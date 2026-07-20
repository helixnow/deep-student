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

                return Ok(SubmitAnswerResult {
                    is_correct,
                    correct_answer: question.answer.clone(),
                    needs_manual_grading,
                    message,
                    updated_question,
                    updated_stats,
                    submission_id: existing_submission.id,
                });
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

        Ok(SubmitAnswerResult {
            is_correct,
            correct_answer: question.answer,
            needs_manual_grading,
            message,
            updated_question,
            updated_stats,
            submission_id,
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
            "true" | "t" | "1" | "yes" | "y" | "对" | "正确" | "是" | "真" | "√" | "✓"
            | "✔" => Some(true),
            "false" | "f" | "0" | "no" | "n" | "错" | "错误" | "否" | "假" | "不对" | "×"
            | "✗" | "✘" | "x" => Some(false),
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
        let structured_answer = structured_data
            .and_then(|sd| sd.get("answer_value").and_then(|v| v.as_f64()).map(|a| (sd, a)));
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
            return if result.is_empty() { None } else { Some(result) };
        }
        // 分隔符回退："B,A,C"、"B、A、C"、"B → A → C"
        let normalized: String = trimmed.chars().map(Self::normalize_fullwidth_char).collect();
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
            let user_values: Vec<String> = match serde_json::from_str::<serde_json::Value>(
                user_answer.trim(),
            ) {
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

        // M-031: 使用 SQL 层随机抽取各类别题目，避免全量加载
        let mut selected_ids: Vec<String> = Vec::new();

        // 1. 优先选择错题（status = review），最多占一半
        let mistake_filters = QuestionFilters {
            status: Some(vec![QuestionStatus::Review]),
            ..Default::default()
        };
        let mistake_ids = VfsQuestionRepo::random_question_ids(
            &self.vfs_db,
            exam_id,
            &mistake_filters,
            &[],
            None,
            (count / 2).max(1),
        )
        .map_err(|e| AppError::database(e.to_string()))?;
        selected_ids.extend(mistake_ids);
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
                &selected_ids,
                None,
                remaining,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            selected_ids.extend(new_ids);
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
                &selected_ids,
                Some(&seven_days_ago),
                remaining,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            selected_ids.extend(review_ids);
        }
        let review_count = (selected_ids.len() as u32)
            .saturating_sub(mistake_count)
            .saturating_sub(new_count);

        // 4. 如果还不够，随机补充（不限状态）
        if selected_ids.len() < target_count {
            let remaining = (target_count - selected_ids.len()) as u32;
            let fill_ids = VfsQuestionRepo::random_question_ids(
                &self.vfs_db,
                exam_id,
                &QuestionFilters::default(),
                &selected_ids,
                None,
                remaining,
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            selected_ids.extend(fill_ids);
        }

        if selected_ids.is_empty() {
            return Err(AppError::validation("题目集中没有题目"));
        }

        let result = DailyPracticeResult {
            date: today,
            exam_id: exam_id.to_string(),
            question_ids: selected_ids.clone(),
            daily_target: count,
            completed_count: 0,
            correct_count: 0,
            source_distribution: DailySourceDistribution {
                mistake_count,
                new_count,
                review_count,
            },
            is_completed: false,
        };

        info!(
            "[QuestionBankService] Generated daily practice: exam_id={}, count={}, mistakes={}, new={}, review={}",
            exam_id, selected_ids.len(), mistake_count, new_count, review_count
        );

        Ok(result)
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
    pub fn get_check_in_calendar(
        &self,
        exam_id: Option<&str>,
        year: i32,
        month: u32,
    ) -> Result<CheckInCalendar, AppError> {
        if !(1..=12).contains(&month) {
            return Err(AppError::validation("月份必须在 1-12 之间"));
        }
        if !(1970..=9999).contains(&year) {
            return Err(AppError::validation("年份无效"));
        }

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
                study_duration_seconds: 0,             // 暂不支持时长统计
                target_achieved: question_count >= 10, // 默认每日目标 10 题
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
            check_structured(
                "３.１４",
                None,
                QuestionType::Numeric,
                sd(0.0, "absolute")
            ),
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
        assert_eq!(check("abc", Some("3.14"), QuestionType::Numeric), (false, false));
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
        assert_eq!(QuestionType::from_str("true_false"), QuestionType::TrueFalse);
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
}
