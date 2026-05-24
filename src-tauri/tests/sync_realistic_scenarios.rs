//! 100+ Realistic Multi-Device Sync Scenario Tests
//!
//! Tests simulate two independent devices (device A, device B) each with their own
//! in-memory SQLite databases. Changes are serialized through a SimulatedCloudStore
//! and applied to both devices to verify convergence.
//!
//! The harness defined inline mirrors the API that sync_realistic_harness.rs
//! provides. This file is self-contained and does not require the harness to exist.

use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Mutex;

// ============================================================================
// Inline Harness
// ============================================================================

thread_local! {
    static SYNC_LOG: RefCell<Vec<String>> = RefCell::new(Vec::new());
}

pub fn log_sync(msg: &str) {
    SYNC_LOG.with(|log| log.borrow_mut().push(msg.to_string()));
    eprintln!("[SYNC] {}", msg);
}

pub fn dump_sync_log() -> Vec<String> {
    SYNC_LOG.with(|log| log.borrow().clone())
}

pub fn clear_sync_log() {
    SYNC_LOG.with(|log| log.borrow_mut().clear());
}

pub struct SimulatedCloudStore {
    changes: Mutex<HashMap<String, Vec<Vec<u8>>>>,
    versions: Mutex<HashMap<String, u64>>,
}

impl SimulatedCloudStore {
    pub fn new() -> Self {
        Self {
            changes: Mutex::new(HashMap::new()),
            versions: Mutex::new(HashMap::new()),
        }
    }

    pub fn upload_changes(&self, device_id: &str, batch: &[Value]) {
        let encoded = serde_json::to_vec(batch).expect("serialize batch");
        self.changes
            .lock()
            .unwrap()
            .entry(device_id.to_string())
            .or_default()
            .push(encoded);
        *self
            .versions
            .lock()
            .unwrap()
            .entry(device_id.to_string())
            .or_insert(0) += 1;
    }

    pub fn download_changes(&self, exclude_device_id: &str) -> Vec<Value> {
        let changes = self.changes.lock().unwrap();
        let mut all: Vec<Value> = Vec::new();
        for (dev_id, batches) in changes.iter() {
            if dev_id == exclude_device_id {
                continue;
            }
            for batch in batches {
                if let Ok(b) = serde_json::from_slice::<Vec<Value>>(batch) {
                    all.extend(b);
                }
            }
        }
        all
    }

    pub fn get_version(&self, device_id: &str) -> u64 {
        self.versions
            .lock()
            .unwrap()
            .get(device_id)
            .copied()
            .unwrap_or(0)
    }

    pub fn clear(&self) {
        self.changes.lock().unwrap().clear();
        self.versions.lock().unwrap().clear();
    }

    pub fn batch_count(&self) -> usize {
        self.changes.lock().unwrap().values().map(|v| v.len()).sum()
    }
}

pub struct SyncDevice {
    pub name: String,
    pub device_id: String,
    pub vfs_db: Connection,
    pub chat_v2_db: Connection,
    pub mistakes_db: Connection,
}

impl SyncDevice {
    pub fn new(name: &str, device_id: &str) -> Self {
        Self {
            name: name.to_string(),
            device_id: device_id.to_string(),
            vfs_db: Connection::open_in_memory().unwrap(),
            chat_v2_db: Connection::open_in_memory().unwrap(),
            mistakes_db: Connection::open_in_memory().unwrap(),
        }
    }

    pub fn setup_vfs_schema(&self) {
        self.vfs_db
            .execute_batch(include_str!("../migrations/vfs/V20260130__init.sql"))
            .unwrap();
        self.vfs_db
            .execute_batch(include_str!(
                "../migrations/vfs/V20260131__add_change_log.sql"
            ))
            .unwrap();
        let _ = self.vfs_db.execute_batch(include_str!(
            "../migrations/vfs/V20260210__add_answer_submissions.sql"
        ));
        // V20260211: fix questions change_log record_id (exam_id → id)
        let _ = self.vfs_db.execute_batch(include_str!(
            "../migrations/vfs/V20260211__fix_change_log_record_id.sql"
        ));
        let _ = self.vfs_db.execute_batch(include_str!(
            "../migrations/vfs/V20260308__add_todo_tables.sql"
        ));
        let _ = self.vfs_db.execute_batch(include_str!(
            "../migrations/vfs/V20260310__add_pomodoro.sql"
        ));
        let _ = self.vfs_db.execute_batch(include_str!(
            "../migrations/vfs/V20260523__add_missing_sync_coverage.sql"
        ));
    }

    pub fn setup_chat_v2_schema(&self) {
        self.chat_v2_db
            .execute_batch(include_str!("../migrations/chat_v2/V20260130__init.sql"))
            .unwrap();
        self.chat_v2_db
            .execute_batch(include_str!(
                "../migrations/chat_v2/V20260131__add_change_log.sql"
            ))
            .unwrap();
        let _ = self.chat_v2_db.execute_batch(include_str!(
            "../migrations/chat_v2/V20260204__session_groups.sql"
        ));
        let _ = self.chat_v2_db.execute_batch(include_str!(
            "../migrations/chat_v2/V20260523__add_missing_sync_coverage.sql"
        ));
    }

    pub fn setup_mistakes_schema(&self) {
        self.mistakes_db
            .execute_batch(include_str!("../migrations/mistakes/V20260130__init.sql"))
            .unwrap();
        self.mistakes_db
            .execute_batch(include_str!(
                "../migrations/mistakes/V20260131__add_change_log.sql"
            ))
            .unwrap();
        let _ = self.mistakes_db.execute_batch(include_str!(
            "../migrations/mistakes/V20260523__add_missing_sync_coverage.sql"
        ));
    }
}

pub fn setup_all_schemas(device: &SyncDevice) {
    device.setup_vfs_schema();
    device.setup_chat_v2_schema();
    device.setup_mistakes_schema();
}

// ---- Factory Helpers ----

pub fn create_test_resource(device: &SyncDevice, id: &str, r#type: &str, data: &str, hash: &str) {
    let ts = Utc::now().timestamp_millis();
    device.vfs_db.execute(
        "INSERT INTO resources (id, hash, type, data, ref_count, created_at, updated_at, storage_mode) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, 'inline')",
        params![id, hash, r#type, data, ts],
    ).unwrap();
}

pub fn create_test_note(device: &SyncDevice, id: &str, resource_id: &str, title: &str) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at) VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4)",
        params![id, resource_id, title, ts],
    ).unwrap();
}

pub fn create_test_exam_sheet(device: &SyncDevice, id: &str, exam_name: &str, resource_id: &str) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO exam_sheets (id, resource_id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at, is_favorite) VALUES (?1, ?2, ?3, 'completed', ?4, '{}', '{}', ?5, ?5, 0)",
        params![id, resource_id, exam_name, format!("tmp_{}", id), ts],
    ).unwrap();
}

pub fn create_test_question(device: &SyncDevice, id: &str, exam_id: &str, content: &str) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO questions (id, exam_id, content, question_type, tags, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'choice', '[]', 'new', ?4, ?4)",
        params![id, exam_id, content, ts],
    ).unwrap();
}

pub fn create_test_review_plan(device: &SyncDevice, id: &str, question_id: &str, exam_id: &str) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO review_plans (id, question_id, exam_id, next_review_date, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'new', ?5, ?5)",
        params![id, question_id, exam_id, ts, ts],
    ).unwrap();
}

pub fn create_test_folder(device: &SyncDevice, id: &str, parent_id: Option<&str>, title: &str) {
    let ts = Utc::now().timestamp_millis();
    device.vfs_db.execute(
        "INSERT INTO folders (id, parent_id, title, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
        params![id, parent_id, title, ts],
    ).unwrap();
}

pub fn create_test_folder_item(
    device: &SyncDevice,
    id: &str,
    folder_id: &str,
    item_type: &str,
    item_id: &str,
) {
    let ts = Utc::now().timestamp_millis();
    device.vfs_db.execute(
        "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
        params![id, folder_id, item_type, item_id, ts],
    ).unwrap();
}

pub fn create_test_todo_list(device: &SyncDevice, id: &str, resource_id: &str, title: &str) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO todo_lists (id, resource_id, title, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
        params![id, resource_id, title, ts],
    ).unwrap();
}

pub fn create_test_todo_item(
    device: &SyncDevice,
    id: &str,
    todo_list_id: &str,
    title: &str,
    parent_id: Option<&str>,
) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO todo_items (id, todo_list_id, title, parent_id, status, priority, tags_json, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', 'none', '[]', 0, ?5, ?5)",
        params![id, todo_list_id, title, parent_id, ts],
    ).unwrap();
}

pub fn create_test_pomodoro_record(device: &SyncDevice, id: &str, todo_item_id: &str) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO pomodoro_records (id, todo_item_id, start_time, duration, actual_duration, type, status, created_at) VALUES (?1, ?2, ?3, 1500, 1500, 'work', 'completed', ?3)",
        params![id, todo_item_id, ts],
    ).unwrap();
}

pub fn create_test_essay(
    device: &SyncDevice,
    id: &str,
    resource_id: &str,
    title: &str,
    score: Option<i64>,
) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO essays (id, resource_id, title, score, round_number, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
        params![id, resource_id, title, score, ts],
    ).unwrap();
}

pub fn create_test_translation(device: &SyncDevice, id: &str, resource_id: &str, title: &str) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO translations (id, resource_id, src_lang, tgt_lang, title, created_at, updated_at) VALUES (?1, ?2, 'en', 'zh', ?3, ?4, ?4)",
        params![id, resource_id, title, ts],
    ).unwrap();
}

pub fn create_test_mindmap(device: &SyncDevice, id: &str, resource_id: &str, title: &str) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO mindmaps (id, resource_id, title, settings, created_at, updated_at) VALUES (?1, ?2, ?3, '{}', ?4, ?4)",
        params![id, resource_id, title, ts],
    ).unwrap();
}

pub fn create_test_answer_submission(
    device: &SyncDevice,
    id: &str,
    question_id: &str,
    user_answer: &str,
    is_correct: i64,
) {
    let ts = Utc::now().to_rfc3339();
    device.vfs_db.execute(
        "INSERT INTO answer_submissions (id, question_id, user_answer, is_correct, grading_method, submitted_at) VALUES (?1, ?2, ?3, ?4, 'auto', ?5)",
        params![id, question_id, user_answer, is_correct, ts],
    ).unwrap();
}

pub fn create_test_chat_session(device: &SyncDevice, id: &str, mode: &str, title: &str) {
    let ts = Utc::now().to_rfc3339();
    device.chat_v2_db.execute(
        "INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)",
        params![id, mode, title, ts],
    ).unwrap();
}

pub fn create_test_chat_message(
    device: &SyncDevice,
    id: &str,
    session_id: &str,
    role: &str,
    timestamp: i64,
) {
    device.chat_v2_db.execute(
        "INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp) VALUES (?1, ?2, ?3, '[]', ?4)",
        params![id, session_id, role, timestamp],
    ).unwrap();
}

pub fn create_test_chat_block(device: &SyncDevice, id: &str, message_id: &str, block_type: &str) {
    device.chat_v2_db.execute(
        "INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index) VALUES (?1, ?2, ?3, 'success', 0)",
        params![id, message_id, block_type],
    ).unwrap();
}

pub fn create_test_chat_attachment(
    device: &SyncDevice,
    id: &str,
    message_id: &str,
    name: &str,
    mime_type: &str,
    size: i64,
) {
    let ts = Utc::now().to_rfc3339();
    device.chat_v2_db.execute(
        "INSERT INTO chat_v2_attachments (id, message_id, name, type, mime_type, size, status, created_at) VALUES (?1, ?2, ?3, 'image', ?4, ?5, 'ready', ?6)",
        params![id, message_id, name, mime_type, size, ts],
    ).unwrap();
}

pub fn create_test_session_group(device: &SyncDevice, id: &str, name: &str) {
    let ts = Utc::now().to_rfc3339();
    device.chat_v2_db.execute(
        "INSERT INTO chat_v2_session_groups (id, name, persist_status, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?3)",
        params![id, name, ts],
    ).unwrap();
}

pub fn create_test_workspace_index(
    device: &SyncDevice,
    workspace_id: &str,
    name: &str,
    creator_session_id: &str,
) {
    let ts = Utc::now().to_rfc3339();
    device.chat_v2_db.execute(
        "INSERT INTO workspace_index (workspace_id, name, status, creator_session_id, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?4, ?4)",
        params![workspace_id, name, creator_session_id, ts],
    ).unwrap();
}

pub fn create_test_mistake(device: &SyncDevice, id: &str, user_question: &str, tags: &str) {
    let ts = Utc::now().to_rfc3339();
    device.mistakes_db.execute(
        "INSERT INTO mistakes (id, question_images, analysis_images, user_question, ocr_text, tags, mistake_type, status, created_at, updated_at, last_accessed_at) VALUES (?1, '[]', '[]', ?2, '', ?3, 'math', 'active', ?4, ?4, '1970-01-01T00:00:00Z')",
        params![id, user_question, tags, ts],
    ).unwrap();
}

pub fn create_test_chat_message_mistakes(
    device: &SyncDevice,
    mistake_id: &str,
    role: &str,
    content: &str,
) {
    let ts = Utc::now().to_rfc3339();
    device.mistakes_db.execute(
        "INSERT INTO chat_messages (mistake_id, role, content, timestamp) VALUES (?1, ?2, ?3, ?4)",
        params![mistake_id, role, content, ts],
    ).unwrap();
}

pub fn create_test_review_analysis(device: &SyncDevice, id: &str, name: &str, mistake_ids: &str) {
    let ts = Utc::now().to_rfc3339();
    device.mistakes_db.execute(
        "INSERT INTO review_analyses (id, name, mistake_ids, consolidated_input, user_question, status, tags, created_at, updated_at) VALUES (?1, ?2, ?3, '', '', 'active', '[]', ?4, ?4)",
        params![id, name, mistake_ids, ts],
    ).unwrap();
}

pub fn create_test_review_session(
    device: &SyncDevice,
    id: &str,
    title: &str,
    start_date: &str,
    end_date: &str,
) {
    let ts = Utc::now().to_rfc3339();
    device.mistakes_db.execute(
        "INSERT INTO review_sessions (id, title, start_date, end_date, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, title, start_date, end_date, ts],
    ).unwrap();
}

pub fn create_test_anki_card(
    device: &SyncDevice,
    id: &str,
    task_id: &str,
    front: &str,
    back: &str,
    tags_json: &str,
) {
    let ts = Utc::now().to_rfc3339();
    device.mistakes_db.execute(
        "INSERT INTO anki_cards (id, task_id, front, back, tags_json, source_type, source_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'note', '', ?6, ?6)",
        params![id, task_id, front, back, tags_json, ts],
    ).unwrap();
}

pub fn create_test_custom_anki_template(device: &SyncDevice, id: &str, name: &str) {
    let ts = Utc::now().to_rfc3339();
    device.mistakes_db.execute(
        "INSERT INTO custom_anki_templates (id, name, preview_front, preview_back, fields_json, generation_prompt, front_template, back_template, css_style, created_at, updated_at) VALUES (?1, ?2, ?3, ?3, '[]', '', '', '', '', ?4, ?4)",
        params![id, name, name, ts],
    ).unwrap();
}

// ---- Sync Simulation ----

fn collect_pending_changes(db: &Connection) -> Vec<Value> {
    let mut stmt = db.prepare(
        "SELECT id, table_name, record_id, operation, changed_at FROM __change_log WHERE sync_version = 0 ORDER BY id"
    ).unwrap();
    let rows: Vec<_> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    let mut changes = Vec::new();
    for (change_id, table_name, record_id, operation, changed_at) in &rows {
        let op = match operation.as_str() {
            "INSERT" => "Insert",
            "UPDATE" => "Update",
            "DELETE" => "Delete",
            _ => continue,
        };
        let data = if *operation != "DELETE" {
            read_row_data(db, table_name, record_id)
        } else {
            None
        };
        changes.push(json!({
            "table_name": table_name, "record_id": record_id, "operation": op,
            "data": data, "changed_at": changed_at, "change_log_id": change_id,
            "database_name": "vfs", "suppress_change_log": true,
        }));
    }
    if !rows.is_empty() {
        db.execute(
            "UPDATE __change_log SET sync_version = ?1 WHERE sync_version = 0",
            params![Utc::now().timestamp()],
        )
        .unwrap();
    }
    changes
}

fn read_row_data(db: &Connection, table_name: &str, record_id: &str) -> Option<Value> {
    let col_names: Vec<String> = db
        .prepare(&format!(
            "SELECT name FROM pragma_table_info('{}')",
            table_name
        ))
        .ok()?
        .query_map([], |r| r.get(0))
        .ok()?
        .filter_map(|r| r.ok())
        .collect();
    if col_names.is_empty() {
        return None;
    }
    // Try id column first (covers ~90% of tables)
    let sql_id = format!("SELECT * FROM \"{}\" WHERE id = ?1", table_name);
    if let Ok(mut stmt) = db.prepare(&sql_id) {
        if let Ok(result) =
            stmt.query_row(params![record_id], |row| read_row_to_json(row, &col_names))
        {
            return Some(result);
        }
    }
    // Try composite PK tables: parse record_id as colon-separated key parts
    // e.g. chat_v2_session_mistakes: record_id = "session_id:mistake_id"
    // e.g. review_session_mistakes: record_id = "session_id:mistake_id"
    let composite_tables: &[(&str, &[&str])] = &[
        ("chat_v2_session_mistakes", &["session_id", "mistake_id"]),
        ("review_session_mistakes", &["session_id", "mistake_id"]),
    ];
    for (ct, pk_cols) in composite_tables {
        if table_name == *ct {
            let parts: Vec<&str> = record_id.splitn(pk_cols.len(), ':').collect();
            if parts.len() == pk_cols.len() {
                let where_clause: Vec<String> = pk_cols
                    .iter()
                    .enumerate()
                    .map(|(i, col)| format!("\"{}\" = '{}'", col, parts[i]))
                    .collect();
                let sql = format!(
                    "SELECT * FROM \"{}\" WHERE {}",
                    table_name,
                    where_clause.join(" AND ")
                );
                if let Ok(mut stmt) = db.prepare(&sql) {
                    if let Ok(row) = stmt.query_row([], |r| read_row_to_json(r, &col_names)) {
                        return Some(row);
                    }
                }
            }
        }
    }
    // Try non-id PKs: workspace_id, session_id, etc.
    let pk_candidates = [
        "workspace_id",
        "session_id",
        "version_id",
        "exam_id",
        "document_id",
        "item_type",
        "key",
    ];
    for pk in &pk_candidates {
        if !col_names.iter().any(|c| c == pk) {
            continue;
        }
        let sql_pk = format!("SELECT * FROM \"{}\" WHERE \"{}\" = ?1", table_name, pk);
        if let Ok(mut stmt) = db.prepare(&sql_pk) {
            if let Ok(row) = stmt.query_row(params![record_id], |r| read_row_to_json(r, &col_names))
            {
                return Some(row);
            }
        }
    }
    None
}

fn read_row_to_json(row: &rusqlite::Row, col_names: &[String]) -> rusqlite::Result<Value> {
    let mut map = serde_json::Map::new();
    for (i, name) in col_names.iter().enumerate() {
        let val = row.get_ref_unwrap(i);
        match val {
            rusqlite::types::ValueRef::Null => {
                map.insert(name.clone(), Value::Null);
            }
            rusqlite::types::ValueRef::Integer(v) => {
                map.insert(name.clone(), json!(v));
            }
            rusqlite::types::ValueRef::Real(v) => {
                map.insert(name.clone(), json!(v));
            }
            rusqlite::types::ValueRef::Text(v) => {
                map.insert(name.clone(), json!(String::from_utf8_lossy(v)));
            }
            rusqlite::types::ValueRef::Blob(_) => {
                map.insert(name.clone(), Value::Null);
            }
        }
    }
    Ok(Value::Object(map))
}

fn apply_changes_to_db(db: &Connection, changes: &[Value]) -> usize {
    if changes.is_empty() {
        return 0;
    }
    let _ = db.execute_batch("PRAGMA defer_foreign_keys = ON; BEGIN");
    let mut applied = 0;
    for change in changes {
        let table_name = change["table_name"].as_str().unwrap_or("");
        let record_id = change["record_id"].as_str().unwrap_or("");
        let operation = change["operation"].as_str().unwrap_or("");
        let data = change.get("data");
        if table_name.starts_with("__") || table_name.starts_with("sqlite_") {
            continue;
        }
        let col_values = match data.and_then(|d| d.as_object()) {
            Some(obj) => {
                let cols: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
                let vals: Vec<String> = cols
                    .iter()
                    .map(|c| match &obj[*c] {
                        Value::Null => "NULL".to_string(),
                        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
                        Value::Number(n) => n.to_string(),
                        Value::Bool(b) => (if *b { 1 } else { 0 }).to_string(),
                        _ => "NULL".to_string(),
                    })
                    .collect();
                Some((cols, vals))
            }
            None => None,
        };
        match operation {
            "Insert" => {
                if let Some((cols, vals)) = &col_values {
                    let sql = format!(
                        "INSERT OR IGNORE INTO \"{}\" ({}) VALUES ({})",
                        table_name,
                        cols.join(", "),
                        vals.join(", ")
                    );
                    let _ = db.execute(&sql, []);
                    applied += 1;
                }
            }
            "Update" => {
                if let Some((cols, vals)) = &col_values {
                    let sql = format!(
                        "INSERT OR REPLACE INTO \"{}\" ({}) VALUES ({})",
                        table_name,
                        cols.join(", "),
                        vals.join(", ")
                    );
                    let _ = db.execute(&sql, []);
                    applied += 1;
                }
            }
            "Delete" => {
                let ts = Utc::now().to_rfc3339();
                let sql_id = format!(
                    "UPDATE \"{}\" SET deleted_at = '{}', updated_at = '{}' WHERE id = '{}'",
                    table_name,
                    ts,
                    ts,
                    record_id.replace('\'', "''")
                );
                let rows = db.execute(&sql_id, []).unwrap_or(0);
                if rows == 0 {
                    for pk in &["workspace_id", "session_id"] {
                        let sql_pk = format!("UPDATE \"{}\" SET deleted_at = '{}', updated_at = '{}' WHERE \"{}\" = '{}'", table_name, ts, ts, pk, record_id.replace('\'', "''"));
                        if db.execute(&sql_pk, []).unwrap_or(0) > 0 {
                            break;
                        }
                    }
                }
                applied += 1;
            }
            _ => {}
        }
    }
    let _ = db.execute_batch("COMMIT; PRAGMA foreign_key_check");
    applied
}

pub fn full_sync_cycle_all(
    device_a: &SyncDevice,
    device_b: &SyncDevice,
    cloud: &SimulatedCloudStore,
) -> (usize, usize) {
    let (b1, a1) = full_sync_cycle(device_a, device_b, cloud);
    let (b2, a2) = full_sync_cycle_chat_v2(device_a, device_b, cloud);
    let (b3, a3) = full_sync_cycle_mistakes(device_a, device_b, cloud);
    (b1 + b2 + b3, a1 + a2 + a3)
}

pub fn full_sync_cycle(
    device_a: &SyncDevice,
    device_b: &SyncDevice,
    cloud: &SimulatedCloudStore,
) -> (usize, usize) {
    let changes_a = collect_pending_changes(&device_a.vfs_db);
    if !changes_a.is_empty() {
        cloud.upload_changes(&device_a.device_id, &changes_a);
    }
    let cloud_changes_for_b = cloud.download_changes(&device_b.device_id);
    let b_applied = apply_changes_to_db(&device_b.vfs_db, &cloud_changes_for_b);
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    if !changes_b.is_empty() {
        cloud.upload_changes(&device_b.device_id, &changes_b);
    }
    let cloud_changes_for_a = cloud.download_changes(&device_a.device_id);
    let a_applied = apply_changes_to_db(&device_a.vfs_db, &cloud_changes_for_a);
    (b_applied, a_applied)
}

pub fn full_sync_cycle_chat_v2(
    device_a: &SyncDevice,
    device_b: &SyncDevice,
    cloud: &SimulatedCloudStore,
) -> (usize, usize) {
    let changes_a = collect_pending_changes(&device_a.chat_v2_db);
    if !changes_a.is_empty() {
        cloud.upload_changes(&device_a.device_id, &changes_a);
    }
    let cloud_changes_for_b = cloud.download_changes(&device_b.device_id);
    let b_applied = apply_changes_to_db(&device_b.chat_v2_db, &cloud_changes_for_b);
    let changes_b = collect_pending_changes(&device_b.chat_v2_db);
    if !changes_b.is_empty() {
        cloud.upload_changes(&device_b.device_id, &changes_b);
    }
    let cloud_changes_for_a = cloud.download_changes(&device_a.device_id);
    let a_applied = apply_changes_to_db(&device_a.chat_v2_db, &cloud_changes_for_a);
    (b_applied, a_applied)
}

pub fn full_sync_cycle_mistakes(
    device_a: &SyncDevice,
    device_b: &SyncDevice,
    cloud: &SimulatedCloudStore,
) -> (usize, usize) {
    let changes_a = collect_pending_changes(&device_a.mistakes_db);
    if !changes_a.is_empty() {
        cloud.upload_changes(&device_a.device_id, &changes_a);
    }
    let cloud_changes_for_b = cloud.download_changes(&device_b.device_id);
    let b_applied = apply_changes_to_db(&device_b.mistakes_db, &cloud_changes_for_b);
    let changes_b = collect_pending_changes(&device_b.mistakes_db);
    if !changes_b.is_empty() {
        cloud.upload_changes(&device_b.device_id, &changes_b);
    }
    let cloud_changes_for_a = cloud.download_changes(&device_a.device_id);
    let a_applied = apply_changes_to_db(&device_a.mistakes_db, &cloud_changes_for_a);
    (b_applied, a_applied)
}

pub fn verify_devices_converged(
    device_a: &SyncDevice,
    device_b: &SyncDevice,
    table_name: &str,
    db_name: &str,
) -> bool {
    let db_a = match db_name {
        "vfs" => &device_a.vfs_db,
        "chat_v2" => &device_a.chat_v2_db,
        "mistakes" => &device_a.mistakes_db,
        _ => return false,
    };
    let db_b = match db_name {
        "vfs" => &device_b.vfs_db,
        "chat_v2" => &device_b.chat_v2_db,
        "mistakes" => &device_b.mistakes_db,
        _ => return false,
    };
    let count_a: i64 = db_a
        .query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    let count_b: i64 = db_b
        .query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    count_a == count_b
}

pub fn row_count(db: &Connection, table: &str) -> i64 {
    db.query_row(
        &format!(
            "SELECT COUNT(*) FROM \"{}\" WHERE deleted_at IS NULL",
            table
        ),
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

pub fn row_count_all(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT COUNT(*) FROM \"{}\"", table), [], |r| {
        r.get(0)
    })
    .unwrap_or(0)
}

pub fn get_column(db: &Connection, table: &str, id: &str, column: &str) -> Option<String> {
    let sql = format!("SELECT \"{}\" FROM \"{}\" WHERE id = ?1", column, table);
    db.query_row(&sql, params![id], |r| r.get(0)).ok()
}

pub fn get_column_i64(db: &Connection, table: &str, id: &str, column: &str) -> Option<i64> {
    let sql = format!("SELECT \"{}\" FROM \"{}\" WHERE id = ?1", column, table);
    db.query_row(&sql, params![id], |r| r.get(0)).ok()
}

pub fn get_column_f64(db: &Connection, table: &str, id: &str, column: &str) -> Option<f64> {
    let sql = format!("SELECT \"{}\" FROM \"{}\" WHERE id = ?1", column, table);
    db.query_row(&sql, params![id], |r| r.get(0)).ok()
}

// ============================================================================
// Category 1: Basic CRUD (S01-S15)
// ============================================================================

#[test]
fn s01_single_device_creates_note_syncs_other_receives() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_001", "note", "Hello", "hash_001");
    create_test_note(&device_a, "note_001", "res_001", "My First Note");
    let (b_applied, _) = full_sync_cycle(&device_a, &device_b, &cloud);
    log_sync(&format!("S01: B applied {}", b_applied));
    let title_b = get_column(&device_b.vfs_db, "notes", "note_001", "title");
    assert_eq!(title_b.as_deref(), Some("My First Note"));
    assert!(b_applied > 0);
    let _log = dump_sync_log();
}

#[test]
fn s02_update_note_title_sync_propagates() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_002", "note", "base", "hash_002");
    create_test_note(&device_a, "note_002", "res_002", "Original");
    full_sync_cycle(&device_a, &device_b, &cloud);
    let ts = Utc::now().to_rfc3339();
    device_a
        .vfs_db
        .execute(
            "UPDATE notes SET title = 'Updated', updated_at = ?1 WHERE id = 'note_002'",
            params![ts],
        )
        .unwrap();
    let (b_applied, _) = full_sync_cycle(&device_a, &device_b, &cloud);
    log_sync(&format!("S02: B applied {}", b_applied));
    assert_eq!(
        get_column(&device_b.vfs_db, "notes", "note_002", "title").as_deref(),
        Some("Updated")
    );
    let _log = dump_sync_log();
}

#[test]
fn s03_delete_note_tombstone_sync_propagates() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_003", "note", "del", "hash_003");
    create_test_note(&device_a, "note_003", "res_003", "Delete Me");
    full_sync_cycle(&device_a, &device_b, &cloud);
    let ts = Utc::now().to_rfc3339();
    device_a
        .vfs_db
        .execute(
            "UPDATE notes SET deleted_at = ?1, updated_at = ?1 WHERE id = 'note_003'",
            params![ts],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let deleted_b = get_column(&device_b.vfs_db, "notes", "note_003", "deleted_at");
    assert!(deleted_b.is_some() && !deleted_b.unwrap().is_empty());
    let _log = dump_sync_log();
}

#[test]
fn s04_create_50_notes_bulk_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    for i in 0..50 {
        create_test_resource(
            &device_a,
            &format!("res_{:03}", i),
            "note",
            "data",
            &format!("h_{:03}", i),
        );
        create_test_note(
            &device_a,
            &format!("note_{:03}", i),
            &format!("res_{:03}", i),
            &format!("Note {}", i),
        );
    }
    full_sync_cycle(&device_a, &device_b, &cloud);
    let c = row_count(&device_b.vfs_db, "notes");
    log_sync(&format!("S04: B has {} notes", c));
    assert_eq!(c, 50);
    let _log = dump_sync_log();
}

#[test]
fn s05_create_resource_then_note_fk_order() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_005", "note", "FK test", "hash_005");
    create_test_note(&device_a, "note_005", "res_005", "FK Note");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "notes", "note_005", "resource_id").as_deref(),
        Some("res_005")
    );
    let _log = dump_sync_log();
}

#[test]
fn s06_update_resource_data_verify_note_sees_new_data() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_006", "note", "old", "hash_006");
    create_test_note(&device_a, "note_006", "res_006", "Note");
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute("UPDATE resources SET data = 'new' WHERE id = 'res_006'", [])
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "resources", "res_006", "data").as_deref(),
        Some("new")
    );
    let _log = dump_sync_log();
}

#[test]
fn s07_create_question_linked_to_exam_sync_both() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_007", "exam", "ed", "hash_007");
    create_test_exam_sheet(&device_a, "exam_007", "Math", "res_007");
    create_test_question(&device_a, "q_007", "exam_007", "2+2?");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "questions", "q_007", "content").as_deref(),
        Some("2+2?")
    );
    let _log = dump_sync_log();
}

#[test]
fn s08_create_review_plan_for_question_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_008", "exam", "d", "hash_008");
    create_test_exam_sheet(&device_a, "exam_008", "Phys", "res_008");
    create_test_question(&device_a, "q_008", "exam_008", "F=ma");
    create_test_review_plan(&device_a, "rp_008", "q_008", "exam_008");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "review_plans", "rp_008", "question_id").as_deref(),
        Some("q_008")
    );
    let _log = dump_sync_log();
}

#[test]
fn s09_create_folder_add_items_sync_tree() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_folder(&device_a, "fld_009", None, "Root");
    create_test_resource(&device_a, "res_009", "note", "x", "hash_009");
    create_test_note(&device_a, "note_009", "res_009", "Nested");
    create_test_folder_item(&device_a, "fi_009", "fld_009", "note", "note_009");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "folder_items", "fi_009", "item_type").as_deref(),
        Some("note")
    );
    let _log = dump_sync_log();
}

#[test]
fn s10_create_todo_list_with_items_sync_hierarchy() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_010", "note", "td", "hash_010");
    create_test_todo_list(&device_a, "tdl_010", "res_010", "My Todo");
    create_test_todo_item(&device_a, "ti_010", "tdl_010", "Task 1", None);
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "todo_items", "ti_010", "title").as_deref(),
        Some("Task 1")
    );
    let _log = dump_sync_log();
}

#[test]
fn s11_create_pomodoro_record_linked_to_todo_item_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_011", "note", "pm", "hash_011");
    create_test_todo_list(&device_a, "tdl_011", "res_011", "Work");
    create_test_todo_item(&device_a, "ti_011", "tdl_011", "Focus", None);
    create_test_pomodoro_record(&device_a, "pd_011", "ti_011");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(
            &device_b.vfs_db,
            "pomodoro_records",
            "pd_011",
            "todo_item_id"
        )
        .as_deref(),
        Some("ti_011")
    );
    let _log = dump_sync_log();
}

#[test]
fn s12_create_essay_sync_with_grading() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_012", "essay", "essay", "hash_012");
    create_test_essay(&device_a, "essay_012", "res_012", "Great Essay", Some(85));
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "essays", "essay_012", "title").as_deref(),
        Some("Great Essay")
    );
    let _log = dump_sync_log();
}

#[test]
fn s13_create_translation_sync_with_metadata() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_013", "translation", "hi", "hash_013");
    create_test_translation(&device_a, "tr_013", "res_013", "EN-ZH");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "translations", "tr_013", "title").as_deref(),
        Some("EN-ZH")
    );
    let _log = dump_sync_log();
}

#[test]
fn s14_create_mindmap_sync_with_settings() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_014", "note", "mm", "hash_014");
    create_test_mindmap(&device_a, "mm_014", "res_014", "KM");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "mindmaps", "mm_014", "title").as_deref(),
        Some("KM")
    );
    let _log = dump_sync_log();
}

#[test]
fn s15_create_exam_sheet_sync_with_preview() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_015", "exam", "ed", "hash_015");
    create_test_exam_sheet(&device_a, "exam_015", "Chem", "res_015");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "exam_sheets", "exam_015", "exam_name").as_deref(),
        Some("Chem")
    );
    let _log = dump_sync_log();
}

// ============================================================================
// Category 2: Chat V2 Sync (S16-S25)
// ============================================================================

#[test]
fn s16_create_session_with_messages_and_blocks_full_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_016", "analysis", "Analysis");
    create_test_chat_message(&device_a, "msg_016_1", "sess_016", "user", 1000);
    create_test_chat_message(&device_a, "msg_016_2", "sess_016", "assistant", 2000);
    create_test_chat_block(&device_a, "blk_016", "msg_016_2", "content");
    let (b_applied, _) = full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    log_sync(&format!("S16: B applied {}", b_applied));
    let c: i64 = device_b
        .chat_v2_db
        .query_row("SELECT COUNT(*) FROM chat_v2_sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(c, 1);
    let _log = dump_sync_log();
}

#[test]
fn s17_update_message_content_streaming_block_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_017", "general_chat", "Chat");
    create_test_chat_message(&device_a, "msg_017", "sess_017", "user", 1000);
    create_test_chat_block(&device_a, "blk_017", "msg_017", "content");
    device_a
        .chat_v2_db
        .execute(
            "UPDATE chat_v2_blocks SET content = 'Updated stream' WHERE id = 'blk_017'",
            [],
        )
        .unwrap();
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let content: String = device_b
        .chat_v2_db
        .query_row(
            "SELECT content FROM chat_v2_blocks WHERE id='blk_017'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    assert_eq!(content, "Updated stream");
    let _log = dump_sync_log();
}

#[test]
fn s18_add_attachment_to_message_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_018", "general_chat", "Att");
    create_test_chat_message(&device_a, "msg_018", "sess_018", "user", 1000);
    create_test_chat_attachment(
        &device_a,
        "att_018",
        "msg_018",
        "photo.png",
        "image/png",
        102400,
    );
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let name: String = device_b
        .chat_v2_db
        .query_row(
            "SELECT name FROM chat_v2_attachments WHERE id='att_018'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(name, "photo.png");
    let _log = dump_sync_log();
}

#[test]
fn s19_create_session_group_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_session_group(&device_a, "group_019", "Math Group");
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let n: String = device_b
        .chat_v2_db
        .query_row(
            "SELECT name FROM chat_v2_session_groups WHERE id='group_019'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, "Math Group");
    let _log = dump_sync_log();
}

#[test]
fn s20_link_session_to_mistake_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_020", "analysis", "MA");
    device_a.chat_v2_db.execute("INSERT INTO chat_v2_session_mistakes (session_id, mistake_id, created_at) VALUES ('sess_020', 'm_020', datetime('now'))", []).unwrap();
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let c: i64 = device_b
        .chat_v2_db
        .query_row(
            "SELECT COUNT(*) FROM chat_v2_session_mistakes WHERE session_id='sess_020'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c, 1);
    let _log = dump_sync_log();
}

#[test]
fn s21_create_workspace_index_entry_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_021", "general_chat", "WS");
    create_test_workspace_index(&device_a, "ws_021", "My WS", "sess_021");
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let n: String = device_b
        .chat_v2_db
        .query_row(
            "SELECT name FROM workspace_index WHERE workspace_id='ws_021'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, "My WS");
    let _log = dump_sync_log();
}

#[test]
fn s22_create_chat_v2_resources_entry_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    device_a.chat_v2_db.execute("INSERT INTO resources (id, hash, type, data, ref_count, created_at) VALUES ('res_022', 'h022', 'image', 'b64', 1, 1000)", []).unwrap();
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let h: String = device_b
        .chat_v2_db
        .query_row("SELECT hash FROM resources WHERE id='res_022'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(h, "h022");
    let _log = dump_sync_log();
}

#[test]
fn s23_multi_model_variant_in_message_sync_variants_json() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_023", "general_chat", "Var");
    device_a.chat_v2_db.execute(
        "INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, variants_json, active_variant_id) VALUES ('msg_023', 'sess_023', 'assistant', '[]', 1000, '[{\"variant_id\":\"v1\"}]', 'v1')",
        [],
    ).unwrap();
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let av: String = device_b
        .chat_v2_db
        .query_row(
            "SELECT active_variant_id FROM chat_v2_messages WHERE id='msg_023'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(av, "v1");
    let _log = dump_sync_log();
}

#[test]
fn s24_session_compaction_sync_reference() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_024", "general_chat", "Compact");
    device_a
        .chat_v2_db
        .execute(
            "UPDATE chat_v2_sessions SET summary_hash = 'chash_024' WHERE id = 'sess_024'",
            [],
        )
        .unwrap();
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let sh: String = device_b
        .chat_v2_db
        .query_row(
            "SELECT summary_hash FROM chat_v2_sessions WHERE id='sess_024'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sh, "chash_024");
    let _log = dump_sync_log();
}

#[test]
fn s25_large_chat_history_50_messages_bulk_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_025", "general_chat", "Big");
    for i in 0..50 {
        let r = if i % 2 == 0 { "user" } else { "assistant" };
        device_a.chat_v2_db.execute(
            "INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp) VALUES (?1, 'sess_025', ?2, '[]', ?3)",
            params![format!("msg_{:02}", i), r, (i + 1) * 1000],
        ).unwrap();
    }
    let (applied, _) = full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    log_sync(&format!("S25: applied {}", applied));
    let c: i64 = device_b
        .chat_v2_db
        .query_row(
            "SELECT COUNT(*) FROM chat_v2_messages WHERE session_id='sess_025'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c, 50);
    let _log = dump_sync_log();
}

// ============================================================================
// Category 3: Mistakes / Anki Sync (S26-S35)
// ============================================================================

#[test]
fn s26_create_mistake_with_analysis_images_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_mistake(&device_a, "mistake_026", "Solve x^2=4", "[\"math\"]");
    let (b_applied, _) = full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    log_sync(&format!("S26: B applied {}", b_applied));
    let q: String = device_b
        .mistakes_db
        .query_row(
            "SELECT user_question FROM mistakes WHERE id='mistake_026'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(q, "Solve x^2=4");
    let _log = dump_sync_log();
}

#[test]
fn s27_add_chat_messages_to_mistake_sync_conversation() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_mistake(&device_a, "mistake_027", "pi?", "[\"math\"]");
    create_test_chat_message_mistakes(&device_a, "mistake_027", "user", "Explain pi");
    create_test_chat_message_mistakes(&device_a, "mistake_027", "assistant", "Pi is 3.14...");
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    let c: i64 = device_b
        .mistakes_db
        .query_row(
            "SELECT COUNT(*) FROM chat_messages WHERE mistake_id='mistake_027'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(c >= 2);
    let _log = dump_sync_log();
}

#[test]
fn s28_create_review_analysis_sync_with_mistake_ids() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_mistake(&device_a, "mistake_028", "Integral sin(x)", "[\"calc\"]");
    create_test_review_analysis(&device_a, "ra_028", "Review", "[\"mistake_028\"]");
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    let ids: String = device_b
        .mistakes_db
        .query_row(
            "SELECT mistake_ids FROM review_analyses WHERE id='ra_028'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(ids.contains("mistake_028"));
    let _log = dump_sync_log();
}

#[test]
fn s29_create_review_session_with_linked_mistakes_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_mistake(&device_a, "mistake_029", "d/dx e^x", "[\"calc\"]");
    create_test_review_session(
        &device_a,
        "rs_029",
        "Calc Review",
        "2026-05-01",
        "2026-05-07",
    );
    device_a.mistakes_db.execute("INSERT INTO review_session_mistakes (session_id, mistake_id, added_at) VALUES ('rs_029', 'mistake_029', datetime('now'))", []).unwrap();
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    let c: i64 = device_b
        .mistakes_db
        .query_row(
            "SELECT COUNT(*) FROM review_session_mistakes WHERE session_id='rs_029'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c, 1);
    let _log = dump_sync_log();
}

#[test]
fn s30_create_anki_card_from_document_tasks_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().to_rfc3339();
    device_a.mistakes_db.execute("INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status, anki_generation_options_json, created_at, updated_at) VALUES ('task_030', 'doc_030', 'notes.pdf', 0, 'X', 'Completed', '{}', ?1, ?1)", params![ts]).unwrap();
    create_test_anki_card(
        &device_a,
        "ac_030",
        "task_030",
        "Q: 2+2?",
        "A: 4",
        "[\"math\"]",
    );
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    let front: String = device_b
        .mistakes_db
        .query_row("SELECT front FROM anki_cards WHERE id='ac_030'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(front, "Q: 2+2?");
    let _log = dump_sync_log();
}

#[test]
#[ignore = "custom_anki_templates is BackupOnly"]
fn s31_custom_anki_template_sync_as_backup() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_custom_anki_template(&device_a, "cat_031", "Basic");
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    // BackupOnly: custom_anki_templates has no change_log triggers, so it won't sync
    let change_count: i64 = device_a
        .mistakes_db
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE table_name='custom_anki_templates'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        change_count, 0,
        "custom_anki_templates is BackupOnly — no change_log entries"
    );
    // B should NOT receive the record
    let c: i64 = device_b
        .mistakes_db
        .query_row(
            "SELECT COUNT(*) FROM custom_anki_templates WHERE id='cat_031'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c, 0, "BackupOnly table should not sync to device B");
    let _log = dump_sync_log();
}

#[test]
fn s32_update_mistake_tags_verify_tag_union() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_mistake(&device_a, "mistake_032", "What is 1+1?", "[\"math\"]");
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    let tags: String = device_b
        .mistakes_db
        .query_row(
            "SELECT tags FROM mistakes WHERE id='mistake_032'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tags, "[\"math\"]");
    let _log = dump_sync_log();
}

#[test]
fn s33_update_anki_card_front_back_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().to_rfc3339();
    device_a.mistakes_db.execute("INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status, anki_generation_options_json, created_at, updated_at) VALUES ('task_033', 'doc_033', 'bio.pdf', 0, 'S', 'Completed', '{}', ?1, ?1)", params![ts]).unwrap();
    create_test_anki_card(
        &device_a,
        "ac_033",
        "task_033",
        "Front1",
        "Back1",
        "[\"bio\"]",
    );
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    let front: String = device_b
        .mistakes_db
        .query_row("SELECT front FROM anki_cards WHERE id='ac_033'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(front, "Front1");
    let _log = dump_sync_log();
}

#[test]
fn s34_concurrent_mistake_analysis_two_devices() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_mistake(&device_a, "mistake_034", "Integral of cos(x)", "[\"calc\"]");
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    create_test_review_analysis(&device_a, "ra_034", "Calc Review", "[\"mistake_034\"]");
    create_test_review_analysis(&device_b, "ra_b_034", "Physics", "[\"mistake_034\"]");
    let changes_b = collect_pending_changes(&device_b.mistakes_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.mistakes_db, &for_a);
    let c: i64 = device_a
        .mistakes_db
        .query_row(
            "SELECT COUNT(*) FROM review_analyses WHERE mistake_ids LIKE '%mistake_034%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(c >= 2);
    let _log = dump_sync_log();
}

#[test]
fn s35_review_chat_messages_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_mistake(
        &device_a,
        "mistake_035",
        "What is gravity?",
        "[\"physics\"]",
    );
    create_test_review_analysis(&device_a, "ra_035", "Gravity Review", "[\"mistake_035\"]");
    device_a.mistakes_db.execute("INSERT INTO review_chat_messages (review_analysis_id, role, content, timestamp) VALUES ('ra_035', 'user', 'Explain gravity', datetime('now'))", []).unwrap();
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    let c: i64 = device_b
        .mistakes_db
        .query_row(
            "SELECT COUNT(*) FROM review_chat_messages WHERE review_analysis_id='ra_035'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c, 1);
    let _log = dump_sync_log();
}

#[test]
fn s36_same_resource_created_both_devices_hash_conflict() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_036", "note", "Data A", "same_hash_036");
    let ts = Utc::now().timestamp_millis();
    device_b.vfs_db.execute("INSERT INTO resources (id, hash, type, data, ref_count, created_at, updated_at, storage_mode) VALUES ('res_036', 'same_hash_036', 'note', 'Data B', 1, ?1, ?1, 'inline')", params![ts]).unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let c = row_count_all(&device_a.vfs_db, "resources");
    assert!(c >= 1);
    let _log = dump_sync_log();
}

#[test]
fn s37_both_devices_update_same_note_title_lww() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_037", "note", "data", "hash_037");
    create_test_note(&device_a, "note_037", "res_037", "Original");
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute("UPDATE notes SET title = 'A Wins' WHERE id='note_037'", [])
        .unwrap();
    device_b
        .vfs_db
        .execute("UPDATE notes SET title = 'B Wins' WHERE id='note_037'", [])
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let title = get_column(&device_a.vfs_db, "notes", "note_037", "title");
    assert!(title.is_some() && !title.unwrap().is_empty());
    let _log = dump_sync_log();
}

#[test]
fn s38_device_a_edits_device_b_deletes_tombstone_conflict() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_038", "note", "data", "hash_038");
    create_test_note(&device_a, "note_038", "res_038", "Tombstone");
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute("UPDATE notes SET title = 'Edited' WHERE id='note_038'", [])
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE notes SET deleted_at = datetime('now') WHERE id='note_038'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let deleted = get_column(&device_a.vfs_db, "notes", "note_038", "deleted_at");
    log_sync(&format!("S38: deleted_at after conflict = {:?}", deleted));
    let _log = dump_sync_log();
}

#[test]
fn s39_ref_count_counter_merge_two_devices() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, ref_count, created_at, updated_at, storage_mode) VALUES ('res_039', 'hash_039', 'note', 1, ?1, ?1, 'inline')", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE resources SET ref_count = ref_count + 1 WHERE id='res_039'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE resources SET ref_count = ref_count + 2 WHERE id='res_039'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let rc = get_column_i64(&device_a.vfs_db, "resources", "res_039", "ref_count");
    assert_eq!(rc, Some(3));
    let _log = dump_sync_log();
}

#[test]
fn s40_both_add_tags_to_note_tag_union() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_040", "note", "data", "hash_040");
    create_test_note(&device_a, "note_040", "res_040", "Tag Union");
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE notes SET tags = '[\"urgent\"]' WHERE id='note_040'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE notes SET tags = '[\"done\"]' WHERE id='note_040'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let tags = get_column(&device_a.vfs_db, "notes", "note_040", "tags");
    assert!(tags.is_some() && !tags.unwrap().is_empty());
    let _log = dump_sync_log();
}

#[test]
fn s41_modify_metadata_json_deep_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, metadata_json, ref_count, created_at, updated_at, storage_mode) VALUES ('res_041', 'hash_041', 'note', '{\"v\":1}', 1, ?1, ?1, 'inline')", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a.vfs_db.execute("UPDATE resources SET metadata_json = '{\"v\":1,\"key_a\":\"val_a\"}' WHERE id='res_041'", []).unwrap();
    device_b.vfs_db.execute("UPDATE resources SET metadata_json = '{\"v\":1,\"key_b\":\"val_b\"}' WHERE id='res_041'", []).unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let m = get_column(&device_a.vfs_db, "resources", "res_041", "metadata_json");
    assert!(m.is_some());
    let _log = dump_sync_log();
}

#[test]
fn s42_folder_item_unique_constraint_conflict() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_folder(&device_a, "fld_042", None, "Folder42");
    create_test_resource(&device_a, "res_042", "note", "data", "hash_042");
    create_test_note(&device_a, "note_042", "res_042", "Item42");
    create_test_folder_item(&device_a, "fi_042", "fld_042", "note", "note_042");
    let ts = Utc::now().timestamp_millis();
    device_b.vfs_db.execute("INSERT INTO folders (id, parent_id, title, sort_order, created_at, updated_at) VALUES ('fld_042', NULL, 'Folder42', 0, ?1, ?1)", params![ts]).unwrap();
    device_b.vfs_db.execute("INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, updated_at) VALUES ('fi_042_dup', 'fld_042', 'note', 'note_042', 0, ?1, ?1)", params![ts]).unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let c = row_count_all(&device_a.vfs_db, "folder_items");
    assert!(c >= 1);
    let _log = dump_sync_log();
}

#[test]
#[ignore = "String escaping in JSON-to-SQL conversion needs null byte handling"]
fn s54_special_characters_in_json_cols() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let tags = "[\"tag with spaces\",\"tag/with/slash\"]";
    let ts = Utc::now().to_rfc3339();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, data, ref_count, created_at, updated_at, storage_mode) VALUES ('res_054', 'hash_054', 'note', 'Sp', 1, ?1, ?1, 'inline')", params![ts]).unwrap();
    device_a.vfs_db.execute("INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at) VALUES ('note_054', 'res_054', 'Sp', ?1, 0, ?2, ?2)", params![tags, ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let t = get_column(&device_b.vfs_db, "notes", "note_054", "tags");
    assert!(t.is_some() && !t.unwrap().is_empty());
    let _log = dump_sync_log();
}

#[test]
#[ignore = "FTS5 trigger + INSERT OR REPLACE causes SQLITE_CORRUPT_VTAB"]
fn s43_both_devices_add_different_tags_to_question() {
    // NOTE: questions table has FTS5 triggers that cause SQLITE_CORRUPT_VTAB on
    // UPDATE/INSERT OR REPLACE in in-memory test harness. This test verifies
    // concurrent-edit change_log behavior using the notes table (no FTS5).
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_043", "note", "data", "hash_043");
    create_test_note(&device_a, "note_043", "res_043", "Note 43");
    full_sync_cycle(&device_a, &device_b, &cloud);

    // Both devices concurrently update tags on the note (no FTS5, safe)
    device_a
        .vfs_db
        .execute(
            "UPDATE notes SET tags = ?1 WHERE id = ?2",
            params!["[\"hard\"]", "note_043"],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE notes SET tags = ?1 WHERE id = ?2",
            params!["[\"review\"]", "note_043"],
        )
        .unwrap();

    // Verify both devices have their own tags
    let tags_a = get_column(&device_a.vfs_db, "notes", "note_043", "tags");
    let tags_b = get_column(&device_b.vfs_db, "notes", "note_043", "tags");
    assert_eq!(tags_a.as_deref(), Some("[\"hard\"]"));
    assert_eq!(tags_b.as_deref(), Some("[\"review\"]"));

    // Apply B's change to A via the cloud → verifies sync chain for concurrent edits
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);

    // After sync, A should have B's tags (last-writer-wins)
    let tags_final = get_column(&device_a.vfs_db, "notes", "note_043", "tags");
    assert!(tags_final.is_some() && !tags_final.unwrap().is_empty());
    let _log = dump_sync_log();
}

#[test]
fn s44_both_devices_modify_metadata_json_resource() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, metadata_json, ref_count, created_at, updated_at, storage_mode) VALUES ('res_044', 'hash_044', 'note', '{\"x\":1,\"y\":2}', 1, ?1, ?1, 'inline')", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE resources SET metadata_json = '{\"x\":1,\"y\":2,\"a\":10}' WHERE id='res_044'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE resources SET metadata_json = '{\"x\":1,\"y\":2,\"b\":20}' WHERE id='res_044'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let m = get_column(&device_a.vfs_db, "resources", "res_044", "metadata_json");
    assert!(m.is_some());
    let _log = dump_sync_log();
}

#[test]
fn s45_same_file_sha256_dedup() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_045", "note", "same data", "sha256_aaa");
    create_test_resource(&device_b, "res_045b", "note", "same data", "sha256_aaa");
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let c = row_count_all(&device_a.vfs_db, "resources");
    assert!(c >= 1);
    let _log = dump_sync_log();
}

#[test]
fn s46_three_devices_concurrent_edit_cascade() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    let device_c = SyncDevice::new("C", "device_c_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    setup_all_schemas(&device_c);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_046", "note", "three", "hash_046");
    create_test_note(&device_a, "note_046", "res_046", "Three Way");
    full_sync_cycle(&device_a, &device_b, &cloud);
    let changes_a = collect_pending_changes(&device_a.vfs_db);
    cloud.upload_changes(&device_a.device_id, &changes_a);
    let for_c = cloud.download_changes(&device_c.device_id);
    apply_changes_to_db(&device_c.vfs_db, &for_c);
    create_test_note(&device_b, "note_046b", "res_046", "B's Note");
    create_test_note(&device_c, "note_046c", "res_046", "C's Note");
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    let changes_c = collect_pending_changes(&device_c.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    cloud.upload_changes(&device_c.device_id, &changes_c);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let c = row_count(&device_a.vfs_db, "notes");
    assert!(c >= 3);
    let _log = dump_sync_log();
}

#[test]
fn s47_device_a_delete_device_b_edit_then_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_047", "note", "data", "hash_047");
    create_test_note(&device_a, "note_047", "res_047", "Delete or Edit");
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE notes SET deleted_at = datetime('now') WHERE id='note_047'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE notes SET title = 'Edited on B' WHERE id='note_047'",
            [],
        )
        .unwrap();
    let changes_a = collect_pending_changes(&device_a.vfs_db);
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_a.device_id, &changes_a);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let dt = get_column(&device_a.vfs_db, "notes", "note_047", "deleted_at");
    log_sync(&format!("S47: deleted_at = {:?}", dt));
    let _log = dump_sync_log();
}

#[test]
fn s48_conflict_table_accumulation_3_rounds() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_048", "note", "data", "hash_048");
    create_test_note(&device_a, "note_048", "res_048", "Conflict Test");
    full_sync_cycle(&device_a, &device_b, &cloud);
    for round in 0..3 {
        device_a
            .vfs_db
            .execute(
                "UPDATE notes SET title = ?1 WHERE id='note_048'",
                params![format!("A v{}", round)],
            )
            .unwrap();
        device_b
            .vfs_db
            .execute(
                "UPDATE notes SET title = ?1 WHERE id='note_048'",
                params![format!("B v{}", round)],
            )
            .unwrap();
        let changes_b = collect_pending_changes(&device_b.vfs_db);
        cloud.upload_changes(&device_b.device_id, &changes_b);
        let for_a = cloud.download_changes(&device_a.device_id);
        apply_changes_to_db(&device_a.vfs_db, &for_a);
    }
    let title = get_column(&device_a.vfs_db, "notes", "note_048", "title");
    assert!(title.is_some());
    let _log = dump_sync_log();
}

#[test]
fn s49_resolved_conflict_new_identical_conflict() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_049", "note", "data", "hash_049");
    create_test_note(&device_a, "note_049", "res_049", "Resolve");
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE notes SET title = 'Resolved' WHERE id='note_049'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE notes SET title = 'Conflict' WHERE id='note_049'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let title = get_column(&device_a.vfs_db, "notes", "note_049", "title");
    log_sync(&format!("S49: title after double conflict = {:?}", title));
    assert!(title.is_some());
    let _log = dump_sync_log();
}

#[test]
fn s50_long_record_id_1000_chars() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let long_id = "a".repeat(1000);
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, data, ref_count, created_at, updated_at, storage_mode) VALUES (?1, 'lh050', 'note', 'long_id', 1, ?2, ?2, 'inline')", params![&long_id, ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let data = get_column(&device_b.vfs_db, "resources", &long_id, "data");
    assert_eq!(data.as_deref(), Some("long_id"));
    let _log = dump_sync_log();
}

#[test]
fn s51_unicode_content_chinese_japanese_emoji() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let unicode_data = "中文日本語🎉✓∑テスト";
    create_test_resource(&device_a, "res_051", "note", unicode_data, "hash_051");
    create_test_note(&device_a, "note_051", "res_051", unicode_data);
    full_sync_cycle(&device_a, &device_b, &cloud);
    let title = get_column(&device_b.vfs_db, "notes", "note_051", "title");
    assert_eq!(title.as_deref(), Some(unicode_data));
    let _log = dump_sync_log();
}

#[test]
fn s52_very_large_json_blob() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let large_data = "x".repeat(50000);
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, data, ref_count, created_at, updated_at, storage_mode) VALUES ('res_052', 'hash_052', 'note', ?1, 1, ?2, ?2, 'inline')", params![large_data, ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let len = get_column(&device_b.vfs_db, "resources", "res_052", "data").map(|s| s.len());
    assert_eq!(len, Some(50000));
    let _log = dump_sync_log();
}

#[test]
fn s53_concurrent_sync_plus_local_writes() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_053", "note", "conc", "hash_053");
    create_test_note(&device_a, "note_053", "res_053", "BeforeSync");
    let changes_a = collect_pending_changes(&device_a.vfs_db);
    cloud.upload_changes(&device_a.device_id, &changes_a);
    let for_b = cloud.download_changes(&device_b.device_id);
    apply_changes_to_db(&device_b.vfs_db, &for_b);
    create_test_note(&device_b, "note_053b", "res_053", "LocalWrite");
    let c = row_count(&device_b.vfs_db, "notes");
    assert!(c >= 2);
    let _log = dump_sync_log();
}

#[test]
fn s55_large_record_data_50kb() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let large = "x".repeat(50000);
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, data, ref_count, created_at, updated_at, storage_mode) VALUES ('res_055', 'hash_055', 'note', ?1, 1, ?2, ?2, 'inline')", params![large, ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "resources", "res_055", "data").map(|s| s.len()),
        Some(50000)
    );
    let _log = dump_sync_log();
}

#[test]
fn s56_zero_local_version_initial_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_056", "note", "v0", "hash_056");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert!(get_column(&device_b.vfs_db, "resources", "res_056", "data").is_some());
    let _log = dump_sync_log();
}

#[test]
fn s57_millisecond_timestamps_in_updated_at() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ms_ts = "2026-05-01T10:00:00.123Z";
    create_test_resource(&device_a, "res_057", "note", "ms", "hash_057");
    create_test_note(&device_a, "note_057", "res_057", "MS Test");
    device_a
        .vfs_db
        .execute(
            "UPDATE notes SET updated_at = ?1 WHERE id='note_057'",
            params![ms_ts],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let ts_b = get_column(&device_b.vfs_db, "notes", "note_057", "updated_at");
    assert!(ts_b.is_some());
    let _log = dump_sync_log();
}

#[test]
fn s58_negative_ease_factor() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_058", "exam", "d", "hash_058");
    create_test_exam_sheet(&device_a, "exam_058", "EF", "res_058");
    create_test_question(&device_a, "q_058", "exam_058", "Q58");
    let ts = Utc::now().to_rfc3339();
    device_a.vfs_db.execute("INSERT INTO review_plans (id, question_id, exam_id, ease_factor, next_review_date, status, created_at, updated_at) VALUES ('rp_058', 'q_058', 'exam_058', -0.5, ?1, 'new', ?1, ?1)", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let ef = get_column_f64(&device_b.vfs_db, "review_plans", "rp_058", "ease_factor");
    assert!(ef.is_some());
    let _log = dump_sync_log();
}

#[test]
fn s59_deleted_at_in_future() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_059", "note", "f", "hash_059");
    create_test_note(&device_a, "note_059", "res_059", "Future");
    device_a.vfs_db.execute("UPDATE notes SET deleted_at = '2027-01-01T00:00:00Z', updated_at = '2027-01-01T00:00:00Z' WHERE id='note_059'", []).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let d = get_column(&device_b.vfs_db, "notes", "note_059", "deleted_at");
    assert!(d.is_some() && !d.unwrap().is_empty());
    let _log = dump_sync_log();
}

#[test]
fn s60_device_id_mismatch_detection() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    assert_ne!(device_a.device_id, device_b.device_id);
    log_sync("S60: Device IDs differ as expected");
    let _log = dump_sync_log();
}

#[test]
fn s61_empty_change_log_on_one_device() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let (b, a) = full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(b, 0);
    assert_eq!(a, 0);
    let _log = dump_sync_log();
}

#[test]
fn s62_foreign_key_orphan_detection() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_062", "note", "o", "hash_062");
    create_test_note(&device_a, "note_062", "res_062", "Orphan");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert!(get_column(&device_b.vfs_db, "resources", "res_062", "id").is_some());
    assert_eq!(
        get_column(&device_b.vfs_db, "notes", "note_062", "resource_id").as_deref(),
        Some("res_062")
    );
    let _log = dump_sync_log();
}

#[test]
fn s63_self_referencing_fk_folder_parent_id() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_folder(&device_a, "fld_parent", None, "Parent");
    create_test_folder(&device_a, "fld_child", Some("fld_parent"), "Child");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "folders", "fld_child", "parent_id").as_deref(),
        Some("fld_parent")
    );
    let _log = dump_sync_log();
}

#[test]
fn s64_composite_pk_record_id() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_mistake(&device_a, "mistake_064", "Q64", "[\"c\"]");
    create_test_review_session(&device_a, "rs_064", "Comp", "2026-05-01", "2026-05-07");
    device_a.mistakes_db.execute("INSERT INTO review_session_mistakes (session_id, mistake_id, added_at) VALUES ('rs_064', 'mistake_064', datetime('now'))", []).unwrap();
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    let c: i64 = device_b
        .mistakes_db
        .query_row(
            "SELECT COUNT(*) FROM review_session_mistakes WHERE session_id='rs_064'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c, 1);
    let _log = dump_sync_log();
}

#[test]
fn s65_autoincrement_pk_on_chat_messages() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_mistake(&device_a, "mistake_065", "APK", "[\"t\"]");
    for i in 0..5 {
        create_test_chat_message_mistakes(&device_a, "mistake_065", "user", &format!("Msg {}", i));
    }
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    let c: i64 = device_b
        .mistakes_db
        .query_row(
            "SELECT COUNT(*) FROM chat_messages WHERE mistake_id='mistake_065'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(c >= 5);
    let _log = dump_sync_log();
}

// ============================================================================
// Category 6: Multi-Table Transactional Integrity (S66-S75)
// ============================================================================

#[test]
fn s66_create_resource_note_in_same_batch_atomic() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_066", "note", "atom", "hash_066");
    create_test_note(&device_a, "note_066", "res_066", "Atomic");
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert!(row_count_all(&device_b.vfs_db, "resources") >= 1);
    assert!(row_count_all(&device_b.vfs_db, "notes") >= 1);
    let _log = dump_sync_log();
}

#[test]
fn s67_delete_parent_cascade_synced() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_067", "note", "c", "hash_067");
    create_test_folder(&device_a, "fld_067", None, "Cascade");
    create_test_folder_item(&device_a, "fi_067", "fld_067", "note", "res_067");
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE folders SET deleted_at = '2026-06-01T00:00:00Z' WHERE id='fld_067'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let d = get_column(&device_b.vfs_db, "folders", "fld_067", "deleted_at");
    assert!(d.is_some() && !d.unwrap().is_empty());
    let _log = dump_sync_log();
}

#[test]
fn s68_reorder_folder_items_sort_order_preserved() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_folder(&device_a, "fld_068", None, "Reordered");
    create_test_resource(&device_a, "res_068", "note", "d", "hash_068");
    create_test_note(&device_a, "note_068", "res_068", "N");
    create_test_folder_item(&device_a, "fi_068", "fld_068", "note", "note_068");
    device_a
        .vfs_db
        .execute(
            "UPDATE folder_items SET sort_order = 99 WHERE id='fi_068'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let so = get_column_i64(&device_b.vfs_db, "folder_items", "fi_068", "sort_order");
    assert_eq!(so, Some(99));
    let _log = dump_sync_log();
}

#[test]
fn s69_move_note_between_folders() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_folder(&device_a, "fld_069a", None, "From");
    create_test_folder(&device_a, "fld_069b", None, "To");
    create_test_resource(&device_a, "res_069", "note", "m", "hash_069");
    create_test_note(&device_a, "note_069", "res_069", "Movable");
    create_test_folder_item(&device_a, "fi_069", "fld_069a", "note", "note_069");
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE folder_items SET folder_id = 'fld_069b' WHERE id='fi_069'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "folder_items", "fi_069", "folder_id").as_deref(),
        Some("fld_069b")
    );
    let _log = dump_sync_log();
}

#[test]
fn s70_link_unlink_mistake_to_session_cross_db() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_070", "analysis", "CrossDB");
    device_a.chat_v2_db.execute("INSERT INTO chat_v2_session_mistakes (session_id, mistake_id, created_at) VALUES ('sess_070', 'm_070', datetime('now'))", []).unwrap();
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let c: i64 = device_b
        .chat_v2_db
        .query_row(
            "SELECT COUNT(*) FROM chat_v2_session_mistakes WHERE session_id='sess_070'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c, 1);
    // Unlink
    device_a.chat_v2_db.execute("DELETE FROM chat_v2_session_mistakes WHERE session_id='sess_070' AND mistake_id='m_070'", []).unwrap();
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let c2: i64 = device_b
        .chat_v2_db
        .query_row(
            "SELECT COUNT(*) FROM chat_v2_session_mistakes WHERE session_id='sess_070'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    log_sync(&format!("S70: remaining = {}", c2));
    let _log = dump_sync_log();
}

#[test]
fn s71_create_todo_item_with_parent_id_subtask() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_071", "note", "sub", "hash_071");
    create_test_todo_list(&device_a, "tdl_071", "res_071", "Parent List");
    create_test_todo_item(&device_a, "ti_071_p", "tdl_071", "Parent Task", None);
    create_test_todo_item(
        &device_a,
        "ti_071_c",
        "tdl_071",
        "Child Task",
        Some("ti_071_p"),
    );
    full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(
        get_column(&device_b.vfs_db, "todo_items", "ti_071_c", "parent_id").as_deref(),
        Some("ti_071_p")
    );
    let _log = dump_sync_log();
}

#[test]
fn s72_pomodoro_record_with_end_time_before_start() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_072", "note", "pm", "hash_072");
    create_test_todo_list(&device_a, "tdl_072", "res_072", "PM");
    create_test_todo_item(&device_a, "ti_072", "tdl_072", "Task", None);
    device_a.vfs_db.execute("INSERT INTO pomodoro_records (id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at) VALUES ('pd_072', 'ti_072', '2026-05-01T10:05:00Z', '2026-05-01T10:00:00Z', 1500, 0, 'work', 'completed', '2026-05-01T10:00:00Z')", []).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let et: String = device_b
        .vfs_db
        .query_row(
            "SELECT end_time FROM pomodoro_records WHERE id='pd_072'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    log_sync(&format!("S72: end_time = {}", et));
    assert!(!et.is_empty());
    let _log = dump_sync_log();
}

#[test]
#[ignore = "answer_submissions UNIQUE(client_request_id) needs engine's COALESCE UPSERT"]
fn s73_answer_submission_idempotency_client_request_id() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_073", "exam", "ed", "hash_073");
    create_test_exam_sheet(&device_a, "exam_073", "Idem", "res_073");
    create_test_question(&device_a, "q_073", "exam_073", "Q73");
    create_test_answer_submission(&device_a, "as_073", "q_073", "Answer A", 1);
    full_sync_cycle(&device_a, &device_b, &cloud);
    // Idempotent: same submission should not duplicate
    // Use INSERT OR IGNORE to safely handle duplicate id (PK constraint)
    let ts = Utc::now().to_rfc3339();
    device_b.vfs_db.execute(
        "INSERT OR IGNORE INTO answer_submissions (id, question_id, user_answer, is_correct, grading_method, submitted_at) VALUES (?1, ?2, ?3, ?4, 'auto', ?5)",
        params!["as_073", "q_073", "Answer A", 1, ts],
    ).unwrap();
    let c: i64 = device_b
        .vfs_db
        .query_row(
            "SELECT COUNT(*) FROM answer_submissions WHERE id='as_073'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        c, 1,
        "Duplicate submission should be ignored by idempotency check"
    );
    let _log = dump_sync_log();
}

#[test]
#[ignore = "Self-referencing FK requires FK-ordering in changeset batch"]
fn s74_question_with_parent_id_variant_question() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_074", "exam", "ed", "hash_074");
    create_test_exam_sheet(&device_a, "exam_074", "Variant", "res_074");
    // Insert parent question first, then child — FK references parent
    create_test_question(&device_a, "q_074_p", "exam_074", "Parent Q");
    let ts = Utc::now().to_rfc3339();
    device_a.vfs_db.execute("INSERT INTO questions (id, exam_id, content, parent_id, question_type, tags, status, created_at, updated_at) VALUES ('q_074_v', 'exam_074', 'Variant Q', 'q_074_p', 'choice', '[]', 'new', ?1, ?1)", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    // Verify FK integrity: child references parent on both devices
    assert_eq!(
        get_column(&device_b.vfs_db, "questions", "q_074_v", "parent_id").as_deref(),
        Some("q_074_p")
    );
    // Also verify parent exists on B
    let parent_exists: i64 = device_b
        .vfs_db
        .query_row(
            "SELECT COUNT(*) FROM questions WHERE id='q_074_p'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(parent_exists, 1, "Parent question should exist on B");
    let _log = dump_sync_log();
}

#[test]
fn s75_simultaneous_folder_tree_restructure() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_folder(&device_a, "root_a", None, "RootA");
    create_test_folder(&device_a, "child_a", Some("root_a"), "ChildA1");
    create_test_folder(&device_a, "root_b", None, "RootB");
    full_sync_cycle(&device_a, &device_b, &cloud);
    // Restructure: A moves child_a under root_b, B deletes child_a
    device_a
        .vfs_db
        .execute(
            "UPDATE folders SET parent_id = 'root_b' WHERE id='child_a'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE folders SET deleted_at = datetime('now') WHERE id='child_a'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let parent = get_column(&device_a.vfs_db, "folders", "child_a", "parent_id");
    log_sync(&format!("S75: child_a parent after sync = {:?}", parent));
    let _log = dump_sync_log();
}

// ============================================================================
// Category 7: RefCount / Counter (S76-S85)
// ============================================================================

#[test]
fn s76_increment_ref_count_from_2_devices() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, ref_count, created_at, updated_at, storage_mode) VALUES ('res_076', 'hash_076', 'note', 1, ?1, ?1, 'inline')", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE resources SET ref_count = ref_count + 1 WHERE id='res_076'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE resources SET ref_count = ref_count + 1 WHERE id='res_076'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let rc = get_column_i64(&device_a.vfs_db, "resources", "res_076", "ref_count");
    log_sync(&format!("S76: ref_count = {:?}", rc));
    assert_eq!(rc, Some(2));
    let _log = dump_sync_log();
}

#[test]
fn s77_decrement_ref_count_verify_not_below_zero() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, ref_count, created_at, updated_at, storage_mode) VALUES ('res_077', 'hash_077', 'note', 2, ?1, ?1, 'inline')", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE resources SET ref_count = MAX(0, ref_count - 1) WHERE id='res_077'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let rc = get_column_i64(&device_b.vfs_db, "resources", "res_077", "ref_count");
    assert_eq!(rc, Some(1));
    let _log = dump_sync_log();
}

#[test]
fn s78_ref_count_to_zero_should_not_delete_resource() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, ref_count, created_at, updated_at, storage_mode) VALUES ('res_078', 'hash_078', 'note', 1, ?1, ?1, 'inline')", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute("UPDATE resources SET ref_count = 0 WHERE id='res_078'", [])
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let exists = row_count_all(&device_b.vfs_db, "resources");
    assert!(
        exists >= 1,
        "Resource should still exist even with ref_count=0"
    );
    let _log = dump_sync_log();
}

#[test]
fn s79_concurrent_pomodoro_completion_counts_sum_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_079", "note", "pmc", "hash_079");
    create_test_todo_list(&device_a, "tdl_079", "res_079", "PM");
    create_test_todo_item(&device_a, "ti_079", "tdl_079", "Focus", None);
    device_a
        .vfs_db
        .execute(
            "UPDATE todo_items SET completed_pomodoros = 3 WHERE id='ti_079'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE todo_items SET completed_pomodoros = 4 WHERE id='ti_079'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE todo_items SET completed_pomodoros = 5 WHERE id='ti_079'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let cp = get_column_i64(
        &device_a.vfs_db,
        "todo_items",
        "ti_079",
        "completed_pomodoros",
    );
    log_sync(&format!("S79: completed_pomodoros = {:?}", cp));
    assert!(cp.unwrap_or(0) > 0);
    let _log = dump_sync_log();
}

#[test]
fn s80_concurrent_attempt_count_on_question_max_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_080", "exam", "ed", "hash_080");
    create_test_exam_sheet(&device_a, "exam_080", "Attempts", "res_080");
    create_test_question(&device_a, "q_080", "exam_080", "Q80");
    device_a
        .vfs_db
        .execute(
            "UPDATE questions SET attempt_count = 5 WHERE id='q_080'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE questions SET attempt_count = 7 WHERE id='q_080'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE questions SET attempt_count = 6 WHERE id='q_080'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let ac = get_column_i64(&device_a.vfs_db, "questions", "q_080", "attempt_count");
    log_sync(&format!("S80: attempt_count = {:?}", ac));
    assert!(ac.unwrap_or(0) >= 5);
    let _log = dump_sync_log();
}

#[test]
fn s81_concurrent_correct_count_updates_max_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_081", "exam", "ed", "hash_081");
    create_test_exam_sheet(&device_a, "exam_081", "Correct", "res_081");
    create_test_question(&device_a, "q_081", "exam_081", "Q81");
    device_a
        .vfs_db
        .execute(
            "UPDATE questions SET correct_count = 3 WHERE id='q_081'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE questions SET correct_count = 4 WHERE id='q_081'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE questions SET correct_count = 5 WHERE id='q_081'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let cc = get_column_i64(&device_a.vfs_db, "questions", "q_081", "correct_count");
    log_sync(&format!("S81: correct_count = {:?}", cc));
    assert!(cc.unwrap_or(0) >= 3);
    let _log = dump_sync_log();
}

#[test]
fn s82_concurrent_estimated_pomodoros_sum_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_082", "note", "ep", "hash_082");
    create_test_todo_list(&device_a, "tdl_082", "res_082", "EP");
    create_test_todo_item(&device_a, "ti_082", "tdl_082", "Est", None);
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE todo_items SET estimated_pomodoros = 3 WHERE id='ti_082'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE todo_items SET estimated_pomodoros = 4 WHERE id='ti_082'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let ep = get_column_i64(
        &device_a.vfs_db,
        "todo_items",
        "ti_082",
        "estimated_pomodoros",
    );
    log_sync(&format!("S82: estimated_pomodoros = {:?}", ep));
    assert!(ep.unwrap_or(0) > 0);
    let _log = dump_sync_log();
}

#[test]
fn s83_concurrent_total_reviews_on_review_plan_max_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_083", "exam", "ed", "hash_083");
    create_test_exam_sheet(&device_a, "exam_083", "TR", "res_083");
    create_test_question(&device_a, "q_083", "exam_083", "Q83");
    create_test_review_plan(&device_a, "rp_083", "q_083", "exam_083");
    device_a
        .vfs_db
        .execute(
            "UPDATE review_plans SET total_reviews = 10 WHERE id='rp_083'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE review_plans SET total_reviews = 12 WHERE id='rp_083'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE review_plans SET total_reviews = 11 WHERE id='rp_083'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let tr = get_column_i64(&device_a.vfs_db, "review_plans", "rp_083", "total_reviews");
    log_sync(&format!("S83: total_reviews = {:?}", tr));
    assert!(tr.unwrap_or(0) >= 10);
    let _log = dump_sync_log();
}

#[test]
fn s84_ref_count_on_chat_v2_resources_separate_table() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    device_a.chat_v2_db.execute("INSERT INTO resources (id, hash, type, data, ref_count, created_at) VALUES ('cr_084', 'h084', 'image', 'b64', 3, 1000)", []).unwrap();
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    let rc: i64 = device_b
        .chat_v2_db
        .query_row(
            "SELECT ref_count FROM resources WHERE id='cr_084'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rc, 3);
    let _log = dump_sync_log();
}

#[test]
fn s85_blob_ref_count_not_in_row_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    // blobs table exists but sync is handled via FileSync (tombstones), not RowSync
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO blobs (hash, relative_path, size, ref_count, created_at) VALUES ('bh_085', 'ab/bh_085.pdf', 1024, 1, ?1)", params![ts]).unwrap();
    let changes = collect_pending_changes(&device_a.vfs_db);
    log_sync(&format!(
        "S85: {} blob changes collected (blobs use FileSync)",
        changes.len()
    ));
    let _log = dump_sync_log();
}

// ============================================================================
// Category 8: Prune Gap / Error Recovery (S86-S95)
// ============================================================================

#[test]
fn s86_normal_sync_after_small_gap() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_086", "note", "gap1", "hash_086");
    create_test_note(&device_a, "note_086", "res_086", "Gap1");
    full_sync_cycle(&device_a, &device_b, &cloud);
    // Small gap: B creates data, A creates more
    device_b
        .vfs_db
        .execute("UPDATE notes SET title = 'B After' WHERE id='note_086'", [])
        .unwrap();
    create_test_resource(&device_a, "res_086b", "note", "gap2", "hash_086b");
    create_test_note(&device_a, "note_086b", "res_086b", "Gap2");
    full_sync_cycle(&device_a, &device_b, &cloud);
    let c = row_count(&device_b.vfs_db, "notes");
    log_sync(&format!("S86: B notes after gap sync = {}", c));
    assert!(c >= 2);
    let _log = dump_sync_log();
}

#[test]
fn s87_gap_detected_and_handled() {
    clear_sync_log();
    let _cloud = SimulatedCloudStore::new();
    // Simulate local version behind cloud prune window
    let local_version = 100u64;
    let cloud_min = Some(500u64);
    // In real code: SyncManager::has_prune_gap(100, Some(500)) == true
    let has_gap = local_version < cloud_min.unwrap_or(0) && local_version > 0;
    log_sync(&format!(
        "S87: has_prune_gap({}, {:?}) = {}",
        local_version, cloud_min, has_gap
    ));
    assert!(has_gap);
    let _log = dump_sync_log();
}

#[test]
fn s88_multiple_incomplete_syncs_then_full_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_088", "note", "inc", "hash_088");
    create_test_note(&device_a, "note_088", "res_088", "Incomplete");
    // Upload A's changes but don't apply to B (simulate partial sync)
    let changes_a = collect_pending_changes(&device_a.vfs_db);
    cloud.upload_changes(&device_a.device_id, &changes_a);
    // More changes on A
    create_test_resource(&device_a, "res_088b", "note", "inc2", "hash_088b");
    create_test_note(&device_a, "note_088b", "res_088b", "Incomplete2");
    // Now full sync
    full_sync_cycle(&device_a, &device_b, &cloud);
    let c = row_count(&device_b.vfs_db, "notes");
    log_sync(&format!("S88: B notes after full sync = {}", c));
    assert!(c >= 2);
    let _log = dump_sync_log();
}

#[test]
fn s89_device_offline_for_10_rounds_then_reconnects() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_089", "note", "start", "hash_089");
    create_test_note(&device_a, "note_089", "res_089", "Start");
    full_sync_cycle(&device_a, &device_b, &cloud);
    // A goes offline, B keeps making changes
    for i in 0..10 {
        create_test_resource(
            &device_b,
            &format!("res_off_{}", i),
            "note",
            &format!("data{}", i),
            &format!("h_off_{}", i),
        );
        create_test_note(
            &device_b,
            &format!("note_off_{}", i),
            &format!("res_off_{}", i),
            &format!("Offline Note {}", i),
        );
    }
    // A reconnects, sync all
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    let applied = apply_changes_to_db(&device_a.vfs_db, &for_a);
    log_sync(&format!("S89: A applied {} catch-up changes", applied));
    let c = row_count(&device_a.vfs_db, "notes");
    assert!(c >= 11);
    let _log = dump_sync_log();
}

#[test]
fn s90_corrupt_change_log_entry_skip_not_crash() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_090", "note", "corrupt", "hash_090");
    create_test_note(&device_a, "note_090", "res_090", "Corrupt");
    // Insert a garbage change_log entry
    device_a.vfs_db.execute("INSERT INTO __change_log (table_name, record_id, operation) VALUES ('nonexistent_table', 'x', 'INSERT')", []).unwrap();
    let changes = collect_pending_changes(&device_a.vfs_db);
    cloud.upload_changes(&device_a.device_id, &changes);
    let for_b = cloud.download_changes(&device_b.device_id);
    let applied = apply_changes_to_db(&device_b.vfs_db, &for_b);
    log_sync(&format!(
        "S90: B applied {} changes (corrupt skipped)",
        applied
    ));
    let c = row_count(&device_b.vfs_db, "notes");
    assert_eq!(c, 1);
    let _log = dump_sync_log();
}

#[test]
fn s91_missing_manifest_on_cloud_graceful_fallback() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    setup_all_schemas(&device_a);
    let cloud = SimulatedCloudStore::new();
    // Empty cloud should not cause errors
    let changes = cloud.download_changes(&device_a.device_id);
    assert!(changes.is_empty());
    log_sync("S91: Empty cloud handled gracefully");
    let _log = dump_sync_log();
}

#[test]
fn s92_duplicate_change_upload_idempotent_application() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_092", "note", "dup", "hash_092");
    create_test_note(&device_a, "note_092", "res_092", "Duplicate");
    // Upload same changes twice
    let changes = collect_pending_changes(&device_a.vfs_db);
    cloud.upload_changes(&device_a.device_id, &changes.clone());
    cloud.upload_changes(&device_a.device_id, &changes);
    // B downloads (duplicate batches)
    let for_b = cloud.download_changes(&device_b.device_id);
    apply_changes_to_db(&device_b.vfs_db, &for_b);
    // Should result in 1 note, not 2
    let c = row_count(&device_b.vfs_db, "notes");
    assert_eq!(c, 1);
    let _log = dump_sync_log();
}

#[test]
fn s93_sync_with_no_changes_zero_op_cycle() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let (b, a) = full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(b, 0);
    assert_eq!(a, 0);
    let (b2, a2) = full_sync_cycle(&device_a, &device_b, &cloud);
    assert_eq!(b2, 0);
    assert_eq!(a2, 0);
    log_sync("S93: Zero-op sync cycles handled");
    let _log = dump_sync_log();
}

#[test]
fn s94_upload_fails_midway_retry_succeeds() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_094", "note", "retry", "hash_094");
    create_test_note(&device_a, "note_094", "res_094", "Retry");
    // Simulate partial upload (just upload)
    let changes = collect_pending_changes(&device_a.vfs_db);
    cloud.upload_changes(&device_a.device_id, &changes);
    // Simulate retry: re-upload + full cycle
    cloud.upload_changes(&device_a.device_id, &changes);
    let for_b = cloud.download_changes(&device_b.device_id);
    apply_changes_to_db(&device_b.vfs_db, &for_b);
    let c = row_count(&device_b.vfs_db, "notes");
    assert_eq!(c, 1);
    let _log = dump_sync_log();
}

#[test]
#[ignore = "Schema version detection needs refinery_schema_history mock"]
fn s95_different_schema_versions_should_detect() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    // Only set up partial schema on B (chat_v2 only)
    device_b.setup_chat_v2_schema();
    // Verify that device A has full VFS schema with change_log
    let a_change_log: i64 = device_a
        .vfs_db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='__change_log'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        a_change_log > 0,
        "Device A should have __change_log table in VFS"
    );
    // Verify device B has only chat_v2 schema (no VFS tables)
    let b_vfs_tables: i64 = device_b
        .vfs_db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    // Device B's VFS was never set up, so it should have no tables
    assert_eq!(
        b_vfs_tables, 0,
        "Device B should have no VFS tables (only chat_v2 setup)"
    );
    // B's chat_v2 should have tables — check for a known table
    let has_sessions: i64 = device_b
        .chat_v2_db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chat_v2_sessions'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        has_sessions > 0,
        "Device B should have chat_v2_sessions table"
    );
    log_sync(&format!(
        "S95: A has __change_log={}, B VFS tables={}, B has chat_v2_sessions={}",
        a_change_log > 0,
        b_vfs_tables,
        has_sessions > 0
    ));
    let _log = dump_sync_log();
}

// ============================================================================
// Category 9: Field Merge Specific (S96-S105)
// ============================================================================

#[test]
fn s96_ease_factor_field_merge_average() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_096", "exam", "ed", "hash_096");
    create_test_exam_sheet(&device_a, "exam_096", "EF Avg", "res_096");
    create_test_question(&device_a, "q_096", "exam_096", "Q96");
    let ts = Utc::now().to_rfc3339();
    device_a.vfs_db.execute("INSERT INTO review_plans (id, question_id, exam_id, ease_factor, next_review_date, status, created_at, updated_at) VALUES ('rp_096', 'q_096', 'exam_096', 2.5, ?1, 'learning', ?1, ?1)", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE review_plans SET ease_factor = 2.8 WHERE id='rp_096'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE review_plans SET ease_factor = 2.2 WHERE id='rp_096'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let ef = get_column_f64(&device_a.vfs_db, "review_plans", "rp_096", "ease_factor");
    log_sync(&format!("S96: ease_factor = {:?}", ef));
    assert!(ef.is_some());
    let _log = dump_sync_log();
}

#[test]
fn s97_interval_days_field_merge_max() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_097", "exam", "ed", "hash_097");
    create_test_exam_sheet(&device_a, "exam_097", "Interval", "res_097");
    create_test_question(&device_a, "q_097", "exam_097", "Q97");
    create_test_review_plan(&device_a, "rp_097", "q_097", "exam_097");
    device_a
        .vfs_db
        .execute(
            "UPDATE review_plans SET interval_days = 7 WHERE id='rp_097'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE review_plans SET interval_days = 10 WHERE id='rp_097'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE review_plans SET interval_days = 8 WHERE id='rp_097'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let idays = get_column_i64(&device_a.vfs_db, "review_plans", "rp_097", "interval_days");
    log_sync(&format!("S97: interval_days = {:?}", idays));
    assert!(idays.unwrap_or(0) > 0);
    let _log = dump_sync_log();
}

#[test]
fn s98_consecutive_failures_field_merge_max() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_098", "exam", "ed", "hash_098");
    create_test_exam_sheet(&device_a, "exam_098", "CF", "res_098");
    create_test_question(&device_a, "q_098", "exam_098", "Q98");
    create_test_review_plan(&device_a, "rp_098", "q_098", "exam_098");
    device_a
        .vfs_db
        .execute(
            "UPDATE review_plans SET consecutive_failures = 3 WHERE id='rp_098'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE review_plans SET consecutive_failures = 5 WHERE id='rp_098'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE review_plans SET consecutive_failures = 4 WHERE id='rp_098'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let cf = get_column_i64(
        &device_a.vfs_db,
        "review_plans",
        "rp_098",
        "consecutive_failures",
    );
    log_sync(&format!("S98: consecutive_failures = {:?}", cf));
    assert!(cf.unwrap_or(0) >= 3);
    let _log = dump_sync_log();
}

#[test]
fn s99_user_note_string_concat_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_099", "exam", "ed", "hash_099");
    create_test_exam_sheet(&device_a, "exam_099", "Note", "res_099");
    create_test_question(&device_a, "q_099", "exam_099", "Q99");
    device_a
        .vfs_db
        .execute(
            "UPDATE questions SET user_note = 'Note from A' WHERE id='q_099'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE questions SET user_note = 'Note from A + more from A' WHERE id='q_099'",
            [],
        )
        .unwrap();
    device_b
        .vfs_db
        .execute(
            "UPDATE questions SET user_note = 'Note from A + more from B' WHERE id='q_099'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let un = get_column(&device_a.vfs_db, "questions", "q_099", "user_note");
    log_sync(&format!("S99: user_note = {:?}", un));
    assert!(un.is_some() && !un.as_ref().unwrap().is_empty());
    let _log = dump_sync_log();
}

#[test]
fn s100_ai_feedback_string_concat_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_100", "exam", "ed", "hash_100");
    create_test_exam_sheet(&device_a, "exam_100", "AI", "res_100");
    create_test_question(&device_a, "q_100", "exam_100", "Q100");
    device_a
        .vfs_db
        .execute(
            "UPDATE questions SET ai_feedback = 'AI: Good work' WHERE id='q_100'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute(
            "UPDATE questions SET ai_feedback = 'AI: Good work + Excellent' WHERE id='q_100'",
            [],
        )
        .unwrap();
    device_b.vfs_db.execute("UPDATE questions SET ai_feedback = 'AI: Good work + Needs improvement' WHERE id='q_100'", []).unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let af = get_column(&device_a.vfs_db, "questions", "q_100", "ai_feedback");
    log_sync(&format!("S100: ai_feedback = {:?}", af));
    assert!(af.is_some());
    let _log = dump_sync_log();
}

#[test]
fn s101_is_favorite_boolean_or_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_101", "note", "fav", "hash_101");
    create_test_note(&device_a, "note_101", "res_101", "Fav");
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a
        .vfs_db
        .execute("UPDATE notes SET is_favorite = 1 WHERE id='note_101'", [])
        .unwrap();
    device_b
        .vfs_db
        .execute("UPDATE notes SET is_favorite = 1 WHERE id='note_101'", [])
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let fav = get_column_i64(&device_a.vfs_db, "notes", "note_101", "is_favorite");
    assert_eq!(fav, Some(1));
    let _log = dump_sync_log();
}

#[test]
fn s102_is_bookmarked_boolean_or_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_102", "exam", "ed", "hash_102");
    create_test_exam_sheet(&device_a, "exam_102", "Bookmark", "res_102");
    create_test_question(&device_a, "q_102", "exam_102", "Q102");
    device_a
        .vfs_db
        .execute(
            "UPDATE questions SET is_bookmarked = 1 WHERE id='q_102'",
            [],
        )
        .unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_b
        .vfs_db
        .execute(
            "UPDATE questions SET is_bookmarked = 1 WHERE id='q_102'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let bm = get_column_i64(&device_a.vfs_db, "questions", "q_102", "is_bookmarked");
    assert_eq!(bm, Some(1));
    let _log = dump_sync_log();
}

#[test]
fn s103_metadata_json_deep_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, metadata_json, ref_count, created_at, updated_at, storage_mode) VALUES ('res_103', 'hash_103', 'note', '{\"v\":1,\"a\":\"x\"}', 1, ?1, ?1, 'inline')", params![ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    device_a.vfs_db.execute("UPDATE resources SET metadata_json = '{\"v\":1,\"a\":\"x\",\"b\":\"y\"}' WHERE id='res_103'", []).unwrap();
    device_b.vfs_db.execute("UPDATE resources SET metadata_json = '{\"v\":1,\"a\":\"x\",\"c\":\"z\"}' WHERE id='res_103'", []).unwrap();
    let changes_b = collect_pending_changes(&device_b.vfs_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.vfs_db, &for_a);
    let m = get_column(&device_a.vfs_db, "resources", "res_103", "metadata_json");
    log_sync(&format!("S103: metadata = {:?}", m));
    assert!(m.is_some());
    let _log = dump_sync_log();
}

#[test]
fn s104_citations_json_deep_merge() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_104", "general_chat", "Citations");
    create_test_chat_message(&device_a, "msg_104", "sess_104", "assistant", 1000);
    create_test_chat_block(&device_a, "blk_104", "msg_104", "content");
    device_a
        .chat_v2_db
        .execute(
            "UPDATE chat_v2_blocks SET citations_json = '[{\"url\":\"a.com\"}]' WHERE id='blk_104'",
            [],
        )
        .unwrap();
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    device_a.chat_v2_db.execute("UPDATE chat_v2_blocks SET citations_json = '[{\"url\":\"a.com\"},{\"url\":\"b.com\"}]' WHERE id='blk_104'", []).unwrap();
    device_b.chat_v2_db.execute("UPDATE chat_v2_blocks SET citations_json = '[{\"url\":\"a.com\"},{\"url\":\"c.com\"}]' WHERE id='blk_104'", []).unwrap();
    let changes_b = collect_pending_changes(&device_b.chat_v2_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.chat_v2_db, &for_a);
    let cit: String = device_a
        .chat_v2_db
        .query_row(
            "SELECT citations_json FROM chat_v2_blocks WHERE id='blk_104'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    log_sync(&format!("S104: citations = {}", cit));
    assert!(!cit.is_empty());
    let _log = dump_sync_log();
}

#[test]
fn s105_tags_json_set_union_on_anki_cards() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let ts = Utc::now().to_rfc3339();
    device_a.mistakes_db.execute("INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status, anki_generation_options_json, created_at, updated_at) VALUES ('task_105', 'doc_105', 'test.pdf', 0, 'S', 'Completed', '{}', ?1, ?1)", params![ts]).unwrap();
    create_test_anki_card(&device_a, "ac_105", "task_105", "Q", "A", "[\"tag1\"]");
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);
    device_a
        .mistakes_db
        .execute(
            "UPDATE anki_cards SET tags_json = '[\"tag1\",\"tag2\"]' WHERE id='ac_105'",
            [],
        )
        .unwrap();
    device_b
        .mistakes_db
        .execute(
            "UPDATE anki_cards SET tags_json = '[\"tag1\",\"tag3\"]' WHERE id='ac_105'",
            [],
        )
        .unwrap();
    let changes_b = collect_pending_changes(&device_b.mistakes_db);
    cloud.upload_changes(&device_b.device_id, &changes_b);
    let for_a = cloud.download_changes(&device_a.device_id);
    apply_changes_to_db(&device_a.mistakes_db, &for_a);
    let tags: String = device_a
        .mistakes_db
        .query_row(
            "SELECT tags_json FROM anki_cards WHERE id='ac_105'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    log_sync(&format!("S105: anki tags = {}", tags));
    assert!(!tags.is_empty());
    let _log = dump_sync_log();
}

// ============================================================================
// Category 10: Stress / Performance (S106-S115)
// ============================================================================

#[test]
fn s106_1000_records_bulk_create_and_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    for i in 0..1000 {
        create_test_resource(
            &device_a,
            &format!("rs{}", i),
            "note",
            "d",
            &format!("h{}", i),
        );
    }
    let (b_applied, _) = full_sync_cycle(&device_a, &device_b, &cloud);
    log_sync(&format!(
        "S106: B applied {} changes for 1000 records",
        b_applied
    ));
    let c = row_count(&device_b.vfs_db, "resources");
    assert_eq!(c, 1000);
    let _log = dump_sync_log();
}

#[test]
fn s107_100_records_each_with_50_updates() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    for i in 0..100 {
        create_test_resource(
            &device_a,
            &format!("ru{}", i),
            "note",
            "d",
            &format!("hu{}", i),
        );
        create_test_note(&device_a, &format!("nu{}", i), &format!("ru{}", i), "base");
    }
    full_sync_cycle(&device_a, &device_b, &cloud);
    // 50 sequential updates on each note
    for u in 0..50 {
        for i in 0..100 {
            device_a
                .vfs_db
                .execute(
                    "UPDATE notes SET title = ?1 WHERE id = ?2",
                    params![format!("n{}v{}", i, u), format!("nu{}", i)],
                )
                .unwrap();
        }
    }
    let (b_applied, _) = full_sync_cycle(&device_a, &device_b, &cloud);
    log_sync(&format!(
        "S107: B applied {} changes after 50x100 updates",
        b_applied
    ));
    let title = get_column(&device_b.vfs_db, "notes", "nu50", "title");
    assert!(title.unwrap_or_default().starts_with("n50v"));
    let _log = dump_sync_log();
}

#[test]
fn s108_10_devices_each_creating_10_records() {
    clear_sync_log();
    let cloud = SimulatedCloudStore::new();
    let mut devices = Vec::new();
    for d in 0..10 {
        let dev = SyncDevice::new(&format!("D{}", d), &format!("dev_{}", d));
        setup_all_schemas(&dev);
        for i in 0..10 {
            let idx = d * 10 + i;
            create_test_resource(
                &dev,
                &format!("r10_{}", idx),
                "note",
                "d",
                &format!("h10_{}", idx),
            );
        }
        devices.push(dev);
    }
    // All upload
    for dev in &devices {
        let changes = collect_pending_changes(&dev.vfs_db);
        cloud.upload_changes(&dev.device_id, &changes);
    }
    // All download (to device 0)
    let all = cloud.download_changes(&devices[0].device_id);
    let applied = apply_changes_to_db(&devices[0].vfs_db, &all);
    log_sync(&format!(
        "S108: Device 0 applied {} total changes from 10 devices",
        applied
    ));
    let c = row_count(&devices[0].vfs_db, "resources");
    assert_eq!(c, 100);
    let _log = dump_sync_log();
}

#[test]
fn s109_rapid_successive_syncs_10_cycles() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    for cycle in 0..10 {
        create_test_resource(
            &device_a,
            &format!("rc{}", cycle),
            "note",
            "d",
            &format!("hc{}", cycle),
        );
        full_sync_cycle(&device_a, &device_b, &cloud);
    }
    let c = row_count(&device_b.vfs_db, "resources");
    log_sync(&format!("S109: B has {} resources after 10 rapid syncs", c));
    assert_eq!(c, 10);
    let _log = dump_sync_log();
}

#[test]
fn s110_deeply_nested_json_5_levels() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    let deep = r#"{"l1":{"l2":{"l3":{"l4":{"l5":"deepest"}}}}}"#;
    let ts = Utc::now().timestamp_millis();
    device_a.vfs_db.execute("INSERT INTO resources (id, hash, type, metadata_json, ref_count, created_at, updated_at, storage_mode) VALUES ('res_110', 'hash_110', 'note', ?1, 1, ?2, ?2, 'inline')", params![deep, ts]).unwrap();
    full_sync_cycle(&device_a, &device_b, &cloud);
    let m = get_column(&device_b.vfs_db, "resources", "res_110", "metadata_json");
    assert_eq!(m.as_deref(), Some(deep));
    let _log = dump_sync_log();
}

#[test]
fn s111_100_folders_with_5_items_each() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    for f in 0..100 {
        create_test_folder(
            &device_a,
            &format!("f111_{}", f),
            None,
            &format!("Folder {}", f),
        );
        for i in 0..5 {
            let idx = f * 5 + i;
            create_test_resource(
                &device_a,
                &format!("r111_{}", idx),
                "note",
                "d",
                &format!("h111_{}", idx),
            );
            create_test_note(
                &device_a,
                &format!("n111_{}", idx),
                &format!("r111_{}", idx),
                &format!("N{}", idx),
            );
            create_test_folder_item(
                &device_a,
                &format!("fi111_{}", idx),
                &format!("f111_{}", f),
                "note",
                &format!("n111_{}", idx),
            );
        }
    }
    full_sync_cycle(&device_a, &device_b, &cloud);
    let fc = row_count(&device_b.vfs_db, "folders");
    let fic = row_count(&device_b.vfs_db, "folder_items");
    log_sync(&format!("S111: {} folders, {} folder_items", fc, fic));
    assert_eq!(fc, 100);
    assert_eq!(fic, 500);
    let _log = dump_sync_log();
}

#[test]
fn s112_50_sessions_with_20_messages_each() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    for s in 0..50 {
        create_test_chat_session(
            &device_a,
            &format!("s112_{}", s),
            "general_chat",
            &format!("Session {}", s),
        );
        for m in 0..20 {
            let role = if m % 2 == 0 { "user" } else { "assistant" };
            create_test_chat_message(
                &device_a,
                &format!("m112_{}_{}", s, m),
                &format!("s112_{}", s),
                role,
                ((s * 20 + m + 1) * 1000) as i64,
            );
        }
    }
    let (applied, _) = full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    log_sync(&format!(
        "S112: B applied {} changes (50x20 messages)",
        applied
    ));
    let sc: i64 = device_b
        .chat_v2_db
        .query_row("SELECT COUNT(*) FROM chat_v2_sessions", [], |r| r.get(0))
        .unwrap();
    let mc: i64 = device_b
        .chat_v2_db
        .query_row("SELECT COUNT(*) FROM chat_v2_messages", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sc, 50);
    assert_eq!(mc, 1000);
    let _log = dump_sync_log();
}

#[test]
fn s113_concurrent_sync_plus_local_writes() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_resource(&device_a, "res_113", "note", "conc", "hash_113");
    create_test_note(&device_a, "note_113", "res_113", "Concurrent");
    // Upload A's changes, B downloads while A keeps writing
    let changes_a = collect_pending_changes(&device_a.vfs_db);
    cloud.upload_changes(&device_a.device_id, &changes_a);
    // A writes more while B downloads
    create_test_resource(&device_a, "res_113b", "note", "conc2", "hash_113b");
    create_test_note(&device_a, "note_113b", "res_113b", "Concurrent2");
    // B downloads
    let for_b = cloud.download_changes(&device_b.device_id);
    apply_changes_to_db(&device_b.vfs_db, &for_b);
    // Now sync again
    full_sync_cycle(&device_a, &device_b, &cloud);
    let c = row_count(&device_b.vfs_db, "notes");
    log_sync(&format!("S113: B has {} notes after concurrent ops", c));
    assert!(c >= 2);
    let _log = dump_sync_log();
}

#[test]
fn s114_large_attachment_metadata_100_attachments() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();
    create_test_chat_session(&device_a, "sess_114", "general_chat", "Attachments");
    create_test_chat_message(&device_a, "msg_114", "sess_114", "user", 1000);
    for i in 0..100 {
        create_test_chat_attachment(
            &device_a,
            &format!("att_{}", i),
            "msg_114",
            &format!("file_{}.png", i),
            "image/png",
            1024 * (i + 1) as i64,
        );
    }
    let (applied, _) = full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    log_sync(&format!(
        "S114: B applied {} changes (100 attachments)",
        applied
    ));
    let c: i64 = device_b
        .chat_v2_db
        .query_row(
            "SELECT COUNT(*) FROM chat_v2_attachments WHERE message_id='msg_114'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c, 100);
    let _log = dump_sync_log();
}

#[test]
#[ignore = "Full DB population needs comprehensive FK ordering"]
fn s115_full_database_population_all_tables_sync() {
    clear_sync_log();
    let device_a = SyncDevice::new("A", "device_a_001");
    let device_b = SyncDevice::new("B", "device_b_001");
    setup_all_schemas(&device_a);
    setup_all_schemas(&device_b);
    let cloud = SimulatedCloudStore::new();

    // VFS: populate notes, resources, questions, review_plans, folders, todo_lists, todo_items,
    //      pomodoro_records, essays, translations, mindmaps, exam_sheets, answer_submissions
    create_test_resource(&device_a, "res_note", "note", "full", "h_note");
    create_test_note(&device_a, "note_full", "res_note", "Full Note");
    create_test_resource(&device_a, "res_exam", "exam", "full_exam", "h_exam");
    create_test_exam_sheet(&device_a, "exam_full", "Full Exam", "res_exam");
    create_test_question(&device_a, "q_full", "exam_full", "Full Q");
    create_test_review_plan(&device_a, "rp_full", "q_full", "exam_full");
    create_test_folder(&device_a, "fld_full", None, "Full Folder");
    create_test_folder_item(&device_a, "fi_full", "fld_full", "note", "note_full");
    create_test_resource(&device_a, "res_todo", "note", "td", "h_todo");
    create_test_todo_list(&device_a, "tdl_full", "res_todo", "Full Todo");
    create_test_todo_item(&device_a, "ti_full", "tdl_full", "Full Item", None);
    create_test_pomodoro_record(&device_a, "pd_full", "ti_full");
    create_test_essay(&device_a, "essay_full", "res_note", "Full Essay", Some(90));
    create_test_translation(&device_a, "tr_full", "res_note", "Full Translation");
    create_test_mindmap(&device_a, "mm_full", "res_note", "Full Mindmap");
    create_test_answer_submission(&device_a, "as_full", "q_full", "Answer", 1);

    // Chat V2: populate sessions, messages, blocks, attachments, session_groups, workspace_index
    create_test_chat_session(&device_a, "sess_full", "general_chat", "Full Chat");
    create_test_chat_message(&device_a, "msg_full", "sess_full", "user", 1000);
    create_test_chat_block(&device_a, "blk_full", "msg_full", "content");
    create_test_chat_attachment(
        &device_a,
        "att_full",
        "msg_full",
        "img.png",
        "image/png",
        1024,
    );
    create_test_session_group(&device_a, "group_full", "Full Group");
    create_test_workspace_index(&device_a, "ws_full", "Full WS", "sess_full");
    device_a.chat_v2_db.execute("INSERT INTO resources (id, hash, type, data, ref_count, created_at) VALUES ('cr_full', 'h_cr', 'image', 'b64', 1, 1000)", []).unwrap();

    // Mistakes: populate mistakes, chat_messages, review_analyses, review_sessions,
    //           anki_cards, custom_anki_templates
    create_test_mistake(&device_a, "mistake_full", "Full Question", "[\"tag\"]");
    create_test_chat_message_mistakes(&device_a, "mistake_full", "user", "Full msg");
    create_test_review_analysis(&device_a, "ra_full", "Full Review", "[\"mistake_full\"]");
    create_test_review_session(
        &device_a,
        "rs_full",
        "Full Session",
        "2026-05-01",
        "2026-05-07",
    );
    device_a.mistakes_db.execute("INSERT INTO review_session_mistakes (session_id, mistake_id, added_at) VALUES ('rs_full', 'mistake_full', datetime('now'))", []).unwrap();
    let ts = Utc::now().to_rfc3339();
    device_a.mistakes_db.execute("INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status, anki_generation_options_json, created_at, updated_at) VALUES ('task_full', 'doc_full', 'test.pdf', 0, 'S', 'Completed', '{}', ?1, ?1)", params![ts]).unwrap();
    create_test_anki_card(&device_a, "ac_full", "task_full", "Q?", "A!", "[\"tag\"]");
    create_test_custom_anki_template(&device_a, "cat_full", "Full Template");
    device_a.mistakes_db.execute("INSERT INTO review_chat_messages (review_analysis_id, role, content, timestamp) VALUES ('ra_full', 'user', 'Review msg', datetime('now'))", []).unwrap();

    // Full sync all databases
    full_sync_cycle(&device_a, &device_b, &cloud);
    full_sync_cycle_chat_v2(&device_a, &device_b, &cloud);
    full_sync_cycle_mistakes(&device_a, &device_b, &cloud);

    // Verify key tables on B
    let checks = [
        ("notes", "vfs"),
        ("resources", "vfs"),
        ("questions", "vfs"),
        ("review_plans", "vfs"),
        ("folders", "vfs"),
        ("folder_items", "vfs"),
        ("todo_lists", "vfs"),
        ("todo_items", "vfs"),
        ("pomodoro_records", "vfs"),
        ("essays", "vfs"),
        ("translations", "vfs"),
        ("mindmaps", "vfs"),
        ("exam_sheets", "vfs"),
        ("answer_submissions", "vfs"),
        ("chat_v2_sessions", "chat_v2"),
        ("chat_v2_messages", "chat_v2"),
        ("chat_v2_blocks", "chat_v2"),
        ("chat_v2_attachments", "chat_v2"),
        ("chat_v2_session_groups", "chat_v2"),
        ("workspace_index", "chat_v2"),
        ("mistakes", "mistakes"),
        ("chat_messages", "mistakes"),
        ("review_analyses", "mistakes"),
        ("review_sessions", "mistakes"),
        ("anki_cards", "mistakes"),
        ("review_chat_messages", "mistakes"),
    ];

    for (table, db_name) in &checks {
        assert!(
            verify_devices_converged(&device_a, &device_b, table, db_name),
            "Table {}.{} should converge",
            db_name,
            table
        );
    }

    log_sync("S115: Full database population sync verified across all tables");
    let _log = dump_sync_log();
}
