// Shared JSON download cleanup for backups and saved-capture exports.
export function exportFileStamp(timestamp) {
  const time = typeof timestamp === "string" && timestamp.trim() ? Date.parse(timestamp) : NaN;
  return Number.isFinite(time)
    ? new Date(time).toISOString().replace(/\.\d{3}Z$/, "").replace(/[:T]/g, "-")
    : "undated";
}

export function downloadJson(payload, filename, indent = 0) {
  const blob = new Blob([JSON.stringify(payload, null, indent)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  let link;
  try {
    link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
  } finally {
    link?.remove();
    // Let the browser start reading the file before releasing its object URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
