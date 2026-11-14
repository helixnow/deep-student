/**
 * 移植自 `dstu-security/src/secure_store.rs` 的 `tests` 与 `cloud_hydration_tests` 模块、
 * `src-tauri/tests/secure_store_tests.rs`（安全存储部分）。Rust 的 `cfg(test)` 下平台密钥库恒为 None，
 * 这里以 `keystore: null` 构造等价环境；需要密钥库的分支用内存 FakeKeystore 注入。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log/api.ts';
import { resolveOsDirs } from '../paths/index.ts';
import { createSecretsService } from './index.ts';
import { SecureStoreError, type SeedKeystore, CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE, CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE, CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE, MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS } from './api.ts';
import {
  applyNonemptyUpdate,
  checkNewCloudEncryptionPassword,
  classifySeedContent,
  cloudEncryptionPasswordTooWeak,
  credentialStatus,
  encryptWithKey,
  MAX_BACKUP_SEED_FILE_BYTES,
  MAX_ENCRYPTED_SECRET_FILE_BYTES,
  migrateSeedToKeystore,
  resolveKeystoreSeed,
  SecureStoreImpl,
  seedFingerprint,
  type SecureStoreInternals,
} from './secure-store.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'f4-secure-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const silent: Logger = { target: 't', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const os = resolveOsDirs(process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', process.env);
const secrets = createSecretsService({ os, log: silent, keystore: null });
const storeIn = (dir: string, keystore: SeedKeystore | null = null) => secrets.openStore(dir, { keystore }) as SecureStoreImpl;
const sampleSeed = () => 'ab'.repeat(32);
const offWindows = process.platform !== 'win32';

class FakeKeystore implements SeedKeystore {
  readonly backendName = 'FakeKeystore';
  entries = new Map<string, string>();
  private readonly opts: { failStore?: boolean; failLoad?: boolean; corruptReadback?: boolean };

  constructor(opts: { failStore?: boolean; failLoad?: boolean; corruptReadback?: boolean } = {}) {
    this.opts = opts;
  }
  async load(fp: string) {
    if (this.opts.failLoad) throw new Error('keystore offline');
    const v = this.entries.get(fp);
    if (this.opts.corruptReadback) return v === undefined ? null : `${v}-corrupted`;
    return v ?? null;
  }
  async store(fp: string, seed: string) {
    if (this.opts.failStore) throw new Error('keystore write denied');
    this.entries.set(fp, seed);
  }
}

function internalsFor(): SecureStoreInternals {
  return { secureDir: null, enabled: true, keystore: null, platform: process.platform, env: process.env, os, log: silent };
}

async function expectKind(p: Promise<unknown>, kind: SecureStoreError['kind']): Promise<SecureStoreError> {
  const error = await p.then(
    () => {
      throw new Error(`expected SecureStoreError(${kind})`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SecureStoreError);
  expect((error as SecureStoreError).kind).toBe(kind);
  return error as SecureStoreError;
}

describe('secure_store::tests', () => {
  it('open_store_creates_secure_dir_eagerly', () => {
    const dir = tempDir();
    secrets.openStore(dir);
    expect(existsSync(join(dir, '.secure'))).toBe(true);
  });
  it('stable_seed_is_persisted', async () => {
    const store = storeIn(tempDir());
    expect((await store.deviceKey()).equals(await store.deviceKey())).toBe(true);
  });
  it('plaintext_backup_seed_is_portable', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, 'aa'.repeat(32));
    await secrets.validateBackupSeedFile(f, { keystore: null });
  });
  it('oversized_backup_seed_is_rejected_before_reading', async () => {
    const f = join(tempDir(), '.key_seed');
    closeSync(openSync(f, 'w'));
    truncateSync(f, MAX_BACKUP_SEED_FILE_BYTES + 1);
    await expectKind(secrets.validateBackupSeedFile(f, { keystore: null }), 'EncryptionError');
  });
  it('empty_existing_seed_fails_closed_without_replacement', async () => {
    const dir = tempDir();
    const store = storeIn(dir);
    mkdirSync(join(dir, '.secure'), { recursive: true });
    writeFileSync(join(dir, '.secure/.key_seed'), '');
    await expectKind(store.saveSecret('empty-seed-test', 'must-not-be-written'), 'EncryptionError');
    expect(readFileSync(join(dir, '.secure/.key_seed'))).toHaveLength(0);
    expect(existsSync(join(dir, '.secure/empty-seed-test.enc'))).toBe(false);
  });
  it('oversized_encrypted_secret_is_rejected_before_allocation', async () => {
    const dir = tempDir();
    const store = storeIn(dir);
    mkdirSync(join(dir, '.secure'), { recursive: true });
    const f = join(dir, '.secure/oversized.enc');
    closeSync(openSync(f, 'w'));
    truncateSync(f, MAX_ENCRYPTED_SECRET_FILE_BYTES + 1);
    await expectKind(store.getSecret('oversized'), 'EncryptionError');
  });
  it.runIf(offWindows)('symlinked_backup_seed_is_rejected', async () => {
    const dir = tempDir();
    const target = join(tempDir(), 'seed');
    writeFileSync(target, 'aa'.repeat(32));
    const f = join(dir, '.key_seed');
    symlinkSync(target, f);
    await expectKind(secrets.validateBackupSeedFile(f, { keystore: null }), 'AccessDenied');
  });
  it.runIf(offWindows)('dpapi_wrapped_backup_seed_is_rejected_off_windows', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, 'DPAPI1:Zm9yZWlnbi1ibG9i');
    await expectKind(secrets.validateBackupSeedFile(f, { keystore: null }), 'PlatformUnsupported');
  });
  // Windows 专属：DPAPI 通过 PowerShell ProtectedData 调用，需在 Windows runner 上执行。
  it.runIf(!offWindows)('plaintext_seed_migrates_to_dpapi_wrapping', async () => {
    const dir = tempDir();
    const store = storeIn(dir);
    mkdirSync(join(dir, '.secure'), { recursive: true });
    const legacy = 'aa'.repeat(32);
    writeFileSync(join(dir, '.secure/.key_seed'), legacy);
    const k1 = await store.deviceKey();
    const onDisk = readFileSync(join(dir, '.secure/.key_seed'), 'utf8');
    expect(onDisk.startsWith('DPAPI1:')).toBe(true);
    expect(onDisk).not.toContain(legacy);
    await secrets.validateBackupSeedFile(join(dir, '.secure/.key_seed'), { keystore: null });
    expect((await store.deviceKey()).equals(k1)).toBe(true);
  });
  it.runIf(!offWindows)('reseal_wraps_imported_plaintext_seed_on_windows', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, sampleSeed());
    expect(await secrets.resealSeedFileForCurrentPlatform(f)).toBe(true);
    const onDisk = readFileSync(f, 'utf8');
    expect(onDisk.startsWith('DPAPI1:')).toBe(true);
    expect(onDisk).not.toContain(sampleSeed());
    expect(await secrets.resolveSeedFilePlaintext(f, { keystore: null })).toBe(sampleSeed());
    expect(await secrets.resealSeedFileForCurrentPlatform(f)).toBe(false);
  });
  it('plaintext_seed_exports_for_password_encrypted_backup', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, sampleSeed());
    expect(await secrets.resolveSeedFilePlaintext(f, { keystore: null })).toBe(sampleSeed());
  });
  it('exported_plaintext_seed_survives_import_roundtrip', async () => {
    const src = join(tempDir(), '.key_seed');
    writeFileSync(src, sampleSeed());
    const exported = await secrets.resolveSeedFilePlaintext(src, { keystore: null });
    const dst = join(tempDir(), '.key_seed');
    writeFileSync(dst, exported);
    await secrets.validateBackupSeedFile(dst, { keystore: null });
    await secrets.resealSeedFileForCurrentPlatform(dst);
    expect(await secrets.resolveSeedFilePlaintext(dst, { keystore: null })).toBe(sampleSeed());
  });
  it.runIf(offWindows)('reseal_keeps_imported_plaintext_seed_off_windows', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, sampleSeed());
    expect(await secrets.resealSeedFileForCurrentPlatform(f)).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe(sampleSeed());
  });
  it.runIf(offWindows)('dpapi_seed_export_fails_closed_off_windows', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, 'DPAPI1:Zm9yZWlnbi1ibG9i');
    await expectKind(secrets.resolveSeedFilePlaintext(f, { keystore: null }), 'PlatformUnsupported');
    expect(readFileSync(f, 'utf8')).toBe('DPAPI1:Zm9yZWlnbi1ibG9i');
  });
  it('keystore_marker_seed_reseal_is_noop_and_export_fails_without_backend', async () => {
    const f = join(tempDir(), '.key_seed');
    const marker = `KEYSTORE1:${seedFingerprint(sampleSeed())}`;
    writeFileSync(f, marker);
    expect(await secrets.resealSeedFileForCurrentPlatform(f)).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe(marker);
    await expectKind(secrets.resolveSeedFilePlaintext(f, { keystore: null }), 'PlatformUnsupported');
  });
  it('classify_seed_content_variants', () => {
    const seed = sampleSeed();
    expect(classifySeedContent(seed)).toEqual({ kind: 'Plaintext', value: seed });
    expect(classifySeedContent('DPAPI1:Zm9v')).toEqual({ kind: 'Dpapi', payload: 'Zm9v' });
    const fp = seedFingerprint(seed);
    expect(classifySeedContent(`KEYSTORE1:${fp}`)).toEqual({ kind: 'KeystoreRef', fingerprint: fp });
    expect(() => classifySeedContent('KEYSTORE1:not-a-fingerprint')).toThrow(SecureStoreError);
  });
  it('seed_fingerprint_is_stable_hex', () => {
    const a = seedFingerprint('seed-a');
    expect(seedFingerprint('seed-a')).toBe(a);
    expect(seedFingerprint('seed-b')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('plaintext_seed_migrates_into_keystore_with_verified_marker', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, sampleSeed());
    const ks = new FakeKeystore();
    await migrateSeedToKeystore(ks, f, sampleSeed(), internalsFor());
    const onDisk = readFileSync(f, 'utf8');
    expect(onDisk.startsWith('KEYSTORE1:')).toBe(true);
    expect(onDisk).not.toContain(sampleSeed());
    const c = classifySeedContent(onDisk.trim());
    if (c.kind !== 'KeystoreRef') throw new Error('marker should classify as keystore ref');
    expect(await resolveKeystoreSeed(ks, c.fingerprint)).toBe(sampleSeed());
  });
  it('migration_store_failure_keeps_plaintext_file', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, sampleSeed());
    await expectKind(migrateSeedToKeystore(new FakeKeystore({ failStore: true }), f, sampleSeed(), internalsFor()), 'KeychainUnavailable');
    expect(readFileSync(f, 'utf8')).toBe(sampleSeed());
  });
  it('migration_readback_mismatch_keeps_plaintext_file', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, sampleSeed());
    await expectKind(migrateSeedToKeystore(new FakeKeystore({ corruptReadback: true }), f, sampleSeed(), internalsFor()), 'EncryptionError');
    expect(readFileSync(f, 'utf8')).toBe(sampleSeed());
  });
  it('keystore_ref_fails_closed_without_backend', async () => {
    await expectKind(resolveKeystoreSeed(null, seedFingerprint(sampleSeed())), 'PlatformUnsupported');
  });
  it('keystore_ref_fails_closed_when_backend_unavailable', async () => {
    const e = await expectKind(resolveKeystoreSeed(new FakeKeystore({ failLoad: true }), seedFingerprint(sampleSeed())), 'KeychainUnavailable');
    expect(e.message).toContain('Secret Service');
  });
  it('keystore_ref_fails_closed_when_entry_missing', async () => {
    await expectKind(resolveKeystoreSeed(new FakeKeystore(), seedFingerprint(sampleSeed())), 'KeyNotFound');
  });
  it('keystore_ref_fingerprint_mismatch_fails_closed', async () => {
    const ks = new FakeKeystore();
    const fp = seedFingerprint(sampleSeed());
    await ks.store(fp, 'cc'.repeat(32));
    await expectKind(resolveKeystoreSeed(ks, fp), 'EncryptionError');
  });
  it('keystore_marker_seed_file_never_replaced_by_new_seed', async () => {
    const dir = tempDir();
    const store = storeIn(dir);
    mkdirSync(join(dir, '.secure'), { recursive: true });
    const marker = `KEYSTORE1:${seedFingerprint(sampleSeed())}`;
    writeFileSync(join(dir, '.secure/.key_seed'), marker);
    await expectKind(store.saveSecret('keystore-marker-test', 'must-not-be-written'), 'PlatformUnsupported');
    expect(readFileSync(join(dir, '.secure/.key_seed'), 'utf8')).toBe(marker);
    expect(existsSync(join(dir, '.secure/keystore-marker-test.enc'))).toBe(false);
  });
  it('keystore_marker_backup_seed_is_rejected_without_backend', async () => {
    const f = join(tempDir(), '.key_seed');
    writeFileSync(f, `KEYSTORE1:${seedFingerprint(sampleSeed())}`);
    await expectKind(secrets.validateBackupSeedFile(f, { keystore: null }), 'PlatformUnsupported');
  });
  it.runIf(offWindows)('dpapi_seed_is_rejected_off_windows_when_reading', async () => {
    const dir = tempDir();
    const store = storeIn(dir);
    mkdirSync(join(dir, '.secure'), { recursive: true });
    writeFileSync(join(dir, '.secure/.key_seed'), 'DPAPI1:Zm9yZWlnbi1ibG9i');
    await expectKind(store.saveSecret('dpapi-cross-platform', 'value'), 'PlatformUnsupported');
  });
  it('new_seed_stays_in_local_file_by_default', async () => {
    const dir = tempDir();
    const store = storeIn(dir);
    await store.saveSecret('default-mode-test', 'value');
    const onDisk = readFileSync(join(dir, '.secure/.key_seed'), 'utf8').trim();
    if (offWindows) expect(onDisk.startsWith('KEYSTORE1:') || onDisk.startsWith('DPAPI1:')).toBe(false);
    expect(existsSync(join(dir, '.secure/.keystore_opt_in'))).toBe(false);
    const status = await store.keystoreProtectionStatus();
    expect(status.enabled).toBe(false);
    expect(status.seedInKeystore).toBe(false);
  });
  it('enabling_keystore_protection_fails_closed_without_backend', async () => {
    const dir = tempDir();
    await expectKind(storeIn(dir).setKeystoreProtection(true), 'PlatformUnsupported');
    expect(existsSync(join(dir, '.secure/.keystore_opt_in'))).toBe(false);
  });
  it('disabling_keystore_protection_is_idempotent', async () => {
    const store = storeIn(tempDir());
    await store.setKeystoreProtection(false);
    await store.setKeystoreProtection(false);
    expect((await store.keystoreProtectionStatus()).enabled).toBe(false);
  });
  it('can_read_legacy_ciphertext_and_migrate', async () => {
    const dir = tempDir();
    const store = storeIn(dir);
    mkdirSync(join(dir, '.secure'), { recursive: true });
    writeFileSync(join(dir, '.secure/legacy_test.enc'), encryptWithKey(await store.legacyDeviceKey(), 'legacy-value'));
    expect(await store.getSecret('legacy_test')).toBe('legacy-value');
    expect(await store.getSecret('legacy_test')).toBe('legacy-value');
  });
});

describe('钥匙串保护开关（FakeKeystore 注入，补充 Rust 中依赖真实密钥库的分支）', () => {
  it('开启迁入密钥库，关闭回迁本地文件，种子不变', async () => {
    const dir = tempDir();
    const ks = new FakeKeystore();
    const store = storeIn(dir, ks);
    await store.saveSecret('k', 'v');
    const seed = readFileSync(join(dir, '.secure/.key_seed'), 'utf8');
    await store.setKeystoreProtection(true);
    expect(await store.keystoreProtectionStatus()).toEqual({ supported: true, enabled: true, seedInKeystore: true });
    expect(ks.entries.get(seedFingerprint(seed))).toBe(seed);
    expect(await store.getSecret('k')).toBe('v');
    await store.setKeystoreProtection(false);
    expect(readFileSync(join(dir, '.secure/.key_seed'), 'utf8')).toBe(seed);
    expect(await store.getSecret('k')).toBe('v');
  });
});

describe('secure_store::cloud_hydration_tests', () => {
  const full = { webdavPassword: 'webdav-secret', s3SecretAccessKey: 's3-secret', ftpPassword: 'ftp-secret', encryptionPassword: 'encryption-secret' };
  it('credential_status_never_serializes_secret_values', () => {
    const encoded = JSON.stringify(credentialStatus(full));
    expect(encoded).toBe('{"webdavPasswordConfigured":true,"s3SecretAccessKeyConfigured":true,"ftpPasswordConfigured":true,"encryptionPasswordConfigured":true}');
    expect(encoded).not.toContain('secret');
  });
  // Supplemental status JSON coverage, not the Rust Debug tests at secure_store.rs:2749/2779.
  // Those mappings remain pending: no production credentials Debug formatter is wired.
  it('credentialStatus reports one configured backend and three absent secrets', () => {
    expect(JSON.stringify(credentialStatus({ webdavPassword: 'webdav-secret' }))).toBe(
      '{"webdavPasswordConfigured":true,"s3SecretAccessKeyConfigured":false,"ftpPasswordConfigured":false,"encryptionPasswordConfigured":false}',
    );
  });
  it('credential_update_preserves_omitted_backend_secrets', () => {
    const c = { webdavPassword: 'stored-webdav', encryptionPassword: 'stored-encryption' } as Record<string, string>;
    applyNonemptyUpdate(c, { s3SecretAccessKey: 'new-s3', webdavPassword: ' ' });
    expect(c).toEqual({ webdavPassword: 'stored-webdav', encryptionPassword: 'stored-encryption', s3SecretAccessKey: 'new-s3' });
  });
  it('short_encryption_password_is_rejected_and_does_not_mark_configured', async () => {
    const store = storeIn(tempDir());
    const e = await expectKind(store.updateCloudCredentials({ encryptionPassword: 'short' }), 'CloudEncryptionPasswordTooShort');
    expect(e.stableCode).toBe(CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE);
    expect(e.message).toContain(String(MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS));
    expect(await store.getCloudCredentials()).toBeNull();
    expect((await store.updateCloudCredentials({ encryptionPassword: 'long-enough-password' })).encryptionPasswordConfigured).toBe(true);
  });
  it('preexisting_short_encryption_password_is_accepted', async () => {
    const store = storeIn(tempDir());
    expect((await store.updateCloudCredentials({ encryptionPassword: 'short6' }, true)).encryptionPasswordConfigured).toBe(true);
    expect((await store.getCloudCredentials())?.encryptionPassword).toBe('short6');
  });
  it('preexisting_policy_does_not_relax_the_default_entry', async () => {
    await expectKind(storeIn(tempDir()).updateCloudCredentials({ encryptionPassword: 'short6' }, false), 'CloudEncryptionPasswordTooShort');
  });
  it('weak_password_predicate_semantics', () => {
    for (const p of ['password123', 'Password123', '  qwertyuiop  ', '12345678', 'aaaaaaaa', 'abababab', '12121212']) expect(cloudEncryptionPasswordTooWeak(p)).toBe(true);
    for (const p of ['aabbccdd', 'correct horse battery staple', 'long-enough-password', '', '   ']) expect(cloudEncryptionPasswordTooWeak(p)).toBe(false);
    expect(cloudEncryptionPasswordTooWeak(null)).toBe(false);
  });
  it('new_password_gate_checks_length_before_weakness', () => {
    try {
      checkNewCloudEncryptionPassword('1234567');
      throw new Error('should fail');
    } catch (e) {
      expect((e as SecureStoreError).kind).toBe('CloudEncryptionPasswordTooShort');
    }
  });
  it('new_weak_encryption_password_is_rejected_and_not_persisted', async () => {
    const store = storeIn(tempDir());
    for (const weak of ['password123', 'aaaaaaaa']) {
      const e = await expectKind(store.updateCloudCredentials({ encryptionPassword: weak }), 'CloudEncryptionPasswordTooWeak');
      expect(e.stableCode).toBe(CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE);
      expect(await store.getCloudCredentials()).toBeNull();
    }
    expect((await store.updateCloudCredentials({ encryptionPassword: 'correct horse battery staple' })).encryptionPasswordConfigured).toBe(true);
  });
  it('preexisting_weak_encryption_password_is_accepted', async () => {
    const store = storeIn(tempDir());
    expect((await store.updateCloudCredentials({ encryptionPassword: 'password123' }, true)).encryptionPasswordConfigured).toBe(true);
    expect((await store.getCloudCredentials())?.encryptionPassword).toBe('password123');
  });
  it('clearing_encryption_password_keeps_transport_credentials', async () => {
    const store = storeIn(tempDir());
    await store.saveCloudCredentials({ webdavPassword: 'webdav-secret', encryptionPassword: 'encryption-secret' });
    const status = await store.clearCloudEncryptionPassword();
    expect(status.encryptionPasswordConfigured).toBe(false);
    expect(status.webdavPasswordConfigured).toBe(true);
    expect(await store.getCloudCredentials()).toEqual({ webdavPassword: 'webdav-secret' });
  });
  it('clearing_the_only_secret_removes_the_record_entirely', async () => {
    const store = storeIn(tempDir());
    await store.saveCloudCredentials({ encryptionPassword: 'encryption-secret' });
    expect(await store.clearCloudEncryptionPassword()).toEqual(credentialStatus({}));
    expect(await store.getCloudCredentials()).toBeNull();
  });
  it('clearing_encryption_password_without_stored_credentials_is_a_noop', async () => {
    expect(await storeIn(tempDir()).clearCloudEncryptionPassword()).toEqual(credentialStatus({}));
  });
  it('successful_cloud_credential_clear_removes_the_secret_record', async () => {
    const dir = tempDir();
    const store = storeIn(dir);
    await store.saveCloudCredentials({ webdavPassword: 'secret' });
    await store.deleteCloudCredentials();
    expect(await store.getCloudCredentials()).toBeNull();
    expect(existsSync(join(dir, '.secure/cloud_storage_credentials.enc'))).toBe(false);
  });
  it('staged_write_leaves_active_record_and_generation_untouched', async () => {
    const store = storeIn(tempDir());
    await store.saveCloudCredentials({ webdavPassword: 'active-webdav', encryptionPassword: 'active-encryption' });
    expect(await store.cloudCredentialsActiveGeneration()).toBe(0n);
    expect(await store.writeStagedCloudCredentials({ webdavPassword: 'staged-webdav' }, false)).toBe(1n);
    expect(await store.getCloudCredentials()).toEqual({ webdavPassword: 'active-webdav', encryptionPassword: 'active-encryption' });
    expect(await store.cloudCredentialsActiveGeneration()).toBe(0n);
    expect(await store.getStagedCloudCredentialsRecord()).toEqual({ generation: 1n, credentials: { webdavPassword: 'staged-webdav', encryptionPassword: 'active-encryption' } });
  });
  it('commit_advances_generation_and_publishes_staged_values', async () => {
    const store = storeIn(tempDir());
    await store.saveCloudCredentials({ webdavPassword: 'active-webdav', encryptionPassword: 'active-encryption' });
    const g = await store.writeStagedCloudCredentials({ webdavPassword: 'staged-webdav' }, false);
    await store.commitStagedCloudCredentials(g);
    expect(await store.cloudCredentialsActiveGeneration()).toBe(1n);
    expect(await store.getCloudCredentials()).toEqual({ webdavPassword: 'staged-webdav', encryptionPassword: 'active-encryption' });
    expect(await store.getStagedCloudCredentialsRecord()).toBeNull();
    await store.commitStagedCloudCredentials(g);
  });
  it('abort_discards_staged_without_touching_active', async () => {
    const store = storeIn(tempDir());
    await store.saveCloudCredentials({ webdavPassword: 'active-webdav' });
    const g = await store.writeStagedCloudCredentials({ webdavPassword: 'staged-webdav' }, false);
    await store.abortStagedCloudCredentials(g);
    expect((await store.getCloudCredentials())?.webdavPassword).toBe('active-webdav');
    expect(await store.cloudCredentialsActiveGeneration()).toBe(0n);
    expect(await store.getStagedCloudCredentialsRecord()).toBeNull();
    await store.abortStagedCloudCredentials(g);
  });
  it('staged_write_enforces_the_same_short_password_policy', async () => {
    const store = storeIn(tempDir());
    const e = await expectKind(store.writeStagedCloudCredentials({ encryptionPassword: 'short6' }, false), 'CloudEncryptionPasswordTooShort');
    expect(e.stableCode).toBe(CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE);
    expect(await store.getStagedCloudCredentialsRecord()).toBeNull();
    await store.commitStagedCloudCredentials(await store.writeStagedCloudCredentials({ encryptionPassword: 'short6' }, true));
    expect((await store.getCloudCredentials())?.encryptionPassword).toBe('short6');
  });
  it('staged_write_enforces_the_same_weak_password_policy', async () => {
    const store = storeIn(tempDir());
    const e = await expectKind(store.writeStagedCloudCredentials({ encryptionPassword: 'password123' }, false), 'CloudEncryptionPasswordTooWeak');
    expect(e.stableCode).toBe(CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE);
    expect(await store.getStagedCloudCredentialsRecord()).toBeNull();
    await store.commitStagedCloudCredentials(await store.writeStagedCloudCredentials({ encryptionPassword: 'password123' }, true));
    expect((await store.getCloudCredentials())?.encryptionPassword).toBe('password123');
  });
  it('stale_generation_handles_fail_closed_without_touching_active', async () => {
    const store = storeIn(tempDir());
    await store.saveCloudCredentials({ webdavPassword: 'active-webdav' });
    const g = await store.writeStagedCloudCredentials({ webdavPassword: 'staged-webdav' }, false);
    for (const stale of [g + 1n, g + 7n]) {
      const e = await expectKind(store.commitStagedCloudCredentials(stale), 'CloudCredentialGenerationConflict');
      expect(e.stableCode).toBe(CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE);
      await expectKind(store.abortStagedCloudCredentials(stale), 'CloudCredentialGenerationConflict');
    }
    expect((await store.getCloudCredentials())?.webdavPassword).toBe('active-webdav');
    expect(await store.cloudCredentialsActiveGeneration()).toBe(0n);
    expect(await store.getStagedCloudCredentialsRecord()).not.toBeNull();
  });
  it('commit_without_staged_record_fails_closed', async () => {
    const store = storeIn(tempDir());
    await expectKind(store.commitStagedCloudCredentials(1n), 'KeyNotFound');
    expect(await store.cloudCredentialsActiveGeneration()).toBe(0n);
  });
  it('transactional_delete_clears_active_staged_and_generation', async () => {
    const dir = tempDir();
    const store = storeIn(dir);
    await store.saveCloudCredentials({ webdavPassword: 'active-webdav' });
    await store.commitStagedCloudCredentials(await store.writeStagedCloudCredentials({ webdavPassword: 'next-webdav' }, false));
    await store.writeStagedCloudCredentials({ webdavPassword: 'orphan-webdav' }, false);
    await store.deleteCloudCredentialsTransactional();
    expect(await store.getCloudCredentials()).toBeNull();
    expect(await store.getStagedCloudCredentialsRecord()).toBeNull();
    expect(await store.cloudCredentialsActiveGeneration()).toBe(0n);
    for (const f of ['cloud_storage_credentials.enc', 'cloud_storage_credentials_staged.enc', 'cloud_storage_credentials_generation.enc']) {
      expect(existsSync(join(dir, '.secure', f))).toBe(false);
    }
  });
  it('staged 记录落盘形状与 serde 一致', async () => {
    const store = storeIn(tempDir());
    await store.writeStagedCloudCredentials({ ftpPassword: 'f' }, false);
    expect(await store.getSecret('cloud_storage_credentials_staged')).toBe('{"generation":1,"credentials":{"ftpPassword":"f"}}');
  });
});

// src-tauri/tests/secure_store_tests.rs
describe('secure_store_tests', () => {
  it('test_secure_store_basic_operations', async () => {
    const store = storeIn(tempDir());
    expect(await store.isAvailable()).toBe(true);
    await store.saveSecret('test.api_key.example', 'secret_api_key_12345');
    expect(await store.getSecret('test.api_key.example')).toBe('secret_api_key_12345');
    await store.deleteSecret('test.api_key.example');
    expect(await store.getSecret('test.api_key.example')).toBeNull();
  });
  it('test_sensitive_key_detection', () => {
    for (const k of ['web_search.api_key.bing', 'web_search.api_key.google_cse', 'api_configs', 'mcp.transport.ssh_private_key', 'builtin-deepseek.api_key']) expect(secrets.isSensitiveKey(k)).toBe(true);
    for (const k of ['web_search.engine', 'web_search.timeout_ms', 'general.theme']) expect(secrets.isSensitiveKey(k)).toBe(false);
  });
  it('listSensitiveKeys 返回替换后的键名', async () => {
    const store = storeIn(tempDir());
    await store.saveSecret('a/b', 'x');
    expect([...(await store.listSensitiveKeys())]).toEqual(['a_b']);
  });
  it('toCommandError 形状', () => {
    expect(new SecureStoreError('KeychainUnavailable', 'x').toCommandError('save_cloud_credentials')).toEqual({
      code: 'SECURE_STORE_UNAVAILABLE',
      message: 'Keychain不可用: x',
      data: { operation: 'save_cloud_credentials', retryable: true },
    });
  });
});
