import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { compareLwwTimestamps, timestampValueToLwwString } from '../src/lww.ts';
import { tableExists, tableColumnNames, primaryKeyColumns, parseRecordKeyValues, buildPrimaryKeyPredicate, quoteIdentifier, jsonValueToSqlParam, getSafe, rowToJson, selectWithTypes } from './sqlite-values.ts';

export interface UnknownFieldVersion { hlc: string; dev: string; seq?: number | bigint }
export interface VersionedUnknownField extends UnknownFieldVersion { value: DbJson }

function isEnvelope(value: DbJson | undefined): value is VersionedUnknownField & Record<string, DbJson> {
  return isJsonObject(value) && Object.hasOwn(value, 'value') && typeof value.hlc === 'string' && typeof value.dev === 'string';
}

function readStoredFields(db: SqlExecutor, table: string, id: string): Record<string, DbJson> {
  if (!tableExists(db, '__sync_unknown_fields')) return {};
  const row = db.get<{ fields_json: string }>('SELECT fields_json FROM __sync_unknown_fields WHERE table_name=?1 AND record_id=?2', [table, id]);
  if (!row) return {};
  const value = parseJsonLossless(row.fields_json);
  return isJsonObject(value) ? value : {};
}

function storeFields(db: SqlExecutor, table: string, id: string, fields: Record<string, DbJson>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS __sync_unknown_fields (
    table_name TEXT NOT NULL, record_id TEXT NOT NULL, fields_json TEXT NOT NULL,
    source_schema_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(table_name, record_id))`);
  db.run(`INSERT INTO __sync_unknown_fields(table_name, record_id, fields_json) VALUES(?1, ?2, ?3)
    ON CONFLICT(table_name, record_id) DO UPDATE SET fields_json=excluded.fields_json, updated_at=datetime('now')`,
  [table, id, stringifyJsonLossless(fields)]);
}

export function readUnknownFields(db: SqlExecutor, table: string, id: string): Record<string, DbJson> {
  return readUnknownFieldsForRoundTrip(db, table, id).values;
}

export function readUnknownFieldsForRoundTrip(db: SqlExecutor, table: string, id: string): {
  values: Record<string, DbJson>; fieldDeltas: Record<string, UnknownFieldVersion>;
} {
  const values: Record<string, DbJson> = {};
  const fieldDeltas: Record<string, UnknownFieldVersion> = {};
  for (const [key, stored] of Object.entries(readStoredFields(db, table, id))) {
    values[key] = isEnvelope(stored) ? stored.value : stored;
    if (isEnvelope(stored)) {
      const { value: _value, ...version } = stored;
      fieldDeltas[key] = version;
    }
  }
  return { values, fieldDeltas };
}

export function vaultUnknownFieldsWithVersion(db: SqlExecutor, table: string, id: string,
  incoming: Record<string, VersionedUnknownField>, floorDeletedHlc?: string): void {
  const fields = readStoredFields(db, table, id);
  let floor = floorDeletedHlc;
  let floorDev = '';
  if (tableExists(db, '__sync_row_meta')) {
    const meta = db.get<{ floor_deleted_hlc: string | null; floor_deleted_dev: string | null }>(
      'SELECT floor_deleted_hlc, floor_deleted_dev FROM __sync_row_meta WHERE table_name=?1 AND record_id=?2', [table, id]);
    if (meta?.floor_deleted_hlc && (!floor || compareLwwTimestamps(meta.floor_deleted_hlc, '', '', floor, '', '') >= 0)) {
      floor = meta.floor_deleted_hlc;
      floorDev = meta.floor_deleted_dev ?? '';
    }
  }
  for (const [key, field] of Object.entries(incoming)) {
    if (floor && compareLwwTimestamps(field.hlc, floorDeletedHlc ? '' : field.dev, '', floor, floorDeletedHlc ? '' : floorDev, '') <= 0) continue;
    const previous = fields[key];
    if (isEnvelope(previous) && compareLwwTimestamps(field.hlc, field.dev, '', previous.hlc, previous.dev, '') <= 0) continue;
    fields[key] = { ...field };
  }
  if (Object.keys(fields).length) storeFields(db, table, id, fields);
}

export function vaultUnknownFields(db: SqlExecutor, table: string, id: string, fields: Record<string, DbJson>): void {
  if (Object.keys(fields).length === 0) return;
  db.exec(`CREATE TABLE IF NOT EXISTS __sync_unknown_fields (
    table_name TEXT NOT NULL, record_id TEXT NOT NULL, fields_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(table_name, record_id))`);
  const previous = readStoredFields(db, table, id);
  // A legacy round-trip cannot mint a newer causal version for an opaque column.
  fields = Object.fromEntries(Object.entries(fields).filter(([key]) => !isEnvelope(previous[key])));
  const deltas = '__sync_field_deltas';
  if (isJsonObject(previous[deltas]) && isJsonObject(fields[deltas])) fields = { ...fields, [deltas]: { ...previous[deltas], ...fields[deltas] } };
  db.run(`INSERT INTO __sync_unknown_fields(table_name, record_id, fields_json) VALUES(?1, ?2, ?3)
    ON CONFLICT(table_name, record_id) DO UPDATE SET fields_json=excluded.fields_json, updated_at=datetime('now')`,
  [table, id, stringifyJsonLossless({ ...previous, ...fields })]);
}

/** Run after a schema upgrade; remove only fields successfully restored to an existing row. */
export function rehydrateUnknownFieldsIfColumnsExist(db: SqlExecutor, table: string): void {
  if (!tableExists(db, '__sync_unknown_fields')) return;
  const known = new Set(tableColumnNames(db, table));
  const pk = primaryKeyColumns(db, table);
  for (const row of db.all<{ record_id: string }>('SELECT record_id FROM __sync_unknown_fields WHERE table_name=?1', [table])) {
    db.exec('SAVEPOINT sync_rehydrate_unknown_fields');
    try {
      const fields = readStoredFields(db, table, row.record_id);
      const meta = tableExists(db, '__sync_row_meta') ? db.get<{ floor_deleted_hlc: string | null; floor_deleted_dev: string | null; col_versions_json: string }>(
        'SELECT floor_deleted_hlc, floor_deleted_dev, col_versions_json FROM __sync_row_meta WHERE table_name=?1 AND record_id=?2', [table, row.record_id]) : undefined;
      const versions = meta ? parseJsonLossless(meta.col_versions_json) : {};
      if (!isJsonObject(versions)) throw new TypeError('列版本不是对象');
      const keyValues = parseRecordKeyValues(table, row.record_id, pk);
      const columns = [...known];
      const existing = getSafe(db, `SELECT ${selectWithTypes(columns)} FROM ${quoteIdentifier(table)} WHERE ${buildPrimaryKeyPredicate(pk)}`, keyValues);
      if (!existing) { db.exec('RELEASE SAVEPOINT sync_rehydrate_unknown_fields'); continue; }
      const versioned = Object.values(fields).some(isEnvelope);
      if (!meta && versioned) {
        const local = rowToJson(existing, columns);
        const bootstrap = { hlc: timestampValueToLwwString(local.updated_at ?? local.created_at) ?? '000000000000000-00000',
          dev: typeof local.device_id === 'string' ? local.device_id : '' };
        for (const col of columns) if (!pk.includes(col) && local[col] !== null) versions[col] = { ...bootstrap };
        db.exec(`CREATE TABLE IF NOT EXISTS __sync_row_meta (
          table_name TEXT NOT NULL, record_id TEXT NOT NULL, floor_deleted_hlc TEXT, floor_deleted_dev TEXT,
          col_versions_json TEXT NOT NULL, PRIMARY KEY(table_name,record_id))`);
        db.run('INSERT INTO __sync_row_meta(table_name,record_id,col_versions_json) VALUES(?1,?2,?3)', [table, row.record_id, stringifyJsonLossless(versions)]);
      }
      const restored = Object.keys(fields).filter(key => {
        if (!known.has(key) || pk.includes(key)) return false;
        const field = fields[key];
        if (!isEnvelope(field)) return !meta?.floor_deleted_hlc;
        if (meta?.floor_deleted_hlc && compareLwwTimestamps(field.hlc, field.dev, '', meta.floor_deleted_hlc, meta.floor_deleted_dev ?? '', '') <= 0) return false;
        const local = versions[key];
        return !isJsonObject(local) || typeof local.hlc !== 'string' || typeof local.dev !== 'string'
          || compareLwwTimestamps(field.hlc, field.dev, '', local.hlc, local.dev, '') > 0;
      });
      if (!restored.length) { db.exec('RELEASE SAVEPOINT sync_rehydrate_unknown_fields'); continue; }
      const values = restored.map(key => {
        const field = fields[key]!;
        const value = jsonValueToSqlParam(isEnvelope(field) ? field.value : field);
        if (value === undefined) throw new TypeError(`列无法转换到 SQLite: ${key}`);
        return value;
      });
      const changed = db.run(`UPDATE ${quoteIdentifier(table)} SET ${restored.map((key, i) => `${quoteIdentifier(key)}=?${i + 1}`).join(',')} WHERE ${buildPrimaryKeyPredicate(pk, restored.length + 1)}`,
        [...values, ...keyValues]).changes;
      if (!changed) { db.exec('RELEASE SAVEPOINT sync_rehydrate_unknown_fields'); continue; }
      for (const key of restored) {
        const field = fields[key];
        if (isEnvelope(field)) {
          const { value: _value, ...version } = field;
          versions[key] = version;
        }
        delete fields[key];
      }
      if (meta || versioned) db.run('UPDATE __sync_row_meta SET col_versions_json=?3 WHERE table_name=?1 AND record_id=?2', [table, row.record_id, stringifyJsonLossless(versions)]);
      if (Object.keys(fields).length) db.run('UPDATE __sync_unknown_fields SET fields_json=?3 WHERE table_name=?1 AND record_id=?2', [table, row.record_id, stringifyJsonLossless(fields)]);
      else db.run('DELETE FROM __sync_unknown_fields WHERE table_name=?1 AND record_id=?2', [table, row.record_id]);
      db.exec('RELEASE SAVEPOINT sync_rehydrate_unknown_fields');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT sync_rehydrate_unknown_fields');
      db.exec('RELEASE SAVEPOINT sync_rehydrate_unknown_fields');
      throw error;
    }
  }
}
