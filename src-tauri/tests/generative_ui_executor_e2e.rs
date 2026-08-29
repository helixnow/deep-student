use std::ffi::OsString;
use std::sync::{Arc, Mutex};

use deep_student_lib::chat_v2::event_types;
use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::tools::{ExecutionContext, GenerativeUiExecutor, ToolExecutor};
use deep_student_lib::chat_v2::types::ToolCall;
use deep_student_lib::hpias::HPIAS_EVENT_CHANNEL;
use deep_student_lib::tools::ToolRegistry;
use serde_json::{json, Value};
use tauri::Listener;

static HPIAS_BACKEND_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct HpiasBackendEnvGuard {
    previous: Option<OsString>,
}

impl HpiasBackendEnvGuard {
    fn set(value: Option<&str>) -> Self {
        let previous = std::env::var_os("DEEP_STUDENT_HPIAS_BACKEND");
        match value {
            Some(value) => std::env::set_var("DEEP_STUDENT_HPIAS_BACKEND", value),
            None => std::env::remove_var("DEEP_STUDENT_HPIAS_BACKEND"),
        }
        Self { previous }
    }
}

impl Drop for HpiasBackendEnvGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("DEEP_STUDENT_HPIAS_BACKEND", value),
            None => std::env::remove_var("DEEP_STUDENT_HPIAS_BACKEND"),
        }
    }
}

struct GenerativeUiHarness {
    _app: tauri::App,
    window: tauri::Window,
    session_id: String,
}

fn create_harness() -> GenerativeUiHarness {
    let session_id = "generative-ui-executor-e2e".to_string();
    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("build generative ui executor test app");
    let webview = tauri::WebviewWindowBuilder::new(
        &app,
        "generative-ui-executor-e2e",
        tauri::WebviewUrl::default(),
    )
    .build()
    .expect("build generative ui executor test window");
    let window = webview.as_ref().window();
    GenerativeUiHarness {
        _app: app,
        window,
        session_id,
    }
}

fn execution_context(harness: &GenerativeUiHarness, block_id: &str) -> ExecutionContext {
    let emitter = Arc::new(ChatV2EventEmitter::new(
        harness.window.clone(),
        harness.session_id.clone(),
    ));
    ExecutionContext::new(
        harness.session_id.clone(),
        "msg-generative-ui-e2e".to_string(),
        block_id.to_string(),
        emitter,
        Arc::new(ToolRegistry::new()),
        Some(harness.window.clone()),
    )
    .with_tool_call_id("call-generative-ui-e2e")
}

fn capture_block_events(window: &tauri::Window, session_id: &str) -> Arc<Mutex<Vec<Value>>> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let channel = format!("chat_v2_event_{session_id}");
    window.listen(channel, move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(payload);
        }
    });
    events
}

fn capture_hpias_events(window: &tauri::Window) -> Arc<Mutex<Vec<Value>>> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    window.listen(HPIAS_EVENT_CHANNEL, move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(payload);
        }
    });
    events
}

fn hpias_event_types(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|payload| payload.get("type").and_then(Value::as_str))
        .collect()
}

#[test]
fn hpias_event_channel_matches_frontend_contract() {
    assert_eq!(HPIAS_EVENT_CHANNEL, "hpias_event");
}

#[tokio::test]
async fn execute_with_default_backend_keeps_research_blocks_static() {
    let _env_lock = HPIAS_BACKEND_ENV_LOCK.lock().await;
    let _env = HpiasBackendEnvGuard::set(None);
    let harness = create_harness();
    let hpias_events = capture_hpias_events(&harness.window);
    let executor = GenerativeUiExecutor::new();
    let intent = json!({
        "version": "1",
        "blocks": [{
            "type": "research-report",
            "props": {
                "title": "Static report",
                "body": "Closed-book content rendered without a fake retrieval timeline."
            }
        }]
    });

    let result = executor
        .execute(
            &ToolCall::new(
                "call-generative-ui-hpias-default".to_string(),
                "builtin-render_generative_ui".to_string(),
                json!({
                    "researchSessionId": "e2e-hpias-default",
                    "intent": intent
                }),
            ),
            &execution_context(&harness, "block-generative-ui-hpias-default"),
        )
        .await
        .expect("executor returns ToolResultInfo");

    assert!(result.success);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let captured = hpias_events
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(
        captured.is_empty(),
        "default backend must not emit a fake HPIAS timeline: {captured:?}"
    );
}

#[tokio::test]
async fn execute_with_research_session_emits_hpias_session_started() {
    let _env_lock = HPIAS_BACKEND_ENV_LOCK.lock().await;
    let _env = HpiasBackendEnvGuard::set(Some("stub"));
    let harness = create_harness();
    let hpias_events = capture_hpias_events(&harness.window);
    let executor = GenerativeUiExecutor::new();
    let intent = json!({
        "version": "1",
        "meta": { "title": "Deep research question?" },
        "blocks": [{
            "type": "research-plan",
            "props": {
                "title": "Research plan",
                "steps": [{ "label": "Literature review", "status": "pending" }]
            }
        }]
    });

    let result = executor
        .execute(
            &ToolCall::new(
                "call-generative-ui-hpias-e2e".to_string(),
                "builtin-render_generative_ui".to_string(),
                json!({
                    "researchSessionId": "e2e-hpias-session-1",
                    "intent": intent
                }),
            ),
            &execution_context(&harness, "block-generative-ui-hpias-e2e"),
        )
        .await
        .expect("executor returns ToolResultInfo");

    assert!(result.success);
    assert_eq!(
        result
            .output
            .get("researchSessionId")
            .and_then(Value::as_str),
        Some("e2e-hpias-session-1")
    );

    for _ in 0..50 {
        let captured = hpias_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if captured
            .iter()
            .any(|e| e.get("type") == Some(&json!("session_started")))
        {
            let started = captured
                .iter()
                .find(|e| e.get("type") == Some(&json!("session_started")))
                .expect("session_started payload");
            assert_eq!(
                started.get("session_id").and_then(Value::as_str),
                Some("e2e-hpias-session-1")
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    panic!("timed out waiting for hpias_event session_started");
}

#[tokio::test]
async fn execute_hpias_stub_pipeline_emits_plan_generated() {
    let _env_lock = HPIAS_BACKEND_ENV_LOCK.lock().await;
    let _env = HpiasBackendEnvGuard::set(Some("stub"));
    let harness = create_harness();
    let hpias_events = capture_hpias_events(&harness.window);
    let executor = GenerativeUiExecutor::new();
    let intent = json!({
        "version": "1",
        "blocks": [{
            "type": "research-plan",
            "props": {
                "title": "Plan",
                "steps": [
                    { "label": "Query A", "status": "pending" },
                    { "label": "Query B", "status": "pending" }
                ]
            }
        }]
    });

    let result = executor
        .execute(
            &ToolCall::new(
                "call-generative-ui-hpias-pipeline-e2e".to_string(),
                "builtin-render_generative_ui".to_string(),
                json!({
                    "researchSessionId": "e2e-hpias-pipeline",
                    "intent": intent
                }),
            ),
            &execution_context(&harness, "block-generative-ui-hpias-pipeline-e2e"),
        )
        .await
        .expect("executor returns ToolResultInfo");

    assert!(result.success);

    for _ in 0..200 {
        let captured = hpias_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let types = hpias_event_types(&captured);
        if types.contains(&"plan_generated") {
            assert!(types.contains(&"session_started"));
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    panic!("timed out waiting for hpias_event plan_generated from stub pipeline");
}

#[tokio::test]
async fn execute_emits_generative_ui_start_chunk_end_events() {
    let harness = create_harness();
    let events = capture_block_events(&harness.window, &harness.session_id);
    let executor = GenerativeUiExecutor::new();
    let block_id = "block-generative-ui-e2e";
    let intent = json!({
        "version": "1",
        "meta": { "title": "Briefing" },
        "blocks": [
            { "type": "stat-card", "props": { "title": "Due flashcards", "value": 4 } }
        ]
    });

    let result = executor
        .execute(
            &ToolCall::new(
                "call-generative-ui-e2e".to_string(),
                "builtin-render_generative_ui".to_string(),
                json!({ "intent": intent.clone() }),
            ),
            &execution_context(&harness, block_id),
        )
        .await
        .expect("executor returns ToolResultInfo");

    assert!(result.success);

    for _ in 0..50 {
        let captured = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if captured.len() >= 3 {
            let generative_events: Vec<&Value> = captured
                .iter()
                .filter(|payload| payload["type"] == event_types::GENERATIVE_UI)
                .collect();
            assert!(
                generative_events.iter().any(|e| e["phase"] == "start"),
                "missing start event: {captured:?}"
            );
            assert!(
                generative_events.iter().any(|e| e["phase"] == "chunk"),
                "missing chunk event: {captured:?}"
            );
            let end = generative_events
                .iter()
                .find(|e| e["phase"] == "end")
                .expect("missing end event");
            assert_eq!(end["blockId"], block_id);
            let end_result = &end["result"];
            assert_eq!(
                end_result
                    .pointer("/intent/blocks")
                    .and_then(Value::as_array)
                    .map(|a| a.len()),
                Some(1)
            );
            assert_eq!(
                end_result.get("isStreaming").and_then(Value::as_bool),
                Some(false)
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    panic!("timed out waiting for generative_ui block events");
}

#[tokio::test]
async fn execute_v1_1_grid_layout_emits_generative_ui() {
    let harness = create_harness();
    let events = capture_block_events(&harness.window, &harness.session_id);
    let executor = GenerativeUiExecutor::new();
    let block_id = "block-generative-ui-v11-e2e";
    let intent = json!({
        "version": "1.1",
        "layout": { "mode": "grid", "columns": 2 },
        "meta": { "title": "Grid briefing" },
        "blocks": [
            { "type": "stat-card", "props": { "title": "Due flashcards", "value": 4 }, "span": 2 }
        ]
    });

    let result = executor
        .execute(
            &ToolCall::new(
                "call-generative-ui-v11-e2e".to_string(),
                "builtin-render_generative_ui".to_string(),
                json!({ "intent": intent.clone() }),
            ),
            &execution_context(&harness, block_id),
        )
        .await
        .expect("executor returns ToolResultInfo");

    assert!(result.success);
    assert_eq!(
        result.output.get("status").and_then(Value::as_str),
        Some("rendered")
    );

    for _ in 0..50 {
        let captured = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if captured.len() >= 3 {
            let generative_events: Vec<&Value> = captured
                .iter()
                .filter(|payload| payload["type"] == event_types::GENERATIVE_UI)
                .collect();
            assert!(
                generative_events.iter().any(|e| e["phase"] == "start"),
                "missing start event: {captured:?}"
            );
            assert!(
                generative_events.iter().any(|e| e["phase"] == "chunk"),
                "missing chunk event: {captured:?}"
            );
            let end = generative_events
                .iter()
                .find(|e| e["phase"] == "end")
                .expect("missing end event");
            assert_eq!(end["blockId"], block_id);
            let end_result = &end["result"];
            assert_eq!(
                end_result
                    .pointer("/intent/version")
                    .and_then(Value::as_str),
                Some("1.1")
            );
            assert_eq!(
                end_result
                    .pointer("/intent/layout/mode")
                    .and_then(Value::as_str),
                Some("grid")
            );
            assert_eq!(
                end_result
                    .pointer("/intent/blocks/0/span")
                    .and_then(Value::as_u64),
                Some(2)
            );
            assert_eq!(
                end_result.get("isStreaming").and_then(Value::as_bool),
                Some(false)
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    panic!("timed out waiting for generative_ui v1.1 grid events");
}

#[tokio::test]
async fn execute_rejects_version_2() {
    let harness = create_harness();
    let events = capture_block_events(&harness.window, &harness.session_id);
    let executor = GenerativeUiExecutor::new();
    let block_id = "block-generative-ui-v2-e2e";

    let result = executor
        .execute(
            &ToolCall::new(
                "call-generative-ui-v2-e2e".to_string(),
                "builtin-render_generative_ui".to_string(),
                json!({
                    "intent": {
                        "version": "2",
                        "layout": { "mode": "grid", "columns": 2 },
                        "blocks": [{ "type": "text", "props": { "text": "hi" } }]
                    }
                }),
            ),
            &execution_context(&harness, block_id),
        )
        .await
        .expect("executor returns ToolResultInfo");

    assert!(!result.success);
    assert!(result.error.as_deref().unwrap_or("").contains("version"));

    for _ in 0..50 {
        let captured = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let generative_events: Vec<&Value> = captured
            .iter()
            .filter(|payload| payload["type"] == event_types::GENERATIVE_UI)
            .collect();
        if generative_events.iter().any(|e| e["phase"] == "error") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    panic!("timed out waiting for generative_ui version-2 error event");
}

#[tokio::test]
async fn execute_rejects_unknown_block_type() {
    let harness = create_harness();
    let events = capture_block_events(&harness.window, &harness.session_id);
    let executor = GenerativeUiExecutor::new();
    let block_id = "block-generative-ui-unknown-type-e2e";

    let result = executor
        .execute(
            &ToolCall::new(
                "call-generative-ui-unknown-type-e2e".to_string(),
                "builtin-render_generative_ui".to_string(),
                json!({
                    "intent": {
                        "version": "1",
                        "blocks": [{ "type": "unknown-widget", "props": {} }]
                    }
                }),
            ),
            &execution_context(&harness, block_id),
        )
        .await
        .expect("executor returns ToolResultInfo");

    assert!(!result.success);
    let error = result.error.as_deref().unwrap_or("");
    assert!(
        error.contains("unknown-widget"),
        "expected unknown type in error, got {error:?}"
    );

    for _ in 0..50 {
        let captured = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let generative_events: Vec<&Value> = captured
            .iter()
            .filter(|payload| payload["type"] == event_types::GENERATIVE_UI)
            .collect();
        if generative_events.iter().any(|e| e["phase"] == "error") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    panic!("timed out waiting for generative_ui unknown-type error event");
}

#[tokio::test]
async fn execute_rejects_too_many_blocks() {
    let harness = create_harness();
    let events = capture_block_events(&harness.window, &harness.session_id);
    let executor = GenerativeUiExecutor::new();
    let block_id = "block-generative-ui-too-many-e2e";
    let blocks: Vec<Value> = (0..33)
        .map(|i| json!({ "type": "text", "props": { "text": format!("block-{i}") } }))
        .collect();

    let result = executor
        .execute(
            &ToolCall::new(
                "call-generative-ui-too-many-e2e".to_string(),
                "builtin-render_generative_ui".to_string(),
                json!({
                    "intent": {
                        "version": "1",
                        "blocks": blocks
                    }
                }),
            ),
            &execution_context(&harness, block_id),
        )
        .await
        .expect("executor returns ToolResultInfo");

    assert!(!result.success);
    let error = result.error.as_deref().unwrap_or("");
    assert!(
        error.contains("32") || error.contains("上限"),
        "expected 32-block cap in error, got {error:?}"
    );

    for _ in 0..50 {
        let captured = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let generative_events: Vec<&Value> = captured
            .iter()
            .filter(|payload| payload["type"] == event_types::GENERATIVE_UI)
            .collect();
        if generative_events.iter().any(|e| e["phase"] == "error") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    panic!("timed out waiting for generative_ui too-many-blocks error event");
}

#[tokio::test]
async fn execute_with_note_edit_preserves_input_payload() {
    let harness = create_harness();
    let executor = GenerativeUiExecutor::new();
    let note_edit = json!({ "operation": "append", "content": "## E2E" });
    let intent = json!({
        "version": "1",
        "blocks": [
            { "type": "text", "props": { "body": "Preview" } },
            {
                "type": "action-bar",
                "props": {
                    "actions": [{ "id": "apply-note-edit", "label": "Apply" }]
                }
            }
        ]
    });

    let result = executor
        .execute(
            &ToolCall::new(
                "call-generative-ui-note-edit-e2e".to_string(),
                "builtin-render_generative_ui".to_string(),
                json!({ "intent": intent, "noteEdit": note_edit }),
            ),
            &execution_context(&harness, "block-generative-ui-note-edit-e2e"),
        )
        .await
        .expect("executor returns ToolResultInfo");

    assert!(result.success);
    assert_eq!(
        result
            .input
            .get("noteEdit")
            .and_then(|v| v.get("operation"))
            .and_then(Value::as_str),
        Some("append")
    );
}
