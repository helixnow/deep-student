import './local-runtime-fixture.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { createPayloadCodec } from '../src/payload.ts';
import { syncAssetDirectories } from '../src/asset-sync.ts';
import { downloadAssetsManifest, publishAssetManifest, type AssetSyncOptions } from '../src/asset-manifest.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';

const roots: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), 'sync-assets-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it('file_e2ee_asset_roundtrip_and_legacy_rejection', async () => {
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
      const bytes = files.get(key)!; if (sha(bytes) !== expected) throw new Error('checksum mismatch');
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return sha(bytes);
    }, instanceBindingHint: () => 'asset-tests',
  } as unknown as CloudStorage;
  async function options(deviceId: string): Promise<AssetSyncOptions> {
    return { deviceId, codec: await createPayloadCodec(backup, 'shared-pw'), isCancelled: () => false,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tombstones: { downloadAssetTombstones: async () => ({ entries: {}, updated_at: '' }) },
    };
  }
  const a = await options('a'), b = await options('b'), rootA = directory(), rootB = directory();
  mkdirSync(join(rootA, 'images')); const plain = Buffer.from('png bytes here'); writeFileSync(join(rootA, 'images/pic.png'), plain);
  writeFileSync(join(rootA, 'images/duplicate.png'), plain);
  try {
    expect(await syncAssetDirectories(cloud, rootA, rootA, 'Upload', a)).toEqual({ uploaded: 2, downloaded: 0, upload_failures: [], download_failures: [] });
    const entry = (await downloadAssetsManifest(cloud, a)).entries.get('active/images/pic.png')!;
    const key = entry.object_key!, bytes = files.get(key)!;
    expect(real.isEncryptedBackup(bytes)).toBe(true);
    expect(key).toBe(`data_governance/asset_objects/${sha(bytes)}`);
    expect(entry.cipher_sha256).toBe(sha(bytes)); expect(entry.sha256).toBe(sha(plain));
    expect(await syncAssetDirectories(cloud, rootB, rootB, 'Download', b)).toEqual({ uploaded: 0, downloaded: 2, upload_failures: [], download_failures: [] });
    expect(readFileSync(join(rootB, 'images/pic.png'))).toEqual(plain);
    expect(readFileSync(join(rootB, 'images/duplicate.png'))).toEqual(plain);
    const legacy = Buffer.from('legacy plaintext asset'), legacyKey = `data_governance/asset_objects/${sha(legacy)}`; files.set(legacyKey, legacy);
    const manifest = await downloadAssetsManifest(cloud, a);
    manifest.entries.set('active/images/legacy.png', { sha256: sha(legacy), size: BigInt(legacy.length), updated_at: '2026-01-01T00:00:00Z',
      object_key: legacyKey, base_sha256: null, revision: 1n, device_id: 'legacy', cipher_sha256: null, cipher_size: null });
    await publishAssetManifest(cloud, manifest, a);
    expect((await syncAssetDirectories(cloud, rootB, rootB, 'Download', b)).download_failures).toEqual(['active/images/legacy.png']);
    expect(existsSync(join(rootB, 'images/legacy.png'))).toBe(false);
  } finally { a.codec.dispose(); b.codec.dispose(); }
});
