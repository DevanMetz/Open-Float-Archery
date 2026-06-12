// UI layer: renders the dashboard from store state and paints the live trace.
// Pure view code — it reads from the store and telemetry, never the device.

import { MAX_TRACE_POINTS } from "../telemetry/telemetry.js";
import { micChartPointsFromSeries } from "../protocol/trace.js?v=shot-store-118";
import { get } from "../core/db.js";

function reviewMicChartData(state) {
  if (!state.reviewMode) return null;
  if (state.reviewMicSeries?.length) {
    return micChartPointsFromSeries(state.reviewMicSeries);
  }
  const payload = state.reviewTrace || [];
  if (payload.some((point) => (point.micAmp || 0) > 0)) {
    return payload.map((point) => ({
      tUs: Number.isFinite(Number(point.tUs)) ? Number(point.tUs) : undefined,
      micAmp: point.micAmp || 0,
    }));
  }
  return null;
}

async function getActiveArrowSpeed() {
  const activeBowId = localStorage.getItem("openfloat_active_bow_id");
  if (activeBowId) {
    try {
      const profile = await get("bow_profiles", activeBowId);
      if (profile && profile.arrow_speed != null) {
        return Number(profile.arrow_speed);
      }
    } catch (error) {
      console.error("Error getting active bow speed:", error);
    }
  }
  return 280; // Fallback default speed
}

function calculateRangeFromTimes(releaseTimeMs, hitTimeMs, bowSpeedFps) {
  if (releaseTimeMs === null || hitTimeMs === null) return null;
  const totalTimeSec = (hitTimeMs - releaseTimeMs) / 1000.0;
  if (totalTimeSec <= 0) return null;

  const V_sound = 1125.0; // fps
  const b = 0.075;
  const A = b;
  const B = -(V_sound + bowSpeedFps + totalTimeSec * b * V_sound);
  const C = totalTimeSec * bowSpeedFps * V_sound;

  const discriminant = B * B - 4 * A * C;
  if (discriminant < 0) return null;

  const distanceFt = (-B - Math.sqrt(discriminant)) / (2 * A);
  if (distanceFt <= 0) return null;

  return {
    yards: distanceFt / 3.0,
    feet: distanceFt
  };
}

function reviewTraceTimeRangeUs(state, trace) {
  if (!Array.isArray(trace) || trace.length < 2) return null;
  const values = trace
    .map((point) => Number(point.tUs))
    .filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  let start = Math.min(...values);
  let end = Math.max(...values);
  if (end <= start) return null;
  return { start, end };
}

function fallbackReviewTimeRangeUs(state, trace) {
  if (!Array.isArray(trace) || trace.length < 2) return null;
  const sampleRateHz = Number(state.reviewSampleRateHz) > 0 ? Number(state.reviewSampleRateHz) : 52;
  const dtUs = 1000000 / sampleRateHz;
  const thresholdG = state.reviewThresholdG != null ? Number(state.reviewThresholdG) : 12;
  const { releaseIdx } = findReleaseIndex(trace, true, thresholdG);
  return {
    start: -releaseIdx * dtUs,
    end: (trace.length - 1 - releaseIdx) * dtUs,
  };
}

function reviewTimeRangeUs(state, trace) {
  return reviewTraceTimeRangeUs(state, trace) || fallbackReviewTimeRangeUs(state, trace);
}

// Shared x-axis for the review line chart: the union of the motion trace and the
// mic series real-timestamp ranges. The mic is captured over a different window
// than the motion (shorter pre-roll, longer post-pad) and at a higher sample
// rate, so using the motion range alone squished the audio into part of the
// chart and clipped its tail. Returns null when neither series has real tUs, so
// both fall back to index mapping and stay aligned.
function reviewLineTimeRangeUs(state, motionData, micData) {
  const motionRange = reviewTraceTimeRangeUs(state, motionData);
  const micRange = Array.isArray(micData) ? reviewTraceTimeRangeUs(state, micData) : null;
  if (motionRange && micRange) {
    return {
      start: Math.min(motionRange.start, micRange.start),
      end: Math.max(motionRange.end, micRange.end),
    };
  }
  return motionRange || micRange || null;
}

const THREE_URL = "https://esm.sh/three@0.164.1";
const GLTF_LOADER_URL = "https://esm.sh/three@0.164.1/examples/jsm/loaders/GLTFLoader.js";
const ORBIT_CONTROLS_URL = "https://esm.sh/three@0.164.1/examples/jsm/controls/OrbitControls.js";
const BOW_MODEL_URL = "Blender/BowModel.glb";
const BOW_MODEL_TARGET_SIZE = 3.35;
const MCU_MODEL_NAMES = [
  "MCU",
  "MCU_XIAO",
  "MCU_XIAO_NRF54L15",
  "MCU_XIAO_nRF54L15",
  "XIAO",
  "XIAO_MODULE",
];
const RISER_MODEL_NAMES = [
  "Riser",
  "Bow_Riser",
  "Bow_Compound_Riser",
];
const BOW_COMPOUND_PART_NAMES = [
  "String",
  "Top_Cam",
  "Bottom_Cam",
  "Riser",
  "Top_Text",
];

export const MOUNT_ORIENTATIONS = [
  {
    id: "firmware-x-90",
    label: "Current firmware mount",
    description: "XIAO rotated 90 degrees around the bow forward axis. Matches MOUNT_ROT_X_SIGN 1.",
    axes: { x: "IMU X", y: "-IMU Z", z: "IMU Y" },
    firmware: "apply_mount_rotation: x'=x, y'=-z, z'=y",
    rotation: [0, 0, 0],
  },
  {
    id: "firmware-x-90-flipped",
    label: "Current mount, inverted sign",
    description: "Same physical mount with the firmware sign flipped for inverted cant or pitch.",
    axes: { x: "IMU X", y: "IMU Z", z: "-IMU Y" },
    firmware: "set MOUNT_ROT_X_SIGN to -1",
    rotation: [Math.PI, 0, 0],
  },
  {
    id: "face-out-usb-up",
    label: "Face out, USB up",
    description: "Component side faces away from the bow, USB connector toward the upper limb.",
    axes: { x: "IMU X", y: "IMU Y", z: "IMU Z" },
    firmware: "identity mapping: x'=x, y'=y, z'=z",
    rotation: [0, 0, 0],
  },
  {
    id: "face-out-usb-down",
    label: "Face out, USB down",
    description: "Component side faces away from the bow, USB connector toward the lower limb.",
    axes: { x: "-IMU X", y: "-IMU Y", z: "IMU Z" },
    firmware: "rotate 180 degrees around board Z",
    rotation: [0, 0, Math.PI],
  },
  {
    id: "face-out-usb-left",
    label: "Face out, USB left",
    description: "Component side faces away from the bow, USB connector toward the string side.",
    axes: { x: "IMU Y", y: "-IMU X", z: "IMU Z" },
    firmware: "rotate 90 degrees clockwise around board Z",
    rotation: [0, 0, -Math.PI / 2],
  },
  {
    id: "face-out-usb-right",
    label: "Face out, USB right",
    description: "Component side faces away from the bow, USB connector toward the sight side.",
    axes: { x: "-IMU Y", y: "IMU X", z: "IMU Z" },
    firmware: "rotate 90 degrees counter-clockwise around board Z",
    rotation: [0, 0, Math.PI / 2],
  },
];

export function mountOrientationById(id) {
  return MOUNT_ORIENTATIONS.find((orientation) => orientation.id === id) || MOUNT_ORIENTATIONS[0];
}

export function cloneMountAxes(axes) {
  return { x: axes.x, y: axes.y, z: axes.z };
}

function negateAxisLabel(label) {
  return label.startsWith("-") ? label.slice(1) : `-${label}`;
}

export function rotateMountAxes(axes, bowAxis) {
  const next = cloneMountAxes(axes);
  if (bowAxis === "x") {
    next.y = negateAxisLabel(axes.z);
    next.z = axes.y;
  } else if (bowAxis === "y") {
    next.x = axes.z;
    next.z = negateAxisLabel(axes.x);
  } else if (bowAxis === "z") {
    next.x = negateAxisLabel(axes.y);
    next.y = axes.x;
  }
  return next;
}

export function mountFirmwareMappingText(axes) {
  return `x'=${axes.x.replace("IMU ", "").toLowerCase()}, y'=${axes.y.replace("IMU ", "").toLowerCase()}, z'=${axes.z.replace("IMU ", "").toLowerCase()}`;
}

export function mountOrientationState(state) {
  const preset = mountOrientationById(state.mountOrientation);
  return {
    ...preset,
    axes: state.mountAxes || preset.axes,
    rotation: state.mountRotation || preset.rotation,
    description: state.mountOrientation === "custom"
      ? "Custom mount preview built from 90 degree rotations around the bow axes."
      : preset.description,
    firmware: state.mountOrientation === "custom"
      ? mountFirmwareMappingText(state.mountAxes || preset.axes)
      : preset.firmware,
  };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Chart draw colors that must flip with the page theme (light marks on the
// classic dark canvas, ink marks on light themes). A theme stylesheet can
// redefine the --trace-* variables; without them we fall back to the classic
// dark-theme palette. Refreshed once per frame so theme toggles apply live.
const CANVAS_INK_DEFAULTS = {
  follow: "rgba(230, 244, 239, 0.58)",
  dotRing: "#FFFFFF",
  crosshair: "rgba(255, 255, 255, 0.65)",
  label: "rgba(230, 244, 239, 0.72)",
  marker: "rgba(230, 244, 239, 0.44)",
  release: "#FF5D73",
  break: "#FFBE5C",
  hold: "#30E39B",
  cyan: "#35C7E8",
};
let canvasInk = { ...CANVAS_INK_DEFAULTS };

function refreshCanvasInk() {
  canvasInk = {
    follow: cssVar("--trace-follow") || CANVAS_INK_DEFAULTS.follow,
    dotRing: cssVar("--trace-dot-ring") || CANVAS_INK_DEFAULTS.dotRing,
    crosshair: cssVar("--trace-crosshair") || CANVAS_INK_DEFAULTS.crosshair,
    label: cssVar("--trace-label") || CANVAS_INK_DEFAULTS.label,
    marker: cssVar("--trace-marker") || CANVAS_INK_DEFAULTS.marker,
    release: cssVar("--red") || CANVAS_INK_DEFAULTS.release,
    break: cssVar("--amber") || CANVAS_INK_DEFAULTS.break,
    hold: cssVar("--green") || CANVAS_INK_DEFAULTS.hold,
    cyan: cssVar("--cyan") || CANVAS_INK_DEFAULTS.cyan,
  };
}

function hasQuaternionSeries(data) {
  return Array.isArray(data) && data.some((point) =>
    ["qw", "qx", "qy", "qz"].every((key) => Number.isFinite(Number(point[key]))),
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function renderBubbleLevel(el, roll, rangeSetting, toleranceSetting) {
  if (!el.levelCard || !el.levelBubble || !el.levelAlertText) return;

  const cant = Number.isFinite(roll) ? roll : 0;
  const maxCantDeg = rangeSetting || 12;
  const levelToleranceDeg = toleranceSetting || 2;
  const warnToleranceDeg = levelToleranceDeg * 3;
  const normalized = clamp(cant / maxCantDeg, -1, 1);
  const bubbleLeftPercent = 50 + normalized * 42;
  const absCant = Math.abs(cant);

  el.levelBubble.style.left = `${bubbleLeftPercent}%`;
  el.levelCard.classList.toggle("level-ok", absCant <= levelToleranceDeg);
  el.levelCard.classList.toggle(
    "level-warn",
    absCant > levelToleranceDeg && absCant <= warnToleranceDeg,
  );
  el.levelCard.classList.toggle("level-danger", absCant > warnToleranceDeg);

  if (absCant <= levelToleranceDeg) {
    el.levelAlertText.textContent = "Level";
  } else {
    const side = cant > 0 ? "right" : "left";
    el.levelAlertText.textContent = `${side} cant`;
  }
}

function radians(degrees) {
  return degrees * (Math.PI / 180);
}

function calibratedAngle(value, offset) {
  return (Number.isFinite(value) ? value : 0) - (Number.isFinite(offset) ? offset : 0);
}

function wrapAngleDeg(value) {
  let wrapped = value;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
}

function blendAngleDeg(current, target, weight) {
  return wrapAngleDeg(current + wrapAngleDeg(target - current) * weight);
}

function viewRollDegrees(state) {
  return Number.isFinite(Number(state.viewRoll)) ? Number(state.viewRoll) : 0;
}

function applyCameraViewRoll(camera, rollDegrees, fallbackQuaternion = null, controls = null) {
  if (!controls && fallbackQuaternion) {
    camera.quaternion.copy(fallbackQuaternion);
  }
  camera.rotateZ(radians(rollDegrees));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function phaseColor(phase) {
  if (phase === "release") return canvasInk.release;
  if (phase === "break") return canvasInk.break;
  if (phase === "follow") return canvasInk.follow;
  return canvasInk.hold;
}

function findReleaseIndex(data, inferWhenMissing = false, thresholdG = 12.0) {
  let releaseIdx = 0;
  let maxG = 0;
  for (let i = 0; i < data.length; i++) {
    const pt = data[i];
    const g = Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0);
    if (g > maxG) {
      maxG = g;
      releaseIdx = i;
    }
  }
  if (maxG <= thresholdG && inferWhenMissing && data.length >= 20) {
    return {
      releaseIdx: Math.round(data.length * 0.62),
      hasRelease: true,
    };
  }
  return {
    releaseIdx,
    hasRelease: maxG > thresholdG,
  };
}

function phaseForIndex(index, releaseIdx, hasRelease, length) {
  if (!hasRelease) return "hold";
  const releaseStart = Math.max(2, releaseIdx - Math.max(4, Math.round(length * 0.025)));
  const releaseEnd = Math.min(length - 1, releaseIdx + Math.max(8, Math.round(length * 0.055)));
  if (index < releaseStart) return "hold";
  if (index < releaseIdx) return "break";
  if (index <= releaseEnd) return "release";
  return "follow";
}

function holdWindow(data, releaseIdx, hasRelease) {
  if (!data.length) return [];
  if (!hasRelease) return data;
  const releaseStart = Math.max(5, releaseIdx - Math.max(6, Math.round(data.length * 0.03)));
  return data.slice(0, releaseStart);
}

function reviewTraceCenter(data, releaseIdx, hasRelease, holdData) {
  if (hasRelease && data[releaseIdx]) {
    return {
      roll: data[releaseIdx].roll || 0,
      pitch: data[releaseIdx].pitch || 0,
    };
  }

  let sumRoll = 0;
  let sumPitch = 0;
  let count = 0;
  for (const pt of holdData) {
    sumRoll += pt.roll || 0;
    sumPitch += pt.pitch || 0;
    count++;
  }
  if (count > 0) {
    return { roll: sumRoll / count, pitch: sumPitch / count };
  }
  return { roll: data[0]?.roll || 0, pitch: data[0]?.pitch || 0 };
}

function maxDeviationAround(scaleData, rollCenter, pitchCenter) {
  let maxDev = 1.0;
  for (const pt of scaleData) {
    const dx = (pt.roll || 0) - rollCenter;
    const dy = (pt.pitch || 0) - pitchCenter;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDev) maxDev = dist;
  }
  return maxDev;
}

// Points used to size the target scale (hold-focused; excludes follow-through spikes).
function reviewScalePoints(traceData, releaseIdx, hasRelease) {
  const holdData = holdWindow(traceData, releaseIdx, hasRelease);
  if (holdData.length >= 5) return holdData;
  if (!hasRelease) return traceData;
  const releaseEnd = Math.min(
    traceData.length - 1,
    releaseIdx + Math.max(8, Math.round(traceData.length * 0.055)),
  );
  return traceData.slice(0, releaseEnd + 1);
}

const REVIEW_TARGET_SCALE_FIT = 0.85;

// Overlay a compare shot using the same normalization as the primary review trace:
// subtract the detected release roll/pitch so the shot point maps to target center.
function drawCompareReviewTrace(ctx, {
  traceData,
  releaseIdx,
  hasRelease,
  rollCenter,
  pitchCenter,
  displayScale,
  normMaxDev,
  cx,
  cy,
  replayProgress,
}) {
  if (traceData.length < 2) return;

  const replayCount = Math.max(2, Math.ceil(traceData.length * replayProgress));
  const visible = traceData.slice(0, replayCount);
  const mapPoint = (pt) => ({
    x: cx - (((pt.roll || 0) - rollCenter) / normMaxDev) * displayScale,
    y: cy - (((pt.pitch || 0) - pitchCenter) / normMaxDev) * displayScale,
  });

  ctx.save();
  ctx.strokeStyle = canvasInk.cyan;
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.88;
  ctx.beginPath();
  for (let i = 0; i < visible.length; i++) {
    const p = mapPoint(visible[i]);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  // Release reticle at target center — same anchoring as the primary trace.
  if (hasRelease && visible.length > releaseIdx) {
    ctx.save();
    ctx.strokeStyle = canvasInk.cyan;
    ctx.fillStyle = canvasInk.cyan;
    ctx.lineWidth = 1.5;

    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy);
    ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx, cy + 12);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  const finalPt = mapPoint(visible[visible.length - 1]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = canvasInk.cyan;
  ctx.beginPath();
  ctx.arc(finalPt.x, finalPt.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = canvasInk.dotRing;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawSigmaEllipse(ctx, points, mapPoint) {
  if (points.length < 8) return;

  const rolls = points.map((pt) => pt.roll || 0);
  const pitches = points.map((pt) => pt.pitch || 0);
  const rollMean = mean(rolls);
  const pitchMean = mean(pitches);
  let covRoll = 0;
  let covPitch = 0;
  let covCross = 0;

  for (let i = 0; i < points.length; i++) {
    const dx = rolls[i] - rollMean;
    const dy = pitches[i] - pitchMean;
    covRoll += dx * dx;
    covPitch += dy * dy;
    covCross += dx * dy;
  }

  covRoll /= points.length;
  covPitch /= points.length;
  covCross /= points.length;

  const trace = covRoll + covPitch;
  const delta = Math.sqrt(Math.max(0, ((covRoll - covPitch) / 2) ** 2 + covCross ** 2));
  const lambda1 = Math.max(0.0001, trace / 2 + delta);
  const lambda2 = Math.max(0.0001, trace / 2 - delta);
  const angle = Math.atan2(2 * covCross, covRoll - covPitch) / 2;
  const center = mapPoint({ roll: rollMean, pitch: pitchMean });
  const unitX = mapPoint({ roll: rollMean + 1, pitch: pitchMean }).x - center.x;
  const unitY = center.y - mapPoint({ roll: rollMean, pitch: pitchMean + 1 }).y;
  const avgScale = Math.max(1, (Math.abs(unitX) + Math.abs(unitY)) / 2);
  const radiusX = Math.max(8, Math.sqrt(lambda1) * avgScale);
  const radiusY = Math.max(6, Math.sqrt(lambda2) * avgScale);

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  ctx.fillStyle = canvasInk.hold;
  ctx.strokeStyle = canvasInk.hold;

  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.beginPath();
  ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.72;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

function makeLine(THREE, points, color, opacity = 1) {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  );
  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
    }),
  );
}

function makeAxisLabel(THREE, text, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "800 38px Inter, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = cssVar("--bg") || "#0b1512";
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const label = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  label.scale.set(0.86, 0.32, 1);
  label.renderOrder = 10;
  return label;
}

function makeAxisGuide(THREE, options = {}) {
  const {
    size = 1.45,
    xLabel = "+X",
    yLabel = "+Y",
    zLabel = "+Z",
    showNegativeLabels = false,
  } = options;
  const guide = new THREE.Group();
  const textColorStr = cssVar("--text") || "#E6F4EF";
  const colors = {
    x: 0x30e39b,
    y: new THREE.Color(textColorStr).getHex(),
    z: 0xffbe5c,
  };
  const labelColors = {
    x: "#30E39B",
    y: textColorStr,
    z: "#FFBE5C",
  };

  guide.add(makeLine(THREE, [[-size, 0, 0], [size, 0, 0]], colors.x, 0.72));
  guide.add(makeLine(THREE, [[0, -size, 0], [0, size, 0]], colors.y, 0.44));
  guide.add(makeLine(THREE, [[0, 0, -size], [0, 0, size]], colors.z, 0.58));

  const labelOffset = size + 0.18;
  const labels = [
    [xLabel, labelColors.x, [labelOffset, 0, 0]],
    [yLabel, labelColors.y, [0, labelOffset, 0]],
    [zLabel, labelColors.z, [0, 0, labelOffset]],
  ];
  if (showNegativeLabels) {
    labels.push(
      ["-X", labelColors.x, [-labelOffset, 0, 0]],
      ["-Y", labelColors.y, [0, -labelOffset, 0]],
      ["-Z", labelColors.z, [0, 0, -labelOffset]],
    );
  }

  for (const [text, color, position] of labels) {
    const label = makeAxisLabel(THREE, text, color);
    label.position.set(...position);
    guide.add(label);
  }

  return guide;
}

function addCylinderBetween(THREE, group, start, end, radius, material) {
  const a = new THREE.Vector3(...start);
  const b = new THREE.Vector3(...end);
  const midpoint = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const direction = new THREE.Vector3().subVectors(b, a);
  const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, direction.length(), 18),
    material,
  );
  cylinder.position.copy(midpoint);
  cylinder.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  group.add(cylinder);
  return cylinder;
}

function buildXiaoModule(THREE) {
  const module = new THREE.Group();
  module.rotation.order = "XYZ";

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.58, 0.045),
    new THREE.MeshStandardMaterial({
      color: 0x163f47,
      metalness: 0.12,
      roughness: 0.46,
    }),
  );
  module.add(board);

  const chip = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.18, 0.04),
    new THREE.MeshStandardMaterial({
      color: 0x061014,
      metalness: 0.18,
      roughness: 0.36,
    }),
  );
  chip.position.z = 0.044;
  module.add(chip);

  const usb = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.08, 0.06),
    new THREE.MeshStandardMaterial({
      color: 0xc7d5d0,
      metalness: 0.5,
      roughness: 0.26,
    }),
  );
  usb.position.set(0, 0.34, 0.02);
  module.add(usb);

  const imuDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.032, 18, 12),
    new THREE.MeshStandardMaterial({
      color: 0xffbe5c,
      metalness: 0.1,
      roughness: 0.32,
    }),
  );
  imuDot.position.set(0.09, -0.07, 0.06);
  module.add(imuDot);

  return module;
}

function applyModuleOrientation(module, orientationState) {
  if (!module) return;
  const orientation = typeof orientationState === "string"
    ? mountOrientationById(orientationState)
    : mountOrientationState(orientationState || {});
  module.rotation.set(...orientation.rotation);
}

function mountPositionOffset(state) {
  const value = Array.isArray(state.mountPositionOffset)
    ? state.mountPositionOffset
    : [0, 0, 0];
  return [
    Number.isFinite(Number(value[0])) ? Number(value[0]) : 0,
    Number.isFinite(Number(value[1])) ? Number(value[1]) : 0,
    Number.isFinite(Number(value[2])) ? Number(value[2]) : 0,
  ];
}

function applyModulePosition(module, state) {
  if (!module) return;
  const bow = module.parent;
  if (!bow) return;
  const basePosition = module.userData.basePosition || module.position;
  const offset = mountPositionOffset(state || {});
  const offsetVector = module.userData.mountOffsetVector || module.position.clone();
  offsetVector.set(offset[0], offset[1], offset[2]);
  module.userData.mountOffsetVector = offsetVector;

  const originPosition = module.userData.originPosition || module.position.clone();
  originPosition.copy(basePosition).sub(offsetVector);
  module.userData.originPosition = originPosition;

  for (const child of bow.children) {
    if (child === module) continue;
    if (!child.userData.moduleOriginBasePosition) {
      child.userData.moduleOriginBasePosition = child.position.clone();
    }
    child.position.copy(child.userData.moduleOriginBasePosition).sub(originPosition);
  }

  module.position.set(0, 0, 0);
}

async function createOrbitControls(camera, canvas, target) {
  try {
    const { OrbitControls } = await import(ORBIT_CONTROLS_URL);
    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1.4;
    controls.maxDistance = 7.5;
    controls.update();
    return controls;
  } catch (error) {
    console.warn("Unable to load orbit controls for 3D preview.", error);
    return null;
  }
}

function modelAlignmentRotation(state) {
  const value = Array.isArray(state.modelAlignmentRotation)
    ? state.modelAlignmentRotation
    : [0, 0, 0];
  return [
    Number.isFinite(Number(value[0])) ? Number(value[0]) : 0,
    Number.isFinite(Number(value[1])) ? Number(value[1]) : 0,
    Number.isFinite(Number(value[2])) ? Number(value[2]) : 0,
  ];
}

function applyModelAlignment(modelRoot, state) {
  if (!modelRoot) return;
  const rotation = modelAlignmentRotation(state);
  modelRoot.rotation.set(...rotation);
}

function degreesLabel(radiansValue) {
  return `${Math.round(radiansValue * (180 / Math.PI))} deg`;
}

function normalizedHexColor(value, fallback = "#c7d5d0") {
  const text = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function materialKey(name) {
  return String(name || "material")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "material";
}

function materialLabel(name) {
  return String(name || "Material")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function materialList(material) {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function cloneMeshMaterials(mesh) {
  if (!mesh || mesh.userData.materialsClonedForOpenFloat) return;
  if (Array.isArray(mesh.material)) {
    mesh.material = mesh.material.map((material) => material.clone());
  } else if (mesh.material) {
    mesh.material = mesh.material.clone();
  }
  mesh.userData.materialsClonedForOpenFloat = true;
}

function materialLuminance(material) {
  if (!material?.color) return 1;
  return material.color.r * 0.2126 + material.color.g * 0.7152 + material.color.b * 0.0722;
}

function captureBaseMaterialColor(material) {
  if (!material?.color || material.userData.openFloatBaseColor) return;
  material.userData.openFloatBaseColor = `#${material.color.getHexString()}`;
  material.userData.openFloatBaseLuminance = materialLuminance(material);
}

function isBowCompoundMesh(mesh) {
  const partNames = new Set(BOW_COMPOUND_PART_NAMES);
  if (partNames.has(mesh.name)) return true;
  let node = mesh;
  while (node) {
    if (node.name === "Bow_Compound_Default") return true;
    if (partNames.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}

function isRiserMesh(mesh) {
  const names = new Set(RISER_MODEL_NAMES);
  if (names.has(mesh.name)) return true;
  let node = mesh;
  while (node) {
    if (String(node.name || "").toLowerCase().includes("riser")) return true;
    node = node.parent;
  }
  return materialList(mesh.material).some((material) => String(material.name || "").toLowerCase().includes("riser"));
}

function bowMaterialColors(state = {}) {
  const colors = state.bowMaterialColors && typeof state.bowMaterialColors === "object"
    ? { ...state.bowMaterialColors }
    : {};
  if (state.bowRiserColor && !colors.riser) {
    colors.riser = state.bowRiserColor;
  }
  if (state.bowHandleColor && !colors.grip) {
    colors.grip = state.bowHandleColor;
  }
  return colors;
}

function collectBowMaterials(modelRoot) {
  const materialsByKey = new Map();
  if (!modelRoot) return [];
  modelRoot.traverse((child) => {
    if (!child.isMesh || !isBowCompoundMesh(child)) return;
    for (const material of materialList(child.material)) {
      if (!material?.color) continue;
      captureBaseMaterialColor(material);
      const name = material.name || child.name || "material";
      const key = materialKey(name);
      if (!materialsByKey.has(key)) {
        materialsByKey.set(key, {
          key,
          label: materialLabel(name),
          defaultColor: material.userData.openFloatBaseColor || `#${material.color.getHexString()}`,
        });
      }
    }
  });
  return [...materialsByKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function applyBowCustomization(modelRoot, state = {}) {
  if (!modelRoot) return;
  const colors = bowMaterialColors(state);
  modelRoot.traverse((child) => {
    if (!child.isMesh || !isBowCompoundMesh(child)) return;
    cloneMeshMaterials(child);
    const materials = materialList(child.material);
    for (const material of materials) {
      if (!material?.color) continue;
      captureBaseMaterialColor(material);
      const key = materialKey(material.name || child.name);
      const defaultColor = material.userData.openFloatBaseColor || `#${material.color.getHexString()}`;
      material.color.set(normalizedHexColor(colors[key], defaultColor));
      material.needsUpdate = true;
    }
  });
}

function renderBowMaterialColorControls(materials, store, el, saveSettingsToCache = null) {
  if (!el.bowMaterialColorList) return;
  const currentColors = bowMaterialColors(store.get());
  el.bowMaterialColorList.replaceChildren();

  for (const material of materials) {
    const control = document.createElement("div");
    control.className = "bow-color-control";

    const label = document.createElement("label");
    const inputId = `bowMaterialColor-${material.key}`;
    label.htmlFor = inputId;
    label.textContent = material.label;

    const row = document.createElement("div");
    row.className = "bow-color-row";

    const input = document.createElement("input");
    input.type = "color";
    input.id = inputId;
    input.value = normalizedHexColor(currentColors[material.key], material.defaultColor);

    const value = document.createElement("span");
    value.textContent = input.value.toUpperCase();

    input.addEventListener("input", () => {
      const nextColors = {
        ...bowMaterialColors(store.get()),
        [material.key]: input.value,
      };
      store.set({ bowMaterialColors: nextColors });
      value.textContent = input.value.toUpperCase();
      if (typeof saveSettingsToCache === "function") {
        saveSettingsToCache();
      }
    });

    row.append(input, value);
    control.append(label, row);
    el.bowMaterialColorList.append(control);
  }
}

function findNamedMountPoint(root) {
  const mountNames = new Set([
    "XIAO_MOUNT_POINT",
    "XIAO_MOUNT",
    "MODULE_MOUNT_POINT",
    "MODULE_MOUNT",
  ]);
  let mountPoint = null;
  root.traverse((child) => {
    if (!mountPoint && mountNames.has(child.name)) {
      mountPoint = child;
    }
  });
  return mountPoint;
}

function findNamedPivotPoint(root) {
  const pivotNames = new Set([
    "BOW_PIVOT",
    "BOW_CENTER",
    "BOW_ORIGIN",
    "GRIP_CENTER",
    "PRESSURE_POINT",
  ]);
  let pivotPoint = null;
  root.traverse((child) => {
    if (!pivotPoint && pivotNames.has(child.name)) {
      pivotPoint = child;
    }
  });
  return pivotPoint;
}

function findNamedModelPart(root, names) {
  const nameSet = new Set(names);
  const directChild = root.children.find((child) => nameSet.has(child.name));
  if (directChild) return directChild;

  let match = null;
  root.traverse((child) => {
    if (!match && nameSet.has(child.name)) {
      match = child;
    }
  });
  return match;
}

function detachModelPart(THREE, root, names) {
  const source = findNamedModelPart(root, names);
  if (!source || !source.parent) return null;

  root.updateMatrixWorld(true);
  source.updateWorldMatrix(true, true);
  const detached = source.clone(true);
  source.matrixWorld.decompose(detached.position, detached.quaternion, detached.scale);
  detached.name = source.name;
  detached.userData.importedModelPart = source.name;
  source.parent.remove(source);
  return detached;
}

function attachXiaoModule(THREE, bow, mountPoint = null, moduleModel = null) {
  const xiaoModule = moduleModel || buildXiaoModule(THREE);
  xiaoModule.rotation.order = "XYZ";
  if (!moduleModel) {
    xiaoModule.scale.setScalar(0.86);
  }

  if (mountPoint) {
    bow.updateMatrixWorld(true);
    const mountPosition = new THREE.Vector3();
    const mountQuaternion = new THREE.Quaternion();
    mountPoint.getWorldPosition(mountPosition);
    mountPoint.getWorldQuaternion(mountQuaternion);
    bow.worldToLocal(mountPosition);
    xiaoModule.position.copy(mountPosition);
    xiaoModule.quaternion.copy(mountQuaternion);
  } else if (!moduleModel) {
    xiaoModule.position.set(-0.22, 0.0, 0.16);
  }
  xiaoModule.userData.basePosition = xiaoModule.position.clone();

  bow.add(xiaoModule);
  bow.userData.xiaoModule = xiaoModule;
  return xiaoModule;
}

function buildProceduralBowModel(THREE) {
  const bow = new THREE.Group();
  bow.rotation.order = "YZX";

  const riserMaterial = new THREE.MeshStandardMaterial({
    color: 0x35c7e8,
    metalness: 0.22,
    roughness: 0.42,
  });
  const limbMaterial = new THREE.MeshStandardMaterial({
    color: 0x30e39b,
    metalness: 0.08,
    roughness: 0.55,
  });
  const stringMaterial = new THREE.LineBasicMaterial({ color: 0xe6f4ef });
  const sightMaterial = new THREE.MeshStandardMaterial({
    color: 0xffbe5c,
    metalness: 0.18,
    roughness: 0.34,
  });

  const riser = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 2.25, 0.16),
    riserMaterial,
  );
  riser.name = "Riser";
  bow.add(riser);

  addCylinderBetween(THREE, bow, [0, 1.08, 0], [0.24, 1.62, 0], 0.045, limbMaterial);
  addCylinderBetween(THREE, bow, [0, -1.08, 0], [0.24, -1.62, 0], 0.045, limbMaterial);

  const stringGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0.24, 1.62, -0.08),
    new THREE.Vector3(-0.18, 0, -0.14),
    new THREE.Vector3(0.24, -1.62, -0.08),
  ]);
  bow.add(new THREE.Line(stringGeometry, stringMaterial));

  const sightRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.18, 0.018, 12, 48),
    sightMaterial,
  );
  sightRing.position.set(0.43, 0.24, 0.25);
  sightRing.rotation.y = Math.PI / 2;
  bow.add(sightRing);

  addCylinderBetween(THREE, bow, [0.08, 0.24, 0.08], [0.43, 0.24, 0.25], 0.018, sightMaterial);

  const levelBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.035, 0.035),
    new THREE.MeshStandardMaterial({
      color: 0xe6f4ef,
      metalness: 0.05,
      roughness: 0.5,
    }),
  );
  levelBar.position.set(0.43, -0.05, 0.25);
  bow.add(levelBar);

  attachXiaoModule(THREE, bow);

  return bow;
}

async function loadBowModel(THREE) {
  try {
    const { GLTFLoader } = await import(GLTF_LOADER_URL);
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(BOW_MODEL_URL);
    const model = gltf.scene;
    const bow = new THREE.Group();
    bow.rotation.order = "YZX";
    bow.userData.modelSource = BOW_MODEL_URL;

    const mountPoint = findNamedMountPoint(model);
    const pivotPoint = findNamedPivotPoint(model);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    if (pivotPoint) {
      pivotPoint.updateWorldMatrix(true, false);
      const pivot = new THREE.Vector3();
      pivotPoint.getWorldPosition(pivot);
      model.position.sub(pivot);
      bow.userData.modelPivotSource = pivotPoint.name;
    } else {
      model.position.sub(center);
      bow.userData.modelPivotSource = "bounding-box";
    }

    const maxDimension = Math.max(size.x, size.y, size.z);
    const scale = maxDimension > 0 ? BOW_MODEL_TARGET_SIZE / maxDimension : 1;
    model.scale.setScalar(scale);

    model.traverse((child) => {
      if (child.isMesh) {
        child.frustumCulled = false;
      }
    });

    const mcuModel = detachModelPart(THREE, model, MCU_MODEL_NAMES);

    bow.add(model);
    bow.userData.modelRoot = model;
    attachXiaoModule(THREE, bow, mountPoint, mcuModel);
    return bow;
  } catch (error) {
    console.warn(`Unable to load ${BOW_MODEL_URL}; using procedural bow fallback.`, error);
    return buildProceduralBowModel(THREE);
  }
}

async function initOrientationVisualizer(el, store) {
  if (!el.orientationCanvas) return;

  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch (error) {
    el.orientationCanvas.classList.add("orientation-unavailable");
    return;
  }

  const canvas = el.orientationCanvas;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(3.2, 1.7, 4.2);
  camera.lookAt(0, 0, 0);
  const baseCameraQuaternion = camera.quaternion.clone();
  const controls = await createOrbitControls(camera, canvas, new THREE.Vector3(0, 0, 0));

  scene.add(new THREE.AmbientLight(0xe6f4ef, 1.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.9);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);

  const guide = new THREE.Group();
  guide.add(makeLine(THREE, [[-1.45, 0, 0], [1.45, 0, 0]], 0x30e39b, 0.72));
  guide.add(makeLine(THREE, [[0, -1.45, 0], [0, 1.45, 0]], 0xe6f4ef, 0.36));
  guide.add(makeLine(THREE, [[0, 0, -1.2], [0, 0, 1.2]], 0xffbe5c, 0.42));
  scene.add(guide);

  const bow = await loadBowModel(THREE);
  scene.add(bow);

  function quaternionFromZyxEulerDeg(rollDeg, pitchDeg, yawDeg) {
    return new THREE.Quaternion().setFromEuler(
      new THREE.Euler(radians(rollDeg), radians(pitchDeg), radians(yawDeg), "ZYX"),
    );
  }

  function finiteQuaternion(qw, qx, qy, qz) {
    if (![qw, qx, qy, qz].every((v) => Number.isFinite(Number(v)))) return null;
    const q = new THREE.Quaternion(Number(qx), Number(qy), Number(qz), Number(qw));
    if (q.lengthSq() <= 0) return null;
    return q.normalize();
  }

  // Map the sensor frame (roll about X, pitch about Y, yaw about Z) onto the
  // bow model frame (roll about X, pitch about Z, yaw about Y) as a proper
  // rotation. Returns null when the invert/swap toggles describe a mirror,
  // which has no quaternion equivalent — callers fall back to the Euler path.
  function sensorToModelBasis(rollSign, pitchSign, swapRollPitch) {
    if ((swapRollPitch ? 1 : -1) * rollSign * pitchSign !== 1) return null;
    const m = new THREE.Matrix4();
    if (swapRollPitch) {
      // sensor x -> rollSign * model z, sensor y -> pitchSign * model x, sensor z -> model y
      m.set(
        0, pitchSign, 0, 0,
        0, 0, 1, 0,
        rollSign, 0, 0, 0,
        0, 0, 0, 1,
      );
    } else {
      // sensor x -> rollSign * model x, sensor y -> pitchSign * model z, sensor z -> model y
      m.set(
        rollSign, 0, 0, 0,
        0, 0, 1, 0,
        0, pitchSign, 0, 0,
        0, 0, 0, 1,
      );
    }
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  // Remove the twist component about the model Y (yaw) axis, keeping the
  // roll/pitch swing. Singularity-free replacement for zeroing the yaw angle.
  function stripYawTwist(q) {
    const twist = new THREE.Quaternion(0, q.y, 0, q.w);
    if (twist.lengthSq() <= 1e-12) return q.clone();
    twist.normalize();
    return q.clone().multiply(twist.conjugate());
  }

  let targetRoll = 0;
  let targetPitch = 0;
  let targetYaw = 0;
  let visualRoll = 0;
  let visualPitch = 0;
  let visualYaw = 0;
  let modelRollSign = 1;
  let modelPitchSign = -1;
  let modelSwapRollPitch = false;
  let modelIgnoreYaw = false;
  let viewRoll = 0;
  let targetQuat = null;
  let visualQuat = null;

  store.subscribe((state) => {
    let roll = state.roll;
    let pitch = state.pitch;
    let yaw = state.yaw || 0;
    let sampleQuat = finiteQuaternion(state.qw, state.qx, state.qy, state.qz);

    if (state.reviewMode && state.reviewTrace && state.reviewTrace.length > 0) {
      const progress = Math.max(0, Math.min(1, state.replayProgress ?? 1));
      const idx = Math.min(state.reviewTrace.length - 1, Math.floor(progress * (state.reviewTrace.length - 1)));
      const pt = state.reviewTrace[idx];
      roll = pt.roll || 0;
      pitch = pt.pitch || 0;
      yaw = pt.yaw || 0;
      sampleQuat = finiteQuaternion(pt.qw, pt.qx, pt.qy, pt.qz);
    }

    targetRoll = calibratedAngle(roll, state.cantOffset);
    targetPitch = calibratedAngle(pitch, state.pitchOffset);
    targetYaw = wrapAngleDeg(calibratedAngle(yaw, state.yawOffset));
    applyModuleOrientation(bow.userData.xiaoModule, state);
    applyModulePosition(bow.userData.xiaoModule, state);
    applyModelAlignment(bow.userData.modelRoot, state);
    applyBowCustomization(bow.userData.modelRoot, state);
    viewRoll = viewRollDegrees(state);
    modelRollSign = state.modelInvertRoll ? -1 : 1;
    modelPitchSign = state.modelInvertPitch ? 1 : -1;
    modelSwapRollPitch = !!state.modelSwapRollPitch;
    modelIgnoreYaw = !!state.modelIgnoreYaw;
    if (el.orientationRollValue) {
      el.orientationRollValue.textContent = targetRoll.toFixed(1);
    }
    if (el.orientationPitchValue) {
      el.orientationPitchValue.textContent = targetPitch.toFixed(1);
    }
    if (el.orientationYawValue) {
      el.orientationYawValue.textContent = targetYaw.toFixed(1);
    }
    if (el.calOffsetRollValue) {
      el.calOffsetRollValue.textContent = (Number(state.cantOffset) || 0).toFixed(1);
    }
    if (el.calOffsetPitchValue) {
      el.calOffsetPitchValue.textContent = (Number(state.pitchOffset) || 0).toFixed(1);
    }
    if (el.calOffsetYawValue) {
      el.calOffsetYawValue.textContent = (Number(state.yawOffset) || 0).toFixed(1);
    }

    // Quaternion-driven attitude (gimbal-lock free). The Euler angles above
    // remain the source for the numeric readouts and for the fallback path.
    targetQuat = null;
    const basisQuat = sensorToModelBasis(modelRollSign, modelPitchSign, modelSwapRollPitch);
    if (sampleQuat && basisQuat) {
      const offsetQuat = quaternionFromZyxEulerDeg(
        Number(state.cantOffset) || 0,
        Number(state.pitchOffset) || 0,
        Number(state.yawOffset) || 0,
      );
      const calibrated = offsetQuat.conjugate().multiply(sampleQuat);
      let modelQuat = basisQuat
        .clone()
        .multiply(calibrated)
        .multiply(basisQuat.clone().conjugate());
      if (modelIgnoreYaw) {
        modelQuat = stripYawTwist(modelQuat);
      }
      targetQuat = modelQuat;
    }
  });

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function animate() {
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * renderer.getPixelRatio()) ||
        canvas.height !== Math.round(rect.height * renderer.getPixelRatio())) {
      resize();
    }

    visualRoll += (targetRoll - visualRoll) * 0.16;
    visualPitch += (targetPitch - visualPitch) * 0.16;
    const activeYaw = modelIgnoreYaw ? 0 : targetYaw;
    visualYaw = blendAngleDeg(visualYaw, activeYaw, 0.16);

    if (targetQuat) {
      if (!visualQuat) visualQuat = targetQuat.clone();
      else visualQuat.slerp(targetQuat, 0.16);
      bow.quaternion.copy(visualQuat);
    } else {
      visualQuat = null;
      /*
       * Euler fallback for samples without a quaternion, or when the
       * invert/swap toggles describe a mirror. The imported bow's natural
       * attitude axes are the reverse of the old procedural placeholder: cant
       * lives on model X, while pitch lives on model Z.
       */
      const modelXAngle = modelSwapRollPitch
        ? modelPitchSign * radians(visualPitch)
        : modelRollSign * radians(visualRoll);
      const modelZAngle = modelSwapRollPitch
        ? modelRollSign * radians(visualRoll)
        : modelPitchSign * radians(visualPitch);

      bow.rotation.x = modelXAngle;
      bow.rotation.z = modelZAngle;
      bow.rotation.y = radians(visualYaw);
    }
    guide.rotation.z = 0;

    if (controls) controls.update();
    applyCameraViewRoll(camera, viewRoll, baseCameraQuaternion, controls);
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  window.addEventListener("resize", resize);
  resize();
  animate();
}

export async function mountOrientationSettings({ store, el }) {
  if (!el.mountOrientationCanvas) return;

  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch (error) {
    el.mountOrientationCanvas.classList.add("orientation-unavailable");
    return;
  }

  const canvas = el.mountOrientationCanvas;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(3.1, 1.25, 4.1);
  camera.lookAt(0, 0, 0);
  const baseCameraQuaternion = camera.quaternion.clone();
  const controls = await createOrbitControls(camera, canvas, new THREE.Vector3(0, 0, 0));

  scene.add(new THREE.AmbientLight(0xe6f4ef, 1.15));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);

  const guide = makeAxisGuide(THREE, {
    size: 1.18,
    xLabel: "X axis",
    yLabel: "Y axis",
    zLabel: "Z axis",
  });
  scene.add(guide);

  const bow = await loadBowModel(THREE);
  bow.rotation.y = radians(12);
  scene.add(bow);
  let viewRoll = 0;

  // Live orientation so users can wiggle-test the mount from this card.
  // Mirrors the dashboard visualizer; 12 deg base yaw keeps the static
  // three-quarter view when no sensor is streaming.
  const MOUNT_PREVIEW_BASE_YAW_DEG = 12;
  let targetRoll = 0;
  let targetPitch = 0;
  let targetYaw = 0;
  let visualRoll = 0;
  let visualPitch = 0;
  let visualYaw = 0;
  let modelRollSign = 1;
  let modelPitchSign = -1;
  let modelSwapRollPitch = false;
  let modelIgnoreYaw = false;

  function updateOrientation(state) {
    targetRoll = calibratedAngle(state.roll, state.cantOffset);
    targetPitch = calibratedAngle(state.pitch, state.pitchOffset);
    targetYaw = wrapAngleDeg(calibratedAngle(state.yaw || 0, state.yawOffset));
    modelRollSign = state.modelInvertRoll ? -1 : 1;
    modelPitchSign = state.modelInvertPitch ? 1 : -1;
    modelSwapRollPitch = !!state.modelSwapRollPitch;
    modelIgnoreYaw = !!state.modelIgnoreYaw;
    if (el.mountLiveCantValue) el.mountLiveCantValue.textContent = targetRoll.toFixed(1);
    if (el.mountLivePitchValue) el.mountLivePitchValue.textContent = targetPitch.toFixed(1);

    const orientation = mountOrientationState(state);
    applyModuleOrientation(bow.userData.xiaoModule, state);
    applyModulePosition(bow.userData.xiaoModule, state);
    applyModelAlignment(bow.userData.modelRoot, state);
    applyBowCustomization(bow.userData.modelRoot, state);
    if (el.mountOrientationDescription) {
      el.mountOrientationDescription.textContent = orientation.description;
    }
    if (el.mountAxisXValue) el.mountAxisXValue.textContent = orientation.axes.x;
    if (el.mountAxisYValue) el.mountAxisYValue.textContent = orientation.axes.y;
    if (el.mountAxisZValue) el.mountAxisZValue.textContent = orientation.axes.z;
    if (el.mountFirmwareNote) {
      el.mountFirmwareNote.textContent = `Firmware note: ${orientation.firmware}.`;
    }
    if (el.mountOrientationSelect && el.mountOrientationSelect.value !== state.mountOrientation) {
      el.mountOrientationSelect.value = state.mountOrientation;
    }
    const modelRotation = modelAlignmentRotation(state);
    if (el.modelAxisXValue) el.modelAxisXValue.textContent = degreesLabel(modelRotation[0]);
    if (el.modelAxisYValue) el.modelAxisYValue.textContent = degreesLabel(modelRotation[1]);
    if (el.modelAxisZValue) el.modelAxisZValue.textContent = degreesLabel(modelRotation[2]);
    if (el.modelInvertRollToggle) el.modelInvertRollToggle.checked = !!state.modelInvertRoll;
    if (el.modelInvertPitchToggle) el.modelInvertPitchToggle.checked = !!state.modelInvertPitch;
    if (el.modelSwapRollPitchToggle) el.modelSwapRollPitchToggle.checked = !!state.modelSwapRollPitch;
    if (el.modelIgnoreYawToggle) el.modelIgnoreYawToggle.checked = !!state.modelIgnoreYaw;
    viewRoll = viewRollDegrees(state);
    if (el.mountViewRollValue) el.mountViewRollValue.textContent = Math.round(viewRoll);
    if (el.mountViewRollSlider) el.mountViewRollSlider.value = String(viewRoll);
    const position = mountPositionOffset(state);
    if (el.mountPositionXValue) el.mountPositionXValue.textContent = position[0].toFixed(2);
    if (el.mountPositionYValue) el.mountPositionYValue.textContent = position[1].toFixed(2);
    if (el.mountPositionZValue) el.mountPositionZValue.textContent = position[2].toFixed(2);
    if (el.mountPositionXSlider) el.mountPositionXSlider.value = String(position[0]);
    if (el.mountPositionYSlider) el.mountPositionYSlider.value = String(position[1]);
    if (el.mountPositionZSlider) el.mountPositionZSlider.value = String(position[2]);
  }

  store.subscribe(updateOrientation);
  updateOrientation(store.get());

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function animate() {
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * renderer.getPixelRatio()) ||
        canvas.height !== Math.round(rect.height * renderer.getPixelRatio())) {
      resize();
    }

    visualRoll += (targetRoll - visualRoll) * 0.16;
    visualPitch += (targetPitch - visualPitch) * 0.16;
    visualYaw = blendAngleDeg(visualYaw, modelIgnoreYaw ? 0 : targetYaw, 0.16);

    // Same axis convention as the dashboard visualizer: cant on model X,
    // pitch on model Z, with the swap toggle as a compatibility escape hatch.
    const modelXAngle = modelSwapRollPitch
      ? modelPitchSign * radians(visualPitch)
      : modelRollSign * radians(visualRoll);
    const modelZAngle = modelSwapRollPitch
      ? modelRollSign * radians(visualRoll)
      : modelPitchSign * radians(visualPitch);

    bow.rotation.x = modelXAngle;
    bow.rotation.z = modelZAngle;
    bow.rotation.y = radians(MOUNT_PREVIEW_BASE_YAW_DEG + visualYaw);
    if (controls) controls.update();
    applyCameraViewRoll(camera, viewRoll, baseCameraQuaternion, controls);
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  window.addEventListener("resize", resize);
  resize();
  animate();
}

export async function mountBowShop({ store, el, saveSettingsToCache = null }) {
  if (!el.bowShopCanvas) return;

  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch (error) {
    el.bowShopCanvas.classList.add("orientation-unavailable");
    return;
  }

  const canvas = el.bowShopCanvas;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(3.2, 1.35, 4.25);
  camera.lookAt(0, 0, 0);
  const controls = await createOrbitControls(camera, canvas, new THREE.Vector3(0, 0, 0));

  scene.add(new THREE.AmbientLight(0xe6f4ef, 1.15));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x35c7e8, 0.55);
  fillLight.position.set(-3, 1.5, 2);
  scene.add(fillLight);

  const guide = makeAxisGuide(THREE, {
    size: 1.1,
    xLabel: "X",
    yLabel: "Y",
    zLabel: "Z",
  });
  scene.add(guide);

  const bow = await loadBowModel(THREE);
  bow.rotation.y = radians(12);
  scene.add(bow);
  renderBowMaterialColorControls(
    collectBowMaterials(bow.userData.modelRoot),
    store,
    el,
    saveSettingsToCache,
  );

  function updateCustomization(state) {
    applyModuleOrientation(bow.userData.xiaoModule, state);
    applyModulePosition(bow.userData.xiaoModule, state);
    applyModelAlignment(bow.userData.modelRoot, state);
    applyBowCustomization(bow.userData.modelRoot, state);
  }

  store.subscribe(updateCustomization);
  updateCustomization(store.get());

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function animate() {
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * renderer.getPixelRatio()) ||
        canvas.height !== Math.round(rect.height * renderer.getPixelRatio())) {
      resize();
    }

    bow.rotation.y = radians(12);
    if (controls) controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  window.addEventListener("resize", resize);
  resize();
  animate();
}

export function mountDashboard({ store, telemetry, el }) {
  const ctx = el.traceCanvas.getContext("2d");
  initOrientationVisualizer(el, store);

  // Interactive RELEASE & HIT Marker Dragging
  let draggedMarker = null;

  const getMarkerClickTarget = (xClient, yClient) => {
    const state = store.get();
    if (!state.reviewMode || !state.reviewTrace) return null;

    const canvas = el.traceCanvas;
    const rect = canvas.getBoundingClientRect();
    const clientWidth = rect.width;
    const clientHeight = rect.height;

    const isTargetView = state.chartView === "target";
    const bandHeight = isTargetView ? 0.2 : 0.3;
    const bandTopClient = clientHeight * (1 - bandHeight);

    if (yClient < bandTopClient) return null;

    const timeRangeUs = reviewTimeRangeUs(state, state.reviewTrace);
    const maxIdx = state.reviewTrace.length - 1;
    if (maxIdx <= 0) return null;

    const getXForTime = (timeMs, idx) => {
      if (
        timeRangeUs &&
        timeRangeUs.end > timeRangeUs.start &&
        timeMs !== null &&
        timeMs !== undefined
      ) {
        const tUs = timeMs * 1000;
        return ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * clientWidth;
      }
      if (idx !== null && idx !== undefined && idx >= 0) {
        return (idx / maxIdx) * clientWidth;
      }
      return null;
    };

    const xRelease = getXForTime(state.reviewReleaseTimeMs, state.reviewReleaseIdx);
    const xHit = getXForTime(state.reviewHitTimeMs, state.reviewHitIdx);

    const threshold = 15;
    let target = null;
    let minDist = Infinity;

    if (xRelease !== null) {
      const dist = Math.abs(xClient - xRelease);
      if (dist <= threshold && dist < minDist) {
        minDist = dist;
        target = "release";
      }
    }

    if (xHit !== null) {
      const dist = Math.abs(xClient - xHit);
      if (dist <= threshold && dist < minDist) {
        minDist = dist;
        target = "hit";
      }
    }

    return target;
  };

  const handleDragMove = (xClient) => {
    if (!draggedMarker) return;
    const state = store.get();
    if (!state.reviewMode || !state.reviewTrace) return;

    const canvas = el.traceCanvas;
    const rect = canvas.getBoundingClientRect();
    const clientWidth = rect.width;
    const frac = Math.max(0, Math.min(1, xClient / clientWidth));

    const timeRangeUs = reviewTimeRangeUs(state, state.reviewTrace);
    const maxIdx = state.reviewTrace.length - 1;
    if (maxIdx <= 0) return;

    let timeMs = 0;
    let idx = 0;

    if (timeRangeUs && timeRangeUs.end > timeRangeUs.start) {
      const tUs = timeRangeUs.start + frac * (timeRangeUs.end - timeRangeUs.start);
      timeMs = tUs / 1000;
      idx = Math.max(0, Math.min(maxIdx, Math.round(frac * maxIdx)));
    } else {
      idx = Math.max(0, Math.min(maxIdx, Math.round(frac * maxIdx)));
      const f = state.reviewTrace[idx];
      if (f.tUs !== undefined) {
        timeMs = f.tUs / 1000;
      } else {
        const hz = state.reviewSampleRateHz || 52;
        timeMs = (idx * 1000) / hz;
      }
    }

    const updates = {};
    if (draggedMarker === "release") {
      updates.reviewReleaseIdx = idx;
      updates.reviewReleaseTimeMs = timeMs;
    } else if (draggedMarker === "hit") {
      updates.reviewHitIdx = idx;
      updates.reviewHitTimeMs = timeMs;
    }

    const newRelease = draggedMarker === "release" ? timeMs : state.reviewReleaseTimeMs;
    const newHit = draggedMarker === "hit" ? timeMs : state.reviewHitTimeMs;

    getActiveArrowSpeed().then((speedVal) => {
      const range = calculateRangeFromTimes(newRelease, newHit, speedVal);
      const rangeText = range
        ? `| Est. Range: ${range.yards.toFixed(1)} yds (${Math.round(range.feet)} ft) @ ${speedVal} fps`
        : "";

      updates.reviewRangeEst = rangeText;
      store.set(updates);
    });
  };

  el.traceCanvas.addEventListener("mousedown", (e) => {
    const target = getMarkerClickTarget(e.offsetX, e.offsetY);
    if (target) {
      draggedMarker = target;
    }
  });

  el.traceCanvas.addEventListener("mousemove", (e) => {
    if (draggedMarker) {
      handleDragMove(e.offsetX);
    } else {
      const target = getMarkerClickTarget(e.offsetX, e.offsetY);
      el.traceCanvas.style.cursor = target ? "ew-resize" : "";
    }
  });

  const endDrag = () => {
    draggedMarker = null;
    if (el.traceCanvas) {
      el.traceCanvas.style.cursor = "";
    }
  };

  el.traceCanvas.addEventListener("mouseup", endDrag);
  el.traceCanvas.addEventListener("mouseleave", endDrag);

  // Touch Drag Support
  el.traceCanvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = el.traceCanvas.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const target = getMarkerClickTarget(x, y);
      if (target) {
        draggedMarker = target;
      }
    }
  });

  el.traceCanvas.addEventListener("touchmove", (e) => {
    if (draggedMarker && e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = el.traceCanvas.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      handleDragMove(x);
      e.preventDefault(); // Disable scroll/pinch gesture while dragging a marker
    }
  }, { passive: false });

  el.traceCanvas.addEventListener("touchend", endDrag);

  let filteredRoll = null;
  let lastUpdateTime = null;

  store.subscribe((s) => {
    el.statusBadge.className = `status clickable ${s.statusMode || ""}`.trim();
    el.statusBadge.title = s.connected ? "Disconnect Sensor" : "Connect Sensor";
    el.statusText.textContent = s.statusText;

    // Toggle Review Mode layout components reactively
    if (el.reviewBanner && el.reviewInfo && el.chartTitle) {
      if (s.reviewMode) {
        el.reviewBanner.classList.remove("hidden");
        el.chartTitle.textContent = "Trace Review Mode";
        el.reviewInfo.textContent = s.reviewInfo || "";
        if (el.reviewRangeEst) {
          el.reviewRangeEst.textContent = s.reviewRangeEst || "";
        }
      } else {
        el.reviewBanner.classList.add("hidden");
        el.chartTitle.textContent = "Shot Sequence Trace";
        if (el.reviewRangeEst) {
          el.reviewRangeEst.textContent = "";
        }
      }
    }

    let roll = s.roll;
    let pitch = s.pitch;
    let yaw = s.yaw || 0;
    let accelG = s.accelG || 0;
    let gyroMag = s.gyroMag || 0;

    if (s.reviewMode && s.reviewTrace && s.reviewTrace.length > 0) {
      const progress = Math.max(0, Math.min(1, s.replayProgress ?? 1));
      const idx = Math.min(s.reviewTrace.length - 1, Math.floor(progress * (s.reviewTrace.length - 1)));
      const pt = s.reviewTrace[idx];
      roll = pt.roll || 0;
      pitch = pt.pitch || 0;
      yaw = pt.yaw || 0;
      
      accelG = Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0);
      gyroMag = Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0);
    }

    el.hzValue.textContent = s.reviewMode ? "--" : String(s.hz || 0);
    el.lossValue.textContent = s.reviewMode ? "--" : String(s.lost || 0);
    el.frameCountValue.textContent = s.reviewMode ? "--" : String(s.frameCount || 0);
    el.shotCountValue.textContent = String(s.shotCount || 0);

    let hasMic = s.connected && !s.reviewMode && s.sample && s.sample.micAmp !== undefined;
    let micPct = hasMic ? Math.round((s.sample.micAmp / 255) * 100) : 0;
    if (s.reviewMode && s.reviewMicSeries?.length) {
      hasMic = true;
      const replayProgress = Math.max(0, Math.min(1, s.replayProgress ?? 1));
      const endIdx = Math.max(
        0,
        Math.min(s.reviewMicSeries.length - 1, Math.floor(replayProgress * (s.reviewMicSeries.length - 1))),
      );
      const peak = s.reviewMicSeries
        .slice(0, endIdx + 1)
        .reduce((max, point) => Math.max(max, point.micAmp || 0), 0);
      micPct = Math.round((peak / 255) * 100);
    } else if (s.reviewMode && s.reviewTrace?.length) {
      const peak = s.reviewTrace.reduce((max, point) => Math.max(max, point.micAmp || 0), 0);
      if (peak > 0) {
        hasMic = true;
        micPct = Math.round((peak / 255) * 100);
      }
    }
    if (el.micVolumeItem) {
      el.micVolumeItem.classList.toggle("hidden", !hasMic);
      if (hasMic && el.volBar) {
        el.volBar.style.width = `${micPct}%`;
      }
    }

    const uploadPending = s.reviewMode ? 0 : s.uploadPending || 0;
    if (el.uploadStatusItem) {
      el.uploadStatusItem.classList.toggle("hidden", uploadPending <= 0);
    }
    if (el.uploadCountValue) {
      el.uploadCountValue.textContent = String(uploadPending);
    }

    const now = performance.now();
    const calibratedRoll = calibratedAngle(roll, s.cantOffset);
    
    if (s.reviewMode) {
      filteredRoll = null;
      lastUpdateTime = null;
    }

    if (filteredRoll === null || lastUpdateTime === null) {
      filteredRoll = calibratedRoll;
    } else {
      const dt = (now - lastUpdateTime) / 1000;
      if (dt > 0.5) {
        filteredRoll = calibratedRoll;
      } else {
        const timeConstant = 0.08; // 80ms filter time constant (vial fluid viscosity)
        const alpha = 1 - Math.exp(-dt / timeConstant);
        filteredRoll = alpha * calibratedRoll + (1 - alpha) * filteredRoll;
      }
    }
    lastUpdateTime = now;

    el.cantValue.textContent = `${filteredRoll.toFixed(1)}`;
    renderBubbleLevel(el, filteredRoll, s.levelRange, s.levelTolerance);
    if (el.orientationYawValue) {
      const calibratedYaw = wrapAngleDeg(calibratedAngle(yaw, s.yawOffset));
      el.orientationYawValue.textContent = calibratedYaw.toFixed(1);
    }

    if (el.formScoreValue) el.formScoreValue.textContent = s.formScore == null ? "--" : String(s.formScore);
    if (el.holdStabilityValue) el.holdStabilityValue.textContent = s.holdStability == null ? "--" : `${s.holdStability}%`;
    if (el.releaseQualityValue) el.releaseQualityValue.textContent = s.releaseQuality == null ? "--" : `${s.releaseQuality}%`;
    if (el.followThroughValue) el.followThroughValue.textContent = s.followThrough == null ? "--" : `${s.followThrough}%`;
    if (el.coachTitle) el.coachTitle.textContent = s.coachTitle || "Waiting for movement";
    if (el.coachText) el.coachText.textContent = s.coachText || "Connect a sensor or run the demo to start reading hold stability.";

    if (s.reviewMode || s.sample) {
      if (el.protocolValue) el.protocolValue.textContent = s.reviewMode ? "IndexedDB" : String(s.sample.protocol);
      if (el.typeValue) el.typeValue.textContent = s.reviewMode ? "Trace Point" : String(s.sample.type);
      if (el.sourceValue) el.sourceValue.textContent = s.reviewMode ? "Replay" : s.sample.source;
      if (el.seqValue) el.seqValue.textContent = s.reviewMode ? "N/A" : String(s.sample.sequence);
      if (el.dtValue) el.dtValue.textContent = s.reviewMode ? "--" : String(s.sample.dtUs);
    }
  });

  function resize() {
    const rect = el.traceCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    el.traceCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    el.traceCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    refreshCanvasInk();
    const rect = el.traceCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const state = store.get();
    const data = state.reviewMode ? (state.reviewTrace || []) : telemetry.getTrace();

    if (state.chartView === "target") {
      const cx = w / 2;
      const cy = h / 2;
      const maxRadius = Math.min(w, h) * 0.45;

      // Draw concentric archery target rings outer-to-inner (White, Black, Blue, Red, Yellow)
      const colors = ["#FFFFFF", "#1E1E1E", "#00B5E2", "#EE383E", "#FFE000"];
      const radii = [maxRadius, maxRadius * 0.8, maxRadius * 0.6, maxRadius * 0.4, maxRadius * 0.2];

      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = colors[i];
        ctx.strokeStyle = "rgba(142, 166, 160, 0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, radii[i], 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();

        // Sub-ring detailed line
        ctx.beginPath();
        ctx.arc(cx, cy, radii[i] - (radii[i] - (radii[i + 1] || 0)) / 2, 0, 2 * Math.PI);
        ctx.stroke();
      }

      if (data.length >= 2) {
        const replayProgress = state.reviewMode ? Math.max(0, Math.min(1, state.replayProgress ?? 1)) : 1;
        const replayCount = Math.max(2, Math.ceil(data.length * replayProgress));
        const visibleData = state.reviewMode ? data.slice(0, replayCount) : data;
        const targetZoom = state.reviewMode ? state.traceZoom || 1 : 1;
        let rollCenter = 0;
        let pitchCenter = 0;

        const thresholdG = state.reviewMode && state.reviewThresholdG != null
          ? state.reviewThresholdG
          : (state.threshold ?? 12.0);
        const { releaseIdx, hasRelease } = findReleaseIndex(data, state.reviewMode, thresholdG);
        const holdData = holdWindow(data, releaseIdx, hasRelease);

        if (state.reviewMode) {
          const center = reviewTraceCenter(data, releaseIdx, hasRelease, holdData);
          rollCenter = center.roll;
          pitchCenter = center.pitch;
        } else {
          // Centering around hold average in live streaming view
          let sumRoll = 0;
          let sumPitch = 0;
          for (let i = 0; i < data.length; i++) {
            sumRoll += data[i].roll || 0;
            sumPitch += data[i].pitch || 0;
          }
          rollCenter = sumRoll / data.length;
          pitchCenter = sumPitch / data.length;
        }

        const primaryScalePts = reviewScalePoints(data, releaseIdx, hasRelease);
        const primaryNormMaxDev = maxDeviationAround(primaryScalePts, rollCenter, pitchCenter);

        let compareOverlay = null;
        let compareNormMaxDev = 1.0;
        if (state.reviewMode && state.compareTrace && state.compareTrace.length >= 2) {
          const compareData = state.compareTrace;
          const compareThreshold = state.compareThresholdG ?? 12;
          const compareRelease = findReleaseIndex(compareData, true, compareThreshold);
          const compareHoldData = holdWindow(
            compareData,
            compareRelease.releaseIdx,
            compareRelease.hasRelease,
          );
          const compareCenter = reviewTraceCenter(
            compareData,
            compareRelease.releaseIdx,
            compareRelease.hasRelease,
            compareHoldData,
          );
          const compareScalePts = reviewScalePoints(
            compareData,
            compareRelease.releaseIdx,
            compareRelease.hasRelease,
          );
          compareNormMaxDev = maxDeviationAround(
            compareScalePts,
            compareCenter.roll,
            compareCenter.pitch,
          );
          compareOverlay = {
            traceData: compareData,
            releaseIdx: compareRelease.releaseIdx,
            hasRelease: compareRelease.hasRelease,
            rollCenter: compareCenter.roll,
            pitchCenter: compareCenter.pitch,
          };
        }

        // Solo review: one shared scale from the primary trace extent.
        // Compare mode: each trace is normalized to its own movement extent, then
        // drawn with the same display scale so neither looks compressed on the face.
        const displayScale = maxRadius * REVIEW_TARGET_SCALE_FIT * targetZoom;
        const primaryDrawScale = displayScale / primaryNormMaxDev;
        const mapPoint = (pt) => ({
          x: cx - ((pt.roll || 0) - rollCenter) * primaryDrawScale,
          y: cy - ((pt.pitch || 0) - pitchCenter) * primaryDrawScale,
        });

        if (compareOverlay) {
          drawCompareReviewTrace(ctx, {
            traceData: compareOverlay.traceData,
            releaseIdx: compareOverlay.releaseIdx,
            hasRelease: compareOverlay.hasRelease,
            rollCenter: compareOverlay.rollCenter,
            pitchCenter: compareOverlay.pitchCenter,
            displayScale,
            normMaxDev: compareNormMaxDev,
            cx,
            cy,
            replayProgress,
          });
        }

        drawSigmaEllipse(ctx, holdData, mapPoint);

        // Decimate visibleData for drawing when the point count exceeds the
        // canvas pixel width — sub-pixel segments are invisible, so we keep
        // at most ~2× the pixel width for smooth curves plus all phase-boundary
        // and release points which must remain precise.
        const maxDrawPts = Math.max(200, Math.round(w * 2));
        let drawData = visibleData;
        if (visibleData.length > maxDrawPts) {
          const step = visibleData.length / maxDrawPts;
          drawData = [];
          let nextSlot = 0;
          for (let i = 0; i < visibleData.length; i++) {
            if (i >= nextSlot || i === visibleData.length - 1 || i === releaseIdx) {
              drawData.push({ _origIdx: i, ...visibleData[i] });
              nextSlot = i + step;
            }
          }
        }

        // Batch trace segments by phase colour — one beginPath/stroke per
        // phase run instead of per-segment (~4 draw calls vs ~6000).
        ctx.lineWidth = 2.8;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        let curPhase = null;
        for (let i = 1; i < drawData.length; i++) {
          const origIdx = drawData[i]._origIdx ?? i;
          const phase = phaseForIndex(origIdx, releaseIdx, hasRelease, data.length);
          if (phase !== curPhase) {
            // Flush previous run
            if (curPhase !== null) ctx.stroke();
            curPhase = phase;
            ctx.strokeStyle = phaseColor(phase);
            ctx.beginPath();
            const prev = mapPoint(drawData[i - 1]);
            ctx.moveTo(prev.x, prev.y);
          }
          const p = mapPoint(drawData[i]);
          ctx.lineTo(p.x, p.y);
        }
        if (curPhase !== null) ctx.stroke();

        if (hasRelease && visibleData.length > releaseIdx) {
          const releasePoint = mapPoint(data[releaseIdx]);
          ctx.save();
          ctx.strokeStyle = "#FF5D73";
          ctx.fillStyle = "rgba(255, 93, 115, 0.18)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(releasePoint.x, releasePoint.y, 12, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(releasePoint.x - 16, releasePoint.y);
          ctx.lineTo(releasePoint.x + 16, releasePoint.y);
          ctx.moveTo(releasePoint.x, releasePoint.y - 16);
          ctx.lineTo(releasePoint.x, releasePoint.y + 16);
          ctx.stroke();
          ctx.restore();
        }

        // Draw current pin dot or release position marker
        const finalPt = visibleData[visibleData.length - 1];
        const finalPoint = mapPoint(finalPt);
        const finalPhase = phaseForIndex(visibleData.length - 1, releaseIdx, hasRelease, data.length);

        ctx.fillStyle = phaseColor(finalPhase);
        ctx.beginPath();
        ctx.arc(finalPoint.x, finalPoint.y, 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = canvasInk.dotRing;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.strokeStyle = canvasInk.crosshair;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(finalPoint.x - 11, finalPoint.y);
        ctx.lineTo(finalPoint.x + 11, finalPoint.y);
        ctx.moveTo(finalPoint.x, finalPoint.y - 11);
        ctx.lineTo(finalPoint.x, finalPoint.y + 11);
        ctx.stroke();

        if (state.reviewMode) {
          ctx.fillStyle = canvasInk.label;
          ctx.font = "700 11px ui-monospace, Consolas, monospace";
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          ctx.fillText(`zoom ${targetZoom.toFixed(1)}x`, w - 12, h - 12);
          ctx.textAlign = "left";
          const phaseHint = "green hold  red release  gray follow";
          const compareHint = compareOverlay
            ? "  |  cyan = compare (release centered, matched scale)"
            : "";
          ctx.fillText(phaseHint + compareHint, 12, h - 12);
        }
      }

      const reviewMic = reviewMicChartData(state);
      if (reviewMic?.length) {
        // Share the union of the motion-trace and mic-series time ranges, same
        // as the line/motion view. Using the motion range alone squished the
        // audio and clipped its tail because the mic is captured over a wider
        // window at a higher rate.
        const timeRangeUs = reviewLineTimeRangeUs(state, state.reviewTrace, reviewMic);
        drawMicSeries(
          ctx,
          reviewMic,
          "micAmp",
          "rgba(53, 199, 232, 0.55)",
          "rgba(53, 199, 232, 0.22)",
          w,
          h,
          {
            bandHeight: 0.2,
            label: "Audio",
            timeRangeUs,
            releaseTimeMs: state.reviewReleaseTimeMs,
            hitTimeMs: state.reviewHitTimeMs,
            releaseIdx: state.reviewReleaseIdx,
            hitIdx: state.reviewHitIdx,
          },
        );
      }
    } else {
      ctx.strokeStyle = "rgba(142, 166, 160, 0.22)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i += 1) {
        const y = (h / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const state = store.get();
      const data = state.reviewMode ? (state.reviewTrace || []) : telemetry.getTrace();
      const micData = state.reviewMode ? (reviewMicChartData(state) || data) : data;
      // Share one x-axis between the accel lines and the mic band: the union of
      // both series' real-timestamp ranges. With real tUs (browser captures)
      // both map by time even though the mic samples at ~1110 Hz and the motion
      // trace at 52-208 Hz over a different window; the union keeps the audio
      // from being squished or clipped. Without real tUs (firmware traces) it
      // returns null and both fall back to index mapping, still aligned because
      // the mic series is derived from the same payload.
      const timeRangeUs = state.reviewMode
        ? reviewLineTimeRangeUs(state, data, micData)
        : null;

      // Draw raw mic channel in the background (bottom band)
      drawMicSeries(
        ctx,
        micData,
        "micAmp",
        "rgba(53, 199, 232, 0.45)",
        "rgba(53, 199, 232, 0.15)",
        w,
        h,
        state.reviewMode ? {
          bandHeight: 0.3,
          label: "Audio",
          timeRangeUs,
          releaseTimeMs: state.reviewReleaseTimeMs,
          hitTimeMs: state.reviewHitTimeMs,
          releaseIdx: state.reviewReleaseIdx,
          hitIdx: state.reviewHitIdx,
        } : undefined,
      );

      if (hasQuaternionSeries(data)) {
        drawSeries(ctx, data, "qw", cssVar("--green"), w, h, timeRangeUs, 1);
        drawSeries(ctx, data, "qx", cssVar("--cyan"), w, h, timeRangeUs, 1);
        drawSeries(ctx, data, "qy", cssVar("--amber"), w, h, timeRangeUs, 1);
        drawSeries(ctx, data, "qz", "#ff5d73", w, h, timeRangeUs, 1);
        drawChartLegend(ctx, [
          ["qw", cssVar("--green")],
          ["qx", cssVar("--cyan")],
          ["qy", cssVar("--amber")],
          ["qz", "#ff5d73"],
        ], w);
      } else {
        drawSeries(ctx, data, "ax", cssVar("--green"), w, h, timeRangeUs);
        drawSeries(ctx, data, "ay", cssVar("--cyan"), w, h, timeRangeUs);
        drawSeries(ctx, data, "az", cssVar("--amber"), w, h, timeRangeUs);
        drawChartLegend(ctx, [
          ["ax", cssVar("--green")],
          ["ay", cssVar("--cyan")],
          ["az", cssVar("--amber")],
        ], w);
      }
      drawSequenceMarkers(ctx, data, w, h, state.reviewMode);
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  resize();
  draw();
}

function drawChartLegend(ctx, items, w) {
  ctx.save();
  ctx.font = "700 11px ui-monospace, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  let x = 10;
  for (const [label, color] of items) {
    ctx.fillStyle = color;
    ctx.fillText(label, x, 10);
    x += Math.max(28, ctx.measureText(label).width + 14);
    if (x > w - 32) break;
  }
  ctx.restore();
}

function drawSeries(ctx, data, key, color, w, h, timeRangeUs = null, limit = 2) {
  if (data.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const maxIdx = data.length - 1;
  const useTime = !!(timeRangeUs && timeRangeUs.end > timeRangeUs.start);

  // When the dataset is much wider than the canvas, decimate with a min/max
  // bucket strategy that preserves visual peaks while skipping sub-pixel detail.
  const maxVerts = Math.max(200, Math.round(w * 2));
  const step = data.length > maxVerts ? data.length / maxVerts : 1;

  if (step <= 1) {
    // No decimation needed — draw every point
    for (let i = 0; i < data.length; i += 1) {
      const tUs = Number(data[i].tUs);
      const x =
        useTime && Number.isFinite(tUs)
          ? Math.max(
              0,
              Math.min(w, ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * w),
            )
          : (i / maxIdx) * w;
      const value = Number(data[i][key]);
      const clamped = Number.isFinite(value)
        ? Math.max(-limit, Math.min(limit, value))
        : 0;
      const y = h / 2 - (clamped / (limit * 2)) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    // Min-max bucket decimation: for each pixel-width bucket, emit the point
    // with the minimum and maximum Y value to preserve peaks/troughs.
    const xForIdx = (idx) => {
      if (useTime) {
        const tUs = Number(data[idx].tUs);
        if (Number.isFinite(tUs)) {
          return Math.max(0, Math.min(w, ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * w));
        }
      }
      return (idx / maxIdx) * w;
    };
    const yForIdx = (idx) => {
      const value = Number(data[idx][key]);
      const clamped = Number.isFinite(value)
        ? Math.max(-limit, Math.min(limit, value))
        : 0;
      return h / 2 - (clamped / (limit * 2)) * h;
    };

    // First point
    ctx.moveTo(xForIdx(0), yForIdx(0));

    for (let b = 0; b < maxVerts; b++) {
      const bStart = Math.round(b * step);
      const bEnd = Math.min(data.length - 1, Math.round((b + 1) * step) - 1);
      if (bStart > maxIdx) break;

      let minY = Infinity, maxY = -Infinity, minIdx = bStart, maxIdx2 = bStart;
      for (let j = bStart; j <= bEnd; j++) {
        const y = yForIdx(j);
        if (y < minY) { minY = y; minIdx = j; }
        if (y > maxY) { maxY = y; maxIdx2 = j; }
      }

      // Emit min then max in index order to preserve waveform direction
      const first = minIdx <= maxIdx2 ? minIdx : maxIdx2;
      const second = minIdx <= maxIdx2 ? maxIdx2 : minIdx;
      ctx.lineTo(xForIdx(first), yForIdx(first));
      if (first !== second) {
        ctx.lineTo(xForIdx(second), yForIdx(second));
      }
    }
  }

  ctx.stroke();
}

function drawMicSeries(ctx, data, key, baseColor, w, h, options = {}) {
  if (data.length < 2) return;

  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const val = data[i][key];
    if (val !== undefined && val > peak) peak = val;
  }
  if (peak <= 0) return;

  const bandHeight = options.bandHeight ?? 0.3;
  const bandTop = options.bandTop ?? h * (1 - bandHeight);
  const bandBottom = bandTop + h * bandHeight;
  const bandPixelHeight = bandBottom - bandTop;

  ctx.save();
  ctx.lineWidth = 1.5;

  const maxIdx = data.length - 1;
  const timeRangeUs = options.timeRangeUs || null;
  const xForPoint = (point, index) => {
    const tUs = Number(point.tUs);
    if (
      timeRangeUs &&
      Number.isFinite(tUs) &&
      timeRangeUs.end > timeRangeUs.start
    ) {
      return Math.max(
        0,
        Math.min(w, ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * w),
      );
    }
    return (index / maxIdx) * w;
  };

  const yForMicIdx = (index) => {
    const val = data[index][key] || 0;
    const ratio = val / peak;
    return bandBottom - ratio * bandPixelHeight;
  };

  // 1. Draw fill
  ctx.fillStyle = baseColor;
  ctx.save();
  ctx.globalAlpha = options.fillOpacity ?? 0.15;
  ctx.beginPath();
  ctx.moveTo(xForPoint(data[0], 0), bandBottom);
  const maxVerts = Math.max(200, Math.round(w * 2));
  const micStep = data.length > maxVerts ? data.length / maxVerts : 1;
  if (micStep <= 1) {
    for (let i = 0; i < data.length; i += 1) {
      ctx.lineTo(xForPoint(data[i], i), yForMicIdx(i));
    }
  } else {
    for (let b = 0; b < maxVerts; b++) {
      const bStart = Math.round(b * micStep);
      const bEnd = Math.min(data.length - 1, Math.round((b + 1) * micStep) - 1);
      if (bStart > maxIdx) break;
      let bestIdx = bStart, bestY = Infinity;
      for (let j = bStart; j <= bEnd; j++) {
        const y = yForMicIdx(j);
        if (y < bestY) { bestY = y; bestIdx = j; }
      }
      ctx.lineTo(xForPoint(data[bestIdx], bestIdx), bestY);
    }
  }
  ctx.lineTo(w, bandBottom);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 2. Draw stroke
  ctx.strokeStyle = baseColor;
  ctx.save();
  ctx.globalAlpha = options.strokeOpacity ?? 0.45;
  ctx.beginPath();
  if (micStep <= 1) {
    for (let i = 0; i < data.length; i += 1) {
      const x = xForPoint(data[i], i);
      const y = yForMicIdx(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    ctx.moveTo(xForPoint(data[0], 0), yForMicIdx(0));
    for (let b = 0; b < maxVerts; b++) {
      const bStart = Math.round(b * micStep);
      const bEnd = Math.min(data.length - 1, Math.round((b + 1) * micStep) - 1);
      if (bStart > maxIdx) break;
      let bestIdx = bStart, bestY = Infinity;
      for (let j = bStart; j <= bEnd; j++) {
        const y = yForMicIdx(j);
        if (y < bestY) { bestY = y; bestIdx = j; }
      }
      ctx.lineTo(xForPoint(data[bestIdx], bestIdx), bestY);
    }
  }
  ctx.stroke();
  ctx.restore();

  if (options.label) {
    ctx.fillStyle = canvasInk.label;
    ctx.font = "600 10px ui-monospace, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(options.label, 8, bandTop + 4);
  }

  // Draw release and target hit markers if available
  const getXForTime = (timeMs, idx) => {
    if (
      timeRangeUs &&
      timeRangeUs.end > timeRangeUs.start &&
      timeMs !== null &&
      timeMs !== undefined
    ) {
      const tUs = timeMs * 1000;
      return Math.max(
        0,
        Math.min(w, ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * w),
      );
    }
    return idx !== null && idx !== undefined && idx >= 0
      ? (idx / maxIdx) * w
      : null;
  };

  const xRelease = getXForTime(options.releaseTimeMs, options.releaseIdx);
  const xHit = getXForTime(options.hitTimeMs, options.hitIdx);

  if (xRelease !== null && xRelease >= 0 && xRelease <= w) {
    ctx.save();
    ctx.strokeStyle = canvasInk.release;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xRelease, bandTop);
    ctx.lineTo(xRelease, bandBottom);
    ctx.stroke();

    ctx.fillStyle = canvasInk.release;
    ctx.font = "700 9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("RELEASE", xRelease - 4, bandTop + 4);
    ctx.restore();
  }

  if (xHit !== null && xHit >= 0 && xHit <= w) {
    ctx.save();
    ctx.strokeStyle = canvasInk.cyan;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xHit, bandTop);
    ctx.lineTo(xHit, bandBottom);
    ctx.stroke();

    ctx.fillStyle = canvasInk.cyan;
    ctx.font = "700 9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("HIT", xHit + 4, bandTop + 4);
    ctx.restore();
  }

  ctx.restore();
}

function drawSequenceMarkers(ctx, data, w, h, reviewMode) {
  if (data.length < 20) return;

  const markerColor = canvasInk.marker;
  const labels = reviewMode
    ? [
        { x: 0.2, text: "hold" },
        { x: 0.62, text: "release" },
        { x: 0.84, text: "follow" },
      ]
    : [
        { x: 0.33, text: "hold" },
        { x: 0.67, text: "float" },
      ];

  ctx.save();
  ctx.font = "700 10px ui-monospace, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const marker of labels) {
    const x = marker.x * w;
    ctx.strokeStyle = markerColor;
    ctx.setLineDash([4, 7]);
    ctx.beginPath();
    ctx.moveTo(x, 10);
    ctx.lineTo(x, h - 10);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = canvasInk.label;
    ctx.fillText(marker.text, x, 12);
  }
  ctx.restore();
}

export function mountLog(bus, logEl) {
  bus.on("log", (message) => {
    const stamp = new Date().toLocaleTimeString();
    logEl.textContent = `[${stamp}] ${message}\n` + logEl.textContent;
  });
}
