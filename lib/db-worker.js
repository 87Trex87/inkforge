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

/* Only one page may own the database files. On reload the old page can still hold them for a
   moment, so wait for an exclusive lock (released automatically when that page closes) instead
   of racing it. Never fall back to memory when OPFS exists: writes there would silently vanish. */
function acquireLock() {
  if (!self.navigator?.locks) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = new AbortController();
    const t = setTimeout(() => { abort.abort(); reject(new Error('InkForge is already open in another tab or window. Close it, then reload this one.')); }, 8000);
    navigator.locks.request('inkforge-db', { signal: abort.signal }, () => {
      clearTimeout(t); resolve();
      return new Promise(() => {});   // hold for the life of this worker
    }).catch(() => {});
  });
}

const ready = (async () => {
  sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: console.error });
  if (self.navigator?.storage?.getDirectory) {
    await acquireLock();
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'inkforge-pool' });
  }
  openDb();
})();

const ops = {
  info() {
    return { mode, sqlite: sqlite3.version.libVersion,
      files: pool ? pool.getFileNames() : [], capacity: pool ? pool.getCapacity() : 0, used: pool ? pool.getFileCount() : 0 };
  },
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
  // Reads every table of a backup database in a separate in-memory copy, for merging.
  // The device's own database is not touched.
  peek({ bytes }) {
    const d = new sqlite3.oo1.DB(':memory:', 'c');
    try {
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      d.checkRc(sqlite3.capi.sqlite3_deserialize(d.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE));
      const tables = {};
      for (const t of d.selectValues(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`))
        tables[t] = d.selectObjects(`SELECT * FROM "${t}"`);
      return { tables };
    } finally { d.close(); }
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
