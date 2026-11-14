import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { deviceIdShortHash } from '../../sync-providers/api.ts';
import sync from '../index.ts';
import { createPayloadCodec, type SyncService, type SyncCursorStore } from '../api.ts';
import { FORMAT_KEY, parseFormatDescriptor, descriptorToJson } from '../src/remote-format.ts';
import { INSTANCE_KEY } from '../src/change-availability.ts';
import { deviceManifestKey, readDeviceManifests } from '../src/remote-manifest.ts';
import { createManifest, detectConflicts } from '../src/merge.ts';
import { schemaMismatchError } from '../src/manifest-upload.ts';
import { parseChangeKey, parseVersionFromKey, listAllChangeKeys, changeSequenceInventory, pathDeviceAliases, missingSequenceIsProven } from '../src/change-keys.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import { pendingChangesFromEntries } from '../src/change-log.ts';
import { executeDownloadWithProgress, executeBidirectionalWithProgress, type SyncPassOptions } from '../src/record-progress.ts';
import { OptionalEmitter } from '../src/emitter.ts';

class Cloud {
  files = new Map<string, Uint8Array>();
  writes: string[] = [];
  reads: string[] = [];
  afterList?: (prefix: string) => void;
  afterPut?: (key: string) => void;
  truncatedPrefix: string | null = null;
  seed(key: string, value: unknown) { this.files.set(key, Buffer.from(JSON.stringify(value))); }
  providerName() { return 'memory'; }
  instanceBindingHint() { return 'memory:remote-protocol'; }
  async get(key: string) { this.reads.push(key); return this.files.get(key) ?? null; }
  async put(key: string, data: Uint8Array) {
    this.writes.push(key);
    this.files.set(key, data.slice());
    this.afterPut?.(key);
  }
  async listOutcome(prefix: string) {
    const files = [...this.files].filter(([key]) => key.startsWith(prefix))
      .map(([key, data]) => ({ key, size: data.length, lastModified: '' }));
    this.afterList?.(prefix);
    return { files, truncated: this.truncatedPrefix === prefix };
  }
  storage(): CloudStorage { return this as unknown as CloudStorage; }
}

let host: Awaited<ReturnType<typeof createTestHost>>;
let service: SyncService;
const codec = await createPayloadCodec(undefined, null);
const options = { deviceId: 'reader', codec };
const instanceCursors = new Map<string, Map<string, bigint>>();
beforeAll(async () => {
  host = await createTestHost({ plugins: [sync], provide: {
    storage: {}, paths: { deviceId: async () => 'reader' },
    syncSupport: { state: {
      bindInstance: () => undefined,
      cursors: (instance: string) => instanceCursors.get(instance) ?? new Map(),
      getCursor: (instance: string, device: string) => instanceCursors.get(instance)?.get(device) ?? 0n,
      isLegacyProcessed: () => false,
      setCursor: () => { throw new Error('download must not acknowledge unapplied records'); },
    } },
  } });
  service = host.ctx.sync;
});
afterAll(async () => { codec.dispose(); await host.dispose(); });

function peer(cloud: Cloud, id: string, version: number, seq = 0) {
  const manifest = { ...createManifest(id, {}), format_version: version, published_max_seq: seq };
  cloud.seed(deviceManifestKey(id), manifest);
  return manifest;
}
function shard(cloud: Cloud, seq: number, v4 = false) {
  const prefix = v4 ? 'data_governance/v4/shards' : 'data_governance/changes';
  const key = `${prefix}/${deviceIdShortHash('writer')}/${String(seq).padStart(12, '0')}-1792755307-operation-id.json.zst`;
  cloud.files.set(key, new Uint8Array());
  return key;
}
function expiredFormat(cloud: Cloud) {
  cloud.seed(FORMAT_KEY, { format_version: 4, min_client: 3, compatibility_lease: {
    expires_at: '2000-01-01T00:00:00Z',
  } });
}

it('unsafe_snapshot_bootstrap_is_disabled', async () => {
  const cloud = new Cloud();
  cloud.seed(FORMAT_KEY, { format_version: 4, min_client: 4 });
  cloud.seed(INSTANCE_KEY, { instance_id: 'snapshot-must-not-hide-gap' });
  peer(cloud, 'writer', 4, 3);
  shard(cloud, 1); shard(cloud, 3);
  const snapshot = 'data_governance/snapshots/vfs/old.json.zst';
  cloud.seed(snapshot, { covered_cursors: { writer: 3 }, rows: {} });
  await expect(service.executeDownload(cloud.storage(), createManifest('reader', {}), 'KeepLatest', options))
    .rejects.toThrow('缺少序号 2');
  expect(cloud.reads).not.toContain(snapshot);
  expect(cloud.writes).toEqual([]);
  expect(instanceCursors.has('snapshot-must-not-hide-gap')).toBe(false);
});

it('regression_c8_upload_path_verifies_size: provider short reads propagate without acknowledgement', async () => {
  const cloud = new Cloud(); cloud.seed(FORMAT_KEY, { format_version: 4, min_client: 4 });
  cloud.seed(INSTANCE_KEY, { instance_id: 'short-read' }); peer(cloud, 'writer', 4, 1);
  const key = shard(cloud, 1); const get = cloud.get.bind(cloud);
  cloud.get = async candidate => { if (candidate === key) throw new Error('截断体不得解码、不得推进水位'); return get(candidate); };
  await expect(service.downloadChanges(cloud.storage(), 0n, null, options)).rejects.toThrow('截断体不得解码、不得推进水位');
  expect(instanceCursors.has('short-read')).toBe(false); expect(cloud.writes).toEqual([]);
});

it.each(['download', 'bidirectional'] as const)('progress_v2_download_paths_enforce_prune_gap_check: %s', async direction => {
  const cloud = new Cloud();
  cloud.seed(FORMAT_KEY, { format_version: 4, min_client: 4 });
  cloud.seed(INSTANCE_KEY, { instance_id: 'progress-gap' });
  peer(cloud, 'writer', 4, 2); shard(cloud, 2);
  const apply = vi.fn(() => { throw new Error('must not apply through a sequence gap'); });
  const pass = { ...options, compression, openState: () => host.ctx.syncSupport.state, application: { apply },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as SyncPassOptions;
  const local = createManifest('reader', {}), emitter = new OptionalEmitter(null);
  const result = direction === 'download'
    ? executeDownloadWithProgress(cloud.storage(), local, 'KeepLatest', pass, null, emitter)
    : executeBidirectionalWithProgress(cloud.storage(), [], pendingChangesFromEntries([]), local, 'KeepLatest', pass, null, emitter);
  await expect(result).rejects.toThrow('缺少序号 1');
  expect(apply).not.toHaveBeenCalled(); expect(cloud.writes).toEqual([]);
});

it('bidirectional engine only downloads and returns pending IDs without publishing or acknowledging', async () => {
  const cloud = new Cloud();
  cloud.seed(FORMAT_KEY, { format_version: 4, min_client: 4 });
  cloud.seed(INSTANCE_KEY, { instance_id: 'bidirectional-engine' });
  const pending = pendingChangesFromEntries([{ id: 42, table_name: 'notes', record_id: 'n1', operation: 'Update',
    changed_at: '2026-01-01T00:00:00Z', sync_version: 0 }]);
  const [result, ids, downloaded] = await service.executeBidirectional(cloud.storage(), pending, createManifest('reader', {}), 'KeepLatest', options);
  expect(result).toMatchObject({ direction: 'Bidirectional', success: true, changes_uploaded: 1, changes_downloaded: 0, conflicts_detected: 0, error_message: null });
  expect(ids).toEqual([42]); expect(downloaded.changes).toEqual([]); expect(cloud.writes).toEqual([]);
});

describe('remote format via sync', () => {
  it('v3_format_descriptor_defaults_into_v4_compatible_skeleton', async () => {
    const cloud = new Cloud();
    cloud.seed(FORMAT_KEY, { format_version: 3 });
    const descriptor = await service.validateRemoteFormat(cloud.storage(), false, options);
    expect(descriptor.format_version).toBe(3);
    expect(descriptor.min_reader_version).toBe(3);
    expect(descriptor.features).toEqual([]);
    const serialized = descriptorToJson(descriptor) as Record<string, unknown>;
    expect(serialized.min_client).toBe(3);
    expect(serialized).not.toHaveProperty('min_reader_version');
    const upgraded = await service.validateRemoteFormat(cloud.storage(), true, options);
    expect(upgraded.format_version).toBe(4);
    expect(upgraded.min_reader_version).toBe(3);
    expect(upgraded.compatibility_lease?.holder_device_id).toBe('reader');
  });

  it('v4_migration_requires_every_non_superseded_manifest', async () => {
    const cloud = new Cloud();
    expiredFormat(cloud);
    expect((await service.validateRemoteFormat(cloud.storage(), true, options)).min_reader_version).toBe(3);
    peer(cloud, 'new', 4);
    const old = peer(cloud, 'old', 3);
    expect((await service.validateRemoteFormat(cloud.storage(), true, options)).min_reader_version).toBe(3);
    cloud.seed(deviceManifestKey('old'), { ...old, superseded_by: 'new' });
    const migrated = await service.validateRemoteFormat(cloud.storage(), true, options);
    expect(migrated.min_reader_version).toBe(4);
    expect(migrated.compatibility_lease).toBeNull();
    expect(cloud.writes).toEqual([FORMAT_KEY]);
  });

  it.each([
    { features: null }, { features: 'v4' }, { checkpoint: { complete: 1 } },
    { checkpoint: { full_listing_verified: null } },
    { compatibility_lease: { expires_at: 123 } },
    { checkpoint: { generation: -1 } },
    { min_client: 3, min_reader_version: 3 },
  ])('rejects invalid descriptor fields before writes: %j', async invalid => {
    const cloud = new Cloud(); cloud.seed(FORMAT_KEY, invalid);
    await expect(service.validateRemoteFormat(cloud.storage(), true, options))
      .rejects.toThrow('Database error: 远端 format.json 损坏:');
    expect(cloud.writes).toEqual([]);
  });

  it('rejects out-of-range u64 and retains exact large checkpoint cursors', () => {
    expect(() => parseFormatDescriptor('{"checkpoint":{"generation":18446744073709551616}}')).toThrow();
    const parsed = parseFormatDescriptor('{"checkpoint":{"generation":18446744073709551615,"shard_cursors":{"a":9007199254740993}}}');
    expect(parsed.checkpoint?.generation).toBe(18446744073709551615n);
    expect(parsed.checkpoint?.shard_cursors.a).toBe(9007199254740993n);
  });

  it('rejects future versions and a concurrent upgrade before writing', async () => {
    const cloud = new Cloud(); cloud.seed(FORMAT_KEY, { format_version: 5 });
    await expect(service.validateRemoteFormat(cloud.storage(), true, options)).rejects.toThrow('高于当前客户端 v4');
    cloud.seed(FORMAT_KEY, { format_version: 3 });
    cloud.afterList = () => cloud.seed(FORMAT_KEY, { format_version: 5, min_client: 5 });
    await expect(service.validateRemoteFormat(cloud.storage(), true, options)).rejects.toThrow('协商期间升级到 v5');
    expect(cloud.writes).toEqual([]);
  });

  it('validates readback structurally and rejects changed fields', async () => {
    const cloud = new Cloud();
    const descriptor = parseFormatDescriptor('{"format_version":4,"min_client":4,"checkpoint":{"shard_cursors":{"a":1,"b":2}}}');
    const { writeFormatDescriptor } = await import('../src/remote-format.ts');
    cloud.afterPut = key => cloud.seed(key, { ...descriptorToJson(descriptor) as object,
      checkpoint: { ...descriptor.checkpoint, shard_cursors: { b: 2, a: 1 } },
    });
    await writeFormatDescriptor(cloud.storage(), descriptor);
    cloud.afterPut = key => cloud.seed(key, { format_version: 3 });
    await expect(writeFormatDescriptor(cloud.storage(), descriptor)).rejects.toThrow('写入后远端 format.json 内容不一致');
  });
});

describe('sequence availability via sync', () => {
  const state: SyncCursorStore = { bindInstance: () => undefined, cursors: () => new Map() };
  it.each([
    [[2], 2, 1], [[1, 3], 3, 2], [[1], 2, 2], [[], 1, 1],
  ] as const)('sequence_gap_preflight_catches_prefix_middle_tail_and_entire_missing_logs: %j', async (seqs, published, expected) => {
    const cloud = new Cloud(); peer(cloud, 'writer', 4, published);
    cloud.seed(INSTANCE_KEY, { instance_id: 'instance' });
    for (const seq of seqs) shard(cloud, seq);
    const result = await service.detectChangeLogGaps(cloud.storage(), options, () => state);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.expected_seq).toBe(BigInt(expected));
    expect(cloud.writes).toEqual([]);
    await expect(service.downloadChanges(cloud.storage(), 0n, null, options)).rejects.toThrow('缺少序号');
  });

  it.each([false, true])('sequence_gap_preflight_allows_publication_after_listing: v4=%s', async v4 => {
    const cloud = new Cloud(); peer(cloud, 'writer', 4, 1); shard(cloud, 1);
    const prefix = v4 ? 'data_governance/v4/shards' : 'data_governance/changes';
    const publish = vi.fn((listed: string) => {
      if (listed !== prefix) return;
      shard(cloud, 2, v4); peer(cloud, 'writer', 4, 2);
      cloud.afterList = undefined;
    });
    cloud.afterList = publish;
    const result = await service.detectChangeLogGaps(cloud.storage(), options, () => state);
    expect(result.gaps).toEqual([]);
    expect(publish).toHaveBeenCalledWith(prefix);
    expect(cloud.afterList).toBeUndefined();
    const manifests = await readDeviceManifests(cloud.storage(), options);
    expect(manifests.get('writer')!.published_max_seq).toBe(2);
    const inventory = changeSequenceInventory(await listAllChangeKeys(cloud.storage()), manifests, 'reader');
    expect(inventory.get('writer')!.sort()).toEqual([1n, 2n]);
    expect((await service.detectChangeLogGaps(cloud.storage(), options, () => state)).gaps).toEqual([]);
  });

  it('legacy_timestamp_distance_alone_is_not_a_proven_prune_gap', async () => {
    const cloud = new Cloud();
    cloud.files.set('data_governance/changes/peer/1792755307.json.zst', new Uint8Array());
    const open = vi.fn(() => state);
    const report = await service.detectChangeLogGaps(cloud.storage(), options, open);
    expect(report.gaps).toEqual([]);
    expect(report.min_available_version).toBe(1792755307n);
    expect(cloud.files.has(INSTANCE_KEY)).toBe(false);
    expect(cloud.files.has(FORMAT_KEY)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(cloud.writes).toEqual([]);
  });

  it('binds the exact instance before reading cursors and never acknowledges', async () => {
    const cloud = new Cloud(); cloud.seed(INSTANCE_KEY, { instance_id: ' instance ' });
    peer(cloud, 'writer', 4, 3); shard(cloud, 3);
    const calls: string[] = [];
    const store: SyncCursorStore = {
      bindInstance: (id, provider, hint) => calls.push(`${id}:${provider}:${hint}`),
      cursors: id => { calls.push(id); return new Map([['writer', 2n]]); },
    };
    expect((await service.detectChangeLogGaps(cloud.storage(), options, () => store)).gaps).toEqual([]);
    expect(calls).toEqual(['instance:memory:memory:remote-protocol', 'instance']);
    expect(cloud.writes).toEqual([]);
  });
});

it('regression_c4_dedupe_keeps_last', async () => {
  const cloud = new Cloud(); peer(cloud, 'writer', 4, 1);
  const key = shard(cloud, 1);
  cloud.seed(key, { device_id: 'writer', total_count: 3, changes: [1, 2, 1].map((x, index) => ({
    table_name: 'items', record_id: 'r1', operation: 'Update', data: { x },
    changed_at: '2026-01-01T00:00:00Z', change_log_id: index + 1,
  })) });
  const result = await service.downloadChanges(cloud.storage(), 0n, null, options);
  expect(result.changes).toHaveLength(2);
  expect(result.changes[1]!.change_log_id).toBe(3);
  expect(result.changes[1]!.data).toEqual({ x: 1 });
  expect(result.changes[0]!.data).toEqual({ x: 2 });
  expect(result.cursor_advancements.get('writer')).toBe(1n);
});

it('regression_c4_dedupe_distinct_kept', async () => {
  const cloud = new Cloud(); peer(cloud, 'writer', 4, 1); const key = shard(cloud, 1);
  cloud.seed(key, { device_id: 'writer', total_count: 3, changes: [['r1', 1], ['r2', 1], ['r1', 2]].map(([id, x], index) => ({
    table_name: 'items', record_id: id, operation: 'Update', data: { x },
    changed_at: '2026-01-01T00:00:00Z', change_log_id: index + 1,
  })) });
  const result = await service.downloadChanges(cloud.storage(), 0n, null, options);
  expect(result.changes).toHaveLength(3);
  expect(result.changes.map(change => change.change_log_id)).toEqual([1, 2, 3]);
});

it('v4 parsing keeps the full UUID operation identity', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  expect(parseChangeKey(`data_governance/v4/shards/peer/000000000043-1707500001-${uuid}.json.zst`))
    .toEqual({ kind: 'v4Shard', deviceId: 'peer', seq: 43n, version: 1707500001n, operationId: uuid });
});

it.each([
  ['test_parse_version_from_key_with_nonce', '12345-acde.json', 12345n],
  ['test_parse_version_from_key_legacy_no_nonce', '1707500000.json', 1707500000n],
  ['test_parse_version_from_key_seconds_with_nonce', '1707500000-550e8400-e29b-41d4-a716-446655440000.json', 1707500000n],
  ['test_parse_version_from_key_zst_with_nonce', '1707500000-550e8400-e29b-41d4-a716-446655440000.json.zst', 1707500000n],
  ['test_parse_version_from_key_zst_legacy_no_nonce', '1707500000.json.zst', 1707500000n],
] as const)('%s', (_title, file, expected) => {
  expect(parseVersionFromKey(`data_governance/changes/device-1/${file}`)).toBe(expected);
});

it('test_parse_version_from_key_invalid', () => {
  for (const key of ['', 'no-slash', 'data_governance/changes/device-1/notanumber.json', 'data_governance/changes/device-1/abc.json.zst']) {
    expect(parseVersionFromKey(key)).toBeNull();
  }
});

it('fresh_device_cursor_zero_is_not_a_prune_gap', () => {
  expect(service.hasPruneGap(0n, 1n)).toBe(false);
  expect(service.hasPruneGap(0n, 42n)).toBe(false);
  expect(service.hasPruneGap(3n, 4n)).toBe(true);
  expect(missingSequenceIsProven(1n, 1n, 1n)).toBe(false);
  expect(missingSequenceIsProven(1n, 2n, 0n)).toBe(true);
  expect(missingSequenceIsProven(6n, 7n, 5n)).toBe(true);
});

it('schema_error_reports_only_real_mismatches_in_stable_order', () => {
  const state = (schema: number, version: number, checksum: string) => ({ schema_version: schema, data_version: version, checksum });
  const local = createManifest('old', { chat_v2: state(20260910, 100, 'local'), vfs: state(20261006, 100, 'vfs'), mistakes: state(20261005, 100, 'mistakes') });
  const cloud = createManifest('new', { chat_v2: state(20260910, 101, 'cloud'), vfs: state(20261023, 101, 'vfs'), mistakes: state(20261006, 101, 'mistakes') });
  const error = schemaMismatchError(detectConflicts(local, cloud))!;
  expect(error.message).not.toContain('chat_v2');
  expect(error.message).toContain('vfs (local=20261006, cloud=20261023)');
  expect(error.message).toContain('升级当前客户端');
  expect(error.mismatches.map(item => item.database_name)).toEqual(['mistakes', 'vfs']);
  expect(schemaMismatchError(detectConflicts(cloud, local))!.message).toContain('升级其他设备');
});

it('rebuilt_cloud_ignores_stale_database_versions_and_old_instance_cursors', async () => {
  const cloud = new Cloud();
  instanceCursors.set('old-instance', new Map([['writer', 99n]]));
  cloud.seed(INSTANCE_KEY, { instance_id: 'new-instance' });
  cloud.seed(FORMAT_KEY, { format_version: 4, min_client: 4 });
  const key = shard(cloud, 1);
  cloud.seed(key, { changes: [], total_count: 0, device_id: 'writer', format_version: 3, source_seq: 1, source_device_id: 'writer' });
  cloud.seed(deviceManifestKey('writer'), { ...createManifest('writer', {
    vfs: { schema_version: 20261023, data_version: 100, checksum: 'vfs' },
  }), published_max_seq: 1 });
  const local = createManifest('reader', {
    vfs: { schema_version: 20261023, data_version: 1792755314, checksum: 'vfs' },
    mistakes: { schema_version: 20261005, data_version: 1792655731, checksum: 'mistakes' },
  });
  const report = await service.detectChangeLogGaps(cloud.storage(), options, () => ({ bindInstance: () => undefined, cursors: id => instanceCursors.get(id) ?? new Map() }));
  expect(report.gaps).toEqual([]);
  const [, downloaded] = await service.executeDownload(cloud.storage(), local, 'KeepLatest', options);
  expect(downloaded.cursor_advancements.get('writer')).toBe(1n);
  expect(instanceCursors.get('old-instance')!.get('writer')).toBe(99n);
  expect(instanceCursors.get('new-instance')?.get('writer') ?? 0n).toBe(0n);
});

it.each([false, true])('sequence_gap_download_allows_publication_after_listing: v4=%s', async v4 => {
  const cloud = new Cloud(); peer(cloud, 'writer', 4, 1);
  cloud.seed(FORMAT_KEY, { format_version: 4, min_client: 4 });
  cloud.seed(INSTANCE_KEY, { instance_id: 'download-instance' });
  const firstKey = shard(cloud, 1);
  cloud.seed(firstKey, { changes: [], total_count: 0, device_id: 'writer', format_version: 3, source_seq: 1, source_device_id: 'writer' });
  const prefix = v4 ? 'data_governance/v4/shards' : 'data_governance/changes';
  cloud.afterList = listed => {
    if (listed !== prefix) return;
    const key = shard(cloud, 2, v4);
    cloud.seed(key, { changes: [], total_count: 0, device_id: 'writer', format_version: v4 ? 4 : 3,
      source_seq: 2, source_device_id: 'writer', operation_id: v4 ? 'operation-id' : null });
    peer(cloud, 'writer', 4, 2); cloud.afterList = undefined;
  };
  const first = await service.downloadChanges(cloud.storage(), 0n, null, options);
  expect(cloud.afterList).toBeUndefined();
  expect(first.cursor_advancements.get('writer')).toBe(1n);
  const second = await service.downloadChanges(cloud.storage(), 0n, null, options);
  expect(second.cursor_advancements.get('writer')).toBe(2n);
  // The injected state rejects all setCursor calls; raw state remains zero across both reads.
});

it('decodes real zstd and verifies v4 operation identity without acknowledging', async () => {
  const cloud = new Cloud(); peer(cloud, 'writer', 4, 1); const key = shard(cloud, 1, true);
  const payload = { changes: [], total_count: 0, device_id: 'writer', source_device_id: 'writer',
    source_seq: 1, format_version: 4, operation_id: 'operation-id' };
  cloud.files.set(key, await compression.zstdEncode(Buffer.from(JSON.stringify(payload))));
  expect((await service.downloadChanges(cloud.storage(), 0n, null, options)).cursor_advancements.get('writer')).toBe(1n);
  cloud.seed(key, { ...payload, operation_id: 'operation' });
  await expect(service.downloadChanges(cloud.storage(), 0n, null, options)).rejects.toThrow('v4 变更分片 operation_id/format 与路径不一致');
});

it('test_version_space_compatibility_seconds', async () => {
  const cloud = new Cloud();
  for (const [version, id] of [[1707500000, 'fresh'], [1707300000, 'stale']] as const) {
    cloud.seed(`data_governance/changes/peer/${version}.json`, {
      device_id: 'peer', total_count: 1, changes: [{ table_name: 'notes', record_id: id,
        operation: 'Update', data: { id }, changed_at: '2026-01-01T00:00:00Z' }],
    });
  }
  const result = await service.downloadChanges(cloud.storage(), 1707400000n, null, options);
  expect(result.changes.map(change => change.record_id)).toEqual(['fresh']);
  expect(result.changes[0]!.source_seq).toBe(1707500000n);
  expect(result.legacy_processed_keys).toEqual(['data_governance/changes/peer/1707500000.json']);
});

it('path_aliases_merge_raw_and_hashed_prefixes', () => {
  const raw = 'device-peer'; const hashed = deviceIdShortHash(raw);
  const aliases = pathDeviceAliases(new Set([raw, hashed, 'unrelated']));
  expect(aliases.get(hashed)).toBe('device-peer');
  expect(aliases.get(raw)).toBe('device-peer');
  expect(aliases.has('unrelated')).toBe(false);
});

it('is_own_change_file_accepts_hashed_and_legacy_raw_prefix', () => {
  const key = (id: string) => `data_governance/changes/${id}/000000000001-1707500000-nonce.json.zst`;
  const hashed = deviceIdShortHash('device-1'); const other = deviceIdShortHash('device-2');
  expect(changeSequenceInventory([key(hashed)], new Map(), 'device-1').size).toBe(0);
  expect(changeSequenceInventory([key('device-1')], new Map(), 'device-1').size).toBe(0);
  expect(changeSequenceInventory([key(other)], new Map(), 'device-1').get(other)).toEqual([1n]);
});
