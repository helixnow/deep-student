import { isLoopbackHost } from '../../../platform/net-policy/ip.ts';
import { trim } from '../../../platform/util/portable.ts';
import { insecureTransportAuthorized } from '../api.ts';
import type { RuntimeCloudStorageConfig, PlatformStorageCapabilities, StorageProvider, WebDavConfig, S3Config, FtpConfig } from '../api.ts';
import { CloudStorageError } from './errors.ts';
import { utf8Decode, utf8Encode } from './bytes.ts';

// config.rs:24. The desktop Rust profile includes both native transports.
export const DESKTOP_CAPABILITIES: Readonly<PlatformStorageCapabilities> = { ftpSupported: true, s3Supported: true };
// config.rs `PlatformStorageCapabilities::android_release`: no FTP backend, no S3 feature.
export const ANDROID_CAPABILITIES: Readonly<PlatformStorageCapabilities> = { ftpSupported: false, s3Supported: false };
export const FTP_UNSUPPORTED_ON_ANDROID_CODE = 'E_FTP_UNSUPPORTED_ON_ANDROID';
export const FTP_UNSUPPORTED_ON_ANDROID_MESSAGE = 'FTP/FTPS storage is not available on Android.';
export const S3_UNSUPPORTED_IN_BUILD_CODE = 'E_S3_UNSUPPORTED_IN_BUILD';
export const S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE = '当前安装包不支持 S3 兼容存储，请改用 WebDAV。';

/**
 * Providers that exist only on desktop. FTP/FTPS speaks raw TCP + TLS (`node:net` / `node:tls`),
 * which no mobile runtime offers; Rust likewise compiles the FTP backend out of Android
 * (`cloud_storage/mod.rs:51`). Only the desktop entry links these transports; an entry without
 * them rejects the provider with its platform code before any I/O.
 */
export const DESKTOP_ONLY_PROVIDERS = ['ftp'] as const;

export class CloudStorageConfigError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = 'CloudStorageConfigError';
    this.code = code;
  }
}

export function configRoot(config: RuntimeCloudStorageConfig): string {
  return trim(trim(config.root ?? '').replace(/^\/+|\/+$/g, '')) || 'deep-student-sync';
}

export { isLoopbackHost };

export function isLocalEndpoint(endpoint: string): boolean {
  const url = URL.parse(trim(endpoint));
  return url !== null && isLoopbackHost(url.hostname);
}

/** mod.rs:735: `cfg!(feature = "cloud_storage_s3")` expressed through the build capability. */
export function s3EnabledForCapabilities(capabilities: PlatformStorageCapabilities = DESKTOP_CAPABILITIES): boolean {
  return capabilities.s3Supported;
}

export function validateConfig(config: RuntimeCloudStorageConfig, capabilities: PlatformStorageCapabilities = DESKTOP_CAPABILITIES): void {
  const fail = (message: string): never => { throw new CloudStorageConfigError(message); };
  // cloud/mod.rs:228-245 validates the already-deserialized enum, so normalize the
  // externally-tagged map form once here before taking the same branches.
  switch (providerKey(config.provider)) {
    case 'webdav': {
      const dav = config.webdav ?? fail('缺少 WebDAV 配置');
      if (!trim(dav.endpoint)) fail('WebDAV endpoint 不能为空');
      const url = URL.parse(trim(dav.endpoint)) ?? fail('WebDAV endpoint 必须是有效 URL');
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) fail('WebDAV endpoint 必须使用 HTTP(S) 且包含主机');
      if (url.username || url.password) fail('WebDAV endpoint 不得内嵌凭据');
      if (!trim(dav.username)) fail('WebDAV 用户名不能为空');
      if (!trim(dav.password)) fail('WebDAV 密码不能为空');
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !config[insecureTransportAuthorized]) {
        fail('公网 WebDAV 必须使用 HTTPS；HTTP 仅允许 loopback 或已持久化的 allowInsecure 授权');
      }
      return;
    }
    case 's3': {
      if (!capabilities.s3Supported) throw new CloudStorageConfigError(S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE, S3_UNSUPPORTED_IN_BUILD_CODE);
      const s3 = config.s3 ?? fail('缺少 S3 配置');
      if (!trim(s3.endpoint)) fail('S3 endpoint 不能为空');
      if (!trim(s3.bucket)) fail('S3 bucket 不能为空');
      if (!trim(s3.accessKeyId)) fail('S3 Access Key ID 不能为空');
      if (!trim(s3.secretAccessKey)) fail('S3 Secret Access Key 不能为空');
      if (!isLocalEndpoint(s3.endpoint) && !trim(s3.endpoint).toLowerCase().startsWith('https://')) {
        fail('S3 endpoint 必须使用 HTTPS（仅 localhost 允许 HTTP）');
      }
      return;
    }
    case 'ftp': {
      if (!capabilities.ftpSupported) throw new CloudStorageConfigError(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE, FTP_UNSUPPORTED_ON_ANDROID_CODE);
      const ftp = config.ftp ?? fail('缺少 FTP 配置');
      if (!trim(ftp.host)) fail('FTP host 不能为空');
      if (ftp.host.includes('://') || ftp.host.includes('/') || ftp.host.includes('@') || /\p{White_Space}/u.test(ftp.host)) {
        fail('FTP host 必须是无 scheme/凭据的主机名或 IP');
      }
      if (!trim(ftp.username)) fail('FTP 用户名不能为空');
      if (!trim(ftp.password)) fail('FTP 密码不能为空');
      if (!ftp.useTls && !isLoopbackHost(ftp.host) && !config[insecureTransportAuthorized]) {
        fail('公网 FTP 必须启用 TLS；明文 FTP 仅允许 loopback 或已持久化的 allowInsecure 授权');
      }
    }
  }
}

/**
 * The published contract models `StorageProvider` as literals plus single-key maps, but
 * serde emits the plain lowercase literal for unit variants. Normalize before switching.
 * `#[serde(default)]` means an absent provider is WebDAV (config.rs:218).
 */
export function providerKey(provider: StorageProvider | null | undefined): 'webdav' | 's3' | 'ftp' {
  if (provider == null) return 'webdav';
  if (typeof provider === 'string') return provider;
  if ('webdav' in provider) return 'webdav';
  if ('s3' in provider) return 's3';
  return 'ftp';
}

/** cloud/mod.rs:279-285 `platform_capability_app_error`. */
export function platformCapabilityError(code: string, message: string): CloudStorageError {
  return new CloudStorageError('Configuration', message, { code });
}

/** cloud/mod.rs:287-291: platform capability errors become Configuration + details.code. */
export function configErrorToAppError(error: unknown): CloudStorageError {
  if (error instanceof CloudStorageConfigError) {
    if (error.code !== null) {
      return platformCapabilityError(error.code, error.message);
    }
    return new CloudStorageError('Validation', error.message);
  }
  return new CloudStorageError('Unknown', error instanceof Error ? error.message : String(error));
}

export function providerDisplay(provider: StorageProvider): string {
  return { webdav: 'WebDAV', s3: 'S3', ftp: 'FTP' }[providerKey(provider)];
}

export function debugWebDavConfig(config: WebDavConfig): string {
  return `WebDavConfig { endpoint: ${JSON.stringify(config.endpoint)}, username: ${JSON.stringify(config.username)}, password: "[REDACTED]" }`;
}

export function debugS3Config(config: S3Config): string {
  const bytes = utf8Encode(config.accessKeyId);
  const prefix = bytes.length >= 4 && (bytes[4] === undefined || (bytes[4]! & 0xc0) !== 0x80) ? utf8Decode(bytes.subarray(0, 4)) : '?';
  return `S3Config { endpoint: ${JSON.stringify(config.endpoint)}, bucket: ${JSON.stringify(config.bucket)}, access_key_id: ${JSON.stringify(prefix + '...')}, secret_access_key: "[REDACTED]", region: ${config.region == null ? 'None' : `Some(${JSON.stringify(config.region)})`}, path_style: ${config.pathStyle ?? false} }`;
}

export function debugFtpConfig(config: FtpConfig): string {
  return `FtpConfig { host: ${JSON.stringify(config.host)}, port: ${config.port ?? 21}, username: ${JSON.stringify(config.username)}, password: "[REDACTED]", use_tls: ${config.useTls ?? false} }`;
}
