/* =============================================================================
   PidiFie – Storage Module
   Manages all persistence via IndexedDB:
     - Recent files list (name, last page, date opened)
     - Annotation data per file
     - Saved signature
     - App preferences (theme, zoom)
   ============================================================================= */

const Storage = (() => {
  const DB_NAME    = 'pdfy-db';
  const DB_VERSION = 1;

  const STORES = {
    PREFS:       'preferences',
    RECENT:      'recentFiles',
    ANNOTATIONS: 'annotations',
    SIGNATURE:   'signature',
  };

  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (db) { resolve(db); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORES.PREFS)) {
          d.createObjectStore(STORES.PREFS, { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains(STORES.RECENT)) {
          const rs = d.createObjectStore(STORES.RECENT, { keyPath: 'name' });
          rs.createIndex('openedAt', 'openedAt');
        }
        if (!d.objectStoreNames.contains(STORES.ANNOTATIONS)) {
          d.createObjectStore(STORES.ANNOTATIONS, { keyPath: 'name' });
        }
        if (!d.objectStoreNames.contains(STORES.SIGNATURE)) {
          d.createObjectStore(STORES.SIGNATURE, { keyPath: 'id' });
        }
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function put(storeName, value) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx  = d.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function get(storeName, key) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx  = d.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function getAll(storeName) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx  = d.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function remove(storeName, key) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx  = d.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  // ── Preferences ───────────────────────────────────────────────────────────
  async function getPref(key, defaultValue = null) {
    const rec = await get(STORES.PREFS, key);
    return rec ? rec.value : defaultValue;
  }

  async function setPref(key, value) {
    return put(STORES.PREFS, { key, value });
  }

  // ── Recent files ──────────────────────────────────────────────────────────
  async function touchRecentFile(name, lastPage, totalPages) {
    return put(STORES.RECENT, {
      name, lastPage, totalPages,
      openedAt: Date.now(),
    });
  }

  async function getRecentFiles() {
    const all = await getAll(STORES.RECENT);
    return all.sort((a, b) => b.openedAt - a.openedAt).slice(0, 8);
  }

  async function removeRecentFile(name) {
    return remove(STORES.RECENT, name);
  }

  // ── Annotations ───────────────────────────────────────────────────────────
  async function saveAnnotations(name, annotationMap) {
    return put(STORES.ANNOTATIONS, { name, data: annotationMap, savedAt: Date.now() });
  }

  async function loadAnnotations(name) {
    const rec = await get(STORES.ANNOTATIONS, name);
    return rec ? rec.data : null;
  }

  // ── Signature ─────────────────────────────────────────────────────────────
  async function saveSignature(dataUrl) {
    return put(STORES.SIGNATURE, { id: 'saved', dataUrl });
  }

  async function loadSignature() {
    const rec = await get(STORES.SIGNATURE, 'saved');
    return rec ? rec.dataUrl : null;
  }

  async function clearSignature() {
    return remove(STORES.SIGNATURE, 'saved');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    open,
    getPref, setPref,
    touchRecentFile, getRecentFiles, removeRecentFile,
    saveAnnotations, loadAnnotations,
    saveSignature, loadSignature, clearSignature,
  };
})();
