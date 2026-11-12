'use strict';
/* InkForge design studio: gift vouchers, business cards, flyers and social posts.
   One renderer (a canvas) draws the editor, thumbnails, exports and print sheets, so what you see is
   what prints. A design is JSON: page size, theme, background and a list of layers (text, image,
   shape), each with position, size, rotation and opacity in page pixels (300 dpi for print sizes).
   Colours and fonts can point at the theme ('@fg', '@1'), so switching theme restyles the whole
   design while anything the artist coloured by hand keeps its own colour. Text can hold {fields}
   that fill in from Settings (studio, phone...) and from the design's own details (voucher amount,
   code...). Pictures are media files (content-hash names) listed in design_assets for backups. */
const DESIGN_VERSION = 1;   // app.js checks this matches, to catch a stale cached copy

const DZ_KINDS = {
  note: { label: 'Sticky note', sub: 'Pin it on your menu screens', w: 900, h: 900, per: 0, note: 1 },
  form: { label: 'Form', sub: 'Consent, aftercare, any form', w: 2480, h: 3508, per: 0, form: 1 },
  page: { label: 'Blank page', sub: 'A2 to A6, Letter, custom…', w: 2480, h: 3508, per: 0, page: 1 },
  pattern: { label: 'Pattern tile', sub: 'A seamless repeat, for fills', w: 709, h: 709, per: 0, pattern: 1 },
  challenge: { label: 'Challenge', sub: 'For the simulator: 18 × 13 cm of skin', w: 1800, h: 1300, per: 0, chal: 1 },
  fold: { label: 'Folded pamphlet', sub: 'Trifold, bifold, Z-fold…', w: 3508, h: 2480, per: 0, fold: 1 },
  voucher: { label: 'Gift voucher', sub: 'DL, 210 × 99 mm', w: 2480, h: 1169, per: 2 },
  card: { label: 'Business card', sub: '85 × 55 mm', w: 1004, h: 650, per: 10 },
  flyer: { label: 'Flyer / pamphlet', sub: 'A5, 148 × 210 mm', w: 1748, h: 2480, per: 2 },
  post: { label: 'Square post', sub: '1080 × 1080, feed', w: 1080, h: 1080, per: 0, social: 1 },
  portrait: { label: 'Portrait post', sub: '1080 × 1350, feed (4:5)', w: 1080, h: 1350, per: 0, social: 1 },
  story: { label: 'Story / reel cover', sub: '1080 × 1920 (9:16)', w: 1080, h: 1920, per: 0, social: 1 }
};
// An icon for each kind in the New design window.
/* The design studio's clipboard: copies of layers, kept while the app is open so they paste into any design. */
let DZ_CLIP = null;
/* Drag to reorder: items marked data-<attr>="index" inside root. A tap still taps; past a small move it is a drag, and
   move(from, to) runs each time it passes over another item (start() once, done() at the end). */
function dzDragOrder(root, attr, move, done, start) { let d = null;
  root.addEventListener('pointerdown', (e) => { const b = e.target.closest(`[data-${attr}]`); if (!b || b.dataset[attr] === '') return; d = { i: +b.dataset[attr], x: e.clientX, y: e.clientY, moved: false, id: e.pointerId }; });
  addEventListener('pointermove', (e) => { if (!d || e.pointerId !== d.id) return; if (!d.moved) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return; d.moved = true; start?.(); }
    e.preventDefault(); const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(`[data-${attr}]`); if (!over || !root.contains(over) || over.dataset[attr] === '') return; const j = +over.dataset[attr]; if (j !== d.i) { move(d.i, j); d.i = j; } });
  addEventListener('pointerup', (e) => { if (!d || e.pointerId !== d.id) return; const m = d.moved; d = null; if (m) { root.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true }); done?.(); } }); }
const DZ_KIND_IC = { note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>', form: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>', page: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/>',
  pattern: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1" stroke-dasharray="2 1.5"/><rect x="3" y="13" width="8" height="8" rx="1" stroke-dasharray="2 1.5"/>',
  challenge: '<path d="M6 3h12v5a6 6 0 0 1-12 0z"/><path d="M12 14v4M8 21h8"/>', fold: '<path d="M3 5l6 2 6-2 6 2v12l-6-2-6 2-6-2z"/><path d="M9 7v12M15 5v12"/>', voucher: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M8 7v10" stroke-dasharray="2 2"/><path d="M13 12h5"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h6M7 14h4"/>', flyer: '<rect x="6" y="2" width="12" height="20" rx="1"/><path d="M9 7h6M9 11h6M9 15h4"/>', post: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="12" r="3.5"/>',
  portrait: '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="11" r="3.5"/>', story: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 5h4"/>' };
const DZ_THEMES = {
  ink: { name: 'Ink', bg: '#0f1213', fg: '#f1ece2', accent: '#1fb6a6', soft: '#8c9593', f1: 'Pirata One', f2: 'Inter' },
  gold: { name: 'Black & gold', bg: '#0d0d0d', fg: '#f5ecd7', accent: '#c9a24a', soft: '#9b9180', f1: 'Cinzel', f2: 'Montserrat' },
  paper: { name: 'Paper', bg: '#f8f4ec', fg: '#1a1a1a', accent: '#a8322b', soft: '#6b6660', f1: 'Playfair Display', f2: 'Inter' },
  bold: { name: 'Bold', bg: '#c62828', fg: '#ffffff', accent: '#111111', soft: '#ffd7d2', f1: 'Bebas Neue', f2: 'Oswald' },
  clean: { name: 'Clean', bg: '#ffffff', fg: '#111111', accent: '#14857c', soft: '#777777', f1: 'Montserrat', f2: 'Montserrat' }
};
// [family, Google Fonts spec or '' when already available]
const DZ_FONTS = [['Inter', ''], ['Pirata One', ''], ['Bebas Neue', 'Bebas Neue'], ['Oswald', 'Oswald:wght@400;700'], ['Montserrat', 'Montserrat:wght@400;700'],
  ['Playfair Display', 'Playfair Display:ital,wght@0,400;0,700;1,400'], ['Cinzel', 'Cinzel:wght@400;700'], ['Great Vibes', 'Great Vibes'],
  ['UnifrakturMaguntia', 'UnifrakturMaguntia'], ['Permanent Marker', 'Permanent Marker'], ['Courier Prime', 'Courier Prime:wght@400;700'],
  ['Georgia', ''], ['Arial', '']];
// {field}: label, where it comes from.
const DZ_FIELDS = [['studio', 'Studio'], ['artist', 'Artist'], ['phone', 'Phone'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['tiktok', 'TikTok'],
  ['amount', 'Amount'], ['to', 'For'], ['from', 'From'], ['code', 'Code'], ['expires', 'Valid until'],
  ['title', 'Title'], ['placement', 'Placement'], ['tags', 'Hashtags'], ['date', 'Date']];
const DZ_PIECE_FIELDS = /\{(title|placement|tags|date)\}/;
const DZ_PALETTE = ['#000000', '#ffffff', '#1fb6a6', '#c9a24a', '#a8322b', '#e0605a', '#3b5bdb', '#7b4fa0', '#2e7d32', '#f0b860', '#8c9593'];

/* ---------- Sizes ----------
   Print designs are laid out at 300 dots per inch, so page pixels convert to real sizes. Posts stay in
   pixels. The unit picked in the editor is remembered (one for print, one for posts). */
const DZ_UNITS = { mm: [300 / 25.4, 1], cm: [300 / 2.54, 2], in: [300, 2], px: [1, 0] };   // page px per unit (at 300 dpi), decimals shown
const dzUnit = (doc) => DZ_KINDS[doc.kind]?.social ? Settings.get('dz_unit_post', 'px') : Settings.get('dz_unit', 'mm');
// Large pages are laid out at a lower dpi (doc.dpi) so the drawing stays within what phones can handle.
const dzPer = (doc) => { const u = dzUnit(doc), [k] = DZ_UNITS[u]; return u === 'px' ? 1 : k * (doc.dpi || 300) / 300; };
const dzToU = (doc, px) => +(px / dzPer(doc)).toFixed(DZ_UNITS[dzUnit(doc)][1]);
const dzFromU = (doc, v) => v * dzPer(doc);
/* Blank pages: paper sizes in mm (portrait). The dpi is the highest of 300/250/200/150 that keeps the page
   under about 16 million pixels (the canvas limit on iPhones and iPads). */
const DZ_PAPER = [['A6', 105, 148], ['A5', 148, 210], ['A4', 210, 297], ['A3', 297, 420], ['A2', 420, 594],
  ['Letter', 215.9, 279.4], ['Legal', 215.9, 355.6], ['Tabloid', 279.4, 431.8], ['DL', 99, 210], ['4 × 6 in', 101.6, 152.4], ['5 × 7 in', 127, 177.8], ['Square', 210, 210]];
function dzPaper(wmm, hmm, label) {
  const dpi = [300, 250, 200, 150, 100].find(d => (wmm * d / 25.4) * (hmm * d / 25.4) <= 16e6) || 72;
  return { w: Math.round(wmm * dpi / 25.4), h: Math.round(hmm * dpi / 25.4), dpi, label, mm: [wmm, hmm] };
}
const dzMM = (v) => (Math.round(v * 10) / 10).toString();
/* Pattern tiles (design studio and the simulator's cheat mode), after FORMAthing's pattern maker: one cell, drawn with
   its neighbours shown faintly round it, and anything crossing an edge carries on from the opposite one, so the tile
   always repeats without a seam. A kept tile goes to Portfolio > References, in Patterns, where any texture fill and
   the picture pickers find it; it can also be saved to the device. */
const PAT_RATIOS = [['1:1', 1, 1], ['3:2', 3, 2], ['2:3', 2, 3], ['4:3', 4, 3], ['16:9', 16, 9]];
const PAT_SIZES = [20, 40, 60, 100, 150];
/* Challenge maker. A challenge is drawn on the simulator's 18 x 13 cm patch of skin, 10 px to the mm. Each vector
   shape can be given a role for grading: outline (the outside line the artist follows), detail lines (lines inside
   it, each with its own needle) or packing (solid colour, kept inside the outline). Lines show at the width their
   needle makes in the simulator and always sit on top. Colours are picked or mixed from the challenge's palette,
   which can be the only one allowed while it is played. Play builds the challenge for the simulator (dzChSpec). */
const CH_PX = 10;
const CH_NW = { '1RL': 0.25, '3RL': 0.57, '5RL': 0.7, '7RL': 0.77, '9RL': 0.91, '11RL': 0.91, '14RL': 1.06, '5RS': 1.12, '7RS': 1.26, '9RS': 1.54, '11RS': 1.54, '14RS': 1.82,
  '7M1': 1.4, '9M1': 1.75, '11M1': 2.1, '13M1': 2.45, '15M1': 2.4, '9CM': 1.75, '13CM': 2.45, '15CM': 2.8, '23CM': 4.2, '31CM': 5.6 };   /* mm, from the simulator's needle layouts */
const CH_LINERS = ['1RL', '3RL', '5RL', '7RL', '9RL', '11RL', '14RL'];
const CH_PACKERS = ['5RS', '7RS', '9RS', '11RS', '14RS', '7M1', '9M1', '11M1', '13M1', '15M1', '9CM', '13CM', '15CM', '23CM', '31CM'];
/* Packing and shading can allow several needles (l.nds), any of which the artist may use and mix, like lining with a
   7RL then packing with a 7M1, 13M1 or 23CM; l.nd is the first. Lines keep one needle. */
const dzChOr = (a) => a.length > 1 ? 'the ' + a.slice(0, -1).join(', ') + ' or ' + a.at(-1) + ' (mix and match them as you like)' : 'the ' + (a[0] || '');
const dzChNds = (l) => l.nds?.length ? l.nds : l.nd ? [l.nd] : [];
// Grey wash as a challenge palette: its four washes as the greys they read as on skin (the simulator plays it in wash).
const CH_WASH = () => ({ id: 'wash', name: 'Grey wash', caps: TT_WASH.map(([, k]) => { const v = Math.round(255 * (1 - k * 0.92)).toString(16).padStart(2, '0'); return { c: '#' + v + v + v, s: 1 }; }) });
const CH_ROLES = [['', 'Not graded'], ['outline', 'Outline'], ['detail', 'Detail lines'], ['pack', 'Packing'], ['shade', 'Shading']];
/* Shading zones. p is where a point sits along the zone's gradient, 0 at the dark end and 1 at the light end, in the
   zone's box b ([x, y, w, h], any units as long as x and y match): even (all the darkest), straight (along a turn,
   90 = dark at the top) or radial (dark at a centre, given as fractions of the box). Reverse swaps the ends. The
   wanted darkness runs from Darkest to Lightest; Balance bends it (below 1: more of it dark, above: more light). */
function dzChP(sh, x, y, b) { let p; const C = [[0, 0], [1, 0], [0, 1], [1, 1]];
  if (sh.grad === 'flat') p = 0;
  else if (sh.grad === 'radial') { const cx = b[0] + (sh.cx ?? 0.5) * b[2], cy = b[1] + (sh.cy ?? 0.5) * b[3], R = Math.max(...C.map(([i, j]) => Math.hypot(b[0] + i * b[2] - cx, b[1] + j * b[3] - cy))) || 1; p = Math.hypot(x - cx, y - cy) / R; }
  else { const a = (sh.ang ?? 90) * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), pr = C.map(([i, j]) => (b[0] + i * b[2]) * dx + (b[1] + j * b[3]) * dy), lo = Math.min(...pr), hi = Math.max(...pr); p = (x * dx + y * dy - lo) / ((hi - lo) || 1); }
  p = Math.max(0, Math.min(1, p)); return sh.rev ? 1 - p : p; }
const dzChV = (sh, p) => { const d = sh.dark ?? 0.85, l = sh.light ?? 0.05; return l + (d - l) * Math.pow(1 - p, sh.bias ?? 1); };
const dzChBlend = (sh, p) => Math.pow(p, sh.bias ?? 1);   /* a blend: 0 is the first colour, 1 the second */
/* A painted zone (airbrush or auto shading) keeps its own map: CH_MAP x CH_MAP darknesses (0 to 255) over the zone's
   box, as base64. For a blend, dark is the first colour. dzChAt is what the zone asks for at a point: the darkness
   for a tone, the share of the second colour for a blend. */
const CH_MAP = 40, dzChMapC = new Map();
const dzChMapArr = (sh) => { let a = dzChMapC.get(sh.map); if (!a) { const s = atob(sh.map || ''), N = sh.mapN || CH_MAP; a = new Uint8Array(N * N); for (let i = 0; i < Math.min(s.length, a.length); i++) a[i] = s.charCodeAt(i); if (dzChMapC.size > 60) dzChMapC.clear(); dzChMapC.set(sh.map, a); } return a; };
const dzChMapEnc = (arr) => { let s = ''; for (const v of arr) s += String.fromCharCode(Math.max(0, Math.min(255, Math.round(v)))); return btoa(s); };
function dzChAt(sh, x, y, b) {
  if (sh.grad === 'paint' && sh.map) { const a = dzChMapArr(sh), N = sh.mapN || CH_MAP, u = Math.max(0, Math.min(N - 1, (x - b[0]) / (b[2] || 1) * N - 0.5)), v = Math.max(0, Math.min(N - 1, (y - b[1]) / (b[3] || 1) * N - 0.5)), i = Math.floor(u), j = Math.floor(v), i2 = Math.min(N - 1, i + 1), j2 = Math.min(N - 1, j + 1), fu = u - i, fv = v - j;
    const val = ((a[j * N + i] * (1 - fu) + a[j * N + i2] * fu) * (1 - fv) + (a[j2 * N + i] * (1 - fu) + a[j2 * N + i2] * fu) * fv) / 255; return sh.tech === 'blend' ? 1 - val : val; }
  const p = dzChP(sh, x, y, b); return sh.tech === 'blend' ? dzChBlend(sh, p) : dzChV(sh, p); }
// The zone's gradient as it is now, as a map to paint over.
const dzChBake = (sh, b) => { const N = CH_MAP, a = new Float32Array(N * N); for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const v = dzChAt(sh, b[0] + (i + 0.5) / N * b[2], b[1] + (j + 0.5) / N * b[3], b); a[j * N + i] = 255 * (sh.tech === 'blend' ? 1 - v : v); } return a; };
const CH_SHADE = { stipple: ['Stipple', 'Dots only, from quick even whips with a liner. Judged on the gradient, how even and smooth it is, and reaching the darkest.', '3RL'],
  whip: ['Whip', 'Whipped in black with a shader or magnum, solid at the dark end and fading out. Judged like stipple.', '9M1'],
  wash: ['Grey wash', 'Black thinned with water, blended through the wash values. The simulator starts on the grey wash caps. Judged on how dark each part is.', '13CM'],
  blend: ['Colour blend', 'Packed and whipped from one colour into the next, with no line where one stops. Judged on each band being the colour asked for, coverage and smoothness.', '11M1'] };
// Where t (0 to 1) falls among n colour stops: the stop before it and how far on towards the next.
const dzChSeg = (n, t) => { if (n < 2) return [0, 0]; const v = Math.max(0, Math.min(1, t)) * (n - 1), i = Math.min(n - 2, Math.floor(v)); return [i, v - i]; };
const chHexRGB = (h) => [1, 3, 5].map(i => parseInt(String(h).slice(i, i + 2), 16) || 0);
/* A colour value study's colour at a point (mm), shared with the simulator's judging. Each cell of the picture's
   colour copy (about 1 mm) is snapped to its nearest palette colour; between cells the colour is chosen only from
   the colours of the four cells round it, so no third colour creeps in along an edge, with a soft blend where two
   close colours meet (a gradient). edge: the point is within a cell of a change of colour. */
const dzChRGBC = new WeakMap();
function dzChRGBAt(sh, x, y, b) { const cols = sh.tech === 'blend' && sh.cols?.length > 1 ? sh.cols : sh.palC; if (!sh.rgb || !(cols?.length > 1)) return null;
  let C = dzChRGBC.get(sh); const key = cols.join();
  if (!C || C.rgb !== sh.rgb || C.key !== key) { const A = Uint8Array.from(atob(sh.rgb), ch => ch.charCodeAt(0)), PC = cols.map(chHexRGB), n = Math.floor(A.length / 3), idx = new Uint8Array(n);
    for (let i = 0; i < n; i++) { let bi = 0, bd = 1e9; for (let k = 0; k < PC.length; k++) { const d = (PC[k][0] - A[i * 3]) ** 2 + (PC[k][1] - A[i * 3 + 1]) ** 2 + (PC[k][2] - A[i * 3 + 2]) ** 2; if (d < bd) { bd = d; bi = k; } } idx[i] = bi; }
    C = { rgb: sh.rgb, key, A, PC, idx }; dzChRGBC.set(sh, C); }
  const RW = sh.rgbW || sh.rgbN || 80, RH = sh.rgbH || sh.rgbN || 80, u = Math.max(0, Math.min(RW - 1, (x - b[0]) / (b[2] || 1) * RW - 0.5)), v = Math.max(0, Math.min(RH - 1, (y - b[1]) / (b[3] || 1) * RH - 0.5));
  const i0 = Math.floor(u), j0 = Math.floor(v), i1 = Math.min(RW - 1, i0 + 1), j1 = Math.min(RH - 1, j0 + 1), fu = u - i0, fv = v - j0, A = C.A, at = (i, j, q) => A[(j * RW + i) * 3 + q];
  const px = [0, 1, 2].map(q => (at(i0, j0, q) * (1 - fu) + at(i1, j0, q) * fu) * (1 - fv) + (at(i0, j1, q) * (1 - fu) + at(i1, j1, q) * fu) * fv);
  const cand = [...new Set([C.idx[j0 * RW + i0], C.idx[j0 * RW + i1], C.idx[j1 * RW + i0], C.idx[j1 * RW + i1]])], dd = cand.map(k => Math.sqrt((C.PC[k][0] - px[0]) ** 2 + (C.PC[k][1] - px[1]) ** 2 + (C.PC[k][2] - px[2]) ** 2));
  const o = dd.map((d, n) => n).sort((a, z) => dd[a] - dd[z]), a1 = cand[o[0]], a2 = cand[o[1] ?? o[0]], t = o.length > 1 ? Math.max(0, Math.min(0.5, 0.5 - (dd[o[1]] - dd[o[0]]) / 40)) : 0;
  return { c: [0, 1, 2].map(q => C.PC[a1][q] * (1 - t) + C.PC[a2][q] * t), i: a1, edge: cand.length > 1 }; }
// A shading zone as it should look: dots for stipple, a smooth tone for whip and wash, the colours for a blend.
async function dzChShade(x, doc, l, scale) { const sh = l.sh || {}, outs = doc.layers.filter(o => o.t === 'shape' && o.role === 'outline' && !o.hide && (o.side || null) === (l.side || null));
  const P = dzChPts(l).flat(), xs = P.filter((_, i) => i % 2 === 0), ys = P.filter((_, i) => i % 2); if (!xs.length) return;
  const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], res = 0.2, cw = Math.max(1, Math.ceil(b[2] / res)), chh = Math.max(1, Math.ceil(b[3] / res));
  const c = document.createElement('canvas'); c.width = cw; c.height = chh; const g = c.getContext('2d'), im = g.createImageData(cw, chh), D = im.data;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, CS = (sh.cols?.length ? sh.cols : ['#b3261e', '#f2c21b']).map(chHexRGB); if (CS.length < 2) CS.push(CS[0]);
  const RGB = !!sh.rgb;   /* a colour value study: the picture in the palette's colours */
  for (let j = 0; j < chh; j++) for (let i = 0; i < cw; i++) { const v = dzChAt(sh, b[0] + (i + 0.5) * res, b[1] + (j + 0.5) * res, b), k = (j * cw + i) * 4;
    if (RGB) { const r = dzChRGBAt(sh, b[0] + (i + 0.5) * res, b[1] + (j + 0.5) * res, b); if (r) { D[k] = r.c[0]; D[k + 1] = r.c[1]; D[k + 2] = r.c[2]; D[k + 3] = 255; continue; } }
    if (sh.tech === 'blend') { const [si, f] = dzChSeg(CS.length, v); for (let q = 0; q < 3; q++) D[k + q] = CS[si][q] + (CS[si + 1][q] - CS[si][q]) * f; D[k + 3] = 255; continue; } D[k] = D[k + 1] = D[k + 2] = 20; D[k + 3] = sh.tech === 'stipple' ? (rnd() < v * 0.9 ? 235 : 0) : v * 255; }
  g.putImageData(im, 0, 0);
  x.save(); x.setTransform(scale, 0, 0, scale, 0, 0); if (outs.length) { const O = new Path2D(); for (const o of outs) O.addPath(dzChPath(o)); x.clip(O); } x.clip(dzChPath(l));
  x.imageSmoothingEnabled = sh.tech !== 'stipple'; x.drawImage(c, b[0] * CH_PX, b[1] * CH_PX, b[2] * CH_PX, b[3] * CH_PX); x.restore(); }
// A shape's outline as a path on the page (its turn and flips included).
const dzChPath = (L) => { const p = new Path2D(); p.addPath(new Path2D(dzSvgPath(L)), new DOMMatrix().translate(L.x + L.w / 2, L.y + (L.h || 0) / 2).rotate(L.rot || 0).scale(L.fx ? -1 : 1, L.fy ? -1 : 1)); return p; };
// The same outline as lines of points in mm on the skin, one every 0.3 mm, for the simulator's stencil and judging.
function dzChPts(L) { const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), out = [];
  svg.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden'; document.body.appendChild(svg);
  const M = new DOMMatrix().translate(L.x + L.w / 2, L.y + (L.h || 0) / 2).rotate(L.rot || 0).scale(L.fx ? -1 : 1, L.fy ? -1 : 1);
  try { for (const d of dzSvgPath(L).split(/(?=M)/)) { if (!d.trim()) continue; const pe = document.createElementNS(NS, 'path'); pe.setAttribute('d', d); svg.appendChild(pe);
      const len = pe.getTotalLength(), n = Math.max(2, Math.ceil(len / 3)), pts = [];
      for (let i = 0; i <= n; i++) { const q = M.transformPoint(pe.getPointAtLength(len * i / n)); pts.push(+(q.x / CH_PX).toFixed(2), +(q.y / CH_PX).toFixed(2)); }
      out.push(pts); } } finally { svg.remove(); }
  return out; }
// Packing: the shape's colour, kept inside the challenge's outlines.
async function dzChPack(x, doc, l, scale, one) { const outs = doc.layers.filter(o => o.t === 'shape' && o.role === 'outline' && !o.hide && (o.side || null) === (l.side || null));
  x.save(); x.setTransform(scale, 0, 0, scale, 0, 0); if (outs.length) { const P = new Path2D(); for (const o of outs) P.addPath(dzChPath(o)); x.clip(P); }
  await one(x, { ...l, fill: l.ink || '#141414', fm: undefined, stroke: null, sw: 0 }); x.restore(); }
/* The lessons as Challenge maker templates (once the simulator's script is loaded): each lesson's stencil becomes the
   outline (a rectangle or circle where it is one, otherwise a free shape traced from the stencil) and its packing a
   packing zone. A template keeps the lesson's own calibrated judging (chal.base) until a graded shape is changed. */
function dzChRec() { const subs = []; let cur = null; const P = (x, y) => { if (!cur) { cur = { pts: [], closed: false }; subs.push(cur); } cur.pts.push([x, y]); }, last = () => cur?.pts.at(-1);
  return { subs, moveTo(x, y) { cur = { pts: [[x, y]], closed: false }; subs.push(cur); }, lineTo: P, closePath() { if (cur) { cur.closed = true; cur = null; } },
    rect(x, y, w, h) { this.moveTo(x, y); P(x + w, y); P(x + w, y + h); P(x, y + h); this.closePath(); },
    arc(cx, cy, r, a0, a1, ccw) { this.ellipse(cx, cy, r, r, 0, a0, a1, ccw); },
    ellipse(cx, cy, rx, ry, rot, a0, a1, ccw) { let d = a1 - a0; if (ccw && d > 0) d -= Math.PI * 2; if (!ccw && d < 0) d += Math.PI * 2; if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6) d = ccw ? -Math.PI * 2 : Math.PI * 2;
      const n = Math.max(8, Math.ceil(Math.abs(d) * Math.max(rx, ry))), c = Math.cos(rot), s = Math.sin(rot); for (let i = 0; i <= n; i++) { const a = a0 + d * i / n, ex = rx * Math.cos(a), ey = ry * Math.sin(a); P(cx + ex * c - ey * s, cy + ex * s + ey * c); } },
    bezierCurveTo(a, b, c2, d2, e, f) { const [x0, y0] = last() || [a, b]; for (let i = 1; i <= 24; i++) { const t = i / 24, u = 1 - t; P(u * u * u * x0 + 3 * u * u * t * a + 3 * u * t * t * c2 + t * t * t * e, u * u * u * y0 + 3 * u * u * t * b + 3 * u * t * t * d2 + t * t * t * f); } },
    quadraticCurveTo(a, b, e, f) { const [x0, y0] = last() || [a, b]; for (let i = 1; i <= 16; i++) { const t = i / 16, u = 1 - t; P(u * u * x0 + 2 * u * t * a + t * t * e, u * u * y0 + 2 * u * t * b + t * t * f); } } }; }
/* A stencil (mask of w x h, 1 = line, covering box in mm) into centre lines in mm: brought to about 0.2 mm a pixel,
   thinned to one pixel (Zhang-Suen), walked from end to end (loops too), then simplified. Bits under 1.5 mm go. */
function dzChCentre(mask, w, h, box) { const k = Math.min(1, box[2] / 0.2 / w), W = Math.max(2, Math.round(w * k)), H = Math.max(2, Math.round(h * k)), m = new Uint8Array((W + 2) * (H + 2)), S = W + 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const sx = Math.min(w - 1, Math.floor((x + 0.5) / k)), sy = Math.min(h - 1, Math.floor((y + 0.5) / k)); if (mask[sy * w + sx]) m[(y + 1) * S + x + 1] = 1; }
  const nb = (i) => [m[i - S], m[i - S + 1], m[i + 1], m[i + S + 1], m[i + S], m[i + S - 1], m[i - 1], m[i - S - 1]];
  for (let ch = true, it = 0; ch && it < 60; it++) { ch = false; for (const pass of [0, 1]) { const del = []; for (let y = 1; y <= H; y++) for (let x = 1; x <= W; x++) { const i = y * S + x; if (!m[i]) continue; const P = nb(i), B = P.reduce((a, v) => a + v, 0); if (B < 2 || B > 6) continue;
    let A = 0; for (let q = 0; q < 8; q++) if (!P[q] && P[(q + 1) % 8]) A++; if (A !== 1) continue;
    if (pass === 0 ? (P[0] * P[2] * P[4] || P[2] * P[4] * P[6]) : (P[0] * P[2] * P[6] || P[0] * P[4] * P[6])) continue; del.push(i); } for (const i of del) m[i] = 0; if (del.length) ch = true; } }
  for (let y = 1; y <= H; y++) for (let x = 1; x <= W; x++) { const i = y * S + x; if (!m[i]) continue; const P = nb(i);   /* staircase corners on diagonals: the two either side already touch */
    if ((P[0] && P[2] && !P[4] && !P[6] && !P[5]) || (P[2] && P[4] && !P[0] && !P[6] && !P[7]) || (P[4] && P[6] && !P[0] && !P[2] && !P[1]) || (P[6] && P[0] && !P[2] && !P[4] && !P[3])) m[i] = 0; }
  const off = [-S, -S + 1, 1, S + 1, S, S - 1, -1, -S - 1], deg = (i) => off.reduce((a, o) => a + m[i + o], 0), seen = new Set(), ek = (a, b) => a < b ? a + ',' + b : b + ',' + a, paths = [];
  const walk = (s, n0) => { const p = [s, n0]; seen.add(ek(s, n0)); let a = n0; for (;;) { if (deg(a) !== 2) break; const nx = off.map(o => a + o).find(j => m[j] && !seen.has(ek(a, j))); if (nx == null) break; seen.add(ek(a, nx)); p.push(nx); a = nx; } return p; };
  const all = []; for (let y = 1; y <= H; y++) for (let x = 1; x <= W; x++) if (m[y * S + x]) all.push(y * S + x);
  for (const pass of [0, 1]) for (const i of all) { if (pass === 0 && deg(i) === 2) continue; for (const o of off) { const j = i + o; if (m[j] && !seen.has(ek(i, j))) paths.push(walk(i, j)); } }
  const mmOf = (i) => [box[0] + ((i % S) - 0.5) / W * box[2], box[1] + (Math.floor(i / S) - 0.5) / H * box[3]];
  const dp = (P, tol) => { if (P.length < 3) return P; let mi = 0, md = 0; const [a, b] = [P[0], P[P.length - 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let i = 1; i < P.length - 1; i++) { const d = L < 1e-6 ? Math.hypot(P[i][0] - a[0], P[i][1] - a[1]) : Math.abs((b[0] - a[0]) * (a[1] - P[i][1]) - (a[0] - P[i][0]) * (b[1] - a[1])) / L;   /* a loop: from its start */ if (d > md) { md = d; mi = i; } }
    return md > tol ? [...dp(P.slice(0, mi + 1), tol).slice(0, -1), ...dp(P.slice(mi), tol)] : [a, b]; };
  return paths.map(p => p.map(mmOf)).filter(p => p.reduce((t, q, i) => i ? t + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0, 0) >= 1.5).map(p => ({ closed: false, pts: dp(p, 0.25) })); }
/* ---------- Picture trace (Challenge maker: From a picture) ----------
   Pixels to graded vector shapes. The picture (RGBA, W x H) is brought down to a few colours (k-means from evenly
   spaced shades), the background found from the border, speckle cleared (a majority filter, then every patch under
   the Detail size merged into its neighbour). For line work the darkest colour is split: what an opening of the line
   weight keeps is a solid fill, the rest are lines, thinned to their centre. The silhouette's edge is the outline.
   Each colour's areas are traced along the pixel edges into rings (holes run the other way), smoothed and simplified.
   o: { k: colours, minPx: smallest patch in px, lineR: line half-width in px, lines: split lines out, darkLum }.
   Returns { cols: [[r,g,b]], rings: [{ ci, loops: [[[x,y]...]] }], thin: Uint8Array mask, sil: Uint8Array mask, dark }. */
function dzTraceImg(D, W, H, o) { const prog = o.prog || (() => {}); prog(0.05, 'Finding the colours');
  const N = W * H, lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11, px = new Float32Array(N * 3), op = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const a = D[i * 4 + 3] / 255; op[i] = a > 0.5 ? 1 : 0; for (let q = 0; q < 3; q++) px[i * 3 + q] = D[i * 4 + q] * a + 255 * (1 - a); }
  // k-means: K colours plus one for the background, from evenly spaced shades
  const idx = []; for (let i = 0; i < N; i++) if (op[i]) idx.push(i); const K = Math.max(1, o.k) + (idx.length > N * 0.97 ? 1 : 0);   /* one more for the background, unless the picture is see-through round it */
  const step = Math.max(1, Math.floor(idx.length / 20000)), smp = idx.filter((_, n) => n % step === 0), sl = smp.map(i => [px[i * 3], px[i * 3 + 1], px[i * 3 + 2]]).sort((a, b) => lum(a) - lum(b));
  let cs = Array.from({ length: K }, (_, k) => [...(sl[Math.min(sl.length - 1, Math.floor((k + 0.5) / K * sl.length))] || [255, 255, 255])]);
  const near = (r, g, b) => { let bi = 0, bd = 1e12; for (let k = 0; k < cs.length; k++) { const c = cs[k], d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (d < bd) { bd = d; bi = k; } } return bi; };
  for (let it = 0; it < 10; it++) { const s = cs.map(() => [0, 0, 0, 0]); for (const c of sl) { const t = s[near(c[0], c[1], c[2])]; t[0] += c[0]; t[1] += c[1]; t[2] += c[2]; t[3]++; } cs = cs.map((c, k) => s[k][3] ? [s[k][0] / s[k][3], s[k][1] / s[k][3], s[k][2] / s[k][3]] : c); }
  prog(0.25, 'Clearing the noise'); const L = new Uint8Array(N); for (let i = 0; i < N; i++) L[i] = op[i] ? near(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]) : 255;
  // the background: see-through, or the colour that holds most of the border
  const bc = new Array(K).fill(0); let bn = 0; for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { const l = L[y * W + x]; if (l < 255) bc[l]++; bn++; } for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { const l = L[y * W + x]; if (l < 255) bc[l]++; bn++; }
  const bgK = bc.indexOf(Math.max(...bc)); if (bc[bgK] > bn * 0.4) for (let i = 0; i < N; i++) if (L[i] === bgK) L[i] = 255;
  // speckle: two passes of a 3x3 majority
  for (let pass = 0; pass < 2; pass++) { const S = L.slice(), cnt = new Uint16Array(256); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; let best = S[i], bv = 0; const seen = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = S[i + dy * W + dx]; if (!cnt[v]) seen.push(v); cnt[v]++; if (cnt[v] > bv) { bv = cnt[v]; best = v; } } if (bv >= 5) L[i] = best; for (const v of seen) cnt[v] = 0; } }
  // patches under the Detail size go to the neighbour they share most edge with
  const merge = () => { const C = new Int32Array(N).fill(-1), st = []; let nc = 0, changed = 0;
    for (let s0 = 0; s0 < N; s0++) { if (C[s0] >= 0) continue; const lab = L[s0], mem = [s0]; C[s0] = nc; st.length = 0; st.push(s0); const nb = new Map();
      while (st.length) { const i = st.pop(), x = i % W, y = (i - x) / W; for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) { if (j < 0) continue; if (L[j] === lab) { if (C[j] < 0) { C[j] = nc; st.push(j); mem.push(j); } } else nb.set(L[j], (nb.get(L[j]) || 0) + 1); } }
      if (mem.length < o.minPx && nb.size) { let to = lab, tv = -1; for (const [k, v] of nb) if (v > tv) { tv = v; to = k; } for (const i of mem) L[i] = to; changed++; } nc++; } return changed; };
  for (let r = 0; r < 3 && merge(); r++); prog(0.5, 'Finding the lines');
  // line work: the darkest colour, if dark, split into solid fills (kept by an opening of the line weight) and lines
  const used = [...new Set(L)].filter(v => v < 255), dark = o.lines ? used.reduce((m, k) => (m < 0 || lum(cs[k]) < lum(cs[m]) ? k : m), -1) : -1;
  let thin = null; if (dark >= 0 && lum(cs[dark]) < (o.darkLum ?? 100)) { const M = new Uint8Array(N); for (let i = 0; i < N; i++) M[i] = L[i] === dark ? 1 : 0;
    const thick = dzMorph(dzMorph(M, W, H, o.lineR, true), W, H, o.lineR, false); thin = new Uint8Array(N); for (let i = 0; i < N; i++) if (M[i] && !thick[i]) { thin[i] = 1; L[i] = 254; } }
  const sil = new Uint8Array(N); for (let i = 0; i < N; i++) sil[i] = L[i] < 255 ? 1 : 0;
  prog(0.65, 'Tracing the shapes'); const rings = []; for (const k of [...new Set(L)].filter(v => v < 254)) { const M = new Uint8Array(N); for (let i = 0; i < N; i++) M[i] = L[i] === k ? 1 : 0; const loops = dzTraceLoops(M, W, H).filter(lp => Math.abs(dzRingArea(lp)) >= o.minPx); if (loops.length) rings.push({ ci: k, loops }); }
  return { cols: cs, rings, thin, sil, dark, lab: L };
}
// A mask grown (er false) or shrunk (er true) by n pixels, four ways round, without making garbage.
function dzMorph(A, W, H, n, er) { let B = A; for (let r = 0; r < n; r++) { const C = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { const row = y * W; for (let x = 0; x < W; x++) { const i = row + x, c = B[i], l = x ? B[i - 1] : 0, rr = x < W - 1 ? B[i + 1] : 0, u = y ? B[i - W] : 0, d = y < H - 1 ? B[i + W] : 0;
      C[i] = er ? (c & l & rr & u & d) : (c | l | rr | u | d); } } B = C; } return B; }
/* The whole trace for a set of choices (run in a worker): the colour areas, the lines along their centre (in mm on
   the skin), the outline (the silhouette's biggest edge) and the detail lines (the lines inside it, not on it). */
// A box blur of an RGBA picture, n pixels each way, twice (close to a soft gaussian): for finding tonal zones.
function dzBlurImg(D, W, H, n) { if (n < 1) return D; let A = Float32Array.from(D), B = new Float32Array(A.length);
  for (let pass = 0; pass < 4; pass++) { const hz = pass % 2 === 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = [0, 0, 0, 0]; let c = 0;
      for (let k = -n; k <= n; k++) { const xx = hz ? x + k : x, yy = hz ? y : y + k; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = (yy * W + xx) * 4; t[0] += A[j]; t[1] += A[j + 1]; t[2] += A[j + 2]; t[3] += A[j + 3]; c++; }
      const i = (y * W + x) * 4; for (let q = 0; q < 4; q++) B[i + q] = t[q] / c; } [A, B] = [B, A]; } return Uint8ClampedArray.from(A); }
function dzTraceRun(D, W, H, P, prog) { if (P.blurR) prog(0.03, 'Softening into zones'); const R = dzTraceImg(P.blurR ? dzBlurImg(D, W, H, P.blurR) : D, W, H, { ...P, prog }), { ox, oy, s } = P;
  if (P.linesOnly && R.thin) R.rings = R.rings.filter(r => r.ci !== R.dark);
  prog(0.82, 'Following the lines'); R.lineSubs = R.thin ? dzChCentre(R.thin, W, H, [ox, oy, W * s, H * s]) : [];
  R.outer = dzTraceLoops(R.sil, W, H).filter(lp => dzRingArea(lp) > 0).sort((a, b) => dzRingArea(b) - dzRingArea(a)).slice(0, 1);
  const inner = dzMorph(R.sil, W, H, Math.max(1, Math.round(P.lw * 1.2 / s)), true), isIn = ([X, Y]) => { const x = Math.floor((X - ox) / s), y = Math.floor((Y - oy) / s); return x >= 0 && y >= 0 && x < W && y < H && inner[y * W + x]; };
  const det = []; for (const sp of R.lineSubs) { let cur = []; for (const q of sp.pts) { if (isIn(q)) cur.push(q); else { if (cur.length > 1) det.push(cur); cur = []; } } if (cur.length > 1) det.push(cur); }
  R.details = det.filter(p => p.reduce((t, q, i) => i ? t + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0, 0) >= 1.5); delete R.thin; delete R.sil; delete R.lineSubs; prog(1, 'Done'); return R; }
// The trace in a worker of its own, so the screen never stalls: the functions it needs, sent as its source.
const dzTraceWorker = () => new Worker(URL.createObjectURL(new Blob([[dzTraceImg, dzTraceLoops, dzMorph, dzBlurImg, dzChCentre, dzTraceRun].map(f => f.toString()).join('\n')
  + '\nconst dzRingArea = ' + dzRingArea.toString() + ';\nonmessage = (e) => { const { id, D, W, H, P } = e.data; try { const R = dzTraceRun(D, W, H, P, (p, m) => postMessage({ id, p, m })); postMessage({ id, R }); } catch (err) { postMessage({ id, err: String(err && err.message || err) }); } };'], { type: 'text/javascript' })));
// The edges of a mask (1 inside) as closed loops of pixel corners: outlines one way round, holes the other.
function dzTraceLoops(M, W, H) { const out = new Map(), key = (x, y) => y * (W + 1) + x, add = (a, b) => { let l = out.get(a); if (!l) out.set(a, l = []); l.push(b); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!M[y * W + x]) continue;
    if (y === 0 || !M[(y - 1) * W + x]) add(key(x, y), key(x + 1, y)); if (x === W - 1 || !M[y * W + x + 1]) add(key(x + 1, y), key(x + 1, y + 1));
    if (y === H - 1 || !M[(y + 1) * W + x]) add(key(x + 1, y + 1), key(x, y + 1)); if (x === 0 || !M[y * W + x - 1]) add(key(x, y + 1), key(x, y)); }
  const loops = []; for (const [s] of out) { let l = out.get(s); while (l && l.length) { const lp = [s]; let a = s; for (let g = 0; g < 1e6; g++) { const L2 = out.get(a); if (!L2?.length) break; const b = L2.pop(); if (b === s) break; lp.push(b); a = b; }
      loops.push(lp.map(v => [v % (W + 1), Math.floor(v / (W + 1))])); l = out.get(s); } } return loops; }
const dzRingArea = (lp) => { let a = 0; for (let i = 0; i < lp.length; i++) { const p = lp[i], q = lp[(i + 1) % lp.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
// A traced loop of pixel corners smoothed (the staircase averaged out) and simplified to within tol px.
const dzTraceSmooth = (lp, tol) => { const n = lp.length; if (n < 4) return lp; let P = lp; for (let pass = 0; pass < 2; pass++) P = P.map((p, i) => { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n]; return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4]; });
  const pts = P.map(([x, y]) => ({ x, y })); return (typeof dzRdp === 'function' ? dzRdp([...pts, pts[0]], tol).slice(0, -1) : pts).map(q => [q.x, q.y]); };
const dzChVec = (subs, o) => { const all = subs.flatMap(s => s.pts), xs = all.map(p => p[0]), ys = all.map(p => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(0.2, Math.max(...xs) - x0), h = Math.max(0.2, Math.max(...ys) - y0);
  return dzS('vec', x0 * CH_PX, y0 * CH_PX, w * CH_PX, h * CH_PX, { fill: 'none', subs: subs.filter(s => s.pts.length > 1).map(s => ({ closed: s.closed, nodes: s.pts.map(([x, y]) => dzNd((x - x0) / w, (y - y0) / h)) })), ...o }); };
function dzChTemplates() { if (typeof TT_CH === 'undefined') return [];
  return TT_CH.map(T => [`Lesson ${TT_LS_CH.find(c => c.id === 'l-' + T.id.slice(3))?.lesson || ''}: ${T.title}`, () => {
    const nd = T.strokeNeedle || T.liner || T.needle, pn = T.packNeedle || T.needles?.find(n => n !== nd) || '7RS', L = [], px = (v) => v * CH_PX;
    if (T.circle) { const [cx, cy, r] = T.circle; L.push(dzS('ellipse', px(cx - r), px(cy - r), px(r * 2), px(r * 2), { fill: 'none', role: 'outline', nd }));
      const ink = T.mixOf ? ttToHex(ttMix(ttHex(T.mixOf[0]), ttHex(T.mixOf[1]), 0.5)) : '#141414'; L.push(dzS('ellipse', px(cx - r), px(cy - r), px(r * 2), px(r * 2), { fill: ink, role: 'pack', nd: pn, mixOf: T.mixOf ? [...T.mixOf] : ['#141414'], mixT: 0.5, ink })); }
    else if (T.pack) { const b = T.pack; L.push(dzS('rect', px(b[0]), px(b[1]), px(b[2]), px(b[3]), { fill: 'none', role: 'outline', nd })); L.push(dzS('rect', px(b[0]), px(b[1]), px(b[2]), px(b[3]), { fill: '#141414', role: 'pack', nd: pn, mixOf: ['#141414'], ink: '#141414' })); }
    else { const R = dzChRec(); T.path(R); L.push(dzChVec(R.subs, { role: 'outline', nd })); }
    const zb = T.stipple || T.wgrad;
    if (zb) L.push(dzS('rect', px(zb[0]), px(zb[1]), px(zb[2]), px(zb[3]), { fill: 'none', role: 'shade', nd: T.stipple ? '3RL' : (T.shadeNeedle || '13CM'), sh: T.stipple ? { tech: 'stipple', grad: 'linear', ang: 90, dark: 0.85, light: 0.05, bias: 1 } : { tech: 'wash', grad: 'linear', ang: 90, rev: true, dark: 1, light: 0.14, bias: 1 } }));
    if (T.tri) { const R = dzChRec(), mx = (a, b, t) => ttToHex(ttMix(ttHex(a), ttHex(b), t)), mixs = [['#141414', '#b3261e', 0.6], ['#b3261e'], ['#b3261e', '#f2c21b', 0.5], ['#f2c21b']]; T.path(R);   /* as the lesson: a black and red shadow at the point, red, orange to three quarters, yellow at the wide end */
      L.push(dzChVec(R.subs, { role: 'shade', nd: T.packNeedle || '11M1', sh: { tech: 'blend', grad: 'linear', ang: -90, bias: 1, mixs, cols: mixs.map(m => m[1] ? mx(m[0], m[1], m[2]) : m[0]) } })); }
    L.forEach((l) => l.name = { pack: 'Packing', shade: 'Shading' }[l.role] || 'Outline');
    return L; }, { base: T.id, text: T.text, lessonJudge: true }]); }
// What the graded shapes are, so a template knows when it has been changed.
const dzChSig = (doc) => JSON.stringify(doc.layers.filter(l => l.t === 'shape' && l.role).map(l => [l.role, l.nd, l.shape, Math.round(l.x), Math.round(l.y), Math.round(l.w), Math.round(l.h || 0), l.rot || 0, l.fx, l.fy, l.subs, l.ink, l.sh, l.nds]));
const CH_FOCUS = [['line', 'Linework', 1], ['pack', 'Packing', 1], ['shade', 'Shading', 1], ['colour', 'Colour', 0.6], ['heal', 'Healing', 0.8], ['tech', 'Technique', 0.8]];
// The challenge as the simulator plays it, or { err } when it can't be played yet.
function dzChSpec(doc, title, did) { const S = doc.layers.filter(l => l.t === 'shape' && l.role && !l.hide), outs = S.filter(l => l.role === 'outline'), dets = S.filter(l => l.role === 'detail'), pk = S.find(l => l.role === 'pack');
  if (!outs.length && !S.some(l => l.role === 'pack' || l.role === 'shade')) return { err: 'Give a shape a role first (Grade as in the strip): an outline, packing or shading.' };   /* a value study can be shading alone */
  const nd = outs[0]?.nd || dets[0]?.nd || S.find(l => l.nd)?.nd || '5RL', lines = [...outs, ...dets].flatMap(dzChPts);
  const T = { id: 'u-' + did, title: title || 'Challenge', cat: pk ? 'pack' : 'line', needle: nd, liner: nd, strokeNeedle: nd, lines, pal: doc.chal?.pal || 'default', lock: !!doc.chal?.lock, palData: (() => { let mine = []; try { mine = JSON.parse(Settings.get('tt_pals', '[]')); } catch {} return (Array.isArray(mine) ? mine : []).find(x => x.id === doc.chal?.pal) || null; })(),
    needles: [...new Set([nd, ...dets.map(l => l.nd || nd), ...(pk ? (dzChNds(pk).length ? dzChNds(pk) : ['7RS']) : [])])] };
  const C0 = doc.chal || {}; if (C0.base && C0.lessonJudge !== false && C0.sig === dzChSig(doc)) T.base = C0.base;   /* an unchanged lesson template: the lesson's own judging */
  else { T.zones = true; T.focus = Object.fromEntries(CH_FOCUS.map(([k, , v]) => [k, C0.focus?.[k] ?? v])); }
  if (doc.chal?.pal === 'wash') { T.wash = true; T.ink = 'wash'; }
  if (doc.chal?.needles?.length) T.needles = [...new Set([...doc.chal.needles, ...T.needles])];   /* the setup's needles: ticked and allowed in the simulator */
  if (doc.chal?.bodyArea) T.area = doc.chal.bodyArea;
  if (doc.chal?.refs?.length) T.refs = doc.chal.refs.map(r => ({ ref: r.ref, ar: r.ar || 1 }));
  const shs = S.filter(l => l.role === 'shade');
  if (shs.length) { T.shades = shs.map(l => { const pts = dzChPts(l), P = pts.flat(), xs = P.filter((_, i) => i % 2 === 0), ys = P.filter((_, i) => i % 2);
      const { raw, src, ...sh } = l.sh || {}; if (sh.stencil) (T.stencils ||= []).push(sh.stencil); return { pts, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], nd: l.nd || CH_SHADE[sh.tech || 'stipple'][2], nds: dzChNds(l), ...sh }; });
    T.needles = [...new Set([...T.needles, ...T.shades.flatMap(z => z.nds?.length ? z.nds : [z.nd])])]; T.cat = 'shade'; if (T.shades.some(z => z.tech === 'wash')) { T.wash = true; T.ink = 'wash'; } }
  if (pk) { const P = dzChPts(pk).flat(), xs = P.filter((_, i) => i % 2 === 0), ys = P.filter((_, i) => i % 2), x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    T.pack = [x0, y0, x1 - x0, y1 - y0].map(v => Math.round(v * 10) / 10); T.packNeedle = pk.nd || '7RS'; T.packNeedles = dzChNds(pk).length ? dzChNds(pk) : [T.packNeedle]; T.packPts = dzChPts(pk);
    const ink = pk.ink || '#141414'; T.packInk = ink;
    if (pk.shape === 'ellipse' && Math.abs(pk.w - (pk.h || 0)) < 4) { T.circle = [(x0 + x1) / 2, (y0 + y1) / 2, Math.min(x1 - x0, y1 - y0) / 2].map(v => Math.round(v * 100) / 100); T.mixOf = pk.mixOf?.[1] ? [pk.mixOf[0], pk.mixOf[1]] : [ink, ink]; } }
  const C = doc.chal || {}, what = outs[0]?.shape === 'ellipse' ? 'circle' : 'shape';
  const own = C.text?.trim() && !(C.base && C.text === C.baseText && C.sig !== dzChSig(doc));   /* a lesson's own words go once its shapes or needles change; the artist's own words stay */
  const lead = C.style ? `A ${C.style.toLowerCase()} piece in ${{ black: 'black', bg: 'black and grey', colour: 'colour' }[C.inkT] || 'ink'}. ` : '';
  T.text = (own ? C.text.trim() : '') || lead + (outs.length ? `Line the ${what} with the ${nd}${dets.length ? `, and the detail lines with the ${[...new Set(dets.map(l => l.nd || nd))].join(' and ')}` : ''}.` : 'No linework in this one.')
    + (shs.length ? ' ' + shs.map(l => { const z = l.sh || {}; return `${z.tech === 'blend' ? 'Blend' : 'Shade'} the ${CH_SHADE[z.tech || 'stipple'][0].toLowerCase()} zone with ${dzChOr(dzChNds(l))}${z.tech === 'blend' ? `, through its ${(z.cols || []).length} colours in order` : z.grad === 'flat' ? ', one even tone' : ', dark to light like the example'}.`; }).join(' ') : '')
    + (pk ? ` Then change to ${dzChOr(T.packNeedles)} and pack it solid${pk.mixOf?.[1] ? ', in a colour mixed from two caps like the example' : (pk.ink || '#141414') === '#141414' ? ' black' : ' in the colour of the example'}.` : '') + ' Let it settle, then press Done.';
  return T; }
async function dzSavePattern(cv, title, toDevice) {
  const png = (c) => new Promise(r => c.toBlob(r, 'image/png')), s = Math.min(1, 420 / Math.max(cv.width, cv.height)), th = document.createElement('canvas');
  th.width = Math.max(1, Math.round(cv.width * s)); th.height = Math.max(1, Math.round(cv.height * s)); th.getContext('2d').drawImage(cv, 0, 0, th.width, th.height);
  const blob = await png(cv);
  if (toDevice) { const f = new File([blob], (title || 'pattern').replace(/[^\w-]+/g, '_') + '.png', { type: 'image/png' }); return saveFiles([f]); }
  await DB.run('INSERT INTO ref_images (title, category, photo_ref, thumb_ref, w, h) VALUES (?, ?, ?, ?, ?, ?)',
    [title || 'Pattern', 'Patterns', await Media.save(blob, 'png'), await Media.save(await png(th), 'png'), cv.width, cv.height]);
  toast('Saved to References, in Patterns: pick it for a texture fill.', 3000); }
// The pattern options, the same for a new design and a new simulator piece: cell size, ratio, neighbours, background.
const patOptsHtml = (o, clearLabel, fullLabel) => `<div class="lbl">Cell across</div><div class="dz-papers">${PAT_SIZES.map(v => `<button data-patw="${v}" class="${o.w === v ? 'on' : ''}"><b>${v} mm</b></button>`).join('')}
    <label class="dz-csize" style="margin:0"><span>Other</span><input class="in" type="text" inputmode="decimal" data-patwi value="${PAT_SIZES.includes(o.w) ? '' : o.w}" placeholder="mm" style="width:70px"></label></div>
  <div class="lbl" style="margin-top:8px">Shape</div><div class="seg">${PAT_RATIOS.map(([n, a, b]) => `<button data-patr="${a}:${b}" class="${o.ra === a && o.rb === b ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>
  <div class="lbl" style="margin-top:8px">Neighbours shown</div><div class="seg">${[[0, 'Off'], [1, '1 ring'], [2, '2 rings'], [3, '3 rings']].map(([v, n]) => `<button data-patring="${v}" class="${o.ring === v ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>
  <div class="lbl" style="margin-top:8px">Background</div><div class="seg">${[[true, clearLabel || 'See-through'], [false, fullLabel || 'Colour']].map(([v, n]) => `<button data-patclear="${v ? 1 : 0}" class="${o.clear === v ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>
  <p class="muted" style="font-size:12px;margin:8px 0 12px">${dzMM(o.w)} × ${dzMM(o.w * o.rb / o.ra)} mm. Draw in the cell: what crosses an edge comes back on the other side, so it always repeats seamlessly. Save it to References (Patterns) to use as a texture fill.</p>`;
// A click or entry in those options; true when it was one.
const patOptsAct = (o, t) => { const d = (k) => t.closest(`[data-${k}]`)?.dataset[k];
  if (d('patw')) { o.w = +d('patw'); return true; } if (d('patr')) { const [a, b] = d('patr').split(':').map(Number); o.ra = a; o.rb = b; return true; }
  if (d('patring') != null) { o.ring = +d('patring'); return true; } if (d('patclear') != null) { o.clear = d('patclear') === '1'; return true; } return false; };
/* Folded pamphlets: one landscape sheet, always two-sided (outside = front, inside = back). Panel names follow how the sheet folds: on a trifold the
   panel that folds in is 1.5 mm narrower so it tucks in without buckling. */
const DZ_FOLD_TYPES = {
  tri: { name: 'Trifold', sub: '3 panels, folds in' },
  bi: { name: 'Bifold', sub: 'Folds in half' },
  z: { name: 'Z-fold', sub: '3 panels, zigzag' },
  gate: { name: 'Gatefold', sub: 'Flaps meet in the middle' },
  quad: { name: '4-panel', sub: 'Accordion' }
};
const DZ_FOLD_SHEETS = ['A4', 'Letter', 'Legal', 'A3', 'Tabloid'];
function dzFold(type, sheet) {
  const p = DZ_PAPER.find(x => x[0] === sheet) || DZ_PAPER[2], wmm = p[2], hmm = p[1];   // laid flat, landscape
  const dpi = [300, 250, 200, 150, 100].find(d => (wmm * d / 25.4) * (hmm * d / 25.4) <= 16e6) || 72;
  const W = Math.round(wmm * dpi / 25.4), H = Math.round(hmm * dpi / 25.4), mm = dpi / 25.4, n = type === 'bi' ? 2 : type === 'quad' || type === 'gate' ? 4 : 3;
  let out, inn, lo, li;
  if (type === 'tri') { const f = W / 3 - 1.5 * mm, o2 = (W - f) / 2; out = [f, f + o2]; inn = [o2, 2 * o2];
    lo = ['Inside flap', 'Back', 'Front cover']; li = ['Inside left', 'Inside middle', 'Inside right (folds in)']; }
  else if (type === 'bi') { out = inn = [W / 2]; lo = ['Back', 'Front cover']; li = ['Inside left', 'Inside right']; }
  else if (type === 'gate') { out = inn = [W / 4, W * 3 / 4]; lo = ['Cover, right half', 'Back', 'Cover, left half']; li = ['Left flap', 'Inside middle', 'Right flap']; }
  else { out = inn = [...Array(n - 1)].map((_, i) => W * (i + 1) / n); lo = [...Array(n)].map((_, i) => 'Outside ' + (i + 1)); li = [...Array(n)].map((_, i) => 'Inside ' + (i + 1)); }
  const r = (a) => a.map(Math.round), name = DZ_FOLD_TYPES[type].name;
  return { w: W, h: H, dpi, label: name, mm: [wmm, hmm], sheet: p[0],
    fold: { type, out: r(out), inn: r(inn), lo, li } };
}
// Keep proportions: pictures and the logo by default, shapes not; text sizes with its letters.
const dzKeep = (l) => l.frame ? !!l.keep : l.t === 'text' || (l.keep ?? (l.t !== 'shape' || l.shape === 'path'));

/* ---------- Fonts ---------- */
const DZF = {
  loaded: new Set(['Inter', 'Pirata One', 'Georgia', 'Arial']),
  custom() { try { return JSON.parse(Settings.get('dz_fonts', '[]')); } catch { return []; } },
  async load(name) {
    if (!name || this.loaded.has(name)) return;
    const g = DZ_FONTS.find(f => f[0] === name)?.[1];
    if (g) {
      const l = document.createElement('link'); l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=' + g.replace(/ /g, '+') + '&display=swap';
      document.head.appendChild(l);
      await new Promise(r => { l.onload = r; l.onerror = r; setTimeout(r, 4000); });
    } else {
      const c = this.custom().find(f => f.name === name);
      if (c) { try { const u = await Media.url(c.ref); const ff = new FontFace(name, `url(${u})`); await ff.load(); document.fonts.add(ff); } catch {} }
    }
    await Promise.all([document.fonts.load(`400 48px "${name}"`), document.fonts.load(`700 48px "${name}"`)]).catch(() => {});
    this.loaded.add(name);
  },
  async all(doc) { const t = DZ_THEMES[doc.theme] || DZ_THEMES.ink;
    await Promise.all([t.f1, t.f2, ...doc.layers.filter(l => l.t === 'text' || (l.t === 'field' && l.font)).map(l => l.font[0] === '@' ? t['f' + l.font[1]] : l.font)].map(f => this.load(f)));
    // italics are separate font files: fetched here so the first draw isn't in the fallback font
    await Promise.all(doc.layers.filter(l => l.it && l.font).flatMap(l => [400, 700].map(w => document.fonts.load(`italic ${w} 48px "${dzFont(doc, l.font)}"`).catch(() => {})))); }
};

/* ---------- Drawing ---------- */
const DZI = new Map();   // media ref -> loaded Image
/* Adjust colour for pictures: the same sliders as the simulator's Adjust colour (exposure, brightness, contrast,
   gamma, saturation, vibrance, temperature, tint, hue), without the simulator's limits to what ink can look like. */
const DZ_ADJ = [['exp', 'Exposure', -2, 2, 0.05, v => (v > 0 ? '+' : '') + (+v).toFixed(2)], ['bri', 'Brightness', -1, 1, 0.02], ['con', 'Contrast', -1, 1, 0.02], ['gam', 'Gamma', 0.3, 3, 0.05, v => (+v).toFixed(2)],
  ['sat', 'Saturation', -1, 1, 0.02], ['vib', 'Vibrance', -1, 1, 0.02], ['tmp', 'Temperature', -1, 1, 0.02], ['tin', 'Tint', -1, 1, 0.02], ['hue', 'Hue', -180, 180, 1, v => Math.round(v) + '°']];
const DZ_ADJ0 = { exp: 0, bri: 0, con: 0, gam: 1, sat: 0, vib: 0, tmp: 0, tin: 0, hue: 0 };
function dzAdjust(src, dst, V) { const O = src.data, D = dst.data, hc = Math.cos(V.hue * Math.PI / 180), hs = Math.sin(V.hue * Math.PI / 180), ex = Math.pow(2, V.exp), ck = 1 + V.con, gi = 1 / V.gam;
  for (let i = 0; i < O.length; i += 4) { if (!O[i + 3]) { D[i + 3] = 0; continue; }
    let r = O[i] / 255 * ex + V.bri * 0.5, g = O[i + 1] / 255 * ex + V.bri * 0.5, b = O[i + 2] / 255 * ex + V.bri * 0.5;
    r = Math.max(0, (r - 0.5) * ck + 0.5); g = Math.max(0, (g - 0.5) * ck + 0.5); b = Math.max(0, (b - 0.5) * ck + 0.5);
    if (V.gam !== 1) { r = r ** gi; g = g ** gi; b = b ** gi; }
    if (V.hue) { const y = 0.299 * r + 0.587 * g + 0.114 * b, ii = 0.596 * r - 0.274 * g - 0.322 * b, q = 0.211 * r - 0.523 * g + 0.312 * b, i2 = ii * hc - q * hs, q2 = ii * hs + q * hc;
      r = y + 0.956 * i2 + 0.621 * q2; g = y - 0.272 * i2 - 0.647 * q2; b = y - 1.106 * i2 + 1.703 * q2; }
    const l = 0.299 * r + 0.587 * g + 0.114 * b, mx = Math.max(r, g, b), mn = Math.min(r, g, b), s0 = mx > 0 ? (mx - mn) / mx : 0, sk = (1 + V.sat) * (1 + V.vib * (1 - s0));
    r = l + (r - l) * sk; g = l + (g - l) * sk; b = l + (b - l) * sk;
    r += V.tmp * 0.12; b -= V.tmp * 0.12; g -= V.tin * 0.1; r += V.tin * 0.04; b += V.tin * 0.04;
    D[i] = r * 255; D[i + 1] = g * 255; D[i + 2] = b * 255; D[i + 3] = O[i + 3]; } }
async function dzImg(ref) {
  if (!ref) return null;
  if (DZI.has(ref)) return DZI.get(ref);
  const u = await Media.url(ref); if (!u) return null;
  const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; });
  DZI.set(ref, img); return img;
}
const dzCol = (doc, c) => !c || c === 'none' ? null : c[0] === '@' ? (DZ_THEMES[doc.theme] || DZ_THEMES.ink)[c.slice(1)] : c;
const dzFont = (doc, f) => f && f[0] === '@' ? (DZ_THEMES[doc.theme] || DZ_THEMES.ink)['f' + f[1]] : f;
function dzFill(doc, s) {
  const v = doc.vals || {}, get = (k) => Settings.get(k) || '';
  const map = { studio: get('studio_name') || get('artist_name'), artist: get('artist_name'), phone: get('artist_phone'),
    instagram: get('artist_instagram').replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '@').replace(/\/$/, ''),
    facebook: get('artist_facebook').replace(/^https?:\/\/(www\.)?/, ''), tiktok: get('artist_tiktok').replace(/^https?:\/\/(www\.)?/, ''),
    amount: v.amount !== '' && v.amount != null && !isNaN(+v.amount) ? money(+v.amount) : (v.amount || ''), to: v.to || '', from: v.from || '', code: v.code || '',
    expires: v.expires ? new Date(v.expires + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '',
    title: v.title || '', placement: v.placement || '',
    // Tags become hashtags: "fine line, floral" -> "#fineline #floral"
    tags: String(v.tags || '').split(',').map(t => t.trim().replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean).map(t => '#' + t.toLowerCase()).join(' '),
    date: v.date ? new Date(v.date + 'T00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '' };
  return String(s || '').replace(/\{(\w+)\}/g, (m, k) => k in map ? map[k] : m);
}
const dzFontStr = (doc, l, px) => `${l.it ? 'italic ' : ''}${l.b ? 700 : 400} ${px}px "${dzFont(doc, l.font)}", Inter, sans-serif`;
function dzWrap(x, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/(\s+)/)) {
      const t = line + w;
      if (x.measureText(t.trimEnd()).width > maxW && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); } else line = t;
    }
    out.push(line.trimEnd());
  }
  return out;
}
// Text case (small caps are drawn by the canvas itself).
const dzCase = (l, s) => l.caps === 'upper' ? s.toUpperCase() : l.caps === 'lower' ? s.toLowerCase() : l.caps === 'title' ? s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase()) : s;
// Like dzWrap for one paragraph, with a width that can differ per line (indents, drop caps).
function dzWrapW(x, para, widthAt) {
  const out = []; let line = '';
  for (const w of para.split(/(\s+)/)) { const n = line + w;
    if (x.measureText(n.trimEnd()).width > widthAt(out.length) && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); } else line = n; }
  out.push(line.trimEnd()); return out;
}
// Vertical text: upright letters top to bottom, columns left to right. In a frame, words wrap at the frame's height.
function dzVertLay(x, doc, l, txt) {
  const pad = l.frame ? l.pad || 0 : 0, iw = l.w - pad * 2, ih = (l.h || 1) - pad * 2; let px = l.size;
  for (;;) { x.font = dzFontStr(doc, l, px); const adv = px * 1.05 + (l.ls || 0) * (px / l.size), colw = px * (l.lh || 1.2), cols = [];
    for (const para of txt.split('\n')) { if (!l.frame) { cols.push([...para]); continue; }
      const max = Math.max(1, Math.floor(ih / adv)); let cur = [];
      for (const w of para.split(/(\s+)/)) { let ch = [...w]; if (cur.length + ch.length > max && cur.length) { cols.push(cur); cur = []; if (!w.trim()) ch = []; }
        while (ch.length > max) { cols.push(ch.slice(0, max)); ch = ch.slice(max); } cur.push(...ch); }
      cols.push(cur); }
    const fits = cols.length * colw <= iw + 0.5;
    if (!l.frame || !l.fit || fits || px <= 8) { const shown = l.frame ? cols.slice(0, Math.max(1, Math.floor((iw + 0.5) / colw))) : cols;
      return { v: true, px, adv, colw, pad, cols: shown, over: shown.length < cols.length }; }
    px *= 0.94; }
}
/* Frame text: lines laid out inside a fixed box, in one or more columns. Paragraphs wrap separately, with their own
   spacing, indents, bullets and an optional drop cap; lines that don't fit are held back (over = true) until the frame
   is made bigger or the letters smaller. */
function dzFrameLay(x, doc, l, txt) {
  if (l.vert) return dzVertLay(x, doc, l, txt);
  const pad = l.pad || 0, n = Math.max(1, l.cols || 1), ih = Math.max(1, (l.h || 1) - pad * 2);
  const gut = n > 1 ? (l.gut ?? l.size) : 0, cw = Math.max(10, (l.w - pad * 2 - gut * (n - 1)) / n);
  let px = l.size, rows, over, drop, hs;
  for (;;) {
    x.font = dzFontStr(doc, l, px); const k = px / l.size, lh = px * (l.lh || 1.2), gap = (l.ps || 0) * k, ind1 = (l.ind1 || 0) * k, indl = (l.indl || 0) * k, indr = (l.indr || 0) * k, hang = l.list ? px * 1.5 : 0;
    rows = []; over = false; drop = null; hs = Array(n).fill(0); let col = 0, y = 0, num = 0;
    const paras = txt.split('\n');
    paras.forEach((para, p) => { let body = para, dw = 0, dn = 0;
      if (!p && l.drop >= 2 && !l.list && para.trim()) { const ch = [...para][0], dpx = ((l.drop - 1) * lh + px * 0.72) / 0.72; x.font = dzFontStr(doc, l, dpx); dw = x.measureText(ch).width + px * 0.25; x.font = dzFontStr(doc, l, px);
        drop = { ch, dpx, x: indl, y: (l.drop - 1) * lh + px * 0.9 }; dn = l.drop; body = para.slice(ch.length); }
      const widthAt = (i) => Math.max(10, cw - indl - indr - hang - (!i ? ind1 : 0) - (i < dn ? dw : 0));
      const mark = l.list && para.trim() ? (l.list === 'num' ? ++num + '.' : '•') : '';
      dzWrapW(x, body, widthAt).forEach((s, i, L) => {
        if (y + lh > ih + 0.5 && rows.length) { if (col < n - 1) { col++; y = 0; } else over = true; }
        if (over) return;
        rows.push({ s, y, col, x: indl + hang + (!i ? ind1 : 0) + (i < dn ? dw : 0), w: widthAt(i), end: i === L.length - 1, mark: !i ? mark : '', mx: indl }); y += lh; hs[col] = y; });
      if (p < paras.length - 1 && y) y += gap; });
    if (!l.fit || !over || px <= 8) break; px *= 0.94;
  }
  const off = (c) => l.va === 'middle' ? (ih - hs[c]) / 2 : l.va === 'bottom' ? ih - hs[c] : 0;
  return { px, lh: px * (l.lh || 1.2), rows, cw, gut, pad, over, drop, top: hs.map((_, c) => -l.h / 2 + pad + off(c)) };
}
function dzStar(x, cx, cy, r) {
  x.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
  x.closePath();
}
/* Fills beyond a plain colour (shapes and text): l.fm = 'grad' uses l.grad, 'tex' uses l.tex.
   Gradient: { type: 'linear' | 'radial', ang (degrees, linear), sz (radial size), stops: [{ c, p }] } with 2 to 5
   colours at positions 0..1. Texture: a repeating picture { ref, ts (tile size, % of the shorter side), rot, fx, fy }.
   Drawn in the layer's own space (centred on 0, 0), so they turn and flip with the layer. */
function dzPaint(x, doc, L, tex) {
  const w = L.w, h = L.h || 1;
  if (L.fm === 'grad' && L.grad?.stops?.length) {
    const g = L.grad;
    let gr;
    if (g.type === 'radial') gr = x.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, Math.hypot(w, h) / 2 * (g.sz ?? 1)));
    else { const a = (g.ang ?? 90) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), e = Math.abs(w / 2 * c) + Math.abs(h / 2 * sn) || 1;
      gr = x.createLinearGradient(-c * e, -sn * e, c * e, sn * e); }
    for (const st of [...g.stops].sort((a, b) => a.p - b.p)) gr.addColorStop(Math.max(0, Math.min(1, st.p)), dzCol(doc, st.c) || '#000');
    return gr;
  }
  if (L.fm === 'tex' && tex) {
    const t = L.tex, pt = x.createPattern(tex, 'repeat'), sc = Math.max(1, Math.min(w, h)) * (t.ts || 40) / 100 / (tex.naturalWidth || 1);
    pt.setTransform(new DOMMatrix().rotate(t.rot || 0).scale(sc * (t.fx ? -1 : 1), sc * (t.fy ? -1 : 1)));
    return pt;
  }
  return null;
}
/* Picture to shape: traces the outline of a picture into a shape that takes any fill. See-through pictures
   use their see-through parts as the outside; pictures without any use dark = inside (a black silhouette on
   white). Colours and shading inside are dropped: only the outline is kept. Result: loops of points (0..1 of
   the traced area, alternating x, y) and that area within the picture (fractions), or null if nothing found. */
function dzTrace(im) {
  const nw = im.naturalWidth || im.width, nh = im.naturalHeight || im.height, t = Math.min(1, 600 / Math.max(nw, nh));
  const W = Math.max(1, Math.round(nw * t)), H = Math.max(1, Math.round(nh * t)), c = document.createElement('canvas'); c.width = W; c.height = H;
  const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(im, 0, 0, W, H);
  const px = cx.getImageData(0, 0, W, H).data, m = new Uint8Array(W * H);
  let alpha = false; for (let i = 3; i < px.length; i += 4) if (px[i] < 200) { alpha = true; break; }
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, on = alpha ? px[i + 3] >= 128 : (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) < 128;
    if (on) { m[y * W + x] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] === 1;
  // Edges between inside and outside pixels, each going clockwise round the inside; joined into loops.
  const out = new Map(), key = (x, y) => y * (W + 1) + x, addE = (ax, ay, bx, by) => { const k = key(ax, ay); (out.get(k) || out.set(k, []).get(k)).push(key(bx, by)); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) {
    if (!inside(x, y - 1)) addE(x, y, x + 1, y);
    if (!inside(x + 1, y)) addE(x + 1, y, x + 1, y + 1);
    if (!inside(x, y + 1)) addE(x + 1, y + 1, x, y + 1);
    if (!inside(x - 1, y)) addE(x, y + 1, x, y);
  }
  // Fewer points: drop those within `eps` px of the straight line between their neighbours.
  const simplify = (pts, eps) => {
    const n = pts.length; if (n < 8) return pts;
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const st = [[0, n - 1]];
    while (st.length) { const [a, b] = st.pop(); let dm = 0, im2 = -1;
      const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay);   // a closed loop starts and ends on one point
      for (let i = a + 1; i < b; i++) { const d = L > 1e-9 ? Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L : Math.hypot(pts[i][0] - ax, pts[i][1] - ay); if (d > dm) { dm = d; im2 = i; } }
      if (dm > eps) { keep[im2] = 1; st.push([a, im2], [im2, b]); } }
    return pts.filter((_, i) => keep[i]);
  };
  const loops = [], bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  for (const [k0] of out) {
    let k = k0; const pts = [];
    while (out.get(k)?.length) { const nx = out.get(k).pop(); pts.push([k % (W + 1), Math.floor(k / (W + 1))]); k = nx; if (k === k0) break; }
    if (pts.length < 4) continue;
    let area = 0; for (let i = 0; i < pts.length; i++) { const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length]; area += ax * by - bx * ay; }
    if (Math.abs(area) / 2 < 6) continue;   // specks
    pts.push(pts[0]); const sp = simplify(pts, 0.9); sp.pop();
    loops.push(sp.flatMap(([x, y]) => [+((x - x0) / bw).toFixed(4), +((y - y0) / bh).toFixed(4)]));
  }
  return loops.length ? { loops, box: { x: x0 / W, y: y0 / H, w: bw / W, h: bh / H } } : null;
}
/* ---------- Vector shapes ----------
   The same node model as the drawing board this is modelled on: a shape is subpaths ({ closed, nodes }) of nodes
   { x, y, ix, iy, ox, oy, t } where x, y are fractions of the shape's box (0..1), ix/iy and ox/oy are the curve
   handles coming in and going out (also box fractions, relative to the node), and t is 'corner', 'smooth'
   (handles in line) or 'sym' (in line and the same length). Filled even-odd, so an inner loop is a hole.
   Shape kinds with settings (polygon sides, star points...) are generated; 'Edit nodes' turns any shape into a
   plain node path ('vec'). */
const dzNd = (x, y, ix = 0, iy = 0, ox = 0, oy = 0, t = 'corner') => ({ x, y, ix, iy, ox, oy, t });
const dzK = 0.5523 / 2;   // circle handle length, as a fraction of the box
// The real extent of an outline (points along each curve, not its handles). G(n) gives a node's absolute x, y and handles.
const dzCurveBox = (subs, G) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const put = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const sp of subs) { const N = sp.nodes, segs = sp.closed === false ? N.length - 1 : N.length; if (N.length === 1) { const a = G(N[0]); put(a.x, a.y); }
    for (let i = 0; i < segs; i++) { const a = G(N[i]), b = G(N[(i + 1) % N.length]), X = [a.x, a.x + a.ox, b.x + b.ix, b.x], Y = [a.y, a.y + a.oy, b.y + b.iy, b.y];
      for (let q = 0; q <= 24; q++) { const t = q / 24, u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t; put(w0 * X[0] + w1 * X[1] + w2 * X[2] + w3 * X[3], w0 * Y[0] + w1 * Y[1] + w2 * Y[2] + w3 * Y[3]); } } }
  return { x0, y0, x1, y1 }; };
const dzPoly = (pts) => [{ closed: true, nodes: pts.map(([x, y]) => dzNd(x, y)) }];
// Stretches subpaths so they exactly fill the box (0..1 both ways).
function dzFit01(subs) {
  const xs = [], ys = []; for (const sp of subs) for (const n of sp.nodes) { xs.push(n.x); ys.push(n.y); }
  const x0 = Math.min(...xs), y0 = Math.min(...ys), sx = (Math.max(...xs) - x0) || 1, sy = (Math.max(...ys) - y0) || 1;
  return subs.map(sp => ({ closed: sp.closed, nodes: sp.nodes.map(n => ({ ...n, x: (n.x - x0) / sx, y: (n.y - y0) / sy, ix: n.ix / sx, iy: n.iy / sy, ox: n.ox / sx, oy: n.oy / sy })) }));
}
const dzRing = (n, r, ph = -Math.PI / 2) => [...Array(n)].map((_, i) => { const a = ph + i * 2 * Math.PI / n; return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]; });
const dzCircle = (r = 0.5, rev = false) => { const k = dzK * r * 2, N = [dzNd(0.5, 0.5 - r, -k, 0, k, 0, 'sym'), dzNd(0.5 + r, 0.5, 0, -k, 0, k, 'sym'), dzNd(0.5, 0.5 + r, k, 0, -k, 0, 'sym'), dzNd(0.5 - r, 0.5, 0, k, 0, -k, 'sym')];
  return { closed: true, nodes: rev ? N.reverse().map(n => ({ ...n, ix: n.ox, iy: n.oy, ox: n.ix, oy: n.iy })) : N }; };
const DZ_GEN = {
  poly: (L) => dzFit01(dzPoly(dzRing(Math.max(3, L.n || 6), 0.5))),
  star: (L) => { const n = Math.max(3, L.n || 5), r2 = L.inner ?? 0.45, pts = [];
    for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + i * Math.PI / n, r = i % 2 ? 0.5 * r2 : 0.5; pts.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]); }
    return dzFit01(dzPoly(pts)); },
  tri: () => dzPoly([[0.5, 0], [1, 1], [0, 1]]),
  heart: () => [{ closed: true, nodes: [dzNd(0.5, 1, 0.2, -0.15, -0.2, -0.15), dzNd(0, 0.3, 0, 0.25, 0, -0.18, 'smooth'), dzNd(0.25, 0, -0.14, 0, 0.14, 0, 'smooth'),
    dzNd(0.5, 0.2, 0, -0.12, 0, -0.12), dzNd(0.75, 0, -0.14, 0, 0.14, 0, 'smooth'), dzNd(1, 0.3, 0, -0.18, 0, 0.25, 'smooth')] }],
  arrow: (L) => { const t = (L.th ?? 0.4) / 2; return dzPoly([[0, 0.5 - t], [0.6, 0.5 - t], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.5 + t], [0, 0.5 + t]]); },
  cross: (L) => { const a = 0.5 - (L.th ?? 0.34) / 2, b = 1 - a;
    return dzPoly([[a, 0], [b, 0], [b, a], [1, a], [1, b], [b, b], [b, 1], [a, 1], [a, b], [0, b], [0, a], [a, a]]); },
  bubble: () => dzPoly([[0, 0], [1, 0], [1, 0.75], [0.45, 0.75], [0.22, 1], [0.27, 0.75], [0, 0.75]]),
  ring: (L) => [dzCircle(0.5), dzCircle(0.5 * (L.inner ?? 0.6), true)],
  ellipse: () => [dzCircle(0.5)],
  rect: (L) => { const r = Math.min(L.r || 0, L.w / 2, (L.h || 1) / 2); if (!r) return dzPoly([[0, 0], [1, 0], [1, 1], [0, 1]]);
    const rx = r / L.w, ry = r / L.h, kx = rx * 0.5523, ky = ry * 0.5523;
    return [{ closed: true, nodes: [dzNd(rx, 0, -kx, 0, 0, 0), dzNd(1 - rx, 0, 0, 0, kx, 0), dzNd(1, ry, 0, -ky, 0, 0), dzNd(1, 1 - ry, 0, 0, 0, ky),
      dzNd(1 - rx, 1, kx, 0, 0, 0), dzNd(rx, 1, 0, 0, -kx, 0), dzNd(0, 1 - ry, 0, ky, 0, 0), dzNd(0, ry, 0, 0, 0, -ky)] }]; },
  path: (L) => (L.path || []).map(lp => {   // a traced outline: its smoothed curve, as nodes
    const n = lp.length / 2, P = (i) => [lp[(i % n) * 2], lp[(i % n) * 2 + 1]], nodes = [];
    for (let i = 0; i < n; i++) { const a = P(i), b = P(i + 1), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      nodes.push(dzNd(m[0], m[1], (a[0] - m[0]) * 2 / 3, (a[1] - m[1]) * 2 / 3, (b[0] - m[0]) * 2 / 3, (b[1] - m[1]) * 2 / 3, 'smooth')); }
    return { closed: true, nodes };
  })
};
/* The clipping library (Clipper, kept in lib/ so it works offline), loaded the first time a shape is combined or
   contoured. It counts in whole numbers, so page pixels are scaled up by DZ_CS. A failure isn't remembered, so the
   next try loads it again. */
const DZ_CS = 100;
let dzClipLoad = null;
function dzClipper() {
  if (window.ClipperLib) return Promise.resolve();
  return dzClipLoad ||= new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'lib/clipper.js';
    sc.onload = () => { if (window.ClipperLib) res(); else { dzClipLoad = null; rej(new Error('the shape library did not start')); } };
    sc.onerror = () => { dzClipLoad = null; rej(new Error('the shape library could not be loaded')); };
    document.head.appendChild(sc);
  });
}
/* Editor icons (24 px grid, drawn as strokes). Every icon button has its name in a tooltip. */
const DZ_UI = {
  selbox: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2"/>', selell: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke-dasharray="3 2"/>',
  sellasso: '<path d="M5 9c0-3 3.1-5 7-5s7 2 7 5-3.1 5-7 5c-1.2 0-2.3-.2-3.3-.5" stroke-dasharray="3 2"/><path d="M6 13c-1.3.8-1.7 2.4-.8 3.6.9 1.2 2.6 1.4 3.6.5"/>',
  selpen: '<path d="M12 19l7-7-3-3-7 7-1 4z"/><path d="M15 6l3 3M4 20l4-1"/>', selcol: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/>',
  select: '<path d="M6 3l13 8-6 1.5L10 19z"/>', text: '<path d="M5 7V4h14v3M12 4v16M9 20h6"/>', heading: '<path d="M6 4v16M18 4v16M6 12h12"/>',
  picture: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 8"/>',
  shape: '<rect x="3" y="10" width="11" height="11" rx="1.5"/><circle cx="15.5" cy="8.5" r="5.5"/>',
  pen: '<path d="M12 21v-4M12 17l-6-7 6-7 6 7z"/><circle cx="12" cy="10" r="1.3"/>', pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  field: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>', logo: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/>',
  device: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>', portfolio: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  refs: '<path d="M6 3h12v18l-6-4-6 4z"/>', layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 17l9 5 9-5" opacity=".5"/>',
  page: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  del: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  fwd: '<path d="M5 4h14M12 20V9M7 13l5-5 5 5"/>', back: '<path d="M5 20h14M12 4v11M7 11l5 5 5-5"/>',
  fx: '<path d="M12 3v18M8 7l-5 5 5 5zM16 7l5 5-5 5z"/>', fy: '<path d="M3 12h18M7 8l5-5 5 5zM7 16l5 5 5-5z"/>',
  clip: '<path d="M7 4v10a3 3 0 0 0 3 3h10"/><path d="M16 13l4 4-4 4"/>', crop: '<path d="M6 2v16h16M2 6h16v16"/>',
  area: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 3"/>',
  nodes: '<path d="M5 18C7 7 17 7 19 18"/><rect x="3" y="16" width="4" height="4"/><rect x="17" y="16" width="4" height="4"/><rect x="10" y="6" width="4" height="4"/>',
  toshape: '<path d="M12 3l9 9-9 9-9-9z"/>', flatten: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  pick: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M13 7h8M17 3v8"/>',
  svg: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M9.5 17.5c1-4 2.5-6 5-6.5"/><circle cx="9.5" cy="17.5" r="1"/><circle cx="14.5" cy="11" r="1"/>',
  stencil: '<path d="M4 20c4-1 6-5 8-9s5-6 8-7"/><path d="M4 4l16 16" stroke-dasharray="2 3"/>',
  asset: '<path d="M12 3l2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8z"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>', chev: '<path d="M6 9l6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  export: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v7h14v-7"/>', tpl: '<path d="M6 3h12v18l-6-4-6 4z"/><path d="M12 7v6M9 10h6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 6.1A9 9 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.6 6.6C3.8 8.3 2 12 2 12s4 7 10 7a9 9 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  all: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2.5"/><path d="M8 12l3 3 5-6"/>', none: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
  merge: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M12 14v7M9 18l3 3 3-3"/>', png: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 19h14"/>',
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>', link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  frametext: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 2"/><path d="M8 9h8M8 12h8M8 15h5"/>', ajust: '<path d="M4 6h16M4 10h16M4 14h16M4 18h9"/>', vtop: '<path d="M4 4h16M12 20V9M8 12l4-4 4 4"/>', vmid: '<path d="M4 12h16M12 3v5M12 21v-5M9 6l3 2 3-2M9 18l3-2 3 2"/>', vbot: '<path d="M4 20h16M12 4v11M8 12l4 4 4-4"/>',
  aleft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>', acenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>', aright: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  s_rect: '<rect x="4" y="4" width="16" height="16"/>', s_round: '<rect x="4" y="4" width="16" height="16" rx="5"/>', s_ellipse: '<circle cx="12" cy="12" r="8.5"/>',
  s_tri: '<path d="M12 4l9 16H3z"/>', s_poly: '<path d="M12 3l8 5v8l-8 5-8-5V8z"/>', s_star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  s_heart: '<path d="M12 20s-8-5-8-11a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 6-8 11-8 11z"/>', s_arrow: '<path d="M3 9h11V5l7 7-7 7v-4H3z"/>',
  s_cross: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>', s_bubble: '<path d="M4 5h16v10H10l-5 4v-4H4z"/>',
  s_ring: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/>', s_line: '<path d="M4 20L20 4"/>', s_frame: '<rect x="3" y="3" width="18" height="18"/><rect x="7.5" y="7.5" width="9" height="9"/>'
};
const dzIB = (attr, ic, tip, cls = '') => `<button class="dz-ib ${cls}" ${attr} data-tip="${tip}" aria-label="${tip}"><svg viewBox="0 0 24 24">${DZ_UI[ic] || ic}</svg></button>`;
const DZ_SHAPES = [['rect', 'Square'], ['round', 'Rounded square'], ['ellipse', 'Circle'], ['tri', 'Triangle'], ['poly', 'Polygon'], ['star', 'Star'], ['heart', 'Heart'], ['arrow', 'Arrow'], ['cross', 'Cross'], ['bubble', 'Speech bubble'], ['ring', 'Ring'], ['line', 'Line'], ['frame', 'Frame']];
const DZ_BOOL_ICON = Object.fromEntries(Object.entries({
  add: '<path d="M3 3h7v4h4v7H7v-4H3z"/>', subtract: '<path d="M3 3h10v10H3z" class="g"/><path d="M3 3h10v4H7v6H3z"/>',
  intersect: '<rect x="2" y="2" width="8" height="8" class="g"/><rect x="6" y="6" width="8" height="8" class="g"/><path d="M6 6h4v4H6z"/>',
  xor: '<path d="M2 2h8v4H6v4H2z"/><path d="M14 14H6v-4h4V6h4z"/>', divide: '<rect x="2" y="2" width="8" height="8"/><rect x="6" y="6" width="8" height="8"/>',
  separate: '<rect x="1.5" y="1.5" width="5" height="5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M8 3v2M8 11v2M3 8h2M11 8h2" class="g"/>',
  contour: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/><rect x="1.5" y="1.5" width="13" height="13" rx="3" class="g"/>',
  simp: '<path class="g" d="M1.5 12l2-4 1.5 2 2-5 1.5 3 2-4 1.5 3 2.5-4"/><path d="M1.5 12C5 3 11 3 14.5 9"/>'
}).map(([kk, v]) => [kk, `<svg viewBox="0 0 16 16" class="dz-bi">${v}</svg>`]));
/* ---------- Hold to snap, and fitting a drawn stroke ----------
   dzGuess reads a rough stroke (page points) as a line, circle, ellipse, rectangle, triangle or polygon, the way
   the drawing board's hold-to-snap does: each candidate is scored by how far the stroke strays from it (as a
   fraction of the stroke's size), with a small charge for the fussier ones, and the best wins if it's close
   enough. Results are page-space subpaths of nodes (handles relative to their node). */
const dzP = (x, y, ix = 0, iy = 0, ox = 0, oy = 0, t = 'corner') => ({ x, y, ix, iy, ox, oy, t });
function dzSample(subs, per = 40) {
  const out = [];
  for (const sp of subs) { const N = sp.nodes, n = N.length, last = sp.closed ? n : n - 1;
    for (let i = 0; i < last; i++) { const a = N[i], b = N[(i + 1) % n];
      for (let s2 = 0; s2 <= per; s2++) { const t = s2 / per, u = 1 - t;
        out.push({ x: u * u * u * a.x + 3 * u * u * t * (a.x + a.ox) + 3 * u * t * t * (b.x + b.ix) + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * (a.y + a.oy) + 3 * u * t * t * (b.y + b.iy) + t * t * t * b.y }); } } }
  return out;
}
function dzEllipseSubs(cx, cy, a, b, rot) {
  const c = Math.cos(rot), s2 = Math.sin(rot), R = (x, y) => [x * c - y * s2, x * s2 + y * c], ka = a * 0.5523, kb = b * 0.5523;
  const mk = (px, py, ix, iy, ox, oy) => { const [X, Y] = R(px, py), [IX, IY] = R(ix, iy), [OX, OY] = R(ox, oy); return dzP(cx + X, cy + Y, IX, IY, OX, OY, 'sym'); };
  return [{ closed: true, nodes: [mk(a, 0, 0, -kb, 0, kb), mk(0, b, ka, 0, -ka, 0), mk(-a, 0, 0, kb, 0, -kb), mk(0, -b, -ka, 0, ka, 0)] }];
}
function dzRdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
  while (st.length) { const [a, b] = st.pop(); const A = pts[a], B = pts[b], L = Math.hypot(B.x - A.x, B.y - A.y); let dm = 0, im = -1;
    for (let i = a + 1; i < b; i++) { const P = pts[i], d = L > 1e-9 ? Math.abs((B.x - A.x) * (A.y - P.y) - (A.x - P.x) * (B.y - A.y)) / L : Math.hypot(P.x - A.x, P.y - A.y); if (d > dm) { dm = d; im = i; } }
    if (dm > eps) { keep[im] = 1; st.push([a, im], [im, b]); } }
  return pts.filter((_, i) => keep[i]);
}
function dzGuess(raw) {
  if (!raw || raw.length < 6) return null;
  const xs = raw.map(q => q.x), ys = raw.map(q => q.y), x0 = Math.min(...xs), y0 = Math.min(...ys), W = Math.max(...xs) - x0, H = Math.max(...ys) - y0, D = Math.hypot(W, H);
  if (D < 4) return null;
  let len = 0; for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
  const gap = Math.hypot(raw.at(-1).x - raw[0].x, raw.at(-1).y - raw[0].y), closed = gap < D * 0.25 && len > D * 1.6;
  const probe = raw.filter((_, i) => i % Math.max(1, Math.floor(raw.length / 120)) === 0);
  const err = (subs) => { const S = dzSample(subs, 30); let t = 0; for (const q of probe) { let m = Infinity; for (const r of S) { const d = (r.x - q.x) ** 2 + (r.y - q.y) ** 2; if (d < m) m = d; } t += Math.sqrt(m); } return t / probe.length / D; };
  const cands = [], push = (label, subs, pen, gen) => cands.push({ label, subs, gen, e: err(subs) + pen });
  const tidy = (deg, step = 15, tol = 4) => { const n = Math.round(deg / step) * step; return Math.abs(deg - n) < tol ? n : deg; };
  if (!closed && len < gap * 1.35) {   // a line, if the stroke went one way
    let A = raw[0], B = raw.at(-1); const ang = Math.atan2(B.y - A.y, B.x - A.x) * 180 / Math.PI, near = tidy(ang, 15, 2.5);
    if (near !== ang) { const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, h = Math.hypot(B.x - A.x, B.y - A.y) / 2, a2 = near * Math.PI / 180; A = { x: mx - Math.cos(a2) * h, y: my - Math.sin(a2) * h }; B = { x: mx + Math.cos(a2) * h, y: my + Math.sin(a2) * h }; }
    push('Line', [{ closed: false, nodes: [dzP(A.x, A.y), dzP(B.x, B.y)] }], 0);
  }
  if (closed) {
    let cx = 0, cy = 0; for (const q of raw) { cx += q.x; cy += q.y; } cx /= raw.length; cy /= raw.length;
    const r = raw.reduce((t, q) => t + Math.hypot(q.x - cx, q.y - cy), 0) / raw.length;
    push('Circle', dzEllipseSubs(cx, cy, r, r, 0), 0.002);
    // the stroke's own axes (principal directions) for the rectangle and the ellipse
    let sxx = 0, syy = 0, sxy = 0; for (const q of raw) { const dx = q.x - cx, dy = q.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    let th = 0.5 * Math.atan2(2 * sxy, sxx - syy); th = tidy(th * 180 / Math.PI, 90, 6) * Math.PI / 180;
    const c = Math.cos(th), s2 = Math.sin(th); let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of raw) { const u = (q.x - cx) * c + (q.y - cy) * s2, v = -(q.x - cx) * s2 + (q.y - cy) * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2, ecx = cx + mu * c - mv * s2, ecy = cy + mu * s2 + mv * c;
    let a = (u1 - u0) / 2, b = (v1 - v0) / 2; if (Math.abs(a - b) / Math.max(a, b) < 0.06) a = b = (a + b) / 2;
    const P = (u, v) => dzP(ecx + u * c - v * s2, ecy + u * s2 + v * c);
    push(a === b ? 'Square' : 'Rectangle', [{ closed: true, nodes: [P(-a, -b), P(a, -b), P(a, b), P(-a, b)] }], 0.004, { k: 'rect', cx: ecx, cy: ecy, a, b, th });
    push('Ellipse', dzEllipseSubs(ecx, ecy, a * 0.97, b * 0.97, th), 0.007, { k: 'ell', cx: ecx, cy: ecy, a: a * 0.97, b: b * 0.97, th });
    // corners: the closed loop simplified until only its turns are left
    const loop = dzRdp([...raw, raw[0]], D * 0.06); loop.pop();
    const n = loop.length;
    if (n >= 3 && n <= 8) {
      let px = 0, py = 0; for (const q of loop) { px += q.x; py += q.y; } px /= n; py /= n;
      const rad = loop.map(q => Math.hypot(q.x - px, q.y - py)), R = rad.reduce((t, v) => t + v, 0) / n, off = Math.max(...rad.map(v => Math.abs(v - R)));
      if (n >= 5 && off / R < 0.1) { const a0 = Math.atan2(loop[0].y - py, loop[0].x - px);
        push(`${n}-sided`, [{ closed: true, nodes: [...Array(n)].map((_, i) => dzP(px + R * Math.cos(a0 + i * 2 * Math.PI / n), py + R * Math.sin(a0 + i * 2 * Math.PI / n))) }], 0.003 * n); }
      else push(n === 3 ? 'Triangle' : `${n}-sided`, [{ closed: true, nodes: loop.map(q => dzP(q.x, q.y)) }], 0.003 * n + (n === 4 ? 0.02 : 0), { k: 'poly' });
    }
  }
  if (!cands.length) return null;
  cands.sort((p1, p2) => p1.e - p2.e);
  return cands[0].e < 0.045 ? cands[0] : null;
}
/* A snapped shape made plainer by a fraction u (0..1): an ellipse toward a circle, a rectangle toward a square, a
   free polygon toward its regular form. Blended rather than switched, so the slider moves smoothly. */
function dzPlainer(g, u) {
  const G = g.gen; if (!G || !(u > 0)) return g; u = Math.min(1, u);
  if (G.k === 'rect' || G.k === 'ell') {
    const m = (G.a + G.b) / 2, a = G.a + (m - G.a) * u, b = G.b + (m - G.b) * u, even = Math.abs(a - b) < Math.max(a, b) * 0.004;
    if (G.k === 'ell') return { label: even ? 'Circle' : 'Ellipse', subs: dzEllipseSubs(G.cx, G.cy, a, b, G.th) };
    const c = Math.cos(G.th), s2 = Math.sin(G.th), P = (x, y) => dzP(G.cx + x * c - y * s2, G.cy + x * s2 + y * c);
    return { label: even ? 'Square' : 'Rectangle', subs: [{ closed: true, nodes: [P(-a, -b), P(a, -b), P(a, b), P(-a, b)] }] };
  }
  const n = g.subs[0].nodes; if (!g.subs[0].closed || n.length < 3) return g;
  let cx = 0, cy = 0; for (const q of n) { cx += q.x; cy += q.y; } cx /= n.length; cy /= n.length;
  let R = 0; for (const q of n) R += Math.hypot(q.x - cx, q.y - cy); R /= n.length;
  let ar = 0; for (let i = 0; i < n.length; i++) { const p = n[i], q = n[(i + 1) % n.length]; ar += p.x * q.y - q.x * p.y; }   // which way round, or it folds through itself
  const st = (ar < 0 ? -1 : 1) * 2 * Math.PI / n.length, a0 = Math.atan2(n[0].y - cy, n[0].x - cx);
  return { label: u > 0.98 ? `Regular ${n.length}-sided` : g.label, subs: [{ closed: true, nodes: n.map((q, i) => dzP(q.x + (cx + Math.cos(a0 + st * i) * R - q.x) * u, q.y + (cy + Math.sin(a0 + st * i) * R - q.y) * u)) }] };
}
/* A freehand stroke as nodes: thinned to within `tol` page px of what was drawn, sharp turns kept as corners,
   the rest smooth (handles along the line through the neighbours). */
function dzFitStroke(raw, tol, closed) {
  let pts = []; for (const q of raw) { const l = pts.at(-1); if (!l || Math.hypot(q.x - l.x, q.y - l.y) > tol * 0.3) pts.push(q); }
  if (closed && pts.length > 3 && Math.hypot(pts[0].x - pts.at(-1).x, pts[0].y - pts.at(-1).y) < tol * 3) pts.pop();
  if (pts.length < 2) return null;
  let P = dzRdp(closed ? [...pts, pts[0]] : pts, tol); if (closed) P.pop();
  if (P.length < 2) return null;
  const n = P.length, nodes = P.map(q => dzP(q.x, q.y));
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const a = P[(i - 1 + n) % n], b = P[i], c2 = P[(i + 1) % n];
    const t1 = Math.atan2(b.y - a.y, b.x - a.x), t2 = Math.atan2(c2.y - b.y, c2.x - b.x); let turn = Math.abs(t2 - t1); if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > 1.0) continue;   // a sharp turn stays a corner
    const tx = c2.x - a.x, ty = c2.y - a.y, tl = Math.hypot(tx, ty) || 1, li = Math.hypot(b.x - a.x, b.y - a.y) / 3, lo = Math.hypot(c2.x - b.x, c2.y - b.y) / 3;
    Object.assign(nodes[i], { ix: -tx / tl * li, iy: -ty / tl * li, ox: tx / tl * lo, oy: ty / tl * lo, t: 'smooth' });
  }
  return { closed: !!closed && n > 2, nodes };
}
/* ---------- Fitting curves to outlines ----------
   Ported from the drawing board this is modelled on. A dense outline (what combining, contouring and tracing
   give back) becomes a few smooth curves: corners and straight runs are found first, then each span between them
   gets one cubic, its handles solved by least squares and its timing corrected (Newton steps), and it is only
   split where it still strays further than the tolerance. Tolerances are in page pixels. */
const DZ_FIT_TOL = 0.5, DZ_CHORD = 0.3, DZ_FIT_CORNER = Math.cos(28 * Math.PI / 180), DZ_RUN_PX = 20;
const _fs = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), _fa = (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), _fm = (a, k2) => ({ x: a.x * k2, y: a.y * k2 }), _fd = (a, b) => a.x * b.x + a.y * b.y;
const _fn = (v) => { const l = Math.hypot(v.x, v.y); return l < 1e-12 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l }; };
const _fAt = (bz, t) => { const m = 1 - t; return { x: m * m * m * bz[0].x + 3 * m * m * t * bz[1].x + 3 * m * t * t * bz[2].x + t * t * t * bz[3].x, y: m * m * m * bz[0].y + 3 * m * m * t * bz[1].y + 3 * m * t * t * bz[2].y + t * t * t * bz[3].y }; };
function _fBez(pts, u, t1, t2) {
  const n = pts.length; let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < n; i++) { const t = u[i], m = 1 - t, b0 = m * m * m, b1 = 3 * m * m * t, b2 = 3 * m * t * t, b3 = t * t * t, a1 = _fm(t1, b1), a2 = _fm(t2, b2);
    c00 += _fd(a1, a1); c01 += _fd(a1, a2); c11 += _fd(a2, a2);
    const tmp = _fs(pts[i], { x: pts[0].x * (b0 + b1) + pts[n - 1].x * (b2 + b3), y: pts[0].y * (b0 + b1) + pts[n - 1].y * (b2 + b3) }); x0 += _fd(a1, tmp); x1 += _fd(a2, tmp); }
  const det = c00 * c11 - c01 * c01; let a = 0, b = 0;
  if (Math.abs(det) > 1e-12) { a = (x0 * c11 - x1 * c01) / det; b = (c00 * x1 - c01 * x0) / det; }
  const chord = Math.hypot(pts[n - 1].x - pts[0].x, pts[n - 1].y - pts[0].y);
  if (!(a > 1e-9) || !(b > 1e-9)) a = b = chord / 3;
  a = Math.min(a, chord); b = Math.min(b, chord);   // a handle longer than the chord lets the curve balloon between samples
  return [pts[0], _fa(pts[0], _fm(t1, a)), _fa(pts[n - 1], _fm(t2, b)), pts[n - 1]];
}
const _fParam = (pts) => { const u = [0]; for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)); const L = u.at(-1) || 1; return u.map(v => v / L); };
function _fGap(pts, bz, n) {   // walks the curve itself, to catch a bulge or sag between the sample points
  let worst = 0;
  for (let k2 = 1; k2 < n; k2++) { const q = _fAt(bz, k2 / n); let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1], vx = b.x - a.x, vy = b.y - a.y, L = vx * vx + vy * vy; let t = L < 1e-12 ? 0 : ((q.x - a.x) * vx + (q.y - a.y) * vy) / L; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(q.x - (a.x + vx * t), q.y - (a.y + vy * t)); if (d < best) best = d; }
    if (best > worst) worst = best; }
  return worst;
}
function _fErr(pts, u, bz) {
  let worst = 0, at = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) { const q = _fAt(bz, u[i]), d = Math.hypot(q.x - pts[i].x, q.y - pts[i].y); if (d > worst) { worst = d; at = i; } }
  const sag = _fGap(pts, bz, Math.max(24, Math.min(96, pts.length * 2))) - DZ_CHORD; if (sag > worst) worst = sag;
  return { err: worst, at };
}
const _fRe = (pts, u, bz) => u.map((t, i) => { const m = 1 - t;
  const d1 = { x: 3 * ((bz[1].x - bz[0].x) * m * m + 2 * (bz[2].x - bz[1].x) * m * t + (bz[3].x - bz[2].x) * t * t), y: 3 * ((bz[1].y - bz[0].y) * m * m + 2 * (bz[2].y - bz[1].y) * m * t + (bz[3].y - bz[2].y) * t * t) };
  const d2 = { x: 6 * ((bz[2].x - 2 * bz[1].x + bz[0].x) * m + (bz[3].x - 2 * bz[2].x + bz[1].x) * t), y: 6 * ((bz[2].y - 2 * bz[1].y + bz[0].y) * m + (bz[3].y - 2 * bz[2].y + bz[1].y) * t) };
  const q = _fAt(bz, t), df = { x: q.x - pts[i].x, y: q.y - pts[i].y }, den = d1.x * d1.x + d1.y * d1.y + df.x * d2.x + df.y * d2.y;
  return Math.abs(den) < 1e-12 ? t : Math.max(0, Math.min(1, t - (df.x * d1.x + df.y * d1.y) / den)); });
function _fFit(pts, t1, t2, tol, out, depth) {
  if (pts.length < 2) return;
  if (pts.length === 2) { const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) / 3; out.push([pts[0], _fa(pts[0], _fm(t1, d)), _fa(pts[1], _fm(t2, d)), pts[1]]); return; }
  let u = _fParam(pts), bz = _fBez(pts, u, t1, t2), { err, at } = _fErr(pts, u, bz);
  for (let k2 = 0; k2 < 4 && err > tol; k2++) { const u2 = _fRe(pts, u, bz), bz2 = _fBez(pts, u2, t1, t2), e2 = _fErr(pts, u2, bz2); if (e2.err >= err) break; u = u2; bz = bz2; err = e2.err; at = e2.at; }
  if (err <= tol || depth > 18) { out.push(bz); return; }
  const tc = _fn(_fs(pts[Math.min(at + 1, pts.length - 1)], pts[Math.max(at - 1, 0)]));
  _fFit(pts.slice(0, at + 1), t1, _fm(tc, -1), tol, out, depth + 1); _fFit(pts.slice(at), tc, t2, tol, out, depth + 1);
}
const _fStraight = (pts, tol) => { const a = pts[0], b = pts.at(-1), vx = b.x - a.x, vy = b.y - a.y, L = vx * vx + vy * vy;
  return pts.every(q => { let t = L < 1e-12 ? 0 : ((q.x - a.x) * vx + (q.y - a.y) * vy) / L; t = Math.max(0, Math.min(1, t)); return Math.hypot(q.x - (a.x + vx * t), q.y - (a.y + vy * t)) <= tol; }); };
// One closed ring of points -> one subpath of nodes (absolute positions, handles relative), curves and all.
function dzFitRing(ring, tol = DZ_FIT_TOL) {
  let pts = []; for (const q of ring) { const l = pts.at(-1); if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 1e-7) pts.push({ x: q.x, y: q.y }); }
  if (pts.length > 2 && Math.hypot(pts[0].x - pts.at(-1).x, pts[0].y - pts.at(-1).y) < 1e-7) pts.pop();
  if (pts.length < 3) return { closed: true, nodes: pts.map(q => dzP(q.x, q.y)) };
  const n = pts.length, turn = new Array(n);
  for (let i = 0; i < n; i++) turn[i] = _fd(_fn(_fs(pts[i], pts[(i - 1 + n) % n])), _fn(_fs(pts[(i + 1) % n], pts[i])));
  const cuts = new Set(); for (let i = 0; i < n; i++) if (turn[i] < DZ_FIT_CORNER) cuts.add(i);
  // straight runs, judged as runs (several segments, the same way, long enough) so jitter can't fake one
  const ang = [], segLen = []; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; ang[i] = Math.atan2(b.y - a.y, b.x - a.x); segLen[i] = Math.hypot(b.x - a.x, b.y - a.y); }
  const dA = (p1, q1) => { let d = p1 - q1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); };
  for (let i = 0; i < n;) { let j = i, len = 0;
    while (j - i < n) { const nx = (j + 1) % n; if (turn[nx] < DZ_FIT_CORNER || dA(ang[nx], ang[i]) > 0.5 * Math.PI / 180) break; len += segLen[j % n]; j++; }
    len += segLen[j % n]; if (j > i + 1 && len > DZ_RUN_PX) { cuts.add(i % n); cuts.add((j + 1) % n); } i = Math.max(j, i) + 1; }
  let corners = [...cuts].sort((a, b) => a - b);
  if (corners.length < 2) { const base = corners[0] || 0; corners = [0, 1, 2].map(k2 => (base + Math.round(k2 * n / 3)) % n).sort((a, b) => a - b); }
  const segs = [];
  for (let c = 0; c < corners.length; c++) {
    const i0 = corners[c], i1 = corners[(c + 1) % corners.length]; let span = [];
    for (let i = i0; ; i = (i + 1) % n) { span.push(pts[i]); if (i === i1) break; }
    if (span.length < 2) continue;
    const out = [];
    if (_fStraight(span, tol)) out.push([span[0], null, null, span.at(-1)]);
    else { if (span.length > 4) span = dzRdp(span, tol * 0.25); _fFit(span, _fn(_fs(span[1], span[0])), _fn(_fs(span.at(-2), span.at(-1))), tol, out, 0); }
    out.forEach((bz, k2) => segs.push({ bz, corner: k2 === 0 && turn[i0] < DZ_FIT_CORNER }));
  }
  if (!segs.length) return { closed: true, nodes: pts.map(q => dzP(q.x, q.y)) };
  const nodes = segs.map(sg => dzP(sg.bz[0].x, sg.bz[0].y, 0, 0, 0, 0, sg.corner ? 'corner' : 'smooth'));
  segs.forEach((sg, i) => { const a = nodes[i], b = nodes[(i + 1) % segs.length]; if (sg.bz[1]) { a.ox = sg.bz[1].x - a.x; a.oy = sg.bz[1].y - a.y; } if (sg.bz[2]) { b.ix = sg.bz[2].x - b.x; b.iy = sg.bz[2].y - b.y; } });
  return { closed: true, nodes };
}
// Points along a subpath (absolute nodes) from node a to node b, finely.
function dzSpanPts(sp, a, b, per = 24) {
  const N = sp.nodes, n = N.length, out = [{ x: N[a].x, y: N[a].y }];
  const cnt = sp.closed ? ((b - a + n) % n || n) : b - a;   // a === b on a closed ring: all the way round
  for (let c = 0, i = a; c < cnt; c++, i = (i + 1) % n) { const p0 = N[i], p1 = N[(i + 1) % n], bz = [p0, { x: p0.x + p0.ox, y: p0.y + p0.oy }, { x: p1.x + p1.ix, y: p1.y + p1.iy }, p1];
    for (let s2 = 1; s2 <= per; s2++) out.push(_fAt(bz, s2 / per)); }
  return out;
}
// Refits the nodes a..b (inclusive) between their fixed neighbours at a looser tolerance; returns how many went.
function dzSimplifyRun(sp, a, b, tol) {
  const n = sp.nodes.length; if (n < 3) return 0;
  const prev = sp.closed ? (a - 1 + n) % n : Math.max(0, a - 1), next = sp.closed ? (b + 1) % n : Math.min(n - 1, b + 1); if (prev === next) return 0;
  const pts = dzSpanPts(sp, prev, next); if (pts.length < 4) return 0;
  const segs = []; _fFit(pts, _fn(_fs(pts[1], pts[0])), _fn(_fs(pts.at(-2), pts.at(-1))), tol, segs, 0); if (!segs.length) return 0;
  const made = []; for (let q = 0; q < segs.length - 1; q++) { const P = segs[q][3], nd = dzP(P.x, P.y, segs[q][2].x - P.x, segs[q][2].y - P.y, segs[q + 1][1].x - P.x, segs[q + 1][1].y - P.y, 'smooth'); made.push(nd); }
  const old = b >= a ? b - a + 1 : 0; if (!old || made.length >= old) return 0;
  const pn = sp.nodes[prev], nn = sp.nodes[next];
  pn.ox = segs[0][1].x - pn.x; pn.oy = segs[0][1].y - pn.y; nn.ix = segs.at(-1)[2].x - nn.x; nn.iy = segs.at(-1)[2].y - nn.y;
  sp.nodes.splice(a, old, ...made); return old - made.length;
}
// The subpaths a shape draws with (null for the plain kinds drawn directly: line, box, circle, old traced).
const dzSubs = (L) => L.shape === 'vec' ? L.subs : DZ_GEN[L.shape] && !['ellipse', 'rect', 'path'].includes(L.shape) ? DZ_GEN[L.shape](L) : null;
function dzSubsTo(x, L, subs) {
  const X = (n, d = 0) => (n.x + d - 0.5) * L.w, Y = (n, d = 0) => (n.y + d - 0.5) * L.h;
  const seg = (a, b) => x.bezierCurveTo(X(a, a.ox), Y(a, a.oy), X(b, b.ix), Y(b, b.iy), X(b), Y(b));
  for (const sp of subs || []) { const N = sp.nodes; if (!N?.length) continue;
    x.moveTo(X(N[0]), Y(N[0])); for (let i = 1; i < N.length; i++) seg(N[i - 1], N[i]);
    if (sp.closed !== false) { seg(N.at(-1), N[0]); x.closePath(); } }
}
// A traced shape's outline, smoothed (curves through the midpoints), in the layer's own space.
function dzPathTo(x, L) {
  for (const lp of L.path || []) {
    const n = lp.length / 2, P = (i) => [(lp[(i % n) * 2] - 0.5) * L.w, (lp[(i % n) * 2 + 1] - 0.5) * L.h];
    if (n < 3) continue;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let s0 = mid(P(n - 1), P(0)); x.moveTo(s0[0], s0[1]);
    for (let i = 0; i < n; i++) { const p = P(i), q = mid(p, P(i + 1)); x.quadraticCurveTo(p[0], p[1], q[0], q[1]); }
    x.closePath();
  }
}
// A canvas cut down to its visible (not see-through) pixels, with where that part was; null if all see-through.
function dzTrim(c) {
  const W = c.width, H = c.height, d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) { const r = y * W * 4;
    for (let x = 0; x < W; x++) if (d[r + x * 4 + 3] > 3) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; } }
  if (x1 < 0) return null;
  if (!x0 && !y0 && x1 === W - 1 && y1 === H - 1) return { c, x: 0, y: 0 };
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1; o.getContext('2d').drawImage(c, -x0, -y0);
  return { c: o, x: x0, y: y0 };
}
// CSS for a gradient's colour bar (left to right).
const dzGradCss = (doc, g) => `linear-gradient(90deg, ${[...g.stops].sort((a, b) => a.p - b.p).map(st => `${dzCol(doc, st.c) || '#000'} ${Math.round(st.p * 1000) / 10}%`).join(', ')})`;
// Draws the design onto a canvas at `scale` (canvas px per page px). Text layers get their height measured.
// A link as it will be opened: https:// added where there's no scheme, and only web, mail and phone links allowed.
const dzLinkOK = (s) => { s = String(s || '').trim(); if (!s || /^https?:\/\/$/i.test(s)) return ''; if (/^(https?:|mailto:|tel:)/i.test(s)) return s; if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ''; if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'mailto:' + s; return 'https://' + s; };
const txt0 = (doc, l) => dzCase(l, dzFill(doc, l.text));
/* Text on a curve: a text layer with `on` set to a shape's id runs along that shape's outline (its first loop). Its box
   follows the shape; moving the text by any means moves the shape with it. Closed shapes run clockwise from the top so
   the words sit upright on the outside; open ones run left to right. */
const dzCurves = new WeakMap();
function dzCurve(S) {
  const d = dzSvgPath(S), first = d.slice(0, (d.slice(1).search(/M/) + 1) || d.length), el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', first); let len = 0; try { len = el.getTotalLength(); } catch {} if (!(len > 0)) return null;
  const n = Math.min(1500, Math.max(32, Math.ceil(len / 6))), a = (S.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a), cx = S.x + S.w / 2, cy = S.y + (S.h || 0) / 2, P = [];
  for (let i = 0; i <= n; i++) { const q = el.getPointAtLength(len * i / n); let u = q.x, v = q.y; if (S.fx) u = -u; if (S.fy) v = -v; P.push({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos }); }
  const closed = /z\s*$/i.test(first); let area = 0; for (let i = 0; i < n; i++) area += P[i].x * P[i + 1].y - P[i + 1].x * P[i].y;
  if (closed ? area < 0 : P[0].x > P[n].x) P.reverse();
  let top = 0; if (closed) P.forEach((q, i) => { if (q.y < P[top].y) top = i; });
  return { P, len, closed, top: top / n * len };
}
const dzCurveAt = (C, s) => { const n = C.P.length - 1; let f = s / C.len; if (C.closed) f = ((f % 1) + 1) % 1; else if (f < 0 || f > 1) return null;
  const i = Math.min(n - 1, Math.floor(f * n)), a = C.P[i], b = C.P[i + 1], u = f * n - i; return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, a: Math.atan2(b.y - a.y, b.x - a.x) }; };
function dzCurveSync(doc) { for (const l of doc.layers) { if (l.t !== 'text' || !l.on) continue; const S = doc.layers.find(o => o.id === l.on && o.t === 'shape'), C = S && dzCurve(S); if (!C) { dzCurves.delete(l); continue; }
    if (l._bx && (l.x !== l._bx.x || l.y !== l._bx.y)) { S.x += l.x - l._bx.x; S.y += l.y - l._bx.y; const C2 = dzCurve(S); if (C2) Object.assign(C, C2); }
    dzCurves.set(l, C); const pad = l.size * 1.2 + Math.abs(l.pb || 0), X = C.P.map(q => q.x), Y = C.P.map(q => q.y); l.x = Math.min(...X) - pad; l.y = Math.min(...Y) - pad; l.w = Math.max(...X) + pad - l.x; l.h = Math.max(...Y) + pad - l.y; l.rot = 0; l._bx = { x: l.x, y: l.y }; } }
async function dzDraw(cv, doc, scale = 1, opts = {}) {
  await DZF.all(doc); dzCurveSync(doc);
  const x = cv.getContext('2d'), W = doc.w * scale, H = doc.h * scale;
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
  if (!opts.noBg && !doc.pat?.clear) x.fillStyle = dzCol(doc, doc.bg?.c) || '#ffffff', x.fillRect(0, 0, W, H);
  if (doc.bg?.img && !opts.noBg) { const im = await dzImg(doc.bg.img);
    if (im) { const s = Math.max(W / im.naturalWidth, H / im.naturalHeight); x.globalAlpha = doc.bg.op ?? 1;
      x.drawImage(im, (W - im.naturalWidth * s) / 2, (H - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s); x.globalAlpha = 1; } }
  const one = async (x, l) => {
    const im = l.t === 'image' ? await dzImg(l.logo ? Settings.get('studio_logo_ref') : l.ref) : null;
    const tex = l.fm === 'tex' && l.tex?.ref ? await dzImg(l.tex.ref) : null;
    const nIco = l.t === 'shortcut' ? await dzIcoImg(l.svg || '', dzInkOn(doc)) : null; if (l.t === 'check') l.h = dzCheckH(l); if (l.t === 'field') l.h = dzFieldGeom(l, x, doc).h;
    let lines = null;
    if ('fontVariantCaps' in x) x.fontVariantCaps = l.t === 'text' && l.caps === 'small' ? 'small-caps' : 'normal';
    if (l.t === 'text') {   // measure first, so the box (and its centre) is the real height of the text
      x.setTransform(1, 0, 0, 1, 0, 0);
      if ('letterSpacing' in x) x.letterSpacing = (l.ls || 0) + 'px';
      // "Shrink to fit": a long name or amount gets smaller instead of wrapping onto a second line.
      const txt = dzCase(l, dzFill(doc, l.text)), want = l.fit ? txt.split('\n').length : Infinity;
      let px = l.size;
      if (dzCurves.has(l)) { l._arc = null; l._px = l.size; lines = []; }
      else if (l.frame) { l.h = Math.max(10, l.h || 10); const F = dzFrameLay(x, doc, l, txt); l._fr = F; l._over = F.over; l._arc = null; l._px = F.px; lines = F.rows || []; }
      else if (l.vert) { const F = dzVertLay(x, doc, l, txt); l._fr = F; l._arc = null; l._px = F.px; lines = []; l.w = Math.max(F.px, F.cols.length * F.colw); l.h = Math.max(F.px, Math.max(1, ...F.cols.map(c => c.length)) * F.adv); }
      else if (l.arc) {
        // Bent text: one line laid along a circle. The bend is the angle the text covers (up to a full circle).
        const one = txt.replace(/\s*\n\s*/g, ' '), chars = [...one], a = Math.min(360, Math.abs(l.arc)) * Math.PI / 180;
        let ws, wt, R;
        for (;;) {
          x.font = dzFontStr(doc, l, px); if ('letterSpacing' in x) x.letterSpacing = '0px';
          ws = chars.map(c => x.measureText(c).width + (l.ls || 0)); wt = ws.reduce((m, v) => m + v, 0) || 1; R = wt / a;
          const chord = a >= Math.PI ? 2 * R : 2 * R * Math.sin(a / 2);
          if (!l.fit || chord <= l.w || px <= 8) break; px *= 0.94;
        }
        l._arc = { chars, ws, wt, R }; lines = [one];
        l._px = px; l.h = R * (1 - Math.cos(a / 2)) + px * 1.15;
      } else {
        for (;;) { x.font = dzFontStr(doc, l, px); lines = dzWrap(x, txt, l.w); if (lines.length <= want || px <= 8) break; px *= 0.94; }
        l._arc = null; l._px = px; l.h = Math.max(px, lines.length * px * (l.lh || 1.2));
      }
    }
    x.save();
    x.setTransform(scale, 0, 0, scale, 0, 0);
    x.translate(l.x + l.w / 2, l.y + (l.h || 0) / 2); x.rotate((l.rot || 0) * Math.PI / 180);
    x.globalAlpha = l.op ?? 1;
    const flip = () => { if (l.fx || l.fy) x.scale(l.fx ? -1 : 1, l.fy ? -1 : 1); };   // mirrored
    if (l.t === 'shortcut' || l.t === 'check') { dzNoteDraw(x, l, doc, nIco); x.restore(); return; }
    if (l.t === 'field') { dzFieldDraw(x, doc, l, opts); x.restore(); return; }
    if (l.qr && l.qrbg && l.qrbg !== 'none') { x.fillStyle = dzCol(doc, l.qrbg); x.fillRect(-l.w / 2, -(l.h || 0) / 2, l.w, l.h || 0); }
    if (l.t === 'text') {
      flip();
      const px = l._px || l.size, lh = px * (l.lh || 1.2); x.font = dzFontStr(doc, l, px);
      if ('letterSpacing' in x) x.letterSpacing = (l.ls || 0) + 'px';
      x.fillStyle = (!l.arc && dzPaint(x, doc, l, tex)) || dzCol(doc, l.c) || '#000'; x.textBaseline = 'alphabetic';   // bent text: plain colour
      if (l.shc && l.shc !== 'none') { x.shadowColor = dzCol(doc, l.shc); x.shadowOffsetX = (l.shx ?? 6) * scale; x.shadowOffsetY = (l.shy ?? 6) * scale; x.shadowBlur = (l.shb ?? 8) * scale; }
      // One run of text: outline behind the fill, then underline and strikethrough (not on vertical text).
      const put = (s, ax, y) => { if (l.tsw && l.tsc && l.tsc !== 'none') { x.save(); x.lineJoin = 'round'; x.lineWidth = l.tsw; x.strokeStyle = dzCol(doc, l.tsc); x.strokeText(s, ax, y); x.restore(); }
        x.fillText(s, ax, y); if ((!l.u && !l.st) || l.vert || !s) return;
        const w = x.measureText(s).width, a0 = x.textAlign === 'center' ? ax - w / 2 : x.textAlign === 'right' ? ax - w : ax;
        if (l.u) x.fillRect(a0, y + px * 0.12, w, Math.max(1, px * 0.06)); if (l.st) x.fillRect(a0, y - px * 0.3, w, Math.max(1, px * 0.06)); };
      const onC = dzCurves.get(l);
      if (onC) {
        const chars = [...txt0(doc, l).replace(/\s*\n\s*/g, ' ')]; if ('letterSpacing' in x) x.letterSpacing = '0px'; x.textAlign = 'center';
        let C = onC; if (l.pflip) { C = { ...C, P: [...C.P].reverse(), top: C.len - C.top }; }
        const ws = chars.map(c => x.measureText(c).width + (l.ls || 0)), wt = ws.reduce((m, v) => m + v, 0), al = l.al || 'center', cx = l.x + l.w / 2, cy = l.y + l.h / 2;
        // Closed shapes: aligned around the top. Open lines: aligned along their length.
        const base = (C.closed ? C.top - (al === 'center' ? wt / 2 : al === 'right' ? wt : 0) : al === 'center' ? (C.len - wt) / 2 : al === 'right' ? C.len - wt : 0) + (l.pst || 0) / 100 * C.len;
        let at = base;
        chars.forEach((ch, i) => { const q = dzCurveAt(C, at + ws[i] / 2); at += ws[i]; if (!q || (C.closed && at - ws[i] / 2 > base + C.len)) return;
          const up = -(l.pb || 0); x.save(); x.translate(q.x - cx - Math.sin(q.a) * up, q.y - cy + Math.cos(q.a) * up); x.rotate(q.a); put(ch, 0, 0); x.restore(); });
      } else if (l.arc && l._arc) {
        // Each letter sits on the circle, turned to follow it: up = a rainbow over the centre, down = a smile under it.
        const { chars, ws, wt, R } = l._arc, up = l.arc > 0;
        if ('letterSpacing' in x) x.letterSpacing = '0px';
        x.textAlign = 'center';
        const cy = up ? -l.h / 2 + px * 0.9 + R : l.h / 2 - px * 0.25 - R;
        let at = -wt / 2;
        chars.forEach((ch, i) => {
          const phi = (at + ws[i] / 2) / R; at += ws[i];
          x.save();
          if (up) { x.translate(R * Math.sin(phi), cy - R * Math.cos(phi)); x.rotate(phi); }
          else { x.translate(R * Math.sin(phi), cy + R * Math.cos(phi)); x.rotate(-phi); }
          x.fillText(ch, 0, 0); x.restore();
        });
      } else if (l.vert && l._fr?.v) {
        const F = l._fr, room = l.h - F.pad * 2, al = l.al; x.textAlign = 'center'; x.textBaseline = 'middle';
        F.cols.forEach((c, i) => { const len = c.length * F.adv, y0 = -l.h / 2 + F.pad + (al === 'center' ? (room - len) / 2 : al === 'right' ? room - len : 0), cx = -l.w / 2 + F.pad + F.colw * (i + 0.5);
          c.forEach((ch, j) => put(ch, cx, y0 + (j + 0.5) * F.adv)); });
      } else if (l.frame) {
        const F = l._fr, al = l.al || 'left';
        if (F.drop) { const f0 = x.font; x.font = dzFontStr(doc, l, F.drop.dpx); x.textAlign = 'left'; put(F.drop.ch, -l.w / 2 + F.pad + F.drop.x, F.top[0] + F.drop.y); x.font = f0; }
        for (const r of F.rows) { const cl = -l.w / 2 + F.pad + r.col * (F.cw + F.gut), x0 = cl + r.x, y = F.top[r.col] + r.y + px * 0.9, ax = al === 'center' ? x0 + r.w / 2 : al === 'right' ? x0 + r.w : x0, W = r.s.split(/\s+/);
          if (r.mark) { x.textAlign = 'left'; put(r.mark, cl + r.mx, y); }
          x.textAlign = al === 'justify' ? 'left' : al;
          if (al === 'justify' && !r.end && W.length > 1) {   // the last line of a paragraph stays as it is
            const g = (r.w - W.reduce((s, w) => s + x.measureText(w).width, 0)) / (W.length - 1); let at = ax;
            for (const w of W) { put(w, at, y); at += x.measureText(w).width + g; }
          } else put(r.s, ax, y); }
      } else {
        x.textAlign = l.al || 'left';
        const ax = l.al === 'center' ? 0 : l.al === 'right' ? l.w / 2 : -l.w / 2;
        lines.forEach((ln, i) => put(ln, ax, -l.h / 2 + i * lh + px * 0.9));
      }
    } else {
      // Pictures and shapes. A crop shows part of the full picture or shape: `crop` is the kept part
      // (fractions of the whole); the box is that part, and the whole sits around it, clipped away.
      const body = (L) => {
        x.save(); flip();
        if (L.t === 'image') {
        const r = Math.min(L.r || 0, L.w / 2, L.h / 2), clip = L.cover || r;
        if (clip) { x.save(); x.beginPath(); x.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, r); x.clip(); }
        // cover = fill the box and crop the overflow (photos); otherwise the whole picture fits inside (logos, stickers).
        if (im) { const s = (L.cover ? Math.max : Math.min)(L.w / im.naturalWidth, L.h / im.naturalHeight), w = im.naturalWidth * s, h = im.naturalHeight * s;
          x.drawImage(im, -w / 2 + (L.cover ? (L.px || 0) * (w - L.w) / 2 : 0), -h / 2 + (L.cover ? (L.py || 0) * (h - L.h) / 2 : 0), w, h); }
        else if (L.slot != null) { x.fillStyle = 'rgba(128,128,128,.18)'; x.fillRect(-L.w / 2, -L.h / 2, L.w, L.h);
          x.fillStyle = 'rgba(128,128,128,.8)'; x.font = `600 ${Math.max(14, Math.min(L.w, L.h) * 0.08)}px Inter, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('Photo', 0, 0); }
        else if (L.logo) { x.strokeStyle = 'rgba(128,128,128,.6)'; x.setLineDash([10, 8]); x.lineWidth = 3; x.strokeRect(-L.w / 2, -L.h / 2, L.w, L.h); }
        if (clip) x.restore();
        const st = dzCol(doc, L.stroke);
        if (st && L.sw) { x.beginPath(); x.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, r); x.strokeStyle = st; x.lineWidth = L.sw; x.stroke(); }
      } else if (L.t === 'shape') {
        const f = dzCol(doc, L.fill), st = dzCol(doc, L.stroke), sw = L.sw || 0;
        x.beginPath();
        if (L.shape === 'ellipse') x.ellipse(0, 0, L.w / 2, L.h / 2, 0, 0, Math.PI * 2);
        else if (L.shape === 'line') { x.moveTo(-L.w / 2, 0); x.lineTo(L.w / 2, 0); }
        else if (L.shape === 'path') dzPathTo(x, L);
        else if (dzSubs(L)) dzSubsTo(x, L, dzSubs(L));
        else x.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, Math.min(L.r || 0, L.w / 2, L.h / 2));
        const pf = dzPaint(x, doc, L, tex);
        const dash = (w) => { if (L.dash === 'dash') x.setLineDash([w * 3, w * 2]); else if (L.dash === 'dot') { x.setLineDash([0, w * 2]); x.lineCap = 'round'; x.lineJoin = 'round'; } };   /* matches the SVG export */
        if (L.shape === 'line') { x.strokeStyle = pf || st || f || '#000'; x.lineWidth = Math.max(1, sw || L.h); x.lineCap = 'round'; dash(x.lineWidth); x.stroke(); x.setLineDash([]); }
        else { if ((pf || f) && !(L.shape === 'vec' && L.subs?.every(sp => sp.closed === false))) { x.fillStyle = pf || f; x.fill(L.shape === 'path' || dzSubs(L) ? 'evenodd' : 'nonzero'); } if (st && sw) { x.strokeStyle = st; x.lineWidth = sw; dash(sw); x.stroke(); x.setLineDash([]); } }
        }
        x.restore();
      };
      const c = l.crop;
      if (c && (c.w < 1 || c.h < 1 || opts.ghost === l.id)) {
        const FW = l.w / c.w, FH = l.h / c.h, ox = (0.5 - (c.x + c.w / 2)) * FW, oy = (0.5 - (c.y + c.h / 2)) * FH, full = { ...l, w: FW, h: FH };
        if (opts.ghost === l.id) { x.save(); x.globalAlpha *= 0.28; x.translate(ox, oy); body(full); x.restore(); }   // the part being cut away, faint
        x.save(); x.beginPath(); x.rect(-l.w / 2, -l.h / 2, l.w, l.h); x.clip(); x.translate(ox, oy); body(full); x.restore();
      } else body(l);
    }
    x.restore();
  };
  // Clipping: a layer marked `clip` only shows inside the nearest unclipped layer under it (its base),
  // so a texture laid over a shape takes the shape's form. The bottom layer of each page can't be clipped.
  // Two-sided designs: the master page (shared backgrounds, frames) sits under the front or the back.
  const show = (l) => !l.hide && (!opts.only || opts.only.has(l.id));
  const one0 = one, oneW = doc.pat ? async (cx, l) => { await one0(cx, l); for (const dy of [-doc.h, 0, doc.h]) for (const dx of [-doc.w, 0, doc.w]) if (dx || dy) await one0(cx, { ...l, x: l.x + dx, y: l.y + dy }); } : one0;   /* copies, so the layer itself never moves */
  const chLines = [];   /* a challenge's outline and detail lines, drawn last so nothing covers them */
  for (const L of dzPages(doc, opts.face))
  for (let i = 0; i < L.length; i++) {
    const base = L[i]; let j = i + 1;
    while (j < L.length && L[j].clip) j++;
    const clips = L.slice(i + 1, j).filter(show); i = j - 1;
    if (!show(base)) continue;
    if (doc.chal && base.t === 'shape' && base.role) { if (base.role === 'pack') await dzChPack(x, doc, base, scale, one); else if (base.role === 'shade') await dzChShade(x, doc, base, scale); else chLines.push(base); continue; }
    if (!clips.length) { await oneW(x, base); continue; }
    const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
    const ox = off.getContext('2d');
    await oneW(ox, base); ox.globalCompositeOperation = 'source-atop';
    for (const c of clips) await oneW(ox, c);
    x.setTransform(1, 0, 0, 1, 0, 0); x.drawImage(off, 0, 0);
  }
  /* A value study's stencil, where it goes on the skin: under the judged lines (black, at their needle's width), faint
     purple, so the two never look alike. Hidden with Stencil in the Challenge menu. */
  if (doc.chal && !opts.noStencil && doc.chal.showSten !== false) for (const l of doc.layers) { const S = l.sh?.stencil; if (l.hide || !S || l.sh.mkLive) continue; const im = await dzImg(S.ref); if (!im) continue;
    x.save(); x.setTransform(scale, 0, 0, scale, 0, 0); x.globalAlpha = 0.55; x.drawImage(im, S.box[0] * CH_PX, S.box[1] * CH_PX, S.box[2] * CH_PX, S.box[3] * CH_PX); x.restore(); }
  for (const l of chLines) await one(x, { ...l, fill: null, fm: undefined, stroke: '#141414', sw: (CH_NW[l.nd] || 0.7) * CH_PX, dash: '' });
}
/* ---------- SVG ----------
   Shapes are vector, and so are their plain colours and gradients, so they write straight into an SVG the same
   way they draw. Text (it needs its font), pictures and texture fills are pixels: a choice with any of those
   can't be saved as SVG (turn text into a shape first, e.g. with the shape builder). Clipped layers stay clipped
   to their base; a crop stays a crop. */
const dzVecOK = (l) => l.t === 'shape' && l.fm !== 'tex';
const _sf = (v) => +(+v).toFixed(2);
function dzSvgPath(L) {
  const w = L.w, h = L.h || 0;
  if (L.shape === 'ellipse') { const a = w / 2, b = h / 2; return `M${_sf(-a)} 0A${_sf(a)} ${_sf(b)} 0 1 0 ${_sf(a)} 0A${_sf(a)} ${_sf(b)} 0 1 0 ${_sf(-a)} 0Z`; }
  if (L.shape === 'line') return `M${_sf(-w / 2)} 0L${_sf(w / 2)} 0`;
  if (L.shape === 'path') {
    let d = '';
    for (const lp of L.path || []) { const n = lp.length / 2; if (n < 3) continue;
      const P = (i) => [(lp[(i % n) * 2] - 0.5) * w, (lp[(i % n) * 2 + 1] - 0.5) * h], mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const s0 = mid(P(n - 1), P(0)); d += `M${_sf(s0[0])} ${_sf(s0[1])}`;
      for (let i = 0; i < n; i++) { const p = P(i), q = mid(p, P(i + 1)); d += `Q${_sf(p[0])} ${_sf(p[1])} ${_sf(q[0])} ${_sf(q[1])}`; }
      d += 'Z'; }
    return d;
  }
  const subs = dzSubs(L);
  if (subs) {
    const X = (n, dd = 0) => _sf((n.x + dd - 0.5) * w), Y = (n, dd = 0) => _sf((n.y + dd - 0.5) * h);
    const seg = (a, b) => `C${X(a, a.ox)} ${Y(a, a.oy)} ${X(b, b.ix)} ${Y(b, b.iy)} ${X(b)} ${Y(b)}`;
    let d = '';
    for (const sp of subs) { const N = sp.nodes; if (!N?.length) continue;
      d += `M${X(N[0])} ${Y(N[0])}`; for (let i = 1; i < N.length; i++) d += seg(N[i - 1], N[i]);
      if (sp.closed !== false) d += seg(N.at(-1), N[0]) + 'Z'; }
    return d;
  }
  const r = Math.min(L.r || 0, w / 2, h / 2), x0 = -w / 2, y0 = -h / 2;
  if (!r) return `M${_sf(x0)} ${_sf(y0)}H${_sf(-x0)}V${_sf(-y0)}H${_sf(x0)}Z`;
  return `M${_sf(x0 + r)} ${_sf(y0)}H${_sf(-x0 - r)}A${_sf(r)} ${_sf(r)} 0 0 1 ${_sf(-x0)} ${_sf(y0 + r)}V${_sf(-y0 - r)}A${_sf(r)} ${_sf(r)} 0 0 1 ${_sf(-x0 - r)} ${_sf(-y0)}`
    + `H${_sf(x0 + r)}A${_sf(r)} ${_sf(r)} 0 0 1 ${_sf(x0)} ${_sf(-y0 - r)}V${_sf(y0 + r)}A${_sf(r)} ${_sf(r)} 0 0 1 ${_sf(x0 + r)} ${_sf(y0)}Z`;
}
// The box an item covers on the page (turned corners included), grown by half its outline.
function dzBounds(L) {
  const t = (L.rot || 0) * Math.PI / 180, c = Math.cos(t), s2 = Math.sin(t), cx = L.x + L.w / 2, cy = L.y + (L.h || 0) / 2;
  const g = L.t === 'shape' ? (L.shape === 'line' ? Math.max(1, L.sw || L.h) / 2 : dzCol({}, L.stroke) !== null && L.sw ? L.sw / 2 : 0) : 0;
  const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const dx = u * (L.w / 2 + g), dy = v * ((L.h || 0) / 2 + g); return [cx + dx * c - dy * s2, cy + dx * s2 + dy * c]; });
  return { x0: Math.min(...cs.map(q => q[0])), y0: Math.min(...cs.map(q => q[1])), x1: Math.max(...cs.map(q => q[0])), y1: Math.max(...cs.map(q => q[1])) };
}
// An SVG of these layers (page order), cut to what they cover. Every layer must pass dzVecOK.
function dzSvg(doc, layers) {
  const B = layers.map(dzBounds), x0 = Math.min(...B.map(b => b.x0)), y0 = Math.min(...B.map(b => b.y0)), W = Math.max(1, Math.max(...B.map(b => b.x1)) - x0), H = Math.max(1, Math.max(...B.map(b => b.y1)) - y0);
  const defs = [], out = []; let uid = 0;
  const esc2 = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const xf = (L) => `translate(${_sf(L.x + L.w / 2 - x0)} ${_sf(L.y + (L.h || 0) / 2 - y0)})${L.rot ? ` rotate(${_sf(L.rot)})` : ''}`;
  const paint = (L) => {
    if (L.fm !== 'grad' || !L.grad?.stops?.length) return null;
    const g = L.grad, id = 'g' + (++uid), w = L.w, h = L.h || 1;
    const stops = [...g.stops].sort((a, b) => a.p - b.p).map(st => `<stop offset="${_sf(Math.max(0, Math.min(1, st.p)))}" stop-color="${esc2(dzCol(doc, st.c) || '#000')}"/>`).join('');
    if (g.type === 'radial') defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${_sf(Math.max(1, Math.hypot(w, h) / 2 * (g.sz ?? 1)))}">${stops}</radialGradient>`);
    else { const a = (g.ang ?? 90) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), e = Math.abs(w / 2 * c) + Math.abs(h / 2 * sn) || 1;
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${_sf(-c * e)}" y1="${_sf(-sn * e)}" x2="${_sf(c * e)}" y2="${_sf(sn * e)}">${stops}</linearGradient>`); }
    return `url(#${id})`;
  };
  // One shape drawn in its own space: the box centred on 0, 0 (a crop draws the whole and clips to the box).
  const body = (L) => {
    const f = dzCol(doc, L.fill), st = dzCol(doc, L.stroke), sw = L.sw || 0, flip = L.fx || L.fy ? ` transform="scale(${L.fx ? -1 : 1} ${L.fy ? -1 : 1})"` : '';
    /* Line style: dashes and dots spaced by the line's own width, so they stay in proportion at any thickness. */
    const dash = (w) => L.dash === 'dash' ? ` stroke-dasharray="${_sf(w * 3)} ${_sf(w * 2)}"` : L.dash === 'dot' ? ` stroke-dasharray="0 ${_sf(w * 2)}" stroke-linecap="round" stroke-linejoin="round"` : '';
    const one = (S) => { const pf = paint(S), d = dzSvgPath(S);
      if (S.shape === 'line') { const lw = Math.max(1, sw || S.h); return `<path d="${d}" fill="none" stroke="${esc2(pf || st || f || '#000')}" stroke-width="${_sf(lw)}"${L.dash === 'dot' ? '' : ' stroke-linecap="round"'}${dash(lw)}${flip}/>`; }
      const open = S.shape === 'vec' && S.subs?.every(sp => sp.closed === false), fill = !open && (pf || f);
      return `<path d="${d}" fill="${fill ? esc2(fill) : 'none'}"${S.shape === 'path' || dzSubs(S) ? ' fill-rule="evenodd"' : ''}${st && sw ? ` stroke="${esc2(st)}" stroke-width="${_sf(sw)}"${dash(sw)}` : ''}${flip}/>`; };
    const c = L.crop;
    if (c && (c.w < 1 || c.h < 1)) {
      const FW = L.w / c.w, FH = L.h / c.h, ox = (0.5 - (c.x + c.w / 2)) * FW, oy = (0.5 - (c.y + c.h / 2)) * FH, id = 'c' + (++uid);
      defs.push(`<clipPath id="${id}"><rect x="${_sf(-L.w / 2)}" y="${_sf(-L.h / 2)}" width="${_sf(L.w)}" height="${_sf(L.h)}"/></clipPath>`);
      return `<g clip-path="url(#${id})"><g transform="translate(${_sf(ox)} ${_sf(oy)})">${one({ ...L, w: FW, h: FH })}</g></g>`;
    }
    return one(L);
  };
  const item = (L) => `<g transform="${xf(L)}"${(L.op ?? 1) < 1 ? ` opacity="${_sf(L.op)}"` : ''}>${body(L)}</g>`;
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i]; let j = i + 1; while (j < layers.length && layers[j].clip) j++;
    const clips = layers.slice(i + 1, j); i = j - 1;
    out.push(item(L));
    if (clips.length) { const id = 'k' + (++uid);
      defs.push(`<clipPath id="${id}"><path transform="${xf(L)}${L.fx || L.fy ? ` scale(${L.fx ? -1 : 1} ${L.fy ? -1 : 1})` : ''}" d="${dzSvgPath(L)}"${L.shape === 'path' || dzSubs(L) ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
      out.push(`<g clip-path="url(#${id})">${clips.map(item).join('')}</g>`); }
  }
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${_sf(W)} ${_sf(H)}" width="${_sf(W)}" height="${_sf(H)}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${out.join('')}</svg>`, x0, y0, W, H };
}
// The layers as they'll be kept with an asset: theme colours fixed to what they are now, placed from 0, 0.
function dzAssetLayers(doc, layers, x0, y0) {
  const fix = (c) => c && c[0] === '@' ? dzCol(doc, c) : c;
  return layers.map(l => { const o = JSON.parse(JSON.stringify(l)); delete o.id; delete o.side; delete o.lock; delete o.hide; o.x -= x0; o.y -= y0;
    o.fill = fix(o.fill); o.stroke = fix(o.stroke); if (o.grad?.stops) o.grad.stops.forEach(st => st.c = fix(st.c)); return o; });
}
// The layer lists drawn for a page, bottom first: f = front, b = back, m = master (only the master).
const dzSide = (l) => l.side || 'f';
function dzPages(doc, face = 'f') {
  if (!doc.sides) return [doc.layers];
  const own = doc.layers.filter(l => dzSide(l) === face);
  return face === 'm' ? [own] : [doc.layers.filter(l => l.side === 'm'), own];
}
const dzFaceNames = (doc) => doc.form ? { f: 'Page 1', b: 'Back', m: 'Master' } : doc.fold ? { f: 'Outside', b: 'Inside', m: 'Master' } : { f: 'Front', b: 'Back', m: 'Master' };
// A finished copy of the design as its own canvas (full size unless `scale`), front unless `face`.
async function dzCanvas(doc, scale = 1, face) {
  const cv = document.createElement('canvas'); cv.width = Math.round(doc.w * scale); cv.height = Math.round(doc.h * scale);
  await dzDraw(cv, doc, scale, { face }); return cv;
}

/* Number boxes do sums: type 10+5, 210/3 or (20-4)*2 and it works out on Enter or on leaving the box. While a sum is
   being typed, the box's own handlers don't see it; they get the answer. */
function dzCalc(s) {
  const src = String(s).replace(/\s+/g, '').replace(/,/g, '.').replace(/[×x]/gi, '*').replace(/÷/g, '/'); let i = 0;
  const num = () => { if (src[i] === '-') { i++; return -num(); } if (src[i] === '+') { i++; return num(); }
    if (src[i] === '(') { i++; const v = sum(); if (src[i++] !== ')') return NaN; return v; }
    const m = /^\d*\.?\d+|^\d+\./.exec(src.slice(i)); if (!m) return NaN; i += m[0].length; return +m[0]; };
  const prod = () => { let v = num(); while (src[i] === '*' || src[i] === '/') { const o = src[i++], r = num(); v = o === '*' ? v * r : r ? v / r : NaN; } return v; };
  const sum = () => { let v = prod(); while (src[i] === '+' || src[i] === '-') { const o = src[i++], r = prod(); v = o === '+' ? v + r : v - r; } return v; };
  const v = sum(); return i === src.length && Number.isFinite(v) ? v : NaN;
}
document.addEventListener('focusin', (e) => { if (e.target.matches?.('input[data-calc]')) e.target.dataset.was = e.target.value; });
document.addEventListener('input', (e) => { const t = e.target; if (t.matches?.('input[data-calc]') && (!t.value.trim() || !Number.isFinite(+t.value))) e.stopImmediatePropagation(); }, true);
const dzCalcCommit = (t) => { const raw = t.value.trim(); if (!raw || Number.isFinite(+raw)) return;
  let v = dzCalc(raw); if (Number.isNaN(v)) { toast('That sum doesn\'t work out.'); t.value = t.dataset.was ?? ''; return; }
  const mn = t.getAttribute('min'), mx = t.getAttribute('max'); if (mn != null && v < +mn) v = +mn; if (mx != null && v > +mx) v = +mx;
  t.value = +v.toFixed(3); t.dispatchEvent(new Event('input', { bubbles: true })); };
document.addEventListener('change', (e) => { if (e.target.matches?.('input[data-calc]')) dzCalcCommit(e.target); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches?.('input[data-calc]')) { e.preventDefault(); e.target.blur(); } }, true);

/* ---------- Templates ---------- */
let dzN = 0; const dzId = () => 'L' + Date.now().toString(36) + (dzN++);
const dzT = (text, x, y, w, size, o = {}) => ({ id: dzId(), t: 'text', text, x, y, w, h: size * 1.2, size, font: '@2', c: '@fg', al: 'left', lh: 1.2, ...o });
const dzLogo = (x, y, w, h, o = {}) => ({ id: dzId(), t: 'image', logo: true, x, y, w, h, ...o });
const dzS = (shape, x, y, w, h, o = {}) => ({ id: dzId(), t: 'shape', shape, x, y, w, h, fill: '@accent', ...o });
// A gradient fill (shapes and text): stops as [colour, position 0..1]; angle 90 runs top to bottom.
const dzG = (stops, ang = 90, type = 'linear') => ({ fm: 'grad', grad: { type, ang, stops: stops.map(([c, p]) => ({ c, p })) } });
const DZ_CLEAR = 'rgba(0,0,0,0)';
// A band whose top edge waves (n waves, `amp` deep as a fraction of the band), square below: a node shape.
const dzWave = (x, y, w, h, n = 3, amp = 0.4, o = {}) => {
  const k = 2 * n, dx = 1 / k, top = [];
  for (let i = 0; i <= k; i++) top.push(dzNd(i * dx, i % 2 ? amp : 0, i ? -dx / 2.2 : 0, 0, i < k ? dx / 2.2 : 0, 0, 'smooth'));
  return dzS('vec', x, y, w, h, { subs: [{ closed: true, nodes: [dzNd(0, 1), ...top, dzNd(1, 1)] }], ...o });
};
const dzBurst = (x, y, d, o = {}) => dzS('star', x, y, d, d, { n: 18, inner: 0.84, ...o });   // a starburst sticker
const DZ_TEMPLATES = {
  voucher: [
    ['Classic', (W, H) => [dzS('rect', 0, 0, W * 0.36, H), dzLogo(W * 0.07, H * 0.12, W * 0.22, H * 0.4),
      dzT('{studio}', W * 0.03, H * 0.6, W * 0.3, H * 0.075, { font: '@1', c: '@bg', al: 'center', fit: 1 }),
      dzT('{phone}\n{instagram}', W * 0.03, H * 0.74, W * 0.3, H * 0.045, { c: '@bg', al: 'center' }),
      dzT('GIFT VOUCHER', W * 0.42, H * 0.1, W * 0.54, H * 0.1, { font: '@1', ls: 4 }),
      dzT('{amount}', W * 0.42, H * 0.25, W * 0.54, H * 0.2, { font: '@1', c: '@accent', fit: 1 }),
      dzT('For: {to}', W * 0.42, H * 0.55, W * 0.54, H * 0.055), dzT('From: {from}', W * 0.42, H * 0.64, W * 0.54, H * 0.055),
      dzS('line', W * 0.42, H * 0.77, W * 0.5, 4, { fill: '@soft' }),
      dzT('Code {code}  ·  Valid until {expires}', W * 0.42, H * 0.81, W * 0.54, H * 0.045, { c: '@soft' })]],
    ['Centred', (W, H) => [dzS('rect', W * 0.025, H * 0.05, W * 0.95, H * 0.9, { fill: 'none', stroke: '@accent', sw: 6, r: 24 }),
      dzLogo(W * 0.44, H * 0.1, W * 0.12, H * 0.2), dzT('Gift voucher', W * 0.1, H * 0.31, W * 0.8, H * 0.13, { font: '@1', al: 'center' }),
      dzT('{amount}', W * 0.1, H * 0.45, W * 0.8, H * 0.17, { font: '@1', c: '@accent', al: 'center', fit: 1 }),
      dzT('For {to}  ·  From {from}', W * 0.1, H * 0.66, W * 0.8, H * 0.05, { al: 'center' }),
      dzT('Code {code}  ·  Valid until {expires}', W * 0.1, H * 0.74, W * 0.8, H * 0.04, { al: 'center', c: '@soft' }),
      dzT('{studio}  ·  {phone}  ·  {instagram}', W * 0.1, H * 0.84, W * 0.8, H * 0.04, { al: 'center', c: '@soft' })]],
    ['Ticket', (W, H) => [dzS('rect', W * 0.72, 0, W * 0.28, H), dzT('{amount}', W * 0.73, H * 0.36, W * 0.26, H * 0.15, { font: '@1', c: '@bg', al: 'center', fit: 1 }),
      dzT('No. {code}', W * 0.73, H * 0.56, W * 0.26, H * 0.045, { c: '@bg', al: 'center' }),
      dzLogo(W * 0.05, H * 0.1, W * 0.14, H * 0.28), dzT('{studio}', W * 0.21, H * 0.15, W * 0.48, H * 0.09, { font: '@1', fit: 1 }),
      dzT('A gift for {to}', W * 0.05, H * 0.47, W * 0.64, H * 0.08, { font: '@1', c: '@accent' }),
      dzT('From {from}. Valid until {expires}. Book on {phone} or {instagram}.', W * 0.05, H * 0.62, W * 0.62, H * 0.045, { c: '@soft' })]],
    ['Starburst', (W, H) => [dzS('rect', 0, 0, W, H, dzG([['@bg', 0], ['@bg', 0.5], ['@accent', 1.6]], 20)),
      dzWave(0, H * 0.8, W, H * 0.2, 4, 0.4), dzBurst(W * 0.64, H * 0.08, H * 0.66, { fill: '@fg' }),
      dzT('{amount}', W * 0.64, H * 0.35, H * 0.66, H * 0.13, { font: '@1', c: '@bg', al: 'center', fit: 1 }),
      dzLogo(W * 0.05, H * 0.08, H * 0.26, H * 0.26),
      dzT('GIFT VOUCHER', W * 0.05, H * 0.4, W * 0.55, H * 0.11, { font: '@1', ls: 4, ...dzG([['@fg', 0], ['@accent', 1]], 0) }),
      dzT('For: {to}', W * 0.05, H * 0.56, W * 0.5, H * 0.05), dzT('From: {from}', W * 0.05, H * 0.64, W * 0.5, H * 0.05),
      dzT('{studio}  ·  Code {code}  ·  Valid until {expires}', W * 0.05, H * 0.89, W * 0.9, H * 0.04, { c: '@bg', al: 'center' })]],
    ['Seal', (W, H) => { const d = H * 0.7, sx = W * 0.05, sy = H * 0.15;
      return [dzS('rect', 0, 0, W * 0.4, H, dzG([['@accent', 0], ['@bg', 1]], 0)),
        dzS('ring', sx + W * 0.03, sy, d, d, { inner: 0.88, fill: '@fg' }), dzLogo(sx + W * 0.03 + d * 0.22, sy + d * 0.22, d * 0.56, d * 0.56),
        dzT('{studio}', sx, H * 0.03, d + W * 0.06, H * 0.075, { font: '@1', al: 'center', arc: 70, fit: 1 }),
        dzT('Gift voucher', W * 0.45, H * 0.12, W * 0.5, H * 0.12, { font: '@1', ...dzG([['@accent', 0], ['@fg', 1]], 0) }),
        dzT('{amount}', W * 0.45, H * 0.3, W * 0.5, H * 0.18, { font: '@1', fit: 1 }),
        dzS('line', W * 0.45, H * 0.55, W * 0.48, 5, dzG([['@accent', 0], [DZ_CLEAR, 1]], 0)),
        dzT('For {to}  ·  From {from}', W * 0.45, H * 0.6, W * 0.5, H * 0.05),
        dzT('Code {code}  ·  Valid until {expires}', W * 0.45, H * 0.72, W * 0.5, H * 0.04, { c: '@soft' }),
        dzT('{phone}  ·  {instagram}', W * 0.45, H * 0.82, W * 0.5, H * 0.04, { c: '@soft' })]; }]
  ],
  card: [
    ['Logo left', (W, H) => [dzLogo(W * 0.06, H * 0.2, W * 0.28, H * 0.6), dzS('rect', W * 0.375, H * 0.19, 5, H * 0.62),
      dzT('{studio}', W * 0.42, H * 0.2, W * 0.54, H * 0.13, { font: '@1', fit: 1 }), dzT('{artist}', W * 0.42, H * 0.37, W * 0.54, H * 0.07, { c: '@accent' }),
      dzT('{phone}\n{instagram}', W * 0.42, H * 0.56, W * 0.54, H * 0.065, { lh: 1.45 })]],
    ['Centred', (W, H) => [dzLogo(W * 0.38, H * 0.08, W * 0.24, H * 0.32), dzT('{studio}', W * 0.06, H * 0.44, W * 0.88, H * 0.13, { font: '@1', al: 'center', fit: 1 }),
      dzS('line', W * 0.4, H * 0.66, W * 0.2, 3), dzT('{phone}  ·  {instagram}', W * 0.06, H * 0.74, W * 0.88, H * 0.06, { al: 'center', c: '@soft' })]],
    ['Bold band', (W, H) => [dzS('rect', 0, H * 0.62, W, H * 0.38), dzT('{studio}', W * 0.07, H * 0.14, W * 0.62, H * 0.16, { font: '@1', fit: 1 }),
      dzT('{artist}', W * 0.07, H * 0.36, W * 0.62, H * 0.075, { c: '@soft' }), dzLogo(W * 0.72, H * 0.08, W * 0.22, H * 0.46),
      dzT('{phone}   {instagram}', W * 0.07, H * 0.73, W * 0.86, H * 0.07, { c: '@bg' })]],
    ['Gradient', (W, H) => [dzS('rect', 0, 0, W, H, dzG([['@accent', 0], ['@bg', 0.8]], 135)),
      dzLogo(W * 0.07, H * 0.1, W * 0.2, H * 0.32), dzT('{studio}', W * 0.07, H * 0.52, W * 0.86, H * 0.14, { font: '@1', fit: 1 }),
      dzT('{artist}', W * 0.07, H * 0.69, W * 0.5, H * 0.065, { c: '@soft' }),
      dzT('{phone}\n{instagram}', W * 0.45, H * 0.69, W * 0.48, H * 0.06, { al: 'right', lh: 1.4 })]],
    ['Badge', (W, H) => { const d = H * 0.5, bx = (W - d) / 2;
      return [dzS('ring', bx, H * 0.16, d, d, { inner: 0.86 }), dzLogo(bx + d * 0.2, H * 0.16 + d * 0.2, d * 0.6, d * 0.6),
        dzT('{studio}', W * 0.2, H * 0.03, W * 0.6, H * 0.08, { font: '@1', al: 'center', arc: 60, fit: 1 }),
        dzT('{artist}', W * 0.06, H * 0.71, W * 0.88, H * 0.065, { al: 'center', c: '@accent' }),
        dzT('{phone}  ·  {instagram}', W * 0.06, H * 0.83, W * 0.88, H * 0.055, { al: 'center', c: '@soft' })]; }],
    ['Front & back', (W, H) => [dzS('rect', 0, 0, W, H, dzG([['@accent', 0], ['@bg', 1]], 135)), dzLogo(W * 0.35, H * 0.14, W * 0.3, H * 0.46),
      dzT('{studio}', W * 0.08, H * 0.68, W * 0.84, H * 0.12, { font: '@1', al: 'center', fit: 1 }),
      dzT('{studio}', W * 0.08, H * 0.12, W * 0.84, H * 0.12, { font: '@1', fit: 1, side: 'b' }),
      dzT('{artist}', W * 0.08, H * 0.29, W * 0.84, H * 0.065, { c: '@accent', side: 'b' }),
      dzT('{phone}\n{instagram}\n{facebook}', W * 0.08, H * 0.44, W * 0.84, H * 0.06, { lh: 1.5, side: 'b' }),
      dzWave(0, H * 0.82, W, H * 0.18, 3, 0.45, { side: 'b' })]]
  ],
  flyer: [
    ['Promo', (W, H) => [dzS('rect', 0, 0, W, H * 0.06), dzLogo(W * 0.35, H * 0.1, W * 0.3, H * 0.16),
      dzT('FLASH DAY', W * 0.08, H * 0.3, W * 0.84, H * 0.09, { font: '@1', al: 'center' }),
      dzT('Saturday · walk-ins welcome', W * 0.08, H * 0.42, W * 0.84, H * 0.03, { al: 'center', c: '@accent' }),
      dzT('Pick a design from the wall and get tattooed on the day. Small pieces from a set price, first come first served.', W * 0.12, H * 0.5, W * 0.76, H * 0.024, { al: 'center', lh: 1.5 }),
      dzS('line', W * 0.3, H * 0.74, W * 0.4, 4, { fill: '@soft' }),
      dzT('{studio}\n{phone}  ·  {instagram}', W * 0.08, H * 0.78, W * 0.84, H * 0.026, { al: 'center', lh: 1.6 })]],
    ['Price list', (W, H) => [dzLogo(W * 0.08, H * 0.05, W * 0.18, H * 0.1), dzT('{studio}', W * 0.3, H * 0.075, W * 0.62, H * 0.05, { font: '@1', fit: 1 }),
      dzT('Prices', W * 0.08, H * 0.2, W * 0.84, H * 0.07, { font: '@1', c: '@accent' }),
      dzT('Small (up to 5 cm)\nMedium (palm size)\nLarge (half sleeve)\nFull day session\nTouch-ups', W * 0.08, H * 0.3, W * 0.5, H * 0.026, { lh: 1.9 }),
      dzT('from …\nfrom …\nfrom …\n…\n…', W * 0.6, H * 0.3, W * 0.32, H * 0.026, { lh: 1.9, al: 'right' }),
      dzT('A deposit secures your booking. Prices depend on size, detail and placement.', W * 0.08, H * 0.62, W * 0.84, H * 0.02, { c: '@soft', lh: 1.5 }),
      dzS('rect', 0, H * 0.86, W, H * 0.14), dzT('{phone}  ·  {instagram}', W * 0.08, H * 0.91, W * 0.84, H * 0.026, { c: '@bg', al: 'center' })]],
    ['Aftercare', (W, H) => [dzT('Aftercare', W * 0.08, H * 0.06, W * 0.84, H * 0.07, { font: '@1', al: 'center' }),
      dzT('1. Leave the wrap on for the time you were told.\n2. Wash gently with clean hands and mild soap.\n3. Pat dry and apply a thin layer of aftercare.\n4. No swimming, sun or scratching while it heals.\n5. Questions? Get in touch.', W * 0.1, H * 0.2, W * 0.8, H * 0.024, { lh: 1.8 }),
      dzLogo(W * 0.4, H * 0.7, W * 0.2, H * 0.1), dzT('{studio}\n{phone}  ·  {instagram}', W * 0.08, H * 0.83, W * 0.84, H * 0.024, { al: 'center', lh: 1.6, c: '@soft' })]],
    ['Flash burst', (W, H) => [dzS('rect', 0, 0, W, H * 0.5, dzG([['@accent', 0], ['@bg', 1]], 90)),
      dzBurst(W * 0.15, H * 0.06, W * 0.7, { fill: '@bg', n: 22, inner: 0.86 }),
      dzT('FLASH\nDAY', W * 0.2, H * 0.14, W * 0.6, H * 0.09, { font: '@1', al: 'center', lh: 1, c: '@accent' }),
      dzT('walk-ins welcome', W * 0.2, H * 0.36, W * 0.6, H * 0.03, { al: 'center', arc: -40 }),
      dzT('Pick a design from the wall and get tattooed on the day. Small pieces from a set price, first come first served.', W * 0.12, H * 0.56, W * 0.76, H * 0.024, { al: 'center', lh: 1.5 }),
      dzLogo(W * 0.4, H * 0.67, W * 0.2, H * 0.09),
      dzWave(0, H * 0.82, W, H * 0.18, 3, 0.35), dzT('{studio}\n{phone}  ·  {instagram}', W * 0.08, H * 0.89, W * 0.84, H * 0.026, { al: 'center', lh: 1.6, c: '@bg' })]],
    ['Guest spot', (W, H) => { const d = W * 0.56, hx = (W - d) / 2;
      return [dzT('GUEST SPOT', W * 0.1, H * 0.05, W * 0.8, H * 0.05, { font: '@1', al: 'center', arc: 50, ls: 6 }),
        dzS('poly', hx, H * 0.14, d, d, { n: 6, fill: 'none', stroke: '@accent', sw: 10 }),
        dzS('poly', hx + d * 0.08, H * 0.14 + d * 0.08, d * 0.84, d * 0.84, { n: 6, ...dzG([['@accent', 0], ['@bg', 1]], 90), op: 0.35 }),
        dzLogo(hx + d * 0.25, H * 0.14 + d * 0.25, d * 0.5, d * 0.5),
        dzT('{artist}', W * 0.08, H * 0.56, W * 0.84, H * 0.05, { font: '@1', al: 'center', fit: 1 }),
        dzT('Dates · City', W * 0.08, H * 0.63, W * 0.84, H * 0.03, { al: 'center', c: '@accent' }),
        dzT('A few days only. Message to book a spot or ask about flash.', W * 0.12, H * 0.69, W * 0.76, H * 0.022, { al: 'center', lh: 1.5, c: '@soft' }),
        dzS('rect', 0, H * 0.86, W, H * 0.14, dzG([['@bg', 0], ['@accent', 1]], 0)),
        dzT('{studio}  ·  {phone}  ·  {instagram}', W * 0.06, H * 0.915, W * 0.88, H * 0.024, { al: 'center' })]; }]
  ],
  page: [
    ['Poster', (W, H) => [dzS('rect', 0, 0, W, H, dzG([['@bg', 0], ['@bg', 0.45], ['@accent', 1.4]], 90)),
      dzLogo(W * 0.38, H * 0.06, W * 0.24, W * 0.24),
      dzT('YOUR HEADLINE', W * 0.08, H * 0.27, W * 0.84, H * 0.07, { font: '@1', al: 'center', fit: 1, ...dzG([['@fg', 0], ['@accent', 1]], 0) }),
      dzT('A line about the event, offer or news', W * 0.1, H * 0.37, W * 0.8, H * 0.025, { al: 'center', c: '@soft' }),
      dzBurst(W * 0.62, H * 0.45, W * 0.28, { fill: '@accent', rot: 12 }), dzT('NEW', W * 0.62, H * 0.45 + W * 0.11, W * 0.28, W * 0.06, { font: '@1', al: 'center', c: '@bg', rot: 12 }),
      dzT('Details go here: dates, times, prices or anything people need to know.', W * 0.1, H * 0.5, W * 0.5, H * 0.022, { lh: 1.6 }),
      dzWave(0, H * 0.84, W, H * 0.16, 4, 0.35), dzT('{studio}\n{phone}  ·  {instagram}', W * 0.08, H * 0.9, W * 0.84, H * 0.02, { al: 'center', lh: 1.6, c: '@bg' })]],
    ['Price list', (W, H) => [dzS('rect', 0, 0, W, H * 0.16, dzG([['@accent', 0], ['@bg', 1]], 0)), dzLogo(W * 0.07, H * 0.03, W * 0.14, H * 0.1),
      dzT('{studio}', W * 0.25, H * 0.055, W * 0.68, H * 0.045, { font: '@1', fit: 1 }),
      dzT('Prices', W * 0.07, H * 0.21, W * 0.86, H * 0.05, { font: '@1', c: '@accent' }),
      dzT('Small (up to 5 cm)\nMedium (palm size)\nLarge (half sleeve)\nFull day session\nTouch-ups', W * 0.07, H * 0.29, W * 0.55, H * 0.022, { lh: 2 }),
      dzT('from …\nfrom …\nfrom …\n…\n…', W * 0.6, H * 0.29, W * 0.33, H * 0.022, { lh: 2, al: 'right' }),
      dzS('line', W * 0.07, H * 0.55, W * 0.86, 4, dzG([['@accent', 0], [DZ_CLEAR, 1]], 0)),
      dzT('A deposit secures your booking. Prices depend on size, detail and placement.', W * 0.07, H * 0.58, W * 0.86, H * 0.018, { c: '@soft', lh: 1.5 }),
      dzWave(0, H * 0.88, W, H * 0.12, 3, 0.4), dzT('{phone}  ·  {instagram}', W * 0.07, H * 0.94, W * 0.86, H * 0.02, { c: '@bg', al: 'center' })]]
  ],
  post: [
    ['Announcement', (W, H) => [dzS('rect', W * 0.05, H * 0.05, W * 0.9, H * 0.9, { fill: 'none', stroke: '@accent', sw: 6, r: 20 }),
      dzT('BOOKS OPEN', W * 0.1, H * 0.3, W * 0.8, H * 0.13, { font: '@1', al: 'center' }),
      dzT('Message me to book your spot', W * 0.1, H * 0.48, W * 0.8, H * 0.045, { al: 'center', c: '@accent' }),
      dzLogo(W * 0.4, H * 0.64, W * 0.2, H * 0.16), dzT('{instagram}', W * 0.1, H * 0.84, W * 0.8, H * 0.035, { al: 'center', c: '@soft' })]],
    ['Flash', (W, H) => [dzT('Available flash', W * 0.07, H * 0.06, W * 0.86, H * 0.08, { font: '@1', al: 'center' }),
      dzS('rect', W * 0.12, H * 0.2, W * 0.76, H * 0.6, { fill: 'none', stroke: '@soft', sw: 3, r: 16 }),
      dzT('Add your design here', W * 0.12, H * 0.47, W * 0.76, H * 0.035, { al: 'center', c: '@soft' }),
      dzT('{studio}  ·  {instagram}', W * 0.07, H * 0.87, W * 0.86, H * 0.035, { al: 'center', c: '@accent' })]],
    ['Speech bubble', (W, H) => { const bw = W * 0.82, bh = Math.min(H * 0.42, bw * 0.62), bx = (W - bw) / 2, by = H * 0.14;
      return [dzS('rect', 0, 0, W, H, dzG([['@bg', 0], ['@accent', 1.5]], 90)),
        dzS('bubble', bx, by, bw, bh, { fill: '@fg' }),
        dzT('BOOKS\nOPEN!', bx, by + bh * 0.16, bw, bh * 0.24, { font: '@1', al: 'center', c: '@bg', lh: 1 }),
        dzLogo(W * 0.4, by + bh + H * 0.08, W * 0.2, W * 0.2),
        dzT('Message me to book your spot', W * 0.1, H * 0.8, W * 0.8, Math.min(W * 0.045, H * 0.035), { al: 'center' }),
        dzT('{instagram}', W * 0.1, H * 0.87, W * 0.8, Math.min(W * 0.035, H * 0.028), { al: 'center', c: '@soft' })]; }],
    ['Flash sale', (W, H) => { const d = Math.min(W * 0.78, H * 0.5);
      return [dzS('rect', 0, 0, W, H, dzG([['@accent', 0], ['@bg', 0.7]], 160, 'radial')),
        dzBurst((W - d) / 2, H * 0.12, d, { fill: '@fg', n: 20, rot: -8 }),
        dzT('FLASH\nSALE', (W - d) / 2, H * 0.12 + d * 0.3, d, d * 0.17, { font: '@1', al: 'center', c: '@bg', lh: 1, rot: -8 }),
        dzT('This weekend only', W * 0.1, H * 0.12 + d + H * 0.04, W * 0.8, Math.min(W * 0.05, H * 0.04), { al: 'center', font: '@1' }),
        dzT('Pick from the flash sheet, first come first served', W * 0.1, H * 0.12 + d + H * 0.1, W * 0.8, Math.min(W * 0.032, H * 0.025), { al: 'center', c: '@soft' }),
        dzWave(0, H * 0.88, W, H * 0.12, 3, 0.4), dzT('{studio}  ·  {instagram}', W * 0.06, H * 0.935, W * 0.88, Math.min(W * 0.03, H * 0.024), { al: 'center', c: '@bg' })]; }]
  ]
};
// Photo spots: `slot` n takes the piece's n-th photo; cover crops to fill the spot.
const dzPh = (slot, x, y, w, h, o = {}) => ({ id: dzId(), t: 'image', slot, cover: 1, x, y, w, h, ...o });
const dzMark = (W, H, o = {}) => dzLogo(W * 0.78, W * 0.04, W * 0.18, W * 0.12, { op: 0.85, ...o });   // logo watermark
const DZ_TATTOO = [
  ['Showcase', (W, H) => { const m = W * 0.06, band = H * 0.17;
    return [dzPh(0, m, m, W - 2 * m, H - band - m * 1.5, { r: W * 0.02 }),
      dzT('{title}', m, H - band + m * 0.1, W * 0.66, Math.min(W * 0.06, H * 0.045), { font: '@1', fit: 1 }),
      dzT('{tags}', m, H - band + H * 0.065, W * 0.66, Math.min(W * 0.03, H * 0.021), { c: '@soft', lh: 1.35 }),
      dzLogo(W - m - W * 0.2, H - band + m * 0.1, W * 0.2, band - m * 1.2, { op: 0.9 })]; }],
  ['Full photo', (W, H) => [dzPh(0, 0, 0, W, H), dzS('rect', 0, H * 0.8, W, H * 0.2, { fill: '@bg', op: 0.78 }),
    dzT('{title}', W * 0.06, H * 0.82, W * 0.88, Math.min(W * 0.065, H * 0.05), { font: '@1', fit: 1 }),
    dzT('{tags}', W * 0.06, H * 0.9, W * 0.88, Math.min(W * 0.03, H * 0.022), { c: '@soft' }), dzMark(W, H)]],
  ['Framed', (W, H) => [dzT('{title}', W * 0.08, H * 0.045, W * 0.84, Math.min(W * 0.07, H * 0.055), { font: '@1', al: 'center', fit: 1 }),
    dzPh(0, W * 0.1, H * 0.14, W * 0.8, H * 0.66, { r: W * 0.03, stroke: '@accent', sw: 8 }),
    dzT('{placement}', W * 0.08, H * 0.83, W * 0.84, Math.min(W * 0.04, H * 0.03), { al: 'center', c: '@accent' }),
    dzT('{studio}  ·  {instagram}', W * 0.08, H * 0.9, W * 0.84, Math.min(W * 0.03, H * 0.023), { al: 'center', c: '@soft' })]],
  ['Fresh & healed', (W, H) => { const tall = H > W * 1.4, lab = Math.min(W * 0.045, H * 0.034);
    const a = tall ? [W * 0.08, H * 0.12, W * 0.84, H * 0.36] : [W * 0.05, H * 0.15, W * 0.44, H * 0.62];
    const b = tall ? [W * 0.08, H * 0.52, W * 0.84, H * 0.36] : [W * 0.51, H * 0.15, W * 0.44, H * 0.62];
    const tag = (r, t) => [dzS('rect', r[0] + W * 0.02, r[1] + W * 0.02, W * 0.2, lab * 1.6, { r: lab * 0.8 }),
      dzT(t, r[0] + W * 0.02, r[1] + W * 0.02 + lab * 0.3, W * 0.2, lab, { c: '@bg', al: 'center', b: 1 })];
    return [dzT('{title}', W * 0.06, H * 0.04, W * 0.88, Math.min(W * 0.065, H * 0.05), { font: '@1', al: 'center', fit: 1 }),
      dzPh(0, ...a, { r: W * 0.02 }), dzPh(1, ...b, { r: W * 0.02 }), ...tag(a, 'Fresh'), ...tag(b, 'Healed'),
      dzT('{tags}', W * 0.06, H * (tall ? 0.91 : 0.82), W * 0.88, Math.min(W * 0.03, H * 0.022), { al: 'center', c: '@soft' }), dzMark(W, H, { y: H - W * 0.16 })]; }],
  ['Polaroid', (W, H) => { const fw = W * 0.76, fh = Math.min(H * 0.74, fw * 1.2), fx = (W - fw) / 2, fy = (H - fh) / 2 - H * 0.03;
    return [dzS('rect', fx, fy, fw, fh, { fill: '#fdfbf6', rot: -3, r: 6 }),
      dzPh(0, fx + fw * 0.06, fy + fw * 0.06, fw * 0.88, fh - fw * 0.06 - fh * 0.2, { rot: -3 }),
      dzT('{title}', fx + fw * 0.06, fy + fh * 0.84, fw * 0.88, fh * 0.07, { font: 'Permanent Marker', c: '#222222', al: 'center', rot: -3, fit: 1 }),
      dzT('{tags}', W * 0.08, H * 0.92, W * 0.84, Math.min(W * 0.03, H * 0.022), { al: 'center', c: '@soft' }), dzMark(W, H)]; }],
  ['Photo grid', (W, H) => { const m = W * 0.05, top = H * 0.12, g = W * 0.02, cw = (W - 2 * m - g) / 2, ch = Math.min(cw, (H * 0.72 - g) / 2);
    return [dzT('{title}', m, H * 0.035, W - 2 * m, Math.min(W * 0.06, H * 0.05), { font: '@1', al: 'center', fit: 1 }),
      ...[0, 1, 2, 3].map(i => dzPh(i, m + (i % 2) * (cw + g), top + Math.floor(i / 2) * (ch + g), cw, ch, { r: W * 0.015 })),
      dzT('{tags}', m, top + 2 * ch + g + H * 0.03, W - 2 * m, Math.min(W * 0.03, H * 0.022), { al: 'center', c: '@soft' }),
      dzT('{studio}  ·  {instagram}', m, H - H * 0.06, W - 2 * m, Math.min(W * 0.028, H * 0.021), { al: 'center', c: '@accent' })]; }],
  ['Fade', (W, H) => [dzPh(0, 0, 0, W, H), dzS('rect', 0, H * 0.5, W, H * 0.5, dzG([[DZ_CLEAR, 0], ['@bg', 0.75]], 90)),
    dzT('{title}', W * 0.06, H * 0.8, W * 0.88, Math.min(W * 0.075, H * 0.055), { font: '@1', fit: 1 }),
    dzT('{placement}  ·  {tags}', W * 0.06, H * 0.89, W * 0.88, Math.min(W * 0.03, H * 0.022), { c: '@soft' }), dzMark(W, H)]],
  ['Circle', (W, H) => { const d = Math.min(W * 0.78, H * 0.6), cx = (W - d) / 2, cy = (H - d) / 2 - H * 0.02;
    return [dzS('rect', 0, 0, W, H, dzG([['@accent', 0], ['@bg', 0.65]], 0, 'radial')),
      dzS('ellipse', cx, cy, d, d, { fill: '@soft' }), dzPh(0, cx, cy, d, d, { clip: 1 }),
      dzS('ring', cx - d * 0.04, cy - d * 0.04, d * 1.08, d * 1.08, { inner: 0.93 }),
      dzT('{title}', W * 0.1, cy - Math.min(W * 0.12, H * 0.09), W * 0.8, Math.min(W * 0.06, H * 0.045), { font: '@1', al: 'center', arc: 40, fit: 1 }),
      dzT('{tags}', W * 0.08, cy + d + H * 0.05, W * 0.84, Math.min(W * 0.03, H * 0.022), { al: 'center', c: '@soft' }), dzMark(W, H, { y: H - W * 0.16 })]; }],
  ['Heart', (W, H) => { const d = Math.min(W * 0.8, H * 0.62), hx = (W - d) / 2, hy = H * 0.16;
    return [dzT('{title}', W * 0.06, H * 0.04, W * 0.88, Math.min(W * 0.065, H * 0.05), { font: '@1', al: 'center', fit: 1, ...dzG([['@fg', 0], ['@accent', 1]], 0) }),
      dzS('heart', hx, hy, d, d * 0.92, { fill: '@soft' }), dzPh(0, hx, hy, d, d * 0.92, { clip: 1 }),
      dzT('{placement}', W * 0.08, hy + d * 0.92 + H * 0.03, W * 0.84, Math.min(W * 0.04, H * 0.03), { al: 'center', c: '@accent' }),
      dzT('{tags}', W * 0.08, H * 0.92, W * 0.84, Math.min(W * 0.03, H * 0.022), { al: 'center', c: '@soft' }), dzMark(W, H, { y: H - W * 0.16 })]; }]
];
// Layout choices for a type: built-in ones, your saved templates, then a blank page.
const dzCustom = () => { try { return JSON.parse(Settings.get('dz_tpls', '[]')); } catch { return []; } };
function dzLayouts(kind) {
  const built = DZ_KINDS[kind]?.social ? [...DZ_TATTOO, ...DZ_TEMPLATES.post] : kind === 'challenge' ? dzChTemplates() : DZ_TEMPLATES[kind];
  return [...(built || []).map(t => ({ name: t[0], make: t[1], chal: t[2] })), ...dzCustom().filter(c => c.kind === kind).map(c => ({ name: c.name, custom: c })), { name: 'Blank' }];
}
// A portfolio piece for a post: its photos (in order) and details.
async function dzPiece(id) {
  const it = await DB.one('SELECT * FROM portfolio_items WHERE id = ?', [id]); if (!it) return null;
  const photos = await DB.all('SELECT photo_ref, thumb_ref, label FROM portfolio_photos WHERE item_id = ? ORDER BY sort, id', [id]);
  return { id, photos, vals: { title: it.title || '', placement: it.placement || '', tags: it.tags || '', date: it.made_on || '' }, thumb: photos[0]?.thumb_ref };
}
// Fills photo spots with a piece's photos (a "Fresh & healed" layout looks for photos labelled that way first).
function dzFillSlots(doc, piece) {
  if (!piece) return;
  doc.vals = { ...doc.vals, ...piece.vals, piece: piece.id };
  const used = new Set(), pick = (want) => {
    const byLabel = want && piece.photos.find(p => (p.label || '').toLowerCase() === want && !used.has(p.photo_ref));
    const p = byLabel || piece.photos.find(p => !used.has(p.photo_ref)); if (p) used.add(p.photo_ref); return p?.photo_ref || null; };
  const fh = doc.layers.some(l => l.t === 'text' && l.text === 'Healed');
  for (const l of doc.layers.filter(l => l.slot != null).sort((a, b) => a.slot - b.slot)) l.ref = pick(fh ? (l.slot === 0 ? 'fresh' : l.slot === 1 ? 'healed' : '') : '') || l.ref || null;
}
function dzNew(kind, opt, theme, piece, size, sides) {
  const k = DZ_KINDS[kind], code = Math.random().toString(36).slice(2, 8).toUpperCase(), exp = new Date(); exp.setFullYear(exp.getFullYear() + 1);
  let doc;
  if (opt?.custom) { doc = JSON.parse(JSON.stringify(opt.custom.doc)); { const ids = new Map(); doc.layers.forEach(l => { const n = dzId(); ids.set(l.id, n); l.id = n; }); doc.layers.forEach(l => { if (l.on) { l.on = ids.get(l.on); delete l._bx; } }); } doc.theme = theme || doc.theme; }
  else doc = { v: 1, kind, w: k.w, h: k.h, theme, bg: { c: '@bg' }, layers: opt?.make ? opt.make(k.w, k.h) : [] };
  doc.kind = kind; doc.w = k.w; doc.h = k.h;
  delete doc.dpi; delete doc.paper; delete doc.fold;
  if (k.social) delete doc.sides; else if (sides || size?.fold) doc.sides = 2; else if (!opt?.custom) delete doc.sides;
  if (opt?.make && !doc.sides && !k.form) { doc.layers = doc.layers.filter(l => l.side !== 'b'); doc.layers.forEach(l => delete l.side); }
  if (size) { doc.w = size.w; doc.h = size.h; doc.dpi = size.dpi;
    doc.paper = size.fold ? `${size.label}, ${size.sheet} sheet (${dzMM(size.mm[0])} × ${dzMM(size.mm[1])} mm)` : `${size.label}, ${dzMM(size.mm[0])} × ${dzMM(size.mm[1])} mm`;
    if (size.fold) doc.fold = size.fold; }
  doc.vals = kind === 'voucher' ? { amount: '', to: '', from: '', ...(opt?.custom ? doc.vals : {}), code, expires: ymd(exp) } : {};
  if (k.form) ffSetup(doc, opt?.make);
  if (k.chal) { delete doc.sides; doc.dpi = 254; doc.paper = 'Challenge: 180 × 130 mm of skin'; if (!opt?.custom) doc.bg = { c: '#e2b493' }; doc.chal = { text: '', pal: 'default', lock: true, ...(opt?.chal || {}), ...(doc.chal || {}) }; if (!opt?.chal && !opt?.custom && !doc.layers.length) doc.chal.setup = false;   /* blank: the setup asks first */ if (doc.chal.base) { doc.chal.sig = dzChSig(doc); doc.chal.baseText = doc.chal.text; } }
  if (k.pattern) { delete doc.sides; doc.pat = { ring: 1, fade: 0.38, clear: true, ...(size?.pat || {}) }; if (size) doc.paper = `Pattern tile, ${dzMM(size.mm[0])} × ${dzMM(size.mm[1])} mm`; }
  dzFillSlots(doc, piece);
  return doc;
}
/* Note-only layers. A shortcut is one big thumb-sized tile (icon and name) that opens part of the app; a checklist is
   rows of tick boxes, custom or from the shopping list. Drawn here for the editor; a pinned note shows them as real
   links and checkboxes. */
const dzInkOn = (doc) => { const c = String(doc.bg?.c || '#ffe27a'); if (c[0] !== '#' || c.length < 7) return '#222'; const v = parseInt(c.slice(1, 3), 16) * 0.3 + parseInt(c.slice(3, 5), 16) * 0.59 + parseInt(c.slice(5, 7), 16) * 0.11; return v < 110 ? '#f4f1ea' : '#222'; };
const dzIcoCache = new Map();
function dzIcoImg(svg, col) { const k = col + svg; if (dzIcoCache.has(k)) return dzIcoCache.get(k);
  const src = String(svg).replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" fill="none" stroke="${col}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" `);
  const p = new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = 'data:image/svg+xml,' + encodeURIComponent(src); }); dzIcoCache.set(k, p); return p; }
const dzCheckH = (l) => { const s = l.size || 64; return (l.title ? s * 1.7 : 0) + Math.max(1, l.items?.length || 0) * s * 2.1 + s * 0.4; };
function dzNoteDraw(x, l, doc, ico) { const col = dzInkOn(doc), w = l.w, h = l.h; x.strokeStyle = col; x.fillStyle = col; x.textAlign = 'left'; x.textBaseline = 'middle';
  const fit = (s, mx) => { if (x.measureText(s).width <= mx) return s; while (s.length > 1 && x.measureText(s + '…').width > mx) s = s.slice(0, -1); return s + '…'; };
  if (l.t === 'shortcut') { x.save(); x.globalAlpha *= 0.14; x.beginPath(); x.roundRect(-w / 2, -h / 2, w, h, w * 0.08); x.fill(); x.restore();
    const f = Math.min(w, h) * 0.11, sz = Math.min(w, h) * 0.56; if (ico) x.drawImage(ico, -sz / 2, -h * 0.4, sz, sz);
    x.font = `700 ${f}px Inter, sans-serif`; x.textAlign = 'center'; x.fillText(fit(l.label || 'Shortcut', w * 0.9), 0, h * 0.33); return; }
  const s = l.size || 64, row = s * 2.1; let y = -h / 2 + s * 0.2;
  if (l.title) { x.font = `800 ${s * 1.1}px Inter, sans-serif`; x.fillText(fit(l.title, w), -w / 2, y + s * 0.8); y += s * 1.7; }
  for (const it of (l.items?.length ? l.items : [{ s: 'Nothing on it yet' }])) { const cy = y + row / 2, bx = -w / 2 + 4; x.lineWidth = s * 0.08; x.beginPath(); x.roundRect(bx, cy - s * 0.55, s * 1.1, s * 1.1, s * 0.18); x.stroke();
    if (it.on) { x.beginPath(); x.moveTo(bx + s * 0.22, cy); x.lineTo(bx + s * 0.48, cy + s * 0.28); x.lineTo(bx + s * 0.9, cy - s * 0.3); x.stroke(); }
    x.font = `600 ${s}px Inter, sans-serif`; const t = fit(it.s, w - s * 1.5); x.fillText(t, bx + s * 1.4, cy); if (it.on) { x.lineWidth = s * 0.05; x.beginPath(); x.moveTo(bx + s * 1.4, cy); x.lineTo(bx + s * 1.4 + x.measureText(t).width, cy); x.stroke(); } y += row; } }
/* Sticky notes: ordinary designs (kind 'note') of a fixed width that grow downwards. doc.note holds whether it's
   pinned to the menu screens and its quick links; the overlay that shows them lives in app.js. */
const DZ_NOTE_COLS = ['#ffe27a', '#ffb3c7', '#a9e4ff', '#b6f0b1', '#ffc48a', '#d7c2ff', '#ffffff', '#2b2f31'];
async function dzNoteNew(col = DZ_NOTE_COLS[0]) {
  const doc = dzNew('note', null, 'paper'); doc.bg = { c: col }; doc.note = { pin: true, links: [] };
  const n = (await DB.one('SELECT COUNT(*) AS n FROM designs WHERE kind = ?', ['note'])).n;
  await DB.run('INSERT INTO designs (name, kind, doc) VALUES (?, ?, ?)', ['Sticky note' + (n ? ' ' + (n + 1) : ''), 'note', JSON.stringify(doc)]);
  const id = (await DB.one('SELECT last_insert_rowid() AS id')).id; await dzThumb(id, doc); location.hash = 'design/' + id; return id;
}
// Saves a design's thumbnail for the list (also used right after creating one).
async function dzThumb(id, doc) {
  const th = await dzCanvas(doc, 360 / Math.max(doc.w, doc.h));
  const ref = await Media.save(await new Promise(r => th.toBlob(r, 'image/jpeg', 0.8)), 'jpg');
  const old = (await DB.one('SELECT thumb_ref FROM designs WHERE id = ?', [id]))?.thumb_ref;
  await DB.run('UPDATE designs SET thumb_ref = ? WHERE id = ?', [ref, id]);
  if (old && old !== ref) await Media.release(old);
}
// Grid of portfolio pieces (or their photos) to pick from. Resolves the id / photo_ref, or null.
// The standard picker for anything imported from inside the app: folders like an explorer plus a search over everything.
// photos: true = portfolio photos, 'place' = ink-only portfolio photos (with From this device, resolving '@file'), 'refs' = references, 'sten' = kept stencils (resolves the stencil_ref), false = whole portfolio pieces.
function dzPortfolioPick(photos) {
  return new Promise(async (res) => {
    const rows = photos === 'sten'
      ? await DB.all(`SELECT stencil_ref AS v, thumb_ref AS t, name AS title, id AS pid FROM stencils ORDER BY created_at DESC, id DESC`)
      : photos === 'refs'
      ? await DB.all(`SELECT photo_ref AS v, thumb_ref AS t, title, category AS f FROM ref_images ORDER BY created_at DESC`)
      : photos
      ? await DB.all(`SELECT x.photo_ref AS v, x.thumb_ref AS t, p.title, p.id AS pid FROM portfolio_photos x JOIN portfolio_items p ON p.id = x.item_id
          ${photos === 'place' ? `WHERE x.label = 'Ink only (clear background)'` : ''} ORDER BY coalesce(p.made_on, p.created_at) DESC, x.sort`)
      : await DB.all(`SELECT p.id AS v, p.id AS pid, p.title, (SELECT thumb_ref FROM portfolio_photos x WHERE x.item_id = p.id ORDER BY sort, id LIMIT 1) AS t
          FROM portfolio_items p WHERE EXISTS (SELECT 1 FROM portfolio_photos x WHERE x.item_id = p.id) ORDER BY coalesce(p.made_on, p.created_at) DESC`);
    if (!rows.length && photos !== 'place') { toast(photos === 'sten' ? 'No stencils kept yet: make one in the stencil maker and press Keep.' : photos === 'refs' ? 'No references yet: add some in Portfolio › References.' : 'Add tattoos with photos to your portfolio first.'); return res(null); }
    /* Folders, as in an explorer: reference categories, or the folders made in the portfolio's organiser. */
    if (photos !== 'refs') { const o = Lib.org(photos === 'sten' ? 'stencils' : 'portfolio'); for (const r of rows) r.f = o.in[r.pid] || ''; }
    for (const r of rows) r.f = (r.f || '').trim();
    const folders = [...new Set(rows.map(r => r.f).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    const urls = new Map(), url = async (r) => { if (!urls.has(r.t)) urls.set(r.t, await Media.url(r.t)); return urls.get(r.t); };
    let at = '', q = '';
    const o = document.createElement('div'); o.id = 'merge-dlg'; o.style.zIndex = 99;
    o.innerHTML = `<div class="card dz-pick"><h2>${photos === 'place' ? 'Place a tattoo' : photos === 'sten' ? 'Your stencils' : photos === 'refs' ? 'Choose a reference' : photos ? 'Choose a photo' : 'Choose a portfolio piece'}</h2>
      <input class="in dz-pfq" type="search" placeholder="Search everything" aria-label="Search">
      <div class="dz-pfpath"></div><div class="dz-pf ${photos === 'sten' ? 'dz-pfsten' : photos === 'place' ? 'dz-pfplace' : ''}"></div>
      ${photos === 'place' ? `<div class="row" style="gap:8px;margin-top:10px"><button class="btn" data-v="">Cancel</button><span style="flex:1"></span><button class="btn" data-v="@file">From this device</button></div>`
        : `<button class="btn" data-v="" style="width:100%;margin-top:10px">Cancel</button>`}</div>`;
    const grid = o.querySelector('.dz-pf'), path = o.querySelector('.dz-pfpath');
    const draw = async () => { const ql = q.trim().toLowerCase();
      const list = ql ? rows.filter(r => `${r.title || ''} ${r.f}`.toLowerCase().includes(ql)) : rows.filter(r => r.f === at);
      const dirs = ql || at ? [] : folders;
      path.innerHTML = ql ? `<span class="muted">${list.length} found</span>` : at ? `<button class="lib-chip" data-up>‹ All folders</button><b>${LIB_FOLDER}${esc(at)}</b>` : '';
      const u = await Promise.all(list.map(url));
      grid.innerHTML = dirs.map(f => `<button class="dz-pfdir" data-dir="${esc(f)}">${LIB_FOLDER}<span>${esc(f)}</span><em>${rows.filter(r => r.f === f).length}</em></button>`).join('')
        + list.map((r, i) => `<button data-v="${esc(r.v)}" title="${esc(r.title || '')}"><img src="${u[i]}" alt="" loading="lazy"></button>`).join('')
        + (!dirs.length && !list.length ? `<p class="muted" style="grid-column:1/-1">${rows.length ? 'Nothing here.' : 'Nothing yet: tattoos saved to the portfolio from the simulator show up here.'}</p>` : ''); };
    o.oninput = (e) => { if (e.target.matches('.dz-pfq')) { q = e.target.value; draw(); } };
    o.onclick = (e) => { const t = e.target;
      if (t.closest('[data-up]')) { at = ''; return draw(); }
      const d = t.closest('[data-dir]'); if (d) { at = d.dataset.dir; return draw(); }
      const b = t.closest('[data-v]'); if (!b) return; o.remove(); res(b.dataset.v ? (photos ? b.dataset.v : +b.dataset.v) : null); };
    if (!rows.length) o.querySelector('.dz-pfq').hidden = true;
    document.body.appendChild(o); await draw();
  });
}

/* ---------- List of designs ---------- */
const DZ = {};
DZ.list = async () => {
  const el = $('#dz-list'); if (!el) return;
  const rows = await DB.all('SELECT id, name, kind, thumb_ref, updated_at, CASE WHEN kind = ? THEN doc END AS doc FROM designs ORDER BY updated_at DESC, id DESC', ['page']);
  const urls = await Promise.all(rows.map(r => Media.url(r.thumb_ref)));
  const all = rows.map((r, i) => { const sub = r.kind === 'page' ? (JSON.parse(r.doc || '{}').paper || 'Blank page').split(',')[0] + ' page' : DZ_KINDS[r.kind]?.label || '';
    return { ...r, url: urls[i], sub, kind: r.kind === 'page' ? 'Page' : DZ_KINDS[r.kind]?.label || r.kind, t: r.updated_at }; }), shown = Lib.apply('designs', all);
  el.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="muted" style="margin:0;flex:1;font-size:13px">Vouchers, business cards, flyers and posts with your studio's details.</p>
      <button class="btn primary" id="dz-new">+ New design</button></div>
    ${rows.length ? Lib.bar('designs', all) + (shown.length ? `<div class="dz-grid">${shown.map((r) => `<div class="dz-item" data-open="${r.id}">${Lib.tools('designs', r.id)}
        <div class="dz-thumb">${r.url ? `<img src="${r.url}" alt="">` : ''}</div>
        <div class="dz-meta"><b>${esc(r.name)}</b><span class="muted">${esc(r.sub)}</span></div>
        <button class="mini" data-dup="${r.id}" aria-label="Duplicate" data-tip="Duplicate">⧉</button>
        <button class="mini del" data-del="${r.id}" aria-label="Delete">&times;</button></div>`).join('')}</div>` : Lib.empty)
      : `<div class="empty"><div class="empty-ico">${ICON.design}</div><div style="font:24px var(--display)">Make something</div>
         <div class="muted">Start from a template; your studio name, logo and details fill in for you.</div></div>`}`;
  Lib.wire(el, 'designs', DZ.list);
  el.onclick = async (e) => {
    if (await Lib.click(e, 'designs', DZ.list)) return;
    const t = e.target, d = (k) => t.closest(`[data-${k}]`)?.dataset[k];
    if (t.closest('#dz-new')) return dzPicker();
    if (d('del')) {
      const r = await DB.one('SELECT name, thumb_ref FROM designs WHERE id = ?', [+d('del')]);
      if (!r || !await ask(`Delete "${r.name}"?`)) return;
      const id0 = +d('del'), refs = (await DB.all('SELECT ref FROM design_assets WHERE design_id = ?', [id0])).map(x => x.ref), rp = Settings.get('dz_refs_' + id0, '');
      const snap = await Undel.snap([['designs', 'id = ?', [id0]], ['design_assets', 'design_id = ?', [id0]]]);
      await DB.run('DELETE FROM designs WHERE id = ?', [id0]); Settings.set('dz_refs_' + id0, '');   /* its reference pictures go too */
      Undel.offer(`Deleted "${r.name}".`, snap, [r.thumb_ref, ...refs], DZ.list, () => rp && Settings.set('dz_refs_' + id0, rp));
      return DZ.list();
    }
    if (d('dup')) {
      const r = await DB.one('SELECT * FROM designs WHERE id = ?', [+d('dup')]);
      await DB.run('INSERT INTO designs (name, kind, doc, thumb_ref) VALUES (?, ?, ?, ?)', [r.name + ' (copy)', r.kind, r.doc, r.thumb_ref]);
      const nid = (await DB.one('SELECT last_insert_rowid() AS id')).id;
      await DB.run('INSERT INTO design_assets (design_id, ref) SELECT ?, ref FROM design_assets WHERE design_id = ?', [nid, r.id]);
      return DZ.list();
    }
    if (d('open')) location.hash = 'design/' + d('open');
  };
};

// New design: pick what it is, then a layout and a theme (previews drawn with your own details and photos).
// opts.piece: start a post from this portfolio piece (only post sizes are offered).
async function dzPicker(opts = {}) {
  const st = { kind: opts.kind || null, li: 0, theme: opts.kind === 'form' ? 'paper' : 'ink', piece: opts.piece ? await dzPiece(opts.piece) : null,
    ps: Settings.get('dz_paper', 'A4'), land: false, cw: 200, ch: 200, cu: 'mm', ft: 'tri', fs: Settings.get('dz_fold_sheet', 'A4'), two: false,
    pat: { w: 60, ra: 1, rb: 1, ring: 1, clear: true } };
  // The chosen blank page size (mm, turned for landscape) at its dpi.
  const size = () => {
    if (DZ_KINDS[st.kind]?.fold) return dzFold(st.ft, st.fs);
    if (DZ_KINDS[st.kind]?.pattern) { const P = st.pat, z = dzPaper(P.w, Math.round(P.w * P.rb / P.ra * 10) / 10, 'Pattern'); z.pat = { ring: P.ring, clear: P.clear }; return z; }
    if (!DZ_KINDS[st.kind]?.page) return null;
    const f = { mm: 1, cm: 10, in: 25.4 }[st.cu], p = DZ_PAPER.find(x => x[0] === st.ps);
    let [w, h] = p ? [p[1], p[2]] : [Math.min(1200, Math.max(20, st.cw * f)), Math.min(1200, Math.max(20, st.ch * f))];
    if (p && st.land !== w > h) [w, h] = [h, w];
    return dzPaper(w, h, p ? p[0] : 'Custom');
  };
  const o = document.createElement('div'); o.id = 'merge-dlg';
  const kinds = Object.entries(DZ_KINDS).filter(([, v]) => !st.piece || v.social);
  o.addEventListener('change', (e) => { if (!e.target.matches('[data-patwi]')) return; const v = parseFloat(e.target.value); if (v > 0) { st.pat.w = Math.min(1000, Math.max(5, v)); draw(); } });
  const draw = async () => {
    if (!st.kind) {
      o.innerHTML = `<div class="card dz-pick"><h2>${st.piece ? 'Make a post' : 'New design'}</h2>
        ${st.piece ? '' : '<div class="lbl">Print</div>'}<div class="dz-kinds">${kinds.filter(([, v]) => !v.social).map(([k, v]) =>
          `<button data-kind="${k}"><svg viewBox="0 0 24 24" class="dz-kic">${DZ_KIND_IC[k] || DZ_KIND_IC.page}</svg><b>${v.label}</b><small>${v.sub}</small></button>`).join('')}</div>
        <div class="lbl" style="margin-top:10px">Social posts ${st.piece ? '' : '<span class="muted">(show off a tattoo)</span>'}</div><div class="dz-kinds three">${kinds.filter(([, v]) => v.social).map(([k, v]) =>
          `<button data-kind="${k}"><svg viewBox="0 0 24 24" class="dz-kic">${DZ_KIND_IC[k] || DZ_KIND_IC.page}</svg><b>${v.label}</b><small>${v.sub}</small></button>`).join('')}</div>
        <button class="btn" data-x style="width:100%;margin-top:12px">Cancel</button></div>`;
      return;
    }
    const lays = dzLayouts(st.kind), social = DZ_KINDS[st.kind].social, pu = st.piece ? await Media.url(st.piece.thumb) : '';
    const sz = size();
    o.innerHTML = `<div class="card dz-pick dz-pick2"><h2>${DZ_KINDS[st.kind].label}</h2><div class="dz-pk2"><div class="dz-pkL">
      ${sz?.fold ? `<div class="lbl">Fold</div><div class="dz-papers">${Object.entries(DZ_FOLD_TYPES).map(([k, v]) =>
          `<button data-ft="${k}" class="${st.ft === k ? 'on' : ''}"><b>${v.name}</b><small>${v.sub}</small></button>`).join('')}</div>
        <div class="lbl" style="margin-top:10px">Sheet, laid flat</div><div class="dz-papers">${DZ_FOLD_SHEETS.map(n => { const pp = DZ_PAPER.find(x => x[0] === n);
          return `<button data-fs="${n}" class="${st.fs === n ? 'on' : ''}"><b>${n}</b><small>${dzMM(pp[2])} × ${dzMM(pp[1])}</small></button>`; }).join('')}</div>
        <p class="muted" style="font-size:12px;margin:6px 0 12px">You design both sides: the outside on top, the inside below it, with the folds marked.
          Panels: ${sz.fold.lo.join(', ')}. ${sz.dpi} dpi.</p>` : ''}
      ${DZ_KINDS[st.kind].pattern ? patOptsHtml(st.pat) : ''}
      ${sz && !sz.fold && !sz.pat ? `<div class="lbl">Size</div><div class="dz-papers">${[...DZ_PAPER.map(x => x[0]), 'Custom'].map(n => {
          const pp = DZ_PAPER.find(x => x[0] === n);
          return `<button data-ps="${esc(n)}" class="${st.ps === n ? 'on' : ''}"><b>${esc(n)}</b><small>${pp ? `${dzMM(pp[1])} × ${dzMM(pp[2])}` : 'your size'}</small></button>`; }).join('')}</div>
        ${st.ps === 'Custom' ? `<div class="dz-csize"><label><span>W</span><input class="in" type="text" inputmode="text" data-calc min="0" step="any" data-cs="cw" value="${st.cw}"></label>
          <span class="muted">×</span><label><span>H</span><input class="in" type="text" inputmode="text" data-calc min="0" step="any" data-cs="ch" value="${st.ch}"></label>
          <select class="in" data-cs="cu">${['mm', 'cm', 'in'].map(u => `<option ${st.cu === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>`
        : `<div class="seg" style="margin-top:8px">${[[false, 'Portrait'], [true, 'Landscape']].map(([v, n]) => `<button data-land="${v ? 1 : 0}" class="${st.land === v ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>`}
        <p class="muted" style="font-size:12px;margin:6px 0 12px">${dzMM(sz.mm[0])} × ${dzMM(sz.mm[1])} mm, ${sz.w} × ${sz.h} px at ${sz.dpi} dpi${sz.dpi < 300 ? ' (large pages use a lower dpi so they open on phones and tablets)' : ''}.</p>` : ''}
      ${social ? `<div class="dz-piece">${pu ? `<img src="${pu}" alt="">` : '<span class="muted">No tattoo chosen</span>'}
        <div><b>${esc(st.piece?.vals.title || (st.piece ? 'Untitled piece' : 'Show off a tattoo'))}</b><small class="muted">${st.piece ? `${st.piece.photos.length} photo${st.piece.photos.length > 1 ? 's' : ''}` : 'Pick a portfolio piece to fill the photos, title and hashtags'}</small></div>
        <button class="btn small" data-piece>${st.piece ? 'Change' : 'Choose'}</button></div>` : ''}
      ${!social && !sz?.fold && !sz?.pat && !DZ_KINDS[st.kind].chal ? `<div class="lbl">Sides</div><div class="seg" style="margin-bottom:12px">${[[false, 'One side'], [true, 'Front and back']].map(([v, n]) =>
          `<button data-two="${v ? 1 : 0}" class="${st.two === v ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>` : ''}
      </div><div class="dz-pkR"><div class="lbl">Layout</div><div class="dz-tpls">${lays.map((l, i) =>
        `<button data-li="${i}" class="${st.li === i ? 'on' : ''}"><canvas data-prev="${i}"></canvas><span>${esc(l.name)}${l.custom ? ' <em>yours</em>' : ''}</span>
          ${l.custom ? `<i class="dz-tdel" data-tdel="${esc(l.custom.id)}" title="Delete this template">&times;</i>` : ''}</button>`).join('')}</div>
      <div class="lbl" style="margin-top:12px">Theme</div><div class="dz-themes">${Object.entries(DZ_THEMES).map(([k, t]) =>
        `<button data-theme="${k}" class="${st.theme === k ? 'on' : ''}"><i style="background:${t.bg}"></i><i style="background:${t.accent}"></i><i style="background:${t.fg}"></i><span>${t.name}</span></button>`).join('')}</div>
      </div></div><div class="row dz-pkfoot"><button class="btn" data-back>Back</button><button class="btn primary" data-go style="flex:1">Create</button></div></div>`;
    for (const cv of o.querySelectorAll('canvas[data-prev]')) {
      const doc = dzNew(st.kind, lays[+cv.dataset.prev], st.theme, st.piece, sz, st.two), sc = 220 / Math.max(doc.w, doc.h);
      cv.width = Math.round(doc.w * sc); cv.height = Math.round(doc.h * sc); dzDraw(cv, doc, sc);
    }
  };
  o.onclick = async (e) => {
    const t = e.target, d = (k) => t.closest(`[data-${k}]`)?.dataset[k];
    if (t.closest('[data-x]')) return o.remove();
    if (d('kind') === 'note') { o.remove(); return dzNoteNew(); }
    if (d('kind') === 'challenge' && typeof TATTOO_VERSION === 'undefined') await new Promise((res) => { const s = document.createElement('script'); s.src = 'tattoo.js'; s.onload = s.onerror = res; document.head.appendChild(s); });   /* the lesson templates come from the simulator */
    if (d('kind')) { st.kind = d('kind'); st.li = 0; st.two = false; return draw(); }
    if (d('two') != null) { st.two = d('two') === '1'; return draw(); }
    if (DZ_KINDS[st.kind]?.pattern && patOptsAct(st.pat, t)) return draw();
    if (t.closest('[data-back]')) { st.kind = null; return draw(); }
    if (d('tdel')) { e.stopPropagation();
      if (!await ask('Delete this template? Designs made from it are not affected.')) return;
      await Settings.set('dz_tpls', JSON.stringify(dzCustom().filter(c => c.id !== d('tdel')))); st.li = 0; return draw(); }
    if (t.closest('[data-piece]')) { const id = await dzPortfolioPick(false); if (id) { st.piece = await dzPiece(id); draw(); } return; }
    if (d('li') != null) { st.li = +d('li'); o.querySelectorAll('[data-li]').forEach(b => b.classList.toggle('on', +b.dataset.li === st.li)); return; }
    if (d('theme')) { st.theme = d('theme'); return draw(); }
    if (d('ps')) { st.ps = d('ps'); return draw(); }
    if (d('ft')) { st.ft = d('ft'); return draw(); }
    if (d('fs')) { st.fs = d('fs'); return draw(); }
    if (d('land') != null) { st.land = d('land') === '1'; return draw(); }
    if (t.closest('[data-go]')) {
      const sz = size();
      if (sz) await Settings.set(sz.fold ? 'dz_fold_sheet' : 'dz_paper', sz.fold ? st.fs : st.ps);
      const doc = dzNew(st.kind, dzLayouts(st.kind)[st.li], st.theme, st.piece, sz, st.two);
      const n = await DB.one('SELECT COUNT(*) AS n FROM designs WHERE kind = ?', [st.kind]);
      const base = sz?.pat ? 'Pattern tile' : sz ? (sz.fold ? `${sz.label} pamphlet` : `${sz.label} page`) : DZ_KINDS[st.kind].label;
      const name = st.piece?.vals.title ? `${st.piece.vals.title} (${DZ_KINDS[st.kind].label.toLowerCase()})` : base + (n.n ? ' ' + (n.n + 1) : '');
      await DB.run('INSERT INTO designs (name, kind, doc) VALUES (?, ?, ?)', [name, st.kind, JSON.stringify(doc)]);
      const id = (await DB.one('SELECT last_insert_rowid() AS id')).id;
      // Photos used by the post count as this design's pictures (kept in backups).
      for (const r of [...new Set(doc.layers.filter(l => l.ref).map(l => l.ref))]) await DB.run('INSERT INTO design_assets (design_id, ref) VALUES (?, ?)', [id, r]);
      await dzThumb(id, doc);
      o.remove(); location.hash = 'design/' + id;
    }
  };
  // Custom size: typing updates the numbers below without redrawing (keeps the keyboard up); leaving the box redraws.
  o.addEventListener('input', (e) => { const k = e.target.dataset.cs; if (k === 'cw' || k === 'ch') st[k] = +e.target.value || 0; });
  o.addEventListener('change', (e) => { const k = e.target.dataset.cs; if (!k) return; if (k === 'cu') st.cu = e.target.value; else st[k] = +e.target.value || 0; draw(); });
  document.body.appendChild(o); draw();
}
DZ.post = (pieceId) => dzPicker({ piece: pieceId });

/* ---------- Editor ---------- */
DZ.edit = async (id) => {
  const el = $('#dz'); if (!el) return;
  const row = await DB.one('SELECT * FROM designs WHERE id = ?', [id]);
  if (!row) { location.hash = 'designs'; return; }
  let doc = JSON.parse(row.doc), sel = null, panel = null, name = row.name;
  doc.vals ||= {}; doc.bg ||= { c: '@bg' };
  const hist = [JSON.stringify(doc)]; let hi = 0;
  let adjS = null;   // Adjust colour in progress: the picture shows a stand-in copy (adjS.tmp) until Apply or Cancel
  const docJSON = () => { const s2 = JSON.stringify(doc); return adjS ? s2.split('"' + adjS.tmp + '"').join('"' + adjS.ref + '"') : s2; };   // saved and undo copies always name the real picture
  el.innerHTML = `<div class="dz-ed">
    <div class="dz-top">
      <button class="dz-ib" id="dz-back" aria-label="Back" data-tip="Back to your designs"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <input class="dz-name" id="dz-name" value="${esc(name)}" aria-label="Design name">
      <span class="dz-tsp"></span>
      <button class="dz-ib" id="dz-hide" data-tip="Focus: hide all the panels" aria-label="Focus"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="2.5"/></svg></button>
      <button class="dz-ib" id="dz-panels" data-tip="Panels: show or hide each one" aria-label="Panels"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M3 9h6"/></svg></button>
      <button class="dz-ib" id="dz-undo" aria-label="Undo" data-tip="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
      <button class="dz-ib" id="dz-redo" aria-label="Redo" data-tip="Redo"><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg></button>
      <button class="dz-ib" id="dz-focus" aria-label="Full screen design" data-tip="Full screen: the design fills the screen (Focus hides the panels)"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
      <button class="dz-ib" id="dz-tpl" aria-label="Save as template" data-tip="Save as template, to start new designs from it"><svg viewBox="0 0 24 24">${DZ_UI.tpl}</svg></button>
      <button class="dz-ib dz-go" id="dz-export" aria-label="Export" data-tip="Export: print, save or share"><svg viewBox="0 0 24 24">${DZ_UI.export}</svg></button>
    </div>
    <div class="dz-ctxw"><div class="dz-ctx" id="dz-ctx"></div><div class="dz-csnap" id="dz-csnap"></div></div>
    <div class="dz-body">
      <div class="dz-stage" id="dz-stage">
        <canvas id="dz-patcv" hidden></canvas><div class="tt-qs dz-qstrip" id="dz-qstrip"></div><div class="tt-refs dz-refs" id="dz-refs"></div>
        <div class="dz-rail" id="dz-rail">
          ${dzIB('data-rail="select"', 'select', 'Select and move')}
          ${dzIB('data-rail="nodes"', 'nodes', 'Edit nodes (A): reshape a shape point by point. Or double-tap a shape.')}
          ${doc.kind === 'form' ? dzIB('data-rail="fields"', 'frametext', 'Form fields') : ''}
          ${dzIB('data-rail="text"', 'text', 'Text')}
          ${dzIB('data-rail="image"', 'picture', 'Picture')}
          ${dzIB('data-rail="shape"', 'shape', 'Shape')}
          ${dzIB('data-add="pen"', 'pen', 'Pen (P)')}
          ${dzIB('data-add="pencil"', 'pencil', 'Pencil (N)')}
          ${doc.chal ? dzIB('data-rail="chal"', '<path d="M6 3h12v5a6 6 0 0 1-12 0z"/><path d="M12 14v4M8 21h8"/><path d="M9.5 7.5l1.6 1.6 3.4-3.4"/>', 'Challenge: instructions, palette, and play it in the simulator') : ''}
          ${doc.pat ? dzIB('data-rail="pattern"', '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1" stroke-dasharray="2 1.5"/><rect x="3" y="13" width="8" height="8" rx="1" stroke-dasharray="2 1.5"/><rect x="13" y="13" width="8" height="8" rx="1" stroke-dasharray="2 1.5"/><circle cx="7" cy="7" r="1.6"/>', 'Pattern: cell size, neighbours, fit, and save the tile') : ''}
          ${dzIB('data-rail="grid"', '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>', 'Grid and perspective, with snapping')}
          <i class="sep"></i>
          ${dzIB('data-rail="layers"', 'layers', 'Layers')}
          ${dzIB('data-rail="doc"', 'page', 'Page: theme, background, sides and details')}
          ${dzIB('data-rail="refs" hidden', '<rect x="3" y="6" width="13" height="11" rx="1.5"/><path d="M8 3h13v11"/><circle cx="7.5" cy="10" r="1.5"/><path d="M16 15l-4-4-6 6"/>', 'Reference pictures: float over the design to follow, never printed')}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg,image/*" hidden id="dz-file"></div>
        <div class="dz-pop" id="dz-pop" hidden></div>
        <div class="dz-page ${doc.kind === 'note' ? 'is-note' : ''}" id="dz-page"><canvas id="dz-cv"></canvas><canvas id="dz-gridcv" hidden></canvas><div id="dz-vps"></div>${doc.kind === 'note' ? '<div class="dz-nguide" aria-hidden="true"><i class="s"><b>Top strip (on hover or tap)</b></i><i class="b"></i><i class="f"><b>Scrolls below this line</b></i></div>' : ''}<div id="dz-folds"></div><div id="dz-multi"></div><canvas id="dz-cutcv"></canvas><canvas id="dz-nodecv"></canvas><canvas id="dz-contcv"></canvas><canvas id="dz-pencv"></canvas><div id="dz-sel" hidden>
        <i class="h nw" data-h="nw"></i><i class="h ne" data-h="ne"></i><i class="h sw" data-h="sw"></i><i class="h se" data-h="se"></i>
        <i class="h e" data-h="e"></i><i class="h w" data-h="w"></i><i class="h n" data-h="n"></i><i class="h s" data-h="s"></i><i class="h rot" data-h="rot"></i></div>
        <i class="dz-guide v" hidden></i><i class="dz-guide hz" hidden></i></div>
        <div class="dz-xf" id="dz-xf" hidden></div>
        <div class="dz-faces" id="dz-faces"></div>
        ${doc.kind === 'note' ? '<div class="dz-notebar" id="dz-notebar"></div>' : ''}
        <div id="dz-qs" class="dz-qs" hidden><span class="dz-qs-what"></span><div class="dz-qs-row"><span>Yours</span><input type="range" min="0" max="100" step="1" value="50" aria-label="Closer to what you drew, or cleaner"><span>Cleaner</span></div><div class="dz-qs-row"><button class="btn small" data-qs="no" title="Put back the shape it snapped to">Cancel</button><button class="btn small primary" data-qs="ok">Keep</button></div></div><div id="dz-marq" hidden></div><div class="dz-mods" id="dz-mods" hidden><button data-mod="shift" title="Shift: straight lines, 45° steps, keep proportions">⇧ Shift</button><button data-mod="alt" title="Alt: break a handle, a sharp turn, move freely">⌥ Alt</button><button data-mod="ctrl" title="Ctrl: no snapping, pick several">Ctrl</button></div><div class="dz-zoom"><button data-z="out" aria-label="Zoom out">−</button><button data-z="fit" id="dz-zl" data-tip="Show the whole design">Fit</button><button data-z="in" aria-label="Zoom in">+</button></div></div>
      <div class="dz-side" id="dz-side" hidden></div>
    </div></div>`;
  const cv = $('#dz-cv'), page = $('#dz-page'), stage = $('#dz-stage'), selBox = $('#dz-sel'), side = $('#dz-side');
  let k = 1;   // screen px per page px
  const layer = () => doc.layers.find(l => l.id === sel);
  // Two-sided: the page being edited (f, b or m) and its own layers.
  let face = 'f';
  const F = () => doc.sides ? doc.layers.filter(l => dzSide(l) === face) : doc.layers;
  /* Several selected: `picks` holds them (sel is then null). Selection mode (`picking`, from a long press or
     the Select button) makes taps add and remove items, for touchscreens; on a computer Ctrl/Shift-click. */
  let picks = new Set(), picking = false, anchor = null;
  const many = () => picking || picks.size > 1;
  const picked = () => doc.layers.filter(l => picks.has(l.id));

  // Canvas size: fit the page into the stage; drawn at device resolution for crisp text.
  /* View: zoom (z, 1 = the whole design fits) and pan (vx, vy, screen px from centred). */
  let fitK = 1, z = 1, vx = 0, vy = 0, rs = 1, crispT = null;
  const tb = () => doc.kind === 'note' ? ($('#dz-notebar')?.offsetHeight || 0) + 16 : doc.sides ? 48 : 0;   // room above the design for the page tabs, or a note's bar
  // Phones: the panel is a bottom sheet (up to 48% of the stage, or just its header when folded).
  const sheetH = (H) => innerWidth <= 700 && side && !side.hidden ? (side.classList.contains('min') ? 52 : Math.round(H * 0.48)) : 0;
  let sheetWas = 0;
  const fit = (crisp = true) => {
    // On phones the stage hugs the design's shape, so a wide card doesn't leave empty space above and below.
    stage.style.height = '';
    const r = stage.getBoundingClientRect(), pad = 16, rl = 52;   // rl: the tool rail's width
    const sh = sheetH(r.height), ah = Math.max(160, r.height - sh);   // on phones the design sits above the panel
    fitK = Math.min((r.width - pad * 2 - rl) / doc.w, (ah - tb() - pad * 2) / doc.h); k = fitK * z;
    const w = doc.w * k, h = doc.h * k;
    // Keep some of the design on screen however far it's dragged.
    const mx = Math.max(0, (r.width + w) / 2 - 80), my = Math.max(0, (r.height + h) / 2 - 80);
    vx = Math.max(-mx, Math.min(mx, vx)); vy = Math.max(-my, Math.min(my, vy));
    Object.assign(page.style, { width: w + 'px', height: h + 'px', left: (r.width - w + rl) / 2 + vx + 'px', top: (ah - h + tb()) / 2 + vy + 'px' });
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    // The drawing itself: device resolution, capped so a big zoom doesn't make a huge canvas.
    if (crisp) { rs = Math.min(k * Math.min(2, devicePixelRatio || 1), 4096 / Math.max(doc.w, doc.h)); cv.width = Math.round(doc.w * rs); cv.height = Math.round(doc.h * rs); }
    const zl = $('#dz-zl'); if (zl) zl.textContent = Math.abs(z - 1) < 0.01 && !vx && !vy ? 'Fit' : Math.round(z * 100) + '%';
    drawFolds(); drawCut(); drawNodes(); drawCont(); drawPen(); placeSel(); try { gridDraw(); patDraw(); if (doc.chal) chOv(); } catch {}   /* set up further down; nothing to draw before then */
  };
  // Zoom around a point on the stage (the spot under the fingers or cursor stays put). While zooming the
  // drawing is stretched; it's redrawn sharp a moment after zooming stops.
  // Folded pamphlets: fold lines, panel names and where the outside ends (only on screen, never exported).
  const drawFolds = () => {
    const f = doc.fold, box = $('#dz-folds'); if (!box) return; box.innerHTML = '';
    if (!f) return;
    // The master shows the outside's folds (it sits under both sides).
    const sd = face === 'b', fl = sd ? f.inn : f.out, nm = sd ? f.li : f.lo, ed = [0, ...fl, doc.w];
    box.innerHTML = fl.map(x => `<i class="dz-fl" style="left:${x * k}px;top:0;height:${doc.h * k}px"></i>`).join('')
      + (face === 'm' ? '' : nm.map((n, i) => `<span class="dz-pl" style="left:${ed[i] * k}px;width:${(ed[i + 1] - ed[i]) * k}px;top:0">${esc(n)}</span>`).join(''));
  };
  const zoomTo = (nz, sx, sy) => {
    const r = stage.getBoundingClientRect();
    if (sx == null) { sx = r.width / 2; sy = r.height / 2; }
    const left = (r.width - doc.w * k) / 2 + vx, top = (r.height - doc.h * k + tb()) / 2 + vy, dx = (sx - left) / k, dy = (sy - top) / k;
    z = Math.max(0.5, Math.min(8, nz)); const nk = fitK * z;
    vx = sx - dx * nk - (r.width - doc.w * nk) / 2; vy = sy - dy * nk - (r.height - doc.h * nk + tb()) / 2;
    fit(false); clearTimeout(crispT); crispT = setTimeout(() => { fit(true); redraw(); }, 160);
  };
  const frame = () => { z = 1; vx = vy = 0; fit(); redraw(); };
  let drawing = null;
  let cropping = false;
  let cut = null, cutDrag = null;
  let nodes = null, ndrag = null;
  let cont = null, cdrag = null;
  let penOn = false, pen = null, spaceHeld = false;
  let pclOn = false, stroke = null;   // the pencil (see "Pencil" below)   // the pen tool (see "Pen tool" below)   // the contour tool (see "Shape builder" below)   // editing a shape's nodes (see "Node tool" below)   // selecting part of an item (see "Selecting an area" below)   // crop mode for the selected picture or shape
  const redraw = async () => { const job = (drawing = Symbol()); await dzDraw(cv, doc, rs, { ghost: cropping ? sel : null, face }); if (job === drawing) { placeSel(); try { patDraw(); if (doc.chal && !chDrag) { chOv(); chAreaDraw(); } } catch {} } };
  // Page tabs (top right of the design): front, back and the master page under both.
  const drawFaces = () => {
    const b = $('#dz-faces'); if (!b) return; b.hidden = !doc.sides; if (!doc.sides) return;
    const nm = dzFaceNames(doc), n = (f) => doc.layers.filter(l => dzSide(l) === f).length;
    if (doc.form) { b.innerHTML = [...ffFaces(doc), 'm'].map((f, i) => `<button data-face="${f}" class="${face === f ? 'on' : ''}" ${f === 'm' ? 'data-tip="Headers and frames shown under every page"' : ''}>${f === 'm' ? 'Master' : i + 1}</button>`).join('')
      + `<button data-fpage="add" data-tip="Add a page">+</button>${doc.pages > 1 ? '<button data-fpage="del" data-tip="Delete the last page">−</button>' : ''}`; return; }
    b.innerHTML = ['f', 'b', 'm'].map(f => `<button data-face="${f}" class="${face === f ? 'on' : ''}" ${f === 'm' ? 'data-tip="Backgrounds and frames shown under both sides"' : ''}>${nm[f]}${n(f) ? ` <small>${n(f)}</small>` : ''}</button>`).join('');
  };
  const setFace = (f) => { if (f === face) return; endCrop(); endCut(); endNodes(); endCont(); endPen(); endPencil(); face = f; sel = null; picks = new Set(); picking = false; drawFaces(); drawFolds(); redraw(); drawSide(); };
  // Leaving crop mode: an uncropped item drops its crop entirely.
  const endCrop = () => { if (!cropping) return; cropping = false; const l = layer();
    if (l?.crop && l.crop.w >= 0.999 && l.crop.h >= 0.999) delete l.crop; selBox.classList.remove('cropping'); changed(true); };
  const placeSel = () => {
    if (!selBox) return;
    const mo = $('#dz-multi');
    if (mo) mo.innerHTML = picked().map(m => `<i class="dz-mo ${m.lock ? 'locked' : ''}" style="left:${m.x * k}px;top:${m.y * k}px;width:${m.w * k}px;height:${(m.h || 1) * k}px;transform:rotate(${m.rot || 0}deg)"></i>`).join('');
    stage.classList.toggle('picking', picking);
    const l = layer();
    selBox.hidden = !l || !!cut || !!nodes || !!cont;
    if (!l) return;
    Object.assign(selBox.style, { left: l.x * k + 'px', top: l.y * k + 'px', width: l.w * k + 'px', height: (l.h || 1) * k + 'px', transform: `rotate(${l.rot || 0}deg)` });
    selBox.classList.toggle('locked', !!l.lock); selBox.classList.toggle('textsel', l.t === 'text'); selBox.classList.toggle('framesel', !!l.frame); selBox.classList.toggle('onpath', !!l.on); selBox.classList.toggle('over', !!(l.frame && l._over)); const ovn = side?.querySelector('.dz-over-note'); if (ovn) ovn.hidden = !l._over; selBox.classList.toggle('cropping', cropping);
    drawXf();
  };

  // Saving: a few seconds after changes, with a small thumbnail for the list; pictures listed for backups.
  let saveT = null, saving = null, dirty = false;
  const save = () => { dirty = true; clearTimeout(saveT); saveT = setTimeout(flush, 900); };
  // Writes now (also when leaving the editor, so the list always has the latest thumbnail).
  const flush = () => { clearTimeout(saveT); if (!dirty) return saving || Promise.resolve(); dirty = false;
    // one save at a time: a change made while one runs is written after it; a failed save leaves the design unsaved
    return (saving = (saving || Promise.resolve()).catch(() => {}).then(async () => { try {
    const th = await dzCanvas(doc, 360 / Math.max(doc.w, doc.h));
    const ref = await Media.save(await new Promise(r => th.toBlob(r, 'image/jpeg', 0.8)), 'jpg');
    const old = (await DB.one('SELECT thumb_ref FROM designs WHERE id = ?', [id]))?.thumb_ref;
    const refs = [...new Set([doc.bg?.img, ...doc.layers.filter(l => l.t === 'image' && l.ref).map(l => adjS && l.ref === adjS.tmp ? adjS.ref : l.ref), ...doc.layers.map(l => l.tex?.ref), ...doc.layers.map(l => l.sh?.stencil?.ref), ...(doc.chal?.refs || []).map(r => r.ref)].filter(Boolean))];   /* a value study's stencil is the design's too */
    const before = (await DB.all('SELECT ref FROM design_assets WHERE design_id = ?', [id])).map(x => x.ref);
    await DB.tx([{ sql: `UPDATE designs SET name = ?, doc = ?, thumb_ref = ?, updated_at = datetime('now') WHERE id = ?`, params: [name, docJSON(), ref, id] },
      { sql: 'DELETE FROM design_assets WHERE design_id = ?', params: [id] },
      ...refs.map(r => ({ sql: 'INSERT INTO design_assets (design_id, ref) VALUES (?, ?)', params: [id, r] }))]);
    if (old && old !== ref) await Media.release(old);
    for (const r of before) if (!refs.includes(r)) dropped.add(r);
    if ($('#dz-list')) DZ.list();
    } catch (err) { dirty = true; console.warn('Design save failed:', err); toast('Could not save the design: ' + err.message, 5000); } })); };
  const onHide = () => { if (document.hidden) flush(); };
  document.addEventListener('visibilitychange', onHide);
  const dropped = new Set(), made = new Set();   // pictures taken out (or made) while editing; tidied when leaving
  const docRefs = () => [doc.bg?.img, ...doc.layers.map(l => l.ref), ...doc.layers.map(l => l.tex?.ref)].filter(Boolean);
  let dzKeys = null, dzPenKeys = null, dzRO = null;   // let go of when leaving, so the editor can be freed
  addEventListener('hashchange', function away() { removeEventListener('hashchange', away); document.removeEventListener('visibilitychange', onHide); focus(false);
    removeEventListener('keydown', dzKeys); removeEventListener('keyup', dzPenKeys); dzRO?.disconnect();
    flush().then(async () => { if (typeof notesShow === 'function') notesShow(); const keep = docRefs(); for (const r of new Set([...dropped, ...made])) if (!keep.includes(r)) await Media.release(r); }); });
  // A change: redraw, remember for undo, save.
  let histT = null;
  const push = () => { histT = null; const s = docJSON(); if (s !== hist[hi]) { hist.splice(hi + 1); hist.push(s); if (hist.length > 60) hist.shift(); hi = hist.length - 1; } };
  const changed = (now) => {
    redraw(); save();
    clearTimeout(histT);
    if (now) push(); else histT = setTimeout(push, 450);
  };
  /* Sticky note bar: colour, more or less room, quick links, pinned or hidden. */
  const noteBar = () => { const b = $('#dz-notebar'); if (!b) return; doc.note ||= { pin: false, links: [] };
    b.innerHTML = DZ_NOTE_COLS.map(c => `<button class="nc ${doc.bg?.c === c ? 'on' : ''}" data-nc="${c}" style="background:${c}" aria-label="Note colour"></button>`).join('')
      + `<button data-na="short" class="add">+ Shortcut</button><button data-na="check" class="add">+ Checklist</button><button data-na="more">+ Room</button><button data-na="less">− Room</button><button data-na="links">Links${doc.note.links.length ? ' ' + doc.note.links.length : ''}</button><button data-na="pin" class="${doc.note.pin ? 'on' : ''}">${doc.note.pin ? 'Pinned' : 'Hidden'}</button>`
      + (doc.note.links.length ? `<div class="nb-links"><span>Links:</span>${doc.note.links.map(l => `<button data-na="links" data-tip="${esc(l.url || 'Change links')}">${esc(l.label || NOTE_SECTIONS.find(s => s[0] === l.go)?.[1] || l.go)}${l.url ? ' ↗' : ''}</button>`).join('')}</div>` : ''); fit(false); };
  $('#dz-notebar')?.addEventListener('click', async (e) => { const c = e.target.closest('[data-nc]')?.dataset.nc, a = e.target.closest('[data-na]')?.dataset.na;
    if (c) { doc.bg = { ...doc.bg, c }; changed(true); return noteBar(); }
    if (a === 'pin') { doc.note.pin = !doc.note.pin; changed(true); return noteBar(); }
    if (a === 'short' || a === 'check') { const y = doc.layers.length ? Math.max(...doc.layers.map(l => (l.y || 0) + (l.h || 0))) + 40 : 60;
      let l; if (a === 'short') { const p = await noteShortcutPick(); if (!p) return; l = { t: 'shortcut', ...p, x: 60, y, w: 780, h: 780 }; }
      else l = { t: 'check', title: 'To do', items: [], src: 'custom', size: 64, x: 40, y, w: 820, h: 300 };
      l.h = l.t === 'check' ? dzCheckH(l) : l.h; if (y + l.h + 60 > doc.h) { doc.h = y + l.h + 60; fit(); } add(l); return; }
    if (a === 'links') { const l = await noteLinks(doc.note.links); if (l) { doc.note.links = l; changed(true); noteBar(); } return; }
    if (a === 'more' || a === 'less') { const low = Math.max(450, ...doc.layers.map(l => (l.y || 0) + (l.h || 0)));   // never cuts into what's on the note
      doc.h = a === 'more' ? doc.h + 450 : Math.max(low, doc.h - 450); if (a === 'less' && doc.h === low && low > 450) toast('That\u2019s as short as the note\u2019s contents allow.');
      if (z > 1) { z = 1; vx = vy = 0; }   // the whole note in view; already zoomed out enough stays as it is
      fit(); changed(true); } });
  noteBar();
  if (doc.kind === 'note') {
    side.addEventListener('input', (e) => { const f = e.target.dataset?.nl, l = layer(); if (!f || !l) return;
      if (f === 'items') { const was = new Map((l.items || []).map(i => [i.s, i.on])); l.items = e.target.value.split('\n').map(s => s.trim()).filter(Boolean).map(s => ({ s, on: !!was.get(s) })); }
      else l[f] = f === 'size' ? +e.target.value : e.target.value;
      if (l.t === 'check') l.h = dzCheckH(l); if (l.y + (l.h || 0) + 40 > doc.h) { doc.h = l.y + l.h + 40; fit(); } changed(); });
    side.addEventListener('click', async (e) => { const l = layer(); if (!l) return; const s = e.target.closest('[data-nls]')?.dataset.nls;
      if (s) { l.src = s; if (s === 'shop') { l.items = await noteShopItems(l.items); l.title ||= 'Shopping list'; } l.h = dzCheckH(l); if (l.y + l.h + 40 > doc.h) { doc.h = l.y + l.h + 40; fit(); } changed(true); return drawSide(); }
      if (e.target.closest('[data-nlgo]')) { const p = await noteShortcutPick(); if (p) { Object.assign(l, p); changed(true); drawSide(); } } }); }
  const undo = (d) => { if (histT) { clearTimeout(histT); push(); } const n = hi + d; if (n < 0 || n >= hist.length) return; hi = n; doc = JSON.parse(hist[hi]); setTimeout(noteBar); doc.vals ||= {}; endCut(); endNodes(); endCont(); pen = null; qsHide(); drawPen(); if (!layer()) sel = null;
    picks = new Set(picked().map(l => l.id)); redraw(); save(); drawSide(); };

  /* Side panel: nothing selected = add things, background, details; a layer selected = its settings. */
  const swatches = (key, cur, allowNone) => {
    const roles = [['@fg', 'Text'], ['@accent', 'Accent'], ['@bg', 'Background'], ['@soft', 'Soft']];
    return `<div class="dz-sw" data-swk="${key}">${allowNone ? `<button data-c="none" class="none ${cur === 'none' || !cur ? 'on' : ''}" title="None">∅</button>` : ''}
      ${roles.map(([c, n]) => `<button data-c="${c}" class="role ${cur === c ? 'on' : ''}" title="Theme ${n}" style="background:${dzCol(doc, c)}"></button>`).join('')}
      <span class="sep"></span>${DZ_PALETTE.map(c => `<button data-c="${c}" class="${cur === c ? 'on' : ''}" style="background:${c}"></button>`).join('')}
      <label class="pick" title="Any colour"><input type="color" data-cpick="${key}" value="${/^#/.test(cur || '') ? cur : '#888888'}">+</label></div>`;
  };
  /* Fill: plain colour, gradient or texture. `key` is the plain colour's property (fill for shapes, c for text). */
  let gsel = 0;   // the gradient colour being edited
  const fillUI = (l, key, allowNone) => {
    const fm = l.fm || 'solid';
    const seg = `<div class="seg dz-fm">${[['solid', 'Colour'], ['grad', 'Gradient'], ['tex', 'Texture']].map(([m, n]) => `<button data-fm="${m}" class="${fm === m ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>`;
    if (fm === 'grad') {
      const g = l.grad; gsel = Math.min(gsel, g.stops.length - 1);
      return seg + `<div class="dz-gbar" data-gbar style="background:${dzGradCss(doc, g)}" title="Drag the markers to move the colours; tap the bar to add one">
          ${g.stops.map((st, i) => `<i data-gs="${i}" class="${i === gsel ? 'on' : ''}" style="left:${st.p * 100}%;background:${dzCol(doc, st.c)}"></i>`).join('')}</div>
        <div class="row dz-gacts"><span class="muted" style="font-size:12px">Colour ${gsel + 1} of ${g.stops.length}, at ${Math.round(g.stops[gsel].p * 100)}%</span>
          <button class="btn small" data-gact="add" ${g.stops.length >= 5 ? 'disabled' : ''}>+ Colour</button><button class="btn small" data-gact="del" ${g.stops.length <= 2 ? 'disabled' : ''}>Remove</button></div>
        ${swatches('gstop', g.stops[gsel].c)}
        <div class="row" style="gap:6px;margin:6px 0;flex-wrap:nowrap"><div class="seg" style="flex:1">${[['linear', 'Linear'], ['radial', 'Radial']].map(([t, n]) => `<button data-gtype="${t}" class="${(g.type || 'linear') === t ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>
          <button class="btn small" data-gact="rev" title="Reverse the colours">⇋ Reverse</button>${g.type === 'radial' ? '' : '<button class="btn small" data-gact="turn" title="Turn 90°">↻ 90°</button>'}</div>
        ${g.type === 'radial' ? slider('g:sz', 'Size', 0.2, 2, 0.05, g.sz ?? 1, v => Math.round(v * 100) + '%') : slider('g:ang', 'Angle', -180, 180, 1, Math.round(g.ang ?? 90), v => v + '°')}`;
    }
    if (fm === 'tex') {
      const t = l.tex || {};
      return seg + `<div class="row" style="gap:6px;margin:8px 0;flex-wrap:wrap"><button class="btn small" data-tex="refs">${t.ref ? 'Change: ' : ''}From references</button>
          <label class="btn small">From device<input type="file" accept="image/*" hidden id="dz-texfile"></label></div>
        ${t.ref ? `${slider('t:ts', 'Tile size', 5, 300, 1, t.ts || 40, v => v + '%')}${slider('t:rot', 'Rotation', -180, 180, 1, Math.round(t.rot || 0), v => v + '°')}
          <div class="row" style="gap:6px"><button class="btn small ${t.fx ? 'primary' : ''}" data-tflip="fx">⇋ Flip</button><button class="btn small ${t.fy ? 'primary' : ''}" data-tflip="fy">⇵ Flip</button></div>
          <p class="muted" style="font-size:11px;margin:6px 0 0">Seamless (tileable) pictures repeat without visible joins.</p>`
        : '<p class="muted" style="font-size:12px;margin:0">Pick a picture to fill with. Seamless (tileable) textures work best.</p>'}`;
    }
    return seg + swatches(key, l[key], allowNone);
  };
  const slider = (key, label, min, max, step, val, fmt) => `<label class="dz-sl"><span>${label}<b>${fmt ? fmt(val) : val}</b></span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-k="${key}"></label>`;
  const fontOpts = (cur) => {
    const t = DZ_THEMES[doc.theme] || DZ_THEMES.ink, custom = DZF.custom();
    return `<optgroup label="Theme"><option value="@1" ${cur === '@1' ? 'selected' : ''}>Heading (${t.f1})</option><option value="@2" ${cur === '@2' ? 'selected' : ''}>Body (${t.f2})</option></optgroup>
      <optgroup label="Fonts">${DZ_FONTS.map(([f]) => `<option value="${esc(f)}" ${cur === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</optgroup>
      ${custom.length ? `<optgroup label="Your fonts">${custom.map(f => `<option value="${esc(f.name)}" ${cur === f.name ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</optgroup>` : ''}
      ${cur && cur[0] !== '@' && !DZ_FONTS.some(f => f[0] === cur) && !custom.some(f => f.name === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)} (device)</option>` : ''}
      <optgroup label="More"><option value="+device">Use a font on this device…</option><option value="+import">Import a font file…</option></optgroup>`;
  };
  /* Layers: top of the list is in front. Drag the grip to reorder; hide, lock, rename, delete. */
  let tab = 'edit';
  const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9 9 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.6 6.6C3.8 8.3 2 12 2 12s4 7 10 7a9 9 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  const LOCK = (on) => on ? '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'
    : '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>';
  const layerName = (l) => l.name || (l.t === 'field' ? 'Field: ' + (l.label || l.ft).slice(0, 30) : l.t === 'shortcut' ? 'Shortcut: ' + (l.label || '') : l.t === 'check' ? 'Checklist' : l.t === 'text' ? ((dzFill(doc, l.text).trim() || l.text).split('\n')[0].trim().slice(0, 30) || 'Text')
    : l.t === 'image' ? (l.logo ? 'Logo' : l.slot != null ? `Photo ${l.slot + 1}` : 'Picture')
    : ({ ellipse: 'Circle', line: 'Line', star: 'Star', path: 'Traced shape' }[l.shape] || ((!l.fill || l.fill === 'none') && l.sw ? 'Frame' : 'Shape')));
  const layerIco = (l) => l.t === 'text' ? 'T' : l.t === 'image' ? (l.logo ? '◎' : '▣') : '◆';
  const drawLayers = () => {
    side.innerHTML = `<div class="dz-lh"><b>Layers <small>${F().length}</small></b><span class="dz-hb">${dzIB(`data-mact="${picking ? 'done' : 'pick'}"`, 'pick', picking ? 'Stop selecting several' : 'Select several', picking ? 'on' : '')}
        ${picking || picks.size ? dzIB('data-mact="all"', 'all', 'Select all') + dzIB(`data-mact="none" ${picks.size ? '' : 'disabled'}`, 'none', 'Select none') : ''}${dzIB('data-rail="close"', 'close', 'Close')}</span></div>
      ${doc.sides ? `<p class="muted" style="font-size:12px;margin:0 2px 8px">${face === 'm' ? 'Master page: shown under both sides.' : `${dzFaceNames(doc)[face]} only. The master page shows underneath.`}</p>` : ''}
      <div class="dz-ll" id="dz-ll">${[...F()].reverse().map(l => { const i = F().indexOf(l), cl = i > 0 && l.clip;
        return `<div class="dz-lr ${l.id === sel || picks.has(l.id) ? 'on' : ''} ${l.hide ? 'off' : ''} ${cl ? 'clip' : ''}" data-lid="${l.id}">
        <span class="grip" data-grip aria-label="Drag to reorder">⠿</span><span class="li">${layerIco(l)}</span>
        <span class="nm" data-lname title="${l.id === sel ? 'Tap to rename' : 'Tap to select'}">${cl ? '<b class="clipmark">↳</b>' : ''}${esc(layerName(l))}</span>
        <button data-lclip class="${cl ? 'on' : ''}" ${i ? '' : 'disabled'} title="${cl ? 'Unclip' : 'Clip to the layer below: only shows inside it'}" aria-label="Clip to layer below"><svg viewBox="0 0 24 24"><path d="M7 4v10a3 3 0 0 0 3 3h10"/><path d="M16 13l4 4-4 4"/></svg></button>
        <button data-lhide title="${l.hide ? 'Show' : 'Hide'}" aria-label="${l.hide ? 'Show' : 'Hide'}">${l.hide ? EYE_OFF : EYE}</button>
        <button data-llock class="${l.lock ? 'on' : ''}" title="${l.lock ? 'Unlock' : 'Lock'}" aria-label="Lock">${LOCK(l.lock)}</button>
        <button data-ldel ${l.lock ? 'disabled' : ''} title="${l.lock ? 'Unlock it to delete' : 'Delete'}" aria-label="Delete">✕</button>
        ${l.id === sel ? `<input type="range" class="dz-lop" min="0" max="1" step="0.05" value="${l.op ?? 1}" data-lop aria-label="Opacity" title="How much it shows">` : ''}</div>`; }).join('') || '<p class="muted" style="margin:6px 2px">Nothing on the design yet.</p>'}</div>
      <p class="muted dz-hint">Top of the list is in front. The slider on the selected layer sets how much it shows. Drag ⠿ to reorder; tap a name again to rename; hold a layer to select several.</p>`;
  };
  let mini = Settings.get('dz_panel_min', '') === '1';
  const toolOn = () => !!(penOn || pclOn || cont || cut || nodes || cropping);
  /* The box above Shift / Alt / Ctrl: where the selection is and how big, always on show and typed into directly.
     Several items: their outer box, which moves them together. Nodes: the box round the picked nodes, and the
     distance from one to the next in the order they were picked. */
  let xfKey = '', xfRefocus = false;
  const xfNow = () => {
    if (nodes) { const L = nodeLayer(); if (!L || !nodes.sel.length) return null; const P = nodes.sel.map(([s2, i]) => { const n = L.subs[s2]?.nodes[i]; return n ? n2p(L, n.x, n.y) : null; }).filter(Boolean); if (!P.length) return null;
      const X = P.map(q => q.x), Y = P.map(q => q.y), x = Math.min(...X), y = Math.min(...Y); let d = 0; for (let i = 1; i < P.length; i++) d += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
      return { mode: 'n', x, y, w: Math.max(...X) - x, h: Math.max(...Y) - y, d: P.length > 1 ? d : null, noSize: true }; }
    if (toolOn() || cut || cropping) return null;
    if (many()) { const L = picked(); if (!L.length) return null; const B = L.map(box), x = Math.min(...B.map(b => b.x0)), y = Math.min(...B.map(b => b.y0)); return { mode: 'm', x, y, w: Math.max(...B.map(b => b.x1)) - x, h: Math.max(...B.map(b => b.y1)) - y, noSize: true }; }
    const l = layer(); if (!l) return null;
    return { mode: 'l', x: l.x, y: l.y, w: l.w, h: l.h || 0, l, noH: (l.t === 'text' && !l.frame) || l.t === 'check' || (l.t === 'field' && !['area', 'sign', 'button'].includes(l.ft)), lock: !!l.lock, noSize: !!l.on }; };
  const drawXf = () => { const b = $('#dz-xf'); if (!b) return; const v = xfNow(); b.hidden = !v; if (!v) { xfKey = ''; return; }
    const l = v.l, key = [v.mode, dzUnit(doc), l?.id, l && dzKeep(l), v.noH, v.noSize, v.lock, v.d != null].join('|');
    const f = (k, n, off, tip) => `<label data-tip="${tip}"><span>${n}</span><input class="in" type="text" inputmode="text" data-calc data-xf="${k}" ${off ? 'disabled' : ''} aria-label="${tip}"></label>`;
    // A rebuild (the link toggled while typing) keeps the box in use: its focus, what's typed and the cursor.
    const fa = b.contains(document.activeElement) && document.activeElement.dataset.xf ? document.activeElement : null, fk = fa && { k: fa.dataset.xf, v: fa.value, s: fa.selectionStart, e: fa.selectionEnd };
    if (key !== xfKey) { xfKey = key; b.innerHTML = f('x', 'X', v.lock, 'Across from the left of the page') + f('y', 'Y', v.lock, 'Down from the top of the page') + f('w', 'W', v.noSize || v.lock, 'Width') + f('h', 'H', v.noSize || v.noH || v.lock, 'Height')
      + `<div class="dz-xfr">${l ? `<button class="dz-chain ${dzKeep(l) ? 'on' : ''}" data-act="keep" ${l.t === 'text' && !l.frame ? 'disabled' : ''} title="${dzKeep(l) ? 'Proportions kept: width and height change together' : 'Width and height change separately'}" aria-label="Keep proportions">
          <svg viewBox="0 0 24 24">${dzKeep(l) ? '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
            : '<path d="M15.7 14l3-3a4 4 0 0 0-5.7-5.7l-1 1M8.3 10l-3 3a4 4 0 0 0 5.7 5.7l1-1M8 4v2M4 8h2M16 20v-2M20 16h-2"/>'}</svg></button>` : ''}${v.d != null ? '<span class="dz-xfd" data-tip="Distance from node to node, in the order you picked them"><b>D</b> <i></i></span>' : ''}<select class="in" data-unit aria-label="Unit">${(DZ_KINDS[doc.kind].social ? ['px', 'mm', 'cm', 'in'] : ['mm', 'cm', 'in', 'px']).map(u => `<option ${dzUnit(doc) === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>`;
      if (fk) { const n = b.querySelector(`[data-xf="${fk.k}"]`); if (n && !n.disabled) { n.value = fk.v; n.dataset.was = fa.dataset.was ?? ''; xfRefocus = true; n.focus({ preventScroll: true }); xfRefocus = false; n.setSelectionRange(fk.s, fk.e); } } }
    for (const kk of ['x', 'y', 'w', 'h']) { const i = b.querySelector(`[data-xf="${kk}"]`); if (i && document.activeElement !== i) i.value = dzToU(doc, v[kk]); }
    const dd = b.querySelector('.dz-xfd i'); if (dd) dd.textContent = dzToU(doc, v.d) + ' ' + dzUnit(doc); };
  const xfSet = (k, val) => { const v = xfNow(); if (!v) return; const dx = k === 'x' ? val - v.x : 0, dy = k === 'y' ? val - v.y : 0;
    if (v.mode === 'n') { if (k !== 'x' && k !== 'y') return; const L = nodeLayer(); for (const [s2, i] of nodes.sel) { const n = L.subs[s2]?.nodes[i]; if (!n) continue; const q = n2p(L, n.x, n.y), u = p2n(L, { x: q.x + dx, y: q.y + dy }); n.x = u.u; n.y = u.v; } refit(L); drawNodes(); return redraw(); }
    if (v.mode === 'm') { for (const m of picked()) if (!m.lock && !(m.on && picks.has(m.on))) { m.x += dx; m.y += dy; } return; }
    const l = v.l; if (k === 'x') l.x = val; if (k === 'y') l.y = val;
    if (k === 'w' || k === 'h') { if (!(val > 0)) return; const keep = dzKeep(l) && (l.t !== 'text' || l.frame), r = l.w / (l.h || 1); if (k === 'w') { l.w = val; if (keep) l.h = val / r; } else { l.h = val; if (keep) l.w = val * r; } } };
  /* The strip under the top bar: quick tools and properties for what's selected, a different set per kind of layer. */
  let cpop = null;
  const drawCtx = () => { const b = $('#dz-ctx'); if (!b) return; const l = layer(), sl = b.scrollLeft, sep = '<i class="dz-csep"></i>';
    if (many() && !toolOn() && !cut && !nodes && !cropping) { cpop = null; const L = picked(), n = L.length, dis = n ? '' : 'disabled', all = (f) => n && L.every(f);
      if (n && all(l => l.lock)) { b.innerHTML = dzIB('data-mact="all"', 'all', 'Select all') + dzIB('data-mact="none"', 'none', 'Select none') + sep + `<span class="muted dz-chint" style="padding-right:8px">Locked</span>` + dzIB('data-mact="lock"', 'lock', 'Unlock', 'on') + dzIB('data-mact="dup"', 'copy', 'Duplicate'); b.scrollLeft = 0; return; }
      b.innerHTML = dzIB('data-mact="all"', 'all', 'Select all') + dzIB(`data-mact="none" ${dis}`, 'none', 'Select none') + sep
        + dzIB(`data-mact="dup" ${dis}`, 'copy', 'Duplicate') + dzIB(`data-mact="hide" ${dis}`, all(l => l.hide) ? 'eyeoff' : 'eye', all(l => l.hide) ? 'Show' : 'Hide') + dzIB(`data-mact="lock" ${dis}`, all(l => l.lock) ? 'lock' : 'unlock', all(l => l.lock) ? 'Unlock' : 'Lock', all(l => l.lock) ? 'on' : '') + dzIB(`data-mact="clip" ${dis}`, 'clip', 'Clip to the layer below: each only shows inside it', all(l => l.clip) ? 'on' : '') + sep
        + AL.map(([a, tp, ic]) => `<button class="dz-ib" data-align="${a}" ${!n || (a[0] === 'd' && n < 3) ? 'disabled' : ''} data-tip="Align: ${tp}${n === 1 && a[0] !== 'd' ? ' (on the page)' : ''}" aria-label="${tp}"><svg viewBox="0 0 24 24">${ic}</svg></button>`).join('') + sep
        + [['add', 'Add: weld them into one outline'], ['subtract', 'Subtract: the bottom one, with the rest cut out of it'], ['intersect', 'Intersect: only where they all overlap'], ['xor', 'Exclude: everything except where they overlap'], ['divide', 'Divide: cut into every separate piece the overlaps make'], ['separate', 'Separate: split each into its separate pieces'], ['contour', 'Contour: grow or shrink the outline (O)']].map(([v, tp]) => `<button class="dz-ib" data-bool="${v}" ${!n || (n < 2 && !['separate', 'contour'].includes(v)) ? 'disabled' : ''} data-tip="${tp}" aria-label="${tp.split(':')[0]}">${DZ_BOOL_ICON[v]}</button>`).join('') + sep
        + dzIB(`data-mact="merge" ${dis}`, 'merge', 'Merge into one picture (Undo brings the layers back)') + dzIB(`data-mact="del" ${dis}`, 'del', 'Delete', 'danger');
      b.scrollLeft = sl; return; }
    if (!l || many() || toolOn() || cut || nodes || cropping || l.t === 'shortcut' || l.t === 'check') { cpop = null; b.innerHTML = '<span class="muted dz-chint">Select something to see its tools here.</span>'; return; }
    const tog = (k, s, tip) => `<button class="dz-ib ${l[k] ? 'on' : ''}" data-tog="${k}" data-tip="${tip}" style="${s}">${tip[0]}</button>`;
    const col = (key, ic, tip, none) => { const c = l[key], paint = (key === 'c' || key === 'fill') && l.fm === 'grad' && l.grad ? dzGradCss(doc, l.grad) : (c && c !== 'none' ? dzCol(doc, c) : key === 'c' ? dzCol(doc, '@fg') : 'transparent');
      return `<button class="dz-cbtn ${cpop === key ? 'on' : ''}" data-cpop="${key}" data-none="${none ? 1 : ''}" data-tip="${tip}" aria-label="${tip}"><small>${ic}</small><i style="background:${paint}"></i></button>`; };
    const num = (k, v, tip, max) => `<label class="dz-cnum" data-tip="${tip}"><input class="in" type="text" inputmode="text" data-calc min="0" ${max ? `max="${max}"` : ''} step="1" data-ck="${k}" value="${Math.round(v)}" aria-label="${tip}"></label>`;
    if (l.lock) { cpop = null; b.innerHTML = `<span class="muted dz-chint" style="padding-right:8px">Locked</span>` + dzIB('data-act="lock"', 'lock', 'Unlock', 'on') + dzIB('data-act="dup"', 'copy', 'Duplicate'); return; }
    let own = '';
    if (l.t === 'text') own = `<select class="in dz-cfont" data-k="font" aria-label="Font">${fontOpts(l.font)}</select>${num('size', l.size, 'Text size')}${sep}`
      + tog('b', 'font-weight:800', 'Bold') + tog('it', 'font-style:italic', 'Italic') + tog('u', 'text-decoration:underline', 'Underline') + tog('st', 'text-decoration:line-through', 'Strikethrough') + sep
      + [['left', 'aleft'], ['center', 'acenter'], ['right', 'aright'], ...(l.frame ? [['justify', 'ajust']] : [])].map(([a, ic]) => dzIB(`data-al="${a}"`, ic, 'Align ' + a, (l.al || 'left') === a ? 'on' : '')).join('')
      + (l.frame ? sep + [['top', 'vtop', 'Top of the frame'], ['middle', 'vmid', 'Middle of the frame'], ['bottom', 'vbot', 'Bottom of the frame']].map(([a, ic, n]) => dzIB(`data-va="${a}"`, ic, n, (l.va || 'top') === a ? 'on' : '')).join('') : '')
      + sep + col('c', 'Text', 'Text colour');
    else if (l.t === 'shape') own = (l.shape === 'ring' || l.qr ? '' : dzIB('data-curvetext', '<path d="M3 17C8 7 16 7 21 17"/><path d="M9 6V3h6v3M12 3v7"/>', 'Text on this curve') + sep) + (l.shape === 'line' ? col('fill', 'Line', 'Line colour', true) : col('fill', 'Fill', 'Fill colour', true) + col('stroke', 'Line', 'Outline colour', true) + num('sw', l.sw || 0, 'Outline width', 40))
      + `<select class="in dz-cdash" data-dash aria-label="Line style" data-tip="Line style">${[['', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted']].map(([v, n]) => `<option value="${v}" ${(l.dash || '') === v ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    else if (l.t === 'image' && !l.logo) own = col('stroke', 'Line', 'Outline colour', true) + num('sw', l.sw || 0, 'Outline width', 40);
    else if (l.t === 'field') own = `<select class="in dz-cfont" data-k="font" aria-label="Font">${fontOpts(l.font || '@2')}</select>${num('size', l.size || 46, 'Text size')}${sep}` + tog('b', 'font-weight:800', 'Bold') + tog('it', 'font-style:italic', 'Italic') + sep + col('c', 'Text', 'Text colour') + (l.ft === 'button' ? col('bg', 'Fill', 'Button colour') : '');
    if (doc.chal && l.t === 'shape') own = `<button class="btn small" data-chcopy data-tip="An exact copy on top of this shape, to grade as something else: shading over the outline, say">Copy as…</button>` + sep + `<button class="btn small dz-chrole ${l.role ? 'on' : ''}" data-chrole data-tip="What this shape is in the challenge, and how it is graded">${l.role ? CH_ROLES.find(r => r[0] === l.role)[1] + (l.nd ? ' · ' + dzChNds(l).join('/') : '') : 'Grade as…'}</button>` + sep + own;
    const field = l.t === 'field';
    if (doc.chal && l.t === 'image' && !l.lock) own = `<button class="btn small dz-chrole" data-chvs data-tip="Turn this picture into a shading zone: its light and dark posterized into value steps, to shade like a portrait study">Value study</button>` + sep + own;
    if (l.t === 'image' && l.ref && !l.logo && !l.lock) own += dzIB('data-adjc', '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M12 4a8 8 0 0 1 0 16"/>', 'Adjust colour: exposure, contrast, saturation, hue and more');
    if (bendOK(l)) own += dzIB('data-bend', '<path d="M3 16c4-8 14-8 18 0"/><path d="M6 19c3-5 9-5 12 0"/>', 'Bend into an arc, as in the bend tool') + sep;
    if (doc.grid?.on && doc.grid.type === 'iso' && l.t === 'shape' && l.shape !== 'line' && !l.qr)   // isometric planes, as in Affinity Designer
      own += ISO_PL.map(([v, n]) => `<button class="dz-ib dz-isob ${l.isoP === v ? 'on' : ''}" data-iso="${v}" data-tip="Fit to the ${n.toLowerCase()} plane" aria-label="${n} plane"><b>${n[0]}</b></button>`).join('')
        + (l.isoP ? dzIB('data-iso="rl"', '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>', 'Turn 15° left in the plane') + dzIB('data-iso="rr"', '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>', 'Turn 15° right in the plane')
          + dzIB('data-iso="fh"', 'fx', 'Flip across in the plane') + dzIB('data-iso="fv"', 'fy', 'Flip upside down in the plane') + `<button class="dz-ib dz-isob" data-iso="flat" data-tip="Put it back flat, off the plane" aria-label="Flat"><b>⊟</b></button>` : '') + sep;
    b.innerHTML = (own ? own + sep : '')
      + dzIB('data-act="dup"', 'copy', 'Duplicate') + dzIB('data-act="dupin"', '<rect x="7" y="7" width="12" height="12" rx="2"/><rect x="5" y="5" width="12" height="12" rx="2" stroke-dasharray="2 2"/>', 'Duplicate in place: an exact copy on top (Ctrl+D)') + dzIB('data-act="up"', 'fwd', 'Bring forward') + dzIB('data-act="down"', 'back', 'Send back') + sep
      + (field ? '' : dzIB('data-act="fx"', 'fx', 'Flip left to right', l.fx ? 'on' : '') + dzIB('data-act="fy"', 'fy', 'Flip upside down', l.fy ? 'on' : '') + dzIB(`data-act="clip" ${F().indexOf(l) ? '' : 'disabled'}`, 'clip', 'Clip to the layer below: only shows inside it', clipped(l) ? 'on' : '') + sep
        + `${l.t !== 'text' ? dzIB('data-act="crop"', 'crop', 'Crop', cropping ? 'on' : '') : ''}
        ${dzIB('data-act="cut"', 'area', 'Select area: part of it by box, ellipse, lasso or colour, to delete, split or move')}
        ${l.t === 'shape' && l.shape !== 'line' && !l.qr ? dzIB('data-act="nodes"', 'nodes', l.shape === 'vec' ? 'Edit nodes' : 'Edit nodes (turns it into a free shape)') : ''}
        <button class="dz-ib" data-bool="contour" data-tip="Contour: grow or shrink the outline, or add a border round it (O)" aria-label="Contour">${DZ_BOOL_ICON.contour}</button>
        ${l.t === 'shape' && (l.subs?.length > 1 || l.shape === 'path' || l.shape === 'ring') ? `<button class="dz-ib" data-bool="separate" data-tip="Separate: split into its pieces" aria-label="Separate">${DZ_BOOL_ICON.separate}</button>` : ''}
        ${l.t === 'image' && (l.ref || l.logo) ? dzIB('data-act="toshape"', 'toshape', 'To shape: trace the picture into a shape you can fill') : ''}
        ${l.t !== 'image' || l.ref || l.logo ? dzIB('data-act="flatten1"', 'flatten', l.t === 'image' ? 'Flatten: bake in rotation, flips, crop and opacity' : 'Flatten into a picture') : ''}
        ${dzIB('data-act="pick"', 'pick', 'Select more items')}` + sep)
      + dzIB('data-act="lock"', l.lock ? 'lock' : 'unlock', l.lock ? 'Unlock' : 'Lock', l.lock ? 'on' : '') + dzIB('data-act="del"', 'del', 'Delete', 'danger')
      + (cpop ? `<div class="dz-cpop">${swatches(cpop, l[cpop], cpop !== 'c')}</div>` : '');
    b.scrollLeft = sl;
    if (cpop) { const q = b.querySelector(`[data-cpop="${cpop}"]`).getBoundingClientRect(), p = b.querySelector('.dz-cpop'); p.style.left = Math.max(8, Math.min(innerWidth - 300, q.left)) + 'px'; p.style.top = q.bottom + 6 + 'px'; } };
  // Redrawing the panel keeps it as it was: which sections are open, where it's scrolled to and the control in use.
  const secOpen = new Map(); let sideKey = '';
  const secName = (d) => d.querySelector('summary')?.firstChild?.textContent.trim();
  const drawSide = () => {
    side.querySelectorAll('details.fsec').forEach(d => secOpen.set(secName(d), d.open));
    const was = side.scrollTop, act = document.activeElement, actSel = side.contains(act) ? ['k', 'ffk', 'tk', 'v'].map(n => act.dataset?.[n] != null ? `[data-${n}="${act.dataset[n]}"]` : '').join('') : '', caret = actSel && act.selectionStart != null ? [act.selectionStart, act.selectionEnd] : null;
    const tool = toolOn();
    if (tool || (tab === 'doc' && (layer() || many()))) tab = 'edit';
    const show = tool || tab !== 'edit' || !!layer() || many();
    side.hidden = !show; side.classList.toggle('min', mini);
    if (!show) side.innerHTML = '';
    else {
      if (tab === 'layers') drawLayers(); else if (tab === 'doc') drawDoc(); else if (tab === 'refs') drawRefsSide(); else drawEdit();
      // every panel's header: Done becomes a tick, and a chevron folds the panel down to its header
      const h = side.querySelector('.dz-lh');
      if (h) {
        h.querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Done') { b.className = 'dz-ib dz-ok'; b.dataset.tip = 'Done'; b.setAttribute('aria-label', 'Done'); b.innerHTML = `<svg viewBox="0 0 24 24">${DZ_UI.done}</svg>`; } });
        // plain help paragraphs move into one "?" tip in the header, so the panel shows only controls
        const notes = [...side.querySelectorAll(':scope > p.muted, :scope > .fsec > p.muted')].filter(p => !p.classList.contains('dz-hint') && !p.querySelector('button, input, a'));
        if (notes.length) { h.querySelector('b')?.insertAdjacentHTML('beforeend', ' ' + help(notes.map(p => p.textContent.trim().replace(/\s+/g, ' ')).join(' '))); notes.forEach(p => p.remove()); }
        h.insertAdjacentHTML('beforeend', dzIB('data-collapse', 'chev', mini ? 'Show the panel' : 'Fold the panel away', 'dz-fold'));
      }
    }
    side.querySelectorAll('details.fsec').forEach(d => { const o = secOpen.get(secName(d)); if (o != null) d.open = o; });
    const key = tab + ':' + (sel || '');
    if (key === sideKey) { side.scrollTop = was; if (actSel) { const n = side.querySelector(actSel); if (n) { n.focus({ preventScroll: true }); if (caret) n.setSelectionRange?.(...caret); } } } else { side.scrollTop = 0; sideKey = key; }
    drawCtx(); drawXf(); drawMods(); drawFaces(); drawRail();
    const nh = sheetH(stage.clientHeight); if (nh !== sheetWas) { sheetWas = nh; fit(); redraw(); }
  };
  const drawRail = () => { const r = $('#dz-rail'); if (!r) return;
    const on = { select: !toolOn() && !nodeArm && tab === 'edit', pen: penOn, pencil: pclOn, nodes: !!nodes || nodeArm, grid: !!doc.grid?.on, refs: tab === 'refs', layers: tab === 'layers', doc: tab === 'doc' };
    r.querySelectorAll('[data-rail], [data-add]').forEach(b => b.classList.toggle('on', !!on[b.dataset.rail || b.dataset.add])); try { dqDraw(); gridDraw(); } catch {} };   /* the strip is set up further down; before then there's nothing to redraw */
  /* The tool rail. Text, Picture and Shape open a small menu beside it; the rest act straight away. */
  const pop = () => $('#dz-pop');
  const closePop = () => { const p = pop(); p?.classList.remove('dz-gpop', 'dz-ppop', 'dz-chpop'); setTimeout(() => { try { if (doc.chal) chOv(); } catch {} }); if (p && !p.hidden) { p.hidden = true; $('#dz-rail')?.querySelectorAll('.open').forEach(b => b.classList.remove('open')); } };
  const mi = (attr, ic, label) => `<button class="mi" ${attr}><svg viewBox="0 0 24 24">${DZ_UI[ic]}</svg><span>${label}</span></button>`;
  /* Nodes: with a shape selected it opens its nodes; with none, the next shape tapped opens (nodeArm). A shape is
     also opened for node editing by double-tapping it. */
  let nodeArm = false, itemTap = null;
  const canNodes = (l) => l?.t === 'shape' && l.shape !== 'line' && !l.qr;
  const railAct = (a, btn) => {
    nodeArm = false;
    // Every tool on the rail leaves the pen, pencil and other edit modes first, so they can be switched straight away.
    if (a !== 'select' && a !== 'close' && toolOn()) { endCrop(); endCut(); endNodes(); endCont(); endPen(); endPencil(); }
    if (a === 'chal') { if (!pop().hidden && btn?.classList.contains('open')) return closePop(); return chOpen('set', btn); }
    if (a === 'pattern') { const p0 = pop(); if (!p0.hidden && btn?.classList.contains('open')) return closePop(); closePop(); p0.innerHTML = patMenu(); p0.hidden = false; btn?.classList.add('open'); p0.classList.add('dz-gpop', 'dz-ppop');
      const y = btn.getBoundingClientRect().top - stage.getBoundingClientRect().top; p0.style.top = Math.max(8, Math.min(y - 6, stage.clientHeight - p0.offsetHeight - 8)) + 'px'; return; }
    if (a === 'grid') { const p0 = pop(); if (!p0.hidden && btn?.classList.contains('open')) return closePop(); closePop(); p0.innerHTML = gridMenu(); p0.hidden = false; btn?.classList.add('open'); p0.classList.add('dz-gpop');
      const y = btn.getBoundingClientRect().top - stage.getBoundingClientRect().top; p0.style.top = Math.max(8, Math.min(y - 6, stage.clientHeight - p0.offsetHeight - 8)) + 'px'; return; }
    if (a === 'nodes') { closePop(); const l = layer(); if (canNodes(l)) return startNodes(l); nodeArm = true; drawRail(); return toast('Tap a shape to edit its nodes.', 2000); }
    if (a === 'select') { closePop(); endCrop(); endCut(); endNodes(); endCont(); endPen(); endPencil(); tab = 'edit'; return select(null); }
    if (a === 'refs') { closePop(); tab = tab === 'refs' ? 'edit' : 'refs'; return drawSide(); }
    if (a === 'layers' || a === 'doc') { closePop(); if (a === 'doc' && tab !== 'doc') { sel = null; picks = new Set(); picking = false; placeSel(); } tab = tab === a ? 'edit' : a; return drawSide(); }
    if (a === 'close') { tab = 'edit'; return drawSide(); }
    if (a === 'assets') { closePop(); return addAsset(); }
    const p = pop(); if (!p) return;
    if (!p.hidden && btn?.classList.contains('open')) return closePop();
    closePop();
    p.innerHTML = a === 'fields' ? FF_TYPES.map(([v, n]) => mi(`data-ffadd="${v}"`, 'frametext', n)).join('') : a === 'text' ? mi('data-add="text"', 'text', 'Text') + mi('data-add="frame"', 'frametext', 'Frame text') + mi('data-add="heading"', 'heading', 'Heading')
        + `<div class="gh">Studio info</div>` + DZ_FIELDS.map(([f, n]) => mi(`data-field="${f}"`, 'field', n)).join('')
      : a === 'image' ? mi('data-pic="device"', 'device', 'From this device') + mi('data-pic="pf"', 'portfolio', 'From portfolio') + mi('data-pic="refs"', 'refs', 'From references') + mi('data-add="logo"', 'logo', 'Studio logo')
      : `<div class="sg">${DZ_SHAPES.map(([v, n]) => `<button class="dz-ib tt-icb" data-shape="${v}" data-tip="${n}" aria-label="${n}"><svg viewBox="0 0 24 24">${DZ_UI['s_' + v]}</svg><span>${n.replace('Rounded square', 'Rounded').replace('Speech bubble', 'Bubble')}</span></button>`).join('')}</div>` + mi('data-qradd', 'qr', 'QR code') + mi('data-rail="assets"', 'asset', 'Assets').replace('class="mi"', 'class="mi as"');
    p.hidden = false; btn?.classList.add('open');
    const y = btn.getBoundingClientRect().top - stage.getBoundingClientRect().top; p.style.top = Math.max(8, Math.min(y - 6, stage.clientHeight - p.offsetHeight - 8)) + 'px';
  };
  const AL = [['l', 'Left', '<path d="M4 3v18M8 7h12v4H8zM8 14h7v4H8z"/>'], ['c', 'Centre', '<path d="M12 3v18M5 7h14v4H5zM8 14h8v4H8z"/>'], ['r', 'Right', '<path d="M20 3v18M4 7h12v4H4zM9 14h7v4H9z"/>'],
    ['t', 'Top', '<path d="M3 4h18M7 8v12h4V8zM14 8v7h4V8z"/>'], ['m', 'Middle', '<path d="M3 12h18M7 5v14h4V5zM14 8v8h4V8z"/>'], ['b', 'Bottom', '<path d="M3 20h18M7 4v12h4V4zM14 9v7h4V9z"/>'],
    ['dh', 'Space across', '<path d="M3 4v16M21 4v16M9 8h6v8H9z"/>'], ['dv', 'Space down', '<path d="M4 3h16M4 21h16M8 9h8v6H8z"/>']];
  const drawMulti = () => {
    const L = picked(), n = L.length, all = (f) => n && L.every(f);
    const dis = n ? '' : 'disabled';
    side.innerHTML = `<div class="dz-lh"><b>${n ? `${n} selected` : 'Select items'} ${help(picking ? 'Tap items on the design or in Layers to add or remove them. Drag a selected item to move them all.'
        : 'Ctrl-click adds or removes; Shift-click in Layers picks a range. Shift-drag on an empty spot draws a box: left to right picks what\u2019s wholly inside, right to left anything it touches. On a touchscreen, hold an item, or hold an empty spot then drag for the box.')}</b><button class="btn small" data-mact="done">Done</button></div>
      ${fsec('Saving', `<div class="dz-tb">${dzIB(`data-mact="refs" ${dis}`, 'refs', 'Save to references')}${dzIB(`data-mact="png" ${dis}`, 'png', 'Save as PNG')}
        ${n && vecOnly(L.map(l => l.id)) ? dzIB('data-mact="svg"', 'svg', 'Save as SVG') + dzIB('data-mact="asset"', 'asset', 'Save to Assets') : ''}${dzIB(`data-mact="stencil" ${dis}`, 'stencil', 'Make a stencil')}</div>`)}`;
  };
  const drawEdit = () => {
    if (cont) { side.innerHTML = contPanel(); return; }
    if (penOn) { side.innerHTML = penPanel(); return; }
    if (pclOn) { side.innerHTML = pclPanel(); return; }
    if (many()) return drawMulti();
    if (!layer()) return drawDoc();
    drawItem();
  };
  const drawDoc = () => {
    {
      const kinds = doc.kind === 'voucher' || doc.layers.some(x => /\{(amount|to|from|code|expires)\}/.test(x.text || ''));
      const post = DZ_KINDS[doc.kind].social || doc.layers.some(x => x.slot != null || DZ_PIECE_FIELDS.test(x.text || ''));
      side.innerHTML = `<div class="dz-lh"><b>Page</b>${dzIB('data-rail="close"', 'close', 'Close')}</div>
        ${kinds ? fsec('Voucher details', `<div class="two">
            <label class="field"><span>Amount</span><input class="in" data-v="amount" inputmode="decimal" value="${esc(doc.vals?.amount ?? '')}" placeholder="e.g. 1000"></label>
            <label class="field"><span>Valid until</span><input class="in" type="date" data-v="expires" value="${esc(doc.vals?.expires ?? '')}"></label>
            <label class="field"><span>For</span><input class="in" data-v="to" value="${esc(doc.vals?.to ?? '')}"></label>
            <label class="field"><span>From</span><input class="in" data-v="from" value="${esc(doc.vals?.from ?? '')}"></label></div>
            <div class="row" style="flex-wrap:nowrap"><label class="field" style="flex:1;margin:0"><span>Code</span><input class="in" data-v="code" value="${esc(doc.vals?.code ?? '')}"></label>
            <button class="btn small" id="dz-code" style="align-self:flex-end">New code</button></div>`) : ''}
        ${post ? fsec('Post details', `
            <button class="btn small" id="dz-piece" style="margin-bottom:10px">${doc.vals?.piece ? 'Use another portfolio piece' : 'Fill from a portfolio piece'}</button>
            <label class="field"><span>Title</span><input class="in" data-v="title" value="${esc(doc.vals?.title ?? '')}"></label>
            <div class="two"><label class="field"><span>Placement</span><input class="in" data-v="placement" value="${esc(doc.vals?.placement ?? '')}"></label>
              <label class="field"><span>Date</span><input class="in" type="date" data-v="date" value="${esc(doc.vals?.date ?? '')}"></label></div>
            <label class="field"><span>Tags ${help('Comma separated; shown as #hashtags wherever {tags} is used.')}</span><input class="in" data-v="tags" value="${esc(doc.vals?.tags ?? '')}" placeholder="blackwork, floral"></label>`) : ''}
        ${doc.form ? fsec('Form', `<label class="field" style="margin:0"><span>Keep it under</span><select class="in" data-fcat>${FF_CATS.map(([v, n]) => `<option value="${v}" ${doc.form.cat === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          ${doc.layers.some(x => x.src?.length) ? `<button class="btn small" data-ffupd style="margin-top:8px">Update all lists from studio data</button>` : ''}`) : ''}
        ${!DZ_KINDS[doc.kind].social && !doc.fold && !doc.form ? fsec('Sides', `<div class="seg">${[[0, 'One side'], [1, 'Front and back']].map(([v, n]) =>
            `<button data-sides="${v}" class="${!!doc.sides === !!v ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>
          <p class="muted" style="font-size:11px;margin:6px 0 0">${doc.sides ? 'Switch between Front, Back and Master at the top right of the design. Master holds backgrounds and frames shown under both sides.' : 'Front and back adds a back page and a master page for things shared by both.'}</p>`) : ''}
        ${fsec('Theme', `<div class="dz-themes">${Object.entries(DZ_THEMES).map(([kk, t]) =>
          `<button data-theme="${kk}" class="${doc.theme === kk ? 'on' : ''}"><i style="background:${t.bg}"></i><i style="background:${t.accent}"></i><i style="background:${t.fg}"></i><span>${t.name}</span></button>`).join('')}</div>`)}
        ${fsec('Background', `${swatches('bg', doc.bg?.c)}
          <div class="row" style="margin-top:8px"><label class="btn small">${doc.bg?.img ? 'Change picture' : 'Background picture'}<input type="file" accept="image/*" hidden id="dz-bgfile"></label>
          ${doc.bg?.img ? '<button class="btn small danger" id="dz-bgrm">Remove</button>' : ''}</div>
          ${doc.bg?.img ? slider('bgop', 'Picture opacity', 0.05, 1, 0.05, doc.bg.op ?? 1, v => Math.round(v * 100) + '%') : ''}`)}
        <p class="muted dz-hint">{Fields} like {studio} fill in from Settings.</p>`;
    }
  };
  const linkSec = (l) => { const lt = ffLinkType(l), def = FF_LINKS.find(x => x[0] === lt);
    return fsec('Link', `<label class="field"><span>When clicked</span><select class="in" data-ltype>${FF_LINKS.map(([v, n]) => `<option value="${v}" ${lt === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      ${lt === 'page' ? `<label class="field"><span>Page</span><select class="in" data-linkv>${ffFaces(doc).map((_, i) => `<option value="${i + 1}" ${String(l.lval ?? '1') === String(i + 1) ? 'selected' : ''}>Page ${i + 1}</option>`).join('')}</select></label>` : def?.[2] ? `<label class="field"><span>${def[1]}</span><input class="in" data-linkv value="${esc(l.lval ?? l.link ?? '')}" placeholder="${esc(def[2])}" autocomplete="off"></label>` : ''}
      ${l.link && !/^(page|act):/.test(l.link) ? `<a class="btn small" href="${esc(l.link)}" target="_blank" rel="noopener">Try it</a>` : ''}${l.t === 'shape' && !l.qr && l.link && !/^(page|act):/.test(l.link) ? ' <button class="btn small" data-qrfrom>Add a QR code of this link</button>' : ''}`, { fold: true, open: !!l.link || l.ft === 'button' }); };
  const drawItem = () => {
    const l = layer();
    if (l.lock) { side.innerHTML = `<div class="dz-lh"><b>Locked</b><button class="btn small" data-act="done">Done</button></div><div class="dz-lockn"><span class="muted">It can't be moved or changed while locked.</span><button class="btn small" data-act="lock">Unlock</button></div>`; return; }
    if (l.t === 'field') { side.innerHTML = `<div class="dz-lh"><b>Form field</b></div>
        <label class="field"><span>Type</span><select class="in" data-ffk="ft">${FF_TYPES.map(([v, n]) => `<option value="${v}" ${l.ft === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field"><span>Label</span><textarea class="in" rows="3" data-ffk="label">${esc(l.label || '')}</textarea></label>
        ${['radio', 'combo', 'check'].includes(l.ft) ? `<label class="field"><span>${l.ft === 'check' ? 'Several boxes? One per line' : 'Options, one per line'}</span><textarea class="in" rows="${(l.opts || []).length > 3 ? 7 : 3}" data-ffk="opts">${esc((l.opts ?? []).join('\n'))}</textarea></label>
        ${fsec('Fill from studio data', `<p class="dz-hint muted" style="margin:0 0 6px">Ticking one writes its items into the options above, ready for PDFs too.${l.ft === 'combo' ? '' : ` A list holds up to ${FF_LIST_MAX}.`}</p>${l.src?.length ? `<button class="btn small" data-ffupd style="margin-bottom:8px" data-tip="Pull this form's lists from your studio data again">Update all lists on this form</button>` : ''}${[...new Set(FF_SRC.map(s => s[2]))].map(g => { const S = FF_SRC.filter(s => s[2] === g && (!s[3] || l.ft === 'combo')); return S.length ? `<div class="lbl">${g}</div>` + S.map(s => `<label class="toggle" style="display:flex;margin-bottom:4px"${s[3] ? ' data-tip="Client details: anyone you send a PDF of this form to can read them"' : ''}><input type="checkbox" data-ffsrc="${s[0]}" ${l.src?.includes(s[0]) ? 'checked' : ''}><span>${s[1]}</span></label>`).join('') : ''; }).join('')}`, { fold: true, open: !!l.src?.length })}` : ''}
        ${l.ft === 'text' || l.ft === 'date' ? `<label class="field"><span>Fill in automatically</span><select class="in" data-ffk="v">${FF_PREFILL.map(([v, n]) => `<option value="${v}" ${(l.v || '') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}
        ${l.ft === 'button' ? linkSec(l) : `<label class="toggle" style="display:inline-flex"><input type="checkbox" data-ffk="req" ${l.req ? 'checked' : ''}><span>Required</span></label>`}
        <p class="muted dz-hint">Radio and combo boxes need InkForge or a PDF to fill in; on paper they print as they look here.</p>`; return; }
    if (l.t === 'shortcut' || l.t === 'check') { const n = l.t === 'check';
      side.innerHTML = `<div class="dz-lh"><b>${n ? 'Checklist' : 'Shortcut'}</b>${dzIB('data-act="del"', 'del', 'Delete', 'danger')}</div>` + (n
        ? `<label class="field"><span>Title</span><input class="in" data-nl="title" value="${esc(l.title || '')}"></label>
           <div class="seg" style="margin-bottom:8px"><button data-nls="custom" class="${l.src !== 'shop' ? 'on' : ''}" style="flex:1">Custom</button><button data-nls="shop" class="${l.src === 'shop' ? 'on' : ''}" style="flex:1">Shopping list</button></div>
           ${l.src === 'shop' ? '<p class="muted dz-hint">Filled from Inventory: whatever is at or below its minimum, kept current on the pinned note.</p>' : `<label class="field"><span>Items, one per line</span><textarea class="in" rows="6" data-nl="items">${esc((l.items || []).map(i => i.s).join('\n'))}</textarea></label>`}
           <label class="dz-sl"><span>Text size<b>${l.size}</b></span><input type="range" min="40" max="130" step="2" value="${l.size}" data-nl="size"></label>`
        : `<label class="field"><span>Name</span><input class="in" data-nl="label" value="${esc(l.label || '')}"></label><button class="btn small" data-nlgo>Change what it opens</button>`);
      return; }
    const kindName = l.t === 'text' ? 'Text' : l.t === 'image' ? (l.logo ? 'Logo' : 'Picture') : 'Shape';
    if (cut) { side.innerHTML = cutPanel(l); return; }
    if (nodes) { side.innerHTML = nodePanel(l); return; }
    if (cropping) {
      side.innerHTML = `<div class="dz-lh"><b>Crop ${kindName.toLowerCase()}</b><button class="btn small primary" data-act="cropdone">Done</button></div>
        <p class="muted" style="font-size:13px;margin:0 0 10px">Drag the edges or corners to cut away what you don't want. Drag inside the box to choose which part shows. The faint part is what gets cut.</p>
        <div class="row" style="gap:6px"><button class="btn small" data-act="cropreset" ${l.crop && (l.crop.w < 1 || l.crop.h < 1) ? '' : 'disabled'}>Reset crop</button></div>`;
      return;
    }
    side.innerHTML = `
      <div class="dz-lh"><b>${kindName}</b><button class="btn small" data-act="done">Done</button></div>
      ${groupOf([l.id]).length > 1 ? `<div class="dz-note">${clipped(l) ? 'Clipped to the layer below.' : 'Has layers clipped to it.'}
        <button class="btn small" data-act="flatten">Flatten group</button></div>` : ''}
      
      ${l.t === 'text' ? `
        ${l.frame ? `<p class="dz-over-note" ${l._over ? '' : 'hidden'}>Some text doesn't fit. Make the frame bigger or the letters smaller.</p>` : ''}
        ${fsec('Text', `<textarea class="in dz-text" data-k="text" rows="${l.frame ? 7 : 2}">${esc(l.text)}</textarea>
          <div class="row" style="margin-bottom:8px"><select class="in" data-tk="caps" aria-label="Case" style="flex:1;min-width:0">${[['', 'As typed'], ['upper', 'ALL CAPS'], ['small', 'Small caps'], ['title', 'Title Case'], ['lower', 'lowercase']].map(([v, n]) => `<option value="${v}" ${(l.caps || '') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`, { fold: true, open: true })}
        ${fsec('Colour', `${fillUI(l, 'c')}${l.arc && l.fm && l.fm !== 'solid' ? '<p class="muted" style="font-size:11px;margin:4px 0 0">Bent text shows the plain colour.</p>' : ''}`, { fold: true, open: true })}
        ${l.frame || l.vert ? '' : fsec('Follow a curve', `<label class="field"><span>Curve</span><select class="in" data-tcurve><option value="">None</option>${F().filter(s => s.t === 'shape' && !s.qr).map(s => `<option value="${s.id}" ${l.on === s.id ? 'selected' : ''}>${esc(layerName(s))}</option>`).join('')}</select></label>
          ${l.on ? `<label class="toggle" style="display:flex;margin-bottom:6px" data-tip="The text keeps its shape; the line itself no longer shows"><input type="checkbox" data-tchide ${doc.layers.find(s => s.id === l.on)?.hide ? 'checked' : ''}><span>Hide the curve</span></label>
          <label class="toggle" style="display:flex;margin-bottom:6px" data-tip="Run the other way, on the other side of the line"><input type="checkbox" data-tcflip ${l.pflip ? 'checked' : ''}><span>Flip to the other side</span></label>
          ${slider('pst', 'Start along the curve', -50, 50, 1, l.pst || 0, v => v + '%') + slider('pb', 'Distance from the curve', -100, 100, 1, l.pb || 0)}` : ''}`, { fold: true, open: !!l.on })}
        ${l.on ? '' : fsec('Layout', `<div class="seg" style="margin-bottom:8px"><button data-tframe="0" class="${l.frame ? '' : 'on'}" style="flex:1" data-tip="The box follows the text: dragging a corner scales the letters">Normal</button><button data-tframe="1" class="${l.frame ? 'on' : ''}" style="flex:1" data-tip="A box you size yourself: the text wraps inside it, for paragraphs">Frame</button></div>
          <div class="seg" style="margin-bottom:8px"><button data-tvert="0" class="${l.vert ? '' : 'on'}" style="flex:1">Horizontal</button><button data-tvert="1" class="${l.vert ? 'on' : ''}" style="flex:1" data-tip="Upright letters running top to bottom">Vertical</button></div>
          <label class="toggle" style="display:inline-flex;margin-bottom:6px" data-tip="Long text gets smaller to stay on its lines instead of wrapping, e.g. a studio name or amount"><input type="checkbox" data-fit ${l.fit ? 'checked' : ''}><span>Shrink to fit</span></label>
          ${l.frame ? slider('pad', 'Margin inside the frame', 0, Math.round(Math.min(l.w, l.h) / 3), 1, l.pad || 0) : l.vert ? '' : slider('arc', 'Bend', -360, 360, 5, l.arc || 0, v => +v === 0 ? 'straight' : (v > 0 ? 'up ' : 'down ') + Math.abs(v) + '°')}
          ${l.arc ? '<p class="muted" style="font-size:11px;margin:-4px 0 8px">Bent text runs on one line. <button class="link" data-act="unbend">Straighten</button></p>' : ''}`, { fold: true })}
        ${fsec('Spacing', `${slider('ls', 'Letter spacing', -5, 40, 1, l.ls || 0) + slider('lh', l.vert ? 'Column spacing' : 'Line height', 0.8, 2.5, 0.05, l.lh || 1.2)}
          ${l.frame && !l.vert ? slider('ps', 'Paragraph spacing', 0, Math.round(l.size * 3), 1, l.ps || 0) + `${slider('ind1', 'First line indent', 0, Math.round(l.w / 3), 1, l.ind1 || 0) + slider('indl', 'Left indent', 0, Math.round(l.w / 3), 1, l.indl || 0) + slider('indr', 'Right indent', 0, Math.round(l.w / 3), 1, l.indr || 0)}
          ` : ''}`, { fold: true })}
        ${l.frame && !l.vert ? fsec('Lists and columns', `<label class="field"><span>List</span><select class="in" data-tk="list">${[['', 'None'], ['bullet', 'Bullets'], ['num', 'Numbers']].map(([v, n]) => `<option value="${v}" ${(l.list || '') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          ${slider('drop', 'Drop cap', 0, 6, 1, l.drop || 0, v => +v < 2 ? 'off' : v + ' lines')}
          ${slider('cols', 'Columns', 1, 5, 1, l.cols || 1) + slider('gut', 'Gap between columns', 0, Math.round(l.w / 5), 1, l.gut ?? Math.round(l.size))}`, { fold: true }) : ''}
        ${fsec('Effects', `<div class="lbl">Outline</div>${swatches('tsc', l.tsc, true)}${slider('tsw', 'Outline width', 0, 30, 1, l.tsw || 0)}
          <div class="lbl">Shadow</div>${swatches('shc', l.shc, true)}${slider('shx', 'Across', -60, 60, 1, l.shx ?? 6) + slider('shy', 'Down', -60, 60, 1, l.shy ?? 6) + slider('shb', 'Blur', 0, 60, 1, l.shb ?? 8)}`, { fold: true })}
        ${fsec('Studio info', `<div class="dz-fields">${DZ_FIELDS.map(([f, n]) => `<button data-ins="${f}">+ ${n}</button>`).join('')}</div>`, { fold: true })}`
      : l.t === 'shape' ? fsec(l.shape === 'line' ? 'Line' : 'Fill and outline', `
        <div class="lbl">${l.shape === 'line' ? 'Colour' : 'Fill'}</div>${fillUI(l, 'fill', true)}
        ${l.shape === 'rect' || !l.shape ? slider('r', 'Corner rounding', 0, Math.round(Math.min(l.w, l.h) / 2), 1, l.r || 0) : ''}
        ${l.shape === 'poly' ? slider('n', 'Sides', 3, 16, 1, l.n || 6) : ''}
        ${l.shape === 'star' ? slider('n', 'Points', 3, 24, 1, l.n || 5) + slider('inner', 'Inner depth', 0.1, 0.95, 0.01, l.inner ?? 0.45, v => Math.round(v * 100) + '%') : ''}
        ${l.shape === 'ring' ? slider('inner', 'Hole', 0.05, 0.95, 0.01, l.inner ?? 0.6, v => Math.round(v * 100) + '%') : ''}
        ${l.shape === 'cross' || l.shape === 'arrow' ? slider('th', 'Thickness', 0.05, 0.95, 0.01, l.th ?? (l.shape === 'cross' ? 0.34 : 0.4), v => Math.round(v * 100) + '%') : ''}`, { fold: true, open: true })
      : fsec(l.logo ? 'Logo' : 'Picture', `${l.logo ? '<p class="muted" style="font-size:12px;margin:0 0 8px">Your studio logo from Settings.</p>'
          : `<div class="dz-tb">${dzIB('id="dz-pfphoto"', 'portfolio', 'Replace from portfolio')}${dzIB('id="dz-refphoto"', 'refs', 'Replace from references')}
              <label class="dz-ib" data-tip="Replace from this device" aria-label="Replace from this device"><svg viewBox="0 0 24 24">${DZ_UI.device}</svg><input type="file" accept="image/*" hidden id="dz-repl"></label></div>`}
        ${l.logo ? '' : `<label class="toggle" style="display:inline-flex;margin-bottom:6px" data-tip="Fill the whole box and crop what doesn't fit, like a photo frame. Off: the whole picture fits inside."><input type="checkbox" data-cover ${l.cover ? 'checked' : ''}><span>Fill the box (crop)</span></label>
          ${l.cover ? slider('px', 'Move photo left / right', -1, 1, 0.02, l.px || 0, v => Math.round(v * 100)) + slider('py', 'Move photo up / down', -1, 1, 0.02, l.py || 0, v => Math.round(v * 100)) : ''}
          ${slider('r', 'Corner rounding', 0, Math.round(Math.min(l.w, l.h) / 2), 1, l.r || 0)}
`}`, { fold: true, open: true })}
      ${l.qr ? fsec('QR code', `<label class="field"><span>Link or text</span><textarea class="in" rows="2" data-qrt>${esc(l.qr.text)}</textarea></label>
        <label class="field"><span>Survives damage</span><select class="in" data-qrec>${[['L', 'Low: smallest code'], ['M', 'Medium'], ['Q', 'High'], ['H', 'Highest: can take a logo on top']].map(([v, n]) => `<option value="${v}" ${l.qr.ec === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <div class="lbl">Background</div>${swatches('qrbg', l.qrbg, true)}
        <p class="dz-hint muted" style="margin:6px 0 0">Keep it dark on light so phones can read it. Test it with your phone before printing.</p>`, { fold: true, open: true }) : ''}
      ${doc.form && l.t !== 'field' ? linkSec(l) : ''}
      ${fsec('Rotation and opacity', `${slider('rot', 'Rotation', -180, 180, 1, Math.round(l.rot || 0), v => v + '°')}
        ${slider('op', 'Opacity', 0, 1, 0.05, l.op ?? 1, v => Math.round(v * 100) + '%')}`, { fold: true })}
      ${fsec('Saving', `<div class="dz-tb">${dzIB('data-mact="refs"', 'refs', 'Save to references')}${dzIB('data-mact="png"', 'png', 'Save as PNG')}
        ${vecOnly([l.id]) ? dzIB('data-mact="svg"', 'svg', 'Save as SVG') + dzIB('data-mact="asset"', 'asset', 'Save to Assets') : ''}${dzIB('data-mact="stencil"', 'stencil', 'Make a stencil')}</div>
        ${l.t !== 'image' || l.crop || l.r ? `<button class="btn small" data-mact="merge" style="margin-top:4px">Turn into a picture</button>` : ''}`, { fold: true })}`;
  };
  const select = (idv) => { if (idv !== sel) { endCrop(); endCut(); endNodes(); endCont(); endPen(); endPencil(); } sel = idv; panel = null; picks = new Set(); picking = false; placeSel(); drawSide(); };
  // Several: outside selection mode one item left becomes a normal selection.
  const setPicks = (ids) => {
    endCrop(); picks = new Set(ids); panel = null;
    if (!picking && picks.size <= 1) { sel = [...picks][0] || null; picks = new Set(); } else sel = null;
    placeSel(); drawSide();
  };
  const togglePick = (id) => { const s = new Set(picks); if (sel && !s.size) s.add(sel); s.has(id) ? s.delete(id) : s.add(id); anchor = id; setPicks(s); };
  const startPicking = (id) => { const s = new Set(picks); if (sel) s.add(sel); if (id) s.add(id); picking = true; anchor = id || anchor; setPicks(s); navigator.vibrate?.(30); };
  const clipped = (l) => F().indexOf(l) > 0 && !!l.clip;
  // Whole clip groups: a base with the layers clipped to it travel together, in layer order.
  const groupOf = (ids) => {
    const L = F(), out = new Set(ids);
    for (let i = 0; i < L.length; i++) if (ids.includes(L[i].id)) {
      let b = i; while (b > 0 && L[b].clip) b--;
      let e = b + 1; while (e < L.length && L[e].clip) e++;
      for (let q = b; q < e; q++) out.add(L[q].id);
    }
    return L.filter(l => out.has(l.id));
  };
  // The page area an item covers (rotation included).
  const box = (l) => {
    const a = (l.rot || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a)), h = l.h || 1;
    const hw = (l.w * c + h * sn) / 2, hh = (l.w * sn + h * c) / 2, cx = l.x + l.w / 2, cy = l.y + h / 2;
    return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
  };
  // A see-through picture of some layers, cut to the area they cover. Clipped layers stay inside their base.
  const flatten = async (list, max = 4000) => {
    const vis = list.filter(l => !l.hide), bases = vis.filter(l => !(l.clip && vis.indexOf(l) > 0));
    if (!bases.length) return null;
    // Drawn past the box (the result is trimmed afterwards): outlines, shadows, and the tails of letters.
    const extra = (l) => (l.sw || 0) + (l.tsw || 0) + (l.shc && l.shc !== 'none' ? Math.abs(l.shx ?? 6) + Math.abs(l.shy ?? 6) + (l.shb ?? 8) * 2 : 0) + (l.t === 'text' ? l.size * 0.5 : 0);
    const bs = bases.map(l => { const b = box(l), e = extra(l); return { x0: b.x0 - e, y0: b.y0 - e, x1: b.x1 + e, y1: b.y1 + e }; }), bx = Math.floor(Math.min(...bs.map(b => b.x0))), by = Math.floor(Math.min(...bs.map(b => b.y0)));
    const bw = Math.max(1, Math.ceil(Math.max(...bs.map(b => b.x1))) - bx), bh = Math.max(1, Math.ceil(Math.max(...bs.map(b => b.y1))) - by);
    const curves = doc.layers.filter(s => vis.some(l => l.on === s.id) && !vis.includes(s)).map(s => ({ ...s, hide: true }));
    const d = JSON.parse(JSON.stringify({ ...doc, layers: [...curves, ...vis] })); d.w = bw; d.h = bh; delete d.sides;
    for (const l of d.layers) { l.x -= bx; l.y -= by; delete l._bx; }
    const sc = Math.min(1, max / Math.max(bw, bh)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bw * sc)); c.height = Math.max(1, Math.round(bh * sc));
    await dzDraw(c, d, sc, { noBg: true });
    const tr = dzTrim(c); if (!tr) return null;   // cut to what's visible, so the handles fit it
    return { cv: tr.c, bx: bx + tr.x / sc, by: by + tr.y / sc, bw: tr.c.width / sc, bh: tr.c.height / sc };
  };
  const pngOf = (c) => new Promise(r => c.toBlob(r, 'image/png'));
  const targets = () => many() ? [...picks] : sel ? [sel] : [];
  const merge = async (ids) => {
    const list = groupOf(ids).filter(l => !l.hide);
    if (!list.length) return toast('Nothing visible to merge.');
    if (list.some(l => l.lock)) return toast('Unlock the selected layers first.');
    const txt = list.some(l => l.t === 'text');
    if (!await ask(`${list.length === 1 ? (list[0].t === 'image' ? 'Flatten this picture? Its rotation, flips, crop and opacity become part of it, and its handles fit what shows.' : 'Flatten this layer into a picture? Its fill and outline become part of the picture.') : `Merge ${list.length} layers into one picture?`}${txt ? '\n\nText becomes part of the picture and can no longer be edited.' : ''}\n\nUndo brings the layers back.`)) return;
    const f = await flatten(list); if (!f) return;
    const ref = await Media.save(await pngOf(f.cv), 'png'); made.add(ref);
    const gone = new Set(list.map(l => l.id)), top = Math.max(...list.map(l => doc.layers.indexOf(l)));
    for (const l of list) if (l.on) { const S = doc.layers.find(s => s.id === l.on); if (S?.hide && !doc.layers.some(o => o.on === S.id && !gone.has(o.id))) gone.add(S.id); }
    const m = { id: dzId(), t: 'image', ref, side: list[0].side, x: f.bx, y: f.by, w: f.bw, h: f.bh, op: 1, rot: 0, name: list.length > 1 ? 'Merged' : layerName(list[0]) };
    const out = []; doc.layers.forEach((l, i) => { if (!gone.has(l.id)) out.push(l); if (i === top) out.push(m); });
    doc.layers = out; picking = false; picks = new Set(); sel = m.id; changed(true); drawSide();
    toast('Merged into one picture.');
  };
  // A picture becomes a shape of its outline, sitting exactly where the picture's content was.
  const toShape = async (l) => {
    if (l.lock) return toast('Unlock it first.');
    if (l.cover || (l.crop && (l.crop.w < 1 || l.crop.h < 1))) return toast('Turn off "Fill the box" and reset the crop first, so the whole picture shows.');
    const im = await dzImg(l.logo ? Settings.get('studio_logo_ref') : l.ref); if (!im) return toast('The picture could not be read.');
    toast('Tracing…');
    const tr = dzTrace(im); if (!tr) return toast('No shape found: the picture needs see-through parts, or a dark shape on a light background.', 6000);
    const nw = im.naturalWidth, nh = im.naturalHeight, sc = Math.min(l.w / nw, l.h / nh);   // the picture fits inside its box
    const w = tr.box.w * nw * sc, h = tr.box.h * nh * sc;
    let dx = ((tr.box.x + tr.box.w / 2) - 0.5) * nw * sc, dy = ((tr.box.y + tr.box.h / 2) - 0.5) * nh * sc;
    if (l.fx) dx = -dx; if (l.fy) dy = -dy;
    const a = (l.rot || 0) * Math.PI / 180, cx = l.x + l.w / 2 + dx * Math.cos(a) - dy * Math.sin(a), cy = l.y + l.h / 2 + dx * Math.sin(a) + dy * Math.cos(a);
    const sh = { id: dzId(), t: 'shape', shape: 'path', path: tr.loops, fill: '@accent', stroke: 'none', sw: 0, x: cx - w / 2, y: cy - h / 2, w, h,
      rot: l.rot || 0, op: l.op ?? 1, fx: l.fx, fy: l.fy, name: (l.name || layerName(l)) + ' shape', ...(l.side ? { side: l.side } : {}), ...(l.clip ? { clip: true } : {}) };
    doc.layers[doc.layers.indexOf(l)] = sh; sel = sh.id; changed(true); drawSide();
    toast('Now a shape: give it a colour, gradient or texture. Undo brings the picture back.', 5000);
  };
  /* ---------- Selecting an area ----------
     Part of one item is selected with a box, ellipse, lasso (with smoothing for a steadier line) or by colour,
     added to or taken from the selection, feathered for a soft edge, inverted or moved. Then that part can be
     deleted, kept alone (crop), split off into its own layer (isolate), split off and moved, or copied. The item
     is worked on as a picture of itself (shapes and text become pictures once a change is made); the selection
     is a mask the same size as that picture. Pen setting: draw with a finger or stylus, or with a stylus only
     (fingers then move and zoom the view). */
  const copt = (() => { try { return { tool: 'lasso', mode: 'new', lazy: 30, tol: 20, feather: 0, ...JSON.parse(Settings.get('dz_cut', '{}')) }; } catch { return { tool: 'lasso', mode: 'new', lazy: 30, tol: 20, feather: 0 }; } })();
  const saveCopt = () => Settings.set('dz_cut', JSON.stringify(copt));
  const blank = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const startCut = async (l) => {
    if (l.lock) return toast('Unlock it first.');
    endCrop();
    const f = await flatten([l], 3000); if (!f) return toast('Nothing visible to select from.');
    cut = { id: l.id, R: { x: f.bx, y: f.by, w: f.bw, h: f.bh }, sc: f.cv.width / f.bw, cv: f.cv, mask: blank(f.cv.width, f.cv.height), any: false, soft: null, data: null };
    placeSel(); drawSide(); drawCut();
  };
  function endCut() { if (!cut) return; cut = null; cutDrag = null; drawCut(); placeSel(); }
  // The selection with its feather (soft edge), at the picture's size.
  const soft = () => {
    if (cut.soft) return cut.soft;
    const fp = copt.feather * cut.sc; if (!fp) return (cut.soft = cut.mask);
    const c = blank(cut.mask.width, cut.mask.height), x = c.getContext('2d'); x.filter = `blur(${fp / 2}px)`; x.drawImage(cut.mask, 0, 0); x.filter = 'none';
    return (cut.soft = c);
  };
  // On screen: outside the selection is dimmed; the shape being drawn is outlined.
  function drawCut() {
    const oc = $('#dz-cutcv'); if (!oc) return;
    const W = Math.max(1, Math.round(doc.w * k)), H = Math.max(1, Math.round(doc.h * k));
    if (oc.width !== W || oc.height !== H) { oc.width = W; oc.height = H; }
    const x = oc.getContext('2d'); x.clearRect(0, 0, W, H); oc.hidden = !cut; if (!cut) return;
    const R = cut.R, rx = R.x * k, ry = R.y * k, rw = R.w * k, rh = R.h * k;
    if (cut.any) { x.save(); x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, 0, W, H); x.globalCompositeOperation = 'destination-out'; x.drawImage(soft(), rx, ry, rw, rh); x.restore(); }
    x.setLineDash([6, 4]); x.lineWidth = 1.5; x.strokeStyle = '#1fb6a6'; x.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
    const d = cutDrag; if (!d) return;
    x.strokeStyle = '#fff'; x.setLineDash([5, 4]); x.beginPath();
    if (d.pts) {
      const [sx, sy] = d.pts[0], tip = d.cur || d.lp, near = d.pts.length > 6 && Math.hypot((tip.x - sx) * k, (tip.y - sy) * k) < 18;
      x.save(); x.setLineDash([]); x.beginPath(); x.arc(sx * k, sy * k, near ? 10 : 5, 0, Math.PI * 2);
      x.fillStyle = near ? 'rgba(46,204,113,.35)' : 'rgba(255,255,255,.25)'; x.strokeStyle = near ? '#2ecc71' : '#fff'; x.lineWidth = 2; x.fill(); x.stroke(); x.restore();
      x.beginPath(); d.pts.forEach(([a, b], i) => i ? x.lineTo(a * k, b * k) : x.moveTo(a * k, b * k));
      x.stroke(); if (d.cur) { x.setLineDash([2, 3]); x.strokeStyle = 'rgba(255,255,255,.6)'; x.beginPath(); const lp = d.pts.at(-1); x.moveTo(lp[0] * k, lp[1] * k); x.lineTo(d.cur.x * k, d.cur.y * k); x.stroke(); } }
    else if (d.p1) { const a = d.p0, b = d.p1, l0 = Math.min(a.x, b.x) * k, t0 = Math.min(a.y, b.y) * k, ww = Math.abs(b.x - a.x) * k, hh = Math.abs(b.y - a.y) * k;
      if (copt.tool === 'ellipse') x.ellipse(l0 + ww / 2, t0 + hh / 2, ww / 2, hh / 2, 0, 0, Math.PI * 2); else x.rect(l0, t0, ww, hh); x.stroke(); }
  }
  // Adds a new area (drawn by `draw` in picture pixels) to the selection: replace, add or take away.
  const applySel = (draw) => {
    const m = cut.mask, mx = m.getContext('2d'), tmp = blank(m.width, m.height), tx = tmp.getContext('2d');
    tx.fillStyle = '#fff'; draw(tx);
    if (copt.mode === 'new') mx.clearRect(0, 0, m.width, m.height);
    mx.globalCompositeOperation = copt.mode === 'sub' ? 'destination-out' : 'source-over'; mx.drawImage(tmp, 0, 0); mx.globalCompositeOperation = 'source-over';
    cut.any = copt.mode !== 'sub' || cut.any; cut.soft = null; drawCut(); drawSide();
  };
  const rp = (p) => [(p.x - cut.R.x) * cut.sc, (p.y - cut.R.y) * cut.sc];
  const cutDown = (e) => {
    if (Settings.get('dz_pen', 'any') === 'pen' && e.pointerType === 'touch') return;   // stylus only: fingers move the view
    e.dzHit = true; e.preventDefault(); page.setPointerCapture(e.pointerId);
    const p = toPage(e);
    if (copt.moving) { cutDrag = { move: true, p0: p, m0: (() => { const c = blank(cut.mask.width, cut.mask.height); c.getContext('2d').drawImage(cut.mask, 0, 0); return c; })() }; return; }
    if (copt.tool === 'pen') return penDown(e, true);
    if (copt.tool === 'color') {   // every pixel close to the tapped colour
      const c = cut.cv, W = c.width, H = c.height, [ix, iy] = rp(p).map(Math.floor); if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
      cut.data ||= c.getContext('2d').getImageData(0, 0, W, H).data;
      const px = cut.data, o = (iy * W + ix) * 4, tr = px[o], tg = px[o + 1], tb = px[o + 2], ta = px[o + 3], lim = copt.tol * 2.55;
      const id = new ImageData(W, H), q = id.data;
      for (let i = 0; i < px.length; i += 4) {
        const hit = ta < 24 ? px[i + 3] <= 24 + lim : px[i + 3] > 24 && Math.max(Math.abs(px[i] - tr), Math.abs(px[i + 1] - tg), Math.abs(px[i + 2] - tb)) <= lim;
        if (hit) { q[i] = q[i + 1] = q[i + 2] = q[i + 3] = 255; }
      }
      return applySel((x) => { const t2 = blank(W, H); t2.getContext('2d').putImageData(id, 0, 0); x.drawImage(t2, 0, 0); });
    }
    cutDrag = copt.tool === 'lasso' ? { pts: [[p.x, p.y]], lp: p } : { p0: p, p1: null };
  };
  const cutMove = (e) => {
    if (pinch) { cutDrag = null; return drawCut(); }   // zooming instead
    const p = toPage(e), d = cutDrag;
    if (d.move) {
      const x = cut.mask.getContext('2d'); x.clearRect(0, 0, cut.mask.width, cut.mask.height);
      x.drawImage(d.m0, (p.x - d.p0.x) * cut.sc, (p.y - d.p0.y) * cut.sc); cut.soft = null; return drawCut();
    }
    if (d.pts) {   // smoothing: the line trails the pointer on a string, so wobbles don't show
      const L = copt.lazy * 0.6 / k, dx = p.x - d.lp.x, dy = p.y - d.lp.y, dist = Math.hypot(dx, dy);
      if (d.snap) { holdScale(d.snap, p); d.pts = d.snap.cur.map(q => [q.x, q.y]); d.cur = null; return drawCut(); }
      if (dist > L) { const t = (dist - L) / dist; d.lp = { x: d.lp.x + dx * t, y: d.lp.y + dy * t };
        const last = d.pts.at(-1); if (Math.hypot(d.lp.x - last[0], d.lp.y - last[1]) * k > 1.5) d.pts.push([d.lp.x, d.lp.y]); }
      d.cur = L ? p : null;
      holdWatch(d, p, () => { const g = dzGuess(d.pts.map(([x2, y2]) => ({ x: x2, y: y2 }))); if (!g || !g.subs[0].closed) return;
        d.snap = holdStart(g, p); d.pts = d.snap.cur.map(q => [q.x, q.y]); d.cur = null; drawCut(); toast(g.label + ': keep holding and drag to resize, then let go.', 2500); });
    } else {   // box or ellipse. Shift: square or circle. Ctrl: from the centre.
      d.o ||= d.p0; let q = p;
      if (e.shiftKey) { const s = Math.max(Math.abs(p.x - d.o.x), Math.abs(p.y - d.o.y)); q = { x: d.o.x + Math.sign(p.x - d.o.x || 1) * s, y: d.o.y + Math.sign(p.y - d.o.y || 1) * s }; }
      d.p0 = e.ctrlKey ? { x: 2 * d.o.x - q.x, y: 2 * d.o.y - q.y } : d.o; d.p1 = q; }
    drawCut();
  };
  const cutUp = () => {
    const d = cutDrag; cutDrag = null; clearTimeout(d.ht);
    if (d.move) { drawCut(); return; }
    if (d.pts) { if (d.pts.length < 3) return drawCut();
      return applySel((x) => { x.beginPath(); d.pts.forEach((pt, i) => { const [a, b] = rp({ x: pt[0], y: pt[1] }); i ? x.lineTo(a, b) : x.moveTo(a, b); }); x.closePath(); x.fill(); }); }
    if (!d.p1 || Math.abs(d.p1.x - d.p0.x) * k < 3 || Math.abs(d.p1.y - d.p0.y) * k < 3) return drawCut();
    const [ax, ay] = rp(d.p0), [bx, by] = rp(d.p1), l0 = Math.min(ax, bx), t0 = Math.min(ay, by), ww = Math.abs(bx - ax), hh = Math.abs(by - ay);
    applySel((x) => { x.beginPath(); if (copt.tool === 'ellipse') x.ellipse(l0 + ww / 2, t0 + hh / 2, ww / 2, hh / 2, 0, 0, Math.PI * 2); else x.rect(l0, t0, ww, hh); x.fill(); });
  };
  // What to do with the selection. Results are pictures where the item was; Undo brings the item back.
  const cutOp = async (a) => {
    if (!cut) return;
    const l = doc.layers.find(x => x.id === cut.id); if (!l) return endCut();
    const m = cut.mask, W = m.width, H = m.height;
    if (a === 'done') { endCut(); return drawSide(); }
    if (a === 'clear') { m.getContext('2d').clearRect(0, 0, W, H); cut.any = false; cut.soft = null; drawCut(); return drawSide(); }
    if (a === 'all') { const x = m.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); cut.any = true; cut.soft = null; drawCut(); return drawSide(); }
    if (a === 'invert') { const c = blank(W, H), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.globalCompositeOperation = 'destination-out'; x.drawImage(m, 0, 0);
      const mx = m.getContext('2d'); mx.clearRect(0, 0, W, H); mx.drawImage(c, 0, 0); cut.any = true; cut.soft = null; drawCut(); return drawSide(); }
    if (a === 'movesel') { copt.moving = !copt.moving; return drawSide(); }
    if (!cut.any) return toast('Select an area first.');
    const part = (inside) => { const c = blank(W, H), x = c.getContext('2d'); x.drawImage(cut.cv, 0, 0); x.globalCompositeOperation = inside ? 'destination-in' : 'destination-out'; x.drawImage(soft(), 0, 0); return c; };
    const pic = async (c0, nm) => { const tr = dzTrim(c0); if (!tr) return null;   // nothing left
      const c = tr.c, ref = await Media.save(await pngOf(c), 'png'); made.add(ref);
      return { id: dzId(), t: 'image', ref, x: cut.R.x + tr.x / cut.sc, y: cut.R.y + tr.y / cut.sc, w: c.width / cut.sc, h: c.height / cut.sc, op: 1, rot: 0, name: nm, ...(l.side ? { side: l.side } : {}), ...(l.clip ? { clip: true } : {}) }; };
    const nm = l.name || layerName(l), i = doc.layers.indexOf(l);
    let pick = null;
    if (a === 'del' || a === 'crop') doc.layers[i] = await pic(part(a === 'crop'), nm);
    else if (a === 'copy' || a === 'iso' || a === 'lift') {
      // The new piece goes above the item's clip group, so layers clipped to the item stay clipped to it.
      const piece = await pic(part(true), nm + (a === 'copy' ? ' (copy)' : ' (cut)'));
      if (!piece) return toast('Nothing visible in the selected area.');
      if (a !== 'copy') doc.layers[i] = await pic(part(false), nm);
      let j = i + 1; while (j < doc.layers.length && doc.layers[j].clip && !l.clip) j++;
      doc.layers.splice(j, 0, piece); pick = piece.id;
    }
    else return;
    const keep = a === 'del' || a === 'crop' ? doc.layers[i]?.id : pick;
    doc.layers = doc.layers.filter(Boolean);   // the item was all cut away
    cut = null; cutDrag = null; copt.moving = false; drawCut();
    sel = keep; changed(true); drawSide();
    toast({ del: 'Deleted the selected area.', crop: 'Kept only the selected area.', copy: 'Copied to a new layer.', iso: 'Split into two layers.', lift: 'Cut out: drag it to move.' }[a] + ' Undo brings it back.');
  };
  const cutPanel = (l) => {
    const pen = Settings.get('dz_pen', 'any'), T = copt.tool;
    return `<div class="dz-lh"><b>Select an area</b><button class="btn small primary" data-cut="done">Done</button></div>
      <div class="seg dz-ctools">${[['box', 'Box', 'selbox'], ['ellipse', 'Ellipse', 'selell'], ['lasso', 'Lasso', 'sellasso'], ['pen', 'Pen', 'selpen'], ['color', 'Colour', 'selcol']].map(([t, n, ic]) => `<button data-ctool="${t}" class="tt-icb ${T === t ? 'on' : ''}" aria-label="${n}"><svg viewBox="0 0 24 24">${DZ_UI[ic]}</svg><span>${n}</span></button>`).join('')}</div>
      <div class="seg" style="margin:6px 0">${[['new', 'New'], ['add', 'Add'], ['sub', 'Take away']].map(([m, n]) => `<button data-cmode="${m}" class="${copt.mode === m ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin:0 0 6px">${copt.moving ? 'Drag on the design to move the selection outline.' : T === 'color' ? 'Tap a colour on the item: every part close to it is selected.' : T === 'lasso' ? 'Draw round the part you want.' : T === 'pen' ? 'Click for corners, drag for curves; click the first point to close and select.' : 'Drag across the part you want.'}</p>
      ${T === 'lasso' ? slider('c:lazy', 'Smoothing', 0, 100, 1, copt.lazy, v => v + '%') + holdUI() : ''}
      ${T === 'color' ? slider('c:tol', 'Colour range', 0, 100, 1, copt.tol, v => v + '%') : ''}
      ${slider('c:feather', 'Feather (soft edge)', 0, 80, 1, copt.feather, v => v + ' px')}
      <div class="dz-combine" style="margin-bottom:10px"><button class="btn small" data-cut="all">Select all</button><button class="btn small" data-cut="invert" ${cut.any ? '' : 'disabled'}>Invert</button>
        <button class="btn small ${copt.moving ? 'primary' : ''}" data-cut="movesel" ${cut.any ? '' : 'disabled'}>Move selection</button><button class="btn small" data-cut="clear" ${cut.any ? '' : 'disabled'}>Clear</button></div>
      <div class="lbl">With the selected area</div>
      <div class="dz-combine"><button class="btn small" data-cut="lift" ${cut.any ? '' : 'disabled'}>Cut out and move</button><button class="btn small" data-cut="iso" ${cut.any ? '' : 'disabled'}>Split into two layers</button>
        <button class="btn small" data-cut="copy" ${cut.any ? '' : 'disabled'}>Copy to new layer</button><button class="btn small" data-cut="crop" ${cut.any ? '' : 'disabled'}>Keep only this</button>
        <button class="btn small danger" data-cut="del" ${cut.any ? '' : 'disabled'}>Delete area</button></div>
      ${l.t !== 'image' ? '<p class="muted" style="font-size:11px;margin:8px 0 0">This item becomes a picture once you change it.</p>' : ''}
      ${fsec('Pen', `<div class="seg">${[['any', 'Finger or stylus'], ['pen', 'Stylus only']].map(([v, n]) => `<button data-pen="${v}" class="${pen === v ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">Stylus only: draw with the pen; fingers move and zoom the view.</p>`, { fold: pen === 'any' })}`;
  };
  /* ---------- Node tool ----------
     Edits a shape's outline: drag a node (its handles come with it) or a handle; tap the outline to add a node,
     drag the outline to bend it; double-tap a node to switch it between corner and smooth. Ctrl or Shift + tap
     picks several nodes; Shift keeps a handle to 45 degree steps; Alt drags one handle on its own (a corner).
     When an edit ends the shape's box is fitted round the outline again, so its fill follows the new shape. */
  const nodeLayer = () => nodes && doc.layers.find(x => x.id === nodes.id);
  // Box fractions <-> page, through the shape's flip, turn and position.
  const n2p = (L, u, v) => { let x = (u - 0.5) * L.w, y = (v - 0.5) * L.h; if (L.fx) x = -x; if (L.fy) y = -y;
    const a = (L.rot || 0) * Math.PI / 180; return { x: L.x + L.w / 2 + x * Math.cos(a) - y * Math.sin(a), y: L.y + L.h / 2 + x * Math.sin(a) + y * Math.cos(a) }; };
  const p2n = (L, p) => { const a = -(L.rot || 0) * Math.PI / 180, dx = p.x - L.x - L.w / 2, dy = p.y - L.y - L.h / 2;
    let x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a); if (L.fx) x = -x; if (L.fy) y = -y;
    return { u: x / L.w + 0.5, v: y / L.h + 0.5 }; };
  const bez = (a, b, t) => { const u = 1 - t, P = [a.x, a.x + a.ox, b.x + b.ix, b.x], Q = [a.y, a.y + a.oy, b.y + b.iy, b.y];
    const f = (V) => u * u * u * V[0] + 3 * u * u * t * V[1] + 3 * u * t * t * V[2] + t * t * t * V[3]; return { x: f(P), y: f(Q) }; };
  const segs = (sp) => { const N = sp.nodes, out = []; for (let i = 0; i < N.length - (sp.closed === false ? 1 : 0); i++) out.push([i, (i + 1) % N.length]); return out; };
  const startNodes = (l) => {
    if (l.lock) return toast('Unlock it first.');
    if (l.shape !== 'vec') {   // any shape becomes a free node path
      const g = DZ_GEN[l.shape]; if (!g) return;
      l.subs = JSON.parse(JSON.stringify(g(l))); l.shape = 'vec';
      for (const k of ['n', 'inner', 'th', 'path', 'r']) delete l[k];
      changed(true);
    }
    endCrop(); endCut(); nodes = { id: l.id, sel: [] }; placeSel(); drawSide(); drawNodes();
  };
  function endNodes() { if (!nodes) return; nodes = null; ndrag = null; drawNodes(); placeSel(); }
  function drawNodes() {
    const oc = $('#dz-nodecv'); if (!oc) return;
    const W = Math.max(1, Math.round(doc.w * k)), H = Math.max(1, Math.round(doc.h * k));
    if (oc.width !== W || oc.height !== H) { oc.width = W; oc.height = H; }
    const x = oc.getContext('2d'); x.clearRect(0, 0, W, H); const L = nodes && nodeLayer(); oc.hidden = !L; if (!L) return;
    const S = (u, v) => { const q = n2p(L, u, v); return [q.x * k, q.y * k]; };
    x.lineWidth = 1.5; x.strokeStyle = '#1fb6a6'; x.beginPath();
    for (const sp of L.subs) { const N = sp.nodes; if (!N.length) continue; x.moveTo(...S(N[0].x, N[0].y));
      for (const [i, j] of segs(sp)) { for (let t = 1; t <= 16; t++) { const q = bez(N[i], N[j], t / 16); x.lineTo(...S(q.x, q.y)); } } }
    x.stroke();
    nodes.sel.forEach(([s2, i]) => { const n = L.subs[s2]?.nodes[i]; if (!n) return; const c = S(n.x, n.y);
      for (const [hx, hy] of [[n.ix, n.iy], [n.ox, n.oy]]) if (hx || hy) { const h = S(n.x + hx, n.y + hy);
        x.strokeStyle = 'rgba(255,255,255,.7)'; x.beginPath(); x.moveTo(...c); x.lineTo(...h); x.stroke();
        x.fillStyle = '#fff'; x.beginPath(); x.arc(h[0], h[1], 4.5, 0, Math.PI * 2); x.fill(); } });
    L.subs.forEach((sp, s2) => sp.nodes.forEach((n, i) => { const [cx, cy] = S(n.x, n.y), on = nodes.sel.some(q => q[0] === s2 && q[1] === i);
      x.fillStyle = on ? '#1fb6a6' : '#fff'; x.strokeStyle = on ? '#fff' : '#1fb6a6'; x.lineWidth = 1.5; x.beginPath();
      if (n.t === 'corner') x.rect(cx - 4.5, cy - 4.5, 9, 9); else x.arc(cx, cy, 5, 0, Math.PI * 2); x.fill(); x.stroke(); }));
  }
  // What's under the pointer: a handle of a picked node, a node, or the outline (with where along it).
  const nodeHit = (L, p) => {
    const sp = { x: p.x * k, y: p.y * k }, D = (u, v) => { const q = n2p(L, u, v); return Math.hypot(q.x * k - sp.x, q.y * k - sp.y); };
    for (const [s2, i] of nodes.sel) { const n = L.subs[s2]?.nodes[i]; if (!n) continue;
      for (const side of ['o', 'i']) if ((n[side + 'x'] || n[side + 'y']) && D(n.x + n[side + 'x'], n.y + n[side + 'y']) < 11) return { kind: 'h', s: s2, i, side }; }
    for (let s2 = 0; s2 < L.subs.length; s2++) for (let i = 0; i < L.subs[s2].nodes.length; i++) { const n = L.subs[s2].nodes[i]; if (D(n.x, n.y) < 11) return { kind: 'n', s: s2, i }; }
    let best = null;
    L.subs.forEach((sp2, s2) => { const N = sp2.nodes; for (const [i, j] of segs(sp2)) for (let t = 0.02; t < 1; t += 0.02) { const q = bez(N[i], N[j], t), d = D(q.x, q.y); if (d < 9 && (!best || d < best.d)) best = { kind: 'seg', s: s2, i, j, t, d }; } });
    return best;
  };
  const isSel = (s2, i) => nodes.sel.some(q => q[0] === s2 && q[1] === i);
  // Splits the segment from node i to node j at t (de Casteljau), adding a node there.
  const splitAt = (L, s2, i, j, t) => {
    const N = L.subs[s2].nodes, a = N[i], b = N[j], lerp = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const P0 = { x: a.x, y: a.y }, P1 = { x: a.x + a.ox, y: a.y + a.oy }, P2 = { x: b.x + b.ix, y: b.y + b.iy }, P3 = { x: b.x, y: b.y };
    const A = lerp(P0, P1), B = lerp(P1, P2), C = lerp(P2, P3), Dd = lerp(A, B), E = lerp(B, C), M = lerp(Dd, E);
    a.ox = A.x - a.x; a.oy = A.y - a.y; b.ix = C.x - b.x; b.iy = C.y - b.y;
    const curved = a.ox || a.oy || b.ix || b.iy, nn = dzNd(M.x, M.y, Dd.x - M.x, Dd.y - M.y, E.x - M.x, E.y - M.y, curved ? 'smooth' : 'corner');
    N.splice(i + 1, 0, nn); return i + 1;
  };
  // A handle moved: the other one follows for smooth (in line) and sym (in line, same length) nodes; in page pixels, as the box may be stretched.
  const handleMoved = (L, n, side) => {
    const o = side === 'i' ? 'o' : 'i', hx = n[side + 'x'] * L.w, hy = n[side + 'y'] * L.h, len = Math.hypot(hx, hy);
    if (n.t === 'sym') { n[o + 'x'] = -n[side + 'x']; n[o + 'y'] = -n[side + 'y']; return; }
    if (n.t === 'smooth' && len > 1e-6) { const ol = Math.hypot(n[o + 'x'] * L.w, n[o + 'y'] * L.h); n[o + 'x'] = -hx / len * ol / L.w; n[o + 'y'] = -hy / len * ol / L.h; }
  };
  // Fits the box round the outline again (curves included) so the handles, and the fill, follow the new shape.
  const refit = (L) => {
    const xs = [], ys = [];
    for (const sp of L.subs) { const N = sp.nodes; N.forEach(n => { xs.push(n.x); ys.push(n.y); });
      for (const [i, j] of segs(sp)) for (let t = 0.1; t < 1; t += 0.1) { const q = bez(N[i], N[j], t); xs.push(q.x); ys.push(q.y); } }
    if (!xs.length) return;
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (Math.abs(x0) < 1e-4 && Math.abs(x1 - 1) < 1e-4 && Math.abs(y0) < 1e-4 && Math.abs(y1 - 1) < 1e-4) return;
    const sx = Math.max(x1 - x0, 1 / L.w), sy = Math.max(y1 - y0, 1 / L.h), c = n2p(L, (x0 + x1) / 2, (y0 + y1) / 2), w = sx * L.w, h = sy * L.h;
    for (const sp of L.subs) for (const n of sp.nodes) { n.x = (n.x - x0) / sx; n.y = (n.y - y0) / sy; n.ix /= sx; n.ox /= sx; n.iy /= sy; n.oy /= sy; }
    L.w = w; L.h = h; L.x = c.x - w / 2; L.y = c.y - h / 2;
  };
  let lastTap = { t: 0 };
  const nodeDown = (e) => {
    const L = nodeLayer(); if (!L) return endNodes();
    e.dzHit = true; e.preventDefault(); page.setPointerCapture(e.pointerId);
    const p = toPage(e), h = nodeHit(L, p), add = e.ctrlKey || e.metaKey || e.shiftKey;
    const base = JSON.parse(JSON.stringify(L.subs));
    if (!h) { if (!add) nodes.sel = []; drawNodes(); drawSide(); return; }
    if (h.kind === 'h') { ndrag = { kind: 'h', h, p0: p, base, alt: e.altKey };
      if (e.pointerType !== 'mouse') { const dd = ndrag; dd.holdT = setTimeout(() => { if (ndrag === dd && !dd.moved) { dd.alt = true; navigator.vibrate?.(25); toast('This handle now moves on its own.', 1800); } }, 500); }
      return; }
    if (h.kind === 'n') {
      const now = Date.now();
      if (now - lastTap.t < 320 && lastTap.s === h.s && lastTap.i === h.i) { lastTap = { t: 0 }; nodes.sel = [[h.s, h.i]]; return nodeOp(L.subs[h.s].nodes[h.i].t === 'corner' ? 'smooth' : 'corner'); }
      lastTap = { t: now, s: h.s, i: h.i };
      if (add) nodes.sel = isSel(h.s, h.i) ? nodes.sel.filter(q => !(q[0] === h.s && q[1] === h.i)) : [...nodes.sel, [h.s, h.i]];
      else if (!isSel(h.s, h.i)) nodes.sel = [[h.s, h.i]];
      ndrag = { kind: 'n', p0: p, base }; drawNodes(); drawSide();
      { const dd = ndrag; dd.holdT = setTimeout(() => { if (ndrag === dd && !dd.moved) { ndrag = null; navigator.vibrate?.(25); openNodeMenu(L, h); } }, 650); }
      return;
    }
    ndrag = { kind: 'seg', h, p0: p, base, moved: false };
  };
  const nodeMove = (e) => {
    const L = nodeLayer(), d = ndrag; if (!L || !d) return;
    if (pinch) { L.subs = d.base; ndrag = null; redraw(); return drawNodes(); }   // zooming instead
    const p = d.kind === 'n' && !e.shiftKey ? snapPt(toPage(e), e, new Set([L.id])) : toPage(e), q0 = p2n(L, d.p0), q1 = p2n(L, p); let du = q1.u - q0.u, dv = q1.v - q0.v;
    if (!d.moved && Math.hypot(p.x - d.p0.x, p.y - d.p0.y) * k < 3) return; d.moved = true; clearTimeout(d.holdT);
    L.subs = JSON.parse(JSON.stringify(d.base));
    if (d.kind === 'n') {
      if (e.shiftKey) { const px = du * L.w, py = du * 0 + dv * L.h; if (Math.abs(px) > Math.abs(py)) dv = 0; else du = 0; }
      for (const [s2, i] of nodes.sel) { const n = L.subs[s2]?.nodes[i]; if (n) { n.x += du; n.y += dv; } }
    } else if (d.kind === 'h') {
      const n = L.subs[d.h.s].nodes[d.h.i], sd = d.h.side;
      let hx = n[sd + 'x'] + du, hy = n[sd + 'y'] + dv;
      if (e.shiftKey) { const a = Math.atan2(hy * L.h, hx * L.w), r = Math.hypot(hx * L.w, hy * L.h), s45 = Math.round(a / (Math.PI / 4)) * Math.PI / 4; hx = r * Math.cos(s45) / L.w; hy = r * Math.sin(s45) / L.h; }
      n[sd + 'x'] = hx; n[sd + 'y'] = hy;
      if (e.altKey || d.alt) n.t = 'corner'; else handleMoved(L, n, sd);
    } else {   // bending the outline: the point under the pointer follows it, weighted to the nearer node
      const N = L.subs[d.h.s].nodes, a = N[d.h.i], b = N[d.h.j], t = Math.max(0.08, Math.min(0.92, d.h.t)), u = 1 - t, Nn = 3 * u * u * u * t + 3 * u * t * t * t;
      a.ox += du * u / Nn; a.oy += dv * u / Nn; b.ix += du * t / Nn; b.iy += dv * t / Nn;
      if (a.t === 'corner' && !a.ix && !a.iy) a.t = 'corner'; handleMoved(L, a, 'o'); handleMoved(L, b, 'i');
    }
    redraw(); drawNodes();
  };
  const nodeUp = () => {
    const L = nodeLayer(), d = ndrag; ndrag = null; if (!L || !d) return; clearTimeout(d.holdT);
    if (d.kind === 'seg' && !d.moved) { const i = splitAt(L, d.h.s, d.h.i, d.h.j, d.h.t); nodes.sel = [[d.h.s, i]]; }   // a tap on the outline adds a node
    else if (!d.moved) return drawNodes();
    refit(L); changed(true); drawNodes(); drawSide();
  };
  const nodeOp = (a) => {
    const L = nodeLayer(); if (!L) return endNodes();
    if (a === 'done') { endNodes(); return drawSide(); }
    if (a === 'all') { nodes.sel = L.subs.flatMap((sp, s2) => sp.nodes.map((_, i) => [s2, i])); drawNodes(); return drawSide(); }
    if (a === 'simp') return simplify(L);
    if (!nodes.sel.length) return toast('Pick a node first: tap it.');
    if (a === 'del') {
      const gone = new Set(nodes.sel.map(q => q.join(':')));
      L.subs = L.subs.map((sp, s2) => ({ ...sp, nodes: sp.nodes.filter((_, i) => !gone.has(s2 + ':' + i)) })).filter(sp => sp.nodes.length >= (sp.closed === false ? 2 : 3));
      if (!L.subs.length) { doc.layers = doc.layers.filter(x => x !== L); sel = null; endNodes(); changed(true); return drawSide(); }
    } else for (const [s2, i] of nodes.sel) {
      const sp = L.subs[s2], N = sp?.nodes, n = N?.[i]; if (!n) continue;
      if (a === 'corner') { n.t = 'corner'; }
      if (a === 'line') { n.ix = n.iy = n.ox = n.oy = 0; n.t = 'corner'; }
      if (a === 'smooth' || a === 'sym') {   // handles along the line through the neighbours, a third of the way to each
        const pv = N[(i - 1 + N.length) % N.length], nx = N[(i + 1) % N.length];
        if (!(n.ix || n.iy || n.ox || n.oy)) {
          let dx = (nx.x - pv.x) * L.w, dy = (nx.y - pv.y) * L.h; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
          const li = Math.hypot((n.x - pv.x) * L.w, (n.y - pv.y) * L.h) / 3, lo = Math.hypot((nx.x - n.x) * L.w, (nx.y - n.y) * L.h) / 3;
          n.ix = -dx * li / L.w; n.iy = -dy * li / L.h; n.ox = dx * lo / L.w; n.oy = dy * lo / L.h;
        }
        n.t = a; handleMoved(L, n, 'o');
      }
    }
    if (a === 'del') nodes.sel = [];
    refit(L); changed(true); drawNodes(); drawSide();
  };
  // Holding a node: corner, smooth, even, straight or delete, next to it.
  function closeNodeMenu() { $('#dz-nmenu')?.remove(); }
  const openNodeMenu = (L, h) => {
    closeNodeMenu(); nodes.sel = [[h.s, h.i]]; drawNodes(); drawSide();
    const n = L.subs[h.s].nodes[h.i], q = n2p(L, n.x, n.y), m = document.createElement('div');
    m.id = 'dz-nmenu'; m.className = 'dz-nmenu'; m.style.left = q.x * k + 'px'; m.style.top = q.y * k + 'px';
    m.innerHTML = [['corner', 'Corner'], ['smooth', 'Smooth'], ['sym', 'Even'], ['line', 'Straight'], ['del', 'Delete']].map(([a, nm]) => `<button data-nm="${a}" class="${a === 'del' ? 'danger' : ''}">${nm}</button>`).join('');
    m.onpointerdown = (ev) => ev.stopPropagation();
    m.onclick = (ev) => { const a = ev.target.closest('[data-nm]')?.dataset.nm; if (!a) return; closeNodeMenu(); nodeOp(a); };
    page.appendChild(m);
    // kept on screen: nudged in from the stage's edges, and below the node if there's no room above
    const r = m.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    if (r.right > sr.right - 6) m.style.left = q.x * k - (r.right - sr.right + 6) + 'px';
    if (r.left < sr.left + 6) m.style.left = q.x * k + (sr.left + 6 - r.left) + 'px';
    if (r.top < sr.top + 6) m.style.transform = 'translate(-50%, 14px)';
  };
  const touchHelp = () => touchy ? `<details class="dz-touch"><summary>On a touchscreen</summary><ul>
      <li>Rest a finger anywhere while dragging = <b>Shift</b> (45°, straight lines, keep proportions). Two fingers = <b>Ctrl</b> (no snapping).</li>
      <li>Hold a handle still for a moment, then drag = <b>Alt</b>: it moves on its own.</li>
      <li>Hold a node still: a menu (corner, smooth, even, straight, delete). Double-tap a node: corner / smooth.</li>
      <li>Pen: hold still after placing a point, then slide = move the point.</li>
      <li>Or tap the Shift / Alt / Ctrl buttons on the design: they stay on until tapped again.</li></ul></details>` : '';
  /* Simplify: the outline is walked out into points and fitted again at a looser tolerance, which drops nodes
     without moving the line. Pressing again (with nothing else changed) loosens further; it reports how far the
     outline moved. Works in the shape's own pixels (its box), so a stretched box doesn't skew it. */
  let simpKey = '', simpStep = 0;
  const simplify = (L) => {
    const key = L.id + ':' + hi; if (key !== simpKey) simpStep = 0;
    const W = L.w, H = L.h, toPx = (sp) => ({ closed: sp.closed !== false, nodes: sp.nodes.map(n => ({ ...n, x: n.x * W, y: n.y * H, ix: n.ix * W, iy: n.iy * H, ox: n.ox * W, oy: n.oy * H })) });
    const base = Math.max(0.4, Math.hypot(W, H) * 0.0006), before = L.subs.reduce((t, sp) => t + sp.nodes.length, 0), was = L.subs.map(sp => dzSpanPts(toPx(sp), 0, sp.closed === false ? sp.nodes.length - 1 : 0, 12));
    let subs, dropped = 0;
    while (simpStep < 9) {
      simpStep++; const tol = base * Math.pow(1.9, simpStep); dropped = 0;
      subs = L.subs.map((sp0, s2) => {
        const sp = toPx(sp0), n = sp.nodes.length, picked = [...new Set(nodes.sel.filter(q => q[0] === s2).map(q => q[1]))].sort((x, y) => x - y);
        if (!nodes.sel.length || picked.length >= n - 1) {
          if (sp.closed && n >= 3) { const f = dzFitRing(dzSpanPts(sp, 0, 0, 16), tol); if (f.nodes.length > 2 && f.nodes.length < n) { dropped += n - f.nodes.length; return f; } }
          else if (n >= 3) dropped += dzSimplifyRun(sp, 1, n - 2, tol);
          return sp;
        }
        const runs = []; for (const i of picked) { const r = runs.at(-1); if (r && i === r[1] + 1) r[1] = i; else runs.push([i, i]); }
        for (let r = runs.length - 1; r >= 0; r--) { let [a, b] = runs[r]; if (!sp.closed) { a = Math.max(a, 1); b = Math.min(b, sp.nodes.length - 2); } if (b >= a) dropped += dzSimplifyRun(sp, a, b, tol); }
        return sp;
      });
      if (dropped) break;
    }
    if (!dropped) { simpStep = 0; return toast('That\'s as simple as it goes without losing the shape.'); }
    // how far the outline moved, each ring against its own
    let worst = 0;
    subs.forEach((sp, s2) => { const now = dzSpanPts(sp, 0, sp.closed ? 0 : sp.nodes.length - 1, 12), old = was[s2] || [];
      for (let i = 0; i < old.length; i += Math.max(1, Math.floor(old.length / 200))) { const q = old[i]; let m = Infinity; for (const r of now) { const d = (r.x - q.x) ** 2 + (r.y - q.y) ** 2; if (d < m) m = d; } worst = Math.max(worst, Math.sqrt(m)); } });
    L.subs = subs.map(sp => ({ closed: sp.closed, nodes: sp.nodes.map(n => ({ ...n, x: n.x / W, y: n.y / H, ix: n.ix / W, iy: n.iy / H, ox: n.ox / W, oy: n.oy / H })) }));
    nodes.sel = []; refit(L); changed(true); simpKey = L.id + ':' + hi; drawNodes(); drawSide();
    toast(`${dropped} node${dropped === 1 ? '' : 's'} gone (${before} to ${before - dropped}), within ${Math.max(0.01, dzToU(doc, worst))} ${dzUnit(doc)}. Press again to go further.`, 5000);
  };
  const nodePanel = (l) => {
    const n = nodes.sel.length, one = n === 1 ? l.subs[nodes.sel[0][0]]?.nodes[nodes.sel[0][1]] : null;
    return `<div class="dz-lh"><b>Edit nodes</b><button class="btn small primary" data-nop="done">Done</button></div>
      <p class="muted" style="font-size:12px;margin:0 0 8px">${n ? `${n} node${n === 1 ? '' : 's'} picked${one ? ` (${({ corner: 'corner', smooth: 'smooth', sym: 'symmetric' })[one.t] || 'corner'})` : ''}.` : 'Tap a node to pick it.'}</p>
      <div class="dz-acts">
        <button data-nop="corner" ${n ? '' : 'disabled'} title="Corner: the handles move on their own">◇<span>Corner</span></button>
        <button data-nop="smooth" ${n ? '' : 'disabled'} title="Smooth: the handles stay in line">◠<span>Smooth</span></button>
        <button data-nop="sym" ${n ? '' : 'disabled'} title="Symmetric: in line and the same length">◎<span>Even</span></button>
        <button data-nop="line" ${n ? '' : 'disabled'} title="Straight: remove the handles">／<span>Straight</span></button>
        <button data-nop="all" title="Pick every node">▣<span>All</span></button>
        <button data-nop="simp" title="Simplify: fewer nodes, the same shape. Press again to go further. Works on the picked nodes, or the whole shape if none are picked.">${DZ_BOOL_ICON.simp}<span>Simplify</span></button>
        <button data-nop="del" class="danger" ${n ? '' : 'disabled'} title="Delete the picked nodes">✕<span>Delete</span></button></div>
      <p class="muted" style="font-size:12px;margin:4px 0 0">Drag a node or a handle to reshape. Tap the outline to add a node; drag the outline to bend it.
        Double-tap a node to switch corner / smooth. Ctrl or Shift + tap picks several. Shift keeps to straight lines and 45°; Alt drags one handle on its own.</p>
      ${touchHelp()}`;
  };
  /* ---------- Shape builder ----------
     Combines shapes the way vector drawing programs do: Add (weld), Subtract (the bottom one minus the rest),
     Intersect, Exclude, Divide (every piece the overlaps make, each its own shape) and Separate (a shape's separate
     pieces as shapes of their own). Contour grows or shrinks an outline by a distance; with Keep original it is
     added as a new shape, behind when growing (a border) and in front when shrinking. Shapes give their exact
     outline; text and pictures are traced from how they look. Results are node shapes, styled like the bottom one. */
  const outline = async (L) => {   // closed rings in page pixels
    if (L.t === 'shape') {
      if (L.shape === 'line') return null;
      const subs = dzSubs(L) || DZ_GEN[L.shape]?.(L); if (!subs) return null;
      return subs.filter(sp => sp.closed !== false && sp.nodes.length > 2).map(sp => { const N = sp.nodes, out = [];
        for (let i = 0; i < N.length; i++) { const a = N[i], b = N[(i + 1) % N.length], P0 = n2p(L, a.x, a.y);
          if (!a.ox && !a.oy && !b.ix && !b.iy) { out.push([P0.x, P0.y]); continue; }
          const P3 = n2p(L, b.x, b.y), steps = Math.max(3, Math.min(64, Math.ceil(Math.hypot(P3.x - P0.x, P3.y - P0.y) / 3)));
          for (let t = 0; t < steps; t++) { const q = bez(a, b, t / steps), pp = n2p(L, q.x, q.y); out.push([pp.x, pp.y]); } }
        return out; });
    }
    const f = await flatten([L], 1500); if (!f) return null; const tr = dzTrace(f.cv); if (!tr) return null;
    return tr.loops.map(lp => { const r = []; for (let i = 0; i < lp.length; i += 2) r.push([f.bx + (tr.box.x + lp[i] * tr.box.w) * f.bw, f.by + (tr.box.y + lp[i + 1] * tr.box.h) * f.bh]); return r; });
  };
  const CL = () => window.ClipperLib;
  const toC = (rings) => rings.map(r => r.map(([x, y]) => ({ X: Math.round(x * DZ_CS), Y: Math.round(y * DZ_CS) })));
  const clip = (op, a, b, fill) => { const C = CL(), c = new C.Clipper(), out = new C.Paths();
    if (a.length) c.AddPaths(a, C.PolyType.ptSubject, true); if (b?.length) c.AddPaths(b, C.PolyType.ptClip, true);
    c.Execute(C.ClipType[op], out, fill ?? C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero); return out; };
  const norm = (rings) => clip('ctUnion', toC(rings), null, CL().PolyFillType.pftEvenOdd);   // one shape's own rings, holes and all
  // Separate pieces: each outer outline with its holes (islands inside holes are pieces too).
  const pieces = (paths) => { const C = CL(), c = new C.Clipper(), tree = new C.PolyTree(); if (!paths.length) return [];
    c.AddPaths(paths, C.PolyType.ptSubject, true); c.Execute(C.ClipType.ctUnion, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    const out = [], walk = (nd) => { for (const o of nd.Childs()) { const pc = [o.Contour()]; for (const h of o.Childs()) { pc.push(h.Contour()); walk(h); } out.push(pc); } };
    walk(tree); return out; };
  const styleOf = (l) => l.t === 'shape' ? { fill: l.fill, stroke: l.stroke, sw: l.sw, dash: l.dash, fm: l.fm, grad: l.grad && JSON.parse(JSON.stringify(l.grad)), tex: l.tex && { ...l.tex }, op: l.op ?? 1 }
    : { fill: l.t === 'text' ? (l.c || '@fg') : '@accent', stroke: 'none', sw: 0, op: l.op ?? 1 };
  // Clipper paths (page pixels x DZ_CS) as a node shape styled like `l`.
  const vecFrom = (paths, l, nm) => {   // fitted back into smooth curves, so a circle stays a few nodes, not hundreds
    const C = CL(); paths = C.Clipper.CleanPolygons(paths, 0.2 * DZ_CS).filter(pp => pp.length > 2); if (!paths.length) return null;
    const subs = paths.map(pp => dzFitRing(pp.map(q => ({ x: q.X / DZ_CS, y: q.Y / DZ_CS })))).filter(sp => sp.nodes.length > 2);
    if (!subs.length) return null;
    const v = vecFromPage(subs, { ...styleOf(l), name: nm }); if (l.side) v.side = l.side; else delete v.side;
    return v;
  };
  // The operands go; the results take the place of the topmost one.
  const replaceWith = (olds, news) => {
    const at = Math.max(...olds.map(o => doc.layers.indexOf(o))), gone = new Set(olds.map(o => o.id)), out = [];
    doc.layers.forEach((l, i) => { if (!gone.has(l.id)) out.push(l); if (i === at) out.push(...news); });
    doc.layers = out; picking = false; picks = new Set(news.length > 1 ? news.map(n => n.id) : []); sel = news.length === 1 ? news[0].id : null;
    changed(true); placeSel(); drawSide();
  };
  const BOOL_NAME = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect', xor: 'Exclude', divide: 'Divide', separate: 'Separate' };
  const boolOp = async (op) => {
    if (op === 'contour') return startCont();
    const L = (many() ? picked() : [layer()]).filter(l => l && !l.hide);
    if (L.some(l => l.lock)) return toast('Unlock them first.');
    if (op !== 'separate' && L.length < 2) return toast('Pick at least two items to combine.');
    if (!L.length) return;
    try { await dzClipper(); } catch (err) { return toast('Could not combine: ' + err.message); }
    const G = [];
    for (const l of L) { const r = await outline(l); if (!r?.length) return toast(`"${layerName(l)}" has no outline to work with${l.shape === 'line' ? ' (lines have no inside)' : ''}.`); G.push(norm(r)); }
    const nm = (i) => BOOL_NAME[op] + (i ? ' ' + (i + 1) : '');
    let news = [];
    if (op === 'separate') {
      L.forEach((l, li) => pieces(G[li]).forEach((pc, i) => { const v = vecFrom(pc, l, (l.name || layerName(l)) + ' ' + (i + 1)); if (v) news.push(v); }));
      if (news.length <= L.length) return toast('Already in one piece.');
    } else if (op === 'divide') {   // every region the cuts make, each coloured like the topmost item covering it
      let regions = [{ p: G[0], o: 0 }];
      for (let i = 1; i < G.length; i++) {
        const sI = G[i], next = [];
        for (const r of regions) { const o2 = clip('ctDifference', r.p, sI); if (o2.length) next.push({ p: o2, o: r.o }); const in2 = clip('ctIntersection', r.p, sI); if (in2.length) next.push({ p: in2, o: i }); }
        const covered = clip('ctUnion', regions.flatMap(r => r.p)), rest = clip('ctDifference', sI, covered); if (rest.length) next.push({ p: rest, o: i });
        regions = next;
      }
      for (const r of regions) for (const pc of pieces(r.p)) { const v = vecFrom(pc, L[r.o], 'Piece ' + (news.length + 1)); if (v) news.push(v); }
    } else {
      let res;
      if (op === 'add') res = clip('ctUnion', G.flat());
      else if (op === 'subtract') res = clip('ctDifference', G[0], clip('ctUnion', G.slice(1).flat()));
      else { res = G[0]; for (const g of G.slice(1)) res = clip(op === 'intersect' ? 'ctIntersection' : 'ctXor', res, g); }
      const v = res.length && vecFrom(res, L[0], nm(0)); if (v) news = [v];
    }
    if (!news.length) return toast(BOOL_NAME[op] + ' left nothing behind.');
    replaceWith(L, news);
    toast(`${BOOL_NAME[op]}: ${news.length === 1 ? 'one shape' : news.length + ' shapes'}. Undo brings the originals back.`);
  };
  /* Contour: drag across the design (right grows, left shrinks; Shift for whole units) or type the width. */
  const copt2 = (() => { try { return { d: 10, join: 'round', keep: true, ...JSON.parse(Settings.get('dz_contour', '{}')) }; } catch { return { d: 10, join: 'round', keep: true }; } })();
  const saveC2 = () => Settings.set('dz_contour', JSON.stringify({ d: copt2.d, join: copt2.join, keep: copt2.keep }));
  const startCont = async () => {
    const L = (many() ? picked() : [layer()]).filter(l => l && !l.hide);
    if (!L.length) return toast('Pick something to contour first.');
    if (L.some(l => l.lock)) return toast('Unlock it first.');
    try { await dzClipper(); } catch (err) { return toast('Could not contour: ' + err.message); }
    const base = new Map();
    for (const l of L) { const r = await outline(l); if (r?.length) base.set(l.id, norm(r)); }
    if (!base.size) return toast('Nothing there has an outline to contour.');
    endCrop(); endCut(); endNodes(); cont = { base, ids: L.map(l => l.id) }; contCalc(); placeSel(); drawSide();
  };
  function endCont() { if (!cont) return; cont = null; cdrag = null; drawCont(); placeSel(); }
  const contCalc = () => {
    const C = CL(), J = { round: C.JoinType.jtRound, miter: C.JoinType.jtMiter, bevel: C.JoinType.jtSquare }[copt2.join];
    cont.res = new Map();
    for (const [id, pp] of cont.base) { const co = new C.ClipperOffset(2, 0.25 * DZ_CS), out = new C.Paths(); co.AddPaths(pp, J, C.EndType.etClosedPolygon); co.Execute(out, copt2.d * DZ_CS); cont.res.set(id, out); }
    drawCont();
  };
  function drawCont() {
    const oc = $('#dz-contcv'); if (!oc) return;
    const W = Math.max(1, Math.round(doc.w * k)), H = Math.max(1, Math.round(doc.h * k));
    if (oc.width !== W || oc.height !== H) { oc.width = W; oc.height = H; }
    const x = oc.getContext('2d'); x.clearRect(0, 0, W, H); oc.hidden = !cont; if (!cont?.res) return;
    x.setLineDash([6, 4]); x.lineWidth = 1.6; x.strokeStyle = '#7ac8ff'; x.fillStyle = 'rgba(122,200,255,.12)'; x.beginPath();
    for (const pp of cont.res.values()) for (const r of pp) { r.forEach((q, i) => i ? x.lineTo(q.X / DZ_CS * k, q.Y / DZ_CS * k) : x.moveTo(q.X / DZ_CS * k, q.Y / DZ_CS * k)); x.closePath(); }
    x.fill('evenodd'); x.stroke();
  }
  const contDown = (e) => { e.dzHit = true; e.preventDefault(); page.setPointerCapture(e.pointerId); cdrag = { x0: e.clientX, d0: copt2.d }; };
  const contMove = (e) => {
    const px = e.clientX - cdrag.x0; if (Math.abs(px) < 3 && !cdrag.moved) return; cdrag.moved = true;
    const unit = dzFromU(doc, 1), stepPx = e.shiftKey ? unit : unit / 10;   // Shift: whole mm (or the unit in use)
    copt2.d = Math.round((cdrag.d0 + px / k) / stepPx) * stepPx; contCalc();
    const i = side.querySelector('[data-contd]'); if (i) i.value = dzToU(doc, copt2.d);
  };
  const contApply = () => {
    if (!cont?.res) return;
    if (!copt2.d) return toast('Set a width first.');
    const news = [], olds = [];
    for (const id of cont.ids) { const l = doc.layers.find(x => x.id === id), pp = cont.res.get(id); if (!l || !pp?.length) continue;
      const v = vecFrom(pp, l, (l.name || layerName(l)) + ' contour'); if (!v) continue;
      if (copt2.keep) { const i = doc.layers.indexOf(l); doc.layers.splice(copt2.d > 0 ? i : i + 1, 0, v); }   // a border goes behind; a shrunk copy in front
      else olds.push([l, v]);
      news.push(v); }
    if (!news.length) { toast('Shrunk that far there is nothing left: try a smaller width.'); return; }
    for (const [l, v] of olds) doc.layers[doc.layers.indexOf(l)] = v;
    cont = null; drawCont(); picking = false; picks = new Set(news.length > 1 ? news.map(v => v.id) : []); sel = news.length === 1 ? news[0].id : null;
    changed(true); placeSel(); drawSide();
    toast(`${copt2.d > 0 ? 'Grown' : 'Shrunk'} by ${Math.abs(dzToU(doc, copt2.d))} ${dzUnit(doc)}${copt2.keep ? ', original kept' : ''}.`);
  };
  const contAct = (a) => {
    if (a === 'cancel') { endCont(); return drawSide(); }
    if (a === 'apply') return contApply();
    if (a === 'flip') { copt2.d = -copt2.d; saveC2(); contCalc(); return drawSide(); }
    if (a === 'keep') { copt2.keep = !copt2.keep; saveC2(); return drawSide(); }
    if (['round', 'miter', 'bevel'].includes(a)) { copt2.join = a; saveC2(); contCalc(); return drawSide(); }
  };
  const contPanel = () => `<div class="dz-lh"><b>Contour</b><button class="btn small" data-cont="cancel">Cancel</button></div>
    <p class="muted" style="font-size:12px;margin:0 0 8px">Drag across the design: right grows, left shrinks (Shift for whole ${dzUnit(doc)}). Or type the width; a minus number shrinks. Holes move the other way.</p>
    <div class="row" style="gap:6px;flex-wrap:nowrap;align-items:center"><label class="field" style="flex:1;margin:0"><span>Width (${dzUnit(doc)})</span>
      <input class="in" type="text" inputmode="text" data-calc step="any" data-contd value="${dzToU(doc, copt2.d)}"></label>
      <button class="btn small" data-cont="flip" style="align-self:flex-end" title="Swap between growing and shrinking">±</button></div>
    <div class="seg" style="margin:8px 0">${[['round', 'Round'], ['miter', 'Sharp'], ['bevel', 'Bevel']].map(([j, nm]) => `<button data-cont="${j}" class="${copt2.join === j ? 'on' : ''}" style="flex:1">${nm}</button>`).join('')}</div>
    <label class="toggle" style="display:inline-flex"><input type="checkbox" data-contkeep ${copt2.keep ? 'checked' : ''}><span>Keep original (add the contour as a new shape)</span></label>
    <button class="btn primary" data-cont="apply" style="width:100%;margin-top:10px">Apply (Enter)</button>`;
  /* ---------- Pen tool ----------
     As on the drawing board: click for a corner, drag to pull out curve handles (a symmetric node). Shift keeps
     to 45 degrees; Alt while dragging breaks the pair so only the outgoing handle follows (a sharp turn); Space
     held while dragging moves the node itself. Clicking the node just laid drops its outgoing handle, so the next
     segment starts straight. Clicking the first node closes the shape; Enter leaves the path open; Backspace takes
     the last node back; Esc throws the path away. Starting on the end of an open path carries it on. A closed
     shape can be added to, or cut from, what it overlaps (the Each shape setting, or the buttons after closing).
     Points are kept in page pixels while drawing; the finished path becomes a node shape. In Select area the pen
     draws a selection instead. */
  const PEN_CLOSE = 12, PEN_DEAD = 5;
  const popt = (() => { try { return { mode: 'own', ...JSON.parse(Settings.get('dz_pen_tool', '{}')) }; } catch { return { mode: 'own' }; } })();
  let penLast = null;   // the shape the pen just closed, for Add / Subtract afterwards
  const startPen = () => { endCrop(); endCut(); endNodes(); endCont(); endPencil(); penOn = true; sel = null; picks = new Set(); picking = false; placeSel(); drawSide(); drawPen(); };
  function endPen() { if (!penOn && !pen) return; if (pen && !pen.forCut && pen.nodes.length >= 2) penFinish(true); penOn = false; pen = null; penLast = null; drawPen(); }
  const sNear = (a, b) => Math.hypot((a.x - b.x) * k, (a.y - b.y) * k);
  // Page-space nodes into a node shape (its box fitted round the curve).
  const vecFromPage = (subs, extra) => {
    const xs = [], ys = [];
    for (const sp of subs) { const N = sp.nodes; N.forEach(n => { xs.push(n.x); ys.push(n.y); });
      for (const [i, j] of segs(sp)) for (let t = 0.1; t < 1; t += 0.1) { const q = bez(N[i], N[j], t); xs.push(q.x); ys.push(q.y); } }
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(1, Math.max(...xs) - x0), h = Math.max(1, Math.max(...ys) - y0);
    return { id: dzId(), t: 'shape', shape: 'vec', x: x0, y: y0, w, h, rot: 0, op: 1, ...extra, ...(doc.sides && face !== 'f' ? { side: face } : {}),
      subs: subs.map(sp => ({ closed: sp.closed, nodes: sp.nodes.map(n => ({ x: (n.x - x0) / w, y: (n.y - y0) / h, ix: n.ix / w, iy: n.iy / h, ox: n.ox / w, oy: n.oy / h, t: n.t })) })) };
  };
  // A node shape's subpath in page pixels (to carry on from its end).
  const subToPage = (L, sp) => ({ closed: sp.closed, nodes: sp.nodes.map(n => { const c = n2p(L, n.x, n.y), hi = n2p(L, n.x + n.ix, n.y + n.iy), ho = n2p(L, n.x + n.ox, n.y + n.oy);
    return { x: c.x, y: c.y, ix: hi.x - c.x, iy: hi.y - c.y, ox: ho.x - c.x, oy: ho.y - c.y, t: n.t }; }) });
  const snap45 = (from, p) => { const dx = p.x - from.x, dy = p.y - from.y, a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, r = Math.hypot(dx, dy) * Math.cos(Math.atan2(dy, dx) - a);
    return { x: from.x + r * Math.cos(a), y: from.y + r * Math.sin(a) }; };
  const penDown = (e, forCut) => {
    if (forCut && Settings.get('dz_pen', 'any') === 'pen' && e.pointerType === 'touch') return;
    e.dzHit = true; e.preventDefault(); page.setPointerCapture(e.pointerId);
    let p = toPage(e);
    if (!pen) {
      pen = { nodes: [], forCut: !!forCut, from: null };
      if (!forCut) {   // the end of an open path on this page: carry it on
        for (const L of F()) { if (L.t !== 'shape' || L.shape !== 'vec' || L.lock || L.hide) continue;
          const si = L.subs.findIndex(sp => sp.closed === false); if (si < 0) continue;
          const sp = subToPage(L, L.subs[si]), a = sp.nodes[0], b = sp.nodes.at(-1);
          for (const [nd, atStart] of [[b, false], [a, true]]) if (sNear(nd, p) < PEN_CLOSE) {
            if (atStart) sp.nodes = sp.nodes.reverse().map(n => ({ ...n, ix: n.ox, iy: n.oy, ox: n.ix, oy: n.iy }));
            pen.nodes = sp.nodes; pen.from = { id: L.id, si, style: { fill: L.fill, stroke: L.stroke, sw: L.sw, fm: L.fm, grad: L.grad, tex: L.tex, op: L.op, name: L.name } };
            L.hide = true; redraw(); toast('Carrying on from that end.'); drawPen(); drawSide(); return;
          }
        }
      }
    } else {
      const N = pen.nodes;
      if (N.length >= 3 && sNear(N[0], p) < PEN_CLOSE) return penClose();
      const ln = N.at(-1);
      if (ln && sNear(ln, p) < PEN_CLOSE) { ln.ox = ln.oy = 0; ln.t = 'corner'; toast('Handle dropped: the next part starts straight.'); return drawPen(); }
      if (e.shiftKey && ln) p = snap45(ln, p); else { p = snapPt(p, e); if (ln && !e.altKey) p = perspPt(ln, p); }
    }
    pen.nodes.push({ x: p.x, y: p.y, ix: 0, iy: 0, ox: 0, oy: 0, t: 'corner' });
    pen.drag = { i: pen.nodes.length - 1, anchor: { ...p }, curve: false, at: null, alt: e.altKey };
    if (e.pointerType !== 'mouse') { const dd = pen.drag; dd.holdT = setTimeout(() => { if (pen?.drag === dd && !dd.curve) { dd.space = true; navigator.vibrate?.(25); toast('Moving the point: slide it, then let go.', 1800); } }, 500); }
    drawPen(); drawSide();
  };
  const penMove = (e) => {
    const p = toPage(e); pen.hover = p;
    const d = pen.drag; if (!d) return drawPen();
    if (pinch) { pen.drag = null; return drawPen(); }
    const nd = pen.nodes[d.i];
    if (!d.space && sNear(d.anchor, p) > PEN_DEAD) clearTimeout(d.holdT);
    if (spaceHeld || d.space) {   // Space: move the node itself, then carry on pulling its handles from where it lands
      if (d.at) { nd.x += p.x - d.at.x; nd.y += p.y - d.at.y; d.anchor.x += p.x - d.at.x; d.anchor.y += p.y - d.at.y; }
      d.at = p; return drawPen();
    }
    d.at = null;
    if (!d.curve) { if (sNear(d.anchor, p) <= PEN_DEAD) { nd.t = 'corner'; nd.ix = nd.iy = nd.ox = nd.oy = 0; return drawPen(); } d.curve = true; }
    let q = e.shiftKey ? snap45(d.anchor, p) : p; const dx = q.x - d.anchor.x, dy = q.y - d.anchor.y;
    if (e.altKey || d.alt) { nd.t = 'corner'; nd.ox = dx; nd.oy = dy; }
    else { nd.t = 'sym'; nd.ox = dx; nd.oy = dy; nd.ix = -dx; nd.iy = -dy; }
    drawPen();
  };
  const penBack = () => {
    if (!pen) return;
    pen.nodes.pop(); if (!pen.nodes.length) { if (pen.from) penRestore(); pen = null; }
    drawPen(); drawSide();
  };
  const penRestore = () => { const L = doc.layers.find(x => x.id === pen?.from?.id); if (L) { delete L.hide; redraw(); } };
  // Lays the finished path down as a shape (replacing the open path it carried on, if any).
  const penLay = (closed) => {
    const sp = { closed, nodes: pen.nodes.map(n => ({ ...n })) };
    const style = pen.from?.style || (closed ? { fill: '@accent', stroke: 'none', sw: 0 } : { fill: 'none', stroke: '@accent', sw: Math.max(2, Math.round(Math.min(doc.w, doc.h) * 0.006)) });
    if (closed && pen.from && style.fill === 'none') style.fill = '@accent';
    const v = vecFromPage([sp], { ...style, name: style.name });
    if (pen.from) {
      const L = doc.layers.find(x => x.id === pen.from.id);
      if (L) { const others = L.subs.filter((_, i) => i !== pen.from.si).map(s2 => subToPage(L, s2)); const v2 = vecFromPage([...others, sp], { ...style, side: L.side });
        v2.id = L.id; doc.layers[doc.layers.indexOf(L)] = v2; pen = null; changed(true); return v2; }
    }
    doc.layers.push(v); pen = null; changed(true); return v;
  };
  const penFinish = (quiet) => {
    if (!pen) return;
    if (pen.forCut) { pen = null; return drawPen(); }
    if (pen.nodes.length < 2) { if (pen.from) penRestore(); pen = null; drawPen(); return drawSide(); }
    penLay(false); penLast = null; drawPen(); drawSide(); if (!quiet) toast('Path left open.');
  };
  const penClose = async () => {
    if (pen.forCut) {   // a selection in the shape the pen drew
      const N = pen.nodes; pen = null; drawPen();
      return applySel((x) => { x.beginPath(); const P = (q) => rp(q);
        const [sx, sy] = P(N[0]); x.moveTo(sx, sy);
        for (let i = 0; i < N.length; i++) { const a = N[i], b = N[(i + 1) % N.length], c1 = P({ x: a.x + a.ox, y: a.y + a.oy }), c2 = P({ x: b.x + b.ix, y: b.y + b.iy }), e2 = P(b);
          x.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], e2[0], e2[1]); }
        x.closePath(); x.fill(); });
    }
    const v = penLay(true); penLast = v.id; drawPen(); drawSide();
    if (popt.mode !== 'own') await penCombine(popt.mode); else toast('Shape closed. Add it to or cut it from what it overlaps, or keep drawing.');
  };
  // The shape just closed, added to (welded with) or cut out of whatever it overlaps on this page.
  const penCombine = async (mode) => {
    const v = doc.layers.find(x => x.id === penLast); if (!v) return;
    try { await dzClipper(); } catch (err) { return toast('Could not combine: ' + err.message); }
    const nv = norm(await outline(v)), hit = [];
    for (const L of F()) { if (L === v || L.hide || L.lock || L.t !== 'shape' || L.shape === 'line') continue;
      const r = await outline(L); if (!r?.length) continue; const g = norm(r), ov = clip('ctIntersection', g, nv); if (ov.length) hit.push({ L, g }); }
    if (!hit.length) return toast('It doesn\'t overlap any shape, so it stays as its own.');
    if (mode === 'add') {
      const res = clip('ctUnion', [...hit.flatMap(h => h.g), ...nv]), top = hit.at(-1).L, w2 = vecFrom(res, top, top.name || layerName(top));
      if (w2) replaceWith([...hit.map(h => h.L), v], [w2]);
    } else {
      for (const h of hit) { const res = clip('ctDifference', h.g, nv), i = doc.layers.indexOf(h.L);
        if (res.length) { const w2 = vecFrom(res, h.L, h.L.name || layerName(h.L)); if (w2) { w2.id = h.L.id; doc.layers[i] = w2; } } else doc.layers.splice(i, 1); }
      doc.layers = doc.layers.filter(x => x !== v); sel = null; changed(true); placeSel(); drawSide();
    }
    penLast = null; drawSide(); toast(mode === 'add' ? 'Added to what it overlapped.' : 'Cut out of what was under it.');
  };
  const penAct = async (a) => {
    if (a === 'done') { endPen(); return drawSide(); }
    if (a === 'finish') return penFinish();
    if (a === 'back') return penBack();
    if (a === 'cancel') { if (pen?.from) penRestore(); pen = null; drawPen(); return drawSide(); }
    if (a === 'add' || a === 'sub') return penCombine(a);
    if (['own', 'add2', 'sub2'].includes(a)) { popt.mode = { own: 'own', add2: 'add', sub2: 'sub' }[a]; Settings.set('dz_pen_tool', JSON.stringify(popt)); return drawSide(); }
  };
  function drawPen() {
    const oc = $('#dz-pencv'); if (!oc) return;
    const W = Math.max(1, Math.round(doc.w * k)), H = Math.max(1, Math.round(doc.h * k));
    if (oc.width !== W || oc.height !== H) { oc.width = W; oc.height = H; }
    const x = oc.getContext('2d'); x.clearRect(0, 0, W, H); oc.hidden = !pen && !stroke;
    if (stroke) return drawStroke(x);
    if (!pen?.nodes.length) return;
    const N = pen.nodes, S = (q) => [q.x * k, q.y * k];
    x.lineWidth = 1.6; x.strokeStyle = '#1fb6a6'; x.beginPath(); x.moveTo(...S(N[0]));
    for (let i = 1; i < N.length; i++) { const a = N[i - 1], b = N[i]; x.bezierCurveTo((a.x + a.ox) * k, (a.y + a.oy) * k, (b.x + b.ix) * k, (b.y + b.iy) * k, b.x * k, b.y * k); }
    x.stroke();
    const ln = N.at(-1);
    if (pen.hover && !pen.drag) {   // where the next segment would go
      x.setLineDash([4, 4]); x.strokeStyle = 'rgba(255,255,255,.6)'; x.beginPath(); x.moveTo(...S(ln));
      x.bezierCurveTo((ln.x + ln.ox) * k, (ln.y + ln.oy) * k, pen.hover.x * k, pen.hover.y * k, pen.hover.x * k, pen.hover.y * k); x.stroke(); x.setLineDash([]); }
    for (const [hx, hy] of [[ln.ix, ln.iy], [ln.ox, ln.oy]]) if (hx || hy) { x.strokeStyle = 'rgba(255,255,255,.7)'; x.beginPath(); x.moveTo(...S(ln)); x.lineTo((ln.x + hx) * k, (ln.y + hy) * k); x.stroke();
      x.fillStyle = '#fff'; x.beginPath(); x.arc((ln.x + hx) * k, (ln.y + hy) * k, 4, 0, Math.PI * 2); x.fill(); }
    const near = N.length >= 3 && pen.hover && sNear(N[0], pen.hover) < PEN_CLOSE;
    N.forEach((n, i) => { const [cx, cy] = S(n), first = i === 0;
      if (first && near) { x.fillStyle = 'rgba(46,204,113,.35)'; x.strokeStyle = '#2ecc71'; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, 10, 0, Math.PI * 2); x.fill(); x.stroke(); }
      x.lineWidth = 1.5; x.fillStyle = i === N.length - 1 ? '#1fb6a6' : '#fff'; x.strokeStyle = '#1fb6a6'; x.beginPath();
      if (n.t === 'corner') x.rect(cx - 4, cy - 4, 8, 8); else x.arc(cx, cy, 4.5, 0, Math.PI * 2); x.fill(); x.stroke(); });
  }
  const penPanel = () => {
    const n = pen?.nodes.length || 0;
    return `<div class="dz-lh"><b>Pen</b><button class="btn small primary" data-pact="done">Done</button></div>
      <p class="muted" style="font-size:12px;margin:0 0 8px">Click for a corner; drag to pull out a curve. Click the first point to close the shape.
        ${n ? `${n} point${n === 1 ? '' : 's'} so far.` : 'Start on the end of an open path to carry it on.'}</p>
      <div class="dz-combine" style="margin-bottom:10px">
        <button class="btn small" data-pact="finish" ${n >= 2 ? '' : 'disabled'}>Leave open (Enter)</button>
        <button class="btn small" data-pact="back" ${n ? '' : 'disabled'}>Undo last point</button>
        <button class="btn small" data-pact="cancel" ${n ? '' : 'disabled'}>Throw away</button></div>
      ${penLast ? `<div class="dz-note" style="margin:0 0 10px">Shape closed. <span style="display:flex;gap:6px"><button class="btn small" data-pact="add">Add to</button><button class="btn small" data-pact="sub">Cut out</button></span></div>` : ''}
      <div class="lbl">Each closed shape</div>
      <div class="seg" style="margin-bottom:8px">${[['own', 'Is its own'], ['add2', 'Adds to what it touches'], ['sub2', 'Cuts what\u2019s under it']].map(([v, nm]) =>
        `<button data-pact="${v}" class="${popt.mode === { own: 'own', add2: 'add', sub2: 'sub' }[v] ? 'on' : ''}" style="flex:1;font-size:11px">${nm}</button>`).join('')}</div>
      <p class="muted" style="font-size:11px;margin:0">Shift: 45° steps. Alt while dragging: a sharp turn (only the outgoing handle follows). Space while dragging: move the point.
        Click the last point: the next part starts straight. Backspace: undo a point. Esc: throw the path away. Finished paths can be reshaped with Edit nodes.</p>
      ${touchHelp()}`;
  };
  addEventListener('keyup', dzPenKeys = function penKeys(e) { if (!document.body.contains(el)) return removeEventListener('keyup', penKeys); if (e.key === ' ') spaceHeld = false; });
  /* ---------- Hold to snap (pencil and lasso) ----------
     Draw a shape roughly and hold still: after the hold time it becomes the line, circle, rectangle, triangle or
     polygon it looks like. Keep holding and move to resize it about its middle; let go to keep it. */
  const pcl = (() => { const o = { lazy: 20, smooth: 4, close: true, mode: 'own', hold: true, ms: 800, v: 2 }; try { const sv = JSON.parse(Settings.get('dz_pencil', '{}')); if (!sv.v && sv.ms === 420) delete sv.ms; return { ...o, ...sv, v: 2 }; } catch { return o; } })();
  const savePcl = () => Settings.set('dz_pencil', JSON.stringify(pcl));
  const holdWatch = (st, p, fire) => {
    if (!pcl.hold || st.snap) return;
    if (st.hp && Math.hypot((p.x - st.hp.x) * k, (p.y - st.hp.y) * k) < 3) return;   // still enough: the timer keeps running
    st.hp = p; clearTimeout(st.ht); st.ht = setTimeout(fire, pcl.ms);
  };
  const holdStart = (g, p) => { const S = dzSample(g.subs, 24); let cx = 0, cy = 0; for (const q of S) { cx += q.x; cy += q.y; } cx /= S.length; cy /= S.length;
    return { g, base: JSON.parse(JSON.stringify(g.subs)), cx, cy, d0: Math.max(1, Math.hypot(p.x - cx, p.y - cy)), f: 1, g0: { ...g, subs: JSON.parse(JSON.stringify(g.subs)) }, cur: S, p0: p, armed: false }; };
  const SNAP_DEAD = 12;   // screen px the pen can wander after a snap before dragging starts to resize it (same in the simulator)
  /* ---------- After a snap: Yours ... Cleaner ----------
     A bar under the drawing. The middle is the shape it snapped to. Left keeps the stroke as drawn, following the
     hand more closely the further it goes; right makes the shape plainer (an ellipse rounder, a rectangle squarer,
     a polygon more regular). Keep accepts it (and adds or cuts, if the pencil is set to); Cancel puts back the
     shape it snapped to. Starting another stroke or leaving the pencil keeps it as it is. */
  let qs = null;
  const qsScale = (subs, sn) => { const f = sn.f, c = sn.cx, d = sn.cy;
    return subs.map(sp => ({ closed: sp.closed, nodes: sp.nodes.map(n => ({ ...n, x: c + (n.x - c) * f, y: d + (n.y - d) * f, ix: n.ix * f, iy: n.iy * f, ox: n.ox * f, oy: n.oy * f })) })); };
  const qsAt = (t) => {
    const sn = qs.sn; if (Math.abs(t - 0.5) < 1e-9) return { label: sn.g.label, subs: sn.g.subs };
    const g0 = sn.g0, tol = pcl.smooth / k * Math.exp((t - 0.5) * 4.4);
    if (t < 0.5 || !g0.gen) {
      const sub = dzFitStroke(qs.raw.map(q => ({ x: sn.cx + (q.x - sn.cx) * sn.f, y: sn.cy + (q.y - sn.cy) * sn.f })), tol, g0.subs[0].closed);
      return sub ? { label: 'Drawing', subs: [sub] } : null;
    }
    const g = dzPlainer(g0, (t - 0.5) * 2); return { label: g.label, subs: qsScale(g.subs, sn) };
  };
  const qsApply = (t) => {
    const L = qs && doc.layers.find(x => x.id === qs.id); if (!L) return qsHide();
    const g = qsAt(t); if (!g) return; qs.t = t;
    const v = vecFromPage(g.subs, {}); Object.assign(L, { x: v.x, y: v.y, w: v.w, h: v.h, rot: 0, subs: v.subs, name: g.label }); changed();
    qsSay(g, L);
  };
  const qsSay = (g, L) => { const w = $('#dz-qs .dz-qs-what'); if (w) { const n = L.subs.reduce((a, sp) => a + sp.nodes.length, 0); w.textContent = `${g.label} \u00b7 ${n} node${n === 1 ? '' : 's'}`; } };
  const qsShow = (v, raw, sn, pend) => {
    qs = { id: v.id, raw: raw.slice(), sn, t: 0.5, pend }; const b = $('#dz-qs'); if (!b) return;
    b.querySelector('input').value = 50; b.querySelector('[data-qs="ok"]').textContent = pend === 'add' ? 'Add' : pend === 'sub' ? 'Cut' : 'Keep';
    b.hidden = false; qsSay(sn.g, v);
  };
  function qsHide() { qs = null; const b = $('#dz-qs'); if (b) b.hidden = true; }
  const qsDone = async (keep) => {
    if (!qs) return; const q = qs;
    if (!keep && Math.abs(q.t - 0.5) > 1e-9) qsApply(0.5);
    qsHide(); changed(true);
    if (keep && q.pend && doc.layers.some(x => x.id === q.id)) { penLast = q.id; await penCombine(q.pend); penLast = null; }
    drawSide();
  };
  const holdScale = (sn, p) => {
    if (!sn.armed) { if (Math.hypot((p.x - sn.p0.x) * k, (p.y - sn.p0.y) * k) < SNAP_DEAD) return; sn.armed = true; sn.d0 = Math.max(1, Math.hypot(p.x - sn.cx, p.y - sn.cy)); }   // past the dead zone: resizing starts from here, without a jump
    const f = Math.max(0.05, Math.hypot(p.x - sn.cx, p.y - sn.cy) / sn.d0); sn.f = f;
    sn.g.subs = sn.base.map(sp => ({ closed: sp.closed, nodes: sp.nodes.map(n => ({ ...n, x: sn.cx + (n.x - sn.cx) * f, y: sn.cy + (n.y - sn.cy) * f, ix: n.ix * f, iy: n.iy * f, ox: n.ox * f, oy: n.oy * f })) }));
    sn.cur = dzSample(sn.g.subs, 24); };
  const holdUI = () => `<div class="row" style="gap:8px;align-items:center;margin:4px 0"><label class="toggle" style="display:inline-flex"><input type="checkbox" data-holdon ${pcl.hold ? 'checked' : ''}><span>Hold to snap</span></label></div>
    ${pcl.hold ? slider('h:ms', 'Hold time', 150, 1500, 10, pcl.ms, v => v + ' ms') : ''}`;
  /* ---------- Pencil ----------
     Freehand drawing that becomes a node shape: Steady makes the line trail the pen on a string so wobbles don't
     show; Smoothing sets how closely the curve follows what was drawn (higher = fewer nodes, smoother). A stroke
     that comes back to its start closes itself. Each stroke can be its own, add to what it touches, or cut
     what's under it (those always close). Hold still to snap to a shape. N switches it on and off. */
  const startPencil = () => { endCrop(); endCut(); endNodes(); endCont(); endPen(); pclOn = true; sel = null; picks = new Set(); picking = false; placeSel(); drawSide(); };
  function endPencil() { if (!pclOn) return; if (qs) qsDone(true); pclOn = false; if (stroke) clearTimeout(stroke.ht); stroke = null; drawPen(); }
  const pclDown = (e) => {
    if (Settings.get('dz_pen', 'any') === 'pen' && e.pointerType === 'touch') return;   // stylus only: fingers move the view
    e.dzHit = true; e.preventDefault(); page.setPointerCapture(e.pointerId);
    if (qs) qsDone(true);
    const p = toPage(e); stroke = { pts: [p], lp: p }; drawPen();
  };
  const pclMove = (e) => {
    const d = stroke, p = toPage(e);
    if (pinch) { clearTimeout(d.ht); stroke = null; return drawPen(); }
    if (d.snap) { holdScale(d.snap, p); return drawPen(); }
    const L = pcl.lazy * 0.6 / k, dx = p.x - d.lp.x, dy = p.y - d.lp.y, dist = Math.hypot(dx, dy);
    if (dist > L) { const t = (dist - L) / dist; d.lp = { x: d.lp.x + dx * t, y: d.lp.y + dy * t }; const last = d.pts.at(-1); if (Math.hypot(d.lp.x - last.x, d.lp.y - last.y) * k > 1.2) d.pts.push(d.lp); }
    d.cur = L ? p : null;
    holdWatch(d, p, () => { if (!stroke) return; const g = dzGuess(stroke.pts); if (!g) return; stroke.snap = holdStart(g, p); drawPen(); toast(g.label + ': keep holding and drag to resize, then let go.', 2500); });
    drawPen();
  };
  const pclUp = async () => {
    const d = stroke; stroke = null; clearTimeout(d.ht); drawPen();
    let sub;
    const forceClose = pcl.mode !== 'own';
    if (d.snap) sub = d.snap.g.subs[0];
    else {
      if (d.pts.length < 2) return;
      const D = Math.hypot(Math.max(...d.pts.map(q => q.x)) - Math.min(...d.pts.map(q => q.x)), Math.max(...d.pts.map(q => q.y)) - Math.min(...d.pts.map(q => q.y)));
      if (D * k < 4) return;
      let len = 0; for (let i = 1; i < d.pts.length; i++) len += Math.hypot(d.pts[i].x - d.pts[i - 1].x, d.pts[i].y - d.pts[i - 1].y);
      const gap = Math.hypot(d.pts.at(-1).x - d.pts[0].x, d.pts.at(-1).y - d.pts[0].y), loop = pcl.close && gap < D * 0.2 && len > D * 1.5;
      sub = dzFitStroke(d.pts, pcl.smooth / k, loop || forceClose); if (!sub) return;
    }
    if (forceClose && sub.nodes.length > 2) sub.closed = true;
    const style = sub.closed ? { fill: '@accent', stroke: 'none', sw: 0 } : { fill: 'none', stroke: '@accent', sw: Math.max(2, Math.round(Math.min(doc.w, doc.h) * 0.006)) };
    const v = vecFromPage([sub], { ...style, name: d.snap ? d.snap.g.label : 'Drawing' });
    doc.layers.push(v); changed(true);
    if (d.snap) { qsShow(v, d.pts, d.snap, forceClose && sub.closed ? pcl.mode : null); return drawSide(); }   // tune it first, combine on Keep
    if (forceClose && sub.closed) { penLast = v.id; await penCombine(pcl.mode); penLast = null; }
    drawSide();
  };
  function drawStroke(x) {
    const d = stroke; if (!d) return;
    const P = d.snap ? d.snap.cur : d.pts; if (!P.length) return;
    x.lineWidth = d.snap ? 2 : 1.8; x.strokeStyle = d.snap ? '#2ecc71' : '#1fb6a6'; x.lineJoin = x.lineCap = 'round'; x.beginPath();
    P.forEach((q, i) => i ? x.lineTo(q.x * k, q.y * k) : x.moveTo(q.x * k, q.y * k)); x.stroke();
    if (d.cur && !d.snap) { x.setLineDash([2, 3]); x.strokeStyle = 'rgba(255,255,255,.6)'; x.beginPath(); x.moveTo(d.lp.x * k, d.lp.y * k); x.lineTo(d.cur.x * k, d.cur.y * k); x.stroke(); x.setLineDash([]); }
  }
  const pclAct = (a) => {
    if (a === 'done') { endPencil(); return drawSide(); }
    if (['own', 'add', 'sub'].includes(a)) { pcl.mode = a; savePcl(); return drawSide(); }
  };
  const pclPanel = () => `<div class="dz-lh"><b>Pencil</b><button class="btn small primary" data-pcl="done">Done</button></div>
    <p class="muted" style="font-size:12px;margin:0 0 8px">Draw freehand. Hold still before lifting to snap to a line, circle, rectangle, triangle or polygon, then move to resize it. After you let go, slide between Yours and Cleaner and press Keep.</p>
    ${slider('p:lazy', 'Steady', 0, 100, 1, pcl.lazy, v => v + '%')}
    ${slider('p:smooth', 'Smoothing', 1, 40, 0.5, pcl.smooth, v => v + ' px')}
    <label class="toggle" style="display:inline-flex;margin:2px 0 6px"><input type="checkbox" data-pclclose ${pcl.close ? 'checked' : ''}><span>A loop closes itself</span></label>
    ${holdUI()}
    <div class="lbl" style="margin-top:6px">Each stroke</div>
    <div class="seg" style="margin-bottom:8px">${[['own', 'Is its own'], ['add', 'Adds to what it touches'], ['sub', 'Cuts what\u2019s under it']].map(([v, nm]) =>
      `<button data-pcl="${v}" class="${pcl.mode === v ? 'on' : ''}" style="flex:1;font-size:11px">${nm}</button>`).join('')}</div>
    <p class="muted" style="font-size:11px;margin:0">Adding and cutting always close the stroke. Strokes are node shapes: reshape them with Edit nodes. N or Esc leaves the pencil.</p>`;
  const saveRef = async (ids) => {
    const list = groupOf(ids).filter(l => !l.hide), f = list.length && await flatten(list); if (!f) return toast('Nothing visible to save.');
    const title = await askText('Name for the reference:', list.length === 1 ? layerName(list[0]) : name); if (title == null) return;
    const s = Math.min(1, 420 / Math.max(f.cv.width, f.cv.height)), th = document.createElement('canvas');
    th.width = Math.max(1, Math.round(f.cv.width * s)); th.height = Math.max(1, Math.round(f.cv.height * s)); th.getContext('2d').drawImage(f.cv, 0, 0, th.width, th.height);
    await DB.run('INSERT INTO ref_images (title, category, photo_ref, thumb_ref, w, h) VALUES (?, ?, ?, ?, ?, ?)',
      [title.trim() || 'Design part', 'Design studio', await Media.save(await pngOf(f.cv), 'png'), await Media.save(await pngOf(th), 'png'), f.cv.width, f.cv.height]);
    toast('Saved to References, in Design studio.');
  };
  const savePng = async (ids) => {
    const list = groupOf(ids).filter(l => !l.hide), f = list.length && await flatten(list); if (!f) return toast('Nothing visible to save.');
    const fn = ((list.length === 1 ? layerName(list[0]) : name) || 'design').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) + '.png';
    const a = document.createElement('a'); a.href = URL.createObjectURL(await pngOf(f.cv)); a.download = fn; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Saved ' + fn);
  };
  const vecOnly = (ids) => { const list = groupOf(ids).filter(l => !l.hide); return list.length > 0 && list.every(dzVecOK); };
  const saveSvg = async (ids, asset) => {
    const list = groupOf(ids).filter(l => !l.hide); if (!list.length) return toast('Nothing visible to save.');
    if (!list.every(dzVecOK)) return toast('Only shapes with colour or gradient fills can be saved as SVG. Turn text into a shape first; pictures and textures are pixels.', 5000);
    const r = dzSvg(doc, list), nm = (list.length === 1 ? layerName(list[0]) : name) || 'shape';
    if (asset) {
      const a = await assetAsk(nm); if (!a) return;
      await assetAdd(r.svg, a.name, a.cat, dzAssetLayers(doc, list, r.x0, r.y0));
      return toast(`Saved to Assets › ${a.cat}.`);
    }
    const fn = nm.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) + '.svg';
    const l = document.createElement('a'); l.href = URL.createObjectURL(new Blob([r.svg], { type: 'image/svg+xml' })); l.download = fn; l.click(); setTimeout(() => URL.revokeObjectURL(l.href), 5000);
    toast('Saved ' + fn);
  };
  // Make a stencil: the selection as one picture (text, pictures and shapes alike) into the stencil maker, at its real width.
  const toStencil = async (ids) => {
    const list = groupOf(ids).filter(l => !l.hide), f = list.length && await flatten(list, 2400); if (!f) return toast('Nothing visible to make a stencil from.');
    // On the design's own background, as it looks; a dark background is turned light (and everything with it), so
    // pale text on a dark card still comes out as dark lines on paper.
    const c = document.createElement('canvas'); c.width = f.cv.width; c.height = f.cv.height; const x = c.getContext('2d');
    const bg = dzCol(doc, doc.bg?.c) || '#ffffff'; x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); x.drawImage(f.cv, 0, 0);
    x.fillStyle = bg; x.fillRect(0, 0, 1, 1); const [r0, g0, b0] = x.getImageData(0, 0, 1, 1).data; x.drawImage(f.cv, 0, 0, 1, 1, 0, 0, 1, 1);
    if (r0 * 0.299 + g0 * 0.587 + b0 * 0.114 < 128) { x.globalCompositeOperation = 'difference'; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
    const blob = await pngOf(c); await flush();
    await stLoad(new File([blob], 'design.png', { type: 'image/png' })); if (!ST.src) return;
    if (!DZ_KINDS[doc.kind].social) ST.cm = Math.min(300, Math.max(1, Math.round(f.bw / (doc.dpi || 300) * 25.4) / 10));
    ST.from = list.length === 1 ? layerName(list[0]) : name;
    location.hash = 'stencil';
  };
  // An asset onto the page, in the middle, at the size it was made (smaller only if it wouldn't fit): shapes saved
  // from a design come back as editable shapes, any other SVG as a picture.
  const addAsset = async () => {
    const r = await assetPick(); if (!r) return;
    const s = Math.min(1, doc.w * 0.95 / Math.max(1, r.w), doc.h * 0.95 / Math.max(1, r.h)), ox = (doc.w - r.w * s) / 2, oy = (doc.h - r.h * s) / 2;
    const ls = r.layers ? JSON.parse(r.layers) : null;
    if (!ls?.length) { sel = null; return add({ t: 'image', ref: r.svg_ref, name: r.name || undefined, x: ox, y: oy, w: r.w * s, h: r.h * s }); }
    const made = ls.map(l => ({ ...l, id: dzId(), x: ox + l.x * s, y: oy + l.y * s, w: l.w * s, h: (l.h || 0) * s, ...(l.sw ? { sw: l.sw * s } : {}), ...(l.r ? { r: l.r * s } : {}),
      ...(doc.sides && face !== 'f' ? { side: face } : {}) }));
    doc.layers.push(...made); changed(true);
    if (made.length === 1) { sel = made[0].id; drawSide(); } else setPicks(made.map(l => l.id));
  };
  // Line up the selected items with each other (one item: with the page), or space three or more evenly.
  const align = (how) => {
    const L = picked().filter(l => !l.lock); if (!L.length) return toast('Unlock the items first.');
    const bs = new Map(L.map(l => [l, box(l)])), all = [...bs.values()];
    const T = L.length === 1 && picks.size <= 1 ? { x0: 0, y0: 0, x1: doc.w, y1: doc.h }
      : { x0: Math.min(...all.map(b => b.x0)), y0: Math.min(...all.map(b => b.y0)), x1: Math.max(...all.map(b => b.x1)), y1: Math.max(...all.map(b => b.y1)) };
    if (how === 'dh' || how === 'dv') {
      const h = how === 'dh', cen = (b) => h ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2, o = [...L].sort((p, q) => cen(bs.get(p)) - cen(bs.get(q)));
      const c0 = cen(bs.get(o[0])), c1 = cen(bs.get(o.at(-1)));
      o.forEach((l, i) => { const dv = c0 + (c1 - c0) * i / (o.length - 1) - cen(bs.get(l)); if (h) l.x += dv; else l.y += dv; });
    } else for (const l of L) { const b = bs.get(l);
      if (how === 'l') l.x += T.x0 - b.x0; if (how === 'r') l.x += T.x1 - b.x1; if (how === 'c') l.x += (T.x0 + T.x1 - b.x0 - b.x1) / 2;
      if (how === 't') l.y += T.y0 - b.y0; if (how === 'b') l.y += T.y1 - b.y1; if (how === 'm') l.y += (T.y0 + T.y1 - b.y0 - b.y1) / 2; }
    changed(true);
  };
  const multiAct = async (a) => {
    const L = picked(), every = (f) => L.length && L.every(f);
    if (a === 'pick') return startPicking(null);
    if (a === 'done') { picking = false; return setPicks([]); }
    if (a === 'all') { if (!picking && !many()) picking = true; return setPicks(F().filter(l => !l.hide).map(l => l.id)); }
    if (a === 'none') return setPicks([]);
    if (a === 'merge') return merge(targets());
    if (a === 'refs') return saveRef(targets());
    if (a === 'png') return savePng(targets());
    if (a === 'svg' || a === 'asset') return saveSvg(targets(), a === 'asset');
    if (a === 'stencil') return toStencil(targets());
    if (!L.length) return;
    if (a === 'hide') { const v = !every(l => l.hide); L.forEach(l => l.hide = v); }
    if (a === 'lock') { const v = !every(l => l.lock); L.forEach(l => l.lock = v); }
    if (a === 'clip') { const v = !every(l => l.clip); L.forEach(l => { if (F().indexOf(l) > 0) l.clip = v || undefined; }); }
    if (a === 'del' && L.some(l => l.lock)) return toast('Unlock them first.');
    if (a === 'del') { const gone = new Set(L.map(l => l.id)); doc.layers = doc.layers.filter(l => !gone.has(l.id)); picks = new Set(); toast(`Deleted ${L.length}. Undo brings ${L.length === 1 ? 'it' : 'them'} back.`); }
    if (a === 'dup') {   // copies go together above the highest one, keeping their order (and clipping)
      const top = Math.max(...L.map(l => doc.layers.indexOf(l))), cs = L.map(l => ({ ...JSON.parse(JSON.stringify(l)), id: dzId(), x: l.x + 30, y: l.y + 30, lock: undefined }));
      const idm = new Map(L.map((l, j) => [l.id, cs[j].id])); for (const c of cs) if (c.on) { delete c._bx; if (idm.has(c.on)) c.on = idm.get(c.on); }
      doc.layers.splice(top + 1, 0, ...cs); picks = new Set(cs.map(c => c.id));
    }
    changed(true); placeSel(); drawSide();
  };

  /* Duplicate in place, copy, cut and paste. Copies go above the highest original, keep their order and anything
     they sit on (text on a curve). Paste puts them a little down and right of the last paste; paste in place, on the
     very spot they were copied from. */
  const dupInPlace = (ids) => { const L = doc.layers.filter(l => ids.includes(l.id)), top = Math.max(...L.map(l => doc.layers.indexOf(l))), cs = L.map(l => ({ ...JSON.parse(JSON.stringify(l)), id: dzId(), lock: undefined }));
    const idm = new Map(L.map((l, j) => [l.id, cs[j].id])); for (const c of cs) if (c.on) { delete c._bx; if (idm.has(c.on)) c.on = idm.get(c.on); }
    doc.layers.splice(top + 1, 0, ...cs); if (cs.length === 1) select(cs[0].id); else setPicks(cs.map(c => c.id)); changed(true); drawSide(); return cs; };
  const clipCopy = (cut) => { const ids = targets(); if (!ids.length) return false; const L = doc.layers.filter(l => ids.includes(l.id));
    DZ_CLIP = { layers: JSON.parse(JSON.stringify(L)), n: 0 }; if (cut) { if (L.some(l => l.lock)) { toast('Unlock it first.'); return true; } doc.layers = doc.layers.filter(l => !ids.includes(l.id)); select(null); changed(true); drawSide(); }
    toast(`${cut ? 'Cut' : 'Copied'} ${L.length === 1 ? '1 item' : L.length + ' items'}. Ctrl+V pastes, Ctrl+Shift+V pastes in place.`, 2200); return true; };
  const clipPaste = (inPlace) => { if (!DZ_CLIP?.layers.length) return toast('Nothing copied yet.', 1500); const off = inPlace ? 0 : 30 * ++DZ_CLIP.n;
    const cs = DZ_CLIP.layers.map(l => ({ ...JSON.parse(JSON.stringify(l)), id: dzId(), lock: undefined, x: l.x + off, y: l.y + off, ...(doc.sides ? { side: face !== 'f' ? face : l.side } : {}) }));
    const idm = new Map(DZ_CLIP.layers.map((l, j) => [l.id, cs[j].id])); for (const c of cs) if (c.on) { delete c._bx; c.on = idm.get(c.on) || (doc.layers.some(o => o.id === c.on) ? c.on : undefined); }
    if (!doc.chal) for (const c of cs) { delete c.role; delete c.nds; delete c.sh; }   /* grading only means something in a challenge */
    doc.layers.push(...cs); if (cs.length === 1) select(cs[0].id); else setPicks(cs.map(c => c.id)); changed(true); drawSide(); };

  /* Adding things */
  const center = (w, h) => ({ x: (doc.w - w) / 2, y: (doc.h - h) / 2, w, h });
  const add = (l) => { doc.layers.push({ id: dzId(), op: 1, rot: 0, ...l, ...(doc.sides && face !== 'f' ? { side: face } : {}) }); sel = doc.layers.at(-1).id; changed(true); drawSide(); };
  const importPic = async (file, max = 2000) => {
    if (/svg/.test(file.type) || /\.svg$/i.test(file.name || '')) {   // an SVG: drawn crisp to a clear-background picture
      const u = URL.createObjectURL(file), im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That SVG could not be read.')); i.src = u; });
      const nw = im.naturalWidth || 1000, nh = im.naturalHeight || 1000, s = Math.min(max, 1600) / Math.max(nw, nh), c = document.createElement('canvas'); c.width = Math.round(nw * s); c.height = Math.round(nh * s);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
      const ref = await Media.save(await new Promise(r => c.toBlob(r, 'image/png')), 'png'); return { ref, ar: c.width / c.height }; }
    const alpha = /png|webp|gif/.test(file.type);
    const blob = alpha ? await pngBlob(file, max) : await Media.shrink(file, max, 0.9);
    const ref = await Media.save(blob, alpha ? 'png' : 'jpg');
    const bmp = await createImageBitmap(blob); return { ref, ar: bmp.width / bmp.height };
  };

  /* Pointer: select, move, resize, rotate, with centre guides. */
  const toPage = (e) => { const r = page.getBoundingClientRect(); return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }; };
  const hit = (p) => {
    const over = (l) => { const a = -(l.rot || 0) * Math.PI / 180, cx = l.x + l.w / 2, cy = l.y + (l.h || 0) / 2, dx = p.x - cx, dy = p.y - cy;
      const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a), tol = 10 / k;
      return Math.abs(lx) <= l.w / 2 + tol && Math.abs(ly) <= (l.h || 0) / 2 + tol; };
    const L = F();   // only the page being edited (master items are edited on the Master tab)
    for (let i = L.length - 1; i >= 0; i--) {
      const l = L[i]; if (l.hide || !over(l)) continue;
      const cv0 = dzCurves.get(l); if (cv0) { const r = l.size * 1.3 + Math.abs(l.pb || 0) + 10 / k; if (!cv0.P.some(q => Math.hypot(q.x - p.x, q.y - p.y) < r)) continue; }
      if (i > 0 && l.clip) { let b = i; while (b > 0 && L[b].clip) b--; if (L[b].hide || !over(L[b])) continue; }   // only where it shows
      return l;
    }
    return null;
  };
  // Guide lines at page positions (false = hidden).
  const guides = (gx, gy) => { const v = page.querySelector('.dz-guide.v'), hz = page.querySelector('.dz-guide.hz');
    v.hidden = gx === false; hz.hidden = gy === false; if (gx !== false) v.style.left = gx * k + 'px'; if (gy !== false) hz.style.top = gy * k + 'px'; };
  // Snapping: edges and centres line up with the page and with every other item on the page (the master page's too),
  // while moving, resizing, placing pen points and dragging nodes. Hold Alt for none. Options are in the strip's magnet.
  const snapO = (() => { try { return { on: true, page: true, edges: true, mids: true, dist: 10, gap: 0, ...JSON.parse(Settings.get('dz_snap', '{}')) }; } catch { return { on: true, page: true, edges: true, mids: true, dist: 10, gap: 0 }; } })();
  const snapTargets = (ids) => { const tx = [], ty = [], G = snapO.gap || 0;
    const gs = gridSteps(); if (gs) { tx.grid = gs.x; ty.grid = gs.y; }
    if (!snapO.on) return { tx, ty };
    if (snapO.page) { tx.push(0, doc.w / 2, doc.w); ty.push(0, doc.h / 2, doc.h); }
    for (const o of dzPages(doc, face).flat()) if (!o.hide && !ids.has(o.id)) { const b = box(o);
      if (snapO.edges) { tx.push(b.x0, b.x1); ty.push(b.y0, b.y1); if (G) { tx.push(b.x0 - G, b.x1 + G); ty.push(b.y0 - G, b.y1 + G); } }
      if (snapO.mids) { tx.push((b.x0 + b.x1) / 2); ty.push((b.y0 + b.y1) / 2); } }
    return { tx, ty }; };
  const snapBest = (cs, ts) => { let r = null; const try1 = (c, v) => { const d = v - c; if (Math.abs(d) < snapO.dist / k && (!r || Math.abs(d) < Math.abs(r.d))) r = { d, t: v }; };
    for (const c of cs) { for (const v of ts) try1(c, v); if (ts.grid) try1(c, Math.round(c / ts.grid) * ts.grid); } return r; };   // ts.grid: the grid's line spacing on this axis
  // lock: the axis Shift is holding still ('x' or 'y'), which doesn't snap.
  const snapTo = (list, e, lock) => {
    if (e.altKey || !(snapO.on || gSnap()) || !list.length) return guides(false, false);
    const ids = new Set(list.map(m => m.id)), bs = list.map(box), { tx, ty } = snapTargets(ids);
    const B = { x0: Math.min(...bs.map(b => b.x0)), x1: Math.max(...bs.map(b => b.x1)), y0: Math.min(...bs.map(b => b.y0)), y1: Math.max(...bs.map(b => b.y1)) };
    const sx = lock === 'x' ? null : snapBest([B.x0, (B.x0 + B.x1) / 2, B.x1], tx), sy = lock === 'y' ? null : snapBest([B.y0, (B.y0 + B.y1) / 2, B.y1], ty);
    for (const m of list) { if (sx) m.x += sx.d; if (sy) m.y += sy.d; }
    guides(sx ? sx.t : false, sy ? sy.t : false);
  };
  // One point (a pen point or a node) snapped the same way.
  const snapPt = (p, e, ids = new Set()) => { if (e.altKey || !(snapO.on || gSnap())) { guides(false, false); return p; }
    const { tx, ty } = snapTargets(ids), sx = snapBest([p.x], tx), sy = snapBest([p.y], ty); guides(sx ? sx.t : false, sy ? sy.t : false);
    return { ...p, x: p.x + (sx?.d || 0), y: p.y + (sy?.d || 0) }; };
  let drag = null;
  const pts = new Map(); let pinch = null, bg = null;
  /* Shift, Alt and Ctrl without a keyboard. While something is being dragged (an item, a node or handle, the
     pen, the pencil, a selection), a finger resting on the screen is Shift and two resting fingers are Ctrl,
     instead of zooming. The Shift / Alt / Ctrl buttons (shown on touchscreens while a tool is in use) stay on
     until tapped again. Every pointer event on the design reads them through modEv, as if the keys were held. */
  const rest = new Set(), dock = { shift: false, alt: false, ctrl: false };
  const busy = () => !!(drag || ndrag || pen?.drag || stroke || cutDrag || cdrag);
  const modEv = (e) => new Proxy(e, {
    get(t, kk) {
      if (kk === 'shiftKey') return t.shiftKey || dock.shift || rest.size === 1;
      if (kk === 'altKey') return t.altKey || dock.alt;
      if (kk === 'ctrlKey') return t.ctrlKey || dock.ctrl || rest.size >= 2;
      const v = t[kk]; return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, kk, v) { t[kk] = v; return true; }
  });
  const touchy = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const drawMods = () => {
    const b = $('#dz-mods'); if (!b) return;
    b.hidden = !(touchy && (nodes || penOn || pclOn || cut || cont || layer() || many()));
    b.querySelectorAll('[data-mod]').forEach(x => x.classList.toggle('on', !!dock[x.dataset.mod]));
  };
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-rf]') || refG) return;   // a reference picture's own gesture, not a pan or pinch of the design
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2 && busy() && e.pointerType === 'touch') { rest.add(e.pointerId); return; }   // a resting finger: a modifier, not a zoom
    if (pts.size === 2) {
      // A second finger: stop moving the item (put it back) and pinch the view instead.
      if (drag) { const l = layer(); if (l) Object.assign(l, drag.l0); drag = null; guides(false, false); redraw(); }
      if (bg) clearTimeout(bg.ht); bg = null; marq = null; marqDraw(); const [a, b] = [...pts.values()], r = stage.getBoundingClientRect();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, vx, vy };
    }
  }, true);
  stage.addEventListener('pointerdown', (e) => {
    if (pinch || e.dzHit || rest.has(e.pointerId) || e.target.closest('.dz-xf, .dz-zoom, .dz-faces, .dz-mods, .dz-nmenu, .dz-qs, .dz-rail, .dz-pop, .dz-notebar, [data-rf]')) return;
    // Background (around the design, or an empty part of it): drag to pan, tap to deselect. Shift-drag, or on a
    // touchscreen a moment's hold before dragging, draws a selection box instead.
    stage.setPointerCapture(e.pointerId);
    const free = !(penOn || pclOn || cut || nodes || cont || cropping);
    if (free && modEv(e).shiftKey) return marqStart(e, true);
    bg = { x: e.clientX, y: e.clientY, vx, vy, moved: false };
    if (free && e.pointerType !== 'mouse') { const b0 = bg; bg.ht = setTimeout(() => { if (bg === b0 && !b0.moved && !pinch) { bg = null; navigator.vibrate?.(25); marqStart(e, false); } }, 500); }
  });
  /* Selection box: dragged left to right it picks what lies wholly inside; right to left, anything it touches. */
  let marq = null;
  const marqStart = (e, add) => { marq = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, add }; marqDraw(); };
  const marqDraw = () => {
    const b = $('#dz-marq'); if (!b) return; b.hidden = !marq; if (!marq) return;
    const r = stage.getBoundingClientRect(), x = Math.min(marq.x0, marq.x1), y = Math.min(marq.y0, marq.y1);
    Object.assign(b.style, { left: x - r.left + 'px', top: y - r.top + 'px', width: Math.abs(marq.x1 - marq.x0) + 'px', height: Math.abs(marq.y1 - marq.y0) + 'px' });
    b.classList.toggle('touch', marq.x1 < marq.x0);
  };
  const marqEnd = () => {
    const m = marq; marq = null; marqDraw(); if (!m) return;
    const pr = page.getBoundingClientRect(), P = (cx, cy) => ({ x: (cx - pr.left) / k, y: (cy - pr.top) / k });
    const a = P(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1)), b = P(Math.max(m.x0, m.x1), Math.max(m.y0, m.y1)), touch = m.x1 < m.x0;
    if (Math.abs(m.x1 - m.x0) + Math.abs(m.y1 - m.y0) < 6) { if (!m.add && (sel || picks.size) && !picking) select(null); return; }
    const ids = F().filter(l => !l.hide && !l.lock).filter(l => {
      const t = (l.rot || 0) * Math.PI / 180, c = Math.cos(t), s2 = Math.sin(t), cx = l.x + l.w / 2, cy = l.y + (l.h || 0) / 2;
      const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const dx = u * l.w / 2, dy = v * (l.h || 0) / 2; return { x: cx + dx * c - dy * s2, y: cy + dx * s2 + dy * c }; });
      const x0 = Math.min(...cs.map(q => q.x)), x1 = Math.max(...cs.map(q => q.x)), y0 = Math.min(...cs.map(q => q.y)), y1 = Math.max(...cs.map(q => q.y));
      return touch ? x1 >= a.x && x0 <= b.x && y1 >= a.y && y0 <= b.y : x0 >= a.x && x1 <= b.x && y0 >= a.y && y1 <= b.y;
    }).map(l => l.id);
    const base = m.add || picking ? new Set([...picks, ...(sel ? [sel] : [])]) : new Set();
    ids.forEach(id => base.add(id));
    if (!base.size) return select(null);
    setPicks(base);
    if (ids.length) toast(`${ids.length} selected.`, 1200);
  };
  stage.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()], r = stage.getBoundingClientRect(), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      vx = pinch.vx + mx - pinch.mx; vy = pinch.vy + my - pinch.my; z = pinch.z;   // two-finger pan from where it started
      fit(false); zoomTo(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, mx, my);
      return;
    }
    if (marq) { marq.x1 = e.clientX; marq.y1 = e.clientY; return marqDraw(); }
    if (bg) { const dx = e.clientX - bg.x, dy = e.clientY - bg.y; if (Math.abs(dx) + Math.abs(dy) > 5) bg.moved = true;
      if (bg.moved) { vx = bg.vx + dx; vy = bg.vy + dy; fit(false); } }
  });
  const ptUp = (e) => {
    pts.delete(e.pointerId); if (rest.delete(e.pointerId)) return;
    if (marq) return marqEnd();
    if (pinch && pts.size < 2) { pinch = null; bg = null; return; }
    if (bg) { clearTimeout(bg.ht); if (!bg.moved && (sel || (picks.size && !picking))) select(null); bg = null; }
  };
  stage.addEventListener('pointerup', ptUp); stage.addEventListener('pointercancel', ptUp);
  stage.addEventListener('wheel', (e) => { if (e.target.closest('.dz-pop')) return; e.preventDefault(); const r = stage.getBoundingClientRect();
    zoomTo(z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  /* Full screen design: the editor covers the app (no menus), the browser's bars hide where allowed, and the
     side panel can be tucked away so the design gets the whole screen. One button leaves both. */
  let fsByUs = false;
  const focus = (on) => {
    const b = document.body; if (on === b.classList.contains('dz-focus')) return;
    b.classList.toggle('dz-focus', on); if (!on) b.classList.remove('dz-noside');
    const fb = $('#dz-focus');
    if (fb) { fb.innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
      fb.dataset.tip = on ? 'Leave full screen' : 'Full screen: the design fills the screen'; fb.setAttribute('aria-label', fb.dataset.tip); fb.classList.toggle('primary', on); }
    if (typeof FS !== 'undefined') { if (on && !FS.on() && FS.can()) { fsByUs = true; FS.set(true); } else if (!on && (fsByUs || FS.on())) { fsByUs = false; FS.set(false); } }
    stage.style.height = ''; requestAnimationFrame(() => { fit(); redraw(); });
  };
  $('#dz-focus').onclick = () => focus(!document.body.classList.contains('dz-focus'));
  $('#dz-qs').oninput = (e) => { if (qs && e.target.type === 'range') qsApply(+e.target.value / 100); };
  $('#dz-qs').onclick = (e) => { const a = e.target.closest('[data-qs]')?.dataset.qs; if (a) qsDone(a === 'ok'); };
  $('#dz-mods').onclick = (e) => { const m = e.target.closest('[data-mod]')?.dataset.mod; if (!m) return; dock[m] = !dock[m]; drawMods(); };
  $('#dz-faces').onclick = async (e) => { const f = e.target.closest('[data-face]')?.dataset.face; if (f) return setFace(f);
    const a = e.target.closest('[data-fpage]')?.dataset.fpage; if (!a) return;
    if (a === 'add') { doc.pages++; setFace('p' + doc.pages); return changed(true); }
    const last = 'p' + doc.pages, n = doc.layers.filter(l => l.side === last).length;
    if (!await ask(`Delete page ${doc.pages}?` + (n ? `\n\nIts ${n} item${n > 1 ? 's' : ''} will be removed.` : ''))) return;
    if (face === last) setFace(doc.pages === 2 ? 'f' : 'p' + (doc.pages - 1)); doc.layers = doc.layers.filter(l => l.side !== last); doc.pages--; changed(true); drawFaces(); };
  stage.querySelector('.dz-zoom').onclick = (e) => { const b = e.target.closest('[data-z]'); if (!b) return;
    if (b.dataset.z === 'fit') return frame(); zoomTo(z * (b.dataset.z === 'in' ? 1.4 : 1 / 1.4)); };
  let dupDrag = false;   // this drag started with Ctrl+Alt: a copy is being dragged
  let press = null;   // long press: hold still on an item to start selecting several
  const cancelPress = () => { if (press) clearTimeout(press.t); press = null; };
  page.addEventListener('pointerdown', (e) => {
    if (rest.has(e.pointerId)) return;
    e = modEv(e); closeNodeMenu();
    cancelPress();
    if (pinch || pts.size > 1) return;
    if (penOn) return penDown(e);
    if (pclOn) return pclDown(e);
    if (cut) return cutDown(e);
    if (nodes) return nodeDown(e);
    if (cont) return contDown(e);
    const h = e.target.closest('[data-h]')?.dataset.h, p = toPage(e);
    if (!h && !many()) { const hl0 = hit(p), now = Date.now();
      // A double-tap on a shape, or a tap with the Nodes tool waiting, opens its nodes.
      const twice = hl0 && itemTap?.id === hl0.id && now - itemTap.t < 350; itemTap = hl0 ? { id: hl0.id, t: now } : null;
      if (canNodes(hl0) && !hl0.lock && (twice || nodeArm)) { nodeArm = false; itemTap = null; cancelPress(); e.dzHit = true; e.preventDefault(); select(hl0.id); return startNodes(hl0); }
      if (nodeArm && !hl0) { nodeArm = false; drawRail(); } }
    if (!h || many()) {
      const hl = hit(p);
      if (hl && e.ctrlKey && e.altKey && !many() && !hl.lock) { const c = JSON.parse(JSON.stringify(hl)); c.id = dzId(); if (c.on) { const S = doc.layers.find(s => s.id === c.on); if (S) { const c2 = { ...JSON.parse(JSON.stringify(S)), id: dzId() }; doc.layers.splice(doc.layers.indexOf(S) + 1, 0, c2); c.on = c2.id; } } doc.layers.splice(doc.layers.indexOf(hl) + 1, 0, c); select(c.id); dupDrag = true; }
      else if (hl && (e.ctrlKey || e.metaKey || e.shiftKey)) { e.dzHit = true; return togglePick(hl.id); }
      if (many() && hl) {
        // Several selected: tapping one in selection mode adds it (or, without moving, takes it out); dragging moves them all.
        e.dzHit = true; e.preventDefault();
        const was = picks.has(hl.id); if (!was) { if (!picking) return select(hl.id); setPicks([...picks, hl.id]); }
        page.setPointerCapture(e.pointerId);
        drag = { h: 'group', p0: p, moved: false, tap: was && picking ? hl.id : null, l0: new Map(picked().filter(m => !m.lock).map(m => [m.id, { x: m.x, y: m.y }])) };
        return;
      }
      if (many()) return;
      if (hl) press = { x: e.clientX, y: e.clientY, t: setTimeout(() => { press = null; if (drag) { const l = layer(); if (l) Object.assign(l, drag.l0); drag = null; guides(false, false); redraw(); } startPicking(hl.id); }, 550) };
    }
    let l = layer();
    if (!h) { const hl = hit(p); if (hl?.id !== sel) { select(hl?.id || null); l = hl; } }
    if (!l) return;
    e.dzHit = true;   // an item was picked: the stage doesn't pan
    if (l.lock) return;   // selected, but it stays where it is
    e.preventDefault(); page.setPointerCapture(e.pointerId);
    drag = { h: h || (cropping ? 'pan' : 'move'), p0: p, dup: dupDrag, l0: { ...l, crop: l.crop ? { ...l.crop } : null } }; dupDrag = false;
  });
  page.addEventListener('pointermove', (e) => {
    if (rest.has(e.pointerId)) return;
    e = modEv(e);
    if (pen) return penMove(e);
    if (stroke) return pclMove(e);
    if (cutDrag) return cutMove(e);
    if (ndrag) return nodeMove(e);
    if (cdrag) return contMove(e);
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancelPress();
    if (!drag || pinch) return;
    if (drag.h === 'group') {
      const p = toPage(e), fine = e.altKey ? 0.25 : 1; let dx = (p.x - drag.p0.x) * fine, dy = (p.y - drag.p0.y) * fine;
      if (!drag.moved && Math.hypot(dx, dy) * k < 6) return; drag.moved = true;
      const lock = e.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'y' : 'x') : null; if (lock === 'y') dy = 0; if (lock === 'x') dx = 0;
      for (const [id, o] of drag.l0) { const m = doc.layers.find(x => x.id === id); if (m && !(m.on && drag.l0.has(m.on))) { m.x = o.x + dx; m.y = o.y + dy; } }
      snapTo(doc.layers.filter(m => drag.l0.has(m.id) && !(m.on && drag.l0.has(m.on))), e, lock);
      placeSel(); return redraw();
    }
    const l = layer(), p = toPage(e), o = drag.l0, a = (o.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    if (cropping && o.crop) {
      // Crop: edges cut away (the whole stays where it is); dragging inside slides the whole under the window.
      const fn = e.altKey ? 0.25 : 1, dx = (p.x - drag.p0.x) * fn, dy = (p.y - drag.p0.y) * fn, lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
      const c0 = o.crop, FW = o.w / c0.w, FH = o.h / c0.h, mn = 0.04, cl = (v, a1, b1) => Math.max(a1, Math.min(b1, v));
      if (drag.h === 'pan') { l.crop = { ...c0, x: cl(c0.x - lx / FW, 0, 1 - c0.w), y: cl(c0.y - ly / FH, 0, 1 - c0.h) }; }
      else if (drag.h !== 'rot') {
        let L = c0.x, T = c0.y, Rr = c0.x + c0.w, B = c0.y + c0.h;
        if (drag.h.includes('e')) Rr = cl(Rr + lx / FW, L + mn, 1);
        if (drag.h.includes('w')) L = cl(L + lx / FW, 0, Rr - mn);
        if (drag.h.includes('s')) B = cl(B + ly / FH, T + mn, 1);
        if (drag.h.includes('n')) T = cl(T + ly / FH, 0, B - mn);
        const c = { x: L, y: T, w: Rr - L, h: B - T }; l.crop = c; l.w = c.w * FW; l.h = c.h * FH;
        const ux = (c0.x + c0.w / 2 - 0.5) * FW, uy = (c0.y + c0.h / 2 - 0.5) * FH, vx = (c.x + c.w / 2 - 0.5) * FW, vy = (c.y + c.h / 2 - 0.5) * FH;
        const ccx = o.x + o.w / 2 - (ux * cos - uy * sin), ccy = o.y + o.h / 2 - (ux * sin + uy * cos);
        l.x = ccx + vx * cos - vy * sin - l.w / 2; l.y = ccy + vx * sin + vy * cos - l.h / 2;
      }
    } else if (drag.h === 'move') {
      // Shift: straight across or down. Alt: fine and without snapping (not while Ctrl+Alt is making a copy).
      const alt = e.altKey && !drag.dup, fine = alt ? 0.25 : 1; let dx = (p.x - drag.p0.x) * fine, dy = (p.y - drag.p0.y) * fine;
      const lock = e.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'y' : 'x') : null; if (lock === 'y') dy = 0; if (lock === 'x') dx = 0;
      l.x = o.x + dx; l.y = o.y + dy;
      snapTo([l], { altKey: alt }, lock);
    } else if (drag.h === 'rot') {
      const cx = o.x + o.w / 2, cy = o.y + (o.h || 0) / 2;
      let deg = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90; deg = ((deg + 540) % 360) - 180;
      // Shift: 15 degree steps. Alt: free and fine. Otherwise it only catches near each 15 degrees.
      const near = Math.round(deg / 15) * 15; if (e.shiftKey || (!e.altKey && Math.abs(deg - near) < 4)) deg = near;
      l.rot = e.altKey ? Math.round(deg * 10) / 10 : Math.round(deg);
    } else {
      // Resize around the opposite corner/side, measured in the layer's own (rotated) frame.
      // Shift: keep (or, for pictures, break) the proportions. Ctrl: from the centre. Alt: fine, and no snapping.
      const fine = e.altKey ? 0.25 : 1, mid = e.ctrlKey ? 2 : 1, dx = (p.x - drag.p0.x) * fine, dy = (p.y - drag.p0.y) * fine, lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
      const sx = drag.h.includes('e') ? 1 : drag.h.includes('w') ? -1 : 0, sy = drag.h.includes('s') ? 1 : drag.h.includes('n') ? -1 : 0;
      const oh = o.h || 1, normal = o.t === 'text' && !o.frame, keep = o.shape !== 'line' && (normal ? sx && sy : dzKeep(o) !== e.shiftKey);
      let w = Math.max(20, o.w + sx * lx * mid), hgt = Math.max(10, oh + sy * ly * mid), snapX = null, snapY = null;
      const ocx = o.x + o.w / 2, ocy = o.y + oh / 2;
      if (!o.rot && !e.altKey && (snapO.on || gSnap())) { const { tx, ty } = snapTargets(new Set([l.id]));
        if (sx) { const ed = mid > 1 ? ocx + sx * w / 2 : sx > 0 ? o.x + w : o.x + o.w - w; snapX = snapBest([ed], tx); if (snapX) w = Math.max(20, w + sx * snapX.d * mid); }
        if (sy && !(normal && snapX)) { const ed = mid > 1 ? ocy + sy * hgt / 2 : sy > 0 ? o.y + hgt : o.y + oh - hgt; snapY = snapBest([ed], ty); if (snapY) hgt = Math.max(10, hgt + sy * snapY.d * mid); } }
      if (keep) { const s = snapX ? w / o.w : snapY ? hgt / oh : sx && sy ? Math.max(w / o.w, hgt / oh) : sx ? w / o.w : hgt / oh; w = o.w * s; hgt = oh * s; if (normal) l.size = Math.max(6, o.size * s); }
      guides(snapX ? snapX.t : false, snapY ? snapY.t : false);
      // Keep the opposite edge where it was (from the centre: the centre).
      const ax = -sx * o.w / 2, ay = -sy * oh / 2, wx = ocx + ax * cos - ay * sin, wy = ocy + ax * sin + ay * cos;
      const nax = -sx * w / 2, nay = -sy * hgt / 2, ncx = mid > 1 ? ocx : wx - (nax * cos - nay * sin), ncy = mid > 1 ? ocy : wy - (nax * sin + nay * cos);
      l.w = w; if (!normal) l.h = hgt;
      l.x = ncx - w / 2; l.y = ncy - (normal ? oh * (w / o.w) : hgt) / 2;
    }
    redraw();
  });
  const end = () => { cancelPress(); guides(false, false); requestAnimationFrame(drawXf); if (pen?.drag) { pen.drag = null; return drawPen(); } if (stroke) return pclUp(); if (cutDrag) return cutUp(); if (ndrag) return nodeUp(); if (cdrag) { cdrag = null; return; } if (!drag) return; const d = drag; drag = null; guides(false, false);
    if (d.h === 'group') { if (d.moved) changed(true); else if (d.tap) { picks.delete(d.tap); setPicks(picks); } return; }
    changed(true); drawSide(); };
  page.addEventListener('pointerup', end); page.addEventListener('pointercancel', end);
  addEventListener('keydown', dzKeys = function keys(e) {
    if (!document.body.contains(el)) return removeEventListener('keydown', keys);
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); return undo(e.shiftKey ? 1 : -1); }
    if (pclOn && !stroke && e.key === 'Escape') { e.preventDefault(); endPencil(); return drawSide(); }
    if (pclOn) { if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey) { endPencil(); drawSide(); } return; }
    if (penOn || pen) {
      if (e.key === ' ') { e.preventDefault(); spaceHeld = true; return; }
      if (e.key === 'Enter') { e.preventDefault(); return penFinish(); }
      if (e.key === 'Escape') { e.preventDefault(); if (pen) { pen = null; drawPen(); drawSide(); } else { endPen(); drawSide(); } return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); return penBack(); }
      if (penOn) return;
    }
    if (cont) {
      if (e.key === 'Enter') { e.preventDefault(); return contApply(); }
      if (e.key === 'Escape') { endCont(); return drawSide(); }
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !cut && !nodes && !cont) {   // tool keys, as on the drawing board
      const k1 = e.key.toLowerCase();
      if (k1 === 'o' && targets().length) { e.preventDefault(); return startCont(); }
      if (k1 === 'p') { e.preventDefault(); return startPen(); }
      if (k1 === 'n') { e.preventDefault(); return startPencil(); }
      if (k1 === 'a' && layer()?.t === 'shape' && layer().shape !== 'line') { e.preventDefault(); return startNodes(layer()); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); return setPicks(F().filter(l => !l.hide).map(l => l.id)); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); if (targets().length) merge(targets()); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !nodes && !cut) { const k2 = e.key.toLowerCase();
      if (k2 === 'c' && targets().length) { e.preventDefault(); return void clipCopy(false); }
      if (k2 === 'x' && targets().length) { e.preventDefault(); return void clipCopy(true); }
      if (k2 === 'v' && DZ_CLIP) { e.preventDefault(); return clipPaste(e.shiftKey); }
      if (k2 === 'd' && targets().length) { e.preventDefault(); return void dupInPlace(targets()); } }
    if (many()) {
      if (e.key === 'Escape') { picking = false; return setPicks([]); }
      if (e.key === 'Delete' || e.key === 'Backspace') return multiAct('del');
      const st = e.shiftKey ? 20 : e.altKey ? 1 : 4, mv = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
      if (mv) { e.preventDefault(); for (const m of picked()) if (!m.lock && !(m.on && picks.has(m.on))) { m.x += mv[0]; m.y += mv[1]; } changed(); placeSel(); }
      return;
    }
    const l = layer(); if (!l) return;
    if (nodes) {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); nodeOp('del'); }
      if (e.key === 'Escape') { endNodes(); drawSide(); }
      return;
    }
    if (cut) {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); cutOp('del'); }
      if (e.key === 'Escape') { endCut(); drawSide(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); cutOp('invert'); }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && l.lock) return toast('Unlock it first.');
    if (e.key === 'Delete' || e.key === 'Backspace') { doc.layers = doc.layers.filter(x => x !== l); sel = null; changed(true); drawSide(); }
    const step = e.shiftKey ? 20 : e.altKey ? 1 : 4, mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv && !l.lock) { e.preventDefault(); l.x += mv[0]; l.y += mv[1]; changed(); }
    if (e.key === 'Escape') { if (cropping) { endCrop(); return drawSide(); } select(null); }
  });

  /* Side panel events */
  const sideClick = async (e) => {
    const t = e.target, d = (kk) => t.closest(`[data-${kk}]`)?.dataset[kk], l = layer();
    if (t.matches('[data-lop]')) return;   // the layer's opacity slider: handled as it moves
    if (t.closest('[data-collapse]')) { mini = !mini; Settings.set('dz_panel_min', mini ? '1' : ''); return drawSide(); }
    if (d('rail')) return railAct(d('rail'), t.closest('[data-rail]'));
    if (t.closest('[data-ffupd]')) { const n = await ffUpdateLists(doc); toast(n ? `Updated ${n} field${n > 1 ? 's' : ''}.` : 'Already up to date.'); if (n) changed(true); return drawSide(); }
    if (t.closest('[data-qradd], [data-qrfrom]')) { closePop(); const from = t.closest('[data-qrfrom]') ? l : null, txt = from?.link || 'https://', m = dzQr(txt, 'M'), s = from ? Math.min(from.w, from.h || from.w) * 0.8 : Math.min(doc.w, doc.h) * 0.3;
      secOpen.set('QR code', true); return add({ t: 'shape', shape: 'vec', name: 'QR code', keep: true, qr: { text: txt, ec: 'M', link: true }, ...(from ? {} : {}), subs: dzQrSubs(m), fill: '#000000', stroke: 'none', sw: 0, qrbg: '#ffffff', w: s, h: s, x: from ? from.x + (from.w - s) / 2 : (doc.w - s) / 2, y: from ? from.y + ((from.h || 0) - s) / 2 : (doc.h - s) / 2, link: dzLinkOK(txt) }); }
    if (t.closest('[data-curvetext]') && l) { secOpen.set('Follow a curve', true); return add({ t: 'text', text: 'Your text here', size: Math.round(Math.max(24, Math.min(doc.h * 0.05, Math.min(l.w, l.h || l.w) * 0.14))), font: '@2', c: '@fg', al: 'center', lh: 1.2, on: l.id, x: l.x, y: l.y, w: l.w, h: l.h || 1 }); }
    if (t.closest('.dz-pop') && (d('add') || d('pic') || d('shape') || d('field'))) closePop();
    if (d('tab')) { tab = d('tab'); return drawSide(); }
    if (d('mact')) return multiAct(d('mact'));
    if (d('bool')) return boolOp(d('bool'));
    if (d('pact')) return penAct(d('pact'));
    if (d('pcl')) return pclAct(d('pcl'));
    if (d('cont')) return contAct(d('cont'));
    if (d('align')) return align(d('align'));
    const row = t.closest('[data-lid]');
    if (row && !t.closest('[data-grip]')) {
      const ly = doc.layers.find(x => x.id === row.dataset.lid); if (!ly) return;
      if (rowHeld) { rowHeld = false; return; }   // the long press already picked it
      if (t.closest('[data-lclip]')) { if (F().indexOf(ly) > 0) ly.clip = !ly.clip || undefined; changed(true); return drawSide(); }
      if (t.closest('[data-lhide]')) { ly.hide = !ly.hide; if (ly.hide && sel === ly.id) sel = null; placeSel(); changed(true); return drawSide(); }
      if (t.closest('[data-llock]')) { ly.lock = !ly.lock; if (!many() && !ly.hide) sel = ly.id; placeSel(); changed(true); return drawSide(); }
      if (t.closest('[data-ldel]') && ly.lock) return toast('Unlock it first.');
      if (t.closest('[data-ldel]')) { doc.layers = doc.layers.filter(x => x !== ly); if (sel === ly.id) sel = null; placeSel(); changed(true); return drawSide(); }
      if (e.shiftKey && !t.closest('button')) {   // a range in the list, from the last one picked
        const list = [...F()].reverse(), a = list.findIndex(x => x.id === (anchor || sel)), b = list.indexOf(ly);
        if (a < 0) return togglePick(ly.id);
        return setPicks(new Set([...picks, ...list.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.id)]));
      }
      if ((picking || e.ctrlKey || e.metaKey) && !t.closest('button')) return togglePick(ly.id);
      if (t.closest('[data-lname]') && sel === ly.id) {
        const n = await askText('Layer name:', layerName(ly)); if (n == null) return;
        ly.name = n.trim() || undefined; changed(true); return drawSide();
      }
      anchor = ly.id; return select(ly.id);
    }
    if (d('ffadd')) { const ft = d('ffadd'), w = Math.round(doc.w * 0.6); closePop();
      return add(dzFieldNew(ft, { x: (doc.w - w) / 2, y: doc.h * 0.3, w, h: ft === 'sign' ? 300 : ft === 'area' ? 400 : ft === 'button' ? 120 : 90, ...(ft === 'button' ? { w: Math.round(doc.w * 0.25), x: (doc.w - Math.round(doc.w * 0.25)) / 2, bg: '@accent', c: '#ffffff' } : {}), label: FF_TYPES.find(t => t[0] === ft)[1], ...(ft === 'radio' || ft === 'combo' ? { opts: ['Option 1', 'Option 2'] } : {}) })); }
    if (d('add')) {
      const a = d('add');
      if (a === 'text') return add({ t: 'text', text: 'Your text', size: Math.round(doc.h * 0.05), font: '@2', c: '@fg', al: 'center', lh: 1.2, ...center(doc.w * 0.6, doc.h * 0.06) });
      if (a === 'frame') { const s = Math.round(Math.min(doc.w, doc.h) * 0.035); return add({ t: 'text', frame: true, text: 'Frame text keeps its box: the words wrap to fit it, and resizing the box never changes the letters.\nPress Enter for a new paragraph.', size: s, font: '@2', c: '@fg', al: 'left', lh: 1.3, ps: Math.round(s * 0.6), pad: 0, ...center(doc.w * 0.7, Math.min(doc.h * 0.5, s * 12)) }); }
      if (a === 'heading') return add({ t: 'text', text: 'Heading', size: Math.round(doc.h * 0.1), font: '@1', c: '@fg', al: 'center', lh: 1.1, ...center(doc.w * 0.7, doc.h * 0.11) });
      if (a === 'logo') { if (!Settings.get('studio_logo_ref')) toast('Add your logo in Settings › Profile; it shows here once added.', 5000); const s = Math.min(doc.w, doc.h) * 0.3; return add({ t: 'image', logo: true, ...center(s, s) }); }
      if (a === 'pen') return startPen();
      if (a === 'pencil') return startPencil();
      if (a === 'image') { panel = panel === 'image' ? null : 'image'; return drawSide(); }
      panel = panel === a ? null : a; return drawSide();
    }
    if (d('shape')) { const s = d('shape'), m = Math.min(doc.w, doc.h) * 0.3, onPl = doc.grid?.on && doc.grid.type === 'iso' && doc.grid.plane && s !== 'line' ? doc.grid.plane : null;
      if (onPl) setTimeout(() => { const nl = layer(); if (isoOK(nl) && !nl.isoP) isoAct(nl, onPl); });   // the new shape starts on the chosen isometric plane
      return add({ t: 'shape', shape: s === 'round' || s === 'frame' ? 'rect' : s, r: s === 'round' ? m * 0.15 : s === 'frame' ? 12 : 0,
        fill: s === 'frame' || s === 'line' ? 'none' : '@accent', stroke: s === 'frame' || s === 'line' ? '@accent' : 'none', sw: s === 'frame' ? 6 : s === 'line' ? 6 : 0,
        ...({ poly: { n: 6 }, star: { n: 5, inner: 0.45 }, ring: { inner: 0.6 }, cross: { th: 0.34 }, arrow: { th: 0.4 } }[s] || {}),
        ...center(s === 'line' ? doc.w * 0.5 : s === 'arrow' || s === 'bubble' ? m * 1.4 : m, s === 'line' ? 6 : m) }); }
    if (d('field')) { const f = d('field');
      return add({ t: 'text', text: `{${f}}`, size: Math.round(doc.h * 0.05), font: '@2', c: '@fg', al: 'center', lh: 1.2, ...center(doc.w * 0.6, doc.h * 0.06) }); }
    if (d('theme')) { doc.theme = d('theme'); await DZF.all(doc); changed(true); return drawSide(); }
    if (d('sides') != null) {
      const two = d('sides') === '1'; if (two === !!doc.sides) return;
      if (two) doc.sides = 2;
      else {   // back to one side: the master's items go under the front; the back's are removed (Undo brings them back)
        const back = doc.layers.filter(l => l.side === 'b');
        if (back.length && !await ask(`Remove the back page and its ${back.length} item${back.length === 1 ? '' : 's'}?\n\nThe master page's items stay, under the front. Undo brings the back page back.`)) return;
        doc.layers = [...doc.layers.filter(l => l.side === 'm'), ...doc.layers.filter(l => dzSide(l) === 'f')]; doc.layers.forEach(l => delete l.side); delete doc.sides;
      }
      face = 'f'; sel = null; changed(true); fit(); return drawSide();
    }
    if (t.closest('#dz-code')) { doc.vals.code = Math.random().toString(36).slice(2, 8).toUpperCase(); changed(true); return drawSide(); }
    if (t.closest('#dz-bgrm')) { doc.bg.img = null; changed(true); return drawSide(); }
    if (t.closest('#dz-piece')) { const pid = await dzPortfolioPick(false); if (!pid) return;
      const pc = await dzPiece(pid); for (const ly of doc.layers) if (ly.slot != null) ly.ref = null; dzFillSlots(doc, pc); changed(true); return drawSide(); }
    if (d('pic')) {
      const src = d('pic'); if (src === 'device') return $('#dz-file').click();
      const ref = await dzPortfolioPick(src === 'refs' ? 'refs' : true); if (!ref) return;
      const im = await dzImg(ref), where = await picWhere(); if (!where) return;
      if (where === 'ref') return refNew({ ref, ar: im ? im.naturalHeight / im.naturalWidth : 1 });
      const w = Math.min(doc.w, doc.h) * 0.5, h = im ? w * im.naturalHeight / im.naturalWidth : w;
      panel = null; return add({ t: 'image', ref, ...center(w, h) });
    }
    if ((t.closest('#dz-pfphoto') || t.closest('#dz-refphoto')) && l) { const ref = await dzPortfolioPick(t.closest('#dz-refphoto') ? 'refs' : true); if (!ref) return; l.ref = ref; if (!l.cover && l.slot == null) { const im = await dzImg(ref); if (im) l.h = l.w * im.naturalHeight / im.naturalWidth; } changed(true); return drawSide(); }
    if (d('c')) {
      const key = t.closest('[data-swk]').dataset.swk, c = d('c');
      if (key === 'bg') doc.bg.c = c === 'none' ? '@bg' : c; else if (key === 'gstop') { if (l?.grad) l.grad.stops[gsel].c = c; } else if (l) l[key] = c;
      changed(); return drawSide();
    }
    if (!l) return;
    if (d('act')) {
      const a = d('act'), i = doc.layers.indexOf(l);
      if (a === 'done') return select(null);
      if (a === 'crop') { if (cropping) { endCrop(); return drawSide(); } if (l.lock) return toast('Unlock it first to crop.');
        l.crop ||= { x: 0, y: 0, w: 1, h: 1 }; cropping = true; placeSel(); redraw(); return drawSide(); }
      if (a === 'cropdone') { endCrop(); return drawSide(); }
      if (a === 'cropreset' && l.crop) {
        const c = l.crop, FW = l.w / c.w, FH = l.h / c.h, a1 = (l.rot || 0) * Math.PI / 180;
        const vx = (c.x + c.w / 2 - 0.5) * FW, vy = (c.y + c.h / 2 - 0.5) * FH;   // back to the whole, centred where the whole was
        const cx = l.x + l.w / 2 - (vx * Math.cos(a1) - vy * Math.sin(a1)), cy = l.y + l.h / 2 - (vx * Math.sin(a1) + vy * Math.cos(a1));
        l.crop = { x: 0, y: 0, w: 1, h: 1 }; l.w = FW; l.h = FH; l.x = cx - FW / 2; l.y = cy - FH / 2; changed(true); return drawSide(); }
      if (a === 'unbend') { l.arc = 0; changed(true); return drawSide(); }
      if (a === 'pick') return startPicking(l.id);
      if (a === 'flatten' || a === 'flatten1') return merge([l.id]);
      if (a === 'toshape') return toShape(l);
      if (a === 'cut') return startCut(l);
      if (a === 'nodes') return startNodes(l);
      if (a === 'clip') { if (F().indexOf(l) > 0) l.clip = !l.clip || undefined; }
      if (a === 'del') { doc.layers.splice(i, 1); sel = null; }
      if (a === 'dupin') return void dupInPlace([l.id]);
      if (a === 'dup') { const c = { ...JSON.parse(JSON.stringify(l)), id: dzId(), x: l.x + 30, y: l.y + 30 }; doc.layers.splice(i + 1, 0, c); sel = c.id;
        // text on a curve brings a copy of its curve, so the copy can be seen and moved on its own
        if (c.on) { delete c._bx; const S = doc.layers.find(s => s.id === c.on); if (S) { const c2 = { ...JSON.parse(JSON.stringify(S)), id: dzId(), x: S.x + 30, y: S.y + 30 }; doc.layers.splice(doc.layers.indexOf(S) + 1, 0, c2); c.on = c2.id; } } }
      if (a === 'up' || a === 'down') {   // past the next item on the same page
        const FL = F(), o = FL[FL.indexOf(l) + (a === 'up' ? 1 : -1)];
        if (o) { const j = doc.layers.indexOf(o); [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]]; }
      }
      if (a === 'lock') l.lock = !l.lock;
      if (a === 'fx') l.fx = !l.fx;
      if (a === 'fy') l.fy = !l.fy;
      if (a === 'keep') l.keep = !dzKeep(l);
      changed(true); return drawSide();
    }
    if (d('al')) { l.al = d('al'); changed(true); return drawSide(); }
    if (d('tvert') && l?.t === 'text') { const on = d('tvert') === '1'; if (on === !!l.vert) return; if (on) { l.vw = l.w; l.arc = 0; l.vert = true; } else { l.vert = false; if (!l.frame && l.vw) l.w = l.vw; } await redraw(); changed(true); return drawSide(); }
    if (d('va')) { l.va = d('va'); changed(true); return drawSide(); }
    if (d('tframe') && l?.t === 'text') { const on = d('tframe') === '1'; if (on === !!l.frame) return; l.frame = on; if (on) { l.arc = 0; l.h = Math.max(l.h || 0, l.size * 3); if (l.ps == null) l.ps = Math.round(l.size * 0.6); } else if (l.al === 'justify') l.al = 'left'; await redraw(); changed(true); return drawSide(); }
    if (d('ctool')) { copt.tool = d('ctool'); saveCopt(); return drawSide(); }
    if (d('cmode')) { copt.mode = d('cmode'); saveCopt(); return drawSide(); }
    if (d('pen')) { await Settings.set('dz_pen', d('pen')); return drawSide(); }
    if (d('cut')) return cutOp(d('cut'));
    if (d('nop')) return nodeOp(d('nop'));
    if (d('fm')) {
      const m = d('fm');
      if (m === 'solid') delete l.fm;
      else { l.fm = m;
        if (m === 'grad' && !l.grad) { const c0 = l.t === 'text' ? l.c : l.fill; l.grad = { type: 'linear', ang: 90, stops: [{ c: c0 && c0 !== 'none' ? c0 : '@accent', p: 0 }, { c: '@bg', p: 1 }] }; gsel = 0; }
        if (m === 'tex') l.tex ||= { ts: 40, rot: 0 }; }
      changed(true); return drawSide();
    }
    if (d('gtype') && l.grad) { l.grad.type = d('gtype'); changed(true); return drawSide(); }
    if (d('gact') && l.grad) {
      const g = l.grad, a = d('gact');
      if (a === 'add' && g.stops.length < 5) {   // in the middle of the widest gap
        const o = [...g.stops].sort((p, q) => p.p - q.p); let best = 0;
        for (let i = 1; i < o.length; i++) if (o[i].p - o[i - 1].p > o[best + 1].p - o[best].p) best = i - 1;
        g.stops.push({ c: o[best].c, p: (o[best].p + o[best + 1].p) / 2 }); gsel = g.stops.length - 1;
      }
      if (a === 'del' && g.stops.length > 2) { g.stops.splice(gsel, 1); gsel = 0; }
      if (a === 'rev') g.stops.forEach(st => st.p = 1 - st.p);
      if (a === 'turn') g.ang = (((g.ang ?? 90) + 90 + 180) % 360) - 180;
      changed(true); return drawSide();
    }
    if (d('tex') === 'refs') { const ref = await dzPortfolioPick('refs'); if (!ref) return; l.tex = { ts: 40, rot: 0, ...l.tex, ref }; l.fm = 'tex'; changed(true); return drawSide(); }
    if (d('tflip') && l.tex) { l.tex[d('tflip')] = !l.tex[d('tflip')]; changed(true); return drawSide(); }
    if (d('tog')) { l[d('tog')] = !l[d('tog')]; changed(true); return drawSide(); }
    if (d('ins') && l.t === 'text') {
      const ta = side.querySelector('.dz-text'), at = ta.selectionStart ?? ta.value.length, ins = `{${d('ins')}}`;
      l.text = ta.value.slice(0, at) + ins + ta.value.slice(ta.selectionEnd ?? at); changed(true); drawSide();
      const nt = side.querySelector('.dz-text'); nt.focus(); nt.setSelectionRange(at + ins.length, at + ins.length);
    }
  };
  side.addEventListener('click', sideClick);
  for (const x of [$('#dz-rail'), $('#dz-pop')]) { x.addEventListener('click', sideClick); x.addEventListener('change', (e) => sideChange(e)); }
  /* The magnet: snapping on or off and what snaps to what. Stays at the end of the strip whatever is selected. */
  let snapPop = false;
  const drawSnap = () => { const b = $('#dz-csnap'); if (!b) return; const ck = (key, n, tip) => `<label class="toggle" style="display:flex;margin-bottom:6px" data-tip="${tip}"><input type="checkbox" data-sn="${key}" ${snapO[key] ? 'checked' : ''}><span>${n}</span></label>`;
    b.innerHTML = `<button class="dz-ib ${snapO.on ? 'on' : ''}" data-snapb data-tip="Snapping" aria-label="Snapping"><svg viewBox="0 0 24 24"><path d="M5 4v8a7 7 0 0 0 14 0V4h-4v8a3 3 0 0 1-6 0V4zM5 8h4M15 8h4"/></svg></button>`
      + (snapPop ? `<div class="dz-cpop dz-snappop" style="right:8px;left:auto;top:${b.getBoundingClientRect().bottom + 6}px">
        ${ck('on', 'Snapping on', 'Hold Alt to ignore it for one move')}
        <div class="lbl">Snap to</div>${ck('page', 'Page edges and centre', 'The sides and middle of the page')}${ck('edges', 'Edges of other items', 'Edges line up with edges')}${ck('mids', 'Centres of other items', 'Middles line up with middles')}
        <label class="dz-sl"><span>Snap distance<b>${snapO.dist}</b></span><input type="range" min="3" max="30" step="1" value="${snapO.dist}" data-snv="dist"></label>
        <label class="field" style="margin-bottom:8px" data-tip="Also snap this far outside other items, so spaces between them come out the same"><span>Gap between items (${dzUnit(doc)})</span><input class="in" type="text" inputmode="text" data-calc min="0" step="any" value="${dzToU(doc, snapO.gap || 0)}" data-sng></label>
        <details class="dz-keys"><summary>Shift, Ctrl and Alt</summary><ul><li><b>Resizing:</b> Shift evens or frees the proportions, Ctrl sizes from the centre, Alt is fine and doesn't snap.</li><li><b>Moving:</b> Shift goes straight across or down, Alt is fine and doesn't snap, Ctrl+Alt drags a copy.</li><li><b>Rotating:</b> Shift is 15° steps, Alt is free and fine.</li><li><b>Arrow keys:</b> Shift is a big step, Alt is one pixel.</li><li><b>Selecting:</b> Ctrl or Shift adds or removes.</li></ul></details></div>` : ''); };
  drawSnap();
  const snapSave = () => Settings.set('dz_snap', JSON.stringify(snapO));
  $('#dz-csnap').addEventListener('click', (e) => { if (e.target.closest('[data-snapb]')) { snapPop = !snapPop; drawSnap(); } });
  $('#dz-csnap').addEventListener('input', (e) => { const t2 = e.target; if (t2.dataset.sn) { snapO[t2.dataset.sn] = t2.checked; snapSave(); if (t2.dataset.sn === 'on') $('#dz-csnap [data-snapb]').classList.toggle('on', t2.checked); }
    if (t2.dataset.snv) { snapO.dist = +t2.value; t2.closest('label').querySelector('b').textContent = t2.value; snapSave(); }
    if (t2.hasAttribute('data-sng')) { const v = dzFromU(doc, +t2.value); snapO.gap = v > 0 ? v : 0; snapSave(); } });
  stage.addEventListener('pointerdown', () => { if (snapPop) { snapPop = false; drawSnap(); } }, true);
  const xfB = $('#dz-xf');
  // The link can be toggled in the middle of typing a width or height: the box keeps focus, and the value typed so far
  // is applied again from the size it started at, under the new setting.
  let xfStart = null;
  xfB.addEventListener('focusin', (e) => { const l = layer(); if (e.target.dataset.xf && l && !xfRefocus) xfStart = { id: l.id, w: l.w, h: l.h }; });
  xfB.addEventListener('pointerdown', (e) => { if (e.target.closest('.dz-chain')) e.preventDefault(); });
  xfB.addEventListener('click', async (e) => { if (!e.target.closest('[data-act], [data-unit]')) return; const a = document.activeElement, k = a?.dataset?.xf;
    await sideClick(e); const l = layer();
    if (e.target.closest('.dz-chain') && l && (k === 'w' || k === 'h') && xfStart?.id === l.id && a.value.trim() && Number.isFinite(+a.value)) { const inp = $(`#dz-xf [data-xf="${k}"]`); l.w = xfStart.w; l.h = xfStart.h; xfSet(k, dzFromU(doc, +inp.value)); placeSel(); changed(true); } });
  xfB.addEventListener('input', (e) => { const k = e.target.dataset.xf; if (!k) return; xfSet(k, dzFromU(doc, +e.target.value)); placeSel(); changed(); });
  xfB.addEventListener('change', (e) => { if (e.target.hasAttribute('data-unit')) return sideChange(e); if (e.target.dataset.xf) { changed(true); drawXf(); } });
  const ctxB = $('#dz-ctx');
  ctxB.addEventListener('click', async (e) => { if (e.target.closest('input, select, textarea, .dz-cnum')) return;   /* a box or dropdown: redrawing the strip would throw the click away */
    const iso = e.target.closest('[data-iso]'); if (iso) return isoAct(layer(), iso.dataset.iso);
    if (e.target.closest('[data-chrole]')) return chOpen('role');
    if (e.target.closest('[data-chcopy]') && layer()) { const l0 = layer(), [c] = dupInPlace([l0.id]); delete c.nds; delete c.sh; delete c.mixOf; delete c.ink; c.fill = 'none';
      c.role = l0.role === 'outline' || l0.role === 'detail' ? 'shade' : l0.role || 'shade'; if (c.role === 'shade') c.sh = { tech: 'stipple', grad: 'linear', ang: 90, dark: 0.85, light: 0.05, bias: 1 }; c.nd = c.role === 'shade' ? CH_SHADE.stipple[2] : c.nd; if (c.role === 'pack') { c.mixOf = [chCaps()[0]]; chInk(c); } chDefN(c);
      c.name = (l0.name || 'Shape') + ' (copy)'; select(c.id); changed(true); chTab.role = 'role'; return chOpen('role'); }
    if (e.target.closest('[data-chvs]')) return chStudy(layer());
    if (e.target.closest('[data-bend]')) return bendOpen(layer());
    if (e.target.closest('[data-adjc]')) return adjOpen(layer());
    const k = e.target.closest('[data-cpop]')?.dataset.cpop; if (k) { cpop = cpop === k ? null : k; return drawCtx(); }
    const pick = e.target.closest('.dz-cpop [data-c]'), l = layer();
    if (pick && l && (cpop === 'c' || cpop === 'fill')) l.fm = 'solid';
    if (pick) { const was = cpop; cpop = null; if (was !== 'c' && was !== 'fill' && pick.dataset.c !== 'none' && was === 'stroke' && !l.sw) l.sw = 4; }
    await sideClick(e); drawCtx(); });
  ctxB.addEventListener('change', (e) => { if (e.target.hasAttribute('data-dash')) { const l = layer(); if (!l) return; if (e.target.value) l.dash = e.target.value; else delete l.dash; if (l.shape !== 'line' && e.target.value) { if (!l.sw) l.sw = 4; if (!l.stroke || l.stroke === 'none') l.stroke = '@fg'; }   /* a style needs a visible outline to show on */ changed(true); return drawCtx(); }
    if (e.target.dataset.ck) changed(true); else sideChange(e); });
  ctxB.addEventListener('input', (e) => { const k = e.target.dataset.ck, l = layer(), v = +e.target.value; if (!k || !l || !(v >= 0) || (k === 'size' && v < 6)) return; l[k] = v; changed(); });
  stage.addEventListener('pointerdown', () => { if (cpop) { cpop = null; drawCtx(); } }, true);
  /* The middle mouse button pans the view from anywhere, over a shape or with a menu open, and changes nothing else. */
  stage.addEventListener('pointerdown', (e) => { if (e.button !== 1 || e.pointerType !== 'mouse') return; e.preventDefault(); e.stopImmediatePropagation(); try { stage.setPointerCapture(e.pointerId); } catch {}
    bg = { x: e.clientX, y: e.clientY, vx, vy, moved: true }; }, true);
  stage.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  stage.addEventListener('pointerdown', (e) => { if (!e.target.closest('.dz-pop, .dz-rail, #dz-chov') && !(doc.chal && chHit(e))) closePop(); }, true);   /* not for the airbrush or a gradient dot: their menu stays open */
  let gdrag = null;
  side.addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('[data-gbar]'), l = layer(); if (!bar || !l?.grad) return;
    e.preventDefault();
    const r = bar.getBoundingClientRect(), at = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), mk = e.target.closest('[data-gs]');
    if (mk) gsel = +mk.dataset.gs;
    else if (l.grad.stops.length < 5) {   // a new colour here, the colour of the nearest one
      const near = [...l.grad.stops].sort((a, b) => Math.abs(a.p - at) - Math.abs(b.p - at))[0];
      l.grad.stops.push({ c: near.c, p: at }); gsel = l.grad.stops.length - 1; changed(true); drawSide(); return;
    } else return;
    gdrag = { r, mk }; mk.classList.add('drag'); bar.setPointerCapture(e.pointerId);
    side.querySelectorAll('[data-gs]').forEach(m => m.classList.toggle('on', +m.dataset.gs === gsel));
  });
  side.addEventListener('pointermove', (e) => {
    const l = layer(); if (!gdrag || !l?.grad) return;
    const p = Math.max(0, Math.min(1, (e.clientX - gdrag.r.left) / gdrag.r.width)); l.grad.stops[gsel].p = Math.round(p * 1000) / 1000;
    gdrag.mk.style.left = p * 100 + '%'; gdrag.mk.closest('[data-gbar]').style.background = dzGradCss(doc, l.grad); redraw();
  });
  const gup = () => { if (!gdrag) return; gdrag = null; changed(true); drawSide(); };
  side.addEventListener('pointerup', gup); side.addEventListener('pointercancel', gup);
  // The selected layer's opacity slider in Layers: live while it moves, one undo step when let go.
  side.addEventListener('input', (e) => { if (!e.target.matches('[data-lop]')) return; const l = layer(); if (!l) return; l.op = +e.target.value; redraw(); });
  side.addEventListener('change', (e) => { if (e.target.matches('[data-lop]')) changed(true); });
  let ldrag = null, rowPress = null, rowHeld = false;
  side.addEventListener('pointerdown', (e) => {
    const r = e.target.closest('.dz-lr'); rowHeld = false;
    if (r && !e.target.closest('[data-grip]') && !e.target.closest('button') && e.pointerType !== 'mouse') {
      clearTimeout(rowPress?.t);
      rowPress = { x: e.clientX, y: e.clientY, t: setTimeout(() => { rowPress = null; rowHeld = true; startPicking(r.dataset.lid); }, 550) };
    }
    const g = e.target.closest('[data-grip]'); if (!g) return;
    e.preventDefault();
    const row = g.closest('.dz-lr'), rows = [...$('#dz-ll').children];
    ldrag = { row, rows, from: rows.indexOf(row), to: rows.indexOf(row), y0: e.clientY, h: row.offsetHeight + 4 };
    row.classList.add('drag'); g.setPointerCapture(e.pointerId);
  });
  side.addEventListener('pointermove', (e) => {
    if (rowPress && Math.hypot(e.clientX - rowPress.x, e.clientY - rowPress.y) > 8) { clearTimeout(rowPress.t); rowPress = null; }
    if (!ldrag) return;
    const { row, rows, from, h } = ldrag, dy = e.clientY - ldrag.y0;
    const to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h))); ldrag.to = to;
    row.style.transform = `translateY(${dy}px)`;
    rows.forEach((r, i) => { if (r === row) return;
      const sh = from < to && i > from && i <= to ? -h : from > to && i < from && i >= to ? h : 0;
      r.style.transform = sh ? `translateY(${sh}px)` : ''; });
  });
  const ldrop = () => {
    if (!ldrag) return;
    const { from, to } = ldrag; ldrag = null;
    if (from !== to) {   // reorder this page's layers, in the places they already take in the whole list
      const FL = F(), list = [...FL].reverse(), [m] = list.splice(from, 1); list.splice(to, 0, m); list.reverse();
      const at = FL.map(l => doc.layers.indexOf(l)), all = [...doc.layers]; at.forEach((p, j) => all[p] = list[j]); doc.layers = all; changed(true);
    }
    drawSide();
  };
  const rowUp = () => { clearTimeout(rowPress?.t); rowPress = null; };
  side.addEventListener('pointerup', (e) => { rowUp(); ldrop(e); }); side.addEventListener('pointercancel', (e) => { rowUp(); ldrop(e); });
  side.addEventListener('contextmenu', (e) => { if (e.target.closest('.dz-lr')) e.preventDefault(); });
  page.addEventListener('contextmenu', (e) => e.preventDefault());
  side.addEventListener('input', (e) => { const t2 = e.target, l = layer(); if (!l?.qr || !(t2.hasAttribute('data-qrt') || t2.hasAttribute('data-qrec'))) return;
    const txt = t2.hasAttribute('data-qrt') ? t2.value : l.qr.text, ec = t2.hasAttribute('data-qrec') ? t2.value : l.qr.ec, m = txt.trim() && dzQr(txt.trim(), ec); if (m === null) return toast('That is too long for a QR code.'); if (!m) return;
    const wasLink = l.link === dzLinkOK(l.qr.text); l.qr = { ...l.qr, text: txt, ec }; l.subs = dzQrSubs(m); if (wasLink || !l.link) l.link = dzLinkOK(txt); changed(); });
  side.addEventListener('change', (e) => { const t2 = e.target, l = layer(); if (!l) return;
    if (t2.hasAttribute('data-ltype')) { l.ltype = t2.value; if (!t2.value) { delete l.lval; l.link = ''; } else { if (t2.value === 'page') l.lval = '1'; else if (t2.value.startsWith('act:')) delete l.lval; else if (/^(page:|act:)/.test(l.link || '')) l.lval = ''; else l.lval = l.lval ?? l.link ?? ''; l.link = ffLinkMake(t2.value, l.lval); } changed(true); return drawSide(); }
    if (t2.hasAttribute('data-linkv')) { l.ltype ??= 'web'; l.lval = t2.value; const v = ffLinkMake(l.ltype, t2.value); if (t2.value.trim() && !v) toast("That link can't be used."); l.link = v; changed(true); return drawSide(); }
    if (t2.hasAttribute('data-qrt') || t2.hasAttribute('data-qrec')) { changed(true); return drawSide(); }
    if (t2.hasAttribute('data-tcurve')) { if (t2.value) { Object.assign(l, { on: t2.value, arc: 0, al: 'center' }); delete l._bx; } else { const S = doc.layers.find(o => o.id === l.on); if (S?.hide) S.hide = false; delete l.on; delete l._bx; l.w = Math.min(l.w, doc.w * 0.8); } changed(true); return drawSide(); }
    if (t2.hasAttribute('data-tchide')) { const S = doc.layers.find(o => o.id === l.on); if (S) { S.hide = t2.checked; changed(true); } return; }
    if (t2.hasAttribute('data-tcflip')) { l.pflip = t2.checked; changed(true); } });
  side.addEventListener('change', (e) => { const tk = e.target.dataset.tk, tl = layer(); if (tk && tl) { tl[tk] = e.target.value; changed(true); } });
  side.addEventListener('change', (e) => { if (e.target.matches('[data-fcat]')) { doc.form.cat = e.target.value; changed(true); } });
  side.addEventListener('change', async (e) => { const key = e.target.dataset.ffsrc, l = layer(); if (!key || !l) return; if ((l.opts || []).join() === 'Option 1,Option 2') l.opts = []; const s = new Set(l.src || []); e.target.checked ? s.add(key) : s.delete(key); l.src = [...s]; await ffApply(l); changed(true); drawSide(); });
  side.addEventListener('input', (e) => { const k2 = e.target.dataset.ffk, l = layer(); if (!k2 || !l) return; const t = e.target;
    l[k2] = t.type === 'checkbox' ? t.checked : k2 === 'opts' ? t.value.split('\n').map(s => s.trim()).filter(Boolean) : t.value;
    if (k2 === 'opts' && l.imp) l.imp = l.imp.filter(o => l.opts.includes(o));
    if (k2 === 'ft') { if ((l.ft === 'radio' || l.ft === 'combo') && !l.opts?.length) l.opts = ['Option 1', 'Option 2']; l.h = l.ft === 'sign' ? 300 : l.ft === 'area' ? 400 : l.ft === 'button' ? 120 : l.h; drawSide(); }
    changed(); });
  side.addEventListener('input', (e) => {
    const t = e.target, l = layer(), key = t.dataset.k;
    if (t.dataset.dim && l) {
      const v = dzFromU(doc, +t.value); if (!(v > 0)) return;
      const cx = l.x + l.w / 2, cy = l.y + (l.h || 0) / 2, r = l.w / (l.h || 1), keep = dzKeep(l) && (l.t !== 'text' || l.frame);
      if (t.dataset.dim === 'w') { l.w = v; if (keep) l.h = v / r; } else { l.h = v; if (keep) l.w = v * r; }
      l.x = cx - l.w / 2; if (l.t !== 'text' || l.frame) l.y = cy - l.h / 2;
      const other = side.querySelector(`[data-dim="${t.dataset.dim === 'w' ? 'h' : 'w'}"]`);
      if (other && keep) other.value = dzToU(doc, t.dataset.dim === 'w' ? l.h : l.w);
      return changed();
    }
    if (t.dataset.v) { doc.vals[t.dataset.v] = t.value; return changed(); }
    if (t.dataset.cpick) { const kk = t.dataset.cpick; if (kk === 'bg') doc.bg.c = t.value; else if (kk === 'gstop') { if (l?.grad) l.grad.stops[gsel].c = t.value; } else if (l) l[kk] = t.value; return changed(); }
    if (t.hasAttribute('data-contd') && cont) { const v = dzFromU(doc, +t.value); if (Number.isFinite(v)) { copt2.d = v; saveC2(); contCalc(); } return; }
    if (/^[ph]:/.test(key || '')) {   // pencil and hold-to-snap settings
      const kk = key.slice(2); pcl[kk] = +t.value; savePcl();
      const b = t.closest('.dz-sl')?.querySelector('b'); if (b) b.textContent = kk === 'ms' ? t.value + ' ms' : kk === 'smooth' ? t.value + ' px' : t.value + '%';
      return;
    }
    if (/^c:/.test(key || '')) {   // selection settings
      const kk = key.slice(2); copt[kk] = +t.value; saveCopt();
      const b = t.closest('.dz-sl')?.querySelector('b'); if (b) b.textContent = kk === 'feather' ? t.value + ' px' : t.value + '%';
      if (kk === 'feather' && cut) { cut.soft = null; drawCut(); }
      return;
    }
    if (l && /^[gt]:/.test(key || '')) {   // gradient and texture sliders
      const [o, kk] = key.split(':'), tg = o === 'g' ? l.grad : l.tex; if (!tg) return;
      tg[kk] = +t.value;
      const b = t.closest('.dz-sl')?.querySelector('b');
      if (b) b.textContent = kk === 'sz' ? Math.round(t.value * 100) + '%' : kk === 'ts' ? t.value + '%' : t.value + '°';
      return changed();
    }
    if (key === 'bgop') { doc.bg.op = +t.value; t.closest('.dz-sl').querySelector('b').textContent = Math.round(t.value * 100) + '%'; return changed(); }
    if (!l || !key || key === 'font') return;
    l[key] = key === 'text' ? t.value : +t.value;
    const b = t.closest('.dz-sl')?.querySelector('b');
    if (b) b.textContent = key === 'op' ? Math.round(t.value * 100) + '%' : key === 'rot' ? t.value + '°'
      : key === 'arc' ? (+t.value === 0 ? 'straight' : (t.value > 0 ? 'up ' : 'down ') + Math.abs(t.value) + '°') : t.value;
    changed();
  });
  const sideChange = async (e) => {
    const t = e.target, l = layer();
    if (t.hasAttribute('data-contkeep')) { copt2.keep = t.checked; saveC2(); return; }
    if (t.hasAttribute('data-holdon')) { pcl.hold = t.checked; savePcl(); return drawSide(); }
    if (t.hasAttribute('data-pclclose')) { pcl.close = t.checked; savePcl(); return; }
    if (t.dataset.cpick) return drawSide();
    if (t.id === 'dz-texfile' && l) {
      const f = t.files[0]; t.value = ''; if (!f) return;
      const { ref } = await importPic(f, 2000); made.add(ref);
      l.tex = { ts: 40, rot: 0, ...l.tex, ref }; l.fm = 'tex'; changed(true); return drawSide();
    }
    if (t.id === 'dz-file' || t.id === 'dz-repl' || t.id === 'dz-bgfile') {
      const f = t.files[0]; t.value = ''; if (!f) return;
      try {
        const { ref, ar } = await importPic(f, t.id === 'dz-bgfile' ? 3000 : 2000);
        if (t.id === 'dz-bgfile') { doc.bg.img = ref; doc.bg.op ??= 1; changed(true); return drawSide(); }
        if (t.id === 'dz-repl' && l) { l.ref = ref; l.h = l.w / ar; changed(true); return drawSide(); }
        const where = await picWhere(); if (!where) return; if (where === 'ref') return refNew({ ref, ar: 1 / ar });
        const w = Math.min(doc.w, doc.h) * 0.5, h = w / ar; add({ t: 'image', ref, ...center(w, h) });
      } catch { toast('Could not read that picture.'); }
      return;
    }
    if (t.dataset.k === 'font' && l) {
      if (t.value === '+import') return dzImportFont().then(n => { if (n) { l.font = n; changed(true); } drawSide(); });
      if (t.value === '+device') return dzDeviceFont().then(n => { if (n) { l.font = n; DZF.loaded.add(n); changed(true); } drawSide(); });
      l.font = t.value; await DZF.load(dzFont(doc, l.font)); changed(true);
    }
    if (t.hasAttribute('data-fit') && l) { l.fit = t.checked ? 1 : 0; return changed(true); }
    if (t.dataset.k === 'arc') return drawSide();
    if (t.hasAttribute('data-unit')) { await Settings.set(DZ_KINDS[doc.kind].social ? 'dz_unit_post' : 'dz_unit', t.value); return drawSide(); }
    if (t.dataset.dim) { changed(true); return; }
    if (t.hasAttribute('data-cover') && l) { l.cover = t.checked ? 1 : 0; changed(true); return drawSide(); }
    if (t.dataset.k === 'text' || t.dataset.v) changed(true);
  };
  side.addEventListener('change', sideChange);

  /* Top bar */
  $('#dz-back').onclick = async () => { await flush(); location.hash = 'designs'; };
  $('#dz-tpl').onclick = async () => {
    const n = await askText('Name for this template:', name); if (!n?.trim()) return;
    const tdoc = JSON.parse(JSON.stringify(doc));
    // Photos from a portfolio piece become empty photo spots, ready for the next piece.
    for (const l of tdoc.layers) if (l.slot != null) l.ref = null;
    delete tdoc.vals?.piece; if (tdoc.kind === 'voucher') tdoc.vals = { amount: tdoc.vals?.amount || '' };
    const list = dzCustom(); list.push({ id: Date.now().toString(36), name: n.trim(), kind: doc.kind, doc: tdoc });
    await Settings.set('dz_tpls', JSON.stringify(list));
    toast(`Saved "${n.trim()}". It's under layouts when you start a new ${DZ_KINDS[doc.kind].label.toLowerCase()}.`, 5000);
  };
  $('#dz-name').onchange = (e) => { name = e.target.value.trim() || name; save(); };
  $('#dz-undo').onclick = () => undo(-1); $('#dz-redo').onclick = () => undo(1);
  /* ---------- Challenge maker ----------
     The Challenge menu (rail): the instructions, the palette (and whether it is the only one allowed), and Play.
     The role menu (selection strip, a shape selected): what the shape is, its needle and, for packing, its colour,
     picked from the palette or mixed from two of its caps. */
  const chPals = () => { let mine = []; try { mine = JSON.parse(Settings.get('tt_pals', '[]')); } catch {} return [...(typeof TT_PALS !== 'undefined' ? TT_PALS : []), ...(typeof TT_WASH !== 'undefined' ? [CH_WASH()] : []), ...(Array.isArray(mine) ? mine : [])]; };
  const chCaps = () => (chPals().find(p => p.id === doc.chal.pal) || chPals()[0])?.caps.map(c => c.c) || ['#141414'];
  const chMix = (a, b, t) => typeof ttMix === 'function' ? ttToHex(ttMix(ttHex(a), ttHex(b), t)) : a;
  const chSw = (cs, key, cur) => `<div class="dz-chsw">${cs.map(c => `<button data-${key}="${c}" class="${cur === c ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>`;
  /* Both menus are tabbed (chTab keeps the open tab of each), with a header, a scrolling body and, for the Challenge
     menu, Play pinned at the bottom. */
  const chTab = { role: 'role', set: 'brief' }; let chStop = 0;
  const chTabs = (mode, list) => { if (!list.some(([k]) => k === chTab[mode])) chTab[mode] = list[0][0]; return list.length < 2 ? '' : `<div class="dz-chtabs">${list.map(([k, n]) => `<button data-cht="${mode}:${k}" class="${chTab[mode] === k ? 'on' : ''}">${n}</button>`).join('')}</div>`; };
  const chNote = (t) => `<p class="dz-chnote">${t}</p>`;
  const chFrame = (title, sub, tabs, body, foot = '') => `<div class="dz-chhead"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>${tabs}<div class="dz-chbody">${body}</div>${foot ? `<div class="dz-chfoot">${foot}</div>` : ''}`;
  const chSetMenu = () => { const C = doc.chal, S = doc.layers.filter(l => l.t === 'shape' && l.role), n = (r) => S.filter(l => l.role === r).length, lj = C.base && C.lessonJudge !== false && C.sig === dzChSig(doc);
    const tabs = chTabs('set', [['brief', 'Brief'], ['pal', 'Palette'], ['judge', 'Judging']]);
    const body = chTab.set === 'brief' ? `<div class="dz-gk" style="grid-template-columns:1fr 1fr;margin-bottom:6px"><button data-chsetup>Setup…</button><button data-chtrace>Trace a picture…</button><button data-charea class="${C.area && C.showArea !== false ? 'on' : ''}" ${C.area ? '' : 'disabled'}>Tattoo area</button>${doc.layers.some(o => o.sh?.stencil) ? `<button data-chstshow class="${C.showSten !== false ? 'on' : ''}" style="grid-column:span 2">Stencil</button>` : ''}</div>${doc.layers.some(o => o.sh?.stencil) ? chNote('<b>Black</b>: lines that are judged (Outline or Detail), at the width their needle makes. <b>Faint purple</b>: the stencil, a guide for the shading only.') : ''}<textarea class="in" data-chtext rows="6" style="width:100%;font-size:12.5px" placeholder="Instructions for the artist. Leave empty to have them written from the shapes.">${esc(C.text || '')}</textarea>`
        + chNote(`${n('outline')} outline, ${n('detail')} detail line${n('detail') === 1 ? '' : 's'}, ${n('pack')} packing, ${n('shade')} shading. Select a shape and press Grade as in the strip to give it a role.`)
      : chTab.set === 'pal' ? `<div class="dz-chpals">${chPals().map(p => `<button data-chpal="${esc(p.id)}" class="${C.pal === p.id ? 'on' : ''}"><span>${p.caps.map(c => `<i style="background:${c.c}"></i>`).join('')}</span>${esc(p.name)}</button>`).join('')}</div>
        <div class="dz-gk" style="grid-template-columns:1fr 1fr 1fr;margin-top:6px"><button data-chpe="new">New</button><button data-chpe="edit">${ttPalMine().some(x => x.id === C.pal) ? 'Edit' : 'Copy to edit'}</button><button data-chpe="imp">Import</button></div>
        <label class="toggle" style="margin:8px 4px"><input type="checkbox" data-chlock ${C.lock ? 'checked' : ''}><span>Only this palette in the challenge</span></label>` + chNote('Every colour in the challenge is picked or mixed from this palette. New and Edit open the simulator\'s palette maker, with its mixing bench; Import takes a palette file.')
      : (C.base ? (C.sig === dzChSig(doc) ? `<label class="toggle" style="margin:4px 4px 8px"><input type="checkbox" data-chlj ${C.lessonJudge !== false ? 'checked' : ''}><span>The lesson's own calibrated judging</span></label>` : chNote('The lesson shapes have changed, so it is judged by the focus below.')) : '')
        + (lj ? '' : CH_FOCUS.map(([k, nm, v]) => { const f = C.focus?.[k] ?? v; return `<label class="dz-gsz"><span style="width:74px">${nm}</span><input type="range" min="0" max="1" step="0.05" data-chf="${k}" value="${f}" style="flex:1"><b style="width:36px;text-align:right">${Math.round(f * 100)}%</b></label>`; }).join('')
          + chNote('How much each part counts. Put Linework at 0 to judge only the shading or packing, however rough the line.'));
    return chFrame('Challenge', '', tabs, body, `<button class="btn small" data-chmine data-tip="${doc.chal?.mine ? 'Take it out of My challenges' : 'Put it in the Challenges hub, under My challenges'}">${doc.chal?.mine ? 'In My challenges' : 'Add to My challenges'}</button><button class="btn primary small" data-chplay>Play in the simulator</button>`); };
  const chNds = (l, list) => { const many = l.role === 'pack' || l.role === 'shade', on = many ? dzChNds(l) : [l.nd]; return `<div class="dz-gk" style="grid-template-columns:repeat(4,1fr)">${list.map(n => `<button data-chn="${n}" class="${on.includes(n) ? 'on' : ''}">${n}</button>`).join('')}</div>`; };
  const chRoleMenu = () => { const l = layer(); if (!l || l.t !== 'shape') return chFrame('Grade this shape', '', '', chNote('Select a shape first.')); const r = l.role || '', S = l.sh || {};
    const tabs = chTabs('role', [['role', 'Role'], ...(r ? [['needle', 'Needle']] : []), ...(r === 'pack' || (r === 'shade' && S.tech === 'blend') ? [['colour', 'Colour']] : []), ...(r === 'shade' ? [['grad', 'Gradient']] : []), ...(r === 'shade' && S.grad === 'paint' ? [['brush', 'Brush']] : []), ...(r === 'shade' ? [['sten', 'Stencil']] : [])]);
    const T = chTab.role, tb = (k, v, n) => `<button data-chs="${k}:${v}" class="${String(S[k] ?? '') === String(v) ? 'on' : ''}">${n}</button>`;
    let body = '';
    if (T === 'role') body = `<div class="dz-gk" style="grid-template-columns:1fr 1fr">${CH_ROLES.map(([v, nm]) => `<button data-chr="${v}" class="${r === v ? 'on' : ''}">${nm}</button>`).join('')}</div>`
      + (r === 'shade' ? `<div class="gh" style="margin-top:8px">Technique</div><div class="dz-gk" style="grid-template-columns:1fr 1fr">${Object.entries(CH_SHADE).map(([k, v]) => tb('tech', k, v[0])).join('')}</div>` + chNote(CH_SHADE[S.tech || 'stipple'][1])
        : chNote({ '': 'Not part of the challenge: shown as drawn, not graded.', outline: 'The outside line the artist follows.', detail: 'A line inside the outline, with its own needle.', pack: 'Packed solid in one colour, kept inside the outline.' }[r]));
    else if (T === 'needle') { const list = r === 'pack' ? CH_PACKERS : r === 'shade' ? (S.tech === 'stipple' ? CH_LINERS : CH_PACKERS) : CH_LINERS;
      body = chNds(l, list) + chNote(r === 'outline' || r === 'detail' ? `Shown ${CH_NW[l.nd] || ''} mm wide, as the ${l.nd} lines in the simulator. Lines always sit on top.` : `Tap to allow more than one: the artist can use any of them and mix them for the look. ${dzChNds(l).length} allowed: ${dzChNds(l).join(', ')}.`); }
    else if (T === 'colour' && r === 'pack') body = `<div class="gh">Colour</div>${chSw(chCaps(), 'chca', l.mixOf?.[0])}
        <div class="gh" style="margin-top:4px">Mixed with</div>${chSw(chCaps(), 'chcb', l.mixOf?.[1])}<div class="dz-gk" style="grid-template-columns:1fr"><button data-chcb="" class="${l.mixOf?.[1] ? '' : 'on'}">One cap</button></div>
        ${l.mixOf?.[1] ? `<label class="dz-gsz"><span>Mix</span><input type="range" min="0.05" max="0.95" step="0.05" data-chmt value="${l.mixT ?? 0.5}" style="flex:1"></label>` : ''}
        <div class="dz-chres"><i style="background:${l.ink || '#141414'}"></i><span class="muted">Only colours from the challenge's palette.</span></div>`;
    else if (T === 'colour') body = chStopsUI(l);
    else if (T === 'grad') { const sl = (k, n, mn, mx, stp, def) => `<label class="dz-gsz"><span style="width:86px">${n}</span><input type="range" min="${mn}" max="${mx}" step="${stp}" data-chss="${k}" value="${S[k] ?? def}" style="flex:1"></label>`;
      body = `<div class="dz-gk" style="grid-template-columns:repeat(4,1fr)">${tb('grad', 'flat', 'Even')}${tb('grad', 'linear', 'Straight')}${tb('grad', 'radial', 'Radial')}${tb('grad', 'paint', 'Painted')}</div>
        ${S.grad === 'linear' || S.grad === 'radial' ? chNote('Drag the dots on the shape: the black one is the dark end.') : ''}${S.grad === 'paint' && !S.raw ? chNote('Paint it in the Brush tab, or start from an auto shading below.') : ''}
        ${S.raw ? `<div class="dz-gk" style="grid-template-columns:1fr;margin-top:6px"><button data-chsten class="${S.stencil ? '' : 'on'}">${S.stencil ? 'Remake the stencil' : 'Make the stencil from the picture'}</button></div>`
          + chNote(S.stencil ? 'The stencil is on. Remake it in the stencil maker, or remove it.' + ' <a href="#" data-chstenx>Remove it</a>' : 'Opens the stencil maker with the picture, at this size. Press Use in the challenge there and it comes back lined up.') : ''}
        ${S.raw && S.grad === 'paint' ? `<div class="gh" style="margin-top:6px">Value study</div>${sl('levels', 'Value steps', 2, 8, 1, 5)}<b class="dz-chval">${Math.round(S.levels || 5)} steps</b>` + chNote('The picture posterized into this many values, from Lightest to Darkest. Changing the steps or range starts again from the picture, over any airbrushing.') : ''}
        ${S.grad === 'flat' || S.grad === 'paint' ? '' : `<div class="dz-gk" style="grid-template-columns:1fr"><button data-chs="rev:${S.rev ? 0 : 1}" class="${S.rev ? 'on' : ''}">Reverse</button></div>`}
        ${S.grad === 'linear' || (S.grad === 'paint' && !S.raw) ? sl('ang', 'Turn', 0, 345, 15, 90) : ''}${S.grad === 'radial' ? sl('cx', 'Centre across', 0, 1, 0.05, 0.5) + sl('cy', 'Centre down', 0, 1, 0.05, 0.5) : ''}
        ${S.tech === 'blend' ? '' : sl('dark', 'Darkest', 0.1, 1, 0.05, 0.85) + (S.grad === 'flat' ? '' : sl('light', 'Lightest', 0, 0.9, 0.05, 0.05))}
        ${S.grad === 'flat' || S.raw ? '' : sl('bias', 'Balance', 0.3, 3, 0.1, 1) + chNote('Balance: left keeps more of it dark, right more of it light.')}
        <div class="gh" style="margin-top:8px">Auto shading</div><div class="dz-gk" style="grid-template-columns:1fr 1fr">${CH_PRESETS.map(([k, n]) => `<button data-chpre="${k}" class="${S.grad === 'paint' && S.preset === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        ${chNote('Shades the shape for you; Turn sets the side the shadow falls on.')}`; }
    else if (T === 'brush') body = `<div class="dz-gk" style="grid-template-columns:1fr 1fr">${[['dark', 'Darken'], ['light', 'Lighten']].map(([v, n]) => `<button data-chbr="mode:${v}" class="${chBrush.mode === v ? 'on' : ''}">${n}</button>`).join('')}${[[0, 'Soft'], [1, 'Hard']].map(([v, n]) => `<button data-chbr="hard:${v}" class="${+chBrush.hard === v ? 'on' : ''}">${n}</button>`).join('')}</div>
        <label class="dz-gsz"><span style="width:60px">Size</span><input type="range" min="1" max="24" step="0.5" data-chbrs="size" value="${chBrush.size}" style="flex:1"></label><label class="dz-gsz"><span style="width:60px">Flow</span><input type="range" min="0.05" max="1" step="0.05" data-chbrs="flow" value="${chBrush.flow}" style="flex:1"></label>
        ${chNote('Paint on the shape with a finger or pen. Pan off the shape, or with the middle mouse button.')}`;
    else if (T === 'sten') body = `<div class="dz-gk" style="grid-template-columns:1fr 1fr">${[['draw', 'Skin marker'], ['wipe', 'Spirit wipe']].map(([v, n]) => `<button data-chmk="${v}" class="${(chMkM.wipe ? 'wipe' : 'draw') === v ? 'on' : ''}">${n}</button>`).join('')}</div>
        <label class="dz-gsz"><span style="width:60px">Tip</span><input type="range" min="0.2" max="4" step="0.1" data-chmks value="${chMkM.r}" style="flex:1"><b style="width:52px;text-align:right">${chMkM.r} mm</b></label>
        ${chNote((S.stencil ? 'Draw on the stencil, or wipe parts off, with a finger or pen (the wipe is wider). ' : 'No stencil yet: drawing starts a blank one over this zone. ') + 'For shading detail: the marker goes on the stencil, faint purple, and wears off while tattooing like the rest of it. Lines to be judged are best as shapes graded Outline or Detail.')}
        ${S.raw ? `<div class="dz-gk" style="grid-template-columns:1fr;margin-top:6px"><button data-chsten>${S.stencil ? 'Remake the stencil from the picture' : 'Make the stencil from the picture'}</button></div>` : ''}${S.stencil ? `<p class="dz-chnote"><a href="#" data-chstenx>Remove the stencil</a></p>` : ''}`;
    return chFrame(r ? CH_ROLES.find(x => x[0] === r)[1] + (r === 'shade' ? ': ' + CH_SHADE[S.tech || 'stipple'][0] : '') : 'Grade this shape', r ? dzChNds(l).join(' / ') : '', tabs, body); };
  /* A blend's colours: 2 to 10 stops, blended in order along the gradient. Each stop is a cap from the palette,
     or two caps mixed (sh.mixs keeps how). */
  const chStopsUI = (l) => { const S = l.sh, cs = S.cols || [], i = Math.min(chStop, cs.length - 1), m = S.mixs?.[i] || [cs[i]];
    return `<div class="dz-chstops">${cs.map((c, k) => `<button data-chst="${k}" class="${k === i ? 'on' : ''}" style="background:${c}" aria-label="Colour ${k + 1}"><b>${k + 1}</b></button>`).join('')}${cs.length < 10 ? '<button data-chstadd class="add" data-tip="Add a colour after this one" aria-label="Add a colour">+</button>' : ''}</div>
      <div class="dz-chgrad" style="background:linear-gradient(90deg,${cs.join(',')})"></div>
      <div class="gh" style="margin-top:6px">Colour ${i + 1}</div>${chSw(chCaps(), 'chsc', m[0])}
      <div class="gh" style="margin-top:4px">Mixed with</div>${chSw(chCaps(), 'chsm', m[1])}
      <div class="dz-gk" style="grid-template-columns:1fr${cs.length > 2 ? ' 1fr' : ''}"><button data-chsm="" class="${m[1] ? '' : 'on'}">One cap</button>${cs.length > 2 ? '<button data-chstdel>Remove it</button>' : ''}</div>
      ${m[1] ? `<label class="dz-gsz"><span>Mix</span><input type="range" min="0.05" max="0.95" step="0.05" data-chsmt value="${m[2] ?? 0.5}" style="flex:1"></label>` : ''}
      <div class="gh" style="margin-top:8px">Mixing cup <span style="text-transform:none;letter-spacing:0;font-weight:500">· hold a cap to pour it in</span></div>
      <div class="dz-chcup"><i data-chcupc style="background:${chCup.c ? ttToHex(chCup.c) : 'transparent'}"></i><div class="dz-chsw">${chCaps().map(c => `<button data-chpour="${c}" style="background:${c}" aria-label="Pour ${c}"></button>`).join('')}</div></div>
      <div class="dz-gk" style="grid-template-columns:1fr 1fr 1fr"><button data-chcup="add" ${chCup.c && cs.length < 10 ? '' : 'disabled'}>Add it</button><button data-chcup="use" ${chCup.c ? '' : 'disabled'}>Use for ${i + 1}</button><button data-chcup="empty" ${chCup.c ? '' : 'disabled'}>Empty</button></div>
      ${chNote('Mix like on the needle: the longer you hold a cap, the more of it goes in. Add it puts the mix after colour ' + (i + 1) + '. Drag the colours along the strip to change their order. Blended in order along the gradient, from the dark end; up to 10 colours, all from the palette.')}`; };
  /* The mixing cup: pours like dipping the needle in the simulator (the fuller the cup, the slower a colour changes it). */
  const chCup = { c: null, v: 0 }; let chPour = null;
  const chPourEnd = () => { if (!chPour) return; cancelAnimationFrame(chPour.raf); chPour = null; chRe(); };
  /* Value study (the start of portraits and realism): a picture becomes a shading zone the same size, whose map is
     the picture's darkness (96 x 96, kept raw in sh.raw) posterized into value steps between Lightest and Darkest,
     the way a portrait is blocked in. The technique and needle are chosen as for any shading zone, and the map can be
     airbrushed over; changing the steps or range starts again from the picture. The picture is hidden, not deleted. */
  /* Values into steps, with a short soft edge between neighbouring steps (not a hard jag), so the study reads smoothly. */
  const chQuant = (sh) => { const R = Uint8Array.from(atob(sh.raw), ch => ch.charCodeAt(0)), K = Math.max(2, Math.round(sh.levels || 5)), dk = sh.dark ?? 0.95, lt = sh.light ?? 0.05, w = 0.2;
    sh.map = dzChMapEnc(Array.from(R, v => { const t = v / 255 * (K - 1), f = Math.min(K - 2, Math.floor(t)), r = t - f, u = Math.max(0, Math.min(1, (r - 0.5 + w) / (2 * w))), q = (f + u * u * (3 - 2 * u)) / (K - 1); return 255 * (lt + (dk - lt) * q); }));
    chAutoPal(sh); };
  /* Colour challenges: the value study's picture gives the palette, its colours averaged into as many caps as there
     are value steps (at most 8), with black and white always there for mixing. Kept as one palette of yours, renewed
     when the steps change. */
  const chAutoPal = (sh) => { const C = doc.chal; if (!C || C.inkT !== 'colour' || !sh.pals || typeof ttPalSave !== 'function') return;
    const K = Math.min(8, Math.max(2, Math.round(sh.levels || 5))), cols = sh.pals[K]; if (!cols?.length) return;
    const P = { id: C.autoPal || 'p' + Date.now().toString(36), name: (doc.name || 'Challenge').slice(0, 30) + ' colours', caps: [TT_CAPS[0], ...cols, TT_CAPS[TT_CAPS.length - 1]].map(c => ({ c, s: 1 })) };
    ttPalSave(P); C.autoPal = P.id; C.pal = P.id; sh.palC = P.caps.map(c => c.c); sh.tech = 'blend'; sh.cols = [...sh.palC]; sh.mixs = sh.cols.map(c => [c]); };   /* a colour blend, its colours the palette's, darkest first */
  /* The picture's colours averaged into K groups (k-means from evenly spaced shades), darkest first; ones too close to
     black or white are left to those caps. */
  const chKCols = (D, K) => { const px = []; for (let i = 0; i < D.length; i += 4) if (D[i + 3] > 128) px.push([D[i], D[i + 1], D[i + 2]]); if (px.length < K) return [];
    const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11, srt = [...px].sort((a, b) => lum(a) - lum(b)); let cs = Array.from({ length: K }, (_, k) => [...srt[Math.floor((k + 0.5) / K * srt.length)]]);
    for (let it = 0; it < 12; it++) { const s = cs.map(() => [0, 0, 0, 0]); for (const p of px) { let bi = 0, bd = 1e9; cs.forEach((c, k) => { const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (d < bd) { bd = d; bi = k; } }); const t = s[bi]; t[0] += p[0]; t[1] += p[1]; t[2] += p[2]; t[3]++; }
      cs = cs.map((c, k) => s[k][3] ? [s[k][0] / s[k][3], s[k][1] / s[k][3], s[k][2] / s[k][3]] : c); }
    const hex = (c) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    /* Small strong colours (dots, a coloured rim) are outvoted by area above: any strong hue with a little room in the
       picture that no colour so far is near gets its own cap. */
    const hb = Array.from({ length: 12 }, () => [0, 0, 0, 0]); for (const p of px) { const mx = Math.max(...p), mn = Math.min(...p); if (mx < 60 || (mx - mn) / mx < 0.45) continue; const d = mx - mn, H = mx === p[0] ? ((p[1] - p[2]) / d + 6) % 6 : mx === p[1] ? (p[2] - p[0]) / d + 2 : (p[0] - p[1]) / d + 4, t = hb[Math.floor(H * 2) % 12]; t[0] += p[0]; t[1] += p[1]; t[2] += p[2]; t[3]++; }
    const near = (c, L) => L.some(o => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) < 70), extra = [];
    for (const t of hb.sort((a, z) => z[3] - a[3])) { if (t[3] < px.length * 0.002) break; const c = [t[0] / t[3], t[1] / t[3], t[2] / t[3]]; if (!near(c, [...cs, ...extra])) extra.push(c); }
    const base = cs.filter(c => lum(c) > 28 && lum(c) < 236).slice(0, Math.max(1, 8 - extra.length));
    return [...base, ...extra.slice(0, 8 - base.length)].sort((a, b) => lum(a) - lum(b)).map(hex).filter((h, i, a) => a.indexOf(h) === i); };
  async function chStudy(l) { if (!l || l.t !== 'image') return; if (typeof TATTOO_VERSION === 'undefined') await new Promise((res) => { const sc = document.createElement('script'); sc.src = 'tattoo.js'; sc.onload = sc.onerror = res; document.head.appendChild(sc); });
    let N = 160; const sc = Math.min(1, 1600 / Math.max(doc.w, doc.h)), c = document.createElement('canvas'); c.width = Math.round(doc.w * sc); c.height = Math.round(doc.h * sc);
    await dzDraw(c, doc, sc, { only: new Set([l.id]), noBg: true });   /* the picture as it shows: crop, flips and colour adjustments included */
    const z = dzS('rect', l.x, l.y, l.w, l.h, { fill: 'none', rot: l.rot || 0, role: 'shade', nd: '13CM', name: 'Value study' }), P = dzChPts(z).flat(), xs = P.filter((_, i) => i % 2 === 0), ys = P.filter((_, i) => i % 2);
    const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], m = (N = Math.max(96, Math.min(240, Math.round(Math.max(b[2], b[3])))), document.createElement('canvas')); m.width = m.height = N;   /* about a millimetre a cell */
    const g = m.getContext('2d'); g.drawImage(c, b[0] * CH_PX * sc, b[1] * CH_PX * sc, b[2] * CH_PX * sc, b[3] * CH_PX * sc, 0, 0, N, N); const D = g.getImageData(0, 0, N, N).data, raw = new Uint8Array(N * N);
    let lo = 255, hi = 0; for (let i = 0; i < N * N; i++) { const a = D[i * 4 + 3] / 255, lum = (D[i * 4] * 0.3 + D[i * 4 + 1] * 0.59 + D[i * 4 + 2] * 0.11) / 255, v = 255 * a * (1 - lum); raw[i] = v; if (a > 0.5) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    if (hi > lo) for (let i = 0; i < N * N; i++) raw[i] = Math.max(0, Math.min(255, (raw[i] - lo) / (hi - lo) * 255));   /* stretched so the picture's darkest is the darkest step */
    for (let pass = 0; pass < 1; pass++) { const s = Float32Array.from(raw); for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let t = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue; t += s[yy * N + xx]; n++; } raw[y * N + x] = t / n; } }   /* softened: no speckle where the picture is noisy */
    const pals = doc.chal?.inkT === 'colour' ? Object.fromEntries([2, 3, 4, 5, 6, 7, 8].map(k => [k, chKCols(D, k)])) : undefined;
    const RW = Math.max(8, Math.min(260, Math.round(b[2]))), RH = Math.max(8, Math.min(260, Math.round(b[3]))); let rgb;   /* the colour copy: the picture's own shape, a millimetre a cell, sharp */
    if (pals) { const rc = document.createElement('canvas'); rc.width = RW; rc.height = RH; const rg = rc.getContext('2d'); rg.imageSmoothingQuality = 'high'; rg.drawImage(c, b[0] * CH_PX * sc, b[1] * CH_PX * sc, b[2] * CH_PX * sc, b[3] * CH_PX * sc, 0, 0, RW, RH); const RD = rg.getImageData(0, 0, RW, RH).data, a = new Uint8Array(RW * RH * 3);
      for (let i = 0; i < RW * RH; i++) { const al = RD[i * 4 + 3] / 255; for (let q = 0; q < 3; q++) a[i * 3 + q] = RD[i * 4 + q] * al + 255 * (1 - al); } rgb = dzChMapEnc(a); }
    z.sh = { tech: 'wash', grad: 'paint', mapN: N, raw: dzChMapEnc(raw), src: l.ref, levels: 5, dark: 0.95, light: 0.05, ang: 90, bias: 1, pals, rgb, rgbW: rgb ? RW : undefined, rgbH: rgb ? RH : undefined }; chQuant(z.sh);
    chDefN(z); const i = doc.layers.indexOf(l); doc.layers.splice(i + 1, 0, z); l.hide = true; changed(true); select(z.id); chTab.role = 'grad'; await chOpen('role');
    toast(pals ? 'Value study made, with a palette from the picture\'s colours (plus black and white). The picture is hidden: show it from Layers to compare.' : 'Value study made. The picture is hidden: show it from Layers to compare.', 4000); }
  // The value study's picture, as it shows and cropped to the zone, into the stencil maker at the zone's width.
  /* From a picture: pick one, choose the style, tune the trace with a live preview, then it comes in as graded shapes
     (Outline, Detail lines, one Packing shape per colour) fitted into the tattoo area. The picture is kept, hidden, to
     compare against. Styles that trace the same way share one setting. */
  const TR_STYLES = [['colour', 'Colour line work', 'Traditional, neo-trad, new school: lines, outline and flat colours', { k: 4, lines: true, lw: 0.8 }],
    ['black', 'Blackwork', 'Black lines and solid black', { k: 1, lines: true, lw: 0.8 }],
    ['fine', 'Fine line', 'Thin black lines only', { k: 1, lines: true, lw: 1.2, linesOnly: true }],
    ['bg', 'Black and grey', 'Realism, portraits: grey wash zones, each with its gradient', { k: 5, shade: 'wash', blur: 1.2 }],
    ['real', 'Colour realism', 'Colour portraits and realism: colour blend zones', { k: 5, shade: 'blend', blur: 1.2 }]];
  async function chTracePick() { if (typeof TATTOO_VERSION === 'undefined') await new Promise((res) => { const sc = document.createElement('script'); sc.src = 'tattoo.js'; sc.onload = sc.onerror = res; document.head.appendChild(sc); });   /* palettes and caps */
    const src = await new Promise((res) => { const o = document.createElement('div'); o.id = 'merge-dlg'; o.style.zIndex = 99;
      o.innerHTML = `<div class="card"><h2>A picture to trace</h2><p class="muted" style="margin-top:0">Any drawing or photo: the sharper and bigger, the cleaner the trace.</p><div class="dz-ex">
        <button data-ts="refs"><b>From References</b><small>Portfolio › References</small></button><button data-ts="pf"><b>From your portfolio</b><small>Tattoos, simulator pieces and their photos</small></button><button data-ts="file"><b>From this device</b><small>A drawing from another app, a photo</small></button></div>
        <button class="btn" data-ts="" style="width:100%;margin-top:10px">Cancel</button></div>`;
      o.onclick = (e) => { const b = e.target.closest('[data-ts]'); if (!b && e.target !== o) return; o.remove(); res(b?.dataset.ts || null); }; document.body.appendChild(o); });
    if (!src) return false; let ref = null;
    if (src === 'file') { const f = await new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => res(i.files[0] || null); i.click(); }); if (f) ref = await Media.save(f, (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')); }
    else ref = await dzPortfolioPick(src === 'refs' ? 'refs' : true);
    if (!ref) return false; return chTrace(ref); }
  async function chTrace(ref) { const u = await Media.url(ref), im = u && await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; }); if (!im) { toast('Could not open that picture.', 3000); return false; }
    const A = doc.chal?.area || { x: 30, y: 20, w: 120, h: 90 }, nw = im.naturalWidth, nh = im.naturalHeight, f = Math.min(1, 640 / Math.max(nw, nh)), W = Math.max(8, Math.round(nw * f)), H = Math.max(8, Math.round(nh * f));
    const cv0 = document.createElement('canvas'); cv0.width = W; cv0.height = H; const g0 = cv0.getContext('2d', { willReadFrequently: true }); g0.imageSmoothingQuality = 'high'; g0.drawImage(im, 0, 0, W, H); const D = g0.getImageData(0, 0, W, H).data;
    const s = Math.min(A.w / W, A.h / H), ox = A.x + (A.w - W * s) / 2, oy = A.y + (A.h - H * s) / 2;   /* mm per trace px, and where it sits */
    const O = { style: 'colour', k: 4, detail: 2, smooth: 0.4, lw: 0.8 }; let R = null, timer = 0;
    const wk = dzTraceWorker(); let seq = 0;
    const run = () => { const S = TR_STYLES.find(x => x[0] === O.style)[3], k = S.k > 1 ? O.k : 1, id = ++seq; bar(0.02, 'Starting');
      wk.onmessage = (e) => { const m = e.data; if (m.id !== seq) return; if (m.err) { bar(null); return toast('The trace failed: ' + m.err, 4000); } if (m.R) { R = m.R; bar(null); return draw(); } bar(m.p, m.m); };
      wk.postMessage({ id, D, W, H, P: { k, blurR: S.blur ? Math.max(1, Math.round(S.blur / s)) : 0, minPx: Math.max(4, Math.round((S.shade ? O.detail * 4 : O.detail) / (s * s))), lineR: Math.max(1, Math.round(O.lw / s / 2)), lines: !!S.lines, linesOnly: !!S.linesOnly, ox, oy, s, lw: O.lw } }); };
    const bar = (p, m) => { const b = o.querySelector('#dz-trbar'); if (!b) return; b.hidden = p == null; if (p == null) return; b.querySelector('i').style.width = Math.round(p * 100) + '%'; b.querySelector('span').textContent = m || 'Tracing'; o.querySelector('[data-tr="ok"]').disabled = true; if (p >= 1) o.querySelector('[data-tr="ok"]').disabled = false; };
    const later = () => { clearTimeout(timer); timer = setTimeout(run, 220); };
    const hex = (c) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    const o = document.createElement('div'); o.id = 'dz-trace'; o.className = 'dz-chsetup';
    const sl = (k, n, mn, mx, st, unit) => `<label class="dz-gsz"><span style="width:96px">${n}</span><input type="range" min="${mn}" max="${mx}" step="${st}" data-tro="${k}" value="${O[k]}" style="flex:1"><b style="width:64px;text-align:right" data-trv="${k}">${O[k]}${unit}</b></label>`;
    o.innerHTML = `<div class="card dz-trcard"><h2 style="margin-top:0">Trace the picture</h2><div class="dz-trwrap"><canvas id="dz-trprev"></canvas><div id="dz-trbar" hidden><span>Tracing</span><b><i></i></b></div></div><p class="muted" id="dz-trsum" style="font-size:12px;margin:6px 2px"></p>
      <div class="dz-wgrid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">${TR_STYLES.map(([k, n, d]) => `<button data-trs="${k}" class="${O.style === k ? 'on' : ''}"><b>${n}</b><small>${d}</small></button>`).join('')}</div>
      <div id="dz-trk">${sl('k', 'Colours', 2, 8, 1, '')}</div>${sl('detail', 'Detail', 0.5, 20, 0.5, ' mm²')}${sl('smooth', 'Smoothness', 0.1, 1.5, 0.05, ' mm')}${sl('lw', 'Line weight', 0.3, 2.5, 0.1, ' mm')}
      <p class="dz-chnote">Detail: the smallest shape kept, anything smaller joins its neighbour. Smoothness: how far a curve may stray to save nodes. Line weight: dark marks thinner than this are lines, thicker ones solid black.</p>
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn" data-tr="x" style="flex:1">Cancel</button><button class="btn primary" data-tr="ok" style="flex:2">Use this trace</button></div></div>`;
    document.body.appendChild(o); const pc = o.querySelector('#dz-trprev');
    function draw() { if (!R) return; o.querySelector('[data-tr="ok"]').disabled = false; const k = Math.min(1, 560 / Math.max(W, H)) * 1.6, g = pc.getContext('2d'); pc.width = Math.round(W * k); pc.height = Math.round(H * k); pc.style.width = '100%'; g.fillStyle = '#e2b493'; g.fillRect(0, 0, pc.width, pc.height); g.save(); g.scale(k, k);
      let nodes = 0; for (const r of R.rings) { g.beginPath(); for (const lp of r.loops) { const P = dzTraceSmooth(lp, O.smooth / s); nodes += P.length; g.moveTo(...P[0]); for (const q of P.slice(1)) g.lineTo(...q); g.closePath(); } g.fillStyle = hex(R.cols[r.ci]); g.fill('evenodd'); }
      g.lineCap = g.lineJoin = 'round'; g.strokeStyle = '#141414'; g.lineWidth = Math.max(0.6, O.lw * 0.6 / s); for (const p of R.details) { g.beginPath(); g.moveTo((p[0][0] - ox) / s, (p[0][1] - oy) / s); for (const q of p.slice(1)) g.lineTo((q[0] - ox) / s, (q[1] - oy) / s); g.stroke(); }
      g.strokeStyle = '#1fb6a6'; g.lineWidth = Math.max(0.8, 1.2 / k); for (const lp of R.outer) { const P = dzTraceSmooth(lp, O.smooth / s); g.beginPath(); g.moveTo(...P[0]); for (const q of P.slice(1)) g.lineTo(...q); g.closePath(); g.stroke(); } g.restore();
      const shZ = !!TR_STYLES.find(x => x[0] === O.style)[3].shade; o.querySelector('#dz-trsum').textContent = `${R.rings.length} ${shZ ? 'zone' : 'colour'}${R.rings.length === 1 ? '' : 's'} · ${R.rings.reduce((t, r) => t + r.loops.length, 0)} areas · ${R.details.length} detail lines · about ${nodes} points before curve fitting · outline in teal`;
      const S0 = TR_STYLES.find(x => x[0] === O.style)[3]; o.querySelector('#dz-trk').hidden = S0.k <= 1; o.querySelector('#dz-trk span').textContent = S0.shade ? 'Zones' : 'Colours'; o.querySelector('[data-tro="lw"]').closest('label').hidden = !!S0.shade; }
    o.addEventListener('input', (e) => { const k = e.target.dataset.tro; if (!k) return; O[k] = +e.target.value; o.querySelector(`[data-trv="${k}"]`).textContent = O[k] + { k: '', detail: ' mm²', smooth: ' mm', lw: ' mm' }[k]; later(); });
    run();
    return new Promise((res) => { o.onclick = async (e) => { const st = e.target.closest('[data-trs]'); if (st) { O.style = st.dataset.trs; O.lw = TR_STYLES.find(x => x[0] === O.style)[3].lw || O.lw; o.querySelector('[data-tro="lw"]').value = O.lw; o.querySelector('[data-trv="lw"]').textContent = O.lw + ' mm'; o.querySelectorAll('[data-trs]').forEach(b => b.classList.toggle('on', b === st)); return run(); }
      const b = e.target.closest('[data-tr]'); if (!b || b.disabled) return; if (b.dataset.tr !== 'ok') { wk.terminate(); o.remove(); return res(false); }
      bar(0.5, 'Fitting the curves'); await new Promise(r => setTimeout(r, 30)); wk.terminate(); await chTraceApply(R, { ref, W, H, s, ox, oy, O, hex, bar, D }); o.remove(); res(true); }; }); }
  // The trace into the challenge as shapes: the picture (hidden), one Packing shape per colour, Detail lines, the Outline.
  /* A traced zone's shading, from the picture (not the softened copy the zones came from): a straight gradient when
     the zone's tone runs one way (least squares fit, close enough), otherwise its tones painted in on a grid; colour
     zones also keep the picture's colours there (about a millimetre a cell) and a few colours of their own to mix. */
  const chZoneSh = (R, ci, D, W, H, s, kind) => { const lab = R.lab, dk = (i) => { const a = D[i * 4 + 3] / 255; return a * (1 - (D[i * 4] * 0.3 + D[i * 4 + 1] * 0.59 + D[i * 4 + 2] * 0.11) / 255); };
    let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lab[y * W + x] === ci) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const bw = Math.max(1, x1 - x0 + 1), bh = Math.max(1, y1 - y0 + 1); let n = 0, S = [0, 0, 0, 0, 0, 0, 0, 0, 0], mn = 1, mx = 0;   /* sums for d = a + b u + c v, u and v across the box 0..1 */
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (lab[i] !== ci) continue; const u = (x - x0) / bw, v = (y - y0) / bh, d = dk(i); n++; S[0] += u; S[1] += v; S[2] += d; S[3] += u * u; S[4] += v * v; S[5] += u * v; S[6] += u * d; S[7] += v * d; S[8] += d * d; if (d < mn) mn = d; if (d > mx) mx = d; }
    const M = [[n, S[0], S[1]], [S[0], S[3], S[5]], [S[1], S[5], S[4]]], rhs = [S[2], S[6], S[7]], det3 = (A) => A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    const dd = det3(M), sol = Math.abs(dd) < 1e-9 ? [S[2] / Math.max(1, n), 0, 0] : [0, 1, 2].map(c => det3(M.map((row, r) => row.map((v, k) => k === c ? rhs[r] : v))) / dd), [a, b, c] = sol;
    let res = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (lab[i] !== ci) continue; const e = dk(i) - (a + b * (x - x0) / bw + c * (y - y0) / bh); res += e * e; } const rms = Math.sqrt(res / Math.max(1, n));
    const ends = [a, a + b, a + c, a + b + c], hi = Math.min(1, Math.max(...ends)), lo = Math.max(0, Math.min(...ends)), out = { dark: Math.round(Math.max(0.05, kind === 'wash' && rms < 0.07 ? hi : mx) * 100) / 100, light: Math.round(Math.min(kind === 'wash' && rms < 0.07 ? lo : mn, 0.9) * 100) / 100, bias: 1 };
    if (kind === 'wash' && rms < 0.07) return { tech: 'wash', grad: Math.hypot(b, c) < 0.04 ? 'flat' : 'linear', ang: Math.round(((Math.atan2(-c / (bh * s), -b / (bw * s)) * 180 / Math.PI) % 360 + 360) % 360), ...out };
    const N = Math.max(24, Math.min(96, Math.round(Math.max(bw, bh) * s))), sum = new Float32Array(N * N), cnt = new Float32Array(N * N), mean = S[2] / Math.max(1, n);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (lab[i] !== ci) continue; const k = Math.min(N - 1, Math.floor((y - y0) / bh * N)) * N + Math.min(N - 1, Math.floor((x - x0) / bw * N)); sum[k] += dk(i); cnt[k]++; }
    const map = Array.from(sum, (v, k) => 255 * (cnt[k] ? v / cnt[k] : mean)), sh = { tech: kind, grad: 'paint', map: dzChMapEnc(map), mapN: N, ...out };
    if (kind === 'blend') { const RW = Math.max(4, Math.min(200, Math.round(bw * s))), RH = Math.max(4, Math.min(200, Math.round(bh * s))), rgb = new Uint8Array(RW * RH * 3), rs = new Float32Array(RW * RH * 4), px = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x, k = Math.min(RH - 1, Math.floor((y - y0) / bh * RH)) * RW + Math.min(RW - 1, Math.floor((x - x0) / bw * RW)), al = D[i * 4 + 3] / 255; for (let q = 0; q < 3; q++) rs[k * 4 + q] += D[i * 4 + q] * al + 255 * (1 - al); rs[k * 4 + 3]++; if (lab[i] === ci && (x + y) % 3 === 0) px.push([D[i * 4], D[i * 4 + 1], D[i * 4 + 2]]); }
      for (let k = 0; k < RW * RH; k++) for (let q = 0; q < 3; q++) rgb[k * 3 + q] = rs[k * 4 + 3] ? rs[k * 4 + q] / rs[k * 4 + 3] : 255;
      const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11, srt = px.sort((p1, p2) => lum(p1) - lum(p2)), K = Math.min(4, Math.max(2, Math.round(1 + (mx - mn) * 6)));
      let cs = Array.from({ length: K }, (_, k) => [...(srt[Math.floor((k + 0.5) / K * srt.length)] || [128, 128, 128])]);
      for (let it = 0; it < 8; it++) { const t = cs.map(() => [0, 0, 0, 0]); for (const q of srt) { let bi = 0, bd = 1e12; cs.forEach((c2, k) => { const d2 = (c2[0] - q[0]) ** 2 + (c2[1] - q[1]) ** 2 + (c2[2] - q[2]) ** 2; if (d2 < bd) { bd = d2; bi = k; } }); const u = t[bi]; u[0] += q[0]; u[1] += q[1]; u[2] += q[2]; u[3]++; } cs = cs.map((c2, k) => t[k][3] ? [t[k][0] / t[k][3], t[k][1] / t[k][3], t[k][2] / t[k][3]] : c2); }
      const hx = (c2) => '#' + c2.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''), cols = [...new Set(cs.sort((p1, p2) => lum(p1) - lum(p2)).map(hx))];
      Object.assign(sh, { cols: cols.length > 1 ? cols : [cols[0], cols[0]], mixs: (cols.length > 1 ? cols : [cols[0], cols[0]]).map(c2 => [c2]), rgb: dzChMapEnc(rgb), rgbW: RW, rgbH: RH, palC: cols }); }
    return sh; };
  async function chTraceApply(R, P) { const { ref, W, H, s, ox, oy, O, hex, bar, D } = P, SHK = TR_STYLES.find(x => x[0] === O.style)[3].shade, PX = CH_PX, tol = Math.max(0.3, O.smooth * PX), C = doc.chal || (doc.chal = {});
    const liner = (C.needles || []).find(n => /RL$/.test(n)) || (O.style === 'fine' ? '3RL' : '5RL'), packer = (C.needles || []).find(n => /M1$|RS$/.test(n)) || '9M1', news = [];
    const img = { id: dzId(), t: 'image', ref, x: ox * PX, y: oy * PX, w: W * s * PX, h: H * s * PX, op: 1, rot: 0, name: 'Traced picture', hide: true }; news.push(img);
    const toPage = (lp) => dzTraceSmooth(lp, O.smooth / s).map(([x, y]) => ({ x: (ox + x * s) * PX, y: (oy + y * s) * PX }));
    const cols = [], nR = R.rings.length; let done = 0; for (const r of [...R.rings].sort((a, b) => b.loops.reduce((t, l) => t + Math.abs(dzRingArea(l)), 0) - a.loops.reduce((t, l) => t + Math.abs(dzRingArea(l)), 0))) {
      bar?.(0.1 + 0.85 * done++ / Math.max(1, nR), 'Fitting the curves'); await new Promise(r2 => setTimeout(r2, 0));   /* a breath between colours, so the bar moves */
      const subs = r.loops.map(lp => dzFitRing(toPage(lp), tol)).filter(sp => sp.nodes.length > 2); if (!subs.length) continue; const c = hex(R.cols[r.ci]); cols.push(c);
      const z = SHK ? vecFromPage(subs, { fill: 'none', role: 'shade', nd: SHK === 'wash' ? '13CM' : packer, name: 'Shading ' + (done), sh: chZoneSh(R, r.ci, D, W, H, s, SHK) })
        : vecFromPage(subs, { fill: 'none', role: 'shade', nd: packer, name: 'Packing ' + c, sh: { tech: 'blend', grad: 'flat', cols: [c, c], mixs: [[c], [c]], dark: 0.85, light: 0.05, bias: 1 } }); chDefN(z); news.push(z); }
    if (R.details.length) { const z = dzChVec(R.details.map(p => ({ closed: false, pts: p })), { role: 'detail', nd: liner, name: 'Detail lines' }); chDefN(z); news.push(z); }
    if (R.outer.length && O.style !== 'fine' && !SHK) { const sp = dzFitRing(toPage(R.outer[0]), tol); if (sp.nodes.length > 2) { const z = vecFromPage([sp], { fill: 'none', role: 'outline', nd: liner, name: 'Outline' }); chDefN(z); news.push(z); } }
    if (!C.area) { C.area = { x: Math.round(ox * 10) / 10, y: Math.round(oy * 10) / 10, w: Math.round(W * s * 10) / 10, h: Math.round(H * s * 10) / 10 }; C.showArea = true; }   /* the tattoo area: the traced picture, so Setup starts at its size */
    doc.layers.push(...news);
    if (cols.length && typeof ttPalSave === 'function' && O.style === 'colour') { const P2 = { id: C.autoPal || 'p' + Date.now().toString(36), name: (doc.name || 'Challenge').slice(0, 30) + ' colours', caps: [...new Set([TT_CAPS[0], ...cols.slice(0, 8), TT_CAPS[TT_CAPS.length - 1]])].map(c => ({ c, s: 1 })) }; ttPalSave(P2); C.autoPal = P2.id; C.pal = P2.id; C.inkT = 'colour'; }
    else if (O.style === 'real' && cols.length && typeof ttPalSave === 'function') { const P2 = { id: C.autoPal || 'p' + Date.now().toString(36), name: (doc.name || 'Challenge').slice(0, 30) + ' colours', caps: [...new Set([TT_CAPS[0], ...cols.slice(0, 8), TT_CAPS[TT_CAPS.length - 1]])].map(c => ({ c, s: 1 })) }; ttPalSave(P2); C.autoPal = P2.id; C.pal = P2.id; C.inkT = 'colour'; }
    else if (O.style === 'bg') { C.inkT = 'bg'; C.pal = 'wash'; }
    else if (O.style !== 'colour') C.inkT = 'black';
    C.lines = !!(R.details.length || R.outer.length); changed(true); redraw(); toast(`Traced: ${news.length - 1} shapes. The picture is hidden in Layers to compare. Tap any shape to fine-tune its nodes.`, 5000); }
  async function chStencil(l, lines) { const pic = doc.layers.find(o => o.t === 'image' && o.ref === l.sh.src); if (!pic) return toast('The picture this study was made from is gone.', 3000);
    const b = chBox(l), sc = 2, c = document.createElement('canvas'); c.width = Math.round(b[2] * CH_PX * sc); c.height = Math.round(b[3] * CH_PX * sc);
    const full = document.createElement('canvas'); full.width = Math.round(doc.w * sc); full.height = Math.round(doc.h * sc); await dzDraw(full, { ...doc, layers: doc.layers.map(o => o === pic ? { ...o, hide: false } : o) }, sc, { only: new Set([pic.id]), noBg: true, noStencil: true });
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(full, b[0] * CH_PX * sc, b[1] * CH_PX * sc, c.width, c.height, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/png')); await flush(); closePop();
    await stLoad(new File([blob], 'value-study.png', { type: 'image/png' })); ST.from = name; ST.cm = Math.round(b[2] / 10 * 10) / 10; ST.ret = { id, layer: l.id, box: b, lines: !!lines, nd: (doc.chal?.needles || []).find(n => /RL$/.test(n)) || '3RL' };   /* lines: also traced into detail lines to follow */
    if (lines) toast('Make the stencil, then Use in the challenge: its lines come back as detail lines to follow.', 5000);
    location.hash = 'stencil'; }
  /* Challenge setup: a blank challenge opens it, and Setup in the Challenge menu brings it back. Tabs with Back and
     Next: skin, the tattoo's size (a margin box on the canvas, which can be hidden), style, ink, needles, linework,
     where the judging focuses, and pictures (references for the simulator, and one to work from, fitted to the
     area, optionally made into a value study). Done sets it all up; everything stays changeable. */
  const CH_SIZES = [['Small', 5, 5], ['Palm', 8, 8], ['Portrait', 9, 12], ['Square', 12, 12], ['Wide', 16, 10], ['Whole patch', 17, 12]];
  const chNdDefault = (W) => { const n = new Set(); if (W.lines) n.add(W.style === 'Fine Line' ? '3RL' : '5RL');
    if (W.ink === 'black') ['7RS', '9M1'].forEach(x => n.add(x)); else if (W.ink === 'bg') ['3RL', '9M1', '13CM'].forEach(x => n.add(x)); else ['7RL', '11M1', '13CM'].forEach(x => n.add(x));
    if (/Realism|Portrait|Surrealism/.test(W.style || '')) n.add('23CM'); if (/Dotwork/.test(W.style || '')) n.add('3RL'); if (W.style === 'Fine Line') n.add('1RL'); return [...n]; };
  // A new role's needles from the setup: liners for lines, the rest (or liners for stipple) for packing and shading.
  const chDefN = (l) => { const N = doc.chal?.needles; if (!N?.length) return; const lin = N.filter(n => /RL$/.test(n)), oth = N.filter(n => !/RL$/.test(n));
    if (l.role === 'outline' || l.role === 'detail') { if (lin.length) l.nd = lin[0]; return; }
    const A = l.role === 'shade' && l.sh?.tech === 'stipple' ? lin : oth; if (A.length) { l.nds = A; l.nd = A[0]; } };
  const chAreaDraw = () => { let b = $('#dz-charea'); const A = doc.chal?.area; if (!A || doc.chal.showArea === false) { b?.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'dz-charea'; page.appendChild(b); }
    Object.assign(b.style, { left: A.x / 180 * 100 + '%', top: A.y / 130 * 100 + '%', width: A.w / 180 * 100 + '%', height: A.h / 130 * 100 + '%' }); b.dataset.label = `${dzMM(A.w / 10)} × ${dzMM(A.h / 10)} cm`; };
  async function chSetup() { if (typeof TATTOO_VERSION === 'undefined') await new Promise((res) => { const sc = document.createElement('script'); sc.src = 'tattoo.js'; sc.onload = sc.onerror = res; document.head.appendChild(sc); });
    const C = doc.chal, A0 = C.area, STEPS = [['skin', 'Skin'], ['size', 'Size'], ['style', 'Style'], ['ink', 'Ink'], ['nd', 'Needles'], ['lines', 'Linework'], ['judge', 'Judging'], ['pics', 'Pictures']];
    const W = { skin: C.skin ?? ttChSkin(), w: A0 ? A0.w / 10 : 9, h: A0 ? A0.h / 10 : 12, show: C.showArea !== false, style: C.style || '', ink: C.inkT || 'bg', lines: C.lines ?? true, needles: C.needles ? [...C.needles] : null,
      focus: Object.fromEntries(CH_FOCUS.map(([k, , v]) => [k, C.focus?.[k] ?? v])), refs: [...(C.refs || [])], work: null, study: true, barea: C.bodyArea || '' }; let at = 0;
    const o = document.createElement('div'); o.id = 'dz-chsetup'; o.className = 'dz-chsetup';
    const styles = (typeof QUOTE_V2 !== 'undefined' ? QUOTE_V2.styles.map(s => s[0]) : ['Realism', 'Portrait', 'Fine Line', 'Blackwork', 'Old School', 'New School', 'Japanese']);
    const ndBtn = (n) => `<button data-wn="${n}" class="${W.needles.includes(n) ? 'on' : ''}">${n}</button>`;
    const body = () => { const k = STEPS[at][0];
      if (k === 'skin') return `<p class="dz-chnote">The skin the challenge is tattooed on. Brown and Deep take no colour.</p><div class="dz-wskins">${TT_SKINS.map(([n, c], i) => `<button data-ws="${i}" class="${W.skin === i ? 'on' : ''}"><i style="background:${c}"></i>${n}</button>`).join('')}</div>
        <div class="gh" style="margin-top:12px">Body area</div><p class="dz-chnote">Sets how much it hurts (pain from quotes): on a painful area the client needs breaks sooner. Leave it to the artist to choose, or fix it.</p>
        <select class="in" data-warea style="width:100%"><option value="">The artist chooses</option>${(typeof QUOTE_V2 !== 'undefined' ? QUOTE_V2.placements : []).map(a => `<option value="${esc(a[0])}" ${W.barea === a[0] ? 'selected' : ''}>${esc(a[0])} · pain ${a[2]} of 5</option>`).join('')}</select>`;
      if (k === 'size') return `<p class="dz-chnote">How big the tattoo is. It is shown as a box on the 18 × 13 cm patch, and can be hidden.</p><div class="dz-wgrid">${CH_SIZES.map(([n, w, h]) => `<button data-wz="${w}x${h}" class="${W.w === w && W.h === h ? 'on' : ''}"><b>${n}</b><small>${w} × ${h} cm</small></button>`).join('')}</div>
        <div class="row" style="gap:8px;margin:10px 0;align-items:center"><span class="muted">Other</span><input class="in" data-wzw type="number" min="1" max="17" step="0.5" value="${W.w}" style="width:80px"><span>×</span><input class="in" data-wzh type="number" min="1" max="12" step="0.5" value="${W.h}" style="width:80px"><span class="muted">cm</span></div>
        <label class="toggle"><input type="checkbox" data-wshow ${W.show ? 'checked' : ''}><span>Show the tattoo area on the canvas</span></label>`;
      if (k === 'style') return `<p class="dz-chnote">The style, as in quotes. It sets the starting needles and goes in the brief.</p><div class="dz-wgrid">${styles.map(n => `<button data-wst="${esc(n)}" class="${W.style === n ? 'on' : ''}">${esc(n)}</button>`).join('')}</div>`;
      if (k === 'ink') { const noC = W.skin >= 4; return `<p class="dz-chnote">Black sets the standard inks, black and grey the grey wash, colour the standard colours. You can change the palette later.</p><div class="dz-wgrid">${[['black', 'Black', 'Solid black only'], ['bg', 'Black and grey', 'Grey wash: black thinned with water'], ['colour', 'Colour', noC ? 'Not on this skin' : 'Mixed from the palette']].map(([v, n, sub]) => `<button data-wi="${v}" class="${W.ink === v ? 'on' : ''}" ${v === 'colour' && noC ? 'disabled' : ''}><b>${n}</b><small>${sub}</small></button>`).join('')}</div>`; }
      if (k === 'nd') { W.needles ||= chNdDefault(W); return `<p class="dz-chnote">The needles allowed. Ticked here, they are given to each part as you grade it (liners for lines, the rest for packing and shading), and you can change them per part.</p>${typeof TT_KINDS !== 'undefined' ? Object.entries(TT_KINDS).map(([kind, [, label]]) => `<div class="gh">${label}</div><div class="dz-wnd">${TT_NEEDLES.filter(n => n.kind === kind).map(n => ndBtn(n.id)).join('')}</div>`).join('') : ''}<button class="btn small" data-wnreset style="margin-top:8px">Back to the suggested ones</button>`; }
      if (k === 'lines') return `<div class="dz-wgrid">${[[true, 'Yes', 'An outline and detail lines to follow'], [false, 'No', 'Shading or packing only, judged without lines']].map(([v, n, sub]) => `<button data-wl="${v ? 1 : 0}" class="${W.lines === v ? 'on' : ''}"><b>${n}</b><small>${sub}</small></button>`).join('')}</div>
        <p class="dz-chnote" style="margin-top:10px">Even a portrait is worth a little linework: a few lines to shape the face and the main features. Without them, the face can blend into the background and into the skin, and detail is lost as the tattoo ages.</p>`;
      if (k === 'judge') return `<p class="dz-chnote">Where the judging focuses: how much each part counts.</p>${CH_FOCUS.map(([kk, n]) => `<label class="dz-gsz"><span style="width:84px">${n}</span><input type="range" min="0" max="1" step="0.05" data-wf="${kk}" value="${W.focus[kk]}" style="flex:1"><b style="width:40px;text-align:right">${Math.round(W.focus[kk] * 100)}%</b></label>`).join('')}`;
      return `<div class="gh">Reference pictures</div><p class="dz-chnote">Shown beside the skin in the simulator, to follow.</p><div class="dz-wrefs">${W.refs.map((r, i) => `<span><img data-wru="${esc(r.ref)}" alt=""><button data-wrx="${i}" aria-label="Remove">✕</button></span>`).join('')}<button class="btn small" data-wr="refs">From References</button><button class="btn small" data-wr="pf">Portfolio</button><button class="btn small" data-wr="file">This device</button></div>
        <div class="gh" style="margin-top:12px">A picture to work from</div><p class="dz-chnote">Placed on the canvas, fitted inside the tattoo area, ready to trace or to make a value study from.</p>
        <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">${W.work ? `<img data-wru="${esc(W.work.ref)}" alt="" style="height:56px;border-radius:6px"><button class="btn small" data-ww="x">Remove</button>` : '<button class="btn small" data-ww="refs">From References</button><button class="btn small" data-ww="pf">Portfolio</button><button class="btn small" data-ww="file">This device</button>'}</div>
        ${W.work ? `<label class="toggle" style="margin-top:8px"><input type="checkbox" data-wstudy ${W.study ? 'checked' : ''}><span>Make a value study from it (portraits and realism)</span></label>${W.lines && W.study ? `<label class="toggle" style="margin-top:8px"><input type="checkbox" data-wtrace ${W.trace !== false ? 'checked' : ''}><span>Trace lines from it (opens the stencil maker): the lines come back as detail lines to follow</span></label>` : ''}` : ''}`; };
    const draw = () => { o.innerHTML = `<div class="card dz-wcard"><div class="dz-whead"><h2>Challenge setup</h2><button class="dz-ib" data-wx aria-label="Close">✕</button></div>
        <div class="dz-chtabs dz-wtabs">${STEPS.map(([k, n], i) => `<button data-wt="${i}" class="${i === at ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="dz-wbody">${body()}</div>
        <div class="dz-wfoot"><button class="btn" data-wb ${at ? '' : 'disabled'}>Back</button><span style="flex:1"></span>${at < STEPS.length - 1 ? '<button class="btn" data-wdone>Done</button><button class="btn primary" data-wn2>Next</button>' : '<button class="btn primary" data-wdone>Done</button>'}</div></div>`;
      o.querySelectorAll('[data-wru]').forEach(async im => { im.src = await Media.url(im.dataset.wru); }); };
    const pick = async (src) => { let ref = null; if (src === 'file') { const f = await new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => res(i.files[0] || null); i.click(); }); if (f) ref = await Media.save(f, (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')); }
      else ref = await dzPortfolioPick(src === 'refs' ? 'refs' : true); if (!ref) return null; const u = await Media.url(ref), im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; });
      return { ref, ar: im ? im.naturalHeight / im.naturalWidth : 1 }; };
    o.addEventListener('click', async (e) => { const t = e.target, d = (k) => t.closest(`[data-${k}]`)?.dataset[k];
      if (t === o || t.closest('[data-wx]')) { if (!await ask('Close the setup without applying it?')) return; return o.remove(); }
      if (d('wt') != null) { at = +d('wt'); return draw(); } if (t.closest('[data-wb]')) { at = Math.max(0, at - 1); return draw(); } if (t.closest('[data-wn2]')) { at++; return draw(); }
      if (d('ws') != null) { W.skin = +d('ws'); if (W.skin >= 4 && W.ink === 'colour') W.ink = 'bg'; return draw(); }
      if (d('wz')) { [W.w, W.h] = d('wz').split('x').map(Number); return draw(); }
      if (d('wst')) { W.style = d('wst'); W.needles = null; return draw(); }
      if (d('wi')) { W.ink = d('wi'); W.needles = null; return draw(); }
      if (d('wn')) { const n = d('wn'); W.needles = W.needles.includes(n) ? W.needles.filter(x => x !== n) : [...W.needles, n]; return draw(); }
      if (t.closest('[data-wnreset]')) { W.needles = chNdDefault(W); return draw(); }
      if (d('wl') != null) { W.lines = d('wl') === '1'; W.needles = null; if (!W.lines) W.focus.line = 0; else if (!W.focus.line) W.focus.line = 1; return draw(); }
      if (d('wr')) { const r = await pick(d('wr')); if (r) W.refs.push(r); return draw(); } if (d('wrx') != null) { W.refs.splice(+d('wrx'), 1); return draw(); }
      if (d('ww') === 'x') { W.work = null; return draw(); } if (d('ww')) { W.work = await pick(d('ww')); W.study = /Realism|Portrait|Surrealism/.test(W.style); return draw(); }
      if (t.closest('[data-wdone]')) { W.needles ||= chNdDefault(W); o.remove(); return chSetupApply(W); } });
    o.addEventListener('change', (e) => { const t = e.target;
      if (t.matches('[data-wzw], [data-wzh]')) { W.w = Math.max(1, Math.min(17, +o.querySelector('[data-wzw]').value || W.w)); W.h = Math.max(1, Math.min(12, +o.querySelector('[data-wzh]').value || W.h)); draw(); }
      if (t.matches('[data-warea]')) W.barea = t.value;
      if (t.matches('[data-wshow]')) W.show = t.checked; if (t.matches('[data-wstudy]')) { W.study = t.checked; draw(); } if (t.matches('[data-wtrace]')) W.trace = t.checked; });
    o.addEventListener('input', (e) => { if (e.target.matches('[data-wf]')) { W.focus[e.target.dataset.wf] = +e.target.value; const b = e.target.nextElementSibling; if (b) b.textContent = Math.round(e.target.value * 100) + '%'; } });
    draw(); document.body.appendChild(o); }
  async function chSetupApply(W) { const C = doc.chal, mmW = W.w * 10, mmH = W.h * 10;
    C.skin = W.skin; doc.bg = { ...doc.bg, c: TT_SKINS[W.skin][1] }; C.area = { x: (180 - mmW) / 2, y: (130 - mmH) / 2, w: mmW, h: mmH }; C.showArea = W.show;
    C.style = W.style || null; C.inkT = W.ink; C.pal = W.ink === 'bg' ? 'wash' : 'default'; C.lines = W.lines; C.needles = W.needles; C.focus = W.focus; C.refs = W.refs; C.bodyArea = W.barea || null; C.setup = true;
    if (W.work) { const A = C.area, k0 = Math.min(A.w / 1, A.h / W.work.ar) * CH_PX, w = A.w * CH_PX, h = w * W.work.ar, fit = h > A.h * CH_PX ? A.h * CH_PX / h : 1;
      const L = { id: dzId(), t: 'image', ref: W.work.ref, w: w * fit, h: h * fit, op: 1, rot: 0, name: 'Picture to work from' }; L.x = (A.x + A.w / 2) * CH_PX - L.w / 2; L.y = (A.y + A.h / 2) * CH_PX - L.h / 2; void k0;
      doc.layers.push(L); changed(true); chAreaDraw(); if (W.study) { select(L.id); await chStudy(L); const z = layer(); if (W.lines && W.trace !== false && z?.sh?.src) return chStencil(z, true); } else select(L.id); }
    else { changed(true); chAreaDraw(); }
    toast('Challenge set up. Change any of it from the Challenge menu, or Setup again.', 3500); }
  setTimeout(() => { try { if (doc.chal) { chAreaDraw(); if (doc.chal.setup === false) chStart(); } } catch {} }, 500);
  /* A blank challenge starts by asking: from a picture (traced into shapes), or blank; then the setup. */
  async function chStart() { const how = await new Promise((res) => { const o = document.createElement('div'); o.id = 'merge-dlg'; o.style.zIndex = 99;
      o.innerHTML = `<div class="card"><h2>New challenge</h2><div class="dz-ex"><button data-cs="pic"><b>From a picture</b><small>Trace a drawing, photo or simulator piece into shapes to tattoo: outline, detail lines and colours</small></button><button data-cs="blank"><b>Blank</b><small>Draw your own shapes and grade them</small></button></div></div>`;
      o.onclick = (e) => { const b = e.target.closest('[data-cs]'); if (b) { o.remove(); res(b.dataset.cs); } }; document.body.appendChild(o); });
    if (how === 'pic') await chTracePick(); return chSetup(); }
  dzDragOrder($('#dz-pop'), 'chst', (i, j) => { const l = layer(); if (!l?.sh) return; const S = l.sh; chStopFix(S); const [c] = S.cols.splice(i, 1), [m] = S.mixs.splice(i, 1); S.cols.splice(j, 0, c); S.mixs.splice(j, 0, m); chStop = j; redraw(); chRe(); }, () => changed(true));   /* drag a colour along the strip */
  const chStopFix = (S) => { S.cols ||= []; S.mixs = S.cols.map((c, k) => S.mixs?.[k] || [c]); };
  const chStopSet = (S, i) => { const m = S.mixs[i] || [S.cols[i]]; S.cols[i] = m[1] ? chMix(m[0], m[1], m[2] ?? 0.5) : m[0]; };
  const chInk = (l) => { const m = l.mixOf || ['#141414']; l.ink = m[1] ? chMix(m[0], m[1], l.mixT ?? 0.5) : m[0]; };
  async function chOpen(mode, btn) { if (typeof TATTOO_VERSION === 'undefined') await new Promise((res) => { const s = document.createElement('script'); s.src = 'tattoo.js'; s.onload = s.onerror = res; document.head.appendChild(s); });
    closePop(); const p0 = pop(); p0.dataset.ch = mode; p0.innerHTML = mode === 'role' ? chRoleMenu() : chSetMenu(); p0.hidden = false; p0.classList.add('dz-gpop', 'dz-chpop'); btn?.classList.add('open'); chOv();
    const y = btn && mode !== 'role' ? btn.getBoundingClientRect().top - stage.getBoundingClientRect().top : 8, top = Math.max(8, Math.min(y - 6, stage.clientHeight - Math.min(p0.offsetHeight, 420) - 8));
    p0.style.top = top + 'px'; p0.style.maxHeight = (stage.clientHeight - top - 8) + 'px'; }   /* the body scrolls; the header, tabs and Play stay in view */
  const chRe = () => { const p0 = pop(); if (!p0.hidden && p0.classList.contains('dz-chpop')) p0.innerHTML = p0.dataset.ch === 'role' ? chRoleMenu() : chSetMenu(); chOv(); };
  /* Auto shading: the zone's map worked out from how far each part is from the shape's edge, and which side faces
     the shadow (Turn, 90 = the shadow at the bottom). Pillow: dark round the edge, light in the middle. Edge fade:
     only a dark rim. 3D: a ball lit from the far side, with its edge rolling into shadow. Cast shadow: dark along
     the shadow side, fading across. Darkest and Lightest set the range. */
  const CH_PRESETS = [['pillow', 'Pillow'], ['edge', 'Edge fade'], ['ball', '3D'], ['cast', 'Cast shadow']];
  const chBox = (l) => { const P = dzChPts(l).flat(), xs = P.filter((_, i) => i % 2 === 0), ys = P.filter((_, i) => i % 2); return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) || 1, Math.max(...ys) - Math.min(...ys) || 1]; };
  function chPreset(l, kind) { const sh = l.sh, b = chBox(l), N = CH_MAP, g = document.createElement('canvas').getContext('2d'), P = dzChPath(l), ins = new Uint8Array(N * N), cell = (i, j) => [b[0] + (i + 0.5) / N * b[2], b[1] + (j + 0.5) / N * b[3]];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const [X, Y] = cell(i, j); ins[j * N + i] = g.isPointInPath(P, X * CH_PX, Y * CH_PX, 'evenodd') ? 1 : 0; }
    const outs = []; for (let k = 0; k < N * N; k++) if (!ins[k]) outs.push(cell(k % N, Math.floor(k / N)));
    const e = new Float32Array(N * N); let mx = 0;
    for (let k = 0; k < N * N; k++) { if (!ins[k]) continue; const [X, Y] = cell(k % N, Math.floor(k / N)); let d = Math.min(X - b[0], b[0] + b[2] - X, Y - b[1], b[1] + b[3] - Y); for (const [ox, oy] of outs) { const q = Math.hypot(X - ox, Y - oy); if (q < d) d = q; } e[k] = d; if (d > mx) mx = d; }
    const dk = sh.tech === 'blend' ? 1 : sh.dark ?? 0.85, lt = sh.tech === 'blend' ? 0 : sh.light ?? 0.05, a = (sh.ang ?? 90) * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), A = new Float32Array(N * N), c01 = (v) => Math.max(0, Math.min(1, v));
    for (let k = 0; k < N * N; k++) { const t = e[k] / (mx || 1), u = (k % N + 0.5) / N - 0.5, v = (Math.floor(k / N) + 0.5) / N - 0.5, side = c01((u * dx + v * dy) * 1.4 + 0.5);
      const s = kind === 'pillow' ? Math.pow(1 - t, 1.6) : kind === 'edge' ? Math.pow(1 - t, 5) : kind === 'ball' ? c01(0.8 * side + 0.45 * Math.pow(1 - t, 3) - 0.15) : c01(side * 1.6 - 0.65) * Math.pow(1 - t, 0.8) + 0.15 * Math.pow(1 - t, 6);
      A[k] = 255 * (lt + (dk - lt) * c01(s)); }
    sh.grad = 'paint'; sh.map = dzChMapEnc(A); sh.preset = kind; delete sh.mapN; delete sh.raw; delete sh.src; }
  /* On the shape, while a shading zone's menu is open: dots to drag for a straight or radial gradient (the black dot
     is the dark end), or the airbrush for a painted one. Sized for a finger as well as a pen. */
  const chBrush = { size: 6, flow: 0.35, hard: false, mode: 'dark' }; let chDrag = null, chArr = null, chRaf = 0, chAt = null;
  /* Skin marker on a shading zone's stencil (Stencil tab): drawn into a copy of the stencil picture, shown live on the
     overlay, saved as the zone's stencil when the stroke ends. The wipe takes it off, wider, like a spirit wipe. */
  const chMkM = { r: 0.6, wipe: false }; let chMk = null;
  const chMkOn = () => { const p0 = pop(), l = layer(); return p0 && !p0.hidden && p0.classList.contains('dz-chpop') && p0.dataset.ch === 'role' && chTab.role === 'sten' && l?.role === 'shade' ? l : null; };
  const chMkCanvas = async (l) => { const S = l.sh.stencil, b = S?.box || chBox(l), im = S ? await dzImg(S.ref) : null, k = Math.min(20, 3000 / Math.max(b[2], b[3])), c = document.createElement('canvas');
    c.width = im ? im.naturalWidth || im.width : Math.max(2, Math.round(b[2] * k)); c.height = im ? im.naturalHeight || im.height : Math.max(2, Math.round(b[3] * k)); if (im) c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); return { c, b }; };
  const chMkDot = (x, y) => { const { c, b } = chMk, g = c.getContext('2d'), sx = c.width / b[2], r = (chMkM.wipe ? Math.max(3, chMkM.r * 5) : chMkM.r) / 2 * sx; g.globalCompositeOperation = chMkM.wipe ? 'destination-out' : 'source-over'; g.fillStyle = 'rgba(78,40,150,0.9)'; g.globalAlpha = chMkM.wipe ? 0.5 : 1;
    g.beginPath(); g.arc((x - b[0]) * sx, (y - b[1]) * c.height / b[3], r, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; };
  const chMkSave = async (l) => { const { c, b } = chMk, old = l.sh.stencil?.ref, ref = await Media.save(await new Promise(r => c.toBlob(r, 'image/png')), 'png');
    l.sh.stencil = { ref, box: b.map(v => Math.round(v * 100) / 100) }; await DB.run('INSERT INTO design_assets (design_id, ref) VALUES (?, ?)', [id, ref]);
    if (old && old !== ref) { await DB.run('DELETE FROM design_assets WHERE design_id = ? AND ref = ?', [id, old]); await Media.release(old); } };
  const chOvOn = () => { const m = chMkOn(); if (m) return m; const p0 = pop(), l = layer(); return p0 && !p0.hidden && p0.classList.contains('dz-chpop') && p0.dataset.ch === 'role' && l?.role === 'shade' && ['linear', 'radial', 'paint'].includes(l.sh?.grad) ? l : null; };
  const chScr = () => { const pr = page.getBoundingClientRect(), sr = stage.getBoundingClientRect(), s = pr.width / doc.w; return { ox: pr.left - sr.left, oy: pr.top - sr.top, s, sr }; };
  const mm2s = (x, y) => { const S = chScr(); return [S.ox + x * CH_PX * S.s, S.oy + y * CH_PX * S.s]; };
  const s2mm = (cx, cy) => { const S = chScr(); return [(cx - S.sr.left - S.ox) / S.s / CH_PX, (cy - S.sr.top - S.oy) / S.s / CH_PX]; };
  const chHandles = (l, b = chBox(l)) => { const sh = l.sh, cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
    if (sh.grad === 'radial') return [{ k: 'c', x: b[0] + (sh.cx ?? 0.5) * b[2], y: b[1] + (sh.cy ?? 0.5) * b[3] }];
    const a = (sh.ang ?? 90) * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), half = (Math.abs(dx) * b[2] + Math.abs(dy) * b[3]) / 2, s = sh.rev ? -1 : 1;
    return [{ k: 'd', x: cx - dx * half * s, y: cy - dy * half * s }, { k: 'l', x: cx + dx * half * s, y: cy + dy * half * s }]; };
  function chOv() { let c = $('#dz-chov'); if (!c) { c = document.createElement('canvas'); c.id = 'dz-chov'; stage.appendChild(c); chWire(); }
    const l = chOvOn(); c.hidden = !l; if (!l) return; const sr = stage.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1), W2 = Math.round(sr.width * dpr), H2 = Math.round(sr.height * dpr);
    if (c.width !== W2 || c.height !== H2) { c.width = W2; c.height = H2; } const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, sr.width, sr.height);
    const b = chDrag?.b || chBox(l), S = chScr(), [bx, by] = mm2s(b[0], b[1]); g.setLineDash([5, 4]); g.lineWidth = 1.2; g.strokeStyle = 'rgba(31,182,166,.9)'; g.strokeRect(bx, by, b[2] * CH_PX * S.s, b[3] * CH_PX * S.s); g.setLineDash([]);
    if (chMkOn()) { if (chMk?.live) { const [X0, Y0] = mm2s(chMk.b[0], chMk.b[1]); g.globalAlpha = 0.55; g.drawImage(chMk.c, X0, Y0, chMk.b[2] * CH_PX * S.s, chMk.b[3] * CH_PX * S.s); g.globalAlpha = 1; }
      if (chAt) { const [X, Y] = mm2s(...chAt), r = Math.max(2, (chMkM.wipe ? Math.max(3, chMkM.r * 5) : chMkM.r) / 2 * CH_PX * S.s); g.beginPath(); g.arc(X, Y, r, 0, Math.PI * 2); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); g.strokeStyle = chMkM.wipe ? '#9fd3e0' : '#4e2896'; g.lineWidth = 1.2; g.stroke(); } return; }
    if (l.sh.grad === 'paint') { if (chAt) { const [X, Y] = mm2s(...chAt), r = chBrush.size / 2 * CH_PX * S.s; g.beginPath(); g.arc(X, Y, r, 0, Math.PI * 2); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); g.strokeStyle = '#141414'; g.lineWidth = 1; g.stroke(); } return; }
    const Hs = chHandles(l, b).map(h => ({ ...h, s: mm2s(h.x, h.y) }));
    if (Hs.length === 2) { g.beginPath(); g.moveTo(...Hs[0].s); g.lineTo(...Hs[1].s); g.strokeStyle = 'rgba(31,182,166,.95)'; g.lineWidth = 2.5; g.stroke(); }
    for (const h of Hs) { g.beginPath(); g.arc(h.s[0], h.s[1], 11, 0, Math.PI * 2); g.fillStyle = h.k === 'l' ? '#fbfbf8' : '#141414'; g.fill(); g.strokeStyle = '#1fb6a6'; g.lineWidth = 3; g.stroke(); } }
  const chLive = () => { if (chRaf) return; chRaf = requestAnimationFrame(async () => { chRaf = 0; await redraw(); chOv(); }); };
  const chStamp = (l, x, y) => { const b = chDrag.b, N = l.sh.mapN || CH_MAP, r = chBrush.size / 2, tgt = chBrush.mode === 'light' ? 0 : 255;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const X = b[0] + (i + 0.5) / N * b[2], Y = b[1] + (j + 0.5) / N * b[3], dd = Math.hypot(X - x, Y - y); if (dd > r) continue; const w = chBrush.hard ? 1 : Math.pow(1 - dd / r, 2), k = j * N + i; chArr[k] += (tgt - chArr[k]) * chBrush.flow * w; }
    l.sh.map = dzChMapEnc(chArr); delete l.sh.preset; chLive(); };
  /* The stage takes a press only when it is on a gradient dot, or the airbrush on the zone (left button, pen or one
     finger); anything else (the middle button, a second finger, off the zone) pans, pinches and selects as usual. */
  let chWired = false;
  // A press that is the airbrush on the zone or a gradient dot (left button, pen or one finger), or null for anything else.
  function chHit(e) { const l = chOvOn(); if (!l || e.button !== 0 || (e.pointerType === 'touch' && !e.isPrimary) || e.target.closest('.dz-pop, .dz-rail, .dz-qs, .dz-zoom, .dz-xf, .dz-mods')) return null;
    const [x, y] = s2mm(e.clientX, e.clientY), b = chBox(l);
    if (chMkOn()) { const B = l.sh.stencil?.box || b; return x < B[0] - 2 || x > B[0] + B[2] + 2 || y < B[1] - 2 || y > B[1] + B[3] + 2 ? null : { l, x, y, b: B, mk: true }; }
    if (l.sh.grad === 'paint') { const r = chBrush.size / 2; return x < b[0] - r || x > b[0] + b[2] + r || y < b[1] - r || y > b[1] + b[3] + r ? null : { l, x, y, b, paint: true }; }
    const S = chScr(), hit = chHandles(l, b).find(h => { const [X, Y] = mm2s(h.x, h.y); return Math.hypot(e.clientX - S.sr.left - X, e.clientY - S.sr.top - Y) < 28; }); return hit ? { l, x, y, b, k: hit.k } : null; }
  function chWire() { if (chWired) return; chWired = true;
    stage.addEventListener('pointerdown', async (e) => { const H = chHit(e); if (!H) return; const { l, x, y, b } = H;
      if (H.mk) { e.preventDefault(); e.stopImmediatePropagation(); if (chMk?.busy) return; chDrag = { mk: true, last: [x, y], b, id: e.pointerId, l }; chAt = [x, y]; try { stage.setPointerCapture(e.pointerId); } catch {}
        chMk = { ...(await chMkCanvas(l)), live: true }; l.sh.mkLive = true; chMkDot(x, y); await redraw(); chOv(); return; }
      if (H.paint) { chArr = Float32Array.from(dzChMapArr(l.sh)); chDrag = { paint: true, last: [x, y], b }; chAt = [x, y]; }
      else chDrag = { k: H.k, b };
      e.preventDefault(); e.stopImmediatePropagation(); chDrag.id = e.pointerId; try { stage.setPointerCapture(e.pointerId); } catch {} if (chDrag.paint) chStamp(l, x, y); }, true);
    stage.addEventListener('pointermove', (e) => { const l = chOvOn(); if (!l) return; if (chDrag && e.pointerId !== chDrag.id) return; const [x, y] = s2mm(e.clientX, e.clientY);
      if (!chDrag) { if (l.sh.grad === 'paint') { chAt = [x, y]; chOv(); } return; }
      e.stopImmediatePropagation(); chAt = [x, y];
      if (chDrag.mk) { if (!chMk?.c) return; const [lx, ly] = chDrag.last, st2 = Math.max(0.1, (chMkM.wipe ? chMkM.r * 5 : chMkM.r) / 4), n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / st2)); for (let i = 1; i <= n; i++) chMkDot(lx + (x - lx) * i / n, ly + (y - ly) * i / n); chDrag.last = [x, y]; chOv(); return; }
      if (chDrag.paint) { const [lx, ly] = chDrag.last, r = chBrush.size / 2, n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / Math.max(0.3, r / 3))); for (let i = 1; i <= n; i++) chStamp(l, lx + (x - lx) * i / n, ly + (y - ly) * i / n); chDrag.last = [x, y]; return; }
      const sh = l.sh, b = chDrag.b, c01 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
      if (chDrag.k === 'c') { sh.cx = c01((x - b[0]) / b[2]); sh.cy = c01((y - b[1]) / b[3]); }
      else { const Hs = chHandles(l, b), D = chDrag.k === 'd' ? { x, y } : Hs[0], L2 = chDrag.k === 'l' ? { x, y } : Hs[1]; let a = Math.atan2(L2.y - D.y, L2.x - D.x) * 180 / Math.PI; if (sh.rev) a += 180; sh.ang = Math.round(((a % 360) + 360) % 360); }
      chLive(); }, true);
    const up = async (e) => { if (!chDrag || e.pointerId !== chDrag.id) return; e.stopImmediatePropagation(); const D = chDrag; chDrag = null; chArr = null;
      if (D.mk) { if (!chMk?.c) return; chMk.busy = true; try { await chMkSave(D.l); } catch (err) { toast('Could not save the stencil: ' + err.message, 3500); } delete D.l.sh.mkLive; chMk = null; changed(true); await redraw(); chOv(); return chRe(); }
      changed(true); chRe(); }; stage.addEventListener('pointerup', up, true); stage.addEventListener('pointercancel', up, true);
    stage.addEventListener('pointerleave', () => { if (!chDrag && chAt) { chAt = null; chOv(); } }); }
  $('#dz-pop').addEventListener('click', async (e) => { const p0 = $('#dz-pop'); if (!p0.classList.contains('dz-chpop')) return; const t = e.target, d = (kk) => t.closest(`[data-${kk}]`)?.dataset[kk], l = layer();
    if (d('cht')) { const [m, k] = d('cht').split(':'); chTab[m] = k; return chRe(); }
    if (d('chst') != null && l?.sh) { chStop = +d('chst'); return chRe(); }
    if (d('chcup') && l?.sh) { const k = d('chcup'), S = l.sh; if (k === 'empty') { chCup.c = null; chCup.v = 0; return chRe(); } if (!chCup.c) return; chStopFix(S); const i = Math.min(chStop, S.cols.length - 1), hx = ttToHex(chCup.c);
      if (k === 'add') { if (S.cols.length >= 10) return toast('Up to 10 colours.', 1500); S.cols.splice(i + 1, 0, hx); S.mixs.splice(i + 1, 0, [hx]); chStop = i + 1; } else { S.cols[i] = hx; S.mixs[i] = [hx]; }
      changed(true); return chRe(); }
    if (t.closest('[data-chstadd]') && l?.sh) { const S = l.sh; chStopFix(S); const i = Math.min(chStop, S.cols.length - 1); if (S.cols.length >= 10) return; S.cols.splice(i + 1, 0, S.cols[i]); S.mixs.splice(i + 1, 0, [...S.mixs[i]]); chStop = i + 1; changed(true); return chRe(); }
    if (t.closest('[data-chstdel]') && l?.sh) { const S = l.sh; chStopFix(S); if (S.cols.length <= 2) return; const i = Math.min(chStop, S.cols.length - 1); S.cols.splice(i, 1); S.mixs.splice(i, 1); chStop = Math.max(0, i - 1); changed(true); return chRe(); }
    if (d('chsc') && l?.sh) { const S = l.sh; chStopFix(S); const i = Math.min(chStop, S.cols.length - 1); S.mixs[i] = [d('chsc'), S.mixs[i][1], S.mixs[i][2]]; chStopSet(S, i); changed(true); return chRe(); }
    if (d('chsm') != null && l?.sh) { const S = l.sh; chStopFix(S); const i = Math.min(chStop, S.cols.length - 1); S.mixs[i] = [S.mixs[i][0], d('chsm') || undefined, S.mixs[i][2] ?? 0.5]; chStopSet(S, i); changed(true); return chRe(); }
    if (t.closest('[data-chsten]') && l?.sh?.src) { e.preventDefault(); return chStencil(l); }
    if (t.closest('[data-chstenx]') && l?.sh?.stencil) { e.preventDefault(); delete l.sh.stencil; changed(true); return chRe(); }
    if (d('chpre') && l?.sh) { chPreset(l, d('chpre')); changed(true); drawCtx(); return chRe(); }
    if (d('chmk')) { chMkM.wipe = d('chmk') === 'wipe'; return chRe(); }
    if (d('chbr')) { const [k, v] = d('chbr').split(':'); chBrush[k] = k === 'hard' ? v === '1' : v; return chRe(); }
    if (d('chs') && l?.sh) { const [k, v] = d('chs').split(':'); if (k === 'grad' && v === 'paint' && l.sh.grad !== 'paint') { l.sh.map = dzChMapEnc(dzChBake(l.sh, chBox(l))); delete l.sh.preset; delete l.sh.mapN; delete l.sh.raw; } l.sh[k] = k === 'rev' ? v === '1' : v;
      if (k === 'tech') { l.nd = CH_SHADE[v][2]; delete l.nds; chDefN(l); if (v === 'blend' && !l.sh.cols) { l.sh.cols = [chCaps()[2] || chCaps()[0], chCaps()[3] || chCaps()[0]]; chStopFix(l.sh); } }
      changed(true); drawCtx(); return chRe(); }
    if (d('chr') === 'shade' && l) { l.role = 'shade'; l.sh ||= { tech: 'stipple', grad: 'linear', ang: 90, dark: 0.85, light: 0.05, bias: 1 }; l.nd = CH_SHADE[l.sh.tech][2]; chDefN(l); changed(true); drawCtx(); return chRe(); }
    if (d('chr') != null && l) { const r = d('chr'); if (r) { l.role = r; if (!(r === 'pack' ? CH_PACKERS : CH_LINERS).includes(l.nd)) l.nd = r === 'pack' ? '7RS' : r === 'outline' ? '5RL' : '3RL'; if (r === 'pack') { l.mixOf ||= [chCaps()[0]]; chInk(l); } chDefN(l); } else { delete l.role; delete l.nd; }
      changed(true); drawCtx(); return chRe(); }
    if (d('chn') && l) { const n = d('chn'); if (l.role === 'pack' || l.role === 'shade') { const A = dzChNds(l), on = A.includes(n), B = on ? A.filter(x => x !== n) : [...A, n]; if (!B.length) return toast('Allow at least one needle.', 1600); l.nds = B; l.nd = B[0]; } else { l.nd = n; delete l.nds; } changed(true); drawCtx(); return chRe(); }
    if (d('chca') && l) { l.mixOf = [d('chca'), l.mixOf?.[1]]; chInk(l); changed(true); return chRe(); }
    if (d('chcb') != null && l) { const b = d('chcb'); l.mixOf = [l.mixOf?.[0] || chCaps()[0], b || undefined]; chInk(l); changed(true); return chRe(); }
    if (t.closest('[data-chsetup]')) { closePop(); return chSetup(); }
    if (t.closest('[data-chtrace]')) { closePop(); return chTracePick(); }
    if (t.closest('[data-chstshow]')) { doc.chal.showSten = doc.chal.showSten === false; changed(true); redraw(); return chRe(); }
    if (t.closest('[data-charea]') && doc.chal.area) { doc.chal.showArea = doc.chal.showArea === false; changed(true); chAreaDraw(); return chRe(); }
    if (d('chpal')) { doc.chal.pal = d('chpal'); changed(true); return chRe(); }
    if (d('chpe')) { const k = d('chpe'), use = (P) => { doc.chal.pal = P.id; changed(true); chRe(); };
      if (k === 'imp') return ttPalImport(use);
      if (k === 'new') return ttPalEdit({ id: 'p' + Date.now().toString(36), name: 'Challenge palette', caps: [{ c: '#141414', s: 1 }] }, true, use, () => { doc.chal.pal = 'default'; changed(true); chRe(); });
      const cur = chPals().find(x => x.id === doc.chal.pal) || chPals()[0], mine = ttPalMine().some(x => x.id === cur.id);
      return ttPalEdit(mine ? JSON.parse(JSON.stringify(cur)) : { id: 'p' + Date.now().toString(36), name: 'My ' + cur.name.toLowerCase(), caps: JSON.parse(JSON.stringify(cur.caps)) }, !mine, use, () => { doc.chal.pal = 'default'; changed(true); chRe(); }); }
    if (t.closest('[data-chmine]') && doc.chal) { if (doc.chal.mine) { if (!await ask('Take this out of My challenges? Its best score stays.')) return; doc.chal.mine = false; }
      else { const T = dzChSpec(doc, $('#dz-name').value.trim() || name, id); if (T.err) return toast(T.err, 3500); const rows = await DB.all(`SELECT meta FROM tattoo_pieces WHERE meta LIKE ?`, ['%"u-' + id + '"%']);
        if (!rows.some(r => { try { return JSON.parse(r.meta).exam?.custom?.id === 'u-' + id; } catch { return false; } })) return toast('Play it in the simulator first, to test it.', 3000);
        doc.chal.mine = true; toast('Added to My challenges, in the Challenges hub. Play it here again after changing it, so the hub has the latest.', 5000); }
      changed(true); await flush(); return chRe(); }
    if (t.closest('[data-chplay]') && doc.chal?.lines && !doc.layers.some(o => o.t === 'shape' && (o.role === 'outline' || o.role === 'detail') && !o.hide)) {
      if (await ask('Linework is on, but no shape is graded as a line (Outline or Detail), so there are no lines to judge.\n\nTurn linework off for this challenge?')) { doc.chal.lines = false; if (doc.chal.focus) doc.chal.focus.line = 0; changed(true); } }
    if (t.closest('[data-chplay]')) { const T = dzChSpec(doc, $('#dz-name').value.trim() || name, id); if (T.err) return toast(T.err, 3500); for (const S of T.stencils || []) if (!await Media.url(S.ref)) return toast('The stencil file for this value study is missing. Select the study and press Remake the stencil.', 5000);
      await flush(); closePop();
      { const box = (q) => [q[0], q[1], q[0] + q[2], q[1] + q[3]], P = T.lines.flat().concat(T.pack ? box(T.pack) : [], ...(T.shades || []).map(z => box(z.box))), xs = P.filter((_, i) => i % 2 === 0), ys = P.filter((_, i) => i % 2);
        /* the example: for a value study its own picture (as it shows, the study unhidden) cropped to the zone; otherwise the design, cropped round the challenge (lines, packing and shading) */
        const st = doc.layers.find(o => o.role === 'shade' && o.sh?.src && !o.hide), pic = st && doc.layers.find(o => o.t === 'image' && o.ref === st.sh.src), m = pic ? 0 : 6, zb = pic && T.shades?.find(z => z.mapN)?.box;
        const [X0, Y0, X1, Y1] = zb ? box(zb) : [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        const x0 = Math.max(0, X0 - m), y0 = Math.max(0, Y0 - m), x1 = Math.min(180, X1 + m), y1 = Math.min(130, Y1 + m), full = document.createElement('canvas'), sc = pic ? 1.2 : 0.6;
        if (x1 > x0 && y1 > y0) { full.width = Math.round(doc.w * sc); full.height = Math.round(doc.h * sc); if (pic) { const g0 = full.getContext('2d'); g0.fillStyle = '#fff'; g0.fillRect(0, 0, full.width, full.height); }
        await dzDraw(full, pic ? { ...doc, layers: doc.layers.map(o => o === pic ? { ...o, hide: false } : o) } : doc, sc, pic ? { only: new Set([pic.id]), noBg: true, noStencil: true } : {}); const c = document.createElement('canvas'), k2 = CH_PX * sc;
        c.width = Math.round((x1 - x0) * k2); c.height = Math.round((y1 - y0) * k2); c.getContext('2d').drawImage(full, x0 * k2, y0 * k2, c.width, c.height, 0, 0, c.width, c.height);
        T.refImg = c.toDataURL('image/jpeg', 0.85); T.refAr = c.height / c.width; } }
      const skin = TT_SKINS[doc.chal.skin ?? ttChSkin()]?.[1] || TT_SKINS[ttChSkin()][1], exam = { v: 1, mode: 'ch', list: [T.id], i: 0, res: [], started: Date.now(), custom: T };
      const rows = await DB.all(`SELECT id, meta FROM tattoo_pieces WHERE meta LIKE ?`, ['%"' + T.id + '"%']), hit = rows.find(r => { try { return JSON.parse(r.meta).exam?.custom?.id === T.id; } catch { return false; } });
      if (hit) { let m = {}; try { m = JSON.parse(hit.meta); } catch {} await DB.run(`UPDATE tattoo_pieces SET meta = ?, skin = ?, updated_at = datetime('now') WHERE id = ?`, [JSON.stringify({ ...m, exam }), skin, hit.id]); location.hash = 'tattoo/' + hit.id; return; }
      await DB.run('INSERT INTO tattoo_pieces (name, w_cm, h_cm, skin, meta) VALUES (?, ?, ?, ?, ?)', ['Challenge: ' + T.title, 18, 13, skin, JSON.stringify({ exam })]);
      location.hash = 'tattoo/' + (await DB.one('SELECT last_insert_rowid() AS id')).id; } });
  $('#dz-pop').addEventListener('pointerdown', (e) => { const b = e.target.closest('[data-chpour]'); if (!b || typeof ttMix !== 'function') return; e.preventDefault(); const col = ttHex(b.dataset.chpour);
    if (!chCup.c) { chCup.c = col; chCup.v = 0.15; } let t0 = performance.now();
    const step = (now) => { if (!chPour) return; const dt = Math.min(0.1, (now - t0) / 1000); t0 = now; const a = dt * 0.9, f = a / (chCup.v + a); chCup.c = ttMix(chCup.c, col, f); chCup.v += a;
      const sw = $('#dz-pop [data-chcupc]'); if (sw) sw.style.background = ttToHex(chCup.c); chPour.raf = requestAnimationFrame(step); };
    chPour = { raf: requestAnimationFrame(step) }; });
  ['pointerup', 'pointercancel'].forEach(ev => addEventListener(ev, chPourEnd));
  $('#dz-pop').addEventListener('change', (e) => { const p0 = $('#dz-pop'); if (!p0.classList.contains('dz-chpop')) return;
    if (e.target.matches('[data-chtext]')) { doc.chal.text = e.target.value; changed(true); }
    if (e.target.matches('[data-chlock]')) { doc.chal.lock = e.target.checked; changed(true); }
    if (e.target.matches('[data-chlj]')) { doc.chal.lessonJudge = e.target.checked; changed(true); chRe(); }
    if (e.target.matches('[data-chf]')) { doc.chal.focus = { ...(doc.chal.focus || {}), [e.target.dataset.chf]: +e.target.value }; changed(true); }
    if (e.target.matches('[data-chmt]')) { const l = layer(); if (l) { l.mixT = +e.target.value; chInk(l); changed(true); chRe(); } }
    if (e.target.matches('[data-chss]')) { const l = layer(); if (l?.sh) { const k = e.target.dataset.chss; l.sh[k] = +e.target.value; if (l.sh.grad === 'paint' && l.sh.preset && k !== 'bias') chPreset(l, l.sh.preset); if (l.sh.grad === 'paint' && l.sh.raw && /^(levels|dark|light)$/.test(k)) chQuant(l.sh); changed(true); if (k === 'levels') chRe(); } }
    if (e.target.matches('[data-chbrs]')) chBrush[e.target.dataset.chbrs] = +e.target.value;
    if (e.target.matches('[data-chmks]')) { chMkM.r = +e.target.value; const b2 = e.target.parentElement.querySelector('b'); if (b2) b2.textContent = chMkM.r + ' mm'; }
    if (e.target.matches('[data-chsmt]')) { const l = layer(); if (l?.sh) { const S = l.sh; chStopFix(S); const i = Math.min(chStop, S.cols.length - 1); S.mixs[i][2] = +e.target.value; chStopSet(S, i); changed(true); chRe(); } } });
  $('#dz-pop').addEventListener('input', (e) => { if ($('#dz-pop').classList.contains('dz-chpop') && e.target.matches('[data-chf]')) { const b = e.target.nextElementSibling; if (b) b.textContent = Math.round(e.target.value * 100) + '%'; }
    const l = layer(); if ($('#dz-pop').classList.contains('dz-chpop') && e.target.matches('[data-chss]') && l?.sh) { l.sh[e.target.dataset.chss] = +e.target.value; redraw(); return; }
    if ($('#dz-pop').classList.contains('dz-chpop') && e.target.matches('[data-chmt]') && l) { l.mixT = +e.target.value; chInk(l); redraw(); const r = $('#dz-pop .dz-chres i'); if (r) r.style.background = l.ink; } });
  /* ---------- Pattern tile ----------
     The page is one cell of the pattern. Its neighbours are drawn faintly round it (the same picture, a cell over),
     and every layer is also drawn a cell over in each direction (dzDraw), so a shape that crosses an edge carries on
     from the opposite one. The menu sets the cell's size and shape, how many rings of neighbours show and how faint,
     the background, fits what's selected to the cell, and saves the tile. */
  function patDraw() { const c = $('#dz-patcv'), P = doc.pat; if (!c) return; c.hidden = !P || !P.ring; if (c.hidden) return;
    const sr = stage.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(sr.width * dpr), H = Math.round(sr.height * dpr); if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, sr.width, sr.height);
    const pl = parseFloat(page.style.left) || 0, pt = parseFloat(page.style.top) || 0, pw = doc.w * k, ph = doc.h * k, R = Math.min(3, P.ring | 0);
    g.globalAlpha = Math.max(0.05, Math.min(1, P.fade ?? 0.38));
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) if (i || j) { if (!P.clear) { g.fillStyle = dzCol(doc, doc.bg?.c) || '#fff'; g.fillRect(pl + i * pw, pt + j * ph, pw, ph); } g.drawImage(cv, pl + i * pw, pt + j * ph, pw, ph); }
    g.globalAlpha = 1; g.setLineDash([6, 4]); g.lineWidth = 1.5; g.strokeStyle = 'rgba(232,154,69,.95)'; g.strokeRect(pl - 0.5, pt - 0.5, pw + 1, ph + 1); g.setLineDash([]); }
  const patMM = () => [doc.w / ((doc.dpi || 300) / 25.4), doc.h / ((doc.dpi || 300) / 25.4)];
  const patMenu = () => { const P = doc.pat, [wm, hm] = patMM();
    return `<div class="gh">Pattern</div>
      <div class="dz-gsz"><span>Cell</span><input class="in" type="text" inputmode="decimal" data-patcw value="${dzMM(wm)}" style="width:62px"><span>×</span><input class="in" type="text" inputmode="decimal" data-patch value="${dzMM(hm)}" style="width:62px"><em>mm</em></div>
      <div class="dz-gk" style="grid-template-columns:repeat(5,1fr)">${PAT_RATIOS.map(([n, a, b]) => `<button data-patr="${a}:${b}">${n}</button>`).join('')}</div>
      <div class="gh" style="margin-top:4px">Neighbours</div><div class="dz-gk" style="grid-template-columns:repeat(4,1fr)">${[[0, 'Off'], [1, '1'], [2, '2'], [3, '3']].map(([v, n]) => `<button data-patring="${v}" class="${(P.ring | 0) === v ? 'on' : ''}">${n}</button>`).join('')}</div>
      <label class="dz-gsz"><span>Fade</span><input type="range" min="0.05" max="1" step="0.05" data-patfade value="${P.fade ?? 0.38}" style="flex:1"></label>
      <div class="dz-gk" style="grid-template-columns:1fr 1fr">${[[1, 'See-through'], [0, 'Colour']].map(([v, n]) => `<button data-patclear="${v}" class="${!!P.clear === !!v ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="dz-gk" style="grid-template-columns:1fr;margin-top:6px"><button data-patfit data-tip="Size what's selected (or everything) to fill the cell, keeping its shape and arrangement">Fit to the cell</button></div>
      <div class="gh" style="margin-top:4px">Save the tile</div><div class="dz-gk" style="grid-template-columns:1fr 1fr"><button data-patsave="refs">To References</button><button data-patsave="device">To device</button></div>
      <p class="muted" style="font-size:11px;margin:4px 6px 6px">What crosses an edge comes back on the other side. Saved tiles are in References, in Patterns: pick one for a texture fill.</p>`; };
  const patSet = (fn) => { fn(doc.pat); changed(true); fit(); redraw(); const p0 = pop(); if (!p0.hidden && p0.classList.contains('dz-ppop')) p0.innerHTML = patMenu(); };
  const patSize = (wm, hm) => { const per = ((doc.dpi || 300) / 25.4); doc.w = Math.max(20, Math.round(wm * per)); doc.h = Math.max(20, Math.round(hm * per)); doc.paper = `Pattern tile, ${dzMM(wm)} × ${dzMM(hm)} mm`; };
  $('#dz-pop').addEventListener('click', async (e) => { if (!$('#dz-pop').classList.contains('dz-ppop')) return; const t = e.target, d = (kk) => t.closest(`[data-${kk}]`)?.dataset[kk];
    if (d('patr')) { const [a, b] = d('patr').split(':').map(Number), [wm] = patMM(); return patSet(() => patSize(wm, wm * b / a)); }
    if (d('patring') != null) return patSet(P => { P.ring = +d('patring'); });
    if (d('patclear') != null) return patSet(P => { P.clear = d('patclear') === '1'; });
    if (t.closest('[data-patfit]')) { const L = (many() ? picked() : layer() ? [layer()] : doc.layers).filter(l => !l.hide && !l.lock); if (!L.length) return toast('Nothing to fit.');
      const bs = L.map(box), B = { x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)), x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)) };
      const f = Math.min(doc.w / Math.max(1, B.x1 - B.x0), doc.h / Math.max(1, B.y1 - B.y0)), cx = (B.x0 + B.x1) / 2, cy = (B.y0 + B.y1) / 2;
      for (const l of L) { const lcx = l.x + l.w / 2, lcy = l.y + (l.h || 0) / 2, nw = l.w * f, nh = (l.h || 0) * f; l.x = doc.w / 2 + (lcx - cx) * f - nw / 2; l.y = doc.h / 2 + (lcy - cy) * f - nh / 2; l.w = nw; if (l.h) l.h = nh; if (l.t === 'text' && l.size) l.size *= f; if (l.sw) l.sw *= f; }
      changed(true); redraw(); return toast(L.length === 1 ? 'Fitted to the cell.' : `${L.length} items fitted to the cell.`, 1600); }
    const sv = d('patsave'); if (sv) { const title = sv === 'refs' ? await askText('Name for the pattern:', name) : name; if (title == null) return; closePop(); select(null);
      const c = document.createElement('canvas'); c.width = doc.w; c.height = doc.h; await dzDraw(c, doc, 1); return dzSavePattern(c, title.trim() || 'Pattern', sv === 'device'); } });
  $('#dz-pop').addEventListener('change', (e) => { if (!$('#dz-pop').classList.contains('dz-ppop')) return;
    if (e.target.matches('[data-patcw], [data-patch]')) { const w = parseFloat($('#dz-pop [data-patcw]').value), h = parseFloat($('#dz-pop [data-patch]').value); if (w > 0 && h > 0) patSet(() => patSize(Math.min(1000, w), Math.min(1000, h))); }
    if (e.target.matches('[data-patfade]')) patSet(P => { P.fade = +e.target.value; }); });
  $('#dz-pop').addEventListener('input', (e) => { if ($('#dz-pop').classList.contains('dz-ppop') && e.target.matches('[data-patfade]')) { doc.pat.fade = +e.target.value; patDraw(); } });
  /* ---------- Grid and perspective ----------
     Kept with the design (doc.grid: on, type, size in the design's unit, snap, vanishing points in page px) and
     never printed or exported. Square, isometric, one, two and three point perspective, and radial, as in the
     simulator. With snap on, edges, centres, pen points and nodes snap to the grid's lines; in perspective and
     isometric, a pen line close to a grid direction (towards a vanishing point, upright, level) runs exactly along it. */
  const GRID_KINDS = [['square', 'Square'], ['iso', 'Isometric'], ['p1', '1-point'], ['p2', '2-point'], ['p3', '3-point'], ['radial', 'Radial']];
  const gSnap = () => !!(doc.grid?.on && doc.grid.snap !== false);
  const gStep = () => Math.max(2, (+doc.grid?.size || 10) * dzPer(doc));
  const gVps = () => { const G = doc.grid, W = doc.w, H = doc.h; G.vp ||= [{ x: W / 2, y: H * 0.4 }, { x: W * 0.06, y: H * 0.4 }, { x: W * 0.94, y: H * 0.4 }, { x: W / 2, y: H * 0.96 }];
    return G.type === 'p1' || G.type === 'radial' ? [G.vp[0]] : G.type === 'p2' ? [G.vp[1], G.vp[2]] : G.type === 'p3' ? [G.vp[1], G.vp[2], G.vp[3]] : []; };
  const gIdx = () => { const T = doc.grid?.type; return T === 'p1' || T === 'radial' ? [0] : T === 'p2' ? [1, 2] : T === 'p3' ? [1, 2, 3] : []; };
  function gridSteps() { if (!gSnap()) return null; const T = doc.grid.type || 'square', g = gStep();
    return T === 'square' ? { x: g, y: g } : T === 'iso' ? { x: g * Math.cos(Math.PI / 6), y: 0 } : T === 'p1' || T === 'p2' ? { x: g, y: 0 } : null; }
  // A pen line near a grid direction from the last point runs exactly along it.
  function perspPt(from, p) { if (!gSnap()) return p; const T = doc.grid.type || 'square'; if (T === 'square') return p;
    const dirs = []; if (T === 'iso') dirs.push(Math.PI / 6, -Math.PI / 6, Math.PI / 2); if (T === 'p1') dirs.push(0, Math.PI / 2); if (T === 'p2') dirs.push(Math.PI / 2);
    for (const v of gVps()) dirs.push(Math.atan2(v.y - from.y, v.x - from.x));
    const dx = p.x - from.x, dy = p.y - from.y, L = Math.hypot(dx, dy); if (L < 1) return p; let best = null;
    for (const a of dirs) { const u = { x: Math.cos(a), y: Math.sin(a) }, s = Math.abs(dx * u.y - dy * u.x) / L; if (s < 0.12 && (!best || s < best.s)) { const t = dx * u.x + dy * u.y; best = { s, x: from.x + u.x * t, y: from.y + u.y * t }; } }
    return best ? { ...p, x: best.x, y: best.y } : p; }
  // moving: a vanishing point is being dragged, so its handle is moved, not rebuilt (that would drop the drag).
  function gridDraw(moving) { const c = $('#dz-gridcv'), vb = $('#dz-vps'); if (!c) return; const G = doc.grid;
    c.hidden = !G?.on; if (vb && !moving) vb.innerHTML = ''; if (!G?.on) return;
    const W = doc.w, H = doc.h, dpr = Math.min(2, devicePixelRatio || 1), cw = Math.max(1, Math.round(W * k * dpr)), ch = Math.max(1, Math.round(H * k * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const x = c.getContext('2d'), s = k * dpr, g = gStep(), T = G.type || 'square'; x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cw, ch); x.setTransform(s, 0, 0, s, 0, 0);
    const line = (a, b) => { x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); }, span = Math.hypot(W, H) * 2;
    const op = G.op ?? 0.45; x.lineWidth = 1 / s; x.strokeStyle = `rgba(31,182,166,${op})`; x.beginPath();
    if (T === 'square' || T === 'p1' || T === 'p2') for (let v = g; v < W; v += g) line({ x: v, y: 0 }, { x: v, y: H });
    if (T === 'square') for (let v = g; v < H; v += g) line({ x: 0, y: v }, { x: W, y: v });
    if (T === 'iso') { const t30 = Math.tan(Math.PI / 6), st2 = g / Math.cos(Math.PI / 6);
      for (let q = -W * t30 - H; q < H + W * t30; q += st2) { line({ x: 0, y: q }, { x: W, y: q + W * t30 }); line({ x: 0, y: q + W * t30 }, { x: W, y: q }); }
      for (let v = 0; v < W; v += g * Math.cos(Math.PI / 6)) line({ x: v, y: 0 }, { x: v, y: H }); }
    const vps = gVps(), rays = Math.max(8, Math.min(72, Math.round(300 / (+G.size || 10))));
    if (T === 'radial') { const o = vps[0]; for (let r = g; r < span / 2; r += g) { x.moveTo(o.x + r, o.y); x.arc(o.x, o.y, r, 0, Math.PI * 2); }
      for (let i = 0; i < rays; i++) { const a = Math.PI * 2 * i / rays; line(o, { x: o.x + Math.cos(a) * span, y: o.y + Math.sin(a) * span }); } }
    else for (const v of vps) { const ang = [[0, 0], [W, 0], [0, H], [W, H]].map(([px, py]) => Math.atan2(py - v.y, px - v.x)); let a0 = Math.min(...ang), a1 = Math.max(...ang);
      if (v.x > 0 && v.x < W && v.y > 0 && v.y < H) { a0 = -Math.PI; a1 = Math.PI; } else if (a1 - a0 > Math.PI) { const s2 = ang.map(a => a < 0 ? a + Math.PI * 2 : a); a0 = Math.min(...s2); a1 = Math.max(...s2); }
      for (let i = 0; i <= rays; i++) { const a = a0 + (a1 - a0) * i / rays; line(v, { x: v.x + Math.cos(a) * span, y: v.y + Math.sin(a) * span }); } }
    x.stroke();
    if (T === 'p1' || T === 'p2') { x.strokeStyle = `rgba(255,111,97,${Math.min(1, op + 0.3)})`; x.lineWidth = 1.5 / s; x.beginPath(); line({ x: -W, y: vps[0].y }, { x: W * 2, y: vps[0].y }); x.stroke(); }   // horizon
    if (vb && moving) { vb.querySelectorAll('[data-vp]').forEach(h => { const v = G.vp[+h.dataset.vp]; h.style.left = v.x * k + 'px'; h.style.top = v.y * k + 'px'; }); return; }
    if (vb) vb.innerHTML = G.lock ? '' : gIdx().map(i => `<i class="dz-vp" data-vp="${i}" style="left:${G.vp[i].x * k}px;top:${G.vp[i].y * k}px" data-tip="Drag the vanishing point"></i>`).join(''); }
  const gridMenu = () => { const G = doc.grid || {}, u = dzUnit(doc);
    return `<div class="gh">Grid</div><div class="dz-gk">${[['off', 'Off'], ...GRID_KINDS].map(([v, n]) => `<button class="${(G.on ? G.type || 'square' : 'off') === v ? 'on' : ''}" data-gk="${v}">${n}</button>`).join('')}</div>
      <label class="dz-gsz"><span>Size</span><input class="in" type="number" min="0.1" step="any" data-gsize value="${+G.size || 10}"><em>${esc(u)}</em></label>
      <label class="dz-gsz"><span>Opacity</span><input type="range" min="0.05" max="1" step="0.05" data-gop value="${G.op ?? 0.45}" style="flex:1"><b data-gopv>${Math.round((G.op ?? 0.45) * 100)}%</b></label>
      ${G.on && G.type === 'iso' ? `<div class="gh" style="margin-top:4px">New shapes go on</div><div class="dz-gk">${[['', 'Flat'], ...ISO_PL].map(([v, n]) => `<button class="${(G.plane || '') === v ? 'on' : ''}" data-gplane="${v}">${n}</button>`).join('')}</div>` : ''}
      <label class="toggle" style="display:flex;margin:4px 6px;border:0;min-height:30px;padding:0" data-tip="Edges, centres, pen points and nodes snap to the grid's lines; in perspective, pen lines near a grid direction run along it. Hold Alt for none."><input type="checkbox" data-gsnap ${G.snap === false ? '' : 'checked'}><span>Snap to the grid</span></label>
      ${['p1', 'p2', 'p3', 'radial'].includes(G.type) && G.on ? `<label class="toggle" style="display:flex;margin:0 6px 4px;border:0;min-height:30px;padding:0" data-tip="Keeps the vanishing points where they are and hides their handles"><input type="checkbox" data-glock ${G.lock ? 'checked' : ''}><span>Lock the grid in place</span></label>
        ${G.lock ? '' : '<button class="btn small" data-greset style="margin:2px 6px 6px">Reset vanishing points</button>'}` : ''}
      <p class="muted" style="font-size:11px;margin:2px 6px 6px">Only on screen: never printed or exported.</p>`; };
  const gridSet = (fn) => { doc.grid ||= { on: false, type: 'square', size: 10, snap: true }; fn(doc.grid); changed(true); gridDraw(); drawRail(); const p0 = pop(); if (!p0.hidden && p0.classList.contains('dz-gpop')) p0.innerHTML = gridMenu(); };
  $('#dz-pop').addEventListener('click', (e) => { if (!$('#dz-pop').classList.contains('dz-gpop')) return; const t = e.target;
    const kk = t.closest('[data-gk]')?.dataset.gk; if (kk) return gridSet(G => { if (kk === 'off') G.on = false; else { G.on = true; G.type = kk; } });
    if (t.closest('[data-greset]')) return gridSet(G => { delete G.vp; });
    const gp = t.closest('[data-gplane]'); if (gp) return gridSet(G => { if (gp.dataset.gplane) G.plane = gp.dataset.gplane; else delete G.plane; }); });
  $('#dz-pop').addEventListener('input', (e) => { if (!$('#dz-pop').classList.contains('dz-gpop') || !e.target.matches('[data-gop]')) return;   /* live while sliding; kept on release */
    doc.grid.op = +e.target.value; const b = $('#dz-pop [data-gopv]'); if (b) b.textContent = Math.round(doc.grid.op * 100) + '%'; gridDraw(); });
  $('#dz-pop').addEventListener('change', (e) => { if (!$('#dz-pop').classList.contains('dz-gpop')) return;
    if (e.target.matches('[data-gsize]')) { const v = +e.target.value; if (v > 0) gridSet(G => { G.size = v; }); }
    if (e.target.matches('[data-gsnap]')) gridSet(G => { G.snap = e.target.checked; });
    if (e.target.matches('[data-gop]')) gridSet(G => { G.op = +e.target.value; });
    if (e.target.matches('[data-glock]')) gridSet(G => { G.lock = e.target.checked; }); });
  // Dragging a vanishing point (two-point keeps both on one horizon).
  $('#dz-vps').addEventListener('pointerdown', (e) => { const h = e.target.closest('[data-vp]'); if (!h || doc.grid?.lock) return; e.stopPropagation(); e.preventDefault(); const i = +h.dataset.vp;
    try { h.setPointerCapture(e.pointerId); } catch {}
    const mv = (ev) => { const r = page.getBoundingClientRect(), q = { x: (ev.clientX - r.left) / k, y: (ev.clientY - r.top) / k }; doc.grid.vp[i] = q; if (doc.grid.type === 'p2') for (const j of [1, 2]) doc.grid.vp[j].y = q.y; gridDraw(true); };
    const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); changed(true); gridDraw(); };
    h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up); });
  /* ---------- Isometric planes (as in Affinity Designer's isometric tools) ----------
     A shape is put on the top, front or side plane of the isometric grid by baking its rotation and flips into its
     outline and then skewing that outline onto the plane (l.isoP remembers which). On a plane it can be turned and
     flipped within the plane, moved to another plane, or put back flat; with "New shapes go on" set in the grid
     menu, new shapes start on that plane. Shapes only: text and pictures can't be skewed. */
  const ISO_PL = [['top', 'Top'], ['front', 'Front'], ['side', 'Side']];
  const IC = Math.cos(Math.PI / 6), IS = 0.5;
  const ISO_M = { top: [IC, -IC, IS, IS], front: [IC, 0, IS, 1], side: [IC, 0, -IS, 1] };   // [a, b, c, d]: x' = a x + b y, y' = c x + d y
  const mMul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
  const mInv = (A) => { const dt = A[0] * A[3] - A[1] * A[2]; return [A[3] / dt, -A[1] / dt, -A[2] / dt, A[0] / dt]; };
  const isoOK = (l) => l?.t === 'shape' && l.shape !== 'line' && !l.qr && !l.lock && (l.shape === 'vec' || DZ_GEN[l.shape]);
  // Applies M (about the shape's centre) to its outline, rotation and flips included, and refits its box.
  const isoXf = (l, M) => {
    if (l.shape !== 'vec') { const g = DZ_GEN[l.shape]; if (!g) return false; l.subs = JSON.parse(JSON.stringify(g(l))); l.shape = 'vec'; for (const kk of ['n', 'inner', 'th', 'path', 'r']) delete l[kk]; }
    const w = l.w, h = l.h || 1, a = (l.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), sx = l.fx ? -1 : 1, sy = l.fy ? -1 : 1;
    const R = mMul(M, [ca * sx, -sa * sy, sa * sx, ca * sy]), P = (vx, vy) => [R[0] * vx + R[1] * vy, R[2] * vx + R[3] * vy];
    const all = []; for (const sp of l.subs) for (const n of sp.nodes) {
      const [px, py] = P((n.x - 0.5) * w, (n.y - 0.5) * h), [ix, iy] = P(n.ix * w, n.iy * h), [ox, oy] = P(n.ox * w, n.oy * h);
      Object.assign(n, { _x: px, _y: py, _ix: ix, _iy: iy, _ox: ox, _oy: oy }); all.push([px, py], [px + ix, py + iy], [px + ox, py + oy]); }
    const { x0, y0, x1, y1 } = dzCurveBox(l.subs, n => ({ x: n._x, y: n._y, ix: n._ix, iy: n._iy, ox: n._ox, oy: n._oy }));   // fitted to the outline itself, so a turned circle keeps its box
    const nw = Math.max(1, x1 - x0), nh = Math.max(1, y1 - y0), cx = l.x + w / 2, cy = l.y + (l.h || 0) / 2;
    for (const sp of l.subs) for (const n of sp.nodes) { n.x = (n._x - x0) / nw; n.y = (n._y - y0) / nh; n.ix = n._ix / nw; n.iy = n._iy / nh; n.ox = n._ox / nw; n.oy = n._oy / nh;
      for (const kk of ['_x', '_y', '_ix', '_iy', '_ox', '_oy']) delete n[kk]; }
    l.x = cx + x0; l.y = cy + y0; l.w = nw; l.h = nh; l.rot = 0; l.fx = false; l.fy = false; return true; };
  const isoAct = (l, act) => { if (!isoOK(l)) return toast(l?.lock ? 'Unlock it first.' : 'Planes work on shapes (text and pictures can\'t be skewed).', 2200);
    const P = l.isoP && ISO_M[l.isoP], un = P ? mInv(P) : [1, 0, 0, 1], inP = (A) => P ? mMul(P, mMul(A, un)) : A;
    let M;
    if (ISO_M[act]) { M = mMul(ISO_M[act], un); l.isoP = act; }
    else if (act === 'flat') { if (!P) return; M = un; delete l.isoP; }
    else if (act === 'rl' || act === 'rr') { const a = (act === 'rl' ? -15 : 15) * Math.PI / 180; M = inP([Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)]); }
    else if (act === 'fh') M = inP([-1, 0, 0, 1]); else if (act === 'fv') M = inP([1, 0, 0, -1]); else return;
    if (isoXf(l, M)) { changed(true); drawSide(); } };
  /* ---------- Bend (the studio's bend tool, inside the design studio) ----------
     The same arc as the bend tool (btWarp): the width is laid along an arc of `deg` degrees, up like a rainbow or
     down like a smile, the middle keeping its length. A shape's outline is bent point by point (each curve is cut
     into short pieces first so it follows the arc smoothly) and stays an editable vector; a picture is bent into a
     new picture. The slider previews live; Apply keeps it (one undo step), Cancel puts it back. */
  const bendOK = (l) => !!l && !l.lock && ((l.t === 'shape' && l.shape !== 'line' && !l.qr && (l.shape === 'vec' || DZ_GEN[l.shape])) || (l.t === 'image' && l.ref && !l.logo));
  const bendVec = (l, deg) => { const a = Math.min(360, Math.abs(deg)) * Math.PI / 180; if (a < 0.001) return;
    isoXf(l, [1, 0, 0, 1]); delete l.isoP;   // a free shape with its turn and flips baked in
    const W = l.w, H = l.h || 1, down = deg < 0, Ri = Math.max(H * 0.05, W / a - H / 2), Ro = Ri + H;
    const map = (u, v) => { if (down) v = H - v; const f = (u / W - 0.5) * a, r = Ro - v / H * (Ro - Ri); return [r * Math.sin(f), down ? r * Math.cos(f) : -r * Math.cos(f)]; };
    /* Each edge is sampled finely, bent exactly, then refitted with as few curves as stay within a hair of the true
       bend (Schneider's fit, split in half where it isn't close enough), so a bent box keeps a handful of nodes. */
    const K = 48, tol = Math.max(0.5, 0.0006 * Math.max(W, H)), unit = (v) => { const n = Math.hypot(v[0], v[1]) || 1; return [v[0] / n, v[1] / n]; };
    const bz = (c, t) => { const u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t; return [b0 * c[0][0] + b1 * c[1][0] + b2 * c[2][0] + b3 * c[3][0], b0 * c[0][1] + b1 * c[1][1] + b2 * c[2][1] + b3 * c[3][1]]; };
    const fit = (S, T1, T2) => { const P0 = S[0], P3 = S[S.length - 1], d = [0]; for (let i = 1; i < S.length; i++) d.push(d[i - 1] + Math.hypot(S[i][0] - S[i - 1][0], S[i][1] - S[i - 1][1]));
      const tot = d[d.length - 1] || 1; let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
      for (let i = 0; i < S.length; i++) { const t = d[i] / tot, u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t, A1 = [T1[0] * b1, T1[1] * b1], A2 = [T2[0] * b2, T2[1] * b2];
        const r = [S[i][0] - (P0[0] * (b0 + b1) + P3[0] * (b2 + b3)), S[i][1] - (P0[1] * (b0 + b1) + P3[1] * (b2 + b3))];
        c00 += A1[0] * A1[0] + A1[1] * A1[1]; c01 += A1[0] * A2[0] + A1[1] * A2[1]; c11 += A2[0] * A2[0] + A2[1] * A2[1]; x0 += A1[0] * r[0] + A1[1] * r[1]; x1 += A2[0] * r[0] + A2[1] * r[1]; }
      const det = c00 * c11 - c01 * c01, dd = Math.hypot(P3[0] - P0[0], P3[1] - P0[1]); let a1 = det ? (x0 * c11 - x1 * c01) / det : 0, a2 = det ? (c00 * x1 - c01 * x0) / det : 0;
      if (!(a1 > dd * 1e-3) || !(a2 > dd * 1e-3)) a1 = a2 = dd / 3;
      const C = [P0, [P0[0] + T1[0] * a1, P0[1] + T1[1] * a1], [P3[0] + T2[0] * a2, P3[1] + T2[1] * a2], P3], F = []; for (let q = 0; q <= 60; q++) F.push(bz(C, q / 60));
      // error: each sample's distance to the fitted curve (as 60 short segments, not just its points)
      const sd = (s, p, q) => { const vx = q[0] - p[0], vy = q[1] - p[1], L2 = vx * vx + vy * vy, t = L2 ? Math.max(0, Math.min(1, ((s[0] - p[0]) * vx + (s[1] - p[1]) * vy) / L2)) : 0; return (p[0] + vx * t - s[0]) ** 2 + (p[1] + vy * t - s[1]) ** 2; };
      let err = 0; for (const s of S) { let m = Infinity; for (let q = 1; q < F.length; q++) m = Math.min(m, sd(s, F[q - 1], F[q])); err = Math.max(err, Math.sqrt(m)); } return { C, err }; };
    const fitRange = (S, i0, i1, T1, T2, out, first) => { const r = fit(S.slice(i0, i1 + 1), T1, T2);
      if (r.err <= tol || i1 - i0 <= 3) return out.push({ C: r.C, first });
      const m = (i0 + i1) >> 1, Tm = unit([S[m + 1][0] - S[m - 1][0], S[m + 1][1] - S[m - 1][1]]);
      fitRange(S, i0, m, T1, [-Tm[0], -Tm[1]], out, first); fitRange(S, m, i1, Tm, T2, out, null); };
    const subs = l.subs.map(sp => { const N = sp.nodes, P = (n) => [n.x * W, n.y * H], segN = sp.closed === false ? N.length - 1 : N.length, cs = [];
      for (let i = 0; i < segN; i++) { const A = N[i], B = N[(i + 1) % N.length], c = [P(A), [A.x * W + A.ox * W, A.y * H + A.oy * H], [B.x * W + B.ix * W, B.y * H + B.iy * H], P(B)];
        const S = []; for (let q = 0; q <= K; q++) S.push(map(...bz(c, q / K)));
        const T1 = unit([map(...bz(c, 1e-3))[0] - S[0][0], map(...bz(c, 1e-3))[1] - S[0][1]]), T2 = unit([map(...bz(c, 1 - 1e-3))[0] - S[K][0], map(...bz(c, 1 - 1e-3))[1] - S[K][1]]);
        fitRange(S, 0, K, T1, T2, cs, A.t || 'corner'); }
      const nodes = cs.map((pc, i) => { const prev = cs[i - 1] || (sp.closed === false ? null : cs[cs.length - 1]), [x, y] = pc.C[0];
        return { x, y, ix: prev ? prev.C[2][0] - x : 0, iy: prev ? prev.C[2][1] - y : 0, ox: pc.C[1][0] - x, oy: pc.C[1][1] - y, t: pc.first || 'smooth' }; });
      if (sp.closed === false && cs.length) { const lp = cs[cs.length - 1], [x, y] = lp.C[3]; nodes.push({ x, y, ix: lp.C[2][0] - x, iy: lp.C[2][1] - y, ox: 0, oy: 0, t: N[N.length - 1].t || 'corner' }); }
      return { ...sp, nodes }; });
    const { x0, y0, x1, y1 } = dzCurveBox(subs, n => n);
    const nw = Math.max(1, x1 - x0), nh = Math.max(1, y1 - y0), cx = l.x + W / 2, cy = l.y + H / 2;
    for (const sp of subs) for (const n of sp.nodes) { n.x = (n.x - x0) / nw; n.y = (n.y - y0) / nh; n.ix /= nw; n.iy /= nh; n.ox /= nw; n.oy /= nh; }
    l.subs = subs; l.w = nw; l.h = nh; l.x = cx - nw / 2; l.y = cy - nh / 2; };
  let bendS = null;   // { l, snap, deg, img }
  const bendClose = (keep) => { const b = bendS; bendS = null; $('#dz-bend')?.remove(); if (!b) return;
    if (!keep) { for (const kk of Object.keys(b.l)) delete b.l[kk]; Object.assign(b.l, JSON.parse(b.snap)); redraw(); drawSide(); } };
  const bendOpen = async (l) => { if (!bendOK(l)) return toast(l?.lock ? 'Unlock it first.' : 'Bend works on shapes and pictures.', 1800);
    if (l.t === 'image' && (l.crop || l.rot || l.fx || l.fy || (l.op ?? 1) < 1)) return toast('Flatten the picture first (in this strip), so the bend uses what you see.', 3500);
    bendClose(false); bendS = { l, snap: JSON.stringify(l), deg: 0, img: l.t === 'image' ? await dzImg(l.ref) : null };
    if (l.t === 'image' && !bendS.img) { bendS = null; return toast('Could not load that picture.'); }
    const d = document.createElement('div'); d.id = 'dz-bend'; d.className = 'dz-bendp';
    d.innerHTML = `<div class="row" style="align-items:center;gap:6px"><b style="flex:1">Bend <span class="muted" data-bl>Straight</span></b><button class="btn small" data-bx="0">Cancel</button><button class="btn small primary" data-bx="1">Apply</button></div>
      <input type="range" min="-360" max="360" step="1" value="0" data-bd style="width:100%;accent-color:var(--teal)">
      <div class="bt-fine">${[[-5, '−5'], [-1, '−1'], [0, 'Straight'], [1, '+1'], [5, '+5']].map(([v, n]) => `<button class="btn small" data-bf="${v}">${n}</button>`).join('')}</div>
      ${bendS.img ? '<canvas class="dz-bendpv"></canvas>' : ''}<p class="muted" style="font-size:11px;margin:6px 0 0">Up bends like a rainbow, down like a smile. ${bendS.img ? 'The picture is redrawn bent when you apply.' : 'The shape stays editable.'}</p>`;
    $('.dz-ed').appendChild(d); if (innerWidth <= 700) { const r = $('#dz-ctx').getBoundingClientRect(); d.style.top = (r.bottom + 6) + 'px'; }   /* phones: under the strip (the side sheet is at the bottom); otherwise along the bottom, clear of the design */
    const set = (v) => { const b = bendS; if (!b) return; b.deg = Math.max(-360, Math.min(360, Math.round(v))); d.querySelector('[data-bd]').value = b.deg; d.querySelector('[data-bl]').textContent = btLabel(b.deg);
      if (b.img) { const c = d.querySelector('.dz-bendpv'), w = btWarp(b.img, b.deg, 320); c.width = w.width; c.height = w.height; c.getContext('2d').drawImage(w, 0, 0); return; }
      for (const kk of Object.keys(b.l)) delete b.l[kk]; Object.assign(b.l, JSON.parse(b.snap)); bendVec(b.l, b.deg); redraw(); placeSel(); };
    d.oninput = (e) => { if (e.target.matches('[data-bd]')) set(+e.target.value); };
    d.onclick = async (e) => { const f = e.target.closest('[data-bf]'); if (f) return set(+f.dataset.bf === 0 ? 0 : bendS.deg + +f.dataset.bf);
      const x = e.target.closest('[data-bx]'); if (!x) return; if (x.dataset.bx === '0') return bendClose(false);
      const b = bendS; if (!b.deg) return bendClose(false);
      if (b.img) { const im = b.img, s = Math.min(1, 2400 / Math.max(im.naturalWidth, im.naturalHeight)), out = btWarp(im, b.deg, 2400), per = b.l.w / (im.naturalWidth * s), cx = b.l.x + b.l.w / 2, cy = b.l.y + b.l.h / 2;
        b.l.ref = await Media.save(await new Promise(res => out.toBlob(res, 'image/png')), 'png'); b.l.w = out.width * per; b.l.h = out.height * per; b.l.x = cx - b.l.w / 2; b.l.y = cy - b.l.h / 2; }
      bendClose(true); changed(true); drawSide(); };
    set(0); };
  /* ---------- Adjust colour (pictures), as in the simulator ----------
     The picture previews live on the design (a smaller copy stands in while the sliders move); Apply makes the full
     size picture with the change (one undo step), Cancel puts the original back. Vector shapes keep their own colours. */
  const adjClose = (keep) => { const A = adjS; adjS = null; $('#dz-adj')?.remove(); if (!A) return; cancelAnimationFrame(A.raf); DZI.delete(A.tmp);
    if (!keep) { A.l.ref = A.ref; redraw(); } };
  const adjOpen = async (l) => { if (!l || l.t !== 'image' || !l.ref) return toast('Adjust colour works on pictures.', 1800); if (l.lock) return toast('Unlock it first.');
    adjClose(false); bendClose(false); const im = await dzImg(l.ref); if (!im) return toast('Could not load that picture.');
    const nw = im.naturalWidth, nh = im.naturalHeight, s = Math.min(1, 1200 / Math.max(nw, nh)), pv = document.createElement('canvas'); pv.width = Math.max(1, Math.round(nw * s)); pv.height = Math.max(1, Math.round(nh * s));
    const pg = pv.getContext('2d', { willReadFrequently: true }); pg.drawImage(im, 0, 0, pv.width, pv.height); Object.defineProperty(pv, 'naturalWidth', { value: pv.width }); Object.defineProperty(pv, 'naturalHeight', { value: pv.height });
    const tmp = 'adj:' + l.id; DZI.set(tmp, pv);
    adjS = { l, ref: l.ref, im, pv, tmp, orig: pg.getImageData(0, 0, pv.width, pv.height), out: pg.createImageData(pv.width, pv.height), v: { ...DZ_ADJ0 }, raf: 0 }; l.ref = tmp;
    const f2 = (v) => Math.round(v * 100) + '%', d = document.createElement('div'); d.id = 'dz-adj'; d.className = 'dz-bendp dz-adjp';
    const draw = () => { d.innerHTML = `<div class="row" style="align-items:center;gap:6px"><b style="flex:1">Adjust colour</b><button class="btn small" data-ax="reset">Reset</button><button class="btn small" data-ax="0">Cancel</button><button class="btn small primary" data-ax="1">Apply</button></div>
      ${DZ_ADJ.map(([k2, n2, mn, mx, st2, fm]) => `<label class="dz-sl" style="margin:3px 0"><span>${n2}<b>${(fm || f2)(adjS.v[k2])}</b></span><input type="range" min="${mn}" max="${mx}" step="${st2}" value="${adjS.v[k2]}" data-adj="${k2}"></label>`).join('')}
      <p class="muted" style="font-size:11px;margin:4px 0 0">Previewed on the design; Apply keeps it (Undo takes it back).</p>`; };
    const run = () => { const A = adjS; if (!A || A.raf) return; A.raf = requestAnimationFrame(() => { A.raf = 0; if (adjS !== A) return; dzAdjust(A.orig, A.out, A.v); A.pv.getContext('2d').putImageData(A.out, 0, 0); redraw(); }); };
    d.oninput = (e) => { const k2 = e.target.dataset.adj; if (!k2 || !adjS) return; adjS.v[k2] = +e.target.value; const fm = DZ_ADJ.find(x => x[0] === k2)[5] || f2; e.target.closest('label').querySelector('b').textContent = fm(adjS.v[k2]); run(); };
    d.onclick = async (e) => { const a = e.target.closest('[data-ax]')?.dataset.ax; if (!a || !adjS) return; const A = adjS;
      if (a === 'reset') { A.v = { ...DZ_ADJ0 }; draw(); return run(); }
      if (a === '0') return adjClose(false);
      if (Object.keys(DZ_ADJ0).every(k2 => A.v[k2] === DZ_ADJ0[k2])) return adjClose(false);
      e.target.disabled = true; const s2 = Math.min(1, 4096 / Math.max(A.im.naturalWidth, A.im.naturalHeight)), c = document.createElement('canvas'); c.width = Math.round(A.im.naturalWidth * s2); c.height = Math.round(A.im.naturalHeight * s2);
      const g = c.getContext('2d'); g.drawImage(A.im, 0, 0, c.width, c.height); const src = g.getImageData(0, 0, c.width, c.height), dst = g.createImageData(c.width, c.height); dzAdjust(src, dst, A.v); g.putImageData(dst, 0, 0);
      const ref = await Media.save(await new Promise(r => c.toBlob(r, 'image/png')), 'png'); A.l.ref = ref; adjClose(true); changed(true); drawSide(); toast('Colour adjusted.', 1400); };
    draw(); $('.dz-ed').appendChild(d); { const r = $('#dz-ctx').getBoundingClientRect(); d.style.top = (r.bottom + 6) + 'px'; } redraw(); };   /* over the side panel, top right, so the picture stays in view */
  /* ---------- Reference pictures (as in the simulator) ----------
     Pictures that float over the design to follow: one finger moves one, two fingers move, size and turn it together,
     a corner sizes it, the dot turns it, a double tap flips it. In the panel each can be hidden, locked (so you work
     straight through it), faded or removed. Never part of the design: not printed, exported or undone. Kept with
     each design in the setting dz_refs_<id>. */
  const refLay = $('#dz-refs'); let refs = (() => { try { return JSON.parse(Settings.get('dz_refs_' + id, '[]')).filter(Boolean); } catch { return []; } })(), refSel = null, refSaveT = 0;
  const refSave = () => { clearTimeout(refSaveT); refSaveT = setTimeout(() => Settings.set('dz_refs_' + id, JSON.stringify(refs.map(({ _u, ...r }) => r))), 400); };
  const refUrl = async (r) => r._u ||= await Media.url(r.ref);
  async function drawRefs() { for (const r of refs) await refUrl(r);
    const sr = stage.getBoundingClientRect(), rb = $('#dz-rail [data-rail="refs"]'); if (rb) rb.hidden = !refs.length;
    refLay.innerHTML = refs.filter(r => r.on).map(r => { r.x = Math.max(20, Math.min(sr.width - 20, r.x)); r.y = Math.max(20, Math.min(sr.height - 20, r.y));
      return `<div class="tt-ref ${r.lock ? 'lock' : ''} ${refSel === r.id && !r.lock ? 'sel' : ''}" data-rf="${r.id}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.w * r.ar}px;opacity:${r.op};transform:translate(-50%,-50%) rotate(${r.rot || 0}deg)">
        <img src="${r._u}" alt="" draggable="false" style="${r.flip ? 'transform:scaleX(-1);' : ''}${r.bw ? 'filter:grayscale(1)' : ''}">${refSel === r.id && !r.lock ? '<i data-rh="nw"></i><i data-rh="ne"></i><i data-rh="sw"></i><i data-rh="se"></i><i data-rh="rot"></i>' : ''}</div>`; }).join(''); }
  const refNew = (o) => { const sr = stage.getBoundingClientRect(); const r = { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), x: Math.round(Math.max(170, sr.width * 0.3)), y: Math.round(Math.max(170, sr.height * 0.4)), w: 220, ar: 1, rot: 0, flip: false, op: 0.9, on: true, lock: false, ...o };
    refs.push(r); refSel = r.id; refSave(); drawRefs(); tab = 'refs'; drawSide(); toast('Reference added: drag to move, pinch or a corner to size, the dot to turn.', 2600); return r; };
  // Where a picture goes: into the design, or floating over it as a reference.
  const picWhere = () => new Promise((res) => { const o = document.createElement('div'); o.id = 'merge-dlg'; o.style.zIndex = 99;
    o.innerHTML = `<div class="card"><h2>Add this picture</h2><div class="dz-ex">
      <button data-pw="design"><b>Into the design</b><small>Part of the design: printed and exported</small></button>
      <button data-pw="ref"><b>As a reference</b><small>Floats over the design to follow: move, size, turn, fade or hide it. Never printed</small></button></div>
      <button class="btn" data-pw="" style="width:100%;margin-top:10px">Cancel</button></div>`;
    o.onclick = (e) => { const b = e.target.closest('[data-pw]'); if (!b && e.target !== o) return; o.remove(); res(b?.dataset.pw || null); }; document.body.appendChild(o); });
  const refAdd = async (src) => { let ref = null, ar = 1;
    if (src === 'file') { const f = await new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => res(i.files[0] || null); i.click(); });
      if (f) { try { const p = await importPic(f, 2000); ref = p.ref; ar = 1 / p.ar; } catch { return toast('Could not read that picture.'); } } }
    else { ref = await dzPortfolioPick(src === 'refs' ? 'refs' : src === 'sten' ? 'sten' : true); if (ref) { const im = await dzImg(ref); ar = im ? im.naturalHeight / im.naturalWidth : 1; } }
    if (ref) refNew({ ref, ar }); };
  const drawRefsSide = async () => { const us = await Promise.all(refs.map(refUrl));
    side.innerHTML = `<div class="dz-lh"><b>References <small>${refs.length}</small></b>${dzIB('data-rail="close"', 'close', 'Close')}</div>
      <div class="tt-layers">${refs.map((r, i) => `<div class="tt-lr tt-rr ${refSel === r.id ? 'on' : ''}" data-rid="${r.id}"><img src="${us[i] || ''}" alt="" style="${r.bw ? 'filter:grayscale(1)' : ''}">
        <button class="dz-ib" data-rhide data-tip="${r.on ? 'Hide' : 'Show'}" aria-label="${r.on ? 'Hide' : 'Show'}">${r.on ? '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9 9 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.6 6.6C3.8 8.3 2 12 2 12s4 7 10 7a9 9 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'}</button>
        <button class="dz-ib ${r.lock ? 'on' : ''}" data-rlock data-tip="${r.lock ? 'Unlock' : 'Lock: work straight through it'}" aria-label="Lock">${r.lock ? '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' : '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>'}</button>
        <button class="dz-ib" data-rflip data-tip="Flip" aria-label="Flip"><svg viewBox="0 0 24 24">${DZ_UI.fx}</svg></button>
        <button class="dz-ib ${r.bw ? 'on' : ''}" data-rbw data-tip="${r.bw ? 'Back to colour' : 'Black and white: see the values without the colour'}" aria-label="Black and white"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg></button>
        <button class="dz-ib" data-rdel data-tip="Remove" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <input type="range" min="0.1" max="1" step="0.05" value="${r.op}" data-rop aria-label="See-through"></div>`).join('') || '<p class="muted" style="margin:4px 2px">No references yet.</p>'}</div>
      <div class="lbl" style="margin-top:10px">Add a picture</div>
      <div class="tt-addr"><button class="btn small" data-radd="file">This device</button><button class="btn small" data-radd="refs">References</button><button class="btn small" data-radd="sten">Stencils</button><button class="btn small" data-radd="pf">Portfolio</button></div>
      <p class="muted dz-hint">Drag to move; pinch, or a corner, to size; the dot turns it; double tap flips it. Locked ones let you work straight through. References are never printed or exported.</p>`;
    drawSide2(); };
  const drawSide2 = () => { const h = side.querySelector('.dz-lh'); if (h && !h.querySelector('[data-collapse]')) h.insertAdjacentHTML('beforeend', dzIB('data-collapse', 'chev', mini ? 'Show the panel' : 'Fold the panel away', 'dz-fold')); };
  side.addEventListener('click', async (e) => { if (tab !== 'refs') return; const t = e.target, rid = t.closest('[data-rid]')?.dataset.rid;
    if (rid) { const r = refs.find(x => x.id === rid); if (!r) return; e.stopPropagation();
      if (t.closest('[data-rhide]')) r.on = !r.on; else if (t.closest('[data-rlock]')) { r.lock = !r.lock; if (r.lock && refSel === r.id) refSel = null; }
      else if (t.closest('[data-rflip]')) r.flip = !r.flip; else if (t.closest('[data-rbw]')) r.bw = !r.bw; else if (t.closest('[data-rdel]')) refs = refs.filter(x => x !== r); else if (!t.matches('input')) { refSel = r.id; r.on = true; } else return;
      refSave(); drawRefs(); return drawRefsSide(); }
    const ad = t.closest('[data-radd]'); if (ad) { e.stopPropagation(); return refAdd(ad.dataset.radd); } }, true);
  side.addEventListener('input', (e) => { if (tab !== 'refs' || !e.target.matches('[data-rop]')) return; const r = refs.find(x => x.id === e.target.closest('[data-rid]').dataset.rid); if (!r) return; r.op = +e.target.value; refSave();
    const el = refLay.querySelector(`[data-rf="${r.id}"]`); if (el) el.style.opacity = r.op; });
  // The gestures, as in the simulator: the picture is moved in place while fingers are down, never rebuilt.
  let refG = null, refTap = null; const refPts = new Map(), refPos = (e) => { const sr = stage.getBoundingClientRect(); return { x: e.clientX - sr.left, y: e.clientY - sr.top }; };
  const refPlace = (r) => { const el = refLay.querySelector(`[data-rf="${r.id}"]`); if (!el) return; el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.w * r.ar + 'px'; el.style.transform = `translate(-50%,-50%) rotate(${r.rot || 0}deg)`; };
  const refStart = () => { const r = refG.r, p = [...refPts.values()]; Object.assign(refG, { x0: r.x, y0: r.y, w0: r.w, rot0: r.rot || 0, p0: p.map(q => ({ ...q })) });
    if (refG.h && p.length === 1) { refG.d0 = Math.max(1, Math.hypot(p[0].x - r.x, p[0].y - r.y)); refG.a0 = Math.atan2(p[0].y - r.y, p[0].x - r.x) - (r.rot || 0) * Math.PI / 180; } };
  const refDown = (e, r, h) => { e.stopPropagation(); e.preventDefault(); try { refLay.setPointerCapture(e.pointerId); } catch {} refPts.set(e.pointerId, refPos(e));
    if (!refG) refG = { r, h, t: Date.now(), moved: false }; else refG.h = null; refStart(); };
  refLay.addEventListener('pointerdown', (e) => { const el = e.target.closest('[data-rf]'); if (!el) return; const r = refs.find(x => x.id === el.dataset.rf); if (!r || r.lock) return;
    if (refG && refG.r !== r) return; if (refSel !== r.id) { refSel = r.id; drawRefs(); } refDown(e, r, e.target.dataset.rh); });
  stage.addEventListener('pointerdown', (e) => { if (refG && refPts.size === 1 && e.pointerType === 'touch' && !e.target.closest('[data-rf]')) refDown(e, refG.r, null); }, true);
  const refMove = (e) => { if (!refG || !refPts.has(e.pointerId)) return; refPts.set(e.pointerId, refPos(e)); const g = refG, r = g.r, p = [...refPts.values()];
    if (Math.hypot(p[0].x - g.p0[0].x, p[0].y - g.p0[0].y) > 6) g.moved = true;
    if (p.length >= 2 && g.p0.length >= 2) { const [a0, b0] = g.p0, [a, b] = p, m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }, m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y)), da = Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x), c = Math.cos(da), sn = Math.sin(da);
      const ox = (g.x0 - m0.x) * s, oy = (g.y0 - m0.y) * s; r.w = Math.max(40, g.w0 * s); r.x = m.x + ox * c - oy * sn; r.y = m.y + ox * sn + oy * c;
      let deg = g.rot0 + da * 180 / Math.PI; const q = Math.round(deg / 90) * 90; if (Math.abs(deg - q) < 3) deg = q; r.rot = Math.round(deg * 10) / 10; g.moved = true; }
    else if (!g.h) { r.x = g.x0 + p[0].x - g.p0[0].x; r.y = g.y0 + p[0].y - g.p0[0].y; }
    else if (g.h === 'rot') { let a = (Math.atan2(p[0].y - r.y, p[0].x - r.x) - g.a0) * 180 / Math.PI; const q = Math.round(a / 90) * 90; if (Math.abs(a - q) < 5) a = q; r.rot = Math.round(a); }
    else r.w = Math.max(40, g.w0 * Math.hypot(p[0].x - r.x, p[0].y - r.y) / g.d0);
    refPlace(r); };
  const refUp = (e) => { if (!refG || !refPts.has(e.pointerId)) return; refPts.delete(e.pointerId); if (refPts.size) { refG.h = null; return refStart(); }
    const g = refG; refG = null; const now = Date.now();
    if (!g.moved && !g.h && now - g.t < 300) { if (refTap && refTap.id === g.r.id && now - refTap.t < 350) { g.r.flip = !g.r.flip; refTap = null; } else refTap = { id: g.r.id, t: now }; } else refTap = null;
    refSave(); drawRefs(); if (tab === 'refs') drawRefsSide(); };
  refLay.addEventListener('pointermove', refMove); stage.addEventListener('pointermove', (e) => { if (refG && !refLay.hasPointerCapture?.(e.pointerId)) refMove(e); }, true);
  for (const n of ['pointerup', 'pointercancel']) { refLay.addEventListener(n, refUp); stage.addEventListener(n, (e) => { if (refG && refPts.has(e.pointerId) && !refLay.hasPointerCapture?.(e.pointerId)) refUp(e); }, true); }
  page.addEventListener('pointerdown', () => { if (refSel && !refG) { refSel = null; drawRefs(); } }, true);
  drawRefs();
  /* ---------- Quick strip (as in the tattoo simulator) ----------
     A row of shortcuts across the top of the page. Its + window picks tools, actions on what's selected (they
     work through the context strip's own buttons, so they behave exactly the same), favourite colours (up to 8)
     and favourite fonts (up to 5). Kept for every design (setting dz_strip). */
  const DQ_SVG = { undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>', redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>', fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' };
  const DQ_TOOLS = [['select', 'select', 'Select and move'], ['text', 'text', 'Text'], ['image', 'picture', 'Picture'], ['shape', 'shape', 'Shape'], ['pen', 'pen', 'Pen'], ['pencil', 'pencil', 'Pencil'],
    ['layers', 'layers', 'Layers'], ['doc', 'page', 'Page: theme, background and sides'], ['refs', '<rect x="3" y="6" width="13" height="11" rx="1.5"/><path d="M8 3h13v11"/><circle cx="7.5" cy="10" r="1.5"/><path d="M16 15l-4-4-6 6"/>', 'Reference pictures'], ['undo', DQ_SVG.undo, 'Undo'], ['redo', DQ_SVG.redo, 'Redo'], ['fit', DQ_SVG.fit, 'Show the whole design'], ['export', 'export', 'Export'], ['grid', '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>', 'Grid and perspective']];
  const DQ_ACTS = [['dup', 'copy', 'Duplicate'], ['del', 'del', 'Delete'], ['up', 'fwd', 'Bring forward'], ['down', 'back', 'Send back'], ['fx', 'fx', 'Flip left to right'], ['fy', 'fy', 'Flip upside down'],
    ['lock', 'lock', 'Lock or unlock'], ['crop', 'crop', 'Crop'], ['cut', 'area', 'Select area'], ['nodes', 'nodes', 'Edit nodes'], ['flatten1', 'flatten', 'Flatten into a picture'], ['bend', '<path d="M3 16c4-8 14-8 18 0"/><path d="M6 19c3-5 9-5 12 0"/>', 'Bend into an arc'], ['adjc', '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M12 4a8 8 0 0 1 0 16"/>', 'Adjust colour (pictures)'],
    ...AL.map(([a, tp, ic]) => ['al:' + a, ic, 'Align: ' + tp]), ...['add', 'subtract', 'intersect', 'contour'].map(v => ['bool:' + v, DZ_BOOL_ICON[v], { add: 'Add: weld into one outline', subtract: 'Subtract', intersect: 'Intersect', contour: 'Contour' }[v]])];
  const DQ_DEF = ['select', 'text', 'image', 'shape', 'undo', 'redo'], DQ_CMAX = 8, DQ_FMAX = 5;
  const dqIcon = (ic) => String(ic).startsWith('<svg') ? ic : `<svg viewBox="0 0 24 24">${DZ_UI[ic] || ic}</svg>`;
  const dqList = () => { try { const a = JSON.parse(Settings.get('dz_strip', 'null')); return Array.isArray(a) ? a : DQ_DEF; } catch { return DQ_DEF; } };
  const dqFont = (v) => { const s = document.createElement('select'); s.innerHTML = fontOpts(v); return s.selectedOptions[0]?.textContent || v; };
  function dqDraw() { const el = $('#dz-qstrip'); if (!el) return; let last = '', fdone = false;
    const on = { select: !toolOn() && tab === 'edit', pen: penOn, pencil: pclOn, layers: tab === 'layers', doc: tab === 'doc', grid: !!doc.grid?.on };
    const html = dqList().map(id => { const grp = id.startsWith('c:') ? 'c' : id.startsWith('f:') ? 'f' : DQ_ACTS.some(x => x[0] === id) ? 'a' : 't', sep = last && last !== grp ? '<i class="tt-qsep"></i>' : ''; last = grp;
      if (grp === 'c') return sep + `<button class="tt-qb dz-qc" data-dq="${esc(id)}" data-tip="Colour ${esc(id.slice(2))}: on what's selected" aria-label="Colour ${esc(id.slice(2))}"><i style="background:${esc(id.slice(2))}"></i></button>`;
      if (grp === 'f') { if (fdone) return ''; fdone = true; return sep + `<button class="tt-qb dz-qf" data-dq="fonts" data-tip="Your fonts: pick one for the selected text" aria-label="Your fonts"><b>Aa</b><svg viewBox="0 0 24 24" style="width:10px;height:10px"><path d="M6 9l6 6 6-6"/></svg></button>`; }
      const it = [...DQ_TOOLS, ...DQ_ACTS].find(x => x[0] === id); if (!it) return '';
      return sep + `<button class="tt-qb${on[id] ? ' on' : ''}" data-dq="${id}" data-tip="${esc(it[2])}" aria-label="${esc(it[2])}">${dqIcon(it[1])}</button>`; }).join('')
      + `<i class="tt-qsep"></i><button class="tt-qb tt-qadd" data-dq="add" data-tip="Choose what this strip shows" aria-label="Customise the strip"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
    if (el.innerHTML !== html && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } }   /* rebuilt only when it changes, so a tap's button is still there for its click */
  const dqApply = (key, v) => { const L = many() ? picked() : layer() ? [layer()] : []; if (!L.length) return toast('Select something first.', 1500);
    let n = 0; for (const l of L) { if (l.lock) continue;
      if (key === 'font') { if (l.t === 'text' || l.t === 'field') { l.font = v; n++; } }
      else if (l.t === 'text' || l.t === 'field') { l.c = v; if (l.t === 'text') l.fm = 'solid'; n++; } else if (l.t === 'shape') { if (l.shape === 'line') l.fill = v; else { l.fill = v; l.fm = 'solid'; } n++; } }
    if (!n) return toast(key === 'font' ? 'Fonts go on text.' : 'Colours go on text and shapes.', 1600); changed(true); drawSide(); };
  // A press on the strip is the strip's: the page behind must not take it (it would select, deselect or start a drag).
  $('#dz-qstrip').addEventListener('pointerdown', (e) => e.stopPropagation());
  $('#dz-qstrip').addEventListener('click', (e) => { const b = e.target.closest('[data-dq]'); if (!b) return; const q = b.dataset.dq;
    if (q === 'add') return dqEdit();
    if (q.startsWith('c:')) return dqApply('colour', q.slice(2)); if (q.startsWith('f:')) return dqApply('font', q.slice(2));
    if (q === 'fonts') { const fam = (v) => "'" + (v === '@1' || v === '@2' ? (DZ_THEMES[doc.theme] || DZ_THEMES.ink)['f' + v[1]] : v).replace(/'/g, '') + "'";
      return stripMenu(b, dqList().filter(x => x.startsWith('f:')).map(x => { const v = x.slice(2); return [v, dqFont(v), fam(v)]; }), 'Your fonts').then(v => { if (v) dqApply('font', v); }); }
    if (q === 'undo' || q === 'redo') return undo(q === 'undo' ? -1 : 1);
    if (q === 'fit') return $('.dz-ed .dz-zoom [data-z="fit"]')?.click(); if (q === 'export') return $('#dz-export').click();
    if (q === 'pen' || q === 'pencil') return $(`#dz-rail [data-add="${q}"]`)?.click();
    if (DQ_TOOLS.some(x => x[0] === q)) return $(`#dz-rail [data-rail="${q}"]`)?.click();
    const sel2 = q === 'bend' ? '[data-bend]' : q === 'adjc' ? '[data-adjc]' : q.startsWith('al:') ? `[data-align="${q.slice(3)}"]` : q.startsWith('bool:') ? `[data-bool="${q.slice(5)}"]` : `[data-act="${q}"], [data-mact="${q}"]`;
    const t = $('#dz-ctx').querySelector(sel2); if (!t) return toast(layer() || many() ? 'Not for this item.' : 'Select something first.', 1500); if (t.disabled) return toast('Not right now: select more, or something else.', 1600); t.click(); });
  const dqEdit = () => { let list = dqList().slice(), tab2 = 'tools', addC = '#1fb6a6', addF = ''; const o = document.createElement('div'); o.id = 'dz-qsedit';
    o.style.cssText = 'position:fixed;inset:0;z-index:110;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.55)';
    const row = (id, ic, nm) => `<button class="tt-qrow${list.includes(id) ? ' on' : ''}" data-qi="${esc(id)}"><span class="tt-qri">${dqIcon(ic)}</span><span>${esc(nm)}</span><i class="tt-qsw"></i></button>`;
    const cols = () => list.filter(x => x.startsWith('c:')), fonts = () => list.filter(x => x.startsWith('f:'));
    const draw = () => { const body = tab2 === 'tools' ? `<div class="tt-qrows">${DQ_TOOLS.map(([id, ic, nm]) => row(id, ic, nm)).join('')}</div>`
        : tab2 === 'acts' ? `<p class="muted" style="font-size:12px;margin:0 2px 6px">These work on what's selected, like the strip under the top bar.</p><div class="tt-qrows">${DQ_ACTS.map(([id, ic, nm]) => row(id, ic, nm)).join('')}</div>`
        : tab2 === 'cols' ? `<p class="muted" style="font-size:12px;margin:0 2px 6px">Tap one on the strip to colour what's selected (text, or a shape's fill). Up to ${DQ_CMAX} (${cols().length} / ${DQ_CMAX}).</p>
            <div class="tt-qadd2"><input type="color" data-qcol value="${addC}" style="width:48px;height:34px;padding:0;border:0;background:none"><span class="muted" style="flex:1">${esc(addC)}</span><button class="btn small primary" data-qe="addc">Add</button></div>
            <div class="tt-qrows">${cols().map(id => `<div class="tt-qrow on"><span class="tt-qri"><i class="dz-qcdot" style="background:${esc(id.slice(2))}"></i></span><span>${esc(id.slice(2))}</span><button class="mini" data-qdel="${esc(id)}" aria-label="Remove">✕</button></div>`).join('') || '<p class="muted" style="font-size:12px;margin:8px 2px">No colours yet.</p>'}</div>`
        : `<p class="muted" style="font-size:12px;margin:0 2px 6px">They share one Aa button on the strip: tap it, then a font, to set the font of the selected text. Up to ${DQ_FMAX} (${fonts().length} / ${DQ_FMAX}).</p>
            <div class="tt-qadd2"><select class="in" data-qfont>${fontOpts(addF)}</select><button class="btn small primary" data-qe="addf">Add</button></div>
            <div class="tt-qrows">${fonts().map(id => `<div class="tt-qrow on"><span class="tt-qri"><b>Aa</b></span><span>${esc(dqFont(id.slice(2)))}</span><button class="mini" data-qdel="${esc(id)}" aria-label="Remove">✕</button></div>`).join('') || '<p class="muted" style="font-size:12px;margin:8px 2px">No fonts yet.</p>'}</div>`;
      o.innerHTML = `<div class="card tt-qse"><div class="row" style="align-items:center;gap:6px"><h2 style="margin:0;flex:1">Quick strip</h2><button class="btn small" data-qe="reset">Default</button><button class="btn small primary" data-qe="done">Done</button></div>
        <div class="tt-ftabs" style="margin:10px 0 8px">${[['tools', 'Tools'], ['acts', 'Actions'], ['cols', 'Colours'], ['fonts', 'Fonts']].map(([k2, n]) => `<button data-qt="${k2}" class="${tab2 === k2 ? 'on' : ''}">${n}</button>`).join('')}</div>${body}</div>`;
      if (tab2 === 'fonts') { const s = o.querySelector('[data-qfont]'); addF = s.value; } };
    const order = () => [...DQ_TOOLS, ...DQ_ACTS].map(x => x[0]).filter(x => list.includes(x)).concat(cols(), fonts());
    o.onclick = async (e) => { const t2 = e.target.closest('[data-qt]'); if (t2) { tab2 = t2.dataset.qt; return draw(); }
      const i = e.target.closest('[data-qi]'); if (i) { const id = i.dataset.qi; list = list.includes(id) ? list.filter(x => x !== id) : [...list, id]; list = order(); i.classList.toggle('on'); return; }
      const dl = e.target.closest('[data-qdel]'); if (dl) { list = list.filter(x => x !== dl.dataset.qdel); return draw(); }
      const a = e.target.closest('[data-qe]')?.dataset.qe;
      if (a === 'addc') { const id = 'c:' + addC; if (list.includes(id)) return toast('That colour is already there.', 1500); if (cols().length >= DQ_CMAX) return toast(`Up to ${DQ_CMAX} colours: remove one first.`, 1800); list = [...list, id]; return draw(); }
      if (a === 'addf') { const id = 'f:' + addF; if (!addF || addF[0] === '+') return toast('Pick a font from the list.', 1500); if (list.includes(id)) return toast('That font is already there.', 1500); if (fonts().length >= DQ_FMAX) return toast(`Up to ${DQ_FMAX} fonts: remove one first.`, 1800); list = [...list, id]; return draw(); }
      if (a === 'reset') { list = DQ_DEF.slice(); return draw(); }
      if (a === 'done' || e.target === o) { await Settings.set('dz_strip', JSON.stringify(order())); o.remove(); dqDraw(); } };
    o.oninput = (e) => { if (e.target.matches('[data-qcol]')) { addC = e.target.value; const s = e.target.nextElementSibling; if (s) s.textContent = addC; } };
    o.onchange = (e) => { if (e.target.matches('[data-qfont]')) addF = e.target.value; };
    draw(); document.body.appendChild(o); };
  /* ---------- Panels: hide or show each one, or all at once (Focus), as in the simulator ----------
     Kept in the setting dz_panels (a list of hidden panel names). */
  const DPANELS = [['qs', 'Quick strip'], ['rail', 'Tools'], ['ctx', 'Selection strip'], ['side', 'Side panel'], ['zoom', 'Zoom'], ['refs', 'Reference pictures']];
  let dpHide = (() => { try { return new Set(JSON.parse(Settings.get('dz_panels', '[]'))); } catch { return new Set(); } })();
  const dpApply = () => { const ed = $('.dz-ed'); if (!ed) return; ed.dataset.hide = [...dpHide].join(' '); Settings.set('dz_panels', JSON.stringify([...dpHide]));
    const f = $('#dz-hide'), all = DPANELS.every(([k2]) => dpHide.has(k2)); if (f) { f.classList.toggle('on', all); f.dataset.tip = all ? 'Show all the panels' : 'Focus: hide all the panels'; } };
  $('#dz-hide').onclick = () => { const all = DPANELS.every(([k2]) => dpHide.has(k2)); dpHide = all ? new Set() : new Set(DPANELS.map(([k2]) => k2)); closePop(); dpApply(); };
  $('#dz-panels').onclick = (e) => { e.stopPropagation(); let m = $('#dz-panm'); if (m) return m.remove(); m = document.createElement('div'); m.id = 'dz-panm'; m.className = 'tt-panm';
    const draw = () => { m.innerHTML = `<div class="gh">Panels</div>${DPANELS.map(([k2, n]) => `<button class="tt-qrow${dpHide.has(k2) ? '' : ' on'}" data-pn="${k2}"><span>${n}</span><i class="tt-qsw"></i></button>`).join('')}
      <div class="row" style="gap:6px;margin-top:6px"><button class="btn small" data-pall="hide" style="flex:1">Hide all</button><button class="btn small" data-pall="show" style="flex:1">Show all</button></div>`; };
    m.onclick = (ev) => { ev.stopPropagation(); const p = ev.target.closest('[data-pn]')?.dataset.pn; if (p) { if (dpHide.has(p)) dpHide.delete(p); else dpHide.add(p); dpApply(); return draw(); }
      const a = ev.target.closest('[data-pall]')?.dataset.pall; if (a) { dpHide = a === 'hide' ? new Set(DPANELS.map(([k2]) => k2)) : new Set(); dpApply(); draw(); } };
    draw(); document.body.appendChild(m); const r = $('#dz-panels').getBoundingClientRect(); m.style.top = (r.bottom + 6) + 'px'; m.style.right = Math.max(8, innerWidth - r.right) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!ev.target.closest('#dz-panm, #dz-panels')) { m.remove(); document.removeEventListener('pointerdown', off, true); } }, true)); };
  dpApply(); dqDraw();
  $('#dz-export').onclick = () => { select(null); dzExport(doc, name); };
  dzRO = new ResizeObserver(() => { fit(); redraw(); }); dzRO.observe(stage);
  fit(); drawSide(); await redraw();
  if (!row.thumb_ref) { dirty = true; flush(); }
};

// Font file (.ttf .otf .woff .woff2) kept with the workspace; Android's file picker needs the wide accept list.
function dzImportFont() {
  return new Promise((res) => {
    const i = document.createElement('input'); i.type = 'file';
    i.accept = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2,application/font-sfnt,application/x-font-ttf,application/octet-stream';
    i.onchange = async () => {
      const f = i.files[0]; if (!f) return res(null);
      try {
        const name = f.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ').trim();
        const buf = await f.arrayBuffer(), ff = new FontFace(name, buf); await ff.load(); document.fonts.add(ff);
        const ref = await Media.save(new Blob([buf]), (f.name.split('.').pop() || 'ttf').toLowerCase());
        const list = DZF.custom().filter(x => x.name !== name); list.push({ name, ref });
        await Settings.set('dz_fonts', JSON.stringify(list)); DZF.loaded.add(name);
        toast(`Font "${name}" added.`); res(name);
      } catch { toast('That file is not a font this browser can use.', 5000); res(null); }
    };
    i.click();
  });
}
// Fonts installed on the device: the browser's font list where it allows it (Chrome on computers), otherwise by name.
async function dzDeviceFont() {
  if ('queryLocalFonts' in window) {
    try {
      const fams = [...new Set((await window.queryLocalFonts()).map(f => f.family))].sort();
      if (fams.length) return await new Promise((res) => {
        const o = document.createElement('div'); o.id = 'merge-dlg';
        o.innerHTML = `<div class="card"><h2>Fonts on this device</h2><input class="in" id="df-q" placeholder="Search" style="margin-bottom:8px">
          <div class="dz-flist">${fams.map(f => `<button data-f="${esc(f)}" style="font-family:'${esc(f)}'">${esc(f)}</button>`).join('')}</div>
          <button class="btn" data-f="" style="width:100%;margin-top:10px">Cancel</button></div>`;
        o.onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { o.remove(); res(b.dataset.f || null); } };
        o.querySelector('#df-q').oninput = (e) => o.querySelectorAll('.dz-flist button').forEach(b => b.hidden = !b.dataset.f.toLowerCase().includes(e.target.value.toLowerCase()));
        document.body.appendChild(o);
      });
    } catch {}
  }
  const n = await askText('Type the name of a font installed on this device (exactly as it appears in your other apps).\n\nOn phones and tablets, "Import a font file" works more reliably.');
  return n?.trim() || null;
}

/* ---------- Export ---------- */
function dzExport(doc, name) {
  const kind = DZ_KINDS[doc.kind], st = { sheet: false };
  const o = document.createElement('div'); o.id = 'merge-dlg';
  const file = () => (name || 'design').replace(/[^\w-]+/g, '_');
  const draw = () => {
    o.innerHTML = `<div class="card"><h2>Export</h2>
      <p class="muted" style="font-size:13px;margin-top:0">${esc(kind.label)}, ${esc(doc.paper || kind.sub)}. Saved at ${kind.social ? 'full size' : `print quality (${doc.dpi || 300} dpi)`}.
        ${doc.sides ? `Saved as two pages, ${dzFaceNames(doc).f.toLowerCase()} then ${dzFaceNames(doc).b.toLowerCase()}. Print double-sided${doc.w > doc.h ? ', flipping on the short edge' : ''}.` : ''}</p>
      <div class="dz-ex">
        ${kind.form ? `<button data-ex="ffpdf"><b>Interactive PDF</b><small>Text boxes, check boxes, radio and combo boxes can be filled in on a device. Sign by hand or in InkForge.</small></button>
        <button data-ex="ffprint"><b>Print blank</b><small>All pages, to fill in by hand</small></button>
        <button data-ex="ffopen"><b>Fill in now</b><small>In InkForge, saved to the client</small></button>` : `<button data-ex="png"><b>Save picture</b><small>PNG, for printing elsewhere or posting</small></button>
        <button data-ex="share"><b>Share</b><small>Send it in WhatsApp or another app</small></button>`}
        ${kind.fold ? '<button data-ex="print"><b>Print / PDF</b><small>Two pages: outside, then inside</small></button>' : ''}
        ${kind.page ? `<button data-ex="print"><b>Print / PDF</b><small>${doc.sides ? 'Two pages. ' : ''}Fits the paper in your printer; choose the same size there</small></button>` : ''}
        ${kind.per ? `<button data-ex="print"><b>Print / PDF</b><small>${st.sheet ? `${kind.per} on an A4 sheet with cut marks` : 'One per page'}</small></button>` : ''}
      </div>
      ${kind.per ? `<label class="toggle" style="display:inline-flex;margin-top:10px"><input type="checkbox" id="dx-sheet" ${st.sheet ? 'checked' : ''}><span>Fill an A4 sheet (${kind.per} per page)</span></label>` : ''}
      <button class="btn" data-x style="width:100%;margin-top:14px">Close</button></div>`;
  };
  o.addEventListener('change', (e) => { if (e.target.id === 'dx-sheet') { st.sheet = e.target.checked; draw(); } });
  o.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-ex]')?.dataset.ex;
    if (e.target.closest('[data-x]')) return o.remove();
    if (!a) return;
    if (a === 'ffopen') { o.remove(); Forms.ctx = {}; location.hash = 'form-sign/' + id; return; }
    if (a === 'ffprint') { o.remove(); return ffPrintBlank(doc); }
    if (a === 'ffpdf') { toast('Preparing…'); return ffSavePdf(ffCopy(doc, ffBlankCtx()), name); }
    toast('Preparing…');
    const cv = await dzCanvas(doc);
    if (doc.sides) {   // the two sides as their own pages
      const sides = [cv, await dzCanvas(doc, 1, 'b')], nm = dzFaceNames(doc);
      if (a === 'print') { o.remove(); return printCanvas(...(kind.per ? [await dzSheet(sides[0], doc.kind, st.sheet), await dzSheet(sides[1], doc.kind, st.sheet, true)] : sides)); }
      const fs = await Promise.all(sides.map(async (c, i) => new File([await new Promise(r => c.toBlob(r, 'image/png'))], `${file()}_${(i ? nm.b : nm.f).toLowerCase()}.png`, { type: 'image/png' })));
      if (a === 'share') {
        try { if (navigator.canShare?.({ files: fs })) return await navigator.share({ files: fs, title: name }); } catch (err) { if (err.name === 'AbortError') return; }
      }
      for (const f of fs) { const l = document.createElement('a'); l.href = URL.createObjectURL(f); l.download = f.name; l.click(); setTimeout(() => URL.revokeObjectURL(l.href), 5000); await new Promise(r => setTimeout(r, 250)); }
      return toast('Saved ' + fs.map(f => f.name).join(' and '));
    }
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const f = new File([blob], file() + '.png', { type: 'image/png' });
    if (a === 'png') { const l = document.createElement('a'); l.href = URL.createObjectURL(f); l.download = f.name; l.click(); setTimeout(() => URL.revokeObjectURL(l.href), 5000); return toast('Saved ' + f.name); }
    if (a === 'share') {
      const dl = () => { const l = document.createElement('a'); l.href = URL.createObjectURL(f); l.download = f.name; l.click(); setTimeout(() => URL.revokeObjectURL(l.href), 5000); toast('Saved ' + f.name); };
      try { if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: name }); else dl(); }
      catch (err) { if (err.name !== 'AbortError') dl(); }   // e.g. the tap expired while the picture was made
      return;
    }
    if (a === 'print') { o.remove(); return printCanvas(kind.page ? cv : await dzSheet(cv, doc.kind, st.sheet)); }
  });
  document.body.appendChild(o); draw();
}
// An A4 page (300 dpi): the design once, centred, or as many copies as fit with cut marks.
async function dzSheet(cv, kind, fill, back) {
  const W = 2480, H = 3508, pg = document.createElement('canvas'); pg.width = W; pg.height = H;
  const x = pg.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  const k = DZ_KINDS[kind];
  const marks = (px, py, w, h) => { x.strokeStyle = '#999'; x.lineWidth = 2; const m = 30, g = 8;
    for (const [cx, cy, sx, sy] of [[px, py, -1, -1], [px + w, py, 1, -1], [px, py + h, -1, 1], [px + w, py + h, 1, 1]]) {
      x.beginPath(); x.moveTo(cx + sx * g, cy); x.lineTo(cx + sx * (g + m), cy); x.moveTo(cx, cy + sy * g); x.lineTo(cx, cy + sy * (g + m)); x.stroke(); } };
  if (!fill) {
    const s = Math.min((W - 240) / k.w, (H - 240) / k.h, 1), w = k.w * s, h = k.h * s;
    x.drawImage(cv, (W - w) / 2, (H - h) / 2, w, h); marks((W - w) / 2, (H - h) / 2, w, h); return pg;
  }
  if (kind === 'flyer') {   // two A5 on an A4, each turned sideways (A5 is exactly half an A4)
    for (let i = 0; i < 2; i++) { x.save();
      if (back) { x.translate(W, i * H / 2); x.rotate(Math.PI / 2); } else { x.translate(0, i * H / 2 + H / 2); x.rotate(-Math.PI / 2); }
      x.drawImage(cv, 0, 0, H / 2, W); x.restore(); }
    x.strokeStyle = '#bbb'; x.setLineDash([12, 10]); x.lineWidth = 2; x.beginPath(); x.moveTo(0, H / 2); x.lineTo(W, H / 2); x.stroke();
    return pg;
  }
  const cols = Math.max(1, Math.floor((W - 120) / k.w)), rows = Math.max(1, Math.floor((H - 120) / k.h));
  const ox = (W - cols * k.w) / 2, oy = (H - rows * k.h) / 2;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const px = ox + (back ? cols - 1 - c : c) * k.w, py = oy + r * k.h; x.drawImage(cv, px, py); marks(px, py, k.w, k.h); }
  return pg;
}


/* ---------- Bend tool ----------
   Bends a picture into an arc, mainly for bands around an arm or leg: a limb tapers like a cone, so a
   band drawn straight won't meet flush when it's wrapped round. A slight bend makes the ends line up.
   The picture's width is laid along a circular arc covering `deg` degrees (up = a rainbow, down = a
   smile); its height runs from the outer edge in. See-through parts stay see-through. */
const BT = { src: null, name: 'band', deg: 20 };
// The bent picture on its own canvas, at most `max` px on the long side of the source.
function btWarp(src, deg, max) {
  const s = Math.min(1, max / Math.max(src.width, src.height)), W = Math.max(2, Math.round(src.width * s)), H = Math.max(2, Math.round(src.height * s));
  const down = deg < 0, a = Math.min(360, Math.abs(deg)) * Math.PI / 180;
  const sc = document.createElement('canvas'); sc.width = W; sc.height = H; const sx = sc.getContext('2d', { willReadFrequently: true });
  if (a < 0.001) { sx.drawImage(src, 0, 0, W, H); return sc; }
  if (down) { sx.translate(0, H); sx.scale(1, -1); }   // bending down = bend the upside-down picture up, then turn it back
  sx.drawImage(src, 0, 0, W, H);
  const sd = sx.getImageData(0, 0, W, H).data;
  // The middle of the picture keeps its length; the inner edge can't go below a small radius.
  const Ri = Math.max(H * 0.05, W / a - H / 2), Ro = Ri + H;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= 180; i++) { const f = -a / 2 + a * i / 180;
    for (const r of [Ri, Ro]) { const x = r * Math.sin(f), y = -r * Math.cos(f); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  const OW = Math.ceil(x1 - x0) + 2, OH = Math.ceil(y1 - y0) + 2;
  const out = document.createElement('canvas'); out.width = OW; out.height = OH;
  const ox = out.getContext('2d'), od = ox.createImageData(OW, OH), o = od.data;
  for (let py = 0; py < OH; py++) for (let px = 0; px < OW; px++) {
    const x = px + x0, y = py + y0, r = Math.hypot(x, y);
    if (r < Ri - 1 || r > Ro + 1) continue;
    const f = Math.atan2(x, -y); if (Math.abs(f) > a / 2 + 0.002) continue;
    // Smooth sampling (bilinear) so edges and fine lines stay clean.
    const u = Math.max(0, Math.min(W - 1.001, (f / a + 0.5) * (W - 1))), v = Math.max(0, Math.min(H - 1.001, (Ro - r) / (Ro - Ri) * (H - 1)));
    const ix = u | 0, iy = v | 0, fx = u - ix, fy = v - iy, i00 = (iy * W + ix) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4, j = (py * OW + px) * 4;
    for (let c = 0; c < 4; c++) o[j + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
  }
  ox.putImageData(od, 0, 0);
  if (!down) return out;
  const fl = document.createElement('canvas'); fl.width = OW; fl.height = OH; const fc = fl.getContext('2d');
  fc.translate(0, OH); fc.scale(1, -1); fc.drawImage(out, 0, 0); return fl;
}
const btLabel = (d) => +d === 0 ? 'Straight' : `${d > 0 ? 'Up' : 'Down'} ${Math.abs(d)}°`;
BT.mount = () => {
  const el = $('#bt'); if (!el) return;
  if (!BT.src) {
    el.innerHTML = `<label class="card st-pick">
        <div class="empty-ico">${ICON.bend}</div>
        <div style="font:26px var(--display)">Bend a band</div>
        <div class="muted">Bend a design into an arc so a band meets flush around a tapering arm or leg. PNGs keep their see-through background.</div>
        <span class="btn primary" style="margin-top:14px">Choose image</span>
        <input type="file" accept="image/png,image/*" id="bt-file" hidden></label>`;
    $('#bt-file').onchange = async (e) => { const f = e.target.files[0]; if (!f) return;
      try { BT.src = await createImageBitmap(f); BT.name = f.name.replace(/\.\w+$/, '').replace(/[^\w-]+/g, '_') || 'band'; BT.mount(); } catch { toast('Could not read that image.'); } };
    return;
  }
  el.innerHTML = `<div class="bt">
    <div class="bt-stage"><canvas id="bt-cv"></canvas></div>
    <div class="card bt-ctl">
      <label class="dz-sl"><span>Bend <b id="bt-l">${btLabel(BT.deg)}</b></span><input type="range" id="bt-deg" min="-360" max="360" step="1" value="${BT.deg}"></label>
      <div class="bt-fine">${[[-5, '−5'], [-1, '−1'], [0, 'Straight'], [1, '+1'], [5, '+5']].map(([d, l]) => `<button class="btn small" data-d="${d}">${l}</button>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin:8px 0 12px">For bands, a slight bend (around 10° to 40°) lets the ends meet flush on a limb that gets narrower. Up for a forearm band worn wrist-down, down the other way round. The middle keeps its length.</p>
      <div class="bt-acts">
        <label class="btn">Change image<input type="file" accept="image/png,image/*" id="bt-file" hidden></label>
        <button class="btn" id="bt-png">Save PNG</button>
        <button class="btn" id="bt-share">Share</button>
        <button class="btn primary" id="bt-st">Make a stencil</button>
      </div>
      <div class="muted" id="bt-size" style="font-size:11px;margin-top:8px"></div>
    </div></div>`;
  const cv = $('#bt-cv'), stage = el.querySelector('.bt-stage');
  let q = 0;
  // Preview: a smaller copy while the slider moves, so it keeps up.
  const show = () => { if (q) return; q = requestAnimationFrame(() => { q = 0;
    const b = btWarp(BT.src, BT.deg, 900), r = stage.getBoundingClientRect(), s = Math.min(1, (r.width - 24) / b.width, (r.height - 24) / b.height);
    cv.width = b.width; cv.height = b.height; cv.getContext('2d').drawImage(b, 0, 0);
    cv.style.width = Math.round(b.width * s) + 'px'; cv.style.height = Math.round(b.height * s) + 'px';
    const long = Math.max(BT.src.width, BT.src.height), k = Math.min(1, 3000 / long) / Math.min(1, 900 / long);   // full size vs preview
    $('#bt-size').textContent = `Saves as a ${Math.round(b.width * k)} × ${Math.round(b.height * k)} px PNG with a see-through background.`;
  }); };
  const set = (d) => { BT.deg = Math.max(-360, Math.min(360, Math.round(d))); $('#bt-deg').value = BT.deg; $('#bt-l').textContent = btLabel(BT.deg); show(); };
  $('#bt-deg').oninput = (e) => set(+e.target.value);
  el.querySelector('.bt-fine').onclick = (e) => { const b = e.target.closest('[data-d]'); if (b) set(+b.dataset.d === 0 ? 0 : BT.deg + +b.dataset.d); };
  $('#bt-file').onchange = async (e) => { const f = e.target.files[0]; if (!f) return;
    try { BT.src = await createImageBitmap(f); BT.name = f.name.replace(/\.\w+$/, '').replace(/[^\w-]+/g, '_') || 'band'; BT.mount(); } catch { toast('Could not read that image.'); } };
  // Full quality for saving; the stencil maker gets it on white, the way it expects a photo.
  const result = async () => { toast('Bending…'); await new Promise(r => setTimeout(r, 30));
    const b = btWarp(BT.src, BT.deg, 3000); return new File([await new Promise(r => b.toBlob(r, 'image/png'))], `${BT.name}-bent.png`, { type: 'image/png' }); };
  $('#bt-png').onclick = async () => { const f = await result(); const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast('Saved ' + f.name); };
  $('#bt-share').onclick = async () => { const f = await result(), dl = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast('Saved ' + f.name); };
    try { if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: f.name }); else dl(); }
    catch (err) { if (err.name !== 'AbortError') dl(); } };
  $('#bt-st').onclick = async () => {
    toast('Opening in the stencil maker…'); await new Promise(r => setTimeout(r, 30));
    const b = btWarp(BT.src, BT.deg, 2400), w = document.createElement('canvas'); w.width = b.width; w.height = b.height;
    const x = w.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w.width, w.height); x.drawImage(b, 0, 0);
    await stLoad(await new Promise(r => w.toBlob(r, 'image/png'))); location.hash = 'stencil';
  };
  BT.ro?.disconnect(); BT.ro = new ResizeObserver(show); BT.ro.observe(stage);
  show();
};


/* ---------- Split for printing ----------
   Big stencils (back pieces, sleeves) don't fit one sheet. The design is cut into pieces that each fit a
   page, printed at real size, then taped together. Cuts sit at positions in cm; dragging one is only
   allowed while every piece next to it still fits the page. An overlap repeats a strip of the design on
   both pieces, and each piece prints the exact cut as a dashed line: lay one dashed line over the other. */
const SP_PAPER = { A4: [190, 277], A3: [277, 400], Letter: [196, 259] };   // printable area in mm (10 mm margins)
const SP = { src: null, name: 'stencil', wcm: 40, paper: 'A4', land: false, ov: 1, xs: [], ys: [] };
const spMax = () => { const [w, h] = SP_PAPER[SP.paper]; return SP.land ? [h / 10, w / 10] : [w / 10, h / 10]; };   // cm
const spHcm = () => SP.src ? SP.wcm * SP.src.height / SP.src.width : 0;
const spNeed = (len, max) => Math.max(1, Math.ceil((len - SP.ov) / Math.max(0.5, max - SP.ov) - 1e-9));
// Even cuts into n pieces along a length.
const spEven = (len, n) => Array.from({ length: n - 1 }, (_, i) => len * (i + 1) / n);
function spReset(keep) {
  const [mw, mh] = spMax(), W = SP.wcm, H = spHcm();
  const nx = Math.max(spNeed(W, mw), keep ? SP.xs.length + 1 : 0), ny = Math.max(spNeed(H, mh), keep ? SP.ys.length + 1 : 0);
  SP.xs = spEven(W, nx); SP.ys = spEven(H, ny);
}
// Each piece: its cut-to-cut area plus the overlap on sides that have a neighbour (cm).
function spPieces() {
  const W = SP.wcm, H = spHcm(), xs = [0, ...SP.xs, W], ys = [0, ...SP.ys, H], o = SP.ov / 2, out = [];
  for (let r = 0; r < ys.length - 1; r++) for (let c = 0; c < xs.length - 1; c++) {
    const x0 = Math.max(0, xs[c] - (c ? o : 0)), x1 = Math.min(W, xs[c + 1] + (c < xs.length - 2 ? o : 0));
    const y0 = Math.max(0, ys[r] - (r ? o : 0)), y1 = Math.min(H, ys[r + 1] + (r < ys.length - 2 ? o : 0));
    out.push({ r, c, label: String.fromCharCode(65 + r) + (c + 1), x0, x1, y0, y1, cuts: { l: c ? xs[c] : null, r: c < xs.length - 2 ? xs[c + 1] : null, t: r ? ys[r] : null, b: r < ys.length - 2 ? ys[r + 1] : null } });
  }
  return out;
}
const spFits = () => { const [mw, mh] = spMax(); return spPieces().every(p => p.x1 - p.x0 <= mw + 1e-6 && p.y1 - p.y0 <= mh + 1e-6); };

SP.open = async (blob, name, wcm) => {
  SP.src = await createImageBitmap(blob); SP.name = name || 'stencil'; SP.wcm = wcm || SP.wcm; spReset();
  if (location.hash === '#split') SP.mount(); else location.hash = 'split';
};
SP.mount = () => {
  const el = $('#sp'); if (!el) return;
  if (!SP.src) {
    el.innerHTML = `<label class="card st-pick"><div class="empty-ico">${ICON.split}</div>
      <div style="font:26px var(--display)">Split for printing</div>
      <div class="muted">For stencils bigger than your paper: cut a design into pages, print them at real size and tape them together. Make the stencil first, then tap Split in the stencil maker, or choose an image here.</div>
      <span class="btn primary" style="margin-top:14px">Choose image</span><input type="file" accept="image/*" id="sp-file" hidden></label>`;
    $('#sp-file').onchange = async (e) => { const f = e.target.files[0]; if (!f) return;
      try { SP.src = await createImageBitmap(f); SP.name = f.name.replace(/\.\w+$/, '').replace(/[^\w-]+/g, '_'); spReset(); SP.mount(); } catch { toast('Could not read that image.'); } };
    return;
  }
  const draw = () => {
    const H = spHcm(), [mw, mh] = spMax(), ps = spPieces(), pages = ps.length;
    el.innerHTML = `<div class="sp">
      <div class="sp-stage" id="sp-stage"><div class="sp-img" id="sp-img"><canvas id="sp-cv"></canvas><div id="sp-ov"></div></div></div>
      <div class="card sp-ctl">
        <div class="two">
          <label class="field"><span>Width ${help('Real size of the whole design on the skin. Height follows the image.')}</span>
            <div class="unit-in"><input class="in" id="sp-w" type="text" inputmode="text" data-calc min="5" max="300" step="0.5" value="${+SP.wcm.toFixed(1)}"><em>cm</em></div></label>
          <label class="field"><span>Height</span><div class="unit-in"><input class="in" value="${H.toFixed(1)}" disabled><em>cm</em></div></label>
        </div>
        <div class="lbl">Paper</div>
        <div class="row" style="gap:6px;flex-wrap:nowrap">
          <div class="seg" style="flex:1">${Object.keys(SP_PAPER).map(k => `<button data-paper="${k}" class="${SP.paper === k ? 'on' : ''}" style="flex:1">${k}</button>`).join('')}</div>
          <div class="seg">${[['0', 'Portrait'], ['1', 'Landscape']].map(([k, l]) => `<button data-land="${k}" class="${+SP.land === +k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="lbl" style="margin-top:10px">Overlap for taping ${help('A strip of the design printed on both pieces, so you can line them up. 0 = pieces just touch.')}</div>
        <div class="seg">${[0, 0.5, 1, 2].map(v => `<button data-ov="${v}" class="${SP.ov === v ? 'on' : ''}" style="flex:1">${v ? v + ' cm' : 'None'}</button>`).join('')}</div>
        <div class="sp-grid">
          <div><span class="lbl">Columns</span><div class="sp-step"><button data-nx="-1">−</button><b>${SP.xs.length + 1}</b><button data-nx="1">+</button></div></div>
          <div><span class="lbl">Rows</span><div class="sp-step"><button data-ny="-1">−</button><b>${SP.ys.length + 1}</b><button data-ny="1">+</button></div></div>
        </div>
        <p class="muted" style="font-size:12px;margin:8px 0">${pages} page${pages > 1 ? 's' : ''} on ${SP.paper} ${SP.land ? 'landscape' : 'portrait'} (up to ${mw.toFixed(1)} × ${mh.toFixed(1)} cm each).
          Drag the dashed cut lines to move a cut, for example away from a face or fine detail. <button class="link" id="sp-even">Space evenly</button>
          ${SP.src.width / SP.wcm * 2.54 < 120 ? `<br><b style="color:var(--amber, #f0c75e)">At ${SP.wcm} cm this picture prints at about ${Math.round(SP.src.width / SP.wcm * 2.54)} dpi, so lines may look soft or stepped.</b> A larger picture prints sharper.` : ''}</p>
        <div class="row" style="gap:6px"><button class="btn" id="sp-save" data-tip="Save every piece as a PNG to this device">Save pieces</button><button class="btn" id="sp-share">Share</button><button class="btn primary" id="sp-print" style="flex:1">Print ${pages} page${pages > 1 ? 's' : ''}</button></div>
        <label class="btn small" style="margin-top:10px">Another image<input type="file" accept="image/*" id="sp-file" hidden></label>
      </div></div>`;
    lay(); bind();
  };
  // Preview: the design with its cut lines (draggable), overlap strips and piece labels.
  let pxcm = 1;
  const lay = () => {
    const st = $('#sp-stage'), r = st.getBoundingClientRect(), H = spHcm(), cv = $('#sp-cv');
    pxcm = Math.min((r.width - 24) / SP.wcm, (r.height - 24) / H);
    const w = SP.wcm * pxcm, h = H * pxcm, s = Math.min(2, devicePixelRatio || 1);
    Object.assign($('#sp-img').style, { width: w + 'px', height: h + 'px' });
    cv.width = Math.round(w * s); cv.height = Math.round(h * s); cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height); x.drawImage(SP.src, 0, 0, cv.width, cv.height);
    overlay();
  };
  const overlay = () => {
    const H = spHcm(), o = SP.ov * pxcm, ps = spPieces(), [mw, mh] = spMax();
    $('#sp-ov').innerHTML = SP.xs.map((v, i) => `<i class="sp-band v" style="left:${v * pxcm - o / 2}px;width:${o}px"></i><b class="sp-cut v" data-cx="${i}" style="left:${v * pxcm}px"><span>${v.toFixed(1)}</span></b>`).join('')
      + SP.ys.map((v, i) => `<i class="sp-band h" style="top:${v * pxcm - o / 2}px;height:${o}px"></i><b class="sp-cut h" data-cy="${i}" style="top:${v * pxcm}px"><span>${v.toFixed(1)}</span></b>`).join('')
      + ps.map(p => { const bad = p.x1 - p.x0 > mw + 1e-6 || p.y1 - p.y0 > mh + 1e-6;
        return `<em class="sp-lab ${bad ? 'bad' : ''}" style="left:${(p.x0 + p.x1) / 2 * pxcm}px;top:${(p.y0 + p.y1) / 2 * pxcm}px">${p.label}<small>${(p.x1 - p.x0).toFixed(1)} × ${(p.y1 - p.y0).toFixed(1)} cm</small></em>`; }).join('');
  };
  const bind = () => {
    const ctl = el.querySelector('.sp-ctl');
    ctl.onclick = (e) => {
      const t = e.target, d = (k) => t.closest(`[data-${k}]`)?.dataset[k];
      if (d('paper')) { SP.paper = d('paper'); spReset(); return draw(); }
      if (d('land') != null) { SP.land = d('land') === '1'; spReset(); return draw(); }
      if (d('ov') != null) { SP.ov = +d('ov'); spReset(true); if (!spFits()) spReset(); return draw(); }
      if (d('nx') || d('ny')) {
        const ax = !!d('nx'), dn = +(d('nx') || d('ny')), [mw, mh] = spMax(), len = ax ? SP.wcm : spHcm(), n = (ax ? SP.xs : SP.ys).length + 1 + dn;
        if (n < spNeed(len, ax ? mw : mh)) return toast('Fewer pieces would not fit the paper.');
        if (n > 12) return;
        if (ax) SP.xs = spEven(len, n); else SP.ys = spEven(len, n); return draw();
      }
      if (t.closest('#sp-even')) { SP.xs = spEven(SP.wcm, SP.xs.length + 1); SP.ys = spEven(spHcm(), SP.ys.length + 1); return overlay(); }
      if (t.closest('#sp-print')) return spPrint();
      if (t.closest('#sp-save')) return spSave(false);
      if (t.closest('#sp-share')) return spSave(true);
    };
    $('#sp-w').onchange = (e) => { SP.wcm = Math.max(5, Math.min(300, +e.target.value || SP.wcm)); spReset(); draw(); };
    ctl.querySelector('#sp-file').onchange = async (e) => { const f = e.target.files[0]; if (!f) return;
      try { SP.src = await createImageBitmap(f); SP.name = f.name.replace(/\.\w+$/, '').replace(/[^\w-]+/g, '_'); spReset(); draw(); } catch { toast('Could not read that image.'); } };
    // Dragging a cut: clamped so both pieces beside it still fit the page.
    const ov = $('#sp-ov'); let dr = null;
    // The lines are redrawn while dragging, so the drag follows the pointer on the whole window, not the line itself.
    ov.onpointerdown = (e) => { const c = e.target.closest('.sp-cut'); if (!c) return; e.preventDefault();
      dr = { ax: c.dataset.cx != null, i: +(c.dataset.cx ?? c.dataset.cy) };
      addEventListener('pointermove', move); addEventListener('pointerup', stop); addEventListener('pointercancel', stop); };
    const stop = () => { dr = null; removeEventListener('pointermove', move); removeEventListener('pointerup', stop); removeEventListener('pointercancel', stop); };
    const move = (e) => {
      if (!dr) return;
      const r = $('#sp-img').getBoundingClientRect(), arr = dr.ax ? SP.xs : SP.ys, len = dr.ax ? SP.wcm : spHcm(), max = (dr.ax ? spMax()[0] : spMax()[1]);
      const v = ((dr.ax ? e.clientX - r.left : e.clientY - r.top)) / pxcm, a = dr.i ? arr[dr.i - 1] : 0, b = dr.i < arr.length - 1 ? arr[dr.i + 1] : len;
      // A piece is its cut-to-cut length plus half the overlap on each side that has a neighbour.
      const extra = (lo, hi) => (lo > 0 ? SP.ov / 2 : 0) + (hi < len ? SP.ov / 2 : 0);
      const lo = Math.max(a + 1, b - (max - extra(v, b))), hi = Math.min(b - 1, a + (max - extra(a, v)));
      if (lo <= hi) { arr[dr.i] = Math.max(lo, Math.min(hi, v)); overlay(); $('#sp-ov').querySelector(dr.ax ? `[data-cx="${dr.i}"]` : `[data-cy="${dr.i}"]`)?.classList.add('on'); }
    };
  };
  // Each piece as its own canvas at print resolution (about 300 dpi), with its cut lines dashed and its label.
  const pieceCanvas = (p) => {
    const sx = SP.src.width / SP.wcm, w = Math.round((p.x1 - p.x0) * sx), h = Math.round((p.y1 - p.y0) * sx);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.drawImage(SP.src, p.x0 * sx, p.y0 * sx, w, h, 0, 0, w, h);
    x.strokeStyle = 'rgba(80,80,80,.85)'; x.lineWidth = Math.max(2, sx * 0.03); x.setLineDash([sx * 0.25, sx * 0.18]);
    for (const [k, v] of Object.entries(p.cuts)) { if (v == null) continue; x.beginPath();
      if (k === 'l' || k === 'r') { const X = (v - p.x0) * sx; x.moveTo(X, 0); x.lineTo(X, h); } else { const Y = (v - p.y0) * sx; x.moveTo(0, Y); x.lineTo(w, Y); } x.stroke(); }
    x.setLineDash([]); x.font = `700 ${Math.round(sx * 0.5)}px Inter, sans-serif`; x.fillStyle = 'rgba(80,80,80,.9)'; x.textBaseline = 'top';
    x.fillText(p.label, sx * 0.2, sx * 0.2);
    return cv;
  };
  const spPrint = async () => {
    if (!spFits()) return toast('A piece is bigger than the paper. Add a column or row.');
    const [mw, mh] = spMax();
    let pa = $('#print-area'); if (!pa) { pa = document.createElement('div'); pa.id = 'print-area'; document.body.appendChild(pa); }
    const urls = [];
    pa.innerHTML = spPieces().map(p => {
      let cv = pieceCanvas(p), w = p.x1 - p.x0, h = p.y1 - p.y0;
      if (SP.land) { const r = document.createElement('canvas'); r.width = cv.height; r.height = cv.width; const x = r.getContext('2d');   // landscape pieces print turned onto a portrait page
        x.translate(r.width, 0); x.rotate(Math.PI / 2); x.drawImage(cv, 0, 0); cv = r; [w, h] = [h, w]; }
      const u = cv.toDataURL('image/png'); urls.push(u);
      return `<div class="sp-page"><img src="${u}" style="width:${w}cm;height:${h}cm" alt="">
        <div class="sp-cap">${p.label} · ${esc(SP.name)} · ${w.toFixed(1)} × ${h.toFixed(1)} cm${SP.ov ? ` · overlap ${SP.ov} cm: lay the dashed lines over each other` : ''} · print at 100% / actual size</div></div>`;
    }).join('');
    await Promise.all([...pa.querySelectorAll('img')].map(i => i.decode().catch(() => {})));
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); pa.innerHTML = ''; };
    afterPrint(done);
    window.print();
  };
  const spSave = async (share) => {
    const files = [];
    for (const p of spPieces()) { const cv = pieceCanvas(p); files.push(new File([await new Promise(r => cv.toBlob(r, 'image/png'))], `${SP.name}-${p.label}.png`, { type: 'image/png' })); }
    try {
      if (share && navigator.canShare?.({ files })) return await navigator.share({ files, title: SP.name });
      for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); await new Promise(r => setTimeout(r, 250)); }
      toast(`Saved ${files.length} pieces.`);
    } catch (err) { if (err.name !== 'AbortError') { if (share) return spSave(false); toast('Could not save: ' + err.message); } }
  };
  draw();
  SP.ro?.disconnect(); SP.ro = new ResizeObserver(() => { if ($('#sp-stage')) lay(); }); SP.ro.observe($('#sp-stage'));
};
