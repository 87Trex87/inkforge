'use strict';
/* InkForge app shell: data layer client, migrations, router, tooltips, backup. */

/* ---------- Database (talks to lib/db-worker.js) ---------- */
const DB = (() => {
  const worker = new Worker('lib/db-worker.js');
  const pending = new Map();
  let seq = 0;
  worker.onmessage = (e) => {
    const { id, ok, res, error } = e.data;
    const p = pending.get(id); pending.delete(id);
    ok ? p.resolve(res) : p.reject(new Error(error));
  };
  const call = (op, args, transfer) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args }, transfer || []);
  });
  return {
    info: () => call('info'),
    all: async (sql, params) => (await call('exec', { sql, params })).rows,
    one: async (sql, params) => (await call('exec', { sql, params })).rows[0],
    run: (sql, params) => call('exec', { sql, params }),
    tx: (items) => call('tx', { items }),
    exportBytes: async () => (await call('export')).bytes,
    importBytes: (bytes) => call('import', { bytes }, [bytes.buffer])
  };
})();

/* Append-only. Never edit a past entry; add a new one. SCHEMA_VERSION = MIGRATIONS.length. */
const MIGRATIONS = [
  // v1: meta + settings
  `CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`,
  // v2: clients. photo_ref is a filename in the OPFS media folder, never bytes.
  `CREATE TABLE clients (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
     phone TEXT, email TEXT, instagram TEXT, dob TEXT, pronouns TEXT,
     medical TEXT, notes TEXT, tags TEXT, photo_ref TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE INDEX idx_clients_name ON clients (last_name COLLATE NOCASE, first_name COLLATE NOCASE);`,
  // v3: bookings. start_at is local time 'YYYY-MM-DDTHH:MM'. gcal_* reserved for Google sync.
  `CREATE TABLE bookings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
     start_at TEXT NOT NULL, duration_min INTEGER NOT NULL DEFAULT 120,
     description TEXT, placement TEXT, size TEXT,
     quote REAL, deposit REAL, deposit_paid INTEGER NOT NULL DEFAULT 0,
     notes TEXT, gcal_id TEXT, gcal_updated TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE INDEX idx_bookings_start ON bookings (start_at);
   CREATE INDEX idx_bookings_client ON bookings (client_id);
   CREATE TABLE booking_photos (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
     photo_ref TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX idx_bphotos_booking ON booking_photos (booking_id);`
];
const SCHEMA_VERSION = MIGRATIONS.length;

async function migrate() {
  await DB.run(MIGRATIONS[0]);
  const row = await DB.one(`SELECT value FROM app_meta WHERE key='schema_version'`);
  let v = row ? +row.value : 0;
  if (v > SCHEMA_VERSION) throw new Error(`Database is from a newer InkForge (v${v}).`);
  for (; v < SCHEMA_VERSION; v++) {
    await DB.tx([
      { sql: MIGRATIONS[v] },
      { sql: `INSERT OR REPLACE INTO app_meta VALUES ('schema_version', ?)`, params: [String(v + 1)] }
    ]);
  }
}

const Settings = {
  cache: {},
  async load() { for (const r of await DB.all('SELECT key, value FROM settings')) this.cache[r.key] = r.value; },
  get(k, d = '') { return this.cache[k] ?? d; },
  async set(k, v) { this.cache[k] = v; await DB.run('INSERT OR REPLACE INTO settings VALUES (?, ?)', [k, v]); }
};

/* Media files (photos etc.) live in OPFS /media as content-hash names; DB stores only the name. */
const Media = {
  urls: new Map(),
  async dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle('media', { create: true }); },
  async save(blob, ext) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
    const name = `${hash}.${ext}`;
    const fh = await (await this.dir()).getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
    return name;
  },
  async url(name) {
    if (!name) return '';
    if (this.urls.has(name)) return this.urls.get(name);
    try {
      const f = await (await (await this.dir()).getFileHandle(name)).getFile();
      const u = URL.createObjectURL(f); this.urls.set(name, u); return u;
    } catch { return ''; }
  },
  // Removes a file only if no row still references it.
  async release(name) {
    if (!name) return;
    const used = await DB.one(`SELECT 1 AS x FROM clients WHERE photo_ref = ?1
      UNION ALL SELECT 1 FROM booking_photos WHERE photo_ref = ?1 LIMIT 1`, [name]);
    if (used) return;
    try { await (await this.dir()).removeEntry(name); } catch {}
    const u = this.urls.get(name); if (u) { URL.revokeObjectURL(u); this.urls.delete(name); }
  },
  // Downscale an image file to a JPEG so phone camera shots stay small.
  async shrink(file, max = 640, q = 0.85) {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise(r => c.toBlob(r, 'image/jpeg', q));
  }
};

/* ---------- Helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const help = (text) => `<button class="help" data-tip="${esc(text)}" aria-label="Help">?</button>`;
const fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms);
}

/* ---------- Tooltips: hover on mouse, tap on touch ---------- */
(() => {
  const tip = $('#tip');
  const show = (el) => {
    tip.textContent = el.dataset.tip; tip.hidden = false;
    const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    let x = Math.min(Math.max(8, r.left + r.width / 2 - tr.width / 2), innerWidth - tr.width - 8);
    let y = r.top - tr.height - 8; if (y < 8) y = r.bottom + 8;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };
  const hide = () => tip.hidden = true;
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (el && matchMedia('(hover: hover)').matches) show(el); else hide();
  });
  document.addEventListener('click', e => {
    const el = e.target.closest('.help');
    if (el) { e.stopPropagation(); tip.hidden ? show(el) : hide(); clearTimeout(show._t); show._t = setTimeout(hide, 4000); }
    else hide();
  }, true);
  addEventListener('scroll', hide, true);
})();

/* ---------- Views ---------- */
const ICON = {
  stencil: '<svg viewBox="0 0 24 24"><path d="M4 20c4-1 6-5 8-9s5-6 8-7"/><path d="M4 4l16 16" stroke-dasharray="2 3"/></svg>',
  portfolio: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  forms: '<svg viewBox="0 0 24 24"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 13h8M8 17h5"/></svg>',
  reels: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/></svg>',
  quote: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M8 15h2M12 15h2M16 11v6"/></svg>',
  stock: '<svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/></svg>',
  rules: '<svg viewBox="0 0 24 24"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
};
const tile = (icon, title, tipText, soon, go) =>
  `<div class="card tile" ${go ? `data-go="${go}"` : ''} data-tip="${esc(tipText)}"><div class="ico">${ICON[icon]}</div>
   <div class="t">${title}</div>${soon ? '<span class="soon">Soon</span>' : ''}</div>`;

const VIEWS = {
  home: {
    title: () => 'InkForge',
    render() {
      const name = Settings.get('artist_name');
      const h = new Date().getHours();
      const greet = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
      const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      return `
      <div class="card hero">
        <div class="muted">${esc(today)}</div>
        <div class="big">${greet}${name ? ', ' + esc(name) : ''}</div>
        ${name ? '' : `<p class="muted">Set your name and studio in <a href="#more" style="color:var(--teal)">More &rsaquo; Settings</a>.</p>`}
      </div>
      <div class="card"><h2>Today ${help('Today\'s sessions. Tap one to open it.')}</h2>
        <div id="home-today" class="muted">…</div></div>
      <div class="grid">
        ${tile('stencil', 'Stencil maker', 'Turn a photo into a clean stencil', true)}
        ${tile('quote', 'Quick quote', 'Price a piece in seconds', true)}
      </div>`;
    },
    async mount() {
      const t = new Date(); t.setHours(0, 0, 0, 0);
      const rows = await bookingsBetween(t, addDays(t, 1));
      const el = $('#home-today'); if (!el) return;
      if (rows.length) { el.className = 'card list flush'; el.innerHTML = rows.map(agendaRow).join(''); }
      else el.innerHTML = `No sessions booked. <a href="#" id="h-add" style="color:var(--teal)">Book one</a>`;
      const a = $('#h-add'); if (a) a.onclick = (e) => { e.preventDefault(); newBooking(ymd(new Date()) + 'T' + Settings.get('day_start', '10:00')); };
    }
  },
  clients: {
    title: () => 'Clients',
    render: () => `
      <div class="search-bar">
        <input class="in" id="c-search" type="search" placeholder="Search name, phone, tag…" autocomplete="off" value="${esc(VIEWS.clients.q || '')}">
        <button class="btn primary icon-btn" id="c-add" data-tip="Add client" aria-label="Add client">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
      <div id="c-list"></div>`,
    mount() {
      const s = $('#c-search');
      s.addEventListener('input', () => { VIEWS.clients.q = s.value; renderClientList(); });
      $('#c-add').onclick = () => location.hash = 'client-edit/new';
      renderClientList();
    }
  },
  client: {
    title: () => 'Client',
    render: () => '<div id="c-detail"></div>',
    async mount(id) {
      const c = await DB.one('SELECT * FROM clients WHERE id = ?', [+id]);
      const el = $('#c-detail');
      if (!c) { el.innerHTML = '<div class="card muted">Client not found.</div>'; return; }
      $('#view-title').textContent = 'Client';
      const photo = await Media.url(c.photo_ref);
      const tel = (c.phone || '').replace(/[^\d+]/g, '');
      const ig = (c.instagram || '').replace(/^@/, '');
      const act = (href, icon, label, on) => on
        ? `<a class="act" href="${href}" ${href.startsWith('http') ? 'target="_blank" rel="noopener"' : ''}>${icon}<span>${label}</span></a>`
        : `<span class="act off">${icon}<span>${label}</span></span>`;
      const age = c.dob ? Math.floor((Date.now() - new Date(c.dob)) / 31557600000) : null;
      const field = (label, val) => val ? `<div class="stat"><span class="muted">${label}</span><span class="val">${esc(val)}</span></div>` : '';
      el.innerHTML = `
        <div class="card c-head">
          ${avatar(c, photo, 'lg')}
          <div class="c-name">${esc(fullName(c))}</div>
          ${c.pronouns ? `<div class="muted">${esc(c.pronouns)}</div>` : ''}
          ${tagChips(c.tags)}
          <div class="acts">
            ${act('tel:' + tel, '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>', 'Call', tel)}
            ${act('sms:' + tel, '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-12 7l-5 1 1-4a8 8 0 1 1 16-4z"/></svg>', 'Text', tel)}
            ${act('https://wa.me/' + tel.replace('+', ''), '<svg viewBox="0 0 24 24"><path d="M3 21l2-5a9 9 0 1 1 3 3z"/><path d="M9 9c0 3 3 6 6 6l1-2-2-1-1 1c-1 0-3-2-3-3l1-1-1-2z"/></svg>', 'WhatsApp', tel)}
            ${act('mailto:' + (c.email || ''), '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>', 'Email', c.email)}
            ${act('https://instagram.com/' + encodeURIComponent(ig), '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8"/></svg>', 'Insta', ig)}
          </div>
        </div>
        <div class="card"><h2>Details</h2>
          ${field('Phone', c.phone)}${field('Email', c.email)}${field('Instagram', ig && '@' + ig)}
          ${field('Birthday', c.dob && new Date(c.dob + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) + (age != null ? ` (${age})` : ''))}
          ${field('Client since', new Date(c.created_at + 'Z').toLocaleDateString())}
        </div>
        ${c.medical ? `<div class="card alert"><h2>Medical / allergies ${help('Check before every session.')}</h2><p class="pre">${esc(c.medical)}</p></div>` : ''}
        ${c.notes ? `<div class="card"><h2>Notes</h2><p class="pre">${esc(c.notes)}</p></div>` : ''}
        <div class="card"><h2>Bookings ${help('All sessions for this client, newest first.')}
            <button class="btn small" id="c-book" style="margin-left:auto">+ Book</button></h2>
          <div id="c-hist" class="muted">…</div></div>
        <div class="row" style="margin-bottom:20px">
          <button class="btn" onclick="location.hash='client-edit/${c.id}'">Edit</button>
          <button class="btn danger" id="c-del">Delete</button>
        </div>`;
      $('#c-book').onclick = () => newBooking(ymd(new Date()) + 'T' + Settings.get('day_start', '10:00'), c.id);
      const hist = await DB.all(`SELECT b.*, c.first_name, c.last_name, NULL AS medical FROM bookings b JOIN clients c ON c.id = b.client_id
        WHERE b.client_id = ? ORDER BY b.start_at DESC`, [c.id]);
      const he = $('#c-hist');
      if (he) {
        if (!hist.length) he.textContent = 'No bookings yet.';
        else {
          const total = hist.reduce((s, b) => s + (b.quote || 0), 0);
          he.className = 'card list flush';
          he.innerHTML = hist.map(b => agendaRow(b).replace(/<b>[^<]*<\/b><small/, `<b>${new Date(b.start_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' })}</b><small`)).join('')
            + `<div class="muted count">${hist.length} session${hist.length === 1 ? '' : 's'}${total ? ' · ' + money(total) + ' quoted' : ''}</div>`;
        }
      }
      $('#c-del').onclick = async () => {
        if (!confirm(`Delete ${fullName(c)}?\n\nThis permanently removes the client and their photo. Their bookings stay on the calendar without a client.`)) return;
        await DB.run('DELETE FROM clients WHERE id = ?', [c.id]);
        await Media.release(c.photo_ref);
        toast('Client deleted.'); location.hash = 'clients';
      };
    }
  },
  'client-edit': {
    title: (id) => id === 'new' ? 'New client' : 'Edit client',
    render: () => '<form id="c-form" class="card" autocomplete="off"></form>',
    async mount(id) {
      const c = id === 'new' ? {} : await DB.one('SELECT * FROM clients WHERE id = ?', [+id]);
      if (!c) { location.hash = 'clients'; return; }
      const f = $('#c-form');
      let photoRef = c.photo_ref || null, newPhoto = null;
      const inp = (name, label, type = 'text', extra = '') =>
        `<label class="field"><span>${label}</span><input class="in" name="${name}" type="${type}" value="${esc(c[name])}" ${extra}></label>`;
      f.innerHTML = `
        <div class="photo-pick">
          <label class="avatar-pick" data-tip="Add or change photo">
            <span id="f-ava">${avatar(c, await Media.url(photoRef), 'lg')}</span>
            <input type="file" accept="image/*" id="f-photo" hidden>
            <span class="cam"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></span>
          </label>
          ${photoRef ? '<button type="button" class="btn small" id="f-photo-rm">Remove photo</button>' : ''}
        </div>
        <div class="two">${inp('first_name', 'First name', 'text', 'required autocapitalize="words"')}${inp('last_name', 'Last name', 'text', 'autocapitalize="words"')}</div>
        <div class="two">${inp('phone', 'Phone', 'tel', 'inputmode="tel"')}${inp('email', 'Email', 'email', 'inputmode="email"')}</div>
        <div class="two">${inp('instagram', 'Instagram', 'text', 'placeholder="@handle" autocapitalize="off"')}${inp('pronouns', 'Pronouns', 'text', 'placeholder="optional"')}</div>
        <div class="two">${inp('dob', 'Birthday', 'date')}${inp('tags', 'Tags', 'text', 'placeholder="regular, blackwork"')}</div>
        <label class="field"><span>Medical / allergies ${help('Latex, blood thinners, skin conditions, etc. Shown highlighted on the client page.')}</span>
          <textarea class="in" name="medical" rows="2">${esc(c.medical)}</textarea></label>
        <label class="field"><span>Notes</span><textarea class="in" name="notes" rows="3">${esc(c.notes)}</textarea></label>
        <div class="form-foot row">
          <button type="button" class="btn" id="f-cancel">Cancel</button>
          <button type="submit" class="btn primary" style="flex:1">Save</button>
        </div>`;
      Dirty.set(false);
      f.addEventListener('input', () => Dirty.set(true));
      $('#f-photo').addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try {
          newPhoto = await Media.shrink(file);
          $('#f-ava').innerHTML = avatar(c, URL.createObjectURL(newPhoto), 'lg');
          Dirty.set(true);
        } catch { toast('Could not read that image.'); }
      });
      const rm = $('#f-photo-rm');
      if (rm) rm.onclick = () => { photoRef = null; newPhoto = null; $('#f-ava').innerHTML = avatar(c, '', 'lg'); rm.remove(); Dirty.set(true); };
      $('#f-cancel').onclick = () => history.back();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(f));
        for (const k in d) d[k] = d[k].trim();
        if (!d.first_name) return toast('First name is required.');
        d.instagram = d.instagram.replace(/^@/, '');
        d.tags = d.tags.split(',').map(t => t.trim()).filter(Boolean).join(', ');
        if (newPhoto) photoRef = await Media.save(newPhoto, 'jpg');
        const cols = ['first_name', 'last_name', 'phone', 'email', 'instagram', 'dob', 'pronouns', 'medical', 'notes', 'tags'];
        const vals = cols.map(k => d[k] || null); vals[0] = d.first_name; vals[1] = d.last_name || '';
        let cid = c.id;
        if (cid) {
          await DB.run(`UPDATE clients SET ${cols.map(k => k + ' = ?').join(', ')}, photo_ref = ?, updated_at = datetime('now') WHERE id = ?`, [...vals, photoRef, cid]);
          if (c.photo_ref && c.photo_ref !== photoRef) await Media.release(c.photo_ref);
        } else {
          await DB.run(`INSERT INTO clients (${cols.join(', ')}, photo_ref) VALUES (${cols.map(() => '?').join(', ')}, ?)`, [...vals, photoRef]);
          cid = (await DB.one('SELECT last_insert_rowid() AS id')).id;
        }
        Dirty.set(false);
        toast('Saved.');
        location.replace('#client/' + cid);
      });
    }
  },
  book: {
    title: () => 'Book',
    render: () => `
      <div class="cal-bar">
        <div class="seg" id="cal-mode">
          ${['day', 'week', 'month'].map(m => `<button data-m="${m}" class="${Cal.mode === m ? 'on' : ''}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}
        </div>
        <div class="row" style="gap:6px">
          <button class="btn icon-btn" id="cal-prev" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
          <button class="btn small" id="cal-today" style="min-height:46px">Today</button>
          <button class="btn icon-btn" id="cal-next" aria-label="Next"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
          <button class="btn primary icon-btn" id="cal-add" data-tip="New booking" aria-label="New booking"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
        </div>
      </div>
      <div class="cal-label" id="cal-label"></div>
      <div id="cal"></div>`,
    mount() {
      $('#cal-mode').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; Cal.mode = b.dataset.m; Settings.set('cal_mode', Cal.mode); render(); };
      $('#cal-prev').onclick = () => Cal.shift(-1);
      $('#cal-next').onclick = () => Cal.shift(1);
      $('#cal-today').onclick = () => { Cal.date = new Date(); renderCal(); };
      $('#cal-add').onclick = () => newBooking(ymd(Cal.date) + 'T' + Settings.get('day_start', '10:00'));
      renderCal();
    }
  },
  'booking-edit': {
    title: (id) => id === 'new' ? 'New booking' : 'Booking',
    render: () => '<form id="b-form" class="card" autocomplete="off"></form>',
    async mount(id) {
      const b = id === 'new'
        ? { start_at: Cal.prefill || ymd(new Date()) + 'T10:00', duration_min: 120, client_id: Cal.prefillClient || null }
        : await DB.one('SELECT * FROM bookings WHERE id = ?', [+id]);
      Cal.prefill = Cal.prefillClient = null;
      if (!b) { location.hash = 'book'; return; }
      const photos = b.id ? await DB.all('SELECT id, photo_ref FROM booking_photos WHERE booking_id = ? ORDER BY sort, id', [b.id]) : [];
      const keep = photos.map(p => p.photo_ref);       // existing refs still attached
      const added = [];                                 // new Blobs not yet saved
      let clientId = b.client_id;
      const client = clientId ? await DB.one('SELECT * FROM clients WHERE id = ?', [clientId]) : null;
      const cur = Settings.get('currency');
      const durOpts = []; for (let m = 30; m <= 600; m += 30) durOpts.push(m);
      const f = $('#b-form');
      f.innerHTML = `
        <label class="field"><span>Client ${help('Search existing clients, or type a new name and pick "Add" to create one.')}</span>
          <div class="picker">
            <input class="in" id="b-client" placeholder="Search clients…" value="${esc(client ? fullName(client) : '')}" autocomplete="off">
            <div class="pick-list" id="b-client-list" hidden></div>
          </div></label>
        <div class="two">
          <label class="field"><span>Date</span><input class="in" type="date" name="date" value="${b.start_at.slice(0, 10)}" required></label>
          <div class="two tight">
            <label class="field"><span>Start</span><input class="in" type="time" name="time" step="900" value="${b.start_at.slice(11, 16)}" required></label>
            <label class="field"><span>Length</span><select class="in" name="duration_min">${durOpts.map(m => `<option value="${m}" ${m === b.duration_min ? 'selected' : ''}>${fmtDur(m)}</option>`).join('')}</select></label>
          </div>
        </div>
        <label class="field"><span>Tattoo description</span><textarea class="in" name="description" rows="2" placeholder="e.g. Fine-line peony with stem">${esc(b.description)}</textarea></label>
        <div class="two">
          <label class="field"><span>Placement</span><input class="in" name="placement" value="${esc(b.placement)}" placeholder="Left forearm"></label>
          <label class="field"><span>Size</span><input class="in" name="size" value="${esc(b.size)}" placeholder="15 x 10 cm"></label>
        </div>
        <div class="two">
          <label class="field"><span>Quote${cur ? ` (${esc(cur)})` : ''}</span><input class="in" name="quote" type="number" inputmode="decimal" min="0" step="any" value="${b.quote ?? ''}"></label>
          <label class="field"><span>Deposit${cur ? ` (${esc(cur)})` : ''}</span>
            <div class="row" style="flex-wrap:nowrap"><input class="in" name="deposit" type="number" inputmode="decimal" min="0" step="any" value="${b.deposit ?? ''}">
            <label class="toggle" data-tip="Deposit received"><input type="checkbox" name="deposit_paid" ${b.deposit_paid ? 'checked' : ''}><span>Paid</span></label></div></label>
        </div>
        <div class="field"><span class="lbl">Reference photos ${help('Client references or your sketch. Stored on the device, included in backups.')}</span>
          <div class="thumbs" id="b-thumbs"></div></div>
        <label class="field"><span>Notes</span><textarea class="in" name="notes" rows="3">${esc(b.notes)}</textarea></label>
        <div class="form-foot row">
          ${b.id ? '<button type="button" class="btn danger icon-btn" id="b-del" data-tip="Delete booking" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' : ''}
          <button type="button" class="btn" id="b-cancel">Cancel</button>
          <button type="submit" class="btn primary" style="flex:1">Save</button>
        </div>`;

      // Client picker
      const ci = $('#b-client'), cl = $('#b-client-list');
      const pickClient = async () => {
        const q = ci.value.trim();
        const rows = await DB.all(`SELECT id, first_name, last_name, phone, photo_ref FROM clients
          WHERE (first_name || ' ' || last_name) LIKE ? ORDER BY first_name COLLATE NOCASE LIMIT 8`, ['%' + q + '%']);
        const urls = await Promise.all(rows.map(r => Media.url(r.photo_ref)));
        cl.innerHTML = rows.map((r, i) => `<button type="button" class="c-row" data-id="${r.id}">${avatar(r, urls[i])}
            <span class="c-main"><span class="c-n">${esc(fullName(r))}</span><span class="muted c-sub">${esc(r.phone || '')}</span></span></button>`).join('')
          + (q ? `<button type="button" class="c-row add" data-new="1"><span class="ava">+</span><span class="c-main"><span class="c-n">Add "${esc(q)}"</span><span class="muted c-sub">New client</span></span></button>` : '');
        cl.hidden = !cl.innerHTML;
      };
      ci.addEventListener('focus', pickClient);
      ci.addEventListener('input', () => { clientId = null; pickClient(); });
      ci.addEventListener('blur', () => setTimeout(() => cl.hidden = true, 150));
      cl.addEventListener('mousedown', e => e.preventDefault());
      cl.addEventListener('click', async (e) => {
        const r = e.target.closest('.c-row'); if (!r) return;
        if (r.dataset.new) {
          const [first, ...rest] = ci.value.trim().split(/\s+/);
          await DB.run('INSERT INTO clients (first_name, last_name) VALUES (?, ?)', [first, rest.join(' ')]);
          clientId = (await DB.one('SELECT last_insert_rowid() AS id')).id;
          toast('Client added. Fill in their details later.');
        } else {
          clientId = +r.dataset.id;
          ci.value = r.querySelector('.c-n').textContent;
        }
        cl.hidden = true; ci.blur(); Dirty.set(true);
      });

      // Reference photos
      const drawThumbs = async () => {
        const urls = await Promise.all(keep.map(r => Media.url(r)));
        $('#b-thumbs').innerHTML =
          keep.map((r, i) => `<div class="thumb"><img src="${urls[i]}" alt=""><button type="button" data-k="${i}" aria-label="Remove">&times;</button></div>`).join('') +
          added.map((a, i) => `<div class="thumb"><img src="${a.url}" alt=""><button type="button" data-a="${i}" aria-label="Remove">&times;</button></div>`).join('') +
          `<label class="thumb add" data-tip="Add photos"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><input type="file" accept="image/*" multiple hidden id="b-photo"></label>`;
        $('#b-photo').addEventListener('change', async (e) => {
          for (const file of e.target.files) {
            try { const blob = await Media.shrink(file, 1600, 0.82); added.push({ blob, url: URL.createObjectURL(blob) }); }
            catch { toast('Could not read an image.'); }
          }
          Dirty.set(true); drawThumbs();
        });
      };
      $('#b-thumbs').addEventListener('click', (e) => {
        const x = e.target.closest('button'); if (!x) return;
        if (x.dataset.k != null) keep.splice(+x.dataset.k, 1); else added.splice(+x.dataset.a, 1);
        Dirty.set(true); drawThumbs();
      });
      $('#b-thumbs').addEventListener('click', (e) => {
        const img = e.target.closest('.thumb img'); if (img) viewImage(img.src);
      });
      await drawThumbs();

      Dirty.set(false);
      f.addEventListener('input', (e) => { if (e.target !== ci) Dirty.set(true); });
      $('#b-cancel').onclick = () => history.back();
      const del = $('#b-del');
      if (del) del.onclick = async () => {
        if (!confirm('Delete this booking and its reference photos?')) return;
        await DB.run('DELETE FROM bookings WHERE id = ?', [b.id]);
        for (const p of photos) await Media.release(p.photo_ref);
        Dirty.set(false); toast('Booking deleted.'); history.back();
      };
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(f));
        if (ci.value.trim() && !clientId) return toast('Pick a client from the list, or choose "Add".');
        const num = (v) => v === '' || v == null ? null : +v;
        const vals = [clientId, d.date + 'T' + d.time, +d.duration_min, d.description.trim() || null, d.placement.trim() || null,
          d.size.trim() || null, num(d.quote), num(d.deposit), d.deposit_paid ? 1 : 0, d.notes.trim() || null];
        const cols = 'client_id, start_at, duration_min, description, placement, size, quote, deposit, deposit_paid, notes';
        const refs = [...keep];
        for (const a of added) refs.push(await Media.save(a.blob, 'jpg'));
        let bid = b.id;
        if (bid) await DB.run(`UPDATE bookings SET ${cols.split(', ').map(c => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...vals, bid]);
        else { await DB.run(`INSERT INTO bookings (${cols}) VALUES (${vals.map(() => '?').join(', ')})`, vals); bid = (await DB.one('SELECT last_insert_rowid() AS id')).id; }
        await DB.tx([{ sql: 'DELETE FROM booking_photos WHERE booking_id = ?', params: [bid] },
          ...refs.map((r, i) => ({ sql: 'INSERT INTO booking_photos (booking_id, photo_ref, sort) VALUES (?, ?, ?)', params: [bid, r, i] }))]);
        for (const p of photos) if (!refs.includes(p.photo_ref)) await Media.release(p.photo_ref);
        Cal.date = new Date(d.date + 'T00:00');
        Dirty.set(false); toast('Booking saved.');
        location.replace('#book');
      });
    }
  },
  studio: {
    title: () => 'Studio',
    render: () => `<div class="grid">
      ${tile('portfolio', 'Portfolio', 'Tattoos, art and flash', true)}
      ${tile('stencil', 'Stencil maker', 'Photo to stencil', true)}
      ${tile('forms', 'Consent & aftercare', 'Build and sign forms', true)}
      ${tile('reels', 'Reel maker', 'Quick, consistent tattoo reels', true)}</div>`
  },
  more: {
    title: () => 'More',
    render: () => `<div class="grid">
      ${tile('settings', 'Settings & backup', 'Profile, storage, backup and restore', false, 'settings')}
      ${tile('quote', 'Quote calculator', 'Pricing rules', true)}
      ${tile('stock', 'Inventory', 'Stock and stock takes', true)}
      ${tile('rules', 'Rule book', 'Your studio rules', true)}</div>`
  },
  settings: {
    title: () => 'Settings',
    render() {
      return `
      <div class="card"><h2>Profile ${help('Shown on your home screen, and later on forms and exports.')}</h2>
        <label class="field"><span>Artist name</span><input class="in" id="s-name" value="${esc(Settings.get('artist_name'))}" autocomplete="name"></label>
        <label class="field"><span>Studio</span><input class="in" id="s-studio" value="${esc(Settings.get('studio_name'))}"></label>
        <div class="two">
          <label class="field"><span>Currency symbol ${help('Shown before quotes and deposits, e.g. R, $, £, €.')}</span><input class="in" id="s-cur" value="${esc(Settings.get('currency'))}" maxlength="4"></label>
          <label class="field"><span>Usual start time ${help('Default time for new bookings.')}</span><input class="in" id="s-start" type="time" value="${esc(Settings.get('day_start', '10:00'))}"></label>
        </div>
      </div>
      <div class="card"><h2>Storage ${help('Data is kept in an on-device SQLite database, not browser localStorage. "Protected" asks the browser never to clear it automatically.')}</h2>
        <div id="storage-info" class="muted">Checking…</div>
      </div>
      <div class="card"><h2>Backup ${help('Save a full copy of your database to a file, e.g. to cloud drive. Restore replaces everything on this device with the backup.')}</h2>
        <div id="last-backup" class="muted" style="margin-bottom:12px"></div>
        <div class="row">
          <button class="btn primary" id="b-export">Save backup</button>
          <button class="btn danger" id="b-import">Restore…</button>
        </div>
      </div>`;
    },
    async mount() {
      const save = (k) => (e) => Settings.set(k, e.target.value.trim());
      $('#s-name').addEventListener('change', save('artist_name'));
      $('#s-studio').addEventListener('change', save('studio_name'));
      $('#s-cur').addEventListener('change', save('currency'));
      $('#s-start').addEventListener('change', save('day_start'));
      $('#b-export').onclick = exportBackup;
      $('#b-import').onclick = () => $('#import-file').click();
      const lb = Settings.get('last_backup');
      $('#last-backup').textContent = lb ? 'Last backup: ' + new Date(lb).toLocaleString() : 'No backup yet.';
      await renderStorage();
    }
  }
};

async function renderStorage() {
  const el = $('#storage-info'); if (!el) return;
  const info = await DB.info();
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  const pct = est.quota ? Math.max(1, Math.round(est.usage / est.quota * 100)) : 0;
  el.innerHTML = `
    <div class="stat"><span>Engine</span><span>SQLite ${esc(info.sqlite)} · ${info.mode === 'opfs' ? 'on device' : '<b style="color:var(--red)">memory only</b>'}</span></div>
    <div class="stat"><span>Schema</span><span>v${SCHEMA_VERSION}</span></div>
    <div class="stat"><span>Used</span><span>${est.usage != null ? fmtBytes(est.usage) + ' of ' + fmtBytes(est.quota) : 'unknown'}</span></div>
    <div class="meter"><i style="width:${pct}%"></i></div>
    <div class="row" style="margin-top:12px"><span>${persisted ? '<span class="badge ok">Protected</span>' : '<span class="badge warn">Not protected</span>'}</span>
      ${persisted ? '' : '<button class="btn" id="b-persist">Protect storage</button>'}</div>`;
  const b = $('#b-persist');
  if (b) b.onclick = async () => {
    const ok = await navigator.storage.persist();
    toast(ok ? 'Storage protected.' : 'Browser declined. Installing the app to your home screen usually allows it.');
    renderStorage();
  };
}

/* Backup file: "INKFORGE1" + u32 manifest length + JSON manifest + db bytes + media bytes.
   Plain SQLite files (older backups) are still accepted on restore. */
const BACKUP_MAGIC = 'INKFORGE1';
async function buildBackup() {
  const db = await DB.exportBytes();
  const media = [];
  for await (const [name, h] of (await Media.dir()).entries()) {
    if (h.kind === 'file') media.push({ name, bytes: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
  }
  const manifest = new TextEncoder().encode(JSON.stringify({ v: 1, db: db.length, media: media.map(m => ({ name: m.name, len: m.bytes.length })) }));
  const head = new Uint8Array(BACKUP_MAGIC.length + 4);
  head.set(new TextEncoder().encode(BACKUP_MAGIC));
  new DataView(head.buffer).setUint32(BACKUP_MAGIC.length, manifest.length);
  return new Blob([head, manifest, db, ...media.map(m => m.bytes)]);
}
async function restoreBackup(bytes) {
  const magic = new TextDecoder().decode(bytes.slice(0, 15));
  if (magic === 'SQLite format 3') return DB.importBytes(bytes);
  if (!magic.startsWith(BACKUP_MAGIC)) throw new Error('That file is not an InkForge backup.');
  const mlen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(BACKUP_MAGIC.length);
  let off = BACKUP_MAGIC.length + 4;
  const man = JSON.parse(new TextDecoder().decode(bytes.subarray(off, off + mlen))); off += mlen;
  const db = bytes.slice(off, off + man.db); off += man.db;
  const dir = await Media.dir();
  for (const m of man.media) {
    const w = await (await dir.getFileHandle(m.name, { create: true })).createWritable();
    await w.write(bytes.subarray(off, off + m.len)); await w.close(); off += m.len;
  }
  for (const u of Media.urls.values()) URL.revokeObjectURL(u);
  Media.urls.clear();
  return DB.importBytes(db);
}

async function exportBackup() {
  const bytes = await buildBackup();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const name = `InkForge-${stamp}.inkforge`;
  const file = new File([bytes], name, { type: 'application/octet-stream' });
  // Phones: share sheet (save to Files / Drive). Desktop: download.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'InkForge backup' }); }
    catch (e) { if (e.name === 'AbortError') return; throw e; }
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  await Settings.set('last_backup', new Date().toISOString());
  if (location.hash === '#settings') render();
  toast('Backup saved.');
}

$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  const magic = new TextDecoder().decode(bytes.slice(0, 15));
  if (magic !== 'SQLite format 3' && !magic.startsWith(BACKUP_MAGIC)) return toast('That file is not an InkForge backup.');
  if (!confirm(`Restore "${f.name}"?\n\nEverything currently on this device will be replaced. This cannot be undone.`)) return;
  try {
    await restoreBackup(bytes);
    await migrate(); Settings.cache = {}; await Settings.load();
    toast('Backup restored.'); render();
  } catch (err) { toast('Restore failed: ' + err.message, 5000); }
});

/* ---------- Calendar ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtDur = (m) => (m >= 60 ? Math.floor(m / 60) + 'h' : '') + (m % 60 ? (m % 60) + 'm' : '');
const fmtTime = (s) => new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const money = (v) => v == null ? '' : (Settings.get('currency') || '') + (+v).toLocaleString(undefined, { maximumFractionDigits: 2 });
const HOUR_PX = 60, DAY_FROM = 7, DAY_TO = 23;

const Cal = {
  mode: null, date: new Date(), prefill: null, prefillClient: null,
  weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return addDays(x, -((x.getDay() + 6) % 7)); }, // Monday
  shift(dir) {
    const d = new Date(this.date);
    if (this.mode === 'month') { d.setDate(1); d.setMonth(d.getMonth() + dir); }
    else d.setDate(d.getDate() + (this.mode === 'week' ? 7 : 1) * dir);
    this.date = d; renderCal();
  }
};
function newBooking(startAt, clientId) { Cal.prefill = startAt; Cal.prefillClient = clientId || null; location.hash = 'booking-edit/new'; }

async function bookingsBetween(from, to) {
  return DB.all(`SELECT b.*, c.first_name, c.last_name, c.medical,
      (SELECT photo_ref FROM booking_photos p WHERE p.booking_id = b.id ORDER BY sort, id LIMIT 1) AS cover
    FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
    WHERE b.start_at >= ? AND b.start_at < ? ORDER BY b.start_at`, [ymd(from), ymd(to)]);
}
const bName = (b) => b.first_name != null ? fullName(b) : 'No client';

async function renderCal() {
  const el = $('#cal'); if (!el) return;
  const d = Cal.date, mode = Cal.mode;
  const label = $('#cal-label');
  if (mode === 'month') {
    label.textContent = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const start = Cal.weekStart(first), end = addDays(start, 42);
    const rows = await bookingsBetween(start, end);
    const byDay = {};
    rows.forEach(b => (byDay[b.start_at.slice(0, 10)] ||= []).push(b));
    const today = ymd(new Date()), sel = ymd(d);
    let html = '<div class="month"><div class="wk">' + ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(x => `<span>${x}</span>`).join('') + '</div><div class="mgrid">';
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i), k = ymd(day), list = byDay[k] || [];
      html += `<button class="mday ${day.getMonth() !== d.getMonth() ? 'out' : ''} ${k === today ? 'today' : ''} ${k === sel ? 'sel' : ''}" data-d="${k}">
        <span class="n">${day.getDate()}</span>
        <span class="pips">${list.slice(0, 3).map(() => '<i></i>').join('')}${list.length > 3 ? '<b>+</b>' : ''}</span></button>`;
    }
    html += '</div></div>';
    const dayList = byDay[sel] || [];
    html += `<div class="day-head">${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>`
      + (dayList.length ? '<div class="card list">' + dayList.map(agendaRow).join('') + '</div>'
        : `<div class="empty muted" style="padding:20px">Free day. <a href="#" id="m-add" style="color:var(--teal)">Book it</a></div>`);
    if ($('#cal') !== el) return;
    el.innerHTML = html;
    el.querySelector('.mgrid').onclick = (e) => {
      const b = e.target.closest('.mday'); if (!b) return;
      if (b.dataset.d === sel) return newBooking(sel + 'T' + Settings.get('day_start', '10:00'));
      Cal.date = new Date(b.dataset.d + 'T00:00'); renderCal();
    };
    const ma = $('#m-add'); if (ma) ma.onclick = (e) => { e.preventDefault(); newBooking(sel + 'T' + Settings.get('day_start', '10:00')); };
    return;
  }
  // Day / week timeline
  const days = mode === 'week' ? [...Array(7)].map((_, i) => addDays(Cal.weekStart(d), i)) : [new Date(d.getFullYear(), d.getMonth(), d.getDate())];
  label.textContent = mode === 'week'
    ? `${days[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const rows = await bookingsBetween(days[0], addDays(days[days.length - 1], 1));
  const today = ymd(new Date());
  let html = `<div class="tl ${mode}"><div class="tl-head"><span></span>${days.map(x => `<button class="tl-day ${ymd(x) === today ? 'today' : ''}" data-d="${ymd(x)}">
      <small>${x.toLocaleDateString(undefined, { weekday: 'short' })}</small><b>${x.getDate()}</b></button>`).join('')}</div>
    <div class="tl-body" id="tl-body"><div class="tl-hours">`;
  for (let h = DAY_FROM; h < DAY_TO; h++) html += `<span style="height:${HOUR_PX}px">${pad(h)}:00</span>`;
  html += '</div>';
  for (const day of days) {
    const k = ymd(day);
    const list = rows.filter(b => b.start_at.startsWith(k));
    // Overlap lanes: greedy assignment
    const lanes = [];
    list.forEach(b => {
      const s = minutesOf(b.start_at), e = s + b.duration_min;
      let li = lanes.findIndex(end => end <= s); if (li < 0) { li = lanes.length; lanes.push(0); }
      lanes[li] = e; b._lane = li;
    });
    html += `<div class="tl-col" data-d="${k}" style="height:${(DAY_TO - DAY_FROM) * HOUR_PX}px">`;
    if (k === today) {
      const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
      if (m >= DAY_FROM * 60 && m < DAY_TO * 60) html += `<div class="now" style="top:${(m - DAY_FROM * 60) / 60 * HOUR_PX}px"></div>`;
    }
    list.forEach(b => {
      const top = (minutesOf(b.start_at) - DAY_FROM * 60) / 60 * HOUR_PX, h = Math.max(22, b.duration_min / 60 * HOUR_PX - 2);
      const w = 100 / lanes.length;
      html += `<a class="ev ${b.deposit_paid ? 'paid' : ''}" href="#booking-edit/${b.id}" style="top:${top}px;height:${h}px;left:${b._lane * w}%;width:calc(${w}% - 3px)">
        <b>${esc(mode === 'week' ? (b.first_name || '—') : bName(b))}</b>
        ${mode === 'day' ? `<span>${fmtTime(b.start_at)} · ${fmtDur(b.duration_min)}${b.placement ? ' · ' + esc(b.placement) : ''}</span>
        ${b.description ? `<span class="muted">${esc(b.description)}</span>` : ''}` : ''}</a>`;
    });
    html += '</div>';
  }
  html += '</div></div>';
  if ($('#cal') !== el) return;
  el.innerHTML = html;
  const body = $('#tl-body');
  body.scrollTop = (Math.max(DAY_FROM, (rows[0] ? +rows[0].start_at.slice(11, 13) : 9) - 1) - DAY_FROM) * HOUR_PX;
  el.querySelector('.tl-head').onclick = (e) => {
    const b = e.target.closest('.tl-day'); if (!b || mode === 'day') return;
    Cal.date = new Date(b.dataset.d + 'T00:00'); Cal.mode = 'day'; render();
  };
  body.addEventListener('click', (e) => {
    const col = e.target.closest('.tl-col'); if (!col || e.target.closest('.ev')) return;
    const y = e.clientY - col.getBoundingClientRect().top;
    const m = DAY_FROM * 60 + Math.floor(y / HOUR_PX * 2) * 30;
    newBooking(`${col.dataset.d}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  });
}
const minutesOf = (s) => +s.slice(11, 13) * 60 + +s.slice(14, 16);

function agendaRow(b) {
  const end = new Date(new Date(b.start_at).getTime() + b.duration_min * 60000);
  return `<a class="c-row" href="#booking-edit/${b.id}">
    <span class="time-col"><b>${fmtTime(b.start_at)}</b><small class="muted">${fmtTime(end)}</small></span>
    <span class="c-main"><span class="c-n">${esc(bName(b))}${b.medical ? ' <span class="dot" data-tip="Has medical notes"></span>' : ''}</span>
      <span class="muted c-sub">${esc([b.placement, b.description].filter(Boolean).join(' · ') || fmtDur(b.duration_min))}</span></span>
    ${b.quote != null ? `<span class="price ${b.deposit_paid ? 'paid' : ''}" data-tip="${b.deposit_paid ? 'Deposit paid' : 'Deposit not paid'}">${money(b.quote)}</span>` : ''}
    <svg viewBox="0 0 24 24" class="chev"><path d="M9 6l6 6-6 6"/></svg></a>`;
}

function viewImage(src) {
  const o = document.createElement('div');
  o.id = 'img-viewer'; o.innerHTML = `<img src="${src}" alt="">`;
  o.onclick = () => o.remove();
  document.body.appendChild(o);
}

/* ---------- Clients helpers ---------- */
const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed';
function avatar(c, url, size = '') {
  const ini = ((c.first_name || '?').charAt(0) + (c.last_name || '').charAt(0)).toUpperCase();
  return url ? `<img class="ava ${size}" src="${url}" alt="">` : `<span class="ava ${size}">${esc(ini)}</span>`;
}
const tagChips = (tags) => tags ? `<div class="chips">${tags.split(',').map(t => `<span class="chip">${esc(t.trim())}</span>`).join('')}</div>` : '';

async function renderClientList() {
  const el = $('#c-list'); if (!el) return;
  const q = (VIEWS.clients.q || '').trim();
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const digits = q.replace(/\D/g, '');
  const rows = await DB.all(
    `SELECT id, first_name, last_name, phone, tags, medical, photo_ref FROM clients
     WHERE ?1 = '' OR (first_name || ' ' || last_name) LIKE ?2 OR email LIKE ?2 OR instagram LIKE ?2 OR tags LIKE ?2
       OR (?3 <> '' AND replace(replace(replace(phone,' ',''),'-',''),'+','') LIKE '%' || ?3 || '%')
     ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE`, [q, like, digits]);
  if ($('#c-list') !== el) return;
  if (!rows.length) {
    el.innerHTML = q ? '<div class="empty muted">No matches.</div>'
      : `<div class="empty"><div class="empty-ico"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/></svg></div>
         <div style="font:24px var(--display)">No clients yet</div><div class="muted">Tap + to add your first.</div></div>`;
    return;
  }
  const urls = await Promise.all(rows.map(r => Media.url(r.photo_ref)));
  let html = '', letter = '';
  rows.forEach((c, i) => {
    const L = (c.first_name || '#').charAt(0).toUpperCase();
    if (L !== letter) { if (letter) html += '</div>'; letter = L; html += `<div class="letter">${esc(L)}</div><div class="card list">`; }
    html += `<a class="c-row" href="#client/${c.id}">${avatar(c, urls[i])}
      <span class="c-main"><span class="c-n">${esc(fullName(c))}</span><span class="muted c-sub">${esc(c.phone || c.tags || '')}</span></span>
      ${c.medical ? '<span class="dot" data-tip="Has medical notes"></span>' : ''}
      <svg viewBox="0 0 24 24" class="chev"><path d="M9 6l6 6-6 6"/></svg></a>`;
  });
  el.innerHTML = html + '</div>' + `<div class="muted count">${rows.length} client${rows.length === 1 ? '' : 's'}</div>`;
}

/* Unsaved-form guard: navigating away from a dirty form asks first. */
const Dirty = {
  on: false,
  set(v) { this.on = v; },
  ok() { return !this.on || confirm('Discard unsaved changes?'); }
};
addEventListener('beforeunload', e => { if (Dirty.on) e.preventDefault(); });

/* ---------- Router ---------- */
const NAV_PARENT = { settings: 'more', client: 'clients', 'client-edit': 'clients', 'booking-edit': 'book' };
let currentHash = location.hash;
function render() {
  if (location.hash !== currentHash && !Dirty.ok()) { history.replaceState(null, '', currentHash || '#'); return; }
  Dirty.set(false);
  currentHash = location.hash;
  const [key, arg] = (location.hash.slice(1) || 'home').split('/');
  const v = VIEWS[key] || VIEWS.home;
  $('#view-title').textContent = v.title(arg);
  const view = $('#view');
  view.innerHTML = v.render(arg);
  view.style.animation = 'none'; view.offsetHeight; view.style.animation = '';
  const active = NAV_PARENT[key] || key;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === active));
  $('#main').scrollTop = 0;
  v.mount?.(arg);
}
$('#nav').addEventListener('click', e => {
  const b = e.target.closest('.nav-btn'); if (b) location.hash = b.dataset.view;
});
$('#view').addEventListener('click', e => {
  const t = e.target.closest('[data-go]'); if (t) location.hash = t.dataset.go;
});
addEventListener('hashchange', render);

/* ---------- Boot ---------- */
(async () => {
  const badge = $('#db-badge');
  try {
    await migrate();
    await Settings.load();
    Cal.mode = Settings.get('cal_mode', innerWidth >= 900 ? 'week' : 'day');
    const info = await DB.info();
    badge.textContent = info.mode === 'opfs' ? 'Saved on device' : 'Not saving';
    badge.className = 'badge ' + (info.mode === 'opfs' ? 'ok' : 'warn');
    badge.dataset.tip = info.mode === 'opfs'
      ? 'Your data is in an on-device SQLite database.'
      : 'This browser blocked on-device storage, so changes are lost on reload. Use https or localhost.';
  } catch (err) {
    badge.textContent = 'DB error'; badge.className = 'badge warn'; badge.dataset.tip = err.message;
    console.error(err);
  }
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
})();
