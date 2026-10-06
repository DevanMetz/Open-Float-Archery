import * as browserDb from "../core/db.js?v=shot-store-176";

const ACTIVE_BOW_KEY = "openfloat_active_bow_id";
const DELETE_MESSAGE = "Are you sure you want to delete this bow profile? This will not delete historical shots associated with it.";

export function mountBowProfiles({ el, bus, syncAdapter, database = browserDb, preferences,
  confirmDelete = () => globalThis.confirm(DELETE_MESSAGE) }) {
  const select = el.bowProfileSelect;
  const fields = {
    model: el.bowModelInput, draw_weight: el.drawWeightInput, arrow_speed: el.bowSpeedInput,
    stabilizer_setup: el.stabilizerSetupInput, notes: el.bowNotesInput,
  };
  let detailVersion = 0, listVersion = 0;
  let busy = false, loading = false, dirty = false, initialized = false, loadedId = "";

  function status(message) { el.bowProfileStatus.textContent = message; }
  function log(message) { bus.emit("log", message); }
  function remember(id) {
    try { (preferences ?? globalThis.localStorage).setItem(ACTIVE_BOW_KEY, id); return true; }
    catch (_) { log("This browser could not remember the active bow profile."); return false; }
  }
  function activeId() {
    try { return (preferences ?? globalThis.localStorage).getItem(ACTIVE_BOW_KEY) || ""; }
    catch (_) { return ""; }
  }
  function controls() {
    const unavailable = !!select.value && loadedId !== select.value;
    for (const input of Object.values(fields)) input.disabled = busy || loading || unavailable;
    el.saveBowProfileBtn.disabled = busy || loading || unavailable;
    el.deleteBowProfileBtn.disabled = busy || loading || !loadedId;
    select.disabled = el.newBowProfileBtn.disabled = busy;
  }
  function fill(profile = {}) {
    for (const [key, input] of Object.entries(fields)) input.value = profile[key] ?? "";
    dirty = false;
  }
  function option(id, label) {
    const node = select.ownerDocument.createElement("option");
    node.value = id;
    node.textContent = label;
    return node;
  }
  function label(profile) {
    return (profile.model || "Unnamed bow") + (profile.draw_weight ? ` (${profile.draw_weight} lbs)` : "");
  }
  async function populate() {
    const version = ++detailVersion;
    const id = select.value;
    loadedId = "";
    loading = !!id;
    fill();
    status(id ? "Loading bow profile..." : "");
    controls();
    if (!id) return true;
    try {
      const profile = await database.get("bow_profiles", id);
      if (version !== detailVersion || id !== select.value) return;
      if (!profile) {
        status("This bow profile is no longer saved. Select another profile or create a new one.");
        return false;
      }
      fill(profile);
      loadedId = id;
      status("");
      return true;
    } catch (error) {
      if (version !== detailVersion || id !== select.value) return;
      status(`Could not load this bow profile: ${error.message}. Select it again to retry.`);
      log(`Error loading bow details: ${error.message}`);
      return false;
    } finally {
      if (version === detailVersion) { loading = false; controls(); }
    }
  }
  async function load() {
    if (busy) return false;
    const version = ++listVersion;
    const detailAtStart = detailVersion;
    const wanted = initialized ? select.value : activeId();
    try {
      const profiles = await database.getAll("bow_profiles");
      // A newer refresh owns the result; ignoring this response is not a read
      // failure and must not produce a warning from the caller.
      if (version !== listVersion) return;
      const current = !dirty && detailAtStart === detailVersion ? wanted : select.value;
      const options = [option("", "Default Bow"), ...profiles.map((profile) => option(profile.id, label(profile)))];
      // Retain a missing selected id while editing; saving must still be an
      // update, so a deleted profile cannot silently become a new one.
      if (current && !profiles.some((profile) => profile.id === current)) {
        options.push(option(current, "Unavailable bow profile"));
      }
      select.replaceChildren(...options);
      select.value = current;
      initialized = true;
      if (!dirty && detailAtStart === detailVersion) return await populate();
      return true;
    } catch (error) {
      if (version !== listVersion) return;
      status(`Could not load bow profiles: ${error.message}. Open Settings again or restore a backup to retry.`);
      log(`Error loading bow profiles: ${error.message}`);
      return false;
    }
  }
  function begin(message) {
    busy = true;
    ++listVersion;
    ++detailVersion;
    status(message);
    controls();
  }
  function sync() {
    Promise.resolve().then(() => syncAdapter?.triggerSync())
      .catch((error) => log(`Bow profile change saved locally; cloud sync failed: ${error.message}`));
  }

  for (const input of Object.values(fields)) input.addEventListener("input", () => { dirty = true; });
  select.addEventListener("change", () => {
    if (busy) return;
    remember(select.value);
    return populate();
  });
  el.newBowProfileBtn.addEventListener("click", () => {
    if (busy) return;
    select.value = "";
    remember("");
    populate();
    fields.model.focus();
    status("Enter the details for a new bow profile.");
  });
  el.saveBowProfileBtn.addEventListener("click", async () => {
    if (busy || loading || (select.value && loadedId !== select.value)) return;
    if (!fields.model.value.trim()) {
      status("Enter a bow name or model before saving.");
      fields.model.focus();
      return;
    }
    if (!Object.values(fields).every((input) => input.reportValidity())) return;
    const create = !select.value;
    const profile = { id: select.value || database.generateUUID(), model: fields.model.value.trim(),
      draw_weight: fields.draw_weight.value === "" ? null : fields.draw_weight.valueAsNumber,
      arrow_speed: fields.arrow_speed.value === "" ? null : fields.arrow_speed.valueAsNumber,
      stabilizer_setup: fields.stabilizer_setup.value.trim(), notes: fields.notes.value.trim(),
    };
    begin("Saving bow profile...");
    try {
      const saved = await database.saveBowProfile(profile, { create });
      let node = [...select.options].find((item) => item.value === saved.id);
      if (!node) { node = option(saved.id, ""); select.appendChild(node); }
      node.textContent = label(saved);
      select.value = loadedId = saved.id;
      fill(saved);
      const remembered = remember(saved.id);
      status(`Saved bow profile: ${saved.model}.${remembered ? "" : " This browser could not remember the active bow."}`);
      log(`Saved bow profile: "${saved.model}"`);
      sync();
    } catch (error) {
      status(`Could not save bow profile: ${error.message}. Your changes are still here; try saving again.`);
      log(`Error saving bow profile: ${error.message}`);
    } finally { busy = false; controls(); }
  });
  el.deleteBowProfileBtn.addEventListener("click", async () => {
    if (busy || loading || !loadedId || loadedId !== select.value || !confirmDelete()) return;
    const id = select.value;
    begin("Deleting bow profile...");
    try {
      const removed = await database.removeBowProfile(id);
      [...select.options].find((item) => item.value === id)?.remove();
      select.value = "";
      populate();
      const remembered = remember("");
      status(`Deleted bow profile${removed ? `: ${removed.model}` : ""}. Historical shots are kept.${remembered ? "" : " This browser could not remember the active bow."}`);
      log(`Deleted bow profile: "${removed?.model || id}"`);
      sync();
    } catch (error) {
      status(`Could not delete bow profile: ${error.message}. The profile is still available; try again.`);
      log(`Error deleting bow profile: ${error.message}`);
    } finally { busy = false; controls(); }
  });
  controls();
  return { load };
}
