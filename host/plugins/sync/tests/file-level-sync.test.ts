import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createPayloadCodec } from '../src/payload.ts';
import { runFileLevelSync, FileLevelProgress, type FileLevelSyncOptions } from '../src/file-level-sync.ts';
import { OptionalEmitter, SyncProgressEmitter } from '../src/emitter.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { SyncStateStore } from '../../sync-support/api.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'sync-file-level-')); roots.push(root);
  const files = new Map<string, Uint8Array>();
  const cloud = { providerName: () => 'memory', instanceBindingHint: () => 'file-level',
    get: async (key: string) => files.get(key) ?? null,
    put: async (key: string, bytes: Uint8Array) => { files.set(key, bytes); },
    listOutcome: async () => ({ files: [], truncated: false }),
  } as unknown as CloudStorage;
  const empty = () => ({ entries: {}, updated_at: '' });
  const localStorage = createStorageService({ baseDir: root, dataLocalDir: root });
  const options: FileLevelSyncOptions = {
    deviceId: 'a', codec: await createPayloadCodec(undefined, null),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    localStorage,
    openState: () => ({ bindInstance: vi.fn(), getTombstoneWatermark: () => 0n, setTombstoneWatermark: vi.fn() }) as unknown as SyncStateStore,
    isCancelled: () => false,
    tombstones: {
      downloadBlobTombstones: async () => empty(), downloadAssetTombstones: async () => empty(), downloadWorkspaceTombstones: async () => empty(),
      downloadBlobTombstonesAfter: async () => [empty(), []], downloadAssetTombstonesAfter: async () => [empty(), []], downloadWorkspaceTombstonesAfter: async () => [empty(), []],
      downloadBlobTombstonesForDevice: async () => empty(), downloadAssetTombstonesForDevice: async () => empty(), downloadWorkspaceTombstonesForDevice: async () => empty(),
      uploadBlobTombstones: vi.fn(), uploadAssetTombstones: vi.fn(), uploadWorkspaceTombstones: vi.fn(),
      DEFAULT_TOMBSTONE_RETENTION_DAYS: 90, pruneTombstones: () => 0, applyBlobTombstones: async () => [],
      validateTombstoneTimestamp: vi.fn(), pathModifiedAfter: () => false,
    },
  };
  return { root, cloud, options, localStorage };
}
it('a missing workspace barrier reports failure while blob and asset stages continue', async () => {
  const f = await setup(); const events = { emit: vi.fn() };
  const progress = new FileLevelProgress(new OptionalEmitter(new SyncProgressEmitter(events, vi.fn())), 20, 80);
  try {
    expect(await runFileLevelSync(f.cloud, f.root, 'Download', f.options, null, progress)).toEqual({ failed: true,
      warning: '工作区数据库同步已跳过: WorkspaceCoordinator 尚未初始化，无法取得一致性屏障' });
    expect(events.emit.mock.calls.map(call => call[1].current_item)).toEqual([
      '文件级同步：工作区数据库', '文件级同步：VFS blob', '文件级同步：资产目录', '文件级同步完成',
    ]);
  } finally { f.options.codec.dispose(); f.localStorage.dispose(); }
});
it('workspace barrier exit retries three times and reports a persistent failure without overwriting the sync result', async () => {
  const f = await setup();
  const coordinator = { enterMaintenanceMode: vi.fn(async () => undefined), exitMaintenanceMode: vi.fn(() => { throw new Error('still read-only'); }) };
  try {
    expect(await runFileLevelSync(f.cloud, f.root, 'Download', f.options, coordinator)).toEqual({ failed: false, warning: null });
    expect(coordinator.enterMaintenanceMode).toHaveBeenCalledTimes(1); expect(coordinator.exitMaintenanceMode).toHaveBeenCalledTimes(3);
    expect(f.options.logger.error).toHaveBeenCalledWith('[data_governance] 退出工作区维护模式连续失败，工作区保持只读以避免写入内存池丢失: still read-only');
  } finally { f.options.codec.dispose(); f.localStorage.dispose(); }
});
