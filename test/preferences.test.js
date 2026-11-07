import test from "node:test";
import assert from "node:assert/strict";
import { resetFactorySettings } from "../app/ui/preferences.js";

test("factory reset clears app preferences but preserves saved data and cloud credentials", () => {
  const values = new Map([
    ["openfloat_locale", "pt-BR"],
    ["openfloat_settings", "{}"],
    ["openfloat_overlay_settings", "{}"],
    ["openfloat_active_bow_id", "bow-1"],
    ["of-theme-proto", "dark"],
    ["openfloat_supabase_url", "https://example.supabase.co"],
    ["openfloat_supabase_key", "key"],
    ["openfloat_shot_count_offset", "4"],
    ["openfloat_counter_synced", "1"],
  ]);
  resetFactorySettings({ removeItem: (key) => values.delete(key) });
  assert.deepEqual([...values.keys()].sort(), [
    "openfloat_counter_synced",
    "openfloat_shot_count_offset",
    "openfloat_supabase_key",
    "openfloat_supabase_url",
  ]);
});

test("factory reset reports storage errors", () => {
  const storage = {
    removeItem(key) {
      if (key === "openfloat_settings") throw new Error("storage unavailable");
    },
  };
  assert.throws(() => resetFactorySettings(storage), /storage unavailable/);
});
