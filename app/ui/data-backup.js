// Local data backup / restore UI module.
// Handles JSON export/import and queues imported user-owned records for cloud sync.

import { exportAllData, getAll, importAllData, put } from "../core/db.js?v=shot-store-125";
import { SAMPLE_DEVICE_ID } from "../data/sample-data.js?v=shot-store-125";

function setDataBackupStatus(el, message, isError = false) {
  if (!el.dataBackupStatus) return;
  el.dataBackupStatus.textContent = message;
  el.dataBackupStatus.style.color = isError ? "var(--red)" : "var(--muted)";
}

// Accepts a per-store count map ({ shots: 12, ... }).
function summarizeCounts(counts) {
  const shots = counts.shots || 0;
  const traces = counts.shot_traces || 0;
  const profiles = counts.bow_profiles || 0;
  return `${shots} shot${shots === 1 ? "" : "s"}, ${traces} trace${traces === 1 ? "" : "s"}, ${profiles} bow profile${profiles === 1 ? "" : "s"}`;
}

// User-owned stores that should replicate to the cloud. Imported records are
// written straight to IndexedDB and carry no fresh sync task, so importing
// re-queues a CREATE per record (deduped against any task already pending,
// including ones restored from a backup's own sync_queue) so the data syncs.
const CLOUD_SYNC_TABLES = ["bow_profiles", "sessions", "shots", "shot_traces"];

async function enqueueImportedForSync(stores) {
  const existing = await getAll("sync_queue");
  const seen = new Set(
    existing
      .filter((t) => t && t.status !== "done" && t.targetId != null)
      .map((t) => `${t.table}|${t.targetId}`),
  );
  let queued = 0;
  for (const table of CLOUD_SYNC_TABLES) {
    const records = Array.isArray(stores[table]) ? stores[table] : [];
    for (const rec of records) {
      if (!rec) continue;
      // Never push demo/sample records to the cloud.
      if (rec.sample === true || rec.device_id === SAMPLE_DEVICE_ID) continue;
      const targetId = table === "shot_traces" ? rec.shot_id : rec.id;
      if (targetId == null) continue;
      const key = `${table}|${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await put("sync_queue", {
        table,
        action: "CREATE",
        targetId,
        payload: rec,
        status: "pending",
      });
      queued += 1;
    }
  }
  return queued;
}

export function initDataBackup({ bus, syncAdapter, el, onImportComplete }) {
  async function handleExportData() {
    try {
      setDataBackupStatus(el, "Preparing export...");
      const payload = await exportAllData();
      const exportCounts = Object.fromEntries(
        Object.entries(payload.stores).map(([name, rows]) => [name, rows.length]),
      );
      const summary = summarizeCounts(exportCounts);
      const json = JSON.stringify(payload);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const a = document.createElement("a");
      a.href = url;
      a.download = `openfloat-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDataBackupStatus(el, `Exported ${summary}.`);
      bus.emit("log", `Data export: ${summary}.`);
    } catch (error) {
      setDataBackupStatus(el, `Export failed: ${error.message}`, true);
      bus.emit("log", `Data export failed: ${error.message}`);
    }
  }

  async function handleImportFile(file) {
    try {
      setDataBackupStatus(el, "Reading file...");
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        throw new Error("file is not valid JSON.");
      }

      let summary;
      let stores;
      if (payload && payload.format === "openfloat-shot-export" && payload.shot) {
        // Single-shot export: one shot record plus its optional trace.
        await put("shots", payload.shot);
        if (payload.trace) await put("shot_traces", payload.trace);
        stores = {
          shots: [payload.shot],
          shot_traces: payload.trace ? [payload.trace] : [],
        };
        summary = `1 shot${payload.trace ? " + trace" : ""}`;
      } else {
        // Full backup bundle (writes every store, incl. a restored sync_queue).
        const counts = await importAllData(payload, { merge: true });
        summary = summarizeCounts(counts);
        stores = payload.stores || {};
      }

      // Queue the imported user data for cloud replication, then kick a sync.
      // If cloud isn't configured, triggerSync is a quiet no-op and the tasks
      // wait in the queue until it is.
      const queued = await enqueueImportedForSync(stores);
      if (queued > 0 && syncAdapter) syncAdapter.triggerSync();

      const cloudNote = queued > 0 ? ` (${queued} queued for cloud sync)` : "";
      setDataBackupStatus(el, `Imported ${summary}${cloudNote}.`);
      bus.emit("log", `Data import: ${summary}${cloudNote}.`);
      // Refresh the views that read straight from IndexedDB.
      if (onImportComplete) await onImportComplete();
    } catch (error) {
      setDataBackupStatus(el, `Import failed: ${error.message}`, true);
      bus.emit("log", `Data import failed: ${error.message}`);
    }
  }

  if (el.exportDataBtn) el.exportDataBtn.addEventListener("click", handleExportData);
  if (el.importDataBtn && el.importDataInput) {
    el.importDataBtn.addEventListener("click", () => el.importDataInput.click());
    el.importDataInput.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = ""; // allow re-importing the same file
      if (file) handleImportFile(file);
    });
  }
}
