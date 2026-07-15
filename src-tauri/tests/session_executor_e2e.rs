use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use deep_student_lib::chat_v2::database::ChatV2Database;
use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::repo::ChatV2Repo;
use deep_student_lib::chat_v2::tools::{ExecutionContext, SessionToolExecutor, ToolExecutor};
use deep_student_lib::chat_v2::types::{ChatMessage, ChatSession, MessageBlock, ToolCall};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::tools::ToolRegistry;
use deep_student_lib::vfs::repos::{VfsFolderRepo, VfsNoteRepo};
use deep_student_lib::vfs::{VfsDatabase, VfsFolder};
use serde_json::json;
use tempfile::TempDir;

const SESSION_ID: &str = "sess_session_export_e2e";

struct ExecutorHarness {
    _app: tauri::App,
    _chat_dir: TempDir,
    _vfs_dir: TempDir,
    chat_db: Arc<ChatV2Database>,
    vfs_db: Arc<VfsDatabase>,
    window: tauri::Window,
}

fn create_migrated_chat_db() -> (TempDir, Arc<ChatV2Database>) {
    let dir = TempDir::new().expect("create Chat V2 temp directory");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::ChatV2)
        .expect("apply production Chat V2 migrations");
    let db = ChatV2Database::new(dir.path()).expect("open migrated Chat V2 database");
    (dir, Arc::new(db))
}

fn create_migrated_vfs_db() -> (TempDir, Arc<VfsDatabase>) {
    let dir = TempDir::new().expect("create VFS temp directory");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Vfs)
        .expect("apply production VFS migrations");
    let db = VfsDatabase::new(dir.path()).expect("open migrated VFS database");
    (dir, Arc::new(db))
}

fn create_harness() -> ExecutorHarness {
    let (chat_dir, chat_db) = create_migrated_chat_db();
    let (vfs_dir, vfs_db) = create_migrated_vfs_db();
    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("build Tauri session executor test app");
    let webview = tauri::WebviewWindowBuilder::new(
        &app,
        "session-executor-e2e",
        tauri::WebviewUrl::default(),
    )
    .build()
    .expect("build Tauri session executor test window");
    let window = webview.as_ref().window();

    ExecutorHarness {
        _app: app,
        _chat_dir: chat_dir,
        _vfs_dir: vfs_dir,
        chat_db,
        vfs_db,
        window,
    }
}

fn persist_content_block(
    chat_db: &ChatV2Database,
    message: &mut ChatMessage,
    block_id: &str,
    content: String,
    block_index: u32,
) {
    let mut block = MessageBlock::new_content(message.id.clone(), block_index);
    block.id = block_id.to_string();
    block.content = Some(content);
    block.set_success();
    message.block_ids.push(block.id.clone());
    ChatV2Repo::create_block_v2(chat_db, &block).expect("persist content block");
}

fn seed_session(chat_db: &ChatV2Database, long_user_content: &str) -> String {
    let mut session = ChatSession::new(SESSION_ID.to_string(), "general_chat".to_string());
    session.title = Some("Production session export".to_string());
    ChatV2Repo::create_session_v2(chat_db, &session).expect("persist source session");

    let mut user = ChatMessage::new_user(SESSION_ID.to_string(), Vec::new());
    user.id = "msg_session_export_user".to_string();
    user.timestamp = 1_700_000_000_000;
    ChatV2Repo::create_message_v2(chat_db, &user).expect("persist user message shell");
    persist_content_block(
        chat_db,
        &mut user,
        "blk_session_export_user",
        long_user_content.to_string(),
        0,
    );
    ChatV2Repo::create_message_v2(chat_db, &user).expect("persist user block order");

    let mut assistant = ChatMessage::new_assistant(SESSION_ID.to_string());
    assistant.id = "msg_session_export_assistant".to_string();
    assistant.timestamp = 1_700_000_001_000;
    ChatV2Repo::create_message_v2(chat_db, &assistant).expect("persist assistant message shell");

    let mut thinking = MessageBlock::new_thinking(assistant.id.clone(), 0);
    thinking.id = "blk_session_export_private_thinking".to_string();
    thinking.content = Some("PRIVATE_CHAIN_OF_THOUGHT_MUST_NOT_LEAK".to_string());
    thinking.set_success();
    assistant.block_ids.push(thinking.id.clone());
    ChatV2Repo::create_block_v2(chat_db, &thinking).expect("persist private thinking block");

    persist_content_block(
        chat_db,
        &mut assistant,
        "blk_session_export_answer",
        "最终回答完整保留。".to_string(),
        1,
    );
    ChatV2Repo::create_message_v2(chat_db, &assistant).expect("persist assistant block order");

    assistant.id
}

fn execution_context(
    harness: &ExecutorHarness,
    message_id: &str,
    block_id: &str,
) -> ExecutionContext {
    let emitter = Arc::new(ChatV2EventEmitter::new(
        harness.window.clone(),
        SESSION_ID.to_string(),
    ));
    ExecutionContext::new(
        SESSION_ID.to_string(),
        message_id.to_string(),
        block_id.to_string(),
        emitter,
        Arc::new(ToolRegistry::new()),
        harness.window.clone(),
    )
    .with_chat_v2_db(Some(harness.chat_db.clone()))
    .with_vfs_db(Some(harness.vfs_db.clone()))
}

fn timestamp(timestamp_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .expect("fixture timestamp must be valid")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

async fn session_export_persists_complete_note_and_bounds_markdown_preview() {
    let harness = create_harness();
    let long_user_content = format!("{}正文结束标记", "会话正文段落-".repeat(480));
    let assistant_message_id = seed_session(&harness.chat_db, &long_user_content);
    let folder = VfsFolder::new("Agent session exports".to_string(), None, None, None);
    VfsFolderRepo::create_folder(&harness.vfs_db, &folder)
        .expect("persist destination folder through production repository");

    let expected_title = "Phase 3 complete session note";
    let expected_markdown = format!(
        "# {expected_title}\n\n> Session: `{SESSION_ID}`\n\n## User · {}\n\n{}\n\n## Assistant · {}\n\n最终回答完整保留。\n",
        timestamp(1_700_000_000_000),
        long_user_content,
        timestamp(1_700_000_001_000),
    );
    assert!(expected_markdown.chars().count() > 2_000);

    let executor = SessionToolExecutor::new();
    let note_export = executor
        .execute(
            &ToolCall::new(
                "call-session-export-note".to_string(),
                "builtin-session_export".to_string(),
                json!({
                    "session_id": SESSION_ID,
                    "format": "note",
                    "title": expected_title,
                    "folder_id": folder.id
                }),
            ),
            &execution_context(
                &harness,
                &assistant_message_id,
                "blk_session_export_note_call",
            ),
        )
        .await
        .expect("session note executor result");
    assert!(note_export.success, "{:?}", note_export.error);
    assert_eq!(note_export.output["success"], true);
    assert_eq!(note_export.output["format"], "note");
    assert_eq!(note_export.output["sessionId"], SESSION_ID);
    assert_eq!(note_export.output["title"], expected_title);
    assert_eq!(note_export.output["messageCount"], 2);
    assert_eq!(note_export.output["folderId"], folder.id);
    assert_eq!(note_export.output["target"]["kind"], "vfs_note");
    assert_eq!(note_export.output["reversible"], true);
    assert_eq!(note_export.output["reverseWith"], "builtin-note_delete");

    let note_id = note_export.output["noteId"]
        .as_str()
        .expect("note export returns note ID");
    let resource_id = note_export.output["resourceId"]
        .as_str()
        .expect("note export returns resource ID");
    let path = note_export.output["path"]
        .as_str()
        .expect("note export returns DSTU path");
    assert!(note_id.starts_with("note_"));
    assert!(resource_id.starts_with("res_"));
    assert_eq!(path, format!("/{note_id}"));
    assert_eq!(note_export.output["target"]["folderId"], folder.id);
    assert_eq!(note_export.output["target"]["noteId"], note_id);
    assert_eq!(note_export.output["target"]["resourceId"], resource_id);
    assert_eq!(note_export.output["target"]["path"], path);

    let (persisted_note, persisted_content) =
        VfsNoteRepo::get_note_with_content(&harness.vfs_db, note_id)
            .expect("read exported note from migrated VFS")
            .expect("exported note exists");
    assert_eq!(persisted_note.id, note_id);
    assert_eq!(persisted_note.resource_id, resource_id);
    assert_eq!(persisted_note.title, expected_title);
    assert_eq!(persisted_content, expected_markdown);
    assert!(persisted_content.ends_with("最终回答完整保留。\n"));
    assert!(!persisted_content.contains("PRIVATE_CHAIN_OF_THOUGHT_MUST_NOT_LEAK"));

    let location = VfsFolderRepo::get_folder_item_by_item_id(&harness.vfs_db, "note", note_id)
        .expect("read exported note folder membership")
        .expect("exported note has folder membership");
    assert_eq!(location.folder_id.as_deref(), Some(folder.id.as_str()));

    let markdown_export = executor
        .execute(
            &ToolCall::new(
                "call-session-export-markdown".to_string(),
                "builtin-session_export".to_string(),
                json!({
                    "session_id": SESSION_ID,
                    "format": "markdown",
                    "title": expected_title
                }),
            ),
            &execution_context(
                &harness,
                &assistant_message_id,
                "blk_session_export_markdown_call",
            ),
        )
        .await
        .expect("session markdown executor result");
    assert!(markdown_export.success, "{:?}", markdown_export.error);
    assert_eq!(markdown_export.output["format"], "markdown");
    assert_eq!(markdown_export.output["messageCount"], 2);
    assert_eq!(markdown_export.output["truncated"], true);
    assert_eq!(
        markdown_export.output["totalChars"],
        expected_markdown.chars().count()
    );
    assert_eq!(
        markdown_export.output["markdown"]
            .as_str()
            .expect("markdown preview")
            .chars()
            .count(),
        2_000
    );
    assert!(expected_markdown.starts_with(
        markdown_export.output["markdown"]
            .as_str()
            .expect("markdown preview")
    ));
    assert!(!markdown_export
        .output
        .to_string()
        .contains("PRIVATE_CHAIN_OF_THOUGHT_MUST_NOT_LEAK"));
}

fn main() {
    println!("running 1 test");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build Tokio session executor test runtime");
    runtime.block_on(session_export_persists_complete_note_and_bounds_markdown_preview());
    println!("test session_export_persists_complete_note_and_bounds_markdown_preview ... ok");
    println!("\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
}
