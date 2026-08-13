import { impactDirectionLabel, scoreForImpact } from "../telemetry/outcome.js?v=shot-store-131";

const TARGET_COLORS = [
  { radius: 1, fill: "#f5f1e8" },
  { radius: 0.8, fill: "#171b21" },
  { radius: 0.6, fill: "#2494ca" },
  { radius: 0.4, fill: "#e34c52" },
  { radius: 0.2, fill: "#f3bf4c" },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizedPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const size = Math.min(rect.width, rect.height);
  const radius = size / 2;
  return {
    x: clamp((clientX - (rect.left + rect.width / 2)) / radius, -1.25, 1.25),
    y: clamp(((rect.top + rect.height / 2) - clientY) / radius, -1.25, 1.25),
  };
}

export function mountImpactTarget({ canvas, onSelect }) {
  if (!canvas) return null;
  const context = canvas.getContext("2d");
  let impact = null;

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const cssSize = Math.max(160, Math.min(rect.width || 200, rect.height || rect.width || 200));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelSize = Math.round(cssSize * dpr);
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, cssSize, cssSize);
    const center = cssSize / 2;
    const radius = center - 4;

    for (const ring of TARGET_COLORS) {
      context.beginPath();
      context.arc(center, center, radius * ring.radius, 0, Math.PI * 2);
      context.fillStyle = ring.fill;
      context.fill();
    }
    context.lineWidth = 1;
    for (let ring = 1; ring <= 10; ring += 1) {
      context.beginPath();
      context.arc(center, center, radius * ring / 10, 0, Math.PI * 2);
      context.strokeStyle = ring >= 9 ? "rgba(88, 66, 10, 0.7)" : "rgba(255, 255, 255, 0.45)";
      context.stroke();
    }
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.strokeStyle = "rgba(142, 166, 160, 0.9)";
    context.lineWidth = 2;
    context.stroke();

    if (impact) {
      const markerX = center + impact.x * radius;
      const markerY = center - impact.y * radius;
      context.beginPath();
      context.arc(markerX, markerY, 6, 0, Math.PI * 2);
      context.fillStyle = "#10151a";
      context.fill();
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2;
      context.stroke();
      context.beginPath();
      context.moveTo(markerX - 10, markerY);
      context.lineTo(markerX + 10, markerY);
      context.moveTo(markerX, markerY - 10);
      context.lineTo(markerX, markerY + 10);
      context.strokeStyle = "#10151a";
      context.lineWidth = 1.5;
      context.stroke();
    }
  }

  function announceSelection(point) {
    impact = point ? { ...point } : null;
    if (impact) impact.radius = Math.hypot(impact.x, impact.y);
    canvas.setAttribute(
      "aria-label",
      impact
        ? `Arrow impact ${impactDirectionLabel(impact)}, estimated score ${scoreForImpact(impact.x, impact.y)}. Use arrow keys to adjust, Backspace to clear.`
        : "Arrow impact target. Click or press Enter to place an arrow, then use arrow keys to adjust.",
    );
    draw();
    onSelect?.(impact ? { ...impact, score: scoreForImpact(impact.x, impact.y) } : null);
  }

  canvas.addEventListener("pointerdown", (event) => {
    announceSelection(normalizedPoint(canvas, event.clientX, event.clientY));
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      announceSelection(null);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      announceSelection(impact || { x: 0, y: 0 });
      return;
    }
    const delta = event.shiftKey ? 0.1 : 0.025;
    const next = impact ? { x: impact.x, y: impact.y } : { x: 0, y: 0 };
    if (event.key === "ArrowLeft") next.x -= delta;
    else if (event.key === "ArrowRight") next.x += delta;
    else if (event.key === "ArrowUp") next.y += delta;
    else if (event.key === "ArrowDown") next.y -= delta;
    else return;
    event.preventDefault();
    next.x = clamp(next.x, -1.25, 1.25);
    next.y = clamp(next.y, -1.25, 1.25);
    announceSelection(next);
  });

  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(draw)
    : null;
  resizeObserver?.observe(canvas);
  window.addEventListener("resize", draw);
  draw();

  return {
    setImpact(nextImpact) {
      impact = nextImpact ? { x: Number(nextImpact.x), y: Number(nextImpact.y) } : null;
      canvas.setAttribute(
        "aria-label",
        impact
          ? `Arrow impact ${impactDirectionLabel(impact)}, estimated score ${scoreForImpact(impact.x, impact.y)}. Use arrow keys to adjust, Backspace to clear.`
          : "Arrow impact target. Click or press Enter to place an arrow, then use arrow keys to adjust.",
      );
      draw();
    },
    destroy() {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", draw);
    },
  };
}
