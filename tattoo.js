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

/* ---------- Needles ----------
   Offsets in mm: u across the stroke, v along it. Diameter by needle size (#10 = 0.30 mm, #12 = 0.35 mm). */
const TT_KINDS = { liner: ['RL', 'Round liners'], shader: ['RS', 'Round shaders'], mag: ['M1', 'Magnums'], soft: ['CM', 'Soft edge magnums'] };
const TT_NEEDLES = [['liner', [1, 3, 5, 7, 9, 11, 14]], ['shader', [5, 7, 9, 11]], ['mag', [7, 9, 11, 13, 15]], ['soft', [9, 15, 23, 31]]]
  .flatMap(([kind, ns]) => ns.map(n => ({ id: n + TT_KINDS[kind][0], kind, n,
    name: `${{ liner: 'Liner', shader: 'Shader', mag: 'Magnum', soft: 'Soft edge magnum' }[kind]}, ${n} needle${n > 1 ? 's' : ''}` })));
function ttLayout(nd, dia) {
  const n = nd.n, out = [];
  if (nd.kind === 'liner' || nd.kind === 'shader') {
    const gap = nd.kind === 'shader' ? 1.3 : 0.78;   // shaders are soldered looser; liners tight, so the line comes out solid
    if (n === 1) out.push({ u: 0, v: 0, e: 1 });
    else if (n <= 6) { const r = (dia / 2) / Math.sin(Math.PI / n) * gap; for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n; out.push({ u: r * Math.cos(a), v: r * Math.sin(a), e: 1 }); } }
    else {   // bigger rounds: the n needles of a tight hexagonal bundle nearest its middle
      const g = []; for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) g.push({ u: (i + j / 2) * dia * gap, v: j * dia * gap * 0.866, e: 1 });
      g.sort((p, q) => Math.hypot(p.u, p.v) - Math.hypot(q.u, q.v)); out.push(...g.slice(0, n));
    }
  } else {   // magnums: two staggered rows, flat; the soft edge kind sits the same but its outer needles hit shallower (an airbrush-like fade)
    const a = Math.ceil(n / 2), b = n - a, w = (a - 1) * dia;
    for (let i = 0; i < a; i++) out.push({ u: -w / 2 + i * dia, v: 0 });
    for (let i = 0; i < b; i++) out.push({ u: -w / 2 + dia / 2 + i * dia, v: dia * 0.55 });
    for (const p of out) { const t = w ? Math.abs(p.u) / (w / 2) : 0;
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
   magnums lower). Voltage sets how fast the machine hits (about 14 hits a second per volt) and how hard. */
const TT_VOLT = { '1RL': 7.0, '3RL': 7.2, '5RL': 7.35, '7RL': 7.5, '9RL': 7.6, '11RL': 7.7, '14RL': 7.9, '5RS': 6.6, '7RS': 6.7, '9RS': 6.8, '11RS': 6.9,
  '7M1': 6.5, '9M1': 6.55, '11M1': 6.6, '13M1': 6.7, '15M1': 6.8, '9CM': 6.5, '15CM': 6.6, '23CM': 6.7, '31CM': 6.8 };
/* Hand speed: how fast this artist moves. Each sets a starting hand speed, how much fast strokes fade and an offset
   to every needle's voltage (faster hands run machines faster); Tune in fine tunes from there. */
const TT_PROFILES = [['vslow', 'Very slow', 5, 0.54, -0.3], ['slow', 'Relatively slow', 4.1, 0.62, 0], ['medium', 'Medium', 2.75, 0.8, 0.4], ['fast', 'Fast', 1.8, 0.97, 0.8], ['vfast', 'Very fast', 1.27, 1.15, 1.2]];

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
const TT_CAPS = ['#141414', '#5a5a5a', '#b3261e', '#f2c21b', '#1f4fa8', '#2e7d3b', '#6b3f22', '#f4f1ea'];
const TT_SKINS = [['Light', '#f1d3bd'], ['Fair', '#e2b493'], ['Medium', '#c68c63'], ['Tan', '#a86b45'], ['Brown', '#7b4a2c'], ['Deep', '#4e2f1e']];
const TT_LAYERS = [['stencil', 'Stencil'], ['line', 'Linework'], ['shadow', 'Shadow'], ['mid', 'Mid tone'], ['light', 'Light tone'], ['high', 'Highlights']];
const TT_DRAW = ['stencil', 'light', 'mid', 'shadow', 'line', 'high'];   // bottom to top
const TT_SIZES = [['A4', 21, 29.7], ['A5', 14.8, 21], ['A6', 10.5, 14.8], ['Square 15 cm', 15, 15], ['Forearm 10 × 25 cm', 10, 25]];

const TT = {
  st: null,
  /* Overall calibration, for this device and hand, on top of every needle's own feel: the pen's pressure range,
     a pressure curve, hand speed (how far apart punctures land), how much fast strokes lighten, the angle the pen
     is naturally held at (tilt counts from there) and ink flow. Set by Tune in, or by hand. */
  calDefaults: { penOnly: true, pMin: 0.1, pMax: 0.9, curve: -58, hand: 4.1, fade: 0.62, flow: 1.5, tilt0: 33, profile: 'slow', voltOff: 0, blow: 1, tough: 1 },
  cal() { try { return { ...TT.calDefaults, ...JSON.parse(Settings.get('tt_cal', '{}')) }; } catch { return { ...TT.calDefaults }; } },
  saveCal(c) { Settings.set('tt_cal', JSON.stringify(c)); },
  feel(id) { let o = {}; try { o = JSON.parse(Settings.get('tt_feel', '{}'))[id] || {}; } catch {} const nd = TT_NEEDLES.find(n => n.id === id);
    return { ...TT.feelBase(id), ...o }; },
  feelBase(id) { const nd = TT_NEEDLES.find(n => n.id === id); return { ...TT_FEEL, ...TT_FEEL_LIQ[nd.kind], volt: TT_VOLT[id] ?? 7 }; },
  // Only what differs from the defaults is kept, so better defaults still reach everything left alone.
  setFeel(id, f) { let all = {}; try { all = JSON.parse(Settings.get('tt_feel', '{}')); } catch {}
    if (f) { const b = TT.feelBase(id), d = {}; for (const k in f) if (f[k] !== b[k]) d[k] = f[k]; if (Object.keys(d).length) all[id] = d; else delete all[id]; } else delete all[id];
    Settings.set('tt_feel', JSON.stringify(all)); },
  // Once: the defaults were reworked (voltage, hand speed), so earlier tuning starts again from them.
  migrate() { if (Settings.get('tt_ver') === '2') return false; const pen = TT.cal().penOnly; Settings.set('tt_feel', '{}'); Settings.set('tt_cal', JSON.stringify({ penOnly: pen }));
    Settings.set('tt_tuned', ''); Settings.set('tt_ver', '2'); return true; }
};

/* ---------- The list of pieces ---------- */
TT.list = async (el) => {
  ttStyle();
  const rows = (await DB.all('SELECT id, name, w_cm, h_cm, thumb_ref, updated_at, meta FROM tattoo_pieces ORDER BY updated_at DESC, id DESC'))
    .map(r => { let ex = null; try { ex = JSON.parse(r.meta || '{}').exam; } catch {} return { ...r, exam: ex ? (ex.done ? 2 : 1) : 0 }; });
  const urls = await Promise.all(rows.map(r => Media.url(r.thumb_ref)));
  el.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="muted" style="margin:0;flex:1;font-size:13px">Experimental: draw with needle groupings in ink on skin. Works best with a pressure pen (like an S Pen).</p>
      <button class="btn" id="tt-exam" data-tip="A set of challenges, from lines to a finished piece, with a report card">Apprentice exam</button>
      <button class="btn primary" id="tt-new">+ New piece</button></div>
    ${rows.length ? `<div class="dz-grid">${rows.map((r, i) => `<div class="dz-item" data-open="${r.id}"><div class="dz-thumb">${urls[i] ? `<img src="${urls[i]}" alt="">` : ''}</div>
      <div class="dz-meta"><b>${esc(r.name || 'Piece')}</b><span class="muted">${r.exam ? (r.exam === 2 ? 'Exam · finished' : 'Exam · in progress') : `${+r.w_cm} × ${+r.h_cm} cm`}</span></div>
      <button class="mini" data-del="${r.id}" aria-label="Delete" data-tip="Delete">✕</button></div>`).join('')}</div>`
      : `<div class="empty"><div class="empty-ico">${ICON.needle}</div><div style="font:24px var(--display)">Tattoo simulator</div>
        <div class="muted">Pick a page size and skin tone, load a stencil to trace, dip into the ink caps and tattoo in layers: linework, shadow, mid and light tones, highlights.</div></div>`}`;
  $('#tt-new').onclick = () => ttNewDlg();
  $('#tt-exam').onclick = async () => {   // carry on with an unfinished exam, or start one
    const open = rows.find(r => r.exam === 1);
    if (open) { location.hash = 'tattoo/' + open.id; return; }
    if (!confirm('Start the apprentice exam?\n\n10 challenges, from straight lines to a finished heart. Each loads its stencil, an example to follow and the needle to use; you can stop at any point and carry on later. You get a report card at the end.')) return;
    await DB.run('INSERT INTO tattoo_pieces (name, w_cm, h_cm, skin, meta) VALUES (?, ?, ?, ?, ?)', ['Apprentice exam', 18, 13, Settings.get('tt_skin', '#e2b493'), JSON.stringify({ exam: { v: 1, i: 0, res: [], started: Date.now() } })]);
    location.hash = 'tattoo/' + (await DB.one('SELECT last_insert_rowid() AS id')).id;
  };
  el.onclick = async (e) => {
    const d = e.target.closest('[data-del]');
    if (d) { e.stopPropagation(); const r = await DB.one('SELECT * FROM tattoo_pieces WHERE id = ?', [+d.dataset.del]); if (!r || !confirm(`Delete "${r.name || 'this piece'}"?`)) return;
      await DB.run('DELETE FROM tattoo_pieces WHERE id = ?', [r.id]); for (const k of ['thumb_ref', 'skin_ref', 'blow_ref', ...TT_LAYERS.map(([l]) => l + '_ref')]) await Media.release(r[k]); return TT.list(el); }
    const o = e.target.closest('[data-open]'); if (o) location.hash = 'tattoo/' + o.dataset.open;
  };
};
function ttNewDlg() {
  const st = { size: 1, skin: Settings.get('tt_skin', '#e2b493'), cw: 15, ch: 20 };
  const o = document.createElement('div'); o.id = 'merge-dlg';
  const draw = () => { o.innerHTML = `<div class="card"><h2>New piece</h2>
    <div class="lbl">Page</div><div class="seg" style="flex-wrap:wrap;margin-bottom:8px">${[...TT_SIZES, ['Custom']].map(([n], i) => `<button data-s="${i}" class="${st.size === i ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${st.size === TT_SIZES.length ? `<div class="two"><label class="field"><span>Width (cm)</span><input class="in" id="tn-w" type="number" min="3" max="60" value="${st.cw}"></label>
      <label class="field"><span>Height (cm)</span><input class="in" id="tn-h" type="number" min="3" max="60" value="${st.ch}"></label></div>` : ''}
    <div class="lbl">Skin</div><div class="tt-skins">${TT_SKINS.map(([n, c]) => `<button data-k="${c}" class="${st.skin === c ? 'on' : ''}" style="background:${c}" data-tip="${n}" aria-label="${n}"></button>`).join('')}
      <label class="tt-skinpick" data-tip="Any skin tone"><input type="color" id="tn-k" value="${st.skin}"></label></div>
    <label class="field"><span>Name</span><input class="in" id="tn-n" value="Piece ${ymd(new Date())}"></label>
    <div class="row"><button class="btn" id="tn-x">Cancel</button><button class="btn primary" id="tn-go" style="flex:1">Start</button></div></div>`; };
  o.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-s]')) { st.size = +t.closest('[data-s]').dataset.s; return draw(); }
    if (t.closest('[data-k]')) { st.skin = t.closest('[data-k]').dataset.k; return draw(); }
    if (t.id === 'tn-x') return o.remove();
    if (t.id === 'tn-go') {
      const [, w, h] = st.size < TT_SIZES.length ? TT_SIZES[st.size] : [0, Math.min(60, Math.max(3, +$('#tn-w').value || 15)), Math.min(60, Math.max(3, +$('#tn-h').value || 20))];
      await Settings.set('tt_skin', st.skin);
      await DB.run('INSERT INTO tattoo_pieces (name, w_cm, h_cm, skin) VALUES (?, ?, ?, ?)', [$('#tn-n').value.trim() || 'Piece', w, h, st.skin]);
      const id = (await DB.one('SELECT last_insert_rowid() AS id')).id; o.remove(); location.hash = 'tattoo/' + id;
    }
  };
  o.oninput = (e) => { if (e.target.id === 'tn-k') { st.skin = e.target.value; } if (e.target.id === 'tn-w') st.cw = +e.target.value; if (e.target.id === 'tn-h') st.ch = +e.target.value; };
  document.body.appendChild(o); draw();
}

/* ---------- The page ---------- */
TT.open = async (el, id) => {
  ttStyle(); const migrated = TT.migrate();
  const row = await DB.one('SELECT * FROM tattoo_pieces WHERE id = ?', [id]); if (!row) { location.hash = 'tattoo'; return; }
  const R = Math.min(80, 2400 / Math.max(row.w_cm, row.h_cm)), W = Math.round(row.w_cm * R), H = Math.round(row.h_cm * R), mm = R / 10;   // page px per cm, per mm
  const L = {}; for (const [k] of TT_LAYERS) { const c = document.createElement('canvas'); c.width = W; c.height = H; L[k] = c; }
  for (const [k] of TT_LAYERS) { const ref = row[k + '_ref']; if (!ref) continue; const u = await Media.url(ref); if (!u) continue;
    const im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; }); if (im) L[k].getContext('2d').drawImage(im, 0, 0, W, H); }
  let meta = {}; try { meta = JSON.parse(row.meta || '{}'); } catch {}
  const st = { layer: meta.layer || 'line', needle: meta.needle || '3RL', tool: 'needle', hide: new Set(meta.hide || []), op: { stencil: 0.45, ...(meta.op || {}) },
    ink: { c: ttHex(meta.ink || '#141414'), v: meta.inkV ?? 0, s: meta.inkS ?? 1 }, wash: !!meta.wash, caps: meta.caps || [...TT_CAPS], panel: null, dirty: false, name: row.name, skin: row.skin || '#e2b493',
    stretch: meta.stretch ?? 75, view: 'work', viewC: null, refsInit: meta.refs || [], magAng: meta.magAng ?? 0, magTilt: !!meta.magTilt, rot: meta.rot || 0 };
  /* Pigment in the skin. Each ink layer's pixels hold how much ink that spot holds (alpha: 0 = none, 255 = fully
     saturated) and its colour. A puncture only adds ink into the room left, counting the ink of every layer at that
     spot; ink lighter than what's there is held back in proportion to how saturated it is (a light value can't take
     over a dark one, but fills a feathered edge), while darker ink still goes in. Where two inks share a spot they
     mix like pigment (blue and yellow make green). The pixels are worked on directly and copied to the layer's
     canvas once per frame. */
  const INK = TT_LAYERS.map(([key]) => key).filter(key => key !== 'stencil');
  const loadImg = async (ref) => { const u = ref && await Media.url(ref); return u ? new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; }) : null; };
  const imgd = {}, dirty = {};
  const syncIn = (key) => { if (INK.includes(key)) imgd[key] = L[key].getContext('2d').getImageData(0, 0, W, H); };
  INK.forEach(syncIn);
  const ALOG = new Float32Array(256); for (let i = 0; i < 256; i++) ALOG[i] = -Math.log(Math.max(0.02, i / 255));
  const lumOf = (D, i) => (D[i] * 0.299 + D[i + 1] * 0.587 + D[i + 2] * 0.114) / 255;
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
      const block = (1 - keep) * (dw ? Math.min(1, (lc + 0.03) / (lw / dw + 0.03)) : 0);
      let add = a * (1 - block); const d0 = D[i + 3] / 255;
      if (T.str < 1) { add *= 0.35 + 0.65 * T.str; const sat = 1 - keep; if (sat > T.str) add *= 0.1 * T.str; }   // a thin wash builds slowly past its own tone
      if (add <= 0.0005) continue;
      if (d0 > 0.004) { const t = add / (d0 + add); for (let c = 0; c < 3; c++) D[i + c] = 255 * Math.exp(-(ALOG[D[i + c]] * (1 - t) + Ac[c] * t)); }
      else { D[i] = col[0]; D[i + 1] = col[1]; D[i + 2] = col[2]; }
      D[i + 3] = Math.min(255, Math.floor(D[i + 3] + add * 255 + Math.random()));
    }
    const b = dirty[T.key] ||= { x0, y0, x1, y1 }; b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0); b.x1 = Math.max(b.x1, x1); b.y1 = Math.max(b.y1, y1);
  };
  const flushPig = () => { for (const key in dirty) { const b = dirty[key]; L[key].getContext('2d').putImageData(imgd[key], 0, 0, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1); delete dirty[key]; } };
  // One mark: into pigment (the page), or painted on a canvas (the test pad).
  const put = (cx, x, y, r, al, erase) => { if (cx.pig) return dotPig(cx, x, y, r, al, erase);
    cx.globalAlpha = al; cx.beginPath(); cx.arc(x, y, r, 0, 7); cx.fill(); };
  /* The skin itself. Trauma: every puncture works the skin a little (deeper, more needles: more), on a map at a
     quarter of the page's resolution; as it builds the skin goes red, then swollen and bumpy, then raw like
     minced meat, and overworked skin takes ink badly (patchy). Blowouts: too deep while the punctures land very
     close together (pressing hard and pulling slowly) pushes ink under the skin: a soft, bluish bruise that spreads
     past the line and raises the skin. Both are kept with the piece; a healed preview drops the redness and
     swelling but keeps the blowouts. */
  const TS = 4, tw = Math.ceil(W / TS), th = Math.ceil(H / TS), TR = new Float32Array(tw * th);
  const blowC = document.createElement('canvas'); blowC.width = Math.ceil(W / 2); blowC.height = Math.ceil(H / 2); const bx = blowC.getContext('2d');
  let trDirty = true, trT = 0; const told = {};
  const trAdd = (p, r, v) => {
    const cx0 = p.x / TS, cy0 = p.y / TS, R2 = Math.max(1, r / TS);
    for (let y = Math.max(0, Math.floor(cy0 - R2)); y <= Math.min(th - 1, Math.ceil(cy0 + R2)); y++)
      for (let x2 = Math.max(0, Math.floor(cx0 - R2)); x2 <= Math.min(tw - 1, Math.ceil(cx0 + R2)); x2++) {
        const f = 1 - Math.hypot(x2 + 0.5 - cx0, y + 0.5 - cy0) / R2; if (f > 0) TR[y * tw + x2] += v * f; }
    trDirty = true;
  };
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
  const buildTrauma = () => {
    const rg = trRed.getContext('2d'), mg = trMask.getContext('2d'), ri = rg.createImageData(tw, th), mi = mg.createImageData(tw, th);
    for (let i = 0; i < TR.length; i++) { const t = TR[i], j = i * 4; if (!t) continue;
      ri.data[j] = 214; ri.data[j + 1] = 64; ri.data[j + 2] = 52; ri.data[j + 3] = Math.min(150, Math.max(0, t - 0.3) * 160);
      const m = Math.max(0, Math.min(1, (t - 1) / 1.2)); mi.data[j] = mi.data[j + 1] = mi.data[j + 2] = 255; mi.data[j + 3] = m * m * (3 - 2 * m) * 235; }
    rg.putImageData(ri, 0, 0); mg.putImageData(mi, 0, 0);
    const tg = trTex.getContext('2d'); tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, trTex.width, trTex.height);
    tg.fillStyle = tg.createPattern(patty, 'repeat'); tg.fillRect(0, 0, trTex.width, trTex.height);
    tg.globalCompositeOperation = 'destination-in'; tg.imageSmoothingEnabled = true; tg.drawImage(trMask, 0, 0, trTex.width, trTex.height); tg.globalCompositeOperation = 'source-over';
    trDirty = false; trT = performance.now();
  };
  // The skin under and over the ink: redness and blowouts beneath, the swollen, raw texture on top.
  const skinUnder = (g, withTrauma) => { if (withTrauma) { g.globalCompositeOperation = 'multiply'; g.drawImage(trRed, 0, 0, W, H); }
    g.globalCompositeOperation = 'multiply'; g.drawImage(blowC, 0, 0, W, H); g.globalCompositeOperation = 'source-over'; };
  const skinOver = (g) => { g.globalAlpha = 0.85; g.drawImage(trTex, 0, 0, W, H); g.globalAlpha = 1; };
  // Blowout: ink spread under the skin round p, bluer and softer than the line, and the skin raised over it.
  const blowAt = (p, risk, footR) => {
    if (EX?.cur) EX.cur.blow = (EX.cur.blow || 0) + 1;
    // ink seen through the skin: bluer
    const c = st.ink.c.map((v, j) => Math.round((v * 0.45 + [0.34, 0.42, 0.68][j] * 0.55) * 255)), R = (footR + mm * (1.1 + risk * 1.8)) / 2, gx = p.x / 2, gy = p.y / 2;
    const gr = bx.createRadialGradient(gx, gy, 0, gx, gy, R); gr.addColorStop(0, `rgba(${c},${0.12 + risk * 0.16})`); gr.addColorStop(0.5, `rgba(${c},${0.05 + risk * 0.07})`); gr.addColorStop(1, `rgba(${c},0)`);
    bx.fillStyle = gr; bx.beginPath(); bx.arc(gx, gy, R, 0, 7); bx.fill();
    trAdd(p, footR * 2.2 + mm, 0.035 * risk);
  };
  { const bi = await loadImg(row.blow_ref); if (bi) bx.drawImage(bi, 0, 0, blowC.width, blowC.height);
    const ti = await loadImg(row.skin_ref); if (ti) { const c = document.createElement('canvas'); c.width = tw; c.height = th; const g = c.getContext('2d'); g.drawImage(ti, 0, 0, tw, th);
      const d = g.getImageData(0, 0, tw, th).data; for (let i = 0; i < TR.length; i++) TR[i] = d[i * 4] / 255 * 2; } }
  let refs = (meta.refs || []).filter(Boolean), refSel = null;
  const EX = meta.exam || null;
  const hist = [], fut = [];   // undo and redo: { key, data, tr, blow } snapshots of one layer and the skin
  const state = (key) => ({ key, data: L[key].getContext('2d').getImageData(0, 0, W, H), tr: TR.slice(), blow: bx.getImageData(0, 0, blowC.width, blowC.height) });
  const snap = (key) => { hist.push(state(key)); if (hist.length > 15) hist.shift(); fut.length = 0; };
  el.innerHTML = `<div class="dz-ed tt-ed">
    <div class="dz-top">
      <button class="dz-ib" id="tt-back" data-tip="Back to your pieces" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <input class="dz-name" id="tt-name" value="${esc(row.name || 'Piece')}" aria-label="Name"><span class="dz-tsp"></span>
      <button class="dz-ib" id="tt-undo" data-tip="Undo" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
      <button class="dz-ib" id="tt-redo" data-tip="Redo" aria-label="Redo"><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg></button>
      <button class="dz-ib tt-viewb" id="tt-view" data-tip="Preview: as worked, fresh, healed or after 10 years" aria-label="Preview"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg><b></b></button>
      <button class="dz-ib" id="tt-stencilmk" data-tip="Send to the stencil maker" aria-label="Stencil maker">${ICON.stencil}</button>
      <button class="dz-ib" id="tt-png" data-tip="Save as PNG" aria-label="Save as PNG"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 19h14"/></svg></button>
      <button class="dz-ib dz-go" id="tt-save" data-tip="Save" aria-label="Save"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg></button>
    </div>
    <div class="dz-body"><div class="dz-stage tt-stage" id="tt-stage"><canvas id="tt-cv"></canvas><canvas id="tt-cur"></canvas>
      <div class="dz-rail" id="tt-rail">
        <button class="dz-ib tt-needle" data-r="needles" data-tip="Needle grouping" aria-label="Needle"><b id="tt-nl"></b></button>
        <button class="dz-ib tt-angb" data-r="angle" data-tip="Magnum angle ([ and ] turn it)" aria-label="Magnum angle" hidden><svg viewBox="0 0 24 24"><g id="tt-angi"><path d="M4 12h16" stroke-width="3"/></g></svg><b id="tt-angl"></b></button>
        <button class="dz-ib" data-r="needle" data-tip="Tattoo" aria-label="Tattoo"><svg viewBox="0 0 24 24"><path d="M4 20l5-5M9 15l8-8 2 2-8 8zM14 6l4 4"/></svg></button>
        <button class="dz-ib" data-r="erase" data-tip="Laser (erase)" aria-label="Erase"><svg viewBox="0 0 24 24"><path d="M7 21h10M5 15l9-9 5 5-9 9H8z"/></svg></button>
        <i class="sep"></i>
        <button class="dz-ib" data-r="layers" data-tip="Layers" aria-label="Layers"><svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/></svg></button>
        <button class="dz-ib" data-r="refs" data-tip="References: pictures that float over the skin to follow" aria-label="References"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="11" rx="1.5"/><path d="M8 3h13v11"/><circle cx="7.5" cy="10" r="1.5"/><path d="M16 15l-4-4-6 6"/></svg></button>
        <button class="dz-ib" data-r="feel" data-tip="Needle feel and pen calibration" aria-label="Calibration"><svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg></button>
        <i class="sep"></i>
        <div class="tt-volt" data-tip="Machine voltage for this needle: higher hits harder"><b id="tt-vl"></b><input type="range" id="tt-vs" min="5" max="10" step="0.05" aria-label="Voltage"></div>
      </div>
      <div class="dz-pop" id="tt-pop" hidden></div><div class="tt-refs" id="tt-refs"></div><div class="tt-exam" id="tt-exbar" hidden></div>
      <div class="tt-tray" id="tt-tray"></div>
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
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'), ink = composite(1, true, mode);
    g.drawImage(skin, 0, 0);
    if (mode === 'fresh') {
      g.drawImage(ink, 0, 0);
      const m = document.createElement('canvas'); m.width = W; m.height = H; const mg = m.getContext('2d');
      mg.filter = `blur(${Math.max(2, mm * 2.2)}px)`; for (const key of ['light', 'mid', 'shadow', 'line']) if (!st.hide.has(key)) mg.drawImage(L[key], 0, 0);
      mg.filter = 'none'; mg.globalCompositeOperation = 'source-in'; mg.fillStyle = '#d4483e'; mg.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.8; g.drawImage(m, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    } else {
      const [b, a, sat] = mode === 'healed' ? [0.1, 0.9, 0.92] : [0.38, 0.7, 0.68];
      g.filter = `blur(${Math.max(0.5, mm * b)}px) saturate(${sat})`; g.globalAlpha = a; g.drawImage(ink, 0, 0); g.filter = 'none'; g.globalAlpha = 1;
    }
    return c;
  };
  const paint = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
    const dpr = cv.width / (stage.clientWidth || 1), { cx, cy } = org();
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.translate(cx, cy); x.rotate(st.rot); x.scale(k, k); x.translate(-W / 2, -H / 2);
    x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 24; x.drawImage(skin, 0, 0); x.shadowBlur = 0;
    if (st.view !== 'work') { st.viewC ||= viewOf(st.view); x.drawImage(st.viewC, 0, 0); }
    else { if (trDirty && performance.now() - trT < 120) setTimeout(paint, 130); else if (trDirty) buildTrauma();
      skinUnder(x, true);
      for (const key of TT_DRAW) { if (st.hide.has(key)) continue;
        x.globalAlpha = key === 'stencil' ? st.op.stencil : (st.op[key] ?? 1); x.globalCompositeOperation = key === 'high' ? 'source-over' : 'multiply';
        x.drawImage(L[key], 0, 0); }
      x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; skinOver(x); }
    x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
    const deg = Math.round(((st.rot * 180 / Math.PI) % 360 + 360) % 360);
    $('#tt-zl') && ($('#tt-zl').textContent = Math.abs(z - 1) < 0.01 && !vx && !vy && !deg ? 'Fit' : Math.round(z * 100) + '%' + (deg ? ' · ' + deg + '°' : ''));
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
  const depthOf = (pr, speed, tilt) => { const d = (feel.dMin + (feel.dMax - feel.dMin) * curve(pr, feel.pCurve + cal.curve)) * (0.8 + (volt() - 6.5) * 0.15);   // harder hits at higher voltage
    return Math.max(0.02, Math.min(1, d * (1 - Math.min(0.9, speed / 200 * feel.speedFade / 100 * cal.fade) - tilt * feel.tiltFade / 100 * 0.6))); };
  const volt = () => Math.max(4, Math.min(11, (feel.volt ?? 7) + (cal.voltOff || 0)));
  const hzOf = () => volt() * 14;   // hits per second
  const gapMm = (speed) => Math.max(0.02, speed * (feel.hand / 100) * cal.hand / hzOf());   // mm between punctures
  /* Magnums hold their angle like a calligraphy nib: the row of needles stays at magAng whatever way the stroke
     goes (pulled along the row it lines; across it, it shades). With "follows the pen" the row sits across the
     way the pen leans, when it leans enough to tell. Rounds have no direction, so they follow the stroke. */
  let nk = TT_NEEDLES.find(n => n.id === st.needle)?.kind;
  const isMag = () => ['mag', 'soft'].includes(TT_NEEDLES.find(n => n.id === st.needle)?.kind);
  const rowAng = (ev) => { const tx = ev?.tiltX || 0, ty = ev?.tiltY || 0;
    return st.magTilt && Math.hypot(tx, ty) > 12 ? Math.atan2(ty, tx) + Math.PI / 2 : st.magAng * Math.PI / 180; };
  const turnOf = (strokeA, ev) => isMag() ? rowAng(ev) - Math.PI / 2 : strokeA;
  const pageTurn = (strokeA, ev) => turnOf(strokeA, ev) - (isMag() ? st.rot : 0);   // a magnum's angle is held on the screen, whatever the page's rotation
  const setNeedle = (id) => { st.needle = id; nk = TT_NEEDLES.find(n => n.id === id)?.kind; feel = TT.feel(id); lay = ttLayout(TT_NEEDLES.find(n => n.id === id), feel.size); $('#tt-nl').textContent = id; st.dirty = true; drawAng(); drawCur(); drawVolt(); };
  const drawVolt = () => { const v = feel.volt ?? 7; $('#tt-vs').value = v; $('#tt-vl').textContent = v.toFixed(1) + 'V'; };
  /* One puncture: every needle of the grouping into the skin at p (page px, `sc` px per mm), turned to angle a.
     Needle hang: a longer hang is softer (each needle lands a little off and at its own depth, and tilt spreads
     it more). Skin stretch: loose skin moves under the needles (a wobble shared by the whole puncture), takes
     ink less evenly and lets it bleed further. */
  const puncture = (cx, p, a, depth, tilt, inkC, erase, sc = mm) => {
    const hang = (feel.hang ?? 40) / 100, loose = 1 - st.stretch / 100;
    const ca = Math.cos(a), sa = Math.sin(a), sp = 1 + tilt * feel.tiltSpread / 100 * 0.8 * (0.5 + hang);
    const wide = lay.length > 4 && nk !== 'liner', rr = feel.size / 2 * sc * (wide ? 0.62 + depth * 0.45 : 0.45 + depth * 0.35) * sp, flow = feel.flow / 100 * cal.flow, bleed = feel.bleed / 100 * (1 + loose * 0.8);
    const hit = (1 - (feel.miss / 100) * (1 - depth)) * (1 - loose * 0.15), wob = loose * 0.12, wu = (Math.random() - 0.5) * wob, wv = (Math.random() - 0.5) * wob;
    for (const nd of lay) {
      if (Math.random() > hit || (nd.e < 1 && Math.random() > 0.55 + nd.e * 0.45)) continue;   // shallow edge needles skip more
      const j = 0.04 + hang * 0.06, u = (nd.u + wu + (Math.random() - 0.5) * j) * sc * sp, v = (nd.v + wv + (Math.random() - 0.5) * j) * sc;
      const dd = Math.max(0.02, depth * nd.e * (1 + (Math.random() - 0.5) * hang * 0.5));
      const px = p.x + u * -sa + v * ca, py = p.y + u * ca + v * sa, al = Math.min(1, (0.18 * nd.e + dd * 0.6) * flow * inkC);
      if (al <= 0.004) continue;
      put(cx, px, py, rr, al, erase);
      if (bleed && !erase) put(cx, px, py, rr * 1.6, al * bleed * 0.25, false);
    }
    cx.globalAlpha = 1;
  };
  let pen = null;
  const strokeStart = (e) => {
    const key = st.layer; if (st.hide.has(key)) toast('That layer is hidden: show it to see what you draw.');
    if (key === 'stencil' && st.tool !== 'erase') { toast('The stencil layer holds a picture to trace. Load one from Layers.'); return false; }
    if (st.view !== 'work') { st.view = 'work'; st.viewC = null; drawView(); }
    const c = L[key]; snap(key);
    let cx;
    if (INK.includes(key)) { const col = st.ink.c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));
      cx = { pig: true, key, col, str: st.tool === 'erase' ? 1 : (st.ink.s ?? 1), lum: (col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114) / 255, ac: col.map(v => ALOG[v]) }; }
    else { cx = c.getContext('2d'); cx.globalCompositeOperation = 'destination-out'; cx.fillStyle = '#000'; }   // the stencil: only the laser
    const p = toPage(e);
    if (EX?.cur) { EX.cur.strokes = (EX.cur.strokes || 0) + 1; EX.cur.t0 ||= Date.now(); EX.cur.t1 = Date.now(); }
    pen = { cx, last: p, t: e.timeStamp, carry: 0, speed: 0, a: 0, id: e.pointerId, q: [], raf: 0, foot: (Math.max(...lay.map(n => Math.hypot(n.u, n.v))) + feel.size) * mm };
    if (st.tool !== 'erase' && st.ink.v <= 0.02) toast('The needle is dry: dip into an ink cap first.', 1800);
    return true;
  };
  /* Pen moves are queued and inked once per frame, so the heavy pigment work never holds up the cursor, which is
     drawn straight away on every move (at the browser's predicted point, to cancel the screen's own delay). */
  const strokeMove = (e) => {
    const co = e.getCoalescedEvents?.(); pen.q.push(...(co?.length ? co : [e]));
    if (!pen.raf) pen.raf = requestAnimationFrame(strokeFlush);
  };
  const strokeFlush = () => { if (!pen) return; pen.raf = 0; const evs = pen.q; pen.q = []; if (!evs.length) return;
    for (const ev of evs) {
      const p = toPage(ev), dx = p.x - pen.last.x, dy = p.y - pen.last.y, d = Math.hypot(dx, dy), dt = Math.max(1, ev.timeStamp - pen.t) / 1000;
      if (d < 0.01) continue;
      const v = d * k / (96 / 25.4) / dt;   // the hand's speed on the screen, mm per second (zoom doesn't change it)
      pen.speed = pen.speed ? pen.speed * 0.7 + v * 0.3 : v; pen.a = Math.atan2(dy, dx); pen.trav = (pen.trav || 0) + d / mm;
      const tilt = tiltOf(ev), depth = depthOf(pNorm(ev), pen.speed, tilt);
      if (EX?.cur && st.tool !== 'erase' && (EX.cur.n = (EX.cur.n || 0) + 1) % 3 === 0 && EX.cur.p.length < 1500) {
        EX.cur.p.push(+pNorm(ev).toFixed(3)); EX.cur.v.push(Math.round(pen.speed)); EX.cur.d.push(+depth.toFixed(3)); EX.cur.t.push(Math.round(Math.hypot(ev.tiltX || 0, ev.tiltY || 0))); }
      // punctures land every (hand speed / machine speed) along the skin; `hand` scales screen speed to a tattooing hand's
      const gap = gapMm(pen.speed) / z * mm;
      let t = pen.carry;
      while (t <= d) {
        const q = { x: pen.last.x + dx * t / d, y: pen.last.y + dy * t / d };
        let inkC = st.tool === 'erase' ? 1 : Math.sqrt(Math.min(1, st.ink.v * 1.6));
        if (st.tool !== 'erase' && pen.cx.pig) {
          const t0 = trAt(q);
          if (t0 > 1.4) inkC *= Math.max(0.3, 1 - (t0 - 1.4) * 0.6) * (Math.random() < Math.min(0.5, (t0 - 1.6) * 0.5) ? 0 : 1);   // chewed skin: patchy
          trAdd(q, pen.foot, 0.007 * Math.pow(depth, 4) / (cal.tough || 1));   // tough skin: light passes barely work it; digging in does
          const risk = Math.max(0, Math.min(1, (0.035 - gapMm(pen.speed)) / 0.025)) * Math.max(0, Math.min(1, (depth - 0.8) / 0.15)) * (cal.blow ?? 1);   // a normal line lands ~0.1 mm apart; slowing into a curve is fine, stalling while digging in is not
          if (risk > 0.04 && pen.trav > 1.5 && Math.random() < Math.min(1, risk)) { blowAt(q, Math.min(1, risk), pen.foot);
            if (!told.blow) { told.blow = 1; toast('Blowout: pressing too hard while pulling slowly pushes ink under the skin.', 3500); } }
          if (t0 > 1.6 && !told.over) { told.over = 1; toast('Overworked: the skin there is chewed up and won\u2019t take ink well.', 3500); }
        }
        puncture(pen.cx, q, pageTurn(pen.a, ev), st.tool === 'erase' ? 1 : depth, tilt, inkC, st.tool === 'erase');
        if (st.tool !== 'erase') st.ink.v = Math.max(0, st.ink.v - 0.000008 * lay.length * depth * feel.flow / 100);
        t += gap;
      }
      pen.carry = t - d; pen.last = p; pen.t = ev.timeStamp;
    }
    flushPig(); st.dirty = true; paint(); drawNeedleInk();
  };
  const strokeEnd = () => { if (pen?.raf) cancelAnimationFrame(pen.raf); strokeFlush(); pen = null; drawNeedleInk(); };

  const cur = $('#tt-cur'), cux = cur.getContext('2d'); let curAt = null;
  const drawCur = (e) => {
    const r = stage.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    if (cur.width !== Math.round(r.width * dpr)) { cur.width = Math.round(r.width * dpr); cur.height = Math.round(r.height * dpr); cur.style.width = r.width + 'px'; cur.style.height = r.height + 'px'; }
    cux.setTransform(1, 0, 0, 1, 0, 0); cux.clearRect(0, 0, cur.width, cur.height);
    if (e) curAt = { x: e.clientX - r.left, y: e.clientY - r.top, ev: e };
    if (!curAt || pinch || pan || st.tool === 'erase' && false) return;
    const s = k * mm, a = pageTurn(pen?.a || 0, curAt.ev) + st.rot, ca = Math.cos(a), sa = Math.sin(a), rr = Math.max(1.2, feel.size / 2 * s * 0.8);
    cux.setTransform(dpr, 0, 0, dpr, 0, 0); cux.lineWidth = 1;
    if (isMag()) {   // the row's line, so its angle reads even when the needles are tiny on screen
      const us = lay.map(n => n.u), u0 = Math.min(...us) * s - 6, u1 = Math.max(...us) * s + 6;
      cux.strokeStyle = 'rgba(31,182,166,.9)'; cux.lineWidth = 2; cux.beginPath();
      cux.moveTo(curAt.x + u0 * -sa, curAt.y + u0 * ca); cux.lineTo(curAt.x + u1 * -sa, curAt.y + u1 * ca); cux.stroke(); cux.lineWidth = 1;
    }
    for (const nd of lay) { const px = curAt.x + nd.u * s * -sa + nd.v * s * ca, py = curAt.y + nd.u * s * ca + nd.v * s * sa;
      cux.beginPath(); cux.arc(px, py, rr, 0, 7); cux.fillStyle = 'rgba(255,255,255,.35)'; cux.fill(); cux.strokeStyle = 'rgba(0,0,0,.55)'; cux.stroke(); }
  };
  cv.addEventListener('pointerleave', () => { curAt = null; drawCur(); });

  /* ---------- Pointer: pen draws; fingers move the page (or draw too, when allowed) ---------- */
  const pts = new Map(); let pinch = null, pan = null, space = false;
  cv.addEventListener('pointerdown', (e) => {
    closePop(); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = stage.getBoundingClientRect();
    if (pts.size === 2) { if (pen) { hist.length && undoTo(hist.pop()); pen = null; }   // a second finger: that was a pinch, not a stroke
      const [a, b] = [...pts.values()], mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z, ang: Math.atan2(b.y - a.y, b.x - a.x), rot: st.rot, p: fromScreen(mx, my), snapped: null }; return; }
    cv.setPointerCapture(e.pointerId);
    const touch = e.pointerType === 'touch';
    if (space || e.button === 1 || (touch && cal.penOnly)) { pan = { x: e.clientX, y: e.clientY, vx, vy }; return; }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (strokeStart(e)) strokeMove(e);
  });
  cv.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) { const [a, b] = [...pts.values()], r = stage.getBoundingClientRect(), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      z = Math.max(0.5, Math.min(12, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)); k = fitK * z;
      let rot = pinch.rot + Math.atan2(b.y - a.y, b.x - a.x) - pinch.ang;
      const q90 = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2), near = Math.abs(rot - q90) < 7 * Math.PI / 180;   // snap at every 90 degrees
      if (near) { rot = q90; if (pinch.snapped !== q90) { pinch.snapped = q90; navigator.vibrate?.(12); } } else pinch.snapped = null;
      st.rot = rot; pinTo(pinch.p, mx, my); st.dirty = true; return paint(); }
    if (pan) { vx = pan.vx + e.clientX - pan.x; vy = pan.vy + e.clientY - pan.y; return paint(); }
    if (pen && e.pointerId === pen.id) strokeMove(e);
    if (e.pointerType !== 'touch') { const pr = e.getPredictedEvents?.(); drawCur(pen && pr?.length ? pr[pr.length - 1] : e); }
    calLive(e);
  });
  const up = (e) => { pts.delete(e.pointerId); if (pinch && pts.size < 2) pinch = null; pan = null; if (pen && e.pointerId === pen.id) strokeEnd(); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  const keys = (e) => { if (!document.body.contains(el)) { removeEventListener('keydown', keys); removeEventListener('keyup', keys); return; }
    if (e.target.matches?.('input, textarea')) return;
    if (e.key === ' ') { space = e.type === 'keydown'; e.preventDefault(); }
    if (e.type === 'keydown' && (e.key === '[' || e.key === ']') && isMag()) { setAng(st.magAng + (e.key === ']' ? 15 : -15)); }
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); } };
  addEventListener('keydown', keys); addEventListener('keyup', keys);
  stage.querySelector('.tt-zoom').onclick = (e) => { const b = e.target.closest('[data-z]'); if (!b) return;
    if (b.dataset.z === 'fit') { z = 1; vx = vy = 0; k = fitK; st.rot = 0; return paint(); } const r = stage.getBoundingClientRect(); zoomAt(z * (b.dataset.z === 'in' ? 1.4 : 1 / 1.4), r.width / 2, r.height / 2); };

  const undoTo = (h) => { L[h.key].getContext('2d').putImageData(h.data, 0, 0); syncIn(h.key);
    if (h.tr) { TR.set(h.tr); trDirty = true; } if (h.blow) bx.putImageData(h.blow, 0, 0); st.dirty = true; paint(); };
  const swap = (from, to) => { const h = from.pop(); if (!h) return false; to.push(state(h.key)); undoTo(h); return true; };
  const undo = () => swap(hist, fut) || toast('Nothing to undo.');
  const redo = () => swap(fut, hist) || toast('Nothing to redo.');

  /* ---------- Ink caps: hold to dip (the longer, the more of that colour), tap the cup to rinse ---------- */
  const tray = $('#tt-tray');
  const drawTray = () => {
    tray.innerHTML = `<button class="tt-set" data-set data-tip="Switch between colour inks and grey wash" aria-label="Ink set">${st.wash ? 'Wash' : 'Inks'}</button>
      <button class="tt-cup" data-rinse data-tip="Rinse: clean the needle" aria-label="Rinse"></button>
      ${st.wash ? TT_WASH.map(([n, s], i) => `<button class="tt-cap tt-wcap" data-wash="${i}" style="--c:rgba(20,20,20,${s})" data-tip="${n} wash" aria-label="${n} wash"><i></i></button>`).join('')
        : st.caps.map((c, i) => `<button class="tt-cap" data-cap="${i}" style="--c:${c}" aria-label="Ink cap"><i></i></button>`).join('')}
      <button class="tt-load" id="tt-load" data-tip="Ink on the needle" aria-label="Ink on the needle"><i></i><span></span></button>
      <button class="dz-ib tt-capedit ${st.capEdit ? 'on' : ''}" ${st.wash ? 'hidden' : ''} data-capedit data-tip="Change the ink colours" aria-label="Change ink colours"><svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19z"/></svg></button>`;
    drawNeedleInk();
  };
  const drawNeedleInk = () => { const b = $('#tt-load'); if (!b) return; b.querySelector('i').style.background = st.ink.v > 0.01 ? ttToHex(st.ink.c) : 'transparent'; b.querySelector('i').style.opacity = st.ink.s ?? 1;
    b.style.setProperty('--v', Math.round(st.ink.v * 100) + '%'); b.querySelector('span').textContent = Math.round(st.ink.v * 100) + '%'; };
  let dip = null;
  tray.addEventListener('pointerdown', (e) => {
    const cap = e.target.closest('[data-cap], [data-wash]'); if (!cap) return;
    const i = +(cap.dataset.cap ?? cap.dataset.wash), ws = cap.dataset.wash != null ? TT_WASH[i][1] : 1;
    if (st.capEdit && !st.wash) { const inp = document.createElement('input'); inp.type = 'color'; inp.value = st.caps[i];
      inp.oninput = () => { st.caps[i] = inp.value; st.dirty = true; drawTray(); }; inp.click(); return; }
    e.preventDefault(); const col = ws < 1 ? ttHex(TT_CAPS[0]) : ttHex(st.caps[i]); cap.classList.add('dip'); let t0 = performance.now(); if (EX?.cur) EX.cur.dips = (EX.cur.dips || 0) + 1;
    const step = (now) => { if (!dip) return; const dt = Math.min(0.1, (now - t0) / 1000); t0 = now;
      const a = dt * 0.9, frac = a / (st.ink.v + a);   // ink added this moment, and how much of the mix it is
      const wet = st.ink.v > 0.005; st.ink.c = wet ? ttMix(st.ink.c, col, frac) : col; st.ink.s = wet ? (st.ink.s ?? 1) * (1 - frac) + ws * frac : ws; st.ink.v = Math.min(1, st.ink.v + a);
      drawNeedleInk(); dip.raf = requestAnimationFrame(step); };
    dip = { cap, raf: requestAnimationFrame(step) }; st.dirty = true;
  });
  const dipEnd = () => { if (!dip) return; cancelAnimationFrame(dip.raf); dip.cap.classList.remove('dip'); dip = null; };
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => tray.addEventListener(t, dipEnd));
  tray.addEventListener('click', (e) => {
    if (e.target.closest('[data-rinse]')) { st.ink = { c: [1, 1, 1], v: 0, s: 1 }; drawNeedleInk(); return toast('Needle rinsed.', 1200); }
    if (e.target.closest('[data-set]')) { st.wash = !st.wash; st.capEdit = false; st.dirty = true; return drawTray(); }
    if (e.target.closest('[data-capedit]')) { st.capEdit = !st.capEdit; toast(st.capEdit ? 'Tap a cap to change its colour. Tap the pencil again when done.' : 'Done changing colours.', 2200); return drawTray(); }
  });
  tray.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---------- Rail, needles menu and the side panel ---------- */
  const closePop = () => { pop.hidden = true; };
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
    if (r === 'angle') {
      if (!pop.hidden) return closePop();
      pop.innerHTML = `<div class="gh">Magnum angle</div><div class="tt-angs">${[0, 30, 45, 60, 90, 120, 135, 150].map(v => `<button data-ang="${v}" class="${st.magAng === v ? 'on' : ''}">
          <svg viewBox="0 0 24 24"><path d="M5 12h14" stroke-width="3" transform="rotate(${v} 12 12)"/></svg>${v}°</button>`).join('')}</div>
        <label class="dz-sl" style="margin:6px 6px 2px"><span>Fine<b id="tt-angv">${st.magAng}°</b></span><input type="range" min="0" max="179" step="1" value="${st.magAng}" data-angr></label>
        <label class="toggle" style="display:flex;margin:2px 6px 6px;border:0;min-height:30px;padding:0"><input type="checkbox" data-angt ${st.magTilt ? 'checked' : ''}><span>Follows the way the pen leans</span></label>`;
      pop.hidden = false; pop.style.top = Math.max(8, b.getBoundingClientRect().top - stage.getBoundingClientRect().top - 6) + 'px'; return;
    }
    closePop();
    if (r === 'needle' || r === 'erase') { st.tool = r === 'erase' ? 'erase' : 'needle'; return sel(); }
    st.panel = st.panel === r ? null : r; drawSide();
  };
  pop.onclick = (e) => {
    const g = e.target.closest('[data-ang]'); if (g) { setAng(+g.dataset.ang); pop.querySelectorAll('[data-ang]').forEach(x => x.classList.toggle('on', x === g)); return; }
    const b = e.target.closest('[data-nd]'); if (!b) return; setNeedle(b.dataset.nd); st.tool = 'needle'; closePop(); sel(); if (st.panel === 'feel') drawSide(); };
  pop.oninput = (e) => {
    if (e.target.matches('[data-angr]')) { setAng(+e.target.value); pop.querySelectorAll('[data-ang]').forEach(x => x.classList.toggle('on', +x.dataset.ang === st.magAng)); }
    if (e.target.matches('[data-angt]')) { st.magTilt = e.target.checked; st.dirty = true; drawAng(); }
  };
  function setAng(v) { st.magAng = ((Math.round(v) % 180) + 180) % 180; st.dirty = true; const l = $('#tt-angv'); if (l) l.textContent = st.magAng + '°'; const r = pop.querySelector('[data-angr]'); if (r) r.value = st.magAng; drawAng(); drawCur(); }
  function drawAng() { const b = $('#tt-rail [data-r="angle"]'); if (!b) return; b.hidden = !isMag();
    $('#tt-angi').setAttribute('transform', `rotate(${st.magAng} 12 12)`); $('#tt-angl').textContent = st.magTilt ? 'pen' : st.magAng + '°'; }
  const slider = (key, label, min, max, step, val, fmt) => `<label class="dz-sl"><span>${label}<b>${fmt ? fmt(val) : val}</b></span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-f="${key}"></label>`;
  const setProfile = (k) => { const p = TT_PROFILES.find(x => x[0] === k); if (!p) return; cal.profile = k; cal.hand = p[2]; cal.fade = p[3]; cal.voltOff = p[4]; };
  const cslider = (key, label, min, max, step, val, fmt) => `<label class="dz-sl"><span>${label}<b>${fmt(val)}</b></span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-c="${key}"></label>`;
  const CFMT = { curve: v => v < 0 ? 'soft ' + -v : v > 0 ? 'firm ' + v : 'even', pMin: v => Math.round(v * 100) + '%', pMax: v => Math.round(v * 100) + '%', hand: v => '× ' + v, fade: v => '× ' + v, flow: v => '× ' + v, tilt0: v => v + '°', blow: v => +v ? '× ' + v : 'off', tough: v => '× ' + v };
  const curveSvg = (c) => `<svg class="tt-curve" viewBox="0 0 100 100"><path d="M0 100 ${[...Array(21)].map((_, i) => `L${i * 5} ${100 - curve(i / 20, c) * 100}`).join(' ')}"/></svg>`;
  const drawSide = async () => {
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
    side.innerHTML = `<div class="dz-lh"><b>${nd.id} feel ${help('Every grouping keeps its own settings. Pressure sets depth (darker, wider, fewer missed punctures); hand speed sets how far apart the punctures land; tilt spreads the needles.')}</b>
        <button class="dz-ib" data-close data-tip="Close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <canvas class="tt-pad" id="tt-pad" width="560" height="200"></canvas>
      <div class="tt-live" id="tt-live">Pressure – · Speed – · Tilt –</div>
      <div class="row" style="gap:6px;margin:6px 0 10px"><button class="btn small" data-padclear>Clear the pad</button><button class="btn small primary" data-tune>Tune in (guided)</button></div>
      ${fsec('All needles', `<p class="muted" style="font-size:11px;margin:0 0 6px">Your calibration for this device. Tune in sets these from a few short tasks.</p>
        <div class="lbl">Your hand speed</div><div class="tt-prof">${TT_PROFILES.map(([k, n]) => `<button data-prof="${k}" class="${cal.profile === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        ${cslider('curve', 'Pressure curve', -100, 100, 1, cal.curve, v => v < 0 ? 'soft ' + -v : v > 0 ? 'firm ' + v : 'even')}
        ${cslider('pMin', 'Lightest pen reading', 0, 0.9, 0.01, cal.pMin, v => Math.round(v * 100) + '%')}${cslider('pMax', 'Hardest pen reading', 0.1, 1, 0.01, cal.pMax, v => Math.round(v * 100) + '%')}
        ${cslider('hand', 'Hand speed', 0.1, 5, 0.05, cal.hand, v => '× ' + v)}${cslider('fade', 'Fast strokes lighten', 0.1, 5, 0.05, cal.fade, v => '× ' + v)}
        ${cslider('flow', 'Ink flow', 0.3, 3, 0.05, cal.flow, v => '× ' + v)}${cslider('tilt0', 'Natural angle', 0, 50, 1, cal.tilt0, v => v + '°')}
        ${cslider('blow', 'Blowout sensitivity', 0, 3, 0.05, cal.blow ?? 1, v => +v ? '× ' + v : 'off')}${cslider('tough', 'Skin toughness', 0.3, 3, 0.05, cal.tough ?? 1, v => '× ' + v)}
        <button class="btn small" data-calreset>Reset all needles' calibration</button>`, { fold: true })}
      <div class="lbl" style="margin-top:8px">${nd.id} only</div>
      <div class="lbl">Pressure → depth</div>
      <div class="tt-crow">${curveSvg(f.pCurve)}<div style="flex:1">${slider('pCurve', 'Curve', -100, 100, 1, f.pCurve, v => v < 0 ? 'soft ' + -v : v > 0 ? 'firm ' + v : 'even')}
        ${slider('dMin', 'Lightest', 0, 1, 0.01, f.dMin, v => Math.round(v * 100) + '%')}${slider('dMax', 'Deepest', 0, 1, 0.01, f.dMax, v => Math.round(v * 100) + '%')}</div></div>
      <div class="lbl">Speed</div>
      ${slider('volt', 'Voltage', 5, 10, 0.05, f.volt ?? 7, v => (+v).toFixed(2) + ' V')}
      ${slider('hand', 'Hand speed', 2, 100, 1, f.hand, v => v + '%')}
      ${slider('speedFade', 'Fast strokes lighten', 0, 100, 1, f.speedFade, v => v + '%')}
      <div class="lbl">Tilt</div>
      ${slider('tiltSpread', 'Tilt spreads', 0, 100, 1, f.tiltSpread, v => v + '%')}${slider('tiltFade', 'Tilt lightens', 0, 100, 1, f.tiltFade, v => v + '%')}
      <div class="lbl">Ink</div>
      ${slider('flow', 'Ink flow', 5, 100, 1, f.flow, v => v + '%')}${slider('bleed', 'Bleed into skin', 0, 100, 1, f.bleed, v => v + '%')}
      ${slider('miss', 'Missed punctures when light', 0, 100, 1, f.miss, v => v + '%')}
      ${slider('hang', 'Needle hang', 0, 100, 1, f.hang ?? 40, v => v + '%')}
      <div class="lbl">Skin</div>
      <label class="dz-sl"><span>Skin stretch<b>${st.stretch}%</b></span><input type="range" min="0" max="100" step="1" value="${st.stretch}" data-stretch></label>
      <div class="lbl">Needle size</div><div class="seg" style="margin-bottom:8px">${[[0.25, '#08'], [0.3, '#10'], [0.35, '#12']].map(([v, n]) => `<button data-sz="${v}" class="${f.size === v ? 'on' : ''}" style="flex:1">${n} · ${v} mm</button>`).join('')}</div>
      <label class="toggle" style="display:inline-flex"><input type="checkbox" data-penonly ${TT.cal().penOnly ? 'checked' : ''}><span>Pen only (fingers move the page)</span></label>
      <div class="row" style="margin-top:8px"><button class="btn small" data-feelreset>Reset ${nd.id}</button></div>`;
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
      if (t.closest('[data-clear]')) { if (!confirm('Clear everything on this layer? Undo brings it back.')) return;
        const c = L[ly]; snap(ly); c.getContext('2d').clearRect(0, 0, W, H); syncIn(ly); st.dirty = true; paint(); return; }
      if (t.closest('[data-stl]')) return loadStencil();
      if (t.matches('input')) return;
      st.layer = ly; st.dirty = true; return drawSide();
    }
    if (t.closest('[data-sz]')) { feel.size = +t.closest('[data-sz]').dataset.sz; TT.setFeel(st.needle, feel); lay = ttLayout(TT_NEEDLES.find(n => n.id === st.needle), feel.size); return drawSide(); }
    if (t.closest('[data-feelreset]')) { TT.setFeel(st.needle, null); setNeedle(st.needle); return drawSide(); }
    if (t.closest('[data-padclear]')) return padInit();
    if (t.closest('[data-tune]')) return tuneIn();
    if (t.closest('[data-prof]')) { setProfile(t.closest('[data-prof]').dataset.prof); TT.saveCal(cal); return drawSide(); }
    if (t.closest('[data-calreset]')) { if (!confirm('Put the calibration for all needles back to the defaults?')) return; cal = { ...TT.calDefaults, penOnly: cal.penOnly }; TT.saveCal(cal); return drawSide(); }
    if (t.matches('[data-penonly]')) { cal.penOnly = t.checked; TT.saveCal(cal); }
  });
  $('#tt-vs').addEventListener('input', (e) => { feel.volt = +e.target.value; TT.setFeel(st.needle, feel); drawVolt();
    const s2 = side.querySelector('[data-f="volt"]'); if (s2) { s2.value = feel.volt; s2.closest('.dz-sl').querySelector('b').textContent = feel.volt.toFixed(2) + ' V'; } });
  side.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-rop]')) { const r = refs.find(x => x.id === t.closest('[data-rid]').dataset.rid); if (r) { r.op = +t.value; st.dirty = true; drawRefs(); } return; }
    if (t.matches('[data-lop]')) { const ly = t.closest('[data-ly]').dataset.ly; st.op[ly] = +t.value; st.dirty = true; st.viewC = null; return paint(); }
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
        const tilt = tiltOf(q), depth = depthOf(pNorm(q), sp, tilt), gap = gapMm(sp) * pm, a = turnOf(Math.atan2(dy, dx), q);
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
        cal.hand = +Math.max(0.1, Math.min(10, want / f0.hand)).toFixed(3); let msg = `You line at about ${Math.round(v)} mm/s; punctures now land close enough there for a solid line.`;
        if (ps.length > 20) { const pm = Math.max(0.05, Math.min(0.97, pct(ps, 0.5))), g2 = Math.log(0.85) / Math.log(pm);
          cal.curve = +Math.max(-100, Math.min(100, 50 * Math.log2(g2) - f0.pCurve)).toFixed(1); msg += ` Your normal lining pressure (${Math.round(pm * 100)}% of your range) now goes in firmly.`; }
        return msg; } },
    { id: 'shade', title: 'Whip shading', needle: '7RS', text: 'Shade the empty box to match the example: start each stroke slow and pressed in at the dark (left) end, and flick out fast and light to the right.',
      under: (g) => { g.drawImage(example('whip'), 0, 0); outline(g, box); label(g, 'example', exBox.x, exBox.y - 12); label(g, 'yours', box.x, box.y - 12); },
      fit(pad) { const sp = speeds(pad); if (sp.length < 20) return 'Not enough shading to measure: do several strokes.';
        const v = pct(sp, 0.9), want = 0.75 * 200 * 100 / v;   // your flick speed fades the needle to about a quarter
        cal.fade = +Math.max(0.1, Math.min(10, want / feel.speedFade)).toFixed(3); fades.whip = cal.fade;
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
        const v = mids.reduce((a, b) => a + b, 0) / mids.length, want = 0.45 * 200 * 100 / v;   // mid-swing: a little lighter than a held stroke
        const pf = Math.max(0.1, Math.min(10, want / feel.speedFade)); fades.pend = pf;
        cal.fade = +(fades.whip ? (fades.whip + pf) / 2 : pf).toFixed(3);
        return `${mids.length} swings at about ${Math.round(v)} mm/s through the middle. ${fades.whip ? 'Fast strokes now fade halfway between your whip shading and your pendulum.' : 'Fast strokes now fade to suit your swing.'}`; } },
    { id: 'tilt', title: 'How you hold it', needle: '3RL', text: 'Draw a few lines holding the pen the way you hold your machine.',
      under: (g) => { g.strokeStyle = 'rgba(70,40,120,.4)'; g.lineWidth = 2; for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(100 + i * 200, 320); g.lineTo(220 + i * 200, 80); g.stroke(); } },
      fit(pad) { const ts = pad.strokes.flat().filter(q => q.pointerType === 'pen').map(q => Math.hypot(q.tiltX || 0, q.tiltY || 0)); if (ts.length < 20 || pct(ts, 0.9) < 2) return 'This pen doesn\u2019t report tilt (or it was held straight up), so tilt stays as it was.';
        cal.tilt0 = Math.round(Math.max(0, Math.min(50, pct(ts, 0.5)))); return `You hold it at about ${cal.tilt0}\u00b0; tilt now counts from there, so your normal grip doesn't spread the needles.`; } },
    { id: 'pack', title: 'Packing', needle: '15CM', pm: 10, manual: true,
      text: 'Pack the small box solid with your usual colour-packing technique, for example small, tight circles that overlap, until it looks like the example. The saturation shows as you go; press Check when you would call it done.',
      under: (g) => { g.drawImage(example('pack'), 0, 0); outline(g, pbox); label(g, 'example', pex.x, pex.y - 12); label(g, 'yours', pbox.x, pbox.y - 12); },
      live: (pad) => `Saturation ${Math.round(sat(pad) * 100)}%`,
      fit(pad) { if (!pad.strokes.length) return 'Pack the box first.';
        const cov = sat(pad);
        const before = cal.flow; if (cov < 0.88) cal.flow = +Math.min(3, cal.flow * 0.9 / Math.max(0.2, cov)).toFixed(3); else if (cov > 0.98) cal.flow = +Math.max(0.4, cal.flow * 0.95).toFixed(3);
        const v = pct(speeds(pad), 0.5), fast = v > 150 ? ` You packed fast (about ${Math.round(v)} mm/s): slower, overlapping passes go in darker, as on skin.` : '';
        return `Your packing covered ${Math.round(cov * 100)}% of the box.${fast} ${cal.flow > before ? 'Ink now goes in a little more readily.' : cal.flow < before ? 'Ink now goes in a touch less readily.' : 'That\u2019s about right, so ink flow stays.'}`; } }
  ];
  const tuneIn = () => {
    const keep = { needle: st.needle, stretch: st.stretch, ink: st.ink }, was = { ...cal }; st.stretch = 75;
    const o = document.createElement('div'); o.id = 'merge-dlg'; o.className = 'tt-tune'; o.style.zIndex = 98; document.body.appendChild(o);
    let i = -1, pad = null, msg = '', before = null;
    const finish = () => { setNeedle(keep.needle); st.stretch = keep.stretch; st.ink = keep.ink; o.remove(); drawSide(); };
    const draw = () => {
      if (i >= TUNE.length) {
        const rows = [['Hand speed setting', TT_PROFILES.find(p => p[0] === cal.profile)?.[1] || ''], ['Pressure range', `${Math.round(cal.pMin * 100)}–${Math.round(cal.pMax * 100)}%`], ['Pressure curve', cal.curve > 0 ? 'firm ' + Math.round(cal.curve) : cal.curve < 0 ? 'soft ' + Math.round(-cal.curve) : 'even'],
          ['Hand speed', '× ' + cal.hand], ['Voltage offset', (cal.voltOff >= 0 ? '+' : '') + (cal.voltOff || 0) + ' V'], ['Fast strokes lighten', '× ' + cal.fade], ['Natural angle', cal.tilt0 + '°'], ['Ink flow', '× ' + cal.flow]];
        o.innerHTML = `<div class="card tt-tcard"><h2>Tuned in</h2><p class="muted" style="margin-top:0">These apply to every needle on this device. Each needle's own settings still sit on top, under the sliders icon.</p>
          <div class="tt-sum">${rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('')}</div>
          <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:12px"><button class="btn" data-t="again">Start over</button><button class="btn" data-t="copy" data-tip="Copy these settings to send on, to help tune the defaults">Copy settings</button>
            <span style="flex:1"></span><button class="btn" data-t="cancel">Undo all</button><button class="btn primary" data-t="save">Save</button></div></div>`;
        return;
      }
      if (i < 0) {
        o.innerHTML = `<div class="card tt-tcard"><h2>Your hand speed</h2><p class="muted" style="margin-top:0">How fast you work compared to other artists. This sets where every needle starts (hand speed, fading and voltage); the tasks after it fine tune from there.</p>
          <div class="tt-prof big">${TT_PROFILES.map(([k, n]) => `<button data-prof="${k}" class="${cal.profile === k ? 'on' : ''}">${n}</button>`).join('')}</div>
          <div class="row" style="gap:6px;margin-top:14px"><span style="flex:1"></span><button class="btn" data-t="exit">Stop</button><button class="btn primary" data-t="next">Start</button></div></div>`;
        return;
      }
      const T = TUNE[i]; setNeedle(T.needle);
      o.innerHTML = `<div class="card tt-tcard"><div class="tt-tsteps">${TUNE.map((x, j) => `<i class="${j < i ? 'done' : j === i ? 'on' : ''}"></i>`).join('')}</div>
        <h2>${i + 1}. ${T.title}</h2><p class="muted" style="margin:0 0 8px">${T.text}</p>
        <canvas class="tt-tpad" width="${W2}" height="${H2}"></canvas>
        <p class="tt-tmsg">${msg || '&nbsp;'}</p>
        <div class="row" style="gap:6px"><button class="btn" data-t="skip">Skip</button><button class="btn" data-t="redo">Try again</button><span style="flex:1"></span>
          <button class="btn" data-t="exit">Stop</button>${T.manual && !msg ? '<button class="btn" data-t="check">Check</button>' : ''}<button class="btn primary" data-t="next" ${msg ? '' : 'disabled'}>${msg ? (i === TUNE.length - 1 ? 'Finish' : 'Next') : 'Draw first'}</button></div></div>`;
      pad = skinPad(o.querySelector('canvas'), T.pm || PM2, T.under); pad.color = '#161616';
      before = { ...cal };
      const fitNow = () => { Object.assign(cal, before); msg = T.fit(pad); pad.replay(); o.querySelector('.tt-tmsg').textContent = msg + (T.live ? ' ' + T.live(pad) + ' with the new settings.' : '');
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
      if (a === 'skip') { Object.assign(cal, before || cal); i++; msg = ''; return draw(); }
      if (a === 'redo') { Object.assign(cal, before); msg = ''; return draw(); }
      if (a === 'exit' || a === 'cancel') { Object.assign(cal, was); return finish(); }
      if (a === 'again') { Object.assign(cal, { ...TT.calDefaults, penOnly: cal.penOnly }); i = -1; msg = ''; return draw(); }
      if (a === 'save') { TT.saveCal(cal); Settings.set('tt_tuned', '1'); toast('Saved: every needle now uses your calibration.'); return finish(); }
      if (a === 'copy') {
        const txt = JSON.stringify({ inkforge_tattoo_tune: 1, cal: { ...cal }, device: { ua: navigator.userAgent, screen: [screen.width, screen.height], dpr: devicePixelRatio }, feel: JSON.parse(Settings.get('tt_feel', '{}')) });
        try { await navigator.clipboard.writeText(txt); toast('Settings copied. Paste them into a message to send on.'); } catch { prompt('Copy these settings:', txt); }
      }
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
    const c = L.stencil, cx = c.getContext('2d'); snap('stencil');
    cx.clearRect(0, 0, W, H); const s = Math.min(W * 0.9 / im.naturalWidth, H * 0.9 / im.naturalHeight), w = im.naturalWidth * s, h = im.naturalHeight * s;
    cx.drawImage(im, (W - w) / 2, (H - h) / 2, w, h); st.hide.delete('stencil'); st.dirty = true; paint(); drawSide();
  };

  /* ---------- Saving and exporting ---------- */
  // The piece as one picture. `mode`: as worked or fresh (with the worked skin), healed or aged (blowouts stay).
  const composite = (scale = 1, withSkin = true, mode = 'work') => {
    const c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale); const g = c.getContext('2d'); g.scale(scale, scale);
    const raw = mode === 'work' || mode === 'fresh';
    if (withSkin) { if (raw && trDirty) buildTrauma(); g.drawImage(skin, 0, 0); skinUnder(g, raw); }
    for (const key of TT_DRAW) { if (key === 'stencil' || st.hide.has(key)) continue; g.globalAlpha = st.op[key] ?? 1; g.globalCompositeOperation = key === 'high' || !withSkin ? 'source-over' : 'multiply'; g.drawImage(L[key], 0, 0); }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; if (withSkin && raw) skinOver(g);
    return c;
  };
  const blobOf = (c) => new Promise(r => c.toBlob(r, 'image/png'));
  const save = async (quiet) => {
    const layerRefs = {}; for (const [key] of TT_LAYERS) layerRefs[key] = await Media.save(await blobOf(L[key]), 'png');
    const thumb = await Media.save(await blobOf(composite(Math.min(1, 420 / Math.max(W, H)))), 'png');
    const tc = document.createElement('canvas'); tc.width = tw; tc.height = th; const tg = tc.getContext('2d'), ti = tg.createImageData(tw, th);
    for (let i = 0; i < TR.length; i++) { const v = Math.min(255, Math.round(TR[i] / 2 * 255)); ti.data[i * 4] = ti.data[i * 4 + 1] = ti.data[i * 4 + 2] = v; ti.data[i * 4 + 3] = 255; }
    tg.putImageData(ti, 0, 0);
    const skinRef = TR.some(v => v > 0.004) ? await Media.save(await blobOf(tc), 'png') : null, blowRef = await Media.save(await blobOf(blowC), 'png');
    const old = await DB.one('SELECT * FROM tattoo_pieces WHERE id = ?', [id]);
    await DB.run(`UPDATE tattoo_pieces SET name = ?, ${TT_LAYERS.map(([key]) => key + '_ref = ?').join(', ')}, thumb_ref = ?, skin_ref = ?, blow_ref = ?, meta = ?, updated_at = datetime('now') WHERE id = ?`,
      [$('#tt-name')?.value.trim() || st.name, ...TT_LAYERS.map(([key]) => layerRefs[key]), thumb, skinRef, blowRef,
        JSON.stringify({ layer: st.layer, needle: st.needle, hide: [...st.hide], op: st.op, ink: ttToHex(st.ink.c), inkV: st.ink.v, inkS: st.ink.s ?? 1, wash: st.wash || undefined, caps: st.caps, stretch: st.stretch, magAng: st.magAng, magTilt: st.magTilt, rot: st.rot, refs: refs.map(({ _u, ...r }) => r), exam: EX || undefined }), id]);
    if (old) for (const r of [old.thumb_ref, old.skin_ref, old.blow_ref, ...TT_LAYERS.map(([key]) => old[key + '_ref'])]) if (r && !Object.values(layerRefs).includes(r) && ![thumb, skinRef, blowRef].includes(r)) await Media.release(r);
    st.dirty = false; if (!quiet) toast('Saved.');
  };
  $('#tt-save').onclick = () => save();
  $('#tt-back').onclick = async () => { if (st.dirty) await save(true); location.hash = 'tattoo'; };
  /* Autosave: leaving by any route (the device's back button too), the app going to the background, and every
     40 s of work, so a slip never loses a piece. */
  let saving = null;
  const autosave = () => { if (!st.dirty || saving || pen) return; saving = save(true).catch(() => {}).finally(() => { saving = null; }); };
  const onHash = () => { if (location.hash !== '#tattoo/' + id) { removeEventListener('hashchange', onHash); document.removeEventListener('visibilitychange', onVis); clearInterval(autoT); autosave(); } };
  const onVis = () => { if (document.visibilityState === 'hidden') autosave(); };
  const autoT = setInterval(() => { if (!document.body.contains(el)) return onHash(); autosave(); }, 40000);
  addEventListener('hashchange', onHash); document.addEventListener('visibilitychange', onVis);
  $('#tt-name').onchange = () => { st.dirty = true; };
  $('#tt-undo').onclick = undo; $('#tt-redo').onclick = redo;
  const VIEWS = [['work', ''], ['fresh', 'Fresh'], ['healed', 'Healed'], ['aged', '10 yrs']];
  const drawView = () => { const b = $('#tt-view'); if (!b) return; b.querySelector('b').textContent = VIEWS.find(v => v[0] === st.view)[1]; b.classList.toggle('on', st.view !== 'work'); };
  $('#tt-view').onclick = () => { const i = VIEWS.findIndex(v => v[0] === st.view); st.view = VIEWS[(i + 1) % VIEWS.length][0]; st.viewC = null; drawView(); paint();
    toast({ work: 'As you worked it', fresh: 'Fresh: just tattooed, the skin around it red and raised', healed: 'Healed: settled into the skin, a touch softer', aged: 'After about 10 years: softer edges and faded colour' }[st.view], 2400); };
  $('#tt-png').onclick = async () => { const a = document.createElement('a'); a.href = URL.createObjectURL(await blobOf(composite())); a.download = (($('#tt-name').value || 'tattoo').replace(/[^\w-]+/g, '_')) + '.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
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
  async function refUrl(r) { if (r._u) return r._u; r._u = r.gen ? exGen(r.gen) : await Media.url(r.ref); return r._u; }
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
  let refDrag = null, refTap = null;
  refLay.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-rf]'); if (!el) return; const r = refs.find(x => x.id === el.dataset.rf); if (!r || r.lock) return;
    e.stopPropagation(); e.preventDefault(); refLay.setPointerCapture(e.pointerId);
    const sr = stage.getBoundingClientRect(), px = e.clientX - sr.left, py = e.clientY - sr.top, h = e.target.dataset.rh;
    const now = Date.now(); if (!h && refTap && refTap.id === r.id && now - refTap.t < 320) { r.flip = !r.flip; refTap = null; st.dirty = true; return drawRefs(); }
    refTap = { id: r.id, t: now };
    if (refSel !== r.id) { refSel = r.id; drawRefs(); }
    refDrag = { r, h, px, py, x0: r.x, y0: r.y, w0: r.w, d0: Math.max(1, Math.hypot(px - r.x, py - r.y)), a0: Math.atan2(py - r.y, px - r.x) - (r.rot || 0) * Math.PI / 180 };
  });
  refLay.addEventListener('pointermove', (e) => {
    const d = refDrag; if (!d) return; const sr = stage.getBoundingClientRect(), px = e.clientX - sr.left, py = e.clientY - sr.top, r = d.r;
    if (!d.h) { r.x = d.x0 + px - d.px; r.y = d.y0 + py - d.py; }
    else if (d.h === 'rot') { let a = (Math.atan2(py - r.y, px - r.x) - d.a0) * 180 / Math.PI; const q = Math.round(a / 90) * 90; if (Math.abs(a - q) < 5) a = q; r.rot = Math.round(a); }
    else r.w = Math.max(40, d.w0 * Math.hypot(px - r.x, py - r.y) / d.d0);
    st.dirty = true; drawRefs();
  });
  const refUp = () => { if (refDrag) { refDrag = null; if (st.panel === 'refs') drawSide(); } };
  refLay.addEventListener('pointerup', refUp); refLay.addEventListener('pointercancel', refUp);
  cv.addEventListener('pointerdown', () => { if (refSel) { refSel = null; drawRefs(); } }, true);

  /* ---------- Apprentice exam ----------
     Challenges one at a time on a clean patch of skin, each with its stencil, an example floating beside it and
     the needle to use. Done scores it from the ink in the skin (against the stencil or the example), the skin's
     condition and blowouts, and keeps how the pen was used (pressure, speed, angle) for tuning. The exam is a
     piece of its own: leaving saves it, and opening it carries on where it stopped. */
  const Mm = (g, f) => { g.save(); g.scale(mm, mm); g.beginPath(); f(g); g.restore(); };
  const RED = TT_CAPS[2], YEL = TT_CAPS[3], WHT = TT_CAPS[7];
  const MIX = ttToHex(ttMix(ttHex(RED), ttHex(YEL), 0.55));
  const heart = (g) => { g.moveTo(90, 46); g.bezierCurveTo(88, 28, 60, 26, 58, 46); g.bezierCurveTo(56, 64, 80, 80, 90, 100); g.bezierCurveTo(100, 80, 124, 64, 122, 46); g.bezierCurveTo(120, 26, 92, 28, 90, 46); g.closePath(); };
  const banner = (g) => { g.moveTo(54, 66); g.lineTo(126, 66); g.lineTo(126, 79); g.lineTo(54, 79); g.closePath();
    g.moveTo(54, 68); g.lineTo(41, 66); g.lineTo(46, 74); g.lineTo(41, 82); g.lineTo(54, 79); g.closePath(); g.moveTo(126, 68); g.lineTo(139, 66); g.lineTo(134, 74); g.lineTo(139, 82); g.lineTo(126, 79); g.closePath(); };
  const shine = (g) => { g.ellipse(70, 43, 6.5, 3.2, -0.6, 0, 7); g.closePath(); };
  const CHALL = [
    { id: 'straight', cat: 'line', title: 'Straight lines', needle: '3RL', layer: 'line', ink: 'black', kind: 'line', core: 0.45,
      text: 'Black ink, 3RL. Line the three stencil lines: one steady pull each, solid and even, without going back over them.',
      path: (g) => { for (const y of [35, 65, 95]) { g.moveTo(30, y); g.lineTo(150, y); } } },
    { id: 'curves', cat: 'line', title: 'Curves and a circle', needle: '3RL', layer: 'line', ink: 'black', kind: 'line', core: 0.45,
      text: 'Black ink, 3RL. Follow the S-curve and the circle, keeping the line the same weight all the way round.',
      path: (g) => { g.moveTo(22, 100); g.bezierCurveTo(40, 20, 70, 110, 90, 30); g.moveTo(152, 65); g.arc(128, 65, 24, 0, Math.PI * 2); } },
    { id: 'bold', cat: 'line', title: 'Bold line', needle: '9RL', layer: 'line', ink: 'black', kind: 'line', core: 1.1,
      text: 'Black ink, 9RL. Pull the bold arc solid in one pass, no gaps and no wobble.',
      path: (g) => { g.moveTo(30, 95); g.quadraticCurveTo(90, 10, 150, 95); } },
    { id: 'whip', cat: 'shade', title: 'Whip shading', needle: '7RS', layer: 'shadow', ink: 'black', kind: 'grad', box: [55, 56, 70, 18], prof: (f) => Math.pow(1 - f, 1.4),
      text: 'Black ink, 7RS. Whip shade the box to match the example: dark at the left, fading out to clean skin on the right.' },
    { id: 'smooth', cat: 'shade', title: 'Smooth gradient', needle: '15CM', layer: 'shadow', ink: 'black', kind: 'grad', box: [45, 56, 90, 18], prof: (f) => Math.pow(Math.sin(Math.PI * f), 1.2),
      text: 'Black ink, 15CM. Pendulum shade the box: soft at both ends, darkest through the middle, with no hard edges.' },
    { id: 'pack', cat: 'pack', title: 'Solid black', needle: '15CM', layer: 'shadow', ink: 'black', kind: 'pack', box: [75, 50, 30, 30],
      text: 'Black ink, 15CM. Pack the box solid and even, edge to edge, with your usual technique. Watch the skin: solid, not chewed.' },
    { id: 'colour', cat: 'pack', title: 'Colour packing', needle: '11M1', layer: 'mid', ink: 'red', kind: 'fill', col: RED, shape: (g) => { g.arc(90, 65, 16, 0, Math.PI * 2); },
      text: 'Red ink, 11M1. Pack the circle with solid red, right up to the line and no further.' },
    { id: 'mix', cat: 'colour', title: 'Mix a colour', needle: '11M1', layer: 'mid', ink: 'mix', kind: 'fill', col: MIX, shape: (g) => { g.rect(78, 53, 24, 24); }, colW: 0.75,
      text: 'Mix the colour in the example from the red and yellow caps (dip in one, then the other: the longer the dip, the more of it), then pack the square with it.' },
    { id: 'blend', cat: 'colour', title: 'Colour blend', needle: '15CM', layer: 'mid', ink: 'red, yellow', kind: 'blend', box: [45, 55, 90, 20],
      text: 'Red feathered into yellow, like the example: solid red on the left, feather it out, then saturate yellow into the feathered part and across to the right.' },
    { id: 'final', cat: 'final', title: 'Final piece: traditional heart', needle: '3RL', layer: 'line', ink: 'all', kind: 'final',
      text: 'Tattoo the heart like the reference: line it (black), shade the lower right of the heart (black), pack the heart red and the banner yellow, and put a white highlight in the shine. Use any needles and layers you like.' }
  ];
  // Examples: drawn on skin, for the floating reference beside each challenge.
  function exGen(name) {
    const T = CHALL.find(c => c.id === name); if (!T) return '';
    const c = document.createElement('canvas'), sc = 2; c.width = 180 * sc; c.height = 130 * sc; const g = c.getContext('2d');
    g.fillStyle = st.skin; g.fillRect(0, 0, c.width, c.height); g.scale(sc, sc);
    const dots = (x0, y0, w, h, f, col) => { g.fillStyle = col; for (let i = 0; i < w * h * 3; i++) { const px = x0 + Math.random() * w, py = y0 + Math.random() * h, a = f((px - x0) / w); if (Math.random() < a) { g.globalAlpha = 0.6 + a * 0.4; g.beginPath(); g.arc(px, py, 0.35, 0, 7); g.fill(); } } g.globalAlpha = 1; };
    if (T.kind === 'grad') dots(...T.box, T.prof, '#141414');
    if (T.kind === 'pack') { g.fillStyle = '#161616'; g.fillRect(...T.box); }
    if (T.kind === 'fill') { g.fillStyle = T.col; g.beginPath(); T.shape(g); g.fill(); }
    if (T.kind === 'blend') { const [x0, y0, w, h] = T.box; for (let x = 0; x < w; x += 0.5) { const f = x / w; g.fillStyle = f < 0.3 ? RED : f > 0.7 ? YEL : ttToHex(ttMix(ttHex(RED), ttHex(YEL), (f - 0.3) / 0.4)); g.fillRect(x0 + x, y0, 0.6, h); } }
    if (T.kind === 'final') {
      g.fillStyle = RED; g.beginPath(); heart(g); g.fill();
      const sh = g.createLinearGradient(70, 40, 112, 92); sh.addColorStop(0.45, 'rgba(20,20,20,0)'); sh.addColorStop(1, 'rgba(20,20,20,.85)');
      g.save(); g.beginPath(); heart(g); g.clip(); g.fillStyle = sh; g.fillRect(40, 20, 100, 90); g.restore();
      g.fillStyle = YEL; g.beginPath(); banner(g); g.fill(); g.fillStyle = WHT; g.beginPath(); shine(g); g.fill();
      g.strokeStyle = '#141414'; g.lineWidth = 0.9; g.lineJoin = 'round'; g.beginPath(); heart(g); g.stroke(); g.beginPath(); banner(g); g.stroke(); g.beginPath(); shine(g); g.stroke();
    }
    const [x0, y0, w, h] = exCrop(T), o = document.createElement('canvas'); o.width = w * sc; o.height = h * sc;
    o.getContext('2d').drawImage(c, x0 * sc, y0 * sc, w * sc, h * sc, 0, 0, w * sc, h * sc);
    return o.toDataURL('image/png');
  }
  // The part of the page an example shows (mm): its box or shape, with a margin of skin.
  const exCrop = (T) => T.kind === 'final' ? [34, 20, 112, 88] : T.box ? [T.box[0] - 8, T.box[1] - 8, T.box[2] + 16, T.box[3] + 16] : T.id === 'colour' ? [66, 41, 48, 48] : T.id === 'mix' ? [70, 45, 40, 40] : [0, 0, 180, 130];
  const exStencil = (T) => {
    const g = L.stencil.getContext('2d'); g.clearRect(0, 0, W, H); g.strokeStyle = 'rgba(78,40,150,.9)'; g.lineWidth = 0.32 * mm; g.lineJoin = g.lineCap = 'round';
    if (T.kind === 'line') { Mm(g, T.path); g.stroke(); }
    else if (T.box) { g.setLineDash([2 * mm, 1.5 * mm]); g.strokeRect(T.box[0] * mm, T.box[1] * mm, T.box[2] * mm, T.box[3] * mm); g.setLineDash([]); }
    else if (T.shape) { Mm(g, T.shape); g.stroke(); }
    else if (T.kind === 'final') { Mm(g, heart); g.stroke(); Mm(g, banner); g.stroke(); Mm(g, shine); g.stroke(); }
  };
  const exClear = () => { for (const key of INK) { L[key].getContext('2d').clearRect(0, 0, W, H); syncIn(key); } TR.fill(0); trDirty = true; bx.clearRect(0, 0, blowC.width, blowC.height); hist.length = fut.length = 0; };
  const exStart = (fresh) => {
    const T = CHALL[EX.i]; if (!T) return;
    if (fresh || !EX.cur) { exClear(); EX.cur = { id: T.id, p: [], v: [], d: [], t: [], blow: 0, strokes: 0, dips: 0 }; }
    exStencil(T); st.hide.delete('stencil'); st.op.stencil = 0.6;
    refs = refs.filter(r => !r.gen);
    if (T.kind !== 'line') { const cr = exCrop(T), sr = stage.getBoundingClientRect(), w = Math.max(140, Math.min(280, sr.width * 0.28)), h = w * cr[3] / cr[2];
      refNew({ gen: T.id, ar: cr[3] / cr[2], w, op: 1, x: sr.width - w / 2 - 14, y: Math.min(sr.height - 90 - h / 2, Math.max(150 + h / 2, sr.height / 2)) }); }
    refSel = null;
    setNeedle(T.needle); st.layer = T.layer; st.caps = [...TT_CAPS]; st.view = 'work'; st.viewC = null; z = 1; vx = vy = 0; st.rot = 0; k = fitK;
    drawTray(); drawView(); drawRefs(); exBar(); paint(); st.dirty = true;
  };
  // ---- scoring ----
  const maskOf = (draw, fill, width) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.lineCap = g.lineJoin = 'round';
    g.save(); g.scale(mm, mm); g.beginPath(); draw(g); if (fill) g.fill(); else { g.lineWidth = width; g.stroke(); } g.restore(); return g.getImageData(0, 0, W, H).data; };
  const densAt = (i) => { let keep = 1; for (const key of INK) keep *= 1 - imgd[key].data[i + 3] / 255; return 1 - keep; };
  const colAt = (i) => { let r = 0, g2 = 0, b = 0, w = 0; for (const key of INK) { const D = imgd[key].data, a = D[i + 3] / 255; if (!a) continue; r += D[i] * a; g2 += D[i + 1] * a; b += D[i + 2] * a; w += a; } return w ? [r / w, g2 / w, b / w] : null; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 441;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const lineScore = (draw, coreW) => {
    const core = maskOf(draw, false, coreW), band = maskOf(draw, false, coreW + 2.2), mid = maskOf(draw, false, Math.min(0.2, coreW * 0.4));
    let cn = 0, cin = 0, sum = 0, sum2 = 0, mn = 0, ink = 0, out = 0;
    for (let i = 3; i < core.length; i += 4) { const d = densAt(i - 3);
      if (core[i] > 128) { cn++; if (d > 0.28) cin++; }
      if (mid[i] > 128) { mn++; sum += d; sum2 += d * d; }
      if (d > 0.2) { ink++; if (band[i] < 30) out++; } }
    const mean = sum / Math.max(1, mn), sd = Math.sqrt(Math.max(0, sum2 / Math.max(1, mn) - mean * mean));
    const cov = cin / Math.max(1, cn), spill = out / Math.max(1, ink), cons = 1 - clamp01(sd / 0.65);
    return { score: Math.round(100 * cov * (0.55 + 0.25 * (1 - spill) + 0.2 * cons)), coverage: Math.round(cov * 100), spill: Math.round(spill * 100), evenness: Math.round(cons * 100) };
  };
  const boxIdx = (b) => { const x0 = Math.round(b[0] * mm), y0 = Math.round(b[1] * mm), x1 = Math.round((b[0] + b[2]) * mm), y1 = Math.round((b[1] + b[3]) * mm); return { x0, y0, x1, y1 }; };
  const spillOut = (inside, margin) => { let ink = 0, out = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, d = densAt(i); if (d > 0.2) { ink++; if (!inside(x / mm, y / mm, margin)) out++; } } return out / Math.max(1, ink); };
  const inBox = (b) => (x, y, m = 0) => x >= b[0] - m && x <= b[0] + b[2] + m && y >= b[1] - m && y <= b[1] + b[3] + m;
  const scoreOf = (T) => {
    if (T.kind === 'line') return lineScore(T.path, T.core);
    if (T.kind === 'grad') {   // judged on its shape (scaled to your own darkest) and on getting reasonably dark
      const { x0, y0, x1, y1 } = boxIdx(T.box), cs = [], ts = [];
      for (let x = x0; x < x1; x += 2) { let s2 = 0, m = 0; for (let y = y0; y < y1; y += 2) { s2 += densAt((y * W + x) * 4); m++; } cs.push(s2 / m); ts.push(T.prof((x - x0) / (x1 - x0))); }
      let ct = 0, tt = 0; cs.forEach((c, i) => { ct += c * ts[i]; tt += ts[i] * ts[i]; }); const a = ct / Math.max(1e-6, tt);
      const shape = cs.reduce((e, c, i) => e + Math.abs(c - a * ts[i]), 0) / Math.max(1, cs.length) / Math.max(0.15, a);
      const match = (1 - clamp01(shape * 1.6)) * (0.55 + 0.45 * clamp01(a / 0.7)), sp = spillOut(inBox(T.box), 2.5);
      return { score: Math.round(100 * (0.8 * match + 0.2 * (1 - sp))), match: Math.round(match * 100), darkness: Math.round(clamp01(a) * 100), spill: Math.round(sp * 100) }; }
    if (T.kind === 'pack') { const { x0, y0, x1, y1 } = boxIdx(T.box); let n = 0, cov = 0, s1 = 0, s2 = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const d = densAt((y * W + x) * 4); n++; if (d > 0.75) cov++; s1 += d; s2 += d * d; }
      const mean = s1 / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean)), ev = 1 - clamp01(sd / 0.3), sp = spillOut(inBox(T.box), 1.5);
      return { score: Math.round(100 * (cov / n) * (0.5 + 0.3 * ev + 0.2 * (1 - sp))), coverage: Math.round(cov / n * 100), evenness: Math.round(ev * 100), spill: Math.round(sp * 100) }; }
    if (T.kind === 'fill') { const m = maskOf(T.shape, true), out = maskOf(T.shape, false, 3), want = ttHex(T.col).map(v => v * 255); let n = 0, cov = 0, cs = [0, 0, 0], cn = 0, ink = 0, sp = 0;
      for (let i = 3; i < m.length; i += 4) { const d = densAt(i - 3); if (m[i] > 128) { n++; if (d > 0.6) { cov++; const c = colAt(i - 3); if (c) { cs[0] += c[0]; cs[1] += c[1]; cs[2] += c[2]; cn++; } } } else if (d > 0.2) { ink++; if (out[i] < 30) sp++; } }
      const avg = cn ? cs.map(v => v / cn) : [255, 255, 255], col = 1 - clamp01(dist(avg, want) * 3), cv2 = cov / Math.max(1, n), spl = sp / Math.max(1, ink + cov), cw = T.colW || 0.35;
      return { score: Math.round(100 * ((0.8 - cw) * cv2 + cv2 * (cw * col + 0.2 * (1 - spl)))), coverage: Math.round(cv2 * 100), colour: Math.round(col * 100), spill: Math.round(spl * 100), yourColour: ttToHex(avg.map(v => v / 255)) }; }
    if (T.kind === 'blend') { const { x0, y0, x1, y1 } = boxIdx(T.box); let err = 0, n = 0, cov = 0, tot = 0;
      for (let x = x0; x < x1; x += 3) { const f = (x - x0) / (x1 - x0), want = (f < 0.3 ? ttHex(RED) : f > 0.7 ? ttHex(YEL) : ttMix(ttHex(RED), ttHex(YEL), (f - 0.3) / 0.4)).map(v => v * 255);
        let cs = [0, 0, 0], cn = 0; for (let y = y0; y < y1; y += 3) { tot++; const i = (y * W + x) * 4; if (densAt(i) > 0.5) { cov++; const c = colAt(i); if (c) { cs[0] += c[0]; cs[1] += c[1]; cs[2] += c[2]; cn++; } } }
        err += cn ? dist(cs.map(v => v / cn), want) : 0.6; n++; }
      const e = err / Math.max(1, n), cv2 = cov / Math.max(1, tot); return { score: Math.round(100 * (0.4 * cv2 + 0.6 * (1 - clamp01(e * 3)))), coverage: Math.round(cv2 * 100), colour: Math.round((1 - clamp01(e * 3)) * 100) }; }
    if (T.kind === 'final') {
      const ln = lineScore((g) => { heart(g); banner(g); shine(g); }, 0.6);
      const hm = maskOf(heart, true), bm = maskOf(banner, true), sm = maskOf(shine, true), red = ttHex(RED).map(v => v * 255), yel = ttHex(YEL).map(v => v * 255);
      let rn = 0, rc = 0, rd = 0, bn = 0, bc = 0, bd = 0, sn = 0, sl = 0, lumUL = 0, nUL = 0, lumLR = 0, nLR = 0;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const i = (y * W + x) * 4, j = i + 3, d = densAt(i), c = colAt(i);
        if (sm[j] > 128) { sn++; const hi = imgd.high.data[i + 3] / 255; if (hi > 0.4 || (c && (c[0] + c[1] + c[2]) / 765 > 0.75 && d > 0.3)) sl++; }
        else if (bm[j] > 128) { bn++; if (d > 0.55) { bc++; if (c) bd += 1 - clamp01(dist(c, yel) * 3); } }
        else if (hm[j] > 128) { rn++; if (d > 0.55) { rc++; if (c) rd += 1 - clamp01(dist(c, red) * 2.2); }
          const X = x / mm, Y = y / mm, lum = c ? (1 - d) + d * (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255 : 1;
          if (X < 82 && Y < 58) { lumUL += lum; nUL++; } if (X > 98 && Y > 58) { lumLR += lum; nLR++; } } }
      const redS = 0.6 * rc / Math.max(1, rn) + 0.4 * rd / Math.max(1, rc), banS = 0.6 * bc / Math.max(1, bn) + 0.4 * bd / Math.max(1, bc), hiS = sl / Math.max(1, sn);
      const shade = clamp01(((lumUL / Math.max(1, nUL)) - (lumLR / Math.max(1, nLR))) / 0.12);
      return { score: Math.round(0.35 * ln.score + 100 * (0.3 * redS + 0.15 * banS + 0.1 * hiS + 0.1 * shade)), lines: ln.score, red: Math.round(redS * 100), banner: Math.round(banS * 100), highlight: Math.round(hiS * 100), shading: Math.round(shade * 100) };
    }
    return { score: 0 };
  };
  const statOf = (a) => a.length ? { med: pct(a, 0.5), p10: pct(a, 0.1), p90: pct(a, 0.9) } : null;
  const exDone = () => {
    const T = CHALL[EX.i], empty = !EX.cur?.strokes, sc = empty ? { score: 0 } : scoreOf(T);
    let mx = 0, sum = 0, n = 0; for (const v of TR) if (v > 0.02) { mx = Math.max(mx, v); sum += v; n++; }
    const skin = Math.round(100 * (1 - clamp01((mx - 0.6) / 1.4))), blow = EX.cur?.blow || 0;
    const total = empty ? 0 : Math.max(0, Math.round(sc.score * 0.85 + skin * 0.15 - Math.min(15, blow * 0.5)));
    const th = composite(Math.min(1, 220 / W)).toDataURL('image/jpeg', 0.7), c = EX.cur || {};
    const res = { id: T.id, title: T.title, cat: T.cat, total, parts: sc, skin: empty ? null : skin, empty, traumaMax: +mx.toFixed(2), traumaAvg: +(n ? sum / n : 0).toFixed(2), blowouts: blow, thumb: th,
      stats: { pressure: statOf(c.p || []), speed: statOf(c.v || []), depth: statOf(c.d || []), tilt: statOf(c.t || []), strokes: c.strokes || 0, dips: c.dips || 0, seconds: c.t0 ? Math.round((c.t1 - c.t0) / 1000) : 0 } };
    EX.res = EX.res.filter(r => r.id !== T.id); EX.res.push(res); st.dirty = true; exBar(res);
  };
  const exNext = () => { EX.cur = null; EX.i++; if (EX.i >= CHALL.length) { EX.done = true; EX.finished = Date.now(); exBar(); save(true); return exReport(); } exStart(true); save(true); };
  function exBar(res) {
    const b = $('#tt-exbar'); if (!b) return; b.hidden = !EX;
    if (!EX) return;
    if (EX.done) { b.innerHTML = `<div class="tt-exh"><b>Exam finished</b></div><div class="row" style="gap:6px"><button class="btn small primary" data-ex="report">Report card</button></div>`; return; }
    const T = CHALL[EX.i];
    b.innerHTML = `<div class="tt-exh"><b>${EX.i + 1} / ${CHALL.length} · ${T.title}</b><span class="tt-exdots">${CHALL.map((c, j) => `<i class="${j < EX.i ? 'done' : j === EX.i ? 'on' : ''}"></i>`).join('')}</span><button class="dz-ib" data-ex="fold" data-tip="Show or hide the instructions" aria-label="Instructions"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button></div>
      <p class="tt-ext" ${EX.fold ? 'hidden' : ''}>${T.text}</p>
      ${res ? `<div class="tt-exres"><b>${res.total}</b><span>${Object.entries(res.parts).filter(([kk, v]) => kk !== 'score' && typeof v === 'number').map(([kk, v]) => `${kk} ${v}%`).join(' · ')} · skin ${res.skin}%${res.blowouts ? ` · ${res.blowouts} blowout${res.blowouts === 1 ? '' : 's'}` : ''}</span></div>
        <div class="row" style="gap:6px"><button class="btn small" data-ex="retry">Try again</button><span style="flex:1"></span><button class="btn small primary" data-ex="next">${EX.i === CHALL.length - 1 ? 'Finish' : 'Next challenge'}</button></div>`
      : `<div class="row" style="gap:6px"><button class="btn small" data-ex="retry">Start over</button><span style="flex:1"></span><button class="btn small primary" data-ex="done">Done</button></div>`}`;
  }
  $('#tt-exbar').addEventListener('click', (e) => { const a = e.target.closest('[data-ex]')?.dataset.ex; if (!a) return;
    if (a === 'fold') { EX.fold = !EX.fold; return exBar(); }
    if (a === 'done') return exDone();
    if (a === 'retry') { if (!confirm('Start this challenge again on clean skin?')) return; return exStart(true); }
    if (a === 'next') return exNext();
    if (a === 'report') return exReport(); });
  const CATS = [['line', 'Linework', 'Pull lines in one steady motion at your lining speed, with the same depth all the way; follow the stencil rather than going back over it.'],
    ['shade', 'Shading', 'Let speed do the fading: slow and pressed in where it should be dark, faster and lighter as it fades; keep a steady rhythm on a pendulum.'],
    ['pack', 'Packing', 'Overlap your passes so no skin shows between them, and stop at the line: solid and even, not more passes in one spot.'],
    ['colour', 'Colour', 'Mix by dipping (the longer the dip, the more of that colour), and lay light colours into feathered edges, never over solid dark.'],
    ['skin', 'Skin care', 'Fewer, lighter passes: get it in once at the right depth rather than going over and over the same skin.'],
    ['blow', 'Blowouts', 'Ease off when you slow down: deep and slow pushes ink under the skin. Keep your depth steady as your speed changes.']];
  const exCats = () => {
    const R = EX.res, by = (c) => R.filter(r => r.cat === c), avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null, fin = R.find(r => r.id === 'final' && !r.empty);
    return { line: avg([...by('line').map(r => r.parts.score), ...(fin ? [fin.parts.lines] : [])]), shade: avg([...by('shade').map(r => r.parts.score), ...(fin ? [fin.parts.shading] : [])]),
      pack: avg(by('pack').map(r => r.parts.score)), colour: avg([...by('colour').map(r => r.parts.score), ...(fin ? [Math.round((fin.parts.red + fin.parts.banner + fin.parts.highlight) / 3)] : [])]),
      skin: avg(R.filter(r => !r.empty).map(r => r.skin)), blow: R.some(r => !r.empty) ? Math.max(0, 100 - R.reduce((x, r) => x + r.blowouts, 0) * 3) : null };
  };
  function exReport() {
    const C = exCats(), vals = CATS.map(([kk]) => C[kk]).filter(v => v != null), overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    const grade = overall >= 90 ? 'A' : overall >= 80 ? 'B' : overall >= 70 ? 'C' : overall >= 60 ? 'D' : 'E';
    const ranked = CATS.filter(([kk]) => C[kk] != null).sort((a, b) => C[b[0]] - C[a[0]]);
    const good = ranked.filter(([kk]) => C[kk] >= 80).slice(0, 3), work = ranked.filter(([kk]) => C[kk] < 72).reverse().slice(0, 3);
    const R = EX.res, all = (f) => R.map(r => r.stats[f]?.med).filter(v => v != null);
    const o = document.createElement('div'); o.id = 'merge-dlg'; o.className = 'tt-tune'; o.style.zIndex = 98;
    o.innerHTML = `<div class="card tt-tcard tt-report"><div class="tt-grade"><b>${grade}</b><div><h2 style="margin:0">Apprentice exam</h2><span class="muted">Overall ${overall} / 100 · ${R.length} of ${CHALL.length} challenges</span></div></div>
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
      if (a === 'again') { if (!confirm('Retake the whole exam? This report is replaced when you finish again.')) return; o.remove(); EX.i = 0; EX.done = false; EX.res = []; EX.started = Date.now(); exStart(true); return save(true); }
      if (a === 'copy') { const txt = JSON.stringify({ inkforge_exam: 1, when: new Date().toISOString(), overall, grade, categories: C,
          challenges: R.map(({ thumb, ...r }) => r), cal: { ...cal }, feel: JSON.parse(Settings.get('tt_feel', '{}')), device: { ua: navigator.userAgent, screen: [screen.width, screen.height], dpr: devicePixelRatio } });
        try { await navigator.clipboard.writeText(txt); toast('Results copied. Paste them into a message to send on.'); } catch { prompt('Copy these results:', txt); } } };
    document.body.appendChild(o);
  }

  if (!TT_NEEDLES.some(n => n.id === st.needle)) st.needle = '3RL';
  if (!Settings.get('tt_tuned')) setTimeout(() => toast(migrated ? 'The needle defaults were updated (voltages and a hand speed setting). Run Tune in again under the sliders icon to set them to your hand.'
    : 'New here? Under the sliders icon, Tune in sets the needles to your pen and hand in a few short tasks.', 7000), 800);
  setNeedle(st.needle); st.dirty = false; drawTray(); sel(); drawView();
  new ResizeObserver(() => { fit(); drawRefs(); }).observe(stage); fit(); drawRefs();
  if (EX) { if (EX.done) { exBar(); exReport(); } else exStart(!EX.cur); st.dirty = false; }
};

/* ---------- Styles (kept here so the simulator stays in one file) ---------- */
function ttStyle() {
  if (document.getElementById('tt-css')) return;
  const s = document.createElement('style'); s.id = 'tt-css';
  s.textContent = `
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
.tt-load { width: 46px; height: 46px; flex: none; border-radius: 50%; border: 0; padding: 0; position: relative; cursor: default; display: grid; place-items: center;
  background: conic-gradient(var(--teal) var(--v, 0%), rgba(255,255,255,.12) 0); }
.tt-load i { position: absolute; inset: 5px; border-radius: 50%; border: 2px solid #222; } .tt-load span { position: relative; font: 700 9px var(--ui); color: #fff; text-shadow: 0 1px 2px #000; }
.tt-capedit { flex: none; }
.tt-set { flex: none; border: 1px solid var(--line); background: rgba(255,255,255,.06); color: var(--teal); font: 700 10px var(--ui); border-radius: 8px; padding: 5px 4px; width: 46px; cursor: pointer; }
.tt-wcap { background: #fff; }
.tt-volt { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 4px 0 2px; } .tt-volt b { font: 700 10px var(--ui); color: var(--teal); }
.tt-volt input { writing-mode: vertical-lr; direction: rtl; width: 22px; height: 110px; margin: 0; accent-color: var(--teal); touch-action: none; } .tt-tray { scrollbar-width: none; } .tt-tray::-webkit-scrollbar { display: none; } body:has(#tt-stage) #toast { top: calc(var(--safe-t, 0px) + 64px); bottom: auto; }
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
