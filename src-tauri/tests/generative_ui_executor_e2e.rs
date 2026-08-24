use std::sync::{Arc, Mutex};

use deep_student_lib::chat_v2::context::PipelineContext;
use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::event_types;
use deep_student_lib::chat_v2::tools::{ExecutionContext, GenerativeUiExecutor, ToolExecutor};
use deep_student_lib::chat_v2::types::{block_types, ToolCall};
use deep_student_lib::tools::ToolRegistry;
use serde_json::{json, Value};
use tauri::Listener;

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

#[test]
fn block_type_mapping_for_render_generative_ui_is_generative_ui() {
    for tool_name in [
        "render_generative_ui",
        "builtin-render_generative_ui",
    ] {
        assert_eq!(
            PipelineContext::get_block_type_for_tool_static(tool_name),
            block_types::GENERATIVE_UI,
            "unexpected block type for {tool_name}"
        );
    }
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
