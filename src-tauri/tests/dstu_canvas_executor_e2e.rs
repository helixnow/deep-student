use std::sync::Arc;

use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::tools::{
    CanvasToolExecutor, DstuToolExecutor, ExecutionContext, ToolExecutor,
};
use deep_student_lib::chat_v2::types::{ToolCall, ToolResultInfo};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::database::Database;
use deep_student_lib::file_manager::FileManager;
use deep_student_lib::llm_manager::LLMManager;
use deep_student_lib::tools::ToolRegistry;
use deep_student_lib::vfs::pdf_processing_service::PdfProcessingService;
use deep_student_lib::vfs::repos::{VfsFileRepo, VfsFolderRepo, VfsNoteRepo};
use deep_student_lib::vfs::types::VfsCreateNoteParams;
use deep_student_lib::vfs::{VfsDatabase, VfsLanceStore};
use serde_json::{json, Value};
use tempfile::TempDir;

struct ExecutorHarness {
    _app: tauri::App,
    _main_dir: TempDir,
    _vfs_dir: TempDir,
    main_db: Arc<Database>,
    vfs_db: Arc<VfsDatabase>,
    lance_store: Arc<VfsLanceStore>,
    window: tauri::Window,
}

fn create_vfs_db() -> (TempDir, Arc<VfsDatabase>) {
    let dir = TempDir::new().expect("create VFS temp directory");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Vfs)
        .expect("apply production VFS migrations");
    let db = VfsDatabase::new(dir.path()).expect("open migrated VFS database");
    (dir, Arc::new(db))
}

fn create_main_services(
    vfs_db: Arc<VfsDatabase>,
) -> (
    TempDir,
    Arc<Database>,
    Arc<LLMManager>,
    Arc<PdfProcessingService>,
) {
    let dir = TempDir::new().expect("create main database temp directory");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("apply production main-database migrations");
    let database = Arc::new(
        Database::new(&dir.path().join("mistakes.db")).expect("open migrated main database"),
    );
    let app_data_dir = dir.path().join("app-data");
    std::fs::create_dir_all(&app_data_dir).expect("create app data directory");
    let file_manager = Arc::new(FileManager::new(app_data_dir).expect("create file manager"));
    let llm_manager = Arc::new(
        LLMManager::new(database.clone(), file_manager.clone()).expect("create LLM manager"),
    );
    let pdf_processing_service = Arc::new(PdfProcessingService::new(
        vfs_db,
        database.clone(),
        llm_manager.clone(),
        file_manager,
    ));
    (dir, database, llm_manager, pdf_processing_service)
}

fn create_harness() -> ExecutorHarness {
    let (vfs_dir, vfs_db) = create_vfs_db();
    let lance_store =
        Arc::new(VfsLanceStore::new(vfs_db.clone()).expect("create temporary VFS vector store"));
    let (main_dir, main_db, llm_manager, pdf_processing_service) =
        create_main_services(vfs_db.clone());

    let app = tauri::Builder::default()
        .manage(vfs_db.clone())
        .manage(lance_store.clone())
        .manage(main_db.clone())
        .manage(llm_manager)
        .manage(pdf_processing_service)
        .build(tauri::generate_context!())
        .expect("build Tauri executor test app");
    let webview = tauri::WebviewWindowBuilder::new(
        &app,
        "dstu-canvas-executor-e2e",
        tauri::WebviewUrl::default(),
    )
    .build()
    .expect("build Tauri executor test window");
    let window = webview.as_ref().window();

    ExecutorHarness {
        _app: app,
        _main_dir: main_dir,
        _vfs_dir: vfs_dir,
        main_db,
        vfs_db,
        lance_store,
        window,
    }
}

fn execution_context(harness: &ExecutorHarness, block_id: &str) -> ExecutionContext {
    let emitter = Arc::new(ChatV2EventEmitter::new(
        harness.window.clone(),
        "dstu-canvas-e2e-session".to_string(),
    ));
    ExecutionContext::new(
        "dstu-canvas-e2e-session".to_string(),
        "dstu-canvas-e2e-message".to_string(),
        block_id.to_string(),
        emitter,
        Arc::new(ToolRegistry::new()),
        Some(harness.window.clone()),
    )
    .with_main_db(Some(harness.main_db.clone()))
    .with_vfs_db(Some(harness.vfs_db.clone()))
    .with_vfs_lance_store(Some(harness.lance_store.clone()))
}

async fn execute_tool(
    executor: &dyn ToolExecutor,
    harness: &ExecutorHarness,
    call_id: &str,
    tool_name: &str,
    arguments: Value,
) -> ToolResultInfo {
    executor
        .execute(
            &ToolCall::new(call_id.to_string(), tool_name.to_string(), arguments),
            &execution_context(harness, &format!("block-{call_id}")),
        )
        .await
        .expect("executor must return a ToolResultInfo")
}

fn assert_error_code(result: &ToolResultInfo, expected_code: &str) {
    assert!(!result.success, "call unexpectedly succeeded: {result:?}");
    let payload: Value = serde_json::from_str(
        result
            .error
            .as_deref()
            .expect("failed tool result must include an error"),
    )
    .expect("executor error must be structured JSON");
    assert_eq!(payload["code"], expected_code, "{payload}");
}

fn create_note(
    db: &VfsDatabase,
    title: &str,
    tags: &[&str],
    folder_id: Option<&str>,
) -> deep_student_lib::vfs::VfsNote {
    VfsNoteRepo::create_note_in_folder(
        db,
        VfsCreateNoteParams {
            title: title.to_string(),
            content: format!("# {title}\nExecutor integration fixture"),
            tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
        },
        folder_id,
    )
    .expect("create note fixture through production repository")
}

async fn dstu_and_canvas_tool_executors_run_real_migrated_mutation_paths() {
    let harness = create_harness();
    let dstu = DstuToolExecutor::new();
    let canvas = CanvasToolExecutor::new();

    let source_folder = execute_tool(
        &dstu,
        &harness,
        "folder-source",
        "builtin-dstu_folder_create",
        json!({"title": "Executor Source"}),
    )
    .await;
    assert!(source_folder.success, "{:?}", source_folder.error);
    let source_folder_id = source_folder.output["folder"]["id"]
        .as_str()
        .expect("source folder id")
        .to_string();

    let destination_folder = execute_tool(
        &dstu,
        &harness,
        "folder-destination",
        "builtin-dstu_folder_create",
        json!({"title": "Executor Destination"}),
    )
    .await;
    assert!(destination_folder.success, "{:?}", destination_folder.error);
    let destination_folder_id = destination_folder.output["folder"]["id"]
        .as_str()
        .expect("destination folder id")
        .to_string();

    let note = create_note(
        &harness.vfs_db,
        "Original executor note",
        &["phase2"],
        Some(&source_folder_id),
    );

    let rename = execute_tool(
        &dstu,
        &harness,
        "rename-note",
        "builtin-dstu_rename",
        json!({"path": note.id, "new_name": "Renamed executor note"}),
    )
    .await;
    assert!(rename.success, "{:?}", rename.error);
    assert_eq!(rename.output["action"], "rename");
    assert_eq!(
        VfsNoteRepo::get_note(&harness.vfs_db, &note.id)
            .expect("read renamed note")
            .expect("renamed note remains active")
            .title,
        "Renamed executor note"
    );

    let moved = execute_tool(
        &dstu,
        &harness,
        "move-note",
        "builtin-dstu_move",
        json!({"src": note.id, "dst": destination_folder_id}),
    )
    .await;
    assert!(moved.success, "{:?}", moved.error);
    let location = VfsFolderRepo::get_folder_item_by_item_id(&harness.vfs_db, "note", &note.id)
        .expect("read moved folder item")
        .expect("moved note has a folder item");
    assert_eq!(
        location.folder_id.as_deref(),
        Some(destination_folder_id.as_str())
    );

    let favorite = execute_tool(
        &dstu,
        &harness,
        "favorite-note",
        "builtin-dstu_set_favorite",
        json!({"path": note.id, "favorite": true}),
    )
    .await;
    assert!(favorite.success, "{:?}", favorite.error);
    assert!(
        VfsNoteRepo::get_note(&harness.vfs_db, &note.id)
            .expect("read favorited note")
            .expect("favorited note remains active")
            .is_favorite
    );

    let deleted = execute_tool(
        &dstu,
        &harness,
        "delete-note",
        "builtin-dstu_delete",
        json!({"path": note.id}),
    )
    .await;
    assert!(deleted.success, "{:?}", deleted.error);
    let trash = execute_tool(
        &dstu,
        &harness,
        "list-trash",
        "builtin-dstu_list_trash",
        json!({}),
    )
    .await;
    assert!(trash.success, "{:?}", trash.error);
    assert!(trash.output["items"]
        .as_array()
        .expect("trash items")
        .iter()
        .any(|item| item["id"] == note.id));

    let restored = execute_tool(
        &dstu,
        &harness,
        "restore-note",
        "builtin-dstu_restore",
        json!({"path": format!("/_trash/{}", note.id)}),
    )
    .await;
    assert!(restored.success, "{:?}", restored.error);
    assert_eq!(restored.output["node"]["id"], note.id);
    assert!(VfsNoteRepo::get_note(&harness.vfs_db, &note.id)
        .expect("read restored note")
        .is_some());

    let active_purge = execute_tool(
        &dstu,
        &harness,
        "purge-active-note",
        "builtin-dstu_purge",
        json!({"path": note.id}),
    )
    .await;
    assert_error_code(&active_purge, "DSTU_OPERATION_FAILED");
    assert!(VfsNoteRepo::get_note(&harness.vfs_db, &note.id)
        .expect("active note survives rejected purge")
        .is_some());

    let second_delete = execute_tool(
        &dstu,
        &harness,
        "delete-note-again",
        "builtin-dstu_delete",
        json!({"path": note.id}),
    )
    .await;
    assert!(second_delete.success, "{:?}", second_delete.error);
    let purged = execute_tool(
        &dstu,
        &harness,
        "purge-note",
        "builtin-dstu_purge",
        json!({"path": format!("/_trash/{}", note.id)}),
    )
    .await;
    assert!(purged.success, "{:?}", purged.error);
    let remaining: i64 = harness
        .vfs_db
        .get_conn_safe()
        .expect("open VFS connection")
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE id = ?1",
            rusqlite::params![note.id],
            |row| row.get(0),
        )
        .expect("count purged note rows");
    assert_eq!(remaining, 0);

    let upload_source = harness._main_dir.path().join("executor-upload.txt");
    std::fs::write(&upload_source, b"DSTU executor upload fixture")
        .expect("write local upload fixture");
    let uploaded = execute_tool(
        &dstu,
        &harness,
        "upload-file",
        "builtin-dstu_upload_file",
        json!({
            "local_path": upload_source,
            "folder_id": destination_folder_id,
            "name": "executor-upload.txt",
            "mime_type": "text/plain"
        }),
    )
    .await;
    assert!(uploaded.success, "{:?}", uploaded.error);
    let uploaded_file_id = uploaded.output["source_id"]
        .as_str()
        .expect("uploaded source id");
    let uploaded_file = VfsFileRepo::get_file(&harness.vfs_db, uploaded_file_id)
        .expect("read uploaded file")
        .expect("uploaded file persisted");
    assert_eq!(uploaded_file.file_name, "executor-upload.txt");
    assert_eq!(uploaded.output["folder_id"], destination_folder_id);

    let missing_rename_arg = execute_tool(
        &dstu,
        &harness,
        "rename-invalid",
        "builtin-dstu_rename",
        json!({"path": uploaded_file_id}),
    )
    .await;
    assert_error_code(&missing_rename_arg, "INVALID_ARGS");
    let ambiguous_upload = execute_tool(
        &dstu,
        &harness,
        "upload-invalid",
        "builtin-dstu_upload_file",
        json!({
            "local_path": upload_source,
            "root_id": "temp",
            "relative_path": "executor-upload.txt"
        }),
    )
    .await;
    assert_error_code(&ambiguous_upload, "INVALID_ARGS");

    let canvas_note = create_note(&harness.vfs_db, "Canvas executor note", &["old"], None);
    let missing_occ = execute_tool(
        &canvas,
        &harness,
        "tags-missing-occ",
        "builtin-note_update_tags",
        json!({"noteId": canvas_note.id, "tags": ["new"]}),
    )
    .await;
    assert_error_code(&missing_occ, "NOTE_OCC_REQUIRED");

    let updated_tags = execute_tool(
        &canvas,
        &harness,
        "update-tags",
        "builtin-note_update_tags",
        json!({
            "noteId": canvas_note.id,
            "tags": ["new", "agent"],
            "expected_updated_at": canvas_note.updated_at
        }),
    )
    .await;
    assert!(updated_tags.success, "{:?}", updated_tags.error);
    assert_eq!(updated_tags.output["previousTags"], json!(["old"]));
    assert_eq!(updated_tags.output["tags"], json!(["new", "agent"]));
    let updated_at = updated_tags.output["updatedAt"]
        .as_str()
        .expect("updated note revision")
        .to_string();

    let canvas_deleted = execute_tool(
        &canvas,
        &harness,
        "canvas-delete",
        "builtin-note_delete",
        json!({
            "noteId": canvas_note.id,
            "expected_updated_at": updated_at
        }),
    )
    .await;
    assert!(canvas_deleted.success, "{:?}", canvas_deleted.error);
    assert_eq!(canvas_deleted.output["softDeleted"], true);
    assert_eq!(canvas_deleted.output["restoreWith"], "builtin-dstu_restore");
    assert!(VfsNoteRepo::get_note(&harness.vfs_db, &canvas_note.id)
        .expect("read soft-deleted canvas note")
        .is_none());
}

fn main() {
    println!("running 1 test");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build Tokio executor test runtime");
    runtime.block_on(dstu_and_canvas_tool_executors_run_real_migrated_mutation_paths());
    println!("test dstu_and_canvas_tool_executors_run_real_migrated_mutation_paths ... ok");
    println!("\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
}
