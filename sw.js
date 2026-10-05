/* =============================================================================
   PDFy Service Worker
   Provides offline capability and caching for the PWA.
   Strategy: Cache-first for static assets, network-first for CDN libraries.
   ============================================================================= */

const CACHE_VERSION = 'pdfy-v2';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const CDN_CACHE    = `${CACHE_VERSION}-cdn`;

// App shell files (always cached)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/main.css',
  '/js/storage.js',
  '/js/search.js',
  '/js/annotations.js',
  '/js/textSelection.js',
  '/js/signature.js',
  '/js/pageTools.js',
  '/js/pdfViewer.js',
  '/js/app.js',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// CDN resources to cache on first use
const CDN_PATTERNS = [
  'cdnjs.cloudflare.com',
];

// ── Install: cache app shell ──────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      // Cache what's available; don't fail on missing icons during dev
      return Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !k.startsWith(CACHE_VERSION))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: serve from cache ─────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin data (blobs, etc.)
  if (request.method !== 'GET') return;
  if (url.protocol === 'blob:') return;

  // CDN resources: cache-first, then network
  if (CDN_PATTERNS.some(p => url.hostname.includes(p))) {
    event.respondWith(cdnFirst(request));
    return;
  }

  // App shell: cache-first
  event.respondWith(cacheFirst(request));
});

/**
 * Cache-first strategy
 * Tries cache, falls back to network, caches new responses.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline fallback: return index.html for navigate requests
    if (request.mode === 'navigate') {
      return caches.match('/index.html');
    }
    throw new Error('Offline and not cached');
  }
}

/**
 * CDN-first strategy: check cache, then network, cache on success.
 */
async function cdnFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CDN_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    throw new Error('CDN resource not available offline');
  }
}
