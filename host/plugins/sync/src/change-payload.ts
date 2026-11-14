/**
 * `SyncChangeWithData` 的线缆序列化/反序列化（serde 字段顺序与 skip 语义）。
 */
import type { DbJson } from '../../../platform/util/lossless-json.ts';
import { isJsonObject, parseJsonLossless, stringifyJsonLossless } from '../../../platform/util/lossless-json.ts';

export type ChangeOperation = 'Insert' | 'Update' | 'Delete';

export interface EngineChange {
  table_name: string;
  record_id: string;
  operation: ChangeOperation;
  data: DbJson | null;
  changed_at: string;
  change_log_id?: number | bigint | null;
  database_name?: string | null;
  suppress_change_log?: boolean | null;
  source_device_id?: string | null;
  source_seq?: number | bigint | null;
}

export function changeOperationFromStr(value: string): ChangeOperation | null {
  switch (value.toUpperCase()) {
    case 'INSERT': return 'Insert';
    case 'UPDATE': return 'Update';
    case 'DELETE': return 'Delete';
    default: return null;
  }
}

export function changeOperationAsStr(operation: ChangeOperation): string {
  return operation.toUpperCase();
}

function appendOptionalObjectField(parts: string[], key: string, value: DbJson): void {
  parts.push(`${JSON.stringify(key)}:${stringifyJsonLossless(value)}`);
}

/** 与 serde_json::to_string(&SyncChangeWithData) 一致（跳过 None 的可选字段）。 */
export function serializeSyncChange(change: EngineChange): string {
  const parts: string[] = [
    `"table_name":${JSON.stringify(change.table_name)}`,
    `"record_id":${JSON.stringify(change.record_id)}`,
    `"operation":${JSON.stringify(change.operation)}`,
  ];
  appendOptionalObjectField(parts, 'data', change.data);
  appendOptionalObjectField(parts, 'changed_at', change.changed_at);
  if (change.change_log_id !== undefined && change.change_log_id !== null) {
    parts.push(`"change_log_id":${change.change_log_id}`);
  }
  if (change.database_name !== undefined && change.database_name !== null) {
    parts.push(`"database_name":${JSON.stringify(change.database_name)}`);
  }
  if (change.suppress_change_log !== undefined && change.suppress_change_log !== null) {
    parts.push(`"suppress_change_log":${change.suppress_change_log ? 'true' : 'false'}`);
  }
  if (change.source_device_id !== undefined && change.source_device_id !== null) {
    parts.push(`"source_device_id":${JSON.stringify(change.source_device_id)}`);
  }
  if (change.source_seq !== undefined && change.source_seq !== null) {
    parts.push(`"source_seq":${change.source_seq}`);
  }
  return `{${parts.join(',')}}`;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalInteger(value: unknown, field: string, min: bigint, max: bigint): number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
    throw new Error(`${field} 必须是整数`);
  }
  const integer = BigInt(value);
  if (integer < min || integer > max) throw new Error(`${field} 超出范围`);
  return value as number | bigint;
}

/** 解析单条 change；字段缺失时保持 undefined（对应 serde Option None）。 */
export function parseSyncChange(text: string): EngineChange {
  const raw = parseJsonLossless(text);
  if (!isJsonObject(raw)) {
    throw new Error('change payload 不是 JSON 对象');
  }
  const tableName = optionalString(raw.table_name);
  const recordId = optionalString(raw.record_id);
  const operation = changeOperationFromStr(optionalString(raw.operation) ?? '');
  const changedAt = optionalString(raw.changed_at);
  if (tableName === null || recordId === null || operation === null || changedAt === null) {
    throw new Error('change payload 缺少必填字段');
  }
  const change: EngineChange = {
    table_name: tableName,
    record_id: recordId,
    operation,
    data: (raw.data ?? null) as DbJson | null,
    changed_at: changedAt,
  };
  if (raw.change_log_id !== undefined) change.change_log_id = optionalInteger(raw.change_log_id, 'change_log_id', -(1n << 63n), (1n << 63n) - 1n);
  if (raw.database_name !== undefined) change.database_name = optionalString(raw.database_name);
  if (raw.suppress_change_log !== undefined) change.suppress_change_log = raw.suppress_change_log === true;
  if (raw.source_device_id !== undefined) change.source_device_id = optionalString(raw.source_device_id);
  if (raw.source_seq !== undefined) change.source_seq = optionalInteger(raw.source_seq, 'source_seq', 0n, (1n << 64n) - 1n);
  return change;
}
