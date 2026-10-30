/* InkForge stencil processing. Runs off the main thread so sliders stay smooth.
   In:  { id, w, h, rgba (Uint8ClampedArray), p: params }
   Out: { id, mask (Uint8Array, 1 = ink) }
   Modes: 'lines' (difference-of-Gaussians edges), 'solid' (threshold), 'sketch' (lines + dark fills). */

function gray(rgba, w, h, contrast, bright) {
  const g = new Float32Array(w * h);
  const c = (100 + contrast) / 100;            // contrast -50..50 -> 0.5..1.5
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;               // transparent areas count as white
    let v = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * a + 255 * (1 - a);
    v = (v - 128) * c + 128 + bright;
    g[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return g;
}

// Separable Gaussian blur.
function blur(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (x >= r && x < w - r) { for (let i = -r, o = row + x; i <= r; i++) s += src[o + i] * k[i + r]; }
      else for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i; s += src[row + xx] * k[i + r]; }
      tmp[row + x] = s;
    }
  }
  // Vertical pass row by row (accumulating whole rows) so memory is read in order.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let i = -r; i <= r; i++) {
      const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i, src = yy * w, kv = k[i + r];
      for (let x = 0; x < w; x++) out[row + x] += tmp[src + x] * kv;
    }
  }
  return out;
}

function dilate(m, w, h) {
  const o = new Uint8Array(m);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!m[i] && (m[i - 1] || m[i + 1] || m[i - w] || m[i + w])) o[i] = 1;
  }
  return o;
}

// Removes ink pixels with too few inked neighbours (specks, noise). Repeated `passes` times.
function clean(m, w, h, passes) {
  for (let p = 0; p < passes; p++) {
    const o = new Uint8Array(m);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const n = m[i - w - 1] + m[i - w] + m[i - w + 1] + m[i - 1] + m[i + 1] + m[i + w - 1] + m[i + w] + m[i + w + 1];
      if (n < 2) o[i] = 0;
    }
    m = o;
  }
  return m;
}

self.onmessage = (e) => {
  const { id, w, h, rgba, p } = e.data;
  const g = gray(rgba, w, h, p.contrast, p.bright);
  let mask = new Uint8Array(w * h);
  if (p.mode !== 'solid') {
    // Detail 1..10: higher = finer lines (smaller blur). Sensitivity from line amount 0..100.
    const s = 0.6 + (10 - p.detail) * 0.22;
    const g1 = blur(g, w, h, s), g2 = blur(g, w, h, s * 1.6);
    const t = 1 + (100 - p.amount) * 0.12;     // lower t -> more edges picked up
    for (let i = 0; i < mask.length; i++) if (g1[i] - g2[i] < -t) mask[i] = 1;
    for (let k = 0; k < p.weight; k++) mask = dilate(mask, w, h);
  }
  if (p.mode !== 'lines') {
    const th = p.mode === 'sketch' ? p.threshold * 0.55 : p.threshold;
    const src = p.mode === 'solid' ? blur(g, w, h, 0.8) : g;
    for (let i = 0; i < mask.length; i++) if (src[i] < th) mask[i] = 1;
  }
  if (p.clean) mask = clean(mask, w, h, p.clean);
  self.postMessage({ id, mask }, [mask.buffer]);
};
