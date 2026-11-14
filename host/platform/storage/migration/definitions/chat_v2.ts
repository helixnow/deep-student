/**
 * 自动移植自 `src-tauri/crates/dstu-storage/src/migration/chat_v2.rs`（迁移验证契约，纯数据）。
 * 标识符与 Rust 常量同名；`file` 为相对 `resources/app/migrations` 的路径。
 */
import type { MigrationDefSpec } from '../definitions.ts';

export const V001_EXPECTED_TABLES: readonly string[] = [
  'chat_v2_sessions',
  'chat_v2_messages',
  'chat_v2_blocks',
  'chat_v2_attachments',
  'chat_v2_session_state',
  'chat_v2_session_mistakes',
  'resources',
  'chat_v2_todo_lists',
  'workspace_index',
  'sleep_block',
  'subagent_task',
];

export const V001_EXPECTED_INDEXES: readonly string[] = [
  'idx_chat_v2_sessions_mode',
  'idx_chat_v2_sessions_persist_status',
  'idx_chat_v2_sessions_created_at',
  'idx_chat_v2_sessions_updated_at',
  'idx_sessions_workspace',
  'idx_chat_v2_messages_session_id',
  'idx_chat_v2_messages_timestamp',
  'idx_chat_v2_messages_role',
  'idx_chat_v2_messages_parent_id',
  'idx_chat_v2_messages_active_variant_id',
  'idx_chat_v2_messages_session_timestamp',
  'idx_chat_v2_messages_session_id_id',
  'idx_chat_v2_blocks_message_id',
  'idx_chat_v2_blocks_block_type',
  'idx_chat_v2_blocks_status',
  'idx_chat_v2_blocks_order',
  'idx_chat_v2_blocks_variant_id',
  'idx_chat_v2_blocks_first_chunk_at',
  'idx_chat_v2_attachments_message_id',
  'idx_chat_v2_attachments_type',
  'idx_chat_v2_attachments_status',
  'idx_chat_v2_attachments_block_id',
  'idx_chat_v2_session_mistakes_mistake',
  'idx_chat_v2_session_mistakes_type',
  'idx_resources_hash',
  'idx_resources_source_id',
  'idx_resources_type',
  'idx_resources_ref_count',
  'idx_resources_created_at',
  'idx_chat_v2_todo_lists_message_id',
  'idx_chat_v2_todo_lists_is_all_done',
  'idx_workspace_index_status',
  'idx_workspace_index_creator',
  'idx_sleep_block_status',
  'idx_sleep_block_workspace',
  'idx_sleep_block_coordinator',
  'idx_subagent_task_status',
  'idx_subagent_task_recovery',
];

export const V001_EXPECTED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['chat_v2_sessions', 'id'],
  ['chat_v2_sessions', 'mode'],
  ['chat_v2_sessions', 'persist_status'],
  ['chat_v2_sessions', 'workspace_id'],
  ['chat_v2_messages', 'id'],
  ['chat_v2_messages', 'session_id'],
  ['chat_v2_messages', 'role'],
  ['chat_v2_messages', 'active_variant_id'],
  ['chat_v2_messages', 'variants_json'],
  ['chat_v2_blocks', 'id'],
  ['chat_v2_blocks', 'message_id'],
  ['chat_v2_blocks', 'block_type'],
  ['chat_v2_blocks', 'variant_id'],
  ['chat_v2_blocks', 'first_chunk_at'],
  ['chat_v2_attachments', 'id'],
  ['chat_v2_attachments', 'message_id'],
  ['chat_v2_attachments', 'block_id'],
  ['chat_v2_session_state', 'session_id'],
  ['chat_v2_session_state', 'model_id'],
  ['chat_v2_session_state', 'loaded_skill_ids_json'],
  ['chat_v2_session_state', 'active_skill_id'],
  ['chat_v2_session_mistakes', 'session_id'],
  ['chat_v2_session_mistakes', 'mistake_id'],
  ['resources', 'id'],
  ['resources', 'hash'],
  ['resources', 'type'],
  ['chat_v2_todo_lists', 'session_id'],
  ['chat_v2_todo_lists', 'todo_list_id'],
  ['workspace_index', 'workspace_id'],
  ['workspace_index', 'creator_session_id'],
  ['sleep_block', 'id'],
  ['sleep_block', 'workspace_id'],
  ['sleep_block', 'coordinator_session_id'],
  ['subagent_task', 'id'],
  ['subagent_task', 'workspace_id'],
  ['subagent_task', 'agent_session_id'],
];

export const CHAT_V2_V20260201_SYNC_INDEXES: readonly string[] = [
  'idx_chat_v2_sessions_local_version',
  'idx_chat_v2_sessions_deleted_at',
  'idx_chat_v2_sessions_device_id',
  'idx_chat_v2_sessions_sync_updated_at',
  'idx_chat_v2_sessions_device_version',
  'idx_chat_v2_sessions_updated_not_deleted',
  'idx_chat_v2_messages_local_version',
  'idx_chat_v2_messages_deleted_at',
  'idx_chat_v2_messages_device_id',
  'idx_chat_v2_messages_sync_updated_at',
  'idx_chat_v2_messages_device_version',
  'idx_chat_v2_messages_updated_not_deleted',
  'idx_chat_v2_blocks_local_version',
  'idx_chat_v2_blocks_deleted_at',
  'idx_chat_v2_blocks_device_id',
  'idx_chat_v2_blocks_sync_updated_at',
  'idx_chat_v2_blocks_device_version',
  'idx_chat_v2_blocks_updated_not_deleted',
];

export const V20260130_INIT: MigrationDefSpec = {
  refineryVersion: 20260130,
  name: 'init',
  file: 'chat_v2/V20260130__init.sql',
  expectedTables: V001_EXPECTED_TABLES,
  expectedColumns: V001_EXPECTED_COLUMNS,
  expectedIndexes: V001_EXPECTED_INDEXES,
  idempotent: true,
};

export const V20260131_CHANGE_LOG: MigrationDefSpec = {
  refineryVersion: 20260131,
  name: 'add_change_log',
  file: 'chat_v2/V20260131__add_change_log.sql',
  expectedTables: ['__change_log'],
  idempotent: true,
};

export const V20260201_SYNC_FIELDS: MigrationDefSpec = {
  refineryVersion: 20260201,
  name: 'add_sync_fields',
  file: 'chat_v2/V20260201__add_sync_fields.sql',
  expectedIndexes: CHAT_V2_V20260201_SYNC_INDEXES,
  idempotent: true,
};

export const V20260202_SCHEMA_REPAIR: MigrationDefSpec = {
  refineryVersion: 20260202,
  name: 'schema_repair',
  file: 'chat_v2/V20260202__schema_repair.sql',
  expectedTables: ['sleep_block'],
  expectedIndexes: ['idx_sleep_block_status', 'idx_sleep_block_workspace', 'idx_sleep_block_coordinator'],
  idempotent: true,
};

export const V20260203_ENSURE_SUBAGENT_TASK: MigrationDefSpec = {
  refineryVersion: 20260203,
  name: 'ensure_subagent_task',
  file: 'chat_v2/V20260203__ensure_subagent_task.sql',
  expectedTables: ['subagent_task'],
  expectedIndexes: ['idx_subagent_task_status', 'idx_subagent_task_recovery'],
  idempotent: true,
};

export const V20260204_SESSION_GROUPS: MigrationDefSpec = {
  refineryVersion: 20260204,
  name: 'session_groups',
  file: 'chat_v2/V20260204__session_groups.sql',
  expectedTables: ['chat_v2_session_groups'],
  expectedIndexes: ['idx_chat_v2_session_groups_sort_order', 'idx_chat_v2_session_groups_status', 'idx_chat_v2_session_groups_workspace', 'idx_chat_v2_sessions_group_id'],
  idempotent: true,
};

export const V20260207_ACTIVE_SKILL_IDS: MigrationDefSpec = {
  refineryVersion: 20260207,
  name: 'active_skill_ids_json',
  file: 'chat_v2/V20260207__add_active_skill_ids_json.sql',
  idempotent: true,
};

export const V20260221_GROUP_PINNED_RESOURCES: MigrationDefSpec = {
  refineryVersion: 20260221,
  name: 'group_pinned_resources',
  file: 'chat_v2/V20260221__group_pinned_resources.sql',
  idempotent: true,
};

export const V20260301_CONTENT_SEARCH_AND_TAGS: MigrationDefSpec = {
  refineryVersion: 20260301,
  name: 'content_search_and_tags',
  file: 'chat_v2/V20260301__content_search_and_tags.sql',
  expectedTables: ['chat_v2_content_fts', 'chat_v2_session_tags'],
  expectedIndexes: ['idx_session_tags_tag', 'idx_session_tags_type'],
  idempotent: true,
};

export const V20260302_SUBAGENT_TASK_SCHEMA_ALIGN: MigrationDefSpec = {
  refineryVersion: 20260302,
  name: 'subagent_task_schema_align',
  file: 'chat_v2/V20260302__subagent_task_schema_align.sql',
  expectedColumns: [['subagent_task', 'initial_task'], ['subagent_task', 'started_at'], ['subagent_task', 'completed_at'], ['subagent_task', 'result_summary']],
  expectedIndexes: ['idx_subagent_task_workspace'],
};

export const V20260306_SKILL_STATE_JSON: MigrationDefSpec = {
  refineryVersion: 20260306,
  name: 'skill_state_json',
  file: 'chat_v2/V20260306__add_skill_state_json.sql',
  expectedColumns: [['chat_v2_session_state', 'skill_state_json']],
  idempotent: true,
};

export const V20260502_ARCHIVE_LEGACY_DELETED_SESSIONS: MigrationDefSpec = {
  refineryVersion: 20260502,
  name: 'archive_legacy_deleted_sessions',
  file: 'chat_v2/V20260502__archive_legacy_deleted_sessions.sql',
  idempotent: true,
};

export const V20260510_ADD_COMPACTION: MigrationDefSpec = {
  refineryVersion: 20260510,
  name: 'add_compaction',
  file: 'chat_v2/V20260510__add_compaction.sql',
  expectedTables: ['chat_v2_compactions'],
  expectedColumns: [['chat_v2_blocks', 'compacted_at'], ['chat_v2_sessions', 'last_compaction_id']],
  expectedIndexes: ['idx_chat_v2_compactions_session_created'],
};

export const V20260516_ADD_TITLE_LOCKED: MigrationDefSpec = {
  refineryVersion: 20260516,
  name: 'add_title_locked',
  file: 'chat_v2/V20260516__add_title_locked.sql',
  expectedColumns: [['chat_v2_sessions', 'title_locked']],
  idempotent: true,
};

export const V20260523_ADD_MISSING_SYNC_COVERAGE: MigrationDefSpec = {
  refineryVersion: 20260523,
  name: 'add_missing_sync_coverage',
  file: 'chat_v2/V20260523__add_missing_sync_coverage.sql',
};

export const V20260524_ADD_CHANGE_LOG_FIELD_DELTAS: MigrationDefSpec = {
  refineryVersion: 20260524,
  name: 'add_change_log_field_deltas',
  file: 'chat_v2/V20260524__add_change_log_field_deltas.sql',
};

export const V20260527_ADD_WORKSPACE_DELETION_QUEUE: MigrationDefSpec = {
  refineryVersion: 20260527,
  name: 'add_workspace_deletion_queue',
  file: 'chat_v2/V20260527__add_workspace_deletion_queue.sql',
  expectedTables: ['__workspace_deletion_queue'],
  expectedIndexes: ['idx__workspace_deletion_queue_retry'],
  idempotent: true,
};

export const V20260528_RESOURCES_TYPE_CHECK_REBUILD: MigrationDefSpec = {
  refineryVersion: 20260528,
  name: 'resources_type_check_rebuild',
  file: 'chat_v2/V20260528__resources_type_check_rebuild.sql',
  expectedColumns: [['resources', 'type'], ['resources', 'device_id'], ['resources', 'deleted_at']],
  expectedIndexes: ['idx_resources_hash', 'idx_resources_type', 'idx_resources_local_version'],
  idempotent: true,
};

export const V20260711_SESSION_TAGS_SYNC_COVERAGE: MigrationDefSpec = {
  refineryVersion: 20260711,
  name: 'session_tags_sync_coverage',
  file: 'chat_v2/V20260711__session_tags_sync_coverage.sql',
  idempotent: true,
};

export const V20260717_GROUP_PREFERRED_RUNTIME_ROOT: MigrationDefSpec = {
  refineryVersion: 20260717,
  name: 'group_preferred_runtime_root',
  file: 'chat_v2/V20260717__group_preferred_runtime_root.sql',
  expectedColumns: [['chat_v2_session_groups', 'default_runtime_root_id'], ['chat_v2_session_groups', 'preferred_project_root_path']],
  idempotent: true,
};

export const V20260719_FTS_BLOCKTYPE_COVERAGE: MigrationDefSpec = {
  refineryVersion: 20260719,
  name: 'fts_blocktype_coverage_and_indexes',
  file: 'chat_v2/V20260719__fts_blocktype_coverage_and_indexes.sql',
  expectedIndexes: ['idx_chat_v2_sessions_status_updated'],
  idempotent: true,
};

export const V20260720_COMPACTION_LINEAGE_AND_SYNC: MigrationDefSpec = {
  refineryVersion: 20260720,
  name: 'compaction_lineage_and_sync',
  file: 'chat_v2/V20260720__compaction_lineage_and_sync.sql',
  expectedColumns: [['chat_v2_compactions', 'previous_compaction_id'], ['chat_v2_compactions', 'range_start_message_id'], ['chat_v2_compactions', 'range_end_message_id'], ['chat_v2_compactions', 'compacted_message_count'], ['chat_v2_compactions', 'model_config_id'], ['chat_v2_compactions', 'device_id'], ['chat_v2_compactions', 'local_version'], ['chat_v2_compactions', 'updated_at'], ['chat_v2_compactions', 'deleted_at']],
  expectedIndexes: ['idx_chat_v2_compactions_previous', 'idx_chat_v2_compactions_local_version', 'idx_chat_v2_compactions_device_version', 'idx_chat_v2_compactions_sync_updated_at', 'idx_chat_v2_compactions_updated_not_deleted'],
  idempotent: true,
};

export const V20260721_WORKSPACE_DELETION_INTENT_JOURNAL: MigrationDefSpec = {
  refineryVersion: 20260721,
  name: 'workspace_deletion_intent_journal',
  file: 'chat_v2/V20260721__workspace_deletion_intent_journal.sql',
  expectedTables: ['__file_deletion_journal'],
  expectedColumns: [['__file_deletion_journal', 'operation_id'], ['__file_deletion_journal', 'target_kind'], ['__file_deletion_journal', 'entity_key'], ['__file_deletion_journal', 'local_path'], ['__file_deletion_journal', 'expected_hash'], ['__file_deletion_journal', 'state'], ['__file_deletion_journal', 'prepared_at'], ['__file_deletion_journal', 'ready_at'], ['__file_deletion_journal', 'published_at']],
  expectedIndexes: ['idx__file_deletion_journal_recovery', 'idx__file_deletion_journal_target'],
  expectedQueries: ['SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg__workspace_deletion_queue_published\''],
  idempotent: true,
};

export const V20260806_PROMPT_CACHE_REPLAY_CONSISTENCY: MigrationDefSpec = {
  refineryVersion: 20260806,
  name: 'prompt_cache_replay_consistency',
  file: 'chat_v2/V20260806__prompt_cache_replay_consistency.sql',
  expectedTables: ['chat_v2_blocks'],
  expectedColumns: [['chat_v2_blocks', 'llm_content'], ['chat_v2_blocks', 'tool_call_id'], ['chat_v2_blocks', 'round_text']],
  expectedQueries: ['SELECT llm_content, tool_call_id, round_text FROM chat_v2_blocks LIMIT 0'],
  idempotent: true,
};

export const V20260905_GOAL_TABLE: MigrationDefSpec = {
  refineryVersion: 20260905,
  name: 'goal_table',
  file: 'chat_v2/V20260905__goal_table.sql',
  expectedTables: ['chat_v2_goals'],
  expectedColumns: [['chat_v2_goals', 'session_id'], ['chat_v2_goals', 'goal_id'], ['chat_v2_goals', 'objective'], ['chat_v2_goals', 'status'], ['chat_v2_goals', 'token_budget'], ['chat_v2_goals', 'tokens_used'], ['chat_v2_goals', 'time_used_seconds'], ['chat_v2_goals', 'continuation_count'], ['chat_v2_goals', 'created_at_ms'], ['chat_v2_goals', 'updated_at_ms']],
  expectedIndexes: ['idx_chat_v2_goals_status'],
  expectedQueries: ['SELECT goal_id, objective, status, token_budget, tokens_used, time_used_seconds, continuation_count, created_at_ms, updated_at_ms FROM chat_v2_goals LIMIT 0'],
  idempotent: true,
};

export const V20260907_CONNECTOR_OPERATIONS: MigrationDefSpec = {
  refineryVersion: 20260907,
  name: 'connector_operations',
  file: 'chat_v2/V20260907__connector_operations.sql',
  expectedTables: ['connector_operations'],
  expectedColumns: [['connector_operations', 'operation_id'], ['connector_operations', 'session_id'], ['connector_operations', 'provider_id'], ['connector_operations', 'action'], ['connector_operations', 'idempotency_key'], ['connector_operations', 'state']],
  expectedIndexes: ['idx_connector_operations_state', 'idx_connector_operations_idempotency'],
  idempotent: true,
};

export const V20260908_COMPLETION_OUTBOX: MigrationDefSpec = {
  refineryVersion: 20260908,
  name: 'completion_outbox',
  file: 'chat_v2/V20260908__completion_outbox.sql',
  expectedTables: ['completion_outbox'],
  expectedColumns: [['completion_outbox', 'delivery_id'], ['completion_outbox', 'run_id'], ['completion_outbox', 'target_session_id'], ['completion_outbox', 'state']],
  expectedIndexes: ['idx_completion_outbox_run', 'idx_completion_outbox_state'],
  idempotent: true,
};

export const V20260909_SKILL_USAGE_CANDIDATES: MigrationDefSpec = {
  refineryVersion: 20260909,
  name: 'skill_usage_candidates',
  file: 'chat_v2/V20260909__skill_usage_candidates.sql',
  expectedTables: ['skill_usage', 'skill_candidates'],
  expectedColumns: [['skill_usage', 'skill_id'], ['skill_usage', 'kind'], ['skill_usage', 'outcome'], ['skill_candidates', 'candidate_id'], ['skill_candidates', 'source_kind'], ['skill_candidates', 'status'], ['skill_candidates', 'trace_hash']],
  expectedIndexes: ['idx_skill_usage_run', 'idx_skill_candidates_trace_hash', 'idx_skill_candidates_status_created'],
  idempotent: true,
};

export const V20260910_REVOCATION_EPOCHS_AND_BUDGET: MigrationDefSpec = {
  refineryVersion: 20260910,
  name: 'revocation_epochs_and_budget',
  file: 'chat_v2/V20260910__revocation_epochs_and_budget.sql',
  expectedTables: ['revocation_epochs', 'budget_snapshots'],
  expectedColumns: [['revocation_epochs', 'kind'], ['revocation_epochs', 'task_id'], ['revocation_epochs', 'epoch'], ['revocation_epochs', 'updated_at'], ['budget_snapshots', 'root_id'], ['budget_snapshots', 'limits_json'], ['budget_snapshots', 'usage_json'], ['budget_snapshots', 'updated_at']],
  expectedQueries: ['SELECT kind, task_id, epoch, updated_at FROM revocation_epochs LIMIT 0', 'SELECT root_id, limits_json, usage_json, updated_at FROM budget_snapshots LIMIT 0'],
  idempotent: true,
};

export const V20261111_SESSION_GROUP_ROOT_FOLDER: MigrationDefSpec = {
  refineryVersion: 20261111,
  name: 'session_group_root_folder',
  file: 'chat_v2/V20261111__session_group_root_folder.sql',
  expectedColumns: [['chat_v2_session_groups', 'root_folder_id']],
  expectedIndexes: ['idx_session_groups_root_folder'],
};

export const CHAT_V2_MIGRATIONS: readonly MigrationDefSpec[] = [
  V20260130_INIT,
  V20260131_CHANGE_LOG,
  V20260201_SYNC_FIELDS,
  V20260202_SCHEMA_REPAIR,
  V20260203_ENSURE_SUBAGENT_TASK,
  V20260204_SESSION_GROUPS,
  V20260207_ACTIVE_SKILL_IDS,
  V20260221_GROUP_PINNED_RESOURCES,
  V20260301_CONTENT_SEARCH_AND_TAGS,
  V20260302_SUBAGENT_TASK_SCHEMA_ALIGN,
  V20260306_SKILL_STATE_JSON,
  V20260502_ARCHIVE_LEGACY_DELETED_SESSIONS,
  V20260510_ADD_COMPACTION,
  V20260516_ADD_TITLE_LOCKED,
  V20260523_ADD_MISSING_SYNC_COVERAGE,
  V20260524_ADD_CHANGE_LOG_FIELD_DELTAS,
  V20260527_ADD_WORKSPACE_DELETION_QUEUE,
  V20260528_RESOURCES_TYPE_CHECK_REBUILD,
  V20260711_SESSION_TAGS_SYNC_COVERAGE,
  V20260717_GROUP_PREFERRED_RUNTIME_ROOT,
  V20260719_FTS_BLOCKTYPE_COVERAGE,
  V20260720_COMPACTION_LINEAGE_AND_SYNC,
  V20260721_WORKSPACE_DELETION_INTENT_JOURNAL,
  V20260806_PROMPT_CACHE_REPLAY_CONSISTENCY,
  V20260905_GOAL_TABLE,
  V20260907_CONNECTOR_OPERATIONS,
  V20260908_COMPLETION_OUTBOX,
  V20260909_SKILL_USAGE_CANDIDATES,
  V20260910_REVOCATION_EPOCHS_AND_BUDGET,
  V20261111_SESSION_GROUP_ROOT_FOLDER,
];

export const CHAT_V2_SCHEMA_VERSION = 20261111;
