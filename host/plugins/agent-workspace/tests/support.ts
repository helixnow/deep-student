import type { SettingRow, SettingsService, SettingsStore } from '../../../platform/settings/api.ts';

/** 测试替身：内存 settings（F4 服务不属于本 lane）。 */
export function memorySettings(initial?: Record<string, string>): SettingsService {
  const values = new Map<string, string>(Object.entries(initial ?? {}));
  const store: SettingsStore = {
    get: key => values.get(key) ?? null,
    save: (key, value) => { values.set(key, value); },
    delete: key => values.delete(key),
    listByPrefix: prefix => [...values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]): SettingRow => ({ key, value, updatedAt: '1970-01-01T00:00:00+00:00' })),
    deleteByPrefix: prefix => {
      let deleted = 0;
      for (const key of [...values.keys()]) if (key.startsWith(prefix)) { values.delete(key); deleted++; }
      return deleted;
    },
    saveSecret: async (key, value) => { values.set(key, value); },
    getSecret: async key => values.get(key) ?? null,
    deleteSecret: async key => values.delete(key),
  };
  return { ...store, bind: () => store };
}
