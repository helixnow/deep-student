/**
 * 自动移植自 `src-tauri/crates/dstu-storage/src/migration/mistakes.rs`（迁移验证契约，纯数据）。
 * 标识符与 Rust 常量同名；`file` 为相对 `resources/app/migrations` 的路径。
 */
import type { MigrationDefSpec } from '../definitions.ts';

export const MISTAKES_V20260201_SYNC_INDEXES: readonly string[] = [
  'idx_mistakes_local_version',
  'idx_mistakes_deleted_at',
  'idx_mistakes_device_id',
  'idx_mistakes_updated_at',
  'idx_mistakes_device_version',
  'idx_mistakes_updated_not_deleted',
  'idx_anki_cards_local_version',
  'idx_anki_cards_deleted_at',
  'idx_anki_cards_device_id',
  'idx_anki_cards_updated_at',
  'idx_anki_cards_device_version',
  'idx_anki_cards_updated_not_deleted',
  'idx_review_analyses_local_version',
  'idx_review_analyses_deleted_at',
  'idx_review_analyses_device_id',
  'idx_review_analyses_updated_at',
  'idx_review_analyses_device_version',
  'idx_review_analyses_updated_not_deleted',
];

export const MISTAKES_V20260208_HOT_INDEXES: readonly string[] = [
  'idx_document_tasks_updated_at',
  'idx_document_tasks_document_segment',
  'idx_anki_cards_created_at',
  'idx_anki_cards_template_id',
  'idx_anki_cards_task_order',
];

export const MISTAKES_V20260209_DEDUP_INDEXES: readonly string[] = [
  'idx_anki_cards_dedup_unique',
];

export const V001_EXPECTED_TABLES: readonly string[] = [
  'mistakes',
  'chat_messages',
  'temp_sessions',
  'review_analyses',
  'review_chat_messages',
  'review_sessions',
  'review_session_mistakes',
  'settings',
  'rag_configurations',
  'document_tasks',
  'anki_cards',
  'custom_anki_templates',
  'document_control_states',
  'vectorized_data',
  'rag_sub_libraries',
  'search_logs',
  'exam_sheet_sessions',
  'migration_progress',
];

export const V001_EXPECTED_INDEXES: readonly string[] = [
  'idx_mistakes_irec_card_id',
  'idx_chat_turn_id',
  'idx_chat_turn_pair',
  'idx_document_tasks_document_id',
  'idx_document_tasks_status',
  'idx_anki_cards_task_id',
  'idx_anki_cards_is_error_card',
  'idx_anki_cards_source',
  'idx_anki_cards_text',
  'idx_custom_anki_templates_is_active',
  'idx_custom_anki_templates_is_built_in',
  'idx_document_control_states_state',
  'idx_document_control_states_updated_at',
  'idx_vectorized_data_mistake_id',
  'idx_review_session_mistakes_session_id',
  'idx_review_session_mistakes_mistake_id',
  'idx_search_logs_created_at',
  'idx_search_logs_search_type',
  'idx_exam_sheet_sessions_status',
];

export const V001_SMOKE_QUERIES: readonly string[] = [
  'SELECT id, mistake_summary, user_error_analysis FROM mistakes LIMIT 1',
  'SELECT id, graph_sources, turn_id, turn_seq, reply_to_msg_id, message_kind, lifecycle, metadata FROM chat_messages LIMIT 1',
  'SELECT id, web_search_sources, tool_call, tool_result, overrides, relations FROM review_chat_messages LIMIT 1',
  'SELECT id FROM review_sessions LIMIT 1',
  'SELECT id, text FROM anki_cards LIMIT 1',
];

export const KEY_COLUMNS_VERIFICATION: ReadonlyArray<readonly [string, string]> = [
  ['mistakes', 'id'],
  ['mistakes', 'created_at'],
  ['mistakes', 'question_images'],
  ['mistakes', 'status'],
  ['mistakes', 'irec_card_id'],
  ['mistakes', 'irec_status'],
  ['chat_messages', 'id'],
  ['chat_messages', 'mistake_id'],
  ['chat_messages', 'role'],
  ['chat_messages', 'content'],
  ['chat_messages', 'turn_id'],
  ['chat_messages', 'stable_id'],
  ['review_analyses', 'id'],
  ['review_analyses', 'mistake_ids'],
  ['review_analyses', 'status'],
  ['anki_cards', 'id'],
  ['anki_cards', 'task_id'],
  ['anki_cards', 'front'],
  ['anki_cards', 'back'],
  ['anki_cards', 'text'],
  ['anki_cards', 'source_type'],
  ['anki_cards', 'source_id'],
  ['document_tasks', 'id'],
  ['document_tasks', 'document_id'],
  ['document_tasks', 'status'],
];

export const V20260130_INIT: MigrationDefSpec = {
  refineryVersion: 20260130,
  name: 'init',
  file: 'mistakes/V20260130__init.sql',
  expectedTables: V001_EXPECTED_TABLES,
  expectedColumns: KEY_COLUMNS_VERIFICATION,
  expectedIndexes: V001_EXPECTED_INDEXES,
  expectedQueries: V001_SMOKE_QUERIES,
  idempotent: true,
};

export const V20260131_CHANGE_LOG: MigrationDefSpec = {
  refineryVersion: 20260131,
  name: 'add_change_log',
  file: 'mistakes/V20260131__add_change_log.sql',
  expectedTables: ['__change_log'],
  idempotent: true,
};

export const V20260201_SYNC_FIELDS: MigrationDefSpec = {
  refineryVersion: 20260201,
  name: 'add_sync_fields',
  file: 'mistakes/V20260201__add_sync_fields.sql',
  expectedIndexes: MISTAKES_V20260201_SYNC_INDEXES,
  idempotent: true,
};

export const V20260207_TEMPLATE_PREVIEW_DATA: MigrationDefSpec = {
  refineryVersion: 20260207,
  name: 'add_template_preview_data',
  file: 'mistakes/V20260207__add_template_preview_data.sql',
  idempotent: true,
};

export const V20260208_HOT_QUERY_INDEXES: MigrationDefSpec = {
  refineryVersion: 20260208,
  name: 'add_hot_query_indexes',
  file: 'mistakes/V20260208__add_hot_query_indexes.sql',
  expectedIndexes: MISTAKES_V20260208_HOT_INDEXES,
  idempotent: true,
};

export const V20260209_ANKI_CARD_DEDUP_UNIQUE: MigrationDefSpec = {
  refineryVersion: 20260209,
  name: 'anki_card_dedup_unique',
  file: 'mistakes/V20260209__anki_card_dedup_unique.sql',
  expectedIndexes: MISTAKES_V20260209_DEDUP_INDEXES,
  idempotent: true,
};

export const V20260523_ADD_MISSING_SYNC_COVERAGE: MigrationDefSpec = {
  refineryVersion: 20260523,
  name: 'add_missing_sync_coverage',
  file: 'mistakes/V20260523__add_missing_sync_coverage.sql',
  idempotent: true,
};

export const V20260524_ADD_CHANGE_LOG_FIELD_DELTAS: MigrationDefSpec = {
  refineryVersion: 20260524,
  name: 'add_change_log_field_deltas',
  file: 'mistakes/V20260524__add_change_log_field_deltas.sql',
  idempotent: true,
};

export const V20260705_ADD_DOCUMENT_TASKS_SOURCE_SESSION_ID: MigrationDefSpec = {
  refineryVersion: 20260705,
  name: 'add_document_tasks_source_session_id',
  file: 'mistakes/V20260705__add_document_tasks_source_session_id.sql',
  expectedColumns: [['document_tasks', 'source_session_id']],
  idempotent: true,
};

export const V20260709_FLASHCARD_FSRS: MigrationDefSpec = {
  refineryVersion: 20260709,
  name: 'flashcard_fsrs',
  file: 'mistakes/V20260709__flashcard_fsrs.sql',
  expectedTables: ['anki_decks', 'fsrs_card_states', 'fsrs_review_logs'],
  expectedIndexes: ['idx_fsrs_due', 'idx_fsrs_logs_card'],
  idempotent: true,
};

export const V20260710_ANKI_EXPORT_RECEIPT: MigrationDefSpec = {
  refineryVersion: 20260710,
  name: 'anki_export_receipt',
  file: 'mistakes/V20260710__anki_export_receipt.sql',
  expectedColumns: [['anki_cards', 'anki_note_id'], ['anki_cards', 'export_status'], ['anki_cards', 'last_exported_at'], ['anki_cards', 'content_hash']],
  idempotent: true,
};

export const V20260711_FSRS_SYNC_COVERAGE: MigrationDefSpec = {
  refineryVersion: 20260711,
  name: 'fsrs_sync_coverage',
  file: 'mistakes/V20260711__fsrs_sync_coverage.sql',
  expectedColumns: [['fsrs_card_states', 'device_id'], ['fsrs_card_states', 'local_version'], ['fsrs_card_states', 'deleted_at'], ['fsrs_review_logs', 'created_at'], ['fsrs_review_logs', 'updated_at'], ['fsrs_review_logs', 'device_id'], ['fsrs_review_logs', 'local_version'], ['fsrs_review_logs', 'deleted_at']],
  expectedIndexes: ['idx_anki_decks_device_version', 'idx_fsrs_card_states_device_version', 'idx_fsrs_review_logs_device_version'],
  idempotent: true,
};

export const V20260712_FSRS_UNDO_SNAPSHOT: MigrationDefSpec = {
  refineryVersion: 20260712,
  name: 'fsrs_undo_snapshot',
  file: 'mistakes/V20260712__fsrs_undo_snapshot.sql',
  expectedColumns: [['fsrs_review_logs', 'state_before_json']],
  expectedIndexes: ['idx_fsrs_logs_state_active'],
  idempotent: true,
};

export const V20260713_APKG_CARD_IDENTITY: MigrationDefSpec = {
  refineryVersion: 20260713,
  name: 'apkg_card_identity',
  file: 'mistakes/V20260713__apkg_card_identity.sql',
  expectedIndexes: MISTAKES_V20260209_DEDUP_INDEXES,
  idempotent: true,
};

export const V20260714_AUTOMATION_SCHEDULER: MigrationDefSpec = {
  refineryVersion: 20260714,
  name: 'automation_scheduler',
  file: 'mistakes/V20260714__automation_scheduler.sql',
  expectedTables: ['automation_definitions', 'automation_runs'],
  expectedIndexes: ['idx_automation_definitions_enabled_next', 'idx_automation_definitions_updated', 'idx_automation_runs_automation_created', 'idx_automation_runs_retry_due', 'idx_automation_runs_status_updated'],
  idempotent: true,
};

export const V20260715_HARDEN_AUTOMATION_RUNTIME: MigrationDefSpec = {
  refineryVersion: 20260715,
  name: 'harden_automation_runtime',
  file: 'mistakes/V20260715__harden_automation_runtime.sql',
  expectedColumns: [['automation_runs', 'lease_expires_at'], ['automation_runs', 'retry_requested']],
  expectedIndexes: ['idx_automation_runs_owner_lease'],
  idempotent: true,
};

export const V20260721_TRUSTED_AUTOMATION_PROFILE: MigrationDefSpec = {
  refineryVersion: 20260721,
  name: 'trusted_automation_profile',
  file: 'mistakes/V20260721__trusted_automation_profile.sql',
  expectedColumns: [['automation_definitions', 'trusted_profile_json']],
  idempotent: true,
};

export const V20260722_FSRS_SCHEDULER_HARDENING: MigrationDefSpec = {
  refineryVersion: 20260722,
  name: 'fsrs_scheduler_hardening',
  file: 'mistakes/V20260722__fsrs_scheduler_hardening.sql',
  expectedColumns: [['fsrs_card_states', 'leech'], ['fsrs_card_states', 'buried_until_ms']],
  expectedIndexes: ['idx_fsrs_logs_review_ms'],
  idempotent: true,
};

export const V20260723_TEMPLATE_USER_STATE: MigrationDefSpec = {
  refineryVersion: 20260723,
  name: 'template_user_state',
  file: 'mistakes/V20260723__template_user_state.sql',
  expectedColumns: [['custom_anki_templates', 'user_modified'], ['custom_anki_templates', 'user_deleted']],
  expectedIndexes: ['idx_custom_anki_templates_user_deleted'],
  idempotent: true,
};

export const V20260724_ANKI_DEDUP_INDEX_EXCLUDE_DELETED: MigrationDefSpec = {
  refineryVersion: 20260724,
  name: 'anki_dedup_index_exclude_deleted',
  file: 'mistakes/V20260724__anki_dedup_index_exclude_deleted.sql',
  expectedIndexes: MISTAKES_V20260209_DEDUP_INDEXES,
  idempotent: true,
};

export const V20260824_NORMALIZE_ANKI_CARD_OPTIONAL_JSON: MigrationDefSpec = {
  refineryVersion: 20260824,
  name: 'normalize_anki_card_optional_json',
  file: 'mistakes/V20260824__normalize_anki_card_optional_json.sql',
  idempotent: true,
};

export const V20261005_FSRS_LEARNING_STEP: MigrationDefSpec = {
  refineryVersion: 20261005,
  name: 'fsrs_learning_step',
  file: 'mistakes/V20261005__fsrs_learning_step.sql',
  expectedColumns: [['fsrs_card_states', 'learning_step']],
  idempotent: true,
};

export const V20260720_FSRS_MASTERY_OUTBOX: MigrationDefSpec = {
  refineryVersion: 20260720,
  name: 'fsrs_mastery_outbox',
  file: 'mistakes/V20260720__fsrs_mastery_outbox.sql',
  expectedColumns: [['fsrs_review_logs', 'mastery_synced_at'], ['fsrs_review_logs', 'mastery_revert_pending']],
  expectedIndexes: ['idx_fsrs_review_logs_mastery_pending'],
  idempotent: true,
};

/** Rust `MISTAKES_MIGRATIONS` 的迁移列表（Rust 中内联在 MigrationSet 里）。 */
export const MISTAKES_MIGRATIONS_LIST: readonly MigrationDefSpec[] = [
  V20260130_INIT,
  V20260131_CHANGE_LOG,
  V20260201_SYNC_FIELDS,
  V20260207_TEMPLATE_PREVIEW_DATA,
  V20260208_HOT_QUERY_INDEXES,
  V20260209_ANKI_CARD_DEDUP_UNIQUE,
  V20260523_ADD_MISSING_SYNC_COVERAGE,
  V20260524_ADD_CHANGE_LOG_FIELD_DELTAS,
  V20260705_ADD_DOCUMENT_TASKS_SOURCE_SESSION_ID,
  V20260709_FLASHCARD_FSRS,
  V20260710_ANKI_EXPORT_RECEIPT,
  V20260711_FSRS_SYNC_COVERAGE,
  V20260712_FSRS_UNDO_SNAPSHOT,
  V20260713_APKG_CARD_IDENTITY,
  V20260714_AUTOMATION_SCHEDULER,
  V20260715_HARDEN_AUTOMATION_RUNTIME,
  V20260720_FSRS_MASTERY_OUTBOX,
  V20260721_TRUSTED_AUTOMATION_PROFILE,
  V20260722_FSRS_SCHEDULER_HARDENING,
  V20260723_TEMPLATE_USER_STATE,
  V20260724_ANKI_DEDUP_INDEX_EXCLUDE_DELETED,
  V20260824_NORMALIZE_ANKI_CARD_OPTIONAL_JSON,
  V20261005_FSRS_LEARNING_STEP,
];
