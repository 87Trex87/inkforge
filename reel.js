'use strict';
/* InkForge reel maker: quick, consistent vertical (9:16) tattoo reels.
   A reel = optional intro card + clips (photos/videos) + optional outro card, drawn on one canvas.
   The look (fonts, colours, handle, transitions) is a saved "style" so every reel matches.
   Drafts live in memory only: imported videos are never copied into storage. Export records the
   canvas + Web Audio mix in real time with MediaRecorder (MP4 where the browser supports it). */

// Card backgrounds: { ref, op, zoom, rot, flip } with ref = media file name (kept in the media folder).
const REEL_CARD_BG = { ref: '', op: 0.55, zoom: 1, rot: 0, flip: false };
const REEL_STYLE_DEFAULTS = {
  title: '', handle: '', intro: true, outro: true, outroText: 'Book now',
  font: 'display', color: '#e9e3d6', accent: '#1fb5a8', transition: 'fade',
  captionPos: 'bottom', capSize: 'm', quality: '720',
  wmMode: 'text', wmPos: 'br', wmOp: 0.75,          // watermark: off | text (handle) | logo
  cardLogo: true, introBg: REEL_CARD_BG, outroBg: REEL_CARD_BG
};
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
const INTRO_DUR = 1.6, OUTRO_DUR = 2.4, TRANS = 0.32;
const PREVIEW_W = 540, PREVIEW_H = 960;

const R = {
  clips: [], sel: -1, tab: 'clips', seq: 0,
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
  if (s.intro) push({ kind: 'intro', dur: INTRO_DUR });
  for (const c of R.clips) push({ kind: 'clip', clip: c, dur: clipDur(c) });
  if (s.outro) push({ kind: 'outro', dur: OUTRO_DUR });
  return { segs, total: t };
}
function reelSegAt(segs, t) {
  for (const s of segs) if (t < s.start + s.dur) return s;
  return segs[segs.length - 1];
}

/* ---------- Drawing ---------- */
const reelFont = (s, px, weight = 700) => s.font === 'display' ? `${px}px 'Pirata One', serif` : `${weight} ${px}px Inter, system-ui, sans-serif`;

// Cheap, Safari-safe blur: draw tiny, then stretch.
let _blurCv;
function blurredCover(ctx, el, sw, sh, W, H) {
  _blurCv ||= document.createElement('canvas');
  _blurCv.width = 27; _blurCv.height = 48;
  const b = _blurCv.getContext('2d');
  const sc = Math.max(27 / sw, 48 / sh);
  b.drawImage(el, (27 - sw * sc) / 2, (48 - sh * sc) / 2, sw * sc, sh * sc);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(_blurCv, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, W, H);
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
  if (c.fit === 'blur') {
    blurredCover(ctx, el, sw, sh, BW, BH);
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
  const logo = s.cardLogo ? reelImg(Settings.get('studio_logo_ref')) : null;
  if (logo) drawLogo(ctx, logo, W / 2, H * 0.25, W * 0.5, H * 0.16);
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

function drawWatermark(ctx, s, W, H) {
  if (s.wmMode === 'off') return;
  const k = W / 1080, m = 40 * k;
  const right = s.wmPos[1] === 'r', top = s.wmPos[0] === 't';
  ctx.save();
  ctx.globalAlpha = s.wmOp;
  const logo = s.wmMode === 'logo' ? reelImg(Settings.get('studio_logo_ref')) : null;
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
  if (c.caption) {
    const k = W / 1080, px = (REEL_CAP_PX[s.capSize] || 78) * k;
    ctx.font = reelFont(s, px);
    const lines = wrap(ctx, c.caption, W * 0.84);
    // Keep clear of social app buttons: top ~12%, bottom ~22%
    const y = s.captionPos === 'top' ? H * 0.15 : s.captionPos === 'middle' ? H * 0.5 - (lines.length - 1) * px * 0.56 : H * 0.74 - (lines.length - 1) * px * 1.12;
    const cin = Math.min(1, local / 0.35);
    ctx.save(); ctx.globalAlpha = cin;
    textBlock(ctx, s, lines, W / 2, y + (1 - cin) * 20 * k, px, s.color);
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
  const i = segs.indexOf(seg), next = segs[i + 1], left = seg.dur - local;
  // Wipe and slide show the next segment coming in over the last moments of this one.
  if ((s.transition === 'wipe' || s.transition === 'slide') && next && left < TRANS) {
    const q = 1 - Math.pow(left / TRANS, 2);
    if (s.transition === 'slide') {
      ctx.save(); ctx.translate(-W * q, 0); drawSeg(ctx, s, W, H, seg, local); ctx.restore();
      ctx.save(); ctx.translate(W * (1 - q), 0); drawSeg(ctx, s, W, H, next, 0); ctx.restore();
    } else {
      drawSeg(ctx, s, W, H, seg, local);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * q, H); ctx.clip(); drawSeg(ctx, s, W, H, next, 0); ctx.restore();
      ctx.fillStyle = s.accent; ctx.fillRect(W * q - 3 * W / 1080, 0, 6 * W / 1080, H);
    }
    return;
  }
  // Dip-style transitions: strength near boundaries (not at the very start/end of the reel)
  let a = 0;
  if (s.transition === 'fade' || s.transition === 'flash' || s.transition === 'zoom') {
    if (i > 0 && local < TRANS) a = 1 - local / TRANS;
    if (next && left < TRANS) a = Math.max(a, 1 - left / TRANS);
  }
  ctx.save();
  if (s.transition === 'zoom' && a) { const z = 1 + a * 0.18; ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2); }
  drawSeg(ctx, s, W, H, seg, local);
  ctx.restore();
  if (a && s.transition === 'fade') { ctx.fillStyle = `rgba(0,0,0,${a})`; ctx.fillRect(0, 0, W, H); }
  if (a && s.transition === 'flash') { ctx.fillStyle = `rgba(255,255,255,${a * 0.85})`; ctx.fillRect(0, 0, W, H); }
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
  const { total } = reelSegments();
  const sc = document.getElementById('reel-scrub'), tm = document.getElementById('reel-time');
  if (sc && !R.scrubbing) { sc.max = total || 0; sc.value = R.t; }
  if (tm) tm.textContent = `${R.t.toFixed(1)} / ${total.toFixed(1)}s`;
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
  } else {
    const img = new Image(); img.src = url; await img.decode();
    Object.assign(c, { type: 'image', el: img, w: img.naturalWidth, h: img.naturalHeight, dur: 2.5 });
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
