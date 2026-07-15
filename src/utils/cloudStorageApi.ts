/**
 * 云存储 API 封装
 * 
 * 提供统一的云存储访问接口，支持 WebDAV 和 S3 兼容存储
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errorUtils';

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
    }
  | {
      provider: 's3';
      s3: Pick<S3Config, 'endpoint' | 'bucket' | 'accessKeyId' | 'region' | 'pathStyle'>;
      root?: string;
    }
  | {
      provider: 'ftp';
      ftp: Pick<FtpConfig, 'host' | 'port' | 'username' | 'useTls'>;
      root?: string;
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
      if (!config.webdav) throw new Error('Missing WebDAV configuration');
      return {
        provider: 'webdav',
        webdav: {
          endpoint: config.webdav.endpoint,
          username: config.webdav.username,
        },
        ...(config.root ? { root: config.root } : {}),
      };
    }
    case 's3': {
      if (!config.s3) throw new Error('Missing S3 configuration');
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
      };
    }
  }
}

// ============== 前端本地配置存储（非敏感信息） ==============

/** CloudStorageSection 使用的配置存储 key（仅存储非敏感信息） */
export const CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY = 'cloud_storage_config_v2';

/**
 * 从 localStorage 读取云存储配置（不包含安全存储中的敏感凭据）
 *
 * 注意：这里返回的是“安全配置”（password / secretAccessKey 通常为空字符串）。
 */
export function loadStoredCloudStorageConfigSafe(): CloudStorageConfig | null {
  const storage = typeof window !== 'undefined' ? window.localStorage : undefined;
  if (!storage) return null;
  const raw = storage.getItem(CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CloudStorageConfig;
  } catch {
    return null;
  }
}

export async function saveCloudConfigSsot(
  config: CloudStorageConfig,
): Promise<CloudConfigSsotResponse> {
  return invoke<CloudConfigSsotResponse>('data_governance_save_cloud_config_ssot', {
    config: toSafeCloudStorageConfig(config),
  });
}

export async function getCloudConfigSsot(): Promise<CloudConfigSsotResponse> {
  return invoke<CloudConfigSsotResponse>('data_governance_get_cloud_config_ssot');
}

export async function clearCloudConfigSsot(): Promise<CloudConfigSsotResponse> {
  return invoke<CloudConfigSsotResponse>('data_governance_clear_cloud_config_ssot');
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
  const safe = loadStoredCloudStorageConfigSafe();
  if (!safe) return null;

  if (safe.provider === 'webdav') {
    return {
      ...safe,
      webdav: safe.webdav
        ? {
            ...safe.webdav,
            // 空串占位：后端 hydrate_cloud_config 会从安全存储补全
            password: '',
          }
        : undefined,
      encryptionPassword: undefined,
    };
  }

  if (safe.provider === 'ftp') {
    return {
      ...safe,
      ftp: safe.ftp
        ? {
            ...safe.ftp,
            password: '',
          }
        : undefined,
      encryptionPassword: undefined,
    };
  }

  return {
    ...safe,
    s3: safe.s3
      ? {
          ...safe.s3,
          secretAccessKey: '',
        }
      : undefined,
    encryptionPassword: undefined,
  };
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
 * 检查云存储连接
 */
export async function checkConnection(config: CloudStorageConfig): Promise<boolean> {
  try {
    return await invoke<boolean>('cloud_storage_check_connection', { config });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
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
    await invoke('cloud_storage_put', { config, key, data: Array.from(data) });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
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
    const data = await invoke<number[] | null>('cloud_storage_get', { config, key });
    return data ? new Uint8Array(data) : null;
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
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
    return await invoke<FileInfo[]>('cloud_storage_list', { config, prefix });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
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
    await invoke('cloud_storage_delete', { config, key });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
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
    return await invoke<FileInfo | null>('cloud_storage_stat', { config, key });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
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
    return await invoke<boolean>('cloud_storage_exists', { config, key });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
  }
}

// ============== 同步管理 API ==============

/**
 * 获取同步状态
 */
export async function getSyncStatus(config: CloudStorageConfig): Promise<SyncStatus> {
  try {
    return await invoke<SyncStatus>('cloud_sync_get_status', { config });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
  }
}

/**
 * 列出云端所有备份版本
 */
export async function listVersions(config: CloudStorageConfig): Promise<BackupVersion[]> {
  try {
    return await invoke<BackupVersion[]>('cloud_sync_list_versions', { config });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
  }
}

/**
 * 上传备份到云端
 */
export async function uploadBackup(
  config: CloudStorageConfig,
  zipPath: string,
  appVersion?: string,
  note?: string
): Promise<UploadResult> {
  try {
    return await invoke<UploadResult>('cloud_sync_upload', {
      config,
      zipPath,
      appVersion,
      note,
    });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
  }
}

/**
 * 从云端下载备份
 * @param versionId 版本 ID（null 表示下载最新版本）
 * @param localDir 本地保存目录
 */
export async function downloadBackup(
  config: CloudStorageConfig,
  versionId: string | null,
  localDir: string
): Promise<DownloadResult> {
  try {
    return await invoke<DownloadResult>('cloud_sync_download', {
      config,
      versionId,
      localDir,
    });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
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
    await invoke('cloud_sync_delete_version', { config, versionId });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
  }
}

/**
 * 获取设备 ID
 */
export async function getDeviceId(): Promise<string> {
  try {
    return await invoke<string>('cloud_sync_get_device_id');
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
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

/**
 * 保存云存储凭据到系统安全存储
 * - macOS: Keychain
 * - Windows: Credential Manager
 * - Linux: Secret Service
 * - Android: AES-GCM 加密文件
 */
export async function saveCredentials(credentials: CloudStorageCredentials): Promise<void> {
  try {
    await invoke('secure_save_cloud_credentials', { credentials });
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
  }
}

/**
 * 从系统安全存储获取云存储凭据
 */
export async function getCredentials(): Promise<CloudStorageCredentials | null> {
  try {
    return await invoke<CloudStorageCredentials | null>('secure_get_cloud_credentials');
  } catch (error: unknown) {
    console.warn('Failed to get credentials:', error);
    return null;
  }
}

/**
 * 删除云存储凭据
 */
export async function deleteCredentials(): Promise<void> {
  try {
    await invoke('secure_delete_cloud_credentials');
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
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
