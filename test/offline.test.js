import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const root = new URL("../", import.meta.url);
const worker = readFileSync(new URL("service-worker.js", root), "utf8");
const assets = JSON.parse(worker.match(/const ASSETS = (\[[\s\S]*?\]);/)[1]);
const cached = new Set(assets.map((path) => new URL(path, root).href));

test("every precached asset exists in the shipped static site", () => {
  for (const path of assets) {
    const file = new URL(path === "./" ? "index.html" : path, root);
    assert.ok(statSync(file).isFile(), `Missing precache asset: ${path}`);
  }
});

test("the complete 3D renderer module graph stays local and precached", async () => {
  const bowModule = new URL("app/ui/bow-3d.js", root);
  const bowSource = readFileSync(bowModule, "utf8");
  const rendererModules = [...bowSource.matchAll(/const \w+_URL = "([^"]+\.js)"/g)]
    .map((match) => new URL(match[1], bowModule));
  assert.equal(rendererModules.length, 3, "Expected renderer, loader, and controls entry points");
  const pending = [...rendererModules];
  const visited = new Set();
  while (pending.length) {
    const url = pending.pop();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    assert.ok(url.href.startsWith(root.href), `External renderer dependency: ${url}`);
    assert.ok(cached.has(url.href), `Renderer dependency is not precached: ${url}`);
    const source = readFileSync(url, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*import\s*(?:[\w$*{},\s]+\bfrom\s*)?['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith("."), `Unresolved module import: ${match[1]}`);
      pending.push(new URL(match[1], url));
    }
  }
  // Importing in Node also catches broken local specifiers and syntax without
  // creating a renderer or relying on WebGL in the test environment.
  const modules = await Promise.all(rendererModules.map((url) => import(url.href)));
  assert.ok(modules.every((module) => Object.keys(module).length > 0));
});

test("the bow GLB keeps image and buffer resources embedded for offline use", () => {
  const model = readFileSync(new URL("Blender/BowModel.glb", root));
  assert.equal(model.toString("ascii", 0, 4), "glTF");
  assert.equal(model.toString("ascii", 16, 20), "JSON");
  const json = JSON.parse(model.toString("utf8", 20, 20 + model.readUInt32LE(12)));
  for (const resource of [...(json.buffers || []), ...(json.images || [])]) {
    assert.ok(!resource.uri || resource.uri.startsWith("data:"), `External model resource: ${resource.uri}`);
  }
});
