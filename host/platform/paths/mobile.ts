/** OPFS paths match files/opfs.ts mobileRoots. No host OS paths are probed. */
import { definePlugin } from '../../kernel/core.ts';
import { posix } from '../util/path.ts';
import type { FilesService } from '../files/api.ts';
import type { PathsService } from './api.ts';
import { normalizeDeviceId, deviceIdShortHash } from './device-id-core.ts';

export function createMobilePaths(dataDir: string, files: Pick<FilesService, 'exists' | 'readText' | 'mkdir' | 'writeAtomic'>): PathsService {
  const base = posix.normalize(dataDir);
  const j = (...parts: string[]) => posix.join(base, ...parts);
  const log = j('logs');
  const primary = j('.device_id');
  let pending: Promise<string> | undefined;
  const generate = () => `device-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  async function persist(id: string) {
    if (!id.trim()) throw new Error('new device id must not be empty');
    await files.mkdir(base, { recursive: true });
    await files.writeAtomic(primary, id);
    pending = Promise.resolve(id);
  }
  const deviceId = () => pending ??= (async () => {
    if (await files.exists(primary)) {
      const value = (await files.readText(primary)).trim();
      if (value) return normalizeDeviceId(value);
    }
    const id = generate();
    await persist(id);
    return id;
  })().catch(error => { pending = undefined; throw error; });
  return {
    identifier: posix.basename(base), appDataDir: base, appLocalDataDir: j('local'),
    appConfigDir: j('config'), appCacheDir: j('cache'), appLogDir: log,
    os: { home: base, data: base, dataLocal: j('local'), config: j('config'), cache: j('cache'), temp: j('tmp'), download: null },
    slotsDir: j('slots'), slotStateFile: j('slots', 'state.json'), slotDir: slot => j('slots', slot),
    recoveryBackupsDir: j('recovery', 'backups'), baseSecureDir: j('.secure'),
    deviceIdFile: primary, legacyDeviceIdFiles: [], baseJoin: (...parts) => j(...parts),
    mainLogFile: posix.join(log, 'deep-student.log'), crashLogDir: posix.join(log, 'crash'),
    debugLogsDir: posix.join(log, 'debug-logs'), structuredLogDir: kind => posix.join(log, kind),
    debugLogRoots: [log, base], fallbackSecureDir: j('.secure'), syncStateDatabase: j('local', 'sync_state.db'),
    slot: {
      mainDatabase: dir => posix.join(dir, 'mistakes.db'), vfsDatabase: dir => posix.join(dir, 'databases/vfs.db'),
      auditDatabase: dir => posix.join(dir, 'databases/audit.db'), chatV2Database: dir => posix.join(dir, 'chat_v2.db'),
      llmUsageDatabase: dir => posix.join(dir, 'llm_usage.db'), browserDatabase: dir => posix.join(dir, 'browser.db'),
      secureDir: dir => posix.join(dir, '.secure'), masterKeyFile: dir => posix.join(dir, '.master_key'),
      join: (dir, ...parts) => posix.join(dir, ...parts),
    },
    deviceId, dataSpaceDeviceId: deviceId, normalizeDeviceId, deviceIdShortHash,
    generateDeviceIdAfterRestore: generate, persistDeviceIdAfterRestore: persist,
    async rotateDeviceIdAfterRestore() { const old = await deviceId(); const next = generate(); await persist(next); return [old, next]; },
  };
}

export default definePlugin({
  meta: { id: 'dstu.platform.paths', provides: ['paths'], platforms: ['mobile'] },
  inject: ['files'],
  apply(ctx) { ctx.reflect.provide('paths', createMobilePaths(ctx.app.dataDir, ctx.files)); },
});
