/**
 * `sync_state.db` 的表结构（`state.rs:59-117`）与查询。
 *
 * 连接与路径由 F3 `ctx.storage.database('sync_state')` 提供
 * （`<dataLocalDir>/deep-student/sync/sync_state.db`、busy_timeout 5000）。
 */
import type { Query, SqlExecutor, SqlParams } from '../../../platform/storage/api.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import { StorageError } from '../../../platform/storage/errors.ts';
import { databaseError } from '../src/errors.ts';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS upload_seq (
      instance_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS consume_cursor (
      instance_id TEXT NOT NULL,
      uploader_device_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, uploader_device_id)
  );
  CREATE TABLE IF NOT EXISTS legacy_processed_key (
      instance_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, object_key)
  );
  CREATE TABLE IF NOT EXISTS tombstone_watermark (
      instance_id TEXT NOT NULL,
      source_device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      last_applied_offset INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, source_device_id, kind)
  );
  CREATE TABLE IF NOT EXISTS tombstone_event_publish (
      instance_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, device_id, kind, operation_id),
      UNIQUE (instance_id, device_id, kind, seq)
  );
  CREATE TABLE IF NOT EXISTS instance_binding (
      instance_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      endpoint_hint TEXT NOT NULL,
      bound_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_history (
      old_device_id TEXT NOT NULL,
      new_device_id TEXT NOT NULL,
      rotated_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (old_device_id, new_device_id)
  );
`;

/** `SyncStateStore::init`；失败文案同 Rust。 */
export function initSyncStateSchema(db: SqlExecutor): void {
  try {
    db.exec(SCHEMA);
  } catch (error) {
    databaseError(`初始化 sync_state.db 失败: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Consume F3's physical prepare/bind/execute phase without inspecting error text.
 * rusqlite `Statement::query` only binds parameters, so every step failure,
 * including the first row, maps to the row context (state.rs:424-430).
 */
export function* stateRows<R>(
  db: SqlExecutor,
  query: Query<SqlParams, R>,
  params: SqlParams,
  contexts: { prepare: string; query: string; row: string },
): IterableIterator<R> {
  let rows: IterableIterator<R> | undefined;
  const fail = (error: unknown): never => {
    const phase = error instanceof StorageError ? error.phase : undefined;
    const context = phase === 'prepare' ? contexts.prepare
      : phase === 'bind' ? contexts.query : contexts.row;
    return databaseError(`${context}: ${errorMessage(error)}`);
  };
  try {
    try {
      rows = db.iterate(query, params);
    } catch (error) {
      fail(error);
    }
    while (true) {
      let next: IteratorResult<R>;
      try {
        next = rows!.next();
      } catch (error) {
        fail(error);
      }
      if (next!.done) return;
      yield next!.value;
    }
  } finally {
    rows?.return?.();
  }
}

export const selectInstanceBinding = defineQuery<
  [string],
  { provider: string; endpoint_hint: string }
>(
  'SELECT provider, endpoint_hint FROM instance_binding WHERE instance_id=?1',
  { name: 'syncSupport.state.instanceBinding' },
);

export const insertInstanceBinding = defineQuery<[string, string, string, string], void>(
  `INSERT INTO instance_binding(instance_id, provider, endpoint_hint, bound_at)
   VALUES(?1, ?2, ?3, ?4)`,
  { name: 'syncSupport.state.bindInstance' },
);

export const selectTombstoneWatermark = defineQuery<[string, string, string], { last_applied_offset: number | bigint }>(
  `SELECT last_applied_offset FROM tombstone_watermark
   WHERE instance_id=?1 AND source_device_id=?2 AND kind=?3`,
  { name: 'syncSupport.state.tombstoneWatermark', options: { safeIntegers: true } },
);

export const upsertTombstoneWatermark = defineQuery<[string, string, string, number | bigint, string], void>(
  `INSERT INTO tombstone_watermark(instance_id, source_device_id, kind, last_applied_offset, updated_at)
   VALUES(?1, ?2, ?3, ?4, ?5)
   ON CONFLICT(instance_id, source_device_id, kind)
   DO UPDATE SET last_applied_offset=max(tombstone_watermark.last_applied_offset, excluded.last_applied_offset),
                 updated_at=excluded.updated_at`,
  { name: 'syncSupport.state.setTombstoneWatermark' },
);

export const selectEventSeq = defineQuery<[string, string, string, string], { seq: number | bigint }>(
  `SELECT seq FROM tombstone_event_publish
   WHERE instance_id=?1 AND device_id=?2 AND kind=?3 AND operation_id=?4`,
  { name: 'syncSupport.state.eventSeq', options: { safeIntegers: true } },
);

export const selectEventMaxSeq = defineQuery<[string, string, string], { max_seq: number | bigint }>(
  `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM tombstone_event_publish
   WHERE instance_id=?1 AND device_id=?2 AND kind=?3`,
  { name: 'syncSupport.state.eventMaxSeq', options: { safeIntegers: true } },
);

export const insertEventSeq = defineQuery<[string, string, string, string, number | bigint, string], void>(
  `INSERT INTO tombstone_event_publish
   (instance_id, device_id, kind, operation_id, seq, created_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  { name: 'syncSupport.state.insertEventSeq' },
);

export const selectDeviceRotations = defineQuery<[string], { old_device_id: string; reason: string }>(
  'SELECT old_device_id, reason FROM device_history WHERE new_device_id=?1',
  { name: 'syncSupport.state.deviceRotations', options: { safeIntegers: true } },
);

export const selectUploadSeq = defineQuery<[string, string], { last_seq: number | bigint }>(
  'SELECT last_seq FROM upload_seq WHERE instance_id=?1 AND device_id=?2',
  { name: 'syncSupport.state.uploadSeq', options: { safeIntegers: true } },
);

export const upsertUploadSeq = defineQuery<[string, string, number | bigint, string], void>(
  `INSERT INTO upload_seq(instance_id, device_id, last_seq, updated_at)
   VALUES(?1, ?2, ?3, ?4)
   ON CONFLICT(instance_id, device_id)
   DO UPDATE SET last_seq=max(upload_seq.last_seq, excluded.last_seq),
                 updated_at=excluded.updated_at`,
  { name: 'syncSupport.state.markPublishedSeq' },
);

export const selectCursor = defineQuery<[string, string], { last_seq: number | bigint }>(
  'SELECT last_seq FROM consume_cursor WHERE instance_id=?1 AND uploader_device_id=?2',
  { name: 'syncSupport.state.cursor', options: { safeIntegers: true } },
);

export const upsertCursor = defineQuery<[string, string, number | bigint, string], void>(
  `INSERT INTO consume_cursor(instance_id, uploader_device_id, last_seq, updated_at)
   VALUES(?1, ?2, ?3, ?4)
   ON CONFLICT(instance_id, uploader_device_id)
   DO UPDATE SET last_seq=max(consume_cursor.last_seq, excluded.last_seq),
                 updated_at=excluded.updated_at`,
  { name: 'syncSupport.state.setCursor' },
);

export const selectCursors = defineQuery<[string], { uploader_device_id: string; last_seq: number | bigint }>(
  'SELECT uploader_device_id, last_seq FROM consume_cursor WHERE instance_id=?1',
  { name: 'syncSupport.state.cursors', options: { safeIntegers: true } },
);

export const selectLegacyProcessed = defineQuery<[string, string], { present: number | bigint }>(
  'SELECT 1 AS present FROM legacy_processed_key WHERE instance_id=?1 AND object_key=?2',
  { name: 'syncSupport.state.legacyProcessed' },
);

export const insertLegacyProcessed = defineQuery<[string, string, string], void>(
  `INSERT OR IGNORE INTO legacy_processed_key(instance_id, object_key, processed_at)
   VALUES(?1, ?2, ?3)`,
  { name: 'syncSupport.state.markLegacyProcessed' },
);

export const insertDeviceRotation = defineQuery<[string, string, string, string], void>(
  `INSERT OR REPLACE INTO device_history(old_device_id, new_device_id, rotated_at, reason)
   VALUES(?1, ?2, ?3, ?4)`,
  { name: 'syncSupport.state.deviceRotation' },
);

export const resetConsumeCursors = defineQuery<[string], void>(
  'UPDATE consume_cursor SET last_seq=0, updated_at=?1',
  { name: 'syncSupport.state.resetCursors' },
);

export const deleteAllLegacyProcessed = defineQuery<[], void>(
  'DELETE FROM legacy_processed_key',
  { name: 'syncSupport.state.clearLegacyProcessed' },
);

export const deleteAllTombstoneWatermarks = defineQuery<[], void>(
  'DELETE FROM tombstone_watermark',
  { name: 'syncSupport.state.clearTombstoneWatermarks' },
);

/** `reset_default_after_local_purge` 清空的表（顺序与 Rust 相同）。 */
export const PURGE_RESET_TABLES: readonly string[] = [
  'consume_cursor',
  'legacy_processed_key',
  'tombstone_watermark',
  'instance_binding',
  'device_history',
];

export function deleteAllFromTable(db: SqlExecutor, table: string): void {
  // 表名来自本模块常量白名单，不接受调用方输入。
  db.run(`DELETE FROM ${table}`);
}
