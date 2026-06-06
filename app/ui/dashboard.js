// UI layer: renders the dashboard from store state and paints the live trace.
// Pure view code — it reads from the store and telemetry, never the device.

import { MAX_TRACE_POINTS } from "../telemetry/telemetry.js";

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
  if (phase === "release") return "#FF5D73";
  if (phase === "break") return "#FFBE5C";
  if (phase === "follow") return "rgba(230, 244, 239, 0.58)";
  return "#30E39B";
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
    x: cx + (((pt.roll || 0) - rollCenter) / normMaxDev) * displayScale,
    y: cy - (((pt.pitch || 0) - pitchCenter) / normMaxDev) * displayScale,
  });

  ctx.save();
  ctx.strokeStyle = "#35C7E8";
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
    ctx.strokeStyle = "rgba(53, 199, 232, 0.9)";
    ctx.fillStyle = "rgba(53, 199, 232, 0.16)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy);
    ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx, cy + 12);
    ctx.stroke();
  }

  const finalPt = mapPoint(visible[visible.length - 1]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#35C7E8";
  ctx.beginPath();
  ctx.arc(finalPt.x, finalPt.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#FFFFFF";
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
  ctx.rotate(-angle);
  ctx.fillStyle = "rgba(48, 227, 155, 0.15)";
  ctx.strokeStyle = "rgba(48, 227, 155, 0.72)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
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
  ctx.strokeStyle = "rgba(6, 16, 20, 0.9)";
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
  const colors = {
    x: 0x30e39b,
    y: 0xe6f4ef,
    z: 0xffbe5c,
  };
  const labelColors = {
    x: "#30E39B",
    y: "#E6F4EF",
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

  store.subscribe((state) => {
    let roll = state.roll;
    let pitch = state.pitch;
    let yaw = state.yaw || 0;

    if (state.reviewMode && state.reviewTrace && state.reviewTrace.length > 0) {
      const progress = Math.max(0, Math.min(1, state.replayProgress ?? 1));
      const idx = Math.min(state.reviewTrace.length - 1, Math.floor(progress * (state.reviewTrace.length - 1)));
      const pt = state.reviewTrace[idx];
      roll = pt.roll || 0;
      pitch = pt.pitch || 0;
      yaw = pt.yaw || 0;
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

    /*
     * The imported bow's natural attitude axes are the reverse of the old
     * procedural placeholder: cant lives on model X, while pitch lives on model
     * Z. The swap toggle now acts as a compatibility escape hatch.
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

  function updateOrientation(state) {
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

    bow.rotation.y = radians(12);
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
      } else {
        el.reviewBanner.classList.add("hidden");
        el.chartTitle.textContent = "Shot Sequence Trace";
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

    const hasMic = s.connected && !s.reviewMode && s.sample && s.sample.micAmp !== undefined;
    if (el.micVolumeItem) {
      el.micVolumeItem.classList.toggle("hidden", !hasMic);
      if (hasMic) {
        const pct = Math.round((s.sample.micAmp / 255) * 100);
        if (el.volBar) el.volBar.style.width = `${pct}%`;
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
          x: cx + ((pt.roll || 0) - rollCenter) * primaryDrawScale,
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

        ctx.lineWidth = 2.8;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 1; i < visibleData.length; i++) {
          const pt1 = visibleData[i - 1];
          const pt2 = visibleData[i];
          const p1 = mapPoint(pt1);
          const p2 = mapPoint(pt2);
          const phase = phaseForIndex(i, releaseIdx, hasRelease, data.length);
          ctx.strokeStyle = phaseColor(phase);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }

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
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(finalPoint.x - 11, finalPoint.y);
        ctx.lineTo(finalPoint.x + 11, finalPoint.y);
        ctx.moveTo(finalPoint.x, finalPoint.y - 11);
        ctx.lineTo(finalPoint.x, finalPoint.y + 11);
        ctx.stroke();

        if (state.reviewMode) {
          ctx.fillStyle = "rgba(230, 244, 239, 0.78)";
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

      // Draw raw mic channel in the background (bottom 30% area)
      drawMicSeries(ctx, data, "micAmp", "rgba(53, 199, 232, 0.45)", "rgba(53, 199, 232, 0.15)", w, h);

      drawSeries(ctx, data, "ax", cssVar("--green"), w, h);
      drawSeries(ctx, data, "ay", cssVar("--cyan"), w, h);
      drawSeries(ctx, data, "az", cssVar("--amber"), w, h);
      drawSequenceMarkers(ctx, data, w, h, state.reviewMode);
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  resize();
  draw();
}

function drawSeries(ctx, data, key, color, w, h) {
  if (data.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const maxIdx = data.length - 1;
  for (let i = 0; i < data.length; i += 1) {
    const x = (i / maxIdx) * w;
    const clamped = Math.max(-2, Math.min(2, data[i][key]));
    const y = h / 2 - (clamped / 4) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawMicSeries(ctx, data, key, borderColor, fillColor, w, h) {
  if (data.length < 2) return;

  let hasData = false;
  for (let i = 0; i < data.length; i++) {
    if (data[i][key] !== undefined && data[i][key] > 0) {
      hasData = true;
      break;
    }
  }
  if (!hasData) return;

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = borderColor;
  ctx.fillStyle = fillColor;

  ctx.beginPath();
  const maxIdx = data.length - 1;
  ctx.moveTo(0, h);

  for (let i = 0; i < data.length; i += 1) {
    const x = (i / maxIdx) * w;
    const val = data[i][key] || 0;
    const valHeight = (val / 255) * (h * 0.3);
    const y = h - valHeight;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < data.length; i += 1) {
    const x = (i / maxIdx) * w;
    const val = data[i][key] || 0;
    const valHeight = (val / 255) * (h * 0.3);
    const y = h - valHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.restore();
}

function drawSequenceMarkers(ctx, data, w, h, reviewMode) {
  if (data.length < 20) return;

  const markerColor = "rgba(230, 244, 239, 0.44)";
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
    ctx.fillStyle = "rgba(230, 244, 239, 0.72)";
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
