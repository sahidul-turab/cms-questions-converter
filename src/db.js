// Per-subject persistent storage (IndexedDB).
//
// Each subject keeps its own dataset so the tool can be subject-specific:
//   { subject, cfg, reference: [...slim CMS rows], corrections: [...], updatedAt }
// Reference data persists across sessions — upload once per subject, not every
// time. We store a slim projection (title/solution/options) to stay compact.

const DB_NAME = 'cms_formatter';
const VERSION = 1;
const STORE = 'datasets';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'subject' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function listSubjects() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readonly').getAllKeys();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

export async function getDataset(subject) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readonly').get(subject);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

export async function putDataset(ds) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readwrite').put({ ...ds, updatedAt: new Date().toISOString() });
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

export async function deleteDataset(subject) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readwrite').delete(subject);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

// Keep only the fields used for style learning + example matching.
const SLIM_KEYS = ['Question Title', 'Solution', 'Option A', 'Option B', 'Option C', 'Option D'];
export function slimRow(r) {
  const o = {};
  for (const k of SLIM_KEYS) o[k] = r[k] || '';
  return o;
}
