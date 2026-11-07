import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("available locales have matching, complete translation files", async () => {
  const index = await readJson("../locales/index.json");
  const english = await readJson("../locales/en-US.json");
  const portuguese = await readJson("../locales/pt-BR.json");

  assert.deepEqual(index.languages.map(({ code }) => code).sort(), ["en-US", "pt-BR"]);
  for (const language of index.languages) {
    const dictionary = await readJson(`../${language.file.replace(/^locales\//, "locales/")}`);
    assert.equal(dictionary.code, language.code);
    assert.ok(dictionary.strings && typeof dictionary.strings === "object");
    assert.ok(dictionary.placeholders && typeof dictionary.placeholders === "object");
  }

  assert.deepEqual(
    Object.keys(portuguese.strings).sort(),
    Object.keys(english.strings).sort(),
  );
  assert.deepEqual(
    Object.keys(portuguese.placeholders).sort(),
    Object.keys(english.placeholders).sort(),
  );
});
