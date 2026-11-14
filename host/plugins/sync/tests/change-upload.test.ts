import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import plugin from '../index.ts';
import { createPayloadCodec, type SyncService } from '../api.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { deviceIdShortHash } from '../../sync-providers/api.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import { buildChangeKeyV3, buildChangeKeyV4, parseChangeKey, parseVersionFromKey, pathIdMatchesDevice } from '../src/change-keys.ts';
import { deviceManifestKey, deviceManifestLegacyKey } from '../src/remote-manifest.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let sync: SyncService;
const published = vi.fn();
const codec = await createPayloadCodec(undefined, null);
const options = { deviceId: 'device-1', codec };
beforeAll(async () => {
  host = await createTestHost({ plugins: [plugin], provide: { storage: {}, paths: {}, syncSupport: { state: {
    bindInstance: () => undefined, nextUploadSeq: () => 43n, markPublishedSeq: published,
  } } } });
  sync = host.ctx.sync;
});
afterAll(async () => { codec.dispose(); await host.dispose(); });

function cloud(v4: boolean, badSize = false) {
  const files = new Map<string, Uint8Array>([
    ['data_governance/format.json', Buffer.from(JSON.stringify({ format_version: 4, min_client: v4 ? 4 : 3,
      compatibility_lease: { expires_at: '2999-01-01T00:00:00Z' } }))],
    ['data_governance/instance.json', Buffer.from('{"instance_id":"instance"}')],
  ]);
  const put = vi.fn(async (key: string, bytes: Uint8Array) => { files.set(key, bytes); });
  const storage = {
    providerName: () => 'memory', instanceBindingHint: () => 'root', put,
    get: async (key: string) => files.get(key) ?? null,
    listOutcome: async (prefix: string) => ({ files: [...files.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }),
    stat: async (key: string) => files.has(key) ? { key, size: files.get(key)!.length + (badSize ? 1 : 0) } : null,
    putFile: vi.fn(async (key: string, path: string, progress?: (done: number, total: number) => void) => {
      const bytes = await readFile(path); files.set(key, bytes); progress?.(bytes.length, bytes.length); return '';
    }),
  };
  return { files, put, storage: storage as unknown as CloudStorage, stream: storage.putFile };
}
const changes = [{ table_name: 'notes', record_id: 'n1', operation: 'Update' as const,
  data: { id: 'n1', content: 'body' }, changed_at: '2026-01-01T00:00:00Z' }];

it('record_path_id_is_short_hash_and_matches_raw_or_hashed', () => {
  const raw = 'device-1', hashed = deviceIdShortHash(raw);
  expect(hashed).toHaveLength(16); expect(hashed).not.toBe(raw); expect(hashed).toMatch(/^[0-9a-fA-F]+$/u);
  expect(pathIdMatchesDevice(raw, raw)).toBe(true);
  expect(pathIdMatchesDevice(hashed, raw)).toBe(true);
  expect(pathIdMatchesDevice('device-other', raw)).toBe(false);
  expect(deviceManifestKey(raw)).toBe(`data_governance/manifests/${hashed}.json`);
  expect(deviceManifestLegacyKey(raw)).toBe('data_governance/manifests/device-1.json');
});

it('regression_c1_v3_change_key_parses_seq_and_timestamp', () => {
  const key = buildChangeKeyV3('device-1', 42n, 1707500000n);
  expect(parseVersionFromKey(key)).toBe(1707500000n);
  expect(key).not.toContain('device-1');
  expect(parseChangeKey(key)).toEqual({ kind: 'v3', deviceId: deviceIdShortHash('device-1'), seq: 42n, version: 1707500000n });
});

it('v4_change_shard_key_is_sequenced_and_parseable', () => {
  const key = buildChangeKeyV4('device-1', 43n, 1707500001n);
  expect(key.startsWith(`data_governance/v4/shards/${deviceIdShortHash('device-1')}/`)).toBe(true);
  expect(key).not.toContain('device-1');
  expect(parseChangeKey(key)).toEqual({ kind: 'v4Shard', deviceId: deviceIdShortHash('device-1'), seq: 43n,
    version: 1707500001n, operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
});

it.each([false, true])('uploads compressed changes and advances published seq only after verification: v4=%s', async v4 => {
  const remote = cloud(v4); published.mockClear();
  await sync.uploadEnrichedChanges(remote.storage, changes, options);
  const key = remote.put.mock.calls[0]![0];
  const parsed = parseChangeKey(key)!;
  expect(parsed.kind).toBe(v4 ? 'v4Shard' : 'v3');
  const payload = JSON.parse(Buffer.from(await compression.zstdDecode(remote.files.get(key)!)).toString());
  expect(payload.changes[0].data).toEqual(changes[0]!.data);
  expect(payload.source_seq).toBe(43);
  if (parsed.kind === 'v4Shard') expect(payload.operation_id).toBe(parsed.operationId);
  expect(published).toHaveBeenCalledExactlyOnceWith('instance', 'device-1', 43n);
});

it('regression_c8_upload_path_verifies_size', async () => {
  const remote = cloud(true, true); published.mockClear();
  await expect(sync.uploadEnrichedChanges(remote.storage, changes, options)).rejects.toThrow('上传后 size 校验失败');
  expect(remote.put).toHaveBeenCalledTimes(2);
  expect(published).not.toHaveBeenCalled();
});

it('regression_c8_upload_path_verifies_size: same-length wrong bytes cannot advance published sequence', async () => {
  const remote = cloud(true); published.mockClear();
  const get = remote.storage.get.bind(remote.storage);
  remote.storage.get = async key => {
    const bytes = await get(key);
    if (bytes !== null && key.endsWith('.json.zst')) { const wrong = Uint8Array.from(bytes); wrong[0]! ^= 255; return wrong; }
    return bytes;
  };
  await expect(sync.uploadEnrichedChanges(remote.storage, changes, options)).rejects.toThrow('记录级变更 上传后回读不一致');
  expect(remote.put).toHaveBeenCalledTimes(2); expect(published).not.toHaveBeenCalled();
});

it('streams upload progress with a temporary file and removes it afterward', async () => {
  const remote = cloud(true); const progress = vi.fn();
  await sync.uploadEnrichedChanges(remote.storage, changes, options, progress);
  expect(remote.stream).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalled();
  expect(remote.put).not.toHaveBeenCalled();
  const path = remote.stream.mock.calls[0]![1];
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
