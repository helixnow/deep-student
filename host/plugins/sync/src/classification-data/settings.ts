/** Only these portable preferences may leave a device; credentials and runtime state never do. */
export const SYNCABLE_SETTING_KEYS = new Set([
  'skill.ui.enable_overrides', 'skill.ui.trust_overrides', 'skill.ui.favorites', 'skill.ui.bundles',
  'shortcuts.custom', 'pdf.settings', 'chat.defaultPermissionPreset', 'theme_custom_color',
  'translation.promptTemplates.v1', 'pomodoro.settings', 'sync.include_skills', 'sync.include_plugins',
]);
export const isSyncableSettingKey = (key: string): boolean => SYNCABLE_SETTING_KEYS.has(key);
