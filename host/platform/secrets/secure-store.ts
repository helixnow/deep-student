/**
 * `SecureStore` 的逐行移植（`dstu-security/src/secure_store.rs`）。注释中的行号指该文件。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { decodeUtf8Strict, JsonReader, rustTrim } from '../util/portable.ts';
import { errnoCode, ioMessage } from '../paths/compat.ts';
import {
  CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE,
  SecureStoreError,
  type CloudStorageCredentialStatus,
  type CloudStorageCredentials,
  type KeystoreProtectionStatus,
  type SecureStore,
  type SeedKeystore,
} from './api.ts';
import {
  applyNonemptyUpdate,
  checkNewCloudEncryptionPassword,
  credentialStatus,
  hasAnySecret,
  parseStaged,
  parseU64,
  readCredentials,
  serializeCredentials,
  serializeStaged,
  U64_MAX,
  type StagedRecord,
} from './cloud-credentials.ts';
import { keystoreDisabledByEnv } from './keystore.ts';
import {
  atomicWriteSecureFile,
  classifySeedContent,
  KEYSTORE_SEED_PREFIX,
  MAX_BACKUP_SEED_FILE_BYTES,
  migrateSeedToKeystore,
  readBounded,
  resolveKeystoreSeed,
  restrictPermissions,
  seedFingerprint,
  unwrapDpapiSeed,
  writeSeedFile,
  type SecureStoreInternals,
} from './seed-file.ts';

export {
  classifySeedContent,
  dpapiSeedError,
  keystoreUnavailableDetail,
  MAX_BACKUP_SEED_FILE_BYTES,
  migrateSeedToKeystore,
  resealSeedFileForCurrentPlatform,
  resolveKeystoreSeed,
  resolveSeedFilePlaintext,
  restrictPermissions,
  seedFingerprint,
  validateBackupSeedFile,
  type SecureStoreInternals,
  type SeedFileContent,
} from './seed-file.ts';
export {
  applyNonemptyUpdate,
  checkNewCloudEncryptionPassword,
  cloudEncryptionPasswordTooShort,
  cloudEncryptionPasswordTooShortMessage,
  cloudEncryptionPasswordTooWeak,
  cloudEncryptionPasswordTooWeakMessage,
  credentialStatus,
  serializeCredentials,
} from './cloud-credentials.ts';

const CLOUD_STORAGE_KEY = 'cloud_storage_credentials';
const CLOUD_STORAGE_STAGED_KEY = 'cloud_storage_credentials_staged';
const CLOUD_STORAGE_GENERATION_KEY = 'cloud_storage_credentials_generation';
const KEYSTORE_OPT_IN_MARKER = '.keystore_opt_in';
export const MAX_ENCRYPTED_SECRET_FILE_BYTES = 16 * 1024 * 1024;

export { isSensitiveKey } from './sensitive-key.ts';

/** `derive_key`（1191）：SHA-256(seed ‖ salt)。 */
export function deriveKey(seed: string, salt: string): Buffer {
  return createHash('sha256').update(seed, 'utf8').update(salt, 'utf8').digest();
}

export const SECURE_SALT_V3 = 'deep-student-secure-salt-v3';
export const SECURE_SALT_V2 = 'deep-student-secure-salt-v2';

/** `encrypt_with_key`（1248）：nonce(12) ‖ ct ‖ tag(16)，无 AAD。`nonce` 仅测试向量注入。 */
export function encryptWithKey(key: Uint8Array, value: string, nonce: Uint8Array = randomBytes(12)): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

/** `decrypt_with_key`（1269）。 */
export function decryptWithKey(key: Uint8Array, data: Uint8Array): string {
  if (data.length < 12) throw new SecureStoreError('EncryptionError', '数据格式无效');
  const body = data.subarray(12);
  if (body.length < 16) throw new SecureStoreError('EncryptionError', 'aead::Error');
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(body.subarray(body.length - 16));
    plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  } catch {
    // aes-gcm 的 `aead::Error` 不携带细节；认证失败统一映射为该文案。
    throw new SecureStoreError('EncryptionError', 'aead::Error');
  }
  try {
    return decodeUtf8Strict(plain);
  } catch (error) {
    throw new SecureStoreError('Other', `UTF-8 解码失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    plain.fill(0);
  }
}

// ------------------------------------------------------------------ 进程级状态

/** `MASTER_SEED_LOCK`（186）：全进程一把锁。 */
let masterSeedTail: Promise<unknown> = Promise.resolve();
function withMasterSeedLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = masterSeedTail.then(fn, fn);
  masterSeedTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** `KEYSTORE_SEED_CACHE`（194）。 */
const keystoreSeedCache = new Map<string, string>();

// ------------------------------------------------------------------ 实例

export class SecureStoreImpl implements SecureStore {
  private readonly internals: SecureStoreInternals;

  constructor(internals: SecureStoreInternals) {
    this.internals = internals;
  }

  get secureDir(): string {
    return this.internals.secureDir ?? this.fallbackCandidate();
  }

  get enabled(): boolean {
    return this.internals.enabled;
  }

  private fallbackCandidate(): string {
    return join(this.internals.os.dataLocal, 'deep-student', '.secure');
  }

  private keystoreOptedIn(secureDir: string): Promise<boolean> {
    if (keystoreDisabledByEnv(this.internals.env)) return Promise.resolve(false);
    return stat(join(secureDir, KEYSTORE_OPT_IN_MARKER)).then(
      (s) => s.isFile(),
      () => false,
    );
  }

  private keystoreSupported(): boolean {
    return this.internals.keystore !== null && !keystoreDisabledByEnv(this.internals.env);
  }

  /** `get_secure_dir`（654）。 */
  private async getSecureDir(): Promise<string> {
    if (this.internals.secureDir !== null) {
      const dir = this.internals.secureDir;
      try {
        await mkdir(dir, { recursive: true });
      } catch (error) {
        throw new SecureStoreError('Other', `创建安全目录失败: ${ioMessage(error)}`);
      }
      await restrictPermissions(dir, true, this.internals);
      return dir;
    }
    const candidate = this.fallbackCandidate();
    try {
      await mkdir(candidate, { recursive: true });
      await restrictPermissions(candidate, true, this.internals);
      return candidate;
    } catch (error) {
      // RUST-FIX(RF-W07-secure-store-temp-fallback): Rust falls back to <temp_dir>/deep-student/.secure, where the OS purges the master seed and other users can own the parent dir.
      throw new SecureStoreError('Other', `创建安全目录失败: ${candidate}: ${ioMessage(error)}`);
    }
  }

  /** `get_or_create_master_seed`（701）。 */
  private getOrCreateMasterSeed(): Promise<string> {
    return withMasterSeedLock(() => this.getOrCreateMasterSeedLocked());
  }

  private async getOrCreateMasterSeedLocked(): Promise<string> {
    const { log, platform } = this.internals;
    const secureDir = await this.getSecureDir();
    const seedFile = join(secureDir, '.key_seed');
    let buf: Buffer | null;
    try {
      buf = await readBounded(
        seedFile,
        MAX_BACKUP_SEED_FILE_BYTES,
        (len) => new SecureStoreError('EncryptionError', `密钥种子文件异常过大: ${len} bytes`),
        '密钥种子必须是普通文件，不能是目录或符号链接',
      );
    } catch (error) {
      if (error instanceof SecureStoreError) throw error;
      throw new SecureStoreError('Other', `检查密钥种子失败，拒绝覆盖: ${ioMessage(error)}`);
    }
    if (buf !== null) {
      if (buf.length > MAX_BACKUP_SEED_FILE_BYTES) throw new SecureStoreError('EncryptionError', '密钥种子读取大小超限');
      let text: string;
      try {
        text = decodeUtf8Strict(buf);
      } catch {
        throw new SecureStoreError('Other', '读取密钥种子失败: stream did not contain valid UTF-8');
      } finally {
        buf.fill(0);
      }
      const trimmed = rustTrim(text);
      if (trimmed === '') throw new SecureStoreError('EncryptionError', '密钥种子为空，拒绝生成新种子覆盖');
      const content = classifySeedContent(trimmed);
      if (content.kind === 'Dpapi') {
        if (platform === 'win32') return unwrapDpapiSeed(content.payload, this.internals.dpapi);
        throw new SecureStoreError(
          'PlatformUnsupported',
          '检测到 DPAPI 封装的密钥种子，只能在原 Windows 用户/机器上解封；拒绝把封装载荷当作种子使用（fail-closed，不会生成新密钥）',
        );
      }
      if (content.kind === 'KeystoreRef') {
        let resolved = keystoreSeedCache.get(content.fingerprint);
        if (resolved === undefined) {
          resolved = await resolveKeystoreSeed(this.activeKeystore(), content.fingerprint);
          keystoreSeedCache.set(content.fingerprint, resolved);
        }
        if (!(await this.keystoreOptedIn(secureDir))) {
          try {
            await writeSeedFile(seedFile, resolved, this.internals);
            log.info('钥匙串保护未开启：已将密钥种子从平台密钥库回迁为本地种子文件');
          } catch (error) {
            log.warn(`密钥种子回迁为本地文件失败（下次重试）: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return resolved;
      }
      const plainSeed = content.value;
      if (platform === 'win32') {
        try {
          await writeSeedFile(seedFile, plainSeed, this.internals);
          log.info('已将明文密钥种子迁移为 DPAPI 封装存储');
        } catch (error) {
          log.warn(`迁移明文密钥种子到 DPAPI 封装失败（继续使用明文）: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (await this.keystoreOptedIn(secureDir)) {
        const keystore = this.activeKeystore();
        if (keystore !== null) {
          try {
            await migrateSeedToKeystore(keystore, seedFile, plainSeed, this.internals);
          } catch (error) {
            throw new SecureStoreError(
              'KeychainUnavailable',
              `迁移明文密钥种子到${keystore.backendName}失败，已保留原文件但拒绝继续使用明文种子: ${error instanceof Error ? error.message : String(error)}。请解锁平台密钥库后重试，或在设置中关闭系统钥匙串保护`,
            );
          }
          keystoreSeedCache.set(seedFingerprint(plainSeed), plainSeed);
          log.info(`已将明文密钥种子一次性迁入${keystore.backendName}（.key_seed 仅保留指纹标记）`);
        }
      }
      return plainSeed;
    }

    const seedBytes = randomBytes(32);
    const seed = seedBytes.toString('hex');
    seedBytes.fill(0);
    if (platform !== 'win32' && (await this.keystoreOptedIn(secureDir))) {
      const keystore = this.activeKeystore();
      if (keystore !== null) {
        try {
          await migrateSeedToKeystore(keystore, seedFile, seed, this.internals);
        } catch (error) {
          throw new SecureStoreError(
            'KeychainUnavailable',
            `写入${keystore.backendName}失败，拒绝自动降级为明文文件种子: ${error instanceof Error ? error.message : String(error)}。请解锁平台密钥库后重试，或在设置中关闭系统钥匙串保护`,
          );
        }
        keystoreSeedCache.set(seedFingerprint(seed), seed);
        log.info(`新密钥种子已写入${keystore.backendName}（磁盘仅保留指纹标记）`);
        return seed;
      }
    }
    await writeSeedFile(seedFile, seed, this.internals);
    return seed;
  }

  /** `platform_seed_keystore()`：环境变量禁用时为 null。 */
  private activeKeystore(): SeedKeystore | null {
    return keystoreDisabledByEnv(this.internals.env) ? null : this.internals.keystore;
  }

  /** `get_device_key`（1203）。 */
  async deviceKey(): Promise<Buffer> {
    return deriveKey(await this.getOrCreateMasterSeed(), SECURE_SALT_V3);
  }

  /** `get_legacy_device_key`（1211）。 */
  async legacyDeviceKey(): Promise<Buffer> {
    const { env, os } = this.internals;
    let info = '';
    if (env.ANDROID_ID !== undefined) info += env.ANDROID_ID;
    info += os.home;
    info += os.dataLocal;
    info += hostnameForLegacyKey();
    const user = env.USER !== undefined ? env.USER : env.USERNAME;
    if (user !== undefined) info += user;
    if (info === '') {
      try {
        info = await this.getOrCreateMasterSeed();
      } catch (error) {
        this.internals.log.warn(`legacy 设备信息为空且读取种子失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return deriveKey(info, SECURE_SALT_V2);
  }

  private fileFor(dir: string, key: string): string {
    return join(dir, `${key.replace(/[/\\]/g, '_')}.enc`);
  }

  async saveSecret(key: string, value: string): Promise<void> {
    const dir = await this.getSecureDir();
    const filePath = this.fileFor(dir, key);
    const deviceKey = await this.deviceKey();
    let data: Buffer;
    try {
      data = encryptWithKey(deviceKey, value);
    } finally {
      deviceKey.fill(0);
    }
    try {
      await atomicWriteSecureFile(filePath, data, this.internals);
    } finally {
      data.fill(0);
    }
    this.internals.log.debug(`✅ 凭据已加密存储: ${key}`);
  }

  async getSecret(key: string): Promise<string | null> {
    const dir = await this.getSecureDir();
    const filePath = this.fileFor(dir, key);
    let data: Buffer | null;
    try {
      data = await readBounded(
        filePath,
        MAX_ENCRYPTED_SECRET_FILE_BYTES,
        (len) => new SecureStoreError('EncryptionError', `加密凭据文件过大: ${len} bytes`),
        '加密凭据路径必须是普通文件，不能是目录或符号链接',
      );
    } catch (error) {
      if (error instanceof SecureStoreError) throw error;
      throw new SecureStoreError('Other', `检查加密凭据文件失败: ${ioMessage(error)}`);
    }
    if (data === null) return null;
    try {
      if (data.length > MAX_ENCRYPTED_SECRET_FILE_BYTES) throw new SecureStoreError('EncryptionError', '加密凭据实际读取大小超限');
      const deviceKey = await this.deviceKey();
      let primaryError: unknown;
      try {
        return decryptWithKey(deviceKey, data);
      } catch (error) {
        primaryError = error;
      } finally {
        deviceKey.fill(0);
      }
      const legacyKey = await this.legacyDeviceKey();
      let legacyPlain: string;
      try {
        legacyPlain = decryptWithKey(legacyKey, data);
      } catch {
        // Rust：legacy 也失败时返回**主**密钥的错误。
        throw primaryError;
      } finally {
        legacyKey.fill(0);
      }
      this.internals.log.warn(`检测到 legacy 加密格式，正在迁移到稳定主密钥: ${key}`);
      try {
        await this.saveSecret(key, legacyPlain);
      } catch (error) {
        this.internals.log.warn(`迁移凭据到新密钥失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      return legacyPlain;
    } finally {
      data.fill(0);
    }
  }

  async deleteSecret(key: string): Promise<void> {
    const filePath = this.fileFor(this.secureDir, key);
    try {
      await rm(filePath);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw new SecureStoreError('Other', `删除文件失败: ${ioMessage(error)}`);
    }
    this.internals.log.debug(`✅ 凭据已删除: ${key}`);
  }

  async listSensitiveKeys(): Promise<Set<string>> {
    let dir: string;
    try {
      dir = await this.getSecureDir();
    } catch {
      // Rust：目录不可用时返回空集。
      return new Set();
    }
    const keys = new Set<string>();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // Rust `if let Ok(entries) = read_dir(..)`。
      return keys;
    }
    for (const name of names) {
      const dot = name.lastIndexOf('.');
      if (dot > 0 && name.slice(dot + 1) === 'enc') keys.add(name.slice(0, dot));
    }
    return keys;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.internals.enabled) return false;
    try {
      (await this.deviceKey()).fill(0);
      return true;
    } catch (error) {
      this.internals.log.warn(`安全存储可用性检查失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async keystoreProtectionStatus(): Promise<KeystoreProtectionStatus> {
    const dir = await this.getSecureDir();
    let seedInKeystore = false;
    try {
      const text = decodeUtf8Strict(await readFileBytes(join(dir, '.key_seed')));
      try {
        seedInKeystore = classifySeedContent(rustTrim(text)).kind === 'KeystoreRef';
      } catch {
        // `matches!(classify(..), Ok(KeystoreRef))`：格式非法按 false。
        seedInKeystore = false;
      }
    } catch {
      // `read_to_string(..).ok()`：读不到按 false。
      seedInKeystore = false;
    }
    return { supported: this.keystoreSupported(), enabled: await this.keystoreOptedIn(dir), seedInKeystore };
  }

  async setKeystoreProtection(enabled: boolean): Promise<void> {
    const dir = await this.getSecureDir();
    const marker = join(dir, KEYSTORE_OPT_IN_MARKER);
    if (enabled) {
      if (!this.keystoreSupported()) throw new SecureStoreError('PlatformUnsupported', '当前平台/配置不支持系统钥匙串保护');
      await atomicWriteSecureFile(marker, '1', this.internals);
      try {
        await this.getOrCreateMasterSeed();
      } catch (error) {
        await rm(marker, { force: true });
        throw error;
      }
      return;
    }
    try {
      await rm(marker);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw new SecureStoreError('Other', `移除钥匙串保护标记失败: ${ioMessage(error)}`);
    }
    try {
      await this.getOrCreateMasterSeed();
    } catch (error) {
      await this.restoreMarker(marker);
      throw error;
    }
    let stillMarker = false;
    try {
      stillMarker = rustTrim(decodeUtf8Strict(await readFileBytes(join(dir, '.key_seed')))).startsWith(KEYSTORE_SEED_PREFIX);
    } catch {
      // `read_to_string(..).ok()…unwrap_or(false)`。
      stillMarker = false;
    }
    if (stillMarker) {
      await this.restoreMarker(marker);
      throw new SecureStoreError('Other', '密钥种子回迁为本地文件未完成，已保持钥匙串保护开启');
    }
  }

  /** Rust `let _ = atomic_write_secure_file(&marker, b"1")`：回滚标记是尽力而为。 */
  private async restoreMarker(marker: string): Promise<void> {
    try {
      await atomicWriteSecureFile(marker, '1', this.internals);
    } catch (error) {
      this.internals.log.warn(`恢复钥匙串保护标记失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------------- 云凭据

  async saveCloudCredentials(credentials: CloudStorageCredentials): Promise<void> {
    await this.saveSecret(CLOUD_STORAGE_KEY, JSON.stringify(serializeCredentials(credentials)));
  }

  async getCloudCredentials(): Promise<CloudStorageCredentials | null> {
    const json = await this.getSecret(CLOUD_STORAGE_KEY);
    if (json === null) return null;
    try {
      const r = new JsonReader(json);
      const credentials = readCredentials(r);
      r.end();
      return credentials;
    } catch (error) {
      throw new SecureStoreError('SerializationError', error instanceof Error ? error.message : String(error));
    }
  }

  async updateCloudCredentials(update: CloudStorageCredentials, encryptionPasswordIsPreexisting = false): Promise<CloudStorageCredentialStatus> {
    if (!encryptionPasswordIsPreexisting) checkNewCloudEncryptionPassword(update.encryptionPassword);
    const credentials = (await this.getCloudCredentials()) ?? {};
    applyNonemptyUpdate(credentials, update);
    if (hasAnySecret(credentials)) await this.saveCloudCredentials(credentials);
    else await this.deleteCloudCredentials();
    return credentialStatus(credentials);
  }

  async cloudCredentialStatus(): Promise<CloudStorageCredentialStatus> {
    return credentialStatus((await this.getCloudCredentials()) ?? {});
  }

  async clearCloudEncryptionPassword(): Promise<CloudStorageCredentialStatus> {
    const credentials = await this.getCloudCredentials();
    if (credentials === null) return credentialStatus({});
    delete credentials.encryptionPassword;
    if (hasAnySecret(credentials)) await this.saveCloudCredentials(credentials);
    else await this.deleteCloudCredentials();
    return credentialStatus(credentials);
  }

  deleteCloudCredentials(): Promise<void> {
    return this.deleteSecret(CLOUD_STORAGE_KEY);
  }

  async cloudCredentialsActiveGeneration(): Promise<bigint> {
    const raw = await this.getSecret(CLOUD_STORAGE_GENERATION_KEY);
    if (raw === null) return 0n;
    const v = parseU64(rustTrim(raw));
    if (typeof v === 'string') throw new SecureStoreError('SerializationError', `云凭据 generation pointer 内容非法: ${v}`);
    return v;
  }

  private async getStagedRecord(): Promise<StagedRecord | null> {
    const json = await this.getSecret(CLOUD_STORAGE_STAGED_KEY);
    if (json === null) return null;
    try {
      return parseStaged(json);
    } catch (error) {
      throw new SecureStoreError('SerializationError', `云凭据 staged 记录非法: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 测试/诊断用：读取 staged 记录（Rust `get_staged_cloud_credentials_record`）。 */
  getStagedCloudCredentialsRecord(): Promise<{ generation: bigint; credentials: CloudStorageCredentials } | null> {
    return this.getStagedRecord();
  }

  async writeStagedCloudCredentials(update: CloudStorageCredentials, encryptionPasswordIsPreexisting: boolean): Promise<bigint> {
    if (!encryptionPasswordIsPreexisting) checkNewCloudEncryptionPassword(update.encryptionPassword);
    const merged = (await this.getCloudCredentials()) ?? {};
    applyNonemptyUpdate(merged, update);
    const active = await this.cloudCredentialsActiveGeneration();
    if (active === U64_MAX) throw new SecureStoreError('Other', '云凭据 generation 溢出（u64::MAX）');
    const generation = active + 1n;
    await this.saveSecret(CLOUD_STORAGE_STAGED_KEY, serializeStaged({ generation, credentials: merged }));
    return generation;
  }

  async commitStagedCloudCredentials(expectedGeneration: bigint): Promise<void> {
    const active = await this.cloudCredentialsActiveGeneration();
    if (active === expectedGeneration) {
      const record = await this.getStagedRecord();
      if (record === null) return;
      if (record.generation === expectedGeneration) return this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
      throw new SecureStoreError(
        'CloudCredentialGenerationConflict',
        `[${CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE}] staged generation ${record.generation} 与已提交的 generation ${expectedGeneration} 不符，拒绝清理`,
      );
    }
    const staged = await this.getStagedRecord();
    if (staged === null) throw new SecureStoreError('KeyNotFound', `云凭据 staged 记录不存在，无法提交 generation ${expectedGeneration}`);
    if (staged.generation !== expectedGeneration || active === U64_MAX || active + 1n !== expectedGeneration) {
      throw new SecureStoreError(
        'CloudCredentialGenerationConflict',
        `[${CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE}] 期望提交 generation ${expectedGeneration}，但 active=${active}、staged=${staged.generation}；staged 基线已过期，请重读后重新 stage`,
      );
    }
    const previousActive = await this.getSecret(CLOUD_STORAGE_KEY);
    if (hasAnySecret(staged.credentials)) await this.saveCloudCredentials(staged.credentials);
    else await this.deleteSecret(CLOUD_STORAGE_KEY);
    try {
      await this.saveSecret(CLOUD_STORAGE_GENERATION_KEY, expectedGeneration.toString());
    } catch (error) {
      try {
        if (previousActive !== null) await this.saveSecret(CLOUD_STORAGE_KEY, previousActive);
        else await this.deleteSecret(CLOUD_STORAGE_KEY);
      } catch (restoreError) {
        this.internals.log.warn(
          `云凭据提交失败且回滚 active 也失败（staged 保留，可重放 commit 收敛）: pointer 错误=${String(error)}, 回滚错误=${String(restoreError)}`,
        );
      }
      throw error;
    }
    await this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
  }

  async abortStagedCloudCredentials(expectedGeneration: bigint): Promise<void> {
    const json = await this.getSecret(CLOUD_STORAGE_STAGED_KEY);
    if (json === null) return;
    let record: StagedRecord;
    try {
      record = parseStaged(json);
    } catch (parseError) {
      this.internals.log.warn(`清除无法解析的云凭据 staged 记录: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      return this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
    }
    if (record.generation === expectedGeneration) return this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
    throw new SecureStoreError(
      'CloudCredentialGenerationConflict',
      `[${CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE}] staged generation ${record.generation} 与期望 ${expectedGeneration} 不符，拒绝丢弃`,
    );
  }

  async deleteCloudCredentialsTransactional(): Promise<void> {
    const snapshotActive = await this.getSecret(CLOUD_STORAGE_KEY);
    const snapshotStaged = await this.getSecret(CLOUD_STORAGE_STAGED_KEY);
    const snapshotGeneration = await this.getSecret(CLOUD_STORAGE_GENERATION_KEY);
    try {
      await this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
      await this.deleteSecret(CLOUD_STORAGE_KEY);
      await this.deleteSecret(CLOUD_STORAGE_GENERATION_KEY);
    } catch (error) {
      for (const [key, snapshot] of [
        [CLOUD_STORAGE_KEY, snapshotActive],
        [CLOUD_STORAGE_STAGED_KEY, snapshotStaged],
        [CLOUD_STORAGE_GENERATION_KEY, snapshotGeneration],
      ] as const) {
        if (snapshot === null) continue;
        try {
          await this.saveSecret(key, snapshot);
        } catch (restoreError) {
          this.internals.log.warn(`事务化删除失败后写回快照 ${key} 也失败: ${String(restoreError)}`);
        }
      }
      throw error;
    }
  }
}

async function readFileBytes(path: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** `hostname::get()`：Unix gethostname；Windows `GetComputerNameExW(PhysicalDnsHostname)`（Node `os.hostname()` 近似）。 */
function hostnameForLegacyKey(): string {
  return osHostname();
}
