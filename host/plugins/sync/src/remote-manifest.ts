/**
 * 云端清单下载（`SyncManager::download_manifest`，sync/mod.rs:2112）。
 *
 * 合并所有其他设备的 per-device 清单：
 * - 同一数据库按 schema 版本优先、再按 data_version 取高者；
 * - 同 schema 同 data_version 但 checksum 不同 → 标记分叉哨兵并告警；
 * - 新格式清单缺失时回退旧的单文件清单；
 * - 解密失败硬错误（fail-close），损坏 JSON 仅告警跳过。
 */
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { SyncLogger } from './log.ts';
import { SyncError } from './errors.ts';
import { deviceIdShortHash } from '../../sync-providers/api.ts';
export { pathIdMatchesDevice } from './change-keys.ts';
import {
  isJsonFloat,
  isJsonObject,
  parseJsonLossless,
  type DbJson,
} from '../../../platform/util/lossless-json.ts';
import { parseFlexibleTimestampSqlite } from '../../../platform/time/index.ts';
import { rustTrim, decodeUtf8Strict } from '../../../platform/util/index.ts';
import { pathIdMatchesDevice } from './change-keys.ts';
import type { PayloadCodec } from './payload.ts';
import type { DatabaseSyncState, SyncManifest, SyncTransactionStatus } from './merge.ts';
import { toRfc3339 as nowRfc3339 } from '../../../platform/time/index.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const MANIFESTS_PREFIX = 'data_governance/manifests';
export const LEGACY_MANIFEST_KEY = 'data_governance/sync_manifest.json';
export const DIVERGED_CHECKSUM_SENTINEL = '__cloud_diverged_same_version__';

const STATUS_VALUES: readonly SyncTransactionStatus[] = ['Complete', 'Partial', 'Failed'];
const U64_MAX = 18_446_744_073_709_551_615n;
const U32_MAX = 4_294_967_295n;

function parseError(detail: string): never {
  throw new Error(detail);
}

function expectObject(value: DbJson | undefined, field: string): { [key: string]: DbJson } {
  if (!isJsonObject(value)) parseError(`字段 ${field} 必须是对象`);
  return value;
}

function expectString(value: DbJson | undefined, field: string): string {
  if (typeof value !== 'string') parseError(`字段 ${field} 必须是字符串`);
  return value;
}

function expectOptionalString(value: DbJson | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') parseError(`字段 ${field} 必须是字符串`);
  return value;
}

function expectUnsigned(value: DbJson | undefined, field: string, max: bigint): number | bigint {
  if (typeof value === 'bigint') {
    if (value < 0n || value > max) parseError(`字段 ${field} 超出范围`);
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && BigInt(value) <= max) {
    return value;
  }
  return parseError(`字段 ${field} 必须是无符号整数`);
}

function parseDatabaseState(value: DbJson | undefined, database: string): DatabaseSyncState {
  const obj = expectObject(value, `databases.${database}`);
  return {
    schema_version: Number(expectUnsigned(obj.schema_version, `${database}.schema_version`, U32_MAX)),
    data_version: expectUnsigned(obj.data_version, `${database}.data_version`, U64_MAX),
    checksum: expectString(obj.checksum, `${database}.checksum`),
    last_updated_at: expectOptionalString(obj.last_updated_at, `${database}.last_updated_at`),
  };
}

/** serde 反序列化 `SyncManifest`（未知字段忽略，`#[serde(default)]` 字段补默认值）。 */
export function parseSyncManifest(text: string): SyncManifest {
  const root = expectObject(parseJsonLossless(text), 'manifest');
  const databases: Record<string, DatabaseSyncState> = {};
  if (root.databases !== undefined) {
    const rawDatabases = expectObject(root.databases, 'databases');
    for (const [name, state] of Object.entries(rawDatabases)) {
      databases[name] = parseDatabaseState(state, name);
    }
  } else {
    parseError('缺少字段 databases');
  }

  const status = expectString(root.status, 'status');
  if (!(STATUS_VALUES as readonly string[]).includes(status)) {
    parseError(`字段 status 非法: ${status}`);
  }

  const cursors: Record<string, number | bigint> = {};
  if (root.cursors !== undefined) {
    const rawCursors = expectObject(root.cursors, 'cursors');
    for (const [device, cursor] of Object.entries(rawCursors)) {
      cursors[device] = expectUnsigned(cursor, `cursors.${device}`, U64_MAX);
    }
  }

  const snapshotSeen: Record<string, string> = {};
  if (root.snapshot_seen !== undefined) {
    const rawSnapshot = expectObject(root.snapshot_seen, 'snapshot_seen');
    for (const [db, seen] of Object.entries(rawSnapshot)) {
      snapshotSeen[db] = expectString(seen, `snapshot_seen.${db}`);
    }
  }

  return {
    sync_transaction_id: expectString(root.sync_transaction_id, 'sync_transaction_id'),
    databases,
    status: status as SyncTransactionStatus,
    created_at: expectString(root.created_at, 'created_at'),
    device_id: expectString(root.device_id, 'device_id'),
    format_version: root.format_version === undefined
      ? 2
      : Number(expectUnsigned(root.format_version, 'format_version', U32_MAX)),
    published_max_seq: root.published_max_seq === undefined
      ? 0
      : expectUnsigned(root.published_max_seq, 'published_max_seq', U64_MAX),
    cursors,
    superseded_by: expectOptionalString(root.superseded_by, 'superseded_by'),
    snapshot_seen: snapshotSeen,
  };
}

function toBigIntVersion(value: number | bigint | undefined): bigint {
  return typeof value === 'bigint' ? value : BigInt(value ?? 0);
}

function compareVersions(left: number | bigint | undefined, right: number | bigint | undefined): number {
  const a = toBigIntVersion(left);
  const b = toBigIntVersion(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyManifest(): SyncManifest {
  return {
    sync_transaction_id: '',
    databases: {},
    status: 'Complete',
    created_at: nowRfc3339(),
    device_id: '',
    format_version: 3,
    published_max_seq: 0,
    cursors: {},
    superseded_by: null,
    snapshot_seen: {},
  };
}

/** `device_manifest_key` / `path_id_matches_device`（sync/mod.rs:1419）。 */
export function deviceManifestKey(deviceId: string): string {
  return `${MANIFESTS_PREFIX}/${deviceIdShortHash(deviceId)}.json`;
}

/** mod.rs: device_manifest_legacy_key, used for migration and superseded marking. */
export function deviceManifestLegacyKey(deviceId: string): string {
  return `${MANIFESTS_PREFIX}/${deviceId}.json`;
}

export interface DownloadManifestContext {
  deviceId: string;
  codec: PayloadCodec;
  logger?: SyncLogger | null;
}

/** `SyncManager::download_manifest`（sync/mod.rs:2112）。 */
export async function downloadManifest(
  storage: CloudStorage,
  context: DownloadManifestContext,
): Promise<SyncManifest> {
  let list;
  try {
    list = await storage.listOutcome(MANIFESTS_PREFIX);
  } catch (error) {
    throw new SyncError(`Network error: 列出清单文件失败: ${message(error)}`);
  }
  if (list.truncated) {
    throw new SyncError('Network error: 云端清单列表被截断，已停止同步以避免漏读设备状态');
  }

  const mergedDatabases: Record<string, DatabaseSyncState> = {};
  let anyFound = false;
  let latestCreatedAtNanos: bigint | null = null;
  let latestCreatedAtRaw = '';
  const mergedDivergence = new Set<string>();

  for (const file of list.files) {
    const tail = file.key.slice(file.key.lastIndexOf('/') + 1);
    const fileDeviceId = tail.endsWith('.json') ? tail.slice(0, -'.json'.length) : '';
    if (fileDeviceId === '' || pathIdMatchesDevice(fileDeviceId, context.deviceId)) continue;

    let bytes: Uint8Array | null;
    try {
      bytes = await storage.get(file.key);
    } catch (error) {
      throw new SyncError(`Network error: 下载设备清单失败 ${file.key}: ${message(error)}`);
    }
    if (bytes === null) continue;

    let decoded: Uint8Array;
    try {
      decoded = await context.codec.decode(bytes);
    } catch (error) {
      throw new SyncError(
        `Database error: 设备清单无法解密，已停止同步（请检查加密密码）: ${file.key} (${message(error)})`,
      );
    }

    let manifest: SyncManifest;
    try {
      manifest = parseSyncManifest(decodeUtf8Strict(decoded));
    } catch (error) {
      context.logger?.warn(`[sync] 跳过损坏设备清单: key=${file.key}, error=${message(error)}`);
      continue;
    }

    if (manifest.superseded_by != null || pathIdMatchesDevice(manifest.device_id, context.deviceId)) {
      continue;
    }
    anyFound = true;

    const createdAt = parseFlexibleTimestampSqlite(manifest.created_at);
    if (createdAt !== null) {
      const nanos = createdAt.epochNanos;
      if (latestCreatedAtNanos === null || nanos > latestCreatedAtNanos) {
        latestCreatedAtNanos = nanos;
        latestCreatedAtRaw = manifest.created_at;
      }
    }

    for (const [databaseName, state] of Object.entries(manifest.databases)) {
      const entry = mergedDatabases[databaseName];
      if (entry === undefined) {
        mergedDatabases[databaseName] = { ...state };
        continue;
      }
      if (
        state.schema_version > entry.schema_version
        || (state.schema_version === entry.schema_version
          && compareVersions(state.data_version, entry.data_version) > 0)
      ) {
        mergedDatabases[databaseName] = { ...state };
      } else if (
        state.schema_version === entry.schema_version
        && compareVersions(state.data_version, entry.data_version) === 0
        && entry.checksum !== ''
        && state.checksum !== ''
        && state.checksum !== entry.checksum
      ) {
        mergedDivergence.add(databaseName);
        entry.checksum = DIVERGED_CHECKSUM_SENTINEL;
      }
    }

    context.logger?.debug(
      `[sync] 合并设备清单: device=${fileDeviceId}, databases=${Object.keys(manifest.databases).length}`,
    );
  }

  if (mergedDivergence.size > 0) {
    context.logger?.warn(`[sync] 检测到同版本云端分叉数据库: ${[...mergedDivergence].join(',')}`);
  }

  // 向后兼容：如果没有新格式清单，回退到旧的单文件。
  if (!anyFound) {
    let bytes: Uint8Array | null;
    try {
      bytes = await storage.get(LEGACY_MANIFEST_KEY);
    } catch (error) {
      throw new SyncError(`Network error: 下载旧版清单失败: ${message(error)}`);
    }
    if (bytes !== null) {
      const decoded = await context.codec.decode(bytes);
      let manifest: SyncManifest;
      try {
        manifest = parseSyncManifest(decodeUtf8Strict(decoded));
      } catch (error) {
        throw new SyncError(`Database error: 解析旧版清单失败: ${message(error)}`);
      }
      if (manifest.device_id !== context.deviceId) {
        context.logger?.info(
          `[sync] 从旧版单清单迁移读取: device=${manifest.device_id}, databases=${Object.keys(manifest.databases).length}`,
        );
        return manifest;
      }
    }
  }

  if (!anyFound && Object.keys(mergedDatabases).length === 0) {
    context.logger?.info('[sync] 云端没有其他设备的同步清单');
    return emptyManifest();
  }

  context.logger?.info(
    `[sync] 合并云端清单完成: other_devices=${Math.max(0, list.files.length - 1)}, merged_databases=${Object.keys(mergedDatabases).length}`,
  );

  return {
    sync_transaction_id: globalThis.crypto.randomUUID(),
    databases: mergedDatabases,
    status: 'Complete',
    created_at: latestCreatedAtRaw === '' ? nowRfc3339() : latestCreatedAtRaw,
    device_id: 'merged',
    format_version: 3,
    published_max_seq: 0,
    cursors: {},
    superseded_by: null,
    snapshot_seen: {},
  };
}

function compareSeq(left: number | bigint, right: number | bigint): number {
  const a = toBigIntVersion(left);
  const b = toBigIntVersion(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ReadDeviceManifestsOptions extends DownloadManifestContext {
  /** true 时以完整对象 key 为键（schema 门槛需要同时检查明文与短哈希清单）。 */
  preserveAliases?: boolean;
}

/**
 * `SyncManager::read_device_manifests`（sync/mod.rs:2288）。
 *
 * 与 `downloadManifest` 的「合并成一份状态」不同，这里保留每台设备的完整清单，
 * 供 schema 兼容性、prune 安全边界与 published_max_seq 判定使用。
 */
export async function readDeviceManifests(
  storage: CloudStorage,
  options: ReadDeviceManifestsOptions,
): Promise<Map<string, SyncManifest>> {
  let list;
  try {
    list = await storage.listOutcome(MANIFESTS_PREFIX);
  } catch (error) {
    throw new SyncError(`Network error: 列出清单文件失败: ${message(error)}`);
  }
  if (list.truncated) {
    throw new SyncError('Network error: 云端清单列表被截断，已停止同步以避免漏读设备状态');
  }

  const manifests = new Map<string, SyncManifest>();
  const preserveAliases = options.preserveAliases === true;
  for (const file of list.files) {
    const tail = file.key.slice(file.key.lastIndexOf('/') + 1);
    if (!tail.endsWith('.json')) continue;
    const deviceId = tail.slice(0, -'.json'.length);

    let bytes: Uint8Array | null;
    try {
      bytes = await storage.get(file.key);
    } catch (error) {
      throw new SyncError(`Network error: 下载设备清单失败 ${file.key}: ${message(error)}`);
    }
    if (bytes === null) {
      if (preserveAliases) {
        throw new SyncError(`Network error: 已列举的设备清单消失，无法确认 schema 兼容性: ${file.key}`);
      }
      continue;
    }

    let decoded: Uint8Array;
    try {
      decoded = await options.codec.decode(bytes);
    } catch (error) {
      throw new SyncError(
        `Database error: 设备清单无法解密，已停止同步（请检查加密密码）: ${file.key} (${message(error)})`,
      );
    }

    let manifest: SyncManifest;
    try {
      manifest = parseSyncManifest(decodeUtf8Strict(decoded));
    } catch (error) {
      throw new SyncError(`Database error: 设备清单损坏，无法证明全部客户端已升级: ${file.key} (${message(error)})`);
    }

    if (preserveAliases) {
      manifests.set(file.key, manifest);
      continue;
    }
    const canonical = rustTrim(manifest.device_id) === '' ? deviceId : manifest.device_id;
    const incomingHashed = file.key === deviceManifestKey(canonical);
    const existing = manifests.get(canonical);
    if (existing !== undefined) {
      const order = compareSeq(manifest.published_max_seq, existing.published_max_seq);
      if (order < 0 || (order === 0 && !incomingHashed)) continue;
    }
    manifests.set(canonical, manifest);
  }

  let legacyBytes: Uint8Array | null;
  try {
    legacyBytes = await storage.get(LEGACY_MANIFEST_KEY);
  } catch (error) {
    throw new SyncError(`Network error: 下载 legacy 清单失败: ${message(error)}`);
  }
  if (legacyBytes !== null) {
    let decoded: Uint8Array;
    try {
      decoded = await options.codec.decode(legacyBytes);
    } catch (error) {
      throw new SyncError(`Database error: legacy 清单无法解密，无法证明全部客户端已升级: ${message(error)}`);
    }
    let legacy: SyncManifest;
    try {
      legacy = parseSyncManifest(decodeUtf8Strict(decoded));
    } catch (error) {
      throw new SyncError(`Database error: legacy 清单损坏，无法证明全部客户端已升级: ${message(error)}`);
    }
    if (rustTrim(legacy.device_id) !== '') {
      const key = preserveAliases ? LEGACY_MANIFEST_KEY : legacy.device_id;
      if (!manifests.has(key)) manifests.set(key, legacy);
    }
  }
  return manifests;
}
