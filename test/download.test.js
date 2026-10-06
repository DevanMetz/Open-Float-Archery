import test from "node:test";
import assert from "node:assert/strict";
import { downloadJson, exportFileStamp } from "../app/ui/download.js";

function fixture(t, failure) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const link = { attached: false, removed: false, clicks: 0,
    click() { assert.equal(this.attached, true); this.clicks++; if (failure === "click") throw new Error("Click blocked"); },
    remove() { this.removed = true; this.attached = false; },
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement(tag) { assert.equal(tag, "a"); if (failure === "create") throw new Error("Create blocked"); return link; },
    body: { appendChild(node) { assert.equal(node, link); if (failure === "append") throw new Error("Append blocked"); node.attached = true; } },
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else delete globalThis.document; });
  const blobs = [], releases = [], revoked = [];
  t.mock.method(URL, "createObjectURL", (blob) => { blobs.push(blob); return "blob:export"; });
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  t.mock.method(globalThis, "setTimeout", (action, ms) => { releases.push({ action, ms }); });
  return { link, blobs, releases, revoked };
}

test("JSON downloads keep their payload and release resources after the browser starts reading", async (t) => {
  const f = fixture(t);
  const payload = { format: "openfloat-shot-export", shot: { id: "arrow", label: "A \"quoted\" capture" } };
  downloadJson(payload, "arrow.json", 2);
  assert.equal(f.link.href, "blob:export");
  assert.equal(f.link.download, "arrow.json");
  assert.equal(f.link.clicks, 1);
  assert.equal(f.link.removed, true);
  assert.equal(f.blobs[0].type, "application/json");
  assert.deepEqual(JSON.parse(await f.blobs[0].text()), payload);
  assert.ok((await f.blobs[0].text()).includes("\n  \"format\""));
  assert.deepEqual(f.revoked, []);
  assert.equal(f.releases[0].ms, 1000);
  f.releases[0].action();
  assert.deepEqual(f.revoked, ["blob:export"]);
});

for (const phase of ["create", "append", "click"]) {
  test(`failed JSON download ${phase} cleans up its allocated URL and link`, (t) => {
    const f = fixture(t, phase);
    assert.throws(() => downloadJson({ id: "capture" }, "capture.json"), /blocked/);
    if (phase !== "create") assert.equal(f.link.removed, true);
    assert.equal(f.link.attached, false);
    assert.deepEqual(f.revoked, []);
    assert.equal(f.releases.length, 1);
    f.releases[0].action();
    assert.deepEqual(f.revoked, ["blob:export"]);
  });
}

test("JSON serialization failures allocate no download resources", (t) => {
  const f = fixture(t);
  const circular = {}; circular.self = circular;
  assert.throws(() => downloadJson(circular, "invalid.json"), TypeError);
  assert.equal(f.blobs.length, 0);
  assert.equal(f.link.clicks, 0);
  assert.equal(f.releases.length, 0);
});

test("export filenames use UTC capture times and label unavailable times as undated", () => {
  assert.equal(exportFileStamp("2026-01-01T12:34:56-06:00"), "2026-01-01-18-34-56");
  assert.equal(exportFileStamp("+010000-01-01T00:00:00Z"), "+010000-01-01-00-00-00");
  for (const value of [undefined, null, "", " ", "bad", false, 0, [], {}]) assert.equal(exportFileStamp(value), "undated");
});
