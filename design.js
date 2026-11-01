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
async function dzDraw(cv, doc, scale = 1) {
  await DZF.all(doc);
  const x = cv.getContext('2d'), W = doc.w * scale, H = doc.h * scale;
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
  x.fillStyle = dzCol(doc, doc.bg?.c) || '#ffffff'; x.fillRect(0, 0, W, H);
  if (doc.bg?.img) { const im = await dzImg(doc.bg.img);
    if (im) { const s = Math.max(W / im.naturalWidth, H / im.naturalHeight); x.globalAlpha = doc.bg.op ?? 1;
      x.drawImage(im, (W - im.naturalWidth * s) / 2, (H - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s); x.globalAlpha = 1; } }
  for (const l of doc.layers) {
    if (l.hide) continue;
    const im = l.t === 'image' ? await dzImg(l.logo ? Settings.get('studio_logo_ref') : l.ref) : null;
    let lines = null;
    if (l.t === 'text') {   // measure first, so the box (and its centre) is the real height of the text
      x.setTransform(1, 0, 0, 1, 0, 0);
      if ('letterSpacing' in x) x.letterSpacing = (l.ls || 0) + 'px';
      // "Shrink to fit": a long name or amount gets smaller instead of wrapping onto a second line.
      const txt = dzFill(doc, l.text), want = l.fit ? txt.split('\n').length : Infinity;
      let px = l.size;
      for (;;) { x.font = dzFontStr(doc, l, px); lines = dzWrap(x, txt, l.w); if (lines.length <= want || px <= 8) break; px *= 0.94; }
      l._px = px; l.h = Math.max(px, lines.length * px * (l.lh || 1.2));
    }
    x.save();
    x.setTransform(scale, 0, 0, scale, 0, 0);
    x.translate(l.x + l.w / 2, l.y + (l.h || 0) / 2); x.rotate((l.rot || 0) * Math.PI / 180);
    if (l.fx || l.fy) x.scale(l.fx ? -1 : 1, l.fy ? -1 : 1);   // mirrored
    x.globalAlpha = l.op ?? 1;
    if (l.t === 'text') {
      const px = l._px || l.size, lh = px * (l.lh || 1.2); x.font = dzFontStr(doc, l, px);
      if ('letterSpacing' in x) x.letterSpacing = (l.ls || 0) + 'px';
      x.fillStyle = dzCol(doc, l.c) || '#000'; x.textBaseline = 'alphabetic';
      x.textAlign = l.al || 'left';
      const ax = l.al === 'center' ? 0 : l.al === 'right' ? l.w / 2 : -l.w / 2;
      lines.forEach((ln, i) => x.fillText(ln, ax, -l.h / 2 + i * lh + px * 0.9));
    } else if (l.t === 'image') {
      const r = Math.min(l.r || 0, l.w / 2, l.h / 2), clip = l.cover || r;
      if (clip) { x.save(); x.beginPath(); x.roundRect(-l.w / 2, -l.h / 2, l.w, l.h, r); x.clip(); }
      // cover = fill the box and crop the overflow (photos); otherwise the whole picture fits inside (logos, stickers).
      if (im) { const s = (l.cover ? Math.max : Math.min)(l.w / im.naturalWidth, l.h / im.naturalHeight), w = im.naturalWidth * s, h = im.naturalHeight * s;
        x.drawImage(im, -w / 2 + (l.cover ? (l.px || 0) * (w - l.w) / 2 : 0), -h / 2 + (l.cover ? (l.py || 0) * (h - l.h) / 2 : 0), w, h); }
      else if (l.slot != null) { x.fillStyle = 'rgba(128,128,128,.18)'; x.fillRect(-l.w / 2, -l.h / 2, l.w, l.h);
        x.fillStyle = 'rgba(128,128,128,.8)'; x.font = `600 ${Math.max(14, Math.min(l.w, l.h) * 0.08)}px Inter, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('Photo', 0, 0); }
      else if (l.logo) { x.strokeStyle = 'rgba(128,128,128,.6)'; x.setLineDash([10, 8]); x.lineWidth = 3; x.strokeRect(-l.w / 2, -l.h / 2, l.w, l.h); }
      if (clip) x.restore();
      const st = dzCol(doc, l.stroke);
      if (st && l.sw) { x.beginPath(); x.roundRect(-l.w / 2, -l.h / 2, l.w, l.h, r); x.strokeStyle = st; x.lineWidth = l.sw; x.stroke(); }
    } else if (l.t === 'shape') {
      const f = dzCol(doc, l.fill), st = dzCol(doc, l.stroke), sw = l.sw || 0;
      x.beginPath();
      if (l.shape === 'ellipse') x.ellipse(0, 0, l.w / 2, l.h / 2, 0, 0, Math.PI * 2);
      else if (l.shape === 'star') dzStar(x, 0, 0, Math.min(l.w, l.h) / 2);
      else if (l.shape === 'line') { x.moveTo(-l.w / 2, 0); x.lineTo(l.w / 2, 0); }
      else x.roundRect(-l.w / 2, -l.h / 2, l.w, l.h, Math.min(l.r || 0, l.w / 2, l.h / 2));
      if (l.shape === 'line') { x.strokeStyle = st || f || '#000'; x.lineWidth = Math.max(1, sw || l.h); x.lineCap = 'round'; x.stroke(); }
      else { if (f) { x.fillStyle = f; x.fill(); } if (st && sw) { x.strokeStyle = st; x.lineWidth = sw; x.stroke(); } }
    }
    x.restore();
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
  return [...built.map(t => ({ name: t[0], make: t[1] })), ...dzCustom().filter(c => c.kind === kind).map(c => ({ name: c.name, custom: c })), { name: 'Blank' }];
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
function dzNew(kind, opt, theme, piece) {
  const k = DZ_KINDS[kind], code = Math.random().toString(36).slice(2, 8).toUpperCase(), exp = new Date(); exp.setFullYear(exp.getFullYear() + 1);
  let doc;
  if (opt?.custom) { doc = JSON.parse(JSON.stringify(opt.custom.doc)); doc.layers.forEach(l => l.id = dzId()); doc.theme = theme || doc.theme; }
  else doc = { v: 1, kind, w: k.w, h: k.h, theme, bg: { c: '@bg' }, layers: opt?.make ? opt.make(k.w, k.h) : [] };
  doc.kind = kind; doc.w = k.w; doc.h = k.h;
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
function dzPortfolioPick(photos) {
  return new Promise(async (res) => {
    const rows = photos
      ? await DB.all(`SELECT x.photo_ref AS v, x.thumb_ref AS t, p.title FROM portfolio_photos x JOIN portfolio_items p ON p.id = x.item_id ORDER BY coalesce(p.made_on, p.created_at) DESC, x.sort LIMIT 240`)
      : await DB.all(`SELECT p.id AS v, p.title, (SELECT thumb_ref FROM portfolio_photos x WHERE x.item_id = p.id ORDER BY sort, id LIMIT 1) AS t
          FROM portfolio_items p WHERE EXISTS (SELECT 1 FROM portfolio_photos x WHERE x.item_id = p.id) ORDER BY coalesce(p.made_on, p.created_at) DESC LIMIT 240`);
    if (!rows.length) { toast('Add tattoos with photos to your portfolio first.'); return res(null); }
    const urls = await Promise.all(rows.map(r => Media.url(r.t)));
    const o = document.createElement('div'); o.id = 'merge-dlg'; o.style.zIndex = 99;
    o.innerHTML = `<div class="card dz-pick"><h2>${photos ? 'Choose a photo' : 'Choose a portfolio piece'}</h2>
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
  const rows = await DB.all('SELECT id, name, kind, thumb_ref, updated_at FROM designs ORDER BY updated_at DESC, id DESC');
  const urls = await Promise.all(rows.map(r => Media.url(r.thumb_ref)));
  el.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="muted" style="margin:0;flex:1;font-size:13px">Vouchers, business cards, flyers and posts with your studio's details.</p>
      <button class="btn primary" id="dz-new">+ New design</button></div>
    ${rows.length ? `<div class="dz-grid">${rows.map((r, i) => `<div class="dz-item" data-open="${r.id}">
        <div class="dz-thumb">${urls[i] ? `<img src="${urls[i]}" alt="">` : ''}</div>
        <div class="dz-meta"><b>${esc(r.name)}</b><span class="muted">${esc(DZ_KINDS[r.kind]?.label || '')}</span></div>
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
  const st = { kind: null, li: 0, theme: 'ink', piece: opts.piece ? await dzPiece(opts.piece) : null };
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
    o.innerHTML = `<div class="card dz-pick"><h2>${DZ_KINDS[st.kind].label}</h2>
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
      const doc = dzNew(st.kind, lays[+cv.dataset.prev], st.theme, st.piece), sc = 220 / Math.max(doc.w, doc.h);
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
    if (t.closest('[data-go]')) {
      const doc = dzNew(st.kind, dzLayouts(st.kind)[st.li], st.theme, st.piece);
      const n = await DB.one('SELECT COUNT(*) AS n FROM designs WHERE kind = ?', [st.kind]);
      const name = st.piece?.vals.title ? `${st.piece.vals.title} (${DZ_KINDS[st.kind].label.toLowerCase()})` : DZ_KINDS[st.kind].label + (n.n ? ' ' + (n.n + 1) : '');
      await DB.run('INSERT INTO designs (name, kind, doc) VALUES (?, ?, ?)', [name, st.kind, JSON.stringify(doc)]);
      const id = (await DB.one('SELECT last_insert_rowid() AS id')).id;
      // Photos used by the post count as this design's pictures (kept in backups).
      for (const r of [...new Set(doc.layers.filter(l => l.ref).map(l => l.ref))]) await DB.run('INSERT INTO design_assets (design_id, ref) VALUES (?, ?)', [id, r]);
      await dzThumb(id, doc);
      o.remove(); location.hash = 'design/' + id;
    }
  };
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
      <div class="dz-stage" id="dz-stage"><div class="dz-page" id="dz-page"><canvas id="dz-cv"></canvas><div id="dz-sel" hidden>
        <i class="h nw" data-h="nw"></i><i class="h ne" data-h="ne"></i><i class="h sw" data-h="sw"></i><i class="h se" data-h="se"></i>
        <i class="h e" data-h="e"></i><i class="h w" data-h="w"></i><i class="h rot" data-h="rot"></i></div>
        <i class="dz-guide v" hidden></i><i class="dz-guide hz" hidden></i></div></div>
      <div class="dz-side" id="dz-side"></div>
    </div></div>`;
  const cv = $('#dz-cv'), page = $('#dz-page'), stage = $('#dz-stage'), selBox = $('#dz-sel'), side = $('#dz-side');
  let k = 1;   // screen px per page px
  const layer = () => doc.layers.find(l => l.id === sel);

  // Canvas size: fit the page into the stage; drawn at device resolution for crisp text.
  const fit = () => {
    // On phones the stage hugs the design's shape, so a wide card doesn't leave empty space above and below.
    if (innerWidth < 900) { const sw = stage.clientWidth; stage.style.height = Math.round(Math.min(innerHeight * 0.58, (sw - 32) * doc.h / doc.w + 32)) + 'px'; }
    else stage.style.height = '';
    const r = stage.getBoundingClientRect(), pad = 16;
    k = Math.min((r.width - pad * 2) / doc.w, (Math.max(260, r.height) - pad * 2) / doc.h);
    const w = Math.round(doc.w * k), h = Math.round(doc.h * k), dpr = Math.min(2, devicePixelRatio || 1);
    page.style.width = w + 'px'; page.style.height = h + 'px';
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px';
  };
  let drawing = null;
  const redraw = async () => { const job = (drawing = Symbol()); await dzDraw(cv, doc, k * Math.min(2, devicePixelRatio || 1)); if (job === drawing) placeSel(); };
  const placeSel = () => {
    const l = layer();
    selBox.hidden = !l;
    if (!l) return;
    Object.assign(selBox.style, { left: l.x * k + 'px', top: l.y * k + 'px', width: l.w * k + 'px', height: (l.h || 1) * k + 'px', transform: `rotate(${l.rot || 0}deg)` });
    selBox.classList.toggle('locked', !!l.lock); selBox.classList.toggle('textsel', l.t === 'text');
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
    for (const r of before) if (!refs.includes(r)) await Media.release(r);
    if ($('#dz-list')) DZ.list();
  })()); };
  addEventListener('hashchange', function away() { removeEventListener('hashchange', away); flush(); });
  // A change: redraw, remember for undo, save.
  let histT = null;
  const changed = (now) => {
    redraw(); save();
    clearTimeout(histT);
    const push = () => { const s = JSON.stringify(doc); if (s !== hist[hi]) { hist.splice(hi + 1); hist.push(s); if (hist.length > 60) hist.shift(); hi = hist.length - 1; } };
    if (now) push(); else histT = setTimeout(push, 450);
  };
  const undo = (d) => { const n = hi + d; if (n < 0 || n >= hist.length) return; hi = n; doc = JSON.parse(hist[hi]); doc.vals ||= {}; if (!layer()) sel = null; redraw(); save(); drawSide(); };

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
    side.innerHTML = `<div class="dz-ll" id="dz-ll">${[...doc.layers].reverse().map(l => `<div class="dz-lr ${l.id === sel ? 'on' : ''} ${l.hide ? 'off' : ''}" data-lid="${l.id}">
        <span class="grip" data-grip aria-label="Drag to reorder">⠿</span><span class="li">${layerIco(l)}</span>
        <span class="nm" data-lname title="${l.id === sel ? 'Tap to rename' : 'Tap to select'}">${esc(layerName(l))}</span>
        <button data-lhide title="${l.hide ? 'Show' : 'Hide'}" aria-label="${l.hide ? 'Show' : 'Hide'}">${l.hide ? EYE_OFF : EYE}</button>
        <button data-llock class="${l.lock ? 'on' : ''}" title="${l.lock ? 'Unlock' : 'Lock'}" aria-label="Lock">${LOCK(l.lock)}</button>
        <button data-ldel title="Delete" aria-label="Delete">✕</button></div>`).join('') || '<p class="muted" style="margin:6px 2px">Nothing on the design yet.</p>'}</div>
      <p class="muted" style="font-size:12px;margin:10px 2px 0">The top of the list sits in front. Drag ⠿ to change the order. Tap a name to select it; tap it again to rename.</p>`;
  };
  const drawSide = () => {
    if (tab === 'layers') drawLayers(); else drawEdit();
    side.insertAdjacentHTML('afterbegin', `<div class="seg dz-tabs"><button data-tab="edit" class="${tab === 'edit' ? 'on' : ''}">${layer() ? 'Selected' : 'Design'}</button>
      <button data-tab="layers" class="${tab === 'layers' ? 'on' : ''}">Layers <small>${doc.layers.length}</small></button></div>`);
  };
  const drawEdit = () => {
    const l = layer();
    if (!l) {
      const kinds = doc.kind === 'voucher' || doc.layers.some(x => /\{(amount|to|from|code|expires)\}/.test(x.text || ''));
      const post = DZ_KINDS[doc.kind].social || doc.layers.some(x => x.slot != null || DZ_PIECE_FIELDS.test(x.text || ''));
      side.innerHTML = `
        <div class="dz-add">${[['text', 'Text', 'T'], ['heading', 'Heading', 'H'], ['image', 'Picture', '▣'], ['logo', 'Logo', '◎'], ['shape', 'Shape', '◆'], ['field', 'Studio info', '@']]
          .map(([a, n, i]) => `<button data-add="${a}"><i>${i}</i><span>${n}</span></button>`).join('')}</div>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden id="dz-file">
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
    side.innerHTML = `
      <div class="dz-lh"><b>${kindName}</b><button class="btn small" data-act="done">Done</button></div>
      <div class="dz-acts">
        <button data-act="dup" title="Duplicate">⧉<span>Copy</span></button>
        <button data-act="up" title="Bring forward">▲<span>Forward</span></button>
        <button data-act="down" title="Send back">▼<span>Back</span></button>
        <button data-act="lock" class="${l.lock ? 'on' : ''}" title="Lock">${l.lock ? '🔒' : '🔓'}<span>${l.lock ? 'Locked' : 'Lock'}</span></button>
        <button data-act="fx" class="${l.fx ? 'on' : ''}" title="Flip left to right">⇋<span>Flip</span></button>
        <button data-act="fy" class="${l.fy ? 'on' : ''}" title="Flip upside down">⇵<span>Flip</span></button>
        <button data-act="del" class="danger" title="Delete">✕<span>Delete</span></button></div>
      ${l.t === 'text' ? `
        <textarea class="in dz-text" data-k="text" rows="3">${esc(l.text)}</textarea>
        <div class="dz-fields">${DZ_FIELDS.map(([f, n]) => `<button data-ins="${f}">+ ${n}</button>`).join('')}</div>
        <label class="field"><span>Font</span><select class="in" data-k="font">${fontOpts(l.font)}</select></label>
        <div class="row" style="gap:6px;flex-wrap:nowrap">
          <div class="seg" style="flex:1">${[['left', '⟸'], ['center', '≡'], ['right', '⟹']].map(([a, i]) => `<button data-al="${a}" class="${(l.al || 'left') === a ? 'on' : ''}" style="flex:1" aria-label="Align ${a}">${i}</button>`).join('')}</div>
          <button class="btn small ${l.b ? 'primary' : ''}" data-tog="b" style="font-weight:800">B</button><button class="btn small ${l.it ? 'primary' : ''}" data-tog="it" style="font-style:italic">I</button></div>
        <label class="toggle" style="display:inline-flex;margin-top:8px" data-tip="Long text gets smaller to stay on its lines instead of wrapping, e.g. a studio name or amount"><input type="checkbox" data-fit ${l.fit ? 'checked' : ''}><span>Shrink to fit</span></label>
        ${slider('size', 'Size', 8, Math.round(doc.h * 0.4), 1, Math.round(l.size))}
        ${swatches('c', l.c)}
        ${fsec('Spacing', slider('ls', 'Letter spacing', -5, 40, 1, l.ls || 0) + slider('lh', 'Line height', 0.8, 2.5, 0.05, l.lh || 1.2), { fold: true })}`
      : l.t === 'shape' ? `
        <div class="lbl">Fill</div>${swatches('fill', l.fill, true)}
        <div class="lbl" style="margin-top:8px">Outline</div>${swatches('stroke', l.stroke, true)}
        ${slider('sw', 'Outline width', 0, 40, 1, l.sw || 0)}
        ${l.shape === 'rect' || !l.shape ? slider('r', 'Corner rounding', 0, Math.round(Math.min(l.w, l.h) / 2), 1, l.r || 0) : ''}`
      : `${l.logo ? '<p class="muted" style="font-size:12px;margin:0 0 8px">Your studio logo from Settings.</p>'
          : `<div class="row" style="gap:6px;margin-bottom:8px"><button class="btn small" id="dz-pfphoto">From portfolio</button>
              <label class="btn small">From device<input type="file" accept="image/*" hidden id="dz-repl"></label></div>`}
        ${l.logo ? '' : `<label class="toggle" style="display:inline-flex;margin-bottom:6px" data-tip="Fill the whole box and crop what doesn't fit, like a photo frame. Off: the whole picture fits inside."><input type="checkbox" data-cover ${l.cover ? 'checked' : ''}><span>Fill the box (crop)</span></label>
          ${l.cover ? slider('px', 'Move photo left / right', -1, 1, 0.02, l.px || 0, v => Math.round(v * 100)) + slider('py', 'Move photo up / down', -1, 1, 0.02, l.py || 0, v => Math.round(v * 100)) : ''}
          ${slider('r', 'Corner rounding', 0, Math.round(Math.min(l.w, l.h) / 2), 1, l.r || 0)}
          <div class="lbl">Outline</div>${swatches('stroke', l.stroke, true)}${slider('sw', 'Outline width', 0, 40, 1, l.sw || 0)}`}`}
      ${slider('op', 'Opacity', 0, 1, 0.05, l.op ?? 1, v => Math.round(v * 100) + '%')}
      ${slider('rot', 'Rotation', -180, 180, 1, Math.round(l.rot || 0), v => v + '°')}`;
  };
  const select = (idv) => { sel = idv; panel = null; placeSel(); drawSide(); };

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
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i]; if (l.hide) continue;
      const a = -(l.rot || 0) * Math.PI / 180, cx = l.x + l.w / 2, cy = l.y + (l.h || 0) / 2, dx = p.x - cx, dy = p.y - cy;
      const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a), tol = 10 / k;
      if (Math.abs(lx) <= l.w / 2 + tol && Math.abs(ly) <= (l.h || 0) / 2 + tol) return l;
    }
    return null;
  };
  const guides = (gx, gy) => { page.querySelector('.dz-guide.v').hidden = !gx; page.querySelector('.dz-guide.hz').hidden = !gy; };
  let drag = null;
  stage.addEventListener('pointerdown', (e) => { if (!e.target.closest('#dz-page') && sel) select(null); });
  page.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-h]')?.dataset.h, p = toPage(e);
    let l = layer();
    if (!h) { const hl = hit(p); if (hl?.id !== sel) { select(hl?.id || null); l = hl; } }
    if (!l || l.lock) return;
    e.preventDefault(); page.setPointerCapture(e.pointerId);
    drag = { h: h || 'move', p0: p, l0: { ...l } };
  });
  page.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const l = layer(), p = toPage(e), o = drag.l0, a = (o.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    if (drag.h === 'move') {
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
        if (o.t === 'shape' && o.shape !== 'line' && !e.shiftKey) { w = Math.max(20, o.w + sx * lx); hgt = Math.max(10, (o.h || 1) + sy * ly); }
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
  const end = () => { if (!drag) return; drag = null; guides(false, false); changed(true); drawSide(); };
  page.addEventListener('pointerup', end); page.addEventListener('pointercancel', end);
  addEventListener('keydown', function keys(e) {
    if (!document.body.contains(el)) return removeEventListener('keydown', keys);
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); return undo(e.shiftKey ? 1 : -1); }
    const l = layer(); if (!l) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { doc.layers = doc.layers.filter(x => x !== l); sel = null; changed(true); drawSide(); }
    const step = e.shiftKey ? 20 : 4, mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv && !l.lock) { e.preventDefault(); l.x += mv[0]; l.y += mv[1]; changed(); }
    if (e.key === 'Escape') select(null);
  });

  /* Side panel events */
  side.addEventListener('click', async (e) => {
    const t = e.target, d = (kk) => t.closest(`[data-${kk}]`)?.dataset[kk], l = layer();
    if (d('tab')) { tab = d('tab'); return drawSide(); }
    const row = t.closest('[data-lid]');
    if (row && !t.closest('[data-grip]')) {
      const ly = doc.layers.find(x => x.id === row.dataset.lid); if (!ly) return;
      if (t.closest('[data-lhide]')) { ly.hide = !ly.hide; if (ly.hide && sel === ly.id) sel = null; placeSel(); changed(true); return drawSide(); }
      if (t.closest('[data-llock]')) { ly.lock = !ly.lock; placeSel(); changed(true); return drawSide(); }
      if (t.closest('[data-ldel]')) { doc.layers = doc.layers.filter(x => x !== ly); if (sel === ly.id) sel = null; placeSel(); changed(true); return drawSide(); }
      if (t.closest('[data-lname]') && sel === ly.id) {
        const n = prompt('Layer name:', layerName(ly)); if (n == null) return;
        ly.name = n.trim() || undefined; changed(true); return drawSide();
      }
      return select(ly.id);
    }
    if (d('add')) {
      const a = d('add');
      if (a === 'text') return add({ t: 'text', text: 'Your text', size: Math.round(doc.h * 0.05), font: '@2', c: '@fg', al: 'center', lh: 1.2, ...center(doc.w * 0.6, doc.h * 0.06) });
      if (a === 'heading') return add({ t: 'text', text: 'Heading', size: Math.round(doc.h * 0.1), font: '@1', c: '@fg', al: 'center', lh: 1.1, ...center(doc.w * 0.7, doc.h * 0.11) });
      if (a === 'logo') { if (!Settings.get('studio_logo_ref')) toast('Add your logo in Settings › Profile; it shows here once added.', 5000); const s = Math.min(doc.w, doc.h) * 0.3; return add({ t: 'image', logo: true, ...center(s, s) }); }
      if (a === 'image') return $('#dz-file').click();
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
    if (t.closest('#dz-pfphoto') && l) { const ref = await dzPortfolioPick(true); if (!ref) return; l.ref = ref; if (!l.cover && l.slot == null) { const im = await dzImg(ref); if (im) l.h = l.w * im.naturalHeight / im.naturalWidth; } changed(true); return drawSide(); }
    if (d('c')) {
      const key = t.closest('[data-swk]').dataset.swk, c = d('c');
      if (key === 'bg') doc.bg.c = c === 'none' ? '@bg' : c; else if (l) l[key] = c;
      changed(); return drawSide();
    }
    if (!l) return;
    if (d('act')) {
      const a = d('act'), i = doc.layers.indexOf(l);
      if (a === 'done') return select(null);
      if (a === 'del') { doc.layers.splice(i, 1); sel = null; }
      if (a === 'dup') { const c = { ...JSON.parse(JSON.stringify(l)), id: dzId(), x: l.x + 30, y: l.y + 30 }; doc.layers.splice(i + 1, 0, c); sel = c.id; }
      if (a === 'up' && i < doc.layers.length - 1) [doc.layers[i], doc.layers[i + 1]] = [doc.layers[i + 1], doc.layers[i]];
      if (a === 'down' && i > 0) [doc.layers[i], doc.layers[i - 1]] = [doc.layers[i - 1], doc.layers[i]];
      if (a === 'lock') l.lock = !l.lock;
      if (a === 'fx') l.fx = !l.fx;
      if (a === 'fy') l.fy = !l.fy;
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
  let ldrag = null;
  side.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-grip]'); if (!g) return;
    e.preventDefault();
    const row = g.closest('.dz-lr'), rows = [...$('#dz-ll').children];
    ldrag = { row, rows, from: rows.indexOf(row), to: rows.indexOf(row), y0: e.clientY, h: row.offsetHeight + 4 };
    row.classList.add('drag'); g.setPointerCapture(e.pointerId);
  });
  side.addEventListener('pointermove', (e) => {
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
  side.addEventListener('pointerup', ldrop); side.addEventListener('pointercancel', ldrop);
  side.addEventListener('input', (e) => {
    const t = e.target, l = layer(), key = t.dataset.k;
    if (t.dataset.v) { doc.vals[t.dataset.v] = t.value; return changed(); }
    if (t.dataset.cpick) { const kk = t.dataset.cpick; if (kk === 'bg') doc.bg.c = t.value; else if (l) l[kk] = t.value; return changed(); }
    if (key === 'bgop') { doc.bg.op = +t.value; t.closest('.dz-sl').querySelector('b').textContent = Math.round(t.value * 100) + '%'; return changed(); }
    if (!l || !key || key === 'font') return;
    l[key] = key === 'text' ? t.value : +t.value;
    const b = t.closest('.dz-sl')?.querySelector('b');
    if (b) b.textContent = key === 'op' ? Math.round(t.value * 100) + '%' : key === 'rot' ? t.value + '°' : t.value;
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
      <p class="muted" style="font-size:13px;margin-top:0">${esc(kind.label)}, ${esc(kind.sub)}. Saved at print quality (300 dpi).</p>
      <div class="dz-ex">
        <button data-ex="png"><b>Save picture</b><small>PNG, for printing elsewhere or posting</small></button>
        <button data-ex="share"><b>Share</b><small>Send it in WhatsApp or another app</small></button>
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
    const cv = await dzCanvas(doc), blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const f = new File([blob], file() + '.png', { type: 'image/png' });
    if (a === 'png') { const l = document.createElement('a'); l.href = URL.createObjectURL(f); l.download = f.name; l.click(); setTimeout(() => URL.revokeObjectURL(l.href), 5000); return toast('Saved ' + f.name); }
    if (a === 'share') {
      try { if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: name }); else { const l = document.createElement('a'); l.href = URL.createObjectURL(f); l.download = f.name; l.click(); } }
      catch (err) { if (err.name !== 'AbortError') toast('Could not share: ' + err.message); }
      return;
    }
    if (a === 'print') { o.remove(); return printCanvas(await dzSheet(cv, doc.kind, st.sheet)); }
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
