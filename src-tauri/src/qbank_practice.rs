//! Durable practice drafts, immutable papers and submitted attempts.
//! Draft writes never create submissions or learning signals. Only submit does.

pub mod export;
pub mod export_bridge;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use crate::commands::AppState;
use crate::models::AppError;
use crate::qbank_grading::types::{GradingDiagnostics, GradingFailure};
use crate::question_bank_service::{GeneratedPaper, QuestionBankService};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{Question, VfsQuestionRepo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PracticeDraft {
    pub id: String,
    pub scope_id: String,
    pub paper_id: Option<String>,
    pub title: String,
    pub mode: String,
    pub questions: Vec<Question>,
    pub answers: HashMap<String, String>,
    pub marked_ids: Vec<String>,
    pub current_index: usize,
    pub elapsed_seconds: u32,
    pub duration_seconds: Option<u32>,
    pub deadline: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PracticeResult {
    pub question_id: String,
    pub status: String,
    pub is_correct: Option<bool>,
    pub score: Option<i32>,
    pub feedback: Option<String>,
    pub error: Option<String>,
    pub submission_id: Option<String>,
    pub source_available: bool,
    #[serde(default)]
    pub grading_diagnostics: Option<GradingDiagnostics>,
    #[serde(default)]
    pub grading_drafts: Vec<PracticeGradingDraft>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PracticeGradingDraft {
    pub feedback: String,
    pub error: String,
    pub diagnostics: Option<GradingDiagnostics>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PracticeAttempt {
    pub id: String,
    pub scope_id: String,
    pub paper_id: Option<String>,
    pub title: String,
    pub mode: String,
    pub questions: Vec<Question>,
    pub answers: HashMap<String, String>,
    pub marked_ids: Vec<String>,
    pub results: Vec<PracticeResult>,
    pub elapsed_seconds: u32,
    #[serde(default)]
    pub duration_seconds: Option<u32>,
    pub status: String,
    pub origin_device_id: String,
    pub created_at: String,
    pub submitted_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreatePracticeRequest {
    pub id: String,
    pub scope_id: String,
    pub title: String,
    pub mode: String,
    #[serde(default)]
    pub question_ids: Vec<String>,
    pub paper_id: Option<String>,
    pub duration_seconds: Option<u32>,
    pub started_at: Option<String>,
    pub attempt_id: Option<String>,
    pub start_question_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SavePracticeRequest {
    pub id: String,
    pub revision: i64,
    pub answers: HashMap<String, String>,
    pub marked_ids: Vec<String>,
    pub current_index: usize,
    pub elapsed_seconds: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PracticeSummary {
    pub id: String,
    pub title: String,
    pub mode: String,
    pub paper_id: Option<String>,
    pub question_count: usize,
    pub answered_count: usize,
    pub correct_count: usize,
    pub pending_count: usize,
    pub status: String,
    pub updated_at: String,
}

fn db_error(error: impl std::fmt::Display) -> AppError {
    AppError::database(error.to_string())
}

fn encode<T: Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(db_error)
}

fn decode<T: for<'de> Deserialize<'de>>(value: &str) -> Result<T, AppError> {
    serde_json::from_str(value).map_err(db_error)
}

fn database(state: &AppState) -> Result<Arc<VfsDatabase>, AppError> {
    state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::database("VFS unavailable"))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn load_draft(conn: &Connection, id: &str) -> Result<PracticeDraft, AppError> {
    let json: String = conn
        .query_row(
            "SELECT document_json FROM qbank_practice_drafts WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| AppError::not_found("Practice draft not found"))?;
    decode(&json)
}

pub fn load_attempt(conn: &Connection, id: &str) -> Result<PracticeAttempt, AppError> {
    let json: String = conn
        .query_row(
            "SELECT document_json FROM qbank_practice_attempts WHERE id=?1 AND deleted_at IS NULL",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| AppError::not_found("Practice attempt not found"))?;
    decode(&json)
}

pub fn save_paper(db: &VfsDatabase, paper: &GeneratedPaper) -> Result<(), AppError> {
    let conn = db.get_conn_safe().map_err(db_error)?;
    conn.execute(
        "INSERT INTO qbank_papers(id,exam_id,title,document_json,device_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
        params![paper.id, paper.exam_id, paper.title, encode(paper)?, crate::cloud_storage::get_device_id(), paper.created_at],
    ).map_err(db_error)?;
    Ok(())
}

/// Keep files referenced by an archived paper or practice snapshot available.
/// Soft-deleted history still owns its assets until explicitly purged.
pub fn retains_asset(conn: &Connection, value: &str) -> Result<bool, rusqlite::Error> {
    for table in [
        "qbank_papers",
        "qbank_practice_drafts",
        "qbank_practice_attempts",
    ] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )?;
        if !exists {
            continue;
        }
        let retained: bool = conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table},json_tree(document_json) j WHERE j.key IN ('id','hash') AND j.value=?1)"), [value], |r| r.get(0))?;
        if retained {
            return Ok(true);
        }
        let answers: bool = conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table},json_each(document_json,'$.answers') a,json_tree(CASE WHEN json_valid(a.value) THEN a.value ELSE '{{}}' END) j WHERE j.key IN ('id','hash') AND j.value=?1)"), [value], |r| r.get(0))?;
        if answers {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn load_paper(conn: &Connection, id: &str) -> Result<GeneratedPaper, AppError> {
    let json: String = conn
        .query_row(
            "SELECT document_json FROM qbank_papers WHERE id=?1 AND deleted_at IS NULL",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| AppError::not_found("Paper not found"))?;
    decode(&json)
}

fn persist_attempt(conn: &Connection, attempt: &PracticeAttempt) -> Result<(), AppError> {
    let changed = conn.execute(
        "UPDATE qbank_practice_attempts SET document_json=?2,updated_at=?3,local_version=local_version+1 WHERE id=?1 AND deleted_at IS NULL",
        params![attempt.id, encode(attempt)?, now()],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err(AppError::not_found("Practice attempt not found"));
    }
    Ok(())
}

fn refresh_status(attempt: &mut PracticeAttempt) {
    attempt.status = if attempt.results.iter().any(|r| r.status == "pending") {
        "grading"
    } else if attempt.results.iter().any(|r| r.status == "failed") {
        "needs_review"
    } else {
        "completed"
    }
    .to_string();
}

pub fn create_draft(
    db: &VfsDatabase,
    request: CreatePracticeRequest,
) -> Result<PracticeDraft, AppError> {
    if request.id.is_empty() || request.id.len() > 120 || request.scope_id.is_empty() {
        return Err(AppError::validation("Invalid practice identity"));
    }
    if ![
        "sequential",
        "random",
        "review_first",
        "review_only",
        "by_tag",
        "timed",
        "mock_exam",
        "daily",
        "paper",
        "mistake_redo",
        "group",
    ]
    .contains(&request.mode.as_str())
    {
        return Err(AppError::validation("Invalid practice mode"));
    }
    let mut connection = db.get_conn_safe().map_err(db_error)?;
    let conn = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if let Ok(existing) = load_draft(&conn, &request.id) {
        if existing.scope_id != request.scope_id {
            return Err(AppError::validation("Practice scope mismatch"));
        }
        return Ok(existing);
    }
    if load_attempt(&conn, &request.id).is_ok() {
        return Err(AppError::validation("Practice already submitted"));
    }
    let questions = if let Some(id) = request.attempt_id.as_ref() {
        let attempt = load_attempt(&conn, id)?;
        if attempt.scope_id != request.scope_id {
            return Err(AppError::validation("Practice scope mismatch"));
        }
        attempt.questions
    } else if let Some(id) = request.paper_id.as_ref() {
        let paper = load_paper(&conn, id)?;
        if paper.exam_id != request.scope_id {
            return Err(AppError::validation("Paper scope mismatch"));
        }
        paper.questions
    } else {
        if request.question_ids.is_empty() || request.question_ids.len() > 10000 {
            return Err(AppError::validation("Practice requires 1–10000 questions"));
        }
        let mut seen = HashSet::new();
        let mut questions = Vec::new();
        for id in &request.question_ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            let question = VfsQuestionRepo::get_question_with_conn(&conn, id)
                .map_err(db_error)?
                .ok_or_else(|| AppError::not_found(format!("Question not found: {id}")))?;
            if request.scope_id != "__mistake_redo__" && question.exam_id != request.scope_id {
                return Err(AppError::validation("Question scope mismatch"));
            }
            questions.push(question);
        }
        questions
    };
    if questions.is_empty() {
        return Err(AppError::validation("No questions available"));
    }
    let created_at = now();
    let duration = request.duration_seconds.filter(|d| *d > 0);
    let deadline = if let Some(seconds) = duration {
        if seconds > 480 * 60 {
            return Err(AppError::validation("Duration exceeds 480 minutes"));
        }
        let start = request
            .started_at
            .as_ref()
            .map(|s| chrono::DateTime::parse_from_rfc3339(s).map(|t| t.with_timezone(&chrono::Utc)))
            .transpose()
            .map_err(|_| AppError::validation("Invalid practice start time"))?
            .unwrap_or_else(chrono::Utc::now);
        Some((start + chrono::Duration::seconds(i64::from(seconds))).to_rfc3339())
    } else {
        None
    };
    let current_index = request
        .start_question_id
        .as_ref()
        .and_then(|id| questions.iter().position(|q| &q.id == id))
        .unwrap_or(0);
    let draft = PracticeDraft {
        id: request.id,
        scope_id: request.scope_id,
        paper_id: request.paper_id,
        title: request.title.chars().take(200).collect(),
        mode: request.mode,
        questions,
        answers: HashMap::new(),
        marked_ids: Vec::new(),
        current_index,
        elapsed_seconds: 0,
        duration_seconds: duration,
        deadline,
        revision: 1,
        created_at: created_at.clone(),
        updated_at: created_at,
    };
    conn.execute(
        "INSERT INTO qbank_practice_drafts(id,scope_id,paper_id,document_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
        params![draft.id, draft.scope_id, draft.paper_id, encode(&draft)?, draft.created_at],
    ).map_err(db_error)?;
    conn.commit().map_err(db_error)?;
    Ok(draft)
}

pub fn save_draft(
    db: &VfsDatabase,
    request: SavePracticeRequest,
) -> Result<PracticeDraft, AppError> {
    let conn = db.get_conn_safe().map_err(db_error)?;
    let mut draft = load_draft(&conn, &request.id)?;
    if draft.revision != request.revision {
        return Err(AppError::validation(
            "Practice changed in another window; reload before saving",
        ));
    }
    let ids: HashSet<&str> = draft.questions.iter().map(|q| q.id.as_str()).collect();
    if request.answers.keys().any(|id| !ids.contains(id.as_str()))
        || request
            .marked_ids
            .iter()
            .any(|id| !ids.contains(id.as_str()))
    {
        return Err(AppError::validation(
            "Answer does not belong to this practice",
        ));
    }
    if request
        .answers
        .values()
        .any(|answer| answer.len() > 512 * 1024)
    {
        return Err(AppError::validation("Answer exceeds size limit"));
    }
    if request.current_index >= draft.questions.len() {
        return Err(AppError::validation("Invalid question index"));
    }
    draft.answers = request
        .answers
        .into_iter()
        .filter(|(_, a)| !a.trim().is_empty())
        .collect();
    draft.marked_ids = request.marked_ids;
    draft.current_index = request.current_index;
    draft.elapsed_seconds = request.elapsed_seconds;
    draft.revision += 1;
    draft.updated_at = now();
    let changed = conn.execute(
        "UPDATE qbank_practice_drafts SET document_json=?2,revision=?3,updated_at=?4 WHERE id=?1 AND revision=?5",
        params![draft.id, encode(&draft)?, draft.revision, draft.updated_at, request.revision],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err(AppError::validation(
            "Practice changed in another window; reload before saving",
        ));
    }
    Ok(draft)
}

/// Snapshot grading and canonical learning writes share the submit transaction.
pub fn submit_draft(
    db: &Arc<VfsDatabase>,
    id: &str,
    revision: i64,
) -> Result<PracticeAttempt, AppError> {
    submit_draft_with_revision(db, id, Some(revision))
}

fn submit_draft_with_revision(
    db: &Arc<VfsDatabase>,
    id: &str,
    revision: Option<i64>,
) -> Result<PracticeAttempt, AppError> {
    let mut conn = db.get_conn_safe().map_err(db_error)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if let Ok(existing) = load_attempt(&tx, id) {
        return Ok(existing);
    }
    let draft = load_draft(&tx, id)?;
    if revision.is_some_and(|revision| draft.revision != revision) {
        return Err(AppError::validation(
            "Practice changed before submission; reload before submitting",
        ));
    }
    let submitted_at = now();
    let device_id = crate::cloud_storage::get_device_id();
    let mut results = Vec::new();
    let mut wrong = Vec::new();
    let mut correct_questions = Vec::new();
    let mut mastery_states = Vec::new();
    for question in &draft.questions {
        let live = VfsQuestionRepo::get_question_with_conn(&tx, &question.id).map_err(db_error)?;
        let answer = draft
            .answers
            .get(&question.id)
            .filter(|a| !a.trim().is_empty());
        let (correct, manual) = answer
            .map(|answer| {
                QuestionBankService::check_answer_correctness(
                    answer,
                    question.answer.as_deref(),
                    &question.question_type,
                    question.structured_data.as_ref(),
                )
            })
            .unwrap_or((false, false));
        let is_correct = if answer.is_none() || manual {
            None
        } else {
            Some(correct)
        };
        let status = if answer.is_none() {
            "unanswered"
        } else if manual {
            "pending"
        } else if correct {
            "correct"
        } else {
            "incorrect"
        };
        let mut submission_id = None;
        if let (Some(answer), Some(live)) = (answer, live.as_ref()) {
            let sid = VfsQuestionRepo::insert_submission_with_snapshot_with_conn(
                &tx,
                &question.id,
                answer,
                is_correct,
                if manual { "ai" } else { "auto" },
                Some(&format!("practice:{}:{}", draft.id, question.id)),
                Some(&encode(
                    &crate::qbank_grading::context::question_snapshot_json(question),
                )?),
                Some(&encode(
                    &crate::qbank_grading::context::material_snapshot_json(&question.materials),
                )?),
            )
            .map_err(db_error)?;
            VfsQuestionRepo::submit_answer_with_conn(&tx, &question.id, answer, is_correct, manual)
                .map_err(db_error)?;
            VfsQuestionRepo::refresh_stats_with_conn(&tx, &live.exam_id).map_err(db_error)?;
            if let Some(correct) = is_correct {
                let state = crate::mastery::MasteryService::new(db.clone())
                    .record_qbank_answer_with_conn(
                        &tx,
                        &sid,
                        &question.id,
                        &question.tags,
                        correct,
                    )?;
                mastery_states.push(state);
                if !correct {
                    wrong.push((question.id.clone(), live.exam_id.clone()));
                } else {
                    correct_questions.push(question.id.clone());
                }
            }
            submission_id = Some(sid);
        }
        results.push(PracticeResult {
            question_id: question.id.clone(),
            status: status.to_string(),
            is_correct,
            score: is_correct.map(|v| if v { 100 } else { 0 }),
            feedback: None,
            error: None,
            submission_id,
            source_available: live.is_some(),
            grading_diagnostics: None,
            grading_drafts: Vec::new(),
        });
    }
    let elapsed_seconds = if let (Some(duration), Some(deadline)) =
        (draft.duration_seconds, draft.deadline.as_ref())
    {
        let end = chrono::DateTime::parse_from_rfc3339(deadline).map_err(db_error)?;
        let remaining = (end.timestamp() - chrono::Utc::now().timestamp()).max(0) as u32;
        duration.saturating_sub(remaining)
    } else {
        draft.elapsed_seconds
    };
    let mut attempt = PracticeAttempt {
        id: draft.id,
        scope_id: draft.scope_id,
        paper_id: draft.paper_id,
        title: draft.title,
        mode: draft.mode,
        questions: draft.questions,
        answers: draft.answers,
        marked_ids: draft.marked_ids,
        results,
        elapsed_seconds,
        duration_seconds: draft.duration_seconds,
        status: String::new(),
        origin_device_id: device_id.clone(),
        created_at: draft.created_at,
        submitted_at: submitted_at.clone(),
    };
    refresh_status(&mut attempt);
    tx.execute(
        "INSERT INTO qbank_practice_attempts(id,scope_id,paper_id,document_json,device_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
        params![attempt.id, attempt.scope_id, attempt.paper_id, encode(&attempt)?, device_id, submitted_at],
    ).map_err(db_error)?;
    for result in &attempt.results {
        if result.status == "pending" {
            tx.execute(
                "INSERT INTO qbank_practice_jobs(id,attempt_id,question_id,status,updated_at) VALUES(?1,?2,?3,'queued',?4)",
                params![format!("{}:{}", attempt.id, result.question_id), attempt.id, result.question_id, submitted_at],
            ).map_err(db_error)?;
        }
    }
    tx.execute("DELETE FROM qbank_practice_drafts WHERE id=?1", [id])
        .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    drop(conn);
    let review = crate::review_plan_service::ReviewPlanService::new(db.clone());
    for (question_id, exam_id) in wrong {
        let _ = review.get_or_create_plan(&question_id, &exam_id);
    }
    for question_id in correct_questions {
        if let Ok(Some(plan)) = review.get_plan_by_question(&question_id) {
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            if plan.next_review_date <= today {
                let _ = review.advance_from_practice(&plan.id);
            }
        }
    }
    let mastery = crate::mastery::MasteryService::new(db.clone());
    for state in mastery_states {
        let _ = mastery.sync_learner_profile(&state);
    }
    Ok(attempt)
}

#[tauri::command]
pub fn qbank_create_practice(
    request: CreatePracticeRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PracticeDraft, AppError> {
    let draft = create_draft(database(&state)?.as_ref(), request)?;
    schedule_deadline(app, &draft);
    Ok(draft)
}

#[tauri::command]
pub fn qbank_save_practice(
    request: SavePracticeRequest,
    state: State<'_, AppState>,
) -> Result<PracticeDraft, AppError> {
    save_draft(database(&state)?.as_ref(), request)
}

#[tauri::command]
pub fn qbank_get_practice(
    id: String,
    submitted: bool,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    let db = database(&state)?;
    let conn = db.get_conn_safe().map_err(db_error)?;
    if submitted {
        serde_json::to_value(load_attempt(&conn, &id)?).map_err(db_error)
    } else {
        serde_json::to_value(load_draft(&conn, &id)?).map_err(db_error)
    }
}

#[tauri::command]
pub fn qbank_list_practices(
    scope_id: String,
    submitted: bool,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<PracticeSummary>, AppError> {
    let db = database(&state)?;
    let conn = db.get_conn_safe().map_err(db_error)?;
    let sql = if submitted {
        "SELECT document_json,updated_at FROM qbank_practice_attempts WHERE scope_id=?1 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 200 OFFSET ?2"
    } else {
        "SELECT document_json,updated_at FROM qbank_practice_drafts WHERE scope_id=?1 ORDER BY updated_at DESC,id DESC LIMIT 200 OFFSET ?2"
    };
    let mut stmt = conn.prepare(sql).map_err(db_error)?;
    let rows = stmt
        .query_map(params![scope_id, offset.unwrap_or(0)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;
    let mut summaries = Vec::new();
    for row in rows {
        let (json, updated_at) = row.map_err(db_error)?;
        if submitted {
            let a: PracticeAttempt = decode(&json)?;
            summaries.push(PracticeSummary {
                id: a.id,
                title: a.title,
                mode: a.mode,
                paper_id: a.paper_id,
                question_count: a.questions.len(),
                answered_count: a.answers.len(),
                correct_count: a
                    .results
                    .iter()
                    .filter(|r| r.is_correct == Some(true))
                    .count(),
                pending_count: a
                    .results
                    .iter()
                    .filter(|r| r.status == "pending" || r.status == "failed")
                    .count(),
                status: a.status,
                updated_at,
            });
        } else {
            let d: PracticeDraft = decode(&json)?;
            summaries.push(PracticeSummary {
                id: d.id,
                title: d.title,
                mode: d.mode,
                paper_id: d.paper_id,
                question_count: d.questions.len(),
                answered_count: d.answers.len(),
                correct_count: 0,
                pending_count: 0,
                status: "draft".into(),
                updated_at,
            });
        }
    }
    Ok(summaries)
}

#[tauri::command]
pub fn qbank_submit_practice(
    id: String,
    revision: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PracticeAttempt, AppError> {
    let attempt = submit_draft(&database(&state)?, &id, revision)?;
    let _ = app.emit("qbank-practice-updated", &attempt.id);
    start_grading(app);
    Ok(attempt)
}

#[tauri::command]
pub fn qbank_delete_practice(
    id: String,
    submitted: bool,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let db = database(&state)?;
    let conn = db.get_conn_safe().map_err(db_error)?;
    if submitted {
        conn.execute("UPDATE qbank_practice_attempts SET deleted_at=?2,updated_at=?2,local_version=local_version+1 WHERE id=?1", params![id, now()]).map_err(db_error)?;
    } else {
        conn.execute("DELETE FROM qbank_practice_drafts WHERE id=?1", [id])
            .map_err(db_error)?;
    }
    Ok(())
}

#[tauri::command]
pub fn qbank_list_papers(
    exam_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<GeneratedPaper>, AppError> {
    let db = database(&state)?;
    let conn = db.get_conn_safe().map_err(db_error)?;
    let mut stmt = conn.prepare("SELECT document_json FROM qbank_papers WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at DESC").map_err(db_error)?;
    let rows = stmt
        .query_map([exam_id], |r| r.get::<_, String>(0))
        .map_err(db_error)?;
    rows.map(|row| decode(&row.map_err(db_error)?)).collect()
}

#[tauri::command]
pub fn qbank_get_paper(id: String, state: State<'_, AppState>) -> Result<GeneratedPaper, AppError> {
    let db = database(&state)?;
    let conn = db.get_conn_safe().map_err(db_error)?;
    load_paper(&conn, &id)
}

#[tauri::command]
pub fn qbank_update_paper(
    id: String,
    title: Option<String>,
    deleted: bool,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let db = database(&state)?;
    let conn = db.get_conn_safe().map_err(db_error)?;
    let mut paper = load_paper(&conn, &id)?;
    if let Some(title) = title {
        if title.trim().is_empty() || title.chars().count() > 200 {
            return Err(AppError::validation("Invalid paper title"));
        }
        paper.title = title.trim().to_string();
        paper.config.title = paper.title.clone();
    }
    let timestamp = now();
    conn.execute("UPDATE qbank_papers SET title=?2,document_json=?3,deleted_at=?4,updated_at=?5,local_version=local_version+1 WHERE id=?1",
        params![id, paper.title, encode(&paper)?, if deleted { Some(timestamp.clone()) } else { None }, timestamp]).map_err(db_error)?;
    Ok(())
}

static GRADING_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn start_grading(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _guard = GRADING_LOCK.lock().await;
        if let Err(error) = run_grading_queue(&app).await {
            log::error!("Practice grading queue: {}", error.message);
        }
    });
}

#[tauri::command]
pub fn qbank_resume_practice_grading(app: tauri::AppHandle, state: State<'_, AppState>) {
    if let Ok(db) = database(&state) {
        if let Ok(conn) = db.get_conn_safe() {
            if let Ok(mut stmt) = conn.prepare("SELECT document_json FROM qbank_practice_drafts WHERE json_extract(document_json,'$.deadline') IS NOT NULL") {
                if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                    for row in rows.flatten() {
                        if let Ok(draft) = decode::<PracticeDraft>(&row) { schedule_deadline(app.clone(), &draft); }
                    }
                }
            }
        }
    }
    start_grading(app);
}

static DEADLINES: std::sync::LazyLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashSet::new()));

fn schedule_deadline(app: tauri::AppHandle, draft: &PracticeDraft) {
    let Some(deadline) = draft
        .deadline
        .as_ref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    else {
        return;
    };
    if !DEADLINES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(draft.id.clone())
    {
        return;
    }
    let id = draft.id.clone();
    let delay = (deadline.timestamp() - chrono::Utc::now().timestamp() + 3).max(0) as u64;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        let state = app.state::<AppState>();
        let result = (|| -> Result<PracticeAttempt, AppError> {
            let db = database(&state)?;
            // Select the latest persisted revision inside the submission transaction.
            submit_draft_with_revision(&db, &id, None)
        })();
        if let Ok(attempt) = result {
            let _ = app.emit("qbank-practice-updated", &attempt.id);
            start_grading(app.clone());
        }
        DEADLINES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    });
}

async fn run_grading_queue(app: &tauri::AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let db = database(&state)?;
    // The process lock serializes callers. A running row here survived a restart.
    {
        let conn = db.get_conn_safe().map_err(db_error)?;
        conn.execute(
            "UPDATE qbank_practice_jobs SET status='queued' WHERE status='running'",
            [],
        )
        .map_err(db_error)?;
    }
    loop {
        let next = {
            let conn = db.get_conn_safe().map_err(db_error)?;
            conn.query_row("SELECT j.id,j.attempt_id,j.question_id FROM qbank_practice_jobs j JOIN qbank_practice_attempts a ON a.id=j.attempt_id WHERE j.status='queued' AND a.deleted_at IS NULL AND a.device_id=?1 ORDER BY j.updated_at,j.id LIMIT 1", [crate::cloud_storage::get_device_id()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).optional().map_err(db_error)?
        };
        let Some((job_id, attempt_id, question_id)) = next else {
            break;
        };
        let (question, answer) = {
            let conn = db.get_conn_safe().map_err(db_error)?;
            let attempt = load_attempt(&conn, &attempt_id)?;
            let question = attempt
                .questions
                .iter()
                .find(|q| q.id == question_id)
                .cloned()
                .ok_or_else(|| AppError::validation("Missing practice snapshot"))?;
            let answer = attempt
                .answers
                .get(&question_id)
                .cloned()
                .ok_or_else(|| AppError::validation("Missing practice answer"))?;
            conn.execute(
                "UPDATE qbank_practice_jobs SET status='running',updated_at=?2 WHERE id=?1",
                params![job_id, now()],
            )
            .map_err(db_error)?;
            (question, answer)
        };
        let response = crate::qbank_grading::pipeline::grade_practice_snapshot(
            &db,
            state.llm_manager.clone(),
            &question,
            &answer,
            &job_id,
        )
        .await;
        let mut conn = db.get_conn_safe().map_err(db_error)?;
        let tx = conn.transaction().map_err(db_error)?;
        let mut attempt = match load_attempt(&tx, &attempt_id) {
            Ok(attempt) => attempt,
            Err(error) if matches!(error.error_type, crate::models::AppErrorType::NotFound) => {
                tx.execute(
                    "UPDATE qbank_practice_jobs SET status='done',updated_at=?2 WHERE id=?1",
                    params![job_id, now()],
                )
                .map_err(db_error)?;
                tx.commit().map_err(db_error)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        let result = attempt
            .results
            .iter_mut()
            .find(|r| r.question_id == question_id)
            .ok_or_else(|| AppError::validation("Missing practice result"))?;
        // A user self-grade may have won while the model was streaming.
        if result.status != "pending" {
            tx.execute(
                "UPDATE qbank_practice_jobs SET status='done',updated_at=?2 WHERE id=?1",
                params![job_id, now()],
            )
            .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
            continue;
        }
        let mut outcome = None;
        let response = response.and_then(|response| {
            let applied = apply_practice_verdict(
                &tx,
                &db,
                &question_id,
                result.submission_id.as_deref(),
                response
                    .verdict
                    .as_ref()
                    .is_some_and(|verdict| verdict.is_correct()),
            );
            match applied {
                Ok((applied, source_available)) => {
                    outcome = applied;
                    result.source_available = source_available;
                    Ok(response)
                }
                Err(error) => {
                    let mut diagnostics = response.diagnostics;
                    if let Some(diagnostics) = diagnostics.as_mut() {
                        diagnostics.status =
                            crate::qbank_grading::types::GradingCompletionStatus::PersistenceError;
                    }
                    Err(GradingFailure {
                        error,
                        feedback: response.feedback,
                        diagnostics,
                    })
                }
            }
        });
        match response {
            Ok(response) => {
                let correct = response.verdict.as_ref().is_some_and(|v| v.is_correct());
                result.status = if correct {
                    "correct"
                } else if matches!(
                    response.verdict,
                    Some(crate::qbank_grading::types::Verdict::Partial)
                ) {
                    "partial"
                } else {
                    "incorrect"
                }
                .into();
                result.is_correct = Some(correct);
                result.score = response.score;
                result.feedback = Some(response.feedback);
                result.grading_diagnostics = response.diagnostics;
                result.error = None;
                tx.execute("UPDATE qbank_practice_jobs SET status='done',error=NULL,updated_at=?2 WHERE id=?1", params![job_id, now()]).map_err(db_error)?;
            }
            Err(failure) => {
                record_grading_failure(result, failure);
                log::warn!(
                    "[PracticeGrading] job={} error={:?} diagnostics={}",
                    job_id,
                    result.error,
                    serde_json::to_string(&result.grading_diagnostics).unwrap_or_default()
                );
                tx.execute("UPDATE qbank_practice_jobs SET status='failed',error=?2,updated_at=?3 WHERE id=?1", params![job_id, result.error, now()]).map_err(db_error)?;
            }
        }
        refresh_status(&mut attempt);
        persist_attempt(&tx, &attempt)?;
        tx.commit().map_err(db_error)?;
        drop(conn);
        if let Some(outcome) = outcome {
            if outcome.needs_review_plan {
                let _ = crate::review_plan_service::ReviewPlanService::new(db.clone())
                    .get_or_create_plan(&question_id, &question.exam_id);
            }
            if let Some(mastery) = outcome.mastery_state {
                let _ =
                    crate::mastery::MasteryService::new(db.clone()).sync_learner_profile(&mastery);
            }
        }
        let _ = app.emit("qbank-practice-updated", &attempt.id);
    }
    Ok(())
}

fn apply_practice_verdict(
    conn: &Connection,
    db: &Arc<VfsDatabase>,
    question_id: &str,
    submission_id: Option<&str>,
    correct: bool,
) -> Result<
    (
        Option<crate::question_bank_service::VerdictApplyOutcome>,
        bool,
    ),
    AppError,
> {
    conn.execute("SAVEPOINT practice_grade", [])
        .map_err(db_error)?;
    let applied = (|| {
        let Some(live) =
            VfsQuestionRepo::get_question_with_conn(conn, question_id).map_err(db_error)?
        else {
            return Ok((None, false));
        };
        let Some(sid) = submission_id else {
            return Ok((None, false));
        };
        let Some(submission) =
            crate::qbank_grading::pipeline::get_submission_by_id_with_conn(conn, sid)?
        else {
            return Ok((None, false));
        };
        let outcome = QuestionBankService::new(db.clone()).apply_submission_verdict_in_tx(
            conn,
            &live,
            &submission,
            correct,
            "ai",
            &now(),
        )?;
        Ok((Some(outcome), true))
    })();
    match applied {
        Ok(applied) => {
            conn.execute("RELEASE practice_grade", [])
                .map_err(db_error)?;
            Ok(applied)
        }
        Err(error) => {
            conn.execute_batch("ROLLBACK TO practice_grade; RELEASE practice_grade;")
                .map_err(db_error)?;
            Err(error)
        }
    }
}

fn record_grading_failure(result: &mut PracticeResult, failure: GradingFailure) {
    result.status = "failed".into();
    result.is_correct = None;
    result.score = None;
    result.error = Some(failure.error.message.clone());
    result.grading_diagnostics = failure.diagnostics.clone();
    result.grading_drafts.push(PracticeGradingDraft {
        feedback: failure.feedback,
        error: failure.error.message,
        diagnostics: failure.diagnostics,
        created_at: now(),
    });
}

#[tauri::command]
pub fn qbank_retry_practice_grading(
    id: String,
    question_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PracticeAttempt, AppError> {
    let db = database(&state)?;
    let mut conn = db.get_conn_safe().map_err(db_error)?;
    let tx = conn.transaction().map_err(db_error)?;
    let mut attempt = load_attempt(&tx, &id)?;
    if attempt.origin_device_id != crate::cloud_storage::get_device_id() {
        return Err(AppError::validation("请在发起练习的设备上重试 AI 批改"));
    }
    let result = attempt
        .results
        .iter_mut()
        .find(|r| r.question_id == question_id)
        .ok_or_else(|| AppError::not_found("Result not found"))?;
    if result.status != "failed" {
        return Err(AppError::validation("Only failed grading can be retried"));
    }
    result.status = "pending".into();
    result.error = None;
    tx.execute("INSERT INTO qbank_practice_jobs(id,attempt_id,question_id,status,updated_at) VALUES(?1,?2,?3,'queued',?4) ON CONFLICT(attempt_id,question_id) DO UPDATE SET status='queued',error=NULL,updated_at=excluded.updated_at",
        params![format!("{id}:{question_id}"), id, question_id, now()]).map_err(db_error)?;
    refresh_status(&mut attempt);
    persist_attempt(&tx, &attempt)?;
    tx.commit().map_err(db_error)?;
    drop(conn);
    start_grading(app);
    Ok(attempt)
}

#[tauri::command]
pub fn qbank_grade_practice_manually(
    id: String,
    question_id: String,
    correct: bool,
    state: State<'_, AppState>,
) -> Result<PracticeAttempt, AppError> {
    let db = database(&state)?;
    let mut conn = db.get_conn_safe().map_err(db_error)?;
    let tx = conn.transaction().map_err(db_error)?;
    let mut attempt = load_attempt(&tx, &id)?;
    let result = attempt
        .results
        .iter_mut()
        .find(|r| r.question_id == question_id)
        .ok_or_else(|| AppError::not_found("Result not found"))?;
    if result.status == "unanswered" {
        return Err(AppError::validation("Cannot grade an unanswered question"));
    }
    let mut outcome = None;
    if let Some(sid) = result.submission_id.as_ref() {
        if let Some(question) =
            VfsQuestionRepo::get_question_with_conn(&tx, &question_id).map_err(db_error)?
        {
            if let Some(sub) =
                crate::qbank_grading::pipeline::get_submission_by_id_with_conn(&tx, sid)?
            {
                outcome = Some(
                    QuestionBankService::new(db.clone()).apply_submission_verdict_in_tx(
                        &tx,
                        &question,
                        &sub,
                        correct,
                        "manual",
                        &now(),
                    )?,
                );
            } else {
                result.source_available = false;
            }
        } else {
            result.source_available = false;
        }
    }
    result.is_correct = Some(correct);
    result.score = Some(if correct { 100 } else { 0 });
    result.status = if correct { "correct" } else { "incorrect" }.into();
    result.error = None;
    tx.execute("UPDATE qbank_practice_jobs SET status='done',updated_at=?3 WHERE attempt_id=?1 AND question_id=?2", params![id, question_id, now()]).map_err(db_error)?;
    refresh_status(&mut attempt);
    persist_attempt(&tx, &attempt)?;
    tx.commit().map_err(db_error)?;
    drop(conn);
    if let Some(outcome) = outcome {
        if outcome.needs_review_plan {
            let _ = crate::review_plan_service::ReviewPlanService::new(db.clone())
                .get_or_create_plan(&question_id, &outcome.updated_question.exam_id);
        }
        if let Some(mastery) = outcome.mastery_state {
            let _ = crate::mastery::MasteryService::new(db.clone()).sync_learner_profile(&mastery);
        }
    }
    Ok(attempt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::repos::{CreateQuestionParams, QuestionType};

    fn setup() -> (tempfile::TempDir, Arc<VfsDatabase>) {
        let (tmp, db) = crate::vfs::database::setup_migrated_test_db();
        (tmp, Arc::new(db))
    }

    fn seed(db: &VfsDatabase, subjective: bool) -> Question {
        let conn = db.get_conn_safe().unwrap();
        conn.execute("INSERT OR IGNORE INTO exam_sheets(id,exam_name,status,temp_id,metadata_json,preview_json,created_at,updated_at) VALUES('practice-exam','Practice','completed','practice-temp','{}','{}',?1,?1)", [now()]).unwrap();
        drop(conn);
        VfsQuestionRepo::create_question(
            db,
            &CreateQuestionParams {
                exam_id: "practice-exam".into(),
                content: "Choose the answer".into(),
                answer: Some("A".into()),
                question_type: Some(if subjective {
                    QuestionType::ShortAnswer
                } else {
                    QuestionType::SingleChoice
                }),
                options: None,
                card_id: None,
                question_label: None,
                explanation: Some("Reference explanation".into()),
                structured_data: None,
                difficulty: None,
                tags: None,
                source_type: None,
                source_ref: None,
                images: None,
                parent_id: None,
            },
        )
        .unwrap()
    }

    fn request(q: &Question) -> CreatePracticeRequest {
        CreatePracticeRequest {
            id: format!("practice_{}", uuid::Uuid::new_v4()),
            scope_id: q.exam_id.clone(),
            title: "Practice".into(),
            mode: "sequential".into(),
            question_ids: vec![q.id.clone()],
            paper_id: None,
            duration_seconds: None,
            started_at: None,
            attempt_id: None,
            start_question_id: None,
        }
    }
    fn save(db: &VfsDatabase, draft: &PracticeDraft, answer: &str) -> PracticeDraft {
        save_draft(
            db,
            SavePracticeRequest {
                id: draft.id.clone(),
                revision: draft.revision,
                answers: HashMap::from([(draft.questions[0].id.clone(), answer.into())]),
                marked_ids: vec![],
                current_index: 0,
                elapsed_seconds: 20,
            },
        )
        .unwrap()
    }

    #[test]
    fn drafts_do_not_grade_or_create_learning_signals_and_submit_is_idempotent() {
        let (_tmp, db) = setup();
        let q = seed(&db, false);
        let draft = create_draft(&db, request(&q)).unwrap();
        let draft = save(&db, &draft, "A");
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(load_draft(&conn, &draft.id).unwrap().answers[&q.id], "A");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM answer_submissions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            VfsQuestionRepo::get_question_with_conn(&conn, &q.id)
                .unwrap()
                .unwrap()
                .attempt_count,
            0
        );
        drop(conn);
        let first = submit_draft(&db, &draft.id, draft.revision).unwrap();
        let replay = submit_draft(&db, &draft.id, draft.revision).unwrap();
        assert_eq!(first.results[0].status, "correct");
        assert_eq!(
            first.results[0].submission_id,
            replay.results[0].submission_id
        );
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM answer_submissions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            VfsQuestionRepo::get_question_with_conn(&conn, &q.id)
                .unwrap()
                .unwrap()
                .attempt_count,
            1
        );
        assert!(load_draft(&conn, &draft.id).is_err());
    }

    #[test]
    fn stale_save_and_submit_cannot_overwrite_newer_answers() {
        let (_tmp, db) = setup();
        let q = seed(&db, false);
        let original = create_draft(&db, request(&q)).unwrap();
        let newer = save(&db, &original, "B");
        assert!(save_draft(
            &db,
            SavePracticeRequest {
                id: original.id.clone(),
                revision: original.revision,
                answers: HashMap::new(),
                marked_ids: vec![],
                current_index: 0,
                elapsed_seconds: 0
            }
        )
        .is_err());
        assert!(submit_draft(&db, &original.id, original.revision).is_err());
        assert_eq!(
            submit_draft(&db, &newer.id, newer.revision)
                .unwrap()
                .results[0]
                .status,
            "incorrect"
        );
    }

    #[test]
    fn deadline_submission_uses_latest_saved_revision_and_replays_manual_submit() {
        let (_tmp, db) = setup();
        let q = seed(&db, false);
        let first = create_draft(&db, request(&q)).unwrap();
        let saved = save(&db, &first, "B");
        let latest = save(&db, &saved, "A");
        let automatic = submit_draft_with_revision(&db, &first.id, None).unwrap();
        assert_eq!(automatic.answers[&q.id], "A");
        assert_eq!(automatic.results[0].status, "correct");
        let replay = submit_draft(&db, &first.id, latest.revision).unwrap();
        assert_eq!(
            automatic.results[0].submission_id,
            replay.results[0].submission_id
        );
    }

    #[test]
    fn grading_uses_frozen_answer_even_after_source_changes_or_is_deleted() {
        let (_tmp, db) = setup();
        let q = seed(&db, false);
        let draft = create_draft(&db, request(&q)).unwrap();
        let draft = save(&db, &draft, "A");
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE questions SET answer='B',content='Edited',deleted_at=?2 WHERE id=?1",
            params![q.id, now()],
        )
        .unwrap();
        drop(conn);
        let result = submit_draft(&db, &draft.id, draft.revision).unwrap();
        assert_eq!(result.questions[0].content, "Choose the answer");
        assert_eq!(result.results[0].status, "correct");
        assert!(!result.results[0].source_available);
    }

    #[test]
    fn subjective_answers_are_pending_and_unanswered_are_not_wrong() {
        let (_tmp, db) = setup();
        let q = seed(&db, true);
        let draft = create_draft(&db, request(&q)).unwrap();
        let saved = save(&db, &draft, "My explanation");
        let attempt = submit_draft(&db, &saved.id, saved.revision).unwrap();
        assert_eq!(attempt.status, "grading");
        assert_eq!(attempt.results[0].is_correct, None);
        assert_eq!(attempt.results[0].status, "pending");
        let second = create_draft(&db, request(&q)).unwrap();
        let unanswered = submit_draft(&db, &second.id, second.revision).unwrap();
        assert_eq!(unanswered.results[0].status, "unanswered");
        assert_eq!(unanswered.results[0].is_correct, None);
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM qbank_practice_jobs WHERE status='queued'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            VfsQuestionRepo::get_question_with_conn(&conn, &q.id)
                .unwrap()
                .unwrap()
                .attempt_count,
            1
        );
    }

    #[test]
    fn failed_practice_grading_retains_drafts_on_reload_without_grades_or_learning_writes() {
        let (_tmp, db) = setup();
        let q = seed(&db, true);
        let draft = create_draft(&db, request(&q)).unwrap();
        let saved = save(&db, &draft, "My answer");
        let mut attempt = submit_draft(&db, &saved.id, saved.revision).unwrap();
        let submission_id = attempt.results[0].submission_id.clone().unwrap();
        let diagnostics = GradingDiagnostics {
            status: crate::qbank_grading::types::GradingCompletionStatus::Truncated,
            model: "test".into(),
            model_config_id: "test-id".into(),
            max_output_tokens: 128000,
            finish_reason: Some("length".into()),
            usage: Some(serde_json::json!({"completion_tokens":128000})),
            response_chars: 7,
            reasoning_chars: 90000,
            http_status: Some(200),
            error_message: Some("truncated".into()),
        };
        for text in ["draft one", "draft two"] {
            attempt.results[0].status = "pending".into();
            record_grading_failure(
                &mut attempt.results[0],
                GradingFailure {
                    error: AppError::llm("truncated"),
                    feedback: text.into(),
                    diagnostics: Some(diagnostics.clone()),
                },
            );
        }
        refresh_status(&mut attempt);
        let conn = db.get_conn_safe().unwrap();
        persist_attempt(&conn, &attempt).unwrap();
        let loaded = load_attempt(&conn, &attempt.id).unwrap();
        let result = &loaded.results[0];
        assert_eq!(loaded.status, "needs_review");
        assert_eq!(result.status, "failed");
        assert_eq!(result.is_correct, None);
        assert_eq!(result.score, None);
        assert_eq!(result.feedback, None);
        assert_eq!(result.grading_drafts.len(), 2);
        assert_eq!(result.grading_drafts[0].feedback, "draft one");
        assert_eq!(
            result.grading_drafts[1]
                .diagnostics
                .as_ref()
                .unwrap()
                .finish_reason
                .as_deref(),
            Some("length")
        );
        assert_eq!(
            crate::qbank_grading::pipeline::get_submission_by_id_with_conn(&conn, &submission_id)
                .unwrap()
                .unwrap()
                .is_correct,
            None
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM mastery_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            VfsQuestionRepo::get_question_with_conn(&conn, &q.id)
                .unwrap()
                .unwrap()
                .correct_count,
            0
        );
    }

    #[test]
    fn practice_verdict_persistence_error_rolls_back_partial_learning_writes() {
        let (_tmp, db) = setup();
        let q = seed(&db, true);
        let draft = create_draft(&db, request(&q)).unwrap();
        let saved = save(&db, &draft, "My answer");
        let mut attempt = submit_draft(&db, &saved.id, saved.revision).unwrap();
        let sid = attempt.results[0].submission_id.clone().unwrap();
        let mut conn = db.get_conn_safe().unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute_batch("CREATE TEMP TRIGGER fail_practice_grade BEFORE UPDATE ON questions BEGIN SELECT RAISE(ABORT, 'disk write failed'); END;").unwrap();
        let error = match apply_practice_verdict(&tx, &db, &q.id, Some(&sid), true) {
            Err(error) => error,
            Ok(_) => panic!("grade write must fail"),
        };
        assert!(error.message.contains("disk write failed"));
        record_grading_failure(
            &mut attempt.results[0],
            GradingFailure {
                error,
                feedback: "Finished feedback <verdict>correct</verdict>".into(),
                diagnostics: None,
            },
        );
        refresh_status(&mut attempt);
        persist_attempt(&tx, &attempt).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            crate::qbank_grading::pipeline::get_submission_by_id_with_conn(&conn, &sid)
                .unwrap()
                .unwrap()
                .is_correct,
            None
        );
        assert_eq!(
            load_attempt(&conn, &attempt.id).unwrap().results[0]
                .grading_drafts
                .len(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM mastery_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            VfsQuestionRepo::get_question_with_conn(&conn, &q.id)
                .unwrap()
                .unwrap()
                .correct_count,
            0
        );
    }

    #[test]
    fn papers_keep_answers_when_export_hides_them_and_restore_with_the_exam() {
        let (_tmp, db) = setup();
        let q = seed(&db, false);
        let service = QuestionBankService::new(db.clone());
        let paper = service
            .generate_paper(
                &q.exam_id,
                crate::question_bank_service::PaperConfig {
                    include_answers: false,
                    include_explanations: false,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(paper.questions[0].answer.as_deref(), Some("A"));
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(load_paper(&conn, &paper.id).unwrap().questions.len(), 1);
        crate::vfs::repos::VfsExamRepo::delete_exam_sheet_with_conn(&conn, &q.exam_id).unwrap();
        assert!(load_paper(&conn, &paper.id).is_err());
        crate::vfs::repos::VfsExamRepo::restore_exam_with_conn(&conn, &q.exam_id).unwrap();
        assert!(load_paper(&conn, &paper.id).is_ok());
    }

    #[test]
    fn snapshots_retain_question_and_answer_image_references() {
        let (_tmp, db) = setup();
        let q = seed(&db, false);
        let draft = create_draft(&db, request(&q)).unwrap();
        let conn = db.get_conn_safe().unwrap();
        let mut raw: serde_json::Value = serde_json::to_value(&draft).unwrap();
        raw["questions"][0]["images"] = serde_json::json!([{"id":"snapshot-image","hash":"snapshot-hash","name":"image","mime":"image/png"}]);
        raw["answers"][&q.id] = serde_json::json!(serde_json::json!({"type":"image_answer","images":[{"id":"answer-image","hash":"answer-hash"}]}).to_string());
        conn.execute(
            "UPDATE qbank_practice_drafts SET document_json=?2 WHERE id=?1",
            params![draft.id, raw.to_string()],
        )
        .unwrap();
        assert!(retains_asset(&conn, "snapshot-image").unwrap());
        assert!(retains_asset(&conn, "answer-hash").unwrap());
        assert!(!retains_asset(&conn, "unrelated").unwrap());
    }

    #[test]
    fn historical_correction_does_not_replace_a_newer_answer_verdict() {
        let (_tmp, db) = setup();
        let q = seed(&db, false);
        let service = QuestionBankService::new(db.clone());
        let old = service
            .submit_answer(&q.id, "B", None, Some("old-answer"))
            .unwrap();
        service
            .submit_answer(&q.id, "B", None, Some("new-answer"))
            .unwrap();
        let mut conn = db.get_conn_safe().unwrap();
        let tx = conn.transaction().unwrap();
        let submission =
            crate::qbank_grading::pipeline::get_submission_by_id_with_conn(&tx, &old.submission_id)
                .unwrap()
                .unwrap();
        service
            .apply_submission_verdict_in_tx(&tx, &q, &submission, true, "ai", &now())
            .unwrap();
        tx.commit().unwrap();
        drop(conn);
        let current = VfsQuestionRepo::get_question(&db, &q.id).unwrap().unwrap();
        assert_eq!(current.user_answer.as_deref(), Some("B"));
        assert_eq!(current.is_correct, Some(false));
        assert_eq!(current.correct_count, 1);
        assert_eq!(current.status, crate::vfs::repos::QuestionStatus::Review);
    }
}
