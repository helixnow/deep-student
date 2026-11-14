// Same load/save as the F3 storage plugin's `featureFlags` service (host/platform/storage/index.ts:78-84).
import {
  FeatureFlagManager, type FeatureFlagSettingsStore,
} from '../../../../platform/storage/feature-flags.ts';

export interface KeyValueSettings {
  get(key: string): string | null;
  save(key: string, value: string): void;
}

export const f3FeatureFlags = {
  load: (store: FeatureFlagSettingsStore, appVersion: string, options: { debug?: boolean; userId?: string | null } = {}) => {
    const manager = new FeatureFlagManager(appVersion, options.debug ?? false);
    if (options.userId != null) manager.withUserId(options.userId);
    return manager.loadFromDatabase(store);
  },
  save: (manager: FeatureFlagManager, store: FeatureFlagSettingsStore) => manager.saveToDatabase(store),
};

export function settingsStore(settings: KeyValueSettings): FeatureFlagSettingsStore {
  return { getSetting: key => settings.get(key), saveSetting: (key, value) => settings.save(key, value) };
}

export function loadF3Flags(settings: KeyValueSettings, debug = true): FeatureFlagManager {
  return f3FeatureFlags.load(settingsStore(settings), '0.11.0', { debug });
}
