/** mod.rs:1838-2103: schema gate, instance binding and verified device publication. */
import type { CloudStorage } from '../../sync-providers/api.ts';
import { retryRemote } from './remote-retry.ts';
import type { SyncStateStore } from '../../sync-support/api.ts';
import { rustTrim, decodeUtf8Strict } from '../../../platform/util/index.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { SyncError } from './errors.ts';
import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import type { SyncManifest, ConflictDetectionResult } from './merge.ts';
import { validateRemoteFormat, type ValidateRemoteFormatOptions } from './remote-format.ts';
import { readDeviceManifests, deviceManifestKey, deviceManifestLegacyKey, parseSyncManifest } from './remote-manifest.ts';
import { INSTANCE_KEY } from './change-availability.ts';
import { compareUtf8, encodeUtf8 } from '../../../platform/util/portable.ts';
import { timingSafeEqual } from '../../../platform/crypto/encoding.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
export interface SchemaVersionMismatch { database_name: string; local: number; cloud: number }

export class SchemaMismatchError extends SyncError {
  readonly mismatches: SchemaVersionMismatch[];
  constructor(mismatches: SchemaVersionMismatch[]) {
    super('Schema mismatch: ' + mismatches.map(item => {
      const action = item.local < item.cloud
        ? '本端数据库版本过旧，请升级当前客户端后再同步；已阻止上传以避免降级云端数据'
        : '云端数据库版本过旧，请升级其他设备并完成同步后重试';
      return `${item.database_name} (local=${item.local}, cloud=${item.cloud})：${action}`;
    }).join('；'));
    this.mismatches = mismatches;
  }
}

/** mod.rs:1181: only actual schema mismatches, in stable database order. */
export function schemaMismatchError(detection: ConflictDetectionResult): SchemaMismatchError | null {
  const mismatches: SchemaVersionMismatch[] = [];
  for (const conflict of detection.database_conflicts) {
    if (conflict.conflict_type !== 'SchemaMismatch' || conflict.local_state === null || conflict.cloud_state === null) continue;
    if (conflict.local_state.schema_version !== conflict.cloud_state.schema_version) mismatches.push({
      database_name: conflict.database_name, local: conflict.local_state.schema_version, cloud: conflict.cloud_state.schema_version,
    });
  }
  mismatches.sort((a, b) => compareUtf8(a.database_name, b.database_name));
  return mismatches.length === 0 ? null : new SchemaMismatchError(mismatches);
}

/** mod.rs:1908: inspect every alias before deduplication; reject schema downgrade. */
export async function validateUploadSchemaCompatibility(
  storage: CloudStorage, local: SyncManifest, options: ValidateRemoteFormatOptions,
): Promise<void> {
  const manifests = await readDeviceManifests(storage, { ...options, preserveAliases: true });
  const mismatches: SchemaVersionMismatch[] = [];
  for (const manifest of manifests.values()) {
    if (manifest.superseded_by != null) continue;
    for (const [name, state] of Object.entries(manifest.databases)) {
      const version = Object.hasOwn(local.databases, name) ? local.databases[name]!.schema_version : 0;
      if (state.schema_version > version) mismatches.push({ database_name: name, local: version, cloud: state.schema_version });
    }
  }
  mismatches.sort((a, b) => compareUtf8(a.database_name, b.database_name) || a.cloud - b.cloud);
  const distinct = mismatches.filter((item, index) => {
    const previous = mismatches[index - 1];
    return !previous || previous.database_name !== item.database_name || previous.local !== item.local || previous.cloud !== item.cloud;
  });
  if (distinct.length > 0) throw new SchemaMismatchError(distinct);
}

export async function putAndReread(storage: CloudStorage, key: string, payload: Uint8Array, context: string): Promise<void> {
  try { await storage.put(key, payload); }
  catch (error) { throw new SyncError(`Network error: ${context} 上传失败: ${message(error)}`); }
  let bytes;
  try { bytes = await storage.get(key); }
  catch (error) { throw new SyncError(`Network error: ${context} 上传后回读失败: ${message(error)}`); }
  if (bytes === null) throw new SyncError(`Network error: ${context} 上传后对象不存在，已停止并不得报成功`);
  if (!timingSafeEqual(bytes, payload)) {
    throw new SyncError(`Network error: ${context} 上传后回读不一致，已停止并不得报成功`);
  }
}

export async function ensureRemoteInstanceId(
  storage: CloudStorage, options: ValidateRemoteFormatOptions, openState: () => SyncStateStore,
): Promise<string> {
  await validateRemoteFormat(storage, true, options);
  let bytes;
  try { bytes = await storage.get(INSTANCE_KEY); }
  catch (error) { throw new SyncError(`Network error: 读取远端实例标识失败: ${message(error)}`); }
  let instanceId: string | null = null;
  if (bytes !== null) {
    let value: DbJson | null = null;
    try { value = parseJsonLossless(decodeUtf8Strict(bytes)); }
    catch { // boundary-allow empty-catch: mod.rs:1848 uses if let Ok(value), then replaces invalid instance metadata.
    }
    if (isJsonObject(value) && typeof value.instance_id === 'string' && rustTrim(value.instance_id) !== '') {
      instanceId = rustTrim(value.instance_id);
    }
  }
  if (instanceId === null) {
    instanceId = globalThis.crypto.randomUUID();
    const body = { instance_id: instanceId, format_version: 4, created_at: toRfc3339() };
    const payload = encodeUtf8(stringifyJsonLossless(body, true));
    await putAndReread(storage, INSTANCE_KEY, payload, '远端实例标识');
  }
  openState().bindInstance(instanceId, storage.providerName(), storage.instanceBindingHint());
  return instanceId;
}

async function deleteLegacy(storage: CloudStorage, deviceId: string, options: ValidateRemoteFormatOptions): Promise<void> {
  const key = deviceManifestLegacyKey(deviceId);
  if (deviceManifestKey(deviceId) === key) return;
  let info;
  try { info = await storage.stat(key); }
  catch (error) {
    options.logger?.warn(`[sync] 迁移设备清单时探测旧对象 ${key} 失败: ${message(error)}`);
    return;
  }
  if (info === null) return;
  try { await storage.delete(key); }
  catch (error) { options.logger?.warn(`[sync] 迁移设备清单后删除旧对象 ${key} 失败（新清单已发布）: ${message(error)}`); }
}

function encodeManifest(manifest: SyncManifest, context: string): Uint8Array {
  const { superseded_by, ...rest } = manifest;
  try {
    return encodeUtf8(stringifyJsonLossless({ ...rest,
      ...(superseded_by == null ? {} : { superseded_by }),
    } as unknown as DbJson, true));
  } catch (error) { throw new SyncError(`Database error: ${context}: ${message(error)}`); }
}

async function markSuperseded(storage: CloudStorage, oldId: string, options: ValidateRemoteFormatOptions): Promise<void> {
  if (rustTrim(oldId) === '' || oldId === options.deviceId) return;
  await validateRemoteFormat(storage, true, options);
  const hashed = deviceManifestKey(oldId);
  const legacy = deviceManifestLegacyKey(oldId);
  let bytes;
  try {
    bytes = await storage.get(hashed);
    if (bytes === null && legacy !== hashed) bytes = await storage.get(legacy);
  } catch (error) { throw new SyncError(`Network error: 读取旧设备清单失败: ${message(error)}`); }
  let manifest: SyncManifest;
  if (bytes !== null) {
    const decoded = await options.codec.decode(bytes);
    try { manifest = parseSyncManifest(decodeUtf8Strict(decoded)); }
    catch (error) { throw new SyncError(`Database error: 解析旧设备清单失败: ${message(error)}`); }
  } else {
    manifest = { sync_transaction_id: globalThis.crypto.randomUUID(), databases: {}, status: 'Complete', created_at: toRfc3339(),
      device_id: oldId, format_version: 3, published_max_seq: 0, cursors: {}, snapshot_seen: {}, superseded_by: null };
  }
  if (manifest.superseded_by === options.deviceId) return;
  manifest.format_version = 4;
  manifest.device_id = oldId;
  manifest.superseded_by = options.deviceId;
  const payload = await options.codec.encode(encodeManifest(manifest, '序列化旧设备清单失败'));
  await putAndReread(storage, hashed, payload, '旧设备 superseded_by 清单');
  await deleteLegacy(storage, oldId, options);
}

/** mod.rs:1944: exactly two outer attempts; rate limits return immediately. */
export async function uploadManifest(
  storage: CloudStorage, input: SyncManifest, options: ValidateRemoteFormatOptions, openState: () => SyncStateStore,
): Promise<void> {
  const manifest = { ...input, cursors: { ...input.cursors } };
  await validateUploadSchemaCompatibility(storage, manifest, options);
  const instanceId = await ensureRemoteInstanceId(storage, options, openState);
  manifest.format_version = 4;
  manifest.device_id = options.deviceId;
  let state: SyncStateStore | null = null;
  try { state = openState(); }
  catch { // boundary-allow empty-catch: mod.rs:1957 optional state enrichment uses if let Ok(store).
  }
  if (state !== null) {
    let rotations: [string, string][] = [];
    try { rotations = state.deviceRotationsForNew(options.deviceId); }
    catch { // boundary-allow empty-catch: mod.rs:1958 uses if let Ok(rotations) without warning.
    }
    for (const [oldId, reason] of rotations) {
      try { await markSuperseded(storage, oldId, options); }
      catch (error) {
        options.logger?.warn(`[sync] 写入旧设备 superseded_by 失败: old=${oldId}, new=${options.deviceId}, reason=${reason}, err=${message(error)}`);
      }
    }
    try { manifest.published_max_seq = state.publishedMaxSeq(instanceId, options.deviceId); }
    catch { manifest.published_max_seq = 0; }
    try { manifest.cursors = Object.fromEntries(state.cursors(instanceId)); }
    catch { manifest.cursors = {}; }
  }
  const payload = await options.codec.encode(encodeManifest(manifest, '序列化清单失败'));
  const key = deviceManifestKey(options.deviceId);
  await retryRemote('上传清单', 2, () => putAndReread(storage, key, payload, '记录级设备清单'), options.logger);
  await deleteLegacy(storage, options.deviceId, options);
  options.logger?.info(`[sync] 清单已上传到云端: device=${manifest.device_id}, tx=${manifest.sync_transaction_id}, databases=${Object.keys(manifest.databases).length}, key=${key}, encrypted=${options.codec.encrypted}`);
}
