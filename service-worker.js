const CACHE_NAME = "openfloat-v127";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./theme-graph-paper.css",
  "./manifest.json",
  "./favicon.ico",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./Blender/BowModel.glb",
  "./app/main.js",
  "./app/data/sample-data.js",
  "./app/data/sample-shots-data.js",
  "./app/core/db.js",
  "./app/core/store.js",
  "./app/device/adapters.js",
  "./app/protocol/frame.js",
  "./app/protocol/trace.js",
  "./app/telemetry/telemetry.js",
  "./app/telemetry/score.js",
  "./app/telemetry/sync.js",
  "./app/ui/dashboard.js",
  "./app/ui/bow-3d.js",
  "./app/ui/trace-chart.js",
  "./app/ui/data-backup.js",
  "./app/ui/history.js",
  "./app/ui/session-review.js",
  "./app/ui/trace-preview.js",
  "./app/ui/training.js",
  "./app/ui/guide.js",
  "./docs/index.json"
];

// Collect every Markdown file path from the generated docs index tree.
function collectDocPaths(nodes, out) {
  (nodes || []).forEach((node) => {
    if (node.type === "folder") {
      collectDocPaths(node.children, out);
    } else if (node.type === "file" && node.path) {
      out.push(`./${node.path}`);
    }
  });
  return out;
}

// Precache all Markdown pages listed in docs/index.json so the Guide works
// fully offline. New pages are picked up on the next service-worker version.
async function precacheDocs(cache) {
  try {
    const res = await fetch("./docs/index.json");
    if (!res.ok) return;
    const data = await res.json();
    const paths = collectDocPaths(data.tree, []);
    if (paths.length) await cache.addAll(paths);
  } catch (err) {
    // Offline or missing index: live pages still cache on first fetch.
  }
}

// Install Event
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(ASSETS);
      await precacheDocs(cache);
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

function cacheResponse(request, response) {
  if (!response || response.status !== 200) return response;
  const responseToCache = response.clone();
  caches.open(CACHE_NAME).then((cache) => {
    cache.put(request, responseToCache);
  });
  return response;
}

async function cachedFallback(request) {
  return (
    (await caches.match(request)) ||
    (await caches.match(request, { ignoreSearch: true })) ||
    Response.error()
  );
}

// Fetch Event: network-first for same-origin assets, cached fallback offline.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const isLocal = url.origin === self.location.origin;

  if (!isLocal) return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => cacheResponse(event.request, networkResponse))
      .catch(() => cachedFallback(event.request))
  );
});
