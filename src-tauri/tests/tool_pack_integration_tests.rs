use deep_student_lib::chat_v2::database::ChatV2Database;
use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::tools::{
    AskUserExecutor, ExecutionContext, GeneralToolExecutor, SessionToolExecutor,
    TemplateDesignerExecutor, ToolExecutor, ToolExecutorRegistry, ToolPackExecutor,
    UserTodoExecutor,
};
use deep_student_lib::chat_v2::types::{ToolCall, ToolResultInfo};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::tools::ToolRegistry;
use deep_student_lib::vfs::VfsDatabase;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Instant;
use tokio::sync::Notify;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

struct ToolPackTestHarness {
    _app: tauri::App,
    registry: Arc<ToolExecutorRegistry>,
    context: ExecutionContext,
}

fn create_default_runtime_window(label: &str) -> (tauri::App, tauri::Window) {
    // Tauri 2.10 does not expose tauri::test::mock_context / noop_assets to
    // dependency integration tests unless the dependency feature is enabled.
    // Use the crate context and public WebviewWindowBuilder default runtime.
    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("failed to build default-runtime tauri app");
    let webview_window =
        tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
            .build()
            .expect("failed to build default-runtime window");
    let window = webview_window.as_ref().window();
    (app, window)
}

fn create_tool_pack_registry() -> Arc<ToolExecutorRegistry> {
    Arc::new_cyclic(|weak| {
        ToolExecutorRegistry::from_vec(vec![
            Arc::new(TemplateDesignerExecutor::new()) as Arc<dyn ToolExecutor>,
            Arc::new(SessionToolExecutor::new()),
            Arc::new(UserTodoExecutor::new()),
            Arc::new(AskUserExecutor::new()),
            Arc::new(ToolPackExecutor::new(weak.clone())),
            Arc::new(GeneralToolExecutor::new()),
        ])
    })
}

fn create_execution_context(
    block_id: &str,
    registry: Arc<ToolExecutorRegistry>,
) -> ToolPackTestHarness {
    let (app, window) = create_default_runtime_window("tool-pack-test");
    let emitter = Arc::new(ChatV2EventEmitter::new(
        window.clone(),
        "phase-3-session".to_string(),
    ));
    let context = ExecutionContext::new(
        "phase-3-session".to_string(),
        "phase-3-message".to_string(),
        block_id.to_string(),
        emitter,
        Arc::new(ToolRegistry::new()),
        Some(window),
    )
    .with_feature_flags(true, true, true);

    ToolPackTestHarness {
        _app: app,
        registry,
        context,
    }
}

struct Phase3ConcurrencyProbeExecutor {
    started: Arc<AtomicUsize>,
    in_flight: Arc<AtomicUsize>,
    max_in_flight: Arc<AtomicUsize>,
    started_ten: Arc<Notify>,
    released: Arc<AtomicBool>,
    release: Arc<Notify>,
}

#[async_trait::async_trait]
impl ToolExecutor for Phase3ConcurrencyProbeExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "builtin-phase3_concurrency_probe"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        _ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let current_started = self.started.fetch_add(1, Ordering::SeqCst) + 1;
        let current_in_flight = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;

        let mut observed = self.max_in_flight.load(Ordering::SeqCst);
        while current_in_flight > observed {
            match self.max_in_flight.compare_exchange(
                observed,
                current_in_flight,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(next) => observed = next,
            }
        }

        if current_started >= 10 {
            self.started_ten.notify_waiters();
        }

        loop {
            let release_notified = self.release.notified();
            if self.released.load(Ordering::SeqCst) {
                break;
            }
            release_notified.await;
        }
        self.in_flight.fetch_sub(1, Ordering::SeqCst);

        Ok(ToolResultInfo::success(
            Some(call.id.clone()),
            None,
            call.name.clone(),
            call.arguments.clone(),
            json!({"phase3": "concurrency_probe"}),
            1,
        ))
    }

    fn name(&self) -> &'static str {
        "Phase3ConcurrencyProbeExecutor"
    }
}

struct Phase3FastSuccessExecutor {
    fast_completed: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

#[async_trait::async_trait]
impl ToolExecutor for Phase3FastSuccessExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "builtin-phase3_fast_success"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        _ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        self.fast_completed.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();

        Ok(ToolResultInfo::success(
            Some(call.id.clone()),
            None,
            call.name.clone(),
            call.arguments.clone(),
            json!({"phase3": "fast_success"}),
            1,
        ))
    }

    fn name(&self) -> &'static str {
        "Phase3FastSuccessExecutor"
    }
}

struct Phase3SlowCancelExecutor;

#[async_trait::async_trait]
impl ToolExecutor for Phase3SlowCancelExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "builtin-phase3_slow_cancel"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.cancellation_token()
            .expect("slow cancel executor requires cancellation token")
            .cancelled()
            .await;

        Ok(ToolResultInfo::cancelled(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            start.elapsed().as_millis() as u64,
        ))
    }

    fn name(&self) -> &'static str {
        "Phase3SlowCancelExecutor"
    }
}

struct Phase3NeverCompletesExecutor;

#[async_trait::async_trait]
impl ToolExecutor for Phase3NeverCompletesExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "builtin-phase3_never_finishes"
    }

    async fn execute(
        &self,
        _call: &ToolCall,
        _ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        std::future::pending::<Result<ToolResultInfo, String>>().await
    }

    fn name(&self) -> &'static str {
        "Phase3NeverCompletesExecutor"
    }
}

fn create_concurrency_registry(
    started: Arc<AtomicUsize>,
    in_flight: Arc<AtomicUsize>,
    max_in_flight: Arc<AtomicUsize>,
    started_ten: Arc<Notify>,
    released: Arc<AtomicBool>,
    release: Arc<Notify>,
) -> Arc<ToolExecutorRegistry> {
    Arc::new_cyclic(|weak| {
        ToolExecutorRegistry::from_vec(vec![
            Arc::new(Phase3ConcurrencyProbeExecutor {
                started,
                in_flight,
                max_in_flight,
                started_ten,
                released,
                release,
            }) as Arc<dyn ToolExecutor>,
            Arc::new(ToolPackExecutor::new(weak.clone())),
            Arc::new(GeneralToolExecutor::new()),
        ])
    })
}

fn create_cancellation_registry(
    fast_completed: Arc<AtomicBool>,
    notify: Arc<Notify>,
) -> Arc<ToolExecutorRegistry> {
    Arc::new_cyclic(|weak| {
        ToolExecutorRegistry::from_vec(vec![
            Arc::new(Phase3FastSuccessExecutor {
                fast_completed,
                notify,
            }) as Arc<dyn ToolExecutor>,
            Arc::new(Phase3SlowCancelExecutor),
            Arc::new(ToolPackExecutor::new(weak.clone())),
            Arc::new(GeneralToolExecutor::new()),
        ])
    })
}

fn create_timeout_registry(
    fast_completed: Arc<AtomicBool>,
    notify: Arc<Notify>,
) -> Arc<ToolExecutorRegistry> {
    Arc::new_cyclic(|weak| {
        ToolExecutorRegistry::from_vec(vec![
            Arc::new(Phase3FastSuccessExecutor {
                fast_completed,
                notify,
            }) as Arc<dyn ToolExecutor>,
            Arc::new(Phase3NeverCompletesExecutor),
            Arc::new(ToolPackExecutor::new(weak.clone())),
            Arc::new(GeneralToolExecutor::new()),
        ])
    })
}

fn create_chat_v2_db() -> (tempfile::TempDir, Arc<ChatV2Database>) {
    let temp_dir = tempfile::TempDir::new().expect("failed to create Chat V2 temp dir");
    let mut coordinator =
        MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::ChatV2)
        .expect("Chat V2 migrations should apply cleanly");
    let db = ChatV2Database::new(temp_dir.path()).expect("failed to create Chat V2 database");
    (temp_dir, Arc::new(db))
}

fn create_vfs_db() -> (tempfile::TempDir, Arc<VfsDatabase>) {
    let temp_dir = tempfile::TempDir::new().expect("failed to create VFS temp dir");
    let mut coordinator =
        MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Vfs)
        .expect("VFS migrations should apply cleanly");
    let db = VfsDatabase::new(temp_dir.path()).expect("failed to create VFS database");
    (temp_dir, Arc::new(db))
}

fn valid_template_fixture() -> Value {
    json!({
        "name": "Phase 3 Valid Template",
        "noteType": "Basic",
        "fields": ["Front", "Back"],
        "frontTemplate": "{{Front}}",
        "backTemplate": "{{Back}}",
        "cssStyle": ".card { font-family: arial; }",
        "generationPrompt": "Create a concise study card.",
        "fieldExtractionRules": {
            "Front": {
                "field_type": "Text",
                "is_required": true,
                "description": "Question side"
            },
            "Back": {
                "field_type": "Text",
                "is_required": true,
                "description": "Answer side"
            }
        }
    })
}

fn create_user_todo_create_tools(prefix: &str) -> Vec<Value> {
    (0..20)
        .map(|i| {
            json!({
                "name": "builtin-user_todo_create_item",
                "args": {
                    "title": format!("{}-{}", prefix, i),
                    "priority": "none"
                }
            })
        })
        .collect()
}

fn assert_no_sqlite_lock_errors(results: &[Value]) {
    for item in results {
        let error = item["error"].as_str().unwrap_or_default().to_lowercase();
        assert!(
            !error.contains("database is locked"),
            "unexpected SQLite lock error in result: {}",
            item
        );
        assert!(
            !error.contains("sqlite_busy"),
            "unexpected SQLITE_BUSY error in result: {}",
            item
        );
        assert!(
            !error.contains("database table is locked"),
            "unexpected SQLite table lock error in result: {}",
            item
        );
    }
}

fn tool_pack_call(arguments: Value) -> ToolCall {
    ToolCall::new(
        "phase-3-pack-call".to_string(),
        "builtin-tool_pack".to_string(),
        arguments,
    )
}

#[tokio::test]
async fn tool_pack_harness_constructs_execution_context() {
    let registry = create_tool_pack_registry();
    let harness = create_execution_context("harness-block", registry.clone());

    assert_eq!(harness.context.session_id, "phase-3-session");
    assert_eq!(harness.context.message_id, "phase-3-message");
    assert_eq!(harness.context.block_id, "harness-block");
    assert_eq!(harness.context.window_ref().label(), "tool-pack-test");
    assert_eq!(harness.context.emitter.session_id(), "phase-3-session");
    assert!(harness.registry.has_specific_executor("builtin-tool_pack"));
}

#[test]
fn tool_pack_selected_real_subtools_shared_state_audit_matches_allowed_paths() {
    let template_source = include_str!("../src/chat_v2/tools/template_executor.rs");
    let session_source = include_str!("../src/chat_v2/tools/session_executor.rs");
    let user_todo_source = include_str!("../src/chat_v2/tools/user_todo_executor.rs");
    let tool_pack_source = include_str!("../src/chat_v2/tools/tool_pack_executor.rs");
    let executor_source = include_str!("../src/chat_v2/tools/executor.rs");

    assert!(user_todo_source.contains("VfsTodoRepo::create_todo_item"));
    assert!(session_source.contains("ChatV2Database") || session_source.contains("chat_v2_db"));
    assert!(executor_source.contains("save_tool_block"));
    assert!(
        template_source.contains("emit_tool_call")
            || session_source.contains("emit_tool_call")
            || user_todo_source.contains("emit_tool_call")
    );
    assert!(user_todo_source.contains("emit_todo_changed"));
    assert!(tool_pack_source.contains("ToolExecutorRegistry"));
    assert!(tool_pack_source.contains("registry_clone.execute"));

    let selected_sources = [
        ("template_executor.rs", template_source),
        ("session_executor.rs", session_source),
        ("user_todo_executor.rs", user_todo_source),
    ];
    let forbidden_patterns = [
        "AppState",
        ".state::<",
        "Mutex<",
        "RwLock<",
        ".lock().await",
        "blocking_lock",
        "std::sync::Mutex",
        "tokio::sync::Mutex",
    ];

    for (label, source) in selected_sources {
        for pattern in forbidden_patterns {
            assert!(
                !source.contains(pattern),
                "{label} contains forbidden shared-lock pattern {pattern}"
            );
        }
    }
}

#[tokio::test]
async fn tool_pack_executes_real_builtin_tools_and_returns_one_aggregate() {
    let registry = create_tool_pack_registry();
    let (_temp_dir, chat_v2_db) = create_chat_v2_db();
    let mut harness = create_execution_context("parent-block", registry.clone());
    harness.context = harness.context.with_chat_v2_db(Some(chat_v2_db));
    let call = tool_pack_call(json!({
        "tools": [
            {
                "name": "builtin-template_validate",
                "args": { "template": valid_template_fixture() }
            },
            {
                "name": "builtin-session_list",
                "args": { "limit": 5, "include_tags": false }
            }
        ]
    }));

    let result = registry
        .execute(&call, &harness.context)
        .await
        .expect("valid real built-in pack should return aggregate result");

    assert!(result.success);
    assert_eq!(result.tool_name, "builtin-tool_pack");
    assert_eq!(result.output["succeeded"], 2);
    assert_eq!(result.output["failed"], 0);

    let results = result.output["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|item| !item["duration_ms"].is_null()));
    assert!(results.iter().all(|item| !item["block_id"].is_null()));
    assert!(results.iter().any(|item| {
        item["tool_name"] == "builtin-template_validate"
            && item["success"] == true
            && item["output"]["valid"] == true
    }));
    assert!(results.iter().any(|item| {
        item["tool_name"] == "builtin-session_list"
            && item["success"] == true
            && item["output"]["sessions"].is_array()
    }));

    let block_ids: Vec<&str> = results
        .iter()
        .filter_map(|item| item["block_id"].as_str())
        .collect();
    assert!(block_ids.contains(&"parent-block-tool_pack-0"));
    assert!(block_ids.contains(&"parent-block-tool_pack-1"));
}

#[tokio::test]
async fn tool_pack_mixed_success_failure_preserves_successful_results() {
    let registry = create_tool_pack_registry();
    let harness = create_execution_context("mixed-pack", registry.clone());
    let call = tool_pack_call(json!({
        "tools": [
            {
                "name": "builtin-template_validate",
                "args": { "template": valid_template_fixture() }
            },
            {
                "name": "builtin-template_validate",
                "args": {}
            }
        ]
    }));

    let result = registry
        .execute(&call, &harness.context)
        .await
        .expect("registered sub-tool runtime failure should return aggregate result");

    assert!(result.success);
    assert_eq!(result.output["succeeded"], 1);
    assert_eq!(result.output["failed"], 1);

    let results = result.output["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert!(results.iter().any(|item| {
        item["tool_name"] == "builtin-template_validate" && item["success"] == true
    }));
    assert!(results.iter().any(|item| {
        item["tool_name"] == "builtin-template_validate"
            && item["success"] == false
            && item["error"]
                .as_str()
                .map(|error| !error.is_empty())
                .unwrap_or(false)
    }));
}

#[tokio::test]
async fn tool_pack_blocks_sensitive_subtool_without_bypassing_approval() {
    let registry = create_tool_pack_registry();
    let harness = create_execution_context("sensitive-pack", registry.clone());
    let call = tool_pack_call(json!({
        "tools": [
            {
                "name": "builtin-template_delete",
                "args": { "templateId": "phase-3-sensitive" }
            }
        ]
    }));

    let result = registry
        .execute(&call, &harness.context)
        .await
        .expect("sensitive sub-tool should be blocked inside aggregate result");

    assert!(result.success);
    assert_eq!(result.output["succeeded"], 0);
    assert_eq!(result.output["failed"], 1);

    let results = result.output["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    let failed = &results[0];
    assert_eq!(failed["tool_name"], "builtin-template_delete");
    assert_eq!(failed["success"], false);
    assert!(failed["output"].is_null());
    assert!(failed["error"]
        .as_str()
        .unwrap_or_default()
        .contains("requires user approval"));
}

#[tokio::test]
async fn tool_pack_vfs_write_load_does_not_surface_sqlite_busy_or_database_locked() {
    let registry = create_tool_pack_registry();
    let (_vfs_temp_dir, vfs_db) = create_vfs_db();
    let (_chat_temp_dir, chat_v2_db) = create_chat_v2_db();
    let mut harness = create_execution_context("write-pack", registry.clone());
    harness.context = harness.context.with_vfs_db(Some(vfs_db));
    harness.context = harness.context.with_chat_v2_db(Some(chat_v2_db));
    let call = tool_pack_call(json!({
        "timeout": 30,
        "tools": create_user_todo_create_tools("phase-3-write")
    }));

    let result = registry
        .execute(&call, &harness.context)
        .await
        .expect("write-heavy pack should return aggregate result");

    assert!(result.success);
    assert_eq!(result.output["succeeded"], 20);
    assert_eq!(result.output["failed"], 0);

    let results = result.output["results"].as_array().unwrap();
    assert_eq!(results.len(), 20);
    assert_no_sqlite_lock_errors(results);

    let block_ids: Vec<&str> = results
        .iter()
        .filter_map(|item| item["block_id"].as_str())
        .collect();
    assert!(block_ids.contains(&"write-pack-tool_pack-0"));
    assert!(block_ids.contains(&"write-pack-tool_pack-19"));

    let _keep_app_alive = &harness._app;
}

#[tokio::test]
async fn tool_pack_repeated_vfs_write_load_remains_free_of_sqlite_lock_errors() {
    let registry = create_tool_pack_registry();
    let (_vfs_temp_dir, vfs_db) = create_vfs_db();
    let (_chat_temp_dir, chat_v2_db) = create_chat_v2_db();

    for round in 0..3 {
        let block_id = format!("write-repeat-{}", round);
        let mut harness = create_execution_context(&block_id, registry.clone());
        harness.context = harness.context.with_vfs_db(Some(vfs_db.clone()));
        harness.context = harness.context.with_chat_v2_db(Some(chat_v2_db.clone()));
        let call = tool_pack_call(json!({
            "timeout": 30,
            "tools": create_user_todo_create_tools(&format!("phase-3-repeat-{}", round))
        }));

        let result = registry
            .execute(&call, &harness.context)
            .await
            .expect("repeated write-heavy pack should return aggregate result");

        assert!(result.success);
        assert_eq!(result.output["succeeded"], 20);
        assert_eq!(result.output["failed"], 0);

        let results = result.output["results"].as_array().unwrap();
        assert_eq!(results.len(), 20);
        assert_no_sqlite_lock_errors(results);

        let _keep_app_alive = &harness._app;
    }
}

#[tokio::test]
async fn tool_pack_rejects_empty_tools_array() {
    let registry = create_tool_pack_registry();
    let harness = create_execution_context("empty-pack", registry.clone());
    let call = tool_pack_call(json!({ "tools": [] }));

    let error = registry
        .execute(&call, &harness.context)
        .await
        .expect_err("empty tools should be rejected");

    assert!(error.contains("tool_pack requires at least 1 sub-tool"));
}

#[tokio::test]
async fn tool_pack_rejects_unknown_specific_tool_before_execution() {
    let registry = create_tool_pack_registry();
    let harness = create_execution_context("unknown-pack", registry.clone());
    let call = tool_pack_call(json!({
        "tools": [
            { "name": "builtin-not_a_real_tool", "args": {} }
        ]
    }));

    let error = registry
        .execute(&call, &harness.context)
        .await
        .expect_err("unknown sub-tool should be rejected");

    assert!(error.contains("not found in tool registry"));
}

#[tokio::test]
async fn tool_pack_rejects_recursive_subtool() {
    let registry = create_tool_pack_registry();
    let harness = create_execution_context("recursive-pack", registry.clone());
    let call = tool_pack_call(json!({
        "tools": [
            { "name": "builtin-tool_pack", "args": { "tools": [] } }
        ]
    }));

    let error = registry
        .execute(&call, &harness.context)
        .await
        .expect_err("recursive sub-tool should be rejected");

    assert!(error.contains("cannot invoke itself"));
}

#[tokio::test]
async fn tool_pack_rejects_more_than_20_subtools() {
    let registry = create_tool_pack_registry();
    let harness = create_execution_context("too-many-pack", registry.clone());
    let tools: Vec<Value> = (0..21)
        .map(|_| json!({ "name": "builtin-template_validate", "args": {} }))
        .collect();
    let call = tool_pack_call(json!({ "tools": tools }));

    let error = registry
        .execute(&call, &harness.context)
        .await
        .expect_err("more than 20 sub-tools should be rejected");

    assert!(error.contains("supports at most 20 sub-tools"));
}

#[tokio::test]
async fn tool_pack_rejects_ask_user_no_timeout_subtool() {
    let registry = create_tool_pack_registry();
    let harness = create_execution_context("ask-user-pack", registry.clone());
    let call = tool_pack_call(json!({
        "tools": [
            {
                "name": "builtin-ask_user",
                "args": {
                    "question": "Continue?",
                    "options": ["Yes", "No"]
                }
            }
        ]
    }));

    let error = registry
        .execute(&call, &harness.context)
        .await
        .expect_err("no-timeout sub-tool should be rejected");

    assert!(error.contains("cannot execute blocking/no-timeout tool"));
}

#[tokio::test]
async fn tool_pack_executes_subtools_concurrently_and_respects_max_concurrency() {
    let started = Arc::new(AtomicUsize::new(0));
    let in_flight = Arc::new(AtomicUsize::new(0));
    let max_in_flight = Arc::new(AtomicUsize::new(0));
    let started_ten = Arc::new(Notify::new());
    let released = Arc::new(AtomicBool::new(false));
    let release = Arc::new(Notify::new());
    let registry = create_concurrency_registry(
        started.clone(),
        in_flight.clone(),
        max_in_flight.clone(),
        started_ten.clone(),
        released.clone(),
        release.clone(),
    );
    let harness = create_execution_context("parallel-pack", registry.clone());
    let tools: Vec<Value> = (0..12)
        .map(|_| json!({ "name": "builtin-phase3_concurrency_probe", "args": {} }))
        .collect();
    let call = tool_pack_call(json!({ "tools": tools, "timeout": 30 }));

    let pack = registry.execute(&call, &harness.context);
    tokio::pin!(pack);

    tokio::select! {
        _ = started_ten.notified() => {}
        result = &mut pack => panic!("pack completed before concurrency was observed: {:?}", result),
        _ = tokio::time::sleep(Duration::from_secs(2)) => {
            panic!("first 10 sub-tools should start before release");
        }
    }

    assert_eq!(started.load(Ordering::SeqCst), 10);
    assert!(max_in_flight.load(Ordering::SeqCst) >= 2);
    assert!(max_in_flight.load(Ordering::SeqCst) <= 10);

    released.store(true, Ordering::SeqCst);
    release.notify_waiters();

    let result = timeout(Duration::from_secs(5), &mut pack)
        .await
        .expect("released pack should complete")
        .expect("tool_pack should complete");
    let output = result.output;
    assert_eq!(output["succeeded"], 12);
    assert_eq!(output["failed"], 0);
    assert_eq!(output["results"].as_array().unwrap().len(), 12);
}

#[tokio::test]
async fn tool_pack_subtool_timeout_isolated_to_one_failed_result() {
    let fast_completed = Arc::new(AtomicBool::new(false));
    let fast_notify = Arc::new(Notify::new());
    let registry = create_timeout_registry(fast_completed.clone(), fast_notify.clone());
    let harness = create_execution_context("timeout-pack", registry.clone());
    let call = tool_pack_call(json!({
        "timeout": 1,
        "tools": [
            { "name": "builtin-phase3_fast_success", "args": {} },
            { "name": "builtin-phase3_never_finishes", "args": {} }
        ]
    }));

    let result = timeout(
        Duration::from_secs(5),
        registry.execute(&call, &harness.context),
    )
    .await
    .expect("pack timeout test should not hang")
    .expect("pack should return aggregate result");

    let output = result.output;
    let results = output["results"].as_array().unwrap();
    assert_eq!(output["succeeded"], 1);
    assert_eq!(output["failed"], 1);
    assert_eq!(results.len(), 2);
    assert!(results.iter().any(|item| {
        item["tool_name"] == "builtin-phase3_fast_success" && item["success"] == true
    }));
    assert!(results.iter().any(|item| {
        item["tool_name"] == "builtin-phase3_never_finishes"
            && item["success"] == false
            && item["error"]
                .as_str()
                .unwrap_or_default()
                .contains("timeout")
    }));
    assert!(fast_completed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn tool_pack_parent_cancellation_preserves_completed_results() {
    let fast_completed = Arc::new(AtomicBool::new(false));
    let fast_notify = Arc::new(Notify::new());
    let parent_token = CancellationToken::new();
    let registry = create_cancellation_registry(fast_completed.clone(), fast_notify.clone());
    let mut harness = create_execution_context("cancel-pack", registry.clone());
    harness.context = harness
        .context
        .with_cancellation_token(parent_token.clone());

    let call = tool_pack_call(json!({
        "timeout": 30,
        "tools": [
            { "name": "builtin-phase3_fast_success", "args": {} },
            { "name": "builtin-phase3_slow_cancel", "args": {} }
        ]
    }));

    let pack = registry.execute(&call, &harness.context);
    tokio::pin!(pack);

    tokio::select! {
        _ = fast_notify.notified() => {}
        result = &mut pack => panic!("pack completed before cancellation handoff: {:?}", result),
        _ = tokio::time::sleep(Duration::from_secs(2)) => {
            panic!("fast sub-tool should signal completion");
        }
    }
    assert!(fast_completed.load(Ordering::SeqCst));

    parent_token.cancel();

    let result = timeout(Duration::from_secs(5), &mut pack)
        .await
        .expect("cancelled pack should return within 5 seconds")
        .expect("cancelled pack should return aggregate result");

    let output = result.output;
    let results = output["results"].as_array().unwrap();
    assert_eq!(output["succeeded"], 1);
    assert_eq!(output["failed"], 1);
    assert_eq!(results.len(), 2);
    assert!(results.iter().any(|item| {
        item["tool_name"] == "builtin-phase3_fast_success" && item["success"] == true
    }));
    assert!(results.iter().any(|item| {
        item["tool_name"] == "builtin-phase3_slow_cancel"
            && item["success"] == false
            && item["error"]
                .as_str()
                .unwrap_or_default()
                .to_ascii_lowercase()
                .contains("cancel")
    }));

    let _keep_app_alive = &harness._app;
}
