import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
const cacheName = source.match(/const CACHE_NAME = "([^"]+)"/)[1];
const origin = "http://localhost:4178";

function workerFixture() {
  const handlers = new Map(), stores = new Map(), writes = [], deleted = [];
  let openError = null;
  let network = async () => { throw new Error("Offline"); };
  let write = async (cache, key, response) => cache.set(key, response);
  const keyFor = (request) => typeof request === "string" ? request : request.url;
  const cacheFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      match: async (request, options = {}) => {
        const key = keyFor(request);
        if (entries.has(key)) return entries.get(key).clone();
        if (options.ignoreSearch) {
          const path = (url) => new URL(url).origin + new URL(url).pathname;
          for (const [url, response] of entries) {
            if (path(key) === path(url)) return response.clone();
          }
        }
      },
      put: async (request, response) => {
        const key = keyFor(request);
        writes.push(key);
        await write(entries, key, response);
      },
      addAll: async (requests) => {
        for (const item of requests) {
          const request = item instanceof Request ? item : new Request(new URL(item, `${origin}/service-worker.js`));
          const response = await network(request);
          if (!response.ok) throw new Error(`Precache HTTP ${response.status}`);
          entries.set(request.url, response);
        }
      },
    };
  };
  const caches = {
    open: async (name) => {
      if (openError) throw openError;
      return cacheFor(name);
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => { deleted.push(name); return stores.delete(name); },
    match: async (request, options) => {
      for (const name of stores.keys()) {
        const response = await cacheFor(name).match(request, options);
        if (response) return response;
      }
    },
  };
  runInNewContext(source, {
    URL, Request, Response, caches, fetch: (request) => network(request),
    self: { location: { origin, href: `${origin}/service-worker.js` }, clients: { claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (type, handler) => handlers.set(type, handler) },
  });
  return {
    stores, writes, deleted, cacheFor,
    network: (action) => { network = action; },
    denyCache: () => { openError = new Error("Cache unavailable"); },
    write: (action) => { write = action; },
    fetch: async (path, options) => {
      let response;
      const lifetimes = [];
      handlers.get("fetch")({
        request: new Request(new URL(path, origin), options),
        respondWith: (pending) => { response = pending; },
        waitUntil: (pending) => lifetimes.push(pending),
      });
      return { response: await response, lifetimes };
    },
    activate: async () => {
      const pending = [];
      handlers.get("activate")({ waitUntil: (promise) => pending.push(promise) });
      await Promise.all(pending);
    },
    install: async () => {
      const pending = [];
      handlers.get("install")({ waitUntil: (promise) => pending.push(promise) });
      await Promise.all(pending);
    },
  };
}

test("a new build precaches fresh assets and Guide pages instead of a stale HTTP cache", async () => {
  const worker = workerFixture();
  const requests = [];
  worker.network(async (input) => {
    const request = input instanceof Request ? input : new Request(new URL(input, `${origin}/service-worker.js`));
    requests.push(request);
    if (new URL(request.url).pathname === "/docs/index.json") {
      return new Response(JSON.stringify({ tree: [{ type: "file", id: "quick-start", path: "docs/quick-start.md" }] }));
    }
    return new Response(request.cache === "reload" ? "Current deployment" : "Stale HTTP copy");
  });
  await worker.install();
  for (const path of ["/app/main.js", "/styles.css", "/docs/quick-start.md"]) {
    const response = await worker.cacheFor(cacheName).match(`${origin}${path}`);
    assert.ok(response, `${path} was not precached`);
    assert.equal(await response.text(), "Current deployment", `${path} reused stale content`);
  }
  assert.ok(requests.length > 40 && requests.every((request) => request.cache === "reload"));
});

test("offline fallback reads only the current OpenFloat cache and resolves versioned assets", async () => {
  const worker = workerFixture();
  await worker.cacheFor("another-app").put(`${origin}/app/main.js`, new Response("Unrelated app"));
  await worker.cacheFor(cacheName).put(`${origin}/app/main.js`, new Response("Current build"));
  const { response } = await worker.fetch("/app/main.js?v=new-build");
  assert.equal(await response.text(), "Current build");
});

test("an HTTP server error falls back to the cached app without replacing it", async () => {
  const worker = workerFixture();
  await worker.cacheFor(cacheName).put(`${origin}/`, new Response("Range dashboard"));
  worker.network(async () => new Response("Unavailable", { status: 503 }));
  const { response } = await worker.fetch("/");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Range dashboard");
  assert.equal(worker.writes.length, 1);
});

test("a server error without a cached file preserves its HTTP status", async () => {
  const worker = workerFixture();
  worker.network(async () => new Response("Try later", { status: 502 }));
  const { response } = await worker.fetch("/missing.js");
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Try later");
});

test("offline requests without a cached file return a network error response", async () => {
  const { response } = await workerFixture().fetch("/missing.js");
  assert.equal(response.type, "error");
  assert.equal(response.status, 0);
});

test("a deleted asset's 404 is not hidden by an old cached response", async () => {
  const worker = workerFixture();
  await worker.cacheFor(cacheName).put(`${origin}/removed.js`, new Response("Old module"));
  worker.network(async () => new Response("Not found", { status: 404 }));
  const { response } = await worker.fetch("/removed.js");
  assert.equal(response.status, 404);
});

test("cache writes extend the fetch lifetime without delaying the network response", async () => {
  const worker = workerFixture();
  let finish;
  worker.write(() => new Promise((resolve) => { finish = resolve; }));
  worker.network(async () => new Response("Fresh dashboard"));
  const { response, lifetimes } = await worker.fetch("/");
  assert.equal(await response.text(), "Fresh dashboard");
  assert.equal(lifetimes.length, 1, "Worker can be terminated before saving the offline copy");
  finish();
  await Promise.all(lifetimes);
});

test("cache write failure leaves the network response usable and settles its lifetime", async () => {
  const worker = workerFixture();
  worker.write(async () => { throw new Error("Quota exceeded"); });
  worker.network(async () => new Response("Fresh dashboard"));
  const { response, lifetimes } = await worker.fetch("/");
  assert.equal(await response.text(), "Fresh dashboard");
  assert.equal(lifetimes.length, 1);
  await Promise.all(lifetimes);
});

test("unavailable cache storage preserves network responses and handles offline misses", async () => {
  const worker = workerFixture();
  worker.denyCache();
  worker.network(async () => new Response("Live page"));
  let result = await worker.fetch("/");
  assert.equal(await result.response.text(), "Live page");
  await Promise.all(result.lifetimes);
  worker.network(async () => new Response("Try later", { status: 503 }));
  result = await worker.fetch("/");
  assert.equal(result.response.status, 503);
  worker.network(async () => { throw new Error("Offline"); });
  result = await worker.fetch("/");
  assert.equal(result.response.type, "error");
});

test("activation removes obsolete OpenFloat caches and preserves other applications", async () => {
  const worker = workerFixture();
  worker.cacheFor("openfloat-v1");
  worker.cacheFor(cacheName);
  worker.cacheFor("another-app");
  await worker.activate();
  assert.deepEqual(worker.deleted, ["openfloat-v1"]);
  assert.ok(worker.stores.has(cacheName));
  assert.ok(worker.stores.has("another-app"));
});

test("cross-origin requests and POSTs remain outside the offline cache", async () => {
  const worker = workerFixture();
  assert.equal((await worker.fetch("https://example.com/module.js")).response, undefined);
  assert.equal((await worker.fetch("/", { method: "POST" })).response, undefined);
  assert.deepEqual(worker.writes, []);
});
