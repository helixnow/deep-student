/**
 * 自动移植自 `src-tauri/crates/dstu-storage/src/migration/llm_usage.rs`（迁移验证契约，纯数据）。
 * 标识符与 Rust 常量同名；`file` 为相对 `resources/app/migrations` 的路径。
 */
import type { MigrationDefSpec } from '../definitions.ts';

export const V001_EXPECTED_TABLES: readonly string[] = [
  'llm_usage_logs',
  'llm_usage_daily',
];

export const V001_EXPECTED_INDEXES: readonly string[] = [
  'idx_llm_usage_logs_timestamp',
  'idx_llm_usage_logs_date_key',
  'idx_llm_usage_logs_hour_key',
  'idx_llm_usage_logs_caller_type',
  'idx_llm_usage_logs_model',
  'idx_llm_usage_logs_provider',
  'idx_llm_usage_logs_status',
  'idx_llm_usage_logs_session_id',
  'idx_llm_usage_logs_api_config_id',
  'idx_llm_usage_logs_date_caller',
  'idx_llm_usage_logs_date_model',
  'idx_llm_usage_logs_date_provider',
  'idx_llm_usage_logs_date_status',
  'idx_llm_usage_daily_date',
  'idx_llm_usage_daily_caller_type',
  'idx_llm_usage_daily_model',
  'idx_llm_usage_daily_provider',
];

export const V001_EXPECTED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['llm_usage_logs', 'id'],
  ['llm_usage_logs', 'timestamp'],
  ['llm_usage_logs', 'provider'],
  ['llm_usage_logs', 'model'],
  ['llm_usage_logs', 'prompt_tokens'],
  ['llm_usage_logs', 'completion_tokens'],
  ['llm_usage_logs', 'total_tokens'],
  ['llm_usage_logs', 'caller_type'],
  ['llm_usage_logs', 'status'],
  ['llm_usage_daily', 'date'],
  ['llm_usage_daily', 'caller_type'],
  ['llm_usage_daily', 'model'],
  ['llm_usage_daily', 'provider'],
  ['llm_usage_daily', 'request_count'],
  ['llm_usage_daily', 'total_tokens'],
];

export const LLM_USAGE_V20260201_SYNC_INDEXES: readonly string[] = [
  'idx_llm_usage_logs_local_version',
  'idx_llm_usage_logs_deleted_at',
  'idx_llm_usage_logs_device_id',
  'idx_llm_usage_logs_updated_at',
  'idx_llm_usage_logs_device_version',
  'idx_llm_usage_logs_updated_not_deleted',
  'idx_llm_usage_daily_local_version',
  'idx_llm_usage_daily_deleted_at',
  'idx_llm_usage_daily_device_id',
  'idx_llm_usage_daily_updated_at',
  'idx_llm_usage_daily_device_version',
  'idx_llm_usage_daily_updated_not_deleted',
];

export const LLM_USAGE_ALL_TABLE_NAMES: readonly string[] = [
  'llm_usage_logs',
  'llm_usage_daily',
];

export const V20260130_INIT: MigrationDefSpec = {
  refineryVersion: 20260130,
  name: 'init',
  file: 'llm_usage/V20260130__init.sql',
  expectedTables: V001_EXPECTED_TABLES,
  expectedColumns: V001_EXPECTED_COLUMNS,
  expectedIndexes: V001_EXPECTED_INDEXES,
  idempotent: true,
};

export const V20260131_CHANGE_LOG: MigrationDefSpec = {
  refineryVersion: 20260131,
  name: 'add_change_log',
  file: 'llm_usage/V20260131__add_change_log.sql',
  expectedTables: ['__change_log'],
  idempotent: true,
};

export const V20260201_SYNC_FIELDS: MigrationDefSpec = {
  refineryVersion: 20260201,
  name: 'add_sync_fields',
  file: 'llm_usage/V20260201__add_sync_fields.sql',
  expectedIndexes: LLM_USAGE_V20260201_SYNC_INDEXES,
  idempotent: true,
};

export const V20260202_FIX_CHANGE_LOG_RECORD_ID: MigrationDefSpec = {
  refineryVersion: 20260202,
  name: 'fix_change_log_record_id',
  file: 'llm_usage/V20260202__fix_change_log_record_id.sql',
  idempotent: true,
};

export const V20260524_ADD_CHANGE_LOG_FIELD_DELTAS: MigrationDefSpec = {
  refineryVersion: 20260524,
  name: 'add_change_log_field_deltas',
  file: 'llm_usage/V20260524__add_change_log_field_deltas.sql',
};

export const V20260525_DROP_DAILY_CHANGE_LOG_TRIGGERS: MigrationDefSpec = {
  refineryVersion: 20260525,
  name: 'drop_daily_change_log_triggers',
  file: 'llm_usage/V20260525__drop_daily_change_log_triggers.sql',
  idempotent: true,
};

export const V20260824_ADD_CACHE_WRITE_TOKENS: MigrationDefSpec = {
  refineryVersion: 20260824,
  name: 'add_cache_write_tokens',
  file: 'llm_usage/V20260824__add_cache_write_tokens.sql',
  expectedColumns: [['llm_usage_logs', 'cache_write_tokens']],
};

export const V20260826_ADD_STREAM_IDENTITY: MigrationDefSpec = {
  refineryVersion: 20260826,
  name: 'add_stream_identity',
  file: 'llm_usage/V20260826__add_stream_identity.sql',
  expectedColumns: [['llm_usage_logs', 'variant_id'], ['llm_usage_logs', 'run_id']],
  expectedIndexes: ['idx_llm_usage_logs_variant_id', 'idx_llm_usage_logs_run_id'],
};

export const LLM_USAGE_MIGRATIONS: readonly MigrationDefSpec[] = [
  V20260130_INIT,
  V20260131_CHANGE_LOG,
  V20260201_SYNC_FIELDS,
  V20260202_FIX_CHANGE_LOG_RECORD_ID,
  V20260524_ADD_CHANGE_LOG_FIELD_DELTAS,
  V20260525_DROP_DAILY_CHANGE_LOG_TRIGGERS,
  V20260824_ADD_CACHE_WRITE_TOKENS,
  V20260826_ADD_STREAM_IDENTITY,
];

export const LLM_USAGE_TABLE_COUNT = 2;
