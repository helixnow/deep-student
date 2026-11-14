/**
 * `ctx.secrets`：凭据安全存储与应用级加密（F4，移植 dstu-security）。
 *
 * 磁盘格式与 Rust 逐字节兼容（见 host/platform/API.md「secrets」与 TESTMAP.md 的向量）：
 * - SecureStore（`dstu-security/src/secure_store.rs`）：`<root>/.secure/<key>.enc`
 *   = nonce(12) ‖ AES-256-GCM(ciphertext ‖ tag16)，无 AAD；
 *   key = SHA-256(seed ‖ "deep-student-secure-salt-v3")，seed 来自 `<root>/.secure/.key_seed`
 *   （明文 64 hex / `DPAPI1:`+base64 / `KEYSTORE1:`+指纹）；legacy v2 key 兼容读取并迁移。
 * - CryptoService（`dstu-security/src/crypto/mod.rs`）：`<dir>/.master_key`（base64 32 字节），
 *   API Key 存为 `{"ciphertext":b64,"nonce":b64,"version":2}`。
 * - 平台密钥库：service `deep-student`，account `key_seed.<指纹>`（与 keyring 3.6.3 相同）。
 *
 * 所有方法都是异步的：Rust 侧的同步文件/密钥库访问在 Node 中不能阻塞 Host 事件循环
 * （macOS 钥匙串授权弹窗会同步挂起调用方）。同一 `.secure` 目录的种子初始化在进程内串行化，
 * 对应 Rust `MASTER_SEED_LOCK`。
 */

// 必须引入 Context 才能合并到 cordis 重导出的 Context（而不是新建同名接口）。
import type { Context } from '@deepseek-ai/cordis';

// ------------------------------------------------------------------ 错误

/** `SecureStoreError` 的变体名（与 Rust enum 变体一一对应）。 */
export type SecureStoreErrorKind =
  | 'KeychainUnavailable'
  | 'KeyNotFound'
  | 'AccessDenied'
  | 'PlatformUnsupported'
  | 'SerializationError'
  | 'EncryptionError'
  | 'Other'
  | 'CloudEncryptionPasswordTooShort'
  | 'CloudEncryptionPasswordTooWeak'
  | 'CloudCredentialGenerationConflict';

/** 云端 E2EE 新设口令过短的稳定 IPC code。 */
export const CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE = 'E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT';
/** 云端 E2EE 新设口令过弱的稳定 IPC code。 */
export const CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE = 'E_CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK';
/** staged generation 冲突的稳定 IPC code。 */
export const CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE = 'E_CLOUD_CREDENTIALS_GENERATION_CONFLICT';
/** 与 ZIP 全保真导出 `MIN_ENCRYPTION_PASSWORD_CHARS` 对齐。 */
export const MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS = 8;
/** 新设口令最少需要的不同 Unicode 码点数。 */
export const MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS = 4;

const ERROR_PREFIX: Record<SecureStoreErrorKind, string> = {
  KeychainUnavailable: 'Keychain不可用: ',
  KeyNotFound: '密钥不存在: ',
  AccessDenied: '访问被拒绝: ',
  PlatformUnsupported: '平台不支持: ',
  SerializationError: '序列化错误: ',
  EncryptionError: '加密错误: ',
  Other: '其他错误: ',
  CloudEncryptionPasswordTooShort: '',
  CloudEncryptionPasswordTooWeak: '',
  CloudCredentialGenerationConflict: '',
};

const STABLE_CODE: Record<SecureStoreErrorKind, string> = {
  KeychainUnavailable: 'SECURE_STORE_UNAVAILABLE',
  PlatformUnsupported: 'SECURE_STORE_UNAVAILABLE',
  KeyNotFound: 'SECURE_STORE_KEY_NOT_FOUND',
  AccessDenied: 'SECURE_STORE_ACCESS_DENIED',
  SerializationError: 'SECURE_STORE_DATA_INVALID',
  EncryptionError: 'SECURE_STORE_CRYPTO_ERROR',
  CloudEncryptionPasswordTooShort: CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
  CloudEncryptionPasswordTooWeak: CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE,
  CloudCredentialGenerationConflict: CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE,
  Other: 'SECURE_STORE_INTERNAL',
};

/** dstu-core `CommandError` 的 serde 形状（camelCase，`data`/`traceId` 缺省时省略）。 */
export interface CommandErrorEnvelope {
  code: string;
  message: string;
  data?: unknown;
  traceId?: string;
}

/**
 * 对应 Rust `SecureStoreError`。`message` = thiserror 的 Display（中文前缀 + 详情），
 * `detail` = 变体携带的字符串。
 */
export class SecureStoreError extends Error {
  readonly kind: SecureStoreErrorKind;
  readonly detail: string;
  constructor(kind: SecureStoreErrorKind, detail: string) {
    super(ERROR_PREFIX[kind] + detail);
    this.name = 'SecureStoreError';
    this.kind = kind;
    this.detail = detail;
  }
  /** IPC 稳定错误码（`stable_code()`）。 */
  get stableCode(): string {
    return STABLE_CODE[this.kind];
  }
  /** `retryable` 字段：仅 KeychainUnavailable / AccessDenied / PlatformUnsupported。 */
  get retryable(): boolean {
    return this.kind === 'KeychainUnavailable' || this.kind === 'AccessDenied' || this.kind === 'PlatformUnsupported';
  }
  /** `to_command_error(operation)`：`{code, message, data:{operation, retryable}}`。 */
  toCommandError(operation: string): CommandErrorEnvelope {
    return { code: this.stableCode, message: this.message, data: { operation, retryable: this.retryable } };
  }
}

// ------------------------------------------------------------------ 平台密钥库

/**
 * 根种子的平台密钥库（macOS Keychain / Linux Secret Service）。
 * `load` 返回 `null` 表示条目不存在；reject 表示密钥库不可用/拒绝访问（消息原样进入错误详情）。
 */
export interface SeedKeystore {
  /** 'macOS Keychain' | 'Secret Service'（日志与可行动错误信息用）。 */
  readonly backendName: string;
  load(fingerprint: string): Promise<string | null>;
  store(fingerprint: string, seed: string): Promise<void>;
}

/** 「系统钥匙串保护」状态（`secure_store_get_keystore_protection` 的返回值，camelCase）。 */
export interface KeystoreProtectionStatus {
  supported: boolean;
  enabled: boolean;
  seedInKeystore: boolean;
}

// ------------------------------------------------------------------ 云存储凭据

/** serde camelCase；`undefined` 字段序列化时省略（`skip_serializing_if = "Option::is_none"`）。 */
export interface CloudStorageCredentials {
  webdavPassword?: string;
  s3SecretAccessKey?: string;
  ftpPassword?: string;
  encryptionPassword?: string;
}

/** 只含存在性的状态（绝不含 secret 值），字段顺序与 Rust 序列化一致。 */
export interface CloudStorageCredentialStatus {
  webdavPasswordConfigured: boolean;
  s3SecretAccessKeyConfigured: boolean;
  ftpPasswordConfigured: boolean;
  encryptionPasswordConfigured: boolean;
}

// ------------------------------------------------------------------ SecureStore

export interface SecureStore {
  /** `<root>/.secure`（`new_with_dir`）或 legacy 回退目录（`new`）。 */
  readonly secureDir: string;
  /** `SecureStoreConfig.enabled`（恒为 true，除非构造时关闭）。 */
  readonly enabled: boolean;

  saveSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  /** 文件不存在视为成功；不创建目录、不修复权限。 */
  deleteSecret(key: string): Promise<void>;
  /** 扫描 `*.enc` 的文件名主干（已做 `/`、`\` → `_` 替换的键名）。 */
  listSensitiveKeys(): Promise<Set<string>>;
  /** 实际解析/初始化设备密钥；种子不可解封时返回 false。 */
  isAvailable(): Promise<boolean>;
  /** 只读文件系统，不触碰密钥库。 */
  keystoreProtectionStatus(): Promise<KeystoreProtectionStatus>;
  /** 开启/关闭系统钥匙串保护并立即迁移种子（失败回滚标记）。 */
  setKeystoreProtection(enabled: boolean): Promise<void>;

  // 云存储凭据（active / staged / generation pointer 三条记录）
  saveCloudCredentials(credentials: CloudStorageCredentials): Promise<void>;
  getCloudCredentials(): Promise<CloudStorageCredentials | null>;
  /** 合并非空字段；`encryptionPasswordIsPreexisting` 缺省 false（新设口令走长度/弱口令门）。 */
  updateCloudCredentials(
    update: CloudStorageCredentials,
    encryptionPasswordIsPreexisting?: boolean,
  ): Promise<CloudStorageCredentialStatus>;
  cloudCredentialStatus(): Promise<CloudStorageCredentialStatus>;
  clearCloudEncryptionPassword(): Promise<CloudStorageCredentialStatus>;
  deleteCloudCredentials(): Promise<void>;
  /** u64；缺 pointer = 0n。 */
  cloudCredentialsActiveGeneration(): Promise<bigint>;
  writeStagedCloudCredentials(update: CloudStorageCredentials, encryptionPasswordIsPreexisting: boolean): Promise<bigint>;
  commitStagedCloudCredentials(expectedGeneration: bigint): Promise<void>;
  abortStagedCloudCredentials(expectedGeneration: bigint): Promise<void>;
  deleteCloudCredentialsTransactional(): Promise<void>;
}

export interface OpenSecureStoreOptions {
  /** 默认 true。 */
  enabled?: boolean;
  /**
   * 覆盖平台密钥库。缺省 = 当前平台的真实实现（macOS/Linux），Windows 或
   * `DEEP_STUDENT_KEY_SEED_FILE_ONLY` 生效时为 null。测试用 null 或内存实现注入，绝不触碰真实钥匙串。
   */
  keystore?: SeedKeystore | null;
}

// ------------------------------------------------------------------ CryptoService（.master_key）

/** `EncryptedData`：字段顺序 ciphertext, nonce, version；version 缺省序列化为 null。 */
export interface EncryptedData {
  ciphertext: string;
  nonce: string;
  version: number | null;
}

export interface CryptoService {
  /** `<dir>/.master_key`。 */
  readonly keyPath: string;
  /** SHA-256(master_key) 前 4 字节 hex（日志指纹）。 */
  readonly keyFingerprint: string;
  encryptApiKey(plaintext: string): EncryptedData;
  decryptApiKey(data: EncryptedData): string;
  /** `serde_json::to_string(&encrypt_api_key(p))`。 */
  migratePlaintextKey(plaintext: string): string;
  verifyKeyIntegrity(): boolean;
  /** 在 `newDir` 强制生成新 `.master_key`（覆盖），旧密文不再可解。 */
  rotateMasterKey(newDir: string): Promise<CryptoService>;
}

// ------------------------------------------------------------------ DSBK 备份加密（crypto/backup_crypto.rs）

/** `PasswordVerifier`（serde camelCase）：`digest = SHA-256(domain ‖ Argon2id(password, salt))`。 */
export interface PasswordVerifier {
  kdf: string;
  mCost: number;
  tCost: number;
  pCost: number;
  /** hex */
  salt: string;
  /** hex（32 字节） */
  digest: string;
}

/** `FirstChunkPlan`。 */
export type FirstChunkPlan = { kind: 'StreamV2'; prefixLen: number } | { kind: 'LegacyV1WholeFile' };

/** `FileCipherSession`：一次派生、跨对象复用密钥；用完调用 `dispose()` 清零密钥材料。 */
export interface FileCipherSession {
  /** DSBK v1 单块。 */
  encryptBytes(plaintext: Uint8Array): Promise<Uint8Array>;
  decryptBytes(data: Uint8Array): Promise<Uint8Array>;
  /** DSBK v2 分块流式。 */
  encryptFile(input: string, output: string): Promise<void>;
  /** v1/v2 均可。 */
  decryptFile(input: string, output: string): Promise<void>;
  /** 同 `encryptFile`，读写端为 Web Streams；流的所有权见 `BackupCrypto.encryptBackupStream`。 */
  encryptStream(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>): Promise<void>;
  /** 同 `decryptFile`，读写端为 Web Streams。 */
  decryptStream(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>): Promise<void>;
  dispose(): void;
}

/** 本机「该云端目录曾经加密」记忆（`EncryptedRootMemory`）。 */
export interface EncryptedRootMemoryStore {
  readonly path: string;
  remember(fingerprint: string): Promise<void>;
  /** 文件不存在 → false；无法读取/解析 → true（fail-closed）。 */
  wasEncrypted(fingerprint: string): Promise<boolean>;
}

/** Optional dependencies of the public instance-scoped backup factory. */
export interface BackupCryptoOptions {
  /** Optional instance-owned raw Argon2id service. F4 still owns validation,
   * error wrapping and wiping. Each derivation returns a fresh writable key
   * allocation whose ownership passes to F4. Absent: retain legacy Node/noble.
   */
  readonly nativeArgon2?: import('../native/api.ts').NativeArgon2;
}

export { createBackupCrypto } from './backup-crypto.ts';

/** 错误为 `BackupCryptoError`（message 同 Rust anyhow 文案）。 */
export interface BackupCrypto {
  /** DSBK v1，默认参数 m=65536 KiB、t=3、p=4。 */
  encryptBackup(plaintext: Uint8Array, password: string): Promise<Uint8Array>;
  decryptBackup(data: Uint8Array, password: string): Promise<Uint8Array>;
  /** DSBK v2，1 MiB 分块。 */
  encryptBackupFile(input: string, output: string, password: string): Promise<void>;
  decryptBackupFile(input: string, output: string, password: string): Promise<void>;
  /**
   * `encryptBackupFile` / `decryptBackupFile` 的 Web Streams 版：字节与错误文案相同，解密兼容 v1/v2。
   * 调用即锁定两端。成功时读到 EOF 并 `close()` output（关闭失败 = Rust「刷新…输出失败」）；
   * 任何失败都 `cancel()` input、`abort()` output 后抛出，output 负责丢弃已写出的部分
   * （例如 `ctx.files.openWrite(path, { mode: 'atomic' })` 不落盘）。v2 解密逐块认证后写出，
   * v1 整段认证后一次写出。写给 output 的分块归 output 所有。
   */
  encryptBackupStream(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>, password: string): Promise<void>;
  decryptBackupStream(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>, password: string): Promise<void>;
  isEncryptedBackup(data: Uint8Array): boolean;
  /**
   * 首块试解链对应 Rust `object_len: u64`：超过 2^53 的对象长度必须传 bigint（完整 u64 范围）；
   * number 只接受非负安全整数，否则抛 RangeError。返回的前缀长度有上界（≤ 64 MiB + 60），恒为 number。
   */
  dsbkFirstChunkSpeculativePrefixLen(objectLen: number | bigint): number;
  planFirstChunkTrial(head: Uint8Array, objectLen: number | bigint): FirstChunkPlan;
  trialDecryptFirstChunk(prefix: Uint8Array, objectLen: number | bigint, password: string): Promise<void>;
  /** 缺省参数 = 默认参数；新写入面受 KDF 上限约束。 */
  createFileCipherSession(password: string, params?: { mCost: number; tCost: number; pCost: number }): Promise<FileCipherSession>;
  createPasswordVerifier(password: string): Promise<PasswordVerifier>;
  /** true 一致 / false 不一致 / reject 无法校验（fail-closed）。 */
  checkPasswordVerifier(password: string, verifier: PasswordVerifier): Promise<boolean>;
  encryptedRootMemory(path: string): EncryptedRootMemoryStore;
  /** SHA-256("deep-student.encrypted-root-memory.v1" ‖ hint) hex。 */
  encryptedRootFingerprint(bindingHint: string): string;
}

// ------------------------------------------------------------------ 密钥发布 journal（crypto_publication.rs）

/** `CryptoPublicationJournal`（磁盘上为 snake_case JSON）。 */
export interface CryptoPublicationJournal {
  version: number;
  backupId: string | null;
  targetSlot: string | null;
  hadOldMaster: boolean;
  hadOldSecure: boolean;
  installsMaster: boolean;
  installsSecure: boolean;
  createdAt: string;
}

export type CryptoPublicationRecovery = 'Clean' | 'RolledForward' | 'RolledBack';

/** 错误：`CryptoPublicationError`（kind `InvalidData`）或底层 fs 错误。 */
export interface CryptoPublication {
  journalPath(appDataRoot: string): string;
  rollbackDir(appDataRoot: string): string;
  writeJournal(appDataRoot: string, journal: CryptoPublicationJournal): Promise<void>;
  removeJournal(appDataRoot: string): Promise<void>;
  /** 启动时收敛：`activeLease` = 已持久化的 restore cutover lease `[backupId, targetSlot]`。 */
  recover(appDataRoot: string, activeLease: readonly [string, string] | null): Promise<CryptoPublicationRecovery>;
}

// ------------------------------------------------------------------ 服务

export interface SecretsService {
  /** `SecureStore::new_with_dir(config, appDataDir)` → `<appDataDir>/.secure`。 */
  openStore(appDataDir: string, options?: OpenSecureStoreOptions): SecureStore;
  /** `SecureStore::new(config)`：`dirs::data_local_dir()/deep-student/.secure`（失败回退 temp）。 */
  openFallbackStore(options?: OpenSecureStoreOptions): SecureStore;
  /** `SecureStore::is_sensitive_key`。 */
  isSensitiveKey(key: string): boolean;
  /** 当前平台是否支持系统钥匙串保护（`keystore_supported()`）。 */
  keystoreSupported(): boolean;

  /** 备份/恢复用：校验 `.key_seed` 能否在本平台恢复（只读）。 */
  validateBackupSeedFile(seedFile: string, options?: OpenSecureStoreOptions): Promise<void>;
  /** 备份导出用：把 `.key_seed` 解析为明文种子。 */
  resolveSeedFilePlaintext(seedFile: string, options?: OpenSecureStoreOptions): Promise<string>;
  /** 备份导入用：按当前平台重新封装（Windows → DPAPI）；返回是否执行了封装。 */
  resealSeedFileForCurrentPlatform(seedFile: string): Promise<boolean>;
  /** SHA-256("deep-student.key_seed.fingerprint.v1" ‖ seed) 的 hex。 */
  seedFingerprint(seed: string): string;

  /**
   * `CryptoService::new(dir)`：加载或生成 `<dir>/.master_key`。
   * 加密 API Key 用的实例传应用根目录（`ctx.app.dataDir`），不传活动槽目录：备份和恢复读写的是根目录的
   * `.master_key`，启动时 storage 会把槽内已有的主密钥复制到根目录（RF-W07-crypto-root-adopts-slot-master-key）。
   */
  openCrypto(dir: string): Promise<CryptoService>;
  /** `CryptoService::is_encrypted_format`（serde 反序列化 EncryptedData 是否成功）。 */
  isEncryptedFormat(value: string): boolean;
  /** `CryptoService::derive_static_key`：SHA-256(seed)。 */
  deriveStaticKey(seed: string): Uint8Array;

  /** 云端口令准入谓词（与 Rust 同名函数一致）。 */
  cloudEncryptionPasswordTooShort(password: string | null | undefined): boolean;
  cloudEncryptionPasswordTooWeak(password: string | null | undefined): boolean;

  /** DSBK 备份/云同步加密容器、密码校验子、加密目录记忆。 */
  readonly backup: BackupCrypto;
  /** 恢复切槽时 `.master_key`/`.secure` 发布的 journal 与启动侧收敛。 */
  readonly publication: CryptoPublication;
}

export type { Context };

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** F4：凭据安全存储与应用级加密。 */
    secrets: SecretsService;
  }
}
