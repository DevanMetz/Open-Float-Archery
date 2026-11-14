export function displayShotCount(deviceCount, adjustment = 0) {
  const count = Number(deviceCount);
  const delta = Number(adjustment);
  if (!Number.isFinite(count) || !Number.isFinite(delta)) return 0;
  return Math.max(0, Math.trunc(count + delta));
}

export function adjustShotCountOffset(deviceCount, adjustment, amount) {
  const current = displayShotCount(deviceCount, adjustment);
  return Math.max(0, current + Math.trunc(amount)) - Math.max(0, Math.trunc(Number(deviceCount) || 0));
}
