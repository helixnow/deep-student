import './local-runtime-fixture.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { deviceIdShortHash, type CloudStorage } from '../../sync-providers/api.ts';
import type { SyncStateStore } from '../../sync-support/api.ts';
import { createPayloadCodec } from '../src/payload.ts';
import { syncWorkspaceDatabases, type WorkspaceSyncOptions } from '../src/workspace-sync.ts';
import { downloadWorkspacesManifest, publishWorkspaceManifest, WORKSPACE_MANIFEST_PREFIX } from '../src/workspace-manifest.ts';

const dirs: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), 'sync-workspaces-')); dirs.push(root); return root; }
afterEach(() => { for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const real = createBackupCrypto();
const backup = { ...real, createFileCipherSession: (pw: string) => real.createFileCipherSession(pw, { mCost: 8, tCost: 1, pCost: 1 }) };
class MemoryCloud {
  files = new Map<string, Uint8Array>();
  truncate = false;
  providerName = () => 'memory'; instanceBindingHint = () => 'workspace-tests';
  get = async (key: string) => this.files.get(key) ?? null;
  put = async (key: string, bytes: Uint8Array) => { this.files.set(key, bytes.slice()); };
  delete = async (key: string) => { this.files.delete(key); };
  listOutcome = async (prefix: string) => ({ files: [...this.files].filter(([key]) => key.startsWith(prefix))
    .map(([key, bytes]) => ({ key, size: bytes.length, lastModified: '2026-01-01T00:00:00Z' })), truncated: false });
  stat = async (key: string) => this.files.has(key) ? { key, size: this.files.get(key)!.length } : null;
  putFile = async (key: string, path: string) => { const bytes = readFileSync(path); await this.put(key, this.truncate ? bytes.subarray(0, bytes.length - 1) : bytes); return hash(bytes); };
  getFile = async (key: string, path: string, expected?: string | null) => {
    const bytes = this.files.get(key)!; expect(hash(bytes)).toBe(expected);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return hash(bytes);
  };
  supportsResumableDownload = () => false;
  storage() { return this as unknown as CloudStorage; }
}
async function options(deviceId: string, password: string | null): Promise<WorkspaceSyncOptions> {
  const root = directory();
  return {
    deviceId, codec: await createPayloadCodec(backup, password),
    localStorage: createStorageService({ baseDir: root, dataLocalDir: root }),
    openState: () => ({ bindInstance: vi.fn(), getTombstoneWatermark: () => 0n, setTombstoneWatermark: vi.fn() }) as unknown as SyncStateStore,
    tombstones: {
      downloadWorkspaceTombstones: async () => ({ entries: {}, updated_at: '' }),
      downloadWorkspaceTombstonesAfter: async () => [{ entries: {}, updated_at: '' }, []],
      validateTombstoneTimestamp: vi.fn(), pathModifiedAfter: () => false,
    },
    isCancelled: () => false,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}
function createDatabase(root: string, id: string, content: string, opts: WorkspaceSyncOptions) {
  const path = join(root, 'workspaces', `${id}.db`); mkdirSync(dirname(path), { recursive: true });
  const db = opts.localStorage.openFile(path);
  try { db.exec('CREATE TABLE notes(id TEXT PRIMARY KEY, content TEXT)'); db.run("INSERT INTO notes VALUES ('n1', ?)", [content]); }
  finally { opts.localStorage.close(db); }
  return path;
}
function readNote(root: string, id: string, opts: WorkspaceSyncOptions) {
  const db = opts.localStorage.openFile(join(root, 'workspaces', `${id}.db`));
  try { return db.pluck("SELECT content FROM notes WHERE id='n1'"); } finally { opts.localStorage.close(db); }
}

it('workspace_upload_fails_when_remote_object_size_mismatches', async () => {
  const cloud = new MemoryCloud(); cloud.truncate = true; const a = await options('a', 'pw'); const root = directory();
  createDatabase(root, 'ws_size_mismatch', 'must-not-publish', a);
  try {
    await expect(syncWorkspaceDatabases(cloud.storage(), root, 'Upload', a)).rejects.toThrow('上传后大小不一致或对象不存在');
    expect((await downloadWorkspacesManifest(cloud.storage(), a)).entries.has('ws_size_mismatch')).toBe(false);
  } finally { a.codec.dispose(); }
});

it('regression_c8_upload_path_verifies_size: file manifests also require byte readback', async () => {
  const cloud = new MemoryCloud(), a = await options('file-manifest-readback', null), root = directory();
  createDatabase(root, 'ws_verify', 'verified manifest', a);
  const get = cloud.get;
  cloud.get = async key => {
    const bytes = await get(key);
    if (bytes !== null && key.startsWith(WORKSPACE_MANIFEST_PREFIX)) { const wrong = Uint8Array.from(bytes); wrong[0]! ^= 255; return wrong; }
    return bytes;
  };
  try { await expect(syncWorkspaceDatabases(cloud.storage(), root, 'Upload', a)).rejects.toThrow('文件级工作区清单 上传后回读不一致'); }
  finally { a.codec.dispose(); }
});

it.each([
  ['file_e2ee_workspace_roundtrip_between_encrypted_devices', 'shared-pw', 'encrypted note'],
  ['file_e2ee_workspace_plaintext_mode_unaffected', null, 'plain note'],
])('%s', async (_name, password, content) => {
  const cloud = new MemoryCloud(); const a = await options('device-a', password); const b = await options('device-b', password);
  const dirA = directory(), dirB = directory(); createDatabase(dirA, 'ws_e2ee_rt', content!, a);
  try {
    await syncWorkspaceDatabases(cloud.storage(), dirA, 'Upload', a);
    const objects = [...cloud.files].filter(([key]) => key.startsWith('data_governance/workspaces/'));
    expect(objects).toHaveLength(1); const [key, bytes] = objects[0]!;
    expect(real.isEncryptedBackup(bytes)).toBe(password !== null);
    const entry = (await downloadWorkspacesManifest(cloud.storage(), a)).entries.get('ws_e2ee_rt')!;
    expect(entry.cipher_sha256).toBe(password === null ? null : hash(bytes));
    expect(entry.cipher_size).toBe(password === null ? null : BigInt(bytes.length));
    expect(key).toContain(entry.sha256);
    if (password !== null) expect(entry.cipher_sha256).not.toBe(entry.sha256);
    await syncWorkspaceDatabases(cloud.storage(), dirB, 'Download', b);
    expect(readNote(dirB, 'ws_e2ee_rt', b)).toBe(content);
  } finally { a.codec.dispose(); b.codec.dispose(); }
});

it.each([true, false])('workspace tombstone awaits an asynchronous pathModifiedAfter (resolves %s)', async modified => {
  const cloud = new MemoryCloud(); const a = await options('tombstone-await', null); const root = directory();
  const path = createDatabase(root, 'ws_tombstone_await', 'local note', a);
  const asked: string[] = [];
  a.tombstones = { ...a.tombstones,
    downloadWorkspaceTombstonesAfter: async () => [{ entries: { ws_tombstone_await: { deleted_at: '2026-01-01T00:00:00Z', device_id: 'other' } }, updated_at: '' }, []],
    pathModifiedAfter: async (target: string) => { asked.push(target); return modified; } };
  try {
    await syncWorkspaceDatabases(cloud.storage(), root, 'Download', a);
    expect(asked).toEqual([path]);
    expect(existsSync(path)).toBe(modified);
  } finally { a.codec.dispose(); }
});

it('file_manifest_publish_uses_neutral_object_name', async () => {
  const cloud = new MemoryCloud(); const a = await options('r12-file-manifest-device', null); const root = directory();
  createDatabase(root, 'ws_r12_names', 'hashed path note', a);
  try {
    await syncWorkspaceDatabases(cloud.storage(), root, 'Upload', a);
    const key = [...cloud.files.keys()].find(key => key.startsWith(`${WORKSPACE_MANIFEST_PREFIX}/`))!;
    expect(key).toMatch(/\/[0-9a-f-]{36}\.json$/u);
    expect(key).not.toContain(a.deviceId); expect(key).not.toContain(deviceIdShortHash(a.deviceId));
    expect(key.split('/').at(-1)).not.toMatch(/^\d{13}/u);
  } finally { a.codec.dispose(); }
});

it('file_manifest_download_reads_legacy_raw_device_dir', async () => {
  const cloud = new MemoryCloud(); const a = await options('reader', null);
  await cloud.put(`${WORKSPACE_MANIFEST_PREFIX}/device-legacy-raw/1-seed.json`, Buffer.from(JSON.stringify({ entries: {
    ws_legacy_name: { sha256: 'aa'.repeat(32), size: 1, updated_at: '2026-08-01T00:00:00Z', device_id: 'device-legacy-raw', revision: 1 },
  }, updated_at: '2026-08-01T00:00:00Z' })));
  try { expect((await downloadWorkspacesManifest(cloud.storage(), a)).entries.has('ws_legacy_name')).toBe(true); }
  finally { a.codec.dispose(); }
});

async function legacy(cloud: MemoryCloud, a: WorkspaceSyncOptions, root: string, id: string, content: string) {
  const path = createDatabase(root, id, content, a); const bytes = readFileSync(path); const sha256 = hash(bytes);
  const key = `data_governance/workspaces/${id}/${sha256}.db`; await cloud.put(key, bytes);
  await publishWorkspaceManifest(cloud.storage(), { entries: new Map([[id, {
    sha256, size: BigInt(bytes.length), updated_at: '2026-01-01T00:00:00Z', source_sha256: sha256,
    object_key: key, device_id: 'legacy', base_sha256: null, revision: 1n, cipher_sha256: null, cipher_size: null,
  }]]), updated_at: '' }, a);
}
it('file_e2ee_workspace_rejects_legacy_plaintext_entry', async () => {
  const cloud = new MemoryCloud(); const a = await options('seed', 'shared-pw'); const dest = directory();
  try {
    await legacy(cloud, a, directory(), 'ws_legacy', 'legacy plaintext note');
    const error = await syncWorkspaceDatabases(cloud.storage(), dest, 'Download', a).catch(e => e as Error);
    expect(error).toBeInstanceOf(Error);
    for (const text of ['E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED', 'cipher_sha256', '拒绝下载', '加密密码']) expect((error as Error).message).toContain(text);
    expect(existsSync(join(dest, 'workspaces/ws_legacy.db'))).toBe(false);
  } finally { a.codec.dispose(); }
});
it('file_e2ee_workspace_migrates_legacy_plaintext_entry_on_upload', async () => {
  const cloud = new MemoryCloud(); const a = await options('migrator', 'shared-pw'); const b = await options('reader', 'shared-pw');
  const source = directory(), dest = directory();
  try {
    await legacy(cloud, a, source, 'ws_migrate', 'note to migrate');
    await syncWorkspaceDatabases(cloud.storage(), source, 'Upload', a);
    const entry = (await downloadWorkspacesManifest(cloud.storage(), a)).entries.get('ws_migrate')!;
    expect(entry.cipher_sha256).not.toBeNull(); expect(real.isEncryptedBackup(cloud.files.get(entry.object_key!)!)).toBe(true);
    await syncWorkspaceDatabases(cloud.storage(), dest, 'Download', b);
    expect(readNote(dest, 'ws_migrate', b)).toBe('note to migrate');
  } finally { a.codec.dispose(); b.codec.dispose(); }
});
