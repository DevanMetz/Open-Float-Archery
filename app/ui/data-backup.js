// Local data backup / restore UI module.
// Handles JSON export/import and queues imported user-owned records for cloud sync.

import { exportAllData, importAllData } from "../core/db.js?v=shot-store-134";

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

      const counts = await importAllData(payload, { merge: true, queueForSync: true });
      const summary = summarizeCounts(counts);

      // The import and its fresh upload tasks have already committed together.
      // Without cloud configuration, tasks stay local until sync is enabled.
      const queued = counts.sync_queue;
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
