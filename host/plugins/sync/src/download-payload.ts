/** SyncChangesPayload / legacy PendingChanges deserialization (mod.rs:9944-10021). */
import { isJsonObject, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { parseSyncChange, type EngineChange } from './change-payload.ts';

export function unsigned(value: DbJson | undefined, label: string): bigint {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw new Error(`${label} 必须是无符号整数`);
  const result = BigInt(value);
  if (result < 0n || result > 18446744073709551615n) throw new Error(`${label} 超出 u64 范围`);
  return result;
}
function string(value: DbJson | undefined, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  return value;
}
export interface ChangesPayload {
  changes: EngineChange[];
  format_version: bigint;
  source_seq: bigint;
  source_device_id: string;
  operation_id: string | null;
}
export function parseChangesPayload(value: DbJson): ChangesPayload {
  if (!isJsonObject(value) || !Array.isArray(value.changes)) throw new Error('缺少 changes');
  string(value.device_id, 'device_id');
  unsigned(value.total_count, 'total_count');
  const format = value.format_version === undefined ? 2n : unsigned(value.format_version, 'format_version');
  if (format > 4294967295n) throw new Error('format_version 超出 u32 范围');
  return {
    changes: value.changes.map(change => parseSyncChange(stringifyJsonLossless(change))),
    format_version: format,
    source_seq: value.source_seq === undefined ? 0n : unsigned(value.source_seq, 'source_seq'),
    source_device_id: value.source_device_id === undefined ? '' : string(value.source_device_id, 'source_device_id'),
    operation_id: value.operation_id == null ? null : string(value.operation_id, 'operation_id'),
  };
}
export function parseLegacyPendingChanges(value: DbJson): EngineChange[] {
  if (!isJsonObject(value) || !Array.isArray(value.entries) || !isJsonObject(value.changes_by_table)) throw new Error('缺少 PendingChanges 字段');
  unsigned(value.total_count, 'total_count');
  for (const count of Object.values(value.changes_by_table)) unsigned(count, 'changes_by_table');
  for (const key of ['earliest_change', 'latest_change']) if (value[key] != null) string(value[key], key);
  return value.entries.map(entry => {
    if (!isJsonObject(entry) || entry.id === undefined || entry.sync_version === undefined) throw new Error('缺少 ChangeLogEntry 字段');
    // Reuse the i64 validation of change_log_id for both signed metadata fields.
    parseSyncChange(stringifyJsonLossless({ ...entry, change_log_id: entry.sync_version, data: null }));
    return parseSyncChange(stringifyJsonLossless({ ...entry, change_log_id: entry.id, data: null }));
  });
}
