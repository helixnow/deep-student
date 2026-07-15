use std::sync::{Arc, Mutex};

use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::tools::textbook_pdf_executor::PDF_ANNOTATIONS_CHANGED_EVENT;
use deep_student_lib::chat_v2::tools::{
    ExecutionContext, MemoryToolExecutor, TextbookPdfToolExecutor, ToolExecutor,
};
use deep_student_lib::chat_v2::types::{ToolCall, ToolResultInfo};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::database::Database;
use deep_student_lib::file_manager::FileManager;
use deep_student_lib::llm_manager::LLMManager;
use deep_student_lib::memory::MemoryService;
use deep_student_lib::tools::ToolRegistry;
use deep_student_lib::vfs::repos::{VfsNoteRepo, VfsTextbookRepo};
use deep_student_lib::vfs::types::VfsCreateNoteParams;
use deep_student_lib::vfs::{VfsDatabase, VfsLanceStore};
use serde_json::{json, Value};
use tauri::Listener;
use tempfile::TempDir;

const MEMORY_CHANGED_EVENT: &str = "memory://changed";

struct Phase89Harness {
    _app: tauri::App,
    _main_dir: TempDir,
    _vfs_dir: TempDir,
    main_db: Arc<Database>,
    vfs_db: Arc<VfsDatabase>,
    lance_store: Arc<VfsLanceStore>,
    llm_manager: Arc<LLMManager>,
    memory_service: MemoryService,
    window: tauri::Window,
}

fn create_harness() -> Phase89Harness {
    let vfs_dir = TempDir::new().expect("create VFS temp directory");
    let mut vfs_coordinator =
        MigrationCoordinator::new(vfs_dir.path().to_path_buf()).with_audit_db(None);
    vfs_coordinator
        .migrate_single(DatabaseId::Vfs)
        .expect("apply production VFS migrations");
    let vfs_db = Arc::new(VfsDatabase::new(vfs_dir.path()).expect("open migrated VFS database"));
    let lance_store = Arc::new(VfsLanceStore::new(vfs_db.clone()).expect("create VFS Lance store"));

    let main_dir = TempDir::new().expect("create main database temp directory");
    let mut main_coordinator =
        MigrationCoordinator::new(main_dir.path().to_path_buf()).with_audit_db(None);
    main_coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("apply production main-database migrations");
    let main_db = Arc::new(
        Database::new(&main_dir.path().join("mistakes.db")).expect("open migrated main database"),
    );
    let file_manager = Arc::new(
        FileManager::new(main_dir.path().join("app-data")).expect("create test file manager"),
    );
    let llm_manager =
        Arc::new(LLMManager::new(main_db.clone(), file_manager).expect("create test LLM manager"));
    let memory_service =
        MemoryService::new(vfs_db.clone(), lance_store.clone(), llm_manager.clone());

    let app = tauri::Builder::default()
        .manage(main_db.clone())
        .manage(vfs_db.clone())
        .manage(lance_store.clone())
        .manage(llm_manager.clone())
        .build(tauri::generate_context!())
        .expect("build phase 8/9 executor test app");
    let webview = tauri::WebviewWindowBuilder::new(
        &app,
        "phase8-9-executor-e2e",
        tauri::WebviewUrl::default(),
    )
    .build()
    .expect("build phase 8/9 executor test window");
    let window = webview.as_ref().window();

    Phase89Harness {
        _app: app,
        _main_dir: main_dir,
        _vfs_dir: vfs_dir,
        main_db,
        vfs_db,
        lance_store,
        llm_manager,
        memory_service,
        window,
    }
}

fn execution_context(harness: &Phase89Harness, call_id: &str) -> ExecutionContext {
    let emitter = Arc::new(ChatV2EventEmitter::new(
        harness.window.clone(),
        "phase8-9-executor-session".to_string(),
    ));
    ExecutionContext::new(
        "phase8-9-executor-session".to_string(),
        "phase8-9-executor-message".to_string(),
        format!("block-{call_id}"),
        emitter,
        Arc::new(ToolRegistry::new()),
        harness.window.clone(),
    )
    .with_main_db(Some(harness.main_db.clone()))
    .with_vfs_db(Some(harness.vfs_db.clone()))
    .with_vfs_lance_store(Some(harness.lance_store.clone()))
    .with_llm_manager(Some(harness.llm_manager.clone()))
    .with_tool_call_id(call_id)
}

async fn execute_tool(
    executor: &dyn ToolExecutor,
    harness: &Phase89Harness,
    call_id: &str,
    tool_name: &str,
    arguments: Value,
) -> ToolResultInfo {
    let tool_name = if tool_name.starts_with("builtin-") {
        tool_name.to_string()
    } else {
        format!("builtin-{tool_name}")
    };
    executor
        .execute(
            &ToolCall::new(call_id.to_string(), tool_name, arguments),
            &execution_context(harness, call_id),
        )
        .await
        .expect("production executor returns ToolResultInfo")
}

fn capture_json_events(window: &tauri::Window, event_name: &str) -> Arc<Mutex<Vec<Value>>> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    window.listen(event_name.to_string(), move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(payload);
        }
    });
    events
}

fn event_count(events: &Arc<Mutex<Vec<Value>>>) -> usize {
    events
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .len()
}

async fn wait_for_annotation_event(
    events: &Arc<Mutex<Vec<Value>>>,
    kind: &str,
    action: &str,
) -> Value {
    for _ in 0..50 {
        let matched = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|payload| payload["kind"] == kind && payload["action"] == action)
            .cloned();
        if let Some(payload) = matched {
            return payload;
        }
        tokio::task::yield_now().await;
    }
    panic!("missing annotation event kind={kind} action={action}");
}

async fn wait_for_memory_event(
    events: &Arc<Mutex<Vec<Value>>>,
    action: &str,
    run_id: &str,
) -> Value {
    for _ in 0..50 {
        let matched = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|payload| payload["action"] == action && payload["runId"] == run_id)
            .cloned();
        if let Some(payload) = matched {
            return payload;
        }
        tokio::task::yield_now().await;
    }
    panic!("missing memory event action={action} run_id={run_id}");
}

fn assert_success(result: &ToolResultInfo) -> &Value {
    assert!(result.success, "tool failed unexpectedly: {result:?}");
    &result.output
}

fn assert_error_code(result: &ToolResultInfo, expected_code: &str) -> Value {
    assert!(!result.success, "tool unexpectedly succeeded: {result:?}");
    let error: Value = serde_json::from_str(
        result
            .error
            .as_deref()
            .expect("failed result must carry a structured error"),
    )
    .expect("tool error must be JSON");
    assert_eq!(error["code"], expected_code, "{error}");
    error
}

async fn textbook_annotations_use_real_occ_persistence_and_events(harness: &Phase89Harness) {
    let executor = TextbookPdfToolExecutor::new();
    let events = capture_json_events(&harness.window, PDF_ANNOTATIONS_CHANGED_EVENT);
    let created = VfsTextbookRepo::create_textbook(
        &harness.vfs_db,
        "phase8-annotations-sha256",
        "phase8-textbook.pdf",
        4096,
        None,
        None,
    )
    .expect("create textbook fixture through production repository");
    VfsTextbookRepo::update_page_count(&harness.vfs_db, &created.id, 20)
        .expect("set textbook page count");
    let textbook = VfsTextbookRepo::get_textbook(&harness.vfs_db, &created.id)
        .expect("read textbook fixture")
        .expect("textbook exists");

    let stale_add = execute_tool(
        &executor,
        harness,
        "highlight-stale-add",
        "textbook_highlights",
        json!({
            "action": "add",
            "textbook_id": textbook.id,
            "page_index": 11,
            "text": "Phase 8 highlighted passage",
            "color": "#fef08a",
            "rects": [{"x": 0.1, "y": 0.2, "width": 0.6, "height": 0.08}],
            "expected_updated_at": "2000-01-01T00:00:00.000Z"
        }),
    )
    .await;
    let stale_add_error = assert_error_code(&stale_add, "ANNOTATION_CONFLICT");
    assert_eq!(stale_add_error["kind"], "highlights");
    assert_eq!(stale_add_error["current_updated_at"], textbook.updated_at);
    assert_eq!(stale_add_error["current"], json!([]));
    assert_eq!(event_count(&events), 0);

    let highlight_add = execute_tool(
        &executor,
        harness,
        "highlight-add",
        "textbook_highlights",
        json!({
            "action": "add",
            "textbook_id": textbook.id,
            "page_index": 11,
            "text": "Phase 8 highlighted passage",
            "color": "#fef08a",
            "rects": [{"x": 0.1, "y": 0.2, "width": 0.6, "height": 0.08}],
            "expected_updated_at": textbook.updated_at
        }),
    )
    .await;
    let highlight_output = assert_success(&highlight_add);
    let highlight_id = highlight_output["annotation"]["id"]
        .as_str()
        .expect("highlight id")
        .to_string();
    let revision_after_highlight = highlight_output["updated_at"]
        .as_str()
        .expect("highlight revision")
        .to_string();
    assert_eq!(highlight_output["annotation"]["pageIndex"], 11);
    assert_eq!(highlight_output["annotation"]["coordVersion"], 2);
    assert_eq!(highlight_output["reversible_with_occ"], true);
    let highlight_event = wait_for_annotation_event(&events, "highlights", "add").await;
    assert_eq!(highlight_event["textbook_id"], textbook.id);
    assert_eq!(highlight_event["updated_at"], revision_after_highlight);

    let bookmark_add = execute_tool(
        &executor,
        harness,
        "bookmark-add",
        "textbook_bookmarks",
        json!({
            "action": "add",
            "textbook_id": textbook.id,
            "page_number": 12,
            "title": "Phase 8 key page",
            "expected_updated_at": revision_after_highlight
        }),
    )
    .await;
    let bookmark_output = assert_success(&bookmark_add);
    let revision_after_bookmark = bookmark_output["updated_at"]
        .as_str()
        .expect("bookmark revision")
        .to_string();
    assert_eq!(bookmark_output["annotation"]["page"], 12);
    assert_eq!(bookmark_output["annotation"]["title"], "Phase 8 key page");
    let bookmark_event = wait_for_annotation_event(&events, "bookmarks", "add").await;
    assert_eq!(bookmark_event["updated_at"], revision_after_bookmark);

    let persisted = VfsTextbookRepo::get_textbook(&harness.vfs_db, &textbook.id)
        .expect("read persisted annotations")
        .expect("textbook remains active");
    assert_eq!(persisted.bookmarks.len(), 1);
    assert_eq!(persisted.highlights.len(), 1);
    assert_eq!(persisted.highlights[0]["id"], highlight_id);

    let events_before_conflict = event_count(&events);
    let stale_update = execute_tool(
        &executor,
        harness,
        "highlight-stale-update",
        "textbook_highlights",
        json!({
            "action": "update",
            "textbook_id": textbook.id,
            "highlight_id": highlight_id,
            "text": "Stale replacement must not persist",
            "expected_updated_at": revision_after_highlight
        }),
    )
    .await;
    let stale_update_error = assert_error_code(&stale_update, "ANNOTATION_CONFLICT");
    assert_eq!(
        stale_update_error["current_updated_at"],
        revision_after_bookmark
    );
    assert_eq!(stale_update_error["current"][0]["id"], highlight_id);
    tokio::task::yield_now().await;
    assert_eq!(event_count(&events), events_before_conflict);

    let highlight_update = execute_tool(
        &executor,
        harness,
        "highlight-update",
        "textbook_highlights",
        json!({
            "action": "update",
            "textbook_id": textbook.id,
            "highlight_id": highlight_id,
            "text": "Phase 8 revised highlighted passage",
            "color": "#bbf7d0",
            "expected_updated_at": revision_after_bookmark
        }),
    )
    .await;
    let update_output = assert_success(&highlight_update);
    assert_eq!(
        update_output["previous"]["text"],
        "Phase 8 highlighted passage"
    );
    assert_eq!(
        update_output["annotation"]["text"],
        "Phase 8 revised highlighted passage"
    );
    assert_eq!(update_output["annotation"]["color"], "#bbf7d0");
    wait_for_annotation_event(&events, "highlights", "update").await;

    let highlights_get = execute_tool(
        &executor,
        harness,
        "highlight-get",
        "textbook_highlights",
        json!({"action": "get", "textbook_id": textbook.id, "page_index": 11}),
    )
    .await;
    let get_output = assert_success(&highlights_get);
    assert_eq!(get_output["total"], 1);
    assert_eq!(
        get_output["items"][0]["text"],
        "Phase 8 revised highlighted passage"
    );
}

fn create_memory_note(
    harness: &Phase89Harness,
    root_id: &str,
    title: &str,
    user_tag: &str,
) -> deep_student_lib::vfs::VfsNote {
    VfsNoteRepo::create_note_in_folder(
        &harness.vfs_db,
        VfsCreateNoteParams {
            title: title.to_string(),
            content: format!("# {title}\nPhase 9 memory fixture"),
            tags: vec!["_system-fixture".to_string(), user_tag.to_string()],
        },
        Some(root_id),
    )
    .expect("create memory note fixture")
}

async fn memory_tags_and_relations_expose_occ_inverse_and_events(harness: &Phase89Harness) {
    let executor = MemoryToolExecutor::new();
    let events = capture_json_events(&harness.window, MEMORY_CHANGED_EVENT);
    let root_id = harness
        .memory_service
        .get_or_create_root_folder()
        .expect("create memory root folder");
    let note_a = create_memory_note(harness, &root_id, "Memory Alpha", "old-alpha");
    let note_b = create_memory_note(harness, &root_id, "Memory Beta", "old-beta");

    let stale_tags = execute_tool(
        &executor,
        harness,
        "memory-tags-stale",
        "memory_update_tags",
        json!({
            "note_id": note_a.id,
            "tags": ["new-alpha"],
            "expected_updated_at": "2000-01-01T00:00:00.000Z"
        }),
    )
    .await;
    let stale_tags_error = assert_error_code(&stale_tags, "MEMORY_CONFLICT");
    assert_eq!(stale_tags_error["action"], "update_tags");
    assert_eq!(stale_tags_error["current"][0]["note_id"], note_a.id);
    assert_eq!(
        stale_tags_error["current"][0]["updated_at"],
        note_a.updated_at
    );
    assert_eq!(event_count(&events), 0);

    let tags_update = execute_tool(
        &executor,
        harness,
        "memory-tags-update",
        "memory_update_tags",
        json!({
            "note_id": note_a.id,
            "tags": ["new-alpha", "_forged-system-tag"],
            "expected_updated_at": note_a.updated_at
        }),
    )
    .await;
    let tags_output = assert_success(&tags_update);
    assert_eq!(tags_output["user_tags"], json!(["new-alpha"]));
    assert_eq!(tags_output["system_tags_preserved"], true);
    assert_eq!(tags_output["undo"]["tool"], "builtin-memory_update_tags");
    assert_eq!(tags_output["undo"]["tags"], json!(["old-alpha"]));
    let tags_event = wait_for_memory_event(&events, "update_tags", "memory-tags-update").await;
    assert_eq!(tags_event["entityIds"], json!([note_a.id]));

    let tags_undo = execute_tool(
        &executor,
        harness,
        "memory-tags-undo",
        tags_output["undo"]["tool"].as_str().expect("tag undo tool"),
        json!({
            "note_id": tags_output["undo"]["note_id"],
            "tags": tags_output["undo"]["tags"],
            "expected_updated_at": tags_output["undo"]["expected_updated_at"]
        }),
    )
    .await;
    let tags_undo_output = assert_success(&tags_undo);
    assert_eq!(tags_undo_output["user_tags"], json!(["old-alpha"]));
    wait_for_memory_event(&events, "update_tags", "memory-tags-undo").await;
    let note_a_after_undo = VfsNoteRepo::get_note(&harness.vfs_db, &note_a.id)
        .expect("read tag-restored note")
        .expect("memory note exists");
    assert!(note_a_after_undo
        .tags
        .contains(&"_system-fixture".to_string()));
    assert!(note_a_after_undo.tags.contains(&"old-alpha".to_string()));
    assert!(!note_a_after_undo
        .tags
        .contains(&"_forged-system-tag".to_string()));

    let note_b_current = VfsNoteRepo::get_note(&harness.vfs_db, &note_b.id)
        .expect("read second memory note")
        .expect("second memory note exists");
    let events_before_relation_conflict = event_count(&events);
    let stale_relation = execute_tool(
        &executor,
        harness,
        "memory-relation-stale",
        "memory_add_relation",
        json!({
            "note_id_a": note_a_after_undo.id,
            "note_id_b": note_b_current.id,
            "expected_updated_at_a": note_a_after_undo.updated_at,
            "expected_updated_at_b": "2000-01-01T00:00:00.000Z"
        }),
    )
    .await;
    let relation_conflict = assert_error_code(&stale_relation, "MEMORY_CONFLICT");
    assert_eq!(relation_conflict["action"], "add_relation");
    assert_eq!(relation_conflict["current"].as_array().unwrap().len(), 2);
    tokio::task::yield_now().await;
    assert_eq!(event_count(&events), events_before_relation_conflict);

    let relation_add = execute_tool(
        &executor,
        harness,
        "memory-relation-add",
        "memory_add_relation",
        json!({
            "note_id_a": note_a_after_undo.id,
            "note_id_b": note_b_current.id,
            "expected_updated_at_a": note_a_after_undo.updated_at,
            "expected_updated_at_b": note_b_current.updated_at
        }),
    )
    .await;
    let relation_output = assert_success(&relation_add);
    assert_eq!(relation_output["changed"], true);
    assert_eq!(relation_output["reversible"], true);
    assert_eq!(
        relation_output["undo"]["tool"],
        "builtin-memory_remove_relation"
    );
    assert_eq!(
        relation_output["note_a"]["related_note_ids"],
        json!([note_b_current.id])
    );
    assert_eq!(
        relation_output["note_b"]["related_note_ids"],
        json!([note_a_after_undo.id])
    );
    let relation_event =
        wait_for_memory_event(&events, "add_relation", "memory-relation-add").await;
    assert_eq!(
        relation_event["entityIds"],
        json!([note_a_after_undo.id, note_b_current.id])
    );

    let persisted_a = VfsNoteRepo::get_note(&harness.vfs_db, &note_a_after_undo.id)
        .expect("read related note A")
        .expect("related note A exists");
    let persisted_b = VfsNoteRepo::get_note(&harness.vfs_db, &note_b_current.id)
        .expect("read related note B")
        .expect("related note B exists");
    assert!(persisted_a
        .tags
        .contains(&format!("_ref:{}", note_b_current.id)));
    assert!(persisted_b
        .tags
        .contains(&format!("_ref:{}", note_a_after_undo.id)));

    let relation_undo = execute_tool(
        &executor,
        harness,
        "memory-relation-undo",
        relation_output["undo"]["tool"]
            .as_str()
            .expect("relation undo tool"),
        json!({
            "note_id_a": relation_output["undo"]["note_id_a"],
            "note_id_b": relation_output["undo"]["note_id_b"],
            "expected_updated_at_a": relation_output["undo"]["expected_updated_at_a"],
            "expected_updated_at_b": relation_output["undo"]["expected_updated_at_b"]
        }),
    )
    .await;
    let relation_undo_output = assert_success(&relation_undo);
    assert_eq!(relation_undo_output["changed"], true);
    assert_eq!(
        relation_undo_output["undo"]["tool"],
        "builtin-memory_add_relation"
    );
    wait_for_memory_event(&events, "remove_relation", "memory-relation-undo").await;

    let restored_a = VfsNoteRepo::get_note(&harness.vfs_db, &note_a_after_undo.id)
        .expect("read relation-restored note A")
        .expect("relation-restored note A exists");
    let restored_b = VfsNoteRepo::get_note(&harness.vfs_db, &note_b_current.id)
        .expect("read relation-restored note B")
        .expect("relation-restored note B exists");
    assert!(!restored_a
        .tags
        .contains(&format!("_ref:{}", note_b_current.id)));
    assert!(!restored_b
        .tags
        .contains(&format!("_ref:{}", note_a_after_undo.id)));
}

fn main() {
    println!("running 2 tests");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build phase 8/9 current-thread runtime");
    runtime.block_on(async {
        let harness = create_harness();
        textbook_annotations_use_real_occ_persistence_and_events(&harness).await;
        println!("test textbook_annotations_use_real_occ_persistence_and_events ... ok");
        memory_tags_and_relations_expose_occ_inverse_and_events(&harness).await;
        println!("test memory_tags_and_relations_expose_occ_inverse_and_events ... ok");
    });
    println!("\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
}
