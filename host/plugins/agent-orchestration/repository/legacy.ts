import type { StorageService } from '../../../platform/storage/api.ts';
import { localNodeRuntime } from '../src/local-node-runtime.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { SETTING_ENABLED, writeEnabled, type SuperSettingsStore } from '../src/settings.ts';

/** state.rs:980–1023: close SQLite before renaming, including on Windows. */
export function migrateLegacyDb(storage: StorageService, path: string, settings: SuperSettingsStore, warn: (message: string) => void): boolean | null {
  let connection;
  try {
    connection = storage.openFile(path, { profile: 'plain' });
  } catch (error) {
    throw new Error(`打开旧 superagent.db 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  let enabled: boolean | null = null;
  try {
    const row = connection.get<{ value: string }>("SELECT value FROM sa_kv WHERE key = 'enabled'");
    if (row) {
      if (typeof row.value !== 'string') throw new Error('Invalid column type for value');
      enabled = rustTrim(row.value) === 'true';
    }
  } catch (error) {
    warn(`[SuperSession] Legacy sa_kv unreadable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    storage.close(connection);
  }
  if (enabled !== null) {
    let alreadySet = false;
    try { alreadySet = settings.get(SETTING_ENABLED) !== null; }
    catch { alreadySet = false; }
    if (!alreadySet) writeEnabled(settings, enabled);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const from = path + suffix;
    if (!localNodeRuntime().exists(from)) continue;
    let to = `${from}.legacy`;
    if (localNodeRuntime().exists(to)) to += `.${Date.now()}`;
    try { localNodeRuntime().rename(from, to); }
    catch (error) {
      throw new Error(`重命名 ${from} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return enabled;
}
