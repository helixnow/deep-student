import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { tableExists } from './sqlite-values.ts';
import { ensureV5SyncTables } from './v5-vaults.ts';

export interface V5ColumnVersionRow {
  col_hlc: string;
  col_dev: string;
  value_hash: string;
}

export interface V5RowMetaRow {
  col_versions_json: string;
  floor_deleted_hlc: string | null;
  floor_deleted_dev: string | null;
}

export function readV5ColumnVersion(
  db: SqlExecutor,
  databaseName: string,
  tableName: string,
  recordId: string,
  colName: string,
): V5ColumnVersionRow | undefined {
  return db.get<V5ColumnVersionRow>(
    'SELECT col_hlc,col_dev,value_hash FROM __sync_v5_column_versions WHERE database_name=? AND table_name=? AND record_id=? AND col_name=?',
    [databaseName, tableName, recordId, colName],
  );
}

export function listV5UnknownFieldRecordIds(db: SqlExecutor, tableName: string): Array<{ record_id: string }> {
  return db.all<{ record_id: string }>('SELECT record_id FROM __sync_unknown_fields WHERE table_name=?', [tableName]);
}

export function getV5RowMetaRow(db: SqlExecutor, tableName: string, recordId: string): V5RowMetaRow | undefined {
  return db.get<V5RowMetaRow>('SELECT * FROM __sync_row_meta WHERE table_name=? AND record_id=?', [tableName, recordId]);
}

export function updateV5RowMetaVersions(
  db: SqlExecutor,
  colVersionsJson: string,
  tableName: string,
  recordId: string,
): void {
  db.run('UPDATE __sync_row_meta SET col_versions_json=? WHERE table_name=? AND record_id=?', [
    colVersionsJson,
    tableName,
    recordId,
  ]);
}

export function readV5UnknownFieldsJson(db: SqlExecutor, tableName: string, recordId: string): string {
  return db.one<{ fields_json: string }>(
    'SELECT fields_json FROM __sync_unknown_fields WHERE table_name=? AND record_id=?',
    [tableName, recordId],
  ).fields_json;
}

export function updateOrDeleteV5UnknownFields(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  remaining: Record<string, DbJson>,
): void {
  if (Object.keys(remaining).length) {
    db.run('UPDATE __sync_unknown_fields SET fields_json=? WHERE table_name=? AND record_id=?', [
      stringifyJsonLossless(remaining),
      tableName,
      recordId,
    ]);
  } else {
    db.run('DELETE FROM __sync_unknown_fields WHERE table_name=? AND record_id=?', [tableName, recordId]);
  }
}

export function upsertV5ColumnVersion(
  db: SqlExecutor,
  databaseName: string,
  tableName: string,
  recordId: string,
  colName: string,
  hlc: string,
  valHash: string,
  dev: string,
): void {
  db.run(
    `INSERT INTO __sync_v5_column_versions VALUES(?,?,?,?,?,?,?) ON CONFLICT(database_name,table_name,record_id,col_name)
      DO UPDATE SET col_hlc=excluded.col_hlc,value_hash=excluded.value_hash,col_dev=excluded.col_dev`,
    [databaseName, tableName, recordId, colName, hlc, valHash, dev],
  );
}

export function deleteV5ColumnVersion(
  db: SqlExecutor,
  databaseName: string,
  tableName: string,
  recordId: string,
  colName: string,
): void {
  db.run(
    'DELETE FROM __sync_v5_column_versions WHERE database_name=? AND table_name=? AND record_id=? AND col_name=?',
    [databaseName, tableName, recordId, colName],
  );
}

export function listV5ColumnVersionNames(
  db: SqlExecutor,
  databaseName: string,
  tableName: string,
  recordId: string,
): Array<{ col_name: string }> {
  return db.all<{ col_name: string }>(
    'SELECT col_name FROM __sync_v5_column_versions WHERE database_name=? AND table_name=? AND record_id=?',
    [databaseName, tableName, recordId],
  );
}

export function upsertV5RowMeta(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  floor: string | null,
  floorDev: string | null,
  colVersionsJson: string,
): void {
  db.run(
    `INSERT INTO __sync_row_meta VALUES(?,?,?,?,?) ON CONFLICT(table_name,record_id)
      DO UPDATE SET floor_deleted_hlc=excluded.floor_deleted_hlc,floor_deleted_dev=excluded.floor_deleted_dev,col_versions_json=excluded.col_versions_json`,
    [tableName, recordId, floor, floorDev, colVersionsJson],
  );
}

export function ensureV5RuntimeStateDb(
  db: DatabaseHandle,
  repoId: string,
  deviceId: string,
  defaultIncarnation: string,
  zeroHlc: string,
  decodeBoundChange: (payloadJson: string) => { table_name: string; record_id: string; operation: string },
): {
  state: { incarnation: string; seq: string; hlc: string };
  receipts: Array<{ device: string; incarnation: string; seq: string }>;
} {
  db.exec(`CREATE TABLE IF NOT EXISTS __sync_v5_runtime_state(repo TEXT NOT NULL, device TEXT NOT NULL, incarnation TEXT NOT NULL, seq TEXT NOT NULL, hlc TEXT NOT NULL, PRIMARY KEY(repo,device));
    CREATE TABLE IF NOT EXISTS __sync_v5_runtime_ops(repo TEXT NOT NULL, device TEXT NOT NULL, incarnation TEXT NOT NULL, seq TEXT NOT NULL, payload TEXT NOT NULL, published INTEGER NOT NULL, local_captured INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repo,device,incarnation,seq));
    CREATE TABLE IF NOT EXISTS __sync_v5_oversize_quarantine(repo TEXT NOT NULL, device TEXT NOT NULL, db_name TEXT NOT NULL, log_id INTEGER NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL, operation TEXT NOT NULL, byte_len INTEGER NOT NULL, PRIMARY KEY(repo,device,db_name,log_id,table_name,record_id,operation));
    CREATE TABLE IF NOT EXISTS __sync_v5_runtime_receipts(repo TEXT NOT NULL, device TEXT NOT NULL, incarnation TEXT NOT NULL, seq TEXT NOT NULL, PRIMARY KEY(repo,device,incarnation,seq));
    CREATE TABLE IF NOT EXISTS __sync_v5_pending_gc(repo TEXT NOT NULL, obj_key TEXT NOT NULL, PRIMARY KEY(repo,obj_key));
    CREATE TABLE IF NOT EXISTS __sync_v5_change_log_bindings_v2(repo TEXT NOT NULL, device TEXT NOT NULL, database_name TEXT NOT NULL, change_log_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL, operation TEXT NOT NULL, incarnation TEXT NOT NULL, seq TEXT NOT NULL, PRIMARY KEY(repo,device,database_name,change_log_id,table_name,record_id,operation));`);
  if (!db.all<{ name: string }>('PRAGMA table_info(__sync_v5_runtime_ops)').some(col => col.name === 'local_captured')) {
    db.exec('ALTER TABLE __sync_v5_runtime_ops ADD COLUMN local_captured INTEGER NOT NULL DEFAULT 0');
  }
  if (tableExists(db as unknown as SqlExecutor, '__sync_v5_change_log_bindings')) {
    db.transaction(tx => {
      for (const row of tx.all<{ repo: string; device: string; database_name: string; change_log_id: string; incarnation: string; seq: string; payload: string }>(
        `SELECT b.*,o.payload FROM __sync_v5_change_log_bindings b JOIN __sync_v5_runtime_ops o
         ON o.repo=b.repo AND o.device=b.device AND o.incarnation=b.incarnation AND o.seq=b.seq`)) {
        const change = decodeBoundChange(row.payload);
        tx.run('INSERT OR IGNORE INTO __sync_v5_change_log_bindings_v2 VALUES(?,?,?,?,?,?,?,?,?)', [
          row.repo,
          row.device,
          row.database_name,
          row.change_log_id,
          change.table_name,
          change.record_id,
          change.operation,
          row.incarnation,
          row.seq,
        ]);
      }
    });
  }
  db.run('INSERT OR IGNORE INTO __sync_v5_runtime_state VALUES(?,?,?,?,?)', [repoId, deviceId, defaultIncarnation, '0', zeroHlc]);
  const state = db.one<{ incarnation: string; seq: string; hlc: string }>(
    'SELECT * FROM __sync_v5_runtime_state WHERE repo=? AND device=?',
    [repoId, deviceId],
  );
  const receipts = db.all<{ device: string; incarnation: string; seq: string }>(
    'SELECT * FROM __sync_v5_runtime_receipts WHERE repo=?',
    [repoId],
  );
  return { state, receipts };
}

export function ensureV5TargetDatabaseTables(target: SqlExecutor): void {
  ensureV5SyncTables(target);
  target.exec(`CREATE TABLE IF NOT EXISTS __sync_v5_column_versions(
    database_name TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
    col_name TEXT NOT NULL, col_hlc TEXT NOT NULL, value_hash TEXT NOT NULL, col_dev TEXT NOT NULL,
    PRIMARY KEY(database_name,table_name,record_id,col_name));`);
  target.exec(`CREATE TABLE IF NOT EXISTS __sync_quarantine_records(
    device TEXT NOT NULL, incarnation TEXT NOT NULL, seq TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(device,incarnation,seq));`);
}

export function insertV5RuntimeReceipt(
  tx: SqlExecutor,
  repoId: string,
  deviceId: string,
  incarnationId: string,
  seqStr: string,
): void {
  tx.run('INSERT OR IGNORE INTO __sync_v5_runtime_receipts VALUES(?,?,?,?)', [repoId, deviceId, incarnationId, seqStr]);
}

export function insertV5QuarantineRecord(
  tx: SqlExecutor,
  deviceId: string,
  incarnationId: string,
  seqStr: string,
  payload: string,
): void {
  tx.run('INSERT OR IGNORE INTO __sync_quarantine_records VALUES(?,?,?,?)', [deviceId, incarnationId, seqStr, payload]);
}

export function deleteV5QuarantineRecord(
  tx: SqlExecutor,
  deviceId: string,
  incarnationId: string,
  seqStr: string,
): void {
  tx.run('DELETE FROM __sync_quarantine_records WHERE device=? AND incarnation=? AND seq=?', [deviceId, incarnationId, seqStr]);
}

export function listV5QuarantinePayloads(db: SqlExecutor): Array<{ payload: string }> {
  return db.all<{ payload: string }>('SELECT payload FROM __sync_quarantine_records ORDER BY length(seq),seq');
}

export function listV5UnknownFieldTables(db: SqlExecutor): Array<{ table_name: string }> {
  return db.all<{ table_name: string }>('SELECT DISTINCT table_name FROM __sync_unknown_fields');
}

export function updateV5RuntimeHlc(tx: SqlExecutor, hlc: string, repoId: string, deviceId: string): void {
  tx.run('UPDATE __sync_v5_runtime_state SET hlc=? WHERE repo=? AND device=?', [hlc, repoId, deviceId]);
}

export function listV5PendingGcKeys(db: SqlExecutor, repoId: string): Array<{ obj_key: string }> {
  return db.all<{ obj_key: string }>('SELECT obj_key FROM __sync_v5_pending_gc WHERE repo=?', [repoId]);
}

export function deleteV5PendingGcKey(db: SqlExecutor, repoId: string, objKey: string): void {
  db.run('DELETE FROM __sync_v5_pending_gc WHERE repo=? AND obj_key=?', [repoId, objKey]);
}

export function insertV5PendingGcKey(db: SqlExecutor, repoId: string, objKey: string): void {
  db.run('INSERT OR IGNORE INTO __sync_v5_pending_gc VALUES(?,?)', [repoId, objKey]);
}

export function readV5RuntimeSeq(tx: SqlExecutor, repoId: string, deviceId: string): bigint {
  return BigInt(tx.one<{ seq: string }>('SELECT seq FROM __sync_v5_runtime_state WHERE repo=? AND device=?', [repoId, deviceId]).seq);
}

export function getV5ChangeLogBindingSeq(
  tx: SqlExecutor,
  repoId: string,
  deviceId: string,
  dbName: string,
  changeLogId: string,
  tableName: string,
  recordId: string,
  operation: string,
): { seq: string } | undefined {
  return tx.get<{ seq: string }>(
    'SELECT seq FROM __sync_v5_change_log_bindings_v2 WHERE repo=? AND device=? AND database_name=? AND change_log_id=? AND table_name=? AND record_id=? AND operation=?',
    [repoId, deviceId, dbName, changeLogId, tableName, recordId, operation],
  );
}

export function hasV5ChangeLogBinding(
  db: SqlExecutor,
  repoId: string,
  deviceId: string,
  dbName: string,
  changeLogId: string,
  tableName: string,
  recordId: string,
  operation: string,
): boolean {
  return Boolean(
    db.get(
      'SELECT 1 FROM __sync_v5_change_log_bindings_v2 WHERE repo=? AND device=? AND database_name=? AND change_log_id=? AND table_name=? AND record_id=? AND operation=?',
      [repoId, deviceId, dbName, changeLogId, tableName, recordId, operation],
    ),
  );
}

export function recordV5OversizeQuarantine(
  tx: SqlExecutor,
  key: readonly [string, string, string, string | number | bigint, string, string, string],
  byteLen: number,
): boolean {
  const existing = tx.get(
    'SELECT 1 FROM __sync_v5_oversize_quarantine WHERE repo=? AND device=? AND db_name=? AND log_id=? AND table_name=? AND record_id=? AND operation=?',
    [...key],
  );
  tx.run('INSERT OR REPLACE INTO __sync_v5_oversize_quarantine VALUES(?,?,?,?,?,?,?,?)', [...key, byteLen]);
  return !existing;
}

export function insertV5RuntimeOp(
  tx: SqlExecutor,
  repoId: string,
  deviceId: string,
  incarnationId: string,
  seqStr: string,
  payload: string,
): void {
  tx.run(
    'INSERT INTO __sync_v5_runtime_ops(repo,device,incarnation,seq,payload,published,local_captured) VALUES(?,?,?,?,?,0,0)',
    [repoId, deviceId, incarnationId, seqStr, payload],
  );
}

export function insertV5ChangeLogBinding(
  tx: SqlExecutor,
  repoId: string,
  deviceId: string,
  dbName: string,
  changeLogId: string,
  tableName: string,
  recordId: string,
  operation: string,
  incarnationId: string,
  seqStr: string,
): void {
  tx.run('INSERT INTO __sync_v5_change_log_bindings_v2 VALUES(?,?,?,?,?,?,?,?,?)', [
    repoId,
    deviceId,
    dbName,
    changeLogId,
    tableName,
    recordId,
    operation,
    incarnationId,
    seqStr,
  ]);
}

export function updateV5RuntimeSeqAndHlc(
  tx: SqlExecutor,
  seqStr: string,
  hlc: string,
  repoId: string,
  deviceId: string,
): void {
  tx.run('UPDATE __sync_v5_runtime_state SET seq=?, hlc=? WHERE repo=? AND device=?', [seqStr, hlc, repoId, deviceId]);
}

export function listV5PendingLocalCaptureOps(
  db: SqlExecutor,
  repoId: string,
  deviceId: string,
): Array<{ payload: string }> {
  return db.all<{ payload: string }>(
    'SELECT payload FROM __sync_v5_runtime_ops WHERE repo=? AND device=? AND local_captured=0 ORDER BY length(seq),seq',
    [repoId, deviceId],
  );
}

export function markV5OpLocalCaptured(
  db: SqlExecutor,
  repoId: string,
  deviceId: string,
  incarnationId: string,
  seqStr: string,
): void {
  db.run(
    'UPDATE __sync_v5_runtime_ops SET local_captured=1 WHERE repo=? AND device=? AND incarnation=? AND seq=?',
    [repoId, deviceId, incarnationId, seqStr],
  );
}

export function listV5PendingChangeLogRows(
  db: SqlExecutor,
): Array<{ id: number; table_name: string; record_id: string; operation: string; changed_at: string }> {
  return db.all<{ id: number; table_name: string; record_id: string; operation: string; changed_at: string }>(
    'SELECT * FROM __change_log WHERE sync_version=0 ORDER BY id ASC',
  );
}

export function isolateV5OversizeOutboxOps(
  db: SqlExecutor,
  repoId: string,
  deviceId: string,
  maxPlaintextBytes: number,
): void {
  db.run(
    'UPDATE __sync_v5_runtime_ops SET published=-1 WHERE repo=? AND device=? AND published=0 AND length(CAST(payload AS BLOB))>?',
    [repoId, deviceId, maxPlaintextBytes],
  );
}

export function listV5UnpublishedOps(
  db: SqlExecutor,
  repoId: string,
  deviceId: string,
): Array<{ payload: string }> {
  return db.all<{ payload: string }>(
    'SELECT payload FROM __sync_v5_runtime_ops WHERE repo=? AND device=? AND published=0 ORDER BY length(seq),seq',
    [repoId, deviceId],
  );
}

export function markV5OpPublished(
  tx: SqlExecutor,
  repoId: string,
  deviceId: string,
  incarnationId: string,
  seqStr: string,
): void {
  tx.run(
    'UPDATE __sync_v5_runtime_ops SET published=1 WHERE repo=? AND device=? AND incarnation=? AND seq=?',
    [repoId, deviceId, incarnationId, seqStr],
  );
}
