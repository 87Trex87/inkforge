/* InkForge database worker.
   Runs SQLite (official WASM build) on the OPFS "SAH pool" VFS: real on-device
   file storage, no localStorage, no COOP/COEP headers required.
   Lives in lib/ so sqlite3.wasm resolves relative to this script.
   Each workspace is its own database file in the pool; the page opens one at a time with `open`. */
importScripts('sqlite3.js');

let sqlite3, pool = null, db = null, mode = 'none', path = null;

function openDb(p) {
  if (db) { db.close(); db = null; }
  path = p;
  if (pool) { db = new pool.OpfsSAHPoolDb(p); mode = 'opfs'; }
  else { db = new sqlite3.oo1.DB(':memory:', 'c'); mode = 'memory'; }
  db.exec('PRAGMA foreign_keys = ON;');
}
const need = () => { if (!db) throw new Error('No workspace is open.'); };

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
})();

const ops = {
  info() {
    return { mode, path, sqlite: sqlite3.version.libVersion,
      files: pool ? pool.getFileNames() : [], capacity: pool ? pool.getCapacity() : 0, used: pool ? pool.getFileCount() : 0 };
  },
  // Opens (or creates) a workspace database. The pool has a fixed number of file slots, so keep
  // spare ones for this database and its journal.
  async open({ path: p }) {
    if (pool && pool.getCapacity() - pool.getFileCount() < 4) await pool.reserveMinimumCapacity(pool.getFileCount() + 6);
    openDb(p);
    return { ok: true, mode };
  },
  exec({ sql, params }) {
    need();
    const rows = [];
    db.exec({ sql, bind: params || undefined, rowMode: 'object', resultRows: rows });
    return { rows, changes: db.changes() };
  },
  // Runs several statements atomically. Each item: { sql, params }.
  tx({ items }) {
    need();
    db.transaction(() => {
      for (const it of items) db.exec({ sql: it.sql, bind: it.params || undefined });
    });
    return { ok: true };
  },
  // Bytes of the open database, or of another workspace's file when `path` is given.
  export({ path: p } = {}) {
    if (p && p !== path) {
      if (!pool || !pool.getFileNames().includes(p)) throw new Error('That workspace has no data yet.');
      return { bytes: pool.exportFile(p) };
    }
    need();
    if (!pool) return { bytes: sqlite3.capi.sqlite3_js_db_export(db.pointer) };
    return { bytes: pool.exportFile(path) };
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
    need();
    db.close(); db = null;
    if (pool) { pool.importDb(path, bytes); openDb(path); }
    else {
      openDb(path);
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
      db.checkRc(rc);
    }
    return { ok: true };
  },
  // Deletes a workspace's database file (never the open one).
  drop({ path: p }) {
    if (p === path) throw new Error('Close this workspace before deleting it.');
    if (pool) for (const f of pool.getFileNames()) if (f === p || f.startsWith(p + '-')) pool.unlink(f);
    return { ok: true };
  }
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    await ready;
    const res = await ops[op](args || {});
    const transfer = res && res.bytes ? [res.bytes.buffer] : [];
    self.postMessage({ id, ok: true, res }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
