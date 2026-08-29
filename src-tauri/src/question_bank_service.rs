//! 智能题目集服务
//!
//! 提供题目实体的业务逻辑处理，与 OCR 预览解耦，支持增量更新、历史追溯。
//!
//! ## 核心功能
//! - 题目 CRUD（委托给 VfsQuestionRepo）
//! - 答题状态更新与正确性判断
//! - 统计聚合维护
//! - 历史记录管理
//! - 从 preview 迁移题目

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{
    AnswerSubmission, CreateQuestionParams, Difficulty, Question, QuestionBankStats,
    QuestionFilters, QuestionHistory, QuestionListResult, QuestionSearchFilters,
    QuestionSearchListResult, QuestionStatus, QuestionType, UpdateQuestionParams, VfsQuestionRepo,
};

// ============================================================================
// 服务结构
// ============================================================================

/// 智能题目集服务
pub struct QuestionBankService {
    vfs_db: Arc<VfsDatabase>,
}

/// 答题提交结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitAnswerResult {
    /// 是否正确。主观题（需手动批改）时为 None，避免误判为"错误"。
    pub is_correct: Option<bool>,
    pub correct_answer: Option<String>,
    pub needs_manual_grading: bool,
    pub message: String,
    pub updated_question: Question,
    pub updated_stats: QuestionBankStats,
    /// 本次作答记录的 ID（用于关联 AI 评判）
    pub submission_id: String,
    /// 当日权威练习进度（口径同 DailyPracticeResult.completed_count/correct_count：
    /// 按题去重、当天任一次答对即计 correct）。提交/改判后由后端重算返回，
    /// 前端应以此回写本地乐观计数。
    ///
    /// serde 兼容：新前端读不到时按 None 处理（`default`）；None 时不序列化
    /// （`skip_serializing_if`），旧前端反序列化不受影响；计算失败不阻塞答题主流程。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_progress: Option<DailyProgressSnapshot>,
}

/// 当日练习进度快照（submit_answer / regrade_submission 返回给前端的权威口径）。
///
/// 数据来源为 `query_daily_progress`（与 get_daily_practice / 打卡日历同口径）：
/// answer_submissions 为主、存量无提交记录的题按 last_attempt_at 兜底，
/// DATE(…, 'localtime') 对齐本地日界线。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyProgressSnapshot {
    /// 日期（YYYY-MM-DD，本地时区）
    pub date: String,
    /// 题目集 ID
    pub exam_id: String,
    /// 今天已作答的题目 ID（按题去重）。前端 hydrate 首答去重集合时以此为准，
    /// 本地只做乐观增量。
    pub answered_question_ids: Vec<String>,
    /// 已完成题数（= answered_question_ids.len()）
    pub completed_count: u32,
    /// 正确题数（当天该题任一次答对即计）
    pub correct_count: u32,
}

/// `apply_submission_verdict_in_tx` 的落库产物。
///
/// 事务内只做"事实写入"；复习计划 / learner profile 回流属事务外副作用，
/// 由调用方在 commit（或 RELEASE SAVEPOINT）之后按本结构的标记执行。
#[derive(Debug)]
pub(crate) struct VerdictApplyOutcome {
    /// 本次是否发生写入。同向改判（旧判定 == 新判定）幂等短路时为 false，
    /// 此时 mastery_state 为 None、needs_review_plan 为 false。
    pub changed: bool,
    /// 落库后的题目（幂等路径为当前值）
    pub updated_question: Question,
    /// 落库后的题目集统计
    pub updated_stats: QuestionBankStats,
    /// 事务提交后需回流 sync_learner_profile 的掌握度状态。
    /// 仅 changed 时为 Some；调用失败会随事务一起回滚。
    pub mastery_state: Option<crate::mastery::MasteryState>,
    /// 事务提交后是否需要确保 SM-2 复习计划（判为"错"时为 true）
    pub needs_review_plan: bool,
}

/// 批量操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchResult {
    pub success_count: usize,
    pub failed_count: usize,
    pub errors: Vec<String>,
}

impl QuestionBankService {
    /// 创建服务实例
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        Self { vfs_db }
    }

    // ========================================================================
    // 题目 CRUD
    // ========================================================================

    /// 列出题目（分页+筛选）
    pub fn list_questions(
        &self,
        exam_id: &str,
        filters: &QuestionFilters,
        page: u32,
        page_size: u32,
    ) -> Result<QuestionListResult, AppError> {
        VfsQuestionRepo::list_questions(&self.vfs_db, exam_id, filters, page, page_size)
            .map_err(|e| AppError::database(e.to_string()))
    }

    /// 全文搜索题目（FTS5）
    ///
    /// # Arguments
    /// * `keyword` - 搜索关键词
    /// * `exam_id` - 可选，限定题目集
    /// * `filters` - 搜索筛选条件
    /// * `page` - 页码（从 1 开始）
    /// * `page_size` - 每页大小
    ///
    /// # Returns
    /// * 搜索结果列表，包含高亮片段和相关性分数
    pub fn search_questions(
        &self,
        keyword: &str,
        exam_id: Option<&str>,
        filters: &QuestionSearchFilters,
        page: u32,
        page_size: u32,
    ) -> Result<QuestionSearchListResult, AppError> {
        VfsQuestionRepo::search_questions(&self.vfs_db, keyword, exam_id, filters, page, page_size)
            .map_err(|e| AppError::database(e.to_string()))
    }

    /// 重建 FTS5 索引（用于数据修复）
    pub fn rebuild_fts_index(&self) -> Result<u64, AppError> {
        VfsQuestionRepo::rebuild_fts_index(&self.vfs_db)
            .map_err(|e| AppError::database(e.to_string()))
    }

    /// 获取单题详情
    pub fn get_question(&self, question_id: &str) -> Result<Option<Question>, AppError> {
        VfsQuestionRepo::get_question(&self.vfs_db, question_id)
            .map_err(|e| AppError::database(e.to_string()))
    }

    /// 根据 card_id 获取题目（兼容旧数据）
    pub fn get_question_by_card_id(
        &self,
        exam_id: &str,
        card_id: &str,
    ) -> Result<Option<Question>, AppError> {
        VfsQuestionRepo::get_question_by_card_id(&self.vfs_db, exam_id, card_id)
            .map_err(|e| AppError::database(e.to_string()))
    }

    /// 创建题目
    pub fn create_question(&self, params: &CreateQuestionParams) -> Result<Question, AppError> {
        let question = VfsQuestionRepo::create_question(&self.vfs_db, params)
            .map_err(|e| AppError::database(e.to_string()))?;

        // 更新统计
        if let Err(e) = self.refresh_stats(&params.exam_id) {
            log::warn!("[QuestionBank] 统计刷新失败: {}", e);
        }

        info!(
            "[QuestionBankService] Created question id={} for exam_id={}",
            question.id, params.exam_id
        );

        Ok(question)
    }

    /// 批量创建题目
    pub fn batch_create_questions(
        &self,
        params_list: &[CreateQuestionParams],
    ) -> Result<Vec<Question>, AppError> {
        if params_list.is_empty() {
            return Ok(Vec::new());
        }

        let questions = VfsQuestionRepo::batch_create_questions(&self.vfs_db, params_list)
            .map_err(|e| AppError::database(e.to_string()))?;

        // 更新统计（按 exam_id 分组）
        let exam_ids: std::collections::HashSet<_> =
            params_list.iter().map(|p| &p.exam_id).collect();
        for exam_id in exam_ids {
            if let Err(e) = self.refresh_stats(exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

        info!(
            "[QuestionBankService] Batch created {} questions",
            questions.len()
        );

        Ok(questions)
    }

    /// 更新题目
    pub fn update_question(
        &self,
        question_id: &str,
        params: &UpdateQuestionParams,
        record_history: bool,
    ) -> Result<Question, AppError> {
        self.update_question_internal(question_id, params, record_history, true)
    }

    fn update_question_internal(
        &self,
        question_id: &str,
        params: &UpdateQuestionParams,
        record_history: bool,
        refresh_stats_on_status_change: bool,
    ) -> Result<Question, AppError> {
        // 获取旧数据用于记录历史
        let old_question = if record_history {
            self.get_question(question_id)?
        } else {
            None
        };

        let question = VfsQuestionRepo::update_question(&self.vfs_db, question_id, params)
            .map_err(|e| AppError::database(e.to_string()))?;

        // 记录历史
        if record_history {
            if let Some(old) = old_question {
                self.record_changes(&old, &question, "user")?;
            }
        }

        // 如果状态变化，更新统计
        if refresh_stats_on_status_change && params.status.is_some() {
            if let Err(e) = self.refresh_stats(&question.exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

        debug!("[QuestionBankService] Updated question id={}", question_id);

        Ok(question)
    }

    /// 批量更新题目
    ///
    /// 单连接 + 单事务完成整批操作（此前每题独立走 update_question → 每题各开
    /// 一个连接与隐式事务，含同步标记/重算 content hash 共 4 条语句，N 题产生
    /// N 次连接与 4N 次独立提交开销）。每题包在 SAVEPOINT 中：题目更新、同步
    /// 标记与 content hash 重算保持原子；单题失败仅回滚该题并记入 errors，
    /// 保持"部分成功"语义不变。
    pub fn batch_update_questions(
        &self,
        question_ids: &[String],
        params: &UpdateQuestionParams,
    ) -> Result<BatchResult, AppError> {
        if question_ids.is_empty() {
            return Ok(BatchResult {
                success_count: 0,
                failed_count: 0,
                errors: Vec::new(),
            });
        }

        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut success_count = 0usize;
        let mut errors = Vec::new();
        let mut exam_ids: HashSet<String> = HashSet::new();

        for id in question_ids {
            if let Err(e) = tx.execute_batch("SAVEPOINT qbank_batch_update_question") {
                errors.push(format!("{}: {}", id, e));
                continue;
            }

            // update_question_with_conn 内部完成 UPDATE + 同步标记 + content hash
            // 重算（S-030 口径），与单题 update_question 走同一实现，语义完全一致。
            match VfsQuestionRepo::update_question_with_conn(&tx, id, params) {
                Ok(q) => {
                    if let Err(e) =
                        tx.execute_batch("RELEASE SAVEPOINT qbank_batch_update_question")
                    {
                        let _ = tx.execute_batch(
                            "ROLLBACK TO SAVEPOINT qbank_batch_update_question; RELEASE SAVEPOINT qbank_batch_update_question;",
                        );
                        errors.push(format!("{}: {}", id, e));
                        continue;
                    }
                    success_count += 1;
                    exam_ids.insert(q.exam_id);
                }
                Err(e) => {
                    let _ = tx.execute_batch(
                        "ROLLBACK TO SAVEPOINT qbank_batch_update_question; RELEASE SAVEPOINT qbank_batch_update_question;",
                    );
                    errors.push(format!("{}: {}", id, AppError::database(e.to_string())));
                }
            }
        }

        // 更新统计（与更新同事务提交，避免中途崩溃留下过期统计）
        for exam_id in &exam_ids {
            if let Err(e) = VfsQuestionRepo::refresh_stats_with_conn(&tx, exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

        tx.commit().map_err(|e| AppError::database(e.to_string()))?;

        Ok(BatchResult {
            success_count,
            failed_count: errors.len(),
            errors,
        })
    }

    /// 删除题目
    pub fn delete_question(&self, question_id: &str) -> Result<(), AppError> {
        // 获取 exam_id 用于更新统计
        let question = self.get_question(question_id)?;

        VfsQuestionRepo::delete_question(&self.vfs_db, question_id)
            .map_err(|e| AppError::database(e.to_string()))?;

        // 更新统计
        if let Some(q) = question {
            if let Err(e) = self.refresh_stats(&q.exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

        info!("[QuestionBankService] Deleted question id={}", question_id);

        Ok(())
    }

    /// 批量删除题目
    ///
    /// 单连接 + 单事务完成整批操作（此前每题各开一个连接和事务，N 题产生 2N+
    /// 次连接开销）。单题失败只记录错误并继续，保持"部分成功"语义不变。
    pub fn batch_delete_questions(&self, question_ids: &[String]) -> Result<BatchResult, AppError> {
        if question_ids.is_empty() {
            return Ok(BatchResult {
                success_count: 0,
                failed_count: 0,
                errors: Vec::new(),
            });
        }

        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut exam_ids = std::collections::HashSet::new();
        let mut errors = Vec::new();
        let mut success_count = 0;

        for id in question_ids {
            match VfsQuestionRepo::get_question_with_conn(&tx, id) {
                Ok(Some(q)) => match VfsQuestionRepo::delete_question_with_conn(&tx, id) {
                    Ok(()) => {
                        success_count += 1;
                        exam_ids.insert(q.exam_id);
                    }
                    Err(e) => {
                        errors.push(format!("{}: {}", id, e));
                    }
                },
                Ok(None) => {
                    errors.push(format!("{}: not found", id));
                }
                Err(e) => {
                    errors.push(format!("{}: {}", id, e));
                }
            }
        }

        // 更新统计（与删除同事务，避免中途崩溃留下过期统计）
        for exam_id in &exam_ids {
            if let Err(e) = VfsQuestionRepo::refresh_stats_with_conn(&tx, exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

        tx.commit().map_err(|e| AppError::database(e.to_string()))?;

        Ok(BatchResult {
            success_count,
            failed_count: errors.len(),
            errors,
        })
    }

    /// Atomically soft-delete a batch using one OCC baseline per question.
    ///
    /// The complete batch is rolled back when any question is missing or stale. The returned
    /// entities are the pre-delete values so callers can show the exact impact without another
    /// race-prone read.
    pub fn batch_delete_questions_if_versions(
        &self,
        expected_versions: &[(String, String)],
    ) -> Result<Vec<Question>, AppError> {
        if expected_versions.is_empty() {
            return Err(AppError::validation("question_ids must not be empty"));
        }

        let mut seen = HashSet::new();
        if expected_versions
            .iter()
            .any(|(question_id, _)| !seen.insert(question_id.clone()))
        {
            return Err(AppError::validation("question_ids contains duplicates"));
        }

        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut previous = Vec::with_capacity(expected_versions.len());
        let mut exam_ids = HashSet::new();

        for (question_id, expected_updated_at) in expected_versions {
            let question = VfsQuestionRepo::get_question_with_conn(&tx, question_id)
                .map_err(|e| AppError::database(e.to_string()))?
                .ok_or_else(|| {
                    AppError::not_found(format!("Question not found: {}", question_id))
                })?;
            exam_ids.insert(question.exam_id.clone());
            VfsQuestionRepo::delete_question_if_version_with_conn(
                &tx,
                question_id,
                expected_updated_at,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            previous.push(question);
        }

        tx.commit().map_err(|e| AppError::database(e.to_string()))?;

        for exam_id in exam_ids {
            if let Err(error) = self.refresh_stats(&exam_id) {
                warn!(
                    "[QuestionBankService] Failed to refresh stats after OCC delete for {}: {}",
                    exam_id, error
                );
            }
        }

        Ok(previous)
    }

    // ========================================================================
    // 答题与状态
    // ========================================================================

    /// 提交答案
    pub fn submit_answer(
        &self,
        question_id: &str,
        user_answer: &str,
        is_correct_override: Option<bool>,
        client_request_id: Option<&str>,
    ) -> Result<SubmitAnswerResult, AppError> {
        if is_correct_override.is_some() {
            warn!(
                "[QuestionBankService] submit_answer called with is_correct_override for question_id={}",
                question_id
            );
        }

        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(e.to_string()))?;

        // 获取题目
        let question = VfsQuestionRepo::get_question_with_conn(&tx, question_id)
            .map_err(|e| AppError::database(e.to_string()))?
            .ok_or_else(|| AppError::not_found(format!("Question not found: {}", question_id)))?;

        // 幂等短路：同一客户端请求已处理，直接返回当前状态
        if let Some(req_id) = client_request_id.map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(existing_submission) =
                VfsQuestionRepo::get_submission_by_client_request_with_conn(
                    &tx,
                    question_id,
                    req_id,
                )
                .map_err(|e| AppError::database(e.to_string()))?
            {
                let updated_question = VfsQuestionRepo::get_question_with_conn(&tx, question_id)
                    .map_err(|e| AppError::database(e.to_string()))?
                    .ok_or_else(|| {
                        AppError::not_found(format!("Question not found: {}", question_id))
                    })?;
                let updated_stats =
                    VfsQuestionRepo::refresh_stats_with_conn(&tx, &question.exam_id)
                        .map_err(|e| AppError::database(e.to_string()))?;

                tx.commit().map_err(|e| AppError::database(e.to_string()))?;

                let is_correct = existing_submission.is_correct;
                // is_correct 为 None 一律表示"尚未判定"（主观题或缺少参考答案的客观题），
                // 与首次提交的返回口径保持一致，避免重放时把待批改误报为"回答错误"。
                let needs_manual_grading = is_correct.is_none();
                let message = match is_correct {
                    None => "需要手动批改".to_string(),
                    Some(true) => "回答正确！".to_string(),
                    Some(false) => "回答错误".to_string(),
                };

                let daily_progress = self.build_daily_progress_snapshot(&question.exam_id);
                return Ok(SubmitAnswerResult {
                    is_correct,
                    correct_answer: question.answer.clone(),
                    needs_manual_grading,
                    message,
                    updated_question,
                    updated_stats,
                    submission_id: existing_submission.id,
                    daily_progress,
                });
            }
        }

        // 手动改判去重：用户在"需人工批改"的结果卡上点"我答对了/我答错了"时，
        // 前端会带 is_correct_override 重新提交同一份答案。此前该路径会插入第二条
        // submission 并把 attempt_count 再 +1，导致做题次数被双计、正确率统计失真。
        // 若该题最近一次提交仍未判定（is_correct IS NULL）且答案相同，则按
        // "对该次提交改判"处理（与 AI 评判 qbank_grading/pipeline.rs 的落库口径一致），
        // 不新增作答记录、不重复递增 attempt_count。
        // 已判定提交的换判（如 AI 评判后用户不认可）走显式的 regrade_submission，
        // 此处不做启发式扩展：带 override 重复提交同一答案也可能是真实的重复作答
        // （Agent 批量练习路径），启发式会把它们误并成一次。
        if let Some(override_val) = is_correct_override {
            let latest_submission = VfsQuestionRepo::get_submissions_with_conn(&tx, question_id, 1)
                .map_err(|e| AppError::database(e.to_string()))?
                .into_iter()
                .next();
            if let Some(latest) = latest_submission {
                if latest.is_correct.is_none() && latest.user_answer == user_answer {
                    return self.regrade_submission_in_tx(tx, question, latest, override_val);
                }
            }
        }

        // 判断正确性
        let (raw_is_correct, needs_manual_grading) = if let Some(override_val) = is_correct_override
        {
            (override_val, false)
        } else {
            Self::check_answer_correctness(
                user_answer,
                question.answer.as_deref(),
                &question.question_type,
                question.structured_data.as_ref(),
            )
        };
        // M-063: 主观题 is_correct 设为 None，避免工具调用方误判为"错误"
        let is_correct: Option<bool> = if needs_manual_grading {
            None
        } else {
            Some(raw_is_correct)
        };

        // 更新题目
        let updated_question = VfsQuestionRepo::submit_answer_with_conn(
            &tx,
            question_id,
            user_answer,
            is_correct,
            needs_manual_grading,
        )
        .map_err(|e| AppError::database(e.to_string()))?;

        // 记录作答历史
        let grading_method = if needs_manual_grading {
            "ai"
        } else if is_correct_override.is_some() {
            "manual"
        } else {
            "auto"
        };
        let submission_id = VfsQuestionRepo::insert_submission_with_conn(
            &tx,
            question_id,
            user_answer,
            is_correct,
            grading_method,
            client_request_id,
        )
        .map_err(|e| AppError::database(e.to_string()))?;

        // 更新统计
        let updated_stats = VfsQuestionRepo::refresh_stats_with_conn(&tx, &question.exam_id)
            .map_err(|e| AppError::database(e.to_string()))?;

        // Keep the objective-answer fact and its mastery event/aggregate in the
        // same VFS transaction. A repeated client_request_id can now safely
        // short-circuit without leaving a permanently missing mastery signal.
        let mastery_state = if let Some(correct) = is_correct {
            Some(
                crate::mastery::MasteryService::new(Arc::clone(&self.vfs_db))
                    .record_qbank_answer_with_conn(
                        &tx,
                        &submission_id,
                        question_id,
                        &question.tags,
                        correct,
                    )?,
            )
        } else {
            None
        };

        tx.commit().map_err(|e| AppError::database(e.to_string()))?;

        // ★ I1 修复：答错时自动创建（或复用）SM-2 复习计划，接通间隔重复学习闭环。
        // 失败不阻塞答题流程，仅记录告警。
        if is_correct == Some(false) {
            let review_service =
                crate::review_plan_service::ReviewPlanService::new(Arc::clone(&self.vfs_db));
            match review_service.get_or_create_plan(question_id, &question.exam_id) {
                Ok(plan) => {
                    info!(
                        "[QuestionBankService] Auto review plan for wrong answer: question_id={}, plan_id={}",
                        question_id, plan.id
                    );
                }
                Err(e) => {
                    warn!(
                        "[QuestionBankService] Failed to auto-create review plan for question_id={}: {}",
                        question_id, e
                    );
                }
            }
        }

        // Profile storage is a separate note-level CAS. The authoritative event
        // is already committed; a later signal can safely retry this reflux.
        if let Some(state) = mastery_state.as_ref() {
            let mastery = crate::mastery::MasteryService::new(Arc::clone(&self.vfs_db));
            if let Err(e) = mastery.sync_learner_profile(state) {
                warn!(
                    "[QuestionBankService] mastery profile reflux failed for question_id={}: {}",
                    question_id, e
                );
            }
        }

        let message = if needs_manual_grading {
            "需要手动批改".to_string()
        } else if raw_is_correct {
            "回答正确！".to_string()
        } else {
            "回答错误".to_string()
        };

        info!(
            "[QuestionBankService] Submitted answer for question id={}, is_correct={:?}, submission_id={}",
            question_id, is_correct, submission_id
        );

        let daily_progress = self.build_daily_progress_snapshot(&question.exam_id);

        Ok(SubmitAnswerResult {
            is_correct,
            correct_answer: question.answer,
            needs_manual_grading,
            message,
            updated_question,
            updated_stats,
            submission_id,
            daily_progress,
        })
    }

    /// 对最近一次提交做显式改判（UI 自评按钮"我答对了/我答错了"的唯一后端入口）。
    ///
    /// 与 submit_answer 的关键差异：改判永远不新增作答记录、不递增 attempt_count。
    /// 覆盖两类场景：
    /// - 待判定提交（is_correct IS NULL）的首次人工判定；
    /// - 已判定提交（AI 评判/上次自评）的换判——此前该场景会插入第二条
    ///   submission 并把 attempt_count 再 +1，做题次数与正确率被双计。
    pub fn regrade_submission(
        &self,
        question_id: &str,
        submission_id: &str,
        is_correct: bool,
    ) -> Result<SubmitAnswerResult, AppError> {
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(e.to_string()))?;

        let question = VfsQuestionRepo::get_question_with_conn(&tx, question_id)
            .map_err(|e| AppError::database(e.to_string()))?
            .ok_or_else(|| AppError::not_found(format!("Question not found: {}", question_id)))?;

        // 只允许改判最近一次提交：更早的提交已沉淀进统计口径，
        // 改判它们会让 question.is_correct（最近一次作答结果）失真。
        let latest = VfsQuestionRepo::get_submissions_with_conn(&tx, question_id, 1)
            .map_err(|e| AppError::database(e.to_string()))?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::validation("该题还没有作答记录，无法改判"))?;
        if latest.id != submission_id {
            return Err(AppError::validation(
                "要改判的作答已不是最近一次提交，请刷新后重试",
            ));
        }

        self.regrade_submission_in_tx(tx, question, latest, is_correct)
    }

    /// 判分/改判统一原语：把"某条既有 submission 的判定变化"原子落库。
    /// 自动判分待判定去重分支（submit_answer）、人工改判（regrade_submission）
    /// 与 AI 判分管线（qbank_grading/pipeline.rs 的 persist 段）共用。
    ///
    /// # 语义（与历史 regrade 口径一致）
    /// - 更新既有 submission 的 is_correct/grading_method，不新插记录；
    ///   同时推进该行的 RowSync 列：`updated_at = now`、
    ///   `local_version = COALESCE(local_version, 0) + 1`（V20260523 已建列，
    ///   行级 LWW 依赖它们判新旧）；
    /// - 题目侧不重复递增 attempt_count；correct_count 按 **本 submission 的旧
    ///   is_correct** 与新判定的差值增减：NULL→true +1、false→true +1、
    ///   true→false -1（MAX(0,·) 防负）、其余 0；
    /// - 同向改判（旧判定 == 新判定）幂等短路：不产生任何写入，返回
    ///   `changed = false`；
    /// - 状态转换与 submit_answer_with_conn 同一 CASE 口径
    ///   （错→review，correct_count>=2→mastered，否则 in_progress）；
    /// - 调 mark_as_modified / update_content_hash（S-030 同步口径）；
    /// - 同事务内补记 mastery 事件：首判（submission.is_correct IS NULL）走
    ///   record_qbank_answer_with_conn（幂等键 `me_qbank_{sid}`）；换判
    ///   （Some(old) != new）走 record_qbank_verdict_correction_with_conn
    ///   （tombstone 旧信号 + 追加修订事件 `me_qbank_{sid}_r{n}`），信号不再被
    ///   ON CONFLICT DO NOTHING 锁死在首判方向；同向重放在本函数入口即幂等短路，
    ///   不产生任何 mastery 写入；
    /// - 事务内不做副作用：SM-2 复习计划与 learner profile 回流由调用方在
    ///   commit / RELEASE 之后按返回的 `needs_review_plan` / `mastery_state` 执行。
    ///
    /// # 连接形态（pipeline 接入方式）
    /// `conn` 收 `&rusqlite::Connection`：
    /// - `Transaction` 经 Deref 直接传 `&tx`（本文件两条调用路径）；
    /// - pipeline.rs 用的是裸 Connection + 手工 SAVEPOINT（qbank_grading_persist），
    ///   在 SAVEPOINT 内直接传 `&conn` 即可，无需 with_conn 变体。
    ///   pipeline 侧调用：`QuestionBankService::new(Arc::clone(&deps.vfs_db))
    ///   .apply_submission_verdict_in_tx(&conn, &question, &submission, v.is_correct(), "ai", &now)`，
    ///   替换其 ②③ 段手写 SQL（借此修复 false→true 不 +1、true→false 不 -1
    ///   以及 AI 路不写 mastery 事件的分叉）。
    pub(crate) fn apply_submission_verdict_in_tx(
        &self,
        conn: &rusqlite::Connection,
        question: &Question,
        submission: &AnswerSubmission,
        new_is_correct: bool,
        grading_method: &str,
        now_rfc3339: &str,
    ) -> Result<VerdictApplyOutcome, AppError> {
        let question_id = question.id.as_str();

        // 同向改判幂等短路：连点两次"我答对了"/重放同一 AI verdict 不产生任何写入
        if submission.is_correct == Some(new_is_correct) {
            let updated_question = VfsQuestionRepo::get_question_with_conn(conn, question_id)
                .map_err(|e| AppError::database(e.to_string()))?
                .ok_or_else(|| {
                    AppError::not_found(format!("Question not found: {}", question_id))
                })?;
            let updated_stats = VfsQuestionRepo::refresh_stats_with_conn(conn, &question.exam_id)
                .map_err(|e| AppError::database(e.to_string()))?;
            return Ok(VerdictApplyOutcome {
                changed: false,
                updated_question,
                updated_stats,
                mastery_state: None,
                needs_review_plan: false,
            });
        }

        let is_correct_val: i32 = if new_is_correct { 1 } else { 0 };
        // correct_count 差值以"本 submission 的旧 is_correct"为基准（而非题目级旧值，
        // 避免评判期间用户又提交新答案时增量方向错乱）：
        // 未判定/错 → 对 +1；对 → 错 -1；其余不变
        let correct_delta: i64 = match (submission.is_correct, new_is_correct) {
            (Some(true), false) => -1,
            (None, true) | (Some(false), true) => 1,
            _ => 0,
        };

        // 严格绑定 submission_id + question_id，防止串题写入（与 pipeline 口径一致）。
        // RowSync：推进 updated_at/local_version，行级 LWW 才能识别本次改判为更新。
        let submission_updated = conn
            .execute(
                "UPDATE answer_submissions SET \
                     is_correct = ?1, \
                     grading_method = ?2, \
                     updated_at = ?3, \
                     local_version = COALESCE(local_version, 0) + 1 \
                 WHERE id = ?4 AND question_id = ?5",
                rusqlite::params![
                    is_correct_val,
                    grading_method,
                    now_rfc3339,
                    submission.id,
                    question_id
                ],
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        if submission_updated == 0 {
            return Err(AppError::not_found(format!(
                "作答记录不存在或不属于该题目: {}",
                submission.id
            )));
        }

        // 状态转换与 submit_answer_with_conn / pipeline.rs 保持同一 CASE 口径。
        conn.execute(
            r#"
            UPDATE questions SET
                is_correct = ?1,
                correct_count = MAX(0, correct_count + ?4),
                status = CASE
                    WHEN ?1 = 0 THEN 'review'
                    WHEN MAX(0, correct_count + ?4) >= 2 THEN 'mastered'
                    ELSE 'in_progress'
                END,
                updated_at = ?2
            WHERE id = ?3 AND deleted_at IS NULL
            "#,
            rusqlite::params![is_correct_val, now_rfc3339, question_id, correct_delta],
        )
        .map_err(|e| AppError::database(e.to_string()))?;

        // S-030 口径：改判修改了 is_correct/status，需标记同步并重算内容哈希
        crate::question_sync_service::QuestionSyncService::mark_as_modified_with_conn(
            conn,
            question_id,
        )
        .map_err(|e| AppError::database(e.to_string()))?;
        crate::question_sync_service::QuestionSyncService::update_content_hash_with_conn(
            conn,
            question_id,
        )
        .map_err(|e| AppError::database(e.to_string()))?;

        // mastery 事件分路（同向重放已在函数入口幂等短路，走不到这里）：
        // - 首次判定（旧 is_correct IS NULL）：record_qbank_answer_with_conn，
        //   幂等键 me_qbank_{sid} 保证首判恰好一次；
        // - 换判（Some(old) != new）：record_qbank_verdict_correction_with_conn，
        //   tombstone 旧信号并追加修订事件 me_qbank_{sid}_r{n}——不能再走
        //   record 路，否则 ON CONFLICT DO NOTHING 会把信号锁死在首判方向。
        let mastery = crate::mastery::MasteryService::new(Arc::clone(&self.vfs_db));
        let mastery_state = match submission.is_correct {
            None => mastery.record_qbank_answer_with_conn(
                conn,
                &submission.id,
                question_id,
                &question.tags,
                new_is_correct,
            )?,
            Some(_) => mastery.record_qbank_verdict_correction_with_conn(
                conn,
                &submission.id,
                question_id,
                &question.tags,
                new_is_correct,
            )?,
        };

        let updated_question = VfsQuestionRepo::get_question_with_conn(conn, question_id)
            .map_err(|e| AppError::database(e.to_string()))?
            .ok_or_else(|| AppError::not_found(format!("Question not found: {}", question_id)))?;
        let updated_stats = VfsQuestionRepo::refresh_stats_with_conn(conn, &question.exam_id)
            .map_err(|e| AppError::database(e.to_string()))?;

        Ok(VerdictApplyOutcome {
            changed: true,
            updated_question,
            updated_stats,
            mastery_state: Some(mastery_state),
            needs_review_plan: !new_is_correct,
        })
    }

    /// 改判落库外壳（submit_answer 待判定去重分支与 regrade_submission 共用）：
    /// 调 apply_submission_verdict_in_tx（grading_method='manual'）后提交事务，
    /// 再执行事务外副作用（SM-2 复习计划、learner profile 回流、当日进度快照）。
    fn regrade_submission_in_tx(
        &self,
        tx: rusqlite::Transaction<'_>,
        question: Question,
        submission: AnswerSubmission,
        is_correct: bool,
    ) -> Result<SubmitAnswerResult, AppError> {
        let question_id = question.id.clone();
        let now = chrono::Utc::now().to_rfc3339();

        let outcome = self.apply_submission_verdict_in_tx(
            &tx,
            &question,
            &submission,
            is_correct,
            "manual",
            &now,
        )?;

        tx.commit().map_err(|e| AppError::database(e.to_string()))?;

        // 改判为"错"时接通 SM-2 闭环（失败不阻塞，与 submit_answer 主路径一致）
        if outcome.needs_review_plan {
            let review_service =
                crate::review_plan_service::ReviewPlanService::new(Arc::clone(&self.vfs_db));
            if let Err(e) = review_service.get_or_create_plan(&question_id, &question.exam_id) {
                warn!(
                    "[QuestionBankService] Failed to auto-create review plan after regrade for question_id={}: {}",
                    question_id, e
                );
            }
        }

        if let Some(state) = outcome.mastery_state.as_ref() {
            let mastery = crate::mastery::MasteryService::new(Arc::clone(&self.vfs_db));
            if let Err(e) = mastery.sync_learner_profile(state) {
                warn!(
                    "[QuestionBankService] mastery profile reflux failed for question_id={}: {}",
                    question_id, e
                );
            }
        }

        if outcome.changed {
            info!(
                "[QuestionBankService] Regraded submission id={} for question id={}, {:?} -> {}",
                submission.id, question_id, submission.is_correct, is_correct
            );
        }

        let daily_progress = self.build_daily_progress_snapshot(&question.exam_id);

        Ok(SubmitAnswerResult {
            is_correct: Some(is_correct),
            correct_answer: question.answer,
            needs_manual_grading: false,
            message: if is_correct {
                "回答正确！".to_string()
            } else {
                "回答错误".to_string()
            },
            updated_question: outcome.updated_question,
            updated_stats: outcome.updated_stats,
            submission_id: submission.id,
            daily_progress,
        })
    }

    /// 全角字符归一化为半角
    ///
    /// - 全角空格 U+3000 → 半角空格
    /// - 全角 ASCII 区 U+FF01..=U+FF5E（含 Ａ-Ｚ、ａ-ｚ、０-９ 与全角标点）→ 对应半角字符
    ///
    /// 用于选择题/填空题判分，避免用户用中文输入法输入 "Ａ" 或 "１２３" 被误判为错误。
    fn normalize_fullwidth_char(c: char) -> char {
        match c {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            _ => c,
        }
    }

    /// 判断答案正确性
    ///
    /// 返回 `(is_correct, needs_manual_grading)`。
    ///
    /// 自动判分矩阵：
    /// - single/multiple/indefinite_choice：选项键集合比较（全角/大小写/标点归一化）
    /// - true_false：布尔宽松解析（true/false、对/错、√/× 等）
    /// - numeric：structured_data 携带 answer_value + tolerance（absolute|relative），
    ///   用户输入宽松解析（"3.14 m"、全角数字、千分位逗号、简单分数）
    /// - ordering：严格顺序比较（JSON 数组或分隔符序列）
    /// - matching：配对集合相等（{"pairs":[{"left","right"}]}）
    /// - fill_blank：有 structured_data.blanks 时逐空判分（多可接受答案 + case/trim 规则），
    ///   否则回退旧的单串模糊比对
    /// - short_answer/essay/calculation/proof：手动批改
    fn check_answer_correctness(
        user_answer: &str,
        correct_answer: Option<&str>,
        question_type: &QuestionType,
        structured_data: Option<&serde_json::Value>,
    ) -> (bool, bool) {
        let user_answer = user_answer.trim();

        // 参考答案（去空白后非空才算有效）。matching/ordering/numeric/fill_blank
        // 的标准答案可能存于 structured_data，因此不能在这里一票否决。
        let trimmed_answer = correct_answer.map(str::trim).filter(|a| !a.is_empty());

        match question_type {
            // 选择题：忽略大小写、全半角与标点
            QuestionType::SingleChoice => {
                let Some(correct_answer) = trimmed_answer else {
                    return (false, true);
                };
                let normalize = |s: &str| {
                    s.chars()
                        .map(Self::normalize_fullwidth_char)
                        .collect::<String>()
                        .to_uppercase()
                        .chars()
                        .filter(|c| c.is_alphanumeric())
                        .collect::<String>()
                };
                let mut is_correct = normalize(user_answer) == normalize(correct_answer);
                // 兜底：导入的参考答案可能是 "A. 选项全文" 形式，提取其中的独立选项字母再比较，
                // 避免用户选了正确选项却因答案串含选项内容而被判错
                if !is_correct {
                    if let (Some(user_keys), Some(correct_keys)) = (
                        Self::extract_choice_keys(user_answer),
                        Self::extract_choice_keys(correct_answer),
                    ) {
                        is_correct = user_keys == correct_keys;
                    }
                }
                (is_correct, false)
            }
            // 多选/不定项：全对才 correct（漏选、错选均判错）
            QuestionType::MultipleChoice | QuestionType::IndefiniteChoice => {
                let Some(correct_answer) = trimmed_answer else {
                    return (false, true);
                };
                let normalize = |s: &str| {
                    s.chars()
                        .map(Self::normalize_fullwidth_char)
                        .collect::<String>()
                        .to_uppercase()
                        .chars()
                        .filter(|c| c.is_alphanumeric())
                        .collect::<Vec<char>>()
                };
                let mut user_chars = normalize(user_answer);
                let mut correct_chars = normalize(correct_answer);
                user_chars.sort();
                correct_chars.sort();
                let mut is_correct = user_chars == correct_chars;
                // 兜底：同单选，支持 "A.内容 C.内容" 形式的参考答案
                if !is_correct {
                    if let (Some(user_keys), Some(correct_keys)) = (
                        Self::extract_choice_keys(user_answer),
                        Self::extract_choice_keys(correct_answer),
                    ) {
                        is_correct = user_keys == correct_keys;
                    }
                }
                (is_correct, false)
            }
            // 判断题：布尔宽松解析
            QuestionType::TrueFalse => {
                let Some(correct_answer) = trimmed_answer else {
                    return (false, true);
                };
                match (
                    Self::parse_bool_answer(user_answer),
                    Self::parse_bool_answer(correct_answer),
                ) {
                    (Some(user_val), Some(correct_val)) => (user_val == correct_val, false),
                    // 参考答案本身不是布尔值 → 数据问题，走手动批改
                    (_, None) => (false, true),
                    // 用户输入无法解析为布尔值 → 判错
                    (None, Some(_)) => (false, false),
                }
            }
            // 数值题：容差比较
            QuestionType::Numeric => {
                Self::grade_numeric(user_answer, trimmed_answer, structured_data)
            }
            // 排序题：严格顺序
            QuestionType::Ordering => {
                Self::grade_ordering(user_answer, trimmed_answer, structured_data)
            }
            // 匹配题：配对集合相等
            QuestionType::Matching => Self::grade_matching(user_answer, structured_data),
            // 填空题：优先按 structured_data.blanks 逐空判分，否则旧逻辑单串比对
            QuestionType::FillBlank => {
                Self::grade_fill_blank(user_answer, trimmed_answer, structured_data)
            }
            // 主观题：需要手动批改
            QuestionType::ShortAnswer
            | QuestionType::Essay
            | QuestionType::Calculation
            | QuestionType::Proof => (false, true),
            // 其他：全部走手动批改，精确匹配时判正确
            QuestionType::Other => {
                let Some(correct_answer) = trimmed_answer else {
                    return (false, true);
                };
                let is_exact_match = user_answer.to_lowercase() == correct_answer.to_lowercase();
                if is_exact_match {
                    (true, false) // 完全匹配，判正确
                } else {
                    (false, true) // 不匹配，需手动批改（而非直接判错）
                }
            }
        }
    }

    /// 从选择题答案文本中提取选项键集合（保守启发式）。
    ///
    /// 支持两种形态：
    /// 1. 纯键串："A"、"ABD"、"a,c"、"A、C"——除分隔符外只有 ASCII 字母；
    /// 2. 结构化："A. 选项内容 C. 选项内容"、"正确答案：A"——取左邻为边界、
    ///    右邻为键分隔符（或串尾）的独立字母。
    ///
    /// 不像键集合（含数字/内容文本且无结构化键）时返回 None，调用方保持原判定。
    /// 仅作为标准化精确比较失败后的兜底，避免参考答案携带选项全文时误判。
    fn extract_choice_keys(answer: &str) -> Option<std::collections::BTreeSet<char>> {
        const MAX_KEYS: usize = 8;
        // 先做全角→半角归一化：全角 "Ａ" / "（Ｂ）" 也应被识别为选项键。
        // 归一化后全角结构符（（）：．等）会落回下方边界字符集中的半角形式。
        let normalized: String = answer.chars().map(Self::normalize_fullwidth_char).collect();
        let trimmed = normalized.trim();
        if trimmed.is_empty() {
            return None;
        }

        // 形态一：纯键串（允许常见分隔符）
        let only_key_chars = trimmed
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c.is_whitespace() || ",，、;；/和与".contains(c));
        if only_key_chars {
            let letters: Vec<char> = trimmed
                .chars()
                .filter(|c| c.is_ascii_alphabetic())
                .map(|c| c.to_ascii_uppercase())
                .collect();
            let keys: std::collections::BTreeSet<char> = letters.iter().copied().collect();
            // 键不应重复出现（"the answer" 这类英文内容会有重复字母，拒绝识别为键串）
            if !keys.is_empty() && keys.len() <= MAX_KEYS && keys.len() == letters.len() {
                return Some(keys);
            }
            return None;
        }

        // 形态二：结构化键
        let chars: Vec<char> = trimmed.chars().collect();
        let mut keys = std::collections::BTreeSet::new();
        for (i, &c) in chars.iter().enumerate() {
            if !c.is_ascii_alphabetic() {
                continue;
            }
            let left_ok = if i == 0 {
                true
            } else {
                let p = chars[i - 1];
                p.is_whitespace() || "（(，,、;；:：选".contains(p)
            };
            let right_ok = match chars.get(i + 1) {
                None => true,
                Some(&n) => "．.、:：)）。".contains(n),
            };
            if left_ok && right_ok {
                keys.insert(c.to_ascii_uppercase());
            }
        }
        if !keys.is_empty() && keys.len() <= MAX_KEYS {
            Some(keys)
        } else {
            None
        }
    }

    /// 布尔答案宽松解析（判断题）
    ///
    /// 支持 true/false、t/f、1/0、对/错、正确/错误、是/否、√/×、✓/✗、yes/no 等常见写法。
    fn parse_bool_answer(raw: &str) -> Option<bool> {
        let normalized: String = raw
            .chars()
            .map(Self::normalize_fullwidth_char)
            .collect::<String>()
            .trim()
            .to_lowercase();
        match normalized.as_str() {
            "true" | "t" | "1" | "yes" | "y" | "对" | "正确" | "是" | "真" | "√" | "✓" | "✔" => {
                Some(true)
            }
            "false" | "f" | "0" | "no" | "n" | "错" | "错误" | "否" | "假" | "不对" | "×" | "✗"
            | "✘" | "x" => Some(false),
            _ => None,
        }
    }

    /// 数值宽松解析：全角归一化、去千分位逗号、截取首个数字 token（忽略单位后缀），
    /// 支持 "3.14 m"、"１２３"、"1,234.5"、"-2e3"、简单分数 "3/4"。
    fn parse_numeric_input(raw: &str) -> Option<f64> {
        let normalized: String = raw.chars().map(Self::normalize_fullwidth_char).collect();
        // 全角逗号已归一化为半角，这里统一去掉千分位逗号
        let cleaned = normalized.replace(',', "");
        let chars: Vec<char> = cleaned.chars().collect();

        // 在 pos 起始处解析一个数字 token，返回 (值, 结束位置)
        fn parse_number_at(chars: &[char], start: usize) -> Option<(f64, usize)> {
            let mut i = start;
            let mut token = String::new();
            if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
                token.push(chars[i]);
                i += 1;
            }
            let mut seen_digit = false;
            let mut seen_dot = false;
            let mut seen_exp = false;
            while i < chars.len() {
                let c = chars[i];
                if c.is_ascii_digit() {
                    seen_digit = true;
                    token.push(c);
                    i += 1;
                } else if c == '.' && !seen_dot && !seen_exp {
                    seen_dot = true;
                    token.push(c);
                    i += 1;
                } else if (c == 'e' || c == 'E') && seen_digit && !seen_exp {
                    // 仅当后随（可带符号的）数字时才视为指数，否则按单位处理（如 "3 eV"）
                    let mut j = i + 1;
                    if j < chars.len() && (chars[j] == '+' || chars[j] == '-') {
                        j += 1;
                    }
                    if j < chars.len() && chars[j].is_ascii_digit() {
                        seen_exp = true;
                        token.push('e');
                        if chars[i + 1] == '+' || chars[i + 1] == '-' {
                            token.push(chars[i + 1]);
                        }
                        i = j;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            if !seen_digit {
                return None;
            }
            token.parse::<f64>().ok().map(|v| (v, i))
        }

        // 定位第一个数字 token 的起点（数字，或后随数字的符号/小数点，含 "-.5"）
        let mut start = None;
        for (i, c) in chars.iter().enumerate() {
            let next_is_numeric = chars.get(i + 1).is_some_and(|n| n.is_ascii_digit());
            let signed_dot = (*c == '+' || *c == '-')
                && chars.get(i + 1) == Some(&'.')
                && chars.get(i + 2).is_some_and(|n| n.is_ascii_digit());
            if c.is_ascii_digit()
                || ((*c == '+' || *c == '-' || *c == '.') && next_is_numeric)
                || signed_dot
            {
                start = Some(i);
                break;
            }
        }
        let (value, end) = parse_number_at(&chars, start?)?;

        // 简单分数支持："3/4"、"3 / 4"
        let mut j = end;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        if j < chars.len() && chars[j] == '/' {
            j += 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if let Some((denominator, _)) = parse_number_at(&chars, j) {
                if denominator != 0.0 {
                    return Some(value / denominator);
                }
                return None;
            }
        }

        Some(value)
    }

    /// 数值题判分
    ///
    /// structured_data：{"answer_value":3.14,"tolerance":0.01,"unit":"m","tolerance_mode":"absolute"}
    /// tolerance_mode 支持 "absolute"（默认）| "relative"。
    /// 无 structured_data 时回退解析 answer 字符串（相对误差 1e-9 内视为相等）。
    fn grade_numeric(
        user_answer: &str,
        correct_answer: Option<&str>,
        structured_data: Option<&serde_json::Value>,
    ) -> (bool, bool) {
        let structured_answer = structured_data.and_then(|sd| {
            sd.get("answer_value")
                .and_then(|v| v.as_f64())
                .map(|a| (sd, a))
        });
        if let Some((sd, answer_value)) = structured_answer {
            let Some(user_value) = Self::parse_numeric_input(user_answer) else {
                return (false, false);
            };
            let tolerance = sd
                .get("tolerance")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                .abs();
            let mode = sd
                .get("tolerance_mode")
                .and_then(|v| v.as_str())
                .unwrap_or("absolute");
            let limit = if mode.eq_ignore_ascii_case("relative") {
                tolerance * answer_value.abs()
            } else {
                tolerance
            };
            // 浮点噪声补偿：叠加在容差上（而非取 max），既覆盖 tolerance=0 的
            // 精确比较，也避免 |3.15-3.14| 这类边界值因二进制表示误差被误判。
            let epsilon = f64::EPSILON * answer_value.abs().max(1.0) * 4.0;
            return ((user_value - answer_value).abs() <= limit + epsilon, false);
        }

        // 回退：从 answer 字符串解析参考值
        let Some(correct_answer) = correct_answer else {
            return (false, true);
        };
        match (
            Self::parse_numeric_input(user_answer),
            Self::parse_numeric_input(correct_answer),
        ) {
            (Some(user_value), Some(correct_value)) => {
                let scale = correct_value.abs().max(1.0);
                ((user_value - correct_value).abs() <= 1e-9 * scale, false)
            }
            // 参考答案不是数字 → 数据问题，走手动批改
            (_, None) => (false, true),
            (None, Some(_)) => (false, false),
        }
    }

    /// 解析序列答案：优先 JSON 数组（字符串/数字元素），否则按常见分隔符拆分。
    fn parse_sequence_answer(raw: &str) -> Option<Vec<String>> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Ok(serde_json::Value::Array(items)) = serde_json::from_str(trimmed) {
            let mut result = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    serde_json::Value::String(s) => result.push(s),
                    serde_json::Value::Number(n) => result.push(n.to_string()),
                    _ => return None,
                }
            }
            return if result.is_empty() {
                None
            } else {
                Some(result)
            };
        }
        // 分隔符回退："B,A,C"、"B、A、C"、"B → A → C"
        let normalized: String = trimmed
            .chars()
            .map(Self::normalize_fullwidth_char)
            .collect();
        let replaced = normalized
            .replace("->", ",")
            .replace('→', ",")
            .replace('⇒', ",");
        let parts: Vec<String> = replaced
            .split([',', ';', '、', '，', '；', '|', ' '])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        if parts.is_empty() {
            None
        } else {
            Some(parts)
        }
    }

    /// 序列 key 归一化：全角归一化 + trim + 大写（选项 key 通常为字母/短标识）
    fn normalize_sequence_key(key: &str) -> String {
        key.chars()
            .map(Self::normalize_fullwidth_char)
            .collect::<String>()
            .trim()
            .to_uppercase()
    }

    /// 排序题判分：严格顺序比较
    ///
    /// structured_data：{"items":[{"key":"A","content":"..."}],"correct_order":["B","A","C"]}
    /// user_answer：JSON 数组字符串 ["B","A","C"]（或分隔符序列兜底）。
    fn grade_ordering(
        user_answer: &str,
        correct_answer: Option<&str>,
        structured_data: Option<&serde_json::Value>,
    ) -> (bool, bool) {
        let correct_order: Option<Vec<String>> = structured_data
            .and_then(|sd| sd.get("correct_order"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .filter(|v: &Vec<String>| !v.is_empty())
            .or_else(|| correct_answer.and_then(Self::parse_sequence_answer));

        let Some(correct_order) = correct_order else {
            // 没有可用的标准顺序 → 手动批改
            return (false, true);
        };
        let Some(user_order) = Self::parse_sequence_answer(user_answer) else {
            return (false, false);
        };

        let normalized_correct: Vec<String> = correct_order
            .iter()
            .map(|k| Self::normalize_sequence_key(k))
            .collect();
        let normalized_user: Vec<String> = user_order
            .iter()
            .map(|k| Self::normalize_sequence_key(k))
            .collect();
        (normalized_user == normalized_correct, false)
    }

    /// 匹配题判分：配对集合相等
    ///
    /// structured_data：{"left":[...],"right":[...],"pairs":[{"left":"L1","right":"R2"}]}
    /// user_answer：{"pairs":[{"left":"L1","right":"R1"}]}（或裸 pairs 数组兜底）。
    fn grade_matching(
        user_answer: &str,
        structured_data: Option<&serde_json::Value>,
    ) -> (bool, bool) {
        fn pairs_from_value(value: &serde_json::Value) -> Option<Vec<(String, String)>> {
            let array = match value {
                serde_json::Value::Array(arr) => arr,
                serde_json::Value::Object(_) => value.get("pairs")?.as_array()?,
                _ => return None,
            };
            let mut pairs = Vec::with_capacity(array.len());
            for item in array {
                let left = item.get("left")?.as_str()?;
                let right = item.get("right")?.as_str()?;
                pairs.push((left.to_string(), right.to_string()));
            }
            Some(pairs)
        }

        let correct_pairs = structured_data
            .and_then(pairs_from_value)
            .filter(|p| !p.is_empty());
        let Some(correct_pairs) = correct_pairs else {
            // 没有标准配对 → 手动批改
            return (false, true);
        };

        let user_pairs = serde_json::from_str::<serde_json::Value>(user_answer.trim())
            .ok()
            .as_ref()
            .and_then(pairs_from_value);
        let Some(user_pairs) = user_pairs else {
            return (false, false);
        };

        let to_set = |pairs: &[(String, String)]| {
            pairs
                .iter()
                .map(|(l, r)| {
                    (
                        Self::normalize_sequence_key(l),
                        Self::normalize_sequence_key(r),
                    )
                })
                .collect::<std::collections::BTreeSet<_>>()
        };
        let user_set = to_set(&user_pairs);
        let correct_set = to_set(&correct_pairs);
        // 集合相等且无重复配对（重复配对去重后数量会缩水，防止 "L1-R1" 提交两次凑数）
        let is_correct = user_set == correct_set && user_pairs.len() == user_set.len();
        (is_correct, false)
    }

    /// 填空题判分
    ///
    /// 有 structured_data.blanks 时逐空判分：
    /// {"blanks":[{"answers":["答案1","答案一"],"case_sensitive":false,"trim":true}]}
    /// user_answer 为 JSON 数组字符串 ["ans1","ans2"]；单空兼容旧的裸字符串。
    /// 无 structured_data 时回退旧逻辑（忽略空白/大小写/全半角的单串比对）。
    fn grade_fill_blank(
        user_answer: &str,
        correct_answer: Option<&str>,
        structured_data: Option<&serde_json::Value>,
    ) -> (bool, bool) {
        let blanks = structured_data
            .and_then(|sd| sd.get("blanks"))
            .and_then(|v| v.as_array())
            .filter(|arr| !arr.is_empty());

        if let Some(blanks) = blanks {
            // 解析用户答案：JSON 数组，或（单空时）裸字符串兼容
            let user_values: Vec<String> =
                match serde_json::from_str::<serde_json::Value>(user_answer.trim()) {
                    Ok(serde_json::Value::Array(items)) => items
                        .into_iter()
                        .map(|v| match v {
                            serde_json::Value::String(s) => s,
                            other => other.to_string(),
                        })
                        .collect(),
                    _ => vec![user_answer.to_string()],
                };
            if user_values.len() != blanks.len() {
                return (false, false);
            }

            let normalize = |s: &str, case_sensitive: bool, trim: bool| -> String {
                let mut value: String = s.chars().map(Self::normalize_fullwidth_char).collect();
                if trim {
                    value = value.trim().to_string();
                }
                if !case_sensitive {
                    value = value.to_lowercase();
                }
                value
            };

            for (blank, user_value) in blanks.iter().zip(user_values.iter()) {
                let Some(answers) = blank.get("answers").and_then(|v| v.as_array()) else {
                    // 空位缺少可接受答案 → 数据问题，走手动批改
                    return (false, true);
                };
                if answers.is_empty() {
                    return (false, true);
                }
                let case_sensitive = blank
                    .get("case_sensitive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let trim = blank.get("trim").and_then(|v| v.as_bool()).unwrap_or(true);

                let normalized_user = normalize(user_value, case_sensitive, trim);
                let matched = answers
                    .iter()
                    .filter_map(|a| a.as_str())
                    .any(|accepted| normalize(accepted, case_sensitive, trim) == normalized_user);
                if !matched {
                    return (false, false);
                }
            }
            return (true, false);
        }

        // 旧逻辑：单串模糊匹配（忽略空白、大小写与全半角差异）
        let Some(correct_answer) = correct_answer else {
            return (false, true);
        };
        let normalize = |s: &str| -> String {
            s.chars()
                .map(Self::normalize_fullwidth_char)
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .to_lowercase()
        };
        (normalize(user_answer) == normalize(correct_answer), false)
    }

    /// 切换收藏状态
    pub fn toggle_favorite(&self, question_id: &str) -> Result<Question, AppError> {
        let question = self
            .get_question(question_id)?
            .ok_or_else(|| AppError::not_found(format!("Question not found: {}", question_id)))?;

        let params = UpdateQuestionParams {
            is_favorite: Some(!question.is_favorite),
            ..Default::default()
        };

        self.update_question(question_id, &params, false)
    }

    /// 更新题目状态
    pub fn update_status(
        &self,
        question_id: &str,
        status: QuestionStatus,
    ) -> Result<Question, AppError> {
        let params = UpdateQuestionParams {
            status: Some(status),
            ..Default::default()
        };

        self.update_question(question_id, &params, false)
    }

    // ========================================================================
    // 统计
    // ========================================================================

    /// 获取统计（优先读缓存）
    pub fn get_stats(&self, exam_id: &str) -> Result<Option<QuestionBankStats>, AppError> {
        VfsQuestionRepo::get_stats(&self.vfs_db, exam_id)
            .map_err(|e| AppError::database(e.to_string()))
    }

    /// 刷新统计（重新计算）
    pub fn refresh_stats(&self, exam_id: &str) -> Result<QuestionBankStats, AppError> {
        VfsQuestionRepo::refresh_stats(&self.vfs_db, exam_id)
            .map_err(|e| AppError::database(e.to_string()))
    }

    // ========================================================================
    // 历史记录
    // ========================================================================

    /// 获取历史记录
    pub fn get_history(
        &self,
        question_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<QuestionHistory>, AppError> {
        VfsQuestionRepo::get_history(&self.vfs_db, question_id, limit)
            .map_err(|e| AppError::database(e.to_string()))
    }

    /// 获取作答历史
    pub fn get_submissions(
        &self,
        question_id: &str,
        limit: u32,
    ) -> Result<Vec<AnswerSubmission>, AppError> {
        VfsQuestionRepo::get_submissions(&self.vfs_db, question_id, limit)
            .map_err(|e| AppError::database(e.to_string()))
    }

    /// 记录变更历史
    fn record_changes(
        &self,
        old: &Question,
        new: &Question,
        operator: &str,
    ) -> Result<(), AppError> {
        // 比较各字段，记录变化
        if old.content != new.content {
            VfsQuestionRepo::record_history(
                &self.vfs_db,
                &new.id,
                "content",
                Some(&old.content),
                Some(&new.content),
                operator,
                None,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        }

        if old.answer != new.answer {
            VfsQuestionRepo::record_history(
                &self.vfs_db,
                &new.id,
                "answer",
                old.answer.as_deref(),
                new.answer.as_deref(),
                operator,
                None,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        }

        if old.explanation != new.explanation {
            VfsQuestionRepo::record_history(
                &self.vfs_db,
                &new.id,
                "explanation",
                old.explanation.as_deref(),
                new.explanation.as_deref(),
                operator,
                None,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        }

        // 结构化数据变更（新题型标准答案属于内容变更，纳入历史）
        if old.structured_data != new.structured_data {
            let old_val = old.structured_data.as_ref().map(|v| v.to_string());
            let new_val = new.structured_data.as_ref().map(|v| v.to_string());
            VfsQuestionRepo::record_history(
                &self.vfs_db,
                &new.id,
                "structured_data",
                old_val.as_deref(),
                new_val.as_deref(),
                operator,
                None,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        }

        // 图片变更
        if old.images != new.images {
            let old_val = serde_json::to_string(&old.images).ok();
            let new_val = serde_json::to_string(&new.images).ok();
            VfsQuestionRepo::record_history(
                &self.vfs_db,
                &new.id,
                "images",
                old_val.as_deref(),
                new_val.as_deref(),
                operator,
                None,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        }

        Ok(())
    }

    // ========================================================================
    // 重置进度
    // ========================================================================

    /// 重置学习进度
    pub fn reset_progress(&self, exam_id: &str) -> Result<QuestionBankStats, AppError> {
        let mut conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(e.to_string()))?;

        let now = chrono::Utc::now().to_rfc3339();

        tx.execute(
            r#"
            UPDATE questions SET
                status = 'new',
                user_answer = NULL,
                is_correct = NULL,
                attempt_count = 0,
                correct_count = 0,
                last_attempt_at = NULL,
                ai_feedback = NULL,
                ai_score = NULL,
                ai_graded_at = NULL,
                updated_at = ?1
            WHERE exam_id = ?2 AND deleted_at IS NULL
            "#,
            rusqlite::params![now, exam_id],
        )
        .map_err(|e| AppError::database(e.to_string()))?;

        // S-030 口径：重置也是本地修改，需标记同步状态并重算 content hash，
        // 否则云同步会把本地重置当作"未变更"而用远端旧进度覆盖。
        let question_ids: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT id FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL")
                .map_err(|e| AppError::database(e.to_string()))?;
            let rows = stmt
                .query_map(rusqlite::params![exam_id], |row| row.get::<_, String>(0))
                .map_err(|e| AppError::database(e.to_string()))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for qid in &question_ids {
            crate::question_sync_service::QuestionSyncService::mark_as_modified_with_conn(&tx, qid)
                .map_err(|e| AppError::database(e.to_string()))?;
            crate::question_sync_service::QuestionSyncService::update_content_hash_with_conn(
                &tx, qid,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        }

        // 清除作答历史
        VfsQuestionRepo::delete_submissions_by_exam_with_conn(&tx, exam_id)
            .map_err(|e| AppError::database(e.to_string()))?;

        let stats = VfsQuestionRepo::refresh_stats_with_conn(&tx, exam_id)
            .map_err(|e| AppError::database(e.to_string()))?;

        tx.commit().map_err(|e| AppError::database(e.to_string()))?;

        info!(
            "[QuestionBankService] Reset progress for exam_id={} (including submissions & AI cache)",
            exam_id
        );

        Ok(stats)
    }

    /// 按题目 ID 批量重置学习进度
    pub fn reset_questions_progress(
        &self,
        question_ids: &[String],
    ) -> Result<BatchResult, AppError> {
        if question_ids.is_empty() {
            return Ok(BatchResult {
                success_count: 0,
                failed_count: 0,
                errors: Vec::new(),
            });
        }

        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::database(e.to_string()))?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut success_count = 0;
        let mut errors = Vec::new();
        let mut exam_ids: HashSet<String> = HashSet::new();

        for question_id in question_ids {
            if let Err(e) = tx.execute_batch("SAVEPOINT qbank_reset_question_progress") {
                errors.push(format!("{}: {}", question_id, e));
                continue;
            }

            let per_question_result = (|| -> Result<String, AppError> {
                let exam_id: String = tx
                    .query_row(
                        "SELECT exam_id FROM questions WHERE id = ?1 AND deleted_at IS NULL",
                        rusqlite::params![question_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| match e {
                        rusqlite::Error::QueryReturnedNoRows => {
                            AppError::validation(format!("{}: not found", question_id))
                        }
                        _ => AppError::database(e.to_string()),
                    })?;

                let affected = tx
                    .execute(
                        r#"
                        UPDATE questions SET
                            status = 'new',
                            user_answer = NULL,
                            is_correct = NULL,
                            attempt_count = 0,
                            correct_count = 0,
                            last_attempt_at = NULL,
                            ai_feedback = NULL,
                            ai_score = NULL,
                            ai_graded_at = NULL,
                            updated_at = ?1
                        WHERE id = ?2 AND deleted_at IS NULL
                        "#,
                        rusqlite::params![now, question_id],
                    )
                    .map_err(|e| AppError::database(e.to_string()))?;

                if affected == 0 {
                    return Err(AppError::validation(format!("{}: not found", question_id)));
                }

                // S-030 口径：重置需标记同步状态并重算 content hash（与 reset_progress 一致）
                crate::question_sync_service::QuestionSyncService::mark_as_modified_with_conn(
                    &tx,
                    question_id,
                )
                .map_err(|e| AppError::database(e.to_string()))?;
                crate::question_sync_service::QuestionSyncService::update_content_hash_with_conn(
                    &tx,
                    question_id,
                )
                .map_err(|e| AppError::database(e.to_string()))?;

                VfsQuestionRepo::delete_submissions_by_question_with_conn(&tx, question_id)
                    .map_err(|e| AppError::database(e.to_string()))?;

                Ok(exam_id)
            })();

            match per_question_result {
                Ok(exam_id) => {
                    if let Err(e) =
                        tx.execute_batch("RELEASE SAVEPOINT qbank_reset_question_progress")
                    {
                        errors.push(format!("{}: {}", question_id, e));
                        let _ = tx.execute_batch(
                            "ROLLBACK TO SAVEPOINT qbank_reset_question_progress; RELEASE SAVEPOINT qbank_reset_question_progress;",
                        );
                        continue;
                    }
                    success_count += 1;
                    exam_ids.insert(exam_id);
                }
                Err(e) => {
                    let _ = tx.execute_batch(
                        "ROLLBACK TO SAVEPOINT qbank_reset_question_progress; RELEASE SAVEPOINT qbank_reset_question_progress;",
                    );
                    errors.push(e.to_string());
                }
            }
        }

        for exam_id in &exam_ids {
            if let Err(e) = VfsQuestionRepo::refresh_stats_with_conn(&tx, exam_id) {
                let msg = format!("{}: refresh stats failed: {}", exam_id, e);
                errors.push(msg.clone());
                log::warn!("[QuestionBank] {}", msg);
            }
        }
        tx.commit().map_err(|e| AppError::database(e.to_string()))?;

        Ok(BatchResult {
            success_count,
            failed_count: errors.len(),
            errors,
        })
    }

    // ========================================================================
    // 时间维度统计（2026-01 新增）
    // ========================================================================

    /// 获取学习趋势数据
    ///
    /// 返回指定日期范围内的每日做题数和正确率
    pub fn get_learning_trend(
        &self,
        exam_id: Option<&str>,
        start_date: &str,
        end_date: &str,
    ) -> Result<Vec<LearningTrendPoint>, AppError> {
        // 输入校验：非法/倒置/超大范围此前会静默返回未填充数据或生成上万个填充点
        let start = chrono::NaiveDate::parse_from_str(start_date, "%Y-%m-%d")
            .map_err(|_| AppError::validation("开始日期格式无效，应为 YYYY-MM-DD"))?;
        let end = chrono::NaiveDate::parse_from_str(end_date, "%Y-%m-%d")
            .map_err(|_| AppError::validation("结束日期格式无效，应为 YYYY-MM-DD"))?;
        if start > end {
            return Err(AppError::validation("开始日期不能晚于结束日期"));
        }
        if (end - start).num_days() > 3700 {
            return Err(AppError::validation("日期范围过大（最多支持约 10 年）"));
        }

        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        // 构建基础查询。列名必须带 q. 前缀完全限定：answer_submissions 自
        // V20260523 起也有 deleted_at 列，裸 `deleted_at` 会在 JOIN 中触发
        // "ambiguous column name"，导致按题目集查询学习趋势直接报错。
        let (base_condition, params): (String, Vec<String>) = if let Some(eid) = exam_id {
            (
                "q.exam_id = ?1 AND q.deleted_at IS NULL".to_string(),
                vec![eid.to_string()],
            )
        } else {
            ("q.deleted_at IS NULL".to_string(), vec![])
        };

        // 从 answer_submissions 表统计每日做题次数（而非 questions.last_attempt_at 统计题数）
        // DATE(…, 'localtime')：按本地日界线分组，与打卡/热力图口径一致
        let sql = format!(
            r#"
            SELECT
                DATE(s.submitted_at, 'localtime') as date,
                COUNT(*) as attempt_count,
                SUM(CASE WHEN s.is_correct = 1 THEN 1 ELSE 0 END) as correct_count
            FROM answer_submissions s
            INNER JOIN questions q ON s.question_id = q.id
            WHERE {}
                AND s.submitted_at IS NOT NULL
                AND DATE(s.submitted_at, 'localtime') >= ?
                AND DATE(s.submitted_at, 'localtime') <= ?
            GROUP BY DATE(s.submitted_at, 'localtime')
            ORDER BY date ASC
            "#,
            base_condition
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut rows = if exam_id.is_some() {
            stmt.query(rusqlite::params![params[0], start_date, end_date])
        } else {
            stmt.query(rusqlite::params![start_date, end_date])
        }
        .map_err(|e| AppError::database(e.to_string()))?;

        let mut trends = Vec::new();
        while let Some(row) = rows.next().map_err(|e| AppError::database(e.to_string()))? {
            let date: String = row.get(0).unwrap_or_default();
            let attempt_count: i64 = row.get(1).unwrap_or(0);
            let correct_count: i64 = row.get(2).unwrap_or(0);

            let correct_rate = if attempt_count > 0 {
                (correct_count as f64 / attempt_count as f64 * 100.0).round()
            } else {
                0.0
            };

            trends.push(LearningTrendPoint {
                date,
                attempt_count: attempt_count as i32,
                correct_count: correct_count as i32,
                correct_rate,
            });
        }

        // 填充缺失的日期
        let filled_trends = self.fill_missing_dates(&trends, start_date, end_date);

        Ok(filled_trends)
    }

    /// 填充缺失的日期（返回连续的日期序列）
    fn fill_missing_dates(
        &self,
        data: &[LearningTrendPoint],
        start_date: &str,
        end_date: &str,
    ) -> Vec<LearningTrendPoint> {
        use chrono::{Duration, NaiveDate};

        let start = match NaiveDate::parse_from_str(start_date, "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => return data.to_vec(),
        };
        let end = match NaiveDate::parse_from_str(end_date, "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => return data.to_vec(),
        };

        let data_map: std::collections::HashMap<String, &LearningTrendPoint> =
            data.iter().map(|p| (p.date.clone(), p)).collect();

        let mut result = Vec::new();
        let mut current = start;

        while current <= end {
            let date_str = current.format("%Y-%m-%d").to_string();
            if let Some(point) = data_map.get(&date_str) {
                result.push((*point).clone());
            } else {
                result.push(LearningTrendPoint {
                    date: date_str,
                    attempt_count: 0,
                    correct_count: 0,
                    correct_rate: 0.0,
                });
            }
            current += Duration::days(1);
        }

        result
    }

    /// 获取活跃度热力图数据
    ///
    /// 返回指定年份的每日学习活跃度数据
    pub fn get_activity_heatmap(
        &self,
        exam_id: Option<&str>,
        year: i32,
    ) -> Result<Vec<ActivityHeatmapPoint>, AppError> {
        if !(1970..=9999).contains(&year) {
            return Err(AppError::validation("年份无效"));
        }

        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        let start_date = format!("{}-01-01", year);
        let end_date = format!("{}-12-31", year);

        // 构建基础查询条件
        let base_condition = if exam_id.is_some() {
            "q.exam_id = ?1 AND q.deleted_at IS NULL"
        } else {
            "q.deleted_at IS NULL"
        };

        // 查询每日活跃度：以 answer_submissions 为准（与 get_learning_trend 口径一致），
        // 重复练习不会把题目从历史日期"挪走"；无提交记录的存量题按 last_attempt_at 兜底。
        // DATE(…, 'localtime') 使日界线与 chrono::Local（连续打卡判定）一致。
        let sql = format!(
            r#"
            SELECT date, COUNT(*) as count, SUM(correct) as correct_count FROM (
                SELECT
                    DATE(s.submitted_at, 'localtime') as date,
                    s.question_id,
                    MAX(CASE WHEN s.is_correct = 1 THEN 1 ELSE 0 END) as correct
                FROM answer_submissions s
                INNER JOIN questions q ON q.id = s.question_id
                WHERE {cond}
                GROUP BY DATE(s.submitted_at, 'localtime'), s.question_id
                UNION ALL
                SELECT
                    DATE(q.last_attempt_at, 'localtime') as date,
                    q.id,
                    CASE WHEN q.is_correct = 1 THEN 1 ELSE 0 END as correct
                FROM questions q
                WHERE {cond}
                    AND q.last_attempt_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM answer_submissions s2 WHERE s2.question_id = q.id)
            )
            WHERE date >= ? AND date <= ?
            GROUP BY date
            ORDER BY date ASC
            "#,
            cond = base_condition
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut rows = if let Some(eid) = exam_id {
            stmt.query(rusqlite::params![eid, start_date, end_date])
        } else {
            stmt.query(rusqlite::params![start_date, end_date])
        }
        .map_err(|e| AppError::database(e.to_string()))?;

        let mut heatmap = Vec::new();
        while let Some(row) = rows.next().map_err(|e| AppError::database(e.to_string()))? {
            let date: String = row.get(0).unwrap_or_default();
            let count: i64 = row.get(1).unwrap_or(0);
            let correct_count: i64 = row.get(2).unwrap_or(0);

            // 计算活跃等级（0-4）
            let level = match count {
                0 => 0,
                1..=3 => 1,
                4..=6 => 2,
                7..=10 => 3,
                _ => 4,
            };

            heatmap.push(ActivityHeatmapPoint {
                date,
                count: count as i32,
                correct_count: correct_count as i32,
                level,
            });
        }

        Ok(heatmap)
    }

    /// 获取知识点统计（按标签维度）
    ///
    /// 返回各知识点的掌握度统计
    pub fn get_knowledge_stats(
        &self,
        exam_id: Option<&str>,
    ) -> Result<Vec<KnowledgePoint>, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        // 构建基础查询条件
        let base_condition = if exam_id.is_some() {
            "exam_id = ?1 AND deleted_at IS NULL"
        } else {
            "deleted_at IS NULL"
        };

        // 1. 首先获取所有标签及其题目统计
        let sql = format!(
            r#"
            SELECT
                json_each.value as tag,
                COUNT(*) as total,
                SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) as mastered,
                SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
                SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review,
                SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
                SUM(attempt_count) as total_attempts,
                SUM(correct_count) as total_correct
            FROM questions, json_each(questions.tags)
            WHERE {}
            GROUP BY json_each.value
            HAVING total >= 1
            ORDER BY total DESC
            LIMIT 10
            "#,
            base_condition
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut rows = if let Some(eid) = exam_id {
            stmt.query(rusqlite::params![eid])
        } else {
            stmt.query([])
        }
        .map_err(|e| AppError::database(e.to_string()))?;

        let mut knowledge_points = Vec::new();
        while let Some(row) = rows.next().map_err(|e| AppError::database(e.to_string()))? {
            let tag: String = row.get(0).unwrap_or_default();
            let total: i64 = row.get(1).unwrap_or(0);
            let mastered: i64 = row.get(2).unwrap_or(0);
            let in_progress: i64 = row.get(3).unwrap_or(0);
            let review: i64 = row.get(4).unwrap_or(0);
            let new_count: i64 = row.get(5).unwrap_or(0);
            let total_attempts: i64 = row.get(6).unwrap_or(0);
            let total_correct: i64 = row.get(7).unwrap_or(0);

            // 计算掌握度百分比（已掌握 + 学习中 * 0.5）
            let mastery_rate = if total > 0 {
                ((mastered as f64 + in_progress as f64 * 0.5) / total as f64 * 100.0).round()
            } else {
                0.0
            };

            // 计算正确率
            let correct_rate = if total_attempts > 0 {
                (total_correct as f64 / total_attempts as f64 * 100.0).round()
            } else {
                0.0
            };

            knowledge_points.push(KnowledgePoint {
                tag,
                total: total as i32,
                mastered: mastered as i32,
                in_progress: in_progress as i32,
                review: review as i32,
                new_count: new_count as i32,
                mastery_rate,
                correct_rate,
            });
        }

        Ok(knowledge_points)
    }

    /// 获取知识点统计（带历史对比）
    ///
    /// 返回当前和上周的知识点掌握度对比
    pub fn get_knowledge_stats_with_comparison(
        &self,
        exam_id: Option<&str>,
    ) -> Result<KnowledgeStatsComparison, AppError> {
        // 当前统计
        let current = self.get_knowledge_stats(exam_id)?;

        // 计算上周同期的数据（简化处理：返回空数据表示暂无历史对比）
        // TODO: 实现历史快照对比功能
        let previous = Vec::new();

        Ok(KnowledgeStatsComparison { current, previous })
    }

    // ========================================================================
    // 练习模式扩展（2026-01 新增）
    // ========================================================================

    /// 开始限时练习
    ///
    /// # Arguments
    /// * `exam_id` - 题目集 ID
    /// * `duration_minutes` - 限时（分钟）
    /// * `question_count` - 题目数量
    ///
    /// # Returns
    /// 限时练习会话
    pub fn start_timed_practice(
        &self,
        exam_id: &str,
        duration_minutes: u32,
        question_count: u32,
    ) -> Result<TimedPracticeSession, AppError> {
        if question_count == 0 {
            return Err(AppError::validation("题目数量必须大于 0"));
        }
        if duration_minutes == 0 {
            return Err(AppError::validation("限时时长必须大于 0 分钟"));
        }

        // M-031: 使用 SQL 层随机抽取，避免全量加载
        let question_ids = VfsQuestionRepo::random_question_ids(
            &self.vfs_db,
            exam_id,
            &QuestionFilters::default(),
            &[],
            None,
            question_count,
        )
        .map_err(|e| AppError::database(e.to_string()))?;

        if question_ids.is_empty() {
            return Err(AppError::validation("题目集中没有题目"));
        }

        let actual_count = question_ids.len();

        let session = TimedPracticeSession {
            id: uuid::Uuid::new_v4().to_string(),
            exam_id: exam_id.to_string(),
            duration_minutes,
            question_count: actual_count as u32,
            question_ids,
            started_at: chrono::Utc::now().to_rfc3339(),
            ended_at: None,
            answered_count: 0,
            correct_count: 0,
            is_timeout: false,
            is_submitted: false,
            paused_seconds: 0,
            is_paused: false,
        };

        info!(
            "[QuestionBankService] Started timed practice: id={}, exam_id={}, duration={}min, count={}",
            session.id, exam_id, duration_minutes, actual_count
        );

        Ok(session)
    }

    /// 生成模拟考试
    ///
    /// # Arguments
    /// * `exam_id` - 题目集 ID
    /// * `config` - 模拟考试配置
    ///
    /// # Returns
    /// 模拟考试会话
    pub fn generate_mock_exam(
        &self,
        exam_id: &str,
        config: MockExamConfig,
    ) -> Result<MockExamSession, AppError> {
        // M-031: 使用 SQL 层随机抽取，避免全量加载
        let mut selected_ids: Vec<String> = Vec::new();

        // 构建基础筛选条件（标签 + 是否排除错题）
        let mut base_filters = QuestionFilters::default();
        if let Some(tags) = &config.tags {
            base_filters.tags = Some(tags.clone());
        }
        if !config.include_mistakes {
            // 排除 Review 状态：只选 New / InProgress / Mastered
            base_filters.status = Some(vec![
                QuestionStatus::New,
                QuestionStatus::InProgress,
                QuestionStatus::Mastered,
            ]);
        }

        // 按题型配比选题
        if !config.type_distribution.is_empty() {
            for (qtype, count) in &config.type_distribution {
                let type_filters = QuestionFilters {
                    question_type: Some(vec![QuestionType::from_str(&qtype.to_lowercase())]),
                    tags: base_filters.tags.clone(),
                    status: base_filters.status.clone(),
                    ..Default::default()
                };
                let ids = VfsQuestionRepo::random_question_ids(
                    &self.vfs_db,
                    exam_id,
                    &type_filters,
                    &selected_ids,
                    None,
                    *count,
                )
                .map_err(|e| AppError::database(e.to_string()))?;
                selected_ids.extend(ids);
            }
        }

        // 按难度配比选题
        if !config.difficulty_distribution.is_empty() {
            for (diff, count) in &config.difficulty_distribution {
                let diff_filters = QuestionFilters {
                    difficulty: Some(vec![Difficulty::from_str(&diff.to_lowercase())]),
                    tags: base_filters.tags.clone(),
                    status: base_filters.status.clone(),
                    ..Default::default()
                };
                let ids = VfsQuestionRepo::random_question_ids(
                    &self.vfs_db,
                    exam_id,
                    &diff_filters,
                    &selected_ids,
                    None,
                    *count,
                )
                .map_err(|e| AppError::database(e.to_string()))?;
                selected_ids.extend(ids);
            }
        }

        // 如果配比未选够题目，补充到总数
        if let Some(total) = config.total_count {
            if selected_ids.len() < total as usize {
                let need = (total as usize - selected_ids.len()) as u32;
                let fill_ids = VfsQuestionRepo::random_question_ids(
                    &self.vfs_db,
                    exam_id,
                    &base_filters,
                    &selected_ids,
                    None,
                    need,
                )
                .map_err(|e| AppError::database(e.to_string()))?;
                selected_ids.extend(fill_ids);
            } else if selected_ids.len() > total as usize {
                // 配比超出总数时，随机裁剪以匹配配置
                use rand::seq::SliceRandom;
                let mut rng = rand::thread_rng();
                selected_ids.shuffle(&mut rng);
                selected_ids.truncate(total as usize);
            }
        }

        // 打乱顺序
        if config.shuffle {
            use rand::seq::SliceRandom;
            let mut rng = rand::thread_rng();
            selected_ids.shuffle(&mut rng);
        }

        if selected_ids.is_empty() {
            return Err(AppError::validation("无法根据配置选出足够的题目"));
        }

        let session = MockExamSession {
            id: uuid::Uuid::new_v4().to_string(),
            exam_id: exam_id.to_string(),
            config,
            question_ids: selected_ids.clone(),
            started_at: chrono::Utc::now().to_rfc3339(),
            ended_at: None,
            answers: std::collections::HashMap::new(),
            results: std::collections::HashMap::new(),
            is_submitted: false,
            score: None,
            correct_rate: None,
        };

        info!(
            "[QuestionBankService] Generated mock exam: id={}, exam_id={}, question_count={}",
            session.id,
            exam_id,
            selected_ids.len()
        );

        Ok(session)
    }

    /// 提交模拟考试并生成成绩单
    pub fn submit_mock_exam(
        &self,
        session: &MockExamSession,
    ) -> Result<MockExamScoreCard, AppError> {
        let total_count = session.question_ids.len() as u32;
        let answered_count = session.answers.len() as u32;
        let correct_count = session.results.values().filter(|&&v| v).count() as u32;
        // session 由前端传入，answers/results 可能不一致；用饱和减法避免 u32 下溢
        let wrong_count = answered_count.saturating_sub(correct_count);
        let unanswered_count = total_count.saturating_sub(answered_count);

        let correct_rate = if total_count > 0 {
            (correct_count as f64 / total_count as f64 * 100.0).round()
        } else {
            0.0
        };

        // 计算用时
        let started_at = chrono::DateTime::parse_from_rfc3339(&session.started_at)
            .map_err(|_| AppError::validation("Invalid started_at"))?;
        let ended_at = session
            .ended_at
            .as_ref()
            .map(|s| {
                chrono::DateTime::parse_from_rfc3339(s).unwrap_or_else(|e| {
                    warn!(
                    "[QuestionBankService] Failed to parse ended_at '{}': {}, using epoch fallback",
                    s, e
                );
                    chrono::DateTime::<chrono::Utc>::from(std::time::UNIX_EPOCH).fixed_offset()
                })
            })
            .unwrap_or_else(|| {
                warn!("[QuestionBankService] ended_at is None, using epoch fallback");
                chrono::DateTime::<chrono::Utc>::from(std::time::UNIX_EPOCH).fixed_offset()
            });
        let time_spent_seconds = (ended_at.timestamp() - started_at.timestamp()).max(0) as u32;

        // 获取题目详情计算各维度统计
        // M-031 同类优化：一次 IN 查询批量取回，替代逐题 get_question 的 N+1
        let questions = VfsQuestionRepo::get_questions_by_ids(&self.vfs_db, &session.question_ids)
            .map_err(|e| AppError::database(e.to_string()))?;
        let question_map: std::collections::HashMap<&str, &Question> =
            questions.iter().map(|q| (q.id.as_str(), q)).collect();

        let mut type_stats: std::collections::HashMap<String, TypeStatItem> =
            std::collections::HashMap::new();
        let mut difficulty_stats: std::collections::HashMap<String, DifficultyStatItem> =
            std::collections::HashMap::new();
        let mut wrong_question_ids: Vec<String> = Vec::new();

        for qid in &session.question_ids {
            if let Some(question) = question_map.get(qid.as_str()) {
                let qtype = format!("{:?}", question.question_type);
                let is_correct = session.results.get(qid).copied().unwrap_or(false);

                // 题型统计
                let entry = type_stats.entry(qtype.clone()).or_insert(TypeStatItem {
                    total: 0,
                    correct: 0,
                    rate: 0.0,
                });
                entry.total += 1;
                if is_correct {
                    entry.correct += 1;
                } else if session.answers.contains_key(qid) {
                    wrong_question_ids.push(qid.clone());
                }

                // 难度统计
                if let Some(diff) = &question.difficulty {
                    let diff_str = format!("{:?}", diff);
                    let entry = difficulty_stats
                        .entry(diff_str)
                        .or_insert(DifficultyStatItem {
                            total: 0,
                            correct: 0,
                            rate: 0.0,
                        });
                    entry.total += 1;
                    if is_correct {
                        entry.correct += 1;
                    }
                }
            }
        }

        // 计算各维度正确率
        for (_, stat) in type_stats.iter_mut() {
            stat.rate = if stat.total > 0 {
                (stat.correct as f64 / stat.total as f64 * 100.0).round()
            } else {
                0.0
            };
        }
        for (_, stat) in difficulty_stats.iter_mut() {
            stat.rate = if stat.total > 0 {
                (stat.correct as f64 / stat.total as f64 * 100.0).round()
            } else {
                0.0
            };
        }

        // 生成评语
        let comment = if correct_rate >= 90.0 {
            "优秀！继续保持！".to_string()
        } else if correct_rate >= 80.0 {
            "良好，再接再厉！".to_string()
        } else if correct_rate >= 60.0 {
            "及格，仍需努力。".to_string()
        } else {
            "需要加强练习，建议复习错题。".to_string()
        };

        let score_card = MockExamScoreCard {
            session_id: session.id.clone(),
            exam_id: session.exam_id.clone(),
            total_count,
            answered_count,
            correct_count,
            wrong_count,
            unanswered_count,
            correct_rate,
            time_spent_seconds,
            type_stats,
            difficulty_stats,
            wrong_question_ids,
            comment,
            completed_at: chrono::Utc::now().to_rfc3339(),
        };

        info!(
            "[QuestionBankService] Mock exam submitted: session_id={}, score={}%",
            session.id, correct_rate
        );

        Ok(score_card)
    }

    /// 获取每日一练题目
    ///
    /// 智能选题策略：
    /// 1. 优先选择错题（需复习）
    /// 2. 其次选择新题
    /// 3. 最后补充复习题（已掌握但长时间未练习）
    ///
    /// # Arguments
    /// * `exam_id` - 题目集 ID
    /// * `count` - 题目数量
    ///
    /// # Returns
    /// 每日一练结果
    pub fn get_daily_practice(
        &self,
        exam_id: &str,
        count: u32,
    ) -> Result<DailyPracticeResult, AppError> {
        if count == 0 {
            // 此前 count=0 时错题档 (count/2).max(1) 仍会选出 1 题，与目标数矛盾
            return Err(AppError::validation("每日一练题目数量必须大于 0"));
        }

        // "今天"用本地时区（与 todo/review_plan 模块一致）
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let target_count = count as usize;

        // 当日真实进度：此前 completed_count 硬编码 0，练完回到面板进度条
        // 恒为 0/target，完成庆祝永不出现。口径与打卡日历一致（按题去重，
        // answer_submissions 为主、存量无提交记录的题按 last_attempt_at 兜底）。
        let (answered_today_ids, correct_today) = self.query_daily_progress(exam_id, &today)?;
        let completed_today = answered_today_ids.len() as u32;

        // M-031: 使用 SQL 层随机抽取各类别题目，避免全量加载。
        // 今天已答过的题不再进入推荐（"继续练"应给剩余题，而非重复已答题）。
        let mut selected_ids: Vec<String> = Vec::new();
        let mut exclude_ids: Vec<String> = answered_today_ids.clone();

        // 1. 优先选择错题（status = review），最多占一半
        let mistake_filters = QuestionFilters {
            status: Some(vec![QuestionStatus::Review]),
            ..Default::default()
        };
        let mistake_ids = VfsQuestionRepo::random_question_ids(
            &self.vfs_db,
            exam_id,
            &mistake_filters,
            &exclude_ids,
            None,
            (count / 2).max(1),
        )
        .map_err(|e| AppError::database(e.to_string()))?;
        selected_ids.extend(mistake_ids.iter().cloned());
        exclude_ids.extend(mistake_ids);
        let mistake_count = selected_ids.len() as u32;

        // 2. 其次选择新题（status = new）
        if selected_ids.len() < target_count {
            let new_filters = QuestionFilters {
                status: Some(vec![QuestionStatus::New]),
                ..Default::default()
            };
            let remaining = (target_count - selected_ids.len()) as u32;
            let new_ids = VfsQuestionRepo::random_question_ids(
                &self.vfs_db,
                exam_id,
                &new_filters,
                &exclude_ids,
                None,
                remaining,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            selected_ids.extend(new_ids.iter().cloned());
            exclude_ids.extend(new_ids);
        }
        let new_count = (selected_ids.len() as u32).saturating_sub(mistake_count);

        // 3. 最后补充复习题（mastered 且 7 天未练习）
        if selected_ids.len() < target_count {
            let seven_days_ago = (chrono::Utc::now() - chrono::Duration::days(7)).to_rfc3339();
            let mastered_filters = QuestionFilters {
                status: Some(vec![QuestionStatus::Mastered]),
                ..Default::default()
            };
            let remaining = (target_count - selected_ids.len()) as u32;
            let review_ids = VfsQuestionRepo::random_question_ids(
                &self.vfs_db,
                exam_id,
                &mastered_filters,
                &exclude_ids,
                Some(&seven_days_ago),
                remaining,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            selected_ids.extend(review_ids.iter().cloned());
            exclude_ids.extend(review_ids);
        }
        let review_count = (selected_ids.len() as u32)
            .saturating_sub(mistake_count)
            .saturating_sub(new_count);

        // 4. 如果还不够，随机补充（不限状态，仍排除今天已答的题）
        if selected_ids.len() < target_count {
            let remaining = (target_count - selected_ids.len()) as u32;
            let fill_ids = VfsQuestionRepo::random_question_ids(
                &self.vfs_db,
                exam_id,
                &QuestionFilters::default(),
                &exclude_ids,
                None,
                remaining,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            selected_ids.extend(fill_ids.iter().cloned());
            exclude_ids.extend(fill_ids);
        }

        // 5. 题库里未答的题不足（今天几乎都练过）时，允许重练今天已答的题补齐，
        //    保证"再练一组"仍有题可练；仅排除本轮已选的题。
        if selected_ids.len() < target_count && !answered_today_ids.is_empty() {
            let remaining = (target_count - selected_ids.len()) as u32;
            let repeat_ids = VfsQuestionRepo::random_question_ids(
                &self.vfs_db,
                exam_id,
                &QuestionFilters::default(),
                &selected_ids,
                None,
                remaining,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            selected_ids.extend(repeat_ids);
        }

        if selected_ids.is_empty() {
            return Err(AppError::validation("题目集中没有题目"));
        }

        let result = DailyPracticeResult {
            date: today,
            exam_id: exam_id.to_string(),
            question_ids: selected_ids.clone(),
            daily_target: count,
            completed_count: completed_today,
            correct_count: correct_today,
            source_distribution: DailySourceDistribution {
                mistake_count,
                new_count,
                review_count,
            },
            is_completed: completed_today >= count,
        };

        info!(
            "[QuestionBankService] Generated daily practice: exam_id={}, count={}, mistakes={}, new={}, review={}",
            exam_id, selected_ids.len(), mistake_count, new_count, review_count
        );

        Ok(result)
    }

    /// 查询某题目集在指定日期的做题进度（按题去重）。
    ///
    /// 口径与 get_check_in_calendar / get_activity_heatmap 一致：
    /// answer_submissions 为主，存量无提交记录的题按 last_attempt_at 兜底，
    /// DATE(…, 'localtime') 对齐本地日界线；正确数按"当日该题任一次答对"计。
    fn query_daily_progress(
        &self,
        exam_id: &str,
        date: &str,
    ) -> Result<(Vec<String>, u32), AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        let sql = r#"
            SELECT question_id, MAX(correct) as correct FROM (
                SELECT
                    s.question_id as question_id,
                    CASE WHEN s.is_correct = 1 THEN 1 ELSE 0 END as correct
                FROM answer_submissions s
                INNER JOIN questions q ON q.id = s.question_id
                WHERE q.exam_id = ?1 AND q.deleted_at IS NULL
                    AND DATE(s.submitted_at, 'localtime') = ?2
                UNION ALL
                SELECT
                    q.id as question_id,
                    CASE WHEN q.is_correct = 1 THEN 1 ELSE 0 END as correct
                FROM questions q
                WHERE q.exam_id = ?1 AND q.deleted_at IS NULL
                    AND q.last_attempt_at IS NOT NULL
                    AND DATE(q.last_attempt_at, 'localtime') = ?2
                    AND NOT EXISTS (SELECT 1 FROM answer_submissions s2 WHERE s2.question_id = q.id)
            )
            GROUP BY question_id
        "#;

        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut rows = stmt
            .query(rusqlite::params![exam_id, date])
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut answered_ids: Vec<String> = Vec::new();
        let mut correct_count = 0u32;
        while let Some(row) = rows.next().map_err(|e| AppError::database(e.to_string()))? {
            let question_id: String = row.get(0).unwrap_or_default();
            let correct: i64 = row.get(1).unwrap_or(0);
            if question_id.is_empty() {
                continue;
            }
            if correct == 1 {
                correct_count += 1;
            }
            answered_ids.push(question_id);
        }
        Ok((answered_ids, correct_count))
    }

    /// 提交/改判后重算"今天"的权威进度快照（挂在 SubmitAnswerResult.daily_progress）。
    ///
    /// 必须在事务提交之后调用（query_daily_progress 会另取连接）。
    /// 计算失败只降级为 None，不阻塞答题主流程。
    fn build_daily_progress_snapshot(&self, exam_id: &str) -> Option<DailyProgressSnapshot> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        match self.query_daily_progress(exam_id, &today) {
            Ok((answered_ids, correct_count)) => Some(DailyProgressSnapshot {
                date: today,
                exam_id: exam_id.to_string(),
                completed_count: answered_ids.len() as u32,
                correct_count,
                answered_question_ids: answered_ids,
            }),
            Err(e) => {
                warn!(
                    "[QuestionBankService] daily progress snapshot failed for exam_id={}: {}",
                    exam_id, e
                );
                None
            }
        }
    }

    /// 生成试卷
    ///
    /// # Arguments
    /// * `exam_id` - 题目集 ID
    /// * `config` - 组卷配置
    ///
    /// # Returns
    /// 生成的试卷
    pub fn generate_paper(
        &self,
        exam_id: &str,
        config: PaperConfig,
    ) -> Result<GeneratedPaper, AppError> {
        // 构建筛选条件
        let mut filters = QuestionFilters::default();
        if let Some(ref diff_filter) = config.difficulty_filter {
            filters.difficulty = Some(
                diff_filter
                    .iter()
                    .map(|d| Difficulty::from_str(d))
                    .collect(),
            );
        }
        if let Some(ref tags_filter) = config.tags_filter {
            filters.tags = Some(tags_filter.clone());
        }

        let mut selected_questions: Vec<Question> = Vec::new();

        // M-031: 使用 SQL 层随机抽取，避免全量加载
        if !config.type_selection.is_empty() {
            for (qtype, count) in &config.type_selection {
                let type_filters = QuestionFilters {
                    question_type: Some(vec![QuestionType::from_str(&qtype.to_lowercase())]),
                    difficulty: filters.difficulty.clone(),
                    tags: filters.tags.clone(),
                    ..Default::default()
                };
                let exclude_ids: Vec<String> =
                    selected_questions.iter().map(|q| q.id.clone()).collect();
                let qs = VfsQuestionRepo::random_questions(
                    &self.vfs_db,
                    exam_id,
                    &type_filters,
                    &exclude_ids,
                    *count,
                )
                .map_err(|e| AppError::database(e.to_string()))?;
                selected_questions.extend(qs);
            }
        } else {
            // M-031: 未指定题型配比时，使用 SQL 层随机抽取代替全量加载
            // 上限 500 题，避免大题库内存爆炸
            const MAX_PAPER_QUESTIONS: u32 = 500;
            selected_questions = VfsQuestionRepo::random_questions(
                &self.vfs_db,
                exam_id,
                &filters,
                &[],
                MAX_PAPER_QUESTIONS,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
        }

        if selected_questions.is_empty() {
            return Err(AppError::validation("无法根据配置选出题目"));
        }

        // 打乱顺序
        if config.shuffle {
            use rand::seq::SliceRandom;
            let mut rng = rand::thread_rng();
            selected_questions.shuffle(&mut rng);
        }

        // 处理答案和解析的显示
        if !config.include_answers {
            for q in selected_questions.iter_mut() {
                q.answer = None;
            }
        }
        if !config.include_explanations {
            for q in selected_questions.iter_mut() {
                q.explanation = None;
            }
        }

        let paper = GeneratedPaper {
            id: uuid::Uuid::new_v4().to_string(),
            title: config.title.clone(),
            exam_id: exam_id.to_string(),
            total_score: selected_questions.len() as u32,
            questions: selected_questions.clone(),
            config,
            created_at: chrono::Utc::now().to_rfc3339(),
            export_path: None,
        };

        info!(
            "[QuestionBankService] Generated paper: id={}, title={}, question_count={}",
            paper.id,
            paper.title,
            selected_questions.len()
        );

        Ok(paper)
    }

    /// 获取打卡日历数据
    ///
    /// # Arguments
    /// * `exam_id` - 题目集 ID（可选，为空表示全局）
    /// * `year` - 年份
    /// * `month` - 月份
    /// * `daily_target` - 达标判定用的每日目标题数（可选；缺省 10）。
    ///   此前阈值硬编码 10：目标设 5 做满 5 题不达标、设 20 做 10 题反而达标。
    pub fn get_check_in_calendar(
        &self,
        exam_id: Option<&str>,
        year: i32,
        month: u32,
        daily_target: Option<u32>,
    ) -> Result<CheckInCalendar, AppError> {
        if !(1..=12).contains(&month) {
            return Err(AppError::validation("月份必须在 1-12 之间"));
        }
        if !(1970..=9999).contains(&year) {
            return Err(AppError::validation("年份无效"));
        }
        let target = daily_target.unwrap_or(10).max(1);

        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        let start_date = format!("{:04}-{:02}-01", year, month);
        let end_date = if month == 12 {
            format!("{:04}-01-01", year + 1)
        } else {
            format!("{:04}-{:02}-01", year, month + 1)
        };

        // 构建查询条件
        let base_condition = if exam_id.is_some() {
            "q.exam_id = ?1 AND q.deleted_at IS NULL"
        } else {
            "q.deleted_at IS NULL"
        };

        // 查询每日做题统计：口径与 get_activity_heatmap 一致（以 answer_submissions 为准，
        // 存量无提交记录的题按 last_attempt_at 兜底；'localtime' 对齐本地日界线与连续打卡判定）
        let sql = format!(
            r#"
            SELECT date, COUNT(*) as question_count, SUM(correct) as correct_count FROM (
                SELECT
                    DATE(s.submitted_at, 'localtime') as date,
                    s.question_id,
                    MAX(CASE WHEN s.is_correct = 1 THEN 1 ELSE 0 END) as correct
                FROM answer_submissions s
                INNER JOIN questions q ON q.id = s.question_id
                WHERE {cond}
                GROUP BY DATE(s.submitted_at, 'localtime'), s.question_id
                UNION ALL
                SELECT
                    DATE(q.last_attempt_at, 'localtime') as date,
                    q.id,
                    CASE WHEN q.is_correct = 1 THEN 1 ELSE 0 END as correct
                FROM questions q
                WHERE {cond}
                    AND q.last_attempt_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM answer_submissions s2 WHERE s2.question_id = q.id)
            )
            WHERE date >= ? AND date < ?
            GROUP BY date
            ORDER BY date ASC
            "#,
            cond = base_condition
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut rows = if let Some(eid) = exam_id {
            stmt.query(rusqlite::params![eid, start_date, end_date])
        } else {
            stmt.query(rusqlite::params![start_date, end_date])
        }
        .map_err(|e| AppError::database(e.to_string()))?;

        let mut days: Vec<DailyCheckIn> = Vec::new();
        let mut month_total_questions = 0u32;

        while let Some(row) = rows.next().map_err(|e| AppError::database(e.to_string()))? {
            let date: String = row.get(0).unwrap_or_default();
            let question_count: i64 = row.get(1).unwrap_or(0);
            let correct_count: i64 = row.get(2).unwrap_or(0);

            month_total_questions += question_count as u32;

            days.push(DailyCheckIn {
                date,
                exam_id: exam_id.map(|s| s.to_string()),
                question_count: question_count as u32,
                correct_count: correct_count as u32,
                study_duration_seconds: 0, // 暂不支持时长统计
                target_achieved: question_count as u32 >= target,
            });
        }

        // 计算连续打卡天数：基于完整历史而非本月数据。
        // 此前只用当月的 days 计算，跨月连续打卡（如 7/25–8/3）在月初会被截断为
        // 月内天数；查看历史月份时更是恒为 0。
        let streak_days = self.query_streak_days(&conn, exam_id)?;

        Ok(CheckInCalendar {
            exam_id: exam_id.map(str::to_owned),
            year,
            month,
            days: days.clone(),
            streak_days,
            month_check_in_days: days.len() as u32,
            month_total_questions,
        })
    }

    /// 查询连续打卡天数（不限当月，向历史回溯）
    ///
    /// 口径与 get_check_in_calendar 一致：answer_submissions 为主，存量无提交
    /// 记录的题按 last_attempt_at 兜底，DATE(…, 'localtime') 对齐本地日界线。
    fn query_streak_days(
        &self,
        conn: &rusqlite::Connection,
        exam_id: Option<&str>,
    ) -> Result<u32, AppError> {
        let base_condition = if exam_id.is_some() {
            "q.exam_id = ?1 AND q.deleted_at IS NULL"
        } else {
            "q.deleted_at IS NULL"
        };

        // 连续打卡最多回溯 10 年，足够覆盖任何真实 streak
        let sql = format!(
            r#"
            SELECT DISTINCT date FROM (
                SELECT DATE(s.submitted_at, 'localtime') as date
                FROM answer_submissions s
                INNER JOIN questions q ON q.id = s.question_id
                WHERE {cond}
                UNION
                SELECT DATE(q.last_attempt_at, 'localtime') as date
                FROM questions q
                WHERE {cond}
                    AND q.last_attempt_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM answer_submissions s2 WHERE s2.question_id = q.id)
            )
            WHERE date IS NOT NULL AND date <= ?
            ORDER BY date DESC
            LIMIT 3700
            "#,
            cond = base_condition
        );

        let today = chrono::Local::now().date_naive();
        let today_str = today.format("%Y-%m-%d").to_string();

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut rows = if let Some(eid) = exam_id {
            stmt.query(rusqlite::params![eid, today_str])
        } else {
            stmt.query(rusqlite::params![today_str])
        }
        .map_err(|e| AppError::database(e.to_string()))?;

        let mut dates_desc: Vec<chrono::NaiveDate> = Vec::new();
        while let Some(row) = rows.next().map_err(|e| AppError::database(e.to_string()))? {
            let date_str: String = row.get(0).unwrap_or_default();
            if let Ok(d) = chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") {
                dates_desc.push(d);
            }
        }

        Ok(Self::compute_streak_days(&dates_desc, today))
    }

    /// 从降序去重的活跃日期序列计算连续打卡天数
    ///
    /// 规则：从今天（或今天未打卡时的昨天）开始，向前逐日连续计数。
    fn compute_streak_days(dates_desc: &[chrono::NaiveDate], today: chrono::NaiveDate) -> u32 {
        use chrono::Duration;

        let Some(&latest) = dates_desc.first() else {
            return 0;
        };

        let yesterday = today - Duration::days(1);
        if latest != today && latest != yesterday {
            return 0; // 连续打卡已中断
        }

        let mut streak = 1u32;
        let mut prev = latest;
        for &d in &dates_desc[1..] {
            if d >= prev {
                // 防御：重复或乱序数据跳过，不计入
                continue;
            }
            if prev - d == Duration::days(1) {
                streak += 1;
                prev = d;
            } else {
                break;
            }
        }

        streak
    }
}

// ============================================================================
// 时间维度统计数据结构
// ============================================================================

/// 学习趋势数据点
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningTrendPoint {
    /// 日期（YYYY-MM-DD）
    pub date: String,
    /// 做题数
    pub attempt_count: i32,
    /// 正确数
    pub correct_count: i32,
    /// 正确率（0-100）
    pub correct_rate: f64,
}

/// 活跃度热力图数据点
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityHeatmapPoint {
    /// 日期（YYYY-MM-DD）
    pub date: String,
    /// 做题数
    pub count: i32,
    /// 正确数
    pub correct_count: i32,
    /// 活跃等级（0-4）
    pub level: i32,
}

/// 知识点统计
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgePoint {
    /// 标签名
    pub tag: String,
    /// 总题数
    pub total: i32,
    /// 已掌握数
    pub mastered: i32,
    /// 学习中数
    pub in_progress: i32,
    /// 需复习数
    pub review: i32,
    /// 未学习数
    pub new_count: i32,
    /// 掌握度百分比（0-100）
    pub mastery_rate: f64,
    /// 正确率百分比（0-100）
    pub correct_rate: f64,
}

/// 知识点统计对比
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeStatsComparison {
    /// 当前统计
    pub current: Vec<KnowledgePoint>,
    /// 上周统计（用于对比）
    pub previous: Vec<KnowledgePoint>,
}

// ============================================================================
// 练习模式扩展数据结构（2026-01 新增）
// ============================================================================

/// 练习模式类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum PracticeMode {
    /// 顺序练习
    #[default]
    Sequential,
    /// 随机练习
    Random,
    /// 错题优先
    ReviewFirst,
    /// 按标签练习
    ByTag,
    /// 限时练习
    Timed,
    /// 模拟考试
    MockExam,
    /// 每日一练
    Daily,
    /// 组卷模式
    Paper,
}

/// 限时练习会话
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimedPracticeSession {
    /// 会话 ID
    pub id: String,
    /// 题目集 ID
    pub exam_id: String,
    /// 限时（分钟）
    pub duration_minutes: u32,
    /// 题目数量
    pub question_count: u32,
    /// 题目 ID 列表
    pub question_ids: Vec<String>,
    /// 开始时间（ISO 8601）
    pub started_at: String,
    /// 结束时间（ISO 8601，可为空表示未结束）
    pub ended_at: Option<String>,
    /// 已答题数
    pub answered_count: u32,
    /// 正确数
    pub correct_count: u32,
    /// 是否已超时
    pub is_timeout: bool,
    /// 是否已提交
    pub is_submitted: bool,
    /// 暂停时间（累计秒数）
    pub paused_seconds: u32,
    /// 是否暂停中
    pub is_paused: bool,
}

/// 模拟考试配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockExamConfig {
    /// 考试时长（分钟）
    pub duration_minutes: u32,
    /// 题型配比：题型 -> 数量
    pub type_distribution: std::collections::HashMap<String, u32>,
    /// 难度分布：难度 -> 数量
    pub difficulty_distribution: std::collections::HashMap<String, u32>,
    /// 总题数（如果未指定具体配比，使用此值随机选题）
    pub total_count: Option<u32>,
    /// 是否打乱顺序
    pub shuffle: bool,
    /// 是否包含错题
    pub include_mistakes: bool,
    /// 标签筛选（可选）
    pub tags: Option<Vec<String>>,
}

impl Default for MockExamConfig {
    fn default() -> Self {
        Self {
            duration_minutes: 60,
            type_distribution: std::collections::HashMap::new(),
            difficulty_distribution: std::collections::HashMap::new(),
            total_count: Some(30),
            shuffle: true,
            include_mistakes: true,
            tags: None,
        }
    }
}

/// 模拟考试会话
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockExamSession {
    /// 会话 ID
    pub id: String,
    /// 题目集 ID
    pub exam_id: String,
    /// 考试配置
    pub config: MockExamConfig,
    /// 题目 ID 列表
    pub question_ids: Vec<String>,
    /// 开始时间
    pub started_at: String,
    /// 结束时间
    pub ended_at: Option<String>,
    /// 已答题目及答案：question_id -> user_answer
    pub answers: std::collections::HashMap<String, String>,
    /// 每题正确性：question_id -> is_correct
    pub results: std::collections::HashMap<String, bool>,
    /// 是否已交卷
    pub is_submitted: bool,
    /// 得分（交卷后计算）
    pub score: Option<f64>,
    /// 正确率
    pub correct_rate: Option<f64>,
}

/// 模拟考试成绩单
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockExamScoreCard {
    /// 会话 ID
    pub session_id: String,
    /// 题目集 ID
    pub exam_id: String,
    /// 总题数
    pub total_count: u32,
    /// 已答题数
    pub answered_count: u32,
    /// 正确数
    pub correct_count: u32,
    /// 错误数
    pub wrong_count: u32,
    /// 未答数
    pub unanswered_count: u32,
    /// 正确率（0-100）
    pub correct_rate: f64,
    /// 用时（秒）
    pub time_spent_seconds: u32,
    /// 各题型统计
    pub type_stats: std::collections::HashMap<String, TypeStatItem>,
    /// 各难度统计
    pub difficulty_stats: std::collections::HashMap<String, DifficultyStatItem>,
    /// 错题列表
    pub wrong_question_ids: Vec<String>,
    /// 评语
    pub comment: String,
    /// 完成时间
    pub completed_at: String,
}

/// 题型统计项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeStatItem {
    pub total: u32,
    pub correct: u32,
    pub rate: f64,
}

/// 难度统计项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DifficultyStatItem {
    pub total: u32,
    pub correct: u32,
    pub rate: f64,
}

/// 每日一练结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyPracticeResult {
    /// 日期（YYYY-MM-DD）
    pub date: String,
    /// 题目集 ID
    pub exam_id: String,
    /// 推荐题目 ID 列表
    pub question_ids: Vec<String>,
    /// 每日目标题数
    pub daily_target: u32,
    /// 已完成题数
    pub completed_count: u32,
    /// 正确数
    pub correct_count: u32,
    /// 题目来源分布
    pub source_distribution: DailySourceDistribution,
    /// 是否已完成今日目标
    pub is_completed: bool,
}

/// 每日一练题目来源分布
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailySourceDistribution {
    /// 错题数量
    pub mistake_count: u32,
    /// 新题数量
    pub new_count: u32,
    /// 复习题数量
    pub review_count: u32,
}

/// 组卷配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperConfig {
    /// 试卷标题
    pub title: String,
    /// 题型选择：题型 -> 数量
    pub type_selection: std::collections::HashMap<String, u32>,
    /// 难度筛选
    pub difficulty_filter: Option<Vec<String>>,
    /// 标签筛选
    pub tags_filter: Option<Vec<String>>,
    /// 是否打乱顺序
    pub shuffle: bool,
    /// 是否包含答案
    pub include_answers: bool,
    /// 是否包含解析
    pub include_explanations: bool,
    /// 导出格式
    pub export_format: PaperExportFormat,
}

impl Default for PaperConfig {
    fn default() -> Self {
        Self {
            title: "练习试卷".to_string(),
            type_selection: std::collections::HashMap::new(),
            difficulty_filter: None,
            tags_filter: None,
            shuffle: true,
            include_answers: true,
            include_explanations: true,
            export_format: PaperExportFormat::Preview,
        }
    }
}

/// 试卷导出格式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum PaperExportFormat {
    /// 预览（不导出文件）
    #[default]
    Preview,
    /// PDF 格式
    Pdf,
    /// Word 格式
    Word,
    /// Markdown 格式
    Markdown,
}

/// 生成的试卷
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedPaper {
    /// 试卷 ID
    pub id: String,
    /// 试卷标题
    pub title: String,
    /// 题目集 ID
    pub exam_id: String,
    /// 题目列表（包含完整题目信息）
    pub questions: Vec<Question>,
    /// 总分（每题 1 分）
    pub total_score: u32,
    /// 配置
    pub config: PaperConfig,
    /// 创建时间
    pub created_at: String,
    /// 导出文件路径（如果已导出）
    pub export_path: Option<String>,
}

/// 打卡记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyCheckIn {
    /// 日期（YYYY-MM-DD）
    pub date: String,
    /// 题目集 ID（可选，为空表示全局打卡）
    pub exam_id: Option<String>,
    /// 做题数
    pub question_count: u32,
    /// 正确数
    pub correct_count: u32,
    /// 学习时长（秒）
    pub study_duration_seconds: u32,
    /// 是否达成目标
    pub target_achieved: bool,
}

/// 打卡日历数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckInCalendar {
    /// 此日历所属的题目集；为空时表示跨题目集汇总。
    pub exam_id: Option<String>,
    /// 年份
    pub year: i32,
    /// 月份
    pub month: u32,
    /// 每日打卡记录
    pub days: Vec<DailyCheckIn>,
    /// 连续打卡天数
    pub streak_days: u32,
    /// 本月打卡天数
    pub month_check_in_days: u32,
    /// 本月总做题数
    pub month_total_questions: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mastery::service::{
        set_now_override_ms, MasteryService, MIN_TOTAL_FOR_WEAK, WEAK_SCORE_THRESHOLD,
    };
    use crate::memory::learner_profile::{load_profile_from_db, WEAK_POINT_SOURCE_MASTERY};
    use chrono::Utc;
    use rusqlite::params;

    fn check(user: &str, correct: Option<&str>, qtype: QuestionType) -> (bool, bool) {
        QuestionBankService::check_answer_correctness(user, correct, &qtype, None)
    }

    fn check_structured(
        user: &str,
        correct: Option<&str>,
        qtype: QuestionType,
        structured: serde_json::Value,
    ) -> (bool, bool) {
        QuestionBankService::check_answer_correctness(user, correct, &qtype, Some(&structured))
    }

    fn setup_qbank() -> (tempfile::TempDir, Arc<VfsDatabase>, QuestionBankService) {
        let (temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let vfs_db = Arc::new(db);
        let svc = QuestionBankService::new(vfs_db.clone());
        (temp_dir, vfs_db, svc)
    }

    fn seed_tagged_question(vfs_db: &VfsDatabase, tag: &str, label: &str) -> String {
        let exam_id = format!("exam_{}", nanoid::nanoid!(6));
        let conn = vfs_db.get_conn_safe().expect("conn");
        conn.execute(
            "INSERT INTO exam_sheets (
                id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
             ) VALUES (?1, 'qbank mastery e2e', 'completed', ?2, '{}', '{}', ?3, ?3)",
            params![exam_id, format!("temp_{exam_id}"), "2020-01-01T00:00:00Z"],
        )
        .expect("exam");
        drop(conn);
        VfsQuestionRepo::create_question(
            vfs_db,
            &CreateQuestionParams {
                exam_id,
                card_id: None,
                question_label: Some(label.into()),
                content: format!("{label}?"),
                options: None,
                answer: Some("2".into()),
                explanation: None,
                structured_data: None,
                question_type: Some(QuestionType::FillBlank),
                difficulty: None,
                tags: Some(vec![tag.to_string()]),
                source_type: None,
                source_ref: None,
                images: None,
                parent_id: None,
            },
        )
        .expect("create question")
        .id
    }

    /// C5：submit_answer 连错 3 次 → mastery_events/states + learner_profile.weak_points
    #[test]
    fn submit_answer_wrong_thrice_writes_mastery_and_weak_point() {
        let (_tmp, vfs_db, qbank) = setup_qbank();
        let concept = "qbank_闭环概念";
        let qid = seed_tagged_question(&vfs_db, concept, "Q1");
        let mut t0 = Utc::now().timestamp_millis();
        set_now_override_ms(Some(t0));
        for i in 0..3 {
            t0 += 120_000;
            set_now_override_ms(Some(t0));
            let r = qbank
                .submit_answer(&qid, "x", Some(false), Some(&format!("qw{i}")))
                .expect("submit");
            assert_eq!(r.is_correct, Some(false));
        }
        set_now_override_ms(None);

        let conn = vfs_db.get_conn_safe().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mastery_events
                 WHERE concept_key = ?1 AND source = 'qbank' AND outcome = 'wrong'",
                params![concept],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(n, 3);
        let (score, total): (f64, i32) = conn
            .query_row(
                "SELECT score, total FROM mastery_states WHERE concept_key = ?1",
                params![concept],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(score < WEAK_SCORE_THRESHOLD);
        assert!(total >= MIN_TOTAL_FOR_WEAK);

        let profile = load_profile_from_db(&vfs_db).unwrap().expect("profile");
        assert!(profile.weak_points.iter().any(|w| {
            w.knowledge_point == concept && w.source.as_deref() == Some(WEAK_POINT_SOURCE_MASTERY)
        }));
    }

    /// C5-3：同题 1 分钟内连对 5 次，增幅显著小于 5 道独立题
    #[test]
    fn submit_answer_anti_farm_same_question_gains_less() {
        let (_tmp, vfs_db, qbank) = setup_qbank();
        let mastery = MasteryService::new(vfs_db.clone());
        let concept_ind = "qb_ind";
        let concept_farm = "qb_farm";
        let mut ind = Vec::new();
        for i in 0..5 {
            ind.push(seed_tagged_question(&vfs_db, concept_ind, &format!("I{i}")));
        }
        let farm = seed_tagged_question(&vfs_db, concept_farm, "F");
        let t0 = Utc::now().timestamp_millis();
        set_now_override_ms(Some(t0));
        for (i, qid) in ind.iter().enumerate() {
            set_now_override_ms(Some(t0 + i as i64 * 1_000));
            qbank
                .submit_answer(qid, "2", Some(true), Some(&format!("qi{i}")))
                .unwrap();
        }
        let gain_ind = mastery.get_state(concept_ind).unwrap().unwrap().score - 0.5;
        for i in 0..5 {
            set_now_override_ms(Some(t0 + 1_000_000 + i * 5_000));
            qbank
                .submit_answer(&farm, "2", Some(true), Some(&format!("qf{i}")))
                .unwrap();
        }
        set_now_override_ms(None);
        let gain_farm = mastery.get_state(concept_farm).unwrap().unwrap().score - 0.5;
        assert!(
            gain_farm < gain_ind * 0.55,
            "farm {gain_farm:.4} << ind {gain_ind:.4}"
        );
        let min_w: f64 = vfs_db
            .get_conn_safe()
            .unwrap()
            .query_row(
                "SELECT MIN(weight) FROM mastery_events WHERE concept_key = ?1",
                params![concept_farm],
                |row| row.get(0),
            )
            .unwrap();
        assert!(min_w < 0.3, "decayed weight expected, got {min_w}");
    }

    #[test]
    fn test_single_choice_basic_and_case_insensitive() {
        assert_eq!(
            check("A", Some("A"), QuestionType::SingleChoice),
            (true, false)
        );
        assert_eq!(
            check("a", Some("A."), QuestionType::SingleChoice),
            (true, false)
        );
        assert_eq!(
            check("B", Some("A"), QuestionType::SingleChoice),
            (false, false)
        );
    }

    #[test]
    fn test_single_choice_answer_with_option_text() {
        // 导入答案携带选项全文时，提取键比较
        assert_eq!(
            check(
                "A",
                Some("A. 三角形内角和为180°"),
                QuestionType::SingleChoice
            ),
            (true, false)
        );
        assert_eq!(
            check(
                "B",
                Some("A. 三角形内角和为180°"),
                QuestionType::SingleChoice
            ),
            (false, false)
        );
        assert_eq!(
            check("A", Some("正确答案：A"), QuestionType::SingleChoice),
            (true, false)
        );
    }

    #[test]
    fn test_multiple_choice_order_and_missing() {
        // 乱序等价
        assert_eq!(
            check("BA", Some("AB"), QuestionType::MultipleChoice),
            (true, false)
        );
        assert_eq!(
            check("A,B", Some("B、A"), QuestionType::MultipleChoice),
            (true, false)
        );
        // 漏选判错
        assert_eq!(
            check("A", Some("AB"), QuestionType::MultipleChoice),
            (false, false)
        );
        // 多选判错
        assert_eq!(
            check("ABC", Some("AB"), QuestionType::MultipleChoice),
            (false, false)
        );
    }

    #[test]
    fn test_multiple_choice_answer_with_option_text() {
        assert_eq!(
            check("AC", Some("A. 苹果 C. 橙子"), QuestionType::MultipleChoice),
            (true, false)
        );
        assert_eq!(
            check("A", Some("A. 苹果 C. 橙子"), QuestionType::MultipleChoice),
            (false, false)
        );
    }

    #[test]
    fn test_fill_blank_whitespace_and_case() {
        assert_eq!(
            check(" Newton ", Some("newton"), QuestionType::FillBlank),
            (true, false)
        );
        assert_eq!(
            check("能量 守恒", Some("能量守恒"), QuestionType::FillBlank),
            (true, false)
        );
        assert_eq!(
            check("动量守恒", Some("能量守恒"), QuestionType::FillBlank),
            (false, false)
        );
    }

    #[test]
    fn test_subjective_needs_manual_grading() {
        assert_eq!(
            check("我的论述……", Some("参考答案"), QuestionType::ShortAnswer),
            (false, true)
        );
        assert_eq!(
            check("证明过程", Some("参考证明"), QuestionType::Proof),
            (false, true)
        );
    }

    #[test]
    fn test_missing_answer_needs_manual_grading() {
        assert_eq!(check("A", None, QuestionType::SingleChoice), (false, true));
        assert_eq!(
            check("A", Some("  "), QuestionType::SingleChoice),
            (false, true)
        );
    }

    #[test]
    fn test_extract_choice_keys_conservative() {
        use std::collections::BTreeSet;
        let keys = |s: &str| QuestionBankService::extract_choice_keys(s);
        let set = |cs: &[char]| cs.iter().copied().collect::<BTreeSet<char>>();

        // 纯键串
        assert_eq!(keys("A"), Some(set(&['A'])));
        assert_eq!(keys("abd"), Some(set(&['A', 'B', 'D'])));
        assert_eq!(keys("A、C"), Some(set(&['A', 'C'])));
        // 结构化
        assert_eq!(keys("A. 内容 C. 内容"), Some(set(&['A', 'C'])));
        assert_eq!(keys("（B）"), Some(set(&['B'])));
        assert_eq!(keys("选A。"), Some(set(&['A'])));
        // 内容文本不应误判出键
        assert_eq!(keys("答案是第一个"), None);
        assert_eq!(keys(""), None);
        // 嵌在词中的字母不是键
        assert_eq!(keys("the answer"), None);
        // 全角选项键与结构符
        assert_eq!(keys("Ａ"), Some(set(&['A'])));
        assert_eq!(keys("（Ｂ）"), Some(set(&['B'])));
    }

    #[test]
    fn test_fullwidth_normalization_in_judging() {
        // 全角选项字母
        assert_eq!(
            check("Ａ", Some("A"), QuestionType::SingleChoice),
            (true, false)
        );
        // 多选：全角 + 乱序
        assert_eq!(
            check("ＢＡ", Some("AB"), QuestionType::MultipleChoice),
            (true, false)
        );
        // 填空：全角数字/字母等价于半角
        assert_eq!(
            check("１２３", Some("123"), QuestionType::FillBlank),
            (true, false)
        );
        assert_eq!(
            check("ｎｅｗｔｏｎ", Some("Newton"), QuestionType::FillBlank),
            (true, false)
        );
        // 全角空格视为空白被忽略
        assert_eq!(
            check(
                "能量\u{3000}守恒",
                Some("能量守恒"),
                QuestionType::FillBlank
            ),
            (true, false)
        );
        // 全角归一化不应引入误判
        assert_eq!(
            check("Ｂ", Some("A"), QuestionType::SingleChoice),
            (false, false)
        );
    }

    #[test]
    fn test_true_false_lenient_parsing() {
        assert_eq!(
            check("true", Some("true"), QuestionType::TrueFalse),
            (true, false)
        );
        assert_eq!(
            check("对", Some("true"), QuestionType::TrueFalse),
            (true, false)
        );
        assert_eq!(
            check("√", Some("true"), QuestionType::TrueFalse),
            (true, false)
        );
        assert_eq!(
            check("错误", Some("false"), QuestionType::TrueFalse),
            (true, false)
        );
        assert_eq!(
            check("×", Some("true"), QuestionType::TrueFalse),
            (false, false)
        );
        // 用户输入无法解析为布尔 → 判错
        assert_eq!(
            check("也许吧", Some("true"), QuestionType::TrueFalse),
            (false, false)
        );
        // 参考答案不是布尔 → 手动批改
        assert_eq!(
            check("true", Some("视情况而定"), QuestionType::TrueFalse),
            (false, true)
        );
        assert_eq!(check("true", None, QuestionType::TrueFalse), (false, true));
    }

    #[test]
    // answer_value 是面向用户的题目答案数值（与 π 无关），3.14 配合容差断言
    // 语义最直观；允许 approx_constant 避免 clippy 误判。
    #[allow(clippy::approx_constant)]
    fn test_numeric_tolerance_and_lenient_input() {
        let sd = |t: f64, mode: &str| {
            serde_json::json!({
                "answer_value": 3.14,
                "tolerance": t,
                "unit": "m",
                "tolerance_mode": mode
            })
        };
        // 绝对容差
        assert_eq!(
            check_structured("3.15", None, QuestionType::Numeric, sd(0.01, "absolute")),
            (true, false)
        );
        assert_eq!(
            check_structured("3.16", None, QuestionType::Numeric, sd(0.01, "absolute")),
            (false, false)
        );
        // 相对容差：3.14 * 0.01 ≈ 0.0314
        assert_eq!(
            check_structured("3.17", None, QuestionType::Numeric, sd(0.01, "relative")),
            (true, false)
        );
        // 宽松输入："3.14 m"、全角、千分位
        assert_eq!(
            check_structured("3.14 m", None, QuestionType::Numeric, sd(0.0, "absolute")),
            (true, false)
        );
        assert_eq!(
            check_structured("３.１４", None, QuestionType::Numeric, sd(0.0, "absolute")),
            (true, false)
        );
        let big = serde_json::json!({"answer_value": 1234.5, "tolerance": 0.0});
        assert_eq!(
            check_structured("1,234.5", None, QuestionType::Numeric, big),
            (true, false)
        );
        // 分数输入
        let half = serde_json::json!({"answer_value": 0.5, "tolerance": 0.0});
        assert_eq!(
            check_structured("1/2", None, QuestionType::Numeric, half),
            (true, false)
        );
        // 无 structured_data 时回退 answer 字符串
        assert_eq!(
            check("3.14", Some("3.14"), QuestionType::Numeric),
            (true, false)
        );
        assert_eq!(
            check("3.14", Some("约等于圆周率"), QuestionType::Numeric),
            (false, true)
        );
        assert_eq!(
            check("abc", Some("3.14"), QuestionType::Numeric),
            (false, false)
        );
    }

    #[test]
    fn test_ordering_strict_order() {
        let sd = serde_json::json!({
            "items": [
                {"key": "A", "content": "一"},
                {"key": "B", "content": "二"},
                {"key": "C", "content": "三"}
            ],
            "correct_order": ["B", "A", "C"]
        });
        assert_eq!(
            check_structured(r#"["B","A","C"]"#, None, QuestionType::Ordering, sd.clone()),
            (true, false)
        );
        // 顺序错误
        assert_eq!(
            check_structured(r#"["A","B","C"]"#, None, QuestionType::Ordering, sd.clone()),
            (false, false)
        );
        // 数量不符
        assert_eq!(
            check_structured(r#"["B","A"]"#, None, QuestionType::Ordering, sd.clone()),
            (false, false)
        );
        // 分隔符输入兜底 + 大小写归一化
        assert_eq!(
            check_structured("b、a、c", None, QuestionType::Ordering, sd),
            (true, false)
        );
        // 无标准顺序 → 手动批改
        assert_eq!(
            check(r#"["B","A"]"#, None, QuestionType::Ordering),
            (false, true)
        );
    }

    #[test]
    fn test_matching_pair_set_equality() {
        let sd = serde_json::json!({
            "left": [{"key": "L1", "content": "水"}, {"key": "L2", "content": "火"}],
            "right": [{"key": "R1", "content": "H2O"}, {"key": "R2", "content": "Fire"}],
            "pairs": [
                {"left": "L1", "right": "R1"},
                {"left": "L2", "right": "R2"}
            ]
        });
        // 顺序无关的集合相等
        assert_eq!(
            check_structured(
                r#"{"pairs":[{"left":"L2","right":"R2"},{"left":"L1","right":"R1"}]}"#,
                None,
                QuestionType::Matching,
                sd.clone()
            ),
            (true, false)
        );
        // 配错
        assert_eq!(
            check_structured(
                r#"{"pairs":[{"left":"L1","right":"R2"},{"left":"L2","right":"R1"}]}"#,
                None,
                QuestionType::Matching,
                sd.clone()
            ),
            (false, false)
        );
        // 缺配对
        assert_eq!(
            check_structured(
                r#"{"pairs":[{"left":"L1","right":"R1"}]}"#,
                None,
                QuestionType::Matching,
                sd.clone()
            ),
            (false, false)
        );
        // 重复配对凑数不通过
        assert_eq!(
            check_structured(
                r#"{"pairs":[{"left":"L1","right":"R1"},{"left":"L1","right":"R1"}]}"#,
                None,
                QuestionType::Matching,
                sd.clone()
            ),
            (false, false)
        );
        // 非法输入 → 判错
        assert_eq!(
            check_structured("随便写的", None, QuestionType::Matching, sd),
            (false, false)
        );
        // 无标准配对 → 手动批改
        assert_eq!(
            check(r#"{"pairs":[]}"#, None, QuestionType::Matching),
            (false, true)
        );
    }

    #[test]
    fn test_fill_blank_structured_multi_blank() {
        let sd = serde_json::json!({
            "blanks": [
                {"answers": ["牛顿", "Newton"], "case_sensitive": false, "trim": true},
                {"answers": ["1687"]}
            ]
        });
        assert_eq!(
            check_structured(
                r#"["newton","1687"]"#,
                None,
                QuestionType::FillBlank,
                sd.clone()
            ),
            (true, false)
        );
        assert_eq!(
            check_structured(
                r#"["牛顿"," 1687 "]"#,
                None,
                QuestionType::FillBlank,
                sd.clone()
            ),
            (true, false)
        );
        // 第二空错误
        assert_eq!(
            check_structured(
                r#"["牛顿","1688"]"#,
                None,
                QuestionType::FillBlank,
                sd.clone()
            ),
            (false, false)
        );
        // 空数不符
        assert_eq!(
            check_structured(r#"["牛顿"]"#, None, QuestionType::FillBlank, sd.clone()),
            (false, false)
        );
        // case_sensitive = true
        let cs = serde_json::json!({
            "blanks": [{"answers": ["pH"], "case_sensitive": true, "trim": true}]
        });
        assert_eq!(
            check_structured("pH", None, QuestionType::FillBlank, cs.clone()),
            (true, false)
        );
        assert_eq!(
            check_structured("ph", None, QuestionType::FillBlank, cs),
            (false, false)
        );
        // 单空兼容裸字符串
        let single = serde_json::json!({
            "blanks": [{"answers": ["能量守恒"]}]
        });
        assert_eq!(
            check_structured("能量守恒", None, QuestionType::FillBlank, single),
            (true, false)
        );
    }

    #[test]
    fn test_question_type_from_str_lenient() {
        assert_eq!(
            QuestionType::from_str("true_false"),
            QuestionType::TrueFalse
        );
        assert_eq!(QuestionType::from_str("TrueFalse"), QuestionType::TrueFalse);
        assert_eq!(QuestionType::from_str("matching"), QuestionType::Matching);
        assert_eq!(QuestionType::from_str("ordering"), QuestionType::Ordering);
        assert_eq!(QuestionType::from_str("numeric"), QuestionType::Numeric);
        assert_eq!(
            QuestionType::from_str("SingleChoice"),
            QuestionType::SingleChoice
        );
        assert_eq!(
            QuestionType::from_str("single_choice"),
            QuestionType::SingleChoice
        );
        assert_eq!(QuestionType::from_str("unknown_type"), QuestionType::Other);
    }

    #[test]
    fn test_compute_streak_days() {
        use chrono::NaiveDate;
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let today = d("2026-08-02");
        let streak = |dates: &[&str]| {
            let parsed: Vec<NaiveDate> = dates.iter().map(|s| d(s)).collect();
            QuestionBankService::compute_streak_days(&parsed, today)
        };

        // 空历史
        assert_eq!(streak(&[]), 0);
        // 今天打卡，跨月连续（8/2, 8/1, 7/31, 7/30）
        assert_eq!(
            streak(&["2026-08-02", "2026-08-01", "2026-07-31", "2026-07-30"]),
            4
        );
        // 今天没打卡但昨天打了，从昨天起算
        assert_eq!(streak(&["2026-08-01", "2026-07-31"]), 2);
        // 前天最后一次打卡：已中断
        assert_eq!(streak(&["2026-07-31", "2026-07-30"]), 0);
        // 中间断档只算到断档处
        assert_eq!(streak(&["2026-08-02", "2026-08-01", "2026-07-30"]), 2);
        // 重复日期（防御）不应重复计数
        assert_eq!(streak(&["2026-08-02", "2026-08-02", "2026-08-01"]), 2);
    }

    /// 在同一题目集内造 n 道填空题（答案均为 "2"），返回 (exam_id, question_ids)
    fn seed_exam_with_questions(vfs_db: &VfsDatabase, n: usize) -> (String, Vec<String>) {
        let exam_id = format!("exam_{}", nanoid::nanoid!(6));
        let conn = vfs_db.get_conn_safe().expect("conn");
        conn.execute(
            "INSERT INTO exam_sheets (
                id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
             ) VALUES (?1, 'daily practice test', 'completed', ?2, '{}', '{}', ?3, ?3)",
            params![exam_id, format!("temp_{exam_id}"), "2020-01-01T00:00:00Z"],
        )
        .expect("exam");
        drop(conn);
        let mut ids = Vec::with_capacity(n);
        for i in 0..n {
            let id = VfsQuestionRepo::create_question(
                vfs_db,
                &CreateQuestionParams {
                    exam_id: exam_id.clone(),
                    card_id: None,
                    question_label: Some(format!("Q{i}")),
                    content: format!("question {i}?"),
                    options: None,
                    answer: Some("2".into()),
                    explanation: None,
                    structured_data: None,
                    question_type: Some(QuestionType::FillBlank),
                    difficulty: None,
                    tags: None,
                    source_type: None,
                    source_ref: None,
                    images: None,
                    parent_id: None,
                },
            )
            .expect("create question")
            .id;
            ids.push(id);
        }
        (exam_id, ids)
    }

    /// B1 修复回归：每日一练进度必须反映当日真实作答（此前 completed_count 恒 0），
    /// 且推荐题目排除今天已答过的题。
    #[test]
    fn daily_practice_progress_reflects_todays_submissions() {
        let (_tmp, vfs_db, qbank) = setup_qbank();
        let (exam_id, qids) = seed_exam_with_questions(&vfs_db, 8);

        // 今天答 2 题：1 对 1 错
        qbank
            .submit_answer(&qids[0], "2", Some(true), Some("dp-1"))
            .expect("submit correct");
        qbank
            .submit_answer(&qids[1], "x", Some(false), Some("dp-2"))
            .expect("submit wrong");

        let daily = qbank.get_daily_practice(&exam_id, 5).expect("daily");
        assert_eq!(daily.completed_count, 2, "当日进度按题去重推导");
        assert_eq!(daily.correct_count, 1);
        assert!(!daily.is_completed, "2 < 5 未达标");
        assert_eq!(daily.daily_target, 5);
        assert_eq!(daily.question_ids.len(), 5);
        assert!(
            !daily.question_ids.contains(&qids[0]) && !daily.question_ids.contains(&qids[1]),
            "今天已答过的题不应再进推荐"
        );
    }

    /// B1 修复回归：目标达成后 is_completed=true，且"再练一组"仍能拿到题
    /// （未答题不足时允许回补今天已答过的题）。
    #[test]
    fn daily_practice_marks_completed_and_supports_another_round() {
        let (_tmp, vfs_db, qbank) = setup_qbank();
        let (exam_id, qids) = seed_exam_with_questions(&vfs_db, 3);

        for (i, qid) in qids.iter().enumerate() {
            qbank
                .submit_answer(qid, "2", Some(true), Some(&format!("dc-{i}")))
                .expect("submit");
        }

        let daily = qbank.get_daily_practice(&exam_id, 2).expect("daily");
        assert_eq!(daily.completed_count, 3);
        assert_eq!(daily.correct_count, 3);
        assert!(daily.is_completed, "3 >= 2 达标");
        assert!(
            !daily.question_ids.is_empty(),
            "题库题目全部答完时回补已答题，保证再练一组有题可练"
        );
    }

    /// B2 修复回归：打卡"达标"判定必须跟随用户目标，而非硬编码 10 题。
    #[test]
    fn check_in_calendar_target_follows_user_goal() {
        let (_tmp, vfs_db, qbank) = setup_qbank();
        let (exam_id, qids) = seed_exam_with_questions(&vfs_db, 2);
        qbank
            .submit_answer(&qids[0], "2", Some(true), Some("cal-1"))
            .expect("submit");

        let now = chrono::Local::now();
        let (year, month) = (now.format("%Y").to_string(), now.format("%m").to_string());
        let year: i32 = year.parse().unwrap();
        let month: u32 = month.parse().unwrap();
        let today = now.format("%Y-%m-%d").to_string();

        let low_target = qbank
            .get_check_in_calendar(Some(&exam_id), year, month, Some(1))
            .expect("calendar target=1");
        let today_row = low_target
            .days
            .iter()
            .find(|d| d.date == today)
            .expect("today check-in exists");
        assert!(today_row.target_achieved, "做 1 题、目标 1 → 达标");

        let default_target = qbank
            .get_check_in_calendar(Some(&exam_id), year, month, None)
            .expect("calendar default");
        let today_row = default_target
            .days
            .iter()
            .find(|d| d.date == today)
            .expect("today check-in exists");
        assert!(!today_row.target_achieved, "缺省目标 10：1 题不达标");
    }

    /// B3 修复回归：自评改判（含 AI 评判后的换判）修正最近一次提交，
    /// 不新增作答记录、不双计 attempt_count；correct_count 按差值增减。
    #[test]
    fn regrade_submission_flips_latest_without_double_counting() {
        let (_tmp, vfs_db, qbank) = setup_qbank();
        let (exam_id, qids) = seed_exam_with_questions(&vfs_db, 1);
        let qid = &qids[0];

        // 已判定为错的提交（模拟 AI 评判/首次自评后的状态）
        let first = qbank
            .submit_answer(qid, "my answer", Some(false), Some("rg-1"))
            .expect("initial submit");
        assert_eq!(first.updated_question.attempt_count, 1);
        assert_eq!(first.updated_question.correct_count, 0);

        let count_submissions = |db: &VfsDatabase| -> i64 {
            db.get_conn_safe()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM answer_submissions WHERE question_id = ?1",
                    params![qid],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(count_submissions(&vfs_db), 1);

        // 换判 错 → 对：改原提交，不插新记录
        let flipped = qbank
            .regrade_submission(qid, &first.submission_id, true)
            .expect("regrade to correct");
        assert_eq!(flipped.is_correct, Some(true));
        assert_eq!(flipped.submission_id, first.submission_id, "改判同一条提交");
        assert_eq!(flipped.updated_question.attempt_count, 1, "attempt 不双计");
        assert_eq!(
            flipped.updated_question.correct_count, 1,
            "错→对 correct_count +1"
        );
        assert_eq!(count_submissions(&vfs_db), 1, "不新增作答记录");

        // 同向改判幂等：无写入、无副作用
        let idem = qbank
            .regrade_submission(qid, &first.submission_id, true)
            .expect("idempotent regrade");
        assert_eq!(idem.updated_question.correct_count, 1);
        assert_eq!(count_submissions(&vfs_db), 1);

        // 换判 对 → 错：correct_count 回退，状态回 review
        let back = qbank
            .regrade_submission(qid, &first.submission_id, false)
            .expect("regrade to wrong");
        assert_eq!(back.is_correct, Some(false));
        assert_eq!(
            back.updated_question.correct_count, 0,
            "对→错 correct_count -1"
        );
        assert_eq!(back.updated_question.status, QuestionStatus::Review);
        assert_eq!(count_submissions(&vfs_db), 1);
        let _ = exam_id;
    }

    /// B3 边界：只能改判最近一次提交；提交了新答案后旧提交拒绝改判。
    #[test]
    fn regrade_submission_rejects_stale_submission() {
        let (_tmp, vfs_db, qbank) = setup_qbank();
        let (_exam_id, qids) = seed_exam_with_questions(&vfs_db, 1);
        let qid = &qids[0];

        let first = qbank
            .submit_answer(qid, "old", Some(false), Some("st-1"))
            .expect("first submit");
        qbank
            .submit_answer(qid, "new", Some(false), Some("st-2"))
            .expect("second submit");

        let err = qbank
            .regrade_submission(qid, &first.submission_id, true)
            .expect_err("stale submission must be rejected");
        assert!(
            err.to_string().contains("最近一次提交"),
            "错误信息应说明只能改判最近一次提交，实际：{err}"
        );
    }

    /// R4 verdict 原语：直接驱动 apply_submission_verdict_in_tx，
    /// 校验计数差值口径（NULL→true +1；true→false -1 且 MAX(0)；false→true +1）、
    /// 同向幂等零写入，answer_submissions 的 RowSync 推进
    /// （updated_at 落值、local_version 逐次 +1、幂等时不动），
    /// 以及 mastery 分路：首判写 me_qbank_{sid}，换判走
    /// record_qbank_verdict_correction_with_conn（tombstone 旧信号 +
    /// 追加 me_qbank_{sid}_r{n} 修订事件），不再被 ON CONFLICT DO NOTHING
    /// 锁死在首判方向。
    #[test]
    fn apply_submission_verdict_counts_and_rowsync() {
        let (_tmp, vfs_db, qbank) = setup_qbank();
        let (_exam_id, qids) = seed_exam_with_questions(&vfs_db, 1);
        let qid = &qids[0];

        // 造一条待判定提交（is_correct IS NULL）：清空参考答案后提交 → 需人工批改
        {
            let conn = vfs_db.get_conn_safe().expect("conn");
            conn.execute(
                "UPDATE questions SET answer = NULL WHERE id = ?1",
                params![qid],
            )
            .expect("clear answer");
        }
        let pending = qbank
            .submit_answer(qid, "my essay", None, Some("av-1"))
            .expect("pending submit");
        assert_eq!(pending.is_correct, None, "前置：主观题提交待判定");

        // 事务内取最新 submission + question，跑一次原语，返回 (outcome, 行级同步列)
        let apply = |verdict: bool, method: &str| -> (VerdictApplyOutcome, Option<String>, i64) {
            let mut conn = vfs_db.get_conn_safe().expect("conn");
            let tx = conn.transaction().expect("tx");
            let question = VfsQuestionRepo::get_question_with_conn(&tx, qid)
                .expect("question")
                .expect("question exists");
            let submission = VfsQuestionRepo::get_submissions_with_conn(&tx, qid, 1)
                .expect("submissions")
                .into_iter()
                .next()
                .expect("latest submission");
            let now = chrono::Utc::now().to_rfc3339();
            let outcome = qbank
                .apply_submission_verdict_in_tx(&tx, &question, &submission, verdict, method, &now)
                .expect("apply verdict");
            let (updated_at, local_version): (Option<String>, i64) = tx
                .query_row(
                    "SELECT updated_at, COALESCE(local_version, 0) FROM answer_submissions WHERE id = ?1",
                    params![submission.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("rowsync columns");
            tx.commit().expect("commit");
            (outcome, updated_at, local_version)
        };

        // 本 submission 的 mastery 事件链快照：
        // (存活事件 (id, outcome) 按 id 升序, tombstone 数)。
        // 前缀用 substr 精确匹配（与 mastery 侧口径一致），不吃 LIKE 通配符。
        let sid = pending.submission_id.clone();
        let mastery_chain = || -> (Vec<(String, String)>, i64) {
            let conn = vfs_db.get_conn_safe().expect("conn");
            let base_id = format!("me_qbank_{sid}");
            let revision_prefix = format!("{base_id}_r");
            let mut stmt = conn
                .prepare(
                    "SELECT id, outcome, deleted_at FROM mastery_events \
                     WHERE id = ?1 OR substr(id, 1, length(?2)) = ?2 \
                     ORDER BY id",
                )
                .expect("prepare mastery chain query");
            let rows = stmt
                .query_map(params![base_id, revision_prefix], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .expect("query mastery chain");
            let mut live = Vec::new();
            let mut tombstones = 0i64;
            for row in rows {
                let (id, outcome, deleted_at) = row.expect("chain row");
                if deleted_at.is_some() {
                    tombstones += 1;
                } else {
                    live.push((id, outcome));
                }
            }
            (live, tombstones)
        };

        // NULL→true：+1，首判写 mastery，RowSync 落值（INSERT 时 updated_at=NULL/version=0）
        let (o1, updated_at1, v1) = apply(true, "ai");
        assert!(o1.changed);
        assert_eq!(o1.updated_question.correct_count, 1, "NULL→true +1");
        assert_eq!(o1.updated_question.is_correct, Some(true));
        assert!(o1.mastery_state.is_some(), "首判应产出 mastery 状态");
        assert!(!o1.needs_review_plan);
        assert!(updated_at1.is_some(), "改判必须推进 updated_at");
        assert_eq!(v1, 1, "local_version 0→1");
        let (live, tombstones) = mastery_chain();
        assert_eq!(
            live,
            vec![(format!("me_qbank_{sid}"), "correct".to_string())],
            "首判恰好一条 base 事件"
        );
        assert_eq!(tombstones, 0);

        // 同向幂等：零写入，计数与 RowSync 均不动
        let (o2, updated_at2, v2) = apply(true, "manual");
        assert!(!o2.changed, "同向改判应幂等短路");
        assert_eq!(o2.updated_question.correct_count, 1);
        assert!(o2.mastery_state.is_none());
        assert_eq!(updated_at2, updated_at1, "幂等路径不得推进 updated_at");
        assert_eq!(v2, 1, "幂等路径不得推进 local_version");

        // true→false：-1（MAX(0) 防负），状态回 review，需建复习计划；
        // mastery 走纠正路径——base 被 tombstone，存活信号变为 _r1 wrong，
        // 而不是 DO NOTHING 之后仍停留在首判 correct
        let (o3, updated_at3, v3) = apply(false, "manual");
        assert!(o3.changed);
        assert_eq!(o3.updated_question.correct_count, 0, "true→false -1");
        assert_eq!(o3.updated_question.status, QuestionStatus::Review);
        assert!(o3.needs_review_plan);
        assert!(updated_at3.is_some());
        assert_eq!(v3, 2, "local_version 1→2");
        assert!(o3.mastery_state.is_some(), "换判纠正应产出 mastery 状态");
        let (live, tombstones) = mastery_chain();
        assert_eq!(
            live,
            vec![(format!("me_qbank_{sid}_r1"), "wrong".to_string())],
            "换判必须 tombstone 首判并追加 _r1 修订事件（不得 DO NOTHING 锁死首判）"
        );
        assert_eq!(tombstones, 1, "首判 base 事件被软删");

        // false→true：+1；纠正链继续推进到 _r2 correct
        let (o4, _updated_at4, v4) = apply(true, "manual");
        assert!(o4.changed);
        assert_eq!(o4.updated_question.correct_count, 1, "false→true +1");
        assert_eq!(v4, 3, "local_version 2→3");
        let (live, tombstones) = mastery_chain();
        assert_eq!(
            live,
            vec![(format!("me_qbank_{sid}_r2"), "correct".to_string())]
        );
        assert_eq!(tombstones, 2);

        // 再来一次 true→false 后连续 true→false 幂等：correct_count 不会被减成负数
        let (o5, _, _) = apply(false, "manual");
        assert_eq!(o5.updated_question.correct_count, 0);
        let (o6, _, v6) = apply(false, "manual");
        assert!(!o6.changed);
        assert_eq!(o6.updated_question.correct_count, 0, "MAX(0,·) 防负 + 幂等");
        assert_eq!(v6, 4, "第 5 次是幂等短路，version 停在 4");
        // 同向幂等不追加纠正：存活信号停在 _r3 wrong，链上无新事件
        let (live, tombstones) = mastery_chain();
        assert_eq!(
            live,
            vec![(format!("me_qbank_{sid}_r3"), "wrong".to_string())],
            "同向幂等不得追加纠正事件"
        );
        assert_eq!(tombstones, 3);
    }

    /// R4：submit_answer / regrade_submission 返回当日权威进度快照，
    /// 前端据此回写 completed/correct 计数（按题去重、任一次答对计 correct）。
    #[test]
    fn submit_and_regrade_return_daily_progress_snapshot() {
        let (_tmp, vfs_db, qbank) = setup_qbank();
        let (exam_id, qids) = seed_exam_with_questions(&vfs_db, 2);

        let first = qbank
            .submit_answer(&qids[0], "x", Some(false), Some("dpv-1"))
            .expect("submit wrong");
        let dp = first.daily_progress.expect("daily_progress attached");
        assert_eq!(dp.exam_id, exam_id);
        assert_eq!(dp.completed_count, 1);
        assert_eq!(dp.correct_count, 0);
        assert_eq!(dp.answered_question_ids, vec![qids[0].clone()]);

        // 改判 错→对：快照跟随权威口径（当天任一次答对即计 correct）
        let regraded = qbank
            .regrade_submission(&qids[0], &first.submission_id, true)
            .expect("regrade to correct");
        let dp = regraded.daily_progress.expect("daily_progress attached");
        assert_eq!(dp.completed_count, 1, "改判不新增作答，题数不变");
        assert_eq!(dp.correct_count, 1, "错→对后 correct 回写为 1");

        // 第二题答对：按题去重累计
        let second = qbank
            .submit_answer(&qids[1], "2", Some(true), Some("dpv-2"))
            .expect("submit correct");
        let dp = second.daily_progress.expect("daily_progress attached");
        assert_eq!(dp.completed_count, 2);
        assert_eq!(dp.correct_count, 2);
        assert_eq!(dp.answered_question_ids.len(), 2);
    }

    /// M-5：题型切换后旧 structured_data 的清空规则
    /// - 切到不使用 structured_data 的题型且未显式携带 → 清空
    /// - 切到仍使用 structured_data 的题型（fill_blank/matching/ordering/numeric）→ 不清
    /// - 不动题型的普通更新（question_type 为 None）→ 绝不清
    /// - 显式携带 structured_data → 按显式值走，不额外清
    #[test]
    fn update_params_clear_stale_structured_data_only_on_type_switch() {
        let switch_to_short_answer = UpdateQuestionParams {
            question_type: Some(QuestionType::ShortAnswer),
            ..Default::default()
        };
        assert!(switch_to_short_answer.should_clear_stale_structured_data());

        for qtype in [
            QuestionType::FillBlank,
            QuestionType::Matching,
            QuestionType::Ordering,
            QuestionType::Numeric,
        ] {
            let params = UpdateQuestionParams {
                question_type: Some(qtype),
                ..Default::default()
            };
            assert!(
                !params.should_clear_stale_structured_data(),
                "结构化题型不应触发清空"
            );
        }

        // 只改难度不动题型：绝不能清空
        let difficulty_only = UpdateQuestionParams {
            difficulty: Some(Difficulty::Hard),
            ..Default::default()
        };
        assert!(!difficulty_only.should_clear_stale_structured_data());

        // 显式携带 structured_data（含显式 Null 清空）时按显式值走
        let explicit_payload = UpdateQuestionParams {
            question_type: Some(QuestionType::ShortAnswer),
            structured_data: Some(serde_json::json!({"legacy": true})),
            ..Default::default()
        };
        assert!(!explicit_payload.should_clear_stale_structured_data());
        let explicit_null = UpdateQuestionParams {
            question_type: Some(QuestionType::ShortAnswer),
            structured_data: Some(serde_json::Value::Null),
            ..Default::default()
        };
        assert!(!explicit_null.should_clear_stale_structured_data());
    }
}
