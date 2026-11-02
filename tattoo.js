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
const TT_NEEDLES = [
  ['3RL', 'Liner, 3 round', 'liner', 3], ['5RL', 'Liner, 5 round', 'liner', 5], ['9RL', 'Liner, 9 round', 'liner', 9],
  ['7RS', 'Shader, 7 round', 'shader', 7], ['11M1', 'Magnum, 11', 'mag', 11], ['15CM', 'Soft edge magnum, 15', 'soft', 15]
].map(([id, name, kind, n]) => ({ id, name, kind, n }));
function ttLayout(nd, dia) {
  const n = nd.n, out = [];
  if (nd.kind === 'liner' || nd.kind === 'shader') {
    const ring = n > 6 ? n - 1 : n, r = (dia / 2) / Math.sin(Math.PI / ring) * (nd.kind === 'shader' ? 1.35 : 1);
    if (n > 6) out.push({ u: 0, v: 0, e: 1 });
    for (let i = 0; i < ring; i++) { const a = i * 2 * Math.PI / ring; out.push({ u: r * Math.cos(a), v: r * Math.sin(a), e: 1 }); }
  } else {   // magnums: two staggered rows; the soft edge kind curves and fades towards its ends
    const a = Math.ceil(n / 2), b = n - a, w = (a - 1) * dia;
    for (let i = 0; i < a; i++) out.push({ u: -w / 2 + i * dia, v: 0 });
    for (let i = 0; i < b; i++) out.push({ u: -w / 2 + dia / 2 + i * dia, v: dia * 0.55 });
    for (const p of out) { const t = w ? Math.abs(p.u) / (w / 2) : 0;
      if (nd.kind === 'soft') { p.v += t * t * dia * 1.2; p.e = 1 - t * t * 0.7; } else p.e = 1; }
  }
  return out;
}
// Each needle's feel; every setting can be tuned (and reset) in the calibration panel.
const TT_FEEL = {
  dMin: 0.15, dMax: 1, pCurve: 0, hz: 120, hand: 25, speedFade: 35, tiltSpread: 60, tiltFade: 30, flow: 70, bleed: 35, size: 0.35, miss: 40
};
const TT_FEEL_LIQ = { liner: { flow: 85, miss: 25 }, shader: { flow: 55, miss: 45 }, mag: { flow: 50, miss: 45 }, soft: { flow: 45, miss: 50, bleed: 45 } };

/* ---------- Ink: mixing like pigment ----------
   Each colour as absorbance per channel (-ln of reflectance); mixing averages absorbance by amount. */
const ttHex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const ttToHex = (c) => '#' + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
function ttMix(a, b, t) {
  const A = (v) => -Math.log(Math.max(0.02, v));
  return a.map((v, i) => Math.exp(-(A(v) * (1 - t) + A(b[i]) * t)));
}
const TT_CAPS = ['#141414', '#5a5a5a', '#b3261e', '#f2c21b', '#1f4fa8', '#2e7d3b', '#6b3f22', '#f4f1ea'];
const TT_SKINS = [['Light', '#f1d3bd'], ['Fair', '#e2b493'], ['Medium', '#c68c63'], ['Tan', '#a86b45'], ['Brown', '#7b4a2c'], ['Deep', '#4e2f1e']];
const TT_LAYERS = [['stencil', 'Stencil'], ['line', 'Linework'], ['shadow', 'Shadow'], ['mid', 'Mid tone'], ['light', 'Light tone'], ['high', 'Highlights']];
const TT_DRAW = ['stencil', 'light', 'mid', 'shadow', 'line', 'high'];   // bottom to top
const TT_SIZES = [['A4', 21, 29.7], ['A5', 14.8, 21], ['A6', 10.5, 14.8], ['Square 15 cm', 15, 15], ['Forearm 10 × 25 cm', 10, 25]];

const TT = {
  st: null,
  cal() { try { return { penOnly: true, pMax: 1, ...JSON.parse(Settings.get('tt_cal', '{}')) }; } catch { return { penOnly: true, pMax: 1 }; } },
  feel(id) { let o = {}; try { o = JSON.parse(Settings.get('tt_feel', '{}'))[id] || {}; } catch {} const nd = TT_NEEDLES.find(n => n.id === id);
    return { ...TT_FEEL, ...TT_FEEL_LIQ[nd.kind], ...o }; },
  setFeel(id, f) { let all = {}; try { all = JSON.parse(Settings.get('tt_feel', '{}')); } catch {} if (f) all[id] = f; else delete all[id]; Settings.set('tt_feel', JSON.stringify(all)); }
};

/* ---------- The list of pieces ---------- */
TT.list = async (el) => {
  ttStyle();
  const rows = await DB.all('SELECT id, name, w_cm, h_cm, thumb_ref, updated_at FROM tattoo_pieces ORDER BY updated_at DESC, id DESC');
  const urls = await Promise.all(rows.map(r => Media.url(r.thumb_ref)));
  el.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="muted" style="margin:0;flex:1;font-size:13px">Experimental: draw with needle groupings in ink on skin. Works best with a pressure pen (like an S Pen).</p>
      <button class="btn primary" id="tt-new">+ New piece</button></div>
    ${rows.length ? `<div class="dz-grid">${rows.map((r, i) => `<div class="dz-item" data-open="${r.id}"><div class="dz-thumb">${urls[i] ? `<img src="${urls[i]}" alt="">` : ''}</div>
      <div class="dz-meta"><b>${esc(r.name || 'Piece')}</b><span class="muted">${+r.w_cm} × ${+r.h_cm} cm</span></div>
      <button class="mini" data-del="${r.id}" aria-label="Delete" data-tip="Delete">✕</button></div>`).join('')}</div>`
      : `<div class="empty"><div class="empty-ico">${ICON.needle}</div><div style="font:24px var(--display)">Tattoo simulator</div>
        <div class="muted">Pick a page size and skin tone, load a stencil to trace, dip into the ink caps and tattoo in layers: linework, shadow, mid and light tones, highlights.</div></div>`}`;
  $('#tt-new').onclick = () => ttNewDlg();
  el.onclick = async (e) => {
    const d = e.target.closest('[data-del]');
    if (d) { e.stopPropagation(); const r = await DB.one('SELECT * FROM tattoo_pieces WHERE id = ?', [+d.dataset.del]); if (!r || !confirm(`Delete "${r.name || 'this piece'}"?`)) return;
      await DB.run('DELETE FROM tattoo_pieces WHERE id = ?', [r.id]); for (const k of ['thumb_ref', ...TT_LAYERS.map(([l]) => l + '_ref')]) await Media.release(r[k]); return TT.list(el); }
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
  ttStyle();
  const row = await DB.one('SELECT * FROM tattoo_pieces WHERE id = ?', [id]); if (!row) { location.hash = 'tattoo'; return; }
  const R = Math.min(80, 2400 / Math.max(row.w_cm, row.h_cm)), W = Math.round(row.w_cm * R), H = Math.round(row.h_cm * R), mm = R / 10;   // page px per cm, per mm
  const L = {}; for (const [k] of TT_LAYERS) { const c = document.createElement('canvas'); c.width = W; c.height = H; L[k] = c; }
  for (const [k] of TT_LAYERS) { const ref = row[k + '_ref']; if (!ref) continue; const u = await Media.url(ref); if (!u) continue;
    const im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; }); if (im) L[k].getContext('2d').drawImage(im, 0, 0, W, H); }
  let meta = {}; try { meta = JSON.parse(row.meta || '{}'); } catch {}
  const st = { layer: meta.layer || 'line', needle: meta.needle || '3RL', tool: 'needle', hide: new Set(meta.hide || []), op: { stencil: 0.45, ...(meta.op || {}) },
    ink: { c: ttHex(meta.ink || '#141414'), v: meta.inkV ?? 0 }, caps: meta.caps || [...TT_CAPS], panel: null, dirty: false, name: row.name, skin: row.skin || '#e2b493' };
  const hist = [];
  el.innerHTML = `<div class="dz-ed tt-ed">
    <div class="dz-top">
      <button class="dz-ib" id="tt-back" data-tip="Back to your pieces" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <input class="dz-name" id="tt-name" value="${esc(row.name || 'Piece')}" aria-label="Name"><span class="dz-tsp"></span>
      <button class="dz-ib" id="tt-undo" data-tip="Undo" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
      <button class="dz-ib" id="tt-stencilmk" data-tip="Send to the stencil maker" aria-label="Stencil maker">${ICON.stencil}</button>
      <button class="dz-ib" id="tt-png" data-tip="Save as PNG" aria-label="Save as PNG"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 19h14"/></svg></button>
      <button class="dz-ib dz-go" id="tt-save" data-tip="Save" aria-label="Save"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg></button>
    </div>
    <div class="dz-body"><div class="dz-stage tt-stage" id="tt-stage"><canvas id="tt-cv"></canvas>
      <div class="dz-rail" id="tt-rail">
        <button class="dz-ib tt-needle" data-r="needles" data-tip="Needle grouping" aria-label="Needle"><b id="tt-nl"></b></button>
        <button class="dz-ib" data-r="needle" data-tip="Tattoo" aria-label="Tattoo"><svg viewBox="0 0 24 24"><path d="M4 20l5-5M9 15l8-8 2 2-8 8zM14 6l4 4"/></svg></button>
        <button class="dz-ib" data-r="erase" data-tip="Laser (erase)" aria-label="Erase"><svg viewBox="0 0 24 24"><path d="M7 21h10M5 15l9-9 5 5-9 9H8z"/></svg></button>
        <i class="sep"></i>
        <button class="dz-ib" data-r="layers" data-tip="Layers" aria-label="Layers"><svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/></svg></button>
        <button class="dz-ib" data-r="feel" data-tip="Needle feel and pen calibration" aria-label="Calibration"><svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg></button>
      </div>
      <div class="dz-pop" id="tt-pop" hidden></div>
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
  const org = () => { const r = stage.getBoundingClientRect(); return { ox: (r.width - W * k) / 2 + 26 + vx, oy: (r.height - 70 - H * k) / 2 + vy, r }; };
  const paint = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
    const dpr = cv.width / (stage.clientWidth || 1), { ox, oy } = org();
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
    x.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 24; x.drawImage(skin, 0, 0); x.shadowBlur = 0;
    for (const key of TT_DRAW) { if (st.hide.has(key)) continue;
      x.globalAlpha = key === 'stencil' ? st.op.stencil : (st.op[key] ?? 1); x.globalCompositeOperation = key === 'high' ? 'source-over' : 'multiply';
      x.drawImage(L[key], 0, 0); }
    x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
    $('#tt-zl') && ($('#tt-zl').textContent = Math.abs(z - 1) < 0.01 && !vx && !vy ? 'Fit' : Math.round(z * 100) + '%');
  }); };
  const zoomAt = (nz, px, py) => { const { ox, oy } = org(), pxp = (px - ox) / k, pyp = (py - oy) / k; z = Math.max(0.5, Math.min(12, nz)); k = fitK * z;
    const n = org(); vx += px - (n.ox + pxp * k); vy += py - (n.oy + pyp * k); paint(); };
  const toPage = (e) => { const { ox, oy, r } = org(); return { x: (e.clientX - r.left - ox) / k, y: (e.clientY - r.top - oy) / k }; };

  /* ---------- Needle engine ---------- */
  const cal = TT.cal();
  let feel = TT.feel(st.needle), lay = ttLayout(TT_NEEDLES.find(n => n.id === st.needle), feel.size);
  const curve = (p, c) => Math.pow(Math.max(0, Math.min(1, p)), Math.pow(2, c / 50));   // c -100..100: soft (light presses go deep) .. firm (press harder)
  const setNeedle = (id) => { st.needle = id; feel = TT.feel(id); lay = ttLayout(TT_NEEDLES.find(n => n.id === id), feel.size); $('#tt-nl').textContent = id; st.dirty = true; };
  // One puncture: every needle of the grouping into the skin at p, the grouping turned to angle a.
  const puncture = (cx, p, a, depth, tilt, inkC, erase) => {
    const ca = Math.cos(a), sa = Math.sin(a), sp = 1 + tilt * feel.tiltSpread / 100 * 0.8, rr = feel.size / 2 * mm * (0.7 + depth * 0.55) * sp;
    const flow = feel.flow / 100, bleed = feel.bleed / 100, hit = 1 - (feel.miss / 100) * (1 - depth);
    for (const nd of lay) {
      if (Math.random() > hit) continue;
      const ju = (Math.random() - 0.5) * 0.06, jv = (Math.random() - 0.5) * 0.06, u = (nd.u + ju) * mm * sp, v = (nd.v + jv) * mm;
      const px = p.x + u * -sa + v * ca, py = p.y + u * ca + v * sa, al = Math.min(1, (0.18 + depth * 0.6) * flow * nd.e * inkC);
      if (al <= 0.004) continue;
      cx.globalAlpha = al; cx.beginPath(); cx.arc(px, py, rr, 0, 7); cx.fill();
      if (bleed && !erase) { cx.globalAlpha = al * bleed * 0.22; cx.beginPath(); cx.arc(px, py, rr * 2, 0, 7); cx.fill(); }
    }
  };
  let pen = null;
  const strokeStart = (e) => {
    const key = st.layer; if (st.hide.has(key)) toast('That layer is hidden: show it to see what you draw.');
    if (key === 'stencil' && st.tool !== 'erase') { toast('The stencil layer holds a picture to trace. Load one from Layers.'); return false; }
    const c = L[key]; hist.push({ key, data: c.getContext('2d').getImageData(0, 0, W, H) }); if (hist.length > 15) hist.shift();
    const cx = c.getContext('2d'); cx.globalCompositeOperation = st.tool === 'erase' ? 'destination-out' : 'source-over';
    cx.fillStyle = st.tool === 'erase' ? '#000' : ttToHex(st.ink.c);
    const p = toPage(e);
    pen = { cx, last: p, t: e.timeStamp, carry: 0, speed: 0, a: 0, id: e.pointerId };
    if (st.tool !== 'erase' && st.ink.v <= 0.02) toast('The needle is dry: dip into an ink cap first.', 1800);
    return true;
  };
  const strokeMove = (e) => {
    const co = e.getCoalescedEvents?.(), evs = co?.length ? co : [e];
    for (const ev of evs) {
      const p = toPage(ev), dx = p.x - pen.last.x, dy = p.y - pen.last.y, d = Math.hypot(dx, dy), dt = Math.max(1, ev.timeStamp - pen.t) / 1000;
      if (d < 0.01) continue;
      const v = d * k / (96 / 25.4) / dt;   // the hand's speed on the screen, mm per second (zoom doesn't change it)
      pen.speed = pen.speed ? pen.speed * 0.7 + v * 0.3 : v; pen.a = Math.atan2(dy, dx);
      const pr = ev.pointerType === 'mouse' ? 0.6 : (ev.pressure || 0.5) / Math.max(0.05, cal.pMax);
      const tilt = Math.min(1, Math.hypot(ev.tiltX || 0, ev.tiltY || 0) / 60);
      let depth = feel.dMin + (feel.dMax - feel.dMin) * curve(pr, feel.pCurve);
      depth *= 1 - Math.min(0.9, (pen.speed / 200) * feel.speedFade / 100) - tilt * feel.tiltFade / 100 * 0.6;
      depth = Math.max(0.02, Math.min(1, depth));
      // punctures land every (hand speed / machine speed) along the skin; `hand` scales screen speed to a tattooing hand's
      const gap = Math.max(0.02, pen.speed * (feel.hand / 100) / feel.hz / z) * mm;
      let t = pen.carry;
      while (t <= d) {
        const q = { x: pen.last.x + dx * t / d, y: pen.last.y + dy * t / d };
        const inkC = st.tool === 'erase' ? 1 : Math.sqrt(Math.min(1, st.ink.v * 1.6));
        puncture(pen.cx, q, pen.a, st.tool === 'erase' ? 1 : depth, tilt, inkC, st.tool === 'erase');
        if (st.tool !== 'erase') st.ink.v = Math.max(0, st.ink.v - 0.000015 * lay.length * depth * feel.flow / 100);
        t += gap;
      }
      pen.carry = t - d; pen.last = p; pen.t = ev.timeStamp;
    }
    st.dirty = true; paint(); drawNeedleInk();
  };
  const strokeEnd = () => { pen = null; drawNeedleInk(); };

  /* ---------- Pointer: pen draws; fingers move the page (or draw too, when allowed) ---------- */
  const pts = new Map(); let pinch = null, pan = null, space = false;
  cv.addEventListener('pointerdown', (e) => {
    closePop(); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = stage.getBoundingClientRect();
    if (pts.size === 2) { if (pen) { hist.length && undoTo(hist.pop()); pen = null; }
      const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, vx, vy }; return; }
    cv.setPointerCapture(e.pointerId);
    const touch = e.pointerType === 'touch';
    if (space || e.button === 1 || (touch && TT.cal().penOnly)) { pan = { x: e.clientX, y: e.clientY, vx, vy }; return; }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (strokeStart(e)) strokeMove(e);
  });
  cv.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) { const [a, b] = [...pts.values()], r = stage.getBoundingClientRect(), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      vx = pinch.vx + mx - pinch.mx; vy = pinch.vy + my - pinch.my; z = pinch.z; k = fitK * z; zoomAt(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, mx, my); return; }
    if (pan) { vx = pan.vx + e.clientX - pan.x; vy = pan.vy + e.clientY - pan.y; return paint(); }
    if (pen && e.pointerId === pen.id) strokeMove(e);
    calLive(e);
  });
  const up = (e) => { pts.delete(e.pointerId); if (pinch && pts.size < 2) pinch = null; pan = null; if (pen && e.pointerId === pen.id) strokeEnd(); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  const keys = (e) => { if (!document.body.contains(el)) { removeEventListener('keydown', keys); removeEventListener('keyup', keys); return; }
    if (e.target.matches?.('input, textarea')) return;
    if (e.key === ' ') { space = e.type === 'keydown'; e.preventDefault(); }
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); } };
  addEventListener('keydown', keys); addEventListener('keyup', keys);
  stage.querySelector('.tt-zoom').onclick = (e) => { const b = e.target.closest('[data-z]'); if (!b) return;
    if (b.dataset.z === 'fit') { z = 1; vx = vy = 0; k = fitK; return paint(); } const r = stage.getBoundingClientRect(); zoomAt(z * (b.dataset.z === 'in' ? 1.4 : 1 / 1.4), r.width / 2, r.height / 2); };

  const undoTo = (h) => { L[h.key].getContext('2d').putImageData(h.data, 0, 0); st.dirty = true; paint(); };
  const undo = () => { const h = hist.pop(); if (!h) return toast('Nothing to undo.'); undoTo(h); };

  /* ---------- Ink caps: hold to dip (the longer, the more of that colour), tap the cup to rinse ---------- */
  const tray = $('#tt-tray');
  const drawTray = () => {
    tray.innerHTML = `<button class="tt-cup" data-rinse data-tip="Rinse: clean the needle" aria-label="Rinse"></button>
      ${st.caps.map((c, i) => `<button class="tt-cap" data-cap="${i}" style="--c:${c}" aria-label="Ink cap"><i></i></button>`).join('')}
      <button class="tt-load" id="tt-load" data-tip="Ink on the needle" aria-label="Ink on the needle"><i></i><span></span></button>
      <button class="dz-ib tt-capedit ${st.capEdit ? 'on' : ''}" data-capedit data-tip="Change the ink colours" aria-label="Change ink colours"><svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19z"/></svg></button>`;
    drawNeedleInk();
  };
  const drawNeedleInk = () => { const b = $('#tt-load'); if (!b) return; b.querySelector('i').style.background = st.ink.v > 0.01 ? ttToHex(st.ink.c) : 'transparent';
    b.style.setProperty('--v', Math.round(st.ink.v * 100) + '%'); b.querySelector('span').textContent = Math.round(st.ink.v * 100) + '%'; };
  let dip = null;
  tray.addEventListener('pointerdown', (e) => {
    const cap = e.target.closest('[data-cap]'); if (!cap) return;
    const i = +cap.dataset.cap;
    if (st.capEdit) { const inp = document.createElement('input'); inp.type = 'color'; inp.value = st.caps[i];
      inp.oninput = () => { st.caps[i] = inp.value; st.dirty = true; drawTray(); }; inp.click(); return; }
    e.preventDefault(); const col = ttHex(st.caps[i]); cap.classList.add('dip'); let t0 = performance.now();
    const step = (now) => { if (!dip) return; const dt = Math.min(0.1, (now - t0) / 1000); t0 = now;
      const a = dt * 0.9, frac = a / (st.ink.v + a);   // ink added this moment, and how much of the mix it is
      st.ink.c = st.ink.v > 0.005 ? ttMix(st.ink.c, col, frac) : col; st.ink.v = Math.min(1, st.ink.v + a);
      drawNeedleInk(); dip.raf = requestAnimationFrame(step); };
    dip = { cap, raf: requestAnimationFrame(step) }; st.dirty = true;
  });
  const dipEnd = () => { if (!dip) return; cancelAnimationFrame(dip.raf); dip.cap.classList.remove('dip'); dip = null; };
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => tray.addEventListener(t, dipEnd));
  tray.addEventListener('click', (e) => {
    if (e.target.closest('[data-rinse]')) { st.ink = { c: [1, 1, 1], v: 0 }; drawNeedleInk(); return toast('Needle rinsed.', 1200); }
    if (e.target.closest('[data-capedit]')) { st.capEdit = !st.capEdit; toast(st.capEdit ? 'Tap a cap to change its colour. Tap the pencil again when done.' : 'Done changing colours.', 2200); return drawTray(); }
  });
  tray.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---------- Rail, needles menu and the side panel ---------- */
  const closePop = () => { pop.hidden = true; };
  const sel = (r) => $('#tt-rail').querySelectorAll('[data-r]').forEach(b => b.classList.toggle('on', b.dataset.r === r || (b.dataset.r === st.tool && !['layers', 'feel'].includes(r))
    || (b.dataset.r === st.panel)));
  $('#tt-rail').onclick = (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return; const r = b.dataset.r;
    if (r === 'needles') {
      if (!pop.hidden) return closePop();
      pop.innerHTML = TT_NEEDLES.map(n => `<button class="mi ${n.id === st.needle ? 'on' : ''}" data-nd="${n.id}"><b class="tt-nb">${n.id}</b><span>${n.name}</span></button>`).join('');
      pop.hidden = false; pop.style.top = Math.max(8, b.getBoundingClientRect().top - stage.getBoundingClientRect().top - 6) + 'px'; return;
    }
    closePop();
    if (r === 'needle' || r === 'erase') { st.tool = r === 'erase' ? 'erase' : 'needle'; return sel(); }
    st.panel = st.panel === r ? null : r; drawSide();
  };
  pop.onclick = (e) => { const b = e.target.closest('[data-nd]'); if (!b) return; setNeedle(b.dataset.nd); st.tool = 'needle'; closePop(); sel(); if (st.panel === 'feel') drawSide(); };
  const slider = (key, label, min, max, step, val, fmt) => `<label class="dz-sl"><span>${label}<b>${fmt ? fmt(val) : val}</b></span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-f="${key}"></label>`;
  const curveSvg = (c) => `<svg class="tt-curve" viewBox="0 0 100 100"><path d="M0 100 ${[...Array(21)].map((_, i) => `L${i * 5} ${100 - curve(i / 20, c) * 100}`).join(' ')}"/></svg>`;
  const drawSide = () => {
    sel(st.panel); side.hidden = !st.panel; if (!st.panel) return;
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
      <div class="row" style="gap:6px;margin:6px 0 10px"><button class="btn small" data-padclear>Clear the pad</button><button class="btn small" data-pcal>Calibrate pressure</button></div>
      <div class="lbl">Pressure → depth</div>
      <div class="tt-crow">${curveSvg(f.pCurve)}<div style="flex:1">${slider('pCurve', 'Curve', -100, 100, 1, f.pCurve, v => v < 0 ? 'soft ' + -v : v > 0 ? 'firm ' + v : 'even')}
        ${slider('dMin', 'Lightest', 0, 1, 0.01, f.dMin, v => Math.round(v * 100) + '%')}${slider('dMax', 'Deepest', 0, 1, 0.01, f.dMax, v => Math.round(v * 100) + '%')}</div></div>
      <div class="lbl">Speed</div>
      ${slider('hz', 'Machine speed', 40, 200, 1, f.hz, v => v + ' hits/s')}
      ${slider('hand', 'Hand speed', 2, 100, 1, f.hand, v => v + '%')}
      ${slider('speedFade', 'Fast strokes lighten', 0, 100, 1, f.speedFade, v => v + '%')}
      <div class="lbl">Tilt</div>
      ${slider('tiltSpread', 'Tilt spreads', 0, 100, 1, f.tiltSpread, v => v + '%')}${slider('tiltFade', 'Tilt lightens', 0, 100, 1, f.tiltFade, v => v + '%')}
      <div class="lbl">Ink</div>
      ${slider('flow', 'Ink flow', 5, 100, 1, f.flow, v => v + '%')}${slider('bleed', 'Bleed into skin', 0, 100, 1, f.bleed, v => v + '%')}
      ${slider('miss', 'Missed punctures when light', 0, 100, 1, f.miss, v => v + '%')}
      <div class="lbl">Needle size</div><div class="seg" style="margin-bottom:8px">${[[0.25, '#08'], [0.3, '#10'], [0.35, '#12']].map(([v, n]) => `<button data-sz="${v}" class="${f.size === v ? 'on' : ''}" style="flex:1">${n} · ${v} mm</button>`).join('')}</div>
      <label class="toggle" style="display:inline-flex"><input type="checkbox" data-penonly ${TT.cal().penOnly ? 'checked' : ''}><span>Pen only (fingers move the page)</span></label>
      <div class="row" style="margin-top:8px"><button class="btn small" data-feelreset>Reset ${nd.id}</button></div>`;
    padInit();
  };
  side.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) { st.panel = null; return drawSide(); }
    const ly = t.closest('[data-ly]')?.dataset.ly;
    if (ly) {
      if (t.closest('[data-hide]')) { st.hide.has(ly) ? st.hide.delete(ly) : st.hide.add(ly); st.dirty = true; paint(); return drawSide(); }
      if (t.closest('[data-clear]')) { if (!confirm('Clear everything on this layer? Undo brings it back.')) return;
        const c = L[ly]; hist.push({ key: ly, data: c.getContext('2d').getImageData(0, 0, W, H) }); c.getContext('2d').clearRect(0, 0, W, H); st.dirty = true; paint(); return; }
      if (t.closest('[data-stl]')) return loadStencil();
      if (t.matches('input')) return;
      st.layer = ly; st.dirty = true; return drawSide();
    }
    if (t.closest('[data-sz]')) { feel.size = +t.closest('[data-sz]').dataset.sz; TT.setFeel(st.needle, feel); lay = ttLayout(TT_NEEDLES.find(n => n.id === st.needle), feel.size); return drawSide(); }
    if (t.closest('[data-feelreset]')) { TT.setFeel(st.needle, null); setNeedle(st.needle); return drawSide(); }
    if (t.closest('[data-padclear]')) return padInit();
    if (t.closest('[data-pcal]')) { calib = { max: 0 }; toast('Draw on the pad as hard as you would really press, for a few seconds.', 4000);
      setTimeout(() => { if (!calib) return; const m = calib.max; calib = null; if (m < 0.05) return toast('No pen pressure came through. Try with the stylus on the pad.');
        Settings.set('tt_cal', JSON.stringify({ ...TT.cal(), pMax: m })); cal.pMax = m; toast(`Your firm press now reads as full depth (${Math.round(m * 100)}% of the pen's range).`, 4000); }, 4500); }
    if (t.matches('[data-penonly]')) { Settings.set('tt_cal', JSON.stringify({ ...TT.cal(), penOnly: t.checked })); }
  });
  side.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-lop]')) { const ly = t.closest('[data-ly]').dataset.ly; st.op[ly] = +t.value; st.dirty = true; return paint(); }
    const fk = t.dataset.f; if (!fk) return;
    feel[fk] = +t.value; TT.setFeel(st.needle, feel);
    const v = +t.value, b = t.closest('.dz-sl')?.querySelector('b');
    if (b) b.textContent = fk === 'pCurve' ? (v < 0 ? 'soft ' + -v : v > 0 ? 'firm ' + v : 'even') : fk === 'dMin' || fk === 'dMax' ? Math.round(v * 100) + '%' : fk === 'hz' ? v + ' hits/s' : v + '%';
    if (fk === 'pCurve') side.querySelector('.tt-curve').outerHTML = curveSvg(feel.pCurve);
  });

  // The test pad: a strip of skin in the panel to try the current needle on.
  let calib = null;
  const padInit = () => {
    const c = $('#tt-pad'); if (!c) return; const p = c.getContext('2d');
    p.fillStyle = st.skin; p.fillRect(0, 0, c.width, c.height);
    let last = null, t = 0, carry = 0, sp = 0;
    c.onpointerdown = (e) => { c.setPointerCapture(e.pointerId); last = null; carry = 0; sp = 0; p.fillStyle = ttToHex(st.ink.v > 0.02 ? st.ink.c : [0.08, 0.08, 0.08]); move(e); };
    const move = (e) => {
      calLive(e); if (!c.hasPointerCapture?.(e.pointerId) && e.type !== 'pointerdown') return;
      const r = c.getBoundingClientRect(), s = c.width / r.width;
      const co = e.getCoalescedEvents?.();
      for (const ev of co?.length ? co : [e]) {
        const q = { x: (ev.clientX - r.left) * s, y: (ev.clientY - r.top) * s };
        if (calib && ev.pressure) calib.max = Math.max(calib.max, ev.pressure);
        if (!last) { last = q; t = ev.timeStamp; continue; }
        const dx = q.x - last.x, dy = q.y - last.y, d = Math.hypot(dx, dy), dt = Math.max(1, ev.timeStamp - t) / 1000; if (d < 0.01) continue;
        const pm = 4;   // the pad shows needles bigger than the page: 4 px per mm
        sp = sp ? sp * 0.7 + d / pm / dt * 0.3 : d / pm / dt;
        const pr = ev.pointerType === 'mouse' ? 0.6 : (ev.pressure || 0.5) / Math.max(0.05, cal.pMax), tilt = Math.min(1, Math.hypot(ev.tiltX || 0, ev.tiltY || 0) / 60);
        let depth = feel.dMin + (feel.dMax - feel.dMin) * curve(pr, feel.pCurve);
        depth = Math.max(0.02, Math.min(1, depth * (1 - Math.min(0.9, sp / 200 * feel.speedFade / 100) - tilt * feel.tiltFade / 100 * 0.6)));
        const gap = Math.max(0.03, sp * (feel.hand / 100) / feel.hz) * pm, a = Math.atan2(dy, dx), mmWas = mm;
        let tt = carry;
        while (tt <= d) { punctureAt(p, { x: last.x + dx * tt / d, y: last.y + dy * tt / d }, a, depth, tilt, pm); tt += gap; }
        carry = tt - d; last = q; t = ev.timeStamp;
      }
    };
    c.onpointermove = move; c.onpointerup = c.onpointercancel = () => { last = null; };
  };
  const punctureAt = (cx, p, a, depth, tilt, pm) => {   // the same puncture, at another scale (the pad)
    const ca = Math.cos(a), sa = Math.sin(a), sp = 1 + tilt * feel.tiltSpread / 100 * 0.8, rr = feel.size / 2 * pm * (0.7 + depth * 0.55) * sp;
    const flow = feel.flow / 100, bleed = feel.bleed / 100, hit = 1 - (feel.miss / 100) * (1 - depth);
    for (const nd of lay) { if (Math.random() > hit) continue;
      const u = (nd.u + (Math.random() - 0.5) * 0.06) * pm * sp, v = (nd.v + (Math.random() - 0.5) * 0.06) * pm, px = p.x + u * -sa + v * ca, py = p.y + u * ca + v * sa;
      const al = Math.min(1, (0.18 + depth * 0.6) * flow * nd.e); cx.globalAlpha = al; cx.beginPath(); cx.arc(px, py, rr, 0, 7); cx.fill();
      if (bleed) { cx.globalAlpha = al * bleed * 0.22; cx.beginPath(); cx.arc(px, py, rr * 2, 0, 7); cx.fill(); } }
    cx.globalAlpha = 1;
  };
  let liveT = 0, liveLast = null;
  const calLive = (e) => {
    const l = $('#tt-live'); if (!l) return; const now = e.timeStamp;
    if (liveLast && now - liveT > 30) { const d = Math.hypot(e.clientX - liveLast.x, e.clientY - liveLast.y) / (now - liveT) * 1000 / (96 / 25.4); l.dataset.sp = Math.round(d); }
    if (now - liveT > 30) { liveT = now; liveLast = { x: e.clientX, y: e.clientY }; }
    l.textContent = `Pressure ${e.pointerType === 'mouse' ? 'mouse' : Math.round((e.pressure || 0) * 100) + '%'} · Speed ${l.dataset.sp || 0} mm/s · Tilt ${Math.round(Math.hypot(e.tiltX || 0, e.tiltY || 0))}°`;
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
    const c = L.stencil, cx = c.getContext('2d'); hist.push({ key: 'stencil', data: cx.getImageData(0, 0, W, H) });
    cx.clearRect(0, 0, W, H); const s = Math.min(W * 0.9 / im.naturalWidth, H * 0.9 / im.naturalHeight), w = im.naturalWidth * s, h = im.naturalHeight * s;
    cx.drawImage(im, (W - w) / 2, (H - h) / 2, w, h); st.hide.delete('stencil'); st.dirty = true; paint(); drawSide();
  };

  /* ---------- Saving and exporting ---------- */
  const composite = (scale = 1, withSkin = true) => {
    const c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale); const g = c.getContext('2d'); g.scale(scale, scale);
    if (withSkin) g.drawImage(skin, 0, 0);
    for (const key of TT_DRAW) { if (key === 'stencil' || st.hide.has(key)) continue; g.globalAlpha = st.op[key] ?? 1; g.globalCompositeOperation = key === 'high' || !withSkin ? 'source-over' : 'multiply'; g.drawImage(L[key], 0, 0); }
    return c;
  };
  const blobOf = (c) => new Promise(r => c.toBlob(r, 'image/png'));
  const save = async (quiet) => {
    const refs = {}; for (const [key] of TT_LAYERS) refs[key] = await Media.save(await blobOf(L[key]), 'png');
    const thumb = await Media.save(await blobOf(composite(Math.min(1, 420 / Math.max(W, H)))), 'png');
    const old = await DB.one('SELECT * FROM tattoo_pieces WHERE id = ?', [id]);
    await DB.run(`UPDATE tattoo_pieces SET name = ?, ${TT_LAYERS.map(([key]) => key + '_ref = ?').join(', ')}, thumb_ref = ?, meta = ?, updated_at = datetime('now') WHERE id = ?`,
      [$('#tt-name')?.value.trim() || st.name, ...TT_LAYERS.map(([key]) => refs[key]), thumb,
        JSON.stringify({ layer: st.layer, needle: st.needle, hide: [...st.hide], op: st.op, ink: ttToHex(st.ink.c), inkV: st.ink.v, caps: st.caps }), id]);
    if (old) for (const r of [old.thumb_ref, ...TT_LAYERS.map(([key]) => old[key + '_ref'])]) if (r && !Object.values(refs).includes(r) && r !== thumb) await Media.release(r);
    st.dirty = false; if (!quiet) toast('Saved.');
  };
  $('#tt-save').onclick = () => save();
  $('#tt-back').onclick = async () => { if (st.dirty) await save(true); location.hash = 'tattoo'; };
  $('#tt-name').onchange = () => { st.dirty = true; };
  $('#tt-undo').onclick = undo;
  $('#tt-png').onclick = async () => { const a = document.createElement('a'); a.href = URL.createObjectURL(await blobOf(composite())); a.download = (($('#tt-name').value || 'tattoo').replace(/[^\w-]+/g, '_')) + '.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
  $('#tt-stencilmk').onclick = async () => {
    if (typeof stLoad !== 'function') return;
    const c = composite(1, false), w = document.createElement('canvas'); w.width = c.width; w.height = c.height; const g = w.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w.width, w.height); g.drawImage(c, 0, 0);
    if (st.dirty) await save(true);
    await stLoad(new File([await blobOf(w)], 'tattoo.png', { type: 'image/png' })); if (!ST.src) return;
    ST.cm = row.w_cm; ST.from = $('#tt-name').value || ''; location.hash = 'stencil';
  };

  setNeedle(st.needle); st.dirty = false; drawTray(); sel();
  new ResizeObserver(() => fit()).observe(stage); fit();
};

/* ---------- Styles (kept here so the simulator stays in one file) ---------- */
function ttStyle() {
  if (document.getElementById('tt-css')) return;
  const s = document.createElement('style'); s.id = 'tt-css';
  s.textContent = `
#main:has(.tt-ed) { padding: 0; overflow: hidden; } #main:has(.tt-ed) #topbar { display: none; } #view:has(.tt-ed) { max-width: none; height: 100%; animation: none; } #tt:has(.tt-ed) { height: 100%; }
.tt-stage { background: #1b1e1f; touch-action: none; } .tt-stage canvas#tt-cv { position: absolute; inset: 0; touch-action: none; cursor: crosshair; }
.tt-needle b { font: 700 10px var(--ui); letter-spacing: -.02em; color: var(--teal); }
.dz-pop .mi.on { background: rgba(31,182,166,.15); } .tt-nb { display: inline-block; min-width: 40px; font: 700 12px var(--ui); color: var(--teal); }
.tt-tray { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 6; display: flex; align-items: center; gap: 8px; padding: 8px 10px; max-width: calc(100% - 20px); overflow-x: auto;
  border-radius: 18px; background: rgba(22,27,28,.92); border: 1px solid var(--line); backdrop-filter: blur(10px); box-shadow: 0 8px 24px rgba(0,0,0,.45); touch-action: none; user-select: none; -webkit-user-select: none; }
.tt-cap { width: 38px; height: 38px; flex: none; border-radius: 50%; border: 2px solid #c8c8c8; background: #e9e9e9; padding: 0; cursor: pointer; position: relative; box-shadow: inset 0 -3px 0 rgba(0,0,0,.15); }
.tt-cap i { position: absolute; inset: 5px; border-radius: 50%; background: var(--c); box-shadow: inset 0 2px 4px rgba(0,0,0,.35); }
.tt-cap.dip { transform: scale(.92); outline: 3px solid var(--teal); outline-offset: 2px; }
.tt-cup { width: 34px; height: 38px; flex: none; border-radius: 6px 6px 12px 12px; border: 2px solid #9fb3b8; background: linear-gradient(transparent 35%, rgba(150,200,220,.45) 35%); cursor: pointer; padding: 0; }
.tt-load { width: 46px; height: 46px; flex: none; border-radius: 50%; border: 0; padding: 0; position: relative; cursor: default; display: grid; place-items: center;
  background: conic-gradient(var(--teal) var(--v, 0%), rgba(255,255,255,.12) 0); }
.tt-load i { position: absolute; inset: 5px; border-radius: 50%; border: 2px solid #222; } .tt-load span { position: relative; font: 700 9px var(--ui); color: #fff; text-shadow: 0 1px 2px #000; }
.tt-capedit { flex: none; } .tt-zoom { left: auto !important; right: 10px !important; bottom: 76px !important; }
.tt-layers { display: grid; gap: 4px; }
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
