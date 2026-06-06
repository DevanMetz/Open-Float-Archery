const CACHE_NAME = "openfloat-v94";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.json",
  "./icon.svg",
  "./Blender/BowModel.glb",
  "./app/main.js",
  "./app/core/db.js",
  "./app/core/store.js",
  "./app/device/adapters.js",
  "./app/protocol/frame.js",
  "./app/protocol/trace.js",
  "./app/telemetry/telemetry.js",
  "./app/telemetry/sync.js",
  "./app/ui/dashboard.js",
  "./app/ui/trace-preview.js",
  "./app/ui/training.js"
];

// Install Event
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event with Stale-While-Revalidate and ignoreSearch
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  
  const url = new URL(event.request.url);
  const isLocal = url.origin === self.location.origin;
  
  if (!isLocal) return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback to cache if network fails
      });

      return cachedResponse || fetchPromise;
    })
  );
});
