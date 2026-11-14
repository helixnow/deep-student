/**
 * 云端变更文件 key 解析与序号库存（sync/mod.rs:1487-1567、3091-3301）。
 *
 * 支持三种历史格式：
 * - v4 分片：`data_governance/v4/shards/{path_id}/{seq:012}-{version}-{operation_id}.json.zst`
 * - v3：`data_governance/changes/{path_id}/{seq:012}-{version}-{nonce}.json.zst`
 * - legacy：`data_governance/changes/{path_id}/{version}[-{nonce}].json[.zst]`
 */
import type { CloudStorage } from '../../sync-providers/api.ts';
import { deviceIdShortHash } from '../../sync-providers/api.ts';
import { SyncError } from './errors.ts';
import type { SyncManifest } from './merge.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const CHANGES_PREFIX = 'data_governance/changes';
export const V4_SHARDS_PREFIX = 'data_governance/v4/shards';

export function buildChangeKeyV3(deviceId: string, seq: bigint, version: bigint): string {
  return `${CHANGES_PREFIX}/${deviceIdShortHash(deviceId)}/${seq.toString().padStart(12, '0')}-${version}-${globalThis.crypto.randomUUID()}.json.zst`;
}
export function buildChangeKeyV4(deviceId: string, seq: bigint, version: bigint): string {
  return `${V4_SHARDS_PREFIX}/${deviceIdShortHash(deviceId)}/${seq.toString().padStart(12, '0')}-${version}-${globalThis.crypto.randomUUID()}.json.zst`;
}

export type ParsedChangeKey =
  | { kind: 'v4Shard'; deviceId: string; seq: bigint; version: bigint; operationId: string }
  | { kind: 'v3'; deviceId: string; seq: bigint; version: bigint }
  | { kind: 'legacy'; deviceId: string; version: bigint };

export function pathIdMatchesDevice(pathId: string, deviceId: string): boolean {
  return pathId !== '' && (pathId === deviceId || pathId === deviceIdShortHash(deviceId));
}

function parseU64(text: string): bigint | null {
  if (!/^\+?[0-9]+$/u.test(text)) return null;
  const value = BigInt(text);
  return value <= 18_446_744_073_709_551_615n ? value : null;
}

/** `SyncManager::parse_change_key`（sync/mod.rs:3105）。 */
export function parseChangeKey(key: string): ParsedChangeKey | null {
  const parts = key.split('/');
  const isV4 = parts[0] === 'data_governance' && parts[1] === 'v4' && parts[2] === 'shards';
  let deviceId: string | undefined;
  if (isV4) {
    deviceId = parts[3];
  } else if (parts[0] === 'data_governance' && parts[1] === 'changes') {
    deviceId = parts[2];
  } else {
    return null;
  }
  if (deviceId === undefined) return null;
  const filename = parts[parts.length - 1];
  if (filename === undefined) return null;
  let stem: string;
  if (filename.endsWith('.json.zst')) stem = filename.slice(0, -'.json.zst'.length);
  else if (filename.endsWith('.json')) stem = filename.slice(0, -'.json'.length);
  else return null;

  // Rust splitn(3, '-') keeps the entire remainder (including UUID hyphens).
  const firstDash = stem.indexOf('-');
  const secondDash = firstDash < 0 ? -1 : stem.indexOf('-', firstDash + 1);
  const first = firstDash < 0 ? stem : stem.slice(0, firstDash);
  const second = firstDash < 0 ? undefined
    : stem.slice(firstDash + 1, secondDash < 0 ? undefined : secondDash);
  const operationId = secondDash < 0 ? undefined : stem.slice(secondDash + 1);

  if (first.length === 12 && /^\d{12}$/u.test(first) && second !== undefined) {
    const seq = parseU64(first);
    const version = parseU64(second);
    if (seq !== null && version !== null) {
      if (isV4) {
        const trimmed = rustTrim(operationId ?? '');
        if (trimmed === '') return null;
        return { kind: 'v4Shard', deviceId, seq, version, operationId: trimmed };
      }
      return { kind: 'v3', deviceId, seq, version };
    }
  }

  const version = parseU64(first);
  return version === null ? null : { kind: 'legacy', deviceId, version };
}

/** `SyncManager::parse_version_from_key`。 */
export function parseVersionFromKey(key: string): bigint | null {
  const parsed = parseChangeKey(key);
  return parsed === null ? null : parsed.version;
}

/** `SyncManager::normalize_version_to_seconds`（sync/mod.rs:3223）。 */
export function normalizeVersionToSeconds(version: bigint): bigint {
  const MILLIS_THRESHOLD = 100_000_000_000n;
  return version > MILLIS_THRESHOLD ? version / 1000n : version;
}

/** mod.rs:3232: missing sequences need an observed/published upper watermark. */
export function missingSequenceIsProven(expected: bigint, observed: bigint, publishedMax: bigint): boolean {
  return observed > expected && expected <= (publishedMax > observed ? publishedMax : observed);
}

async function listCompleteKeys(storage: CloudStorage, prefix: string, label: string): Promise<string[]> {
  let list;
  try {
    list = await storage.listOutcome(prefix);
  } catch (error) {
    throw new SyncError(`Network error: 列出${label}失败: ${message(error)}`);
  }
  if (list.truncated) {
    throw new SyncError(`Network error: ${label}列表被截断，拒绝推进游标或执行清理`);
  }
  return list.files.map(file => file.key);
}

/** `SyncManager::list_all_change_keys`。 */
export async function listAllChangeKeys(storage: CloudStorage): Promise<string[]> {
  const keys = await listCompleteKeys(storage, CHANGES_PREFIX, 'legacy/v3 变更文件');
  keys.push(...await listCompleteKeys(storage, V4_SHARDS_PREFIX, 'v4 变更分片'));
  keys.sort((left, right) => compareUtf8(left, right));
  return [...new Set(keys)];
}

/** mod.rs:3303: recover the uploader watermark from both old and new path forms. */
export async function maxCloudSeqForDevice(storage: CloudStorage, deviceId: string): Promise<bigint> {
  const hashed = deviceIdShortHash(deviceId);
  const ids = hashed === deviceId ? [hashed] : [hashed, deviceId];
  let maximum = 0n;
  for (const id of ids) {
    for (const prefix of [CHANGES_PREFIX, V4_SHARDS_PREFIX]) {
      const label = prefix === V4_SHARDS_PREFIX ? '本设备 v4 变更分片' : '本设备 v3 变更文件';
      for (const key of await listCompleteKeys(storage, `${prefix}/${id}`, label)) {
        const parsed = parseChangeKey(key);
        if (parsed !== null && parsed.kind !== 'legacy' && pathIdMatchesDevice(parsed.deviceId, deviceId) && parsed.seq > maximum) maximum = parsed.seq;
      }
    }
  }
  return maximum;
}

/** `SyncManager::path_device_aliases`：同一 listing 里短哈希并入明文 ID。 */
export function pathDeviceAliases(pathIds: ReadonlySet<string>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const raw of pathIds) {
    const hashed = deviceIdShortHash(raw);
    if (hashed !== raw && pathIds.has(hashed)) {
      aliases.set(hashed, raw);
      aliases.set(raw, raw);
    }
  }
  return aliases;
}

/** `SyncManager::resolve_path_device_id`。 */
export function resolvePathDeviceId(
  pathId: string,
  selfDeviceId: string,
  manifests: ReadonlyMap<string, SyncManifest>,
  aliases: ReadonlyMap<string, string>,
): string {
  if (pathIdMatchesDevice(pathId, selfDeviceId)) return selfDeviceId;
  for (const manifest of manifests.values()) {
    if (pathIdMatchesDevice(pathId, manifest.device_id)) {
      if (rustTrim(manifest.device_id) !== '') return manifest.device_id;
      break;
    }
  }
  for (const canonical of manifests.keys()) {
    if (pathIdMatchesDevice(pathId, canonical)) return canonical;
  }
  return aliases.get(pathId) ?? pathId;
}

/** `SyncManager::change_sequence_inventory`：device_id -> 已观察到的 seq。 */
export function changeSequenceInventory(
  keys: readonly string[],
  manifests: ReadonlyMap<string, SyncManifest>,
  selfDeviceId: string,
): Map<string, bigint[]> {
  const pathIds = new Set<string>();
  for (const key of keys) {
    const parsed = parseChangeKey(key);
    if (parsed !== null && parsed.kind !== 'legacy') pathIds.add(parsed.deviceId);
  }
  const aliases = pathDeviceAliases(pathIds);
  const sequences = new Map<string, bigint[]>();
  for (const key of keys) {
    const parsed = parseChangeKey(key);
    if (parsed === null || parsed.kind === 'legacy') continue;
    if (pathIdMatchesDevice(parsed.deviceId, selfDeviceId)) continue;
    const canonical = resolvePathDeviceId(parsed.deviceId, selfDeviceId, manifests, aliases);
    const bucket = sequences.get(canonical);
    if (bucket === undefined) sequences.set(canonical, [parsed.seq]);
    else bucket.push(parsed.seq);
  }
  return sequences;
}

export interface ChangeLogGap {
  device_id: string;
  expected_seq: bigint;
  next_available_seq: bigint | null;
  published_max_seq: bigint;
}

export function changeLogGapDiagnostic(gap: ChangeLogGap): string {
  return `设备 ${gap.device_id} 缺少序号 ${gap.expected_seq}（下一可用序号 ${gap.next_available_seq ?? '无'}，已发布到 ${gap.published_max_seq}）；已停止同步，请从数据完整的备份恢复。不会跳过缺失分片或清空本地消息。`;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

/** `SyncManager::sequence_gaps`（sync/mod.rs:1518）。 */
export function sequenceGaps(
  sequences: Map<string, bigint[]>,
  manifests: ReadonlyMap<string, SyncManifest>,
  cursors: ReadonlyMap<string, bigint>,
  selfDeviceId: string,
): ChangeLogGap[] {
  for (const [device, manifest] of manifests) {
    if (BigInt(manifest.published_max_seq) > 0n && !pathIdMatchesDevice(device, selfDeviceId)) {
      if (!sequences.has(device)) sequences.set(device, []);
    }
  }

  const gaps: ChangeLogGap[] = [];
  for (const [device, rawSeqs] of sequences) {
    const seqs = [...new Set(rawSeqs)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const cursor = maxBigInt(
      cursors.get(device) ?? 0n,
      cursors.get(deviceIdShortHash(device)) ?? 0n,
    );
    const last = seqs.length === 0 ? 0n : seqs[seqs.length - 1]!;
    const manifest = manifests.get(device);
    const published = maxBigInt(manifest === undefined ? 0n : BigInt(manifest.published_max_seq), last);

    const u64Max = 18_446_744_073_709_551_615n;
    let expected = cursor === u64Max ? cursor : cursor + 1n;
    let nextAvailable: bigint | null = null;
    for (const seq of seqs) {
      if (seq <= cursor) continue;
      if (seq > expected) {
        nextAvailable = seq;
        break;
      }
      expected = seq === u64Max ? seq : seq + 1n;
    }
    if (expected <= published && cursor < published) {
      gaps.push({
        device_id: device,
        expected_seq: expected,
        next_available_seq: nextAvailable,
        published_max_seq: published,
      });
    }
  }

  gaps.sort((left, right) => compareUtf8(left.device_id, right.device_id));
  return gaps;
}
