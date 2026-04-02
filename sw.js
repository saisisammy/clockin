/* ═══════════════════════════════════════════════════════════════════
   EduTrack Service Worker  —  sw.js
   Strategies:
     • App shell  → Cache-first  (HTML, fonts, CDN libs)
     • Firebase   → Network-first with cache fallback
     • API writes → Background Sync queue (IndexedDB)
   ═══════════════════════════════════════════════════════════════════ */

const APP_VERSION  = 'v1';
const CACHE_SHELL  = `edutrack-shell-${APP_VERSION}`;
const CACHE_CDN    = `edutrack-cdn-${APP_VERSION}`;
const CACHE_FONTS  = `edutrack-fonts-${APP_VERSION}`;
const DB_NAME      = 'edutrack-offline';
const DB_VERSION   = 1;
const STORE_QUEUE  = 'sync-queue';
const SYNC_TAG     = 'edutrack-attendance-sync';

/* ── App shell: pages served immediately from cache ── */
const SHELL_ASSETS = [
  './index.html',
  './superadmin.html',
  './manifest.json'
];

/* ── CDN scripts cached on first fetch, served from cache thereafter ── */
const CDN_PATTERNS = [
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

/* ── Firebase / Firestore domains  →  network-first ── */
const FIREBASE_PATTERNS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
  'firebase.googleapis.com',
  'gstatic.com/firebasejs'
];

/* ═══════════════════════════════════════════════════════════════════
   INSTALL — pre-cache the app shell
   ═══════════════════════════════════════════════════════════════════ */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Shell pre-cache failed:', err))
  );
});

/* ═══════════════════════════════════════════════════════════════════
   ACTIVATE — delete stale caches, claim clients
   ═══════════════════════════════════════════════════════════════════ */
self.addEventListener('activate', event => {
  const LIVE = [CACHE_SHELL, CACHE_CDN, CACHE_FONTS];

  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => !LIVE.includes(k))
            .map(k => {
              console.log('[SW] Removing stale cache:', k);
              return caches.delete(k);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ═══════════════════════════════════════════════════════════════════
   FETCH — routing
   ═══════════════════════════════════════════════════════════════════ */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Only handle GET and POST; ignore chrome-extension etc. */
  if (!['http:', 'https:'].includes(url.protocol)) return;

  /* ── 1. Firebase / Firestore  →  Network-first ── */
  if (FIREBASE_PATTERNS.some(p => url.href.includes(p))) {
    event.respondWith(networkFirstFirebase(request));
    return;
  }

  /* ── 2. CDN assets  →  Cache-first ── */
  if (CDN_PATTERNS.some(p => url.hostname.includes(p))) {
    const cacheName = url.hostname.includes('gstatic') ? CACHE_FONTS : CACHE_CDN;
    event.respondWith(cacheFirst(request, cacheName));
    return;
  }

  /* ── 3. App shell pages  →  Cache-first with network fallback ── */
  if (request.mode === 'navigate' ||
      SHELL_ASSETS.some(a => url.pathname.endsWith(a.replace('./', '')))) {
    event.respondWith(shellFirst(request));
    return;
  }

  /* ── 4. Everything else  →  stale-while-revalidate ── */
  event.respondWith(staleWhileRevalidate(request));
});

/* ═══════════════════════════════════════════════════════════════════
   STRATEGY HELPERS
   ═══════════════════════════════════════════════════════════════════ */

/** Cache-first: serve from cache; if missing, fetch and store */
async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request.clone());
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (_) {
    return new Response('Offline – resource not cached', { status: 503 });
  }
}

/** Network-first: try network; on failure, fall back to cache */
async function networkFirstFirebase(request) {
  try {
    const response = await fetch(request.clone());
    /* Cache successful GET responses for offline reads */
    if (request.method === 'GET' && response.ok) {
      const cache = await caches.open(CACHE_SHELL);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'offline', message: 'No network. Data will sync when reconnected.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/** Shell-first: serve app shell from cache; fall back to network then offline page */
async function shellFirst(request) {
  const cache  = await caches.open(CACHE_SHELL);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request.clone());
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (_) {
    /* Last resort: serve index.html for any navigation */
    const fallback = await cache.match('./index.html');
    return fallback || new Response('<h1>EduTrack is offline</h1>', {
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

/** Stale-while-revalidate: serve cache immediately; refresh in background */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_CDN);
  const cached = await cache.match(request);

  const networkFetch = fetch(request.clone())
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);

  return cached || networkFetch;
}

/* ═══════════════════════════════════════════════════════════════════
   OFFLINE QUEUE  — IndexedDB helpers
   Used by the page to persist attendance writes when offline.
   The page calls postMessage({ type:'QUEUE_WRITE', payload:{...} })
   ═══════════════════════════════════════════════════════════════════ */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const store = db.createObjectStore(STORE_QUEUE, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

async function enqueue(payload) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_QUEUE, 'readwrite');
    const store = tx.objectStore(STORE_QUEUE);
    const req   = store.add({ ...payload, ts: Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dequeueAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_QUEUE, 'readonly');
    const store = tx.objectStore(STORE_QUEUE);
    const req   = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function removeFromQueue(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_QUEUE, 'readwrite');
    const store = tx.objectStore(STORE_QUEUE);
    const req   = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

/* ═══════════════════════════════════════════════════════════════════
   MESSAGE HANDLER  — communication from page
   ═══════════════════════════════════════════════════════════════════ */
self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};

  switch (type) {

    /* Page requests to queue an offline write */
    case 'QUEUE_WRITE': {
      const id = await enqueue(payload);
      console.log('[SW] Queued offline write:', id, payload.collection);
      /* Register a Background Sync so we retry as soon as online */
      if (self.registration.sync) {
        await self.registration.sync.register(SYNC_TAG).catch(() => {});
      }
      event.source?.postMessage({ type: 'QUEUED', id });
      break;
    }

    /* Page asks how many items are pending */
    case 'QUEUE_COUNT': {
      const items = await dequeueAll();
      event.source?.postMessage({ type: 'QUEUE_COUNT_RESULT', count: items.length });
      break;
    }

    /* Page forces a manual flush (e.g. user taps "Sync now") */
    case 'FLUSH_QUEUE': {
      const synced = await flushQueue();
      event.source?.postMessage({ type: 'FLUSH_DONE', synced });
      break;
    }

    /* Page asks SW to skip waiting (new version ready) */
    case 'SKIP_WAITING': {
      self.skipWaiting();
      break;
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════
   BACKGROUND SYNC  — flush queued Firestore writes
   ═══════════════════════════════════════════════════════════════════ */
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(flushQueue());
  }
});

/**
 * Iterate queued writes and replay them against the Firestore REST API.
 * Each queue item must have:
 *   { collection, docId, data, projectId, apiKey }
 */
async function flushQueue() {
  const items = await dequeueAll();
  if (!items.length) return 0;

  let synced = 0;
  for (const item of items) {
    try {
      await replayFirestoreWrite(item);
      await removeFromQueue(item.id);
      synced++;
      console.log('[SW] Synced queued write:', item.id, item.collection);
    } catch (err) {
      console.warn('[SW] Failed to sync item', item.id, '— will retry:', err.message);
      /* Leave it in the queue; Background Sync will retry */
    }
  }

  /* Notify all open windows */
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'SYNC_COMPLETE', synced, remaining: items.length - synced }));

  return synced;
}

/**
 * Replay a single Firestore write via the REST API.
 * Supports setDoc (PATCH) with merge semantics.
 */
async function replayFirestoreWrite(item) {
  const { collection: col, docId, data, projectId, apiKey } = item;

  /* Build Firestore REST URL */
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const url  = `${base}/${col}/${docId}?key=${apiKey}`;

  /* Convert plain JS object to Firestore field-value format */
  const fields = toFirestoreFields(data);

  const response = await fetch(url, {
    method : 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ fields })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firestore REST error ${response.status}: ${text}`);
  }
}

/** Convert a flat JS object → Firestore REST field-value map */
function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) {
    fields[key] = toFirestoreValue(val);
  }
  return fields;
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number')           return Number.isInteger(val)
    ? { integerValue: String(val) }
    : { doubleValue: val };
  if (typeof val === 'string')           return { stringValue: val };
  if (val instanceof Date)               return { timestampValue: val.toISOString() };
  if (Array.isArray(val))                return {
    arrayValue: { values: val.map(toFirestoreValue) }
  };
  if (typeof val === 'object')           return {
    mapValue: { fields: toFirestoreFields(val) }
  };
  return { stringValue: String(val) };
}

/* ═══════════════════════════════════════════════════════════════════
   PUSH NOTIFICATIONS  (placeholder — enable if you add web-push)
   ═══════════════════════════════════════════════════════════════════ */
self.addEventListener('push', event => {
  if (!event.data) return;
  const { title = 'EduTrack', body = '', icon = './manifest.json' } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge : icon,
      vibrate: [100, 50, 100],
      data  : { url: self.location.origin }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const win = list.find(c => c.url.startsWith(self.location.origin));
      return win ? win.focus() : clients.openWindow(self.location.origin);
    })
  );
});
