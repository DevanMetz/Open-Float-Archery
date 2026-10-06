import test from "node:test";
import assert from "node:assert/strict";
import { initDataBackup } from "../app/ui/data-backup.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const payload = { format: "openfloat-export", version: 1, stores: {
  shots: [{ id: "backup-shot" }], shot_traces: [], bow_profiles: [],
} };
const counts = { shots: 1, shot_traces: 0, bow_profiles: 0, sync_queue: 1 };
const file = (value = payload) => ({ text: async () => JSON.stringify(value) });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const document = { body: {} };
  document.activeElement = document.body;
  const el = Object.fromEntries(["exportDataBtn", "importDataBtn", "importDataInput", "dataBackupStatus"].map((id) => {
    let disabled = false;
    return [id, { ownerDocument: document, textContent: "", value: "", files: [], style: {}, events: {}, clicks: 0,
      get disabled() { return disabled; },
      set disabled(value) { disabled = value; if (value && document.activeElement === this) document.activeElement = document.body; },
      addEventListener(type, handler) { this.events[type] = handler; },
      click() { this.clicks++; return this.events.click?.(); },
      focus() { document.activeElement = this; }, getClientRects: () => [{}],
    }];
  }));
  const imports = [], downloads = [], logs = [];
  const database = { exportAllData: async () => payload,
    importAllData: async (record, settings) => { imports.push({ record, settings }); return counts; }, ...options.database };
  const ui = initDataBackup({ ...options, el, database, bus: { emit: (_event, message) => logs.push(message) },
    download: options.defaultDownload ? undefined : options.download || (async (record) => { downloads.push(record); }) });
  return { ui, el, database, document, imports, downloads, logs,
    select(inputFile) { el.importDataInput.value = "selected.json"; el.importDataInput.files = inputFile ? [inputFile] : [];
      return el.importDataInput.events.change({ target: el.importDataInput }); },
  };
}

test("backup actions stay locked from file reading through the committed import's refresh", async () => {
  const reading = deferred(), committing = deferred(), refreshing = deferred();
  let reads = 0, writes = 0;
  const f = fixture({ database: { importAllData: () => { writes++; return committing.promise; } },
    onImportComplete: () => refreshing.promise });
  const inputFile = { text: () => { reads++; return reading.promise; } };
  f.el.importDataBtn.focus();
  const importing = f.select(inputFile);
  assert.ok(f.el.exportDataBtn.disabled && f.el.importDataBtn.disabled && f.el.importDataInput.disabled);
  assert.equal(f.el.importDataInput.value, "", "File can be selected again after a failure");
  await Promise.all([f.select(inputFile), f.ui.exportData(), f.el.importDataBtn.click()]);
  assert.equal(reads, 1);
  assert.equal(f.el.importDataInput.clicks, 0);
  reading.resolve(JSON.stringify(payload));
  await flush();
  assert.equal(writes, 1);
  assert.equal(f.el.exportDataBtn.disabled, true);
  committing.resolve(counts);
  await flush();
  assert.match(f.el.dataBackupStatus.textContent, /^Saved locally/);
  assert.equal(f.el.importDataBtn.disabled, true);
  refreshing.resolve();
  assert.equal(await importing, counts);
  assert.equal(f.el.importDataBtn.disabled, false);
  assert.equal(f.document.activeElement, f.el.importDataBtn);
  assert.match(f.el.dataBackupStatus.textContent, /^Imported 1 shot, 0 traces, 0 bow profiles.*1 queued/);
});

test("file read, JSON, and storage failures retain an actionable retry", async () => {
  for (const failure of ["read", "json", "storage"]) {
    const f = fixture();
    const inputFile = failure === "read" ? { text: async () => { throw new Error("File unavailable"); } }
      : failure === "json" ? { text: async () => "{" } : file();
    if (failure === "storage") f.database.importAllData = async () => { throw new Error("Storage full"); };
    await f.select(inputFile);
    assert.match(f.el.dataBackupStatus.textContent, /^Import failed:/);
    assert.equal(f.el.dataBackupStatus.style.color, "var(--red)");
    assert.ok(!f.el.importDataBtn.disabled && !f.el.exportDataBtn.disabled && !f.el.importDataInput.disabled);
    f.database.importAllData = async () => counts;
    await f.select(file());
    assert.match(f.el.dataBackupStatus.textContent, /^Imported/);
    assert.equal(f.el.dataBackupStatus.style.color, "var(--muted)");
  }
});

test("sync throws and rejected uploads preserve a committed import and still refresh views", async () => {
  for (const asynchronous of [false, true]) {
    let refreshed = false;
    const f = fixture({ syncAdapter: { triggerSync() {
      if (asynchronous) return Promise.reject(new Error("Sync unavailable"));
      throw new Error("Sync unavailable");
    } }, onImportComplete() { refreshed = true; } });
    assert.equal(await f.ui.importFile(file()), counts);
    await flush();
    assert.equal(refreshed, true);
    assert.equal(f.imports.length, 1);
    assert.match(f.el.dataBackupStatus.textContent, /^Imported/);
    assert.ok(f.logs.some((message) => /saved locally; cloud sync failed/.test(message)));
    assert.ok(!f.logs.some((message) => /Data import failed/.test(message)));
  }
});

test("failed or incomplete view refreshes report a saved import without asking to restore again", async () => {
  for (const onImportComplete of [() => { throw new Error("View unavailable"); }, async () => false]) {
    const f = fixture({ onImportComplete });
    assert.equal(await f.ui.importFile(file()), counts);
    assert.equal(f.imports.length, 1);
    assert.match(f.el.dataBackupStatus.textContent, /^Imported.*Saved locally; some views could not refresh/);
    assert.match(f.el.dataBackupStatus.textContent, /retry the views/);
    assert.equal(f.el.importDataBtn.disabled, false);
    assert.ok(!f.logs.some((message) => /Data import failed/.test(message)));
  }
});

test("export prepares one snapshot and blocks imports through download completion", async () => {
  const snapshot = deferred(), downloading = deferred();
  let exports = 0, downloads = 0;
  const f = fixture({ database: { exportAllData: () => { exports++; return snapshot.promise; } },
    download: (record) => { assert.equal(record, payload); downloads++; return downloading.promise; } });
  const exporting = f.ui.exportData();
  await Promise.all([f.ui.exportData(), f.ui.importFile(file())]);
  assert.equal(exports, 1);
  assert.equal(f.imports.length, 0);
  snapshot.resolve(payload);
  await flush();
  assert.equal(downloads, 1);
  assert.equal(f.el.exportDataBtn.disabled, true);
  downloading.resolve();
  assert.equal(await exporting, payload);
  assert.match(f.el.dataBackupStatus.textContent, /^Exported 1 shot, 0 traces, 0 bow profiles/);
  assert.equal(f.el.exportDataBtn.disabled, false);
});

test("snapshot or download failures unlock backup actions and allow an export retry", async () => {
  for (const phase of ["snapshot", "download"]) {
    let failing = true;
    const f = fixture({ database: { exportAllData: async () => {
      if (failing && phase === "snapshot") throw new Error("Snapshot unavailable");
      return payload;
    } }, download: async () => { if (failing && phase === "download") throw new Error("Download unavailable"); } });
    await f.ui.exportData();
    assert.match(f.el.dataBackupStatus.textContent, /^Export failed:/);
    assert.ok(!f.el.exportDataBtn.disabled && !f.el.importDataBtn.disabled);
    failing = false;
    assert.equal(await f.ui.exportData(), payload);
    assert.match(f.el.dataBackupStatus.textContent, /^Exported/);
  }
});

test("canceling a file selection preserves status and later work preserves another control's focus", async () => {
  const reading = deferred();
  const f = fixture();
  f.el.dataBackupStatus.textContent = "Previous backup";
  await f.select(null);
  assert.equal(f.el.dataBackupStatus.textContent, "Previous backup");
  f.el.importDataBtn.focus();
  const importing = f.ui.importFile({ text: () => reading.promise });
  const otherControl = {};
  f.document.activeElement = otherControl;
  reading.resolve(JSON.stringify(payload));
  await importing;
  assert.equal(f.document.activeElement, otherControl);
});

test("default backup downloads retain their JSON URL until the browser can start reading it", async (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const releases = [], revoked = [], links = [], blobs = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: { appendChild(link) { links.push(link); } },
    createElement: () => ({ click() {}, remove() { this.removed = true; } }),
  } });
  t.after(() => { if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete globalThis.document; });
  t.mock.method(URL, "createObjectURL", (blob) => { blobs.push(blob); return "blob:backup"; });
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  t.mock.method(globalThis, "setTimeout", (action, ms) => { releases.push({ action, ms }); });
  const f = fixture({ defaultDownload: true });
  assert.equal(await f.ui.exportData(), payload);
  assert.equal(links[0].href, "blob:backup");
  assert.match(links[0].download, /^openfloat-backup-.*\.json$/);
  assert.equal(links[0].removed, true);
  assert.deepEqual(JSON.parse(await blobs[0].text()), payload);
  assert.equal(blobs[0].type, "application/json");
  assert.deepEqual(revoked, []);
  assert.equal(releases[0].ms, 1000);
  releases[0].action();
  assert.deepEqual(revoked, ["blob:backup"]);
});
