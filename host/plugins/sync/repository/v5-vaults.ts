import type { SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import type { ChangeOperation, EngineChange } from '../src/change-payload.ts';
import { serializeSyncChange } from '../src/change-payload.ts';
import { compareLwwTimestamps, timestampValueToLwwString } from '../src/lww.ts';
import { readUnknownFieldsForRoundTrip, vaultUnknownFieldsWithVersion, type UnknownFieldVersion, type VersionedUnknownField } from './unknown-fields.ts';
import { buildPrimaryKeyPredicate, ensureTableAllowedAndExists, getSafe, jsonValueToSqlParam, parseRecordKeyValues, primaryKeyColumns, quoteIdentifier, rowToJson, selectWithTypes, tableColumnNames } from './sqlite-values.ts';

export type MaterializationState = 'materialized' | 'pending_schema' | 'pending_fk' | 'deferred_skew' | 'quarantined';
export interface OpIdentity {
  source_device_id: string;
  incarnation_id: string;
  source_seq: number | bigint;
  op_ordinal?: number;
}
export interface ReceivedOp extends OpIdentity { op_hash: Uint8Array }
const identityWhere = 'source_device_id=?1 AND incarnation_id=?2 AND source_seq=?3 AND op_ordinal=?4';

function identityParams(op: OpIdentity): SqlParam[] {
  if (typeof op.source_seq === 'number' && !Number.isSafeInteger(op.source_seq)) throw new RangeError('source_seq 必须是安全整数或 bigint');
  const seq = BigInt(op.source_seq);
  if (seq < 0n || seq > (1n << 63n) - 1n) throw new RangeError('source_seq 超出有符号 64 位范围');
  const ordinal = op.op_ordinal ?? 0;
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 0xffffffff) throw new RangeError('op_ordinal 超出 u32 范围');
  return [op.source_device_id, op.incarnation_id, seq, ordinal];
}

export function ensureV5SyncTables(db: SqlExecutor): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS __sync_applied_ops (
      source_device_id TEXT NOT NULL, incarnation_id TEXT NOT NULL, source_seq INTEGER NOT NULL,
      op_ordinal INTEGER NOT NULL DEFAULT 0, op_hash BLOB NOT NULL CHECK(length(op_hash)=32),
      materialization_state TEXT NOT NULL CHECK(materialization_state IN ('materialized','pending_schema','pending_fk','deferred_skew','quarantined')),
      received_at TEXT NOT NULL, PRIMARY KEY(source_device_id,incarnation_id,source_seq,op_ordinal));
    CREATE TABLE IF NOT EXISTS __sync_applied_ranges (
      source_device_id TEXT NOT NULL, incarnation_id TEXT NOT NULL, from_seq INTEGER NOT NULL,
      upto_seq INTEGER NOT NULL CHECK(upto_seq>=from_seq), range_leaf_hash BLOB NOT NULL CHECK(length(range_leaf_hash)=32),
      checkpoint_key TEXT, PRIMARY KEY(source_device_id,incarnation_id,from_seq));
    CREATE TABLE IF NOT EXISTS __sync_row_meta (
      table_name TEXT NOT NULL, record_id TEXT NOT NULL, floor_deleted_hlc TEXT, floor_deleted_dev TEXT,
      col_versions_json TEXT NOT NULL, PRIMARY KEY(table_name,record_id));
    CREATE TABLE IF NOT EXISTS __sync_unknown_fields (
      table_name TEXT NOT NULL, record_id TEXT NOT NULL, fields_json TEXT NOT NULL,
      source_schema_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(table_name,record_id));
    CREATE TABLE IF NOT EXISTS __sync_unknown_op_log (
      op_seq INTEGER PRIMARY KEY AUTOINCREMENT, source_device_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
      source_seq INTEGER NOT NULL, op_ordinal INTEGER NOT NULL DEFAULT 0, table_name TEXT NOT NULL,
      record_id TEXT NOT NULL, operation TEXT NOT NULL, data_json TEXT, changed_at TEXT NOT NULL,
      source_schema_version INTEGER NOT NULL DEFAULT 0, UNIQUE(source_device_id,incarnation_id,source_seq,op_ordinal));
    CREATE TABLE IF NOT EXISTS __sync_deferred_orphans (
      orphan_seq INTEGER PRIMARY KEY AUTOINCREMENT, source_device_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
      source_seq INTEGER NOT NULL, op_ordinal INTEGER NOT NULL DEFAULT 0, table_name TEXT NOT NULL,
      record_id TEXT NOT NULL, change_payload_json TEXT NOT NULL, missing_parent_table TEXT, missing_parent_id TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 16),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dead_letter')),
      first_seen_at TEXT NOT NULL, last_error TEXT, UNIQUE(source_device_id,incarnation_id,source_seq,op_ordinal));
  `);
  // The legacy unknown-column vault predates source_schema_version.
  if (!tableColumnNames(db, '__sync_unknown_fields').includes('source_schema_version')) {
    db.exec('ALTER TABLE __sync_unknown_fields ADD COLUMN source_schema_version INTEGER NOT NULL DEFAULT 0');
  }
}

/** Only isNew contributes a Log Merkle leaf. Pending duplicates remain replayable. */
export function recordReceivedOp(db: SqlExecutor, op: ReceivedOp, state: MaterializationState = 'pending_schema'):
  { isNew: boolean; shouldMaterialize: boolean; materializationState: MaterializationState } {
  const params = identityParams(op);
  const existing = db.get<{ op_hash: Uint8Array; materialization_state: MaterializationState }>(
    `SELECT op_hash, materialization_state FROM __sync_applied_ops WHERE ${identityWhere}`, params);
  if (existing) {
    if (existing.op_hash.length !== op.op_hash.length || existing.op_hash.some((byte, i) => byte !== op.op_hash[i])) {
      throw new Error('HistoryForkError: 同一操作身份具有不同 op_hash');
    }
    return { isNew: false, shouldMaterialize: isReplayable(existing.materialization_state), materializationState: existing.materialization_state };
  }
  db.run(`INSERT INTO __sync_applied_ops VALUES(?1,?2,?3,?4,?5,?6,?7)`, [...params, op.op_hash, state, new Date().toISOString()]);
  return { isNew: true, shouldMaterialize: isReplayable(state), materializationState: state };
}

function isReplayable(state: MaterializationState): boolean {
  return state === 'pending_schema' || state === 'pending_fk' || state === 'deferred_skew';
}

/** Invoke in the same transaction as the successful business-row materialization. */
export function transitionOpMaterializationState(db: SqlExecutor, op: OpIdentity, state: MaterializationState): boolean {
  const params = identityParams(op);
  return db.run(`UPDATE __sync_applied_ops SET materialization_state=?5 WHERE ${identityWhere}
    AND materialization_state IN ('pending_schema','pending_fk','deferred_skew')`, [...params, state]).changes > 0;
}

export function appendUnknownOp(db: SqlExecutor, op: OpIdentity, change: EngineChange, sourceSchemaVersion = 0): boolean {
  return db.run(`INSERT INTO __sync_unknown_op_log
    (source_device_id,incarnation_id,source_seq,op_ordinal,table_name,record_id,operation,data_json,changed_at,source_schema_version)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(source_device_id,incarnation_id,source_seq,op_ordinal) DO NOTHING`,
  [...identityParams(op), change.table_name, change.record_id, change.operation, stringifyJsonLossless(change.data), change.changed_at, sourceSchemaVersion]).changes > 0;
}

export function appendDeferredOrphan(db: SqlExecutor, op: OpIdentity, change: EngineChange,
  missingParentTable: string | null = null, missingParentId: string | null = null): boolean {
  return db.run(`INSERT INTO __sync_deferred_orphans
    (source_device_id,incarnation_id,source_seq,op_ordinal,table_name,record_id,change_payload_json,missing_parent_table,missing_parent_id,first_seen_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(source_device_id,incarnation_id,source_seq,op_ordinal) DO NOTHING`,
  [...identityParams(op), change.table_name, change.record_id, serializeSyncChange(change), missingParentTable, missingParentId, new Date().toISOString()]).changes > 0;
}

export function recordOrphanRetryFailure(db: SqlExecutor, op: OpIdentity, error: string): void {
  db.run(`UPDATE __sync_deferred_orphans SET retry_count=retry_count+1,
    status=CASE WHEN retry_count+1>=16 THEN 'dead_letter' ELSE 'pending' END, last_error=?5
    WHERE ${identityWhere} AND status='pending'`, [...identityParams(op), error]);
}

const BOOTSTRAP_HLC = '000000000000000-00000';
type ColVersions = Record<string, UnknownFieldVersion>;
function compareVersion(a: UnknownFieldVersion, b: UnknownFieldVersion): number {
  return compareLwwTimestamps(a.hlc, a.dev, '', b.hlc, b.dev, '');
}
function parseVersions(text: string): ColVersions {
  const raw = parseJsonLossless(text);
  if (!isJsonObject(raw)) throw new TypeError('列版本不是对象');
  const result: ColVersions = {};
  for (const [col, value] of Object.entries(raw)) {
    if (!isJsonObject(value) || typeof value.hlc !== 'string' || typeof value.dev !== 'string') throw new TypeError(`无效列版本: ${col}`);
    result[col] = { hlc: value.hlc, dev: value.dev };
    if (typeof value.seq === 'number' || typeof value.seq === 'bigint') result[col]!.seq = value.seq;
  }
  return result;
}

/** A savepoint also works inside the caller's entity-closure transaction. */
export function applyRowWithColumnLifecycle(db: SqlExecutor, table: string, recordId: string,
  op: ChangeOperation | EngineChange, incomingCols: Record<string, DbJson>, incomingColVersions: ColVersions,
  deleteHlc?: string | UnknownFieldVersion): boolean {
  ensureTableAllowedAndExists(db, table);
  db.exec('SAVEPOINT sync_v5_row_lifecycle');
  try {
    const changed = applyLifecycle(db, table, recordId, op, incomingCols, incomingColVersions, deleteHlc);
    db.exec('RELEASE SAVEPOINT sync_v5_row_lifecycle');
    return changed;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT sync_v5_row_lifecycle');
    db.exec('RELEASE SAVEPOINT sync_v5_row_lifecycle');
    throw error;
  }
}

function applyLifecycle(db: SqlExecutor, table: string, id: string, op: ChangeOperation | EngineChange,
  incoming: Record<string, DbJson>, incomingVersions: ColVersions, deleteHlc?: string | UnknownFieldVersion): boolean {
  const operation = typeof op === 'string' ? op : op.operation;
  const pk = primaryKeyColumns(db, table);
  const keys = parseRecordKeyValues(table, id, pk);
  const columns = tableColumnNames(db, table);
  const ident = quoteIdentifier(table);
  const predicate = buildPrimaryKeyPredicate(pk);
  const row = getSafe(db, `SELECT ${selectWithTypes(columns)} FROM ${ident} WHERE ${predicate}`, keys);
  const local = row ? rowToJson(row, columns) : undefined;
  const meta = db.get<{ floor_deleted_hlc: string | null; floor_deleted_dev: string | null; col_versions_json: string }>(
    'SELECT * FROM __sync_row_meta WHERE table_name=?1 AND record_id=?2', [table, id]);
  let floor: UnknownFieldVersion | undefined = meta?.floor_deleted_hlc ? { hlc: meta.floor_deleted_hlc, dev: meta.floor_deleted_dev ?? '' } : undefined;
  const versions: ColVersions = meta ? parseVersions(meta.col_versions_json) : {};
  if (!meta && local) {
    const bootstrap = { hlc: timestampValueToLwwString(local.updated_at ?? local.created_at) ?? BOOTSTRAP_HLC,
      dev: typeof local.device_id === 'string' ? local.device_id : '' };
    for (const col of columns) if (!pk.includes(col) && local[col] !== null) versions[col] = { ...bootstrap };
  }
  const unknown = readUnknownFieldsForRoundTrip(db, table, id);
  for (const [col, version] of Object.entries(unknown.fieldDeltas)) {
    if (!versions[col] || compareVersion(version, versions[col]!) > 0) versions[col] = version;
  }
  let changed = false;
  if (operation === 'Delete') {
    const deletion = typeof deleteHlc === 'object' ? deleteHlc : {
      hlc: deleteHlc ?? (typeof op === 'string' ? '' : op.changed_at),
      dev: typeof op === 'string' ? '' : op.source_device_id ?? '',
    };
    if (!deletion.hlc) throw new TypeError('Delete 缺少 HLC');
    if (!floor || compareVersion(deletion, floor) > 0) floor = deletion;
    // Opaque registers survive in the vault, not as an empty business row.
    const surviving = Object.entries(versions).filter(([col, v]) => columns.includes(col) && !pk.includes(col) && compareVersion(v, floor!) > 0);
    if (local && surviving.length === 0) {
      changed = db.run(`DELETE FROM ${ident} WHERE ${predicate}`, keys).changes > 0;
    } else if (local) {
      // Defaults come from SQLite's schema expression, never from incoming data.
      const info = db.all<{ name: string; dflt_value: string | null }>(`PRAGMA table_info(${ident})`);
      const stale = info.filter(col => !pk.includes(col.name) && (!versions[col.name] || compareVersion(versions[col.name]!, floor!) <= 0));
      if (stale.length) changed = db.run(`UPDATE ${ident} SET ${stale.map(col => `${quoteIdentifier(col.name)}=${col.dflt_value ?? 'NULL'}`).join(',')} WHERE ${predicate}`, keys).changes > 0;
    }
    for (const [col, version] of Object.entries(versions)) if (compareVersion(version, floor) <= 0) delete versions[col];
    const stored = db.get<{ fields_json: string }>('SELECT fields_json FROM __sync_unknown_fields WHERE table_name=?1 AND record_id=?2', [table, id]);
    if (stored) {
      const fields = parseJsonLossless(stored.fields_json);
      if (isJsonObject(fields)) {
        for (const col of Object.keys(fields)) if (!versions[col]) delete fields[col];
        if (Object.keys(fields).length) db.run('UPDATE __sync_unknown_fields SET fields_json=?3 WHERE table_name=?1 AND record_id=?2', [table, id, stringifyJsonLossless(fields)]);
        else db.run('DELETE FROM __sync_unknown_fields WHERE table_name=?1 AND record_id=?2', [table, id]);
      }
    }
  } else {
    const winners: Record<string, DbJson> = {};
    const unknownWinners: Record<string, VersionedUnknownField> = {};
    for (const [col, value] of Object.entries(incoming)) {
      if (pk.includes(col)) continue;
      const version = incomingVersions[col];
      if (!version) throw new TypeError(`列缺少原始版本: ${col}`);
      if (floor && compareVersion(version, floor) <= 0) continue;
      if (versions[col] && compareVersion(version, versions[col]!) <= 0) continue;
      if (columns.includes(col)) winners[col] = value;
      else unknownWinners[col] = { value, ...version };
      versions[col] = { ...version };
    }
    const names = Object.keys(winners);
    if (names.length) {
      const params = names.map(col => {
        const param = jsonValueToSqlParam(winners[col]!);
        if (param === undefined) throw new TypeError(`列无法转换到 SQLite: ${col}`);
        return param;
      });
      if (local) {
        changed = db.run(`UPDATE ${ident} SET ${names.map((col, i) => `${quoteIdentifier(col)}=?${i + 1}`).join(',')} WHERE ${buildPrimaryKeyPredicate(pk, names.length + 1)}`, [...params, ...keys]).changes > 0;
      } else {
        const insertCols = [...pk, ...names];
        changed = db.run(`INSERT INTO ${ident} (${insertCols.map(quoteIdentifier).join(',')}) VALUES(${insertCols.map((_, i) => `?${i + 1}`).join(',')})`, [...keys, ...params]).changes > 0;
      }
    }
    vaultUnknownFieldsWithVersion(db, table, id, unknownWinners);
  }
  const jsonVersions: Record<string, DbJson> = {};
  for (const [col, v] of Object.entries(versions)) jsonVersions[col] = { ...v };
  db.run(`INSERT INTO __sync_row_meta(table_name,record_id,floor_deleted_hlc,floor_deleted_dev,col_versions_json)
    VALUES(?1,?2,?3,?4,?5) ON CONFLICT(table_name,record_id) DO UPDATE SET
    floor_deleted_hlc=excluded.floor_deleted_hlc,floor_deleted_dev=excluded.floor_deleted_dev,col_versions_json=excluded.col_versions_json`,
  [table, id, floor?.hlc ?? null, floor?.dev ?? null, stringifyJsonLossless(jsonVersions)]);
  return changed;
}

export function selectDeterministicCanonicalId(a: { id: string; createdHlc: string; deviceId: string },
  b: { id: string; createdHlc: string; deviceId: string }): string {
  const version = compareLwwTimestamps(a.createdHlc, a.deviceId, '', b.createdHlc, b.deviceId, '');
  return (version || compareUtf8(a.id, b.id)) <= 0 ? a.id : b.id;
}

/** Connected entity references form indivisible groups, even when larger than the target. */
export function partitionEntityCohesiveMicroBatches(changes: EngineChange[], maxBatchRows = 100): EngineChange[][] {
  if (!Number.isSafeInteger(maxBatchRows) || maxBatchRows <= 0) throw new RangeError('maxBatchRows 必须为正整数');
  const parents = changes.map((_, i) => i);
  const find = (i: number): number => {
    while (parents[i] !== i) { parents[i] = parents[parents[i]!]!; i = parents[i]!; }
    return i;
  };
  const seen = new Map<string, number>();
  const rootTables: Record<string, string> = { notes: 'note', note_document_formats: 'note', questions: 'question', mistakes: 'mistake',
    sessions: 'session', chat_v2_sessions: 'session', review_sessions: 'session', temp_sessions: 'session',
    exam_sheet_sessions: 'session', essay_sessions: 'session', resources: 'resource', chat_v2_messages: 'message' };
  changes.forEach((change, i) => {
    const scope = change.database_name ?? '';
    const tokens = [`row:${change.table_name}:${change.record_id}`];
    let keyFields: Record<string, DbJson> = {};
    if (change.record_id.startsWith('{')) {
      try {
        const parsed = parseJsonLossless(change.record_id);
        if (isJsonObject(parsed)) keyFields = parsed;
      } catch (_error) {
        // Opaque string IDs beginning with '{' are not necessarily composite keys.
        keyFields = {};
      }
    }
    const data = { ...keyFields, ...(isJsonObject(change.data) ? change.data : {}) };
    const root = rootTables[change.table_name];
    if (root) tokens.push(`${root}:${change.record_id}`);
    for (const key of ['note_id', 'question_id', 'mistake_id', 'session_id', 'resource_id', 'message_id']) {
      const value = data[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') tokens.push(`${key.slice(0, -3)}:${value}`);
    }
    if (change.table_name === 'folder_items' && data.item_id != null) {
      const type = data.item_type;
      if (typeof type === 'string') tokens.push(`${type === 'notes' ? 'note' : type === 'resources' ? 'resource' : type}:${data.item_id}`);
    }
    const origin = (change as EngineChange & { origin_tx_id?: string }).origin_tx_id ?? data.origin_tx_id;
    if (origin != null) tokens.push(`tx:${origin}`);
    for (const token of tokens) {
      const key = stringifyJsonLossless([scope, token]);
      const previous = seen.get(key);
      if (previous !== undefined) parents[find(i)] = find(previous);
      else seen.set(key, i);
    }
  });
  const groups = new Map<number, EngineChange[]>();
  changes.forEach((change, i) => { const root = find(i); const group = groups.get(root) ?? []; group.push(change); groups.set(root, group); });
  const batches: EngineChange[][] = [];
  let batch: EngineChange[] = [];
  for (const group of groups.values()) {
    if (batch.length && batch.length + group.length > maxBatchRows) { batches.push(batch); batch = []; }
    batch.push(...group);
    if (batch.length >= maxBatchRows) { batches.push(batch); batch = []; }
  }
  if (batch.length) batches.push(batch);
  return batches;
}
