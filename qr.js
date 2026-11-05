/* QR codes: byte mode, versions 1 to 40, all four error correction levels, best of the eight masks.
   dzQr(text, 'M') returns rows of booleans (true = dark), without the quiet zone. Null if the text is too long. */
const QR_EC = { L: [1, [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30], [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25]],
  M: [0, [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28], [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49]],
  Q: [3, [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30], [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68]],
  H: [2, [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30], [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]] };
const qrRaw = (v) => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
const qrMul = (a, b) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((b >>> i) & 1) * a; } return z & 255; };
function qrEcc(data, n) { const gen = Array(n - 1).fill(0).concat([1]); let root = 1;
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { gen[j] = qrMul(gen[j], root); if (j + 1 < n) gen[j] ^= gen[j + 1]; } root = qrMul(root, 2); }
  const out = Array(n).fill(0); for (const b of data) { const f = b ^ out.shift(); out.push(0); gen.forEach((g, i) => { out[i] ^= qrMul(g, f); }); } return out; }
function dzQr(text, level = 'M') {
  const bytes = [...new TextEncoder().encode(String(text))], [fmtBits, perBlock, numBlocks] = QR_EC[level] || QR_EC.M;
  let v = 1, cap; for (; v <= 40; v++) { cap = Math.floor(qrRaw(v) / 8) - perBlock[v] * numBlocks[v]; if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cap * 8) break; }
  if (v > 40) return null;
  const bits = [], put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8)); put(0, Math.min(4, cap * 8 - bits.length)); put(0, (8 - bits.length % 8) % 8);
  for (let p = 0xec; bits.length < cap * 8; p ^= 0xec ^ 0x11) put(p, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  // Blocks, each with its error correction, interleaved.
  const nb = numBlocks[v], ec = perBlock[v], raw = Math.floor(qrRaw(v) / 8), short = nb - raw % nb, shortLen = Math.floor(raw / nb), blocks = [];
  for (let i = 0, at = 0; i < nb; i++) { const d = data.slice(at, at + shortLen - ec + (i < short ? 0 : 1)); at += d.length; const e = qrEcc(d, ec); if (i < short) d.push(-1); blocks.push(d.concat(e)); }
  const code = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ec || j >= short) code.push(b[i]); });
  // Fixed patterns.
  const S = v * 4 + 17, M = Array.from({ length: S }, () => Array(S).fill(false)), F = Array.from({ length: S }, () => Array(S).fill(false)), set = (x, y, d) => { M[y][x] = d; F[y][x] = true; };
  for (let i = 0; i < S; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy; if (x >= 0 && x < S && y >= 0 && y < S) set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(S - 4, 3); finder(3, S - 4);
  const al = v === 1 ? [] : (() => { const n = Math.floor(v / 7) + 2, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, r = [6]; for (let p = S - 7; r.length < n; p -= step) r.splice(1, 0, p); return r; })();
  al.forEach((a, i) => al.forEach((b, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
  const format = (mask) => { const d = (fmtBits << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); const b = ((d << 10) | r) ^ 0x5412, g = (i) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, g(i)); set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8)); for (let i = 9; i < 15; i++) set(14 - i, 8, g(i));
    for (let i = 0; i < 8; i++) set(S - 1 - i, 8, g(i)); for (let i = 8; i < 15; i++) set(8, S - 15 + i, g(i)); set(8, S - 8, true); };
  format(0);
  if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const b = (v << 12) | r; for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) !== 0, a = S - 11 + i % 3, c = Math.floor(i / 3); set(a, c, d); set(c, a, d); } }
  // The data, in the zigzag.
  let i = 0; for (let right = S - 1; right >= 1; right -= 2) { if (right === 6) right = 5;
    for (let vert = 0; vert < S; vert++) for (let j = 0; j < 2; j++) { const x = right - j, up = ((right + 1) & 2) === 0, y = up ? S - 1 - vert : vert;
      if (!F[y][x] && i < code.length * 8) { M[y][x] = ((code[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; } } }
  const flip = (m) => { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { if (F[y][x]) continue; const t = [(x + y) % 2, y % 2, x % 3, (x + y) % 3, (Math.floor(x / 3) + Math.floor(y / 2)) % 2, x * y % 2 + x * y % 3, (x * y % 2 + x * y % 3) % 2, ((x + y) % 2 + x * y % 3) % 2][m]; if (t === 0) M[y][x] = !M[y][x]; } };
  const score = () => { let s = 0, dark = 0; const line = (get) => { for (let a = 0; a < S; a++) { let run = 0, c = null, hist = 0; for (let b = 0; b < S; b++) { const d = get(a, b); if (d === c) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else { c = d; run = 1; } hist = ((hist << 1) | (d ? 1 : 0)) & 0x7ff; if (b >= 10 && (hist === 0x5d || hist === 0x5d0)) s += 40; } } };
    line((a, b) => M[a][b]); line((a, b) => M[b][a]);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { if (M[y][x]) dark++; if (y < S - 1 && x < S - 1 && M[y][x] === M[y][x + 1] && M[y][x] === M[y + 1][x] && M[y][x] === M[y + 1][x + 1]) s += 3; }
    return s + (Math.ceil(Math.abs(dark * 20 - S * S * 10) / (S * S)) - 1) * 10; };
  let best = 0, low = Infinity; for (let m = 0; m < 8; m++) { flip(m); format(m); const s = score(); if (s < low) { low = s; best = m; } flip(m); }
  flip(best); format(best);
  return M;
}
// The dark modules as shape outlines (box fractions), four modules of quiet zone included. Runs in a row join up.
function dzQrSubs(M) { const n = M.length, T = n + 8, subs = [], nd = (x, y) => ({ x: (x + 4) / T, y: (y + 4) / T, ix: 0, iy: 0, ox: 0, oy: 0, t: 'corner' });
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { if (!M[y][x]) continue; let e = x; while (e + 1 < n && M[y][e + 1]) e++; subs.push({ closed: true, nodes: [nd(x, y), nd(e + 1, y), nd(e + 1, y + 1), nd(x, y + 1)] }); x = e; }
  return subs; }
