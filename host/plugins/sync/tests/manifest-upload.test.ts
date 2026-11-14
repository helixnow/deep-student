import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import plugin from '../index.ts';
import { createPayloadCodec, type SyncService } from '../api.ts';
import { createManifest } from '../src/merge.ts';
import { deviceManifestKey, MANIFESTS_PREFIX, parseSyncManifest } from '../src/remote-manifest.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { CLOUD_RATE_LIMITED_CODE } from '../../sync-providers/api.ts';

class Storage {
  files = new Map<string, Uint8Array>();
  puts: string[] = [];
  deletes: string[] = [];
  failPut?: Error;
  failDelete?: Error;
  get = async (key: string) => this.files.get(key) ?? null;
  put = async (key: string, bytes: Uint8Array) => {
    this.puts.push(key);
    if (this.failPut) throw this.failPut;
    this.files.set(key, bytes.slice());
  };
  listOutcome = async (prefix: string) => ({
    files: [...this.files].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.length, lastModified: '' })),
    truncated: false,
  });
  stat = async (key: string) => this.files.has(key) ? { key } : null;
  delete = async (key: string) => {
    this.deletes.push(key);
    if (this.failDelete) throw this.failDelete;
    this.files.delete(key);
  };
  providerName = () => 'memory';
  instanceBindingHint = () => 'root';
  seed(key: string, value: unknown) { this.files.set(key, Buffer.from(JSON.stringify(value))); }
  cloud() { return this as unknown as CloudStorage; }
}

const codec = await createPayloadCodec(undefined, null);
const options = { deviceId: 'current', codec };
let host: Awaited<ReturnType<typeof createTestHost>>;
let service: SyncService;
const state = {
  bindInstance: vi.fn(), deviceRotationsForNew: () => [] as [string, string][],
  publishedMaxSeq: () => 9007199254740993n, cursors: () => new Map([['peer', 9007199254740995n]]),
};
beforeAll(async () => {
  host = await createTestHost({ plugins: [plugin], provide: {
    storage: {}, paths: {}, syncSupport: { state },
  } });
  service = host.ctx.sync;
});
afterAll(async () => { codec.dispose(); await host.dispose(); });

function manifest(device: string, schema: number, version = 1) {
  return createManifest(device, { vfs: { schema_version: schema, data_version: version, checksum: device } });
}

it('schema_upload_allows_upgrade_and_rejects_missing_local_database', async () => {
  const storage = new Storage();
  storage.seed(deviceManifestKey('peer'), manifest('peer', 20261006, 1000));
  await service.validateUploadSchemaCompatibility(storage.cloud(), manifest('writer', 20261023), options);
  await expect(service.validateUploadSchemaCompatibility(storage.cloud(), createManifest('writer', {}), options)).rejects.toThrow('local=0, cloud=20261006');
  expect(storage.puts).toEqual([]);
});

it('schema_gate_checks_both_raw_and_hashed_manifests_before_deduplication', async () => {
  const storage = new Storage();
  storage.seed(deviceManifestKey('current'), manifest('current', 20261023));
  const downgraded = { ...manifest('current', 20261006, 999), published_max_seq: 999 };
  storage.seed(`${MANIFESTS_PREFIX}/current.json`, downgraded);
  await expect(service.validateUploadSchemaCompatibility(storage.cloud(), downgraded, options))
    .rejects.toThrow('local=20261006, cloud=20261023');
});

it.each(['current', 'peer'])('schema_upload_rejects_peer_and_same_device_downgrades_without_writes (manifest portion): %s', async device => {
  const storage = new Storage();
  const key = deviceManifestKey(device);
  storage.seed(key, manifest(device, 20261023));
  const original = storage.files.get(key)!.slice();
  await expect(service.uploadManifest(storage.cloud(), manifest('current', 20261006, 1000), options))
    .rejects.toThrow('vfs (local=20261006, cloud=20261023)');
  expect(storage.files.size).toBe(1);
  expect(storage.files.get(key)).toEqual(original);
  expect(storage.puts).toEqual([]);
});

it('publishes verified bytes with exact state cursors, then removes legacy key', async () => {
  const storage = new Storage();
  storage.seed(`${MANIFESTS_PREFIX}/current.json`, manifest('current', 1));
  await service.uploadManifest(storage.cloud(), manifest('input-device', 1), options);
  const uploaded = parseSyncManifest(Buffer.from(storage.files.get(deviceManifestKey('current'))!).toString());
  expect(uploaded.device_id).toBe('current');
  expect(uploaded.format_version).toBe(4);
  expect(uploaded.published_max_seq).toBe(9007199254740993n);
  expect(uploaded.cursors.peer).toBe(9007199254740995n);
  expect(storage.files.has(`${MANIFESTS_PREFIX}/current.json`)).toBe(false);
  expect(state.bindInstance).toHaveBeenCalledWith(expect.any(String), 'memory', 'root');
  expect(storage.puts).toEqual(['data_governance/format.json', 'data_governance/instance.json', deviceManifestKey('current')]);
});

it('sync_outer_retry_preserves_rate_limit_without_another_attempt', async () => {
  const storage = new Storage();
  storage.seed('data_governance/format.json', { format_version: 4, min_client: 4 });
  storage.seed('data_governance/instance.json', { instance_id: 'instance' });
  storage.failPut = new Error(`[${CLOUD_RATE_LIMITED_CODE}] HTTP 503 BlockedTemporarily`);
  await expect(service.uploadManifest(storage.cloud(), manifest('current', 1), options)).rejects.toThrow('BlockedTemporarily');
  expect(storage.puts).toHaveLength(1);
});

it('legacy deletion failure does not overturn verified publication', async () => {
  const storage = new Storage();
  storage.seed(`${MANIFESTS_PREFIX}/current.json`, manifest('current', 1));
  storage.failDelete = new Error('permission denied');
  await service.uploadManifest(storage.cloud(), manifest('current', 1), options);
  expect(storage.files.has(deviceManifestKey('current'))).toBe(true);
  expect(storage.deletes).toEqual([`${MANIFESTS_PREFIX}/current.json`]);
});

it.each(['instance', 'manifest'] as const)('regression_c8_upload_path_verifies_size: %s publication requires byte readback', async kind => {
  const storage = new Storage();
  storage.seed('data_governance/format.json', { format_version: 4, min_client: 4 });
  if (kind === 'manifest') storage.seed('data_governance/instance.json', { instance_id: 'existing' });
  const key = kind === 'instance' ? 'data_governance/instance.json' : deviceManifestKey('current');
  const get = storage.get;
  storage.get = async candidate => {
    const bytes = await get(candidate);
    if (bytes !== null && candidate === key && storage.puts.includes(candidate)) {
      const wrong = Uint8Array.from(bytes); wrong[0]! ^= 255; return wrong;
    }
    return bytes;
  };
  await expect(service.uploadManifest(storage.cloud(), manifest('current', 1), options)).rejects.toThrow('上传后回读不一致');
  expect(storage.puts).toContain(key);
});
