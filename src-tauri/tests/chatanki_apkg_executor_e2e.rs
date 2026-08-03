use deep_student_lib::chat_v2::database::ChatV2Database;
use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::repo::ChatV2Repo;
use deep_student_lib::chat_v2::resource_types::{ContextRef, ContextSnapshot};
use deep_student_lib::chat_v2::tools::{ChatAnkiToolExecutor, ExecutionContext, ToolExecutor};
use deep_student_lib::chat_v2::types::{ChatMessage, ChatSession, MessageMeta, ToolCall};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::database::Database;
use deep_student_lib::tools::ToolRegistry;
use deep_student_lib::vfs::{VfsBlobRepo, VfsDatabase, VfsFileRepo};
use rusqlite::{params, Connection};
use serde_json::json;
use std::io::{Cursor, Write};
use std::sync::Arc;
use tempfile::{NamedTempFile, TempDir};
use zip::write::FileOptions;
use zip::ZipWriter;

struct ExecutorHarness {
    _app: tauri::App,
    _anki_dir: TempDir,
    _chat_dir: TempDir,
    _vfs_dir: TempDir,
    anki_db: Arc<Database>,
    chat_db: Arc<ChatV2Database>,
    vfs_db: Arc<VfsDatabase>,
    window: tauri::Window,
}

fn create_runtime_window(label: &str) -> (tauri::App, tauri::Window) {
    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("build Tauri test app");
    let webview = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
        .build()
        .expect("build Tauri test window");
    (app, webview.as_ref().window())
}

fn create_anki_db() -> (TempDir, Arc<Database>) {
    let dir = TempDir::new().expect("Anki temp dir");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("mistakes migrations");
    let db = Database::new(&dir.path().join("mistakes.db")).expect("Anki database");
    (dir, Arc::new(db))
}

fn create_chat_db() -> (TempDir, Arc<ChatV2Database>) {
    let dir = TempDir::new().expect("Chat V2 temp dir");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::ChatV2)
        .expect("Chat V2 migrations");
    let db = ChatV2Database::new(dir.path()).expect("Chat V2 database");
    (dir, Arc::new(db))
}

fn create_vfs_db() -> (TempDir, Arc<VfsDatabase>) {
    let dir = TempDir::new().expect("VFS temp dir");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Vfs)
        .expect("VFS migrations");
    let db = VfsDatabase::new(dir.path()).expect("VFS database");
    (dir, Arc::new(db))
}

fn create_harness() -> ExecutorHarness {
    let (anki_dir, anki_db) = create_anki_db();
    let (chat_dir, chat_db) = create_chat_db();
    let (vfs_dir, vfs_db) = create_vfs_db();
    let (app, window) = create_runtime_window("chatanki-apkg-executor-e2e");
    ExecutorHarness {
        _app: app,
        _anki_dir: anki_dir,
        _chat_dir: chat_dir,
        _vfs_dir: vfs_dir,
        anki_db,
        chat_db,
        vfs_db,
        window,
    }
}

fn make_basic_apkg() -> Vec<u8> {
    let collection = NamedTempFile::new().expect("collection temp file");
    let conn = Connection::open(collection.path()).expect("open collection");
    conn.execute_batch(
        "PRAGMA journal_mode = DELETE;
         CREATE TABLE col (models TEXT NOT NULL, decks TEXT NOT NULL);
         CREATE TABLE notes (
             id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL
         );
         CREATE TABLE cards (
             id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL
         );",
    )
    .expect("create collection schema");
    let models = json!({
        "100": {
            "id": 100,
            "name": "Portable Basic",
            "type": 0,
            "flds": [
                {"name": "Front", "ord": 0},
                {"name": "Back", "ord": 1},
                {"name": "Source", "ord": 2}
            ]
        }
    });
    let decks = json!({"1": {"id": 1, "name": "Portable Deck"}});
    conn.execute(
        "INSERT INTO col (models, decks) VALUES (?1, ?2)",
        params![models.to_string(), decks.to_string()],
    )
    .expect("insert collection metadata");
    conn.execute(
        "INSERT INTO notes (id, mid, tags, flds) VALUES (1, 100, 'alpha beta', ?1)",
        params!["Executor front\u{1f}Executor back\u{1f}portable fixture"],
    )
    .expect("insert note");
    conn.execute(
        "INSERT INTO cards (id, nid, did, ord) VALUES (10, 1, 1, 0)",
        [],
    )
    .expect("insert card");
    conn.close().expect("close collection");

    let collection_bytes = std::fs::read(collection.path()).expect("read collection");
    let cursor = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(cursor);
    zip.start_file("collection.anki2", FileOptions::default())
        .expect("start collection entry");
    zip.write_all(&collection_bytes)
        .expect("write collection entry");
    zip.start_file("media", FileOptions::default())
        .expect("start media entry");
    zip.write_all(b"{}").expect("write media manifest");
    zip.finish().expect("finish APKG").into_inner()
}

fn seed_session(chat_db: &ChatV2Database, session_id: &str, resource_id: Option<&str>) {
    ChatV2Repo::create_session_v2(
        chat_db,
        &ChatSession::new(session_id.to_string(), "general_chat".to_string()),
    )
    .expect("create session");

    if let Some(resource_id) = resource_id {
        let mut message = ChatMessage::new_user(session_id.to_string(), Vec::new());
        message.meta = Some(MessageMeta {
            context_snapshot: Some(ContextSnapshot {
                user_refs: vec![ContextRef::new(
                    resource_id.to_string(),
                    "portable-apkg-hash".to_string(),
                    "file".to_string(),
                )],
                ..Default::default()
            }),
            ..Default::default()
        });
        ChatV2Repo::create_message_v2(chat_db, &message).expect("create context message");
    }
}

fn execution_context(
    harness: &ExecutorHarness,
    session_id: &str,
    message_id: &str,
    block_id: &str,
) -> ExecutionContext {
    let emitter = Arc::new(ChatV2EventEmitter::new(
        harness.window.clone(),
        session_id.to_string(),
    ));
    ExecutionContext::new(
        session_id.to_string(),
        message_id.to_string(),
        block_id.to_string(),
        emitter,
        Arc::new(ToolRegistry::new()),
        Some(harness.window.clone()),
    )
    .with_anki_db(Some(harness.anki_db.clone()))
    .with_chat_v2_db(Some(harness.chat_db.clone()))
    .with_vfs_db(Some(harness.vfs_db.clone()))
}

async fn executor_imports_vfs_apkg_reads_cards_and_enforces_document_ownership() {
    const OWNER: &str = "chatanki-apkg-owner";
    const OTHER: &str = "chatanki-apkg-other";

    let harness = create_harness();
    let apkg = make_basic_apkg();
    let blob = VfsBlobRepo::store_blob(
        &harness.vfs_db,
        &apkg,
        Some("application/octet-stream"),
        Some("apkg"),
    )
    .expect("store APKG blob");
    let file = VfsFileRepo::create_file(
        &harness.vfs_db,
        &blob.hash,
        "portable.apkg",
        apkg.len() as i64,
        "file",
        Some("application/octet-stream"),
        Some(&blob.hash),
        None,
    )
    .expect("create APKG VFS file");
    let resource_id = file.resource_id.expect("file resource ID");
    assert!(resource_id.starts_with("res_"));

    seed_session(&harness.chat_db, OWNER, Some(&resource_id));
    seed_session(&harness.chat_db, OTHER, None);
    let executor = ChatAnkiToolExecutor::new();

    let import = executor
        .execute(
            &ToolCall::new(
                "call-import".to_string(),
                "builtin-chatanki_import_apkg".to_string(),
                json!({"resourceId": resource_id}),
            ),
            &execution_context(&harness, OWNER, "message-import", "block-import"),
        )
        .await
        .expect("executor import result");
    assert!(import.success, "import failed: {:?}", import.error);
    assert_eq!(import.output["importedCards"], 1);
    assert_eq!(import.output["importedTemplates"], 0);
    assert_eq!(import.output["mediaSkipped"], 0);
    // 导入成功后附带后续操作建议（提示 AI 入队复习并展示卡片）
    let next_steps = import.output["nextSteps"]
        .as_array()
        .expect("nextSteps suggestions");
    assert!(next_steps.iter().any(|step| step
        .as_str()
        .is_some_and(|s| s.contains("chatanki_enqueue_review"))));
    let document_id = import.output["documentId"]
        .as_str()
        .expect("import document ID")
        .to_string();
    assert!(harness
        .anki_db
        .is_document_owned_by_session(&document_id, OWNER)
        .expect("owner lookup"));
    assert!(!harness
        .anki_db
        .is_document_owned_by_session(&document_id, OTHER)
        .expect("other-session lookup"));

    let read = executor
        .execute(
            &ToolCall::new(
                "call-read".to_string(),
                "builtin-chatanki_get_cards".to_string(),
                json!({"documentId": document_id, "page": 1, "pageSize": 20}),
            ),
            &execution_context(&harness, OWNER, "message-read", "block-read"),
        )
        .await
        .expect("executor read result");
    assert!(read.success, "read failed: {:?}", read.error);
    assert_eq!(read.output["status"], "ok");
    assert_eq!(read.output["total"], 1);
    assert_eq!(read.output["page"], 1);
    assert_eq!(read.output["pageSize"], 20);
    let cards = read.output["cards"].as_array().expect("cards array");
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["front"], "Executor front");
    assert_eq!(cards[0]["back"], "Executor back");
    assert_eq!(cards[0]["tags"], json!(["alpha", "beta"]));
    assert_eq!(cards[0]["extraFields"]["Source"], "portable fixture");
    assert!(cards[0]["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(cards[0]["version"]
        .as_str()
        .is_some_and(|version| !version.is_empty()));

    let rejected = executor
        .execute(
            &ToolCall::new(
                "call-cross-session".to_string(),
                "builtin-chatanki_get_cards".to_string(),
                json!({"documentId": document_id}),
            ),
            &execution_context(
                &harness,
                OTHER,
                "message-cross-session",
                "block-cross-session",
            ),
        )
        .await
        .expect("executor cross-session result");
    assert!(!rejected.success);
    assert_eq!(
        rejected.error.as_deref(),
        Some("blocks.ankiCards.errors.statusNotFound")
    );
}

fn main() {
    println!("running 1 test");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build Tokio test runtime");
    runtime.block_on(executor_imports_vfs_apkg_reads_cards_and_enforces_document_ownership());
    println!("test executor_imports_vfs_apkg_reads_cards_and_enforces_document_ownership ... ok");
    println!("\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
}
