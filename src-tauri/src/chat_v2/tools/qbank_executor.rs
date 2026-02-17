use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::LazyLock;
use tokio::sync::Mutex;

use super::builtin_retrieval_executor::BUILTIN_NAMESPACE;
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::models::{
    AppError, Difficulty as ModelsDifficulty, ExamCardPreview, ExamSheetPreviewPage,
    ExamSheetPreviewResult, ExamSheetSessionDetail, ExamSheetSessionMetadata,
    ExamSheetSessionSummary, QuestionBankStats, QuestionStatus as ModelsQuestionStatus,
    QuestionType, SourceType,
};
use crate::question_bank_service::QuestionBankService;
use crate::vfs::repos::{
    CreateQuestionParams, Difficulty, Question, QuestionFilters, QuestionImage, QuestionOption,
    QuestionStatus, SourceType as RepoSourceType, UpdateQuestionParams, VfsExamRepo,
    VfsQuestionRepo,
};

static QBANK_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// 🆕 2026-01 改造：优先使用 QuestionBankService 查询 questions 表
/// 如果服务不可用或迁移未完成，回退到解析 preview_json
fn check_answer_correctness(
    user_answer: &str,
    correct_answer: &str,
    question_type: &Option<QuestionType>,
) -> bool {
    let normalize = |s: &str| {
        s.trim()
            .to_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
    };
    let normalize_choice = |s: &str| {
        s.to_uppercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
    };

    match question_type {
        Some(QuestionType::MultipleChoice) => {
            let mut user_chars: Vec<char> = normalize_choice(user_answer).chars().collect();
            let mut correct_chars: Vec<char> = normalize_choice(correct_answer).chars().collect();
            user_chars.sort();
            correct_chars.sort();
            user_chars == correct_chars
        }
        Some(QuestionType::SingleChoice) => {
            normalize_choice(user_answer) == normalize_choice(correct_answer)
        }
        _ => normalize(user_answer) == normalize(correct_answer),
    }
}

pub struct QBankExecutor;

impl QBankExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 从工具名称中去除前缀
    ///
    /// 支持的前缀：builtin-, mcp_
    fn strip_namespace(tool_name: &str) -> &str {
        tool_name
            .strip_prefix(BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name)
    }

    /// 读取全部题目（自动分页）
    fn list_all_questions(
        &self,
        service: &QuestionBankService,
        session_id: &str,
        filters: &QuestionFilters,
    ) -> Result<Vec<Question>, String> {
        let mut page = 1;
        let page_size = 200;
        let mut all = Vec::new();

        loop {
            let result = service
                .list_questions(session_id, filters, page, page_size)
                .map_err(|e| format!("Failed to list questions: {}", e))?;
            all.extend(result.questions);
            if !result.has_more {
                break;
            }
            page = page.saturating_add(1);
            if page > 10_000 {
                log::warn!(
                    "[QBankExecutor] list_all_questions exceeded page limit, session_id={}",
                    session_id
                );
                break;
            }
        }

        Ok(all)
    }

    /// 列出所有题目集（不需要 session_id）
    async fn execute_list(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        let limit = call
            .arguments
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(20) as u32;
        let limit = limit.min(500); // M-043: 最大 500 条
        let offset = call
            .arguments
            .get("offset")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as u32;
        let search = call.arguments.get("search").and_then(|v| v.as_str());
        let include_stats = call
            .arguments
            .get("include_stats")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exams = VfsExamRepo::list_exam_sheets(vfs_db, search, limit, offset)
            .map_err(|e| format!("Failed to list exam sheets: {}", e))?;

        let question_banks: Vec<Value> = exams
            .iter()
            .map(|exam| {
                let mut bank = json!({
                    "session_id": exam.id,
                    "name": exam.exam_name.clone().unwrap_or_else(|| "未命名题目集".to_string()),
                    "status": exam.status,
                    "created_at": exam.created_at,
                    "updated_at": exam.updated_at,
                    "is_favorite": exam.is_favorite,
                });

                if include_stats {
                    let mut stats_set = false;

                    if let Some(service) = &ctx.question_bank_service {
                        match service.get_stats(&exam.id) {
                            Ok(Some(stats)) => {
                                bank["stats"] = json!({
                                    "total": stats.total_count,
                                    "mastered": stats.mastered_count,
                                    "review": stats.review_count,
                                    "in_progress": stats.in_progress_count,
                                    "new": stats.new_count,
                                    "correct_rate": stats.correct_rate,
                                });
                                stats_set = true;
                            }
                            _ => {
                                if let Ok(stats) = service.refresh_stats(&exam.id) {
                                    bank["stats"] = json!({
                                        "total": stats.total_count,
                                        "mastered": stats.mastered_count,
                                        "review": stats.review_count,
                                        "in_progress": stats.in_progress_count,
                                        "new": stats.new_count,
                                        "correct_rate": stats.correct_rate,
                                    });
                                    stats_set = true;
                                }
                            }
                        }
                    }

                    if !stats_set {
                        if let Ok(preview) = serde_json::from_value::<ExamSheetPreviewResult>(
                            exam.preview_json.clone(),
                        ) {
                            let mut total = 0;
                            let mut mastered = 0;
                            let mut review = 0;
                            let mut in_progress = 0;
                            let mut new_count = 0;
                            let mut total_attempts = 0;
                            let mut total_correct = 0;

                            for page in &preview.pages {
                                for card in &page.cards {
                                    total += 1;
                                    match &card.status {
                                        ModelsQuestionStatus::Mastered => mastered += 1,
                                        ModelsQuestionStatus::Review => review += 1,
                                        ModelsQuestionStatus::InProgress => in_progress += 1,
                                        ModelsQuestionStatus::New => new_count += 1,
                                    }
                                    total_attempts += card.attempt_count;
                                    total_correct += card.correct_count;
                                }
                            }

                            let correct_rate = if total_attempts > 0 {
                                (total_correct as f64) / (total_attempts as f64)
                            } else {
                                0.0
                            };

                            bank["stats"] = json!({
                                "total": total,
                                "mastered": mastered,
                                "review": review,
                                "in_progress": in_progress,
                                "new": new_count,
                                "correct_rate": correct_rate,
                                "source": "preview_json",
                                "degraded": true
                            });
                        }
                    }
                }

                bank
            })
            .collect();

        Ok(json!({
            "total": question_banks.len(),
            "question_banks": question_banks,
            "limit": limit,
            "offset": offset,
        }))
    }

    /// 🆕 2026-01 改造：优先使用 QuestionBankService 查询 questions 表
    async fn execute_list_questions(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;

        let status_filter = call.arguments.get("status").and_then(|v| v.as_str());
        let difficulty_filter = call.arguments.get("difficulty").and_then(|v| v.as_str());
        let tags_filter: Option<Vec<String>> = call
            .arguments
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        let page = call
            .arguments
            .get("page")
            .and_then(|v| v.as_i64())
            .unwrap_or(1) as u32;
        let page = page.max(1);
        let page_size = call
            .arguments
            .get("page_size")
            .and_then(|v| v.as_i64())
            .unwrap_or(20) as u32;
        let page_size = page_size.min(500); // M-043: 最大 500 条

        // 🆕 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            // 将字符串转换为枚举类型
            let status_enum: Option<Vec<QuestionStatus>> = status_filter.and_then(|s| {
                serde_json::from_value(serde_json::json!(s))
                    .ok()
                    .map(|v| vec![v])
            });
            let difficulty_enum: Option<Vec<Difficulty>> = difficulty_filter.and_then(|d| {
                serde_json::from_value(serde_json::json!(d))
                    .ok()
                    .map(|v| vec![v])
            });

            let filters = QuestionFilters {
                status: status_enum,
                difficulty: difficulty_enum,
                tags: tags_filter.clone(),
                ..Default::default()
            };

            match service.list_questions(session_id, &filters, page, page_size) {
                Ok(result) => {
                    let questions: Vec<Value> = result
                        .questions
                        .iter()
                        .map(|q| {
                            json!({
                                "card_id": q.card_id.clone().unwrap_or_else(|| q.id.clone()),
                                "label": q.question_label,
                                "content_preview": q.content.chars().take(100).collect::<String>(),
                                "status": q.status,
                                "difficulty": q.difficulty,
                                "tags": q.tags,
                                "attempt_count": q.attempt_count,
                                "correct_count": q.correct_count,
                                "has_images": !q.images.is_empty(),
                            })
                        })
                        .collect();

                    return Ok(json!({
                        "total": result.total,
                        "page": page,
                        "page_size": page_size,
                        "questions": questions,
                        "source": "questions_table"
                    }));
                }
                Err(e) => {
                    log::warn!(
                        "[QBankExecutor] QuestionBankService failed, falling back to preview: {}",
                        e
                    );
                }
            }
        }

        // 回退：解析 preview_json
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut all_cards: Vec<&ExamCardPreview> =
            preview.pages.iter().flat_map(|p| p.cards.iter()).collect();

        if let Some(status) = status_filter {
            all_cards.retain(|c| {
                let card_status = serde_json::to_value(&c.status)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "new".to_string());
                card_status == status
            });
        }

        if let Some(diff) = difficulty_filter {
            all_cards.retain(|c| {
                c.difficulty
                    .as_ref()
                    .map(|d| {
                        serde_json::to_value(d)
                            .ok()
                            .and_then(|v| v.as_str().map(String::from))
                            .unwrap_or_default()
                    })
                    .unwrap_or_default()
                    == diff
            });
        }

        if let Some(tags) = &tags_filter {
            all_cards.retain(|c| tags.iter().any(|t| c.tags.contains(t)));
        }

        let total = all_cards.len();
        let start = (page.saturating_sub(1) * page_size) as usize;
        let questions: Vec<Value> = all_cards
            .iter()
            .skip(start)
            .take(page_size as usize)
            .map(|c| {
                json!({
                    "card_id": c.card_id,
                    "label": c.question_label,
                    "content_preview": c.ocr_text.chars().take(100).collect::<String>(),
                    "status": c.status,
                    "difficulty": c.difficulty,
                    "tags": c.tags,
                    "attempt_count": c.attempt_count,
                    "correct_count": c.correct_count,
                })
            })
            .collect();

        Ok(json!({
            "total": total,
            "page": page,
            "page_size": page_size,
            "questions": questions,
            "source": "preview_json"
        }))
    }

    /// 🆕 2026-01 改造：优先使用 QuestionBankService
    async fn execute_get_question(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let card_id = call
            .arguments
            .get("card_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'card_id' parameter")?;

        // 🆕 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            if let Ok(Some(q)) = service.get_question_by_card_id(session_id, card_id) {
                // 获取最近 5 条作答历史
                let submissions = service.get_submissions(&q.id, 5).unwrap_or_default();
                let submissions_json: Vec<Value> = submissions
                    .iter()
                    .map(|s| {
                        json!({
                            "answer": s.user_answer,
                            "is_correct": s.is_correct,
                            "method": s.grading_method,
                            "at": s.submitted_at,
                        })
                    })
                    .collect();

                return Ok(json!({
                    "card_id": q.card_id.clone().unwrap_or_else(|| q.id.clone()),
                    "label": q.question_label,
                    "content": q.content,
                    "question_type": q.question_type,
                    "answer": q.answer,
                    "explanation": q.explanation,
                    "difficulty": q.difficulty,
                    "status": q.status,
                    "tags": q.tags,
                    "user_answer": q.user_answer,
                    "is_correct": q.is_correct,
                    "attempt_count": q.attempt_count,
                    "correct_count": q.correct_count,
                    "last_attempt_at": q.last_attempt_at,
                    "user_note": q.user_note,
                    "images": q.images,
                    "recent_submissions": submissions_json,
                    "source": "questions_table"
                }));
            }
        }

        // 回退：解析 preview_json
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let card = preview
            .pages
            .iter()
            .flat_map(|p| p.cards.iter())
            .find(|c| c.card_id == card_id)
            .ok_or("Question not found")?;

        Ok(json!({
            "card_id": card.card_id,
            "label": card.question_label,
            "content": card.ocr_text,
            "question_type": card.question_type,
            "answer": card.answer,
            "explanation": card.explanation,
            "difficulty": card.difficulty,
            "status": card.status,
            "tags": card.tags,
            "user_answer": card.user_answer,
            "is_correct": card.is_correct,
            "attempt_count": card.attempt_count,
            "correct_count": card.correct_count,
            "last_attempt_at": card.last_attempt_at,
            "user_note": card.user_note,
            "source": "preview_json"
        }))
    }

    /// 🆕 2026-01 改造：优先使用 QuestionBankService
    async fn execute_submit_answer(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let _write_guard = QBANK_WRITE_LOCK.lock().await;

        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let card_id = call
            .arguments
            .get("card_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'card_id' parameter")?;
        let user_answer = call
            .arguments
            .get("user_answer")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'user_answer' parameter")?;
        // M-065: user_answer 长度校验
        if user_answer.len() > 50000 {
            return Err("答案内容过长（上限 50000 字符）".to_string());
        }
        let is_correct_override = call.arguments.get("is_correct").and_then(|v| v.as_bool());

        // 🆕 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            // 先通过 card_id 获取 question_id
            if let Ok(Some(question)) = service.get_question_by_card_id(session_id, card_id) {
                match service.submit_answer(&question.id, user_answer, is_correct_override) {
                    Ok(result) => {
                        return Ok(json!({
                            "is_correct": result.is_correct,
                            "correct_answer": result.correct_answer,
                            "needs_manual_grading": result.needs_manual_grading,
                            "message": result.message,
                            "submission_id": result.submission_id,
                            "source": "questions_table"
                        }));
                    }
                    Err(e) => {
                        log::warn!(
                            "[QBankExecutor] QuestionBankService submit_answer failed: {}",
                            e
                        );
                    }
                }
            }
        }

        // 回退：使用 preview_json
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let mut preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut found = false;
        let mut is_correct: Option<bool> = Some(false);
        let mut correct_answer = String::new();
        let mut question_type: Option<QuestionType> = None;
        let mut needs_manual_grading = false;

        for page in &mut preview.pages {
            for card in &mut page.cards {
                if card.card_id == card_id {
                    found = true;
                    card.user_answer = Some(user_answer.to_string());
                    card.attempt_count += 1;
                    card.last_attempt_at = Some(chrono::Utc::now().to_rfc3339());
                    question_type = card.question_type.clone();

                    let is_subjective = matches!(
                        card.question_type,
                        Some(QuestionType::Essay)
                            | Some(QuestionType::ShortAnswer)
                            | Some(QuestionType::Calculation)
                            | Some(QuestionType::Proof)
                    );

                    if is_subjective && is_correct_override.is_none() {
                        // M-063: 主观题 is_correct 设为 None，避免工具调用方误判为"错误"
                        needs_manual_grading = true;
                        is_correct = None;
                        card.status = ModelsQuestionStatus::InProgress;
                        card.is_correct = None;
                    } else {
                        let correct = is_correct_override.unwrap_or_else(|| {
                            card.answer
                                .as_ref()
                                .map(|a| {
                                    check_answer_correctness(user_answer, a, &card.question_type)
                                })
                                .unwrap_or(false)
                        });
                        is_correct = Some(correct);

                        card.is_correct = Some(correct);
                        if correct {
                            card.correct_count += 1;
                            if card.correct_count >= 2 {
                                card.status = ModelsQuestionStatus::Mastered;
                            } else {
                                card.status = ModelsQuestionStatus::InProgress;
                            }
                        } else {
                            card.status = ModelsQuestionStatus::Review;
                        }
                    }

                    correct_answer = card.answer.clone().unwrap_or_default();
                    break;
                }
            }
            if found {
                break;
            }
        }

        if !found {
            return Err("Question not found".to_string());
        }

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| format!("Failed to serialize preview: {}", e))?;

        VfsExamRepo::update_preview_json(vfs_db, session_id, preview_json)
            .map_err(|e| format!("Failed to update exam sheet: {}", e))?;

        Ok(json!({
            "is_correct": is_correct,
            "correct_answer": correct_answer,
            "needs_manual_grading": needs_manual_grading,
            "message": if needs_manual_grading {
                "主观题已提交，请参考答案自行判断。"
            } else if is_correct == Some(true) {
                "回答正确！"
            } else {
                "回答错误，请查看正确答案。"
            },
            "source": "preview_json",
            "degraded": true
        }))
    }

    async fn execute_update_question(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let _write_guard = QBANK_WRITE_LOCK.lock().await;

        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let card_id = call
            .arguments
            .get("card_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'card_id' parameter")?;

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            if let Ok(Some(question)) = service.get_question_by_card_id(session_id, card_id) {
                let mut params = UpdateQuestionParams::default();
                if let Some(answer) = call.arguments.get("answer").and_then(|v| v.as_str()) {
                    params.answer = Some(answer.to_string());
                }
                if let Some(explanation) =
                    call.arguments.get("explanation").and_then(|v| v.as_str())
                {
                    params.explanation = Some(explanation.to_string());
                }
                if let Some(difficulty) = call.arguments.get("difficulty").and_then(|v| v.as_str())
                {
                    params.difficulty = serde_json::from_value(serde_json::json!(difficulty)).ok();
                }
                if let Some(tags) = call.arguments.get("tags").and_then(|v| v.as_array()) {
                    params.tags = Some(
                        tags.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect(),
                    );
                }
                if let Some(note) = call.arguments.get("user_note").and_then(|v| v.as_str()) {
                    params.user_note = Some(note.to_string());
                }
                if let Some(status) = call.arguments.get("status").and_then(|v| v.as_str()) {
                    params.status = serde_json::from_value(serde_json::json!(status)).ok();
                }
                if let Some(images) = call.arguments.get("images").and_then(|v| v.as_array()) {
                    params.images = Some(
                        images
                            .iter()
                            .filter_map(|img| {
                                let id = img.get("id").and_then(|v| v.as_str())?.to_string();
                                let name = img
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let mime = img
                                    .get("mime")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("image/png")
                                    .to_string();
                                let hash = img
                                    .get("hash")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                Some(QuestionImage {
                                    id,
                                    name,
                                    mime,
                                    hash,
                                })
                            })
                            .collect(),
                    );
                }

                if service
                    .update_question(&question.id, &params, false)
                    .is_ok()
                {
                    return Ok(
                        json!({ "success": true, "message": "题目已更新", "source": "questions_table" }),
                    );
                }
            }
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let mut preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut found = false;
        for page in &mut preview.pages {
            for card in &mut page.cards {
                if card.card_id == card_id {
                    found = true;
                    if let Some(answer) = call.arguments.get("answer").and_then(|v| v.as_str()) {
                        card.answer = Some(answer.to_string());
                    }
                    if let Some(explanation) =
                        call.arguments.get("explanation").and_then(|v| v.as_str())
                    {
                        card.explanation = Some(explanation.to_string());
                    }
                    if let Some(difficulty) =
                        call.arguments.get("difficulty").and_then(|v| v.as_str())
                    {
                        card.difficulty = Some(match difficulty {
                            "easy" => ModelsDifficulty::Easy,
                            "medium" => ModelsDifficulty::Medium,
                            "hard" => ModelsDifficulty::Hard,
                            "very_hard" => ModelsDifficulty::VeryHard,
                            _ => ModelsDifficulty::Medium,
                        });
                    }
                    if let Some(tags) = call.arguments.get("tags").and_then(|v| v.as_array()) {
                        card.tags = tags
                            .iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect();
                    }
                    if let Some(note) = call.arguments.get("user_note").and_then(|v| v.as_str()) {
                        card.user_note = Some(note.to_string());
                    }
                    if let Some(status) = call.arguments.get("status").and_then(|v| v.as_str()) {
                        card.status = match status {
                            "new" => ModelsQuestionStatus::New,
                            "in_progress" => ModelsQuestionStatus::InProgress,
                            "mastered" => ModelsQuestionStatus::Mastered,
                            "review" => ModelsQuestionStatus::Review,
                            _ => ModelsQuestionStatus::New,
                        };
                    }
                    break;
                }
            }
            if found {
                break;
            }
        }

        if !found {
            return Err("Question not found".to_string());
        }

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| format!("Failed to serialize preview: {}", e))?;

        VfsExamRepo::update_preview_json(vfs_db, session_id, preview_json)
            .map_err(|e| format!("Failed to update exam sheet: {}", e))?;

        Ok(
            json!({ "success": true, "message": "题目已更新", "source": "preview_json", "degraded": true }),
        )
    }

    async fn execute_get_stats(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            if let Ok(Some(stats)) = service.get_stats(session_id) {
                return Ok(json!({
                    "total": stats.total_count,
                    "new": stats.new_count,
                    "in_progress": stats.in_progress_count,
                    "mastered": stats.mastered_count,
                    "review": stats.review_count,
                    "correct_rate": stats.correct_rate,
                    "total_attempts": stats.total_attempts,
                    "total_correct": stats.total_correct,
                    "source": "questions_table"
                }));
            }
            if let Ok(stats) = service.refresh_stats(session_id) {
                return Ok(json!({
                    "total": stats.total_count,
                    "new": stats.new_count,
                    "in_progress": stats.in_progress_count,
                    "mastered": stats.mastered_count,
                    "review": stats.review_count,
                    "correct_rate": stats.correct_rate,
                    "total_attempts": stats.total_attempts,
                    "total_correct": stats.total_correct,
                    "source": "questions_table"
                }));
            }
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut stats = QuestionBankStats::default();
        let mut total_attempts = 0;
        let mut total_correct = 0;

        for page in &preview.pages {
            for card in &page.cards {
                stats.total_count += 1;
                match card.status {
                    ModelsQuestionStatus::New => stats.new_count += 1,
                    ModelsQuestionStatus::InProgress => stats.in_progress_count += 1,
                    ModelsQuestionStatus::Mastered => stats.mastered_count += 1,
                    ModelsQuestionStatus::Review => stats.review_count += 1,
                }
                total_attempts += card.attempt_count;
                total_correct += card.correct_count;
            }
        }

        if total_attempts > 0 {
            stats.correct_rate = Some(total_correct as f64 / total_attempts as f64);
        }

        Ok(json!({
            "total": stats.total_count,
            "new": stats.new_count,
            "in_progress": stats.in_progress_count,
            "mastered": stats.mastered_count,
            "review": stats.review_count,
            "correct_rate": stats.correct_rate,
            "total_attempts": total_attempts,
            "total_correct": total_correct,
            "source": "preview_json",
            "degraded": true
        }))
    }

    async fn execute_get_next_question(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let mode = call
            .arguments
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("sequential");
        let tag_filter = call.arguments.get("tag").and_then(|v| v.as_str());
        let current_card_id = call
            .arguments
            .get("current_card_id")
            .and_then(|v| v.as_str());

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            let questions =
                self.list_all_questions(service, session_id, &QuestionFilters::default())?;
            if questions.is_empty() {
                return Ok(json!({ "message": "题目集为空" }));
            }

            let next_question: Option<&Question> = match mode {
                "random" => {
                    use rand::seq::SliceRandom;
                    questions.choose(&mut rand::thread_rng())
                }
                "review_first" => questions
                    .iter()
                    .find(|q| matches!(q.status, QuestionStatus::Review))
                    .or_else(|| {
                        questions
                            .iter()
                            .find(|q| matches!(q.status, QuestionStatus::New))
                    })
                    .or_else(|| {
                        questions
                            .iter()
                            .find(|q| matches!(q.status, QuestionStatus::InProgress))
                    }),
                "by_tag" => {
                    if let Some(tag) = tag_filter {
                        questions.iter().find(|q| {
                            q.tags.contains(&tag.to_string())
                                && !matches!(q.status, QuestionStatus::Mastered)
                        })
                    } else {
                        questions.first()
                    }
                }
                _ => {
                    if let Some(current_id) = current_card_id {
                        let current_idx = questions
                            .iter()
                            .position(|q| q.card_id.as_deref().unwrap_or(&q.id) == current_id);
                        if let Some(idx) = current_idx {
                            questions.get(idx + 1)
                        } else {
                            questions.first()
                        }
                    } else {
                        questions.first()
                    }
                }
            };

            return match next_question {
                Some(q) => Ok(json!({
                    "card_id": q.card_id.clone().unwrap_or_else(|| q.id.clone()),
                    "label": q.question_label,
                    "content": q.content,
                    "question_type": q.question_type,
                    "difficulty": q.difficulty,
                    "status": q.status,
                    "tags": q.tags,
                    "images": q.images,
                    "source": "questions_table"
                })),
                None => Ok(json!({ "message": "没有更多题目" })),
            };
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let all_cards: Vec<&ExamCardPreview> =
            preview.pages.iter().flat_map(|p| p.cards.iter()).collect();

        if all_cards.is_empty() {
            return Ok(json!({ "message": "题目集为空" }));
        }

        let next_card: Option<&ExamCardPreview> = match mode {
            "random" => {
                use rand::seq::SliceRandom;
                all_cards.choose(&mut rand::thread_rng()).copied()
            }
            "review_first" => all_cards
                .iter()
                .find(|c| matches!(c.status, ModelsQuestionStatus::Review))
                .or_else(|| {
                    all_cards
                        .iter()
                        .find(|c| matches!(c.status, ModelsQuestionStatus::New))
                })
                .or_else(|| {
                    all_cards
                        .iter()
                        .find(|c| matches!(c.status, ModelsQuestionStatus::InProgress))
                })
                .copied(),
            "by_tag" => {
                if let Some(tag) = tag_filter {
                    all_cards
                        .iter()
                        .find(|c| {
                            c.tags.contains(&tag.to_string())
                                && !matches!(c.status, ModelsQuestionStatus::Mastered)
                        })
                        .copied()
                } else {
                    all_cards.first().copied()
                }
            }
            _ => {
                if let Some(current_id) = current_card_id {
                    let current_idx = all_cards.iter().position(|c| c.card_id == current_id);
                    if let Some(idx) = current_idx {
                        all_cards.get(idx + 1).copied()
                    } else {
                        all_cards.first().copied()
                    }
                } else {
                    all_cards.first().copied()
                }
            }
        };

        match next_card {
            Some(card) => Ok(json!({
                "card_id": card.card_id,
                "label": card.question_label,
                "content": card.ocr_text,
                "question_type": card.question_type,
                "difficulty": card.difficulty,
                "status": card.status,
                "tags": card.tags,
                "source": "preview_json",
                "degraded": true
            })),
            None => Ok(json!({ "message": "没有更多题目" })),
        }
    }

    async fn execute_reset_progress(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let _write_guard = QBANK_WRITE_LOCK.lock().await;

        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let card_ids: Option<Vec<&str>> = call
            .arguments
            .get("card_ids")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect());

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            if let Some(card_ids) = &card_ids {
                let mut question_ids = Vec::new();
                for card_id in card_ids {
                    if let Ok(Some(q)) = service.get_question_by_card_id(session_id, card_id) {
                        question_ids.push(q.id);
                    }
                }
                let result = service
                    .reset_questions_progress(&question_ids)
                    .map_err(|e| format!("Failed to reset progress: {}", e))?;
                return Ok(json!({
                    "success": true,
                    "reset_count": result.success_count,
                    "message": format!("已重置 {} 道题目的学习进度", result.success_count),
                    "source": "questions_table"
                }));
            } else {
                let stats = service
                    .reset_progress(session_id)
                    .map_err(|e| format!("Failed to reset progress: {}", e))?;
                return Ok(json!({
                    "success": true,
                    "reset_count": stats.total_count,
                    "message": format!("已重置 {} 道题目的学习进度", stats.total_count),
                    "source": "questions_table"
                }));
            }
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let mut preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut reset_count = 0;
        for page in &mut preview.pages {
            for card in &mut page.cards {
                let should_reset = card_ids
                    .as_ref()
                    .map(|ids| ids.contains(&card.card_id.as_str()))
                    .unwrap_or(true);

                if should_reset {
                    card.status = ModelsQuestionStatus::New;
                    card.user_answer = None;
                    card.is_correct = None;
                    card.attempt_count = 0;
                    card.correct_count = 0;
                    card.last_attempt_at = None;
                    reset_count += 1;
                }
            }
        }

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| format!("Failed to serialize preview: {}", e))?;

        VfsExamRepo::update_preview_json(vfs_db, session_id, preview_json)
            .map_err(|e| format!("Failed to update exam sheet: {}", e))?;

        Ok(json!({
            "success": true,
            "reset_count": reset_count,
            "message": format!("已重置 {} 道题目的学习进度", reset_count),
            "source": "preview_json",
            "degraded": true
        }))
    }

    async fn execute_export(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let format = call
            .arguments
            .get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("json");
        let include_stats = call
            .arguments
            .get("include_stats")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let filter_status = call.arguments.get("filter_status").and_then(|v| v.as_str());

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            let exam_name = if let Some(vfs_db) = &ctx.vfs_db {
                VfsExamRepo::get_exam_sheet(vfs_db, session_id)
                    .ok()
                    .flatten()
                    .and_then(|exam| exam.exam_name)
                    .unwrap_or_else(|| "题目集".to_string())
            } else {
                "题目集".to_string()
            };
            let status_enum: Option<Vec<QuestionStatus>> = filter_status
                .and_then(|s| serde_json::from_value(serde_json::json!(s)).ok())
                .map(|v| vec![v]);
            let filters = QuestionFilters {
                status: status_enum,
                ..Default::default()
            };
            let questions_list = self.list_all_questions(service, session_id, &filters)?;
            let questions: Vec<Value> = questions_list
                .iter()
                .map(|q| {
                    json!({
                        "label": q.question_label,
                        "content": q.content,
                        "question_type": q.question_type,
                        "answer": q.answer,
                        "explanation": q.explanation,
                        "difficulty": q.difficulty,
                        "tags": q.tags,
                        "status": q.status,
                        "attempt_count": q.attempt_count,
                        "correct_count": q.correct_count,
                        "user_note": q.user_note,
                        "images": q.images,
                    })
                })
                .collect();

            if format == "markdown" {
                let mut md = format!("# {}\n\n", exam_name);
                for (i, q) in questions.iter().enumerate() {
                    md.push_str(&format!("## 题目 {}\n\n", i + 1));
                    md.push_str(&format!(
                        "**题干**\n{}\n\n",
                        q.get("content").and_then(|v| v.as_str()).unwrap_or("")
                    ));
                    if let Some(answer) = q.get("answer").and_then(|v| v.as_str()) {
                        md.push_str(&format!("**答案**\n{}\n\n", answer));
                    }
                    if let Some(explanation) = q.get("explanation").and_then(|v| v.as_str()) {
                        md.push_str(&format!("**解析**\n{}\n\n", explanation));
                    }
                    md.push_str("---\n\n");
                }
                return Ok(json!({
                    "format": "markdown",
                    "content": md,
                    "question_count": questions.len(),
                    "source": "questions_table"
                }));
            }

            // ★ 2026-02 新增：DOCX 格式导出（使用 docx-rs 写入 API）
            if format == "docx" {
                use crate::document_parser::DocumentParser;

                let mut blocks: Vec<Value> = Vec::new();
                for (i, q) in questions.iter().enumerate() {
                    // 题目标题
                    blocks.push(json!({
                        "type": "heading",
                        "level": 2,
                        "text": format!("题目 {}", i + 1)
                    }));
                    // 题干
                    if let Some(content) = q.get("content").and_then(|v| v.as_str()) {
                        blocks.push(json!({
                            "type": "paragraph",
                            "text": content
                        }));
                    }
                    // 答案
                    if let Some(answer) = q.get("answer").and_then(|v| v.as_str()) {
                        blocks.push(json!({
                            "type": "paragraph",
                            "text": format!("答案：{}", answer),
                            "bold": true
                        }));
                    }
                    // 解析
                    if let Some(explanation) = q.get("explanation").and_then(|v| v.as_str()) {
                        blocks.push(json!({
                            "type": "paragraph",
                            "text": format!("解析：{}", explanation),
                            "italic": true
                        }));
                    }
                }

                let spec = json!({
                    "title": exam_name,
                    "blocks": blocks
                });

                let docx_bytes = DocumentParser::generate_docx_from_spec(&spec)
                    .map_err(|e| format!("DOCX 生成失败: {}", e))?;

                use base64::Engine;
                let base64_content =
                    base64::engine::general_purpose::STANDARD.encode(&docx_bytes);

                return Ok(json!({
                    "format": "docx",
                    "content_base64": base64_content,
                    "file_name": format!("{}.docx", exam_name),
                    "file_size": docx_bytes.len(),
                    "question_count": questions.len(),
                    "source": "questions_table",
                    "message": format!("已生成 DOCX 文件「{}.docx」({}KB, {} 道题目)", exam_name, docx_bytes.len() / 1024, questions.len())
                }));
            }

            let mut result = json!({
                "name": exam_name,
                "questions": questions,
                "question_count": questions.len(),
                "source": "questions_table"
            });

            if include_stats {
                let stats = self.execute_get_stats(call, ctx).await?;
                result["stats"] = stats;
            }

            return Ok(result);
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json.clone())
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut questions: Vec<Value> = Vec::new();
        for page in &preview.pages {
            for card in &page.cards {
                if let Some(status) = filter_status {
                    let card_status = serde_json::to_value(&card.status)
                        .ok()
                        .and_then(|v| v.as_str().map(String::from))
                        .unwrap_or_else(|| "new".to_string());
                    if card_status != status {
                        continue;
                    }
                }

                questions.push(json!({
                    "label": card.question_label,
                    "content": card.ocr_text,
                    "question_type": card.question_type,
                    "answer": card.answer,
                    "explanation": card.explanation,
                    "difficulty": card.difficulty,
                    "tags": card.tags,
                    "status": card.status,
                    "attempt_count": card.attempt_count,
                    "correct_count": card.correct_count,
                    "user_note": card.user_note,
                }));
            }
        }

        if format == "markdown" {
            let mut md = format!(
                "# {}\n\n",
                exam.exam_name.unwrap_or_else(|| "题目集".to_string())
            );
            for (i, q) in questions.iter().enumerate() {
                md.push_str(&format!("## 题目 {}\n\n", i + 1));
                md.push_str(&format!(
                    "**题干**\n{}\n\n",
                    q.get("content").and_then(|v| v.as_str()).unwrap_or("")
                ));
                if let Some(answer) = q.get("answer").and_then(|v| v.as_str()) {
                    md.push_str(&format!("**答案**\n{}\n\n", answer));
                }
                if let Some(explanation) = q.get("explanation").and_then(|v| v.as_str()) {
                    md.push_str(&format!("**解析**\n{}\n\n", explanation));
                }
                md.push_str("---\n\n");
            }
            return Ok(json!({
                "format": "markdown",
                "content": md,
                "question_count": questions.len(),
                "source": "preview_json",
                "degraded": true
            }));
        }

        let mut result = json!({
            "name": exam.exam_name,
            "questions": questions,
            "question_count": questions.len(),
            "source": "preview_json",
            "degraded": true
        });

        if include_stats {
            let stats = self.execute_get_stats(call, ctx).await?;
            result["stats"] = stats;
        }

        Ok(result)
    }

    /// P2-1: 变式生成 - 返回原题信息，由 AI 在对话中生成变式题
    async fn execute_generate_variant(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let card_id = call
            .arguments
            .get("card_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'card_id' parameter")?;
        let variant_type = call
            .arguments
            .get("variant_type")
            .and_then(|v| v.as_str())
            .unwrap_or("similar");

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            if let Ok(Some(q)) = service.get_question_by_card_id(session_id, card_id) {
                let variant_prompt = match variant_type {
                    "harder" => "请基于以下原题生成一道**更难**的变式题。保持相同的知识点和题型，但增加难度（如增加步骤、引入更复杂的条件）。",
                    "easier" => "请基于以下原题生成一道**更简单**的变式题。保持相同的知识点和题型，但降低难度（如简化条件、减少步骤）。",
                    "different_context" => "请基于以下原题生成一道**不同情境**的变式题。保持相同的知识点和解题方法，但更换题目背景（如换个应用场景）。",
                    _ => "请基于以下原题生成一道**相似难度**的变式题。保持相同的知识点、题型和难度，但改变具体数值或细节。",
                };

                return Ok(json!({
                    "action": "generate_variant",
                    "original_question": {
                        "card_id": q.card_id.clone().unwrap_or_else(|| q.id.clone()),
                        "label": q.question_label,
                        "content": q.content,
                        "question_type": q.question_type,
                        "answer": q.answer,
                        "explanation": q.explanation,
                        "difficulty": q.difficulty,
                        "tags": q.tags,
                        "images": q.images,
                    },
                    "variant_type": variant_type,
                    "prompt": variant_prompt,
                    "instruction": format!(
                        "{}\n\n**原题**：\n{}\n\n**原题答案**：{}\n\n请生成变式题，包含：1) 新的题干 2) 正确答案 3) 解析",
                        variant_prompt,
                        q.content,
                        q.answer.clone().unwrap_or_else(|| "未提供".to_string())
                    ),
                    "session_id": session_id,
                    "hint": "AI 将基于原题生成变式题。生成后可使用 qbank_batch_import 将新题目导入题目集。",
                    "source": "questions_table"
                }));
            }
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let card = preview
            .pages
            .iter()
            .flat_map(|p| p.cards.iter())
            .find(|c| c.card_id == card_id)
            .ok_or("Question not found")?;

        let variant_prompt = match variant_type {
            "harder" => "请基于以下原题生成一道**更难**的变式题。保持相同的知识点和题型，但增加难度（如增加步骤、引入更复杂的条件）。",
            "easier" => "请基于以下原题生成一道**更简单**的变式题。保持相同的知识点和题型，但降低难度（如简化条件、减少步骤）。",
            "different_context" => "请基于以下原题生成一道**不同情境**的变式题。保持相同的知识点和解题方法，但更换题目背景（如换个应用场景）。",
            _ => "请基于以下原题生成一道**相似难度**的变式题。保持相同的知识点、题型和难度，但改变具体数值或细节。",
        };

        Ok(json!({
            "action": "generate_variant",
            "original_question": {
                "card_id": card.card_id,
                "label": card.question_label,
                "content": card.ocr_text,
                "question_type": card.question_type,
                "answer": card.answer,
                "explanation": card.explanation,
                "difficulty": card.difficulty,
                "tags": card.tags,
            },
            "variant_type": variant_type,
            "prompt": variant_prompt,
            "instruction": format!(
                "{}\n\n**原题**：\n{}\n\n**原题答案**：{}\n\n请生成变式题，包含：1) 新的题干 2) 正确答案 3) 解析",
                variant_prompt,
                card.ocr_text,
                card.answer.clone().unwrap_or_else(|| "未提供".to_string())
            ),
            "session_id": session_id,
            "hint": "AI 将基于原题生成变式题。生成后可使用 qbank_batch_import 将新题目导入题目集。",
            "source": "preview_json",
            "degraded": true
        }))
    }

    /// P2-4: 文档导入 - 使用统一的 QuestionImportService
    ///
    /// 与 Tauri 命令 `import_question_bank` 使用相同的实现
    async fn execute_import_document(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        use crate::question_import_service::{ImportRequest, QuestionImportService};

        let _write_guard = QBANK_WRITE_LOCK.lock().await;

        let content = call
            .arguments
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'content' parameter")?;
        let format = call
            .arguments
            .get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("txt");
        let name = call.arguments.get("name").and_then(|v| v.as_str());
        let session_id = call.arguments.get("session_id").and_then(|v| v.as_str());
        let folder_id = call.arguments.get("folder_id").and_then(|v| v.as_str());

        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM Manager not available")?;
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 使用统一的 QuestionImportService
        let import_service = QuestionImportService::new(llm_manager.clone());

        let import_request = ImportRequest {
            content: content.to_string(),
            format: format.to_string(),
            name: name.map(String::from),
            session_id: session_id.map(String::from),
            folder_id: folder_id.map(String::from),
            model_config_id: None,
        };

        let result = import_service
            .import_document(vfs_db, import_request)
            .await
            .map_err(|e| format!("导入失败: {}", e))?;

        Ok(json!({
            "success": true,
            "session_id": result.session_id,
            "name": result.name,
            "imported_count": result.imported_count,
            "total_questions": result.total_questions,
            "message": format!("成功导入 {} 道题目", result.imported_count)
        }))
    }

    /// P2-3: 批量导入 - 解析 AI 生成的题目并添加到题目集
    async fn execute_batch_import(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        use crate::vfs::types::VfsCreateExamSheetParams;

        let _write_guard = QBANK_WRITE_LOCK.lock().await;

        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let name = call
            .arguments
            .get("name")
            .and_then(|v| v.as_str())
            .map(String::from);
        // ★ 容错处理：部分模型可能将 questions 序列化为 JSON 字符串而非数组
        let questions_value = call.arguments.get("questions");
        let parsed_questions: Option<Vec<Value>>;
        let questions: &Vec<Value> = if let Some(arr) = questions_value.and_then(|v| v.as_array()) {
            arr
        } else if let Some(s) = questions_value.and_then(|v| v.as_str()) {
            parsed_questions = serde_json::from_str(s).ok();
            parsed_questions
                .as_ref()
                .ok_or("'questions' parameter is a string but not valid JSON array")?
        } else {
            return Err("Missing 'questions' parameter".to_string());
        };
        let parent_card_id = call
            .arguments
            .get("parent_card_id")
            .and_then(|v| v.as_str());

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let mut is_new_session = false;
        let (mut session_id, exam_name, mut preview) = if let Some(sid) = session_id {
            let exam = VfsExamRepo::get_exam_sheet(vfs_db, &sid)
                .map_err(|e| format!("Failed to get exam sheet: {}", e))?
                .ok_or("Exam sheet not found")?;
            let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
                .map_err(|e| format!("Failed to parse preview: {}", e))?;
            (
                sid,
                exam.exam_name.unwrap_or_else(|| "未命名题目集".to_string()),
                preview,
            )
        } else {
            let new_session_id = uuid::Uuid::new_v4().to_string();
            let exam_name = name.clone().unwrap_or_else(|| "导入的题目集".to_string());
            let preview = ExamSheetPreviewResult {
                temp_id: new_session_id.clone(),
                exam_name: Some(exam_name.clone()),
                pages: Vec::new(),
                raw_model_response: None,
                instructions: None,
                session_id: Some(new_session_id.clone()),
            };
            is_new_session = true;
            (new_session_id, exam_name, preview)
        };

        let mut imported_count = 0;
        let mut new_card_ids: Vec<String> = Vec::new();
        let mut question_params_list: Vec<CreateQuestionParams> = Vec::new();

        let parent_question_id = if let (Some(parent_card_id), Some(service)) =
            (parent_card_id, &ctx.question_bank_service)
        {
            service
                .get_question_by_card_id(&session_id, parent_card_id)
                .ok()
                .flatten()
                .map(|q| q.id)
        } else {
            None
        };

        if preview.pages.is_empty() {
            preview.pages.push(ExamSheetPreviewPage {
                page_index: 0,
                cards: Vec::new(),
                blob_hash: None,
                width: None,
                height: None,
                original_image_path: String::new(),
                raw_ocr_text: None,
                ocr_completed: false,
                parse_completed: false,
            });
        }

        for q in questions {
            let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if content.is_empty() {
                continue;
            }

            let existing_count = preview.pages.iter().map(|p| p.cards.len()).sum::<usize>();
            let question_label = format!("Q{}", existing_count + 1);
            let card_id = format!(
                "card_{}",
                uuid::Uuid::new_v4().to_string().replace("-", "")[..12].to_string()
            );
            let question_type = q.get("question_type").and_then(|v| v.as_str());
            let answer = q.get("answer").and_then(|v| v.as_str()).map(String::from);
            let explanation = q
                .get("explanation")
                .and_then(|v| v.as_str())
                .map(String::from);
            let difficulty = q.get("difficulty").and_then(|v| v.as_str());
            let tags: Vec<String> = q
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            let new_card = ExamCardPreview {
                card_id: card_id.clone(),
                page_index: 0,
                question_label: question_label.clone(),
                ocr_text: content.to_string(),
                tags,
                question_type: question_type
                    .and_then(|t| serde_json::from_str(&format!("\"{}\"", t)).ok()),
                answer,
                explanation,
                difficulty: difficulty
                    .and_then(|d| serde_json::from_str(&format!("\"{}\"", d)).ok()),
                status: ModelsQuestionStatus::New,
                source_type: SourceType::AiGenerated,
                parent_card_id: parent_card_id.map(String::from),
                ..Default::default()
            };

            preview.pages[0].cards.push(new_card);
            new_card_ids.push(card_id.clone());
            imported_count += 1;

            // 解析选项（仅 questions 表需要）
            let options = q.get("options").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|opt| {
                        let key = opt
                            .get("key")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let content = opt
                            .get("content")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if key.is_empty() && content.is_empty() {
                            None
                        } else {
                            Some(QuestionOption { key, content })
                        }
                    })
                    .collect()
            });

            let question_params = CreateQuestionParams {
                exam_id: session_id.clone(),
                card_id: Some(card_id.clone()),
                question_label: Some(question_label),
                content: content.to_string(),
                options,
                answer: q.get("answer").and_then(|v| v.as_str()).map(String::from),
                explanation: q
                    .get("explanation")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                question_type: question_type
                    .and_then(|t| serde_json::from_str(&format!("\"{}\"", t)).ok()),
                difficulty: difficulty
                    .and_then(|d| serde_json::from_str(&format!("\"{}\"", d)).ok()),
                tags: Some(
                    q.get("tags")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|t| t.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                ),
                source_type: Some(RepoSourceType::AiGenerated),
                source_ref: None,
                images: None,
                parent_id: parent_question_id.clone(),
            };
            question_params_list.push(question_params);
        }

        if imported_count == 0 {
            return Err("未能导入题目：内容为空或格式不完整".to_string());
        }

        if imported_count > 0 {
            // 如果有 parent_card_id，更新父题的 variant_ids
            if let Some(parent_id) = parent_card_id {
                for page in &mut preview.pages {
                    for card in &mut page.cards {
                        if card.card_id == parent_id {
                            let mut variants = card.variant_ids.clone().unwrap_or_default();
                            variants.extend(new_card_ids.clone());
                            card.variant_ids = Some(variants);
                            break;
                        }
                    }
                }
            }

            let preview_json = serde_json::to_value(&preview)
                .map_err(|e| format!("Failed to serialize preview: {}", e))?;

            // S-009: 获取单一连接 + SAVEPOINT 事务保护，确保 preview_json 与 questions 原子写入
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| format!("Failed to get db connection: {}", e))?;

            conn.execute("SAVEPOINT batch_import", [])
                .map_err(|e| format!("Failed to create savepoint: {}", e))?;

            // S-009-fix: 使用 actual_exam_id 追踪真实的 exam_sheets.id
            let mut actual_exam_id = session_id.clone();

            let sp_result = (|| -> Result<(), String> {
                if is_new_session {
                    let params = VfsCreateExamSheetParams {
                        exam_name: Some(exam_name.clone()),
                        temp_id: session_id.clone(),
                        metadata_json: json!({}),
                        preview_json,
                        status: "completed".to_string(),
                        folder_id: None,
                    };
                    let created_exam = VfsExamRepo::create_exam_sheet_with_conn(&conn, params)
                        .map_err(|e| format!("Failed to create exam sheet: {}", e))?;
                    // ★ 关键修复：使用 VfsExamSheet::generate_id() 生成的真实 ID
                    // 而非 uuid::Uuid 格式的 temp_id，否则 questions.exam_id FK 会违反约束
                    actual_exam_id = created_exam.id.clone();
                } else {
                    VfsExamRepo::update_preview_json_with_conn(&conn, &session_id, preview_json)
                        .map_err(|e| format!("Failed to update exam sheet: {}", e))?;
                }

                // 逐条写入 questions 表（不使用 batch 版本，因其内部有独立事务）
                for params in &mut question_params_list {
                    // ★ 将每条题目的 exam_id 修正为真实的 exam_sheets.id
                    params.exam_id = actual_exam_id.clone();
                    VfsQuestionRepo::create_question_with_conn(&conn, params)
                        .map_err(|e| format!("Failed to write question: {}", e))?;
                }

                Ok(())
            })();

            match sp_result {
                Ok(()) => {
                    conn.execute("RELEASE batch_import", [])
                        .map_err(|e| format!("Failed to release savepoint: {}", e))?;
                }
                Err(e) => {
                    let _ = conn.execute("ROLLBACK TO batch_import", []);
                    let _ = conn.execute("RELEASE batch_import", []);
                    log::warn!(
                        "[QBankExecutor] S-009: batch_import SAVEPOINT rolled back: {}",
                        e
                    );
                    return Err(e);
                }
            }

            // 刷新统计（非关键，在 SAVEPOINT 外执行）
            if !question_params_list.is_empty() {
                if let Err(e) = VfsQuestionRepo::refresh_stats_with_conn(&conn, &actual_exam_id) {
                    log::warn!("[QuestionBank] 统计刷新失败: {}", e);
                }
            }

            // ★ 使用真实 exam_id 覆盖 session_id，确保返回值正确
            session_id = actual_exam_id;
        }

        Ok(json!({
            "success": true,
            "session_id": session_id,
            "name": exam_name,
            "imported_count": imported_count,
            "total_questions": preview.pages.iter().map(|p| p.cards.len()).sum::<usize>(),
            "new_card_ids": new_card_ids,
            "message": format!("成功导入 {} 道题目", imported_count)
        }))
    }
}

impl Default for QBankExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for QBankExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let name = Self::strip_namespace(tool_name);
        matches!(
            name,
            "qbank_list"
                | "qbank_list_questions"
                | "qbank_get_question"
                | "qbank_submit_answer"
                | "qbank_update_question"
                | "qbank_get_stats"
                | "qbank_get_next_question"
                | "qbank_generate_variant"
                | "qbank_batch_import"
                | "qbank_import_document"
                | "qbank_reset_progress"
                | "qbank_export"
                | "qbank_ai_grade"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = Self::strip_namespace(&call.name);

        log::debug!("[QBankExecutor] Executing tool: {}", tool_name);

        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id), // 🆕 tool_call_id
            None,
        );

        let result = match tool_name {
            "qbank_list" => self.execute_list(call, ctx).await,
            "qbank_list_questions" => self.execute_list_questions(call, ctx).await,
            "qbank_get_question" => self.execute_get_question(call, ctx).await,
            "qbank_submit_answer" => self.execute_submit_answer(call, ctx).await,
            "qbank_update_question" => self.execute_update_question(call, ctx).await,
            "qbank_get_stats" => self.execute_get_stats(call, ctx).await,
            "qbank_get_next_question" => self.execute_get_next_question(call, ctx).await,
            "qbank_reset_progress" => self.execute_reset_progress(call, ctx).await,
            "qbank_export" => self.execute_export(call, ctx).await,
            "qbank_generate_variant" => self.execute_generate_variant(call, ctx).await,
            "qbank_batch_import" => self.execute_batch_import(call, ctx).await,
            "qbank_import_document" => self.execute_import_document(call, ctx).await,
            "qbank_ai_grade" => {
                // AI 评判通过独立的 Tauri command 处理（流式管线），
                // 此处仅返回提示信息，不在 Chat 工具链中直接执行流式操作。
                Ok(json!({
                    "message": "AI 评判需要通过流式管线执行，请在题目集练习界面中使用此功能。",
                    "hint": "在对话中，你可以使用 qbank_submit_answer 提交答案，主观题会自动触发 AI 评判。"
                }))
            }
            _ => Err(format!("Unknown qbank tool: {}", tool_name)),
        };

        let elapsed_ms = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(value) => {
                log::debug!(
                    "[QBankExecutor] Tool {} completed in {}ms",
                    tool_name,
                    elapsed_ms
                );

                // 🔧 修复：发射工具调用结束事件
                ctx.emitter.emit_end(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({
                        "result": value,
                        "durationMs": elapsed_ms,
                    })),
                    None,
                );

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    value,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[QBankExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                log::error!("[QBankExecutor] Tool {} failed: {}", tool_name, e);

                // 🔧 修复：发射工具调用错误事件
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &e, None);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[QBankExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = Self::strip_namespace(tool_name);
        match stripped {
            // ★ 2026-02-09: 仅保留 qbank_reset_progress 为 Medium（重置进度不可逆）
            "qbank_reset_progress" => ToolSensitivity::Medium,
            // 其他操作（导入/导出/提交答案/更新题目）都是创建性或学习性操作，降为 Low
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "QBankExecutor"
    }
}
