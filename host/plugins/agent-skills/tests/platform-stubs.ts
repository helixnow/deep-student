/**
 * Platform-service stubs for plugin-level tests that only exercise filesystem /
 * requires / zip commands. `dstu.agent-skills` injects `settings` and `storage`
 * (ARCHITECTURE.md §3/§4), but those code paths are not reached by these tests.
 * A command that unexpectedly needs the database fails with a clear error.
 */
import type { SettingRow, SettingsStore } from '../../../platform/settings/api.ts';

export function memorySettings(): SettingsStore {
  const values = new Map<string, string>();
  const rows = (): SettingRow[] => [...values].map(([key, value]) => ({ key, value, updatedAt: '' }));
  return {
    save(key, value) { values.set(key, value); },
    get(key) { return values.get(key) ?? null; },
    delete(key) { return values.delete(key); },
    listByPrefix(prefix) { return rows().filter(row => row.key.startsWith(prefix)); },
    deleteByPrefix(prefix) {
      const doomed = [...values.keys()].filter(key => key.startsWith(prefix));
      for (const key of doomed) values.delete(key);
      return doomed.length;
    },
    async saveSecret(key, value) { values.set(key, value); },
    async getSecret(key) { return values.get(key) ?? null; },
    async deleteSecret(key) { return values.delete(key); },
  };
}

export function unavailableStorage(): { database(name: string): never } {
  return {
    database(name: string): never {
      throw new Error(`test storage stub has no database('${name}')`);
    },
  };
}
