/* ═══════════════════════════════════════════════
   EduTrack Service Worker — v4
   Caches app shell + Firebase JS SDK
   Prevents blank page when offline
═══════════════════════════════════════════════ */
const CACHE_NAME = 'edutrack-v4';

// Core app shell — must be served from same origin
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json'
];

// External CDN resources to pre-cache (fonts + PDF libs)
const CDN_RESOURCES = [
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.6.0/jspdf.plugin.autotable.min.js'
];

// ── INSTALL: cache app shell immediately ──
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache app shell (critical — must succeed)
      return cache.addAll(APP_SHELL)
        .then(() => {
          // Cache CDN resources (non-critical — ignore failures)
          return Promise.allSettled(
            CDN_RESOURCES.map(url =>
              fetch(url, { mode: 'cors' })
                .then(res => { if (res.ok) cache.put(url, res); })
                .catch(() => {})
            )
          );
        })
        .catch(err => {
          // If even app shell cache fails (e.g. local file://), continue anyway
          console.warn('[SW] App shell cache failed:', err.message);
        });
    })
  );
});

// ── ACTIVATE: delete old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: Network-first for Firebase/API, Cache-first for app shell ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension, data URIs, blob URLs
  if (!url.protocol.startsWith('http')) return;

  // ── Firebase / Firestore / Google APIs → Network only (never cache live data) ──
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.hostname.includes('www.gstatic.com')
  ) {
    return; // Let browser handle it directly — no SW interference
  }

  // ── App shell (same-origin HTML/JS/CSS/manifest) → Cache-first, fallback to network ──
  if (url.origin === self.location.origin || url.hostname === self.location.hostname) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;

        return fetch(event.request)
          .then(response => {
            // Cache successful same-origin responses
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Offline fallback: serve index.html for navigation requests
            if (event.request.mode === 'navigate') {
              return caches.match('./index.html')
                || caches.match('./')
                || new Response(
                  offlinePage(),
                  { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                );
            }
            return new Response('', { status: 408 });
          });
      })
    );
    return;
  }

  // ── CDN resources (fonts, jsPDF) → Stale-while-revalidate ──
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => null);

      return cached || networkFetch || new Response('', { status: 408 });
    })
  );
});

// ── Minimal offline fallback page ──
function offlinePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EduTrack — Offline</title>
<style>
  body {
    margin:0; font-family: sans-serif;
    background:#0b1120; color:#e2e8f0;
    display:flex; flex-direction:column;
    align-items:center; justify-content:center;
    min-height:100vh; text-align:center; padding:24px;
  }
  .icon { font-size:60px; margin-bottom:20px; }
  h1 { font-size:22px; font-weight:800; margin:0 0 8px; }
  p { color:#64748b; font-size:14px; line-height:1.6; max-width:300px; }
  button {
    margin-top:24px; padding:12px 28px; border-radius:100px;
    background:#0fd4c0; color:#0b1120; font-size:14px;
    font-weight:700; border:none; cursor:pointer;
  }
</style>
</head>
<body>
  <div class="icon">📡</div>
  <h1>You're offline</h1>
  <p>EduTrack needs an internet connection to load for the first time. Please reconnect and try again.</p>
  <button onclick="location.reload()">↻ Retry</button>
</body>
</html>`;
}
