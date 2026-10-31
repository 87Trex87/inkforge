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
    run: (sql, params) => call('exec', { sql, params }).finally(() => Snapshot.soon()),
    tx: (items) => call('tx', { items }).finally(() => Snapshot.soon()),
    open: (path) => call('open', { path }),
    drop: (path) => call('drop', { path }),
    exportBytes: async (path) => (await call('export', { path })).bytes,
    importBytes: (bytes) => call('import', { bytes }, [bytes.buffer]).finally(() => Snapshot.soon()),
    peek: async (bytes) => (await call('peek', { bytes }, [bytes.buffer])).tables
  };
})();

/* Safety net: a copy of the database kept as a plain OPFS file, outside the SQLite storage pool.
   Written a few seconds after changes and when the app goes to the background. If the app ever
   starts on an empty database while a snapshot exists, boot restores it. An empty database is
   never snapshotted, so a good copy can't be overwritten by a blank one. */
const Snapshot = {
  ready: false, _t: null,
  async handle(create) {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('snapshots', { create: true });
    return d.getFileHandle(WS.snapName(WS.cur), { create });
  },
  soon() { if (!this.ready) return; clearTimeout(this._t); this._t = setTimeout(() => this.save(), 4000); },
  async save() {
    clearTimeout(this._t);
    if (!this.ready) return;
    try {
      if (!(await hasData())) return;
      const bytes = await DB.exportBytes();
      const w = await (await this.handle(true)).createWritable();
      await w.write(bytes); await w.close();
    } catch (e) { console.warn('Snapshot failed:', e); }
  },
  async load() {
    try { const f = await (await this.handle(false)).getFile(); return f.size ? new Uint8Array(await f.arrayBuffer()) : null; }
    catch { return null; }
  }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) Snapshot.save(); });

/* ---------- Workspaces ----------
   Each workspace (e.g. one per artist) is its own database file, media folder and snapshot.
   The list lives in OPFS as workspaces.json (not localStorage). The original single database
   is the workspace "main", keeping its old file names, so existing data needs no migration. */
const WS = {
  list: [], last: null, auto: false, cur: null,
  dbPath: (w) => w.id === 'main' ? '/inkforge.db' : `/ws-${w.id}.db`,
  mediaName: (w) => w.id === 'main' ? 'media' : `media-${w.id}`,
  snapName: (w) => w.id === 'main' ? 'latest.sqlite' : `ws-${w.id}.sqlite`,
  async file(create) { return (await navigator.storage.getDirectory()).getFileHandle('workspaces.json', { create }); },
  async load() {
    try { Object.assign(this, JSON.parse(await (await (await this.file(false)).getFile()).text())); } catch {}
    if (!this.list.length) this.list = [{ id: 'main', name: 'My workspace', created: new Date().toISOString(), opened: null }];
  },
  async save() {
    const w = await (await this.file(true)).createWritable();
    await w.write(JSON.stringify({ list: this.list, last: this.last, auto: this.auto })); await w.close();
  },
  get: (id) => WS.list.find(w => w.id === id),
  async create(name) {
    const w = { id: Date.now().toString(36), name, created: new Date().toISOString(), opened: null };
    this.list.push(w); await this.save(); return w;
  },
  // Opening switches the database, media folder and snapshot to this workspace.
  async open(w) {
    this.cur = w;
    await DB.open(this.dbPath(w));
    w.opened = new Date().toISOString(); this.last = w.id; await this.save();
  },
  async remove(w) {
    await DB.drop(this.dbPath(w));
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(this.mediaName(w), { recursive: true }); } catch {}
    try { await (await root.getDirectoryHandle('snapshots')).removeEntry(this.snapName(w)); } catch {}
    this.list = this.list.filter(x => x !== w); if (this.last === w.id) this.last = null;
    await this.save();
  },
  // Switching reloads the page so no state from the previous workspace can leak into the next.
  switchTo(id) {
    try { sessionStorage.setItem('ws-open', id || ''); sessionStorage.setItem('ws-start', id ? '' : '1'); } catch {}
    location.hash = 'home'; location.reload();
  }
};
// A database "has data" once migrations have created app_meta (sqlite_sequence alone doesn't count).
const hasData = async () => !!(await DB.one(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'`));

/* Append-only. Never edit a past entry; add a new one. SCHEMA_VERSION = MIGRATIONS.length.
   Adding a table? Also add it to MERGE_TABLES (backup merge). Full backups include every table
   and media file automatically; merge needs to know which section a table belongs to. */
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
   CREATE INDEX idx_bphotos_booking ON booking_photos (booking_id);`,
  // v4: Google Calendar sync. gcal_synced_at = local updated_at value last pushed/pulled.
  `ALTER TABLE bookings ADD COLUMN gcal_synced_at TEXT;
   CREATE TABLE gcal_deletes (gcal_id TEXT PRIMARY KEY);
   CREATE TABLE gcal_busy (start_at TEXT NOT NULL, end_at TEXT NOT NULL);
   CREATE INDEX idx_gcal_busy ON gcal_busy (start_at);`,
  // v5: forms. blocks = JSON array of {t: 'h'|'p'|'check'|'field', text}. Signed forms keep a
  // frozen copy of the blocks so later template edits never change what a client signed.
  `CREATE TABLE form_templates (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL CHECK (kind IN ('consent', 'aftercare')),
     title TEXT NOT NULL, blocks TEXT NOT NULL DEFAULT '[]',
     updated_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE TABLE signed_forms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
     booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
     template_id INTEGER REFERENCES form_templates(id) ON DELETE SET NULL,
     kind TEXT NOT NULL, title TEXT NOT NULL, client_name TEXT,
     blocks TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '{}',
     signature_ref TEXT, signed_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE INDEX idx_signed_client ON signed_forms (client_id);`,
  // v6: portfolio. Each photo has a full-size ref and a small grid thumbnail ref.
  `CREATE TABLE portfolio_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL CHECK (kind IN ('tattoo', 'art', 'flash')),
     title TEXT, description TEXT, placement TEXT, tags TEXT,
     client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
     booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
     made_on TEXT, price REAL, claimed INTEGER NOT NULL DEFAULT 0,
     favourite INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE INDEX idx_pf_kind ON portfolio_items (kind, made_on);
   CREATE INDEX idx_pf_client ON portfolio_items (client_id);
   CREATE TABLE portfolio_photos (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     item_id INTEGER NOT NULL REFERENCES portfolio_items(id) ON DELETE CASCADE,
     photo_ref TEXT NOT NULL, thumb_ref TEXT NOT NULL, label TEXT, sort INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX idx_pf_photos ON portfolio_photos (item_id);`,
  // v7: inventory, stock takes, rule book.
  `CREATE TABLE inventory_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL, category TEXT, unit TEXT,
     qty REAL NOT NULL DEFAULT 0, min_qty REAL NOT NULL DEFAULT 0,
     supplier TEXT, cost REAL, notes TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE TABLE stock_takes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     taken_at TEXT NOT NULL DEFAULT (datetime('now')), notes TEXT);
   CREATE TABLE stock_take_lines (
     take_id INTEGER NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
     item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
     item_name TEXT NOT NULL, expected REAL, counted REAL NOT NULL);
   CREATE TABLE rules (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL, body TEXT, sort INTEGER NOT NULL DEFAULT 0);`,
  // v8: booking type (see BOOKING_KINDS). Existing bookings are tattoo sessions.
  `ALTER TABLE bookings ADD COLUMN kind TEXT NOT NULL DEFAULT 'tattoo';`,
  // v9: finishing a tattoo. completed + what was paid and how long it took (feeds Stats), the
  // follow-up booking it spawned (followup_of on the follow-up), and the promotion on its receipt.
  `ALTER TABLE bookings ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE bookings ADD COLUMN completed_at TEXT;
   ALTER TABLE bookings ADD COLUMN paid REAL;
   ALTER TABLE bookings ADD COLUMN time_min INTEGER;
   ALTER TABLE bookings ADD COLUMN pay_method TEXT;
   ALTER TABLE bookings ADD COLUMN followup_of INTEGER REFERENCES bookings(id) ON DELETE SET NULL;
   ALTER TABLE bookings ADD COLUMN promo_kind TEXT;
   ALTER TABLE bookings ADD COLUMN promo_value REAL;
   ALTER TABLE bookings ADD COLUMN promo_until TEXT;
   CREATE INDEX idx_bookings_done ON bookings (completed, start_at);`
];
/* Booking types. ink: shows the tattoo fields (placement, size, quote, deposit, references). */
const BOOKING_KINDS = {
  tattoo: { label: 'Tattoo', ink: true }, consult: { label: 'Consultation', ink: true }, touchup: { label: 'Touch-up', ink: true },
  followup: { label: 'Follow-up' }, hold: { label: 'Hold' }, meeting: { label: 'Meeting' }, leave: { label: 'Leave' }, other: { label: 'Other' }
};
// Kinds that can be marked completed (and so count in Stats, get a receipt and a follow-up).
const DONE_KINDS = ['tattoo', 'touchup'];
const PAY_METHODS = ['Cash', 'Card', 'EFT', 'Voucher'];
const kindOf = (b) => BOOKING_KINDS[b.kind] ? b.kind : 'tattoo';
const kindLabel = (b) => BOOKING_KINDS[kindOf(b)].label;
const kindChip = (b) => kindOf(b) === 'tattoo' ? '' : `<span class="kchip k-${kindOf(b)}">${kindLabel(b)}</span>`;

/* Starter templates, inserted once on a fresh database. Fully editable.
   Block types: h heading, sub subheading, p paragraph, li bullet, check tick box (required unless opt),
   field answer (v = prefill with placeholders, long = multi-line), choice (opts split on '/', req = must pick). */
const DEFAULT_TEMPLATES = [
  { kind: 'consent', title: 'Tattoo consent form', blocks: [
    { t: 'h', text: 'Tattoo consent form' },
    { t: 'p', text: 'Tattoo artist: {artist} · Date: {date}' },
    { t: 'field', text: 'Full name', v: '{client}' },
    { t: 'field', text: 'Contact number', v: '{phone}' },
    { t: 'field', text: 'ID number' },
    { t: 'field', text: 'Email', v: '{email}' },
    { t: 'sub', text: 'Legal age and health' },
    { t: 'choice', text: 'Age', opts: 'I am at least 18 years of age / I am under 18 and my legal guardian is present to provide consent', req: true },
    { t: 'field', text: 'Guardian name (under 18 only)' },
    { t: 'field', text: 'Guardian ID number (under 18 only)' },
    { t: 'check', text: 'I confirm that I am not under the influence of drugs or alcohol.' },
    { t: 'check', text: 'I am not pregnant or nursing.' },
    { t: 'check', text: 'I do not have diabetes, epilepsy, heart conditions, hemophilia, HIV/AIDS, hepatitis A, B or C, or any other communicable disease.' },
    { t: 'check', text: 'I am not taking any medications, including antibiotics, that may affect the tattoo process.' },
    { t: 'check', text: 'I do not have any skin conditions that may interfere with the tattoo process.' },
    { t: 'check', text: 'To my knowledge, I do not have any physical or mental impairment or disability that can affect my judgement regarding getting a tattoo.' },
    { t: 'sub', text: 'Awareness and responsibility' },
    { t: 'check', text: 'I understand that a tattoo is a permanent change to my appearance.' },
    { t: 'check', text: 'I am aware that the tattoo procedure involves the insertion of needles into my skin and that the tattoo process might require the artist to touch various parts of my body.' },
    { t: 'check', text: 'I willingly and voluntarily agree to this and I will not file any complaint or accusation of assault, sexual or indecent behavior.' },
    { t: 'check', text: 'I accept all responsibility for any consequences that might arise from my decision to have this tattoo.' },
    { t: 'check', text: 'I agree to follow the aftercare instructions provided to me and to seek professional medical advice if needed during the healing process.' },
    { t: 'check', text: 'I release the tattoo artist and studio from all responsibility concerning the tattoo.' },
    { t: 'sub', text: 'Use of images' },
    { t: 'check', text: 'A photo of the completed tattoo may be taken and used at the tattoo artist\'s discretion.' },
    { t: 'check', text: 'I give permission to the tattoo artist to photograph the tattoo for their portfolio and promotional use.' },
    { t: 'sub', text: 'Declaration' },
    { t: 'check', text: 'I have read and fully understood every part of this consent form.' },
    { t: 'sub', text: 'Tattoo details' },
    { t: 'field', text: 'Tattoo description', v: '{description}' },
    { t: 'field', text: 'Quote', v: '{quote}' },
    { t: 'choice', text: 'Payment', opts: 'Cash / Card / EFT / Voucher' },
    { t: 'field', text: 'Notes', long: true }
  ] },
  { kind: 'aftercare', title: 'After care', blocks: [
    { t: 'h', text: 'After care' },
    { t: 'p', text: 'Hi {first}, here is how to look after your new tattoo.' },
    { t: 'sub', text: 'After your tattoo session' },
    { t: 'li', text: 'Your artist will apply a bandage or second skin. Wear time is usually 3–5 days.' },
    { t: 'li', text: 'Wash your hands first, then remove the bandage carefully.' },
    { t: 'li', text: 'Gently wash with lukewarm water and unscented antibacterial soap. Use your hands only.' },
    { t: 'li', text: 'Pat dry with a clean paper towel or let it air-dry.' },
    { t: 'sub', text: 'Moisturise lightly' },
    { t: 'li', text: 'Apply a thin layer of unscented tattoo aftercare ointment.' },
    { t: 'li', text: 'Don\'t overdo it: too much cream clogs the pores. Avoid petroleum jelly.' },
    { t: 'sub', text: 'Daily care (2–3 times a day)' },
    { t: 'li', text: 'Clean and moisturise morning and night for at least 2 weeks.' },
    { t: 'li', text: 'No soaking: no baths, swimming or hot tubs.' },
    { t: 'li', text: 'Showers are fine; avoid spraying directly on the tattoo.' },
    { t: 'sub', text: 'Keep it protected' },
    { t: 'li', text: 'Wear loose, clean clothing (no jeans).' },
    { t: 'li', text: 'Avoid friction, tight gear, contact with pets and dirty hands.' },
    { t: 'sub', text: 'Normal healing signs' },
    { t: 'li', text: 'Your tattoo isn\'t smudged: it\'s just some plasma built up under the bandage.' },
    { t: 'li', text: 'Flaking and peeling are normal.' },
    { t: 'li', text: 'No scratching, rubbing or picking!' },
    { t: 'sub', text: 'Infection warning signs (seek medical help if you notice any)' },
    { t: 'li', text: 'Swelling or redness getting worse after 3–4 days.' },
    { t: 'li', text: 'Yellow or green pus, or a foul smell.' },
    { t: 'li', text: 'It is hot to the touch, or you have a fever or chills.' },
    { t: 'li', text: 'Pain that persists or keeps increasing.' },
    { t: 'sub', text: 'Precautions' },
    { t: 'li', text: 'No sun exposure. Once healed, always use SPF.' },
    { t: 'li', text: 'Healing time is 2–4 weeks, depending on size, location and person.' },
    { t: 'li', text: 'Unsure? Contact your artist. There are no dumb questions.' },
    { t: 'sub', text: '{artist}' },
    { t: 'p', text: 'Contact: {artist_phone}' },
    { t: 'p', text: 'Instagram: {instagram}' },
    { t: 'p', text: 'Facebook: {facebook}' },
    { t: 'p', text: 'TikTok: {tiktok}' }
  ] }
];
/* Apprentice consent: the standard consent form plus a section where the client accepts that the
   artist is still learning, and an apprentice-specific touch-up agreement. Seeded as a third starter. */
const APPRENTICE_TEMPLATE = (() => {
  const base = DEFAULT_TEMPLATES[0].blocks.map(b => ({ ...b }));
  base[0] = { t: 'h', text: 'Apprentice tattoo consent form' };
  base[1] = { t: 'p', text: 'Apprentice artist: {artist} · Date: {date}' };
  const at = base.findIndex(b => b.t === 'sub' && b.text === 'Declaration');
  base.splice(at, 0,
    { t: 'sub', text: 'Apprentice artist' },
    { t: 'field', text: 'Supervising artist' },
    { t: 'check', text: 'I understand that my tattoo artist is an apprentice who is still learning, and that a qualified artist may supervise the session.' },
    { t: 'check', text: 'I understand that the session may take longer than it would with an experienced artist.' },
    { t: 'check', text: 'I accept that the result may not be perfect and that touch-ups may be needed once the tattoo has healed.' },
    { t: 'check', text: 'I agree that the supervising artist may guide, step in or correct the work during the session if needed.' },
    { t: 'check', text: 'I chose to be tattooed by an apprentice knowingly, and any reduced price reflects this.', opt: true },
    { t: 'check', text: 'I give permission for photos of my tattoo to be shared with the supervising artist for feedback and learning.', opt: true },
    { t: 'field', text: 'Touch-up agreement (e.g. one free touch-up within 3 months)', long: true });
  return { kind: 'consent', title: 'Apprentice consent form', blocks: base };
})();
DEFAULT_TEMPLATES.splice(1, 0, APPRENTICE_TEMPLATE);
/* The first starter templates. On upgrade they are swapped for the new ones only if never edited. */
const LEGACY_TEMPLATES = [
  { kind: 'consent', title: 'Tattoo consent', blocks: [
    { t: 'h', text: 'Tattoo consent & release' },
    { t: 'p', text: 'I, {client}, consent to be tattooed by {artist} at {studio} on {date}.' },
    { t: 'field', text: 'Emergency contact (name & number)' },
    { t: 'check', text: 'I am 18 years or older.' },
    { t: 'check', text: 'I am not under the influence of alcohol or drugs.' },
    { t: 'check', text: 'I have disclosed any medical conditions, allergies (including latex), medication or pregnancy.' },
    { t: 'check', text: 'I understand a tattoo is permanent and that results, healing and colour can vary.' },
    { t: 'check', text: 'I have checked the design, spelling and placement and approve them.' },
    { t: 'check', text: 'I have received aftercare instructions and accept responsibility for following them.' },
    { t: 'check', text: 'I agree that photos of the finished tattoo may be used in the artist\'s portfolio and social media.' },
    { t: 'p', text: 'This is a starter template. Review it against the regulations where you work before using it.' }
  ] },
  { kind: 'aftercare', title: 'Aftercare', blocks: [
    { t: 'h', text: 'Looking after your new tattoo' },
    { t: 'p', text: 'Hi {first}, thanks for coming in! Follow these steps for the best healing.' },
    { t: 'check', text: 'Leave the wrap on for 2–4 hours (or as instructed), then wash gently with lukewarm water and unscented soap.' },
    { t: 'check', text: 'Pat dry with a clean paper towel. Apply a thin layer of aftercare cream 2–3 times a day.' },
    { t: 'check', text: 'No swimming, baths, saunas or sunbeds for 2–3 weeks.' },
    { t: 'check', text: 'Don\'t pick or scratch. Peeling and itching are normal.' },
    { t: 'check', text: 'Keep it out of direct sun while healing. Use SPF once fully healed.' },
    { t: 'p', text: 'Any redness, heat or swelling that gets worse after a few days: contact me or see a doctor.' },
    { t: 'p', text: '{artist} · {studio}' }
  ] }
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
  const seedNew = DEFAULT_TEMPLATES.map(t => ({ sql: 'INSERT INTO form_templates (kind, title, blocks) VALUES (?, ?, ?)', params: [t.kind, t.title, JSON.stringify(t.blocks)] }));
  if (!(await DB.one(`SELECT 1 AS x FROM app_meta WHERE key = 'forms_seeded'`))) {
    await DB.tx([...seedNew,
      { sql: `INSERT INTO app_meta VALUES ('forms_seeded', '1')` },
      { sql: `INSERT INTO app_meta VALUES ('forms_v2', '1')` },
      { sql: `INSERT INTO app_meta VALUES ('forms_v3', '1')` }]);
  } else if (!(await DB.one(`SELECT 1 AS x FROM app_meta WHERE key = 'forms_v2'`))) {
    // Replace the first starter templates with the new ones, leaving any the artist edited.
    await DB.tx([
      ...LEGACY_TEMPLATES.map(t => ({ sql: 'DELETE FROM form_templates WHERE kind = ? AND title = ? AND blocks = ?', params: [t.kind, t.title, JSON.stringify(t.blocks)] })),
      ...seedNew,
      { sql: `INSERT INTO app_meta VALUES ('forms_v2', '1')` },
      { sql: `INSERT INTO app_meta VALUES ('forms_v3', '1')` }]);
  } else if (!(await DB.one(`SELECT 1 AS x FROM app_meta WHERE key = 'forms_v3'`))) {
    // v3 starter: the apprentice consent form, added alongside whatever the artist already has.
    const t = APPRENTICE_TEMPLATE;
    await DB.tx([
      { sql: 'INSERT INTO form_templates (kind, title, blocks) VALUES (?, ?, ?)', params: [t.kind, t.title, JSON.stringify(t.blocks)] },
      { sql: `INSERT INTO app_meta VALUES ('forms_v3', '1')` }]);
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
  async dir(w = WS.cur) { return (await navigator.storage.getDirectory()).getDirectoryHandle(WS.mediaName(w), { create: true }); },
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
      UNION ALL SELECT 1 FROM booking_photos WHERE photo_ref = ?1
      UNION ALL SELECT 1 FROM signed_forms WHERE signature_ref = ?1
      UNION ALL SELECT 1 FROM portfolio_photos WHERE photo_ref = ?1 OR thumb_ref = ?1
      UNION ALL SELECT 1 FROM settings WHERE instr(value, ?1) > 0 LIMIT 1`, [name]);
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

// Redraw an image as PNG (keeps transparency), capped at `max` px on the long side.
async function pngBlob(file, max) {
  const bmp = await createImageBitmap(file), sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/png'));
}

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
        ${tile('stencil', 'Stencil maker', 'Turn a photo into a clean stencil', false, 'stencil')}
        ${tile('quote', 'Quick quote', 'Price a piece in seconds', false, 'quote')}
      </div>`;
    },
    async mount() {
      const t = new Date(); t.setHours(0, 0, 0, 0);
      const rows = await bookingsBetween(t, addDays(t, 1));
      const el = $('#home-today'); if (!el) return;
      if (rows.length) { el.className = 'card list flush'; el.innerHTML = rows.map(agendaRow).join(''); }
      else el.innerHTML = `No sessions booked. <a href="#" id="h-add" style="color:var(--teal)">Book one</a>`;
      const a = $('#h-add'); if (a) a.onclick = (e) => { e.preventDefault(); newBookingNext(); };
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
        <div class="card"><h2>Tattoos ${help('Portfolio pieces done on this client.')}
            <button class="btn small" id="c-pf" style="margin-left:auto">+ Add</button></h2>
          <div id="c-pfs" class="muted">…</div></div>
        <div class="card"><h2>Forms ${help('Signed consent forms and aftercare sent to this client.')}
            <span class="row" style="margin-left:auto;gap:6px" id="c-fbtns"></span></h2>
          <div id="c-forms" class="muted">…</div></div>
        <div class="row" style="margin-bottom:20px">
          <button class="btn" onclick="location.hash='client-edit/${c.id}'">Edit</button>
          <button class="btn danger" id="c-del">Delete</button>
        </div>`;
      $('#c-book').onclick = () => newBookingNext(c.id);
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
      $('#c-pf').onclick = () => { PF.ctx = { kind: 'tattoo', clientId: c.id }; location.hash = 'pf-edit/new'; };
      const pfs = await DB.all(`SELECT p.id, (SELECT thumb_ref FROM portfolio_photos x WHERE x.item_id = p.id ORDER BY sort, id LIMIT 1) AS thumb
        FROM portfolio_items p WHERE p.client_id = ? ORDER BY coalesce(p.made_on, p.created_at) DESC`, [c.id]);
      const pe = $('#c-pfs');
      if (pe) {
        const urls = await Promise.all(pfs.map(p => Media.url(p.thumb)));
        pe.innerHTML = pfs.length ? `<div class="pf-strip">${pfs.map((p, i) => `<a class="pf-tile" href="#pf/${p.id}">${urls[i] ? `<img src="${urls[i]}" alt="">` : ''}</a>`).join('')}</div>` : 'None yet.';
      }
      const tpls = await DB.all('SELECT id, kind FROM form_templates ORDER BY id');
      const firstOf = (k) => tpls.find(t => t.kind === k)?.id;
      const fb = $('#c-fbtns');
      if (fb) {
        if (firstOf('consent')) fb.innerHTML += `<button class="btn small" data-t="${firstOf('consent')}">Consent</button>`;
        if (firstOf('aftercare')) fb.innerHTML += `<button class="btn small" data-t="${firstOf('aftercare')}">Aftercare</button>`;
        fb.onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) openForm(+b.dataset.t, c.id); };
      }
      const sf = await DB.all('SELECT id, kind, title, signed_at FROM signed_forms WHERE client_id = ? ORDER BY signed_at DESC', [c.id]);
      const fe = $('#c-forms');
      if (fe) {
        if (!sf.length) fe.textContent = 'No forms yet.';
        else {
          fe.className = 'card list flush';
          fe.innerHTML = sf.map(r => `<a class="c-row" href="#signed/${r.id}"><span class="c-main"><span class="c-n">${esc(r.title)}</span>
            <span class="muted c-sub">${new Date(r.signed_at + 'Z').toLocaleDateString()}</span></span>
            <span class="chip">${r.kind === 'consent' ? 'Signed' : 'Sent'}</span><svg viewBox="0 0 24 24" class="chev"><path d="M9 6l6 6-6 6"/></svg></a>`).join('');
        }
      }
      $('#c-del').onclick = async () => {
        if (!confirm(`Delete ${fullName(c)}?\n\nThis permanently removes the client and their photo. Their bookings stay on the calendar without a client.`)) return;
        await DB.run('UPDATE bookings SET gcal_synced_at = NULL WHERE client_id = ?', [c.id]);
        await DB.run('DELETE FROM clients WHERE id = ?', [c.id]);
        Gcal.soon();
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
          await DB.run('UPDATE bookings SET gcal_synced_at = NULL WHERE client_id = ?', [cid]);  // name/phone live in Google notes
          Gcal.soon();
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
          ${Gcal.enabled() ? `<button class="btn icon-btn gsync ${Gcal.state}" id="gcal-btn" aria-label="Sync Google Calendar"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/></svg></button>` : ''}
          <button class="btn icon-btn" id="cal-share" data-tip="Share your open appointments" aria-label="Share open appointments"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/></svg></button>
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
      const gb = $('#gcal-btn');
      if (gb) {
        Gcal.setState(Gcal.state);
        gb.onclick = () => Gcal.sync({ interactive: true }).then(() => { toast('Synced.'); renderCal(); }).catch(e => toast('Google sync: ' + e.message, 6000));
      }
      $('#cal-add').onclick = () => newBookingNext(null, Cal.date < new Date() ? new Date() : Cal.date);
      $('#cal-share').onclick = openAvailability;
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
      if (id === 'new' && Cal.prefillQuote) {
        const q = Cal.prefillQuote;
        Object.assign(b, { quote: q.quote, deposit: q.deposit, size: q.size || null, duration_min: Math.min(600, Math.max(30, q.duration || 120)),
          placement: q.placement || null, description: q.description || null, notes: q.notes || null });
      }
      const fromQuote = id === 'new' ? Cal.prefillQuote : null;
      Cal.prefill = Cal.prefillClient = Cal.prefillQuote = null;
      if (!b) { location.hash = 'book'; return; }
      const photos = b.id ? await DB.all('SELECT id, photo_ref FROM booking_photos WHERE booking_id = ? ORDER BY sort, id', [b.id]) : [];
      const keep = photos.map(p => p.photo_ref);       // existing refs still attached
      const added = [];                                 // new Blobs not yet saved
      // A design attached to the quote arrives as an unsaved reference photo (remove or replace it as usual).
      if (fromQuote?.design) added.push({ blob: fromQuote.design, url: URL.createObjectURL(fromQuote.design) });
      let clientId = b.client_id;
      const client = clientId ? await DB.one('SELECT * FROM clients WHERE id = ?', [clientId]) : null;
      const cur = Settings.get('currency');
      const durOpts = []; for (let m = 30; m <= 600; m += 30) durOpts.push(m);
      const f = $('#b-form');
      let kind = kindOf(b);
      f.innerHTML = `
        <div class="field"><span class="lbl">Type</span>
          <div class="seg kinds" id="b-kind">${Object.entries(BOOKING_KINDS).map(([k, v]) => `<button type="button" data-k="${k}" class="${k === kind ? 'on' : ''}">${v.label}</button>`).join('')}</div></div>
        <label class="field"><span>Client ${help('Search existing clients, or type a new name and pick "Add" to create one. Optional for meetings and leave.')}</span>
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
        <div class="off-warn" id="b-offwarn" hidden></div>
        <label class="field"><span id="b-desc-l">Tattoo description</span><textarea class="in" name="description" rows="2" placeholder="e.g. Fine-line peony with stem">${esc(b.description)}</textarea></label>
        <div id="b-ink">
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
        </div>
        <label class="field"><span>Notes</span><textarea class="in" name="notes" rows="3">${esc(b.notes)}</textarea></label>
        <div class="b-done" id="b-done">
          <label class="toggle b-done-t"><input type="checkbox" name="completed" ${b.completed ? 'checked' : ''}><span>Tattoo completed</span></label>
          <div id="b-done-in">
            <div class="two">
              <label class="field"><span>Final price paid${cur ? ` (${esc(cur)})` : ''} ${help('What the client paid in total, deposit included. Used in Stats and on the receipt.')}</span>
                <input class="in" name="paid" type="number" inputmode="decimal" min="0" step="any" value="${b.paid ?? b.quote ?? ''}"></label>
              <label class="field"><span>Time tattooed ${help('Needle time only, breaks not included. Used in Stats.')}</span>
                <div class="unit-in"><input class="in" name="time_h" type="number" inputmode="decimal" min="0" step="0.25" value="${b.time_min != null ? +(b.time_min / 60).toFixed(2) : +(b.duration_min / 60).toFixed(2)}"><em>hours</em></div></label>
            </div>
            <div class="field"><span class="lbl">Paid by</span><div class="seg" id="b-pay">${PAY_METHODS.map(m => `<button type="button" data-pay="${m}" class="${b.pay_method === m ? 'on' : ''}" style="flex:1">${m}</button>`).join('')}</div></div>
            <div class="b-done-acts">
              <div class="b-fu"><button type="button" class="btn" id="b-followup" data-tip="Book a check-up to see how it healed and whether a touch-up is needed">Book follow-up</button>
                <span>in</span><input class="in" id="b-fu-w" type="number" min="1" max="52" value="${Settings.get('followup_weeks', '6')}"><span>weeks</span></div>
              <button type="button" class="btn" id="b-receipt" data-tip="A thank-you receipt with what they paid, and an optional discount on their next tattoo">Thank-you receipt</button>
            </div>
            <div id="b-fu-info" class="muted" style="font-size:13px;margin-top:8px"></div>
          </div>
        </div>
        ${b.id && kind === 'tattoo' ? `<button type="button" class="btn small" id="b-pf" style="margin-bottom:8px" data-tip="Add the finished tattoo to your portfolio, prefilled from this booking">+ Add finished tattoo to portfolio</button>` : ''}
        <div class="form-foot row">
          ${b.id ? '<button type="button" class="btn danger icon-btn" id="b-del" data-tip="Delete booking" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' : ''}
          <button type="button" class="btn" id="b-cancel">Cancel</button>
          <button type="submit" class="btn primary" style="flex:1">Save</button>
        </div>`;

      // Type: non-tattoo kinds hide the tattoo-only fields (their values are kept, not cleared)
      // Booking a tattoo on a day off is allowed (emergencies happen); it's just pointed out.
      const offWarn = () => {
        const k = f.date.value, on = !!k && BOOKING_KINDS[kind].ink && isDayOff(k);
        $('#b-offwarn').hidden = !on;
        if (on) $('#b-offwarn').innerHTML = `<b>${new Date(k + 'T00:00').toLocaleDateString(undefined, { weekday: 'long' })} is one of your days off.</b>
          <span>You can still book it. Next open day: <button type="button" class="link" id="b-nextday">${esc(fmtDay(nextOpenDay(new Date(k + 'T00:00'))))}</button></span>`;
      };
      f.date.addEventListener('change', offWarn);
      $('#b-offwarn').addEventListener('click', (e) => { if (e.target.id === 'b-nextday') { f.date.value = nextOpenDay(new Date(f.date.value + 'T00:00')); offWarn(); Dirty.set(true); } });
      const showDone = () => { $('#b-done').hidden = !DONE_KINDS.includes(kind); $('#b-done-in').hidden = !f.completed.checked; };
      let payMethod = b.pay_method || null;
      $('#b-pay').onclick = (e) => { const x = e.target.closest('[data-pay]'); if (!x) return;
        payMethod = payMethod === x.dataset.pay ? null : x.dataset.pay;
        $('#b-pay').querySelectorAll('button').forEach(y => y.classList.toggle('on', y.dataset.pay === payMethod)); Dirty.set(true); };
      f.completed.addEventListener('change', showDone);
      const showKind = () => {
        const ink = BOOKING_KINDS[kind].ink;
        showDone(); offWarn();
        $('#b-ink').hidden = !ink;
        $('#b-desc-l').textContent = kind === 'tattoo' || kind === 'touchup' ? 'Tattoo description' : kind === 'consult' ? 'Idea / what to discuss' : kind === 'followup' ? 'What to check' : kind === 'hold' ? 'Held for (private)' : 'Details';
        f.description.placeholder = ink ? 'e.g. Fine-line peony with stem' : kind === 'leave' ? 'e.g. Holiday' : '';
      };
      showKind();
      $('#b-kind').onclick = (e) => {
        const x = e.target.closest('button'); if (!x) return;
        kind = x.dataset.k; $('#b-kind').querySelectorAll('button').forEach(y => y.classList.toggle('on', y === x));
        showKind(); Dirty.set(true);
      };

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
      const bpf = $('#b-pf');
      if (bpf) bpf.onclick = () => {
        PF.ctx = { kind: 'tattoo', clientId, bookingId: b.id, title: b.description, description: '', placement: b.placement, date: b.start_at.slice(0, 10) };
        location.hash = 'pf-edit/new';
      };
      const del = $('#b-del');
      if (del) del.onclick = async () => {
        if (!confirm('Delete this booking and its reference photos?')) return;
        await DB.tx([
          ...(b.gcal_id ? [{ sql: 'INSERT OR IGNORE INTO gcal_deletes VALUES (?)', params: [b.gcal_id] }] : []),
          { sql: 'DELETE FROM bookings WHERE id = ?', params: [b.id] }]);
        for (const p of photos) await Media.release(p.photo_ref);
        Dirty.set(false); toast('Booking deleted.'); Gcal.soon(); history.back();
      };
      // Saves the form and returns the booking id (null if something needs fixing first).
      const save = async () => {
        const d = Object.fromEntries(new FormData(f));
        if (ci.value.trim() && !clientId) { toast('Pick a client from the list, or choose "Add".'); return null; }
        const num = (v) => v === '' || v == null ? null : +v;
        const done = DONE_KINDS.includes(kind) && !!d.completed;
        const vals = [clientId, d.date + 'T' + d.time, +d.duration_min, d.description.trim() || null, d.placement.trim() || null,
          d.size.trim() || null, num(d.quote), num(d.deposit), d.deposit_paid ? 1 : 0, d.notes.trim() || null, kind,
          done ? 1 : 0, done ? (b.completed_at || new Date().toISOString()) : null,
          done ? num(d.paid) : null, done && d.time_h !== '' ? Math.round(+d.time_h * 60) : null, done ? payMethod : null];
        const cols = 'client_id, start_at, duration_min, description, placement, size, quote, deposit, deposit_paid, notes, kind, completed, completed_at, paid, time_min, pay_method';
        const refs = [...keep];
        for (const a of added) refs.push(await Media.save(a.blob, 'jpg'));
        let bid = b.id;
        if (bid) await DB.run(`UPDATE bookings SET ${cols.split(', ').map(c => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...vals, bid]);
        else { await DB.run(`INSERT INTO bookings (${cols}) VALUES (${vals.map(() => '?').join(', ')})`, vals); bid = (await DB.one('SELECT last_insert_rowid() AS id')).id; }
        await DB.tx([{ sql: 'DELETE FROM booking_photos WHERE booking_id = ?', params: [bid] },
          ...refs.map((r, i) => ({ sql: 'INSERT INTO booking_photos (booking_id, photo_ref, sort) VALUES (?, ?, ?)', params: [bid, r, i] }))]);
        for (const p of photos) if (!refs.includes(p.photo_ref)) await Media.release(p.photo_ref);
        Cal.date = new Date(d.date + 'T00:00');
        Dirty.set(false); Gcal.soon();
        if (!b.id) { b.id = bid; }
        Object.assign(b, { completed: done ? 1 : 0, paid: done ? num(d.paid) : null, time_min: vals[14], pay_method: done ? payMethod : null, client_id: clientId,
          description: vals[3], placement: vals[4], size: vals[5], start_at: vals[1] });
        keep.splice(0, keep.length, ...refs); added.length = 0; photos.splice(0, photos.length, ...refs.map(r => ({ photo_ref: r })));
        return bid;
      };
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        // Ask once: when the booking is new or moved onto a day off, not on every later save.
        if (BOOKING_KINDS[kind].ink && isDayOff(f.date.value) && (!b.id || f.date.value !== b.start_at.slice(0, 10))
          && !confirm(`${new Date(f.date.value + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} is your day off.\n\nBook it anyway?`)) return;
        if (!(await save())) return;
        toast('Booking saved.'); location.replace('#book');
      });

      // Follow-up: a short check-up booking N weeks after the session, linked back to it.
      const fuInfo = async () => {
        const fu = b.id ? await DB.one(`SELECT id, start_at FROM bookings WHERE followup_of = ? ORDER BY start_at LIMIT 1`, [b.id]) : null;
        $('#b-fu-info').innerHTML = fu ? `Follow-up booked for <a href="#booking-edit/${fu.id}">${esc(fmtDay(fu.start_at))}</a>.` : '';
      };
      fuInfo();
      $('#b-followup').onclick = async () => {
        const bid = await save(); if (!bid) return;
        const weeks = Math.max(1, +$('#b-fu-w').value || 6);
        await Settings.set('followup_weeks', String(weeks));
        const when = ymd(addDays(new Date(b.start_at.slice(0, 10) + 'T00:00'), weeks * 7)) + 'T' + Settings.get('day_start', '10:00');
        await DB.run(`INSERT INTO bookings (client_id, start_at, duration_min, kind, description, placement, followup_of) VALUES (?, ?, 30, 'followup', ?, ?, ?)`,
          [b.client_id, when, `Check healing${b.description ? ': ' + b.description : ''}. Touch-up needed?`, b.placement, bid]);
        Gcal.soon(); toast(`Follow-up booked for ${fmtDay(when)}.`); fuInfo();
      };
      $('#b-receipt').onclick = async () => { const bid = await save(); if (bid) openReceipt(bid); };
    }
  },
  studio: {
    title: () => 'Studio',
    render: () => `<div class="grid">
      ${tile('portfolio', 'Portfolio', 'Tattoos, art and flash', false, 'portfolio')}
      ${tile('stencil', 'Stencil maker', 'Photo to stencil', false, 'stencil')}
      ${tile('forms', 'Consent & aftercare', 'Build, sign and send forms', false, 'forms')}
      ${tile('reels', 'Reel maker', 'Quick, consistent tattoo reels', false, 'reel')}</div>`
  },
  more: {
    title: () => 'More',
    render: () => `<div class="grid">
      ${tile('settings', 'Settings & backup', 'Profile, storage, backup and restore', false, 'settings')}
      ${tile('quote', 'Quote calculator', 'Price a piece from your own rates', false, 'quote')}
      ${tile('quote', 'Stats', 'Tattoos, hours and earnings over time', false, 'stats')}
      ${tile('stock', 'Inventory', 'Stock, low-stock alerts and stock takes', false, 'inventory')}
      ${tile('rules', 'Rule book', 'Your studio rules', false, 'rules')}</div>`
  },
  portfolio: {
    title: () => 'Portfolio',
    render: () => `
      <div class="search-bar">
        <input class="in" id="pf-q" type="search" placeholder="Search title, tag, placement…" value="${esc(PF.q)}" autocomplete="off">
        <button class="btn primary icon-btn" id="pf-add" data-tip="Add to portfolio" aria-label="Add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
      <div class="seg pf-seg" id="pf-filter">
        ${[['all', 'All'], ['tattoo', 'Tattoos'], ['art', 'Art'], ['flash', 'Flash'], ['fav', '★']].map(([k, l]) =>
          `<button data-f="${k}" class="${PF.filter === k ? 'on' : ''}" ${k === 'fav' ? 'data-tip="Favourites" aria-label="Favourites"' : ''}>${l}</button>`).join('')}
      </div>
      <div id="pf-grid"></div>`,
    mount() {
      $('#pf-q').addEventListener('input', (e) => { PF.q = e.target.value; renderPfGrid(); });
      $('#pf-filter').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; PF.filter = b.dataset.f;
        document.querySelectorAll('#pf-filter button').forEach(x => x.classList.toggle('on', x === b)); renderPfGrid(); };
      $('#pf-add').onclick = () => { PF.ctx = { kind: ['tattoo', 'art', 'flash'].includes(PF.filter) ? PF.filter : 'tattoo' }; location.hash = 'pf-edit/new'; };
      renderPfGrid();
    }
  },
  pf: {
    title: () => 'Portfolio',
    render: () => '<div id="pf-view"></div>',
    async mount(id) {
      const it = await DB.one(`SELECT p.*, c.first_name, c.last_name FROM portfolio_items p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = ?`, [+id]);
      const el = $('#pf-view');
      if (!it) { el.innerHTML = '<div class="card muted">Not found.</div>'; return; }
      const photos = await DB.all('SELECT * FROM portfolio_photos WHERE item_id = ? ORDER BY sort, id', [it.id]);
      const urls = await Promise.all(photos.map(p => Media.url(p.photo_ref)));
      $('#view-title').textContent = PF_KIND[it.kind];
      const field = (l, v) => v ? `<div class="stat"><span class="muted">${l}</span><span class="val">${v}</span></div>` : '';
      el.innerHTML = `
        <div class="carousel" id="pf-car">${photos.map((p, i) => `<div class="slide"><img src="${urls[i]}" alt="" data-i="${i}">
          ${p.label ? `<span class="slide-label">${esc(p.label)}</span>` : ''}</div>`).join('') || '<div class="slide empty-slide muted">No photos</div>'}</div>
        ${photos.length > 1 ? `<div class="dots" id="pf-dots">${photos.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
        <div class="card">
          <div class="row" style="justify-content:space-between;flex-wrap:nowrap">
            <h2 style="margin:0">${esc(it.title || PF_KIND[it.kind])}</h2>
            <button class="fav ${it.favourite ? 'on' : ''}" id="pf-fav" data-tip="Favourite" aria-label="Favourite">★</button>
          </div>
          ${it.kind === 'flash' ? `<div class="row" style="margin:8px 0 4px">
            ${it.price != null ? `<span class="price paid">${money(it.price)}</span>` : ''}
            <label class="toggle" data-tip="Mark this flash as taken"><input type="checkbox" id="pf-claimed" ${it.claimed ? 'checked' : ''}><span>Claimed</span></label></div>` : ''}
          ${it.description ? `<p class="pre">${esc(it.description)}</p>` : ''}
          ${field('Placement', esc(it.placement || ''))}
          ${field('Client', it.client_id ? `<a href="#client/${it.client_id}" style="color:var(--teal)">${esc(fullName(it))}</a>` : '')}
          ${field('Date', it.made_on ? new Date(it.made_on + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '')}
          ${it.tags ? `<div style="margin-top:10px">${tagChips(it.tags).replace('justify-content:center', '')}</div>` : ''}
        </div>
        <div class="row" style="margin-bottom:24px">
          <button class="btn danger icon-btn" id="pf-del" data-tip="Delete" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
          <button class="btn" id="pf-share" ${photos.length ? '' : 'disabled'}>Share</button>
          <button class="btn primary" style="flex:1" onclick="location.hash='pf-edit/${it.id}'">Edit</button>
        </div>`;
      const car = $('#pf-car'), dots = $('#pf-dots');
      const cur = () => Math.round(car.scrollLeft / car.clientWidth);
      if (dots) car.addEventListener('scroll', () => dots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i === cur())), { passive: true });
      car.onclick = (e) => { const img = e.target.closest('img'); if (img) viewImage(img.src); };
      $('#pf-fav').onclick = async (e) => {
        const btn = e.currentTarget;   // currentTarget is null after the await
        it.favourite = it.favourite ? 0 : 1;
        btn.classList.toggle('on', !!it.favourite);
        await DB.run('UPDATE portfolio_items SET favourite = ? WHERE id = ?', [it.favourite, it.id]);
      };
      const cl = $('#pf-claimed');
      if (cl) cl.onchange = () => DB.run(`UPDATE portfolio_items SET claimed = ?, updated_at = datetime('now') WHERE id = ?`, [cl.checked ? 1 : 0, it.id]);
      $('#pf-share').onclick = async () => {
        const p = photos[cur()] || photos[0];
        const f = await (await (await Media.dir()).getFileHandle(p.photo_ref)).getFile();
        const file = new File([f], (it.title || 'inkforge').replace(/[^\w-]+/g, '_') + '.jpg', { type: 'image/jpeg' });
        try {
          if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: it.title || '' });
          else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); }
        } catch (e) { if (e.name !== 'AbortError') toast('Could not share: ' + e.message); }
      };
      $('#pf-del').onclick = async () => {
        if (!confirm(`Delete "${it.title || PF_KIND[it.kind]}" and its ${photos.length} photo${photos.length === 1 ? '' : 's'}?`)) return;
        await DB.run('DELETE FROM portfolio_items WHERE id = ?', [it.id]);
        for (const p of photos) { await Media.release(p.photo_ref); await Media.release(p.thumb_ref); }
        toast('Deleted.'); history.back();
      };
    }
  },
  'pf-edit': {
    title: (id) => id === 'new' ? 'Add to portfolio' : 'Edit',
    render: () => '<form id="pf-form" class="card" autocomplete="off"></form>',
    async mount(id) {
      const ctx = PF.ctx || {}; PF.ctx = null;
      const it = id === 'new'
        ? { kind: ctx.kind || 'tattoo', title: ctx.title || '', description: ctx.description || '', placement: ctx.placement || '', tags: '',
            client_id: ctx.clientId || null, booking_id: ctx.bookingId || null, made_on: ctx.date || ymd(new Date()), price: null, claimed: 0 }
        : await DB.one('SELECT * FROM portfolio_items WHERE id = ?', [+id]);
      if (!it) { location.hash = 'portfolio'; return; }
      const old = it.id ? await DB.all('SELECT * FROM portfolio_photos WHERE item_id = ? ORDER BY sort, id', [it.id]) : [];
      // Working list: existing rows {photo_ref, thumb_ref, label} or new {blob, thumb, url, label}
      const photos = await Promise.all(old.map(async p => ({ ...p, url: await Media.url(p.thumb_ref) })));
      let clientId = it.client_id;
      const client = clientId ? await DB.one('SELECT * FROM clients WHERE id = ?', [clientId]) : null;
      const cur = Settings.get('currency');
      const f = $('#pf-form');
      f.innerHTML = `
        <div class="seg" id="pf-kind" style="margin-bottom:14px">${Object.entries(PF_KIND).map(([k, l]) => `<button type="button" data-k="${k}" class="${it.kind === k ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}</div>
        <div class="field"><span class="lbl">Photos ${help('The first photo is the cover. Tag each one as fresh, healed, stencil or sketch. Tap ◀ to move a photo forward.')}</span>
          <div class="thumbs pf-thumbs" id="pf-thumbs"></div></div>
        <label class="field"><span>Title</span><input class="in" name="title" value="${esc(it.title)}" placeholder="Peony sleeve"></label>
        <label class="field"><span>Description</span><textarea class="in" name="description" rows="2">${esc(it.description)}</textarea></label>
        <div class="two">
          <label class="field"><span>Placement</span><input class="in" name="placement" value="${esc(it.placement)}"></label>
          <label class="field"><span>Date</span><input class="in" type="date" name="made_on" value="${esc(it.made_on)}"></label>
        </div>
        <label class="field"><span>Tags ${help('Comma separated, e.g. blackwork, floral, fine-line. Used by search.')}</span><input class="in" name="tags" value="${esc(it.tags)}" placeholder="blackwork, floral"></label>
        <label class="field pf-client"><span>Client (optional)</span>
          <div class="picker"><input class="in" id="pf-client" placeholder="Search clients…" value="${esc(client ? fullName(client) : '')}" autocomplete="off">
          <div class="pick-list" id="pf-client-list" hidden></div></div></label>
        <div class="two pf-flash">
          <label class="field"><span>Price${cur ? ` (${esc(cur)})` : ''}</span><input class="in" name="price" type="number" inputmode="decimal" min="0" step="any" value="${it.price ?? ''}"></label>
          <label class="field"><span>&nbsp;</span><label class="toggle"><input type="checkbox" name="claimed" ${it.claimed ? 'checked' : ''}><span>Claimed</span></label></label>
        </div>
        <div class="form-foot row">
          <button type="button" class="btn" id="pf-cancel">Cancel</button>
          <button type="submit" class="btn primary" style="flex:1">Save</button>
        </div>`;
      const syncKind = () => {
        f.querySelector('.pf-flash').hidden = it.kind !== 'flash';
        f.querySelector('.pf-client').hidden = it.kind !== 'tattoo';
      };
      syncKind();
      $('#pf-kind').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; it.kind = b.dataset.k;
        $('#pf-kind').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); syncKind(); Dirty.set(true); };
      const LABELS = ['', 'Fresh', 'Healed', 'Stencil', 'Sketch', 'Process'];
      const drawThumbs = () => {
        $('#pf-thumbs').innerHTML = photos.map((p, i) => `
          <div class="pf-ph"><div class="thumb ${i ? '' : 'cover'}"><img src="${p.url}" alt="">
            <button type="button" data-rm="${i}" aria-label="Remove">&times;</button>
            ${i ? `<button type="button" class="fwd" data-fwd="${i}" aria-label="Move forward">&#9664;</button>` : ''}</div>
            <select class="in mini-sel" data-lbl="${i}">${LABELS.map(l => `<option value="${l}" ${p.label === l || (!p.label && !l) ? 'selected' : ''}>${l || 'No label'}</option>`).join('')}</select></div>`).join('')
          + `<div class="pf-ph"><label class="thumb add" data-tip="Add photos"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
             <input type="file" accept="image/*" multiple hidden id="pf-file"></label></div>`;
        $('#pf-file').addEventListener('change', async (e) => {
          const files = [...e.target.files];
          toast(files.length > 1 ? `Processing ${files.length} photos…` : 'Processing photo…');
          for (const file of files) {
            try {
              const blob = await Media.shrink(file, 2048, 0.86), thumb = await Media.shrink(file, 480, 0.78);
              photos.push({ blob, thumb, url: URL.createObjectURL(thumb), label: '' });
            } catch { toast('Could not read an image.'); }
          }
          Dirty.set(true); drawThumbs();
        });
      };
      $('#pf-thumbs').addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.rm != null) photos.splice(+b.dataset.rm, 1);
        else if (b.dataset.fwd != null) { const i = +b.dataset.fwd; photos.splice(i - 1, 0, photos.splice(i, 1)[0]); }
        Dirty.set(true); drawThumbs();
      });
      $('#pf-thumbs').addEventListener('change', (e) => { if (e.target.dataset.lbl != null) { photos[+e.target.dataset.lbl].label = e.target.value; Dirty.set(true); } });
      drawThumbs();
      clientPicker($('#pf-client'), $('#pf-client-list'), (cid) => { clientId = cid; Dirty.set(true); });
      $('#pf-client').addEventListener('input', (e) => { if (!e.target.value.trim()) clientId = null; });
      $('#pf-cancel').onclick = () => history.back();
      f.addEventListener('input', (e) => { if (e.target.id !== 'pf-client') Dirty.set(true); });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!photos.length) return toast('Add at least one photo.');
        const d = Object.fromEntries(new FormData(f));
        const flash = it.kind === 'flash';
        const vals = [it.kind, d.title.trim() || null, d.description.trim() || null, d.placement.trim() || null,
          d.tags.split(',').map(t => t.trim()).filter(Boolean).join(', ') || null,
          it.kind === 'tattoo' ? clientId : null, it.booking_id ?? null, d.made_on || null,
          flash && d.price !== '' ? +d.price : null, flash && d.claimed ? 1 : 0];
        const cols = 'kind, title, description, placement, tags, client_id, booking_id, made_on, price, claimed';
        const rows = [];
        for (const p of photos) {
          if (p.blob) rows.push({ photo_ref: await Media.save(p.blob, 'jpg'), thumb_ref: await Media.save(p.thumb, 'jpg'), label: p.label || null });
          else rows.push({ photo_ref: p.photo_ref, thumb_ref: p.thumb_ref, label: p.label || null });
        }
        let pid = it.id;
        if (pid) await DB.run(`UPDATE portfolio_items SET ${cols.split(', ').map(c => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...vals, pid]);
        else { await DB.run(`INSERT INTO portfolio_items (${cols}) VALUES (${vals.map(() => '?').join(', ')})`, vals); pid = (await DB.one('SELECT last_insert_rowid() AS id')).id; }
        await DB.tx([{ sql: 'DELETE FROM portfolio_photos WHERE item_id = ?', params: [pid] },
          ...rows.map((r, i) => ({ sql: 'INSERT INTO portfolio_photos (item_id, photo_ref, thumb_ref, label, sort) VALUES (?, ?, ?, ?, ?)', params: [pid, r.photo_ref, r.thumb_ref, r.label, i] }))]);
        for (const p of old) if (!rows.some(r => r.photo_ref === p.photo_ref)) { await Media.release(p.photo_ref); await Media.release(p.thumb_ref); }
        Dirty.set(false); toast('Saved to portfolio.');
        location.replace('#pf/' + pid);
      });
      Dirty.set(false);
    }
  },
  quote: {
    title: () => 'Quote',
    render: () => '<div id="qz"></div>',
    mount() { qzDraw(); }
  },
  stats: {
    title: () => 'Stats',
    render: () => `
      <div class="seg st-period" id="st-period">${[['month', 'Month'], ['3m', '3 months'], ['year', 'Year'], ['all', 'All'], ['custom', 'Custom']].map(([k, l]) =>
        `<button data-p="${k}" class="${STATS.period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="row st-head">
        ${STATS.period === 'custom' ? `<input class="in" type="date" id="st-from" value="${STATS.from}"><span class="muted">to</span><input class="in" type="date" id="st-to" value="${STATS.to}">`
          : '<span class="muted" id="st-range"></span>'}
        <span class="row no-print" style="margin-left:auto;gap:6px"><button class="btn small" id="st-csv" data-tip="Spreadsheet of the tattoos in this period; opens in Excel">Export Excel</button>
          <button class="btn small" id="st-print" data-tip="Choose Save as PDF in the print dialog for a PDF">Print / PDF</button></span>
      </div>
      <div class="st-wrap"><div id="st-body"></div><div id="st-side"></div></div>`,
    mount() {
      $('#st-period').onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; STATS.period = b.dataset.p; render(); };
      const f = $('#st-from'), t = $('#st-to');
      if (f) { f.onchange = () => { STATS.from = f.value; renderStats(); }; t.onchange = () => { STATS.to = t.value; renderStats(); }; }
      $('#st-csv').onclick = statsCsv;
      $('#st-print').onclick = () => window.print();
      renderStats();
    }
  },
  'quote-cal': {
    title: () => 'Calibrate quotes',
    render: () => '<div id="qc"></div>',
    mount() { qcDraw(); }
  },
  inventory: {
    title: () => 'Inventory',
    render: () => `
      <div class="search-bar">
        <input class="in" id="inv-q" type="search" placeholder="Search stock…" value="${esc(INV.q)}" autocomplete="off">
        <button class="btn primary icon-btn" id="inv-add" data-tip="Add item" aria-label="Add item"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
      <div class="row" style="margin-bottom:12px">
        <button class="btn" id="inv-take" style="flex:1" data-tip="Count everything and record the differences">Stock take</button>
        <button class="btn" id="inv-shop" style="flex:1" data-tip="Share a list of everything at or below its minimum">Shopping list</button>
      </div>
      <div id="inv-list"></div>
      <div id="inv-hist"></div>`,
    mount() {
      $('#inv-q').addEventListener('input', (e) => { INV.q = e.target.value; renderInventory(); });
      $('#inv-add').onclick = () => location.hash = 'inv-edit/new';
      $('#inv-take').onclick = () => location.hash = 'stocktake';
      $('#inv-shop').onclick = async () => {
        const low = await DB.all('SELECT name, qty, min_qty, unit, supplier FROM inventory_items WHERE qty <= min_qty ORDER BY supplier, name COLLATE NOCASE');
        if (!low.length) return toast('Nothing is running low.');
        const text = 'Shopping list\n\n' + low.map(i => `• ${i.name} (have ${fmtQty(i.qty)}${i.unit ? ' ' + i.unit : ''}, min ${fmtQty(i.min_qty)})${i.supplier ? ' – ' + i.supplier : ''}`).join('\n');
        try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast('List copied.'); } }
        catch (e) { if (e.name !== 'AbortError') toast('Could not share.'); }
      };
      $('#inv-list').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-step]'); if (!b) return;
        e.preventDefault();
        const id = +b.dataset.id;
        await DB.run(`UPDATE inventory_items SET qty = max(0, qty + ?), updated_at = datetime('now') WHERE id = ?`, [+b.dataset.step, id]);
        renderInventory();
      });
      renderInventory();
    }
  },
  'inv-edit': {
    title: (id) => id === 'new' ? 'New item' : 'Edit item',
    render: () => '<form id="inv-form" class="card" autocomplete="off"></form>',
    async mount(id) {
      const it = id === 'new' ? { qty: 0, min_qty: 0 } : await DB.one('SELECT * FROM inventory_items WHERE id = ?', [+id]);
      if (!it) { location.hash = 'inventory'; return; }
      const cats = (await DB.all(`SELECT DISTINCT category FROM inventory_items WHERE category IS NOT NULL ORDER BY category`)).map(r => r.category);
      const sugg = [...new Set([...cats, 'Needles', 'Ink', 'Hygiene', 'Aftercare', 'Stencil', 'Other'])];
      const cur = Settings.get('currency');
      const f = $('#inv-form');
      const inp = (n, l, t = 'text', x = '') => `<label class="field"><span>${l}</span><input class="in" name="${n}" type="${t}" value="${esc(it[n] ?? '')}" ${x}></label>`;
      f.innerHTML = `
        ${inp('name', 'Name', 'text', 'required placeholder="Black ink 8oz"')}
        <div class="two">
          <label class="field"><span>Category</span><input class="in" name="category" list="inv-cats" value="${esc(it.category ?? '')}">
            <datalist id="inv-cats">${sugg.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
          ${inp('unit', 'Unit', 'text', 'placeholder="box, bottle, pack"')}
        </div>
        <div class="two">
          ${inp('qty', 'In stock', 'number', 'inputmode="decimal" min="0" step="any"')}
          <label class="field"><span>Minimum ${help('When stock drops to this, the item is flagged and goes on the shopping list.')}</span>
            <input class="in" name="min_qty" type="number" inputmode="decimal" min="0" step="any" value="${it.min_qty ?? 0}"></label>
        </div>
        <div class="two">${inp('supplier', 'Supplier')}${inp('cost', 'Cost per unit' + (cur ? ` (${esc(cur)})` : ''), 'number', 'inputmode="decimal" min="0" step="any"')}</div>
        <label class="field"><span>Notes</span><textarea class="in" name="notes" rows="2">${esc(it.notes ?? '')}</textarea></label>
        <div class="form-foot row">
          ${it.id ? '<button type="button" class="btn danger icon-btn" id="inv-del" aria-label="Delete" data-tip="Delete item"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' : ''}
          <button type="button" class="btn" id="inv-cancel">Cancel</button>
          <button type="submit" class="btn primary" style="flex:1">Save</button>
        </div>`;
      Dirty.set(false);
      f.addEventListener('input', () => Dirty.set(true));
      $('#inv-cancel').onclick = () => history.back();
      const del = $('#inv-del');
      if (del) del.onclick = async () => {
        if (!confirm(`Delete "${it.name}" from inventory?`)) return;
        await DB.run('DELETE FROM inventory_items WHERE id = ?', [it.id]);
        Dirty.set(false); toast('Item deleted.'); location.replace('#inventory');
      };
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(f));
        const n = (v) => v === '' ? null : +v, s = (v) => v.trim() || null;
        const vals = [d.name.trim(), s(d.category), s(d.unit), +d.qty || 0, +d.min_qty || 0, s(d.supplier), n(d.cost), s(d.notes)];
        const cols = 'name, category, unit, qty, min_qty, supplier, cost, notes';
        if (it.id) await DB.run(`UPDATE inventory_items SET ${cols.split(', ').map(c => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...vals, it.id]);
        else await DB.run(`INSERT INTO inventory_items (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, vals);
        Dirty.set(false); toast('Saved.'); location.replace('#inventory');
      });
    }
  },
  stocktake: {
    title: () => 'Stock take',
    render: () => '<div id="stk"></div>',
    async mount() {
      const items = await DB.all('SELECT * FROM inventory_items ORDER BY category COLLATE NOCASE, name COLLATE NOCASE');
      const el = $('#stk');
      if (!items.length) { el.innerHTML = '<div class="card muted">Add some inventory items first.</div>'; return; }
      let cat = null;
      el.innerHTML = `<p class="muted" style="margin:0 4px 12px">Count what's on the shelf. Fields start at the expected amount; change any that differ.</p>`
        + items.map(i => {
          const head = i.category !== cat ? `${cat !== null ? '</div>' : ''}<div class="letter">${esc(i.category || 'Uncategorised')}</div><div class="card list">` : '';
          cat = i.category;
          return head + `<div class="c-row"><span class="c-main"><span class="c-n">${esc(i.name)}</span>
            <span class="muted c-sub">Expected ${fmtQty(i.qty)}${i.unit ? ' ' + esc(i.unit) : ''}</span></span>
            <input class="in count-in" type="number" inputmode="decimal" min="0" step="any" data-id="${i.id}" value="${fmtQty(i.qty)}"></div>`;
        }).join('') + `</div>
        <label class="field"><span>Notes</span><input class="in" id="stk-notes" placeholder="optional"></label>
        <div class="form-foot row" style="background:var(--bg)">
          <button class="btn" id="stk-cancel">Cancel</button>
          <button class="btn primary" style="flex:1" id="stk-save">Save stock take</button>
        </div>`;
      Dirty.set(false);
      el.addEventListener('input', (e) => { if (e.target.matches('.count-in')) { Dirty.set(true); e.target.classList.toggle('diff', +e.target.value !== items.find(i => i.id === +e.target.dataset.id).qty); } });
      $('#stk-cancel').onclick = () => history.back();
      $('#stk-save').onclick = async () => {
        const counts = [...el.querySelectorAll('.count-in')].map(x => ({ item: items.find(i => i.id === +x.dataset.id), counted: x.value === '' ? null : +x.value }));
        if (counts.some(c => c.counted == null)) return toast('Fill in every count (0 if none).');
        const diffs = counts.filter(c => c.counted !== c.item.qty).length;
        if (!confirm(`Save stock take?\n\n${diffs} item${diffs === 1 ? '' : 's'} will be updated to the counted amount.`)) return;
        await DB.run('INSERT INTO stock_takes (notes) VALUES (?)', [$('#stk-notes').value.trim() || null]);
        const tid = (await DB.one('SELECT last_insert_rowid() AS id')).id;
        await DB.tx(counts.flatMap(c => [
          { sql: 'INSERT INTO stock_take_lines (take_id, item_id, item_name, expected, counted) VALUES (?, ?, ?, ?, ?)', params: [tid, c.item.id, c.item.name, c.item.qty, c.counted] },
          ...(c.counted !== c.item.qty ? [{ sql: `UPDATE inventory_items SET qty = ?, updated_at = datetime('now') WHERE id = ?`, params: [c.counted, c.item.id] }] : [])]));
        Dirty.set(false); toast(`Stock take saved. ${diffs} adjusted.`); location.replace('#inventory');
      };
    }
  },
  rules: {
    title: () => 'Rule book',
    render: () => `
      <div class="row" style="margin-bottom:12px">
        <button class="btn" id="r-share" style="flex:1" data-tip="Send the whole rule book as text, e.g. to a client or apprentice">Share</button>
        <button class="btn primary" id="r-add" style="flex:1">+ Add rule</button>
      </div>
      <div id="r-list"></div>`,
    mount() {
      $('#r-add').onclick = () => location.hash = 'rule-edit/new';
      $('#r-share').onclick = async () => {
        const rs = await DB.all('SELECT title, body FROM rules ORDER BY sort, id');
        if (!rs.length) return toast('No rules yet.');
        const text = `${Settings.get('studio_name') || 'Studio'} rules\n\n` + rs.map((r, i) => `${i + 1}. ${r.title}${r.body ? '\n' + r.body : ''}`).join('\n\n');
        try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast('Rules copied.'); } }
        catch (e) { if (e.name !== 'AbortError') toast('Could not share.'); }
      };
      $('#r-list').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-mv]'); if (!b) return;
        e.preventDefault();
        const rs = await DB.all('SELECT id FROM rules ORDER BY sort, id');
        const i = rs.findIndex(r => r.id === +b.dataset.id), j = i + +b.dataset.mv;
        if (j < 0 || j >= rs.length) return;
        [rs[i], rs[j]] = [rs[j], rs[i]];
        await DB.tx(rs.map((r, k) => ({ sql: 'UPDATE rules SET sort = ? WHERE id = ?', params: [k, r.id] })));
        renderRules();
      });
      renderRules();
    }
  },
  'rule-edit': {
    title: (id) => id === 'new' ? 'New rule' : 'Edit rule',
    render: () => '<form id="r-form" class="card" autocomplete="off"></form>',
    async mount(id) {
      const r = id === 'new' ? {} : await DB.one('SELECT * FROM rules WHERE id = ?', [+id]);
      if (!r) { location.hash = 'rules'; return; }
      const f = $('#r-form');
      f.innerHTML = `
        <label class="field"><span>Rule</span><input class="in" name="title" value="${esc(r.title ?? '')}" required placeholder="Deposits are non-refundable"></label>
        <label class="field"><span>Details</span><textarea class="in" name="body" rows="6" placeholder="Optional explanation">${esc(r.body ?? '')}</textarea></label>
        <div class="form-foot row">
          ${r.id ? '<button type="button" class="btn danger icon-btn" id="r-del" aria-label="Delete" data-tip="Delete rule"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' : ''}
          <button type="button" class="btn" id="r-cancel">Cancel</button>
          <button type="submit" class="btn primary" style="flex:1">Save</button>
        </div>`;
      Dirty.set(false);
      f.addEventListener('input', () => Dirty.set(true));
      $('#r-cancel').onclick = () => history.back();
      const del = $('#r-del');
      if (del) del.onclick = async () => {
        if (!confirm(`Delete the rule "${r.title}"?`)) return;
        await DB.run('DELETE FROM rules WHERE id = ?', [r.id]);
        Dirty.set(false); toast('Rule deleted.'); location.replace('#rules');
      };
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(f));
        if (r.id) await DB.run('UPDATE rules SET title = ?, body = ? WHERE id = ?', [d.title.trim(), d.body.trim() || null, r.id]);
        else await DB.run('INSERT INTO rules (title, body, sort) VALUES (?, ?, (SELECT coalesce(max(sort), -1) + 1 FROM rules))', [d.title.trim(), d.body.trim() || null]);
        Dirty.set(false); toast('Saved.'); location.replace('#rules');
      });
    }
  },
  reel: {
    title: () => 'Reel',
    render: () => `
      <div class="reel-wrap">
        <div class="reel-stage">
          <canvas id="reel-cv" width="${PREVIEW_W}" height="${PREVIEW_H}"></canvas>
          <div class="reel-ctrl">
            <button class="btn icon-btn" id="reel-restart" aria-label="Play from the start" data-tip="Play from the start"><svg viewBox="0 0 24 24"><path d="M6 5v14M19 5l-10 7 10 7z"/></svg></button>
            <button class="btn icon-btn" id="reel-play" aria-label="Play"></button>
            <input type="range" id="reel-scrub" min="0" step="0.01" value="0" aria-label="Scrub">
            <span id="reel-time" class="muted"></span>
          </div>
          <div class="reel-tl" id="reel-tl"></div>
          <div class="reel-quick" id="reel-quick" hidden></div>
        </div>
        <div class="reel-side">
          <div class="seg" id="reel-tabs" style="margin-bottom:12px">
            ${[['edit', 'Edit'], ['style', 'Style'], ['music', 'Music'], ['tpl', 'Templates']].map(([k, l]) => `<button data-t="${k}" class="${R.tab === k ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}
          </div>
          <div id="reel-panel"></div>
          <button class="btn primary" id="reel-export" style="width:100%;margin:14px 0 24px">Export reel</button>
        </div>
      </div>`,
    mount() {
      reelPlayBtn(); reelRender();
      $('#reel-play').onclick = () => R.playing ? reelPause() : reelPlay();
      $('#reel-restart').onclick = () => { reelShow(0); reelPlay(); };
      reelQuickBind($('#reel-quick'));
      const sc = $('#reel-scrub');
      sc.addEventListener('input', () => { R.scrubbing = true; if (R.playing) reelPause(); R.t = +sc.value; reelSyncVideos(R.t, false); reelRender(); });
      sc.addEventListener('change', () => { R.scrubbing = false; });
      $('#reel-tabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; R.tab = b.dataset.t;
        $('#reel-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); reelPanel(); };
      $('#reel-export').onclick = () => reelExport();
      if (!['edit', 'style', 'music', 'tpl'].includes(R.tab)) R.tab = 'edit';
      reelCanvasBind($('#reel-cv'));
      reelTimeline(); reelPanel();
      document.fonts.ready.then(() => reelRender());
    }
  },
  stencil: {
    title: () => 'Stencil',
    render: () => ST.src ? `
      <div class="st-stage">
        <div class="st-view" id="st-view"><canvas id="st-canvas"></canvas>
          <button class="btn small st-fit" id="st-fit" hidden data-tip="Back to the whole image (or double-tap)">Fit</button></div>
        <div class="st-tools">
          <button class="btn icon-btn" id="st-orig" data-tip="Hold to see the original photo" aria-label="Hold for original"><svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button class="btn icon-btn" id="st-rot" data-tip="Rotate 90°" aria-label="Rotate"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>
          <button class="btn icon-btn ${ST.p.flip ? 'on' : ''}" id="st-flip" data-tip="Mirror (for hand transfers)" aria-label="Mirror"><svg viewBox="0 0 24 24"><path d="M12 3v18M8 7l-5 5 5 5V7zM16 7l5 5-5 5V7z"/></svg></button>
          <span class="ink-dots" id="st-ink">${ST_INKS.map(([c, n]) => `<button class="ink ${ST.p.ink === c ? 'on' : ''}" data-c="${c}" style="background:${c}" data-tip="${n} ink" aria-label="${n}"></button>`).join('')}</span>
          <button class="btn icon-btn" id="st-new" data-tip="Start with a new photo" aria-label="New photo" style="margin-left:auto"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></button>
        </div>
      </div>
      <div class="card st-controls">
        <div class="seg" id="st-mode" style="margin-bottom:12px">
          ${[['lines', 'Lines'], ['sketch', 'Lines + shade'], ['solid', 'Solid']].map(([k, l]) => `<button data-m="${k}" class="${ST.p.mode === k ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}
        </div>
        <div id="st-sliders"></div>
        <div class="row st-export">
          <label class="field" style="margin:0;flex:0 0 120px"><span>Print width ${help('Real size on paper in centimetres. Height follows the image proportions.')}</span>
            <input class="in" id="st-cm" type="number" inputmode="decimal" min="1" max="40" step="0.5" value="${ST.cm}"></label>
          <button class="btn" id="st-print" style="align-self:flex-end">Print</button>
          <button class="btn primary" id="st-save" style="align-self:flex-end;flex:1">Save / share</button>
        </div>
      </div>` : `
      <label class="card st-pick">
        <div class="empty-ico">${ICON.stencil}</div>
        <div style="font:26px var(--display)">Photo to stencil</div>
        <div class="muted">Take or choose a photo of a design, sketch or reference.</div>
        <span class="btn primary" style="margin-top:14px">Choose photo</span>
        <input type="file" accept="image/*" id="st-file" hidden>
      </label>`,
    mount() {
      if (!ST.src) {
        $('#st-file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { await stLoad(f); render(); } });
        return;
      }
      stSliders();
      $('#st-mode').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; ST.p.mode = b.dataset.m;
        $('#st-mode').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); stSliders(); stRun(); };
      const orig = $('#st-orig');
      orig.addEventListener('pointerdown', (e) => { e.preventDefault(); stDraw(true); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => orig.addEventListener(t, () => stDraw(false)));
      $('#st-rot').onclick = () => { ST.rot = (ST.rot + 90) % 360; stPrepare(); stRun(); ST.zoom?.reset(); };
      ST.zoom = stZoom($('#st-view'), $('#st-canvas'), $('#st-fit'));
      $('#st-flip').onclick = (e) => { ST.p.flip = !ST.p.flip; e.currentTarget.classList.toggle('on', ST.p.flip); stPrepare(); stRun(); };
      $('#st-ink').onclick = (e) => { const b = e.target.closest('.ink'); if (!b) return; ST.p.ink = b.dataset.c;
        $('#st-ink').querySelectorAll('.ink').forEach(x => x.classList.toggle('on', x === b)); stDraw(false); stSave(); };
      $('#st-new').onclick = () => { ST.src = null; render(); };
      $('#st-cm').addEventListener('change', (e) => { ST.cm = Math.min(40, Math.max(1, +e.target.value || 10)); Settings.set('st_cm', String(ST.cm)); });
      $('#st-save').onclick = stExport;
      $('#st-print').onclick = stPrint;
      stPrepare(); stRun();
    }
  },
  forms: {
    title: () => 'Forms',
    render: () => '<div id="f-list"></div>',
    async mount() {
      const t = await DB.all('SELECT id, kind, title, blocks FROM form_templates ORDER BY kind, title COLLATE NOCASE');
      const recent = await DB.all(`SELECT id, kind, title, client_name, signed_at FROM signed_forms ORDER BY signed_at DESC LIMIT 10`);
      const sec = (kind, label, tip) => `
        <div class="letter row" style="justify-content:space-between">${label} ${help(tip)}
          <button class="btn small" data-new="${kind}" style="margin-left:auto">+ New</button></div>
        <div class="card list">${t.filter(x => x.kind === kind).map(x => `
          <div class="c-row f-tpl">
            <span class="ava">${ICON[kind === 'consent' ? 'forms' : 'rules']}</span>
            <span class="c-main"><span class="c-n">${esc(x.title)}</span><span class="muted c-sub">${JSON.parse(x.blocks).length} blocks</span></span>
            <span class="f-acts"><button class="btn small icon-btn" data-dup="${x.id}" data-tip="Duplicate: start a new form from this one" aria-label="Duplicate"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button>
            <button class="btn small" data-edit="${x.id}">Edit</button>
            ${kind === 'consent' ? `<button class="btn small" data-blank="${x.id}" data-tip="Print an empty copy to fill in by hand">Print blank</button>` : ''}
            <button class="btn small primary" data-use="${x.id}">${kind === 'consent' ? 'Sign' : 'Send'}</button></span>
          </div>`).join('') || '<div class="muted" style="padding:14px">None yet.</div>'}</div>`;
      $('#f-list').innerHTML =
        sec('consent', 'Consent', 'Clients read, tick and sign on your phone or tablet. A frozen copy is kept on their record.')
        + sec('aftercare', 'Aftercare', 'Send care instructions to a client through any messaging app, or print them.')
        + (recent.length ? `<div class="letter">Recent</div><div class="card list">${recent.map(r => `
          <a class="c-row" href="#signed/${r.id}"><span class="c-main"><span class="c-n">${esc(r.title)}</span>
            <span class="muted c-sub">${esc(r.client_name || 'No client')} · ${new Date(r.signed_at + 'Z').toLocaleDateString()}</span></span>
            <span class="chip">${r.kind === 'consent' ? 'Signed' : 'Sent'}</span><svg viewBox="0 0 24 24" class="chev"><path d="M9 6l6 6-6 6"/></svg></a>`).join('')}</div>` : '');
      $('#f-list').onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.new) location.hash = 'form-edit/new-' + b.dataset.new;
        if (b.dataset.edit) location.hash = 'form-edit/' + b.dataset.edit;
        if (b.dataset.use) { Forms.ctx = {}; location.hash = 'form-sign/' + b.dataset.use; }
        if (b.dataset.blank) printBlankForm(+b.dataset.blank);
        if (b.dataset.dup) (async () => {
          // A copy to adapt; the original stays as it is. Opens straight in the editor.
          const src = t.find(x => x.id === +b.dataset.dup);
          await DB.run('INSERT INTO form_templates (kind, title, blocks) VALUES (?, ?, ?)', [src.kind, src.title + ' (copy)', src.blocks]);
          const id = (await DB.one('SELECT last_insert_rowid() AS id')).id;
          toast('Copy made. Rename and adjust it.'); location.hash = 'form-edit/' + id;
        })();
      };
    }
  },
  'form-edit': {
    title: (id) => String(id).startsWith('new') ? 'New form' : 'Edit form',
    render: () => '<form id="fe-form" class="card" autocomplete="off"></form>',
    async mount(id) {
      const isNew = id.startsWith('new');
      const t = isNew ? { kind: id.split('-')[1] === 'aftercare' ? 'aftercare' : 'consent', title: '', blocks: '[]' }
        : await DB.one('SELECT * FROM form_templates WHERE id = ?', [+id]);
      if (!t) { location.hash = 'forms'; return; }
      const blocks = JSON.parse(t.blocks);
      if (isNew && !blocks.length) blocks.push({ t: 'h', text: '' }, { t: 'p', text: '' });
      const f = $('#fe-form');
      const TYPES = { h: 'Heading', sub: 'Subheading', p: 'Paragraph', li: 'Bullet', check: 'Tick box', field: 'Answer field', choice: 'Choice' };
      const flag = (i, k, label, on, tip) => `<label class="toggle blk-flag" data-tip="${tip}"><input type="checkbox" data-i="${i}" data-k="${k}" ${on ? 'checked' : ''}><span>${label}</span></label>`;
      const extras = (b, i) =>
        b.t === 'field' ? `<div class="blk-extra"><input class="in" data-i="${i}" data-k="v" value="${esc(b.v || '')}" placeholder="Prefill, e.g. {client} or {phone}">
          ${flag(i, 'long', 'Long', b.long, 'Several lines, for notes')}</div>`
        : b.t === 'choice' ? `<div class="blk-extra"><input class="in" data-i="${i}" data-k="opts" value="${esc(b.opts || '')}" placeholder="Options, separated by /">
          ${flag(i, 'req', 'Required', b.req, 'The client must pick one before signing')}</div>`
        : b.t === 'check' ? `<div class="blk-extra">${flag(i, 'opt', 'Optional', b.opt, 'Can be left unticked when signing')}</div>` : '';
      const draw = () => {
        f.innerHTML = `
          <div class="two">
            <label class="field"><span>Title</span><input class="in" id="fe-title" value="${esc(t.title)}" required></label>
            <label class="field"><span>Type</span><select class="in" id="fe-kind">
              <option value="consent" ${t.kind === 'consent' ? 'selected' : ''}>Consent (signed)</option>
              <option value="aftercare" ${t.kind === 'aftercare' ? 'selected' : ''}>Aftercare (sent)</option></select></label>
          </div>
          <div class="lbl">Content ${help('Placeholders fill in automatically: {client}, {first}, {phone}, {email}, {description} and {quote} (from the booking), {artist}, {studio}, {date}, and your {artist_phone}, {instagram}, {facebook}, {tiktok} from Settings. Lines whose placeholders are empty are left out. Tick boxes must be ticked before signing unless marked Optional.')}</div>
          <div id="fe-blocks">${blocks.map((b, i) => `
            <div class="blk blk-${b.t}" data-i="${i}">
              <div class="blk-bar"><span class="chip">${TYPES[b.t]}</span>
                <span class="row" style="gap:4px;margin-left:auto">
                  <button type="button" class="mini" data-act="up" aria-label="Move up" ${i ? '' : 'disabled'}>&uarr;</button>
                  <button type="button" class="mini" data-act="down" aria-label="Move down" ${i < blocks.length - 1 ? '' : 'disabled'}>&darr;</button>
                  <button type="button" class="mini del" data-act="del" aria-label="Remove">&times;</button></span></div>
              <textarea class="in" rows="${b.t === 'p' ? 3 : 1}" data-i="${i}" placeholder="${TYPES[b.t]} text">${esc(b.text)}</textarea>
              ${extras(b, i)}
            </div>`).join('')}</div>
          <div class="row add-blocks">${Object.entries(TYPES).map(([k, v]) => `<button type="button" class="btn small" data-add="${k}">+ ${v}</button>`).join('')}</div>
          <div class="form-foot row">
            ${isNew ? '' : '<button type="button" class="btn danger icon-btn" id="fe-del" data-tip="Delete template" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>'}
            <button type="button" class="btn" id="fe-cancel">Cancel</button>
            <button type="submit" class="btn primary" style="flex:1">Save</button>
          </div>`;
        $('#fe-cancel').onclick = () => history.back();
        const del = $('#fe-del');
        if (del) del.onclick = async () => {
          if (!confirm(`Delete the "${t.title}" template?\n\nForms already signed with it are kept.`)) return;
          await DB.run('DELETE FROM form_templates WHERE id = ?', [t.id]);
          Dirty.set(false); toast('Template deleted.'); location.replace('#forms');
        };
      };
      draw();
      f.addEventListener('input', (e) => {
        Dirty.set(true);
        if (e.target.matches('textarea[data-i]')) blocks[+e.target.dataset.i].text = e.target.value;
        else if (e.target.matches('input.in[data-k]')) blocks[+e.target.dataset.i][e.target.dataset.k] = e.target.value;
        if (e.target.id === 'fe-title') t.title = e.target.value;
      });
      f.addEventListener('change', (e) => {
        if (e.target.id === 'fe-kind') { t.kind = e.target.value; Dirty.set(true); }
        if (e.target.matches('input[type=checkbox][data-k]')) { blocks[+e.target.dataset.i][e.target.dataset.k] = e.target.checked; Dirty.set(true); }
      });
      f.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.add) { blocks.push({ t: b.dataset.add, text: '' }); Dirty.set(true); draw(); f.querySelector(`textarea[data-i="${blocks.length - 1}"]`).focus(); return; }
        const i = +b.closest('.blk')?.dataset.i;
        if (b.dataset.act === 'del') blocks.splice(i, 1);
        else if (b.dataset.act === 'up') blocks.splice(i - 1, 0, blocks.splice(i, 1)[0]);
        else if (b.dataset.act === 'down') blocks.splice(i + 1, 0, blocks.splice(i, 1)[0]);
        else return;
        Dirty.set(true); draw();
      });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = $('#fe-title').value.trim();
        if (!title) return toast('Give the form a title.');
        const clean = JSON.stringify(blocks.map(b => {
          const o = { t: b.t, text: b.text.trim() };
          if (b.t === 'field') { if (b.v?.trim()) o.v = b.v.trim(); if (b.long) o.long = true; }
          if (b.t === 'choice') { o.opts = (b.opts || '').trim(); if (b.req) o.req = true; }
          if (b.t === 'check' && b.opt) o.opt = true;
          return o;
        }).filter(b => b.text));
        if (isNew) await DB.run('INSERT INTO form_templates (kind, title, blocks) VALUES (?, ?, ?)', [t.kind, title, clean]);
        else await DB.run(`UPDATE form_templates SET kind = ?, title = ?, blocks = ?, updated_at = datetime('now') WHERE id = ?`, [t.kind, title, clean, t.id]);
        Dirty.set(false); toast('Form saved.'); location.replace('#forms');
      });
      Dirty.set(false);
    }
  },
  'form-sign': {
    title: () => 'Form',
    render: () => '<div id="fs"></div>',
    async mount(id) {
      const t = await DB.one('SELECT * FROM form_templates WHERE id = ?', [+id]);
      if (!t) { location.hash = 'forms'; return; }
      $('#view-title').textContent = t.kind === 'consent' ? 'Sign' : 'Aftercare';
      const ctx = Forms.ctx || {}; Forms.ctx = null;
      let client = ctx.clientId ? await DB.one('SELECT * FROM clients WHERE id = ?', [ctx.clientId]) : null;
      const booking = ctx.bookingId ? await DB.one('SELECT * FROM bookings WHERE id = ?', [ctx.bookingId]) : null;
      const logoUrl = await Media.url(Settings.get('studio_logo_ref'));
      const blocks = JSON.parse(t.blocks);
      const consent = t.kind === 'consent';
      const el = $('#fs');
      el.innerHTML = `
        <div class="card"><label class="field" style="margin:0"><span>Client</span>
          <div class="picker"><input class="in" id="fs-client" placeholder="Search clients…" value="${esc(client ? fullName(client) : '')}" autocomplete="off">
          <div class="pick-list" id="fs-list" hidden></div></div></label></div>
        <div class="sheet sheet-${t.kind}" id="fs-sheet"></div>
        <div class="form-foot row" style="background:var(--bg)">
          <button type="button" class="btn" id="fs-cancel">Cancel</button>
          ${consent ? '<button type="button" class="btn primary" style="flex:1" id="fs-save">Sign & save</button>'
            : '<button type="button" class="btn" id="fs-print">Print</button><button type="button" class="btn primary" style="flex:1" id="fs-share">Send</button>'}
        </div>`;
      const answers = { checks: {}, fields: {} };
      // Prefilled fields follow the chosen client until the artist types over them.
      const typed = new Set();
      const prefill = (c) => blocks.forEach((b, i) => { if (b.t === 'field' && b.v && !typed.has(i)) answers.fields[i] = fillPlaceholders(b.v, c).replace(/^_+$/, ''); });
      let pad = null;
      const drawSheet = () => {
        const c = formCtx(client, booking);
        prefill(c);
        $('#fs-sheet').innerHTML = (logoUrl ? `<img class="sheet-logo" src="${logoUrl}" alt="">` : '') + renderFormBlocks(blocks, c, answers, consent)
          + (consent ? `<div class="sig-wrap"><div class="sig-label">Signature <button type="button" class="link" id="fs-clear">Clear</button></div>
              <canvas id="fs-sig"></canvas><div class="sig-line">${esc(c.client)} · ${esc(c.date)}</div></div>` : '');
        if (consent) { pad = signaturePad($('#fs-sig')); $('#fs-clear').onclick = () => pad.clear(); }
      };
      drawSheet();
      $('#fs-sheet').addEventListener('change', (e) => {
        if (e.target.dataset.check != null) answers.checks[e.target.dataset.check] = e.target.checked;
        if (e.target.dataset.choice != null) answers.fields[e.target.dataset.choice] = e.target.value;
        Dirty.set(true);
      });
      $('#fs-sheet').addEventListener('input', (e) => { if (e.target.dataset.field != null) { answers.fields[e.target.dataset.field] = e.target.value; typed.add(+e.target.dataset.field); Dirty.set(true); } });
      clientPicker($('#fs-client'), $('#fs-list'), async (cid) => {
        client = await DB.one('SELECT * FROM clients WHERE id = ?', [cid]);
        const sig = pad && !pad.empty() ? pad.data() : null;
        drawSheet(); if (sig) pad.restore(sig);
      });
      $('#fs-cancel').onclick = () => history.back();
      const record = async (sigRef) => {
        const c = formCtx(client, booking);
        const frozen = blocks.map(b => blankLine(b, c) ? null : { ...b, text: fillPlaceholders(b.text, c) });
        frozen.forEach((b, i) => { if (!b) frozen[i] = { t: 'p', text: '' }; });   // keep indexes aligned with answers
        await DB.run(`INSERT INTO signed_forms (client_id, booking_id, template_id, kind, title, client_name, blocks, answers, signature_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [client?.id ?? null, ctx.bookingId ?? null, t.id, t.kind, t.title, client ? fullName(client) : null, JSON.stringify(frozen), JSON.stringify(answers), sigRef]);
        return (await DB.one('SELECT last_insert_rowid() AS id')).id;
      };
      if (consent) $('#fs-save').onclick = async () => {
        if (!client) return toast('Choose the client first.');
        const checks = blocks.map((b, i) => b.t === 'check' && !b.opt ? i : -1).filter(i => i >= 0);
        if (checks.some(i => !answers.checks[i])) return toast('All required boxes need to be ticked before signing.');
        const missing = blocks.find((b, i) => b.t === 'choice' && b.req && !answers.fields[i]);
        if (missing) return toast(`Choose an option for "${missing.text}".`);
        if (pad.empty()) return toast('Please sign in the box.');
        const sigRef = await Media.save(await pad.blob(), 'png');
        const sid = await record(sigRef);
        Dirty.set(false); toast('Consent signed and saved.'); location.replace('#signed/' + sid);
      };
      else {
        $('#fs-print').onclick = () => window.print();
        $('#fs-share').onclick = async () => {
          const text = formAsText(blocks, formCtx(client, booking));
          try {
            if (navigator.share) await navigator.share({ title: t.title, text });
            else { await navigator.clipboard.writeText(text); toast('Copied. Paste it into any message.'); }
          } catch (e) { if (e.name === 'AbortError') return; toast('Could not share: ' + e.message); return; }
          if (client) { await record(null); toast('Logged on ' + fullName(client) + '\'s record.'); }
          Dirty.set(false);
        };
      }
      Dirty.set(false);
    }
  },
  signed: {
    title: () => 'Form',
    render: () => '<div id="sf"></div>',
    async mount(id) {
      const s = await DB.one('SELECT * FROM signed_forms WHERE id = ?', [+id]);
      const el = $('#sf');
      if (!s) { el.innerHTML = '<div class="card muted">Form not found.</div>'; return; }
      const answers = JSON.parse(s.answers);
      const sig = await Media.url(s.signature_ref);
      const logoUrl = await Media.url(Settings.get('studio_logo_ref'));
      const when = new Date(s.signed_at + 'Z');
      el.innerHTML = `
        <div class="sheet sheet-${s.kind}">
          ${logoUrl ? `<img class="sheet-logo" src="${logoUrl}" alt="">` : ''}
          ${renderFormBlocks(JSON.parse(s.blocks), null, answers, false, true)}
          ${s.kind === 'consent' ? `<div class="sig-wrap"><div class="sig-label">Signature</div>
            ${sig ? `<img class="sig-img" src="${sig}" alt="Signature">` : '<div class="muted">Signature file missing.</div>'}
            <div class="sig-line">${esc(s.client_name || '')} · ${when.toLocaleString()}</div></div>`
          : `<p class="sig-line">Sent to ${esc(s.client_name || '')} · ${when.toLocaleString()}</p>`}
        </div>
        <div class="row no-print" style="margin:14px 0 24px">
          ${s.client_id ? `<a class="btn" href="#client/${s.client_id}">Client</a>` : ''}
          <button class="btn danger icon-btn" id="sf-del" data-tip="Delete this record" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
          <button class="btn primary" style="flex:1" onclick="window.print()" data-tip="Choose 'Save as PDF' in the print dialog to keep or email a copy.">Print / PDF</button>
        </div>`;
      $('#sf-del').onclick = async () => {
        if (!confirm(`Delete this ${s.kind === 'consent' ? 'signed consent form' : 'aftercare record'}?\n\nThis cannot be undone.`)) return;
        await DB.run('DELETE FROM signed_forms WHERE id = ?', [s.id]);
        await Media.release(s.signature_ref);
        toast('Deleted.'); history.back();
      };
    }
  },
  settings: {
    title: () => 'Settings',
    render() {
      return `
      <div class="card"><h2>Profile ${help('Shown on your home screen, and later on forms and exports.')}</h2>
        <label class="field"><span>Artist name</span><input class="in" id="s-name" value="${esc(Settings.get('artist_name'))}" autocomplete="name"></label>
        <label class="field"><span>Studio</span><input class="in" id="s-studio" value="${esc(Settings.get('studio_name'))}"></label>
        <div class="field"><span class="lbl">Studio logo ${help('A PNG with a transparent background works best. Used on reel cards, as a reel watermark and at the top of forms.')}</span>
          <div class="row" style="flex-wrap:nowrap">
            <span class="logo-box" id="s-logo-box"></span>
            <label class="btn small"><span id="s-logo-l">Choose PNG</span><input type="file" accept="image/png,image/*" hidden id="s-logo"></label>
            <button class="btn small danger" id="s-logo-rm" hidden>Remove</button>
          </div></div>
        <div class="two">
          <label class="field"><span>Currency symbol ${help('Shown before quotes and deposits, e.g. R, $, £, €.')}</span><input class="in" id="s-cur" value="${esc(Settings.get('currency'))}" maxlength="4"></label>
        </div>
      </div>
      <div class="card"><h2>Working hours ${help('Your normal day. Used for new bookings and for the open appointments you share. Longer sessions can still run past the end time.')}</h2>
        <div class="two">
          <label class="field"><span>Start</span><input class="in" id="s-start" type="time" value="${esc(Settings.get('day_start', '10:00'))}"></label>
          <label class="field"><span>Finish</span><input class="in" id="s-end" type="time" value="${esc(Settings.get('day_end', '17:00'))}"></label>
        </div>
        <label class="field"><span>Most tattoos per day ${help('Once a day has this many tattoo bookings, it shows as booked on your open appointments.')}</span>
          <input class="in" id="s-maxday" type="number" min="1" max="10" value="${esc(Settings.get('max_per_day', '1'))}"></label>
      </div>
      <div class="card"><h2>Days off ${help('Days you never tattoo. They are greyed out in the calendar and skipped when a new booking picks a day. You can still book on them; InkForge just checks with you first.')}</h2>
        <div id="off-card"></div></div>
      <div class="card"><h2>Contact details ${help('Printed at the bottom of your aftercare form. Leave any blank to hide that line.')}</h2>
        <div class="two">
          <label class="field"><span>Contact number</span><input class="in" id="s-aphone" type="tel" value="${esc(Settings.get('artist_phone'))}"></label>
          <label class="field"><span>Instagram</span><input class="in" id="s-ig" value="${esc(Settings.get('artist_instagram'))}" placeholder="instagram.com/…" autocapitalize="off"></label>
          <label class="field"><span>Facebook</span><input class="in" id="s-fb" value="${esc(Settings.get('artist_facebook'))}" placeholder="facebook.com/…" autocapitalize="off"></label>
          <label class="field"><span>TikTok</span><input class="in" id="s-tt" value="${esc(Settings.get('artist_tiktok'))}" placeholder="tiktok.com/@…" autocapitalize="off"></label>
        </div>
      </div>
      <div class="card"><h2>Google Calendar ${help('Bookings sync both ways with an "InkForge" calendar in your Google account. Only time, title and the labelled note lines are used; everything else in Google is ignored.')}</h2>
        <div id="gcal-status" style="margin-bottom:12px"></div>
        <label class="field"><span>OAuth client ID ${help('Created once in Google Cloud. See the setup guide below.')}</span>
          <input class="in" id="s-gid" value="${esc(Settings.get('gcal_client_id'))}" placeholder="…apps.googleusercontent.com" autocapitalize="off" spellcheck="false"></label>
        <label class="toggle" style="display:inline-flex;margin-bottom:12px" data-tip="Your personal Google events appear as grey blocks, with no details.">
          <input type="checkbox" id="s-gbusy" ${Settings.get('gcal_busy', '1') === '1' ? 'checked' : ''}><span>Show personal events as busy</span></label>
        <div class="row">
          <button class="btn primary" id="g-connect">Connect</button>
          <button class="btn primary" id="g-sync" hidden>Sync now</button>
          <button class="btn danger" id="g-off" hidden>Disconnect</button>
        </div>
        <details class="guide"><summary>Setup guide (one time, about 5 minutes)</summary>
          <ol>
            <li>Open <b>console.cloud.google.com</b> and create a project called <b>InkForge</b>.</li>
            <li><b>APIs &amp; Services › Library</b>: search <b>Google Calendar API</b> and press Enable.</li>
            <li><b>Google Auth Platform</b> (OAuth consent screen): app name InkForge, your email, audience <b>External</b>. Under <b>Audience › Test users</b>, add your own Gmail address.</li>
            <li><b>Clients › Create client</b>: type <b>Web application</b>. Under <b>Authorized JavaScript origins</b> add <code>${esc(location.origin)}</code> (add your https address later too).</li>
            <li>Copy the <b>Client ID</b>, paste it above, then press Connect.</li>
          </ol>
          <p class="muted">Google only lets InkForge manage calendars it creates, plus see when you're busy. It cannot read or change your other events.</p>
        </details>
      </div>
      <div class="card"><h2>Storage ${help('Data is kept in an on-device SQLite database, not browser localStorage. "Protected" asks the browser never to clear it automatically.')}</h2>
        <div id="storage-info" class="muted">Checking…</div>
      </div>
      <div class="card"><h2>Backup ${help('A backup holds everything: clients, bookings, forms, portfolio, stock, rules, reel templates, settings and all photos. Save one regularly, e.g. to cloud storage.')}</h2>
        <div id="last-backup" class="muted" style="margin-bottom:12px"></div>
        <div class="row">
          <button class="btn primary" id="b-export" data-tip="Save this workspace as a file: a backup, or to open it on another device">Save workspace file</button>
          <button class="btn" id="b-merge" data-tip="Add another backup's data to yours, e.g. from another artist or device. Pick which sections; duplicates are skipped.">Merge from file…</button>
          ${WS.list.length > 1 ? '<button class="btn" id="b-mergews" data-tip="Copy sections from another workspace on this device into this one, e.g. to update every artist from a test workspace">Merge from workspace…</button>' : ''}
          <button class="btn danger" id="b-import" data-tip="Replace everything on this device with a backup">Replace with backup…</button>
        </div>
        <input type="file" id="merge-file" accept=".inkforge,.sqlite,.db" hidden>
      </div>`;
    },
    async mount() {
      const save = (k) => (e) => Settings.set(k, e.target.value.trim());
      $('#s-name').addEventListener('change', save('artist_name'));
      $('#s-studio').addEventListener('change', save('studio_name'));
      $('#s-cur').addEventListener('change', save('currency'));
      $('#s-start').addEventListener('change', save('day_start'));
      $('#s-end').addEventListener('change', save('day_end'));
      $('#s-maxday').addEventListener('change', (e) => Settings.set('max_per_day', String(Math.max(1, +e.target.value || 1))));
      const drawLogo = async () => {
        const ref = Settings.get('studio_logo_ref'), u = await Media.url(ref);
        $('#s-logo-box').innerHTML = u ? `<img src="${u}" alt="Studio logo">` : '<span class="muted">None</span>';
        $('#s-logo-l').textContent = u ? 'Change' : 'Choose PNG'; $('#s-logo-rm').hidden = !u;
      };
      drawLogo();
      $('#s-logo').addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try {
          // Keep transparency: redraw as PNG, capped at 1000 px so it stays small.
          const bmp = await createImageBitmap(f), sc = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
          const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
          c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          const ref = await Media.save(await new Promise(r => c.toBlob(r, 'image/png')), 'png');
          const old = Settings.get('studio_logo_ref');
          await Settings.set('studio_logo_ref', ref);
          if (old && old !== ref) await Media.release(old);
          drawLogo(); toast('Logo saved.');
        } catch { toast('Could not read that image.'); }
        e.target.value = '';
      });
      $('#s-logo-rm').onclick = async () => {
        if (!confirm('Remove the studio logo?')) return;
        const old = Settings.get('studio_logo_ref');
        await Settings.set('studio_logo_ref', ''); await Media.release(old); drawLogo();
      };
      renderDaysOff();
      $('#s-aphone').addEventListener('change', save('artist_phone'));
      $('#s-ig').addEventListener('change', save('artist_instagram'));
      $('#s-fb').addEventListener('change', save('artist_facebook'));
      $('#s-tt').addEventListener('change', save('artist_tiktok'));
      $('#s-gid').addEventListener('change', save('gcal_client_id'));
      $('#s-gbusy').addEventListener('change', async (e) => { await Settings.set('gcal_busy', e.target.checked ? '1' : '0'); Gcal.soon(); });
      const gsync = async () => {
        try { await Gcal.sync({ interactive: true }); toast('Synced with Google Calendar.'); }
        catch (e) { toast('Google sync: ' + e.message, 6000); }
        renderGcalStatus();
      };
      $('#g-connect').onclick = async () => {
        const id = $('#s-gid').value.trim();
        if (!/\.apps\.googleusercontent\.com$/.test(id)) return toast('Paste the Client ID first (ends in .apps.googleusercontent.com).', 5000);
        await Settings.set('gcal_client_id', id); await Settings.set('gcal_on', '1');
        await gsync();
        if (!Gcal.hasToken()) { await Settings.set('gcal_on', '0'); renderGcalStatus(); }
      };
      $('#g-sync').onclick = gsync;
      $('#g-off').onclick = async () => {
        if (!confirm('Disconnect Google Calendar?\n\nBookings stay in InkForge and in Google; they just stop syncing.')) return;
        await Gcal.disconnect(); renderGcalStatus();
      };
      renderGcalStatus();
      $('#b-export').onclick = exportBackup;
      $('#b-import').onclick = () => $('#import-file').click();
      $('#b-merge').onclick = () => $('#merge-file').click();
      const mws = $('#b-mergews');
      if (mws) mws.onclick = () => {
        const others = WS.list.filter(x => x !== WS.cur);
        const o = document.createElement('div'); o.id = 'merge-dlg';
        o.innerHTML = `<div class="card"><h2>Merge from workspace</h2>
          <p class="muted" style="margin-top:0">Pick the workspace to copy from. Next you choose which sections.</p>
          <div class="merge-list">${others.map(x => `<button class="merge-row" data-from="${x.id}"><span class="c-main"><b>${esc(x.name)}</b></span></button>`).join('')}</div>
          <button class="btn" id="mw-cancel" style="width:100%;margin-top:12px">Cancel</button></div>`;
        document.body.appendChild(o);
        o.onclick = (e) => {
          if (e.target.closest('#mw-cancel')) return o.remove();
          const b = e.target.closest('[data-from]'); if (!b) return;
          o.remove(); openMerge(WS.get(b.dataset.from));
        };
      };
      $('#merge-file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openMerge(f); });
      const lb = Settings.get('last_backup');
      $('#last-backup').textContent = lb ? 'Last backup: ' + new Date(lb).toLocaleString() : 'No backup yet.';
      await renderStorage();
    }
  }
};

function renderDaysOff() {
  const el = $('#off-card'); if (!el) return;
  const o = daysOff();
  el.innerHTML = `
    <div class="lbl">Every week</div>
    <div class="off-days">${WEEKDAYS.map(([n, l]) => `<button type="button" class="${o.weekly.includes(n) ? 'on' : ''}" data-wd="${n}" aria-pressed="${o.weekly.includes(n)}">${l}</button>`).join('')}</div>
    <label class="field" style="margin-top:12px"><span>Repeat until ${help('Leave empty to keep these days off for good. Set a date if you plan your days off week by week or month by month.')}</span>
      <input class="in" type="date" id="off-until" value="${o.until}"></label>
    <div class="lbl">Other days off ${help('Single days, e.g. holidays or a day you have blocked out this month.')}</div>
    <div class="off-dates">${o.dates.sort().map(k => `<span class="chip">${esc(fmtDay(k))}<button type="button" data-rmdate="${k}" aria-label="Remove">&times;</button></span>`).join('') || '<span class="muted" style="font-size:13px">None</span>'}</div>
    <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input class="in" type="date" id="off-add-d"><button type="button" class="btn small" id="off-add">Add day</button></div>
    <button type="button" class="btn small danger" id="off-reset" style="margin-top:12px" ${o.weekly.length || o.dates.length || o.until ? '' : 'disabled'}>Reset days off</button>`;
  const put = async (n) => { await Settings.set('days_off', JSON.stringify(n)); renderDaysOff(); };
  el.onclick = async (e) => {
    const wd = e.target.closest('[data-wd]');
    if (wd) {
      const n = +wd.dataset.wd, has = o.weekly.includes(n);
      if (!has && o.weekly.length >= 6) return toast('Keep at least one day a week open for bookings.');
      return put({ ...o, weekly: has ? o.weekly.filter(x => x !== n) : [...o.weekly, n] });
    }
    const rm = e.target.closest('[data-rmdate]');
    if (rm) return put({ ...o, dates: o.dates.filter(k => k !== rm.dataset.rmdate) });
    if (e.target.id === 'off-add') {
      const k = $('#off-add-d').value; if (!k) return toast('Pick a date first.');
      if (o.dates.includes(k)) return toast('That day is already off.');
      return put({ ...o, dates: [...o.dates, k] });
    }
    if (e.target.id === 'off-reset' && confirm('Clear all your days off?\n\nYou can set them again straight away.')) return put({ weekly: [], until: '', dates: [] });
  };
  $('#off-until').onchange = (e) => put({ ...o, until: e.target.value });
}

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
// The open workspace by default; any other workspace's file can be built without opening it.
async function buildBackup(w = WS.cur) {
  const db = await DB.exportBytes(w === WS.cur ? undefined : WS.dbPath(w));
  const media = [];
  for await (const [name, h] of (await Media.dir(w)).entries()) {
    if (h.kind === 'file') media.push({ name, bytes: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
  }
  const manifest = new TextEncoder().encode(JSON.stringify({ v: 1, name: w?.name, db: db.length, media: media.map(m => ({ name: m.name, len: m.bytes.length })) }));
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

/* ---------- Merge from a backup ----------
   Adds another backup's data to this device instead of replacing it. Every table belongs to one
   section the artist can tick; rows are compared by content (never by name), so anything already
   here is skipped. Ids are remapped, and a linked row from an unticked section (e.g. the client of
   a booking) is brought along only when needed. Media files keep their content-hash names. */
const MERGE_SECTIONS = [
  ['clients', 'Clients', 'Phonebook entries and their photos'],
  ['bookings', 'Bookings', 'Appointments and reference photos'],
  ['forms', 'Forms', 'Form templates and signed forms'],
  ['portfolio', 'Portfolio', 'Tattoos, art and flash with photos'],
  ['inventory', 'Inventory', 'Stock items and stock takes'],
  ['rules', 'Rule book', 'Your studio rules'],
  ['reel', 'Reel templates', 'Saved reel templates and their images'],
  ['settings', 'Settings', 'Profile, quote and app settings, only where yours are still blank']
];
// table -> { section, fk: { column: parentTable }, refs: [media columns], skip: [columns not compared or copied] }.
// section null = device-specific, never merged.
const MERGE_TABLES = {
  clients: { section: 'clients', refs: ['photo_ref'] },
  bookings: { section: 'bookings', fk: { client_id: 'clients', followup_of: 'bookings' }, skip: ['gcal_id', 'gcal_updated', 'gcal_synced_at'] },
  booking_photos: { section: 'bookings', fk: { booking_id: 'bookings' }, refs: ['photo_ref'] },
  form_templates: { section: 'forms' },
  signed_forms: { section: 'forms', fk: { client_id: 'clients', booking_id: 'bookings', template_id: 'form_templates' }, refs: ['signature_ref'] },
  portfolio_items: { section: 'portfolio', fk: { client_id: 'clients', booking_id: 'bookings' } },
  portfolio_photos: { section: 'portfolio', fk: { item_id: 'portfolio_items' }, refs: ['photo_ref', 'thumb_ref'] },
  inventory_items: { section: 'inventory' },
  stock_takes: { section: 'inventory' },
  stock_take_lines: { section: 'inventory', fk: { take_id: 'stock_takes', item_id: 'inventory_items' } },
  rules: { section: 'rules' },
  settings: { section: 'settings' },        // handled by key, see mergeSettings
  app_meta: { section: null }, gcal_deletes: { section: null }, gcal_busy: { section: null }
};
const MERGE_ORDER = ['clients', 'bookings', 'booking_photos', 'form_templates', 'signed_forms', 'portfolio_items',
  'portfolio_photos', 'inventory_items', 'stock_takes', 'stock_take_lines', 'rules'];
// Settings never copied: this device's own sync state, accounts and bookkeeping.
const MERGE_SETTING_SKIP = /^(gcal_|last_backup$|reel_templates$|reel_style$|forms_)/;
const MERGE_META_COLS = new Set(['id', 'created_at', 'updated_at', 'sort']);

function parseBackup(bytes) {
  const magic = new TextDecoder().decode(bytes.slice(0, 15));
  if (magic === 'SQLite format 3') return { db: bytes, media: new Map() };
  if (!magic.startsWith(BACKUP_MAGIC)) throw new Error('That file is not an InkForge backup.');
  const mlen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(BACKUP_MAGIC.length);
  let off = BACKUP_MAGIC.length + 4;
  const man = JSON.parse(new TextDecoder().decode(bytes.subarray(off, off + mlen))); off += mlen;
  const db = bytes.slice(off, off + man.db); off += man.db;
  const media = new Map();
  for (const m of man.media) { media.set(m.name, bytes.subarray(off, off + m.len)); off += m.len; }
  return { db, media, name: man.name };
}

// Comparable fingerprint of a row: every column except ids, timestamps, sort and skipped ones.
// Clients also match on phone digits or email, so the same person with an edited note still matches.
// `cols` = columns both databases have, so a backup from an older version still matches.
function mergeFp(table, row, cols) {
  const cfg = MERGE_TABLES[table], skip = new Set([...(cfg.skip || []), ...MERGE_META_COLS]);
  const o = {};
  for (const k of [...cols].sort()) if (!skip.has(k)) o[k] = row[k] == null ? null : String(row[k]).trim();
  return JSON.stringify(o);
}
const clientKeys = (c) => [c.phone && 'p:' + String(c.phone).replace(/\D/g, '').slice(-9), c.email && 'e:' + String(c.email).trim().toLowerCase()]
  .filter(k => k && k.length > 4);

async function mergeBackup(src, media, picked) {
  const stats = {}; MERGE_SECTIONS.forEach(([k]) => stats[k] = { added: 0, skipped: 0 });
  const idMap = {}, local = {}, needRefs = new Set();
  const localCols = {}, fpCols = {};
  for (const t of MERGE_ORDER) {
    idMap[t] = new Map();
    localCols[t] = new Set((await DB.all(`PRAGMA table_info("${t}")`)).map(c => c.name));
    const srcCols = src[t]?.length ? Object.keys(src[t][0]) : [...localCols[t]];
    fpCols[t] = srcCols.filter(c => localCols[t].has(c));
    const rows = await DB.all(`SELECT * FROM "${t}"`);
    local[t] = new Map(rows.map(r => [mergeFp(t, r, fpCols[t]), r.id ?? true]));
    if (t === 'clients') for (const r of rows) for (const k of clientKeys(r)) local[t].set(k, r.id);
  }
  const byId = {}; for (const t of MERGE_ORDER) byId[t] = new Map((src[t] || []).map(r => [r.id, r]));

  // Returns this device's id for a backup row, adding the row if it isn't here yet.
  async function bring(t, row) {
    if (row.id != null && idMap[t].has(row.id)) return idMap[t].get(row.id);
    const cfg = MERGE_TABLES[t], out = { ...row };
    for (const [col, parent] of Object.entries(cfg.fk || {})) {
      const pid = row[col];
      out[col] = pid == null ? null : byId[parent].has(pid) ? await bring(parent, byId[parent].get(pid)) : null;
    }
    for (const c of cfg.skip || []) out[c] = null;
    const fp = mergeFp(t, out, fpCols[t]);
    let hit = local[t].get(fp);
    if (hit == null && t === 'clients') for (const k of clientKeys(out)) if (local[t].has(k)) { hit = local[t].get(k); break; }
    const sec = cfg.section;
    if (hit != null) { stats[sec].skipped++; if (row.id != null) idMap[t].set(row.id, hit); return hit; }
    const cols = Object.keys(out).filter(c => c !== 'id' && localCols[t].has(c));
    await DB.run(`INSERT INTO "${t}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => out[c]));
    const nid = row.id != null ? (await DB.one('SELECT last_insert_rowid() AS id')).id : true;
    for (const c of cfg.refs || []) if (out[c]) needRefs.add(out[c]);
    local[t].set(fp, nid);
    if (t === 'clients') for (const k of clientKeys(out)) local[t].set(k, nid);
    if (row.id != null) idMap[t].set(row.id, nid);
    stats[sec].added++;
    return nid;
  }
  for (const t of MERGE_ORDER) if (picked.has(MERGE_TABLES[t].section)) for (const row of src[t] || []) await bring(t, row);

  // Settings live as key/value rows; merge them by key.
  const theirs = Object.fromEntries((src.settings || []).map(r => [r.key, r.value]));
  const refsIn = (v) => (String(v || '').match(/[0-9a-f]{32}\.(?:png|jpe?g|webp)/g) || []);
  if (picked.has('reel') && theirs.reel_templates) {
    let list = []; try { list = JSON.parse(theirs.reel_templates); } catch {}
    const mine = reelTemplates();
    const sig = (t) => JSON.stringify([t.style, t.slots, t.clipTrans, t.outroTrans]);
    const have = new Set(mine.map(sig)), names = new Set(mine.map(t => t.name));
    for (const t of list) {
      if (have.has(sig(t))) { stats.reel.skipped++; continue; }
      let name = t.name || 'Template'; while (names.has(name)) name += ' (imported)';
      names.add(name); have.add(sig(t));
      mine.push({ ...t, id: Date.now().toString(36) + stats.reel.added, name });
      refsIn(JSON.stringify(t)).forEach(r => needRefs.add(r)); stats.reel.added++;
    }
    await Settings.set('reel_templates', JSON.stringify(mine));
    if (!Settings.get('reel_style') && theirs.reel_style) { await Settings.set('reel_style', theirs.reel_style); refsIn(theirs.reel_style).forEach(r => needRefs.add(r)); }
  }
  if (picked.has('settings')) {
    for (const [k, v] of Object.entries(theirs)) {
      if (MERGE_SETTING_SKIP.test(k) || v == null || v === '') continue;
      if (Settings.get(k)) { stats.settings.skipped++; continue; }
      await Settings.set(k, v); refsIn(v).forEach(r => needRefs.add(r)); stats.settings.added++;
    }
  }

  // Copy only the media files that merged rows use and that aren't here already.
  const dir = await Media.dir();
  for (const ref of needRefs) {
    const bytes = media.get(ref); if (!bytes) continue;
    try { await dir.getFileHandle(ref); continue; } catch {}
    const w = await (await dir.getFileHandle(ref, { create: true })).createWritable();
    await w.write(bytes); await w.close();
  }
  return stats;
}

// Tables in a backup that the merge doesn't know about (a newer app version, or a table that was
// added without updating MERGE_TABLES). Shown to the artist rather than silently dropped.
const mergeUnknown = (src) => Object.keys(src).filter(t => !(t in MERGE_TABLES));

function mergeCounts(src) {
  const n = {}; MERGE_SECTIONS.forEach(([k]) => n[k] = 0);
  for (const [t, cfg] of Object.entries(MERGE_TABLES)) if (cfg.section && t !== 'settings' && t !== 'booking_photos' && t !== 'portfolio_photos' && t !== 'stock_take_lines') n[cfg.section] += (src[t] || []).length;
  const set = Object.fromEntries((src.settings || []).map(r => [r.key, r.value]));
  try { n.reel = JSON.parse(set.reel_templates || '[]').length; } catch {}
  n.settings = Object.keys(set).filter(k => !MERGE_SETTING_SKIP.test(k) && set[k]).length;
  return n;
}

// `from` is a backup File, or another workspace on this device (merged straight from its storage).
async function openMerge(from) {
  let parsed, src;
  try {
    const bytes = from.id ? new Uint8Array(await (await buildBackup(from)).arrayBuffer()) : new Uint8Array(await from.arrayBuffer());
    parsed = parseBackup(bytes); src = await DB.peek(parsed.db.slice());
  }
  catch (err) { return toast('Could not read that backup: ' + err.message, 5000); }
  const n = mergeCounts(src), unknown = mergeUnknown(src);
  const o = document.createElement('div');
  o.id = 'merge-dlg';
  o.innerHTML = `<div class="card">
    <h2>Merge from backup</h2>
    <p class="muted" style="margin-top:0">Adds what's in <b>${esc(from.name)}</b> to this workspace. Nothing of yours is changed or removed, and anything you already have is skipped.</p>
    <div class="merge-list">${MERGE_SECTIONS.map(([k, l, d]) => `<label class="merge-row ${n[k] ? '' : 'empty'}">
      <input type="checkbox" data-sec="${k}" ${n[k] ? 'checked' : 'disabled'}>
      <span class="c-main"><b>${l}</b><span class="muted">${d}</span></span><span class="chip">${n[k]}</span></label>`).join('')}</div>
    <p class="muted" style="font-size:12px">Linked items come along when needed: e.g. merging bookings also adds the clients they belong to.</p>
    ${unknown.length ? `<p style="color:var(--red);font-size:13px">This backup also contains data this version can't merge (${esc(unknown.join(', '))}). Update InkForge, then merge again to include it.</p>` : ''}
    <div class="row" style="margin-top:12px"><button class="btn" id="mg-cancel">Cancel</button>
      <button class="btn primary" id="mg-go" style="flex:1">Merge</button></div></div>`;
  document.body.appendChild(o);
  $('#mg-cancel').onclick = () => o.remove();
  $('#mg-go').onclick = async () => {
    const picked = new Set([...o.querySelectorAll('[data-sec]:checked')].map(x => x.dataset.sec));
    if (!picked.size) return toast('Tick at least one section.');
    $('#mg-go').disabled = true; $('#mg-go').textContent = 'Merging…';
    try {
      const stats = await mergeBackup(src, parsed.media, picked);
      Settings.cache = {}; await Settings.load();
      o.querySelector('.card').innerHTML = `<h2>Merge complete</h2>
        <div class="merge-list">${MERGE_SECTIONS.filter(([k]) => stats[k].added || stats[k].skipped).map(([k, l]) =>
          `<div class="stat"><span>${l}</span><span>${stats[k].added} added · ${stats[k].skipped} already here</span></div>`).join('') || '<p class="muted">Nothing new to add.</p>'}</div>
        <button class="btn primary" id="mg-done" style="width:100%;margin-top:14px">Done</button>`;
      $('#mg-done').onclick = () => { o.remove(); render(); };
      Gcal.soon();
    } catch (err) { toast('Merge failed: ' + err.message, 6000); o.remove(); }
  };
}

async function exportBackup(w = WS.cur) {
  const bytes = await buildBackup(w);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const name = `${(w?.name || 'InkForge').replace(/[^\w-]+/g, '_')}-${stamp}.inkforge`;
  const file = new File([bytes], name, { type: 'application/octet-stream' });
  // Phones: share sheet (save to Files / Drive). Desktop: download.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'InkForge backup' }); }
    catch (e) { if (e.name === 'AbortError') return; throw e; }
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  if (w === WS.cur && booted) {
    await Settings.set('last_backup', new Date().toISOString());
    if (location.hash === '#settings') render();
  }
  toast(`"${w.name}" saved to a file.`);
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
const fmtDay = (s) => new Date(String(s).slice(0, 10) + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
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

/* Days off. Settings key days_off = { weekly: [weekday numbers, 0 = Sunday], until: 'YYYY-MM-DD' or '',
   dates: ['YYYY-MM-DD', ...] }. Weekly days repeat until `until` (or for good when empty); `dates`
   are single extra days. They are shaded in the calendar, skipped when a new booking picks a day,
   and flagged (never blocked) when a tattoo is booked on one. At least one weekday stays open. */
const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
function daysOff() {
  let o = {}; try { o = JSON.parse(Settings.get('days_off', '{}')); } catch {}
  return { weekly: Array.isArray(o.weekly) ? o.weekly : [], until: o.until || '', dates: Array.isArray(o.dates) ? o.dates : [] };
}
// True when the date (YYYY-MM-DD) is one of the artist's days off.
function isDayOff(k, o = daysOff()) {
  if (o.dates.includes(k)) return true;
  if (!o.weekly.length || (o.until && k > o.until)) return false;
  return o.weekly.includes(new Date(k + 'T00:00').getDay());
}
// The first day from `from` (Date) that is not a day off, as YYYY-MM-DD.
function nextOpenDay(from = new Date()) {
  const o = daysOff();
  for (let i = 0; i < 400; i++) { const k = ymd(addDays(from, i)); if (!isDayOff(k, o)) return k; }
  return ymd(from);
}
// New booking on the next working day (today if open), at the usual start time.
const newBookingNext = (clientId, from) => newBooking(nextOpenDay(from) + 'T' + Settings.get('day_start', '10:00'), clientId);

async function bookingsBetween(from, to) {
  return DB.all(`SELECT b.*, c.first_name, c.last_name, c.medical,
      (SELECT photo_ref FROM booking_photos p WHERE p.booking_id = b.id ORDER BY sort, id LIMIT 1) AS cover
    FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
    WHERE b.start_at >= ? AND b.start_at < ? ORDER BY b.start_at`, [ymd(from), ymd(to)]);
}
const bName = (b) => b.first_name != null ? fullName(b) : kindOf(b) !== 'tattoo' ? kindLabel(b) : 'No client';

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
    const today = ymd(new Date()), sel = ymd(d), off = daysOff();
    let html = '<div class="month"><div class="wk">' + ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(x => `<span>${x}</span>`).join('') + '</div><div class="mgrid">';
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i), k = ymd(day), list = byDay[k] || [];
      html += `<button class="mday ${day.getMonth() !== d.getMonth() ? 'out' : ''} ${k === today ? 'today' : ''} ${k === sel ? 'sel' : ''} ${isDayOff(k, off) ? 'off' : ''}" data-d="${k}">
        <span class="n">${day.getDate()}</span>
        <span class="pips">${list.slice(0, 3).map(() => '<i></i>').join('')}${list.length > 3 ? '<b>+</b>' : ''}</span></button>`;
    }
    html += '</div></div>';
    const dayList = byDay[sel] || [];
    html += `<div class="day-head">${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>`
      + (dayList.length ? '<div class="card list">' + dayList.map(agendaRow).join('') + '</div>'
        : `<div class="empty muted" style="padding:20px">${isDayOff(sel, off) ? 'Your day off.' : 'Free day.'} <a href="#" id="m-add" style="color:var(--teal)">Book it</a></div>`);
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
  const busy = Settings.get('gcal_busy', '1') === '1'
    ? await DB.all('SELECT start_at, end_at FROM gcal_busy WHERE start_at < ? AND end_at > ?', [ymd(addDays(days[days.length - 1], 1)), ymd(days[0])]) : [];
  const today = ymd(new Date()), off = daysOff();
  let html = `<div class="tl ${mode}"><div class="tl-head"><span></span>${days.map(x => `<button class="tl-day ${ymd(x) === today ? 'today' : ''} ${isDayOff(ymd(x), off) ? 'off' : ''}" data-d="${ymd(x)}">
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
    html += `<div class="tl-col ${isDayOff(k, off) ? 'off' : ''}" data-d="${k}" style="height:${(DAY_TO - DAY_FROM) * HOUR_PX}px">${isDayOff(k, off) ? '<span class="off-tag">Day off</span>' : ''}`;
    // Personal Google events: grey, details hidden, clipped to this day and the visible hours
    const dayStart = k + 'T00:00', dayEnd = ymd(addDays(day, 1)) + 'T00:00';
    for (const x of busy) {
      if (x.start_at >= dayEnd || x.end_at <= dayStart) continue;
      const s = Math.max(DAY_FROM * 60, x.start_at < dayStart ? 0 : minutesOf(x.start_at));
      const e = Math.min(DAY_TO * 60, x.end_at >= dayEnd ? 1440 : minutesOf(x.end_at));
      if (e <= s) continue;
      html += `<div class="ev busy" style="top:${(s - DAY_FROM * 60) / 60 * HOUR_PX}px;height:${(e - s) / 60 * HOUR_PX - 2}px;left:0;width:calc(100% - 3px)" data-tip="Busy in your Google Calendar"><b>Busy</b></div>`;
    }
    if (k === today) {
      const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
      if (m >= DAY_FROM * 60 && m < DAY_TO * 60) html += `<div class="now" style="top:${(m - DAY_FROM * 60) / 60 * HOUR_PX}px"></div>`;
    }
    list.forEach(b => {
      const top = (minutesOf(b.start_at) - DAY_FROM * 60) / 60 * HOUR_PX, h = Math.max(22, b.duration_min / 60 * HOUR_PX - 2);
      const w = 100 / lanes.length;
      // Too short for stacked lines (e.g. a 30-minute follow-up): put everything on one line instead.
      const short = h < 48;
      html += `<a class="ev k-${kindOf(b)} ${b.deposit_paid ? 'paid' : ''} ${short ? 'short' : ''}" href="#booking-edit/${b.id}" style="top:${top}px;height:${h}px;left:${b._lane * w}%;width:calc(${w}% - 3px)"
        title="${esc([bName(b), kindLabel(b), fmtTime(b.start_at) + ' · ' + fmtDur(b.duration_min), b.placement, b.description].filter(Boolean).join(' · '))}">
        <b>${esc(mode === 'week' ? (b.first_name || (kindOf(b) !== 'tattoo' ? kindLabel(b) : '—')) : bName(b))}</b>
        ${mode === 'day' ? `<span>${kindOf(b) !== 'tattoo' && b.first_name != null ? kindLabel(b) + ' · ' : ''}${fmtTime(b.start_at)} · ${fmtDur(b.duration_min)}${b.placement ? ' · ' + esc(b.placement) : ''}</span>
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
    <span class="c-main"><span class="c-n">${b.completed ? '<span class="done-tick" data-tip="Completed">✓</span>' : ''}${esc(bName(b))}${b.first_name != null ? kindChip(b) : ''}${b.medical ? ' <span class="dot" data-tip="Has medical notes"></span>' : ''}</span>
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

/* ---------- Google Calendar sync ----------
   InkForge owns a dedicated "InkForge" calendar in the user's Google account.
   Each booking = one event: title, start/end, and labelled note lines. Every other
   Google event property (location, guests, attachments, colours...) is ignored.
   Personal (primary) calendar is read only as free/busy times. */
const NOTE_FOOTER = '— Synced from InkForge';
const NOTE_LABELS = ['Type', 'Client', 'Phone', 'Tattoo', 'Details', 'Placement', 'Size', 'Quote', 'Deposit', 'Notes'];

function buildNotes(b, c) {
  const L = [];
  if (kindOf(b) !== 'tattoo') L.push('Type: ' + kindLabel(b));
  if (c) L.push('Client: ' + fullName(c));
  if (c?.phone) L.push('Phone: ' + c.phone);
  if (b.description) L.push((BOOKING_KINDS[kindOf(b)].ink ? 'Tattoo: ' : 'Details: ') + b.description);
  if (b.placement) L.push('Placement: ' + b.placement);
  if (b.size) L.push('Size: ' + b.size);
  if (b.quote != null) L.push('Quote: ' + money(b.quote));
  if (b.deposit != null) L.push('Deposit: ' + money(b.deposit) + (b.deposit_paid ? ' (paid)' : ' (unpaid)'));
  if (b.notes) L.push('Notes: ' + b.notes);
  L.push(NOTE_FOOTER);
  return L.join('\n');
}

// Reads labelled lines back. Only labels present in the text are returned; unlabelled lines go to notes.
function parseNotes(text) {
  text = String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '');
  const ta = document.createElement('textarea'); ta.innerHTML = text; text = ta.value;
  const out = {}, extra = [];
  let inNotes = false;
  const re = new RegExp(`^\\s*(${NOTE_LABELS.join('|')})\\s*:\\s*(.*)$`, 'i');
  const num = (s) => { const n = parseFloat(String(s).replace(/[^\d.,-]/g, '').replace(/,/g, '')); return isNaN(n) ? null : n; };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith(NOTE_FOOTER.slice(0, 1)) && line.includes('InkForge')) break;
    const m = line.match(re);
    if (m && !(inNotes && !NOTE_LABELS.slice(0, -1).some(l => l.toLowerCase() === m[1].toLowerCase()))) {
      const k = m[1].toLowerCase(), v = m[2].trim();
      inNotes = false;
      if (k === 'type') out.kind = Object.keys(BOOKING_KINDS).find(x => BOOKING_KINDS[x].label.toLowerCase() === v.toLowerCase()) || 'tattoo';
      else if (k === 'client') out.client = v;
      else if (k === 'tattoo' || k === 'details') out.description = v || null;
      else if (k === 'placement') out.placement = v || null;
      else if (k === 'size') out.size = v || null;
      else if (k === 'quote') out.quote = num(v);
      else if (k === 'deposit') { out.deposit = num(v); out.deposit_paid = /\bpaid\b/i.test(v) && !/unpaid/i.test(v) ? 1 : 0; }
      else if (k === 'notes') { inNotes = true; if (v) extra.push(v); }
    } else if (line.trim()) extra.push(line.replace(/\s+$/, ''));
  }
  if (extra.length || 'client' in out || 'description' in out) out.notes = extra.join('\n') || null;
  return out;
}

const localStamp = (iso) => { const d = new Date(iso); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sqlTime = (s) => new Date(s.replace(' ', 'T') + 'Z');

const Gcal = {
  SCOPES: ['https://www.googleapis.com/auth/calendar.app.created', 'https://www.googleapis.com/auth/calendar.freebusy'],
  token: null, exp: 0, running: false, state: 'off', msg: '', _t: null,
  enabled() { return Settings.get('gcal_on') === '1' && !!Settings.get('gcal_client_id'); },
  hasToken() { return !!this.token && Date.now() < this.exp - 60000; },

  async loadGis() {
    if (window.google?.accounts?.oauth2) return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = res; s.onerror = () => rej(new Error('Could not load Google sign-in. Check your connection.'));
      document.head.appendChild(s);
    });
  },
  async auth() {
    await this.loadGis();
    await new Promise((res, rej) => {
      google.accounts.oauth2.initTokenClient({
        client_id: Settings.get('gcal_client_id'), scope: this.SCOPES.join(' '),
        callback: (r) => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...this.SCOPES)) return rej(new Error('Please tick both calendar permissions when Google asks.'));
          this.token = r.access_token; this.exp = Date.now() + r.expires_in * 1000; res();
        },
        error_callback: (e) => rej(new Error(e.type === 'popup_closed' ? 'Google sign-in was closed.' : (e.message || 'Google sign-in failed.')))
      }).requestAccessToken({ prompt: '' });
    });
  },
  async api(path, opts = {}) {
    const r = await fetch('https://www.googleapis.com/calendar/v3' + path, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error?.message || 'Google error ' + r.status); e.status = r.status; throw e; }
    return j;
  },
  setState(state, msg = '') {
    this.state = state; this.msg = msg;
    const b = $('#gcal-btn');
    if (b) {
      b.className = 'btn icon-btn gsync ' + state;
      b.dataset.tip = state === 'syncing' ? 'Syncing with Google…' : state === 'error' ? 'Sync problem: ' + msg + ' Tap to retry.'
        : this.hasToken() ? 'Synced with Google. Tap to sync now.' : 'Tap to sign in to Google and sync.';
    }
    const s = $('#gcal-status'); if (s) renderGcalStatus();
  },

  async calId() {
    let id = Settings.get('gcal_cal_id');
    if (id) {
      try { await this.api('/calendars/' + encodeURIComponent(id)); return id; }
      catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
    }
    const c = await this.api('/calendars', { method: 'POST', body: {
      summary: 'InkForge', description: 'Tattoo bookings synced from InkForge.',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    await Settings.set('gcal_cal_id', c.id);
    await Settings.set('gcal_sync_token', '');
    await DB.run('UPDATE bookings SET gcal_id = NULL, gcal_updated = NULL, gcal_synced_at = NULL');
    await DB.run('DELETE FROM gcal_deletes');
    return c.id;
  },

  toEvent(b, c) {
    const start = new Date(b.start_at), end = new Date(start.getTime() + b.duration_min * 60000);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      summary: [kindOf(b) !== 'tattoo' && kindLabel(b), c ? fullName(c) : (b.description || (kindOf(b) === 'tattoo' ? 'Booking' : '')), b.placement].filter(Boolean).join(' · '),
      description: buildNotes(b, c),
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
      extendedProperties: { private: { inkforgeId: String(b.id) } }
    };
  },

  async push(C, b) {
    const c = b.client_id ? await DB.one('SELECT * FROM clients WHERE id = ?', [b.client_id]) : null;
    const body = this.toEvent(b, c);
    let ev = null;
    if (b.gcal_id) {
      try { ev = await this.api(`${C}/events/${encodeURIComponent(b.gcal_id)}`, { method: 'PATCH', body }); }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    if (!ev || ev.status === 'cancelled') ev = await this.api(`${C}/events`, { method: 'POST', body });
    await DB.run('UPDATE bookings SET gcal_id = ?, gcal_updated = ?, gcal_synced_at = ? WHERE id = ?', [ev.id, ev.updated, b.updated_at, b.id]);
  },

  async applyEvent(ev) {
    const local = await DB.one('SELECT * FROM bookings WHERE gcal_id = ?', [ev.id]);
    if (ev.status === 'cancelled') {
      if (local) {
        const refs = (await DB.all('SELECT photo_ref FROM booking_photos WHERE booking_id = ?', [local.id])).map(r => r.photo_ref);
        await DB.run('DELETE FROM bookings WHERE id = ?', [local.id]);
        for (const r of refs) await Media.release(r);
      }
      return;
    }
    if (!ev.start?.dateTime || ev.recurrence || ev.recurringEventId) return;   // all-day / repeating: ignored
    if (local && local.gcal_updated === ev.updated) return;                    // echo of our own write
    const start = localStamp(ev.start.dateTime);
    const dur = Math.max(15, Math.round((new Date(ev.end.dateTime) - new Date(ev.start.dateTime)) / 60000));
    const f = parseNotes(ev.description);
    const fields = ['kind', 'description', 'placement', 'size', 'quote', 'deposit', 'deposit_paid', 'notes'].filter(k => k in f);
    if (local) {
      const dirty = local.updated_at !== local.gcal_synced_at;
      if (dirty && sqlTime(local.updated_at) > new Date(ev.updated)) return;   // local edit is newer; push wins
      await DB.run(`UPDATE bookings SET start_at = ?, duration_min = ?, ${fields.map(k => k + ' = ?, ').join('')}
        gcal_updated = ?, updated_at = datetime('now'), gcal_synced_at = datetime('now') WHERE id = ?`,
        [start, dur, ...fields.map(k => f[k]), ev.updated, local.id]);
    } else {
      // Created directly in the InkForge Google calendar: import it, then let push tidy the notes.
      let clientId = null;
      if (f.client) clientId = (await DB.one(`SELECT id FROM clients WHERE lower(trim(first_name || ' ' || last_name)) = lower(trim(?)) LIMIT 1`, [f.client]))?.id ?? null;
      if (!('description' in f) && ev.summary) f.description = ev.summary;
      await DB.run(`INSERT INTO bookings (kind, client_id, start_at, duration_min, description, placement, size, quote, deposit, deposit_paid, notes, gcal_id, gcal_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [f.kind || 'tattoo', clientId, start, dur, f.description ?? null, f.placement ?? null, f.size ?? null, f.quote ?? null, f.deposit ?? null, f.deposit_paid ?? 0, f.notes ?? null, ev.id, ev.updated]);
    }
  },

  async pull(C) {
    let token = Settings.get('gcal_sync_token'), page = '', next = '';
    const items = [];
    for (;;) {
      const q = new URLSearchParams({ maxResults: '250', showDeleted: 'true' });
      if (token) q.set('syncToken', token);
      if (page) q.set('pageToken', page);
      let r;
      try { r = await this.api(`${C}/events?${q}`); }
      catch (e) {
        if (e.status === 410 && token) { token = ''; page = ''; items.length = 0; continue; }  // token expired: full resync
        throw e;
      }
      items.push(...(r.items || []));
      page = r.nextPageToken || '';
      if (!page) { next = r.nextSyncToken || ''; break; }
    }
    for (const ev of items) await this.applyEvent(ev);
    if (next) await Settings.set('gcal_sync_token', next);
  },

  async pullBusy() {
    if (Settings.get('gcal_busy', '1') !== '1') { await DB.run('DELETE FROM gcal_busy'); return; }
    const from = addDays(new Date(), -14), to = addDays(new Date(), 75);
    const r = await this.api('/freeBusy', { method: 'POST', body: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] } });
    const list = r.calendars?.primary?.busy || [];
    await DB.tx([{ sql: 'DELETE FROM gcal_busy' },
      ...list.map(x => ({ sql: 'INSERT INTO gcal_busy VALUES (?, ?)', params: [localStamp(x.start), localStamp(x.end)] }))]);
  },

  async sync({ interactive = false } = {}) {
    if (this.running || !this.enabled()) return;
    if (!this.hasToken()) { if (!interactive) return; await this.auth(); }
    this.running = true; this.setState('syncing');
    try {
      const cal = await this.calId(), C = '/calendars/' + encodeURIComponent(cal);
      for (const { gcal_id } of await DB.all('SELECT gcal_id FROM gcal_deletes')) {
        try { await this.api(`${C}/events/${encodeURIComponent(gcal_id)}`, { method: 'DELETE' }); }
        catch (e) { if (![404, 410].includes(e.status)) throw e; }
        await DB.run('DELETE FROM gcal_deletes WHERE gcal_id = ?', [gcal_id]);
      }
      await this.pull(C);
      const dirty = await DB.all('SELECT * FROM bookings WHERE gcal_id IS NULL OR gcal_synced_at IS NULL OR updated_at <> gcal_synced_at');
      for (const b of dirty) await this.push(C, b);
      await this.pullBusy();
      await Settings.set('gcal_last', new Date().toISOString());
      this.setState('ok');
    } catch (e) {
      if (e.status === 401) this.token = null;
      this.setState('error', e.message);
      throw e;
    } finally { this.running = false; }
  },
  // Background sync after local edits, only while signed in.
  soon() {
    clearTimeout(this._t);
    if (this.enabled() && this.hasToken()) this._t = setTimeout(() => this.sync().then(() => renderCal()).catch(e => toast('Google sync: ' + e.message, 5000)), 1200);
  },
  async disconnect() {
    if (this.token) { try { await this.loadGis(); google.accounts.oauth2.revoke(this.token, () => {}); } catch {} }
    this.token = null; await Settings.set('gcal_on', '0'); this.setState('off');
  }
};

function renderGcalStatus() {
  const el = $('#gcal-status'); if (!el) return;
  const last = Settings.get('gcal_last');
  const on = Gcal.enabled();
  el.innerHTML = `
    <div class="stat"><span>Status</span><span>${!on ? 'Off' : Gcal.state === 'syncing' ? 'Syncing…' : Gcal.state === 'error' ? `<span style="color:var(--red)">${esc(Gcal.msg)}</span>` : Gcal.hasToken() ? '<span style="color:var(--teal)">Connected</span>' : 'Signed out (tap Sync)'}</span></div>
    ${on && last ? `<div class="stat"><span>Last sync</span><span>${new Date(last).toLocaleString()}</span></div>` : ''}`;
  $('#g-connect').hidden = on; $('#g-sync').hidden = !on; $('#g-off').hidden = !on;
}

/* ---------- Portfolio helpers ---------- */
const PF = { filter: 'all', q: '', ctx: null };
const PF_KIND = { tattoo: 'Tattoo', art: 'Art', flash: 'Flash' };

async function renderPfGrid() {
  const el = $('#pf-grid'); if (!el) return;
  const q = PF.q.trim(), like = '%' + q + '%';
  const where = PF.filter === 'fav' ? 'p.favourite = 1' : PF.filter === 'all' ? '1' : 'p.kind = ?';
  const rows = await DB.all(`SELECT p.id, p.kind, p.title, p.price, p.claimed, p.favourite,
      (SELECT thumb_ref FROM portfolio_photos x WHERE x.item_id = p.id ORDER BY sort, id LIMIT 1) AS thumb,
      (SELECT count(*) FROM portfolio_photos x WHERE x.item_id = p.id) AS n
    FROM portfolio_items p LEFT JOIN clients c ON c.id = p.client_id
    WHERE ${where} AND (? = '' OR p.title LIKE ? OR p.tags LIKE ? OR p.placement LIKE ? OR p.description LIKE ?
      OR (c.first_name || ' ' || c.last_name) LIKE ?)
    ORDER BY coalesce(p.made_on, p.created_at) DESC, p.id DESC`,
    [...(['tattoo', 'art', 'flash'].includes(PF.filter) ? [PF.filter] : []), q, like, like, like, like, like]);
  if ($('#pf-grid') !== el) return;
  if (!rows.length) {
    el.innerHTML = q || PF.filter !== 'all' ? '<div class="empty muted">Nothing here.</div>'
      : `<div class="empty"><div class="empty-ico">${ICON.portfolio}</div><div style="font:24px var(--display)">Show off your work</div>
         <div class="muted">Tap + to add tattoos, art or flash.</div></div>`;
    return;
  }
  const urls = await Promise.all(rows.map(r => Media.url(r.thumb)));
  el.innerHTML = '<div class="pf-grid">' + rows.map((r, i) => `
    <a class="pf-tile ${r.claimed ? 'claimed' : ''}" href="#pf/${r.id}" aria-label="${esc(r.title || PF_KIND[r.kind])}">
      ${urls[i] ? `<img src="${urls[i]}" alt="" loading="lazy">` : ''}
      ${r.kind === 'flash' ? `<span class="pf-badge">${r.claimed ? 'Claimed' : r.price != null ? esc(money(r.price)) : 'Flash'}</span>` : ''}
      ${r.favourite ? '<span class="pf-star">★</span>' : ''}
      ${r.n > 1 ? `<span class="pf-n">${r.n}</span>` : ''}
    </a>`).join('') + '</div>' + `<div class="muted count">${rows.length} piece${rows.length === 1 ? '' : 's'}</div>`;
}

/* ---------- Quote calculator ----------
   Estimate the tattooing time, then price that time on the artist's own rate curve.
     minutes = size area x fill x minutes-per-cm2 (detail) x colour x pain (placement) x style
             + lettering minutes
     price   = rate curve(hours per session) x sessions        (breaks are never counted)
   The rate curve is a few anchor points (e.g. 1 h = R650, 4 h = R2500, 9 h = R4500) joined by
   straight lines; under the first point is the minimum. Long pieces are split into sessions of at
   most `sessionMax` hours. Every number lives in Calibrate (settings key quote_v2). */
const PAIN_COLOURS = ['#b9b9b9', '#e6d27a', '#f0b860', '#ef9a6a', '#e0605a'];
const PAIN_NAMES = ['Least', 'Low', 'Medium', 'High', 'Most'];
const QUOTE_V2 = {
  anchors: [[1, 650], [4, 2500], [9, 4500]],
  sessionMax: 9, round: 50, deposit: 30, fill: 70, range: 15,
  vatOn: false, vatRate: 15,                               // VAT is added on top when switched on
  touchupFee: 250, touchupNote: true,                      // touch-up price (0 = free), mentioned on quotes and receipts
  speed: [0.25, 0.45, 0.6, 0.9, 1.25],                     // minutes per cm2, detail levels 1-5
  colour: { black: 1, bg: 1.15, colour: 1.3 },
  pain: [1, 1.05, 1.12, 1.2, 1.3],                         // pain levels 1-5
  textMin: 3,                                              // minutes per letter at 2 cm letter height
  placements: [
    ['Head', 'Head & neck', 4], ['Face', 'Head & neck', 5], ['Neck', 'Head & neck', 4],
    ['Shoulder', 'Arms & hands', 2], ['Upper arm', 'Arms & hands', 1], ['Inner bicep', 'Arms & hands', 3],
    ['Elbow', 'Arms & hands', 5], ['Back of elbow', 'Arms & hands', 4], ['Forearm', 'Arms & hands', 2],
    ['Wrist', 'Arms & hands', 4], ['Hand', 'Arms & hands', 4], ['Fingers', 'Arms & hands', 5], ['Armpit', 'Arms & hands', 5],
    ['Collarbone', 'Front', 4], ['Chest', 'Front', 3], ['Breast', 'Front', 3], ['Sternum', 'Front', 5],
    ['Ribs', 'Front', 5], ['Stomach', 'Front', 4], ['Hip', 'Front', 4], ['Genitals', 'Front', 5],
    ['Upper back', 'Back', 2], ['Spine', 'Back', 5], ['Lower back', 'Back', 3], ['Bottom', 'Back', 2],
    ['Outer thigh', 'Legs & feet', 1], ['Thigh', 'Legs & feet', 2], ['Inner thigh', 'Legs & feet', 4],
    ['Back of thigh', 'Legs & feet', 2], ['Knee', 'Legs & feet', 5], ['Back of knee', 'Legs & feet', 5],
    ['Shin', 'Legs & feet', 4], ['Calf', 'Legs & feet', 2], ['Outer calf', 'Legs & feet', 1],
    ['Inner calf', 'Legs & feet', 3], ['Ankle', 'Legs & feet', 4], ['Foot', 'Legs & feet', 5]
  ],
  styles: [
    ['Realism', 1.3], ['Surrealism', 1.3], ['Portrait', 1.4], ['Sketch / Illustrative', 1], ['Abstract', 1],
    ['Anime and Manga', 1.1], ['Comic / Cartoon', 1], ['Cyberpunk / Futuristic', 1.15], ['Watercolor', 1.15],
    ['Trash Polka', 1.1], ['Biomechanical', 1.3], ['New School', 1.1], ['Old School', 0.95], ['Japanese', 1.15],
    ['Blackwork', 1], ['Geometric', 1.1], ['Fine Line', 0.9], ['Script / Text', 0.9], ['Polynesian / Tribal', 1],
    ['Dotwork / Pointillism', 1.25]
  ],
  fonts: [['Calligraphy', 1.2], ['Handwritten', 1], ['Gothic / Old English', 1.25], ['Foreign script', 1.2],
    ['Techno', 1], ['Typewriter', 1], ['Serif / Sans serif', 0.9], ['Brush / Stencil', 1.05], ['Western', 1.1], ['Fancy', 1.2]]
};
const DETAIL_LEVELS = [
  ['Linework', 'Clean outlines only, no shading.'],
  ['Simple shading', 'Outlines with light, soft shading.'],
  ['Bold blackwork', 'Solid black fills and strong contrast.'],
  ['Detailed', 'Smooth realism-style shading, texture and highlights.'],
  ['Full scene', 'Detailed subject plus a background or extra elements.']
];
const COLOUR_MODES = [['black', 'Black', 'Black ink only'], ['bg', 'Black & grey', 'Black with grey wash shading'], ['colour', 'Colour', 'Full colour']];

function qCfg() {
  let c = {}; try { c = JSON.parse(Settings.get('quote_v2', '{}')); } catch {}
  return { ...QUOTE_V2, ...c, colour: { ...QUOTE_V2.colour, ...c.colour } };
}
const qSave = (cfg) => Settings.set('quote_v2', JSON.stringify(cfg));

// The wizard's answers, kept while the app is open.
const QZ = { client: '', discType: 'pct', discVal: 0, step: 0, seen: 0, place: '', side: 'L', w: 10, h: 10, colour: '', detail: 3, style: '', text: '', font: '', fontName: '', letter: 2, hours: null };
const QZ_STEPS = ['Placement', 'Size', 'Colour', 'Detail', 'Style', 'Text', 'Quote'];

// Price for one session of h hours on the rate curve.
function qCurve(c, h) {
  const a = [...c.anchors].filter(x => x[0] > 0).sort((x, y) => x[0] - y[0]);
  if (!a.length) return 0;
  if (h <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) if (h <= a[i][0]) {
    const [h0, p0] = a[i - 1], [h1, p1] = a[i];
    return p0 + (p1 - p0) * (h - h0) / (h1 - h0);
  }
  const [hl, pl] = a[a.length - 1], [hp, pp] = a.length > 1 ? a[a.length - 2] : [0, 0];
  return pl + (pl - pp) / ((hl - hp) || 1) * (h - hl);
}
const qRound = (c, v) => c.round > 0 ? Math.round(v / c.round) * c.round : Math.round(v);

function qCalc(q = QZ) {
  const c = qCfg(), lines = [];
  const pl = c.placements.find(p => p[0] === q.place), pain = pl ? pl[2] : 3;
  const st = c.styles.find(s => s[0] === q.style), font = c.fonts.find(f => f[0] === q.font);
  const area = q.w * q.h, inked = area * c.fill / 100;
  let mins = inked * c.speed[q.detail - 1];
  lines.push([`${q.w} × ${q.h} cm, ${c.fill}% filled, ${DETAIL_LEVELS[q.detail - 1][0].toLowerCase()}`, mins]);
  const f = (label, k) => { if (k !== 1) { lines.push([`${label} ×${k}`, mins * (k - 1)]); mins *= k; } };
  if (q.colour) f(COLOUR_MODES.find(m => m[0] === q.colour)[1], c.colour[q.colour]);
  if (pl) f(`${q.place} (${PAIN_NAMES[pain - 1].toLowerCase()} pain)`, c.pain[pain - 1]);
  if (st) f(q.style, st[1]);
  const letters = q.text.replace(/\s/g, '').length;
  if (letters) {
    const t = letters * c.textMin * (q.letter / 2) * (font ? font[1] : 1);
    lines.push([`Lettering: ${letters} letters${q.font ? ', ' + q.font.toLowerCase() : ''}`, t]); mins += t;
  }
  const est = Math.max(0.5, Math.round(mins / 60 * 4) / 4);       // to the nearest quarter hour
  const hours = q.hours ?? est;
  const sessions = Math.max(1, Math.ceil(hours / c.sessionMax - 1e-9));
  const per = hours / sessions;
  // Tattoo price, then the discount off it, then VAT on what is left.
  const fin = (base) => {
    const disc = Math.min(base, Math.max(0, q.discType === 'amt' ? +q.discVal || 0 : base * (+q.discVal || 0) / 100));
    const net = base - disc, vat = c.vatOn ? Math.round(net * c.vatRate / 100) : 0;
    return { base, disc: Math.round(disc), net: Math.round(net), vat, total: Math.round(net + vat) };
  };
  const pr = fin(qRound(c, qCurve(c, per) * sessions));
  const lo = fin(qRound(c, qCurve(c, hours * (1 - c.range / 100) / sessions) * sessions)).total;
  const hi = fin(qRound(c, qCurve(c, hours * (1 + c.range / 100) / sessions) * sessions)).total;
  return { c, pain, est, hours, sessions, per, ...pr, lo, hi, deposit: qRound(c, pr.total * c.deposit / 100), lines, minutes: Math.round(hours * 60) };
}
const fmtH = (h) => { const m = Math.round(h * 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`; };

/* Detail previews: one rose drawn five ways, in the chosen ink. Placeholders until real drawings exist. */
function detailSvg(level, colour) {
  const col = colour === 'colour', grey = colour !== 'black';
  const ink = '#141414', petal = col ? '#c0392b' : grey ? '#6b6b6b' : '#141414', petalL = col ? '#ef8a80' : grey ? '#c9c9c9' : '#141414';
  const leaf = col ? '#2e7d32' : grey ? '#5a5a5a' : '#141414', leafL = col ? '#9ccc65' : grey ? '#bdbdbd' : '#141414';
  const id = 'r' + level + colour;
  const bud = 'M60 26 C80 26 88 44 84 58 C80 74 66 80 60 80 C52 80 38 74 36 58 C32 44 40 26 60 26Z';
  const inner = 'M60 38 q13 2 11 15 q-2 11 -13 10 q-9 -1 -8 -10 q1 -7 8 -6 M48 52 q2 14 12 16 q12 -2 14 -16 M42 62 q8 14 18 14 q12 0 18 -14';
  const stem = 'M60 80 q-5 16 1 34', leaves = 'M61 96 q16 -11 27 -4 q-12 13 -27 4Z M59 105 q-16 -11 -27 -4 q12 13 27 4Z';
  const defs = `<defs><radialGradient id="${id}p" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="${petalL}"/><stop offset="1" stop-color="${petal}"/></radialGradient>
    <linearGradient id="${id}l" x1="0" x2="1"><stop offset="0" stop-color="${leafL}"/><stop offset="1" stop-color="${leaf}"/></linearGradient>
    <linearGradient id="${id}s" x1="0" x2="1"><stop offset=".5" stop-color="${petalL}" stop-opacity=".9"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`;
  let art = '';
  if (level === 1) art = `<g fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"><path d="${bud}"/><path d="${inner}"/><path d="${stem}"/><path d="${leaves}"/></g>`;
  if (level === 2) art = `<path d="${bud}" fill="url(#${id}s)"/><path d="${leaves}" fill="${leafL}" opacity=".6"/>
    <g fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"><path d="${bud}"/><path d="${inner}"/><path d="${stem}"/><path d="${leaves}"/></g>`;
  if (level === 3) art = `<path d="${bud}" fill="${ink}"/><path d="${leaves}" fill="${ink}"/><path d="${stem}" stroke="${ink}" stroke-width="4" fill="none"/>
    <path d="${inner}" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
  if (level >= 4) art = `<path d="${bud}" fill="url(#${id}p)"/><path d="${leaves}" fill="url(#${id}l)"/>
    <path d="${stem}" stroke="${leaf}" stroke-width="3" fill="none"/>
    <path d="${inner}" stroke="${ink}" stroke-width="1.1" fill="none" stroke-linecap="round" opacity=".8"/>
    <g stroke="${ink}" stroke-width=".6" opacity=".35">${Array.from({ length: 9 }, (_, i) => `<path d="M${40 + i * 3} ${60 + i} l6 -6"/>`).join('')}</g>
    <path d="M52 36 q6 -4 12 -2" stroke="#fff" stroke-width="2" fill="none" opacity=".8" stroke-linecap="round"/>
    <path d="M70 98 q6 -3 10 -3" stroke="#fff" stroke-width="1.2" fill="none" opacity=".7"/>`;
  const bg = level === 5 ? `<circle cx="60" cy="56" r="46" fill="none" stroke="${ink}" stroke-width="1.2"/>
    <g stroke="${col ? '#e0a33a' : ink}" stroke-width="1" opacity=".55">${Array.from({ length: 16 }, (_, i) => { const a = i * Math.PI / 8;
      return `<path d="M${60 + Math.cos(a) * 49} ${56 + Math.sin(a) * 49} L${60 + Math.cos(a) * 57} ${56 + Math.sin(a) * 57}"/>`; }).join('')}</g>
    <circle cx="60" cy="56" r="46" fill="${col ? '#fdf1d6' : '#ececec'}" opacity=".6"/>
    <g fill="${ink}" opacity=".5">${[[24, 30], [96, 28], [20, 80], [100, 84], [30, 104], [92, 108]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.4"/>`).join('')}</g>` : '';
  return `<svg viewBox="0 0 120 120" aria-hidden="true">${defs}${bg}${art}</svg>`;
}

/* Wizard: one question per step, Back / Next, with a live estimate once there is enough to go on. */
function qzDraw() {
  const el = $('#qz'); if (!el) return;
  const c = qCfg(), s = QZ.step, cur = Settings.get('currency');
  const done = (i) => [QZ.place, true, QZ.colour, true, true, true, true][i];
  const steps = `<div class="qz-steps">${QZ_STEPS.map((n, i) => `<button data-step="${i}" class="${i === s ? 'on' : ''} ${i <= QZ.seen ? 'seen' : ''}" ${i <= QZ.seen ? '' : 'disabled'}>
      <i>${i < s && done(i) ? '✓' : i + 1}</i><span>${n}</span></button>`).join('')}</div>`;
  let body = '';
  if (s === 0) {
    const groups = [...new Set(c.placements.map(p => p[1]))];
    body = `<h2>Where is the tattoo?</h2>
      <div class="qz-pin"><button class="qz-chart" id="qz-chart" data-tip="Tap to enlarge"><img src="img/pain-chart.png" alt="Body pain chart: grey least pain, red most pain"></button></div>
      <div class="seg" id="qz-side" style="margin:10px 0">${[['L', 'Left'], ['C', 'Centre'], ['R', 'Right']].map(([k, l]) =>
        `<button data-side="${k}" class="${QZ.side === k ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}</div>
      ${groups.map(g => `<div class="lbl">${esc(g)}</div><div class="qz-chips">${c.placements.filter(p => p[1] === g).map(([n, , pn]) =>
        `<button data-place="${esc(n)}" class="chip qz-chip ${QZ.place === n ? 'on' : ''}"><b style="background:${PAIN_COLOURS[pn - 1]}" title="${PAIN_NAMES[pn - 1]} pain"></b>${esc(n)}</button>`).join('')}</div>`).join('')}
      <div class="qz-legend">${PAIN_COLOURS.map((col, i) => `<span><b style="background:${col}"></b>${PAIN_NAMES[i]}</span>`).join('')}</div>`;
  } else if (s === 1) {
    const presets = [['Small', 5, 5], ['Palm', 10, 10], ['Forearm', 12, 22], ['Half sleeve', 25, 35], ['Back piece', 40, 55], ['Full sleeve', 30, 65]];
    const sc = 120 / Math.max(QZ.w, QZ.h, 20);
    body = `<h2>How big?</h2><p class="muted" style="margin-top:0">The box the design fits in. Calibrate sets how much of that box is actually inked.</p>
      <div class="qz-chips" style="margin-bottom:12px">${presets.map(([n, w, h]) => `<button class="chip qz-chip ${QZ.w === w && QZ.h === h ? 'on' : ''}" data-preset="${w}x${h}">${n}</button>`).join('')}</div>
      <div class="qz-pin"><div class="qz-size"><div class="qz-box" style="width:${QZ.w * sc}px;height:${QZ.h * sc}px"><span>${QZ.w} × ${QZ.h} cm</span></div></div></div>
      ${reelSlider('data-qz', 'w', 'Width', 1, 70, 0.5, QZ.w, QZ.w + ' cm')}
      ${reelSlider('data-qz', 'h', 'Height', 1, 70, 0.5, QZ.h, QZ.h + ' cm')}`;
  } else if (s === 2) {
    body = `<h2>Colour</h2><div class="qz-cards">${COLOUR_MODES.map(([k, l, d]) => `<button class="qz-card ${QZ.colour === k ? 'on' : ''}" data-colour="${k}">
      <span class="qz-sw sw-${k}"></span><b>${l}</b><span class="muted">${d}</span></button>`).join('')}</div>`;
  } else if (s === 3) {
    body = `<h2>How detailed?</h2>
      <div class="qz-pin"><div class="qz-detail">${detailSvg(QZ.detail, QZ.colour || 'black')}</div>
      <div class="qz-dname"><b>${DETAIL_LEVELS[QZ.detail - 1][0]}</b><span class="muted">${DETAIL_LEVELS[QZ.detail - 1][1]}</span></div></div>
      <input type="range" min="1" max="5" step="1" value="${QZ.detail}" data-qz="detail" class="qz-range" aria-label="Detail level">
      <div class="qz-thumbs">${DETAIL_LEVELS.map((d, i) => `<button data-detail="${i + 1}" class="${QZ.detail === i + 1 ? 'on' : ''}" aria-label="${d[0]}">${detailSvg(i + 1, QZ.colour || 'black')}</button>`).join('')}</div>`;
  } else if (s === 4) {
    body = `<h2>Style</h2><p class="muted" style="margin-top:0">Not sure? Pick the closest, or skip.</p>
      <div class="qz-chips">${c.styles.map(([n]) => `<button class="chip qz-chip ${QZ.style === n ? 'on' : ''}" data-style="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
  } else if (s === 5) {
    body = `<h2>Any lettering?</h2><p class="muted" style="margin-top:0">Optional. Skip if there's no text.</p>
      <label class="field"><span>Text</span><input class="in" data-qzt="text" value="${esc(QZ.text)}" placeholder="e.g. Family first"></label>
      ${QZ.text ? `<div class="lbl">Font style</div><div class="qz-chips">${c.fonts.map(([n]) => `<button class="chip qz-chip ${QZ.font === n ? 'on' : ''}" data-font="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      <label class="field" style="margin-top:12px"><span>Font name ${help('Browse fonts on dafont.com, then type the name or paste the link here.')}</span>
        <input class="in" data-qzt="fontName" value="${esc(QZ.fontName)}" placeholder="Font name or link"></label>
      <a class="btn small" href="https://www.dafont.com/" target="_blank" rel="noopener" style="margin-bottom:12px">Browse fonts on dafont.com ↗</a>
      ${reelSlider('data-qz', 'letter', 'Letter height', 0.5, 10, 0.5, QZ.letter, QZ.letter + ' cm')}
      <p class="muted" style="font-size:12px">Double-check the spelling with the client.</p>` : ''}`;
  } else {
    const r = qCalc();
    body = `<div class="qz-result" id="qz-price">${qzPriceHTML(r)}</div>
      <details class="qz-sec" open><summary>Adjust</summary>
        ${reelSlider('data-qz', 'hours', `Time ${help('Your call overrides the estimate. The price follows your rate curve.')}`, 0.5, Math.max(20, Math.ceil(r.est * 2)), 0.25, r.hours, fmtH(r.hours) + (QZ.hours != null ? ' (yours)' : ''))}
        ${QZ.hours != null ? '<button class="link" id="qz-reset" style="margin:-4px 0 10px">Use the estimate again</button>' : ''}
        <div class="lbl">Discount</div>
        <div class="qz-disc">
          <div class="seg" id="qz-dt">${[['pct', '%'], ['amt', cur || 'Amount']].map(([k, l]) => `<button data-dt="${k}" class="${QZ.discType === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
          <input class="in" type="number" inputmode="decimal" min="0" step="any" data-qzd value="${QZ.discVal || ''}" placeholder="0">
        </div>
        ${QZ.discType === 'pct' ? `<div class="qz-chips" style="margin-top:8px">${[5, 10, 15, 20].map(v => `<button class="chip qz-chip ${+QZ.discVal === v ? 'on' : ''}" data-dq="${v}">${v}%</button>`).join('')}</div>` : ''}
        <label class="toggle" style="display:inline-flex;margin-top:6px" data-tip="Adds VAT on top of the price after any discount. Set the rate in Calibrate.">
          <input type="checkbox" id="qz-vat" ${r.c.vatOn ? 'checked' : ''}><span>Add VAT (${r.c.vatRate}%)</span></label>
      </details>
      <details class="qz-sec qz-why"><summary>How it was worked out</summary>
        ${r.lines.map(([l, m]) => `<div class="stat"><span>${esc(l)}</span><span>${m >= 0 ? '+' : '−'}${Math.round(Math.abs(m))} min</span></div>`).join('')}
        <div class="stat"><span><b>Estimated time</b></span><span><b>${fmtH(r.est)}</b></span></div>
        ${r.sessions > 1 ? `<p class="muted" style="font-size:12px;margin:6px 0 0">${r.sessions} sessions of about ${fmtH(r.per)}, each priced on your rates. Breaks are not included.</p>` : ''}
      </details>
      <div class="qz-out">
        <label class="toggle" style="display:inline-flex;margin-bottom:10px" data-tip="Attach a sketch, concept or reference with notes. It prints as its own page and goes into the booking.">
          <input type="checkbox" id="qz-dz" ${QZ.withDesign ? 'checked' : ''}><span>Add design or concept</span></label>
        ${QZ.withDesign ? `<div class="qz-dz">
          <label class="qz-dzimg">${QZ.design ? `<img src="${QZ.design.url}" alt="Design">` : '<span>+<small>Add picture</small></span>'}
            <input type="file" accept="image/*" hidden id="qz-dzfile"></label>
          <div class="qz-dzside">
            ${QZ.design ? '<div class="row" style="gap:6px;margin-bottom:8px"><label class="btn small">Replace<input type="file" accept="image/*" hidden id="qz-dzfile2"></label><button class="btn small danger" id="qz-dzrm">Remove</button></div>' : ''}
            <label class="field" style="margin:0"><span>Notes for the client</span>
              <textarea class="in" rows="4" data-qzt="designNote" placeholder="e.g. Rough concept; linework will be refined, roses can be swapped for peonies">${esc(QZ.designNote || '')}</textarea></label>
          </div></div>` : ''}
        <label class="field"><span>Client name <span class="muted">(optional, shown on the quote sheet)</span></span>
          <input class="in" data-qzt="client" value="${esc(QZ.client || '')}" autocomplete="off"></label>
        <div class="qz-acts">
          <button class="btn" id="qz-print" data-tip="An invoice-style quote sheet. Choose Save as PDF to keep a copy.">Print</button>
          <button class="btn" id="qz-img" data-tip="The same quote sheet as a picture, for clients who prefer an image">Save image</button>
          <button class="btn" id="qz-share">Send text</button>
        </div>
        <label class="toggle" style="display:inline-flex;margin-top:8px" data-tip="Adds a page with your open days (${AV.months} month${AV.months > 1 ? 's' : ''} ahead)">
          <input type="checkbox" id="qz-av" ${QZ.withAvail ? 'checked' : ''}><span>Include open appointments</span></label>
        ${QZ.withAvail ? '<div class="qz-avp" id="qz-avp"></div>' : ''}
        <button class="btn primary" id="qz-book" style="width:100%;margin-top:8px">Book with this quote</button>
      </div>
      <div class="row" style="margin-top:12px"><button class="btn small" id="qz-new">Start over</button>
        <a class="btn small" href="#quote-cal" style="margin-left:auto">Calibrate</a></div>`;
  }
  const r = s >= 1 && s < 6 && QZ.place ? qCalc() : null;
  el.innerHTML = `${steps}<div class="card qz-card-main">${body}</div>
    ${s < 6 ? `<div class="form-foot qz-foot">
      ${r ? `<div class="qz-live"><span>≈ <b>${money(r.total)}</b> · ${fmtH(r.hours)}</span><span class="muted">so far</span></div>` : ''}
      <div class="row">
      <button class="btn" id="qz-back" ${s ? '' : 'disabled'}>Back</button>
      ${s === 4 || s === 5 ? `<button class="btn" id="qz-skip">Skip</button>` : ''}
      <button class="btn primary" id="qz-next" style="flex:1" ${(s === 0 && !QZ.place) || (s === 2 && !QZ.colour) ? 'disabled' : ''}>${s === 5 ? 'See quote' : 'Next'}</button></div></div>`
      : ''}
    ${s === 0 ? '<a class="btn small" href="#quote-cal" style="margin-top:10px">Calibrate rates, pain and speeds</a>' : ''}`;
  qzBind(el);
  if (QZ.withAvail && s === 6) qzAvPanel();
}

function qzPriceHTML(r) {
  const adj = r.disc || r.vat;
  return `<div class="muted qz-k">${adj ? 'Total' : 'Estimate'}</div>
    <div class="qz-price">${money(r.total)}</div>
    <div class="muted">Range ${money(r.lo)} – ${money(r.hi)}</div>
    ${adj ? `<div class="qz-lines">
      <div><span>Tattoo</span><span>${money(r.base)}</span></div>
      ${r.disc ? `<div><span>Discount${QZ.discType === 'pct' ? ` ${+QZ.discVal}%` : ''}</span><span>−${money(r.disc)}</span></div>` : ''}
      ${r.vat ? `<div><span>VAT ${r.c.vatRate}%</span><span>+${money(r.vat)}</span></div>` : ''}</div>` : ''}
    <div class="qz-facts"><span><b>${fmtH(r.hours)}</b>tattoo time</span><span><b>${r.sessions}</b>session${r.sessions > 1 ? 's' : ''}</span><span><b>${money(r.deposit)}</b>deposit</span></div>`;
}

// #main is the scrolling area (the window itself does not scroll), so each step starts at its top.
function qzGo(n) { QZ.step = Math.max(0, Math.min(6, n)); QZ.seen = Math.max(QZ.seen, QZ.step); qzDraw(); $('#main').scrollTo(0, 0); }

function qzBind(el) {
  const next = $('#qz-next'), back = $('#qz-back'), skip = $('#qz-skip');
  if (next) next.onclick = () => qzGo(QZ.step + 1);
  if (back) back.onclick = () => qzGo(QZ.step - 1);
  if (skip) skip.onclick = () => { if (QZ.step === 4) QZ.style = ''; if (QZ.step === 5) Object.assign(QZ, { text: '', font: '', fontName: '' }); qzGo(QZ.step + 1); };
  el.onclick = (e) => {
    const t = e.target, d = (k) => t.closest(`[data-${k}]`)?.dataset[k];
    if (d('step') != null && !t.closest('[data-step]').disabled) return qzGo(+d('step'));
    if (d('place') != null) { QZ.place = d('place'); return qzDraw(); }
    if (d('side')) { QZ.side = d('side'); return qzDraw(); }
    if (d('preset')) { const [w, h] = d('preset').split('x').map(Number); Object.assign(QZ, { w, h, hours: null }); return qzDraw(); }
    if (d('colour')) { QZ.colour = d('colour'); QZ.hours = null; return qzDraw(); }
    if (d('detail')) { QZ.detail = +d('detail'); QZ.hours = null; return qzDraw(); }
    if (d('style') != null) { QZ.style = QZ.style === d('style') ? '' : d('style'); QZ.hours = null; return qzDraw(); }
    if (d('font') != null) { QZ.font = QZ.font === d('font') ? '' : d('font'); QZ.hours = null; return qzDraw(); }
    if (t.closest('#qz-chart')) return viewImage('img/pain-chart.png');
    if (t.closest('#qz-reset')) { QZ.hours = null; return qzDraw(); }
    if (t.closest('#qz-dzrm')) { URL.revokeObjectURL(QZ.design.url); QZ.design = null; return qzDraw(); }
    if (d('dt')) { QZ.discType = d('dt'); QZ.discVal = 0; return qzDraw(); }
    const avk = t.closest('[data-avk] button');
    if (avk) { qzAvOpts(); const k = avk.parentElement.dataset.avk; QZ.av[k] = k === 'months' ? +avk.dataset.v : avk.dataset.v; return qzAvPanel(); }
    if (d('avd')) { qzAvOpts(); const k = d('avd'), h = QZ.av.hidden; h.includes(k) ? h.splice(h.indexOf(k), 1) : h.push(k); return qzAvPanel(); }
    if (t.closest('#qz-avclear')) { QZ.av.hidden = []; return qzAvPanel(); }
    if (d('dq')) { QZ.discVal = +QZ.discVal === +d('dq') ? 0 : +d('dq'); return qzDraw(); }
    if (t.closest('#qz-new')) { if (QZ.design) URL.revokeObjectURL(QZ.design.url);
      Object.assign(QZ, { design: null, designNote: '', withDesign: false, av: null, client: '', discType: 'pct', discVal: 0, step: 0, seen: 0, place: '', side: 'L', w: 10, h: 10, colour: '', detail: 3, style: '', text: '', font: '', fontName: '', letter: 2, hours: null }); return qzDraw(); }
    if (t.closest('#qz-book')) {
      const r = qCalc();
      Cal.prefillQuote = { quote: r.total, deposit: r.deposit, size: `${QZ.w} x ${QZ.h} cm`, duration: Math.min(600, Math.ceil(r.per * 2) * 30),
        placement: qzPlacement(), description: qzSummary(),
        design: QZ.design ? QZ.design.blob : null, notes: QZ.design && QZ.designNote ? 'Design notes: ' + QZ.designNote : null };
      return newBookingNext();
    }
    if (t.closest('#qz-share')) return qzShare();
    if (t.closest('#qz-print')) return qzPrint();
    if (t.closest('#qz-img')) return qzSaveImage();
  };
  // Sliders: update the value label at once, redraw the preview parts when the finger lifts.
  el.oninput = (e) => {
    const k = e.target.dataset.qz, tk = e.target.dataset.qzt;
    if (e.target.hasAttribute('data-qzd')) { QZ.discVal = +e.target.value || 0; $('#qz-price').innerHTML = qzPriceHTML(qCalc()); return; }
    if (e.target.dataset.avn) { e.target.closest('.slider').querySelector('b').textContent = fmtH(+e.target.value); return; }
    if (tk) { QZ[tk] = e.target.value; if (tk === 'text') QZ.hours = null; return; }
    if (!k) return;
    QZ[k] = +e.target.value; if (k !== 'hours') QZ.hours = null;
    const b = e.target.closest('.slider')?.querySelector('b');
    if (b) b.textContent = k === 'hours' ? fmtH(QZ.hours) + ' (yours)' : QZ[k] + ' cm';
    if (k === 'w' || k === 'h') { const sc = 120 / Math.max(QZ.w, QZ.h, 20), box = $('.qz-box');
      box.style.width = QZ.w * sc + 'px'; box.style.height = QZ.h * sc + 'px'; box.firstElementChild.textContent = `${QZ.w} × ${QZ.h} cm`; }
    if (k === 'detail') {
      $('.qz-detail').innerHTML = detailSvg(QZ.detail, QZ.colour || 'black');
      $('.qz-dname').innerHTML = `<b>${DETAIL_LEVELS[QZ.detail - 1][0]}</b><span class="muted">${DETAIL_LEVELS[QZ.detail - 1][1]}</span>`;
      el.querySelectorAll('.qz-thumbs button').forEach((x, i) => x.classList.toggle('on', i + 1 === QZ.detail));
    }
    const live = $('.qz-live b'); if (live) live.textContent = money(qCalc().total);
    const pc = $('#qz-price'); if (pc && k === 'hours') pc.innerHTML = qzPriceHTML(qCalc());
  };
  el.onchange = async (e) => {
    if (e.target.id === 'qz-av') { QZ.withAvail = e.target.checked; return qzDraw(); }
    if (e.target.id === 'qz-dz') { QZ.withDesign = e.target.checked; return qzDraw(); }
    if (e.target.id === 'qz-dzfile' || e.target.id === 'qz-dzfile2') {
      const f = e.target.files[0]; if (!f) return;
      try {
        // Kept in memory with the quote, at most 1600 px, on white so transparent sketches stay readable.
        const bmp = await createImageBitmap(f), sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
        if (QZ.design) URL.revokeObjectURL(QZ.design.url);
        QZ.design = { blob, url: URL.createObjectURL(blob) };
      } catch { toast('Could not read that image.'); }
      return qzDraw();
    }
    if (e.target.id === 'qz-avfull') { qzAvOpts(); QZ.av.fullOnly = e.target.checked; return qzAvPanel(); }
    if (e.target.dataset.avn) { qzAvOpts(); QZ.av.need = Math.round(+e.target.value * 60); return qzAvPanel(); }
    if (e.target.id === 'qz-vat') { const c = qCfg(); c.vatOn = e.target.checked; await qSave(c); return qzDraw(); }
    if (e.target.dataset.qz === 'hours' || e.target.dataset.qzt === 'text' || e.target.hasAttribute('data-qzd')) qzDraw();
  };
}

const qzPlacement = () => QZ.place ? `${QZ.side === 'L' ? 'Left ' : QZ.side === 'R' ? 'Right ' : ''}${QZ.place.toLowerCase()}`.replace(/^./, m => m.toUpperCase()) : '';
const qzSummary = () => [QZ.style, COLOUR_MODES.find(m => m[0] === QZ.colour)?.[1].toLowerCase(), DETAIL_LEVELS[QZ.detail - 1][0].toLowerCase(),
  QZ.text && `text "${QZ.text}"${QZ.fontName ? ' in ' + QZ.fontName : ''}`].filter(Boolean).join(', ');

/* Client quote sheet: an invoice-style A4 page (1240 x 1754, 150 dpi) drawn on a canvas, so Print and
   Save image are exactly the same. Shows what was asked for, the time and the price, not the maths. */
async function qzSheet() {
  const r = qCalc(), c = r.c, W = 1240, H = 1754, M = 90;
  await Promise.all([document.fonts.load("64px 'Pirata One'"), document.fonts.load('600 28px Inter'), document.fonts.load('400 28px Inter')]).catch(() => {});
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  const teal = '#14857c', ink = '#1a1a1a', soft = '#6b6b6b', line = '#e3ddd0';
  const font = (px, w = 400, disp = false) => disp ? `${px}px 'Pirata One', serif` : `${w} ${px}px Inter, system-ui, sans-serif`;
  const text = (s, tx, ty, f, col = ink, align = 'left') => { x.font = f; x.fillStyle = col; x.textAlign = align; x.textBaseline = 'alphabetic'; x.fillText(s, tx, ty); };
  const wrapLines = (s, f, maxW) => { x.font = f; const out = []; let cur = '';
    for (const w of String(s).split(/\s+/)) { const t = cur ? cur + ' ' + w : w; if (x.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t; }
    if (cur) out.push(cur); return out; };
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);

  // Header: logo and studio left, contact details right
  const studio = Settings.get('studio_name') || Settings.get('artist_name') || 'Tattoo studio';
  const artist = Settings.get('artist_name');
  let hx = M;
  const logoUrl = await Media.url(Settings.get('studio_logo_ref'));
  if (logoUrl) {
    const img = new Image(); img.src = logoUrl; await img.decode().catch(() => {});
    if (img.naturalWidth) { const sc = Math.min(220 / img.naturalWidth, 140 / img.naturalHeight); x.drawImage(img, M, 70, img.naturalWidth * sc, img.naturalHeight * sc); hx = M + img.naturalWidth * sc + 30; }
  }
  text(studio, hx, 140, font(60, 400, true));
  if (artist && artist !== studio) text(artist, hx, 185, font(26, 500), soft);
  const contact = [Settings.get('artist_phone'), Settings.get('artist_instagram'), Settings.get('artist_facebook'), Settings.get('artist_tiktok')].filter(Boolean);
  contact.slice(0, 4).forEach((s, i) => text(s.replace(/^https?:\/\/(www\.)?/, ''), W - M, 100 + i * 34, font(22), soft, 'right'));
  x.fillStyle = teal; x.fillRect(M, 240, W - 2 * M, 6);

  // Title and reference block
  text('Tattoo quote', M, 360, font(96, 400, true));
  const now = new Date(), valid = new Date(now.getTime() + 30 * 864e5);
  const ref = 'Q' + now.toISOString().slice(2, 10).replace(/-/g, '') + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  const dfmt = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  [['Quote no.', ref], ['Date', dfmt(now)], ['Valid until', dfmt(valid)], ['Client', QZ.client || '—']].forEach(([k, v], i) => {
    text(k, W - M - 440, 300 + i * 38, font(22, 600), soft); text(v, W - M, 300 + i * 38, font(24, 500), ink, 'right');
  });

  // Details table
  let y = 450;
  text('YOUR TATTOO', M, y, font(22, 700), teal); y += 18;
  const pl = c.placements.find(p => p[0] === QZ.place);
  const rows = [
    ['Placement', qzPlacement() + (pl ? `  (${PAIN_NAMES[pl[2] - 1].toLowerCase()} pain area)` : '')],
    ['Size', `${QZ.w} × ${QZ.h} cm`],
    ['Colour', COLOUR_MODES.find(m => m[0] === QZ.colour)?.[1] || '—'],
    ['Detail', `${DETAIL_LEVELS[QZ.detail - 1][0]}: ${DETAIL_LEVELS[QZ.detail - 1][1].replace(/\.$/, '')}`],
    ['Style', QZ.style || '—']
  ];
  if (QZ.text) rows.push(['Lettering', `"${QZ.text}"${QZ.font ? ', ' + QZ.font : ''}${QZ.fontName ? ' (' + QZ.fontName + ')' : ''}, ${QZ.letter} cm letters`]);
  for (const [i, [k, v]] of rows.entries()) {
    const lines = wrapLines(v, font(28), W - 2 * M - 300), h = 22 + lines.length * 38;
    if (i % 2 === 0) { x.fillStyle = '#f7f4ee'; x.fillRect(M, y, W - 2 * M, h); }
    text(k, M + 24, y + 42, font(26, 600), soft);
    lines.forEach((ln, j) => text(ln, M + 300, y + 42 + j * 38, font(28)));
    y += h;
  }
  x.fillStyle = line; x.fillRect(M, y, W - 2 * M, 2);

  // Summary: time, sessions, price, deposit
  y += 44;
  const boxH = 270;
  x.fillStyle = '#eef8f6'; x.strokeStyle = teal; x.lineWidth = 3;
  x.beginPath(); x.roundRect(M, y, W - 2 * M, boxH, 24); x.fill(); x.stroke();
  const col = (W - 2 * M) / 3;
  [['Tattoo time', fmtH(r.hours)], ['Sessions', String(r.sessions)], ['Deposit to book', money(r.deposit)]].forEach(([k, v], i) => {
    text(k.toUpperCase(), M + col * i + col / 2, y + 60, font(20, 700), soft, 'center');
    text(v, M + col * i + col / 2, y + 110, font(40, 600), ink, 'center');
  });
  x.fillStyle = '#cfe7e3'; x.fillRect(M + 40, y + 140, W - 2 * M - 80, 2);
  // With a discount or VAT, list how the total is made up on the left; the total stays large on the right.
  const adj = [['Tattoo', money(r.base)], r.disc && [`Discount${QZ.discType === 'pct' ? ' ' + (+QZ.discVal) + '%' : ''}`, '-' + money(r.disc)],
    r.vat && [`VAT ${c.vatRate}%`, '+' + money(r.vat)]].filter(Boolean);
  if (adj.length > 1) {
    adj.forEach(([k, v], i) => { text(k, M + 40, y + 186 + i * 32, font(22, 500), soft); text(v, M + 360, y + 186 + i * 32, font(22, 600), ink, 'right'); });
    text('TOTAL', W - M - 40, y + 172, font(18, 700), soft, 'right');
  } else text('ESTIMATE', M + 40, y + 215, font(26, 700), soft);
  text(money(r.total), W - M - 40, y + (adj.length > 1 ? 252 : 238), font(adj.length > 1 ? 84 : 96, 400, true), teal, 'right');
  y += boxH + 56;

  // The basics of the calculation, then the terms
  const rates = [...c.anchors].sort((a, b) => a[0] - b[0]).map(([h, p]) => `${h} h ${money(p)}`).join('  ·  ');
  const how = [`Priced on tattooing time at our rates: ${rates}.`,
    r.sessions > 1 ? `Split into ${r.sessions} sessions of about ${fmtH(r.per)} each, each priced at these rates.` : '',
    `Expected range ${money(r.lo)} – ${money(r.hi)}, depending on how the session goes.`].filter(Boolean);
  text('HOW THIS IS PRICED', M, y, font(22, 700), teal); y += 44;
  for (const s of how) for (const ln of wrapLines(s, font(26), W - 2 * M)) { text(ln, M, y, font(26), ink); y += 38; }
  y += 24;
  text('PLEASE NOTE', M, y, font(22, 700), teal); y += 44;
  for (const s of ['Breaks are not included in the time or the quote.', 'The final price may change if the design, size or placement changes.',
    `The deposit secures your booking and comes off the final price.`, 'This quote is valid for 30 days.',
    c.vatOn ? `Prices include VAT at ${c.vatRate}%.` : '', touchupLine()].filter(Boolean))
    for (const ln of wrapLines('•  ' + s, font(26), W - 2 * M)) { text(ln, M, y, font(26), ink); y += 38; }

  // Footer sits under the notes, or at the foot of the page when there is room.
  const fy = Math.min(H - 60, Math.max(y + 60, H - 130));
  x.fillStyle = teal; x.fillRect(M, fy - 50, W - 2 * M, 3);
  text(`Thank you${QZ.client ? ', ' + QZ.client.split(' ')[0] : ''}!`, M, fy, font(44, 400, true));
  text(ref, W - M, fy - 4, font(20), soft, 'right');
  return { cv, ref };
}

async function qzPrint() {
  const { cv } = await qzSheet();
  const extra = [];
  if (qzHasDesign()) extra.push(await designPage());
  if (QZ.withAvail) extra.push((await qzAvailSheet()).cv);
  return printCanvas(cv, ...extra);
}
const qzHasDesign = () => QZ.withDesign && (QZ.design || (QZ.designNote || '').trim());

// The design or concept on its own A4 page: the picture as large as fits, the notes under it.
async function designPage() {
  const { W, H, M, teal, ink, soft } = DOC;
  const { cv, x, font, text, wrap, header } = await docCanvas();
  await header();
  text('Design concept', M, 360, font(88, 400, true));
  text([QZ.client, qzPlacement(), `${QZ.w} × ${QZ.h} cm`].filter(Boolean).join(' · '), M, 410, font(26, 500), soft);
  const notes = (QZ.designNote || '').trim() ? wrap(QZ.designNote.trim(), font(28), W - 2 * M).slice(0, 10) : [];
  const notesH = notes.length ? 80 + notes.length * 42 : 0;
  const top = 460, bottom = H - 170 - notesH;
  if (QZ.design) {
    const img = new Image(); img.src = QZ.design.url; await img.decode().catch(() => {});
    if (img.naturalWidth) {
      const sc = Math.min((W - 2 * M) / img.naturalWidth, (bottom - top) / img.naturalHeight), w = img.naturalWidth * sc, h = img.naturalHeight * sc;
      const ix = (W - w) / 2;
      x.fillStyle = '#f7f4ee'; x.fillRect(M, top, W - 2 * M, h + 0); x.drawImage(img, ix, top, w, h);
      x.strokeStyle = '#e3ddd0'; x.lineWidth = 2; x.strokeRect(ix, top, w, h);
    }
  }
  let y = bottom + 60;
  if (notes.length) { text('NOTES', M, y, font(22, 700), teal); y += 46; for (const ln of notes) { text(ln, M, y, font(28), ink); y += 42; } }
  x.fillStyle = teal; x.fillRect(M, H - 110, W - 2 * M, 3);
  text('Concept only: the final design is drawn for your placement before the session.', M, H - 66, font(22), soft);
  return cv;
}

/* Open appointments tuned to this quote: how far ahead, from when, whether only full days count,
   how long the session needs (starts at this quote's session length), and days hidden for this
   client. Kept on QZ.av for as long as the quote is open. */
function qzAvOpts() {
  const r = qCalc(), [ws, we] = workHours().map(toMin);
  QZ.av ||= { months: AV.months, from: AV.from, fullOnly: false, hidden: [], need: null };
  const needDefault = Math.min(we - ws, Math.ceil(r.per * 60 / 30) * 30);
  return { ...QZ.av, need: QZ.av.need ?? needDefault, needDefault, workMin: we - ws };
}
const qzAvailSheet = () => { const o = qzAvOpts(); return availSheet(o.months, o.from, o); };

async function qzAvPanel() {
  const el = $('#qz-avp'); if (!el) return;
  const o = qzAvOpts(), [start, end] = availRange(o.months, o.from), map = await availability(start, end, o);
  const months = [];
  for (let m = 0; m < o.months; m++) months.push(new Date(start.getFullYear(), start.getMonth() + m, 1));
  const count = (st) => Object.values(map).filter(v => v === st).length;
  el.innerHTML = `
    <div class="seg" data-avk="months" style="margin-bottom:8px">${[1, 2, 3].map(n => `<button data-v="${n}" class="${o.months === n ? 'on' : ''}" style="flex:1">${n} month${n > 1 ? 's' : ''}</button>`).join('')}</div>
    <div class="seg" data-avk="from" style="margin-bottom:10px">${[['now', 'This month'], ['next', 'Next month']].map(([k, l]) => `<button data-v="${k}" class="${o.from === k ? 'on' : ''}" style="flex:1">From ${l.toLowerCase()}</button>`).join('')}</div>
    ${reelSlider('data-avn', 'need', `Session needs ${help('Only days with at least this much free time inside your working hours are shown. Starts at this quote\'s session length.')}`, 0.5, o.workMin / 60, 0.5, o.need / 60, fmtH(o.need / 60))}
    <label class="toggle" style="display:inline-flex;margin-bottom:10px"><input type="checkbox" id="qz-avfull" ${o.fullOnly ? 'checked' : ''}><span>Only fully open days</span></label>
    <div class="lbl">Tap a day to hide it for this client ${o.hidden.length ? `<button class="link" id="qz-avclear" style="margin-left:8px">Show all again (${o.hidden.length})</button>` : ''}</div>
    <div class="qz-avmonths">${months.map(first => {
      const lead = (first.getDay() + 6) % 7, days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      let cells = '';
      for (let i = 0; i < lead; i++) cells += '<span></span>';
      for (let d = 1; d <= days; d++) {
        const k = ymd(new Date(first.getFullYear(), first.getMonth(), d)), st = map[k], hid = o.hidden.includes(k);
        cells += st === 'off' ? `<span class="avd off">${d}</span>`
          : `<button class="avd ${hid ? 'hid' : st}" data-avd="${k}" ${hid ? 'title="Hidden for this client"' : ''}>${d}</button>`;
      }
      return `<div class="avm"><b>${first.toLocaleDateString(undefined, { month: 'long' })}</b><div class="avgrid">${'MTWTFSS'.split('').map(l => `<i>${l}</i>`).join('')}${cells}</div></div>`;
    }).join('')}</div>
    <p class="muted" style="font-size:12px;margin:6px 0 0"><b>${count('open')}</b> open · <b>${count('part')}</b> with some time · hidden days and your Holds show as booked.</p>`;
}

async function qzSaveImage() {
  const { cv, ref } = await qzSheet();
  const tag = QZ.client ? '-' + QZ.client.replace(/[^\w-]+/g, '_') : '';
  const pages = [[cv, `Quote-${ref}${tag}.png`]];
  if (qzHasDesign()) pages.push([await designPage(), `Design-${ref}${tag}.png`]);
  if (QZ.withAvail) pages.push([(await qzAvailSheet()).cv, `Open-appointments-${ref}${tag}.png`]);
  const files = await Promise.all(pages.map(async ([c, n]) => new File([await new Promise(res => c.toBlob(res, 'image/png'))], n, { type: 'image/png' })));
  try {
    if (navigator.canShare?.({ files })) await navigator.share({ files, title: 'Tattoo quote' });
    else {
      for (const file of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
      toast(files.length > 1 ? `Quote saved (${files.length} pages).` : 'Quote image saved.');
    }
  } catch (e) { if (e.name !== 'AbortError') toast('Could not save: ' + e.message); }
}

async function qzShare() {
  const r = qCalc(), studio = Settings.get('studio_name') || Settings.get('artist_name');
  const text = `Tattoo quote${studio ? ' from ' + studio : ''}\n`
    + `${qzPlacement()} · ${QZ.w} x ${QZ.h} cm\n${qzSummary()}\n\n`
    + (r.disc ? `Tattoo: ${money(r.base)}\nDiscount: -${money(r.disc)}\n` : '')
    + (r.vat ? `VAT ${r.c.vatRate}%: ${money(r.vat)}\n` : '')
    + `${r.disc || r.vat ? 'Total' : 'Estimate'}: ${money(r.total)} (about ${fmtH(r.hours)}${r.sessions > 1 ? ` over ${r.sessions} sessions` : ''})\n`
    + `Deposit to book: ${money(r.deposit)}\n\nFinal price may change with design changes.`;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Quote copied.'); }
  } catch (e) { if (e.name !== 'AbortError') toast('Could not share.'); }
}

/* Calibrate: every number the calculator uses, grouped, with a live sample so changes make sense. */
function qcDraw() {
  const el = $('#qc'); if (!el) return;
  const c = qCfg(), cur = Settings.get('currency') || '';
  const num = (path, v, step = 'any', w = '') => `<input class="in qc-n" type="number" inputmode="decimal" step="${step}" value="${v}" data-p="${path}" ${w}>`;
  const sample = (h) => money(qRound(c, qCurve(c, h)));
  el.innerHTML = `
    <div class="card"><h2>Your rates ${help('Price for tattooing time, breaks not included. Between points the price runs in a straight line; under the first point is your minimum.')}</h2>
      <div class="qc-grid qc-anchors"><span class="lbl">Hours</span><span class="lbl">Price${cur ? ' (' + esc(cur) + ')' : ''}</span><span></span>
        ${c.anchors.map(([h, p], i) => `${num(`anchors.${i}.0`, h, '0.25')}${num(`anchors.${i}.1`, p, '10')}
          <button class="mini del" data-rm="${i}" aria-label="Remove" ${c.anchors.length > 1 ? '' : 'disabled'}>&times;</button>`).join('')}</div>
      <button class="btn small" id="qc-add" style="margin-top:8px">+ Add a point</button>
      <div class="qc-sample">${[1, 2, 3, 4, 6, 9].map(h => `<span><b>${sample(h)}</b>${h} h</span>`).join('')}</div>
      <div class="two" style="margin-top:12px">
        <label class="field"><span>Longest session ${help('Pieces longer than this are split into sessions, each priced on the rates above.')}</span><div class="unit-in">${num('sessionMax', c.sessionMax, '0.5')}<em>h</em></div></label>
        <label class="field"><span>Round to</span><div class="unit-in">${num('round', c.round, '10')}<em>${esc(cur)}</em></div></label>
        <label class="field"><span>Deposit</span><div class="unit-in">${num('deposit', c.deposit, '5')}<em>%</em></div></label>
        <label class="field"><span>Range shown ${help('The ± range under the estimate.')}</span><div class="unit-in">${num('range', c.range, '5')}<em>%</em></div></label>
      </div>
      <div class="qc-vat"><label class="toggle"><input type="checkbox" id="qc-vat" ${c.vatOn ? 'checked' : ''}><span>Add VAT to quotes</span></label>
        <div class="unit-in" style="width:120px">${num('vatRate', c.vatRate, '0.5')}<em>%</em></div></div>
      <div class="qc-vat"><label class="toggle" data-tip="Adds a line about your touch-up price to quote sheets and receipts"><input type="checkbox" id="qc-tu" ${c.touchupNote ? 'checked' : ''}><span>Touch-up fee on documents ${help('Set 0 if your touch-ups are free; documents then say so.')}</span></label>
        <div class="unit-in" style="width:120px">${num('touchupFee', c.touchupFee, '10')}<em>${esc(cur)}</em></div></div></div>
    <div class="card"><h2>Speed ${help('How many minutes one square centimetre takes at each detail level. Fill is how much of the size box is actually inked.')}</h2>
      <label class="field"><span>Design fill of the size box</span><div class="unit-in">${num('fill', c.fill, '5')}<em>%</em></div></label>
      ${DETAIL_LEVELS.map(([n], i) => `<div class="qc-row"><span class="qc-ic">${detailSvg(i + 1, 'bg')}</span><span>${n}</span>
        <div class="unit-in">${num(`speed.${i}`, c.speed[i], '0.05')}<em>min/cm²</em></div></div>`).join('')}
      <p class="muted" style="font-size:12px">A 10 × 10 cm ${DETAIL_LEVELS[2][0].toLowerCase()} piece ≈ ${fmtH(100 * c.fill / 100 * c.speed[2] / 60)}.</p></div>
    <div class="card"><h2>Colour</h2>${COLOUR_MODES.map(([k, l]) => `<div class="qc-row"><span class="qz-sw sw-${k}"></span><span>${l}</span>
        <div class="unit-in">${num(`colour.${k}`, c.colour[k], '0.05')}<em>× time</em></div></div>`).join('')}</div>
    <div class="card"><h2>Pain and difficulty ${help('Each placement has a pain level; each level adds time. Change a placement\'s level below.')}</h2>
      ${PAIN_NAMES.map((n, i) => `<div class="qc-row"><b class="qc-dot" style="background:${PAIN_COLOURS[i]}"></b><span>${n}</span>
        <div class="unit-in">${num(`pain.${i}`, c.pain[i], '0.05')}<em>× time</em></div></div>`).join('')}
      <details class="guide" ${R.qcOpen === 'pl' ? 'open' : ''} data-open="pl"><summary>Placements (${c.placements.length})</summary>
        ${c.placements.map(([n, g, p], i) => `<div class="qc-row qc-del"><b class="qc-dot" style="background:${PAIN_COLOURS[p - 1]}"></b><span>${esc(n)} <span class="muted" style="font-size:12px">${esc(g)}</span></span>
          <select class="in qc-n" data-p="placements.${i}.2">${PAIN_NAMES.map((pn, j) => `<option value="${j + 1}" ${p === j + 1 ? 'selected' : ''}>${pn}</option>`).join('')}</select>
          <button class="mini del" data-del="placements.${i}" aria-label="Remove ${esc(n)}">&times;</button></div>`).join('')}
        <div class="qc-add">
          <input class="in" id="qc-pl-name" placeholder="New placement, e.g. Behind the ear">
          <select class="in" id="qc-pl-group">${[...new Set(c.placements.map(p => p[1]))].map(g => `<option>${esc(g)}</option>`).join('')}</select>
          <select class="in" id="qc-pl-pain">${PAIN_NAMES.map((pn, j) => `<option value="${j + 1}" ${j === 2 ? 'selected' : ''}>${pn} pain</option>`).join('')}</select>
          <button class="btn small primary" id="qc-pl-add">Add</button></div>
      </details></div>
    <div class="card"><h2>Styles ${help('Adds or removes time for a style. 1 = no change, 1.3 = 30% longer.')}</h2>
      ${c.styles.map(([n, f], i) => `<div class="qc-row qc-del"><span>${esc(n)}</span><div class="unit-in">${num(`styles.${i}.1`, f, '0.05')}<em>×</em></div>
        <button class="mini del" data-del="styles.${i}" aria-label="Remove ${esc(n)}">&times;</button></div>`).join('')}
      <div class="qc-add"><input class="in" id="qc-st-name" placeholder="New style, e.g. Ornamental">
        <div class="unit-in"><input class="in" id="qc-st-f" type="number" step="0.05" value="1"><em>×</em></div>
        <button class="btn small primary" id="qc-st-add">Add</button></div></div>
    <div class="card"><h2>Lettering</h2>
      <label class="field"><span>Minutes per letter ${help('At 2 cm letter height. Bigger letters scale up.')}</span><div class="unit-in">${num('textMin', c.textMin, '0.5')}<em>min</em></div></label>
      ${c.fonts.map(([n, f], i) => `<div class="qc-row"><span>${esc(n)}</span><div class="unit-in">${num(`fonts.${i}.1`, f, '0.05')}<em>×</em></div></div>`).join('')}</div>
    <button class="btn danger" id="qc-reset" style="margin:4px 0 24px">Reset all to defaults</button>`;
  el.oninput = (e) => {
    const p = e.target.dataset.p; if (!p) return;
    const cfg = qCfg(), keys = p.split('.'), v = +e.target.value;
    let o = cfg; for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = v;
    qSave(cfg);
    if (p.startsWith('anchors') || p === 'round') { const c2 = qCfg(); el.querySelectorAll('.qc-sample b').forEach((b, i) => b.textContent = money(qRound(c2, qCurve(c2, [1, 2, 3, 4, 6, 9][i])))); }
  };
  el.onchange = async (e) => {
    if (e.target.id === 'qc-vat') { const cfg = qCfg(); cfg.vatOn = e.target.checked; return qSave(cfg); }
    if (e.target.id === 'qc-tu') { const cfg = qCfg(); cfg.touchupNote = e.target.checked; return qSave(cfg); }
    if (e.target.dataset.p && e.target.tagName === 'SELECT') qcDraw();
  };
  el.addEventListener('toggle', (e) => { if (e.target.dataset.open) R.qcOpen = e.target.open ? e.target.dataset.open : null; }, true);
  el.onclick = async (e) => {
    const cfg = qCfg();
    const del = e.target.closest('[data-del]');
    if (del) {
      const [list, i] = del.dataset.del.split('.'), name = cfg[list][+i][0];
      if (!confirm(`Remove "${name}"?`)) return;
      cfg[list].splice(+i, 1); await qSave(cfg); return qcDraw();
    }
    if (e.target.closest('#qc-pl-add')) {
      const n = $('#qc-pl-name').value.trim(); if (!n) return toast('Type a name for the placement.');
      if (cfg.placements.some(p => p[0].toLowerCase() === n.toLowerCase())) return toast('That placement is already listed.');
      cfg.placements.push([n, $('#qc-pl-group').value, +$('#qc-pl-pain').value]); await qSave(cfg); toast(`Added ${n}.`); return qcDraw();
    }
    if (e.target.closest('#qc-st-add')) {
      const n = $('#qc-st-name').value.trim(); if (!n) return toast('Type a name for the style.');
      if (cfg.styles.some(x => x[0].toLowerCase() === n.toLowerCase())) return toast('That style is already listed.');
      cfg.styles.push([n, +$('#qc-st-f').value || 1]); await qSave(cfg); toast(`Added ${n}.`); return qcDraw();
    }
    if (e.target.closest('#qc-add')) { const last = cfg.anchors[cfg.anchors.length - 1] || [1, 500]; cfg.anchors.push([last[0] + 2, last[1] + 1000]); await qSave(cfg); return qcDraw(); }
    const rm = e.target.closest('[data-rm]');
    if (rm) { cfg.anchors.splice(+rm.dataset.rm, 1); await qSave(cfg); return qcDraw(); }
    if (e.target.closest('#qc-reset') && confirm('Reset every quote setting to the defaults?')) { await Settings.set('quote_v2', ''); qcDraw(); toast('Defaults restored.'); }
  };
}

/* ---------- Thank-you receipt ----------
   For a completed tattoo: what they paid, plus an optional promotion on their next tattoo
   (% or amount off, valid for N months) and optionally an aftercare sheet as a second page.
   Pages are drawn on canvases, so print/PDF and images are identical. The promotion is saved on
   the booking so Stats can list promotions still open; the show/hide choices are remembered. */
const RECEIPT_PARTS = [['description', 'Tattoo'], ['placement', 'Placement'], ['size', 'Size'], ['time', 'Time tattooed'],
  ['method', 'Paid by'], ['tips', 'Care tips'], ['touchup', 'Touch-up fee']];
function receiptOpts() {
  let o = {}; try { o = JSON.parse(Settings.get('receipt_opts', '{}')); } catch {}
  return { show: { description: true, placement: true, size: true, time: true, method: true, tips: true, touchup: true, ...o.show },
    aftercare: !!o.aftercare, aftercareId: o.aftercareId || null };
}
// Touch-up fee line for documents, from Calibrate (0 = free). '' when the artist hides it.
const touchupLine = () => { const c = qCfg(); if (!c.touchupNote) return '';
  return +c.touchupFee > 0 ? `Touch-ups after healing are ${money(+c.touchupFee)}.` : 'Touch-ups after healing are free.'; };

async function openReceipt(bid) {
  const b = await DB.one(`SELECT b.*, c.first_name, c.last_name FROM bookings b LEFT JOIN clients c ON c.id = b.client_id WHERE b.id = ?`, [bid]);
  if (!b) return;
  const cur = Settings.get('currency'), opts = receiptOpts();
  const afters = await DB.all(`SELECT id, title FROM form_templates WHERE kind = 'aftercare' ORDER BY title COLLATE NOCASE`);
  if (!afters.some(a => a.id === opts.aftercareId)) opts.aftercareId = afters[0]?.id ?? null;
  const st = { kind: b.promo_kind || '', value: b.promo_value ?? 10, months: +Settings.get('promo_months', '3') || 3 };
  const o = document.createElement('div'); o.id = 'merge-dlg';
  const draw = () => {
    o.innerHTML = `<div class="card rc-card"><h2>Thank-you receipt</h2>
      <div class="stat"><span>${esc(bName(b))}</span><span><b>${b.paid != null ? money(b.paid) : '—'}</b>${b.pay_method ? ' · ' + esc(b.pay_method) : ''}</span></div>
      ${b.paid == null ? '<p class="muted" style="font-size:12px">Add the final price paid on the booking to show it here.</p>' : ''}
      <div class="lbl" style="margin-top:14px">Show on the receipt</div>
      <div class="qz-chips">${RECEIPT_PARTS.map(([k, l]) => `<button class="chip qz-chip ${opts.show[k] ? 'on' : ''}" data-part="${k}">${opts.show[k] ? '✓ ' : ''}${l}</button>`).join('')}</div>
      <div class="lbl" style="margin-top:6px">Next-tattoo promotion</div>
      <div class="seg" id="rc-kind" style="margin-bottom:10px">${[['', 'None'], ['pct', '% off'], ['amt', `${cur || 'Amount'} off`]].map(([k, l]) =>
        `<button data-k="${k}" class="${st.kind === k ? 'on' : ''}" style="flex:1">${esc(l)}</button>`).join('')}</div>
      ${st.kind ? `<div class="two">
        <label class="field"><span>${st.kind === 'pct' ? 'Percent off' : 'Amount off'}</span><div class="unit-in"><input class="in" id="rc-val" type="number" min="0" step="any" value="${st.value}"><em>${st.kind === 'pct' ? '%' : esc(cur)}</em></div></label>
        <label class="field"><span>Valid for</span><div class="unit-in"><input class="in" id="rc-mo" type="number" min="1" max="24" value="${st.months}"><em>months</em></div></label>
      </div>` : ''}
      <div class="rc-after">
        <label class="toggle" ${afters.length ? '' : 'data-tip="Create an aftercare form under Studio › Forms first"'}><input type="checkbox" id="rc-ac" ${opts.aftercare && afters.length ? 'checked' : ''} ${afters.length ? '' : 'disabled'}><span>Include aftercare</span></label>
        ${afters.length > 1 ? `<select class="in" id="rc-acid" ${opts.aftercare ? '' : 'disabled'}>${afters.map(a => `<option value="${a.id}" ${a.id === opts.aftercareId ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}</select>` : ''}
      </div>
      <p class="muted" style="font-size:12px;margin:4px 0 10px">${opts.aftercare ? 'Print / PDF puts both on one document; images and Send give two pages.' : ''}</p>
      <div class="qz-acts">
        <button class="btn" id="rc-print">Print / PDF</button><button class="btn" id="rc-img">Save image</button><button class="btn primary" id="rc-send">Send</button></div>
      <button class="btn" id="rc-close" style="width:100%;margin-top:8px">Close</button></div>`;
  };
  document.body.appendChild(o); draw();
  const promo = () => st.kind ? { kind: st.kind, value: +st.value || 0, until: ymd(addDays(new Date(), Math.round(st.months * 30.44))) } : null;
  const remember = async () => {
    const p = promo();
    await DB.run('UPDATE bookings SET promo_kind = ?, promo_value = ?, promo_until = ? WHERE id = ?', [p?.kind || null, p?.value ?? null, p?.until || null, bid]);
    if (st.kind) await Settings.set('promo_months', String(st.months));
    await Settings.set('receipt_opts', JSON.stringify(opts));
  };
  o.addEventListener('input', (e) => { if (e.target.id === 'rc-val') st.value = +e.target.value; if (e.target.id === 'rc-mo') st.months = +e.target.value || 3; });
  o.addEventListener('change', (e) => {
    if (e.target.id === 'rc-ac') { opts.aftercare = e.target.checked; draw(); }
    if (e.target.id === 'rc-acid') opts.aftercareId = +e.target.value;
  });
  o.addEventListener('click', async (e) => {
    const part = e.target.closest('[data-part]');
    if (part) { opts.show[part.dataset.part] = !opts.show[part.dataset.part]; return draw(); }
    const k = e.target.closest('[data-k]');
    if (k) { st.kind = k.dataset.k; if (st.kind === 'amt' && st.value <= 50) st.value = 100; if (st.kind === 'pct' && st.value > 50) st.value = 10; return draw(); }
    if (e.target.closest('#rc-close')) return o.remove();
    const act = e.target.closest('#rc-print, #rc-img, #rc-send')?.id; if (!act) return;
    await remember();
    const pages = await receiptPages(b, promo(), opts);
    if (act === 'rc-print') return printCanvas(...pages.map(p => p.cv));
    const files = await Promise.all(pages.map(async (p) => new File([await new Promise(r => p.cv.toBlob(r, 'image/png'))], p.name, { type: 'image/png' })));
    try {
      if (act === 'rc-send' && navigator.canShare?.({ files })) await navigator.share({ files, title: 'Thank you', text: receiptText(b, promo()) });
      else if (act === 'rc-send' && navigator.share) await navigator.share({ text: receiptText(b, promo()) });
      else {
        for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
        toast(files.length > 1 ? 'Receipt and aftercare saved.' : 'Receipt saved.');
      }
    } catch (err) { if (err.name !== 'AbortError') toast('Could not share: ' + err.message); }
  });
}

// Receipt page, plus the chosen aftercare form as a second page when asked for.
async function receiptPages(b, promo, opts) {
  const tag = b.first_name ? '-' + b.first_name.replace(/[^\w-]+/g, '_') : '';
  const r = await receiptSheet(b, promo, opts.show);
  const pages = [{ cv: r.cv, name: `Receipt-${r.ref}${tag}.png` }];
  if (opts.aftercare && opts.aftercareId) {
    const t = await DB.one('SELECT * FROM form_templates WHERE id = ?', [opts.aftercareId]);
    if (t) {
      const client = b.client_id ? await DB.one('SELECT * FROM clients WHERE id = ?', [b.client_id]) : null;
      pages.push({ cv: await formPage(t, formCtx(client, b)), name: `Aftercare-${r.ref}${tag}.png` });
    }
  }
  return pages;
}

const promoLabel = (p) => p ? (p.kind === 'pct' ? `${+p.value}% off` : `${money(p.value)} off`) + ' your next tattoo' : '';
function receiptText(b, p) {
  const studio = Settings.get('studio_name') || Settings.get('artist_name');
  return `Thank you${b.first_name ? ', ' + b.first_name : ''}!${studio ? ' From ' + studio : ''}\n`
    + `${b.description || 'Tattoo'}${b.placement ? ' · ' + b.placement : ''}\nPaid: ${b.paid != null ? money(b.paid) : '—'}\n`
    + (p ? `\nAs a thank you: ${promoLabel(p)}. Valid until ${fmtDay(p.until)}.\n` : '')
    + (touchupLine() ? '\n' + touchupLine() : '')
    + '\nFollow your aftercare and reach out if anything looks off.';
}

// Prints canvas pages (quote sheets, receipts, aftercare) through #print-area, one A4 page each.
async function printCanvas(...cvs) {
  let p = $('#print-area');
  if (!p) { p = document.createElement('div'); p.id = 'print-area'; document.body.appendChild(p); }
  p.innerHTML = cvs.map(cv => `<img src="${cv.toDataURL('image/png')}" class="quote-print" alt="">`).join('');
  await Promise.all([...p.querySelectorAll('img')].map(i => i.decode().catch(() => {})));
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); p.innerHTML = ''; removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  window.print();
}

/* Shared page drawing for A4 documents (1240 x 1754 = 150 dpi). */
const DOC = { W: 1240, H: 1754, M: 90, teal: '#14857c', ink: '#1a1a1a', soft: '#6b6b6b' };
async function docCanvas() {
  await Promise.all([document.fonts.load("64px 'Pirata One'"), document.fonts.load('600 28px Inter'), document.fonts.load('400 28px Inter')]).catch(() => {});
  const cv = document.createElement('canvas'); cv.width = DOC.W; cv.height = DOC.H;
  const x = cv.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, DOC.W, DOC.H);
  const font = (px, w = 400, disp = false) => disp ? `${px}px 'Pirata One', serif` : `${w} ${px}px Inter, system-ui, sans-serif`;
  const text = (s, tx, ty, f, col = DOC.ink, align = 'left') => { x.font = f; x.fillStyle = col; x.textAlign = align; x.textBaseline = 'alphabetic'; x.fillText(s, tx, ty); };
  const wrap = (s, f, maxW) => { x.font = f; const out = []; let line = '';
    for (const w of String(s).split(/\s+/)) { const t = line ? line + ' ' + w : w; if (x.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
    if (line) out.push(line); return out; };
  // Header: logo and studio left, contact details right, accent rule under it.
  const header = async () => {
    const { M, W } = DOC, studio = Settings.get('studio_name') || Settings.get('artist_name') || 'Tattoo studio';
    let hx = M;
    const logoUrl = await Media.url(Settings.get('studio_logo_ref'));
    if (logoUrl) { const img = new Image(); img.src = logoUrl; await img.decode().catch(() => {});
      if (img.naturalWidth) { const sc = Math.min(220 / img.naturalWidth, 140 / img.naturalHeight); x.drawImage(img, M, 70, img.naturalWidth * sc, img.naturalHeight * sc); hx = M + img.naturalWidth * sc + 30; } }
    text(studio, hx, 140, font(60, 400, true));
    [Settings.get('artist_phone'), Settings.get('artist_instagram'), Settings.get('artist_facebook'), Settings.get('artist_tiktok')].filter(Boolean)
      .forEach((s, i) => text(s.replace(/^https?:\/\/(www\.)?/, ''), W - M, 100 + i * 34, font(22), DOC.soft, 'right'));
    x.fillStyle = DOC.teal; x.fillRect(M, 240, W - 2 * M, 6);
  };
  return { cv, x, font, text, wrap, header };
}

async function receiptSheet(b, promo, show) {
  const { W, H, M, teal, ink, soft } = DOC;
  const { cv, x, font, text, wrap, header } = await docCanvas();
  await header();
  const ref = 'R' + b.start_at.slice(2, 10).replace(/-/g, '') + '-' + b.id;
  text(`Thank you${b.first_name ? ', ' + b.first_name : ''}!`, M, 370, font(96, 400, true));
  text('Receipt', M, 425, font(28, 600), soft);
  [['Receipt no.', ref], ['Session', fmtDay(b.start_at)], ['Client', bName(b)]].forEach(([k, v], i) => {
    text(k, W - M - 440, 330 + i * 38, font(22, 600), soft); text(v, W - M, 330 + i * 38, font(24, 500), ink, 'right');
  });
  let y = 500;
  const rows = [show.description && ['Tattoo', b.description], show.placement && ['Placement', b.placement], show.size && ['Size', b.size],
    show.time && ['Time tattooed', b.time_min != null ? fmtH(b.time_min / 60) : null], show.method && ['Paid by', b.pay_method]].filter(r => r && r[1]);
  rows.forEach(([k, v], i) => {
    const lines = wrap(v, font(28), W - 2 * M - 300), h = 22 + lines.length * 38;
    if (i % 2 === 0) { x.fillStyle = '#f7f4ee'; x.fillRect(M, y, W - 2 * M, h); }
    text(k, M + 24, y + 42, font(26, 600), soft); lines.forEach((ln, j) => text(ln, M + 300, y + 42 + j * 38, font(28))); y += h;
  });
  y += rows.length ? 50 : 10;
  x.fillStyle = '#eef8f6'; x.strokeStyle = teal; x.lineWidth = 3;
  x.beginPath(); x.roundRect(M, y, W - 2 * M, 170, 24); x.fill(); x.stroke();
  text('AMOUNT PAID', M + 40, y + 100, font(26, 700), soft);
  text(b.paid != null ? money(b.paid) : '—', W - M - 40, y + 118, font(96, 400, true), teal, 'right');
  y += 170 + 60;
  if (promo) {
    // A cut-out coupon: dashed border, the offer large, the expiry under it.
    x.save(); x.setLineDash([16, 12]); x.strokeStyle = ink; x.lineWidth = 3;
    x.beginPath(); x.roundRect(M + 60, y, W - 2 * M - 120, 290, 28); x.stroke(); x.restore();
    text('✂', M + 40, y + 20, font(34), soft);
    text('A THANK YOU FOR NEXT TIME', W / 2, y + 66, font(24, 700), teal, 'center');
    text(promo.kind === 'pct' ? `${+promo.value}% off` : `${money(promo.value)} off`, W / 2, y + 166, font(104, 400, true), ink, 'center');
    text('your next tattoo', W / 2, y + 212, font(30, 500), ink, 'center');
    text(`Valid until ${fmtDay(promo.until)} · receipt ${ref}`, W / 2, y + 258, font(22), soft, 'center');
    y += 290 + 60;
  }
  const notes = [...(show.tips ? ['Follow your aftercare instructions for the next 2 to 4 weeks.', 'Keep it out of the sun while it heals; use SPF once healed.',
    'Anything unusual, or a spot that needs a touch-up? Get in touch.'] : []), show.touchup && touchupLine()].filter(Boolean);
  if (notes.length) {
    text(show.tips ? 'LOOKING AFTER IT' : 'GOOD TO KNOW', M, y, font(22, 700), teal); y += 44;
    for (const s of notes) for (const ln of wrap('•  ' + s, font(26), W - 2 * M)) { text(ln, M, y, font(26)); y += 40; }
  }
  const fy = Math.min(H - 60, Math.max(y + 60, H - 130));
  x.fillStyle = teal; x.fillRect(M, fy - 50, W - 2 * M, 3);
  text('See you next time!', M, fy, font(44, 400, true));
  text(ref, W - M, fy - 4, font(20), soft, 'right');
  return { cv, ref };
}

/* A form (e.g. aftercare) as an A4 page, matching the receipt. Lays the blocks out in one column,
   or two columns with smaller text when that's what it takes to fit on one page. */
async function formPage(t, c) {
  const { W, H, M, teal, ink, soft } = DOC;
  const { cv, x, font, text, wrap, header } = await docCanvas();
  await header();
  const blocks = JSON.parse(t.blocks).filter(b => !blankLine(b, c));
  const top = 290, bottom = H - 90;
  const items = (cols, px) => {
    const colW = (W - 2 * M - (cols - 1) * 50) / cols, lh = Math.round(px * 1.42), out = [];
    for (const b of blocks) {
      const s = fillPlaceholders(b.text, c);
      if (b.t === 'h') out.push({ kind: 'h', lines: wrap(s, font(Math.round(px * 2.6), 400, true), W - 2 * M), lh: Math.round(px * 2.9), span: true });
      else if (b.t === 'sub') out.push({ kind: 'sub', lines: wrap(s.toUpperCase(), font(Math.round(px * 0.82), 700), colW), lh: Math.round(px * 1.2), gap: Math.round(px * 0.9) });
      else if (b.t === 'li' || b.t === 'check') out.push({ kind: 'li', lines: wrap(s, font(px), colW - 30), lh });
      else if (b.t === 'p') out.push({ kind: 'p', lines: wrap(s, font(px), colW), lh, gap: Math.round(px * 0.4) });
    }
    return { out, colW };
  };
  // Pick the first layout that fits: 1 column, then 2 columns at decreasing sizes.
  let plan;
  for (const [cols, px] of [[1, 28], [1, 25], [2, 25], [2, 22], [2, 19], [2, 16]]) {
    const { out, colW } = items(cols, px);
    const h0 = out.filter(i => i.span).reduce((s, i) => s + i.lines.length * i.lh + 20, 0);
    const flow = out.filter(i => !i.span).reduce((s, i) => s + (i.gap || 0) + i.lines.length * i.lh, 0);
    plan = { cols, px, out, colW, h0 };
    if (h0 + flow / cols * 1.08 <= bottom - top) break;
  }
  let y = top, col = 0;
  for (const it of plan.out.filter(i => i.span)) { for (const ln of it.lines) { y += it.lh; text(ln, M, y, font(Math.round(plan.px * 2.6), 400, true)); } y += 20; }
  const flowTop = y, colX = (n) => M + n * (plan.colW + 50);
  for (const it of plan.out.filter(i => !i.span)) {
    const need = (it.gap || 0) + it.lines.length * it.lh + (it.kind === 'sub' ? plan.px * 2.5 : 0);   // keep a heading with its first line
    if (y + need > bottom && col < plan.cols - 1) { col++; y = flowTop; }
    y += it.gap || 0;
    it.lines.forEach((ln, j) => {
      y += it.lh;
      if (it.kind === 'sub') text(ln, colX(col), y, font(Math.round(plan.px * 0.82), 700), teal);
      else if (it.kind === 'li') { if (j === 0) { x.fillStyle = teal; x.beginPath(); x.arc(colX(col) + 8, y - plan.px * 0.35, plan.px * 0.18, 0, 7); x.fill(); } text(ln, colX(col) + 30, y, font(plan.px), ink); }
      else text(ln, colX(col), y, font(plan.px), ink);
    });
  }
  text(t.title, W - M, H - 50, font(20), soft, 'right');
  return cv;
}

/* ---------- Open appointments ----------
   A one-page calendar of open days (1 to 3 months) to send to clients, on its own or with a quote.
   Each day is worked out from the artist's own calendar:
     off    = one of the artist's days off (or in the past): left blank
     taken  = a Hold or Leave booking that day, or already at the day's maximum tattoos,
              or less than 2 hours left inside working hours
     part   = some bookings already, still room for a smaller piece
     open   = nothing booked inside working hours: room for a large, full-day piece
   Google "busy" blocks count as booked time. */
const AV = { months: 3, from: 'now' };
const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const workHours = () => [Settings.get('day_start', '10:00'), Settings.get('day_end', '17:00')];
const maxPerDay = () => Math.max(1, +Settings.get('max_per_day', '1') || 1);

// opts (all optional, per client): need = minutes the session needs (a "some time left" day must
// have at least this much free), fullOnly = only fully open days, hidden = dates to leave off.
async function availability(start, end, opts = {}) {
  const need = Math.max(30, opts.need || 120), hidden = new Set(opts.hidden || []);
  const [ws, we] = workHours().map(toMin), work = Math.max(60, we - ws);
  const rows = await DB.all(`SELECT start_at, duration_min, kind FROM bookings WHERE start_at >= ? AND start_at < ?`, [ymd(start), ymd(end)]);
  const busy = Settings.get('gcal_busy', '1') === '1' ? await DB.all('SELECT start_at, end_at FROM gcal_busy WHERE start_at < ? AND end_at > ?', [ymd(end), ymd(start)]) : [];
  const off = daysOff(), today = ymd(new Date()), out = {};
  for (let d = new Date(start); d < end; d = addDays(d, 1)) {
    const k = ymd(d);
    if (k < today || isDayOff(k, off)) { out[k] = 'off'; continue; }
    if (hidden.has(k)) { out[k] = 'taken'; continue; }
    const day = rows.filter(r => r.start_at.startsWith(k));
    if (day.some(r => r.kind === 'hold' || r.kind === 'leave')) { out[k] = 'taken'; continue; }
    // Only tattoo sessions use up the day's tattoo count; consultations just take time.
    if (day.filter(r => DONE_KINDS.includes(r.kind)).length >= maxPerDay()) { out[k] = 'taken'; continue; }
    // Booked minutes inside working hours, from bookings and Google busy time.
    const spans = day.map(r => { const s = minutesOf(r.start_at); return [s, s + r.duration_min]; });
    for (const x of busy) { if (x.start_at >= ymd(addDays(d, 1)) || x.end_at <= k) continue;
      spans.push([x.start_at < k ? 0 : minutesOf(x.start_at), x.end_at >= ymd(addDays(d, 1)) ? 1440 : minutesOf(x.end_at)]); }
    let used = 0; for (const [s, e] of spans) used += Math.max(0, Math.min(e, we) - Math.max(s, ws));
    out[k] = used <= 0 && work >= need ? 'open' : !opts.fullOnly && work - used >= need ? 'part' : 'taken';
  }
  return out;
}
function availRange(months = AV.months, from = AV.from) {
  const t = new Date(), start = from === 'next' ? new Date(t.getFullYear(), t.getMonth() + 1, 1) : new Date(t.getFullYear(), t.getMonth(), 1);
  return [start, new Date(start.getFullYear(), start.getMonth() + months, 1)];
}

// The sheet: header, up to three month grids stacked, legend and notes, always one A4 page.
async function availSheet(months = AV.months, from = AV.from, opts = {}) {
  const { W, H, M, teal, ink, soft } = DOC;
  const { cv, x, font, text, wrap, header } = await docCanvas();
  await header();
  const [start, end] = availRange(months, from), map = await availability(start, end, opts);
  const mfmt = (d, o) => d.toLocaleDateString(undefined, o);
  text('Open appointments', M, 360, font(88, 400, true));
  const last = addDays(end, -1);
  text(`${mfmt(start, { month: 'long' })}${months > 1 ? ' – ' + mfmt(last, { month: 'long' }) : ''} ${last.getFullYear()}`, M, 410, font(28, 600), soft);
  const [ws, we] = workHours();
  text(`Usually ${ws} – ${we}`, W - M, 410, font(24, 500), soft, 'right');

  const COL = { open: teal, part: '#e0a33a', taken: '#c9c4ba' };
  const legendY = 462;
  [['open', 'Open: room for a big piece'], ['part', 'Some time left'], ['taken', 'Booked']].forEach(([k, l], i) => {
    const lx = M + [0, 430, 740][i];
    x.fillStyle = COL[k]; x.beginPath(); x.roundRect(lx, legendY - 22, 30, 30, 8); x.fill();
    text(l, lx + 42, legendY, font(22, 500), ink);
  });

  // Space for the months, shared equally, so three still fit on one page.
  const top = 510, notesH = 230, avail = H - 120 - notesH - top, gap = 26;
  const mh = (avail - gap * (months - 1)) / months, cw = (W - 2 * M) / 7;
  for (let m = 0; m < months; m++) {
    const first = new Date(start.getFullYear(), start.getMonth() + m, 1);
    const y0 = top + m * (mh + gap);
    const lead = (first.getDay() + 6) % 7, days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const rows = Math.ceil((lead + days) / 7), titleH = 44, headH = 30, ch = Math.min(90, (mh - titleH - headH) / rows);
    text(mfmt(first, { month: 'long', year: 'numeric' }), M, y0 + 34, font(34, 400, true), ink);
    const counts = { open: 0, part: 0 };
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((l, i) => text(l, M + i * cw + cw / 2, y0 + titleH + 22, font(18, 700), soft, 'center'));
    for (let dnum = 1; dnum <= days; dnum++) {
      const i = lead + dnum - 1, cx = M + (i % 7) * cw, cy = y0 + titleH + headH + Math.floor(i / 7) * ch;
      const st = map[ymd(new Date(first.getFullYear(), first.getMonth(), dnum))];
      if (st === 'open' || st === 'part') counts[st]++;
      if (st !== 'off') { x.fillStyle = COL[st]; x.globalAlpha = st === 'taken' ? 0.45 : 1; x.beginPath(); x.roundRect(cx + 4, cy + 4, cw - 8, ch - 8, 10); x.fill(); x.globalAlpha = 1; }
      text(String(dnum), cx + cw / 2, cy + ch / 2 + 9, font(Math.min(26, ch * 0.4), st === 'open' || st === 'part' ? 700 : 400),
        st === 'open' || st === 'part' ? '#fff' : st === 'taken' ? soft : '#bdb8ae', 'center');
    }
    text(`${counts.open + counts.part} open day${counts.open + counts.part === 1 ? '' : 's'}`, W - M, y0 + 34, font(20, 600), soft, 'right');
  }

  let y = H - 120 - notesH + 40;
  text('PLEASE NOTE', M, y, font(22, 700), teal); y += 42;
  const phone = Settings.get('artist_phone');
  for (const s of ['Openings are live: they change as bookings come in, so a date is only yours once your deposit is paid.',
    opts.need ? `Days shown have room for your session of about ${fmtH(opts.need / 60)}.` : 'Large or full-day pieces need an open (green) day.',
    phone ? `To book, get in touch: ${phone}.` : 'Get in touch to book your date.'])
    for (const ln of wrap('•  ' + s, font(24), W - 2 * M)) { text(ln, M, y, font(24)); y += 36; }
  x.fillStyle = teal; x.fillRect(M, H - 110, W - 2 * M, 3);
  text(`Made ${fmtDay(ymd(new Date()))}`, W - M, H - 66, font(20), soft, 'right');
  return { cv, map, start, end };
}

// The same openings as plain text, for messages.
function availText(map, start, end) {
  const byMonth = {};
  for (const [k, st] of Object.entries(map)) if (st === 'open' || st === 'part') {
    const d = new Date(k + 'T00:00'), m = d.toLocaleDateString(undefined, { month: 'long' });
    (byMonth[m] ||= []).push(`${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}${st === 'part' ? '*' : ''}`);
  }
  const lines = Object.entries(byMonth).map(([m, ds]) => `${m}: ${ds.join(', ')}`);
  return `Open appointments\n${lines.join('\n') || 'No open days in this period.'}\n${lines.some(l => l.includes('*')) ? '* some time left, not for a full-day piece\n' : ''}`
    + 'Openings change as bookings come in; a date is only yours once your deposit is paid.';
}

async function openAvailability() {
  const o = document.createElement('div'); o.id = 'merge-dlg';
  const draw = async () => {
    const [s, e] = availRange(), map = await availability(s, e);
    const open = Object.values(map).filter(v => v === 'open').length, part = Object.values(map).filter(v => v === 'part').length;
    o.innerHTML = `<div class="card"><h2>Share open appointments</h2>
      <p class="muted" style="margin-top:0;font-size:13px">A one-page calendar of your open days, worked out from your bookings, days off, working hours (${workHours().join('–')}) and up to ${maxPerDay()} tattoo${maxPerDay() > 1 ? 's' : ''} a day. To keep a day off this sheet, add a <b>Hold</b> booking on it.</p>
      <div class="lbl">How far ahead</div>
      <div class="seg" id="av-m" style="margin-bottom:10px">${[1, 2, 3].map(n => `<button data-m="${n}" class="${AV.months === n ? 'on' : ''}" style="flex:1">${n} month${n > 1 ? 's' : ''}</button>`).join('')}</div>
      <div class="seg" id="av-f" style="margin-bottom:12px">${[['now', 'From this month'], ['next', 'From next month']].map(([k, l]) => `<button data-f="${k}" class="${AV.from === k ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}</div>
      <div class="stat"><span>Open days</span><span><b>${open}</b> full · <b>${part}</b> part</span></div>
      <div class="qz-acts" style="margin-top:12px"><button class="btn" id="av-print">Print / PDF</button><button class="btn" id="av-img">Save image</button><button class="btn primary" id="av-send">Send</button></div>
      <button class="btn" id="av-close" style="width:100%;margin-top:8px">Close</button></div>`;
  };
  document.body.appendChild(o); await draw();
  o.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-m]'), f = e.target.closest('[data-f]');
    if (m) { AV.months = +m.dataset.m; return draw(); }
    if (f) { AV.from = f.dataset.f; return draw(); }
    if (e.target.closest('#av-close')) return o.remove();
    const act = e.target.closest('#av-print, #av-img, #av-send')?.id; if (!act) return;
    const { cv, map, start, end } = await availSheet();
    if (act === 'av-print') return printCanvas(cv);
    const file = new File([await new Promise(r => cv.toBlob(r, 'image/png'))], `Open-appointments-${ymd(start).slice(0, 7)}.png`, { type: 'image/png' });
    try {
      if (act === 'av-send' && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Open appointments', text: availText(map, start, end) });
      else if (act === 'av-send' && navigator.share) await navigator.share({ text: availText(map, start, end) });
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast('Saved.'); }
    } catch (err) { if (err.name !== 'AbortError') toast('Could not share: ' + err.message); }
  });
}

/* ---------- Stats ----------
   Built from completed tattoo bookings (tattoo and touch-up) in the chosen period. */
const STATS = { period: 'year', from: '', to: '' };
function statsRange() {
  const t = new Date(), y = t.getFullYear(), m = t.getMonth();
  if (STATS.period === 'month') return [ymd(new Date(y, m, 1)), ymd(new Date(y, m + 1, 0))];
  if (STATS.period === '3m') return [ymd(new Date(y, m - 2, 1)), ymd(new Date(y, m + 1, 0))];
  if (STATS.period === 'year') return [`${y}-01-01`, `${y}-12-31`];
  if (STATS.period === 'custom') return [STATS.from || '0000-01-01', STATS.to || '9999-12-31'];
  return ['0000-01-01', '9999-12-31'];
}
async function statsRows() {
  const [a, z] = statsRange();
  return DB.all(`SELECT b.*, c.first_name, c.last_name FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
    WHERE b.completed = 1 AND substr(b.start_at, 1, 10) BETWEEN ? AND ? ORDER BY b.start_at`, [a, z]);
}
async function renderStats() {
  const el = $('#st-body'); if (!el) return;
  const rows = await statsRows(), [a, z] = statsRange();
  const n = rows.length, mins = rows.reduce((s, r) => s + (r.time_min || 0), 0), paid = rows.reduce((s, r) => s + (r.paid || 0), 0);
  const hours = mins / 60, clients = new Set(rows.map(r => r.client_id).filter(Boolean));
  // Returning = had a completed tattoo before this period started.
  const before = new Set((await DB.all(`SELECT DISTINCT client_id FROM bookings WHERE completed = 1 AND substr(start_at, 1, 10) < ? AND client_id IS NOT NULL`, [a])).map(r => r.client_id));
  const returning = [...clients].filter(c => before.has(c)).length;
  const today = ymd(new Date());
  const fus = await DB.all(`SELECT b.id, b.start_at, c.first_name, c.last_name FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
    WHERE b.kind = 'followup' AND substr(b.start_at, 1, 10) >= ? ORDER BY b.start_at LIMIT 5`, [today]);
  const promos = await DB.all(`SELECT b.id, b.promo_kind, b.promo_value, b.promo_until, c.first_name, c.last_name FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
    WHERE b.promo_kind IS NOT NULL AND b.promo_until >= ? ORDER BY b.promo_until`, [today]);
  // Per month, for the chart
  const months = {}; for (const r of rows) { const k = r.start_at.slice(0, 7); (months[k] ||= { paid: 0, mins: 0, n: 0 }); months[k].paid += r.paid || 0; months[k].mins += r.time_min || 0; months[k].n++; }
  const keys = Object.keys(months).sort().slice(-12), maxP = Math.max(1, ...keys.map(k => months[k].paid));
  const count = (f) => { const m = {}; for (const r of rows) { const k = f(r); if (k) m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((p, q) => q[1] - p[1]).slice(0, 5); };
  const days = count(r => new Date(r.start_at.slice(0, 10) + 'T00:00').toLocaleDateString(undefined, { weekday: 'long' }));
  const places = count(r => (r.placement || '').replace(/^(left|right)\s+/i, '').trim().replace(/^./, c => c.toUpperCase()));
  const kpi = (v, l, tip) => `<div class="kpi" ${tip ? `data-tip="${esc(tip)}"` : ''}><b>${v}</b><span>${l}</span></div>`;
  el.innerHTML = !n ? `<div class="card empty"><div class="empty-ico">${ICON.quote}</div><div style="font:24px var(--display)">No completed tattoos ${STATS.period === 'all' ? 'yet' : 'in this period'}</div>
      <div class="muted">Open a tattoo booking, switch on <b>Tattoo completed</b> and add what was paid and how long it took.</div></div>` : `
    <div class="kpis">
      ${kpi(n, 'tattoos')}${kpi(fmtH(hours), 'tattooed')}${kpi(money(paid), 'earned')}
      ${kpi(money(n ? Math.round(paid / n) : 0), 'average tattoo')}${kpi(hours ? money(Math.round(paid / hours)) : '—', 'per hour', 'Earned divided by hours tattooed')}
      ${kpi(n ? fmtH(hours / n) : '—', 'average session')}${kpi(clients.size, 'clients')}${kpi(`${clients.size - returning} / ${returning}`, 'new / returning', 'Returning clients had a completed tattoo before this period')}
    </div>
    ${keys.length > 1 ? `<div class="card"><h2>Earnings by month</h2>
      <div class="bars">${keys.map(k => `<div class="bar" data-tip="${esc(money(months[k].paid))} · ${fmtH(months[k].mins / 60)} · ${months[k].n} tattoo${months[k].n > 1 ? 's' : ''}">
        <i style="height:${Math.max(3, months[k].paid / maxP * 100)}%"></i><span>${new Date(k + '-01T00:00').toLocaleDateString(undefined, { month: 'short' })}</span></div>`).join('')}</div></div>` : ''}
    <div class="grid st-two">
      <div class="card"><h2>Busiest days</h2>${days.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><span>${v}</span></div>`).join('') || '<p class="muted">—</p>'}</div>
      <div class="card"><h2>Top placements</h2>${places.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><span>${v}</span></div>`).join('') || '<p class="muted">—</p>'}</div>
    </div>
    <div class="card"><h2>Tattoos (${n})</h2><div class="st-table"><table>
      <thead><tr><th>Date</th><th>Client</th><th>Tattoo</th><th>Time</th><th>Paid</th></tr></thead>
      <tbody>${rows.slice().reverse().map(r => `<tr data-bk="${r.id}"><td>${esc(r.start_at.slice(0, 10))}</td><td>${esc(bName(r))}</td>
        <td>${esc([r.description, r.placement].filter(Boolean).join(' · ') || '—')}</td><td>${r.time_min != null ? fmtH(r.time_min / 60) : '—'}</td><td>${r.paid != null ? money(r.paid) : '—'}</td></tr>`).join('')}</tbody></table></div></div>`;
  $('#st-side').innerHTML = `
    <div class="card"><h2>Follow-ups coming up</h2>${fus.map(f => `<a class="stat" href="#booking-edit/${f.id}"><span>${esc(bName(f))}</span><span>${esc(fmtDay(f.start_at))}</span></a>`).join('') || '<p class="muted" style="margin:0">None booked.</p>'}</div>
    <div class="card"><h2>Open promotions</h2>${promos.map(p => `<a class="stat" href="#booking-edit/${p.id}"><span>${esc(bName(p))}: ${p.promo_kind === 'pct' ? +p.promo_value + '%' : money(p.promo_value)} off</span><span>until ${esc(p.promo_until)}</span></a>`).join('') || '<p class="muted" style="margin:0">None open.</p>'}</div>`;
  el.querySelectorAll('[data-bk]').forEach(tr => tr.onclick = () => { location.hash = 'booking-edit/' + tr.dataset.bk; });
  const rg = $('#st-range'); if (rg) rg.textContent = STATS.period === 'all' ? 'All time' : `${a} to ${z}`;
}
async function statsCsv() {
  const rows = await statsRows();
  if (!rows.length) return toast('Nothing to export in this period.');
  const q = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const head = ['Date', 'Start', 'Client', 'Type', 'Tattoo', 'Placement', 'Size', 'Quote', 'Paid', 'Paid by', 'Hours tattooed', 'Deposit', 'Promotion', 'Promotion until'];
  const lines = rows.map(r => [r.start_at.slice(0, 10), r.start_at.slice(11, 16), bName(r), kindLabel(r), r.description, r.placement, r.size, r.quote, r.paid, r.pay_method,
    r.time_min != null ? +(r.time_min / 60).toFixed(2) : '', r.deposit, r.promo_kind ? (r.promo_kind === 'pct' ? r.promo_value + '%' : r.promo_value) : '', r.promo_until].map(q).join(','));
  // BOM so Excel reads the file as UTF-8.
  const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv' });
  const [a, z] = statsRange(), name = `InkForge-tattoos-${STATS.period === 'all' ? 'all' : a + '_to_' + z}.csv`;
  const file = new File([blob], name, { type: 'text/csv' });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Tattoo stats' });
    else { const el = document.createElement('a'); el.href = URL.createObjectURL(file); el.download = name; el.click(); setTimeout(() => URL.revokeObjectURL(el.href), 5000); toast('Spreadsheet saved.'); }
  } catch (e) { if (e.name !== 'AbortError') toast('Could not export: ' + e.message); }
}

/* ---------- Inventory & rules helpers ---------- */
const INV = { q: '' };
const fmtQty = (n) => +(+n).toFixed(2);

async function renderInventory() {
  const el = $('#inv-list'); if (!el) return;
  const like = '%' + INV.q.trim() + '%';
  const rows = await DB.all(`SELECT * FROM inventory_items WHERE name LIKE ?1 OR category LIKE ?1 OR supplier LIKE ?1
    ORDER BY (qty <= min_qty) DESC, category COLLATE NOCASE, name COLLATE NOCASE`, [like]);
  if ($('#inv-list') !== el) return;
  const low = rows.filter(r => r.qty <= r.min_qty);
  if (!rows.length) {
    el.innerHTML = INV.q ? '<div class="empty muted">No matches.</div>'
      : `<div class="empty"><div class="empty-ico">${ICON.stock}</div><div style="font:24px var(--display)">Nothing stocked yet</div><div class="muted">Tap + to add needles, ink, gloves…</div></div>`;
  } else {
    const row = (i) => `<a class="c-row inv-row ${i.qty <= i.min_qty ? 'low' : ''}" href="#inv-edit/${i.id}">
      <span class="c-main"><span class="c-n">${esc(i.name)}</span>
        <span class="muted c-sub">${esc([i.category, i.supplier].filter(Boolean).join(' · ') || ' ')}</span></span>
      <span class="stepper">
        <button class="mini" data-step="-1" data-id="${i.id}" aria-label="One less">−</button>
        <b>${fmtQty(i.qty)}<small>${esc(i.unit || '')}</small></b>
        <button class="mini" data-step="1" data-id="${i.id}" aria-label="One more">+</button></span></a>`;
    el.innerHTML = (low.length ? `<div class="letter" style="color:var(--red)">Running low (${low.length})</div><div class="card list">${low.map(row).join('')}</div>` : '')
      + (rows.length > low.length ? `<div class="letter">In stock</div><div class="card list">${rows.filter(r => r.qty > r.min_qty).map(row).join('')}</div>` : '');
  }
  const h = await DB.all(`SELECT t.id, t.taken_at, t.notes, count(l.take_id) AS n, sum(l.counted <> l.expected) AS diff
    FROM stock_takes t LEFT JOIN stock_take_lines l ON l.take_id = t.id GROUP BY t.id ORDER BY t.taken_at DESC LIMIT 5`);
  const he = $('#inv-hist');
  if (he) he.innerHTML = h.length ? `<div class="letter">Past stock takes</div><div class="card list">${h.map(t => `<div class="c-row"><span class="c-main">
      <span class="c-n">${new Date(t.taken_at + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      <span class="muted c-sub">${t.n} counted · ${t.diff || 0} adjusted${t.notes ? ' · ' + esc(t.notes) : ''}</span></span></div>`).join('')}</div>` : '';
}

async function renderRules() {
  const el = $('#r-list'); if (!el) return;
  const rs = await DB.all('SELECT * FROM rules ORDER BY sort, id');
  el.innerHTML = rs.length ? '<div class="card list">' + rs.map((r, i) => `
    <a class="c-row rule" href="#rule-edit/${r.id}"><span class="rule-n">${i + 1}</span>
      <span class="c-main"><span class="c-n">${esc(r.title)}</span>${r.body ? `<span class="muted rule-b">${esc(r.body)}</span>` : ''}</span>
      <span class="row" style="gap:4px;flex-wrap:nowrap"><button class="mini" data-mv="-1" data-id="${r.id}" ${i ? '' : 'disabled'} aria-label="Move up">&uarr;</button>
      <button class="mini" data-mv="1" data-id="${r.id}" ${i < rs.length - 1 ? '' : 'disabled'} aria-label="Move down">&darr;</button></span></a>`).join('') + '</div>'
    : `<div class="empty"><div class="empty-ico">${ICON.rules}</div><div style="font:24px var(--display)">No rules yet</div><div class="muted">Deposits, cancellations, touch-ups, age, guests…</div></div>`;
}

/* ---------- Reel UI (engine in reel.js) ---------- */
// The draft stays in memory while the app is open, so leaving the Reel screen loses nothing.
function reelChanged() { reelTimeline(); reelRender(); if (!R.quickDrag) reelQuick(); }

/* ---------- Quick slider under the timeline ----------
   The main timing control of whatever is selected, right by the timeline: a photo's length, a
   video's start and end, a card's duration or a transition's duration. Same values as the panel. */
function reelQuickSpec() {
  const p = R.pick, s = reelStyle();
  if (!p) return [];
  if (p.kind === 'clip') {
    const c = R.clips.find(x => x.id === p.key); if (!c) return [];
    return c.type === 'video'
      ? [['inP', 'Start', 0, c.srcDur, 0.1, c.inP], ['outP', 'End', 0, c.srcDur, 0.1, c.outP]]
      : [['dur', 'Length', 0.5, 8, 0.1, c.dur]];
  }
  if ((p.kind === 'intro' || p.kind === 'outro') && s[p.kind]) return [[p.kind + 'Dur', 'Duration', 0.8, 6, 0.1, +s[p.kind + 'Dur']]];
  if (p.kind === 'trans') {
    const tr = reelTrans(s, { key: p.key });
    return tr.type === 'cut' ? [] : [['tdur', 'Transition', 0.1, 1.2, 0.05, tr.dur]];
  }
  return [];
}
function reelQuick() {
  const el = $('#reel-quick'); if (!el) return;
  const spec = reelQuickSpec();
  el.hidden = !spec.length;
  el.innerHTML = spec.map(([k, l, min, max, step, v]) => `<label class="q-sl"><span>${l}</span>
    <input type="range" min="${min}" max="${(+max).toFixed(2)}" step="${step}" value="${v}" data-q="${k}"><b>${(+v).toFixed(k === 'tdur' ? 2 : 1)}s</b></label>`).join('');
}
function reelQuickBind(el) {
  el.addEventListener('input', (e) => {
    const k = e.target.dataset.q; if (!k) return;
    const v = +e.target.value, p = R.pick; R.quickDrag = true;
    if (p.kind === 'clip') {
      const c = R.clips.find(x => x.id === p.key); if (!c) return;
      c[k] = v;
      if (k === 'inP' && c.outP - c.inP < 0.5) c.outP = Math.min(c.srcDur, c.inP + 0.5);
      if (k === 'outP' && c.outP - c.inP < 0.5) c.inP = Math.max(0, c.outP - 0.5);
      const g = reelSegments().segs.find(x => x.key === c.id);
      if (g) reelShow(k === 'outP' ? g.start + g.dur - 0.05 : k === 'inP' ? g.start + 0.01 : g.start + Math.min(g.dur * 0.45, 0.6));
    } else if (k === 'tdur') {
      R.trans[p.key] = { ...reelTrans(reelStyle(), { key: p.key }), ...R.trans[p.key], dur: v };
    } else reelSetStyle(k, v);
    e.target.nextElementSibling.textContent = v.toFixed(k === 'tdur' ? 2 : 1) + 's';
    reelChanged();
  });
  // On release: refresh the panel so its own sliders show the new value; preview transitions.
  el.addEventListener('change', (e) => {
    R.quickDrag = false; reelPanel();
    if (e.target.dataset.q === 'tdur') reelPeekTransition(R.pick.key);
    else if (R.pick.kind === 'intro' || R.pick.kind === 'outro') reelShowCard(R.pick.kind);
  });
}

// The timeline under the preview is the main way around: tap a clip, card or transition and the
// Edit tab shows that item's settings. Style holds the shared look; Music the soundtrack.
const REEL_CLIP_TOOLS = [['trim', 'Trim'], ['look', 'Look'], ['frame', 'Frame'], ['text', 'Text'], ['stickers', 'Stickers'], ['arrange', 'Arrange']];
const REEL_STYLE_TABS = [['text', 'Text'], ['brand', 'Brand'], ['trans', 'Transitions'], ['export', 'Export']];
const REEL_TRANSITIONS = [['cut', 'Cut', 'Straight cut'], ['fade', 'Fade', 'Dip to black'], ['flash', 'Flash', 'White flash, good on the beat'],
  ['zoom', 'Zoom', 'Punch-in between clips'], ['wipe', 'Wipe', 'Before / after reveal, e.g. stencil to finished'], ['slide', 'Slide', 'Next clip pushes in from the side']];
const REEL_TR_ICON = { cut: '|', fade: '◐', flash: '✦', zoom: '⤢', wipe: '▧', slide: '⇥' };
const REEL_PPS = 34;   // timeline pixels per second
R.tool ||= 'trim'; R.stab ||= 'text';

/* ---------- Timeline ---------- */
function reelTimeline() {
  const el = $('#reel-tl'); if (!el) return;
  const s = reelStyle(), { segs, total } = reelSegments(), p = R.pick;
  const on = (kind, key) => p && p.kind === kind && String(p.key) === String(key) ? 'on' : '';
  let x = 0, blocks = '', marks = '';
  segs.forEach((g, i) => {
    const w = Math.max(26, g.dur * REEL_PPS);
    if (g.kind === 'clip') {
      const c = g.clip;
      blocks += `<button class="tl-b tl-clip ${on('clip', c.id)}" data-pk="clip" data-key="${c.id}" style="width:${w}px;background-image:url('${c.thumb || ''}')" aria-label="Clip ${i}">
        <span>${g.dur.toFixed(1)}s</span></button>`;
    } else blocks += `<button class="tl-b tl-card ${on(g.kind, g.kind)}" data-pk="${g.kind}" data-key="${g.kind}" style="width:${w}px">${g.kind === 'intro' ? 'Intro' : 'Outro'}</button>`;
    x += w;
    const next = segs[i + 1];
    if (next) {
      const tr = reelTrans(s, next), own = !!R.trans[next.key];
      marks += `<button class="tl-tr ${own ? 'own' : ''} ${on('trans', next.key)}" data-pk="trans" data-key="${next.key}" style="left:${x}px"
        aria-label="Transition: ${tr.type}">${REEL_TR_ICON[tr.type] || '·'}</button>`;
    }
  });
  el.innerHTML = `<div class="tl-track" id="tl-track">
      ${s.intro ? '' : '<button class="tl-ghost" data-pk="add-intro">+ Intro</button>'}
      <div class="tl-row" id="tl-row">${blocks}${marks}<i class="tl-head" id="tl-head"></i></div>
      <label class="tl-ghost tl-add" data-tip="Add photos or videos">+<input type="file" accept="image/*,video/*" multiple hidden id="reel-file"></label>
      <button class="tl-ghost tl-add" id="reel-pf" data-tip="Add from your portfolio">${ICON.portfolio}</button>
      ${s.outro ? '' : '<button class="tl-ghost" data-pk="add-outro">+ Outro</button>'}
    </div>`;
  el.dataset.total = total;
  $('#reel-file').addEventListener('change', async (e) => {
    const files = [...e.target.files], before = R.clips.length;
    for (const f of files) { try { await reelAddFile(f); } catch (err) { toast(`Skipped ${f.name}: ${err.message}`); } }
    if (R.tplId) reelTplRecipe(before);   // new clips take the template's settings for their position
    const c = R.clips[R.clips.length - 1];
    if (c) reelPick('clip', c.id); else reelChanged();
  });
  $('#reel-pf').onclick = reelPortfolioPicker;
  el.onclick = (e) => {
    const b = e.target.closest('[data-pk]'); if (!b) return;
    const k = b.dataset.pk;
    if (k === 'add-intro' || k === 'add-outro') { const w = k.slice(4); reelSetStyle(w, true); reelPick(w, w); return; }
    reelPick(k, k === 'clip' ? +b.dataset.key : b.dataset.key);
  };
  reelTlHead();
}
// Moves the playhead line; while playing, keeps it in view.
function reelTlHead() {
  const h = $('#tl-head'), row = $('#tl-row'); if (!h || !row) return;
  // Blocks have a minimum width, so map time to position block by block rather than t * PPS.
  const { segs } = reelSegments(); let x = 0;
  for (const g of segs) {
    const w = Math.max(26, g.dur * REEL_PPS);
    if (R.t < g.start + g.dur || g === segs[segs.length - 1]) { x += Math.min(1, (R.t - g.start) / g.dur) * w; break; }
    x += w;
  }
  h.style.left = x + 'px';
  if (R.playing) { const tl = $('#reel-tl'); if (x < tl.scrollLeft + 20 || x > tl.scrollLeft + tl.clientWidth - 40) tl.scrollLeft = x - 60; }
}
/* ---------- Drag, resize and snap layers on the preview ----------
   One finger on a layer moves it; on its corner dot (or two fingers) resizes it, keeping its
   proportions. While moving, its centre and edges snap to the frame centre and to other layers. */
function reelCanvasBind(cv) {
  const ctx = cv.getContext('2d'), pts = new Map();
  let drag = null;   // { o, mode: 'move'|'scale', sx, sy, box, pos, d0 }
  const toCv = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height, k: cv.width / r.width }; };
  // Read and write a layer's normalised position { x, y, s }.
  const getPos = (o) => o.kind === 'cap' ? o.clip.cap || { x: o.box.cx / cv.width, y: o.box.cy / cv.height, s: 1 }
    : o.kind === 'stk' ? o.clip.stickers[o.i] : reelStyle()[o.card + 'Pos'] || { x: o.box.cx / cv.width, y: o.box.cy / cv.height, s: 1 };
  const setPos = (o, p) => {
    if (o.kind === 'cap') o.clip.cap = { x: p.x, y: p.y, s: p.s };
    else if (o.kind === 'stk') Object.assign(o.clip.stickers[o.i], { x: p.x, y: p.y, s: p.s });
    else {   // card text lives in the saved style: update the cache now, write to the database on release
      const st = reelStyle(); st[o.card + 'Pos'] = { x: p.x, y: p.y, s: p.s };
      Settings.cache.reel_style = JSON.stringify(st);
    }
  };
  // Opens the panel that belongs to a layer, so its controls are right there.
  const openFor = (o, seg) => {
    if (o.kind === 'card') { if (R.pick?.kind !== o.card) reelPick(o.card, o.card); return; }
    const want = o.kind === 'cap' ? 'text' : 'stickers';
    if (R.pick?.kind !== 'clip' || R.pick.key !== seg.key || R.tool !== want) { R.tool = want; reelPick('clip', seg.key); }
    else reelPanel();
  };
  cv.addEventListener('pointerdown', (e) => {
    if (R.recording) return;
    try { cv.setPointerCapture(e.pointerId); } catch {}
    const p = toCv(e); pts.set(e.pointerId, p);
    if (R.playing) reelPause();
    const { seg, list } = reelLayers(ctx, cv.width, cv.height);
    if (pts.size === 2 && drag) {   // second finger: pinch the current layer
      const [a, b] = [...pts.values()];
      drag = { ...drag, mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), pos: { ...getPos(drag.o) } };
      return;
    }
    const sel = list.find(x => x.id === R.layer);
    const hk = 22 * p.k;
    if (sel && Math.hypot(p.x - (sel.box.cx + sel.box.w / 2 + 6 * p.k), p.y - (sel.box.cy + sel.box.h / 2 + 6 * p.k)) < hk) {
      drag = { o: sel, mode: 'scale', pos: { ...getPos(sel) }, d0: Math.hypot(p.x - sel.box.cx, p.y - sel.box.cy) };
      return;
    }
    const hit = [...list].reverse().find(o => Math.abs(p.x - o.box.cx) <= o.box.w / 2 + 8 * p.k && Math.abs(p.y - o.box.cy) <= o.box.h / 2 + 8 * p.k);
    if (!hit) { drag = null; if (R.layer) { R.layer = null; reelRender(); } return; }
    R.layer = hit.id; R.dragging = true;
    drag = { o: hit, mode: 'move', sx: p.x, sy: p.y, box: { ...hit.box }, pos: { ...getPos(hit) }, others: list.filter(o => o.id !== hit.id) };
    openFor(hit, seg);
    reelRender();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag || !pts.has(e.pointerId)) return;
    const p = toCv(e); pts.set(e.pointerId, p);
    const W = cv.width, H = cv.height, o = drag.o;
    if (drag.mode === 'pinch' && pts.size > 1) {
      const [a, b] = [...pts.values()];
      setPos(o, { ...drag.pos, s: Math.max(0.3, Math.min(4, drag.pos.s * Math.hypot(a.x - b.x, a.y - b.y) / drag.d0)) });
    } else if (drag.mode === 'scale') {
      const c = { x: drag.pos.x * W, y: drag.pos.y * H };
      setPos(o, { ...drag.pos, s: Math.max(0.3, Math.min(4, drag.pos.s * Math.hypot(p.x - c.x, p.y - c.y) / drag.d0)) });
    } else if (drag.mode === 'move') {
      let cx = drag.box.cx + p.x - drag.sx, cy = drag.box.cy + p.y - drag.sy;
      const hw = drag.box.w / 2, hh = drag.box.h / 2, th = 10 * p.k, guides = [];
      // Candidate lines: frame centre, plus every other layer's centre and edges.
      const xs = [W / 2], ys = [H / 2];
      for (const q of drag.others) { xs.push(q.box.cx, q.box.cx - q.box.w / 2, q.box.cx + q.box.w / 2); ys.push(q.box.cy, q.box.cy - q.box.h / 2, q.box.cy + q.box.h / 2); }
      const snap = (v, half, lines) => {
        for (const L of lines) for (const off of [0, -half, half]) if (Math.abs(v + off - L) < th) return [L - off, L];
        return [v, null];
      };
      let gx, gy;
      [cx, gx] = snap(cx, hw, xs); [cy, gy] = snap(cy, hh, ys);
      if (gx != null) guides.push({ x: gx }); if (gy != null) guides.push({ y: gy });
      R.guides = guides;
      setPos(o, { ...drag.pos, x: cx / W, y: cy / H });
    }
    reelRender();
    if (R.tool === 'text' && o.kind === 'cap') { const b = document.querySelector('[data-cs]'); if (b) { const s = getPos(o).s; b.value = s; b.closest('.slider').querySelector('b').textContent = Math.round(s * 100) + '%'; } }
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    if (pts.size) { if (drag?.mode === 'pinch') drag = null; return; }
    if (drag?.o.kind === 'card') Settings.set('reel_style', Settings.cache.reel_style);
    if (drag?.o.kind === 'card' || drag?.o.kind === 'cap') reelPanel();   // enables the reset buttons
    drag = null; R.dragging = false; R.guides = []; reelRender();
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}

// Select a timeline item: jump the preview to it and open its settings in the Edit tab.
function reelPick(kind, key) {
  R.pick = { kind, key };
  const segs = reelSegments().segs;
  if (kind === 'clip') {
    R.sel = R.clips.findIndex(c => c.id === key);
    // A little way in, past any fade, so the preview shows the clip itself.
    const g = segs.find(x => x.key === key); if (g) reelShow(g.start + Math.min(g.dur * 0.45, 0.6));
  } else if (kind === 'intro' || kind === 'outro') reelShowCard(kind);
  else { const g = segs.find(x => x.key === key); if (g) reelShow(Math.max(0, g.start - 0.05)); }
  R.tab = 'edit';
  $('#reel-tabs')?.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.t === 'edit'));
  reelTimeline(); reelPanel();
}

const reelSeg = (key, cur, opts, attr = 'data-v') => `<div class="seg" data-seg="${key}" style="margin-bottom:12px">${opts.map(([v, l]) =>
  `<button ${attr}="${v}" class="${String(cur) === String(v) ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}</div>`;
const reelSlider = (attr, key, label, min, max, step, val, shown) =>
  `<label class="slider"><span>${label}<b>${shown}</b></span><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" ${attr}="${key}"></label>`;

// Jump the paused preview to a moment, e.g. the card being edited, so changes show at once.
function reelShow(t) { if (R.playing) reelPause(); R.t = Math.max(0, t); reelSyncVideos(R.t, false); reelRender(); }
function reelShowCard(kind) {
  const seg = reelSegments().segs.find(x => x.kind === kind);
  if (seg) reelShow(seg.start + Math.min(seg.dur - 0.05, 0.8));
}
// Play a short stretch around one boundary (default: the first) so a transition can be judged.
let reelPeekT = 0;
function reelPeekTransition(key) {
  const s = reelStyle(), { segs } = reelSegments();
  if (segs.length < 2) return toast('Add a clip to see the transition.');
  const g = segs.find(x => String(x.key) === String(key)) || segs[1];
  const d = reelTrans(s, g).dur;
  reelShow(g.start - d - 0.4); reelPlay();
  clearTimeout(reelPeekT); reelPeekT = setTimeout(() => { if (R.playing) reelPause(); }, (d + 1) * 1000);
}

async function reelPanel() {
  const el = $('#reel-panel'); if (!el) return;
  const s = reelStyle();
  // One set of named listeners for every panel; adding the same function again is a no-op.
  el.addEventListener('input', reelStyleInput);
  el.addEventListener('click', reelStyleClick);
  el.addEventListener('change', reelStyleChange);
  el.addEventListener('click', reelTplClick);
  if (!R.quickDrag) reelQuick();
  if (R.tab === 'edit') {
    const p = R.pick;
    const c = p?.kind === 'clip' ? R.clips.find(x => x.id === p.key) : null;
    const seg = p?.kind === 'trans' ? reelSegments().segs.find(x => String(x.key) === String(p.key)) : null;
    if (c) {
      R.sel = R.clips.indexOf(c);
      el.innerHTML = `<div class="reel-tools" id="reel-tools">${REEL_CLIP_TOOLS.map(([k, l]) => `<button data-tool="${k}" class="${R.tool === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="card reel-clip-ed">
          <div class="reel-clip-head"><b>${c.type === 'video' ? 'Video' : 'Photo'} ${R.sel + 1} of ${R.clips.length}</b>
            <button class="btn small danger" data-act="del">Remove clip</button></div>
          ${reelClipTool(c)}</div>`;
      $('#reel-tools').onclick = (e) => { const b = e.target.closest('[data-tool]'); if (!b) return; R.tool = b.dataset.tool; reelPanel(); };
      const ed = el.querySelector('.reel-clip-ed');
      reelClipBind(ed, c); if (R.tool === 'look') reelFilterThumbs(c);
    } else if (p && (p.kind === 'intro' || p.kind === 'outro') && s[p.kind]) {
      el.innerHTML = `<div class="card">${await reelCardPanel(s, p.kind)}</div>`;
    } else if (seg) {
      el.innerHTML = `<div class="card">${reelTransPanel(s, seg)}</div>`;
    } else {
      R.pick = null; reelQuick();
      el.innerHTML = `<div class="card reel-hint">${R.clips.length
        ? '<b>Tap the timeline to edit.</b><span class="muted">A clip opens its trim, look and text tools. A card opens its text and background. The small dots between them are transitions: each one can be different.</span>'
        : '<b>Add photos or videos to start.</b><span class="muted">Use the + at the end of the timeline above, or pick from your portfolio.</span>'}</div>`;
    }
  } else if (R.tab === 'tpl') {
    el.innerHTML = reelTplPanel();
  } else if (R.tab === 'style') {
    el.innerHTML = `<div class="reel-tools" id="reel-stabs">${REEL_STYLE_TABS.map(([k, l]) => `<button data-stab="${k}" class="${R.stab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="card">${await reelStyleSection(s)}</div>
      <p class="muted" style="font-size:12px;margin:6px 4px 0">Style is saved and reused on every reel, so your posts look consistent.</p>`;
    el.addEventListener('input', reelStyleInput);
    el.addEventListener('click', reelStyleClick);
    el.addEventListener('change', reelStyleChange);
  } else {
    const m = R.music, { total } = reelSegments();
    el.innerHTML = `<div class="card">
      ${m ? `<div class="row" style="flex-wrap:nowrap;margin-bottom:12px"><span class="ava">♪</span><b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</b>
          <button class="btn small danger" id="reel-mrm">Remove</button></div>
        <label class="slider"><span>Start song at ${help('Skip the intro of the song so the good part plays.')}<b>${m.offset.toFixed(1)}s</b></span>
          <input type="range" min="0" max="${Math.max(0, m.buffer.duration - Math.min(total, m.buffer.duration) - 0.1).toFixed(1)}" step="0.1" value="${m.offset}" data-m="offset"></label>
        <label class="slider"><span>Volume<b>${Math.round(m.vol * 100)}%</b></span>
          <input type="range" min="0" max="1" step="0.05" value="${m.vol}" data-m="vol"></label>
        <p class="muted" style="font-size:13px">Song: ${m.buffer.duration.toFixed(0)}s · Reel: ${total.toFixed(1)}s. Fades out at the end.</p>`
      : `<p class="muted" style="margin-top:0">Add a song or sound from this device. Use audio you have the rights to. Most social apps also let you add music after you upload.</p>`}
      <label class="btn ${m ? '' : 'primary'}" style="width:100%">${m ? 'Change sound' : 'Choose audio file'}<input type="file" accept="audio/*" hidden id="reel-mfile"></label>
    </div>`;
    $('#reel-mfile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const ctx = reelAudio();
        const buffer = await ctx.decodeAudioData(await f.arrayBuffer());
        R.music = { name: f.name, buffer, offset: 0, vol: 0.8 };
        reelPanel();
      } catch { toast('Could not read that audio file.'); }
    });
    const rm = $('#reel-mrm'); if (rm) rm.onclick = () => { reelPause(); R.music = null; reelPanel(); };
    el.addEventListener('input', reelMusicInput);
  }
}

function reelClipTool(c) {
  const video = c.type === 'video';
  if (R.tool === 'trim') return video ? `
      ${reelSlider('data-c', 'inP', `Start ${help('Where this video clip begins.')}`, 0, c.srcDur.toFixed(2), 0.1, c.inP, c.inP.toFixed(1) + 's')}
      ${reelSlider('data-c', 'outP', 'End', 0, c.srcDur.toFixed(2), 0.1, c.outP, c.outP.toFixed(1) + 's')}
      <div class="lbl">Speed ${help('Slow motion for detail shots, faster for time-lapses of the session.')}</div>
      ${reelSeg('speed', c.speed || 1, [[0.5, '0.5×'], [1, '1×'], [1.5, '1.5×'], [2, '2×'], [4, '4×']])}
      <label class="toggle" style="display:inline-flex"><input type="checkbox" data-c="sound" ${c.mute ? '' : 'checked'}><span>Clip sound</span></label>`
    : reelSlider('data-c', 'dur', 'Length', 0.5, 8, 0.1, c.dur, c.dur.toFixed(1) + 's');
  if (R.tool === 'look') return `<div class="fx-grid">${REEL_FILTERS.map(([k, l]) =>
      `<button class="fx ${(c.filter || 'none') === k ? 'on' : ''}" data-fx="${k}"><canvas width="54" height="96"></canvas><span>${l}</span></button>`).join('')}</div>`;
  if (R.tool === 'frame') return `
      <div class="lbl">Motion ${help('Slow zoom or pan keeps photos alive.')}</div>
      ${reelSeg('motion', c.motion, [['none', 'Still'], ['in', 'Zoom in'], ['out', 'Zoom out'], ['pan', 'Pan']])}
      <div class="lbl">Framing ${help('Fill crops to the full screen. Fit shows the whole image, over a soft blurred copy of itself or a plain black background.')}</div>
      ${reelSeg('fit', c.fit, [['cover', 'Fill'], ['blur', 'Fit + blur'], ['plain', 'Fit + black']])}
      <div class="row"><button class="btn small" data-act="rot">↻ Rotate</button><button class="btn small ${c.flip ? 'on' : ''}" data-act="flip">⇋ Mirror</button></div>`;
  if (R.tool === 'text') return `
      <label class="field"><span>Caption</span><input class="in" data-c="caption" value="${esc(c.caption)}" placeholder="e.g. Fine-line peony, healed"></label>
      ${c.caption ? `${reelSlider('data-cs', 's', 'Size', 0.4, 2.5, 0.05, c.cap?.s || 1, Math.round((c.cap?.s || 1) * 100) + '%')}
        <div class="row"><button class="btn small" data-act="capreset" ${c.cap ? '' : 'disabled'}>Reset position and size</button></div>` : ''}
      <p class="muted" style="font-size:12px;margin:10px 0 0">Drag the caption on the preview to move it; drag its corner dot to resize. It snaps to the centre and to stickers.</p>`;
  if (R.tool === 'stickers') {
    const list = c.stickers || [];
    return `
      <div class="stk-list">${list.map((st, i) => `<span class="stk ${R.layer === 'stk' + i ? 'on' : ''}" data-stk="${i}"><img src="${st.url}" alt="">
        <b data-stkdel="${i}" role="button" aria-label="Remove sticker">&times;</b></span>`).join('')}
        <label class="stk add" data-tip="Add a PNG (transparent background works best)">+<input type="file" accept="image/png,image/webp,image/*" multiple hidden data-stkfile></label></div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Stickers sit on this clip only. Drag on the preview to move; drag the corner dot (or pinch) to resize.</p>`;
  }
  const here = reelSegments().segs.find(x => x.clip === c);
  const canSplit = video && here && R.t > here.start + 0.3 && R.t < here.start + here.dur - 0.3;
  return `<div class="row">
      <button class="btn small" data-act="left" ${R.sel ? '' : 'disabled'}>◀ Move</button>
      <button class="btn small" data-act="right" ${R.sel < R.clips.length - 1 ? '' : 'disabled'}>Move ▶</button>
      <button class="btn small" data-act="dup" data-tip="Copy this clip with all its settings">Duplicate</button>
      ${video ? `<button class="btn small" data-act="split" ${canSplit ? '' : 'disabled'} data-tip="Cut the clip in two where the playhead is">Split</button>` : ''}
      <button class="btn small danger" data-act="del" style="margin-left:auto">Remove</button></div>
    ${video && !canSplit ? '<p class="muted" style="font-size:12px;margin:8px 0 0">To split, move the playhead inside this clip first.</p>' : ''}`;
}

// Filter previews: the clip's current frame drawn small with each look.
function reelFilterThumbs(c) {
  document.querySelectorAll('.fx').forEach(b => {
    const cv = b.querySelector('canvas'), x = cv.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 54, 96);
    drawMedia(x, { ...c, filter: b.dataset.fx, motion: 'none' }, 54, 96, 0);
  });
}

function reelClipBind(ed, c) {
  const el = $('#reel-panel');
  ed.addEventListener('input', (e) => {
    if (e.target.dataset.cs) {
      const L = capLayout($('#reel-cv').getContext('2d'), reelStyle(), c, PREVIEW_W, PREVIEW_H);
      c.cap = { x: L.cx / PREVIEW_W, y: L.cy / PREVIEW_H, ...c.cap, s: +e.target.value };
      e.target.closest('.slider').querySelector('b').textContent = Math.round(c.cap.s * 100) + '%';
      R.layer = 'cap'; return reelRender();
    }
    const k = e.target.dataset.c; if (!k) return;
    if (k === 'caption') c.caption = e.target.value;
    else if (k === 'sound') c.mute = !e.target.checked;
    else {
      c[k] = +e.target.value;
      if (k === 'inP' && c.outP - c.inP < 0.5) c.outP = Math.min(c.srcDur, c.inP + 0.5);
      if (k === 'outP' && c.outP - c.inP < 0.5) c.inP = Math.max(0, c.outP - 0.5);
      e.target.closest('.slider').querySelector('b').textContent = c[k].toFixed(1) + 's';
      const tile = el.querySelector(`.reel-clip[data-i="${R.sel}"] span`);
      if (tile) tile.textContent = clipDur(c).toFixed(1) + 's';
      if (k === 'inP' || k === 'outP') { const seg = reelSegments().segs.find(x => x.clip === c); if (seg) reelShow(seg.start + (k === 'outP' ? seg.dur - 0.05 : 0.01)); }
    }
    reelChanged();
  });
  ed.addEventListener('change', async (e) => {
    if (e.target.dataset.c === 'inP' || e.target.dataset.c === 'outP') reelPanel();
    if (e.target.dataset.c === 'caption' && R.tool === 'text') reelPanel();   // show size controls once there is text
    if (e.target.hasAttribute('data-stkfile')) {
      // Stickers stay in memory with the draft, like the clips themselves.
      c.stickers ||= [];
      for (const f of e.target.files) {
        const url = URL.createObjectURL(f), img = new Image(); img.src = url;
        try { await img.decode(); } catch { toast(`Could not read ${f.name}.`); continue; }
        c.stickers.push({ url, img, x: 0.5, y: 0.4, s: 1 });
      }
      R.layer = 'stk' + (c.stickers.length - 1); reelRender(); reelPanel();
    }
  });
  ed.addEventListener('click', (e) => {
    const sd = e.target.closest('[data-stkdel]');
    if (sd) { const [gone] = c.stickers.splice(+sd.dataset.stkdel, 1);
      if (!R.clips.some(x => x.stickers?.some(o => o.url === gone.url))) URL.revokeObjectURL(gone.url);
      R.layer = null; reelRender(); return reelPanel(); }
    const sk = e.target.closest('[data-stk]');
    if (sk) { R.layer = 'stk' + sk.dataset.stk; reelRender(); return reelPanel(); }
    const sb = e.target.closest('[data-seg] button');
    if (sb) {
      const k = sb.parentElement.dataset.seg;
      c[k] = k === 'speed' ? +sb.dataset.v : sb.dataset.v;
      sb.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === sb));
      if (k === 'speed') { const tile = el.querySelector(`.reel-clip[data-i="${R.sel}"] span`); if (tile) tile.textContent = clipDur(c).toFixed(1) + 's'; }
      reelChanged(); return;
    }
    const fx = e.target.closest('[data-fx]');
    if (fx) { c.filter = fx.dataset.fx; ed.querySelectorAll('.fx').forEach(x => x.classList.toggle('on', x === fx)); reelChanged(); return; }
    const a = e.target.closest('[data-act]'); if (!a || a.disabled) return;
    const i = R.sel, act = a.dataset.act;
    if (act === 'rot') { c.rot = ((c.rot || 0) + 90) % 360; reelChanged(); return; }
    if (act === 'flip') { c.flip = !c.flip; a.classList.toggle('on', c.flip); reelChanged(); return; }
    if (act === 'capreset') { delete c.cap; R.layer = 'cap'; reelRender(); return reelPanel(); }
    if (act === 'del') return reelRemoveClip(i);
    let pick = c;
    // Copies get their own caption position and sticker list, so moving one never moves the other.
    const copy = (extra) => ({ ...c, id: ++R.seq, cap: c.cap && { ...c.cap }, stickers: (c.stickers || []).map(o => ({ ...o })), ...extra });
    if (act === 'dup') {
      pick = copy(); R.clips.splice(i + 1, 0, pick);
    } else if (act === 'split') {
      const seg = reelSegments().segs.find(x => x.clip === c);
      const cut = c.inP + (R.t - seg.start) * (c.speed || 1);
      pick = copy({ inP: cut }); R.clips.splice(i + 1, 0, pick); c.outP = cut;
      toast('Clip split.');
    } else { const j = act === 'left' ? i - 1 : i + 1; [R.clips[i], R.clips[j]] = [R.clips[j], R.clips[i]]; }
    R.t = Math.min(R.t, reelSegments().total);
    reelPick('clip', pick.id);
  });
}

// Removes a clip from the draft only; the original photo or video on the device is untouched.
function reelRemoveClip(i) {
  const [gone] = R.clips.splice(i, 1); if (!gone) return;
  // Split/duplicated clips share the media; only release it when no clip uses it any more.
  if (!R.clips.some(x => x.url === gone.url)) { if (gone.type === 'video') gone.el.pause(); URL.revokeObjectURL(gone.url); }
  delete R.trans[gone.id];
  R.sel = Math.min(i, R.clips.length - 1);
  R.t = Math.min(R.t, reelSegments().total);
  const next = R.clips[R.sel];
  if (next) reelPick('clip', next.id); else { R.pick = null; reelChanged(); reelPanel(); }
}

// Intro / outro card: opened by tapping it in the timeline.
async function reelCardPanel(s, kind) {
  const intro = kind === 'intro', bgKey = intro ? 'introBg' : 'outroBg', bg = s[bgKey];
  const bgUrl = bg.ref ? await Media.url(bg.ref) : '';
  const hasLogo = !!reelLogoRef(s);
  return `
    <div class="reel-clip-head"><b>${intro ? 'Intro' : 'Outro'} card</b>
      <button class="btn small danger" data-cardoff="${kind}" data-tip="Take this card out of the reel. Add it back with + ${intro ? 'Intro' : 'Outro'} on the timeline.">Remove card</button></div>
    ${intro ? `<label class="field"><span>Name on intro</span><input class="in" data-s="title" value="${esc(s.title)}" placeholder="${esc(Settings.get('studio_name') || 'Studio name')}"></label>`
      : `<label class="field"><span>Outro text</span><input class="in" data-s="outroText" value="${esc(s.outroText)}"></label>`}
    ${reelSlider('data-s', kind + 'Dur', 'Duration', 0.8, 6, 0.1, s[kind + 'Dur'], (+s[kind + 'Dur']).toFixed(1) + 's')}
    <label class="toggle" style="display:inline-flex;margin-bottom:12px" data-tip="Your studio logo above the text on both cards"><input type="checkbox" data-s="cardLogo" ${s.cardLogo ? 'checked' : ''}><span>Show logo</span></label>
    ${hasLogo ? '' : '<p class="muted" style="font-size:12px;margin:-4px 0 12px">Add your studio logo in More › Settings to use it here.</p>'}
    <div class="row" style="margin-bottom:12px"><button class="btn small" data-cardpos="${kind}" ${s[kind + 'Pos'] ? '' : 'disabled'}>Reset text position and size</button></div>
    <p class="muted" style="font-size:12px;margin:-4px 0 12px">Drag the card text on the preview to move it; drag its corner dot to resize.</p>
    <div class="lbl">Background image ${help('A photo of your studio or a tattoo behind the card text. Lower the opacity so the text stays readable.')}</div>
    <div class="row" style="margin-bottom:12px;flex-wrap:nowrap">
      <span class="bg-thumb">${bgUrl ? `<img src="${bgUrl}" alt="">` : ''}</span>
      <label class="btn small">${bg.ref ? 'Change' : 'Choose image'}<input type="file" accept="image/*" hidden data-bgfile="${bgKey}"></label>
      ${bg.ref ? `<button class="btn small danger" data-bgact="remove" data-bg="${bgKey}">Remove</button>` : ''}
    </div>
    ${bg.ref ? `
      ${reelSlider('data-bgk', 'op', 'Opacity', 0.05, 1, 0.05, bg.op, Math.round(bg.op * 100) + '%').replace('data-bgk', `data-bg="${bgKey}" data-bgk`)}
      ${reelSlider('data-bgk', 'zoom', 'Zoom', 1, 3, 0.05, bg.zoom, bg.zoom.toFixed(2) + '×').replace('data-bgk', `data-bg="${bgKey}" data-bgk`)}
      <div class="row"><button class="btn small" data-bgact="rot" data-bg="${bgKey}">↻ Rotate</button>
        <button class="btn small ${bg.flip ? 'on' : ''}" data-bgact="flip" data-bg="${bgKey}">⇋ Mirror</button></div>` : ''}
    <p class="muted" style="font-size:12px;margin:12px 0 0">Card text and background are saved in your style and reused on every reel.</p>`;
}

// One boundary's transition, opened by tapping its dot in the timeline. Changes apply to this
// boundary only; "Use for all" makes it the default and clears every other override.
function reelTransPanel(s, seg) {
  const { segs } = reelSegments(), prev = segs[segs.findIndex(x => x.key === seg.key) - 1];
  const name = (g) => g.kind === 'clip' ? `${g.clip.type === 'video' ? 'Video' : 'Photo'} ${R.clips.indexOf(g.clip) + 1}` : g.kind === 'intro' ? 'Intro' : 'Outro';
  const tr = reelTrans(s, seg), own = !!R.trans[seg.key];
  return `
    <div class="reel-clip-head"><b>${name(prev)} → ${name(seg)}</b><span class="chip">${own ? 'Custom' : 'Default'}</span></div>
    <div class="tr-grid" style="margin-bottom:12px">${REEL_TRANSITIONS.map(([k, l, d]) =>
      `<button data-tt="${k}" class="tr ${tr.type === k ? 'on' : ''}"><b>${REEL_TR_ICON[k]} ${l}</b><span>${d}</span></button>`).join('')}</div>
    ${REEL_TR_VARIANTS[tr.type] ? `<div class="lbl">${tr.type === 'wipe' || tr.type === 'slide' ? 'Comes in from' : 'Version'}</div>
      <div class="seg ${REEL_TR_VARIANTS[tr.type].length > 2 ? 'dir4' : ''}" style="margin-bottom:12px">${REEL_TR_VARIANTS[tr.type].map(([v, l]) =>
        `<button data-td="${v}" class="${trVariant(tr) === v ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}</div>` : ''}
    ${tr.type !== 'cut' ? reelSlider('data-tdur', '1', 'Duration', 0.1, 1.2, 0.05, tr.dur, tr.dur.toFixed(2) + 's') : ''}
    <div class="row" style="margin-top:4px">
      <button class="btn small" data-tall data-tip="Make this the transition between every clip">Use for all</button>
      ${own ? '<button class="btn small" data-treset data-tip="Go back to the default from Style › Transitions">Reset to default</button>' : ''}
      <button class="btn small primary" data-tpeek style="margin-left:auto">▶ Preview</button>
    </div>`;
}

async function reelStyleSection(s) {
  const swatches = (k) => `<span class="ink-dots" data-sw="${k}">${REEL_COLORS.map(c => `<button class="ink ${s[k] === c ? 'on' : ''}" data-v="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</span>`;
  const seg = (k, opts) => `<div class="seg" data-st="${k}" style="margin-bottom:12px">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(s[k]) === String(v) ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}</div>`;
  const hasLogo = !!reelLogoRef(s);
  const noLogo = '<p class="muted" style="font-size:12px;margin:-4px 0 12px">Add your studio logo in More › Settings to use it here.</p>';
  if (R.stab === 'text') return `
      <div class="lbl">Font</div>${seg('font', [['display', 'Tattoo'], ['clean', 'Clean']])}
      <div class="lbl">Caption position</div>${seg('captionPos', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']])}
      <div class="lbl">Caption size</div>${seg('capSize', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']])}
      <div class="row" style="margin-bottom:12px"><span class="lbl" style="margin:0;width:70px">Text</span>${swatches('color')}</div>
      <div class="row"><span class="lbl" style="margin:0;width:70px">Accent</span>${swatches('accent')}</div>`;
  if (R.stab === 'brand') {
    const lu = s.logoRef ? await Media.url(s.logoRef) : '';
    return `
      <label class="field"><span>Handle</span><input class="in" data-s="handle" value="${esc(s.handle)}" placeholder="@yourhandle" autocapitalize="off"></label>
      <div class="lbl">Logo ${help('Uses your studio logo from Settings, unless you pick a different one for this style, e.g. for another artist\'s template.')}</div>
      <div class="row" style="margin-bottom:12px;flex-wrap:nowrap">
        <span class="logo-box">${lu ? `<img src="${lu}" alt="">` : '<span class="muted">Studio</span>'}</span>
        <label class="btn small">${s.logoRef ? 'Change' : 'Use a different logo'}<input type="file" accept="image/png,image/*" hidden data-logofile></label>
        ${s.logoRef ? '<button class="btn small" data-logoclear>Use studio logo</button>' : ''}
      </div>
      <div class="lbl">Watermark ${help('Shown in a corner of every clip so reposts still point back to you.')}</div>
      ${seg('wmMode', [['off', 'Off'], ['text', 'Handle'], ['logo', 'Logo']])}
      ${s.wmMode === 'logo' && !hasLogo ? noLogo : ''}
      <div class="lbl">Corner</div>${seg('wmPos', [['tl', '↖ Top left'], ['tr', 'Top right ↗'], ['bl', '↙ Bottom left'], ['br', 'Bottom right ↘']])}
      ${reelSlider('data-s', 'wmOp', 'Opacity', 0.2, 1, 0.05, s.wmOp, Math.round(s.wmOp * 100) + '%')}`;
  }
  if (R.stab === 'trans') {
    const custom = Object.keys(R.trans).length;
    return `<p class="muted" style="font-size:13px;margin:0 0 12px">The default for every transition. To change just one, tap its dot on the timeline.</p>
      <div class="tr-grid" data-st="transition" style="margin-bottom:12px">${REEL_TRANSITIONS.map(([k, l, d]) =>
      `<button data-v="${k}" class="tr ${s.transition === k ? 'on' : ''}"><b>${REEL_TR_ICON[k]} ${l}</b><span>${d}</span></button>`).join('')}</div>
      ${REEL_TR_VARIANTS[s.transition] ? `<div class="lbl">${s.transition === 'wipe' || s.transition === 'slide' ? 'Comes in from' : 'Version'}</div>
        <div class="seg ${REEL_TR_VARIANTS[s.transition].length > 2 ? 'dir4' : ''}" data-st="transDir" style="margin-bottom:12px">${REEL_TR_VARIANTS[s.transition].map(([v, l]) =>
          `<button data-v="${v}" class="${trVariant({ type: s.transition, dir: s.transDir }) === v ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}</div>` : ''}
      ${s.transition !== 'cut' ? reelSlider('data-s', 'transDur', `Duration ${help('How long each transition takes. Short feels snappy, long feels smooth.')}`, 0.1, 1.2, 0.05, s.transDur, (+s.transDur).toFixed(2) + 's') : ''}
      ${custom ? `<button class="btn small" data-tclear style="margin-top:6px">Reset ${custom} custom transition${custom > 1 ? 's' : ''} to this</button>` : ''}`;
  }
  return `<div class="lbl">Export quality ${help('1080p looks sharper but makes bigger files and is heavier on older phones.')}</div>${seg('quality', [['720', '720p'], ['1080', '1080p']])}`;
}

function reelMusicInput(e) {
  const k = e.target.dataset.m; if (!k || !R.music) return;
  R.music[k] = +e.target.value;
  e.target.closest('.slider').querySelector('b').textContent = k === 'vol' ? Math.round(R.music.vol * 100) + '%' : R.music.offset.toFixed(1) + 's';
  if (R.playing) reelMusicStart(R.t);
}
// Panel listeners are named functions: #reel-panel survives re-renders, and re-adding the same
// function reference is a no-op, so they never stack up. Each only reacts to its own data- attributes.
function reelStyleInput(e) {
  const t = e.target;
  if (t.dataset.tdur && R.pick?.kind === 'trans') {
    const key = R.pick.key, v = +t.value;
    R.trans[key] = { ...R.trans[key], type: reelTrans(reelStyle(), { key }).type, dur: v };
    t.closest('.slider').querySelector('b').textContent = v.toFixed(2) + 's';
    return reelTimeline();
  }
  if (t.dataset.bgk) {
    const s = reelStyle(), bg = { ...s[t.dataset.bg], [t.dataset.bgk]: +t.value };
    reelSetStyle(t.dataset.bg, bg);
    t.closest('.slider').querySelector('b').textContent = t.dataset.bgk === 'op' ? Math.round(bg.op * 100) + '%' : bg.zoom.toFixed(2) + '×';
    return reelShowCard(t.dataset.bg === 'introBg' ? 'intro' : 'outro');
  }
  const k = t.dataset.s; if (!k) return;
  const v = t.type === 'checkbox' ? t.checked : t.type === 'range' ? +t.value : t.value;
  reelSetStyle(k, v);
  if (t.type === 'range') t.closest('.slider').querySelector('b').textContent =
    k === 'transDur' ? v.toFixed(2) + 's' : /Dur$/.test(k) ? v.toFixed(1) + 's' : Math.round(v * 100) + '%';
  if (/^(intro|outro)Dur$/.test(k)) return reelChanged();
  if (R.pick && (R.pick.kind === 'intro' || R.pick.kind === 'outro')) reelShowCard(R.pick.kind);
  else reelChanged();
}
async function reelStyleClick(e) {
  const t = e.target;
  const tab = t.closest('[data-stab]');
  if (tab) { R.stab = tab.dataset.stab; return reelPanel(); }
  // Per-boundary transition panel
  if (R.pick?.kind === 'trans') {
    const key = R.pick.key, cur = reelTrans(reelStyle(), { key });
    const tt = t.closest('[data-tt]'), td = t.closest('[data-td]');
    if (tt || td) {
      R.trans[key] = { type: cur.type, dir: cur.dir, dur: cur.dur, ...R.trans[key], ...(tt ? { type: tt.dataset.tt } : { dir: td.dataset.td }) };
      reelChanged(); await reelPanel(); return reelPeekTransition(key);
    }
    if (t.closest('[data-tall]')) {
      reelSetStyle('transition', cur.type); reelSetStyle('transDir', cur.dir); reelSetStyle('transDur', cur.dur);
      R.trans = {}; toast('Used for every transition.'); reelChanged(); return reelPanel();
    }
    if (t.closest('[data-treset]')) { delete R.trans[key]; reelChanged(); await reelPanel(); return reelPeekTransition(key); }
    if (t.closest('[data-tpeek]')) return reelPeekTransition(key);
  }
  if (t.closest('[data-tclear]')) { R.trans = {}; reelChanged(); return reelPanel(); }
  if (t.closest('[data-logoclear]')) {
    const old = reelStyle().logoRef; reelSetStyle('logoRef', ''); await Media.release(old); reelRender(); return reelPanel();
  }
  const cp = t.closest('[data-cardpos]');
  if (cp) { reelSetStyle(cp.dataset.cardpos + 'Pos', null); reelPanel(); return reelShowCard(cp.dataset.cardpos); }
  const off = t.closest('[data-cardoff]');
  if (off) { reelSetStyle(off.dataset.cardoff, false); R.pick = null; reelChanged(); return reelPanel(); }
  const act = t.closest('[data-bgact]');
  if (act) {
    const key = act.dataset.bg, s = reelStyle(), bg = { ...s[key] };
    if (act.dataset.bgact === 'remove') { const old = bg.ref; reelSetStyle(key, { ...REEL_CARD_BG }); await Media.release(old); }
    else if (act.dataset.bgact === 'rot') reelSetStyle(key, { ...bg, rot: ((bg.rot || 0) + 90) % 360 });
    else reelSetStyle(key, { ...bg, flip: !bg.flip });
    reelPanel(); reelShowCard(key === 'introBg' ? 'intro' : 'outro'); return;
  }
  const b = t.closest('[data-st] button, [data-sw] .ink'); if (!b) return;
  const box = b.closest('[data-st], [data-sw]'), k = box.dataset.st || box.dataset.sw;
  reelSetStyle(k, b.dataset.v);
  box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  if (k === 'quality') return;
  if (k === 'transition') { reelChanged(); await reelPanel(); return reelPeekTransition(); }
  if (k === 'transDir') { reelChanged(); return reelPeekTransition(); }
  if (k === 'wmMode') reelPanel();
  reelRender();
}
async function reelStyleChange(e) {
  if (e.target.hasAttribute('data-tpl-import')) { const f = e.target.files[0]; e.target.value = ''; return f && reelTplImport(f); }
  if (e.target.dataset.s === 'transDur') return reelPeekTransition();   // preview once the finger lifts
  if (e.target.dataset.tdur && R.pick?.kind === 'trans') return reelPeekTransition(R.pick.key);
  if (e.target.hasAttribute('data-logofile')) {
    const f = e.target.files[0]; if (!f) return;
    try {
      const ref = await Media.save(await pngBlob(f, 1000), 'png'), old = reelStyle().logoRef;
      reelSetStyle('logoRef', ref);
      if (old && old !== ref) await Media.release(old);
      reelRender(); reelPanel();
    } catch { toast('Could not read that image.'); }
    return;
  }
  const key = e.target.dataset.bgfile; if (!key) return;
  const f = e.target.files[0]; if (!f) return;
  try {
    const ref = await Media.save(await Media.shrink(f, 1600, 0.85), 'jpg');
    const old = reelStyle()[key].ref;
    reelSetStyle(key, { ...REEL_CARD_BG, ref });
    if (old && old !== ref) await Media.release(old);
    reelPanel(); reelShowCard(key === 'introBg' ? 'intro' : 'outro');
  } catch { toast('Could not read that image.'); }
}

/* ---------- Reel templates ----------
   A template = the whole style (cards, backgrounds, logo, text, watermark, default transition)
   plus a "recipe" taken from the draft: per-clip settings and per-join transitions by position.
   New photos/videos added after applying one take the recipe for their position; beyond the
   recipe's length the last entry repeats. Stored as JSON in settings (key reel_templates);
   images stay in the media folder and are kept alive because their names appear in that JSON. */
const REEL_SLOT_KEYS = ['dur', 'motion', 'fit', 'filter', 'speed', 'rot', 'flip', 'mute'];
function reelTemplates() { try { return JSON.parse(Settings.get('reel_templates', '[]')); } catch { return []; } }
const reelSaveTemplates = (list) => Settings.set('reel_templates', JSON.stringify(list));

function reelTplCapture(name, id) {
  const segs = reelSegments().segs;
  return {
    id: id || Date.now().toString(36), name, style: reelStyle(),
    slots: R.clips.map(c => Object.fromEntries(REEL_SLOT_KEYS.filter(k => c[k] !== undefined && !(k === 'dur' && c.type === 'video')).map(k => [k, c[k]]))),
    // Joins into clip i (i = 0 is from the intro) and into the outro, so the outro keeps its own.
    clipTrans: segs.filter(g => g.kind === 'clip').map(g => R.trans[g.key] || null),
    outroTrans: R.trans.outro || null
  };
}
const pickN = (arr, i) => arr.length ? arr[Math.min(i, arr.length - 1)] : null;
// Apply the active template's recipe to clips from index `from` onwards (new ones by default).
function reelTplRecipe(from) {
  const t = reelTemplates().find(x => x.id === R.tplId); if (!t) return;
  R.clips.forEach((c, i) => {
    if (i < from) return;
    const slot = pickN(t.slots, i) || {};
    for (const [k, v] of Object.entries(slot)) if (!(k === 'dur' && c.type === 'video') && !(k === 'mute' && c.type !== 'video')) c[k] = v;
    const tr = pickN(t.clipTrans, i); if (tr) R.trans[c.id] = { ...tr }; else delete R.trans[c.id];
  });
  if (t.outroTrans) R.trans.outro = { ...t.outroTrans }; else delete R.trans.outro;
}
function reelTplApply(t) {
  Settings.set('reel_style', JSON.stringify(t.style));
  R.tplId = t.id; R.trans = {};
  reelTplRecipe(0);
  reelChanged(); reelPanel();
  toast(`"${t.name}" applied.`);
}

function reelTplPanel() {
  const list = reelTemplates(), cur = list.find(x => x.id === R.tplId);
  return `<div class="card">
    <p class="muted" style="font-size:13px;margin:0 0 12px">Save the current look as a template: intro and outro cards, backgrounds, logo, text, watermark and transitions, plus each clip's length, look and motion. Apply it later and new photos and videos pick up the same settings.</p>
    <div class="tpl-list">${list.map(t => `<div class="tpl ${t.id === R.tplId ? 'on' : ''}">
        <span class="tpl-n"><b>${esc(t.name)}</b><span class="muted">${t.slots.length} clip setting${t.slots.length === 1 ? '' : 's'}${t.id === R.tplId ? ' · in use' : ''}</span></span>
        <button class="btn small primary" data-tpl-apply="${t.id}">Apply</button>
        <button class="btn small icon-btn ${R.tplMenu === t.id ? 'on' : ''}" data-tpl-menu="${t.id}" aria-label="More">⋯</button>
        ${R.tplMenu === t.id ? `<div class="row tpl-acts">
          <button class="btn small" data-tpl-rename="${t.id}">Rename</button>
          <button class="btn small" data-tpl-dup="${t.id}">Duplicate</button>
          <button class="btn small danger" data-tpl-del="${t.id}" style="margin-left:auto">Delete</button></div>` : ''}
      </div>`).join('') || '<p class="muted" style="margin:0 0 8px">No templates yet.</p>'}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn small primary" data-tpl-new>+ Save current as template</button>
      ${cur ? `<button class="btn small" data-tpl-update="${cur.id}" data-tip="Overwrite it with the current look and clip settings">Update "${esc(cur.name)}"</button>` : ''}
    </div>
    <div class="row" style="margin-top:12px;border-top:1px dashed var(--line);padding-top:12px">
      <button class="btn small" data-tpl-export ${list.length ? '' : 'disabled'} data-tip="One file with every template and its images, for another phone or tablet">Export templates</button>
      <label class="btn small">Import templates<input type="file" accept=".json,application/json" hidden data-tpl-import></label>
    </div></div>`;
}

async function reelTplClick(e) {
  if (R.tab !== 'tpl') return;
  const t = e.target, list = reelTemplates();
  const id = (a) => t.closest(`[${a}]`)?.getAttribute(a);
  if (id('data-tpl-apply')) return reelTplApply(list.find(x => x.id === id('data-tpl-apply')));
  if (t.closest('[data-tpl-new]')) {
    const name = prompt('Template name (e.g. an artist or a type of post):', `Template ${list.length + 1}`);
    if (!name?.trim()) return;
    const tpl = reelTplCapture(name.trim());
    await reelSaveTemplates([...list, tpl]); R.tplId = tpl.id; toast('Template saved.'); return reelPanel();
  }
  if (id('data-tpl-update')) {
    const i = list.findIndex(x => x.id === id('data-tpl-update'));
    if (!confirm(`Overwrite "${list[i].name}" with the current settings?`)) return;
    list[i] = reelTplCapture(list[i].name, list[i].id); await reelSaveTemplates(list); toast('Template updated.'); return reelPanel();
  }
  if (id('data-tpl-menu')) { R.tplMenu = R.tplMenu === id('data-tpl-menu') ? null : id('data-tpl-menu'); return reelPanel(); }
  const tp = list.find(x => x.id === (id('data-tpl-rename') || id('data-tpl-dup') || id('data-tpl-del')));
  if (tp && id('data-tpl-rename')) {
    const n = prompt('New name:', tp.name); if (!n?.trim()) return;
    tp.name = n.trim(); await reelSaveTemplates(list); return reelPanel();
  }
  if (tp && id('data-tpl-dup')) {
    await reelSaveTemplates([...list, { ...structuredClone(tp), id: Date.now().toString(36), name: tp.name + ' copy' }]);
    R.tplMenu = null; return reelPanel();
  }
  if (tp && id('data-tpl-del')) {
    if (!confirm(`Delete the template "${tp.name}"?\n\nThis cannot be undone.`)) return;
    const rest = list.filter(x => x !== tp);
    await reelSaveTemplates(rest); if (R.tplId === tp.id) R.tplId = null; R.tplMenu = null;
    for (const ref of reelTplRefs([tp])) await Media.release(ref);   // release() keeps any still in use
    toast('Template deleted.'); return reelPanel();
  }
  if (t.closest('[data-tpl-export]')) return reelTplExport(list);
}

// Images a set of templates uses: card backgrounds and per-template logos.
const reelTplRefs = (list) => [...new Set(list.flatMap(t => [t.style.introBg?.ref, t.style.outroBg?.ref, t.style.logoRef]).filter(Boolean))];

async function reelTplExport(list) {
  const media = {};
  for (const ref of reelTplRefs(list)) {
    try {
      const f = await (await (await Media.dir()).getFileHandle(ref)).getFile();
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      media[ref] = btoa(bin);
    } catch {}
  }
  const name = `InkForge-reel-templates-${ymd(new Date())}.json`;
  const file = new File([JSON.stringify({ inkforgeReelTemplates: 1, templates: list, media })], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Reel templates' });
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
    toast(`Exported ${list.length} template${list.length === 1 ? '' : 's'}.`);
  } catch (err) { if (err.name !== 'AbortError') toast('Could not export: ' + err.message); }
}

async function reelTplImport(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('That file is not a templates file.'); }
  if (data?.inkforgeReelTemplates !== 1 || !Array.isArray(data.templates)) return toast('That file is not an InkForge templates file.');
  // Images are saved under content-hash names, so the same names come back and refs stay valid.
  for (const [ref, b64] of Object.entries(data.media || {})) {
    try {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await Media.save(new Blob([bytes]), ref.split('.').pop());
    } catch {}
  }
  const list = reelTemplates(), names = new Set(list.map(t => t.name));
  let n = 0;
  for (const t of data.templates) {
    if (!t?.style || !Array.isArray(t.slots)) continue;
    let name = t.name || 'Template'; while (names.has(name)) name += ' (imported)';
    names.add(name); n++;
    list.push({ ...t, id: Date.now().toString(36) + n, name });
  }
  await reelSaveTemplates(list); toast(`Imported ${n} template${n === 1 ? '' : 's'}.`); reelPanel();
}

async function reelPortfolioPicker() {
  const rows = await DB.all(`SELECT x.photo_ref, x.thumb_ref, p.title FROM portfolio_photos x JOIN portfolio_items p ON p.id = x.item_id
    ORDER BY coalesce(p.made_on, p.created_at) DESC, x.sort LIMIT 120`);
  if (!rows.length) return toast('Your portfolio is empty.');
  const urls = await Promise.all(rows.map(r => Media.url(r.thumb_ref)));
  const o = document.createElement('div');
  o.id = 'reel-pick';
  o.innerHTML = `<div class="card"><h2>Pick from portfolio</h2>
    <div class="pf-grid" style="max-height:55vh;overflow-y:auto">${rows.map((r, i) => `<button class="pf-tile" data-i="${i}"><img src="${urls[i]}" alt=""></button>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn" id="rp-cancel">Cancel</button><button class="btn primary" id="rp-add" style="flex:1">Add</button></div></div>`;
  document.body.appendChild(o);
  const chosen = new Set();
  o.querySelector('.pf-grid').onclick = (e) => { const b = e.target.closest('.pf-tile'); if (!b) return; const i = +b.dataset.i;
    chosen.has(i) ? chosen.delete(i) : chosen.add(i); b.classList.toggle('picked', chosen.has(i)); };
  o.querySelector('#rp-cancel').onclick = () => o.remove();
  o.querySelector('#rp-add').onclick = async () => {
    const before = R.clips.length;
    for (const i of chosen) {
      try {
        const f = await (await (await Media.dir()).getFileHandle(rows[i].photo_ref)).getFile();
        const c = await reelAddFile(new File([f], rows[i].title || 'portfolio.jpg', { type: 'image/jpeg' }));
        if (rows[i].title && !c.caption) c.caption = '';
      } catch { toast('Could not load a portfolio photo.'); }
    }
    o.remove();
    if (R.tplId) reelTplRecipe(before);
    const last = R.clips[R.clips.length - 1];
    if (last) reelPick('clip', last.id); else { reelChanged(); reelPanel(); }
  };
}

/* ---------- Stencil helpers ---------- */
const ST_INKS = [['#1a1a1a', 'Black'], ['#3b2d8f', 'Stencil purple'], ['#b3261e', 'Red']];
const ST_DEFAULTS = { mode: 'lines', detail: 6, amount: 60, weight: 1, threshold: 110, clean: 1, contrast: 0, bright: 0, ink: '#3b2d8f', flip: false };
const ST_MAX = 1200;   // working resolution (long side): 300 dpi at 10 cm, 150 dpi at 20 cm
const ST = {
  src: null, rot: 0, w: 0, h: 0, rgba: null, mask: null, cm: 10, seq: 0, worker: null, _t: null,
  p: { ...ST_DEFAULTS }
};

async function stLoad(file) {
  try { ST.src = await createImageBitmap(file); }
  catch { toast('Could not read that image.'); return; }
  ST.rot = 0; ST.mask = null;
  try { Object.assign(ST.p, JSON.parse(Settings.get('st_params', '{}'))); } catch {}
  ST.p.flip = false;
  ST.cm = +Settings.get('st_cm', '10') || 10;
}

// Applies rotation/mirror and downsizes into the working buffer.
function stPrepare() {
  const s = Math.min(1, ST_MAX / Math.max(ST.src.width, ST.src.height));
  const sw = Math.round(ST.src.width * s), sh = Math.round(ST.src.height * s);
  const side = ST.rot % 180 !== 0;
  ST.w = side ? sh : sw; ST.h = side ? sw : sh;
  const c = new OffscreenCanvas(ST.w, ST.h), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, ST.w, ST.h);
  x.translate(ST.w / 2, ST.h / 2);
  if (ST.p.flip) x.scale(-1, 1);
  x.rotate(ST.rot * Math.PI / 180);
  x.drawImage(ST.src, -sw / 2, -sh / 2, sw, sh);
  ST.orig = c;
  ST.rgba = x.getImageData(0, 0, ST.w, ST.h).data;
  const cv = $('#st-canvas'); if (cv) { cv.width = ST.w; cv.height = ST.h; }
}

function stRun() {
  clearTimeout(ST._t);
  ST._t = setTimeout(() => {
    if (!ST.worker) {
      ST.worker = new Worker('lib/stencil-worker.js');
      ST.worker.onmessage = (e) => { if (e.data.id !== ST.seq) return; ST.mask = e.data.mask; stDraw(false); $('#st-canvas')?.classList.remove('busy'); };
    }
    $('#st-canvas')?.classList.add('busy');
    ST.worker.postMessage({ id: ++ST.seq, w: ST.w, h: ST.h, rgba: ST.rgba.slice(), p: ST.p });
  }, 90);
}

// Pinch / wheel to zoom (1x to 8x), drag to pan while zoomed, double-tap or Fit to reset.
// Only the on-screen view is transformed; the stencil itself and its export are untouched.
function stZoom(view, cv, fitBtn) {
  let s = 1, tx = 0, ty = 0, lastTap = 0;
  const pts = new Map();
  let g = null;   // gesture start: { s, tx, ty, d, cx, cy }
  const apply = () => {
    // Keep the image covering the view: pan is limited to how far the zoomed image overhangs.
    const mx = cv.offsetWidth * (s - 1) / 2, my = cv.offsetHeight * (s - 1) / 2;
    tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty));
    cv.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
    fitBtn.hidden = s === 1;
  };
  // Zoom by factor k around a point (px, py) given relative to the canvas centre.
  const zoomAt = (ns, px, py) => {
    ns = Math.max(1, Math.min(8, ns));
    tx = px - (px - tx) * ns / s; ty = py - (py - ty) * ns / s; s = ns; apply();
  };
  const centre = (x, y) => { const r = view.getBoundingClientRect(); return [x - r.left - r.width / 2, y - r.top - r.height / 2]; };
  const snapshot = () => {
    const p = [...pts.values()];
    const cx = p.reduce((a, q) => a + q.x, 0) / p.length, cy = p.reduce((a, q) => a + q.y, 0) / p.length;
    g = { s, tx, ty, cx, cy, d: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0 };
  };
  view.addEventListener('pointerdown', (e) => {
    if (e.target === fitBtn) return;
    if (e.pointerType !== 'mouse' && pts.size === 0) {
      const now = Date.now();
      if (now - lastTap < 300) { reset(); lastTap = 0; return; }
      lastTap = now;
    }
    try { view.setPointerCapture(e.pointerId); } catch {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); snapshot();
  });
  view.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.values()];
    const cx = p.reduce((a, q) => a + q.x, 0) / p.length, cy = p.reduce((a, q) => a + q.y, 0) / p.length;
    if (p.length > 1 && g.d) {
      const ns = Math.max(1, Math.min(8, g.s * Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) / g.d));
      const [ox, oy] = centre(g.cx, g.cy);
      s = ns; tx = ox - (ox - g.tx) * ns / g.s + (cx - g.cx); ty = oy - (oy - g.ty) * ns / g.s + (cy - g.cy);
    } else if (s > 1) { tx = g.tx + cx - g.cx; ty = g.ty + cy - g.cy; }
    apply();
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size) snapshot(); };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  view.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(s * Math.exp(-e.deltaY * 0.0015), ...centre(e.clientX, e.clientY)); }, { passive: false });
  view.addEventListener('dblclick', () => reset());
  const reset = () => { s = 1; tx = ty = 0; apply(); };
  fitBtn.onclick = reset;
  return { reset };
}

function stDraw(original) {
  const cv = $('#st-canvas'); if (!cv) return;
  const x = cv.getContext('2d');
  if (original || !ST.mask) { x.drawImage(ST.orig, 0, 0); return; }
  x.putImageData(stImage(ST.mask), 0, 0);
}

function stImage(mask) {
  const img = new ImageData(ST.w, ST.h), d = img.data;
  const ink = ST.p.ink, r = parseInt(ink.slice(1, 3), 16), g = parseInt(ink.slice(3, 5), 16), b = parseInt(ink.slice(5, 7), 16);
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    if (mask[i]) { d[j] = r; d[j + 1] = g; d[j + 2] = b; } else { d[j] = d[j + 1] = d[j + 2] = 255; }
    d[j + 3] = 255;
  }
  return img;
}

const stSave = () => { const { flip, ...keep } = ST.p; Settings.set('st_params', JSON.stringify(keep)); };

function stSliders() {
  const m = ST.p.mode;
  const S = [
    m !== 'solid' && ['detail', 'Detail', 1, 10, 1, 'Higher picks up finer lines. Lower gives bold, simple outlines.'],
    m !== 'solid' && ['amount', 'Line amount', 0, 100, 1, 'How many edges become lines. Lower it if the stencil looks busy.'],
    m !== 'solid' && ['weight', 'Line weight', 0, 3, 1, 'Thickens every line.'],
    m !== 'lines' && ['threshold', m === 'sketch' ? 'Shading' : 'Threshold', 20, 230, 1, 'Everything darker than this becomes solid ink.'],
    ['contrast', 'Contrast', -50, 50, 1, 'Boost a flat or faded photo before converting.'],
    ['bright', 'Brightness', -60, 60, 1, 'Lighten or darken the photo before converting.'],
    ['clean', 'Clean up', 0, 3, 1, 'Removes stray specks and noise.']
  ].filter(Boolean);
  $('#st-sliders').innerHTML = S.map(([k, l, min, max, step, tip]) => `
    <label class="slider"><span>${l} ${help(tip)}<b id="sv-${k}">${ST.p[k]}</b></span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${ST.p[k]}" data-k="${k}"></label>`).join('')
    + `<button class="link" id="st-reset" style="margin-top:4px">Reset sliders</button>`;
  $('#st-sliders').oninput = (e) => {
    const k = e.target.dataset.k; if (!k) return;
    ST.p[k] = +e.target.value; $('#sv-' + k).textContent = e.target.value; stRun(); stSave();
  };
  $('#st-reset').onclick = () => { Object.assign(ST.p, { ...ST_DEFAULTS, mode: ST.p.mode, ink: ST.p.ink, flip: ST.p.flip }); stSliders(); stRun(); stSave(); };
}

async function stBlob() {
  const c = new OffscreenCanvas(ST.w, ST.h);
  c.getContext('2d').putImageData(stImage(ST.mask), 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

async function stExport() {
  if (!ST.mask) return;
  const file = new File([await stBlob()], `stencil-${ymd(new Date())}.png`, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Stencil' });
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
  } catch (e) { if (e.name !== 'AbortError') toast('Could not save: ' + e.message); }
}

// Prints the stencil at its real size (width in cm) on a blank page.
// An empty paper copy of a form: blank lines for answers, empty boxes, a space to sign by hand.
async function printBlankForm(id) {
  const t = await DB.one('SELECT * FROM form_templates WHERE id = ?', [id]); if (!t) return;
  const c = { ...formCtx(null), client: '____________________', first: '', date: '____ / ____ / ________' };
  const logo = await Media.url(Settings.get('studio_logo_ref'));
  let p = $('#print-area');
  if (!p) { p = document.createElement('div'); p.id = 'print-area'; document.body.appendChild(p); }
  p.innerHTML = `<div class="sheet sheet-${t.kind}">${logo ? `<img class="sheet-logo" src="${logo}" alt="">` : ''}
    ${renderFormBlocks(JSON.parse(t.blocks), c, {}, true)}
    ${t.kind === 'consent' ? `<div class="sig-wrap"><div class="sig-label">Signature</div><div class="sig-blank"></div>
      <div class="sig-line">Name: ______________________________ &nbsp; Date: ____ / ____ / ________</div></div>` : ''}</div>`;
  if (logo) await p.querySelector('.sheet-logo').decode().catch(() => {});
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); p.innerHTML = ''; removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  window.print();
}

async function stPrint() {
  if (!ST.mask) return;
  const url = URL.createObjectURL(await stBlob());
  let p = $('#print-area');
  if (!p) { p = document.createElement('div'); p.id = 'print-area'; document.body.appendChild(p); }
  p.innerHTML = `<img src="${url}" style="width:${ST.cm}cm" alt="">`;
  await p.querySelector('img').decode();
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); p.innerHTML = ''; URL.revokeObjectURL(url); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  window.print();
}

/* ---------- Slider touch guard ----------
   Sliders use touch-action: pan-y, so a vertical finger drag scrolls the page and the browser cancels
   the slider's pointer. A tap or sideways drag still sets the value. If the slider already jumped
   to where the finger landed before the scroll was recognised, put the old value back. */
(() => {
  let el = null, start = '';
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.target.matches?.('input[type=range]')) return;
    el = e.target; start = el.value;
  }, true);
  document.addEventListener('pointercancel', () => {
    if (el && el.value !== start) {
      el.value = start;
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el = null;
  }, true);
  document.addEventListener('pointerup', () => { el = null; }, true);
})();

/* ---------- Forms helpers ---------- */
const Forms = { ctx: null };   // { clientId, bookingId } handed to the sign view
function openForm(templateId, clientId, bookingId) { Forms.ctx = { clientId, bookingId }; location.hash = 'form-sign/' + templateId; }
// booking (optional) supplies {description} and {quote}. Contact keys come from Settings and are '' when unset.
const formCtx = (client, booking) => ({
  client: client ? fullName(client) : '________',
  first: client ? (client.first_name || fullName(client)) : 'there',
  phone: client?.phone || '', email: client?.email || '',
  description: booking?.description || '', quote: booking?.quote != null ? money(booking.quote) : '',
  artist: Settings.get('artist_name') || 'the artist',
  studio: Settings.get('studio_name') || 'the studio',
  artist_phone: Settings.get('artist_phone'), instagram: Settings.get('artist_instagram'),
  facebook: Settings.get('artist_facebook'), tiktok: Settings.get('artist_tiktok'),
  date: new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
});
const fillPlaceholders = (text, c) => text.replace(/\{(\w+)\}/g, (m, k) => k in c ? c[k] : m);
// Info lines whose placeholders are all empty (e.g. "TikTok: {tiktok}" with no handle set) are left out.
const blankLine = (b, c) => c && /^(p|li|sub)$/.test(b.t) && /\{\w+\}/.test(b.text)
  && [...b.text.matchAll(/\{(\w+)\}/g)].every(([, k]) => k in c && !c[k]);
const choiceOpts = (b) => (b.opts || '').split('/').map(s => s.trim()).filter(Boolean);

// interactive: tick boxes and fields are editable. readonly: show stored answers.
function renderFormBlocks(blocks, c, answers, interactive, readonly) {
  const txt = (s) => esc(c ? fillPlaceholders(s, c) : s);
  return blocks.map((b, i) => {
    if (blankLine(b, c)) return '';
    if (b.t === 'h') return `<h3>${txt(b.text)}</h3>`;
    if (b.t === 'sub') return `<h4>${txt(b.text)}</h4>`;
    if (b.t === 'p') return b.text ? `<p>${txt(b.text)}</p>` : '';
    if (b.t === 'li') return `<div class="f-bullet">${txt(b.text)}</div>`;
    if (b.t === 'check') {
      if (!interactive && !readonly) return `<div class="f-bullet">${txt(b.text)}</div>`;
      const on = answers?.checks?.[i];
      return `<label class="f-check"><input type="checkbox" data-check="${i}" ${on ? 'checked' : ''} ${readonly ? 'disabled' : ''}><span>${txt(b.text)}</span></label>`;
    }
    if (b.t === 'field') {
      const v = answers?.fields?.[i] || '';
      return `<label class="f-field"><span>${txt(b.text)}</span>${readonly ? `<div class="f-ans">${esc(v) || '—'}</div>`
        : b.long ? `<textarea class="in" rows="3" data-field="${i}" ${interactive ? '' : 'disabled'}>${esc(v)}</textarea>`
        : `<input class="in" data-field="${i}" value="${esc(v)}" ${interactive ? '' : 'disabled'}>`}</label>`;
    }
    if (b.t === 'choice') {
      const v = answers?.fields?.[i] || '';
      return `<div class="f-field"><span>${txt(b.text)}</span><div class="f-opts">${choiceOpts(b).map(o =>
        `<label class="f-opt"><input type="radio" name="fc${i}" data-choice="${i}" value="${esc(o)}" ${v === o ? 'checked' : ''} ${interactive && !readonly ? '' : 'disabled'}><span>${esc(o)}</span></label>`).join('')}</div></div>`;
    }
    return '';
  }).join('');
}
const formAsText = (blocks, c) => blocks.filter(b => !blankLine(b, c)).map(b => {
  const s = fillPlaceholders(b.text, c);
  return b.t === 'h' ? s.toUpperCase() : b.t === 'sub' ? s.toUpperCase()
    : b.t === 'check' || b.t === 'li' ? '• ' + s : b.t === 'field' ? s + ': ' : b.t === 'choice' ? s + ': ' + choiceOpts(b).join(' / ') : s;
}).join('\n\n').replace(/\n\n• /g, '\n• ');

/* One-page forms: before any print (the app's buttons or the browser's own), switch the form to
   its compact print layout at A4 width, measure it, and scale it down if it would still spill
   onto a second page. Undone after printing. */
const A4_PX = 277 * 96 / 25.4;   // printable height: 297 mm minus 10 mm margins top and bottom
function fitFormForPrint() {
  // A blank form prints from #print-area; otherwise the form on screen. (Stencils use #print-area without a sheet.)
  const sheet = document.body.classList.contains('printing') ? $('#print-area .sheet') : $('.sheet'); if (!sheet) return;
  document.body.classList.add('pfit');
  sheet.style.zoom = '';
  // #print-area is only shown by the print stylesheet, so show it briefly to measure it.
  const pa = sheet.closest('#print-area'); if (pa) pa.style.display = 'block';
  const h = sheet.scrollHeight;
  if (pa) pa.style.display = '';
  const room = A4_PX * 0.97;   // a little slack for rounding in the print engine
  if (h > room) sheet.style.zoom = String(Math.floor(room / h * 1000) / 1000);
}
addEventListener('beforeprint', fitFormForPrint);
addEventListener('afterprint', () => { document.body.classList.remove('pfit'); const s = $('.sheet'); if (s) s.style.zoom = ''; });

// Finger/stylus/mouse signature on a canvas. Dark ink on the white sheet.
function signaturePad(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const fit = () => { const r = canvas.getBoundingClientRect(); canvas.width = r.width * dpr; canvas.height = r.height * dpr; };
  fit();
  const ctx = canvas.getContext('2d');
  const setup = () => { ctx.scale(dpr, dpr); ctx.lineCap = ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2.4; };
  setup();
  let drawing = false, last = null, inked = false;
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pt(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pt(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; inked = true;
  });
  const end = () => { if (drawing && inked) Dirty.set(true); drawing = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  return {
    empty: () => !inked,
    clear() { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); setup(); inked = false; },
    data: () => canvas.toDataURL(),
    restore(url) { const img = new Image(); img.onload = () => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(img, 0, 0); setup(); inked = true; }; img.src = url; },
    blob: () => new Promise(r => canvas.toBlob(r, 'image/png'))
  };
}

// Search-as-you-type client chooser. onPick(id) gets the chosen client id.
function clientPicker(input, list, onPick) {
  const show = async () => {
    const rows = await DB.all(`SELECT id, first_name, last_name, phone, photo_ref FROM clients
      WHERE (first_name || ' ' || last_name) LIKE ? ORDER BY first_name COLLATE NOCASE LIMIT 8`, ['%' + input.value.trim() + '%']);
    const urls = await Promise.all(rows.map(r => Media.url(r.photo_ref)));
    list.innerHTML = rows.map((r, i) => `<button type="button" class="c-row" data-id="${r.id}">${avatar(r, urls[i])}
      <span class="c-main"><span class="c-n">${esc(fullName(r))}</span><span class="muted c-sub">${esc(r.phone || '')}</span></span></button>`).join('')
      || '<div class="muted" style="padding:12px">No match. Add the client in Clients first.</div>';
    list.hidden = false;
  };
  input.addEventListener('focus', show);
  input.addEventListener('input', show);
  input.addEventListener('blur', () => setTimeout(() => list.hidden = true, 150));
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', (e) => {
    const r = e.target.closest('.c-row'); if (!r) return;
    input.value = r.querySelector('.c-n').textContent; list.hidden = true; input.blur();
    onPick(+r.dataset.id);
  });
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
const NAV_PARENT = { settings: 'more', client: 'clients', 'client-edit': 'clients', 'booking-edit': 'book',
  quote: 'more', 'quote-cal': 'more', stats: 'more', inventory: 'more', 'inv-edit': 'more', stocktake: 'more', rules: 'more', 'rule-edit': 'more',
  reel: 'studio', stencil: 'studio', portfolio: 'studio', pf: 'studio', 'pf-edit': 'studio',
  forms: 'studio', 'form-edit': 'studio', 'form-sign': 'studio', signed: 'studio' };
let currentHash = location.hash;
function render() {
  if (location.hash !== currentHash && !Dirty.ok()) { history.replaceState(null, '', currentHash || '#'); return; }
  Dirty.set(false);
  currentHash = location.hash;
  const [key, arg] = (location.hash.slice(1) || 'home').split('/');
  if (R.playing && key !== 'reel') reelPause();
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
let booted = false;   // no view touches the database before boot has opened and migrated it
addEventListener('hashchange', () => { if (booted) render(); });

/* ---------- Boot ---------- */
(async () => {
  // reel.js and app.js ship together. If a cached older reel.js loaded next to this app.js,
  // refetch both past the browser cache and reload once (the flag stops a reload loop).
  if (typeof REEL_VERSION === 'undefined' || REEL_VERSION !== 6) {
    let tried = false; try { tried = sessionStorage.getItem('if-reload') === '1'; sessionStorage.setItem('if-reload', '1'); } catch {}
    if (!tried) { await Promise.all(['reel.js', 'app.js', 'app.css'].map(u => fetch(u, { cache: 'reload' }).catch(() => {}))); location.reload(); return; }
  }
  try { sessionStorage.removeItem('if-reload'); } catch {}
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
  try { await WS.load(); } catch (err) { console.error(err); }
  let openId = '', forceStart = false;
  try { openId = sessionStorage.getItem('ws-open') || ''; forceStart = sessionStorage.getItem('ws-start') === '1';
    sessionStorage.removeItem('ws-open'); sessionStorage.removeItem('ws-start'); } catch {}
  const w = WS.get(openId) || (!forceStart && WS.auto && WS.get(WS.last));
  if (w) startWorkspace(w); else showStart();
})();

/* Start screen: like a desktop app's welcome window. New, open a workspace file, or pick a recent one. */
function showStart() {
  const ago = (iso) => { if (!iso) return 'Never opened'; const d = (Date.now() - new Date(iso)) / 864e5;
    return d < 1 ? 'Opened today' : d < 2 ? 'Opened yesterday' : `Opened ${new Date(iso).toLocaleDateString()}`; };
  const draw = () => {
    const list = [...WS.list].sort((a, b) => (b.opened || '').localeCompare(a.opened || ''));
    o.innerHTML = `<div class="start-in">
      <div class="start-brand"><img src="icon.svg" alt=""><h1>InkForge</h1><span class="badge ea">Early Access</span></div>
      <div class="start-acts">
        <button class="start-big" id="st-new"><b>+ New workspace</b><span>Start fresh, e.g. for another artist</span></button>
        <label class="start-big"><b>Open file…</b><span>A workspace or backup file (.inkforge)</span><input type="file" accept=".inkforge,.sqlite,.db" hidden id="st-file"></label>
      </div>
      <div class="letter">Recent</div>
      <div class="card list">${list.map(w => `<div class="c-row ws-row">
          <button class="c-main ws-open" data-ws="${w.id}"><span class="c-n">${esc(w.name)}</span><span class="muted c-sub">${ago(w.opened)}</span></button>
          <button class="btn small icon-btn ${menu === w.id ? 'on' : ''}" data-wsmenu="${w.id}" aria-label="More">⋯</button>
          ${menu === w.id ? `<div class="row tpl-acts">
            <button class="btn small" data-wsren="${w.id}">Rename</button>
            <button class="btn small" data-wssave="${w.id}" data-tip="Save this workspace as a file to share or keep safe">Save file</button>
            <button class="btn small danger" data-wsdel="${w.id}" style="margin-left:auto">Delete</button></div>` : ''}
        </div>`).join('')}</div>
      <label class="toggle" style="display:inline-flex;margin-top:12px" data-tip="Skip this screen and go straight to the last workspace. Switch any time by tapping the workspace name at the top.">
        <input type="checkbox" id="st-auto" ${WS.auto ? 'checked' : ''}><span>Open my last workspace automatically</span></label>
      <p class="muted" style="font-size:12px;margin-top:16px">Workspaces are stored on this device. Save a workspace file to move it to another device or keep a copy safe: keeping that file safe is up to you.</p>
    </div>`;
  };
  let menu = null;
  const o = document.createElement('div'); o.id = 'start';
  document.body.appendChild(o); draw();
  o.addEventListener('click', async (e) => {
    const t = e.target, id = (a) => t.closest(`[${a}]`)?.getAttribute(a);
    if (id('data-ws')) { o.remove(); return startWorkspace(WS.get(id('data-ws'))); }
    if (id('data-wsmenu')) { menu = menu === id('data-wsmenu') ? null : id('data-wsmenu'); return draw(); }
    const w = WS.get(id('data-wsren') || id('data-wssave') || id('data-wsdel'));
    if (w && id('data-wsren')) { const n = prompt('Workspace name:', w.name); if (n?.trim()) { w.name = n.trim(); await WS.save(); draw(); } return; }
    if (w && id('data-wssave')) { try { await exportBackup(w); } catch (err) { toast('Could not save: ' + err.message, 5000); } return; }
    if (w && id('data-wsdel')) {
      if (!confirm(`Delete the workspace "${w.name}" and everything in it from this device?\n\nSave its file first if you might need it. This cannot be undone.`)) return;
      try { await WS.remove(w); toast('Workspace deleted.'); } catch (err) { toast(err.message, 5000); }
      if (!WS.list.length) await WS.create('My workspace');
      menu = null; return draw();
    }
    if (t.closest('#st-new')) {
      const n = prompt('Name for the new workspace (e.g. the artist\'s name):', '');
      if (!n?.trim()) return;
      const nw = await WS.create(n.trim()); o.remove(); return startWorkspace(nw);
    }
  });
  o.addEventListener('change', async (e) => {
    if (e.target.id === 'st-auto') { WS.auto = e.target.checked; return WS.save(); }
    if (e.target.id !== 'st-file') return;
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    let name;
    try { name = parseBackup(bytes.slice()).name; } catch (err) { return toast(err.message, 5000); }
    name = name || f.name.replace(/(-\d{4}-\d\d-\d\d-\d\d-\d\d)?\.\w+$/, '').replace(/_/g, ' ');
    if (WS.list.some(w => w.name === name)) name += ' (opened)';
    const nw = await WS.create(name); o.remove();
    startWorkspace(nw, bytes);
  });
}

// Opens a workspace and runs the normal start-up (snapshot recovery, migrations, settings).
// `fileBytes`: a workspace/backup file to load into it first (from "Open file…").
async function startWorkspace(w, fileBytes) {
  const badge = $('#db-badge');
  let recovered = false;
  try {
    await WS.open(w);
    if (fileBytes) await restoreBackup(fileBytes);
    else if (!(await hasData())) {
      const snap = await Snapshot.load();
      if (snap) { await DB.importBytes(snap); recovered = true; }
    }
    await migrate();
    await Settings.load();
    // Every table must belong to a merge section (or be marked device-only) in MERGE_TABLES,
    // otherwise "Merge from backup" would quietly leave its data behind.
    const unmapped = (await DB.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`))
      .map(r => r.name).filter(t => !(t in MERGE_TABLES));
    if (unmapped.length) {
      console.error('Tables missing from MERGE_TABLES:', unmapped);
      if (location.hostname === 'localhost') toast('Developer: add ' + unmapped.join(', ') + ' to MERGE_TABLES.', 8000);
    }
    Cal.mode = Settings.get('cal_mode', innerWidth >= 900 ? 'week' : 'day');
    const info = await DB.info();
    // The badge names the open workspace; tapping it goes back to the start screen to switch.
    badge.textContent = w.name;
    badge.className = 'badge ws-badge ' + (info.mode === 'opfs' ? 'ok' : 'warn');
    badge.dataset.tip = info.mode === 'opfs'
      ? `Workspace "${w.name}", saved on this device. Tap to switch workspace.`
      : 'This browser blocked on-device storage, so changes are lost on reload. Use https or localhost.';
    badge.onclick = () => { if (Dirty.ok()) { Dirty.set(false); Snapshot.save().finally(() => WS.switchTo(null)); } };
  } catch (err) {
    badge.textContent = 'DB error'; badge.className = 'badge warn'; badge.dataset.tip = err.message;
    console.error(err);
    // Block the UI rather than let anything be typed into a database that is not open.
    $('#view').innerHTML = `<div class="card alert"><h2>Can't open your data</h2><p>${esc(err.message)}</p>
      <button class="btn primary" onclick="location.reload()">Reload</button></div>`;
    return;
  }
  booted = true;
  Snapshot.ready = true;
  render();
  if (recovered) toast('Your data was missing on start-up and has been restored from the last automatic save.', 8000);
  else if (fileBytes) { toast(`Opened "${w.name}".`); Snapshot.soon(); }
  else Snapshot.soon();
}
