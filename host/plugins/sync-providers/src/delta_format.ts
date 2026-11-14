/**
 * backup-v2 snapshot descriptor and repository config codec (`delta_format.rs`).
 *
 * This module is format-only: schema, limits, encode/decode round-trips and
 * fail-closed rejection. It is not wired into any upload, download, command or UI
 * path; production Cloud backup remains "whole ZIP -> single object put_file".
 *
 * Hard constraints:
 * - every `SnapshotDescriptorV2` is a self-contained complete object table; the
 *   schema denies unknown fields, so any `parent` / `patch` field fails decode and
 *   can never silently become a restore-chain dependency;
 * - `formatVersion` must be exactly 2; future versions fail closed;
 * - every limit (file count, path bytes, objectKey bytes) rejects on overflow and
 *   never truncates;
 * - `BackupV2RepoConfig` carries only format and `idKeyEpoch`, no key material.
 */

import { parseEpochMillis } from './time.ts';
import { utf8Decode, utf8Encode } from './bytes.ts';

/** Fixed snapshot descriptor format string. */
export const SNAPSHOT_V2_FORMAT = 'snapshot-v2';
/** Fixed repository config format string. */
export const BACKUP_V2_FORMAT = 'backup-v2';
/** The only accepted formatVersion; not ">=", future versions must be rejected. */
export const DELTA_FORMAT_VERSION = 2;
/** Maximum logical files a single descriptor may reference. */
export const MAX_SNAPSHOT_FILES = 100_000;
/** Maximum UTF-8 bytes of `logicalPath`. */
export const MAX_LOGICAL_PATH_BYTES = 4096;
/** Maximum UTF-8 bytes of `objectKey`. */
export const MAX_OBJECT_KEY_BYTES = 512;
/** Defensive upper bound for identifiers such as `versionId` / `deviceId`. */
export const MAX_IDENTIFIER_BYTES = 256;

/** A logical file to immutable cloud object reference. */
export interface SnapshotFileRefV2 {
  logicalPath: string;
  size: number;
  plaintextSha256: string;
  objectKey: string;
  objectCipherSha256: string;
}

/** A self-contained complete snapshot descriptor. */
export interface SnapshotDescriptorV2 {
  format: string;
  formatVersion: number;
  versionId: string;
  deviceId: string;
  createdAt: string;
  files: SnapshotFileRefV2[];
  logicalSize: number;
}

/** backup-v2 encrypted repository config plaintext schema. */
export interface BackupV2RepoConfig {
  format: string;
  formatVersion: number;
  idKeyEpoch: number;
}

const U32_MAX = 0xffff_ffff;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

function validation(message: string): Error {
  const error = new Error(message);
  error.name = 'ValidationError';
  return error;
}

function isHexSha256(value: string): boolean {
  return value.length === 64 && /^[0-9a-fA-F]+$/.test(value);
}

function byteLength(value: string): number {
  return utf8Encode(value).byteLength;
}

function validateIdentifier(field: string, value: string): void {
  if (value === '') throw validation(`${field} 不能为空`);
  if (byteLength(value) > MAX_IDENTIFIER_BYTES) {
    throw validation(`${field} 超过 ${MAX_IDENTIFIER_BYTES} 字节上限`);
  }
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)
      || character === '/' || character === '\\') {
      throw validation(`${field} 含控制字符或路径分隔符`);
    }
  }
}

/** Rejects `..`, `.`, absolute paths, empty segments, backslashes and NUL. */
function validateRelativePath(field: string, value: string, maxBytes: number): void {
  if (value === '') throw validation(`${field} 不能为空`);
  if (byteLength(value) > maxBytes) {
    throw validation(`${field} 超过 ${maxBytes} 字节上限（不截断，直接拒绝）`);
  }
  const bytes = utf8Encode(value);
  if (bytes.includes(0)) throw validation(`${field} 含 NUL 字节`);
  if (value.includes('\\')) {
    throw validation(`${field} 含反斜杠；只允许 \`/\` 分隔的相对路径`);
  }
  if (value.startsWith('/')) throw validation(`${field} 不允许绝对路径`);
  if (bytes[1] === 0x3a) throw validation(`${field} 不允许盘符路径`);
  for (const segment of value.split('/')) {
    if (segment === '') {
      throw validation(`${field} 含空路径段（前导/尾随/重复 \`/\`）`);
    }
    if (segment === '.' || segment === '..') {
      throw validation(`${field} 含 \`.\`/\`..\` 路径段，拒绝目录穿越`);
    }
  }
}

/** Full validation of one file reference. */
export function validateSnapshotFileRef(file: SnapshotFileRefV2): void {
  validateRelativePath('logicalPath', file.logicalPath, MAX_LOGICAL_PATH_BYTES);
  validateRelativePath('objectKey', file.objectKey, MAX_OBJECT_KEY_BYTES);
  if (!isHexSha256(file.plaintextSha256)) {
    throw validation('plaintextSha256 必须是 64 位十六进制 SHA-256');
  }
  if (!isHexSha256(file.objectCipherSha256)) {
    throw validation('objectCipherSha256 必须是 64 位十六进制 SHA-256');
  }
}

function u64(value: number, field: string): bigint {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw validation(`${field} 必须是 0..2^53-1 的整数`);
  }
  return BigInt(value);
}

/** Full descriptor validation. */
export function validateSnapshotDescriptor(descriptor: SnapshotDescriptorV2): void {
  if (descriptor.format !== SNAPSHOT_V2_FORMAT) {
    throw validation(`snapshot descriptor format 必须是 ${SNAPSHOT_V2_FORMAT}，实际为 ${descriptor.format}`);
  }
  if (descriptor.formatVersion !== DELTA_FORMAT_VERSION) {
    throw validation(
      `snapshot descriptor formatVersion 必须恰好为 ${DELTA_FORMAT_VERSION}，`
        + `实际为 ${descriptor.formatVersion}；未来版本 fail-closed，不猜测解读`,
    );
  }
  validateIdentifier('versionId', descriptor.versionId);
  validateIdentifier('deviceId', descriptor.deviceId);
  if (parseEpochMillis(descriptor.createdAt) === null) {
    throw validation('createdAt 必须是合法 RFC 3339 时间戳');
  }
  if (descriptor.files.length > MAX_SNAPSHOT_FILES) {
    throw validation(
      `descriptor 文件数 ${descriptor.files.length} 超过上限 ${MAX_SNAPSHOT_FILES}（不截断，直接拒绝）`,
    );
  }
  const seen = new Set<string>();
  let sum = 0n;
  for (const file of descriptor.files) {
    validateSnapshotFileRef(file);
    if (seen.has(file.logicalPath)) {
      throw validation(`logicalPath 重复：${file.logicalPath}（fail-closed，拒绝整个 descriptor）`);
    }
    seen.add(file.logicalPath);
    sum += u64(file.size, 'files[].size');
    if (sum > U64_MAX) throw validation('files[].size 之和溢出 u64，拒绝 descriptor');
  }
  const logical = u64(descriptor.logicalSize, 'logicalSize');
  if (logical !== sum) {
    throw validation(`logicalSize(${descriptor.logicalSize}) 必须精确等于 files[].size 之和(${sum})`);
  }
}

function encodeJson(value: unknown, errorMessage: string): Uint8Array {
  try {
    return utf8Encode(JSON.stringify(value));
  } catch (error) {
    throw new Error(`${errorMessage}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validates then encodes compact canonical JSON. */
export function encodeSnapshotDescriptor(descriptor: SnapshotDescriptorV2): Uint8Array {
  validateSnapshotDescriptor(descriptor);
  return encodeJson(descriptor, 'snapshot descriptor 序列化失败');
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validation(`${label} 解析失败: 顶层必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function expectExactFields(
  value: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw validation(
        `${label} 解析失败: unknown field \`${key}\`, expected one of ${allowed.map(field => `\`${field}\``).join(', ')}`,
      );
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      throw validation(`${label} 解析失败: missing field \`${key}\``);
    }
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw validation(`${field} 必须是字符串`);
  }
  return value;
}

function expectU32(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw validation(`${field} 必须是 u32 整数`);
  }
  return value;
}

function expectU64(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw validation(`${field} 必须是 u64 整数`);
  }
  return value;
}

/** Decodes and fully validates; unknown fields, future versions and bad paths fail closed. */
export function decodeSnapshotDescriptor(bytes: Uint8Array): SnapshotDescriptorV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch (error) {
    throw validation(`snapshot descriptor 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = expectObject(parsed, 'snapshot descriptor');
  expectExactFields(object, 'snapshot descriptor', [
    'format', 'formatVersion', 'versionId', 'deviceId', 'createdAt', 'files', 'logicalSize',
  ]);
  if (!Array.isArray(object.files)) {
    throw validation('snapshot descriptor 解析失败: files 必须是数组');
  }
  const files = object.files.map((item, index) => {
    const file = expectObject(item, `files[${index}]`);
    expectExactFields(file, `files[${index}]`, [
      'logicalPath', 'size', 'plaintextSha256', 'objectKey', 'objectCipherSha256',
    ]);
    return {
      logicalPath: expectString(file.logicalPath, `files[${index}].logicalPath`),
      size: expectU64(file.size, `files[${index}].size`),
      plaintextSha256: expectString(file.plaintextSha256, `files[${index}].plaintextSha256`),
      objectKey: expectString(file.objectKey, `files[${index}].objectKey`),
      objectCipherSha256: expectString(file.objectCipherSha256, `files[${index}].objectCipherSha256`),
    };
  });
  const descriptor: SnapshotDescriptorV2 = {
    format: expectString(object.format, 'format'),
    formatVersion: expectU32(object.formatVersion, 'formatVersion'),
    versionId: expectString(object.versionId, 'versionId'),
    deviceId: expectString(object.deviceId, 'deviceId'),
    createdAt: expectString(object.createdAt, 'createdAt'),
    files,
    logicalSize: expectU64(object.logicalSize, 'logicalSize'),
  };
  validateSnapshotDescriptor(descriptor);
  return descriptor;
}

/** Validates format/version exactly and `idKeyEpoch >= 1`. */
export function validateBackupV2RepoConfig(config: BackupV2RepoConfig): void {
  if (config.format !== BACKUP_V2_FORMAT) {
    throw validation(`repository config format 必须是 ${BACKUP_V2_FORMAT}，实际为 ${config.format}`);
  }
  if (config.formatVersion !== DELTA_FORMAT_VERSION) {
    throw validation(
      `repository config formatVersion 必须恰好为 ${DELTA_FORMAT_VERSION}，`
        + `实际为 ${config.formatVersion}；未来版本 fail-closed`,
    );
  }
  if (config.idKeyEpoch === 0) {
    throw validation('idKeyEpoch 必须 ≥ 1（0 视为未初始化，fail-closed）');
  }
}

/** Validates then encodes JSON bytes. */
export function encodeBackupV2RepoConfig(config: BackupV2RepoConfig): Uint8Array {
  validateBackupV2RepoConfig(config);
  return encodeJson(config, 'repository config 序列化失败');
}

/** Decodes and validates; unknown fields (any key material) are rejected. */
export function decodeBackupV2RepoConfig(bytes: Uint8Array): BackupV2RepoConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch (error) {
    throw validation(`repository config 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = expectObject(parsed, 'repository config');
  expectExactFields(object, 'repository config', ['format', 'formatVersion', 'idKeyEpoch']);
  const config: BackupV2RepoConfig = {
    format: expectString(object.format, 'format'),
    formatVersion: expectU32(object.formatVersion, 'formatVersion'),
    idKeyEpoch: expectU32(object.idKeyEpoch, 'idKeyEpoch'),
  };
  validateBackupV2RepoConfig(config);
  return config;
}
