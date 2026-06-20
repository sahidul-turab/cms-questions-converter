// Per-subject persistent storage (IndexedDB).
//
// Each subject keeps its own dataset so the tool can be subject-specific:
//   { subject, cfg, reference: [...slim CMS rows], corrections: [...], updatedAt }
// Reference data persists across sessions — upload once per subject, not every
// time. We store a slim projection (title/solution/options) to stay compact.

const DB_NAME = 'cms_formatter';
const VERSION = 2;
const STORE = 'datasets';
// Single-record store for app-wide state that isn't tied to one subject — most
// importantly the in-progress review session (the parsed/edited rows), so a tab
// reload or crash never loses the reviewer's work.
const META = 'meta';
const SESSION_KEY = 'session';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'subject' });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
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

// ---- in-progress review session (autosaved working rows) ----
// One record holds the latest parsed/edited rows so a reload can offer to
// restore them. Stored separately from per-subject datasets because it is the
// transient working set, not the subject's saved defaults/corrections.

function metaTx(db, mode) {
  return db.transaction(META, mode).objectStore(META);
}

export async function getSession() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = metaTx(db, 'readonly').get(SESSION_KEY);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

export async function putSession(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = metaTx(db, 'readwrite').put({ ...session, key: SESSION_KEY, updatedAt: new Date().toISOString() });
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

export async function clearSession() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = metaTx(db, 'readwrite').delete(SESSION_KEY);
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
