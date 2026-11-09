/* Tattoo simulator (experimental).
   A drawing page where the brushes are needle groupings and the paint is ink in skin. Everything for it lives in
   this file (its styles too); InkForge only adds a Studio tile, the 'tattoo' route and the tattoo_pieces table,
   so it can be taken out again cleanly.

   How a stroke works: the machine punctures at its speed (hits per second) while the hand moves, so the faster
   the hand, the further apart the punctures land; each puncture puts every needle of the grouping into the skin.
   Pressure sets how deep (darker, wider, fewer misses), speed lightens, tilt spreads the needles, and the needle
   carries a load of ink that runs down as it goes. Ink is mixed like pigment, not light: yellow and blue make
   green. Layers are fixed: stencil (for tracing, never part of the piece), linework, shadow, mid tone, light tone
   and highlights. Ink darkens the skin under it (multiply); highlights sit on top. */
const TATTOO_VERSION = 1;
const TT_BUILD = APP_BUILD;   // shown on the lessons screen and report card, so a test can tell which build it really ran; keep with sw.js

/* ---------- Needles ----------
   Offsets in mm: u across the stroke, v along it. Diameter by needle size (#10 = 0.30 mm, #12 = 0.35 mm). */
const TT_KINDS = { liner: ['RL', 'Round liners'], shader: ['RS', 'Round shaders'], mag: ['M1', 'Magnums'], soft: ['CM', 'Soft edge magnums'] };
const TT_NEEDLES = [['liner', [1, 3, 5, 7, 9, 11, 14]], ['shader', [5, 7, 9, 11, 14]], ['mag', [7, 9, 11, 13, 15]], ['soft', [9, 13, 15, 23, 31]]]
  .flatMap(([kind, ns]) => ns.map(n => ({ id: n + TT_KINDS[kind][0], kind, n,
    name: `${{ liner: 'Liner', shader: 'Shader', mag: 'Magnum', soft: 'Soft edge magnum' }[kind]}, ${n} needle${n > 1 ? 's' : ''}` })));
function ttLayout(nd, dia) {
  const n = nd.n, out = [];
  if (nd.kind === 'liner' || nd.kind === 'shader') {
    const gap = nd.kind === 'shader' ? 1.3 : 0.78;   // shaders are soldered looser; liners tight, so the line comes out solid
    if (n === 1) out.push({ u: 0, v: 0, e: 1 });
    else if (n <= 6) { const r = (dia / 2) / Math.sin(Math.PI / n) * gap; for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n; out.push({ u: r * Math.cos(a), v: r * Math.sin(a), e: 1 }); } }
    else {   // bigger rounds: an even outer circle around a small core, so the bundle stays round
      const core = n <= 9 ? 1 : n <= 11 ? 3 : 4, ring = (m, off) => { const r = m < 2 ? 0 : dia * gap / (2 * Math.sin(Math.PI / m)); for (let i = 0; i < m; i++) { const a = off + i * 2 * Math.PI / m; out.push({ u: r * Math.cos(a), v: r * Math.sin(a), e: 1 }); } };
      ring(core, 0); ring(n - core, Math.PI / (n - core));
    }
  } else {   // magnums: two staggered rows, flat; the soft edge kind sits the same but its outer needles hit shallower (an airbrush-like fade)
    const a = Math.ceil(n / 2), b = n - a, w = (a - 1) * dia;
    for (let i = 0; i < a; i++) out.push({ u: -w / 2 + i * dia, v: 0 });
    for (let i = 0; i < b; i++) out.push({ u: -w / 2 + dia / 2 + i * dia, v: dia * 0.55 });
    for (const p of out) { const t = w ? Math.abs(p.u) / (w / 2) : 0; p.t = w ? p.u / (w / 2) : 0;   // t: place along the row, -1 to 1
      p.e = nd.kind === 'soft' ? 0.22 + 0.78 * Math.pow(Math.cos(t * Math.PI / 2), 1.5) : 1; }
  }
  return out;
}
// Each needle's feel; every setting can be tuned (and reset) in the calibration panel.
const TT_FEEL = {
  dMin: 0.12, dMax: 1, pCurve: 0, hand: 25, speedFade: 35, tiltSpread: 60, tiltFade: 30, flow: 70, bleed: 40, size: 0.35, miss: 40, hang: 40
};
const TT_FEEL_LIQ = { liner: { flow: 80, miss: 25, size: 0.3, bleed: 60 }, shader: { flow: 60, miss: 40, bleed: 45 }, mag: { flow: 60, miss: 35, bleed: 45 }, soft: { flow: 60, miss: 35, bleed: 55, speedFade: 30, dMax: 0.95 } };
/* Voltage by grouping, as set up for a relatively slow hand (liners higher as they get bigger; shaders and
   magnums lower). Voltage sets how fast the machine hits (about 98 a second at 7 V, rising steeply with voltage), how hard, and how fast the skin gets irritated. */
// How far a setting can move towards easier before a lesson flags it: [direction that's easier, margin]. Shared by the check and the sliders' green zones.
const TT_LIMITS = { cal: { flow: [1, 0.25], hand: [-1, 0.5], fade: [-1, 0.2], tough: [1, 0.25], blow: [-1, 0.25] }, look: { thin: [1, 10], tex: [-1, 25], stretch: [1, 15] }, feel: { volt: [1, 0.4], hand: [-1, 8], speedFade: [-1, 12], flow: [1, 12], bleed: [1, 12], miss: [-1, 10], dMax: [1, 0.1], dMin: [1, 0.08], size: [1, 0.03] } };
// A measured working speed sets hand speed, fade and voltage, along the same curve the old presets sat on. 60 mm/s is the reference packing speed for the default hand of 4.1.
const ttHandFrom = (v) => { const hand = Math.max(1.27, Math.min(5, 4.1 * 60 / Math.max(5, v))), P = [...TT_PROFILES].sort((a, b) => a[2] - b[2]); let i = 0; while (i < P.length - 2 && hand > P[i + 1][2]) i++; const f = (hand - P[i][2]) / (P[i + 1][2] - P[i][2]), mix = (n) => P[i][n] + (P[i + 1][n] - P[i][n]) * f; return { hand: +hand.toFixed(2), fade: +mix(3).toFixed(3), voltOff: +mix(4).toFixed(2) }; };
const TT_LOOK = { thin: 45, tex: 100 }, TT_STRETCH = 75;
const TT_TOUGH = 1.8;   // what Skin toughness 1 means
const TT_VOLT = { '1RL': 7.0, '3RL': 7.55, '5RL': 7.35, '7RL': 7.5, '9RL': 7.6, '11RL': 7.7, '14RL': 7.9, '5RS': 6.6, '7RS': 6.7, '9RS': 6.8, '11RS': 6.9, '14RS': 7,
  '7M1': 6.5, '9M1': 6.55, '11M1': 6.6, '13M1': 8.25, '15M1': 6.55, '9CM': 6.5, '13CM': 6.6, '15CM': 7.45, '23CM': 6.7, '31CM': 6.75 };
// Single groupings set apart from their kind, tuned on a real tablet by a relatively slow hand.
const TT_FEEL_ID = { '1RL': { size: 0.25 }, '15M1': { speedFade: 100, tiltSpread: 55, size: 0.3, hang: 51 }, '23CM': { tiltSpread: 49, flow: 85, bleed: 35, miss: 40, hang: 65 }, '31CM': { hand: 31, speedFade: 47, tiltFade: 38, flow: 85 } };
/* Hand speed: how fast this artist moves. Each sets a starting hand speed, how much fast strokes fade and an offset
   to every needle's voltage (faster hands run machines faster); Tune in fine tunes from there. */
const TT_PROFILES = [['vslow', 'Very slow', 5, 0.3, -0.3], ['slow', 'Relatively slow', 4.1, 0.35, 0], ['medium', 'Medium', 2.75, 0.45, 0.4], ['fast', 'Fast', 1.8, 0.55, 0.8], ['vfast', 'Very fast', 1.27, 0.65, 1.2]];

/* ---------- Ink: mixing like pigment ----------
   Each colour as absorbance per channel (-ln of reflectance); mixing averages absorbance by amount. */
const ttHex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const ttToHex = (c) => '#' + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
function ttMix(a, b, t) {
  const A = (v) => -Math.log(Math.max(0.02, v));
  return a.map((v, i) => Math.exp(-(A(v) * (1 - t) + A(b[i]) * t)));
}
// Grey wash: black ink thinned with water, not mixed with white; the strength is how much pigment it carries.
const TT_WASH = [['Black', 1], ['Dark', 0.55], ['Mid', 0.3], ['Light', 0.14]];
const TT_CAPS = ['#141414', '#5a5a5a', '#b3261e', '#f2c21b', '#1f4fa8', '#2e7d3b', '#6b3f22', '#c2185b', '#fbfbf8'];   // white stays last; a new cap goes in just before it
// Lettering fonts (the first is the app's own blackletter-style display face).
const TT_FONTS = [["'Pirata One', serif", 'Old English'], ["'Brush Script MT', 'Segoe Script', cursive", 'Script'], ["Georgia, 'Times New Roman', serif", 'Serif'], ["Impact, 'Arial Black', sans-serif", 'Bold'], ["'Courier New', monospace", 'Type'], ["Arial, sans-serif", 'Plain']];
const TT_SKINS = [['Light', '#f1d3bd'], ['Fair', '#e2b493'], ['Medium', '#c68c63'], ['Tan', '#a86b45'], ['Brown', '#7b4a2c'], ['Deep', '#4e2f1e']];
const TT_LAYERS = [['stencil', 'Stencil'], ['marker', 'Skin marker'], ['line', 'Linework'], ['shadow', 'Shadow'], ['mid', 'Mid tone'], ['light', 'Light tone'], ['high', 'Highlights']];
const TT_DRAW = ['stencil', 'marker', 'light', 'mid', 'shadow', 'line', 'high'];   // bottom to top
const TT_SIZES = [['A4', 21, 29.7], ['A5', 14.8, 21], ['A6', 10.5, 14.8], ['Square 15 cm', 15, 15], ['Forearm 10 × 25 cm', 10, 25]];

const TT = {
  st: null,
  /* Overall calibration, for this device and hand, on top of every needle's own feel: the pen's pressure range,
     a pressure curve, hand speed (how far apart punctures land), how much fast strokes lighten, the angle the pen
     is naturally held at (tilt counts from there) and ink flow. Set by Tune in, or by hand. */
  calDefaults: { penOnly: true, pMin: 0.2, pMax: 0.866, curve: -75, hand: 4.1, fade: 0.35, flow: 2, tilt0: 35, profile: 'slow', voltOff: 0, blow: 1.2, tough: 1.25, t3: 1, t4: 1, b3: 1, t5: 1 },
  // Toughness scale: rescaled twice (each time × 1 became what × 2.5 was); t2/t3 mark which scale a saved value is
  // on, and older ones are moved across.
  cal() { try { const s = JSON.parse(Settings.get('tt_cal', '{}')); if (s.tough != null && !s.t3) { s.tough = Math.round(s.tough / (s.t2 ? 2.5 : 6.25) * 100) / 100; s.t3 = 1; } if (s.tough != null && !s.t4) { s.tough = Math.round(s.tough / 1.8 * 100) / 100; s.t4 = 1; } if (s.tough === 1.5 && !s.t5) { s.tough = 1.25; s.t5 = 1; } if (s.blow != null && !s.b3) { s.blow = Math.round(s.blow / 3 * 100) / 100; s.b3 = 1; } return { ...TT.calDefaults, ...s }; } catch { return { ...TT.calDefaults }; } },
  saveCal(c) { Settings.set('tt_cal', JSON.stringify(c)); },
  /* Your saved settings: what the simulator goes back to each time the app loads. Changes on the sliders work straight
     away but stay temporary until saved over these. */
  settingsNow() { let feel = {}; try { feel = JSON.parse(Settings.get('tt_feel', '{}')); } catch {} return { cal: TT.cal(), feel, look: { thin: +Settings.get('tt_thin', String(TT_LOOK.thin)), tex: +Settings.get('tt_tex', String(TT_LOOK.tex)) } }; },
  savedGet() { try { return JSON.parse(Settings.get('tt_saved', 'null')); } catch { return null; } },
  canon(s) { const sort = (v) => Array.isArray(v) || v === null || typeof v !== 'object' ? v : Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])); return JSON.stringify(sort(s)); },
  changed() { const s = TT.savedGet(); return !s || TT.canon(s) !== TT.canon(TT.settingsNow()); },
  async saveSettings() { await Settings.set('tt_saved', JSON.stringify(TT.settingsNow())); },
  async applySettings(s) { await Settings.set('tt_cal', JSON.stringify(s.cal || {})); await Settings.set('tt_feel', JSON.stringify(s.feel || {})); await Settings.set('tt_thin', String(s.look?.thin ?? TT_LOOK.thin)); await Settings.set('tt_tex', String(s.look?.tex ?? TT_LOOK.tex)); },
  // Once per app load: drop anything left unsaved. The first time, what's set now becomes the saved settings.
  async loadSaved() { if (TT.savedDone) return; TT.savedDone = true; if (Settings.get('tt_trying')) await Settings.set('tt_trying', ''); const s = TT.savedGet(); if (s) await TT.applySettings(s); else await TT.saveSettings(); },
  feel(id) { let o = {}; try { o = JSON.parse(Settings.get('tt_feel', '{}'))[id] || {}; } catch {} const nd = TT_NEEDLES.find(n => n.id === id);
    return { ...TT.feelBase(id), ...o }; },
  feelBase(id) { const nd = TT_NEEDLES.find(n => n.id === id); return { ...TT_FEEL, ...TT_FEEL_LIQ[nd.kind], ...TT_FEEL_ID[id], volt: TT_VOLT[id] ?? 7 }; },
  // Only what differs from the defaults is kept, so better defaults still reach everything left alone.
  setFeel(id, f) { let all = {}; try { all = JSON.parse(Settings.get('tt_feel', '{}')); } catch {}
    if (f) { const b = TT.feelBase(id), d = {}; for (const k in f) if (f[k] !== b[k]) d[k] = f[k]; if (Object.keys(d).length) all[id] = d; else delete all[id]; } else delete all[id];
    Settings.set('tt_feel', JSON.stringify(all)); },
  // Once: the defaults were reworked (voltage, hand speed), so earlier tuning starts again from them.
  migrate() { if (Settings.get('tt_ver') === '2') return false; const pen = TT.cal().penOnly; Settings.set('tt_feel', '{}'); Settings.set('tt_cal', JSON.stringify({ penOnly: pen }));
    Settings.set('tt_tuned', ''); Settings.set('tt_ver', '2'); return true; }
};

/* ---------- Challenges ----------
   Every challenge sits on an 18 x 13 cm patch of skin; shapes and boxes are in mm on it. `kind` says how it is judged:
   line (follow a stencil line), grad (a shading profile across a box), pack (solid black box), fill (pack a shape in
   a colour), blend (one colour feathered into another) and piece (a whole flash picture: lines, coloured regions,
   highlights and a shading direction). The apprentice exam is a fixed run of them; every one can also be played on
   its own from the Challenges hub, for medals, personal bests and trophies. `diff` is 1 to 3 stars; `hub` puts it
   in a hub section other than its scoring category. */
const RED = TT_CAPS[2], YEL = TT_CAPS[3], BLU = TT_CAPS[4], GRN = TT_CAPS[5], BRN = TT_CAPS[6], WHT = TT_CAPS[TT_CAPS.length - 1], GRY = TT_CAPS[1];
const MIX = ttToHex(ttMix(ttHex(RED), ttHex(YEL), 0.55));
const heart = (g) => { g.moveTo(90, 46); g.bezierCurveTo(88, 28, 60, 26, 58, 46); g.bezierCurveTo(56, 64, 80, 80, 90, 100); g.bezierCurveTo(100, 80, 124, 64, 122, 46); g.bezierCurveTo(120, 26, 92, 28, 90, 46); g.closePath(); };
const banner = (g) => { g.moveTo(54, 66); g.lineTo(126, 66); g.lineTo(126, 79); g.lineTo(54, 79); g.closePath();
  g.moveTo(54, 68); g.lineTo(41, 66); g.lineTo(46, 74); g.lineTo(41, 82); g.lineTo(54, 79); g.closePath(); g.moveTo(126, 68); g.lineTo(139, 66); g.lineTo(134, 74); g.lineTo(139, 82); g.lineTo(126, 79); g.closePath(); };
const shine = (g) => { g.moveTo(76.5, 43); g.ellipse(70, 43, 6.5, 3.2, -0.6, 0, 7); g.closePath(); };
// Path helpers that never join one part to the next with a stray line.
const ttCirc = (g, x, y, r) => { g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2); g.closePath(); };
const ttEll = (g, x, y, rx, ry, a) => { g.moveTo(x + rx * Math.cos(a), y + rx * Math.sin(a)); g.ellipse(x, y, rx, ry, a, 0, Math.PI * 2); g.closePath(); };
const ttPoly = (g, pts) => { g.moveTo(...pts[0]); for (const p of pts.slice(1)) g.lineTo(...p); g.closePath(); };
const ttStar = (g, x, y, R, r) => ttPoly(g, Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? r : R; return [x + q * Math.cos(a), y + q * Math.sin(a)]; }));
// Flash shapes
const fStar = (g) => ttStar(g, 90, 68, 38, 16);
const fBolt = (g) => ttPoly(g, [[98, 22], [68, 72], [87, 72], [76, 108], [114, 54], [94, 54], [106, 22]]);
const fGem = (g) => ttPoly(g, [[60, 50], [74, 32], [106, 32], [120, 50], [90, 100]]);
const fGemFacets = (g) => { g.moveTo(60, 50); g.lineTo(120, 50); g.moveTo(74, 32); g.lineTo(82, 50); g.lineTo(90, 100); g.moveTo(106, 32); g.lineTo(98, 50); g.lineTo(90, 100); g.moveTo(82, 50); g.lineTo(90, 32); g.lineTo(98, 50); };
const fCherries = (g) => { ttCirc(g, 72, 86, 12); ttCirc(g, 104, 88, 12); };
const fStems = (g) => { g.moveTo(72, 74); g.quadraticCurveTo(80, 50, 96, 34); g.moveTo(104, 76); g.quadraticCurveTo(102, 52, 96, 34); };
const fLeaf = (g) => ttEll(g, 110, 36, 12, 5.5, -0.5);
const fPetals = (g) => { for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / 5; ttEll(g, 90 + 16 * Math.cos(a), 65 + 16 * Math.sin(a), 13, 8, a); } };
const fCentre = (g) => ttCirc(g, 90, 65, 8);
const fBlade = (g) => ttPoly(g, [[90, 18], [98, 30], [98, 80], [82, 80], [82, 30]]);
const fGuard = (g) => g.rect(70, 80, 40, 7);
const fHandle = (g) => g.rect(85, 87, 10, 21);
const fPommel = (g) => ttCirc(g, 90, 114, 6);
const fCap = (g) => { g.moveTo(56, 64); g.arc(90, 64, 34, Math.PI, Math.PI * 2); g.closePath(); };
const fStem = (g) => { g.moveTo(80, 64); g.lineTo(78, 98); g.quadraticCurveTo(90, 104, 102, 98); g.lineTo(100, 64); g.closePath(); };
const fSpots = (g) => { ttCirc(g, 77, 50, 5); ttCirc(g, 96, 41, 6); ttCirc(g, 109, 55, 4); };
const fAnchor = (g) => { ttCirc(g, 90, 28, 7); g.moveTo(90, 35); g.lineTo(90, 104); g.moveTo(72, 46); g.lineTo(108, 46);
  g.moveTo(60, 82); g.quadraticCurveTo(66, 108, 90, 106); g.quadraticCurveTo(114, 108, 120, 82); g.moveTo(54, 89); g.lineTo(60, 80); g.lineTo(66, 89); g.moveTo(114, 89); g.lineTo(120, 80); g.lineTo(126, 89); };

const TT_CH = [
  // ---- lining ----
  { id: 'straight', cat: 'line', diff: 1, title: 'Straight lines', needle: '3RL', layer: 'line', ink: 'black', kind: 'line', core: 0.45,
    text: 'Black ink, 3RL. Line the three stencil lines: one steady pull each, solid and even, without going back over them.',
    path: (g) => { for (const y of [35, 65, 95]) { g.moveTo(30, y); g.lineTo(150, y); } } },
  { id: 'curves', cat: 'line', diff: 2, title: 'Curves and a circle', needle: '3RL', layer: 'line', ink: 'black', kind: 'line', core: 0.45,
    text: 'Black ink, 3RL. Follow the S-curve and the circle, keeping the line the same weight all the way round.',
    path: (g) => { g.moveTo(22, 100); g.bezierCurveTo(40, 20, 70, 110, 90, 30); g.moveTo(152, 65); g.arc(128, 65, 24, 0, Math.PI * 2); } },
  { id: 'bold', cat: 'line', diff: 2, title: 'Bold line', needle: '9RL', layer: 'line', ink: 'black', kind: 'line', core: 1.1,
    text: 'Black ink, 9RL. Pull the bold arc solid in one pass, no gaps and no wobble.',
    path: (g) => { g.moveTo(30, 95); g.quadraticCurveTo(90, 10, 150, 95); } },
  { id: 'zigzag', cat: 'line', diff: 2, title: 'Sharp corners', needle: '3RL', layer: 'line', ink: 'black', kind: 'line', core: 0.45,
    text: 'Black ink, 3RL. Line the zigzag with crisp points: stop, turn and pull again at each corner, without rounding them off or doubling back.',
    path: (g) => { g.moveTo(26, 90); for (let i = 1; i <= 8; i++) g.lineTo(26 + i * 16, i % 2 ? 40 : 90); } },
  { id: 'fine', cat: 'line', diff: 3, title: 'Fine line', needle: '1RL', layer: 'line', ink: 'black', kind: 'line', core: 0.25,
    text: 'Black ink, 1RL. Three fine, gentle curves close together: light and steady, so they stay crisp and never touch.',
    path: (g) => { for (const y of [52, 66, 80]) { g.moveTo(30, y); g.quadraticCurveTo(90, y - 18, 150, y); } } },
  { id: 'spiral', cat: 'line', diff: 3, title: 'Spiral', needle: '3RL', layer: 'line', ink: 'black', kind: 'line', core: 0.45,
    text: 'Black ink, 3RL. Follow the spiral from the middle out in one continuous line, turning the skin (two fingers) as you go if it helps.',
    path: (g) => { for (let i = 0; i <= 360; i++) { const a = i / 360 * Math.PI * 6, r = 3 + i / 360 * 50; i ? g.lineTo(90 + r * Math.cos(a), 65 + r * Math.sin(a) * 0.95) : g.moveTo(90 + r, 65); } } },
  { id: 'loops', cat: 'line', diff: 3, title: 'Script loops', needle: '5RL', layer: 'line', ink: 'black', kind: 'line', core: 0.55,
    text: 'Black ink, 5RL. Run the loops like joined-up script: an even line through every loop and turn.',
    path: (g) => { for (let i = 0; i <= 600; i++) { const t = i / 600 * Math.PI * 12, x = 28 + t * 3.1 - 7 * Math.sin(t), y = 70 - 15 * Math.cos(t); i ? g.lineTo(x, y) : g.moveTo(x, y); } } },
  // ---- shading ----
  { id: 'whip', cat: 'shade', diff: 1, title: 'Whip shading', needle: '7RS', layer: 'shadow', ink: 'black', kind: 'grad', box: [55, 56, 70, 18], prof: (f) => Math.pow(1 - f, 1.4),
    text: 'Black ink, 7RS. Whip shade the box to match the example: dark at the left, fading out to clean skin on the right.' },
  { id: 'whipr', cat: 'shade', diff: 1, title: 'Whip from the right', needle: '7RS', layer: 'shadow', ink: 'black', kind: 'grad', box: [55, 56, 70, 18], prof: (f) => Math.pow(f, 1.4),
    text: 'Black ink, 7RS. The other way round: dark at the right, whipping out to clean skin on the left.' },
  { id: 'smooth', cat: 'shade', diff: 2, title: 'Smooth gradient', needle: '15CM', layer: 'shadow', ink: 'black', kind: 'grad', box: [45, 56, 90, 18], prof: (f) => Math.pow(Math.sin(Math.PI * f), 1.2),
    text: 'Black ink, 15CM. Pendulum shade the box: soft at both ends, darkest through the middle, with no hard edges.' },
  { id: 'wash', cat: 'shade', diff: 2, title: 'Grey wash blend', needle: '15CM', layer: 'shadow', ink: 'wash', wash: true, kind: 'grad', box: [45, 55, 90, 20], dk: 0.45, prof: (f) => Math.pow(1 - f, 1.1),
    text: 'Grey wash, 15CM. Blend from dark on the left to clean skin on the right with the washes: dark wash at the left, mid through the middle, light to fade it out. Smooth, no steps between the tones.' },
  { id: 'longfade', cat: 'shade', diff: 3, title: 'Long fade', needle: '15CM', layer: 'shadow', ink: 'black', kind: 'grad', box: [25, 57, 130, 16], prof: (f) => 1 - f,
    text: 'Black ink, 15CM. One long, even fade across the whole box: as smooth at the far end as at the start.' },
  { id: 'steps', cat: 'shade', diff: 3, title: 'Three clean tones', needle: '15M1', layer: 'shadow', ink: 'wash', wash: true, kind: 'grad', box: [45, 55, 90, 20], dk: 0.45, prof: (f) => f < 1 / 3 ? 1 : f < 2 / 3 ? 0.5 : 0.22,
    text: 'Grey wash, 15M1. Three flat tones in equal thirds, dark to light, each one even with a crisp edge between them (not a blend).' },
  // ---- packing ----
  { id: 'pack', cat: 'pack', diff: 1, title: 'Solid black', needle: '15M1', layer: 'shadow', ink: 'black', kind: 'pack', box: [75, 50, 30, 30],
    text: 'Black ink, 15M1. Pack the box solid and even, edge to edge, with your usual technique. Watch the skin: solid, not chewed.' },
  { id: 'bigpack', cat: 'pack', diff: 3, title: 'Big black pack', needle: '15M1', layer: 'shadow', ink: 'black', kind: 'pack', box: [55, 40, 70, 50],
    text: 'Black ink, 15M1. A big area to pack solid: work in sections, overlap your passes, and keep the skin from chewing up.' },
  { id: 'colour', cat: 'pack', diff: 1, title: 'Colour packing', needle: '11M1', layer: 'mid', ink: 'red', kind: 'fill', col: RED, crop: [66, 41, 48, 48], shape: (g) => { g.arc(90, 65, 16, 0, Math.PI * 2); },
    text: 'Red ink, 11M1. Pack the circle with solid red, right up to the line and no further.' },
  { id: 'bluesq', cat: 'pack', diff: 1, title: 'Blue square', needle: '11M1', layer: 'mid', ink: 'blue', kind: 'fill', col: BLU, crop: [67, 42, 46, 46], shape: (g) => g.rect(75, 50, 30, 30),
    text: 'Blue ink, 11M1. Pack the square solid blue, keeping the corners sharp and the edges clean.' },
  { id: 'greentri', cat: 'pack', diff: 2, title: 'Green triangle', needle: '9M1', layer: 'mid', ink: 'green', kind: 'fill', col: GRN, crop: [56, 32, 68, 64], shape: (g) => ttPoly(g, [[90, 40], [116, 88], [64, 88]]),
    text: 'Green ink, 9M1. Pack the triangle right into its points without going over the edges.' },
  { id: 'yelstar', cat: 'pack', diff: 3, title: 'Yellow star', needle: '7M1', layer: 'mid', ink: 'yellow', kind: 'fill', col: YEL, crop: [60, 36, 60, 60], shape: (g) => ttStar(g, 90, 67, 26, 11),
    text: 'Yellow ink, 7M1. Pack the star solid, all the way into each of its five points: small needle, small passes.' },
  // ---- colour ----
  { id: 'mix', cat: 'colour', diff: 2, title: 'Mix a colour', needle: '11M1', layer: 'mid', ink: 'mix', kind: 'fill', col: MIX, crop: [70, 45, 40, 40], shape: (g) => { g.rect(78, 53, 24, 24); }, colW: 0.75,
    text: 'Mix the colour in the example from the red and yellow caps (dip in one, then the other: the longer the dip, the more of it), then pack the square with it.' },
  { id: 'mixgreen', cat: 'colour', diff: 2, title: 'Mix a green', needle: '11M1', layer: 'mid', ink: 'mix', kind: 'fill', col: ttToHex(ttMix(ttHex(BLU), ttHex(YEL), 0.5)), crop: [70, 45, 40, 40], shape: (g) => { g.rect(78, 53, 24, 24); }, colW: 0.75,
    text: 'Mix the green in the example from the blue and yellow caps, then pack the square with it.' },
  { id: 'mixpurple', cat: 'colour', diff: 3, title: 'Mix a purple', needle: '11M1', layer: 'mid', ink: 'mix', kind: 'fill', col: ttToHex(ttMix(ttHex(RED), ttHex(BLU), 0.5)), crop: [70, 45, 40, 40], shape: (g) => { g.rect(78, 53, 24, 24); }, colW: 0.75,
    text: 'Mix the purple in the example from the red and blue caps (it takes a careful balance), then pack the square with it.' },
  { id: 'blend', cat: 'colour', diff: 2, title: 'Colour blend', needle: '15CM', layer: 'mid', ink: 'red, yellow', kind: 'blend', box: [45, 55, 90, 20], from: RED, to: YEL,
    text: 'Red feathered into yellow, like the example: solid red on the left, feather it out, then saturate yellow into the feathered part and across to the right.' },
  { id: 'blendby', cat: 'colour', diff: 3, title: 'Blue into yellow', needle: '15CM', layer: 'mid', ink: 'blue, yellow', kind: 'blend', box: [45, 55, 90, 20], from: BLU, to: YEL,
    text: 'Blue feathered into yellow: solid blue on the left, feathered out, with yellow saturated through it to the right. The middle should turn green, not muddy.' },
  // ---- flash: whole pictures ----
  { id: 'fbolt', cat: 'final', hub: 'flash', diff: 1, title: 'Flash: lightning bolt', needle: '3RL', layer: 'line', ink: 'black, yellow', kind: 'piece', crop: [58, 14, 66, 102],
    lines: fBolt, regions: [{ shape: fBolt, col: YEL }],
    text: 'Line the bolt in black, then pack it solid yellow up to the line.' },
  { id: 'fanchor', cat: 'line', hub: 'flash', diff: 2, title: 'Flash: anchor (lines)', needle: '5RL', layer: 'line', ink: 'black', kind: 'line', core: 0.6,
    path: fAnchor, text: 'Black ink, 5RL. Line the whole anchor: ring, shank, stock, arms and points, with clean joins.' },
  { id: 'fstar', cat: 'final', hub: 'flash', diff: 2, title: 'Flash: shaded star', needle: '3RL', layer: 'line', ink: 'black, yellow, white', kind: 'piece', crop: [48, 26, 84, 82],
    lines: fStar, regions: [{ shape: fStar, col: YEL }], hi: [(g) => ttEll(g, 82, 56, 4, 2.4, -0.5)], shade: { in: fStar, light: [80, 44, 20, 14], dark: [72, 80, 36, 10] },
    text: 'Line the star, pack it yellow, shade the lower points darker with black, and put a white highlight up near the top.' },
  { id: 'fgem', cat: 'final', hub: 'flash', diff: 2, title: 'Flash: gem', needle: '3RL', layer: 'line', ink: 'black, blue, white', kind: 'piece', crop: [52, 24, 76, 84],
    lines: (g) => { fGem(g); fGemFacets(g); }, regions: [{ shape: fGem, col: BLU }], hi: [(g) => ttPoly(g, [[76, 36], [84, 36], [78, 46]])], shade: { in: fGem, light: [66, 38, 12, 8], dark: [94, 62, 10, 18] },
    text: 'Line the gem and its facets, pack it blue, shade the lower right side darker, and put a white glint in the top left facet.' },
  { id: 'fcherry', cat: 'final', hub: 'flash', diff: 2, title: 'Flash: cherries', needle: '3RL', layer: 'line', ink: 'black, red, green, white', kind: 'piece', crop: [52, 24, 76, 82],
    lines: (g) => { fCherries(g); fStems(g); fLeaf(g); }, regions: [{ shape: fCherries, col: RED }, { shape: fLeaf, col: GRN }], hi: [(g) => { ttEll(g, 67, 81, 3, 1.8, -0.6); ttEll(g, 99, 83, 3, 1.8, -0.6); }],
    text: 'Line the cherries, stems and leaf, pack the cherries red and the leaf green, and give each cherry a small white shine.' },
  { id: 'fflower', cat: 'final', hub: 'flash', diff: 2, title: 'Flash: flower', needle: '3RL', layer: 'line', ink: 'black, red, yellow', kind: 'piece', crop: [52, 26, 76, 78],
    lines: (g) => { fPetals(g); fCentre(g); }, regions: [{ shape: fPetals, col: RED }, { shape: fCentre, col: YEL }],
    text: 'Line the five petals and the centre, pack the petals red and the centre yellow.' },
  { id: 'fdagger', cat: 'final', hub: 'flash', diff: 3, title: 'Flash: dagger', needle: '3RL', layer: 'line', ink: 'black, grey, red, yellow', kind: 'piece', crop: [52, 12, 76, 112],
    lines: (g) => { fBlade(g); g.moveTo(90, 22); g.lineTo(90, 78); fGuard(g); fHandle(g); fPommel(g); },
    regions: [{ shape: fBlade, col: GRY }, { shape: fGuard, col: YEL }, { shape: fHandle, col: RED }, { shape: fPommel, col: YEL }], shade: { in: fBlade, light: [83, 34, 5, 40], dark: [92, 34, 5, 40] },
    text: 'Line the dagger (and the ridge down the blade), pack the blade grey with its right side shaded darker, the guard and pommel yellow and the handle red.' },
  { id: 'fmush', cat: 'final', hub: 'flash', diff: 3, title: 'Flash: mushroom', needle: '3RL', layer: 'line', ink: 'black, red, brown, white', kind: 'piece', crop: [48, 22, 84, 90],
    lines: (g) => { fCap(g); fStem(g); fSpots(g); }, regions: [{ shape: fCap, col: RED }, { shape: fStem, col: BRN }], hi: [fSpots],
    text: 'Line the cap, stem and spots, pack the cap red and the stem brown, and fill the spots solid white.' },
  { id: 'final', cat: 'final', hub: 'flash', diff: 3, title: 'Final piece: traditional heart', needle: '3RL', layer: 'line', ink: 'all', kind: 'piece', crop: [34, 20, 112, 88],
    lines: (g) => { heart(g); banner(g); shine(g); }, regions: [{ shape: heart, col: RED, tol: 2.2 }, { shape: banner, col: YEL }], hi: [shine], shade: { in: heart, light: [40, 20, 42, 38], dark: [98, 58, 50, 50] },
    text: 'Tattoo the heart like the reference: line it (black), shade the lower right of the heart (black), pack the heart red and the banner yellow, and put a white highlight in the shine. Use any needles and layers you like.' }
];
/* Grey wash flash: every colour flash piece again in black and grey, for any skin (and the only way to do them on
   skin that takes no colour). Each colour becomes a wash tone by how dark it reads; highlights are left as bare skin.
   Scored on the tones (how dark each part is), the line and the shading, not on colour. */
TT_CH.push(...TT_CH.filter(c => c.hub === 'flash' && c.kind === 'piece').map(c => ({ ...c, id: 'g' + c.id, title: 'Grey wash: ' + c.title.replace(/^(Flash|Final piece): /, ''),
  ink: 'wash', wash: true, bare: true,
  regions: c.regions.map(r => { const v = ttHex(r.col), tone = Math.max(0.15, Math.min(0.65, (1 - (v[0] * 0.3 + v[1] * 0.59 + v[2] * 0.11)) * 0.8)), g = 1 - tone * 0.92;
    return { shape: r.shape, tone, col: ttToHex([g, g, g]) }; }),
  text: 'Line it in black, then build it up in grey wash like the example: each part its own tone, blended smooth, ' + (c.shade ? 'darker where it\u2019s shaded, ' : '') + (c.hi ? 'with the highlights left as bare skin. ' : '') + 'Use the grey wash set, or dilute black in the dilute cup.' })));
const TT_EXAM = ['straight', 'curves', 'bold', 'whip', 'smooth', 'pack', 'wash', 'colour', 'mix', 'blend', 'final'];
const TT_HUB = [['line', 'Lining'], ['shade', 'Shading'], ['pack', 'Packing'], ['colour', 'Colour'], ['flash', 'Flash']];
const ttHubOf = (c) => c.hub || c.cat;
// A stencil picture recoloured to the transfer purple the challenges use: the darker the line, the stronger.
function ttPurple(g, w, h) { const im = g.getImageData(0, 0, w, h), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const a = (1 - (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255) * d[i + 3] / 255;
    d[i] = 78; d[i + 1] = 40; d[i + 2] = 150; d[i + 3] = Math.round(Math.min(1, a * 1.1) * 230); }
  g.putImageData(im, 0, 0); }
const ttShort = (t) => { t = t.replace(/^Flash: /, ''); return t[0].toUpperCase() + t.slice(1); };
// The part of the page an example shows (mm): its crop, its box with a margin, or the whole patch.
const ttCrop = (T) => T.crop || (T.box ? [T.box[0] - 8, T.box[1] - 8, T.box[2] + 16, T.box[3] + 16] : [0, 0, 180, 130]);
// A challenge's example on skin (line challenges: the stencil to follow), as a picture of its crop.
function ttExGen(T, skin) {
  // Painted on white, then laid into the skin by multiplying, the way the simulator shows ink, so colours dull
  // and darken with the skin just as they will when tattooed; white highlights go on top.
  const c = document.createElement('canvas'), sc = 2; c.width = 180 * sc; c.height = 130 * sc; const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.scale(sc, sc); g.lineCap = g.lineJoin = 'round';
  const hiC = document.createElement('canvas'); hiC.width = c.width; hiC.height = c.height; const hg = hiC.getContext('2d'); hg.scale(sc, sc);
  const dots = (x0, y0, w, h, f, col) => { g.fillStyle = col; for (let i = 0; i < w * h * 3; i++) { const px = x0 + Math.random() * w, py = y0 + Math.random() * h, a = f((px - x0) / w); if (Math.random() < a) { g.globalAlpha = 0.6 + a * 0.4; g.beginPath(); g.arc(px, py, 0.35, 0, 7); g.fill(); } } g.globalAlpha = 1; };
  if (T.kind === 'line') { g.strokeStyle = '#141414'; g.lineWidth = Math.max(0.5, T.core); g.beginPath(); T.path(g); g.stroke(); }
  if (T.kind === 'grad') dots(...T.box, T.wash ? (f) => T.prof(f) * 0.5 : T.prof, '#141414');
  if (T.kind === 'pack') { g.fillStyle = '#161616'; g.fillRect(...T.box); }
  if (T.kind === 'fill') { g.fillStyle = T.col; g.beginPath(); T.shape(g); g.fill(); }
  if (T.kind === 'blend') { const [x0, y0, w, h] = T.box, A = ttHex(T.from || RED), B = ttHex(T.to || YEL);
    for (let x = 0; x < w; x += 0.5) { const f = x / w; g.fillStyle = f < 0.3 ? ttToHex(A) : f > 0.7 ? ttToHex(B) : ttToHex(ttMix(A, B, (f - 0.3) / 0.4)); g.fillRect(x0 + x, y0, 0.6, h); } }
  if (T.kind === 'piece') {
    for (const r of T.regions || []) { g.fillStyle = r.col; g.beginPath(); r.shape(g); g.fill(); }
    if (T.shade) { const [lx, ly, lw, lh] = T.shade.light, [dx, dy, dw, dh] = T.shade.dark, sh = g.createLinearGradient(lx + lw / 2, ly + lh / 2, dx + Math.min(dw, 20) / 2, dy + Math.min(dh, 20) / 2);
      sh.addColorStop(0.35, 'rgba(20,20,20,0)'); sh.addColorStop(1, 'rgba(20,20,20,.8)');
      g.save(); g.beginPath(); T.shade.in(g); g.clip(); g.fillStyle = sh; g.fillRect(0, 0, 180, 130); g.restore(); }
    for (const h of T.hi || []) { g.fillStyle = '#fff'; g.beginPath(); h(g); g.fill(); if (!T.bare) { hg.fillStyle = WHT; hg.beginPath(); h(hg); hg.fill(); } }
    g.strokeStyle = '#141414'; g.lineWidth = 0.9; g.beginPath(); T.lines(g); g.stroke();
  }
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'multiply'; g.fillStyle = skin; g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 0.8; g.drawImage(hiC, 0, 0); g.globalAlpha = 1;
  if (T.kind === 'piece') { g.scale(sc, sc); g.strokeStyle = '#141414'; g.lineWidth = 0.9; g.lineCap = g.lineJoin = 'round'; g.beginPath(); T.lines(g); g.stroke(); g.setTransform(1, 0, 0, 1, 0, 0); }
  const [x0, y0, w, h] = ttCrop(T), o = document.createElement('canvas'); o.width = w * sc; o.height = h * sc;
  o.getContext('2d').drawImage(c, x0 * sc, y0 * sc, w * sc, h * sc, 0, 0, w * sc, h * sc);
  return o.toDataURL('image/png');
}

/* ---------- Medals, personal bests and trophies ----------
   Kept in the setting tt_awards (so backups carry them): pb { id: { best, bestT, last, lastT, tries } }, a log of
   every finished challenge, trophies { id: when }, and finished exams. */
const TT_MEDALS = [[90, 'gold', 'Gold'], [75, 'silver', 'Silver'], [60, 'bronze', 'Bronze']];
const ttMedal = (s) => s == null ? null : TT_MEDALS.find(([m]) => s >= m) || null;
const ttHubCh = (sec) => TT_CH.filter(c => ttHubOf(c) === sec);
const ttBest = (a, id) => a.pb[id]?.best ?? -1;
const TT_TROPHIES = [
  { id: 'first', tier: 'bronze', name: 'First ink', desc: 'Finish any challenge.', test: (a) => Object.keys(a.pb).length >= 1 },
  { id: 'ten', tier: 'silver', name: 'Getting serious', desc: 'Finish 10 different challenges.', test: (a) => Object.keys(a.pb).length >= 10 },
  { id: 'all', tier: 'gold', name: 'Completionist', desc: 'Finish every challenge.', test: (a) => TT_CH.every(c => a.pb[c.id]) },
  { id: 'medals', tier: 'bronze', name: 'On the podium', desc: 'Win a medal in every section.', test: (a) => TT_HUB.every(([k]) => ttHubCh(k).some(c => ttBest(a, c.id) >= 60)) },
  { id: 'gold5', tier: 'silver', name: 'Golden hands', desc: 'Win 5 gold medals.', test: (a) => TT_CH.filter(c => ttBest(a, c.id) >= 90).length >= 5 },
  { id: 'gold15', tier: 'gold', name: 'Gold rush', desc: 'Win 15 gold medals.', test: (a) => TT_CH.filter(c => ttBest(a, c.id) >= 90).length >= 15 },
  ...TT_HUB.map(([k, n]) => ({ id: 'm-' + k, tier: 'gold', name: { line: 'Line master', shade: 'Shade master', pack: 'Packing master', colour: 'Colourist', flash: 'Flash master' }[k], desc: `Gold on every ${n.toLowerCase()} challenge.`, test: (a) => ttHubCh(k).every(c => ttBest(a, c.id) >= 90) })),
  { id: 'flash', tier: 'silver', name: 'Flash collector', desc: 'Finish every flash piece.', test: (a) => ttHubCh('flash').every(c => a.pb[c.id]) },
  { id: 'hard', tier: 'gold', name: 'Hard mode', desc: 'Silver or better on every three-star challenge.', test: (a) => TT_CH.filter(c => c.diff === 3).every(c => ttBest(a, c.id) >= 75) },
  { id: 'perfect', tier: 'gold', name: 'Flawless', desc: 'Score 95 or more on any challenge.', test: (a) => TT_CH.some(c => ttBest(a, c.id) >= 95) },
  { id: 'clean', tier: 'silver', name: 'Gentle hands', desc: 'A medal on a flash piece with the skin at 95% or better and no blowouts.', test: (a) => a.log.some(l => ttHubOf(TT_CH.find(c => c.id === l.id) || {}) === 'flash' && l.s >= 60 && l.skin >= 95 && !l.blow) },
  { id: 'improve', tier: 'bronze', name: 'Practice pays', desc: 'Beat a personal best by 15 points or more.', test: (a) => a.log.some((l, i) => { const prev = a.log.slice(0, i).filter(x => x.id === l.id); return prev.length && l.s - Math.max(...prev.map(x => x.s)) >= 15; }) },
  { id: 'days', tier: 'silver', name: 'Dedicated', desc: 'Practise on 5 different days.', test: (a) => new Set(a.log.map(l => new Date(l.t).toDateString())).size >= 5 },
  { id: 'exam', tier: 'silver', name: 'Graduate', desc: 'Finish the apprentice exam.', test: (a) => a.exam.length > 0 },
  { id: 'examA', tier: 'gold', name: 'Top of the class', desc: 'Grade A in the apprentice exam.', test: (a) => a.exam.some(e => e.grade === 'A') }
];
TT.aw = {
  get() { let a = {}; try { a = JSON.parse(Settings.get('tt_awards', '{}')); } catch {} return { pb: {}, log: [], trophies: {}, exam: [], ...a }; },
  put(a) { Settings.set('tt_awards', JSON.stringify(a)); },
  check(a) { const got = []; for (const t of TT_TROPHIES) if (!a.trophies[t.id] && t.test(a)) { a.trophies[t.id] = Date.now(); got.push(t); } return got; },
  // A finished challenge: returns the earlier best (null the first time), the best now and any trophies just won.
  record(T, res) {
    const a = this.get(), p = a.pb[T.id] || { best: 0, tries: 0 }, was = p.tries ? p.best : null;
    p.tries++; p.last = res.total; p.lastT = Date.now(); if (was == null || res.total > p.best) { p.best = res.total; p.bestT = Date.now(); }
    a.pb[T.id] = p; a.log.push({ id: T.id, s: res.total, t: Date.now(), skin: res.skin, blow: res.blowouts }); if (a.log.length > 1500) a.log.splice(0, a.log.length - 1500);
    const gained = this.check(a); this.put(a); return { was, best: p.best, newPb: was != null && res.total > was, first: was == null, gained };
  },
  exam(overall, grade) { const a = this.get(); a.exam.push({ overall, grade, t: Date.now() }); const g = this.check(a); this.put(a); return g; }
};
const ttStars = (n) => '<span class="tt-stars">' + [1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('') + '</span>';
const ttCup = (tier, size = 28) => `<svg class="tt-cup ${tier}" viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8M9.5 17h5"/></svg>`;
const ttMedalIco = (m, size = 22) => m ? `<svg class="tt-medal ${m[1]}" viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M8 2l4 7 4-7"/><circle cx="12" cy="15" r="6"/></svg>` : '';

/* Skin for challenges and the exam (setting tt_chskin, an index into TT_SKINS). The three lightest play the same;
   Tan is the hardest for colour (colour inks take less and read duller); Brown and Deep take no colour at all
   (as in the studio), so their challenges are black and grey only, and black takes a little less too. */
const ttChSkin = () => { const i = +Settings.get('tt_chskin', 1); return i >= 0 && i < TT_SKINS.length ? i : 1; };
const ttNoColour = (i = ttChSkin()) => i >= 4;
const ttIsColour = (T) => !/^(black|wash)$/.test(T.ink || 'black');   // grey wash flash counts as black and grey
const TT_SKIN_NOTE = ['', '', '', 'Hardest for colour: colour inks take less', 'Black and grey only: no colour on this skin', 'Black and grey only: no colour on this skin'];
// The exam on skin that takes no colour: the colour challenges swapped for black and grey ones.
const TT_EXAM_BG = { colour: 'bigpack', mix: 'steps', blend: 'longfade', final: 'gfinal' };
const ttExamList = (i = ttChSkin()) => ttNoColour(i) ? TT_EXAM.map(id => TT_EXAM_BG[id] || id) : null;

// Starts (or restarts) a challenge on its own piece of skin; each challenge keeps one piece.
async function ttChStart(id) {
  const T = TT_CH.find(c => c.id === id); if (!T) return;
  if (ttNoColour() && ttIsColour(T)) { location.hash = 'tattoo/challenges'; return toast(`${TT_SKINS[ttChSkin()][0]} skin takes no colour: pick a black and grey challenge, or a lighter skin.`, 3500); }
  const chSkin = TT_SKINS[ttChSkin()][1];
  const exam = { v: 1, mode: 'ch', list: [id], i: 0, res: [], started: Date.now() };
  const rows = await DB.all(`SELECT id, meta FROM tattoo_pieces WHERE meta LIKE '%"mode":"ch"%'`);
  const hit = rows.find(r => { try { return JSON.parse(r.meta).exam?.list?.[0] === id; } catch { return false; } });
  if (hit) { let m = {}; try { m = JSON.parse(hit.meta); } catch {} await DB.run(`UPDATE tattoo_pieces SET meta = ?, skin = ?, updated_at = datetime('now') WHERE id = ?`, [JSON.stringify({ ...m, exam }), chSkin, hit.id]); location.hash = 'tattoo/' + hit.id; return; }
  await DB.run('INSERT INTO tattoo_pieces (name, w_cm, h_cm, skin, meta) VALUES (?, ?, ?, ?, ?)', ['Challenge: ' + T.title, 18, 13, chSkin, JSON.stringify({ exam })]);
  location.hash = 'tattoo/' + (await DB.one('SELECT last_insert_rowid() AS id')).id;
}

/* ---------- The Challenges hub ----------
   Sections of challenge cards (example, stars, best score and medal), the trophy cabinet, and a results sheet to
   print, save or share for comparing over time. */
TT.hub = async (el) => {
  ttStyle();
  const a = TT.aw.get(), si = ttChSkin(), skin = TT_SKINS[si][1], noCol = ttNoColour(si);
  const done = TT_CH.filter(c => a.pb[c.id]).length, golds = TT_CH.filter(c => ttBest(a, c.id) >= 90).length, cups = Object.keys(a.trophies).length;
  el.innerHTML = `<div class="tt-hub">
    <div class="row" style="margin-bottom:12px;gap:8px;flex-wrap:wrap"><button class="btn icon-btn" data-go="tattoo" aria-label="Back" data-tip="Back to your pieces"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <div class="tt-hubsum"><span><b>${done}</b> / ${TT_CH.length} done</span><span>${ttMedalIco(TT_MEDALS[0], 18)}<b>${golds}</b> gold</span><span>${ttCup('gold', 18)}<b>${cups}</b> / ${TT_TROPHIES.length} trophies</span></div>
      <span style="flex:1"></span><button class="btn" id="tt-sheet">Results sheet</button>${done || a.exam.length ? '<button class="btn" id="tt-chreset" data-tip="Clear challenge scores or exam results">Reset…</button>' : ''}</div>
    ${(() => { let L0 = null; try { L0 = JSON.parse(Settings.get('tt_chlast', 'null')); } catch {} return L0 ? `<button class="tt-lsrow" style="width:100%;margin-bottom:12px" data-chlast><span class="tt-lsno">${L0.total}</span><span class="tt-lsmeta"><b>Open last challenge</b><span class="muted">${esc(ttShort(L0.title))} · ${new Date(L0.when).toLocaleString()}</span></span></button>` : ''; })()}
    <div class="tt-chskin"><span class="lbl" style="margin:0">Skin for challenges and the exam</span>
      <div class="tt-skins" style="margin:0">${TT_SKINS.map(([n, c], i) => `<button data-chskin="${i}" class="${i === si ? 'on' : ''}" style="background:${c}" data-tip="${n}${TT_SKIN_NOTE[i] ? ': ' + TT_SKIN_NOTE[i] : ''}" aria-label="${n}"></button>`).join('')}</div>
      <span class="muted" style="font-size:12px">${TT_SKINS[si][0]}${TT_SKIN_NOTE[si] ? ' · ' + TT_SKIN_NOTE[si] : ''}</span></div>
    <div class="letter">Trophy cabinet</div>
    <div class="tt-cabinet">${TT_TROPHIES.map(t => `<div class="tt-trophy ${a.trophies[t.id] ? 'won' : ''}" data-tip="${esc(t.desc)}">${ttCup(a.trophies[t.id] ? t.tier : 'locked', 30)}<b>${esc(t.name)}</b><span>${a.trophies[t.id] ? new Date(a.trophies[t.id]).toLocaleDateString() : esc(t.desc)}</span></div>`).join('')}</div>
    ${TT_HUB.map(([k, n]) => `<div class="letter">${n}</div><div class="tt-chgrid">${ttHubCh(k).sort((x, y) => x.diff - y.diff).map(c => { const p = a.pb[c.id], m = ttMedal(p?.best);
      const off = noCol && ttIsColour(c);
      return `<button class="tt-chc ${off ? 'off' : ''}" data-ch="${c.id}" ${off ? 'data-tip="No colour on this skin"' : ''}><div class="tt-chimg"><img src="${ttExGen(c, skin)}" alt=""></div>
        <div class="tt-chmeta"><b>${esc(ttShort(c.title))}</b><span>${ttStars(c.diff)} ${c.needle}</span>
        <span class="tt-chpb">${p ? `${ttMedalIco(m)} Best ${p.best} <i class="tt-chr" data-chr="${c.id}" data-tip="Clear this challenge's best score">Reset</i>` : '<i class="muted">Not tried yet</i>'}</span></div></button>`; }).join('')}</div>`).join('')}
  </div>`;
  // After scores are cleared, trophies stay only if what's left still earns them.
  const keepTrophies = (A) => { for (const tr of TT_TROPHIES) if (A.trophies[tr.id] && !tr.test(A)) delete A.trophies[tr.id]; };
  const dropExamPieces = async () => { const rows = await DB.all('SELECT * FROM tattoo_pieces'); for (const r of rows) { let m = {}; try { m = JSON.parse(r.meta || '{}'); } catch {} if (!m.exam || m.exam.mode === 'ch') continue; await DB.run('DELETE FROM tattoo_pieces WHERE id = ?', [r.id]); for (const k2 of ['thumb_ref', 'skin_ref', 'blow_ref', ...TT_LAYERS.map(([l]) => l + '_ref')]) await Media.release(r[k2]); for (const f of m.tl || []) await Media.release(f); } };
  el.onclick = async (e) => { if (e.target.closest('[data-chlast]')) return ttLessonResult(null, 'ch'); const cr = e.target.closest('[data-chr]')?.dataset.chr; if (cr) { e.stopPropagation(); const T = TT_CH.find(c => c.id === cr); if (!await ask(`Reset "${ttShort(T.title)}"? Its best score and history are cleared. Your next attempt becomes the new best.`)) return; const A = TT.aw.get(); delete A.pb[cr]; A.log = A.log.filter(l => l.id !== cr); keepTrophies(A); TT.aw.put(A); return TT.hub(el); }
    if (e.target.closest('#tt-chreset')) { const pick = await new Promise((res) => { const o = document.createElement('div'); o.id = 'merge-dlg'; o.innerHTML = '<div class="card" style="margin:auto;max-width:380px"><h2 style="margin-top:0">Reset</h2><p class="muted" style="margin-top:0">Clears scores so you can start over. Copies in your portfolio stay.</p><div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn" data-pk="">Cancel</button><span style="flex:1"></span><button class="btn" data-pk="ch">Challenges</button><button class="btn" data-pk="exam">Exam</button></div></div>'; o.onclick = (ev) => { const b = ev.target.closest('[data-pk]'); if (b) { o.remove(); res(b.dataset.pk); } }; document.body.appendChild(o); }); if (!pick) return;
      if (!await ask(pick === 'ch' ? 'Reset all challenges? Every best score, the history and the trophies they earned are cleared.' : 'Reset the apprentice exam? All exam results and exam pieces, finished or unfinished, are deleted.')) return; const A = TT.aw.get(); if (pick === 'ch') { A.pb = {}; A.log = []; let L0 = null; try { L0 = JSON.parse(Settings.get('tt_chlast', 'null')); } catch {} if (L0) { for (const k of ['ref', 'page']) if (L0[k]) await Media.release(L0[k]); await Settings.set('tt_chlast', ''); } } else { A.exam = []; await dropExamPieces(); } keepTrophies(A); TT.aw.put(A); return TT.hub(el); }
    const k = e.target.closest('[data-chskin]'); if (k) { await Settings.set('tt_chskin', +k.dataset.chskin); return TT.hub(el); }
    const c = e.target.closest('[data-ch]'); if (c) return ttChStart(c.dataset.ch); if (e.target.closest('#tt-sheet')) return TT.sheet(); };
};

/* ---------- Lessons ----------
   Chapters of lessons, each unlocked by completing and qualifying for the one before. A lesson is a list of steps like
   the tour's stops: a short text, an optional "See more", and optionally a picture (`pic`: needles, sizes, caps, skins)
   or an action (`tune`). A lesson with no steps yet shows as coming. Later lessons add a `qualify` test once they have
   a drawing task; until then reaching the end completes it. Wording lives here, so it's easy to change. */
const TT_LESSONS = [
  { name: 'Chapter 1: Beginner', lessons: [
    { id: '1-1', title: 'Introduction', sum: 'Set up your tablet, then meet the needles, inks and skin.', steps: [
      { title: 'Tune in first', tune: true, text: 'Every tablet and pen reads pressure differently, so start by fitting the simulator to yours. It takes a few minutes and you only need to do it once on each device.',
        more: 'Tune in has you draw a few short tasks and sets the pressure range, hand speed and more from how you actually work. You can run it again whenever you like, under the sliders icon while tattooing.' },
      { title: 'Needles: what the code means', pic: { needles: ['3RL', '7RS', '7M1', '15CM'] }, text: 'A needle grouping is named by how many needles it has and how they are arranged. 7RL means 7 needles in a round liner. There are four kinds to know: RL, RS, M and CM.',
        more: 'There are many more variants out there, such as flat magnums with a single row of needles instead of two. Needles also differ in taper, the length of the narrowing point: a long taper is finer and gentler on the skin, while a short taper is blunter and puts down more ink with each hit. In this simulation we only show the most commonly used stacks and arrangements. The pictures show the tips of the needles from below, as they meet the skin. In this simulator, the shape you see is the shape that lands on the skin with each hit.' },
      { title: 'RL: round liner', pic: { needles: ['1RL', '3RL', '7RL', '14RL'] }, text: 'Needles packed tightly into a circle. They work together like one sharp point, which gives a solid, clean line. This is your needle for linework.',
        more: 'Because all the force lands on a small area, a round liner is the easiest needle to blow out with. Pressing in deep while moving slowly pushes past the dermis and into the hypodermis, which is mostly fat with no structure to hold ink in place, so the ink spreads under the skin.' },
      { title: 'RS: round shader', pic: { needles: ['5RS', '7RS', '11RS', '14RS'] }, text: 'The same circle, spaced a little looser. It is used for small areas of shading and colour, and it also pulls a lovely bold line, known as a power line.',
        more: 'Looser does not mean safer. Lining with a round shader looks great, but it can blow out just like a liner if you press deep and move slowly.' },
      { title: 'M: magnum', pic: { needles: ['7M1', '9M1', '11M1', '15M1'] }, text: 'Needles in a flat, stacked row. A magnum covers a wide band with each pass, so it suits shading and packing colour across bigger areas.',
        more: 'Which way you hold the stack matters. Roll it onto one end and that end goes deepest while the rest feather away, which is how you get a soft edge.' },
      { title: 'CM: curved magnum', pic: { needles: ['9CM', '15CM', '23CM', '31CM'] }, text: 'A magnum with its row curved, also called a soft edge, and some refer to it as a round mag. The ends sit higher than the middle, so it leaves softer edges and is gentler on the skin.',
        more: 'This is the go-to for smooth grey gradients and for packing large areas of colour, because its passes blend into each other without hard lines.' },
      { title: 'Thickness: #08, #10, #12', pic: { sizes: true }, text: 'The number is the thickness of each single needle: #08 is 0.25 mm, #10 is 0.30 mm and #12 is 0.35 mm. Thinner needles leave finer marks; thicker ones carry more ink and hit bolder.',
        more: 'Thin needles go into the skin more easily, so they blow out more easily too. You can change the size of each needle in its settings under the sliders icon.' },
      { title: 'Groupings: where each is used', pic: { table: [['1RL to 3RL', 'Fine line, small detail, lettering'], ['5RL to 9RL', 'Everyday linework'], ['11RL to 14RL', 'Bold, heavy outlines'], ['5RS to 14RS', 'Small shading, colour in tight spots, bold lines'], ['7M to 15M', 'Shading and colour in medium areas'], ['9CM to 31CM', 'Smooth gradients, packing large areas']] }, text: 'More needles cover more skin with each pass, but they also make the fine control harder. Choose the smallest grouping that does the job comfortably.',
        more: 'Bigger groupings usually run at different voltages too. Each needle here starts at a sensible voltage, shown beside it while you tattoo.' },
      { title: 'Inks', pic: { caps: true }, text: 'Hold the pen in an ink cap to load the needle: the longer you hold it, the more ink you pick up. Dip into a second cap to mix the colours, as real pigment would.',
        more: 'Grey wash is black thinned with water, so it gets lighter without turning chalky the way adding white does. A needle runs out as you work, so keep dipping.' },
      { title: 'Skin', pic: { skins: true }, text: 'Skin is the part that fights back. Every pass wears it: first it goes red, then it swells, and overworked skin stops taking ink. Work it gently and leave it alone once it has had enough.',
        more: 'Redness settles after a rest, but serious damage stays. Darker skin tones show less contrast and take no colour on the deepest tones, which you will plan for later on. Keep the skin stretched: loose skin moves under the needle.' }
    ] },
    { id: '1-2', title: 'Your first line', sum: 'Pull one short, straight line with a 5RL. Grade C or higher moves you on.', task: 'l-first', steps: [
      { title: 'Your needle: 5RL, #10', pic: { needles: ['5RL'] }, text: 'A good first needle: big enough to make a solid line, and small enough to stay controlled. The workspace will have it ready for you.',
        more: '5 needles at 0.30 mm each, in a tight round. If you changed this needle in its settings, its size stays as you set it.' },
      { title: 'Load your ink', pic: { caps: true }, text: 'In the workspace, hold the pen in the black ink cap for a moment to load the needle. An empty needle leaves nothing behind.' },
      { title: 'Start moving before you go in', text: 'Begin the motion just above the skin, then land while already moving. Lift off the same way at the end. Landing or lifting while still leaves a dark dot.',
        more: 'Coming straight down hard, known as a crash, marks the skin and can blow out. Ease in and ease out.' },
      { title: 'Steady speed, steady pressure', text: 'Pull the line in one smooth movement, at one speed and one depth. Follow the middle of the stencil line, and look a little ahead of the needle, not at it.',
        more: 'Too light and the ink misses. Too deep while moving slowly and it blows out. If you stop partway, carry on from just before the stop, moving as you land. You can pull it in up to 2 strokes; each one more costs 3 points.' },
      { title: 'Then leave it to settle', text: 'One clean pass is the goal, because every extra pass wears the skin. When the line is done, leave the skin alone for about a minute before you press Done, so the redness can calm down.',
        more: 'Skin starts settling a few seconds after the needle moves away, and the redness halves about every 30 seconds. Your skin score counts for part of your grade, so waiting pays off.' },
      { title: 'Your grade', text: 'Press Done when you are ready for your score. Grade C (70) or higher unlocks the next lesson, and you can try as often as you like.',
        more: 'A is 90 or more, B is 80, C is 70, D is 60. Most of the score is the line itself: on the stencil, solid and even. The rest is the condition of the skin. Blowouts and extra undos take points off. More than 1 blowout is an instant fail.' }
    ] },
    { id: '1-3', title: 'Sharp corners', sum: 'Line a rectangle with crisp corners and consistent lines. Grade C or higher moves you on.', task: 'l-rect', steps: [
      { title: 'A rectangle, same needle', pic: { needles: ['5RL'] }, text: 'Same 5RL, but now four lines that have to meet. The lines are judged as before, and now so are your four corners: sharp, not rounded, and not crossing over each other.' },
      { title: 'Corners are two lines', text: 'Do not try to steer around a corner. Pull one side, ease out as you reach the corner, then start the next side from that same point. Each line gets its own clean start and finish. You can use up to 8 strokes, two per side; each one more costs 3 points.',
        more: 'Turning the page with two fingers between sides lets you pull every line in the direction that feels best.' },
      { title: 'Meet, do not cross', text: 'Land each new line right where the last one ended. Stop short and the corner has a gap; run past and it has an ugly tail. Slow down just slightly as you come in, without digging in.',
        more: 'A rounded corner means you kept moving as you turned. An overlap means you carried on past the point. Going over a corner twice also darkens and widens it, so get it right the first time.' },
      { title: 'Keep it consistent', text: 'All four sides should look like one line: the same darkness and the same width. Keep your speed and pressure the same on every side, and reload before the ink runs low.' },
      { title: 'Your grade', text: 'Leave the skin to settle for about a minute, then press Done. Grade C (70) or higher unlocks the next lesson, and more than 1 blowout is still an instant fail.',
        more: 'Your score is your line score, the same as the last lesson, then reduced for poor corners, by up to 25% if all four are bad.' }
    ] },
    { id: '1-4', title: 'Curves', sum: 'An S that runs on into a circle, with the same weight of line all the way. Grade C or higher moves you on.', task: 'l-curve', steps: [
      { title: 'An S that becomes a circle', pic: { needles: ['5RL'] }, text: 'Same 5RL. This time the line starts as an S, and its second curl carries on around to form a circle that does not quite close. No corners to hide in: just flowing curves.' },
      { title: 'Move from the arm', text: 'Small curves can come from the fingers, but big ones need your whole arm and shoulder moving together. Fingers alone make flat spots and wobbles.',
        more: 'Practise the shape in the air above the skin first, so your arm knows the path before the needle lands.' },
      { title: 'Stop and restart if you need to', text: 'You do not have to pull it in one go. Stop where it is comfortable, turn the page with two fingers, then land while moving, just behind where you stopped, and carry on along the same line.',
        more: 'A restart that lands too heavy leaves a dark spot, and one that misses the line leaves a step. Ease in so the join disappears. Up to 8 strokes are allowed; each one more costs 3 points.' },
      { title: 'Consistent weight', text: 'This is what you are judged on. The line should be the same thickness and darkness the whole way around. Curves tempt you to slow down and dig in, so keep your speed and pressure steady.',
        more: 'A thick patch usually means you slowed down or pressed in. A thin patch means you sped up or lifted. Going back over a line to fix it usually makes it thicker there.' },
      { title: 'Your grade', text: 'Leave the skin to settle for about a minute, then press Done. Grade C (70) or higher unlocks the next lesson, and more than 1 blowout is still an instant fail.',
        more: 'Your score is your line score, then reduced by up to 30% if the thickness of the line changes along the way, shown as Weight on your report card.' }
    ] },
    { id: '1-5', title: 'The flag', sum: 'Everything so far in one piece: straight lines, sharp corners and S curves. Grade C or higher finishes the chapter.', task: 'l-flag', steps: [
      { title: 'Putting it all together', pic: { needles: ['5RL'] }, text: 'Your last beginner linework lesson: a flag on a pole, with the same 5RL. The pole is your straight line, the waving edges are your S curves, the corners are your corners, and the ball on top is your circle.' },
      { title: 'Plan your order', text: 'Think before you start. Pull the long pole first, then the flag edges into it, then the end of the flag. Turn the page with two fingers whenever a pull feels awkward.',
        more: 'Lines that meet another line should land right on it and stop. Do not cross the pole, and do not leave a gap.' },
      { title: 'Everything counts', text: 'Your line stays on the stencil, even and solid. Your corners are sharp, not rounded and not running past. Your weight is the same on the straight parts as on the curves.',
        more: 'Reload before the ink runs low, so a thin patch does not sneak into the last line. Keep the same speed and pressure on every line. Up to 12 strokes are allowed; each one more costs 3 points.' },
      { title: 'Your grade', text: 'Leave the skin to settle for about a minute, then press Done. Grade C (70) or higher finishes the chapter, and more than 1 blowout is still an instant fail.',
        more: 'Your score is your line score, reduced by up to 20% for poor corners and up to 10% for changing line weight. Both reductions apply together.' }
    ] }
  ] },
  { name: 'Chapter 2: Intermediate', lessons: [
    { id: '2-1', title: 'Solid black', sum: 'Line a small square, then pack it solid black with no patches. Grade C or higher moves you on.', task: 'l-pack', steps: [
      { title: 'Two needles, one small square', pic: { needles: ['5RL', '7RS'] }, text: 'A 1 cm square. Line it first with a #10 5RL, then change to a #12 7RS and pack it solid black. You choose the needle in the workspace, so remember to change it.',
        more: 'The outline gives you a wall to work up to. Line it the way you learned in Chapter 1, sharp corners included: up to 8 strokes with the 5RL, two per side, and each one more costs 3 points. Packing with the 7RS has no stroke limit.' },
      { title: 'The circular motion', pic: { motion: true }, text: 'There are a few ways to get solid colour, but the easiest to grasp is tight little circles. Stack 3 to 4 rows at once as you move across: 3 up, 1 to the right, 3 down, 1 to the right, and repeat to the far side. Then come back the same way.',
        more: 'Every circle overlaps the one before, and each trip overlaps the previous row. The picture is one continuous stroke, stretched out so you can see the path. On skin the circles sit far tighter, with no skin showing between them.' },
      { title: 'Keep it consistent', text: 'Your movement and depth must always stay the same. Keep the circles tight and do not dig. Consistency matters most here: patchy work is not allowed.',
        more: 'A patch usually comes from speeding up, lifting a little, or running low on ink. Digging in to fix a light spot chews up the skin and makes it worse, so come back over it with the same steady motion.' },
      { title: 'No scratching', text: 'Do not scrub back and forth like colouring in with a crayon. It can look dark, but it scratches ink in unevenly and chews up the skin. Your motion is graded: circles or ovals keep turning the same way, while scrubbing keeps changing direction and can take off up to 70%.' },
      { title: 'Stay inside the line', text: 'Work up to your outline without going over it. Slow your sweep slightly as you reach the edge and turn back, rather than running out past it.' },
      { title: 'Take a break if you need to', text: 'You do not have to do it all in one go. If the skin is getting bruised, stop and let it settle, then carry on. With consistent work it can easily be done in one go.',
        more: 'Skin starts settling a few seconds after the needle moves away, but badly overworked skin stays damaged and will not take ink well.' },
      { title: 'Your grade', text: 'When it is solid and the skin has settled, press Done. Grade C (70) or higher moves you on, and more than 1 blowout is an instant fail.',
        more: 'Consistency counts most: how evenly your passes are layered across the square, even where it already looks dark. Then saturation, how much is solid and staying inside the line. A shaky or missing outline can take off up to 10%. Technique can take off up to 70% if your motion keeps changing direction, and Control up to half if you rush or your speed and depth keep changing. Skin condition is part of the grade, as always.' }
    ] },
    { id: '2-2', title: 'Orange circle', sum: 'Line a small circle in black, then pack it in orange that heals solid. Grade C or higher moves you on.', task: 'l-orange', steps: [
      { title: 'Line, then pack in colour', pic: { needles: ['7RL', '7M1'] }, text: 'A 1.2 cm circle. Line it in black with a #10 7RL, then change to a #12 7M magnum and pack it solid orange. Your line is judged as well as your packing.',
        more: 'A new needle starts clean, so the black from your lining won\'t muddy the orange. Up to 4 strokes are allowed for the line; each one more costs 3 points.' },
      { title: 'Mixing orange', pic: { caps: true }, text: 'There is no orange cap: mix it. Hold the pen in the red cap, then in the yellow, about the same time in each. More red makes a deeper orange, more yellow a brighter one.',
        more: 'Ink mixes like real pigment. Your orange is judged against an even mix of the red and yellow caps, so aim for the middle.' },
      { title: 'Same circles, a little oval', pic: { motion: true }, text: 'Pack with the same tight circular motion as Solid black, stretched into slight ovals so the magnum\'s flat edge lays the colour down evenly. Keep turning the same way.',
        more: 'Overlap every pass, keep your speed and depth steady, and meet the line rather than going over it.' },
      { title: 'Colour has to last', text: 'Colour needs plenty of passes to heal solid. You are judged on how it holds up over 10 years, so keep layering evenly until it is fully saturated, without chewing up the skin.',
        more: 'Thin spots look fine fresh but heal patchy, and patches show more in colour than in black. Check the Healed and 10 years views on your report.' },
      { title: 'Your grade', text: 'When it is solid and the skin has settled, press Done. Grade C (70) or higher moves you on, and more than 1 blowout is an instant fail.',
        more: 'Consistency counts most, then how it heals, your colour, saturation and staying inside the line. Your line, technique and control are part of the grade too, and skin condition counts as always.' }
    ] },
    { id: '2-3', title: 'Stipple shading', sum: 'Line a rectangle, then shade a smooth gradient inside it using only the dots a fast whip leaves. Grade C or higher moves you on.', task: 'l-stipple', steps: [
      { title: 'Line at full power', pic: { needles: ['3RL'] }, text: 'A 0.6 × 2 cm rectangle. Line it in black with a #08 3RL at about 7.2 volts (7.0 to 7.6): the lesson starts you there. Up to 8 strokes for the line; each one more costs 3 points.',
        more: 'A lining machine needs to run strong so the needle goes in clean and the line heals solid. Leave the voltage where it is until the line is done.' },
      { title: 'Turn it right down', text: 'Keep the same needle and lower the voltage to between 4.8 and 5.8 volts. Running slow, each pass of the needle leaves separate little dots instead of a solid line.',
        more: 'This is what stippling is: a slow-running machine and a quick hand. The dots are what build the shade, so the voltage has to be low enough that they stay apart.' },
      { title: 'Whip, don\'t drag', pic: { whip: true }, text: 'Shade with quick, even whips: land softly on the move, flick through, and lift off on the move. Each whip is a short straight flick: a quick taper in, a little solid, then a long taper out that breaks into dots.',
        more: 'Stopping or pressing at either end of a whip leaves a heavy dot or a dark smudge. Keep every whip the same speed and length so the dots fall evenly.' },
      { title: 'Build the gradient in layers', text: 'Make one end dark and fade smoothly to almost bare skin at the other. Go over the dark end many times and the light end only a few, in layers, so there is no hard step anywhere.',
        more: 'Work from the dark end outwards and shorten each layer a little, so the dots thin out gradually. Keep it dots: if the dark end turns solid you have packed it, not stippled it.' },
      { title: 'Stay inside the lines', text: 'Your whips must start and finish inside the rectangle. A whip that runs over the line, as it starts or as it finishes, leaves dots outside that cannot be taken back.',
        more: 'Aim the flick so it ends just short of the line, and turn the rectangle so you whip along its length if that helps.' },
      { title: 'Your grade', text: 'When the gradient is done and the skin has settled, press Done. Grade C (70) or higher moves you on. An uneven or patchy gradient or more than 1 blowout is an instant fail. One crash landing is free; each one after costs a point.',
        more: 'Trevor\'s example sits beside you while you work: aim for that look. The gradient counts most: dark at one end, light at the other, smooth in between and even from side to side. Then keeping it to dots, staying inside the line, whipping, your voltage for each part, and how straight your outline is. Skin condition counts as always.' }
    ] }
,
    { id: '2-4', title: 'Whip shading', sum: 'Line a rectangle, then whip a smooth grey wash gradient into it with a curved magnum, from black to the lightest wash. Grade C or higher moves you on.', task: 'l-whipgrey', steps: [
      { title: 'Line it', pic: { needles: ['9RL', '13CM'] }, text: 'A 1 × 2.5 cm rectangle. Line it in black with a #10 9RL at about 7.5 volts. The lesson starts you on it, set up.',
        more: 'The ink tray is on the grey wash set: Black is full strength, then Dark, Mid and Light. Line with Black.' },
      { title: 'Change to the curved mag', text: 'Switch to the 13 curved magnum (13CM). It is set to about 6.6 volts, softer than your liner, for shading.',
        more: 'A curved mag has its needle tips in an arc, so the middle hits harder than the ends. That is what makes its edges soft and lets shading blend.' },
      { title: 'Whip from black to light', text: 'Start with Black at the dark end and whip it out towards the middle. Then rinse, dip the next lighter wash, and whip it over the end of the last one, fading it further. Carry on down to Light.',
        more: 'Each wash fades off the one before it, so the steps disappear. You cannot get this gradient by whipping straight black lighter and lighter: the lesson checks that you used the diluted washes. Back-and-forth pendulum whips are fine too.' },
      { title: 'Whip, never pack', pic: { whip: true }, text: 'Every stroke is a whip: land on the move, flick through and lift off on the move. No circles and no packing: the shade has to come from whips laid over each other.',
        more: 'Packing colour in circles gives a flat, solid tone. Whips give the soft fade a grey wash needs. Packing in this lesson is an instant fail.' },
      { title: 'Shade away from the line', text: 'At the light end, turn around and whip away from the end line, back into your previous shade, instead of whipping towards the line.',
        more: 'Whipping towards a line is risky: the flick runs on and crosses it. Starting at the line and whipping away keeps the edge clean.' },
      { title: 'Tilt for a hard edge', text: 'Where the shade meets a line, tilt the curved mag slightly so one end of it sits against the line. That gives a harder edge there and avoids holidays.',
        more: 'A holiday is a light gap between your line and your shade, about as thick as the line. This is your first lesson in tilting the needle: tilted, the mag makes a harder edge; flat, a soft one.' },
      { title: 'Your grade', text: 'When the gradient is done and the skin has settled, press Done. Grade C (70) or higher moves you on. Packing, an uneven gradient, not using the lighter washes or more than 1 blowout is an instant fail. One crash landing is free; each one after costs a point.',
        more: 'The gradient counts most: dark to light, smooth and even from side to side. Then whipping instead of packing, using the washes in turn, hard edges with no holidays, staying inside the line, and your voltage on each needle. Skin condition counts as always.' }
    ] },
    { id: '2-5', title: 'Colour blend', sum: 'Line a long triangle in red, then blend it from a dark red shadow at the point, through red and orange, to yellow at the wide end. Grade C or higher moves you on.', task: 'l-blend', steps: [
      { title: 'Line it in red', pic: { needles: ['7RL', '11M1'] }, text: 'A triangle 1.5 cm wide and 5 cm long. Line it in red with a #12 7RL at about 7.5 volts. The lesson starts you on it, set up.',
        more: 'For a really sharp point, give the line a slight whip as you pull out of the corner, so it tapers off a little.' },
      { title: 'The shadow at the point', text: 'Change to the #10 11 magnum. Mix black and red for the shadow and start at the sharp point: whip into it, angling and tilting the magnum to squeeze into the corner without going over the line. Whip it out to a little past a quarter of the way along.',
        more: 'This starts the same way as the grey wash: dark at the end, whipped out so it fades. Tip: in the magnum angle settings, turn off "Follows the way the pen leans" so the magnum stays in one position, then turn the page with two fingers until the point sits where you can squeeze the magnum into it comfortably.' },
      { title: 'Pack the red on top', pic: { motion: true }, text: 'Rinse, load red, and pack it over the shadow and on past it, so everything is nicely saturated. Do not overwork it.',
        more: 'Pack with tight overlapping ovals and blend the red into the shadow rather than stopping at a hard edge.' },
      { title: 'Optional: deepen the point', text: 'With the red in, you can switch to straight black and lightly brush it onto the point, over your black and red mix, until you see a gradient. Do not go crazy.',
        more: 'Black laid first can dull in a tattoo, so adding it on top at the end lifts the contrast. A little of the magnum\'s step texture running through the colour looks very nice too.' },
      { title: 'Orange to three quarters', text: 'Rinse, mix orange from red and yellow, and with a mix of packing and feathering (whipping), saturate it over the end of the red and feather it out to about three quarters of the way along.',
        more: 'Overlap the red so the two blend; there should be no line where one colour stops and the next starts.' },
      { title: 'Yellow at the wide end', text: 'Rinse, take yellow and pack it smoothly into the last quarter, blending into the orange.',
        more: 'Yellow is light and shows every patch, so lay it evenly and keep going until it is solid.' },
      { title: 'Your grade', text: 'When it is blended and the skin has settled, press Done. Grade C (70) or higher moves you on. More than 1 blowout is an instant fail. One crash landing is free; each one after costs a point.',
        more: 'Judged on your linework and a sharp point, saturation, how evenly the colours blend, how close each part is to the colours asked for, and solid healing with no patches. Your voltage, staying inside the line and skin condition count too.' }
    ] }  ] },
  { name: 'Chapter 3: Advanced', lessons: [] }
];
// A flag on a pole, in mm: pole, ball, two waving edges (each an S) and the flag's end.
const TT_FLAG = [['l', 45, 30, 45, 110], ['a', 45, 26, 4, 90, 450], ['c', 45, 36, 60, 18, 72, 18, 77.5, 36], ['c', 77.5, 36, 83, 54, 97, 36, 110, 36], ['l', 110, 36, 110, 70], ['c', 45, 70, 60, 52, 72, 52, 77.5, 70], ['c', 77.5, 70, 83, 88, 97, 70, 110, 70]];
const ttGeomDraw = (g, segs) => { for (const s of segs) { if (s[0] === 'l') { g.moveTo(s[1], s[2]); g.lineTo(s[3], s[4]); } else if (s[0] === 'c') { g.moveTo(s[1], s[2]); g.bezierCurveTo(s[3], s[4], s[5], s[6], s[7], s[8]); } else { const a0 = s[4] * Math.PI / 180; g.moveTo(s[1] + s[3] * Math.cos(a0), s[2] + s[3] * Math.sin(a0)); g.arc(s[1], s[2], s[3], a0, s[5] * Math.PI / 180); } } };
// Points about every half millimetre along a shape, each with the direction straight across the line.
const ttGeomPts = (segs) => segs.flatMap(s => { const out = [];
  if (s[0] === 'l') { const L = Math.hypot(s[3] - s[1], s[4] - s[2]), n = Math.ceil(L / 0.5); for (let i = 0; i <= n; i++) out.push({ x: s[1] + (s[3] - s[1]) * i / n, y: s[2] + (s[4] - s[2]) * i / n, nx: -(s[4] - s[2]) / L, ny: (s[3] - s[1]) / L }); }
  else if (s[0] === 'a') { const n = Math.ceil(Math.abs(s[5] - s[4]) * Math.PI / 180 * s[3] / 0.5); for (let i = 0; i <= n; i++) { const a = (s[4] + (s[5] - s[4]) * i / n) * Math.PI / 180; out.push({ x: s[1] + s[3] * Math.cos(a), y: s[2] + s[3] * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) }); } }
  else { const n = 80; for (let i = 0; i <= n; i++) { const u = i / n, v = 1 - u, f = (a, b, c, d) => v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d, df = (a, b, c, d) => 3 * v * v * (b - a) + 6 * v * u * (c - b) + 3 * u * u * (d - c), dx = df(s[1], s[3], s[5], s[7]), dy = df(s[2], s[4], s[6], s[8]), L = Math.hypot(dx, dy) || 1; out.push({ x: f(s[1], s[3], s[5], s[7]), y: f(s[2], s[4], s[6], s[8]), nx: -dy / L, ny: dx / L }); } }
  return out; });
// Lesson tasks run in the real workspace like a challenge, but stay out of the challenge list, medals and trophies.
const TT_LS_CH = [{ id: 'l-first', lesson: '1-2', cat: 'line', diff: 1, title: 'Your first line', needle: '5RL', layer: 'line', ink: 'black', kind: 'line', core: 0.6, covEase: 0.86, maxBlow: 1, maxStrokes: 2,
  text: 'Black ink, 5RL. Load the needle, then pull one clean line down the stencil in no more than 2 strokes. Leave the skin to settle for about a minute, then press Done. C or higher unlocks the next lesson.',
  path: (g) => { g.moveTo(90, 35); g.lineTo(90, 95); } },
  { id: 'l-rect', lesson: '1-3', cat: 'line', diff: 1, title: 'Sharp corners', needle: '5RL', layer: 'line', ink: 'black', kind: 'line', core: 0.6, covEase: 0.86, maxBlow: 1, maxStrokes: 8, corners: [[60, 45, -1, -1], [120, 45, 1, -1], [120, 85, 1, 1], [60, 85, -1, 1]],
    text: 'Black ink, 5RL. Line the rectangle: four clean sides with sharp corners, not rounded and not crossing, in no more than 8 strokes. Let the skin settle for about a minute, then press Done. C or higher unlocks the next lesson.',
    path: (g) => { g.moveTo(60, 45); g.lineTo(120, 45); g.lineTo(120, 85); g.lineTo(60, 85); g.closePath(); } },
  { id: 'l-curve', lesson: '1-4', cat: 'line', diff: 1, title: 'Curves', needle: '5RL', layer: 'line', ink: 'black', kind: 'line', core: 0.6, covEase: 0.86, maxBlow: 1, arcs: [[78, 42, 15, -30, -270], [78, 79, 22, -90, 245]], maxStrokes: 8,
    text: 'Black ink, 5RL. Follow the S and on around the circle, with the same weight of line all the way. You can stop and restart, in no more than 8 strokes. Let the skin settle for about a minute, then press Done. C or higher unlocks the next lesson.',
    path: (g) => { g.moveTo(78 + 15 * Math.cos(-Math.PI / 6), 42 + 15 * Math.sin(-Math.PI / 6)); g.arc(78, 42, 15, -Math.PI / 6, -1.5 * Math.PI, true); g.arc(78, 79, 22, -Math.PI / 2, 245 * Math.PI / 180); } },
  { id: 'l-flag', lesson: '1-5', cat: 'line', diff: 1, title: 'The flag', needle: '5RL', layer: 'line', ink: 'black', kind: 'line', core: 0.6, covEase: 0.86, maxBlow: 1, geom: TT_FLAG, joints: [[45, 36], [45, 70], [45, 30], [110, 36], [110, 70]],
    maxStrokes: 12, corners: [[110, 36, 1, -1, 0, 'Top right'], [110, 70, 1, 1, 0, 'Bottom right'], [45, 36, -1, -1, 1, 'Top edge at the pole'], [45, 70, -1, -1, 1, 'Bottom edge at the pole']],
    text: 'Black ink, 5RL. Line the flag: straight pole, ball on top, waving edges and sharp corners, in no more than 12 strokes. Stop edges on the pole without crossing it. Let the skin settle for about a minute, then press Done.',
    path: (g) => ttGeomDraw(g, TT_FLAG) }];
const ttPackPath = (b) => (g) => { g.moveTo(b[0], b[1]); g.lineTo(b[0] + b[2], b[1]); g.lineTo(b[0] + b[2], b[1] + b[3]); g.lineTo(b[0], b[1] + b[3]); g.closePath(); };
TT_LS_CH.push({ id: 'l-stipple', lesson: '2-3', cat: 'pack', diff: 2, title: 'Stipple shading', needle: '3RL', layer: 'line', ink: 'black', kind: 'line', core: 0.6, maxBlow: 1, stipple: [87, 50, 6, 20], needles: ['3RL'], size: 0.25, volt: 7.2, crashFree: 1, refImg: 'img/ref/stipple-example.jpg', refAr: 420 / 220, maxStrokes: 8, linePhase: 6.4, lineVolt: [7.2, 0.4], shadeVolt: [4.8, 5.8], voltMin: 4.5, path: ttPackPath([87, 50, 6, 20]),
  text: 'Line the rectangle with the #08 3RL at about 7.2 volts, in no more than 8 strokes. Then turn it down to 4.8 to 5.8 volts and shade a smooth gradient, dark at one end to light at the other, using only the dots from quick, even whips. Start and finish every whip inside the line. Aim for the look of the example beside you.' });
TT_LS_CH.push({ id: 'l-whipgrey', lesson: '2-4', cat: 'shade', diff: 2, title: 'Whip shading', needle: '9RL', layer: 'line', ink: 'wash', wash: true, kind: 'line', core: 0.6, maxBlow: 1, crashFree: 1, wgrad: [85, 47, 10, 25], needles: ['9RL', '13CM'], lineNeedle: '9RL', shadeNeedle: '13CM', presets: { '9RL': { size: 0.3, volt: 7.5 }, '13CM': { volt: 6.6 } }, refImg: 'img/ref/whip-example.jpg', refAr: 415 / 220, lineVolt: [7.5, 0.4], shadeVolt: [6.6, 0.4], path: ttPackPath([85, 47, 10, 25]),
  text: 'Line the rectangle with the #10 9RL at about 7.5 volts. Then change to the 13 curved mag at about 6.6 volts and whip a smooth gradient: Black at one end, then each lighter wash faded off the last, down to Light. Whips only, no packing. Tilt the mag against the line for a hard edge. Aim for the look of the example beside you.' });
TT_LS_CH.push({ id: 'l-blend', lesson: '2-5', cat: 'pack', diff: 2, title: 'Colour blend', needle: '7RL', layer: 'line', ink: 'red', kind: 'line', core: 0.6, maxBlow: 1, crashFree: 1, tri: [[90, 92.5], [82.5, 42.5], [97.5, 42.5]], needles: ['7RL', '11M1'], liner: '7RL', packNeedle: '11M1', presets: { '7RL': { size: 0.35, volt: 7.5 }, '11M1': { size: 0.3, volt: 6.6 } }, refImg: 'img/ref/blend-example.jpg', refAr: 480 / 195, lineVolt: [7.5, 0.4],
  path: (g) => { g.moveTo(90, 92.5); g.lineTo(82.5, 42.5); g.lineTo(97.5, 42.5); g.closePath(); },
  text: 'Line the triangle in red with the #12 7RL at about 7.5 volts. Then with the #10 11 magnum: a black and red shadow whipped into the point, red packed over it, orange feathered out to three quarters, and yellow packed into the wide end. Blend every change of colour. Aim for the look of the example beside you.' });
TT_LS_CH.push({ id: 'l-pack', lesson: '2-1', cat: 'pack', diff: 2, title: 'Solid black', needle: '5RL', layer: 'line', ink: 'black', kind: 'line', core: 0.6, maxBlow: 1, pack: [85, 55, 10, 10], needles: ['5RL', '7RS'], maxStrokes: 8, strokeNeedle: '5RL', path: ttPackPath([85, 55, 10, 10]),
  text: 'Black ink. Line the square with the 5RL in no more than 8 strokes, then change to the 7RS and pack it solid with tight overlapping circles. Take a break if the skin bruises. Let it settle, then press Done.' });
TT_LS_CH.push({ id: 'l-orange', lesson: '2-2', cat: 'pack', diff: 2, title: 'Orange circle', needle: '7RL', layer: 'line', ink: 'black', kind: 'line', core: 0.6, maxBlow: 1, pack: [84, 54, 12, 12], circle: [90, 60, 6], needles: ['7RL', '7M1'], packNeedle: '7M1', liner: '7RL', maxStrokes: 4, strokeNeedle: '7RL', mixOf: ['#b3261e', '#f2c21b'],
  path: (g) => { g.moveTo(96, 60); g.arc(90, 60, 6, 0, Math.PI * 2); },
  text: 'Line the circle in black with the 7RL in no more than 4 strokes. Then change to the 7M magnum, mix orange from the red and yellow caps, and pack it solid with tight ovals. It has to heal solid. Let it settle, then press Done.' });
const ttGrade = (s) => s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'E';
const TT_LS_PASS = 70;
const TT_BLOW_SEVERE = 7, TT_BLOW_JOKES = ['Did you nod off with your foot on the pedal?', 'That is not shading. That is a bruise with ambition.', 'Your mentor felt that from across town.', 'Somewhere, a client just googled laser removal.', 'The ink has left the building. So has my faith in you.', 'Chores. So many chores.', 'Fat layer says hi. Nobody invited it.'];
const ttLessonRun = async (id) => { const T = TT_LS_CH.find(c => c.id === id), skin = TT_SKINS[ttChSkin()][1], exam = { v: 1, mode: 'ch', lesson: T.lesson, list: [id], i: 0, res: [], started: Date.now() };
  const rows = await DB.all(`SELECT id, meta FROM tattoo_pieces WHERE meta LIKE '%"mode":"ch"%'`), hit = rows.find(r => { try { return JSON.parse(r.meta).exam?.list?.[0] === id; } catch { return false; } });
  if (hit) { let m = {}; try { m = JSON.parse(hit.meta); } catch {} await DB.run(`UPDATE tattoo_pieces SET meta = ?, skin = ?, updated_at = datetime('now') WHERE id = ?`, [JSON.stringify({ ...m, exam }), skin, hit.id]); location.hash = 'tattoo/' + hit.id; return; }
  await DB.run('INSERT INTO tattoo_pieces (name, w_cm, h_cm, skin, meta) VALUES (?, ?, ?, ?, ?)', ['Lesson: ' + T.title, 18, 13, skin, JSON.stringify({ exam })]);
  location.hash = 'tattoo/' + (await DB.one('SELECT last_insert_rowid() AS id')).id; };
const ttLessonList = () => TT_LESSONS.flatMap(c => c.lessons);
const ttLessonProg = () => { try { return { done: {}, ...JSON.parse(Settings.get('tt_lessons', '{}')) }; } catch { return { done: {} }; } };
// A lesson opens once every lesson before it is done.
const ttLessonOpen = (id, p) => { const a = ttLessonList(), n = a.findIndex(l => l.id === id); return a.slice(0, n).every(l => p.done[l.id]); };
// Needle tips from below, drawn from the same layout the simulator tattoos with.
const ttNeedleSvg = (id, size) => { const nd = TT_NEEDLES.find(n => n.id === id), f = size ?? TT.feelBase(id).size, lay = ttLayout(nd, f), R = Math.max(0.5, ...lay.map(q => Math.hypot(q.u, q.v) + f)) * 1.1;
  return `<svg viewBox="${-R} ${-R} ${R * 2} ${R * 2}" role="img" aria-label="${esc(nd.name)}"><circle r="${(R * 0.99).toFixed(3)}" class="tt-lsbg"/>${lay.map(q => `<circle cx="${q.u.toFixed(3)}" cy="${q.v.toFixed(3)}" r="${(f * 0.42).toFixed(3)}" class="tt-lsdot"/>`).join('')}</svg>`; };
// The packing path, neatly: tight loops stacked 3 rows high, stepping sideways up and down the column.
/* A stipple whip: a short taper in (a few dots closing up), a short solid run, then a long taper out where the dots
   spread further and further apart. Three whips laid side by side, the way a row of shading builds up. */
const ttWhipSvg = () => { const rows = [26, 46, 66].map((y, r) => { const x0 = 18 + r * 10, out = [];
    [0, 7, 12, 15].forEach(d => out.push(`<circle cx="${x0 + d}" cy="${y}" r="1.6"/>`));
    out.push(`<path d="M${x0 + 18} ${y}h${46}" stroke-width="3.4" stroke-linecap="round"/>`);
    let x = x0 + 68, gap = 3.2; for (let k = 0; k < 13 && x < 300; k++) { out.push(`<circle cx="${x.toFixed(1)}" cy="${(y + (k % 3 - 1) * 0.6).toFixed(1)}" r="${Math.max(0.9, 1.6 - k * 0.05).toFixed(2)}"/>`); x += gap; gap *= 1.33; }
    return out.join(''); }).join('');
  return `<div class="tt-whip"><svg viewBox="0 0 320 92" style="fill:var(--ink);stroke:var(--ink)">${rows}<path d="M14 84h80" stroke-width="1" stroke-dasharray="2 3" fill="none" style="stroke:var(--ink2)"/><path d="M110 84h196" stroke-width="1" stroke-dasharray="2 3" fill="none" style="stroke:var(--ink2)"/><text x="16" y="91" font-size="7" style="fill:var(--ink2);stroke:none">taper in</text><text x="112" y="91" font-size="7" style="fill:var(--ink2);stroke:none">long taper out</text></svg><p class="muted">Quick, straight and even: lift off while still moving</p></div>`; };
const ttMotionSvg = () => { const C = [], h = 33, sx = 14, x0 = 24, yB = 74; for (let c = 0; c < 15; c++) { const x = x0 + c * sx; C.push(c % 2 ? [x, yB - h] : [x, yB], c % 2 ? [x, yB] : [x, yB - h]); }
  const pts = [], r = 8, per = 11; let travelled = 0; for (let i = 1; i < C.length; i++) { const a = C[i - 1], b = C[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(L / 0.5); for (let j = 0; j < n; j++) { const s = travelled + L * j / n, an = s / per * Math.PI * 2, f = j / n; pts.push([a[0] + (b[0] - a[0]) * f + r * Math.cos(an), a[1] + (b[1] - a[1]) * f + r * Math.sin(an)]); } travelled += L; }
  const d = pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' ');
  return `<svg class="tt-lsmotion" style="width:100%;height:auto;aspect-ratio:2.5" viewBox="0 0 250 100" role="img" aria-label="Tight overlapping circles moving up and down in columns, stepping from left to right"><path d="${d}" class="tt-lsmpath"/><path d="M14 94H236M228 89l8 5-8 5" class="tt-lsmarrow"/></svg>`; };
const ttLessonPic = (pic) => { if (!pic) return '';
  if (pic.motion) return ttMotionSvg();
  if (pic.whip) return ttWhipSvg();
  if (pic.needles) return `<div class="tt-lspics">${pic.needles.map(id => `<figure>${ttNeedleSvg(id)}<figcaption>${id}</figcaption></figure>`).join('')}</div>`;
  if (pic.sizes) return `<div class="tt-lspics">${[[0.25, '#08', '0.25 mm'], [0.3, '#10', '0.30 mm'], [0.35, '#12', '0.35 mm']].map(([s, n, m]) => `<figure>${ttNeedleSvg('3RL', s)}<figcaption>${n}<br><span class="muted">${m}</span></figcaption></figure>`).join('')}</div>`;
  if (pic.table) return `<div class="tt-sum tt-lstable">${pic.table.map(([a, b]) => `<b>${a}</b><span>${b}</span>`).join('')}</div>`;
  if (pic.caps) return `<div class="tt-lsswatch">${TT_CAPS.map(c => `<i style="background:${c}"></i>`).join('')}</div>`;
  if (pic.skins) return `<div class="tt-lsswatch">${TT_SKINS.map(([n, c]) => `<i style="background:${c}" data-tip="${n}"></i>`).join('')}</div>`;
  return ''; };
TT.lessons = (el) => { ttStyle();
  if (TT.lessonBack) { const b = TT.lessonBack; TT.lessonBack = null; return TT.lesson(el, b.id, b.i); }
  const p = ttLessonProg();
  el.innerHTML = `<div class="tt-hub">${ttTryBar()}<div class="row" style="margin-bottom:12px;gap:8px"><button class="btn icon-btn" data-go="tattoo" aria-label="Back" data-tip="Back to your pieces"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button><b style="flex:1">Lessons</b><span class="muted" style="font-size:12px">Build ${TT_BUILD}</span>${Object.keys(p.done).length ? '<button class="btn small" data-lsall data-tip="Clear every lesson and lock them again">Reset all</button>' : ''}</div>
    ${p.last ? (() => { const l0 = ttLessonList().find(x => x.id === p.last.lesson); return l0 ? `<button class="tt-lsrow" style="width:100%;margin-bottom:12px" data-lslast><span class="tt-lsno">${ttGrade(p.last.total)}</span><span class="tt-lsmeta"><b>Open last lesson</b><span class="muted">${esc(l0.title)} · ${p.last.total} / 100 · ${new Date(p.last.when).toLocaleString()}</span></span></button>` : ''; })() : ''}
    ${TT_LESSONS.map(c => `<div class="letter">${c.name}</div>${c.lessons.length ? `<div class="tt-lslist">${c.lessons.map(l => { const open = ttLessonOpen(l.id, p), ready = !!l.steps?.length, can = open && ready;
      return `<div class="row" style="gap:6px;flex-wrap:nowrap"><button class="tt-lsrow ${can ? '' : 'off'}" style="flex:1" ${can ? `data-ls="${l.id}"` : 'disabled'}><span class="tt-lsno">${p.done[l.id] ? '✓' : l.id.split('-')[1]}</span><span class="tt-lsmeta"><b>${esc(l.title)}${p.best?.[l.id] != null ? ` · ${ttGrade(p.best[l.id])}` : ''}</b><span class="muted">${esc(l.sum)}</span></span><span class="muted tt-lsst">${!ready ? 'Coming soon' : p.done[l.id] ? 'Done' : open ? 'Start' : 'Locked'}</span></button>${can && l.task ? `<button class="btn small" data-lscmp="${l.id}" data-tip="Compare two attempts at this lesson side by side: yours, Trevor's, an apprentice's or another artist's">Compare</button>` : ''}${p.results?.[l.id] ? `<button class="btn small" data-lres="${l.id}">Result</button>` : ''}${p.best?.[l.id] != null || p.results?.[l.id] ? `<button class="btn small" data-lsone="${l.id}" data-tip="Clear this lesson's best and result, and keep it unlocked">Reset</button>` : ''}</div>`; }).join('')}</div>` : '<p class="muted" style="font-size:13px">Lessons coming soon.</p>'}`).join('')}</div>`;
  const dropResult = async (P, id) => { const R = P.results?.[id]; if (R?.ref) await Media.release(R.ref); if (R?.heat) await Media.release(R.heat); if (P.results) delete P.results[id]; if (P.best) delete P.best[id]; };
  el.onclick = async (e) => { const one = e.target.closest('[data-lsone]')?.dataset.lsone; if (one) { const l = ttLessonList().find(x => x.id === one); if (!await ask(`Reset "${l.title}"? Its best score and saved result are cleared, and it stays unlocked. Your next attempt becomes the new best, even if it's lower.`)) return; const P = ttLessonProg(); await dropResult(P, one); await Settings.set('tt_lessons', JSON.stringify(P)); return TT.lessons(el); }
    if (e.target.closest('[data-lsall]')) { if (!await ask('Reset all lessons? Every score and saved result is cleared, and the lessons lock again from the start. Copies in your portfolio stay.')) return; const P = ttLessonProg(); for (const k of Object.keys(P.results || {})) await dropResult(P, k); for (const k of ['ref', 'heat', 'page']) if (P.last?.[k]) await Media.release(P.last[k]); await Settings.set('tt_lessons', '{}'); return TT.lessons(el); }
    const cl = e.target.closest('[data-lscmp]')?.dataset.lscmp; if (cl) return TT.compare(cl); if (e.target.closest('[data-lslast]')) return ttLessonResult(null, true); const v = e.target.closest('[data-lres]'); if (v) return ttLessonResult(v.dataset.lres); const r = e.target.closest('[data-ls]'); if (r) TT.lesson(el, r.dataset.ls, 0); };
};
// A report's picture: the finished piece, with a toggle to the heat map and its notes; tap for full screen.
const TT_LEG_LINE = '<div class="tt-lsleg"><i style="background:#3cdc78"></i>On the line<i style="background:#f03c3c"></i>Missed<i style="background:#ff9628"></i>Off the line<i style="background:#783caa"></i>Overworked<i style="background:#3c82ff"></i>Blowout</div>', TT_LEG_PACK = '<div class="tt-lsgrad"><span>Fewer passes</span><i></i><span>More passes</span></div><div class="tt-lsleg"><i style="background:#ff9628"></i>Off the line<i style="background:#783caa"></i>Overworked<i style="background:#3c82ff"></i>Blowout</div>';
const ttShotHtml = (pu, hu, notes, pack) => `<div class="tt-lsshot">${hu ? '<div class="seg" style="margin:10px 0 8px"><button class="on" data-shot="p" style="flex:1">Finished piece</button><button data-shot="h" style="flex:1">Heat map</button></div>' : ''}
  <img class="tt-chshot tt-lsimg" src="${pu}" alt="The attempt" data-tip="Tap to view full screen"><div class="tt-lsheatinfo" hidden>${pack ? TT_LEG_PACK : TT_LEG_LINE}<ul class="tt-lsnotes">${(notes || []).map(n => `<li>${esc(n)}</li>`).join('')}</ul></div></div>`;
// A small PDF: one A4 page holding a JPEG, then pages of real text, so the stats can be selected and copied back out.
const ttStatsPdf = (jpeg, iw, ih, text) => { const enc = new TextEncoder(), wrap = []; let rest = text.replace(/[^\x20-\x7e]/g, '?'); while (rest.length) { if (rest.length <= 105) { wrap.push(rest); break; } let cut = rest.lastIndexOf(',', 105); if (cut < 40) cut = 104; wrap.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1); }
  const pages = []; for (let i = 0; i < wrap.length; i += 76) pages.push(wrap.slice(i, i + 76)); const objs = [], n = pages.length, kids = [3, ...pages.map((_, i) => 7 + i * 2)];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'; objs[2] = `<< /Type /Pages /Count ${n + 1} /Kids [${kids.map(k => k + ' 0 R').join(' ')}] >>`; objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /I 5 0 R >> >> /Contents 4 0 R >>';
  const pic = 'q 595 0 0 842 0 0 cm /I Do Q'; objs[4] = `<< /Length ${pic.length} >>\nstream\n${pic}\nendstream`; objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>';
  pages.forEach((ls, i) => { const body = `BT /F 8 Tf 10 TL 30 806 Td ${i ? '' : '(Stats for comparing attempts) Tj T* T* '}${ls.map(l => `(${l.replace(/([\\()])/g, '\\$1')}) Tj T*`).join(' ')} ET`, a = 7 + i * 2; objs[a] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F 6 0 R >> >> /Contents ${a + 1} 0 R >>`; objs[a + 1] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`; });
  const parts = [enc.encode('%PDF-1.4\n')], off = []; let pos = parts[0].length; const add = (b) => { parts.push(b); pos += b.length; };
  for (let i = 1; i < objs.length; i++) { off[i] = pos; if (i === 5) { add(enc.encode(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`)); add(jpeg); add(enc.encode('\nendstream\nendobj\n')); } else add(enc.encode(`${i} 0 obj\n${objs[i]}\nendobj\n`)); }
  const xref = pos; add(enc.encode(`xref\n0 ${objs.length}\n0000000000 65535 f \n${off.slice(1).map(v => String(v).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)); return new Blob(parts, { type: 'application/pdf' }); };
// A row of plain numbers from the stats block, under the bars.
const ttChips = (txt) => { let s = null; try { s = JSON.parse(txt); } catch {} if (!s) return ''; const m = Math.floor((s.needleSeconds || 0) / 60), sec = Math.round((s.needleSeconds || 0) % 60), c = [['Needle time', m ? `${m} m ${sec} s` : `${sec} s`], ...(s.passes ? [['Passes per spot', Math.round(s.passes.mean)]] : []), ['Blowouts', s.blowouts || 0], ['Undos', s.undos || 0]]; return `<div class="tt-lschips">${c.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('')}</div>`; };
const ttShotBind = (root, pu, hu) => { const im = root.querySelector('.tt-lsimg'), info = root.querySelector('.tt-lsheatinfo'); let cur = 'p';
  root.querySelectorAll('[data-shot]').forEach(b => b.onclick = () => { cur = b.dataset.shot; root.querySelectorAll('[data-shot]').forEach(x => x.classList.toggle('on', x === b)); im.src = cur === 'h' ? hu : pu; info.hidden = cur !== 'h'; });
  im.onclick = () => ttZoom(pu, hu, cur); };
// Full screen, to get right up close: two fingers or the wheel to zoom, drag to move, double tap to reset.
const ttZoom = (pu, hu, start) => { const o = document.createElement('div'); o.id = 'tt-zoom'; let cur = start, z = 1, x = 0, y = 0, pin = null, lastTap = 0; const P = new Map();
  o.innerHTML = `<img alt="" draggable="false"><div class="tt-zbar">${hu ? `<div class="seg"><button data-z="p" class="${cur === 'p' ? 'on' : ''}">Piece</button><button data-z="h" class="${cur === 'h' ? 'on' : ''}">Heat map</button></div>` : ''}<span style="flex:1"></span><button class="btn small" data-z="out" aria-label="Zoom out">−</button><button class="btn small" data-z="in" aria-label="Zoom in">+</button><button class="btn small primary" data-z="close">Close</button></div>`;
  const im = o.querySelector('img'), show = () => { im.style.transform = `translate(${x}px, ${y}px) scale(${z})`; }, setZ = (n, cx = innerWidth / 2, cy = innerHeight / 2) => { n = Math.max(1, Math.min(16, n)); const dx = cx - innerWidth / 2 - x, dy = cy - innerHeight / 2 - y; x += dx - dx * n / z; y += dy - dy * n / z; z = n; if (z === 1) x = y = 0; show(); };
  const load = () => { im.src = cur === 'h' ? hu : pu; z = 1; x = y = 0; show(); }; load();
  o.onclick = (e) => { const a = e.target.closest('[data-z]')?.dataset.z; if (!a) return; if (a === 'close') return o.remove(); if (a === 'in') return setZ(z * 1.5); if (a === 'out') return setZ(z / 1.5); cur = a; o.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.z === a)); load(); };
  o.onwheel = (e) => { e.preventDefault(); setZ(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); };
  im.onpointerdown = (e) => { e.preventDefault(); im.setPointerCapture?.(e.pointerId); P.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (P.size === 2) { const [a, b] = [...P.values()]; pin = { d: Math.hypot(a.x - b.x, a.y - b.y), z }; } else { if (e.timeStamp - lastTap < 300) setZ(z > 1 ? 1 : 3, e.clientX, e.clientY); lastTap = e.timeStamp; } };
  im.onpointermove = (e) => { const p = P.get(e.pointerId); if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; if (P.size >= 2 && pin) { const [a, b] = [...P.values()]; setZ(pin.z * Math.hypot(a.x - b.x, a.y - b.y) / pin.d, (a.x + b.x) / 2, (a.y + b.y) / 2); } else if (z > 1) { x += dx; y += dy; show(); } };
  im.onpointerup = im.onpointercancel = (e) => { P.delete(e.pointerId); if (P.size < 2) pin = null; };
  document.body.appendChild(o); };
// A small progress card for the few seconds between pressing Done and the report card. ttFrame lets it paint first.
const ttFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
const ttBusy = (label, frac) => { let o = document.getElementById('tt-busy'); if (label == null) { o?.remove(); return; } if (!o) { o = document.createElement('div'); o.id = 'tt-busy'; o.innerHTML = '<div class="card"><b></b><i><s></s></i></div>'; document.body.appendChild(o); } o.querySelector('b').textContent = label + '…'; o.querySelector('s').style.width = Math.round(frac * 100) + '%'; };
/* ---------- Compare stats ----------
   Two attempts side by side: yours from this device, a pasted stats block, a file (the stats text, or a PDF this app
   made, which carries the stats as text and the report as a picture), or a reference artist's attempt that ships with
   the app. Builds a table of every stat both share, a speed chart, and plain advice on what the first could learn. */
// Reference attempts that ship with the app: { name, note, stats, img } where stats is the copied stats text and img the
// report page. The PDF text is only read from where the text starts, as the picture before it can hold any bytes.
const TT_REF_STATS = [
  { name: "Trevor", note: "Colour blend \u00b7 A 92", img: 'img/ref/trevor-2-5.jpg', stats: "{\"inkforge_stats\":1,\"artist\":\"Trevor Schuster\",\"build\":332,\"lesson\":\"2-5\",\"task\":\"l-blend\",\"when\":\"2026-11-09T11:30:38.412Z\",\"grade\":\"A\",\"total\":92,\"parts\":{\"score\":90,\"outline\":59,\"saturation\":100,\"coverage\":100,\"colour\":93,\"blend\":100,\"healing\":97,\"voltage\":100,\"spill\":0,\"bandColours\":\"#1e1716 #201715 #3e1a17 #71201a #a72a1c #c0421c #d0561c #d5681c #e08c1b #eeb51b\"},\"skin\":100,\"traumaMax\":0.19,\"traumaAvg\":0.04,\"blowouts\":0,\"blowSpots\":[],\"maxStrokes\":null,\"extraStrokes\":0,\"undos\":0,\"lasers\":0,\"penalty\":0,\"dips\":16,\"needleSeconds\":261.1,\"pauses\":19,\"pauseSeconds\":168,\"zoomHist\":[0,0,2535,68090,182420,8015,0],\"passes\":null,\"linePasses\":{\"mean\":90.4,\"sd\":38.1,\"untouched\":0,\"p10\":43,\"median\":86,\"p90\":145,\"max\":214},\"tryingSettingsOf\":null,\"settingsFlags\":[],\"settingsUnsaved\":true,\"savedSettings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"feel\":{\"7M1\":{\"flow\":71}},\"look\":{\"thin\":45,\"tex\":100}},\"needles\":{\"7RL\":{\"seconds\":34.9,\"travelMm\":465,\"mmPerSec\":13.3,\"speedAvg\":13.3,\"speedSd\":5.5,\"depthAvg\":0.522,\"depthSd\":0.216,\"strokes\":5,\"turnPerMm\":0.079,\"sameWay30mm\":0.035,\"cw\":18,\"ccw\":18,\"reversalsPer10mm\":0,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":1.097,\"hist\":{\"speed\":[11770,22819,308,22,0,0,0,0,0],\"gap\":[1191,14945,17247,1481,55,0,0,0],\"depth\":[0,6179,641,1178,2545,8541,8240,7595,0,0],\"pressure\":[9791,5680,6271,7455,5722,0,0,0,0,0],\"tilt\":[0,2312,32507,100,0],\"radius\":[0,1,30,70,118,51],\"stroke\":[0,0,0,1,4,0,0,0]}},\"11M1\":{\"seconds\":226.1,\"travelMm\":30776,\"mmPerSec\":136.1,\"speedAvg\":127.6,\"speedSd\":79.5,\"depthAvg\":0.539,\"depthSd\":0.197,\"strokes\":344,\"turnPerMm\":0.165,\"sameWay30mm\":0.756,\"cw\":4141,\"ccw\":949,\"reversalsPer10mm\":0.297,\"dipReversalsPer10mm\":0.093,\"turnFlipsPer10mm\":0.345,\"hist\":{\"speed\":[3151,6571,17514,48456,33000,45316,38260,24302,9570],\"gap\":[512,1841,3615,8076,35204,58396,75050,43447],\"depth\":[25746,568,2970,8693,22277,31468,113178,21239,0,0],\"pressure\":[35171,13474,17089,14224,17587,32772,38985,45009,11828,0],\"tilt\":[0,0,226140,0,0],\"radius\":[1647,556,782,1518,2595,14620],\"run\":[618,126,449,880,118,40],\"stroke\":[1,48,239,46,0,1,2,7]}}},\"edges\":{\"speed\":[10,25,50,85,110,150,200,300],\"gap\":[0.05,0.1,0.2,0.4,0.8,1.3,2.2],\"depth\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"pressure\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"tilt\":[15,30,45,60],\"zoom\":[1,1.5,2,3,5,8],\"radius\":[1,2,4,8,16],\"run\":[2,5,10,20,40],\"stroke\":[2,5,10,20,50,100,200]},\"settings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"look\":{\"thin\":0.45,\"tex\":1},\"stretch\":75,\"skin\":\"#e2b493\",\"feel\":{\"7M1\":{\"flow\":71},\"7RL\":{\"size\":0.35},\"11M1\":{\"size\":0.3}}},\"device\":{\"ua\":\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\",\"screen\":[1317,823],\"dpr\":1.75}}" },
  { name: "Trevor", note: "Whip shading \u00b7 A 96", img: 'img/ref/trevor-2-4.jpg', stats: "{\"inkforge_stats\":1,\"artist\":\"Trevor Schuster\",\"build\":320,\"lesson\":\"2-4\",\"task\":\"l-whipgrey\",\"when\":\"2026-11-08T21:36:44.266Z\",\"grade\":\"A\",\"total\":96,\"parts\":{\"score\":95,\"gradient\":86,\"smoothness\":72,\"evenness\":100,\"whips\":100,\"washes\":100,\"edges\":98,\"inside\":98,\"voltage\":100,\"outline\":100,\"spill\":0,\"packing\":\"0\",\"bands\":\"0.18 0.18 0.22 0.29 0.34 0.38 0.47 0.54 0.61 0.86\"},\"skin\":100,\"traumaMax\":0.07,\"traumaAvg\":0.03,\"blowouts\":0,\"blowSpots\":[],\"maxStrokes\":null,\"extraStrokes\":0,\"undos\":0,\"lasers\":0,\"penalty\":0,\"dips\":5,\"needleSeconds\":120.4,\"pauses\":13,\"pauseSeconds\":84,\"zoomHist\":[0,0,0,9219,97372,13858,0],\"passes\":null,\"linePasses\":{\"mean\":129.2,\"sd\":82.1,\"untouched\":0,\"p10\":56,\"median\":96,\"p90\":291,\"max\":339},\"tryingSettingsOf\":null,\"settingsFlags\":[],\"settingsUnsaved\":true,\"savedSettings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"feel\":{\"7M1\":{\"flow\":71}},\"look\":{\"thin\":45,\"tex\":100}},\"needles\":{\"9RL\":{\"seconds\":24.2,\"travelMm\":361,\"mmPerSec\":14.9,\"speedAvg\":15,\"speedSd\":6.2,\"depthAvg\":0.605,\"depthSd\":0.17,\"strokes\":4,\"turnPerMm\":0.093,\"sameWay30mm\":0.015,\"cw\":17,\"ccw\":17,\"reversalsPer10mm\":0,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":1.19,\"hist\":{\"speed\":[2957,18214,3058,0,0,0,0,0,0],\"gap\":[530,5261,13838,4599,0,0,0,0],\"depth\":[0,1605,245,649,2160,4826,5352,9391,0,0],\"pressure\":[3332,4197,5135,3826,4349,3390,0,0,0,0],\"tilt\":[0,700,23529,0,0],\"radius\":[0,1,25,71,98,65],\"stroke\":[0,0,1,1,2,0,0,0]}},\"13CM\":{\"seconds\":96.2,\"travelMm\":28917,\"mmPerSec\":300.5,\"speedAvg\":253,\"speedSd\":188.2,\"depthAvg\":0.234,\"depthSd\":0.151,\"strokes\":518,\"turnPerMm\":0.014,\"sameWay30mm\":0.776,\"cw\":255,\"ccw\":154,\"reversalsPer10mm\":0.011,\"dipReversalsPer10mm\":0.002,\"turnFlipsPer10mm\":0.34,\"hist\":{\"speed\":[5487,6433,7066,6563,3747,5214,6326,12987,42398],\"gap\":[1514,3075,3890,6340,7657,6684,9946,57115],\"depth\":[44029,1626,8571,21977,18859,1159,0,0,0,0],\"pressure\":[59311,15491,11996,7079,2266,78,0,0,0,0],\"tilt\":[655,1883,85046,8636,0],\"radius\":[64,27,73,169,357,12715],\"run\":[21,0,0,0,1,75],\"stroke\":[6,51,150,311,0,0,0,0]}}},\"edges\":{\"speed\":[10,25,50,85,110,150,200,300],\"gap\":[0.05,0.1,0.2,0.4,0.8,1.3,2.2],\"depth\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"pressure\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"tilt\":[15,30,45,60],\"zoom\":[1,1.5,2,3,5,8],\"radius\":[1,2,4,8,16],\"run\":[2,5,10,20,40],\"stroke\":[2,5,10,20,50,100,200]},\"settings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"look\":{\"thin\":0.45,\"tex\":1},\"stretch\":75,\"skin\":\"#e2b493\",\"feel\":{\"7M1\":{\"flow\":71},\"9RL\":{\"volt\":7.5}}},\"device\":{\"ua\":\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\",\"screen\":[1317,823],\"dpr\":1.75}}" },
  { name: "Trevor", note: "Stipple shading \u00b7 A 96", img: 'img/ref/trevor-2-3.jpg', stats: "{\"inkforge_stats\":1,\"artist\":\"Trevor Schuster\",\"build\":318,\"lesson\":\"2-3\",\"task\":\"l-stipple\",\"when\":\"2026-11-08T20:38:52.426Z\",\"grade\":\"A\",\"total\":96,\"parts\":{\"score\":95,\"gradient\":94,\"smoothness\":100,\"evenness\":89,\"bands\":\"0.56 0.46 0.35 0.32 0.30 0.22 0.17 0.11 0.06 0.04\",\"dots\":100,\"inside\":93,\"whips\":100,\"voltage\":100,\"outline\":100,\"spill\":0,\"lineVolts\":\"7.2\"},\"skin\":100,\"traumaMax\":0,\"traumaAvg\":0,\"blowouts\":0,\"blowSpots\":[],\"maxStrokes\":8,\"extraStrokes\":0,\"undos\":0,\"lasers\":0,\"penalty\":0,\"dips\":1,\"needleSeconds\":86.6,\"pauses\":6,\"pauseSeconds\":34,\"zoomHist\":[0,0,0,13058,66531,6973,0],\"passes\":null,\"linePasses\":{\"mean\":37.7,\"sd\":15.6,\"untouched\":0,\"p10\":24,\"median\":33,\"p90\":56,\"max\":121},\"tryingSettingsOf\":null,\"settingsFlags\":[],\"settingsUnsaved\":true,\"savedSettings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"feel\":{\"7M1\":{\"flow\":71}},\"look\":{\"thin\":45,\"tex\":100}},\"needles\":{\"3RL\":{\"seconds\":86.6,\"travelMm\":17165,\"mmPerSec\":198.3,\"speedAvg\":166.7,\"speedSd\":158.1,\"depthAvg\":0.261,\"depthSd\":0.259,\"strokes\":493,\"turnPerMm\":0.016,\"sameWay30mm\":0.761,\"cw\":101,\"ccw\":173,\"reversalsPer10mm\":0.016,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":0.362,\"hist\":{\"speed\":[10026,20237,3547,3792,2730,4459,6298,14780,20693],\"gap\":[1047,7439,16195,4032,3525,2735,4518,47073],\"depth\":[38452,7666,15200,2635,264,519,13065,8762,0,0],\"pressure\":[52587,8782,3277,6124,10202,5591,0,0,0,0],\"tilt\":[0,222,74716,11625,0],\"radius\":[29,14,38,132,296,7910],\"run\":[5,0,0,3,11,30],\"stroke\":[17,86,265,123,2,0,0,0]}}},\"edges\":{\"speed\":[10,25,50,85,110,150,200,300],\"gap\":[0.05,0.1,0.2,0.4,0.8,1.3,2.2],\"depth\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"pressure\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"tilt\":[15,30,45,60],\"zoom\":[1,1.5,2,3,5,8],\"radius\":[1,2,4,8,16],\"run\":[2,5,10,20,40],\"stroke\":[2,5,10,20,50,100,200]},\"settings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"look\":{\"thin\":0.45,\"tex\":1},\"stretch\":75,\"skin\":\"#e2b493\",\"feel\":{\"7M1\":{\"flow\":71},\"3RL\":{\"size\":0.25,\"volt\":5.05}}},\"device\":{\"ua\":\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\",\"screen\":[1317,823],\"dpr\":1.75}}" },
  { name: "Trevor", note: "Orange circle \u00b7 A 91", img: 'img/ref/trevor-2-2.jpg', stats: "{\"inkforge_stats\":1,\"artist\":\"Trevor Schuster\",\"build\":311,\"lesson\":\"2-2\",\"task\":\"l-orange\",\"when\":\"2026-11-08T17:49:38.311Z\",\"grade\":\"A\",\"total\":91,\"parts\":{\"score\":90,\"technique\":100,\"outline\":90,\"colour\":100,\"healing\":100,\"saturation\":100,\"coverage\":100,\"consistency\":82,\"control\":99,\"spill\":0,\"yourColour\":\"#d1571c\"},\"skin\":94,\"traumaMax\":0.69,\"traumaAvg\":0.11,\"blowouts\":0,\"blowSpots\":[],\"maxStrokes\":4,\"extraStrokes\":0,\"undos\":0,\"lasers\":0,\"penalty\":0,\"dips\":7,\"needleSeconds\":266.8,\"pauses\":7,\"pauseSeconds\":62,\"zoomHist\":[0,0,0,0,238414,28429,0],\"passes\":{\"mean\":316.9,\"sd\":74.8,\"min\":154,\"p10\":228,\"median\":310,\"p90\":424,\"max\":551},\"linePasses\":null,\"tryingSettingsOf\":null,\"settingsFlags\":[],\"settingsUnsaved\":false,\"savedSettings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"feel\":{\"7M1\":{\"flow\":71}},\"look\":{\"thin\":45,\"tex\":100}},\"needles\":{\"7RL\":{\"seconds\":30.3,\"travelMm\":255,\"mmPerSec\":8.4,\"speedAvg\":8.4,\"speedSd\":2.6,\"depthAvg\":0.533,\"depthSd\":0.145,\"strokes\":3,\"turnPerMm\":0.168,\"sameWay30mm\":0.145,\"cw\":18,\"ccw\":24,\"reversalsPer10mm\":0,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":0.744,\"hist\":{\"speed\":[24067,6177,89,0,0,0,0,0,0],\"gap\":[1273,25142,3818,100,0,0,0,0],\"depth\":[0,2901,89,411,700,16990,9243,0,0,0],\"pressure\":[3922,9144,17267,0,0,0,0,0,0,0],\"tilt\":[0,0,30333,0,0],\"radius\":[0,8,46,82,58,22],\"stroke\":[0,0,1,2,0,0,0,0]}},\"7M1\":{\"seconds\":236.5,\"travelMm\":10663,\"mmPerSec\":45.1,\"speedAvg\":45.2,\"speedSd\":19.3,\"depthAvg\":0.668,\"depthSd\":0.052,\"strokes\":6,\"turnPerMm\":0.622,\"sameWay30mm\":0.992,\"cw\":6607,\"ccw\":27,\"reversalsPer10mm\":0.291,\"dipReversalsPer10mm\":0.001,\"turnFlipsPer10mm\":0.005,\"hist\":{\"speed\":[675,25360,132177,67409,10330,458,33,67,0],\"gap\":[58,247,5520,59340,136566,33583,1128,67],\"depth\":[925,11,56,255,794,11936,192495,30039,0,0],\"pressure\":[1269,539,3540,7630,8027,44605,135999,34902,0,0],\"tilt\":[0,278,236232,0,0],\"radius\":[2026,1445,2195,2781,1415,360],\"run\":[1953,1259,607,11,1,0],\"stroke\":[0,0,0,0,0,0,1,5]}}},\"edges\":{\"speed\":[10,25,50,85,110,150,200,300],\"gap\":[0.05,0.1,0.2,0.4,0.8,1.3,2.2],\"depth\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"pressure\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"tilt\":[15,30,45,60],\"zoom\":[1,1.5,2,3,5,8],\"radius\":[1,2,4,8,16],\"run\":[2,5,10,20,40],\"stroke\":[2,5,10,20,50,100,200]},\"settings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"look\":{\"thin\":0.45,\"tex\":1},\"stretch\":75,\"skin\":\"#e2b493\",\"feel\":{\"7M1\":{\"flow\":71}}},\"device\":{\"ua\":\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\",\"screen\":[1317,823],\"dpr\":1.75}}" },
  { name: "Trevor", note: "Solid black \u00b7 B 89", img: 'img/ref/trevor-2-1.jpg', stats: "{\"inkforge_stats\":1,\"artist\":\"Trevor Schuster\",\"build\":307,\"lesson\":\"2-1\",\"task\":\"l-pack\",\"when\":\"2026-11-08T14:20:55.591Z\",\"grade\":\"B\",\"total\":89,\"parts\":{\"score\":87,\"technique\":100,\"outline\":100,\"saturation\":100,\"coverage\":100,\"consistency\":84,\"control\":94,\"spill\":0},\"skin\":100,\"traumaMax\":0.25,\"traumaAvg\":0.09,\"blowouts\":0,\"blowSpots\":[],\"maxStrokes\":8,\"extraStrokes\":0,\"undos\":0,\"lasers\":0,\"penalty\":0,\"dips\":1,\"needleSeconds\":253.6,\"pauses\":4,\"pauseSeconds\":55,\"zoomHist\":[0,0,0,0,247002,6629,0],\"passes\":{\"mean\":310.7,\"sd\":36.9,\"min\":238,\"p10\":265,\"median\":308,\"p90\":361,\"max\":400},\"linePasses\":null,\"tryingSettingsOf\":null,\"settingsFlags\":[],\"settingsUnsaved\":false,\"savedSettings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"feel\":{},\"look\":{\"thin\":45,\"tex\":100}},\"needles\":{\"5RL\":{\"seconds\":14.8,\"travelMm\":262,\"mmPerSec\":17.6,\"speedAvg\":17.8,\"speedSd\":6.1,\"depthAvg\":0.635,\"depthSd\":0.127,\"strokes\":4,\"turnPerMm\":0.039,\"sameWay30mm\":0.07,\"cw\":5,\"ccw\":5,\"reversalsPer10mm\":0,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":0.726,\"hist\":{\"speed\":[1510,11479,1835,0,0,0,0,0,0],\"gap\":[349,1808,8580,4086,0,0,0,0],\"depth\":[0,658,45,78,219,2073,6479,5272,0,0],\"pressure\":[880,577,3675,2934,5505,1252,0,0,0,0],\"tilt\":[0,0,14824,0,0],\"radius\":[0,0,2,20,46,35],\"stroke\":[0,0,2,2,0,0,0,0]}},\"7RS\":{\"seconds\":238.8,\"travelMm\":6030,\"mmPerSec\":25.3,\"speedAvg\":25.4,\"speedSd\":8.4,\"depthAvg\":0.535,\"depthSd\":0.09,\"strokes\":8,\"turnPerMm\":1.073,\"sameWay30mm\":0.97,\"cw\":6374,\"ccw\":97,\"reversalsPer10mm\":1.469,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":0.003,\"hist\":{\"speed\":[1515,129449,104531,3292,19,0,0,0,0],\"gap\":[169,659,34457,174583,28842,97,0,0],\"depth\":[3472,155,1264,8710,49455,121487,54264,0,0,0],\"pressure\":[15832,42502,63005,67022,45045,5401,0,0,0,0],\"tilt\":[0,0,237256,1552,0],\"radius\":[1950,1025,1066,842,331,112],\"run\":[2570,1014,22,0,0,0],\"stroke\":[0,0,0,0,1,1,5,1]}}},\"edges\":{\"speed\":[10,25,50,85,110,150,200,300],\"gap\":[0.05,0.1,0.2,0.4,0.8,1.3,2.2],\"depth\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"pressure\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"tilt\":[15,30,45,60],\"zoom\":[1,1.5,2,3,5,8],\"radius\":[1,2,4,8,16],\"run\":[2,5,10,20,40],\"stroke\":[2,5,10,20,50,100,200]},\"settings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"look\":{\"thin\":0.45,\"tex\":1},\"stretch\":75,\"skin\":\"#e2b493\",\"feel\":{}},\"device\":{\"ua\":\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\",\"screen\":[1317,823],\"dpr\":1.75}}" },
  { name: "Trevor", note: "The flag \u00b7 A 92", img: 'img/ref/trevor-1-5.jpg', stats: "{\"inkforge_stats\":1,\"artist\":\"Trevor Schuster\",\"build\":303,\"lesson\":\"1-5\",\"task\":\"l-flag\",\"when\":\"2026-11-08T12:36:39.438Z\",\"grade\":\"A\",\"total\":92,\"parts\":{\"score\":90,\"coverage\":94,\"spill\":0,\"evenness\":98,\"corners\":88,\"weight\":85},\"skin\":100,\"traumaMax\":0.15,\"traumaAvg\":0.05,\"blowouts\":0,\"blowSpots\":[],\"maxStrokes\":12,\"extraStrokes\":0,\"undos\":0,\"lasers\":0,\"penalty\":0,\"dips\":1,\"needleSeconds\":136.8,\"pauses\":10,\"pauseSeconds\":84,\"zoomHist\":[0,0,14879,82019,20231,19652,0],\"passes\":null,\"linePasses\":{\"mean\":32.6,\"sd\":11.6,\"untouched\":0,\"p10\":23,\"median\":29,\"p90\":48,\"max\":105},\"tryingSettingsOf\":null,\"settingsFlags\":[],\"settingsUnsaved\":false,\"savedSettings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"feel\":{},\"look\":{\"thin\":45,\"tex\":100}},\"needles\":{\"5RL\":{\"seconds\":136.8,\"travelMm\":1213,\"mmPerSec\":8.9,\"speedAvg\":8.9,\"speedSd\":2.6,\"depthAvg\":0.704,\"depthSd\":0.121,\"strokes\":11,\"turnPerMm\":0.148,\"sameWay30mm\":0.084,\"cw\":86,\"ccw\":93,\"reversalsPer10mm\":0,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":0.758,\"hist\":{\"speed\":[95053,41562,166,0,0,0,0,0,0],\"gap\":[4921,98949,32689,222,0,0,0,0],\"depth\":[0,3473,267,804,2607,4000,31940,85798,7893,0],\"pressure\":[5264,2972,7746,18528,37827,30420,34024,0,0,0],\"tilt\":[0,6385,128970,1427,0],\"radius\":[1,26,187,362,289,130],\"run\":[0,0,1,0,0,2],\"stroke\":[0,0,0,2,9,0,0,0]}}},\"edges\":{\"speed\":[10,25,50,85,110,150,200,300],\"gap\":[0.05,0.1,0.2,0.4,0.8,1.3,2.2],\"depth\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"pressure\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"tilt\":[15,30,45,60],\"zoom\":[1,1.5,2,3,5,8],\"radius\":[1,2,4,8,16],\"run\":[2,5,10,20,40],\"stroke\":[2,5,10,20,50,100,200]},\"settings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"look\":{\"thin\":0.45,\"tex\":1},\"stretch\":75,\"skin\":\"#e2b493\",\"feel\":{}},\"device\":{\"ua\":\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\",\"screen\":[1317,823],\"dpr\":1.75}}" },
  { name: "Trevor", note: "Curves \u00b7 A 90", img: 'img/ref/trevor-1-4.jpg', stats: "{\"inkforge_stats\":1,\"artist\":\"Trevor Schuster\",\"build\":300,\"lesson\":\"1-4\",\"task\":\"l-curve\",\"when\":\"2026-11-08T12:01:05.458Z\",\"grade\":\"A\",\"total\":90,\"parts\":{\"score\":88,\"coverage\":92,\"spill\":0,\"evenness\":98,\"weight\":87},\"skin\":100,\"traumaMax\":0.11,\"traumaAvg\":0.04,\"blowouts\":0,\"blowSpots\":[],\"maxStrokes\":8,\"extraStrokes\":0,\"undos\":0,\"lasers\":0,\"penalty\":0,\"dips\":1,\"needleSeconds\":80.6,\"pauses\":6,\"pauseSeconds\":40,\"zoomHist\":[0,0,0,48581,31980,0,0],\"passes\":null,\"linePasses\":{\"mean\":30.3,\"sd\":6.6,\"untouched\":0,\"p10\":23,\"median\":29,\"p90\":40,\"max\":58},\"tryingSettingsOf\":null,\"settingsFlags\":[],\"settingsUnsaved\":false,\"savedSettings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"feel\":{},\"look\":{\"thin\":45,\"tex\":100}},\"needles\":{\"5RL\":{\"seconds\":80.6,\"travelMm\":819,\"mmPerSec\":10.2,\"speedAvg\":10.2,\"speedSd\":3.3,\"depthAvg\":0.652,\"depthSd\":0.118,\"strokes\":7,\"turnPerMm\":0.146,\"sameWay30mm\":0.094,\"cw\":55,\"ccw\":65,\"reversalsPer10mm\":0,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":0.83,\"hist\":{\"speed\":[37211,43042,219,67,22,0,0,0,0],\"gap\":[678,46049,33448,264,100,22,0,0],\"depth\":[0,2855,133,386,1074,3542,44560,28010,0,0],\"pressure\":[3996,2487,5690,32404,28298,7684,0,0,0,0],\"tilt\":[0,6165,73721,675,0],\"radius\":[0,15,121,260,171,92],\"stroke\":[0,0,0,0,7,0,0,0]}}},\"edges\":{\"speed\":[10,25,50,85,110,150,200,300],\"gap\":[0.05,0.1,0.2,0.4,0.8,1.3,2.2],\"depth\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"pressure\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"tilt\":[15,30,45,60],\"zoom\":[1,1.5,2,3,5,8],\"radius\":[1,2,4,8,16],\"run\":[2,5,10,20,40],\"stroke\":[2,5,10,20,50,100,200]},\"settings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"look\":{\"thin\":0.45,\"tex\":1},\"stretch\":75,\"skin\":\"#e2b493\",\"feel\":{}},\"device\":{\"ua\":\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\",\"screen\":[1317,823],\"dpr\":1.75}}" },
  { name: "Trevor", note: "Sharp corners \u00b7 A 91", img: 'img/ref/trevor-1-3.jpg', stats: "{\"inkforge_stats\":1,\"artist\":\"Trevor Schuster\",\"build\":298,\"lesson\":\"1-3\",\"task\":\"l-rect\",\"when\":\"2026-11-08T11:16:53.535Z\",\"grade\":\"A\",\"total\":91,\"parts\":{\"score\":89,\"coverage\":92,\"spill\":0,\"evenness\":92,\"corners\":93},\"skin\":100,\"traumaMax\":0.07,\"traumaAvg\":0.04,\"blowouts\":0,\"blowSpots\":[],\"maxStrokes\":8,\"extraStrokes\":0,\"undos\":0,\"lasers\":0,\"penalty\":0,\"dips\":1,\"needleSeconds\":87.8,\"pauses\":6,\"pauseSeconds\":66,\"zoomHist\":[0,0,12126,65306,10371,0,0],\"passes\":null,\"linePasses\":{\"mean\":29.7,\"sd\":6.7,\"untouched\":0,\"p10\":22,\"median\":29,\"p90\":36,\"max\":81},\"tryingSettingsOf\":null,\"settingsFlags\":[],\"settingsUnsaved\":false,\"savedSettings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"feel\":{},\"look\":{\"thin\":45,\"tex\":100}},\"needles\":{\"5RL\":{\"seconds\":87.8,\"travelMm\":757,\"mmPerSec\":8.6,\"speedAvg\":8.7,\"speedSd\":4,\"depthAvg\":0.767,\"depthSd\":0.102,\"strokes\":8,\"turnPerMm\":0.109,\"sameWay30mm\":0.07,\"cw\":41,\"ccw\":41,\"reversalsPer10mm\":0.026,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":0.885,\"hist\":{\"speed\":[70641,16761,322,22,22,33,0,0,0],\"gap\":[3674,71704,11617,719,33,56,0,0],\"depth\":[0,1642,89,133,532,1302,3448,48027,32629,0],\"pressure\":[2219,996,1330,2355,9037,28927,35417,7522,0,0],\"tilt\":[0,4666,83136,0,0],\"radius\":[2,6,92,133,142,62],\"run\":[0,0,0,0,0,2],\"stroke\":[0,0,0,2,6,0,0,0]}}},\"edges\":{\"speed\":[10,25,50,85,110,150,200,300],\"gap\":[0.05,0.1,0.2,0.4,0.8,1.3,2.2],\"depth\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"pressure\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"tilt\":[15,30,45,60],\"zoom\":[1,1.5,2,3,5,8],\"radius\":[1,2,4,8,16],\"run\":[2,5,10,20,40],\"stroke\":[2,5,10,20,50,100,200]},\"settings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"look\":{\"thin\":0.45,\"tex\":1},\"stretch\":75,\"skin\":\"#e2b493\",\"feel\":{}},\"device\":{\"ua\":\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\",\"screen\":[1317,823],\"dpr\":1.75}}" },
  { name: "Trevor", note: "Your first line \u00b7 A 92", img: 'img/ref/trevor-1-2.jpg', stats: "{\"inkforge_stats\":1,\"artist\":\"Trevor Schuster\",\"build\":296,\"lesson\":\"1-2\",\"task\":\"l-first\",\"when\":\"2026-11-08T10:20:58.317Z\",\"grade\":\"A\",\"total\":92,\"parts\":{\"score\":91,\"coverage\":91,\"spill\":0,\"evenness\":97},\"skin\":100,\"traumaMax\":0.05,\"traumaAvg\":0.03,\"blowouts\":0,\"blowSpots\":[],\"maxStrokes\":2,\"extraStrokes\":0,\"undos\":0,\"lasers\":0,\"penalty\":0,\"dips\":1,\"needleSeconds\":21.5,\"pauses\":1,\"pauseSeconds\":3,\"zoomHist\":[0,0,15565,5952,0,0,0],\"passes\":null,\"linePasses\":{\"mean\":22.9,\"sd\":4.8,\"untouched\":0,\"p10\":18,\"median\":22,\"p90\":27,\"max\":42},\"tryingSettingsOf\":null,\"settingsFlags\":[],\"settingsUnsaved\":false,\"savedSettings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"feel\":{},\"look\":{\"thin\":45,\"tex\":100}},\"needles\":{\"5RL\":{\"seconds\":21.5,\"travelMm\":149,\"mmPerSec\":6.9,\"speedAvg\":6.9,\"speedSd\":2.3,\"depthAvg\":0.688,\"depthSd\":0.137,\"strokes\":2,\"turnPerMm\":0.038,\"sameWay30mm\":0,\"cw\":3,\"ccw\":3,\"reversalsPer10mm\":0,\"dipReversalsPer10mm\":0,\"turnFlipsPer10mm\":0.336,\"hist\":{\"speed\":[18742,2764,11,0,0,0,0,0,0],\"gap\":[4811,14646,2036,25,0,0,0,0],\"depth\":[0,872,56,134,155,389,6244,13668,0,0],\"pressure\":[1194,111,1119,3909,6557,8628,0,0,0,0],\"tilt\":[0,0,21517,0,0],\"radius\":[0,0,3,11,24,10],\"stroke\":[0,0,0,0,2,0,0,0]}}},\"edges\":{\"speed\":[10,25,50,85,110,150,200,300],\"gap\":[0.05,0.1,0.2,0.4,0.8,1.3,2.2],\"depth\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"pressure\":[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9],\"tilt\":[15,30,45,60],\"zoom\":[1,1.5,2,3,5,8],\"radius\":[1,2,4,8,16],\"run\":[2,5,10,20,40],\"stroke\":[2,5,10,20,50,100,200]},\"settings\":{\"cal\":{\"penOnly\":true,\"pMin\":0.2,\"pMax\":0.866,\"curve\":-75,\"hand\":4.1,\"fade\":0.35,\"flow\":2,\"tilt0\":35,\"profile\":\"slow\",\"voltOff\":0,\"blow\":1.2,\"tough\":1.25,\"t3\":1,\"t4\":1,\"b3\":1,\"t5\":1},\"look\":{\"thin\":0.45,\"tex\":1},\"stretch\":75,\"skin\":\"#e2b493\",\"feel\":{}},\"device\":{\"ua\":\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\",\"screen\":[1317,823],\"dpr\":1.75}}" },
];
const ttStatsParse = (txt) => { try { const s = JSON.parse(String(txt).trim()); return s?.inkforge_stats ? s : null; } catch { const m = String(txt).match(/\{"inkforge_stats"[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } } };
// Our PDFs: stats are plain text lines on the later pages, the report page is a JPEG.
const ttPdfRead = (buf) => { const u = new Uint8Array(buf), s = new TextDecoder('latin1').decode(u); let img = null; const di = s.indexOf('/DCTDecode'); if (di > 0) { const a = s.indexOf('stream\n', di) + 7, b = s.indexOf('\nendstream', a); if (a > 6 && b > a) img = URL.createObjectURL(new Blob([u.slice(a, b)], { type: 'image/jpeg' })); }
  const parts = [], txt = s.slice(Math.max(0, s.indexOf('BT /F'))); for (const m of txt.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)) parts.push(m[1].replace(/\\(.)/g, '$1')); const st = ttStatsParse(parts.filter(p => p !== 'Stats for comparing attempts').join('')); return { stats: st, img }; };
const ttCmpRows = (A, B) => { const r1 = (v) => v == null ? null : Math.round(v * 10) / 10, pct = (v) => v == null ? '–' : Math.round(v * 100) + '%', num = (v) => v == null ? '–' : String(r1(v)), rows = [], add = (sec, label, a, b, better, f = num) => { if (a == null && b == null) return; rows.push({ sec, label, a, b, better, f }); };
  add('Result', 'Score', A.total, B.total, 1); for (const k of new Set([...Object.keys(A.parts || {}), ...Object.keys(B.parts || {})])) if (k !== 'score') add('Result', k[0].toUpperCase() + k.slice(1), A.parts?.[k], B.parts?.[k], 1); add('Result', 'Skin', A.skin, B.skin, 1); add('Result', 'Blowouts', A.blowouts, B.blowouts, -1); add('Result', 'Undos', A.undos, B.undos, -1);
  add('Time', 'Needle time (s)', A.needleSeconds, B.needleSeconds, 0); add('Time', 'Breaks', A.pauses, B.pauses, 0); if (A.linePasses || B.linePasses) { add('Packing', 'Hits along the line', A.linePasses?.mean, B.linePasses?.mean, 0); add('Packing', 'Most gone over', A.linePasses?.p90, B.linePasses?.p90, 0); add('Packing', 'Line not touched', A.linePasses && A.linePasses.untouched / 100, B.linePasses && B.linePasses.untouched / 100, -1, pct); }
  if (A.passes || B.passes) { add('Packing', 'Passes per spot', A.passes?.mean, B.passes?.mean, 1); add('Packing', 'Weakest 10% of spots', A.passes?.p10, B.passes?.p10, 1); add('Packing', 'Unevenness', A.passes && A.passes.sd / A.passes.mean, B.passes && B.passes.sd / B.passes.mean, -1, pct); }
  for (const id of new Set([...Object.keys(A.needles || {}), ...Object.keys(B.needles || {})])) { const a = A.needles?.[id] || {}, b = B.needles?.[id] || {}, sec = id;
    add(sec, 'Time in the skin (s)', a.seconds, b.seconds, 0); add(sec, 'Distance moved (mm)', a.travelMm, b.travelMm, 0); add(sec, 'Speed (mm/s)', a.speedAvg, b.speedAvg, 0); add(sec, 'Speed changes', a.speedAvg && a.speedSd / a.speedAvg, b.speedAvg && b.speedSd / b.speedAvg, -1, pct);
    add(sec, 'Depth', a.depthAvg, b.depthAvg, 0, (v) => v == null ? '–' : v.toFixed(2)); add(sec, 'Depth changes', a.depthAvg && a.depthSd / a.depthAvg, b.depthAvg && b.depthSd / b.depthAvg, -1, pct); add(sec, 'Strokes', a.strokes, b.strokes, 0);
    if (a.sameWay30mm != null || b.sameWay30mm != null) { add(sec, 'Keeps turning one way', a.sameWay30mm, b.sameWay30mm, id.includes('RL') ? 0 : 1, pct); add(sec, 'Direction flips per cm', a.turnFlipsPer10mm, b.turnFlipsPer10mm, id.includes('RL') ? 0 : -1, (v) => v == null ? '–' : v.toFixed(2)); add(sec, 'Sharp reversals per cm', a.reversalsPer10mm, b.reversalsPer10mm, -1, (v) => v == null ? '–' : v.toFixed(2)); } }
  add('Setup', 'Settings past their limit', A.settingsFlags?.length, B.settingsFlags?.length, -1); add('Setup', 'Build', A.build, B.build, 0); return rows; };
// What the first attempt could learn from the second: stats where the second is clearly better.
const ttCmpAdvice = (rows, na, nb) => { const out = []; for (const r of rows) { if (!r.better || r.a == null || r.b == null || r.sec === 'Setup') continue; const d = (r.b - r.a) * r.better, big = Math.abs(r.b - r.a) / Math.max(1e-6, Math.abs(r.a), Math.abs(r.b)); if (d > 0 && big > 0.12) out.push({ w: big, s: `${r.sec === 'Result' || r.sec === 'Time' || r.sec === 'Packing' ? '' : r.sec + ' '}${r.label.toLowerCase()}: ${nb} ${r.f(r.b)}, ${na} ${r.f(r.a)}.` }); } return out.sort((x, y) => y.w - x.w).slice(0, 6).map(x => x.s); };
const ttSpeedChart = (A, B, id) => { const a = A.needles?.[id]?.hist?.speed, b = B.needles?.[id]?.hist?.speed; if (!a || !b) return ''; const E = A.edges?.speed || [10, 25, 50, 85, 110, 150, 200, 300], na = a.reduce((x, y) => x + y, 0) || 1, nb = b.reduce((x, y) => x + y, 0) || 1, mx = Math.max(...a.map(v => v / na), ...b.map(v => v / nb)) || 1, lab = ['<' + E[0], ...E.slice(1).map((e, i) => E[i] + '–' + e), E[E.length - 1] + '+'];
  return `<div class="tt-cmpchart"><div class="lbl">${id}: time spent at each speed (mm/s)</div><div class="tt-cmpbars">${a.map((v, i) => `<div><span><i class="ca" style="height:${(v / na / mx * 100).toFixed(0)}%"></i><i class="cb" style="height:${(b[i] / nb / mx * 100).toFixed(0)}%"></i></span><em>${lab[i]}</em></div>`).join('')}</div></div>`; };
// Your collection: stats you've loaded and kept, to compare against again. { id, name, note, stats, img (media ref) }
const ttLib = () => { try { return JSON.parse(Settings.get('tt_cmp_lib', '[]')); } catch { return []; } };
// Settings that differ between two attempts: calibration, needle look, skin and each needle's own changes.
const TT_SET_NAMES = { hand: 'Hand speed', fade: 'Fast strokes lighten', flow: 'Ink flow', tough: 'Skin toughness', blow: 'Blowout sensitivity', curve: 'Pressure curve', pMin: 'Lightest pen reading', pMax: 'Hardest pen reading', tilt0: 'Natural angle', voltOff: 'Voltage offset', handBase: 'Measured hand speed', tuneSpeed: 'Tune in speed (mm/s)', volt: 'voltage', speedFade: 'fast strokes lighten', bleed: 'bleed', miss: 'missed punctures', hang: 'needle hang', dMin: 'lightest', dMax: 'deepest', pCurve: 'pressure curve', size: 'size', tiltSpread: 'tilt spreads', tiltFade: 'tilt lightens' };
const ttCmpSettings = (A, B) => { const out = [], same = (x, y) => x === y || (typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) < 1e-3), fmt = (v) => v == null ? '–' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v), sa = A.settings || {}, sb = B.settings || {};
  for (const k of Object.keys(TT_SET_NAMES)) { if (!(k in (sa.cal || {})) && !(k in (sb.cal || {}))) continue; const x = sa.cal?.[k], y = sb.cal?.[k]; if (!same(x, y)) out.push({ label: TT_SET_NAMES[k], a: fmt(x), b: fmt(y) }); }
  for (const [k, n] of [['thin', 'Needle thickness'], ['tex', 'Magnum texture']]) { const x = sa.look?.[k], y = sb.look?.[k]; if (!same(x, y)) out.push({ label: n, a: x == null ? '–' : Math.round(x * 100) + '%', b: y == null ? '–' : Math.round(y * 100) + '%' }); }
  if (!same(sa.stretch, sb.stretch)) out.push({ label: 'Skin stretch', a: fmt(sa.stretch), b: fmt(sb.stretch) }); if (sa.skin !== sb.skin) out.push({ label: 'Skin tone', a: fmt(sa.skin), b: fmt(sb.skin) });
  for (const id of new Set([...Object.keys(sa.feel || {}), ...Object.keys(sb.feel || {})])) { if (!TT_NEEDLES.find(n => n.id === id)) continue; const base = TT.feelBase(id); for (const k of new Set([...Object.keys(sa.feel?.[id] || {}), ...Object.keys(sb.feel?.[id] || {})])) { const x = sa.feel?.[id]?.[k] ?? base[k], y = sb.feel?.[id]?.[k] ?? base[k]; if (!same(x, y)) out.push({ label: `${id} ${TT_SET_NAMES[k] || k}`, a: fmt(x), b: fmt(y) }); } }
  return out; };
// A PDF of whole-page pictures (JPEG), one per page.
const ttImgPdf = (pages) => { const enc = new TextEncoder(), parts = [enc.encode('%PDF-1.4\n')], off = []; let pos = parts[0].length; const add = (b) => { parts.push(b); pos += b.length; }, n = pages.length, obj = (i, s) => { off[i] = pos; add(enc.encode(`${i} 0 obj\n${s}\nendobj\n`)); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>'); obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => (3 + i * 3) + ' 0 R').join(' ')}] >>`);
  pages.forEach((p, i) => { const k = 3 + i * 3, draw = 'q 595 0 0 842 0 0 cm /I Do Q'; obj(k, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /I ${k + 2} 0 R >> >> /Contents ${k + 1} 0 R >>`); obj(k + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    off[k + 2] = pos; add(enc.encode(`${k + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`)); add(p.jpeg); add(enc.encode('\nendstream\nendobj\n')); });
  const xref = pos, size = 3 + n * 3; add(enc.encode(`xref\n0 ${size}\n0000000000 65535 f \n${off.slice(1).map(v => String(v).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)); return new Blob(parts, { type: 'application/pdf' }); };
/* Trying someone else's settings: their tattooing settings replace yours for now, while anything about your own pen and
   tablet (pressure, pen readings, natural angle, tilt) stays yours. Your own are kept aside until you choose. */
const TT_PEN_CAL = ['pMin', 'pMax', 'curve', 'tilt0', 'penOnly'], TT_PEN_FEEL = ['pCurve', 'dMin', 'dMax', 'tiltSpread', 'tiltFade'];
const ttTrying = () => { try { return JSON.parse(Settings.get('tt_trying', 'null')); } catch { return null; } };
const ttTrySettings = async (stats, name) => { const S = stats.settings; if (!S?.cal) return toast('Those stats have no settings in them.'); const mine = TT.settingsNow(), back = ttTrying()?.backup || mine, cal = { ...mine.cal }, feel = {};
  for (const [k, v] of Object.entries(S.cal)) if (!TT_PEN_CAL.includes(k)) cal[k] = v; for (const k of Object.keys(cal)) if (!TT_PEN_CAL.includes(k) && !(k in S.cal) && k in TT.calDefaults) cal[k] = TT.calDefaults[k];
  for (const id of new Set([...Object.keys(mine.feel || {}), ...Object.keys(S.feel || {})])) { const o = {}; for (const [k, v] of Object.entries(mine.feel?.[id] || {})) if (TT_PEN_FEEL.includes(k)) o[k] = v; for (const [k, v] of Object.entries(S.feel?.[id] || {})) if (!TT_PEN_FEEL.includes(k)) o[k] = v; if (Object.keys(o).length) feel[id] = o; }
  await Settings.set('tt_cal', JSON.stringify(cal)); await Settings.set('tt_feel', JSON.stringify(feel)); if (S.look) { await Settings.set('tt_thin', String(Math.round(S.look.thin * 100))); await Settings.set('tt_tex', String(Math.round(S.look.tex * 100))); }
  await Settings.set('tt_trying', JSON.stringify({ name, backup: back })); };
const ttTryEnd = async (keep) => { const T0 = ttTrying(); if (!T0) return; if (keep) await TT.saveSettings(); else { await TT.applySettings(T0.backup); } await Settings.set('tt_trying', ''); toast(keep ? 'Their settings are now yours.' : 'Back to your own settings.'); };
const ttTryBar = () => { const T0 = ttTrying(); return T0 ? `<div class="tt-trybar"><span>Trying <b>${esc(T0.name)}</b>'s settings</span><button class="btn small" data-tryback>Back to mine</button><button class="btn small primary" data-trykeep>Keep theirs</button></div>` : ''; };
document.addEventListener('click', async (e) => { const k = e.target.closest?.('[data-trykeep], [data-tryback]'); if (!k) return; if (!k.dataset.trykeep && k.dataset.tryback === undefined) return; const keep = 'trykeep' in k.dataset; if (keep && !await ask('Keep their settings as yours from now on? Your old ones are replaced.')) return; await ttTryEnd(keep); document.querySelectorAll('.tt-trybar').forEach(b => b.remove()); });
TT.compare = (lid) => { const L = ttLessonList(), LS = L.find(x => x.id === lid); if (!LS) return; const slot = [{ name: 'You', s: null, img: null }, { name: '', s: null, img: null }], o = document.createElement('div'); o.id = 'merge-dlg'; o.className = 'tt-tune'; o.style.zIndex = 98; let tab = 'sum';
  // Only attempts at this lesson: your best and last here, your collection and the pre-loaded ones for it.
  const mine = (k) => { const P = ttLessonProg(), R = k === 'best' ? P.results?.[lid] : P.last?.lesson === lid ? P.last : null; return R?.stats ? { s: ttStatsParse(R.stats), ref: R.ref } : null; };
  const refs = () => TT_REF_STATS.map((r, j) => ({ r, j, s: ttStatsParse(r.stats) })).filter(x => x.s?.lesson === lid), libs = () => ttLib().map(r => ({ r, s: ttStatsParse(r.stats) })).filter(x => x.s?.lesson === lid);
  const fits = (s) => { if (s.lesson === lid) return true; const l = L.find(x => x.id === s.lesson); toast(`Those stats are from ${l ? `"${l.title}"` : 'a different lesson'}. Load an attempt at "${LS.title}" to compare it fairly.`, 4500); return false; };
  const opt = (v, img, name, note, s) => `<button class="tt-cmpopt" data-co="${v}">${img ? `<img src="${img}" alt="">` : `<span class="tt-cmpnoimg">${s ? s.grade : '?'}</span>`}<span><b>${esc(name)}</b><span class="muted">${s ? `${s.grade} · ${s.total} / 100` : ''}${note ? ' · ' + esc(note) : ''}</span></span></button>`;
  const pick = (i) => { const B = mine('best'), La = mine('last'), R = refs(), C = libs();
    const own = [B && opt('best', null, 'My best', 'saved result', B.s), La && !(B && La.s.when === B.s.when) && opt('last', null, 'My last attempt', La.s.when ? new Date(La.s.when).toLocaleDateString() : '', La.s)].filter(Boolean);
    return `${own.length ? `<div class="lbl">Yours</div><div class="tt-cmpopts">${own.join('')}</div>` : ''}${R.length ? `<div class="lbl">Pre-loaded</div><div class="tt-cmpopts">${R.map(x => opt('r:' + x.j, x.r.img, x.r.name, x.r.note, x.s)).join('')}</div>` : ''}${C.length ? `<div class="lbl">Your collection</div><div class="tt-cmpopts">${C.map(x => opt('c:' + x.r.id, null, x.r.name, x.r.note, x.s)).join('')}</div>` : ''}
      <div class="lbl">From someone else</div><div class="tt-cmpsrc"><button class="btn small" data-cs="paste:${i}" data-tip="Paste stats copied with Copy stats on a report card">Paste stats</button><button class="btn small" data-cs="file:${i}" data-tip="A PDF saved from a lesson report, or a stats file">Open file</button></div>`; };
  const slotHtml = (i) => { const S = slot[i], s = S.s;
    return `<div class="tt-cmpslot ${i ? 'b' : 'a'}"><div class="tt-cmpwho"><i class="${i ? 'cb' : 'ca'}"></i><input class="in" data-cn="${i}" value="${esc(S.name)}" placeholder="${i ? 'Name, e.g. Trevor or a mentor' : 'Name'}" aria-label="Name for this attempt">${s ? `<button class="mini" data-cx="${i}" aria-label="Choose another" data-tip="Choose another attempt">✕</button>` : ''}</div>
      ${s ? `${S.img ? `<img class="tt-cmpimg" src="${S.img}" alt="" data-cz="${i}" data-tip="Tap to view full screen">` : '<div class="tt-cmpimg tt-cmpnone">No picture with these stats</div>'}<div class="tt-cmpgrade"><b>${s.grade}</b><span>${s.total} / 100</span><span class="muted">${s.when ? new Date(s.when).toLocaleDateString() : ''} · build ${s.build}</span></div>
        <div class="tt-cmpsrc">${S.libId ? `<button class="btn small" data-cdel="${i}">Remove from collection</button>` : S.ref || S.pre ? '' : `<button class="btn small" data-csave="${i}">Save to collection</button>`}${!S.ref && s.settings?.cal ? `<button class="btn small" data-ctry="${i}" data-tip="Do this lesson again with their tattooing settings. Your pen and tablet settings stay yours.">Try their settings</button>` : ''}</div>`
      : `<p class="muted" style="margin:0;font-size:12px">Choose an attempt at ${esc(LS.title)}:</p>${pick(i)}`}</div>`; };
  const view = () => { const [A, B] = slot.map(x => x.s); if (!A || !B) return null; const na = slot[0].name || 'First', nb = slot[1].name || 'Second', rows = ttCmpRows(A, B), needles = [...new Set([...Object.keys(A.needles || {}), ...Object.keys(B.needles || {})])];
    return { A, B, na, nb, rows, needles, adv: ttCmpAdvice(rows, na, nb), adv2: ttCmpAdvice(rows.map(r => ({ ...r, a: r.b, b: r.a })), nb, na), sets: ttCmpSettings(A, B), tabs: [['sum', 'Summary'], ['time', 'Time & packing'], ...needles.map(id => ['n:' + id, id]), ['set', 'Settings']] }; };
  const table = (rows, na, nb) => { let sec = ''; return `<table class="tt-cmptab"><thead><tr><th></th><th>${esc(na)}</th><th>${esc(nb)}</th><th></th></tr></thead><tbody>${rows.map(r => { const h = r.sec !== sec && r.sec ? `<tr class="sec"><td colspan="4">${esc(r.sec)}</td></tr>` : ''; sec = r.sec; const win = !r.better || r.a == null || r.b == null || r.a === r.b ? '' : (r.b - r.a) * r.better > 0 ? 'b' : 'a';
    return h + `<tr><td>${esc(r.label)}</td><td class="${win === 'a' ? 'win' : ''}">${r.f ? r.f(r.a) : esc(r.a)}</td><td class="${win === 'b' ? 'win' : ''}">${r.f ? r.f(r.b) : esc(r.b)}</td><td class="muted">${r.better ? (r.better > 0 ? 'higher is better' : 'lower is better') : ''}</td></tr>`; }).join('')}</tbody></table>`; };
  const draw = () => { const V = view(); let body = '<p class="muted" style="margin:10px 0 0">Choose an attempt on each side and the comparison appears here.</p>';
    if (V) { const { A, B, na, nb, rows } = V; if (!V.tabs.find(x => x[0] === tab)) tab = 'sum'; let page = '';
      if (tab === 'sum') page = `<div class="tt-cmpadv"><div><div class="lbl">Where ${esc(na)} can learn from ${esc(nb)}</div>${V.adv.length ? `<ul>${V.adv.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">Nothing stands out: level or ahead on everything graded.</p>'}</div><div><div class="lbl">Where ${esc(na)} is ahead</div>${V.adv2.length ? `<ul>${V.adv2.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">Nothing stands out.</p>'}</div></div>${table(rows.filter(r => r.sec === 'Result'), na, nb)}`;
      if (tab === 'time') page = table(rows.filter(r => r.sec === 'Time' || r.sec === 'Packing'), na, nb);
      if (tab.startsWith('n:')) { const id = tab.slice(2); page = table(rows.filter(r => r.sec === id).map(r => ({ ...r, sec: '' })), na, nb) + ttSpeedChart(A, B, id) + `<div class="tt-cmpkey"><i class="ca"></i>${esc(na)}<i class="cb"></i>${esc(nb)}</div>`; }
      if (tab === 'set') page = (V.sets.length ? `<p class="muted" style="margin:0 0 6px">Only settings that differ are shown.</p>${table(V.sets, na, nb)}` : '<p class="muted">Both used the same settings.</p>') + table(rows.filter(r => r.sec === 'Setup'), na, nb) + [[A, na], [B, nb]].filter(([s]) => s.settingsFlags?.length).map(([s, n]) => `<p class="tt-cmpwarn">${esc(n)}: ${esc(s.settingsFlags.map(f => `${f.name} ${f.value} (default ${f.default})`).join(', '))}</p>`).join('');
      body = `<div class="tt-ftabs" style="margin-top:12px">${V.tabs.map(([k, n]) => `<button data-ct="${k}" class="${tab === k ? 'on' : ''}">${esc(n)}</button>`).join('')}</div><div class="tt-cmppage">${page}</div>`; }
    o.innerHTML = `<div class="card tt-tcard tt-cmp"><div class="row" style="align-items:center;gap:6px"><h2 style="margin:0;flex:1">Compare <span class="muted" style="font-size:.7em">· ${esc(LS.id)} ${esc(LS.title)}</span></h2>${V ? '<button class="btn small" data-cpdf>Save PDF</button>' : ''}<button class="btn small" data-cc>Close</button></div>
      <p class="muted" style="margin:4px 0 10px">Put two attempts at this lesson side by side: your best against Trevor's, an older try of yours, an apprentice or a mentor. Teal is the left side, gold the right; the better number in each row is highlighted.</p>
      <div class="tt-cmpslots">${slotHtml(0)}${slotHtml(1)}</div>${body}</div>`; };
  // The comparison on A4 pages, one section after another, with each side's report page after it when there is one.
  const pdf = async () => { const V = view(), P = 1240, Q = 1754, m = 70, pages = [], ink = '#171a1b', soft = '#5f6a6b', teal = '#17a697'; let c, g, y;
    const page = () => { c = document.createElement('canvas'); c.width = P; c.height = Q; g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, P, Q); y = m; pages.push(c); }, need = (h) => { if (y + h > Q - m) page(); };
    const text = (s, x, size, col = ink, wt = 400, maxW = P - 2 * m) => { g.font = `${wt} ${size}px Inter, sans-serif`; g.fillStyle = col; const words = String(s).split(' '); let ln = ''; for (const w of words) { const nx = ln ? ln + ' ' + w : w; if (g.measureText(nx).width > maxW && ln) { need(size * 1.4); g.fillText(ln, x, y + size); y += size * 1.4; ln = w; } else ln = nx; } need(size * 1.4); g.fillText(ln, x, y + size); y += size * 1.4; };
    const head = (s) => { y += 20; need(60); text(s, m, 30, teal, 700); y += 4; }, trows = (rows) => { const cx = [m, P - m - 520, P - m - 300, P - m]; g.font = '600 20px Inter, sans-serif'; need(34); g.fillStyle = soft; g.textAlign = 'right'; g.fillText(V.na, cx[1] + 140, y + 22); g.fillText(V.nb, cx[2] + 140, y + 22); g.textAlign = 'left'; y += 34;
      let sec = ''; for (const r of rows) { if (r.sec && r.sec !== sec) { sec = r.sec; need(40); g.font = '700 21px Inter, sans-serif'; g.fillStyle = teal; g.fillText(r.sec, m, y + 26); y += 36; } need(32); const win = !r.better || r.a == null || r.b == null || r.a === r.b ? '' : (r.b - r.a) * r.better > 0 ? 'b' : 'a'; g.font = '400 20px Inter, sans-serif'; g.fillStyle = ink; g.fillText(r.label, m, y + 22); g.textAlign = 'right';
        for (const [k, v, x] of [['a', r.a, cx[1] + 140], ['b', r.b, cx[2] + 140]]) { g.font = `${win === k ? 700 : 400} 20px Inter, sans-serif`; g.fillStyle = win === k ? teal : ink; g.fillText(r.f ? r.f(v) : String(v), x, y + 22); } g.font = '400 15px Inter, sans-serif'; g.fillStyle = soft; g.fillText(r.better ? (r.better > 0 ? 'higher is better' : 'lower is better') : '', cx[3], y + 22); g.textAlign = 'left'; g.fillStyle = '#e5e8e8'; g.fillRect(m, y + 30, P - 2 * m, 1); y += 32; } };
    page(); text('Compare stats', m, 46, ink, 700); text(`${V.na}: ${V.A.grade} ${V.A.total} / 100   ·   ${V.nb}: ${V.B.grade} ${V.B.total} / 100`, m, 24, soft, 500); const lsn = L.find(x => x.id === V.A.lesson); text(`${lsn ? 'Lesson ' + lsn.id + ': ' + lsn.title : ''}   ·   ${new Date().toLocaleDateString()}`, m, 20, soft);
    head('Summary'); text(`Where ${V.na} can learn from ${V.nb}`, m, 22, ink, 700); for (const s of V.adv.length ? V.adv : ['Nothing stands out.']) text('• ' + s, m + 10, 20); y += 8; text(`Where ${V.na} is ahead`, m, 22, ink, 700); for (const s of V.adv2.length ? V.adv2 : ['Nothing stands out.']) text('• ' + s, m + 10, 20); trows(V.rows.filter(r => r.sec === 'Result'));
    head('Time and packing'); trows(V.rows.filter(r => r.sec === 'Time' || r.sec === 'Packing'));
    for (const id of V.needles) { head(id); trows(V.rows.filter(r => r.sec === id).map(r => ({ ...r, sec: '' }))); const ha = V.A.needles?.[id]?.hist?.speed, hb = V.B.needles?.[id]?.hist?.speed; if (ha && hb) { need(220); text('Time spent at each speed (mm/s)', m, 18, soft, 600); const na2 = ha.reduce((a2, b2) => a2 + b2, 0) || 1, nb2 = hb.reduce((a2, b2) => a2 + b2, 0) || 1, mx = Math.max(...ha.map(v => v / na2), ...hb.map(v => v / nb2)) || 1, bw = (P - 2 * m) / ha.length, E = V.A.edges?.speed || [];
        ha.forEach((v, i) => { const x = m + i * bw, hA = v / na2 / mx * 150, hB = hb[i] / nb2 / mx * 150; g.fillStyle = teal; g.fillRect(x + 6, y + 160 - hA, bw / 2 - 8, hA); g.fillStyle = '#e8b44c'; g.fillRect(x + bw / 2, y + 160 - hB, bw / 2 - 8, hB); g.fillStyle = soft; g.font = '400 14px Inter, sans-serif'; g.fillText(i ? (E[i - 1] ?? '') + (E[i] ? '–' + E[i] : '+') : '<' + (E[0] ?? ''), x + 6, y + 182); }); y += 196; } }
    head('Settings'); if (V.sets.length) { text('Only settings that differ are shown.', m, 18, soft); trows(V.sets); } else text('Both used the same settings.', m, 20); trows(V.rows.filter(r => r.sec === 'Setup')); for (const [s, n] of [[V.A, V.na], [V.B, V.nb]]) if (s.settingsFlags?.length) text(`${n}, past their limit: ${s.settingsFlags.map(f => `${f.name} ${f.value} (default ${f.default})`).join(', ')}`, m, 18, '#b0731a');
    const out = []; for (const pg of pages) out.push({ jpeg: new Uint8Array(await (await new Promise(r => pg.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer()), w: P, h: Q });
    for (const S of slot) if (S.img) { try { const im = await new Promise((res, rej) => { const i2 = new Image(); i2.onload = () => res(i2); i2.onerror = rej; i2.src = S.img; }), cv = document.createElement('canvas'); cv.width = P; cv.height = Q; const gg = cv.getContext('2d'); gg.fillStyle = '#fff'; gg.fillRect(0, 0, P, Q); const sc = Math.min(P / im.width, Q / im.height); gg.drawImage(im, (P - im.width * sc) / 2, (Q - im.height * sc) / 2, im.width * sc, im.height * sc); out.push({ jpeg: new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88))).arrayBuffer()), w: P, h: Q }); } catch {} }
    const safe = (s) => String(s).replace(/[^\w-]+/g, '-'); await saveFiles([new File([ttImgPdf(out)], `compare-${safe(V.na)}-vs-${safe(V.nb)}-${ymd(new Date())}.pdf`, { type: 'application/pdf' })]); };
  const load = async (i, src) => { const S = slot[i]; S.libId = null; S.ref = null; S.pre = false;
    if (src === 'best' || src === 'last') { const R = mine(src); if (!R) return; S.s = R.s; S.ref = R.ref; S.img = R.ref ? await Media.url(R.ref) : null; if (!S.name || S.name === 'You') S.name = R.s.artist || 'You'; return draw(); }
    if (src.startsWith('r:')) { const ref = TT_REF_STATS[+src.slice(2)]; S.s = ttStatsParse(ref.stats); S.name = ref.name; S.img = ref.img || null; S.pre = true; return draw(); }
    if (src.startsWith('c:')) { const it = ttLib().find(x => x.id === src.slice(2)); if (!it) return; S.s = ttStatsParse(it.stats); S.name = it.name; S.img = it.img ? await Media.url(it.img) : null; S.libId = it.id; return draw(); }
    if (src === 'paste') { const txt = await askText('Paste the copied stats:', ''); if (!txt) return; const s = ttStatsParse(txt); if (!s) return toast('Those are not InkForge stats. Copy them with Copy stats on a report card.', 4000); if (!fits(s)) return; S.s = s; S.img = null; if (!S.name && s.artist) S.name = s.artist; return draw(); }
    if (src === 'file') { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,.json,.txt,application/pdf,text/plain'; inp.onchange = async () => { const f = inp.files[0]; if (!f) return; let s = null, img = null;
        if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') { const r = ttPdfRead(await f.arrayBuffer()); s = r.stats; img = r.img; if (!s) return toast('No stats found in that PDF. Use one made with Save PDF in InkForge. Printed or re-saved copies lose the text.', 5000); }
        else s = ttStatsParse(await f.text()); if (!s) return toast('No InkForge stats found in that file.', 4000); if (!fits(s)) return; S.s = s; S.img = img; if (!S.name) S.name = s.artist || f.name.replace(/\.[^.]+$/, ''); draw(); }; return inp.click(); } };
  o.onclick = async (e) => { if (e.target.closest('[data-cc]')) return o.remove(); const ct = e.target.closest('[data-ct]')?.dataset.ct; if (ct) { tab = ct; return draw(); }
    if (e.target.closest('[data-cpdf]')) { const b = e.target.closest('[data-cpdf]'); b.disabled = true; b.textContent = 'Saving…'; try { await pdf(); } catch (err) { toast('Could not save: ' + err.message, 4000); } return draw(); }
    const cs = e.target.closest('[data-cs]')?.dataset.cs; if (cs) { const [src, i] = cs.split(':'); return load(+i, src); }
    const co = e.target.closest('[data-co]'); if (co) return load(+co.closest('.tt-cmpslot').classList.contains('b'), co.dataset.co);
    const cx = e.target.closest('[data-cx]')?.dataset.cx; if (cx != null) { Object.assign(slot[+cx], { s: null, img: null, libId: null, ref: null }); return draw(); }
    const sv = e.target.closest('[data-csave]')?.dataset.csave; if (sv != null) { const S = slot[+sv], note = await askText('A note for this one (optional), e.g. the date or what you were trying:', ''); if (note === null) return; let ref = null; if (S.img) { try { ref = await Media.save(await (await fetch(S.img)).blob(), 'jpg'); } catch {} } const lib = ttLib(), id = Date.now().toString(36); lib.push({ id, name: S.name || 'Saved stats', note, stats: JSON.stringify(S.s), img: ref }); await Settings.set('tt_cmp_lib', JSON.stringify(lib)); S.libId = id; toast('Saved to your collection.'); return draw(); }
    const dl = e.target.closest('[data-cdel]')?.dataset.cdel; if (dl != null) { const S = slot[+dl]; if (!await ask(`Remove "${S.name}" from your collection?`)) return; const lib = ttLib(), it = lib.find(r => r.id === S.libId); if (it?.img) await Media.release(it.img); await Settings.set('tt_cmp_lib', JSON.stringify(lib.filter(r => r.id !== S.libId))); S.libId = null; return draw(); }
    const tr = e.target.closest('[data-ctry]')?.dataset.ctry; if (tr != null) { const S = slot[+tr], l = L.find(x => x.id === S.s.lesson); if (!await ask(`Try ${S.name || 'their'} settings${l ? ` and do "${l.title}" again` : ''}? Only tattooing settings change, not your pen or tablet ones. Afterwards you choose to keep theirs or go back to yours.`)) return; await ttTrySettings(S.s, S.name || 'their'); o.remove(); toast(`Now using ${S.name || 'their'} settings.`); if (l?.task) return ttLessonRun(l.task); return; }
    const cz = e.target.closest('[data-cz]')?.dataset.cz; if (cz != null) return ttZoom(slot[+cz].img, null, 'p'); };
  o.oninput = (e) => { const n = e.target.dataset.cn; if (n != null) slot[+n].name = e.target.value; };
  o.onchange = (e) => { if (e.target.dataset.cn != null) draw(); };
  // Ready to go: your best (or last) here on the left, the first pre-loaded attempt at this lesson on the right.
  draw(); document.body.appendChild(o); (async () => { if (mine('best')) await load(0, 'best'); else if (mine('last')) await load(0, 'last'); const R = refs(); if (R.length) await load(1, 'r:' + R[0].j); })(); };
// A lesson's best passed attempt: the finished piece and its report card, and a copy for the portfolio that stays if a better score replaces it.
const ttLessonResult = async (id, last) => { const P0 = ttLessonProg(); let chl = null; if (last === 'ch') { try { chl = JSON.parse(Settings.get('tt_chlast', 'null')); } catch {} } const R = last === 'ch' ? chl : last ? P0.last : P0.results?.[id], l = last === 'ch' ? (chl && { id: chl.id, title: chl.title, task: '' }) : ttLessonList().find(x => x.id === (last ? R?.lesson : id)), lb = last === 'ch' ? 'Challenge: ' : 'Lesson: '; if (!R || !l) return; const url = await Media.url(R.ref), hurl = R.heat ? await Media.url(R.heat) : null, when = new Date(R.when).toLocaleString(), rows = [...R.parts, ...(R.skin != null ? [['skin', R.skin]] : [])], cap = s => s[0].toUpperCase() + s.slice(1), o = document.createElement('div'); o.id = 'merge-dlg'; o.className = 'tt-tune'; o.style.zIndex = 98;
  o.innerHTML = `<div class="card tt-tcard tt-report tt-chrep"><div class="tt-grade"><b>${ttGrade(R.total)}</b><div><h2 style="margin:0">${esc(l.title)}</h2><span class="muted">${last ? 'Last attempt · ' : ''}${R.total} / 100 · ${when}</span></div></div>
    <div class="tt-cats tt-lscats">${rows.map(([k, v]) => `<div><span>${cap(k)}</span><i><s style="width:${v}%;background:${v >= 80 ? 'var(--teal)' : v >= 65 ? '#e8b44c' : '#e0605a'}"></s></i><b>${v}</b></div>`).join('')}</div>
    <p class="muted" style="margin:4px 0;font-size:12px">${R.strokes} strokes · build ${R.build}</p>
    ${ttChips(R.stats)}${ttShotHtml(url, hurl, R.notes, ['l-pack', 'l-orange', 'l-stipple', 'l-whipgrey', 'l-blend'].includes(l.task))}
    <div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap"><button class="btn" data-lv="close">Close</button>${R.stats ? '<button class="btn" data-lv="copy">Copy stats</button>' : ''}${R.page ? '<button class="btn" data-lv="pdf">Save PDF</button>' : ''}<span style="flex:1"></span><button class="btn primary" data-lv="pf">Save to portfolio</button></div></div>`;
  ttShotBind(o, url, hurl);
  o.onclick = async (e) => { const a = e.target.closest('[data-lv]'); if (!a) return; if (a.dataset.lv === 'close') return o.remove(); if (a.dataset.lv === 'copy') { try { await navigator.clipboard.writeText(R.stats); toast('Stats copied.'); } catch { await askText('Copy these stats:', R.stats); } return; } if (a.dataset.lv === 'pdf') { const jb = await (await fetch(await Media.url(R.page))).arrayBuffer(), name = `${last === 'ch' ? 'challenge' : 'lesson'}-${l.id}-${ttGrade(R.total)}-${R.total}-${ymd(new Date(R.when))}.pdf`; return saveFiles([new File([ttStatsPdf(new Uint8Array(jb), R.pw, R.ph, R.stats)], name, { type: 'application/pdf' })]); } if (a.dataset.lv === 'pdf') { const jb = await (await fetch(await Media.url(R.page))).arrayBuffer(), name = `${last === 'ch' ? 'challenge' : 'lesson'}-${l.id}-${ttGrade(R.total)}-${R.total}-${ymd(new Date(R.when))}.pdf`; return saveFiles([new File([ttStatsPdf(new Uint8Array(jb), R.pw, R.ph, R.stats)], name, { type: 'application/pdf' })]); } if (a.disabled) return; a.disabled = true;
    try { const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }), W2 = 1080, ih = Math.round(im.height * 1000 / im.width), c = document.createElement('canvas'); c.width = W2; c.height = 240 + ih + 60 + Math.ceil(rows.length / 2) * 50 + 70; const g = c.getContext('2d');
      g.fillStyle = '#121617'; g.fillRect(0, 0, W2, c.height); g.fillStyle = '#e9e3d6'; g.font = "64px 'Pirata One', serif"; g.fillText(lb + l.title, 40, 100); g.font = '600 28px Inter, sans-serif'; g.fillStyle = '#9aa5a6'; g.fillText(when, 40, 150);
      g.textAlign = 'right'; g.fillStyle = '#1fb5a8'; g.font = '800 110px Inter, sans-serif'; g.fillText(String(R.total), 1040, 120); g.font = '700 30px Inter, sans-serif'; g.fillText('GRADE ' + ttGrade(R.total), 1040, 170); g.textAlign = 'left'; g.drawImage(im, 40, 220, 1000, ih);
      let y = 220 + ih + 60; g.font = '500 28px Inter, sans-serif'; g.fillStyle = '#e9e3d6'; rows.forEach(([k, v], n) => g.fillText(`${cap(k)}  ${v}`, 40 + (n % 2) * 520, y + Math.floor(n / 2) * 50)); y += Math.ceil(rows.length / 2) * 50; g.fillStyle = '#9aa5a6'; g.font = '500 24px Inter, sans-serif'; g.fillText(`${R.blowouts || 0} blowouts  ·  ${R.undos || 0} undos  ·  ${R.strokes} strokes`, 40, y);
      const blobOf = (cv, q) => new Promise(r => cv.toBlob(r, 'image/jpeg', q)), tc = document.createElement('canvas'); tc.width = 520; tc.height = Math.round(c.height * 520 / W2); tc.getContext('2d').drawImage(c, 0, 0, tc.width, tc.height);
      const photo = await Media.save(await blobOf(c, 0.9), 'jpg'), thumb = await Media.save(await blobOf(tc, 0.85), 'jpg');
      await DB.run(`INSERT INTO portfolio_items (kind, title, description, tags, made_on) VALUES ('art', ?, ?, 'simulator', date('now'))`, [lb + l.title, `${last === 'ch' ? 'Challenge' : 'Lesson'} piece from the tattoo simulator: ${R.total} / 100, grade ${ttGrade(R.total)}.`]); const pid = (await DB.one('SELECT last_insert_rowid() AS id')).id;
      await DB.run('INSERT INTO portfolio_photos (item_id, photo_ref, thumb_ref, label, sort) VALUES (?, ?, ?, ?, 0)', [pid, photo, thumb, 'Finished piece and report card']);
      if (hurl) { const hm = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = hurl; }), hc = document.createElement('canvas'); hc.width = hm.width; hc.height = hm.height; hc.getContext('2d').drawImage(hm, 0, 0); const ht = document.createElement('canvas'), hs = Math.min(1, 520 / Math.max(hm.width, hm.height)); ht.width = Math.max(1, Math.round(hm.width * hs)); ht.height = Math.max(1, Math.round(hm.height * hs)); ht.getContext('2d').drawImage(hm, 0, 0, ht.width, ht.height);
        await DB.run('INSERT INTO portfolio_photos (item_id, photo_ref, thumb_ref, label, sort) VALUES (?, ?, ?, ?, 1)', [pid, await Media.save(await blobOf(hc, 0.92), 'jpg'), await Media.save(await blobOf(ht, 0.85), 'jpg'), 'Heat map']); }
      a.textContent = 'Saved'; toast('Saved to Portfolio.'); } catch (err) { a.disabled = false; toast('Could not save: ' + err.message, 4000); } };
  document.body.appendChild(o); };
TT.lesson = (el, id, i) => { const l = ttLessonList().find(x => x.id === id), S = l.steps; let more = false;
  const draw = () => { const s = S[i], tuned = !!Settings.get('tt_tuned'), last = i === S.length - 1;
    el.innerHTML = `<div class="tt-hub"><div class="row" style="margin-bottom:12px;gap:8px"><button class="btn icon-btn" data-l="out" aria-label="Back" data-tip="Back to the lessons"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button><b style="flex:1">${esc(l.title)}</b>${l.task ? '<button class="btn small" data-l="run">Skip to tattooing</button>' : ''}</div>
      <div class="card tt-lscard"><div class="tt-tsteps">${S.map((_, j) => `<i class="${j < i ? 'done' : j === i ? 'on' : ''}"></i>`).join('')}</div>
        <h2>${esc(s.title)}</h2>${ttLessonPic(s.pic)}<p>${esc(s.text)}</p>
        ${s.more ? (more ? `<p class="muted">${esc(s.more)}</p>` : '<button class="btn small" data-l="more">See more</button>') : ''}
        ${s.tune ? `<p class="tt-tmsg">${tuned ? 'This device is tuned in. You can run it again if you like.' : ''}</p><div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn ${tuned ? '' : 'primary'}" data-l="tune">${tuned ? 'Tune in again' : 'Tune in now'}</button>${tuned ? '' : '<button class="btn" data-l="skip">Skip for now</button>'}</div>` : ''}
        <div class="row" style="gap:6px;margin-top:14px"><button class="btn" data-l="prev" ${i ? '' : 'disabled'}>Back</button><span style="flex:1"></span><button class="btn primary" data-l="${last && l.task ? 'run' : 'next'}" ${s.tune && !tuned ? 'disabled' : ''}>${last ? (l.task ? 'Go to the workspace' : 'Finish lesson') : 'Next'}</button></div></div></div>`; };
  el.onclick = async (e) => { const a = e.target.closest('[data-l]')?.dataset.l; if (!a) return;
    if (a === 'out') return TT.lessons(el);
    if (a === 'more') { more = true; return draw(); }
    if (a === 'prev') { i--; more = false; return draw(); }
    if (a === 'run') return ttLessonRun(l.task);
    if (a === 'tune') { TT.lessonBack = { id, i }; return ttTuneOnly(); }
    if (a === 'skip' || a === 'next') { if (i < S.length - 1) { i++; more = false; return draw(); }
      const p = ttLessonProg(); p.done[id] = Date.now(); await Settings.set('tt_lessons', JSON.stringify(p)); toast('Lesson complete.'); return TT.lessons(el); } };
  draw();
};
// Tune in lives inside an open piece, so the lessons reach it through one hidden piece kept for the purpose.
const ttTuneOnly = async () => { const rows = await DB.all('SELECT id, meta FROM tattoo_pieces'), r = rows.find(x => { try { return JSON.parse(x.meta || '{}').tuneOnly; } catch { return false; } });
  if (r) { location.hash = 'tattoo/' + r.id; return; }
  await DB.run('INSERT INTO tattoo_pieces (name, w_cm, h_cm, skin, meta) VALUES (?, ?, ?, ?, ?)', ['Tune in', 18, 13, Settings.get('tt_skin', '#e2b493'), JSON.stringify({ tuneOnly: 1 })]);
  location.hash = 'tattoo/' + (await DB.one('SELECT last_insert_rowid() AS id')).id; };

// The results sheet: every challenge with its stars, best, medal and tries, the trophies and exam grades, on an A4 page.
TT.sheet = async () => {
  const a = TT.aw.get(), { cv, x, font, text, header } = await docCanvas(); await header();
  const { W, M, teal, soft } = DOC; let y = 300;
  text('Challenge results', M, y, font(54, 400, true)); text(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }), W - M, y, font(22), soft, 'right'); y += 46;
  const done = TT_CH.filter(c => a.pb[c.id]).length, golds = TT_CH.filter(c => ttBest(a, c.id) >= 90).length;
  text(`${done} of ${TT_CH.length} challenges done · ${golds} gold · ${Object.keys(a.trophies).length} of ${TT_TROPHIES.length} trophies`, M, y, font(22), soft); y += 40;
  const cols = [M, M + 560, M + 660, M + 780, M + 900];
  for (const [k, n] of TT_HUB) {
    x.fillStyle = teal; x.fillRect(M, y - 4, W - 2 * M, 2); y += 30; text(n.toUpperCase(), M, y, font(20, 700), teal);
    text('STARS', cols[1], y, font(16, 700), soft); text('BEST', cols[2], y, font(16, 700), soft); text('MEDAL', cols[3], y, font(16, 700), soft); text('TRIES', cols[4], y, font(16, 700), soft); y += 30;
    for (const c of ttHubCh(k).sort((p, q) => p.diff - q.diff)) { const p = a.pb[c.id], m = ttMedal(p?.best);
      text(ttShort(c.title), cols[0], y, font(21)); text('★'.repeat(c.diff), cols[1], y, font(21), '#c99a2e');
      text(p ? String(p.best) : '–', cols[2], y, font(21, 700)); text(m ? m[2] : '', cols[3], y, font(21), m ? { gold: '#b8860b', silver: '#7d8a91', bronze: '#a0622d' }[m[1]] : soft); text(p ? String(p.tries) : '', cols[4], y, font(21), soft); y += 29; }
    y += 6;
  }
  const won = TT_TROPHIES.filter(t => a.trophies[t.id]);
  if (won.length) { y += 8; text('TROPHIES', M, y, font(20, 700), teal); y += 30; text(won.map(t => t.name).join(' · '), M, y, font(19)); y += 34; }
  if (a.exam.length) { text('APPRENTICE EXAM', M, y, font(20, 700), teal); y += 30; text(a.exam.slice(-6).map(e => `${new Date(e.t).toLocaleDateString()}: ${e.grade} (${e.overall})`).join(' · '), M, y, font(19)); }
  const file = await canvasFile(cv, `challenge-results-${ymd(new Date())}.png`);
  const o = document.createElement('div'); o.id = 'merge-dlg';
  o.innerHTML = `<div class="card"><h2>Results sheet</h2><img src="${cv.toDataURL('image/jpeg', 0.8)}" alt="" style="width:100%;border-radius:8px;margin-bottom:10px">
    <div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn" data-a="x">Close</button><span style="flex:1"></span><button class="btn" data-a="save">Save</button><button class="btn" data-a="share">Share</button><button class="btn primary" data-a="print">Print / PDF</button></div></div>`;
  o.onclick = (e) => { const k = e.target.closest('[data-a]')?.dataset.a; if (!k) return;
    if (k === 'x') return o.remove(); if (k === 'save') return saveFiles([file]); if (k === 'share') return shareFiles([file], 'Challenge results');
    if (k === 'print') { o.remove(); printCanvas(cv); } };
  document.body.appendChild(o);
};

/* ---------- The list of pieces ---------- */
TT.list = async (el) => {
  ttStyle();
  const rows = (await DB.all('SELECT id, name, w_cm, h_cm, thumb_ref, updated_at, meta FROM tattoo_pieces ORDER BY updated_at DESC, id DESC'))
    .map(r => { let ex = null; try { ex = JSON.parse(r.meta || '{}').exam; } catch {} let m2 = {}; try { m2 = JSON.parse(r.meta || '{}'); } catch {} return { ...r, ch: ex?.mode === 'ch', cheat: !!m2.cheat, exam: ex ? (ex.done ? 2 : 1) : 0, tuneOnly: !!m2.tuneOnly }; }).filter(r => !r.ch && !r.tuneOnly);
  const urls = await Promise.all(rows.map(r => Media.url(r.thumb_ref)));
  el.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="muted" style="margin:0;flex:1;font-size:13px">Experimental: draw with needle groupings in ink on skin. Works best with a pressure pen (like an S Pen).</p>
      <button class="btn" id="tt-less" data-go="tattoo/lessons" data-tip="Step-by-step lessons with tips and techniques; each one unlocks the next">Lessons</button>
      <button class="btn" id="tt-chal" data-go="tattoo/challenges" data-tip="Single challenges in every style and flash pieces to tattoo: medals, personal bests and trophies">Challenges</button>
      <button class="btn" id="tt-exam" data-tip="A set of challenges, from lines to a finished piece, with a report card">Apprentice exam</button>
      <button class="btn primary" id="tt-new">+ New piece</button></div>
    ${rows.length ? `<div class="dz-grid">${rows.map((r, i) => `<div class="dz-item" data-open="${r.id}"><div class="dz-thumb">${urls[i] ? `<img src="${urls[i]}" alt="">` : ''}</div>
      <div class="dz-meta"><b>${esc(r.name || 'Piece')}</b><span class="muted">${r.exam ? (r.exam === 2 ? 'Exam · finished' : 'Exam · in progress') : `${+r.w_cm} × ${+r.h_cm} cm`}${r.cheat ? ' <span class="tt-cheat" style="display:inline-block;margin-left:4px">Cheat</span>' : ''}</span></div>
      <button class="mini" data-del="${r.id}" aria-label="Delete" data-tip="Delete">✕</button></div>`).join('')}</div>`
      : `<div class="empty"><div class="empty-ico">${ICON.needle}</div><div style="font:24px var(--display)">Tattoo simulator</div>
        <div class="muted">Pick a page size and skin tone, load a stencil to trace, dip into the ink caps and tattoo in layers: linework, shadow, mid and light tones, highlights.</div></div>`}`;
  $('#tt-new').onclick = () => ttNewDlg();
  $('#tt-exam').onclick = async () => {   // carry on with an unfinished exam, or start one
    const open = rows.find(r => r.exam === 1);
    if (open) { location.hash = 'tattoo/' + open.id; return; }
    const si = ttChSkin(), list = ttExamList(si);
    if (!await ask(`Start the apprentice exam on ${TT_SKINS[si][0].toLowerCase()} skin?\n\n11 challenges, from straight lines to ${list ? 'a heart in grey wash (this skin takes no colour)' : 'a finished heart'}. Each loads its stencil, an example to follow and the needle to use; you can stop at any point and carry on later. You get a report card at the end.\n\nThe skin is chosen in Challenges.`)) return;
    await DB.run('INSERT INTO tattoo_pieces (name, w_cm, h_cm, skin, meta) VALUES (?, ?, ?, ?, ?)', ['Apprentice exam', 18, 13, TT_SKINS[si][1], JSON.stringify({ exam: { v: 1, i: 0, res: [], started: Date.now(), ...(list ? { list } : {}) } })]);
    location.hash = 'tattoo/' + (await DB.one('SELECT last_insert_rowid() AS id')).id;
  };
  el.onclick = async (e) => {
    const d = e.target.closest('[data-del]');
    if (d) { e.stopPropagation(); const r = await DB.one('SELECT * FROM tattoo_pieces WHERE id = ?', [+d.dataset.del]); if (!r || !await ask(`Delete "${r.name || 'this piece'}"?`)) return;
      await DB.run('DELETE FROM tattoo_pieces WHERE id = ?', [r.id]); for (const k of ['thumb_ref', 'skin_ref', 'blow_ref', ...TT_LAYERS.map(([l]) => l + '_ref')]) await Media.release(r[k]);
      let tl = []; try { tl = JSON.parse(r.meta || '{}').tl || []; } catch {} for (const f of tl) await Media.release(f); return TT.list(el); }
    const o = e.target.closest('[data-open]'); if (o) location.hash = 'tattoo/' + o.dataset.open;
  };
};
function ttNewDlg() {
  const st = { size: 1, skin: Settings.get('tt_skin', '#e2b493'), cw: 15, ch: 20, cheat: false };
  const o = document.createElement('div'); o.id = 'merge-dlg';
  const draw = () => { o.innerHTML = `<div class="card"><h2>New piece</h2>
    <div class="lbl">Page</div><div class="seg" style="flex-wrap:wrap;margin-bottom:8px">${[...TT_SIZES, ['Custom']].map(([n], i) => `<button data-s="${i}" class="${st.size === i ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${st.size === TT_SIZES.length ? `<div class="two"><label class="field"><span>Width (cm)</span><input class="in" id="tn-w" type="number" min="3" max="60" value="${st.cw}"></label>
      <label class="field"><span>Height (cm)</span><input class="in" id="tn-h" type="number" min="3" max="60" value="${st.ch}"></label></div>` : ''}
    <div class="lbl">Skin</div><div class="tt-skins">${TT_SKINS.map(([n, c]) => `<button data-k="${c}" class="${st.skin === c ? 'on' : ''}" style="background:${c}" data-tip="${n}" aria-label="${n}"></button>`).join('')}
      <label class="tt-skinpick" data-tip="Any skin tone"><input type="color" id="tn-k" value="${st.skin}"></label></div>
    <label class="field"><span>Name</span><input class="in" id="tn-n" value="${esc(st.name ?? 'Piece ' + ymd(new Date()))}"></label>
    <label class="toggle tt-cheatpick" data-tip="Design freely: no skin damage, smoother lines, hold to snap, and drawing helpers. Not for challenges, and anything saved from it is marked as a cheat.">
      <input type="checkbox" id="tn-cheat" ${st.cheat ? 'checked' : ''}><span><b>Cheat mode</b> · no skin damage, drawing helpers. Handy for designing for clients.</span></label>
    <div class="row"><button class="btn" id="tn-x">Cancel</button><button class="btn primary" id="tn-go" style="flex:1">Start</button></div></div>`; };
  o.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-s]')) { st.size = +t.closest('[data-s]').dataset.s; return draw(); }
    if (t.closest('[data-k]')) { st.skin = t.closest('[data-k]').dataset.k; return draw(); }
    if (t.id === 'tn-x') return o.remove();
    if (t.id === 'tn-go') {
      const [, w, h] = st.size < TT_SIZES.length ? TT_SIZES[st.size] : [0, Math.min(60, Math.max(3, +$('#tn-w').value || 15)), Math.min(60, Math.max(3, +$('#tn-h').value || 20))];
      await Settings.set('tt_skin', st.skin);
      await DB.run('INSERT INTO tattoo_pieces (name, w_cm, h_cm, skin, meta) VALUES (?, ?, ?, ?, ?)', [$('#tn-n').value.trim() || 'Piece', w, h, st.skin, st.cheat ? JSON.stringify({ cheat: true }) : null]);
      const id = (await DB.one('SELECT last_insert_rowid() AS id')).id; o.remove(); location.hash = 'tattoo/' + id;
    }
  };
  o.oninput = (e) => { if (e.target.id === 'tn-cheat') st.cheat = e.target.checked; if (e.target.id === 'tn-n') st.name = e.target.value; if (e.target.id === 'tn-k') { st.skin = e.target.value; } if (e.target.id === 'tn-w') st.cw = +e.target.value; if (e.target.id === 'tn-h') st.ch = +e.target.value; };
  document.body.appendChild(o); draw();
}

/* ---------- The page ---------- */
TT.open = async (el, id) => {
  ttStyle(); const migrated = TT.migrate(); await TT.loadSaved();
  const row = await DB.one('SELECT * FROM tattoo_pieces WHERE id = ?', [id]); if (!row) { location.hash = 'tattoo'; return; }
  const R = Math.min(80, 2400 / Math.max(row.w_cm, row.h_cm)), W = Math.round(row.w_cm * R), H = Math.round(row.h_cm * R), mm = R / 10;   // page px per cm, per mm
  const L = {}; for (const [k] of TT_LAYERS) { const c = document.createElement('canvas'); c.width = W; c.height = H; L[k] = c; }
  for (const [k] of TT_LAYERS) { const ref = row[k + '_ref']; if (!ref) continue; const u = await Media.url(ref); if (!u) continue;
    const im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; }); if (im) L[k].getContext('2d').drawImage(im, 0, 0, W, H); }
  let meta = {}; try { meta = JSON.parse(row.meta || '{}'); } catch {}
  /* Cheat mode (chosen for a new piece, never in challenges): the skin takes no damage (no redness, swelling,
     blowouts, bumps or crashes), strokes are smoothed, holding the pen still snaps a stroke to a line or circle, and
     drawing helpers are on hand. Anything saved from it is stamped as a cheat. */
  const CHEAT = !!meta.cheat && !meta.exam;
  // Tool settings last used (cheat tools, for new cheat pieces; the marker, for every piece). A piece's own come first.
  const CP = (() => { try { return CHEAT ? JSON.parse(Settings.get('tt_cheat_prefs', '{}')) : {}; } catch { return {}; } })();
  const MKP = (() => { try { return JSON.parse(Settings.get('tt_mk', 'null')); } catch { return null; } })();
  let lastVk = '';   // the view the guides were last placed for
  const st = { layer: meta.layer || 'line', needle: meta.needle || '3RL', tool: 'needle', hide: new Set(meta.hide || []), op: { stencil: 0.45, ...(meta.op || {}) },
    ink: { c: ttHex(meta.ink || '#141414'), v: meta.inkV ?? 0, s: meta.inkS ?? 1, w: meta.inkW ?? 0 }, wash: !!meta.wash, caps: meta.caps ? (meta.caps.length < TT_CAPS.length ? [...meta.caps.slice(0, -1), ...TT_CAPS.slice(meta.caps.length - 1, -1), meta.caps[meta.caps.length - 1]] : meta.caps) : [...TT_CAPS] /* a piece saved before a cap was added gets it too, in before its white */, panel: null, dirty: false, name: row.name, skin: row.skin || '#e2b493',
    stretch: meta.stretch ?? TT_STRETCH, view: 'work', viewC: null, refsInit: meta.refs || [], magAng: meta.magAng ?? 75, magTilt: meta.magTilt ?? true, rot: meta.rot || 0 };
  /* Pigment in the skin. Each ink layer's pixels hold how much ink that spot holds (alpha: 0 = none, 255 = fully
     saturated) and its colour. A puncture only adds ink into the room left, counting the ink of every layer at that
     spot; ink lighter than what's there is held back in proportion to how saturated it is (a light value can't take
     over a dark one, but fills a feathered edge), while darker ink still goes in. Where two inks share a spot they
     mix like pigment (blue and yellow make green). The pixels are worked on directly and copied to the layer's
     canvas once per frame. */
  const INK = TT_LAYERS.map(([key]) => key).filter(key => key !== 'stencil' && key !== 'marker');   // the stencil and marker sit on the skin, not in it
  const loadImg = async (ref) => { const u = ref && await Media.url(ref); return u ? new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; }) : null; };
  const imgd = {}, dirty = {}, touched = new Set();   // touched: layers changed since the last save
  const syncIn = (key) => { if (INK.includes(key)) imgd[key] = L[key].getContext('2d').getImageData(0, 0, W, H); };
  INK.forEach(syncIn);
  const ALOG = new Float32Array(256); for (let i = 0; i < 256; i++) ALOG[i] = -Math.log(Math.max(0.02, i / 255));
  const lumOf = (D, i) => (D[i] * 0.299 + D[i + 1] * 0.587 + D[i + 2] * 0.114) / 255;
  /* How far each pixel has already been shifted by lighter ink packed over saturated darker ink, in 1/255 steps.
     Real pigment can't be covered by a lighter one: past about 5% the extra passes only work the skin. */
  const MUD = [66, 48, 36].map(v => ALOG[v]);   // the dark brown a cold colour churns a warm one towards
  let LIT = null, LITC = null;   // per pixel: how far the ink now going over it has shifted it (sum of each pass's share, x1000), and which ink that is (a new ink starts its own count)
  const dotPig = (T, cx0, cy0, r, amt, erase) => {
    const x0 = Math.max(0, Math.floor(cx0 - r - 1)), x1 = Math.min(W - 1, Math.ceil(cx0 + r + 1)), y0 = Math.max(0, Math.floor(cy0 - r - 1)), y1 = Math.min(H - 1, Math.ceil(cy0 + r + 1));
    if (x0 > x1 || y0 > y1) return;
    const D = imgd[T.key].data, col = T.col, lc = T.lum, Ac = T.ac;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const cov = Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx0, y + 0.5 - cy0)); if (cov <= 0) continue;
      const a = amt * cov, i = (y * W + x) * 4;
      if (erase) { D[i + 3] = Math.floor(D[i + 3] * (1 - a)); continue; }
      let keep = 1, lw = 0, dw = 0;   // the ink already here, in every layer: how saturated, and how light
      for (const key of INK) { const E = imgd[key].data, d2 = E[i + 3] / 255; if (!d2) continue; keep *= 1 - d2; lw += lumOf(E, i) * d2; dw += d2; }
      // lighter ink over saturated ink: mostly held back, but never fully, and it still tints what's there a little
      /* A cold colour (blue, green) over a warm one (red, orange) muddies it: it acts darker than its value, and the
         mix goes dark and brownish, more the more saturated the warm ink under it is. */
      const d0w = D[i + 3] / 255, opp = d0w > 0.004 ? Math.max(0, Math.min(1, (D[i] - D[i + 2]) / 255 * 1.6)) * Math.max(0, Math.min(1, (col[2] + col[1] / 2 - col[0]) / 255 * 1.6)) * (1 - keep) : 0, lce = lc - 0.6 * opp;
      const lwa = dw ? lw / dw : 0, block = Math.pow(1 - keep, 1.4) * (dw ? Math.max(0, Math.min(1, (lce - lwa - 0.02) / 0.1)) : 0) * 0.88, dom = dw ? 1 + 4 * Math.max(0, lwa - lce) : 1;   // close values mix evenly; a darker ink takes over (black over red completely), a lighter one is held back
      let add = a * (1 - block); const d0 = D[i + 3] / 255, tint = add * dom + a * block * 0.35;
      if (T.str < 1) { add *= 0.35 + 0.65 * T.str; const sat = 1 - keep; if (sat > T.str) add *= 0.1 * T.str; }   // a thin wash builds slowly past its own tone
      if (add <= 0.0005) continue;
      if (d0 > 0.004) { let t = Math.min(0.85, tint / (d0 + tint)); const sat0 = 1 - keep, cap = block > 0.4 ? -Math.log(1 - 0.5 * Math.max(0.1, 1 - (lce - lwa) / 0.5)) : sat0 > 0.7 && (lc > lwa - 0.15 || opp > 0.05) ? -Math.log(1 - Math.min(0.995, 0.65 + 2.3 * Math.max(0, lwa - lce))) : 0;   /* saturated skin: like oil paint, a lighter colour mixes its hue in (more the closer in value) but can't lighten it more than a touch; one close in value mixes in, from 65% up to all but completely the darker it is (black over red) */
        if (cap) { const p = y * W + x, ck = 1 + ((col[0] >> 3) << 10 | (col[1] >> 3) << 5 | col[2] >> 3); LIT ||= new Uint16Array(W * H); LITC ||= new Uint16Array(W * H); if (LITC[p] !== ck) { LITC[p] = ck; LIT[p] = 0; } const used = LIT[p] / 1000; t = Math.min(t, Math.max(0, cap - used)); LIT[p] = Math.min(65535, Math.round((used + t) * 1000)); }
        const m = Math.min(0.5, t * opp * 1.4), nv = [0, 1, 2].map(c => 255 * Math.exp(-(ALOG[D[i + c]] * (1 - t - m) + Ac[c] * t + MUD[c] * m)));
        if (block > 0.4) { const L1 = (nv[0] * 0.299 + nv[1] * 0.587 + nv[2] * 0.114) / 255, lim = lumOf(D, i) * (1 + 0.1 * t) + 0.002; if (L1 > lim) for (let c = 0; c < 3; c++) nv[c] *= lim / L1; }   // a lighter ink changes the hue but keeps the value: no lighter than a touch
        for (let c = 0; c < 3; c++) D[i + c] = Math.floor(nv[c] + Math.random()); }   /* rounded at random, not to the nearest, so shifts smaller than a step still add up evenly on every channel */
      else { D[i] = col[0]; D[i + 1] = col[1]; D[i + 2] = col[2]; }
      D[i + 3] = Math.min(255, Math.floor(D[i + 3] + add * 255 + Math.random()));
    }
    const b = dirty[T.key] ||= { x0, y0, x1, y1 }; b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0); b.x1 = Math.max(b.x1, x1); b.y1 = Math.max(b.y1, y1);
  };
  const flushPig = () => { let u = null;
    for (const key in dirty) { const b = dirty[key]; L[key].getContext('2d').putImageData(imgd[key], 0, 0, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1); delete dirty[key]; touched.add(key);
      u = u ? { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) } : { ...b }; }
    return u; };
  // One mark: into pigment (the page), or painted on a canvas (the test pad).
  const put = (cx, x, y, r, al, erase) => { if (cx.pig) return dotPig(cx, x, y, r, al, erase);
    cx.globalAlpha = al; cx.beginPath(); cx.arc(x, y, r, 0, 7); cx.fill(); };
  /* The skin itself. Trauma: every puncture works the skin a little (deeper, more needles: more), on a map at a
     quarter of the page's resolution; as it builds the skin goes red, then swollen and bumpy, then raw like
     minced meat, and overworked skin takes ink badly (patchy). Blowouts: too deep while the punctures land very
     close together (pressing hard and pulling slowly) pushes ink under the skin: a soft, bluish bruise that spreads
     past the line and raises the skin. Both are kept with the piece; a healed preview drops the redness and
     swelling but keeps the blowouts. */
  const TS = 4, tw = Math.ceil(W / TS), th = Math.ceil(H / TS), TR = new Float32Array(tw * th), TP = new Float32Array(tw * th), THit = new Float64Array(tw * th), HC = new Float32Array(tw * th);   // HC: needle hits landed on each cell, however dark it already looks
  // Bumps: little red pimples where the needle went too deep or the machine ran too hard (fresh skin only).
  const BU = new Float32Array(tw * th);
  const buAdd = (p, v) => { if (CHEAT) return; const i = Math.min(th - 1, Math.max(0, Math.floor(p.y / TS))) * tw + Math.min(tw - 1, Math.max(0, Math.floor(p.x / TS))); BU[i] = Math.min(1, BU[i] + v); trDirty = true; };
  const blowC = document.createElement('canvas'); blowC.width = Math.ceil(W / 2); blowC.height = Math.ceil(H / 2); const bx = blowC.getContext('2d');
  let trDirty = true, trT = 0; const told = {};
  const trAdd = (p, r, v) => { if (CHEAT) return;
    const cx0 = p.x / TS, cy0 = p.y / TS, R2 = Math.max(1, r / TS), now = performance.now();
    for (let y = Math.max(0, Math.floor(cy0 - R2)); y <= Math.min(th - 1, Math.ceil(cy0 + R2)); y++)
      for (let x2 = Math.max(0, Math.floor(cx0 - R2)); x2 <= Math.min(tw - 1, Math.ceil(cx0 + R2)); x2++) {
        const f = 1 - Math.hypot(x2 + 0.5 - cx0, y + 0.5 - cy0) / R2; if (f > 0) { const c = y * tw + x2; TR[c] += v * f; if (TR[c] > TP[c]) TP[c] = TR[c]; THit[c] = now; } }
    trDirty = true;
  };
  /* Skin settles once the needle moves away: after a few seconds' rest, redness and swelling halve about every 30 seconds.
     Damage leaves a mark, though: once well into swelling, skin only comes down one stage, to a level set by the worst it
     reached (TP), and stays there: it can get worse but never better. The healed views read TP too, so the timer doesn't change them. Only runs while the piece is open. */
  const HEAL_REST = 3000, HEAL_HALF = 30000, healFloor = (pk) => pk < 1 ? 0 : pk < 1.4 ? 0.35 + (pk - 1) : 0.85 + (pk - 1.4) * 0.5;   // red heals away; just into swelling settles at red; overworked settles at swollen and stays
  let healT = performance.now();
  const healId = setInterval(() => { if (!cv.isConnected) return clearInterval(healId); if (CHEAT) return; const now = performance.now(), dt = now - healT; healT = now; if (document.hidden) return;
    const k = 1 - Math.pow(0.5, dt / HEAL_HALF); let moved = 0;
    for (let i = 0; i < TR.length; i++) { const v = TR[i]; if (v <= 0 || now - THit[i] < HEAL_REST) continue; const fl = healFloor(TP[i]); if (v <= fl) continue; const nv = v - (v - fl) * k; TR[i] = nv < 0.005 ? 0 : nv; moved = Math.max(moved, v - nv);
      if (BU[i] && TP[i] < 1) BU[i] = Math.max(0, BU[i] - k * 0.8); }
    if (moved > 0.002) { trDirty = true; if (!pen && st.view === 'work') paint(); } }, 2000);
  const trAt = (p) => TR[Math.min(th - 1, Math.max(0, Math.floor(p.y / TS))) * tw + Math.min(tw - 1, Math.max(0, Math.floor(p.x / TS)))] || 0;
  // Raw skin: a mottled, bumpy texture of red and pink lumps, made once.
  const patty = (() => { const c = document.createElement('canvas'); c.width = c.height = 160; const g = c.getContext('2d');
    g.fillStyle = '#a53a33'; g.fillRect(0, 0, 160, 160);
    for (let i = 0; i < 520; i++) { const px = Math.random() * 160, py = Math.random() * 160, r = 2 + Math.random() * 6, gr = g.createRadialGradient(px - r * 0.35, py - r * 0.35, 0, px, py, r);
      gr.addColorStop(0, `rgba(${226 + Math.random() * 20},${120 + Math.random() * 40},${105 + Math.random() * 30},.85)`); gr.addColorStop(0.6, 'rgba(160,52,45,.5)'); gr.addColorStop(1, 'rgba(95,24,22,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(px, py, r, 0, 7); g.fill(); }
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(70,15,14,${0.25 + Math.random() * 0.35})`; g.beginPath(); g.arc(Math.random() * 160, Math.random() * 160, 0.6 + Math.random() * 1.2, 0, 7); g.fill(); }
    return c; })();
  const trRed = document.createElement('canvas'), trMask = document.createElement('canvas'), trTex = document.createElement('canvas');
  trRed.width = trMask.width = tw; trRed.height = trMask.height = th; trTex.width = Math.ceil(W / 2); trTex.height = Math.ceil(H / 2);
  const trGlow = document.createElement('canvas'), trPuff = document.createElement('canvas'); trGlow.width = trPuff.width = tw; trGlow.height = trPuff.height = th; const glowG = trGlow.getContext('2d'), puffG = trPuff.getContext('2d');
  const buildTrauma = () => {
    const rg = trRed.getContext('2d'), mg = trMask.getContext('2d'), ri = rg.createImageData(tw, th), mi = mg.createImageData(tw, th);
    for (let i = 0; i < TR.length; i++) { const t = TR[i], j = i * 4; if (!t) continue;
      ri.data[j] = 214; ri.data[j + 1] = 64; ri.data[j + 2] = 52; ri.data[j + 3] = Math.min(150, Math.max(0, t - 0.3) * 160);
      const m = Math.max(0, Math.min(1, (t - 1) / 1.2)); mi.data[j] = mi.data[j + 1] = mi.data[j + 2] = 255; mi.data[j + 3] = m * m * (3 - 2 * m) * 235; }
    rg.putImageData(ri, 0, 0); mg.putImageData(mi, 0, 0);
    const tg = trTex.getContext('2d'); tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, trTex.width, trTex.height);
    tg.fillStyle = tg.createPattern(patty, 'repeat'); tg.fillRect(0, 0, trTex.width, trTex.height);
    tg.globalCompositeOperation = 'destination-in'; tg.imageSmoothingEnabled = true; tg.drawImage(trMask, 0, 0, trTex.width, trTex.height); tg.globalCompositeOperation = 'source-over';
    // Sores: tiny raised pimples, a pinprick with a flush round it and a speck of shine, each a little different.
    const bs = trTex.width / tw;
    for (let i = 0; i < BU.length; i++) { const b = BU[i]; if (b < 0.15) continue; const h = Math.imul(i, 2654435761) >>> 0;
      const px = ((i % tw) + 0.2 + (h & 255) / 255 * 0.6) * bs, py = (Math.floor(i / tw) + 0.2 + ((h >> 8) & 255) / 255 * 0.6) * bs, r = (0.2 + b * 0.22 + ((h >> 16) & 255) / 255 * 0.14) * mm / 4;
      let gr = tg.createRadialGradient(px, py, r * 0.4, px, py, r * 2.6); gr.addColorStop(0, 'rgba(205,60,52,.42)'); gr.addColorStop(1, 'rgba(205,60,52,0)'); tg.fillStyle = gr; tg.beginPath(); tg.arc(px, py, r * 2.6, 0, 7); tg.fill();
      gr = tg.createRadialGradient(px - r * 0.3, py - r * 0.35, 0, px, py, r); gr.addColorStop(0, 'rgba(236,128,116,.95)'); gr.addColorStop(0.6, 'rgba(186,48,44,.95)'); gr.addColorStop(1, 'rgba(140,28,28,.85)'); tg.fillStyle = gr; tg.beginPath(); tg.arc(px, py, r, 0, 7); tg.fill();
      tg.fillStyle = 'rgba(110,18,20,.85)'; tg.beginPath(); tg.arc(px, py, Math.max(0.35, r * 0.22), 0, 7); tg.fill();
      tg.fillStyle = 'rgba(255,240,235,.75)'; tg.beginPath(); tg.arc(px - r * 0.38, py - r * 0.42, Math.max(0.25, r * 0.16), 0, 7); tg.fill(); }
    // Swelling and the flush round it: the wear spread out a few mm (three box blurs), as a red halo and as raised, lit skin.
    { const R = Math.max(2, Math.round(2.5 * mm / TS)), A = Float32Array.from(TR), B = new Float32Array(TR.length), blur = (S, D, n, step, lines, len) => { for (let l = 0; l < lines; l++) { let s = 0; const at = (k) => S[l * n + Math.max(0, Math.min(len - 1, k)) * step]; for (let k = -R; k <= R; k++) s += at(k); for (let k = 0; k < len; k++) { D[l * n + k * step] = s / (2 * R + 1); s += at(k + R + 1) - at(k - R); } } };
      for (let p = 0; p < 2; p++) { blur(A, B, tw, 1, th, tw); blur(B, A, 1, tw, tw, th); }
      const gi = glowG.createImageData(tw, th), pi = puffG.createImageData(tw, th);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const i = y * tw + x, j = i * 4, v = A[i]; if (v < 0.01) continue;
        gi.data[j] = 216; gi.data[j + 1] = 78; gi.data[j + 2] = 66; gi.data[j + 3] = Math.min(135, Math.max(0, v - 0.12) * 190);
        const sh = ((A[i - 1] ?? v) - (A[i + 1] ?? v) + (A[i - tw] ?? v) - (A[i + tw] ?? v)) * 7 * Math.min(1, v * 1.5), lit = sh < 0; pi.data[j] = pi.data[j + 1] = pi.data[j + 2] = lit ? 255 : 60; pi.data[j + 3] = Math.min(70, Math.abs(sh) * 255); }
      glowG.putImageData(gi, 0, 0); puffG.putImageData(pi, 0, 0); }
    trDirty = false; trT = performance.now();
  };
  // The skin under and over the ink: redness and blowouts beneath, the swollen, raw texture on top.
  const skinUnder = (g, withTrauma) => { if (withTrauma) { g.globalCompositeOperation = 'multiply'; g.drawImage(trGlow, 0, 0, W, H); g.drawImage(trRed, 0, 0, W, H); }
    g.globalCompositeOperation = 'multiply'; g.drawImage(blowC, 0, 0, W, H); g.globalCompositeOperation = 'source-over'; };
  // Redness shows through the ink, the swelling lifts the skin, and the raw texture and sores sit on top.
  const skinOver = (g) => { g.globalAlpha = 0.3; g.drawImage(trRed, 0, 0, W, H); g.globalAlpha = 1; g.drawImage(trPuff, 0, 0, W, H); g.globalAlpha = 0.85; g.drawImage(trTex, 0, 0, W, H); g.globalAlpha = 1; };
  // Blowout: ink spread under the skin round p, bluer and softer than the line, and the skin raised over it.
  const blowAt = (p, risk, footR) => { if (CHEAT) return;
    if (EX?.cur) { EX.cur.blow = (EX.cur.blow || 0) + 1; tally(); const sp = EX.cur.spots ||= [], near = sp.find(q => Math.hypot(q[0] - p.x, q[1] - p.y) < 3 * mm); if (near) near[2]++; else sp.push([p.x, p.y, 1]); } SS.blow++;   // spots for the heat map; hits within 3 mm are one spot
    // ink seen through the skin: bluer
    const c = st.ink.c.map((v, j) => Math.round((v * 0.45 + [0.34, 0.42, 0.68][j] * 0.55) * 255)), R = (footR + mm * (1.1 + risk * 1.8)) / 2, gx = p.x / 2, gy = p.y / 2;
    const gr = bx.createRadialGradient(gx, gy, 0, gx, gy, R); gr.addColorStop(0, `rgba(${c},${0.12 + risk * 0.16})`); gr.addColorStop(0.5, `rgba(${c},${0.05 + risk * 0.07})`); gr.addColorStop(1, `rgba(${c},0)`);
    bx.fillStyle = gr; bx.beginPath(); bx.arc(gx, gy, R, 0, 7); bx.fill();
    trAdd(p, footR * 2.2 + mm, 0.035 * risk);
  };
  { const bi = await loadImg(row.blow_ref); if (bi) bx.drawImage(bi, 0, 0, blowC.width, blowC.height);
    const ti = await loadImg(row.skin_ref); if (ti) { const c = document.createElement('canvas'); c.width = tw; c.height = th; const g = c.getContext('2d'); g.drawImage(ti, 0, 0, tw, th);
      if (meta.hc) { const hu = await Media.url(meta.hc), him = hu && await new Promise(r => { const i2 = new Image(); i2.onload = () => r(i2); i2.onerror = () => r(null); i2.src = hu; }); if (him) { const hc = document.createElement('canvas'); hc.width = tw; hc.height = th; const hg = hc.getContext('2d'); hg.imageSmoothingEnabled = false; hg.drawImage(him, 0, 0, tw, th); const hd = hg.getImageData(0, 0, tw, th).data; for (let i = 0; i < HC.length; i++) HC[i] = Math.round(Math.pow(2, hd[i * 4] / 20) - 1); } }
      const d = g.getImageData(0, 0, tw, th).data; for (let i = 0; i < TR.length; i++) { TR[i] = d[i * 4] / 255 * 2; TP[i] = Math.max(TR[i], d[i * 4 + 1] / 255 * 2); if (meta.bu) BU[i] = d[i * 4 + 2] / 255; } } }
  let refs = (meta.refs || []).filter(Boolean), refSel = null;
  const EX = meta.exam || null;
  /* Stats: the work is counted in meta. Frames kept by the old timelapse (meta.tl) are released on the next save. */
  const TL = { refs: (meta.tl || []).slice() };
  const SS = Object.assign({ strokes: 0, mm: 0, ms: 0, dips: 0, punct: 0, blow: 0, erase: 0, needles: {}, layers: {}, since: Date.now() }, meta.stats || {});
  const hist = [], fut = [];   // undo and redo: { key, data, tr, blow } snapshots of one layer and the skin
  /* An undo step is the layer and the skin before a change. Taken whole when a stroke starts, then cut down to the
     patch the stroke touched when it ends: whole copies of a big page are ~20 MB each and could run a tablet out of
     memory. `rc`: the patch in page px (none: the whole page). */
  const state = (key, rc, hi) => rc ? { key, rc, data: L[key].getContext('2d').getImageData(rc.x, rc.y, rc.w, rc.h), hi: hi ? L.high.getContext('2d').getImageData(rc.x, rc.y, rc.w, rc.h) : null, tr: TR.slice(), tp: TP.slice(), bu: BU.slice(), blow: bx.getImageData(rc.x >> 1, rc.y >> 1, (rc.w >> 1) + 2, (rc.h >> 1) + 2) }
    : { key, data: L[key].getContext('2d').getImageData(0, 0, W, H), hi: hi ? L.high.getContext('2d').getImageData(0, 0, W, H) : null, tr: TR.slice(), tp: TP.slice(), bu: BU.slice(), blow: bx.getImageData(0, 0, blowC.width, blowC.height) };
  const cropID = (src, x, y, w, h) => { const out = new ImageData(w, h), sw = src.width;
    for (let r = 0; r < h; r++) { const from = ((y + r) * sw + x) * 4; out.data.set(src.data.subarray(from, from + w * 4), r * w * 4); } return out; };
  const cropTop = (box) => { const h = hist[hist.length - 1]; if (!h || h.rc) return;
    const x = Math.max(0, Math.floor(box.x0)), y = Math.max(0, Math.floor(box.y0)), rc = { x, y, w: Math.min(W, Math.ceil(box.x1)) - x, h: Math.min(H, Math.ceil(box.y1)) - y };
    if (rc.w <= 0 || rc.h <= 0) return;
    const bxx = x >> 1, byy = y >> 1, bw = Math.min(blowC.width - bxx, (rc.w >> 1) + 2), bh = Math.min(blowC.height - byy, (rc.h >> 1) + 2);
    h.data = cropID(h.data, rc.x, rc.y, rc.w, rc.h); if (h.hi) h.hi = cropID(h.hi, rc.x, rc.y, rc.w, rc.h); if (h.more) h.more.forEach(m => { m.data = cropID(m.data, rc.x, rc.y, rc.w, rc.h); }); h.blow = cropID(h.blow, bxx, byy, bw, bh); h.rc = rc; };
  const snap = (key, hi) => { hist.push(state(key, null, hi)); if (hist.length > 15) hist.shift(); fut.length = 0; };
  el.innerHTML = `<div class="dz-ed tt-ed">
    <div class="dz-top">
      <button class="dz-ib" id="tt-back" data-tip="Back to your pieces" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <input class="dz-name" id="tt-name" value="${esc(row.name || 'Piece')}" aria-label="Name">${CHEAT ? '<span class="tt-cheat" data-tip="Cheat mode: no skin damage, drawing helpers. Saved pictures say so.">Cheat mode</span>' : ''}<span class="dz-tsp"></span>
      <button class="dz-ib" id="tt-undo" data-tip="Undo" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
      <button class="dz-ib" id="tt-redo" data-tip="Redo" aria-label="Redo"><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg></button>
      <button class="dz-ib tt-viewb" id="tt-view" data-tip="Preview: as worked, fresh, healed or after 10 years" aria-label="Preview"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg><b></b></button>
      <button class="dz-ib" id="tt-stencilmk" data-tip="Send to the stencil maker" aria-label="Stencil maker">${ICON.stencil}</button>
      <button class="dz-ib" id="tt-fs" data-tip="Full screen" aria-label="Full screen" ${typeof FS !== 'undefined' && FS.can() ? '' : 'hidden'}></button>
      <button class="dz-ib" id="tt-pf" data-tip="Save to portfolio: fresh, healed and 10 years, with the stencil" aria-label="Save to portfolio"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15l5-5 4 4 3-3 6 6"/><path d="M12 2v6M9 5l3 3 3-3"/></svg></button>
      <button class="dz-ib" id="tt-tl" data-tip="Stats" aria-label="Stats"><svg viewBox="0 0 24 24"><path d="M5 20V11M12 20V5M19 20v-6"/></svg></button>
      <button class="dz-ib" id="tt-png" data-tip="Save as PNG" aria-label="Save as PNG"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 19h14"/></svg></button>
      <button class="dz-ib dz-go" id="tt-save" data-tip="Save" aria-label="Save"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg></button>
    </div>
    <div class="dz-body"><div class="dz-stage tt-stage" id="tt-stage"><canvas id="tt-cv"></canvas><canvas id="tt-cur"></canvas>
      <div class="dz-rail" id="tt-rail">
        <button class="dz-ib tt-needle" data-r="needles" data-tip="Needle grouping" aria-label="Needle"><b id="tt-nl"></b></button>
        <div class="tt-szq" id="tt-szq">${[[0.25, '08'], [0.3, '10'], [0.35, '12']].map(([v, n]) => `<button data-szq="${v}" data-tip="Needle size #${n} (${v} mm)" aria-label="Needle size ${n}">#${n}</button>`).join('')}</div>
        <button class="dz-ib tt-angb" data-r="angle" data-tip="Magnum angle ([ and ] turn it)" aria-label="Magnum angle" hidden><svg viewBox="0 0 24 24"><g id="tt-angi"><path d="M4 12h16" stroke-width="3"/></g></svg><b id="tt-angl"></b></button>
        <button class="dz-ib" data-r="needle" data-tip="Tattoo" aria-label="Tattoo"><svg viewBox="0 0 24 24"><path d="M4 20l5-5M9 15l8-8 2 2-8 8zM14 6l4 4"/></svg></button>
        <button class="dz-ib" data-r="marker" data-tip="Skin marker: draw freehand on the skin (its own layer). Tap again for colours, size and the spirit wipe." aria-label="Skin marker"><svg viewBox="0 0 24 24"><path d="M15 4l5 5-9 9H6v-5z"/><path d="M13 6l5 5M4 21h7"/></svg></button>
        <button class="dz-ib" data-r="erase" data-tip="Laser (erase)" aria-label="Erase"><svg viewBox="0 0 24 24"><path d="M7 21h10M5 15l9-9 5 5-9 9H8z"/></svg></button>
        <i class="sep"></i>
        <button class="dz-ib" data-r="layers" data-tip="Layers" aria-label="Layers"><svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/></svg></button>
        ${CHEAT ? `<button class="dz-ib tt-cheatb" data-r="tools" data-tip="Cheat tools: ruler, symmetry, blend, fill, shapes, lasso, fast lines" aria-label="Cheat tools"><svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg></button>` : ''}
        <button class="dz-ib" data-r="refs" data-tip="References: pictures that float over the skin to follow" aria-label="References"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="11" rx="1.5"/><path d="M8 3h13v11"/><circle cx="7.5" cy="10" r="1.5"/><path d="M16 15l-4-4-6 6"/></svg></button>
        <button class="dz-ib" data-r="feel" data-tip="Needle feel and pen calibration" aria-label="Calibration"><svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg></button>
        <i class="sep"></i>
        <div class="tt-volt" data-tip="Machine voltage for this needle: higher hits harder"><b id="tt-vl"></b><span class="tt-zwrapv"><input type="range" id="tt-vs" min="5" max="10" step="0.05" aria-label="Voltage"><i id="tt-vz" class="tt-zonev" data-tip="Green stays inside the lesson limits"></i></span></div>
      </div>
      <div class="dz-pop" id="tt-pop" hidden></div><div class="tt-refs" id="tt-refs"></div><div class="tt-guides" id="tt-guides"></div><div class="tt-exam" id="tt-exbar" hidden></div>
      <div class="tt-tray" id="tt-tray"></div>
      <div class="tt-meter" id="tt-meter" data-tip="How the needle is going in: keep each marker in the green. Too deep blows out; too slow while deep blows out; skin past the green is getting overworked."></div>
      <div class="dz-zoom tt-zoom"><button data-z="out" aria-label="Zoom out">−</button><button data-z="fit" id="tt-zl">Fit</button><button data-z="in" aria-label="Zoom in">+</button></div>
    </div><div class="dz-side" id="tt-side" hidden></div></div></div>`;
  const stage = $('#tt-stage'), cv = $('#tt-cv'), side = $('#tt-side'), pop = $('#tt-pop');
  const x = cv.getContext('2d');

  // Skin: the tone with a faint grain of pores, made once.
  const skin = document.createElement('canvas'); skin.width = W; skin.height = H;
  { const s = skin.getContext('2d'); s.fillStyle = st.skin; s.fillRect(0, 0, W, H);
    const g = document.createElement('canvas'); g.width = g.height = 128; const gx = g.getContext('2d'), id = gx.createImageData(128, 128);
    for (let i = 0; i < id.data.length; i += 4) { const v = Math.random(); id.data[i] = id.data[i + 1] = id.data[i + 2] = v > 0.5 ? 255 : 0; id.data[i + 3] = Math.random() < 0.06 ? 22 : 6; }
    gx.putImageData(id, 0, 0); s.fillStyle = s.createPattern(g, 'repeat'); s.fillRect(0, 0, W, H); }

  /* View: zoom z (1 = whole page fits) and pan (vx, vy). */
  let z = 1, vx = 0, vy = 0, k = 1, fitK = 1, frame = 0;
  const fit = () => {
    const r = stage.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
    fitK = Math.min((r.width - 72) / W, (r.height - 110) / H); k = fitK * z; paint();
  };
  /* View: the page's middle sits at C on screen, turned by st.rot and scaled by k. Two fingers move, zoom and
     turn it together (the spot under them stays put), snapping to every 90 degrees. */
  const org = () => { const r = stage.getBoundingClientRect(); return { cx: r.width / 2 + 26 + vx, cy: (r.height - 70) / 2 + vy, r }; };
  const toScreen = (p) => { const { cx, cy } = org(), c = Math.cos(st.rot), sn = Math.sin(st.rot), dx = (p.x - W / 2) * k, dy = (p.y - H / 2) * k; return { x: cx + dx * c - dy * sn, y: cy + dx * sn + dy * c }; };
  const fromScreen = (sx, sy) => { const { cx, cy } = org(), c = Math.cos(st.rot), sn = Math.sin(st.rot), dx = sx - cx, dy = sy - cy; return { x: (dx * c + dy * sn) / k + W / 2, y: (-dx * sn + dy * c) / k + H / 2 }; };
  // Put page point p under screen point (sx, sy) with the current zoom and turn.
  TT.view = { toScreen: (x, y) => toScreen({ x: x * mm, y: y * mm }) };   // page mm to stage px (used by checks)
  const pinTo = (p, sx, sy) => { const s0 = toScreen(p); vx += sx - s0.x; vy += sy - s0.y; };
  /* Previews: fresh = redness round the ink; healed = settled a little softer; 10 years = softer edges, faded
     and duller colour. Made at page size from the layers (without the stencil). */
  const viewOf = (mode) => {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'), ink = mode === 'fresh' ? composite(1, true, mode) : null;
    g.drawImage(skin, 0, 0);
    if (mode === 'fresh') {
      g.drawImage(ink, 0, 0);
      const m = document.createElement('canvas'); m.width = W; m.height = H; const mg = m.getContext('2d');
      mg.filter = `blur(${Math.max(2, mm * 2.2)}px)`; for (const key of ['light', 'mid', 'shadow', 'line']) if (!st.hide.has(key)) mg.drawImage(L[key], 0, 0);
      mg.filter = 'none'; mg.globalCompositeOperation = 'source-in'; mg.fillStyle = '#d4483e'; mg.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.8; g.drawImage(m, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    } else {
      /* Healed: overworked skin has pushed ink out and under-packed areas don't hold it, so those parts come back patchy, more of it gone the harder
         they were worked; blowouts stay for good as a soft blue-grey haze that spreads a little with the years;
         ten years settles the edges only slightly (still crisp) and dulls the colour. */
      const aged = mode === 'aged', [b, a, sat] = aged ? [0.14, 0.8, 0.72] : [0.06, 0.92, 0.92], loss = falloutMask(aged);
      g.globalCompositeOperation = 'multiply';
      g.filter = `blur(${Math.max(1, mm * (aged ? 0.9 : 0.5))}px)`; g.drawImage(blowC, 0, 0, W, H);   // blowouts: softened, never faded
      g.filter = `blur(${Math.max(1.5, mm * (aged ? 1.8 : 1.1))}px)`; g.globalAlpha = 0.6; g.drawImage(blowC, 0, 0, W, H); g.globalAlpha = 1;
      const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; const tg = tmp.getContext('2d');
      for (const key of TT_DRAW) { if (key === 'stencil' || key === 'marker' || st.hide.has(key)) continue;
        tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, W, H); tg.drawImage(L[key], 0, 0);
        if (loss) { tg.globalCompositeOperation = 'destination-out'; tg.drawImage(loss, 0, 0, W, H); }
        // white settles to a faint version of itself (still readable if packed in well); on dark skin it disappears
        const sk = ttHex(st.skin), skL = sk[0] * 0.3 + sk[1] * 0.59 + sk[2] * 0.11, wf = key === 'high' ? (aged ? 0.4 : 0.55) * Math.max(0, Math.min(1, (skL - 0.3) / 0.35)) : 1;
        g.globalCompositeOperation = key === 'high' ? 'source-over' : 'multiply'; g.globalAlpha = a * (st.op[key] ?? 1) * wf;
        g.filter = `blur(${Math.max(0.4, mm * b)}px) saturate(${sat})`; g.drawImage(tmp, 0, 0); }
      g.filter = 'none'; g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }
    return c;
  };
  /* Where overworked skin lost ink, as a mask (opaque = ink gone): nothing below swollen, then more the harder it
     was worked, broken up into blotches so it heals patchy rather than evenly lighter. The same blotches every
     time for a piece. */
  /* Solid-looking areas heal by how well they were packed: a cell with few needle hits, or far fewer than the solid
     area around it, drops out even though it looked saturated when fresh. Lines and light shading aren't affected. */
  const underPacked = () => { const out = new Float32Array(tw * th), R0 = Math.max(2, Math.round(1.5 * mm / TS)), pT = EX && exList()[EX.i], pb = pT?.pack, inBand = (x, y) => { if (!pb) return false; if (pT.circle) { const dd = Math.hypot((x + 0.5) * TS / mm - pT.circle[0], (y + 0.5) * TS / mm - pT.circle[1]); return Math.abs(dd - pT.circle[2]) < 1; } const X = (x + 0.5) * TS / mm - pb[0], Y = (y + 0.5) * TS / mm - pb[1]; return X > -1 && Y > -1 && X < pb[2] + 1 && Y < pb[3] + 1 && Math.min(X, Y, pb[2] - X, pb[3] - Y) < 1; }; let any = false;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const i = y * tw + x, h = HC[i]; if (h <= 0 || inBand(x, y)) continue; const j = (Math.min(H - 1, y * TS + 2) * W + Math.min(W - 1, x * TS + 2)) * 4; if (densAt(j) < 0.6) continue; let n = 0, on = 0, sum = 0; for (let b = Math.max(0, y - R0); b <= Math.min(th - 1, y + R0); b++) for (let a = Math.max(0, x - R0); a <= Math.min(tw - 1, x + R0); a++) { n++; const v = HC[b * tw + a]; if (v > 0) { on++; sum += v; } } if (on / n < 0.75) continue;
      const v = Math.max(Math.max(0, Math.min(1, (120 - h) / 90)) * 0.55, Math.max(0, Math.min(1, (0.65 - h / (sum / on)) / 0.35)) * 0.8) * (densAt(j) > 0.9 ? 0.4 : 1); if (v > 0) { out[i] = v; any = true; } }   // fewer passes than before count as packed, and dense, well saturated ink (a whipped-in dark corner) far less likely to drop out
    return any ? out : null; };
  const falloutMask = (aged) => { const patch = underPacked();
    let any = !!patch; if (!any) for (let i = 0; i < TP.length; i++) if (TP[i] > 0.9) { any = true; break; } if (!any) return null;
    const sev = document.createElement('canvas'); sev.width = tw; sev.height = th; const sg = sev.getContext('2d'), si = sg.createImageData(tw, th);
    for (let i = 0; i < TR.length; i++) { const v = Math.max(Math.max(0, Math.min(1, (TP[i] - 0.9) / 1.3)), patch ? patch[i] : 0); si.data[i * 4 + 3] = Math.round(Math.min(1, v * (aged ? 1.1 : 1)) * 255); }
    sg.putImageData(si, 0, 0);
    let s = (id * 2654435761) >>> 0 || 7; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const m = document.createElement('canvas'); m.width = Math.ceil(W / 2); m.height = Math.ceil(H / 2); const mg = m.getContext('2d');
    for (let i = 0, n = Math.round(m.width * m.height / 40); i < n; i++) { const r = (0.25 + rnd() * 0.9) * mm / 2;
      mg.fillStyle = `rgba(0,0,0,${0.35 + rnd() * 0.65})`; mg.beginPath(); mg.arc(rnd() * m.width, rnd() * m.height, r, 0, 7); mg.fill(); }
    mg.globalCompositeOperation = 'destination-in'; mg.imageSmoothingEnabled = true; mg.drawImage(sev, 0, 0, m.width, m.height);
    // the worst parts lose most of it, not just spots
    mg.globalCompositeOperation = 'source-over'; mg.globalAlpha = 0.55; mg.drawImage(sev, 0, 0, m.width, m.height); mg.globalAlpha = 1;
    return m;
  };
  /* The skin and every layer are composed once into `comp`; while tattooing only the patch the needle touched is
     composed again, so each frame is one picture on the screen however far it is zoomed. */
  const comp = document.createElement('canvas'); comp.width = W; comp.height = H; const cg = comp.getContext('2d');
  let compAll = true, compR = null, pen = null;
  const recomp = (x0, y0, w, h) => { cg.save(); cg.beginPath(); cg.rect(x0, y0, w, h); cg.clip(); cg.globalAlpha = 1; cg.globalCompositeOperation = 'source-over';
    cg.clearRect(x0, y0, w, h); cg.drawImage(skin, 0, 0); skinUnder(cg, true);
    for (const key of TT_DRAW) { if (st.hide.has(key)) continue;
      cg.globalAlpha = key === 'stencil' ? st.op.stencil : (st.op[key] ?? (key === 'marker' ? 0.9 : 1)); cg.globalCompositeOperation = key === 'high' ? 'source-over' : 'multiply'; cg.drawImage(L[key], 0, 0);
      if (key === 'high') cg.drawImage(L[key], 0, 0); }   // white laid twice: fresh white ink reads bright, not grey
    cg.globalAlpha = 1; cg.globalCompositeOperation = 'source-over'; skinOver(cg); if (CHEAT && st.letters?.length && !st.hide.has('stencil')) cg.drawImage(LT, 0, 0); cg.restore(); };
  const paint = (rect) => { if (rect) compR = compR ? { x0: Math.min(compR.x0, rect.x0), y0: Math.min(compR.y0, rect.y0), x1: Math.max(compR.x1, rect.x1), y1: Math.max(compR.y1, rect.y1) } : rect; else compAll = true;
    cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
    const dpr = cv.width / (stage.clientWidth || 1), { cx, cy } = org();
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.translate(cx, cy); x.rotate(st.rot); x.scale(k, k); x.translate(-W / 2, -H / 2);
    x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 24; x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.shadowBlur = 0;
    if (st.view !== 'work') { x.drawImage(skin, 0, 0); st.viewC ||= viewOf(st.view); x.drawImage(st.viewC, 0, 0); }
    else { if (trDirty && !pen) { buildTrauma(); compAll = true; }   // the skin's redness catches up when the needle lifts
      if (compAll) recomp(0, 0, W, H);
      else if (compR) { const x0 = Math.max(0, Math.floor(compR.x0)), y0 = Math.max(0, Math.floor(compR.y0)); recomp(x0, y0, Math.min(W, Math.ceil(compR.x1)) - x0 + 1, Math.min(H, Math.ceil(compR.y1)) - y0 + 1); }
      compAll = false; compR = null; x.drawImage(comp, 0, 0); }
    x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
    const deg = Math.round(((st.rot * 180 / Math.PI) % 360 + 360) % 360);
    $('#tt-zl') && ($('#tt-zl').textContent = Math.abs(z - 1) < 0.01 && !vx && !vy && !deg ? 'Fit' : Math.round(z * 100) + '%' + (deg ? ' · ' + deg + '°' : ''));
    if (CHEAT) { const vk = k + ',' + vx + ',' + vy + ',' + st.rot; if (vk !== lastVk) { lastVk = vk; placeGuides(); } }
  }); };
  const zoomAt = (nz, px, py) => { const p = fromScreen(px, py); z = Math.max(0.5, Math.min(12, nz)); k = fitK * z; pinTo(p, px, py); paint(); };
  const toPage = (e) => { const r = stage.getBoundingClientRect(); return fromScreen(e.clientX - r.left, e.clientY - r.top); };

  /* ---------- Needle engine ---------- */
  let cal = TT.cal();
  let feel = TT.feel(st.needle), lay = ttLayout(TT_NEEDLES.find(n => n.id === st.needle), feel.size);
  const curve = (p, c) => Math.pow(Math.max(0, Math.min(1, p)), Math.pow(2, Math.max(-150, Math.min(150, c)) / 50));   // c -100..100: soft (light presses go deep) .. firm (press harder)
  // The input, through the overall calibration and then the needle's feel.
  const pNorm = (ev) => ev.pointerType === 'mouse' ? 0.6 : Math.max(0, Math.min(1, ((ev.pressure || 0.5) - cal.pMin) / Math.max(0.05, cal.pMax - cal.pMin)));
  const tiltOf = (ev) => Math.max(0, Math.min(1, (Math.hypot(ev.tiltX || 0, ev.tiltY || 0) - cal.tilt0) / Math.max(10, 60 - cal.tilt0)));
  const depthOf = (pr, speed, tilt0) => { const tilt = isMag() ? 0 : tilt0, d = (feel.dMin + (feel.dMax - feel.dMin) * curve(pr, feel.pCurve + cal.curve)) * (0.8 + (volt() - 6.5) * 0.15);   // harder hits at higher voltage
    return Math.max(0.02, Math.min(1, d * (1 - Math.min(0.9, speed / 200 * feel.speedFade / 100 * cal.fade) - tilt * feel.tiltFade / 100 * 0.6))); };
  const volt = () => Math.max(4, Math.min(11, (feel.volt ?? 7) + (cal.voltOff || 0)));
  const hzOf = () => 98 * Math.pow(volt() / 7, 2.2);   // hits per second: unchanged at 7 V, and voltage counts for a lot, so 7.5 V lands dots far closer than 5 V at the same hand speed
  const gapMm = (speed) => Math.max(0.02, speed * (feel.hand / 100) * cal.hand / hzOf());   // mm between punctures
  /* Magnums hold their angle like a calligraphy nib: the row of needles stays at magAng whatever way the stroke
     goes (pulled along the row it lines; across it, it shades). With "follows the pen" the row sits across the
     way the pen leans, when it leans enough to tell. Rounds have no direction, so they follow the stroke. */
  let nk = TT_NEEDLES.find(n => n.id === st.needle)?.kind;
  const isMag = () => ['mag', 'soft'].includes(TT_NEEDLES.find(n => n.id === st.needle)?.kind);
  const rowAng = (ev) => { const tx = ev?.tiltX || 0, ty = ev?.tiltY || 0;
    return st.magTilt && Math.hypot(tx, ty) > 12 ? Math.atan2(ty, tx) + Math.PI / 2 + st.magAng * Math.PI / 180 : st.magAng * Math.PI / 180; };   // leaning: the angle is an offset on the lean
  // magFlip: the short row of a magnum leads (the rows swapped end for end), the way most artists hold one
  st.magFlip = Settings.get('tt_magflip', '1') === '1';
  const turnOf = (strokeA, ev) => isMag() ? rowAng(ev) - Math.PI / 2 + (st.magFlip ? Math.PI : 0) : strokeA;
  const pageTurn = (strokeA, ev) => turnOf(strokeA, ev) - (isMag() ? st.rot : 0);   // a magnum's angle is held on the screen, whatever the page's rotation
  const setNeedle = (id) => { st.needle = id; nk = TT_NEEDLES.find(n => n.id === id)?.kind; feel = TT.feel(id); lay = ttLayout(TT_NEEDLES.find(n => n.id === id), feel.size); $('#tt-nl').textContent = id; st.dirty = true; drawAng(); drawCur(); drawVolt(); drawSz(); };
  // Quick needle size (#08, #10, #12) under the grouping: kept with this needle's feel, the selected one lit.
  function drawSz() { try { meterBuild(); meter(lastM); } catch { /* the meter isn't built yet on the first call */ } $('#tt-szq')?.querySelectorAll('[data-szq]').forEach(b => b.classList.toggle('on', +b.dataset.szq === feel.size)); }
  $('#tt-szq').onclick = (e) => { const b = e.target.closest('[data-szq]'); if (!b) return; feel.size = +b.dataset.szq; TT.setFeel(st.needle, feel);
    lay = ttLayout(TT_NEEDLES.find(n => n.id === st.needle), feel.size); st.dirty = true; drawSz(); drawCur(); if (st.panel === 'feel') drawSide(); };
  const drawVolt = () => { const v = feel.volt ?? 7, b = TT.feelBase(st.needle).volt, vs = $('#tt-vs'); vs.min = +Math.min(b - 1.5, (EX && exList()[EX.i]?.voltMin) || 99).toFixed(2); vs.max = +(b + 1.5).toFixed(2); vs.value = v; { const z = $('#tt-vz'); if (z) { const m = TT_LIMITS.feel.volt[1], pc = (b + m - +vs.min) / (+vs.max - +vs.min) * 100; z.style.height = pc.toFixed(1) + '%'; } } $('#tt-vl').textContent = v.toFixed(1) + 'V'; };
  /* One puncture: every needle of the grouping into the skin at p (page px, `sc` px per mm), turned to angle a.
     Needle hang: a longer hang is softer (each needle lands a little off and at its own depth, and tilt spreads
     it more). Skin stretch: loose skin moves under the needles (a wobble shared by the whole puncture), takes
     ink less evenly and lets it bleed further. */
  /* Tilting a magnum: the stack rolls along its row (roll -1 to 1; the sign says which end goes down), so the end that's
     down goes deepest and the others come up out of the skin in turn. Pressure sets how many still reach: a hard edge
     feathering away, or only two or three needles for a soft guide line. A curved magnum's belly is what touches, so
     rolling it moves the deepest point along the row until it reaches the end: half of it lies flat and the rest lifts
     away, a 13CM working like a 7M. magReach gives how deep one needle goes, 0 if it misses the skin. */
  let rollNow = 0; st.magRoll = meta.magRoll ?? 0;
  /* Needle look, for every piece: thickness scales each needle's mark (and how tight a round liner's needles sit); needle
     texture is how much a magnum's separate marks show, the rest of the ink going down as a soft haze. 100 and 100 are
     how the simulator used to draw. */
  const nlook = { thin: +Settings.get('tt_thin', String(TT_LOOK.thin)) / 100, tex: +Settings.get('tt_tex', String(TT_LOOK.tex)) / 100 };
  const magReach = (nd, depth, roll) => { const tau = Math.abs(roll); if (tau < 0.01) return depth * nd.e; const s = Math.sign(roll), q = (1 - s * nd.t) / 2;
    if (nk !== 'soft') return Math.max(0, depth - tau * 1.5 * q);
    const te = Math.min(1, Math.abs(nd.t - s * tau)); return Math.max(0, depth * (0.22 + 0.78 * Math.pow(Math.cos(te * Math.PI / 2), 1.5)) - tau * 0.25 * q); };
  // The set tilt plus the way the pen is leaning along the row (leaning towards an end puts that end down).
  const setRoll = (ev, a) => { let lean = 0; if (isMag() && ev && st.magTilt) { const tx = ev.tiltX || 0, ty = ev.tiltY || 0, h = Math.hypot(tx, ty); if (h > 1) lean = tiltOf(ev) * (tx * -Math.sin(a) + ty * Math.cos(a)) / h; }
    rollNow = isMag() ? Math.max(-1, Math.min(1, (st.magRoll || 0) + lean)) : 0; };
  // Round shaders take to the skin less readily, and less again the faster they move, so packing has to be worked in rather than scrubbed.
  const wideTex = () => isMag() ? nlook.tex : 1;
  const puncture = (cx, p, a, depth, tilt0, inkC, erase, sc = mm) => {
    const mag = isMag() && !erase, tilt = mag ? 0 : tilt0, hang = (feel.hang ?? 40) / 100, loose = 1 - st.stretch / 100;
    const thin = nlook.thin, posK = nk === 'liner' || nk === 'shader' ? thin : 1, tex = wideTex(), ca = Math.cos(a), sa = Math.sin(a), sp = 1 + tilt * feel.tiltSpread / 100 * 0.8 * (0.5 + hang);
    const wide = lay.length > 4 && nk !== 'liner', rr = feel.size / 2 * sc * (wide ? 0.62 + depth * 0.45 : 0.45 + depth * 0.35) * sp * thin, flow = feel.flow / 100 * cal.flow * (nk === 'shader' && !erase ? 0.75 * (1 - 0.6 * Math.max(0, Math.min(1, ((pen?.speed || 0) - 85) / 65))) : 1), bleed = feel.bleed / 100 * (1 + loose * 0.8);
    const hit = (1 - (feel.miss / 100) * (1 - depth)) * (1 - loose * 0.15), wob = loose * 0.12, wu = (Math.random() - 0.5) * wob, wv = (Math.random() - 0.5) * wob;
    for (const nd of lay) {
      const reach = mag ? magReach(nd, depth, rollNow) : depth * nd.e, ratio = depth > 0 ? reach / depth : 0; if (mag && reach <= 0.004) continue;   // up out of the skin
      if (Math.random() > hit || (ratio < 1 && Math.random() > 0.55 + ratio * 0.45)) continue;   // shallow edge needles skip more
      const j = 0.04 + hang * 0.06, u = (nd.u * posK + wu + (Math.random() - 0.5) * j) * sc * sp, v = (nd.v * posK + wv + (Math.random() - 0.5) * j) * sc;
      const dd = Math.max(0.02, reach * (1 + (Math.random() - 0.5) * hang * 0.5));
      const px = p.x + u * -sa + v * ca, py = p.y + u * ca + v * sa, al = Math.min(1, (0.18 * ratio + dd * 0.6) * flow * inkC * (1 + (1 - thin) * 0.5)), r1 = mag ? rr * (0.55 + 0.45 * Math.min(1, ratio)) : rr;
      if (al <= 0.004) continue;
      if (tex < 1 && !erase) { put(cx, px, py, r1 * 2.6, al * (1 - tex) * 0.3, false); put(cx, px, py, r1, al * (0.25 + 0.75 * tex), false); }
      else put(cx, px, py, r1, al, erase);
      if (bleed && !erase) put(cx, px, py, r1 * 1.6, al * bleed * 0.25, false);
    }
    cx.globalAlpha = 1;
  };
  const strokeStart = (e) => {
    const key = st.layer; if (st.hide.has(key)) toast('That layer is hidden: show it to see what you draw.');
    if (key === 'stencil' && st.tool !== 'erase') { toast('The stencil layer holds a picture to trace. Load one from Layers.'); return false; }
    if (key === 'marker') { toast('The marker layer is for the skin marker: pick it on the left, or choose an ink layer in Layers.'); return false; }
    if (st.view !== 'work') { st.view = 'work'; st.viewC = null; drawView(); }
    /* White is opaque: ink with white in it (white, or a colour mixed with white) also covers the skin in the
       highlights layer as much as it is white, so a pastel is solid and bright, not a thin, see-through tint the way
       diluted ink is. */
    const wsh = st.tool !== 'erase' && INK.includes(key) && key !== 'high' ? (st.ink.w || 0) : 0;
    const c = L[key]; snap(key, wsh > 0.04); touched.add(key);
    let cx;
    if (INK.includes(key)) { const col = st.ink.c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));
      cx = { pig: true, key, col, str: st.tool === 'erase' ? 1 : (st.ink.s ?? 1), lum: (col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114) / 255, ac: col.map(v => ALOG[v]) }; }
    else { cx = c.getContext('2d'); cx.globalCompositeOperation = 'destination-out'; cx.fillStyle = '#000'; }   // the stencil: only the laser
    const p = toPage(e);
    if (EX?.cur) { if (st.tool !== 'erase') { (EX.cur.used ||= {})[st.needle] = 1; } EX.cur.strokes = (EX.cur.strokes || 0) + 1; EX.cur.t0 ||= Date.now(); EX.cur.t1 = Date.now(); }
    SS.strokes++; if (st.tool === 'erase') SS.erase++; else SS.layers[key] = (SS.layers[key] || 0) + 1;
    if (wsh > 0.04 && cx.pig) cx.alsoHi = { ...cx, key: 'high', w: wsh };
    if (EX?.cur && st.tool !== 'erase') tmStrokeStart(); pen = { cx, last: p, t: e.timeStamp, t0: e.timeStamp, carry: 0, speed: 0, a: 0, id: e.pointerId, q: [], raf: 0, foot: (Math.max(...lay.map(n => Math.hypot(n.u, n.v))) + feel.size) * mm, dw: { x: p.x, y: p.y, t: performance.now() }, s0: p };
    if (cx.pig && st.tool !== 'erase' && !CHEAT) dwellRun();
    if (st.tool !== 'erase' && st.ink.v <= 0.02) toast('Needle dry: dip in ink.', 1500);
    if (CHEAT) pen.sym = symMats();
    return true;
  };
  /* Pen moves are queued and inked once per frame, so the heavy pigment work never holds up the cursor, which is
     drawn straight away on every move (at the browser's predicted point, to cancel the screen's own delay). */
  const strokeMove = (e) => {
    const co = e.getCoalescedEvents?.(); pen.q.push(...(co?.length ? co : [e]));
    if (!pen.raf) pen.raf = requestAnimationFrame(strokeFlush);
  };
  /* Packing: how many passes land on each half millimetre of the square (so a patch shows even where it already looks
     dark), and how steady the 7RS's speed and depth stay. Scrubbing tends to show up as rushing and uneven speed. */
  /* Stats for comparing a right way against a cheat, per needle, in the hand's own millimetres on the screen so zoom
     doesn't change them. Histograms hold milliseconds spent in each bucket (TM_EDGES gives the upper limits). They only
     collect; grading reads what it needs. Saved with the attempt. */
  const TM_EDGES = { speed: [10, 25, 50, 85, 110, 150, 200, 300], gap: [0.05, 0.1, 0.2, 0.4, 0.8, 1.3, 2.2], depth: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], pressure: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], tilt: [15, 30, 45, 60], zoom: [1, 1.5, 2, 3, 5, 8], radius: [1, 2, 4, 8, 16], run: [2, 5, 10, 20, 40], stroke: [2, 5, 10, 20, 50, 100, 200] };
  const tmBin = (key, v) => { const E = TM_EDGES[key]; let i = 0; while (i < E.length && v >= E[i]) i++; return i; };
  const tmPut = (o, key, v, w) => { const h = o[key] ||= new Array(TM_EDGES[key].length + 1).fill(0); h[tmBin(key, v)] += w; };
  const tmAdd = (ev, d, dx, dy, depth, dtS) => { const c = EX.cur.tm ||= { by: {}, pauses: 0, pauseMs: 0 }, n = c.by[st.needle] ||= { ms: 0, mm: 0, strokes: 0, turn: 0, net: 0, abs: 0, cw: 0, ccw: 0, rev: 0, revDip: 0, flips: 0, n: 0, vm: 0, vs: 0, dm: 0, ds: 0, ws: 0, wa: 0, wl: 0, fs: 0, fl: 0, runL: 0 };
    const ms = Math.min(250, dtS * 1000), sc = k / (96 / 25.4), l = d * sc, v = pen.speed || 0; n.ms += ms; n.mm += l; n.n++; const a = v - n.vm; n.vm += a / n.n; n.vs += a * (v - n.vm); const b = depth - n.dm; n.dm += b / n.n; n.ds += b * (depth - n.dm);
    tmPut(n, 'speed', v, ms); tmPut(n, 'gap', gapMm(v), ms); tmPut(n, 'depth', depth, ms); tmPut(n, 'pressure', pNorm(ev), ms); tmPut(n, 'tilt', Math.hypot(ev.tiltX || 0, ev.tiltY || 0), ms); tmPut(c, 'zoom', z, ms);
    pen.tx = (pen.tx || 0) + dx * sc; pen.ty = (pen.ty || 0) + dy * sc; const sl = Math.hypot(pen.tx, pen.ty); if (sl < 0.5) return; const an = Math.atan2(pen.ty, pen.tx); pen.tx = pen.ty = 0; pen.tv = pen.tv == null ? v : pen.tv * 0.9 + v * 0.1; n.runL += sl;
    if (pen.ta != null) { let sd = an - pen.ta; while (sd > Math.PI) sd -= 2 * Math.PI; while (sd < -Math.PI) sd += 2 * Math.PI; const de = Math.abs(sd); n.turn += de; if (sd > 0) n.cw += de; else n.ccw += de; if (de > 0.02) tmPut(n, 'radius', sl / de, sl); if (de > 2.2) { n.rev++; if (v < pen.tv * 0.5) n.revDip++; }
      if (de > 0.5) { tmPut(n, 'run', n.runL, 1); n.runL = 0; }
      n.ws += sd; n.wa += de; n.wl += sl; if (n.wl >= 30) { n.net += Math.abs(n.ws); n.abs += n.wa; n.ws = n.wa = n.wl = 0; }
      n.fs += sd; n.fl += sl; if (n.fl >= 5) { const s2 = Math.sign(n.fs); if (s2 && pen.tf && s2 !== pen.tf) n.flips++; if (s2) pen.tf = s2; n.fs = n.fl = 0; } } pen.ta = an; };
  const tmStrokeEnd = () => { const c = EX?.cur?.tm, n = c?.by[st.needle]; if (!n) return; n.strokes++; tmPut(n, 'stroke', (pen.trav || 0), 1); c.lastEnd = Date.now(); const T = exList()[EX.i];
    if ((T?.linePhase || T?.lineNeedle) && pen) { const v = volt(), line = T.lineNeedle ? st.needle === T.lineNeedle : v >= T.linePhase, sk = EX.cur.sk ||= []; if (line) EX.cur.lineN = (EX.cur.lineN || 0) + 1;   // stipple: lining strokes run high, shading strokes low
      if (sk.length < 600) sk.push({ v: +v.toFixed(2), l: line ? 1 : 0, w: pen.whip ? 1 : 0, n: st.needle, s: +(pen.cx.str ?? 1).toFixed(2), mm: +(pen.trav || 0).toFixed(1), a: [+(pen.s0.x / mm).toFixed(2), +(pen.s0.y / mm).toFixed(2)], b: [+(pen.last.x / mm).toFixed(2), +(pen.last.y / mm).toFixed(2)] }); }
    if (T?.tri && pen && st.needle === T.liner) { const L2 = pen.trav || 0; EX.cur.lvS = (EX.cur.lvS || 0) + volt() * L2; EX.cur.lvL = (EX.cur.lvL || 0) + L2; EX.cur.lineV = EX.cur.lvS / Math.max(1e-6, EX.cur.lvL); }
    if (T?.maxStrokes) exBar(); };
  const tmStrokeStart = () => { const c = EX?.cur?.tm; if (c?.lastEnd) { const gap = Date.now() - c.lastEnd; if (gap > 3000) { c.pauses++; c.pauseMs += gap; } } };
  // Everything about an attempt as one block of text, to paste beside another attempt and compare.
  /* Settings moved well past their default in the direction that makes a lesson easier. Compared against the live
     defaults, so changing a default updates this too. Pen pressure and natural angle differ per tablet, so they're left
     out. Each entry: name, value, default, direction that's easier (+1 higher, -1 lower), allowed margin. This only
     reports; it doesn't change the grade. */
  const settingsCheck = (T) => { const D = TT.calDefaults, pf = TT_PROFILES.find(p => p[0] === cal.profile), hand0 = cal.handBase ?? (pf ? pf[2] : D.hand), fade0 = cal.fadeBase ?? (pf ? pf[3] : D.fade), C = TT_LIMITS.cal, L2 = TT_LIMITS.look, F = TT_LIMITS.feel, list = [['Ink flow', cal.flow, D.flow, ...C.flow], ['Hand speed', cal.hand, hand0, ...C.hand], ['Fast strokes lighten', cal.fade, fade0, ...C.fade], ['Skin toughness', cal.tough, D.tough, ...C.tough], ['Blowout sensitivity', cal.blow, D.blow, ...C.blow], ['Needle thickness', Math.round(nlook.thin * 100), TT_LOOK.thin, ...L2.thin], ['Magnum texture', Math.round(nlook.tex * 100), TT_LOOK.tex, ...L2.tex], ['Skin stretch', st.stretch, TT_STRETCH, ...L2.stretch]];
    for (const id of T.needles || [T.needle]) { const f = TT.feel(id), b = { ...TT.feelBase(id), ...T.presets?.[id], ...(id === T.needle && T.size ? { size: T.size } : {}), ...(id === T.needle && T.volt ? { volt: T.volt } : {}) }; /* what the lesson itself sets is never past the limit */ list.push([id + ' voltage', f.volt, b.volt, ...F.volt], [id + ' hand speed', f.hand, b.hand, ...F.hand], [id + ' fast strokes lighten', f.speedFade, b.speedFade, ...F.speedFade], [id + ' ink flow', f.flow, b.flow, ...F.flow], [id + ' bleed', f.bleed, b.bleed, ...F.bleed], [id + ' missed punctures', f.miss, b.miss, ...F.miss], [id + ' deepest', f.dMax, b.dMax, ...F.dMax], [id + ' lightest', f.dMin, b.dMin, ...F.dMin], [id + ' size', f.size, b.size, ...F.size]); }
    return list.filter(([, v, d, dir, m]) => (v - d) * dir > m + 1e-6).map(([name, value, def]) => ({ name, value, default: def })); };
  const tmReport = (T, res) => { const c = EX.cur || {}, tm = c.tm || { by: {} }, r1 = (v) => Math.round(v * 10) / 10, by = {}; for (const id in tm.by) { const n = tm.by[id]; by[id] = { seconds: r1(n.ms / 1000), travelMm: Math.round(n.mm), mmPerSec: r1(n.mm / Math.max(0.001, n.ms / 1000)), speedAvg: r1(n.vm), speedSd: r1(Math.sqrt(n.vs / Math.max(1, n.n))), depthAvg: +n.dm.toFixed(3), depthSd: +Math.sqrt(n.ds / Math.max(1, n.n)).toFixed(3), strokes: n.strokes, turnPerMm: +(n.turn / Math.max(1, n.mm)).toFixed(3), sameWay30mm: n.abs ? +(n.net / n.abs).toFixed(3) : null, cw: Math.round(n.cw), ccw: Math.round(n.ccw), reversalsPer10mm: +(n.rev / Math.max(1, n.mm) * 10).toFixed(3), dipReversalsPer10mm: +(n.revDip / Math.max(1, n.mm) * 10).toFixed(3), turnFlipsPer10mm: +(n.flips / Math.max(1, n.mm) * 10).toFixed(3), hist: Object.fromEntries(['speed', 'gap', 'depth', 'pressure', 'tilt', 'radius', 'run', 'stroke'].filter(k => n[k]).map(k => [k, n[k].map(Math.round)])) }; }
    let linePasses = null; if (!T.pack && T.path) { const mk = maskOf(T.path, false, 0.6), v = []; for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const px = Math.min(W - 1, x * TS + 2), py = Math.min(H - 1, y * TS + 2); if (mk[(py * W + px) * 4 + 3] > 128) v.push(HC[y * tw + x]); } if (v.length) { const s2 = [...v].sort((a, b) => a - b), m2 = v.reduce((a, b) => a + b, 0) / v.length; linePasses = { mean: r1(m2), sd: r1(Math.sqrt(v.reduce((a, b) => a + (b - m2) * (b - m2), 0) / v.length)), untouched: Math.round(v.filter(x => !x).length / v.length * 100), p10: s2[Math.floor(s2.length * 0.1)], median: s2[Math.floor(s2.length / 2)], p90: s2[Math.floor(s2.length * 0.9)], max: s2[s2.length - 1] }; } }   // hits along the stencil: going back over a line shows up as more hits
    const hm = c.hm || [], box = T.pack; let passes = null; if (box) { const v = []; for (let j = 2; j < box[3] * 2 - 2; j++) for (let i = 2; i < box[2] * 2 - 2; i++) if (!T.circle || Math.hypot(box[0] + (i + 0.5) / 2 - T.circle[0], box[1] + (j + 0.5) / 2 - T.circle[1]) < T.circle[2] - 1) v.push(hm[j * 30 + i] || 0); const s = [...v].sort((a, b) => a - b), m = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); passes = { mean: r1(m), sd: r1(Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, v.length))), min: s[0], p10: s[Math.floor(s.length * 0.1)], median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] }; }
    return { inkforge_stats: 1, artist: Settings.get('artist_name') || '', build: TT_BUILD, lesson: EX.lesson, task: T.id, when: new Date().toISOString(), grade: ttGrade(res.total), total: res.total, parts: res.parts, skin: res.skin, traumaMax: res.traumaMax, traumaAvg: res.traumaAvg, blowouts: res.blowouts, blowSpots: (c.spots || []).map(s => s[2]), maxStrokes: T.maxStrokes || null, extraStrokes: res.extraStrokes || 0, undos: res.undos || 0, lasers: res.lasers || 0, penalty: res.penalty || 0, dips: c.dips || 0, needleSeconds: r1(Object.values(tm.by).reduce((a, n) => a + n.ms, 0) / 1000), pauses: tm.pauses || 0, pauseSeconds: Math.round((tm.pauseMs || 0) / 1000), zoomHist: (tm.zoom || []).map(Math.round), passes, linePasses, tryingSettingsOf: ttTrying()?.name || null, settingsFlags: settingsCheck(T), settingsUnsaved: TT.changed(), savedSettings: TT.savedGet(), needles: by, edges: TM_EDGES, settings: { cal: { ...cal }, look: { thin: nlook.thin, tex: nlook.tex }, stretch: st.stretch, skin: st.skin, feel: JSON.parse(Settings.get('tt_feel', '{}')) }, device: { ua: navigator.userAgent, screen: [screen.width, screen.height], dpr: devicePixelRatio } }; };
  const hcAdd = (q, r) => { const R0 = Math.max(TS, r), x0 = Math.max(0, Math.floor((q.x - R0) / TS)), x1 = Math.min(tw - 1, Math.floor((q.x + R0) / TS)), y0 = Math.max(0, Math.floor((q.y - R0) / TS)), y1 = Math.min(th - 1, Math.floor((q.y + R0) / TS)); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (Math.hypot((x + 0.5) * TS - q.x, (y + 0.5) * TS - q.y) <= R0) HC[y * tw + x]++; };
  const packHit = (b, q) => { const hm = EX.cur.hm ||= new Array(900).fill(0), r = Math.max(0.3, pen.foot / mm), x = q.x / mm - b[0], y = q.y / mm - b[1]; for (let i = Math.max(0, Math.floor((x - r) * 2)); i <= Math.min(b[2] * 2 - 1, Math.floor((x + r) * 2)); i++) for (let j = Math.max(0, Math.floor((y - r) * 2)); j <= Math.min(b[3] * 2 - 1, Math.floor((y + r) * 2)); j++) if (Math.hypot((i + 0.5) / 2 - x, (j + 0.5) / 2 - y) <= r) hm[j * 30 + i]++; };
  const packMotion = (d, depth) => { const m = EX.cur.mv ||= { all: 0, fast: 0, n: 0, vm: 0, vs: 0, dm: 0, ds: 0 }, l = d / mm, v = pen.speed || 0; m.all += l; if (v > 110) m.fast += l; m.n++; const a = v - m.vm; m.vm += a / m.n; m.vs += a * (v - m.vm); const b = depth - m.dm; m.dm += b / m.n; m.ds += b * (depth - m.dm); };
  const strokeFlush = () => { if (!pen) return; pen.raf = 0; const evs = pen.q; pen.q = []; if (!evs.length) return;
    for (const ev of evs) {
      if (pen.snapped) continue;
      const p = gridPt(rulerPt(smoothPt(toPage(ev)))), dx = p.x - pen.last.x, dy = p.y - pen.last.y, d = Math.hypot(dx, dy), dt = Math.max(1, ev.timeStamp - pen.t) / 1000;
      if (d < 0.01) continue;
      const v = d * k / (96 / 25.4) / dt;   // the hand's speed on the screen, mm per second (zoom doesn't change it)
      pen.speed = pen.speed ? pen.speed * 0.7 + v * 0.3 : v; pen.a = Math.atan2(dy, dx); pen.trav = (pen.trav || 0) + d / mm;
      // fast lines: speed no longer thins the ink or spaces the punctures out; quick strokes only taper a touch
      const fast = CHEAT && st.fast,   /* the laser too: a quick sweep clears a solid path */ tilt = tiltOf(ev), depth = fast ? depthOf(pNorm(ev), Math.min(pen.speed, 15), tilt) * (1 - Math.min(0.3, pen.speed / 900)) : depthOf(pNorm(ev), pen.speed, tilt);
      if (CHEAT) { pen.dsum = (pen.dsum || 0) + depth; pen.dn = (pen.dn || 0) + 1; }
      if (st.tool !== 'erase' && pen.cx.pig && ev.pointerType !== 'mouse') {   // a mouse has no pressure to land with
        /* Landing like a plane: the needle should come in on the move and sink in gradually. Over the first mm the
           deepest point is watched; already deep while moving fast is a crash (a dark spot and sore skin there).
           A stroke that came in softly and moves fast is whip shading, which the speed meter allows for. */
        if (pen.d0 == null) { pen.d0 = pNorm(ev); pen.p0 = { ...pen.last }; }   // d0: how hard the pen first touched
        if (!pen.landed) { pen.dLand = Math.max(pen.dLand || 0, depth); if (pen.trav >= 1) { pen.landed = true; if (pen.dLand > CRASH_D && pen.speed > CRASH_V) crash(pen.p0, pen.dLand, ev); } }
        pen.whip = pen.d0 < 0.35 && pen.speed > 50; pen.dEnd = depth; pen.evEnd = ev;
      }
      if (EX?.cur && st.tool !== 'erase' && (EX.cur.n = (EX.cur.n || 0) + 1) % 3 === 0 && EX.cur.p.length < 1500) {
        EX.cur.p.push(+pNorm(ev).toFixed(3)); EX.cur.v.push(Math.round(pen.speed)); EX.cur.d.push(+depth.toFixed(3)); EX.cur.t.push(Math.round(Math.hypot(ev.tiltX || 0, ev.tiltY || 0))); }
      // punctures land every (hand speed / machine speed) along the skin; `hand` scales screen speed to a tattooing hand's
      const packB = EX?.cur && st.tool !== 'erase' && pen.cx.pig ? exList()[EX.i]?.pack : null; if (packB && st.needle === (exList()[EX.i]?.packNeedle || '7RS') && d > 0) packMotion(d, depth); if (EX?.cur && st.tool !== 'erase' && pen.cx.pig) tmAdd(ev, d, dx, dy, depth, dt);
      const gap = (fast ? Math.min(gapMm(pen.speed), 0.06) : gapMm(pen.speed)) / z * mm;
      let t = pen.carry;
      while (t <= d) {
        const q = { x: pen.last.x + dx * t / d, y: pen.last.y + dy * t / d };
        let inkC = st.tool === 'erase' ? 1 : Math.sqrt(Math.min(1, st.ink.v * 1.6)) * skinTake();
        if (st.tool !== 'erase' && pen.cx.pig) {
          const t0 = trAt(q); hcAdd(q, pen.foot); if (packB) packHit(packB, q);
          if (t0 > 1.4) inkC *= Math.max(0.3, 1 - (t0 - 1.4) * 0.6) * (Math.random() < Math.min(0.5, (t0 - 1.6) * 0.5) ? 0 : 1);   // chewed skin: patchy
          trAdd(q, pen.foot, 0.0128 * depth * depth * Math.sqrt(Math.max(0.02, gapMm(pen.speed)) / 0.1) * Math.min(2, 1.1 * mm / pen.foot) * Math.pow(volt() / 7, 2) * (isMag() ? 0.7 : 1) / ((cal.tough || 1) * TT_TOUGH));   // magnums spread each hit over more skin, so they wear it 30% less per pass   // and by the needle's width: a wide curved mag's big footprint overlaps itself far more per pass, so it no longer scars faster than a small mag   // per pass over a spot, not per hit, so widely spaced hits still wear the skin (slow passes a bit more): red in a few passes, overworked in ~10; light passes far less
          const risk = Math.max(0, Math.min(1, (0.035 - gapMm(pen.speed)) / 0.025)) * Math.max(0, Math.min(1, (depth - blowD()) / 0.15)) * (cal.blow ?? 1) * 3 * Math.pow(0.3 / blowSize(), 2);   // a normal line lands ~0.1 mm apart; slowing into a curve is fine, stalling while digging in is not
          if (risk > 0.04 && pen.trav > 1.5 && Math.random() < Math.min(1, risk)) { blowAt(q, Math.min(1, risk), pen.foot);
            if (!told.blow) { told.blow = 1; toast('Blowout: too deep, too slow.', 2500); } }
          if (t0 > 1.6 && EX?.cur && !pen.overN) { pen.overN = 1; EX.cur.over = (EX.cur.over || 0) + 1; tally(); } if (t0 > 1.6 && !told.over) { told.over = 1; toast('Overworked skin: move on.', 2500); }
        }
        if (st.tool !== 'erase' && pen.cx.pig && !CHEAT) {   // too deep or too much voltage raises little red bumps
          const bump = Math.max(0, Math.min(1, (depth - 0.85) / 0.2)) + Math.max(0, Math.min(1, (volt() - 8.2) / 1.8));
          if (bump > 0 && Math.random() < 0.12 * bump) { buAdd({ x: q.x + (Math.random() - 0.5) * pen.foot * 2, y: q.y + (Math.random() - 0.5) * pen.foot * 2 }, 0.3 * bump); SS.bumps = (SS.bumps || 0) + 1; if (EX?.cur) { EX.cur.bumps = (EX.cur.bumps || 0) + 1; tally(); }
            if (!told.bump) { told.bump = 1; toast('Red bumps: too deep or too much voltage.', 2500); } } }
        if (st.tool !== 'erase' && pen.cx.pig) pen.mt = { whip: pen.whip, depth, gap: gapMm(pen.speed), skin: Math.max(trAt(q), pen.mt?.fresh ? 0 : pen.mt?.skin || 0) };   // the most worked spot this moment
        setRoll(ev, turnOf(pen.a, ev)); st.lastD = depth;
        puncture(pen.cx, q, pageTurn(pen.a, ev), st.tool === 'erase' ? 1 : depth, tilt, inkC, st.tool === 'erase');
        if (pen.cx.alsoHi) puncture(pen.cx.alsoHi, q, pageTurn(pen.a, ev), depth, tilt, inkC * pen.cx.alsoHi.w, false);
        if (pen.sym) symPunc(q, pageTurn(pen.a, ev), st.tool === 'erase' ? 1 : depth, tilt, inkC, st.tool === 'erase');
        const bp = pen.foot * 2 + 6 * mm, B = pen.box ||= { x0: q.x, y0: q.y, x1: q.x, y1: q.y };
        B.x0 = Math.min(B.x0, q.x - bp); B.y0 = Math.min(B.y0, q.y - bp); B.x1 = Math.max(B.x1, q.x + bp); B.y1 = Math.max(B.y1, q.y + bp);
        if (st.tool !== 'erase') { if (!(CHEAT && st.endless)) st.ink.v = Math.max(0, st.ink.v - 0.000008 * lay.length * depth * feel.flow / 100); SS.punct++; }
        t += gap;
      }
      pen.carry = t - d; pen.last = p; pen.t = ev.timeStamp; if (pen.dw && Math.hypot(p.x - pen.dw.x, p.y - pen.dw.y) > 0.4 * mm) pen.dw = { x: p.x, y: p.y, t: performance.now() };
    }
    if (pen.mt) { meter(lastM = pen.mt); pen.mt.fresh = true; }
    const u = flushPig(), pad = pen.foot * 2 + 4 * mm; st.dirty = true; drawNeedleInk();
    paint(u && pen.cx.pig ? { x0: u.x0 - pad, y0: u.y0 - pad, x1: u.x1 + pad, y1: u.y1 + pad } : undefined);
  };
  /* Dwelling: the machine keeps running while the needle sits in one spot, so after a moment there it digs a hole,
     even at a good depth: the skin there is overworked in about 2 s at a normal depth (faster deeper). Any needle. */
  const dwellRun = () => { let last = performance.now(); const id = setInterval(() => { if (!pen || !pen.dw || !cv.isConnected) return clearInterval(id);
      const now = performance.now(), dt = Math.min(0.2, (now - last) / 1000); last = now; const held = (now - pen.dw.t) / 1000; if (held < 0.3) return;
      const d = st.lastD ?? 0.5; if (d < 0.15) return;
      /* Bleeding: ink held in one spot wicks out around it like a marker pressed into paper, a soft blotch that grows
         to about 1.2 mm past the needle over 6 s (after 0.35 s still), darker near the middle. Not a blowout: it sits at the surface. */
      if (st.ink.v > 0.01 && held >= 0.35) { const R = pen.foot + Math.min(1.2, (held - 0.35) * 0.2) * mm, ink = Math.sqrt(Math.min(1, st.ink.v * 1.6)) * skinTake();
        for (let n = 0; n < 6; n++) { const an = Math.random() * 6.283, rr = R * Math.sqrt(Math.random()), q = { x: pen.dw.x + Math.cos(an) * rr, y: pen.dw.y + Math.sin(an) * rr };
          dotPig(pen.cx, q.x, q.y, 0.25 * mm + Math.random() * 0.2 * mm, 0.025 * ink * (1 - 0.6 * rr / R), false); }
        const bp = R + 2 * mm, B = pen.box ||= { x0: pen.dw.x, y0: pen.dw.y, x1: pen.dw.x, y1: pen.dw.y };
        B.x0 = Math.min(B.x0, pen.dw.x - bp); B.y0 = Math.min(B.y0, pen.dw.y - bp); B.x1 = Math.max(B.x1, pen.dw.x + bp); B.y1 = Math.max(B.y1, pen.dw.y + bp);
        const u = flushPig(); if (u) paint({ x0: u.x0 - 4, y0: u.y0 - 4, x1: u.x1 + 4, y1: u.y1 + 4 }); }
      if (held < 0.3) return;
      trAdd(pen.dw, pen.foot, 0.65 * dt * Math.pow(d / 0.6, 2) * (volt() / 7) * (isMag() ? 0.7 : 1) / ((cal.tough || 1) * TT_TOUGH));
      SS.dwell = (SS.dwell || 0) + dt; if (EX?.cur) EX.cur.dwell = +((EX.cur.dwell || 0) + dt).toFixed(2);
      if (now - pen.dw.t > 900 && !told.dwell) { told.dwell = 1; toast('Keep moving: digging a hole.', 2500); } }, 100); };   // the redness shows when the needle lifts
  // A crash landing or take-off at p: the needle slams in, leaving a darker spot (a line of them along a shaded edge)
  // and working the skin hard there.
  /* Cheat mode: the stroke follows a point that trails the pen (more smoothing, more trail), so wobbles even out.
     The raw points are kept for hold to snap. */
  st.smooth ??= meta.smooth ?? CP.smooth ?? 45; st.fast = !!(meta.fast ?? CP.fast); st.endless = !!(meta.endless ?? CP.endless);
  st.ruler = meta.ruler || { on: !!CP.rulerOn, a: { x: W * 0.2, y: H * 0.5 }, b: { x: W * 0.8, y: H * 0.5 } };
  st.sym = meta.sym || { mode: CP.sym?.mode || 'off', n: CP.sym?.n || 8, mir: !!CP.sym?.mir, c: { x: W / 2, y: H / 2 } };
  const smoothPt = (p) => { if (!CHEAT) return p; const rw = pen.raw ||= [], lr = rw[rw.length - 1]; if (!lr || Math.hypot(p.x - lr.x, p.y - lr.y) > 0.5) rw.push(p);   // holding still adds nothing
    const f = 1 - Math.min(0.9, st.smooth / 100); pen.sp = pen.sp ? { x: pen.sp.x + (p.x - pen.sp.x) * f, y: pen.sp.y + (p.y - pen.sp.y) * f } : p; return pen.sp; };
  const rulerPt = (p) => { if (!CHEAT || !st.ruler.on) return p; const { a, b } = st.ruler, L = Math.hypot(b.x - a.x, b.y - a.y); if (L < 1) return p;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, t2 = (p.x - a.x) * ux + (p.y - a.y) * uy, q = { x: a.x + ux * t2, y: a.y + uy * t2 };
    if (!pen.rOff) { const ox = p.x - q.x, oy = p.y - q.y; pen.rOff = Math.hypot(ox, oy) < 8 * mm ? { x: 0, y: 0 } : { x: ox, y: oy }; }   // close to it: right on its edge
    return { x: q.x + pen.rOff.x, y: q.y + pen.rOff.y }; };
  /* Symmetry: every puncture is repeated at its mirrored or turned copies round the centre (mandala: n sections,
     optionally mirrored within each), with the needle turned to match. */
  const symMats = () => { const S = st.sym, out = [], rot = (t2) => [Math.cos(t2), -Math.sin(t2), Math.sin(t2), Math.cos(t2)];
    if (S.mode === 'mirror') out.push([-1, 0, 0, 1]);
    if (S.mode === 'quad') out.push([-1, 0, 0, 1], [1, 0, 0, -1], [-1, 0, 0, -1]);
    if (S.mode === 'mandala') for (let i = 0; i < S.n; i++) { const R = rot(Math.PI * 2 * i / S.n); if (i) out.push(R); if (S.mir) out.push([R[0] * -1, R[1], R[2] * -1, R[3]]); }
    return out.length ? out : null; };
  const symPts = (q) => { const M2 = CHEAT ? symMats() : null, c = st.sym.c; return M2 ? M2.map(M => ({ x: c.x + M[0] * (q.x - c.x) + M[1] * (q.y - c.y), y: c.y + M[2] * (q.x - c.x) + M[3] * (q.y - c.y) })) : []; };
  const symPunc = (q, a, depth, tilt, ink, erase) => { const c = st.sym.c, bp = pen.foot * 2 + 6 * mm;
    for (const M of pen.sym) { const dx = q.x - c.x, dy = q.y - c.y, q2 = { x: c.x + M[0] * dx + M[1] * dy, y: c.y + M[2] * dx + M[3] * dy };
      const ca = Math.cos(a), sa = Math.sin(a), a2 = Math.atan2(M[2] * ca + M[3] * sa, M[0] * ca + M[1] * sa);
      puncture(pen.cx, q2, a2, depth, tilt, ink, erase); if (pen.cx.alsoHi && !erase) puncture(pen.cx.alsoHi, q2, a2, depth, tilt, ink * pen.cx.alsoHi.w, false);
      const B = pen.box ||= { x0: q2.x, y0: q2.y, x1: q2.x, y1: q2.y }; B.x0 = Math.min(B.x0, q2.x - bp); B.y0 = Math.min(B.y0, q2.y - bp); B.x1 = Math.max(B.x1, q2.x + bp); B.y1 = Math.max(B.y1, q2.y + bp); } };
  /* On screen: the ruler's line with a handle at each end, and the symmetry centre (draggable) with its axes. */
  const guides = $('#tt-guides');
  function placeGuides() { if (!CHEAT) return; const hs = [];
    $('#tt-rail [data-r="tools"]')?.classList.toggle('on', ['blend', 'fill', 'shape', 'lasso', 'pick', 'liquify', 'text', 'path'].includes(st.tool) || st.grid.on || st.ruler.on || st.sym.mode !== 'off' || !!st.fast);
    $('#tt-rail [data-r="ruler"]')?.classList.toggle('on', st.ruler.on); $('#tt-rail [data-r="sym"]')?.classList.toggle('on', st.sym.mode !== 'off');
    if (st.ruler.on) hs.push(['ra', st.ruler.a], ['rb', st.ruler.b]);
    if (st.grid.on) gridVps().forEach((v, i) => hs.push(['gv' + i, v]));
    if (st.sym.mode !== 'off') hs.push(['sc', st.sym.c]);
    let sh = '';
    if (lsel) { const cs = selCorners().map(toScreen), c = toScreen(selCentre()), ang = lsel.rot + st.rot, w = lsel.b.w * lsel.s * k, h2 = lsel.b.h * lsel.s * k, top = toScreen({ x: (selCorners()[0].x + selCorners()[1].x) / 2, y: (selCorners()[0].y + selCorners()[1].y) / 2 });
      const up = { x: Math.sin(ang) * 28, y: -Math.cos(ang) * 28 };
      sh = `<div data-gh="sbody" class="tt-selb" style="left:${c.x}px;top:${c.y}px;width:${w}px;height:${h2}px;transform:translate(-50%,-50%) rotate(${ang}rad)"></div>`
        + cs.map((q, i) => `<i data-gh="sk${i}" class="lsel" style="left:${q.x}px;top:${q.y}px"></i>`).join('') + `<i data-gh="srot" class="lsel rot" style="left:${top.x + up.x}px;top:${top.y + up.y}px"></i>`
        + `<div class="tt-selbar"><button data-sa="fx">Flip ↔</button><button data-sa="fy">Flip ↕</button><button data-sa="del">Delete</button><button data-sa="undo">Cancel</button><button data-sa="ok" class="ok">Done</button></div>`; }
    const Lc = st.tool === 'text' && letCur(); if (Lc) { const Y = letLayout(ltg, Lc), c = toScreen(Lc), ang = (Lc.rot || 0) + st.rot, w = Y.w * k, h2 = Y.h * k, ca = Math.cos(ang), sa = Math.sin(ang);
      const cr = { x: c.x + (w / 2) * ca - (h2 / 2) * sa, y: c.y + (w / 2) * sa + (h2 / 2) * ca }, tp = { x: c.x + (h2 / 2 + 26) * sa, y: c.y - (h2 / 2 + 26) * ca };
      sh += `<div data-gh="lbody" class="tt-selb let" style="left:${c.x}px;top:${c.y}px;width:${w}px;height:${h2}px;transform:translate(-50%,-50%) rotate(${ang}rad)"></div><i data-gh="lsize" class="lsel" style="left:${cr.x}px;top:${cr.y}px"></i><i data-gh="lrot" class="lsel rot" style="left:${tp.x}px;top:${tp.y}px"></i>`; }
    if (st.tool === 'path' && !snapE?.live) { sh += pth.a.map((a, i) => { const q = toScreen(a); return `<i data-gh="pa${i}" class="anc ${a.c ? 'corner' : ''} ${i === 0 ? 'first' : ''}" style="left:${q.x}px;top:${q.y}px"></i>`; }).join('')
      + `<div class="tt-selbar"><button data-sa="pclose">${pth.closed ? 'Open' : 'Close'}</button><button data-sa="pback">Undo point</button><button data-sa="pclear">Clear</button>
        <label class="tt-pp" data-tip="How hard the needle goes in along the path">Pressure <input type="range" min="0.15" max="1" step="0.05" value="${st.pathP}" data-pp></label><button data-sa="papply" class="ok">Apply</button></div>`; }
    if (snapE?.live) sh += snapE.anchors.map((a, i) => { const q = toScreen(a); return `<i data-gh="an${i}" class="anc ${a.c ? 'corner' : ''}" style="left:${q.x}px;top:${q.y}px"></i>`; }).join('')
      + `<div class="tt-selbar"><span class="tt-anhint">Drag an anchor to reshape · tap it for curve or corner</span><button data-sa="snapok" class="ok">Done</button></div>`;
    guides.innerHTML = sh + hs.map(([k2, p]) => { const s = toScreen(p); return `<i data-gh="${k2}" class="${k2 === 'sc' ? 'sym' : k2[0] === 'g' ? 'vp' : ''}" style="left:${s.x}px;top:${s.y}px"></i>`; }).join('');
    drawCur(); }
  /* Grids: square, isometric, one, two and three point perspective (vanishing points draggable), and radial. In
     perspective the lines fan out from each vanishing point across the page, closer together as the grid size drops. */
  const GRID_TYPES = [['square', 'Square'], ['iso', 'Isometric'], ['p1', '1-point'], ['p2', '2-point'], ['p3', '3-point'], ['radial', 'Radial']];
  const gridVps = () => { const G = st.grid; G.vp ||= [{ x: W / 2, y: H * 0.4 }, { x: W * 0.06, y: H * 0.4 }, { x: W * 0.94, y: H * 0.4 }, { x: W / 2, y: H * 0.96 }];
    return G.type === 'p1' || G.type === 'radial' ? [G.vp[0]] : G.type === 'p2' ? [G.vp[1], G.vp[2]] : G.type === 'p3' ? [G.vp[1], G.vp[2], G.vp[3]] : []; };
  const drawGrid = () => { const G = st.grid, g = G.mm * mm, T = G.type || 'square', line = (a, b) => { const A = toScreen(a), B = toScreen(b); cux.moveTo(A.x, A.y); cux.lineTo(B.x, B.y); };
    cux.save(); { const C = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => toScreen({ x, y })); cux.beginPath(); C.forEach((q, i) => i ? cux.lineTo(q.x, q.y) : cux.moveTo(q.x, q.y)); cux.closePath(); cux.clip(); }   // only on the page
    cux.lineWidth = 1; cux.strokeStyle = 'rgba(255,255,255,.2)'; cux.beginPath();
    const span = Math.hypot(W, H) * 2;
    if (T === 'square' || T === 'p1') { for (let x = g; x < W; x += g) line({ x, y: 0 }, { x, y: H }); if (T === 'square') for (let y = g; y < H; y += g) line({ x: 0, y }, { x: W, y }); }
    if (T === 'iso') { const t30 = Math.tan(Math.PI / 6), step = g / Math.cos(Math.PI / 6);
      for (let c = -W * t30 - H; c < H + W * t30; c += step) { line({ x: 0, y: c }, { x: W, y: c + W * t30 }); line({ x: 0, y: c + W * t30 }, { x: W, y: c }); }
      for (let x = 0; x < W; x += g * Math.cos(Math.PI / 6)) line({ x, y: 0 }, { x, y: H }); }
    if (T === 'p2') for (let x = g; x < W; x += g) line({ x, y: 0 }, { x, y: H });   // uprights
    const vps = gridVps(), rays = Math.max(8, Math.min(72, Math.round(300 / G.mm)));
    if (T === 'radial') { const c = vps[0]; for (let r = g; r < span / 2; r += g) { const C = toScreen(c); cux.moveTo(C.x + r * k, C.y); cux.arc(C.x, C.y, r * k, 0, Math.PI * 2); }
      for (let i = 0; i < rays; i++) { const a = Math.PI * 2 * i / rays; line(c, { x: c.x + Math.cos(a) * span, y: c.y + Math.sin(a) * span }); } }
    else for (const v of vps) {   // a fan across the page from each vanishing point
      const ang = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.atan2(y - v.y, x - v.x)); let a0 = Math.min(...ang), a1 = Math.max(...ang);
      if (v.x > 0 && v.x < W && v.y > 0 && v.y < H) { a0 = -Math.PI; a1 = Math.PI; } else if (a1 - a0 > Math.PI) { const s = ang.map(a => a < 0 ? a + Math.PI * 2 : a); a0 = Math.min(...s); a1 = Math.max(...s); }
      for (let i = 0; i <= rays; i++) { const a = a0 + (a1 - a0) * i / rays; line(v, { x: v.x + Math.cos(a) * span, y: v.y + Math.sin(a) * span }); } }
    cux.stroke();
    if (T === 'p1' || T === 'p2') { const y = vps[0].y; cux.strokeStyle = 'rgba(255,111,97,.6)'; cux.lineWidth = 1.5; cux.beginPath(); line({ x: -W, y }, { x: W * 2, y }); cux.stroke(); }   // horizon
    cux.restore(); };
  // Lines follow the grid: once a stroke shows its direction, it runs exactly along the nearest grid direction.
  const gridPt = (p) => { const G = st.grid; if (!CHEAT || !G.on || !G.snap || !pen) return p;
    if (!pen.gs) { pen.gs = p; return p; } const s = pen.gs;
    if (!pen.gd) { if (Math.hypot(p.x - s.x, p.y - s.y) < 2.5 * mm) return p;
      const T = G.type || 'square', mv = Math.atan2(p.y - s.y, p.x - s.x), dirs = [];
      if (T === 'square' || T === 'p1') dirs.push(0, Math.PI / 2); if (T === 'p2') dirs.push(Math.PI / 2); if (T === 'iso') dirs.push(Math.PI / 6, -Math.PI / 6, Math.PI / 2);
      if (T === 'radial') { const c = gridVps()[0]; dirs.push(Math.atan2(s.y - c.y, s.x - c.x)); }
      else for (const v of gridVps()) dirs.push(Math.atan2(v.y - s.y, v.x - s.x));
      const diff = (a) => { let d = Math.abs(((mv - a) % Math.PI + Math.PI * 1.5) % Math.PI - Math.PI / 2); return d; };
      const best = dirs.reduce((b, a) => diff(a) < diff(b) ? a : b, dirs[0]); pen.gd = { x: Math.cos(best), y: Math.sin(best) }; }
    const u = pen.gd, t2 = (p.x - s.x) * u.x + (p.y - s.y) * u.y; return { x: s.x + u.x * t2, y: s.y + u.y * t2 }; };
  const drawGuides = () => { if (!CHEAT) return; const dpr = cur.width / (stage.clientWidth || 1); cux.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (st.tool === 'path' && pth.a.length > 1) { const P = pathPts(pth.a, pth.closed, 1.5 * mm).map(toScreen); cux.beginPath(); P.forEach((q, i) => i ? cux.lineTo(q.x, q.y) : cux.moveTo(q.x, q.y));
      cux.lineWidth = 3; cux.strokeStyle = 'rgba(0,0,0,.35)'; cux.stroke(); cux.lineWidth = 1.5; cux.strokeStyle = '#ff8a7a'; cux.stroke(); }
    if (st.grid.on) drawGrid();
    if (st.ruler.on) { const a = toScreen(st.ruler.a), b = toScreen(st.ruler.b), L = Math.hypot(b.x - a.x, b.y - a.y) || 1, ex = (b.x - a.x) / L * 4000, ey = (b.y - a.y) / L * 4000;
      cux.lineWidth = 6; cux.strokeStyle = 'rgba(255,111,97,.18)'; cux.beginPath(); cux.moveTo(a.x - ex, a.y - ey); cux.lineTo(b.x + ex, b.y + ey); cux.stroke();
      cux.lineWidth = 1.5; cux.strokeStyle = 'rgba(255,111,97,.9)'; cux.beginPath(); cux.moveTo(a.x - ex, a.y - ey); cux.lineTo(b.x + ex, b.y + ey); cux.stroke(); }
    const S = st.sym; if (S.mode !== 'off') { const c = toScreen(S.c), R = 3000; cux.setLineDash([6, 6]); cux.lineWidth = 1; cux.strokeStyle = 'rgba(181,138,232,.75)';
      const ray = (ang, both) => { const dx = Math.cos(ang + st.rot) * R, dy = Math.sin(ang + st.rot) * R; cux.beginPath(); cux.moveTo(both ? c.x - dx : c.x, both ? c.y - dy : c.y); cux.lineTo(c.x + dx, c.y + dy); cux.stroke(); };
      if (S.mode === 'mirror') ray(Math.PI / 2, true); else if (S.mode === 'quad') { ray(Math.PI / 2, true); ray(0, true); }
      else for (let i = 0; i < S.n; i++) ray(-Math.PI / 2 + Math.PI * 2 * i / S.n, false);
      cux.setLineDash([]); } };
  let gDrag = null;
  guides.addEventListener('pointerdown', (e) => { const h = e.target.closest('[data-gh]'); if (!h) return; e.stopPropagation(); e.preventDefault(); try { guides.setPointerCapture(e.pointerId); } catch {} gDrag = h.dataset.gh;
    if (/^l(body|size|rot)$/.test(gDrag) && letCur()) { const r = stage.getBoundingClientRect(), Lc = letCur(); gDrag = { k: gDrag, p0: fromScreen(e.clientX - r.left, e.clientY - r.top), x: Lc.x, y: Lc.y, mm: Lc.mm, rot: Lc.rot || 0 }; return; }
    if (/^pa\d+$/.test(gDrag)) { gDrag = { k: 'pa', i: +gDrag.slice(2), x: e.clientX, y: e.clientY, moved: false }; return; }
    if (snapE?.live && /^an\d+$/.test(gDrag)) { gDrag = { k: 'an', i: +gDrag.slice(2), x: e.clientX, y: e.clientY, moved: false }; return; }
    if (lsel && /^s(body|k|rot)/.test(gDrag)) { const r = stage.getBoundingClientRect(); gDrag = { k: gDrag, p0: fromScreen(e.clientX - r.left, e.clientY - r.top), tx: lsel.tx, ty: lsel.ty, s: lsel.s, rot: lsel.rot, c: selCentre() }; } });
  guides.addEventListener('click', (e) => { const a = e.target.closest('[data-sa]')?.dataset.sa; if (a === 'snapok') return snapFinish();
    if (a === 'papply') return pathApply(); if (a === 'pclose') { pth.closed = !pth.closed; return placeGuides(); } if (a === 'pback') { pth.a.pop(); if (pth.a.length < 3) pth.closed = false; return placeGuides(); } if (a === 'pclear') { pth.a = []; pth.closed = false; return placeGuides(); }
    if (!a || !lsel) return;
    if (a === 'fx') lsel.fx *= -1; if (a === 'fy') lsel.fy *= -1; if (a === 'ok') return selCommit(); if (a === 'del') return selCommit(true); if (a === 'undo') return selCancel();
    selApply(); placeGuides(); });
  guides.addEventListener('input', (e) => { if (e.target.matches('[data-pp]')) { st.pathP = +e.target.value; st.dirty = true; } });
  guides.addEventListener('pointermove', (e) => { if (!gDrag) return; const r = stage.getBoundingClientRect(), p = fromScreen(e.clientX - r.left, e.clientY - r.top), cl = { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
    if (gDrag?.k?.[0] === 'l' && gDrag.k !== 'lsel') { const Lc = letCur(); if (!Lc) return; const g = gDrag;
      if (g.k === 'lbody') { Lc.x = g.x + p.x - g.p0.x; Lc.y = g.y + p.y - g.p0.y; }
      else if (g.k === 'lsize') Lc.mm = Math.max(2, Math.round(g.mm * Math.hypot(p.x - g.x, p.y - g.y) / Math.max(1, Math.hypot(g.p0.x - g.x, g.p0.y - g.y)) * 2) / 2);
      else { let a = g.rot + Math.atan2(p.y - g.y, p.x - g.x) - Math.atan2(g.p0.y - g.y, g.p0.x - g.x); const q = Math.round(a / (Math.PI / 4)) * (Math.PI / 4); if (Math.abs(a - q) < 0.05) a = q; Lc.rot = a; }
      st.dirty = true; letDraw(); return placeGuides(); }
    if (gDrag?.k === 'pa') { if (!gDrag.moved && Math.hypot(e.clientX - gDrag.x, e.clientY - gDrag.y) < 5) return; gDrag.moved = true; pth.a[gDrag.i] = { ...pth.a[gDrag.i], x: cl.x, y: cl.y }; st.dirty = true; return placeGuides(); }
    if (gDrag?.k === 'an') { if (!snapE) return; if (!gDrag.moved && Math.hypot(e.clientX - gDrag.x, e.clientY - gDrag.y) < 5) return;
      gDrag.moved = true; snapE.moved = true; snapE.anchors[gDrag.i] = { ...snapE.anchors[gDrag.i], x: cl.x, y: cl.y };
      if (!snapRaf) snapRaf = requestAnimationFrame(() => { snapRaf = 0; renderSnap(); }); return placeGuides(); }
    if (typeof gDrag === 'object') { if (!lsel) return; const g = gDrag, c = g.c;
      if (g.k === 'sbody') { lsel.tx = g.tx + p.x - g.p0.x; lsel.ty = g.ty + p.y - g.p0.y; }
      else if (g.k === 'srot') { let a = g.rot + Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(g.p0.y - c.y, g.p0.x - c.x); const q = Math.round(a / (Math.PI / 4)) * (Math.PI / 4); if (Math.abs(a - q) < 0.05) a = q; lsel.rot = a; }
      else lsel.s = Math.max(0.05, g.s * Math.hypot(p.x - c.x, p.y - c.y) / Math.max(1, Math.hypot(g.p0.x - c.x, g.p0.y - c.y)));
      selApply(); return placeGuides(); }
    if (/^gv\d$/.test(gDrag)) { const v = gridVps()[+gDrag[2]]; if (v) { v.x = p.x; v.y = p.y; if (st.grid.type === 'p2') gridVps().forEach(o => { o.y = p.y; }); } }   // two-point: both stay on the horizon
    else if (gDrag === 'ra') st.ruler.a = cl; else if (gDrag === 'rb') st.ruler.b = cl; else st.sym.c = cl; st.dirty = true; placeGuides(); });
  for (const n of ['pointerup', 'pointercancel']) guides.addEventListener(n, (e) => { const g = gDrag; gDrag = null;
    if (g?.k === 'pa' && !g.moved && e.type === 'pointerup') { const a = pth.a[g.i]; if (g.i === 0 && pth.a.length > 2 && !pth.closed) pth.closed = true; else if (a) a.c = !a.c; return placeGuides(); }
    if (g?.k === 'an' && !g.moved && e.type === 'pointerup' && snapE) { const a = snapE.anchors[g.i]; a.c = !a.c; snapE.moved = true; renderSnap(); placeGuides(); } });
  /* The Tools menu: every cheat tool in one place (the rail stays short), each button named under its icon. */
  const TOOL_BTNS = `<button class="tt-tb" data-r="adjust" data-tip="Adjust colour: brightness, contrast, hue and more, on the whole piece or on what the lasso holds" aria-label="Adjust colour"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v16M12 4a8 8 0 0 1 0 16"/></svg></button>
        <button class="tt-tb" data-r="path" data-tip="Path: tap to place points (curves through them), tap a point for a sharp corner, then Apply to tattoo it with the needle" aria-label="Path"><svg viewBox="0 0 24 24"><path d="M4 18C8 6 16 18 20 6"/><circle cx="4" cy="18" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="20" cy="6" r="1.8"/></svg></button>
        <button class="tt-tb" data-r="place" data-tip="Place a tattoo saved to your portfolio (or any picture) into this piece, then move, size, turn and flip it" aria-label="Place tattoo"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg></button>
        <button class="tt-tb" data-r="liquify" data-tip="Liquify: push the ink around like wet paint, to nudge shapes and curves" aria-label="Liquify"><svg viewBox="0 0 24 24"><path d="M4 12c3-6 6 6 9 0s5-4 7-2"/><path d="M4 18c3-4 6 2 9-1s5-2 7-1"/><circle cx="17" cy="6" r="2"/></svg></button>
        <button class="tt-tb" data-r="text" data-tip="Lettering: tap to place text on the stencil layer, to trace" aria-label="Lettering"><svg viewBox="0 0 24 24"><path d="M5 6V4h14v2M12 4v16M9 20h6"/></svg></button><button class="tt-tb" data-r="pick" data-tip="Colour pick: tap ink in the skin to load that exact colour on the needle" aria-label="Colour pick"><svg viewBox="0 0 24 24"><path d="M14 4l6 6-2 2-6-6z"/><path d="M15 9l-9 9H4v-2l9-9"/></svg></button>
        <button class="tt-tb" data-r="grid" data-tip="Grid over the page, for lining things up" aria-label="Grid"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg></button><button class="tt-tb" data-r="ruler" data-tip="Ruler: strokes run straight along it. Drag its ends to place it." aria-label="Ruler"><svg viewBox="0 0 24 24"><path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/></svg></button>
        <button class="tt-tb" data-r="blend" data-tip="Blend: smudge and soften ink on the current layer" aria-label="Blend"><svg viewBox="0 0 24 24"><path d="M14 3l7 7-8 8a3 3 0 0 1-4 0l-3-3a3 3 0 0 1 0-4z"/><path d="M4 21c2 0 3-1 3-3"/></svg></button>
        <button class="tt-tb" data-r="fill" data-tip="Fill: tap inside an outline to pack it with the ink on the needle" aria-label="Fill"><svg viewBox="0 0 24 24"><path d="M5 11l7-7 7 7-7 7z"/><path d="M5 11h14"/><path d="M20 15s2 2.5 2 4a2 2 0 0 1-4 0c0-1.5 2-4 2-4z"/></svg></button>
        <button class="tt-tb" data-r="shape" data-tip="Shapes: drag out a line, box, ellipse, triangle or star" aria-label="Shapes"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="9" height="9" rx="1"/><circle cx="16.5" cy="7.5" r="4.5"/></svg></button>
        <button class="tt-tb" data-r="sym" data-tip="Symmetry and mandala" aria-label="Symmetry"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.2 4.2M14.2 14.2l4.2 4.2M18.4 5.6l-4.2 4.2M9.8 14.2l-4.2 4.2"/></svg></button>
        <button class="tt-tb" data-r="lasso" data-tip="Lasso: draw round part of the work to move, size, turn or flip it" aria-label="Lasso"><svg viewBox="0 0 24 24"><path d="M4 9c0-3 3.6-5 8-5s8 2 8 5-3.6 5-8 5c-1.4 0-2.7-.2-3.8-.6"/><path d="M6 13c-1.5 1-1.5 3 0 4s3 0 3-2-2-2-3-2zM6 17c0 2 1 3 2 4"/></svg></button>`;
  const TOOL_NAMES = { adjust: 'Adjust colour', path: 'Path', place: 'Place tattoo', liquify: 'Liquify', text: 'Lettering', pick: 'Colour pick', grid: 'Grid', ruler: 'Ruler', sym: 'Symmetry', blend: 'Blend', fill: 'Fill', shape: 'Shapes', lasso: 'Lasso' };
  function toolsPop(b) {
    pop.innerHTML = `<div class="gh">Cheat tools</div><div class="tt-tools">${TOOL_BTNS}</div>
      <label class="toggle" style="display:flex;margin:6px 6px 6px;border:0;min-height:30px;padding:0" data-tip="Lines come out solid however fast you pull them, like a brush: pressure still sets the width, and quick strokes taper a little."><input type="checkbox" data-fast ${st.fast ? 'checked' : ''}><span>Fast lines</span></label>
      <button class="btn small" data-toolreset style="margin:2px 6px 6px">Reset tool settings</button>
      <label class="toggle" style="display:flex;margin:0 6px 6px;border:0;min-height:30px;padding:0" data-tip="The needle never runs dry. Dipping still mixes colours as usual."><input type="checkbox" data-endless ${st.endless ? 'checked' : ''}><span>Ink never runs out</span></label>
      <div class="tt-lseg" style="flex-wrap:wrap">${GRID_TYPES.map(([k2, n2]) => `<button data-gt="${k2}" class="${(st.grid.type || 'square') === k2 && st.grid.on ? 'on' : ''}" style="flex:1 1 30%">${n2}</button>`).join('')}</div>
      <label class="toggle" style="display:flex;margin:0 6px 4px;border:0;min-height:30px;padding:0" data-tip="A line drawn with the grid on runs exactly along the nearest grid direction (towards a vanishing point in perspective)."><input type="checkbox" data-gsnap ${st.grid.snap ? 'checked' : ''}><span>Lines follow the grid</span></label>
      <label class="dz-sl" style="margin:2px 6px 6px"><span>Grid size<b id="tt-gridv">${st.grid.mm} mm</b></span><input type="range" min="2" max="30" step="1" value="${st.grid.mm}" data-gridmm></label>`;
    pop.querySelectorAll('.tt-tb').forEach(x => { const r = x.dataset.r; x.insertAdjacentHTML('beforeend', `<span>${TOOL_NAMES[r]}</span>`);
      x.classList.toggle('on', r === st.tool || (r === 'grid' && st.grid.on) || (r === 'ruler' && st.ruler.on) || (r === 'sym' && st.sym.mode !== 'off')); });
    pop.hidden = false; pop.style.top = Math.max(8, b.getBoundingClientRect().top - stage.getBoundingClientRect().top - 6) + 'px'; }
  /* ---------- Cheat tools: blend, fill and shapes ----------
     All work on the current layer with the ink on the needle, and undo like a stroke. */
  st.liq = meta.liq || CP.liq || { r: 8, s: 0.5, all: true };
  st.letters = meta.letters || []; st.letSel = null;
  st.letDef = meta.letDef || CP.letDef || { s: 'Mum', font: "'Pirata One', serif", mm: 12, sp: 0, lh: 1.15, curve: 0, bold: false, ital: false, align: 'center', mode: 'outline', ow: 0.35 };
  st.lassoAll = !!(meta.lassoAll ?? CP.lassoAll); st.grid = meta.grid || { on: false, mm: 10, ...(CP.grid || {}) }; st.blend = meta.blend || CP.blend || { r: 3, i: 0.5 }; st.fillo = meta.fillo || CP.fillo || { sten: true }; st.shape = meta.shape || CP.shape || { kind: 'rect', fill: false };
  function toolPop(b) {
    const T = st.tool, sl = (o, f, lab, min, max, step, fmt) => `<label class="dz-sl" style="margin:4px 6px"><span>${lab}<b>${fmt(st[o][f])}</b></span><input type="range" min="${min}" max="${max}" step="${step}" value="${st[o][f]}" data-tl="${o}.${f}"></label>`;
    const tg = (o, f, lab) => `<label class="toggle" style="display:flex;margin:2px 6px 6px;border:0;min-height:30px;padding:0"><input type="checkbox" data-tl="${o}.${f}" ${st[o][f] ? 'checked' : ''}><span>${lab}</span></label>`;
    pop.innerHTML = T === 'blend' ? `<div class="gh">Blend</div>${sl('blend', 'r', 'Size', 1, 15, 0.5, v => v + ' mm')}${sl('blend', 'i', 'Intensity', 0.05, 1, 0.05, v => Math.round(v * 100) + '%')}<p class="muted" style="font-size:11px;margin:2px 6px 6px">Drag over ink to smudge and soften it, on the current layer.</p>`
      : T === 'fill' ? `<div class="gh">Fill</div>${tg('fillo', 'sten', 'Stencil lines count as edges')}<p class="muted" style="font-size:11px;margin:2px 6px 6px">Tap inside an outline: it packs solid with the ink on the needle, on the current layer.</p>`
      : T === 'liquify' ? `<div class="gh">Liquify</div>${sl('liq', 'r', 'Size', 2, 30, 0.5, v => v + ' mm')}${sl('liq', 's', 'Strength', 0.1, 1, 0.05, v => Math.round(v * 100) + '%')}${tg('liq', 'all', 'Every ink layer, not just the current one')}<p class="muted" style="font-size:11px;margin:2px 6px 6px">Drag to push the ink along like wet paint.</p>`
      : T === 'text' ? `<div class="gh">Lettering</div><p class="muted" style="font-size:11px;margin:2px 6px 6px">Tap the page to add text, or tap a text to change it. It stays editable on its own lettering layer until you bake it.</p>`
      : T === 'lasso' ? `<div class="gh">Lasso</div><label class="toggle" style="display:flex;margin:2px 6px 6px;border:0;min-height:30px;padding:0"><input type="checkbox" data-lassoall ${st.lassoAll ? 'checked' : ''}><span>Every ink layer, not just the current one</span></label><p class="muted" style="font-size:11px;margin:2px 6px 6px">Draw round the part to move. Drag it, size it from a corner, turn it from the top dot, flip it, then Done.</p>`
      : `<div class="gh">Shapes</div><div class="tt-symm">${[['line', 'Line'], ['rect', 'Box'], ['ellipse', 'Ellipse'], ['tri', 'Triangle'], ['star', 'Star'], ['heart', 'Heart']].map(([k2, n]) => `<button data-shp="${k2}" class="${st.shape.kind === k2 ? 'on' : ''}">${n}</button>`).join('')}</div>${tg('shape', 'fill', 'Fill it as well')}<p class="muted" style="font-size:11px;margin:2px 6px 6px">Drag corner to corner. Lined with the current needle.</p>`;
    pop.hidden = false; pop.style.top = Math.max(8, b.getBoundingClientRect().top - stage.getBoundingClientRect().top - 6) + 'px'; }
  const inkCx = (key) => { const col = st.ink.c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));
    return { pig: true, key, col, str: st.ink.s ?? 1, lum: (col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114) / 255, ac: col.map(v => ALOG[v]) }; };
  const markDirty = (key, x0, y0, x1, y1) => { const b = dirty[key] ||= { x0, y0, x1, y1 }; b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0); b.x1 = Math.max(b.x1, x1); b.y1 = Math.max(b.y1, y1); };
  // Lay ink colour col (0-255) at strength a (0-1) into pixel i, mixing with what's there.
  const layInk = (D, i, col, a) => { const d0 = D[i + 3] / 255; if (d0 > 0.01) { const tm = a / (a + d0 * 0.6); for (let c = 0; c < 3; c++) D[i + c] = D[i + c] + (col[c] - D[i + c]) * tm; } else { D[i] = col[0]; D[i + 1] = col[1]; D[i + 2] = col[2]; }
    D[i + 3] = Math.max(D[i + 3], Math.round(a * 255)); };
  const toolLayer = () => { const key = st.layer; if (!INK.includes(key)) { toast('Pick an ink layer in Layers first (not the stencil).'); return null; }
    if (st.view !== 'work') { st.view = 'work'; st.viewC = null; drawView(); } return key; };
  let td = null;
  // Blend: each step smears the ink from just behind the brush into where it is now, softened by intensity.
  const blendStep = (a, b) => { const D = imgd[td.key].data, R = st.blend.r * mm, I = st.blend.i, dx = Math.round(b.x - a.x), dy = Math.round(b.y - a.y);
    const x0 = Math.max(0, Math.floor(b.x - R)), x1 = Math.min(W - 1, Math.ceil(b.x + R)), y0 = Math.max(0, Math.floor(b.y - R)), y1 = Math.min(H - 1, Math.ceil(b.y + R));
    if (x0 > x1 || y0 > y1) return; const ww = x1 - x0 + 1;
    const copy = new Uint8ClampedArray((ww + 2 * Math.abs(dx) + 4) * (y1 - y0 + 1 + 2 * Math.abs(dy) + 4) * 4), cx0 = x0 - Math.abs(dx) - 2, cy0 = y0 - Math.abs(dy) - 2, cw = ww + 2 * Math.abs(dx) + 4;
    for (let y = cy0; y < cy0 + (y1 - y0 + 1 + 2 * Math.abs(dy) + 4); y++) { if (y < 0 || y >= H) continue; for (let x = cx0; x < cx0 + cw; x++) { if (x < 0 || x >= W) continue; const s = (y * W + x) * 4, o = ((y - cy0) * cw + (x - cx0)) * 4; copy[o] = D[s]; copy[o + 1] = D[s + 1]; copy[o + 2] = D[s + 2]; copy[o + 3] = D[s + 3]; } }
    const at = (x, y) => { x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y)); return ((y - cy0) * cw + (x - cx0)) * 4; };
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const dd = Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) / R; if (dd >= 1) continue;
      const f = I * (1 - dd * dd), i = (y * W + x) * 4; let sr = 0, sg = 0, sb = 0, sa = 0;
      for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { const o = at(x - dx + ox, y - dy + oy), A = copy[o + 3]; sr += copy[o] * A; sg += copy[o + 1] * A; sb += copy[o + 2] * A; sa += A; }
      const ta = sa / 5, ca = D[i + 3], na = ca + (ta - ca) * f; if (na < 0.5) { D[i + 3] = 0; continue; }
      if (sa > 0) { const pr = (D[i] * ca) * (1 - f) + (sr / 5) * f, pg = (D[i + 1] * ca) * (1 - f) + (sg / 5) * f, pb = (D[i + 2] * ca) * (1 - f) + (sb / 5) * f; D[i] = pr / na; D[i + 1] = pg / na; D[i + 2] = pb / na; }
      D[i + 3] = na; }
    markDirty(td.key, x0, y0, x1, y1); const B = td.box; B.x0 = Math.min(B.x0, x0); B.y0 = Math.min(B.y0, y0); B.x1 = Math.max(B.x1, x1); B.y1 = Math.max(B.y1, y1); };
  /* ---------- Lettering ----------
     Each text is an object on the lettering layer (drawn over the work, never inked) that can be changed at any time:
     words, font (built in, the design studio's, or an imported one), size, letter spacing, line height, curve, bold,
     italic, alignment, and how it will end up: a stencil outline or solid stencil to trace, or tattooed solid or as
     an outline in the needle's ink. Bake lays it into the stencil or the current ink layer, after which it's just
     ink (one undo step). */
  const LT = document.createElement('canvas'); LT.width = W; LT.height = H; const ltg = LT.getContext('2d');
  const famCss = (f) => /[,'"]/.test(f) ? f : `"${f}"`;
  const letFont = (Lt) => `${Lt.ital ? 'italic ' : ''}${Lt.bold ? 700 : 400} ${Lt.mm * mm}px ${famCss(Lt.font)}`;
  // Each line's letters with their offsets, and the block's size (page px, before turning).
  const letLayout = (g, Lt) => { g.font = letFont(Lt); const fs = Lt.mm * mm, sp = Lt.sp * fs, lines = String(Lt.s || '').split('\n'), lh = fs * Lt.lh;
    const L2 = lines.map(line => { const ch = [...line], ws = ch.map(c => g.measureText(c).width); return { ch, ws, w: ws.reduce((a, b) => a + b, 0) + sp * Math.max(0, ch.length - 1) }; });
    const mw = Math.max(1, ...L2.map(l => l.w)), th = lh * lines.length, th0 = Lt.curve ? Math.abs(Lt.curve) / 100 * Math.PI : 0, sag = th0 ? mw / th0 * (1 - Math.cos(th0 / 2)) : 0;
    return { fs, sp, lh, lines: L2, w: mw + fs * 0.2, h: th + sag + fs * 0.2, sag }; };
  // Draws one text at its place, in its own colour (or ink: the needle's colour it was given).
  const letPaint = (g, Lt, style) => { const Y = letLayout(g, Lt), purple = 'rgba(78,40,150,.92)', ink = Lt.mode === 'ink' || Lt.mode === 'inkline';
    const col = style?.col || (ink ? Lt.col : purple), outline = Lt.mode === 'outline' || Lt.mode === 'inkline';
    g.save(); g.translate(Lt.x, Lt.y); g.rotate(Lt.rot || 0); g.font = letFont(Lt); g.textBaseline = 'middle'; g.fillStyle = col; g.strokeStyle = col; g.lineWidth = Lt.ow * mm; g.lineJoin = 'round';
    const y0 = -Y.lh * (Y.lines.length - 1) / 2 - (Lt.curve > 0 ? Y.sag / 2 : Lt.curve < 0 ? -Y.sag / 2 : 0);
    Y.lines.forEach((ln, li) => { const by = y0 + li * Y.lh, x0 = Lt.align === 'left' ? -Y.w / 2 + Y.fs * 0.1 : Lt.align === 'right' ? Y.w / 2 - Y.fs * 0.1 - ln.w : -ln.w / 2;
      const th0 = Lt.curve / 100 * Math.PI, R = Math.abs(th0) > 0.01 ? ln.w / th0 : 0; let s = 0;
      ln.ch.forEach((c, i) => { const cw = ln.ws[i], mid = x0 + s + cw / 2; g.save();
        if (R) { const phi = (mid - (x0 + ln.w / 2)) / R; g.translate(x0 + ln.w / 2 + R * Math.sin(phi), by + R - R * Math.cos(phi)); g.rotate(phi); } else g.translate(mid, by);
        g.textAlign = 'center'; outline ? g.strokeText(c, 0, 0) : g.fillText(c, 0, 0); g.restore(); s += cw + Y.sp; }); });
    g.restore(); return Y; };
  const letDraw = () => { ltg.clearRect(0, 0, W, H); for (const Lt of st.letters) letPaint(ltg, Lt); compAll = true; paint(); };
  const letHit = (Lt, p) => { const Y = letLayout(ltg, Lt), c = Math.cos(-(Lt.rot || 0)), s = Math.sin(-(Lt.rot || 0)), dx = p.x - Lt.x, dy = p.y - Lt.y;
    return Math.abs(dx * c - dy * s) < Y.w / 2 && Math.abs(dx * s + dy * c) < Y.h / 2; };
  const letCur = () => st.letters.find(l => l.id === st.letSel);
  const letFonts = () => { const out = [...TT_FONTS.map(([f, n2]) => [f, n2])];
    if (typeof DZ_FONTS !== 'undefined') for (const [n2] of DZ_FONTS) if (!out.some(o => o[1] === n2)) out.push([n2, n2]);
    if (typeof DZF !== 'undefined') for (const c of DZF.custom()) out.push([c.name, c.name + ' (yours)']); return out; };
  const letLoadFont = async (f) => { if (typeof DZF !== 'undefined' && !/[,'"]/.test(f)) await DZF.load(f); else await document.fonts.load(`400 40px ${f}`).catch(() => {}); };
  function letPanel() { const Lt = letCur(); if (!Lt) return; const b = $('#tt-rail [data-r="tools"]');
    const sl = (f, lab, min, max, step, fmt) => `<label class="dz-sl" style="margin:3px 6px"><span>${lab}<b>${fmt(Lt[f])}</b></span><input type="range" min="${min}" max="${max}" step="${step}" value="${Lt[f]}" data-lt="${f}"></label>`;
    const seg = (f, opts) => `<div class="tt-lseg">${opts.map(([v, n2]) => `<button data-lv="${f}:${v}" class="${String(Lt[f]) === String(v) ? 'on' : ''}">${n2}</button>`).join('')}</div>`;
    pop.innerHTML = `<div class="tt-letp"><div class="gh">Lettering</div>
      <textarea class="in" data-lt="s" rows="2" style="margin:2px 6px 6px;width:calc(100% - 12px);font-family:${Lt.font.replace(/"/g, "'")}">${esc(Lt.s)}</textarea>
      <div class="row" style="gap:4px;margin:0 6px 6px"><select class="in" data-lt="font" style="flex:1">${letFonts().map(([f, n2]) => `<option value="${esc(f)}" ${f === Lt.font ? 'selected' : ''}>${esc(n2)}</option>`).join('')}</select>
        ${typeof dzImportFont === 'function' ? '<button class="btn small" data-la="font">Import</button>' : ''}</div>
      ${seg('mode', [['outline', 'Stencil line'], ['solid', 'Stencil solid'], ['ink', 'Tattoo solid'], ['inkline', 'Tattoo line']])}
      ${sl('mm', 'Size', 3, 80, 0.5, v => v + ' mm')}${sl('sp', 'Letter spacing', -0.2, 1, 0.01, v => Math.round(v * 100) + '%')}${sl('lh', 'Line height', 0.7, 2.5, 0.05, v => '× ' + v)}
      ${sl('curve', 'Curve', -100, 100, 1, v => v ? (v > 0 ? 'arch ' : 'dip ') + Math.abs(v) : 'straight')}${Lt.mode === 'outline' || Lt.mode === 'inkline' ? sl('ow', 'Line width', 0.1, 2, 0.05, v => v + ' mm') : ''}
      ${seg('align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']])}
      <div class="tt-lseg"><button data-lv="bold:${!Lt.bold}" class="${Lt.bold ? 'on' : ''}" style="font-weight:800">Bold</button><button data-lv="ital:${!Lt.ital}" class="${Lt.ital ? 'on' : ''}" style="font-style:italic">Italic</button><button data-la="ink">Needle ink</button></div>
      <div class="row" style="gap:4px;margin:8px 6px 6px"><button class="btn small" data-la="del">Delete</button><button class="btn small" data-la="dup">Copy</button><span style="flex:1"></span>
        <button class="btn small primary" data-la="bake" data-tip="Lay it into the ${Lt.mode === 'outline' || Lt.mode === 'solid' ? 'stencil' : 'current ink'} layer. After this it can't be edited as text.">Bake</button></div></div>`;
    pop.hidden = false; pop.style.top = Math.max(8, (b?.getBoundingClientRect().top || 0) - stage.getBoundingClientRect().top - 6) + 'px'; }
  // Bake: the text becomes stencil or ink for good.
  const letBake = (Lt) => { const toSten = Lt.mode === 'outline' || Lt.mode === 'solid', key = toSten ? 'stencil' : st.layer;
    if (!toSten && !INK.includes(key)) return toast('Pick an ink layer in Layers to bake tattooed lettering into.');
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); const Y = letPaint(g, Lt, { col: toSten ? undefined : '#000' });
    snap(key); touched.add(key);
    if (toSten) { L.stencil.getContext('2d').drawImage(c, 0, 0); st.hide.delete('stencil'); }
    else { const M = g.getImageData(0, 0, W, H).data, D = imgd[key].data, col = ttHex(Lt.col).map(v => Math.round(v * 255)); let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (let i = 3; i < M.length; i += 4) if (M[i] > 10) { layInk(D, i - 3, col, 0.92 * M[i] / 255); const px = (i >> 2) % W, py = (i >> 2) / W | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
      if (x1 >= x0) markDirty(key, x0, y0, x1, y1); flushPig(); }
    const r = Math.hypot(Y.w, Y.h) / 2 + 4; cropTop({ x0: Lt.x - r, y0: Lt.y - r, x1: Lt.x + r, y1: Lt.y + r });
    st.letters = st.letters.filter(l => l !== Lt); st.letSel = null; st.dirty = true; closePop(); letDraw(); placeGuides();
    toast(toSten ? 'Baked into the stencil layer: trace it.' : 'Baked into the ink layer.', 1800); };
  pop.addEventListener('input', (e) => { const f = e.target.dataset?.lt, Lt = letCur(); if (!f || !Lt) return;
    Lt[f] = e.target.type === 'range' ? +e.target.value : e.target.value; if (f !== 's') st.letDef = { ...st.letDef, [f]: Lt[f] }; st.dirty = true;
    const v = e.target.closest('label')?.querySelector('b'); if (v) v.textContent = f === 'mm' || f === 'ow' ? Lt[f] + ' mm' : f === 'sp' ? Math.round(Lt[f] * 100) + '%' : f === 'lh' ? '× ' + Lt[f] : f === 'curve' ? (Lt.curve ? (Lt.curve > 0 ? 'arch ' : 'dip ') + Math.abs(Lt.curve) : 'straight') : '';
    if (f === 'font') { e.target.closest('.tt-letp').querySelector('textarea').style.fontFamily = Lt.font.replace(/"/g, "'"); letLoadFont(Lt.font).then(() => { letDraw(); placeGuides(); }); return; }
    letDraw(); placeGuides(); });
  pop.addEventListener('click', async (e) => { const Lt = letCur(); if (!Lt) return; const lv = e.target.closest('[data-lv]')?.dataset.lv, la = e.target.closest('[data-la]')?.dataset.la;
    if (lv) { const [f, v] = lv.split(':'); Lt[f] = v === 'true' ? true : v === 'false' ? false : v; st.letDef = { ...st.letDef, [f]: Lt[f] }; st.dirty = true; letDraw(); placeGuides(); return letPanel(); }
    if (la === 'del') { st.letters = st.letters.filter(l => l !== Lt); st.letSel = null; st.dirty = true; closePop(); letDraw(); return placeGuides(); }
    if (la === 'dup') { const c2 = { ...Lt, id: 'l' + Date.now().toString(36), x: Lt.x + 6 * mm, y: Lt.y + 6 * mm }; st.letters.push(c2); st.letSel = c2.id; st.dirty = true; letDraw(); placeGuides(); return letPanel(); }
    if (la === 'ink') { Lt.col = ttToHex(st.ink.v > 0.02 ? st.ink.c : [0.08, 0.08, 0.08]); st.dirty = true; letDraw(); return toast('The text takes the ink on the needle.', 1400); }
    if (la === 'bake') return letBake(Lt);
    if (la === 'font') { const n2 = await dzImportFont(); if (n2) { Lt.font = n2; st.letDef = { ...st.letDef, font: n2 }; st.dirty = true; await letLoadFont(n2); letDraw(); placeGuides(); letPanel(); } } });
  Promise.all(st.letters.map(l => letLoadFont(l.font))).then(() => letDraw());
  // Liquify: inside the brush, each pixel takes the ink from a little behind the brush's movement, strongest at the
  // centre, so the ink is pushed along with it (every chosen layer together).
  const liqStep = (a, b) => { const R = st.liq.r * mm, S = st.liq.s, dx = b.x - a.x, dy = b.y - a.y;
    const x0 = Math.max(0, Math.floor(b.x - R)), x1 = Math.min(W - 1, Math.ceil(b.x + R)), y0 = Math.max(0, Math.floor(b.y - R)), y1 = Math.min(H - 1, Math.ceil(b.y + R)); if (x0 > x1 || y0 > y1) return;
    const m = Math.ceil(Math.abs(dx) + Math.abs(dy)) + 2, cx0 = Math.max(0, x0 - m), cy0 = Math.max(0, y0 - m), cx1 = Math.min(W - 1, x1 + m), cy1 = Math.min(H - 1, y1 + m), cw = cx1 - cx0 + 1;
    for (const key of td.keys) { const D = imgd[key].data, C = new Uint8ClampedArray(cw * (cy1 - cy0 + 1) * 4);
      for (let y = cy0; y <= cy1; y++) C.set(D.subarray((y * W + cx0) * 4, (y * W + cx1 + 1) * 4), (y - cy0) * cw * 4);
      const smp = (fx, fy, c) => { fx = Math.max(cx0, Math.min(cx1, fx)); fy = Math.max(cy0, Math.min(cy1, fy)); const ix = Math.min(cx1 - 1, Math.floor(fx)), iy = Math.min(cy1 - 1, Math.floor(fy)), u = fx - ix, v = fy - iy;
        const o = (yy, xx) => ((yy - cy0) * cw + (xx - cx0)) * 4 + c; return C[o(iy, ix)] * (1 - u) * (1 - v) + C[o(iy, ix + 1)] * u * (1 - v) + C[o(iy + 1, ix)] * (1 - u) * v + C[o(iy + 1, ix + 1)] * u * v; };
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const dd = Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) / R; if (dd >= 1) continue;
        const f = S * (1 - dd * dd) ** 2, sx = x - dx * f * 1.6, sy = y - dy * f * 1.6, i = (y * W + x) * 4, A = smp(sx, sy, 3);
        if (A > 0.5) { D[i] = smp(sx, sy, 0); D[i + 1] = smp(sx, sy, 1); D[i + 2] = smp(sx, sy, 2); }
        D[i + 3] = A; }
      markDirty(key, x0, y0, x1, y1); }
    const B = td.box; B.x0 = Math.min(B.x0, x0); B.y0 = Math.min(B.y0, y0); B.x1 = Math.max(B.x1, x1); B.y1 = Math.max(B.y1, y1); };
  // Fill: everything joined to the tapped spot that isn't inside ink (or a stencil line), packed with the needle's ink.
  // ps: the tapped point, plus its symmetry copies.
  const fillAt = async (ps, key) => { if (st.ink.v <= 0.02) return toast('Needle dry: dip in ink.', 1500);
    if (st.hide.has(key)) toast('That layer is hidden: show it to see the fill.');
    const SD = st.fillo.sten ? L.stencil.getContext('2d').getImageData(0, 0, W, H).data : null, Ds = INK.map(k2 => imgd[k2].data);
    const wall = (i) => { let keep = 1; for (const E of Ds) keep *= 1 - E[i * 4 + 3] / 255; return 1 - keep > 0.35 || (SD && SD[i * 4 + 3] > 60); };
    const seen = new Uint8Array(W * H), stack = []; let n = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (const p of ps) { const sx = Math.round(p.x), sy = Math.round(p.y); if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue; const i = sy * W + sx; if (seen[i] || wall(i)) continue; seen[i] = 1; stack.push(i); }
    if (!stack.length) return toast('Tap inside an outline, not on a line.', 1800);
    while (stack.length) { const i = stack.pop(), x = i % W, y = (i - x) / W; n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && !seen[j]) { seen[j] = 1; if (wall(j)) seen[j] = 2; else stack.push(j); } }
    if (n > W * H * 0.85 && !await ask('That fills nearly the whole page (the outline may have a gap). Fill anyway?')) return;
    snap(key); touched.add(key); const D = imgd[key].data, col = inkCx(key).col, a = 0.92 * (st.ink.s ?? 1);
    for (let i = 0; i < seen.length; i++) if (seen[i]) layInk(D, i * 4, col, seen[i] === 2 ? a * 0.6 : a);   // the edge pixels too, so no skin shows along the line
    markDirty(key, Math.max(0, x0 - 1), Math.max(0, y0 - 1), Math.min(W - 1, x1 + 1), Math.min(H - 1, y1 + 1)); const u = flushPig(); cropTop({ x0: x0 - 2, y0: y0 - 2, x1: x1 + 2, y1: y1 + 2 });
    st.dirty = true; paint(u ? { x0: u.x0 - 2, y0: u.y0 - 2, x1: u.x1 + 2, y1: u.y1 + 2 } : undefined); };
  // Shapes: the outline's points (page px) for a drag from a to b.
  const shapePts = (kind, a, b) => { const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y), cx = x0 + w / 2, cy = y0 + h / 2;
    if (kind === 'line') return [a, b];
    if (kind === 'rect') return [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }, { x: x0, y: y0 }];
    if (kind === 'tri') return [{ x: cx, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }, { x: cx, y: y0 }];
    const out = [];
    if (kind === 'ellipse') for (let i = 0; i <= 96; i++) { const t2 = Math.PI * 2 * i / 96; out.push({ x: cx + Math.cos(t2) * w / 2, y: cy + Math.sin(t2) * h / 2 }); }
    if (kind === 'star') for (let i = 0; i <= 10; i++) { const t2 = -Math.PI / 2 + Math.PI * i / 5, r = i % 2 ? 0.42 : 1; out.push({ x: cx + Math.cos(t2) * w / 2 * r, y: cy + Math.sin(t2) * h / 2 * r }); }
    if (kind === 'heart') for (let i = 0; i <= 120; i++) { const t2 = Math.PI * 2 * i / 120, hx = 16 * Math.sin(t2) ** 3, hy = -(13 * Math.cos(t2) - 5 * Math.cos(2 * t2) - 2 * Math.cos(3 * t2) - Math.cos(4 * t2)); out.push({ x: cx + hx / 32 * w, y: cy + (hy + 2.5) / 30 * h }); }
    return out; };
  const shapeCommit = (a, b) => { const key = toolLayer(); if (!key) return; if (st.ink.v <= 0.02) return toast('Needle dry: dip in ink.', 1500);
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1.5 * mm) return;
    const P = shapePts(st.shape.kind, a, b), wsh = key !== 'high' ? (st.ink.w || 0) : 0, cx = inkCx(key); if (wsh > 0.04) cx.alsoHi = { ...cx, key: 'high', w: wsh };
    snap(key, wsh > 0.04); touched.add(key); SS.strokes++;
    pen = { cx, foot: (Math.max(...lay.map(n => Math.hypot(n.u, n.v))) + feel.size) * mm, sym: symMats(), box: null, id: -1 };
    if (st.shape.fill && st.shape.kind !== 'line') {   // the inside, packed (with its symmetry copies)
      const m = document.createElement('canvas'); m.width = W; m.height = H; const mg = m.getContext('2d'); mg.fillStyle = '#000';
      const poly = (Q) => { mg.beginPath(); Q.forEach((q, i) => i ? mg.lineTo(q.x, q.y) : mg.moveTo(q.x, q.y)); mg.closePath(); mg.fill(); };
      poly(P); for (const M of pen.sym || []) { const c = st.sym.c; poly(P.map(q => ({ x: c.x + M[0] * (q.x - c.x) + M[1] * (q.y - c.y), y: c.y + M[2] * (q.x - c.x) + M[3] * (q.y - c.y) }))); }
      const MD = mg.getImageData(0, 0, W, H).data, D = imgd[key].data, aa = 0.92 * (st.ink.s ?? 1); let fx0 = W, fy0 = H, fx1 = 0, fy1 = 0;
      for (let i = 3; i < MD.length; i += 4) if (MD[i] > 20) { layInk(D, i - 3, cx.col, aa * MD[i] / 255); const px = (i >> 2) % W, py = ((i >> 2) - px) / W; if (px < fx0) fx0 = px; if (px > fx1) fx1 = px; if (py < fy0) fy0 = py; if (py > fy1) fy1 = py; }
      if (fx1 >= fx0) { markDirty(key, fx0, fy0, fx1, fy1); pen.box = { x0: fx0, y0: fy0, x1: fx1, y1: fy1 }; } }
    const depth = depthOf(0.6, 20, 0), ink = Math.sqrt(Math.min(1, st.ink.v * 1.6)) * skinTake(), bp = pen.foot * 2 + 6 * mm, step = 0.08 * mm;
    for (let s = 1; s < P.length; s++) { const A = P[s - 1], B2 = P[s], n = Math.max(1, Math.ceil(Math.hypot(B2.x - A.x, B2.y - A.y) / step)), ang = Math.atan2(B2.y - A.y, B2.x - A.x);
      for (let i = 0; i <= n; i++) { const q = { x: A.x + (B2.x - A.x) * i / n, y: A.y + (B2.y - A.y) * i / n };
        puncture(cx, q, ang, depth, 0, ink, false); if (cx.alsoHi) puncture(cx.alsoHi, q, ang, depth, 0, ink * wsh, false); if (pen.sym) symPunc(q, ang, depth, 0, ink, false);
        const BB = pen.box ||= { x0: q.x, y0: q.y, x1: q.x, y1: q.y }; BB.x0 = Math.min(BB.x0, q.x - bp); BB.y0 = Math.min(BB.y0, q.y - bp); BB.x1 = Math.max(BB.x1, q.x + bp); BB.y1 = Math.max(BB.y1, q.y + bp); } }
    const u = flushPig(); cropTop(pen.box); pen = null; st.dirty = true; paint(u ? { x0: u.x0 - 4 * mm, y0: u.y0 - 4 * mm, x1: u.x1 + 4 * mm, y1: u.y1 + 4 * mm } : undefined); };
  const toolDown = (e) => { const p = toPage(e);
    if (st.tool === 'text') { const hit = [...st.letters].reverse().find(Lt => letHit(Lt, p));
      if (hit) { st.letSel = hit.id; } else { const Lt = { id: 'l' + Date.now().toString(36), ...st.letDef, x: p.x, y: p.y, rot: 0, col: ttToHex(st.ink.v > 0.02 ? st.ink.c : [0.08, 0.08, 0.08]) }; st.letters.push(Lt); st.letSel = Lt.id; }
      st.dirty = true; letDraw(); placeGuides(); return letPanel(); }
    if (st.tool === 'liquify') { const keys = st.liq.all ? INK.filter(k2 => !st.hide.has(k2)) : [toolLayer()]; if (!keys[0]) return;
      const h = state(keys[0]); h.more = keys.slice(1).map(k2 => ({ key: k2, data: L[k2].getContext('2d').getImageData(0, 0, W, H) })); hist.push(h); if (hist.length > 15) hist.shift(); fut.length = 0;
      keys.forEach(k2 => touched.add(k2)); td = { kind: 'liq', keys, id: e.pointerId, last: p, box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } }; return; }
    if (st.tool === 'pick') {   // the ink at that spot, all layers mixed as they show
      const x = Math.round(p.x), y = Math.round(p.y); if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; let r = 0, g = 0, b = 0, w = 0, keep = 1;
      for (const key of INK) { const D = imgd[key].data, a = D[i + 3] / 255; if (!a) continue; r += D[i] * a; g += D[i + 1] * a; b += D[i + 2] * a; w += a; keep *= 1 - a; }
      if (!w) return toast('No ink there to pick up.', 1500);
      const c = [r / w / 255, g / w / 255, b / w / 255]; st.ink = { c, v: 1, s: Math.max(0.15, Math.min(1, (1 - keep) * 1.1)), w: Math.min(...c) > 0.85 ? 1 : 0 }; st.dirty = true; drawNeedleInk();
      st.tool = 'needle'; sel(); placeGuides(); return toast('Picked up that colour: the needle is loaded.', 1600); }
    if (st.tool === 'path') { if (pth.a.length > 2 && !pth.closed) { const f = toScreen(pth.a[0]), r = stage.getBoundingClientRect(); if (Math.hypot(f.x - (e.clientX - r.left), f.y - (e.clientY - r.top)) < 16) { pth.closed = true; return placeGuides(); } }
      if (pth.closed) return; pth.a.push({ x: p.x, y: p.y, c: false }); return placeGuides(); }
    if (st.tool === 'lasso') { if (lsel) selCommit(); td = { kind: 'lasso', id: e.pointerId, pts: [p] }; return; }
    if (st.tool === 'fill') { const key = toolLayer(); if (key) fillAt([p, ...symPts(p)], key); return; }
    if (st.tool === 'shape') { td = { kind: 'shape', id: e.pointerId, a: p, b: p }; return drawCur(e); }
    const key = toolLayer(); if (!key) return; snap(key); touched.add(key); td = { kind: 'blend', key, id: e.pointerId, last: p, box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } }; };
  const toolMove = (e) => { const p = toPage(e);
    if (td.kind === 'lasso') { const l = td.pts[td.pts.length - 1]; if (Math.hypot(p.x - l.x, p.y - l.y) > 2) td.pts.push(p); return drawCur(e); }
    if (td.kind === 'shape') { td.b = p; return; }
    if (td.kind === 'liq') { const d = Math.hypot(p.x - td.last.x, p.y - td.last.y), stp = Math.max(1, st.liq.r * mm / 5), n = Math.ceil(d / stp);
      for (let i = 1; i <= n; i++) { const a = { x: td.last.x + (p.x - td.last.x) * (i - 1) / n, y: td.last.y + (p.y - td.last.y) * (i - 1) / n }, b = { x: td.last.x + (p.x - td.last.x) * i / n, y: td.last.y + (p.y - td.last.y) * i / n };
        liqStep(a, b); const sa = symPts(a), sb = symPts(b); sa.forEach((q, j) => liqStep(q, sb[j])); }
      td.last = p; const u = flushPig(); st.dirty = true; if (u) paint({ x0: u.x0 - 2, y0: u.y0 - 2, x1: u.x1 + 2, y1: u.y1 + 2 }); return; }
    const d = Math.hypot(p.x - td.last.x, p.y - td.last.y), stp = Math.max(1, st.blend.r * mm / 3), n = Math.ceil(d / stp);
    for (let i = 1; i <= n; i++) { const a = { x: td.last.x + (p.x - td.last.x) * (i - 1) / n, y: td.last.y + (p.y - td.last.y) * (i - 1) / n }, b = { x: td.last.x + (p.x - td.last.x) * i / n, y: td.last.y + (p.y - td.last.y) * i / n }; blendStep(a, b); const sa = symPts(a), sb = symPts(b); sa.forEach((q, j) => blendStep(q, sb[j])); }
    td.last = p; const u = flushPig(); st.dirty = true; if (u) paint({ x0: u.x0 - 2, y0: u.y0 - 2, x1: u.x1 + 2, y1: u.y1 + 2 }); };
  const toolUp = () => { const t0 = td; td = null; if (!t0) return;
    if (t0.kind === 'lasso') { if (t0.pts.length > 6) liftSel(t0.pts); return drawCur(); }
    if (t0.kind === 'shape') { shapeCommit(t0.a, t0.b); return drawCur(); }
    if (t0.kind === 'liq') { const B = t0.box, pad = st.liq.r * mm + 4; cropTop({ x0: B.x0 - pad, y0: B.y0 - pad, x1: B.x1 + pad, y1: B.y1 + pad }); return; }
    const B = t0.box, pad = st.blend.r * mm + 2; cropTop({ x0: B.x0 - pad, y0: B.y0 - pad, x1: B.x1 + pad, y1: B.y1 + pad }); };
  /* Lasso: draw round part of the work; it lifts off its layer (or every ink layer) and floats, to drag, size from a
     corner, turn from the top dot or flip, then Done puts it down (one undo step). Tapping elsewhere also puts it down. */
  let lsel = null;
  const selCentre = () => ({ x: lsel.b.x + lsel.b.w / 2 + lsel.tx, y: lsel.b.y + lsel.b.h / 2 + lsel.ty });
  const selCorners = () => { const c = selCentre(), ca = Math.cos(lsel.rot), sa = Math.sin(lsel.rot), hw = lsel.b.w / 2 * lsel.s, hh = lsel.b.h / 2 * lsel.s;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca })); };
  let selRaf = 0;
  const selApply = () => { if (selRaf) return; selRaf = requestAnimationFrame(() => { selRaf = 0; if (!lsel) return; const c = selCentre();
    let x0 = W, y0 = H, x1 = 0, y1 = 0; for (const q of selCorners()) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const now = { x0: Math.max(0, Math.floor(x0) - 2), y0: Math.max(0, Math.floor(y0) - 2), x1: Math.min(W, Math.ceil(x1) + 2), y1: Math.min(H, Math.ceil(y1) + 2) }, was = lsel.last || now;
    const R = { x0: Math.min(now.x0, was.x0), y0: Math.min(now.y0, was.y0), x1: Math.max(now.x1, was.x1), y1: Math.max(now.y1, was.y1) }; lsel.last = now;
    for (const key of lsel.keys) { const g = L[key].getContext('2d'); g.putImageData(lsel.base[key], 0, 0, R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0);   // only where it was and is g.save(); g.translate(c.x, c.y); g.rotate(lsel.rot); g.scale(lsel.s * lsel.fx, lsel.s * lsel.fy);
      g.imageSmoothingQuality = 'high'; g.drawImage(lsel.fl[key], -lsel.b.w / 2, -lsel.b.h / 2); g.restore(); }
    st.dirty = true; paint(R); }); };
  const liftSel = (poly) => {
    let x0 = W, y0 = H, x1 = 0, y1 = 0; for (const q of poly) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1)); const bw = x1 - x0, bh = y1 - y0;
    if (bw < 4 || bh < 4) return;
    const keys = st.lassoAll ? INK.filter(k2 => !st.hide.has(k2)) : [st.layer];   // the stencil layer works too (e.g. lettering)
    const m = document.createElement('canvas'); m.width = bw; m.height = bh; const mg = m.getContext('2d'); mg.beginPath(); poly.forEach((q, i) => i ? mg.lineTo(q.x - x0, q.y - y0) : mg.moveTo(q.x - x0, q.y - y0)); mg.closePath(); mg.fill();
    const M = mg.getImageData(0, 0, bw, bh).data; let any = false;
    const h = state(keys[0]); h.more = keys.slice(1).map(k2 => ({ key: k2, data: L[k2].getContext('2d').getImageData(0, 0, W, H) })); hist.push(h); if (hist.length > 15) hist.shift(); fut.length = 0;
    const base = {}, fl = {};
    for (const key of keys) { const D = INK.includes(key) ? imgd[key].data : L[key].getContext('2d').getImageData(0, 0, W, H).data, f = new ImageData(bw, bh), F = f.data;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const mi = (y * bw + x) * 4 + 3, a = M[mi] / 255; if (!a) continue; const i = ((y + y0) * W + x + x0) * 4, o = (y * bw + x) * 4;
        if (D[i + 3]) any = true; F[o] = D[i]; F[o + 1] = D[i + 1]; F[o + 2] = D[i + 2]; F[o + 3] = D[i + 3] * a; D[i + 3] = D[i + 3] * (1 - a); }
      const c = document.createElement('canvas'); c.width = bw; c.height = bh; c.getContext('2d').putImageData(f, 0, 0); fl[key] = c;
      base[key] = new ImageData(new Uint8ClampedArray(D), W, H); touched.add(key); }
    if (!any) { hist.pop(); for (const key of keys) syncIn(key); return toast('Nothing inside that lasso on ' + (st.lassoAll ? 'the ink layers.' : 'this layer.'), 1800); }
    lsel = { keys, base, fl, b: { x: x0, y: y0, w: bw, h: bh }, tx: 0, ty: 0, s: 1, rot: 0, fx: 1, fy: 1, poly };
    selApply(); placeGuides(); };
  function keepPrefs() {
    Settings.set('tt_mk', JSON.stringify({ col: st.mk.col, r: st.mk.r }));
    if (CHEAT) Settings.set('tt_cheat_prefs', JSON.stringify({ smooth: st.smooth, fast: st.fast, endless: st.endless, rulerOn: st.ruler.on, sym: { mode: st.sym.mode, n: st.sym.n, mir: st.sym.mir },
      grid: { on: st.grid.on, mm: st.grid.mm, type: st.grid.type, snap: st.grid.snap }, liq: st.liq, letDef: st.letDef, lassoAll: st.lassoAll, blend: st.blend, fillo: st.fillo, shape: st.shape, pathP: st.pathP })); }
  // Back to the defaults: the marker and magnum settings, and (in cheat mode) every cheat tool, here and for new pieces.
  async function resetTools() { if (!await ask('Put the tool settings back to the defaults?\n\nThe marker, the magnum angle' + (CHEAT ? ' and every cheat tool (smoothing, fast lines, endless ink, grid, symmetry, ruler and the rest)' : '') + '. Your work is not changed.')) return;
    await Settings.set('tt_mk', ''); await Settings.set('tt_magflip', '1'); st.mk = { col: MK_COLS[0], r: 0.6, wipe: false }; st.magAng = 75; st.magTilt = true; st.magFlip = true;
    if (CHEAT) { await Settings.set('tt_cheat_prefs', '{}'); Object.assign(st, { smooth: 45, fast: false, endless: false, lassoAll: false, pathP: 0.6, blend: { r: 3, i: 0.5 }, fillo: { sten: true }, shape: { kind: 'rect', fill: false }, liq: { r: 8, s: 0.5, all: true } });
      st.ruler.on = false; Object.assign(st.sym, { mode: 'off', n: 8, mir: false, c: { x: W / 2, y: H / 2 } }); st.grid = { on: false, mm: 10 }; }
    st.dirty = true; closePop(); drawAng(); meterBuild(); meter(lastM); placeGuides(); drawCur(); toast('Tool settings are back to the defaults.', 1800); }
  /* ---------- Adjust colour ----------
     Exposure, brightness, contrast, gamma, saturation, vibrance, temperature, tint and hue on the ink: the whole
     piece (every shown ink layer), or only what the lasso is holding. Only the colour of ink already in the skin
     changes, never where it is or how much is there, and colours are kept to what inks can be (no glowing,
     over-saturated or skin-lighter-than-skin results), so it stays a tattoo. Previewed live; Apply is one undo step. */
  let adjS = null;
  const ADJ = [['exp', 'Exposure', -2, 2, 0.05, v => (v > 0 ? '+' : '') + (+v).toFixed(2)], ['bri', 'Brightness', -1, 1, 0.02], ['con', 'Contrast', -1, 1, 0.02], ['gam', 'Gamma', 0.3, 3, 0.05, v => (+v).toFixed(2)],
    ['sat', 'Saturation', -1, 1, 0.02], ['vib', 'Vibrance', -1, 1, 0.02], ['tmp', 'Temperature', -1, 1, 0.02], ['tin', 'Tint', -1, 1, 0.02], ['hue', 'Hue', -180, 180, 1, v => Math.round(v) + '°']];
  const ADJ0 = { exp: 0, bri: 0, con: 0, gam: 1, sat: 0, vib: 0, tmp: 0, tin: 0, hue: 0 };
  function adjOpen(b) {
    if (adjS) adjEnd(false);
    const sel = !!lsel, keys = sel ? lsel.keys : INK.filter(k2 => !st.hide.has(k2)), T = [];
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (const key of keys) { const id = sel ? lsel.fl[key].getContext('2d').getImageData(0, 0, lsel.fl[key].width, lsel.fl[key].height) : imgd[key], D = id.data, ix = [];
      for (let i = 3; i < D.length; i += 4) if (D[i]) { ix.push(i - 3); if (!sel) { const p = (i - 3) >> 2, x = p % W, y = (p - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
      if (ix.length) T.push({ key, id, orig: new Uint8ClampedArray(D), ix: Uint32Array.from(ix) }); }
    if (!T.length) return toast(sel ? 'Nothing in the lasso to adjust.' : 'No ink to adjust yet.');
    let h = null; if (!sel) { h = state(T[0].key); h.more = T.slice(1).map(o => ({ key: o.key, data: L[o.key].getContext('2d').getImageData(0, 0, W, H) })); }
    adjS = { sel, T, h, v: { ...ADJ0 }, box: { x0, y0, x1, y1 }, raf: 0 };
    const f2 = (v) => Math.round(v * 100) + '%';
    pop.innerHTML = `<div class="tt-letp"><div class="gh">Adjust colour · ${sel ? 'the lasso' : 'whole piece'}</div>
      ${ADJ.map(([k2, n2, mn, mx, s2, fm]) => `<label class="dz-sl" style="margin:3px 6px"><span>${n2}<b>${(fm || f2)(ADJ0[k2])}</b></span><input type="range" min="${mn}" max="${mx}" step="${s2}" value="${ADJ0[k2]}" data-adj="${k2}"></label>`).join('')}
      <div class="row" style="gap:4px;margin:8px 6px 6px"><button class="btn small" data-adja="reset">Reset</button><button class="btn small" data-adja="cancel">Cancel</button><span style="flex:1"></span><button class="btn small primary" data-adja="apply">Apply</button></div>
      <p class="muted" style="font-size:11px;margin:2px 6px 6px">${sel ? 'Only the lassoed part changes.' : 'For one area, lasso it first, then open this.'} Ink only changes colour: nothing spreads or appears.</p></div>`;
    pop.hidden = false; pop.style.top = '8px'; }   // a tall panel: from the top, so the piece shows beside it
  // One colour through every adjustment, then held to what ink can look like.
  const adjCol = (r, g, b, V, hc, hs) => {
    const ex = Math.pow(2, V.exp); r *= ex; g *= ex; b *= ex;
    r += V.bri * 0.5; g += V.bri * 0.5; b += V.bri * 0.5;
    const ck = 1 + V.con; r = (r - 0.5) * ck + 0.5; g = (g - 0.5) * ck + 0.5; b = (b - 0.5) * ck + 0.5;
    r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b); if (V.gam !== 1) { const gi = 1 / V.gam; r = r ** gi; g = g ** gi; b = b ** gi; }
    if (V.hue) { const y = 0.299 * r + 0.587 * g + 0.114 * b, i = 0.596 * r - 0.274 * g - 0.322 * b, q = 0.211 * r - 0.523 * g + 0.312 * b, i2 = i * hc - q * hs, q2 = i * hs + q * hc;
      r = y + 0.956 * i2 + 0.621 * q2; g = y - 0.272 * i2 - 0.647 * q2; b = y - 1.106 * i2 + 1.703 * q2; }
    let l = 0.299 * r + 0.587 * g + 0.114 * b; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s0 = mx > 0 ? (mx - mn) / mx : 0;
    const sk = (1 + V.sat) * (1 + V.vib * (1 - s0)); r = l + (r - l) * sk; g = l + (g - l) * sk; b = l + (b - l) * sk;
    r += V.tmp * 0.12; b -= V.tmp * 0.12; g -= V.tin * 0.1; r += V.tin * 0.04; b += V.tin * 0.04;
    // within what ink can be: no channel past the brightest ink, saturation no higher than the strongest ink's
    r = Math.min(0.98, Math.max(0.02, r)); g = Math.min(0.98, Math.max(0.02, g)); b = Math.min(0.98, Math.max(0.02, b));
    const M = Math.max(r, g, b), m = Math.min(r, g, b); if (M - m > 0.9 * M) { l = 0.299 * r + 0.587 * g + 0.114 * b; const k2 = 0.9 * M / (M - m); r = l + (r - l) * k2; g = l + (g - l) * k2; b = l + (b - l) * k2; }
    return [r, g, b]; };
  const adjRun = () => { const S = adjS; if (!S) return; S.raf = 0; const V = S.v, hc = Math.cos(V.hue * Math.PI / 180), hs = Math.sin(V.hue * Math.PI / 180);
    for (const o of S.T) { const D = o.id.data, O = o.orig;
      for (const i of o.ix) { const c = adjCol(O[i] / 255, O[i + 1] / 255, O[i + 2] / 255, V, hc, hs); D[i] = c[0] * 255; D[i + 1] = c[1] * 255; D[i + 2] = c[2] * 255; }
      if (S.sel) lsel.fl[o.key].getContext('2d').putImageData(o.id, 0, 0); else markDirty(o.key, S.box.x0, S.box.y0, S.box.x1, S.box.y1); }
    if (S.sel) selApply(); else { flushPig(); paint({ x0: S.box.x0 - 2, y0: S.box.y0 - 2, x1: S.box.x1 + 2, y1: S.box.y1 + 2 }); } st.dirty = true; };
  function adjEnd(apply) { const S = adjS; if (!S) return; adjS = null; cancelAnimationFrame(S.raf);
    if (!apply) { for (const o of S.T) o.id.data.set(o.orig); for (const o of S.T) { if (S.sel) lsel?.fl[o.key].getContext('2d').putImageData(o.id, 0, 0); else markDirty(o.key, S.box.x0, S.box.y0, S.box.x1, S.box.y1); }
      if (S.sel) { if (lsel) selApply(); } else { flushPig(); paint(); } return; }
    if (!S.sel && S.h) { hist.push(S.h); if (hist.length > 15) hist.shift(); fut.length = 0; cropTop({ x0: S.box.x0 - 2, y0: S.box.y0 - 2, x1: S.box.x1 + 2, y1: S.box.y1 + 2 }); }
    toast('Colour adjusted.', 1200); }
  pop.addEventListener('input', (e) => { const k2 = e.target.dataset?.adj; if (!k2 || !adjS) return; adjS.v[k2] = +e.target.value;
    const d = ADJ.find(a => a[0] === k2); e.target.closest('label').querySelector('b').textContent = (d[5] || ((v) => Math.round(v * 100) + '%'))(adjS.v[k2]);
    if (!adjS.raf) adjS.raf = requestAnimationFrame(adjRun); });
  pop.addEventListener('click', (e) => { const a = e.target.closest('[data-adja]')?.dataset.adja; if (!a || !adjS) return;
    if (a === 'reset') { adjS.v = { ...ADJ0 }; pop.querySelectorAll('[data-adj]').forEach(x => { x.value = ADJ0[x.dataset.adj]; x.dispatchEvent(new Event('input', { bubbles: true })); }); return; }
    if (a === 'apply') { adjEnd(true); pop.hidden = true; return; }
    if (a === 'cancel') { adjEnd(false); pop.hidden = true; } });
  /* Place: a picture becomes a floating piece on the current ink layer (white parts on the highlights layer, so they
     stay white), handled like a lasso selection: drag, size, turn, flip, Done. */
  async function placePick() {
    const rows = await DB.all(`SELECT p.title, x.photo_ref, x.thumb_ref FROM portfolio_photos x JOIN portfolio_items p ON p.id = x.item_id WHERE x.label = 'Ink only (clear background)' ORDER BY p.id DESC LIMIT 120`);
    const us = await Promise.all(rows.map(r => Media.url(r.thumb_ref)));
    const ref = await new Promise((res) => { const o = document.createElement('div'); o.id = 'merge-dlg';
      o.innerHTML = `<div class="card dz-pick"><h2>Place a tattoo</h2>${rows.length ? `<div class="dz-pf">${rows.map((r, i) => `<button data-v="${esc(r.photo_ref)}" title="${esc(r.title || '')}" class="tt-plc"><img src="${us[i]}" alt="" style="object-fit:contain"></button>`).join('')}</div>`
        : '<p class="muted">Nothing yet: tattoos saved to the portfolio from the simulator show up here.</p>'}
        <div class="row" style="gap:8px;margin-top:10px"><button class="btn" data-v="">Cancel</button><span style="flex:1"></span><button class="btn" data-v="@file">From this device</button></div></div>`;
      o.onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; o.remove(); res(b.dataset.v); }; document.body.appendChild(o); });
    if (!ref) return;
    const url = ref === '@file' ? await new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => res(i.files[0] ? URL.createObjectURL(i.files[0]) : null); i.click(); }) : await Media.url(ref);
    if (!url) return; const im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = url; }); if (!im) return toast('Could not read that picture.');
    placeSel(im); }
  function placeSel(im) { if (lsel) selCommit(); if (snapE) snapFinish();
    const key = INK.includes(st.layer) ? st.layer : 'line', w = im.naturalWidth, h = im.naturalHeight; if (!w || !h) return;
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const D = g.getImageData(0, 0, w, h), wd = new ImageData(w, h); let white = false;
    if (key !== 'high') for (let i = 0; i < D.data.length; i += 4) { const r = D.data[i], gg = D.data[i + 1], b = D.data[i + 2]; if (D.data[i + 3] && Math.min(r, gg, b) > 225) { wd.data.set([r, gg, b, D.data[i + 3]], i); D.data[i + 3] = 0; white = true; } }
    g.putImageData(D, 0, 0); const fl = { [key]: c };
    const keys = white ? [key, 'high'] : [key]; if (white) { const hc = document.createElement('canvas'); hc.width = w; hc.height = h; hc.getContext('2d').putImageData(wd, 0, 0); fl.high = hc; }
    const hh = state(keys[0]); hh.more = keys.slice(1).map(k2 => ({ key: k2, data: L[k2].getContext('2d').getImageData(0, 0, W, H) })); hist.push(hh); if (hist.length > 15) hist.shift(); fut.length = 0;
    const base = {}; for (const k2 of keys) { base[k2] = new ImageData(new Uint8ClampedArray(imgd[k2].data), W, H); touched.add(k2); }
    lsel = { keys, base, fl, b: { x: W / 2 - w / 2, y: H / 2 - h / 2, w, h }, tx: 0, ty: 0, s: Math.min(1, W * 0.6 / w, H * 0.6 / h), rot: 0, fx: 1, fy: 1 };
    st.tool = 'lasso'; sel(); selApply(); placeGuides(); toast('Drag it into place, size it from a corner, turn it from the dot, then Done.', 2600); }
  function selCommit(drop) { if (!lsel) return; const S = lsel; lsel = null; cancelAnimationFrame(selRaf); selRaf = 0;
    const c = { x: S.b.x + S.b.w / 2 + S.tx, y: S.b.y + S.b.h / 2 + S.ty };
    for (const key of S.keys) { const g = L[key].getContext('2d'); g.putImageData(S.base[key], 0, 0);
      if (!drop) { g.save(); g.translate(c.x, c.y); g.rotate(S.rot); g.scale(S.s * S.fx, S.s * S.fy); g.imageSmoothingQuality = 'high'; g.drawImage(S.fl[key], -S.b.w / 2, -S.b.h / 2); g.restore(); }
      syncIn(key); touched.add(key); }
    lsel = S; const cs = selCorners(); lsel = null;
    let x0 = S.b.x, y0 = S.b.y, x1 = S.b.x + S.b.w, y1 = S.b.y + S.b.h; for (const q of cs) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    cropTop({ x0: x0 - 4, y0: y0 - 4, x1: x1 + 4, y1: y1 + 4 }); st.dirty = true; paint(); placeGuides(); }
  function selCancel() { if (!lsel) return; const S = lsel; lsel = null; for (const key of S.keys) { L[key].getContext('2d').putImageData(S.base[key], 0, 0); }
    const h = hist.pop(); if (h) undoTo(h); placeGuides(); }
  // What a rough stroke was meant to be: a straight line, or a circle. Null when it's neither.
  const shapeOf = (P) => { if (P.length < 6) return null; const a = P[0], b = P[P.length - 1], L = Math.hypot(b.x - a.x, b.y - a.y);
    let len = 0; for (let i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
    if (L > 3 * mm) { let dev = 0; for (const q of P) dev = Math.max(dev, Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / L); if (dev / L < 0.07 && len < L * 1.6) return { kind: 'line', a, b }; }
    const c = { x: P.reduce((s, q) => s + q.x, 0) / P.length, y: P.reduce((s, q) => s + q.y, 0) / P.length }, rs = P.map(q => Math.hypot(q.x - c.x, q.y - c.y)), R = rs.reduce((s, v) => s + v, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((s, v) => s + (v - R) ** 2, 0) / rs.length);
    if (R > 1.5 * mm && sd / R < 0.14 && len > Math.PI * 2 * R * 0.8 && L < R * 0.9) return { kind: 'circle', c, R, a0: Math.atan2(a.y - c.y, a.x - c.x) };
    return null; };
  // Hold the pen still mid-stroke: the stroke is redone as the clean shape, at the stroke's own depth.
  /* Hold to snap fits whatever was drawn: a line or circle when it's close to one, otherwise the stroke cleaned up
     into smooth curves and sharp corners (corners where it turns hard). Right after, tapping the line shows its
     anchors: drag one to reshape, tap one to switch it between curve and corner. */
  const fitPath = (raw) => {
    if (raw.length < 4) return null; let len = 0; for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y); if (len < 3 * mm) return null;
    const sh = shapeOf(raw);
    if (sh?.kind === 'line') return { kind: 'line', closed: false, anchors: [{ ...sh.a, c: true }, { ...sh.b, c: true }] };
    if (sh?.kind === 'circle') return { kind: 'circle', closed: true, anchors: [...Array(8)].map((_, i) => { const a = sh.a0 + Math.PI * i / 4; return { x: sh.c.x + Math.cos(a) * sh.R, y: sh.c.y + Math.sin(a) * sh.R, c: false }; }) };
    // resample every mm, so turns and tolerances don't depend on how fast it was drawn
    const st1 = Math.max(1, mm), P = [raw[0]]; let carry = 0;
    for (let i = 1; i < raw.length; i++) { const a = raw[i - 1], b = raw[i], d = Math.hypot(b.x - a.x, b.y - a.y); let tt = st1 - carry; while (tt <= d) { P.push({ x: a.x + (b.x - a.x) * tt / d, y: a.y + (b.y - a.y) * tt / d }); tt += st1; } carry = d - (tt - st1); }
    const last = raw[raw.length - 1]; if (Math.hypot(last.x - P[P.length - 1].x, last.y - P[P.length - 1].y) > st1 * 0.3) P.push(last);
    const closed = Math.hypot(P[0].x - P[P.length - 1].x, P[0].y - P[P.length - 1].y) < Math.max(4 * mm, len * 0.1); if (closed) P.pop();
    // the hand's wobble is ironed out first, more on bigger strokes (so a big shape shrugs off a bigger wobble)
    const K = Math.max(3, Math.round(len / mm * 0.025)), eps = Math.max(0.7 * mm, len * 0.018);
    for (let pass = 0; pass < 3; pass++) { const Q = P.map(q => ({ ...q })); for (let i = 0; i < P.length; i++) { if (!closed && (i === 0 || i === P.length - 1)) continue;
      const a = Q[(i - 1 + Q.length) % Q.length], c = Q[(i + 1) % Q.length]; P[i] = { x: (a.x + Q[i].x * 2 + c.x) / 4, y: (a.y + Q[i].y * 2 + c.y) / 4 }; } }
    const n = P.length, at = (i) => closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))];
    const turn = (i) => { const a = at(i - K), b = at(i), c = at(i + K), a1 = Math.atan2(b.y - a.y, b.x - a.x), a2 = Math.atan2(c.y - b.y, c.x - b.x); let d = Math.abs(a2 - a1); if (d > Math.PI) d = Math.PI * 2 - d; return d; };
    const T = P.map((_, i) => (!closed && (i < K || i > n - 1 - K)) ? 0 : turn(i)), cor = [];
    for (let i = 0; i < n; i++) if (T[i] > 0.9 && [...Array(2 * K + 1)].every((_, j) => { const o = i - K + j; const oi = closed ? (o + n) % n : o; return oi < 0 || oi >= n || oi === i || T[oi] <= T[i]; })) cor.push(i);
    // between corners (and the ends), keep only the points the curve needs (Douglas-Peucker)
    const rdp = (lo, hi, out) => { let md = 0, mi = -1; const a = at(lo), b = at(hi), L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (let i = lo + 1; i < hi; i++) { const q = at(i), d = Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / L; if (d > md) { md = d; mi = i; } }
      if (md > eps && mi > 0) { rdp(lo, mi, out); out.push(mi); rdp(mi, hi, out); } };
    const breaks = closed ? (cor.length ? cor : [0]) : [0, ...cor.filter(i => i > 0 && i < n - 1), n - 1], idx = [];
    for (let j = 0; j < breaks.length - (closed ? 0 : 1); j++) { const lo = breaks[j], hi = closed ? (j + 1 < breaks.length ? breaks[j + 1] : breaks[0] + n) : breaks[j + 1]; idx.push(lo); const mid = []; rdp(lo, hi, mid); idx.push(...mid); }
    if (!closed) idx.push(n - 1);
    const anchors = []; for (const i of idx) { const q = at(i), c = cor.includes(((i % n) + n) % n) || (!closed && (i === 0 || i === n - 1)); const l2 = anchors[anchors.length - 1]; if (!l2 || Math.hypot(l2.x - q.x, l2.y - q.y) > 0.5 * mm) anchors.push({ x: q.x, y: q.y, c }); }
    if (anchors.length < 2) return null;
    return { kind: 'free', closed, anchors }; };
  // Points along the anchors: curves through smooth anchors, straight into and out of corners.
  const pathPts = (A, closed, step) => { const n = A.length, out = [], P = (i) => closed ? A[(i + n) % n] : A[Math.max(0, Math.min(n - 1, i))];
    const tan = (i) => { const a = P(i); if (a.c && !(closed && false)) return { x: 0, y: 0 }; const p0 = P(i - 1), p1 = P(i + 1); return { x: (p1.x - p0.x) * 0.5, y: (p1.y - p0.y) * 0.5 }; };
    for (let s2 = 0; s2 < (closed ? n : n - 1); s2++) { const a = P(s2), b = P(s2 + 1), ta = tan(s2), tb = tan(s2 + 1), m = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 1.2 / step));
      for (let j = s2 ? 1 : 0; j <= m; j++) { const u = j / m, u2 = u * u, u3 = u2 * u, h1 = 2 * u3 - 3 * u2 + 1, h2 = -2 * u3 + 3 * u2, h3 = u3 - 2 * u2 + u, h4 = u3 - u2;
        out.push({ x: h1 * a.x + h2 * b.x + h3 * ta.x + h4 * tb.x, y: h1 * a.y + h2 * b.y + h3 * ta.y + h4 * tb.y }); } }
    return out; };
  let snapE = null, snapRaf = 0;
  // Lay the snapped path into the skin, over the layer as it was before the stroke.
  const renderSnap = () => { const S = snapE; if (!S) return;
    if (S.mk) {   // a marker stroke: redrawn as felt-tip dots along the clean path
      const g = L.marker.getContext('2d'); g.putImageData(S.base, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.fillStyle = S.mk.col;
      const pts = pathPts(S.anchors, S.closed, Math.max(0.5, S.mk.r * 0.3)), B = { x0: W, y0: H, x1: 0, y1: 0 };
      for (const q of pts) { mkDot(g, q, S.mk.r); B.x0 = Math.min(B.x0, q.x - S.mk.r - 2); B.y0 = Math.min(B.y0, q.y - S.mk.r - 2); B.x1 = Math.max(B.x1, q.x + S.mk.r + 2); B.y1 = Math.max(B.y1, q.y + S.mk.r + 2); }
      S.box = B; S.pts = pts; touched.add('marker'); st.dirty = true; compAll = true; return paint(); }
    delete dirty[S.key]; L[S.key].getContext('2d').putImageData(S.base, 0, 0); syncIn(S.key); if (S.baseHi) { delete dirty.high; L.high.getContext('2d').putImageData(S.baseHi, 0, 0); syncIn('high'); }
    const own = !pen; if (own) pen = { cx: S.cx, foot: S.foot, sym: S.sym, box: null, id: -1 }; else pen.box = null;
    const pts = pathPts(S.anchors, S.closed, 0.08 * mm), bp = S.foot * 2 + 6 * mm;
    for (let i = 0; i < pts.length; i++) { const q = pts[i], n2 = pts[Math.min(pts.length - 1, i + 1)], pv = pts[Math.max(0, i - 1)], a = Math.atan2(n2.y - pv.y, n2.x - pv.x);
      puncture(S.cx, q, a, S.depth, 0, S.ink, false); if (S.cx.alsoHi) puncture(S.cx.alsoHi, q, a, S.depth, 0, S.ink * S.cx.alsoHi.w, false); if (pen.sym) symPunc(q, a, S.depth, 0, S.ink, false);
      const B = pen.box ||= { x0: q.x, y0: q.y, x1: q.x, y1: q.y }; B.x0 = Math.min(B.x0, q.x - bp); B.y0 = Math.min(B.y0, q.y - bp); B.x1 = Math.max(B.x1, q.x + bp); B.y1 = Math.max(B.y1, q.y + bp); }
    S.box = { ...pen.box }; S.pts = pts; if (own) pen = null; flushPig(); st.dirty = true; paint(); };
  const snapNow = () => { if (!CHEAT || !pen || pen.snapped || !pen.cx.pig || st.tool === 'erase') return;
    const fit = fitPath(pen.raw || []); if (!fit) { if ((pen.raw || []).length > 12) toast('Hold to snap: draw a little more, then hold still.', 2000); return; }
    const h = hist[hist.length - 1]; if (!h || h.rc) return;
    snapE = { key: h.key, base: h.data, baseHi: h.hi, anchors: fit.anchors, closed: fit.closed, kind: fit.kind, depth: pen.dn ? pen.dsum / pen.dn : 0.6,
      ink: Math.sqrt(Math.min(1, st.ink.v * 1.6)) * skinTake(), cx: pen.cx, sym: pen.sym, foot: pen.foot, live: false };
    renderSnap(); pen.snapped = true; pen.q = []; navigator.vibrate?.(15);
    toast(fit.kind === 'line' ? 'Snapped to a straight line. Tap it to adjust.' : fit.kind === 'circle' ? 'Snapped to a circle. Tap it to adjust.' : 'Snapped and smoothed. Tap it to adjust its anchors.', 1800); };
  /* Path (pen): tap to lay anchors, which curve smoothly through (tap one for a sharp corner, drag one to move it,
     tap the first to close the shape). Apply tattoos it with the current needle at the chosen pressure, as one
     stroke, and leaves it adjustable like a snapped line until Done. */
  const pth = { a: [], closed: false };
  st.pathP = meta.pathP ?? CP.pathP ?? 0.6;
  const pathApply = () => { if (pth.a.length < 2) return toast('Place at least two points first.');
    const key = toolLayer(); if (!key) return; if (st.ink.v <= 0.02 && !st.endless) return toast('Needle dry: dip in ink.', 1500);
    const wsh = key !== 'high' ? (st.ink.w || 0) : 0, cx = inkCx(key); if (wsh > 0.04) cx.alsoHi = { ...cx, key: 'high', w: wsh };
    snap(key, wsh > 0.04); touched.add(key); SS.strokes++; const h = hist[hist.length - 1];
    snapE = { key, base: h.data, baseHi: h.hi, anchors: pth.a.map(a => ({ ...a })), closed: pth.closed, kind: 'free', depth: depthOf(st.pathP, 20, 0),
      ink: Math.sqrt(Math.min(1, Math.max(st.ink.v, 0.3) * 1.6)) * skinTake(), cx, sym: symMats(), foot: (Math.max(...lay.map(n => Math.hypot(n.u, n.v))) + feel.size) * mm, live: true };
    renderSnap(); cropTop(snapE.box); snapE.h = hist[hist.length - 1]; snapE.moved = false;
    pth.a = []; pth.closed = false; placeGuides(); toast('Tattooed. Adjust the points if needed, then Done.', 2000); };
  // The adjusting is done: the undo step is widened to cover wherever the path ended up.
  function snapFinish() { const S = snapE; if (!S) return; snapE = null; cancelAnimationFrame(snapRaf); snapRaf = 0;
    if (S.h && S.moved && hist[hist.length - 1] === S.h) { const h = S.h, o = h.rc || { x: 0, y: 0, w: W, h: H };
      const x0 = Math.max(0, Math.floor(Math.min(o.x, S.box.x0))), y0 = Math.max(0, Math.floor(Math.min(o.y, S.box.y0))), x1 = Math.min(W, Math.ceil(Math.max(o.x + o.w, S.box.x1))), y1 = Math.min(H, Math.ceil(Math.max(o.y + o.h, S.box.y1)));
      h.rc = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; h.data = cropID(S.base, x0, y0, x1 - x0, y1 - y0); h.hi = S.baseHi ? cropID(S.baseHi, x0, y0, x1 - x0, y1 - y0) : null; h.blow = null; }
    placeGuides(); }
  const nearSnap = (e) => { if (!snapE?.pts) return false; const r = stage.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    for (let i = 0; i < snapE.pts.length; i += 4) { const q = toScreen(snapE.pts[i]); if (Math.hypot(q.x - sx, q.y - sy) < 16) return true; } return false; };
  const CRASH_D = 0.75, CRASH_V = 60;   // a crash: still this deep, moving at least this fast (mm/s), as the needle lands or leaves; normal working depth is about 0.4-0.65
  const crash = (p, d, ev) => { if (!pen || CHEAT) return; const sev = Math.max(0.2, Math.min(1, (d - CRASH_D) / 0.3));
    trAdd(p, pen.foot * 1.4, 0.15 * sev / ((cal.tough || 1) * TT_TOUGH));
    const ink = Math.sqrt(Math.min(1, st.ink.v * 1.6)) * skinTake(); setRoll(ev, turnOf(pen.a, ev)); for (let i = 0; i < 3; i++) puncture(pen.cx, p, pen.a, Math.min(1.1, d + 0.25), tiltOf(ev), ink, false);
    const bp = pen.foot * 2 + 6 * mm, B = pen.box ||= { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    B.x0 = Math.min(B.x0, p.x - bp); B.y0 = Math.min(B.y0, p.y - bp); B.x1 = Math.max(B.x1, p.x + bp); B.y1 = Math.max(B.y1, p.y + bp);
    SS.crash = (SS.crash || 0) + 1; if (EX?.cur) { EX.cur.crash = (EX.cur.crash || 0) + 1; tally(); }
    if (!told.crash) { told.crash = 1; toast('Crash: land and lift off on the move.', 2500); } };
  const strokeEnd = () => { clearTimeout(pen?.hold?.t); if (pen?.raf) cancelAnimationFrame(pen.raf); strokeFlush();
    if (pen?.landed && pen.dEnd > CRASH_D && pen.speed > CRASH_V && pen.cx.pig && st.tool !== 'erase') {   // the take-off: still deep as it left at speed
      crash(pen.last, pen.dEnd, pen.evEnd); const u = flushPig(), pad = pen.foot * 2 + 4 * mm; if (u) paint({ x0: u.x0 - pad, y0: u.y0 - pad, x1: u.x1 + pad, y1: u.y1 + pad }); }
    if (pen?.snapped && snapE) { if (pen.box) cropTop(pen.box); snapE.h = hist[hist.length - 1]; }
    if (pen) { if (pen.box) { if (!pen.snapped || !snapE) cropTop(pen.box); if (st.tool === 'erase' && pen.cx.pig) exLaser(); } else { hist.pop(); SS.strokes--; }   // a tap that left nothing: no undo step, no stroke
      const mmD = pen.trav || 0; SS.mm += mmD; SS.ms += Math.max(0, pen.t - pen.t0); if (st.tool !== 'erase') SS.needles[st.needle] = (SS.needles[st.needle] || 0) + mmD; }
    if (pen?.box && pen.cx.pig && st.tool !== 'erase') recentAdd(pen.cx); if (st.tool !== 'erase') tmStrokeEnd(); pen = null; drawNeedleInk(); if (trDirty) paint(); };

  /* ---------- Skin marker ----------
     Freehand on the skin, on its own layer, like a felt-tip: solid at any speed, a touch wider with pressure, a
     little smoothing. Colours for sketching light and refining dark; the spirit wipe takes it off. Nothing here
     touches the skin itself. */
  const MK_COLS = ['#7b4bc9', '#3a6fd8', '#d23b3b', '#2f9a52', '#1c1c1c', '#8fc7f0', '#f08bbd', '#f39a33'];
  st.mk = meta.mk || (MKP && { ...MKP, wipe: false }) || { col: MK_COLS[0], r: 0.6, wipe: false };
  function markerPop(b) { const M = st.mk;
    pop.innerHTML = `<div class="gh">Skin marker</div><div class="tt-lseg"><button data-mk="draw" class="${M.wipe ? '' : 'on'}">Marker</button><button data-mk="wipe" class="${M.wipe ? 'on' : ''}">Spirit wipe</button></div>
      <div class="tt-mkc">${MK_COLS.map(c => `<button data-mkc="${c}" style="background:${c}" class="${M.col === c ? 'on' : ''}" aria-label="Marker colour"></button>`).join('')}<label class="tt-mkcu" data-tip="Any colour"><input type="color" data-mkcu value="${M.col}"></label></div>
      <label class="dz-sl" style="margin:4px 6px"><span>Tip<b>${M.r} mm</b></span><input type="range" min="0.2" max="4" step="0.1" value="${M.r}" data-mkr></label>
      <label class="dz-sl" style="margin:4px 6px"><span>Opacity<b>${Math.round((st.op.marker ?? 0.9) * 100)}%</b></span><input type="range" min="0.1" max="1" step="0.05" value="${st.op.marker ?? 0.9}" data-mko></label>
      <div class="row" style="gap:4px;margin:4px 6px 6px"><button class="btn small" data-mk="clear">Wipe it all</button></div>`;
    pop.hidden = false; pop.style.top = Math.max(8, b.getBoundingClientRect().top - stage.getBoundingClientRect().top - 6) + 'px'; }
  pop.addEventListener('click', async (e) => { const m = e.target.closest('[data-mk]')?.dataset.mk, c = e.target.closest('[data-mkc]')?.dataset.mkc;
    if (c) { st.mk.col = c; st.mk.wipe = false; st.dirty = true; return markerPop($('#tt-rail [data-r="marker"]')); }
    if (m === 'draw' || m === 'wipe') { st.mk.wipe = m === 'wipe'; st.dirty = true; drawCur(); return markerPop($('#tt-rail [data-r="marker"]')); }
    if (m === 'clear') { if (!await ask('Wipe all the marker off the skin?')) return; snap('marker'); L.marker.getContext('2d').clearRect(0, 0, W, H); touched.add('marker'); st.dirty = true; paint(); } });
  pop.addEventListener('input', (e) => { if (e.target.matches('[data-mko]')) { st.op.marker = +e.target.value; e.target.closest('label').querySelector('b').textContent = Math.round(st.op.marker * 100) + '%'; st.dirty = true; compAll = true; return paint(); }
    if (e.target.matches('[data-mkr]')) { st.mk.r = +e.target.value; e.target.closest('label').querySelector('b').textContent = st.mk.r + ' mm'; st.dirty = true; return drawCur(); }
    if (e.target.matches('[data-mkcu]')) { st.mk.col = e.target.value; st.mk.wipe = false; st.dirty = true; } });
  let mk = null;
  const mkDot = (g, p, r) => { g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.fill(); };
  const mkDown = (e) => { const p = toPage(e); if (st.view !== 'work') { st.view = 'work'; st.viewC = null; drawView(); } st.hide.delete('marker');
    snap('marker'); touched.add('marker'); const g = L.marker.getContext('2d');
    mk = { id: e.pointerId, g, last: p, sp: p, box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y }, raw: [p], rs: 0, rn: 0 };
    g.fillStyle = st.mk.col; g.globalCompositeOperation = st.mk.wipe ? 'destination-out' : 'source-over'; mkTo(p, e); };
  // the spirit wipe is a cloth, much wider than the marker's tip
  const mkTo = (p, e) => { if (mk.snapped) return; const M = st.mk, pr = e.pointerType === 'mouse' ? 0.6 : Math.max(0.15, e.pressure || 0.5);
    const lr = mk.raw[mk.raw.length - 1]; if (Math.hypot(p.x - lr.x, p.y - lr.y) > 0.5) mk.raw.push(p);
    mk.sp = { x: mk.sp.x + (p.x - mk.sp.x) * 0.55, y: mk.sp.y + (p.y - mk.sp.y) * 0.55 };   // a little smoothing
    const r = (M.wipe ? Math.max(3, M.r * 5) : M.r) * mm / 2 * (0.6 + 0.6 * pr), a = mk.last, b = mk.sp, d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(d / Math.max(0.5, r * 0.3)));
    mk.g.globalAlpha = M.wipe ? 0.35 : 1; mk.rs += r; mk.rn++;
    for (let i = 1; i <= n; i++) mkDot(mk.g, { x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }, r);
    const B = mk.box; B.x0 = Math.min(B.x0, b.x - r - 2); B.y0 = Math.min(B.y0, b.y - r - 2); B.x1 = Math.max(B.x1, b.x + r + 2); B.y1 = Math.max(B.y1, b.y + r + 2);
    mk.last = b; st.dirty = true; paint({ x0: Math.min(a.x, b.x) - r - 2, y0: Math.min(a.y, b.y) - r - 2, x1: Math.max(a.x, b.x) + r + 2, y1: Math.max(a.y, b.y) + r + 2 }); };
  const mkMove = (e) => { for (const ev of (e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e])) mkTo(toPage(ev), ev);
    // cheat mode: hold still to snap the marker line, the same as the needle's hold to snap
    if (CHEAT && !st.mk.wipe && !mk.snapped) { const h0 = mk.hold; if (!h0 || Math.hypot(e.clientX - h0.x, e.clientY - h0.y) > 4) { clearTimeout(h0?.t); mk.hold = { x: e.clientX, y: e.clientY, t: setTimeout(mkSnap, 550) }; } } };
  const mkSnap = () => { if (!mk || mk.snapped) return; const fit = fitPath(mk.raw); if (!fit) { if (mk.raw.length > 12) toast('Hold to snap: draw a little more, then hold still.', 2000); return; }
    const h = hist[hist.length - 1]; if (!h || h.rc || h.key !== 'marker') return;
    snapE = { key: 'marker', base: h.data, anchors: fit.anchors, closed: fit.closed, kind: fit.kind, mk: { col: st.mk.col, r: mk.rn ? mk.rs / mk.rn : st.mk.r * mm / 2 }, live: false };
    renderSnap(); mk.snapped = true; navigator.vibrate?.(15);
    toast(fit.kind === 'line' ? 'Snapped to a straight line. Tap it to adjust.' : fit.kind === 'circle' ? 'Snapped to a circle. Tap it to adjust.' : 'Snapped and smoothed. Tap it to adjust its anchors.', 1800); };
  const mkUp = () => { if (!mk) return; clearTimeout(mk.hold?.t); mk.g.globalAlpha = 1; mk.g.globalCompositeOperation = 'source-over';
    if (mk.snapped && snapE) { cropTop(snapE.box); snapE.h = hist[hist.length - 1]; } else cropTop(mk.box); mk = null; };

  /* Skin meter: depth, speed (how close the punctures land) and how worked the skin under the needle is, each a
     bar with its safe band in green, so a stroke going wrong shows before the damage does. Shows the last values
     while the needle is up. Bands follow the skin model: blowouts start at depth 0.8 when the punctures land under
     0.035 mm apart; the skin reddens from 0.3, swells from 1, gets patchy past 1.4. */
  const MTR = [
    ['depth', 'Depth', 0, 1.1, 0.45, 0.8, 0.95, (v) => v.toFixed(2)],   // the green edge and red start follow the needle size (meterBands)
    ['gap', 'Speed', 0, 0.8, 0.05, 0.2, 0.035, (v) => v.toFixed(3) + ' mm', true],   // whip shading widens the green to WHIP_GAP
    ['skin', 'Skin', 0, 2.2, 0, 0.8, 1.4, (v) => v < 0.3 ? 'fresh' : v < 0.8 ? 'red' : v < 1.4 ? 'swollen' : 'overworked'],
  ];
  // How well ink takes in a challenge's skin: Tan takes colour poorly, Brown and Deep take a little less black.
  const skinI = TT_SKINS.findIndex(([, c]) => c.toLowerCase() === (st.skin || '').toLowerCase());
  const skinTake = () => { if (!EX || skinI < 3) return 1; const col = st.ink.c, grey = Math.max(...col) - Math.min(...col) < 0.08;
    return skinI === 3 ? (grey ? 1 : 0.72) : 0.88; };
  const meterEl = $('#tt-meter');
  // Thinner needles cut deeper for the same push: #08 starts blowing out sooner (and more often) than #12.
  // A round shader's tight bundle lines like a liner, and blows out like one, whatever its needle size.
  function blowSize() { const s = feel.size || 0.3; return TT_NEEDLES.find(n => n.id === st.needle)?.kind === 'shader' ? Math.min(s, 0.3) : s; }
  function blowD() { return 0.8 - (0.3 - blowSize()) * 1.2; }
  /* Check: the cursor becomes a circle that reads the skin inside it (its average wear as a score out of 100,
     and how worked the worst spot is) instead of tattooing; the slider sets the circle's size in mm. */
  st.checkR ??= 6;
  /* While a lesson or challenge runs: what has gone wrong so far, under the meter, so a ruined attempt can be started
     over straight away. Red once it costs points. */
  function tally() { const el = $('#tt-tally'); if (!el) return; const c = EX?.cur; if (!c) { el.hidden = true; return; } el.hidden = false; const T = exList()[EX.i] || {}, free = T.crashFree ?? 0;
    const it = [['Crashes', c.crash || 0, (c.crash || 0) > free], ['Blowouts', c.blow || 0, (c.blow || 0) > (T.maxBlow ?? 0)], ['Overworked', c.over || 0, (c.over || 0) > 0], ['Bumps', c.bumps || 0, (c.bumps || 0) > 0]];
    el.innerHTML = it.map(([n, v, bad]) => `<span class="${bad ? 'bad' : v ? 'warn' : ''}">${n} <b>${v}</b></span>`).join(''); }
  const chkRow = () => `<div class="tt-tally" id="tt-tally" hidden></div><div class="tt-chkrow"><button class="tt-peek" data-peek data-tip="Hold to see it healed" aria-label="Hold to see it healed"><svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button><button class="${st.check ? 'on' : ''}" data-chk data-tip="Check the skin: the cursor reads the skin inside its circle instead of tattooing">Check</button>
    <input type="range" min="2" max="30" step="1" value="${st.checkR}" data-chkr aria-label="Check circle size" ${st.check ? '' : 'hidden'}><em>${st.check ? st.checkR + ' mm' : ''}</em></div>${CHEAT ? `<div class="tt-chkrow"><span class="tt-smlbl">Smooth</span><input type="range" min="0" max="90" step="5" value="${st.smooth}" data-smooth aria-label="Line smoothing"><em>${st.smooth}%</em></div>` : ''}`;
  /* The eye: held down, the piece shows as healed; let go and it is back as it was. */
  let peekWas = null; const peekEnd = () => { if (peekWas == null) return; st.view = peekWas; peekWas = null; st.viewC = null; drawView(); paint(); meterEl.querySelector('[data-peek]')?.classList.remove('on'); };
  meterEl.addEventListener('pointerdown', (e) => { const b = e.target.closest('[data-peek]'); if (!b || peekWas != null) return; e.preventDefault(); b.setPointerCapture?.(e.pointerId); peekWas = st.view; st.view = 'healed'; st.viewC = null; b.classList.add('on'); drawView(); paint(); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => meterEl.addEventListener(ev, peekEnd));
  meterEl.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-peek]')) e.preventDefault(); });
  meterEl.addEventListener('click', (e) => { if (!e.target.closest('[data-chk]')) return; st.check = !st.check; meterBuild(); meter(lastM); drawCur(); });
  meterEl.addEventListener('input', (e) => { if (e.target.matches('[data-smooth]')) { st.smooth = +e.target.value; st.dirty = true; e.target.nextElementSibling.textContent = st.smooth + '%'; return; }
    if (!e.target.matches('[data-chkr]')) return; st.checkR = +e.target.value; e.target.nextElementSibling.textContent = st.checkR + ' mm'; drawCur(); });
  // Skin inside a circle round page point p (radius in page px): average wear, the worst spot, and a score.
  const skinCheck = (p, R) => { let sum = 0, n = 0, mx = 0; const r2 = (R / TS) ** 2, cx0 = p.x / TS, cy0 = p.y / TS;
    for (let y = Math.max(0, Math.floor(cy0 - R / TS)); y <= Math.min(th - 1, Math.ceil(cy0 + R / TS)); y++)
      for (let x2 = Math.max(0, Math.floor(cx0 - R / TS)); x2 <= Math.min(tw - 1, Math.ceil(cx0 + R / TS)); x2++) {
        if ((x2 + 0.5 - cx0) ** 2 + (y + 0.5 - cy0) ** 2 > r2) continue; const v = TR[y * tw + x2]; sum += v; n++; if (v > mx) mx = v; }
    const avg = n ? sum / n : 0; return { avg, mx, score: Math.round(100 * (1 - Math.max(0, Math.min(1, (avg - 0.3) / 1.6)))) }; };
  const skinWord = (v) => v < 0.3 ? 'fresh' : v < 0.8 ? 'red' : v < 1.4 ? 'swollen' : 'overworked';
  const meterBands = () => { const d = blowD(); MTR[0][5] = d; MTR[0][6] = d + 0.12; };
  const meterBuild = () => { meterBands(); meterEl.innerHTML = MTR.map(([key, name, lo, hi, g0, g1, bad, , low]) => { const P = (v) => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
    const badZ = low ? `left:0;width:${P(bad)}%` : `left:${P(bad)}%;right:0`;
    return `<div class="tt-mr" data-m="${key}"><span>${name}</span><div class="tt-mb"><i class="bad" style="${badZ}"></i><i class="ok" style="left:${P(g0)}%;width:${P(g1) - P(g0)}%"></i><b></b></div><em></em></div>`; }).join('') + chkRow(); tally(); };
  meterBuild(); tally(); if (CHEAT) meterEl.classList.add('cheat');   // no skin damage to show
  const WHIP_GAP = 0.7;
  const meter = (m) => {
    const gr = meterEl.querySelector('[data-m="gap"]');
    if (!!m.whip !== (gr.querySelector('span').textContent === 'Whip')) { const row = gr, whipShown = !!m.whip, [, , lo, hi, g0, g1] = MTR[1], P = (v) => (v - lo) / (hi - lo) * 100;
      row.querySelector('span').textContent = whipShown ? 'Whip' : 'Speed'; row.querySelector('i.ok').style.width = P(whipShown ? WHIP_GAP : g1) - P(g0) + '%'; }
    for (const [key, , lo, hi, g0, g1raw, bad, fmt, low] of MTR) { const v = m[key], row = meterEl.querySelector(`[data-m="${key}"]`), g1 = key === 'gap' && m.whip ? WHIP_GAP : g1raw;
    let z = v >= g0 && v <= g1 ? 'ok' : (low ? v < bad : v > bad) ? 'bad' : 'warn';
    if (key === 'gap' && z === 'bad' && m.depth < blowD()) z = 'warn';   // slow is only a danger while digging in
    row.querySelector('b').style.left = Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)) + '%'; row.className = 'tt-mr ' + z; row.querySelector('em').textContent = fmt(v); } };
  let lastM = { depth: 0, gap: 0.1, skin: 0 }; meter(lastM);

  /* Challenge rules: a few free undos (in case the app got it wrong), then each costs points; the laser costs
     points from its first beam on the skin. Each is flagged on screen as it happens and listed in the result.
     Singles: 1 free undo (2 on three-star ones); the exam: 3 shared over the whole exam. */
  const UNDO_PTS = 3, LASER_PTS = [4, 2];   // per undo past the free ones; the first beam, then each one after
  const exLive = () => !!(EX && !EX.done && EX.cur && !EX.cur.scored);
  const freeUndos = () => EX.mode === 'ch' ? (exList()[EX.i]?.diff >= 3 ? 2 : 1) : 3;
  const usedUndos = () => EX.mode === 'ch' ? (EX.cur?.undos || 0) : (EX.undos || 0);
  const exPen = (c = EX?.cur) => { if (!c) return { pts: 0 };
    const over = Math.max(0, (c.undos || 0) - (c.free ?? 0)), l = c.laser || 0, lp = l ? LASER_PTS[0] + (l - 1) * LASER_PTS[1] : 0;
    return { pts: Math.min(40, over * UNDO_PTS + lp) }; };
  const flag = (msg, bad) => { const f = document.createElement('div'); f.className = 'tt-flag' + (bad ? ' bad' : ''); f.textContent = msg; stage.append(f); setTimeout(() => f.remove(), 2600); };
  function exUndo() { if (!exLive()) return; const free = freeUndos();
    // what the allowance still held when this challenge's first undo came (the exam's three are shared)
    EX.cur.free ??= Math.max(0, free - (EX.mode === 'ch' ? 0 : (EX.undos || 0)));
    EX.cur.undos = (EX.cur.undos || 0) + 1; if (EX.mode !== 'ch') EX.undos = (EX.undos || 0) + 1;
    const left = Math.max(0, free - usedUndos());
    if (EX.cur.undos <= EX.cur.free) flag(left ? `Free undo used: ${left} left` : 'Last free undo used', false);
    else flag(`Undo: −${UNDO_PTS} points`, true);
    st.dirty = true; exBar(); }
  function exLaser() { if (!exLive()) return; EX.cur.laser = (EX.cur.laser || 0) + 1;
    if (EX.lesson) flag('Laser used: this attempt fails', true); else flag(`Laser on the skin: −${EX.cur.laser === 1 ? LASER_PTS[0] : LASER_PTS[1]} points`, true); st.dirty = true; exBar(); }

  const cur = $('#tt-cur'), cux = cur.getContext('2d'); let curAt = null;
  const drawCur = (e) => {
    const r = stage.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    if (cur.width !== Math.round(r.width * dpr)) { cur.width = Math.round(r.width * dpr); cur.height = Math.round(r.height * dpr); cur.style.width = r.width + 'px'; cur.style.height = r.height + 'px'; }
    cux.setTransform(1, 0, 0, 1, 0, 0); cux.clearRect(0, 0, cur.width, cur.height); drawGuides();
    if (e) curAt = { x: e.clientX - r.left, y: e.clientY - r.top, ev: e };
    if (!curAt || pinch || pan) return;
    const s = k * mm, a = pageTurn(pen?.a || 0, curAt.ev) + st.rot, ca = Math.cos(a), sa = Math.sin(a), rr = Math.max(1.2, feel.size / 2 * s * 0.8);
    cux.setTransform(dpr, 0, 0, dpr, 0, 0); cux.lineWidth = 1;
    if (CHEAT && st.tool === 'liquify') { cux.beginPath(); cux.arc(curAt.x, curAt.y, st.liq.r * s, 0, 7); cux.lineWidth = 3; cux.strokeStyle = 'rgba(0,0,0,.45)'; cux.stroke(); cux.lineWidth = 1.5; cux.strokeStyle = '#b58ae8'; cux.stroke(); return; }
    if (CHEAT && st.tool === 'text') { cux.lineWidth = 1.5; cux.strokeStyle = '#b58ae8'; cux.beginPath(); cux.moveTo(curAt.x - 8, curAt.y); cux.lineTo(curAt.x + 8, curAt.y); cux.moveTo(curAt.x, curAt.y - 10); cux.lineTo(curAt.x, curAt.y + 10); cux.stroke(); return; }
    if (CHEAT && st.tool === 'blend') { cux.beginPath(); cux.arc(curAt.x, curAt.y, st.blend.r * s, 0, 7); cux.lineWidth = 3; cux.strokeStyle = 'rgba(0,0,0,.45)'; cux.stroke(); cux.lineWidth = 1.5; cux.strokeStyle = '#ff8a7a'; cux.stroke(); return; }
    if (CHEAT && (st.tool === 'fill' || st.tool === 'shape' || st.tool === 'lasso' || st.tool === 'pick')) {
      if (td?.kind === 'lasso') { const P = td.pts.map(toScreen); cux.setLineDash([5, 4]); cux.beginPath(); P.forEach((q, i) => i ? cux.lineTo(q.x, q.y) : cux.moveTo(q.x, q.y)); cux.closePath(); cux.lineWidth = 1.5; cux.strokeStyle = '#ff8a7a'; cux.stroke(); cux.setLineDash([]); }
      if (td?.kind === 'shape') { const P = shapePts(st.shape.kind, td.a, td.b).map(toScreen); cux.beginPath(); P.forEach((q, i) => i ? cux.lineTo(q.x, q.y) : cux.moveTo(q.x, q.y)); cux.lineWidth = 3; cux.strokeStyle = 'rgba(0,0,0,.4)'; cux.stroke(); cux.lineWidth = 1.5; cux.strokeStyle = '#ff8a7a'; cux.stroke(); }
      cux.lineWidth = 1.5; cux.strokeStyle = '#ff8a7a'; cux.beginPath(); cux.moveTo(curAt.x - 8, curAt.y); cux.lineTo(curAt.x + 8, curAt.y); cux.moveTo(curAt.x, curAt.y - 8); cux.lineTo(curAt.x, curAt.y + 8); cux.stroke(); return; }
    if (st.tool === 'marker') { const r = (st.mk.wipe ? Math.max(3, st.mk.r * 5) : st.mk.r) * s / 2; cux.beginPath(); cux.arc(curAt.x, curAt.y, Math.max(2, r), 0, 7); cux.lineWidth = 2.5; cux.strokeStyle = 'rgba(0,0,0,.4)'; cux.stroke();
      cux.lineWidth = 1.5; cux.strokeStyle = st.mk.wipe ? '#9fd3e0' : st.mk.col; cux.stroke(); return; }
    if (st.check) { const R = st.checkR * s, c = skinCheck(fromScreen(curAt.x, curAt.y), st.checkR * mm), col = c.score >= 80 ? '#6fe39a' : c.score >= 55 ? '#f2c14e' : '#ff7a66';
      cux.beginPath(); cux.arc(curAt.x, curAt.y, R, 0, 7); cux.lineWidth = 3; cux.strokeStyle = 'rgba(0,0,0,.5)'; cux.stroke(); cux.lineWidth = 1.5; cux.strokeStyle = col; cux.stroke();
      cux.beginPath(); cux.arc(curAt.x, curAt.y, 1.5, 0, 7); cux.fillStyle = col; cux.fill();
      const tx = curAt.x + R * 0.72 + 8, ty = curAt.y - R * 0.72 - 8, l1 = `Skin ${c.score}`, l2 = `${skinWord(c.avg)} · worst ${skinWord(c.mx)}`;
      cux.font = '700 15px Inter, sans-serif'; const w = Math.max(cux.measureText(l1).width, (cux.font = '600 11px Inter, sans-serif', cux.measureText(l2).width)) + 16;
      cux.fillStyle = 'rgba(15,18,19,.88)'; cux.beginPath(); cux.roundRect?.(tx, ty - 34, w, 40, 8) ?? cux.rect(tx, ty - 34, w, 40); cux.fill();
      cux.fillStyle = col; cux.font = '700 15px Inter, sans-serif'; cux.fillText(l1, tx + 8, ty - 16); cux.fillStyle = '#cfd6d8'; cux.font = '600 11px Inter, sans-serif'; cux.fillText(l2, tx + 8, ty - 2);
      return; }
    if (isMag()) {   // the row's line, so its angle reads even when the needles are tiny on screen
      const us = lay.map(n => n.u), u0 = Math.min(...us) * s - 6, u1 = Math.max(...us) * s + 6;
      cux.strokeStyle = 'rgba(31,182,166,.9)'; cux.lineWidth = 2; cux.beginPath();
      cux.moveTo(curAt.x + u0 * -sa, curAt.y + u0 * ca); cux.lineTo(curAt.x + u1 * -sa, curAt.y + u1 * ca); cux.stroke(); cux.lineWidth = 1;
    }
    const mg = isMag(), curRoll = pen ? rollNow : (st.magRoll || 0), curD = st.lastD ?? 0.5; let hits = 0;
    if (mg && Math.abs(curRoll) > 0.01) { for (const nd of lay) if (magReach(nd, curD, curRoll) / curD > 0.004) hits++;   // tilted: how many needles reach the skin, faint behind the cursor
      cux.font = '600 10px Inter, sans-serif'; cux.textAlign = 'center'; cux.fillStyle = 'rgba(255,255,255,.38)'; cux.fillText(`${hits}/${lay.length}`, curAt.x, curAt.y + Math.max(rr + 14, 16)); cux.textAlign = 'start'; hits = 0; }
    for (const nd of lay) { const pk = mg ? 1 : nlook.thin, px = curAt.x + nd.u * pk * s * -sa + nd.v * pk * s * ca, py = curAt.y + nd.u * pk * s * ca + nd.v * pk * s * sa, rc = mg ? magReach(nd, curD, curRoll) / curD : 1; if (rc > 0.004) hits++;
      cux.beginPath(); cux.arc(px, py, Math.max(0.8, rr * nlook.thin), 0, 7); cux.fillStyle = mg ? `rgba(255,255,255,${0.05 + 0.55 * Math.min(1, rc)})` : 'rgba(255,255,255,.35)'; cux.fill(); cux.strokeStyle = rc > 0.004 ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.2)'; cux.stroke(); }
    // A tag when the needle runs dry, on the left and clear of a right hand's pen: low under 18% loaded, then empty.
    if (st.tool === 'needle' && !(CHEAT && st.endless) && st.ink.v < 0.18) { const tt = st.ink.v <= 0.01 ? 'Empty' : 'Low', ty = curAt.y - Math.max(14, rr + 10); cux.font = '700 14px Inter, sans-serif'; const tw = cux.measureText(tt).width + 14, tx = curAt.x - Math.max(16, rr + 12) - tw; cux.fillStyle = 'rgba(15,18,19,.92)'; cux.fillRect(tx, ty - 15, tw, 21); cux.fillStyle = tt === 'Empty' ? '#ff7a66' : '#f2c14e'; cux.fillText(tt, tx + 7, ty); }
    // What's loaded: a drop of the needle's ink beside the cursor (paler when diluted), hidden while tattooing.
    if (!pen && st.ink.v > 0.01) { const dx = curAt.x + Math.max(14, rr + 10), dy = curAt.y - Math.max(14, rr + 10);
      cux.beginPath(); cux.moveTo(dx, dy - 9); cux.bezierCurveTo(dx + 7, dy - 1, dx + 6, dy + 6, dx, dy + 6); cux.bezierCurveTo(dx - 6, dy + 6, dx - 7, dy - 1, dx, dy - 9); cux.closePath();
      cux.fillStyle = '#fff'; cux.fill(); cux.globalAlpha = Math.max(0.12, st.ink.s ?? 1); cux.fillStyle = ttToHex(st.ink.c); cux.fill(); cux.globalAlpha = 1;
      cux.lineWidth = 1.5; cux.strokeStyle = 'rgba(0,0,0,.7)'; cux.stroke(); }
  };
  cv.addEventListener('pointerleave', () => { curAt = null; drawCur(); });

  /* ---------- Pointer: pen draws; fingers move the page (or draw too, when allowed) ---------- */
  const pts = new Map(); let pinch = null, pan = null, space = false;
  cv.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && cal.penOnly && pen) return;   // a resting palm while the pen draws
    if (CHEAT && e.pointerType === 'touch') { if (!ftap || !pts.size) ftap = { t0: performance.now(), max: 0, moved: false, at: new Map() }; ftap.at.set(e.pointerId, { x: e.clientX, y: e.clientY }); ftap.max = Math.max(ftap.max, pts.size + 1); }
    closePop(); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = stage.getBoundingClientRect();
    if (pts.size === 2) { if (pen) { cancelAnimationFrame(pen.raf); hist.length && undoTo(hist.pop()); SS.strokes--; pen = null; }   // a second finger: that was a pinch, not a stroke
      const [a, b] = [...pts.values()], mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z, ang: Math.atan2(b.y - a.y, b.x - a.x), rot: st.rot, p: fromScreen(mx, my), snapped: null }; return; }
    cv.setPointerCapture(e.pointerId);
    const touch = e.pointerType === 'touch';
    if (space || e.button === 1 || (touch && cal.penOnly)) { pan = { x: e.clientX, y: e.clientY, vx, vy }; return; }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (st.check) return drawCur(e);   // checking the skin, not tattooing
    if (lsel && st.tool !== 'lasso') selCommit();
    if (snapE) { if (!snapE.live && (st.tool === 'needle' || st.tool === 'marker') && nearSnap(e)) { snapE.live = true; placeGuides(); return; } snapFinish(); }
    if (st.tool === 'marker') return mkDown(e);
    if (CHEAT && st.tool !== 'path' && pth.a.length) pth.a = [];   // left the path tool: the unfinished path goes
    if (CHEAT && ['blend', 'fill', 'shape', 'lasso', 'pick', 'liquify', 'text', 'path'].includes(st.tool)) return toolDown(e);
    if (strokeStart(e)) strokeMove(e);
  });
  cv.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ftap?.at.has(e.pointerId)) { const s = ftap.at.get(e.pointerId); if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 12) ftap.moved = true; }
    if (pinch && pts.size >= 2) { const [a, b] = [...pts.values()], r = stage.getBoundingClientRect(), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      z = Math.max(0.5, Math.min(12, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)); k = fitK * z;
      let rot = pinch.rot + Math.atan2(b.y - a.y, b.x - a.x) - pinch.ang;
      const q90 = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2), near = Math.abs(rot - q90) < 7 * Math.PI / 180;   // snap at every 90 degrees
      if (near) { rot = q90; if (pinch.snapped !== q90) { pinch.snapped = q90; navigator.vibrate?.(12); } } else pinch.snapped = null;
      st.rot = rot; pinTo(pinch.p, mx, my); st.dirty = true; return paint(); }
    if (pan) { vx = pan.vx + e.clientX - pan.x; vy = pan.vy + e.clientY - pan.y; return paint(); }
    if (td && e.pointerId === td.id) toolMove(e);
    if (mk && e.pointerId === mk.id) mkMove(e);
    if (pen && e.pointerId === pen.id) { strokeMove(e);
      if (CHEAT && !pen.snapped) { const h0 = pen.hold; if (!h0 || Math.hypot(e.clientX - h0.x, e.clientY - h0.y) > 4) { clearTimeout(h0?.t); pen.hold = { x: e.clientX, y: e.clientY, t: setTimeout(snapNow, 550) }; } } }
    if (e.pointerType !== 'touch' || ((st.check || td || mk) && !pan)) { const pr = e.getPredictedEvents?.(); drawCur(pen && pen.speed > 60 && pr?.length ? pr[pr.length - 1] : e); }   // a slow line follows the pen exactly; prediction only helps quick sweeps
    calLive(e);
  });
  // a quick tap of two fingers (undo) or three (redo) that didn't move: cheat mode only
  let ftap = null;
  const up = (e) => { pts.delete(e.pointerId);
    if (ftap && !pts.size) { const f = ftap; ftap = null; if (!f.moved && f.max >= 2 && performance.now() - f.t0 < 400) { f.max === 2 ? undo() : redo(); navigator.vibrate?.(10); } } if (pinch && pts.size < 2) pinch = null; pan = null; if (pen && e.pointerId === pen.id) strokeEnd(); if (td && e.pointerId === td.id) toolUp(); if (mk && e.pointerId === mk.id) mkUp(); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  const keys = (e) => { if (!document.body.contains(el)) { removeEventListener('keydown', keys); removeEventListener('keyup', keys); return; }
    if (e.target.matches?.('input, textarea')) return;
    if (e.key === ' ') { space = e.type === 'keydown'; e.preventDefault(); }
    if (e.type === 'keydown' && (e.key === '[' || e.key === ']') && isMag()) { setAng(st.magAng + (e.key === ']' ? 15 : -15)); }
    if (e.type === 'keydown' && (e.key === ',' || e.key === '.') && isMag()) { setRoll2((st.magRoll || 0) + (e.key === '.' ? 0.1 : -0.1)); toast('Stack tilt: ' + rollText(), 900); }
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    if (e.type === 'keydown' && CHEAT) {   // Enter puts a lasso down or finishes adjusting a snap; Escape cancels; Delete removes the lassoed part
      if (e.key === 'Enter') { if (lsel) selCommit(); else if (snapE) snapFinish(); }
      if (e.key === 'Escape') { if (lsel) selCancel(); else if (snapE) snapFinish(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && lsel) { e.preventDefault(); selCommit(true); } } };
  addEventListener('keydown', keys); addEventListener('keyup', keys);
  document.addEventListener('input', (e) => { const n = e.target; if (n.matches?.('[data-nthin]')) { nlook.thin = +n.value / 100; Settings.set('tt_thin', n.value); const b = $('#tt-thinv'); if (b) b.textContent = n.value + '%'; drawCur(); } if (n.matches?.('[data-ntex]')) { nlook.tex = +n.value / 100; Settings.set('tt_tex', n.value); const b = $('#tt-texv'); if (b) b.textContent = n.value + '%'; } });
  stage.querySelector('.tt-zoom').onclick = (e) => { const b = e.target.closest('[data-z]'); if (!b) return;
    if (b.dataset.z === 'fit') { z = 1; vx = vy = 0; k = fitK; st.rot = 0; return paint(); } const r = stage.getBoundingClientRect(); zoomAt(z * (b.dataset.z === 'in' ? 1.4 : 1 / 1.4), r.width / 2, r.height / 2); };

  const undoTo = (h) => { L[h.key].getContext('2d').putImageData(h.data, h.rc?.x || 0, h.rc?.y || 0); syncIn(h.key); touched.add(h.key);
    if (h.more) for (const m of h.more) { L[m.key].getContext('2d').putImageData(m.data, h.rc?.x || 0, h.rc?.y || 0); syncIn(m.key); touched.add(m.key); }
    if (h.hi) { L.high.getContext('2d').putImageData(h.hi, h.rc?.x || 0, h.rc?.y || 0); syncIn('high'); touched.add('high'); }
    if (h.tr) { TR.set(h.tr); if (h.tp) TP.set(h.tp); trDirty = true; } if (h.bu) BU.set(h.bu); if (h.blow) bx.putImageData(h.blow, h.rc ? h.rc.x >> 1 : 0, h.rc ? h.rc.y >> 1 : 0); st.dirty = true; st.viewC = null; paint(); };
  const swap = (from, to) => { if (pen) return true; if (snapE) snapFinish(); if (lsel) { selCancel(); return true; }   // undo while something floats: put it back where it was
    const h = from.pop(); if (!h) return false; const s2 = state(h.key, h.rc, !!h.hi); if (h.more) s2.more = h.more.map(m => ({ key: m.key, data: L[m.key].getContext('2d').getImageData(h.rc?.x || 0, h.rc?.y || 0, h.rc?.w || W, h.rc?.h || H) })); to.push(s2); undoTo(h); return true; };
  const undo = () => { if (!swap(hist, fut)) return toast('Nothing to undo.'); exUndo(); };
  const redo = () => swap(fut, hist) || toast('Nothing to redo.');

  /* Recent colours: the last three inks that went into the skin, plain black skipped, kept in small caps beside the
     needle's ink so an exact mix can be dipped again. A fourth pushes the oldest out. */
  st.recent = (meta.recent || []).slice(0, 3);
  const recentAdd = (cx) => { const r = { c: cx.col.map(v => +(v / 255).toFixed(3)), s: +(cx.str ?? 1).toFixed(3), w: +(st.ink.w || 0).toFixed(3) };
    if (Math.max(...r.c) < 0.12 && r.s > 0.9) return;   // solid black
    const same = (a) => Math.abs(a.s - r.s) < 0.02 && a.c.every((v, i) => Math.abs(v - r.c[i]) < 0.02); if (st.recent[0] && same(st.recent[0])) return;
    st.recent = [r, ...st.recent.filter(a => !same(a))].slice(0, 3); st.dirty = true; drawTray(); };
  /* ---------- Ink caps: hold to dip (the longer, the more of that colour), tap the cup to rinse ---------- */
  const tray = $('#tt-tray');
  const drawTray = () => {
    tray.innerHTML = `<button class="tt-set" data-set data-tip="Switch between colour inks and grey wash" aria-label="Ink set">${st.wash ? 'Wash' : 'Inks'}</button>
      <button class="tt-cup" data-rinse data-tip="Rinse: clean the needle" aria-label="Rinse"></button>
      ${st.wash ? TT_WASH.map(([n, s], i) => `<button class="tt-cap tt-wcap" data-wash="${i}" style="--c:rgba(20,20,20,${s})" data-tip="${n} wash" aria-label="${n} wash"><i></i></button>`).join('')
        : st.caps.map((c, i) => `<button class="tt-cap" data-cap="${i}" style="--c:${c}" aria-label="Ink cap"><i></i></button>`).join('')}
      <button class="tt-cup tt-dil" data-dilute data-tip="Dilute: hold to thin the ink on the needle (keeps its colour, only lighter)" aria-label="Dilute"></button>
      <button class="tt-load" id="tt-load" data-tip="Ink on the needle" aria-label="Ink on the needle"><i></i><span></span></button>
      ${st.wash ? '' : `<span class="tt-recent">${[0, 1, 2].map(i => { const r = st.recent[i]; return r ? `<button class="tt-cap tt-rcap" data-rc="${i}" style="--c:${ttToHex(r.c)};--o:${Math.max(0.15, r.s)}" data-tip="Your mix: hold to load this exact colour" aria-label="Recent colour"><i></i></button>` : '<span class="tt-rcap tt-rnone"></span>'; }).join('')}</span>`}
      <button class="dz-ib tt-capedit ${st.capEdit ? 'on' : ''}" ${st.wash ? 'hidden' : ''} data-capedit data-tip="Change the ink colours" aria-label="Change ink colours"><svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19z"/></svg></button>`;
    drawNeedleInk();
  };
  const drawNeedleInk = () => { const b = $('#tt-load'); if (!b) return; b.querySelector('i').style.background = st.ink.v > 0.01 ? ttToHex(st.ink.c) : 'transparent'; b.querySelector('i').style.opacity = st.ink.s ?? 1;
    b.style.setProperty('--v', Math.round(st.ink.v * 100) + '%'); b.querySelector('span').textContent = Math.round(st.ink.v * 100) + '%';
    b.dataset.tip = st.ink.v > 0.01 ? `Ink on the needle: ${Math.round(st.ink.v * 100)}%, strength ${Math.round((st.ink.s ?? 1) * 100)}%` : 'The needle is dry'; drawCur(); };
  let dip = null;
  tray.addEventListener('pointerdown', (e) => {
    const cap = e.target.closest('[data-cap], [data-wash], [data-dilute], [data-rc]'); if (!cap) return;
    const rc = cap.dataset.rc != null ? st.recent[+cap.dataset.rc] : null;
    // The dilute cup is clear water: it adds volume of the needle's own colour at no strength, so a hold thins it.
    const dil = cap.dataset.dilute != null, i = +(cap.dataset.cap ?? cap.dataset.wash ?? 0), ws = dil ? 0 : rc ? rc.s : cap.dataset.wash != null ? TT_WASH[i][1] : 1;
    if (st.capEdit && !st.wash && !dil && !rc) { const inp = document.createElement('input'); inp.type = 'color'; inp.value = st.caps[i];
      inp.oninput = () => { st.caps[i] = inp.value; st.dirty = true; drawTray(); }; inp.click(); return; }
    e.preventDefault(); const capW = rc ? rc.w : (() => { const c = ttHex(ws < 1 ? TT_CAPS[0] : st.caps[i]); return Math.min(...c) > 0.85 ? 1 : 0; })();   // a white cap
    const col = dil ? st.ink.c : rc ? rc.c.slice() : ws < 1 ? ttHex(TT_CAPS[0]) : ttHex(st.caps[i]); cap.classList.add('dip'); let t0 = performance.now(); if (EX?.cur) EX.cur.dips = (EX.cur.dips || 0) + 1; SS.dips++;
    const step = (now) => { if (!dip) return; const dt = Math.min(0.1, (now - t0) / 1000); t0 = now;
      const a = dt * 0.9, frac = a / (st.ink.v + a);   // ink added this moment, and how much of the mix it is
      const wet = st.ink.v > 0.005; st.ink.c = wet ? ttMix(st.ink.c, col, frac) : col; st.ink.s = wet ? (st.ink.s ?? 1) * (1 - frac) + ws * frac : ws; st.ink.v = Math.min(1, st.ink.v + a);
      if (!dil) st.ink.w = wet ? (st.ink.w || 0) * (1 - frac) + capW * frac : capW;   // the white share of the pigment (water doesn't change it)
      drawNeedleInk(); dip.raf = requestAnimationFrame(step); };
    dip = { cap, raf: requestAnimationFrame(step) }; st.dirty = true;
  });
  const dipEnd = () => { if (!dip) return; cancelAnimationFrame(dip.raf); dip.cap.classList.remove('dip'); dip = null; };
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => tray.addEventListener(t, dipEnd));
  tray.addEventListener('click', (e) => {
    if (e.target.closest('[data-rinse]')) { st.ink = { c: [1, 1, 1], v: 0, s: 1, w: 0 }; drawNeedleInk(); return toast('Needle rinsed.', 1200); }
    if (e.target.closest('[data-set]')) { st.wash = !st.wash; st.capEdit = false; st.dirty = true; return drawTray(); }
    if (e.target.closest('[data-capedit]')) { st.capEdit = !st.capEdit; toast(st.capEdit ? 'Tap a cap to change its colour. Tap the pencil again when done.' : 'Done changing colours.', 2200); return drawTray(); }
  });
  tray.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---------- Rail, needles menu and the side panel ---------- */
  new MutationObserver(() => { if (pop.hidden) return; const sh = stage.clientHeight; pop.style.maxHeight = (sh - 16) + 'px'; pop.style.overflowY = 'auto';
    if (pop.offsetTop + pop.offsetHeight > sh - 8) pop.style.top = Math.max(8, sh - pop.offsetHeight - 8) + 'px'; }).observe(pop, { childList: true, attributes: true, attributeFilter: ['hidden'] });
  const closePop = () => { pop.hidden = true; if (adjS) adjEnd(false); };   // leaving colour adjustments unapplied puts them back
  const sel = (r) => $('#tt-rail').querySelectorAll('[data-r]').forEach(b => b.classList.toggle('on', b.dataset.r === r || (b.dataset.r === st.tool && !['layers', 'feel', 'refs'].includes(r))
    || (b.dataset.r === st.panel)));
  $('#tt-rail').onclick = (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return; const r = b.dataset.r;
    if (r === 'needles') {
      if (!pop.hidden) return closePop();
      pop.innerHTML = Object.entries(TT_KINDS).map(([kind, [, label]]) => `<div class="gh">${label}</div><div class="tt-ndg">${TT_NEEDLES.filter(n => n.kind === kind)
        .map(n => `<button class="${n.id === st.needle ? 'on' : ''}" data-nd="${n.id}" data-tip="${n.name}">${n.id}</button>`).join('')}</div>`).join('');
      pop.hidden = false; pop.style.top = Math.max(8, b.getBoundingClientRect().top - stage.getBoundingClientRect().top - 6) + 'px'; return;
    }
    if (r === 'tools') { if (!pop.hidden) return closePop(); return toolsPop(b); }
    if (r === 'place') { closePop(); return placePick(); }
    if (r === 'adjust') { if (snapE) snapFinish(); return adjOpen(b); }
    if (r === 'grid') { closePop(); st.grid.on = !st.grid.on; st.dirty = true; return placeGuides(); }
    if (r === 'pick') { closePop(); if (lsel) selCommit(); st.tool = 'pick'; sel(); placeGuides(); return toast('Tap ink in the skin to load that colour.', 1800); }
    if (r === 'ruler') { closePop(); st.ruler.on = !st.ruler.on; st.dirty = true; b.classList.toggle('on', st.ruler.on); placeGuides(); return toast(st.ruler.on ? 'Ruler on: drag its ends to place it. Strokes close to it run along its edge.' : 'Ruler off.', 2200); }
    if (r === 'sym') {
      if (!pop.hidden) return closePop();
      const S = st.sym; pop.innerHTML = `<div class="gh">Symmetry</div><div class="tt-symm">${[['off', 'Off'], ['mirror', 'Mirror'], ['quad', 'Four ways'], ['mandala', 'Mandala']].map(([k2, n]) => `<button data-sym="${k2}" class="${S.mode === k2 ? 'on' : ''}">${n}</button>`).join('')}</div>
        <label class="dz-sl" style="margin:6px 6px 2px" ${S.mode === 'mandala' ? '' : 'hidden'} data-symn><span>Sections<b id="tt-symnv">${S.n}</b></span><input type="range" min="2" max="24" step="1" value="${S.n}" data-symr></label>
        <label class="toggle" style="display:flex;margin:2px 6px 6px;border:0;min-height:30px;padding:0" ${S.mode === 'mandala' ? '' : 'hidden'} data-symm><input type="checkbox" data-symmir ${S.mir ? 'checked' : ''}><span>Mirror each section</span></label>
        <button class="btn small" style="margin:2px 6px 6px" data-symc>Centre on the page</button>`;
      pop.hidden = false; pop.style.top = Math.max(8, b.getBoundingClientRect().top - stage.getBoundingClientRect().top - 6) + 'px'; return;
    }
    if (r === 'angle') {
      if (!pop.hidden) return closePop();
      pop.innerHTML = `<div class="gh">Magnum angle</div><div class="tt-angs">${[0, 30, 45, 60, 90, 120, 135, 150].map(v => `<button data-ang="${v}" class="${st.magAng === v ? 'on' : ''}">
          <svg viewBox="0 0 24 24"><path d="M5 12h14" stroke-width="3" transform="rotate(${v} 12 12)"/></svg>${v}°</button>`).join('')}</div>
        <label class="dz-sl" style="margin:6px 6px 2px"><span id="tt-angn">${st.magTilt ? 'Offset on the lean' : 'Fine'}</span><span><b id="tt-angv">${st.magAng}°</b></span><input type="range" min="0" max="179" step="1" value="${st.magAng}" data-angr></label>
        <label class="dz-sl" style="margin:6px 6px 2px" data-tip="Roll the stack onto one end: that end goes deepest and the rest feather away. Press , and . while tattooing. Less pressure, fewer needles reach the skin."><span>Stack tilt<b id="tt-rollv">${rollText()}</b></span><input type="range" min="-100" max="100" step="5" value="${Math.round((st.magRoll || 0) * 100)}" data-angroll></label>
        <button class="btn small" data-rollzero style="margin:0 6px 6px">Flat</button>
        <label class="toggle" style="display:flex;margin:2px 6px 6px;border:0;min-height:30px;padding:0"><input type="checkbox" data-angt ${st.magTilt ? 'checked' : ''}><span>Follows the way the pen leans</span></label>
        <label class="toggle" style="display:flex;margin:0 6px 6px;border:0;min-height:30px;padding:0" data-tip="Which of the magnum's two rows leads: the shorter row in front, or the longer. Kept for every piece."><input type="checkbox" data-angf ${st.magFlip ? 'checked' : ''}><span>Short row in front</span></label>`;
      pop.hidden = false; pop.style.top = Math.max(8, b.getBoundingClientRect().top - stage.getBoundingClientRect().top - 6) + 'px'; return;
    }
    closePop();
    if (r === 'marker') { if (st.tool === 'marker' && !pop.hidden) return closePop(); if (typeof lsel !== 'undefined' && lsel) selCommit(); st.tool = 'marker'; sel(); drawCur(); return markerPop(b); }
    if (r === 'erase' && EX?.lesson && EX.cur && st.tool !== 'erase') toast('Laser in a lesson: using it fails the attempt.', 3500);
    if (r === 'needle' || r === 'erase') { st.tool = r === 'erase' ? 'erase' : 'needle'; if (CHEAT) placeGuides(); return sel(); }
    if (r === 'text' && st.letSel) { st.tool = 'text'; sel(); return letPanel(); }
    if (r === 'path') { closePop(); if (lsel) selCommit(); if (snapE) snapFinish(); st.tool = 'path'; sel(); placeGuides(); return toast('Tap to place points. Drag a point to move it, tap it for a corner. Apply tattoos it with the needle.', 3200); }
    if (r === 'blend' || r === 'fill' || r === 'shape' || r === 'lasso' || r === 'liquify' || r === 'text') { if (st.tool === r && !pop.hidden) return closePop(); if (lsel && r !== 'lasso') selCommit(); st.tool = r; sel(); drawCur(); return toolPop(b); }
    st.panel = st.panel === r ? null : r; drawSide();
  };
  pop.onclick = (e) => {
    if (e.target.closest('[data-toolreset]')) return resetTools();
    const gt = e.target.closest('[data-gt]'); if (gt) { st.grid.on = true; st.grid.type = gt.dataset.gt; st.dirty = true; pop.querySelectorAll('[data-gt]').forEach(x => x.classList.toggle('on', x === gt)); return placeGuides(); }
    const tb = e.target.closest('.tt-tb'); if (tb) { const top = pop.style.top; pop.hidden = true; $('#tt-rail').onclick({ target: tb }); pop.style.top = top; return placeGuides(); }
    const shb = e.target.closest('[data-shp]'); if (shb) { st.shape.kind = shb.dataset.shp; st.dirty = true; pop.querySelectorAll('[data-shp]').forEach(x => x.classList.toggle('on', x === shb)); return; }
    const sy = e.target.closest('[data-sym]'); if (sy) { st.sym.mode = sy.dataset.sym; st.dirty = true; pop.querySelectorAll('[data-sym]').forEach(x => x.classList.toggle('on', x === sy));
      pop.querySelector('[data-symn]').hidden = pop.querySelector('[data-symm]').hidden = st.sym.mode !== 'mandala'; $('#tt-rail [data-r="sym"]')?.classList.toggle('on', st.sym.mode !== 'off'); return placeGuides(); }
    if (e.target.closest('[data-symc]')) { st.sym.c = { x: W / 2, y: H / 2 }; st.dirty = true; return placeGuides(); }
    const g = e.target.closest('[data-ang]'); if (g) { setAng(+g.dataset.ang); pop.querySelectorAll('[data-ang]').forEach(x => x.classList.toggle('on', x === g)); return; }
    const b = e.target.closest('[data-nd]'); if (!b) return; if (EX?.lesson && b.dataset.nd !== st.needle) { st.ink = { c: [1, 1, 1], v: 0, s: 1, w: 0 }; drawNeedleInk(); } setNeedle(b.dataset.nd); st.tool = 'needle'; closePop(); sel(); if (st.panel === 'feel') drawSide(); };
  pop.oninput = (e) => {
    if (e.target.matches('[data-lassoall]')) { st.lassoAll = e.target.checked; st.dirty = true; return; }
    if (e.target.matches('[data-gsnap]')) { st.grid.snap = e.target.checked; st.dirty = true; return toast(st.grid.snap ? 'Lines follow the grid.' : 'Lines are free again.', 1400); }
    if (e.target.matches('[data-gridmm]')) { st.grid.mm = +e.target.value; $('#tt-gridv').textContent = st.grid.mm + ' mm'; st.dirty = true; return placeGuides(); }
    if (e.target.matches('[data-endless]')) { st.endless = e.target.checked; st.dirty = true; return toast(st.endless ? 'Endless ink: the needle stays loaded.' : 'Ink runs out again as you work.', 1600); }
    if (e.target.matches('[data-fast]')) { st.fast = e.target.checked; st.dirty = true; return toast(st.fast ? 'Fast lines on: pull lines as quick as you like.' : 'Fast lines off.', 1600); }
    if (e.target.matches('[data-tl]')) { const [o, f] = e.target.dataset.tl.split('.'); st[o][f] = e.target.type === 'checkbox' ? e.target.checked : +e.target.value; st.dirty = true;
      const v = e.target.closest('label').querySelector('b'); if (v) v.textContent = f === 'r' || f === 'mm' ? st[o][f] + ' mm' : Math.round(st[o][f] * 100) + '%'; return drawCur(); }
    if (e.target.matches('[data-symr]')) { st.sym.n = +e.target.value; $('#tt-symnv').textContent = st.sym.n; st.dirty = true; return placeGuides(); }
    if (e.target.matches('[data-symmir]')) { st.sym.mir = e.target.checked; st.dirty = true; return placeGuides(); }
    if (e.target.matches('[data-angr]')) { setAng(+e.target.value); pop.querySelectorAll('[data-ang]').forEach(x => x.classList.toggle('on', +x.dataset.ang === st.magAng)); }
    if (e.target.matches('[data-angroll]')) return setRoll2(+e.target.value / 100);
    if (e.target.matches('[data-angf]')) { st.magFlip = e.target.checked; Settings.set('tt_magflip', st.magFlip ? '1' : '0'); return drawCur(); }
    if (e.target.matches('[data-angt]')) { st.magTilt = e.target.checked; st.dirty = true; const n = $('#tt-angn'); if (n) n.textContent = st.magTilt ? 'Offset on the lean' : 'Fine'; drawAng(); }
  };
  function rollText() { const v = Math.round((st.magRoll || 0) * 100); return v ? `${Math.abs(v)}% ${v > 0 ? 'this end' : 'other end'}` : 'flat'; }
  function setRoll2(v) { st.magRoll = Math.max(-1, Math.min(1, Math.round(v * 20) / 20)); st.dirty = true; const b = $('#tt-rollv'); if (b) b.textContent = rollText(); const r = pop.querySelector('[data-angroll]'); if (r) r.value = Math.round(st.magRoll * 100); drawCur(); }
  pop.addEventListener('click', (e) => { if (e.target.closest('[data-rollzero]')) setRoll2(0); });
  function setAng(v) { st.magAng = ((Math.round(v) % 180) + 180) % 180; st.dirty = true; const l = $('#tt-angv'); if (l) l.textContent = st.magAng + '°'; const r = pop.querySelector('[data-angr]'); if (r) r.value = st.magAng; drawAng(); drawCur(); }
  function drawAng() { const b = $('#tt-rail [data-r="angle"]'); if (!b) return; b.hidden = !isMag();
    $('#tt-angi').setAttribute('transform', `rotate(${st.magAng} 12 12)`); $('#tt-angl').textContent = st.magTilt ? (st.magAng ? 'pen+' + st.magAng : 'pen') : st.magAng + '°'; }
  // The part of a slider that stays inside a lesson's limits, shown in green under it.
  const zoneHtml = (min, max, def, lim) => { if (!lim) return ''; const [dir, m] = lim, lo = Math.max(+min, dir > 0 ? +min : def - m), hi = Math.min(+max, dir > 0 ? def + m : +max), pc = (v) => (v - min) / (max - min) * 100; return hi > lo ? `<i class="tt-zone" style="left:${pc(lo).toFixed(1)}%;width:${(pc(hi) - pc(lo)).toFixed(1)}%" data-tip="Green stays inside the lesson limits"></i>` : ''; };
  const slider = (key, label, min, max, step, val, fmt) => `<label class="dz-sl"><span>${label}<b>${fmt ? fmt(val) : val}</b></span>
    <span class="tt-zwrap"><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-f="${key}">${zoneHtml(min, max, TT.feelBase(st.needle)[key], TT_LIMITS.feel[key])}</span></label>`;
  // A needle's slider, centred on that needle's default: `w` either way, less if the floor is nearer.
  const fslider = (key, label, w, floor, step, val, fmt) => { const b = TT.feelBase(st.needle)[key] ?? val, r = Math.min(w, b - floor), dp = step < 1 ? 2 : 0; return slider(key, label, +(b - r).toFixed(dp), +(b + r).toFixed(dp), step, val, fmt); };
  const setProfile = (k) => { const p = TT_PROFILES.find(x => x[0] === k); if (!p) return; cal.profile = k; cal.hand = p[2]; cal.fade = p[3]; cal.voltOff = p[4]; };
  const cslider = (key, label, min, max, step, val, fmt) => { const pf = TT_PROFILES.find(p => p[0] === cal.profile), def = key === 'hand' ? cal.handBase ?? (pf ? pf[2] : TT.calDefaults.hand) : key === 'fade' ? cal.fadeBase ?? (pf ? pf[3] : TT.calDefaults.fade) : TT.calDefaults[key]; return `<label class="dz-sl"><span>${label}<b>${fmt(val)}</b></span>
    <span class="tt-zwrap"><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-c="${key}">${zoneHtml(min, max, def, TT_LIMITS.cal[key])}</span></label>`; };
  const CFMT = { curve: v => v < 0 ? 'soft ' + -v : v > 0 ? 'firm ' + v : 'even', pMin: v => Math.round(v * 100) + '%', pMax: v => Math.round(v * 100) + '%', hand: v => '× ' + v, fade: v => '× ' + v, flow: v => '× ' + v, tilt0: v => v + '°', blow: v => +v ? '× ' + v : 'off', tough: v => '× ' + v };
  const curveSvg = (c) => `<svg class="tt-curve" viewBox="0 0 100 100"><path d="M0 100 ${[...Array(21)].map((_, i) => `L${i * 5} ${100 - curve(i / 20, c) * 100}`).join(' ')}"/></svg>`;
  const copySettings = async () => {
    const txt = JSON.stringify({ inkforge_tattoo_tune: 2, sw: (await caches.keys().catch(() => [])).find(k => k.startsWith('inkforge-')) || '', cal: { ...cal }, feel: JSON.parse(Settings.get('tt_feel', '{}')), look: { thin: Math.round(nlook.thin * 100), tex: Math.round(nlook.tex * 100) },
      piece: { needle: st.needle, stretch: st.stretch, magAng: st.magAng, magTilt: st.magTilt, magRoll: st.magRoll || 0, magFlip: st.magFlip }, device: { ua: navigator.userAgent, screen: [screen.width, screen.height], dpr: devicePixelRatio } });
    try { await navigator.clipboard.writeText(txt); toast('Settings copied. Paste them into a message to send on.'); } catch { await askText('Copy these settings:', txt); }
  };
  let sidePrev = null, askedFor = '', feelTab = 'start';
  const drawSide = async () => {
    const leaving = sidePrev === 'feel' && st.panel !== 'feel'; sidePrev = st.panel;
    if (leaving && TT.changed() && askedFor !== TT.canon(TT.settingsNow())) { askedFor = TT.canon(TT.settingsNow()); if (await ask('You changed your settings. Replace your saved settings with these?\n\nIf not, the changes reset the next time the app loads.')) { await TT.saveSettings(); toast('Saved: these are your settings from now on.'); } }
    sel(st.panel); side.hidden = !st.panel; if (!st.panel) return;
    if (st.panel === 'refs') {
      const us = await Promise.all(refs.map(refUrl));
      side.innerHTML = `<div class="dz-lh"><b>References ${help('Pictures that float over the skin to follow. Drag to move, a corner to resize, the dot to turn, double tap to flip. Lock one to tattoo through it.')}</b><button class="dz-ib" data-close data-tip="Close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="tt-layers">${refs.map((r, i) => `<div class="tt-lr tt-rr ${refSel === r.id ? 'on' : ''}" data-rid="${r.id}"><img src="${us[i] || ''}" alt="">
          <button class="dz-ib" data-rhide data-tip="${r.on ? 'Hide' : 'Show'}" aria-label="Hide">${r.on ? '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9 9 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.6 6.6C3.8 8.3 2 12 2 12s4 7 10 7a9 9 0 0 0 4.4-1.1"/></svg>'}</button>
          <button class="dz-ib ${r.lock ? 'on' : ''}" data-rlock data-tip="${r.lock ? 'Unlock' : 'Lock: tattoo straight through it'}" aria-label="Lock"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 ${r.lock ? '8 0v3' : '7.5-2'}"/></svg></button>
          <button class="dz-ib" data-rdel data-tip="Remove" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          <input type="range" min="0.1" max="1" step="0.05" value="${r.op}" data-rop aria-label="See-through"></div>`).join('') || '<p class="muted" style="margin:4px 2px">No references yet.</p>'}</div>
        <div class="lbl" style="margin-top:10px">Add a picture</div>
        <div class="tt-addr"><button class="btn small" data-radd="file">This device</button><button class="btn small" data-radd="refs">References</button><button class="btn small" data-radd="sten">Stencils</button><button class="btn small" data-radd="pf">Portfolio</button></div>`;
      return;
    }
    if (st.panel === 'layers') {
      side.innerHTML = `<div class="dz-lh"><b>Layers</b><button class="dz-ib" data-close data-tip="Close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="tt-layers">${[...TT_LAYERS].map(([key, n]) => `<div class="tt-lr ${st.layer === key ? 'on' : ''}" data-ly="${key}">
          <span class="nm">${n}</span>
          ${key === 'stencil' ? `<button class="dz-ib" data-stl data-tip="Load a picture to trace" aria-label="Load stencil"><svg viewBox="0 0 24 24"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v7h14v-7"/></svg></button>` : ''}
          <button class="dz-ib" data-hide data-tip="${st.hide.has(key) ? 'Show' : 'Hide'}" aria-label="Hide">${st.hide.has(key) ? '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9 9 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.6 6.6C3.8 8.3 2 12 2 12s4 7 10 7a9 9 0 0 0 4.4-1.1"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'}</button>
          <button class="dz-ib" data-clear data-tip="Clear this layer" aria-label="Clear"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
          <input type="range" min="0" max="1" step="0.05" value="${key === 'stencil' ? st.op.stencil : (st.op[key] ?? 1)}" data-lop aria-label="Opacity"></div>`).join('')}</div>
        <p class="muted dz-hint">Tap a layer to work on it. The stencil is only a guide: it isn't saved into PNGs or sent to the stencil maker.</p>`;
      return;
    }
    const nd = TT_NEEDLES.find(n => n.id === st.needle), f = feel;
    const tab = (k, n) => `<button data-ftab="${k}" class="${feelTab === k ? 'on' : ''}">${n}</button>`, intro = (s) => `<p class="tt-fintro">${s}</p>`;
    const pages = {
      start: () => `<canvas class="tt-pad" id="tt-pad" width="560" height="200"></canvas>
        <div class="tt-live" id="tt-live">Pressure – · Speed – · Tilt –</div>
        <div class="row" style="gap:6px;margin:6px 0 12px"><button class="btn small primary" style="flex:1" data-tune>Tune in (guided)</button><button class="btn small" data-padclear>Clear the pad</button></div>
        <div class="lbl">Needle size</div><div class="seg" style="margin-bottom:8px">${[[0.25, '#08'], [0.3, '#10'], [0.35, '#12']].map(([v, n]) => `<button data-sz="${v}" class="${f.size === v ? 'on' : ''}" style="flex:1">${n} · ${v} mm</button>`).join('')}</div>
        <label class="dz-sl"><span>Skin stretch<b>${st.stretch}%</b></span><span class="tt-zwrap"><input type="range" min="50" max="100" step="1" value="${st.stretch}" data-stretch>${zoneHtml(50, 100, TT_STRETCH, TT_LIMITS.look.stretch)}</span></label>
        <label class="toggle" style="display:inline-flex"><input type="checkbox" data-penonly ${TT.cal().penOnly ? 'checked' : ''}><span>Pen only (fingers move the page)</span></label>`,
      needle: () => intro(`Only the ${nd.id}. How it runs and how it puts ink in.`) + `<div class="lbl">Speed</div>
        ${fslider('volt', 'Voltage', 1.5, 0, 0.05, f.volt ?? 7, v => (+v).toFixed(2) + ' V')}
        ${fslider('hand', 'Hand speed', 23, 2, 1, f.hand, v => v + '%')}
        ${fslider('speedFade', 'Fast strokes lighten', 35, 0, 1, f.speedFade, v => v + '%')}
        <div class="lbl">Ink</div>
        ${fslider('flow', 'Ink flow', 40, 5, 1, f.flow, v => v + '%')}${fslider('bleed', 'Bleed into skin', 40, 0, 1, f.bleed, v => v + '%')}
        ${fslider('miss', 'Missed punctures when light', 40, 0, 1, f.miss, v => v + '%')}
        ${fslider('hang', 'Needle hang', 40, 0, 1, f.hang ?? 40, v => v + '%')}
        <button class="btn small" data-feelreset>Reset ${nd.id}</button>`,
      press: () => intro(`Only the ${nd.id}. How pressing and leaning the pen changes the mark.`) + `<div class="lbl">Pressure to depth</div>
        <div class="tt-crow">${curveSvg(f.pCurve)}<div style="flex:1">${slider('pCurve', 'Curve', -100, 100, 1, f.pCurve, v => v < 0 ? 'soft ' + -v : v > 0 ? 'firm ' + v : 'even')}
        ${fslider('dMin', 'Lightest', 0.12, 0, 0.01, f.dMin, v => Math.round(v * 100) + '%')}${fslider('dMax', 'Deepest', 0.3, 0, 0.01, f.dMax, v => Math.round(v * 100) + '%')}</div></div>
        <div class="lbl">Tilt</div>
        ${fslider('tiltSpread', 'Tilt spreads', 40, 0, 1, f.tiltSpread, v => v + '%')}${fslider('tiltFade', 'Tilt lightens', 30, 0, 1, f.tiltFade, v => v + '%')}`,
      all: () => intro('Every needle, on this device. Tune in sets most of these. Fine tune here if your hand changes.') + `<div class="lbl">Your hand</div>
        ${cslider('hand', 'Hand speed', 0.5, 5, 0.05, cal.hand, v => '× ' + v)}${cslider('fade', 'Fast strokes lighten', 0.05, 0.85, 0.05, cal.fade, v => '× ' + v)}
        ${cslider('flow', 'Ink flow', 1, 3, 0.05, cal.flow, v => '× ' + v)}
        <div class="lbl">Skin</div>
        ${cslider('tough', 'Skin toughness', 0.1, 2.4, 0.05, cal.tough ?? 1, v => '× ' + v)}${cslider('blow', 'Blowout sensitivity', 0, 2.4, 0.05, cal.blow ?? 1, v => +v ? '× ' + v : 'off')}
        <div class="lbl">Your pen</div>
        ${cslider('curve', 'Pressure curve', -150, 0, 1, cal.curve, v => v < 0 ? 'soft ' + -v : v > 0 ? 'firm ' + v : 'even')}
        ${cslider('pMin', 'Lightest pen reading', 0, 0.4, 0.01, cal.pMin, v => Math.round(v * 100) + '%')}${cslider('pMax', 'Hardest pen reading', 0.732, 1, 0.002, cal.pMax, v => Math.round(v * 100) + '%')}
        ${cslider('tilt0', 'Natural angle', 20, 50, 1, cal.tilt0, v => v + '°')}
        <button class="btn small" data-calreset>Reset all needles</button> <button class="btn small" data-toolreset>Reset tool settings</button>`,
      look: () => intro('How the needles look, for all needles and pieces. It takes effect on your next stroke.') + `<label class="dz-sl"><span>Needle thickness<b id="tt-thinv">${Math.round(nlook.thin * 100)}%</b></span><input type="range" min="20" max="70" step="5" value="${Math.round(nlook.thin * 100)}" data-nthin>${zoneHtml(20, 70, TT_LOOK.thin, TT_LIMITS.look.thin)}</label>
        <label class="dz-sl"><span>Magnum needle texture<b id="tt-texv">${Math.round(nlook.tex * 100)}%</b></span><input type="range" min="0" max="100" step="5" value="${Math.round(nlook.tex * 100)}" data-ntex>${zoneHtml(0, 100, TT_LOOK.tex, TT_LIMITS.look.tex)}</label>
        <button class="btn small" data-nnew>Back to default (${TT_LOOK.thin}% / ${TT_LOOK.tex}%)</button>`
    };
    side.innerHTML = `<div class="dz-lh"><b>Settings · ${nd.id} ${help('Green under a slider is the safe range for lessons. Going past it gets noted on your report.')}</b>
        <button class="dz-ib" data-close data-tip="Close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="tt-ftabs">${tab('start', 'Start')}${tab('needle', nd.id)}${tab('press', 'Pressure')}${tab('all', 'All needles')}${tab('look', 'Look')}</div>
      <div class="tt-fpage">${pages[feelTab]()}</div>
      <div class="tt-ffoot"><span class="tt-unsaved" ${TT.changed() ? '' : 'hidden'}>Unsaved changes</span><button class="btn small" data-setsave ${TT.changed() ? '' : 'disabled'} data-tip="Keep these as your settings from now on. Unsaved changes reset when the app next loads.">Save settings</button><button class="btn small" data-setexp data-tip="Save your settings to a file, to load in another workspace or on another device">Export</button><button class="btn small" data-setimp data-tip="Load settings from an exported file">Import</button></div>`;
    padInit();
  };
  side.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) { st.panel = null; return drawSide(); }
    const rid = t.closest('[data-rid]')?.dataset.rid;
    if (rid) { const r = refs.find(x => x.id === rid); if (!r) return;
      if (t.closest('[data-rhide]')) r.on = !r.on; else if (t.closest('[data-rlock]')) r.lock = !r.lock;
      else if (t.closest('[data-rdel]')) refs = refs.filter(x => x !== r); else if (!t.matches('input')) { refSel = r.id; r.on = true; } else return;
      st.dirty = true; drawRefs(); return drawSide(); }
    if (t.closest('[data-radd]')) return refAdd(t.closest('[data-radd]').dataset.radd);
    const ly = t.closest('[data-ly]')?.dataset.ly;
    if (ly) {
      if (t.closest('[data-hide]')) { st.hide.has(ly) ? st.hide.delete(ly) : st.hide.add(ly); st.dirty = true; paint(); return drawSide(); }
      if (t.closest('[data-clear]')) { if (!await ask('Clear everything on this layer? Undo brings it back.')) return;
        const c = L[ly]; snap(ly); c.getContext('2d').clearRect(0, 0, W, H); syncIn(ly); touched.add(ly); st.dirty = true; st.viewC = null; paint(); return; }
      if (t.closest('[data-stl]')) return loadStencil();
      if (t.matches('input')) return;
      st.layer = ly; st.dirty = true; return drawSide();
    }
    if (t.closest('[data-nnew]')) { nlook.thin = 0.45; nlook.tex = 1; Settings.set('tt_thin', String(Math.round(nlook.thin * 100))); Settings.set('tt_tex', String(Math.round(nlook.tex * 100))); drawCur(); return drawSide(); }
    if (t.closest('[data-sz]')) { feel.size = +t.closest('[data-sz]').dataset.sz; TT.setFeel(st.needle, feel); lay = ttLayout(TT_NEEDLES.find(n => n.id === st.needle), feel.size); drawCur(); drawSz(); return drawSide(); }
    if (t.closest('[data-feelreset]')) { TT.setFeel(st.needle, null); setNeedle(st.needle); return drawSide(); }
    if (t.closest('[data-padclear]')) return padInit();
    if (t.closest('[data-ftab]')) { feelTab = t.closest('[data-ftab]').dataset.ftab; return drawSide(); }
    if (t.closest('[data-tune]')) return tuneIn();
    if (t.closest('[data-setsave]')) { await TT.saveSettings(); toast('Saved: these are your settings from now on.'); return drawSide(); }
    if (t.closest('[data-setexp]')) { const txt = JSON.stringify({ inkforge_settings: 1, build: TT_BUILD, saved: TT.savedGet() || TT.settingsNow() }, null, 1); return saveFiles([new File([txt], `inkforge-tattoo-settings-${ymd(new Date())}.json`, { type: 'application/json' })]); }
    if (t.closest('[data-setimp]')) { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json'; inp.onchange = async () => { try { const j = JSON.parse(await inp.files[0].text()); if (!j.inkforge_settings || !j.saved?.cal) throw new Error('not a settings file'); if (!await ask('Load these settings? They replace your saved settings.')) return; await TT.applySettings(j.saved); await TT.saveSettings(); await Settings.set('tt_tuned', '1'); cal = TT.cal(); Object.assign(nlook, { thin: +j.saved.look?.thin / 100 || nlook.thin, tex: +j.saved.look?.tex / 100 || nlook.tex }); setNeedle(st.needle); drawVolt(); drawCur(); drawSide(); toast('Settings loaded. You are tuned in.'); } catch (err) { toast('Could not load that file: ' + err.message, 4000); } }; return inp.click(); }
    if (t.closest('[data-prof]')) { setProfile(t.closest('[data-prof]').dataset.prof); TT.saveCal(cal); return drawSide(); }
    if (t.closest('[data-toolreset]')) return resetTools();
    if (t.closest('[data-calreset]')) { if (!await ask('Put the calibration for all needles back to the defaults?')) return; cal = { ...TT.calDefaults, penOnly: cal.penOnly }; TT.saveCal(cal); return drawSide(); }
    if (t.matches('[data-penonly]')) { cal.penOnly = t.checked; TT.saveCal(cal); }
  });
  $('#tt-vs').addEventListener('input', (e) => { feel.volt = +e.target.value; TT.setFeel(st.needle, feel); drawVolt();
    const s2 = side.querySelector('[data-f="volt"]'); if (s2) { s2.value = feel.volt; s2.closest('.dz-sl').querySelector('b').textContent = feel.volt.toFixed(2) + ' V'; } });
  side.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-rop]')) { const r = refs.find(x => x.id === t.closest('[data-rid]').dataset.rid); if (r) { r.op = +t.value; st.dirty = true; drawRefs(); } return; }
    if (t.matches('[data-lop]')) { const ly = t.closest('[data-ly]').dataset.ly; st.op[ly] = +t.value; st.dirty = true; st.viewC = null; return paint(); }
    setTimeout(() => { const ch = TT.changed(), u = side.querySelector('.tt-unsaved'), b = side.querySelector('[data-setsave]'); if (u) u.hidden = !ch; if (b) b.disabled = !ch; }, 50);
    if (t.dataset.c) { cal[t.dataset.c] = +t.value; TT.saveCal(cal); t.closest('.dz-sl').querySelector('b').textContent = CFMT[t.dataset.c](+t.value); return; }
    if (t.matches('[data-stretch]')) { st.stretch = +t.value; st.dirty = true; t.closest('.dz-sl').querySelector('b').textContent = t.value + '%'; return; }
    const fk = t.dataset.f; if (!fk) return;
    feel[fk] = +t.value; TT.setFeel(st.needle, feel); if (fk === 'volt') drawVolt();
    const v = +t.value, b = t.closest('.dz-sl')?.querySelector('b');
    if (b) b.textContent = fk === 'pCurve' ? (v < 0 ? 'soft ' + -v : v > 0 ? 'firm ' + v : 'even') : fk === 'dMin' || fk === 'dMax' ? Math.round(v * 100) + '%' : fk === 'volt' ? v.toFixed(2) + ' V' : v + '%';
    if (fk === 'pCurve') side.querySelector('.tt-curve').outerHTML = curveSvg(feel.pCurve);
  });

  /* A strip of skin to draw on (the test pad, the Tune in tasks): `pm` px per mm. Strokes are kept as samples so
     they can be drawn again with other settings. `under` draws what goes beneath the ink (a stencil, an example). */
  const skinPad = (c, pm, under) => {
    const g = c.getContext('2d'), ink = document.createElement('canvas'); ink.width = c.width; ink.height = c.height; const ix = ink.getContext('2d');
    const pad = { strokes: [], ink, show() { g.globalCompositeOperation = 'source-over'; g.fillStyle = st.skin; g.fillRect(0, 0, c.width, c.height);
      under?.(g); g.globalCompositeOperation = 'multiply'; g.drawImage(ink, 0, 0); g.globalCompositeOperation = 'source-over'; } };
    const one = (S) => {   // a stroke's samples into ink
      let last = null, sp = 0, carry = 0; ix.fillStyle = pad.color || ttToHex(st.ink.v > 0.02 ? st.ink.c : [0.08, 0.08, 0.08]);
      for (const q of S) {
        if (!last) { last = q; continue; }
        const dx = q.x - last.x, dy = q.y - last.y, d = Math.hypot(dx, dy), dt = Math.max(1, q.t - last.t) / 1000; if (d < 0.01) continue;
        const v = d / q.s / (96 / 25.4) / dt; sp = sp ? sp * 0.7 + v * 0.3 : v;   // screen mm per second, as on the page
        const tilt = tiltOf(q), depth = depthOf(pNorm(q), sp, tilt), gap = gapMm(sp) * pm, a = turnOf(Math.atan2(dy, dx), q); setRoll(q, a);
        let tt = carry; while (tt <= d) { puncture(ix, { x: last.x + dx * tt / d, y: last.y + dy * tt / d }, a, depth, tilt, 1, false, pm); tt += gap; }
        carry = tt - d; last = q;
      }
    };
    pad.replay = () => { ix.clearRect(0, 0, ink.width, ink.height); pad.strokes.forEach(one); pad.show(); };
    pad.clear = () => { pad.strokes = []; ix.clearRect(0, 0, ink.width, ink.height); pad.show(); };
    let cur = null;
    const take = (e) => { const r = c.getBoundingClientRect(), sc = c.width / r.width, co = e.getCoalescedEvents?.();
      return (co?.length ? co : [e]).map(ev => ({ x: (ev.clientX - r.left) * sc, y: (ev.clientY - r.top) * sc, t: ev.timeStamp, s: sc, pressure: ev.pressure, tiltX: ev.tiltX, tiltY: ev.tiltY, pointerType: ev.pointerType })); };
    c.onpointerdown = (e) => { if (e.pointerType === 'touch' && TT.cal().penOnly) return; e.preventDefault(); c.setPointerCapture(e.pointerId); cur = take(e); pad.strokes.push(cur); };
    c.onpointermove = (e) => { calLive(e); if (!cur) return; const add = take(e); const from = Math.max(0, cur.length - 1); cur.push(...add); one(cur.slice(from)); pad.show(); };
    c.onpointerup = c.onpointercancel = () => { if (cur) { ix.clearRect(0, 0, ink.width, ink.height); pad.strokes.forEach(one); pad.show(); } cur = null; pad.onstroke?.(); };
    pad.show(); return pad;
  };
  // The test pad in the feel panel.
  const padInit = () => { const c = $('#tt-pad'); if (c) skinPad(c, 8); };

  let liveT = 0, liveLast = null;
  const calLive = (e) => {
    const l = $('#tt-live'); if (!l) return; const now = e.timeStamp;
    if (liveLast && now - liveT > 30) { const d = Math.hypot(e.clientX - liveLast.x, e.clientY - liveLast.y) / (now - liveT) * 1000 / (96 / 25.4); l.dataset.sp = Math.round(d); }
    if (now - liveT > 30) { liveT = now; liveLast = { x: e.clientX, y: e.clientY }; }
    l.textContent = `Pressure ${e.pointerType === 'mouse' ? 'mouse' : Math.round((e.pressure || 0) * 100) + '%'} · Speed ${l.dataset.sp || 0} mm/s · Tilt ${Math.round(Math.hypot(e.tiltX || 0, e.tiltY || 0))}°`;
  };

  /* ---------- Tune in ----------
     A few short tasks, each with a stencil to follow or an example to match. Each measures how this hand on this
     device naturally draws (pressure, speed, angle) and sets the overall calibration from it; the attempt is then
     drawn again with the new settings. The result can be copied to send on, so the defaults can learn from it. */
  const W2 = 960, H2 = 400, PM2 = 6;   // the task pad: px, and px per mm
  const pct = (a, q) => { const b = [...a].sort((m, n) => m - n); return b.length ? b[Math.min(b.length - 1, Math.max(0, Math.floor(q * (b.length - 1))))] : 0; };
  const speeds = (pad) => pad.strokes.flatMap(S => S.slice(1).map((q, i) => { const p = S[i], dt = Math.max(1, q.t - p.t) / 1000; return Math.hypot(q.x - p.x, q.y - p.y) / q.s / (96 / 25.4) / dt; })).filter(v => v > 1 && v < 3000);
  const penPress = (pad) => pad.strokes.flat().filter(q => q.pointerType === 'pen' && q.pressure > 0).map(q => q.pressure);
  const box = { x: 560, y: 145, w: 360, h: 110 }, exBox = { x: 40, y: 145, w: 360, h: 110 };
  const pbox = { x: 600, y: 110, w: 250, h: 180 }, pex = { x: 110, y: 110, w: 250, h: 180 };   // packing: 25 x 18 mm at 10 px/mm
  const sat = (pad) => { const d = pad.ink.getContext('2d').getImageData(pbox.x, pbox.y, pbox.w, pbox.h).data; let s2 = 0; for (let i = 3; i < d.length; i += 4) s2 += d[i]; return s2 / (d.length / 4) / 255; };
  const fades = {};
  const grain = (g, x0, y0, w, h, dens) => { for (let i = 0; i < w * h / 40; i++) { const xx = x0 + Math.random() * w, yy = y0 + Math.random() * h, a = dens(xx - x0, w); if (Math.random() < a) { g.globalAlpha = 0.5 + a * 0.5; g.beginPath(); g.arc(xx, yy, 1.4, 0, 7); g.fill(); } } g.globalAlpha = 1; };
  const outline = (g, b) => { g.save(); g.setLineDash([8, 6]); g.strokeStyle = 'rgba(70,40,120,.7)'; g.lineWidth = 2; g.strokeRect(b.x, b.y, b.w, b.h); g.restore(); };
  const label = (g, t, x, y) => { g.fillStyle = 'rgba(40,20,70,.75)'; g.font = '600 18px Inter, sans-serif'; g.fillText(t, x, y); };
  let exCache = {};
  const example = (kind) => exCache[kind] ||= (() => { const c = document.createElement('canvas'); c.width = W2; c.height = H2; const g = c.getContext('2d'); g.fillStyle = '#151515';
    if (kind === 'whip') grain(g, exBox.x, exBox.y, exBox.w, exBox.h, (x, w) => Math.pow(1 - x / w, 1.6));
    if (kind === 'pack') { g.globalAlpha = 0.93; g.fillRect(pex.x, pex.y, pex.w, pex.h); g.globalAlpha = 1; grain(g, pex.x, pex.y, pex.w, pex.h, () => 0.4); }
    return c; })();
  const TUNE = [
    { id: 'speed', title: 'Your hand speed', needle: '7RS', pm: 10, manual: true, text: 'Colour in the circle the way you normally pack: your usual pace, in tight circles. Do not rush or slow down for the test, as this sets your hand speed and your limits. Press Check when it is filled.',
      under: (g) => { g.strokeStyle = 'rgba(70,40,120,.6)'; g.setLineDash([8, 6]); g.lineWidth = 2; g.beginPath(); g.arc(480, 200, 120, 0, 7); g.stroke(); g.setLineDash([]); },
      live: () => '',
      fit(pad) { const sp = speeds(pad); if (sp.length < 60) return 'Keep going a little longer: colour in more of the circle, then press Check.';
        const v = pct(sp, 0.5), H2 = ttHandFrom(v); Object.assign(cal, H2, { handBase: H2.hand, fadeBase: H2.fade, tuneSpeed: Math.round(v), profile: 'measured' }); return `You work at about ${Math.round(v)} mm/s, so your hand speed is set to × ${H2.hand}. The rest of Tune in stays within your limits.`; } },
    { id: 'range', title: 'Pressure range', needle: '3RL', text: 'Draw back and forth along the strip. Start with the lightest touch you would ever use, and build up to the hardest you would ever press.',
      under: (g) => { const gr = g.createLinearGradient(80, 0, 880, 0); gr.addColorStop(0, 'rgba(70,40,120,.08)'); gr.addColorStop(1, 'rgba(70,40,120,.45)'); g.fillStyle = gr;
        g.beginPath(); g.moveTo(80, 230); g.lineTo(880, 170); g.lineTo(880, 290); g.closePath(); g.fill(); label(g, 'lightest', 80, 330); label(g, 'hardest', 800, 330); },
      fit(pad) { const ps = penPress(pad); if (ps.length < 30 || pct(ps, 0.97) - pct(ps, 0.05) < 0.15) return 'No pressure range came through (a mouse or finger has none), so pressure stays as it was.';
        cal.pMin = +(pct(ps, 0.05) * 0.9).toFixed(3); cal.pMax = +Math.max(cal.pMin + 0.1, pct(ps, 0.97)).toFixed(3);
        return `Your lightest touch reads ${Math.round(cal.pMin * 100)}% and your hardest ${Math.round(cal.pMax * 100)}% of the pen's range; that's now the full range from barely in to full depth.`; } },
    { id: 'line', title: 'Lining', needle: '3RL', text: 'Trace the stencil line the way you would pull a line: your normal pressure and speed. It should come out solid and even.',
      under: (g) => { g.strokeStyle = 'rgba(70,40,120,.55)'; g.lineWidth = 3; g.beginPath(); g.moveTo(80, 300); g.bezierCurveTo(330, 20, 600, 400, 880, 110); g.stroke(); },
      fit(pad) { const sp = speeds(pad), ps = pad.strokes.flat().filter(q => q.pointerType !== 'mouse').map(pNorm); if (sp.length < 20) return 'Not enough line to measure: trace the whole line.';
        const v = pct(sp, 0.5), f0 = feel, want = 0.1 * hzOf() * 100 / v;   // a solid line: punctures about 0.1 mm apart at your lining speed
        cal.hand = +Math.max((cal.handBase ?? TT.calDefaults.hand) - TT_LIMITS.cal.hand[1], Math.min(5, want / f0.hand)).toFixed(3); let msg = `You line at about ${Math.round(v)} mm/s; punctures now land close enough there for a solid line.`;
        if (ps.length > 20) { const pm = Math.max(0.05, Math.min(0.97, pct(ps, 0.5))), g2 = Math.log(0.85) / Math.log(pm);
          cal.curve = +Math.max(-150, Math.min(0, 50 * Math.log2(g2) - f0.pCurve)).toFixed(1); msg += ` Your normal lining pressure (${Math.round(pm * 100)}% of your range) now goes in firmly.`; }
        return msg; } },
    { id: 'rsline', title: 'Lining with a round shader', needle: '5RS', text: 'Trace the line again with a round shader. Its tight bundle makes a bold, clean line, but it blows out just like a liner if you press in hard while moving slowly. Nothing changes here: this shows how close your line came.',
      under: (g) => { g.strokeStyle = 'rgba(70,40,120,.55)'; g.lineWidth = 3; g.beginPath(); g.moveTo(80, 110); g.bezierCurveTo(330, 390, 600, 20, 880, 300); g.stroke(); },
      fit(pad) { const pts = pad.strokes.flatMap(S => S.slice(1).map((q, j) => { const p = S[j], v = Math.hypot(q.x - p.x, q.y - p.y) / q.s / (96 / 25.4) / (Math.max(1, q.t - p.t) / 1000); return { pr: pNorm(q), v }; })).filter(s => s.v < 3000); if (pts.length < 20) return 'Not enough line to measure: trace the whole line.';
        const bad = pts.filter(s => depthOf(s.pr, s.v, 0) > blowD() && gapMm(s.v) < 0.035).length / pts.length, near = pts.filter(s => depthOf(s.pr, s.v, 0) > blowD() && gapMm(s.v) < 0.06).length / pts.length;
        return bad > 0.02 ? `About ${Math.round(bad * 100)}% of that line would risk a blowout: you were deep and slow. Ease off or keep moving.` : near > 0.05 ? 'Clean, but parts came close to blowing out. Watch the slow spots where you press in.' : 'Clean: your pressure and speed stayed clear of a blowout.'; } },
    { id: 'shade', title: 'Whip shading', needle: '7RS', text: 'Shade the empty box to match the example: start each stroke slow and pressed in at the dark (left) end, and flick out fast and light to the right.',
      under: (g) => { g.drawImage(example('whip'), 0, 0); outline(g, box); label(g, 'example', exBox.x, exBox.y - 12); label(g, 'yours', box.x, box.y - 12); },
      fit(pad) { const sp = speeds(pad); if (sp.length < 20) return 'Not enough shading to measure: do several strokes.';
        const v = pct(sp, 0.9), want = 0.1 * 200 * 100 / v;   // pressure does most of a whip's fade; your flick speed takes about a tenth off on top
        cal.fade = +Math.max((cal.fadeBase ?? TT.calDefaults.fade) - TT_LIMITS.cal.fade[1], Math.min(0.85, want / feel.speedFade)).toFixed(3); fades.whip = cal.fade;
        return `Your flicks reach about ${Math.round(v)} mm/s; at that speed the needle now fades out like whip shading.`; } },
    { id: 'pend', title: 'Pendulum shading', needle: '7RS', text: 'Swing back and forth across the band like a pendulum: a soft entry, press in through the middle, feather out at the end, and reverse. Keep a steady rhythm for several swings.',
      under: (g) => { const gr = g.createLinearGradient(160, 0, 800, 0); [[0, 0], [0.5, 0.5], [1, 0]].forEach(([p, a]) => gr.addColorStop(p, `rgba(20,20,20,${a})`)); g.fillStyle = gr; g.fillRect(160, 160, 640, 80);
        g.strokeStyle = 'rgba(70,40,120,.5)'; g.setLineDash([6, 6]); g.strokeRect(160, 160, 640, 80); g.setLineDash([]); label(g, 'feather', 160, 270); label(g, 'press in', 440, 270); label(g, 'feather', 740, 270); },
      fit(pad) {
        // one long back-and-forth stroke or several: each swing's middle speed, averaged
        const mids = [];
        for (const S of pad.strokes) { let seg = [];
          const flush = () => { if (seg.length > 6) { const m = seg.slice(Math.floor(seg.length * 0.35), Math.ceil(seg.length * 0.65)); if (m.length) mids.push(m.reduce((a, b) => a + b, 0) / m.length); } seg = []; };
          let dir = 0; for (let j = 1; j < S.length; j++) { const p = S[j - 1], q = S[j], dx = q.x - p.x, dt = Math.max(1, q.t - p.t) / 1000, v = Math.hypot(dx, q.y - p.y) / q.s / (96 / 25.4) / dt;
            const nd = Math.sign(dx); if (nd && dir && nd !== dir) flush(); if (nd) dir = nd; if (v > 1 && v < 3000) seg.push(v); }
          flush(); }
        if (mids.length < 3) return 'Do a few more swings, back and forth.';
        const v = mids.reduce((a, b) => a + b, 0) / mids.length, want = 0.06 * 200 * 100 / v;   // mid-swing: a little lighter than a held stroke
        const pf = Math.max((cal.fadeBase ?? TT.calDefaults.fade) - TT_LIMITS.cal.fade[1], Math.min(0.85, want / feel.speedFade)); fades.pend = pf;
        cal.fade = +(fades.whip ? (fades.whip + pf) / 2 : pf).toFixed(3);
        return `${mids.length} swings at about ${Math.round(v)} mm/s through the middle. ${fades.whip ? 'Fast strokes now fade halfway between your whip shading and your pendulum.' : 'Fast strokes now fade to suit your swing.'}`; } },
    { id: 'tilt', title: 'How you hold it', needle: '3RL', text: 'Draw a few lines holding the pen the way you hold your machine.',
      under: (g) => { g.strokeStyle = 'rgba(70,40,120,.4)'; g.lineWidth = 2; for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(100 + i * 200, 320); g.lineTo(220 + i * 200, 80); g.stroke(); } },
      fit(pad) { const ts = pad.strokes.flat().filter(q => q.pointerType === 'pen').map(q => Math.hypot(q.tiltX || 0, q.tiltY || 0)); if (ts.length < 20 || pct(ts, 0.9) < 2) return 'This pen doesn\u2019t report tilt (or it was held straight up), so tilt stays as it was.';
        cal.tilt0 = Math.round(Math.max(20, Math.min(50, pct(ts, 0.5)))); return `You hold it at about ${cal.tilt0}\u00b0; tilt now counts from there, so your normal grip doesn't spread the needles.`; } },
    { id: 'pack', title: 'Packing', needle: '15CM', pm: 10, manual: true,
      text: 'Pack the small box solid with your usual colour-packing technique, for example small, tight circles that overlap, until it looks like the example. The saturation shows as you go; press Check when you would call it done.',
      under: (g) => { g.drawImage(example('pack'), 0, 0); outline(g, pbox); label(g, 'example', pex.x, pex.y - 12); label(g, 'yours', pbox.x, pbox.y - 12); },
      live: (pad) => `Saturation ${Math.round(sat(pad) * 100)}%`,
      fit(pad) { if (!pad.strokes.length) return 'Pack the box first.';
        const cov = sat(pad);
        const before = cal.flow; if (cov < 0.88) cal.flow = +Math.min(TT.calDefaults.flow + TT_LIMITS.cal.flow[1], cal.flow * 0.9 / Math.max(0.2, cov)).toFixed(3); else if (cov > 0.98) cal.flow = +Math.max(1, cal.flow * 0.95).toFixed(3);
        const v = pct(speeds(pad), 0.5), fast = v > 150 ? ` You packed fast (about ${Math.round(v)} mm/s): slower, overlapping passes go in darker, as on skin.` : '';
        return `Your packing covered ${Math.round(cov * 100)}% of the box.${fast} ${cal.flow > before ? 'Ink now goes in a little more readily.' : cal.flow < before ? 'Ink now goes in a touch less readily.' : 'That\u2019s about right, so ink flow stays.'}`; } },
    { id: 'skin', title: 'Skin and blowouts', needle: '3RL', noPad: true, text: 'These are a matter of taste, so set them by feel. The middle of each slider is the default; you can come back and change them any time.',
      sliders: [['cal', 'tough', 'Skin toughness: higher takes longer to redden and swell', 0.1, TT.calDefaults.tough + TT_LIMITS.cal.tough[1], 0.05, v => '× ' + v], ['cal', 'blow', 'Blowout sensitivity: higher blows out more easily', TT.calDefaults.blow - TT_LIMITS.cal.blow[1], 2.4, 0.05, v => +v ? '× ' + v : 'off']] },
    { id: 'look', title: 'Needle look', needle: '15M1', pm: 10, text: 'Draw on the pad and set how the needles should look. Thickness is for all needles, texture for magnums. New strokes use the change, so draw again after moving a slider.',
      sliders: [['look', 'thin', 'Needle thickness', 20, TT_LOOK.thin + TT_LIMITS.look.thin[1], 5, v => v + '%'], ['look', 'tex', 'Magnum needle texture', TT_LOOK.tex - TT_LIMITS.look.tex[1], 100, 5, v => v + '%']] }
  ];
  const tuneIn = () => {
    const keep = { needle: st.needle, stretch: st.stretch, ink: st.ink }, was = { ...cal }, wasLook = { ...nlook }; st.stretch = 75;
    const o = document.createElement('div'); o.id = 'merge-dlg'; o.className = 'tt-tune'; o.style.zIndex = 98; document.body.appendChild(o);
    let i = -1, pad = null, msg = '', before = null, beforeLook = null;
    const saveLook = () => { Settings.set('tt_thin', String(Math.round(nlook.thin * 100))); Settings.set('tt_tex', String(Math.round(nlook.tex * 100))); };
    const finish = () => { setNeedle(keep.needle); st.stretch = keep.stretch; st.ink = keep.ink; o.remove(); if (meta.tuneOnly) { st.dirty = false; Dirty.set(false); location.hash = 'tattoo/lessons'; return; } drawSide(); };
    const draw = () => {
      if (i >= TUNE.length) {
        const D = { ...TT.calDefaults, hand: cal.handBase ?? TT.calDefaults.hand, fade: cal.fadeBase ?? TT.calDefaults.fade }, x = v => '× ' + v, cv = v => v > 0 ? 'firm ' + Math.round(v) : v < 0 ? 'soft ' + Math.round(-v) : 'even', pc = v => Math.round(v * 100) + '%';
        const rows = [['Lightest pen reading', pc(cal.pMin), pc(D.pMin)], ['Hardest pen reading', pc(cal.pMax), pc(D.pMax)], ['Pressure curve', cv(cal.curve), cv(D.curve)], ['Hand speed', x(cal.hand), x(D.hand)], ['Fast strokes lighten', x(cal.fade), x(D.fade)], ['Natural angle', cal.tilt0 + '°', D.tilt0 + '°'], ['Ink flow', x(cal.flow), x(D.flow)],
          ['Skin toughness', x(cal.tough), x(D.tough)], ['Blowout sensitivity', +cal.blow ? x(cal.blow) : 'off', x(D.blow)], ['Needle thickness', pc(nlook.thin), '45%'], ['Magnum texture', pc(nlook.tex), '100%']];
        o.innerHTML = `<div class="card tt-tcard"><h2>Tuned in</h2><p class="muted" style="margin-top:0">These apply to every needle on this device. Each needle's own settings still sit on top, under the sliders icon.</p>
          <div class="tt-sum tt-sum3"><span class="muted">Setting</span><span class="muted">Default</span><span class="muted">Yours</span>${rows.map(([a, b, c]) => `<span>${a}</span><span class="muted">${c}</span><b>${b}</b>`).join('')}</div>
          <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:12px"><button class="btn" data-t="again">Back to defaults, start over</button><button class="btn" data-t="copy" data-tip="Copy every setting as text">Copy settings</button>
            <span style="flex:1"></span><button class="btn" data-t="cancel">Undo all</button><button class="btn primary" data-t="save">Save</button></div></div>`;
        return;
      }
      if (i < 0) {
        o.innerHTML = `<div class="card tt-tcard"><h2>Tune in</h2><p class="muted" style="margin-top:0">Fit the simulator to your pen and hand in ${TUNE.length} short steps, starting with your hand speed. Each step shows what it changed, and everything stays inside the lesson limits. You can skip a step to leave that setting alone. Nothing is kept until you press Save at the end.</p>
          <div class="row" style="gap:6px;margin-top:14px"><span style="flex:1"></span><button class="btn" data-t="exit">Stop</button><button class="btn primary" data-t="next">Start</button></div></div>`;
        return;
      }
      const T = TUNE[i]; setNeedle(T.needle);
      o.innerHTML = `<div class="card tt-tcard"><div class="tt-tsteps">${TUNE.map((x, j) => `<i class="${j < i ? 'done' : j === i ? 'on' : ''}"></i>`).join('')}</div>
        <h2>${i + 1} of ${TUNE.length}. ${T.title}</h2><p class="muted" style="margin:0 0 8px">${T.text}</p>
        ${(T.sliders || []).map(([w, k, n, mn, mx, s, fm]) => { const v = w === 'look' ? Math.round(nlook[k] * 100) : cal[k]; return `<label class="dz-sl"><span>${n}<b>${fm(v)}</b></span><input type="range" min="${mn}" max="${mx}" step="${s}" value="${v}" data-ts="${w}.${k}"></label>`; }).join('')}
        <canvas class="tt-tpad" width="${W2}" height="${H2}" ${T.noPad ? 'hidden' : ''}></canvas>
        <p class="tt-tmsg">${T.sliders ? '' : msg || '&nbsp;'}</p>
        <div class="row" style="gap:6px"><button class="btn" data-t="skip">Skip</button><button class="btn" data-t="redo">Try again</button><span style="flex:1"></span>
          <button class="btn" data-t="exit">Stop</button>${T.manual && !msg ? '<button class="btn" data-t="check">Check</button>' : ''}<button class="btn primary" data-t="next" ${msg || T.sliders ? '' : 'disabled'}>${msg || T.sliders ? (i === TUNE.length - 1 ? 'Finish' : 'Next') : 'Draw first'}</button></div></div>`;
      pad = skinPad(o.querySelector('canvas'), T.pm || PM2, T.under); pad.color = '#161616';
      before = { ...cal }; beforeLook = { ...nlook };
      if (T.sliders) { o.querySelectorAll('[data-ts]').forEach(n => n.oninput = () => { const [w, k] = n.dataset.ts.split('.'), S = T.sliders.find(r => r[1] === k); if (w === 'look') nlook[k] = +n.value / 100; else cal[k] = +n.value; n.closest('.dz-sl').querySelector('b').textContent = S[6](+n.value); }); return; }
      const fitNow = () => { Object.assign(cal, before); msg = T.fit(pad); pad.replay(); o.querySelector('.tt-tmsg').textContent = msg + (T.live?.(pad) ? ' ' + T.live(pad) + ' with the new settings.' : '');
        const nb = o.querySelector('[data-t="next"]'); nb.disabled = false; nb.textContent = i === TUNE.length - 1 ? 'Finish' : 'Next'; o.querySelector('[data-t="check"]')?.remove(); };
      pad.check = fitNow;
      if (T.manual) { pad.onstroke = () => { o.querySelector('.tt-tmsg').textContent = T.live(pad); }; return; }
      pad.onstroke = () => { clearTimeout(pad.tm); pad.tm = setTimeout(() => {   // a moment after drawing: measure, set, draw it again with the result
        Object.assign(cal, before); msg = T.fit(pad); pad.replay();
        o.querySelector('.tt-tmsg').textContent = msg; const nb = o.querySelector('[data-t="next"]'); nb.disabled = false; nb.textContent = i === TUNE.length - 1 ? 'Finish' : 'Next'; }, 900); };
    };
    o.onclick = async (e) => {
      const pf = e.target.closest('[data-prof]'); if (pf) { setProfile(pf.dataset.prof); o.querySelectorAll('[data-prof]').forEach(b => b.classList.toggle('on', b === pf)); return; }
      const a = e.target.closest('[data-t]')?.dataset.t; if (!a) return;
      if (a === 'next') { i++; msg = ''; return draw(); }
      if (a === 'check') return pad?.check();
      if (a === 'skip') { Object.assign(cal, before || cal); Object.assign(nlook, beforeLook || nlook); i++; msg = ''; return draw(); }
      if (a === 'redo') { Object.assign(cal, before); Object.assign(nlook, beforeLook); msg = ''; return draw(); }
      if (a === 'exit' || a === 'cancel') { Object.assign(cal, was); Object.assign(nlook, wasLook); return finish(); }
      if (a === 'again') { Object.assign(cal, { ...TT.calDefaults, penOnly: cal.penOnly }); nlook.thin = 0.45; nlook.tex = 1; i = -1; msg = ''; return draw(); }
      if (a === 'save') { TT.saveCal(cal); saveLook(); Settings.set('tt_tuned', '1'); await TT.saveSettings(); toast('Saved: every needle now uses your calibration.'); return finish(); }
      if (a === 'copy') return copySettings();
    };
    draw();
  };

  /* ---------- Stencil picture ---------- */
  const loadStencil = async () => {
    const pick = await new Promise((res) => {
      const o = document.createElement('div'); o.id = 'merge-dlg'; o.style.zIndex = 99;
      o.innerHTML = `<div class="card"><h2>Stencil to trace</h2><div class="dz-ex">
        <button data-src="file"><b>From this device</b><small>A photo or drawing</small></button>
        <button data-src="sten"><b>From your stencils</b><small>Portfolio › Stencils</small></button>
        <button data-src="refs"><b>From references</b><small>Portfolio › References</small></button></div>
        <button class="btn" data-src="" style="width:100%;margin-top:10px">Cancel</button></div>`;
      o.onclick = (e) => { const b = e.target.closest('[data-src]'); if (!b) return; o.remove(); res(b.dataset.src); };
      document.body.appendChild(o);
    });
    let url = null;
    if (pick === 'file') url = await new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => res(i.files[0] ? URL.createObjectURL(i.files[0]) : null); i.click(); });
    else if (pick === 'refs' && typeof dzPortfolioPick === 'function') { const ref = await dzPortfolioPick('refs'); url = ref && await Media.url(ref); }
    else if (pick === 'sten') {
      const rows = await DB.all('SELECT id, name, stencil_ref, thumb_ref FROM stencils ORDER BY created_at DESC LIMIT 200');
      if (!rows.length) return toast('No stencils kept yet: make one in the stencil maker and press Keep.');
      const us = await Promise.all(rows.map(r => Media.url(r.thumb_ref)));
      const ref = await new Promise((res) => { const o = document.createElement('div'); o.id = 'merge-dlg'; o.style.zIndex = 99;
        o.innerHTML = `<div class="card dz-pick"><h2>Your stencils</h2><div class="dz-pf">${rows.map((r, i) => `<button data-v="${esc(r.stencil_ref)}" title="${esc(r.name || '')}" style="background:#fff"><img src="${us[i]}" alt="" style="object-fit:contain"></button>`).join('')}</div>
          <button class="btn" data-v="" style="width:100%;margin-top:10px">Cancel</button></div>`;
        o.onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; o.remove(); res(b.dataset.v || null); }; document.body.appendChild(o); });
      url = ref && await Media.url(ref);
    }
    if (!url) return;
    const im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = url; }); if (!im) return toast('Could not read that picture.');
    const c = L.stencil, cx = c.getContext('2d'); snap('stencil'); touched.add('stencil');
    cx.clearRect(0, 0, W, H); const s = Math.min(W * 0.9 / im.naturalWidth, H * 0.9 / im.naturalHeight), w = im.naturalWidth * s, h = im.naturalHeight * s;
    cx.drawImage(im, (W - w) / 2, (H - h) / 2, w, h); ttPurple(cx, W, H); st.hide.delete('stencil'); st.dirty = true; paint(); drawSide();
  };

  /* ---------- Saving and exporting ---------- */
  // The piece as one picture. `mode`: as worked or fresh (with the worked skin), healed or aged (blowouts stay).
  const composite = (scale = 1, withSkin = true, mode = 'work') => {
    const c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale); const g = c.getContext('2d'); g.scale(scale, scale);
    const raw = mode === 'work' || mode === 'fresh';
    if (withSkin) { if (raw && trDirty) buildTrauma(); g.drawImage(skin, 0, 0); skinUnder(g, raw); }
    for (const key of TT_DRAW) { if (key === 'stencil' || key === 'marker' || st.hide.has(key)) continue; g.globalAlpha = st.op[key] ?? 1; g.globalCompositeOperation = key === 'high' || !withSkin ? 'source-over' : 'multiply'; g.drawImage(L[key], 0, 0); if (key === 'high' && raw) g.drawImage(L[key], 0, 0); }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; if (withSkin && raw) skinOver(g);
    return c;
  };
  const blobOf = (c) => new Promise(r => c.toBlob(r, 'image/png'));
  const save = async (quiet) => {
    st.dirty = false;   // cleared first: anything done while this save runs marks it dirty again
    try {
    const old = await DB.one('SELECT * FROM tattoo_pieces WHERE id = ?', [id]), chgd = new Set(touched); touched.clear();
    const layerRefs = {}; for (const [key] of TT_LAYERS) layerRefs[key] = chgd.has(key) || !old ? await Media.save(await blobOf(L[key]), 'png') : old[key + '_ref'];
    const thumb = await Media.save(await blobOf(composite(Math.min(1, 420 / Math.max(W, H)))), 'png');
    const tc = document.createElement('canvas'); tc.width = tw; tc.height = th; const tg = tc.getContext('2d'), ti = tg.createImageData(tw, th);
    for (let i = 0; i < TR.length; i++) { const v = Math.min(255, Math.round(TR[i] / 2 * 255)); ti.data[i * 4] = v; ti.data[i * 4 + 1] = Math.min(255, Math.round(TP[i] / 2 * 255)); ti.data[i * 4 + 2] = Math.round(BU[i] * 255); ti.data[i * 4 + 3] = 255; }
    tg.putImageData(ti, 0, 0);
    let hcRef = null; if (HC.some(v => v > 0)) { const hc = document.createElement('canvas'); hc.width = tw; hc.height = th; const hg = hc.getContext('2d'), hi = hg.createImageData(tw, th); for (let i = 0; i < HC.length; i++) { const v = Math.min(255, Math.round(20 * Math.log2(1 + HC[i]))); hi.data[i * 4] = hi.data[i * 4 + 1] = hi.data[i * 4 + 2] = v; hi.data[i * 4 + 3] = 255; } hg.putImageData(hi, 0, 0); hcRef = await Media.save(await blobOf(hc), 'png'); }
    const skinRef = TR.some(v => v > 0.004) ? await Media.save(await blobOf(tc), 'png') : null, blowRef = await Media.save(await blobOf(blowC), 'png');
    const tlDrop = [];
    tlDrop.push(...TL.refs.splice(0));
    await DB.run(`UPDATE tattoo_pieces SET name = ?, ${TT_LAYERS.map(([key]) => key + '_ref = ?').join(', ')}, thumb_ref = ?, skin_ref = ?, blow_ref = ?, meta = ?, updated_at = datetime('now') WHERE id = ?`,
      [$('#tt-name')?.value.trim() || st.name, ...TT_LAYERS.map(([key]) => layerRefs[key]), thumb, skinRef, blowRef,
        (keepPrefs(), JSON.stringify({ hc: hcRef || undefined, layer: st.layer, needle: st.needle, hide: [...st.hide], op: st.op, ink: ttToHex(st.ink.c), inkV: st.ink.v, inkS: st.ink.s ?? 1, inkW: st.ink.w || 0, bu: 1, wash: st.wash || undefined, caps: st.caps, recent: st.recent.length ? st.recent : undefined, stretch: st.stretch, magAng: st.magAng, magRoll: st.magRoll || undefined, magTilt: st.magTilt, rot: st.rot, refs: refs.map(({ _u, ...r }) => r), exam: EX || undefined,  stats: SS, mk: st.mk, cheat: CHEAT || undefined, smooth: CHEAT ? st.smooth : undefined, ruler: CHEAT ? st.ruler : undefined, sym: CHEAT ? st.sym : undefined, blend: CHEAT ? st.blend : undefined, fillo: CHEAT ? st.fillo : undefined, shape: CHEAT ? st.shape : undefined, fast: CHEAT && st.fast || undefined, lassoAll: CHEAT && st.lassoAll || undefined, grid: CHEAT ? st.grid : undefined, liq: CHEAT ? st.liq : undefined, letters: CHEAT && st.letters.length ? st.letters : undefined, letDef: CHEAT ? st.letDef : undefined, endless: CHEAT && st.endless || undefined, pathP: CHEAT ? st.pathP : undefined })), id]);
    for (const r of tlDrop) await Media.release(r);
    if (old) for (const r of [old.thumb_ref, old.skin_ref, old.blow_ref, ...TT_LAYERS.map(([key]) => old[key + '_ref'])]) if (r && !Object.values(layerRefs).includes(r) && ![thumb, skinRef, blowRef].includes(r)) await Media.release(r);
    if (!quiet) toast('Saved.');
    } catch (err) { st.dirty = true; TT_LAYERS.forEach(([key]) => touched.add(key)); if (!quiet) toast('Could not save: ' + err.message, 5000); throw err; }
  };
  $('#tt-save').onclick = () => save();
  $('#tt-back').onclick = async () => { if (st.dirty) await save(true); location.hash = 'tattoo'; };
  /* Autosave: leaving by any route (the device's back button too), the app going to the background, and every
     40 s of work, so a slip never loses a piece. */
  let saving = null;
  const autosave = () => { if (!st.dirty || saving || pen) return; saving = save(true).catch(() => {}).finally(() => { saving = null; }); };
  // Leaving lets go of everything that pointed back into this page (keys, full screen, the resize watcher), so its
  // canvases and undo steps can be freed; a tablet has no keyboard to trip the old "remove on next key" check.
  const onHash = () => { if (location.hash !== '#tattoo/' + id) { removeEventListener('hashchange', onHash); document.removeEventListener('visibilitychange', onVis); clearInterval(autoT);
    removeEventListener('keydown', keys); removeEventListener('keyup', keys); document.removeEventListener('fullscreenchange', fsShow); ttRO.disconnect(); autosave(); } };
  const onVis = () => { if (document.visibilityState === 'hidden') autosave(); };
  const autoT = setInterval(() => { if (!document.body.contains(el)) return onHash(); autosave(); }, 40000);
  addEventListener('hashchange', onHash); document.addEventListener('visibilitychange', onVis);
  $('#tt-name').onchange = () => { st.dirty = true; };
  $('#tt-undo').onclick = undo; $('#tt-redo').onclick = redo;
  const VIEWS = [['work', ''], ['fresh', 'Fresh'], ['healed', 'Healed'], ['aged', '10 yrs']];
  const drawView = () => { const b = $('#tt-view'); if (!b) return; b.querySelector('b').textContent = VIEWS.find(v => v[0] === st.view)[1]; b.classList.toggle('on', st.view !== 'work'); };
  $('#tt-view').onclick = () => { const i = VIEWS.findIndex(v => v[0] === st.view); st.view = VIEWS[(i + 1) % VIEWS.length][0]; st.viewC = null; drawView(); paint();
    toast({ work: 'As you worked it', fresh: 'Fresh: just tattooed, the skin around it red and raised', healed: 'Healed: settled into the skin, a touch softer', aged: 'After about 10 years: softer edges and faded colour' }[st.view], 2400); };
  $('#tt-png').onclick = async () => {   // on its skin, or the ink alone on a clear background (to use anywhere)
    const pick = await new Promise((res) => { const o = document.createElement('div'); o.id = 'merge-dlg';
      o.innerHTML = `<div class="card"><h2>Save as PNG</h2><div class="dz-ex"><button data-pg="skin"><b>On the skin</b><small>The whole page as you see it</small></button><button data-pg="clear"><b>Ink only</b><small>No skin: a clear background, cropped to the tattoo</small></button></div>
        <button class="btn" data-pg="" style="width:100%;margin-top:10px">Cancel</button></div>`;
      o.onclick = (e) => { const b = e.target.closest('[data-pg]'); if (!b) return; o.remove(); res(b.dataset.pg); }; document.body.appendChild(o); });
    if (!pick) return; if (lsel) selCommit(); if (snapE) snapFinish();
    const c = pick === 'skin' ? composite() : inkPng(); if (!c) return toast('There\u2019s no ink to save yet.');
    const name = (($('#tt-name').value || 'tattoo').replace(/[^\w-]+/g, '_')) + (pick === 'clear' ? '-ink' : '') + '.png';
    await saveFiles([new File([await blobOf(c)], name, { type: 'image/png' })]); };
  /* ---------- Stats ---------- */
  const tlFmt = (ms) => { const s = Math.round(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const tlDist = (mm) => mm >= 1000 ? (mm / 1000).toFixed(2) + ' m' : mm >= 100 ? (mm / 10).toFixed(1) + ' cm' : Math.round(mm) + ' mm';
  // Full screen: the whole app, so the skin gets the browser's bars too; the icon follows the state.
  const fsBtn = $('#tt-fs'), fsShow = () => { if (!document.body.contains(fsBtn)) return document.removeEventListener('fullscreenchange', fsShow); const on = FS.on();
    fsBtn.innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    fsBtn.dataset.tip = on ? 'Exit full screen' : 'Full screen'; setTimeout(fit, 120); };
  fsBtn.onclick = () => FS.set(!FS.on()); document.addEventListener('fullscreenchange', fsShow); fsShow();
  /* ---------- Save to portfolio ----------
     One picture of the piece: the stencil (if there is one), fresh, healed and 10 years side by side, cropped to the
     work, and for a challenge its score card underneath. Kept in Portfolio › Simulator (art tagged "simulator"). */
  const workBox = () => { let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (const key of [...INK, 'stencil', 'marker']) { const D = !INK.includes(key) ? L[key].getContext('2d').getImageData(0, 0, W, H).data : imgd[key].data;
      for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) if (D[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    if (x1 < 0) return { x: 0, y: 0, w: W, h: H }; const pad = 6 * mm;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W, x1 + pad); y1 = Math.min(H, y1 + pad); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };
  // Just the ink (no skin, stencil or marker), on a clear background, cropped to where the ink is.
  const inkPng = () => { let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (const key of INK) { if (st.hide.has(key)) continue; const D = imgd[key].data; for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (D[(y * W + x) * 4 + 3] > 6) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    if (x1 < 0) return null; const pad = 2 * mm; x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad)); x1 = Math.min(W, Math.ceil(x1 + pad)); y1 = Math.min(H, Math.ceil(y1 + pad));
    const full = composite(1, false), c = document.createElement('canvas'); c.width = x1 - x0; c.height = y1 - y0; c.getContext('2d').drawImage(full, x0, y0, c.width, c.height, 0, 0, c.width, c.height); return c; };
  const sheetOf = async (card) => {
    const b = workBox(), has = (key) => { const D = L[key].getContext('2d').getImageData(b.x, b.y, b.w, b.h).data; for (let i = 3; i < D.length; i += 16) if (D[i] > 8) return true; return false; }, hasSten = has('stencil') || has('marker');
    const panels = [];
    if (hasSten) { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.fillStyle = '#f6f3ee'; g.fillRect(0, 0, W, H); g.drawImage(L.stencil, 0, 0); g.drawImage(L.marker, 0, 0); panels.push([has('marker') ? (has('stencil') ? 'Stencil and marker' : 'Marker') : 'Stencil', c]); }
    for (const [mode, label] of [['fresh', 'Fresh'], ['healed', 'Healed'], ['aged', '10 years']]) panels.push([label, viewOf(mode)]);
    const pw = 720, ph = Math.round(pw * b.h / b.w), gap = 36, M = 60, cw = M * 2 + panels.length * pw + (panels.length - 1) * gap;
    const cardW = card ? Math.min(cw - M * 2, 900) : 0, cardH = card ? Math.round(cardW / card.width * card.height) : 0, chH = 150 + ph + 70 + (card ? cardH + 40 : 0);
    const c = document.createElement('canvas'); c.width = cw; c.height = chH; const g = c.getContext('2d');
    g.fillStyle = '#121617'; g.fillRect(0, 0, cw, chH);
    g.fillStyle = '#e9e3d6'; g.font = "60px 'Pirata One', serif"; g.fillText($('#tt-name')?.value.trim() || st.name || 'Piece', M, 95);
    g.fillStyle = '#9aa5a6'; g.font = '600 26px Inter, sans-serif'; g.fillText(`Tattoo simulator · ${new Date().toLocaleDateString()}`, M, 132);
    if (CHEAT) {   // the cheat stamp, in the header beside the title (never on the work itself)
      g.save(); g.translate(cw - M - 250, 82); g.rotate(-0.06); g.strokeStyle = '#ff6f61'; g.lineWidth = 5; g.fillStyle = 'rgba(255,111,97,.12)';
      g.beginPath(); g.roundRect?.(-250, -56, 500, 104, 14) ?? g.rect(-250, -56, 500, 104); g.fill(); g.stroke();
      g.fillStyle = '#ff6f61'; g.textAlign = 'center'; g.font = '900 46px Inter, sans-serif'; g.fillText('CHEAT MODE', 0, 6);
      g.font = '600 20px Inter, sans-serif'; g.fillText('No skin was harmed. Neither were any rules. Probably.', 0, 36); g.restore(); }
    panels.forEach(([label, pc], i) => { const x = M + i * (pw + gap); g.drawImage(pc, b.x, b.y, b.w, b.h, x, 160, pw, ph);
      g.fillStyle = '#e9e3d6'; g.font = '700 26px Inter, sans-serif'; g.fillText(label, x, 160 + ph + 42); });
    if (card) g.drawImage(card, (cw - cardW) / 2, 160 + ph + 80, cardW, cardH);   // the score card, centred under the stages
    return c; };
  const toPortfolio = async (card, title) => {
    toast('Saving to portfolio…', 1500);
    const sh = await sheetOf(card), blob = await new Promise(r => sh.toBlob(r, 'image/jpeg', 0.9));
    const tc = document.createElement('canvas'), ts = Math.min(1, 520 / sh.width); tc.width = Math.round(sh.width * ts); tc.height = Math.round(sh.height * ts); tc.getContext('2d').drawImage(sh, 0, 0, tc.width, tc.height);
    const tb = await new Promise(r => tc.toBlob(r, 'image/jpeg', 0.85)), photo = await Media.save(blob, 'jpg'), thumb = await Media.save(tb, 'jpg');
    await DB.run(`INSERT INTO portfolio_items (kind, title, description, tags, made_on) VALUES ('art', ?, ?, 'simulator', date('now'))`,
      [title || $('#tt-name')?.value.trim() || st.name || 'Simulator piece', CHEAT ? 'Designed in cheat mode in the tattoo simulator (no skin was harmed).' : card ? 'Challenge piece from the tattoo simulator, with its score card.' : 'From the tattoo simulator: fresh, healed and 10 years.']);
    const pid = (await DB.one('SELECT last_insert_rowid() AS id')).id;
    await DB.run('INSERT INTO portfolio_photos (item_id, photo_ref, thumb_ref, label, sort) VALUES (?, ?, ?, ?, 0)', [pid, photo, thumb, 'Fresh, healed and 10 years']);
    const ic = inkPng(); if (ic) { const ib = await blobOf(ic), it = document.createElement('canvas'), s2 = Math.min(1, 360 / Math.max(ic.width, ic.height)); it.width = Math.max(1, Math.round(ic.width * s2)); it.height = Math.max(1, Math.round(ic.height * s2)); it.getContext('2d').drawImage(ic, 0, 0, it.width, it.height);
      await DB.run('INSERT INTO portfolio_photos (item_id, photo_ref, thumb_ref, label, sort) VALUES (?, ?, ?, ?, 1)', [pid, await Media.save(ib, 'png'), await Media.save(await blobOf(it), 'png'), 'Ink only (clear background)']); }
    toast('Saved to Portfolio › Simulator.', 2500); };
  $('#tt-pf').onclick = async () => { const b = $('#tt-pf'); if (b.disabled) return; b.disabled = true; if (lsel) selCommit(); if (snapE) snapFinish();
    try { const r = EX?.res?.[EX.res.length - 1], T = r && TT_CH.find(c => c.id === r.id); await toPortfolio(r && T ? await cardOf(T, r, EX.info) : null, T?.title); }
    catch (err) { toast('Could not save: ' + err.message, 4000); } finally { b.disabled = false; } };
  $('#tt-tl').onclick = () => {
    const o = document.createElement('div'); o.id = 'merge-dlg'; 
    const LAYN = Object.fromEntries(TT_LAYERS);
    const draw = () => {
      const ndl = Object.entries(SS.needles).sort((a, b) => b[1] - a[1]);
      const stat = (l, v) => `<div class="stat"><span>${l}</span><span>${v}</span></div>`;
      o.innerHTML = `<div class="card" style="max-height:90dvh;overflow:auto"><h2>Stats</h2>
        ${stat('Strokes', SS.strokes.toLocaleString())}
        ${stat('Needle travelled', tlDist(SS.mm))}
        ${stat('Needle-down time', tlFmt(SS.ms))}
        ${stat('Average hand speed', SS.ms > 0 ? Math.round(SS.mm / (SS.ms / 1000)) + ' mm/s' : '-')}
        ${stat('Punctures', SS.punct.toLocaleString())}
        ${stat('Dips', SS.dips.toLocaleString())}
        ${stat('Laser passes', SS.erase.toLocaleString())}
        ${stat('Blowouts', SS.blow.toLocaleString())}
        ${ndl.length ? `<div class="lbl" style="margin-top:10px">Needles</div>${ndl.map(([k, v]) => stat(k, tlDist(v))).join('')}` : ''}
        ${Object.keys(SS.layers).length ? `<div class="lbl" style="margin-top:10px">Strokes per layer</div>${Object.entries(SS.layers).map(([k, v]) => stat(LAYN[k] || k, v)).join('')}` : ''}
        <p class="muted" style="font-size:12px">Counting since ${new Date(SS.since).toLocaleDateString()}.</p>
        <div class="row" style="flex-wrap:wrap"><button class="btn danger" id="tl-reset">Reset</button><button class="btn primary" id="tl-x" style="flex:1">Close</button></div></div>`;
    };
    o.onclick = async (e) => {
      const t = e.target;
      if (t.id === 'tl-x' || t === o) return o.remove();
      if (t.id === 'tl-reset') { if (!await ask('Reset the stats for this piece?\n\nThe piece itself is not changed.')) return;
        Object.assign(SS, { strokes: 0, mm: 0, ms: 0, dips: 0, punct: 0, blow: 0, erase: 0, needles: {}, layers: {}, since: Date.now() });
        st.dirty = true; await save(true); return draw(); }
    };
    document.body.appendChild(o); draw();
  };
  $('#tt-stencilmk').onclick = async () => {
    if (typeof stLoad !== 'function') return;
    const c = composite(1, false), w = document.createElement('canvas'); w.width = c.width; w.height = c.height; const g = w.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w.width, w.height); g.drawImage(c, 0, 0);
    if (st.dirty) await save(true);
    await stLoad(new File([await blobOf(w)], 'tattoo.png', { type: 'image/png' })); if (!ST.src) return;
    ST.cm = row.w_cm; ST.from = $('#tt-name').value || ''; location.hash = 'stencil';
  };

  /* ---------- References ----------
     Pictures floating over the skin to follow, in screen space, so they stay put while the skin is moved, zoomed
     and turned under them (like the drawing board's reference tool). Drag to move, a corner to resize (always in
     proportion), the dot to turn, double tap to flip; locked ones let the needle through. Kept with the piece. */
  const refLay = $('#tt-refs');
  async function refUrl(r) { if (r._u) return r._u; r._u = r.src || (r.gen ? exGen(r.gen) : await Media.url(r.ref)); return r._u; }
  async function drawRefs() {
    for (const r of refs) await refUrl(r);
    const sr = stage.getBoundingClientRect();
    refLay.innerHTML = refs.filter(r => r.on).map(r => { r.x = Math.max(20, Math.min(sr.width - 20, r.x)); r.y = Math.max(20, Math.min(sr.height - 20, r.y));
      return `<div class="tt-ref ${r.lock ? 'lock' : ''} ${refSel === r.id && !r.lock ? 'sel' : ''}" data-rf="${r.id}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.w * r.ar}px;opacity:${r.op};transform:translate(-50%,-50%) rotate(${r.rot || 0}deg)">
        <img src="${r._u}" alt="" draggable="false" style="${r.flip ? 'transform:scaleX(-1)' : ''}">${refSel === r.id && !r.lock ? '<i data-rh="nw"></i><i data-rh="ne"></i><i data-rh="sw"></i><i data-rh="se"></i><i data-rh="rot"></i>' : ''}</div>`; }).join('');
  }
  const refNew = (o) => { const sr = stage.getBoundingClientRect(); const r = { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), x: sr.width - 150, y: 140, w: 220, ar: 1, rot: 0, flip: false, op: 0.9, on: true, lock: false, ...o };
    refs.push(r); refSel = r.id; st.dirty = true; drawRefs(); return r; };
  const refAdd = async (src) => {
    let ref = null;
    if (src === 'file') { const f = await new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => res(i.files[0] || null); i.click(); });
      if (f) ref = await Media.save(f, (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')); }
    else if (src === 'refs' && typeof dzPortfolioPick === 'function') ref = await dzPortfolioPick('refs');
    else if (src === 'pf' && typeof dzPortfolioPick === 'function') ref = await dzPortfolioPick(true);
    else if (src === 'sten') { const rows = await DB.all('SELECT stencil_ref, src_ref, name FROM stencils ORDER BY created_at DESC LIMIT 1');
      if (!rows.length) return toast('No stencils kept yet.'); ref = typeof dzPortfolioPick === 'function' ? null : null;
      const us = await Promise.all((await DB.all('SELECT stencil_ref FROM stencils ORDER BY created_at DESC LIMIT 200')).map(x => x.stencil_ref));
      ref = await new Promise(async (res) => { const ims = await Promise.all(us.map(u => Media.url(u))); const o = document.createElement('div'); o.id = 'merge-dlg'; o.style.zIndex = 99;
        o.innerHTML = `<div class="card dz-pick"><h2>Your stencils</h2><div class="dz-pf">${us.map((u, i) => `<button data-v="${esc(u)}" style="background:#fff"><img src="${ims[i]}" alt="" style="object-fit:contain"></button>`).join('')}</div><button class="btn" data-v="" style="width:100%;margin-top:10px">Cancel</button></div>`;
        o.onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; o.remove(); res(b.dataset.v || null); }; document.body.appendChild(o); }); }
    if (!ref) return;
    const u = await Media.url(ref), im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; });
    refNew({ ref, ar: im ? im.naturalHeight / im.naturalWidth : 1 }); drawSide();
  };
  /* Gestures on a reference, like Infinite Painter's: one finger moves it, two fingers move, size and turn it together
     (the second finger can land anywhere on the skin), a handle sizes or turns it, a quick double tap flips it.
     The picture is moved in place while the fingers are down, never rebuilt, so the touch is never lost. */
  let refG = null, refTap = null;
  const refPts = new Map(), refPos = (e) => { const sr = stage.getBoundingClientRect(); return { x: e.clientX - sr.left, y: e.clientY - sr.top }; };
  const refPlace = (r) => { const el = refLay.querySelector(`[data-rf="${r.id}"]`); if (!el) return;
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.w * r.ar + 'px'; el.style.transform = `translate(-50%,-50%) rotate(${r.rot || 0}deg)`; };
  const refStart = () => { const r = refG.r, p = [...refPts.values()];
    Object.assign(refG, { x0: r.x, y0: r.y, w0: r.w, rot0: r.rot || 0, p0: p.map(q => ({ ...q })), moved: refG.moved });
    if (refG.h && p.length === 1) { refG.d0 = Math.max(1, Math.hypot(p[0].x - r.x, p[0].y - r.y)); refG.a0 = Math.atan2(p[0].y - r.y, p[0].x - r.x) - (r.rot || 0) * Math.PI / 180; } };
  const refDown = (e, r, h) => {
    e.stopPropagation(); e.preventDefault(); try { refLay.setPointerCapture(e.pointerId); } catch {}
    refPts.set(e.pointerId, refPos(e));
    if (!refG) refG = { r, h, t: Date.now(), moved: false }; else refG.h = null;   // a second finger turns a handle drag into a pinch
    refStart();
  };
  refLay.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-rf]'); if (!el) return; const r = refs.find(x => x.id === el.dataset.rf); if (!r || r.lock) return;
    if (refG && refG.r !== r) return;
    if (refSel !== r.id) { refSel = r.id; drawRefs(); }
    refDown(e, r, e.target.dataset.rh);
  });
  // While one finger holds a reference, a second finger anywhere on the stage joins the gesture instead of drawing.
  stage.addEventListener('pointerdown', (e) => { if (refG && refPts.size === 1 && e.pointerType === 'touch' && !e.target.closest('[data-rf]')) refDown(e, refG.r, null); }, true);
  const refMove = (e) => {
    if (!refG || !refPts.has(e.pointerId)) return; refPts.set(e.pointerId, refPos(e));
    const g = refG, r = g.r, p = [...refPts.values()];
    if (Math.hypot(p[0].x - g.p0[0].x, p[0].y - g.p0[0].y) > 6) g.moved = true;
    if (p.length >= 2 && g.p0.length >= 2) {
      const [a0, b0] = g.p0, [a, b] = p, m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }, m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y));
      const da = Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x), c = Math.cos(da), sn = Math.sin(da);
      const ox = (g.x0 - m0.x) * s, oy = (g.y0 - m0.y) * s;   // the picture turns and sizes about the point between the fingers
      r.w = Math.max(40, g.w0 * s); r.x = m.x + ox * c - oy * sn; r.y = m.y + ox * sn + oy * c;
      let deg = g.rot0 + da * 180 / Math.PI; const q = Math.round(deg / 90) * 90; if (Math.abs(deg - q) < 3) deg = q; r.rot = Math.round(deg * 10) / 10; g.moved = true;
    } else if (!g.h) { r.x = g.x0 + p[0].x - g.p0[0].x; r.y = g.y0 + p[0].y - g.p0[0].y; }
    else if (g.h === 'rot') { let a = (Math.atan2(p[0].y - r.y, p[0].x - r.x) - g.a0) * 180 / Math.PI; const q = Math.round(a / 90) * 90; if (Math.abs(a - q) < 5) a = q; r.rot = Math.round(a); }
    else r.w = Math.max(40, g.w0 * Math.hypot(p[0].x - r.x, p[0].y - r.y) / g.d0);
    st.dirty = true; refPlace(r);
  };
  const refUp = (e) => {
    if (!refG || !refPts.has(e.pointerId)) return; refPts.delete(e.pointerId);
    if (refPts.size) { refG.h = null; return refStart(); }   // one finger lifted: the other carries on moving it
    const g = refG; refG = null; const now = Date.now();
    if (!g.moved && !g.h && now - g.t < 300) {   // a tap: two in a row flip it
      if (refTap && refTap.id === g.r.id && now - refTap.t < 350) { g.r.flip = !g.r.flip; refTap = null; st.dirty = true; }
      else refTap = { id: g.r.id, t: now };
    } else refTap = null;
    drawRefs(); if (st.panel === 'refs') drawSide();
  };
  for (const n of ['pointermove']) { refLay.addEventListener(n, refMove); stage.addEventListener(n, (e) => { if (refG && !refLay.hasPointerCapture?.(e.pointerId)) refMove(e); }, true); }
  for (const n of ['pointerup', 'pointercancel']) { refLay.addEventListener(n, refUp); stage.addEventListener(n, (e) => { if (refG && refPts.has(e.pointerId) && !refLay.hasPointerCapture?.(e.pointerId)) refUp(e); }, true); }
  cv.addEventListener('pointerdown', () => { if (refSel && !refG) { refSel = null; drawRefs(); } }, true);

  /* ---------- Apprentice exam ----------
     Challenges one at a time on a clean patch of skin, each with its stencil, an example floating beside it and
     the needle to use. Done scores it from the ink in the skin (against the stencil or the example), the skin's
     condition and blowouts, and keeps how the pen was used (pressure, speed, angle) for tuning. The exam is a
     piece of its own: leaving saves it, and opening it carries on where it stopped. */
  const Mm = (g, f) => { g.save(); g.scale(mm, mm); g.beginPath(); f(g); g.restore(); };
  // This run's challenges: the exam's, or the one challenge played from the hub.
  const exList = () => (EX?.list || TT_EXAM).map(id => TT_CH.find(c => c.id === id) || TT_LS_CH.find(c => c.id === id)).filter(Boolean);
  const exGen = (name) => { const T = TT_CH.find(c => c.id === name); return T ? ttExGen(T, st.skin) : ''; };
  const exCrop = ttCrop;
  const exStencil = (T) => {
    const g = L.stencil.getContext('2d'); g.clearRect(0, 0, W, H); touched.add('stencil'); g.strokeStyle = 'rgba(78,40,150,.9)'; g.lineWidth = 0.32 * mm; g.lineJoin = g.lineCap = 'round';
    if (T.kind === 'line') { Mm(g, T.path); g.stroke(); }
    else if (T.box) { g.setLineDash([2 * mm, 1.5 * mm]); g.strokeRect(T.box[0] * mm, T.box[1] * mm, T.box[2] * mm, T.box[3] * mm); g.setLineDash([]); }
    else if (T.shape) { Mm(g, T.shape); g.stroke(); }
    else if (T.kind === 'piece') { Mm(g, T.lines); g.stroke(); }
  };
  const exClear = () => { L.marker.getContext('2d').clearRect(0, 0, W, H); touched.add('marker'); for (const key of INK) { L[key].getContext('2d').clearRect(0, 0, W, H); syncIn(key); touched.add(key); } (TR.fill(0), TP.fill(0), HC.fill(0)); LIT = LITC = null; trDirty = true; bx.clearRect(0, 0, blowC.width, blowC.height); hist.length = fut.length = 0; };
  const exStart = (fresh) => {
    const T = exList()[EX.i]; if (!T) return;
    if (fresh || !EX.cur) { exClear(); EX.cur = { id: T.id, p: [], v: [], d: [], t: [], blow: 0, strokes: 0, dips: 0 }; }
    exStencil(T); st.hide.delete('stencil'); st.op.stencil = 0.6;
    refs = refs.filter(r => !r.gen);
    if (T.kind !== 'line') { const cr = exCrop(T), sr = stage.getBoundingClientRect(), w = Math.max(140, Math.min(280, sr.width * 0.28)), h = w * cr[3] / cr[2];
      refNew({ gen: T.id, ar: cr[3] / cr[2], w, op: 1, x: sr.width - w / 2 - 14, y: Math.min(sr.height - 90 - h / 2, Math.max(150 + h / 2, sr.height / 2)) }); }
    if (T.refImg) { const sr = stage.getBoundingClientRect(), eb = $('#tt-exbar')?.getBoundingClientRect(), top = eb?.height ? eb.bottom - sr.top + 10 : 150, h = Math.max(110, Math.min(260, sr.height - top - 120)), w = h / T.refAr;   // an example of the finished look, under the instructions
      refNew({ gen: T.id, src: T.refImg, ar: T.refAr, w, op: 1, x: sr.width - w / 2 - 14, y: top + h / 2 }); }
    refSel = null;
    st.ink = { c: [1, 1, 1], v: 0, s: 1, w: 0 }; st.wash = !!T.wash;   // each challenge starts with a clean, empty needle
    if (T.presets) for (const [id, f] of Object.entries(T.presets)) TT.setFeel(id, { ...TT.feel(id), ...f });   // each needle the lesson uses, set up as it asks
    setNeedle(T.needle); if (T.size || T.volt) { if (T.size) feel.size = T.size; if (T.volt) feel.volt = T.volt; TT.setFeel(st.needle, feel); lay = ttLayout(TT_NEEDLES.find(n => n.id === st.needle), feel.size); drawSz(); drawVolt(); }   // a lesson that asks for a size and voltage starts there
    st.layer = T.layer; st.caps = [...TT_CAPS]; st.view = 'work'; st.viewC = null; z = 1; vx = vy = 0; st.rot = 0; k = fitK;
    drawTray(); drawView(); drawRefs(); exBar(); tally(); paint(); st.dirty = true;
  };
  // ---- scoring ----
  const maskOf = (draw, fill, width) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.lineCap = g.lineJoin = 'round';
    g.save(); g.scale(mm, mm); g.beginPath(); draw(g); if (fill) g.fill(); else { g.lineWidth = width; g.stroke(); } g.restore(); return g.getImageData(0, 0, W, H).data; };
  const densAt = (i) => { let keep = 1; for (const key of INK) keep *= 1 - imgd[key].data[i + 3] / 255; return 1 - keep; };
  const colAt = (i) => { let r = 0, g2 = 0, b = 0, w = 0; for (const key of INK) { const D = imgd[key].data, a = D[i + 3] / 255; if (!a) continue; r += D[i] * a; g2 += D[i + 1] * a; b += D[i + 2] * a; w += a; } return w ? [r / w, g2 / w, b / w] : null; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 441;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const lineScore = (draw, coreW, covEase = 1, skip = null) => {   // covEase: the share of the strip that counts as full coverage
    coreW = Math.min(coreW, 1.7 * (Math.max(...lay.map(n => Math.hypot(n.u, n.v))) + feel.size * 0.35));   // never wider than the needle in use can make
    const core = maskOf(draw, false, coreW), band = maskOf(draw, false, coreW + 2.2), mid = maskOf(draw, false, Math.min(0.2, coreW * 0.4));
    let cn = 0, cin = 0, sum = 0, sum2 = 0, mn = 0, ink = 0, out = 0;
    for (let i = 3; i < core.length; i += 4) { const d = densAt(i - 3);
      if (core[i] > 128) { cn++; if (d > 0.28) cin++; }
      if (mid[i] > 128 && !(skip && skip((i >> 2) % W, Math.floor((i >> 2) / W)))) { mn++; sum += d; sum2 += d * d; }   // skip: where lines meet, which is darker by design
      if (d > 0.2) { ink++; if (band[i] < 30) out++; } }
    const mean = sum / Math.max(1, mn), sd = Math.sqrt(Math.max(0, sum2 / Math.max(1, mn) - mean * mean));
    const cov = Math.min(1, cin / Math.max(1, cn) / covEase), spill = out / Math.max(1, ink), cons = 1 - clamp01(sd / 0.8);
    return { score: Math.round(100 * cov * (0.55 + 0.25 * (1 - spill) + 0.2 * cons)), coverage: Math.round(cov * 100), spill: Math.round(spill * 100), evenness: Math.round(cons * 100) };
  };
  const boxIdx = (b) => { const x0 = Math.round(b[0] * mm), y0 = Math.round(b[1] * mm), x1 = Math.round((b[0] + b[2]) * mm), y1 = Math.round((b[1] + b[3]) * mm); return { x0, y0, x1, y1 }; };
  const spillOut = (inside, margin) => { let ink = 0, out = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, d = densAt(i); if (d > 0.2) { ink++; if (!inside(x / mm, y / mm, margin)) out++; } } return out / Math.max(1, ink); };
  const inBox = (b) => (x, y, m = 0) => x >= b[0] - m && x <= b[0] + b[2] + m && y >= b[1] - m && y <= b[1] + b[3] + m;
  // How steady the line's thickness stays along a shape: the ink's width across the line at each step, away from where lines meet.
  const weightScore = (segs, joints = []) => { const ws = [], hcAll = ttGeomPts(segs).map(q => HC[Math.floor(q.y * mm / TS) * tw + Math.floor(q.x * mm / TS)] || 0).filter(v => v > 0).sort((a, b) => a - b), hcMed = hcAll.length ? hcAll[Math.floor(hcAll.length / 2)] : 0; for (const q of ttGeomPts(segs)) { if (joints.some(j => Math.hypot(j[0] - q.x, j[1] - q.y) < 5)) continue; let c = 0; { const cell = HC[Math.floor(q.y * mm / TS) * tw + Math.floor(q.x * mm / TS)] || 0; if (hcMed && cell > hcMed * 1.6) continue; }
      const hit = (o) => { const X = Math.round((q.x + o * q.nx) * mm), Y = Math.round((q.y + o * q.ny) * mm); return X >= 0 && Y >= 0 && X < W && Y < H && densAt((Y * W + X) * 4) > 0.2; };
      if (joints.length) { // several lines close together: measure only the stroke nearest the stencil, so a neighbouring line isn't read as thickness
        let o0 = null; for (let d = 0; d <= 2.5 && o0 == null; d += 1 / mm) { if (hit(d)) o0 = d; else if (hit(-d)) o0 = -d; }
        if (o0 != null) { const dAt = (o) => { const X = Math.round((q.x + o * q.nx) * mm), Y = Math.round((q.y + o * q.ny) * mm); return X >= 0 && Y >= 0 && X < W && Y < H ? densAt((Y * W + X) * 4) : 0; }; c = dAt(o0); for (let o = o0 + 1 / mm; o <= o0 + 2.5 && hit(o); o += 1 / mm) c += dAt(o); for (let o = o0 - 1 / mm; o >= o0 - 2.5 && hit(o); o -= 1 / mm) c += dAt(o); } }
      else { // the ink across the line, added up, so a few pixels either side don't jump the reading; joins, where a new stroke tapers back over the last one, are left out
        for (let o = -2.5; o <= 2.5; o += 1 / mm) { const X = Math.round((q.x + o * q.nx) * mm), Y = Math.round((q.y + o * q.ny) * mm); if (X >= 0 && Y >= 0 && X < W && Y < H) c += densAt((Y * W + X) * 4); } }
      if (c) ws.push(c / mm); }
    if (ws.length > 10) { const sm = ws.map((_, i) => { const a = ws.slice(Math.max(0, i - 2), i + 3); return a.reduce((x, y) => x + y, 0) / a.length; }); ws.splice(0, ws.length, ...sm); }   // averaged over about 2.5 mm, as an eye would see it
    if (ws.length < 10) return 0; const m = ws.reduce((a, b) => a + b, 0) / ws.length, sd = Math.sqrt(ws.reduce((a, b) => a + (b - m) * (b - m), 0) / ws.length); return Math.round(100 * (1 - clamp01(sd / m / 0.5))); };
  /* Each corner, from [x, y, out x, out y]: ink has to reach the point itself, stay out of the diagonal just inside it
     (a rounded corner cuts through there), and stay off the two lines' extensions just past it (a crossed corner). */
  let cornerNotes = [];
  const cornerScore = (cs) => { cornerNotes = []; const inkAt = (x, y) => { const X = Math.round(x * mm), Y = Math.round(y * mm); return X >= 0 && Y >= 0 && X < W && Y < H && densAt((Y * W + X) * 4) > 0.28 ? 1 : 0; };
    const frac = (x0, x1, y0, y1) => { let n = 0, c = 0; for (let x = x0; x <= x1 + 1e-6; x += 0.1) for (let y = y0; y <= y1 + 1e-6; y += 0.1) { n++; c += inkAt(x, y); } return c / Math.max(1, n); };
    const one = ([x, y, sx, sy, onlyX, label]) => { const box = (a0, a1, b0, b1) => frac(Math.min(x + sx * a0, x + sx * a1), Math.max(x + sx * a0, x + sx * a1), Math.min(y + sy * b0, y + sy * b1), Math.max(y + sy * b0, y + sy * b1));
      const reach = Math.min(1, frac(x - 0.7, x + 0.7, y - 0.7, y + 0.7) / 0.35), cut = box(-2.4, -1, -2.4, -1);
      // how far a line runs on past the corner: a clean end stops within 0.7 mm, and 2.2 mm past scores nothing. Any visible ink counts, across small gaps, so a faint, dotted whip-out still shows as running past.
      const faint = (X0, Y0) => { const X = Math.round(X0 * mm), Y = Math.round(Y0 * mm); return X >= 0 && Y >= 0 && X < W && Y < H && densAt((Y * W + X) * 4) > 0.06; };
      const past = (ux, uy) => { let last = 0.7; for (let d = 0.7; d < 6 && d - last <= 0.5; d += 0.1) for (let o = -0.5; o <= 0.5; o += 0.1) if (faint(x + ux * d + uy * o, y + uy * d + ux * o)) { last = d; break; } return last - 0.7; };
      const run = onlyX ? past(sx, 0) : Math.max(past(sx, 0), past(0, sy)), name = label || `${sy < 0 ? 'Top' : 'Bottom'} ${sx < 0 ? 'left' : 'right'}`; const say = []; if (reach < 0.7) say.push(`${name} ${label ? '' : 'corner '}stops short of the point.`); if (cut > 0.15) say.push(`${name} ${label ? '' : 'corner '}is rounded: the line cuts inside it.`); if (run > 0.3) say.push(`${name} ${label ? '' : 'corner '}runs ${(run + 0.7).toFixed(1)} mm past the point.`);
      // only said when the corner really costs marks: under three quarters of a full corner, after the 0.78 allowance
      const val = reach * (1 - clamp01(cut * 2.5)) * (1 - clamp01(run / 1.5)); if (val / 0.78 < 0.75) cornerNotes.push(...say); return val; };
    const main = cs.filter(c => !c[4]), side = cs.filter(c => c[4]), mean = (a) => a.reduce((s, c) => s + one(c), 0) / a.length;   // an edge ending on another line can only lose marks by crossing it: that line's own ink always reaches the point, so it can't earn any
    return Math.round(100 * Math.min(1, mean(main) / 0.78) * (side.length ? mean(side) : 1)); };   // a hand's near perfect corners measure about 0.7, so 0.78 counts as full
  // A packed square. Saturation: how dark. Coverage: how much is solid. Consistency: how evenly passes are layered over 1 mm patches, with patches well under the average counting extra, even where the ink looks dark. Control: the 7RS's speed and depth stay steady, and it isn't rushed. Technique: the 7RS keeps turning the same way.
  /* How steady the liner's depth stayed, as spread over average (at least 0.6). Time spent lighter than 0.3 is left
     out: that is the taper as a line lands, lifts off or whips out of a point, which lessons ask for. */
  const lineCv = (n) => { const h = n?.depth; if (!h) return n?.n > 1 ? Math.sqrt(n.ds / n.n) / Math.max(0.6, n.dm) : 9; const E = TM_EDGES.depth; let w = 0, s = 0, s2 = 0;
    for (let i = 3; i < h.length; i++) { const c = i < E.length ? (E[i - 1] + E[i]) / 2 : E[E.length - 1] + 0.05; w += h[i]; s += h[i] * c; s2 += h[i] * c * c; }
    if (!w) return 9; const m = s / w; return Math.sqrt(Math.max(0, s2 / w - m * m)) / Math.max(0.6, m); };
  const packScore = (b) => { const m = 0.6; let n = 0, solid = 0, sum = 0; for (let cx = b[0] + m; cx < b[0] + b[2] - m; cx += 1) for (let cy = b[1] + m; cy < b[1] + b[3] - m; cy += 1) { for (let x = Math.round(cx * mm); x < (cx + 1) * mm; x += 2) for (let y = Math.round(cy * mm); y < (cy + 1) * mm; y += 2) { const d = densAt((y * W + x) * 4); n++; sum += d; if (d > 0.7) solid++; } }
    const hm = EX.cur?.hm || [], pc = []; for (let i = 2; i + 1 < b[2] * 2 - 2; i += 2) for (let j = 2; j + 1 < b[3] * 2 - 2; j += 2) pc.push((hm[j * 30 + i] || 0) + (hm[j * 30 + i + 1] || 0) + (hm[(j + 1) * 30 + i] || 0) + (hm[(j + 1) * 30 + i + 1] || 0));
    const mean = pc.reduce((a, v) => a + v, 0) / Math.max(1, pc.length), sd = Math.sqrt(pc.reduce((a, v) => a + (v - mean) * (v - mean), 0) / Math.max(1, pc.length)), low = pc.filter(v => v < mean * 0.6).length / Math.max(1, pc.length);
    // Depth changes are measured against at least 0.6 depth, so a light, gentle hand (which heals solid) isn't read as unsteady just because its average is low.
    const sat = clamp01(sum / Math.max(1, n) / 0.9), cov = solid / Math.max(1, n), cons = mean > 0 ? clamp01(1 - sd / mean / 0.6 - low * 1.5) * Math.min(1, sat / 0.5) : 0, sp = spillOut(inBox(b), 1.2), mv = EX.cur?.mv, ctrl = mv?.n > 1 ? (1 - clamp01((Math.sqrt(mv.vs / mv.n) / Math.max(1, mv.vm) - 0.5) / 0.6)) * (1 - clamp01((Math.sqrt(mv.ds / mv.n) / Math.max(0.6, mv.dm) - 0.12) / 0.5)) * (1 - clamp01(mv.fast / mv.all)) : 0;
    // Technique, set from side by side stats: real circles turned the same way 0.90 of the time and flipped 0.13 times per 10 mm; a scrub at the same speed 0.17 and 1.15.
    const rs = EX.cur?.tm?.by?.['7RS'], same = rs?.abs ? rs.net / rs.abs : 0, flips = rs?.mm ? rs.flips / rs.mm * 10 : 9, tech = clamp01((same - 0.3) / 0.5) * clamp01(1 - (flips - 0.2) / 0.6);
    // Outline: how steady the 5RL's depth stayed (real lining varied 22%, an unsteady one 41%), and how straight the square's outer edge came out. Not lining with the 5RL scores nothing.
    const l5 = EX.cur?.tm?.by?.['5RL'], cvD = lineCv(l5), offs = []; for (let s = 1; s < b[2] - 1; s += 0.25) for (const [ox, oy, ux, uy] of [[b[0] + s, b[1], 0, -1], [b[0] + s, b[1] + b[3], 0, 1], [b[0], b[1] + s, -1, 0], [b[0] + b[2], b[1] + s, 1, 0]]) { for (let o = 2.5; o >= -1; o -= 1 / mm) { const X = Math.round((ox + ux * o) * mm), Y = Math.round((oy + uy * o) * mm); if (X >= 0 && Y >= 0 && X < W && Y < H && densAt((Y * W + X) * 4) > 0.2) { offs.push(o); break; } } }
    const om = offs.reduce((a, v) => a + v, 0) / Math.max(1, offs.length), osd = Math.sqrt(offs.reduce((a, v) => a + (v - om) * (v - om), 0) / Math.max(1, offs.length)), outl = offs.length ? clamp01(1 - (cvD - 0.2) / 0.4) * clamp01(1 - (osd - 0.1) / 0.5) : 0;
    return { score: Math.round(100 * cov * (0.2 * sat + 0.65 * cons + 0.15 * (1 - sp)) * (0.5 + 0.5 * ctrl) * (0.3 + 0.7 * tech) * (0.9 + 0.1 * outl)), technique: Math.round(tech * 100), outline: Math.round(outl * 100), saturation: Math.round(sat * 100), coverage: Math.round(cov * 100), consistency: Math.round(cons * 100), control: Math.round(ctrl * 100), spill: Math.round(sp * 100) }; };
  /* Colour packing in a circle: the same judging as Solid black, plus whether the colour is the mix asked for and
     whether it would heal solid (the same thin-spot check the Healed and 10 years views use). The line is the liner's
     steadiness and how round the outer edge came out. */
  const circleScore = (T) => { const [cx, cy, r] = T.circle, b = T.pack, inside = (x, y, mg) => Math.hypot(x - cx, y - cy) <= r - mg, want = ttMix(ttHex(T.mixOf[0]), ttHex(T.mixOf[1]), 0.5).map(v => v * 255); let n = 0, solid = 0, sum = 0, cs = [0, 0, 0], cn = 0;
    for (let y = Math.round((cy - r) * mm); y <= (cy + r) * mm; y += 2) for (let x = Math.round((cx - r) * mm); x <= (cx + r) * mm; x += 2) { if (!inside(x / mm, y / mm, 0.6)) continue; const i = (y * W + x) * 4, d = densAt(i); n++; sum += d; if (d > 0.7) { solid++; const c = colAt(i); if (c) { cs[0] += c[0]; cs[1] += c[1]; cs[2] += c[2]; cn++; } } }
    const hm = EX.cur?.hm || [], pc = []; for (let i = 0; i + 1 < b[2] * 2; i += 2) for (let j = 0; j + 1 < b[3] * 2; j += 2) { if (!inside(b[0] + (i + 1) / 2, b[1] + (j + 1) / 2, 1.2)) continue; pc.push((hm[j * 30 + i] || 0) + (hm[j * 30 + i + 1] || 0) + (hm[(j + 1) * 30 + i] || 0) + (hm[(j + 1) * 30 + i + 1] || 0)); }
    { const md = pc.slice().sort((p, q) => p - q)[pc.length >> 1] || 0; for (let k = 0; k < pc.length; k++) pc[k] = Math.min(pc[k], md); }   /* extra passes where a magnum turns are not patchy: only spots short of the median count (overwork is judged by Healing) */
    const mean = pc.reduce((a, v) => a + v, 0) / Math.max(1, pc.length), sd = Math.sqrt(pc.reduce((a, v) => a + (v - mean) * (v - mean), 0) / Math.max(1, pc.length)), low = pc.filter(v => v < mean * 0.6).length / Math.max(1, pc.length);
    const sat = clamp01(sum / Math.max(1, n) / 0.9), cov = solid / Math.max(1, n), cons = mean > 0 ? clamp01(1 - sd / mean / 0.6 - low * 1.5) * Math.min(1, sat / 0.5) : 0, avg = cn ? cs.map(v => v / cn) : [255, 255, 255], col = cn ? 1 - clamp01((dist(avg, want) - 0.06) * 3) : 0, sp = spillOut((x, y, m) => Math.hypot(x - cx, y - cy) <= r + m, 1.2);
    const up = underPacked(); let hn = 0, hl = 0; for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { if (!inside((x + 0.5) * TS / mm, (y + 0.5) * TS / mm, 1)) continue; hn++; const k2 = y * tw + x; hl += Math.max(up ? up[k2] : 0, Math.max(0, Math.min(1, (TP[k2] - 0.9) / 1.3))); /* thin spots and overworked skin both heal patchy */ } const heal = clamp01(1 - hl / Math.max(1, hn) * 2) * Math.min(1, sat / 0.5);   // only meaningful once the colour is actually in
    const mv = EX.cur?.mv, ctrl = mv?.n > 1 ? (1 - clamp01((Math.sqrt(mv.vs / mv.n) / Math.max(1, mv.vm) - 0.5) / 0.6)) * (1 - clamp01((Math.sqrt(mv.ds / mv.n) / Math.max(0.6, mv.dm) - 0.12) / 0.5)) * (1 - clamp01(mv.fast / mv.all)) : 0;
    const rs = EX.cur?.tm?.by?.[T.packNeedle], same = rs?.abs ? rs.net / rs.abs : 0, flips = rs?.mm ? rs.flips / rs.mm * 10 : 9, tech = clamp01((same - 0.3) / 0.5) * clamp01(1 - (flips - 0.2) / 0.6);
    const ln = EX.cur?.tm?.by?.[T.liner], cvD = lineCv(ln), offs = []; for (let a = 0; a < 360; a += 2) { const ca = Math.cos(a * Math.PI / 180), sa = Math.sin(a * Math.PI / 180); for (let o = 2.5; o >= -1; o -= 1 / mm) { const X = Math.round((cx + (r + o) * ca) * mm), Y = Math.round((cy + (r + o) * sa) * mm); if (X >= 0 && Y >= 0 && X < W && Y < H && densAt((Y * W + X) * 4) > 0.2) { offs.push(o); break; } } }
    const om = offs.reduce((a, v) => a + v, 0) / Math.max(1, offs.length), osd = Math.sqrt(offs.reduce((a, v) => a + (v - om) * (v - om), 0) / Math.max(1, offs.length)), outl = offs.length ? clamp01(1 - (cvD - 0.2) / 0.4) * clamp01(1 - (osd - 0.1) / 0.5) : 0;
    return { score: Math.round(100 * cov * (0.15 * sat + 0.45 * cons + 0.15 * col + 0.1 * (1 - sp) + 0.15 * heal) * (0.5 + 0.5 * ctrl) * (0.3 + 0.7 * tech) * (0.85 + 0.15 * outl)), technique: Math.round(tech * 100), outline: Math.round(outl * 100), colour: Math.round(col * 100), healing: Math.round(heal * 100), saturation: Math.round(sat * 100), coverage: Math.round(cov * 100), consistency: Math.round(cons * 100), control: Math.round(ctrl * 100), spill: Math.round(sp * 100), yourColour: ttToHex(avg.map(v => v / 255)) }; };
  /* Stipple shading, a first version to tune against real attempts. The rectangle is cut into ten bands along its
     length: the gradient is how far apart the two ends are, whether it keeps going one way, and whether any one step
     is a hard jump. Dots: how little of it went solid. Inside: ink past the line and whips that started or finished
     outside it. Whips: the share of shading strokes that landed softly on the move. Voltage: the lining strokes near
     7.2 V and the shading strokes in 4.8-5.8 V. Outline: how straight the rectangle's edges came out. */
  const stippleScore = (T) => { const b = T.stipple, m = 0.5, N = 10, bands = new Array(N).fill(0), cnt = new Array(N).fill(0), cols = [...Array(N)].map(() => [0, 0, 0, 0, 0, 0]); let solid = 0, n = 0;
    for (let y = Math.round((b[1] + m) * mm); y < (b[1] + b[3] - m) * mm; y += 2) for (let x = Math.round((b[0] + m) * mm); x < (b[0] + b[2] - m) * mm; x += 2) { const d = densAt((y * W + x) * 4), k = Math.min(N - 1, Math.floor((y / mm - b[1] - m) / (b[3] - 2 * m) * N)), cl = Math.min(2, Math.floor((x / mm - b[0] - m) / (b[2] - 2 * m) * 3)); bands[k] += d; cnt[k]++; cols[k][cl] += d; cols[k][cl + 3]++; n++; if (d > 0.85) solid++; }
    const d = bands.map((v, i) => v / Math.max(1, cnt[i])), dir = (d[0] + d[1]) >= (d[N - 1] + d[N - 2]) ? 1 : -1, g = dir > 0 ? d : d.slice().reverse(), span = Math.max(0, (g[0] + g[1]) / 2 - (g[N - 1] + g[N - 2]) / 2);
    let back = 0, maxStep = 0; for (let i = 1; i < N; i++) { const s = g[i - 1] - g[i]; if (s < -0.02) back += -s; maxStep = Math.max(maxStep, Math.abs(s)); }
    /* Even across the width: in each band, how far its left, middle and right thirds stray from the band's own shade
       (clumps and streaks show here), weighted towards the darker bands where they show most. */
    let ev = 0, evW = 0; for (let k = 0; k < N; k++) { const c3 = [0, 1, 2].map(q => cols[k][q] / Math.max(1, cols[k][q + 3])), mu = (c3[0] + c3[1] + c3[2]) / 3; if (mu < 0.03) continue; const dev = Math.max(...c3.map(v => Math.abs(v - mu))) / mu; ev += dev * mu; evW += mu; }
    const even = evW ? clamp01(1 - (ev / evW - 0.08) / 0.3) : 0;
    const grad = clamp01((span - 0.08) / 0.4), mono = clamp01(1 - back / Math.max(0.05, span)), smooth = span > 0.02 ? clamp01(1 - (maxStep / span - 0.3) / 0.5) : 0, gradient = grad * (0.4 + 0.6 * mono) * (0.5 + 0.5 * smooth);
    const dots = n ? clamp01(1 - (solid / n - 0.1) / 0.3) : 0, sp = spillOut(inBox(b), 0.6);
    const sk = EX.cur?.sk || [], ln = sk.filter(s => s.l), sh = sk.filter(s => !s.l), out = (q) => !inBox(b)(q[0], q[1], -0.2), cross = sh.length ? sh.filter(s => out(s.a) || out(s.b)).length / sh.length : 0;
    const whip = sh.length ? sh.filter(s => s.w).length / sh.length : 0, lvW = ln.reduce((a, s) => a + s.mm, 0), lv = lvW ? ln.reduce((a, s) => a + s.v * s.mm, 0) / lvW : 0;
    const lvs = ln.length ? clamp01(1 - (Math.abs(lv - T.lineVolt[0]) - T.lineVolt[1]) / 0.6) : 0, svs = sh.length ? sh.filter(s => s.v >= T.shadeVolt[0] - 0.05 && s.v <= T.shadeVolt[1] + 0.05).length / sh.length : 0, volts = 0.5 * lvs + 0.5 * svs;
    const offs = []; for (let s = 1; s < b[3] - 1; s += 0.25) for (const [ox, oy, ux, uy, ok] of [[b[0] + s, b[1], 0, -1, s < b[2] - 1], [b[0] + s, b[1] + b[3], 0, 1, s < b[2] - 1], [b[0], b[1] + s, -1, 0, 1], [b[0] + b[2], b[1] + s, 1, 0, 1]]) { if (!ok) continue; for (let o = 2.5; o >= -1; o -= 1 / mm) { const X = Math.round((ox + ux * o) * mm), Y = Math.round((oy + uy * o) * mm); if (X >= 0 && Y >= 0 && X < W && Y < H && densAt((Y * W + X) * 4) > 0.2) { offs.push(o); break; } } }
    const om = offs.reduce((a, v) => a + v, 0) / Math.max(1, offs.length), osd = Math.sqrt(offs.reduce((a, v) => a + (v - om) * (v - om), 0) / Math.max(1, offs.length)), outl = offs.length ? clamp01(1 - (osd - 0.1) / 0.5) : 0;
    const inside = (1 - sp) * (1 - 0.6 * cross);
    return { score: Math.round(100 * (0.35 * gradient + 0.15 * even + 0.1 * dots + 0.15 * inside + 0.1 * whip + 0.15 * volts) * (0.85 + 0.15 * outl)), gradient: Math.round(gradient * 100), smoothness: Math.round(smooth * 100), evenness: Math.round(even * 100), bands: d.map(v => v.toFixed(2)).join(' '), dots: Math.round(dots * 100), inside: Math.round(inside * 100), whips: Math.round(whip * 100), voltage: Math.round(volts * 100), outline: Math.round(outl * 100), spill: Math.round(sp * 100), lineVolts: lv ? lv.toFixed(1) : '' }; };   // lineVolts as text: shown in the notes, not as a bar
  /* Whip shading in grey wash, a first version to tune against real attempts. Gradient, smoothness and evenness as in
     Stipple shading. Whips: the share of the curved mag's strokes that were whips, cut down hard if its motion went round
     in circles the same way (packing). Washes: the lighter washes were really used, black through to Light. Edges: no
     holiday, the band just inside the long lines along the darker half as dark as the shade a little further in.
     Voltage: the liner near 7.5 V, the mag near 6.6 V. */
  const washGradScore = (T) => { const b = T.wgrad, m = 0.5, N = 10, bands = new Array(N).fill(0), cnt = new Array(N).fill(0), cols = [...Array(N)].map(() => [0, 0, 0, 0, 0, 0]);
    for (let y = Math.round((b[1] + m) * mm); y < (b[1] + b[3] - m) * mm; y += 2) for (let x = Math.round((b[0] + m) * mm); x < (b[0] + b[2] - m) * mm; x += 2) { const d = densAt((y * W + x) * 4), k = Math.min(N - 1, Math.floor((y / mm - b[1] - m) / (b[3] - 2 * m) * N)), cl = Math.min(2, Math.floor((x / mm - b[0] - m) / (b[2] - 2 * m) * 3)); bands[k] += d; cnt[k]++; cols[k][cl] += d; cols[k][cl + 3]++; }
    const d = bands.map((v, i) => v / Math.max(1, cnt[i])), dir = (d[0] + d[1]) >= (d[N - 1] + d[N - 2]) ? 1 : -1, g = dir > 0 ? d : d.slice().reverse(), span = Math.max(0, (g[0] + g[1]) / 2 - (g[N - 1] + g[N - 2]) / 2);
    let back = 0, maxStep = 0; for (let i = 1; i < N; i++) { const s = g[i - 1] - g[i]; if (s < -0.02) back += -s; maxStep = Math.max(maxStep, Math.abs(s)); }
    const grad = clamp01((span - 0.1) / 0.45), mono = clamp01(1 - back / Math.max(0.05, span)), smooth = span > 0.02 ? clamp01(1 - (maxStep / span - 0.3) / 0.5) : 0, gradient = grad * (0.4 + 0.6 * mono) * (0.5 + 0.5 * smooth);
    let ev = 0, evW = 0; for (let k = 0; k < N; k++) { const c3 = [0, 1, 2].map(q => cols[k][q] / Math.max(1, cols[k][q + 3])), mu = (c3[0] + c3[1] + c3[2]) / 3; if (mu < 0.03) continue; ev += Math.max(...c3.map(v => Math.abs(v - mu))) / mu * mu; evW += mu; }
    const even = evW ? clamp01(1 - (ev / evW - 0.08) / 0.3) : 0, sp = spillOut(inBox(b), 0.6);
    const sk = EX.cur?.sk || [], ln = sk.filter(s => s.l), sh = sk.filter(s => !s.l && s.n === T.shadeNeedle), out = (q) => !inBox(b)(q[0], q[1], -0.2), cross = sh.length ? sh.filter(s => out(s.a) || out(s.b)).length / sh.length : 0, inside = (1 - sp) * (1 - 0.6 * cross);
    const cm = EX.cur?.tm?.by?.[T.shadeNeedle], same = cm?.abs ? cm.net / cm.abs : 0, turn = cm?.mm ? cm.turn / cm.mm : 0, packing = clamp01((same - 0.55) / 0.3) * clamp01((turn - 0.35) / 0.4);
    const whips = (sh.length ? sh.filter(s => s.w).length / sh.length : 0) * (1 - packing);
    const lv = (S, want) => { const L2 = S.reduce((a, s) => a + s.mm, 0); if (!L2) return 0; const v = S.reduce((a, s) => a + s.v * s.mm, 0) / L2; return clamp01(1 - (Math.abs(v - want[0]) - want[1]) / 0.6); }, volts = 0.5 * lv(ln, T.lineVolt) + 0.5 * lv(sh, T.shadeVolt);
    const ws2 = sh.filter(s => s.mm > 2).map(s => s.s), washes = (ws2.some(s => s >= 0.8) ? 0.25 : 0) + (ws2.some(s => s > 0.3 && s < 0.8) ? 0.35 : 0) + (ws2.some(s => s <= 0.3) ? 0.4 : 0);   // strength as dipped: washes mixed on the needle without a rinse land in between, which counts
    // Holidays: along both long lines over the darker half, the strip just inside the line against the shade 1.2-2.4 mm in.
    let near = 0, far = 0, nn = 0, nf = 0; const yA = dir > 0 ? b[1] + 1 : b[1] + b[3] / 2, yB = dir > 0 ? b[1] + b[3] / 2 : b[1] + b[3] - 1;
    for (let y = yA; y < yB; y += 0.25) for (const [x0, sx] of [[b[0], 1], [b[0] + b[2], -1]]) { for (let o = 0.35; o <= 0.8; o += 0.15) { near += densAt((Math.round(y * mm) * W + Math.round((x0 + sx * o) * mm)) * 4); nn++; } for (let o = 1.2; o <= 2.4; o += 0.3) { far += densAt((Math.round(y * mm) * W + Math.round((x0 + sx * o) * mm)) * 4); nf++; } }
    near /= Math.max(1, nn); far /= Math.max(1, nf); const edges = far > 0.05 ? clamp01(1 - (Math.max(0, far - near) / far - 0.1) / 0.4) : 0;
    const offs = []; for (let s = 1; s < b[3] - 1; s += 0.25) for (const [ox, oy, ux, uy, ok] of [[b[0] + s, b[1], 0, -1, s < b[2] - 1], [b[0] + s, b[1] + b[3], 0, 1, s < b[2] - 1], [b[0], b[1] + s, -1, 0, 1], [b[0] + b[2], b[1] + s, 1, 0, 1]]) { if (!ok) continue; for (let o = 2.5; o >= -1; o -= 1 / mm) { const X = Math.round((ox + ux * o) * mm), Y = Math.round((oy + uy * o) * mm); if (X >= 0 && Y >= 0 && X < W && Y < H && densAt((Y * W + X) * 4) > 0.2) { offs.push(o); break; } } }
    const om = offs.reduce((a, v) => a + v, 0) / Math.max(1, offs.length), osd = Math.sqrt(offs.reduce((a, v) => a + (v - om) * (v - om), 0) / Math.max(1, offs.length)), outl = offs.length ? clamp01(1 - (osd - 0.1) / 0.5) : 0;
    return { score: Math.round(100 * (0.3 * gradient + 0.15 * even + 0.15 * whips + 0.1 * washes + 0.1 * edges + 0.1 * inside + 0.1 * volts) * (0.85 + 0.15 * outl)), gradient: Math.round(gradient * 100), smoothness: Math.round(smooth * 100), evenness: Math.round(even * 100), whips: Math.round(whips * 100), washes: Math.round(washes * 100), edges: Math.round(edges * 100), inside: Math.round(inside * 100), voltage: Math.round(volts * 100), outline: Math.round(outl * 100), spill: Math.round(sp * 100), packing: (packing * 100).toFixed(0), bands: d.map(v => v.toFixed(2)).join(' ') }; };
  /* Colour blend, a first version to tune against real attempts. The triangle runs from its point to the wide end; it
     is cut into ten bands along that length. Saturation and coverage inside it. Colour: each band against the colour
     asked for there (the black and red shadow, red, orange, yellow, changing gradually). Blend: no hard step in colour
     between neighbouring bands, and even across each band. Healing: thin or overworked spots, as in Orange circle. Line:
     the liner's steadiness and how straight the three edges came out. */
  const triScore = (T) => { const [A, B, C] = T.tri, base = [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2], len = Math.hypot(base[0] - A[0], base[1] - A[1]), ux = (base[0] - A[0]) / len, uy = (base[1] - A[1]) / len;
    const sgn = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]), edgeD = (p) => Math.min(...[[A, B], [B, C], [C, A]].map(([p1, p2]) => { const ex = p2[0] - p1[0], ey = p2[1] - p1[1], L = Math.hypot(ex, ey); return Math.abs((p[0] - p1[0]) * ey - (p[1] - p1[1]) * ex) / L; }));
    const inside = (x, y, mg) => { const p = [x, y], d1 = sgn(p, A, B), d2 = sgn(p, B, C), d3 = sgn(p, C, A); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) && (!mg || edgeD(p) >= mg); };
    const R = ttHex(TT_CAPS[2]), Y = ttHex(TT_CAPS[3]), K = ttHex(TT_CAPS[0]), want = (f) => { const stops = [[0, ttMix(K, R, 0.5)], [0.27, R], [0.5, R], [0.75, ttMix(R, Y, 0.5)], [0.88, Y], [1, Y]]; let i = 1; while (i < stops.length - 1 && f > stops[i][0]) i++; const [f0, c0] = stops[i - 1], [f1, c1] = stops[i]; return ttMix(c0, c1, f1 > f0 ? (f - f0) / (f1 - f0) : 0).map(v => v * 255); };
    const N = 10, bs = [...Array(N)].map(() => ({ c: [0, 0, 0], n: 0, side: [[0, 0, 0, 0], [0, 0, 0, 0]] })); let n = 0, solid = 0, sum = 0;
    const x0 = Math.min(A[0], B[0], C[0]), x1 = Math.max(A[0], B[0], C[0]), y0 = Math.min(A[1], B[1], C[1]), y1 = Math.max(A[1], B[1], C[1]);
    for (let y = Math.round(y0 * mm); y <= y1 * mm; y += 2) for (let x = Math.round(x0 * mm); x <= x1 * mm; x += 2) { const px = x / mm, py = y / mm; if (!inside(px, py, 0.6)) continue; const i = (y * W + x) * 4, d = densAt(i); n++; sum += d; if (d <= 0.7) continue; solid++;
      const f = Math.max(0, Math.min(0.999, ((px - A[0]) * ux + (py - A[1]) * uy) / len)), k = Math.floor(f * N), c = colAt(i); if (!c) continue; const b = bs[k]; b.c[0] += c[0]; b.c[1] += c[1]; b.c[2] += c[2]; b.n++; const sd = b.side[((px - A[0]) * -uy + (py - A[1]) * ux) > 0 ? 1 : 0]; sd[0] += c[0]; sd[1] += c[1]; sd[2] += c[2]; sd[3]++; }
    const sat = clamp01(sum / Math.max(1, n) / 0.9), cov = solid / Math.max(1, n), avg = bs.map(b => b.n ? b.c.map(v => v / b.n) : null);
    const acc = avg.map((c, k) => c ? 1 - clamp01((dist(c, want((k + 0.5) / N)) - 0.1) * 2.5) : 0), col = acc.reduce((a, v) => a + v, 0) / N;
    let maxStep = 0, side = 0, sn = 0; for (let k = 1; k < N; k++) if (avg[k] && avg[k - 1]) maxStep = Math.max(maxStep, dist(avg[k], avg[k - 1]) - Math.max(0.08, dist(want((k + 0.5) / N), want((k - 0.5) / N))));
    for (const b of bs) if (b.side[0][3] > 4 && b.side[1][3] > 4) { side += dist(b.side[0].slice(0, 3).map(v => v / b.side[0][3]), b.side[1].slice(0, 3).map(v => v / b.side[1][3])); sn++; }
    const blend = clamp01(1 - (maxStep - 0.06) / 0.25) * clamp01(1 - ((sn ? side / sn : 0) - 0.04) / 0.15);
    const up = underPacked(); let hn = 0, hl = 0; for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { if (!inside((x + 0.5) * TS / mm, (y + 0.5) * TS / mm, 1)) continue; hn++; const k2 = y * tw + x; hl += Math.max(up ? up[k2] : 0, Math.max(0, Math.min(1, (TP[k2] - 0.9) / 1.3))); } const heal = clamp01(1 - hl / Math.max(1, hn) * 2) * Math.min(1, sat / 0.5);
    const sp = spillOut((x, y, m) => inside(x, y) || edgeD([x, y]) <= m, 1);
    const ln = EX.cur?.tm?.by?.[T.liner], cvD = lineCv(ln), offs = [];
    for (const [p1, p2] of [[A, B], [B, C], [C, A]]) { const ex = p2[0] - p1[0], ey = p2[1] - p1[1], L = Math.hypot(ex, ey), cx0 = (A[0] + B[0] + C[0]) / 3, cy0 = (A[1] + B[1] + C[1]) / 3; let nx = ey / L, ny = -ex / L; if ((p1[0] - cx0) * nx + (p1[1] - cy0) * ny < 0) { nx = -nx; ny = -ny; }
      for (let s = 2; s < L - 2; s += 0.5) { const ox = p1[0] + ex * s / L, oy = p1[1] + ey * s / L; for (let o = 2.5; o >= -1; o -= 1 / mm) { const X = Math.round((ox + nx * o) * mm), Y2 = Math.round((oy + ny * o) * mm); if (X >= 0 && Y2 >= 0 && X < W && Y2 < H && densAt((Y2 * W + X) * 4) > 0.2) { offs.push(o); break; } } } }
    const om = offs.reduce((a, v) => a + v, 0) / Math.max(1, offs.length), osd = Math.sqrt(offs.reduce((a, v) => a + (v - om) * (v - om), 0) / Math.max(1, offs.length)), outl = offs.length ? clamp01(1 - (cvD - 0.2) / 0.4) * clamp01(1 - (osd - 0.1) / 0.5) : 0;
    const volts = ln ? clamp01(1 - (Math.abs((EX.cur?.lineV || 0) - T.lineVolt[0]) - T.lineVolt[1]) / 0.6) : 0;
    return { score: Math.round(100 * cov * (0.15 * sat + 0.25 * col + 0.25 * blend + 0.25 * heal + 0.1 * (1 - sp)) * (0.8 + 0.2 * outl) * (0.9 + 0.1 * volts)), outline: Math.round(outl * 100), saturation: Math.round(sat * 100), coverage: Math.round(cov * 100), colour: Math.round(col * 100), blend: Math.round(blend * 100), healing: Math.round(heal * 100), voltage: Math.round(volts * 100), spill: Math.round(sp * 100), bandColours: avg.map(c => c ? ttToHex(c.map(v => v / 255)) : '-').join(' ') }; };
  const scoreOf = (T) => {
    if (T.tri) return triScore(T);
    if (T.wgrad) return washGradScore(T);
    if (T.stipple) return stippleScore(T);
    if (T.circle) return circleScore(T);
    if (T.pack) return packScore(T.pack);
    if (T.geom) { const hv = ttGeomPts(T.geom).map(q => HC[Math.floor(q.y * mm / TS) * tw + Math.floor(q.x * mm / TS)] || 0).filter(v => v > 0).sort((a, b) => a - b), med = hv[Math.floor(hv.length / 2)] || 0, skip = (px, py) => T.joints.some(j => Math.hypot(j[0] * mm - px, j[1] * mm - py) < 3 * mm) || (med && (HC[Math.floor(py / TS) * tw + Math.floor(px / TS)] || 0) > med * 1.6); const ln = lineScore(T.path, T.core, T.covEase, skip), cr = cornerScore(T.corners), wt = weightScore(T.geom, T.joints); return { ...ln, score: Math.round(ln.score * (0.8 + 0.2 * cr / 100) * (0.9 + 0.1 * wt / 100)), corners: cr, weight: wt }; }
    if (T.arcs) { const ln = lineScore(T.path, T.core, T.covEase), wt = weightScore(T.arcs.map(a => ['a', ...a])); return { ...ln, score: Math.round(ln.score * (0.7 + 0.3 * wt / 100)), weight: wt }; }
    if (T.corners) { const ln = lineScore(T.path, T.core, T.covEase), cr = cornerScore(T.corners); return { ...ln, score: Math.round(ln.score * (0.75 + 0.25 * cr / 100)), corners: cr }; }
    if (T.kind === 'line') return lineScore(T.path, T.core, T.covEase);
    if (T.kind === 'grad') {   // judged on its shape (scaled to your own darkest) and on getting reasonably dark
      const { x0, y0, x1, y1 } = boxIdx(T.box), cs = [], ts = [];
      for (let x = x0; x < x1; x += 2) { let s2 = 0, m = 0; for (let y = y0; y < y1; y += 2) { s2 += densAt((y * W + x) * 4); m++; } cs.push(s2 / m); ts.push(T.prof((x - x0) / (x1 - x0))); }
      let ct = 0, tt = 0; cs.forEach((c, i) => { ct += c * ts[i]; tt += ts[i] * ts[i]; }); const a = ct / Math.max(1e-6, tt);
      const shape = cs.reduce((e, c, i) => e + Math.abs(c - a * ts[i]), 0) / Math.max(1, cs.length) / Math.max(0.15, a);
      const match = (1 - clamp01(shape * 1.6)) * (0.55 + 0.45 * clamp01(a / (T.dk || 0.7))), sp = spillOut(inBox(T.box), 2.5);
      return { score: Math.round(100 * (0.8 * match + 0.2 * (1 - sp))), match: Math.round(match * 100), darkness: Math.round(clamp01(a) * 100), spill: Math.round(sp * 100) }; }
    if (T.kind === 'pack') { const { x0, y0, x1, y1 } = boxIdx(T.box); let n = 0, cov = 0, s1 = 0, s2 = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const d = densAt((y * W + x) * 4); n++; if (d > 0.75) cov++; s1 += d; s2 += d * d; }
      const mean = s1 / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean)), ev = 1 - clamp01(sd / 0.3), sp = spillOut(inBox(T.box), 1.5);
      return { score: Math.round(100 * (cov / n) * (0.5 + 0.3 * ev + 0.2 * (1 - sp))), coverage: Math.round(cov / n * 100), evenness: Math.round(ev * 100), spill: Math.round(sp * 100) }; }
    if (T.kind === 'fill') { const m = maskOf(T.shape, true), out = maskOf(T.shape, false, 3), want = ttHex(T.col).map(v => v * 255); let n = 0, cov = 0, cs = [0, 0, 0], cn = 0, ink = 0, sp = 0;
      for (let i = 3; i < m.length; i += 4) { const d = densAt(i - 3); if (m[i] > 128) { n++; if (d > 0.6) { cov++; const c = colAt(i - 3); if (c) { cs[0] += c[0]; cs[1] += c[1]; cs[2] += c[2]; cn++; } } } else if (d > 0.2) { ink++; if (out[i] < 30) sp++; } }
      const avg = cn ? cs.map(v => v / cn) : [255, 255, 255], col = 1 - clamp01(dist(avg, want) * 3), cv2 = cov / Math.max(1, n), spl = sp / Math.max(1, ink + cov), cw = T.colW || 0.35;
      return { score: Math.round(100 * ((0.8 - cw) * cv2 + cv2 * (cw * col + 0.2 * (1 - spl)))), coverage: Math.round(cv2 * 100), colour: Math.round(col * 100), spill: Math.round(spl * 100), yourColour: ttToHex(avg.map(v => v / 255)) }; }
    if (T.kind === 'blend') { const { x0, y0, x1, y1 } = boxIdx(T.box), A = ttHex(T.from || RED), Bc = ttHex(T.to || YEL); let err = 0, n = 0, cov = 0, tot = 0;
      for (let x = x0; x < x1; x += 3) { const f = (x - x0) / (x1 - x0), want = (f < 0.3 ? A : f > 0.7 ? Bc : ttMix(A, Bc, (f - 0.3) / 0.4)).map(v => v * 255);
        let cs = [0, 0, 0], cn = 0; for (let y = y0; y < y1; y += 3) { tot++; const i = (y * W + x) * 4; if (densAt(i) > 0.5) { cov++; const c = colAt(i); if (c) { cs[0] += c[0]; cs[1] += c[1]; cs[2] += c[2]; cn++; } } }
        err += cn ? dist(cs.map(v => v / cn), want) : 0.6; n++; }
      const e = err / Math.max(1, n), cv2 = cov / Math.max(1, tot); return { score: Math.round(100 * (0.4 * cv2 + 0.6 * (1 - clamp01(e * 3)))), coverage: Math.round(cv2 * 100), colour: Math.round((1 - clamp01(e * 3)) * 100) }; }
    if (T.kind === 'piece') {
      const ln = lineScore(T.lines, 0.6), regs = (T.regions || []).map(r => ({ ...r, m: maskOf(r.shape, true), want: ttHex(r.col).map(v => v * 255), n: 0, c: 0, d: 0 }));
      const his = (T.hi || []).map(h => maskOf(h, true)), shIn = T.shade && maskOf(T.shade.in, true), inR = (b, X, Y) => X >= b[0] && X <= b[0] + b[2] && Y >= b[1] && Y <= b[1] + b[3];
      let sn = 0, sl = 0, lumL = 0, nL = 0, lumD = 0, nD = 0;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const i = (y * W + x) * 4, j = i + 3, d = densAt(i), c = colAt(i);
        if (his.some(m => m[j] > 128)) { sn++; const hi = imgd.high.data[i + 3] / 255; if (T.bare ? d < 0.2 : (hi > 0.4 || (c && (c[0] + c[1] + c[2]) / 765 > 0.75 && d > 0.3))) sl++; continue; }
        for (let k = regs.length - 1; k >= 0; k--) { const r = regs[k]; if (r.m[j] <= 128) continue;   // later regions sit on top
          if (r.tone != null) { r.n++; if (d > r.tone * 0.5) { r.c++; r.d += 1 - clamp01((Math.abs(d - r.tone) - 0.06) * 3); } break; }   // grey wash: how dark, not what colour
          r.n++; if (d > 0.55) { r.c++; if (c) r.d += 1 - clamp01(dist(c, r.want) * (r.tol || 2.6)); } break; }
        if (shIn && shIn[j] > 128) { const X = x / mm, Y = y / mm, lum = c ? (1 - d) + d * (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255 : 1;
          if (inR(T.shade.light, X, Y)) { lumL += lum; nL++; } if (inR(T.shade.dark, X, Y)) { lumD += lum; nD++; } } }
      const area = regs.reduce((t, r) => t + r.n, 0), fill = area ? regs.reduce((t, r) => t + r.n * (0.6 * r.c / Math.max(1, r.n) + 0.4 * r.d / Math.max(1, r.c)), 0) / area : null;
      const hiS = his.length ? sl / Math.max(1, sn) : null, shade = T.shade ? clamp01(((lumL / Math.max(1, nL)) - (lumD / Math.max(1, nD))) / 0.12) : null;
      const parts = [[0.35, ln.score / 100], [0.45, fill], [0.1, hiS], [0.1, shade]].filter(([, v]) => v != null), wsum = parts.reduce((t, [w]) => t + w, 0);
      const out = { score: Math.round(100 * parts.reduce((t, [w, v]) => t + w * v, 0) / wsum), lines: ln.score };
      if (fill != null) out[T.bare ? 'tones' : 'colour'] = Math.round(fill * 100); if (hiS != null) out.highlight = Math.round(hiS * 100); if (shade != null) out.shading = Math.round(shade * 100);
      return out;
    }
    return { score: 0 };
  };
  const statOf = (a) => a.length ? { med: pct(a, 0.5), p10: pct(a, 0.1), p90: pct(a, 0.9) } : null;
  const exDone = () => {
    const T = exList()[EX.i], empty = !EX.cur?.strokes, sc = empty ? { score: 0 } : scoreOf(T);
    let mx = 0, sum = 0, n = 0; for (const v of TR) if (v > 0.02) { mx = Math.max(mx, v); sum += v; n++; }
    const skin = Math.round(100 * (1 - clamp01((mx - 0.6) / 1.4))), blow = EX.cur?.blow || 0;
    const pen = exPen();
    // A lesson can set a blowout limit; going over it fails outright, however good the line.
    const blowFail = T.maxBlow != null && blow > T.maxBlow;
    const laserFail = !!EX.lesson && (EX.cur?.laser || 0) > 0;   // lessons don't allow the laser
    const crashes = EX.cur?.crash || 0, crashFail = false, crashPts = T.crashFree != null ? Math.max(0, crashes - T.crashFree) : 0;   // a free crash landing, then a point off each
    // Stipple: the point of the lesson is the gradient, so one that is uneven, patchy or barely there fails however clean the rest is.
    const gradFail = !!(T.stipple || T.wgrad) && !empty && (sc.gradient < 45 || sc.evenness < 55 || sc.smoothness < 50);
    const packFail = !!T.wgrad && !empty && +sc.packing >= 50, washFail = !!T.wgrad && !empty && sc.washes < 40;   // whip shading: no packing, and the lighter washes have to be used
    // A lesson can limit how many strokes the line is pulled in: each one over costs 3 points.
    const strokes = T.linePhase ? (EX.cur?.lineN || 0) : T.strokeNeedle ? (EX.cur?.tm?.by?.[T.strokeNeedle]?.strokes || 0) : Object.values(EX.cur?.tm?.by || {}).reduce((a, n) => a + (n.strokes || 0), 0), extraStrokes = T.maxStrokes ? Math.max(0, strokes - T.maxStrokes) : 0;
    const total0 = empty ? 0 : Math.max(0, Math.round(sc.score * 0.85 + skin * 0.15 - Math.min(15, blow * 0.5) - pen.pts - extraStrokes * 3 - crashPts)), total = blowFail || crashFail || gradFail || packFail || washFail || laserFail ? Math.min(59, total0) : total0;
    const th = composite(Math.min(1, 220 / W)).toDataURL('image/jpeg', 0.7), c = EX.cur || {};
    const res = { id: T.id, title: T.title, cat: T.cat, total, parts: sc, skin: empty ? null : skin, empty, blowFail, crashFail, crashPts, laserFail, gradFail, packFail, washFail, crashes, strokesUsed: strokes, extraStrokes, traumaMax: +mx.toFixed(2), traumaAvg: +(n ? sum / n : 0).toFixed(2), blowouts: blow, undos: EX.cur?.undos || 0, lasers: EX.cur?.laser || 0, penalty: empty ? 0 : pen.pts, thumb: th,
      stats: { pressure: statOf(c.p || []), speed: statOf(c.v || []), depth: statOf(c.d || []), tilt: statOf(c.t || []), strokes: c.strokes || 0, dips: c.dips || 0, seconds: c.t0 ? Math.round((c.t1 - c.t0) / 1000) : 0 } };
    if (EX.cur) EX.cur.scored = true;
    EX.res = EX.res.filter(r => r.id !== T.id); EX.res.push(res); st.dirty = true; exBar(res);
    if (EX.mode === 'ch') { const info = empty || EX.lesson ? null : TT.aw.record(T, res); EX.info = info; save(true); chReport(T, res, info); }
  };
  const exNext = () => { EX.cur = null; EX.i++; if (EX.i >= exList().length) { EX.done = true; EX.finished = Date.now(); exBar(); save(true); return exReport(); } exStart(true); save(true); };
  function exBar(res) {
    const b = $('#tt-exbar'); if (!b) return; b.hidden = !EX;
    if (!EX) return;
    if (EX.done) { b.innerHTML = `<div class="tt-exh"><b>Exam finished</b></div><div class="row" style="gap:6px"><button class="btn small primary" data-ex="report">Report card</button></div>`; return; }
    const T = exList()[EX.i];
    if (EX.mode === 'ch') { const p = TT.aw.get().pb[T.id];
      b.innerHTML = `<div class="tt-exh"><b>${T.title}</b>${ttStars(T.diff)}<span class="muted" style="font-size:11px">${p ? 'Best ' + p.best : ''}</span><button class="dz-ib" data-ex="fold" data-tip="Show or hide the instructions" aria-label="Instructions"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button></div>
        <p class="tt-ext" ${EX.fold ? 'hidden' : ''}>${T.text}</p>
        ${res ? `<div class="tt-exres"><b>${res.total}</b><span>${EX.lesson ? 'Grade ' + ttGrade(res.total) : ttMedal(res.total)?.[2] || 'No medal'}</span></div>
          <div class="row" style="gap:6px"><button class="btn small" data-ex="hub">${EX.lesson ? 'Lessons' : 'Challenges'}</button><span style="flex:1"></span><button class="btn small" data-ex="card">Report card</button><button class="btn small primary" data-ex="again">Try again</button></div>`
        : `${penLine()}<div class="row" style="gap:6px"><button class="btn small" data-ex="hub">${EX.lesson ? 'Lessons' : 'Challenges'}</button><button class="btn small" data-ex="retry">Start over</button><span style="flex:1"></span><button class="btn small primary" data-ex="done">Done</button></div>`}`;
      return; }
    b.innerHTML = `<div class="tt-exh"><b>${EX.i + 1} / ${exList().length} · ${T.title}</b><span class="tt-exdots">${exList().map((c, j) => `<i class="${j < EX.i ? 'done' : j === EX.i ? 'on' : ''}"></i>`).join('')}</span><button class="dz-ib" data-ex="fold" data-tip="Show or hide the instructions" aria-label="Instructions"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button></div>
      <p class="tt-ext" ${EX.fold ? 'hidden' : ''}>${T.text}</p>
      ${res ? `<div class="tt-exres"><b>${res.total}</b><span>${Object.entries(res.parts).filter(([kk, v]) => kk !== 'score' && typeof v === 'number').map(([kk, v]) => `${kk} ${v}%`).join(' · ')} · skin ${res.skin}%${res.blowouts ? ` · ${res.blowouts} blowout${res.blowouts === 1 ? '' : 's'}` : ''}${res.penalty ? ` · −${res.penalty} undo/laser` : ''}</span></div>
        <div class="row" style="gap:6px"><button class="btn small" data-ex="retry">Try again</button><span style="flex:1"></span><button class="btn small primary" data-ex="next">${EX.i === exList().length - 1 ? 'Finish' : 'Next challenge'}</button></div>`
      : `${penLine()}<div class="row" style="gap:6px"><button class="btn small" data-ex="retry">Start over</button><span style="flex:1"></span><button class="btn small primary" data-ex="done">Done</button></div>`}`;
  }
  // Undos left and points lost so far, under the instructions while a challenge is on.
  function penLine() { if (!EX?.cur) return ''; const free = freeUndos(), left = Math.max(0, free - usedUndos()), p = exPen(), T = exList()[EX.i];
    const sn = T?.maxStrokes ? T.linePhase ? (EX.cur.lineN || 0) : (T.strokeNeedle ? (EX.cur.tm?.by?.[T.strokeNeedle]?.strokes || 0) : Object.values(EX.cur.tm?.by || {}).reduce((a, n) => a + (n.strokes || 0), 0)) : 0;
    return `<div class="tt-expen"><span>Free undos ${left} / ${free}${EX.mode === 'ch' ? '' : ' (whole exam)'}</span>${T?.maxStrokes ? `<span class="tt-strk${sn > T.maxStrokes ? ' over' : ''}">${T.linePhase ? 'Line s' : T.strokeNeedle ? T.strokeNeedle + ' s' : 'S'}trokes ${sn} / ${T.maxStrokes}${sn > T.maxStrokes ? ` (−${(sn - T.maxStrokes) * 3})` : ''}</span>` : ''}${p.pts ? `<b>−${p.pts} points</b>` : ''}</div>`; }
  $('#tt-exbar').addEventListener('click', async (e) => { const a = e.target.closest('[data-ex]')?.dataset.ex; if (!a) return;
    if (a === 'fold') { EX.fold = !EX.fold; return exBar(); }
    if (a === 'done') { ttBusy('Scoring your work', 0.1); await ttFrame(); return exDone(); }
    if (a === 'retry') { if (!await ask('Start this challenge again on clean skin?')) return; return exStart(true); }
    if (a === 'next') return exNext();
    if (a === 'report') return exReport();
    if (a === 'hub') return location.hash = EX.lesson ? 'tattoo/lessons' : 'tattoo/challenges';
    if (a === 'again') { EX.res = []; EX.info = null; return exStart(true); }
    if (a === 'card') { const r = EX.res[EX.res.length - 1]; if (r) chReport(exList()[0], r, EX.info); } });
  // The report card for one challenge: score and medal, against the personal best, its parts, and trophies won.
  /* The attempt as a heat map, zoomed to the stencil: green where the strip the score looks at has ink, red where it
     hasn't, orange for ink outside the band that counts as spill, purple for skin worked into swelling, blue for blowouts.
     Uses the same strip and band as the line score, so it shows what was actually judged. */
  const heatOf = (T, res) => { const coreW = Math.min(T.core, 1.7 * (Math.max(...lay.map(n => Math.hypot(n.u, n.v))) + feel.size * 0.35)), core = T.pack ? maskOf(T.path, true) : maskOf(T.path, false, coreW), band = T.pack || T.stipple || T.wgrad || T.tri ? (() => { const f = maskOf(T.path, true), e = maskOf(T.path, false, 2.4); for (let i = 3; i < f.length; i += 4) f[i] = Math.max(f[i], e[i]); return f; })() : maskOf(T.path, false, coreW + 2.2);
    let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (band[(y * W + x) * 4 + 3] > 30) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const m = Math.round(8 * mm), spots = EX.cur?.spots || [], severe = spots.filter(s => s[2] >= TT_BLOW_SEVERE); for (const s of spots) { x0 = Math.min(x0, s[0]); y0 = Math.min(y0, s[1]); x1 = Math.max(x1, s[0]); y1 = Math.max(y1, s[1]); }
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W, x1 + m); y1 = Math.min(H, y1 + m); if (severe.length) { const need = Math.round(90 * mm) - (x1 - x0); if (need > 0) { x0 = Math.max(0, x0 - Math.ceil(need / 2)); x1 = Math.min(W, x1 + Math.ceil(need / 2)); } } const cw = x1 - x0, ch = y1 - y0, c = document.createElement('canvas'), HS = Math.min(3, 3600 / Math.max(cw, ch)); c.width = Math.round(cw * HS); c.height = Math.round(ch * HS); const g = c.getContext('2d'); g.scale(HS, HS); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';   // drawn larger than the piece, so full screen stays sharp
    g.fillStyle = '#101314'; g.fillRect(0, 0, cw, ch); g.globalAlpha = 0.4; g.drawImage(composite(1), -x0, -y0); g.globalAlpha = 1;
    const im = g.createImageData(cw, ch), D = im.data, bl = (() => { const bc = document.createElement('canvas'); bc.width = W; bc.height = H; const bg = bc.getContext('2d'); bg.drawImage(blowC, 0, 0, W, H); return bg.getImageData(0, 0, W, H).data; })(), put = (i, r, gg, b) => { D[i] = r; D[i + 1] = gg; D[i + 2] = b; D[i + 3] = 255; }, third = [0, 0, 0], hm = EX.cur?.hm || [], hmN = hm.filter(v => v > 0), hmM = hmN.reduce((a, v) => a + v, 0) / Math.max(1, hmN.length), hmv = (x, y) => (hm[Math.floor(y * 2) * 30 + Math.floor(x * 2)] || 0) / Math.max(1, hmM); let miss = 0, cn = 0, sx = 0, sy = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const px = x + x0, py = y + y0, j = (py * W + px) * 4, i = (y * cw + x) * 4, d = densAt(j), tp = TP[Math.floor(py / TS) * tw + Math.floor(px / TS)];
      if (tp > 1) put(i, 120, 60, 170);
      if (bl[j + 3] > 40) put(i, 60, 130, 255);
      if (d > 0.2 && band[j + 3] < 30) put(i, 255, 150, 40);
      if (T.pack && core[j + 3] > 128) { cn++; const hv = hmv((px / mm - T.pack[0]), (py / mm - T.pack[1])); if (!(d > 0.7 && hv >= 0.75)) miss++; }
      else if (!T.stipple && !T.wgrad && !T.tri && core[j + 3] > 128) { cn++; if (d > 0.28) put(i, 60, 220, 120); else { put(i, 240, 60, 60); miss++; sx += px; sy += py; third[Math.min(2, Math.floor((py - y0 - m) / Math.max(1, ch - 2 * m) * 3))]++; } } }
    const ov = document.createElement('canvas'); ov.width = cw; ov.height = ch; ov.getContext('2d').putImageData(im, 0, 0); g.filter = `blur(${Math.max(2, mm * 0.5) * HS}px)`; g.globalAlpha = 0.55; g.drawImage(ov, 0, 0); g.filter = 'none'; g.globalAlpha = 1; g.drawImage(ov, 0, 0);
    if (T.pack) { const N = T.pack[2] * 2, pm = document.createElement('canvas'); pm.width = pm.height = N; const pg = pm.getContext('2d'), pi = pg.createImageData(N, N), mix = (a, b, f) => a.map((v, n) => v + (b[n] - v) * f), RED = [235, 60, 60], YEL = [240, 200, 60], GRN = [60, 220, 120], ORG = [255, 150, 40];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const cd = T.circle ? Math.hypot(T.pack[0] + (i + 0.5) / 2 - T.circle[0], T.pack[1] + (j + 0.5) / 2 - T.circle[1]) - T.circle[2] : 0; if (T.circle && cd > 0.25) { pi.data[(j * N + i) * 4 + 3] = 0; continue; } const edge = T.circle ? cd > -1 : i < 2 || j < 2 || i >= N - 2 || j >= N - 2, dE = edge ? densAt((Math.round((T.pack[1] + (j + 0.5) / 2) * mm) * W + Math.round((T.pack[0] + (i + 0.5) / 2) * mm)) * 4) : 0, r = edge && dE > 0.7 ? 1 : (hm[j * 30 + i] || 0) / Math.max(1, hmM), c0 = r < 0.7 ? RED : r < 0.9 ? mix(RED, YEL, (r - 0.7) / 0.2) : r < 1.05 ? mix(YEL, GRN, (r - 0.9) / 0.15) : r < 1.3 ? GRN : mix(GRN, ORG, Math.min(1, (r - 1.3) / 0.3)), q = (j * N + i) * 4; pi.data[q] = c0[0]; pi.data[q + 1] = c0[1]; pi.data[q + 2] = c0[2]; pi.data[q + 3] = 255; }
      pg.putImageData(pi, 0, 0); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(pm, T.pack[0] * mm - x0, T.pack[1] * mm - y0, T.pack[2] * mm, T.pack[3] * mm); g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = Math.max(1, mm * 0.1); if (T.circle) { g.beginPath(); g.arc(T.circle[0] * mm - x0, T.circle[1] * mm - y0, T.circle[2] * mm, 0, 7); g.stroke(); } else g.strokeRect(T.pack[0] * mm - x0, T.pack[1] * mm - y0, T.pack[2] * mm, T.pack[3] * mm); }
    if (T.tri || T.wgrad || T.stipple) { const fm = maskOf(T.path, true), cells = []; let sum = 0;   /* passes per skin cell inside the shape, against the average there */
      for (let y = Math.floor(y0 / TS); y <= Math.min(th - 1, Math.ceil(y1 / TS)); y++) for (let x = Math.floor(x0 / TS); x <= Math.min(tw - 1, Math.ceil(x1 / TS)); x++) { const px = Math.min(W - 1, Math.round((x + 0.5) * TS)), py = Math.min(H - 1, Math.round((y + 0.5) * TS)); if (fm[(py * W + px) * 4 + 3] < 128) continue; const h = HC[y * tw + x] || 0; cells.push([x, y, h]); sum += h; }
      const avg = sum / Math.max(1, cells.length), mix = (a, b, f) => a.map((v, n) => v + (b[n] - v) * f), RED = [235, 60, 60], YEL = [240, 200, 60], GRN = [60, 220, 120], ORG = [255, 150, 40];
      if (avg > 0) { const pc = document.createElement('canvas'); pc.width = cw; pc.height = ch; const pg = pc.getContext('2d');
        for (const [x, y, h] of cells) { const r = h / avg, c0 = r < 0.5 ? RED : r < 0.85 ? mix(RED, YEL, (r - 0.5) / 0.35) : r < 1.05 ? mix(YEL, GRN, (r - 0.85) / 0.2) : r < 1.5 ? GRN : mix(GRN, ORG, Math.min(1, (r - 1.5) / 0.5)); pg.fillStyle = `rgb(${c0.map(Math.round).join(',')})`; pg.fillRect(x * TS - x0, y * TS - y0, TS + 0.5, TS + 0.5); }
        g.save(); g.filter = `blur(${Math.max(1, TS * 0.6)}px)`; g.globalAlpha = 0.85; g.drawImage(pc, 0, 0); g.restore(); }
      g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = Math.max(1, mm * 0.1); g.save(); g.translate(-x0, -y0); g.scale(mm, mm); g.beginPath(); T.path(g); g.restore(); g.stroke(); }
    // A ring around every blowout, and for a really bad one, an arrow and the level of disappointment.
    const u = mm, ringR = (s) => Math.min(6, 2.5 + s[2] * 0.1) * u; g.lineWidth = 0.4 * u; g.strokeStyle = '#fff'; for (const s of spots) { g.beginPath(); g.arc(s[0] - x0, s[1] - y0, ringR(s), 0, 7); g.stroke(); }
    let nextY = 2 * u, jk = Math.floor(Math.random() * TT_BLOW_JOKES.length); for (const s of [...severe].sort((a, b) => a[1] - b[1])) { const sx0 = s[0] - x0, sy0 = s[1] - y0, onRight = sx0 < cw / 2, bw = Math.min(cw * 0.42, 30 * u), pad = 1.2 * u, fs = Math.round(2.6 * u); g.font = `700 ${fs}px Inter, sans-serif`;
      const words = TT_BLOW_JOKES[jk++ % TT_BLOW_JOKES.length].split(' '), lines = ['']; for (const w of words) { const n = (lines[lines.length - 1] + ' ' + w).trim(); if (g.measureText(n).width > bw - pad * 2 && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = n; }
      const bh = lines.length * fs * 1.25 + pad * 2, bx = onRight ? cw - bw - 2 * u : 2 * u, by = Math.min(ch - bh - 2 * u, Math.max(nextY, sy0 - bh / 2)); nextY = by + bh + 2 * u;
      const ex = onRight ? bx : bx + bw, ey = by + bh / 2, ang = Math.atan2(sy0 - ey, sx0 - ex), R = ringR(s) + 0.6 * u, tx = sx0 - Math.cos(ang) * R, ty = sy0 - Math.sin(ang) * R, hd = 2 * u; g.strokeStyle = g.fillStyle = '#ffd24a'; g.lineWidth = 0.5 * u; g.beginPath(); g.moveTo(ex, ey); g.lineTo(tx, ty); g.stroke();
      g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx - Math.cos(ang - 0.45) * hd, ty - Math.sin(ang - 0.45) * hd); g.lineTo(tx - Math.cos(ang + 0.45) * hd, ty - Math.sin(ang + 0.45) * hd); g.closePath(); g.fill();
      g.fillStyle = 'rgba(15,18,19,.94)'; g.fillRect(bx, by, bw, bh); g.strokeRect(bx, by, bw, bh); g.fillStyle = '#ffd24a'; lines.forEach((l, i) => g.fillText(l, bx + pad, by + pad + fs * (i + 0.85) * 1.15)); }
    const notes = [], P = res.parts, big = third.indexOf(Math.max(...third));
    if (T.tri) { if (P.colour < 70) notes.push('Some parts are off the colours asked for: a black and red shadow at the point, then red, orange by three quarters, and yellow at the wide end.'); if (P.blend < 70) notes.push('There is a hard step where one colour meets the next, or one side of the triangle differs from the other. Overlap each new colour onto the last and feather it in.'); if (P.healing < 80) notes.push('Parts of it would heal patchy: keep layering there until it is fully solid, without chewing up the skin.'); if (P.saturation < 80 || P.coverage < 80) notes.push('It needs more ink overall. Saturate each colour until it is solid.'); if (P.outline < 70) notes.push('Your outline was uneven: keep the 7RL at one steady depth, the edges straight, and whip out of the point to keep it sharp.'); if (P.spill > 2) notes.push('Some colour went over the line. Tilt and angle the magnum to get into the point instead of pushing past the edge.'); if (P.voltage < 70) notes.push('Line at about 7.5 V on the 7RL.'); }
    else if (T.wgrad) { if (P.gradient < 70) notes.push('The gradient is not smooth yet: Black at one end fading to almost bare skin at the other, with no step where one wash meets the next. Fade each wash off the end of the last.'); if (P.evenness < 75) notes.push('The shade is patchy across the width. Lay each set of whips evenly from one side to the other.'); if (P.whips < 70) notes.push('Not all your shading was whips. Land on the move, flick through and lift off on the move, and never go round in circles.'); if (P.washes < 75) notes.push('Use the washes in turn: Black first, then Dark or Mid, then Light, each faded off the last.'); if (P.edges < 70) notes.push('There is a holiday, a light gap between the line and your shade. Tilt the curved mag a little so its end sits against the line.'); if (P.inside < 80) notes.push('Some whips crossed the line. At the light end, start at the line and whip away from it into your previous shade.'); if (P.voltage < 70) notes.push('Check your voltage: about 7.5 V on the 9RL to line, and about 6.6 V on the curved mag to shade.'); }
    else if (T.stipple) { if (P.gradient < 70) notes.push('The gradient is not smooth yet: one end should be dark and the other almost bare, with no hard step between. Layer the dark end more often and the light end only a few times.'); if (P.evenness < 75) notes.push('The shade is patchy across the width: some spots got more dots than the rest of their row. Spread each layer of whips evenly from one side to the other.'); if (P.dots < 70) notes.push('Parts of it went solid. Keep the voltage low and whip quickly so each pass leaves separate dots, and do not go back over the same spot until it fills in.'); if (P.inside < 80) notes.push('Some whips ran over the line. Start and finish every whip inside the rectangle: aim the flick to end just short of the line.'); if (P.whips < 60) notes.push('Most of your shading strokes were not whips. Land softly while already moving, flick through and lift off on the move.'); if (P.voltage < 70) notes.push(`Check your voltage: about 7.2 V to line${P.lineVolts ? ` (yours averaged ${P.lineVolts} V)` : ''}, then 4.8 to 5.8 V to shade.`); if (P.outline < 70) notes.push('Your outline was uneven: keep the rectangle\'s edges straight and at one steady depth.'); }
    else if (T.pack) { if (P.consistency < 80) notes.push('Red and yellow are patches with fewer passes than your average, even if they look dark, and they will heal patchy. Orange got more than the rest. Keep your circles tight and your speed the same, and overlap every pass.'); if (P.outline < 70) notes.push(`Your outline was uneven: keep the ${T.liner || '5RL'} at one steady depth, and keep the ${T.circle ? 'circle round' : 'square\'s edges straight'}.`); if (P.colour != null && P.colour < 75) notes.push(`Your colour came out away from an even orange (yours was ${P.yourColour || 'off'}). Hold the red and yellow caps for about the same time.`); if (P.healing != null && P.healing < 80) notes.push('Parts of it would heal patchy: layer more passes there until it is fully solid.'); if (P.technique < 70) notes.push('Your motion kept changing direction instead of circling one way. That is scrubbing: tight circles or ovals, always turning the same way, moving steadily across.'); if (P.control < 70) notes.push(`Your speed or depth was not steady${EX.cur?.mv?.n ? ` (you averaged about ${Math.round(EX.cur.mv.vm)} mm/s, and ${Math.round((EX.cur.mv.fast || 0) / Math.max(1, EX.cur.mv.all) * 100)}% of your travel was over 110 mm/s)` : ''}. Rushing usually means scrubbing: slow down and keep the same pace and depth.`); if (P.saturation < 80) notes.push('It needs more ink overall. Slower, overlapping passes go in darker. Do not dig to get there.'); if (P.spill > 2) notes.push('Orange is ink outside your line. Slow your sweep as you reach the edge and turn back sooner.'); const unused = (T.needles || []).filter(n => !EX.cur?.used?.[n]); if (unused.length) notes.push(`You did not use the ${unused.join(' or ')} this lesson asks for.`); }
    else if (cn && miss / cn > 0.05) notes.push(`Red shows where the line left the stencil or went too light. Most of it is in the ${['top', 'middle', 'bottom'][big]} third. Keep your eye just ahead of the needle and hold your pressure there.`);
    if (!T.pack && P.spill > 2) notes.push('Orange is ink well off the line. Slow your approach and land on the stencil before you pull.');
    if (P.evenness < 75) notes.push('The darkness changes along the line. That usually means your speed or pressure changed, often at the start and end, or where you restarted.');
    if (P.weight != null && P.weight < 75) notes.push('The thickness changes along the line. Watch for slowing down or pressing in through the curves.');
    if (T.corners) notes.push(...cornerNotes);
    if (res.blowouts) notes.push(`Blue with a white ring is blowout, ${spots.length} spot${spots.length === 1 ? '' : 's'}: pressing deep while moving slowly. Keep moving whenever the needle is in.`);
    if (res.skin != null && res.skin < 90) notes.push('Purple is overworked skin. Make fewer passes, and let it settle before pressing Done.');
    const sf = settingsCheck(T); if (sf.length) notes.push(`Settings past their limit, which can make this easier: ${sf.map(s => `${s.name} ${s.value} (default ${s.default})`).join(', ')}.`);
    if (!notes.length) notes.push(T.tri ? 'Nothing stands out: a clean attempt. To score higher, blend each colour further into the next and keep the point dark and sharp.' : T.wgrad ? 'Nothing stands out: a clean attempt. To score higher, fade each wash further into the last and keep the edges hard against the line.' : T.stipple ? 'Nothing stands out: a clean attempt. To score higher, take the dark end a little darker and keep every row of dots even from side to side.' : T.pack ? 'Nothing stands out: a clean attempt. To score higher, layer your passes more evenly so no spot gets fewer than the rest.' : 'Nothing stands out: a clean attempt. To score higher, keep the line dead centre on the stencil and the speed steady from start to finish.');
    return { c, notes, crop: [x0, y0, cw, ch] }; };
  // The attempt on one A4 page: report, finished piece and heat map, then fresh, healed and 10 years, cropped the same.
  const reportPage = async (T, res, heat, parts) => { const P = 1240, Q = 1754, m = 60, c = document.createElement('canvas'); c.width = P; c.height = Q; const g = c.getContext('2d'), [x0, y0, cw, ch] = heat.crop; g.fillStyle = '#fff'; g.fillRect(0, 0, P, Q); const ink = '#171a1b', soft = '#5f6a6b', col = (v) => v >= 80 ? '#17a697' : v >= 65 ? '#d29a26' : '#d3524c';
    g.fillStyle = ink; g.font = '700 44px Inter, sans-serif'; g.fillText(EX.lesson ? `Lesson ${EX.lesson}: ${T.title}` : `Challenge: ${T.title}`, m, 90); g.fillStyle = soft; g.font = '500 24px Inter, sans-serif'; g.fillText(`${new Date().toLocaleString()}  ·  Build ${TT_BUILD}  ·  ${res.blowouts || 0} blowouts  ·  ${res.undos || 0} undos`, m, 130);
    g.textAlign = 'right'; g.fillStyle = col(res.total); g.font = '800 92px Inter, sans-serif'; g.fillText(ttGrade(res.total), P - m, 100); g.font = '700 28px Inter, sans-serif'; g.fillText(`${res.total} / 100`, P - m, 138); g.textAlign = 'left';
    const rows = [...parts, ...(res.skin != null ? [['skin', res.skin]] : [])]; rows.forEach(([k, v], i) => { const cx = m + (i % 2) * 570, y = 178 + Math.floor(i / 2) * 42; g.fillStyle = ink; g.font = '500 24px Inter, sans-serif'; g.fillText(k[0].toUpperCase() + k.slice(1), cx, y + 18); g.fillStyle = '#e5e8e8'; g.fillRect(cx + 170, y, 300, 20); g.fillStyle = col(v); g.fillRect(cx + 170, y, 3 * v, 20); g.fillStyle = ink; g.textAlign = 'right'; g.fillText(String(v), cx + 530, y + 18); g.textAlign = 'left'; });
    const top = 190 + Math.ceil(rows.length / 2) * 42, fit = (src, label, bx, by, bw, bh, sx = x0, sy = y0, sw = cw, sh = ch) => { const s = Math.min(bw / sw, (bh - 34) / sh), dw = sw * s, dh = sh * s; g.fillStyle = soft; g.font = '600 22px Inter, sans-serif'; g.fillText(label, bx, by + 22); g.drawImage(src, sx, sy, sw, sh, bx + (bw - dw) / 2, by + 34, dw, dh); };
    const half = (P - 2 * m - 30) / 2, third = (P - 2 * m - 40) / 3, h1 = 640; g.imageSmoothingQuality = 'high'; if (heat.none) fit(composite(1), 'Finished piece', m, top, P - 2 * m, h1); else { fit(composite(1), 'Finished piece', m, top, half, h1); fit(heat.c, 'Heat map', m + half + 30, top, half, h1, 0, 0, heat.c.width, heat.c.height); }
    const y2 = top + h1 + 20; [['fresh', 'Fresh'], ['healed', 'Healed'], ['aged', '10 years']].forEach(([md, lb], i) => fit(viewOf(md), lb, m + i * (third + 20), y2, third, 400));
    const y3 = y2 + 420; g.fillStyle = ink; g.font = '400 21px Inter, sans-serif'; let yy = y3; for (const n of heat.notes) { const words = n.split(' '); let ln = ''; for (const w of words) { const nx = ln ? ln + ' ' + w : w; if (g.measureText(nx).width > P - 2 * m) { if (yy < Q - 30) g.fillText(ln, m, yy); yy += 27; ln = w; } else ln = nx; } if (yy < Q - 30) g.fillText(ln, m, yy); yy += 33; }
    return c; };
  const shareStats = (T, res, heat, parts, statsTxt) => { const o = document.createElement('div'); o.id = 'tt-share'; o.className = 'tt-tune'; o.style.cssText = 'position:fixed;inset:0;z-index:110;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.6)';
    o.innerHTML = `<div class="card tt-tcard" style="max-width:360px"><h2 style="margin-top:0">Share this attempt</h2><p class="muted" style="margin-top:0">Copy the stats as text, or save a PDF with the report, pictures, healed stages and stats.</p><div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn" data-sh="close">Cancel</button><span style="flex:1"></span><button class="btn" data-sh="copy">Copy stats</button><button class="btn primary" data-sh="pdf" ${heat ? '' : 'disabled'}>Save PDF</button></div></div>`;
    o.onclick = async (e) => { const b = e.target.closest('[data-sh]'); if (!b) return; const a = b.dataset.sh; if (a === 'close') return o.remove();
      if (a === 'copy') { try { await navigator.clipboard.writeText(statsTxt); toast('Stats copied.'); } catch { await askText('Copy these stats:', statsTxt); } return o.remove(); }
      if (b.disabled) return; b.disabled = true; b.textContent = 'Saving…'; try { const pg = await reportPage(T, res, heat, parts), jb = await new Promise(r => pg.toBlob(r, 'image/jpeg', 0.88)), jpeg = new Uint8Array(await jb.arrayBuffer()), pdf = ttStatsPdf(jpeg, pg.width, pg.height, statsTxt), name = `lesson-${EX.lesson}-${ttGrade(res.total)}-${res.total}-${ymd(new Date())}.pdf`; await saveFiles([new File([pdf], name, { type: 'application/pdf' })]); o.remove(); } catch (err) { b.disabled = false; b.textContent = 'Save PDF'; toast('Could not save: ' + err.message, 4000); } };
    document.body.appendChild(o); };
  async function lessonReport(T, res) {
    const g = ttGrade(res.total), pass = !res.empty && res.total >= TT_LS_PASS, parts = Object.entries(res.parts).filter(([kk, v]) => kk !== 'score' && typeof v === 'number');
    const p = ttLessonProg(); p.best = p.best || {}; if (!res.empty) p.best[EX.lesson] = Math.max(p.best[EX.lesson] ?? 0, res.total); if (pass) p.done[EX.lesson] = p.done[EX.lesson] || Date.now();
    ttBusy('Making the heat map', 0.35); await ttFrame(); const heat = res.empty ? null : heatOf(T, res), hurl = heat?.c.toDataURL('image/jpeg', 0.92), purl = composite(Math.min(1, 1600 / W)).toDataURL('image/jpeg', 0.9), old = p.results?.[EX.lesson];   // the best passed attempt, kept as proof: the finished piece with its report card
    if (pass && (!old || res.total > old.total)) { const sc = Math.min(1, 1600 / W), blob = await new Promise(r => composite(sc).toBlob(r, 'image/jpeg', 0.9));
      p.results = p.results || {}; p.results[EX.lesson] = { ref: await Media.save(blob, 'jpg'), total: res.total, parts, skin: res.skin, blowouts: res.blowouts, undos: res.undos, penalty: res.penalty, strokes: res.stats?.strokes || 0, when: Date.now(), build: TT_BUILD, heat: await Media.save(await new Promise(r => heat.c.toBlob(r, 'image/jpeg', 0.92)), 'jpg'), notes: heat.notes }; if (old?.ref) await Media.release(old.ref); if (old?.heat) await Media.release(old.heat); }
    await Settings.set('tt_lessons', JSON.stringify(p));
    const statsTxt = JSON.stringify(tmReport(T, res)); if (pass && p.results?.[EX.lesson]?.when && p.results[EX.lesson].total === res.total) { p.results[EX.lesson].stats = statsTxt; await Settings.set('tt_lessons', JSON.stringify(p)); }
    /* The last attempt, pass or fail, kept so it can be reopened after leaving the app. Only one is kept. Saved at slightly
       different quality from the best result so the two never share a file (media files are named by their content). */
    ttBusy('Saving your attempt', 0.65); await ttFrame(); if (heat) { const jpg = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q)), prev = p.last, pg = await reportPage(T, res, heat, parts); p.last = { lesson: EX.lesson, ref: await Media.save(await jpg(composite(Math.min(1, 1600 / W)), 0.89), 'jpg'), heat: await Media.save(await jpg(heat.c, 0.91), 'jpg'), page: await Media.save(await jpg(pg, 0.87), 'jpg'), pw: pg.width, ph: pg.height, notes: heat.notes, total: res.total, parts, skin: res.skin, blowouts: res.blowouts, undos: res.undos, strokes: res.stats?.strokes || 0, when: Date.now(), build: TT_BUILD, stats: statsTxt, pass };
      await Settings.set('tt_lessons', JSON.stringify(p)); for (const k of ['ref', 'heat', 'page']) if (prev?.[k] && prev[k] !== p.last[k]) await Media.release(prev[k]); }
    const col = v => v >= 80 ? 'var(--teal)' : v >= 65 ? '#e8b44c' : '#e0605a', o = document.createElement('div'); o.id = 'merge-dlg'; o.className = 'tt-tune'; o.style.zIndex = 98;
    o.innerHTML = `<div class="card tt-tcard tt-report tt-chrep"><div class="tt-grade"><b>${res.empty ? '–' : g}</b><div><h2 style="margin:0">${esc(T.title)}</h2><span class="muted">Build ${TT_BUILD} · ${res.empty ? 'Nothing tattooed yet' : `${res.total} / 100 · ${res.blowFail ? 'Failed: too much blowout' : res.laserFail ? 'Failed: the laser was used' : res.crashFail ? 'Failed: too many crash landings' : res.gradFail ? 'Failed: the gradient is uneven' : res.packFail ? 'Failed: that was packed, not whipped' : res.washFail ? 'Failed: the lighter washes were not used' : pass ? 'Passed: the next lesson is unlocked' : 'C (70) or higher moves you on'}`}</span></div></div>
      <div class="tt-cats tt-lscats">${parts.map(([kk, v]) => `<div><span>${kk[0].toUpperCase() + kk.slice(1)}</span><i><s style="width:${v}%;background:${col(v)}"></s></i><b>${v}</b></div>`).join('')}${res.skin != null ? `<div><span>Skin</span><i><s style="width:${res.skin}%;background:${col(res.skin)}"></s></i><b>${res.skin}</b></div>` : ''}</div>
      ${T.crashFree != null && res.crashes ? `<p class="muted" style="margin:4px 0">${res.crashes} crash landing${res.crashes === 1 ? '' : 's'}: ${T.crashFree} free${res.crashPts ? `, −${res.crashPts} point${res.crashPts === 1 ? '' : 's'}` : ''}. Land and lift off on the move.</p>` : ''}${res.packFail ? '<p class="muted" style="margin:4px 0">The curved mag went round in circles: that is packing. In this lesson every stroke has to be a whip.</p>' : ''}${res.washFail ? '<p class="muted" style="margin:4px 0">The gradient has to be built from the washes in turn, Black down to Light, not from black alone.</p>' : ''}${res.gradFail ? '<p class="muted" style="margin:4px 0">The gradient has to run smoothly and evenly from dark to light to pass. Gradient needs 45, evenness 55 and smoothness 50.</p>' : ''}${res.blowouts ? `<p class="muted" style="margin:4px 0">${res.blowFail ? `${res.blowouts} blowouts. More than 1 is an instant fail.` : '1 blowout: that is your limit.'}</p>` : ''}${res.penalty ? `<p class="muted" style="margin:4px 0">−${res.penalty} points for undos</p>` : ''}${T.maxStrokes ? `<p class="muted" style="margin:4px 0">${res.strokesUsed} ${T.strokeNeedle ? T.strokeNeedle + ' ' : ''}stroke${res.strokesUsed === 1 ? '' : 's'} of ${T.maxStrokes} allowed${res.extraStrokes ? ` · −${res.extraStrokes * 3} points` : ''}</p>` : ''}
      ${ttTryBar()}${ttChips(statsTxt)}${ttShotHtml(purl, hurl, heat?.notes, !!(T.pack || T.tri || T.wgrad || T.stipple))}
      <div class="row" style="gap:6px;margin-top:12px"><button class="btn ${pass ? '' : 'primary'}" style="flex:1" data-lr="again">Try again</button>${pass ? '<button class="btn primary" style="flex:1" data-lr="out">Continue</button>' : ''}</div>
      <div class="row" style="gap:6px;margin-top:6px;justify-content:center"><button class="btn small" data-lr="out">Lessons</button><button class="btn small" data-lr="close">Close</button><button class="btn small" data-lr="copy" data-tip="Copy every stat from this attempt as text, to compare attempts">Copy stats</button></div></div>`;
    ttShotBind(o, purl, hurl);
    o.onclick = async (e) => { const a = e.target.closest('[data-lr]')?.dataset.lr; if (!a) return; if (a === 'copy') return shareStats(T, res, heat, parts, statsTxt); o.remove(); if (a === 'out') location.hash = 'tattoo/lessons'; if (a === 'again') { EX.res = []; EX.info = null; exStart(true); } };
    ttBusy(null); document.body.appendChild(o);
  }
  // The last challenge done, pass or fail, kept so it can be reopened after leaving the app. Only one is kept.
  const saveChLast = async (T, res) => { if (res.empty) return; const jpg = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q)), parts = Object.entries(res.parts).filter(([kk, v]) => kk !== 'score' && typeof v === 'number'); let prev = null; try { prev = JSON.parse(Settings.get('tt_chlast', 'null')); } catch {} const pg = await reportPage(T, res, { none: true, c: composite(1), crop: [0, 0, W, H], notes: [] }, parts), next = { id: T.id, title: T.title, ref: await Media.save(await jpg(composite(Math.min(1, 1600 / W)), 0.89), 'jpg'), page: await Media.save(await jpg(pg, 0.87), 'jpg'), pw: pg.width, ph: pg.height, total: res.total, parts, skin: res.skin, blowouts: res.blowouts, undos: res.undos, strokes: res.stats?.strokes || 0, when: Date.now(), build: TT_BUILD, stats: JSON.stringify(tmReport(T, res)) }; await Settings.set('tt_chlast', JSON.stringify(next)); for (const k of ['ref', 'page']) if (prev?.[k] && prev[k] !== next[k]) await Media.release(prev[k]); };
  function chReport(T, res, info) {
    if (EX.lesson) return lessonReport(T, res); ttBusy(null);
    if (!EX.savedLast || EX.savedLast !== res) { EX.savedLast = res; saveChLast(T, res).catch(() => {}); }
    const m = ttMedal(res.total), parts = Object.entries(res.parts).filter(([kk, v]) => kk !== 'score' && typeof v === 'number');
    const all = TT_CH.filter(c => ttHubOf(c) === ttHubOf(T)).sort((x, y) => x.diff - y.diff), next = all[all.indexOf(T) + 1];
    const o = document.createElement('div'); o.id = 'merge-dlg'; o.className = 'tt-tune'; o.style.zIndex = 98;
    o.innerHTML = `<div class="card tt-tcard tt-report tt-chrep"><div class="tt-grade ${m ? m[1] : ''}"><b>${res.total}</b><div><h2 style="margin:0">${esc(T.title)}</h2>
        <span class="muted">${ttStars(T.diff)} ${m ? m[2] + ' medal' : res.empty ? 'Nothing tattooed' : 'No medal yet: 60 for bronze'}</span></div>${ttMedalIco(m, 40)}</div>
      ${info ? (info.newPb ? `<div class="tt-pb">New personal best! <span>was ${info.was}</span></div>` : info.first ? '<div class="tt-pb">First try: that\'s your score to beat.</div>' : `<div class="muted" style="margin:6px 0">Personal best: ${info.best}</div>`) : ''}
      <div class="tt-cats">${parts.map(([kk, v]) => `<div><span>${kk[0].toUpperCase() + kk.slice(1)}</span><i><s style="width:${v}%;background:${v >= 80 ? 'var(--teal)' : v >= 65 ? '#e8b44c' : '#e0605a'}"></s></i><b>${v}</b></div>`).join('')}
        ${res.skin != null ? `<div><span>Skin</span><i><s style="width:${res.skin}%;background:${res.skin >= 80 ? 'var(--teal)' : res.skin >= 65 ? '#e8b44c' : '#e0605a'}"></s></i><b>${res.skin}</b></div>` : ''}</div>
      ${res.blowouts ? `<p class="muted" style="margin:4px 0">${res.blowouts} blowout${res.blowouts === 1 ? '' : 's'}</p>` : ''}
      ${res.penalty ? `<p class="muted" style="margin:4px 0">−${res.penalty} points: ${[res.undos ? `${res.undos} undo${res.undos === 1 ? '' : 's'}` : '', res.lasers ? `laser ${res.lasers} time${res.lasers === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}</p>` : ''}
      <img class="tt-chshot" src="${res.thumb}" alt="">
      ${info?.gained?.length ? `<div class="lbl">Trophies won</div><div class="tt-cabinet">${info.gained.map(t => `<div class="tt-trophy won">${ttCup(t.tier, 30)}<b>${esc(t.name)}</b><span>${esc(t.desc)}</span></div>`).join('')}</div>` : ''}
      ${ttHubOf(T) === 'flash' && !res.empty ? `<div class="tt-pfask"><span>Keep this flash piece? It goes to Portfolio › Simulator with fresh, healed and 10 year views and this score card.</span><button class="btn primary small" data-cr="pf">Save to portfolio</button></div>` : ''}
      <div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap"><button class="btn" data-cr="hub">Challenges</button><button class="btn" data-cr="save">Save card</button><span style="flex:1"></span>
        ${next ? '<button class="btn" data-cr="next">Next challenge</button>' : ''}<button class="btn" data-cr="close">Close</button><button class="btn primary" data-cr="again">Try again</button></div></div>`;
    o.onclick = async (e) => { const a = e.target.closest('[data-cr]')?.dataset.cr; if (!a) return;
      if (a === 'close') return o.remove();
      if (a === 'hub') { o.remove(); location.hash = 'tattoo/challenges'; return; }
      if (a === 'next') { o.remove(); if (st.dirty) await save(true); return ttChStart(next.id); }
      if (a === 'again') { o.remove(); EX.res = []; EX.info = null; return exStart(true); }
      if (a === 'pf') { const bt = e.target.closest('[data-cr]'); if (bt.disabled) return; bt.disabled = true;
        try { await toPortfolio(await cardOf(T, res, info), T.title); bt.textContent = 'Saved'; } catch (err) { bt.disabled = false; toast('Could not save: ' + err.message, 4000); } return; }
      if (a === 'save') return saveFiles([await canvasFile(await cardOf(T, res, info), `${T.id}-${res.total}-${ymd(new Date())}.png`)]);
    };
    document.body.appendChild(o);
  }
  // The score card as a picture: the attempt, the score, medal and best, for comparing later.
  async function cardOf(T, res, info) {
    const m = ttMedal(res.total), parts = Object.entries(res.parts).filter(([kk, v]) => kk !== 'score' && typeof v === 'number');
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1350; const g = c.getContext('2d');
    g.fillStyle = '#121617'; g.fillRect(0, 0, 1080, 1350);
    const im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = res.thumb; });
    const s2 = Math.min(1000 / im.width, 700 / im.height); g.drawImage(im, (1080 - im.width * s2) / 2, 300, im.width * s2, im.height * s2);
    g.fillStyle = '#e9e3d6'; g.font = "64px 'Pirata One', serif"; g.fillText(T.title, 50, 110);
    g.font = '600 30px Inter, sans-serif'; g.fillStyle = '#9aa5a6'; g.fillText(`${'★'.repeat(T.diff)}  ·  ${new Date().toLocaleDateString()}${info ? '  ·  best ' + info.best : ''}`, 50, 165);
    g.fillStyle = m ? { gold: '#e2b34a', silver: '#c9d1d6', bronze: '#c88a55' }[m[1]] : '#1fb5a8'; g.font = '800 120px Inter, sans-serif'; g.textAlign = 'right'; g.fillText(String(res.total), 1030, 140);
    g.font = '700 30px Inter, sans-serif'; g.fillText(m ? m[2].toUpperCase() : 'NO MEDAL', 1030, 190); g.textAlign = 'left';
    g.font = '500 28px Inter, sans-serif'; g.fillStyle = '#e9e3d6';
    [...parts, ...(res.skin != null ? [['skin', res.skin]] : [])].forEach(([kk, v], n) => g.fillText(`${kk[0].toUpperCase() + kk.slice(1)}  ${v}`, 50 + (n % 2) * 520, 1080 + Math.floor(n / 2) * 50));
    return c;
  }
  const CATS = [['line', 'Linework', 'Pull lines in one steady motion at your lining speed, with the same depth all the way; follow the stencil rather than going back over it.'],
    ['shade', 'Shading', 'Let speed do the fading: slow and pressed in where it should be dark, faster and lighter as it fades; keep a steady rhythm on a pendulum.'],
    ['pack', 'Packing', 'Overlap your passes so no skin shows between them, and stop at the line: solid and even, not more passes in one spot.'],
    ['colour', 'Colour', 'Mix by dipping (the longer the dip, the more of that colour), and lay light colours into feathered edges, never over solid dark.'],
    ['skin', 'Skin care', 'Fewer, lighter passes: get it in once at the right depth rather than going over and over the same skin.'],
    ['blow', 'Blowouts', 'Ease off when you slow down: deep and slow pushes ink under the skin. Keep your depth steady as your speed changes.']];
  const exCats = () => {
    const R = EX.res, by = (c) => R.filter(r => r.cat === c), avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null, fin = R.find(r => r.id === 'final' && !r.empty);
    return { line: avg([...by('line').map(r => r.parts.score), ...(fin ? [fin.parts.lines] : [])]), shade: avg([...by('shade').map(r => r.parts.score), ...(fin ? [fin.parts.shading] : [])]),
      pack: avg(by('pack').map(r => r.parts.score)), colour: avg([...by('colour').map(r => r.parts.score), ...(fin ? [fin.parts.colour != null ? Math.round((fin.parts.colour * 2 + (fin.parts.highlight ?? fin.parts.colour)) / 3) : Math.round((fin.parts.red + fin.parts.banner + fin.parts.highlight) / 3)] : [])]),
      skin: avg(R.filter(r => !r.empty).map(r => r.skin)), blow: R.some(r => !r.empty) ? Math.max(0, 100 - R.reduce((x, r) => x + r.blowouts, 0) * 3) : null };
  };
  function exReport() {
    const C = exCats(), vals = CATS.map(([kk]) => C[kk]).filter(v => v != null), overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    const grade = overall >= 90 ? 'A' : overall >= 80 ? 'B' : overall >= 70 ? 'C' : overall >= 60 ? 'D' : 'E';
    const ranked = CATS.filter(([kk]) => C[kk] != null).sort((a, b) => C[b[0]] - C[a[0]]);
    const good = ranked.filter(([kk]) => C[kk] >= 80).slice(0, 3), work = ranked.filter(([kk]) => C[kk] < 72).reverse().slice(0, 3);
    const R = EX.res, all = (f) => R.map(r => r.stats[f]?.med).filter(v => v != null);
    if (EX.done && !EX.awarded) { EX.awarded = true; st.dirty = true; const got = TT.aw.exam(overall, grade); if (got.length) setTimeout(() => toast('Trophy won: ' + got.map(t => t.name).join(', '), 4000), 600); }
    const o = document.createElement('div'); o.id = 'merge-dlg'; o.className = 'tt-tune'; o.style.zIndex = 98;
    o.innerHTML = `<div class="card tt-tcard tt-report"><div class="tt-grade"><b>${grade}</b><div><h2 style="margin:0">Apprentice exam</h2><span class="muted">Overall ${overall} / 100 · ${R.length} of ${exList().length} challenges</span></div></div>
      <div class="tt-cats">${CATS.map(([kk, n]) => C[kk] == null ? '' : `<div><span>${n}</span><i><s style="width:${C[kk]}%;background:${C[kk] >= 80 ? 'var(--teal)' : C[kk] >= 65 ? '#e8b44c' : '#e0605a'}"></s></i><b>${C[kk]}</b></div>`).join('')}</div>
      ${good.length ? `<div class="lbl">You excel at</div><ul class="tt-list">${good.map(([, n]) => `<li><b>${n}</b></li>`).join('')}</ul>` : ''}
      ${work.length ? `<div class="lbl">Needs work</div><ul class="tt-list">${work.map(([, n, tip]) => `<li><b>${n}.</b> ${tip}</li>`).join('')}</ul>` : ''}
      <div class="lbl">How you worked</div>
      <div class="tt-sum"><span>Usual pressure</span><b>${Math.round(pct(all('pressure'), 0.5) * 100)}% of your range</b><span>Usual hand speed</span><b>${Math.round(pct(all('speed'), 0.5))} mm/s</b>
        <span>Pen angle</span><b>${Math.round(pct(all('tilt'), 0.5))}°</b><span>Blowouts</span><b>${R.reduce((x, r) => x + r.blowouts, 0)}</b><span>Most worked skin</span><b>${Math.max(0, ...R.map(r => r.traumaMax)).toFixed(2)}</b>
        <span>Time tattooing</span><b>${Math.round(R.reduce((x, r) => x + (r.stats.seconds || 0), 0) / 60)} min</b></div>
      <div class="lbl" style="margin-top:10px">Challenges</div>
      <div class="tt-chs">${R.map(r => `<div><img src="${r.thumb}" alt=""><span>${esc(r.title)}</span><b>${r.total}</b></div>`).join('')}</div>
      <div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap"><button class="btn" data-rp="copy" data-tip="Temporary: copy every result and setting, to send on for tuning">Copy results</button><button class="btn" data-rp="again">Retake the exam</button><span style="flex:1"></span><button class="btn primary" data-rp="close">Close</button></div></div>`;
    o.onclick = async (e) => { const a = e.target.closest('[data-rp]')?.dataset.rp; if (!a) return;
      if (a === 'close') return o.remove();
      if (a === 'again') { if (!await ask('Retake the whole exam? This report is replaced when you finish again.')) return; o.remove(); EX.i = 0; EX.done = false; EX.res = []; EX.undos = 0; EX.started = Date.now(); exStart(true); return save(true); }
      if (a === 'copy') { const txt = JSON.stringify({ inkforge_exam: 1, when: new Date().toISOString(), overall, grade, categories: C,
          challenges: R.map(({ thumb, ...r }) => r), cal: { ...cal }, feel: JSON.parse(Settings.get('tt_feel', '{}')), device: { ua: navigator.userAgent, screen: [screen.width, screen.height], dpr: devicePixelRatio } });
        try { await navigator.clipboard.writeText(txt); toast('Results copied. Paste them into a message to send on.'); } catch { await askText('Copy these results:', txt); } } };
    document.body.appendChild(o);
  }

  if (!TT_NEEDLES.some(n => n.id === st.needle)) st.needle = '3RL';
  if (meta.tuneOnly) setTimeout(tuneIn, 0);
  else if (!Settings.get('tt_tuned')) setTimeout(() => toast(migrated ? 'The needle defaults were updated (voltages and a hand speed setting). Run Tune in again under the sliders icon to set them to your hand.'
    : 'New here? Under the sliders icon, Tune in sets the needles to your pen and hand in a few short tasks.', 7000), 800);
  setNeedle(st.needle); st.dirty = false; drawTray(); sel(); drawView();
  const ttRO = new ResizeObserver(() => { fit(); drawRefs(); }); ttRO.observe(stage); fit(); drawRefs();
  if (EX) { if (EX.done) { exBar(); exReport(); } else exStart(!EX.cur); st.dirty = false; }
};

/* ---------- Styles (kept here so the simulator stays in one file) ---------- */
function ttStyle() {
  if (document.getElementById('tt-css')) return;
  const s = document.createElement('style'); s.id = 'tt-css';
  s.textContent = `
.tt-hubsum { display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; color: var(--ink2); align-items: center; } .tt-hubsum span { display: inline-flex; gap: 4px; align-items: center; } .tt-hubsum b { color: var(--ink); }
.tt-cabinet { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-bottom: 8px; }
.tt-trophy { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; align-items: center; padding: 8px; border-radius: 12px; background: var(--bg2); border: 1px solid var(--line); opacity: .55; }
.tt-trophy.won { opacity: 1; } .tt-trophy svg { grid-row: span 2; } .tt-trophy b { font-size: 12px; } .tt-trophy span { font-size: 10px; color: var(--ink2); line-height: 1.25; }
.tt-cup, .tt-medal { fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.tt-cup.gold, .tt-medal.gold { stroke: #e2b34a; } .tt-cup.silver, .tt-medal.silver { stroke: #c9d1d6; } .tt-cup.bronze, .tt-medal.bronze { stroke: #c88a55; } .tt-cup.locked { stroke: var(--ink2); }
.tt-chgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-bottom: 8px; }
.tt-chc { display: flex; flex-direction: column; text-align: left; padding: 0; border-radius: 12px; overflow: hidden; background: var(--bg2); border: 1px solid var(--line); color: var(--ink); cursor: pointer; font: inherit; }
.tt-cheat { flex: none; font: 800 10px var(--ui); letter-spacing: .06em; text-transform: uppercase; color: #ff8a7a; border: 1.5px solid #ff6f61; border-radius: 6px; padding: 2px 6px; transform: rotate(-3deg); }
.tt-guides { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
.tt-guides i { position: absolute; width: 22px; height: 22px; margin: -11px; border-radius: 50%; background: rgba(255,111,97,.25); border: 2px solid #ff6f61; pointer-events: auto; touch-action: none; cursor: grab; }
.tt-guides i.anc { width: 22px; height: 22px; margin: -11px; border-radius: 50%; background: #fff; border: 2px solid #ff6f61; } .tt-guides i.anc.corner { border-radius: 3px; background: #ff6f61; }
.tt-guides i.anc.first { box-shadow: 0 0 0 3px rgba(255,111,97,.35); } .tt-pp { display: flex; align-items: center; gap: 4px; font: 600 11px var(--ui); color: var(--ink2); padding: 0 4px; } .tt-pp input { width: 80px; accent-color: var(--teal); }
.tt-anhint { font: 600 11px var(--ui); color: var(--ink2); align-self: center; padding: 0 6px; }
.tt-guides i.lsel { width: 18px; height: 18px; margin: -9px; border-radius: 4px; background: #1a1410; border-color: #ff8a7a; } .tt-guides i.lsel.rot { border-radius: 50%; }
.tt-selb { position: absolute; border: 1.5px dashed #ff8a7a; pointer-events: auto; touch-action: none; cursor: move; background: rgba(255,111,97,.04); }
.tt-selbar { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); display: flex; gap: 4px; padding: 5px; border-radius: 12px; background: rgba(15,18,19,.9); pointer-events: auto; z-index: 2; }
.tt-selbar button { border: 1px solid var(--line); background: rgba(255,255,255,.06); color: var(--ink); font: 700 12px var(--ui); border-radius: 8px; padding: 6px 10px; cursor: pointer; } .tt-selbar button.ok { background: var(--teal); color: #071312; border-color: var(--teal); }
.tt-mkc { display: flex; flex-wrap: wrap; gap: 5px; padding: 4px 6px; max-width: 100%; box-sizing: border-box; } .tt-mkc button { width: 24px; height: 24px; flex: none; border-radius: 50%; border: 2px solid rgba(255,255,255,.2); cursor: pointer; padding: 0; }
.tt-mkc button.on { outline: 2px solid var(--teal); outline-offset: 2px; } .tt-mkcu { position: relative; flex: none; width: 24px; height: 24px; border-radius: 50%; background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red); }
.tt-mkcu input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.tt-letp { max-height: min(70vh, 560px); overflow-y: auto; } .tt-lseg { display: flex; gap: 3px; margin: 4px 6px; } .tt-lseg button { flex: 1; border: 0; border-radius: 7px; background: rgba(255,255,255,.05); color: var(--ink); font: 700 11px var(--ui); padding: 7px 2px; cursor: pointer; }
.tt-lseg button.on { background: rgba(181,138,232,.28); color: #d6bdf7; } .tt-selb.let { border-color: #b58ae8; }
.tt-tools { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 0 6px; }
.tt-tb { display: flex; flex-direction: column; align-items: center; gap: 2px; border: 0; border-radius: 8px; background: rgba(255,255,255,.05); color: var(--ink); padding: 8px 2px 6px; cursor: pointer; font: 600 10px var(--ui); }
.tt-tb svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; } .tt-tb.on { background: rgba(255,111,97,.2); color: #ff8a7a; }
.tt-guides i.vp { background: rgba(255,255,255,.25); border-color: #fff; border-radius: 3px; transform: rotate(45deg); }
.tt-guides i.sym { background: rgba(181,138,232,.3); border-color: #b58ae8; }
.tt-cheatb.on { color: #ff8a7a !important; background: rgba(255,111,97,.18) !important; }
.tt-symm { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; padding: 0 6px; } .tt-symm button { border: 0; border-radius: 8px; background: rgba(255,255,255,.05); color: var(--ink); font: 700 12px var(--ui); padding: 8px 4px; cursor: pointer; }
.tt-symm button.on { background: rgba(181,138,232,.28); color: #d6bdf7; }
.tt-meter.cheat [data-m="skin"] { display: none; } .tt-smlbl { font: 700 11px var(--ui); color: #ff8a7a; padding: 0 4px; }
.tt-cheatpick { display: flex; margin: 4px 0 10px; } .tt-cheatpick b { color: #ff8a7a; }
.tt-pfask { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--teal); background: rgba(31,182,166,.08); font-size: 13px; }
.tt-pfask span { flex: 1; }
.tt-chc:hover { border-color: var(--teal); } .tt-chc.off { opacity: .4; filter: grayscale(1); }
.tt-chskin { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 14px; padding: 10px 12px; border-radius: 12px; background: var(--bg2); border: 1px solid var(--line); }
.tt-chskin .tt-skins button.on { outline: 2px solid var(--teal); outline-offset: 2px; } .tt-chimg { aspect-ratio: 4 / 3; overflow: hidden; background: #1b1e1f; } .tt-chimg img { width: 100%; height: 100%; object-fit: contain; display: block; }
.tt-chmeta { display: flex; flex-direction: column; gap: 2px; padding: 8px; font-size: 12px; } .tt-chmeta b { font-size: 13px; } .tt-chpb { display: inline-flex; gap: 4px; align-items: center; }
.tt-stars { display: inline-flex; gap: 2px; margin-right: 4px; vertical-align: middle; } .tt-stars i { width: 8px; height: 8px; transform: rotate(45deg); background: var(--line); display: inline-block; } .tt-stars i.on { background: #e2b34a; }
.tt-chrep .tt-grade.gold b { color: #e2b34a; } .tt-chrep .tt-grade.silver b { color: #c9d1d6; } .tt-chrep .tt-grade.bronze b { color: #c88a55; } .tt-chrep .tt-grade { align-items: center; }
.tt-pb { margin: 8px 0; padding: 8px 10px; border-radius: 10px; background: rgba(31,181,166,.14); color: var(--teal); font-weight: 700; } .tt-pb span { color: var(--ink2); font-weight: 400; font-size: 12px; margin-left: 6px; }
.tt-chshot { display: block; max-width: 100%; max-height: 220px; margin: 8px auto; border-radius: 10px; }
#main:has(.tt-ed) { padding: 0; overflow: hidden; } #main:has(.tt-ed) #topbar { display: none; } #view:has(.tt-ed) { max-width: none; height: 100%; animation: none; } #tt:has(.tt-ed) { height: 100%; }
.tt-stage { background: #1b1e1f; touch-action: none; } .tt-stage canvas#tt-cv { position: absolute; inset: 0; touch-action: none; cursor: none; }
#tt-cur { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
.tt-angb { flex-direction: column; height: 44px !important; gap: 0; } .tt-angb b { font: 700 9px var(--ui); color: var(--teal); } .tt-angb svg { width: 18px; height: 18px; }
.tt-angs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; padding: 0 4px; }
.tt-angs button { display: flex; flex-direction: column; align-items: center; gap: 2px; border: 0; border-radius: 8px; background: rgba(255,255,255,.05); color: var(--ink); font: 600 11px var(--ui); padding: 6px 2px; cursor: pointer; }
.tt-angs button.on { background: rgba(31,182,166,.25); color: var(--teal); } .tt-angs svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-linecap: round; }
.tt-needle b { font: 700 10px var(--ui); letter-spacing: -.02em; color: var(--teal); }
.dz-pop .mi.on { background: rgba(31,182,166,.15); } .tt-nb { display: inline-block; min-width: 40px; font: 700 12px var(--ui); color: var(--teal); }
.tt-tray { position: absolute; left: 66px; top: 50%; transform: translateY(-50%); z-index: 6; display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 8px 6px; max-height: calc(100% - 20px); overflow-y: auto;
  border-radius: 18px; background: rgba(22,27,28,.92); border: 1px solid var(--line); backdrop-filter: blur(10px); box-shadow: 0 8px 24px rgba(0,0,0,.45); touch-action: none; user-select: none; -webkit-user-select: none; }
.tt-cap { width: 38px; height: 38px; flex: none; border-radius: 50%; border: 2px solid #c8c8c8; background: #e9e9e9; padding: 0; cursor: pointer; position: relative; box-shadow: inset 0 -3px 0 rgba(0,0,0,.15); }
.tt-cap i { position: absolute; inset: 5px; border-radius: 50%; background: var(--c); box-shadow: inset 0 2px 4px rgba(0,0,0,.35); }
.tt-cap.dip { transform: scale(.92); outline: 3px solid var(--teal); outline-offset: 2px; }
.tt-cup { width: 34px; height: 38px; flex: none; border-radius: 6px 6px 12px 12px; border: 2px solid #9fb3b8; background: linear-gradient(transparent 35%, rgba(150,200,220,.45) 35%); cursor: pointer; padding: 0; }
.tt-recent { display: flex; gap: 3px; align-items: center; } .tt-cap.tt-rcap, .tt-rnone { width: 24px; height: 24px; border-width: 1.5px; } .tt-cap.tt-rcap i { inset: 3px; opacity: var(--o, 1); } .tt-rnone { flex: none; border-radius: 50%; border: 1.5px dashed rgba(255,255,255,.18); box-sizing: border-box; }
.tt-strk { margin-left: 10px; } .tt-strk.over { color: #ff8a7a; font-weight: 700; }
.tt-whip { margin: 6px 0 10px; } .tt-whip svg { width: 100%; max-width: 460px; height: auto; display: block; } .tt-whip p { margin: 4px 0 0; font-size: 12px; }
.tt-cup.tt-dil { border-color: #b9c4c7; background: linear-gradient(transparent 35%, rgba(235,240,242,.3) 35%); }
.tt-cup.tt-dil.dip { transform: scale(.92); outline: 3px solid var(--teal); outline-offset: 2px; }
.tt-load { width: 46px; height: 46px; flex: none; border-radius: 50%; border: 0; padding: 0; position: relative; cursor: default; display: grid; place-items: center;
  background: conic-gradient(var(--teal) var(--v, 0%), rgba(255,255,255,.12) 0); }
.tt-load i { position: absolute; inset: 5px; border-radius: 50%; border: 2px solid #222; } .tt-load span { position: relative; font: 700 9px var(--ui); color: #fff; text-shadow: 0 1px 2px #000; }
.tt-capedit { flex: none; }
.tt-set { flex: none; border: 1px solid var(--line); background: rgba(255,255,255,.06); color: var(--teal); font: 700 10px var(--ui); border-radius: 8px; padding: 5px 4px; width: 46px; cursor: pointer; }
.tt-wcap { background: #fff; }
.tt-szq { display: flex; flex-direction: column; gap: 2px; padding: 2px 0; } .tt-szq button { border: 0; border-radius: 6px; background: rgba(255,255,255,.05); color: var(--ink2); font: 700 10px var(--ui); padding: 4px 0; width: 38px; cursor: pointer; }
.tt-szq button.on { background: rgba(31,182,166,.25); color: var(--teal); }
#tt-rail { max-height: calc(100% - 20px); overflow-y: auto; scrollbar-width: none; } .dz-ed #tt-rail { max-height: calc(100% - 20px); }
.tt-volt { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 4px 0 2px; } .tt-volt b { font: 700 10px var(--ui); color: var(--teal); }
.tt-volt input { writing-mode: vertical-lr; direction: rtl; width: 22px; height: clamp(56px, 14vh, 110px); margin: 0; accent-color: var(--teal); touch-action: none; } .tt-tray { scrollbar-width: none; } .tt-tray::-webkit-scrollbar { display: none; } body:has(#tt-stage) #toast { top: calc(var(--safe-t, 0px) + 64px); bottom: auto; }
@media (max-height: 700px) { .tt-tray { top: 10px; transform: none; } } .tt-zoom { left: auto !important; right: 10px !important; bottom: 76px !important; }
.tt-layers { display: grid; gap: 4px; }
.tt-refs { position: absolute; inset: 0; pointer-events: none; z-index: 4; overflow: hidden; }
.tt-ref { position: absolute; pointer-events: auto; touch-action: none; cursor: move; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
.tt-ref.lock { pointer-events: none; } .tt-ref img { width: 100%; height: 100%; display: block; user-select: none; -webkit-user-drag: none; }
.tt-ref.sel { outline: 1.5px dashed #b58ae8; outline-offset: 2px; }
.tt-ref i { position: absolute; width: 14px; height: 14px; margin: -7px; background: #1a1410; border: 1.5px solid #b58ae8; border-radius: 3px; }
.tt-ref i[data-rh=nw] { left: 0; top: 0; cursor: nwse-resize; } .tt-ref i[data-rh=ne] { right: 0; top: 0; cursor: nesw-resize; }
.tt-ref i[data-rh=sw] { left: 0; bottom: 0; cursor: nesw-resize; } .tt-ref i[data-rh=se] { right: 0; bottom: 0; cursor: nwse-resize; }
.tt-ref i[data-rh=rot] { left: 50%; top: -26px; border-radius: 50%; cursor: grab; }
.tt-rr { grid-template-columns: 44px 1fr auto auto auto; grid-template-areas: "a n b c d" "r r r r r"; } .tt-rr img { width: 40px; height: 40px; object-fit: cover; border-radius: 6px; grid-area: a; }
.tt-addr { display: flex; flex-wrap: wrap; gap: 4px; }
.tt-exam { position: absolute; right: 10px; top: 10px; z-index: 6; width: min(290px, calc(100% - 150px)); padding: 6px 10px; border-radius: 12px;
  background: rgba(22,27,28,.95); border: 1px solid var(--line); backdrop-filter: blur(10px); box-shadow: 0 8px 24px rgba(0,0,0,.45); }
.tt-expen { display: flex; justify-content: space-between; font-size: 11px; color: var(--ink2); margin: 2px 0 6px; } .tt-expen b { color: #ff8a7a; }
.tt-flag { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); z-index: 8; pointer-events: none; padding: 10px 18px; border-radius: 12px; font: 700 15px var(--ui);
  background: rgba(20,30,30,.92); color: #9ff0e4; border: 1.5px solid var(--teal); box-shadow: 0 8px 24px rgba(0,0,0,.4); animation: ttFlag 2.6s ease forwards; }
.tt-flag.bad { color: #ffd2cb; border-color: #e0604c; background: rgba(60,20,16,.94); }
@keyframes ttFlag { 0% { opacity: 0; transform: translate(-50%, 8px); } 8%, 80% { opacity: 1; transform: translate(-50%, 0); } 100% { opacity: 0; } }
.tt-meter { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 5; width: min(300px, calc(100% - 220px)); min-width: 180px; padding: 6px 10px; border-radius: 12px;
  background: rgba(15,18,19,.82); display: grid; gap: 3px; }
.tt-tally { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 3px; font: 600 10px var(--ui); color: var(--ink2); } .tt-tally b { color: var(--ink); } .tt-tally .warn b { color: #f2c14e; } .tt-tally .bad, .tt-tally .bad b { color: #ff7a66; }
.tt-peek { width: 26px; height: 24px; padding: 0; display: grid; place-items: center; touch-action: none; } .tt-peek svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; } .tt-peek.on { color: var(--teal); border-color: var(--teal); }
.tt-chkrow { display: flex; align-items: center; gap: 8px; margin-top: 3px; } .tt-chkrow em { font: 600 10px var(--ui); color: var(--ink2); font-style: normal; min-width: 36px; }
.tt-chkrow button { border: 1px solid var(--line); background: rgba(255,255,255,.06); color: var(--ink); font: 700 11px var(--ui); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
.tt-chkrow button.on { background: rgba(31,182,166,.25); color: var(--teal); border-color: var(--teal); } .tt-chkrow input { flex: 1; accent-color: var(--teal); }
.tt-mr { display: grid; grid-template-columns: 38px 1fr 66px; align-items: center; gap: 6px; font: 600 10px var(--ui); color: var(--ink2); }
.tt-mr em { font-style: normal; text-align: right; } .tt-mr.ok em { color: #6fe39a; } .tt-mr.warn em { color: #f2c14e; } .tt-mr.bad em { color: #ff7a66; }
.tt-mb { position: relative; height: 8px; border-radius: 4px; background: rgba(255,255,255,.1); overflow: hidden; }
.tt-mb i { position: absolute; top: 0; bottom: 0; } .tt-mb i.ok { background: rgba(80,200,120,.55); } .tt-mb i.bad { background: rgba(224,96,76,.45); }
.tt-mb b { position: absolute; top: -1px; bottom: -1px; width: 3px; margin-left: -1.5px; background: #fff; border-radius: 2px; box-shadow: 0 0 3px #000; transition: left .08s linear; }
.tt-exam[hidden] { display: none; } .tt-exh { display: flex; align-items: center; gap: 8px; } .tt-exh b { font-size: 13px; flex: 1; }
.tt-exdots { display: flex; gap: 3px; } .tt-exdots i { width: 8px; height: 8px; border-radius: 50%; background: var(--line); } .tt-exdots i.on { background: var(--teal); } .tt-exdots i.done { background: rgba(31,182,166,.45); }
.tt-exam .tt-exdots { display: none; } .tt-exam .btn.small { padding: 5px 10px; font-size: 12px; } .tt-exres b { font-size: 20px !important; }
.tt-ext { font-size: 11.5px; line-height: 1.35; margin: 3px 0 6px; color: var(--ink2); } .tt-exres { display: flex; align-items: center; gap: 10px; margin: 6px 0 8px; }
.tt-exres b { font: 700 26px var(--ui); color: var(--teal); } .tt-exres span { font-size: 11.5px; color: var(--ink2); }
.tt-grade { display: flex; gap: 14px; align-items: center; margin-bottom: 12px; } .tt-grade > b { font: 800 40px var(--ui); color: var(--teal); width: 64px; height: 64px; display: grid; place-items: center; border: 2px solid var(--teal); border-radius: 16px; }
.tt-cats { display: grid; gap: 6px; margin-bottom: 10px; } .tt-cats div { display: grid; grid-template-columns: 90px 1fr 34px; gap: 8px; align-items: center; font-size: 13px; }
.tt-cats i { height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; } .tt-cats s { display: block; height: 100%; } .tt-cats b { text-align: right; }
.tt-list { margin: 2px 0 10px; padding-left: 18px; font-size: 13px; } .tt-list li { margin: 3px 0; }
.tt-chs { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; } .tt-chs div { display: grid; gap: 2px; font-size: 11px; }
.tt-chs img { width: 100%; border-radius: 8px; } .tt-chs b { color: var(--teal); }
.tt-report { max-height: calc(100vh - 40px); overflow-y: auto; }
.tt-tune .card { max-width: 1000px; width: calc(100vw - 24px); } .tt-tpad { width: 100%; height: auto; border-radius: 12px; touch-action: none; display: block; cursor: crosshair; }
.tt-tmsg { min-height: 2.6em; font-size: 13px; color: var(--teal); margin: 8px 0; }
.tt-tsteps { display: flex; gap: 4px; margin-bottom: 8px; } .tt-tsteps i { flex: 1; height: 4px; border-radius: 2px; background: var(--line); } .tt-tsteps i.on { background: var(--teal); } .tt-tsteps i.done { background: rgba(31,182,166,.45); }
.tt-prof { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; } .tt-prof button { flex: 1 1 auto; border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 10px; padding: 7px 8px; font: 600 12px var(--ui); cursor: pointer; }
.tt-prof button.on { border-color: var(--teal); background: rgba(31,182,166,.15); color: var(--teal); } .tt-prof.big button { padding: 12px 10px; font-size: 14px; }
#tt-zoom { position: fixed; inset: 0; z-index: 120; background: #0b0d0e; overflow: hidden; display: flex; align-items: center; justify-content: center; touch-action: none; } #tt-zoom img { max-width: 100%; max-height: 100%; touch-action: none; user-select: none; cursor: grab; }
.tt-zbar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 6px; align-items: center; padding: 10px 12px; background: rgba(15,18,19,.85); }
.tt-lsimg { cursor: zoom-in; max-height: 300px; } .tt-lscats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; } @media (max-width: 520px) { .tt-lscats { grid-template-columns: 1fr; } }
.tt-lschips { display: flex; gap: 6px; margin-top: 10px; } .tt-lschips div { flex: 1; text-align: center; padding: 6px 2px; border: 1px solid var(--line); border-radius: 8px; } .tt-lschips b { display: block; font-size: 15px; } .tt-lschips span { font-size: 11px; color: var(--ink2, #9aa5a6); }
.tt-lsgrad { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 6px 0 2px; } .tt-lsgrad i { flex: 1; height: 9px; border-radius: 5px; background: linear-gradient(90deg, #eb3c3c 0%, #f0c83c 35%, #3cdc78 55%, #3cdc78 75%, #ff9628 100%); }
.tt-lsimg { cursor: zoom-in; } .tt-lsheatinfo[hidden] { display: none; } .tt-lsleg { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 12px; margin: 6px 0; } .tt-lsleg i { width: 11px; height: 11px; border-radius: 3px; margin-left: 6px; } .tt-lsnotes { margin: 6px 0; padding-left: 18px; font-size: 13px; line-height: 1.45; }
.tt-lsmotion { display: block; width: 100%; max-width: 480px; margin: 10px 0; } .tt-lsmotion .tt-lsmpath { fill: none; stroke: var(--teal); stroke-width: .9; } .tt-lsmotion .tt-lsmarrow { fill: none; stroke: var(--ink2, #999); stroke-width: 1.2; }
.tt-zwrap { position: relative; display: block; } .tt-zwrap input { display: block; width: 100%; } .tt-zone { position: absolute; bottom: -2px; height: 3px; border-radius: 2px; background: #3cdc78; pointer-events: none; } .dz-sl:has(> .tt-zone) { position: relative; } .dz-sl > .tt-zone { bottom: 0; }
.tt-zwrapv { position: relative; display: block; } .tt-zonev { position: absolute; right: -3px; bottom: 0; width: 3px; border-radius: 2px; background: #3cdc78; pointer-events: none; }
.tt-unsaved { font-size: 12px; color: #e8b44c; font-weight: 600; } .tt-unsaved[hidden] { display: none; }
.tt-chr { font-style: normal; font-size: 11px; margin-left: 6px; padding: 1px 6px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink2, #9aa5a6); cursor: pointer; }
.tt-ftabs { display: flex; gap: 2px; margin: 2px 0 10px; padding: 3px; border-radius: 10px; background: rgba(127,127,127,.12); overflow-x: auto; scrollbar-width: none; } .tt-ftabs button { flex: 1 0 auto; padding: 7px 8px; border: 0; border-radius: 8px; background: none; color: var(--ink2, #9aa5a6); font: 600 12px var(--ui); cursor: pointer; white-space: nowrap; } .tt-ftabs button.on { background: var(--teal); color: #06201d; }
.tt-fintro { margin: 0 0 10px; font-size: 12px; line-height: 1.4; color: var(--ink2, #9aa5a6); } .tt-fpage .lbl { margin-top: 10px; } .tt-fpage .lbl:first-of-type { margin-top: 0; } .tt-fpage > .btn { margin-top: 10px; }
.tt-ffoot { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.tt-cmp { max-width: 820px; margin: auto; } .tt-cmppage { min-height: 200px; } .tt-cmpslot select { margin-top: 2px; } .tt-cmpslots { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; } @media (max-width: 620px) { .tt-cmpslots, .tt-cmpadv { grid-template-columns: 1fr !important; } }
.tt-cmpslot { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; } .tt-cmpsrc { display: flex; flex-wrap: wrap; gap: 6px; }
.tt-cmpslot.a { border-top: 3px solid var(--teal); } .tt-cmpslot.b { border-top: 3px solid #e8b44c; } .tt-cmpwho { display: flex; gap: 6px; align-items: center; } .tt-cmpwho > i { width: 12px; height: 12px; border-radius: 3px; flex: none; } .tt-cmpwho input { flex: 1; min-width: 0; }
.tt-cmpimg { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 8px; cursor: zoom-in; background: #1b1e1f; display: block; } .tt-cmpnone { display: grid; place-items: center; font-size: 12px; color: var(--ink2); cursor: default; }
.tt-cmpgrade { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-size: 13px; } .tt-cmpgrade b { font: 24px var(--display); }
.tt-cmpopts { display: flex; flex-direction: column; gap: 6px; } .tt-cmpopt { display: flex; gap: 10px; align-items: center; text-align: left; padding: 6px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg2); color: var(--ink); cursor: pointer; font: inherit; } .tt-cmpopt:hover { border-color: var(--teal); }
.tt-cmpopt img, .tt-cmpnoimg { width: 96px; height: 72px; object-fit: cover; border-radius: 6px; flex: none; } .tt-cmpnoimg { display: grid; place-items: center; background: rgba(127,127,127,.12); font: 22px var(--display); } .tt-cmpopt > span { display: flex; flex-direction: column; gap: 2px; font-size: 13px; min-width: 0; }
.tt-cmpwarn { color: #e8b44c; font-size: 13px; } .tt-cmpadv { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 12px 0; } .tt-cmpadv ul { margin: 4px 0; padding-left: 18px; font-size: 13px; line-height: 1.45; }
.tt-cmptab { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; } .tt-cmptab th, .tt-cmptab td { padding: 5px 8px; text-align: right; border-bottom: 1px solid var(--line); } .tt-cmptab th:first-child, .tt-cmptab td:first-child { text-align: left; } .tt-cmptab td:last-child { font-size: 11px; }
.tt-cmptab tr.sec td { text-align: left; font-weight: 700; color: var(--teal); padding-top: 12px; } .tt-cmptab td.win { color: var(--teal); font-weight: 700; }
.tt-cmpchart { margin-top: 14px; } .tt-cmpbars { display: flex; gap: 4px; align-items: flex-end; height: 110px; } .tt-cmpbars > div { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; } .tt-cmpbars span { flex: 1; width: 100%; display: flex; gap: 2px; align-items: flex-end; } .tt-cmpbars i { flex: 1; display: block; border-radius: 3px 3px 0 0; min-height: 1px; } .tt-cmpbars em { font-style: normal; font-size: 10px; color: var(--ink2, #9aa5a6); margin-top: 3px; white-space: nowrap; }
.ca { background: var(--teal); } .cb { background: #e8b44c; } .tt-cmpkey { display: flex; gap: 6px; align-items: center; font-size: 12px; margin-top: 8px; } .tt-cmpkey i { width: 11px; height: 11px; border-radius: 3px; margin-left: 6px; }
.tt-trybar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0 0 12px; padding: 8px 10px; border: 1px solid #e8b44c; border-radius: 10px; font-size: 13px; } .tt-trybar span { flex: 1; min-width: 160px; }
#tt-busy { position: fixed; inset: 0; z-index: 130; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); } #tt-busy .card { width: min(320px, 86vw); text-align: center; } #tt-busy b { display: block; margin-bottom: 10px; font-size: 14px; } #tt-busy i { display: block; height: 8px; border-radius: 4px; background: rgba(127,127,127,.25); overflow: hidden; } #tt-busy s { display: block; height: 100%; background: var(--teal); transition: width .3s; }
.tt-lscard { max-width: 620px; margin: 0 auto; } .tt-lscard p { line-height: 1.5; }
.tt-lspics { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0; } .tt-lspics figure { margin: 0; flex: 1; min-width: 70px; max-width: 120px; text-align: center; font-size: 13px; font-weight: 600; } .tt-lspics svg { display: block; width: 100%; height: auto; aspect-ratio: 1; }
.tt-lspics .tt-lsbg { fill: var(--bg2, rgba(127,127,127,.1)); stroke: var(--line); stroke-width: 1px; vector-effect: non-scaling-stroke; } .tt-lspics .tt-lsdot { fill: var(--teal); stroke: none; }
.tt-lstable { grid-template-columns: auto 1fr; margin: 10px 0; font-size: 13px; }
.tt-lsswatch { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; } .tt-lsswatch i { width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--line); }
.tt-lslist { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.tt-lsrow { display: flex; align-items: center; gap: 12px; padding: 10px 12px; text-align: left; background: var(--card, transparent); color: inherit; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; font: inherit; } .tt-lsrow.off { opacity: .55; cursor: default; }
.tt-lsno { flex: none; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; background: rgba(31,182,166,.15); color: var(--teal); font-weight: 700; } .tt-lsmeta { flex: 1; display: flex; flex-direction: column; font-size: 13px; } .tt-lsst { font-size: 12px; }
.tt-sum3 { grid-template-columns: 1fr auto auto; } .tt-tpad[hidden] { display: none; }
.tt-sum { display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; font-size: 14px; } .tt-sum b { color: var(--teal); }
.tt-ndg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; padding: 0 4px 4px; }
.tt-ndg button { border: 0; border-radius: 8px; background: rgba(255,255,255,.05); color: var(--ink); font: 700 12px var(--ui); padding: 8px 2px; cursor: pointer; }
.tt-ndg button:hover { background: rgba(255,255,255,.1); } .tt-ndg button.on { background: rgba(31,182,166,.25); color: var(--teal); }
.tt-viewb { width: auto !important; padding: 0 6px; gap: 4px; display: inline-flex !important; align-items: center; } .tt-viewb b { font: 700 10px var(--ui); }
.tt-lr { display: grid; grid-template-columns: 1fr auto auto auto; grid-template-areas: "n a b c" "r r r r"; align-items: center; gap: 2px 4px; padding: 6px 8px; border-radius: 10px; border: 1px solid var(--line); cursor: pointer; }
.tt-lr .nm { grid-area: n; font-size: 13px; } .tt-lr input { grid-area: r; width: 100%; accent-color: var(--teal); } .tt-lr.on { border-color: var(--teal); background: rgba(31,182,166,.1); }
.tt-lr .dz-ib { width: 30px; height: 30px; }
.tt-pad { width: 100%; height: auto; border-radius: 10px; touch-action: none; display: block; cursor: crosshair; }
.tt-live { font: 600 11px var(--ui); color: var(--ink2); margin-top: 6px; }
.tt-crow { display: flex; gap: 10px; align-items: center; } .tt-curve { width: 64px; height: 64px; flex: none; background: rgba(0,0,0,.25); border-radius: 8px; }
.tt-curve path { fill: none; stroke: var(--teal); stroke-width: 3; }
.tt-skins { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; } .tt-skins button { width: 34px; height: 34px; border-radius: 50%; border: 2px solid rgba(255,255,255,.2); cursor: pointer; }
.tt-skins button.on { outline: 2px solid var(--teal); outline-offset: 2px; }
.tt-skinpick { width: 34px; height: 34px; border-radius: 50%; overflow: hidden; position: relative; background: conic-gradient(#f1d3bd, #4e2f1e, #f1d3bd); }
.tt-skinpick input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
@media (max-width: 700px) { .tt-zoom { top: 10px !important; bottom: auto !important; } }`;
  document.head.appendChild(s);
}
