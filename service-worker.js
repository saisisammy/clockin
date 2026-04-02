// Service Worker for EduTrack PWA
const CACHE_NAME = 'edutrack-v1';
const OFFLINE_PAGE = '/?offline=true';

// Files to cache on install
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/superadmin.html',
  // Cache external resources
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.6.0/jspdf.plugin.autotable.min.js'
];

// Install event - cache resources
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching app resources');
      return cache.addAll(URLS_TO_CACHE).catch((err) => {
        console.warn('Some resources failed to cache:', err);
        // Cache what we can, don't fail on missing resources
        return cache.addAll(
          URLS_TO_CACHE.filter(url => !url.startsWith('https://'))
        );
      });
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache, fall back to network
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip Firebase and external API calls - let them through
  const url = new URL(event.request.url);
  if (url.origin === 'https://www.gstatic.com' ||
      url.hostname.includes('firebasestorage') ||
      url.hostname.includes('firebaseapp.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache successful responses
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Return cached version if offline
          return caches.match(event.request);
        })
    );
    return;
  }

  // For HTML documents, use network-first strategy
  if (event.request.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache successful responses
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Serve from cache on offline
          return caches.match(event.request).then((cached) => {
            if (cached) {
              return cached;
            }
            // Return offline message if not cached
            return new Response(
              '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Offline</title><style>body{font-family:system-ui;background:#0b1120;color:#e2e8f0;height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:20px}div{text-align:center;max-width:500px}h1{font-size:32px;margin-bottom:16px;color:#0fd4c0}p{font-size:16px;color:#94a3b8;line-height:1.6;margin-bottom:24px}button{background:#0fd4c0;color:#0b1120;border:none;padding:12px 32px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:all .3s}button:hover{background:#0dd9b0;transform:scale(1.05)}</style></head><body><div><h1>📶 You are Offline</h1><p>EduTrack is working offline mode. Most features are available, but online features requiring internet connection will be limited.</p><p>Your data will sync when you\'re back online.</p><button onclick="location.reload()">Try Again</button></div></body></html>',
              {
                status: 200,
                headers: { 'Content-Type': 'text/html' }
              }
            );
          });
        })
    );
    return;
  }

  // For other requests, use cache-first strategy
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Fetch in background to update cache
        fetch(event.request)
          .then((response) => {
            if (response.status === 200) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, response.clone());
              });
            }
          })
          .catch(() => {
            // Silent failure, use cached version
          });
        return cached;
      }
      return fetch(event.request).catch(() => {
        // If not in cache and fetch fails, return null
        return new Response('Resource not available offline', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers({
            'Content-Type': 'text/plain'
          })
        });
      });
    })
  );
});

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
