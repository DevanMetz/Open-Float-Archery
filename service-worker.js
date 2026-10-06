const CACHE_NAME = "openfloat-v200";
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
  "./vendor/three/build/three.module.min.js",
  "./vendor/three/examples/jsm/loaders/GLTFLoader.js",
  "./vendor/three/examples/jsm/controls/OrbitControls.js",
  "./vendor/three/examples/jsm/utils/BufferGeometryUtils.js",
  "./app/main.js",
  "./app/data/sample-data.js",
  "./app/data/sample-shots-data.js",
  "./app/core/db.js",
  "./app/core/saved-data.js",
  "./app/core/store.js",
  "./app/device/adapters.js",
  "./app/protocol/frame.js",
  "./app/protocol/trace.js",
  "./app/telemetry/telemetry.js",
  "./app/telemetry/score.js",
  "./app/telemetry/range.js",
  "./app/telemetry/outcome.js",
  "./app/telemetry/sync.js",
  "./app/ui/dashboard.js",
  "./app/ui/bow-profiles.js",
  "./app/ui/browser-support.js",
  "./app/ui/bow-3d.js",
  "./app/ui/trace-chart.js",
  "./app/ui/trace-phases.js",
  "./app/ui/replay.js",
  "./app/ui/data-backup.js",
  "./app/ui/download.js",
  "./app/ui/history.js",
  "./app/ui/impact-target.js",
  "./app/ui/session-review.js",
  "./app/ui/trace-preview.js",
  "./app/ui/training.js",
  "./app/ui/training-coach.js",
  "./app/ui/guide.js",
  "./docs/index.json",
  "./docs/images/dashboard-live.png"
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

// A new deployment must not populate its offline cache with an older, still
// fresh HTTP response for an unversioned asset or Markdown page.
function freshRequest(path) {
  return new Request(new URL(path, self.location.href), { cache: "reload" });
}

// Precache all Markdown pages listed in docs/index.json so the Guide works
// fully offline. New pages are picked up on the next service-worker version.
async function precacheDocs(cache) {
  try {
    const res = await fetch(freshRequest("./docs/index.json"));
    if (!res.ok) return;
    const data = await res.json();
    const paths = collectDocPaths(data.tree, []);
    if (paths.length) await cache.addAll(paths.map(freshRequest));
  } catch (err) {
    // Offline or missing index: live pages still cache on first fetch.
  }
}

// Install Event
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(ASSETS.map(freshRequest));
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
          if (key.startsWith("openfloat-v") && key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

function cacheResponse(event, response) {
  if (!response || response.status !== 200) return response;
  const responseToCache = response.clone();
  // Keep the worker alive until the offline copy is committed. Storage limits
  // must not turn a successful network response into a failed page load.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.put(event.request, responseToCache))
      .catch(() => {})
  );
  return response;
}

async function cachedFallback(request, networkResponse = null) {
  try {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) ||
      (await cache.match(request, { ignoreSearch: true })) ||
      networkResponse || Response.error();
  } catch (_) {
    return networkResponse || Response.error();
  }
}

// Fetch Event: network-first for same-origin assets, cached fallback offline.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const isLocal = url.origin === self.location.origin;

  if (!isLocal) return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => networkResponse.status >= 500
        ? cachedFallback(event.request, networkResponse)
        : cacheResponse(event, networkResponse))
      .catch(() => cachedFallback(event.request))
  );
});
