// App entry point: build the shared bus + store, wire telemetry and UI, and
// own the transport lifecycle (connect / disconnect / demo).

import { createStore, EventBus } from "./core/store.js";
import { TelemetryStore } from "./telemetry/telemetry.js";
import { createAdapter } from "./device/adapters.js";
import { mountDashboard, mountLog } from "./ui/dashboard.js";

const ELEMENT_IDS = [
  "statusBadge", "statusText", "transportSelect", "baudField", "baudSelect",
  "connectBtn", "disconnectBtn", "demoBtn",
  "protocolValue", "typeValue", "sourceValue", "seqValue", "lossValue",
  "dtValue", "hzValue", "accelMagValue", "gyroMagValue", "frameCountValue",
  "shotCountValue", "axValue", "ayValue", "azValue", "gxValue", "gyValue",
  "gzValue", "sampleTimeValue", "eventLog", "traceCanvas",
];

const el = {};
for (const id of ELEMENT_IDS) el[id] = document.getElementById(id);

const bus = new EventBus();
const store = createStore({
  statusMode: "",
  statusText: "Disconnected",
  connected: false,
  hz: 0,
  lost: 0,
  frameCount: 0,
  accelG: 0,
  gyroMag: 0,
  shotCount: 0,
  sample: null,
});

const telemetry = new TelemetryStore(bus, store);
mountDashboard({ store, telemetry, el });
mountLog(bus, el.eventLog);

let adapter = null;

function transport() {
  return el.transportSelect.value;
}

function syncTransportUi() {
  el.baudField.classList.toggle("hidden", transport() !== "serial");
}

async function disconnect() {
  if (!adapter) return;
  try {
    await adapter.disconnect();
  } catch (_) {}
  adapter = null;
}

async function connect() {
  await disconnect();
  telemetry.reset();
  adapter = createAdapter(transport(), bus, {
    baudRate: Number(el.baudSelect.value),
  });
  try {
    await adapter.connect();
  } catch (error) {
    bus.emit("log", `Connect failed: ${error.message}`);
    adapter = null;
  }
}

async function toggleDemo() {
  if (adapter && adapter.name === "Demo") {
    await disconnect();
    return;
  }
  await disconnect();
  telemetry.reset();
  adapter = createAdapter("demo", bus);
  await adapter.connect();
}

el.transportSelect.addEventListener("change", syncTransportUi);
el.connectBtn.addEventListener("click", connect);
el.disconnectBtn.addEventListener("click", disconnect);
el.demoBtn.addEventListener("click", toggleDemo);

syncTransportUi();
bus.emit("log", "Ready. Pick a transport and connect, or run the demo stream.");
