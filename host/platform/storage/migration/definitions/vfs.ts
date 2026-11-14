/**
 * 自动移植自 `src-tauri/crates/dstu-storage/src/migration/vfs.rs`（迁移验证契约，纯数据）。
 * 标识符与 Rust 常量同名；`file` 为相对 `resources/app/migrations` 的路径。
 */
import type { MigrationDefSpec } from '../definitions.ts';

export const VFS_V20260201_SYNC_INDEXES: readonly string[] = [
  'idx_resources_local_version',
  'idx_resources_device_id',
  'idx_resources_device_version',
  'idx_resources_updated_not_deleted',
  'idx_notes_local_version',
  'idx_notes_deleted_at_sync',
  'idx_notes_device_id',
  'idx_notes_device_version',
  'idx_notes_updated_not_deleted',
  'idx_questions_local_version',
  'idx_questions_device_id',
  'idx_questions_device_version',
  'idx_questions_updated_not_deleted',
  'idx_review_plans_local_version',
  'idx_review_plans_deleted_at',
  'idx_review_plans_device_id',
  'idx_review_plans_device_version',
  'idx_review_plans_updated_not_deleted',
  'idx_folders_local_version',
  'idx_folders_device_id',
  'idx_folders_device_version',
  'idx_folders_updated_not_deleted',
];

export const VFS_V001_TABLES: readonly string[] = [
  'resources',
  'blobs',
  'notes',
  'files',
  'exam_sheets',
  'translations',
  'essays',
  'essay_sessions',
  'folders',
  'folder_items',
  'path_cache',
  'mindmaps',
  'questions',
  'question_history',
  'question_bank_stats',
  'review_plans',
  'review_history',
  'review_stats',
  'question_sync_conflicts',
  'question_sync_logs',
  'memory_config',
  'vfs_indexing_config',
  'vfs_index_units',
  'vfs_index_segments',
  'vfs_embedding_dims',
];

export const VFS_V001_SMOKE_QUERIES: readonly string[] = [
  'SELECT 1 FROM questions_fts LIMIT 0',
  'SELECT 1 FROM trash_view LIMIT 0',
];

export const VFS_V001_KEY_INDEXES: readonly string[] = [
  'idx_resources_hash',
  'idx_resources_type',
  'idx_resources_source',
  'idx_resources_index_state',
  'idx_notes_resource',
  'idx_notes_deleted',
  'idx_files_sha256',
  'idx_files_resource',
  'idx_files_blob',
  'idx_files_deleted_at',
  'idx_exam_sheets_resource',
  'idx_exam_sheets_status',
  'idx_translations_resource',
  'idx_essays_resource',
  'idx_essays_session',
  'idx_folders_parent',
  'idx_folder_items_folder',
  'idx_folder_items_type_id',
  'idx_questions_exam_id',
  'idx_questions_status',
  'idx_questions_sync_status',
  'idx_review_plans_exam_id',
  'idx_review_plans_next_review',
  'idx_vfs_index_units_resource',
  'idx_vfs_index_units_text_state',
  'idx_vfs_index_segments_unit',
  'idx_vfs_embedding_dims_table',
];

export const VFS_ALL_TABLE_NAMES: readonly string[] = [
  'resources',
  'notes',
  'note_document_revisions',
  'note_document_formats',
  'note_transfer_operations',
  'note_state',
  'note_learning_relations',
  'note_history_retention',
  'note_review_save_operations',
  'note_review_save_receipts',
  'note_editor_participants',
  'note_editor_leases',
  'note_editor_lease_notes',
  'note_editor_lease_acks',
  'note_editor_write_grants',
  'files',
  'exam_sheets',
  'translations',
  'essays',
  'essay_sessions',
  'blobs',
  'folders',
  'folder_items',
  'path_cache',
  'mindmaps',
  'mindmap_versions',
  'questions',
  'question_history',
  'question_bank_stats',
  'review_plans',
  'review_history',
  'review_stats',
  'question_sync_conflicts',
  'question_sync_logs',
  'memory_config',
  'memory_audit_log',
  'memory_write_idempotency',
  'vfs_indexing_config',
  'vfs_index_units',
  'vfs_index_segments',
  'vfs_embedding_dims',
  'vfs_index_profiles',
  'answer_submissions',
  'todo_lists',
  'todo_items',
  'automation_todo_deliveries',
  'pomodoro_records',
  'mastery_events',
  'mastery_states',
  'note_tags',
  'note_links',
  'media_transcript_segments',
  'media_progress',
  'study_time_daily',
  'qbank_sources',
  'qbank_materials',
  'qbank_groups',
  'qbank_group_materials',
  'qbank_import_jobs',
  'qbank_papers',
  'qbank_practice_drafts',
  'qbank_practice_attempts',
  'qbank_practice_jobs',
  'vfs_study_space_profiles',
  'vfs_space_mounts',
  'vfs_anchor_edges',
  '__blob_deletion_queue',
  '__asset_deletion_queue',
  '__file_deletion_journal',
  '__lance_orphan_queue',
  'questions_fts',
  'notes_fts',
];

export const VFS_VIEW_NAMES: readonly string[] = [
  'trash_view',
];

export const V20260130_INIT: MigrationDefSpec = {
  refineryVersion: 20260130,
  name: 'init',
  file: 'vfs/V20260130__init.sql',
  expectedTables: VFS_V001_TABLES,
  expectedIndexes: VFS_V001_KEY_INDEXES,
  expectedQueries: VFS_V001_SMOKE_QUERIES,
  idempotent: true,
};

export const V20260131_CHANGE_LOG: MigrationDefSpec = {
  refineryVersion: 20260131,
  name: 'add_change_log',
  file: 'vfs/V20260131__add_change_log.sql',
  expectedTables: ['__change_log'],
  idempotent: true,
};

export const V20260201_SYNC_FIELDS: MigrationDefSpec = {
  refineryVersion: 20260201,
  name: 'add_sync_fields',
  file: 'vfs/V20260201__add_sync_fields.sql',
  expectedIndexes: VFS_V20260201_SYNC_INDEXES,
  idempotent: true,
};

export const V20260202_ADD_SEGMENTS_FK: MigrationDefSpec = {
  refineryVersion: 20260202,
  name: 'add_segments_fk',
  file: 'vfs/V20260202__add_segments_fk.sql',
  idempotent: true,
};

export const V20260203_SCHEMA_REPAIR: MigrationDefSpec = {
  refineryVersion: 20260203,
  name: 'schema_repair',
  file: 'vfs/V20260203__schema_repair.sql',
  idempotent: true,
};

export const V20260204_PDF_PROCESSING_STATUS: MigrationDefSpec = {
  refineryVersion: 20260204,
  name: 'add_pdf_processing_status',
  file: 'vfs/V20260204__add_pdf_processing_status.sql',
};

export const V20260205_ADD_COMPRESSED_BLOB_HASH: MigrationDefSpec = {
  refineryVersion: 20260205,
  name: 'add_compressed_blob_hash',
  file: 'vfs/V20260205__add_compressed_blob_hash.sql',
};

export const V20260206_REPAIR_INDEX_SEGMENTS_UNIT: MigrationDefSpec = {
  refineryVersion: 20260206,
  name: 'repair_vfs_index_segments_unit',
  file: 'vfs/V20260206__repair_vfs_index_segments_unit.sql',
  idempotent: true,
};

export const V20260207_UNIFY_DELETED_AT_TYPE: MigrationDefSpec = {
  refineryVersion: 20260207,
  name: 'unify_deleted_at_type',
  file: 'vfs/V20260207__unify_deleted_at_type.sql',
};

export const V20260208_ADD_QUESTIONS_LAST_ATTEMPT_DATE_INDEX: MigrationDefSpec = {
  refineryVersion: 20260208,
  name: 'add_questions_last_attempt_date_index',
  file: 'vfs/V20260208__add_questions_last_attempt_date_index.sql',
  expectedIndexes: ['idx_questions_last_attempt_date', 'idx_questions_last_attempt_at'],
  idempotent: true,
};

export const V20260209_ADD_QUESTIONS_IMAGES: MigrationDefSpec = {
  refineryVersion: 20260209,
  name: 'add_questions_images',
  file: 'vfs/V20260209__add_questions_images.sql',
};

export const V20260210_ADD_ANSWER_SUBMISSIONS: MigrationDefSpec = {
  refineryVersion: 20260210,
  name: 'add_answer_submissions',
  file: 'vfs/V20260210__add_answer_submissions.sql',
  expectedTables: ['answer_submissions'],
  expectedIndexes: ['idx_submissions_question'],
};

export const V20260211_FIX_CHANGE_LOG_RECORD_ID: MigrationDefSpec = {
  refineryVersion: 20260211,
  name: 'fix_change_log_record_id',
  file: 'vfs/V20260211__fix_change_log_record_id.sql',
  idempotent: true,
};

export const V20260212_ADD_MINDMAP_VERSIONS: MigrationDefSpec = {
  refineryVersion: 20260212,
  name: 'add_mindmap_versions',
  file: 'vfs/V20260212__add_mindmap_versions.sql',
  expectedTables: ['mindmap_versions'],
  expectedIndexes: ['idx_mindmap_versions_mindmap', 'idx_mindmap_versions_resource', 'idx_mindmap_versions_created'],
  idempotent: true,
};

export const V20260213_ADD_INDEX_STATUS_PERF_INDEXES: MigrationDefSpec = {
  refineryVersion: 20260213,
  name: 'add_index_status_perf_indexes',
  file: 'vfs/V20260213__add_index_status_perf_indexes.sql',
  expectedIndexes: ['idx_resources_source_id'],
  idempotent: true,
};

export const V20260214_DROP_NOTES_VERSIONS: MigrationDefSpec = {
  refineryVersion: 20260214,
  name: 'drop_notes_versions',
  file: 'vfs/V20260214__drop_notes_versions.sql',
};

export const V20260215_ADD_IMPORT_CHECKPOINT: MigrationDefSpec = {
  refineryVersion: 20260215,
  name: 'add_import_checkpoint',
  file: 'vfs/V20260215__add_import_checkpoint.sql',
  idempotent: true,
};

export const V20260227_ADD_MEMORY_AUDIT_LOG: MigrationDefSpec = {
  refineryVersion: 20260227,
  name: 'add_memory_audit_log',
  file: 'vfs/V20260227__add_memory_audit_log.sql',
  expectedTables: ['memory_audit_log'],
  expectedIndexes: ['idx_memory_audit_log_timestamp', 'idx_memory_audit_log_source', 'idx_memory_audit_log_operation', 'idx_memory_audit_log_note_id'],
  idempotent: true,
};

export const V20260302_NORMALIZE_FOLDER_ITEMS_TIMESTAMPS: MigrationDefSpec = {
  refineryVersion: 20260302,
  name: 'normalize_folder_items_timestamps',
  file: 'vfs/V20260302__normalize_folder_items_timestamps.sql',
  idempotent: true,
};

export const V20260303_ADD_MEMORY_WRITE_IDEMPOTENCY: MigrationDefSpec = {
  refineryVersion: 20260303,
  name: 'add_memory_write_idempotency',
  file: 'vfs/V20260303__add_memory_write_idempotency.sql',
  expectedTables: ['memory_write_idempotency'],
  expectedIndexes: ['idx_memory_write_idempotency_created_at'],
  idempotent: true,
};

export const V20260304_HARDEN_MEMORY_FOLDER_ITEMS_AND_AUDIT_INDEXES: MigrationDefSpec = {
  refineryVersion: 20260304,
  name: 'harden_memory_folder_items_and_audit_indexes',
  file: 'vfs/V20260304__harden_memory_folder_items_and_audit_indexes.sql',
  expectedIndexes: ['idx_folder_items_note_active_unique', 'idx_folder_items_note_folder_sort_active', 'idx_folder_items_note_lifecycle', 'idx_memory_audit_log_source_operation_success_id_desc', 'idx_memory_audit_log_operation_id_desc'],
  idempotent: true,
};

export const V20260305_ADD_ANSWER_SUBMISSION_IDEMPOTENCY: MigrationDefSpec = {
  refineryVersion: 20260305,
  name: 'add_answer_submission_idempotency',
  file: 'vfs/V20260305__add_answer_submission_idempotency.sql',
  expectedColumns: [['answer_submissions', 'client_request_id']],
  expectedIndexes: ['idx_submissions_question_request_id'],
};

export const V20260306_CANONICALIZE_FOLDER_ITEM_MOUNTS: MigrationDefSpec = {
  refineryVersion: 20260306,
  name: 'canonicalize_folder_item_mounts',
  file: 'vfs/V20260306__canonicalize_folder_item_mounts.sql',
  expectedIndexes: ['idx_folder_items_item_active_unique'],
  idempotent: true,
};

export const V20260308_ADD_TODO_TABLES: MigrationDefSpec = {
  refineryVersion: 20260308,
  name: 'add_todo_tables',
  file: 'vfs/V20260308__add_todo_tables.sql',
  expectedTables: ['todo_lists', 'todo_items'],
  expectedIndexes: ['idx_todo_lists_deleted', 'idx_todo_lists_favorite', 'idx_todo_lists_updated', 'idx_todo_lists_default', 'idx_todo_items_list', 'idx_todo_items_status', 'idx_todo_items_priority', 'idx_todo_items_due_date', 'idx_todo_items_parent', 'idx_todo_items_deleted', 'idx_todo_items_updated', 'idx_todo_items_list_status'],
  idempotent: true,
};

export const V20260309_DECOUPLE_TODO_FROM_VFS: MigrationDefSpec = {
  refineryVersion: 20260309,
  name: 'decouple_todo_from_vfs',
  file: 'vfs/V20260309__decouple_todo_from_vfs.sql',
  expectedColumns: [['todo_lists', 'id'], ['todo_lists', 'title'], ['todo_lists', 'updated_at']],
};

export const V20260310_ADD_POMODORO: MigrationDefSpec = {
  refineryVersion: 20260310,
  name: 'add_pomodoro',
  file: 'vfs/V20260310__add_pomodoro.sql',
  expectedTables: ['pomodoro_records'],
  expectedColumns: [['todo_items', 'estimated_pomodoros'], ['todo_items', 'completed_pomodoros']],
  expectedIndexes: ['idx_pomodoro_item', 'idx_pomodoro_type', 'idx_pomodoro_status', 'idx_pomodoro_created'],
};

export const V20260311_TODO_CONSTRAINTS: MigrationDefSpec = {
  refineryVersion: 20260311,
  name: 'todo_constraints',
  file: 'vfs/V20260311__todo_constraints.sql',
  idempotent: true,
};

export const V20260312_ADD_BLOB_DELETION_QUEUE: MigrationDefSpec = {
  refineryVersion: 20260312,
  name: 'add_blob_deletion_queue',
  file: 'vfs/V20260312__add_blob_deletion_queue.sql',
  expectedTables: ['__blob_deletion_queue'],
  expectedIndexes: ['idx__blob_deletion_queue_retry'],
  idempotent: true,
};

export const V20260523_ADD_MISSING_SYNC_COVERAGE: MigrationDefSpec = {
  refineryVersion: 20260523,
  name: 'add_missing_sync_coverage',
  file: 'vfs/V20260523__add_missing_sync_coverage.sql',
};

export const V20260524_ADD_CHANGE_LOG_FIELD_DELTAS: MigrationDefSpec = {
  refineryVersion: 20260524,
  name: 'add_change_log_field_deltas',
  file: 'vfs/V20260524__add_change_log_field_deltas.sql',
};

export const V20260525_REPAIR_LEGACY_QUESTIONS_CHANGE_LOG_RECORD_IDS: MigrationDefSpec = {
  refineryVersion: 20260525,
  name: 'repair_legacy_questions_change_log_record_ids',
  file: 'vfs/V20260525__repair_legacy_questions_change_log_record_ids.sql',
};

export const V20260526_ADD_BLOB_METADATA_SYNC: MigrationDefSpec = {
  refineryVersion: 20260526,
  name: 'add_blob_metadata_sync',
  file: 'vfs/V20260526__add_blob_metadata_sync.sql',
};

export const V20260527_ADD_ASSET_DELETION_QUEUE: MigrationDefSpec = {
  refineryVersion: 20260527,
  name: 'add_asset_deletion_queue',
  file: 'vfs/V20260527__add_asset_deletion_queue.sql',
  expectedTables: ['__asset_deletion_queue'],
  expectedIndexes: ['idx__asset_deletion_queue_retry'],
  idempotent: true,
};

export const V20260610_FIX_QUESTIONS_FTS_TRIGGERS: MigrationDefSpec = {
  refineryVersion: 20260610,
  name: 'fix_questions_fts_triggers',
  file: 'vfs/V20260610__fix_questions_fts_triggers.sql',
  idempotent: true,
};

export const V20260611_ADD_LANCE_ORPHAN_QUEUE: MigrationDefSpec = {
  refineryVersion: 20260611,
  name: 'add_lance_orphan_queue',
  file: 'vfs/V20260611__add_lance_orphan_queue.sql',
  expectedTables: ['__lance_orphan_queue'],
  expectedIndexes: ['idx__lance_orphan_queue_retry'],
  idempotent: true,
};

export const V20260612_TODO_INSERT_SELF_REF_CHECK: MigrationDefSpec = {
  refineryVersion: 20260612,
  name: 'todo_insert_self_ref_check',
  file: 'vfs/V20260612__todo_insert_self_ref_check.sql',
  idempotent: true,
};

export const V20260613_POMODORO_TIMESTAMPS_AND_CONSTRAINTS: MigrationDefSpec = {
  refineryVersion: 20260613,
  name: 'pomodoro_timestamps_and_constraints',
  file: 'vfs/V20260613__pomodoro_timestamps_and_constraints.sql',
  idempotent: true,
};

export const V20260614_TODO_PARENT_CHECK_SOFTDELETE_FIX: MigrationDefSpec = {
  refineryVersion: 20260614,
  name: 'todo_parent_check_softdelete_fix',
  file: 'vfs/V20260614__todo_parent_check_softdelete_fix.sql',
  idempotent: true,
};

export const V20260615_TODO_CYCLE_CHECK_FULL_GRAPH: MigrationDefSpec = {
  refineryVersion: 20260615,
  name: 'todo_cycle_check_full_graph',
  file: 'vfs/V20260615__todo_cycle_check_full_graph.sql',
  idempotent: true,
};

export const V20260714_ADD_VECTOR_INDEX_PROFILES: MigrationDefSpec = {
  refineryVersion: 20260714,
  name: 'add_vector_index_profiles',
  file: 'vfs/V20260714__add_vector_index_profiles.sql',
  expectedTables: ['vfs_index_profiles'],
  expectedColumns: [['vfs_index_profiles', 'id'], ['vfs_index_profiles', 'model_fingerprint'], ['vfs_index_profiles', 'model_config_id'], ['vfs_index_profiles', 'model_name'], ['vfs_index_profiles', 'dimension'], ['vfs_index_profiles', 'modality'], ['vfs_index_profiles', 'embedding_protocol'], ['vfs_index_profiles', 'schema_version'], ['vfs_index_profiles', 'lance_table_name'], ['vfs_index_profiles', 'active_generation'], ['vfs_index_profiles', 'state'], ['vfs_index_profiles', 'ann_metric'], ['vfs_index_profiles', 'ann_index_version'], ['vfs_index_profiles', 'created_at'], ['vfs_index_profiles', 'updated_at'], ['vfs_embedding_dims', 'active_profile_id'], ['vfs_embedding_dims', 'model_fingerprint'], ['vfs_embedding_dims', 'embedding_protocol'], ['vfs_embedding_dims', 'active_generation'], ['vfs_embedding_dims', 'ann_metric'], ['vfs_embedding_dims', 'ann_index_version'], ['vfs_index_segments', 'index_profile_id'], ['vfs_index_segments', 'generation'], ['vfs_index_units', 'text_profile_id'], ['vfs_index_units', 'text_generation'], ['vfs_index_units', 'mm_profile_id'], ['vfs_index_units', 'mm_generation'], ['resources', 'index_generation'], ['resources', 'mm_index_generation'], ['resources', 'index_next_retry_at'], ['resources', 'mm_index_next_retry_at'], ['__lance_orphan_queue', 'next_retry_at'], ['__lance_orphan_queue', 'last_error']],
  expectedIndexes: ['idx_vfs_index_profiles_route', 'idx_vfs_index_profiles_model', 'idx_vfs_index_segments_profile_generation', 'idx_vfs_index_units_text_profile', 'idx_vfs_index_units_mm_profile', 'idx_resources_index_retry_due', 'idx_resources_mm_index_retry_due', 'idx_lance_orphan_retry_due'],
};

export const V20260715_AUTOMATION_TODO_DELIVERY_RECEIPTS: MigrationDefSpec = {
  refineryVersion: 20260715,
  name: 'automation_todo_delivery_receipts',
  file: 'vfs/V20260715__automation_todo_delivery_receipts.sql',
  expectedTables: ['automation_todo_deliveries'],
  expectedIndexes: ['idx_automation_todo_deliveries_item'],
  idempotent: true,
};

export const V20260718_ADD_MASTERY_TABLES: MigrationDefSpec = {
  refineryVersion: 20260718,
  name: 'add_mastery_tables',
  file: 'vfs/V20260718__add_mastery_tables.sql',
  expectedTables: ['mastery_events', 'mastery_states'],
  expectedColumns: [['mastery_events', 'id'], ['mastery_events', 'created_at'], ['mastery_events', 'source'], ['mastery_events', 'concept_key'], ['mastery_events', 'item_id'], ['mastery_events', 'outcome'], ['mastery_events', 'weight'], ['mastery_states', 'concept_key'], ['mastery_states', 'score'], ['mastery_states', 'streak'], ['mastery_states', 'total'], ['mastery_states', 'wrong_count'], ['mastery_states', 'last_signal_at']],
  expectedIndexes: ['idx_mastery_events_concept_time', 'idx_mastery_events_item_time', 'idx_mastery_states_score'],
  idempotent: true,
};

export const V20260719_MASTERY_EVENTS_SIGNAL: MigrationDefSpec = {
  refineryVersion: 20260719,
  name: 'mastery_events_signal',
  file: 'vfs/V20260719__mastery_events_signal.sql',
  expectedColumns: [['mastery_events', 'signal']],
  idempotent: true,
};

export const V20260720_MASTERY_EVENTS_SYNC: MigrationDefSpec = {
  refineryVersion: 20260720,
  name: 'mastery_events_sync',
  file: 'vfs/V20260720__mastery_events_sync.sql',
  expectedColumns: [['mastery_events', 'device_id'], ['mastery_events', 'local_version'], ['mastery_events', 'updated_at'], ['mastery_events', 'deleted_at']],
  expectedIndexes: ['idx_mastery_events_local_version', 'idx_mastery_events_updated_at', 'idx_mastery_events_device_version'],
  expectedQueries: ['SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg__change_log_mastery_events_insert\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg__change_log_mastery_events_update\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg__change_log_mastery_events_delete\''],
  idempotent: true,
};

export const V20260721_POMODORO_BACKFILL_UPDATED_AT: MigrationDefSpec = {
  refineryVersion: 20260721,
  name: 'pomodoro_backfill_updated_at',
  file: 'vfs/V20260721__pomodoro_backfill_updated_at.sql',
  expectedQueries: ['SELECT 1 FROM pomodoro_records WHERE updated_at IS NULL AND created_at IS NOT NULL LIMIT 0'],
  idempotent: true,
};

export const V20260722_NOTE_TAGS: MigrationDefSpec = {
  refineryVersion: 20260722,
  name: 'note_tags',
  file: 'vfs/V20260722__note_tags.sql',
  expectedTables: ['note_tags'],
  expectedIndexes: ['idx_note_tags_tag'],
  expectedQueries: ['SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_note_tags_insert\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_note_tags_update\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_note_tags_delete\''],
  idempotent: true,
};

export const V20260723_TRANSLATION_SOFT_DELETE_REPAIR_AND_INDEXES: MigrationDefSpec = {
  refineryVersion: 20260723,
  name: 'translation_soft_delete_repair_and_indexes',
  file: 'vfs/V20260723__translation_soft_delete_repair_and_indexes.sql',
  expectedIndexes: ['idx_translations_created_alive', 'idx_folder_items_translation_folder_sort_active'],
  idempotent: true,
};

export const V20260724_NOTES_FTS: MigrationDefSpec = {
  refineryVersion: 20260724,
  name: 'notes_fts',
  file: 'vfs/V20260724__notes_fts.sql',
  expectedTables: ['notes_fts'],
  expectedQueries: ['SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_notes_fts_insert\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_notes_fts_update\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_notes_fts_delete\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_notes_fts_resource_insert\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_notes_fts_resource_data_update\''],
  idempotent: true,
};

export const V20260725_NOTE_LINKS: MigrationDefSpec = {
  refineryVersion: 20260725,
  name: 'note_links',
  file: 'vfs/V20260725__note_links.sql',
  expectedTables: ['note_links'],
  expectedIndexes: ['idx_note_links_target_id', 'idx_note_links_unresolved', 'idx_notes_title_nocase'],
  expectedQueries: ['SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_note_links_on_note_delete\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_note_links_resolve_on_insert\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_note_links_resolve_on_update\''],
  idempotent: true,
};

export const V20260726_MINDMAP_CONTENT_UPDATED_AT: MigrationDefSpec = {
  refineryVersion: 20260726,
  name: 'mindmap_content_updated_at',
  file: 'vfs/V20260726__mindmap_content_updated_at.sql',
  expectedColumns: [['mindmaps', 'content_updated_at']],
  expectedQueries: ['SELECT 1 FROM mindmaps WHERE content_updated_at IS NULL AND updated_at IS NOT NULL LIMIT 0'],
  idempotent: true,
};

export const V20260727_TODO_COMPLETED_AT_INDEX: MigrationDefSpec = {
  refineryVersion: 20260727,
  name: 'todo_completed_at_index',
  file: 'vfs/V20260727__todo_completed_at_index.sql',
  expectedIndexes: ['idx_todo_items_completed_at'],
  idempotent: true,
};

export const V20260728_TODO_REMINDER_INDEX_AND_LIST_SORT: MigrationDefSpec = {
  refineryVersion: 20260728,
  name: 'todo_reminder_index_and_list_sort',
  file: 'vfs/V20260728__todo_reminder_index_and_list_sort.sql',
  expectedIndexes: ['idx_todo_items_reminder', 'idx_todo_items_list_parent_sort'],
  idempotent: true,
};

export const V20260801_TODO_POMODORO_STATS_INDEXES: MigrationDefSpec = {
  refineryVersion: 20260801,
  name: 'todo_pomodoro_stats_indexes',
  file: 'vfs/V20260801__todo_pomodoro_stats_indexes.sql',
  expectedIndexes: ['idx_todo_items_status_due', 'idx_pomodoro_records_work_created', 'idx_pomodoro_records_item_created'],
  idempotent: true,
};

export const V20260806_MINDMAP_VERSIONS_LOOKUP_INDEX: MigrationDefSpec = {
  refineryVersion: 20260806,
  name: 'mindmap_versions_lookup_index',
  file: 'vfs/V20260806__mindmap_versions_lookup_index.sql',
  expectedIndexes: ['idx_mindmap_versions_mindmap_created'],
  idempotent: true,
};

export const V20260807_QUESTION_STRUCTURED_DATA: MigrationDefSpec = {
  refineryVersion: 20260807,
  name: 'question_structured_data',
  file: 'vfs/V20260807__question_structured_data.sql',
  expectedColumns: [['questions', 'structured_data']],
};

export const V20260808_FILE_DELETION_INTENT_JOURNAL: MigrationDefSpec = {
  refineryVersion: 20260808,
  name: 'file_deletion_intent_journal',
  file: 'vfs/V20260808__file_deletion_intent_journal.sql',
  expectedTables: ['__file_deletion_journal'],
  expectedColumns: [['__file_deletion_journal', 'operation_id'], ['__file_deletion_journal', 'target_kind'], ['__file_deletion_journal', 'entity_key'], ['__file_deletion_journal', 'local_path'], ['__file_deletion_journal', 'expected_hash'], ['__file_deletion_journal', 'state'], ['__file_deletion_journal', 'prepared_at'], ['__file_deletion_journal', 'ready_at'], ['__file_deletion_journal', 'published_at']],
  expectedIndexes: ['idx__file_deletion_journal_recovery', 'idx__file_deletion_journal_target'],
  expectedQueries: ['SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg__blob_deletion_queue_published\'', 'SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg__asset_deletion_queue_published\''],
  idempotent: true,
};

export const V20260824_NOTE_PROPS: MigrationDefSpec = {
  refineryVersion: 20260824,
  name: 'note_props',
  file: 'vfs/V20260824__note_props.sql',
  expectedColumns: [['notes', 'props']],
};

export const V20260907_INSIGHT_CARDS: MigrationDefSpec = {
  refineryVersion: 20260907,
  name: 'insight_cards',
  file: 'vfs/V20260907__insight_cards.sql',
  expectedTables: ['insights', 'insight_revisions', 'insight_evidence', 'insight_relations', 'insight_events'],
  expectedColumns: [['insights', 'ownership'], ['insights', 'verification_state'], ['insight_revisions', 'stuck_point'], ['insight_revisions', 'turning_point'], ['insight_revisions', 'validity_conditions'], ['insight_evidence', 'quote_snapshot'], ['insight_relations', 'relation_type'], ['insight_events', 'event_type'], ['insight_events', 'help_level']],
  idempotent: true,
};

export const V20260908_INSIGHT_FTS: MigrationDefSpec = {
  refineryVersion: 20260908,
  name: 'insight_fts',
  file: 'vfs/V20260908__insight_fts.sql',
  expectedTables: ['insight_fts'],
  idempotent: true,
};

export const V20260909_MASTERY_EVENTS_INSIGHT_SOURCE: MigrationDefSpec = {
  refineryVersion: 20260909,
  name: 'mastery_events_insight_source',
  file: 'vfs/V20260909__mastery_events_insight_source.sql',
  expectedTables: ['mastery_events'],
  expectedColumns: [['mastery_events', 'signal'], ['mastery_events', 'device_id'], ['mastery_events', 'local_version'], ['mastery_events', 'deleted_at']],
  idempotent: true,
};

export const V20260910_INSIGHT_JOBS: MigrationDefSpec = {
  refineryVersion: 20260910,
  name: 'insight_jobs',
  file: 'vfs/V20260910__insight_jobs.sql',
  expectedTables: ['insight_jobs'],
  expectedColumns: [['insight_jobs', 'dedupe_key'], ['insight_jobs', 'lease_owner'], ['insight_jobs', 'next_attempt_at'], ['insight_jobs', 'payload_json']],
  idempotent: true,
};

export const V20260911_INSIGHT_FTS_UPDATE_TRIGGER_NARROWING: MigrationDefSpec = {
  refineryVersion: 20260911,
  name: 'insight_fts_update_trigger_narrowing',
  file: 'vfs/V20260911__insight_fts_update_trigger_narrowing.sql',
  expectedTables: ['insight_fts'],
  idempotent: true,
};

export const V20260912_QBANK_GENERATION_TASKS: MigrationDefSpec = {
  refineryVersion: 20260912,
  name: 'qbank_generation_tasks',
  file: 'vfs/V20260912__qbank_generation_tasks.sql',
  expectedTables: ['qbank_generation_tasks'],
  expectedIndexes: ['idx_qbank_generation_tasks_exam', 'idx_qbank_generation_tasks_status'],
  idempotent: true,
};

export const V20260921_NOTE_DOCUMENT_REVISIONS: MigrationDefSpec = {
  refineryVersion: 20260921,
  name: 'note_document_revisions',
  file: 'vfs/V20260921__note_document_revisions.sql',
  expectedTables: ['note_document_revisions'],
  expectedIndexes: ['idx_note_revisions_timeline'],
  idempotent: true,
};

export const V20260922_NOTE_STORAGE_FOUNDATIONS: MigrationDefSpec = {
  refineryVersion: 20260922,
  name: 'note_storage_foundations',
  file: 'vfs/V20260922__note_storage_foundations.sql',
  expectedTables: ['note_document_formats', 'note_transfer_operations', 'note_state', 'note_learning_relations'],
  expectedIndexes: ['idx_note_learning_relations_note', 'idx_note_learning_relations_resource'],
  idempotent: true,
};

export const V20260923_NOTE_HISTORY_INTEGRATION: MigrationDefSpec = {
  refineryVersion: 20260923,
  name: 'note_history_integration',
  file: 'vfs/V20260923__note_history_integration.sql',
  expectedTables: ['note_history_retention', 'note_review_save_operations', 'note_review_save_receipts'],
  expectedQueries: ['SELECT edit_bucket_seconds, max_edit_versions FROM note_history_retention WHERE id=1', 'SELECT version_id FROM note_document_revisions LIMIT 0'],
  idempotent: true,
};

export const V20260924_NOTE_EDITOR_LEASES: MigrationDefSpec = {
  refineryVersion: 20260924,
  name: 'note_editor_leases',
  file: 'vfs/V20260924__note_editor_leases.sql',
  expectedTables: ['note_editor_participants', 'note_editor_leases', 'note_editor_lease_notes', 'note_editor_lease_acks', 'note_editor_write_grants'],
  idempotent: true,
};

export const V20261005_MEDIA_TRANSCRIPTS: MigrationDefSpec = {
  refineryVersion: 20261005,
  name: 'media_transcripts',
  file: 'vfs/V20261005__media_transcripts.sql',
  expectedTables: ['media_transcript_segments', 'media_progress'],
  expectedIndexes: ['idx_media_segments_status'],
  idempotent: true,
};

export const V20261006_STUDY_TIME: MigrationDefSpec = {
  refineryVersion: 20261006,
  name: 'study_time',
  file: 'vfs/V20261006__study_time.sql',
  expectedTables: ['study_time_daily'],
  idempotent: true,
};

export const V20261023_QUESTION_AUTHORING_V2: MigrationDefSpec = {
  refineryVersion: 20261023,
  name: 'question_authoring_v2',
  file: 'vfs/V20261023__question_authoring_v2.sql',
  expectedTables: ['qbank_sources', 'qbank_materials', 'qbank_groups', 'qbank_group_materials', 'qbank_import_jobs'],
  expectedColumns: [['questions', 'group_id'], ['questions', 'group_position'], ['questions', 'source_key'], ['questions', 'provenance_json'], ['questions', 'answer_origin'], ['questions', 'deletion_batch'], ['exam_sheets', 'deletion_batch'], ['answer_submissions', 'question_snapshot_json'], ['answer_submissions', 'material_snapshot_json']],
};

export const V20261027_PRACTICE_SESSIONS: MigrationDefSpec = {
  refineryVersion: 20261027,
  name: 'practice_sessions',
  file: 'vfs/V20261027__practice_sessions.sql',
  expectedTables: ['qbank_papers', 'qbank_practice_drafts', 'qbank_practice_attempts', 'qbank_practice_jobs'],
  idempotent: true,
};

export const V20261111_STUDY_SPACE_PROFILES_AND_MOUNTS: MigrationDefSpec = {
  refineryVersion: 20261111,
  name: 'study_space_profiles_and_mounts',
  file: 'vfs/V20261111__study_space_profiles_and_mounts.sql',
  expectedTables: ['vfs_study_space_profiles', 'vfs_space_mounts', 'vfs_anchor_edges'],
  expectedIndexes: [
    'idx_vfs_study_space_profiles_root_folder',
    'idx_vfs_space_mounts_active_unique',
    'idx_vfs_anchor_edges_target',
    'idx_vfs_anchor_edges_source',
  ],
  idempotent: true,
};

export const VFS_MIGRATIONS: readonly MigrationDefSpec[] = [
  V20260130_INIT,
  V20260131_CHANGE_LOG,
  V20260201_SYNC_FIELDS,
  V20260202_ADD_SEGMENTS_FK,
  V20260203_SCHEMA_REPAIR,
  V20260204_PDF_PROCESSING_STATUS,
  V20260205_ADD_COMPRESSED_BLOB_HASH,
  V20260206_REPAIR_INDEX_SEGMENTS_UNIT,
  V20260207_UNIFY_DELETED_AT_TYPE,
  V20260208_ADD_QUESTIONS_LAST_ATTEMPT_DATE_INDEX,
  V20260209_ADD_QUESTIONS_IMAGES,
  V20260210_ADD_ANSWER_SUBMISSIONS,
  V20260211_FIX_CHANGE_LOG_RECORD_ID,
  V20260212_ADD_MINDMAP_VERSIONS,
  V20260213_ADD_INDEX_STATUS_PERF_INDEXES,
  V20260214_DROP_NOTES_VERSIONS,
  V20260215_ADD_IMPORT_CHECKPOINT,
  V20260227_ADD_MEMORY_AUDIT_LOG,
  V20260302_NORMALIZE_FOLDER_ITEMS_TIMESTAMPS,
  V20260303_ADD_MEMORY_WRITE_IDEMPOTENCY,
  V20260304_HARDEN_MEMORY_FOLDER_ITEMS_AND_AUDIT_INDEXES,
  V20260305_ADD_ANSWER_SUBMISSION_IDEMPOTENCY,
  V20260306_CANONICALIZE_FOLDER_ITEM_MOUNTS,
  V20260308_ADD_TODO_TABLES,
  V20260309_DECOUPLE_TODO_FROM_VFS,
  V20260310_ADD_POMODORO,
  V20260311_TODO_CONSTRAINTS,
  V20260312_ADD_BLOB_DELETION_QUEUE,
  V20260523_ADD_MISSING_SYNC_COVERAGE,
  V20260524_ADD_CHANGE_LOG_FIELD_DELTAS,
  V20260525_REPAIR_LEGACY_QUESTIONS_CHANGE_LOG_RECORD_IDS,
  V20260526_ADD_BLOB_METADATA_SYNC,
  V20260527_ADD_ASSET_DELETION_QUEUE,
  V20260610_FIX_QUESTIONS_FTS_TRIGGERS,
  V20260611_ADD_LANCE_ORPHAN_QUEUE,
  V20260612_TODO_INSERT_SELF_REF_CHECK,
  V20260613_POMODORO_TIMESTAMPS_AND_CONSTRAINTS,
  V20260614_TODO_PARENT_CHECK_SOFTDELETE_FIX,
  V20260615_TODO_CYCLE_CHECK_FULL_GRAPH,
  V20260714_ADD_VECTOR_INDEX_PROFILES,
  V20260715_AUTOMATION_TODO_DELIVERY_RECEIPTS,
  V20260718_ADD_MASTERY_TABLES,
  V20260719_MASTERY_EVENTS_SIGNAL,
  V20260720_MASTERY_EVENTS_SYNC,
  V20260721_POMODORO_BACKFILL_UPDATED_AT,
  V20260722_NOTE_TAGS,
  V20260723_TRANSLATION_SOFT_DELETE_REPAIR_AND_INDEXES,
  V20260724_NOTES_FTS,
  V20260725_NOTE_LINKS,
  V20260726_MINDMAP_CONTENT_UPDATED_AT,
  V20260727_TODO_COMPLETED_AT_INDEX,
  V20260728_TODO_REMINDER_INDEX_AND_LIST_SORT,
  V20260801_TODO_POMODORO_STATS_INDEXES,
  V20260806_MINDMAP_VERSIONS_LOOKUP_INDEX,
  V20260807_QUESTION_STRUCTURED_DATA,
  V20260808_FILE_DELETION_INTENT_JOURNAL,
  V20260824_NOTE_PROPS,
  V20260907_INSIGHT_CARDS,
  V20260908_INSIGHT_FTS,
  V20260909_MASTERY_EVENTS_INSIGHT_SOURCE,
  V20260910_INSIGHT_JOBS,
  V20260911_INSIGHT_FTS_UPDATE_TRIGGER_NARROWING,
  V20260912_QBANK_GENERATION_TASKS,
  V20260921_NOTE_DOCUMENT_REVISIONS,
  V20260922_NOTE_STORAGE_FOUNDATIONS,
  V20260923_NOTE_HISTORY_INTEGRATION,
  V20260924_NOTE_EDITOR_LEASES,
  V20261005_MEDIA_TRANSCRIPTS,
  V20261006_STUDY_TIME,
  V20261023_QUESTION_AUTHORING_V2,
  V20261027_PRACTICE_SESSIONS,
  V20261111_STUDY_SPACE_PROFILES_AND_MOUNTS,
];

export const VFS_SCHEMA_VERSION: number = VFS_MIGRATIONS[VFS_MIGRATIONS.length - 1]!.refineryVersion;

export const VFS_TABLE_COUNT = 70;

export const VFS_VIEW_COUNT = 1;

export const VFS_FTS_TABLE_COUNT = 2;
