use serde::{Deserialize, Serialize};

/// Sync classification for every table in every database
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncCategory {
    /// Row-level incremental sync via __change_log + COALESCE UPSERT
    RowSync,
    /// File-level sync (content-addressed blobs, workspace .db files)
    FileSync,
    /// Derived/cached data, fully rebuildable from RowSync tables
    DerivedRebuild,
    /// Transient runtime state (streaming sessions, locks, sleep states)
    LocalRuntime,
    /// Backup-only (exported in ZIP backups but not incrementally synced)
    BackupOnly,
    /// No longer in use, kept for migration compatibility
    Deprecated,
}

/// Classification entry for one table
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableClassification {
    pub database: &'static str,
    pub table_name: &'static str,
    pub primary_key: &'static str,
    pub category: SyncCategory,
    pub conflict_policy: ConflictPolicyClass,
    /// Comma-separated business unique keys (beyond PK)
    pub business_unique_keys: &'static str,
    /// Whether this table has JSON blob columns needing field-level merge
    pub has_json_blobs: bool,
    /// Special merge notes
    pub merge_notes: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum ConflictPolicyClass {
    Lww,
    FieldMerge,
    CounterMerge,
    SetUnion,
    DeleteWins,
    NoConflict,
}

/// The master sync classification registry.
/// Returns classifications for ALL tables across ALL 4 databases.
pub fn sync_classification_registry() -> Vec<TableClassification> {
    vec![
        // ========== VFS database ==========
        // --- RowSync tables ---
        TableClassification { database: "vfs", table_name: "resources", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::CounterMerge, business_unique_keys: "hash", has_json_blobs: true, merge_notes: "ref_count uses CRDT counter merge; metadata_json field-level merge" },
        TableClassification { database: "vfs", table_name: "notes", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: false, merge_notes: "tags field uses set union" },
        TableClassification { database: "vfs", table_name: "files", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "sha256,content_hash", has_json_blobs: true, merge_notes: "sha256/content_hash conflict = duplicate file, merge via content dedup; bookmarks_json/tags_json/preview_json field-level merge" },
        TableClassification { database: "vfs", table_name: "exam_sheets", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "metadata_json/preview_json field-level merge; sync_config for exam-specific sync settings" },
        TableClassification { database: "vfs", table_name: "translations", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: true, merge_notes: "metadata_json field-level merge" },
        TableClassification { database: "vfs", table_name: "essays", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "grading_result_json/dimension_scores_json field-level merge" },
        TableClassification { database: "vfs", table_name: "essay_sessions", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: false, merge_notes: "Essay writing sessions tracking rounds/scores across devices" },
        TableClassification { database: "vfs", table_name: "mindmaps", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "settings JSON field-level merge" },
        TableClassification { database: "vfs", table_name: "folders", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: false, merge_notes: "Self-referencing parent_id FK" },
        TableClassification { database: "vfs", table_name: "folder_items", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "folder_id,item_type,item_id", has_json_blobs: false, merge_notes: "Junction table; unique on (folder_id,item_type,item_id)" },
        TableClassification { database: "vfs", table_name: "questions", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "options_json/tags/images_json field-level merge; attempt_count/correct_count = max merge; user_note concatenation" },
        TableClassification { database: "vfs", table_name: "answer_submissions", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "question_id,client_request_id", has_json_blobs: false, merge_notes: "Idempotency via client_request_id UNIQUE" },
        TableClassification { database: "vfs", table_name: "review_plans", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "question_id", has_json_blobs: false, merge_notes: "question_id UNIQUE conflict = same question, merge SM-2 stats: ease_factor avg, interval_days max, total_reviews sum" },
        TableClassification { database: "vfs", table_name: "todo_lists", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: false, merge_notes: "User todo lists with sort_order/is_default" },
        TableClassification { database: "vfs", table_name: "todo_items", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "estimated_pomodoros/completed_pomodoros sum; tags_json field-level merge" },

        TableClassification { database: "vfs", table_name: "pomodoro_records", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: false, merge_notes: "Focus session records linked to todo items" },
        // --- FileSync ---
        TableClassification { database: "vfs", table_name: "blobs", primary_key: "hash", category: SyncCategory::FileSync, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Content-addressed file sync; ref_count is derived" },
        // --- DerivedRebuild ---
        TableClassification { database: "vfs", table_name: "path_cache", primary_key: "item_type,item_id", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Fully rebuildable from folders + folder_items" },
        TableClassification { database: "vfs", table_name: "question_bank_stats", primary_key: "exam_id", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Computed from questions table" },
        TableClassification { database: "vfs", table_name: "review_stats", primary_key: "exam_id", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Computed from review_plans + review_history" },
        TableClassification { database: "vfs", table_name: "questions_fts", primary_key: "(virtual)", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "FTS5 virtual table; rebuilt from questions" },
        TableClassification { database: "vfs", table_name: "vfs_index_units", primary_key: "id", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Rebuildable from resources/files" },
        TableClassification { database: "vfs", table_name: "vfs_index_segments", primary_key: "id", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Rebuildable from vfs_index_units" },
        TableClassification { database: "vfs", table_name: "vfs_embedding_dims", primary_key: "dimension,modality", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Rebuildable from segments" },
        // --- LocalRuntime ---
        TableClassification { database: "vfs", table_name: "question_history", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Field-level change history, debugging only" },
        TableClassification { database: "vfs", table_name: "question_sync_conflicts", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Transient conflict resolution" },
        TableClassification { database: "vfs", table_name: "question_sync_logs", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Sync audit log" },
        TableClassification { database: "vfs", table_name: "review_history", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Audit-like history, not synced" },
        TableClassification { database: "vfs", table_name: "memory_audit_log", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Debug audit log" },
        TableClassification { database: "vfs", table_name: "memory_write_idempotency", primary_key: "idempotency_key", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Dedup prevention" },
        // --- BackupOnly ---
        TableClassification { database: "vfs", table_name: "mindmap_versions", primary_key: "version_id", category: SyncCategory::BackupOnly, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Version history, backup only" },
        TableClassification { database: "vfs", table_name: "memory_config", primary_key: "key", category: SyncCategory::BackupOnly, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "KV config" },
        TableClassification { database: "vfs", table_name: "vfs_indexing_config", primary_key: "key", category: SyncCategory::BackupOnly, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "KV config" },
        // --- Deprecated ---
        TableClassification { database: "vfs", table_name: "notes_versions", primary_key: "version_id", category: SyncCategory::Deprecated, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Dropped in V20260214" },

        // ========== Chat V2 database ==========
        TableClassification { database: "chat_v2", table_name: "chat_v2_sessions", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "metadata_json field-level merge" },
        TableClassification { database: "chat_v2", table_name: "chat_v2_messages", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "block_ids_json/meta_json/attachments_json/variants_json/shared_context_json field-level merge" },
        TableClassification { database: "chat_v2", table_name: "chat_v2_blocks", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "tool_input_json/tool_output_json/citations_json field-level merge" },
        TableClassification { database: "chat_v2", table_name: "chat_v2_attachments", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "content_hash", has_json_blobs: false, merge_notes: "Linked to message + block via FK; storage_path needs file-level sync companion" },
        TableClassification { database: "chat_v2", table_name: "resources", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::CounterMerge, business_unique_keys: "hash", has_json_blobs: true, merge_notes: "ref_count CRDT counter merge; metadata_json field-level merge" },
        TableClassification { database: "chat_v2", table_name: "chat_v2_session_mistakes", primary_key: "session_id,mistake_id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: false, merge_notes: "Composite PK junction table" },
        TableClassification { database: "chat_v2", table_name: "chat_v2_session_groups", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "default_skill_ids_json/pinned_resource_ids_json field-level merge" },
        TableClassification { database: "chat_v2", table_name: "workspace_index", primary_key: "workspace_id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: false, merge_notes: "Workspace registry" },
        // --- LocalRuntime ---
        TableClassification { database: "chat_v2", table_name: "chat_v2_session_state", primary_key: "session_id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Transient UI state + ChatParams" },
        TableClassification { database: "chat_v2", table_name: "chat_v2_todo_lists", primary_key: "session_id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Agent-generated, transient" },
        TableClassification { database: "chat_v2", table_name: "chat_v2_session_tags", primary_key: "session_id,tag", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Auto-generated tags, can be regenerated" },
        TableClassification { database: "chat_v2", table_name: "sleep_block", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Transient agent sleep state" },
        TableClassification { database: "chat_v2", table_name: "subagent_task", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Transient task tracking" },
        // --- DerivedRebuild ---
        TableClassification { database: "chat_v2", table_name: "chat_v2_content_fts", primary_key: "(virtual)", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "FTS5 virtual table; rebuilt from chat_v2_blocks" },
        TableClassification { database: "chat_v2", table_name: "chat_v2_compactions", primary_key: "id", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Rebuildable from messages + blocks" },

        // ========== Mistakes database ==========
        TableClassification { database: "mistakes", table_name: "mistakes", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "question_images/analysis_images/tags JSON arrays; chat_metadata JSON" },
        TableClassification { database: "mistakes", table_name: "chat_messages", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "15 JSON blob columns; turn_id/turn_seq/stability for turn grouping" },
        TableClassification { database: "mistakes", table_name: "review_analyses", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "mistake_ids/tags JSON arrays; temp_session_data JSON" },
        TableClassification { database: "mistakes", table_name: "review_chat_messages", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "Same JSON-heavy structure as chat_messages" },
        TableClassification { database: "mistakes", table_name: "review_sessions", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: false, merge_notes: "Review note sessions with start/end dates" },
        TableClassification { database: "mistakes", table_name: "review_session_mistakes", primary_key: "session_id,mistake_id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: false, merge_notes: "Composite PK junction table" },
        TableClassification { database: "mistakes", table_name: "anki_cards", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::FieldMerge, business_unique_keys: "", has_json_blobs: true, merge_notes: "tags_json/images_json/extra_fields_json field-level merge" },
        // --- LocalRuntime ---
        TableClassification { database: "mistakes", table_name: "temp_sessions", primary_key: "temp_id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Transient streaming state" },
        TableClassification { database: "mistakes", table_name: "document_tasks", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Document processing pipeline" },
        TableClassification { database: "mistakes", table_name: "document_control_states", primary_key: "document_id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Processing state machine" },
        TableClassification { database: "mistakes", table_name: "search_logs", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Debug/search logs" },
        TableClassification { database: "mistakes", table_name: "exam_sheet_sessions", primary_key: "id", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Processing sessions" },
        TableClassification { database: "mistakes", table_name: "migration_progress", primary_key: "category", category: SyncCategory::LocalRuntime, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Migration tracking" },
        // --- DerivedRebuild ---
        TableClassification { database: "mistakes", table_name: "vectorized_data", primary_key: "id", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: true, merge_notes: "Rebuildable from mistakes; embeddings can regenerate" },
        // --- BackupOnly ---
        TableClassification { database: "mistakes", table_name: "settings", primary_key: "key", category: SyncCategory::BackupOnly, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "KV settings" },
        TableClassification { database: "mistakes", table_name: "rag_configurations", primary_key: "id", category: SyncCategory::BackupOnly, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "RAG config" },
        TableClassification { database: "mistakes", table_name: "custom_anki_templates", primary_key: "id", category: SyncCategory::BackupOnly, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "name", has_json_blobs: true, merge_notes: "User-created templates; fields_json/field_extraction_rules_json" },
        TableClassification { database: "mistakes", table_name: "rag_sub_libraries", primary_key: "id", category: SyncCategory::BackupOnly, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "name", has_json_blobs: false, merge_notes: "RAG sub-libraries" },

        // ========== LLM Usage database ==========
        TableClassification { database: "llm_usage", table_name: "llm_usage_logs", primary_key: "id", category: SyncCategory::RowSync, conflict_policy: ConflictPolicyClass::Lww, business_unique_keys: "", has_json_blobs: false, merge_notes: "Usage logs with GENERATED columns (date_key, hour_key STORED)" },
        TableClassification { database: "llm_usage", table_name: "llm_usage_daily", primary_key: "date,caller_type,model,provider", category: SyncCategory::DerivedRebuild, conflict_policy: ConflictPolicyClass::NoConflict, business_unique_keys: "", has_json_blobs: false, merge_notes: "Pre-aggregated; fully rebuildable from llm_usage_logs" },
    ]
}

/// Query helpers
impl TableClassification {
    /// Get all RowSync tables
    pub fn row_sync_tables() -> Vec<TableClassification> {
        sync_classification_registry()
            .into_iter()
            .filter(|c| c.category == SyncCategory::RowSync)
            .collect()
    }

    /// Get tables for which checksum should be computed (RowSync + FileSync only)
    pub fn checksum_tables(database: &str) -> Vec<TableClassification> {
        sync_classification_registry()
            .into_iter()
            .filter(|c| c.database == database)
            .filter(|c| matches!(c.category, SyncCategory::RowSync | SyncCategory::FileSync))
            .collect()
    }

    /// Check if a table name should be excluded from checksum (FTS shadows, runtime, derived)
    pub fn is_excluded_from_checksum(database: &str, table_name: &str) -> bool {
        if table_name.starts_with("sqlite_") || table_name.starts_with("__") {
            return true;
        }
        let fts_shadows = &[
            "_content",
            "_docsize",
            "_config",
            "_idx",
            "_segdir",
            "_segments",
            "_stat",
            "_data",
        ];
        for suffix in fts_shadows {
            if table_name.ends_with(suffix) {
                let base = table_name.trim_end_matches(suffix);
                let is_fts_virtual = sync_classification_registry().iter().any(|c| {
                    c.database == database && c.table_name == base && c.primary_key == "(virtual)"
                });
                if is_fts_virtual {
                    return true;
                }
            }
        }
        sync_classification_registry()
            .iter()
            .filter(|c| c.database == database)
            .any(|c| {
                c.table_name == table_name
                    && !matches!(c.category, SyncCategory::RowSync | SyncCategory::FileSync)
            })
    }

    /// Get business unique keys for conflict resolution
    pub fn get_business_unique_keys(database: &str, table_name: &str) -> Vec<String> {
        sync_classification_registry()
            .iter()
            .filter(|c| c.database == database && c.table_name == table_name)
            .flat_map(|c| {
                if c.business_unique_keys.is_empty() {
                    vec![]
                } else {
                    c.business_unique_keys
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .collect()
                }
            })
            .collect()
    }
}
