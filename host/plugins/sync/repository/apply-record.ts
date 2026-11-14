import { rustTrim } from '../../../platform/util/index.ts';
import { vaultUnknownFields } from './unknown-fields.ts';
export { rehydrateUnknownFieldsIfColumnsExist } from './unknown-fields.ts';
import { getSafe } from './sqlite-values.ts';
import type { DatabaseHandle, SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { serializeSyncChange } from '../src/change-payload.ts';
import { mergeField, fieldMergeColumnsForTable } from '../src/field-merge.ts';
import { ClockDriftSuspectedError, SyncError } from '../src/errors.ts';
import { syncClassificationRegistry } from '../src/classification.ts';
import { MAX_DRIFT_MS } from '../src/hlc.ts';
import { isJsonFloat, isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { compareLwwTimestamps, lwwDevicePair, lwwTimestampMillis, timestampValueToLwwString } from '../src/lww.ts';
import { recomputeTodoCompletedPomodorosIfRelevant } from './pomodoro-counts.ts';
import { snapshotRecordWithData } from './history.ts';
import { newBatchId, REASON_POLICY_OVERRIDE } from '../src/history.ts';
import { canonicalizeSyncValueForCompare, getRecordData, recordsSemanticallyEqualForSync, SYNC_FIELD_DELTAS_KEY } from './record-data.ts';
import { saveConflictRecord, ensureConflictTable, resolveOne } from './conflict-resolver.ts';
import {
  buildPrimaryKeyPredicate,
  columnDeclaredType,
  ensureTableAllowedAndExists,
  getTableColumns,
  isLocalDerivedSyncColumn,
  jsonValueToAliasKey,
  jsonValueToSqlParam,
  parseRecordKeyValues,
  pluckSafe,
  primaryKeyColumns,
  quoteIdentifier,
  rowToJson,
  selectWithTypes,
  tableColumnNames,
  tableExists,
  tableHasColumn,
} from './sqlite-values.ts';
import {
  type ApplyChangeFailure,
  type ApplyChangesResult,
  type ApplyContext,
  type NoteHistoryHooks,
  beginApplySavepoint,
  databaseError,
  emptyApplyChangesResult,
  getDefaultNoteHistory,
  keyOf,
  message,
  releaseApplySavepoint,
  rollbackAndReleaseApplySavepoint,
  setDefaultNoteHistory,
  suppressEchoChangeLog,
} from './apply-shared.ts';
import { parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

interface DeleteVersion {
  changedAt: string;
  sourceDeviceId: string;
  sourceSeq: bigint;
}

export function ensureDeleteVersionsTable(db: SqlExecutor): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS __sync_delete_versions (
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          source_device_id TEXT NOT NULL,
          source_seq INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (table_name, record_id)
      );
    `);
  } catch (error) {
    databaseError(`创建 __sync_delete_versions 失败: ${message(error)}`);
  }
}

function compareOperationVersions(left: DeleteVersion, right: DeleteVersion): number {
  const base = compareLwwTimestamps(
    left.changedAt,
    left.sourceDeviceId,
    '',
    right.changedAt,
    right.sourceDeviceId,
    '',
  );
  if (base !== 0) return base;
  if (left.sourceSeq === right.sourceSeq) return 0;
  return left.sourceSeq < right.sourceSeq ? -1 : 1;
}

function storedDeleteVersion(db: SqlExecutor, tableName: string, recordId: string): DeleteVersion | null {
  ensureDeleteVersionsTable(db);
  let row;
  try {
    row = getSafe(db,
      'SELECT changed_at, source_device_id, source_seq FROM __sync_delete_versions WHERE table_name=?1 AND record_id=?2',
      [tableName, recordId],
    );
  } catch (error) {
    databaseError(`读取 DELETE 版本失败: ${message(error)}`);
  }
  if (row === undefined) return null;
  const seq = BigInt(row.source_seq as number | bigint);
  return {
    changedAt: String(row.changed_at),
    sourceDeviceId: String(row.source_device_id),
    sourceSeq: seq < 0n ? 0n : seq,
  };
}

function currentDeleteVersion(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  idColumn: string,
  defaultDeviceId: string,
): DeleteVersion | null {
  const stored = storedDeleteVersion(db, tableName, recordId);
  if (stored !== null) return stored;

  if (tableHasColumn(db, tableName, 'deleted_at')) {
    const local = getRecordData(db, tableName, recordId, idColumn);
    if (local !== null && typeof local === 'object' && !Array.isArray(local) && !isJsonFloat(local)) {
      const changedAt = timestampValueToLwwString(local.deleted_at);
      if (changedAt !== null) {
        const device = typeof local.device_id === 'string' && rustTrim(local.device_id) !== ''
          ? local.device_id
          : defaultDeviceId;
        return { changedAt, sourceDeviceId: device, sourceSeq: 0n };
      }
    }
  }

  if (!tableExists(db, '__change_log')) return null;
  try {
    const row = db.get(
      `SELECT changed_at FROM __change_log
       WHERE record_id=?2 AND table_name=?1 AND upper(operation)='DELETE'
       ORDER BY id DESC LIMIT 1`,
      [tableName, recordId],
    );
    if (row === undefined) return null;
    return { changedAt: String(row.changed_at), sourceDeviceId: defaultDeviceId, sourceSeq: 0n };
  } catch (error) {
    databaseError(`读取本地 DELETE 日志失败: ${message(error)}`);
  }
}

function changeVersion(change: EngineChange, defaultDeviceId: string): DeleteVersion {
  let changedAt = change.changed_at;
  if (change.data !== null && typeof change.data === 'object' && !Array.isArray(change.data) && !isJsonFloat(change.data)) {
    const updatedAt = timestampValueToLwwString(change.data.updated_at);
    if (updatedAt !== null) changedAt = updatedAt;
  }
  return {
    changedAt,
    sourceDeviceId: change.source_device_id !== undefined && change.source_device_id !== null
      && rustTrim(change.source_device_id) !== ''
      ? change.source_device_id
      : defaultDeviceId,
    sourceSeq: BigInt(change.source_seq ?? 0),
  };
}

export function upsertBlockedByDeleteVersion(
  db: SqlExecutor,
  change: EngineChange,
  idColumn: string,
  defaultDeviceId: string,
): boolean {
  const deleteVersion = currentDeleteVersion(db, change.table_name, change.record_id, idColumn, defaultDeviceId);
  if (deleteVersion === null) return false;
  return compareOperationVersions(deleteVersion, changeVersion(change, defaultDeviceId)) >= 0;
}

function recordDeleteVersion(db: SqlExecutor, change: EngineChange, defaultDeviceId: string): void {
  ensureDeleteVersionsTable(db);
  const incoming = changeVersion(change, defaultDeviceId);
  const existing = storedDeleteVersion(db, change.table_name, change.record_id);
  if (existing !== null && compareOperationVersions(existing, incoming) >= 0) return;
  try {
    db.run(
      `INSERT INTO __sync_delete_versions
       (table_name, record_id, changed_at, source_device_id, source_seq)
       VALUES(?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(table_name, record_id) DO UPDATE SET
         changed_at=excluded.changed_at,
         source_device_id=excluded.source_device_id,
         source_seq=excluded.source_seq`,
      [
        change.table_name,
        change.record_id,
        incoming.changedAt,
        incoming.sourceDeviceId,
        incoming.sourceSeq > 2n ** 63n - 1n ? 2n ** 63n - 1n : incoming.sourceSeq,
      ],
    );
  } catch (error) {
    databaseError(`写入 DELETE 版本失败: ${message(error)}`);
  }
}

/** mod.rs:8390: archive callers must preserve all local DELETE versions first. */
export function prepareDeleteVersionsForCleanup(db: SqlExecutor, localDeviceId: string): void {
  ensureDeleteVersionsTable(db);
  if (!tableExists(db, '__change_log')) return;
  let rows;
  try { rows = db.iterate<Record<string, unknown>>("SELECT table_name, record_id, changed_at FROM __change_log WHERE upper(operation)='DELETE' ORDER BY id"); }
  catch (error) { databaseError(`准备 DELETE 版本回填失败: ${message(error)}`); }
  try {
    for (;;) {
      let next;
      try { next = rows.next(); }
      catch (error) { databaseError(`读取 DELETE 版本回填失败: ${message(error)}`); }
      if (next.done) break;
      const row = next.value;
      for (const [index, name] of ['table_name', 'record_id', 'changed_at'].entries()) {
        const value = row[name];
        if (typeof value === 'string') continue;
        const type = value === null ? 'Null' : value instanceof Uint8Array ? 'Blob'
          : typeof value === 'bigint' || Number.isInteger(value) ? 'Integer' : 'Real';
        databaseError(`读取 DELETE 版本回填失败: Invalid column type ${type} at index: ${index}, name: ${name}`);
      }
      recordDeleteVersion(db, { table_name: row.table_name as string, record_id: row.record_id as string, changed_at: row.changed_at as string,
        operation: 'Delete', data: null, change_log_id: null, database_name: null,
        suppress_change_log: true, source_device_id: localDeviceId, source_seq: null }, localDeviceId);
    }
  } finally { rows.return?.(); }
}

function clearDeleteVersion(db: SqlExecutor, tableName: string, recordId: string): void {
  ensureDeleteVersionsTable(db);
  try {
    db.run('DELETE FROM __sync_delete_versions WHERE table_name=?1 AND record_id=?2', [tableName, recordId]);
  } catch (error) {
    databaseError(`清理 DELETE 版本失败: ${message(error)}`);
  }
}

type UpsertFreshness =
  | { kind: 'proceed' }
  | { kind: 'skipStale' }
  | { kind: 'suspectDrift'; driftMs: number };

function cloudUpdatedAtString(data: DbJson): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data) || isJsonFloat(data)) return null;
  return timestampValueToLwwString(data.updated_at);
}

function evaluateCloudUpsertFreshness(
  db: SqlExecutor,
  change: EngineChange,
  idColumn: string,
): UpsertFreshness {
  if (change.data === null) return { kind: 'proceed' };
  const cloudString = cloudUpdatedAtString(change.data);
  if (cloudString === null) return { kind: 'proceed' };

  const cloudMillis = lwwTimestampMillis(cloudString);
  if (cloudMillis !== null) {
    const drift = Number(cloudMillis) - Date.now();
    if (drift > MAX_DRIFT_MS) return { kind: 'suspectDrift', driftMs: drift };
  }

  if (!tableHasColumn(db, change.table_name, 'updated_at')) return { kind: 'proceed' };
  const localData = getRecordData(db, change.table_name, change.record_id, idColumn);
  if (localData === null) return { kind: 'proceed' };
  const localString = timestampValueToLwwString(
    typeof localData === 'object' && !Array.isArray(localData) && !isJsonFloat(localData) ? localData.updated_at : null,
  );
  if (localString === null) return { kind: 'proceed' };
  const [localDevice, cloudDevice] = lwwDevicePair(localData, change.data, change.source_device_id ?? null);
  const order = compareLwwTimestamps(
    localString,
    localDevice,
    stringifyJsonLossless(localData),
    cloudString,
    cloudDevice,
    stringifyJsonLossless(change.data),
  );
  return order > 0 ? { kind: 'skipStale' } : { kind: 'proceed' };
}

function buildInsertParts(obj: { [key: string]: DbJson }): {
  columns: string;
  placeholders: string;
  values: SqlParam[];
  columnList: string[];
} {
  const columns: string[] = [];
  const placeholders: string[] = [];
  const values: SqlParam[] = [];
  const columnList: string[] = [];
  let index = 0;
  for (const [key, value] of Object.entries(obj)) {
    index += 1;
    const quoted = quoteIdentifier(key);
    columns.push(quoted);
    columnList.push(quoted);
    placeholders.push(`?${index}`);
    const sqlValue = jsonValueToSqlParam(value);
    if (sqlValue === undefined) {
      databaseError(`字段 ${key} 的 JSON 值无法转换为 SQLite 参数`);
    }
    values.push(sqlValue);
  }
  return { columns: columns.join(', '), placeholders: placeholders.join(', '), values, columnList };
}

export function registryBusinessUniqueColumns(config: { databaseName?: string | null }, tableName: string): string[] {
  const entries = syncClassificationRegistry().filter(entry => entry.table_name === tableName);
  const registered = config.databaseName
    ? entries.filter(entry => entry.database === config.databaseName)
    : entries;
  const distinct = [...new Set(
    registered
      .map(entry => rustTrim(entry.business_unique_keys))
      .filter(value => value !== ''),
  )].sort(compareStrings);
  if (distinct.length !== 1) return [];
  return (distinct[0] as string).split(',').map(rustTrim).filter(part => part !== '');
}

export function uniqueIndexColumnGroups(db: SqlExecutor, tableName: string): string[][] {
  ensureTableAllowedAndExists(db, tableName);
  const tableIdent = quoteIdentifier(tableName);
  const indexes = db.all<{ name: string; unique: number | bigint }>(`PRAGMA index_list(${tableIdent})`);
  const groups: string[][] = [];
  for (const index of indexes) {
    if (Number(index.unique) === 0) continue;
    const indexIdent = quoteIdentifier(index.name);
    const rows = db.all<{ cid: number | bigint; name: string | null }>(`PRAGMA index_info(${indexIdent})`);
    const cols = rows
      .filter(row => Number(row.cid) >= 0 && row.name !== null)
      .map(row => String(row.name));
    if (cols.length > 0 && !groups.some(group => group.length === cols.length && group.every((c, i) => c === cols[i]))) {
      groups.push(cols);
    }
  }
  return groups;
}

function getFallbackUpsertSql(
  db: SqlExecutor,
  config: { databaseName?: string | null },
  tableName: string,
  tableIdent: string,
  columns: string,
  placeholders: string,
  columnsList: readonly string[],
  pkColumns: readonly string[],
): string {
  const registered = registryBusinessUniqueColumns(config, tableName);
  if (registered.length === 0) {
    databaseError(`表 ${tableName} 没有已注册且可验证的业务唯一键，id 冲突需要人工处理`);
  }
  const registeredSet = new Set(registered);
  const groups = uniqueIndexColumnGroups(db, tableName)
    .filter(group => group.every(column => registeredSet.has(column)))
    .sort((left, right) => compareStrings(left.join(','), right.join(',')));
  if (groups.length === 0) {
    databaseError(`表 ${tableName} 没有已注册且可验证的业务唯一键，id 冲突需要人工处理`);
  }
  const protectedColumns = new Set(pkColumns);
  const updateSet = columnsList
    .filter(column => {
      const raw = column.replaceAll('""', '"').replace(/^"|"$/g, '');
      return !protectedColumns.has(raw);
    })
    .map(column => `${column}=excluded.${column}`)
    .join(', ');
  const action = updateSet === '' ? 'DO NOTHING' : `DO UPDATE SET ${updateSet}`;
  return `INSERT INTO ${tableIdent} (${columns}) VALUES (${placeholders}) ON CONFLICT ${action}`;
}

export function compareStrings(left: string, right: string): number {
  return compareUtf8(left, right);
}

/** `ensure_table_allowed_and_exists_for`：未注册为 RowSync 的表 fail-close。 */
function ensureRowSyncTableAllowed(
  db: SqlExecutor,
  tableName: string,
  databaseName: string | null | undefined,
  allowTestFixtures: boolean | undefined,
): void {
  ensureTableAllowedAndExists(db, tableName);
  const table = rustTrim(tableName);
  // Rust `#[cfg(test)]` 豁免：测试 fixture 表名固定，不能放行任意表。
  if (allowTestFixtures === true
    && (table.startsWith('test_') || table.endsWith('_records') || table === 'resource_notes')) {
    return;
  }
  const registered = syncClassificationRegistry().some(entry =>
    entry.table_name === table
    && entry.category === 'RowSync'
    && (databaseName === null || databaseName === undefined || entry.database === databaseName));
  if (!registered) {
    databaseError(`禁止同步未注册为 RowSync 的表: ${databaseName ?? '*'}.${tableName}`);
  }
}

function applySingleRecord(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  data: DbJson,
  allowFieldMerge: boolean,
  context: ApplyContext,
  databaseName?: string | null,
): void {
  ensureRowSyncTableAllowed(db, tableName, databaseName, context.allowSyncTestFixtureTables);
  const noteHistory = context.noteHistory ?? getDefaultNoteHistory();

  if (tableName === 'note_document_revisions') {
    if (!noteHistory?.applyRevision) {
      databaseError('note history service unavailable (L10 note_format_repo)');
    }
    noteHistory.applyRevision(db, recordId, data);
    return;
  }
  noteHistory?.validateIncoming?.(db, tableName, recordId, data);
  const historyNotes = noteHistory?.affectedNotes?.(db, tableName, recordId) ?? [];
  let previousNoteResource: string | null = null;
  if (tableName === 'notes' && historyNotes.length > 0) {
    try {
      const row = db.get('SELECT resource_id FROM notes WHERE id=?1', [recordId]);
      previousNoteResource = row === undefined ? null : String(row.resource_id);
    } catch (error) {
      databaseError(message(error));
    }
  }
  if (historyNotes.length > 0) noteHistory?.snapshotNotes?.(db, historyNotes, 'before_sync');

  const tableIdent = quoteIdentifier(tableName);
  if (data === null || typeof data !== 'object' || Array.isArray(data) || isJsonFloat(data)) {
    databaseError(`记录数据不是有效的 JSON 对象: ${recordId}`);
  }
  const obj: { [key: string]: DbJson } = { ...data };

  let fieldDeltas: { [key: string]: DbJson } | null = null;
  const rawDeltas = obj[SYNC_FIELD_DELTAS_KEY];
  delete obj[SYNC_FIELD_DELTAS_KEY];
  if (rawDeltas !== undefined && rawDeltas !== null) {
    if (typeof rawDeltas !== 'object' || Array.isArray(rawDeltas) || isJsonFloat(rawDeltas)) {
      databaseError(`字段增量元数据格式错误: ${SYNC_FIELD_DELTAS_KEY} = ${stringifyJsonLossless(rawDeltas)}`);
    }
    fieldDeltas = { ...rawDeltas };
  }

  for (const column of Object.keys(obj)) {
    if (isLocalDerivedSyncColumn(tableName, column)) delete obj[column];
  }
  if (tableName === 'note_learning_relations') {
    if (!noteHistory?.prepareRelation) {
      databaseError('note history service unavailable (note_relation_repo)');
    }
    noteHistory.prepareRelation(db, recordId, obj);
  }
  if (fieldDeltas !== null) {
    for (const column of Object.keys(fieldDeltas)) {
      if (isLocalDerivedSyncColumn(tableName, column)) delete fieldDeltas[column];
    }
  }

  const knownColumns = new Set(tableColumnNames(db, tableName));
  const unknown: Record<string, DbJson> = {};
  for (const column of Object.keys(obj)) {
    if (!knownColumns.has(column)) { unknown[column] = obj[column]!; delete obj[column]; }
  }
  if (fieldDeltas !== null) {
    const unknownDeltas: Record<string, DbJson> = {};
    for (const column of Object.keys(fieldDeltas)) {
      if (!knownColumns.has(column)) { unknownDeltas[column] = fieldDeltas[column]!; delete fieldDeltas[column]; }
    }
    if (Object.keys(unknownDeltas).length) unknown[SYNC_FIELD_DELTAS_KEY] = unknownDeltas;
  }
  vaultUnknownFields(db, tableName, recordId, unknown);
  if (Object.keys(obj).length === 0) databaseError(`记录数据为空: ${recordId}`);

  const reviveRecord = Object.hasOwn(obj, 'deleted_at')
    && obj.deleted_at === null
    && tableHasColumn(db, tableName, 'deleted_at');

  const pkColumns = primaryKeyColumns(db, tableName);
  const pkValues = parseRecordKeyValues(tableName, recordId, pkColumns);
  const pkPredicate = buildPrimaryKeyPredicate(pkColumns);

  let payloadKeyValues: string[] | null = null;
  if (pkColumns.length === 1) {
    const pk = pkColumns[0] as string;
    if (Object.hasOwn(obj, pk)) {
      const value = obj[pk] as DbJson;
      payloadKeyValues = [jsonValueToAliasKey(value) ?? stringifyJsonLossless(value)];
    }
  } else if (pkColumns.every(column => Object.hasOwn(obj, column))) {
    payloadKeyValues = pkColumns.map(column => {
      const value = obj[column] as DbJson;
      return jsonValueToAliasKey(value) ?? stringifyJsonLossless(value);
    });
  }
  if (payloadKeyValues !== null) {
    const same = payloadKeyValues.length === pkValues.length
      && payloadKeyValues.every((value, index) => value === pkValues[index]);
    if (!same) {
      databaseError(
        `payload 主键不一致: record_id='${recordId}', payload_pk='${payloadKeyValues.join(':')}'。这可能是云端数据损坏或重放攻击，已拒绝。`,
      );
    }
  }

  const { columns, placeholders, values, columnList } = buildInsertParts(obj);

  const localBefore = new Map<string, DbJson>();
  if (allowFieldMerge) {
    const picklist = fieldMergeColumnsForTable(tableName).filter(column => tableHasColumn(db, tableName, column));
    if (picklist.length > 0) {
      const colsSql = picklist.map(column => quoteIdentifier(column)).join(',');
      const readSql = `SELECT ${selectWithTypes(picklist)} FROM ${tableIdent} WHERE ${pkPredicate}`;
      const row = getSafe(db, readSql, pkValues);
      if (row !== undefined) {
        const json = rowToJson(row, picklist);
        for (const column of picklist) localBefore.set(column, json[column] as DbJson);
      }
    }
  }

  const updateSetFor = (exclude: readonly string[]): string => columnList
    .filter(column => {
      const raw = column.replaceAll('""', '"').replace(/^"|"$/g, '');
      return !exclude.includes(raw);
    })
    .map(column => `${column}=excluded.${column}`)
    .join(', ');

  let upsertSql: string;
  if (tableName === 'review_plans') {
    const action = updateSetFor(['id']);
    upsertSql = `INSERT INTO ${tableIdent} (${columns}) VALUES (${placeholders}) ON CONFLICT(question_id) WHERE question_id IS NOT NULL ${action === '' ? 'DO NOTHING' : `DO UPDATE SET ${action}`}`;
  } else if (tableName === 'resources') {
    const action = updateSetFor(['id']);
    upsertSql = `INSERT INTO ${tableIdent} (${columns}) VALUES (${placeholders}) ON CONFLICT(id) ${action === '' ? 'DO NOTHING' : `DO UPDATE SET ${action}`}`;
  } else if (tableName === 'folder_items') {
    const action = updateSetFor(['id']);
    upsertSql = `INSERT INTO ${tableIdent} (${columns}) VALUES (${placeholders}) ON CONFLICT(folder_id, item_type, item_id) WHERE deleted_at IS NULL ${action === '' ? 'DO NOTHING' : `DO UPDATE SET ${action}`}`;
  } else {
    const action = updateSetFor(pkColumns);
    upsertSql = `INSERT INTO ${tableIdent} (${columns}) VALUES (${placeholders}) ON CONFLICT(${pkColumns.map(quoteIdentifier).join(', ')}) ${action === '' ? 'DO NOTHING' : `DO UPDATE SET ${action}`}`;
  }

  try {
    db.run(upsertSql, values);
  } catch (error) {
    if (!message(error).includes('UNIQUE constraint failed')) {
      databaseError(`UPSERT (OnConflict) 记录失败: ${message(error)}`);
    }
    const fallbackSql = getFallbackUpsertSql(db, { databaseName: null }, tableName, tableIdent, columns, placeholders, columnList, pkColumns);
    try {
      db.exec('SAVEPOINT sp_upsert_fallback');
      try {
        db.run(fallbackSql, values);
        db.exec('RELEASE SAVEPOINT sp_upsert_fallback');
      } catch (fallbackError) {
        db.exec('ROLLBACK TO SAVEPOINT sp_upsert_fallback');
        db.exec('RELEASE SAVEPOINT sp_upsert_fallback');
        databaseError(`UPSERT (业务键回落) 记录失败: ${message(fallbackError)}`);
      }
    } catch (savepointError) {
      if (savepointError instanceof SyncError) throw savepointError;
      databaseError(`创建 SAVEPOINT 失败: ${message(savepointError)}`);
    }
  }

  if (tableName === 'resources') {
    resetDerivedColumns(db, tableIdent, pkPredicate, pkValues, tableName, [
      ['index_state', "index_state = CASE WHEN index_state = 'disabled' THEN 'disabled' ELSE 'pending' END"],
      ['index_hash', 'index_hash = NULL'],
      ['index_error', 'index_error = NULL'],
      ['indexed_at', 'indexed_at = NULL'],
      ['index_retry_count', 'index_retry_count = 0'],
      ['index_next_retry_at', 'index_next_retry_at = 0'],
      ['index_generation', 'index_generation = 0'],
      ['mm_index_state', "mm_index_state = CASE WHEN mm_index_state IS NULL THEN NULL WHEN mm_index_state = 'disabled' THEN 'disabled' ELSE 'pending' END"],
      ['mm_index_error', 'mm_index_error = NULL'],
      ['mm_indexed_at', 'mm_indexed_at = NULL'],
      ['mm_embedding_dim', 'mm_embedding_dim = NULL'],
      ['mm_indexing_mode', 'mm_indexing_mode = NULL'],
      ['mm_index_retry_count', 'mm_index_retry_count = 0'],
      ['mm_index_next_retry_at', 'mm_index_next_retry_at = 0'],
      ['mm_index_generation', 'mm_index_generation = 0'],
    ], '远端资源落地后重置本机派生索引状态失败');
  } else if (tableName === 'files' || tableName === 'exam_sheets') {
    resetDerivedColumns(db, tableIdent, pkPredicate, pkValues, tableName, [
      ['mm_index_state', "mm_index_state = CASE WHEN mm_index_state IS NULL THEN NULL WHEN mm_index_state = 'disabled' THEN 'disabled' ELSE 'pending' END"],
      ['mm_index_error', 'mm_index_error = NULL'],
      ['mm_indexed_pages_json', 'mm_indexed_pages_json = NULL'],
      ['mm_embedding_dim', 'mm_embedding_dim = NULL'],
      ['mm_indexing_mode', 'mm_indexing_mode = NULL'],
      ['mm_indexed_at', 'mm_indexed_at = NULL'],
    ], '远端业务记录落地后重置本机多模态派生状态失败');
  }

  if (reviveRecord) {
    try {
      db.run(
        `UPDATE ${tableIdent} SET "deleted_at" = NULL WHERE ${pkPredicate} AND "deleted_at" IS NOT NULL`,
        pkValues,
      );
    } catch (error) {
      databaseError(`复活软删记录失败: ${message(error)}`);
    }
  }

  for (const [columnName, originalLocal] of localBefore) {
    const remoteValue = obj[columnName];
    if (remoteValue === undefined || remoteValue === null) continue;
    const [mergedValue, wasMerged] = mergeField(
      tableName,
      columnName,
      originalLocal as never,
      remoteValue as never,
      context.profileMerger,
    );
    if (!wasMerged) continue;
    const mergePredicate = buildPrimaryKeyPredicate(pkColumns, 2);
    const columnIdent = quoteIdentifier(columnName);
    const mergeSql = `UPDATE ${tableIdent} SET ${columnIdent} = ?1 WHERE ${mergePredicate}`;
    const sqlValue = jsonValueToSqlParam(mergedValue as DbJson);
    if (sqlValue === undefined) continue;
    let affected: number;
    try {
      affected = db.run(mergeSql, [sqlValue, ...pkValues]).changes;
    } catch (error) {
      databaseError(`字段级合并写入失败: ${tableName}.${columnName} ${message(error)}`);
    }
    if (affected === 0) {
      databaseError(`字段级合并未命中目标记录: ${tableName}.${columnName} record_id=${recordId}`);
    }
  }

  let finalHistoryNotes = historyNotes;
  if (tableName === 'notes' && tableHasColumn(db, 'note_document_revisions', 'version_id')) {
    if (!finalHistoryNotes.includes(recordId)) finalHistoryNotes = [...finalHistoryNotes, recordId];
  }
  if (finalHistoryNotes.length > 0) {
    noteHistory?.snapshotNotes?.(db, finalHistoryNotes, 'remote_sync');
  }
  if (previousNoteResource !== null) {
    noteHistory?.retargetNoteRelations?.(db, recordId, previousNoteResource);
  }
}

function resetDerivedColumns(
  db: SqlExecutor,
  tableIdent: string,
  pkPredicate: string,
  pkValues: readonly string[],
  tableName: string,
  candidates: ReadonlyArray<readonly [string, string]>,
  errorPrefix: string,
): void {
  const existing = new Set(tableColumnNames(db, tableName));
  const assignments = candidates
    .filter(([column]) => existing.has(column))
    .map(([, assignment]) => assignment);
  if (assignments.length === 0) return;
  try {
    db.run(`UPDATE ${tableIdent} SET ${assignments.join(', ')} WHERE ${pkPredicate}`, pkValues);
  } catch (error) {
    databaseError(`${errorPrefix}: ${message(error)}`);
  }
}

export function applySingleChange(
  db: SqlExecutor,
  change: EngineChange,
  idColumn: string,
  skipLww: boolean,
  allowFieldMerge: boolean,
  context: ApplyContext,
): boolean {
  if (change.table_name === 'note_document_revisions') {
    if (change.operation === 'Delete') return false;
    if (change.data === null) databaseError('History payload missing');
    applySingleRecord(db, change.table_name, change.record_id, change.data, false, context, change.database_name);
    return true;
  }
  ensureDeleteVersionsTable(db);

  if (change.operation === 'Delete') {
    ensureTableAllowedAndExists(db, change.table_name);
    const tableIdent = quoteIdentifier(change.table_name);
    const hasTombstone = tableHasColumn(db, change.table_name, 'deleted_at');
    const pkColumns = primaryKeyColumns(db, change.table_name);
    const pkValues = parseRecordKeyValues(change.table_name, change.record_id, pkColumns);
    const pkPredicate = buildPrimaryKeyPredicate(pkColumns);
    const pkPredicateAfter = buildPrimaryKeyPredicate(pkColumns, 2);

    if (!skipLww) {
      const cloudMillis = lwwTimestampMillis(change.changed_at);
      if (cloudMillis === null) {
        databaseError(
          `DELETE changed_at 不可解析，fail-closed 拒绝删除: ${change.table_name}.${idColumn} = ${change.record_id}, changed_at="${change.changed_at}"`,
        );
      }
      const drift = Number(cloudMillis) - Date.now();
      if (drift > MAX_DRIFT_MS) {
        throw new ClockDriftSuspectedError(change.table_name, change.record_id, drift);
      }

      if (tableHasColumn(db, change.table_name, 'updated_at')) {
        const localData = getRecordData(db, change.table_name, change.record_id, idColumn);
        if (localData !== null && typeof localData === 'object' && !Array.isArray(localData) && !isJsonFloat(localData)) {
          const localTimestamp = timestampValueToLwwString(localData.updated_at);
          if (localTimestamp !== null) {
            const [localDevice, cloudDevice] = lwwDevicePair(localData, null, change.source_device_id ?? null);
            if (compareLwwTimestamps(
              localTimestamp,
              localDevice,
              stringifyJsonLossless(localData),
              change.changed_at,
              cloudDevice,
              '',
            ) > 0) {
              const alreadyTombstoned = localData.deleted_at !== undefined && localData.deleted_at !== null;
              if (!alreadyTombstoned) {
                saveConflictRecord(db, {
                  table_name: change.table_name,
                  record_id: change.record_id,
                  side: 'Cloud',
                  data: null,
                  winning_device_id: null,
                  losing_device_id: change.source_device_id ?? null,
                });
              }
              return false;
            }
          }
        }
      }
    }

    if (hasTombstone) {
      const declared = columnDeclaredType(db, change.table_name, 'deleted_at') ?? 'TEXT';
      const sql = `UPDATE ${tableIdent} SET "deleted_at" = ?1 WHERE ${pkPredicateAfter} AND "deleted_at" IS NULL`;
      let tombstoneValue: SqlParam;
      if (declared.toUpperCase().includes('INT')) {
        const millis = lwwTimestampMillis(change.changed_at);
        if (millis === null) databaseError(`软删除时间戳不可解析: "${change.changed_at}"`);
        tombstoneValue = millis;
      } else {
        const parsed = parseRfc3339(change.changed_at);
        tombstoneValue = parsed === null ? change.changed_at : toRfc3339(parsed.epochNanos);
      }
      try {
        db.run(sql, [tombstoneValue, ...pkValues]);
      } catch (error) {
        databaseError(`软删除记录失败: ${message(error)}`);
      }
    } else {
      try {
        db.run(`DELETE FROM ${tableIdent} WHERE ${pkPredicate}`, pkValues);
      } catch (error) {
        databaseError(`删除记录失败: ${message(error)}`);
      }
    }
    recordDeleteVersion(db, change, context.deviceId);
    return true;
  }

  if (change.data === null) {
    if (change.database_name === null || change.database_name === undefined) return false;
    databaseError(`INSERT/UPDATE 缺少 data 字段: ${change.table_name}.${idColumn} = ${change.record_id}`);
  }
  if (upsertBlockedByDeleteVersion(db, change, idColumn, context.deviceId)) return false;

  if (!skipLww) {
    const freshness = evaluateCloudUpsertFreshness(db, change, idColumn);
    if (freshness.kind === 'suspectDrift') {
      throw new ClockDriftSuspectedError(change.table_name, change.record_id, freshness.driftMs);
    }
    if (freshness.kind === 'skipStale') {
      const localData = getRecordData(db, change.table_name, change.record_id, idColumn);
      const isSemanticEcho = localData !== null && recordsSemanticallyEqualForSync(localData, change.data);
      if (!isSemanticEcho) {
        saveConflictRecord(db, {
          table_name: change.table_name,
          record_id: change.record_id,
          side: 'Cloud',
          data: change.data,
          winning_device_id: null,
          losing_device_id: change.source_device_id ?? null,
        });
      }
      return false;
    }
  }

  const localData = getRecordData(db, change.table_name, change.record_id, idColumn);
  if (localData !== null && recordsSemanticallyEqualForSync(localData, change.data)) return false;

  applySingleRecord(db, change.table_name, change.record_id, change.data, allowFieldMerge, context, change.database_name);
  clearDeleteVersion(db, change.table_name, change.record_id);
  return true;
}
