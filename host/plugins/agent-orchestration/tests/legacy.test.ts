import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { migrateLegacyDb } from '../repository/legacy.ts';
import { readEnabled, writeEnabled } from '../src/settings.ts';
import { setLocalNodeRuntime } from '../src/local-node-runtime.ts';
import { nodeLocalNodeRuntime } from '../src/local-node-runtime.node.ts';

beforeAll(() => { setLocalNodeRuntime(nodeLocalNodeRuntime); });
afterAll(() => { setLocalNodeRuntime(null); });

async function fixture() {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const main = storage.database('mistakes');
  main.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const settings = createSettingsStore({ db: () => main, secureStore: () => null, isSensitiveKey: () => false });
  const path = join(host.app.dataDir, 'superagent.db');
  const legacy = storage.openFile(path);
  legacy.exec("CREATE TABLE sa_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sa_kv (key,value) VALUES ('enabled','true')");
  storage.close(legacy);
  return { host, storage, settings, path };
}

describe('state.rs legacy migration', () => {
  it('legacy_db_migration_copies_enabled_and_renames', async () => {
    const { host, storage, settings, path } = await fixture();
    try {
      expect(migrateLegacyDb(storage, path, settings, () => undefined)).toBe(true);
      expect(readEnabled(settings)).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.legacy`)).toBe(true);
    } finally { storage.dispose(); await host.dispose(); }
  });
  it('legacy_db_migration_does_not_override_existing_setting', async () => {
    const { host, storage, settings, path } = await fixture();
    try {
      writeEnabled(settings, false);
      expect(migrateLegacyDb(storage, path, settings, () => undefined)).toBe(true);
      expect(readEnabled(settings)).toBe(false);
      const path2 = join(host.app.dataDir, 'other.db');
      const other = storage.openFile(path2);
      other.exec('CREATE TABLE unrelated (x INTEGER)');
      storage.close(other);
      expect(migrateLegacyDb(storage, path2, settings, () => undefined)).toBeNull();
      expect(existsSync(`${path2}.legacy`)).toBe(true);
    } finally { storage.dispose(); await host.dispose(); }
  });
});
