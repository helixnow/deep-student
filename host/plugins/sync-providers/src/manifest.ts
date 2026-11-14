/**
 * Cloud manifest model (sync_manager.rs:104-143, 416): serde-equivalent
 * decode/encode, business validation and merge order.
 *
 * `u64` sizes stay `bigint` until the IPC boundary (`toWireVersion`).
 */

import { parseRfc3339 } from '../../../platform/time/index.ts';
import type { BackupVersion } from '../api.ts';
import { CloudStorageError } from './errors.ts';
import {
  SerdeJsonError,
  decodeOption,
  decodeSeq,
  decodeString,
  decodeStruct,
  decodeU32,
  decodeU64,
  decodeUtcTimestamp,
  fromSlice,
  type Deserializer,
} from './serde_struct.ts';
import { chronoAutoSiZ } from './time.ts';
import { randomHex } from './random.ts';

export const NEUTRAL_VERSION_ID_LEN = 22;
const MAX_MANIFEST_VERSIONS = 10_000;

export interface ManifestVersion extends Omit<BackupVersion, 'size'> {
  /** `u64` is kept exact until the IPC boundary. */
  size: bigint;
}

export interface CloudManifest {
  version: number;
  latest?: string | null;
  versions: ManifestVersion[];
  updatedAt: string;
}

/** IPC boundary only: Rust/Tauri serializes `u64` as a JSON number. */
export function toWireVersion(version: ManifestVersion): BackupVersion {
  return { ...version, size: Number(version.size) };
}

/**
 * serde_json-compatible manifest encoding. `JSON.stringify` throws on `bigint`;
 * emitting the `u64` token directly keeps large sizes byte-exact on the wire.
 * Field order matches the Rust struct declaration order.
 */
export function encodeManifest(manifest: CloudManifest): string {
  const fields = [`"version":${manifest.version}`];
  if (manifest.latest !== undefined && manifest.latest !== null) {
    fields.push(`"latest":${JSON.stringify(manifest.latest)}`);
  }
  fields.push(`"versions":[${manifest.versions.map(encodeManifestVersion).join(',')}]`);
  fields.push(`"updatedAt":${JSON.stringify(manifest.updatedAt)}`);
  return `{${fields.join(',')}}`;
}

function encodeManifestVersion(version: ManifestVersion): string {
  const fields = [
    `"id":${JSON.stringify(version.id)}`,
    `"timestamp":${JSON.stringify(version.timestamp)}`,
    `"size":${version.size.toString()}`,
    `"checksum":${JSON.stringify(version.checksum)}`,
    `"deviceId":${JSON.stringify(version.deviceId)}`,
  ];
  if (version.appVersion !== undefined && version.appVersion !== null) {
    fields.push(`"appVersion":${JSON.stringify(version.appVersion)}`);
  }
  if (version.note !== undefined && version.note !== null) {
    fields.push(`"note":${JSON.stringify(version.note)}`);
  }
  if (version.recoveryKind !== undefined && version.recoveryKind !== null) {
    fields.push(`"recoveryKind":${JSON.stringify(version.recoveryKind)}`);
  }
  return `{${fields.join(',')}}`;
}

export function emptyManifest(now = new Date()): CloudManifest {
  return { version: 1, versions: [], updatedAt: chronoAutoSiZ(now.getTime()) };
}

/** [R12-neutral-names] 22 random alphanumerics; no time, no device short id. */
export function generateNeutralVersionId(): string {
  let id = '';
  while (id.length < NEUTRAL_VERSION_ID_LEN) id += randomHex(16);
  return id.slice(0, NEUTRAL_VERSION_ID_LEN);
}

export function validateVersionId(id: string): void {
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new CloudStorageError('Validation', `云端备份版本 ID 非法: ${JSON.stringify(id)}`);
  }
}

export function validateManifest(key: string, manifest: CloudManifest): void {
  if (manifest.versions.length > MAX_MANIFEST_VERSIONS) {
    throw new CloudStorageError('Validation', `manifest ${key} 版本数量异常: ${manifest.versions.length}`);
  }
  const seen = new Set<string>();
  for (const version of manifest.versions) {
    validateVersionId(version.id);
    if (seen.has(version.id)) {
      throw new CloudStorageError('Validation', `manifest ${key} 包含重复版本 ID: ${version.id}`);
    }
    seen.add(version.id);
    if (version.checksum.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(version.checksum)) {
      throw new CloudStorageError('Validation', `manifest ${key} 的版本 ${version.id} 校验和非法`);
    }
  }
  const latest = manifest.latest ?? null;
  if (latest !== null && !seen.has(latest)) {
    throw new CloudStorageError('Validation', `manifest ${key} 的 latest 未指向有效版本: ${latest}`);
  }
  if (latest === null && manifest.versions.length > 0) {
    throw new CloudStorageError('Validation', `manifest ${key} 含版本但缺少 latest`);
  }
}

const none = (): undefined => undefined;
const optionalString = { decode: (input: Deserializer) => decodeOption(input, decodeString), default: none };

function decodeBackupVersion(input: Deserializer): ManifestVersion {
  const fields = decodeStruct(input, 'BackupVersion', {
    id: { decode: decodeString },
    timestamp: { decode: (value: Deserializer) => decodeUtcTimestamp(value, 'timestamp') },
    size: { decode: decodeU64 },
    checksum: { decode: decodeString },
    deviceId: { decode: decodeString },
    appVersion: optionalString,
    note: optionalString,
    recoveryKind: optionalString,
  });
  const decoded: ManifestVersion = {
    id: fields.id, timestamp: fields.timestamp, size: fields.size, checksum: fields.checksum, deviceId: fields.deviceId,
  };
  if (fields.appVersion !== undefined) decoded.appVersion = fields.appVersion;
  if (fields.note !== undefined) decoded.note = fields.note;
  if (fields.recoveryKind !== undefined) decoded.recoveryKind = fields.recoveryKind;
  return decoded;
}

function decodeCloudManifest(input: Deserializer): CloudManifest {
  const fields = decodeStruct(input, 'CloudManifest', {
    version: { decode: decodeU32 },
    latest: optionalString,
    versions: { decode: (value: Deserializer) => decodeSeq(value, decodeBackupVersion) },
    updatedAt: { decode: (value: Deserializer) => decodeUtcTimestamp(value, 'updatedAt') },
  });
  const decoded: CloudManifest = { version: fields.version, versions: fields.versions, updatedAt: fields.updatedAt };
  if (fields.latest !== undefined) decoded.latest = fields.latest;
  return decoded;
}

/** sync_manager.rs:104-143: serde_json::from_slice + validate_manifest. */
export function decodeManifest(key: string, data: Uint8Array): CloudManifest {
  let manifest: CloudManifest;
  try { manifest = fromSlice(data, decodeCloudManifest); }
  catch (error) {
    if (error instanceof SerdeJsonError) throw new CloudStorageError('Unknown', `manifest ${key} 损坏: ${error.message}`);
    throw error;
  }
  validateManifest(key, manifest);
  return manifest;
}

export function timestampNanos(value: string): bigint {
  return parseRfc3339(value)?.epochNanos ?? 0n;
}

/** sync_manager.rs:416: union by id, newest first, latest = first. */
export function mergeManifest(target: CloudManifest, incoming: CloudManifest): void {
  const byId = new Map<string, ManifestVersion>();
  for (const version of [...target.versions, ...incoming.versions]) byId.set(version.id, version);
  target.versions = [...byId.values()].sort((a, b) => {
    const left = timestampNanos(a.timestamp);
    const right = timestampNanos(b.timestamp);
    if (left !== right) return left > right ? -1 : 1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  target.latest = target.versions[0]?.id ?? null;
  if (timestampNanos(incoming.updatedAt) > timestampNanos(target.updatedAt)) target.updatedAt = incoming.updatedAt;
}
