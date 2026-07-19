use std::sync::{Arc, Mutex};

use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::tools::qbank_executor::QBankExecutor;
use deep_student_lib::chat_v2::tools::{ExecutionContext, ToolExecutor};
use deep_student_lib::chat_v2::types::{ToolCall, ToolResultInfo};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::database::Database;
use deep_student_lib::file_manager::FileManager;
use deep_student_lib::llm_manager::{LLMManager, ModelProfile, VendorConfig};
use deep_student_lib::models::ModelAssignments;
use deep_student_lib::question_bank_service::QuestionBankService;
use deep_student_lib::tools::ToolRegistry;
use deep_student_lib::vfs::repos::{
    CreateQuestionParams, Question, QuestionStatus, QuestionType, SourceType, VfsExamRepo,
    VfsQuestionRepo,
};
use deep_student_lib::vfs::types::VfsCreateExamSheetParams;
use deep_student_lib::vfs::VfsDatabase;
use mockito::{Request, Server};
use serde_json::{json, Value};
use tempfile::TempDir;

const SESSION_ID: &str = "qbank-executor-e2e-session";
const VALID_QUESTION_MARKER: &str = "QBANK_VALID_GRADE";
const INVALID_QUESTION_MARKER: &str = "QBANK_INVALID_VERDICT";
const REAL_FEEDBACK: &str =
    "The response identifies both required causes and explains their relationship.";
const REMOVED_STUB_MESSAGE: &str = "请在题目集练习界面中使用此功能";

#[derive(Clone, Default)]
struct FakeQbankServerState {
    requests: Arc<Mutex<Vec<Value>>>,
}

impl FakeQbankServerState {
    fn requests(&self) -> Vec<Value> {
        self.requests
            .lock()
            .expect("lock fake qbank requests")
            .clone()
    }
}

struct ExecutorHarness {
    _app: tauri::App,
    _main_dir: TempDir,
    _vfs_dir: TempDir,
    main_db: Arc<Database>,
    vfs_db: Arc<VfsDatabase>,
    llm_manager: Arc<LLMManager>,
    question_bank_service: Arc<QuestionBankService>,
    window: tauri::Window,
}

fn request_json(request: &Request) -> Value {
    serde_json::from_slice(request.body().expect("qbank grading request body"))
        .expect("qbank grading request must be JSON")
}

fn request_user_prompt(request: &Request) -> String {
    request_json(request)["messages"][1]["content"]
        .as_str()
        .expect("qbank grading user prompt")
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

async fn install_fake_qbank_endpoint(
    server: &mut Server,
    state: FakeQbankServerState,
) -> mockito::Mock {
    let request_state = state;
    server
        .mock("POST", "/chat/completions")
        .with_header("content-type", "text/event-stream")
        .with_status_code_from_request(move |request| {
            request_state
                .requests
                .lock()
                .expect("record fake qbank request")
                .push(request_json(request));
            200
        })
        .with_body_from_request(move |request| {
            let prompt = request_user_prompt(request);
            if prompt.contains(INVALID_QUESTION_MARKER) {
                openai_sse(&["Feedback intentionally missing structured grading tags."])
            } else {
                assert!(
                    prompt.contains(VALID_QUESTION_MARKER),
                    "unexpected qbank grading prompt: {prompt}"
                );
                openai_sse(&[
                    REAL_FEEDBACK,
                    "\n<verdict>correct</verdict>\n",
                    "<score value=\"92\"/>",
                ])
            }
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

    let vendor_id = "qbank-fake-vendor".to_string();
    let model_id = "qbank-fake-model".to_string();
    llm_manager
        .save_vendor_model_configs(
            &[VendorConfig {
                id: vendor_id.clone(),
                name: "QBank Fake Vendor".to_string(),
                provider_type: "openai".to_string(),
                api_protocol: Some("openai_chat_completions".to_string()),
                supports_openai_responses: Some(false),
                base_url: base_url.to_string(),
                api_key: "qbank-test-key".to_string(),
                ..VendorConfig::default()
            }],
            &[ModelProfile {
                id: model_id.clone(),
                vendor_id,
                label: "QBank Fake Model".to_string(),
                model: "qbank-fake".to_string(),
                provider_scope: Some("openai".to_string()),
                api_protocol: Some("openai_chat_completions".to_string()),
                model_adapter: "general".to_string(),
                enabled: true,
                max_output_tokens: 4096,
                ..ModelProfile::default()
            }],
        )
        .await
        .expect("save fake qbank model configuration");
    llm_manager
        .save_model_assignments(&ModelAssignments {
            qbank_ai_grading_model_config_id: Some(model_id),
            ..ModelAssignments::default()
        })
        .await
        .expect("assign fake qbank grading model");

    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("build Tauri qbank test app");
    let webview =
        tauri::WebviewWindowBuilder::new(&app, "qbank-executor-e2e", tauri::WebviewUrl::default())
            .build()
            .expect("build Tauri qbank test window");
    let window = webview.as_ref().window();
    let question_bank_service = Arc::new(QuestionBankService::new(vfs_db.clone()));

    ExecutorHarness {
        _app: app,
        _main_dir: main_dir,
        _vfs_dir: vfs_dir,
        main_db,
        vfs_db,
        llm_manager,
        question_bank_service,
        window,
    }
}

fn execution_context(harness: &ExecutorHarness, block_id: &str) -> ExecutionContext {
    let emitter = Arc::new(ChatV2EventEmitter::new(
        harness.window.clone(),
        SESSION_ID.to_string(),
    ));
    ExecutionContext::new(
        SESSION_ID.to_string(),
        "qbank-executor-e2e-message".to_string(),
        block_id.to_string(),
        emitter,
        Arc::new(ToolRegistry::new()),
        Some(harness.window.clone()),
    )
    .with_main_db(Some(harness.main_db.clone()))
    .with_vfs_db(Some(harness.vfs_db.clone()))
    .with_llm_manager(Some(harness.llm_manager.clone()))
    .with_question_bank_service(Some(harness.question_bank_service.clone()))
}

async fn execute_tool(
    executor: &QBankExecutor,
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
        .expect("qbank executor returns ToolResultInfo")
}

fn create_subjective_question(
    harness: &ExecutorHarness,
    exam_id: &str,
    card_id: &str,
    marker: &str,
) -> Question {
    VfsQuestionRepo::create_question(
        &harness.vfs_db,
        &CreateQuestionParams {
            exam_id: exam_id.to_string(),
            card_id: Some(card_id.to_string()),
            question_label: Some(card_id.to_string()),
            content: format!("{marker}: Explain why seasons occur on Earth."),
            options: None,
            answer: Some(
                "Earth's axial tilt changes the angle and duration of sunlight during its orbit."
                    .to_string(),
            ),
            explanation: Some(
                "A complete answer must mention axial tilt and Earth's orbit around the Sun."
                    .to_string(),
            ),
            question_type: Some(QuestionType::ShortAnswer),
            difficulty: None,
            tags: Some(vec!["astronomy".to_string(), "phase1-e2e".to_string()]),
            source_type: Some(SourceType::Manual),
            source_ref: Some("qbank-executor-e2e".to_string()),
            images: None,
            parent_id: None,
        },
    )
    .expect("create subjective qbank fixture through production repository")
}

fn create_exam_sheet(harness: &ExecutorHarness, temp_id: &str, name: &str) -> String {
    VfsExamRepo::create_exam_sheet(
        &harness.vfs_db,
        VfsCreateExamSheetParams {
            exam_name: Some(name.to_string()),
            temp_id: temp_id.to_string(),
            metadata_json: json!({"fixture": "qbank-executor-e2e"}),
            preview_json: json!({"session_id": temp_id, "pages": []}),
            status: "completed".to_string(),
            folder_id: None,
        },
    )
    .expect("create qbank exam fixture through production repository")
    .id
}

async fn submit_subjective_answer(
    executor: &QBankExecutor,
    harness: &ExecutorHarness,
    question: &Question,
    call_id: &str,
    user_answer: &str,
) -> String {
    let card_id = question.card_id.as_deref().expect("question card id");
    let submitted = execute_tool(
        executor,
        harness,
        call_id,
        "builtin-qbank_submit_answer",
        json!({
            "session_id": question.exam_id,
            "card_id": card_id,
            "user_answer": user_answer
        }),
    )
    .await;
    assert!(submitted.success, "{:?}", submitted.error);
    assert_eq!(submitted.output["needs_manual_grading"], true);
    assert!(submitted.output["is_correct"].is_null());
    assert_eq!(submitted.output["source"], "questions_table");
    submitted.output["submission_id"]
        .as_str()
        .expect("subjective submission id")
        .to_string()
}

async fn qbank_ai_grade_executor_runs_real_sse_and_persistence_paths() {
    let state = FakeQbankServerState::default();
    let mut server = Server::new_async().await;
    let _grading_mock = install_fake_qbank_endpoint(&mut server, state.clone()).await;
    let harness = create_harness(&server.url()).await;
    let executor = QBankExecutor::new();
    let exam_id = create_exam_sheet(&harness, "temp-qbank-ai-grade-e2e", "QBank AI grade E2E");

    let valid_question = create_subjective_question(
        &harness,
        &exam_id,
        "subjective-valid",
        VALID_QUESTION_MARKER,
    );
    let valid_submission_id = submit_subjective_answer(
        &executor,
        &harness,
        &valid_question,
        "submit-valid",
        "Seasons happen because Earth's axis is tilted while Earth travels around the Sun.",
    )
    .await;

    let before_grade = VfsQuestionRepo::get_question(&harness.vfs_db, &valid_question.id)
        .expect("read subjective question before grading")
        .expect("subjective question exists before grading");
    assert_eq!(before_grade.status, QuestionStatus::InProgress);
    assert_eq!(before_grade.attempt_count, 1);
    assert_eq!(before_grade.correct_count, 0);
    assert_eq!(before_grade.is_correct, None);
    assert_eq!(before_grade.ai_feedback, None);

    let graded = execute_tool(
        &executor,
        &harness,
        "grade-valid",
        "builtin-qbank_ai_grade",
        json!({
            "question_id": valid_question.id,
            "submission_id": valid_submission_id,
            "mode": "grade"
        }),
    )
    .await;
    assert!(graded.success, "{:?}", graded.error);
    assert_eq!(graded.output["submission_id"], valid_submission_id);
    assert_eq!(graded.output["verdict"], "correct");
    assert_eq!(graded.output["score"], 92);
    let feedback = graded.output["feedback"]
        .as_str()
        .expect("real grading feedback");
    assert!(feedback.contains(REAL_FEEDBACK));
    assert!(feedback.contains("<verdict>correct</verdict>"));
    assert!(!feedback.contains(REMOVED_STUB_MESSAGE));
    assert_ne!(graded.output, json!({"message": REMOVED_STUB_MESSAGE}));

    let persisted = VfsQuestionRepo::get_question(&harness.vfs_db, &valid_question.id)
        .expect("read graded question")
        .expect("graded question persists");
    assert_eq!(
        persisted.user_answer.as_deref(),
        Some("Seasons happen because Earth's axis is tilted while Earth travels around the Sun.")
    );
    assert_eq!(persisted.is_correct, Some(true));
    assert_eq!(persisted.attempt_count, 1);
    assert_eq!(persisted.correct_count, 1);
    assert_eq!(persisted.status, QuestionStatus::InProgress);
    assert_eq!(persisted.ai_score, Some(92));
    assert_eq!(persisted.ai_feedback.as_deref(), Some(feedback));
    assert!(persisted.ai_graded_at.is_some());

    let submissions = VfsQuestionRepo::get_submissions(&harness.vfs_db, &valid_question.id, 5)
        .expect("read graded submission history");
    let persisted_submission = submissions
        .iter()
        .find(|submission| submission.id == valid_submission_id)
        .expect("graded submission remains persisted");
    assert_eq!(persisted_submission.is_correct, Some(true));
    assert_eq!(persisted_submission.grading_method, "ai");

    let stats = VfsQuestionRepo::get_stats(&harness.vfs_db, &exam_id)
        .expect("read refreshed qbank stats")
        .expect("qbank stats are persisted");
    assert_eq!(stats.total_count, 1);
    assert_eq!(stats.total_attempts, 1);
    assert_eq!(stats.total_correct, 1);
    assert_eq!(stats.correct_rate, 1.0);

    let invalid_exam_id = create_exam_sheet(
        &harness,
        "temp-qbank-invalid-grade-e2e",
        "QBank invalid grade E2E",
    );
    let invalid_question = create_subjective_question(
        &harness,
        &invalid_exam_id,
        "subjective-invalid",
        INVALID_QUESTION_MARKER,
    );
    let invalid_submission_id = submit_subjective_answer(
        &executor,
        &harness,
        &invalid_question,
        "submit-invalid",
        "The answer reaches the fake model, but its response omits verdict tags.",
    )
    .await;
    let failed = execute_tool(
        &executor,
        &harness,
        "grade-invalid",
        "builtin-qbank_ai_grade",
        json!({
            "question_id": invalid_question.id,
            "submission_id": invalid_submission_id,
            "mode": "grade"
        }),
    )
    .await;
    assert!(!failed.success, "invalid verdict unexpectedly succeeded");
    assert!(
        failed
            .error
            .as_deref()
            .expect("invalid verdict error")
            .contains("verdict"),
        "unexpected invalid-verdict error: {:?}",
        failed.error
    );

    let not_graded = VfsQuestionRepo::get_question(&harness.vfs_db, &invalid_question.id)
        .expect("read failed-grade question")
        .expect("failed-grade question remains persisted");
    assert_eq!(not_graded.ai_feedback, None);
    assert_eq!(not_graded.ai_score, None);
    assert_eq!(not_graded.ai_graded_at, None);
    assert_eq!(not_graded.is_correct, None);
    assert_eq!(not_graded.correct_count, 0);
    assert_eq!(not_graded.status, QuestionStatus::InProgress);
    let invalid_submissions =
        VfsQuestionRepo::get_submissions(&harness.vfs_db, &invalid_question.id, 5)
            .expect("read failed-grade submission history");
    let unchanged_submission = invalid_submissions
        .iter()
        .find(|submission| submission.id == invalid_submission_id)
        .expect("failed-grade submission remains persisted");
    assert_eq!(unchanged_submission.is_correct, None);

    let requests = state.requests();
    assert_eq!(requests.len(), 2, "both grades must reach the fake LLM");
    let valid_request = requests
        .iter()
        .find(|request| {
            request["messages"][1]["content"]
                .as_str()
                .is_some_and(|prompt| prompt.contains(VALID_QUESTION_MARKER))
        })
        .expect("captured valid grading request");
    assert_eq!(valid_request["model"], "qbank-fake");
    assert_eq!(valid_request["stream"], true);
    let system_prompt = valid_request["messages"][0]["content"]
        .as_str()
        .expect("captured grading system prompt");
    let user_prompt = valid_request["messages"][1]["content"]
        .as_str()
        .expect("captured grading user prompt");
    assert!(system_prompt.contains("<verdict>correct|partial|incorrect</verdict>"));
    assert!(user_prompt.contains("## 参考答案"));
    assert!(user_prompt.contains("Earth's axial tilt"));
    assert!(user_prompt.contains("## 学生答案（待评判）"));
    assert!(user_prompt.contains("Earth's axis is tilted"));
}

fn main() {
    println!("running 1 test");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build Tokio qbank executor test runtime");
    runtime.block_on(qbank_ai_grade_executor_runs_real_sse_and_persistence_paths());
    println!("test qbank_ai_grade_executor_runs_real_sse_and_persistence_paths ... ok");
    println!("\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");
}
