import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import type { BlobTombstones, AssetTombstones } from '../../sync-support/api.ts';
import type { RuntimeCloudStorageConfig } from '../../sync-providers/api.ts';
import type { AsyncTombstoneWriter } from '../src/tombstone-needs.ts';
import type { SyncGlobalLimiter } from '../src/limiter-needs.ts';
import type { SyncContext } from '../src/dependencies.ts';
import { markBlobDeletedCommand, markAssetDeletedCommand, acquireTombstonePermit } from '../src/tombstone-commands.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
function semaphore(): SyncGlobalLimiter & { busy: boolean } {
  return { busy: false, tryAcquire() {
    if (this.busy) return null;
    this.busy = true; return { release: () => { this.busy = false; } };
  } };
}
async function fixture() {
  const limiter = semaphore();
  const files = new Map<string, Uint8Array>([['data_governance/format.json', Buffer.from('{"format_version":4,"min_client":4}')]]);
  const storage = {
    providerName: () => 'memory', instanceBindingHint: () => 'tombstone-command',
    get: async (key: string) => files.get(key) ?? null, getBounded: async (key: string) => files.get(key) ?? null,
    stat: async (key: string) => files.has(key) ? { key, size: files.get(key)!.length } : null,
    listOutcome: async () => ({ files: [], truncated: false }), list: async () => [],
    supportsConditionalPut: () => false, supportsPrefixRead: () => false,
  };
  const createStorage = vi.fn(async () => { expect(limiter.busy).toBe(true); return storage; });
  let manifest: BlobTombstones = { entries: {}, updated_at: '' };
  const read = vi.fn(async () => structuredClone(manifest));
  const write = vi.fn(async (_s: unknown, _c: unknown, _d: string, next: BlobTombstones | AssetTombstones) => {
    expect(limiter.busy).toBe(true); manifest = structuredClone(next);
  });
  const writer = { DEFAULT_TOMBSTONE_RETENTION_DAYS: 90, pruneTombstones: () => 0,
    downloadBlobTombstonesForDevice: read, downloadAssetTombstonesForDevice: read,
    uploadBlobTombstones: write, uploadAssetTombstones: write,
  } as unknown as AsyncTombstoneWriter;
  const host = await createTestHost({ provide: {
    backup: { hydrateCloudConfig: vi.fn(async () => undefined) }, paths: { deviceId: async () => 'device' },
    syncProvider: { createStorage }, secrets: { backup: createBackupCrypto() },
  } }); hosts.push(host);
  const ctx = host.ctx as SyncContext, config = {} as RuntimeCloudStorageConfig;
  return { limiter, writer, read, write, manifest: () => manifest, createStorage,
    markBlob: (hash: string) => markBlobDeletedCommand(ctx, limiter, writer, config, hash, null, null),
    markAsset: (key: string) => markAssetDeletedCommand(ctx, limiter, writer, config, key, null) };
}
it('concurrent_direct_tombstone_marks_serialize_or_fail_busy', async () => {
  const f = await fixture();
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  f.read.mockImplementationOnce(async () => { const old = structuredClone(f.manifest()); enter(); await gate; return old; });
  const first = f.markBlob('blob-a'); await entered;
  await expect(f.markBlob('blob-b')).rejects.toMatchObject({ value: expect.stringContaining('E_DG_TOMBSTONE_LIMITER_BUSY') });
  expect(f.write).not.toHaveBeenCalled();
  resume(); await first;
  expect(Object.keys(f.manifest().entries)).toEqual(['blob-a']); expect(f.write).toHaveBeenCalledTimes(1);
  await f.markBlob('blob-b'); expect(Object.keys(f.manifest().entries)).toEqual(['blob-a', 'blob-b']);
  expect(f.limiter.busy).toBe(false);
});
it('tombstone_limiter_busy_code_is_stable', () => {
  const limiter = semaphore(); const held = limiter.tryAcquire()!;
  try {
    expect(() => acquireTombstonePermit(limiter)).toThrow('[E_DG_TOMBSTONE_LIMITER_BUSY]');
    expect(() => acquireTombstonePermit(limiter)).toThrow('正在进行中');
  } finally { held.release(); }
});
it.each(['blob', 'asset'] as const)('tombstone_direct_commands_take_permit_and_keep_readback_invariant: %s', async kind => {
  const f = await fixture();
  f.write.mockImplementationOnce(async () => { expect(f.limiter.busy).toBe(true); throw new Error('上传后回读不一致'); });
  await expect(kind === 'blob' ? f.markBlob('blob') : f.markAsset('active/images/a')).rejects.toMatchObject({ value: expect.stringContaining('上传后回读不一致') });
  expect(f.createStorage).toHaveBeenCalledTimes(2); expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.limiter.busy).toBe(false);
});
