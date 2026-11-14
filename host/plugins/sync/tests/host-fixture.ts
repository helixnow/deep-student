import { createTestHost as createKernelTestHost } from '../../../kernel/testing.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import syncSupport from '../../sync-support/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';

/** Unused dependencies throw if a test unexpectedly enters their business path. */
function unused(service: string): object {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`Test must provide ${service}.${key}`);
    },
  });
}

export async function createTestHost(options: Parameters<typeof createKernelTestHost>[0] = {}) {
  // Install the real owner in its own fixture context; callers' storage/paths
  // doubles remain untouched, and the batch method receives the caller's tx.
  const ownerHost = await createKernelTestHost();
  const ownerStorage = createStorageService({ baseDir: ownerHost.app.dataDir, dataLocalDir: ownerHost.app.dataDir });
  ownerHost.ctx.provide('storage', ownerStorage);
  ownerHost.ctx.provide('paths', { deviceId: async () => 'sync-test-owner', dataSpaceDeviceId: async () => 'sync-test-owner' });
  await ownerHost.install(vfsRepos);
  ownerHost.ctx.provide('notes', unused('notes'));
  await ownerHost.install(syncSupport);
  const provide: Record<string, unknown> = {
    notes: unused('notes'), mastery: unused('mastery'), backup: unused('backup'),
    syncProvider: unused('syncProvider'), secrets: { backup: createBackupCrypto() },
    syncSupport: ownerHost.ctx.syncSupport,
    nativeCompression: compression,
    vfsRepo: ownerHost.ctx.vfsRepo,
    vfsDatabase: { isInMaintenanceMode: () => false },
    ...options.provide,
  };
  for (const key of Object.keys(provide)) if (provide[key] === undefined) delete provide[key];
  if (options.provide?.syncSupport !== undefined && typeof options.provide.syncSupport === 'object' && options.provide.syncSupport !== null) {
    provide.syncSupport = { ...ownerHost.ctx.syncSupport, ...options.provide.syncSupport };
  }
  try {
    const host = await createKernelTestHost({ ...options, provide });
    const dispose = host.dispose.bind(host);
    host.dispose = async () => { try { await dispose(); } finally { await ownerHost.dispose(); ownerStorage.dispose(); } };
    return host;
  } catch (error) { await ownerHost.dispose(); ownerStorage.dispose(); throw error; }
}
