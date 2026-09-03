/**
 * 云存储 API 封装
 * 
 * 提供统一的云存储访问接口，支持 WebDAV 和 S3 兼容存储
 */

import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import { parseCommandErrorEnvelope } from '@/api/tauriClient';
import { getErrorMessage } from './errorUtils';

export const FTP_UNSUPPORTED_ON_ANDROID_CODE = 'E_FTP_UNSUPPORTED_ON_ANDROID';
export const S3_UNSUPPORTED_IN_BUILD_CODE = 'E_S3_UNSUPPORTED_IN_BUILD';
export const CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE = 'E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT';
export const CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE = 'E_CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK';
export const STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED_CODE =
  'E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED';
export const SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE = 'E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED';
export const SYNC_E2EE_WRONG_PASSWORD_CODE = 'E_SYNC_E2EE_WRONG_PASSWORD';
export const SYNC_E2EE_MARKER_CORRUPTED_CODE = 'E_SYNC_E2EE_MARKER_CORRUPTED';
export const SYNC_E2EE_PASSWORD_REQUIRED_CODE = 'E_SYNC_E2EE_PASSWORD_REQUIRED';
export const SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE = 'E_SYNC_E2EE_MEMORY_PERSIST_FAILED';
export const SYNC_E2EE_DOWNGRADE_REJECTED_CODE = 'E_SYNC_E2EE_DOWNGRADE_REJECTED';
export const SYNC_E2EE_CLAIM_CONFLICT_CODE = 'E_SYNC_E2EE_CLAIM_CONFLICT';
export const SYNC_BAD_OBJECT_FAIL_CLOSED_CODE = 'E_SYNC_BAD_OBJECT_FAIL_CLOSED';
export const DG_TOMBSTONE_LIMITER_BUSY_CODE = 'E_DG_TOMBSTONE_LIMITER_BUSY';
export const PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE = 'E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE';
export const SEALED_BACKUP_PASSWORD_REQUIRED_CODE = 'E_BACKUP_SEALED_PASSWORD_REQUIRED';
export const SEALED_BACKUP_DECRYPT_FAILED_CODE = 'E_BACKUP_SEALED_DECRYPT_FAILED';
export const ATOMIC_RESTORE_UNAVAILABLE_CODE = 'E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE';
export const BACKUP_DIR_MISSING_CODE = 'E_BACKUP_DIR_MISSING';
export const RESTORE_DISK_BUDGET_OVERFLOW_CODE = 'E_RESTORE_DISK_BUDGET_OVERFLOW';
export const ZIP_EXPORT_TEMP_MISSING_CODE = 'E_ZIP_EXPORT_TEMP_MISSING';
export const ZIP_EXPORT_COPY_TARGET_FAILED_CODE = 'E_ZIP_EXPORT_COPY_TARGET_FAILED';

/**
 * Whether an imported ZIP's job stats say the archive can replace the data slot.
 *
 * Missing stats (older backends) return true so `restoreBackup` still decides.
 * `partial_archive` or explicit `restorable: false` must not start slot restore.
 */
export function isImportedArchiveSlotRestorable(
  stats: { recovery_kind?: unknown; restorable?: unknown } | null | undefined,
): boolean {
  if (!stats || typeof stats !== 'object') return true;
  if (stats.recovery_kind === 'partial_archive') return false;
  if (stats.restorable === false) return false;
  return true;
}

type ErrorWithCode = Error & { code?: string };

function asErrorRecord(raw: unknown): Record<string, unknown> | null {
  let candidate = raw instanceof Error ? raw.message : raw;
  if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (!text.startsWith('{')) return null;
    try {
      candidate = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return typeof candidate === 'object' && candidate !== null
    ? candidate as Record<string, unknown>
    : null;
}

/**
 * Extract the backend's stable cloud-storage code from either the canonical
 * CommandError envelope or the legacy AppError `{ details: { code } }` shape.
 * Messages are intentionally ignored for dispatch.
 */
export function getCloudStorageErrorCode(error: unknown): string | undefined {
  const envelope = parseCommandErrorEnvelope(error)
    ?? (error instanceof Error ? parseCommandErrorEnvelope(error.message) : null);
  if (envelope) return envelope.code;

  const record = asErrorRecord(error);
  if (record) {
    if (typeof record.code === 'string') return record.code;
    if (typeof record.errorCode === 'string') return record.errorCode;

    const details = typeof record.details === 'object' && record.details !== null
      ? record.details as Record<string, unknown>
      : null;
    if (typeof details?.code === 'string') return details.code;
    if (typeof details?.errorCode === 'string') return details.errorCode;
  }
  return codeFromDiagnosticText(getErrorMessage(error));
}

function codeFromDiagnosticText(text: string): string | undefined {
  // [R5-i18n] 后端用户可见错误的通用惯例是 `[E_...] 中文诊断`（对齐
  // restore_codes.rs / ATOMIC_RESTORE_UNAVAILABLE_CODE 的用法）：优先提取
  // 方括号里的稳定码，新码无须逐个登记即可参与 code-only 映射。
  const bracketed = /\[(E_[A-Z0-9_]+)\]/.exec(text);
  if (bracketed) return bracketed[1];
  // 兜底：旧诊断可能不带方括号、码出现在文案中间。
  if (text.includes(CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE)) {
    return CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE;
  }
  if (text.includes(STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED_CODE)) {
    return STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED_CODE;
  }
  if (text.includes(SYNC_E2EE_MARKER_CORRUPTED_CODE)) {
    return SYNC_E2EE_MARKER_CORRUPTED_CODE;
  }
  if (text.includes(SYNC_E2EE_WRONG_PASSWORD_CODE)) {
    return SYNC_E2EE_WRONG_PASSWORD_CODE;
  }
  if (text.includes(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE)) {
    return SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE;
  }
  if (text.includes(SYNC_E2EE_PASSWORD_REQUIRED_CODE)) {
    return SYNC_E2EE_PASSWORD_REQUIRED_CODE;
  }
  if (text.includes(PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE)) {
    return PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE;
  }
  if (text.includes(SEALED_BACKUP_PASSWORD_REQUIRED_CODE)) {
    return SEALED_BACKUP_PASSWORD_REQUIRED_CODE;
  }
  if (text.includes(SEALED_BACKUP_DECRYPT_FAILED_CODE)) {
    return SEALED_BACKUP_DECRYPT_FAILED_CODE;
  }
  if (text.includes(ATOMIC_RESTORE_UNAVAILABLE_CODE)) {
    return ATOMIC_RESTORE_UNAVAILABLE_CODE;
  }
  return undefined;
}

/**
 * Keep a stable backend code when legacy API wrappers normalize an invoke
 * rejection into `Error`; CloudStorageSection can then localize by code.
 */
export function normalizeCloudStorageError(error: unknown): ErrorWithCode {
  const normalized = new Error(getErrorMessage(error)) as ErrorWithCode;
  normalized.code = getCloudStorageErrorCode(error);
  return normalized;
}

export type CloudPlatformErrorI18nKey =
  | 'cloudStorage:errors.ftpDisabledAndroid'
  | 'cloudStorage:errors.s3DisabledInBuild';

export type CloudEncryptionErrorI18nKey =
  | 'cloudStorage:encryption.tooShort'
  | 'cloudStorage:encryption.tooWeak'
  | 'cloudStorage:encryption.storedPasswordRequired';

/** Platform capability errors are localized exclusively by stable backend code. */
export function getCloudPlatformErrorI18nKey(
  error: unknown,
): CloudPlatformErrorI18nKey | undefined {
  switch (getCloudStorageErrorCode(error)) {
    case FTP_UNSUPPORTED_ON_ANDROID_CODE:
      return 'cloudStorage:errors.ftpDisabledAndroid';
    case S3_UNSUPPORTED_IN_BUILD_CODE:
      return 'cloudStorage:errors.s3DisabledInBuild';
    default:
      return undefined;
  }
}

/** Short-password / stored-password refusals prefer stable code, then message token. */
export function getCloudEncryptionErrorI18nKey(
  error: unknown,
): CloudEncryptionErrorI18nKey | undefined {
  switch (getCloudStorageErrorCode(error)) {
    case CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE:
      return 'cloudStorage:encryption.tooShort';
    case CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE:
      return 'cloudStorage:encryption.tooWeak';
    case STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED_CODE:
      return 'cloudStorage:encryption.storedPasswordRequired';
    default:
      return undefined;
  }
}

// ============== 类型定义 ==============

/** 存储提供商类型 */
export type StorageProvider = 'webdav' | 's3' | 'ftp';

/** WebDAV 配置 */
export interface WebDavConfig {
  endpoint: string;
  username: string;
  password: string;
}

/** S3 兼容存储配置 */
export interface S3Config {
  /** S3 endpoint URL */
  endpoint: string;
  /** 存储桶名称 */
  bucket: string;
  /** Access Key ID */
  accessKeyId: string;
  /** Secret Access Key */
  secretAccessKey: string;
  /** 区域（可选） */
  region?: string;
  /** 是否使用 path-style 地址（MinIO 等需要） */
  pathStyle?: boolean;
}

/** FTP/FTPS 配置 */
export interface FtpConfig {
  /** FTP 服务器主机名或 IP 地址 */
  host: string;
  /** FTP 端口（默认 21） */
  port?: number;
  /** 用户名 */
  username: string;
  /** 密码 */
  password: string;
  /** 是否使用 TLS（FTPS 显式加密） */
  useTls?: boolean;
}

/** 云存储配置 */
export interface CloudStorageConfig {
  /** 存储提供商类型 */
  provider: StorageProvider;
  /** WebDAV 配置 */
  webdav?: WebDavConfig;
  /** S3 配置 */
  s3?: S3Config;
  /** FTP 配置 */
  ftp?: FtpConfig;
  /** 根目录路径 */
  root?: string;
  /**
   * Persisted acknowledgement for public cleartext WebDAV/FTP.
   * Loopback endpoints never require this override.
   */
  allowInsecure?: boolean;
  /** 端到端加密密码（可选）
   *
   * 非空时后端上传 ZIP 前会用 AES-256-GCM + Argon2id 加密，下载时自动解密。
   * 密码存储在系统安全存储（与 webdav/s3 凭据同机制）。
   */
  encryptionPassword?: string;
}

/** Credential-free cloud configuration persisted for backend Agent sync. */
export type SafeCloudStorageConfig =
  | {
      provider: 'webdav';
      webdav: Pick<WebDavConfig, 'endpoint' | 'username'>;
      root?: string;
      allowInsecure?: boolean;
    }
  | {
      provider: 's3';
      s3: Pick<S3Config, 'endpoint' | 'bucket' | 'accessKeyId' | 'region' | 'pathStyle'>;
      root?: string;
      allowInsecure?: boolean;
    }
  | {
      provider: 'ftp';
      ftp: Pick<FtpConfig, 'host' | 'port' | 'username' | 'useTls'>;
      root?: string;
      allowInsecure?: boolean;
    };

export interface CloudConfigSsotResponse {
  configured: boolean;
  provider?: StorageProvider;
  root?: string;
  config?: SafeCloudStorageConfig;
}

/**
 * Convert the UI configuration into the exclusive, credential-free DTO
 * accepted by the backend SSOT command. Inactive provider blocks and every
 * secret field are dropped rather than serialized as empty placeholders.
 */
export function toSafeCloudStorageConfig(config: CloudStorageConfig): SafeCloudStorageConfig {
  switch (config.provider) {
    case 'webdav': {
      if (!config.webdav) throw new Error(i18next.t('backend_errors:cloud_storage.missing_webdav_config'));
      return {
        provider: 'webdav',
        webdav: {
          endpoint: config.webdav.endpoint,
          username: config.webdav.username,
        },
        ...(config.root ? { root: config.root } : {}),
        ...(config.allowInsecure ? { allowInsecure: true } : {}),
      };
    }
    case 's3': {
      if (!config.s3) throw new Error(i18next.t('backend_errors:cloud_storage.missing_s3_config'));
      return {
        provider: 's3',
        s3: {
          endpoint: config.s3.endpoint,
          bucket: config.s3.bucket,
          accessKeyId: config.s3.accessKeyId,
          ...(config.s3.region ? { region: config.s3.region } : {}),
          pathStyle: config.s3.pathStyle ?? false,
        },
        ...(config.root ? { root: config.root } : {}),
        ...(config.allowInsecure ? { allowInsecure: true } : {}),
      };
    }
    case 'ftp': {
      if (!config.ftp) throw new Error('Missing FTP configuration');
      return {
        provider: 'ftp',
        ftp: {
          host: config.ftp.host,
          port: config.ftp.port ?? 21,
          username: config.ftp.username,
          useTls: config.ftp.useTls ?? false,
        },
        ...(config.root ? { root: config.root } : {}),
        ...(config.allowInsecure ? { allowInsecure: true } : {}),
      };
    }
  }
}

/** Rebuild a runtime DTO with explicit empty secret placeholders. */
export function fromSafeCloudStorageConfig(config: SafeCloudStorageConfig): CloudStorageConfig {
  switch (config.provider) {
    case 'webdav':
      return {
        provider: 'webdav',
        webdav: { ...config.webdav, password: '' },
        root: config.root,
        allowInsecure: config.allowInsecure ?? false,
      };
    case 's3':
      return {
        provider: 's3',
        s3: { ...config.s3, secretAccessKey: '' },
        root: config.root,
        allowInsecure: false,
      };
    case 'ftp':
      return {
        provider: 'ftp',
        ftp: { ...config.ftp, password: '' },
        root: config.root,
        allowInsecure: config.allowInsecure ?? false,
      };
  }
}

/**
 * The only cloud-config shape permitted on routine IPC calls.
 * Secrets are absent from the persisted DTO and rebuilt as empty placeholders
 * solely because the legacy Rust runtime type requires those fields.
 */
export function toRuntimeCloudStorageConfig(config: CloudStorageConfig): CloudStorageConfig {
  const runtime = fromSafeCloudStorageConfig(toSafeCloudStorageConfig(config));
  // `allowInsecure` is a persisted decision, not an IPC capability. The Rust
  // runtime rebuilds it from the backend SSOT and rejects forged payload flags.
  delete runtime.allowInsecure;
  return runtime;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return octets.length === 4
    && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 127;
}

/** Whether an HTTP endpoint targets a non-loopback host. Invalid URLs are false. */
export function isPublicHttpEndpoint(endpointValue: string): boolean {
  try {
    const endpoint = new URL(endpointValue);
    return endpoint.protocol === 'http:' && !isLoopbackHost(endpoint.hostname);
  } catch {
    return false;
  }
}

/** Whether this configuration needs a persisted cleartext-transport opt-in. */
export function requiresInsecureTransportOptIn(config: CloudStorageConfig): boolean {
  if (config.provider === 'webdav' && config.webdav) {
    return isPublicHttpEndpoint(config.webdav.endpoint);
  }
  if (config.provider === 'ftp' && config.ftp) {
    return !config.ftp.useTls && !isLoopbackHost(config.ftp.host);
  }
  return false;
}

// ============== 前端本地配置存储（非敏感信息） ==============

/** CloudStorageSection 使用的配置存储 key（仅存储非敏感信息） */
export const CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY = 'cloud_storage_config_v2';
export const CLOUD_STORAGE_LEGACY_STORAGE_KEY = 'cloud_storage_config';
export const CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY = 'cloud_storage_ssot_migrated_v1';

type CloudConfigStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): CloudConfigStorage | null {
  return typeof window !== 'undefined' ? window.localStorage : null;
}

function writeSafeCloudConfigCache(
  storage: CloudConfigStorage,
  config: SafeCloudStorageConfig,
): void {
  storage.setItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY, JSON.stringify(config));
}

/**
 * 从 localStorage 读取云存储配置（不包含安全存储中的敏感凭据）
 *
 * 注意：这里返回的是“安全配置”（password / secretAccessKey 通常为空字符串）。
 */
export function loadStoredCloudStorageConfigSafe(): CloudStorageConfig | null {
  const storage = browserStorage();
  if (!storage) return null;
  const raw = storage.getItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CloudStorageConfig;
    const safe = toSafeCloudStorageConfig(parsed);
    writeSafeCloudConfigCache(storage, safe);
    return fromSafeCloudStorageConfig(safe);
  } catch {
    return null;
  }
}

export async function saveCloudConfigSsot(
  config: CloudStorageConfig,
): Promise<CloudConfigSsotResponse> {
  return invoke<CloudConfigSsotResponse>('cloud_config_ssot_save', {
    config: toSafeCloudStorageConfig(config),
  });
}

export async function getCloudConfigSsot(): Promise<CloudConfigSsotResponse> {
  return invoke<CloudConfigSsotResponse>('cloud_config_ssot_get');
}

export async function clearCloudConfigSsot(): Promise<CloudConfigSsotResponse> {
  return invoke<CloudConfigSsotResponse>('cloud_config_ssot_clear');
}

// ============== 草稿测试 / 发布（配置事务边界） ==============

/** `cloud_config_test_connection_draft` 的返回。连接失败走 rejection。 */
export interface CloudConfigDraftTestResponse {
  ok: boolean;
  /** 当前 active 凭据 generation；草稿测试只读，绝不 bump。 */
  generation: number;
}

/**
 * `cloud_config_publish` 的返回：后端在一次逻辑提交内写入凭据与非敏感
 * 配置（任何一步失败保持旧 generation 与旧 SSOT）。secret 值不回传；
 * 凭据存在旗标另经只读的 `getCredentialStatus` 获取。
 */
export interface CloudConfigPublishResponse {
  ok: boolean;
  /** 提交成功后的新 active generation。 */
  generation: number;
  provider: StorageProvider;
  root?: string;
  config: SafeCloudStorageConfig;
}

/**
 * 草稿试连：把当前表单的非敏感配置与凭据一次性传给后端做连接测试。
 * 后端不写安全存储、不改 active SSOT/generation——测试失败的配置只存在
 * 于表单草稿中，永远不会成为「已发布」配置。
 *
 * 凭据空字段表示「草稿缺该凭据」；「空=保留」的合并语义只属于 publish，
 * 不属于草稿测试。
 *
 * 保留后端 CommandError envelope，调用方按稳定 code（SECURE_STORE_* /
 * 平台能力 code）展示可行动提示。
 */
export async function testConnectionDraft(
  config: CloudStorageConfig,
  credentials: CloudStorageCredentials,
  options?: {
    /** 声明草稿携带的是存量加密口令（换机/重装重输），放行 8 字符门。 */
    encryptionPasswordIsPreexisting?: boolean;
  },
): Promise<CloudConfigDraftTestResponse> {
  return invoke<CloudConfigDraftTestResponse>('cloud_config_test_connection_draft', {
    config: toSafeCloudStorageConfig(config),
    credentials,
    encryptionPasswordIsPreexisting: options?.encryptionPasswordIsPreexisting ?? false,
  });
}

/**
 * 发布配置：凭据+非敏感配置由后端 `cloud_config_publish` 作为单个逻辑
 * 提交写入；失败保持旧 generation（旧凭据与旧 SSOT 原样生效），绝不留
 * 「凭据已换、配置还旧」的半更新态。凭据空字段=保留已发布值的合并语义
 * 仅在本命令生效。
 *
 * 保留后端 CommandError envelope，调用方按稳定 code 展示可行动提示。
 */
export async function publishCloudConfig(
  config: CloudStorageConfig,
  credentials: CloudStorageCredentials,
  options?: {
    /** 声明提交的是存量加密口令（换机/重装重输），放行 8 字符门。 */
    encryptionPasswordIsPreexisting?: boolean;
  },
): Promise<CloudConfigPublishResponse> {
  return invoke<CloudConfigPublishResponse>('cloud_config_publish', {
    config: toSafeCloudStorageConfig(config),
    credentials,
    encryptionPasswordIsPreexisting: options?.encryptionPasswordIsPreexisting ?? false,
  });
}

function credentialsFromLegacyConfig(config: CloudStorageConfig): CloudStorageCredentials {
  return {
    webdavPassword: config.webdav?.password || undefined,
    s3SecretAccessKey: config.s3?.secretAccessKey || undefined,
    ftpPassword: config.ftp?.password || undefined,
    encryptionPassword: config.encryptionPassword || undefined,
  };
}

function hasCredentials(credentials: CloudStorageCredentials): boolean {
  return Boolean(
    credentials.webdavPassword
    || credentials.s3SecretAccessKey
    || credentials.ftpPassword
    || credentials.encryptionPassword,
  );
}

/**
 * Resolve cloud configuration with the backend DB as the only authority.
 *
 * localStorage participates only when the backend explicitly returns
 * `configured: false`. The local candidate is migrated once; credentials are
 * committed to secure storage before the non-secret DB record is published.
 * Local secrets are removed only after both writes succeed.
 */
export async function resolveCloudStorageConfig(
  storageOverride?: CloudConfigStorage | null,
): Promise<CloudStorageConfig | null> {
  const storage = storageOverride === undefined ? browserStorage() : storageOverride;
  const backend = await getCloudConfigSsot();

  if (backend.configured) {
    if (!backend.config) {
      throw new Error('Backend cloud configuration is marked configured but missing its DTO');
    }
    if (storage) {
      writeSafeCloudConfigCache(storage, backend.config);
      storage.removeItem(CLOUD_STORAGE_LEGACY_STORAGE_KEY);
      storage.setItem(CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY, '1');
    }
    return fromSafeCloudStorageConfig(backend.config);
  }

  if (!storage) return null;
  if (storage.getItem(CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY) === '1') {
    // A backend miss after a completed migration/previous backend config is a
    // real clear, not permission for a stale cache to resurrect configuration.
    storage.removeItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY);
    storage.removeItem(CLOUD_STORAGE_LEGACY_STORAGE_KEY);
    return null;
  }
  const current = storage.getItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY);
  const legacy = storage.getItem(CLOUD_STORAGE_LEGACY_STORAGE_KEY);
  const raw = current ?? legacy;
  if (!raw) return null;

  const candidate = JSON.parse(raw) as CloudStorageConfig;
  const safe = toSafeCloudStorageConfig(candidate);
  const credentials = credentialsFromLegacyConfig(candidate);
  if (hasCredentials(credentials)) {
    // 迁移携带的是 v0.9.44 时代已经在用的存量口令：按「新设口令」的最小长度
    // 拒绝它会让整个 resolveCloudStorageConfig 抛错，云配置直接解析失败。
    await saveCredentials(credentials, { encryptionPasswordIsPreexisting: true });
  }
  const migrated = await saveCloudConfigSsot(candidate);
  if (!migrated.configured || !migrated.config) {
    throw new Error('Backend rejected the migrated cloud configuration');
  }

  writeSafeCloudConfigCache(storage, migrated.config);
  storage.removeItem(CLOUD_STORAGE_LEGACY_STORAGE_KEY);
  storage.setItem(CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY, '1');
  return fromSafeCloudStorageConfig(migrated.config);
}

/**
 * 加载用于调用后端命令的云存储配置（不含明文凭据）
 *
 * [P0-3A] 敏感字段（密码 / secretAccessKey / 加密密码）一律传空，由后端
 * 各 Tauri 命令在入口处调用 `hydrate_cloud_config` 从系统安全存储自行补全。
 * 明文凭据不再在前端内存与 IPC 通道中往返，仅在用户首次录入时经过一次。
 *
 * 函数名保留 `WithCredentials` 以兼容既有调用方——语义是"可直接用于
 * 需要凭据的后端调用"，而非"对象里携带明文凭据"。
 */
export async function loadStoredCloudStorageConfigWithCredentials(): Promise<CloudStorageConfig | null> {
  return resolveCloudStorageConfig();
}

/** 文件信息 */
export interface FileInfo {
  /** 文件路径 */
  key: string;
  /** 文件大小（字节） */
  size: number;
  /** 最后修改时间 */
  lastModified: string;
  /** ETag（可选） */
  etag?: string;
}

/** 备份版本信息 */
export interface BackupVersion {
  /** 版本 ID（YYYYMMDD-HHMMSS） */
  id: string;
  /** 创建时间 */
  timestamp: string;
  /** 文件大小（字节） */
  size: number;
  /** SHA256 校验和 */
  checksum: string;
  /** 来源设备 ID */
  deviceId: string;
  /** 应用版本 */
  appVersion?: string;
  /** 备注 */
  note?: string;
  /**
   * 导入后能否整槽恢复。旧云端清单没有该字段，按未知处理。
   * `partial_archive` 表示便携/部分归档，不能替换数据槽。
   */
  recoveryKind?: 'disaster_recovery' | 'partial_archive' | string;
}

export function findCloudBackupVersion(
  versionId: string | null | undefined,
  versions: readonly BackupVersion[],
  latest?: BackupVersion | null,
): BackupVersion | undefined {
  if (!versionId) return undefined;
  return versions.find((version) => version.id === versionId)
    ?? (latest?.id === versionId ? latest : undefined);
}

export function isKnownPortableCloudBackup(
  version: Pick<BackupVersion, 'recoveryKind'> | null | undefined,
): boolean {
  return version?.recoveryKind === 'partial_archive';
}

/** [P11] 「本机加密目录记忆」（第二道明文防线）持久化失败状态 */
export interface EncryptionMemoryPersistFailure {
  /** 稳定错误码（恒为 SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE；文案走 i18n） */
  code: string;
  /** 失败发生时间（RFC3339） */
  at: string;
}

/** 同步状态 */
export interface SyncStatus {
  /** 是否已连接 */
  connected: boolean;
  /** 云端版本数 */
  cloudVersionCount: number;
  /** 最新云端版本 */
  latestVersion?: BackupVersion;
  /** 本地最后同步时间 */
  lastSyncTime?: string;
  /** 错误信息 */
  error?: string;
  /** [P11] 上次「本机加密目录记忆」持久化失败（缺省 = 无失败） */
  encryptionMemoryPersistFailure?: EncryptionMemoryPersistFailure;
}

/** 上传结果 */
export interface UploadResult {
  /** 上传的版本信息 */
  version: BackupVersion;
  /** 已清理的旧版本 ID 列表 */
  prunedVersions: string[];
}

/** 下载结果 */
export interface DownloadResult {
  /** 下载的版本信息 */
  version: BackupVersion;
  /** 本地保存路径 */
  localPath: string;
}

// ============== 存储层 API ==============

/**
 * 检查云存储连接（同步引擎内部使用）
 *
 * 该命令由后端从已发布 SSOT + 安全存储 hydrate 凭据，只能验证「已发布」
 * 配置。设置页的测试按钮不要再走这里——草稿测试必须用 `testConnectionDraft`，
 * 否则会拿旧凭据得出与表单草稿无关的结论。
 */
export async function checkConnection(config: CloudStorageConfig): Promise<boolean> {
  try {
    return await invoke<boolean>('cloud_storage_check_connection', {
      config: toRuntimeCloudStorageConfig(config),
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 上传文件到云存储
 */
export async function putFile(
  config: CloudStorageConfig,
  key: string,
  data: Uint8Array
): Promise<void> {
  try {
    await invoke('cloud_storage_put', {
      config: toRuntimeCloudStorageConfig(config),
      key,
      data: Array.from(data),
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 从云存储下载文件
 */
export async function getFile(
  config: CloudStorageConfig,
  key: string
): Promise<Uint8Array | null> {
  try {
    const data = await invoke<number[] | null>('cloud_storage_get', {
      config: toRuntimeCloudStorageConfig(config),
      key,
    });
    return data ? new Uint8Array(data) : null;
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 列出云存储中的文件
 */
export async function listFiles(
  config: CloudStorageConfig,
  prefix: string
): Promise<FileInfo[]> {
  try {
    return await invoke<FileInfo[]>('cloud_storage_list', {
      config: toRuntimeCloudStorageConfig(config),
      prefix,
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 删除云存储中的文件
 */
export async function deleteFile(
  config: CloudStorageConfig,
  key: string
): Promise<void> {
  try {
    await invoke('cloud_storage_delete', {
      config: toRuntimeCloudStorageConfig(config),
      key,
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 获取文件信息
 */
export async function statFile(
  config: CloudStorageConfig,
  key: string
): Promise<FileInfo | null> {
  try {
    return await invoke<FileInfo | null>('cloud_storage_stat', {
      config: toRuntimeCloudStorageConfig(config),
      key,
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 检查文件是否存在
 */
export async function fileExists(
  config: CloudStorageConfig,
  key: string
): Promise<boolean> {
  try {
    return await invoke<boolean>('cloud_storage_exists', {
      config: toRuntimeCloudStorageConfig(config),
      key,
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

// ============== 同步管理 API ==============

/**
 * 获取同步状态
 */
export async function getSyncStatus(config: CloudStorageConfig): Promise<SyncStatus> {
  try {
    return await invoke<SyncStatus>('cloud_sync_get_status', {
      config: toRuntimeCloudStorageConfig(config),
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 列出云端所有备份版本
 */
export async function listVersions(config: CloudStorageConfig): Promise<BackupVersion[]> {
  try {
    return await invoke<BackupVersion[]>('cloud_sync_list_versions', {
      config: toRuntimeCloudStorageConfig(config),
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 上传备份到云端
 */
export async function uploadBackup(
  config: CloudStorageConfig,
  zipPath: string,
  appVersion?: string,
  note?: string,
  recoveryKind?: string,
): Promise<UploadResult> {
  try {
    return await invoke<UploadResult>('cloud_sync_upload', {
      config: toRuntimeCloudStorageConfig(config),
      zipPath,
      appVersion,
      note,
      recoveryKind,
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 从云端下载备份
 * @param versionId 版本 ID（null 表示下载最新版本）
 * @param localDir 本地保存目录
 * @param allowPlaintextHistory [R6-downgrade-optin] 仅本次下载生效的显式确认：
 *   「我知道这是启用加密前的旧明文版本，仍要恢复」。缺省 = 拒绝（后端防降级
 *   默认拒明文，E_SYNC_E2EE_DOWNGRADE_REJECTED）。调用方必须来自用户当次的
 *   显式勾选 + 二次确认，禁止持久化该值或默认传 true。
 */
export async function downloadBackup(
  config: CloudStorageConfig,
  versionId: string | null,
  localDir: string,
  allowPlaintextHistory?: boolean
): Promise<DownloadResult> {
  try {
    return await invoke<DownloadResult>('cloud_sync_download', {
      config: toRuntimeCloudStorageConfig(config),
      versionId,
      localDir,
      allowPlaintextHistory: allowPlaintextHistory === true,
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 删除云端备份版本
 */
export async function deleteVersion(
  config: CloudStorageConfig,
  versionId: string
): Promise<void> {
  try {
    await invoke('cloud_sync_delete_version', {
      config: toRuntimeCloudStorageConfig(config),
      versionId,
    });
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 获取设备 ID
 */
export async function getDeviceId(): Promise<string> {
  try {
    return await invoke<string>('cloud_sync_get_device_id');
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

// ============== 辅助函数 ==============

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * 格式化时间
 */
export function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString();
  } catch {
    return timestamp;
  }
}

/**
 * 创建默认的 WebDAV 配置
 */
export function createWebDavConfig(
  endpoint: string,
  username: string,
  password: string,
  root?: string
): CloudStorageConfig {
  return {
    provider: 'webdav',
    webdav: { endpoint, username, password },
    root,
  };
}

/**
 * 创建默认的 S3 配置
 */
export function createS3Config(
  endpoint: string,
  bucket: string,
  accessKeyId: string,
  secretAccessKey: string,
  options?: { region?: string; pathStyle?: boolean; root?: string }
): CloudStorageConfig {
  return {
    provider: 's3',
    s3: {
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      region: options?.region,
      pathStyle: options?.pathStyle,
    },
    root: options?.root,
  };
}

/**
 * 创建默认的 FTP 配置
 */
export function createFtpConfig(
  host: string,
  username: string,
  password: string,
  options?: { port?: number; useTls?: boolean; root?: string }
): CloudStorageConfig {
  return {
    provider: 'ftp',
    ftp: {
      host,
      port: options?.port ?? 21,
      username,
      password,
      useTls: options?.useTls ?? false,
    },
    root: options?.root,
  };
}

/**
 * 检查 S3 存储是否已启用（编译时 feature）
 */
export async function isS3Enabled(): Promise<boolean> {
  try {
    return await invoke<boolean>('cloud_storage_is_s3_enabled');
  } catch (error: unknown) {
    console.warn('Failed to check S3 feature status:', error);
    return false;
  }
}

// ============== 安全存储 API ==============

/** 云存储凭据（仅包含敏感信息） */
export interface CloudStorageCredentials {
  /** WebDAV 密码 */
  webdavPassword?: string;
  /** S3 Secret Access Key */
  s3SecretAccessKey?: string;
  /** FTP 密码 */
  ftpPassword?: string;
  /** 端到端加密密码 */
  encryptionPassword?: string;
}

/** Secret-presence flags returned by the backend; no credential value is exposed. */
export interface CloudStorageCredentialStatus {
  webdavPasswordConfigured: boolean;
  s3SecretAccessKeyConfigured: boolean;
  ftpPasswordConfigured: boolean;
  encryptionPasswordConfigured: boolean;
}

/**
 * 保存云存储凭据到系统安全存储
 * - macOS: Keychain
 * - Windows: Credential Manager
 * - Linux: Secret Service
 * - Android: AES-GCM 加密文件
 */
export async function saveCredentials(
  credentials: CloudStorageCredentials,
  options?: {
    /**
     * 声明提交的是存量加密口令（换机/重装重输、legacy 配置迁移）。
     * 8 字符下限只是新设口令的准入；v0.9.44 从未限制长度，存量口令必须
     * 放行，否则既有云端密文在产品内永远打不开。
     */
    encryptionPasswordIsPreexisting?: boolean;
  },
): Promise<CloudStorageCredentialStatus> {
  // 保留后端 CommandError envelope，调用方需要稳定 code 展示可行动的密钥库提示。
  return await invoke<CloudStorageCredentialStatus>('secure_save_cloud_credentials', {
    credentials,
    encryptionPasswordIsPreexisting: options?.encryptionPasswordIsPreexisting ?? false,
  });
}

/**
 * 获取系统安全存储中的凭据存在状态。Secret 值永不返回前端。
 */
export async function getCredentialStatus(): Promise<CloudStorageCredentialStatus> {
  return await invoke<CloudStorageCredentialStatus>('secure_get_cloud_credentials');
}

/**
 * 显式停用端到端加密：仅从系统安全存储删除加密密码，
 * WebDAV/S3/FTP 传输凭据保持不变。
 *
 * 保留后端 CommandError envelope，调用方按 SECURE_STORE_* code 展示可行动提示。
 */
export async function clearEncryptionPassword(): Promise<CloudStorageCredentialStatus> {
  return await invoke<CloudStorageCredentialStatus>('secure_clear_cloud_encryption_password');
}

/**
 * 删除云存储凭据
 */
export async function deleteCredentials(): Promise<void> {
  try {
    await invoke('secure_delete_cloud_credentials');
  } catch (error: unknown) {
    throw normalizeCloudStorageError(error);
  }
}

/**
 * 检查安全存储是否可用
 */
export async function isSecureStoreAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>('secure_store_is_available');
  } catch (error: unknown) {
    console.warn('Failed to check secure store availability:', error);
    return false;
  }
}
