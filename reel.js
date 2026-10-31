'use strict';
/* InkForge reel maker: quick, consistent vertical (9:16) tattoo reels.
   A reel = optional intro card + clips (photos/videos) + optional outro card, drawn on one canvas.
   The look (fonts, colours, handle, transitions) is a saved "style" so every reel matches.
   Drafts live in memory only: imported videos are never copied into storage. Export records the
   canvas + Web Audio mix in real time with MediaRecorder (MP4 where the browser supports it). */

const REEL_VERSION = 6;   // app.js checks this matches, to catch a stale cached copy
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
  slide: [['left', '← Left'], ['right', 'Right →'], ['top', '↑ Top'], ['bottom', '↓ Bottom']]
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
  ['fade', 'Faded', 'contrast(.85) brightness(1.08) saturate(.8)']
];
const REEL_FILTER_CSS = Object.fromEntries(REEL_FILTERS.map(([k, , f]) => [k, f]));
const REEL_CAP_PX = { s: 60, m: 78, l: 100 };
const REEL_COLORS = ['#e9e3d6', '#ffffff', '#1fb5a8', '#f0c75e', '#d2453b'];
const PREVIEW_W = 540, PREVIEW_H = 960;

const R = {
  clips: [], sel: -1, tab: 'edit', seq: 0,
  pick: null,             // timeline selection: { kind: 'clip'|'intro'|'outro'|'trans', key }
  trans: {},              // per-boundary overrides { type, dir, dur }, keyed by the incoming segment's key
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
const REEL_DIPS = ['fade', 'flash', 'zoom'];
function reelTrans(s, seg) {
  const o = R.trans[seg.key] || {};
  return { type: o.type ?? s.transition, dir: o.dir ?? s.transDir, dur: +(o.dur ?? s.transDur) || 0.32 };
}
function reelSegAt(segs, t) {
  for (const s of segs) if (t < s.start + s.dur) return s;
  return segs[segs.length - 1];
}

/* ---------- Drawing ---------- */
const reelFont = (s, px, weight = 700) => s.font === 'display' ? `${px}px 'Pirata One', serif` : `${weight} ${px}px Inter, system-ui, sans-serif`;

// Soft background blur. Drawn at 180x320 (cheap every frame), blurred there, then scaled up smoothly.
// Where canvas filters are missing (older Safari), halving the image a few times and scaling it
// back up gives a similar soft result without the blocky look of one big stretch.
let _blurA, _blurB;
const BLUR_W = 180, BLUR_H = 320;
const canFilter = (() => { try { const x = document.createElement('canvas').getContext('2d'); x.filter = 'blur(2px)'; return x.filter === 'blur(2px)'; } catch { return false; } })();
function blurredCover(ctx, el, sw, sh, W, H) {
  _blurA ||= document.createElement('canvas'); _blurB ||= document.createElement('canvas');
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
  ctx.filter = REEL_FILTER_CSS[c.filter] || 'none';
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
function drawLogo(ctx, img, cx, cy, maxW, maxH) {
  const sc = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
  const w = img.naturalWidth * sc, h = img.naturalHeight * sc;
  ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
}

function textBlock(ctx, s, lines, x, y, px, color, align = 'center') {
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.font = reelFont(s, px);
  ctx.lineJoin = 'round';
  lines.forEach((ln, i) => {
    const yy = y + i * px * 1.12;
    ctx.lineWidth = px * 0.14; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(ln, x, yy);
    ctx.fillStyle = color; ctx.fillText(ln, x, yy);
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
  const k = W / 1080, ease = 1 - Math.pow(1 - Math.min(1, 0.3 + p * 2.2), 3);
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
  const k = W / 1080, pos = s[kind + 'Pos'];
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
  const k = W / 1080, sc = c.cap?.s || 1, px = (REEL_CAP_PX[s.capSize] || 78) * k * sc;
  ctx.font = reelFont(s, px);
  const lines = wrap(ctx, c.caption, W * 0.84);
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)), h = lines.length * px * 1.12;
  // Default spot from Style › Text, kept clear of social app buttons (top ~12%, bottom ~22%).
  const def = s.captionPos === 'top' ? H * 0.15 + (lines.length - 1) * px * 0.56
    : s.captionPos === 'middle' ? H * 0.5 : H * 0.74 - (lines.length - 1) * px * 0.56;
  return { cx: (c.cap?.x ?? 0.5) * W, cy: c.cap ? c.cap.y * H : def, w, h, px, lines };
}
function stickerLayout(st, W, H) {
  const iw = st.img.naturalWidth || 1, ih = st.img.naturalHeight || 1;
  const w = W * 0.35 * st.s, h = w * ih / iw;
  return { cx: st.x * W, cy: st.y * H, w, h };
}
// Everything movable on the frame at R.t, topmost last. Used by the preview's drag handling.
function reelLayers(ctx, W, H) {
  const s = reelStyle(), { segs, total } = reelSegments();
  if (!segs.length) return { seg: null, list: [] };
  const seg = reelSegAt(segs, Math.min(R.t, total - 1e-3)), list = [];
  if (seg.kind === 'clip') {
    const c = seg.clip;
    (c.stickers || []).forEach((st, i) => { if (st.img.complete) list.push({ id: 'stk' + i, kind: 'stk', i, clip: c, box: stickerLayout(st, W, H) }); });
    if (c.caption) list.push({ id: 'cap', kind: 'cap', clip: c, box: capLayout(ctx, s, c, W, H) });
  } else {
    const L = cardLayout(s, seg.kind, W, H);
    list.push({ id: 'card', kind: 'card', card: seg.kind, box: { cx: L.cx, cy: L.cy, w: L.w, h: L.h } });
  }
  return { seg, list };
}

function drawWatermark(ctx, s, W, H) {
  if (s.wmMode === 'off') return;
  const k = W / 1080, m = 40 * k;
  const right = s.wmPos[1] === 'r', top = s.wmPos[0] === 't';
  ctx.save();
  ctx.globalAlpha = s.wmOp;
  const logo = s.wmMode === 'logo' ? reelImg(reelLogoRef(s)) : null;
  if (logo) {
    const bw = 200 * k, bh = 120 * k;
    const sc = Math.min(bw / logo.naturalWidth, bh / logo.naturalHeight), w = logo.naturalWidth * sc, h = logo.naturalHeight * sc;
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 10 * k;
    // Same safe-area rows as the text version: below the top UI, above the caption/buttons zone.
    ctx.drawImage(logo, right ? W - m - w : m, top ? H * 0.13 : H * 0.8 - h, w, h);
  } else if (s.handle) {
    ctx.font = `600 ${34 * k}px Inter, sans-serif`; ctx.textAlign = right ? 'right' : 'left';
    ctx.textBaseline = top ? 'top' : 'alphabetic';
    ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 8 * k;
    ctx.fillText(s.handle, right ? W - m : m, top ? H * 0.13 : H * 0.8);
  }
  ctx.restore();
}

// One segment as it looks `local` seconds in: the clip (with caption and watermark) or a card.
function drawSeg(ctx, s, W, H, seg, local) {
  const p = Math.min(1, local / seg.dur);
  if (seg.kind !== 'clip') return drawCard(ctx, s, W, H, p, seg.kind);
  const c = seg.clip;
  drawMedia(ctx, c, W, H, p);
  for (const st of c.stickers || []) {
    if (!st.img.complete || !st.img.naturalWidth) continue;
    const b = stickerLayout(st, W, H);
    ctx.drawImage(st.img, b.cx - b.w / 2, b.cy - b.h / 2, b.w, b.h);
  }
  if (c.caption) {
    const k = W / 1080, L = capLayout(ctx, s, c, W, H);
    const cin = R.dragging ? 1 : Math.min(1, local / 0.35);   // no fade-in while it is being moved
    ctx.save(); ctx.globalAlpha = cin;
    textBlock(ctx, s, L.lines, L.cx, L.cy - (L.lines.length - 1) * L.px * 0.56 + (1 - cin) * 20 * k, L.px, s.color);
    ctx.restore();
  }
  drawWatermark(ctx, s, W, H);
}

function reelDraw(ctx, W, H, t) {
  const s = reelStyle(), { segs, total } = reelSegments();
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
  if (tOut && (tOut.type === 'wipe' || tOut.type === 'slide') && left < T(next, tOut)) {
    const q = 1 - Math.pow(left / T(next, tOut), 2);
    const d = trVariant(tOut), dx = d === 'left' ? 1 : d === 'right' ? -1 : 0, dy = d === 'top' ? 1 : d === 'bottom' ? -1 : 0;
    if (tOut.type === 'slide') {
      ctx.save(); ctx.translate(dx * W * q, dy * H * q); drawSeg(ctx, s, W, H, seg, local); ctx.restore();
      ctx.save(); ctx.translate(-dx * W * (1 - q), -dy * H * (1 - q)); drawSeg(ctx, s, W, H, next, 0); ctx.restore();
    } else {
      drawSeg(ctx, s, W, H, seg, local);
      const k = W / 1080;
      // Revealed area grows from the chosen edge; a thin accent line rides the edge.
      const r = dx > 0 ? [0, 0, W * q, H] : dx < 0 ? [W * (1 - q), 0, W * q, H] : dy > 0 ? [0, 0, W, H * q] : [0, H * (1 - q), W, H * q];
      ctx.save(); ctx.beginPath(); ctx.rect(...r); ctx.clip(); drawSeg(ctx, s, W, H, next, 0); ctx.restore();
      ctx.fillStyle = s.accent;
      if (dx) ctx.fillRect((dx > 0 ? W * q : W * (1 - q)) - 3 * k, 0, 6 * k, H);
      else ctx.fillRect(0, (dy > 0 ? H * q : H * (1 - q)) - 3 * k, W, 6 * k);
    }
    return;
  }
  // Dip-style transitions ramp in after the boundary before this segment and out before the next.
  // Each side uses its own boundary's type, so a fade-in can follow a flash-out.
  const amt = { fade: 0, flash: 0, zoom: 0 }, vr = {};
  const dip = (tr, a) => { if (a > amt[tr.type]) { amt[tr.type] = a; vr[tr.type] = trVariant(tr); } };
  if (tIn && REEL_DIPS.includes(tIn.type) && local < T(prev, tIn)) dip(tIn, 1 - local / T(prev, tIn));
  if (tOut && REEL_DIPS.includes(tOut.type) && left < T(next, tOut)) dip(tOut, 1 - left / T(next, tOut));
  ctx.save();
  if (amt.zoom) {
    // In: punch towards the viewer. Out: the frame shrinks away into black.
    const z = vr.zoom === 'out' ? 1 - amt.zoom * 0.22 : 1 + amt.zoom * 0.18;
    ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);
  }
  drawSeg(ctx, s, W, H, seg, local);
  ctx.restore();
  if (amt.fade) { ctx.fillStyle = vr.fade === 'white' ? `rgba(255,255,255,${amt.fade})` : `rgba(0,0,0,${amt.fade})`; ctx.fillRect(0, 0, W, H); }
  if (amt.flash) {
    ctx.save(); ctx.globalAlpha = amt.flash * 0.85;
    ctx.fillStyle = vr.flash === 'accent' ? s.accent : '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
}

// Editing aids on the preview only (never recorded): selection box, resize handle, snap guides.
function reelDrawOverlay(ctx, W, H) {
  if (R.recording || !R.layer) return;
  const { list } = reelLayers(ctx, W, H), o = list.find(x => x.id === R.layer);
  if (!o) return;
  const b = o.box, k = W / 540;
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
    if (c.gain) c.gain.gain.value = c.mute ? 0 : 1;
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
    c.gain = R.actx.createGain(); c.gain.gain.value = c.mute ? 0 : 1;
    src.connect(c.gain).connect(R.master);
  } catch (e) { console.warn('Clip audio unavailable', e); }
}
function reelMusicStart(t) {
  reelMusicStop();
  if (!R.music || !R.actx) return;
  const n = R.actx.createBufferSource(), g = R.actx.createGain();
  n.buffer = R.music.buffer; g.gain.value = R.music.vol;
  n.connect(g).connect(R.master);
  const { total } = reelSegments();
  // fade out over the last second
  const now = R.actx.currentTime, left = total - t;
  if (left > 1) { g.gain.setValueAtTime(R.music.vol, now + left - 1); g.gain.linearRampToValueAtTime(0, now + left); }
  n.start(0, Math.min(R.music.buffer.duration - 0.01, R.music.offset + t));
  R.musicNode = n;
}
function reelMusicStop() { if (R.musicNode) { try { R.musicNode.stop(); } catch {} R.musicNode = null; } }

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

/* ---------- Adding clips ---------- */
async function reelAddFile(file) {
  const url = URL.createObjectURL(file);
  const c = { id: ++R.seq, name: file.name, url, motion: 'in', fit: 'cover', caption: '', mute: true, filter: 'none', speed: 1, rot: 0, flip: false };
  if (file.type.startsWith('video')) {
    const v = document.createElement('video');
    v.src = url; v.muted = false; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Unsupported video')); });
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
  await document.fonts.load(reelFont(s, 40)).catch(() => {});
  reelPause();
  const [W, H] = s.quality === '1080' ? [1080, 1920] : [720, 1280];
  cv.width = W; cv.height = H;
  reelAudio();
  R.recDest = R.actx.createMediaStreamDestination();
  R.master.connect(R.recDest);
  const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...R.recDest.stream.getAudioTracks()]);
  const mime = reelMime();
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: s.quality === '1080' ? 10e6 : 6e6 });
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
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Reel' });
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
    toast(`Reel saved (${fmtBytes(file.size)}).`);
  } catch (e) { if (e.name !== 'AbortError') toast('Could not save: ' + e.message); }
  return file;
}
