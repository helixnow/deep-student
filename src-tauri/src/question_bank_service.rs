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
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{
    AnswerSubmission,
    CreateQuestionParams,
    Difficulty,
    Question,
    QuestionBankStats,
    QuestionFilters,
    QuestionHistory,
    QuestionListResult,
    QuestionOption,
    QuestionSearchFilters,
    QuestionSearchListResult,
    // FTS5 全文搜索相关
    QuestionSearchResult,
    QuestionStatus,
    QuestionType,
    SearchSortBy,
    SourceType,
    UpdateQuestionParams,
    VfsExamRepo,
    VfsQuestionRepo,
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
        if params.status.is_some() {
            if let Err(e) = self.refresh_stats(&question.exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

        debug!("[QuestionBankService] Updated question id={}", question_id);

        Ok(question)
    }

    /// 批量更新题目
    pub fn batch_update_questions(
        &self,
        question_ids: &[String],
        params: &UpdateQuestionParams,
    ) -> Result<BatchResult, AppError> {
        let mut success_count = 0;
        let mut errors = Vec::new();
        let mut exam_ids = std::collections::HashSet::new();

        for id in question_ids {
            match self.update_question(id, params, false) {
                Ok(q) => {
                    success_count += 1;
                    exam_ids.insert(q.exam_id);
                }
                Err(e) => {
                    errors.push(format!("{}: {}", id, e));
                }
            }
        }

        // 更新统计
        for exam_id in exam_ids {
            if let Err(e) = self.refresh_stats(&exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

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
    pub fn batch_delete_questions(&self, question_ids: &[String]) -> Result<BatchResult, AppError> {
        // 收集 exam_ids
        let mut exam_ids = std::collections::HashSet::new();
        let mut errors = Vec::new();
        let mut success_count = 0;

        for id in question_ids {
            match self.get_question(id) {
                Ok(Some(q)) => {
                    exam_ids.insert(q.exam_id.clone());
                    match VfsQuestionRepo::batch_delete_questions(&self.vfs_db, &[id.clone()]) {
                        Ok(1) => {
                            success_count += 1;
                        }
                        Ok(_) => {
                            errors.push(format!("{}: not found or already deleted", id));
                        }
                        Err(e) => {
                            errors.push(format!("{}: {}", id, e));
                        }
                    }
                }
                Ok(None) => {
                    errors.push(format!("{}: not found", id));
                }
                Err(e) => {
                    errors.push(format!("{}: {}", id, e));
                }
            }
        }

        // 更新统计
        for exam_id in exam_ids {
            if let Err(e) = self.refresh_stats(&exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

        Ok(BatchResult {
            success_count,
            failed_count: errors.len(),
            errors,
        })
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
    ) -> Result<SubmitAnswerResult, AppError> {
        // 获取题目
        let question = self
            .get_question(question_id)?
            .ok_or_else(|| AppError::not_found(format!("Question not found: {}", question_id)))?;

        // 判断正确性
        let (raw_is_correct, needs_manual_grading) = if let Some(override_val) = is_correct_override
        {
            (override_val, false)
        } else {
            self.check_answer_correctness(
                user_answer,
                question.answer.as_deref(),
                &question.question_type,
            )
        };
        // M-063: 主观题 is_correct 设为 None，避免工具调用方误判为"错误"
        let is_correct: Option<bool> = if needs_manual_grading {
            None
        } else {
            Some(raw_is_correct)
        };

        // 更新题目
        let updated_question = VfsQuestionRepo::submit_answer(
            &self.vfs_db,
            question_id,
            user_answer,
            is_correct,
            needs_manual_grading,
        )
        .map_err(|e| AppError::database(e.to_string()))?;

        // 记录作答历史
        let grading_method = if needs_manual_grading { "ai" } else { "auto" };
        let submission_id = VfsQuestionRepo::insert_submission(
            &self.vfs_db,
            question_id,
            user_answer,
            is_correct,
            grading_method,
        )
        .map_err(|e| AppError::database(e.to_string()))?;

        // 更新统计
        let updated_stats = self.refresh_stats(&question.exam_id)?;

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

    /// 判断答案正确性
    fn check_answer_correctness(
        &self,
        user_answer: &str,
        correct_answer: Option<&str>,
        question_type: &QuestionType,
    ) -> (bool, bool) {
        let user_answer = user_answer.trim();

        // 如果没有标准答案，需要手动批改
        let correct_answer = match correct_answer {
            Some(a) if !a.trim().is_empty() => a.trim(),
            _ => return (false, true),
        };

        match question_type {
            // 选择题：忽略大小写与标点
            QuestionType::SingleChoice => {
                let normalize = |s: &str| {
                    s.to_uppercase()
                        .chars()
                        .filter(|c| c.is_alphanumeric())
                        .collect::<String>()
                };
                let is_correct = normalize(user_answer) == normalize(correct_answer);
                (is_correct, false)
            }
            QuestionType::MultipleChoice | QuestionType::IndefiniteChoice => {
                let normalize = |s: &str| {
                    s.to_uppercase()
                        .chars()
                        .filter(|c| c.is_alphanumeric())
                        .collect::<Vec<char>>()
                };
                let mut user_chars = normalize(user_answer);
                let mut correct_chars = normalize(correct_answer);
                user_chars.sort();
                correct_chars.sort();
                let is_correct = user_chars == correct_chars;
                (is_correct, false)
            }
            // 填空题：模糊匹配
            QuestionType::FillBlank => {
                let normalize = |s: &str| -> String {
                    s.to_lowercase()
                        .chars()
                        .filter(|c| !c.is_whitespace())
                        .collect()
                };
                let is_correct = normalize(user_answer) == normalize(correct_answer);
                (is_correct, false)
            }
            // 主观题：需要手动批改
            QuestionType::ShortAnswer
            | QuestionType::Essay
            | QuestionType::Calculation
            | QuestionType::Proof => (false, true),
            // 其他：全部走手动批改，精确匹配时判正确
            QuestionType::Other => {
                let is_exact_match = user_answer.to_lowercase() == correct_answer.to_lowercase();
                if is_exact_match {
                    (true, false) // 完全匹配，判正确
                } else {
                    (false, true) // 不匹配，需手动批改（而非直接判错）
                }
            }
        }
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

    /// 解析选项
    fn parse_options(&self, card: &serde_json::Value) -> Option<Vec<QuestionOption>> {
        card.get("options").and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|opt| {
                    let key = opt.get("key").and_then(|v| v.as_str())?.to_string();
                    let content = opt.get("content").and_then(|v| v.as_str())?.to_string();
                    Some(QuestionOption { key, content })
                })
                .collect()
        })
    }

    /// 解析题目类型
    fn parse_question_type(&self, card: &serde_json::Value) -> Option<QuestionType> {
        card.get("question_type")
            .and_then(|v| v.as_str())
            .map(|s| QuestionType::from_str(s))
    }

    /// 解析难度
    fn parse_difficulty(&self, card: &serde_json::Value) -> Option<Difficulty> {
        card.get("difficulty")
            .and_then(|v| v.as_str())
            .map(|s| Difficulty::from_str(s))
    }

    /// 解析状态
    fn parse_status(&self, card: &serde_json::Value) -> QuestionStatus {
        card.get("status")
            .and_then(|v| v.as_str())
            .map(|s| QuestionStatus::from_str(s))
            .unwrap_or(QuestionStatus::New)
    }

    // ========================================================================
    // 重置进度
    // ========================================================================

    /// 重置学习进度
    pub fn reset_progress(&self, exam_id: &str) -> Result<QuestionBankStats, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
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

        // 清除作答历史
        VfsQuestionRepo::delete_submissions_by_exam(&self.vfs_db, exam_id)
            .map_err(|e| AppError::database(e.to_string()))?;

        info!(
            "[QuestionBankService] Reset progress for exam_id={} (including submissions & AI cache)",
            exam_id
        );

        self.refresh_stats(exam_id)
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
        let now = chrono::Utc::now().to_rfc3339();
        let mut success_count = 0;
        let mut errors = Vec::new();
        let mut exam_ids: HashSet<String> = HashSet::new();

        for question_id in question_ids {
            match self.get_question(question_id) {
                Ok(Some(question)) => {
                    let affected = conn
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
                        errors.push(format!("{}: not found", question_id));
                    } else {
                        // 清除该题的作答历史
                        let _ = VfsQuestionRepo::delete_submissions_by_question(
                            &self.vfs_db,
                            question_id,
                        );
                        success_count += 1;
                        exam_ids.insert(question.exam_id);
                    }
                }
                Ok(None) => {
                    errors.push(format!("{}: not found", question_id));
                }
                Err(e) => {
                    errors.push(format!("{}: {}", question_id, e));
                }
            }
        }

        for exam_id in exam_ids {
            if let Err(e) = self.refresh_stats(&exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

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
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        // 构建基础查询
        let (base_condition, params): (String, Vec<String>) = if let Some(eid) = exam_id {
            (
                "exam_id = ?1 AND deleted_at IS NULL".to_string(),
                vec![eid.to_string()],
            )
        } else {
            ("deleted_at IS NULL".to_string(), vec![])
        };

        // 从 answer_submissions 表统计每日做题次数（而非 questions.last_attempt_at 统计题数）
        let sql = format!(
            r#"
            SELECT
                DATE(s.submitted_at) as date,
                COUNT(*) as attempt_count,
                SUM(CASE WHEN s.is_correct = 1 THEN 1 ELSE 0 END) as correct_count
            FROM answer_submissions s
            INNER JOIN questions q ON s.question_id = q.id
            WHERE q.{}
                AND s.submitted_at IS NOT NULL
                AND DATE(s.submitted_at) >= ?
                AND DATE(s.submitted_at) <= ?
            GROUP BY DATE(s.submitted_at)
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
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        let start_date = format!("{}-01-01", year);
        let end_date = format!("{}-12-31", year);

        // 构建基础查询条件
        let base_condition = if exam_id.is_some() {
            "exam_id = ?1 AND deleted_at IS NULL"
        } else {
            "deleted_at IS NULL"
        };

        // 查询每日活跃度（统计做题次数）
        let sql = format!(
            r#"
            SELECT
                DATE(last_attempt_at) as date,
                COUNT(*) as count,
                SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct_count
            FROM questions
            WHERE {}
                AND last_attempt_at IS NOT NULL
                AND DATE(last_attempt_at) >= ?
                AND DATE(last_attempt_at) <= ?
            GROUP BY DATE(last_attempt_at)
            ORDER BY date ASC
            "#,
            base_condition
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
        let wrong_count = answered_count - correct_count;
        let unanswered_count = total_count - answered_count;

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
        let mut type_stats: std::collections::HashMap<String, TypeStatItem> =
            std::collections::HashMap::new();
        let mut difficulty_stats: std::collections::HashMap<String, DifficultyStatItem> =
            std::collections::HashMap::new();
        let mut wrong_question_ids: Vec<String> = Vec::new();

        for qid in &session.question_ids {
            if let Ok(Some(question)) = self.get_question(qid) {
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
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
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
            "exam_id = ?1 AND deleted_at IS NULL"
        } else {
            "deleted_at IS NULL"
        };

        // 查询每日做题统计
        let sql = format!(
            r#"
            SELECT
                DATE(last_attempt_at) as date,
                COUNT(*) as question_count,
                SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct_count
            FROM questions
            WHERE {}
                AND last_attempt_at IS NOT NULL
                AND DATE(last_attempt_at) >= ?
                AND DATE(last_attempt_at) < ?
            GROUP BY DATE(last_attempt_at)
            ORDER BY date ASC
            "#,
            base_condition
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

        // 计算连续打卡天数
        let streak_days = self.calculate_streak_days(&days);

        Ok(CheckInCalendar {
            year,
            month,
            days: days.clone(),
            streak_days,
            month_check_in_days: days.len() as u32,
            month_total_questions,
        })
    }

    /// 计算连续打卡天数
    fn calculate_streak_days(&self, days: &[DailyCheckIn]) -> u32 {
        use chrono::{Duration, NaiveDate};

        if days.is_empty() {
            return 0;
        }

        // 按日期排序（降序，最新的在前）
        let mut sorted_days: Vec<&DailyCheckIn> =
            days.iter().filter(|d| d.question_count > 0).collect();
        sorted_days.sort_by(|a, b| b.date.cmp(&a.date));

        if sorted_days.is_empty() {
            return 0;
        }

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

        // 如果今天没有打卡，检查昨天
        let yesterday = (chrono::Utc::now() - Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();

        let start_date = if sorted_days[0].date == today {
            today.clone()
        } else if sorted_days[0].date == yesterday {
            yesterday.clone()
        } else {
            return 0; // 连续打卡已中断
        };

        let mut streak = 0u32;
        let mut current_date = NaiveDate::parse_from_str(&start_date, "%Y-%m-%d").ok();

        for day in sorted_days {
            if let Some(ref curr) = current_date {
                let day_date = NaiveDate::parse_from_str(&day.date, "%Y-%m-%d").ok();
                if let Some(dd) = day_date {
                    if dd == *curr {
                        streak += 1;
                        current_date = Some(*curr - Duration::days(1));
                    } else if dd < *curr {
                        break; // 连续中断
                    }
                }
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
pub enum PracticeMode {
    /// 顺序练习
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

impl Default for PracticeMode {
    fn default() -> Self {
        PracticeMode::Sequential
    }
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
pub enum PaperExportFormat {
    /// 预览（不导出文件）
    Preview,
    /// PDF 格式
    Pdf,
    /// Word 格式
    Word,
    /// Markdown 格式
    Markdown,
}

impl Default for PaperExportFormat {
    fn default() -> Self {
        PaperExportFormat::Preview
    }
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
