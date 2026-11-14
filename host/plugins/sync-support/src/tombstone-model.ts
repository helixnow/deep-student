/** tombstone.rs：设备/事件标识、清单合并与过滤、serde 形状和序列化。 */

import { sha256Hasher, sha256Hex, uint32be, uint64be, utf8ByteLength } from './portable.ts';

import { rustTrim } from '../../../platform/util/portable.ts';

import type { AssetTombstoneEntry, AssetTombstones, BlobTombstoneEntry, BlobTombstones, TombstoneEvent, WorkspaceTombstoneEntry, WorkspaceTombstones } from '../api.ts';

import { SyncSupportError, databaseError } from './errors.ts';

import { parseFlexibleTimestamp as parseTimestamp, parseFlexibleTimestampMillis as parseFlexibleTimestamp } from '../../../platform/time/index.ts';

import { MAX_DRIFT_MS } from './lww-limits.ts';

export const LEGACY_BLOB_TOMBSTONE_KEY = 'data_governance/tombstones/blobs.json';

export const LEGACY_ASSET_TOMBSTONE_KEY = 'data_governance/tombstones/assets.json';

export const LEGACY_WS_TOMBSTONE_KEY = 'data_governance/tombstones/workspaces.json';

export const BLOB_TOMBSTONE_PREFIX = 'data_governance/tombstones/blobs/';

export const ASSET_TOMBSTONE_PREFIX = 'data_governance/tombstones/assets/';

export const WS_TOMBSTONE_PREFIX = 'data_governance/tombstones/workspaces/';

export const TOMBSTONE_EVENTS_PREFIX = 'data_governance/tombstone-events';

export const DEFAULT_TOMBSTONE_RETENTION_DAYS = 90;

export const TOMBSTONE_EVENT_FORMAT_VERSION = 4;

export interface TombstoneLogger {
  warn(message: string): void;
  info(message: string): void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `cloud_storage::device_id_short_hash`：sha256 前 16 hex。 */
export function deviceIdShortHash(deviceId: string): string {
  return sha256Hex(deviceId).slice(0, 16);
}

/** `device_component`：文件系统保留字符替换为 `_`，空白落 `unknown-device`。 */
export function deviceComponent(deviceId: string): string {
  const cleaned = [...deviceId]
    .map(character => ('/\\:*?"<>|'.includes(character) ? '_' : character))
    .join('');
  return rustTrim(cleaned) === '' ? 'unknown-device' : cleaned;
}

export function tombstoneDevicePathId(deviceId: string): string {
  return deviceIdShortHash(deviceId);
}

/** `{:020}`：20 位零填充。 */
function formatSeq(seq: bigint): string {
  return seq.toString().padStart(20, '0');
}

export function eventOperationId(kind: string, deviceId: string, objectId: string, deletedAt: string): string {
  const hasher = sha256Hasher();
  for (const part of [kind, deviceId, objectId, deletedAt]) {
    hasher.update(uint64be(BigInt(utf8ByteLength(part))));
    hasher.update(part);
  }
  return hasher.digestHex();
}


export function eventPayloadHash(event: TombstoneEvent): string {
  const hasher = sha256Hasher();
  hasher.update(uint32be(event.format_version));
  hasher.update(uint64be(event.seq));
  for (const value of [event.device_id, event.operation_id, event.kind, event.object_id, event.deleted_at]) {
    hasher.update(uint64be(BigInt(utf8ByteLength(value))));
    hasher.update(value);
  }
  if (event.size !== null && event.size !== undefined) {
    hasher.update(Uint8Array.of(1));
    hasher.update(uint64be(BigInt(event.size)));
  } else {
    hasher.update(Uint8Array.of(0));
  }
  if (event.relative_path !== null && event.relative_path !== undefined) {
    hasher.update(Uint8Array.of(1));
    hasher.update(uint64be(BigInt(utf8ByteLength(event.relative_path))));
    hasher.update(event.relative_path);
  } else {
    hasher.update(Uint8Array.of(0));
  }
  return hasher.digestHex();
}

export function eventDevicePrefix(kind: string, deviceId: string): string {
  return `${TOMBSTONE_EVENTS_PREFIX}/${kind}/${tombstoneDevicePathId(deviceId)}/`;
}

export function eventDeviceLegacyPrefix(kind: string, deviceId: string): string {
  return `${TOMBSTONE_EVENTS_PREFIX}/${kind}/${deviceComponent(deviceId)}/`;
}

export function eventKey(event: TombstoneEvent): string {
  return `${eventDevicePrefix(event.kind, event.device_id)}${formatSeq(event.seq)}-${event.operation_id}.json`;
}

export function eventLegacyKey(event: TombstoneEvent): string {
  return `${eventDeviceLegacyPrefix(event.kind, event.device_id)}${formatSeq(event.seq)}-${event.operation_id}.json`;
}

export function eventKeyMatches(event: TombstoneEvent, key: string): boolean {
  return key === eventKey(event) || key === eventLegacyKey(event);
}

/** `event_seq_from_key`：`<seq>-<operation_id>.json` 前缀按 u64 解析。 */
export function eventSeqFromKey(key: string): bigint | null {
  const file = key.split('/').pop();
  if (file === undefined) return null;
  const dash = file.indexOf('-');
  if (dash < 0) return null;
  const text = file.slice(0, dash);
  if (!/^\+?\d+$/u.test(text)) return null;
  const value = BigInt(text.replace('+', ''));
  return value <= 0xffff_ffff_ffff_ffffn ? value : null;
}

export function eventOperationFromKey(key: string): string | null {
  const file = key.split('/').pop();
  if (file === undefined || !file.endsWith('.json')) return null;
  const stem = file.slice(0, -'.json'.length);
  const dash = stem.indexOf('-');
  if (dash < 0) return null;
  const operation = stem.slice(dash + 1);
  return operation === '' ? null : operation;
}

export function normalizeSize(size: bigint | number | null | undefined): bigint | null {
  return size === null || size === undefined ? null : BigInt(size);
}

// ------------------------------------------------------------------ 每设备清单 key

export function blobDeviceTombstoneKey(deviceId: string): string {
  return `${BLOB_TOMBSTONE_PREFIX}${tombstoneDevicePathId(deviceId)}.json`;
}

export function blobDeviceTombstoneLegacyKey(deviceId: string): string {
  return `${BLOB_TOMBSTONE_PREFIX}${deviceComponent(deviceId)}.json`;
}

export function assetDeviceTombstoneKey(deviceId: string): string {
  return `${ASSET_TOMBSTONE_PREFIX}${tombstoneDevicePathId(deviceId)}.json`;
}

export function assetDeviceTombstoneLegacyKey(deviceId: string): string {
  return `${ASSET_TOMBSTONE_PREFIX}${deviceComponent(deviceId)}.json`;
}

export function workspaceDeviceTombstoneKey(deviceId: string): string {
  return `${WS_TOMBSTONE_PREFIX}${tombstoneDevicePathId(deviceId)}.json`;
}

export function workspaceDeviceTombstoneLegacyKey(deviceId: string): string {
  return `${WS_TOMBSTONE_PREFIX}${deviceComponent(deviceId)}.json`;
}

// ------------------------------------------------------------------ 合并与过滤

export function deletedAtIsNewer(candidate: string, current: string): boolean {
  const left = parseTimestamp(candidate);
  const right = parseTimestamp(current);
  if (left !== null && right !== null) return left.epochNanos > right.epochNanos;
  return candidate > current;
}

function mergeUpdatedAt(current: string, candidate: string): string {
  return current === '' || deletedAtIsNewer(candidate, current) ? candidate : current;
}

function mergeEntries<T extends { deleted_at: string }>(
  destination: Record<string, T>,
  source: Record<string, T>,
  updatedAt: string,
  sourceUpdatedAt: string,
): string {
  for (const [key, entry] of Object.entries(source)) {
    const existing = destination[key];
    if (existing === undefined || deletedAtIsNewer(entry.deleted_at, existing.deleted_at)) {
      destination[key] = entry;
    }
  }
  return mergeUpdatedAt(updatedAt, sourceUpdatedAt);
}

export function mergeBlobTombstones(destination: BlobTombstones, source: BlobTombstones): void {
  destination.updated_at = mergeEntries(
    destination.entries as Record<string, { deleted_at: string }>,
    source.entries as Record<string, { deleted_at: string }>,
    destination.updated_at,
    source.updated_at,
  );
}

export function mergeAssetTombstones(destination: AssetTombstones, source: AssetTombstones): void {
  destination.updated_at = mergeEntries(
    destination.entries as Record<string, { deleted_at: string }>,
    source.entries as Record<string, { deleted_at: string }>,
    destination.updated_at,
    source.updated_at,
  );
}

export function mergeWorkspaceTombstones(destination: WorkspaceTombstones, source: WorkspaceTombstones): void {
  destination.updated_at = mergeEntries(
    destination.entries as Record<string, { deleted_at: string }>,
    source.entries as Record<string, { deleted_at: string }>,
    destination.updated_at,
    source.updated_at,
  );
}

/** `validate_tombstone_timestamp`：未来漂移超 `MAX_DRIFT_MS` 即怀疑时钟。 */
export function validateTombstoneTimestamp(timestamp: string, label: string): void {
  const parsed = parseFlexibleTimestamp(timestamp);
  if (parsed === null) databaseError(`${label} tombstone 时间戳无效: ${timestamp}`);
  const driftMs = parsed - Date.now();
  if (driftMs > MAX_DRIFT_MS) {
    throw new SyncSupportError(
      'ClockDriftSuspected',
      `Clock drift suspected: ${label}_tombstone.${timestamp} timestamp is ${driftMs}ms in the future`,
      { table: `${label}_tombstone`, recordId: timestamp, driftMs },
    );
  }
}

/** [R04 anti-DoS]：坏/超前条目跳过并记录 warning，调用方不得推进水位。 */
export function tombstoneDeletedAtUsable(
  deletedAt: string,
  label: string,
  logger: TombstoneLogger,
): boolean {
  try {
    validateTombstoneTimestamp(deletedAt, label);
    return true;
  } catch (error) {
    logger.warn(
      `[sync] 跳过坏/超前 deleted_at 的 tombstone（该条不推进水位）: ${label} ` +
      `deleted_at=${deletedAt} 原因: ${errorMessage(error)}`,
    );
    return false;
  }
}

export function tombstonePathStem(prefix: string, key: string): string {
  const rest = key.startsWith(prefix) && key.endsWith('.json')
    ? key.slice(prefix.length, -'.json'.length)
    : null;
  return rest !== null && rustTrim(rest) !== '' ? rest : 'unknown-device';
}

/** 路径段是否指向该设备：兼容旧明文（含净化）与新短哈希。 */
export function tombstonePathIdMatchesDevice(pathId: string, deviceId: string): boolean {
  return pathId !== ''
    && (pathId === deviceComponent(deviceId) || pathId === tombstoneDevicePathId(deviceId));
}

/**
 * 水位必须按内容里的完整 `device_id` 记账；路径与内容不一致、或一份清单混多台
 * 设备时 fail-closed。
 */
export function sourceDeviceFromTombstoneEntries(
  key: string,
  prefix: string,
  deviceIds: Iterable<string | null | undefined>,
): string {
  const pathId = tombstonePathStem(prefix, key);
  let seenEntry = false;
  const unique: string[] = [];
  for (const raw of deviceIds) {
    seenEntry = true;
    const id = rustTrim(raw ?? '');
    if (id === '') continue;
    if (!unique.includes(id)) unique.push(id);
  }
  if (unique.length === 0) {
    if (!seenEntry) return pathId;
    return databaseError(`tombstone 清单缺少 device_id，已停止同步且未推进水位: ${key}`);
  }
  if (unique.length > 1) {
    databaseError(`tombstone 清单混有多台设备的 device_id，已停止同步且未推进水位: ${key}`);
  }
  const deviceId = unique[0]!;
  if (!tombstonePathIdMatchesDevice(pathId, deviceId)) {
    databaseError(`tombstone 清单路径与内容 device_id 不一致: ${key}`);
  }
  return deviceId;
}

export function tombstoneOffsetFromDeletedAt(deletedAt: string): bigint {
  const parsed = parseFlexibleTimestamp(deletedAt);
  return parsed === null ? 0n : BigInt(Math.max(0, parsed));
}

export function filterBlobTombstonesAfter(
  manifest: BlobTombstones,
  watermark: bigint,
  logger: TombstoneLogger,
): [BlobTombstones, bigint] {
  const filtered: BlobTombstones = { entries: {}, updated_at: manifest.updated_at };
  let maxOffset = watermark;
  for (const [hash, entry] of Object.entries(manifest.entries)) {
    if (!tombstoneDeletedAtUsable(entry.deleted_at, `blob/${hash}`, logger)) continue;
    const offset = tombstoneOffsetFromDeletedAt(entry.deleted_at);
    if (offset > maxOffset) maxOffset = offset;
    // 时间戳不是安全游标（同毫秒删除、墙钟回拨）；tombstone 保留且应用幂等，重放整个集合。
    filtered.entries[hash] = entry;
  }
  return [filtered, maxOffset];
}

export function filterAssetTombstonesAfter(
  manifest: AssetTombstones,
  watermark: bigint,
  logger: TombstoneLogger,
): [AssetTombstones, bigint] {
  const filtered: AssetTombstones = { entries: {}, updated_at: manifest.updated_at };
  let maxOffset = watermark;
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (!tombstoneDeletedAtUsable(entry.deleted_at, `asset/${key}`, logger)) continue;
    const offset = tombstoneOffsetFromDeletedAt(entry.deleted_at);
    if (offset > maxOffset) maxOffset = offset;
    filtered.entries[key] = entry;
  }
  return [filtered, maxOffset];
}

export function filterWorkspaceTombstonesAfter(
  manifest: WorkspaceTombstones,
  watermark: bigint,
): [WorkspaceTombstones, bigint] {
  const filtered: WorkspaceTombstones = { entries: {}, updated_at: manifest.updated_at };
  let maxOffset = watermark;
  for (const [workspaceId, entry] of Object.entries(manifest.entries)) {
    const offset = tombstoneOffsetFromDeletedAt(entry.deleted_at);
    if (offset > maxOffset) maxOffset = offset;
    filtered.entries[workspaceId] = entry;
  }
  return [filtered, maxOffset];
}

// ------------------------------------------------------------------ JSON 形状

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** serde 错误里的类型名（用于 fail-closed 文案）。 */
function serdeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  switch (typeof value) {
    case 'boolean': return `boolean \`${value}\``;
    case 'number': return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
    case 'bigint': return `integer \`${value}\``;
    case 'string': return `string ${JSON.stringify(value)}`;
    case 'object': return 'map';
    default: return typeof value;
  }
}

function expectStruct(value: unknown, name: string): Record<string, unknown> {
  const object = asObject(value);
  if (object === null) databaseError(`invalid type: ${serdeType(value)}, expected struct ${name}`);
  return object;
}

/** serde `String` 字段：缺失或类型错误都失败。 */
function requiredString(object: Record<string, unknown>, field: string): string {
  if (!Object.hasOwn(object, field)) databaseError(`missing field \`${field}\``);
  const value = object[field];
  if (typeof value !== 'string') databaseError(`invalid type: ${serdeType(value)}, expected a string`);
  return value;
}

/** serde `Option<String>`：缺失/null → null，其余必须是字符串。 */
function optionalString(object: Record<string, unknown>, field: string): string | null {
  if (!Object.hasOwn(object, field) || object[field] === null) return null;
  const value = object[field];
  if (typeof value !== 'string') databaseError(`invalid type: ${serdeType(value)}, expected a string`);
  return value;
}

/** serde `Option<u64>`：缺失/null → null；布尔/浮点/负数/越界都失败。 */
function optionalU64(object: Record<string, unknown>, field: string): bigint | null {
  if (!Object.hasOwn(object, field) || object[field] === null) return null;
  const value = object[field];
  if (typeof value === 'bigint') {
    if (value < 0n || value > U64_MAX) databaseError(`invalid value: integer \`${value}\`, expected u64`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      databaseError(`invalid type: ${serdeType(value)}, expected u64`);
    }
    if (value > Number(U64_MAX)) databaseError(`invalid value: integer \`${value}\`, expected u64`);
    return BigInt(value);
  }
  databaseError(`invalid type: ${serdeType(value)}, expected u64`);
}

/** serde `u64` 必填字段。 */
function requiredU64(object: Record<string, unknown>, field: string): bigint {
  if (!Object.hasOwn(object, field)) databaseError(`missing field \`${field}\``);
  const value = optionalU64(object, field);
  if (value === null) databaseError(`invalid type: null, expected u64`);
  return value;
}

/** 反序列化 `BlobTombstones`（缺省字段按 serde `default`，显式 null 仍失败）。 */
export function normalizeBlobManifest(value: unknown): BlobTombstones | null {
  const root = expectStruct(value, 'BlobTombstones');
  const entries: Record<string, BlobTombstoneEntry> = {};
  if (Object.hasOwn(root, 'entries')) {
    const map = asObject(root.entries);
    if (map === null) {
      databaseError(`invalid type: ${serdeType(root.entries)}, expected a map`);
    }
    for (const [key, raw] of Object.entries(map)) {
      const entry = expectStruct(raw, 'BlobTombstoneEntry');
      const deletedAt = requiredString(entry, 'deleted_at');
      const deviceId = requiredString(entry, 'device_id');
      entries[key] = {
        deleted_at: deletedAt,
        device_id: deviceId,
        size: optionalU64(entry, 'size'),
        relative_path: optionalString(entry, 'relative_path'),
      };
    }
  }
  const updatedAt = Object.hasOwn(root, 'updated_at')
    ? requiredString(root, 'updated_at')
    : '';
  return { entries, updated_at: updatedAt };
}

/** 反序列化 `AssetTombstones`。 */
export function normalizeAssetManifest(value: unknown): AssetTombstones | null {
  const root = expectStruct(value, 'AssetTombstones');
  const entries: Record<string, AssetTombstoneEntry> = {};
  if (Object.hasOwn(root, 'entries')) {
    const map = asObject(root.entries);
    if (map === null) {
      databaseError(`invalid type: ${serdeType(root.entries)}, expected a map`);
    }
    for (const [key, raw] of Object.entries(map)) {
      const entry = expectStruct(raw, 'AssetTombstoneEntry');
      const deletedAt = requiredString(entry, 'deleted_at');
      const deviceId = requiredString(entry, 'device_id');
      entries[key] = { deleted_at: deletedAt, device_id: deviceId, size: optionalU64(entry, 'size') };
    }
  }
  const updatedAt = Object.hasOwn(root, 'updated_at')
    ? requiredString(root, 'updated_at')
    : '';
  return { entries, updated_at: updatedAt };
}

/** 反序列化 `WorkspaceTombstones`。 */
export function normalizeWorkspaceManifest(value: unknown): WorkspaceTombstones | null {
  const root = expectStruct(value, 'WorkspaceTombstones');
  const entries: Record<string, WorkspaceTombstoneEntry> = {};
  if (Object.hasOwn(root, 'entries')) {
    const map = asObject(root.entries);
    if (map === null) {
      databaseError(`invalid type: ${serdeType(root.entries)}, expected a map`);
    }
    for (const [key, raw] of Object.entries(map)) {
      const entry = expectStruct(raw, 'WorkspaceTombstoneEntry');
      const deletedAt = requiredString(entry, 'deleted_at');
      const deviceId = requiredString(entry, 'device_id');
      entries[key] = { deleted_at: deletedAt, device_id: deviceId };
    }
  }
  const updatedAt = Object.hasOwn(root, 'updated_at')
    ? requiredString(root, 'updated_at')
    : '';
  return { entries, updated_at: updatedAt };
}

/** 解析 `TombstoneEvent`（serde 结构；`format_version` / `payload_hash` 有默认值）。 */
export function parseTombstoneEvent(value: unknown): TombstoneEvent {
  const root = expectStruct(value, 'TombstoneEvent');
  let formatVersion = TOMBSTONE_EVENT_FORMAT_VERSION;
  if (Object.hasOwn(root, 'format_version')) {
    const raw = root.format_version;
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < 0 ||
      raw > 0xffff_ffff
    ) {
      databaseError(`invalid type: ${serdeType(raw)}, expected u32`);
    }
    formatVersion = raw;
  }
  const deviceId = requiredString(root, 'device_id');
  const seq = requiredU64(root, 'seq');
  const operationId = requiredString(root, 'operation_id');
  const kind = requiredString(root, 'kind');
  const objectId = requiredString(root, 'object_id');
  const deletedAt = requiredString(root, 'deleted_at');
  const payloadHash = Object.hasOwn(root, 'payload_hash')
    ? requiredString(root, 'payload_hash')
    : '';
  return {
    format_version: formatVersion,
    device_id: deviceId,
    seq,
    operation_id: operationId,
    kind,
    object_id: objectId,
    deleted_at: deletedAt,
    size: optionalU64(root, 'size'),
    relative_path: optionalString(root, 'relative_path'),
    payload_hash: payloadHash,
  };
}

function stringifySize(size: bigint | number | null | undefined): string {
  return size === null || size === undefined ? 'null' : BigInt(size).toString();
}

export function stringifyBlobTombstones(manifest: BlobTombstones): string {
  const entries = Object.entries(manifest.entries).map(([key, entry]) => {
    const fields = [
      `"deleted_at":${JSON.stringify(entry.deleted_at)}`,
      `"device_id":${JSON.stringify(entry.device_id)}`,
    ];
    if (entry.size !== null && entry.size !== undefined) fields.push(`"size":${stringifySize(entry.size)}`);
    if (entry.relative_path !== null && entry.relative_path !== undefined) {
      fields.push(`"relative_path":${JSON.stringify(entry.relative_path)}`);
    }
    return `${JSON.stringify(key)}:{${fields.join(',')}}`;
  });
  return `{"entries":{${entries.join(',')}},"updated_at":${JSON.stringify(manifest.updated_at)}}`;
}

export function stringifyAssetTombstones(manifest: AssetTombstones): string {
  const entries = Object.entries(manifest.entries).map(([key, entry]) => {
    const fields = [
      `"deleted_at":${JSON.stringify(entry.deleted_at)}`,
      `"device_id":${JSON.stringify(entry.device_id)}`,
    ];
    if (entry.size !== null && entry.size !== undefined) fields.push(`"size":${stringifySize(entry.size)}`);
    return `${JSON.stringify(key)}:{${fields.join(',')}}`;
  });
  return `{"entries":{${entries.join(',')}},"updated_at":${JSON.stringify(manifest.updated_at)}}`;
}

export function stringifyWorkspaceTombstones(manifest: WorkspaceTombstones): string {
  const entries = Object.entries(manifest.entries).map(([key, entry]) =>
    `${JSON.stringify(key)}:{"deleted_at":${JSON.stringify(entry.deleted_at)},` +
    `"device_id":${JSON.stringify(entry.device_id)}}`);
  return `{"entries":{${entries.join(',')}},"updated_at":${JSON.stringify(manifest.updated_at)}}`;
}
