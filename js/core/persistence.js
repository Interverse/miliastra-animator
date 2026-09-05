// Local persistence (IndexedDB) — everything stays in the user's browser.
//
//   store "projects"  explicitly saved projects, keyed by project id
//                     { id, schema, name, giaName, createdAt, modifiedAt, meta,
//                       project, giaBytes, ui }
//   store "project"   the single autosave / recovery record (key "current")
//                     { project, giaBytes, giaName, ui, projectId, projectName,
//                       createdAt, dirty, savedAt }
//
// localStorage only carries small UI preferences (PREFS_KEY).
const DB_NAME = 'miliastra-animator';
const DB_VERSION = 2;
const RECOVERY_STORE = 'project';
const PROJECTS_STORE = 'projects';
const RECOVERY_KEY = 'current';
const PREFS_KEY = 'miliastra-animator-prefs';
export const PROJECT_SCHEMA = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECOVERY_STORE)) db.createObjectStore(RECOVERY_STORE);
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    try { result = fn(os); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

export function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message || e.name || '')));
}

// ---------- recovery / autosave ----------
export async function saveRecovery(rec) {
  if (typeof indexedDB === 'undefined') return false; // headless (tests)
  try {
    const db = await openDb();
    await tx(db, RECOVERY_STORE, 'readwrite', (os) => os.put({ ...rec, giaBytes: rec.giaBytes ? rec.giaBytes.slice() : null, savedAt: Date.now() }, RECOVERY_KEY));
    db.close();
    return true;
  } catch (e) {
    console.warn('persistence: recovery save failed', e);
    return false;
  }
}
export async function loadRecovery() {
  try {
    const db = await openDb();
    const rec = await tx(db, RECOVERY_STORE, 'readonly', (os) => os.get(RECOVERY_KEY));
    db.close();
    return rec || null;
  } catch { return null; }
}
export async function clearRecovery() {
  try {
    const db = await openDb();
    await tx(db, RECOVERY_STORE, 'readwrite', (os) => os.delete(RECOVERY_KEY));
    db.close();
  } catch {}
}
// backwards-compatible aliases
export const saveProject = saveRecovery;
export const loadProject = loadRecovery;
export const clearProject = clearRecovery;

// ---------- saved projects ----------
// Migrate an older record to the current schema (add cases as the schema grows).
export function migrateRecord(rec) {
  if (!rec) return rec;
  const r = { ...rec };
  if (!r.schema) r.schema = 1;
  if (!r.createdAt) r.createdAt = r.modifiedAt || Date.now();
  if (!r.meta) r.meta = {};
  if (!r.ui) r.ui = null;
  return r;
}

export async function listProjects() {
  try {
    const db = await openDb();
    const all = await tx(db, PROJECTS_STORE, 'readonly', (os) => os.getAll());
    db.close();
    return (all || []).map(migrateRecord).map(({ project, giaBytes, ui, ...summary }) => summary).sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  } catch { return []; }
}
export async function getProject(id) {
  try {
    const db = await openDb();
    const rec = await tx(db, PROJECTS_STORE, 'readonly', (os) => os.get(id));
    db.close();
    return rec ? migrateRecord(rec) : null;
  } catch { return null; }
}
// Throws on failure (quota errors included) so the caller can report it.
export async function putProject(rec) {
  const db = await openDb();
  try {
    await tx(db, PROJECTS_STORE, 'readwrite', (os) => os.put({ ...rec, giaBytes: rec.giaBytes ? rec.giaBytes.slice() : null }));
  } finally { db.close(); }
  return rec.id;
}
export async function deleteProject(id) {
  try {
    const db = await openDb();
    await tx(db, PROJECTS_STORE, 'readwrite', (os) => os.delete(id));
    db.close();
    return true;
  } catch { return false; }
}
export async function countProjects() { return (await listProjects()).length; }

export function newProjectId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// ---------- small preferences (localStorage) ----------
export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
export function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}
export function updatePrefs(patch) {
  const p = { ...loadPrefs(), ...patch };
  savePrefs(p);
  return p;
}
