/* InkForge database worker.
   Runs SQLite (official WASM build) on the OPFS "SAH pool" VFS: real on-device
   file storage, no localStorage, no COOP/COEP headers required.
   Lives in lib/ so sqlite3.wasm resolves relative to this script. */
importScripts('sqlite3.js');

const DB_PATH = '/inkforge.db';
let sqlite3, pool = null, db = null, mode = 'none';

function openDb() {
  if (pool) { db = new pool.OpfsSAHPoolDb(DB_PATH); mode = 'opfs'; }
  else { db = new sqlite3.oo1.DB(':memory:', 'c'); mode = 'memory'; }
  db.exec('PRAGMA foreign_keys = ON;');
}

const ready = (async () => {
  sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: console.error });
  try { pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'inkforge-pool' }); }
  catch (e) { console.warn('OPFS unavailable, falling back to memory:', e); pool = null; }
  openDb();
})();

const ops = {
  info() { return { mode, sqlite: sqlite3.version.libVersion }; },
  exec({ sql, params }) {
    const rows = [];
    db.exec({ sql, bind: params || undefined, rowMode: 'object', resultRows: rows });
    return { rows, changes: db.changes() };
  },
  // Runs several statements atomically. Each item: { sql, params }.
  tx({ items }) {
    db.transaction(() => {
      for (const it of items) db.exec({ sql: it.sql, bind: it.params || undefined });
    });
    return { ok: true };
  },
  export() {
    if (!pool) return { bytes: sqlite3.capi.sqlite3_js_db_export(db.pointer) };
    return { bytes: pool.exportFile(DB_PATH) };
  },
  import({ bytes }) {
    db.close();
    if (pool) { pool.importDb(DB_PATH, bytes); openDb(); }
    else {
      openDb();
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
      db.checkRc(rc);
    }
    return { ok: true };
  }
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    await ready;
    const res = ops[op](args || {});
    const transfer = res && res.bytes ? [res.bytes.buffer] : [];
    self.postMessage({ id, ok: true, res }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
