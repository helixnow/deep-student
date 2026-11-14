/**
 * Tombstone 清单（`tombstone.rs` 纯函数移植）。
 *
 * 覆盖事件标识/哈希/对象 key、每设备清单的合并与过滤、路径校验与按 hash
 * 查找 blob。上传/下载与 E2EE 编解码由后续传输层注入。
 */
import { rustTrim } from '../../../platform/util/index.ts';
import fs from 'node:fs';
import * as path from '../../../platform/util/path.ts';
import { ClockDriftSuspectedError, SyncError } from '../src/errors.ts';
import { MAX_DRIFT_MS } from '../src/hlc.ts';
import { parseFlexibleTimestampMillis } from '../src/lww.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { utf8Encode, utf8Decode } from '../../../platform/crypto/encoding.ts';

export const LEGACY_BLOB_TOMBSTONE_KEY = 'data_governance/tombstones/blobs.json';
export const LEGACY_ASSET_TOMBSTONE_KEY = 'data_governance/tombstones/assets.json';
export const LEGACY_WS_TOMBSTONE_KEY = 'data_governance/tombstones/workspaces.json';

export const BLOB_TOMBSTONE_PREFIX = 'data_governance/tombstones/blobs/';
export const ASSET_TOMBSTONE_PREFIX = 'data_governance/tombstones/assets/';
export const WS_TOMBSTONE_PREFIX = 'data_governance/tombstones/workspaces/';
export const TOMBSTONE_EVENTS_PREFIX = 'data_governance/tombstone-events';

export const DEFAULT_TOMBSTONE_RETENTION_DAYS = 90;
export const TOMBSTONE_EVENT_FORMAT_VERSION = 4;

export interface TombstoneEvent {
  format_version: number;
  device_id: string;
  seq: bigint;
  operation_id: string;
  kind: string;
  object_id: string;
  deleted_at: string;
  size?: bigint | null;
  relative_path?: string | null;
  payload_hash: string;
}

export interface BlobTombstoneEntry {
  deleted_at: string;
  device_id: string;
  size?: bigint | number | null;
  relative_path?: string | null;
}

export interface BlobTombstones {
  entries: Record<string, BlobTombstoneEntry>;
  updated_at: string;
}

export interface AssetTombstoneEntry {
  deleted_at: string;
  device_id: string;
  size?: bigint | number | null;
}

export interface AssetTombstones {
  entries: Record<string, AssetTombstoneEntry>;
  updated_at: string;
}

export interface WorkspaceTombstoneEntry {
  deleted_at: string;
  device_id: string;
}

export interface WorkspaceTombstones {
  entries: Record<string, WorkspaceTombstoneEntry>;
  updated_at: string;
}

/** `cloud_storage::device_id_short_hash`：sha256 前 16 位 hex。 */
export function deviceIdShortHash(deviceId: string): string {
  return createHasherSync('SHA-256').update(deviceId).digestHex().slice(0, 16);
}

/** `device_component`：把路径分隔符等替换为 `_`，空值落到 `unknown-device`。 */
export function deviceComponent(deviceId: string): string {
  const cleaned = [...deviceId]
    .map(character => ('/\\:*?"<>|'.includes(character) ? '_' : character))
    .join('');
  return rustTrim(cleaned) === '' ? 'unknown-device' : cleaned;
}

/** 新 tombstone 路径用短哈希，避免把完整 device_id 写进对象 key。 */
export function tombstoneDevicePathId(deviceId: string): string {
  return deviceIdShortHash(deviceId);
}

function u64be(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value);
  return bytes;
}

function u32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

export function eventOperationId(
  kind: string,
  deviceId: string,
  objectId: string,
  deletedAt: string,
): string {
  const hasher = createHasherSync('SHA-256');
  for (const part of [kind, deviceId, objectId, deletedAt]) {
    const bytes = utf8Encode(part);
    const length = u64be(BigInt(bytes.length));
    hasher.update(length);
    hasher.update(bytes);
  }
  return hasher.digestHex();
}

export function eventPayloadHash(event: TombstoneEvent): string {
  const hasher = createHasherSync('SHA-256');
  hasher.update(u32be(event.format_version));
  hasher.update(u64be(event.seq));
  for (const value of [
    event.device_id,
    event.operation_id,
    event.kind,
    event.object_id,
    event.deleted_at,
  ]) {
    const bytes = utf8Encode(value);
    const length = u64be(BigInt(bytes.length));
    hasher.update(length);
    hasher.update(bytes);
  }
  if (event.size !== undefined && event.size !== null) {
    hasher.update(Uint8Array.from([1]));
    hasher.update(u64be(BigInt(event.size)));
  } else {
    hasher.update(Uint8Array.from([0]));
  }
  if (event.relative_path !== undefined && event.relative_path !== null) {
    hasher.update(Uint8Array.from([1]));
    const bytes = utf8Encode(event.relative_path);
    const length = u64be(BigInt(bytes.length));
    hasher.update(length);
    hasher.update(bytes);
  } else {
    hasher.update(Uint8Array.from([0]));
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
  return `${eventDevicePrefix(event.kind, event.device_id)}${event.seq.toString().padStart(20, '0')}-${event.operation_id}.json`;
}

export function eventLegacyKey(event: TombstoneEvent): string {
  return `${eventDeviceLegacyPrefix(event.kind, event.device_id)}${event.seq.toString().padStart(20, '0')}-${event.operation_id}.json`;
}

export function eventKeyMatches(event: TombstoneEvent, key: string): boolean {
  return key === eventKey(event) || key === eventLegacyKey(event);
}

export function eventSeqFromKey(key: string): bigint | null {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dash = name.indexOf('-');
  if (dash < 0) return null;
  const value = name.slice(0, dash);
  if (!/^\d+$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function eventOperationFromKey(key: string): string | null {
  const name = key.slice(key.lastIndexOf('/') + 1);
  if (!name.endsWith('.json')) return null;
  const dash = name.indexOf('-');
  if (dash < 0) return null;
  const operationId = name.slice(dash + 1, -'.json'.length);
  return operationId === '' ? null : operationId;
}

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

export function deletedAtIsNewer(candidate: string, current: string): boolean {
  const left = parseFlexibleTimestampMillis(candidate);
  const right = parseFlexibleTimestampMillis(current);
  if (left !== null && right !== null) return left > right;
  return candidate > current;
}

function mergeUpdatedAt(current: string, candidate: string): string {
  return current === '' || deletedAtIsNewer(candidate, current) ? candidate : current;
}

function mergeEntries<T extends { deleted_at: string }>(
  destination: Record<string, T>,
  source: Record<string, T>,
): void {
  for (const [key, entry] of Object.entries(source)) {
    const existing = destination[key];
    if (existing === undefined || deletedAtIsNewer(entry.deleted_at, existing.deleted_at)) {
      destination[key] = entry;
    }
  }
}

export function mergeBlobTombstones(destination: BlobTombstones, source: BlobTombstones): void {
  destination.updated_at = mergeUpdatedAt(destination.updated_at, source.updated_at);
  mergeEntries(destination.entries, source.entries);
}

export function mergeAssetTombstones(destination: AssetTombstones, source: AssetTombstones): void {
  destination.updated_at = mergeUpdatedAt(destination.updated_at, source.updated_at);
  mergeEntries(destination.entries, source.entries);
}

export function mergeWorkspaceTombstones(
  destination: WorkspaceTombstones,
  source: WorkspaceTombstones,
): void {
  destination.updated_at = mergeUpdatedAt(destination.updated_at, source.updated_at);
  mergeEntries(destination.entries, source.entries);
}

export function pathModifiedAfter(filePath: string, timestamp: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  const modified = parseFlexibleTimestampMillis(timestamp);
  if (modified === null) return false;
  return stat.mtimeMs > modified;
}

/** 与行级 LWW 相同的未来时钟漂移上限；无法证明因果时 fail-close。 */
export function validateTombstoneTimestamp(timestamp: string, label: string): void {
  const parsed = parseFlexibleTimestampMillis(timestamp);
  if (parsed === null) {
    throw new SyncError(`Database error: ${label} tombstone 时间戳无效: ${timestamp}`);
  }
  const driftMs = parsed - Date.now();
  if (driftMs > MAX_DRIFT_MS) {
    throw new ClockDriftSuspectedError(`${label}_tombstone`, timestamp, driftMs);
  }
}

/** `tombstone_deleted_at_usable`：坏/超前条目跳过且不推进水位。 */
export function tombstoneDeletedAtUsable(deletedAt: string, label: string): boolean {
  try {
    validateTombstoneTimestamp(deletedAt, label);
    return true;
  } catch {
    return false;
  }
}

export interface PayloadCodec {
  decode(data: Uint8Array): Uint8Array;
}

export const plainCodec: PayloadCodec = {
  decode: data => data,
};

/** `decode_tombstone_file`：解密/解析失败都必须硬错误。 */
export function decodeTombstoneFile<T>(
  codec: PayloadCodec,
  bytes: Uint8Array,
  label: string,
): T | null {
  let decoded: Uint8Array;
  try {
    decoded = codec.decode(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyncError(
      `Database error: ${label} tombstone 清单无法解密，已停止同步（请检查加密密码）: ${message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(decoded));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyncError(
      `Database error: ${label} tombstone 清单损坏，已停止同步且未推进水位: ${message}`,
    );
  }
  return normalizeTombstoneManifest<T>(parsed);
}

/** serde 反序列化等价：对象必须是 object，`entries` 缺省为空。 */
function normalizeTombstoneManifest<T>(parsed: unknown): T {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyncError(
      'Database error: tombstone 清单损坏，已停止同步且未推进水位: expected a JSON object',
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.entries === undefined) record.entries = {};
  if (record.updated_at === undefined) record.updated_at = '';
  return record as T;
}

export interface TombstoneWatermarkAdvance {
  source_device_id: string;
  last_applied_offset: bigint;
}

export function tombstonePathStem(prefix: string, key: string): string {
  if (!key.startsWith(prefix)) return 'unknown-device';
  const rest = key.slice(prefix.length);
  if (!rest.endsWith('.json')) return 'unknown-device';
  const stem = rest.slice(0, -'.json'.length);
  return rustTrim(stem) === '' ? 'unknown-device' : stem;
}

function tombstonePathIdMatchesDevice(pathId: string, deviceId: string): boolean {
  return pathId !== ''
    && (pathId === deviceComponent(deviceId) || pathId === tombstoneDevicePathId(deviceId));
}

/** 水位按内容里的完整 `device_id` 记账；路径与内容不一致或混多设备都 fail-closed。 */
export function sourceDeviceFromTombstoneEntries(
  key: string,
  prefix: string,
  deviceIds: Iterable<string>,
): string {
  const pathId = tombstonePathStem(prefix, key);
  let seenEntry = false;
  const unique: string[] = [];
  for (const raw of deviceIds) {
    seenEntry = true;
    const id = rustTrim(raw);
    if (id === '') continue;
    if (!unique.includes(id)) unique.push(id);
  }
  if (unique.length === 0) {
    if (!seenEntry) return pathId;
    throw new SyncError(
      `Database error: tombstone 清单缺少 device_id，已停止同步且未推进水位: ${key}`,
    );
  }
  if (unique.length > 1) {
    throw new SyncError(
      `Database error: tombstone 清单混有多台设备的 device_id，已停止同步且未推进水位: ${key}`,
    );
  }
  const deviceId = unique[0] as string;
  if (!tombstonePathIdMatchesDevice(pathId, deviceId)) {
    throw new SyncError(`Database error: tombstone 清单路径与内容 device_id 不一致: ${key}`);
  }
  return deviceId;
}

export function tombstoneOffsetFromDeletedAt(deletedAt: string): bigint {
  const millis = parseFlexibleTimestampMillis(deletedAt);
  return millis === null ? 0n : BigInt(Math.max(0, millis));
}

/** 时间戳不是安全游标：完整按设备集合重放，条目应用是幂等的。 */
export function filterBlobTombstonesAfter(
  manifest: BlobTombstones,
  watermark: bigint,
): [BlobTombstones, bigint] {
  const filtered: BlobTombstones = { entries: {}, updated_at: manifest.updated_at };
  let maxOffset = watermark;
  for (const [hash, entry] of Object.entries(manifest.entries)) {
    if (!tombstoneDeletedAtUsable(entry.deleted_at, `blob/${hash}`)) continue;
    const offset = tombstoneOffsetFromDeletedAt(entry.deleted_at);
    if (offset > maxOffset) maxOffset = offset;
    filtered.entries[hash] = entry;
  }
  return [filtered, maxOffset];
}

export function filterAssetTombstonesAfter(
  manifest: AssetTombstones,
  watermark: bigint,
): [AssetTombstones, bigint] {
  const filtered: AssetTombstones = { entries: {}, updated_at: manifest.updated_at };
  let maxOffset = watermark;
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (!tombstoneDeletedAtUsable(entry.deleted_at, `asset/${key}`)) continue;
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

/** 拒绝两段以外的路径、非 Normal 段、bucket/stem 与 hash 不符以及符号链接。 */
export function validateBlobRelativePath(
  blobsDir: string,
  hash: string,
  relativePath: string,
): string {
  const parsed = path.parse(relativePath);
  const segments = relativePath.split(/[\\/]/u);
  if (segments.length !== 2 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new SyncError(`Database error: 拒绝不安全的 blob tombstone 相对路径: ${JSON.stringify(relativePath)}`);
  }
  const [bucket, fileName] = segments as [string, string];
  if (parsed.dir !== bucket) {
    throw new SyncError(`Database error: 拒绝不安全的 blob tombstone 相对路径: ${JSON.stringify(relativePath)}`);
  }
  const stem = fileName.includes('.') ? fileName.slice(0, fileName.indexOf('.')) : fileName;
  if (bucket !== hash.slice(0, 2) || stem !== hash) {
    throw new SyncError(
      `Database error: blob tombstone 路径与内容 hash 不匹配: ${JSON.stringify(relativePath)}`,
    );
  }

  const bucketPath = path.join(blobsDir, bucket);
  let bucketStat: fs.Stats | null = null;
  try {
    bucketStat = fs.lstatSync(bucketPath);
  } catch {
    bucketStat = null;
  }
  if (bucketStat !== null && bucketStat.isSymbolicLink()) {
    throw new SyncError(`Database error: blob tombstone 目标桶不能是符号链接: ${bucketPath}`);
  }
  const target = path.join(bucketPath, fileName);
  let targetStat: fs.Stats | null = null;
  try {
    targetStat = fs.lstatSync(target);
  } catch {
    targetStat = null;
  }
  if (targetStat !== null && targetStat.isSymbolicLink()) {
    throw new SyncError(`Database error: blob tombstone 目标不能是符号链接: ${target}`);
  }
  return target;
}

/** 按 hash 在 blobs_dir 下扫描 `<hash 前两位>/<hash>.<ext>`。 */
export function findBlobByHash(blobsDir: string, hash: string): string | null {
  if (hash.length !== 64 || !/^[0-9a-fA-F]{64}$/u.test(hash)) return null;
  const bucket = path.join(blobsDir, hash.slice(0, 2));
  let bucketStat: fs.Stats;
  try {
    bucketStat = fs.lstatSync(bucket);
  } catch {
    return null;
  }
  if (bucketStat.isSymbolicLink() || !bucketStat.isDirectory()) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(bucket);
  } catch {
    return null;
  }
  for (const name of entries) {
    const filePath = path.join(bucket, name);
    const stem = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
    if (stem === hash) return filePath;
  }
  return null;
}

/** 权威 replace snapshot 上线前不得按时间裁剪。 */
export function pruneTombstones<T>(
  _entries: Record<string, T>,
  _retentionDays: bigint | number,
  _extractDeletedAt: (entry: T) => string,
): number {
  return 0;
}
