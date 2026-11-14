import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import storagePlugin from '../../../platform/storage/index.ts';
import { createLogService } from '../../../platform/log/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import settingsPlugin from '../../../platform/settings/index.ts';
import vfsReposPlugin from '../../../plugins/vfs-repos/index.ts';
import vfsIndexPlugin from '../../../plugins/vfs-index/index.ts';
import vfsPlugin from '../../../plugins/vfs/index.ts';
import notesPlugin from '../../../plugins/notes/index.ts';
import chatPlugin from '../../../plugins/chat/index.ts';
import ankiPlugin from '../../../plugins/anki/index.ts';
import browserPlugin from '../../../plugins/browser/index.ts';
import backupPlugin from '../../../plugins/backup/index.ts';
import type { Logger } from '../../../platform/log/api.ts';
import { join } from 'node:path';

export const quiet: Logger = { target: 'x3', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
export function services(base: string) {
  const paths = createPaths({ dataDir: base, platform: 'linux', env: { HOME: base, XDG_DATA_HOME: join(base, 'local') } });
  const secrets = createSecretsService({ os: paths.os, log: quiet, platform: 'linux', env: {}, keystore: null });
  const storage = createStorageService({ baseDir: base, dataLocalDir: join(base, 'local') });
  return { paths, secrets, storage };
}
export async function openHost(base: string, backup = false) {
  const { paths, secrets } = services(base);
  const log = createLogService({ paths, debug: false, version: 'x3', env: {} });
  try {
    // Install the real F3 provider for storage/featureFlags/noteAssets instead of copying its utilities into a test double.
    const host = await createTestHost({ app: { dataDir: base }, provide: { paths, secrets, log },
      plugins: [[storagePlugin, { dataLocalDir: join(base, 'local') }], settingsPlugin,
        ...(backup ? [backupPlugin] : [vfsReposPlugin, vfsIndexPlugin, vfsPlugin, notesPlugin, chatPlugin, ankiPlugin, browserPlugin])],
    });
    return { paths, secrets, storage: host.ctx.storage, host,
      async dispose() { try { await host.dispose(); } finally { await log.close(); } },
    };
  } catch (error) {
    await log.close();
    throw error;
  }
}
