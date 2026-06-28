use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::tools::{
    AskUserExecutor, ExecutionContext, GeneralToolExecutor, TemplateDesignerExecutor, ToolExecutor,
    ToolExecutorRegistry, ToolPackExecutor,
};
use deep_student_lib::chat_v2::types::{ToolCall, ToolResultInfo};
use deep_student_lib::tools::ToolRegistry;
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
        window,
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

        self.release.notified().await;
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
    release: Arc<Notify>,
) -> Arc<ToolExecutorRegistry> {
    Arc::new_cyclic(|weak| {
        ToolExecutorRegistry::from_vec(vec![
            Arc::new(Phase3ConcurrencyProbeExecutor {
                started,
                in_flight,
                max_in_flight,
                started_ten,
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
    assert_eq!(harness.context.window.label(), "tool-pack-test");
    assert_eq!(harness.context.emitter.session_id(), "phase-3-session");
    assert!(harness.registry.has_specific_executor("builtin-tool_pack"));
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
    let release = Arc::new(Notify::new());
    let registry = create_concurrency_registry(
        started.clone(),
        in_flight.clone(),
        max_in_flight.clone(),
        started_ten.clone(),
        release.clone(),
    );
    let harness = create_execution_context("parallel-pack", registry.clone());
    let tools: Vec<Value> = (0..12)
        .map(|_| json!({ "name": "builtin-phase3_concurrency_probe", "args": {} }))
        .collect();
    let call = tool_pack_call(json!({ "tools": tools, "timeout": 30 }));

    let pack = registry.execute(&call, &harness.context);
    tokio::pin!(pack);

    timeout(Duration::from_secs(2), started_ten.notified())
        .await
        .expect("first 10 sub-tools should start before release");

    assert_eq!(started.load(Ordering::SeqCst), 10);
    assert!(max_in_flight.load(Ordering::SeqCst) >= 2);
    assert!(max_in_flight.load(Ordering::SeqCst) <= 10);

    release.notify_waiters();

    let result = pack.await.expect("tool_pack should complete");
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

    timeout(Duration::from_secs(2), fast_notify.notified())
        .await
        .expect("fast sub-tool should signal completion");
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
