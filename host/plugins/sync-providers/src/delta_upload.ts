/**
 * backup-v2 snapshot publish primitive (`delta_upload.rs`).
 *
 * Not wired: no Tauri command, UI, `sync_manager` or other production entry point
 * calls this module; production Cloud backup is still "whole ZIP -> single object
 * put_file to backups/<version>.zip". Its presence does not mean incremental
 * backup / content dedup / CDC is implemented.
 *
 * Object layout (only the backup-v2 namespace; v1 `backups/` and
 * `manifests/<device>.json` are never touched):
 *
 * ```text
 * backup-v2/objects/<device_id>/<uuid>.dsbk      # immutable logical file object
 * backup-v2/snapshots/<device_id>/<version_id>.dsbk
 * backup-v2/manifests/<device_id>.json           # per-device index (commit point)
 * backup-v2/config.dsbk                          # first publish only, never overwritten
 * backup-v2/locks/                               # only through the backup lease API
 * ```
 *
 * Publish order: inventory -> read old index/descriptor (corruption fails closed,
 * zero object writes) -> upload new objects (fresh random keys, readback verified)
 * -> PUT snapshot descriptor (readback verified) -> **last** append to the
 * per-device index. Any earlier failure leaves invisible orphans and no index.
 *
 * The staging inventory is owned by L21 (`data_governance/backup/delta_inventory`),
 * which is not published in `host/plugins/backup/api.ts` yet. This module accepts a
 * minimal `DeltaInventoryProvider` interface; when it is absent the publish fails
 * closed instead of guessing or reimplementing L21's manifest cross-check.
 */

import { sha256Hasher, sha256Hex } from './hashing.ts';
import { dirname, join } from '../../../platform/util/path.ts';
import { isEncryptedBackup } from '../../../platform/secrets/dsbk-stream.ts';
import type { FileCipherSession } from '../../../platform/secrets/api.ts';
import type { CloudStorage } from '../api.ts';
import { acquireBackupRepoLease, type BackupRepoLeaseGuard } from './backup_lease.ts';
import {
  BACKUP_V2_FORMAT,
  DELTA_FORMAT_VERSION,
  MAX_IDENTIFIER_BYTES,
  SNAPSHOT_V2_FORMAT,
  decodeSnapshotDescriptor,
  encodeBackupV2RepoConfig,
  encodeSnapshotDescriptor,
  type BackupV2RepoConfig,
  type SnapshotDescriptorV2,
  type SnapshotFileRefV2,
} from './delta_format.ts';
import { normalizeDeviceId } from './device_id.ts';
import { bytesEqual, compareUtf8, utf8ByteLength, utf8Decode, utf8Encode } from './bytes.ts';
import { CloudStorageError } from './errors.ts';
import { fs } from './local-fs.ts';
import { defaultLogSink } from './logging.ts';
import { chronoAutoSiUtc, parseEpochMillis } from './time.ts';
import { randomUuid } from './random.ts';

/** Immutable logical file object directory (one more level per device). */
export const BACKUP_V2_OBJECTS_PREFIX = 'backup-v2/objects/';
/** Snapshot descriptor directory (one more level per device). */
export const BACKUP_V2_SNAPSHOTS_PREFIX = 'backup-v2/snapshots/';
/** Per-device index directory; the index PUT is the only visible commit point. */
export const BACKUP_V2_MANIFESTS_PREFIX = 'backup-v2/manifests/';
/** Repository config object; first publish writes it, existing is never overwritten. */
export const BACKUP_V2_CONFIG_KEY = 'backup-v2/config.dsbk';
/** Fixed per-device index format string. */
export const BACKUP_V2_INDEX_FORMAT = 'backup-v2-index';
/** Keep only the newest N index entries per device (pruned snapshots/objects stay for GC). */
export const DEFAULT_BACKUP_V2_MAX_VERSIONS = 10;

const MAX_OBJECT_KEY_ATTEMPTS = 16;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

// ------------------------------------------------------------------ inventory interface (L21)

/** One logical file from a verified staging inventory (`delta_inventory::InventoryEntry`). */
export interface DeltaInventoryEntry {
  logicalPath: string;
  size: number;
  plaintextSha256: string;
}

/** Canonical staging inventory (`delta_inventory::DeltaInventory`). */
export interface DeltaInventory {
  entries: DeltaInventoryEntry[];
  logicalSize: number;
}

/**
 * Minimal interface for L21's not-yet-published staging inventory builder.
 * `buildCrossChecked` must hash the disk and cross-check `manifest.json`, failing
 * closed on any mismatch; it must never trust manifest metadata over disk bytes.
 */
export interface DeltaInventoryProvider {
  buildCrossChecked(stagingRoot: string): Promise<DeltaInventory>;
}

/** Mirrors `delta_inventory::diff` (pure; kept local so no L21 implementation is copied). */
export function diffInventories(previous: DeltaInventory, current: DeltaInventory): {
  reuse: DeltaInventoryEntry[];
  uploadNew: DeltaInventoryEntry[];
  deleted: string[];
} {
  const previousByPath = new Map(previous.entries.map(entry => [entry.logicalPath, entry]));
  const currentPaths = new Set(current.entries.map(entry => entry.logicalPath));
  const reuse: DeltaInventoryEntry[] = [];
  const uploadNew: DeltaInventoryEntry[] = [];
  for (const entry of current.entries) {
    const old = previousByPath.get(entry.logicalPath);
    if (old !== undefined && old.size === entry.size && old.plaintextSha256 === entry.plaintextSha256) {
      reuse.push(entry);
    } else {
      uploadNew.push(entry);
    }
  }
  const deleted = previous.entries
    .filter(entry => !currentPaths.has(entry.logicalPath))
    .map(entry => entry.logicalPath);
  return { reuse, uploadNew, deleted };
}

// ------------------------------------------------------------------ index codec

/** One entry in the per-device version index. */
export interface BackupV2IndexEntry {
  id: string;
  timestamp: string;
  deviceId: string;
  appVersion?: string;
  note?: string;
  format: string;
  snapshotKey: string;
  snapshotCipherSha256: string;
  snapshotSize: number;
  logicalSize: number;
  newlyUploadedSize: number;
}

function validation(message: string): CloudStorageError {
  return new CloudStorageError('Validation', message);
}

function byteLength(value: string): number {
  return utf8ByteLength(value);
}

function isHexSha256(value: string): boolean {
  return value.length === 64 && /^[0-9a-fA-F]+$/.test(value);
}

function validateIndexIdentifier(field: string, value: string): void {
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

function validateSnapshotKey(key: string): void {
  if (!key.startsWith(BACKUP_V2_SNAPSHOTS_PREFIX)) {
    throw validation(`versions[].snapshotKey 必须位于 ${BACKUP_V2_SNAPSHOTS_PREFIX} 下`);
  }
  if (key.includes('\\') || utf8Encode(key).includes(0)
    || key.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw validation('versions[].snapshotKey 含非法路径段（穿越 / 空段 / 反斜杠 / NUL）');
  }
}

function validateIndexEntry(entry: BackupV2IndexEntry): void {
  validateIndexIdentifier('versions[].id', entry.id);
  validateIndexIdentifier('versions[].deviceId', entry.deviceId);
  if (parseEpochMillis(entry.timestamp) === null) {
    throw validation('versions[].timestamp 必须是合法 RFC 3339 时间戳');
  }
  if (entry.format !== SNAPSHOT_V2_FORMAT) {
    throw validation(`versions[].format 必须是 ${SNAPSHOT_V2_FORMAT}，实际为 ${entry.format}`);
  }
  validateSnapshotKey(entry.snapshotKey);
  if (!isHexSha256(entry.snapshotCipherSha256)) {
    throw validation('versions[].snapshotCipherSha256 必须是 64 位十六进制 SHA-256');
  }
}

function u64(value: number, field: string): bigint {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw validation(`${field} 必须是 0..2^53-1 的整数`);
  }
  return BigInt(value);
}

/** Per-device version index (`backup-v2/manifests/<device_id>.json`). */
export class BackupV2DeviceIndex {
  format: string;
  formatVersion: number;
  deviceId: string;
  latest?: string;
  updatedAt: string;
  versions: BackupV2IndexEntry[];

  constructor(fields: {
    format: string;
    formatVersion: number;
    deviceId: string;
    latest?: string;
    updatedAt: string;
    versions: BackupV2IndexEntry[];
  }) {
    this.format = fields.format;
    this.formatVersion = fields.formatVersion;
    this.deviceId = fields.deviceId;
    if (fields.latest !== undefined) this.latest = fields.latest;
    this.updatedAt = fields.updatedAt;
    this.versions = fields.versions;
  }

  static empty(deviceId: string, nowMs: number): BackupV2DeviceIndex {
    return new BackupV2DeviceIndex({
      format: BACKUP_V2_INDEX_FORMAT,
      formatVersion: DELTA_FORMAT_VERSION,
      deviceId,
      updatedAt: chronoAutoSiUtc(nowMs),
      versions: [],
    });
  }

  validate(): void {
    if (this.format !== BACKUP_V2_INDEX_FORMAT) {
      throw validation(`备份索引 format 必须是 ${BACKUP_V2_INDEX_FORMAT}，实际为 ${this.format}`);
    }
    if (this.formatVersion !== DELTA_FORMAT_VERSION) {
      throw validation(
        `备份索引 formatVersion 必须恰好为 ${DELTA_FORMAT_VERSION}，实际为 ${this.formatVersion}；`
          + '未来版本 fail-closed，不猜测解读',
      );
    }
    validateIndexIdentifier('deviceId', this.deviceId);
    if (parseEpochMillis(this.updatedAt) === null) {
      throw validation('updatedAt 必须是合法 RFC 3339 时间戳');
    }
    const seen = new Set<string>();
    for (const entry of this.versions) {
      validateIndexEntry(entry);
      if (entry.deviceId !== this.deviceId) {
        throw validation(`索引条目 ${entry.id} 的 deviceId 与索引本身不符，fail-closed`);
      }
      if (seen.has(entry.id)) {
        throw validation(`索引版本 ID 重复：${entry.id}（fail-closed）`);
      }
      seen.add(entry.id);
    }
    if (this.latest === undefined) {
      if (this.versions.length > 0) {
        throw validation('索引 versions 非空时 latest 不能为空');
      }
    } else if (!this.versions.some(entry => entry.id === this.latest)) {
      throw validation(`索引 latest=${this.latest} 未指向任何 versions 条目，fail-closed`);
    }
  }

  encode(): Uint8Array {
    this.validate();
    try {
      return utf8Encode(JSON.stringify(this, null, 2));
    } catch (error) {
      throw new CloudStorageError('Unknown',
        `备份索引序列化失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  static decode(bytes: Uint8Array): BackupV2DeviceIndex {
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8Decode(bytes));
    } catch (error) {
      throw validation(`备份索引解析失败（fail-closed）: ${error instanceof Error ? error.message : String(error)}`);
    }
    const object = expectObject(parsed, '备份索引');
    expectFields(object, '备份索引', ['format', 'formatVersion', 'deviceId', 'updatedAt', 'versions'], ['latest']);
    if (!Array.isArray(object.versions)) throw validation('备份索引解析失败: versions 必须是数组');
    const versions = object.versions.map((item, index) => {
      const entry = expectObject(item, `versions[${index}]`);
      expectFields(entry, `versions[${index}]`, [
        'id', 'timestamp', 'deviceId', 'format', 'snapshotKey',
        'snapshotCipherSha256', 'snapshotSize', 'logicalSize', 'newlyUploadedSize',
      ], ['appVersion', 'note']);
      return {
        id: expectString(entry.id, `versions[${index}].id`),
        timestamp: expectString(entry.timestamp, `versions[${index}].timestamp`),
        deviceId: expectString(entry.deviceId, `versions[${index}].deviceId`),
        ...(entry.appVersion === undefined ? {} : { appVersion: expectString(entry.appVersion, `versions[${index}].appVersion`) }),
        ...(entry.note === undefined ? {} : { note: expectString(entry.note, `versions[${index}].note`) }),
        format: expectString(entry.format, `versions[${index}].format`),
        snapshotKey: expectString(entry.snapshotKey, `versions[${index}].snapshotKey`),
        snapshotCipherSha256: expectString(entry.snapshotCipherSha256, `versions[${index}].snapshotCipherSha256`),
        snapshotSize: expectU64(entry.snapshotSize, `versions[${index}].snapshotSize`),
        logicalSize: expectU64(entry.logicalSize, `versions[${index}].logicalSize`),
        newlyUploadedSize: expectU64(entry.newlyUploadedSize, `versions[${index}].newlyUploadedSize`),
      } satisfies BackupV2IndexEntry;
    });
    const index = new BackupV2DeviceIndex({
      format: expectString(object.format, 'format'),
      formatVersion: expectU32(object.formatVersion, 'formatVersion'),
      deviceId: expectString(object.deviceId, 'deviceId'),
      ...(object.latest === undefined ? {} : { latest: expectString(object.latest, 'latest') }),
      updatedAt: expectString(object.updatedAt, 'updatedAt'),
      versions,
    });
    index.validate();
    return index;
  }
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validation(`${label} 解析失败: 顶层必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function expectFields(
  object: Record<string, unknown>,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  for (const key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw validation(
        `${label} 解析失败: unknown field \`${key}\`, expected one of `
          + [...required, ...optional].map(field => `\`${field}\``).join(', '),
      );
    }
  }
  for (const key of required) {
    if (!(key in object)) throw validation(`${label} 解析失败: missing field \`${key}\``);
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validation(`${field} 必须是字符串`);
  return value;
}

function expectU32(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
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

/** Cloud key of a device's version index. */
export function deviceIndexKey(deviceId: string): string {
  return `${BACKUP_V2_MANIFESTS_PREFIX}${deviceId}.json`;
}

// ------------------------------------------------------------------ publish

/** Publish parameters. */
export interface PublishParams {
  deviceId: string;
  appVersion?: string;
  note?: string;
  cipher?: FileCipherSession | null;
}

/** One successful publish. */
export interface PublishResult {
  versionId: string;
  snapshotKey: string;
  logicalSize: number;
  newlyUploadedSize: number;
  reusedSize: number;
  reusedFileCount: number;
  uploadedFileCount: number;
}

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hasher = sha256Hasher();
  let size = 0;
  for await (const chunk of fs.readChunks(path, 64 * 1024)) {
    hasher.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: hasher.digestHex(), size };
}

function inventoryFromDescriptor(descriptor: SnapshotDescriptorV2): DeltaInventory {
  const entries = descriptor.files.map(file => ({
    logicalPath: file.logicalPath,
    size: file.size,
    plaintextSha256: file.plaintextSha256,
  }));
  entries.sort((left, right) => compareUtf8(left.logicalPath, right.logicalPath));
  return { entries, logicalSize: descriptor.logicalSize };
}

function generateVersionId(deviceId: string, nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const stamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    + `-${pad(date.getUTCMilliseconds(), 3)}`;
  const deviceShort = [...deviceId].filter(character => /[A-Za-z0-9]/.test(character)).slice(0, 6).join('');
  const nonce = randomUuid().replaceAll('-', '').slice(0, 8);
  return `${stamp}-${deviceShort}-${nonce}`;
}

function decodeStoredDescriptor(
  bytes: Uint8Array,
  cipher: FileCipherSession | null | undefined,
  label: string,
): Promise<Uint8Array> {
  if (cipher !== null && cipher !== undefined) {
    if (!isEncryptedBackup(bytes)) {
      return Promise.reject(validation(
        `已配置加密会话，但 ${label} 不是 DSBK 密文；加密策略不一致，fail-closed`,
      ));
    }
    return cipher.decryptBytes(bytes).catch(error => {
      throw validation(`解密 ${label} 失败（密码错或数据损坏），fail-closed：${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (isEncryptedBackup(bytes)) {
    return Promise.reject(validation(
      `${label} 是 DSBK 密文，但本次未提供加密会话；不得静默改变加密策略，fail-closed`,
    ));
  }
  return Promise.resolve(bytes);
}

async function loadPreviousDescriptor(
  storage: CloudStorage,
  index: BackupV2DeviceIndex,
  deviceId: string,
  cipher: FileCipherSession | null | undefined,
): Promise<SnapshotDescriptorV2> {
  const latestId = index.latest;
  if (latestId === undefined) throw validation('索引缺少 latest，fail-closed');
  const entry = index.versions.find(candidate => candidate.id === latestId);
  if (entry === undefined) throw validation('索引 latest 指向不存在的条目，fail-closed');

  const bytes = await storage.get(entry.snapshotKey);
  if (bytes === null) {
    throw validation(
      `上一份 snapshot descriptor 缺失（${entry.snapshotKey}），fail-closed：拒绝发布，零新对象写入`,
    );
  }
  if (bytes.byteLength !== entry.snapshotSize
    || sha256Hex(bytes).toLowerCase() !== entry.snapshotCipherSha256.toLowerCase()) {
    throw validation(
      `上一份 snapshot descriptor（${entry.snapshotKey}）与索引登记的大小/哈希不符，`
        + 'fail-closed：拒绝发布，零新对象写入',
    );
  }
  const plaintext = await decodeStoredDescriptor(bytes, cipher, '上一份 descriptor');
  const descriptor = decodeSnapshotDescriptor(plaintext);
  if (descriptor.deviceId !== deviceId) {
    throw validation('上一份 descriptor 的 deviceId 与本设备不符；跨设备对象一律不复用，fail-closed');
  }
  if (descriptor.versionId !== latestId) {
    throw validation('上一份 descriptor 的 versionId 与索引 latest 不符，fail-closed');
  }
  return descriptor;
}

async function uploadNewObject(
  storage: CloudStorage,
  stagingRoot: string,
  entry: DeltaInventoryEntry,
  deviceId: string,
  cipher: FileCipherSession | null | undefined,
  scratchDir: string,
): Promise<SnapshotFileRefV2> {
  const source = join(stagingRoot, entry.logicalPath);
  let encryptedTemp: string | null = null;
  let uploadPath = source;
  if (cipher !== null && cipher !== undefined) {
    encryptedTemp = join(scratchDir, `.delta-object-${randomUuid()}.dsbk`);
    await cipher.encryptFile(source, encryptedTemp).catch(error => {
      throw new CloudStorageError('Unknown',
        `加密备份对象失败: ${error instanceof Error ? error.message : String(error)}`);
    });
    uploadPath = encryptedTemp;
  }

  try {
    const { sha256: objectCipherSha256, size: objectSize } = await sha256File(uploadPath);

    let objectKey: string | null = null;
    for (let attempt = 0; attempt < MAX_OBJECT_KEY_ATTEMPTS; attempt += 1) {
      const candidate = `${BACKUP_V2_OBJECTS_PREFIX}${deviceId}/${randomUuid()}.dsbk`;
      if (!await storage.exists(candidate)) {
        objectKey = candidate;
        break;
      }
    }
    if (objectKey === null) {
      throw new CloudStorageError('Unknown',
        '连续生成的随机对象 key 均已存在，存储行为异常，fail-closed');
    }

    await storage.putFile(objectKey, uploadPath, null);
    const readback = await storage.get(objectKey);
    if (readback === null) {
      throw new CloudStorageError('Network',
        `对象 ${objectKey} 上传后回读缺失，已中止发布（fail-closed）`);
    }
    if (readback.byteLength !== objectSize || sha256Hex(readback) !== objectCipherSha256) {
      throw new CloudStorageError('Network',
        `对象 ${objectKey} 回读字节与本地不符，已中止发布（fail-closed）`);
    }

    return {
      logicalPath: entry.logicalPath,
      size: entry.size,
      plaintextSha256: entry.plaintextSha256,
      objectKey,
      objectCipherSha256,
    };
  } finally {
    if (encryptedTemp !== null) await fs.rm(encryptedTemp, { force: true });
  }
}

function checkedAddU64(left: number, right: number, message: string): number {
  const sum = u64(left, 'size') + u64(right, 'size');
  if (sum > U64_MAX) throw validation(message);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw validation(`${message}（超过 JS 安全整数上限，fail-closed）`);
  }
  return Number(sum);
}

function descriptorEquals(left: SnapshotDescriptorV2, right: SnapshotDescriptorV2): boolean {
  if (left.format !== right.format || left.formatVersion !== right.formatVersion
    || left.versionId !== right.versionId || left.deviceId !== right.deviceId
    || left.createdAt !== right.createdAt || left.logicalSize !== right.logicalSize
    || left.files.length !== right.files.length) {
    return false;
  }
  return left.files.every((file, index) => {
    const other = right.files[index]!;
    return file.logicalPath === other.logicalPath
      && file.size === other.size
      && file.plaintextSha256 === other.plaintextSha256
      && file.objectKey === other.objectKey
      && file.objectCipherSha256 === other.objectCipherSha256;
  });
}

async function releaseBestEffort(guard: BackupRepoLeaseGuard): Promise<void> {
  // Rust logs a warning and lets the TTL reclaim the lease; the publish result is
  // not turned into a failure after the commit point.
  const [result] = await Promise.allSettled([guard.release()]);
  if (result.status === 'rejected') {
    defaultLogSink().warn(
      `[delta-upload] 释放备份仓库租约失败（将由 TTL 兜底）: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    );
  }
}

/**
 * Publishes a verified backup staging directory as a backup-v2 snapshot version.
 *
 * The whole publish window holds the backup-v2 repository lease (stable
 * `E_BACKUP_LEASE_HELD` on contention). Reuse comes only from this device's
 * previous descriptor's `reuseCandidates` (`manifest.json` is always re-uploaded).
 * Old index/descriptor decode/validation/decryption failures fail closed before any
 * new object write. The index PUT is the only visible commit point; earlier
 * failures leave invisible orphans and no index.
 */
export async function publishVerifiedStaging(
  storage: CloudStorage,
  stagingRoot: string,
  params: PublishParams,
  inventoryProvider?: DeltaInventoryProvider,
): Promise<PublishResult> {
  if (params.deviceId.trim() === '') {
    throw validation('设备 ID 为空，拒绝发布 backup-v2 快照（fail-closed）');
  }
  if (inventoryProvider === undefined) {
    throw new CloudStorageError('Configuration',
      'backup-v2 发布需要 L21 的 delta_inventory 服务（build_inventory_cross_checked），'
        + '当前 host/plugins/backup/api.ts 尚未发布；拒绝发布（fail-closed）');
  }
  const deviceId = normalizeDeviceId(params.deviceId);
  validateIndexIdentifier('deviceId', deviceId);

  const guard = await acquireBackupRepoLease(storage, deviceId);
  try {
    return await publishLocked(storage, stagingRoot, params, deviceId, inventoryProvider);
  } finally {
    await releaseBestEffort(guard);
  }
}

async function publishLocked(
  storage: CloudStorage,
  stagingRoot: string,
  params: PublishParams,
  deviceId: string,
  inventoryProvider: DeltaInventoryProvider,
): Promise<PublishResult> {
  // 1. Verified staging inventory (unverified staging fails closed).
  let inventory: DeltaInventory;
  try {
    inventory = await inventoryProvider.buildCrossChecked(stagingRoot);
  } catch (error) {
    throw validation(`staging 未通过验证，拒绝发布（fail-closed）: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. This device's index and previous descriptor.
  const indexKey = deviceIndexKey(deviceId);
  const indexBytes = await storage.get(indexKey);
  let existingIndex: BackupV2DeviceIndex | null = null;
  if (indexBytes !== null) {
    const index = BackupV2DeviceIndex.decode(indexBytes);
    if (index.deviceId !== deviceId) {
      throw validation('版本索引 deviceId 与本设备不符，fail-closed');
    }
    existingIndex = index;
  }
  const previousDescriptor = existingIndex !== null && existingIndex.versions.length > 0
    ? await loadPreviousDescriptor(storage, existingIndex, deviceId, params.cipher)
    : null;

  // 3. Reuse plan; manifest.json is always re-uploaded.
  const reusedRefs: SnapshotFileRefV2[] = [];
  const uploadEntries: DeltaInventoryEntry[] = [];
  if (previousDescriptor !== null) {
    const previousInventory = inventoryFromDescriptor(previousDescriptor);
    const plan = diffInventories(previousInventory, inventory);
    const reusablePaths = new Set(
      plan.reuse.filter(entry => entry.logicalPath !== 'manifest.json').map(entry => entry.logicalPath),
    );
    const previousByPath = new Map(previousDescriptor.files.map(file => [file.logicalPath, file]));
    for (const entry of inventory.entries) {
      if (reusablePaths.has(entry.logicalPath)) {
        const previousRef = previousByPath.get(entry.logicalPath);
        if (previousRef === undefined) {
          throw new CloudStorageError('Unknown',
            '复用候选在上一份 descriptor 中缺失（内部不变量被破坏）');
        }
        reusedRefs.push({
          logicalPath: entry.logicalPath,
          size: entry.size,
          plaintextSha256: entry.plaintextSha256,
          objectKey: previousRef.objectKey,
          objectCipherSha256: previousRef.objectCipherSha256,
        });
      } else {
        uploadEntries.push(entry);
      }
    }
  } else {
    uploadEntries.push(...inventory.entries);
  }

  // 4. First publish writes the repository config; existing config is never overwritten.
  if (await storage.get(BACKUP_V2_CONFIG_KEY) === null) {
    const config: BackupV2RepoConfig = {
      format: BACKUP_V2_FORMAT,
      formatVersion: DELTA_FORMAT_VERSION,
      idKeyEpoch: 1,
    };
    const encoded = encodeBackupV2RepoConfig(config);
    const stored = params.cipher ? await params.cipher.encryptBytes(encoded).catch(error => {
      throw new CloudStorageError('Unknown',
        `加密仓库配置失败: ${error instanceof Error ? error.message : String(error)}`);
    }) : encoded;
    await storage.put(BACKUP_V2_CONFIG_KEY, stored);
  }

  // 5. Upload new objects (fresh random key + readback verification).
  const scratch = await fs.mkdtemp(join(dirname(stagingRoot) || '.', '.delta-upload-scratch-')).catch(error => {
    throw new CloudStorageError('FileSystem',
      `创建上传临时目录失败: ${error instanceof Error ? error.message : String(error)}`);
  });
  let uploadedRefs: SnapshotFileRefV2[];
  let newlyUploadedSize = 0;
  try {
    uploadedRefs = [];
    for (const entry of uploadEntries) {
      const fileRef = await uploadNewObject(
        storage, stagingRoot, entry, deviceId, params.cipher, scratch,
      );
      newlyUploadedSize = checkedAddU64(newlyUploadedSize, entry.size, '新上传字节数溢出 u64，拒绝发布');
      uploadedRefs.push(fileRef);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }

  let reusedSize = 0;
  for (const fileRef of reusedRefs) {
    reusedSize = checkedAddU64(reusedSize, fileRef.size, '复用字节数溢出 u64，拒绝发布');
  }

  // 6. Self-contained descriptor (no parent/patch; codec denies unknown fields).
  const reusedFileCount = reusedRefs.length;
  const uploadedFileCount = uploadedRefs.length;
  const now = Date.now();
  const versionId = generateVersionId(deviceId, now);
  const files = [...reusedRefs, ...uploadedRefs];
  files.sort((left, right) => compareUtf8(left.logicalPath, right.logicalPath));
  const descriptor: SnapshotDescriptorV2 = {
    format: SNAPSHOT_V2_FORMAT,
    formatVersion: DELTA_FORMAT_VERSION,
    versionId,
    deviceId,
    createdAt: chronoAutoSiUtc(now),
    files,
    logicalSize: inventory.logicalSize,
  };
  const encodedDescriptor = encodeSnapshotDescriptor(descriptor);
  const storedDescriptor = params.cipher
    ? await params.cipher.encryptBytes(encodedDescriptor).catch(error => {
      throw new CloudStorageError('Unknown',
        `加密 snapshot descriptor 失败: ${error instanceof Error ? error.message : String(error)}`);
    })
    : encodedDescriptor;
  const snapshotKey = `${BACKUP_V2_SNAPSHOTS_PREFIX}${deviceId}/${versionId}.dsbk`;
  if (await storage.exists(snapshotKey)) {
    throw new CloudStorageError('Conflict',
      `snapshot key 已存在（${snapshotKey}），拒绝覆盖不可变对象`);
  }
  await storage.put(snapshotKey, storedDescriptor);

  const readback = await storage.get(snapshotKey);
  if (readback === null) {
    throw new CloudStorageError('Network',
      'snapshot descriptor 上传后回读缺失，已中止发布（fail-closed）');
  }
  if (!bytesEqual(readback, storedDescriptor)) {
    throw new CloudStorageError('Network',
      'snapshot descriptor 回读字节与本地不符，已中止发布（fail-closed）');
  }
  const readbackPlain = params.cipher
    ? await params.cipher.decryptBytes(readback).catch(error => {
      throw new CloudStorageError('Unknown',
        `回读 snapshot descriptor 解密失败: ${error instanceof Error ? error.message : String(error)}`);
    })
    : readback;
  const readbackDescriptor = decodeSnapshotDescriptor(readbackPlain);
  if (!descriptorEquals(readbackDescriptor, descriptor)) {
    throw new CloudStorageError('Network',
      '回读的 snapshot descriptor 与本地不一致，已中止发布（fail-closed）');
  }

  // 7. Only commit point: append the new version to this device's index.
  const snapshotCipherSha256 = sha256Hex(storedDescriptor);
  const index = existingIndex ?? BackupV2DeviceIndex.empty(deviceId, now);
  index.versions.unshift({
    id: versionId,
    timestamp: chronoAutoSiUtc(now),
    deviceId,
    ...(params.appVersion === undefined ? {} : { appVersion: params.appVersion }),
    ...(params.note === undefined ? {} : { note: params.note }),
    format: SNAPSHOT_V2_FORMAT,
    snapshotKey,
    snapshotCipherSha256,
    snapshotSize: storedDescriptor.byteLength,
    logicalSize: inventory.logicalSize,
    newlyUploadedSize,
  });
  index.versions.sort((left, right) => {
    const leftTime = parseEpochMillis(left.timestamp);
    const rightTime = parseEpochMillis(right.timestamp);
    if (leftTime !== rightTime) {
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return rightTime - leftTime;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  if (index.versions.length > DEFAULT_BACKUP_V2_MAX_VERSIONS) {
    index.versions.splice(DEFAULT_BACKUP_V2_MAX_VERSIONS);
  }
  index.latest = versionId;
  index.updatedAt = chronoAutoSiUtc(now);
  const indexOut = index.encode();
  await storage.put(indexKey, indexOut);
  const indexReadback = await storage.get(indexKey);
  if (indexReadback === null) {
    throw new CloudStorageError('Network',
      '版本索引写入后回读缺失，commit 状态不明，请重试');
  }
  if (!bytesEqual(indexReadback, indexOut)) {
    throw new CloudStorageError('Network',
      '版本索引回读字节与本地不符，commit 状态不明，请重试');
  }

  return {
    versionId,
    snapshotKey,
    logicalSize: inventory.logicalSize,
    newlyUploadedSize,
    reusedSize,
    reusedFileCount,
    uploadedFileCount,
  };
}
