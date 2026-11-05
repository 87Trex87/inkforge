/* ---------- Forms ----------
   A form is a design of kind 'form': any number of pages (layer.side = 'f', 'p2', 'p3'..., or 'm' for the master under
   every page) holding ordinary layers plus field layers (t: 'field'). Filling one in lays real inputs over the drawn
   pages; a completed form is kept as flattened page pictures (signed_form_pages), so later edits never change it. */
const FF_TYPES = [['text', 'Text box'], ['area', 'Paragraph box'], ['date', 'Date'], ['check', 'Check box'], ['radio', 'Radio buttons'], ['combo', 'Combo box'], ['sign', 'Signature']];
const FF_CATS = [['consent', 'Consent'], ['aftercare', 'Aftercare'], ['other', 'Other forms']];
const FF_PREFILL = [['', 'Nothing'], ['{client}', 'Client name'], ['{phone}', 'Client phone'], ['{email}', 'Client email'], ['{date}', 'Today']];
const ffFaces = (doc) => Array.from({ length: doc.pages || 1 }, (_, i) => i ? 'p' + (i + 1) : 'f');
const ffX = document.createElement('canvas').getContext('2d');

/* Where everything in a field sits, in the layer's own box (top left = 0,0). Drawing, filling in and the PDF all use this. */
function dzFieldGeom(l, x = ffX) {
  const s = l.size || 46, lh = s * 1.3, w = l.w, g = { label: [], box: null, opts: [], h: 0 };
  x.font = `400 ${s}px Inter, sans-serif`;
  if (l.ft === 'check') {
    const lines = l.label ? dzWrap(x, l.label, Math.max(20, w - s * 1.6)) : [];
    g.box = { x: 0, y: s * 0.12, w: s, h: s };
    lines.forEach((t, i) => g.label.push({ s: t, x: s * 1.6, y: i * lh + s }));
    g.h = Math.max(s * 1.3, lines.length * lh); return g;
  }
  let y = 0;
  if (l.label) { x.font = `600 ${s}px Inter, sans-serif`; for (const t of dzWrap(x, l.label, w)) { g.label.push({ s: t, x: 0, y: y + s, b: 1 }); y += lh; } x.font = `400 ${s}px Inter, sans-serif`; y += s * 0.15; }
  if (l.ft === 'radio') {
    for (const o of (l.opts || [])) { const L = dzWrap(x, o, Math.max(20, w - s * 1.6)); g.opts.push({ v: o, x: 0, y: y + s * 0.12, d: s, lines: L.map((t, i) => ({ s: t, x: s * 1.6, y: y + i * lh + s })) }); y += L.length * lh + s * 0.25; }
    g.h = Math.max(y, s * 1.3); return g;
  }
  const tall = l.ft === 'area' || l.ft === 'sign', bh = tall ? Math.max((l.h || 0) - y, s * (l.ft === 'sign' ? 3.5 : 2.5)) : s * 1.7;
  g.box = { x: 0, y, w, h: bh }; g.h = y + bh; return g;
}
// Draws a field. val is its answer (none in the editor or on a blank copy), sig the picture for a signature.
function dzFieldDraw(x, doc, l, o = {}) {
  const g = dzFieldGeom(l, x), s = l.size || 46, col = dzCol(doc, l.c || '@fg') || '#111', v = o.noVal ? undefined : o.vals?.[l.id];
  x.translate(-l.w / 2, -l.h / 2); x.fillStyle = col; x.strokeStyle = col; x.lineWidth = Math.max(2, s * 0.05); x.textAlign = 'left'; x.textBaseline = 'alphabetic';
  x.font = `600 ${s}px Inter, sans-serif`; for (const t of g.label.filter(t => t.b)) x.fillText(t.s, t.x, t.y);
  x.font = `400 ${s}px Inter, sans-serif`; for (const t of g.label.filter(t => !t.b)) x.fillText(t.s, t.x, t.y);
  if (l.ft === 'check') { const b = g.box; x.strokeRect(b.x, b.y, b.w, b.h);
    if (v) { x.beginPath(); x.moveTo(b.x + b.w * 0.2, b.y + b.h * 0.55); x.lineTo(b.x + b.w * 0.42, b.y + b.h * 0.78); x.lineTo(b.x + b.w * 0.82, b.y + b.h * 0.22); x.lineWidth *= 2; x.stroke(); }
    return; }
  if (l.ft === 'radio') { for (const r of g.opts) { x.beginPath(); x.arc(r.x + r.d / 2, r.y + r.d / 2, r.d / 2, 0, 7); x.stroke();
      if (v === r.v) { x.beginPath(); x.arc(r.x + r.d / 2, r.y + r.d / 2, r.d * 0.26, 0, 7); x.fill(); }
      for (const t of r.lines) x.fillText(t.s, t.x, t.y); }
    return; }
  const b = g.box;
  if (l.ft === 'area' || l.ft === 'sign') x.strokeRect(b.x, b.y, b.w, b.h); else { x.beginPath(); x.moveTo(b.x, b.y + b.h); x.lineTo(b.x + b.w, b.y + b.h); x.stroke(); }
  if (l.ft === 'combo' && !o.print) { const a = b.x + b.w - s * 0.9, m = b.y + b.h * 0.42; x.beginPath(); x.moveTo(a, m); x.lineTo(a + s * 0.5, m); x.lineTo(a + s * 0.25, m + s * 0.3); x.closePath(); x.fill(); }
  const sig = o.sigs?.[l.id];
  if (l.ft === 'sign' && sig) { const k = Math.min(b.w / sig.width, b.h / sig.height); x.drawImage(sig, b.x + (b.w - sig.width * k) / 2, b.y + (b.h - sig.height * k) / 2, sig.width * k, sig.height * k); return; }
  if (v) { if (l.ft === 'area') dzWrap(x, String(v), b.w - s * 0.5).forEach((t, i) => { if ((i + 1) * s * 1.3 < b.h) x.fillText(t, b.x + s * 0.25, b.y + (i + 1) * s * 1.2); });
    else x.fillText(String(v), b.x + s * 0.1, b.y + b.h - s * 0.4); }
}
const dzFieldNew = (ft, o = {}) => ({ id: dzId(), t: 'field', ft, keep: false, label: '', size: 46, w: 1000, h: 90, x: 200, y: 200, rot: 0, op: 1, ...o });

/* Templates: lays the wording out over as many A4 pages as it takes. */
function ffFromBlocks(tpl, W, H) {
  const M = 190, cw = W - M * 2, out = []; let y = M, pg = 1;
  const side = () => pg > 1 ? { side: 'p' + pg } : {};
  const place = (l, h, keep = 0) => { if (y + h + keep > H - M && y > M) { pg++; y = M; } Object.assign(l, { x: M, y, ...side() }); out.push(l); y += h; };
  if (Settings.get('studio_logo_ref')) { out.push(dzLogo((W - 420) / 2, M - 60, 420, 300)); y = M + 280; }
  const text = (s, size, o, gap, keep) => { ffX.font = `${o.b ? 700 : 400} ${size}px Inter, sans-serif`; const lh = o.lh || 1.3, h = dzWrap(ffX, s, cw).length * size * lh; place(dzT(s, 0, 0, cw, size, { lh, ...o }), h + gap, keep); };
  for (const b of tpl.blocks) {
    if (b.t === 'h') text(b.text, 110, { font: '@1', al: 'center', c: '@accent' }, 40);
    else if (b.t === 'sub') { y += 26; text(b.text, 60, { b: 1, c: '@accent' }, 18, 120); }
    else if (b.t === 'p') text(b.text, 46, {}, 18);
    else if (b.t === 'li') text('•  ' + b.text, 46, {}, 12);
    else { const ft = b.t === 'check' ? 'check' : b.t === 'choice' ? 'radio' : 'text';
      const f = dzFieldNew(ft, { label: b.text, w: cw, v: b.v && /^\{\w+\}$/.test(b.v) ? b.v : '', req: b.t === 'choice' ? !!b.req : tpl.kind === 'consent' && b.t === 'check' && !b.opt });
      if (ft === 'radio') f.opts = String(b.opts || '').split('/').map(s => s.trim()).filter(Boolean);
      const h = dzFieldGeom(f).h; f.h = h; place(f, h + 22); }
  }
  if (tpl.kind === 'consent') { y += 30; const f = dzFieldNew('sign', { label: 'Signature', w: cw, h: 420, req: true }); place(f, 480); }
  return out;
}
const ffTpl = (get, cat) => { const m = (W, H) => ffFromBlocks(get(), W, H); m.cat = cat; return m; };
DZ_TEMPLATES.form = [
  ['Tattoo consent', ffTpl(() => DEFAULT_TEMPLATES.find(t => t.kind === 'consent'), 'consent')],
  ['Apprentice consent', ffTpl(() => APPRENTICE_TEMPLATE, 'consent')],
  ['Aftercare', ffTpl(() => DEFAULT_TEMPLATES.find(t => t.kind === 'aftercare'), 'aftercare')]
];
// A new form's page count comes from the template's own layers.
function ffSetup(doc, make) { doc.sides = 2; doc.form = { cat: make?.cat || doc.form?.cat || 'other' }; doc.pages = Math.max(doc.pages || 1, ...doc.layers.map(l => /^p\d+$/.test(l.side || '') ? +l.side.slice(1) : 1)); }

/* A working copy of a form with the wording filled in for this client (or left blank for paper). */
function ffCopy(doc, ctx) { const d = JSON.parse(JSON.stringify(doc));
  for (const l of d.layers) { if (l.t === 'text') l.text = fillPlaceholders(l.text, ctx); if (l.t === 'field' && l.label) l.label = fillPlaceholders(l.label, ctx); }
  return d; }
const ffBlankCtx = () => ({ ...formCtx(null), client: '____________________', first: '', date: '____ / ____ / ________' });
async function ffPage(d, face, opt = {}, scale = 1) { const cv = document.createElement('canvas'); cv.width = Math.round(d.w * scale); cv.height = Math.round(d.h * scale); await dzDraw(cv, d, scale, { face, ...opt }); return cv; }
async function ffPrintBlank(doc) { const d = ffCopy(doc, ffBlankCtx()), pages = []; for (const f of ffFaces(d)) pages.push(await ffPage(d, f, { noVal: true, print: true })); return printCanvas(...pages); }
// The pages of a form filled for a client, for attaching to a receipt.
async function ffPagesFor(id, client, booking) { const r = await DB.one('SELECT doc, name FROM designs WHERE id = ?', [id]); if (!r) return []; const d = ffCopy(JSON.parse(r.doc), formCtx(client, booking)), out = [];
  for (const f of ffFaces(d)) out.push({ cv: await ffPage(d, f, { noVal: true }), name: r.name }); return out; }

/* ---------- PDF: the pages as pictures, with real form fields on top ---------- */
const ffEnc = new TextEncoder();
const ffStr = (s) => { s = String(s ?? ''); return /^[\x20-\x7e]*$/.test(s) ? '(' + s.replace(/[\\()]/g, '\\$&') + ')' : '<FEFF' + [...Array(s.length).keys()].map(i => s.charCodeAt(i).toString(16).padStart(4, '0')).join('') + '>'; };
const ffName = (s) => '/' + s;
async function ffPdf(d, opt = {}) {
  const objs = [], add = (o) => { objs.push(o); return objs.length; }, resv = () => add(null);
  const stream = (dict, bytes) => { const b = typeof bytes === 'string' ? ffEnc.encode(bytes) : bytes; return [ffEnc.encode(`<<${dict}/Length ${b.length}>>\nstream\n`), b, ffEnc.encode('\nendstream')]; };
  const catalog = resv(), pagesO = resv(), font = add('<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>');
  const k = 72 / (d.dpi || 300), PW = d.w * k, PH = d.h * k, kids = [], fields = [], vals = opt.vals || {};
  const ap = (w, h, draw) => add(stream(`/Type/XObject/Subtype/Form/BBox[0 0 ${w} ${h}]`, draw));
  const tick = (w, h) => `q ${Math.max(1, w * 0.1)} w ${w * .2} ${h * .45} m ${w * .42} ${h * .22} l ${w * .82} ${h * .78} l S Q`;
  const dot = (w) => { const r = w * .26, c = w / 2, q = r * .552; return `q 0 g ${c + r} ${c} m ${c + r} ${c + q} ${c + q} ${c + r} ${c} ${c + r} c ${c - q} ${c + r} ${c - r} ${c + q} ${c - r} ${c} c ${c - r} ${c - q} ${c - q} ${c - r} ${c} ${c - r} c ${c + q} ${c - r} ${c + r} ${c - q} ${c + r} ${c} c f Q`; };
  for (const face of ffFaces(d)) {
    const cv = await ffPage(d, face, { noVal: true, sigs: opt.sigs, print: false }, Math.min(1, 1654 / d.w));
    const jpg = Uint8Array.from(atob(cv.toDataURL('image/jpeg', 0.88).split(',')[1]), c => c.charCodeAt(0));
    const img = add(stream(`/Type/XObject/Subtype/Image/Width ${cv.width}/Height ${cv.height}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode`, jpg));
    const content = add(stream('', `q ${PW} 0 0 ${PH} 0 0 cm /I Do Q`));
    const annots = [], page = resv();
    const rect = (l, b) => { const x = (l.x + b.x) * k, y = PH - (l.y + b.y + b.h) * k; return `[${x.toFixed(2)} ${y.toFixed(2)} ${(x + b.w * k).toFixed(2)} ${(y + b.h * k).toFixed(2)}]`; };
    if (!opt.flat) for (const l of d.layers.filter(l => l.t === 'field' && !l.hide && dzSide(l) === face)) {
      const g = dzFieldGeom(l), fs = ((l.size || 46) * k * 0.9).toFixed(1), da = `/DA(/Helv ${fs} Tf 0 g)`, v = vals[l.id], base = `/Type/Annot/Subtype/Widget/F 4/P ${page} 0 R/T${ffStr(l.id)}/TU${ffStr(l.label || '')}`;
      if (l.ft === 'text' || l.ft === 'date' || l.ft === 'area') { const n = add(`<<${base}/FT/Tx/Rect${rect(l, g.box)}${da}${l.ft === 'area' ? '/Ff 4096' : ''}${v ? '/V' + ffStr(v) : ''}>>`); annots.push(n); fields.push(n); }
      else if (l.ft === 'combo') { const n = add(`<<${base}/FT/Ch/Ff 131072/Rect${rect(l, g.box)}${da}/Opt[${(l.opts || []).map(ffStr).join(' ')}]${v ? '/V' + ffStr(v) : ''}>>`); annots.push(n); fields.push(n); }
      else if (l.ft === 'check') { const w = g.box.w * k, on = ap(w, w, tick(w, w)), off = ap(w, w, ''); const n = add(`<<${base}/FT/Btn/Rect${rect(l, g.box)}${da}/AP<</N<</Yes ${on} 0 R/Off ${off} 0 R>>>>/AS${v ? '/Yes/V/Yes' : '/Off/V/Off'}>>`); annots.push(n); fields.push(n); }
      else if (l.ft === 'radio') { const par = resv(), ks = [];
        g.opts.forEach((r, i) => { const w = r.d * k, on = ap(w, w, dot(w)), off = ap(w, w, ''); const n = add(`<</Type/Annot/Subtype/Widget/F 4/P ${page} 0 R/Parent ${par} 0 R/Rect${rect(l, { x: r.x, y: r.y, w: r.d, h: r.d })}/AP<</N<</o${i} ${on} 0 R/Off ${off} 0 R>>>>/AS${v === r.v ? '/o' + i : '/Off'}>>`); ks.push(n); annots.push(n); });
        const sel = g.opts.findIndex(r => r.v === v); objs[par - 1] = `<</FT/Btn/Ff 49152/T${ffStr(l.id)}/TU${ffStr(l.label || '')}/Kids[${ks.map(n => n + ' 0 R').join(' ')}]/V${sel >= 0 ? '/o' + sel : '/Off'}>>`; fields.push(par); }
      // A signature stays a drawn box: signed by hand on paper, or in InkForge.
    }
    objs[page - 1] = `<</Type/Page/Parent ${pagesO} 0 R/MediaBox[0 0 ${PW.toFixed(2)} ${PH.toFixed(2)}]/Contents ${content} 0 R/Resources<</XObject<</I ${img} 0 R>>>>/Annots[${annots.map(n => n + ' 0 R').join(' ')}]>>`;
    kids.push(page);
  }
  objs[catalog - 1] = `<</Type/Catalog/Pages ${pagesO} 0 R${fields.length ? `/AcroForm<</Fields[${fields.map(n => n + ' 0 R').join(' ')}]/NeedAppearances true/DA(/Helv 11 Tf 0 g)/DR<</Font<</Helv ${font} 0 R>>>>>>` : ''}>>`;
  objs[pagesO - 1] = `<</Type/Pages/Count ${kids.length}/Kids[${kids.map(n => n + ' 0 R').join(' ')}]>>`;
  const parts = [ffEnc.encode('%PDF-1.5\n')], off = []; let at = parts[0].length;
  const push = (b) => { parts.push(b); at += b.length; };
  objs.forEach((o, i) => { off.push(at); push(ffEnc.encode(`${i + 1} 0 obj\n`)); (Array.isArray(o) ? o : [ffEnc.encode(o)]).forEach(push); push(ffEnc.encode('\nendobj\n')); });
  const xref = at; push(ffEnc.encode(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<</Size ${objs.length + 1}/Root ${catalog} 0 R>>\nstartxref\n${xref}\n%%EOF`));
  return new Blob(parts, { type: 'application/pdf' });
}
async function ffSavePdf(d, name, opt) { const f = new File([await ffPdf(d, opt)], String(name || 'form').replace(/[^\w-]+/g, '_') + '.pdf', { type: 'application/pdf' });
  try { if (opt?.share && navigator.canShare?.({ files: [f] })) return await navigator.share({ files: [f], title: name }); } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast('Saved ' + f.name); }

/* ---------- The Forms section ---------- */
const FF = {
  // The starter forms go in once per workspace; after that they're the artist's to change or delete.
  async seed() { if (await DB.one(`SELECT 1 AS x FROM app_meta WHERE key = 'forms_dz'`)) return;
    for (const t of dzLayouts('form').filter(t => t.make)) { await DZF.load('Inter').catch(() => {}); const doc = dzNew('form', t, 'paper'); await DB.run('INSERT INTO designs (name, kind, doc) VALUES (?, ?, ?)', [t.name, 'form', JSON.stringify(doc)]); }
    await DB.run(`INSERT INTO app_meta VALUES ('forms_dz', '1')`); },
  async all() { await FF.seed(); return (await DB.all(`SELECT id, name, doc FROM designs WHERE kind = 'form' ORDER BY name COLLATE NOCASE`)).map(r => { const doc = JSON.parse(r.doc); return { id: r.id, name: r.name, doc, cat: doc.form?.cat || 'other' }; }); },
  async list() {
    const forms = await FF.all(), done = await DB.all('SELECT id, kind, title, client_name, signed_at FROM signed_forms ORDER BY signed_at DESC LIMIT 20'), el = $('#f-list');
    const sec = ([cat, name]) => { const L = forms.filter(f => f.cat === cat); return !L.length && cat === 'other' ? '' : `<div class="letter">${name}</div><div class="card list">${L.map(f => `
      <div class="c-row f-tpl"><span class="ava">${ICON.forms}</span><span class="c-main"><span class="c-n">${esc(f.name)}</span><span class="muted c-sub">${f.doc.pages || 1} page${(f.doc.pages || 1) > 1 ? 's' : ''}</span></span>
        <span class="f-acts"><button class="btn small" data-f="dup" data-id="${f.id}">Copy</button><button class="btn small" data-f="edit" data-id="${f.id}">Design</button><button class="btn small" data-f="print" data-id="${f.id}" data-tip="An empty copy to fill in by hand">Print</button><button class="btn small" data-f="pdf" data-id="${f.id}" data-tip="A PDF the client can fill in on their own device">PDF</button><button class="btn small primary" data-f="fill" data-id="${f.id}">Fill in</button></span></div>`).join('') || '<div class="muted" style="padding:14px">None yet.</div>'}</div>`; };
    el.innerHTML = `<div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="btn primary" data-f="new">+ New form</button></div>` + FF_CATS.map(sec).join('')
      + `<div class="letter">Completed</div><div class="card list">${done.map(r => `<a class="c-row" href="#signed/${r.id}"><span class="c-main"><span class="c-n">${esc(r.title)}</span><span class="muted c-sub">${esc(r.client_name || 'No client')} · ${new Date(r.signed_at + 'Z').toLocaleDateString()}</span></span><svg viewBox="0 0 24 24" class="chev"><path d="M9 6l6 6-6 6"/></svg></a>`).join('') || '<div class="muted" style="padding:14px">Forms you fill in are kept here and on the client\'s card.</div>'}</div>`;
    el.onclick = async (e) => { const b = e.target.closest('[data-f]'); if (!b) return; const a = b.dataset.f, f = forms.find(x => x.id === +b.dataset.id);
      if (a === 'new') return dzPicker({ kind: 'form' });
      if (a === 'edit') location.hash = 'design/' + f.id;
      if (a === 'fill') { Forms.ctx = {}; location.hash = 'form-sign/' + f.id; }
      if (a === 'print') return ffPrintBlank(f.doc);
      if (a === 'pdf') { toast('Preparing…'); return ffSavePdf(ffCopy(f.doc, ffBlankCtx()), f.name); }
      if (a === 'dup') { await DB.run('INSERT INTO designs (name, kind, doc) VALUES (?, ?, ?)', [f.name + ' (copy)', 'form', JSON.stringify(f.doc)]); toast('Copy made.'); FF.list(); } };
  },
  async fill(id) {
    const r = await DB.one(`SELECT name, doc FROM designs WHERE id = ? AND kind = 'form'`, [id]); if (!r) { location.hash = 'forms'; return; }
    $('#view-title').textContent = r.name;
    const ctx0 = Forms.ctx || {}, src = JSON.parse(r.doc); Forms.ctx = null;
    let client = ctx0.clientId ? await DB.one('SELECT * FROM clients WHERE id = ?', [ctx0.clientId]) : null;
    const booking = ctx0.bookingId ? await DB.one('SELECT * FROM bookings WHERE id = ?', [ctx0.bookingId]) : null;
    const el = $('#fs'), vals = {}, typed = new Set(), pads = {}, faces = ffFaces(src), cat = src.form?.cat || 'other'; let d;
    el.innerHTML = `<div class="card"><label class="field" style="margin:0"><span>Client</span><div class="picker"><input class="in" id="fs-client" placeholder="Search clients…" value="${esc(client ? fullName(client) : '')}" autocomplete="off"><div class="pick-list" id="fs-list" hidden></div></div></label></div>
      <div id="ff-pages">${faces.map(f => `<div class="ff-page" data-face="${f}"><canvas></canvas><div class="ff-over"></div></div>`).join('')}</div>
      <div class="form-foot row" style="background:var(--bg)"><button type="button" class="btn" id="fs-cancel">Cancel</button><button type="button" class="btn" id="fs-print">Print</button><button type="button" class="btn" id="fs-pdf">PDF</button><button type="button" class="btn primary" style="flex:1" id="fs-save">Save to client</button></div>`;
    const K = () => $('#ff-pages').clientWidth / src.w;
    const fontFit = () => { const k = K(); for (const n of el.querySelectorAll('[data-s]')) n.style.fontSize = n.dataset.s * k * 0.9 + 'px'; };
    const pct = (b, l) => `left:${(l.x + b.x) / src.w * 100}%;top:${(l.y + b.y) / src.h * 100}%;width:${b.w / src.w * 100}%;height:${b.h / src.h * 100}%`;
    const prefill = (c) => { for (const l of d.layers) if (l.t === 'field' && l.v && !typed.has(l.id)) vals[l.id] = fillPlaceholders(l.v, c).replace(/^_+$/, ''); };
    const paint = async () => { d = ffCopy(src, formCtx(client, booking)); prefill(formCtx(client, booking));
      for (const f of faces) { const host = el.querySelector(`.ff-page[data-face="${f}"]`), cv = await ffPage(d, f, { noVal: true }, Math.min(1, 1400 / d.w)), c = host.querySelector('canvas'); c.width = cv.width; c.height = cv.height; c.getContext('2d').drawImage(cv, 0, 0);
        const sigs = Object.fromEntries(Object.entries(pads).filter(([, p]) => !p.empty()).map(([i, p]) => [i, p.data()]));
        host.querySelector('.ff-over').innerHTML = d.layers.filter(l => l.t === 'field' && !l.hide && dzSide(l) === f).map(l => { const g = dzFieldGeom(l), a = `data-id="${l.id}" data-s="${l.size || 46}" aria-label="${esc(l.label || FF_TYPES.find(t => t[0] === l.ft)?.[1])}"`, v = vals[l.id] ?? '';
          if (l.ft === 'check') return `<input type="checkbox" class="ff-c" ${a} style="${pct(g.box, l)}" ${v ? 'checked' : ''}>`;
          if (l.ft === 'radio') return g.opts.map(o => `<input type="radio" class="ff-c" name="${l.id}" value="${esc(o.v)}" ${a} style="${pct({ x: o.x, y: o.y, w: o.d, h: o.d }, l)}" ${v === o.v ? 'checked' : ''}>`).join('');
          if (l.ft === 'combo') return `<select class="ff-i" ${a} style="${pct(g.box, l)}"><option value=""></option>${(l.opts || []).map(o => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
          if (l.ft === 'area') return `<textarea class="ff-i" ${a} style="${pct(g.box, l)}">${esc(v)}</textarea>`;
          if (l.ft === 'sign') return `<div class="ff-sign" style="${pct(g.box, l)}"><canvas data-sig="${l.id}"></canvas><button type="button" class="link" data-sigc="${l.id}">Clear</button></div>`;
          return `<input class="ff-i" type="${l.ft === 'date' ? 'date' : 'text'}" value="${esc(v)}" ${a} style="${pct(g.box, l)}">`; }).join('');
        for (const s of host.querySelectorAll('[data-sig]')) { const p = signaturePad(s); pads[s.dataset.sig] = p; if (sigs[s.dataset.sig]) p.restore(sigs[s.dataset.sig]); } }
      fontFit(); };
    await paint();
    new ResizeObserver(fontFit).observe($('#ff-pages'));
    const pagesEl = $('#ff-pages');
    pagesEl.addEventListener('input', (e) => { const t = e.target, i = t.dataset.id; if (!i) return; vals[i] = t.type === 'checkbox' ? t.checked : t.value; typed.add(i); Dirty.set(true); });
    pagesEl.addEventListener('click', (e) => { const c = e.target.dataset.sigc; if (c) pads[c]?.clear(); });
    clientPicker($('#fs-client'), $('#fs-list'), async (cid) => { client = await DB.one('SELECT * FROM clients WHERE id = ?', [cid]); await paint(); });
    $('#fs-cancel').onclick = () => history.back();
    const sigImgs = async () => { const o = {}; for (const [i, p] of Object.entries(pads)) if (!p.empty()) o[i] = await createImageBitmap(await p.blob()); return o; };
    const baked = async (scale = 1) => { const sigs = await sigImgs(), out = []; for (const f of faces) out.push(await ffPage(d, f, { vals, sigs }, scale)); return out; };
    $('#fs-print').onclick = async () => printCanvas(...await baked());
    $('#fs-pdf').onclick = async () => { toast('Preparing…'); ffSavePdf(d, r.name + (client ? '-' + fullName(client) : ''), { vals, sigs: await sigImgs(), share: true }); };
    let busy = false;
    $('#fs-save').onclick = async () => { if (busy) return;
      if (!client) return toast('Choose the client first.');
      for (const l of d.layers.filter(l => l.t === 'field' && l.req && !l.hide)) { const ok = l.ft === 'sign' ? pads[l.id] && !pads[l.id].empty() : !!vals[l.id];
        if (!ok) { el.querySelector(`[data-id="${l.id}"], [data-sig="${l.id}"]`)?.scrollIntoView({ block: 'center' }); return toast(l.ft === 'sign' ? 'Please sign in the box.' : l.ft === 'check' ? 'Every required box needs a tick.' : `Please answer "${(l.label || 'this field').slice(0, 50)}".`); } }
      busy = true; $('#fs-save').disabled = true;
      try { const refs = []; for (const cv of await baked(Math.min(1, 1654 / d.w))) refs.push(await Media.save(await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.88)), 'jpg'));
        const summary = d.layers.filter(l => l.t === 'field' && l.ft !== 'sign' && l.label).map(l => ({ t: l.ft, text: l.label, v: vals[l.id] ?? '' }));
        await DB.run(`INSERT INTO signed_forms (client_id, booking_id, kind, title, client_name, blocks, answers) VALUES (?, ?, ?, ?, ?, ?, ?)`, [client.id, ctx0.bookingId ?? null, cat, r.name, fullName(client), JSON.stringify(summary), JSON.stringify(vals)]);
        const sid = (await DB.one('SELECT last_insert_rowid() AS id')).id;
        await DB.tx(refs.map((ref, i) => ({ sql: 'INSERT INTO signed_form_pages (form_id, ref, sort) VALUES (?, ?, ?)', params: [sid, ref, i] })));
        Dirty.set(false); toast('Form saved.'); location.replace('#signed/' + sid);
      } catch (err) { busy = false; $('#fs-save').disabled = false; toast('Could not save: ' + err.message, 5000); } };
  },
  // A completed form: the flattened pages, exactly as they were saved.
  async view(id) {
    const s = await DB.one('SELECT * FROM signed_forms WHERE id = ?', [id]), el = $('#sf'); if (!s) { el.innerHTML = '<div class="card muted">Form not found.</div>'; return; }
    const pages = await DB.all('SELECT ref FROM signed_form_pages WHERE form_id = ? ORDER BY sort', [id]), urls = await Promise.all(pages.map(p => Media.url(p.ref)));
    el.innerHTML = `<p class="muted no-print">${esc(s.client_name || '')} · ${new Date(s.signed_at + 'Z').toLocaleString()}</p><div id="ff-pages">${urls.map(u => `<div class="ff-page"><img src="${u}" alt="Form page"></div>`).join('') || '<div class="card muted">This form has no saved pages.</div>'}</div>
      <div class="row no-print" style="margin:14px 0 24px">${s.client_id ? `<a class="btn" href="#client/${s.client_id}">Client</a>` : ''}<button class="btn danger" id="sf-del">Delete</button><button class="btn" id="sf-pdf">PDF</button><button class="btn primary" style="flex:1" id="sf-print">Print</button></div>`;
    const canv = async () => { const out = []; for (const i of el.querySelectorAll('.ff-page img')) { await i.decode(); const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); out.push(c); } return out; };
    $('#sf-print').onclick = async () => printCanvas(...await canv());
    $('#sf-pdf').onclick = async () => { const cs = await canv(); if (!cs.length) return;
      const d = { w: cs[0].width, h: cs[0].height, dpi: cs[0].width / 8.27, pages: cs.length, sides: 2, layers: cs.map(() => null) }; const pdf = await ffImagesPdf(cs, d); const f = new File([pdf], s.title.replace(/[^\w-]+/g, '_') + '.pdf', { type: 'application/pdf' }); const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast('Saved ' + f.name); };
    $('#sf-del').onclick = async () => { if (!await ask('Delete this completed form?\n\nThis cannot be undone.')) return;
      await DB.tx([{ sql: 'DELETE FROM signed_form_pages WHERE form_id = ?', params: [id] }, { sql: 'DELETE FROM signed_forms WHERE id = ?', params: [id] }]);
      for (const p of pages) await Media.release(p.ref); await Media.release(s.signature_ref); toast('Deleted.'); history.back(); };
  }
};
// A flat PDF from page pictures (a completed form).
async function ffImagesPdf(cs, d) { const parts = [ffEnc.encode('%PDF-1.5\n')], off = []; let at = parts[0].length, n = 2; const push = (b) => { parts.push(b); at += b.length; }, kids = [], body = [];
  const k = 72 / d.dpi, PW = (d.w * k).toFixed(2), PH = (d.h * k).toFixed(2);
  for (const c of cs) { const jpg = Uint8Array.from(atob(c.toDataURL('image/jpeg', 0.88).split(',')[1]), x => x.charCodeAt(0)), im = ++n, ct = ++n, pg = ++n, cmd = ffEnc.encode(`q ${PW} 0 0 ${PH} 0 0 cm /I Do Q`); kids.push(pg);
    body.push([im, [ffEnc.encode(`<</Type/XObject/Subtype/Image/Width ${c.width}/Height ${c.height}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpg.length}>>\nstream\n`), jpg, ffEnc.encode('\nendstream')]], [ct, [ffEnc.encode(`<</Length ${cmd.length}>>\nstream\n`), cmd, ffEnc.encode('\nendstream')]], [pg, [ffEnc.encode(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PW} ${PH}]/Contents ${ct} 0 R/Resources<</XObject<</I ${im} 0 R>>>>>>`)]]); }
  const all = [[1, [ffEnc.encode('<</Type/Catalog/Pages 2 0 R>>')]], [2, [ffEnc.encode(`<</Type/Pages/Count ${kids.length}/Kids[${kids.map(i => i + ' 0 R').join(' ')}]>>`)]], ...body];
  for (const [i, bs] of all) { off[i] = at; push(ffEnc.encode(`${i} 0 obj\n`)); bs.forEach(push); push(ffEnc.encode('\nendobj\n')); }
  const xref = at; push(ffEnc.encode(`xref\n0 ${n + 1}\n0000000000 65535 f \n${off.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<</Size ${n + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`));
  return new Blob(parts, { type: 'application/pdf' }); }
