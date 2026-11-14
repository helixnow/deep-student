import './local-runtime-fixture.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { AssetTombstones, SyncStateStore } from '../../sync-support/api.ts';
import type { AsyncAssetTombstones } from '../src/tombstone-needs.ts';
import { createPayloadCodec } from '../src/payload.ts';
import { assetLocalPath } from '../src/asset-paths.ts';
import { syncAssetDirectories } from '../src/asset-sync.ts';
import { syncAssetsWithTombstones } from '../src/file-tombstone-sync.ts';
import { publishAssetManifest } from '../src/asset-manifest.ts';
import { classifyAssets, type AssetEntry } from '../src/unsynced-classification.ts';
import { createTestHost } from './host-fixture.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'asset-top-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }

/** A plaintext (no E2EE) server that can publish any asset manifest entry and tombstone (S01-security-r2 M2). */
async function maliciousServer(tombstones: AssetTombstones = { entries: {}, updated_at: '' },
  local: Pick<AsyncAssetTombstones, 'validateTombstoneTimestamp' | 'pathModifiedAfter'> = { validateTombstoneTimestamp: vi.fn(), pathModifiedAfter: async () => false }) {
  const files = new Map<string, Uint8Array>();
  const cloud = {
    providerName: () => 'memory', instanceBindingHint: () => 'asset-top',
    get: async (key: string) => files.get(key) ?? null,
    put: async (key: string, bytes: Uint8Array) => { files.set(key, bytes.slice()); },
    delete: vi.fn(async (key: string) => { files.delete(key); }),
    listOutcome: async (prefix: string) => ({ files: [...files].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.length })), truncated: false }),
    stat: async (key: string) => files.has(key) ? { key, size: files.get(key)!.length } : null,
    putFile: async (key: string, path: string) => { const bytes = readFileSync(path); files.set(key, bytes); return sha(bytes); },
    supportsResumableDownload: () => false,
    getFile: async (key: string, path: string, expected: string) => {
      const bytes = files.get(key)!; if (sha(bytes) !== expected) throw new Error('checksum mismatch');
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return sha(bytes);
    },
  } as unknown as CloudStorage;
  const reader: AsyncAssetTombstones = {
    downloadAssetTombstones: async () => structuredClone(tombstones),
    downloadAssetTombstonesAfter: async () => [structuredClone(tombstones), []],
    validateTombstoneTimestamp: (timestamp, label) => local.validateTombstoneTimestamp(timestamp, label),
    pathModifiedAfter: (path, timestamp) => local.pathModifiedAfter(path, timestamp),
  };
  const state = { bindInstance: vi.fn(), getTombstoneWatermark: () => 0n, setTombstoneWatermark: vi.fn() } as unknown as SyncStateStore;
  const codec = await createPayloadCodec(undefined, null);
  cleanups.push(() => codec.dispose());
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const options = { deviceId: 'victim', codec, tombstones: reader, isCancelled: () => false, openState: () => state, logger };
  const publish = async (entries: Record<string, Buffer>) => {
    const manifest = { entries: new Map<string, AssetEntry>(), updated_at: '2026-01-01T00:00:00Z' };
    for (const [key, bytes] of Object.entries(entries)) {
      const object = `data_governance/asset_objects/${sha(bytes)}`; files.set(object, bytes);
      manifest.entries.set(key, { sha256: sha(bytes), size: BigInt(bytes.length), updated_at: '2099-01-01T00:00:00Z', revision: 7n,
        object_key: object, base_sha256: null, device_id: 'attacker', cipher_sha256: null, cipher_size: null });
    }
    await publishAssetManifest(cloud, manifest, options);
  };
  return { cloud, options, logger, publish };
}
const logged = (logger: { warn: ReturnType<typeof vi.fn> }, key: string) => logger.warn.mock.calls.some(([text]) => String(text).includes(key));

it('RF-W32-asset-top-allowlist: asset keys only map into the synced asset directories', () => {
  const base = directory();
  const active = join(base, 'slots', 'slotA');
  mkdirSync(join(active, 'images'), { recursive: true });
  // Production passes the active slot for both roots (file-level-sync.ts:111).
  expect(assetLocalPath(active, active, 'active/images/a.png')).toBe(join(active, 'images', 'a.png'));
  expect(assetLocalPath(active, active, 'app_data/pdf_ocr_sessions/s/p.json')).toBe(join(active, 'pdf_ocr_sessions', 's', 'p.json'));
  for (const key of ['active/databases/vfs.db', 'active/workspaces/w.db', 'app_data/databases/vfs.db', 'active/pdf_ocr_sessions/s/p.json', 'app_data/images/a.png']) {
    expect(assetLocalPath(active, active, key), key).toBeNull();
  }
});

it('RF-W32-asset-top-allowlist: a cloud asset entry outside the synced directories does not overwrite the local database', async () => {
  // Rust mod.rs:12315 asset_local_path_from_key accepts any top directory, so active/databases/vfs.db is replaced on download.
  const server = await maliciousServer();
  const active = directory();
  const original = Buffer.from('SQLite format 3\0 genuine database');
  mkdirSync(join(active, 'databases'), { recursive: true }); writeFileSync(join(active, 'databases', 'vfs.db'), original);
  const forged = Buffer.from('SQLite format 3\0 forged database'), picture = Buffer.from('png');
  await server.publish({ 'active/databases/vfs.db': forged, 'active/images/ok.png': picture });
  const outcome = await syncAssetDirectories(server.cloud, active, active, 'Download', server.options);
  expect(readFileSync(join(active, 'databases', 'vfs.db'))).toEqual(original);
  expect(readdirSync(join(active, 'databases'))).toEqual(['vfs.db']);
  expect(readFileSync(join(active, 'images', 'ok.png'))).toEqual(picture);
  expect(outcome).toMatchObject({ downloaded: 1, download_failures: [] });
  expect(logged(server.logger, 'active/databases/vfs.db')).toBe(true);
});

it('RF-W32-asset-top-allowlist: a future-dated cloud tombstone outside the synced directories does not delete the local database', async () => {
  // Production clock-drift and local-mtime checks: deleted_at 30 s ahead passes drift validation (limit 60 s) and still
  // beats the freshly written file's mtime, so only the allowlist keeps the database.
  const host = await createTestHost(); cleanups.push(() => host.dispose());
  const support = host.ctx.syncSupport.tombstones;
  const future = new Date(Date.now() + 30_000).toISOString();
  const active = directory();
  const original = Buffer.from('SQLite format 3\0 genuine database');
  mkdirSync(join(active, 'databases'), { recursive: true }); writeFileSync(join(active, 'databases', 'vfs.db'), original);
  mkdirSync(join(active, 'images'), { recursive: true }); writeFileSync(join(active, 'images', 'gone.png'), 'x');
  const server = await maliciousServer({ updated_at: future, entries: {
    'active/databases/vfs.db': { deleted_at: future, device_id: 'attacker', size: null },
    'active/images/gone.png': { deleted_at: future, device_id: 'attacker', size: null },
  } } as unknown as AssetTombstones, {
    validateTombstoneTimestamp: (timestamp, label) => support.validateTombstoneTimestamp(timestamp, label),
    pathModifiedAfter: (path, timestamp) => support.pathModifiedAfter(path, timestamp),
  });
  await syncAssetsWithTombstones(server.cloud, active, active, 'Download', server.options);
  expect(readFileSync(join(active, 'databases', 'vfs.db'))).toEqual(original);
  expect(readdirSync(join(active, 'databases'))).toEqual(['vfs.db']);
  expect(existsSync(join(active, 'images', 'gone.png'))).toBe(false);
  expect(logged(server.logger, 'active/databases/vfs.db')).toBe(true);
});

it('RF-W32-asset-top-allowlist: unsynced diagnostics report keys outside the synced directories as invalid', () => {
  const active = directory();
  const entry = (sha256: string): AssetEntry => ({ sha256, size: 1n, updated_at: '2026-08-24T00:00:00Z', cipher_sha256: null, revision: 0n });
  const manifest = { updated_at: '', entries: new Map([
    ['active/databases/vfs.db', entry('a')], ['app_data/images/x.png', entry('b')], ['active/pdf_ocr_sessions/s.json', entry('c')],
    ['active/images/ok.png', entry('d')], ['app_data/pdf_ocr_sessions/s.json', entry('e')],
  ]) };
  const kinds = Object.fromEntries(classifyAssets(manifest, active, active, false).map(item => [item.key, item.kind]));
  expect(kinds).toEqual({
    'active/databases/vfs.db': 'invalidKey', 'app_data/images/x.png': 'invalidKey', 'active/pdf_ocr_sessions/s.json': 'invalidKey',
    'active/images/ok.png': 'downloadPending', 'app_data/pdf_ocr_sessions/s.json': 'downloadPending',
  });
});
