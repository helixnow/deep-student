/** mod.rs:2725-3075. Returns acknowledgement candidates, never persists cursors. */
import type { CloudStorage } from '../../sync-providers/api.ts';
import { deviceIdShortHash } from '../../sync-providers/api.ts';
import type { SyncStateStore } from '../../sync-support/api.ts';
import type { NativeCompression } from '../../../platform/native/api.ts';
import { decodeUtf8Strict } from '../../../platform/util/index.ts';
import { parseFlexibleTimestampSqlite } from '../../../platform/time/index.ts';
import { parseJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import type { EngineChange } from './change-payload.ts';
import { parseChangesPayload, parseLegacyPendingChanges } from './download-payload.ts';
import { dedupeDownloadedChanges } from '../repository/record-data.ts';
import { ensureRemoteInstanceId } from './manifest-upload.ts';
import { readDeviceManifests } from './remote-manifest.ts';
import type { ValidateRemoteFormatOptions } from './remote-format.ts';
import { SyncError } from './errors.ts';
import {
  parseChangeKey, listAllChangeKeys, sequenceGaps, changeSequenceInventory,
  changeLogGapDiagnostic, normalizeVersionToSeconds, pathDeviceAliases, resolvePathDeviceId, pathIdMatchesDevice,
  missingSequenceIsProven,
} from './change-keys.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

export interface DownloadChangesResult {
  changes: EngineChange[];
  decode_failures: string[];
  cursor_advancements: Map<string, bigint>;
  legacy_processed_keys: string[];
}
type OrderedChange = { device: string; seq: bigint; version: bigint; change: EngineChange };

/** mod.rs:3819-3832: called only after the caller has durably applied the batch. */
export async function commitDownloadProgress(
  storage: CloudStorage, downloaded: DownloadChangesResult, options: ValidateRemoteFormatOptions, openState: () => SyncStateStore,
): Promise<void> {
  const instance = await ensureRemoteInstanceId(storage, options, openState);
  const state = openState();
  for (const [device, seq] of downloaded.cursor_advancements) state.setCursor(instance, device, seq);
  for (const key of downloaded.legacy_processed_keys) state.markLegacyProcessed(instance, key);
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const strCmp = (a: string, b: string): number => compareUtf8(a, b);
const intCmp = (a: bigint, b: bigint): number => a < b ? -1 : a > b ? 1 : 0;
const max = (a: bigint, b: bigint): bigint => a > b ? a : b;
const increment = (value: bigint): bigint => value === 18446744073709551615n ? value : value + 1n;

async function decodedValue(data: Uint8Array, compression: NativeCompression): Promise<DbJson> {
  let bytes = data;
  try { bytes = await compression.zstdDecode(data); }
  catch { // boundary-allow empty-catch: mod.rs:2885/2973 decode_all(...).unwrap_or(decrypted), for legacy plain JSON.
  }
  return parseJsonLossless(decodeUtf8Strict(bytes));
}

function compareChanges(a: OrderedChange, b: OrderedChange): number {
  let order = strCmp(a.device, b.device) || intCmp(a.seq, b.seq) || intCmp(a.version, b.version);
  if (order !== 0) return order;
  const ta = parseFlexibleTimestampSqlite(a.change.changed_at); const tb = parseFlexibleTimestampSqlite(b.change.changed_at);
  order = ta !== null && tb !== null ? intCmp(ta.epochNanos, tb.epochNanos)
    : ta !== null ? -1 : tb !== null ? 1 : strCmp(a.change.changed_at, b.change.changed_at);
  const ad = a.change.database_name; const bd = b.change.database_name;
  const dbOrder = ad == null ? bd == null ? 0 : -1 : bd == null ? 1 : strCmp(ad, bd);
  const ai = a.change.change_log_id; const bi = b.change.change_log_id;
  const idOrder = ai == null ? bi == null ? 0 : -1 : bi == null ? 1 : intCmp(BigInt(ai), BigInt(bi));
  return order || dbOrder || strCmp(a.change.table_name, b.change.table_name) || idOrder
    || strCmp(a.change.record_id, b.change.record_id) || strCmp(a.change.operation.toUpperCase(), b.change.operation.toUpperCase());
}

export async function downloadChanges(
  storage: CloudStorage, sinceVersion: bigint, perDbSince: ReadonlyMap<string, bigint> | null,
  options: ValidateRemoteFormatOptions, openState: () => SyncStateStore, compression: NativeCompression,
): Promise<DownloadChangesResult> {
  const instanceId = await ensureRemoteInstanceId(storage, options, openState);
  const store = openState();
  let manifests;
  try { manifests = await readDeviceManifests(storage, options); }
  catch (error) { throw new SyncError(`Network error: 下载设备 manifest 失败: ${message(error)}`); }
  const keys = await listAllChangeKeys(storage);
  const gaps = sequenceGaps(changeSequenceInventory(keys, manifests, options.deviceId), manifests, store.cursors(instanceId), options.deviceId);
  if (gaps.length > 0) throw new SyncError(`Network error: ${gaps.map(changeLogGapDiagnostic).join('；')}`);
  const pathIds = new Set(keys.map(parseChangeKey).filter(item => item !== null).map(item => item.deviceId));
  const aliases = pathDeviceAliases(pathIds);
  const groups = new Map<string, { seq: bigint; version: bigint; key: string }[]>();
  const legacy: { device: string; version: bigint; key: string }[] = [];
  for (const key of keys) {
    const parsed = parseChangeKey(key);
    if (parsed === null || pathIdMatchesDevice(parsed.deviceId, options.deviceId)) continue;
    const device = resolvePathDeviceId(parsed.deviceId, options.deviceId, manifests, aliases);
    const version = normalizeVersionToSeconds(parsed.version);
    if (parsed.kind === 'legacy') legacy.push({ device, version, key });
    else {
      const group = groups.get(device) ?? [];
      group.push({ seq: parsed.seq, version, key }); groups.set(device, group);
    }
  }
  const all: OrderedChange[] = [];
  const advancements = new Map<string, bigint>();
  const processed: string[] = [];
  for (const [uploader, files] of groups) {
    files.sort((a, b) => intCmp(a.seq, b.seq) || intCmp(a.version, b.version) || strCmp(a.key, b.key));
    for (let i = 1; i < files.length; i += 1) {
      if (files[i - 1]!.seq === files[i]!.seq) throw new SyncError(
        `Network error: 设备 ${uploader} 的不可变变更分片序号 ${files[i]!.seq} 对应多个对象（${files[i - 1]!.key} / ${files[i]!.key}），拒绝选择性覆盖`,
      );
    }
    let expected = increment(max(store.getCursor(instanceId, uploader), store.getCursor(instanceId, deviceIdShortHash(uploader))));
    const manifest = manifests.get(uploader) ?? [...manifests.values()].find(m => pathIdMatchesDevice(uploader, m.device_id));
    const published = max(BigInt(manifest?.published_max_seq ?? 0), files.at(-1)?.seq ?? 0n);
    for (const file of files) {
      const { seq, version, key } = file;
      if (seq < expected) continue;
      if (seq > expected) {
        if (missingSequenceIsProven(expected, seq, published)) throw new SyncError(`Network error: 云端文件缺失/无法解密，已停在安全点：设备 ${uploader} 缺少序号 ${expected}（已发布到 ${published}）`);
        break;
      }
      let data;
      try { data = await storage.get(key); }
      catch (error) { throw new SyncError(`Network error: 下载变更文件失败: ${message(error)}`); }
      if (data === null) throw new SyncError(`Network error: 云端文件缺失/无法解密，已停在安全点：${key}`);
      let payload;
      try { payload = parseChangesPayload(await decodedValue(await options.codec.decode(data), compression)); }
      catch (error) { throw new SyncError(`Network error: 云端文件缺失/无法解密，已停在安全点：${key} (${message(error)})`); }
      const path = parseChangeKey(key)!;
      if (payload.source_seq !== 0n && payload.source_seq !== seq) throw new SyncError(`Network error: 变更分片路径 seq 与 payload 不一致: ${key}`);
      if (payload.source_device_id !== '' && payload.source_device_id !== uploader && !pathIdMatchesDevice(path.deviceId, payload.source_device_id)) {
        throw new SyncError(`Network error: 变更分片路径 device 与 payload 不一致: ${key}`);
      }
      if (path.kind === 'v4Shard' && (payload.format_version !== 4n || payload.operation_id !== path.operationId)) {
        throw new SyncError(`Network error: v4 变更分片 operation_id/format 与路径不一致: ${key}`);
      }
      const source = payload.source_device_id === '' ? uploader : payload.source_device_id;
      const sourceSeq = payload.source_seq === 0n ? seq : payload.source_seq;
      for (const change of payload.changes) all.push({ device: source, seq: sourceSeq, version,
        change: { ...change, source_device_id: source, source_seq: sourceSeq } });
      for (const id of [uploader, deviceIdShortHash(uploader), ...(source === '' ? [] : [source, deviceIdShortHash(source)])]) advancements.set(id, seq);
      expected = increment(expected);
    }
  }
  legacy.sort((a, b) => strCmp(a.device, b.device) || intCmp(a.version, b.version) || strCmp(a.key, b.key));
  for (const { device, version, key } of legacy) {
    if (version < normalizeVersionToSeconds(sinceVersion) || store.isLegacyProcessed(instanceId, key)) continue;
    let data;
    try { data = await storage.get(key); }
    catch (error) { throw new SyncError(`Network error: 下载 legacy 变更文件失败: ${message(error)}`); }
    if (data === null) continue;
    let decrypted;
    try { decrypted = await options.codec.decode(data); }
    catch (error) { throw new SyncError(`Network error: legacy 云端变更无法解密，已停在安全点：${key} (${message(error)})`); }
    let value;
    try { value = await decodedValue(decrypted, compression); }
    catch { throw new SyncError(`Network error: legacy 云端变更无法解析，已停在安全点：${key}`); }
    let payload = null;
    try { payload = parseChangesPayload(value); }
    catch { // boundary-allow empty-catch: mod.rs:2975 falls through to PendingChanges on enriched-payload parse failure.
    }
    if (payload !== null) {
      const source = payload.source_device_id === '' ? device : payload.source_device_id;
      const seq = payload.source_seq === 0n ? version : payload.source_seq;
      for (const change of payload.changes) {
        const threshold = change.database_name == null ? undefined : perDbSince?.get(change.database_name);
        if (threshold !== undefined && version < normalizeVersionToSeconds(threshold)) continue;
        all.push({ device: 'legacy', seq: 0n, version, change: { ...change, source_device_id: source, source_seq: seq } });
      }
    } else {
      let changes;
      try { changes = parseLegacyPendingChanges(value); }
      catch { throw new SyncError(`Network error: legacy 云端变更无法解析，已停在安全点：${key}`); }
      for (const change of changes) all.push({ device: 'legacy', seq: 0n, version,
        change: { ...change, source_device_id: device, source_seq: version } });
    }
    processed.push(key);
  }
  all.sort(compareChanges);
  const changes = dedupeDownloadedChanges(all.map(item => item.change));
  options.logger?.info(`[sync] 从云端下载变更: since=${sinceVersion}, total=${changes.length}, deduped=${all.length - changes.length}, v3_devices=${advancements.size}, legacy=${processed.length}`);
  return { changes, decode_failures: [], cursor_advancements: advancements, legacy_processed_keys: processed };
}
