const FACTORY_RESET_KEYS = [
  "openfloat_locale",
  "openfloat_settings",
  "openfloat_overlay_settings",
  "openfloat_active_bow_id",
  "of-theme-proto",
];

export function resetFactorySettings(storage) {
  for (const key of FACTORY_RESET_KEYS) storage.removeItem(key);
}
