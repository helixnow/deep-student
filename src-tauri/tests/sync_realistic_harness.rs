//! Realistic Multi-Device Sync Test Harness
//!
//! Simulates: Device A ←→ Cloud Store ←→ Device B
//! Uses real SQLite schemas from production migrations, full change log triggers,
//! and actual sync infrastructure.
//! Every sync operation is logged with timestamps for debugging.
//!
//! ## Design
//!
//! - **SyncDevice**: Wraps an in-memory SQLite connection with a device identity.
//!   Each device is an independent database representing one real user device.
//! - **SimulatedCloudStore**: In-memory `HashMap` acting as the cloud sync server.
//!   Receives uploads from devices, serves downloads.
//! - **SyncLogEntry**: Timestamped record of every sync and data mutation.
//! - **Verification utilities**: Compare device states, count rows, check convergence.
//!
//! ## Usage from another test file
//!
//! ```rust,ignore
//! mod sync_realistic_harness;
//! use sync_realistic_harness::*;
//!
//! let device_a = SyncDevice::new("Device A", "dev-a-001");
//! let device_b = SyncDevice::new("Device B", "dev-b-001");
//! let cloud = SimulatedCloudStore::new();
//!
//! setup_all_schemas(&device_a);
//! setup_all_schemas(&device_b);
//!
//! create_test_resource(&device_a, "res_001", "abc123", "hello world");
//! // ... sync, verify ...
//! ```

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use rusqlite::{params, Connection};
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::Value;

// ============================================================================
// LOGGING
// ============================================================================

static SYNC_LOG: std::sync::LazyLock<Mutex<Vec<SyncLogEntry>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

#[derive(Debug, Clone, Serialize)]
pub struct SyncLogEntry {
    pub timestamp_ms: u64,
    pub device: String,
    pub operation: String,
    pub table_name: Option<String>,
    pub record_id: Option<String>,
    pub details: String,
    pub success: bool,
}

pub fn log_sync(
    device: &str,
    operation: &str,
    table: Option<&str>,
    record: Option<&str>,
    details: &str,
    success: bool,
) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    SYNC_LOG.lock().unwrap().push(SyncLogEntry {
        timestamp_ms: ts,
        device: device.to_string(),
        operation: operation.to_string(),
        table_name: table.map(|s| s.to_string()),
        record_id: record.map(|s| s.to_string()),
        details: details.to_string(),
        success,
    });
}

pub fn dump_sync_log() -> Vec<SyncLogEntry> {
    SYNC_LOG.lock().unwrap().clone()
}

pub fn clear_sync_log() {
    SYNC_LOG.lock().unwrap().clear();
}

// ============================================================================
// SIMULATED CLOUD STORE
// ============================================================================

/// Simple in-memory cloud store using HashMap.
/// Each key maps to a byte vector representing serialized sync data.
#[derive(Default)]
pub struct SimulatedCloudStore {
    files: Mutex<HashMap<String, Vec<u8>>>,
}

impl SimulatedCloudStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put(&self, key: &str, data: &[u8]) {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), data.to_vec());
        log_sync(
            "SERVER",
            "PUT",
            None,
            None,
            &format!("key={}, bytes={}", key, data.len()),
            true,
        );
    }

    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let result = self.files.lock().unwrap().get(key).cloned();
        log_sync(
            "SERVER",
            "GET",
            None,
            None,
            &format!("key={}, found={}", key, result.is_some()),
            result.is_some(),
        );
        result
    }

    pub fn list(&self, prefix: &str) -> Vec<String> {
        let keys: Vec<String> = self
            .files
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect();
        log_sync(
            "SERVER",
            "LIST",
            None,
            None,
            &format!("prefix={}, count={}", prefix, keys.len()),
            true,
        );
        keys
    }

    pub fn delete(&self, key: &str) {
        self.files.lock().unwrap().remove(key);
        log_sync("SERVER", "DELETE", None, None, &format!("key={}", key), true);
    }

    pub fn file_count(&self) -> usize {
        self.files.lock().unwrap().len()
    }
}

// ============================================================================
// DEVICE REPRESENTATION
// ============================================================================

pub struct SyncDevice {
    pub name: String,
    pub device_id: String,
    pub conn: Connection,
}

impl SyncDevice {
    pub fn new(name: &str, device_id: &str) -> Self {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .unwrap();
        SyncDevice {
            name: name.to_string(),
            device_id: device_id.to_string(),
            conn,
        }
    }

    /// Get the count of unsynchronized changes (sync_version = 0)
    pub fn pending_changes_count(&self) -> usize {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
                [],
                |row| row.get::<_, usize>(0),
            )
            .unwrap_or(0)
    }
}

// ============================================================================
// FULL SCHEMA SETUP
// ============================================================================

/// Sets up ALL RowSync tables across all 4 databases with real columns
/// from production migrations, plus `__change_log`, `__sync_conflicts`,
/// and all INSERT/UPDATE/DELETE triggers.
pub fn setup_all_schemas(device: &SyncDevice) {
    let conn = &device.conn;

    // ── Shared infrastructure tables ──
    conn.execute_batch(SHARED_INFRASTRUCTURE_SQL).unwrap();

    // ── VFS database tables ──
    conn.execute_batch(VFS_SCHEMA_SQL).unwrap();

    // ── Chat V2 database tables ──
    conn.execute_batch(CHAT_V2_SCHEMA_SQL).unwrap();

    // ── Mistakes database tables ──
    conn.execute_batch(MISTAKES_SCHEMA_SQL).unwrap();

    // ── LLM Usage database tables ──
    conn.execute_batch(LLM_USAGE_SCHEMA_SQL).unwrap();

    // ── Change log triggers for all RowSync tables ──
    conn.execute_batch(ALL_TRIGGERS_SQL).unwrap();

    log_sync(
        &device.name,
        "SCHEMA_SETUP",
        None,
        None,
        "All RowSync schemas + triggers created",
        true,
    );
}

// ============================================================================
// SHARED INFRASTRUCTURE SQL
// ============================================================================

const SHARED_INFRASTRUCTURE_SQL: &str = r#"
-- __change_log: records every INSERT/UPDATE/DELETE for RowSync tables
CREATE TABLE IF NOT EXISTS __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx__change_log_sync_version ON __change_log(sync_version);
CREATE INDEX IF NOT EXISTS idx__change_log_table_sync ON __change_log(table_name, sync_version);

-- __sync_conflicts: records conflicts detected during sync
CREATE TABLE IF NOT EXISTS __sync_conflicts (
    id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    conflict_type TEXT NOT NULL,
    local_snapshot TEXT,
    remote_snapshot TEXT,
    resolution TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

// ============================================================================
// VFS DATABASE SCHEMA (all RowSync tables with real columns)
// ============================================================================

const VFS_SCHEMA_SQL: &str = r#"
-- 1. resources: core content-addressed store
CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    source_id TEXT,
    source_table TEXT,
    storage_mode TEXT NOT NULL DEFAULT 'inline',
    data TEXT,
    external_hash TEXT,
    metadata_json TEXT,
    ref_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    deleted_reason TEXT,
    index_state TEXT DEFAULT 'pending',
    index_hash TEXT,
    index_error TEXT,
    indexed_at INTEGER,
    index_retry_count INTEGER DEFAULT 0,
    ocr_text TEXT,
    -- Sync columns
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 2. notes: note metadata linked to resources
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    title TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 3. files: unified file storage (textbooks + attachments)
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    resource_id TEXT,
    blob_hash TEXT,
    sha256 TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    original_path TEXT,
    size INTEGER NOT NULL,
    page_count INTEGER,
    tags_json TEXT NOT NULL DEFAULT '[]',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    last_opened_at TEXT,
    last_page INTEGER,
    bookmarks_json TEXT NOT NULL DEFAULT '[]',
    cover_key TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    type TEXT NOT NULL DEFAULT 'document',
    name TEXT,
    content_hash TEXT,
    description TEXT,
    mime_type TEXT,
    preview_json TEXT,
    extracted_text TEXT,
    ocr_pages_json TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 4. exam_sheets: exam recognition metadata
CREATE TABLE IF NOT EXISTS exam_sheets (
    id TEXT PRIMARY KEY,
    resource_id TEXT,
    exam_name TEXT,
    status TEXT NOT NULL,
    temp_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    preview_json TEXT NOT NULL,
    linked_mistake_ids TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    ocr_pages_json TEXT,
    sync_enabled INTEGER DEFAULT 0,
    last_synced_at TEXT,
    remote_exam_id TEXT,
    sync_config TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 5. translations: translation metadata
CREATE TABLE IF NOT EXISTS translations (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    src_lang TEXT NOT NULL DEFAULT 'auto',
    tgt_lang TEXT NOT NULL DEFAULT 'zh',
    engine TEXT,
    model TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    quality_rating INTEGER,
    created_at TEXT NOT NULL,
    metadata_json TEXT,
    title TEXT,
    subject TEXT,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 6. essays: essay grading metadata
CREATE TABLE IF NOT EXISTS essays (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    title TEXT,
    essay_type TEXT,
    grading_result_json TEXT,
    score INTEGER,
    session_id TEXT,
    round_number INTEGER NOT NULL DEFAULT 1,
    grade_level TEXT,
    custom_prompt TEXT,
    dimension_scores_json TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 7. essay_sessions: essay writing sessions
CREATE TABLE IF NOT EXISTS essay_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    essay_type TEXT,
    grade_level TEXT,
    custom_prompt TEXT,
    subject TEXT DEFAULT '语文',
    total_rounds INTEGER NOT NULL DEFAULT 0,
    latest_score INTEGER,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 8. mindmaps: knowledge mind maps
CREATE TABLE IF NOT EXISTS mindmaps (
    id TEXT PRIMARY KEY NOT NULL,
    resource_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    is_favorite INTEGER DEFAULT 0,
    default_view TEXT DEFAULT 'outline',
    theme TEXT,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 9. folders: folder hierarchy
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    title TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    is_expanded INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 10. folder_items: junction between folders and items
CREATE TABLE IF NOT EXISTS folder_items (
    id TEXT PRIMARY KEY,
    folder_id TEXT,
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    cached_path TEXT,
    deleted_at TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 11. questions: exam question bank
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY NOT NULL,
    exam_id TEXT NOT NULL,
    card_id TEXT,
    question_label TEXT,
    content TEXT NOT NULL,
    options_json TEXT,
    answer TEXT,
    explanation TEXT,
    question_type TEXT DEFAULT 'other',
    difficulty TEXT,
    tags TEXT DEFAULT '[]',
    status TEXT DEFAULT 'new',
    user_answer TEXT,
    is_correct INTEGER,
    attempt_count INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    user_note TEXT,
    is_favorite INTEGER DEFAULT 0,
    is_bookmarked INTEGER DEFAULT 0,
    source_type TEXT DEFAULT 'ocr',
    source_ref TEXT,
    parent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    sync_status TEXT DEFAULT 'local_only',
    last_synced_at TEXT,
    remote_id TEXT,
    content_hash TEXT,
    remote_version INTEGER DEFAULT 0,
    ai_feedback TEXT,
    ai_score INTEGER,
    ai_graded_at TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 12. answer_submissions: per-attempt answer history
CREATE TABLE IF NOT EXISTS answer_submissions (
    id TEXT PRIMARY KEY NOT NULL,
    question_id TEXT NOT NULL,
    user_answer TEXT NOT NULL,
    is_correct INTEGER,
    grading_method TEXT NOT NULL DEFAULT 'auto',
    submitted_at TEXT NOT NULL,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 13. review_plans: SM-2 spaced repetition
CREATE TABLE IF NOT EXISTS review_plans (
    id TEXT PRIMARY KEY NOT NULL,
    question_id TEXT NOT NULL UNIQUE,
    exam_id TEXT NOT NULL,
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval_days INTEGER NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    next_review_date TEXT NOT NULL,
    last_review_date TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    total_reviews INTEGER NOT NULL DEFAULT 0,
    total_correct INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    is_difficult INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    deleted_at TEXT
);

-- 14. todo_lists: user todo list metadata (decoupled from VFS)
CREATE TABLE IF NOT EXISTS todo_lists (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 15. todo_items: individual todo tasks
CREATE TABLE IF NOT EXISTS todo_items (
    id TEXT PRIMARY KEY NOT NULL,
    todo_list_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'none',
    due_date TEXT,
    due_time TEXT,
    reminder TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    completed_at TEXT,
    repeat_json TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    estimated_pomodoros INTEGER DEFAULT 0,
    completed_pomodoros INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0
);

-- 16. pomodoro_records: focus session records
CREATE TABLE IF NOT EXISTS pomodoro_records (
    id TEXT PRIMARY KEY NOT NULL,
    todo_item_id TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT,
    duration INTEGER NOT NULL,
    actual_duration INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'work',
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);
"#;

// ============================================================================
// CHAT V2 DATABASE SCHEMA
// ============================================================================

const CHAT_V2_SCHEMA_SQL: &str = r#"
-- 1. chat_v2_sessions: chat sessions
CREATE TABLE IF NOT EXISTS chat_v2_sessions (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    title TEXT,
    persist_status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT,
    description TEXT,
    summary_hash TEXT,
    workspace_id TEXT,
    group_id TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    deleted_at TEXT
);

-- 2. chat_v2_messages: messages within sessions
CREATE TABLE IF NOT EXISTS chat_v2_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    block_ids_json TEXT NOT NULL DEFAULT '[]',
    timestamp INTEGER NOT NULL,
    persistent_stable_id TEXT,
    parent_id TEXT,
    supersedes TEXT,
    meta_json TEXT,
    attachments_json TEXT,
    active_variant_id TEXT,
    variants_json TEXT,
    shared_context_json TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 3. chat_v2_blocks: streaming content blocks
CREATE TABLE IF NOT EXISTS chat_v2_blocks (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    block_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    block_index INTEGER NOT NULL DEFAULT 0,
    content TEXT,
    tool_name TEXT,
    tool_input_json TEXT,
    tool_output_json TEXT,
    citations_json TEXT,
    error TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    variant_id TEXT,
    first_chunk_at INTEGER,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 4. chat_v2_attachments: file attachments on messages
CREATE TABLE IF NOT EXISTS chat_v2_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    preview_url TEXT,
    storage_path TEXT,
    error TEXT,
    content_hash TEXT,
    created_at TEXT NOT NULL,
    block_id TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 5. resources: chat_v2's own content-addressed resource store
CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('image', 'file', 'note', 'card', 'retrieval')),
    source_id TEXT,
    data TEXT,
    metadata_json TEXT,
    ref_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 6. chat_v2_session_mistakes: links sessions to mistakes (composite PK)
CREATE TABLE IF NOT EXISTS chat_v2_session_mistakes (
    session_id TEXT NOT NULL,
    mistake_id TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'primary',
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, mistake_id),
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 7. chat_v2_session_groups: session grouping
CREATE TABLE IF NOT EXISTS chat_v2_session_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    color TEXT,
    system_prompt TEXT,
    default_skill_ids_json TEXT DEFAULT '[]',
    workspace_id TEXT,
    sort_order INTEGER DEFAULT 0,
    persist_status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    deleted_at TEXT
);

-- 8. workspace_index: workspace registry
CREATE TABLE IF NOT EXISTS workspace_index (
    workspace_id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    creator_session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    deleted_at TEXT
);
"#;

// ============================================================================
// MISTAKES DATABASE SCHEMA
// ============================================================================

const MISTAKES_SCHEMA_SQL: &str = r#"
-- 1. mistakes: main mistakes table
CREATE TABLE IF NOT EXISTS mistakes (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    question_images TEXT NOT NULL,
    analysis_images TEXT NOT NULL,
    user_question TEXT NOT NULL,
    ocr_text TEXT NOT NULL,
    ocr_note TEXT,
    tags TEXT NOT NULL,
    mistake_type TEXT NOT NULL,
    status TEXT NOT NULL,
    chat_category TEXT NOT NULL DEFAULT 'analysis',
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
    chat_metadata TEXT,
    exam_sheet TEXT,
    autosave_signature TEXT,
    mistake_summary TEXT,
    user_error_analysis TEXT,
    irec_card_id TEXT,
    irec_status INTEGER DEFAULT 0,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    deleted_at TEXT
);

-- 2. chat_messages: mistake analysis chat messages (AUTOINCREMENT PK)
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    thinking_content TEXT,
    rag_sources TEXT,
    memory_sources TEXT,
    graph_sources TEXT,
    web_search_sources TEXT,
    image_paths TEXT,
    image_base64 TEXT,
    doc_attachments TEXT,
    tool_call TEXT,
    tool_result TEXT,
    overrides TEXT,
    relations TEXT,
    stable_id TEXT,
    turn_id TEXT,
    turn_seq SMALLINT,
    reply_to_msg_id INTEGER,
    message_kind TEXT,
    lifecycle TEXT,
    metadata TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 3. review_analyses: consolidated review analysis
CREATE TABLE IF NOT EXISTS review_analyses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    mistake_ids TEXT NOT NULL,
    consolidated_input TEXT NOT NULL,
    user_question TEXT NOT NULL,
    status TEXT NOT NULL,
    tags TEXT NOT NULL,
    analysis_type TEXT NOT NULL DEFAULT 'consolidated_review',
    temp_session_data TEXT,
    session_sequence INTEGER DEFAULT 0,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    deleted_at TEXT
);

-- 4. review_chat_messages: review analysis chat messages
CREATE TABLE IF NOT EXISTS review_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_analysis_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    thinking_content TEXT,
    rag_sources TEXT,
    memory_sources TEXT,
    web_search_sources TEXT,
    image_paths TEXT,
    image_base64 TEXT,
    doc_attachments TEXT,
    tool_call TEXT,
    tool_result TEXT,
    overrides TEXT,
    relations TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 5. review_sessions: note review sessions
CREATE TABLE IF NOT EXISTS review_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    deleted_at TEXT
);

-- 6. review_session_mistakes: composite PK junction
CREATE TABLE IF NOT EXISTS review_session_mistakes (
    session_id TEXT NOT NULL,
    mistake_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, mistake_id),
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 7. anki_cards: generated Anki cards
CREATE TABLE IF NOT EXISTS anki_cards (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    tags_json TEXT DEFAULT '[]',
    images_json TEXT DEFAULT '[]',
    is_error_card INTEGER NOT NULL DEFAULT 0,
    error_content TEXT,
    card_order_in_task INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    extra_fields_json TEXT DEFAULT '{}',
    template_id TEXT,
    source_type TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT '',
    text TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    deleted_at TEXT
);
"#;

// ============================================================================
// LLM USAGE DATABASE SCHEMA
// ============================================================================

const LLM_USAGE_SCHEMA_SQL: &str = r#"
-- 1. llm_usage_logs: detailed LLM API usage records
CREATE TABLE IF NOT EXISTS llm_usage_logs (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    adapter TEXT,
    api_config_id TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER,
    cached_tokens INTEGER,
    token_source TEXT NOT NULL DEFAULT 'api',
    duration_ms INTEGER,
    request_bytes INTEGER,
    response_bytes INTEGER,
    first_token_ms INTEGER,
    caller_type TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'success',
    error_message TEXT,
    cost_estimate REAL,
    date_key TEXT GENERATED ALWAYS AS (substr(timestamp, 1, 10)) STORED,
    hour_key TEXT GENERATED ALWAYS AS (substr(timestamp, 1, 13)) STORED,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);
"#;

// ============================================================================
// ALL CHANGE LOG TRIGGERS (INSERT/UPDATE/DELETE for every RowSync table)
// ============================================================================

const ALL_TRIGGERS_SQL: &str = r#"
-- ── VFS tables ──
CREATE TRIGGER IF NOT EXISTS trg__cl_resources_ins AFTER INSERT ON resources BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_resources_upd AFTER UPDATE ON resources BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_resources_del AFTER DELETE ON resources BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_notes_ins AFTER INSERT ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_notes_upd AFTER UPDATE ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_notes_del AFTER DELETE ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_files_ins AFTER INSERT ON files BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('files', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_files_upd AFTER UPDATE ON files BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('files', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_files_del AFTER DELETE ON files BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('files', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_exam_sheets_ins AFTER INSERT ON exam_sheets BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('exam_sheets', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_exam_sheets_upd AFTER UPDATE ON exam_sheets BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('exam_sheets', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_exam_sheets_del AFTER DELETE ON exam_sheets BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('exam_sheets', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_translations_ins AFTER INSERT ON translations BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('translations', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_translations_upd AFTER UPDATE ON translations BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('translations', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_translations_del AFTER DELETE ON translations BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('translations', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_essays_ins AFTER INSERT ON essays BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('essays', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_essays_upd AFTER UPDATE ON essays BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('essays', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_essays_del AFTER DELETE ON essays BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('essays', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_essay_sessions_ins AFTER INSERT ON essay_sessions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('essay_sessions', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_essay_sessions_upd AFTER UPDATE ON essay_sessions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('essay_sessions', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_essay_sessions_del AFTER DELETE ON essay_sessions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('essay_sessions', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_mindmaps_ins AFTER INSERT ON mindmaps BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('mindmaps', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_mindmaps_upd AFTER UPDATE ON mindmaps BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('mindmaps', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_mindmaps_del AFTER DELETE ON mindmaps BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('mindmaps', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_folders_ins AFTER INSERT ON folders BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('folders', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_folders_upd AFTER UPDATE ON folders BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('folders', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_folders_del AFTER DELETE ON folders BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('folders', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_folder_items_ins AFTER INSERT ON folder_items BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('folder_items', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_folder_items_upd AFTER UPDATE ON folder_items BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('folder_items', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_folder_items_del AFTER DELETE ON folder_items BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('folder_items', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_questions_ins AFTER INSERT ON questions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('questions', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_questions_upd AFTER UPDATE ON questions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('questions', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_questions_del AFTER DELETE ON questions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('questions', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_answer_submissions_ins AFTER INSERT ON answer_submissions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('answer_submissions', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_answer_submissions_upd AFTER UPDATE ON answer_submissions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('answer_submissions', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_answer_submissions_del AFTER DELETE ON answer_submissions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('answer_submissions', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_review_plans_ins AFTER INSERT ON review_plans BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_plans', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_review_plans_upd AFTER UPDATE ON review_plans BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_plans', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_review_plans_del AFTER DELETE ON review_plans BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_plans', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_todo_lists_ins AFTER INSERT ON todo_lists BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('todo_lists', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_todo_lists_upd AFTER UPDATE ON todo_lists BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('todo_lists', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_todo_lists_del AFTER DELETE ON todo_lists BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('todo_lists', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_todo_items_ins AFTER INSERT ON todo_items BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('todo_items', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_todo_items_upd AFTER UPDATE ON todo_items BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('todo_items', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_todo_items_del AFTER DELETE ON todo_items BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('todo_items', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_pomodoro_records_ins AFTER INSERT ON pomodoro_records BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('pomodoro_records', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_pomodoro_records_upd AFTER UPDATE ON pomodoro_records BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('pomodoro_records', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_pomodoro_records_del AFTER DELETE ON pomodoro_records BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('pomodoro_records', OLD.id, 'DELETE');
END;

-- ── Chat V2 tables ──
CREATE TRIGGER IF NOT EXISTS trg__cl_sessions_ins AFTER INSERT ON chat_v2_sessions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_sessions', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_sessions_upd AFTER UPDATE ON chat_v2_sessions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_sessions', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_sessions_del AFTER DELETE ON chat_v2_sessions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_sessions', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_messages_ins AFTER INSERT ON chat_v2_messages BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_messages', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_messages_upd AFTER UPDATE ON chat_v2_messages BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_messages', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_messages_del AFTER DELETE ON chat_v2_messages BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_messages', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_blocks_ins AFTER INSERT ON chat_v2_blocks BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_blocks', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_blocks_upd AFTER UPDATE ON chat_v2_blocks BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_blocks', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_blocks_del AFTER DELETE ON chat_v2_blocks BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_blocks', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_attachments_ins AFTER INSERT ON chat_v2_attachments BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_attachments', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_attachments_upd AFTER UPDATE ON chat_v2_attachments BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_attachments', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_attachments_del AFTER DELETE ON chat_v2_attachments BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_attachments', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_cv2_resources_ins AFTER INSERT ON resources BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_cv2_resources_upd AFTER UPDATE ON resources BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_cv2_resources_del AFTER DELETE ON resources BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_session_mistakes_ins AFTER INSERT ON chat_v2_session_mistakes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_session_mistakes', NEW.session_id || ':' || NEW.mistake_id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_session_mistakes_upd AFTER UPDATE ON chat_v2_session_mistakes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_session_mistakes', NEW.session_id || ':' || NEW.mistake_id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_session_mistakes_del AFTER DELETE ON chat_v2_session_mistakes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_session_mistakes', OLD.session_id || ':' || OLD.mistake_id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_session_groups_ins AFTER INSERT ON chat_v2_session_groups BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_session_groups', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_session_groups_upd AFTER UPDATE ON chat_v2_session_groups BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_session_groups', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_session_groups_del AFTER DELETE ON chat_v2_session_groups BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_v2_session_groups', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_workspace_index_ins AFTER INSERT ON workspace_index BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('workspace_index', NEW.workspace_id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_workspace_index_upd AFTER UPDATE ON workspace_index BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('workspace_index', NEW.workspace_id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_workspace_index_del AFTER DELETE ON workspace_index BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('workspace_index', OLD.workspace_id, 'DELETE');
END;

-- ── Mistakes tables ──
CREATE TRIGGER IF NOT EXISTS trg__cl_mistakes_ins AFTER INSERT ON mistakes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('mistakes', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_mistakes_upd AFTER UPDATE ON mistakes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('mistakes', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_mistakes_del AFTER DELETE ON mistakes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('mistakes', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_chat_messages_ins AFTER INSERT ON chat_messages BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_messages', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_chat_messages_upd AFTER UPDATE ON chat_messages BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_messages', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_chat_messages_del AFTER DELETE ON chat_messages BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('chat_messages', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_review_analyses_ins AFTER INSERT ON review_analyses BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_analyses', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_review_analyses_upd AFTER UPDATE ON review_analyses BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_analyses', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_review_analyses_del AFTER DELETE ON review_analyses BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_analyses', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_review_chat_msgs_ins AFTER INSERT ON review_chat_messages BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_chat_messages', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_review_chat_msgs_upd AFTER UPDATE ON review_chat_messages BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_chat_messages', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_review_chat_msgs_del AFTER DELETE ON review_chat_messages BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_chat_messages', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_review_sessions_ins AFTER INSERT ON review_sessions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_sessions', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_review_sessions_upd AFTER UPDATE ON review_sessions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_sessions', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_review_sessions_del AFTER DELETE ON review_sessions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_sessions', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_rev_session_mistakes_ins AFTER INSERT ON review_session_mistakes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_session_mistakes', NEW.session_id || ':' || NEW.mistake_id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_rev_session_mistakes_upd AFTER UPDATE ON review_session_mistakes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_session_mistakes', NEW.session_id || ':' || NEW.mistake_id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_rev_session_mistakes_del AFTER DELETE ON review_session_mistakes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('review_session_mistakes', OLD.session_id || ':' || OLD.mistake_id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__cl_anki_cards_ins AFTER INSERT ON anki_cards BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('anki_cards', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_anki_cards_upd AFTER UPDATE ON anki_cards BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('anki_cards', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_anki_cards_del AFTER DELETE ON anki_cards BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('anki_cards', OLD.id, 'DELETE');
END;

-- ── LLM Usage tables ──
CREATE TRIGGER IF NOT EXISTS trg__cl_llm_usage_logs_ins AFTER INSERT ON llm_usage_logs BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('llm_usage_logs', NEW.id, 'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_llm_usage_logs_upd AFTER UPDATE ON llm_usage_logs BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('llm_usage_logs', NEW.id, 'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__cl_llm_usage_logs_del AFTER DELETE ON llm_usage_logs BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('llm_usage_logs', OLD.id, 'DELETE');
END;
"#;

// ============================================================================
// SYNC OPERATIONS
// ============================================================================

/// Simulates a device uploading its pending changes to the cloud.
/// Scans `__change_log` for rows with `sync_version = 0`, serializes
/// the corresponding records, and stores them in the cloud store.
/// Marks the uploaded change log entries as synced.
pub fn device_sync_upload(device: &SyncDevice, cloud: &SimulatedCloudStore) -> usize {
    let conn = &device.conn;
    let mut uploaded = 0usize;

    let mut stmt = conn
        .prepare(
            "SELECT id, table_name, record_id, operation FROM __change_log WHERE sync_version = 0",
        )
        .unwrap();

    let rows: Vec<(i64, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    for (log_id, table_name, record_id, operation) in &rows {
        let key = format!("{}/{}/{}", &device.device_id, table_name, record_id);

        // Serialize the record as JSON bytes
        let data = serialize_record_to_json(conn, table_name, record_id);

        cloud.put(&key, &data);

        // Mark as synced
        conn.execute(
            "UPDATE __change_log SET sync_version = 1 WHERE id = ?1",
            params![log_id],
        )
        .unwrap();

        log_sync(
            &device.name,
            "UPLOAD",
            Some(table_name),
            Some(record_id),
            &format!("op={}, bytes={}", operation, data.len()),
            true,
        );
        uploaded += 1;
    }

    log_sync(
        &device.name,
        "UPLOAD_COMPLETE",
        None,
        None,
        &format!("uploaded {} changes", uploaded),
        true,
    );
    uploaded
}

/// Simulates a device downloading changes from the cloud.
/// Lists all keys for the device prefix, compares with local state,
/// and applies remote changes to the local database.
pub fn device_sync_download(device: &SyncDevice, cloud: &SimulatedCloudStore) -> usize {
    let conn = &device.conn;
    let mut downloaded = 0usize;

    let keys = cloud.list(&format!("{}/", &device.device_id));

    for key in &keys {
        // Key format: "dev-id/table_name/record_id"
        let parts: Vec<&str> = key.splitn(3, '/').collect();
        if parts.len() < 3 {
            continue;
        }
        let table_name = parts[1];
        let record_id = parts[2];

        if let Some(data) = cloud.get(key) {
            let result = replay_remote_record(conn, table_name, record_id, &data);

            log_sync(
                &device.name,
                "DOWNLOAD",
                Some(table_name),
                Some(record_id),
                &format!("bytes={}, applied={}", data.len(), result),
                result,
            );
            if result {
                downloaded += 1;
            }
        }
    }

    log_sync(
        &device.name,
        "DOWNLOAD_COMPLETE",
        None,
        None,
        &format!("downloaded {} changes", downloaded),
        true,
    );
    downloaded
}

/// Bidirectional sync: upload then download.
pub fn device_sync_bidirectional(device: &SyncDevice, cloud: &SimulatedCloudStore) -> (usize, usize) {
    let up = device_sync_upload(device, cloud);
    let down = device_sync_download(device, cloud);
    log_sync(
        &device.name,
        "BIDIRECTIONAL_COMPLETE",
        None,
        None,
        &format!("up={}, down={}", up, down),
        true,
    );
    (up, down)
}

/// Complete round-trip: A uploads → B downloads → B uploads → A downloads.
/// Ensures changes made on either device propagate to the other.
pub fn full_sync_cycle(
    device_a: &SyncDevice,
    device_b: &SyncDevice,
    cloud: &SimulatedCloudStore,
) -> (usize, usize, usize, usize) {
    log_sync("SYSTEM", "CYCLE_START", None, None, "", true);

    // Phase 1: A's changes → cloud
    let a_up = device_sync_upload(device_a, cloud);

    // Phase 2: B pulls A's changes
    let b_down = device_sync_download(device_b, cloud);

    // Phase 3: B's changes → cloud
    let b_up = device_sync_upload(device_b, cloud);

    // Phase 4: A pulls B's changes (plus any merge results)
    let a_down = device_sync_download(device_a, cloud);

    log_sync(
        "SYSTEM",
        "CYCLE_COMPLETE",
        None,
        None,
        &format!(
            "a_up={}, b_down={}, b_up={}, a_down={}",
            a_up, b_down, b_up, a_down
        ),
        true,
    );
    (a_up, b_down, b_up, a_down)
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// Serializes a record's current row data as JSON bytes
fn serialize_record_to_json(conn: &Connection, table_name: &str, record_id: &str) -> Vec<u8> {
    let pk_col = pk_column_for(table_name);
    let query = format!("SELECT * FROM \"{}\" WHERE {} = ?1", table_name, pk_col);

    match conn.prepare(&query) {
        Ok(mut stmt) => {
            let result: Option<HashMap<String, Value>> = stmt
                .query_row(params![record_id], |row| {
                    let names: Vec<String> = (0..row.as_ref().column_count())
                        .map(|i| row.as_ref().column_name(i).unwrap().to_string())
                        .collect();
                    let mut map = HashMap::new();
                    let mut idx = 0;
                    for name in &names {
                        let val: rusqlite::types::Value = row.get_unwrap(idx);
                        idx += 1;
                        match val {
                            rusqlite::types::Value::Null => { map.insert(name.clone(), Value::Null); }
                            rusqlite::types::Value::Integer(i) => { map.insert(name.clone(), Value::Number(i.into())); }
                            rusqlite::types::Value::Real(f) => {
                                if let Some(n) = serde_json::Number::from_f64(f) {
                                    map.insert(name.clone(), Value::Number(n));
                                } else {
                                    map.insert(name.clone(), Value::Null);
                                }
                            }
                            rusqlite::types::Value::Text(s) => { map.insert(name.clone(), Value::String(s)); }
                            rusqlite::types::Value::Blob(_) => { map.insert(name.clone(), Value::Null); }
                        }
                    }
                    Ok(map)
                })
                .optional()
                .ok()
                .flatten();
            match result {
                Some(map) => serde_json::to_vec(&map).unwrap_or_default(),
                None => vec![],
            }
        }
        Err(_) => vec![],
    }
}

/// Applies a remote record to the local database (simple UPSERT via INSERT OR REPLACE)
fn replay_remote_record(
    conn: &Connection,
    table_name: &str,
    _record_id: &str,
    data: &[u8],
) -> bool {
    let map: HashMap<String, Value> = match serde_json::from_slice(data) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if map.is_empty() {
        return false;
    }

    // Build INSERT OR REPLACE statement
    let columns: Vec<String> = map.keys().cloned().collect();
    let placeholders: Vec<String> = columns.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
    let sql = format!(
        "INSERT OR REPLACE INTO \"{}\" ({}) VALUES ({})",
        table_name,
        columns.join(", "),
        placeholders.join(", ")
    );

    match conn.prepare(&sql) {
        Ok(mut stmt) => {
            let params: Vec<Box<dyn rusqlite::types::ToSql>> = columns
                .iter()
                .map(|col| {
                    let v = map.get(col).cloned().unwrap_or(Value::Null);
                    let boxed: Box<dyn rusqlite::types::ToSql> = match v {
                        Value::Null => Box::new(rusqlite::types::Null),
                        Value::String(s) => Box::new(s),
                        Value::Number(n) => {
                            if let Some(i) = n.as_i64() {
                                Box::new(i)
                            } else {
                                Box::new(n.as_f64().unwrap_or(0.0))
                            }
                        }
                        Value::Bool(b) => Box::new(b as i64),
                        _ => Box::new(rusqlite::types::Null),
                    };
                    boxed
                })
                .collect::<Vec<Box<dyn rusqlite::types::ToSql>>>();
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                params.iter().map(|p| p.as_ref()).collect();
            stmt.execute(param_refs.as_slice()).is_ok()
        }
        Err(_) => false,
    }
}

/// Maps a table name to its primary key column name
fn pk_column_for(table_name: &str) -> &'static str {
    match table_name {
        "workspace_index" => "workspace_id",
        "chat_v2_session_mistakes" => "session_id",
        "review_session_mistakes" => "session_id",
        _ => "id",
    }
}

// ============================================================================
// VERIFICATION UTILITIES
// ============================================================================

/// Compares row counts across both devices for every RowSync table.
pub fn verify_devices_converged(device_a: &SyncDevice, device_b: &SyncDevice) -> bool {
    let tables = all_row_sync_table_names();
    let mut converged = true;

    for table in &tables {
        let count_a = count_table(device_a, table);
        let count_b = count_table(device_b, table);

        if count_a != count_b {
            log_sync(
                "VERIFY",
                "DIVERGENCE",
                Some(table),
                None,
                &format!(
                    "A:{} rows vs B:{} rows",
                    count_a, count_b
                ),
                false,
            );
            converged = false;
        }
    }

    if converged {
        log_sync("VERIFY", "CONVERGED", None, None, "All tables match", true);
    }
    converged
}

/// Counts rows in a table (excluding deleted records).
pub fn count_table(device: &SyncDevice, table: &str) -> usize {
    if has_column(&device.conn, table, "deleted_at") {
        device
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM \"{}\" WHERE deleted_at IS NULL", table),
                [],
                |row| row.get::<_, usize>(0),
            )
            .unwrap_or(0)
    } else {
        device
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM \"{}\"", table),
                [],
                |row| row.get::<_, usize>(0),
            )
            .unwrap_or(0)
    }
}

/// Gets total row count including deleted records.
pub fn count_table_all(device: &SyncDevice, table: &str) -> usize {
    device
        .conn
        .query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table),
            [],
            |row| row.get::<_, usize>(0),
        )
        .unwrap_or(0)
}

/// Retrieves a single record as a `HashMap<String, Value>`.
pub fn get_record(
    device: &SyncDevice,
    table: &str,
    id_col: &str,
    id_val: &str,
) -> Option<HashMap<String, Value>> {
    let query = format!("SELECT * FROM \"{}\" WHERE {} = ?1", table, id_col);
    let mut stmt = device.conn.prepare(&query).ok()?;
    stmt.query_row(params![id_val], |row| {
        let names: Vec<String> = (0..row.as_ref().column_count())
            .map(|i| row.as_ref().column_name(i).unwrap().to_string())
            .collect();
        let mut map = HashMap::new();
        let mut idx = 0;
        for name in &names {
            let val: rusqlite::types::Value = row.get_unwrap(idx);
            idx += 1;
            match val {
                rusqlite::types::Value::Null => {
                    map.insert(name.clone(), Value::Null);
                }
                rusqlite::types::Value::Integer(i) => {
                    map.insert(name.clone(), Value::Number(i.into()));
                }
                rusqlite::types::Value::Real(f) => {
                    if let Some(n) = serde_json::Number::from_f64(f) {
                        map.insert(name.clone(), Value::Number(n));
                    } else {
                        map.insert(name.clone(), Value::Null);
                    }
                }
                rusqlite::types::Value::Text(s) => {
                    map.insert(name.clone(), Value::String(s));
                }
                rusqlite::types::Value::Blob(_) => {
                    map.insert(name.clone(), Value::Null);
                }
            }
        }
        Ok(map)
    })
    .ok()
}

/// Checks that no unsynchronized changes remain in `__change_log`.
pub fn verify_no_pending_changes(device: &SyncDevice) -> bool {
    let count = device.pending_changes_count();
    if count > 0 {
        log_sync(
            &device.name,
            "PENDING_CHANGES",
            None,
            None,
            &format!("{} unsynchronized change log entries", count),
            false,
        );
        return false;
    }
    true
}

/// Checks whether a table has a specific column.
fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |row| row.get::<_, usize>(0),
    )
    .unwrap_or(0)
        > 0
}

/// Returns the list of all RowSync table names.
pub fn all_row_sync_table_names() -> Vec<&'static str> {
    vec![
        // VFS
        "resources", "notes", "files", "exam_sheets", "translations",
        "essays", "essay_sessions", "mindmaps", "folders", "folder_items",
        "questions", "answer_submissions", "review_plans",
        "todo_lists", "todo_items", "pomodoro_records",
        // Chat V2
        "chat_v2_sessions", "chat_v2_messages", "chat_v2_blocks",
        "chat_v2_attachments", "chat_v2_session_mistakes",
        "chat_v2_session_groups", "workspace_index",
        // Mistakes
        "mistakes", "chat_messages", "review_analyses",
        "review_chat_messages", "review_sessions", "review_session_mistakes",
        "anki_cards",
        // LLM Usage
        "llm_usage_logs",
    ]
}

// ============================================================================
// DATA GENERATORS — Insert realistic test data
// ============================================================================

pub fn create_test_resource(device: &SyncDevice, id: &str, hash: &str, data: &str) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    device.conn.execute(
        "INSERT INTO resources (id, hash, type, data, ref_count, created_at, updated_at, device_id)
         VALUES (?1, ?2, 'note', ?3, 1, ?4, ?4, ?5)",
        params![id, hash, data, now_ms, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("resources"), Some(id), &format!("hash={}", hash), true);
}

pub fn create_test_note(device: &SyncDevice, id: &str, resource_id: &str, title: &str, tags: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO notes (id, resource_id, title, tags, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        params![id, resource_id, title, tags, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("notes"), Some(id), title, true);
}

pub fn create_test_question(device: &SyncDevice, id: &str, exam_id: &str, content: &str, answer: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO questions (id, exam_id, content, answer, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        params![id, exam_id, content, answer, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("questions"), Some(id), content, true);
}

pub fn create_test_session(device: &SyncDevice, id: &str, title: &str, mode: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO chat_v2_sessions (id, mode, title, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![id, mode, title, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("chat_v2_sessions"), Some(id), title, true);
}

pub fn create_test_message(device: &SyncDevice, id: &str, session_id: &str, role: &str) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    device.conn.execute(
        "INSERT INTO chat_v2_messages (id, session_id, role, timestamp, block_ids_json, device_id)
         VALUES (?1, ?2, ?3, ?4, '[]', ?5)",
        params![id, session_id, role, now_ms, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("chat_v2_messages"), Some(id), role, true);
}

pub fn create_test_block(device: &SyncDevice, id: &str, message_id: &str, block_type: &str, content: &str) {
    device.conn.execute(
        "INSERT INTO chat_v2_blocks (id, message_id, block_type, content, status, device_id)
         VALUES (?1, ?2, ?3, ?4, 'completed', ?5)",
        params![id, message_id, block_type, content, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("chat_v2_blocks"), Some(id), block_type, true);
}

pub fn create_test_mistake(device: &SyncDevice, id: &str, user_question: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO mistakes (id, created_at, question_images, analysis_images, user_question,
         ocr_text, tags, mistake_type, status, updated_at, device_id)
         VALUES (?1, ?2, '[]', '[]', ?3, '', '[]', 'calculation', 'new', ?2, ?4)",
        params![id, now, user_question, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("mistakes"), Some(id), user_question, true);
}

pub fn create_test_anki_card(device: &SyncDevice, id: &str, front: &str, back: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO anki_cards (id, task_id, front, back, created_at, updated_at, device_id)
         VALUES (?1, 'task_000', ?2, ?3, ?4, ?4, ?5)",
        params![id, front, back, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("anki_cards"), Some(id), front, true);
}

pub fn create_test_exam_sheet(device: &SyncDevice, id: &str, exam_name: &str, status: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, 'temp_001', '{}', '{}', ?4, ?4, ?5)",
        params![id, exam_name, status, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("exam_sheets"), Some(id), exam_name, true);
}

pub fn create_test_essay(device: &SyncDevice, id: &str, resource_id: &str, title: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO essays (id, resource_id, title, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![id, resource_id, title, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("essays"), Some(id), title, true);
}

pub fn create_test_file(device: &SyncDevice, id: &str, file_name: &str, sha256: &str, size: i64) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO files (id, sha256, file_name, size, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        params![id, sha256, file_name, size, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("files"), Some(id), file_name, true);
}

pub fn create_test_folder(device: &SyncDevice, id: &str, title: &str, parent_id: Option<&str>) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    device.conn.execute(
        "INSERT INTO folders (id, parent_id, title, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![id, parent_id, title, now_ms, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("folders"), Some(id), title, true);
}

pub fn create_test_todo_list(device: &SyncDevice, id: &str, title: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO todo_lists (id, title, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?3, ?4)",
        params![id, title, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("todo_lists"), Some(id), title, true);
}

pub fn create_test_todo_item(device: &SyncDevice, id: &str, todo_list_id: &str, title: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO todo_items (id, todo_list_id, title, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![id, todo_list_id, title, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("todo_items"), Some(id), title, true);
}

pub fn create_test_usage_log(device: &SyncDevice, id: &str, provider: &str, model: &str, caller_type: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO llm_usage_logs (id, timestamp, provider, model, caller_type, prompt_tokens, completion_tokens, total_tokens, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, 100, 50, 150, ?6)",
        params![id, now, provider, model, caller_type, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("llm_usage_logs"), Some(id), &format!("{}/{}", provider, model), true);
}

pub fn create_test_translation(device: &SyncDevice, id: &str, resource_id: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO translations (id, resource_id, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?3, ?4)",
        params![id, resource_id, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("translations"), Some(id), "", true);
}

pub fn create_test_mindmap(device: &SyncDevice, id: &str, resource_id: &str, title: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO mindmaps (id, resource_id, title, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![id, resource_id, title, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("mindmaps"), Some(id), title, true);
}

pub fn create_test_review_plan(device: &SyncDevice, id: &str, question_id: &str, exam_id: &str) {
    let now = chrono_now_iso();
    let tomorrow = chrono_tomorrow_iso();
    device.conn.execute(
        "INSERT INTO review_plans (id, question_id, exam_id, next_review_date, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        params![id, question_id, exam_id, tomorrow, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("review_plans"), Some(id), "", true);
}

pub fn create_test_pomodoro_record(device: &SyncDevice, id: &str, todo_item_id: &str) {
    let now = chrono_now_iso();
    device.conn.execute(
        "INSERT INTO pomodoro_records (id, todo_item_id, start_time, duration, created_at, device_id)
         VALUES (?1, ?2, ?3, 1500, ?3, ?4)",
        params![id, todo_item_id, now, device.device_id],
    ).unwrap();
    log_sync(&device.name, "INSERT", Some("pomodoro_records"), Some(id), "", true);
}

// ============================================================================
// TIME HELPERS
// ============================================================================

fn chrono_now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn chrono_tomorrow_iso() -> String {
    (chrono::Utc::now() + chrono::Duration::days(1))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}
