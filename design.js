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
  page: { label: 'Blank page', sub: 'A2 to A6, Letter, custom…', w: 2480, h: 3508, per: 0, page: 1 },
  fold: { label: 'Folded pamphlet', sub: 'Trifold, bifold, Z-fold…', w: 3508, h: 2480, per: 0, fold: 1 },
  voucher: { label: 'Gift voucher', sub: 'DL, 210 × 99 mm', w: 2480, h: 1169, per: 2 },
  card: { label: 'Business card', sub: '85 × 55 mm', w: 1004, h: 650, per: 10 },
  flyer: { label: 'Flyer / pamphlet', sub: 'A5, 148 × 210 mm', w: 1748, h: 2480, per: 2 },
  post: { label: 'Square post', sub: '1080 × 1080, feed', w: 1080, h: 1080, per: 0, social: 1 },
  portrait: { label: 'Portrait post', sub: '1080 × 1350, feed (4:5)', w: 1080, h: 1350, per: 0, social: 1 },
  story: { label: 'Story / reel cover', sub: '1080 × 1920 (9:16)', w: 1080, h: 1920, per: 0, social: 1 }
};
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
const dzKeep = (l) => l.t === 'text' || (l.keep ?? (l.t !== 'shape' || l.shape === 'path'));

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
    await Promise.all([t.f1, t.f2, ...doc.layers.filter(l => l.t === 'text').map(l => l.font[0] === '@' ? t['f' + l.font[1]] : l.font)].map(f => this.load(f))); }
};

/* ---------- Drawing ---------- */
const DZI = new Map();   // media ref -> loaded Image
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
  const cands = [], push = (label, subs, pen) => cands.push({ label, subs, e: err(subs) + pen });
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
    push(a === b ? 'Square' : 'Rectangle', [{ closed: true, nodes: [P(-a, -b), P(a, -b), P(a, b), P(-a, b)] }], 0.004);
    push('Ellipse', dzEllipseSubs(ecx, ecy, a * 0.97, b * 0.97, th), 0.007);
    // corners: the closed loop simplified until only its turns are left
    const loop = dzRdp([...raw, raw[0]], D * 0.06); loop.pop();
    const n = loop.length;
    if (n >= 3 && n <= 8) {
      let px = 0, py = 0; for (const q of loop) { px += q.x; py += q.y; } px /= n; py /= n;
      const rad = loop.map(q => Math.hypot(q.x - px, q.y - py)), R = rad.reduce((t, v) => t + v, 0) / n, off = Math.max(...rad.map(v => Math.abs(v - R)));
      if (n >= 5 && off / R < 0.1) { const a0 = Math.atan2(loop[0].y - py, loop[0].x - px);
        push(`${n}-sided`, [{ closed: true, nodes: [...Array(n)].map((_, i) => dzP(px + R * Math.cos(a0 + i * 2 * Math.PI / n), py + R * Math.sin(a0 + i * 2 * Math.PI / n))) }], 0.003 * n); }
      else push(n === 3 ? 'Triangle' : `${n}-sided`, [{ closed: true, nodes: loop.map(q => dzP(q.x, q.y)) }], 0.003 * n + (n === 4 ? 0.02 : 0));
    }
  }
  if (!cands.length) return null;
  cands.sort((p1, p2) => p1.e - p2.e);
  return cands[0].e < 0.045 ? cands[0] : null;
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
async function dzDraw(cv, doc, scale = 1, opts = {}) {
  await DZF.all(doc);
  const x = cv.getContext('2d'), W = doc.w * scale, H = doc.h * scale;
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
  if (!opts.noBg) x.fillStyle = dzCol(doc, doc.bg?.c) || '#ffffff', x.fillRect(0, 0, W, H);
  if (doc.bg?.img && !opts.noBg) { const im = await dzImg(doc.bg.img);
    if (im) { const s = Math.max(W / im.naturalWidth, H / im.naturalHeight); x.globalAlpha = doc.bg.op ?? 1;
      x.drawImage(im, (W - im.naturalWidth * s) / 2, (H - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s); x.globalAlpha = 1; } }
  const one = async (x, l) => {
    const im = l.t === 'image' ? await dzImg(l.logo ? Settings.get('studio_logo_ref') : l.ref) : null;
    const tex = l.fm === 'tex' && l.tex?.ref ? await dzImg(l.tex.ref) : null;
    let lines = null;
    if (l.t === 'text') {   // measure first, so the box (and its centre) is the real height of the text
      x.setTransform(1, 0, 0, 1, 0, 0);
      if ('letterSpacing' in x) x.letterSpacing = (l.ls || 0) + 'px';
      // "Shrink to fit": a long name or amount gets smaller instead of wrapping onto a second line.
      const txt = dzFill(doc, l.text), want = l.fit ? txt.split('\n').length : Infinity;
      let px = l.size;
      if (l.arc) {
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
    if (l.t === 'text') {
      flip();
      const px = l._px || l.size, lh = px * (l.lh || 1.2); x.font = dzFontStr(doc, l, px);
      if ('letterSpacing' in x) x.letterSpacing = (l.ls || 0) + 'px';
      x.fillStyle = (!l.arc && dzPaint(x, doc, l, tex)) || dzCol(doc, l.c) || '#000'; x.textBaseline = 'alphabetic';   // bent text: plain colour
      if (l.arc && l._arc) {
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
      } else {
        x.textAlign = l.al || 'left';
        const ax = l.al === 'center' ? 0 : l.al === 'right' ? l.w / 2 : -l.w / 2;
        lines.forEach((ln, i) => x.fillText(ln, ax, -l.h / 2 + i * lh + px * 0.9));
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
        if (L.shape === 'line') { x.strokeStyle = pf || st || f || '#000'; x.lineWidth = Math.max(1, sw || L.h); x.lineCap = 'round'; x.stroke(); }
        else { if ((pf || f) && !(L.shape === 'vec' && L.subs?.every(sp => sp.closed === false))) { x.fillStyle = pf || f; x.fill(L.shape === 'path' || dzSubs(L) ? 'evenodd' : 'nonzero'); } if (st && sw) { x.strokeStyle = st; x.lineWidth = sw; x.stroke(); } }
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
  for (const L of dzPages(doc, opts.face))
  for (let i = 0; i < L.length; i++) {
    const base = L[i]; let j = i + 1;
    while (j < L.length && L[j].clip) j++;
    const clips = L.slice(i + 1, j).filter(show); i = j - 1;
    if (!show(base)) continue;
    if (!clips.length) { await one(x, base); continue; }
    const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
    const ox = off.getContext('2d');
    await one(ox, base); ox.globalCompositeOperation = 'source-atop';
    for (const c of clips) await one(ox, c);
    x.setTransform(1, 0, 0, 1, 0, 0); x.drawImage(off, 0, 0);
  }
}
// The layer lists drawn for a page, bottom first: f = front, b = back, m = master (only the master).
const dzSide = (l) => l.side || 'f';
function dzPages(doc, face = 'f') {
  if (!doc.sides) return [doc.layers];
  const own = doc.layers.filter(l => dzSide(l) === face);
  return face === 'm' ? [own] : [doc.layers.filter(l => l.side === 'm'), own];
}
const dzFaceNames = (doc) => doc.fold ? { f: 'Outside', b: 'Inside', m: 'Master' } : { f: 'Front', b: 'Back', m: 'Master' };
// A finished copy of the design as its own canvas (full size unless `scale`), front unless `face`.
async function dzCanvas(doc, scale = 1, face) {
  const cv = document.createElement('canvas'); cv.width = Math.round(doc.w * scale); cv.height = Math.round(doc.h * scale);
  await dzDraw(cv, doc, scale, { face }); return cv;
}

/* ---------- Templates ---------- */
let dzN = 0; const dzId = () => 'L' + Date.now().toString(36) + (dzN++);
const dzT = (text, x, y, w, size, o = {}) => ({ id: dzId(), t: 'text', text, x, y, w, h: size * 1.2, size, font: '@2', c: '@fg', al: 'left', lh: 1.2, ...o });
const dzLogo = (x, y, w, h, o = {}) => ({ id: dzId(), t: 'image', logo: true, x, y, w, h, ...o });
const dzS = (shape, x, y, w, h, o = {}) => ({ id: dzId(), t: 'shape', shape, x, y, w, h, fill: '@accent', ...o });
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
      dzT('From {from}. Valid until {expires}. Book on {phone} or {instagram}.', W * 0.05, H * 0.62, W * 0.62, H * 0.045, { c: '@soft' })]]
  ],
  card: [
    ['Logo left', (W, H) => [dzLogo(W * 0.06, H * 0.2, W * 0.28, H * 0.6), dzS('rect', W * 0.375, H * 0.19, 5, H * 0.62),
      dzT('{studio}', W * 0.42, H * 0.2, W * 0.54, H * 0.13, { font: '@1', fit: 1 }), dzT('{artist}', W * 0.42, H * 0.37, W * 0.54, H * 0.07, { c: '@accent' }),
      dzT('{phone}\n{instagram}', W * 0.42, H * 0.56, W * 0.54, H * 0.065, { lh: 1.45 })]],
    ['Centred', (W, H) => [dzLogo(W * 0.38, H * 0.08, W * 0.24, H * 0.32), dzT('{studio}', W * 0.06, H * 0.44, W * 0.88, H * 0.13, { font: '@1', al: 'center', fit: 1 }),
      dzS('line', W * 0.4, H * 0.66, W * 0.2, 3), dzT('{phone}  ·  {instagram}', W * 0.06, H * 0.74, W * 0.88, H * 0.06, { al: 'center', c: '@soft' })]],
    ['Bold band', (W, H) => [dzS('rect', 0, H * 0.62, W, H * 0.38), dzT('{studio}', W * 0.07, H * 0.14, W * 0.62, H * 0.16, { font: '@1', fit: 1 }),
      dzT('{artist}', W * 0.07, H * 0.36, W * 0.62, H * 0.075, { c: '@soft' }), dzLogo(W * 0.72, H * 0.08, W * 0.22, H * 0.46),
      dzT('{phone}   {instagram}', W * 0.07, H * 0.73, W * 0.86, H * 0.07, { c: '@bg' })]]
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
      dzLogo(W * 0.4, H * 0.7, W * 0.2, H * 0.1), dzT('{studio}\n{phone}  ·  {instagram}', W * 0.08, H * 0.83, W * 0.84, H * 0.024, { al: 'center', lh: 1.6, c: '@soft' })]]
  ],
  post: [
    ['Announcement', (W, H) => [dzS('rect', W * 0.05, H * 0.05, W * 0.9, H * 0.9, { fill: 'none', stroke: '@accent', sw: 6, r: 20 }),
      dzT('BOOKS OPEN', W * 0.1, H * 0.3, W * 0.8, H * 0.13, { font: '@1', al: 'center' }),
      dzT('Message me to book your spot', W * 0.1, H * 0.48, W * 0.8, H * 0.045, { al: 'center', c: '@accent' }),
      dzLogo(W * 0.4, H * 0.64, W * 0.2, H * 0.16), dzT('{instagram}', W * 0.1, H * 0.84, W * 0.8, H * 0.035, { al: 'center', c: '@soft' })]],
    ['Flash', (W, H) => [dzT('Available flash', W * 0.07, H * 0.06, W * 0.86, H * 0.08, { font: '@1', al: 'center' }),
      dzS('rect', W * 0.12, H * 0.2, W * 0.76, H * 0.6, { fill: 'none', stroke: '@soft', sw: 3, r: 16 }),
      dzT('Add your design here', W * 0.12, H * 0.47, W * 0.76, H * 0.035, { al: 'center', c: '@soft' }),
      dzT('{studio}  ·  {instagram}', W * 0.07, H * 0.87, W * 0.86, H * 0.035, { al: 'center', c: '@accent' })]]
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
      dzT('{studio}  ·  {instagram}', m, H - H * 0.06, W - 2 * m, Math.min(W * 0.028, H * 0.021), { al: 'center', c: '@accent' })]; }]
];
// Layout choices for a type: built-in ones, your saved templates, then a blank page.
const dzCustom = () => { try { return JSON.parse(Settings.get('dz_tpls', '[]')); } catch { return []; } };
function dzLayouts(kind) {
  const built = DZ_KINDS[kind]?.social ? [...DZ_TATTOO, ...DZ_TEMPLATES.post] : DZ_TEMPLATES[kind];
  return [...(built || []).map(t => ({ name: t[0], make: t[1] })), ...dzCustom().filter(c => c.kind === kind).map(c => ({ name: c.name, custom: c })), { name: 'Blank' }];
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
  if (opt?.custom) { doc = JSON.parse(JSON.stringify(opt.custom.doc)); doc.layers.forEach(l => l.id = dzId()); doc.theme = theme || doc.theme; }
  else doc = { v: 1, kind, w: k.w, h: k.h, theme, bg: { c: '@bg' }, layers: opt?.make ? opt.make(k.w, k.h) : [] };
  doc.kind = kind; doc.w = k.w; doc.h = k.h;
  delete doc.dpi; delete doc.paper; delete doc.fold;
  if (k.social) delete doc.sides; else if (sides || size?.fold) doc.sides = 2; else if (!opt?.custom) delete doc.sides;
  if (size) { doc.w = size.w; doc.h = size.h; doc.dpi = size.dpi;
    doc.paper = size.fold ? `${size.label}, ${size.sheet} sheet (${dzMM(size.mm[0])} × ${dzMM(size.mm[1])} mm)` : `${size.label}, ${dzMM(size.mm[0])} × ${dzMM(size.mm[1])} mm`;
    if (size.fold) doc.fold = size.fold; }
  doc.vals = kind === 'voucher' ? { amount: '', to: '', from: '', ...(opt?.custom ? doc.vals : {}), code, expires: ymd(exp) } : {};
  dzFillSlots(doc, piece);
  return doc;
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
// photos: true = portfolio photos, 'refs' = references, false = whole portfolio pieces.
function dzPortfolioPick(photos) {
  return new Promise(async (res) => {
    const rows = photos === 'refs'
      ? await DB.all(`SELECT photo_ref AS v, thumb_ref AS t, title FROM ref_images ORDER BY category COLLATE NOCASE, created_at DESC LIMIT 400`)
      : photos
      ? await DB.all(`SELECT x.photo_ref AS v, x.thumb_ref AS t, p.title FROM portfolio_photos x JOIN portfolio_items p ON p.id = x.item_id ORDER BY coalesce(p.made_on, p.created_at) DESC, x.sort LIMIT 240`)
      : await DB.all(`SELECT p.id AS v, p.title, (SELECT thumb_ref FROM portfolio_photos x WHERE x.item_id = p.id ORDER BY sort, id LIMIT 1) AS t
          FROM portfolio_items p WHERE EXISTS (SELECT 1 FROM portfolio_photos x WHERE x.item_id = p.id) ORDER BY coalesce(p.made_on, p.created_at) DESC LIMIT 240`);
    if (!rows.length) { toast(photos === 'refs' ? 'No references yet: add some in Portfolio › References.' : 'Add tattoos with photos to your portfolio first.'); return res(null); }
    const urls = await Promise.all(rows.map(r => Media.url(r.t)));
    const o = document.createElement('div'); o.id = 'merge-dlg'; o.style.zIndex = 99;
    o.innerHTML = `<div class="card dz-pick"><h2>${photos === 'refs' ? 'Choose a reference' : photos ? 'Choose a photo' : 'Choose a portfolio piece'}</h2>
      <div class="dz-pf">${rows.map((r, i) => `<button data-v="${esc(r.v)}" title="${esc(r.title || '')}"><img src="${urls[i]}" alt=""></button>`).join('')}</div>
      <button class="btn" data-v="" style="width:100%;margin-top:10px">Cancel</button></div>`;
    o.onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; o.remove(); res(b.dataset.v ? (photos ? b.dataset.v : +b.dataset.v) : null); };
    document.body.appendChild(o);
  });
}

/* ---------- List of designs ---------- */
const DZ = {};
DZ.list = async () => {
  const el = $('#dz-list'); if (!el) return;
  const rows = await DB.all('SELECT id, name, kind, thumb_ref, updated_at, CASE WHEN kind = ? THEN doc END AS doc FROM designs ORDER BY updated_at DESC, id DESC', ['page']);
  const urls = await Promise.all(rows.map(r => Media.url(r.thumb_ref)));
  el.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="muted" style="margin:0;flex:1;font-size:13px">Vouchers, business cards, flyers and posts with your studio's details.</p>
      <button class="btn primary" id="dz-new">+ New design</button></div>
    ${rows.length ? `<div class="dz-grid">${rows.map((r, i) => `<div class="dz-item" data-open="${r.id}">
        <div class="dz-thumb">${urls[i] ? `<img src="${urls[i]}" alt="">` : ''}</div>
        <div class="dz-meta"><b>${esc(r.name)}</b><span class="muted">${esc(r.kind === 'page' ? (JSON.parse(r.doc || '{}').paper || 'Blank page').split(',')[0] + ' page' : DZ_KINDS[r.kind]?.label || '')}</span></div>
        <button class="mini" data-dup="${r.id}" aria-label="Duplicate" data-tip="Duplicate">⧉</button>
        <button class="mini del" data-del="${r.id}" aria-label="Delete">&times;</button></div>`).join('')}</div>`
      : `<div class="empty"><div class="empty-ico">${ICON.design}</div><div style="font:24px var(--display)">Make something</div>
         <div class="muted">Start from a template; your studio name, logo and details fill in for you.</div></div>`}`;
  el.onclick = async (e) => {
    const t = e.target, d = (k) => t.closest(`[data-${k}]`)?.dataset[k];
    if (t.closest('#dz-new')) return dzPicker();
    if (d('del')) {
      const r = await DB.one('SELECT name, thumb_ref FROM designs WHERE id = ?', [+d('del')]);
      if (!r || !confirm(`Delete "${r.name}"? This can't be undone.`)) return;
      const refs = (await DB.all('SELECT ref FROM design_assets WHERE design_id = ?', [+d('del')])).map(x => x.ref);
      await DB.run('DELETE FROM designs WHERE id = ?', [+d('del')]);
      for (const ref of [r.thumb_ref, ...refs]) await Media.release(ref);
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
  const st = { kind: null, li: 0, theme: 'ink', piece: opts.piece ? await dzPiece(opts.piece) : null,
    ps: Settings.get('dz_paper', 'A4'), land: false, cw: 200, ch: 200, cu: 'mm', ft: 'tri', fs: Settings.get('dz_fold_sheet', 'A4'), two: false };
  // The chosen blank page size (mm, turned for landscape) at its dpi.
  const size = () => {
    if (DZ_KINDS[st.kind]?.fold) return dzFold(st.ft, st.fs);
    if (!DZ_KINDS[st.kind]?.page) return null;
    const f = { mm: 1, cm: 10, in: 25.4 }[st.cu], p = DZ_PAPER.find(x => x[0] === st.ps);
    let [w, h] = p ? [p[1], p[2]] : [Math.min(1200, Math.max(20, st.cw * f)), Math.min(1200, Math.max(20, st.ch * f))];
    if (p && st.land !== w > h) [w, h] = [h, w];
    return dzPaper(w, h, p ? p[0] : 'Custom');
  };
  const o = document.createElement('div'); o.id = 'merge-dlg';
  const kinds = Object.entries(DZ_KINDS).filter(([, v]) => !st.piece || v.social);
  const draw = async () => {
    if (!st.kind) {
      o.innerHTML = `<div class="card dz-pick"><h2>${st.piece ? 'Make a post' : 'New design'}</h2>
        ${st.piece ? '' : '<div class="lbl">Print</div>'}<div class="dz-kinds">${kinds.filter(([, v]) => !v.social).map(([k, v]) =>
          `<button data-kind="${k}"><span class="dz-shape" style="aspect-ratio:${v.w}/${v.h}"></span><b>${v.label}</b><small>${v.sub}</small></button>`).join('')}</div>
        <div class="lbl" style="margin-top:10px">Social posts ${st.piece ? '' : '<span class="muted">(show off a tattoo)</span>'}</div><div class="dz-kinds three">${kinds.filter(([, v]) => v.social).map(([k, v]) =>
          `<button data-kind="${k}"><span class="dz-shape" style="aspect-ratio:${v.w}/${v.h}"></span><b>${v.label}</b><small>${v.sub}</small></button>`).join('')}</div>
        <button class="btn" data-x style="width:100%;margin-top:12px">Cancel</button></div>`;
      return;
    }
    const lays = dzLayouts(st.kind), social = DZ_KINDS[st.kind].social, pu = st.piece ? await Media.url(st.piece.thumb) : '';
    const sz = size();
    o.innerHTML = `<div class="card dz-pick"><h2>${DZ_KINDS[st.kind].label}</h2>
      ${sz?.fold ? `<div class="lbl">Fold</div><div class="dz-papers">${Object.entries(DZ_FOLD_TYPES).map(([k, v]) =>
          `<button data-ft="${k}" class="${st.ft === k ? 'on' : ''}"><b>${v.name}</b><small>${v.sub}</small></button>`).join('')}</div>
        <div class="lbl" style="margin-top:10px">Sheet, laid flat</div><div class="dz-papers">${DZ_FOLD_SHEETS.map(n => { const pp = DZ_PAPER.find(x => x[0] === n);
          return `<button data-fs="${n}" class="${st.fs === n ? 'on' : ''}"><b>${n}</b><small>${dzMM(pp[2])} × ${dzMM(pp[1])}</small></button>`; }).join('')}</div>
        <p class="muted" style="font-size:12px;margin:6px 0 12px">You design both sides: the outside on top, the inside below it, with the folds marked.
          Panels: ${sz.fold.lo.join(', ')}. ${sz.dpi} dpi.</p>` : ''}
      ${sz && !sz.fold ? `<div class="lbl">Size</div><div class="dz-papers">${[...DZ_PAPER.map(x => x[0]), 'Custom'].map(n => {
          const pp = DZ_PAPER.find(x => x[0] === n);
          return `<button data-ps="${esc(n)}" class="${st.ps === n ? 'on' : ''}"><b>${esc(n)}</b><small>${pp ? `${dzMM(pp[1])} × ${dzMM(pp[2])}` : 'your size'}</small></button>`; }).join('')}</div>
        ${st.ps === 'Custom' ? `<div class="dz-csize"><label><span>W</span><input class="in" type="number" inputmode="decimal" min="0" step="any" data-cs="cw" value="${st.cw}"></label>
          <span class="muted">×</span><label><span>H</span><input class="in" type="number" inputmode="decimal" min="0" step="any" data-cs="ch" value="${st.ch}"></label>
          <select class="in" data-cs="cu">${['mm', 'cm', 'in'].map(u => `<option ${st.cu === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>`
        : `<div class="seg" style="margin-top:8px">${[[false, 'Portrait'], [true, 'Landscape']].map(([v, n]) => `<button data-land="${v ? 1 : 0}" class="${st.land === v ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>`}
        <p class="muted" style="font-size:12px;margin:6px 0 12px">${dzMM(sz.mm[0])} × ${dzMM(sz.mm[1])} mm, ${sz.w} × ${sz.h} px at ${sz.dpi} dpi${sz.dpi < 300 ? ' (large pages use a lower dpi so they open on phones and tablets)' : ''}.</p>` : ''}
      ${social ? `<div class="dz-piece">${pu ? `<img src="${pu}" alt="">` : '<span class="muted">No tattoo chosen</span>'}
        <div><b>${esc(st.piece?.vals.title || (st.piece ? 'Untitled piece' : 'Show off a tattoo'))}</b><small class="muted">${st.piece ? `${st.piece.photos.length} photo${st.piece.photos.length > 1 ? 's' : ''}` : 'Pick a portfolio piece to fill the photos, title and hashtags'}</small></div>
        <button class="btn small" data-piece>${st.piece ? 'Change' : 'Choose'}</button></div>` : ''}
      ${!social && !sz?.fold ? `<div class="lbl">Sides</div><div class="seg" style="margin-bottom:12px">${[[false, 'One side'], [true, 'Front and back']].map(([v, n]) =>
          `<button data-two="${v ? 1 : 0}" class="${st.two === v ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>` : ''}
      <div class="lbl">Layout</div><div class="dz-tpls">${lays.map((l, i) =>
        `<button data-li="${i}" class="${st.li === i ? 'on' : ''}"><canvas data-prev="${i}"></canvas><span>${esc(l.name)}${l.custom ? ' <em>yours</em>' : ''}</span>
          ${l.custom ? `<i class="dz-tdel" data-tdel="${esc(l.custom.id)}" title="Delete this template">&times;</i>` : ''}</button>`).join('')}</div>
      <div class="lbl" style="margin-top:12px">Theme</div><div class="dz-themes">${Object.entries(DZ_THEMES).map(([k, t]) =>
        `<button data-theme="${k}" class="${st.theme === k ? 'on' : ''}"><i style="background:${t.bg}"></i><i style="background:${t.accent}"></i><i style="background:${t.fg}"></i><span>${t.name}</span></button>`).join('')}</div>
      <div class="row" style="margin-top:14px"><button class="btn" data-back>Back</button><button class="btn primary" data-go style="flex:1">Create</button></div></div>`;
    for (const cv of o.querySelectorAll('canvas[data-prev]')) {
      const doc = dzNew(st.kind, lays[+cv.dataset.prev], st.theme, st.piece, sz, st.two), sc = 220 / Math.max(doc.w, doc.h);
      cv.width = Math.round(doc.w * sc); cv.height = Math.round(doc.h * sc); dzDraw(cv, doc, sc);
    }
  };
  o.onclick = async (e) => {
    const t = e.target, d = (k) => t.closest(`[data-${k}]`)?.dataset[k];
    if (t.closest('[data-x]')) return o.remove();
    if (d('kind')) { st.kind = d('kind'); st.li = 0; st.two = false; return draw(); }
    if (d('two') != null) { st.two = d('two') === '1'; return draw(); }
    if (t.closest('[data-back]')) { st.kind = null; return draw(); }
    if (d('tdel')) { e.stopPropagation();
      if (!confirm('Delete this template? Designs made from it are not affected.')) return;
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
      const base = sz ? (sz.fold ? `${sz.label} pamphlet` : `${sz.label} page`) : DZ_KINDS[st.kind].label;
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
  el.innerHTML = `<div class="dz-ed">
    <div class="dz-top">
      <button class="btn icon-btn" id="dz-back" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <input class="in" id="dz-name" value="${esc(name)}" aria-label="Design name">
      <button class="btn icon-btn" id="dz-undo" aria-label="Undo" data-tip="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
      <button class="btn icon-btn" id="dz-redo" aria-label="Redo" data-tip="Redo"><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg></button>
      <button class="btn icon-btn" id="dz-panel" aria-label="Hide the panel" data-tip="Hide or show the side panel"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>
      <button class="btn icon-btn" id="dz-focus" aria-label="Full screen design" data-tip="Full screen: the design fills the screen"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
      <button class="btn icon-btn" id="dz-tpl" aria-label="Save as template" data-tip="Save as template, to start new designs from it"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg></button>
      <button class="btn primary" id="dz-export">Export</button>
    </div>
    <div class="dz-body">
      <div class="dz-stage" id="dz-stage"><div class="dz-page" id="dz-page"><canvas id="dz-cv"></canvas><div id="dz-folds"></div><div id="dz-multi"></div><canvas id="dz-cutcv"></canvas><canvas id="dz-nodecv"></canvas><canvas id="dz-contcv"></canvas><canvas id="dz-pencv"></canvas><div id="dz-sel" hidden>
        <i class="h nw" data-h="nw"></i><i class="h ne" data-h="ne"></i><i class="h sw" data-h="sw"></i><i class="h se" data-h="se"></i>
        <i class="h e" data-h="e"></i><i class="h w" data-h="w"></i><i class="h n" data-h="n"></i><i class="h s" data-h="s"></i><i class="h rot" data-h="rot"></i></div>
        <i class="dz-guide v" hidden></i><i class="dz-guide hz" hidden></i></div>
        <div class="dz-faces" id="dz-faces"></div>
        <div class="dz-mods" id="dz-mods" hidden><button data-mod="shift" title="Shift: straight lines, 45° steps, keep proportions">⇧ Shift</button><button data-mod="alt" title="Alt: break a handle, a sharp turn, move freely">⌥ Alt</button><button data-mod="ctrl" title="Ctrl: no snapping, pick several">Ctrl</button></div><div class="dz-zoom"><button data-z="out" aria-label="Zoom out">−</button><button data-z="fit" id="dz-zl" data-tip="Show the whole design">Fit</button><button data-z="in" aria-label="Zoom in">+</button></div></div>
      <div class="dz-side" id="dz-side"></div>
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
  const tb = () => doc.sides ? 48 : 0;   // room above the design for the page tabs
  const fit = (crisp = true) => {
    // On phones the stage hugs the design's shape, so a wide card doesn't leave empty space above and below.
    if (innerWidth < 900 && !document.body.classList.contains('dz-focus')) { const sw = stage.clientWidth; stage.style.height = Math.round(Math.min(innerHeight * 0.58, (sw - 32) * doc.h / doc.w + 32 + tb())) + 'px'; }
    else stage.style.height = '';
    const r = stage.getBoundingClientRect(), pad = 16;
    fitK = Math.min((r.width - pad * 2) / doc.w, (Math.max(260, r.height) - tb() - pad * 2) / doc.h); k = fitK * z;
    const w = doc.w * k, h = doc.h * k;
    // Keep some of the design on screen however far it's dragged.
    const mx = Math.max(0, (r.width + w) / 2 - 80), my = Math.max(0, (r.height + h) / 2 - 80);
    vx = Math.max(-mx, Math.min(mx, vx)); vy = Math.max(-my, Math.min(my, vy));
    Object.assign(page.style, { width: w + 'px', height: h + 'px', left: (r.width - w) / 2 + vx + 'px', top: (r.height - h + tb()) / 2 + vy + 'px' });
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    // The drawing itself: device resolution, capped so a big zoom doesn't make a huge canvas.
    if (crisp) { rs = Math.min(k * Math.min(2, devicePixelRatio || 1), 4096 / Math.max(doc.w, doc.h)); cv.width = Math.round(doc.w * rs); cv.height = Math.round(doc.h * rs); }
    const zl = $('#dz-zl'); if (zl) zl.textContent = Math.abs(z - 1) < 0.01 && !vx && !vy ? 'Fit' : Math.round(z * 100) + '%';
    drawFolds(); drawCut(); drawNodes(); drawCont(); drawPen(); placeSel();
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
  const redraw = async () => { const job = (drawing = Symbol()); await dzDraw(cv, doc, rs, { ghost: cropping ? sel : null, face }); if (job === drawing) placeSel(); };
  // Page tabs (top right of the design): front, back and the master page under both.
  const drawFaces = () => {
    const b = $('#dz-faces'); if (!b) return; b.hidden = !doc.sides; if (!doc.sides) return;
    const nm = dzFaceNames(doc), n = (f) => doc.layers.filter(l => dzSide(l) === f).length;
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
    selBox.classList.toggle('locked', !!l.lock); selBox.classList.toggle('textsel', l.t === 'text'); selBox.classList.toggle('cropping', cropping);
    for (const [kk, v] of [['w', l.w], ['h', l.h || 0]]) { const i = side?.querySelector(`[data-dim="${kk}"]`); if (i && document.activeElement !== i) i.value = dzToU(doc, v); }
  };

  // Saving: a few seconds after changes, with a small thumbnail for the list; pictures listed for backups.
  let saveT = null, saving = null, dirty = false;
  const save = () => { dirty = true; clearTimeout(saveT); saveT = setTimeout(flush, 900); };
  // Writes now (also when leaving the editor, so the list always has the latest thumbnail).
  const flush = () => { clearTimeout(saveT); if (!dirty) return saving || Promise.resolve(); dirty = false; return (saving = (async () => {
    const th = await dzCanvas(doc, 360 / Math.max(doc.w, doc.h));
    const ref = await Media.save(await new Promise(r => th.toBlob(r, 'image/jpeg', 0.8)), 'jpg');
    const old = (await DB.one('SELECT thumb_ref FROM designs WHERE id = ?', [id]))?.thumb_ref;
    const refs = [...new Set([doc.bg?.img, ...doc.layers.filter(l => l.t === 'image' && l.ref).map(l => l.ref), ...doc.layers.map(l => l.tex?.ref)].filter(Boolean))];
    const before = (await DB.all('SELECT ref FROM design_assets WHERE design_id = ?', [id])).map(x => x.ref);
    await DB.tx([{ sql: `UPDATE designs SET name = ?, doc = ?, thumb_ref = ?, updated_at = datetime('now') WHERE id = ?`, params: [name, JSON.stringify(doc), ref, id] },
      { sql: 'DELETE FROM design_assets WHERE design_id = ?', params: [id] },
      ...refs.map(r => ({ sql: 'INSERT INTO design_assets (design_id, ref) VALUES (?, ?)', params: [id, r] }))]);
    if (old && old !== ref) await Media.release(old);
    for (const r of before) if (!refs.includes(r)) dropped.add(r);
    if ($('#dz-list')) DZ.list();
  })()); };
  const dropped = new Set(), made = new Set();   // pictures taken out (or made) while editing; tidied when leaving
  const docRefs = () => [doc.bg?.img, ...doc.layers.map(l => l.ref), ...doc.layers.map(l => l.tex?.ref)].filter(Boolean);
  addEventListener('hashchange', function away() { removeEventListener('hashchange', away); focus(false);
    flush().then(async () => { const keep = docRefs(); for (const r of new Set([...dropped, ...made])) if (!keep.includes(r)) await Media.release(r); }); });
  // A change: redraw, remember for undo, save.
  let histT = null;
  const changed = (now) => {
    redraw(); save();
    clearTimeout(histT);
    const push = () => { const s = JSON.stringify(doc); if (s !== hist[hi]) { hist.splice(hi + 1); hist.push(s); if (hist.length > 60) hist.shift(); hi = hist.length - 1; } };
    if (now) push(); else histT = setTimeout(push, 450);
  };
  const undo = (d) => { const n = hi + d; if (n < 0 || n >= hist.length) return; hi = n; doc = JSON.parse(hist[hi]); doc.vals ||= {}; endCut(); endNodes(); endCont(); pen = null; drawPen(); if (!layer()) sel = null;
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
  const layerName = (l) => l.name || (l.t === 'text' ? ((dzFill(doc, l.text).trim() || l.text).split('\n')[0].trim().slice(0, 30) || 'Text')
    : l.t === 'image' ? (l.logo ? 'Logo' : l.slot != null ? `Photo ${l.slot + 1}` : 'Picture')
    : ({ ellipse: 'Circle', line: 'Line', star: 'Star', path: 'Traced shape' }[l.shape] || ((!l.fill || l.fill === 'none') && l.sw ? 'Frame' : 'Shape')));
  const layerIco = (l) => l.t === 'text' ? 'T' : l.t === 'image' ? (l.logo ? '◎' : '▣') : '◆';
  const drawLayers = () => {
    side.innerHTML = `<div class="dz-lbar"><button class="btn small ${picking ? 'primary' : ''}" data-mact="${picking ? 'done' : 'pick'}">${picking ? 'Done selecting' : 'Select…'}</button>
        ${picking || picks.size ? `<button class="btn small" data-mact="all">All</button><button class="btn small" data-mact="none" ${picks.size ? '' : 'disabled'}>None</button>` : ''}</div>
      ${doc.sides ? `<p class="muted" style="font-size:12px;margin:0 2px 8px">${face === 'm' ? 'Master page: shown under both sides.' : `${dzFaceNames(doc)[face]} only. The master page shows underneath.`}</p>` : ''}
      <div class="dz-ll" id="dz-ll">${[...F()].reverse().map(l => { const i = F().indexOf(l), cl = i > 0 && l.clip;
        return `<div class="dz-lr ${l.id === sel || picks.has(l.id) ? 'on' : ''} ${l.hide ? 'off' : ''} ${cl ? 'clip' : ''}" data-lid="${l.id}">
        <span class="grip" data-grip aria-label="Drag to reorder">⠿</span><span class="li">${layerIco(l)}</span>
        <span class="nm" data-lname title="${l.id === sel ? 'Tap to rename' : 'Tap to select'}">${cl ? '<b class="clipmark">↳</b>' : ''}${esc(layerName(l))}</span>
        <button data-lclip class="${cl ? 'on' : ''}" ${i ? '' : 'disabled'} title="${cl ? 'Unclip' : 'Clip to the layer below: only shows inside it'}" aria-label="Clip to layer below"><svg viewBox="0 0 24 24"><path d="M7 4v10a3 3 0 0 0 3 3h10"/><path d="M16 13l4 4-4 4"/></svg></button>
        <button data-lhide title="${l.hide ? 'Show' : 'Hide'}" aria-label="${l.hide ? 'Show' : 'Hide'}">${l.hide ? EYE_OFF : EYE}</button>
        <button data-llock class="${l.lock ? 'on' : ''}" title="${l.lock ? 'Unlock' : 'Lock'}" aria-label="Lock">${LOCK(l.lock)}</button>
        <button data-ldel title="Delete" aria-label="Delete">✕</button></div>`; }).join('') || '<p class="muted" style="margin:6px 2px">Nothing on the design yet.</p>'}</div>
      <p class="muted" style="font-size:12px;margin:10px 2px 0">The top of the list sits in front. Drag ⠿ to change the order. Tap a name to select it; tap it again to rename.
        Hold a layer (or Ctrl/Shift-click) to select several. ↳ clips a layer to the one below it.</p>`;
  };
  const drawSide = () => {
    if (tab === 'layers') drawLayers(); else drawEdit();
    drawMods();
    side.insertAdjacentHTML('afterbegin', `<div class="seg dz-tabs"><button data-tab="edit" class="${tab === 'edit' ? 'on' : ''}">${layer() || many() ? 'Selected' : 'Design'}</button>
      <button data-tab="layers" class="${tab === 'layers' ? 'on' : ''}">Layers <small>${F().length}</small></button></div>`);
    drawFaces();
  };
  const AL = [['l', 'Left', '<path d="M4 3v18M8 7h12v4H8zM8 14h7v4H8z"/>'], ['c', 'Centre', '<path d="M12 3v18M5 7h14v4H5zM8 14h8v4H8z"/>'], ['r', 'Right', '<path d="M20 3v18M4 7h12v4H4zM9 14h7v4H9z"/>'],
    ['t', 'Top', '<path d="M3 4h18M7 8v12h4V8zM14 8v7h4V8z"/>'], ['m', 'Middle', '<path d="M3 12h18M7 5v14h4V5zM14 8v8h4V8z"/>'], ['b', 'Bottom', '<path d="M3 20h18M7 4v12h4V4zM14 9v7h4V9z"/>'],
    ['dh', 'Space across', '<path d="M3 4v16M21 4v16M9 8h6v8H9z"/>'], ['dv', 'Space down', '<path d="M4 3h16M4 21h16M8 9h8v6H8z"/>']];
  const drawMulti = () => {
    const L = picked(), n = L.length, all = (f) => n && L.every(f);
    side.innerHTML = `<div class="dz-lh"><b>${n ? `${n} selected` : 'Select items'}</b><button class="btn small" data-mact="done">Done</button></div>
      <p class="muted" style="font-size:12px;margin:0 0 10px">${picking ? 'Tap items on the design or in Layers to add or remove them. Drag a selected item to move them all.'
        : 'Ctrl-click adds or removes; Shift-click in Layers picks a range. On a touchscreen, hold an item for a moment.'}</p>
      <div class="row" style="gap:6px;margin-bottom:10px"><button class="btn small" data-mact="all">Select all</button><button class="btn small" data-mact="none" ${n ? '' : 'disabled'}>Clear</button></div>
      <div class="dz-acts">
        <button data-mact="dup" ${n ? '' : 'disabled'} title="Duplicate">⧉<span>Copy</span></button>
        <button data-mact="hide" ${n ? '' : 'disabled'} title="Hide or show">${all(l => l.hide) ? '◌' : '◉'}<span>${all(l => l.hide) ? 'Show' : 'Hide'}</span></button>
        <button data-mact="lock" class="${all(l => l.lock) ? 'on' : ''}" ${n ? '' : 'disabled'} title="Lock">${all(l => l.lock) ? '🔒' : '🔓'}<span>${all(l => l.lock) ? 'Locked' : 'Lock'}</span></button>
        <button data-mact="clip" class="${all(l => l.clip) ? 'on' : ''}" ${n ? '' : 'disabled'} title="Clip to the layer below: each only shows inside it">↳<span>Clip</span></button>
        <button data-mact="del" class="danger" ${n ? '' : 'disabled'} title="Delete">✕<span>Delete</span></button></div>
      ${fsec('Align', `<div class="dz-align">${AL.map(([a, t, ic]) => `<button data-align="${a}" ${!n || (a[0] === 'd' && n < 3) ? 'disabled' : ''} title="${t}${n === 1 && a[0] !== 'd' ? ' (on the page)' : ''}" aria-label="${t}"><svg viewBox="0 0 24 24">${ic}</svg></button>`).join('')}</div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">${n === 1 ? 'One item lines up with the page.' : 'Items line up with each other. Spacing needs three or more.'}</p>`)}
      ${fsec('Shape builder', `<div class="dz-bool">${[['add', 'Add', 'Weld them into one outline'], ['subtract', 'Subtract', 'The bottom one, with the rest cut out of it'],
          ['intersect', 'Intersect', 'Only where they all overlap'], ['xor', 'Exclude', 'Everything except where they overlap'], ['divide', 'Divide', 'Cut into every separate piece the overlaps make'],
          ['separate', 'Separate', 'Split each into its separate pieces'], ['contour', 'Contour', 'Grow or shrink the outline (O)']].map(([b, nm, tip]) =>
          `<button data-bool="${b}" ${!n || (n < 2 && !['separate', 'contour'].includes(b)) ? 'disabled' : ''} title="${tip}">${DZ_BOOL_ICON[b]}<span>${nm}</span></button>`).join('')}</div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">The result is a new shape you can reshape with Edit nodes. Text and pictures are traced first, so they work too.</p>`)}
      ${fsec('Combine and save', `<div class="dz-combine">
        <button class="btn small" data-mact="merge" ${n ? '' : 'disabled'}>Merge into one picture</button>
        <button class="btn small" data-mact="refs" ${n ? '' : 'disabled'}>Save to references</button>
        <button class="btn small" data-mact="png" ${n ? '' : 'disabled'}>Save as PNG</button></div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">Merging turns the selection into a single picture layer on the design (Undo brings the layers back).
          Saving makes a see-through picture of just the selection and leaves the design as it is. Clipped layers go with the layer they're clipped to.</p>`)}`;
  };
  const drawEdit = () => {
    if (cont) { side.innerHTML = contPanel(); return; }
    if (penOn) { side.innerHTML = penPanel(); return; }
    if (pclOn) { side.innerHTML = pclPanel(); return; }
    if (many()) return drawMulti();
    const l = layer();
    if (!l) {
      const kinds = doc.kind === 'voucher' || doc.layers.some(x => /\{(amount|to|from|code|expires)\}/.test(x.text || ''));
      const post = DZ_KINDS[doc.kind].social || doc.layers.some(x => x.slot != null || DZ_PIECE_FIELDS.test(x.text || ''));
      side.innerHTML = `
        <div class="dz-add">${[['text', 'Text', 'T'], ['heading', 'Heading', 'H'], ['image', 'Picture', '▣'], ['logo', 'Logo', '◎'], ['shape', 'Shape', '◆'], ['pen', 'Pen', '✒'], ['pencil', 'Pencil', '✎'], ['field', 'Studio info', '@']]
          .map(([a, n, i]) => `<button data-add="${a}"><i>${i}</i><span>${n}</span></button>`).join('')}</div>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden id="dz-file">
        ${panel === 'image' ? `<div class="dz-shapes"><button data-pic="device">From this device</button><button data-pic="pf">From portfolio</button><button data-pic="refs">From references</button></div>` : ''}
        ${panel === 'shape' ? `<div class="dz-shapes">${[['rect', 'Square'], ['round', 'Rounded'], ['ellipse', 'Circle'], ['tri', 'Triangle'], ['poly', 'Polygon'], ['star', 'Star'], ['heart', 'Heart'], ['arrow', 'Arrow'], ['cross', 'Cross'], ['bubble', 'Speech'], ['ring', 'Ring'], ['line', 'Line'], ['frame', 'Frame']]
          .map(([s, n]) => `<button data-shape="${s}">${n}</button>`).join('')}</div>` : ''}
        ${panel === 'field' ? `<div class="dz-shapes">${DZ_FIELDS.map(([f, n]) => `<button data-field="${f}">${n}</button>`).join('')}</div>` : ''}
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
        ${!DZ_KINDS[doc.kind].social && !doc.fold ? fsec('Sides', `<div class="seg">${[[0, 'One side'], [1, 'Front and back']].map(([v, n]) =>
            `<button data-sides="${v}" class="${!!doc.sides === !!v ? 'on' : ''}" style="flex:1">${n}</button>`).join('')}</div>
          <p class="muted" style="font-size:11px;margin:6px 0 0">${doc.sides ? 'Switch between Front, Back and Master at the top right of the design. Master holds backgrounds and frames shown under both sides.' : 'Front and back adds a back page and a master page for things shared by both.'}</p>`) : ''}
        ${fsec('Theme', `<div class="dz-themes">${Object.entries(DZ_THEMES).map(([kk, t]) =>
          `<button data-theme="${kk}" class="${doc.theme === kk ? 'on' : ''}"><i style="background:${t.bg}"></i><i style="background:${t.accent}"></i><i style="background:${t.fg}"></i><span>${t.name}</span></button>`).join('')}</div>`)}
        ${fsec('Background', `${swatches('bg', doc.bg?.c)}
          <div class="row" style="margin-top:8px"><label class="btn small">${doc.bg?.img ? 'Change picture' : 'Background picture'}<input type="file" accept="image/*" hidden id="dz-bgfile"></label>
          ${doc.bg?.img ? '<button class="btn small danger" id="dz-bgrm">Remove</button>' : ''}</div>
          ${doc.bg?.img ? slider('bgop', 'Picture opacity', 0.05, 1, 0.05, doc.bg.op ?? 1, v => Math.round(v * 100) + '%') : ''}`, { fold: true })}
        <p class="muted" style="font-size:12px;margin:10px 2px">Tap anything on the design to change it. Drag to move, corners to resize, the top dot to rotate. {Fields} like {studio} fill in from Settings.</p>`;
      return;
    }
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
      <div class="dz-acts">
        <button data-act="dup" title="Duplicate">⧉<span>Copy</span></button>
        <button data-act="up" title="Bring forward">▲<span>Forward</span></button>
        <button data-act="down" title="Send back">▼<span>Back</span></button>
        <button data-act="lock" class="${l.lock ? 'on' : ''}" title="Lock">${l.lock ? '🔒' : '🔓'}<span>${l.lock ? 'Locked' : 'Lock'}</span></button>
        ${l.t !== 'text' ? `<button data-act="crop" class="${cropping ? 'on' : ''}" title="Crop">⛶<span>Crop</span></button>` : ''}
        <button data-act="fx" class="${l.fx ? 'on' : ''}" title="Flip left to right">⇋<span>Flip</span></button>
        <button data-act="fy" class="${l.fy ? 'on' : ''}" title="Flip upside down">⇵<span>Flip</span></button>
        <button data-act="clip" class="${clipped(l) ? 'on' : ''}" ${F().indexOf(l) ? '' : 'disabled'} title="Clip to the layer below: only shows inside it">↳<span>Clip</span></button>
        ${l.t === 'image' ? (l.ref || l.logo ? '<button data-act="toshape" title="Trace the picture into a shape you can fill">◆<span>To shape</span></button><button data-act="flatten1" title="Flatten: bake in its rotation, flips, crop and opacity, and fit the handles to what shows">▦<span>Flatten</span></button>' : '')
          : '<button data-act="flatten1" title="Flatten into a picture: its fill and outline become permanent">▦<span>Flatten</span></button>'}
        <button data-bool="contour" title="Contour: grow or shrink the outline, or add a border round it (O)">${DZ_BOOL_ICON.contour}<span>Contour</span></button>
        ${l.t === 'shape' && (l.subs?.length > 1 || l.shape === 'path' || l.shape === 'ring') ? `<button data-bool="separate" title="Split into its separate pieces">${DZ_BOOL_ICON.separate}<span>Separate</span></button>` : ''}
        <button data-act="cut" title="Select part of it with a box, ellipse, lasso or by colour, then delete, split or move that part">⬚<span>Select area</span></button>
        <button data-act="pick" title="Select more items">☐<span>Select</span></button>
        <button data-act="del" class="danger" title="Delete">✕<span>Delete</span></button></div>
      ${groupOf([l.id]).length > 1 ? `<div class="dz-note">${clipped(l) ? 'Clipped to the layer below.' : 'Has layers clipped to it.'}
        <button class="btn small" data-act="flatten">Flatten group</button></div>` : ''}
      <div class="dz-dims">
        <label><span>W</span><input class="in" type="number" inputmode="decimal" min="0" step="any" data-dim="w" value="${dzToU(doc, l.w)}"></label>
        <button class="dz-chain ${dzKeep(l) ? 'on' : ''}" data-act="keep" ${l.t === 'text' ? 'disabled' : ''} title="${dzKeep(l) ? 'Proportions kept: width and height change together' : 'Width and height change separately'}" aria-label="Keep proportions">
          <svg viewBox="0 0 24 24">${dzKeep(l) ? '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
            : '<path d="M15.7 14l3-3a4 4 0 0 0-5.7-5.7l-1 1M8.3 10l-3 3a4 4 0 0 0 5.7 5.7l1-1M8 4v2M4 8h2M16 20v-2M20 16h-2"/>'}</svg></button>
        <label><span>H</span><input class="in" type="number" inputmode="decimal" min="0" step="any" data-dim="h" value="${dzToU(doc, l.h || 0)}" ${l.t === 'text' ? 'disabled title="Text height follows the text; use Size for the letters"' : ''}></label>
        <select class="in" data-unit aria-label="Unit">${(DZ_KINDS[doc.kind].social ? ['px', 'mm', 'cm', 'in'] : ['mm', 'cm', 'in', 'px']).map(u => `<option ${dzUnit(doc) === u ? 'selected' : ''}>${u}</option>`).join('')}</select>
      </div>
      ${l.t === 'text' ? `
        <textarea class="in dz-text" data-k="text" rows="3">${esc(l.text)}</textarea>
        <div class="dz-fields">${DZ_FIELDS.map(([f, n]) => `<button data-ins="${f}">+ ${n}</button>`).join('')}</div>
        <label class="field"><span>Font</span><select class="in" data-k="font">${fontOpts(l.font)}</select></label>
        <div class="row" style="gap:6px;flex-wrap:nowrap">
          <div class="seg" style="flex:1">${[['left', '⟸'], ['center', '≡'], ['right', '⟹']].map(([a, i]) => `<button data-al="${a}" class="${(l.al || 'left') === a ? 'on' : ''}" style="flex:1" aria-label="Align ${a}">${i}</button>`).join('')}</div>
          <button class="btn small ${l.b ? 'primary' : ''}" data-tog="b" style="font-weight:800">B</button><button class="btn small ${l.it ? 'primary' : ''}" data-tog="it" style="font-style:italic">I</button></div>
        <label class="toggle" style="display:inline-flex;margin-top:8px" data-tip="Long text gets smaller to stay on its lines instead of wrapping, e.g. a studio name or amount"><input type="checkbox" data-fit ${l.fit ? 'checked' : ''}><span>Shrink to fit</span></label>
        ${slider('size', 'Size', 8, Math.round(doc.h * 0.4), 1, Math.round(l.size))}
        ${slider('arc', 'Bend', -360, 360, 5, l.arc || 0, v => +v === 0 ? 'straight' : (v > 0 ? 'up ' : 'down ') + Math.abs(v) + '°')}
        ${l.arc ? '<p class="muted" style="font-size:11px;margin:-4px 0 8px">Bent text runs on one line. <button class="link" data-act="unbend">Straighten</button></p>' : ''}
        <div class="lbl">Colour</div>${fillUI(l, 'c')}${l.arc && l.fm && l.fm !== 'solid' ? '<p class="muted" style="font-size:11px;margin:4px 0 0">Bent text shows the plain colour.</p>' : ''}
        ${fsec('Spacing', slider('ls', 'Letter spacing', -5, 40, 1, l.ls || 0) + slider('lh', 'Line height', 0.8, 2.5, 0.05, l.lh || 1.2), { fold: true })}`
      : l.t === 'shape' ? `
        <div class="lbl">${l.shape === 'line' ? 'Colour' : 'Fill'}</div>${fillUI(l, 'fill', true)}
        <div class="lbl" style="margin-top:8px">Outline</div>${swatches('stroke', l.stroke, true)}
        ${slider('sw', 'Outline width', 0, 40, 1, l.sw || 0)}
        ${l.shape === 'rect' || !l.shape ? slider('r', 'Corner rounding', 0, Math.round(Math.min(l.w, l.h) / 2), 1, l.r || 0) : ''}
        ${l.shape === 'poly' ? slider('n', 'Sides', 3, 16, 1, l.n || 6) : ''}
        ${l.shape === 'star' ? slider('n', 'Points', 3, 24, 1, l.n || 5) + slider('inner', 'Inner depth', 0.1, 0.95, 0.01, l.inner ?? 0.45, v => Math.round(v * 100) + '%') : ''}
        ${l.shape === 'ring' ? slider('inner', 'Hole', 0.05, 0.95, 0.01, l.inner ?? 0.6, v => Math.round(v * 100) + '%') : ''}
        ${l.shape === 'cross' || l.shape === 'arrow' ? slider('th', 'Thickness', 0.05, 0.95, 0.01, l.th ?? (l.shape === 'cross' ? 0.34 : 0.4), v => Math.round(v * 100) + '%') : ''}
        ${l.shape !== 'line' ? `<button class="btn small" data-act="nodes" style="margin-top:8px">${l.shape === 'vec' ? 'Edit nodes' : 'Edit nodes (turns it into a free shape)'}</button>` : ''}`
      : `${l.logo ? '<p class="muted" style="font-size:12px;margin:0 0 8px">Your studio logo from Settings.</p>'
          : `<div class="row" style="gap:6px;margin-bottom:8px;flex-wrap:wrap"><button class="btn small" id="dz-pfphoto">From portfolio</button><button class="btn small" id="dz-refphoto">From references</button>
              <label class="btn small">From device<input type="file" accept="image/*" hidden id="dz-repl"></label></div>`}
        ${l.logo ? '' : `<label class="toggle" style="display:inline-flex;margin-bottom:6px" data-tip="Fill the whole box and crop what doesn't fit, like a photo frame. Off: the whole picture fits inside."><input type="checkbox" data-cover ${l.cover ? 'checked' : ''}><span>Fill the box (crop)</span></label>
          ${l.cover ? slider('px', 'Move photo left / right', -1, 1, 0.02, l.px || 0, v => Math.round(v * 100)) + slider('py', 'Move photo up / down', -1, 1, 0.02, l.py || 0, v => Math.round(v * 100)) : ''}
          ${slider('r', 'Corner rounding', 0, Math.round(Math.min(l.w, l.h) / 2), 1, l.r || 0)}
          <div class="lbl">Outline</div>${swatches('stroke', l.stroke, true)}${slider('sw', 'Outline width', 0, 40, 1, l.sw || 0)}`}`}
      ${slider('op', 'Opacity', 0, 1, 0.05, l.op ?? 1, v => Math.round(v * 100) + '%')}
      ${slider('rot', 'Rotation', -180, 180, 1, Math.round(l.rot || 0), v => v + '°')}
      ${fsec('Save', `<div class="dz-combine"><button class="btn small" data-mact="refs">Save to references</button><button class="btn small" data-mact="png">Save as PNG</button>
        ${l.t !== 'image' || l.crop || l.r ? '<button class="btn small" data-mact="merge">Turn into a picture</button>' : ''}</div>`, { fold: true })}`;
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
    const bs = bases.map(box), bx = Math.floor(Math.min(...bs.map(b => b.x0))), by = Math.floor(Math.min(...bs.map(b => b.y0)));
    const bw = Math.max(1, Math.ceil(Math.max(...bs.map(b => b.x1))) - bx), bh = Math.max(1, Math.ceil(Math.max(...bs.map(b => b.y1))) - by);
    const d = JSON.parse(JSON.stringify({ ...doc, layers: vis })); d.w = bw; d.h = bh; delete d.sides;
    for (const l of d.layers) { l.x -= bx; l.y -= by; }
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
    if (!confirm(`${list.length === 1 ? (list[0].t === 'image' ? 'Flatten this picture? Its rotation, flips, crop and opacity become part of it, and its handles fit what shows.' : 'Flatten this layer into a picture? Its fill and outline become part of the picture.') : `Merge ${list.length} layers into one picture?`}${txt ? '\n\nText becomes part of the picture and can no longer be edited.' : ''}\n\nUndo brings the layers back.`)) return;
    const f = await flatten(list); if (!f) return;
    const ref = await Media.save(await pngOf(f.cv), 'png'); made.add(ref);
    const gone = new Set(list.map(l => l.id)), top = Math.max(...list.map(l => doc.layers.indexOf(l)));
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
        d.snap = holdStart(g, p); d.pts = d.snap.cur.map(q => [q.x, q.y]); d.cur = null; drawCut(); toast(g.label + ': keep holding and move to resize.', 2500); });
    } else d.p1 = p;
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
      <div class="seg dz-ctools">${[['box', '▭ Box'], ['ellipse', '◯ Ellipse'], ['lasso', '✎ Lasso'], ['pen', '✒ Pen'], ['color', '◉ Colour']].map(([t, n]) => `<button data-ctool="${t}" class="${T === t ? 'on' : ''}">${n}</button>`).join('')}</div>
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
    const p = toPage(e), q0 = p2n(L, d.p0), q1 = p2n(L, p); let du = q1.u - q0.u, dv = q1.v - q0.v;
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
  const styleOf = (l) => l.t === 'shape' ? { fill: l.fill, stroke: l.stroke, sw: l.sw, fm: l.fm, grad: l.grad && JSON.parse(JSON.stringify(l.grad)), tex: l.tex && { ...l.tex }, op: l.op ?? 1 }
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
      <input class="in" type="number" step="any" inputmode="decimal" data-contd value="${dzToU(doc, copt2.d)}"></label>
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
      if (e.shiftKey && ln) p = snap45(ln, p);
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
  addEventListener('keyup', function penKeys(e) { if (!document.body.contains(el)) return removeEventListener('keyup', penKeys); if (e.key === ' ') spaceHeld = false; });
  /* ---------- Hold to snap (pencil and lasso) ----------
     Draw a shape roughly and hold still: after the hold time it becomes the line, circle, rectangle, triangle or
     polygon it looks like. Keep holding and move to resize it about its middle; let go to keep it. */
  const pcl = (() => { try { return { lazy: 20, smooth: 4, close: true, mode: 'own', hold: true, ms: 420, ...JSON.parse(Settings.get('dz_pencil', '{}')) }; } catch { return { lazy: 20, smooth: 4, close: true, mode: 'own', hold: true, ms: 420 }; } })();
  const savePcl = () => Settings.set('dz_pencil', JSON.stringify(pcl));
  const holdWatch = (st, p, fire) => {
    if (!pcl.hold || st.snap) return;
    if (st.hp && Math.hypot((p.x - st.hp.x) * k, (p.y - st.hp.y) * k) < 3) return;   // still enough: the timer keeps running
    st.hp = p; clearTimeout(st.ht); st.ht = setTimeout(fire, pcl.ms);
  };
  const holdStart = (g, p) => { const S = dzSample(g.subs, 24); let cx = 0, cy = 0; for (const q of S) { cx += q.x; cy += q.y; } cx /= S.length; cy /= S.length;
    return { g, base: JSON.parse(JSON.stringify(g.subs)), cx, cy, d0: Math.max(1, Math.hypot(p.x - cx, p.y - cy)), cur: S }; };
  const holdScale = (sn, p) => { const f = Math.max(0.05, Math.hypot(p.x - sn.cx, p.y - sn.cy) / sn.d0);
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
  function endPencil() { if (!pclOn) return; pclOn = false; if (stroke) clearTimeout(stroke.ht); stroke = null; drawPen(); }
  const pclDown = (e) => {
    if (Settings.get('dz_pen', 'any') === 'pen' && e.pointerType === 'touch') return;   // stylus only: fingers move the view
    e.dzHit = true; e.preventDefault(); page.setPointerCapture(e.pointerId);
    const p = toPage(e); stroke = { pts: [p], lp: p }; drawPen();
  };
  const pclMove = (e) => {
    const d = stroke, p = toPage(e);
    if (pinch) { clearTimeout(d.ht); stroke = null; return drawPen(); }
    if (d.snap) { holdScale(d.snap, p); return drawPen(); }
    const L = pcl.lazy * 0.6 / k, dx = p.x - d.lp.x, dy = p.y - d.lp.y, dist = Math.hypot(dx, dy);
    if (dist > L) { const t = (dist - L) / dist; d.lp = { x: d.lp.x + dx * t, y: d.lp.y + dy * t }; const last = d.pts.at(-1); if (Math.hypot(d.lp.x - last.x, d.lp.y - last.y) * k > 1.2) d.pts.push(d.lp); }
    d.cur = L ? p : null;
    holdWatch(d, p, () => { if (!stroke) return; const g = dzGuess(stroke.pts); if (!g) return; stroke.snap = holdStart(g, p); drawPen(); toast(g.label + ': keep holding and move to resize.', 2500); });
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
    <p class="muted" style="font-size:12px;margin:0 0 8px">Draw freehand. Hold still before lifting to snap to a line, circle, rectangle, triangle or polygon, then move to resize it.</p>
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
    const title = prompt('Name for the reference:', list.length === 1 ? layerName(list[0]) : name); if (title == null) return;
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
    if (!L.length) return;
    if (a === 'hide') { const v = !every(l => l.hide); L.forEach(l => l.hide = v); }
    if (a === 'lock') { const v = !every(l => l.lock); L.forEach(l => l.lock = v); }
    if (a === 'clip') { const v = !every(l => l.clip); L.forEach(l => { if (F().indexOf(l) > 0) l.clip = v || undefined; }); }
    if (a === 'del') { const gone = new Set(L.map(l => l.id)); doc.layers = doc.layers.filter(l => !gone.has(l.id)); picks = new Set(); toast(`Deleted ${L.length}. Undo brings ${L.length === 1 ? 'it' : 'them'} back.`); }
    if (a === 'dup') {   // copies go together above the highest one, keeping their order (and clipping)
      const top = Math.max(...L.map(l => doc.layers.indexOf(l))), cs = L.map(l => ({ ...JSON.parse(JSON.stringify(l)), id: dzId(), x: l.x + 30, y: l.y + 30, lock: undefined }));
      doc.layers.splice(top + 1, 0, ...cs); picks = new Set(cs.map(c => c.id));
    }
    changed(true); placeSel(); drawSide();
  };

  /* Adding things */
  const center = (w, h) => ({ x: (doc.w - w) / 2, y: (doc.h - h) / 2, w, h });
  const add = (l) => { doc.layers.push({ id: dzId(), op: 1, rot: 0, ...l, ...(doc.sides && face !== 'f' ? { side: face } : {}) }); sel = doc.layers.at(-1).id; changed(true); drawSide(); };
  const importPic = async (file, max = 2000) => {
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
      if (i > 0 && l.clip) { let b = i; while (b > 0 && L[b].clip) b--; if (L[b].hide || !over(L[b])) continue; }   // only where it shows
      return l;
    }
    return null;
  };
  // Guide lines at page positions (false = hidden).
  const guides = (gx, gy) => { const v = page.querySelector('.dz-guide.v'), hz = page.querySelector('.dz-guide.hz');
    v.hidden = gx === false; hz.hidden = gy === false; if (gx !== false) v.style.left = gx * k + 'px'; if (gy !== false) hz.style.top = gy * k + 'px'; };
  // Snapping while moving: the moved items' edges and centres line up with the page's edges and centre and with
  // every other item on the page (the master page's too). Hold Alt to move freely.
  const snapTo = (list, e) => {
    if (e.altKey || e.ctrlKey || !list.length) return guides(false, false);
    const ids = new Set(list.map(m => m.id)), bs = list.map(box);
    const B = { x0: Math.min(...bs.map(b => b.x0)), x1: Math.max(...bs.map(b => b.x1)), y0: Math.min(...bs.map(b => b.y0)), y1: Math.max(...bs.map(b => b.y1)) };
    const tx = [0, doc.w / 2, doc.w], ty = [0, doc.h / 2, doc.h];
    for (const o of dzPages(doc, face).flat()) if (!o.hide && !ids.has(o.id)) { const b = box(o); tx.push(b.x0, (b.x0 + b.x1) / 2, b.x1); ty.push(b.y0, (b.y0 + b.y1) / 2, b.y1); }
    const best = (cs, ts) => { let r = null; for (const c of cs) for (const t of ts) { const d = t - c; if (Math.abs(d) < 10 / k && (!r || Math.abs(d) < Math.abs(r.d))) r = { d, t }; } return r; };
    const sx = best([B.x0, (B.x0 + B.x1) / 2, B.x1], tx), sy = best([B.y0, (B.y0 + B.y1) / 2, B.y1], ty);
    for (const m of list) { if (sx) m.x += sx.d; if (sy) m.y += sy.d; }
    guides(sx ? sx.t : false, sy ? sy.t : false);
  };
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
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2 && busy() && e.pointerType === 'touch') { rest.add(e.pointerId); return; }   // a resting finger: a modifier, not a zoom
    if (pts.size === 2) {
      // A second finger: stop moving the item (put it back) and pinch the view instead.
      if (drag) { const l = layer(); if (l) Object.assign(l, drag.l0); drag = null; guides(false, false); redraw(); }
      bg = null; const [a, b] = [...pts.values()], r = stage.getBoundingClientRect();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, vx, vy };
    }
  }, true);
  stage.addEventListener('pointerdown', (e) => {
    if (pinch || e.dzHit || rest.has(e.pointerId) || e.target.closest('.dz-zoom, .dz-faces, .dz-mods, .dz-nmenu')) return;
    // Background (around the design, or an empty part of it): drag to pan, tap to deselect.
    bg = { x: e.clientX, y: e.clientY, vx, vy, moved: false }; stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()], r = stage.getBoundingClientRect(), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      vx = pinch.vx + mx - pinch.mx; vy = pinch.vy + my - pinch.my; z = pinch.z;   // two-finger pan from where it started
      fit(false); zoomTo(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, mx, my);
      return;
    }
    if (bg) { const dx = e.clientX - bg.x, dy = e.clientY - bg.y; if (Math.abs(dx) + Math.abs(dy) > 5) bg.moved = true;
      if (bg.moved) { vx = bg.vx + dx; vy = bg.vy + dy; fit(false); } }
  });
  const ptUp = (e) => {
    pts.delete(e.pointerId); if (rest.delete(e.pointerId)) return;
    if (pinch && pts.size < 2) { pinch = null; bg = null; return; }
    if (bg) { if (!bg.moved && (sel || (picks.size && !picking))) select(null); bg = null; }
  };
  stage.addEventListener('pointerup', ptUp); stage.addEventListener('pointercancel', ptUp);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect();
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
  $('#dz-panel').onclick = () => { document.body.classList.toggle('dz-noside'); requestAnimationFrame(() => { fit(); redraw(); }); };
  $('#dz-mods').onclick = (e) => { const m = e.target.closest('[data-mod]')?.dataset.mod; if (!m) return; dock[m] = !dock[m]; drawMods(); };
  $('#dz-faces').onclick = (e) => { const f = e.target.closest('[data-face]')?.dataset.face; if (f) setFace(f); };
  stage.querySelector('.dz-zoom').onclick = (e) => { const b = e.target.closest('[data-z]'); if (!b) return;
    if (b.dataset.z === 'fit') return frame(); zoomTo(z * (b.dataset.z === 'in' ? 1.4 : 1 / 1.4)); };
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
    if (!h || many()) {
      const hl = hit(p);
      if (hl && (e.ctrlKey || e.metaKey || e.shiftKey)) { e.dzHit = true; return togglePick(hl.id); }
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
    if (!l || l.lock) return;
    e.dzHit = true;   // an item was picked: the stage doesn't pan
    e.preventDefault(); page.setPointerCapture(e.pointerId);
    drag = { h: h || (cropping ? 'pan' : 'move'), p0: p, l0: { ...l, crop: l.crop ? { ...l.crop } : null } };
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
      const p = toPage(e), dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (!drag.moved && Math.hypot(dx, dy) * k < 6) return; drag.moved = true;
      for (const [id, o] of drag.l0) { const m = doc.layers.find(x => x.id === id); if (m) { m.x = o.x + dx; m.y = o.y + dy; } }
      snapTo(doc.layers.filter(m => drag.l0.has(m.id)), e);
      placeSel(); return redraw();
    }
    const l = layer(), p = toPage(e), o = drag.l0, a = (o.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    if (cropping && o.crop) {
      // Crop: edges cut away (the whole stays where it is); dragging inside slides the whole under the window.
      const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y, lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
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
      l.x = o.x + p.x - drag.p0.x; l.y = o.y + p.y - drag.p0.y;
      snapTo([l], e);
    } else if (drag.h === 'rot') {
      const cx = o.x + o.w / 2, cy = o.y + (o.h || 0) / 2;
      let deg = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90; deg = ((deg + 540) % 360) - 180;
      const near = Math.round(deg / 15) * 15; if (Math.abs(deg - near) < 4) deg = near;
      l.rot = Math.round(deg);
    } else {
      // Resize around the opposite corner/side, measured in the layer's own (rotated) frame.
      const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y, lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
      const sx = drag.h.includes('e') ? 1 : drag.h.includes('w') ? -1 : 0, sy = drag.h.includes('s') ? 1 : drag.h.includes('n') ? -1 : 0;
      let w = Math.max(20, o.w + sx * lx), hgt = Math.max(10, (o.h || 1) + sy * ly);
      if (sy) {   // corners keep the proportions; text scales its font with it
        const s = Math.max(w / o.w, hgt / (o.h || 1)); w = o.w * s; hgt = (o.h || 1) * s;
        if (o.t === 'text') l.size = Math.max(6, o.size * s);
        if (o.t !== 'text' && o.shape !== 'line' && dzKeep(o) === e.shiftKey) { w = Math.max(20, o.w + sx * lx); hgt = Math.max(10, (o.h || 1) + sy * ly); }
      } else hgt = o.h || 1;
      // Keep the opposite edge where it was.
      const ocx = o.x + o.w / 2, ocy = o.y + (o.h || 0) / 2;
      const ax = -sx * o.w / 2, ay = -sy * (o.h || 0) / 2, wx = ocx + ax * cos - ay * sin, wy = ocy + ax * sin + ay * cos;
      const nax = -sx * w / 2, nay = -sy * hgt / 2, ncx = wx - (nax * cos - nay * sin), ncy = wy - (nax * sin + nay * cos);
      l.w = w; if (o.t !== 'text') l.h = hgt;
      l.x = ncx - w / 2; l.y = ncy - (o.t === 'text' ? (o.h || 0) * (w / o.w) : hgt) / 2;
    }
    redraw();
  });
  const end = () => { cancelPress(); if (pen?.drag) { pen.drag = null; return drawPen(); } if (stroke) return pclUp(); if (cutDrag) return cutUp(); if (ndrag) return nodeUp(); if (cdrag) { cdrag = null; return; } if (!drag) return; const d = drag; drag = null; guides(false, false);
    if (d.h === 'group') { if (d.moved) changed(true); else if (d.tap) { picks.delete(d.tap); setPicks(picks); } return; }
    changed(true); drawSide(); };
  page.addEventListener('pointerup', end); page.addEventListener('pointercancel', end);
  addEventListener('keydown', function keys(e) {
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
    if (many()) {
      if (e.key === 'Escape') { picking = false; return setPicks([]); }
      if (e.key === 'Delete' || e.key === 'Backspace') return multiAct('del');
      const st = e.shiftKey ? 20 : 4, mv = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
      if (mv) { e.preventDefault(); for (const m of picked()) if (!m.lock) { m.x += mv[0]; m.y += mv[1]; } changed(); placeSel(); }
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
    if (e.key === 'Delete' || e.key === 'Backspace') { doc.layers = doc.layers.filter(x => x !== l); sel = null; changed(true); drawSide(); }
    const step = e.shiftKey ? 20 : 4, mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv && !l.lock) { e.preventDefault(); l.x += mv[0]; l.y += mv[1]; changed(); }
    if (e.key === 'Escape') { if (cropping) { endCrop(); return drawSide(); } select(null); }
  });

  /* Side panel events */
  side.addEventListener('click', async (e) => {
    const t = e.target, d = (kk) => t.closest(`[data-${kk}]`)?.dataset[kk], l = layer();
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
      if (t.closest('[data-llock]')) { ly.lock = !ly.lock; placeSel(); changed(true); return drawSide(); }
      if (t.closest('[data-ldel]')) { doc.layers = doc.layers.filter(x => x !== ly); if (sel === ly.id) sel = null; placeSel(); changed(true); return drawSide(); }
      if (e.shiftKey && !t.closest('button')) {   // a range in the list, from the last one picked
        const list = [...F()].reverse(), a = list.findIndex(x => x.id === (anchor || sel)), b = list.indexOf(ly);
        if (a < 0) return togglePick(ly.id);
        return setPicks(new Set([...picks, ...list.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.id)]));
      }
      if ((picking || e.ctrlKey || e.metaKey) && !t.closest('button')) return togglePick(ly.id);
      if (t.closest('[data-lname]') && sel === ly.id) {
        const n = prompt('Layer name:', layerName(ly)); if (n == null) return;
        ly.name = n.trim() || undefined; changed(true); return drawSide();
      }
      anchor = ly.id; return select(ly.id);
    }
    if (d('add')) {
      const a = d('add');
      if (a === 'text') return add({ t: 'text', text: 'Your text', size: Math.round(doc.h * 0.05), font: '@2', c: '@fg', al: 'center', lh: 1.2, ...center(doc.w * 0.6, doc.h * 0.06) });
      if (a === 'heading') return add({ t: 'text', text: 'Heading', size: Math.round(doc.h * 0.1), font: '@1', c: '@fg', al: 'center', lh: 1.1, ...center(doc.w * 0.7, doc.h * 0.11) });
      if (a === 'logo') { if (!Settings.get('studio_logo_ref')) toast('Add your logo in Settings › Profile; it shows here once added.', 5000); const s = Math.min(doc.w, doc.h) * 0.3; return add({ t: 'image', logo: true, ...center(s, s) }); }
      if (a === 'pen') return startPen();
      if (a === 'pencil') return startPencil();
      if (a === 'image') { panel = panel === 'image' ? null : 'image'; return drawSide(); }
      panel = panel === a ? null : a; return drawSide();
    }
    if (d('shape')) { const s = d('shape'), m = Math.min(doc.w, doc.h) * 0.3;
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
        if (back.length && !confirm(`Remove the back page and its ${back.length} item${back.length === 1 ? '' : 's'}?\n\nThe master page's items stay, under the front. Undo brings the back page back.`)) return;
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
      const im = await dzImg(ref), w = Math.min(doc.w, doc.h) * 0.5, h = im ? w * im.naturalHeight / im.naturalWidth : w;
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
      if (a === 'dup') { const c = { ...JSON.parse(JSON.stringify(l)), id: dzId(), x: l.x + 30, y: l.y + 30 }; doc.layers.splice(i + 1, 0, c); sel = c.id; }
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
  });
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
  side.addEventListener('input', (e) => {
    const t = e.target, l = layer(), key = t.dataset.k;
    if (t.dataset.dim && l) {
      const v = dzFromU(doc, +t.value); if (!(v > 0)) return;
      const cx = l.x + l.w / 2, cy = l.y + (l.h || 0) / 2, r = l.w / (l.h || 1), keep = dzKeep(l) && l.t !== 'text';
      if (t.dataset.dim === 'w') { l.w = v; if (keep) l.h = v / r; } else { l.h = v; if (keep) l.w = v * r; }
      l.x = cx - l.w / 2; if (l.t !== 'text') l.y = cy - l.h / 2;
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
  side.addEventListener('change', async (e) => {
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
  });

  /* Top bar */
  $('#dz-back').onclick = async () => { await flush(); location.hash = 'designs'; };
  $('#dz-tpl').onclick = async () => {
    const n = prompt('Name for this template:', name); if (!n?.trim()) return;
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
  $('#dz-export').onclick = () => { select(null); dzExport(doc, name); };
  new ResizeObserver(() => { fit(); redraw(); }).observe(stage);
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
  const n = prompt('Type the name of a font installed on this device (exactly as it appears in your other apps).\n\nOn phones and tablets, "Import a font file" works more reliably.');
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
        <button data-ex="png"><b>Save picture</b><small>PNG, for printing elsewhere or posting</small></button>
        <button data-ex="share"><b>Share</b><small>Send it in WhatsApp or another app</small></button>
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
      try { if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: name }); else { const l = document.createElement('a'); l.href = URL.createObjectURL(f); l.download = f.name; l.click(); } }
      catch (err) { if (err.name !== 'AbortError') toast('Could not share: ' + err.message); }
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
  $('#bt-share').onclick = async () => { const f = await result();
    try { if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: f.name }); else { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); } }
    catch (err) { if (err.name !== 'AbortError') toast('Could not share: ' + err.message); } };
  $('#bt-st').onclick = async () => {
    toast('Opening in the stencil maker…'); await new Promise(r => setTimeout(r, 30));
    const b = btWarp(BT.src, BT.deg, 2400), w = document.createElement('canvas'); w.width = b.width; w.height = b.height;
    const x = w.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w.width, w.height); x.drawImage(b, 0, 0);
    await stLoad(await new Promise(r => w.toBlob(r, 'image/png'))); location.hash = 'stencil';
  };
  new ResizeObserver(show).observe(stage);
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
            <div class="unit-in"><input class="in" id="sp-w" type="number" inputmode="decimal" min="5" max="300" step="0.5" value="${+SP.wcm.toFixed(1)}"><em>cm</em></div></label>
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
          Drag the dashed cut lines to move a cut, for example away from a face or fine detail. <button class="link" id="sp-even">Space evenly</button></p>
        <div class="row" style="gap:6px"><button class="btn" id="sp-save">Save pieces</button><button class="btn primary" id="sp-print" style="flex:1">Print ${pages} page${pages > 1 ? 's' : ''}</button></div>
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
      if (t.closest('#sp-save')) return spSave();
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
    const done = () => { document.body.classList.remove('printing'); pa.innerHTML = ''; removeEventListener('afterprint', done); };
    addEventListener('afterprint', done);
    window.print();
  };
  const spSave = async () => {
    const files = [];
    for (const p of spPieces()) { const cv = pieceCanvas(p); files.push(new File([await new Promise(r => cv.toBlob(r, 'image/png'))], `${SP.name}-${p.label}.png`, { type: 'image/png' })); }
    try {
      if (navigator.canShare?.({ files })) return await navigator.share({ files, title: SP.name });
      for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); await new Promise(r => setTimeout(r, 250)); }
      toast(`Saved ${files.length} pieces.`);
    } catch (err) { if (err.name !== 'AbortError') toast('Could not save: ' + err.message); }
  };
  draw();
  new ResizeObserver(() => { if ($('#sp-stage')) lay(); }).observe($('#sp-stage'));
};
