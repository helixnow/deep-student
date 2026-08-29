use serde::{Deserialize, Serialize};

/// Sync classification for every table in every database
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncCategory {
    /// Row-level incremental sync via __change_log + UPSERT (`SET col = excluded.col`)
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
    /// Whether this table has JSON blob columns. JSON blobs default to row-level LWW
    /// unless a specific column appears in the field_merge strategy registry.
    pub has_json_blobs: bool,
    /// Special merge notes
    pub merge_notes: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
        TableClassification {
            database: "vfs",
            table_name: "resources",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "hash",
            has_json_blobs: true,
            merge_notes: "ref_count is derived/recomputed; metadata_json uses row-level LWW/conflict handling; data uses conditional learner-profile JSON merge (only when both sides match the learner profile shape, see field_merge::merge_learner_profile_data), all other data conflicts stay row-level LWW",
        },
        TableClassification {
            database: "vfs",
            table_name: "notes",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "tags uses set union with single-value tag normalization; is_favorite uses boolean OR; props is an arbitrary JSON object and intentionally stays out of the automatic field-merge picklist, so concurrent whole-object replacements use row-level LWW",
        },
        TableClassification {
            database: "vfs",
            table_name: "files",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "sha256",
            has_json_blobs: true,
            merge_notes: "sha256 is the verified file-content business key; same-content rows are aliased to the surviving file id",
        },
        TableClassification {
            database: "vfs",
            table_name: "exam_sheets",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "metadata_json/preview_json use row-level LWW/conflict handling; sync_config for exam-specific sync settings",
        },
        TableClassification {
            database: "vfs",
            table_name: "translations",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "metadata_json uses row-level LWW/conflict handling",
        },
        TableClassification {
            database: "vfs",
            table_name: "essays",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "grading_result_json/dimension_scores_json use row-level LWW/conflict handling",
        },
        TableClassification {
            database: "vfs",
            table_name: "essay_sessions",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Essay writing sessions tracking rounds/scores across devices",
        },
        TableClassification {
            database: "vfs",
            table_name: "mindmaps",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "settings JSON uses row-level LWW/conflict handling",
        },
        TableClassification {
            database: "vfs",
            table_name: "folders",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Self-referencing parent_id FK",
        },
        TableClassification {
            database: "vfs",
            table_name: "folder_items",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "folder_id,item_type,item_id",
            has_json_blobs: false,
            merge_notes: "Junction table; unique on (folder_id,item_type,item_id)",
        },
        TableClassification {
            database: "vfs",
            table_name: "questions",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "tags use set union; attempt_count/correct_count are a coupled pair updated atomically per answer and may legitimately reset, so they use row-level LWW (not max, see field_merge [R04]); options_json/images_json/user_note use row-level LWW/conflict handling",
        },
        TableClassification {
            database: "vfs",
            table_name: "answer_submissions",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "question_id,client_request_id",
            has_json_blobs: false,
            merge_notes: "Idempotency via client_request_id UNIQUE",
        },
        TableClassification {
            database: "vfs",
            table_name: "review_plans",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "question_id",
            has_json_blobs: false,
            merge_notes: "question_id UNIQUE conflict = same question; total_reviews/total_correct use max; interval_days/consecutive_failures are non-monotonic (can legitimately decrease/reset) so they use row-level LWW, not max (see field_merge [R02]); ease_factor uses row-level LWW",
        },
        TableClassification {
            database: "vfs",
            table_name: "mastery_events",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Append-only evidence events; deterministic FSRS event ids deduplicate retries",
        },
        TableClassification {
            database: "vfs",
            table_name: "todo_lists",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "User todo lists with sort_order/is_default; sort_order is user-reordered (todo_reorder_lists rewrites 0..n and bumps updated_at/local_version, LWW row-sync carries the order)",
        },
        TableClassification {
            database: "vfs",
            table_name: "todo_items",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "estimated_pomodoros uses max; completed_pomodoros is a derived cache recomputed from pomodoro_records at sync apply commit boundary (TD-02, no field merge); tags_json uses set union; sort_order/todo_list_id rewritten by todo_reorder_items/todo_move_item (per-field LWW inside FieldMerge)",
        },
        TableClassification {
            database: "vfs",
            table_name: "pomodoro_records",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Focus session records linked to todo items; soft delete via deleted_at (bumps updated_at/local_version, LWW propagates deletion); fact table for todo_items.completed_pomodoros which is recomputed after applying changes (TD-02)",
        },
        // --- FileSync ---
        TableClassification {
            database: "vfs",
            table_name: "blobs",
            primary_key: "hash",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Content-addressed blob metadata; raw bytes sync through file-level blob sync",
        },
        // --- DerivedRebuild ---
        TableClassification {
            database: "vfs",
            table_name: "path_cache",
            primary_key: "item_type,item_id",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Fully rebuildable from folders + folder_items",
        },
        TableClassification {
            database: "vfs",
            table_name: "question_bank_stats",
            primary_key: "exam_id",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Computed from questions table",
        },
        TableClassification {
            database: "vfs",
            table_name: "review_stats",
            primary_key: "exam_id",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Computed from synced review_plans; review_history is local audit/runtime data and is not part of incremental sync",
        },
        TableClassification {
            database: "vfs",
            table_name: "mastery_states",
            primary_key: "concept_key",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Recomputed deterministically from synced mastery_events",
        },
        TableClassification {
            database: "vfs",
            table_name: "questions_fts",
            primary_key: "(virtual)",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "FTS5 virtual table; rebuilt from questions",
        },
        TableClassification {
            database: "vfs",
            table_name: "vfs_index_units",
            primary_key: "id",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Rebuildable from resources/files",
        },
        TableClassification {
            database: "vfs",
            table_name: "vfs_index_segments",
            primary_key: "id",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Rebuildable from vfs_index_units",
        },
        TableClassification {
            database: "vfs",
            table_name: "vfs_embedding_dims",
            primary_key: "dimension,modality",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Rebuildable from segments",
        },
        TableClassification {
            database: "vfs",
            table_name: "vfs_index_profiles",
            primary_key: "id",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "model_fingerprint,dimension,modality,embedding_protocol,schema_version",
            has_json_blobs: false,
            merge_notes: "Local vector-space identity derived from configured embedding models and rebuilt indexes",
        },
        // --- LocalRuntime ---
        TableClassification {
            database: "vfs",
            table_name: "question_history",
            primary_key: "id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Column change history, debugging only",
        },
        TableClassification {
            database: "vfs",
            table_name: "question_sync_conflicts",
            primary_key: "id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Transient conflict resolution",
        },
        TableClassification {
            database: "vfs",
            table_name: "question_sync_logs",
            primary_key: "id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Sync audit log",
        },
        TableClassification {
            database: "vfs",
            table_name: "review_history",
            primary_key: "id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Audit-like history, not synced",
        },
        TableClassification {
            database: "vfs",
            table_name: "memory_audit_log",
            primary_key: "id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Debug audit log",
        },
        TableClassification {
            database: "vfs",
            table_name: "memory_write_idempotency",
            primary_key: "idempotency_key",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Dedup prevention",
        },
        TableClassification {
            database: "vfs",
            table_name: "automation_todo_deliveries",
            primary_key: "run_id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "todo_item_id",
            has_json_blobs: false,
            merge_notes: "Local idempotency receipts for automation todo side effects",
        },
        // --- BackupOnly ---
        TableClassification {
            database: "vfs",
            table_name: "mindmap_versions",
            primary_key: "version_id",
            category: SyncCategory::BackupOnly,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Version history, backup only",
        },
        TableClassification {
            database: "vfs",
            table_name: "memory_config",
            primary_key: "key",
            category: SyncCategory::BackupOnly,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "KV config; memory_root_folder_id is device-local, so MemoryConfig::get_or_create_root_folder claims the RowSync-synced memory root before creating a new one to avoid cross-device root forks",
        },
        TableClassification {
            database: "vfs",
            table_name: "vfs_indexing_config",
            primary_key: "key",
            category: SyncCategory::BackupOnly,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "KV config",
        },
        // --- Deprecated ---
        TableClassification {
            database: "vfs",
            table_name: "notes_versions",
            primary_key: "version_id",
            category: SyncCategory::Deprecated,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Dropped in V20260214",
        },
        // ========== Chat V2 database ==========
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_sessions",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "metadata_json uses row-level LWW/conflict handling",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_messages",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "block_ids_json/meta_json/attachments_json/variants_json/shared_context_json use row-level LWW/conflict handling",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_blocks",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "tool_input_json/tool_output_json/citations_json use row-level LWW/conflict handling",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_attachments",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Linked to message + block via FK; content_hash is a dedup hint, not a UNIQUE key",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "resources",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "hash",
            has_json_blobs: true,
            merge_notes: "ref_count is derived/recomputed; metadata_json uses row-level LWW/conflict handling",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_session_mistakes",
            primary_key: "session_id,mistake_id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Composite PK junction table",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_session_groups",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "default_skill_ids_json/pinned_resource_ids_json use row-level LWW/conflict handling",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "workspace_index",
            primary_key: "workspace_id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Workspace registry",
        },
        // --- LocalRuntime ---
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_session_state",
            primary_key: "session_id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Transient UI state + ChatParams",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_todo_lists",
            primary_key: "session_id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Agent-generated, transient",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_session_tags",
            primary_key: "session_id,tag",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Manual tags are user data; auto tags share the same composite-key row contract",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_compactions",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Append-only summary lineage; active pointer is synchronized on chat_v2_sessions",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "sleep_block",
            primary_key: "id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Transient agent sleep state",
        },
        TableClassification {
            database: "chat_v2",
            table_name: "subagent_task",
            primary_key: "id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Transient task tracking",
        },
        // --- DerivedRebuild ---
        TableClassification {
            database: "chat_v2",
            table_name: "chat_v2_content_fts",
            primary_key: "(virtual)",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "FTS5 virtual table; rebuilt from chat_v2_blocks",
        },
        // ========== Mistakes database ==========
        TableClassification {
            database: "mistakes",
            table_name: "mistakes",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "question_images/analysis_images/tags JSON arrays; chat_metadata JSON",
        },
        TableClassification {
            database: "mistakes",
            table_name: "chat_messages",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "15 JSON blob columns; turn_id/turn_seq/stability for turn grouping",
        },
        TableClassification {
            database: "mistakes",
            table_name: "review_analyses",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "mistake_ids/tags JSON arrays; temp_session_data JSON",
        },
        TableClassification {
            database: "mistakes",
            table_name: "review_chat_messages",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Same JSON-heavy structure as chat_messages",
        },
        TableClassification {
            database: "mistakes",
            table_name: "review_sessions",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Review note sessions with start/end dates",
        },
        TableClassification {
            database: "mistakes",
            table_name: "review_session_mistakes",
            primary_key: "session_id,mistake_id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Composite PK junction table",
        },
        TableClassification {
            database: "mistakes",
            table_name: "document_tasks",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Anki card parent task; anki_generation_options_json uses row-level LWW/conflict handling",
        },
        TableClassification {
            database: "mistakes",
            table_name: "anki_cards",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::FieldMerge,
            business_unique_keys: "",
            has_json_blobs: true,
            // Export receipt 列（anki_note_id/export_status/last_exported_at/content_hash）由
            // write_anki_export_receipts 在一次 AnkiConnect 导出后整组写回并 bump updated_at。
            // 四列必须作为一组保持一致，逐列自动合并会产生撕裂 receipt（note id 与时间戳来自
            // 不同设备），因此登记为 row-level LWW：以最新导出的 receipt 整组为准。
            merge_notes: "tags_json uses set union; images_json/extra_fields_json use row-level LWW/conflict handling; APKG rows use id-based identity while generated cards retain content deduplication; export receipt columns anki_note_id/export_status/last_exported_at/content_hash use row-level LWW so the latest export receipt wins as a coherent group",
        },
        TableClassification {
            database: "mistakes",
            table_name: "anki_decks",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "name",
            has_json_blobs: true,
            merge_notes: "Deck configuration JSON uses row-level LWW/conflict handling",
        },
        TableClassification {
            database: "mistakes",
            table_name: "fsrs_card_states",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "anki_card_id",
            has_json_blobs: false,
            merge_notes: "One scheduling state per Anki card; latest scheduler state wins",
        },
        TableClassification {
            database: "mistakes",
            table_name: "fsrs_review_logs",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Review events carry immutable state_before_json snapshots; undo uses a synced soft-delete tombstone",
        },
        // --- LocalRuntime ---
        TableClassification {
            database: "mistakes",
            table_name: "temp_sessions",
            primary_key: "temp_id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Transient streaming state",
        },
        TableClassification {
            database: "mistakes",
            table_name: "document_control_states",
            primary_key: "document_id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Processing state machine",
        },
        TableClassification {
            database: "mistakes",
            table_name: "search_logs",
            primary_key: "id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Debug/search logs",
        },
        TableClassification {
            database: "mistakes",
            table_name: "exam_sheet_sessions",
            primary_key: "id",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Processing sessions",
        },
        TableClassification {
            database: "mistakes",
            table_name: "migration_progress",
            primary_key: "category",
            category: SyncCategory::LocalRuntime,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Migration tracking",
        },
        // --- DerivedRebuild ---
        TableClassification {
            database: "mistakes",
            table_name: "vectorized_data",
            primary_key: "id",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Rebuildable from mistakes; embeddings can regenerate",
        },
        // --- BackupOnly ---
        TableClassification {
            database: "mistakes",
            table_name: "settings",
            primary_key: "key",
            category: SyncCategory::BackupOnly,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "KV settings",
        },
        TableClassification {
            database: "mistakes",
            table_name: "rag_configurations",
            primary_key: "id",
            category: SyncCategory::BackupOnly,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "RAG config",
        },
        TableClassification {
            database: "mistakes",
            table_name: "custom_anki_templates",
            primary_key: "id",
            category: SyncCategory::BackupOnly,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "name",
            has_json_blobs: true,
            merge_notes: "User-created templates; fields_json/field_extraction_rules_json",
        },
        TableClassification {
            database: "mistakes",
            table_name: "automation_definitions",
            primary_key: "id",
            category: SyncCategory::BackupOnly,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: true,
            merge_notes: "Device-local scheduler definitions included in full backups",
        },
        TableClassification {
            database: "mistakes",
            table_name: "automation_runs",
            primary_key: "id",
            category: SyncCategory::BackupOnly,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "dedupe_key",
            has_json_blobs: true,
            merge_notes: "Durable local execution history and delivery state",
        },
        TableClassification {
            database: "mistakes",
            table_name: "rag_sub_libraries",
            primary_key: "id",
            category: SyncCategory::BackupOnly,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "name",
            has_json_blobs: false,
            merge_notes: "RAG sub-libraries",
        },
        // ========== LLM Usage database ==========
        TableClassification {
            database: "llm_usage",
            table_name: "llm_usage_logs",
            primary_key: "id",
            category: SyncCategory::RowSync,
            conflict_policy: ConflictPolicyClass::Lww,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Usage logs with GENERATED columns (date_key, hour_key STORED)",
        },
        TableClassification {
            database: "llm_usage",
            table_name: "llm_usage_daily",
            primary_key: "date,caller_type,model,provider",
            category: SyncCategory::DerivedRebuild,
            conflict_policy: ConflictPolicyClass::NoConflict,
            business_unique_keys: "",
            has_json_blobs: false,
            merge_notes: "Pre-aggregated; fully rebuildable from llm_usage_logs",
        },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vfs_profile_ledger_is_rebuilt_locally_and_excluded_from_row_sync() {
        let profile = sync_classification_registry()
            .into_iter()
            .find(|entry| entry.database == "vfs" && entry.table_name == "vfs_index_profiles")
            .expect("vfs_index_profiles classification");

        assert_eq!(profile.category, SyncCategory::DerivedRebuild);
        assert!(TableClassification::is_excluded_from_checksum(
            "vfs",
            "vfs_index_profiles"
        ));
        assert!(!TableClassification::checksum_tables("vfs")
            .iter()
            .any(|entry| entry.table_name == "vfs_index_profiles"));
    }

    #[test]
    fn td02_completed_pomodoros_registered_as_derived_cache_of_pomodoro_records() {
        let todo = sync_classification_registry()
            .into_iter()
            .find(|entry| entry.database == "vfs" && entry.table_name == "todo_items")
            .expect("todo_items classification");
        assert!(
            todo.merge_notes.contains("completed_pomodoros")
                && todo.merge_notes.contains("derived cache")
                && todo.merge_notes.contains("pomodoro_records"),
            "todo_items merge_notes must document completed_pomodoros as a derived cache \
             recomputed from pomodoro_records"
        );

        let records = sync_classification_registry()
            .into_iter()
            .find(|entry| entry.database == "vfs" && entry.table_name == "pomodoro_records")
            .expect("pomodoro_records classification");
        assert_eq!(records.category, SyncCategory::RowSync);
        assert!(
            records.merge_notes.contains("fact table"),
            "pomodoro_records must be documented as the fact table for the derived counter"
        );

        // 注册层与字段合并层保持一致：completed_pomodoros 不允许自动字段级合并
        assert!(
            !crate::data_governance::sync::field_merge::field_merge_columns_for_table("todo_items")
                .contains(&"completed_pomodoros"),
            "completed_pomodoros must stay out of the field merge picklist"
        );
    }

    #[test]
    fn anki_cards_export_receipt_columns_are_registered_as_row_level_lww() {
        let entry = sync_classification_registry()
            .into_iter()
            .find(|entry| entry.database == "mistakes" && entry.table_name == "anki_cards")
            .expect("anki_cards classification");

        assert_eq!(entry.category, SyncCategory::RowSync);
        assert_eq!(entry.conflict_policy, ConflictPolicyClass::FieldMerge);
        for column in [
            "anki_note_id",
            "export_status",
            "last_exported_at",
            "content_hash",
        ] {
            assert!(
                entry.merge_notes.contains(column),
                "anki_cards merge_notes must document receipt column {}",
                column
            );
        }
        assert!(
            entry.merge_notes.contains("row-level LWW"),
            "receipt columns must be registered as row-level LWW"
        );
    }
}
