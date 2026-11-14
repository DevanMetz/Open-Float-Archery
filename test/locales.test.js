import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_LOCALE,
  getSavedLocale,
  saveLocalePreference,
  translateMessage,
} from "../app/ui/localization.js";

test("English and Brazilian Portuguese locale files define matching messages", async () => {
  const [english, portuguese] = await Promise.all([
    readFile(new URL("../locales/en-US.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../locales/pt-BR.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(Object.keys(portuguese).sort(), Object.keys(english).sort());
  assert.equal(english.language, "Language");
  assert.equal(portuguese.language, "Idioma");
  assert.equal(portuguese.obsOverlaySettings, "Sobreposição do OBS Studio");
});

test("Brazilian Portuguese locale points to existing translated guide pages", async () => {
  const portuguese = JSON.parse(await readFile(
    new URL("../locales/pt-BR.json", import.meta.url), "utf8",
  ));
  const index = JSON.parse(await readFile(
    new URL("../docs/index.json", import.meta.url), "utf8",
  ));
  const pageIds = [];
  function collectPages(nodes) {
    for (const node of nodes) {
      if (node.type === "folder") collectPages(node.children);
      else pageIds.push(node.id);
    }
  }
  collectPages(index.tree);
  assert.deepEqual(Object.keys(portuguese._guidePages).sort(), [
    "feature-status",
    "quick-start",
    "reference/ble-commands",
    "translation-guide",
  ]);
  assert.deepEqual(Object.keys(portuguese._guidePages).sort(), pageIds.sort());
  for (const path of Object.values(portuguese._guidePages)) {
    const markdown = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(markdown, /^# .+/);
  }
});

test("the selected locale persists in browser storage and invalid values use the default", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(getSavedLocale(storage), DEFAULT_LOCALE);
  saveLocalePreference("pt-BR", storage);
  assert.equal(values.get("openfloat_locale"), "pt-BR");
  assert.equal(getSavedLocale(storage), "pt-BR");
  values.set("openfloat_locale", "unsupported");
  assert.equal(getSavedLocale(storage), DEFAULT_LOCALE);
  assert.throws(() => saveLocalePreference("unsupported", storage), RangeError);
});

test("guided setup messages and dynamic values are translated", async () => {
  const portuguese = JSON.parse(await readFile(
    new URL("../locales/pt-BR.json", import.meta.url), "utf8",
  ));
  assert.equal(
    translateMessage(
      "Step 1 of 2 — Hold the bow upright and level, as if aiming with no cant. Keep it still, then press Capture.",
      portuguese,
    ),
    "Etapa 1 de 2 — Segure o arco reto e nivelado, como se estivesse mirando sem inclinação. Mantenha-o imóvel e toque em Capturar.",
  );
  assert.equal(
    translateMessage(
      "Unexpected acceleration (1.23 g). Hold the bow still — only gravity should be acting on it — and retry.",
      portuguese,
    ),
    "Aceleração inesperada (1.23 g). Mantenha o arco imóvel — somente a gravidade deve atuar nele — e tente novamente.",
  );
  assert.equal(
    translateMessage(
      'Detected "Default" (Bow X IMU X, Bow Y IMU Y, Bow Z IMU Z). Press Apply to use it.',
      portuguese,
    ),
    'Montagem detectada: "Default" (Arco X IMU X, Arco Y IMU Y, Arco Z IMU Z). Toque em Aplicar para usar.',
  );
  assert.equal(
    translateMessage("Exported 1 shot, 3 traces, 2 bow profiles.", portuguese),
    "Exportados: 1 disparo, 3 traçados, 2 perfis de arco.",
  );
  assert.equal(
    translateMessage(
      "Imported 2 shots, 3 traces, 4 bow profiles (2 queued for cloud sync).",
      portuguese,
    ),
    "Importados: 2 disparos, 3 traçados, 4 perfis de arco (2 aguardando sincronização com a nuvem).",
  );
  assert.equal(
    translateMessage(
      "This browser does not provide Web Bluetooth for sensor connections. Use Chrome on Android, or Chrome/Edge on Windows or macOS. Demo, Saved Shots, and local backup/restore still work.",
      portuguese,
    ),
    "Este navegador não oferece Web Bluetooth para conectar sensores. Use o Chrome no Android ou Chrome/Edge no Windows ou macOS. Demo, Disparos salvos e backup/restauração local continuam disponíveis.",
  );
});

test("warning-prefixed alignment guidance is translated without losing its icon", async () => {
  const portuguese = JSON.parse(await readFile(
    new URL("../locales/pt-BR.json", import.meta.url), "utf8",
  ));
  assert.equal(
    translateMessage(
      "⚠ Picking a position here only previews the mapping. The sensor itself keeps reporting with the mapping compiled into its firmware — rebuild and flash the firmware with the matching mount mapping to change the data.",
      portuguese,
    ),
    "⚠ Esta opção apenas mostra uma prévia do mapeamento. O sensor continua usando o mapeamento gravado no firmware; para alterar os dados, recompile e grave o firmware com o mapeamento correspondente.",
  );
});
