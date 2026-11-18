// IndexedDB persistence. Stores: projects, highlights, media, timelines, settings, feedback, exports, history, perf.
const DB_NAME = 'clipforge-gta6', DB_VER = 1;
const STORES = {
  projects: { keyPath: 'id' },
  highlights: { keyPath: 'id', indexes: [['projectId', 'projectId']] },
  media: { keyPath: 'projectId' },
  timelines: { keyPath: 'projectId' },
  settings: { keyPath: 'key' },
  feedback: { keyPath: 'id', indexes: [['highlightId', 'highlightId']] },
  exports: { keyPath: 'id', indexes: [['projectId', 'projectId']] },
  history: { keyPath: 'id' },
  perf: { keyPath: 'id' },
};
let dbp = null;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB is not available in this browser.'));
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, cfg] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const os = db.createObjectStore(name, { keyPath: cfg.keyPath });
          (cfg.indexes || []).forEach(([n, kp]) => os.createIndex(n, kp));
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });
  return dbp;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(wrapErr(t.error));
    t.onabort = () => reject(wrapErr(t.error));
    result = fn(t.objectStore(store), t);
  }));
}
function wrapErr(e) {
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
    const err = new Error('Browser storage quota exceeded. Free space in Settings → Local storage, or delete old projects.');
    err.quota = true; return err;
  }
  return e || new Error('IndexedDB error');
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  put: (store, val) => tx(store, 'readwrite', (os) => { os.put(val); }),
  putMany: (store, vals) => tx(store, 'readwrite', (os) => { vals.forEach((v) => os.put(v)); }),
  get: (store, key) => openDB().then((d) => reqP(d.transaction(store).objectStore(store).get(key))),
  getAll: (store) => openDB().then((d) => reqP(d.transaction(store).objectStore(store).getAll())),
  getAllBy: (store, index, key) => openDB().then((d) => reqP(d.transaction(store).objectStore(store).index(index).getAll(key))),
  delete: (store, key) => tx(store, 'readwrite', (os) => { os.delete(key); }),
  clear: (store) => tx(store, 'readwrite', (os) => { os.clear(); }),
  async deleteBy(store, index, key) {
    const items = await this.getAllBy(store, index, key);
    const kp = STORES[store].keyPath;
    return tx(store, 'readwrite', (os) => { items.forEach((i) => os.delete(i[kp])); });
  },
  async clearAll() { for (const s of Object.keys(STORES)) await this.clear(s); },
  async deleteDatabase() {
    try { (await dbp)?.close(); } catch {}
    dbp = null;
    return new Promise((res) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  },
};

export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 }; }
  } catch {}
  return { usage: 0, quota: 0, unknown: true };
}
export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
