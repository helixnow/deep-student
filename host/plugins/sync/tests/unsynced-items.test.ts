import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { AsyncTombstoneReader } from '../src/tombstone-needs.ts';
import { createPayloadCodec } from '../api.ts';
import { collectUnsyncedItems } from '../src/unsynced-items.ts';
import { listUnsyncedItemsCommand } from '../src/unsynced-command.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SyncContext } from '../src/dependencies.ts';
import type { RuntimeCloudStorageConfig } from '../../sync-providers/api.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function setup(encrypted = false) {
  const root = mkdtempSync(join(tmpdir(), 'sync-unsynced-report-')); roots.push(root);
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const cloud = {
    get: vi.fn(async (key: string) => { calls.push(key); return files.get(key) ?? null; }),
    listOutcome: vi.fn(async (prefix: string) => ({ files: [...files.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false })),
    put: vi.fn(), delete: vi.fn(), instanceBindingHint: () => 'memory',
  };
  const tombstones: AsyncTombstoneReader = {
    downloadBlobTombstones: vi.fn(async () => { calls.push('blob-tombstones'); return { entries: { gone: { deleted_at: '2026-01-02T00:00:00Z', device_id: 'peer' } }, updated_at: '' }; }),
    downloadAssetTombstones: vi.fn(async () => { calls.push('asset-tombstones'); return { entries: {}, updated_at: '' }; }),
  };
  const codec = await createPayloadCodec(undefined, null);
  const options = { activeDir: root, appDataDir: root, codec, encryptionEnabled: encrypted, tombstones };
  const run = () => collectUnsyncedItems(cloud as unknown as CloudStorage, options);
  const seed = (key: string, value: unknown) => files.set(key, Buffer.from(JSON.stringify(value)));
  return { root, files, cloud, calls, codec, options, seed, run };
}

it('aggregates manifests, filters tombstones before classification and preserves Rust enum ordering', async () => {
  const f = await setup(true);
  f.seed('data_governance/blobs_manifest.json', { entries: {
    gone: { relative_path: 'aa/gone', size: 1, updated_at: '2026-01-01T00:00:00Z' },
    z: { relative_path: 'aa/z', size: 2, cipher_sha256: 'cipher' },
    a: { relative_path: 'aa/a', size: 3 },
    bad: { relative_path: '../outside', size: 4 },
  } });
  f.seed('data_governance/file_manifests/assets/peer/old.json', { entries: {
    'active/images/b': { sha256: 'b', size: 5, cipher_sha256: 'cipher' },
  } });
  try {
    const result = await f.run();
    expect(result.items.map(item => [item.kind, item.key])).toEqual([
      ['downloadPending', 'active/images/b'], ['downloadPending', 'z'], ['legacyPlaintext', 'a'], ['invalidKey', 'bad'],
    ]);
    expect(result).toMatchObject({ itemsTruncated: false, totalUnsynced: 4, blobEntriesTotal: 3, assetEntriesTotal: 1, encryptionEnabled: true });
    expect(result.items[0]).not.toHaveProperty('counterpart');
    expect(result.items[0]!.size).toBe(5n);
    expect(result.generatedAt).toMatch(/Z$/u);
    expect(f.calls.indexOf('blob-tombstones')).toBeLessThan(f.calls.indexOf('data_governance/assets_manifest.json'));
    expect(f.cloud.put).not.toHaveBeenCalled(); expect(f.cloud.delete).not.toHaveBeenCalled();
  } finally { f.codec.dispose(); }
});

it('counts the full report before the 500 item cap and preserves u64 sizes', async () => {
  const f = await setup();
  const entries = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [String(i).padStart(3, '0'), { relative_path: `aa/${i}`, size: 1 }]));
  f.seed('data_governance/blobs_manifest.json', { entries });
  f.files.set('data_governance/file_manifests/assets/u64.json', Buffer.from('{"entries":{"active/images/a":{"sha256":"x","size":18446744073709551615}}}'));
  try {
    const report = await f.run();
    expect(report).toMatchObject({ totalUnsynced: 502, itemsTruncated: true, blobEntriesTotal: 501, assetEntriesTotal: 1 });
    expect(report.items).toHaveLength(500);
    f.seed('data_governance/blobs_manifest.json', { entries: {} });
    expect((await f.run()).items[0]!.size).toBe(18446744073709551615n);
  } finally { f.codec.dispose(); }
});

it('rejects truncated listings and vanished objects rather than returning a partial report', async () => {
  const f = await setup();
  try {
    f.cloud.listOutcome.mockResolvedValueOnce({ files: [], truncated: true });
    await expect(f.run()).rejects.toMatchObject({ value: ' blob 清单列表被截断，无法给出可信的未同步清单' });
    f.cloud.listOutcome.mockResolvedValueOnce({ files: [{ key: 'missing.json' }], truncated: false });
    await expect(f.run()).rejects.toMatchObject({ value: '已列举的 blob 清单消失: missing.json' });
  } finally { f.codec.dispose(); }
});

it('reports legacy decode and structure errors with their distinct command contexts', async () => {
  const f = await setup();
  try {
    f.seed('data_governance/blobs_manifest.json', { entries: { bad: { size: 1 } } });
    await expect(f.run()).rejects.toMatchObject({ value: expect.stringContaining('旧 blob 清单损坏:') });
    f.options.codec = { ...f.codec, decode: async () => { throw new Error('wrong password'); } };
    await expect(f.run()).rejects.toMatchObject({ value: '旧 blob 清单无法解密（请检查加密密码）: wrong password' });
  } finally { f.codec.dispose(); }
});

it('unsynced command hydrates and resolves identity before creating storage, retaining command error context', async () => {
  const calls: string[] = [];
  const host = await createTestHost({ provide: {
    vfsDatabase: { isInMaintenanceMode: () => false }, storage: { locations: { activeDir: '/unused' } },
    backup: { hydrateCloudConfig: async () => { calls.push('hydrate'); } }, paths: { deviceId: async () => { calls.push('identity'); return 'reader'; } },
    secrets: { backup: undefined }, syncProvider: { createStorage: async () => { calls.push('storage'); throw new Error('offline'); } },
  } });
  try {
    await expect(listUnsyncedItemsCommand(host.ctx as SyncContext, {} as AsyncTombstoneReader, {} as RuntimeCloudStorageConfig))
      .rejects.toMatchObject({ value: '创建云存储失败: offline' });
    expect(calls).toEqual(['hydrate', 'identity', 'storage']);
  } finally { await host.dispose(); }
});

it('D3: exact internal u64 size becomes a JSON number only at the command boundary', async () => {
  const f = await setup();
  f.files.set('data_governance/blobs_manifest.json', Buffer.from('{"entries":{"large":{"relative_path":"aa/large","size":18446744073709551615}}}'));
  const host = await createTestHost({ provide: {
    vfsDatabase: { isInMaintenanceMode: () => false }, storage: { locations: { activeDir: f.root } },
    backup: { hydrateCloudConfig: async () => undefined }, paths: { deviceId: async () => 'reader' },
    secrets: { backup: undefined }, syncProvider: { createStorage: async () => f.cloud },
  } });
  try {
    expect((await f.run()).items[0]!.size).toBe(18446744073709551615n);
    const report = await listUnsyncedItemsCommand(host.ctx as SyncContext, f.options.tombstones, {} as RuntimeCloudStorageConfig);
    expect(typeof report.items[0]!.size).toBe('number');
    expect(report.items[0]!.size).toBe(JSON.parse('18446744073709551615'));
  } finally { f.codec.dispose(); await host.dispose(); }
});
