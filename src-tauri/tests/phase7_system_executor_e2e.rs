use std::sync::{Arc, Mutex};

use chrono::Utc;
use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::tools::settings_models_executor::{
    MODEL_ASSIGNMENTS_CHANGED_EVENT, SETTINGS_CHANGED_EVENT,
};
use deep_student_lib::chat_v2::tools::{
    ExecutionContext, LlmUsageToolExecutor, SettingsModelsToolExecutor, ToolExecutor,
};
use deep_student_lib::chat_v2::types::{ToolCall, ToolResultInfo};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::database::Database;
use deep_student_lib::file_manager::FileManager;
use deep_student_lib::llm_manager::{LLMManager, ModelProfile, VendorConfig};
use deep_student_lib::llm_usage::database::LlmUsageDatabase;
use deep_student_lib::llm_usage::repo::LlmUsageRepo;
use deep_student_lib::llm_usage::types::{CallerType, UsageRecord};
use deep_student_lib::tools::ToolRegistry;
use serde_json::{json, Value};
use tauri::Listener;
use tempfile::TempDir;

const MODEL_ID: &str = "phase7-system-model";
const SECRET_API_KEY: &str = "phase7-secret-api-key-must-not-leak";

struct Phase7Harness {
    _app: tauri::App,
    _main_dir: TempDir,
    _usage_dir: TempDir,
    main_db: Arc<Database>,
    llm_manager: Arc<LLMManager>,
    usage_db: Arc<LlmUsageDatabase>,
    window: tauri::Window,
}

async fn create_harness() -> Phase7Harness {
    let main_dir = TempDir::new().expect("create main database temp directory");
    let mut coordinator =
        MigrationCoordinator::new(main_dir.path().to_path_buf()).with_audit_db(None);
    coordinator
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

    let vendor_id = "phase7-system-vendor".to_string();
    llm_manager
        .save_vendor_model_configs(
            &[VendorConfig {
                id: vendor_id.clone(),
                name: "Phase 7 System Vendor".to_string(),
                provider_type: "openai".to_string(),
                api_protocol: Some("openai_chat_completions".to_string()),
                supports_openai_responses: Some(false),
                base_url: "https://phase7.invalid/v1".to_string(),
                api_key: SECRET_API_KEY.to_string(),
                ..VendorConfig::default()
            }],
            &[ModelProfile {
                id: MODEL_ID.to_string(),
                vendor_id,
                label: "Phase 7 System Model".to_string(),
                model: "phase7-system-model-runtime-name".to_string(),
                provider_scope: Some("openai".to_string()),
                api_protocol: Some("openai_chat_completions".to_string()),
                model_adapter: "general".to_string(),
                enabled: true,
                ..ModelProfile::default()
            }],
        )
        .await
        .expect("save model directory fixture");

    let usage_dir = TempDir::new().expect("create usage database temp directory");
    let usage_db = Arc::new(
        LlmUsageDatabase::new(usage_dir.path()).expect("open migrated LLM usage database"),
    );

    let app = tauri::Builder::default()
        .manage(main_db.clone())
        .manage(llm_manager.clone())
        .manage(usage_db.clone())
        .build(tauri::generate_context!())
        .expect("build phase 7 executor test app");
    let webview = tauri::WebviewWindowBuilder::new(
        &app,
        "phase7-system-executor-e2e",
        tauri::WebviewUrl::default(),
    )
    .build()
    .expect("build phase 7 executor test window");
    let window = webview.as_ref().window();

    Phase7Harness {
        _app: app,
        _main_dir: main_dir,
        _usage_dir: usage_dir,
        main_db,
        llm_manager,
        usage_db,
        window,
    }
}

fn execution_context(harness: &Phase7Harness, call_id: &str) -> ExecutionContext {
    let emitter = Arc::new(ChatV2EventEmitter::new(
        harness.window.clone(),
        "phase7-system-executor-session".to_string(),
    ));
    ExecutionContext::new(
        "phase7-system-executor-session".to_string(),
        "phase7-system-executor-message".to_string(),
        format!("block-{call_id}"),
        emitter,
        Arc::new(ToolRegistry::new()),
        Some(harness.window.clone()),
    )
    .with_main_db(Some(harness.main_db.clone()))
    .with_llm_manager(Some(harness.llm_manager.clone()))
    .with_tool_call_id(call_id)
}

async fn execute_tool(
    executor: &dyn ToolExecutor,
    harness: &Phase7Harness,
    call_id: &str,
    tool_name: &str,
    arguments: Value,
) -> ToolResultInfo {
    executor
        .execute(
            &ToolCall::new(
                call_id.to_string(),
                format!("builtin-{tool_name}"),
                arguments,
            ),
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

async fn wait_for_event(events: &Arc<Mutex<Vec<Value>>>, action: &str) -> Value {
    for _ in 0..50 {
        let matched = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|payload| payload["action"] == action)
            .cloned();
        if let Some(payload) = matched {
            return payload;
        }
        tokio::task::yield_now().await;
    }
    panic!("missing domain event action={action}");
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

async fn settings_models_and_usage_executors_run_real_system_paths() {
    let harness = create_harness().await;
    let settings_executor = SettingsModelsToolExecutor::new();
    let usage_executor = LlmUsageToolExecutor::new();
    let settings_events = capture_json_events(&harness.window, SETTINGS_CHANGED_EVENT);
    let assignment_events = capture_json_events(&harness.window, MODEL_ASSIGNMENTS_CHANGED_EVENT);

    harness
        .main_db
        .save_setting("theme", "light")
        .expect("save public setting fixture");
    harness
        .main_db
        .save_setting("theme_api_key", SECRET_API_KEY)
        .expect("save protected prefix-collision fixture");

    let settings_get = execute_tool(
        &settings_executor,
        &harness,
        "settings-get",
        "settings_get",
        json!({"prefix": "theme"}),
    )
    .await;
    let settings_output = assert_success(&settings_get);
    assert_eq!(settings_output["count"], 1);
    assert_eq!(settings_output["settings"][0]["key"], "theme");
    assert_eq!(settings_output["settings"][0]["value"], "light");
    assert!(!settings_output.to_string().contains(SECRET_API_KEY));
    assert!(!settings_output.to_string().contains("theme_api_key"));

    let unknown_prefix = execute_tool(
        &settings_executor,
        &harness,
        "settings-unknown-prefix",
        "settings_get",
        json!({"prefix": "debug."}),
    )
    .await;
    assert_error_code(&unknown_prefix, "SETTING_PREFIX_NOT_ALLOWED");

    let sensitive_get = execute_tool(
        &settings_executor,
        &harness,
        "settings-sensitive-get",
        "settings_get",
        json!({"prefix": "api_key"}),
    )
    .await;
    assert_error_code(&sensitive_get, "SENSITIVE_SETTING_REJECTED");

    let sensitive_set = execute_tool(
        &settings_executor,
        &harness,
        "settings-sensitive-set",
        "settings_set",
        json!({"key": "api_key", "value": "replacement-secret"}),
    )
    .await;
    assert_error_code(&sensitive_set, "SENSITIVE_SETTING_REJECTED");
    assert_eq!(event_count(&settings_events), 0);

    let settings_set = execute_tool(
        &settings_executor,
        &harness,
        "settings-set-theme",
        "settings_set",
        json!({"key": "theme", "value": "dark"}),
    )
    .await;
    let settings_set_output = assert_success(&settings_set);
    assert_eq!(settings_set_output["previous_value"], "light");
    assert_eq!(settings_set_output["value"], "dark");
    assert_eq!(settings_set_output["changed"], true);
    assert_eq!(
        harness.main_db.get_setting("theme").unwrap().as_deref(),
        Some("dark")
    );
    let settings_event = wait_for_event(&settings_events, "set").await;
    assert_eq!(settings_event["key"], "theme");

    let assignments_get = execute_tool(
        &settings_executor,
        &harness,
        "assignments-get",
        "model_assignments_get",
        json!({}),
    )
    .await;
    let assignments_output = assert_success(&assignments_get);
    assert!(assignments_output["assignments"]["model2_config_id"].is_null());
    assert!(assignments_output["available_models"]
        .as_array()
        .expect("available models array")
        .iter()
        .any(|model| model["id"] == MODEL_ID));
    assert!(!assignments_output.to_string().contains(SECRET_API_KEY));
    assert!(!assignments_output
        .to_string()
        .contains("https://phase7.invalid"));

    let missing_occ = execute_tool(
        &settings_executor,
        &harness,
        "assignments-missing-occ",
        "model_assignments_set",
        json!({"slot": "model2_config_id", "config_id": MODEL_ID}),
    )
    .await;
    assert_error_code(&missing_occ, "INVALID_ARGUMENT");
    assert_eq!(event_count(&assignment_events), 0);

    let assignment_set = execute_tool(
        &settings_executor,
        &harness,
        "assignments-set",
        "model_assignments_set",
        json!({
            "slot": "model2_config_id",
            "config_id": MODEL_ID,
            "expected_current_config_id": null
        }),
    )
    .await;
    let assignment_set_output = assert_success(&assignment_set);
    assert_eq!(assignment_set_output["config_id"], MODEL_ID);
    assert_eq!(assignment_set_output["changed"], true);
    assert_eq!(
        harness
            .llm_manager
            .get_model_assignments()
            .await
            .expect("read persisted assignments")
            .model2_config_id
            .as_deref(),
        Some(MODEL_ID)
    );
    let assignment_event = wait_for_event(&assignment_events, "set").await;
    assert_eq!(assignment_event["slot"], "model2_config_id");

    let events_before_conflict = event_count(&assignment_events);
    let stale_assignment = execute_tool(
        &settings_executor,
        &harness,
        "assignments-stale",
        "model_assignments_set",
        json!({
            "slot": "model2_config_id",
            "config_id": null,
            "expected_current_config_id": null
        }),
    )
    .await;
    let conflict = assert_error_code(&stale_assignment, "MODEL_ASSIGNMENT_CONFLICT");
    assert_eq!(conflict["current_config_id"], MODEL_ID);
    tokio::task::yield_now().await;
    assert_eq!(event_count(&assignment_events), events_before_conflict);

    let mut usage_record = UsageRecord::new(
        CallerType::ChatV2,
        "phase7-usage-model".to_string(),
        120,
        30,
    );
    usage_record.caller_id = Some("private-caller-id-must-not-leak".to_string());
    usage_record.config_id = Some("private-config-id-must-not-leak".to_string());
    usage_record.provider_id = Some("phase7-provider".to_string());
    usage_record.duration_ms = Some(45);
    usage_record.estimated_cost_usd = Some(0.0015);
    usage_record.created_at = Utc::now();
    LlmUsageRepo::insert_usage(
        &harness
            .usage_db
            .get_conn_safe()
            .expect("get usage database connection"),
        &usage_record,
    )
    .expect("insert usage fixture through production repository");

    let date = usage_record.created_at.format("%Y-%m-%d").to_string();
    let summary = execute_tool(
        &usage_executor,
        &harness,
        "usage-summary",
        "llm_usage_query",
        json!({"action": "summary", "start_date": date, "end_date": date}),
    )
    .await;
    let summary_output = assert_success(&summary);
    assert_eq!(summary_output["action"], "summary");
    assert_eq!(summary_output["totalRequests"], 1);
    assert_eq!(summary_output["promptTokens"], 120);
    assert_eq!(summary_output["completionTokens"], 30);
    assert_eq!(summary_output["totalTokens"], 150);

    let recent = execute_tool(
        &usage_executor,
        &harness,
        "usage-recent",
        "llm_usage_query",
        json!({"action": "recent", "limit": 1}),
    )
    .await;
    let recent_output = assert_success(&recent);
    assert_eq!(recent_output["action"], "recent");
    assert_eq!(recent_output["items"][0]["id"], usage_record.id);
    assert_eq!(recent_output["items"][0]["modelId"], "phase7-usage-model");
    assert_eq!(recent_output["items"][0]["totalTokens"], 150);
    assert_eq!(recent_output["redaction"]["callerId"], "omitted");
    assert!(!recent_output
        .to_string()
        .contains("private-caller-id-must-not-leak"));
    assert!(!recent_output
        .to_string()
        .contains("private-config-id-must-not-leak"));
}

fn main() {
    println!("running 1 test");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build phase 7 current-thread runtime");
    runtime.block_on(settings_models_and_usage_executors_run_real_system_paths());
    println!("test settings_models_and_usage_executors_run_real_system_paths ... ok");
    println!("\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
}
