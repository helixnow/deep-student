import './local-runtime-fixture.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { AssetTombstones, SyncStateStore } from '../../sync-support/api.ts';
import type { AsyncAssetTombstones, AsyncTombstoneWriter } from '../src/tombstone-needs.ts';
import { createPayloadCodec } from '../src/payload.ts';
import { syncAssetDirectories } from '../src/asset-sync.ts';
import { syncAssetsWithTombstones } from '../src/file-tombstone-sync.ts';
import { downloadAssetsManifest } from '../src/asset-manifest.ts';
import { markAssetDeleted, markBlobDeletions, markWorkspaceDeletions } from '../src/file-deletions.ts';

const roots: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), 'sync-delete-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function assetTombstoneScenario(pathModifiedAfter: AsyncAssetTombstones['pathModifiedAfter'],
  check: (result: { outcome: Awaited<ReturnType<typeof syncAssetsWithTombstones>>; target: string; rel: string; object: string;
    files: Map<string, Uint8Array>; setWatermark: ReturnType<typeof vi.fn> }) => void) {
  const files = new Map<string, Uint8Array>(); let deleted: AssetTombstones = { entries: {}, updated_at: '' };
  const cloud = {
    providerName: () => 'memory', instanceBindingHint: () => 'deletion-tests',
    get: async (key: string) => files.get(key) ?? null,
    put: async (key: string, bytes: Uint8Array) => { files.set(key, bytes.slice()); },
    delete: vi.fn(async (key: string) => { files.delete(key); }),
    listOutcome: async (prefix: string) => ({ files: [...files].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.length })), truncated: false }),
    stat: async (key: string) => files.has(key) ? { key, size: files.get(key)!.length } : null,
    putFile: async (key: string, path: string) => { const bytes = readFileSync(path); files.set(key, bytes); return hash(bytes); },
    supportsResumableDownload: () => false,
    getFile: async (key: string, path: string, expected: string) => {
      const bytes = files.get(key)!; if (hash(bytes) !== expected) throw new Error('checksum mismatch');
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return hash(bytes);
    },
  } as unknown as CloudStorage;
  const reader: AsyncAssetTombstones = {
    downloadAssetTombstones: async () => structuredClone(deleted),
    downloadAssetTombstonesAfter: async () => [structuredClone(deleted), [{ source_device_id: 'source', last_applied_offset: 1n }]],
    validateTombstoneTimestamp: vi.fn(), pathModifiedAfter,
  };
  const writer = {
    DEFAULT_TOMBSTONE_RETENTION_DAYS: 90,
    pruneTombstones: () => 0,
    downloadAssetTombstonesForDevice: async () => structuredClone(deleted),
    uploadAssetTombstones: async (_storage: unknown, _codec: unknown, _device: string, manifest: AssetTombstones) => { deleted = structuredClone(manifest); },
  } as unknown as AsyncTombstoneWriter;
  const setWatermark = vi.fn();
  const state = { bindInstance: vi.fn(), getTombstoneWatermark: () => 0n, setTombstoneWatermark: setWatermark } as unknown as SyncStateStore;
  const codec = await createPayloadCodec(undefined, null);
  const options = { deviceId: 'source', codec, tombstones: reader, isCancelled: () => false, openState: () => state,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  const source = directory(), target = directory(), rel = 'images/contract/diagram.bin', key = 'active/images/contract/diagram.bin';
  const bytes = Buffer.from(Array.from({ length: 12 * 1024 + 19 }, (_, i) => (i * 31 + Math.floor(i / 7)) % 251));
  mkdirSync(dirname(join(source, rel)), { recursive: true }); writeFileSync(join(source, rel), bytes);
  try {
    expect((await syncAssetDirectories(cloud, source, source, 'Bidirectional', options)).uploaded).toBe(1);
    const object = (await downloadAssetsManifest(cloud, options)).entries.get(key)!.object_key!;
    expect((await syncAssetDirectories(cloud, target, target, 'Bidirectional', options)).downloaded).toBe(1);
    rmSync(join(source, rel));
    await markAssetDeleted(cloud, key, BigInt(bytes.length), { ...options, tombstones: writer });
    const outcome = await syncAssetsWithTombstones(cloud, target, target, 'Bidirectional', options);
    check({ outcome, target, rel, object, files, setWatermark });
  } finally { codec.dispose(); }
}

it('asset_tombstone_reclaims_object_without_conflict_resurrection', async () => {
  await assetTombstoneScenario(() => false, ({ outcome, target, rel, object, files, setWatermark }) => {
    expect(outcome.upload_failures).toEqual([]); expect(outcome.download_failures).toEqual([]);
    expect(existsSync(join(target, rel))).toBe(false); expect(outcome.uploaded).toBe(0);
    expect(files.has(object)).toBe(false);
    expect(setWatermark).toHaveBeenCalledWith(expect.any(String), 'source', 'assets', 1n);
  });
});

it('asset tombstone awaits an asynchronous pathModifiedAfter: a newer local file skips the tombstone', async () => {
  const asked: string[] = [];
  await assetTombstoneScenario(async path => { asked.push(path); return true; }, ({ outcome, target, rel, object, files }) => {
    expect(asked).toEqual([join(target, rel)]);
    expect(outcome.upload_failures).toEqual([]); expect(outcome.download_failures).toEqual([]);
    expect(existsSync(join(target, rel))).toBe(true);
    expect(files.has(object)).toBe(true);
  });
});

it('empty deletion batches perform no format, state or cloud access', async () => {
  const codec = await createPayloadCodec(undefined, null);
  const storage = new Proxy({}, { get() { throw new Error('unexpected cloud access'); } }) as CloudStorage;
  const options = { deviceId: 'a', codec, tombstones: {} as AsyncTombstoneWriter };
  try {
    await markBlobDeletions(storage, [], options);
    await markWorkspaceDeletions(storage, [], options);
  } finally { codec.dispose(); }
});
