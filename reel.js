'use strict';
/* InkForge reel maker: quick, consistent vertical (9:16) tattoo reels.
   A reel = optional intro card + clips (photos/videos) + optional outro card, drawn on one canvas.
   The look (fonts, colours, handle, transitions) is a saved "style" so every reel matches.
   Reels are saved like designs (see "Saved reels" in app.js): clips are copied into the media folder. Export records the
   canvas + Web Audio mix in real time with MediaRecorder (MP4 where the browser supports it). */

const REEL_VERSION = 10;   // app.js checks this matches, to catch a stale cached copy
// Card backgrounds: { ref, op, zoom, rot, flip } with ref = media file name (kept in the media folder).
const REEL_CARD_BG = { ref: '', op: 0.55, zoom: 1, rot: 0, flip: false };
const REEL_STYLE_DEFAULTS = {
  title: '', handle: '', intro: true, outro: true, outroText: 'Book now',
  font: 'display', color: '#e9e3d6', accent: '#1fb5a8', transition: 'fade',
  transDir: 'left', transDur: 0.32,                 // wipe/slide come in from this side; seconds per transition
  captionPos: 'bottom', capSize: 'm', quality: '720',
  wmMode: 'text', wmPos: 'br', wmOp: 0.75,          // watermark: off | text (handle) | logo
  cardLogo: true, introBg: REEL_CARD_BG, outroBg: REEL_CARD_BG,
  introDur: 1.6, outroDur: 2.4,
  introPos: null, outroPos: null,                    // card text group moved on the preview: { x, y, s }
  logoRef: ''                                        // a logo for this style only (e.g. another artist); '' = studio logo
};
const reelLogoRef = (s) => s.logoRef || Settings.get('studio_logo_ref');
// Opposite / alternative versions of a transition, stored in its `dir`. Wipe and slide use sides.
const REEL_TR_VARIANTS = {
  zoom: [['in', 'Zoom in'], ['out', 'Zoom out']],
  fade: [['black', 'To black'], ['white', 'To white']],
  flash: [['white', 'White'], ['accent', 'Accent colour']],
  wipe: [['left', '← Left'], ['right', 'Right →'], ['top', '↑ Top'], ['bottom', '↓ Bottom']],
  slide: [['left', '← Left'], ['right', 'Right →'], ['top', '↑ Top'], ['bottom', '↓ Bottom']],
  whip: [['left', '← Left'], ['right', 'Right →']],
  doors: [['side', 'Sideways'], ['top', 'Up and down']],
  spin: [['right', 'Clockwise'], ['left', 'Anticlockwise']]
};
// A transition's variant, falling back to the type's first one when dir belongs to another type.
const trVariant = (tr) => { const v = REEL_TR_VARIANTS[tr.type]; return v ? (v.some(([k]) => k === tr.dir) ? tr.dir : v[0][0]) : ''; };
// Per-clip looks. ctx.filter strings; browsers without canvas filters just show the original.
const REEL_FILTERS = [
  ['none', 'Original', 'none'],
  ['fresh', 'Fresh ink', 'contrast(1.2) saturate(1.35) brightness(1.03)'],
  ['punch', 'Punchy', 'contrast(1.4) saturate(1.1)'],
  ['bw', 'B&W', 'grayscale(1) contrast(1.15)'],
  ['noir', 'Noir', 'grayscale(1) contrast(1.6) brightness(.9)'],
  ['warm', 'Warm', 'sepia(.25) saturate(1.2) hue-rotate(-8deg)'],
  ['cool', 'Cool', 'saturate(.9) hue-rotate(12deg) brightness(1.02)'],
  ['fade', 'Faded', 'contrast(.85) brightness(1.08) saturate(.8)'],
  ['vivid', 'Vivid', 'saturate(1.7) contrast(1.1)'],
  ['matte', 'Matte', 'contrast(.8) brightness(1.1) saturate(.9) sepia(.08)'],
  ['moody', 'Moody', 'contrast(1.25) brightness(.85) saturate(.75)'],
  ['golden', 'Golden hour', 'sepia(.35) saturate(1.4) brightness(1.05) hue-rotate(-12deg)'],
  ['teal', 'Teal & orange', 'contrast(1.15) saturate(1.3) hue-rotate(-6deg) sepia(.15)'],
  ['cine', 'Cinematic', 'contrast(1.3) saturate(.85) brightness(.92) sepia(.12)'],
  ['vintage', 'Vintage', 'sepia(.5) contrast(.9) brightness(1.05) saturate(.8)'],
  ['sepia', 'Sepia', 'sepia(.9) contrast(1.05)'],
  ['chrome', 'Chrome', 'contrast(1.35) saturate(1.25) brightness(1.05)'],
  ['dream', 'Dreamy', 'brightness(1.12) contrast(.85) saturate(1.15) blur(.6px)'],
  ['night', 'Night', 'brightness(.75) contrast(1.2) saturate(.7) hue-rotate(18deg)'],
  ['ink', 'Ink only', 'grayscale(1) contrast(2.2) brightness(1.15)'],
  ['pop', 'Pop art', 'saturate(2.4) contrast(1.4)'],
  ['frost', 'Frost', 'saturate(.6) hue-rotate(25deg) brightness(1.1)'],
  ['rose', 'Rose', 'sepia(.25) hue-rotate(-30deg) saturate(1.3)']
];
/* Per-clip adjustments (all 0 = untouched): [key, label, min, max]. Added on top of the clip's filter. */
const REEL_ADJ = [['bri', 'Brightness', -60, 60], ['con', 'Contrast', -60, 60], ['sat', 'Saturation', -100, 100], ['warm', 'Warmth', -60, 60],
  ['hue', 'Hue', -180, 180], ['soft', 'Soften', 0, 10]];
// The whole ctx.filter for a clip at frame width W: its look, then its adjustments.
function reelClipFilter(c, W = 1080) {
  const a = c.adj || {}, f = [REEL_FILTER_CSS[c.filter] || ''];
  if (a.bri) f.push(`brightness(${1 + a.bri / 100})`);
  if (a.con) f.push(`contrast(${1 + a.con / 100})`);
  if (a.sat) f.push(`saturate(${Math.max(0, 1 + a.sat / 100)})`);
  if (a.warm > 0) f.push(`sepia(${a.warm / 100})`); else if (a.warm < 0) f.push(`hue-rotate(${-a.warm * 0.4}deg) saturate(${1 + a.warm / 300})`);
  if (a.hue) f.push(`hue-rotate(${a.hue}deg)`);
  if (a.soft) f.push(`blur(${a.soft * W / 1080 * 0.6}px)`);
  const out = f.filter(x => x && x !== 'none').join(' ');
  return out || 'none';
}
/* Effects layered on a clip: [key, label, what it does]. Shake and Pulse move the picture; the rest draw over it. */
const REEL_FX = [['vignette', 'Vignette', 'Darkens the edges'], ['grain', 'Film grain', 'Moving film noise'], ['glitch', 'Glitch', 'Digital tears and colour split'],
  ['leak', 'Light leak', 'Warm light drifting across'], ['bars', 'Cinema bars', 'Black bars top and bottom'], ['scan', 'VHS lines', 'Old TV scanlines'],
  ['shake', 'Shake', 'Handheld camera shake'], ['pulse', 'Pulse', 'Beats in and out'], ['flicker', 'Flicker', 'Old film light flicker'],
  ['sparkle', 'Sparkle', 'Twinkling highlights'], ['frame', 'Border', 'An accent coloured frame'], ['blurin', 'Focus in', 'Starts blurred, sharpens']];
let _grain = null;
function reelGrain() {   // a small noise tile, made once
  if (_grain) return _grain;
  _grain = document.createElement('canvas'); _grain.width = _grain.height = 128;
  const x = _grain.getContext('2d'), d = x.createImageData(128, 128);
  for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 40; }
  x.putImageData(d, 0, 0); return _grain;
}
const reelRnd = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };   // steady per frame number
// Before the picture: camera moves.
function reelFxPre(ctx, c, W, H, local) {
  const fx = c.fx || [];
  if (fx.includes('shake')) { const f = Math.floor(local * 24), k = Math.min(W, H) / 1080; ctx.translate((reelRnd(f) - 0.5) * 14 * k, (reelRnd(f + 7) - 0.5) * 14 * k); }
  if (fx.includes('pulse')) { const z = 1 + 0.035 * (0.5 + 0.5 * Math.sin(local * Math.PI * 4)); ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2); }
}
// After the picture: looks laid over it.
function reelFxPost(ctx, s, c, W, H, local) {
  const fx = c.fx || []; if (!fx.length) return;
  const k = Math.min(W, H) / 1080, f = Math.floor(local * 24);
  if (fx.includes('glitch') && reelRnd(f * 3) > 0.55) {
    for (let i = 0; i < 5; i++) { const y = reelRnd(f + i) * H, h = (10 + reelRnd(f + i * 9) * 70) * k, dx = (reelRnd(f + i * 5) - 0.5) * 80 * k;
      ctx.drawImage(ctx.canvas, 0, y * ctx.canvas.height / H, ctx.canvas.width, h * ctx.canvas.height / H, dx, y, W, h); }
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.35;
    ctx.fillStyle = reelRnd(f) > 0.5 ? '#ff0040' : '#00e5ff'; ctx.fillRect(0, reelRnd(f + 2) * H, W, 6 * k); ctx.restore();
  }
  if (fx.includes('leak')) {
    const a = local * 0.6, x = W * (0.5 + 0.5 * Math.sin(a)), y = H * (0.3 + 0.2 * Math.cos(a * 1.3));
    const g = ctx.createRadialGradient(x, y, 0, x, y, W * 0.9);
    g.addColorStop(0, 'rgba(255,150,60,.45)'); g.addColorStop(0.5, 'rgba(255,60,90,.15)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
  if (fx.includes('sparkle')) {
    ctx.save(); ctx.fillStyle = '#fff';
    for (let i = 0; i < 14; i++) { const ph = (local * 1.5 + reelRnd(i * 3)) % 1, a = Math.sin(ph * Math.PI), x = reelRnd(i + 1) * W, y = reelRnd(i + 50) * H, r = (6 + reelRnd(i + 9) * 10) * k * a;
      if (r < 0.5) continue; ctx.globalAlpha = a * 0.9; ctx.beginPath();
      ctx.moveTo(x, y - r * 2); ctx.lineTo(x + r * 0.35, y - r * 0.35); ctx.lineTo(x + r * 2, y); ctx.lineTo(x + r * 0.35, y + r * 0.35);
      ctx.lineTo(x, y + r * 2); ctx.lineTo(x - r * 0.35, y + r * 0.35); ctx.lineTo(x - r * 2, y); ctx.lineTo(x - r * 0.35, y - r * 0.35); ctx.fill(); }
    ctx.restore();
  }
  if (fx.includes('scan')) {
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.22)'; const st = 6 * k;
    for (let y = (local * 40 * k) % st; y < H; y += st) ctx.fillRect(0, y, W, st / 2);
    ctx.globalAlpha = 0.08; ctx.fillStyle = '#7fd'; ctx.fillRect(0, ((local * 0.4) % 1) * H, W, 40 * k); ctx.restore();
  }
  if (fx.includes('grain')) {
    const g = reelGrain(), pat = ctx.createPattern(g, 'repeat');
    ctx.save(); ctx.translate(reelRnd(f) * 128, reelRnd(f + 3) * 128); ctx.globalCompositeOperation = 'overlay'; ctx.fillStyle = pat; ctx.fillRect(-128, -128, W + 256, H + 256); ctx.restore();
  }
  if (fx.includes('flicker')) { ctx.save(); ctx.fillStyle = `rgba(0,0,0,${0.04 + reelRnd(f) * 0.14})`; ctx.fillRect(0, 0, W, H); ctx.restore(); }
  if (fx.includes('vignette')) {
    const g = ctx.createRadialGradient(W / 2, H / 2, W * 0.35, W / 2, H / 2, H * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.7)');
    ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
  if (fx.includes('bars')) { ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H * 0.11); ctx.fillRect(0, H * 0.89, W, H * 0.11); ctx.restore(); }
  if (fx.includes('frame')) { ctx.save(); ctx.strokeStyle = s.accent; ctx.lineWidth = 14 * k; ctx.strokeRect(28 * k, 28 * k, W - 56 * k, H - 56 * k); ctx.restore(); }
}
/* Fonts for cards and captions: [key, label, css family, Google Fonts spec or '' when built in]. */
const REEL_FONTS = [['display', 'Tattoo', "'Pirata One', serif", ''], ['clean', 'Clean', 'Inter, system-ui, sans-serif', ''],
  ['blackletter', 'Blackletter', "'UnifrakturMaguntia', serif", 'UnifrakturMaguntia'], ['bebas', 'Bold condensed', "'Bebas Neue', sans-serif", 'Bebas Neue'],
  ['anton', 'Impact', "'Anton', sans-serif", 'Anton'], ['oswald', 'Oswald', "'Oswald', sans-serif", 'Oswald:wght@400;700'],
  ['montserrat', 'Modern', "'Montserrat', sans-serif", 'Montserrat:wght@400;800'], ['playfair', 'Elegant serif', "'Playfair Display', serif", 'Playfair Display:wght@400;700'],
  ['cinzel', 'Classic', "'Cinzel', serif", 'Cinzel:wght@400;700'], ['vibes', 'Script', "'Great Vibes', cursive", 'Great Vibes'],
  ['dancing', 'Handwriting', "'Dancing Script', cursive", 'Dancing Script:wght@700'], ['pacifico', 'Retro script', "'Pacifico', cursive", 'Pacifico'],
  ['marker', 'Marker', "'Permanent Marker', cursive", 'Permanent Marker'], ['caveat', 'Note', "'Caveat', cursive", 'Caveat:wght@700'],
  ['rye', 'Western', "'Rye', serif", 'Rye'], ['typewriter', 'Typewriter', "'Special Elite', monospace", 'Special Elite'],
  ['monoton', 'Neon sign', "'Monoton', sans-serif", 'Monoton'], ['bungee', 'Street', "'Bungee', sans-serif", 'Bungee']];
// Built in, then fonts imported in the design studio or here (key 'u:<name>'), which load from the media folder.
const reelFontsAll = () => [...REEL_FONTS, ...(typeof DZF !== 'undefined' ? DZF.custom() : []).map(f => ['u:' + f.name, f.name, `'${f.name}'`, ''])];
const reelFontDef = (key) => reelFontsAll().find(f => f[0] === key) || REEL_FONTS[0];
const _reelFontsAsked = new Set();
// Loads a font's file (once) and redraws when it arrives.
function reelFontLoad(key) {
  if (String(key).startsWith('u:')) { if (_reelFontsAsked.has(key) || typeof DZF === 'undefined') return Promise.resolve(); _reelFontsAsked.add(key);
    return DZF.load(key.slice(2)).catch(() => {}).then(() => { if (!R.playing) reelRender(); }); }
  const [, , fam, g] = reelFontDef(key); if (!g || _reelFontsAsked.has(key)) return Promise.resolve();
  _reelFontsAsked.add(key);
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=' + g.replace(/ /g, '+') + '&display=swap';
  document.head.appendChild(l);
  return new Promise(r => { l.onload = r; l.onerror = r; setTimeout(r, 4000); }).then(() => document.fonts.load(`700 40px ${fam}`)).catch(() => {}).then(() => { if (!R.playing) reelRender(); });
}
const REEL_FILTER_CSS = Object.fromEntries(REEL_FILTERS.map(([k, , f]) => [k, f]));
const REEL_CAP_PX = { s: 60, m: 78, l: 100 };
const REEL_COLORS = ['#e9e3d6', '#ffffff', '#1fb5a8', '#f0c75e', '#d2453b'];
/* Reel sizes: [key, label, where it is used, width, height at 1080p]. The preview keeps its long side at 960. */
const REEL_SIZES = [['9:16', 'Vertical 9:16', 'Reels, TikTok, Shorts, Stories', 1080, 1920], ['4:5', 'Portrait 4:5', 'Instagram and Facebook feed', 1080, 1350],
  ['1:1', 'Square 1:1', 'Feed posts, carousels', 1080, 1080], ['16:9', 'Landscape 16:9', 'YouTube, Facebook video', 1920, 1080]];
let PREVIEW_W = 540, PREVIEW_H = 960;
const reelSize = (k) => REEL_SIZES.find(x => x[0] === k) || REEL_SIZES[0];
function reelSetAspect(k) { const [, , , w, h] = reelSize(k); R.ar = reelSize(k)[0]; const f = 960 / Math.max(w, h); PREVIEW_W = Math.round(w * f); PREVIEW_H = Math.round(h * f); }

const R = {
  clips: [], sel: -1, tab: 'edit', seq: 0,
  pick: null,             // timeline selection: { kind: 'clip'|'intro'|'outro'|'trans', key }
  trans: {},              // per-boundary overrides { type, dir, dur }, keyed by the incoming segment's key
  ovl: [],                // text and stickers over the whole reel: sticker fields + t0, t1 (seconds on the reel)
  aud: [],                // sound tracks: { id, row 0|1, name, ref, buffer, t0, off, len, vol, fadeIn, fadeOut }
  audNodes: [],
  music: null,            // { name, buffer, offset, vol }
  playing: false, t: 0, t0: 0, raf: 0,
  actx: null, master: null, musicNode: null, recDest: null,
  recording: false, cancel: false
};

function reelStyle() {
  let s = {}; try { s = JSON.parse(Settings.get('reel_style', '{}')); } catch {}
  if (!('wmMode' in s) && s.watermark === false) s.wmMode = 'off';   // older saved styles had an on/off watermark
  const out = { ...REEL_STYLE_DEFAULTS, ...s };
  out.introBg = { ...REEL_CARD_BG, ...s.introBg }; out.outroBg = { ...REEL_CARD_BG, ...s.outroBg };
  return out;
}
function reelSetStyle(k, v) { const s = reelStyle(); s[k] = v; Settings.set('reel_style', JSON.stringify(s)); }

// Saved images (logo, card backgrounds) decoded once and cached; the preview redraws when one arrives.
const reelImgs = new Map();
function reelImg(ref) {
  if (!ref) return null;
  const hit = reelImgs.get(ref);
  if (hit) return hit.ok ? hit.img : null;
  const rec = { img: new Image(), ok: false };
  reelImgs.set(ref, rec);
  Media.url(ref).then(u => { if (!u) return; rec.img.onload = () => { rec.ok = true; if (!R.playing) reelRender(); }; rec.img.src = u; });
  return null;
}

/* ---------- Timeline ---------- */
const clipDur = (c) => c.type === 'video' ? Math.max(0.3, (c.outP - c.inP) / (c.speed || 1)) : c.dur;
function reelSegments() {
  const s = reelStyle(), segs = [];
  let t = 0;
  const push = (seg) => { seg.start = t; t += seg.dur; segs.push(seg); };
  if (s.intro) push({ kind: 'intro', key: 'intro', dur: +s.introDur || 1.6 });
  for (const c of R.clips) push({ kind: 'clip', key: c.id, clip: c, dur: clipDur(c) });
  if (s.outro) push({ kind: 'outro', key: 'outro', dur: +s.outroDur || 2.4 });
  return { segs, total: t };
}
// Transition INTO a segment: its own override in R.trans (keyed by seg.key), else the style default.
const REEL_DIPS = ['fade', 'flash', 'zoom', 'spin', 'blur', 'glitch'];
// Transitions where the next segment shows over the end of this one.
const REEL_OVER = ['wipe', 'slide', 'dissolve', 'iris', 'doors', 'whip', 'heart'];
function reelTrans(s, seg) {
  const o = R.trans[seg.key] || {};
  return { type: o.type ?? s.transition, dir: o.dir ?? s.transDir, dur: +(o.dur ?? s.transDur) || 0.32 };
}
function reelSegAt(segs, t) {
  for (const s of segs) if (t < s.start + s.dur) return s;
  return segs[segs.length - 1];
}

/* ---------- Drawing ---------- */
// key: a REEL_FONTS key (a caption's own font) or the style's font when left out.
const reelFont = (s, px, weight = 700, key) => { const k = key || s.font, [, , fam, g] = reelFontDef(k); if (g || String(k).startsWith('u:')) reelFontLoad(k);
  return k === 'display' ? `${px}px ${fam}` : `${weight} ${px}px ${fam}`; };

// Soft background blur. Drawn at 180x320 (cheap every frame), blurred there, then scaled up smoothly.
// Where canvas filters are missing (older Safari), halving the image a few times and scaling it
// back up gives a similar soft result without the blocky look of one big stretch.
let _blurA, _blurB;
let BLUR_W = 180, BLUR_H = 320;
const canFilter = (() => { try { const x = document.createElement('canvas').getContext('2d'); x.filter = 'blur(2px)'; return x.filter === 'blur(2px)'; } catch { return false; } })();
function blurredCover(ctx, el, sw, sh, W, H) {
  _blurA ||= document.createElement('canvas'); _blurB ||= document.createElement('canvas');
  BLUR_W = Math.round(320 * W / Math.max(W, H)); BLUR_H = Math.round(320 * H / Math.max(W, H));
  const sc = Math.max(BLUR_W / sw, BLUR_H / sh) * 1.15;   // slight overscan hides soft edges
  _blurA.width = BLUR_W; _blurA.height = BLUR_H;
  const a = _blurA.getContext('2d');
  a.imageSmoothingEnabled = true; a.imageSmoothingQuality = 'high';
  if (canFilter) {
    a.filter = 'blur(9px)';
    a.drawImage(el, (BLUR_W - sw * sc) / 2, (BLUR_H - sh * sc) / 2, sw * sc, sh * sc);
  } else {
    a.drawImage(el, (BLUR_W - sw * sc) / 2, (BLUR_H - sh * sc) / 2, sw * sc, sh * sc);
    const b = _blurB.getContext('2d');
    for (const f of [4, 8]) {   // down to 1/4 and 1/8, then back up, each step smoothed
      _blurB.width = BLUR_W / f; _blurB.height = BLUR_H / f;
      b.imageSmoothingEnabled = true; b.imageSmoothingQuality = 'high';
      b.drawImage(_blurA, 0, 0, _blurB.width, _blurB.height);
      a.clearRect(0, 0, BLUR_W, BLUR_H); a.drawImage(_blurB, 0, 0, BLUR_W, BLUR_H);
    }
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(_blurA, 0, 0, W, H);
  ctx.filter = 'none';
  ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// Draws a clip into W x H. Rotation (0/90/180/270) and mirror are applied around the centre;
// for 90/270 the image is fitted into the swapped box so it still fills the frame.
function drawMedia(ctx, c, W, H, p) {
  if (c.type === 'blank') {   // a plain page: one colour, or a gradient from top to bottom
    if (c.bg2) { const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, c.bg || '#111'); g.addColorStop(1, c.bg2); ctx.fillStyle = g; } else ctx.fillStyle = c.bg || '#111';
    ctx.fillRect(0, 0, W, H); return;
  }
  const el = c.el, sw = c.w, sh = c.h;
  if (!sw || !sh) return;
  let z = 1, ox = 0;
  if (c.motion === 'in') z = 1 + 0.12 * p;
  else if (c.motion === 'out') z = 1.12 - 0.12 * p;
  else if (c.motion === 'pan') { z = 1.12; ox = (p - 0.5) * 2; }
  const rot = c.rot || 0, BW = rot % 180 ? H : W, BH = rot % 180 ? W : H;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  if (rot) ctx.rotate(rot * Math.PI / 180);
  if (c.flip) ctx.scale(-1, 1);
  ctx.translate(-BW / 2, -BH / 2);
  ctx.filter = reelClipFilter(c, W);
  if (c.fx?.includes('blurin') && p < 0.3) ctx.filter = (ctx.filter === 'none' ? '' : ctx.filter + ' ') + `blur(${(1 - p / 0.3) * 14 * Math.min(W, H) / 1080}px)`;
  const zz = c.zoom || 1; if (zz !== 1 || c.ox || c.oy) { ctx.translate(BW / 2 + (c.ox || 0) * BW, BH / 2 + (c.oy || 0) * BH); ctx.scale(zz, zz); ctx.translate(-BW / 2, -BH / 2); }
  if (c.fit === 'blur' || c.fit === 'plain') {
    if (c.fit === 'blur') blurredCover(ctx, el, sw, sh, BW, BH);   // takes the clip's look too, so B&W stays B&W
    else { ctx.fillStyle = c.bg || '#000'; ctx.fillRect(0, 0, BW, BH); }
    const sc = Math.min(BW / sw, BH / sh) * (0.94 + (z - 1) * 0.5);
    const dw = sw * sc, dh = sh * sc;
    ctx.drawImage(el, (BW - dw) / 2 + ox * BW * 0.02, (BH - dh) / 2, dw, dh);
  } else {
    const sc = Math.max(BW / sw, BH / sh) * z;
    const dw = sw * sc, dh = sh * sc;
    const slack = (dw - BW) / 2;
    ctx.drawImage(el, (BW - dw) / 2 + ox * slack, (BH - dh) / 2, dw, dh);
  }
  ctx.restore();
}

// Background image on an intro/outro card: cover-fit, then zoom, rotate, mirror, at the chosen opacity.
function drawCardBg(ctx, bg, W, H) {
  const img = reelImg(bg.ref); if (!img) return;
  const rot = bg.rot || 0, BW = rot % 180 ? H : W, BH = rot % 180 ? W : H;
  const sc = Math.max(BW / img.naturalWidth, BH / img.naturalHeight) * (bg.zoom || 1);
  ctx.save();
  ctx.globalAlpha = bg.op;
  ctx.translate(W / 2, H / 2);
  if (rot) ctx.rotate(rot * Math.PI / 180);
  if (bg.flip) ctx.scale(-1, 1);
  ctx.drawImage(img, -img.naturalWidth * sc / 2, -img.naturalHeight * sc / 2, img.naturalWidth * sc, img.naturalHeight * sc);
  ctx.restore();
}

// Logo scaled to fit a box, centred on (cx, cy).
/* Big pictures drawn small (logos, stickers): shrunk in halves first and kept, so they stay sharp instead of
   jagged and shimmering, which a single big step down gives. Cached per picture and size (in steps of 16 px). */
const _hq = new WeakMap();
function reelHQ(img, w) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; if (!iw || !w || w * 1.6 >= iw) return img;
  let m = _hq.get(img); if (!m) _hq.set(img, m = new Map());
  const tw = Math.max(16, Math.ceil(w / 16) * 16); if (m.has(tw)) return m.get(tw);
  let src = img, cw = iw, ch = ih;
  while (cw / 2 >= tw) { const c = document.createElement('canvas'); c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
    const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height); src = c; cw = c.width; ch = c.height; }
  if (m.size > 12) m.clear(); m.set(tw, src); return src;
}
function drawLogo(ctx, img, cx, cy, maxW, maxH) {
  const sc = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
  const w = img.naturalWidth * sc, h = img.naturalHeight * sc;
  ctx.drawImage(reelHQ(img, w), cx - w / 2, cy - h / 2, w, h);
}

/* o: { font, look, upto } for captions. look: outline (default) | shadow | box | neon | plain | accent box.
   upto: how many characters show (typewriter). */
function textBlock(ctx, s, lines, x, y, px, color, align = 'center', o = {}) {
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.font = reelFont(s, px, 700, o.font);
  ctx.lineJoin = 'round';
  let left = o.upto ?? Infinity;
  lines.forEach((ln0, i) => {
    const ln = left >= ln0.length ? ln0 : ln0.slice(0, Math.max(0, left)); left -= ln0.length + 1;
    if (!ln) return;
    const yy = y + i * px * 1.12, look = o.look || 'outline';
    ctx.save();
    if (look === 'box' || look === 'abox') {
      const w = ctx.measureText(ln0).width, pad = px * 0.28, bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      ctx.fillStyle = look === 'abox' ? s.accent : 'rgba(0,0,0,.72)';
      ctx.beginPath(); (ctx.roundRect ? ctx.roundRect(bx - pad, yy - px * 0.62, w + pad * 2, px * 1.2, px * 0.2) : ctx.rect(bx - pad, yy - px * 0.62, w + pad * 2, px * 1.2)); ctx.fill();
      ctx.fillStyle = look === 'abox' ? '#0b0d0e' : color; ctx.fillText(ln, x, yy);
    } else if (look === 'neon') {
      ctx.shadowColor = s.accent; ctx.shadowBlur = px * 0.5; ctx.fillStyle = color; ctx.fillText(ln, x, yy); ctx.shadowBlur = px * 0.2; ctx.fillText(ln, x, yy);
    } else if (look === 'shadow') {
      ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = px * 0.25; ctx.shadowOffsetY = px * 0.06; ctx.fillStyle = color; ctx.fillText(ln, x, yy);
    } else if (look === 'plain') {
      ctx.fillStyle = color; ctx.fillText(ln, x, yy);
    } else {
      ctx.lineWidth = px * 0.14; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(ln, x, yy);
      ctx.fillStyle = color; ctx.fillText(ln, x, yy);
    }
    ctx.restore();
  });
}
function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/), lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

function drawCard(ctx, s, W, H, p, kind) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0c0f10'); g.addColorStop(1, '#13181a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.8, H * 0.15, 0, W * 0.8, H * 0.15, W);
  glow.addColorStop(0, s.accent + '40'); glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  drawCardBg(ctx, kind === 'intro' ? s.introBg : s.outroBg, W, H);
  // Starts partly visible so a paused preview at 0:00 still shows the card.
  const k = Math.min(W, H) / 1080, ease = 1 - Math.pow(1 - Math.min(1, 0.3 + p * 2.2), 3);
  ctx.save();
  ctx.globalAlpha = ease;
  ctx.translate(0, (1 - ease) * 40 * k);
  const logo = s.cardLogo ? reelImg(reelLogoRef(s)) : null;
  if (logo) drawLogo(ctx, logo, W / 2, H * 0.25, W * 0.5, H * 0.16);
  // The text group (title, accent rule, handle) can be moved and scaled on the preview.
  const L = cardLayout(s, kind, W, H);
  ctx.translate(L.cx, L.cy); ctx.scale(L.sc, L.sc); ctx.translate(-W / 2, -L.baseY);
  // accent rule
  ctx.fillStyle = s.accent;
  ctx.fillRect(W / 2 - 90 * k * ease, H * 0.5 + 120 * k, 180 * k * ease, 6 * k);
  const studio = s.title || Settings.get('studio_name') || Settings.get('artist_name') || 'InkForge';
  if (kind === 'intro') {
    ctx.font = reelFont(s, 130 * k);
    textBlock(ctx, s, wrap(ctx, studio, W * 0.84), W / 2, H * 0.44, 130 * k, s.color);
    if (s.handle) textBlock(ctx, s, [s.handle], W / 2, H * 0.5 + 200 * k, 52 * k, s.accent);
  } else {
    ctx.font = reelFont(s, 150 * k);
    textBlock(ctx, s, wrap(ctx, s.outroText || 'Book now', W * 0.84), W / 2, H * 0.42, 150 * k, s.color);
    textBlock(ctx, s, [s.handle || studio], W / 2, H * 0.5 + 200 * k, 56 * k, s.accent);
  }
  ctx.restore();
}

/* ---------- Movable layers: caption, stickers, card text ----------
   Positions are normalised: x, y = centre as a fraction of width/height; s = scale (1 = default size).
   Layout functions return the on-canvas box { cx, cy, w, h } used for drawing and for hit-testing. */
function cardLayout(s, kind, W, H) {
  const k = Math.min(W, H) / 1080, pos = s[kind + 'Pos'];
  // Natural group: title centred near baseY, handle below; box spans both.
  // Natural extent (unscaled): from the top of the first title line to the handle line, or to the
  // accent rule when the intro has no handle. baseY is the middle of that, the group's anchor.
  const intro = kind === 'intro', px = (intro ? 130 : 150) * k;
  const top = (intro ? H * 0.44 : H * 0.42) - px * 0.6;
  const bottom = intro && !s.handle ? H * 0.5 + 126 * k : H * 0.5 + 200 * k + 32 * k;
  const baseY = (top + bottom) / 2, sc = pos?.s || 1;
  return { cx: (pos?.x ?? 0.5) * W, cy: (pos?.y ?? baseY / H) * H, sc, baseY, w: W * 0.84 * sc, h: (bottom - top) * sc };
}
function capLayout(ctx, s, c, W, H) {
  const k = Math.min(W, H) / 1080, sc = c.cap?.s || 1, px = (REEL_CAP_PX[s.capSize] || 78) * k * sc;
  ctx.font = reelFont(s, px, 700, c.capFont);
  const lines = wrap(ctx, c.caption, W * 0.84);
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)), h = lines.length * px * 1.12;
  // Default spot from Style › Text, kept clear of social app buttons (top ~12%, bottom ~22%).
  const def = s.captionPos === 'top' ? H * 0.15 + (lines.length - 1) * px * 0.56
    : s.captionPos === 'middle' ? H * 0.5 : H * 0.74 - (lines.length - 1) * px * 0.56;
  return { cx: (c.cap?.x ?? 0.5) * W, cy: c.cap ? c.cap.y * H : def, w, h, px, lines };
}
/* A sticker's picture, rebuilt from its file when the draft came back from undo or a saved reel (the Image itself
   is never saved). */
function reelStkImg(st) {
  if (st.img instanceof Image) return st.img;
  const img = new Image(); st.img = img;
  const go = (u) => { if (!u) return; img.onload = () => { if (!R.playing) reelRender(); }; img.src = u; st.url = u; };
  if (st.ref) Media.url(st.ref).then(go); else go(st.url);
  return img;
}
const _mctx = document.createElement('canvas').getContext('2d');
function stickerLayout(st, W, H) {
  if (st.text != null) return reelTextLayout(st, W, H);
  const img = reelStkImg(st), iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
  const w0 = Math.min(W, H) * 0.35 * st.s, w = w0 * (st.sx || 1), h = w0 * ih / iw * (st.sy || 1);
  return { cx: st.x * W, cy: st.y * H, w, h };
}
// Everything movable on the frame at R.t, topmost last. Used by the preview's drag handling.
function reelLayers(ctx, W, H) {
  const s = reelStyle(), { segs, total } = reelSegments();
  if (!segs.length) return { seg: null, list: [] };
  const seg = reelSegAt(segs, Math.min(R.t, total - 1e-3)), list = [];
  if (seg.kind === 'clip') {
    const c = seg.clip;
    if (c.caption) list.push({ id: 'cap', kind: 'cap', clip: c, box: capLayout(ctx, s, c, W, H) });
    const wm = wmLayout(s, W, H); if (wm) list.unshift({ id: 'wm', kind: 'wm', box: { cx: wm.cx, cy: wm.cy, w: wm.w, h: wm.h } });
  } else {
    const L = cardLayout(s, seg.kind, W, H);
    list.push({ id: 'card', kind: 'card', card: seg.kind, box: { cx: L.cx, cy: L.cy, w: L.w, h: L.h } });
  }
  const OV = R.ovl || [], holder = { stickers: OV };
  OV.forEach((st, i) => { if (R.t >= st.t0 && R.t < st.t1 && (st.text != null || reelStkImg(st).complete)) list.push({ id: 'stk' + i, kind: 'stk', i, clip: holder, box: stickerLayout(st, W, H) }); });
  return { seg, list };
}

/* The watermark's box. Old styles kept a corner (wmPos); that corner is the starting place until it is dragged. */
function wmLayout(s, W, H) {
  if (s.wmMode === 'off') return null;
  const k = Math.min(W, H) / 1080, m = 40 * k, sc = s.wmXY?.s || 1, logo = s.wmMode === 'logo' ? reelImg(reelLogoRef(s)) : null;
  let w, h;
  if (logo) { const f = Math.min(200 * k / logo.naturalWidth, 120 * k / logo.naturalHeight) * sc; w = logo.naturalWidth * f; h = logo.naturalHeight * f; }
  else if (s.handle) { _mctx.font = `600 ${34 * k * sc}px Inter, sans-serif`; w = _mctx.measureText(s.handle).width; h = 40 * k * sc; }
  else return null;
  const c = s.wmPos || 'br', right = c[1] !== 'l', top = c[0] === 't';
  const dx = right ? W - m - w / 2 : m + w / 2, dy = top ? H * 0.13 + h / 2 : H * 0.8 - h / 2;
  return { cx: s.wmXY ? s.wmXY.x * W : dx, cy: s.wmXY ? s.wmXY.y * H : dy, w, h, logo, sc };
}
function drawWatermark(ctx, s, W, H) {
  const L = wmLayout(s, W, H); if (!L) return;
  const k = Math.min(W, H) / 1080;
  ctx.save(); ctx.globalAlpha = s.wmOp; ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 9 * k;
  if (L.logo) ctx.drawImage(reelHQ(L.logo, L.w), L.cx - L.w / 2, L.cy - L.h / 2, L.w, L.h);
  else { ctx.font = `600 ${34 * k * L.sc}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(s.handle, L.cx, L.cy); }
  ctx.restore();
}

// One segment as it looks `local` seconds in: the clip (with caption and watermark) or a card.
function drawSeg(ctx, s, W, H, seg, local) {
  const p = Math.min(1, local / seg.dur);
  if (seg.kind !== 'clip') return drawCard(ctx, s, W, H, p, seg.kind);
  const c = seg.clip;
  ctx.save(); reelFxPre(ctx, c, W, H, local); drawMedia(ctx, c, W, H, p); ctx.restore();
  reelFxPost(ctx, s, c, W, H, local);
  for (const st of c.stickers || []) reelStkDraw(ctx, s, st, W, H, local, seg.dur);
  if (c.caption) {
    const k = Math.min(W, H) / 1080, L = capLayout(ctx, s, c, W, H), an = R.dragging ? 'none' : c.capAnim || 'fade';
    const q = an === 'none' ? 1 : Math.min(1, local / (an === 'type' ? Math.max(0.4, c.caption.length * 0.05) : 0.35)), e = 1 - Math.pow(1 - q, 3);
    let y0 = L.cy - (L.lines.length - 1) * L.px * 0.56, sc = 1, a = 1, upto;
    if (an === 'fade') { a = q; y0 += (1 - q) * 20 * k; }
    else if (an === 'slide') { y0 += (1 - e) * 140 * k; a = q; }
    else if (an === 'pop') sc = q < 1 ? 0.4 + 0.75 * e - 0.15 * Math.sin(q * Math.PI) : 1;
    else if (an === 'bounce') { y0 -= Math.abs(Math.sin(q * Math.PI * 2.5)) * (1 - q) * 80 * k; a = Math.min(1, q * 3); }
    else if (an === 'type') upto = Math.floor(q * c.caption.length);
    const out = c.capOut && seg.dur - local < 0.3 ? Math.max(0, (seg.dur - local) / 0.3) : 1;   /* fades away at the end of the clip */
    ctx.save(); ctx.globalAlpha = a * out;
    if (sc !== 1) { ctx.translate(L.cx, L.cy); ctx.scale(sc, sc); ctx.translate(-L.cx, -L.cy); }
    textBlock(ctx, s, L.lines, L.cx, y0, L.px, c.capColor || s.color, 'center', { font: c.capFont, look: c.capLook, upto });
    ctx.restore();
  }
  drawWatermark(ctx, s, W, H);
}

function reelDraw(ctx, W, H, t) {
  const s = reelStyle(), { segs, total } = reelSegments();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';   /* the default is low, which blurs and jags scaled pictures */
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!segs.length) return;
  const seg = reelSegAt(segs, Math.min(t, total - 1e-3));
  const local = Math.max(0, t - seg.start);
  const i = segs.indexOf(seg), prev = segs[i - 1], next = segs[i + 1], left = seg.dur - local;
  // Each boundary has its own transition: tIn (prev -> seg) and tOut (seg -> next).
  const tIn = prev && reelTrans(s, seg), tOut = next && reelTrans(s, next);
  // Never longer than half of either neighbouring segment, so short clips still show.
  const T = (o, tr) => Math.max(0.05, Math.min(tr.dur, seg.dur / 2, o.dur / 2));
  // Wipe and slide show the next segment coming in over the last moments of this one,
  // from the chosen side. (dx, dy) points from where the new clip starts towards the centre.
  if (tOut && REEL_OVER.includes(tOut.type) && left < T(next, tOut)) {
    const q = 1 - Math.pow(left / T(next, tOut), 2), lin = 1 - left / T(next, tOut);
    const d = trVariant(tOut), dx = d === 'left' ? 1 : d === 'right' ? -1 : 0, dy = d === 'top' ? 1 : d === 'bottom' ? -1 : 0;
    if (tOut.type === 'dissolve') {
      drawSeg(ctx, s, W, H, seg, local);
      ctx.save(); ctx.globalAlpha = lin; drawSeg(ctx, s, W, H, next, 0); ctx.restore(); reelProgress(ctx, s, W, H, t); return;
    }
    if (tOut.type === 'iris' || tOut.type === 'heart' || tOut.type === 'doors') {
      drawSeg(ctx, s, W, H, seg, local);
      ctx.save(); ctx.beginPath();
      if (tOut.type === 'iris') ctx.arc(W / 2, H / 2, Math.hypot(W, H) / 2 * q, 0, 7);
      else if (tOut.type === 'doors') { if (d === 'top' || d === 'bottom') ctx.rect(0, H / 2 * (1 - q), W, H * q); else ctx.rect(W / 2 * (1 - q), 0, W * q, H); }
      else { const r = H * 1.1 * q, cx = W / 2, cy = H / 2 - r * 0.15;   /* a heart opening from the middle */
        ctx.moveTo(cx, cy + r * 0.7); ctx.bezierCurveTo(cx + r, cy, cx + r * 0.55, cy - r * 0.6, cx, cy - r * 0.2); ctx.bezierCurveTo(cx - r * 0.55, cy - r * 0.6, cx - r, cy, cx, cy + r * 0.7); }
      ctx.clip(); drawSeg(ctx, s, W, H, next, 0); ctx.restore(); reelProgress(ctx, s, W, H, t); return;
    }
    if (tOut.type === 'whip') {   /* a fast blurred pan */
      const blur = Math.sin(lin * Math.PI) * 26 * Math.min(W, H) / 1080, ddx = d === 'right' ? -1 : 1;
      ctx.save(); if (canFilter) ctx.filter = `blur(${blur}px)`;
      ctx.translate(ddx * W * q, 0); drawSeg(ctx, s, W, H, seg, local); ctx.translate(-ddx * W, 0); drawSeg(ctx, s, W, H, next, 0); ctx.restore(); reelProgress(ctx, s, W, H, t); return;
    }
    if (tOut.type === 'slide') {
      ctx.save(); ctx.translate(dx * W * q, dy * H * q); drawSeg(ctx, s, W, H, seg, local); ctx.restore();
      ctx.save(); ctx.translate(-dx * W * (1 - q), -dy * H * (1 - q)); drawSeg(ctx, s, W, H, next, 0); ctx.restore();
    } else {
      drawSeg(ctx, s, W, H, seg, local);
      const k = Math.min(W, H) / 1080;
      // Revealed area grows from the chosen edge; a thin accent line rides the edge.
      const r = dx > 0 ? [0, 0, W * q, H] : dx < 0 ? [W * (1 - q), 0, W * q, H] : dy > 0 ? [0, 0, W, H * q] : [0, H * (1 - q), W, H * q];
      ctx.save(); ctx.beginPath(); ctx.rect(...r); ctx.clip(); drawSeg(ctx, s, W, H, next, 0); ctx.restore();
      ctx.fillStyle = s.accent;
      if (dx) ctx.fillRect((dx > 0 ? W * q : W * (1 - q)) - 3 * k, 0, 6 * k, H);
      else ctx.fillRect(0, (dy > 0 ? H * q : H * (1 - q)) - 3 * k, W, 6 * k);
    }
    reelProgress(ctx, s, W, H, t);
    return;
  }
  // Dip-style transitions ramp in after the boundary before this segment and out before the next.
  // Each side uses its own boundary's type, so a fade-in can follow a flash-out.
  const amt = { fade: 0, flash: 0, zoom: 0, spin: 0, blur: 0, glitch: 0 }, vr = {};
  const dip = (tr, a) => { if (a > amt[tr.type]) { amt[tr.type] = a; vr[tr.type] = trVariant(tr); } };
  if (tIn && REEL_DIPS.includes(tIn.type) && local < T(prev, tIn)) dip(tIn, 1 - local / T(prev, tIn));
  if (tOut && REEL_DIPS.includes(tOut.type) && left < T(next, tOut)) dip(tOut, 1 - left / T(next, tOut));
  ctx.save();
  if (amt.zoom) {
    // In: punch towards the viewer. Out: the frame shrinks away into black.
    const z = vr.zoom === 'out' ? 1 - amt.zoom * 0.22 : 1 + amt.zoom * 0.18;
    ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);
  }
  if (amt.spin) { const sd = vr.spin === 'left' ? -1 : 1, z = 1 + amt.spin * 0.6; ctx.translate(W / 2, H / 2); ctx.rotate(sd * amt.spin * Math.PI * 0.5); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2); }
  if (amt.blur && canFilter) ctx.filter = `blur(${amt.blur * 30 * Math.min(W, H) / 1080}px)`;
  drawSeg(ctx, s, W, H, seg, local);
  ctx.restore();
  if (amt.glitch > 0.05) {
    const k = Math.min(W, H) / 1080, f = Math.floor(t * 30);
    for (let i = 0; i < 8; i++) { const y = reelRnd(f + i) * H, h = (8 + reelRnd(f + i * 7) * 90) * k, dx = (reelRnd(f + i * 3) - 0.5) * 200 * k * amt.glitch;
      ctx.drawImage(ctx.canvas, 0, y * ctx.canvas.height / H, ctx.canvas.width, h * ctx.canvas.height / H, dx, y, W, h); }
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = amt.glitch * 0.5; ctx.fillStyle = '#ff0050'; ctx.fillRect(0, reelRnd(f) * H, W, 30 * k); ctx.fillStyle = '#00e0ff'; ctx.fillRect(0, reelRnd(f + 1) * H, W, 20 * k); ctx.restore();
  }
  reelProgress(ctx, s, W, H, t);
  if (amt.fade) { ctx.fillStyle = vr.fade === 'white' ? `rgba(255,255,255,${amt.fade})` : `rgba(0,0,0,${amt.fade})`; ctx.fillRect(0, 0, W, H); }
  if (amt.flash) {
    ctx.save(); ctx.globalAlpha = amt.flash * 0.85;
    ctx.fillStyle = vr.flash === 'accent' ? s.accent : '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
}

/* Sticker entrances (st.anim) and looping effects (st.fx: float, pulse, spin, wiggle, shadow, glow), opacity st.op,
   turn st.rot (degrees). Entrances take 0.5 s from the start of the clip, or from st.at seconds in. */
const REEL_STK_ANIMS = [['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['zoom', 'Zoom'], ['slide', 'Slide up'], ['drop', 'Drop'], ['spin', 'Spin'], ['bounce', 'Bounce'], ['type', 'Typewriter']];
/* Directions for entrances (st.adir) and moving effects (st.spinDir, st.floatDir): [value, label]. */
const REEL_STK_DIRS = { slide: [['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→']], drop: [['top', 'From top'], ['bottom', 'From bottom'], ['left', 'From left'], ['right', 'From right']],
  spin: [['cw', '↻'], ['ccw', '↺']], zoom: [['in', 'From big'], ['out', 'From small']] };
const REEL_STK_FX = [['float', 'Float'], ['pulse', 'Pulse'], ['spin', 'Spin'], ['wiggle', 'Wiggle'], ['shadow', 'Shadow'], ['glow', 'Glow']];
function reelStkDraw(ctx, s, st, W, H, local, dur) {
  const img = st.text == null ? reelStkImg(st) : null;
  if (img && (!img.complete || !img.naturalWidth)) return;
  const b = stickerLayout(st, W, H), k = Math.min(W, H) / 1080, an = R.dragging ? 'none' : st.anim || 'none', fx = st.fx || [];
  const lt = local - (st.at || 0); if (lt < 0 && an !== 'none') return;
  const ad = st.animDur || 0.5, tl = String(st.text || '').length, span = an === 'type' ? Math.max(0.4, tl * 0.05) * ad / 0.5 : ad;   /* animDur: how long it takes to appear */
  let q = an === 'none' ? 1 : Math.min(1, lt / span);
  if (st.exit && an !== 'none') q = Math.min(q, Math.max(0, (dur - local) / span));   /* the same entrance played backwards to leave */
  const e = 1 - Math.pow(1 - q, 3), dir = st.adir;
  let a = st.op ?? 1, sc = 1, rot = (st.rot || 0) * Math.PI / 180, dx = 0, dy = 0, upto;
  if (an === 'type') upto = Math.floor(q * tl);
  if (st.out && dur - local < 0.3) a *= Math.max(0, (dur - local) / 0.3);   /* fades away at the end of the clip */
  if (an === 'fade') a *= q; else if (an === 'pop') sc = q < 1 ? 0.3 + 0.85 * e - 0.15 * Math.sin(q * Math.PI) : 1;
  else if (an === 'zoom') { sc = dir === 'out' ? 0.15 + 0.85 * e : 2.4 - 1.4 * e; a *= q; }
  else if (an === 'slide') { const m = (1 - e) * 220 * k; if (dir === 'down') dy = -m; else if (dir === 'left') dx = m; else if (dir === 'right') dx = -m; else dy = m; a *= q; }
  else if (an === 'drop') { if (dir === 'bottom') dy = (1 - e) * H * 0.6; else if (dir === 'left') dx = -(1 - e) * W * 0.6; else if (dir === 'right') dx = (1 - e) * W * 0.6; else dy = -(1 - e) * H * 0.6; }
  else if (an === 'spin') { rot += (dir === 'ccw' ? -1 : 1) * (1 - e) * Math.PI * 2; sc = e; }
  else if (an === 'bounce') { dy = -Math.abs(Math.sin(q * Math.PI * 2.5)) * (1 - q) * 120 * k; a *= Math.min(1, q * 3); }
  const lf = local * (st.fxSpeed || 1);   /* fxSpeed: how fast the effects move */
  if (fx.includes('float')) { const f = Math.sin(lf * 2.2 + st.x * 9) * 12 * k; if (st.floatDir === 'x') dx += f; else dy += f; }
  if (fx.includes('pulse')) sc *= 1 + 0.06 * Math.sin(lf * Math.PI * 3);
  if (fx.includes('spin')) rot += (st.spinDir === 'ccw' ? -1 : 1) * lf * Math.PI;
  if (fx.includes('wiggle')) rot += Math.sin(lf * 9) * 0.12;
  ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, a));
  ctx.translate(b.cx + dx, b.cy + dy); ctx.rotate(rot); ctx.scale(sc, sc);
  if (fx.includes('shadow')) { ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 24 * k; ctx.shadowOffsetY = 8 * k; }
  if (fx.includes('glow')) { ctx.shadowColor = s.accent; ctx.shadowBlur = 36 * k; }
  if (st.flip) ctx.scale(-1, 1);
  if (st.text != null) reelTextDraw(ctx, s, st, b, upto, local);
  else ctx.drawImage(reelHQ(img, b.w * sc), -b.w / 2, -b.h / 2, b.w, b.h);
  ctx.restore();
}
/* The selected sticker's handles in canvas pixels: 4 corners (size), 4 sides (stretch, pictures only) and the
   turn knob above. Each has local unit offsets (ux, uy) used to read a drag back in the sticker's own frame. */
function reelHandles(b, st, k) {
  const a = (st.rot || 0) * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), hw = b.w / 2 + 4 * k, hh = b.h / 2 + 4 * k, out = [];
  const at = (lx, ly, kind, ux, uy) => out.push({ kind, ux, uy, x: b.cx + lx * cs - ly * sn, y: b.cy + lx * sn + ly * cs });
  for (const [ux, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) at(ux * hw, uy * hh, 'corner', ux, uy);
  if (st.text == null) for (const [ux, uy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) at(ux * hw, uy * hh, 'side', ux, uy);
  else if (st.box) for (const ux of [1, -1]) at(ux * hw, 0, 'side', ux, 0);   /* a paragraph frame: sides set its width */
  at(0, -hh - 30 * k, 'rot', 0, -1);
  return out;
}
/* ---------- Text layers ----------
   Heading: one block, as wide as its words. Paragraph (st.box): a frame st.bw of the frame's width that wraps.
   Options: bold (st.bold, default on), italic (st.ital), align (st.align), line spacing (st.lh), letter spacing (st.ls, in
   em), padding for boxed looks (st.pad, in em), outline colour and width (st.oc, st.ow), and a shape (st.shape: arc, circle,
   wave, rise, with st.amt). */
const REEL_TXT_SHAPES = [['none', 'Straight'], ['arc', 'Arc'], ['circle', 'Circle'], ['wave', 'Wave'], ['rise', 'Rise'], ['bulge', 'Bulge']];
const reelTxtFont = (st, px) => { const f = reelFont(reelStyle(), px, st.bold === false ? 400 : 700, st.font); return st.ital ? 'italic ' + f : f; };
function reelTxtWrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    if (!para) { out.push(''); continue; }
    let cur = '';
    for (const w of para.split(/\s+/)) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t; }
    out.push(cur);
  }
  return out.length ? out : [''];
}
function reelTextLayout(st, W, H) {
  const k = Math.min(W, H) / 1080, px = 72 * k * (st.s || 1), lh = px * (st.lh || 1.12), ls = (st.ls || 0) * px;
  _mctx.font = reelTxtFont(st, px); if ('letterSpacing' in _mctx) _mctx.letterSpacing = ls + 'px';
  const boxed = st.look === 'box' || st.look === 'abox', pad = boxed ? (st.pad ?? 0.28) * px : 0;
  const lines = st.box ? reelTxtWrap(_mctx, st.text, Math.max(40 * k, (st.bw || 0.7) * W - pad * 2)) : String(st.text || ' ').split('\n');
  const widths = lines.map(l => _mctx.measureText(l).width);
  let w = st.box ? (st.bw || 0.7) * W : Math.max(20 * k, ...widths) + pad * 2 + px * 0.3, h = lines.length * lh + pad * 2 + px * 0.2;
  const sh = st.shape || 'none', amt = st.amt ?? 50;
  if (sh === 'circle') { const r = Math.max(...widths) / (2 * Math.PI) + px * 0.6; w = h = 2 * r + px * 1.4; }
  else if (sh === 'arc') h += Math.abs(amt) / 100 * w * 0.35;
  else if (sh === 'wave') h += Math.abs(amt) / 100 * px * 1.2;
  else if (sh === 'rise' || sh === 'bulge') h += Math.abs(amt) / 100 * px * 0.8;
  if ('letterSpacing' in _mctx) _mctx.letterSpacing = '0px';
  return { cx: st.x * W, cy: st.y * H, w, h, px, lh, ls, pad, lines, widths, k };
}
// One letter of shaped text, with the layer's look.
function reelTxtGlyph(ctx, s, st, ch, x, y, rot, sy, color, px) {
  ctx.save(); ctx.translate(x, y); if (rot) ctx.rotate(rot); if (sy && sy !== 1) ctx.scale(1, sy);
  const look = st.look || 'outline';
  if (look === 'outline') { ctx.lineWidth = px * (st.ow ?? 0.14); ctx.strokeStyle = st.oc || 'rgba(0,0,0,.75)'; ctx.strokeText(ch, 0, 0); }
  else if (look === 'shadow') { ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = px * 0.25; ctx.shadowOffsetY = px * 0.06; }
  else if (look === 'neon') { ctx.shadowColor = s.accent; ctx.shadowBlur = px * 0.5; }
  ctx.fillStyle = color; ctx.fillText(ch, 0, 0); ctx.restore();
}
function reelTextDraw(ctx, s, st, L, upto, local = 0) {
  const { px, lh, ls, pad, lines, widths } = L, color = st.color || s.color, look = st.look || 'outline', sh = st.shape || 'none', amt = st.amt ?? 50;
  ctx.font = reelTxtFont(st, px); ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const al = st.align || 'center', boxed = look === 'box' || look === 'abox';
  let left = upto ?? Infinity;
  const y0 = -(lines.length - 1) * lh / 2;
  // straight text: whole lines (fast, kerning kept)
  if (sh === 'none') {
    if ('letterSpacing' in ctx) ctx.letterSpacing = ls + 'px';
    const innerW = L.w - pad * 2 - (st.box ? 0 : px * 0.3), xa = al === 'left' ? -innerW / 2 : al === 'right' ? innerW / 2 : 0;
    ctx.textAlign = al;
    lines.forEach((ln0, i) => {
      const ln = left >= ln0.length ? ln0 : ln0.slice(0, Math.max(0, left)); left -= ln0.length + 1; if (!ln) return;
      const y = y0 + i * lh;
      if (boxed) { const w = widths[i], bx = al === 'left' ? xa : al === 'right' ? xa - w : -w / 2;
        ctx.save(); ctx.fillStyle = look === 'abox' ? s.accent : 'rgba(0,0,0,.72)'; ctx.beginPath(); const r = [bx - pad, y - lh / 2 - pad * 0.15, w + pad * 2, lh + pad * 0.3];
        ctx.roundRect ? ctx.roundRect(...r, px * 0.2) : ctx.rect(...r); ctx.fill(); ctx.restore(); }
      ctx.save();
      if (look === 'outline') { ctx.lineWidth = px * (st.ow ?? 0.14); ctx.strokeStyle = st.oc || 'rgba(0,0,0,.75)'; ctx.strokeText(ln, xa, y); }
      else if (look === 'shadow') { ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = px * 0.25; ctx.shadowOffsetY = px * 0.06; }
      else if (look === 'neon') { ctx.shadowColor = s.accent; ctx.shadowBlur = px * 0.5; ctx.fillStyle = color; ctx.fillText(ln, xa, y); ctx.shadowBlur = px * 0.2; }
      ctx.fillStyle = look === 'abox' ? '#0b0d0e' : color; ctx.fillText(ln, xa, y); ctx.restore();
    });
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    return;
  }
  // shaped text: letter by letter
  ctx.textAlign = 'center';
  const fill = look === 'abox' ? s.accent : color;
  lines.forEach((ln0, li) => {
    const chars = [...ln0], ws = chars.map(c => ctx.measureText(c).width + ls), tw = ws.reduce((a, b) => a + b, 0) - ls, yL = y0 + li * lh;
    let x = -tw / 2;
    if (sh === 'arc' || sh === 'circle') {
      const A = sh === 'circle' ? Math.PI * 2 * 0.999 : Math.max(0.01, Math.abs(amt) / 100 * Math.PI * 1.6), up = sh === 'circle' || amt >= 0;
      const r = (sh === 'circle' ? tw / A + px * 0.25 : tw / A), dir = up ? 1 : -1, cy = yL + dir * r;
      chars.forEach((c, i) => { if (left-- <= 0) return; const mid = x + ws[i] / 2 - ls / 2; x += ws[i];
        const th = mid / r; reelTxtGlyph(ctx, s, st, c, Math.sin(th) * r, cy - dir * Math.cos(th) * r, dir * th, 1, fill, px); });
    } else {
      chars.forEach((c, i) => { if (left-- <= 0) return; const mid = x + ws[i] / 2 - ls / 2; x += ws[i]; const f = tw ? (mid + tw / 2) / tw : 0.5;
        let dy = 0, rot = 0, sy = 1;
        if (sh === 'wave') { const ph = st.waveMove ? local * 4 : 0; dy = Math.sin(f * Math.PI * 2 * 1.5 + ph) * amt / 100 * px * 0.6; rot = Math.cos(f * Math.PI * 3 + ph) * amt / 100 * 0.25; }
        else if (sh === 'rise') { dy = -(f - 0.5) * amt / 100 * px * 0.8; sy = 1 + (f - 0.5) * amt / 100 * 0.8; }
        else if (sh === 'bulge') { const b = Math.sin(f * Math.PI); sy = 1 + b * amt / 100 * 0.7; }
        reelTxtGlyph(ctx, s, st, c, mid, yL + dy, rot, sy, fill, px); });
    }
    left--;
  });
}
// A thin bar along the top filling as the reel plays (Style › Brand › Progress bar).
function reelProgress(ctx, s, W, H, t) {
  for (const o of R.ovl || []) if (t >= o.t0 && t < o.t1) reelStkDraw(ctx, s, o, W, H, t - o.t0, o.t1 - o.t0);   /* text and stickers sit on top */
  if (!s.progress) return; const { total } = reelSegments(); if (!total) return;
  const k = Math.min(W, H) / 1080; ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(0, 0, W, 8 * k);
  ctx.fillStyle = s.accent; ctx.fillRect(0, 0, W * Math.min(1, t / total), 8 * k); ctx.restore();
}
// Editing aids on the preview only (never recorded): selection box, resize handle, snap guides.
function reelDrawOverlay(ctx, W, H) {
  if (R.recording || R.watching || !R.layer) return;
  const { list } = reelLayers(ctx, W, H), o = list.find(x => x.id === R.layer);
  if (!o) return;
  const b = o.box, k = Math.max(Math.min(W, H) / 540, R.pxk || 0);   /* handles keep their size on screen, however small the preview */
  if (o.kind === 'stk') {   /* turned box with the design studio's handles */
    const st = o.clip.stickers[o.i], hs = reelHandles(b, st, k);
    ctx.save(); ctx.translate(b.cx, b.cy); ctx.rotate((st.rot || 0) * Math.PI / 180);
    ctx.strokeStyle = '#1fb5a8'; ctx.lineWidth = 1.5 * k; ctx.setLineDash([6 * k, 4 * k]); ctx.strokeRect(-b.w / 2 - 4 * k, -b.h / 2 - 4 * k, b.w + 8 * k, b.h + 8 * k); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(0, -b.h / 2 - 4 * k); ctx.lineTo(0, -b.h / 2 - 34 * k); ctx.stroke(); ctx.restore();
    for (const h of hs) { ctx.beginPath(); ctx.fillStyle = h.kind === 'rot' ? '#f0c75e' : '#fff'; ctx.strokeStyle = '#1fb5a8'; ctx.lineWidth = 1.5 * k;
      if (h.kind === 'rot') ctx.arc(h.x, h.y, 7 * k, 0, 7); else ctx.rect(h.x - 5 * k, h.y - 5 * k, 10 * k, 10 * k); ctx.fill(); ctx.stroke(); }
    ctx.save(); ctx.strokeStyle = '#f0c75e'; ctx.lineWidth = 1.5 * k;
    for (const g of R.guides || []) { ctx.beginPath(); if (g.x != null) { ctx.moveTo(g.x, 0); ctx.lineTo(g.x, H); } else { ctx.moveTo(0, g.y); ctx.lineTo(W, g.y); } ctx.stroke(); }
    ctx.restore(); return;
  }
  ctx.save();
  ctx.strokeStyle = '#1fb5a8'; ctx.lineWidth = 2 * k; ctx.setLineDash([6 * k, 4 * k]);
  ctx.strokeRect(b.cx - b.w / 2 - 6 * k, b.cy - b.h / 2 - 6 * k, b.w + 12 * k, b.h + 12 * k);
  ctx.setLineDash([]);
  ctx.fillStyle = '#1fb5a8'; ctx.strokeStyle = '#fff';
  ctx.beginPath(); ctx.arc(b.cx + b.w / 2 + 6 * k, b.cy + b.h / 2 + 6 * k, 11 * k, 0, 7); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = '#f0c75e'; ctx.lineWidth = 1.5 * k;
  for (const g of R.guides || []) {
    ctx.beginPath();
    if (g.x != null) { ctx.moveTo(g.x, 0); ctx.lineTo(g.x, H); } else { ctx.moveTo(0, g.y); ctx.lineTo(W, g.y); }
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------- Video sync ---------- */
function reelSyncVideos(t, playing) {
  const { segs } = reelSegments();
  const seg = reelSegAt(segs, t);
  const nextSeg = segs[segs.indexOf(seg) + 1];
  const activeEl = seg?.kind === 'clip' ? seg.clip.el : null;
  for (const c of R.clips) {
    if (c.type !== 'video') continue;
    const active = seg && seg.kind === 'clip' && seg.clip === c;
    if (!active) {
      if (c.el === activeEl) continue;   // split/duplicated clips share one video element
      if (!c.el.paused) c.el.pause();
      // Park the upcoming clip on its first frame so wipe/slide transitions show it.
      if (nextSeg?.clip === c && Math.abs(c.el.currentTime - c.inP) > 0.1) c.el.currentTime = c.inP;
      continue;
    }
    c.el.playbackRate = c.speed || 1;
    const want = c.inP + (t - seg.start) * (c.speed || 1);
    if (playing) {
      if (Math.abs(c.el.currentTime - want) > 0.3) c.el.currentTime = want;
      if (c.el.paused) c.el.play().catch(() => {});
    } else {
      if (!c.el.paused) c.el.pause();
      if (Math.abs(c.el.currentTime - want) > 0.04) c.el.currentTime = want;
    }
    if (c.gain) c.gain.gain.value = c.mute ? 0 : (c.vol ?? 1);
  }
}

/* ---------- Audio ---------- */
function reelAudio() {
  if (R.actx) { if (R.actx.state === 'suspended') R.actx.resume(); return R.actx; }
  R.actx = new (window.AudioContext || window.webkitAudioContext)();
  R.master = R.actx.createGain();
  R.master.connect(R.actx.destination);
  for (const c of R.clips) reelHookClipAudio(c);
  return R.actx;
}
function reelHookClipAudio(c) {
  if (!R.actx || c.type !== 'video' || c.gain) return;
  try {
    const src = R.actx.createMediaElementSource(c.el);
    c.gain = R.actx.createGain(); c.gain.gain.value = c.mute ? 0 : (c.vol ?? 1);
    src.connect(c.gain).connect(R.master);
  } catch (e) { console.warn('Clip audio unavailable', e); }
}
/* Sound: every track on its own row and time (R.aud). Each plays from t0 for len seconds, from off seconds into the
   file, with its own fade in and out, so two overlapping tracks cross-fade. */
function reelMusicStart(t) {
  reelMusicStop();
  if (!R.actx) return;
  const now = R.actx.currentTime;
  for (const a of R.aud || []) {
    if (!a.buffer || t >= a.t0 + a.len) continue;
    const into = Math.max(0, t - a.t0), S = now + (a.t0 - t), fi = Math.min(a.fadeIn || 0, a.len / 2), fo = Math.min(a.fadeOut ?? 1, a.len / 2), v = a.vol ?? 0.8;
    const env = (x) => v * Math.min(1, fi ? x / fi : 1, fo ? (a.len - x) / fo : 1);
    const n = R.actx.createBufferSource(), g = R.actx.createGain(), rate = a.rate || 1; n.buffer = a.buffer; n.playbackRate.value = rate; n.connect(g).connect(R.master);
    g.gain.setValueAtTime(Math.max(0, env(into)), Math.max(now, S));
    if (fi && S + fi > now) g.gain.linearRampToValueAtTime(v, S + fi);
    if (fo) { if (S + a.len - fo > now) g.gain.setValueAtTime(v, S + a.len - fo); g.gain.linearRampToValueAtTime(0, S + a.len); }
    const off = Math.min(a.buffer.duration - 0.01, (a.off || 0) + into * rate);   /* sped up: the song moves faster than the reel */
    n.start(Math.max(now, S), off, Math.max(0.01, (a.len - into) * rate)); R.audNodes.push(n);
  }
}
function reelMusicStop() { for (const n of R.audNodes || []) { try { n.stop(); } catch {} } R.audNodes = []; }

/* ---------- Playback ---------- */
function reelCanvas() { return document.getElementById('reel-cv'); }
function reelRender() {
  const cv = reelCanvas(); if (!cv) return;
  reelDraw(cv.getContext('2d'), cv.width, cv.height, R.t);
  if (!R.playing) reelDrawOverlay(cv.getContext('2d'), cv.width, cv.height);
  const { total } = reelSegments();
  const sc = document.getElementById('reel-scrub'), tm = document.getElementById('reel-time');
  if (sc && !R.scrubbing) { sc.max = total || 0; sc.value = R.t; }
  if (tm) tm.textContent = `${R.t.toFixed(1)} / ${total.toFixed(1)}s`;
  if (typeof reelTlHead === 'function') reelTlHead();
}
function reelPlay() {
  const { total } = reelSegments();
  if (!total) return;
  reelAudio();
  if (R.t >= total - 0.05) R.t = 0;
  R.playing = true; R.t0 = performance.now() - R.t * 1000;
  reelMusicStart(R.t);
  const tick = () => {
    if (!R.playing) return;
    R.t = (performance.now() - R.t0) / 1000;
    if (R.t >= total) { R.t = total; reelPause(); if (R.onEnd) R.onEnd(); return; }
    reelSyncVideos(R.t, true);
    reelRender();
    R.raf = requestAnimationFrame(tick);
  };
  R.raf = requestAnimationFrame(tick);
  reelPlayBtn();
}
function reelPause() {
  R.playing = false; cancelAnimationFrame(R.raf);
  reelMusicStop(); reelSyncVideos(R.t, false); reelRender(); reelPlayBtn();
}
function reelPlayBtn() {
  const b = document.getElementById('reel-play'); if (!b) return;
  b.innerHTML = R.playing ? '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>';
}

/* A clip copy (split or duplicate) gets its own video element on the same file, so both can show their own frame at
   once: a transition between two halves of a split shows each one correctly. */
function reelOwnVideo(c) {
  if (c.type !== 'video') return c;
  const v = document.createElement('video'); v.src = c.url; v.muted = false; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
  v.addEventListener('seeked', () => { if (!R.playing) reelRender(); });
  c.el = v; delete c.gain; reelHookClipAudio(c); return c;
}

/* ---------- Adding clips ---------- */
async function reelAddFile(file, keep = true) {
  const url = URL.createObjectURL(file);
  const c = { id: ++R.seq, name: file.name, url, motion: 'in', fit: 'cover', caption: '', mute: true, filter: 'none', speed: 1, rot: 0, flip: false };
  if (file.type.startsWith('video')) {
    const v = document.createElement('video');
    v.src = url; v.muted = false; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Unsupported video')); });
    if (!isFinite(v.duration)) {   // some recordings (e.g. WebM) don't state their length: seek past the end to find it
      await new Promise(res => { v.ondurationchange = () => { if (isFinite(v.duration)) res(); }; v.currentTime = 1e7; setTimeout(res, 3000); });
      v.ondurationchange = null; v.currentTime = 0; await new Promise(res => { v.onseeked = res; setTimeout(res, 1000); }); v.onseeked = null;
      if (!isFinite(v.duration)) throw new Error('Could not read the video’s length');
    }
    Object.assign(c, { type: 'video', el: v, w: v.videoWidth, h: v.videoHeight, srcDur: v.duration, inP: 0, outP: Math.min(v.duration, 5), motion: 'none' });
    v.addEventListener('seeked', () => { if (!R.playing) reelRender(); });
    reelHookClipAudio(c);
    // Small still for the timeline (the first frame, tiled along the clip's length).
    try {
      const tc = document.createElement('canvas'); tc.height = 96; tc.width = Math.round(96 * c.w / c.h) || 54;
      tc.getContext('2d').drawImage(v, 0, 0, tc.width, tc.height); c.thumb = tc.toDataURL('image/jpeg', 0.7);
    } catch {}
  } else {
    const img = new Image(); img.src = url; await img.decode();
    Object.assign(c, { type: 'image', el: img, w: img.naturalWidth, h: img.naturalHeight, dur: 2.5, thumb: url });
  }
  R.clips.push(c);
  if (keep && typeof reelKeep === 'function') reelKeep(c, file);   // copied into the media folder, so the reel can be opened again
  return c;
}

/* ---------- Export ---------- */
function reelMime() {
  const opts = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return opts.find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

async function reelExport() {
  const { total } = reelSegments();
  if (!R.clips.length) return toast('Add at least one photo or video.');
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return toast('This browser cannot record video.');
  const s = reelStyle(), cv = reelCanvas();
  await Promise.all([s.font, ...R.clips.map(c => c.capFont).filter(Boolean)].map(k => reelFontLoad(k).then(() => document.fonts.load(reelFont(s, 40, 700, k))).catch(() => {})));
  reelPause();
  const [, , , w0, h0] = reelSize(R.ar), q = s.quality === '1080' ? 1 : 2 / 3, W = Math.round(w0 * q / 2) * 2, H = Math.round(h0 * q / 2) * 2;
  cv.width = W; cv.height = H;
  reelAudio();
  R.recDest = R.actx.createMediaStreamDestination();
  R.master.connect(R.recDest);
  const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...R.recDest.stream.getAudioTracks()]);
  const mime = reelMime();
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: s.quality === '1080' ? 16e6 : 9e6 });   /* fine detail (logos, line work) needs room */
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const overlay = document.createElement('div');
  overlay.id = 'reel-rec';
  overlay.innerHTML = `<div class="card"><h2>Recording reel</h2><p class="muted">Keep this screen open until it finishes (about ${Math.ceil(total)}s).</p>
    <div class="meter"><i id="reel-prog" style="width:0"></i></div><button class="btn" id="reel-cancel" style="margin-top:14px">Cancel</button></div>`;
  document.body.appendChild(overlay);
  R.recording = true; R.cancel = false;
  document.getElementById('reel-cancel').onclick = () => { R.cancel = true; reelPause(); rec.stop(); };
  const done = new Promise(res => rec.onstop = res);
  R.t = 0; reelSyncVideos(0, false);
  // Let first video frames seek before recording starts
  await new Promise(r => setTimeout(r, 300));
  rec.start(250);
  const prog = setInterval(() => { const p = document.getElementById('reel-prog'); if (p) p.style.width = Math.min(100, R.t / total * 100) + '%'; }, 200);
  R.onEnd = () => setTimeout(() => rec.state !== 'inactive' && rec.stop(), 150);
  reelPlay();
  await done;
  clearInterval(prog); R.onEnd = null; R.recording = false;
  R.master.disconnect(R.recDest); R.recDest = null;
  overlay.remove();
  cv.width = PREVIEW_W; cv.height = PREVIEW_H; R.t = 0; reelRender();
  if (R.cancel) return toast('Export cancelled.');
  const type = (mime || 'video/webm').split(';')[0];
  const file = new File([new Blob(chunks, { type })], `reel-${ymd(new Date())}.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type });
  // Sharing needs a fresh tap: the one that started the export expired while recording, so ask for one.
  const download = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); };
  const ready = document.createElement('div');
  ready.id = 'reel-rec';
  ready.innerHTML = `<div class="card"><h2>Reel ready</h2><p class="muted">${fmtBytes(file.size)}</p>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="btn primary" id="reel-dl">Save to device</button><button class="btn" id="reel-save">Share</button><button class="btn" id="reel-close">Close</button></div></div>`;
  document.body.appendChild(ready);
  document.getElementById('reel-close').onclick = () => ready.remove();
  document.getElementById('reel-dl').onclick = () => { download(); ready.remove(); toast('Reel saved to Downloads.'); };
  document.getElementById('reel-save').onclick = async () => {
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Reel' });
      else download();
      ready.remove(); toast('Reel shared.');
    } catch (e) {
      if (e.name === 'AbortError') return;
      download(); ready.remove(); toast('Reel downloaded.');
    }
  };
  return file;
}
