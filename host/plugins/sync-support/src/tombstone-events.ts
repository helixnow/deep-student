/** tombstone.rs：不可变事件发布、回读校验、下载与连续消费水位。 */

import { sha256Hex, utf8Encode } from './portable.ts';

import { decodeUtf8Strict } from '../../../platform/util/portable.ts';

import type { PayloadCodec, TombstoneEvent, TombstoneStorage, TombstoneWatermarkAdvance, TombstoneWatermarkLookup } from '../api.ts';

import { databaseError, networkError } from './errors.ts';
import { parseJsonLossless } from '../../../platform/util/lossless-json.ts';

import {
  TOMBSTONE_EVENTS_PREFIX,
  TOMBSTONE_EVENT_FORMAT_VERSION,
  errorMessage,
  eventDeviceLegacyPrefix,
  eventDevicePrefix,
  eventKey,
  eventKeyMatches,
  eventOperationFromKey,
  eventOperationId,
  eventPayloadHash,
  eventSeqFromKey,
  normalizeSize,
  parseTombstoneEvent,
  tombstoneDeletedAtUsable,
} from './tombstone-model.ts';

import type {
  TombstoneLogger,
} from './tombstone-model.ts';

async function remoteInstanceId(storage: TombstoneStorage): Promise<string> {
  const hint = storage.instance_binding_hint();
  return `tombstone:${sha256Hex(hint).slice(0, 32)}`;
}

async function listEventKeys(storage: TombstoneStorage, prefix: string): Promise<string[]> {
  let outcome;
  try {
    outcome = await storage.list_outcome(prefix);
  } catch (error) {
    return networkError(`列举不可变 tombstone 事件失败: ${errorMessage(error)}`);
  }
  if (outcome.truncated) networkError('不可变 tombstone 事件列表被截断，拒绝推进水位');
  return outcome.files.map(file => file.key).filter(key => key.endsWith('.json'));
}

function eventEquals(left: TombstoneEvent, right: TombstoneEvent): boolean {
  return left.format_version === right.format_version
    && left.device_id === right.device_id
    && left.seq === right.seq
    && left.operation_id === right.operation_id
    && left.kind === right.kind
    && left.object_id === right.object_id
    && left.deleted_at === right.deleted_at
    && normalizeSize(left.size) === normalizeSize(right.size)
    && (left.relative_path ?? null) === (right.relative_path ?? null)
    && left.payload_hash === right.payload_hash;
}

function serializeEvent(event: TombstoneEvent): string {
  const fields: string[] = [
    `"format_version":${event.format_version}`,
    `"device_id":${JSON.stringify(event.device_id)}`,
    `"seq":${event.seq.toString()}`,
    `"operation_id":${JSON.stringify(event.operation_id)}`,
    `"kind":${JSON.stringify(event.kind)}`,
    `"object_id":${JSON.stringify(event.object_id)}`,
    `"deleted_at":${JSON.stringify(event.deleted_at)}`,
  ];
  if (event.size !== null && event.size !== undefined) fields.push(`"size":${event.size.toString()}`);
  if (event.relative_path !== null && event.relative_path !== undefined) {
    fields.push(`"relative_path":${JSON.stringify(event.relative_path)}`);
  }
  fields.push(`"payload_hash":${JSON.stringify(event.payload_hash)}`);
  return `{${fields.join(',')}}`;
}

async function putEventVerified(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  event: TombstoneEvent,
): Promise<void> {
  const key = eventKey(event);
  const verify = async (bytes: Uint8Array): Promise<boolean> => {
    const decoded = await codec.decode(bytes);
    let existing: TombstoneEvent;
    try {
      existing = parseTombstoneEvent(parseJsonLossless(decodeUtf8Strict(decoded)));
    } catch {
      return false;
    }
    return existing.payload_hash !== ''
      && eventPayloadHash(existing) === existing.payload_hash
      && eventEquals(existing, event);
  };
  let existingBytes: Uint8Array | null;
  try {
    existingBytes = await storage.get(key);
  } catch (error) {
    return networkError(`回读不可变 tombstone 事件失败: ${errorMessage(error)}`);
  }
  if (existingBytes !== null) {
    if (await verify(existingBytes)) return;
    networkError(`不可变 tombstone 事件 key 冲突且内容不同: ${key}`);
  }

  const json = utf8Encode(serializeEvent(event));
  const payload = await codec.encode(new Uint8Array(json));
  try {
    await storage.put(key, payload);
  } catch (error) {
    return networkError(`上传不可变 tombstone 事件失败: ${errorMessage(error)}`);
  }
  let written: Uint8Array | null;
  try {
    written = await storage.get(key);
  } catch (error) {
    return networkError(`上传后回验 tombstone 事件失败: ${errorMessage(error)}`);
  }
  if (written === null) networkError(`上传后 tombstone 事件不存在: ${key}`);
  if (!await verify(written)) networkError(`上传后 tombstone 事件内容回验失败: ${key}`);
}

export interface PublishEventInput {
  objectId: string;
  deletedAt: string;
  size: bigint | number | null;
  relativePath: string | null;
}

export async function publishEvents(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  state: { reserveTombstoneEventSeqWithExisting: (
    instanceId: string, deviceId: string, kind: string, operationId: string,
    cloudMaxSeq: bigint, cloudExistingSeq: bigint | null,
  ) => bigint },
  deviceId: string,
  kind: string,
  entries: readonly PublishEventInput[],
): Promise<void> {
  const instanceId = await remoteInstanceId(storage);
  const hashedPrefix = eventDevicePrefix(kind, deviceId);
  const cloudKeys = await listEventKeys(storage, hashedPrefix);
  const legacyPrefix = eventDeviceLegacyPrefix(kind, deviceId);
  if (legacyPrefix !== hashedPrefix) cloudKeys.push(...await listEventKeys(storage, legacyPrefix));

  let cloudMax = 0n;
  for (const key of cloudKeys) {
    const seq = eventSeqFromKey(key);
    if (seq !== null && seq > cloudMax) cloudMax = seq;
  }
  const operationSeqs = new Map<string, bigint>();
  for (const key of cloudKeys) {
    const seq = eventSeqFromKey(key);
    const operationId = eventOperationFromKey(key);
    if (seq === null || operationId === null) continue;
    const previous = operationSeqs.get(operationId);
    if (previous !== undefined && previous !== seq) {
      networkError(`同一 tombstone operation_id 对应多个序号: ${operationId}`);
    }
    operationSeqs.set(operationId, seq);
  }

  for (const entry of entries) {
    const operationId = eventOperationId(kind, deviceId, entry.objectId, entry.deletedAt);
    const cloudExistingSeq = operationSeqs.get(operationId) ?? null;
    const seq = state.reserveTombstoneEventSeqWithExisting(
      instanceId, deviceId, kind, operationId, cloudMax, cloudExistingSeq,
    );
    const event: TombstoneEvent = {
      format_version: TOMBSTONE_EVENT_FORMAT_VERSION,
      device_id: deviceId,
      seq,
      operation_id: operationId,
      kind,
      object_id: entry.objectId,
      deleted_at: entry.deletedAt,
      size: entry.size,
      relative_path: entry.relativePath,
      payload_hash: '',
    };
    event.payload_hash = eventPayloadHash(event);
    await putEventVerified(storage, codec, event);
    if (seq > cloudMax) cloudMax = seq;
    operationSeqs.set(operationId, seq);
  }
}

export async function downloadEvents(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  kind: string,
): Promise<TombstoneEvent[]> {
  const prefix = `${TOMBSTONE_EVENTS_PREFIX}/${kind}/`;
  const events: TombstoneEvent[] = [];
  for (const key of await listEventKeys(storage, prefix)) {
    let bytes: Uint8Array | null;
    try {
      bytes = await storage.get(key);
    } catch (error) {
      return networkError(`读取 tombstone 事件失败 ${key}: ${errorMessage(error)}`);
    }
    if (bytes === null) networkError(`已列举的 tombstone 事件消失: ${key}`);
    const decoded = await codec.decode(bytes);
    let event: TombstoneEvent;
    try {
      event = parseTombstoneEvent(parseJsonLossless(decodeUtf8Strict(decoded)));
    } catch (error) {
      return databaseError(`解析 tombstone 事件失败 ${key}: ${errorMessage(error)}`);
    }
    const expectedOperationId = eventOperationId(event.kind, event.device_id, event.object_id, event.deleted_at);
    if (event.format_version !== TOMBSTONE_EVENT_FORMAT_VERSION
      || event.kind !== kind
      || event.operation_id !== expectedOperationId
      || !eventKeyMatches(event, key)
      || event.payload_hash === ''
      || eventPayloadHash(event) !== event.payload_hash) {
      databaseError(`tombstone 事件路径与内容不一致: ${key}`);
    }
    events.push(event);
  }
  events.sort((left, right) => {
    if (left.device_id !== right.device_id) return left.device_id < right.device_id ? -1 : 1;
    if (left.seq !== right.seq) return left.seq < right.seq ? -1 : 1;
    if (left.operation_id !== right.operation_id) return left.operation_id < right.operation_id ? -1 : 1;
    return 0;
  });
  return events;
}

export async function downloadEventsAfter(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  kind: string,
  watermarkFor: TombstoneWatermarkLookup,
  logger: TombstoneLogger,
): Promise<[TombstoneEvent[], TombstoneWatermarkAdvance[]]> {
  const grouped = new Map<string, TombstoneEvent[]>();
  for (const event of await downloadEvents(storage, codec, kind)) {
    const list = grouped.get(event.device_id);
    if (list === undefined) grouped.set(event.device_id, [event]);
    else list.push(event);
  }

  const selected: TombstoneEvent[] = [];
  const advances: TombstoneWatermarkAdvance[] = [];
  for (const deviceId of [...grouped.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const events = grouped.get(deviceId)!;
    const source = `event:${deviceId}`;
    const watermark = watermarkFor(source);
    let expected = watermark + 1n;
    let maxSeq = watermark;
    let badEntrySeen = false;
    for (const event of events.filter(item => item.seq > watermark)) {
      if (event.seq !== expected) {
        networkError(`不可变 tombstone 事件断层：设备 ${deviceId} 期望 seq=${expected}，实际 seq=${event.seq}`);
      }
      expected += 1n;
      // [R04] 坏/超前 deleted_at：跳过该条，且 seq 水位停在它之前（其后正常事件也不推进）。
      if (!tombstoneDeletedAtUsable(event.deleted_at, `${kind}/${event.object_id}`, logger)) {
        badEntrySeen = true;
        continue;
      }
      if (!badEntrySeen) maxSeq = event.seq;
      selected.push(event);
    }
    if (maxSeq > watermark) {
      advances.push({ source_device_id: source, last_applied_offset: maxSeq });
    }
  }
  return [selected, advances];
}
