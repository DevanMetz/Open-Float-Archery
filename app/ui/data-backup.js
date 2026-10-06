// Local data backup / restore UI module.
// Handles JSON export/import and queues imported user-owned records for cloud sync.

import * as browserDb from "../core/db.js?v=shot-store-176";
import { downloadJson, exportFileStamp } from "./download.js?v=shot-store-176";

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

function downloadBackup(payload) {
  downloadJson(payload, `openfloat-backup-${exportFileStamp(new Date().toISOString())}.json`);
}

export function initDataBackup({ bus, syncAdapter, el, onImportComplete,
  database = browserDb, download = downloadBackup }) {
  let busy = false;
  function setBusy(value) {
    busy = value;
    for (const control of [el.exportDataBtn, el.importDataBtn, el.importDataInput]) {
      if (control) control.disabled = value;
    }
  }
  function finish(control, hadFocus) {
    setBusy(false);
    if (hadFocus && control.ownerDocument.activeElement === control.ownerDocument.body && control.getClientRects().length) {
      control.focus();
    }
  }
  async function handleExportData() {
    if (busy) return;
    const hadFocus = !!el.exportDataBtn && el.exportDataBtn.ownerDocument?.activeElement === el.exportDataBtn;
    setBusy(true);
    try {
      setDataBackupStatus(el, "Preparing export...");
      const payload = await database.exportAllData();
      const exportCounts = Object.fromEntries(
        Object.entries(payload.stores).map(([name, rows]) => [name, rows.length]),
      );
      const summary = summarizeCounts(exportCounts);
      await download(payload);
      setDataBackupStatus(el, `Exported ${summary}.`);
      bus.emit("log", `Data export: ${summary}.`);
      return payload;
    } catch (error) {
      setDataBackupStatus(el, `Export failed: ${error.message}`, true);
      bus.emit("log", `Data export failed: ${error.message}`);
    } finally {
      finish(el.exportDataBtn, hadFocus);
    }
  }

  async function handleImportFile(file) {
    if (busy || !file) return;
    const hadFocus = !!el.importDataBtn && el.importDataBtn.ownerDocument?.activeElement === el.importDataBtn;
    setBusy(true);
    try {
      setDataBackupStatus(el, "Reading file...");
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        throw new Error("file is not valid JSON.");
      }

      setDataBackupStatus(el, "Restoring data...");
      const counts = await database.importAllData(payload, { merge: true, queueForSync: true });
      const summary = summarizeCounts(counts);

      // The import and its fresh upload tasks have already committed together.
      // Without cloud configuration, tasks stay local until sync is enabled.
      const queued = counts.sync_queue;
      if (queued > 0 && syncAdapter) {
        Promise.resolve().then(() => syncAdapter.triggerSync()).catch((error) =>
          bus.emit("log", `Import saved locally; cloud sync failed: ${error.message}`));
      }

      const cloudNote = queued > 0 ? ` (${queued} queued for cloud sync)` : "";
      bus.emit("log", `Data import: ${summary}${cloudNote}.`);
      // Refresh the views that read straight from IndexedDB.
      let refreshed = true;
      setDataBackupStatus(el, "Saved locally. Refreshing views...");
      try {
        if (onImportComplete) refreshed = (await onImportComplete()) !== false;
      } catch (error) {
        refreshed = false;
        bus.emit("log", `Import saved locally; view refresh failed: ${error.message}`);
      }
      const refreshNote = refreshed ? "" : " Saved locally; some views could not refresh. Reopen Settings or Saved Shots to retry the views.";
      setDataBackupStatus(el, `Imported ${summary}${cloudNote}.${refreshNote}`, !refreshed);
      return counts;
    } catch (error) {
      setDataBackupStatus(el, `Import failed: ${error.message}`, true);
      bus.emit("log", `Data import failed: ${error.message}`);
    } finally {
      finish(el.importDataBtn, hadFocus);
    }
  }

  if (el.exportDataBtn) el.exportDataBtn.addEventListener("click", handleExportData);
  if (el.importDataBtn && el.importDataInput) {
    el.importDataBtn.addEventListener("click", () => { if (!busy) el.importDataInput.click(); });
    el.importDataInput.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = ""; // allow re-importing the same file
      return handleImportFile(file);
    });
  }
  return { exportData: handleExportData, importFile: handleImportFile };
}
