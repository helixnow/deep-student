import './local-fs-fixture.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudStorage, FileInfo, ListOutcome } from '../api.ts';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import { DSBK_V2_HEADER_LEN } from '../../../platform/secrets/backup-crypto.ts';
import { CloudStorageBase } from '../src/traits.ts';
import { chronoAutoSiZ } from '../src/time.ts';
import { deviceIdShortHash } from '../src/device_id.ts';
import {
  BACKUPS_DIR,
  CloudSyncManager,
  ENCRYPTION_MARKER_FILE,
  ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
  MANIFESTS_DIR,
} from '../src/sync_manager.ts';
import {
  decodeManifest,
  encodeManifest,
  generateNeutralVersionId,
  NEUTRAL_VERSION_ID_LEN,
  type CloudManifest,
} from '../src/manifest.ts';
import { ENCRYPTION_MARKER_LEASE_SUFFIX, SYNC_E2EE_CLAIM_CONFLICT_CODE } from '../src/e2ee_claim.ts';
import { VERIFIED_PUBLISH_MISMATCH_CODE } from '../src/verified_publish.ts';
import {
  SYNC_E2EE_MARKER_CORRUPTED_CODE,
  SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
} from '../src/mod.ts';
import { MemoryStorage } from './memory_storage.ts';
import { createNativeBackupHost, type NativeBackupHost } from './native_backup_host.ts';

let fixture: NativeBackupHost | undefined;
let backup: BackupCrypto;
const tempDirs: string[] = [];

beforeAll(async () => {
  fixture = await createNativeBackupHost();
  backup = fixture.backup;
});

afterAll(async () => {
  await fixture?.host.dispose();
});

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sync-manager-'));
  tempDirs.push(dir);
  return dir;
}

async function writeTemp(name: string, data: Uint8Array | string): Promise<string> {
  const dir = await tempDir();
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

function managerOn(storage: CloudStorage, deviceId: string): CloudSyncManager {
  return new CloudSyncManager(storage, deviceId, { backup, encryptionMemoryPath: null });
}

const leaseKey = (): string => `${ENCRYPTION_MARKER_FILE}${ENCRYPTION_MARKER_LEASE_SUFFIX}`;

function leaseBytes(device: string, expiresInSeconds: number): Uint8Array {
  const now = Date.now();
  return Buffer.from(JSON.stringify({
    format_version: 1,
    device_id: device,
    nonce: randomUUID(),
    created_at: chronoAutoSiZ(now),
    expires_at: chronoAutoSiZ(now + expiresInSeconds * 1000),
  }, null, 2), 'utf8');
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) { return error as Error; }
  throw new Error('expected the operation to fail');
}

function hasBackupObject(storage: MemoryStorage): boolean {
  return storage.keys().some(key => key.startsWith(BACKUPS_DIR));
}

/** Counts prefix reads and full `get` calls on `backups/` objects. */
class PrefixReadStorage extends CloudStorageBase {
  readonly inner = new MemoryStorage();
  prefixReads: Array<[string, number]> = [];
  fullBackupGets: string[] = [];

  override providerName(): string { return 'memory-prefix-read'; }
  override async checkConnection(): Promise<void> { await this.inner.checkConnection(); }
  override async put(key: string, data: Uint8Array): Promise<void> { await this.inner.put(key, data); }

  override async get(key: string): Promise<Uint8Array | null> {
    if (key.startsWith(BACKUPS_DIR)) this.fullBackupGets.push(key);
    return this.inner.get(key);
  }

  override async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> { return this.inner.getBounded(key, maxBytes); }
  override async list(prefix: string): Promise<FileInfo[]> { return this.inner.list(prefix); }
  override async listOutcome(prefix: string): Promise<ListOutcome> { return this.inner.listOutcome(prefix); }
  override async delete(key: string): Promise<void> { await this.inner.delete(key); }
  override async stat(key: string): Promise<FileInfo | null> { return this.inner.stat(key); }
  override supportsPrefixRead(): boolean { return true; }

  override async getPrefix(key: string, prefixLen: number): Promise<Uint8Array | null> {
    this.prefixReads.push([key, prefixLen]);
    const data = this.inner.bytes(key);
    return data === null ? null : data.subarray(0, Math.min(prefixLen, data.byteLength));
  }

  resetCounters(): void { this.prefixReads = []; this.fullBackupGets = []; }
  object(key: string): Uint8Array { return this.inner.bytes(key)!; }
  objectLen(key: string): number { return this.object(key).byteLength; }
  putRaw(key: string, data: Uint8Array): void { this.inner.putAt(key, data, Date.now()); }
}

/** Seeds a DSBK v2 backup through the real upload pipeline; returns its version id. */
async function seedV2Backup(storage: PrefixReadStorage, password: string, payload: Uint8Array): Promise<string> {
  const dir = await tempDir();
  const plain = join(dir, 'backup.zip');
  const sealed = join(dir, 'backup.zip.dsbk');
  await writeFile(plain, payload);
  const session = await backup.createFileCipherSession(password, { mCost: 8, tCost: 1, pCost: 1 });
  try { await session.encryptFile(plain, sealed); }
  finally { session.dispose(); }
  const uploaded = await managerOn(storage, 'device-seeder').upload(sealed, '1.0.0', null, null);
  return uploaded.version.id;
}

/** Corrupts specific keys on write. */
class CorruptingStorage extends CloudStorageBase {
  private readonly inner: MemoryStorage;
  private readonly corrupt: (key: string, data: Uint8Array) => Uint8Array | null;

  constructor(
    inner: MemoryStorage,
    corrupt: (key: string, data: Uint8Array) => Uint8Array | null,
  ) { super();
    this.inner = inner;
    this.corrupt = corrupt; }

  override providerName(): string { return 'memory-corrupting'; }
  override async checkConnection(): Promise<void> { await this.inner.checkConnection(); }

  override async put(key: string, data: Uint8Array): Promise<void> {
    const replacement = this.corrupt(key, data);
    await this.inner.put(key, replacement ?? data);
  }

  override async get(key: string): Promise<Uint8Array | null> { return this.inner.get(key); }
  override async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> { return this.inner.getBounded(key, maxBytes); }
  override async list(prefix: string): Promise<FileInfo[]> { return this.inner.list(prefix); }
  override async listOutcome(prefix: string): Promise<ListOutcome> { return this.inner.listOutcome(prefix); }
  override async delete(key: string): Promise<void> { await this.inner.delete(key); }
  override async stat(key: string): Promise<FileInfo | null> { return this.inner.stat(key); }
}

describe('sync_manager.rs', () => {
  // ================== [R5-prove-cost] prove 首块降本 ==================

  it('prove_uses_first_chunk_without_full_download_for_v2', async () => {
    const storage = new PrefixReadStorage();
    await managerOn(storage, 'device-legacy').persistEncryptionMarker();
    const versionId = await seedV2Backup(storage, 'team-pw-2026', new Uint8Array(2 * 1024 * 1024 + 123).fill(7));
    storage.resetCounters();

    const manager = managerOn(storage, 'device-a');
    const upgraded = await manager.verifyEncryptionPasswordBeforeUpload('team-pw-2026');
    expect(upgraded.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(upgraded.keyVerifier).toBeTruthy();

    expect(storage.prefixReads.length).toBeGreaterThanOrEqual(1);
    expect(storage.fullBackupGets).toEqual([]);
    const objectLen = storage.objectLen(`${BACKUPS_DIR}/${versionId}.zip`);
    for (const [key, len] of storage.prefixReads) {
      expect(key.endsWith(`${versionId}.zip`)).toBe(true);
      expect(len).toBeLessThan(objectLen);
    }
  });

  it('prove_first_chunk_keeps_a_manifest_size_beyond_2_53_exact', async () => {
    // Rust passes `version.size: u64` straight to the first-chunk trial; a size above
    // 2^53 must not be rounded or rejected at a Number boundary on the way.
    const storage = new PrefixReadStorage();
    await managerOn(storage, 'device-legacy').persistEncryptionMarker();
    const versionId = await seedV2Backup(storage, 'team-pw-2026', new Uint8Array(2 * 1024 * 1024 + 123).fill(7));
    const hugeSize = 9_007_199_254_740_993n;
    for (const file of await storage.list('')) {
      if (!file.key.startsWith('manifest')) continue;
      const manifest = decodeManifest(file.key, (await storage.get(file.key))!);
      const target = manifest.versions.find(version => version.id === versionId);
      if (target === undefined) continue;
      target.size = hugeSize;
      await storage.put(file.key, Buffer.from(encodeManifest(manifest)));
    }
    storage.resetCounters();

    const manager = managerOn(storage, 'device-a');
    expect((await manager.getManifest()).versions.find(version => version.id === versionId)?.size).toBe(hugeSize);
    const upgraded = await manager.verifyEncryptionPasswordBeforeUpload('team-pw-2026');
    expect(upgraded.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(storage.fullBackupGets).toEqual([]);
    expect(storage.prefixReads.length).toBeGreaterThanOrEqual(1);
  });

  it('prove_wrong_password_fails_fast_on_first_chunk', async () => {
    const storage = new PrefixReadStorage();
    await managerOn(storage, 'device-legacy').persistEncryptionMarker();
    const versionId = await seedV2Backup(storage, 'team-pw-2026', new Uint8Array(2 * 1024 * 1024).fill(9));
    storage.resetCounters();

    const manager = managerOn(storage, 'device-mistaken');
    const error = await failure(manager.verifyEncryptionPasswordBeforeUpload('wrong-pw-2026'));
    expect(error.message).toContain(SYNC_E2EE_WRONG_PASSWORD_CODE);
    expect(error.message).toContain('试解');
    expect(error.message).toContain('未通过');
    expect(error.message).toContain(versionId);
    expect(storage.fullBackupGets).toEqual([]);
    const marker = (await manager.readEncryptionMarker())!;
    expect(marker.version).toBe(1);
    expect(marker.keyVerifier ?? null).toBeNull();
  });

  it('prove_falls_back_to_second_newest_when_latest_corrupt', async () => {
    const storage = new PrefixReadStorage();
    await managerOn(storage, 'device-legacy').persistEncryptionMarker();
    const older = await seedV2Backup(storage, 'team-pw-2026', Buffer.from('older intact backup'));
    const newest = await seedV2Backup(storage, 'team-pw-2026', Buffer.from('newest to corrupt'));
    expect(older).not.toBe(newest);

    const newestKey = `${BACKUPS_DIR}/${newest}.zip`;
    const bytes = storage.object(newestKey);
    bytes[DSBK_V2_HEADER_LEN + 1] = (bytes[DSBK_V2_HEADER_LEN + 1] ?? 0) ^ 0xff;
    storage.putRaw(newestKey, bytes);
    storage.resetCounters();

    const manager = managerOn(storage, 'device-a');
    const upgraded = await manager.verifyEncryptionPasswordBeforeUpload('team-pw-2026');
    expect(upgraded.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(storage.prefixReads.length).toBeGreaterThanOrEqual(2);
    expect(storage.fullBackupGets).toEqual([]);
    expect(storage.prefixReads.some(([key]) => key.includes(older))).toBe(true);
  });

  it('prove_v1_container_still_proves_via_whole_file', async () => {
    const storage = new PrefixReadStorage();
    await managerOn(storage, 'device-legacy').persistEncryptionMarker();
    const sealed = await writeTemp('legacy.dsbk', await backup.encryptBackup(Buffer.from('legacy v1 payload'), 'team-pw-2026'));
    await managerOn(storage, 'device-seeder').upload(sealed, '0.9.44', null, null);
    storage.resetCounters();

    const manager = managerOn(storage, 'device-a');
    const upgraded = await manager.verifyEncryptionPasswordBeforeUpload('team-pw-2026');
    expect(upgraded.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(storage.prefixReads.length).toBeGreaterThanOrEqual(1);
    expect(storage.fullBackupGets.length).toBeGreaterThanOrEqual(1);
  });

  it('prove_plain_zip_detected_from_prefix_without_full_download', async () => {
    const storage = new PrefixReadStorage();
    const plainZip = await writeTemp('legacy.zip', Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('legacy plaintext zip payload')]));
    await managerOn(storage, 'device-legacy').upload(plainZip, '0.9.44', null, null);
    storage.resetCounters();

    const manager = managerOn(storage, 'device-upgraded');
    const marker = await manager.verifyEncryptionPasswordBeforeUpload('new-e2ee-pw');
    expect(marker.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(storage.prefixReads.length).toBeGreaterThanOrEqual(1);
    expect(storage.fullBackupGets).toEqual([]);
  });

  it('prove_non_default_chunk_triggers_precise_topup_read', async () => {
    const storage = new PrefixReadStorage();
    await managerOn(storage, 'device-legacy').persistEncryptionMarker();

    const object = Buffer.alloc(DSBK_V2_HEADER_LEN + 5 * 1024 * 1024, 0xa5);
    object.write('DSBK', 0, 'latin1');
    object[4] = 2;
    object.writeUInt32LE(8, 5);
    object.writeUInt32LE(1, 9);
    object.writeUInt32LE(1, 13);
    object.fill(0, 17, 33);
    object.fill(0, 33, 40);
    object.writeUInt32LE(4 * 1024 * 1024, 40);
    const foreign = await writeTemp('foreign.dsbk', object);
    await managerOn(storage, 'device-seeder').upload(foreign, null, null, null);
    storage.resetCounters();

    const manager = managerOn(storage, 'device-a');
    const error = await failure(manager.verifyEncryptionPasswordBeforeUpload('any-pw'));
    expect(error.message).toContain('未通过');
    expect(storage.prefixReads.length).toBeGreaterThanOrEqual(2);
    expect(storage.fullBackupGets).toEqual([]);
  });

  // ================== 加密策略 ==================

  it('plaintext_upload_allowed_without_marker', async () => {
    const storage = new MemoryStorage();
    const manager = managerOn(storage, 'device-a');
    expect(await manager.readEncryptionMarker()).toBeNull();
    await manager.enforceEncryptionPolicyBeforeUpload(false);
  });

  it('plaintext_upload_rejected_when_marker_present', async () => {
    const storage = new MemoryStorage();
    await managerOn(storage, 'device-a').persistEncryptionMarker();

    const manager = managerOn(storage, 'device-b');
    const error = await failure(manager.enforceEncryptionPolicyBeforeUpload(false));
    expect(error.message).toContain(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE);
    expect(error.message).toContain('加密');
    expect(hasBackupObject(storage)).toBe(false);
    const marker = (await manager.readEncryptionMarker())!;
    expect(marker.createdByDevice).toBe(deviceIdShortHash('device-a'));
  });

  it('encrypted_upload_succeeds_and_keeps_marker', async () => {
    const storage = new MemoryStorage();
    const manager = managerOn(storage, 'device-a');

    await manager.enforceEncryptionPolicyBeforeUploadWithPassword('pw-2026');
    const first = (await manager.readEncryptionMarker())!;
    expect(first.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(first.createdByDevice).toBe(deviceIdShortHash('device-a'));
    expect(first.keyVerifier).toBeTruthy();

    const zip = await writeTemp('backup.dsbk', Buffer.from('DSBK pretend-encrypted payload'));
    const result = await manager.upload(zip, '1.0.0', null, null);
    expect(result.version.deviceId).toBe('device-a');

    await manager.enforceEncryptionPolicyBeforeUploadWithPassword('pw-2026');
    const second = (await manager.readEncryptionMarker())!;
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.createdByDevice).toBe(first.createdByDevice);
    expect(second.keyVerifier).toEqual(first.keyVerifier);
  });

  it('wrong_password_upload_rejected_before_any_backup_write', async () => {
    const storage = new MemoryStorage();
    const deviceA = managerOn(storage, 'device-a');
    await deviceA.enforceEncryptionPolicyBeforeUploadWithPassword('correct-pw');
    const original = (await deviceA.readEncryptionMarker())!;

    const deviceB = managerOn(storage, 'device-b');
    const error = await failure(deviceB.enforceEncryptionPolicyBeforeUploadWithPassword('wrong-pw'));
    expect(error.message).toContain('不一致');
    expect(hasBackupObject(storage)).toBe(false);
    const after = (await deviceB.readEncryptionMarker())!;
    expect(after.createdByDevice).toBe(original.createdByDevice);
    expect(after.keyVerifier).toEqual(original.keyVerifier);
  });

  it('legacy_marker_without_verifier_is_upgraded_once', async () => {
    const storage = new MemoryStorage();
    const legacy = await managerOn(storage, 'device-legacy').persistEncryptionMarker();
    expect(legacy.version).toBe(1);
    expect(legacy.keyVerifier ?? null).toBeNull();

    const deviceA = managerOn(storage, 'device-a');
    const upgraded = await deviceA.verifyEncryptionPasswordBeforeUpload('team-pw');
    expect(upgraded.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(upgraded.createdByDevice).toBe(deviceIdShortHash('device-legacy'));
    expect(upgraded.createdAt).toBe(legacy.createdAt);
    expect(upgraded.keyVerifier).toBeTruthy();

    await deviceA.verifyEncryptionPasswordBeforeUpload('team-pw');
    const deviceB = managerOn(storage, 'device-b');
    expect(await failure(deviceB.verifyEncryptionPasswordBeforeUpload('other-pw'))).toBeInstanceOf(Error);
  });

  it('first_claim_blocked_by_foreign_live_lease', async () => {
    const storage = new MemoryStorage();
    await storage.put(leaseKey(), leaseBytes('device-other', 60));

    const manager = managerOn(storage, 'device-b');
    const error = await failure(manager.verifyEncryptionPasswordBeforeUpload('pw-b'));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(storage.bytes(ENCRYPTION_MARKER_FILE)).toBeNull();
    expect(hasBackupObject(storage)).toBe(false);
  });

  it('expired_foreign_lease_reclaimed_then_claim_succeeds', async () => {
    const storage = new MemoryStorage();
    await storage.put(leaseKey(), leaseBytes('device-crashed', -5));

    const manager = managerOn(storage, 'device-b');
    const marker = await manager.verifyEncryptionPasswordBeforeUpload('pw-b');
    expect(marker.version).toBe(ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    expect(storage.bytes(ENCRYPTION_MARKER_FILE)).not.toBeNull();
    expect(storage.bytes(leaseKey())).toBeNull();
  });

  it('v1_upgrade_blocked_by_foreign_live_lease', async () => {
    const storage = new MemoryStorage();
    await managerOn(storage, 'device-legacy').persistEncryptionMarker();
    const v1Bytes = storage.bytes(ENCRYPTION_MARKER_FILE)!;
    await storage.put(leaseKey(), leaseBytes('device-other', 60));

    const manager = managerOn(storage, 'device-b');
    const error = await failure(manager.verifyEncryptionPasswordBeforeUpload('pw-b'));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(Buffer.from(storage.bytes(ENCRYPTION_MARKER_FILE)!).equals(Buffer.from(v1Bytes))).toBe(true);
  });

  it('publish_recheck_rejects_marker_swapped_between_verify_and_publish', async () => {
    const storage = new MemoryStorage();
    const manager = managerOn(storage, 'device-a');
    await manager.enforceEncryptionPolicyBeforeUploadWithPassword('pw-a');

    await storage.put(ENCRYPTION_MARKER_FILE, Buffer.from('{"version":2,"createdByDevice":"other"}'));

    const zip = await writeTemp('backup.dsbk', Buffer.from('DSBK pretend-encrypted payload'));
    const error = await failure(manager.upload(zip, null, null, null));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(hasBackupObject(storage)).toBe(false);
    expect(storage.keys().some(key => key.startsWith(MANIFESTS_DIR))).toBe(false);
  });

  it('oversized_marker_fails_closed_for_both_upload_paths', async () => {
    const storage = new MemoryStorage();
    await storage.put(ENCRYPTION_MARKER_FILE, new Uint8Array(64 * 1024 + 1).fill(0x78));

    const manager = managerOn(storage, 'device-a');
    const error = await failure(manager.verifyEncryptionPasswordBeforeUpload('pw'));
    expect(error.message).toContain(SYNC_E2EE_MARKER_CORRUPTED_CODE);
    expect(await failure(manager.ensurePlaintextUploadAllowed())).toBeInstanceOf(Error);
  });

  it('concurrent_two_password_claims_never_both_succeed', async () => {
    for (const round of [0, 1, 2]) {
      const storage = new MemoryStorage();
      const claimWith = (device: string, password: string): Promise<boolean> =>
        managerOn(storage, device).verifyEncryptionPasswordBeforeUpload(password)
          .then(() => true).catch(() => false);

      const [okA, okB] = await Promise.all([
        claimWith('device-a', 'pw-alpha-2026'),
        claimWith('device-b', 'pw-beta-2026'),
      ]);
      expect(okA && okB, `第 ${round} 轮：并发认领不得双成功`).toBe(false);

      const markerRaw = storage.bytes(ENCRYPTION_MARKER_FILE);
      if (okA || okB) {
        expect(markerRaw, `第 ${round} 轮`).not.toBeNull();
        const marker = JSON.parse(Buffer.from(markerRaw!).toString('utf8')) as { keyVerifier: Parameters<typeof backup.checkPasswordVerifier>[1] };
        const winner = okA ? 'pw-alpha-2026' : 'pw-beta-2026';
        const loser = okA ? 'pw-beta-2026' : 'pw-alpha-2026';
        expect(await backup.checkPasswordVerifier(winner, marker.keyVerifier), `第 ${round} 轮赢家`).toBe(true);
        expect(await backup.checkPasswordVerifier(loser, marker.keyVerifier), `第 ${round} 轮输家`).toBe(false);
      } else if (markerRaw !== null) {
        const marker = JSON.parse(Buffer.from(markerRaw).toString('utf8')) as { keyVerifier: Parameters<typeof backup.checkPasswordVerifier>[1] };
        const alpha = await backup.checkPasswordVerifier('pw-alpha-2026', marker.keyVerifier);
        const beta = await backup.checkPasswordVerifier('pw-beta-2026', marker.keyVerifier);
        expect(alpha !== beta, `第 ${round} 轮：双失败留下的标记必须恰好绑定一个口令`).toBe(true);
      }
    }
  });

  it('corrupted_marker_blocks_encrypted_upload', async () => {
    const storage = new MemoryStorage();
    await storage.put(ENCRYPTION_MARKER_FILE, Buffer.from('not-json'));

    const manager = managerOn(storage, 'device-a');
    const error = await failure(manager.enforceEncryptionPolicyBeforeUploadWithPassword('pw'));
    expect(error.message).toContain('损坏');
    expect(storage.text(ENCRYPTION_MARKER_FILE)).toBe('not-json');
  });

  it('persist_encryption_marker_fails_when_reread_mismatches', async () => {
    const inner = new MemoryStorage();
    const storage = new CorruptingStorage(inner, key =>
      key === ENCRYPTION_MARKER_FILE ? Buffer.from('corrupted-encryption-marker') : null);
    const manager = managerOn(storage, 'device-marker-reread');
    const error = await failure(manager.persistEncryptionMarker());
    expect(error.message).toContain('加密标记上传后回读不一致');
    expect(inner.text(ENCRYPTION_MARKER_FILE)).toBe('corrupted-encryption-marker');
  });

  it('persist_encryption_marker_fails_when_missing_after_put', async () => {
    const inner = new MemoryStorage();
    // Swallow the marker write entirely.
    const vanishing = new (class extends CloudStorageBase {
      override providerName(): string { return 'memory-vanish-marker'; }
      override async checkConnection(): Promise<void> { await inner.checkConnection(); }
      override async put(key: string, data: Uint8Array): Promise<void> {
        if (key === ENCRYPTION_MARKER_FILE) return;
        await inner.put(key, data);
      }
      override async get(key: string) { return inner.get(key); }
      override async getBounded(key: string, maxBytes: number) { return inner.getBounded(key, maxBytes); }
      override async list(prefix: string) { return inner.list(prefix); }
      override async listOutcome(prefix: string) { return inner.listOutcome(prefix); }
      override async delete(key: string) { await inner.delete(key); }
      override async stat(key: string) { return inner.stat(key); }
    })();
    const manager = managerOn(vanishing, 'device-marker-missing');
    const error = await failure(manager.persistEncryptionMarker());
    expect(error.message).toContain('加密标记上传后对象不存在');
    expect(inner.bytes(ENCRYPTION_MARKER_FILE)).toBeNull();
  });

  it('unknown_verifier_kdf_fails_closed', async () => {
    const storage = new MemoryStorage();
    const marker = {
      version: ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
      createdByDevice: 'device-future',
      createdAt: chronoAutoSiZ(Date.now()),
      keyVerifier: {
        kdf: 'quantum-kdf-9000', mCost: 65536, tCost: 3, pCost: 4,
        salt: '00112233445566778899aabbccddeeff', digest: '00'.repeat(32),
      },
    };
    await storage.put(ENCRYPTION_MARKER_FILE, Buffer.from(JSON.stringify(marker)));

    const manager = managerOn(storage, 'device-a');
    const error = await failure(manager.verifyEncryptionPasswordBeforeUpload('pw'));
    expect(error.message).toContain('无法校验');
    const after = (await manager.readEncryptionMarker())!;
    expect(after.createdByDevice).toBe('device-future');
  });

  it('v2_marker_missing_verifier_fails_closed', async () => {
    const storage = new MemoryStorage();
    await storage.put(ENCRYPTION_MARKER_FILE, Buffer.from(JSON.stringify({
      version: ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
      createdByDevice: 'device-x',
      createdAt: chronoAutoSiZ(Date.now()),
    })));

    const manager = managerOn(storage, 'device-a');
    const error = await failure(manager.verifyEncryptionPasswordBeforeUpload('pw'));
    expect(error.message).toContain(SYNC_E2EE_MARKER_CORRUPTED_CODE);
    expect(error.message).toContain('缺少密码校验子');
  });

  it('corrupted_marker_still_blocks_plaintext_upload', async () => {
    const storage = new MemoryStorage();
    await storage.put(ENCRYPTION_MARKER_FILE, Buffer.from('not-json'));
    const manager = managerOn(storage, 'device-a');
    expect(await failure(manager.ensurePlaintextUploadAllowed())).toBeInstanceOf(Error);
  });

  it('old_backup_version_json_without_recovery_kind_still_deserializes', async () => {
    const manifest: CloudManifest = {
      version: 1,
      latest: '20260101-000000-000-abcd-1234abcd',
      versions: [{
        id: '20260101-000000-000-abcd-1234abcd',
        timestamp: '2026-01-01T00:00:00Z',
        size: 12n,
        checksum: 'a'.repeat(64),
        deviceId: 'device-a',
      }],
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const decoded = decodeManifest('manifests/x.json', Buffer.from(encodeManifest(manifest)));
    expect(decoded.versions[0]!.recoveryKind ?? null).toBeNull();
    expect(decoded.versions[0]!.deviceId).toBe('device-a');
  });

  it('mixed_manifest_keeps_old_unknown_and_new_recovery_kind', () => {
    const json = `{
      "version": 1,
      "latest": "new-id",
      "updatedAt": "2026-01-02T00:00:00Z",
      "versions": [
        {
          "id": "new-id",
          "timestamp": "2026-01-02T00:00:00Z",
          "size": 2,
          "checksum": "${'b'.repeat(64)}",
          "deviceId": "device-b",
          "recoveryKind": "partial_archive"
        },
        {
          "id": "old-id",
          "timestamp": "2026-01-01T00:00:00Z",
          "size": 1,
          "checksum": "${'a'.repeat(64)}",
          "deviceId": "device-a"
        }
      ]
    }`;
    const manifest = decodeManifest('manifests/x.json', Buffer.from(json));
    expect(manifest.versions[0]!.recoveryKind).toBe('partial_archive');
    expect(manifest.versions[1]!.recoveryKind ?? null).toBeNull();
    const encoded = encodeManifest(manifest);
    expect(encoded).toContain('recoveryKind');
    expect(encoded).toContain('partial_archive');
  });

  it('upload_persists_recovery_kind_for_list_and_status', async () => {
    const storage = new MemoryStorage();
    const manager = managerOn(storage, 'device-kind');
    const zip = await writeTemp('backup.zip', Buffer.from('zip-bytes-for-recovery-kind'));

    const uploaded = (await manager.uploadWithProgress(zip, '1.2.3', null, 'partial_archive', null)).version;
    expect(uploaded.recoveryKind).toBe('partial_archive');

    const listed = await manager.listVersions();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.recoveryKind).toBe('partial_archive');

    const status = await manager.getStatus();
    expect(status.latestVersion?.recoveryKind).toBe('partial_archive');
  });

  it('new_version_id_is_22_hex_and_not_a_timestamp', () => {
    const id = generateNeutralVersionId();
    expect(id).toHaveLength(NEUTRAL_VERSION_ID_LEN);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
    expect(id.includes('-')).toBe(false);
    expect(generateNeutralVersionId()).not.toBe(id);
  });

  it('device_manifest_key_uses_short_hash_not_raw_device_id', () => {
    const manager = managerOn(new MemoryStorage(), 'device-a');
    const internals = manager as unknown as {
      deviceManifestKey(): string;
      deviceManifestLegacyKey(): string;
    };
    expect(internals.deviceManifestKey()).toBe(`manifests/${deviceIdShortHash('device-a')}.json`);
    expect(internals.deviceManifestLegacyKey()).toBe('manifests/device-a.json');
    expect(internals.deviceManifestKey()).not.toBe(internals.deviceManifestLegacyKey());
  });

  it('upload_fails_when_remote_zip_size_mismatches', async () => {
    const inner = new MemoryStorage();
    const storage = new CorruptingStorage(inner, (key, data) =>
      key.endsWith('.zip') && data.byteLength > 0 ? data.subarray(0, data.byteLength - 1) : null);
    const manager = managerOn(storage, 'device-short-zip');
    const zip = await writeTemp('backup.zip', Buffer.from('zip-bytes-should-not-shorten'));

    const error = await failure(manager.upload(zip, '1.2.3', null, null));
    expect(error.message).toContain('云端备份对象上传后大小不一致');
    expect(hasBackupObject(inner)).toBe(false);
  });

  it('upload_fails_when_remote_zip_missing_after_put', async () => {
    const inner = new MemoryStorage();
    const vanishing = new (class extends CloudStorageBase {
      override providerName(): string { return 'memory-vanish-zip'; }
      override async checkConnection(): Promise<void> { await inner.checkConnection(); }
      override async put(key: string, data: Uint8Array): Promise<void> {
        if (key.endsWith('.zip')) return;
        await inner.put(key, data);
      }
      override async get(key: string) { return inner.get(key); }
      override async getBounded(key: string, maxBytes: number) { return inner.getBounded(key, maxBytes); }
      override async list(prefix: string) { return inner.list(prefix); }
      override async listOutcome(prefix: string) { return inner.listOutcome(prefix); }
      override async delete(key: string) { await inner.delete(key); }
      override async stat(key: string) { return inner.stat(key); }
    })();
    const manager = managerOn(vanishing, 'device-missing-zip');
    const zip = await writeTemp('backup.zip', Buffer.from('zip-bytes-should-exist-remotely'));

    const error = await failure(manager.upload(zip, '1.2.3', null, null));
    expect(error.message).toContain('云端备份对象上传后不存在');
    expect(hasBackupObject(inner)).toBe(false);
  });

  it('upload_fails_when_published_manifest_reread_mismatches', async () => {
    const inner = new MemoryStorage();
    const storage = new CorruptingStorage(inner, key =>
      key.endsWith('.json') ? Buffer.from('corrupted-manifest') : null);
    const manager = managerOn(storage, 'device-corrupt');
    const zip = await writeTemp('backup.zip', Buffer.from('zip-bytes-manifest-reread'));

    const error = await failure(manager.upload(zip, '1.2.3', null, null));
    expect(error.message).toContain(VERIFIED_PUBLISH_MISMATCH_CODE);
    expect(inner.keys().some(key => key.startsWith(BACKUPS_DIR) && key.endsWith('.zip'))).toBe(false);
    expect(inner.keys().some(key => key.includes('.tmp-'))).toBe(true);
  });

  it('upload_without_recovery_kind_stays_unknown', async () => {
    const storage = new MemoryStorage();
    const manager = managerOn(storage, 'device-unknown');
    const zip = await writeTemp('backup.zip', Buffer.from('zip-bytes-unknown-kind'));

    const uploaded = (await manager.upload(zip, '1.2.3', null, null)).version;
    expect(uploaded.recoveryKind ?? null).toBeNull();
    const listed = await manager.listVersions();
    expect(listed[0]!.recoveryKind ?? null).toBeNull();
  });
});
