import { afterEach } from 'vitest';
import { createTestHost as createKernelTestHost, type TestHostOptions } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
// boundary-allow cross-plugin-impl: integration installs the real table owner; no repository implementation is copied
import vfsRepos from '../../vfs-repos/index.ts';

/** Real F4 identity resolution, with every legacy search root confined to the fixture. */
export function testPaths(dataDir: string, deviceId = 'l22-sync-device') {
  return createPaths({
    dataDir,
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    env: {
      HOME: dataDir, USERPROFILE: dataDir, APPDATA: dataDir, LOCALAPPDATA: dataDir,
      XDG_DATA_HOME: dataDir, XDG_CONFIG_HOME: dataDir, XDG_CACHE_HOME: dataDir,
      DEVICE_ID: deviceId,
    },
  });
}

/** Install real F3/F4/L11 before the requested sync plugin, not L20's stale test adapters. */
export async function createTestHost(options: TestHostOptions = {}) {
  const host = await createKernelTestHost({ ...options, plugins: [] });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const defaults: Record<string, unknown> = {
    storage, paths: testPaths(host.app.dataDir),
    notes: {}, mastery: {}, backup: {}, syncProvider: {}, syncSupport: {},
    secrets: { backup: createBackupCrypto() }, nativeCompression: compression,
    vfsDatabase: { isInMaintenanceMode: () => false },
  };
  for (const [name, value] of Object.entries(defaults)) {
    if (options.provide?.[name] === undefined) host.ctx.provide(name, value);
  }
  const dispose = host.dispose.bind(host);
  host.dispose = async () => { try { await dispose(); } finally { storage.dispose(); } };
  try {
    await host.install(vfsRepos, ...options.plugins ?? []);
    return host;
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

export type TestDatabase = DatabaseHandle;
const databases: ReturnType<typeof createStorageService>[] = [];
afterEach(() => { for (const storage of databases.splice(0)) storage.dispose(); });

/** Production SQLite adapter: native load errors fail collection/execution, never skip tests. */
export function openTestDatabase(): TestDatabase {
  const storage = createStorageService({ baseDir: '/tmp/opencode', dataLocalDir: '/tmp/opencode' });
  databases.push(storage);
  return storage.openFile(':memory:');
}
