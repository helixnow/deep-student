import './local-runtime-fixture.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { createPayloadCodec } from '../src/payload.ts';
import { syncVfsBlobs, downloadBlobsManifest, publishBlobManifest, type BlobSyncOptions } from '../src/blob-sync.ts';
import { deviceIdShortHash, type CloudStorage } from '../../sync-providers/api.ts';

const roots: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), 'sync-blobs-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it('file_e2ee_blob_roundtrip_rejection_and_migration / file_and_snapshot_keys_are_neutral_ids (active blobs manifest)', async () => {
  const real = createBackupCrypto();
  const backup = { ...real, createFileCipherSession: (pw: string) => real.createFileCipherSession(pw, { mCost: 8, tCost: 1, pCost: 1 }) };
  const files = new Map<string, Uint8Array>();
  const cloud = {
    get: async (key: string) => files.get(key) ?? null,
    put: async (key: string, bytes: Uint8Array) => { files.set(key, bytes.slice()); },
    listOutcome: async (prefix: string) => ({ files: [...files].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.length })), truncated: false }),
    stat: async (key: string) => files.has(key) ? { key, size: files.get(key)!.length } : null,
    putFile: async (key: string, path: string) => { const bytes = readFileSync(path); files.set(key, bytes); return sha(bytes); },
    supportsResumableDownload: () => false,
    getFile: async (key: string, path: string, expected: string) => {
      const bytes = files.get(key)!;
      if (sha(bytes) !== expected) throw new Error('checksum mismatch');
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return sha(bytes);
    },
    instanceBindingHint: () => 'blob-tests',
  } as unknown as CloudStorage;
  async function options(deviceId: string): Promise<BlobSyncOptions> {
    return { deviceId, codec: await createPayloadCodec(backup, 'shared-pw'), isCancelled: () => false,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tombstones: { downloadBlobTombstones: async () => ({ entries: {}, updated_at: '' }) },
    };
  }
  const a = await options('device-file-path'), b = await options('b'), c = await options('c');
  const dirA = directory(), dirB = directory(), dirC = directory();
  const bytes = Buffer.from('blob payload for e2ee'); const hash = sha(bytes); const rel = `${hash.slice(0, 2)}/${hash}.pdf`;
  mkdirSync(dirname(join(dirA, rel)), { recursive: true }); writeFileSync(join(dirA, rel), bytes);
  try {
    expect(await syncVfsBlobs(cloud, dirA, 'Upload', a)).toEqual({ uploaded: 1, downloaded: 0, upload_failures: [], download_failures: [] });
    // mod.rs:13779-13797: the active half of file_and_snapshot_keys_are_neutral_ids.
    const manifestKey = [...files.keys()].find(key => key.startsWith('data_governance/file_manifests/blobs/'))!;
    expect(manifestKey.startsWith('data_governance/file_manifests/blobs/')).toBe(true);
    expect(manifestKey.endsWith('.json')).toBe(true);
    const fileName = manifestKey.split('/').at(-1)!;
    expect(fileName).toHaveLength(36 + '.json'.length);
    expect(manifestKey).not.toContain(a.deviceId);
    expect(manifestKey).not.toContain(deviceIdShortHash(a.deviceId));
    expect(fileName).not.toMatch(/^\d{13}/u);
    const key = `data_governance/blobs/${rel}`; const object = files.get(key)!;
    expect(real.isEncryptedBackup(object)).toBe(true);
    const entry = (await downloadBlobsManifest(cloud, a)).entries.get(hash)!;
    expect(entry.cipher_sha256).toBe(sha(object)); expect(entry.cipher_size).toBe(BigInt(object.length)); expect(entry.size).toBe(BigInt(bytes.length));
    expect(await syncVfsBlobs(cloud, dirB, 'Download', b)).toEqual({ uploaded: 0, downloaded: 1, upload_failures: [], download_failures: [] });
    expect(readFileSync(join(dirB, rel))).toEqual(bytes);
    const corrupt = object.slice(); corrupt[corrupt.length - 1]! ^= 255; files.set(key, corrupt);
    const rejected = await syncVfsBlobs(cloud, dirC, 'Download', c);
    expect(rejected.download_failures).toEqual([hash]); expect(existsSync(join(dirC, rel))).toBe(false);
    files.set(key, object);
    const legacy = Buffer.from('legacy plaintext blob'); const legacyHash = sha(legacy); const legacyRel = `${legacyHash.slice(0, 2)}/${legacyHash}.pdf`;
    const legacyKey = `data_governance/blobs/${legacyRel}`; files.set(legacyKey, legacy);
    const manifest = await downloadBlobsManifest(cloud, a);
    manifest.entries.set(legacyHash, { relative_path: legacyRel, size: BigInt(legacy.length), updated_at: '2026-01-01T00:00:00Z', cipher_sha256: null, cipher_size: null });
    await publishBlobManifest(cloud, manifest, a);
    expect((await syncVfsBlobs(cloud, dirB, 'Download', b)).download_failures).toEqual([legacyHash]);
    expect(existsSync(join(dirB, legacyRel))).toBe(false);
    mkdirSync(dirname(join(dirA, legacyRel)), { recursive: true }); writeFileSync(join(dirA, legacyRel), legacy);
    expect((await syncVfsBlobs(cloud, dirA, 'Upload', a)).uploaded).toBe(1);
    expect(real.isEncryptedBackup(files.get(legacyKey)!)).toBe(true);
    expect((await downloadBlobsManifest(cloud, a)).entries.get(legacyHash)!.cipher_sha256).not.toBeNull();
    expect(await syncVfsBlobs(cloud, dirB, 'Download', b)).toEqual({ uploaded: 0, downloaded: 1, upload_failures: [], download_failures: [] });
    expect(readFileSync(join(dirB, legacyRel))).toEqual(legacy);
  } finally { a.codec.dispose(); b.codec.dispose(); c.codec.dispose(); }
});
