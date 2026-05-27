//! Real migrated database sync flow smoke tests.
//!
//! These tests exercise the public SyncManager path against databases created by
//! the real migration coordinator. They are intentionally small, but they use
//! real tables, real triggers, and real FK chains.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo};
use deep_student_lib::data_governance::migration::MigrationCoordinator;
use deep_student_lib::data_governance::sync::{
    classification::{sync_classification_registry, SyncCategory, TableClassification},
    MergeStrategy, SyncChangeWithData, SyncError, SyncManager,
};
use deep_student_lib::models::AppError;
use rusqlite::{params, types::ValueRef, Connection};
use serde_json::{Map, Number, Value};
use tempfile::TempDir;

type CloudResult<T> = Result<T, AppError>;

#[derive(Default)]
struct MemoryCloudStorage {
    files: Mutex<BTreeMap<String, (Vec<u8>, chrono::DateTime<Utc>)>>,
}

#[async_trait]
impl CloudStorage for MemoryCloudStorage {
    fn provider_name(&self) -> &'static str {
        "memory"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone()))
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        let mut files: Vec<FileInfo> = self
            .files
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, (data, modified))| FileInfo {
                key: key.clone(),
                size: data.len() as u64,
                last_modified: *modified,
                etag: None,
            })
            .collect();
        files.sort_by(|left, right| right.last_modified.cmp(&left.last_modified));
        Ok(files)
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, modified)| FileInfo {
                key: key.to_string(),
                size: data.len() as u64,
                last_modified: *modified,
                etag: None,
            }))
    }
}

struct MigratedWorkspace {
    _temp_dir: TempDir,
    paths: BTreeMap<&'static str, PathBuf>,
}

impl MigratedWorkspace {
    fn open(&self, database: &str) -> Connection {
        let path = self
            .paths
            .get(database)
            .unwrap_or_else(|| panic!("missing migrated database path for {database}"));
        Connection::open(path)
            .unwrap_or_else(|e| panic!("failed to open migrated {database} database: {e}"))
    }
}

fn migrate_workspace() -> MigratedWorkspace {
    let temp_dir = TempDir::new().expect("create temp app data dir");
    let root = temp_dir.path().to_path_buf();
    let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
    let report = coordinator.run_all().expect("real migrations should run");
    assert!(
        report.success,
        "migration report should be successful: {report:?}"
    );

    let paths = BTreeMap::from([
        ("vfs", root.join("databases").join("vfs.db")),
        ("chat_v2", root.join("chat_v2.db")),
        ("mistakes", root.join("mistakes.db")),
        ("llm_usage", root.join("llm_usage.db")),
    ]);

    for (database, path) in &paths {
        assert!(
            path.exists(),
            "migration should create {database} database at {}",
            path.display()
        );
    }

    MigratedWorkspace {
        _temp_dir: temp_dir,
        paths,
    }
}

fn clear_change_log(conn: &Connection) {
    conn.execute("DELETE FROM __change_log", [])
        .expect("clear migrated change log");
}

fn pending_count(conn: &Connection) -> usize {
    SyncManager::get_pending_changes(conn, None, None)
        .expect("read pending changes")
        .total_count
}

fn cloud_changes(conn: &Connection, database_name: &str) -> Vec<SyncChangeWithData> {
    let pending = SyncManager::get_pending_changes(conn, None, None).expect("read pending");
    assert!(
        pending.has_changes(),
        "source database should have pending changes"
    );
    let mut changes = SyncManager::enrich_changes_with_data(conn, &pending.entries, None)
        .expect("enrich pending changes");
    for change in &mut changes {
        change.database_name = Some(database_name.to_string());
        change.suppress_change_log = Some(true);
    }
    changes
}

fn reverse_for_fk_stress(mut changes: Vec<SyncChangeWithData>) -> Vec<SyncChangeWithData> {
    changes.reverse();
    changes
}

fn insert_vfs_note_bundle(conn: &Connection, res_id: &str, note_id: &str, hash: &str, title: &str) {
    let created_ms = 1_714_000_000_000i64;
    let created_iso = "2024-04-24T00:00:00Z";
    conn.execute(
        "INSERT INTO resources (
            id, hash, type, storage_mode, data, metadata_json, ref_count, created_at, updated_at
         ) VALUES (?1, ?2, 'note', 'inline', ?3, '{}', 1, ?4, ?4)",
        params![res_id, hash, format!("body for {title}"), created_ms],
    )
    .expect("insert real vfs resource");
    conn.execute(
        "INSERT INTO notes (
            id, resource_id, title, tags, is_favorite, created_at, updated_at
         ) VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4)",
        params![note_id, res_id, title, created_iso],
    )
    .expect("insert real vfs note");
}

fn insert_chat_bundle(conn: &Connection) {
    let now = "2024-04-24T00:00:00Z";
    let ts = 1_714_000_000_000i64;

    conn.execute(
        "INSERT INTO chat_v2_sessions (
            id, mode, title, persist_status, created_at, updated_at, metadata_json
         ) VALUES ('sess_real_1', 'general_chat', 'Real chat', 'active', ?1, ?1, '{}')",
        params![now],
    )
    .expect("insert real chat session");

    conn.execute(
        "INSERT INTO chat_v2_messages (
            id, session_id, role, block_ids_json, timestamp, attachments_json, updated_at
         ) VALUES (
            'msg_real_1', 'sess_real_1', 'assistant', '[\"blk_real_1\"]',
            ?1, '[{\"id\":\"att_real_1\"}]', ?2
         )",
        params![ts, now],
    )
    .expect("insert real chat message");

    conn.execute(
        "INSERT INTO chat_v2_blocks (
            id, message_id, block_type, status, block_index, content, started_at, ended_at,
            updated_at
         ) VALUES (
            'blk_real_1', 'msg_real_1', 'content', 'success', 0,
            'streamed content', ?1, ?1, ?2
         )",
        params![ts, now],
    )
    .expect("insert real chat block");

    conn.execute(
        "INSERT INTO chat_v2_attachments (
            id, message_id, block_id, name, type, mime_type, size, status, storage_path,
            content_hash, created_at, updated_at
         ) VALUES (
            'att_real_1', 'msg_real_1', 'blk_real_1', 'scan.pdf', 'document',
            'application/pdf', 42, 'ready', 'active/documents/scan.pdf',
            'hash_scan_pdf', ?1, ?1
         )",
        params![now],
    )
    .expect("insert real chat attachment");
}

fn insert_vfs_all_row_sync_bundle(conn: &Connection) {
    let ms = 1_714_000_000_000i64;
    let ts = "2024-04-24T00:00:00Z";

    for (id, hash, kind, body) in [
        ("res_all_note", "hash_all_note", "note", "note body"),
        ("res_all_file", "hash_all_file", "file", "file body"),
        ("res_all_exam", "hash_all_exam", "exam", "exam body"),
        (
            "res_all_translation",
            "hash_all_translation",
            "translation",
            "translation body",
        ),
        ("res_all_essay", "hash_all_essay", "essay", "essay body"),
        (
            "res_all_mindmap",
            "hash_all_mindmap",
            "note",
            "mindmap body",
        ),
    ] {
        conn.execute(
            "INSERT INTO resources (
                id, hash, type, storage_mode, data, metadata_json, ref_count, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'inline', ?4, '{}', 1, ?5, ?5)",
            params![id, hash, kind, body, ms],
        )
        .expect("insert vfs resource");
    }

    conn.execute(
        "INSERT INTO notes (
            id, resource_id, title, tags, is_favorite, created_at, updated_at
         ) VALUES ('note_all', 'res_all_note', 'All rows note', '[\"sync\"]', 1, ?1, ?1)",
        params![ts],
    )
    .expect("insert vfs note");

    conn.execute(
        "INSERT INTO files (
            id, resource_id, sha256, file_name, size, tags_json, bookmarks_json, status,
            created_at, updated_at, type, name, content_hash, mime_type, preview_json
         ) VALUES (
            'file_all', 'res_all_file', 'sha_all_file', 'paper.pdf', 4096, '[\"pdf\"]',
            '[]', 'active', ?1, ?1, 'document', 'paper.pdf', 'content_hash_all_file',
            'application/pdf', '{}'
         )",
        params![ts],
    )
    .expect("insert vfs file");

    conn.execute(
        "INSERT INTO exam_sheets (
            id, resource_id, exam_name, status, temp_id, metadata_json, preview_json,
            created_at, updated_at, is_favorite
         ) VALUES ('exam_all', 'res_all_exam', 'All rows exam', 'completed', 'tmp_exam_all', '{}', '{}', ?1, ?1, 0)",
        params![ts],
    )
    .expect("insert vfs exam");

    conn.execute(
        "INSERT INTO questions (
            id, exam_id, content, options_json, answer, explanation, question_type, tags,
            status, created_at, updated_at
         ) VALUES (
            'q_all', 'exam_all', '2+2?', '[\"3\",\"4\"]', '4', 'basic arithmetic',
            'choice', '[\"math\"]', 'new', ?1, ?1
         )",
        params![ts],
    )
    .expect("insert vfs question");

    conn.execute(
        "INSERT INTO review_plans (
            id, question_id, exam_id, next_review_date, status, created_at, updated_at
         ) VALUES ('rp_all', 'q_all', 'exam_all', ?1, 'new', ?1, ?1)",
        params![ts],
    )
    .expect("insert vfs review plan");

    conn.execute(
        "INSERT INTO answer_submissions (
            id, question_id, user_answer, is_correct, grading_method, submitted_at, updated_at
         ) VALUES ('as_all', 'q_all', '4', 1, 'manual', ?1, ?1)",
        params![ts],
    )
    .expect("insert vfs answer submission");

    conn.execute(
        "INSERT INTO translations (
            id, resource_id, src_lang, tgt_lang, engine, model, is_favorite,
            quality_rating, created_at, metadata_json, title, subject, updated_at
         ) VALUES (
            'tr_all', 'res_all_translation', 'en', 'zh', 'test', 'model', 0,
            5, ?1, '{}', 'All rows translation', 'english', ?1
         )",
        params![ts],
    )
    .expect("insert vfs translation");

    conn.execute(
        "INSERT INTO essay_sessions (
            id, title, essay_type, grade_level, subject, total_rounds, latest_score,
            created_at, updated_at
         ) VALUES ('essay_sess_all', 'Essay session', 'argument', 'high', '语文', 1, 92, ?1, ?1)",
        params![ts],
    )
    .expect("insert vfs essay session");

    conn.execute(
        "INSERT INTO essays (
            id, resource_id, title, essay_type, grading_result_json, score, session_id,
            round_number, grade_level, dimension_scores_json, created_at, updated_at
         ) VALUES (
            'essay_all', 'res_all_essay', 'All rows essay', 'argument', '{}', 92,
            'essay_sess_all', 1, 'high', '{}', ?1, ?1
         )",
        params![ts],
    )
    .expect("insert vfs essay");

    conn.execute(
        "INSERT INTO mindmaps (
            id, resource_id, title, description, default_view, theme, settings, created_at, updated_at
         ) VALUES (
            'mm_all', 'res_all_mindmap', 'All rows mindmap', 'desc', 'outline',
            'default', '{}', ?1, ?1
         )",
        params![ts],
    )
    .expect("insert vfs mindmap");

    conn.execute(
        "INSERT INTO folders (
            id, parent_id, title, icon, color, sort_order, created_at, updated_at
         ) VALUES ('fld_all', NULL, 'All rows folder', 'folder', '#336699', 0, ?1, ?1)",
        params![ms],
    )
    .expect("insert vfs folder");

    conn.execute(
        "INSERT INTO folder_items (
            id, folder_id, item_type, item_id, sort_order, created_at, updated_at
         ) VALUES ('fi_all', 'fld_all', 'note', 'note_all', 0, ?1, ?1)",
        params![ms],
    )
    .expect("insert vfs folder item");

    conn.execute(
        "INSERT INTO todo_lists (
            id, title, description, icon, color, sort_order, is_default, created_at, updated_at
         ) VALUES ('tdl_all', 'All rows todo list', 'desc', 'check', '#663399', 0, 1, ?1, ?1)",
        params![ts],
    )
    .expect("insert vfs todo list");

    conn.execute(
        "INSERT INTO todo_items (
            id, todo_list_id, title, description, status, priority, tags_json, sort_order,
            attachments_json, created_at, updated_at, estimated_pomodoros, completed_pomodoros
         ) VALUES (
            'ti_all', 'tdl_all', 'All rows todo item', 'desc', 'pending', 'medium',
            '[\"sync\"]', 0, '[]', ?1, ?1, 2, 1
         )",
        params![ts],
    )
    .expect("insert vfs todo item");

    conn.execute(
        "INSERT INTO pomodoro_records (
            id, todo_item_id, start_time, end_time, duration, actual_duration, type,
            status, created_at, updated_at
         ) VALUES ('pd_all', 'ti_all', ?1, ?1, 1500, 1200, 'work', 'completed', ?1, ?1)",
        params![ts],
    )
    .expect("insert vfs pomodoro record");
}

fn insert_chat_all_row_sync_bundle(conn: &Connection) {
    let ts = "2024-04-24T00:00:00Z";
    let ms = 1_714_000_000_000i64;

    conn.execute(
        "INSERT INTO chat_v2_session_groups (
            id, name, description, default_skill_ids_json, persist_status, created_at, updated_at
         ) VALUES ('group_all', 'All rows group', 'desc', '[]', 'active', ?1, ?1)",
        params![ts],
    )
    .expect("insert chat session group");

    conn.execute(
        "INSERT INTO chat_v2_sessions (
            id, mode, title, persist_status, created_at, updated_at, metadata_json, group_id
         ) VALUES ('sess_all', 'general_chat', 'All rows chat', 'active', ?1, ?1, '{}', 'group_all')",
        params![ts],
    )
    .expect("insert chat session");

    conn.execute(
        "INSERT INTO chat_v2_messages (
            id, session_id, role, block_ids_json, timestamp, meta_json, attachments_json,
            variants_json, shared_context_json, updated_at
         ) VALUES (
            'msg_all', 'sess_all', 'assistant', '[\"blk_all\"]', ?1, '{}', '[{\"id\":\"att_all\"}]',
            '[]', '{}', ?2
         )",
        params![ms, ts],
    )
    .expect("insert chat message");

    conn.execute(
        "INSERT INTO chat_v2_blocks (
            id, message_id, block_type, status, block_index, content, tool_input_json,
            tool_output_json, citations_json, started_at, ended_at, updated_at
         ) VALUES (
            'blk_all', 'msg_all', 'content', 'success', 0, 'answer', '{}',
            '{}', '[]', ?1, ?1, ?2
         )",
        params![ms, ts],
    )
    .expect("insert chat block");

    conn.execute(
        "INSERT INTO chat_v2_attachments (
            id, message_id, block_id, name, type, mime_type, size, status,
            storage_path, content_hash, created_at, updated_at
         ) VALUES (
            'att_all', 'msg_all', 'blk_all', 'attachment.pdf', 'document',
            'application/pdf', 2048, 'ready', 'active/documents/attachment.pdf',
            'hash_attachment_all', ?1, ?1
         )",
        params![ts],
    )
    .expect("insert chat attachment");

    conn.execute(
        "INSERT INTO resources (
            id, hash, type, source_id, data, metadata_json, ref_count, created_at, updated_at
         ) VALUES ('chat_res_all', 'hash_chat_res_all', 'note', 'note_all', 'snapshot', '{}', 1, ?1, ?2)",
        params![ms, ts],
    )
    .expect("insert chat resource");

    conn.execute(
        "INSERT INTO chat_v2_session_mistakes (
            session_id, mistake_id, relation_type, created_at, updated_at
         ) VALUES ('sess_all', 'mistake_all', 'primary', ?1, ?1)",
        params![ts],
    )
    .expect("insert chat session mistake");

    conn.execute(
        "INSERT INTO workspace_index (
            workspace_id, name, status, creator_session_id, created_at, updated_at
         ) VALUES ('ws_all', 'All rows workspace', 'active', 'sess_all', ?1, ?1)",
        params![ts],
    )
    .expect("insert chat workspace index");
}

fn insert_mistakes_all_row_sync_bundle(conn: &Connection) {
    let ts = "2024-04-24T00:00:00Z";

    conn.execute(
        "INSERT INTO mistakes (
            id, created_at, question_images, analysis_images, user_question, ocr_text,
            tags, mistake_type, status, updated_at, last_accessed_at, chat_metadata
         ) VALUES (
            'mistake_all', ?1, '[]', '[]', 'All rows mistake?', 'ocr', '[\"math\"]',
            'math', 'active', ?1, ?1, '{}'
         )",
        params![ts],
    )
    .expect("insert mistake");

    conn.execute(
        "INSERT INTO chat_messages (
            mistake_id, role, content, timestamp, rag_sources, memory_sources,
            graph_sources, web_search_sources, image_paths, image_base64,
            doc_attachments, tool_call, tool_result, overrides, relations,
            stable_id, turn_id, turn_seq, message_kind, lifecycle, metadata, updated_at
         ) VALUES (
            'mistake_all', 'user', 'mistake chat', ?1, '[]', '[]', '[]', '[]',
            '[]', '[]', '[]', '{}', '{}', '{}', '{}', 'stable_all',
            'turn_all', 1, 'normal', 'complete', '{}', ?1
         )",
        params![ts],
    )
    .expect("insert mistake chat message");

    conn.execute(
        "INSERT INTO review_analyses (
            id, name, created_at, updated_at, mistake_ids, consolidated_input,
            user_question, status, tags, temp_session_data
         ) VALUES (
            'ra_all', 'All rows analysis', ?1, ?1, '[\"mistake_all\"]',
            'input', 'question', 'active', '[\"review\"]', '{}'
         )",
        params![ts],
    )
    .expect("insert review analysis");

    conn.execute(
        "INSERT INTO review_chat_messages (
            review_analysis_id, role, content, timestamp, rag_sources, memory_sources,
            web_search_sources, image_paths, image_base64, doc_attachments, tool_call,
            tool_result, overrides, relations, updated_at
         ) VALUES (
            'ra_all', 'assistant', 'review chat', ?1, '[]', '[]', '[]', '[]',
            '[]', '[]', '{}', '{}', '{}', '{}', ?1
         )",
        params![ts],
    )
    .expect("insert review chat message");

    conn.execute(
        "INSERT INTO review_sessions (
            id, title, start_date, end_date, created_at, updated_at
         ) VALUES ('rs_all', 'All rows review session', '2024-04-24', '2024-04-25', ?1, ?1)",
        params![ts],
    )
    .expect("insert review session");

    conn.execute(
        "INSERT INTO review_session_mistakes (
            session_id, mistake_id, added_at, updated_at
         ) VALUES ('rs_all', 'mistake_all', ?1, ?1)",
        params![ts],
    )
    .expect("insert review session mistake");

    conn.execute(
        "INSERT INTO document_tasks (
            id, document_id, original_document_name, segment_index, content_segment,
            status, created_at, updated_at, anki_generation_options_json
         ) VALUES (
            'task_all', 'doc_all', 'source.pdf', 0, 'segment', 'Completed',
            ?1, ?1, '{}'
         )",
        params![ts],
    )
    .expect("insert document task");

    conn.execute(
        "INSERT INTO anki_cards (
            id, task_id, front, back, tags_json, images_json, extra_fields_json,
            source_type, source_id, created_at, updated_at
         ) VALUES (
            'anki_all', 'task_all', 'front', 'back', '[\"tag\"]', '[]', '{}',
            'document_task', 'task_all', ?1, ?1
         )",
        params![ts],
    )
    .expect("insert anki card");
}

fn insert_llm_usage_all_row_sync_bundle(conn: &Connection) {
    let ts = "2024-04-24T12:34:56.000Z";
    conn.execute(
        "INSERT INTO llm_usage_logs (
            id, timestamp, provider, model, adapter, api_config_id, prompt_tokens,
            completion_tokens, total_tokens, reasoning_tokens, cached_tokens, token_source,
            duration_ms, request_bytes, response_bytes, first_token_ms, caller_type,
            session_id, status, error_message, cost_estimate, updated_at
         ) VALUES (
            'usage_all', ?1, 'openai', 'gpt-4o-mini', 'openai_compatible', 'cfg_all',
            100, 50, 150, 10, 5, 'api', 1200, 512, 1024, 300, 'chat_v2',
            'sess_all', 'success', NULL, 0.0123, ?1
         )",
        params![ts],
    )
    .expect("insert llm usage log");
}

fn update_vfs_all_row_sync_bundle(conn: &Connection) {
    let ms = 1_714_086_400_000i64;
    let ts = "2024-04-25T00:00:00Z";
    conn.execute(
        "UPDATE resources SET data = data || ' / updated', updated_at = ?1",
        params![ms],
    )
    .expect("update vfs resources");
    conn.execute(
        "UPDATE notes SET title = 'All rows note updated', updated_at = ?1 WHERE id = 'note_all'",
        params![ts],
    )
    .expect("update vfs note");
    conn.execute(
        "UPDATE files SET file_name = 'paper-updated.pdf', name = 'paper-updated.pdf',
            size = 8192, updated_at = ?1 WHERE id = 'file_all'",
        params![ts],
    )
    .expect("update vfs file");
    conn.execute(
        "UPDATE exam_sheets SET exam_name = 'All rows exam updated', status = 'reviewed',
            updated_at = ?1 WHERE id = 'exam_all'",
        params![ts],
    )
    .expect("update vfs exam");
    conn.execute(
        "UPDATE questions SET content = '3+3?', answer = '6', status = 'answered',
            updated_at = ?1 WHERE id = 'q_all'",
        params![ts],
    )
    .expect("update vfs question");
    conn.execute(
        "UPDATE review_plans SET status = 'scheduled', next_review_date = ?1,
            updated_at = ?1 WHERE id = 'rp_all'",
        params![ts],
    )
    .expect("update vfs review plan");
    conn.execute(
        "UPDATE answer_submissions SET user_answer = '6', is_correct = 0,
            updated_at = ?1 WHERE id = 'as_all'",
        params![ts],
    )
    .expect("update vfs answer submission");
    conn.execute(
        "UPDATE translations SET title = 'All rows translation updated',
            quality_rating = 4, updated_at = ?1 WHERE id = 'tr_all'",
        params![ts],
    )
    .expect("update vfs translation");
    conn.execute(
        "UPDATE essay_sessions SET title = 'Essay session updated',
            latest_score = 88, updated_at = ?1 WHERE id = 'essay_sess_all'",
        params![ts],
    )
    .expect("update vfs essay session");
    conn.execute(
        "UPDATE essays SET title = 'All rows essay updated',
            score = 88, updated_at = ?1 WHERE id = 'essay_all'",
        params![ts],
    )
    .expect("update vfs essay");
    conn.execute(
        "UPDATE mindmaps SET title = 'All rows mindmap updated',
            description = 'desc updated', updated_at = ?1 WHERE id = 'mm_all'",
        params![ts],
    )
    .expect("update vfs mindmap");
    conn.execute(
        "UPDATE folders SET title = 'All rows folder updated',
            sort_order = 7, updated_at = ?1 WHERE id = 'fld_all'",
        params![ms],
    )
    .expect("update vfs folder");
    conn.execute(
        "UPDATE folder_items SET sort_order = 9, updated_at = ?1 WHERE id = 'fi_all'",
        params![ms],
    )
    .expect("update vfs folder item");
    conn.execute(
        "UPDATE todo_lists SET title = 'All rows todo list updated',
            sort_order = 3, updated_at = ?1 WHERE id = 'tdl_all'",
        params![ts],
    )
    .expect("update vfs todo list");
    conn.execute(
        "UPDATE todo_items SET title = 'All rows todo item updated',
            status = 'completed', priority = 'high', updated_at = ?1 WHERE id = 'ti_all'",
        params![ts],
    )
    .expect("update vfs todo item");
    conn.execute(
        "UPDATE pomodoro_records SET status = 'interrupted',
            actual_duration = 900, updated_at = ?1 WHERE id = 'pd_all'",
        params![ts],
    )
    .expect("update vfs pomodoro record");
}

fn update_chat_all_row_sync_bundle(conn: &Connection) {
    let ts = "2024-04-25T00:00:00Z";
    conn.execute(
        "UPDATE chat_v2_session_groups SET name = 'All rows group updated',
            updated_at = ?1 WHERE id = 'group_all'",
        params![ts],
    )
    .expect("update chat session group");
    conn.execute(
        "UPDATE chat_v2_sessions SET title = 'All rows chat updated',
            persist_status = 'archived', updated_at = ?1 WHERE id = 'sess_all'",
        params![ts],
    )
    .expect("update chat session");
    conn.execute(
        "UPDATE chat_v2_messages SET role = 'user', updated_at = ?1 WHERE id = 'msg_all'",
        params![ts],
    )
    .expect("update chat message");
    conn.execute(
        "UPDATE chat_v2_blocks SET content = 'answer updated',
            status = 'partial', updated_at = ?1 WHERE id = 'blk_all'",
        params![ts],
    )
    .expect("update chat block");
    conn.execute(
        "UPDATE chat_v2_attachments SET name = 'attachment-updated.pdf',
            size = 4096, status = 'indexed', updated_at = ?1 WHERE id = 'att_all'",
        params![ts],
    )
    .expect("update chat attachment");
    conn.execute(
        "UPDATE resources SET data = 'snapshot updated', updated_at = ?1 WHERE id = 'chat_res_all'",
        params![ts],
    )
    .expect("update chat resource");
    conn.execute(
        "UPDATE chat_v2_session_mistakes SET relation_type = 'secondary',
            updated_at = ?1 WHERE session_id = 'sess_all' AND mistake_id = 'mistake_all'",
        params![ts],
    )
    .expect("update chat session mistake");
    conn.execute(
        "UPDATE workspace_index SET name = 'All rows workspace updated',
            status = 'archived', updated_at = ?1 WHERE workspace_id = 'ws_all'",
        params![ts],
    )
    .expect("update chat workspace index");
}

fn update_mistakes_all_row_sync_bundle(conn: &Connection) {
    let ts = "2024-04-25T00:00:00Z";
    conn.execute(
        "UPDATE mistakes SET ocr_text = 'ocr updated', status = 'resolved',
            updated_at = ?1 WHERE id = 'mistake_all'",
        params![ts],
    )
    .expect("update mistake");
    conn.execute(
        "UPDATE chat_messages SET content = 'mistake chat updated',
            lifecycle = 'archived', updated_at = ?1
         WHERE mistake_id = 'mistake_all' AND stable_id = 'stable_all'",
        params![ts],
    )
    .expect("update mistake chat message");
    conn.execute(
        "UPDATE review_analyses SET name = 'All rows analysis updated',
            status = 'closed', updated_at = ?1 WHERE id = 'ra_all'",
        params![ts],
    )
    .expect("update review analysis");
    conn.execute(
        "UPDATE review_chat_messages SET content = 'review chat updated',
            updated_at = ?1 WHERE review_analysis_id = 'ra_all'",
        params![ts],
    )
    .expect("update review chat message");
    conn.execute(
        "UPDATE review_sessions SET title = 'All rows review session updated',
            end_date = '2024-04-26', updated_at = ?1 WHERE id = 'rs_all'",
        params![ts],
    )
    .expect("update review session");
    conn.execute(
        "UPDATE review_session_mistakes SET added_at = ?1, updated_at = ?1
         WHERE session_id = 'rs_all' AND mistake_id = 'mistake_all'",
        params![ts],
    )
    .expect("update review session mistake");
    conn.execute(
        "UPDATE document_tasks SET content_segment = 'segment updated',
            status = 'Paused', updated_at = ?1 WHERE id = 'task_all'",
        params![ts],
    )
    .expect("update document task");
    conn.execute(
        "UPDATE anki_cards SET front = 'front updated', back = 'back updated',
            updated_at = ?1 WHERE id = 'anki_all'",
        params![ts],
    )
    .expect("update anki card");
}

fn update_llm_usage_all_row_sync_bundle(conn: &Connection) {
    let ts = "2024-04-25T12:34:56.000Z";
    conn.execute(
        "UPDATE llm_usage_logs SET total_tokens = 180, completion_tokens = 80,
            status = 'success', updated_at = ?1 WHERE id = 'usage_all'",
        params![ts],
    )
    .expect("update llm usage log");
}

fn assert_table_counts_match(source: &Connection, target: &Connection, table_name: &str) {
    let sql = format!("SELECT COUNT(*) FROM \"{table_name}\"");
    let source_count: i64 = source
        .query_row(&sql, [], |row| row.get(0))
        .unwrap_or_else(|e| panic!("count source {table_name}: {e}"));
    let target_count: i64 = target
        .query_row(&sql, [], |row| row.get(0))
        .unwrap_or_else(|e| panic!("count target {table_name}: {e}"));
    assert_eq!(
        target_count, source_count,
        "{table_name} count should converge"
    );
}

fn quote_ident(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn business_columns(conn: &Connection, table_name: &str) -> Vec<String> {
    let escaped = table_name.replace('\'', "''");
    let sql = format!("PRAGMA table_info('{escaped}')");
    let mut stmt = conn.prepare(&sql).expect("prepare table_info query");

    stmt.query_map([], |row| row.get::<_, String>(1))
        .expect("query table_info")
        .filter_map(Result::ok)
        .filter(|column| {
            !matches!(
                column.as_str(),
                "device_id" | "local_version" | "sync_version"
            )
        })
        .collect()
}

fn row_order_columns(database_name: &str, table_name: &str) -> Vec<String> {
    sync_classification_registry()
        .into_iter()
        .find(|entry| entry.database == database_name && entry.table_name == table_name)
        .unwrap_or_else(|| panic!("missing sync classification for {database_name}.{table_name}"))
        .primary_key
        .split(',')
        .map(str::trim)
        .filter(|column| !column.is_empty() && *column != "(virtual)")
        .map(ToOwned::to_owned)
        .collect()
}

fn sql_value_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Number(value.into()),
        ValueRef::Real(value) => Value::Number(
            Number::from_f64(value)
                .unwrap_or_else(|| panic!("SQLite REAL value cannot be represented as JSON")),
        ),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).to_string()),
        ValueRef::Blob(value) => {
            let encoded = value
                .iter()
                .map(|byte| format!("{:02x}", *byte))
                .collect::<String>();
            Value::String(encoded)
        }
    }
}

fn canonical_business_rows(conn: &Connection, database_name: &str, table_name: &str) -> Vec<Value> {
    let columns = business_columns(conn, table_name);
    assert!(
        !columns.is_empty(),
        "{database_name}.{table_name} should expose comparable business columns"
    );

    let projection = columns
        .iter()
        .map(|column| quote_ident(column))
        .collect::<Vec<_>>()
        .join(", ");
    let order_by = row_order_columns(database_name, table_name)
        .into_iter()
        .filter(|column| columns.contains(column))
        .map(|column| quote_ident(&column))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = if order_by.is_empty() {
        format!("SELECT {projection} FROM {}", quote_ident(table_name))
    } else {
        format!(
            "SELECT {projection} FROM {} ORDER BY {order_by}",
            quote_ident(table_name)
        )
    };

    let mut stmt = conn.prepare(&sql).unwrap_or_else(|e| {
        panic!("prepare canonical query for {database_name}.{table_name}: {e}")
    });
    let rows = stmt
        .query_map([], |row| {
            let mut object = Map::new();
            for (index, column) in columns.iter().enumerate() {
                let value = row.get_ref(index)?;
                object.insert(column.clone(), sql_value_to_json(value));
            }
            Ok(Value::Object(object))
        })
        .unwrap_or_else(|e| panic!("query canonical rows for {database_name}.{table_name}: {e}"));

    rows.map(|row| {
        row.unwrap_or_else(|e| panic!("read canonical row for {database_name}.{table_name}: {e}"))
    })
    .collect()
}

fn assert_table_business_rows_match(
    source: &Connection,
    target: &Connection,
    database_name: &str,
    table_name: &str,
) {
    let source_rows = canonical_business_rows(source, database_name, table_name);
    let target_rows = canonical_business_rows(target, database_name, table_name);
    assert_eq!(
        target_rows, source_rows,
        "{database_name}.{table_name} business rows should converge"
    );
}

fn assert_deleted_at_is_set(conn: &Connection, table_name: &str, id: &str) {
    let sql = format!(
        "SELECT COUNT(*) FROM {} WHERE id = ?1 AND deleted_at IS NOT NULL",
        quote_ident(table_name)
    );
    let count: i64 = conn
        .query_row(&sql, params![id], |row| row.get(0))
        .unwrap_or_else(|e| panic!("read tombstone for {table_name}.{id}: {e}"));
    assert_eq!(count, 1, "{table_name}.{id} should be tombstoned");
}

fn apply_all_pending_and_assert(
    source: &Connection,
    target: &Connection,
    database_name: &str,
    expected_tables: &[&str],
) {
    let pending = SyncManager::get_pending_changes(source, None, None).expect("read pending");
    for table in expected_tables {
        assert!(
            pending.changes_by_table.contains_key(*table),
            "{database_name}.{table} should produce a pending change"
        );
    }

    let mut changes = cloud_changes(source, database_name);
    changes.reverse();
    let applied = SyncManager::apply_downloaded_changes(target, &changes, None)
        .unwrap_or_else(|e| panic!("apply {database_name} changes: {e}"));
    assert_eq!(
        applied.failure_count, 0,
        "{database_name} apply failures: {:?}",
        applied.failures
    );

    for table in expected_tables {
        assert_table_counts_match(source, target, table);
        assert_table_business_rows_match(source, target, database_name, table);
    }
    assert_eq!(
        pending_count(target),
        0,
        "{database_name} replay must not echo"
    );
}

fn insert_legacy_non_row_sync_change_log_entries(conn: &Connection, database_name: &str) -> usize {
    let mut inserted = 0usize;
    for entry in sync_classification_registry()
        .into_iter()
        .filter(|entry| entry.database == database_name)
        .filter(|entry| {
            !matches!(
                entry.category,
                SyncCategory::RowSync | SyncCategory::Deprecated
            )
        })
    {
        conn.execute(
            "INSERT INTO __change_log (table_name, record_id, operation)
             VALUES (?1, ?2, 'UPDATE')",
            params![entry.table_name, format!("legacy:{}", entry.table_name)],
        )
        .unwrap_or_else(|e| {
            panic!(
                "insert legacy non-RowSync change for {}.{}: {e}",
                database_name, entry.table_name
            )
        });
        inserted += 1;
    }
    inserted
}

fn assert_only_row_sync_pending_after_filter(conn: &Connection, database_name: &str) {
    let legacy_count = insert_legacy_non_row_sync_change_log_entries(conn, database_name);
    assert!(
        legacy_count > 0,
        "{database_name} should have non-RowSync tables"
    );

    let raw_pending = SyncManager::get_pending_changes(conn, None, None).expect("read pending");
    assert!(
        raw_pending.total_count > legacy_count,
        "{database_name} fixture must include RowSync entries as well as legacy entries"
    );

    let raw_total_count = raw_pending.total_count;
    let filtered = SyncManager::filter_pending_changes_for_database(raw_pending, database_name);
    let row_sync_tables: std::collections::HashSet<&'static str> =
        TableClassification::row_sync_tables()
            .into_iter()
            .filter(|entry| entry.database == database_name)
            .map(|entry| entry.table_name)
            .collect();
    assert!(
        filtered.total_count > 0,
        "{database_name} RowSync entries should survive filtering"
    );
    for entry in &filtered.entries {
        assert!(
            row_sync_tables.contains(entry.table_name.as_str()),
            "{database_name}.{} survived upload filtering but is not RowSync",
            entry.table_name
        );
    }
    assert_eq!(
        filtered.total_count,
        raw_total_count - legacy_count,
        "{database_name} filtering should remove only legacy non-RowSync entries"
    );
}

fn pending_rows_for_table(conn: &Connection, table_name: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM __change_log WHERE table_name = ?1 AND sync_version = 0",
        params![table_name],
        |row| row.get(0),
    )
    .unwrap_or_else(|e| panic!("count pending rows for {table_name}: {e}"))
}

fn pending_record_ids_for_table(conn: &Connection, table_name: &str) -> BTreeSet<String> {
    let mut stmt = conn
        .prepare(
            "SELECT record_id FROM __change_log
             WHERE table_name = ?1 AND sync_version = 0
             ORDER BY record_id",
        )
        .unwrap_or_else(|e| panic!("prepare pending record id query for {table_name}: {e}"));

    stmt.query_map(params![table_name], |row| row.get::<_, String>(0))
        .unwrap_or_else(|e| panic!("query pending record ids for {table_name}: {e}"))
        .map(|row| row.unwrap_or_else(|e| panic!("read pending record id for {table_name}: {e}")))
        .collect()
}

fn pending_table_names(conn: &Connection) -> BTreeSet<String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT table_name FROM __change_log
             WHERE sync_version = 0
             ORDER BY table_name",
        )
        .expect("prepare pending table names query");

    stmt.query_map([], |row| row.get::<_, String>(0))
        .expect("query pending table names")
        .map(|row| row.expect("read pending table name"))
        .collect()
}

fn concrete_non_row_sync_tables(database_name: &str) -> BTreeSet<&'static str> {
    sync_classification_registry()
        .into_iter()
        .filter(|entry| entry.database == database_name)
        .filter(|entry| entry.primary_key != "(virtual)")
        .filter(|entry| {
            !matches!(
                entry.category,
                SyncCategory::RowSync | SyncCategory::Deprecated
            )
        })
        .map(|entry| entry.table_name)
        .collect()
}

fn assert_non_row_sync_fixture_coverage(
    database_name: &str,
    inserted_tables: BTreeSet<&'static str>,
) {
    let expected = concrete_non_row_sync_tables(database_name);
    assert_eq!(
        inserted_tables, expected,
        "{database_name} non-RowSync fixture must cover every concrete classified table"
    );
}

fn change_log_trigger_count(conn: &Connection, table_name: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'trigger'
           AND tbl_name = ?1
           AND lower(sql) LIKE '%__change_log%'",
        params![table_name],
        |row| row.get(0),
    )
    .unwrap_or_else(|e| panic!("count change-log triggers for {table_name}: {e}"))
}

fn insert_vfs_non_row_sync_rows(conn: &Connection) -> BTreeSet<&'static str> {
    let ms = 1_714_000_000_000i64;
    let ts = "2024-04-24T00:00:00Z";

    conn.execute(
        "INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
         VALUES ('blob_non_row_hash', 'bl/ob/blob_non_row_hash', 4096, 'application/pdf', 1, ?1)",
        params![ms],
    )
    .expect("insert vfs FileSync blob row");
    conn.execute(
        "INSERT INTO path_cache (item_type, item_id, full_path, folder_path, updated_at)
         VALUES ('note', 'note_all', '/All rows folder/All rows note', '/All rows folder', ?1)",
        params![ts],
    )
    .expect("insert vfs path cache row");
    conn.execute(
        "INSERT INTO question_bank_stats (
            exam_id, total_count, new_count, total_attempts, total_correct, correct_rate, updated_at
         ) VALUES ('exam_all', 1, 1, 2, 1, 0.5, ?1)",
        params![ts],
    )
    .expect("insert vfs question bank stats row");
    conn.execute(
        "INSERT INTO review_stats (
            exam_id, total_plans, new_count, due_today, total_reviews, total_correct,
            avg_correct_rate, avg_ease_factor, updated_at
         ) VALUES ('exam_all', 1, 1, 1, 2, 1, 0.5, 2.4, ?1)",
        params![ts],
    )
    .expect("insert vfs review stats row");
    conn.execute(
        "INSERT INTO vfs_index_units (
            id, resource_id, unit_index, image_blob_hash, image_mime_type, text_content,
            text_source, content_hash, text_required, text_state, text_indexed_at,
            text_chunk_count, text_embedding_dim, mm_required, mm_state, created_at, updated_at
         ) VALUES (
            'idx_unit_non_row', 'res_all_file', 0, 'blob_non_row_hash',
            'application/pdf', 'indexed text', 'ocr', 'idx_content_non_row',
            1, 'indexed', ?1, 1, 1536, 0, 'disabled', ?1, ?1
         )",
        params![ms],
    )
    .expect("insert vfs index unit row");
    conn.execute(
        "INSERT INTO vfs_index_segments (
            id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
            content_text, content_hash, start_pos, end_pos, metadata_json, created_at, updated_at
         ) VALUES (
            'idx_seg_non_row', 'idx_unit_non_row', 0, 'text', 1536, 'lance_non_row',
            'indexed text', 'idx_seg_hash_non_row', 0, 12, '{}', ?1, ?1
         )",
        params![ms],
    )
    .expect("insert vfs index segment row");
    conn.execute(
        "INSERT INTO vfs_embedding_dims (
            dimension, modality, lance_table_name, record_count, created_at,
            last_used_at, model_config_id, model_name
         ) VALUES (1536, 'text', 'vfs_text_1536', 1, ?1, ?1, 'emb_cfg', 'text-embedding')",
        params![ms],
    )
    .expect("insert vfs embedding dimension row");
    conn.execute(
        "INSERT INTO question_history (
            id, question_id, field_name, old_value, new_value, operator, reason, created_at
         ) VALUES ('qh_non_row', 'q_all', 'status', 'new', 'review', 'user', 'fixture', ?1)",
        params![ts],
    )
    .expect("insert vfs question history row");
    conn.execute(
        "INSERT INTO question_sync_conflicts (
            id, question_id, exam_id, conflict_type, local_snapshot, remote_snapshot,
            status, created_at
         ) VALUES (
            'qsc_non_row', 'q_all', 'exam_all', 'modify_modify', '{}', '{}',
            'pending', ?1
         )",
        params![ts],
    )
    .expect("insert vfs question sync conflict row");
    conn.execute(
        "INSERT INTO question_sync_logs (
            id, exam_id, direction, sync_type, result, synced_count, conflict_count,
            error_count, details_json, started_at, completed_at
         ) VALUES (
            'qsl_non_row', 'exam_all', 'pull', 'incremental', 'success',
            1, 0, 0, '{}', ?1, ?1
         )",
        params![ts],
    )
    .expect("insert vfs question sync log row");
    conn.execute(
        "INSERT INTO review_history (
            id, plan_id, question_id, quality, passed, ease_factor_before,
            ease_factor_after, interval_before, interval_after, repetitions_before,
            repetitions_after, reviewed_at, user_answer, time_spent_seconds
         ) VALUES (
            'rh_non_row', 'rp_all', 'q_all', 4, 1, 2.5, 2.6, 1, 3, 0, 1,
            ?1, '4', 30
         )",
        params![ts],
    )
    .expect("insert vfs review history row");
    conn.execute(
        "INSERT INTO memory_audit_log (
            source, operation, success, note_id, title, content_preview, folder,
            event, confidence, reason, session_id, duration_ms, extra_json
         ) VALUES (
            'manual', 'write', 1, 'note_all', 'memory title', 'preview',
            '/memory', 'ADD', 0.9, 'fixture', 'sess_all', 12, '{}'
         )",
        [],
    )
    .expect("insert vfs memory audit row");
    conn.execute(
        "INSERT INTO memory_write_idempotency (
            idempotency_key, note_id, event, is_new, confidence, reason,
            resource_id, downgraded, created_at
         ) VALUES (
            'idem_non_row', 'note_all', 'ADD', 1, 0.9, 'fixture',
            'res_all_note', 0, ?1
         )",
        params![ms],
    )
    .expect("insert vfs memory idempotency row");
    conn.execute(
        "INSERT INTO mindmap_versions (
            version_id, mindmap_id, resource_id, title, label, source, created_at
         ) VALUES (
            'mv_non_row', 'mm_all', 'res_all_mindmap', 'All rows mindmap',
            'v1', 'manual', ?1
         )",
        params![ts],
    )
    .expect("insert vfs mindmap version row");
    conn.execute(
        "UPDATE memory_config SET value = 'fld_all', updated_at = ?1
         WHERE key = 'memory_root_folder_id'",
        params![ts],
    )
    .expect("update vfs memory config row");
    conn.execute(
        "UPDATE vfs_indexing_config SET value = 'false', updated_at = ?1
         WHERE key = 'indexing.enabled'",
        params![ms],
    )
    .expect("update vfs indexing config row");

    BTreeSet::from([
        "blobs",
        "path_cache",
        "question_bank_stats",
        "review_stats",
        "vfs_index_units",
        "vfs_index_segments",
        "vfs_embedding_dims",
        "question_history",
        "question_sync_conflicts",
        "question_sync_logs",
        "review_history",
        "memory_audit_log",
        "memory_write_idempotency",
        "mindmap_versions",
        "memory_config",
        "vfs_indexing_config",
    ])
}

fn insert_chat_non_row_sync_rows(conn: &Connection) -> BTreeSet<&'static str> {
    let ms = 1_714_000_000_000i64;
    let ts = "2024-04-24T00:00:00Z";

    conn.execute(
        "INSERT INTO chat_v2_session_state (
            session_id, chat_params_json, features_json, mode_state_json, input_value,
            panel_states_json, updated_at, model_id, temperature, context_limit,
            max_tokens, enable_thinking, disable_tools, attachments_json,
            rag_enabled, rag_library_ids_json, rag_top_k, graph_rag_enabled,
            memory_enabled, web_search_enabled, anki_enabled, anki_template_id,
            anki_options_json, pending_context_refs_json, loaded_skill_ids_json,
            active_skill_id, active_skill_ids_json, skill_state_json
         ) VALUES (
            'sess_all', '{}', '{}', '{}', 'draft', '{}', ?1, 'model-a',
            0.2, 4096, 1024, 1, 0, '[]', 1, '[]', 5, 1, 1, 0, 0,
            NULL, '{}', '[]', '[]', NULL, '[]', '{}'
         )",
        params![ts],
    )
    .expect("insert chat session state row");
    conn.execute(
        "INSERT INTO chat_v2_todo_lists (
            session_id, message_id, variant_id, todo_list_id, title, steps_json,
            is_all_done, created_at, updated_at
         ) VALUES (
            'sess_all', 'msg_all', NULL, 'chat_todo_non_row', 'Agent plan',
            '[{\"title\":\"step\"}]', 0, ?1, ?1
         )",
        params![ms],
    )
    .expect("insert chat todo list row");
    conn.execute(
        "INSERT INTO chat_v2_session_tags (session_id, tag, tag_type, created_at)
         VALUES ('sess_all', 'auto-tag', 'auto', ?1)",
        params![ts],
    )
    .expect("insert chat session tag row");
    conn.execute(
        "INSERT INTO sleep_block (
            id, workspace_id, coordinator_session_id, awaiting_agents, wake_condition,
            status, timeout_at, created_at, awakened_at, awakened_by,
            awaken_message, message_id, block_id
         ) VALUES (
            'sleep_non_row', 'ws_all', 'sess_all', '[]',
            '{\"type\":\"result_message\"}', 'sleeping', NULL, ?1, NULL,
            NULL, NULL, 'msg_all', 'blk_all'
         )",
        params![ts],
    )
    .expect("insert chat sleep block row");
    conn.execute(
        "INSERT INTO subagent_task (
            id, workspace_id, agent_session_id, skill_id, status, task_content,
            last_active_at, needs_recovery, created_at, initial_task, started_at,
            completed_at, result_summary
         ) VALUES (
            'subtask_non_row', 'ws_all', 'agent_sess_non_row', 'skill_non_row',
            'running', 'task', ?1, 1, ?1, 'task', ?1, NULL, NULL
         )",
        params![ts],
    )
    .expect("insert chat subagent task row");
    conn.execute(
        "INSERT INTO chat_v2_compactions (
            id, session_id, summary_message_id, tail_start_message_id,
            tail_start_time_created, reason, is_auto, is_overflow,
            tokens_before, tokens_after, model_id, created_at
         ) VALUES (
            'compact_non_row', 'sess_all', 'msg_all', 'msg_all', ?1,
            'manual', 0, 0, 8000, 1200, 'model-a', ?1
         )",
        params![ms],
    )
    .expect("insert chat compaction row");

    BTreeSet::from([
        "chat_v2_session_state",
        "chat_v2_todo_lists",
        "chat_v2_session_tags",
        "sleep_block",
        "subagent_task",
        "chat_v2_compactions",
    ])
}

fn insert_mistakes_non_row_sync_rows(conn: &Connection) -> BTreeSet<&'static str> {
    let ts = "2024-04-24T00:00:00Z";

    conn.execute(
        "INSERT INTO temp_sessions (
            temp_id, session_data, stream_state, created_at, updated_at, last_error
         ) VALUES ('temp_non_row', '{}', 'in_progress', ?1, ?1, NULL)",
        params![ts],
    )
    .expect("insert mistakes temp session row");
    conn.execute(
        "INSERT INTO document_control_states (
            document_id, state, pending_tasks_json, running_tasks_json,
            completed_tasks_json, failed_tasks_json, created_at, updated_at
         ) VALUES ('doc_non_row', 'running', '[]', '{}', '[]', '{}', ?1, ?1)",
        params![ts],
    )
    .expect("insert mistakes document control state row");
    conn.execute(
        "INSERT INTO search_logs (
            id, search_type, query, result_count, execution_time_ms,
            mistake_ids_json, error_message, user_feedback, created_at
         ) VALUES (
            'search_non_row', 'semantic', 'algebra', 1, 25,
            '[\"mistake_all\"]', NULL, 'useful', ?1
         )",
        params![ts],
    )
    .expect("insert mistakes search log row");
    conn.execute(
        "INSERT INTO exam_sheet_sessions (
            id, exam_name, created_at, updated_at, temp_id, status,
            metadata_json, preview_json, linked_mistake_ids
         ) VALUES (
            'exam_sess_non_row', 'Runtime exam', ?1, ?1, 'tmp_exam_non_row',
            'processing', '{}', '{}', '[\"mistake_all\"]'
         )",
        params![ts],
    )
    .expect("insert mistakes exam sheet session row");
    conn.execute(
        "INSERT INTO migration_progress (
            category, status, last_cursor, total_processed, last_error, created_at, updated_at
         ) VALUES ('legacy_import', 'running', 'cursor-1', 3, NULL, ?1, ?1)",
        params![ts],
    )
    .expect("insert mistakes migration progress row");
    conn.execute(
        "INSERT INTO vectorized_data (
            id, mistake_id, text_content, embedding_json, created_at
         ) VALUES ('vec_non_row', 'mistake_all', 'vector text', '[0.1,0.2]', ?1)",
        params![ts],
    )
    .expect("insert mistakes vectorized data row");
    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES ('sync.fixture.setting', 'enabled', ?1)",
        params![ts],
    )
    .expect("insert mistakes setting row");
    conn.execute(
        "INSERT INTO rag_configurations (
            id, chunk_size, chunk_overlap, chunking_strategy, min_chunk_size,
            default_top_k, default_rerank_enabled, created_at, updated_at
         ) VALUES ('rag_non_row', 512, 64, 'fixed_size', 20, 8, 1, ?1, ?1)",
        params![ts],
    )
    .expect("insert mistakes rag configuration row");
    conn.execute(
        "INSERT INTO custom_anki_templates (
            id, name, description, author, version, preview_front, preview_back,
            note_type, fields_json, generation_prompt, front_template,
            back_template, css_style, field_extraction_rules_json,
            created_at, updated_at, is_active, is_built_in, preview_data_json
         ) VALUES (
            'tmpl_non_row', 'Template non row', 'desc', 'tester', '1.0.0',
            'front', 'back', 'Basic', '[\"Front\",\"Back\"]', 'prompt',
            '{{Front}}', '{{Back}}', '.card{}', '{}', ?1, ?1, 1, 0, '{}'
         )",
        params![ts],
    )
    .expect("insert mistakes custom anki template row");
    conn.execute(
        "INSERT INTO rag_sub_libraries (id, name, description, created_at, updated_at)
         VALUES ('rag_sub_non_row', 'RAG sub non row', 'desc', ?1, ?1)",
        params![ts],
    )
    .expect("insert mistakes rag sub library row");

    BTreeSet::from([
        "temp_sessions",
        "document_control_states",
        "search_logs",
        "exam_sheet_sessions",
        "migration_progress",
        "vectorized_data",
        "settings",
        "rag_configurations",
        "custom_anki_templates",
        "rag_sub_libraries",
    ])
}

fn local_manifest(
    manager: &SyncManager,
    conn: &Connection,
    database_name: &str,
) -> deep_student_lib::data_governance::sync::SyncManifest {
    let mut states = HashMap::new();
    states.insert(
        database_name.to_string(),
        SyncManager::get_database_sync_state(conn, database_name)
            .expect("read database sync state"),
    );
    manager.create_manifest(states)
}

fn workspace_manifest(
    manager: &SyncManager,
    workspace: &MigratedWorkspace,
    database_names: &[&str],
) -> deep_student_lib::data_governance::sync::SyncManifest {
    let mut states = HashMap::new();
    for database_name in database_names {
        let conn = workspace.open(database_name);
        states.insert(
            (*database_name).to_string(),
            SyncManager::get_database_sync_state(&conn, database_name)
                .unwrap_or_else(|e| panic!("read {database_name} sync state: {e}")),
        );
    }
    manager.create_manifest(states)
}

fn append_enriched_changes(
    all_changes: &mut Vec<SyncChangeWithData>,
    conn: &Connection,
    database_name: &str,
) {
    let pending = SyncManager::get_pending_changes(conn, None, None)
        .unwrap_or_else(|e| panic!("read pending changes for {database_name}: {e}"));
    assert!(
        pending.has_changes(),
        "{database_name} should produce pending changes"
    );
    let filtered = SyncManager::filter_pending_changes_for_database(pending, database_name);
    assert!(
        filtered.has_changes(),
        "{database_name} should retain RowSync changes after filtering"
    );
    let mut changes = SyncManager::enrich_changes_with_data(conn, &filtered.entries, None)
        .unwrap_or_else(|e| panic!("enrich {database_name} pending changes: {e}"));
    for change in &mut changes {
        change.database_name = Some(database_name.to_string());
        change.suppress_change_log = Some(true);
    }
    all_changes.extend(changes);
}

#[test]
fn real_vfs_note_roundtrips_without_pending_echo() {
    let source = migrate_workspace();
    let target = migrate_workspace();
    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);

    insert_vfs_note_bundle(
        &source_vfs,
        "res_real_flow_1",
        "note_real_flow_1",
        "hash_real_flow_1",
        "Real migrated note",
    );

    let pending = SyncManager::get_pending_changes(&source_vfs, None, None).unwrap();
    assert!(pending.total_count >= 2);
    assert_eq!(pending.changes_by_table.get("resources").copied(), Some(1));
    assert_eq!(pending.changes_by_table.get("notes").copied(), Some(1));

    let changes = reverse_for_fk_stress(cloud_changes(&source_vfs, "vfs"));
    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &changes, None)
        .expect("apply vfs changes to target");
    assert!(applied.success_count >= 2);
    assert!(applied.failure_count == 0);

    let title: String = target_vfs
        .query_row(
            "SELECT title FROM notes WHERE id = 'note_real_flow_1'",
            [],
            |row| row.get(0),
        )
        .expect("target note should exist");
    let hash: String = target_vfs
        .query_row(
            "SELECT hash FROM resources WHERE id = 'res_real_flow_1'",
            [],
            |row| row.get(0),
        )
        .expect("target resource should exist");
    assert_eq!(title, "Real migrated note");
    assert_eq!(hash, "hash_real_flow_1");
    assert_eq!(pending_count(&target_vfs), 0, "replay must not create echo");

    let change_ids: Vec<i64> = pending.entries.iter().map(|entry| entry.id).collect();
    let marked = SyncManager::mark_synced_with_timestamp(&source_vfs, &change_ids).unwrap();
    assert_eq!(marked, change_ids.len());
    assert_eq!(pending_count(&source_vfs), 0);
}

#[test]
fn real_chat_fk_chain_roundtrips_without_pending_echo() {
    let source = migrate_workspace();
    let target = migrate_workspace();
    let source_chat = source.open("chat_v2");
    let target_chat = target.open("chat_v2");
    clear_change_log(&source_chat);
    clear_change_log(&target_chat);

    insert_chat_bundle(&source_chat);

    let pending = SyncManager::get_pending_changes(&source_chat, None, None).unwrap();
    assert!(pending.total_count >= 4);
    for table in [
        "chat_v2_sessions",
        "chat_v2_messages",
        "chat_v2_blocks",
        "chat_v2_attachments",
    ] {
        assert_eq!(
            pending.changes_by_table.get(table).copied(),
            Some(1),
            "{table} should have exactly one pending insert"
        );
    }

    let changes = reverse_for_fk_stress(cloud_changes(&source_chat, "chat_v2"));
    let applied = SyncManager::apply_downloaded_changes(&target_chat, &changes, None)
        .expect("apply chat changes to target");
    assert!(applied.success_count >= 4);
    assert!(applied.failure_count == 0);

    let content: String = target_chat
        .query_row(
            "SELECT content FROM chat_v2_blocks WHERE id = 'blk_real_1'",
            [],
            |row| row.get(0),
        )
        .expect("target block should exist");
    let attachment_path: String = target_chat
        .query_row(
            "SELECT storage_path FROM chat_v2_attachments WHERE id = 'att_real_1'",
            [],
            |row| row.get(0),
        )
        .expect("target attachment should exist");
    assert_eq!(content, "streamed content");
    assert_eq!(attachment_path, "active/documents/scan.pdf");
    assert_eq!(
        pending_count(&target_chat),
        0,
        "replay must not create echo"
    );
}

#[test]
fn real_restore_baseline_clears_old_changes_and_allows_new_delta() {
    let workspace = migrate_workspace();
    let vfs = workspace.open("vfs");
    clear_change_log(&vfs);

    insert_vfs_note_bundle(
        &vfs,
        "res_restore_flow_1",
        "note_restore_flow_1",
        "hash_restore_flow_1",
        "Before restore",
    );
    let pending_before = pending_count(&vfs);
    assert!(pending_before >= 2);

    let (truncated, reset_records) = SyncManager::reset_sync_baseline_after_restore(&vfs).unwrap();
    assert!(truncated >= pending_before);
    // Real migrated VFS schemas currently clear restore drift by truncating pending
    // change logs. They do not expose per-row sync_version columns, so the business
    // row touch count is an implementation detail and may legitimately remain zero.
    assert!(reset_records <= truncated as usize);
    assert_eq!(
        pending_count(&vfs),
        0,
        "restore baseline should clear old log"
    );

    vfs.execute(
        "UPDATE notes SET title = 'After restore', updated_at = ?1
         WHERE id = 'note_restore_flow_1'",
        params!["2024-04-25T00:00:00Z"],
    )
    .expect("edit note after restore baseline");

    let pending_after = SyncManager::get_pending_changes(&vfs, None, None).unwrap();
    assert_eq!(pending_after.total_count, 1);
    let entry = pending_after.entries.first().expect("one new note delta");
    assert_eq!(entry.table_name, "notes");
    assert_eq!(entry.record_id, "note_restore_flow_1");
}

#[test]
fn real_migrated_all_row_sync_tables_roundtrip_with_reordered_changes() {
    let source = migrate_workspace();
    let target = migrate_workspace();

    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);
    insert_vfs_all_row_sync_bundle(&source_vfs);
    apply_all_pending_and_assert(
        &source_vfs,
        &target_vfs,
        "vfs",
        &[
            "resources",
            "notes",
            "files",
            "exam_sheets",
            "questions",
            "review_plans",
            "answer_submissions",
            "translations",
            "essay_sessions",
            "essays",
            "mindmaps",
            "folders",
            "folder_items",
            "todo_lists",
            "todo_items",
            "pomodoro_records",
        ],
    );

    let source_chat = source.open("chat_v2");
    let target_chat = target.open("chat_v2");
    clear_change_log(&source_chat);
    clear_change_log(&target_chat);
    insert_chat_all_row_sync_bundle(&source_chat);
    apply_all_pending_and_assert(
        &source_chat,
        &target_chat,
        "chat_v2",
        &[
            "chat_v2_session_groups",
            "chat_v2_sessions",
            "chat_v2_messages",
            "chat_v2_blocks",
            "chat_v2_attachments",
            "resources",
            "chat_v2_session_mistakes",
            "workspace_index",
        ],
    );

    let source_mistakes = source.open("mistakes");
    let target_mistakes = target.open("mistakes");
    clear_change_log(&source_mistakes);
    clear_change_log(&target_mistakes);
    insert_mistakes_all_row_sync_bundle(&source_mistakes);
    apply_all_pending_and_assert(
        &source_mistakes,
        &target_mistakes,
        "mistakes",
        &[
            "mistakes",
            "chat_messages",
            "review_analyses",
            "review_chat_messages",
            "review_sessions",
            "review_session_mistakes",
            "document_tasks",
            "anki_cards",
        ],
    );

    let source_usage = source.open("llm_usage");
    let target_usage = target.open("llm_usage");
    clear_change_log(&source_usage);
    clear_change_log(&target_usage);
    insert_llm_usage_all_row_sync_bundle(&source_usage);
    apply_all_pending_and_assert(
        &source_usage,
        &target_usage,
        "llm_usage",
        &["llm_usage_logs"],
    );
}

#[test]
fn real_migrated_all_row_sync_tables_update_roundtrip_with_reordered_changes() {
    let source = migrate_workspace();
    let target = migrate_workspace();

    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);
    insert_vfs_all_row_sync_bundle(&source_vfs);
    let vfs_tables = [
        "resources",
        "notes",
        "files",
        "exam_sheets",
        "questions",
        "review_plans",
        "answer_submissions",
        "translations",
        "essay_sessions",
        "essays",
        "mindmaps",
        "folders",
        "folder_items",
        "todo_lists",
        "todo_items",
        "pomodoro_records",
    ];
    apply_all_pending_and_assert(&source_vfs, &target_vfs, "vfs", &vfs_tables);
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);
    update_vfs_all_row_sync_bundle(&source_vfs);
    apply_all_pending_and_assert(&source_vfs, &target_vfs, "vfs", &vfs_tables);

    let source_chat = source.open("chat_v2");
    let target_chat = target.open("chat_v2");
    clear_change_log(&source_chat);
    clear_change_log(&target_chat);
    insert_chat_all_row_sync_bundle(&source_chat);
    let chat_tables = [
        "chat_v2_session_groups",
        "chat_v2_sessions",
        "chat_v2_messages",
        "chat_v2_blocks",
        "chat_v2_attachments",
        "resources",
        "chat_v2_session_mistakes",
        "workspace_index",
    ];
    apply_all_pending_and_assert(&source_chat, &target_chat, "chat_v2", &chat_tables);
    clear_change_log(&source_chat);
    clear_change_log(&target_chat);
    update_chat_all_row_sync_bundle(&source_chat);
    apply_all_pending_and_assert(&source_chat, &target_chat, "chat_v2", &chat_tables);

    let source_mistakes = source.open("mistakes");
    let target_mistakes = target.open("mistakes");
    clear_change_log(&source_mistakes);
    clear_change_log(&target_mistakes);
    insert_mistakes_all_row_sync_bundle(&source_mistakes);
    let mistakes_tables = [
        "mistakes",
        "chat_messages",
        "review_analyses",
        "review_chat_messages",
        "review_sessions",
        "review_session_mistakes",
        "document_tasks",
        "anki_cards",
    ];
    apply_all_pending_and_assert(
        &source_mistakes,
        &target_mistakes,
        "mistakes",
        &mistakes_tables,
    );
    clear_change_log(&source_mistakes);
    clear_change_log(&target_mistakes);
    update_mistakes_all_row_sync_bundle(&source_mistakes);
    apply_all_pending_and_assert(
        &source_mistakes,
        &target_mistakes,
        "mistakes",
        &mistakes_tables,
    );

    let source_usage = source.open("llm_usage");
    let target_usage = target.open("llm_usage");
    clear_change_log(&source_usage);
    clear_change_log(&target_usage);
    insert_llm_usage_all_row_sync_bundle(&source_usage);
    let usage_tables = ["llm_usage_logs"];
    apply_all_pending_and_assert(&source_usage, &target_usage, "llm_usage", &usage_tables);
    clear_change_log(&source_usage);
    clear_change_log(&target_usage);
    update_llm_usage_all_row_sync_bundle(&source_usage);
    apply_all_pending_and_assert(&source_usage, &target_usage, "llm_usage", &usage_tables);
}

#[test]
fn real_delete_tombstones_vfs_and_chat_fk_chains_without_pending_echo() {
    let source = migrate_workspace();
    let target = migrate_workspace();

    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);
    insert_vfs_note_bundle(
        &source_vfs,
        "res_delete_flow_1",
        "note_delete_flow_1",
        "hash_delete_flow_1",
        "Delete flow note",
    );
    apply_all_pending_and_assert(&source_vfs, &target_vfs, "vfs", &["resources", "notes"]);
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);

    source_vfs
        .execute("DELETE FROM notes WHERE id = 'note_delete_flow_1'", [])
        .expect("delete vfs note");
    source_vfs
        .execute("DELETE FROM resources WHERE id = 'res_delete_flow_1'", [])
        .expect("delete vfs resource");

    let changes = reverse_for_fk_stress(cloud_changes(&source_vfs, "vfs"));
    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &changes, None)
        .expect("apply vfs deletes");
    assert_eq!(applied.failure_count, 0, "vfs delete failures: {applied:?}");
    assert_deleted_at_is_set(&target_vfs, "notes", "note_delete_flow_1");
    assert_deleted_at_is_set(&target_vfs, "resources", "res_delete_flow_1");
    assert_eq!(pending_count(&target_vfs), 0);

    let source_chat = source.open("chat_v2");
    let target_chat = target.open("chat_v2");
    clear_change_log(&source_chat);
    clear_change_log(&target_chat);
    insert_chat_bundle(&source_chat);
    apply_all_pending_and_assert(
        &source_chat,
        &target_chat,
        "chat_v2",
        &[
            "chat_v2_sessions",
            "chat_v2_messages",
            "chat_v2_blocks",
            "chat_v2_attachments",
        ],
    );
    clear_change_log(&source_chat);
    clear_change_log(&target_chat);

    source_chat
        .execute("DELETE FROM chat_v2_sessions WHERE id = 'sess_real_1'", [])
        .expect("delete chat session");
    let pending = SyncManager::get_pending_changes(&source_chat, None, None)
        .expect("read chat delete pending");
    for table in [
        "chat_v2_sessions",
        "chat_v2_messages",
        "chat_v2_blocks",
        "chat_v2_attachments",
    ] {
        assert!(
            pending.changes_by_table.contains_key(table),
            "cascade delete should emit change-log entry for {table}"
        );
    }

    let changes = reverse_for_fk_stress(cloud_changes(&source_chat, "chat_v2"));
    let applied = SyncManager::apply_downloaded_changes(&target_chat, &changes, None)
        .expect("apply chat cascade deletes");
    assert_eq!(
        applied.failure_count, 0,
        "chat delete failures: {applied:?}"
    );
    assert_deleted_at_is_set(&target_chat, "chat_v2_sessions", "sess_real_1");
    assert_deleted_at_is_set(&target_chat, "chat_v2_messages", "msg_real_1");
    assert_deleted_at_is_set(&target_chat, "chat_v2_blocks", "blk_real_1");
    assert_deleted_at_is_set(&target_chat, "chat_v2_attachments", "att_real_1");
    assert_eq!(pending_count(&target_chat), 0);
}

#[test]
fn real_business_unique_key_conflicts_alias_ids_and_remap_dependents() {
    let source = migrate_workspace();
    let target = migrate_workspace();
    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);

    insert_vfs_note_bundle(
        &source_vfs,
        "res_unique_remote",
        "note_unique_remote",
        "hash_unique_shared",
        "Remote unique note",
    );
    insert_vfs_note_bundle(
        &target_vfs,
        "res_unique_local",
        "note_unique_local",
        "hash_unique_shared",
        "Local unique note",
    );
    clear_change_log(&target_vfs);

    let changes = reverse_for_fk_stress(cloud_changes(&source_vfs, "vfs"));
    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &changes, None)
        .expect("apply resource business-key conflict");
    assert_eq!(
        applied.failure_count, 0,
        "resource unique conflict failures: {applied:?}"
    );
    let resource_count: i64 = target_vfs
        .query_row(
            "SELECT COUNT(*) FROM resources WHERE hash = 'hash_unique_shared'",
            [],
            |row| row.get(0),
        )
        .expect("count canonical resource");
    assert_eq!(resource_count, 1);
    let note_resource_id: String = target_vfs
        .query_row(
            "SELECT resource_id FROM notes WHERE id = 'note_unique_remote'",
            [],
            |row| row.get(0),
        )
        .expect("read remapped note resource id");
    assert_eq!(note_resource_id, "res_unique_local");
    assert_eq!(pending_count(&target_vfs), 0);

    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);
    source_vfs
        .execute(
            "INSERT INTO files (
                id, resource_id, sha256, file_name, size, tags_json, bookmarks_json, status,
                created_at, updated_at, type, name, content_hash, mime_type, preview_json
             ) VALUES (
                'file_unique_remote', 'res_unique_remote', 'sha_unique_shared',
                'remote.pdf', 256, '[]', '[]', 'active',
                '2024-04-24T00:00:00Z', '2024-04-24T00:00:00Z',
                'document', 'remote.pdf', 'content_unique_shared', 'application/pdf', '{}'
             )",
            [],
        )
        .expect("insert remote unique file");
    target_vfs
        .execute(
            "INSERT INTO files (
                id, resource_id, sha256, file_name, size, tags_json, bookmarks_json, status,
                created_at, updated_at, type, name, content_hash, mime_type, preview_json
             ) VALUES (
                'file_unique_local', 'res_unique_local', 'sha_unique_shared',
                'local.pdf', 128, '[]', '[]', 'active',
                '2024-04-24T00:00:00Z', '2024-04-24T00:00:00Z',
                'document', 'local.pdf', 'content_unique_local', 'application/pdf', '{}'
             )",
            [],
        )
        .expect("insert local unique file");
    clear_change_log(&target_vfs);

    let changes = cloud_changes(&source_vfs, "vfs");
    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &changes, None)
        .expect("apply file business-key conflict");
    assert_eq!(
        applied.failure_count, 0,
        "file unique conflict failures: {applied:?}"
    );
    let file_count: i64 = target_vfs
        .query_row(
            "SELECT COUNT(*) FROM files WHERE sha256 = 'sha_unique_shared'",
            [],
            |row| row.get(0),
        )
        .expect("count canonical file");
    assert_eq!(file_count, 1);

    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);
    source_vfs
        .execute(
            "INSERT INTO folders (
                id, parent_id, title, icon, color, sort_order, created_at, updated_at
             ) VALUES ('folder_unique_remote', NULL, 'Remote folder', 'folder', '#111111', 0, ?1, ?1)",
            params![1_714_000_000_000i64],
        )
        .expect("insert remote folder");
    source_vfs
        .execute(
            "INSERT INTO folder_items (
                id, folder_id, item_type, item_id, sort_order, created_at, updated_at
             ) VALUES ('fi_unique_remote', 'folder_unique_remote', 'note', 'note_unique_remote', 4, ?1, ?1)",
            params![1_714_000_000_000i64],
        )
        .expect("insert remote folder item");
    target_vfs
        .execute(
            "INSERT INTO folders (
                id, parent_id, title, icon, color, sort_order, created_at, updated_at
             ) VALUES ('folder_unique_remote', NULL, 'Remote folder', 'folder', '#111111', 0, ?1, ?1)",
            params![1_714_000_000_000i64],
        )
        .expect("insert target folder");
    target_vfs
        .execute(
            "INSERT INTO folder_items (
                id, folder_id, item_type, item_id, sort_order, created_at, updated_at
             ) VALUES ('fi_unique_local', 'folder_unique_remote', 'note', 'note_unique_remote', 1, ?1, ?1)",
            params![1_714_000_000_000i64],
        )
        .expect("insert local folder item");
    clear_change_log(&target_vfs);

    let changes = cloud_changes(&source_vfs, "vfs");
    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &changes, None)
        .expect("apply folder item business-key conflict");
    assert_eq!(
        applied.failure_count, 0,
        "folder item unique conflict failures: {applied:?}"
    );
    let folder_item_count: i64 = target_vfs
        .query_row(
            "SELECT COUNT(*) FROM folder_items
             WHERE folder_id = 'folder_unique_remote'
               AND item_type = 'note'
               AND item_id = 'note_unique_remote'
               AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .expect("count canonical folder item");
    assert_eq!(folder_item_count, 1);

    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);
    for conn in [&source_vfs, &target_vfs] {
        conn.execute(
            "INSERT INTO resources (
                id, hash, type, storage_mode, data, metadata_json, ref_count, created_at, updated_at
             ) VALUES (
                'res_answer_unique_parent', 'hash_answer_unique_parent', 'exam',
                'inline', 'answer parent', '{}', 1, ?1, ?1
             )",
            params![1_714_000_000_000i64],
        )
        .expect("insert answer unique parent resource");
        conn.execute(
            "INSERT INTO exam_sheets (
                id, resource_id, exam_name, status, temp_id, metadata_json, preview_json,
                created_at, updated_at
             ) VALUES (
                'exam_answer_unique_parent', 'res_answer_unique_parent', 'Answer unique exam',
                'completed', 'tmp_answer_unique_parent', '{}', '{}', ?1, ?1
             )",
            params!["2024-04-24T00:00:00Z"],
        )
        .expect("insert answer unique parent exam");
        conn.execute(
            "INSERT INTO questions (
                id, exam_id, content, options_json, answer, explanation, question_type,
                tags, status, created_at, updated_at
             ) VALUES (
                'q_answer_unique_parent', 'exam_answer_unique_parent', 'Unique answer?',
                '[]', 'A', 'explanation', 'short_answer', '[]', 'new', ?1, ?1
             )",
            params!["2024-04-24T00:00:00Z"],
        )
        .expect("insert answer unique parent question");
    }
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);
    source_vfs
        .execute(
            "INSERT INTO answer_submissions (
                id, question_id, user_answer, is_correct, grading_method, submitted_at,
                client_request_id, updated_at
             ) VALUES (
                'as_unique_remote', 'q_answer_unique_parent', 'A', 1, 'manual',
                ?1, 'answer_req_unique_shared', ?1
             )",
            params!["2024-04-24T00:00:00Z"],
        )
        .expect("insert remote answer submission with idempotency key");
    target_vfs
        .execute(
            "INSERT INTO answer_submissions (
                id, question_id, user_answer, is_correct, grading_method, submitted_at,
                client_request_id, updated_at
             ) VALUES (
                'as_unique_local', 'q_answer_unique_parent', 'A', 1, 'manual',
                ?1, 'answer_req_unique_shared', ?1
             )",
            params!["2024-04-24T00:00:00Z"],
        )
        .expect("insert local answer submission with same idempotency key");
    clear_change_log(&target_vfs);

    let changes = cloud_changes(&source_vfs, "vfs");
    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &changes, None)
        .expect("apply answer submission business-key conflict");
    assert_eq!(
        applied.failure_count, 0,
        "answer submission unique conflict failures: {applied:?}"
    );
    let answer_submission_count: i64 = target_vfs
        .query_row(
            "SELECT COUNT(*) FROM answer_submissions
             WHERE question_id = 'q_answer_unique_parent'
               AND client_request_id = 'answer_req_unique_shared'
               AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .expect("count canonical answer submission");
    assert_eq!(answer_submission_count, 1);
    assert_eq!(pending_count(&target_vfs), 0);

    let source_chat = source.open("chat_v2");
    let target_chat = target.open("chat_v2");
    clear_change_log(&source_chat);
    clear_change_log(&target_chat);
    source_chat
        .execute(
            "INSERT INTO resources (
                id, hash, type, source_id, data, metadata_json, ref_count, created_at, updated_at
             ) VALUES ('chat_res_unique_remote', 'chat_hash_unique_shared', 'note',
                'note_unique_remote', 'remote', '{}', 1, ?1, ?2)",
            params![1_714_000_000_000i64, "2024-04-24T00:00:00Z"],
        )
        .expect("insert remote chat resource");
    target_chat
        .execute(
            "INSERT INTO resources (
                id, hash, type, source_id, data, metadata_json, ref_count, created_at, updated_at
             ) VALUES ('chat_res_unique_local', 'chat_hash_unique_shared', 'note',
                'note_unique_local', 'local', '{}', 1, ?1, ?2)",
            params![1_714_000_000_000i64, "2024-04-24T00:00:00Z"],
        )
        .expect("insert local chat resource");
    clear_change_log(&target_chat);

    let changes = cloud_changes(&source_chat, "chat_v2");
    let applied = SyncManager::apply_downloaded_changes(&target_chat, &changes, None)
        .expect("apply chat resource business-key conflict");
    assert_eq!(
        applied.failure_count, 0,
        "chat resource unique conflict failures: {applied:?}"
    );
    let chat_resource_count: i64 = target_chat
        .query_row(
            "SELECT COUNT(*) FROM resources WHERE hash = 'chat_hash_unique_shared'",
            [],
            |row| row.get(0),
        )
        .expect("count canonical chat resource");
    assert_eq!(chat_resource_count, 1);
    assert_eq!(pending_count(&target_chat), 0);
}

#[test]
fn real_llm_usage_daily_is_derived_and_legacy_pending_entries_are_filtered() {
    let workspace = migrate_workspace();
    let conn = workspace.open("llm_usage");
    clear_change_log(&conn);

    conn.execute(
        "INSERT INTO llm_usage_daily (
            date, caller_type, model, provider, request_count, total_tokens
         ) VALUES ('2024-04-24', 'chat_v2', 'gpt-4o-mini', 'openai', 1, 150)",
        [],
    )
    .expect("insert derived daily usage row");

    assert_eq!(
        pending_count(&conn),
        0,
        "llm_usage_daily is DerivedRebuild and must not create pending change-log rows"
    );

    conn.execute(
        "INSERT INTO __change_log (table_name, record_id, operation)
         VALUES ('llm_usage_daily', '{\"date\":\"2024-04-24\",\"caller_type\":\"chat_v2\",\"model\":\"gpt-4o-mini\",\"provider\":\"openai\"}', 'UPDATE')",
        [],
    )
    .expect("insert legacy derived pending entry");
    insert_llm_usage_all_row_sync_bundle(&conn);

    let raw_pending = SyncManager::get_pending_changes(&conn, None, None).expect("read pending");
    assert!(
        raw_pending.changes_by_table.contains_key("llm_usage_daily"),
        "fixture must include a legacy derived pending entry"
    );
    assert!(
        raw_pending.changes_by_table.contains_key("llm_usage_logs"),
        "fixture must include a real RowSync usage log"
    );

    let filtered = SyncManager::filter_pending_changes_for_database(raw_pending, "llm_usage");
    assert_eq!(filtered.total_count, 1);
    assert!(
        filtered.changes_by_table.contains_key("llm_usage_logs"),
        "RowSync log entry must remain uploadable"
    );
    assert!(
        !filtered.changes_by_table.contains_key("llm_usage_daily"),
        "DerivedRebuild daily entry must be removed before enrichment/upload"
    );

    let enriched = SyncManager::enrich_changes_with_data(&conn, &filtered.entries, None)
        .expect("enrich filtered pending changes");
    assert_eq!(enriched.len(), 1);
    assert_eq!(enriched[0].table_name, "llm_usage_logs");
}

#[test]
fn real_legacy_non_row_sync_pending_entries_are_filtered_for_all_databases() {
    let workspace = migrate_workspace();

    let vfs = workspace.open("vfs");
    clear_change_log(&vfs);
    insert_vfs_all_row_sync_bundle(&vfs);
    assert_only_row_sync_pending_after_filter(&vfs, "vfs");

    let chat = workspace.open("chat_v2");
    clear_change_log(&chat);
    insert_chat_all_row_sync_bundle(&chat);
    assert_only_row_sync_pending_after_filter(&chat, "chat_v2");

    let mistakes = workspace.open("mistakes");
    clear_change_log(&mistakes);
    insert_mistakes_all_row_sync_bundle(&mistakes);
    assert_only_row_sync_pending_after_filter(&mistakes, "mistakes");

    let usage = workspace.open("llm_usage");
    clear_change_log(&usage);
    insert_llm_usage_all_row_sync_bundle(&usage);
    assert_only_row_sync_pending_after_filter(&usage, "llm_usage");
}

#[test]
fn real_non_row_sync_tables_with_real_rows_never_enter_incremental_upload() {
    let workspace = migrate_workspace();

    let vfs = workspace.open("vfs");
    clear_change_log(&vfs);
    insert_vfs_all_row_sync_bundle(&vfs);
    clear_change_log(&vfs);
    let inserted_vfs_tables = insert_vfs_non_row_sync_rows(&vfs);
    assert_non_row_sync_fixture_coverage("vfs", inserted_vfs_tables);
    assert_eq!(
        pending_table_names(&vfs),
        BTreeSet::new(),
        "vfs non-RowSync writes must not enter __change_log"
    );

    let chat = workspace.open("chat_v2");
    clear_change_log(&chat);
    insert_chat_all_row_sync_bundle(&chat);
    clear_change_log(&chat);
    let inserted_chat_tables = insert_chat_non_row_sync_rows(&chat);
    assert_non_row_sync_fixture_coverage("chat_v2", inserted_chat_tables);
    assert_eq!(
        pending_table_names(&chat),
        BTreeSet::new(),
        "chat_v2 non-RowSync writes must not enter __change_log"
    );

    let mistakes = workspace.open("mistakes");
    clear_change_log(&mistakes);
    insert_mistakes_all_row_sync_bundle(&mistakes);
    clear_change_log(&mistakes);
    let inserted_mistakes_tables = insert_mistakes_non_row_sync_rows(&mistakes);
    assert_non_row_sync_fixture_coverage("mistakes", inserted_mistakes_tables);
    assert_eq!(
        pending_table_names(&mistakes),
        BTreeSet::new(),
        "mistakes non-RowSync writes must not enter __change_log"
    );

    let usage = workspace.open("llm_usage");
    clear_change_log(&usage);
    insert_llm_usage_daily_non_row(&usage);
    assert_non_row_sync_fixture_coverage("llm_usage", BTreeSet::from(["llm_usage_daily"]));
    assert_eq!(
        pending_table_names(&usage),
        BTreeSet::new(),
        "llm_usage non-RowSync writes must not enter __change_log"
    );
}

fn insert_llm_usage_daily_non_row(conn: &Connection) {
    conn.execute(
        "INSERT INTO llm_usage_daily (
            date, caller_type, model, provider, request_count, success_count,
            error_count, total_prompt_tokens, total_completion_tokens, total_tokens,
            total_reasoning_tokens, total_cached_tokens, total_cost_estimate,
            avg_duration_ms, total_duration_ms, created_at, updated_at
         ) VALUES (
            '2024-04-24', 'chat_v2', 'gpt-4o-mini', 'openai', 2, 2,
            0, 100, 50, 150, 10, 5, 0.0123, 600.0, 1200,
            '2024-04-24T00:00:00Z', '2024-04-24T00:00:00Z'
         )",
        [],
    )
    .expect("insert llm_usage daily aggregate row");
}

#[test]
fn cross_version_llm_usage_daily_legacy_change_log_is_pruned_after_upgrade() {
    let conn = Connection::open_in_memory().expect("open legacy llm_usage database");
    conn.execute_batch(include_str!("../migrations/llm_usage/V20260130__init.sql"))
        .expect("apply llm_usage init migration");
    conn.execute_batch(include_str!(
        "../migrations/llm_usage/V20260131__add_change_log.sql"
    ))
    .expect("apply llm_usage legacy change-log migration");
    conn.execute_batch(include_str!(
        "../migrations/llm_usage/V20260201__add_sync_fields.sql"
    ))
    .expect("apply llm_usage sync fields migration");
    conn.execute_batch(include_str!(
        "../migrations/llm_usage/V20260202__fix_change_log_record_id.sql"
    ))
    .expect("apply llm_usage composite key repair migration");
    conn.execute_batch(include_str!(
        "../migrations/llm_usage/V20260524__add_change_log_field_deltas.sql"
    ))
    .expect("apply llm_usage field delta migration");

    assert!(
        change_log_trigger_count(&conn, "llm_usage_daily") > 0,
        "legacy database should still have daily aggregate change-log triggers"
    );
    conn.execute(
        "INSERT INTO llm_usage_daily (
            date, caller_type, model, provider, request_count, total_tokens
         ) VALUES ('2024-05-01', 'chat_v2', 'gpt-4o-mini', 'openai', 2, 300)",
        [],
    )
    .expect("insert legacy daily aggregate row");
    assert!(
        pending_rows_for_table(&conn, "llm_usage_daily") > 0,
        "legacy trigger should create a derived-table pending entry before upgrade"
    );

    conn.execute_batch(include_str!(
        "../migrations/llm_usage/V20260525__drop_daily_change_log_triggers.sql"
    ))
    .expect("apply llm_usage derived-table change-log cleanup migration");
    assert_eq!(
        change_log_trigger_count(&conn, "llm_usage_daily"),
        0,
        "upgrade must remove daily aggregate change-log triggers"
    );
    assert_eq!(
        pending_rows_for_table(&conn, "llm_usage_daily"),
        0,
        "upgrade must prune unsynced legacy daily aggregate change-log rows"
    );

    conn.execute(
        "INSERT INTO llm_usage_daily (
            date, caller_type, model, provider, request_count, total_tokens
         ) VALUES ('2024-05-02', 'chat_v2', 'gpt-4o-mini', 'openai', 1, 120)",
        [],
    )
    .expect("insert daily aggregate row after cleanup migration");
    assert_eq!(
        pending_rows_for_table(&conn, "llm_usage_daily"),
        0,
        "post-upgrade daily aggregate writes must stay local derived data"
    );

    conn.execute(
        "INSERT INTO llm_usage_logs (
            id, timestamp, provider, model, prompt_tokens, completion_tokens,
            total_tokens, token_source, caller_type, status, updated_at
         ) VALUES (
            'usage_cross_version_1', '2024-05-02T12:00:00.000Z', 'openai',
            'gpt-4o-mini', 80, 40, 120, 'api', 'chat_v2', 'success',
            '2024-05-02T12:00:00.000Z'
         )",
        [],
    )
    .expect("insert real usage log after cleanup migration");
    assert_eq!(
        pending_rows_for_table(&conn, "llm_usage_logs"),
        1,
        "source usage logs must remain RowSync after derived-table cleanup"
    );
    let raw_pending = SyncManager::get_pending_changes(&conn, None, None).expect("read pending");
    let filtered = SyncManager::filter_pending_changes_for_database(raw_pending, "llm_usage");
    assert_eq!(filtered.total_count, 1);
    assert_eq!(filtered.entries[0].table_name, "llm_usage_logs");
}

#[test]
fn cross_version_vfs_legacy_question_exam_record_ids_are_requeued_after_upgrade() {
    let conn = Connection::open_in_memory().expect("open legacy vfs database");
    conn.execute_batch(include_str!("../migrations/vfs/V20260130__init.sql"))
        .expect("apply vfs init migration");
    conn.execute_batch(include_str!(
        "../migrations/vfs/V20260131__add_change_log.sql"
    ))
    .expect("apply vfs legacy change-log migration");
    conn.execute_batch(include_str!(
        "../migrations/vfs/V20260201__add_sync_fields.sql"
    ))
    .expect("apply vfs sync fields migration");

    conn.execute(
        "INSERT INTO resources (
            id, hash, type, storage_mode, data, metadata_json, ref_count, created_at, updated_at
         ) VALUES (
            'res_question_legacy', 'hash_question_legacy', 'exam', 'inline',
            'legacy exam body', '{}', 1, ?1, ?1
         )",
        params![1_714_000_000_000i64],
    )
    .expect("insert legacy resource");
    conn.execute(
        "INSERT INTO exam_sheets (
            id, resource_id, exam_name, status, temp_id, metadata_json, preview_json,
            created_at, updated_at
         ) VALUES (
            'exam_question_legacy', 'res_question_legacy', 'Legacy exam',
            'completed', 'tmp_question_legacy', '{}', '{}', ?1, ?1
         )",
        params!["2024-04-24T00:00:00Z"],
    )
    .expect("insert legacy exam sheet");
    clear_change_log(&conn);

    for (id, content) in [
        ("q_question_legacy_1", "legacy question 1"),
        ("q_question_legacy_2", "legacy question 2"),
    ] {
        conn.execute(
            "INSERT INTO questions (
                id, exam_id, content, options_json, answer, explanation, question_type,
                tags, status, created_at, updated_at
             ) VALUES (
                ?1, 'exam_question_legacy', ?2, '[]', 'answer', 'explanation',
                'short_answer', '[]', 'new', ?3, ?3
             )",
            params![id, content, "2024-04-24T00:00:00Z"],
        )
        .unwrap_or_else(|e| panic!("insert legacy question {id}: {e}"));
    }

    assert_eq!(
        pending_record_ids_for_table(&conn, "questions"),
        BTreeSet::from(["exam_question_legacy".to_string()]),
        "legacy trigger should collapse question changes onto exam_id before upgrade"
    );

    conn.execute_batch(include_str!(
        "../migrations/vfs/V20260211__fix_change_log_record_id.sql"
    ))
    .expect("apply vfs question trigger repair migration");
    conn.execute_batch(include_str!(
        "../migrations/vfs/V20260524__add_change_log_field_deltas.sql"
    ))
    .expect("apply vfs field delta migration");
    conn.execute_batch(include_str!(
        "../migrations/vfs/V20260525__repair_legacy_questions_change_log_record_ids.sql"
    ))
    .expect("apply vfs legacy question pending repair migration");

    assert_eq!(
        pending_record_ids_for_table(&conn, "questions"),
        BTreeSet::from([
            "q_question_legacy_1".to_string(),
            "q_question_legacy_2".to_string(),
        ]),
        "upgrade must replace legacy exam_id pending entries with question primary keys"
    );

    let raw_pending = SyncManager::get_pending_changes(&conn, None, None).expect("read pending");
    let filtered = SyncManager::filter_pending_changes_for_database(raw_pending, "vfs");
    let enriched = SyncManager::enrich_changes_with_data(&conn, &filtered.entries, None)
        .expect("enrich repaired question changes");
    let enriched_ids: BTreeSet<String> = enriched
        .iter()
        .filter(|change| change.table_name == "questions")
        .map(|change| change.record_id.clone())
        .collect();
    assert_eq!(
        enriched_ids,
        BTreeSet::from([
            "q_question_legacy_1".to_string(),
            "q_question_legacy_2".to_string(),
        ]),
        "repaired question pending entries must resolve to full row payloads"
    );

    clear_change_log(&conn);
    conn.execute(
        "UPDATE questions
         SET content = 'legacy question 1 updated', updated_at = ?1
         WHERE id = 'q_question_legacy_1'",
        params!["2024-04-25T00:00:00Z"],
    )
    .expect("update question after trigger repair");
    assert_eq!(
        pending_record_ids_for_table(&conn, "questions"),
        BTreeSet::from(["q_question_legacy_1".to_string()]),
        "post-upgrade question trigger must use question id"
    );
}

#[tokio::test]
async fn real_download_rejects_stale_schema_manifest_then_succeeds_after_migration() {
    let source = migrate_workspace();
    let target = migrate_workspace();
    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);

    insert_vfs_note_bundle(
        &source_vfs,
        "res_schema_flow_1",
        "note_schema_flow_1",
        "hash_schema_flow_1",
        "Schema gated note",
    );

    let storage = MemoryCloudStorage::default();
    let source_manager = SyncManager::new("schema-source-device".to_string());
    let target_manager = SyncManager::new("schema-target-device".to_string());
    let changes = cloud_changes(&source_vfs, "vfs");
    source_manager
        .upload_enriched_changes(&storage, &changes, None)
        .await
        .expect("upload source changes");

    let source_manifest = local_manifest(&source_manager, &source_vfs, "vfs");
    source_manager
        .upload_manifest(&storage, &source_manifest)
        .await
        .expect("upload source manifest");

    let mut stale_manifest = local_manifest(&target_manager, &target_vfs, "vfs");
    stale_manifest
        .databases
        .get_mut("vfs")
        .expect("target manifest should include vfs")
        .schema_version = source_manifest.databases["vfs"]
        .schema_version
        .saturating_sub(1);

    let err = target_manager
        .execute_download(&storage, &stale_manifest, MergeStrategy::KeepLatest)
        .await
        .expect_err("stale schema should block download");
    assert!(
        matches!(err, SyncError::SchemaMismatch { .. }),
        "expected SchemaMismatch, got {err:?}"
    );

    let current_manifest = local_manifest(&target_manager, &target_vfs, "vfs");
    let (result, downloaded) = target_manager
        .execute_download(&storage, &current_manifest, MergeStrategy::KeepLatest)
        .await
        .expect("latest migrated target should download");
    assert!(result.success);
    assert!(downloaded.len() >= 2);

    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &downloaded, None)
        .expect("apply after schema migration");
    assert_eq!(applied.failure_count, 0);

    let title: String = target_vfs
        .query_row(
            "SELECT title FROM notes WHERE id = 'note_schema_flow_1'",
            [],
            |row| row.get(0),
        )
        .expect("schema gated note should exist after retry");
    assert_eq!(title, "Schema gated note");
}

#[tokio::test]
async fn real_full_cycle_all_databases_through_manifest_and_cloud_changes() {
    let source = migrate_workspace();
    let target = migrate_workspace();
    let databases = ["vfs", "chat_v2", "mistakes", "llm_usage"];

    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);
    insert_vfs_all_row_sync_bundle(&source_vfs);

    let source_chat = source.open("chat_v2");
    let target_chat = target.open("chat_v2");
    clear_change_log(&source_chat);
    clear_change_log(&target_chat);
    insert_chat_all_row_sync_bundle(&source_chat);

    let source_mistakes = source.open("mistakes");
    let target_mistakes = target.open("mistakes");
    clear_change_log(&source_mistakes);
    clear_change_log(&target_mistakes);
    insert_mistakes_all_row_sync_bundle(&source_mistakes);

    let source_usage = source.open("llm_usage");
    let target_usage = target.open("llm_usage");
    clear_change_log(&source_usage);
    clear_change_log(&target_usage);
    insert_llm_usage_all_row_sync_bundle(&source_usage);

    let storage = MemoryCloudStorage::default();
    let source_manager = SyncManager::new("full-cycle-source-device".to_string());
    let target_manager = SyncManager::new("full-cycle-target-device".to_string());

    let mut all_changes = Vec::new();
    append_enriched_changes(&mut all_changes, &source_vfs, "vfs");
    append_enriched_changes(&mut all_changes, &source_chat, "chat_v2");
    append_enriched_changes(&mut all_changes, &source_mistakes, "mistakes");
    append_enriched_changes(&mut all_changes, &source_usage, "llm_usage");
    assert!(
        all_changes
            .iter()
            .all(|change| change.database_name.is_some()),
        "every uploaded change must carry its database name"
    );

    source_manager
        .upload_enriched_changes(&storage, &all_changes, None)
        .await
        .expect("upload multi-database changes");
    let source_manifest = workspace_manifest(&source_manager, &source, &databases);
    source_manager
        .upload_manifest(&storage, &source_manifest)
        .await
        .expect("upload multi-database manifest");

    let target_manifest = workspace_manifest(&target_manager, &target, &databases);
    let (download_result, downloaded_changes) = target_manager
        .execute_download(&storage, &target_manifest, MergeStrategy::KeepLatest)
        .await
        .expect("download multi-database changes through manifest");
    assert!(
        download_result.success,
        "download result: {download_result:?}"
    );
    assert_eq!(
        downloaded_changes.len(),
        all_changes.len(),
        "target should download every uploaded RowSync change"
    );

    let mut grouped: BTreeMap<String, Vec<SyncChangeWithData>> = BTreeMap::new();
    for change in downloaded_changes {
        let database_name = change
            .database_name
            .clone()
            .expect("downloaded change must keep database name");
        grouped.entry(database_name).or_default().push(change);
    }

    for (database_name, target_conn) in [
        ("vfs", &target_vfs),
        ("chat_v2", &target_chat),
        ("mistakes", &target_mistakes),
        ("llm_usage", &target_usage),
    ] {
        let changes = grouped
            .remove(database_name)
            .unwrap_or_else(|| panic!("missing downloaded changes for {database_name}"));
        let applied = SyncManager::apply_downloaded_changes(target_conn, &changes, None)
            .unwrap_or_else(|e| panic!("apply {database_name} downloaded changes: {e}"));
        assert_eq!(
            applied.failure_count, 0,
            "{database_name} apply failures: {:?}",
            applied.failures
        );
        assert_eq!(
            pending_count(target_conn),
            0,
            "{database_name} replay must not create echo changes"
        );
    }
    assert!(
        grouped.is_empty(),
        "all downloaded database groups should be applied"
    );

    for table in [
        "resources",
        "notes",
        "files",
        "exam_sheets",
        "questions",
        "review_plans",
        "answer_submissions",
        "translations",
        "essay_sessions",
        "essays",
        "mindmaps",
        "folders",
        "folder_items",
        "todo_lists",
        "todo_items",
        "pomodoro_records",
    ] {
        assert_table_business_rows_match(&source_vfs, &target_vfs, "vfs", table);
    }
    for table in [
        "chat_v2_session_groups",
        "chat_v2_sessions",
        "chat_v2_messages",
        "chat_v2_blocks",
        "chat_v2_attachments",
        "resources",
        "chat_v2_session_mistakes",
        "workspace_index",
    ] {
        assert_table_business_rows_match(&source_chat, &target_chat, "chat_v2", table);
    }
    for table in [
        "mistakes",
        "chat_messages",
        "review_analyses",
        "review_chat_messages",
        "review_sessions",
        "review_session_mistakes",
        "document_tasks",
        "anki_cards",
    ] {
        assert_table_business_rows_match(&source_mistakes, &target_mistakes, "mistakes", table);
    }
    assert_table_business_rows_match(&source_usage, &target_usage, "llm_usage", "llm_usage_logs");
}
