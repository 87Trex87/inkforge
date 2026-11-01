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
/* Folded pamphlets: one landscape sheet, both sides. The design holds the outside on top and the inside
   below it; export splits them into two pages. Panel names follow how the sheet folds: on a trifold the
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
  const dpi = [300, 250, 200, 150, 100].find(d => (wmm * d / 25.4) * (2 * hmm * d / 25.4) <= 16e6) || 72;
  const W = Math.round(wmm * dpi / 25.4), H = Math.round(hmm * dpi / 25.4), mm = dpi / 25.4, n = type === 'bi' ? 2 : type === 'quad' || type === 'gate' ? 4 : 3;
  let out, inn, lo, li;
  if (type === 'tri') { const f = W / 3 - 1.5 * mm, o2 = (W - f) / 2; out = [f, f + o2]; inn = [o2, 2 * o2];
    lo = ['Inside flap', 'Back', 'Front cover']; li = ['Inside left', 'Inside middle', 'Inside right (folds in)']; }
  else if (type === 'bi') { out = inn = [W / 2]; lo = ['Back', 'Front cover']; li = ['Inside left', 'Inside right']; }
  else if (type === 'gate') { out = inn = [W / 4, W * 3 / 4]; lo = ['Cover, right half', 'Back', 'Cover, left half']; li = ['Left flap', 'Inside middle', 'Right flap']; }
  else { out = inn = [...Array(n - 1)].map((_, i) => W * (i + 1) / n); lo = [...Array(n)].map((_, i) => 'Outside ' + (i + 1)); li = [...Array(n)].map((_, i) => 'Inside ' + (i + 1)); }
  const r = (a) => a.map(Math.round), name = DZ_FOLD_TYPES[type].name;
  return { w: W, h: 2 * H, dpi, label: name, mm: [wmm, hmm], sheet: p[0],
    fold: { type, side: H, out: r(out), inn: r(inn), lo, li } };
}
// Keep proportions: pictures and the logo by default, shapes not; text sizes with its letters.
const dzKeep = (l) => l.t === 'text' || (l.keep ?? l.t !== 'shape');

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
      x.fillStyle = dzCol(doc, l.c) || '#000'; x.textBaseline = 'alphabetic';
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
        else if (L.shape === 'star') dzStar(x, 0, 0, Math.min(L.w, L.h) / 2);
        else if (L.shape === 'line') { x.moveTo(-L.w / 2, 0); x.lineTo(L.w / 2, 0); }
        else x.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, Math.min(L.r || 0, L.w / 2, L.h / 2));
        if (L.shape === 'line') { x.strokeStyle = st || f || '#000'; x.lineWidth = Math.max(1, sw || L.h); x.lineCap = 'round'; x.stroke(); }
        else { if (f) { x.fillStyle = f; x.fill(); } if (st && sw) { x.strokeStyle = st; x.lineWidth = sw; x.stroke(); } }
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
  // so a texture laid over a shape takes the shape's form. The bottom layer can't be clipped.
  const L = doc.layers, show = (l) => !l.hide && (!opts.only || opts.only.has(l.id));
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
// A finished copy of the design as its own canvas (full size unless `scale`).
async function dzCanvas(doc, scale = 1) {
  const cv = document.createElement('canvas'); cv.width = Math.round(doc.w * scale); cv.height = Math.round(doc.h * scale);
  await dzDraw(cv, doc, scale); return cv;
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
function dzNew(kind, opt, theme, piece, size) {
  const k = DZ_KINDS[kind], code = Math.random().toString(36).slice(2, 8).toUpperCase(), exp = new Date(); exp.setFullYear(exp.getFullYear() + 1);
  let doc;
  if (opt?.custom) { doc = JSON.parse(JSON.stringify(opt.custom.doc)); doc.layers.forEach(l => l.id = dzId()); doc.theme = theme || doc.theme; }
  else doc = { v: 1, kind, w: k.w, h: k.h, theme, bg: { c: '@bg' }, layers: opt?.make ? opt.make(k.w, k.h) : [] };
  doc.kind = kind; doc.w = k.w; doc.h = k.h;
  delete doc.dpi; delete doc.paper; delete doc.fold;
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
    ps: Settings.get('dz_paper', 'A4'), land: false, cw: 200, ch: 200, cu: 'mm', ft: 'tri', fs: Settings.get('dz_fold_sheet', 'A4') };
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
      <div class="lbl">Layout</div><div class="dz-tpls">${lays.map((l, i) =>
        `<button data-li="${i}" class="${st.li === i ? 'on' : ''}"><canvas data-prev="${i}"></canvas><span>${esc(l.name)}${l.custom ? ' <em>yours</em>' : ''}</span>
          ${l.custom ? `<i class="dz-tdel" data-tdel="${esc(l.custom.id)}" title="Delete this template">&times;</i>` : ''}</button>`).join('')}</div>
      <div class="lbl" style="margin-top:12px">Theme</div><div class="dz-themes">${Object.entries(DZ_THEMES).map(([k, t]) =>
        `<button data-theme="${k}" class="${st.theme === k ? 'on' : ''}"><i style="background:${t.bg}"></i><i style="background:${t.accent}"></i><i style="background:${t.fg}"></i><span>${t.name}</span></button>`).join('')}</div>
      <div class="row" style="margin-top:14px"><button class="btn" data-back>Back</button><button class="btn primary" data-go style="flex:1">Create</button></div></div>`;
    for (const cv of o.querySelectorAll('canvas[data-prev]')) {
      const doc = dzNew(st.kind, lays[+cv.dataset.prev], st.theme, st.piece, sz), sc = 220 / Math.max(doc.w, doc.h);
      cv.width = Math.round(doc.w * sc); cv.height = Math.round(doc.h * sc); dzDraw(cv, doc, sc);
    }
  };
  o.onclick = async (e) => {
    const t = e.target, d = (k) => t.closest(`[data-${k}]`)?.dataset[k];
    if (t.closest('[data-x]')) return o.remove();
    if (d('kind')) { st.kind = d('kind'); st.li = 0; return draw(); }
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
      const doc = dzNew(st.kind, dzLayouts(st.kind)[st.li], st.theme, st.piece, sz);
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
      <button class="btn icon-btn" id="dz-tpl" aria-label="Save as template" data-tip="Save as template, to start new designs from it"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg></button>
      <button class="btn primary" id="dz-export">Export</button>
    </div>
    <div class="dz-body">
      <div class="dz-stage" id="dz-stage"><div class="dz-page" id="dz-page"><canvas id="dz-cv"></canvas><div id="dz-folds"></div><div id="dz-multi"></div><div id="dz-sel" hidden>
        <i class="h nw" data-h="nw"></i><i class="h ne" data-h="ne"></i><i class="h sw" data-h="sw"></i><i class="h se" data-h="se"></i>
        <i class="h e" data-h="e"></i><i class="h w" data-h="w"></i><i class="h n" data-h="n"></i><i class="h s" data-h="s"></i><i class="h rot" data-h="rot"></i></div>
        <i class="dz-guide v" hidden></i><i class="dz-guide hz" hidden></i></div>
        <div class="dz-zoom"><button data-z="out" aria-label="Zoom out">−</button><button data-z="fit" id="dz-zl" data-tip="Show the whole design">Fit</button><button data-z="in" aria-label="Zoom in">+</button></div></div>
      <div class="dz-side" id="dz-side"></div>
    </div></div>`;
  const cv = $('#dz-cv'), page = $('#dz-page'), stage = $('#dz-stage'), selBox = $('#dz-sel'), side = $('#dz-side');
  let k = 1;   // screen px per page px
  const layer = () => doc.layers.find(l => l.id === sel);
  /* Several selected: `picks` holds them (sel is then null). Selection mode (`picking`, from a long press or
     the Select button) makes taps add and remove items, for touchscreens; on a computer Ctrl/Shift-click. */
  let picks = new Set(), picking = false, anchor = null;
  const many = () => picking || picks.size > 1;
  const picked = () => doc.layers.filter(l => picks.has(l.id));

  // Canvas size: fit the page into the stage; drawn at device resolution for crisp text.
  /* View: zoom (z, 1 = the whole design fits) and pan (vx, vy, screen px from centred). */
  let fitK = 1, z = 1, vx = 0, vy = 0, rs = 1, crispT = null;
  const fit = (crisp = true) => {
    // On phones the stage hugs the design's shape, so a wide card doesn't leave empty space above and below.
    if (innerWidth < 900) { const sw = stage.clientWidth; stage.style.height = Math.round(Math.min(innerHeight * 0.58, (sw - 32) * doc.h / doc.w + 32)) + 'px'; }
    else stage.style.height = '';
    const r = stage.getBoundingClientRect(), pad = 16;
    fitK = Math.min((r.width - pad * 2) / doc.w, (Math.max(260, r.height) - pad * 2) / doc.h); k = fitK * z;
    const w = doc.w * k, h = doc.h * k;
    // Keep some of the design on screen however far it's dragged.
    const mx = Math.max(0, (r.width + w) / 2 - 80), my = Math.max(0, (r.height + h) / 2 - 80);
    vx = Math.max(-mx, Math.min(mx, vx)); vy = Math.max(-my, Math.min(my, vy));
    Object.assign(page.style, { width: w + 'px', height: h + 'px', left: (r.width - w) / 2 + vx + 'px', top: (r.height - h) / 2 + vy + 'px' });
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    // The drawing itself: device resolution, capped so a big zoom doesn't make a huge canvas.
    if (crisp) { rs = Math.min(k * Math.min(2, devicePixelRatio || 1), 4096 / Math.max(doc.w, doc.h)); cv.width = Math.round(doc.w * rs); cv.height = Math.round(doc.h * rs); }
    const zl = $('#dz-zl'); if (zl) zl.textContent = Math.abs(z - 1) < 0.01 && !vx && !vy ? 'Fit' : Math.round(z * 100) + '%';
    drawFolds(); placeSel();
  };
  // Zoom around a point on the stage (the spot under the fingers or cursor stays put). While zooming the
  // drawing is stretched; it's redrawn sharp a moment after zooming stops.
  // Folded pamphlets: fold lines, panel names and where the outside ends (only on screen, never exported).
  const drawFolds = () => {
    const f = doc.fold, box = $('#dz-folds'); if (!box) return; box.innerHTML = '';
    if (!f) return;
    box.innerHTML = [0, 1].map(sd => { const y = sd * f.side, fl = sd ? f.inn : f.out, nm = sd ? f.li : f.lo, ed = [0, ...fl, doc.w];
      return fl.map(x => `<i class="dz-fl" style="left:${x * k}px;top:${y * k}px;height:${f.side * k}px"></i>`).join('')
        + nm.map((n, i) => `<span class="dz-pl" style="left:${ed[i] * k}px;width:${(ed[i + 1] - ed[i]) * k}px;top:${y * k}px">${esc(n)}</span>`).join('')
        + `<b class="dz-stag" style="top:${(y + f.side) * k}px">${sd ? 'Inside' : 'Outside'}</b>`; }).join('')
      + `<i class="dz-fsep" style="top:${f.side * k}px"></i>`;
  };
  const zoomTo = (nz, sx, sy) => {
    const r = stage.getBoundingClientRect();
    if (sx == null) { sx = r.width / 2; sy = r.height / 2; }
    const left = (r.width - doc.w * k) / 2 + vx, top = (r.height - doc.h * k) / 2 + vy, dx = (sx - left) / k, dy = (sy - top) / k;
    z = Math.max(0.5, Math.min(8, nz)); const nk = fitK * z;
    vx = sx - dx * nk - (r.width - doc.w * nk) / 2; vy = sy - dy * nk - (r.height - doc.h * nk) / 2;
    fit(false); clearTimeout(crispT); crispT = setTimeout(() => { fit(true); redraw(); }, 160);
  };
  const frame = () => { z = 1; vx = vy = 0; fit(); redraw(); };
  let drawing = null;
  let cropping = false;   // crop mode for the selected picture or shape
  const redraw = async () => { const job = (drawing = Symbol()); await dzDraw(cv, doc, rs, { ghost: cropping ? sel : null }); if (job === drawing) placeSel(); };
  // Leaving crop mode: an uncropped item drops its crop entirely.
  const endCrop = () => { if (!cropping) return; cropping = false; const l = layer();
    if (l?.crop && l.crop.w >= 0.999 && l.crop.h >= 0.999) delete l.crop; selBox.classList.remove('cropping'); changed(true); };
  const placeSel = () => {
    if (!selBox) return;
    const mo = $('#dz-multi');
    if (mo) mo.innerHTML = picked().map(m => `<i class="dz-mo ${m.lock ? 'locked' : ''}" style="left:${m.x * k}px;top:${m.y * k}px;width:${m.w * k}px;height:${(m.h || 1) * k}px;transform:rotate(${m.rot || 0}deg)"></i>`).join('');
    stage.classList.toggle('picking', picking);
    const l = layer();
    selBox.hidden = !l;
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
    const refs = [...new Set([doc.bg?.img, ...doc.layers.filter(l => l.t === 'image' && l.ref).map(l => l.ref)].filter(Boolean))];
    const before = (await DB.all('SELECT ref FROM design_assets WHERE design_id = ?', [id])).map(x => x.ref);
    await DB.tx([{ sql: `UPDATE designs SET name = ?, doc = ?, thumb_ref = ?, updated_at = datetime('now') WHERE id = ?`, params: [name, JSON.stringify(doc), ref, id] },
      { sql: 'DELETE FROM design_assets WHERE design_id = ?', params: [id] },
      ...refs.map(r => ({ sql: 'INSERT INTO design_assets (design_id, ref) VALUES (?, ?)', params: [id, r] }))]);
    if (old && old !== ref) await Media.release(old);
    for (const r of before) if (!refs.includes(r)) dropped.add(r);
    if ($('#dz-list')) DZ.list();
  })()); };
  const dropped = new Set(), made = new Set();   // pictures taken out (or made) while editing; tidied when leaving
  const docRefs = () => [doc.bg?.img, ...doc.layers.map(l => l.ref)].filter(Boolean);
  addEventListener('hashchange', function away() { removeEventListener('hashchange', away);
    flush().then(async () => { const keep = docRefs(); for (const r of new Set([...dropped, ...made])) if (!keep.includes(r)) await Media.release(r); }); });
  // A change: redraw, remember for undo, save.
  let histT = null;
  const changed = (now) => {
    redraw(); save();
    clearTimeout(histT);
    const push = () => { const s = JSON.stringify(doc); if (s !== hist[hi]) { hist.splice(hi + 1); hist.push(s); if (hist.length > 60) hist.shift(); hi = hist.length - 1; } };
    if (now) push(); else histT = setTimeout(push, 450);
  };
  const undo = (d) => { const n = hi + d; if (n < 0 || n >= hist.length) return; hi = n; doc = JSON.parse(hist[hi]); doc.vals ||= {}; if (!layer()) sel = null;
    picks = new Set(picked().map(l => l.id)); redraw(); save(); drawSide(); };

  /* Side panel: nothing selected = add things, background, details; a layer selected = its settings. */
  const swatches = (key, cur, allowNone) => {
    const roles = [['@fg', 'Text'], ['@accent', 'Accent'], ['@bg', 'Background'], ['@soft', 'Soft']];
    return `<div class="dz-sw" data-swk="${key}">${allowNone ? `<button data-c="none" class="none ${cur === 'none' || !cur ? 'on' : ''}" title="None">∅</button>` : ''}
      ${roles.map(([c, n]) => `<button data-c="${c}" class="role ${cur === c ? 'on' : ''}" title="Theme ${n}" style="background:${dzCol(doc, c)}"></button>`).join('')}
      <span class="sep"></span>${DZ_PALETTE.map(c => `<button data-c="${c}" class="${cur === c ? 'on' : ''}" style="background:${c}"></button>`).join('')}
      <label class="pick" title="Any colour"><input type="color" data-cpick="${key}" value="${/^#/.test(cur || '') ? cur : '#888888'}">+</label></div>`;
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
    : ({ ellipse: 'Circle', line: 'Line', star: 'Star' }[l.shape] || ((!l.fill || l.fill === 'none') && l.sw ? 'Frame' : 'Shape')));
  const layerIco = (l) => l.t === 'text' ? 'T' : l.t === 'image' ? (l.logo ? '◎' : '▣') : '◆';
  const drawLayers = () => {
    side.innerHTML = `<div class="dz-lbar"><button class="btn small ${picking ? 'primary' : ''}" data-mact="${picking ? 'done' : 'pick'}">${picking ? 'Done selecting' : 'Select…'}</button>
        ${picking || picks.size ? `<button class="btn small" data-mact="all">All</button><button class="btn small" data-mact="none" ${picks.size ? '' : 'disabled'}>None</button>` : ''}</div>
      <div class="dz-ll" id="dz-ll">${[...doc.layers].reverse().map(l => { const i = doc.layers.indexOf(l), cl = i > 0 && l.clip;
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
    side.insertAdjacentHTML('afterbegin', `<div class="seg dz-tabs"><button data-tab="edit" class="${tab === 'edit' ? 'on' : ''}">${layer() || many() ? 'Selected' : 'Design'}</button>
      <button data-tab="layers" class="${tab === 'layers' ? 'on' : ''}">Layers <small>${doc.layers.length}</small></button></div>`);
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
      ${fsec('Combine and save', `<div class="dz-combine">
        <button class="btn small" data-mact="merge" ${n ? '' : 'disabled'}>Merge into one picture</button>
        <button class="btn small" data-mact="refs" ${n ? '' : 'disabled'}>Save to references</button>
        <button class="btn small" data-mact="png" ${n ? '' : 'disabled'}>Save as PNG</button></div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">Merging turns the selection into a single picture layer on the design (Undo brings the layers back).
          Saving makes a see-through picture of just the selection and leaves the design as it is. Clipped layers go with the layer they're clipped to.</p>`)}`;
  };
  const drawEdit = () => {
    if (many()) return drawMulti();
    const l = layer();
    if (!l) {
      const kinds = doc.kind === 'voucher' || doc.layers.some(x => /\{(amount|to|from|code|expires)\}/.test(x.text || ''));
      const post = DZ_KINDS[doc.kind].social || doc.layers.some(x => x.slot != null || DZ_PIECE_FIELDS.test(x.text || ''));
      side.innerHTML = `
        <div class="dz-add">${[['text', 'Text', 'T'], ['heading', 'Heading', 'H'], ['image', 'Picture', '▣'], ['logo', 'Logo', '◎'], ['shape', 'Shape', '◆'], ['field', 'Studio info', '@']]
          .map(([a, n, i]) => `<button data-add="${a}"><i>${i}</i><span>${n}</span></button>`).join('')}</div>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden id="dz-file">
        ${panel === 'image' ? `<div class="dz-shapes"><button data-pic="device">From this device</button><button data-pic="pf">From portfolio</button><button data-pic="refs">From references</button></div>` : ''}
        ${panel === 'shape' ? `<div class="dz-shapes">${[['rect', 'Square'], ['round', 'Rounded'], ['ellipse', 'Circle'], ['line', 'Line'], ['star', 'Star'], ['frame', 'Frame']]
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
        <button data-act="clip" class="${clipped(l) ? 'on' : ''}" ${doc.layers.indexOf(l) ? '' : 'disabled'} title="Clip to the layer below: only shows inside it">↳<span>Clip</span></button>
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
        ${swatches('c', l.c)}
        ${fsec('Spacing', slider('ls', 'Letter spacing', -5, 40, 1, l.ls || 0) + slider('lh', 'Line height', 0.8, 2.5, 0.05, l.lh || 1.2), { fold: true })}`
      : l.t === 'shape' ? `
        <div class="lbl">Fill</div>${swatches('fill', l.fill, true)}
        <div class="lbl" style="margin-top:8px">Outline</div>${swatches('stroke', l.stroke, true)}
        ${slider('sw', 'Outline width', 0, 40, 1, l.sw || 0)}
        ${l.shape === 'rect' || !l.shape ? slider('r', 'Corner rounding', 0, Math.round(Math.min(l.w, l.h) / 2), 1, l.r || 0) : ''}`
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
  const select = (idv) => { if (idv !== sel) endCrop(); sel = idv; panel = null; picks = new Set(); picking = false; placeSel(); drawSide(); };
  // Several: outside selection mode one item left becomes a normal selection.
  const setPicks = (ids) => {
    endCrop(); picks = new Set(ids); panel = null;
    if (!picking && picks.size <= 1) { sel = [...picks][0] || null; picks = new Set(); } else sel = null;
    placeSel(); drawSide();
  };
  const togglePick = (id) => { const s = new Set(picks); if (sel && !s.size) s.add(sel); s.has(id) ? s.delete(id) : s.add(id); anchor = id; setPicks(s); };
  const startPicking = (id) => { const s = new Set(picks); if (sel) s.add(sel); if (id) s.add(id); picking = true; anchor = id || anchor; setPicks(s); navigator.vibrate?.(30); };
  const clipped = (l) => doc.layers.indexOf(l) > 0 && !!l.clip;
  // Whole clip groups: a base with the layers clipped to it travel together, in layer order.
  const groupOf = (ids) => {
    const L = doc.layers, out = new Set(ids);
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
    const d = JSON.parse(JSON.stringify({ ...doc, layers: vis })); d.w = bw; d.h = bh;
    for (const l of d.layers) { l.x -= bx; l.y -= by; }
    const sc = Math.min(1, max / Math.max(bw, bh)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bw * sc)); c.height = Math.max(1, Math.round(bh * sc));
    await dzDraw(c, d, sc, { noBg: true });
    return { cv: c, bx, by, bw, bh };
  };
  const pngOf = (c) => new Promise(r => c.toBlob(r, 'image/png'));
  const targets = () => many() ? [...picks] : sel ? [sel] : [];
  const merge = async (ids) => {
    const list = groupOf(ids).filter(l => !l.hide);
    if (!list.length) return toast('Nothing visible to merge.');
    if (list.some(l => l.lock)) return toast('Unlock the selected layers first.');
    const txt = list.some(l => l.t === 'text');
    if (!confirm(`Merge ${list.length === 1 ? 'this layer' : list.length + ' layers'} into one picture?${txt ? '\n\nText becomes part of the picture and can no longer be edited.' : ''}\n\nUndo brings the layers back.`)) return;
    const f = await flatten(list); if (!f) return;
    const ref = await Media.save(await pngOf(f.cv), 'png'); made.add(ref);
    const gone = new Set(list.map(l => l.id)), top = Math.max(...list.map(l => doc.layers.indexOf(l)));
    const m = { id: dzId(), t: 'image', ref, x: f.bx, y: f.by, w: f.bw, h: f.bh, op: 1, rot: 0, name: list.length > 1 ? 'Merged' : layerName(list[0]) };
    const out = []; doc.layers.forEach((l, i) => { if (!gone.has(l.id)) out.push(l); if (i === top) out.push(m); });
    doc.layers = out; picking = false; picks = new Set(); sel = m.id; changed(true); drawSide();
    toast('Merged into one picture.');
  };
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
    if (a === 'all') { if (!picking && !many()) picking = true; return setPicks(doc.layers.filter(l => !l.hide).map(l => l.id)); }
    if (a === 'none') return setPicks([]);
    if (a === 'merge') return merge(targets());
    if (a === 'refs') return saveRef(targets());
    if (a === 'png') return savePng(targets());
    if (!L.length) return;
    if (a === 'hide') { const v = !every(l => l.hide); L.forEach(l => l.hide = v); }
    if (a === 'lock') { const v = !every(l => l.lock); L.forEach(l => l.lock = v); }
    if (a === 'clip') { const v = !every(l => l.clip); L.forEach(l => { if (doc.layers.indexOf(l) > 0) l.clip = v || undefined; }); }
    if (a === 'del') { const gone = new Set(L.map(l => l.id)); doc.layers = doc.layers.filter(l => !gone.has(l.id)); picks = new Set(); toast(`Deleted ${L.length}. Undo brings ${L.length === 1 ? 'it' : 'them'} back.`); }
    if (a === 'dup') {   // copies go together above the highest one, keeping their order (and clipping)
      const top = Math.max(...L.map(l => doc.layers.indexOf(l))), cs = L.map(l => ({ ...JSON.parse(JSON.stringify(l)), id: dzId(), x: l.x + 30, y: l.y + 30, lock: undefined }));
      doc.layers.splice(top + 1, 0, ...cs); picks = new Set(cs.map(c => c.id));
    }
    changed(true); placeSel(); drawSide();
  };

  /* Adding things */
  const center = (w, h) => ({ x: (doc.w - w) / 2, y: (doc.h - h) / 2, w, h });
  const add = (l) => { doc.layers.push({ id: dzId(), op: 1, rot: 0, ...l }); sel = doc.layers.at(-1).id; changed(true); drawSide(); };
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
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i]; if (l.hide || !over(l)) continue;
      if (i > 0 && l.clip) { let b = i; while (b > 0 && doc.layers[b].clip) b--; if (doc.layers[b].hide || !over(doc.layers[b])) continue; }   // only where it shows
      return l;
    }
    return null;
  };
  const guides = (gx, gy) => { page.querySelector('.dz-guide.v').hidden = !gx; page.querySelector('.dz-guide.hz').hidden = !gy; };
  let drag = null;
  const pts = new Map(); let pinch = null, bg = null;
  stage.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      // A second finger: stop moving the item (put it back) and pinch the view instead.
      if (drag) { const l = layer(); if (l) Object.assign(l, drag.l0); drag = null; guides(false, false); redraw(); }
      bg = null; const [a, b] = [...pts.values()], r = stage.getBoundingClientRect();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, vx, vy };
    }
  }, true);
  stage.addEventListener('pointerdown', (e) => {
    if (pinch || e.dzHit || e.target.closest('.dz-zoom')) return;
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
    pts.delete(e.pointerId);
    if (pinch && pts.size < 2) { pinch = null; bg = null; return; }
    if (bg) { if (!bg.moved && (sel || (picks.size && !picking))) select(null); bg = null; }
  };
  stage.addEventListener('pointerup', ptUp); stage.addEventListener('pointercancel', ptUp);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect();
    zoomTo(z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  stage.querySelector('.dz-zoom').onclick = (e) => { const b = e.target.closest('[data-z]'); if (!b) return;
    if (b.dataset.z === 'fit') return frame(); zoomTo(z * (b.dataset.z === 'in' ? 1.4 : 1 / 1.4)); };
  let press = null;   // long press: hold still on an item to start selecting several
  const cancelPress = () => { if (press) clearTimeout(press.t); press = null; };
  page.addEventListener('pointerdown', (e) => {
    cancelPress();
    if (pinch || pts.size > 1) return;
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
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancelPress();
    if (!drag || pinch) return;
    if (drag.h === 'group') {
      const p = toPage(e), dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (!drag.moved && Math.hypot(dx, dy) * k < 6) return; drag.moved = true;
      for (const [id, o] of drag.l0) { const m = doc.layers.find(x => x.id === id); if (m) { m.x = o.x + dx; m.y = o.y + dy; } }
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
      const cx = l.x + l.w / 2, cy = l.y + (l.h || 0) / 2, snap = 12 / k;
      const gx = Math.abs(cx - doc.w / 2) < snap, gy = Math.abs(cy - doc.h / 2) < snap;
      if (gx) l.x = doc.w / 2 - l.w / 2; if (gy) l.y = doc.h / 2 - (l.h || 0) / 2; guides(gx, gy);
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
  const end = () => { cancelPress(); if (!drag) return; const d = drag; drag = null; guides(false, false);
    if (d.h === 'group') { if (d.moved) changed(true); else if (d.tap) { picks.delete(d.tap); setPicks(picks); } return; }
    changed(true); drawSide(); };
  page.addEventListener('pointerup', end); page.addEventListener('pointercancel', end);
  addEventListener('keydown', function keys(e) {
    if (!document.body.contains(el)) return removeEventListener('keydown', keys);
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); return undo(e.shiftKey ? 1 : -1); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); return setPicks(doc.layers.filter(l => !l.hide).map(l => l.id)); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); if (targets().length) merge(targets()); return; }
    if (many()) {
      if (e.key === 'Escape') { picking = false; return setPicks([]); }
      if (e.key === 'Delete' || e.key === 'Backspace') return multiAct('del');
      const st = e.shiftKey ? 20 : 4, mv = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
      if (mv) { e.preventDefault(); for (const m of picked()) if (!m.lock) { m.x += mv[0]; m.y += mv[1]; } changed(); placeSel(); }
      return;
    }
    const l = layer(); if (!l) return;
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
    if (d('align')) return align(d('align'));
    const row = t.closest('[data-lid]');
    if (row && !t.closest('[data-grip]')) {
      const ly = doc.layers.find(x => x.id === row.dataset.lid); if (!ly) return;
      if (rowHeld) { rowHeld = false; return; }   // the long press already picked it
      if (t.closest('[data-lclip]')) { if (doc.layers.indexOf(ly) > 0) ly.clip = !ly.clip || undefined; changed(true); return drawSide(); }
      if (t.closest('[data-lhide]')) { ly.hide = !ly.hide; if (ly.hide && sel === ly.id) sel = null; placeSel(); changed(true); return drawSide(); }
      if (t.closest('[data-llock]')) { ly.lock = !ly.lock; placeSel(); changed(true); return drawSide(); }
      if (t.closest('[data-ldel]')) { doc.layers = doc.layers.filter(x => x !== ly); if (sel === ly.id) sel = null; placeSel(); changed(true); return drawSide(); }
      if (e.shiftKey && !t.closest('button')) {   // a range in the list, from the last one picked
        const list = [...doc.layers].reverse(), a = list.findIndex(x => x.id === (anchor || sel)), b = list.indexOf(ly);
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
      if (a === 'image') { panel = panel === 'image' ? null : 'image'; return drawSide(); }
      panel = panel === a ? null : a; return drawSide();
    }
    if (d('shape')) { const s = d('shape'), m = Math.min(doc.w, doc.h) * 0.3;
      return add({ t: 'shape', shape: s === 'round' || s === 'frame' ? 'rect' : s, r: s === 'round' ? m * 0.15 : s === 'frame' ? 12 : 0,
        fill: s === 'frame' || s === 'line' ? 'none' : '@accent', stroke: s === 'frame' || s === 'line' ? '@accent' : 'none', sw: s === 'frame' ? 6 : s === 'line' ? 6 : 0,
        ...center(s === 'line' ? doc.w * 0.5 : m, s === 'line' ? 6 : m) }); }
    if (d('field')) { const f = d('field');
      return add({ t: 'text', text: `{${f}}`, size: Math.round(doc.h * 0.05), font: '@2', c: '@fg', al: 'center', lh: 1.2, ...center(doc.w * 0.6, doc.h * 0.06) }); }
    if (d('theme')) { doc.theme = d('theme'); await DZF.all(doc); changed(true); return drawSide(); }
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
      if (key === 'bg') doc.bg.c = c === 'none' ? '@bg' : c; else if (l) l[key] = c;
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
      if (a === 'flatten') return merge([l.id]);
      if (a === 'clip') { if (i > 0) l.clip = !l.clip || undefined; }
      if (a === 'del') { doc.layers.splice(i, 1); sel = null; }
      if (a === 'dup') { const c = { ...JSON.parse(JSON.stringify(l)), id: dzId(), x: l.x + 30, y: l.y + 30 }; doc.layers.splice(i + 1, 0, c); sel = c.id; }
      if (a === 'up' && i < doc.layers.length - 1) [doc.layers[i], doc.layers[i + 1]] = [doc.layers[i + 1], doc.layers[i]];
      if (a === 'down' && i > 0) [doc.layers[i], doc.layers[i - 1]] = [doc.layers[i - 1], doc.layers[i]];
      if (a === 'lock') l.lock = !l.lock;
      if (a === 'fx') l.fx = !l.fx;
      if (a === 'fy') l.fy = !l.fy;
      if (a === 'keep') l.keep = !dzKeep(l);
      changed(true); return drawSide();
    }
    if (d('al')) { l.al = d('al'); changed(true); return drawSide(); }
    if (d('tog')) { l[d('tog')] = !l[d('tog')]; changed(true); return drawSide(); }
    if (d('ins') && l.t === 'text') {
      const ta = side.querySelector('.dz-text'), at = ta.selectionStart ?? ta.value.length, ins = `{${d('ins')}}`;
      l.text = ta.value.slice(0, at) + ins + ta.value.slice(ta.selectionEnd ?? at); changed(true); drawSide();
      const nt = side.querySelector('.dz-text'); nt.focus(); nt.setSelectionRange(at + ins.length, at + ins.length);
    }
  });
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
    if (from !== to) { const list = [...doc.layers].reverse(), [m] = list.splice(from, 1); list.splice(to, 0, m); doc.layers = list.reverse(); changed(true); }
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
    if (t.dataset.cpick) { const kk = t.dataset.cpick; if (kk === 'bg') doc.bg.c = t.value; else if (l) l[kk] = t.value; return changed(); }
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
    if (t.dataset.cpick) return drawSide();
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
        ${doc.fold ? 'Saved as two pages, outside then inside. Print double-sided, flipping on the short edge.' : ''}</p>
      <div class="dz-ex">
        <button data-ex="png"><b>Save picture</b><small>PNG, for printing elsewhere or posting</small></button>
        <button data-ex="share"><b>Share</b><small>Send it in WhatsApp or another app</small></button>
        ${kind.fold ? '<button data-ex="print"><b>Print / PDF</b><small>Two pages: outside, then inside</small></button>' : ''}
        ${kind.page ? '<button data-ex="print"><b>Print / PDF</b><small>Fits the paper in your printer; choose the same size there</small></button>' : ''}
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
    if (doc.fold) {   // the two sides as their own pages
      const sides = [0, 1].map(i => { const c = document.createElement('canvas'); c.width = doc.w; c.height = doc.fold.side; c.getContext('2d').drawImage(cv, 0, -i * doc.fold.side); return c; });
      if (a === 'print') { o.remove(); return printCanvas(...sides); }
      const fs = await Promise.all(sides.map(async (c, i) => new File([await new Promise(r => c.toBlob(r, 'image/png'))], `${file()}_${i ? 'inside' : 'outside'}.png`, { type: 'image/png' })));
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
async function dzSheet(cv, kind, fill) {
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
    for (let i = 0; i < 2; i++) { x.save(); x.translate(0, i * H / 2); x.rotate(-Math.PI / 2); x.drawImage(cv, -H / 2, 0, H / 2, W); x.restore(); }
    x.strokeStyle = '#bbb'; x.setLineDash([12, 10]); x.lineWidth = 2; x.beginPath(); x.moveTo(0, H / 2); x.lineTo(W, H / 2); x.stroke();
    return pg;
  }
  const cols = Math.max(1, Math.floor((W - 120) / k.w)), rows = Math.max(1, Math.floor((H - 120) / k.h));
  const ox = (W - cols * k.w) / 2, oy = (H - rows * k.h) / 2;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const px = ox + c * k.w, py = oy + r * k.h; x.drawImage(cv, px, py); marks(px, py, k.w, k.h); }
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
