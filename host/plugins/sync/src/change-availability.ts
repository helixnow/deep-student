/** `SyncManager::detect_change_log_gaps` (mod.rs:1572): remote read-only preflight. */
import type { CloudStorage } from '../../sync-providers/api.ts';
import { rustTrim, decodeUtf8Strict } from '../../../platform/util/index.ts';
import { isJsonObject, parseJsonLossless } from '../../../platform/util/lossless-json.ts';
import { SyncError } from './errors.ts';
import { validateRemoteFormat, type ValidateRemoteFormatOptions } from './remote-format.ts';
import { readDeviceManifests } from './remote-manifest.ts';
import {
  changeSequenceInventory, listAllChangeKeys, normalizeVersionToSeconds,
  parseVersionFromKey, sequenceGaps, type ChangeLogGap,
} from './change-keys.ts';

export const INSTANCE_KEY = 'data_governance/instance.json';

/** L20b owns persistence; the engine only binds the instance and reads cursors. */
export interface SyncCursorStore {
  bindInstance(instanceId: string, provider: string, endpointHint: string): void;
  cursors(instanceId: string): ReadonlyMap<string, bigint>;
}

export interface ChangeLogAvailability {
  remote_format_version: number;
  instance_id: string | null;
  min_available_version: bigint | null;
  gaps: ChangeLogGap[];
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function detectChangeLogGaps(
  storage: CloudStorage,
  options: ValidateRemoteFormatOptions,
  openState: () => SyncCursorStore,
): Promise<ChangeLogAvailability> {
  const format = await validateRemoteFormat(storage, false, options);
  let bytes: Uint8Array | null;
  try {
    bytes = await storage.get(INSTANCE_KEY);
  } catch (error) {
    throw new SyncError(`Network error: 读取远端实例标识失败: ${message(error)}`);
  }
  let instanceId: string | null = null;
  if (bytes !== null) {
    let value;
    try {
      value = parseJsonLossless(decodeUtf8Strict(bytes));
    } catch (error) {
      throw new SyncError(`Database error: 远端实例标识损坏: ${message(error)}`);
    }
    const id = isJsonObject(value) ? value.instance_id : undefined;
    if (typeof id !== 'string' || rustTrim(id) === '') {
      throw new SyncError('Database error: 远端实例标识缺少 instance_id');
    }
    instanceId = rustTrim(id);
  }
  let cursors: ReadonlyMap<string, bigint> = new Map();
  if (instanceId !== null) {
    const store = openState();
    store.bindInstance(instanceId, storage.providerName(), storage.instanceBindingHint());
    cursors = store.cursors(instanceId);
  }
  // Read publication watermarks BEFORE listing immutable shards, as in Rust.
  const manifests = await readDeviceManifests(storage, options);
  const keys = await listAllChangeKeys(storage);
  const sequences = changeSequenceInventory(keys, manifests, options.deviceId);
  const gaps = sequenceGaps(sequences, manifests, cursors, options.deviceId);
  let minVersion: bigint | null = null;
  for (const key of keys) {
    const raw = parseVersionFromKey(key);
    if (raw === null) continue;
    const version = normalizeVersionToSeconds(raw);
    if (minVersion === null || version < minVersion) minVersion = version;
  }
  options.logger?.info(
    `[sync] 序号断层检测: instance=${instanceId}, format=${format.format_version}, ` +
    `cursors=${[...cursors].map(([device, seq]) => `${device}:${seq}`).join(',')}, ` +
    `min_available=${minVersion}, gaps=${gaps.map(gap => `${gap.device_id}:${gap.expected_seq}`).join(',')}`,
  );
  return {
    remote_format_version: format.format_version,
    instance_id: instanceId,
    min_available_version: minVersion,
    gaps,
  };
}
