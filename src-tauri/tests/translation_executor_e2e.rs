use std::sync::{Arc, Mutex};
use std::time::Duration;

use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::tools::{ExecutionContext, ToolExecutor, TranslationToolExecutor};
use deep_student_lib::chat_v2::types::{ToolCall, ToolResultInfo};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::database::Database;
use deep_student_lib::file_manager::FileManager;
use deep_student_lib::llm_manager::{LLMManager, ModelProfile, VendorConfig};
use deep_student_lib::models::ModelAssignments;
use deep_student_lib::tools::ToolRegistry;
use deep_student_lib::vfs::repos::{VfsFolderRepo, VfsTranslationRepo};
use deep_student_lib::vfs::{VfsDatabase, VfsFolder};
use mockito::{Request, Server};
use serde_json::{json, Value};
use tauri::Listener;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

const SESSION_ID: &str = "translation-executor-e2e-session";

#[derive(Clone, Default)]
struct FakeTranslationServerState {
    requests: Arc<Mutex<Vec<Value>>>,
    cancellation: Arc<Mutex<Option<CancellationToken>>>,
}

impl FakeTranslationServerState {
    fn request_count(&self) -> usize {
        self.requests
            .lock()
            .expect("lock fake translation requests")
            .len()
    }

    fn requests_since(&self, start: usize) -> Vec<Value> {
        self.requests
            .lock()
            .expect("lock fake translation requests")
            .iter()
            .skip(start)
            .cloned()
            .collect()
    }

    fn set_cancellation(&self, token: Option<CancellationToken>) {
        *self
            .cancellation
            .lock()
            .expect("lock fake cancellation token") = token;
    }
}

struct ExecutorHarness {
    _app: tauri::App,
    _main_dir: TempDir,
    _vfs_dir: TempDir,
    main_db: Arc<Database>,
    vfs_db: Arc<VfsDatabase>,
    llm_manager: Arc<LLMManager>,
    window: tauri::Window,
}

fn request_json(request: &Request) -> Value {
    serde_json::from_slice(request.body().expect("translation request body"))
        .expect("translation request must be JSON")
}

fn request_user_prompt(request: &Request) -> String {
    request_json(request)["messages"][1]["content"]
        .as_str()
        .expect("translation user prompt")
        .to_string()
}

fn openai_sse(chunks: &[&str]) -> Vec<u8> {
    let mut body = String::new();
    for content in chunks {
        let data = json!({
            "choices": [{
                "index": 0,
                "delta": {"content": content},
                "finish_reason": null
            }]
        });
        body.push_str(&format!("data: {data}\n\n"));
    }
    body.push_str("data: [DONE]\n\n");
    body.into_bytes()
}

async fn install_fake_translation_endpoint(
    server: &mut Server,
    state: FakeTranslationServerState,
) -> mockito::Mock {
    let status_state = state.clone();
    let body_state = state;
    server
        .mock("POST", "/chat/completions")
        .with_header("content-type", "text/event-stream")
        .with_status_code_from_request(move |request| {
            let payload = request_json(request);
            let prompt = payload["messages"][1]["content"]
                .as_str()
                .expect("translation user prompt");
            let should_fail = prompt.contains("FAIL_SEGMENT");
            status_state
                .requests
                .lock()
                .expect("record fake translation request")
                .push(payload);
            if should_fail {
                500
            } else {
                200
            }
        })
        .with_body_from_request(move |request| {
            let prompt = request_user_prompt(request);

            if prompt.contains("CANCEL_FIRST") {
                if let Some(token) = body_state
                    .cancellation
                    .lock()
                    .expect("read fake cancellation token")
                    .as_ref()
                {
                    token.cancel();
                }
            }

            let translated_chunks: &[&str] = if prompt.contains("NORMAL_FIRST") {
                &["FI", "RST"]
            } else if prompt.contains("NORMAL_SECOND") {
                &["SEC", "OND"]
            } else if prompt.contains("PARTIAL_FIRST") {
                &["PAR", "TIAL"]
            } else if prompt.contains("CANCEL_FIRST") {
                &["CANCELLED", "_PART"]
            } else {
                &["FAKE_", "TRANSLATION"]
            };
            openai_sse(translated_chunks)
        })
        .create_async()
        .await
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

async fn create_harness(base_url: &str) -> ExecutorHarness {
    let (vfs_dir, vfs_db) = create_vfs_db();
    let main_dir = TempDir::new().expect("create main database temp directory");
    let mut coordinator =
        MigrationCoordinator::new(main_dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("apply production main-database migrations");
    let main_db = Arc::new(
        Database::new(&main_dir.path().join("mistakes.db")).expect("open migrated main database"),
    );
    let app_data_dir = main_dir.path().join("app-data");
    std::fs::create_dir_all(&app_data_dir).expect("create app data directory");
    let file_manager = Arc::new(FileManager::new(app_data_dir).expect("create file manager"));
    let llm_manager =
        Arc::new(LLMManager::new(main_db.clone(), file_manager).expect("create test LLM manager"));

    let vendor_id = "translation-fake-vendor".to_string();
    let model_id = "translation-fake-model".to_string();
    llm_manager
        .save_vendor_model_configs(
            &[VendorConfig {
                id: vendor_id.clone(),
                name: "Translation Fake Vendor".to_string(),
                provider_type: "openai".to_string(),
                api_protocol: Some("openai_chat_completions".to_string()),
                supports_openai_responses: Some(false),
                base_url: base_url.to_string(),
                api_key: "translation-test-key".to_string(),
                ..VendorConfig::default()
            }],
            &[ModelProfile {
                id: model_id.clone(),
                vendor_id,
                label: "Translation Fake Model".to_string(),
                model: "translation-fake".to_string(),
                provider_scope: Some("openai".to_string()),
                api_protocol: Some("openai_chat_completions".to_string()),
                model_adapter: "general".to_string(),
                enabled: true,
                max_output_tokens: 4096,
                ..ModelProfile::default()
            }],
        )
        .await
        .expect("save fake translation model configuration");
    llm_manager
        .save_model_assignments(&ModelAssignments {
            translation_model_config_id: Some(model_id),
            ..ModelAssignments::default()
        })
        .await
        .expect("assign fake translation model");

    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("build Tauri translation test app");
    let webview = tauri::WebviewWindowBuilder::new(
        &app,
        "translation-executor-e2e",
        tauri::WebviewUrl::default(),
    )
    .build()
    .expect("build Tauri translation test window");
    let window = webview.as_ref().window();

    ExecutorHarness {
        _app: app,
        _main_dir: main_dir,
        _vfs_dir: vfs_dir,
        main_db,
        vfs_db,
        llm_manager,
        window,
    }
}

fn execution_context(
    harness: &ExecutorHarness,
    block_id: &str,
    cancellation: Option<CancellationToken>,
) -> ExecutionContext {
    let emitter = Arc::new(ChatV2EventEmitter::new(
        harness.window.clone(),
        SESSION_ID.to_string(),
    ));
    let mut context = ExecutionContext::new(
        SESSION_ID.to_string(),
        "translation-executor-e2e-message".to_string(),
        block_id.to_string(),
        emitter,
        Arc::new(ToolRegistry::new()),
        Some(harness.window.clone()),
    )
    .with_main_db(Some(harness.main_db.clone()))
    .with_vfs_db(Some(harness.vfs_db.clone()))
    .with_llm_manager(Some(harness.llm_manager.clone()));
    if let Some(cancellation) = cancellation {
        context = context.with_cancellation_token(cancellation);
    }
    context
}

async fn execute_tool(
    harness: &ExecutorHarness,
    call_id: &str,
    tool_name: &str,
    arguments: Value,
    cancellation: Option<CancellationToken>,
) -> ToolResultInfo {
    TranslationToolExecutor::new()
        .execute(
            &ToolCall::new(call_id.to_string(), tool_name.to_string(), arguments),
            &execution_context(harness, &format!("block-{call_id}"), cancellation),
        )
        .await
        .expect("translation executor returns ToolResultInfo")
}

fn error_code(result: &ToolResultInfo) -> String {
    assert!(!result.success, "call unexpectedly succeeded: {result:?}");
    let error: Value = serde_json::from_str(
        result
            .error
            .as_deref()
            .expect("failed translation result includes error"),
    )
    .expect("translation error is structured JSON");
    error["code"]
        .as_str()
        .expect("translation error code")
        .to_string()
}

fn message_content(request: &Value, index: usize) -> &str {
    request["messages"][index]["content"]
        .as_str()
        .expect("request message content")
}

fn normal_segmented_source() -> String {
    format!(
        "NORMAL_FIRST{}\n\nNORMAL_SECOND{}",
        "A".repeat(59_980),
        "B".repeat(60_000)
    )
}

fn two_hard_segments(first_marker: &str, second_marker: &str) -> String {
    let first_padding = 100_000usize.saturating_sub(first_marker.chars().count());
    format!("{first_marker}{}{second_marker}", "X".repeat(first_padding))
}

async fn translation_executor_real_pipeline_and_save_workflow() {
    let state = FakeTranslationServerState::default();
    let mut server = Server::new_async().await;
    let _translation_mock = install_fake_translation_endpoint(&mut server, state.clone()).await;
    let harness = create_harness(&server.url()).await;

    let source = normal_segmented_source();
    let normal_request_start = state.request_count();
    let translated = execute_tool(
        &harness,
        "translate-segmented",
        "builtin-translate_text",
        json!({
            "text": source,
            "source_lang": "en",
            "target_lang": "zh-CN",
            "formality": "formal",
            "domain": "academic",
            "terms": [{"src": "agent", "dst": "智能体"}]
        }),
        None,
    )
    .await;
    assert!(translated.success, "{:?}", translated.error);
    assert_eq!(translated.output["segment_count"], 2);
    assert_eq!(translated.output["translated"], "FIRSTSECOND");
    assert_eq!(translated.output["translated_truncated"], false);
    let result_id = translated.output["translation_result_id"]
        .as_str()
        .expect("cached translation result id")
        .to_string();

    let normal_requests = state.requests_since(normal_request_start);
    assert_eq!(normal_requests.len(), 2);
    for request in &normal_requests {
        assert_eq!(request["model"], "translation-fake");
        assert_eq!(request["stream"], true);
        assert_eq!(request["temperature"], 0.3);
        assert_eq!(request["max_tokens"], 4096);
        assert_eq!(request["messages"].as_array().map(Vec::len), Some(2));
        assert_eq!(request["messages"][0]["role"], "system");
        assert_eq!(request["messages"][1]["role"], "user");
        let system = message_content(request, 0);
        let user = message_content(request, 1);
        assert!(system.contains("academic translator"));
        assert!(system.contains("formal, polite language"));
        assert!(system.contains("\"agent\" → \"智能体\""));
        assert!(user.contains("from English to Simplified Chinese"));
    }
    assert!(message_content(&normal_requests[0], 1).contains("NORMAL_FIRST"));
    assert!(message_content(&normal_requests[1], 1).contains("NORMAL_SECOND"));

    let folder = VfsFolder::new("Saved translations".to_string(), None, None, None);
    VfsFolderRepo::create_folder(&harness.vfs_db, &folder)
        .expect("create translation destination folder");

    let invalid_folder = execute_tool(
        &harness,
        "save-invalid-folder",
        "builtin-translation_save",
        json!({
            "translation_result_id": result_id,
            "title": "Segmented translation",
            "folder_id": "fld_missing_translation_target"
        }),
        None,
    )
    .await;
    assert_eq!(error_code(&invalid_folder), "FOLDER_NOT_FOUND");

    let (event_tx, event_rx) = tokio::sync::oneshot::channel();
    let event_tx = Arc::new(Mutex::new(Some(event_tx)));
    let listener_id = harness.window.listen("dstu:change", move |event| {
        if let Some(sender) = event_tx
            .lock()
            .expect("lock translation event sender")
            .take()
        {
            let _ = sender.send(event.payload().to_string());
        }
    });
    let saved = execute_tool(
        &harness,
        "save-cached",
        "builtin-translation_save",
        json!({
            "translation_result_id": result_id,
            "title": "Segmented translation",
            "folder_id": folder.id,
            "engine": "fake-sse",
            "model": "translation-fake"
        }),
        None,
    )
    .await;
    assert!(saved.success, "{:?}", saved.error);
    assert_eq!(saved.output["source_mode"], "cached_result");
    assert_eq!(saved.output["translation_result_consumed"], true);
    assert_eq!(saved.output["folder_id"], folder.id);
    assert_eq!(saved.output["reversible"], true);
    assert_eq!(saved.output["undo"]["tool_name"], "builtin-dstu_delete");
    assert_eq!(
        saved.output["undo"]["arguments"]["path"],
        saved.output["path"]
    );

    let event: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(2), event_rx)
            .await
            .expect("translation save event timeout")
            .expect("translation save emits dstu:change"),
    )
    .expect("DSTU event payload is JSON");
    harness.window.unlisten(listener_id);
    assert_eq!(event["type"], "created");
    assert_eq!(event["path"], saved.output["path"]);
    assert_eq!(event["node"]["id"], saved.output["translation_id"]);
    assert_eq!(event["node"]["metadata"]["sourceText"], Value::Null);
    assert_eq!(event["node"]["metadata"]["translatedText"], Value::Null);
    let serialized_event = event.to_string();
    assert!(!serialized_event.contains("NORMAL_FIRST"));
    assert!(!serialized_event.contains("FIRSTSECOND"));

    let translation_id = saved.output["translation_id"]
        .as_str()
        .expect("saved translation id");
    let persisted = VfsTranslationRepo::get_translation(&harness.vfs_db, translation_id)
        .expect("read saved translation")
        .expect("cached translation persisted");
    assert_eq!(persisted.source_text.as_deref(), Some(source.as_str()));
    assert_eq!(persisted.translated_text.as_deref(), Some("FIRSTSECOND"));
    assert_eq!(persisted.src_lang, "en");
    assert_eq!(persisted.tgt_lang, "zh-CN");
    let resource_data: String = harness
        .vfs_db
        .get_conn_safe()
        .expect("open VFS connection")
        .query_row(
            "SELECT data FROM resources WHERE id = ?1",
            rusqlite::params![persisted.resource_id],
            |row| row.get(0),
        )
        .expect("read translation SSOT resource data");
    let resource_content: Value =
        serde_json::from_str(&resource_data).expect("translation resource data is JSON");
    assert_eq!(resource_content["source"], source);
    assert_eq!(resource_content["translated"], "FIRSTSECOND");
    let folder_item =
        VfsFolderRepo::get_folder_item_by_item_id(&harness.vfs_db, "translation", translation_id)
            .expect("read translation folder item")
            .expect("translation assigned to folder");
    assert_eq!(folder_item.folder_id.as_deref(), Some(folder.id.as_str()));

    let consumed = execute_tool(
        &harness,
        "save-consumed",
        "builtin-translation_save",
        json!({"translation_result_id": result_id}),
        None,
    )
    .await;
    assert_eq!(error_code(&consumed), "TRANSLATION_RESULT_NOT_FOUND");
    let missing = execute_tool(
        &harness,
        "save-missing",
        "builtin-translation_save",
        json!({"translation_result_id": "translation_result_missing"}),
        None,
    )
    .await;
    assert_eq!(error_code(&missing), "TRANSLATION_RESULT_NOT_FOUND");

    let inline = execute_tool(
        &harness,
        "save-inline",
        "builtin-translation_save",
        json!({
            "source": "Inline source",
            "translated": "内联译文",
            "source_lang": "en",
            "target_lang": "zh-CN",
            "title": "Inline translation",
            "folder_id": folder.id
        }),
        None,
    )
    .await;
    assert!(inline.success, "{:?}", inline.error);
    assert_eq!(inline.output["source_mode"], "inline");
    assert_eq!(inline.output["translation_result_consumed"], false);
    assert_eq!(inline.output["reversible"], true);
    let inline_id = inline.output["translation_id"]
        .as_str()
        .expect("inline translation id");
    let inline_persisted = VfsTranslationRepo::get_translation(&harness.vfs_db, inline_id)
        .expect("read inline translation")
        .expect("inline translation persisted");
    assert_eq!(
        inline_persisted.source_text.as_deref(),
        Some("Inline source")
    );
    assert_eq!(
        inline_persisted.translated_text.as_deref(),
        Some("内联译文")
    );
    let inline_folder_item =
        VfsFolderRepo::get_folder_item_by_item_id(&harness.vfs_db, "translation", inline_id)
            .expect("read inline translation folder item")
            .expect("inline translation assigned to folder");
    assert_eq!(
        inline_folder_item.folder_id.as_deref(),
        Some(folder.id.as_str())
    );

    let partial_source = two_hard_segments("PARTIAL_FIRST", "FAIL_SEGMENT");
    let partial_start = state.request_count();
    let partial = execute_tool(
        &harness,
        "translate-partial-failure",
        "builtin-translate_text",
        json!({
            "text": partial_source,
            "source_lang": "en",
            "target_lang": "zh-CN"
        }),
        None,
    )
    .await;
    assert_eq!(error_code(&partial), "TRANSLATION_FAILED");
    let partial_requests = state.requests_since(partial_start);
    assert_eq!(partial_requests.len(), 2);
    assert!(message_content(&partial_requests[0], 1).contains("PARTIAL_FIRST"));
    assert!(message_content(&partial_requests[1], 1).contains("FAIL_SEGMENT"));
    assert!(partial.output.get("translation_result_id").is_none());

    let pre_cancelled_token = CancellationToken::new();
    pre_cancelled_token.cancel();
    let pre_cancel_start = state.request_count();
    let pre_cancelled = execute_tool(
        &harness,
        "translate-pre-cancelled",
        "builtin-translate_text",
        json!({
            "text": "This request must never reach the fake model.",
            "source_lang": "en",
            "target_lang": "zh-CN"
        }),
        Some(pre_cancelled_token),
    )
    .await;
    assert_eq!(error_code(&pre_cancelled), "TRANSLATION_CANCELLED");
    assert_eq!(state.request_count(), pre_cancel_start);
    assert!(pre_cancelled.output.get("translation_result_id").is_none());

    let cancellation = CancellationToken::new();
    state.set_cancellation(Some(cancellation.clone()));
    let cancel_source = two_hard_segments("CANCEL_FIRST", "CANCEL_SECOND");
    let cancel_start = state.request_count();
    let cancelled = execute_tool(
        &harness,
        "translate-cancelled-between-segments",
        "builtin-translate_text",
        json!({
            "text": cancel_source,
            "source_lang": "en",
            "target_lang": "zh-CN"
        }),
        Some(cancellation),
    )
    .await;
    state.set_cancellation(None);
    assert_eq!(error_code(&cancelled), "TRANSLATION_CANCELLED");
    let cancelled_requests = state.requests_since(cancel_start);
    assert_eq!(cancelled_requests.len(), 1);
    assert!(message_content(&cancelled_requests[0], 1).contains("CANCEL_FIRST"));
    assert!(cancelled.output.get("translation_result_id").is_none());
}

fn main() {
    println!("running 1 test");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build Tokio translation executor test runtime");
    runtime.block_on(translation_executor_real_pipeline_and_save_workflow());
    println!("test translation_executor_real_pipeline_and_save_workflow ... ok");
    println!("\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
}
