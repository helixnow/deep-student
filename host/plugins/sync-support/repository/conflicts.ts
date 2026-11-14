/**
 * `conflict_resolver.rs` 的 SQL：冲突表结构（含老库升级）、去重索引与写入。
 */
import { defineQuery } from '../../../platform/storage/query.ts';
import { tableInfoCount } from './pragma.ts';

/** `ensure_conflict_table` 的建表 + 普通索引（幂等）。 */
export const CREATE_CONFLICT_TABLE = `
  CREATE TABLE IF NOT EXISTS __sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('local','cloud')),
      data_json TEXT NOT NULL,
      data_hash TEXT NOT NULL DEFAULT '',
      winning_device_id TEXT,
      losing_device_id TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolution TEXT
  );
  CREATE INDEX IF NOT EXISTS idx__sync_conflicts_unresolved
      ON __sync_conflicts(resolved_at) WHERE resolved_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx__sync_conflicts_record
      ON __sync_conflicts(table_name, record_id);
`;

/** 老库升级：`ALTER TABLE ADD COLUMN` 失败静默（列已存在）。 */
export const ADD_CONFLICT_DATA_HASH =
  "ALTER TABLE __sync_conflicts ADD COLUMN data_hash TEXT NOT NULL DEFAULT ''";

/** 部分唯一索引：未解决冲突按 (table, record, side, data_hash) 去重。 */
export const CREATE_CONFLICT_DEDUP_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx__sync_conflicts_dedup
      ON __sync_conflicts(table_name, record_id, side, data_hash)
      WHERE resolved_at IS NULL;
`;

export const selectConflictDataHashColumn = tableInfoCount;

export const hasUnsyncedChange = defineQuery<[string, string], { count: number | bigint }>(
  `SELECT COUNT(*) AS count FROM __change_log
   WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0`,
  { name: 'syncSupport.conflicts.hasUnsyncedChange' },
);

export const insertConflictRecord = defineQuery<
  [string, string, string, string, string, string | null, string | null],
  void
>(
  `INSERT INTO __sync_conflicts
   (table_name, record_id, side, data_json, data_hash, winning_device_id, losing_device_id)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
   ON CONFLICT(table_name, record_id, side, data_hash) WHERE resolved_at IS NULL
   DO NOTHING`,
  { name: 'syncSupport.conflicts.insert' },
);
