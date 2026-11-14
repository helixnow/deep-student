/**
 * `cloud_config_commands.rs` 的非敏感云配置模型：形状、规范化校验、严格 serde 解析/序列化，
 * 以及与运行时配置（`RuntimeCloudStorageConfig`）之间的转换和凭据注入。纯函数，不碰存储。
 */

import {
  DESKTOP_CAPABILITIES, FTP_UNSUPPORTED_ON_ANDROID_CODE, FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
  S3_UNSUPPORTED_IN_BUILD_CODE, S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE,
  insecureTransportAuthorized, isLoopbackHost,
  type PlatformStorageCapabilities, type RuntimeCloudStorageConfig,
} from '../../sync-providers/api.ts';
import type { CloudStorageCredentials } from '../../../platform/secrets/api.ts';
import { CommandError } from '../../../kernel/api.ts';

export const CLOUD_CONFIG_INVALID_CODE = 'E_CLOUD_CONFIG_INVALID';

const MAX_ENDPOINT_CHARS = 2_048;
const MAX_IDENTITY_CHARS = 512;
const MAX_ROOT_CHARS = 256;

// Rust str::trim uses Unicode White_Space; String.prototype.trim also strips BOM,
// which Rust keeps.
export const trim = (text: string): string => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const charCount = (text: string): number => Array.from(text).length;
const hasControl = (text: string): boolean => /\p{Cc}/u.test(text);
const hasWhitespace = (text: string): boolean => /\p{White_Space}/u.test(text);

export interface SafeWebDavConfig {
  endpoint: string;
  username: string;
}

export interface SafeS3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  region: string | null;
  pathStyle: boolean;
}

export interface SafeFtpConfig {
  host: string;
  port: number;
  username: string;
  useTls: boolean;
}

export type SafeCloudStorageConfig =
  | { provider: 'webdav'; webdav: SafeWebDavConfig; root: string | null; allow_insecure: boolean }
  | { provider: 's3'; s3: SafeS3Config; root: string | null; allow_insecure: boolean }
  | { provider: 'ftp'; ftp: SafeFtpConfig; root: string | null; allow_insecure: boolean };

export class CloudConfigSsotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CloudConfigSsotError';
    this.code = code;
  }

  toCommandError(): CommandError {
    return new CommandError({ code: this.code, message: this.message });
  }
}

export function invalid(detail: string, code = CLOUD_CONFIG_INVALID_CODE): CloudConfigSsotError {
  return new CloudConfigSsotError(code, `invalid non-secret cloud configuration: ${detail}`);
}

function platformInvalid(code: string, message: string): CloudConfigSsotError {
  return invalid(message, code);
}

function boundedText(value: string, field: string, maxChars: number): string {
  const text = trim(value);
  if (text === '') throw invalid(`${field} must not be blank`);
  if (charCount(text) > maxChars) throw invalid(`${field} exceeds ${maxChars} characters`);
  if (hasControl(text)) throw invalid(`${field} contains control characters`);
  return text;
}

function validatedHttpEndpoint(value: string, field: string): { endpoint: string; url: URL } {
  const endpoint = boundedText(value, field, MAX_ENDPOINT_CHARS);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid(`${field} must be a valid URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
    throw invalid(`${field} must use http or https and include a host`);
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid(`${field} must not embed credentials`);
  }
  return { endpoint, url };
}

function validatedRoot(root: string | null | undefined): string | null {
  if (root === null || root === undefined) return null;
  const value = trim(trim(root).replace(/^\/+|\/+$/g, ''));
  if (value === '') return null;
  if (
    charCount(value) > MAX_ROOT_CHARS
    || hasControl(value)
    || value.includes('\\')
    || value.split('/').some(component => component === '' || component === '.' || component === '..')
  ) {
    throw invalid('root must be a bounded relative cloud key without traversal');
  }
  return value;
}

export function validateAndNormalize(
  config: SafeCloudStorageConfig,
  capabilities: PlatformStorageCapabilities = DESKTOP_CAPABILITIES,
): SafeCloudStorageConfig {
  switch (config.provider) {
    case 'webdav': {
      const { endpoint, url } = validatedHttpEndpoint(config.webdav.endpoint, 'webdav.endpoint');
      const loopback = isLoopbackHost(url.hostname);
      const insecure = url.protocol === 'http:' && !loopback;
      if (insecure && !config.allow_insecure) {
        throw invalid('public HTTP WebDAV requires persisted allowInsecure=true');
      }
      return {
        provider: 'webdav',
        webdav: {
          endpoint,
          username: boundedText(config.webdav.username, 'webdav.username', MAX_IDENTITY_CHARS),
        },
        root: validatedRoot(config.root),
        allow_insecure: insecure && config.allow_insecure,
      };
    }
    case 's3': {
      if (!capabilities.s3Supported) {
        throw platformInvalid(S3_UNSUPPORTED_IN_BUILD_CODE, S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE);
      }
      const { endpoint, url } = validatedHttpEndpoint(config.s3.endpoint, 's3.endpoint');
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
        throw invalid('public S3 endpoints must use HTTPS');
      }
      const region = config.s3.region === null || config.s3.region === undefined
        ? null
        : boundedText(config.s3.region, 's3.region', MAX_IDENTITY_CHARS);
      return {
        provider: 's3',
        s3: {
          endpoint,
          bucket: boundedText(config.s3.bucket, 's3.bucket', MAX_IDENTITY_CHARS),
          accessKeyId: boundedText(config.s3.accessKeyId, 's3.accessKeyId', MAX_IDENTITY_CHARS),
          region,
          pathStyle: config.s3.pathStyle === true,
        },
        root: validatedRoot(config.root),
        allow_insecure: false,
      };
    }
    case 'ftp': {
      if (!capabilities.ftpSupported) {
        throw platformInvalid(FTP_UNSUPPORTED_ON_ANDROID_CODE, FTP_UNSUPPORTED_ON_ANDROID_MESSAGE);
      }
      const port = config.ftp.port ?? 21;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw invalid('ftp.port must be between 1 and 65535');
      }
      const host = boundedText(config.ftp.host, 'ftp.host', MAX_ENDPOINT_CHARS);
      if (host.includes('://') || host.includes('/') || host.includes('@') || hasWhitespace(host)) {
        throw invalid('ftp.host must be a hostname or IP address without scheme or credentials');
      }
      const useTls = config.ftp.useTls === true;
      const insecure = !useTls && !isLoopbackHost(host);
      if (insecure && !config.allow_insecure) {
        throw invalid('public FTP without TLS requires persisted allowInsecure=true');
      }
      return {
        provider: 'ftp',
        ftp: {
          host,
          port,
          username: boundedText(config.ftp.username, 'ftp.username', MAX_IDENTITY_CHARS),
          useTls,
        },
        root: validatedRoot(config.root),
        allow_insecure: insecure && config.allow_insecure,
      };
    }
  }
}

export function providerName(config: SafeCloudStorageConfig): 'webdav' | 's3' | 'ftp' {
  return config.provider;
}

export function intoRuntimeConfig(config: SafeCloudStorageConfig): RuntimeCloudStorageConfig {
  const runtime: RuntimeCloudStorageConfig = {
    provider: config.provider,
    webdav: null,
    s3: null,
    ftp: null,
    root: config.root,
    encryptionPassword: null,
    [insecureTransportAuthorized]: config.allow_insecure,
  };
  if (config.provider === 'webdav') {
    runtime.webdav = { endpoint: config.webdav.endpoint, username: config.webdav.username, password: '' };
  } else if (config.provider === 's3') {
    runtime.s3 = {
      endpoint: config.s3.endpoint,
      bucket: config.s3.bucket,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: '',
      region: config.s3.region,
      pathStyle: config.s3.pathStyle,
    };
  } else {
    runtime.ftp = {
      host: config.ftp.host,
      port: config.ftp.port,
      username: config.ftp.username,
      password: '',
      useTls: config.ftp.useTls,
    };
  }
  return runtime;
}

/** `apply_cloud_credentials`：安全存储是 secret 的唯一事实源，IPC secret 先被清空。 */
export function applyCloudCredentials(
  config: RuntimeCloudStorageConfig,
  credentials: CloudStorageCredentials | null,
): void {
  const nonBlank = (value: string | null | undefined): string => {
    if (value === null || value === undefined) return '';
    const text = trim(value);
    return text === '' ? '' : value;
  };
  if (config.webdav) config.webdav.password = nonBlank(credentials?.webdavPassword);
  if (config.s3) config.s3.secretAccessKey = nonBlank(credentials?.s3SecretAccessKey);
  if (config.ftp) config.ftp.password = nonBlank(credentials?.ftpPassword);
  const encryption = nonBlank(credentials?.encryptionPassword);
  config.encryptionPassword = encryption === '' ? null : encryption;
}

/** `replace_with_persisted_cloud_config`：非敏感运行时形状只来自 SSOT。 */
export function replaceWithPersistedCloudConfig(
  config: RuntimeCloudStorageConfig,
  persisted: SafeCloudStorageConfig | null,
): void {
  if (persisted === null) {
    config.provider = 'webdav';
    config.webdav = null;
    config.s3 = null;
    config.ftp = null;
    config.root = null;
    config.encryptionPassword = null;
    config[insecureTransportAuthorized] = false;
    return;
  }
  const runtime = intoRuntimeConfig(persisted);
  config.provider = runtime.provider;
  config.webdav = runtime.webdav;
  config.s3 = runtime.s3;
  config.ftp = runtime.ftp;
  config.root = runtime.root;
  config.encryptionPassword = null;
  config[insecureTransportAuthorized] = runtime[insecureTransportAuthorized] === true;
}

/** `apply_draft_credentials`：与 hydrate 相反，只使用本次 IPC 载荷，绝不触碰安全存储。 */
export function applyDraftCredentials(
  config: RuntimeCloudStorageConfig,
  credentials: CloudStorageCredentials,
): void {
  const nonEmpty = (value: string | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    const text = trim(value);
    return text === '' ? null : text;
  };
  if (config.webdav) {
    const password = nonEmpty(credentials.webdavPassword);
    if (password !== null) config.webdav.password = password;
  }
  if (config.s3) {
    const secret = nonEmpty(credentials.s3SecretAccessKey);
    if (secret !== null) config.s3.secretAccessKey = secret;
  }
  if (config.ftp) {
    const password = nonEmpty(credentials.ftpPassword);
    if (password !== null) config.ftp.password = password;
  }
  config.encryptionPassword = nonEmpty(credentials.encryptionPassword);
}

export function serializableConfig(config: SafeCloudStorageConfig): Record<string, unknown> {
  const base: Record<string, unknown> = { provider: config.provider };
  if (config.provider === 'webdav') {
    base.webdav = { endpoint: config.webdav.endpoint, username: config.webdav.username };
  } else if (config.provider === 's3') {
    base.s3 = {
      endpoint: config.s3.endpoint,
      bucket: config.s3.bucket,
      accessKeyId: config.s3.accessKeyId,
      ...(config.s3.region === null ? {} : { region: config.s3.region }),
      pathStyle: config.s3.pathStyle,
    };
  } else {
    base.ftp = {
      host: config.ftp.host,
      port: config.ftp.port,
      username: config.ftp.username,
      useTls: config.ftp.useTls,
    };
  }
  if (config.root !== null) base.root = config.root;
  if (config.allow_insecure) base.allow_insecure = true;
  return base;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unknown field \`${key}\``);
  }
}

export function parseConfigObject(value: unknown): SafeCloudStorageConfig {
  const root = requireObject(value, 'configuration');
  const provider = requireString(root.provider, 'provider');
  if (provider === 'webdav') {
    rejectUnknownFields(root, ['provider', 'webdav', 'root', 'allow_insecure']);
    const webdav = requireObject(root.webdav, 'webdav');
    rejectUnknownFields(webdav, ['endpoint', 'username']);
    return {
      provider,
      webdav: {
        endpoint: requireString(webdav.endpoint, 'webdav.endpoint'),
        username: requireString(webdav.username, 'webdav.username'),
      },
      root: root.root === undefined || root.root === null ? null : requireString(root.root, 'root'),
      allow_insecure: root.allow_insecure === undefined
        ? false
        : requireBoolean(root.allow_insecure, 'allow_insecure'),
    };
  }
  if (provider === 's3') {
    rejectUnknownFields(root, ['provider', 's3', 'root', 'allow_insecure']);
    const s3 = requireObject(root.s3, 's3');
    rejectUnknownFields(s3, ['endpoint', 'bucket', 'accessKeyId', 'region', 'pathStyle']);
    return {
      provider,
      s3: {
        endpoint: requireString(s3.endpoint, 's3.endpoint'),
        bucket: requireString(s3.bucket, 's3.bucket'),
        accessKeyId: requireString(s3.accessKeyId, 's3.accessKeyId'),
        region: s3.region === undefined || s3.region === null ? null : requireString(s3.region, 's3.region'),
        pathStyle: s3.pathStyle === undefined ? false : requireBoolean(s3.pathStyle, 's3.pathStyle'),
      },
      root: root.root === undefined || root.root === null ? null : requireString(root.root, 'root'),
      allow_insecure: root.allow_insecure === undefined
        ? false
        : requireBoolean(root.allow_insecure, 'allow_insecure'),
    };
  }
  if (provider === 'ftp') {
    rejectUnknownFields(root, ['provider', 'ftp', 'root', 'allow_insecure']);
    const ftp = requireObject(root.ftp, 'ftp');
    rejectUnknownFields(ftp, ['host', 'port', 'username', 'useTls']);
    const port = ftp.port === undefined ? 21 : ftp.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error('ftp.port must be an integer between 0 and 65535');
    }
    return {
      provider,
      ftp: {
        host: requireString(ftp.host, 'ftp.host'),
        port,
        username: requireString(ftp.username, 'ftp.username'),
        useTls: ftp.useTls === undefined ? false : requireBoolean(ftp.useTls, 'ftp.useTls'),
      },
      root: root.root === undefined || root.root === null ? null : requireString(root.root, 'root'),
      allow_insecure: root.allow_insecure === undefined
        ? false
        : requireBoolean(root.allow_insecure, 'allow_insecure'),
    };
  }
  throw new Error(`unknown provider \`${provider}\``);
}

/** 严格 serde 形状解析；任何未知字段/类型错误都按 malformed 拒绝。 */
export function parseSafeCloudStorageConfig(value: unknown): SafeCloudStorageConfig {
  try {
    return parseConfigObject(value);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

export function serializeSafeCloudStorageConfig(config: SafeCloudStorageConfig): string {
  return JSON.stringify(serializableConfig(config));
}
