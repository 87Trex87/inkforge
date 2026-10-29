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
   CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`
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
      <div class="card"><h2>Today ${help('Your appointments for today will appear here once Booking is built.')}</h2>
        <p class="muted" style="margin:0">No sessions booked.</p></div>
      <div class="grid">
        ${tile('stencil', 'Stencil maker', 'Turn a photo into a clean stencil', true)}
        ${tile('quote', 'Quick quote', 'Price a piece in seconds', true)}
      </div>`;
    }
  },
  clients: { title: () => 'Clients', render: () => `<div class="card"><h2>Phonebook ${help('Client details, history, photos and forms. Built in section 2.')}</h2><p class="muted" style="margin:0">Coming next.</p></div>` },
  book: { title: () => 'Book', render: () => `<div class="card"><h2>Calendar ${help('Appointments with reference photos. Built in section 3.')}</h2><p class="muted" style="margin:0">Coming soon.</p></div>` },
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

async function exportBackup() {
  const bytes = await DB.exportBytes();
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
  if (magic !== 'SQLite format 3') return toast('That file is not an InkForge backup.');
  if (!confirm(`Restore "${f.name}"?\n\nEverything currently on this device will be replaced. This cannot be undone.`)) return;
  try {
    await DB.importBytes(bytes);
    await migrate(); Settings.cache = {}; await Settings.load();
    toast('Backup restored.'); render();
  } catch (err) { toast('Restore failed: ' + err.message, 5000); }
});

/* ---------- Router ---------- */
const NAV_PARENT = { settings: 'more' };
function render() {
  const key = location.hash.slice(1) || 'home';
  const v = VIEWS[key] || VIEWS.home;
  $('#view-title').textContent = v.title();
  const view = $('#view');
  view.innerHTML = v.render();
  view.style.animation = 'none'; view.offsetHeight; view.style.animation = '';
  const active = NAV_PARENT[key] || key;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === active));
  $('#main').scrollTop = 0;
  v.mount?.();
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
