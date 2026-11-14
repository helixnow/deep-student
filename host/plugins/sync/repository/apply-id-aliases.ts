import { rustTrim } from '../../../platform/util/index.ts';
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
import { compareStrings, registryBusinessUniqueColumns, uniqueIndexColumnGroups } from './apply-record.ts';

export type IdAliasMap = Map<string, string>;

function aliasKey(tableName: string, recordId: string): string {
  return `${tableName}\u001f${recordId}`;
}

/** `resolve_persisted_id_alias`（id_alias.rs:45）：只读解析，循环降级为原始 id。 */
export function resolvePersistedIdAlias(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
): string {
  if (!tableExists(db, '__sync_id_aliases')) return recordId;
  const seen = new Set<string>();
  let current = recordId;
  for (;;) {
    if (seen.has(current)) return recordId;
    seen.add(current);
    let next;
    try {
      next = db.pluck<string | null>(
        'SELECT canonical_id FROM __sync_id_aliases WHERE table_name = ?1 AND remote_id = ?2',
        [tableName, current],
      );
    } catch (error) {
      databaseError(`读取 ID 别名失败: ${message(error)}`);
    }
    if (next === null || next === undefined) return current;
    current = String(next);
  }
}

export function ensureIdAliasTable(db: SqlExecutor): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS __sync_id_aliases (
          table_name TEXT NOT NULL,
          remote_id TEXT NOT NULL,
          canonical_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (table_name, remote_id)
      );
      CREATE INDEX IF NOT EXISTS idx__sync_id_aliases_canonical
          ON __sync_id_aliases(table_name, canonical_id);
    `);
  } catch (error) {
    databaseError(`创建 __sync_id_aliases 失败: ${message(error)}`);
  }
}

/** `resolve_alias_with_lookup`：沿别名链解析并拒绝循环。 */
export function resolveAlias(aliases: IdAliasMap, tableName: string, recordId: string): string {
  const visited = new Set<string>();
  let current = recordId;
  for (;;) {
    if (visited.has(current)) {
      databaseError(`ID 别名形成循环: ${tableName}.${recordId}`);
    }
    visited.add(current);
    const next = aliases.get(aliasKey(tableName, current));
    if (next === undefined || next === current) return current;
    current = next;
  }
}

function insertAlias(
  aliases: IdAliasMap,
  tableName: string,
  remoteId: string,
  canonicalId: string,
): boolean {
  if (remoteId === canonicalId) return false;
  const canonicalResolved = resolveAlias(aliases, tableName, canonicalId);
  if (canonicalResolved === remoteId) {
    // 拒绝写入会形成循环的别名。
    return false;
  }
  const key = aliasKey(tableName, remoteId);
  const existing = aliases.get(key);
  if (existing !== undefined) {
    if (existing === canonicalResolved) return false;
    databaseError(`ID 别名冲突: ${tableName}.${remoteId} -> ${existing} / ${canonicalResolved}`);
  }
  aliases.set(key, canonicalResolved);
  return true;
}

function loadIdAliases(db: SqlExecutor): IdAliasMap {
  ensureIdAliasTable(db);
  let rows;
  try {
    rows = db.all<{ table_name: string; remote_id: string; canonical_id: string }>(
      'SELECT table_name, remote_id, canonical_id FROM __sync_id_aliases',
    );
  } catch (error) {
    databaseError(`读取 __sync_id_aliases 失败: ${message(error)}`);
  }
  const aliases: IdAliasMap = new Map();
  for (const row of rows) insertAlias(aliases, row.table_name, row.remote_id, row.canonical_id);
  return aliases;
}

export function persistIdAliases(db: SqlExecutor, aliases: IdAliasMap): void {
  ensureIdAliasTable(db);
  for (const [key, canonicalId] of aliases) {
    const separator = key.indexOf('\u001f');
    const tableName = key.slice(0, separator);
    const remoteId = key.slice(separator + 1);
    try {
      db.run(
        `INSERT INTO __sync_id_aliases (table_name, remote_id, canonical_id)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(table_name, remote_id) DO UPDATE SET
            canonical_id = excluded.canonical_id`,
        [tableName, remoteId, canonicalId],
      );
    } catch (error) {
      databaseError(`写入 ID 别名失败: ${message(error)}`);
    }
  }
}

interface ForeignKeyColumn {
  parentTable: string;
  childColumn: string;
  parentColumn: string;
}

function foreignKeyColumns(db: SqlExecutor, tableName: string): ForeignKeyColumn[] {
  ensureTableAllowedAndExists(db, tableName);
  const tableIdent = quoteIdentifier(tableName);
  let rows;
  try {
    rows = db.all<{ table: string; from: string; to: string }>(
      `PRAGMA foreign_key_list(${tableIdent})`,
    );
  } catch (error) {
    databaseError(`查询外键失败: ${message(error)}`);
  }
  const columns: ForeignKeyColumn[] = rows.map(row => ({
    parentTable: String(row.table),
    childColumn: String(row.from),
    parentColumn: String(row.to),
  }));

  const logicalRelations: ReadonlyArray<readonly [string, string, string, string]> = matchLogicalRelations(tableName);
  const childColumns = tableColumnNames(db, tableName);
  for (const [childColumn, parentTable, parentColumn] of logicalRelations) {
    if (!childColumns.includes(childColumn)
      || columns.some(fk => fk.childColumn === childColumn && fk.parentTable === parentTable && fk.parentColumn === parentColumn)) {
      continue;
    }
    try {
      ensureTableAllowedAndExists(db, parentTable);
    } catch {
      continue;
    }
    columns.push({ childColumn, parentTable, parentColumn });
  }
  return columns;
}

function matchLogicalRelations(tableName: string): ReadonlyArray<readonly [string, string, string, string]> {
  if (tableName === 'fsrs_card_states') {
    return [
      ['anki_card_id', 'anki_cards', 'id', ''],
      ['deck_id', 'anki_decks', 'id', ''],
    ];
  }
  if (tableName === 'fsrs_review_logs') {
    return [
      ['card_state_id', 'fsrs_card_states', 'id', ''],
      ['anki_card_id', 'anki_cards', 'id', ''],
    ];
  }
  return [];
}

function businessUniqueKeyGroups(
  db: SqlExecutor,
  tableName: string,
): string[][] {
  const registered = registryBusinessUniqueColumns({ databaseName: null }, tableName);
  if (registered.length === 0) return [];
  const registeredSet = new Set(registered);
  const groups = uniqueIndexColumnGroups(db, tableName)
    .filter(group => group.every(column => registeredSet.has(column)))
    .map(group => [...group]);
  groups.sort((left, right) => compareStrings(left.join(','), right.join(',')));
  return groups.filter((group, index) => index === 0 || group.join(',') !== groups[index - 1]!.join(','));
}

function findCanonicalIdByBusinessKey(
  db: SqlExecutor,
  tableName: string,
  idColumn: string,
  obj: { [key: string]: DbJson },
): string | null {
  const keyGroups = businessUniqueKeyGroups(db, tableName);
  if (keyGroups.length === 0) return null;
  const tableIdent = quoteIdentifier(tableName);
  const idIdent = quoteIdentifier(idColumn);
  for (const group of keyGroups) {
    const whereParts: string[] = [];
    const values: SqlParam[] = [];
    let complete = true;
    for (const column of group) {
      const value = obj[column];
      if (value === undefined || value === null) {
        complete = false;
        break;
      }
      const sqlValue = jsonValueToSqlParam(value);
      if (sqlValue === undefined) {
        complete = false;
        break;
      }
      whereParts.push(`${quoteIdentifier(column)} = ?`);
      values.push(sqlValue);
    }
    if (!complete || values.length !== group.length) continue;
    const sql = `SELECT ${idIdent} FROM ${tableIdent} WHERE ${whereParts.join(' AND ')} LIMIT 1`;
    let row;
    try {
      row = db.get(sql, values);
    } catch (error) {
      databaseError(`查询业务键 canonical id 失败: ${message(error)}`);
    }
    if (row !== undefined) {
      const alias = jsonValueToAliasKey(row[idColumn] as DbJson);
      if (alias !== null) return alias;
    }
  }
  return null;
}

function businessKeyFingerprints(
  db: SqlExecutor,
  tableName: string,
  obj: { [key: string]: DbJson },
): string[] {
  const keyGroups = businessUniqueKeyGroups(db, tableName);
  const fingerprints: string[] = [];
  for (const group of keyGroups) {
    const parts: string[] = [];
    let complete = true;
    for (const column of group) {
      const value = obj[column];
      if (value === undefined || value === null) {
        complete = false;
        break;
      }
      const keyValue = jsonValueToAliasKey(value);
      if (keyValue === null) {
        complete = false;
        break;
      }
      parts.push(`${column}=${keyValue}`);
    }
    if (complete && parts.length > 0) fingerprints.push(parts.join('\u001f'));
  }
  return fingerprints;
}

function remapIdsInJsonValue(value: DbJson, keys: readonly string[], aliases: IdAliasMap): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) changed = remapIdsInJsonValue(item, keys, aliases) || changed;
    return changed;
  }
  if (!isJsonObject(value)) return false;
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key) && typeof child === 'string' && rustTrim(child) !== '') {
      const canonical = resolveAlias(aliases, 'files', child);
      if (canonical !== child) {
        value[key] = canonical;
        changed = true;
      }
    }
    changed = remapIdsInJsonValue(child, keys, aliases) || changed;
  }
  return changed;
}

export function remapJsonEmbeddedIds(
  aliases: IdAliasMap,
  obj: { [key: string]: DbJson },
  column: string,
  keys: readonly string[],
): void {
  const raw = obj[column];
  if (typeof raw !== 'string') return;
  let parsed: DbJson;
  try {
    parsed = parseJsonLossless(raw);
  } catch {
    return;
  }
  if (!remapIdsInJsonValue(parsed, keys, aliases)) return;
  obj[column] = stringifyJsonLossless(parsed);
}

export function remapForeignKeysInObject(
  db: SqlExecutor,
  tableName: string,
  obj: { [key: string]: DbJson },
  aliases: IdAliasMap,
): void {
  for (const fk of foreignKeyColumns(db, tableName)) {
    let parentPk: string[];
    try {
      parentPk = primaryKeyColumns(db, fk.parentTable);
    } catch {
      continue;
    }
    if (parentPk.length !== 1 || parentPk[0] !== fk.parentColumn) continue;
    const current = obj[fk.childColumn];
    if (current === undefined) continue;
    const key = jsonValueToAliasKey(current);
    if (key === null) continue;
    const canonical = resolveAlias(aliases, fk.parentTable, key);
    if (canonical !== key) obj[fk.childColumn] = canonical;
  }

  if (tableName === 'note_learning_relations') {
    const raw = obj.locator_json;
    if (typeof raw !== 'string') databaseError('Missing relation locator');
    let locator: { type?: string; id?: string } & { [key: string]: DbJson };
    try {
      locator = parseJsonLossless(raw) as typeof locator;
    } catch (error) {
      databaseError(message(error));
    }
    if (!isJsonObject(locator)) databaseError('Missing relation locator');
    if (locator.type !== 'card' && typeof obj.resource_id === 'string') {
      obj.resource_id = resolveAlias(aliases, 'resources', obj.resource_id);
    }
    if (locator.type === 'question' && typeof locator.id === 'string') {
      locator.id = resolveAlias(aliases, 'questions', locator.id);
      obj.locator_json = stringifyJsonLossless(locator);
    }
  }

  if (tableName === 'qbank_materials') {
    remapJsonEmbeddedIds(aliases, obj, 'images_json', ['id']);
  }
  if (tableName === 'qbank_sources') {
    remapJsonEmbeddedIds(aliases, obj, 'descriptor_json', ['file_id', 'vfs_file_id']);
  }
}

export function buildDownloadIdAliases(db: SqlExecutor, changes: readonly EngineChange[]): IdAliasMap {
  const aliases = loadIdAliases(db);
  for (;;) {
    const before = aliases.size;
    const batchBusinessKeys = new Map<string, string>();
    for (const change of changes) {
      if (change.operation === 'Delete' || change.data === null || !isJsonObject(change.data)) continue;
      try {
        ensureTableAllowedAndExists(db, change.table_name);
      } catch {
        continue;
      }
      const idColumn = change.table_name === 'note_document_revisions' ? 'version_id' : 'id';
      const obj: { [key: string]: DbJson } = { ...change.data };
      remapForeignKeysInObject(db, change.table_name, obj, aliases);

      const scope = change.database_name ?? '';
      const remoteId = resolveAlias(aliases, change.table_name, change.record_id);
      const fingerprints = businessKeyFingerprints(db, change.table_name, obj);

      const canonical = findCanonicalIdByBusinessKey(db, change.table_name, idColumn, obj);
      if (canonical !== null) {
        insertAlias(aliases, change.table_name, remoteId, canonical);
        insertAlias(aliases, change.table_name, change.record_id, canonical);
        for (const fingerprint of fingerprints) {
          batchBusinessKeys.set(`${scope}\u001f${change.table_name}\u001f${fingerprint}`, canonical);
        }
        continue;
      }

      let matched: string | null = null;
      for (const fingerprint of fingerprints) {
        const existing = batchBusinessKeys.get(`${scope}\u001f${change.table_name}\u001f${fingerprint}`);
        if (existing !== undefined) {
          matched = resolveAlias(aliases, change.table_name, existing);
          break;
        }
      }
      if (matched !== null) {
        insertAlias(aliases, change.table_name, remoteId, matched);
        insertAlias(aliases, change.table_name, change.record_id, matched);
        for (const fingerprint of fingerprints) {
          batchBusinessKeys.set(`${scope}\u001f${change.table_name}\u001f${fingerprint}`, matched);
        }
      } else {
        for (const fingerprint of fingerprints) {
          batchBusinessKeys.set(`${scope}\u001f${change.table_name}\u001f${fingerprint}`, remoteId);
        }
      }
    }
    if (aliases.size === before) break;
  }
  return aliases;
}

export function remapChangeWithAliases(
  db: SqlExecutor,
  change: EngineChange,
  idColumn: string,
  aliases: IdAliasMap,
): EngineChange {
  const remapped: EngineChange = { ...change };
  const canonicalRecordId = resolveAlias(aliases, change.table_name, change.record_id);
  if (canonicalRecordId !== change.record_id) remapped.record_id = canonicalRecordId;
  if (change.data !== null && isJsonObject(change.data)) {
    const obj: { [key: string]: DbJson } = { ...change.data };
    if (canonicalRecordId !== change.record_id && Object.hasOwn(obj, idColumn)) {
      obj[idColumn] = canonicalRecordId;
    }
    remapForeignKeysInObject(db, change.table_name, obj, aliases);
    remapped.data = obj;
  }
  return remapped;
}
