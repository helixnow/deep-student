/**
 * 远端同步格式协商（`SyncFormatDescriptor`，sync/mod.rs:753-812、1640-1944）。
 *
 * format.json 是明文对象：缺失视为 legacy v3；未来版本或更高 min_client fail-close。
 * 第一次写入先发布 v4 能力描述，但在兼容租约到期且所有已知客户端升级前继续写 v3 root。
 */
import type { CloudStorage } from '../../sync-providers/api.ts';
import { SyncError } from './errors.ts';
import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { nowEpochNanos, toRfc3339, parseFlexibleTimestampSqlite } from '../../../platform/time/index.ts';
import { decodeUtf8Strict } from '../../../platform/util/index.ts';
import type { SyncLogger } from './log.ts';
import { readDeviceManifests } from './remote-manifest.ts';
import type { PayloadCodec } from './payload.ts';

/**
 * `util.isDeepStrictEqual` for JSON-like data (primitives by `Object.is`, arrays, and objects with the same
 * prototype and the same own enumerable keys, compared recursively).
 */
function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    if (left.length !== other.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!isDeepStrictEqual(left[index], other[index])) return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => Object.hasOwn(right, key)
    && isDeepStrictEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const FORMAT_KEY = 'data_governance/format.json';
export const CURRENT_FORMAT_VERSION = 4;
export const MIN_COMPATIBLE_FORMAT_VERSION = 3;
export const COMPATIBILITY_RELEASE_DAYS = 30;

export interface SyncShardCheckpoint {
  generation: number | bigint;
  shard_cursors: Record<string, number | bigint>;
  complete: boolean;
  compaction_marker_key?: string | null;
  full_listing_verified: boolean;
}

export interface SyncCompatibilityLease {
  holder_device_id: string;
  operation_id: string;
  expires_at: string;
  min_writer_version: number;
}

export interface SyncFormatDescriptor {
  format_version: number;
  min_reader_version: number;
  features: string[];
  checkpoint: SyncShardCheckpoint | null;
  compatibility_lease: SyncCompatibilityLease | null;
}

const U32_MAX = 4_294_967_295n;

function descriptorError(detail: string): never {
  throw new Error(detail);
}

function expectObject(value: DbJson | undefined, field: string): { [key: string]: DbJson } {
  if (!isJsonObject(value)) descriptorError(`字段 ${field} 必须是对象`);
  return value;
}

function expectU32(value: DbJson | undefined, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && BigInt(value) <= U32_MAX) {
    return value;
  }
  if (typeof value === 'bigint' && value >= 0n && value <= U32_MAX) return Number(value);
  return descriptorError(`字段 ${field} 必须是无符号 32 位整数`);
}

function expectU64(value: DbJson | undefined, field: string): number | bigint {
  if (typeof value === 'bigint' && value >= 0n && value <= 18_446_744_073_709_551_615n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return descriptorError(`字段 ${field} 必须是无符号整数`);
}

function expectBoolean(value: DbJson | undefined, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  return descriptorError(`字段 ${field} 必须是布尔值`);
}

function expectString(value: DbJson | undefined, field: string): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return descriptorError(`字段 ${field} 必须是字符串`);
}

function parseCheckpoint(value: DbJson): SyncShardCheckpoint {
  const obj = expectObject(value, 'checkpoint');
  const cursors: Record<string, number | bigint> = {};
  if (obj.shard_cursors !== undefined) {
    for (const [key, cursor] of Object.entries(expectObject(obj.shard_cursors, 'checkpoint.shard_cursors'))) {
      cursors[key] = expectU64(cursor, `checkpoint.shard_cursors.${key}`);
    }
  }
  return {
    generation: obj.generation === undefined ? 0 : expectU64(obj.generation, 'checkpoint.generation'),
    shard_cursors: cursors,
    complete: expectBoolean(obj.complete, 'checkpoint.complete'),
    compaction_marker_key: obj.compaction_marker_key == null ? null
      : expectString(obj.compaction_marker_key, 'checkpoint.compaction_marker_key'),
    full_listing_verified: expectBoolean(obj.full_listing_verified, 'checkpoint.full_listing_verified'),
  };
}

function parseLease(value: DbJson): SyncCompatibilityLease {
  const obj = expectObject(value, 'compatibility_lease');
  return {
    holder_device_id: expectString(obj.holder_device_id, 'compatibility_lease.holder_device_id'),
    operation_id: expectString(obj.operation_id, 'compatibility_lease.operation_id'),
    expires_at: expectString(obj.expires_at, 'compatibility_lease.expires_at'),
    min_writer_version: obj.min_writer_version === undefined
      ? 0
      : expectU32(obj.min_writer_version, 'compatibility_lease.min_writer_version'),
  };
}

/** serde 反序列化 `SyncFormatDescriptor`（`min_client` 与旧名 `min_reader_version` 都接受）。 */
export function parseFormatDescriptor(text: string): SyncFormatDescriptor {
  const root = expectObject(parseJsonLossless(text), 'format');
  if (root.min_client !== undefined && root.min_reader_version !== undefined) {
    descriptorError('duplicate field `min_client`');
  }
  if (root.features !== undefined && !Array.isArray(root.features)) {
    descriptorError('字段 features 必须是数组');
  }
  const minRaw = root.min_client !== undefined ? root.min_client : root.min_reader_version;
  return {
    format_version: root.format_version === undefined ? 3 : expectU32(root.format_version, 'format_version'),
    min_reader_version: minRaw === undefined ? 3 : expectU32(minRaw, 'min_client'),
    features: Array.isArray(root.features)
      ? root.features.map((feature, index) => {
        if (typeof feature !== 'string') descriptorError(`字段 features[${index}] 必须是字符串`);
        return feature;
      })
      : [],
    checkpoint: root.checkpoint === undefined || root.checkpoint === null
      ? null
      : parseCheckpoint(root.checkpoint),
    compatibility_lease: root.compatibility_lease === undefined || root.compatibility_lease === null
      ? null
      : parseLease(root.compatibility_lease),
  };
}

export function descriptorToJson(descriptor: SyncFormatDescriptor): DbJson {
  return {
    format_version: descriptor.format_version,
    min_client: descriptor.min_reader_version,
    features: descriptor.features,
    ...(descriptor.checkpoint === null ? {} : {
      checkpoint: {
        generation: descriptor.checkpoint.generation,
        shard_cursors: descriptor.checkpoint.shard_cursors,
        complete: descriptor.checkpoint.complete,
        ...(descriptor.checkpoint.compaction_marker_key === null
          || descriptor.checkpoint.compaction_marker_key === undefined
          ? {}
          : { compaction_marker_key: descriptor.checkpoint.compaction_marker_key }),
        full_listing_verified: descriptor.checkpoint.full_listing_verified,
      },
    }),
    ...(descriptor.compatibility_lease === null ? {} : {
      compatibility_lease: {
        holder_device_id: descriptor.compatibility_lease.holder_device_id,
        operation_id: descriptor.compatibility_lease.operation_id,
        expires_at: descriptor.compatibility_lease.expires_at,
        min_writer_version: descriptor.compatibility_lease.min_writer_version,
      },
    }),
  };
}

function descriptorEquals(left: SyncFormatDescriptor, right: SyncFormatDescriptor): boolean {
  return isDeepStrictEqual(descriptorToJson(left), descriptorToJson(right));
}

function v4Features(): string[] {
  return [
    'append_only_tombstones',
    'v4_change_shards',
    'verified_compaction_marker',
    'compatibility_lease',
  ];
}

function newCompatibilityLease(deviceId: string): SyncCompatibilityLease {
  const expires = nowEpochNanos() + BigInt(COMPATIBILITY_RELEASE_DAYS) * 86_400_000_000_000n;
  return {
    holder_device_id: deviceId,
    operation_id: globalThis.crypto.randomUUID(),
    expires_at: toRfc3339(expires),
    min_writer_version: MIN_COMPATIBLE_FORMAT_VERSION,
  };
}

function compatibilityLeaseExpired(lease: SyncCompatibilityLease): boolean {
  const parsed = parseFlexibleTimestampSqlite(lease.expires_at);
  return parsed !== null && parsed.epochNanos <= nowEpochNanos();
}

function allKnownClientsSupportV4(manifests: ReadonlyMap<string, import('./merge.ts').SyncManifest>): boolean {
  const active = [...manifests.values()].filter(manifest => manifest.superseded_by === null || manifest.superseded_by === undefined);
  return active.length > 0 && active.every(manifest => manifest.format_version >= CURRENT_FORMAT_VERSION);
}

/** `SyncManager::write_format_descriptor`（含 PUT 后回读校验）。 */
export async function writeFormatDescriptor(
  storage: CloudStorage,
  descriptor: SyncFormatDescriptor,
): Promise<void> {
  let encoded: Uint8Array;
  try {
    encoded = new TextEncoder().encode(stringifyJsonLossless(descriptorToJson(descriptor), true));
  } catch (error) {
    throw new SyncError(`Database error: 序列化远端同步格式失败: ${message(error)}`);
  }
  try {
    await storage.put(FORMAT_KEY, encoded);
  } catch (error) {
    throw new SyncError(`Network error: 写入远端同步格式失败: ${message(error)}`);
  }
  let verifiedBytes: Uint8Array | null;
  try {
    verifiedBytes = await storage.get(FORMAT_KEY);
  } catch (error) {
    throw new SyncError(`Network error: 回验远端同步格式失败: ${message(error)}`);
  }
  if (verifiedBytes === null) {
    throw new SyncError('Network error: 写入后远端 format.json 不存在');
  }
  let verified: SyncFormatDescriptor;
  try {
    verified = parseFormatDescriptor(decodeUtf8Strict(verifiedBytes));
  } catch (error) {
    throw new SyncError(`Database error: 回验远端 format.json 失败: ${message(error)}`);
  }
  if (!descriptorEquals(verified, descriptor)) {
    throw new SyncError('Network error: 写入后远端 format.json 内容不一致');
  }
}

async function prepareFormatForWrite(
  storage: CloudStorage,
  descriptor: SyncFormatDescriptor,
  deviceId: string,
  codec: PayloadCodec,
  logger?: SyncLogger | null,
): Promise<SyncFormatDescriptor> {
  let changed = false;
  if (descriptor.format_version < CURRENT_FORMAT_VERSION) {
    descriptor.format_version = CURRENT_FORMAT_VERSION;
    descriptor.min_reader_version = MIN_COMPATIBLE_FORMAT_VERSION;
    descriptor.features = v4Features();
    descriptor.checkpoint = {
      generation: 0,
      shard_cursors: {},
      complete: false,
      full_listing_verified: false,
    };
    descriptor.compatibility_lease = newCompatibilityLease(deviceId);
    changed = true;
  } else if (descriptor.min_reader_version < CURRENT_FORMAT_VERSION && descriptor.compatibility_lease === null) {
    // 旧的 v4 skeleton 没有租约，不能把“字段缺失”误当成兼容期已结束。
    descriptor.compatibility_lease = newCompatibilityLease(deviceId);
    changed = true;
  }

  if (descriptor.min_reader_version < CURRENT_FORMAT_VERSION) {
    const leaseExpired = descriptor.compatibility_lease !== null
      && compatibilityLeaseExpired(descriptor.compatibility_lease);
    const manifests = await readDeviceManifests(storage, { deviceId, codec, logger });
    const legacyDevices = [...manifests.values()]
      .filter(manifest => (manifest.superseded_by === null || manifest.superseded_by === undefined)
        && manifest.format_version < CURRENT_FORMAT_VERSION)
      .map(manifest => manifest.device_id);
    if (leaseExpired && allKnownClientsSupportV4(manifests)) {
      descriptor.min_reader_version = CURRENT_FORMAT_VERSION;
      descriptor.compatibility_lease = null;
      changed = true;
      logger?.warn('[sync] v3 双读兼容期已结束，全部已知客户端均支持 v4；后续写入自动迁移到 v4 分片根');
    } else {
      const expiresAt = descriptor.compatibility_lease?.expires_at ?? 'unknown';
      logger?.warn(
        `[sync] v3 双读兼容仍启用: lease_expires_at=${expiresAt}, lease_expired=${leaseExpired}, ` +
          `legacy_devices=${JSON.stringify(legacyDevices)}, known_manifests=${manifests.size}; ` +
          '升级或 supersede 旧设备后才会切换到 v4 分片根',
      );
    }
  }

  if (changed) {
    let freshBytes: Uint8Array | null;
    try {
      freshBytes = await storage.get(FORMAT_KEY);
    } catch (error) {
      throw new SyncError(`Network error: 写前复核远端同步格式失败: ${message(error)}`);
    }
    if (freshBytes !== null) {
      let fresh: SyncFormatDescriptor;
      try {
        fresh = parseFormatDescriptor(decodeUtf8Strict(freshBytes));
      } catch (error) {
        throw new SyncError(`Database error: 写前复核远端 format.json 失败: ${message(error)}`);
      }
      if (fresh.format_version > CURRENT_FORMAT_VERSION || fresh.min_reader_version > CURRENT_FORMAT_VERSION) {
        throw new SyncError(
          `Database error: 远端同步格式在协商期间升级到 v${fresh.format_version}（最低 client v${fresh.min_reader_version}），拒绝覆盖`,
        );
      }
    }
    await writeFormatDescriptor(storage, descriptor);
  }
  return descriptor;
}

export interface ValidateRemoteFormatOptions {
  deviceId: string;
  codec: PayloadCodec;
  logger?: SyncLogger | null;
}

/** `SyncManager::validate_remote_format`（sync/mod.rs:1779）。 */
export async function validateRemoteFormat(
  storage: CloudStorage,
  willWrite: boolean,
  options: ValidateRemoteFormatOptions,
): Promise<SyncFormatDescriptor> {
  let bytes: Uint8Array | null;
  try {
    bytes = await storage.get(FORMAT_KEY);
  } catch (error) {
    throw new SyncError(`Network error: 读取远端同步格式失败: ${message(error)}`);
  }

  if (bytes === null) {
    const legacy: SyncFormatDescriptor = {
      format_version: MIN_COMPATIBLE_FORMAT_VERSION,
      min_reader_version: MIN_COMPATIBLE_FORMAT_VERSION,
      features: [],
      checkpoint: null,
      compatibility_lease: null,
    };
    if (!willWrite) return legacy;

    const descriptor: SyncFormatDescriptor = {
      format_version: CURRENT_FORMAT_VERSION,
      min_reader_version: MIN_COMPATIBLE_FORMAT_VERSION,
      features: v4Features(),
      checkpoint: {
        generation: 0,
        shard_cursors: {},
        complete: false,
        full_listing_verified: false,
      },
      compatibility_lease: newCompatibilityLease(options.deviceId),
    };
    await writeFormatDescriptor(storage, descriptor);
    return descriptor;
  }

  let descriptor: SyncFormatDescriptor;
  try {
    descriptor = parseFormatDescriptor(decodeUtf8Strict(bytes));
  } catch (error) {
    throw new SyncError(`Database error: 远端 format.json 损坏: ${message(error)}`);
  }

  if (descriptor.format_version > CURRENT_FORMAT_VERSION || descriptor.min_reader_version > CURRENT_FORMAT_VERSION) {
    throw new SyncError(
      `Database error: 远端同步格式 v${descriptor.format_version}（最低 reader v${descriptor.min_reader_version}）高于当前客户端 v${CURRENT_FORMAT_VERSION}；为避免旧客户端破坏数据，已在写入前拒绝同步`,
    );
  }
  if (descriptor.format_version < MIN_COMPATIBLE_FORMAT_VERSION) {
    throw new SyncError(
      `Database error: 远端同步格式 v${descriptor.format_version} 过旧，当前客户端仅兼容 v${MIN_COMPATIBLE_FORMAT_VERSION}-v${CURRENT_FORMAT_VERSION}`,
    );
  }
  if (!willWrite) return descriptor;
  return prepareFormatForWrite(storage, descriptor, options.deviceId, options.codec, options.logger);
}
