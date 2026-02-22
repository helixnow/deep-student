//! 复习计划服务模块
//!
//! 提供复习计划的业务逻辑层，整合 SM-2 算法和数据仓库操作。
//!
//! ## 核心功能
//! - `create_review_plan`: 创建复习计划
//! - `process_review`: 处理复习结果，使用 SM-2 算法计算下次复习时间
//! - `get_due_reviews`: 获取到期复习
//! - `get_review_stats`: 获取复习统计
//! - `batch_create_from_questions`: 批量为题目创建复习计划

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::spaced_repetition::{
    calculate_next_review, calculate_next_review_date, DEFAULT_EASE_FACTOR,
    PASSING_GRADE,
};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::question_repo::{QuestionFilters, VfsQuestionRepo};
use crate::vfs::repos::review_plan_repo::{
    CalendarHeatmapData, CreateReviewPlanParams, DueReviewsFilter, DueReviewsResult,
    RecordReviewHistoryParams, ReviewHistory, ReviewPlan, ReviewPlanStatus, ReviewStats,
    UpdateReviewPlanParams, VfsReviewPlanRepo,
};

// ============================================================================
// 常量定义
// ============================================================================

/// 毕业阈值：间隔天数
const GRADUATION_INTERVAL_THRESHOLD: u32 = 21;

/// 毕业阈值：连续正确次数
const GRADUATION_REPETITIONS_THRESHOLD: u32 = 3;

/// 困难标记阈值：连续失败次数
const DIFFICULT_THRESHOLD: u32 = 3;

// ============================================================================
// 数据类型定义
// ============================================================================

/// 处理复习结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessReviewResult {
    /// 更新后的复习计划
    pub plan: ReviewPlan,
    /// 本次复习是否通过
    pub passed: bool,
    /// 新的复习间隔（天）
    pub new_interval: u32,
    /// 下次复习日期
    pub next_review_date: String,
    /// 复习历史记录
    pub history: ReviewHistory,
}

/// 批量创建复习计划结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchCreateResult {
    /// 成功创建的计划数
    pub created: u32,
    /// 已存在（跳过）的计划数
    pub skipped: u32,
    /// 失败的计划数
    pub failed: u32,
    /// 创建的计划列表
    pub plans: Vec<ReviewPlan>,
}

/// 复习计划服务配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewPlanServiceConfig {
    /// 初始易度因子
    pub initial_ease_factor: f64,
    /// 毕业间隔阈值
    pub graduation_interval_threshold: u32,
    /// 毕业重复次数阈值
    pub graduation_repetitions_threshold: u32,
    /// 困难标记阈值
    pub difficult_threshold: u32,
}

impl Default for ReviewPlanServiceConfig {
    fn default() -> Self {
        Self {
            initial_ease_factor: DEFAULT_EASE_FACTOR,
            graduation_interval_threshold: GRADUATION_INTERVAL_THRESHOLD,
            graduation_repetitions_threshold: GRADUATION_REPETITIONS_THRESHOLD,
            difficult_threshold: DIFFICULT_THRESHOLD,
        }
    }
}

// ============================================================================
// 复习计划服务
// ============================================================================

/// 复习计划服务
pub struct ReviewPlanService {
    /// VFS 数据库引用
    vfs_db: Arc<VfsDatabase>,
    /// 配置
    config: ReviewPlanServiceConfig,
}

impl ReviewPlanService {
    /// 创建复习计划服务
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        Self {
            vfs_db,
            config: ReviewPlanServiceConfig::default(),
        }
    }

    /// 使用自定义配置创建复习计划服务
    pub fn with_config(vfs_db: Arc<VfsDatabase>, config: ReviewPlanServiceConfig) -> Self {
        Self { vfs_db, config }
    }

    // ========================================================================
    // 核心业务方法
    // ========================================================================

    /// 创建复习计划
    ///
    /// # 参数
    /// * `question_id` - 题目 ID
    /// * `exam_id` - 题目集 ID
    ///
    /// # 返回
    /// * 创建的复习计划
    pub fn create_review_plan(&self, question_id: &str, exam_id: &str) -> Result<ReviewPlan> {
        let params = CreateReviewPlanParams {
            question_id: question_id.to_string(),
            exam_id: exam_id.to_string(),
            initial_ease_factor: Some(self.config.initial_ease_factor),
        };

        let plan = VfsReviewPlanRepo::create_plan(&self.vfs_db, &params).with_context(|| {
            format!(
                "Failed to create review plan for question_id={}",
                question_id
            )
        })?;

        info!(
            "[ReviewPlanService] Created review plan: id={}, question_id={}",
            plan.id, question_id
        );

        Ok(plan)
    }

    /// 处理复习结果
    ///
    /// 使用 SM-2 算法计算下次复习时间，更新复习计划。
    ///
    /// # 参数
    /// * `plan_id` - 复习计划 ID
    /// * `quality` - 复习质量评分 (0-5)
    /// * `user_answer` - 用户答案（可选）
    /// * `time_spent_seconds` - 复习耗时（可选）
    ///
    /// # 返回
    /// * 处理结果
    pub fn process_review(
        &self,
        plan_id: &str,
        quality: u8,
        user_answer: Option<String>,
        time_spent_seconds: Option<u32>,
    ) -> Result<ProcessReviewResult> {
        // 1. 获取当前复习计划
        let plan = VfsReviewPlanRepo::get_plan(&self.vfs_db, plan_id)
            .with_context(|| format!("Failed to get review plan: {}", plan_id))?
            .ok_or_else(|| anyhow::anyhow!("Review plan not found: {}", plan_id))?;

        // 2. 使用 SM-2 算法计算新参数
        let (new_interval, new_ease_factor, new_repetitions) = calculate_next_review(
            quality,
            plan.repetitions,
            plan.ease_factor,
            plan.interval_days,
        );

        // 3. 计算下次复习日期
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let next_review_date = calculate_next_review_date(new_interval);

        // 4. 判断是否通过
        let passed = quality >= PASSING_GRADE;

        // 5. 计算新状态
        let (new_status, consecutive_failures, is_difficult) =
            self.calculate_new_status(&plan, passed, new_interval, new_repetitions);

        // 6. 在同一事务中更新复习计划并记录历史
        let update_params = UpdateReviewPlanParams {
            ease_factor: new_ease_factor,
            interval_days: new_interval,
            repetitions: new_repetitions,
            next_review_date: next_review_date.clone(),
            last_review_date: today.clone(),
            status: new_status,
            total_reviews: plan.total_reviews + 1,
            total_correct: if passed {
                plan.total_correct + 1
            } else {
                plan.total_correct
            },
            consecutive_failures,
            is_difficult,
        };

        let history_params = RecordReviewHistoryParams {
            plan_id: plan_id.to_string(),
            question_id: plan.question_id.clone(),
            quality,
            passed,
            ease_factor_before: plan.ease_factor,
            ease_factor_after: new_ease_factor,
            interval_before: plan.interval_days,
            interval_after: new_interval,
            repetitions_before: plan.repetitions,
            repetitions_after: new_repetitions,
            user_answer,
            time_spent_seconds,
        };

        let conn = self.vfs_db.get_conn_safe()
            .map_err(|e| anyhow::anyhow!("Failed to get DB connection: {}", e))?;

        let tx = conn.unchecked_transaction()
            .with_context(|| "Failed to begin transaction for process_review")?;

        let updated_plan = VfsReviewPlanRepo::update_plan_with_conn(&tx, plan_id, &update_params)
            .with_context(|| format!("Failed to update review plan: {}", plan_id))?;

        let history = VfsReviewPlanRepo::record_history_with_conn(&tx, &history_params)
            .with_context(|| format!("Failed to record review history for plan: {}", plan_id))?;

        tx.commit()
            .with_context(|| "Failed to commit process_review transaction")?;

        info!(
            "[ReviewPlanService] Processed review: plan_id={}, quality={}, passed={}, new_interval={}, next_date={}",
            plan_id, quality, passed, new_interval, next_review_date
        );

        Ok(ProcessReviewResult {
            plan: updated_plan,
            passed,
            new_interval,
            next_review_date,
            history,
        })
    }

    /// 计算新状态
    fn calculate_new_status(
        &self,
        plan: &ReviewPlan,
        passed: bool,
        new_interval: u32,
        new_repetitions: u32,
    ) -> (ReviewPlanStatus, u32, bool) {
        let consecutive_failures = if passed {
            0
        } else {
            plan.consecutive_failures + 1
        };

        let is_difficult = consecutive_failures >= self.config.difficult_threshold;

        let new_status = if plan.status == ReviewPlanStatus::Suspended {
            // 暂停状态不自动改变
            ReviewPlanStatus::Suspended
        } else if new_repetitions == 0 {
            // 失败重置到新建
            ReviewPlanStatus::New
        } else if new_repetitions < 2 {
            ReviewPlanStatus::Learning
        } else if new_interval >= self.config.graduation_interval_threshold
            && new_repetitions >= self.config.graduation_repetitions_threshold
        {
            ReviewPlanStatus::Graduated
        } else {
            ReviewPlanStatus::Reviewing
        };

        (new_status, consecutive_failures, is_difficult)
    }

    /// 获取到期复习
    ///
    /// # 参数
    /// * `exam_id` - 题目集 ID（可选，为空查所有）
    /// * `until_date` - 截止日期（可选，默认今天）
    ///
    /// # 返回
    /// * 到期复习列表
    pub fn get_due_reviews(
        &self,
        exam_id: Option<&str>,
        until_date: Option<&str>,
    ) -> Result<DueReviewsResult> {
        let filter = DueReviewsFilter {
            exam_id: exam_id.map(|s| s.to_string()),
            until_date: until_date.map(|s| s.to_string()),
            status: None,
            difficult_only: None,
            limit: Some(100),
            offset: None,
        };

        let result = VfsReviewPlanRepo::list_due_reviews(&self.vfs_db, &filter)
            .with_context(|| "Failed to list due reviews")?;

        debug!(
            "[ReviewPlanService] Got {} due reviews for exam_id={:?}",
            result.plans.len(),
            exam_id
        );

        Ok(result)
    }

    /// 获取到期复习（带完整筛选）
    pub fn get_due_reviews_with_filter(
        &self,
        filter: &DueReviewsFilter,
    ) -> Result<DueReviewsResult> {
        let result = VfsReviewPlanRepo::list_due_reviews(&self.vfs_db, filter)
            .with_context(|| "Failed to list due reviews with filter")?;

        Ok(result)
    }

    /// 获取复习统计
    ///
    /// # 参数
    /// * `exam_id` - 题目集 ID（可选，为空返回全局统计）
    ///
    /// # 返回
    /// * 复习统计
    pub fn get_review_stats(&self, exam_id: Option<&str>) -> Result<ReviewStats> {
        let stats = VfsReviewPlanRepo::get_stats(&self.vfs_db, exam_id)
            .with_context(|| format!("Failed to get review stats for exam_id={:?}", exam_id))?;

        Ok(stats)
    }

    /// 刷新并缓存复习统计
    pub fn refresh_review_stats(&self, exam_id: Option<&str>) -> Result<ReviewStats> {
        let stats = VfsReviewPlanRepo::refresh_stats(&self.vfs_db, exam_id)
            .with_context(|| format!("Failed to refresh review stats for exam_id={:?}", exam_id))?;

        Ok(stats)
    }

    // ========================================================================
    // 批量操作
    // ========================================================================

    /// 批量为题目创建复习计划
    ///
    /// # 参数
    /// * `question_ids` - 题目 ID 列表
    /// * `exam_id` - 题目集 ID
    ///
    /// # 返回
    /// * 批量创建结果
    pub fn batch_create_from_questions(
        &self,
        question_ids: &[String],
        exam_id: &str,
    ) -> Result<BatchCreateResult> {
        let mut created = 0u32;
        let mut skipped = 0u32;
        let mut failed = 0u32;
        let mut plans = Vec::new();

        for question_id in question_ids {
            match self.create_review_plan(question_id, exam_id) {
                Ok(plan) => {
                    created += 1;
                    plans.push(plan);
                }
                Err(e) => {
                    // 检查是否是已存在的错误
                    let error_msg = e.to_string();
                    if error_msg.contains("already exists") || error_msg.contains("AlreadyExists") {
                        skipped += 1;
                        debug!(
                            "[ReviewPlanService] Review plan already exists for question_id={}",
                            question_id
                        );
                    } else {
                        failed += 1;
                        warn!(
                            "[ReviewPlanService] Failed to create review plan for question_id={}: {}",
                            question_id, e
                        );
                    }
                }
            }
        }

        info!(
            "[ReviewPlanService] Batch create result: created={}, skipped={}, failed={}",
            created, skipped, failed
        );

        Ok(BatchCreateResult {
            created,
            skipped,
            failed,
            plans,
        })
    }

    /// 为题目集的所有题目创建复习计划
    ///
    /// # 参数
    /// * `exam_id` - 题目集 ID
    ///
    /// # 返回
    /// * 批量创建结果
    pub fn create_plans_for_exam(&self, exam_id: &str) -> Result<BatchCreateResult> {
        // 获取题目集的所有题目
        let filters = QuestionFilters::default();
        let result = VfsQuestionRepo::list_questions(&self.vfs_db, exam_id, &filters, 1, 1000)
            .with_context(|| format!("Failed to list questions for exam_id={}", exam_id))?;

        let question_ids: Vec<String> = result.questions.iter().map(|q| q.id.clone()).collect();

        if question_ids.is_empty() {
            return Ok(BatchCreateResult {
                created: 0,
                skipped: 0,
                failed: 0,
                plans: Vec::new(),
            });
        }

        self.batch_create_from_questions(&question_ids, exam_id)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 根据题目 ID 获取复习计划
    pub fn get_plan_by_question(&self, question_id: &str) -> Result<Option<ReviewPlan>> {
        let plan = VfsReviewPlanRepo::get_plan_by_question(&self.vfs_db, question_id)
            .with_context(|| {
                format!("Failed to get review plan for question_id={}", question_id)
            })?;

        Ok(plan)
    }

    /// 获取复习计划
    pub fn get_plan(&self, plan_id: &str) -> Result<Option<ReviewPlan>> {
        let plan = VfsReviewPlanRepo::get_plan(&self.vfs_db, plan_id)
            .with_context(|| format!("Failed to get review plan: {}", plan_id))?;

        Ok(plan)
    }

    /// 暂停复习计划
    pub fn suspend_plan(&self, plan_id: &str) -> Result<ReviewPlan> {
        let plan = VfsReviewPlanRepo::suspend_plan(&self.vfs_db, plan_id)
            .with_context(|| format!("Failed to suspend review plan: {}", plan_id))?;

        info!("[ReviewPlanService] Suspended review plan: {}", plan_id);

        Ok(plan)
    }

    /// 恢复复习计划
    pub fn resume_plan(&self, plan_id: &str) -> Result<ReviewPlan> {
        let plan = VfsReviewPlanRepo::resume_plan(&self.vfs_db, plan_id)
            .with_context(|| format!("Failed to resume review plan: {}", plan_id))?;

        info!("[ReviewPlanService] Resumed review plan: {}", plan_id);

        Ok(plan)
    }

    /// 删除复习计划
    pub fn delete_plan(&self, plan_id: &str) -> Result<()> {
        VfsReviewPlanRepo::delete_plan(&self.vfs_db, plan_id)
            .with_context(|| format!("Failed to delete review plan: {}", plan_id))?;

        info!("[ReviewPlanService] Deleted review plan: {}", plan_id);

        Ok(())
    }

    /// 获取复习历史
    pub fn get_review_history(
        &self,
        plan_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<ReviewHistory>> {
        let history = VfsReviewPlanRepo::get_history(&self.vfs_db, plan_id, limit)
            .with_context(|| format!("Failed to get review history for plan: {}", plan_id))?;

        Ok(history)
    }

    /// 列出题目集的所有复习计划
    pub fn list_plans_by_exam(
        &self,
        exam_id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<DueReviewsResult> {
        let result = VfsReviewPlanRepo::list_plans_by_exam(&self.vfs_db, exam_id, limit, offset)
            .with_context(|| format!("Failed to list review plans for exam_id={}", exam_id))?;

        Ok(result)
    }

    /// 检查题目是否有复习计划
    pub fn has_review_plan(&self, question_id: &str) -> Result<bool> {
        let plan = self.get_plan_by_question(question_id)?;
        Ok(plan.is_some())
    }

    /// 获取或创建复习计划
    pub fn get_or_create_plan(&self, question_id: &str, exam_id: &str) -> Result<ReviewPlan> {
        if let Some(plan) = self.get_plan_by_question(question_id)? {
            return Ok(plan);
        }

        self.create_review_plan(question_id, exam_id)
    }

    /// 获取日历热力图数据
    pub fn get_calendar_data(
        &self,
        start_date: Option<&str>,
        end_date: Option<&str>,
        exam_id: Option<&str>,
    ) -> Result<Vec<CalendarHeatmapData>> {
        let data =
            VfsReviewPlanRepo::get_calendar_data(&self.vfs_db, start_date, end_date, exam_id)
                .context("Failed to get calendar data")?;
        Ok(data)
    }
}

// ============================================================================
// Tauri 命令
// ============================================================================

use tauri::State;

/// 创建复习计划
#[tauri::command]
pub async fn review_plan_create(
    question_id: String,
    exam_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ReviewPlan, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .create_review_plan(&question_id, &exam_id)
        .map_err(|e| e.to_string())
}

/// 处理复习结果
#[tauri::command]
pub async fn review_plan_process(
    plan_id: String,
    quality: u8,
    user_answer: Option<String>,
    time_spent_seconds: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ProcessReviewResult, String> {
    if quality > 5 {
        return Err("Quality must be between 0 and 5".to_string());
    }

    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .process_review(&plan_id, quality, user_answer, time_spent_seconds)
        .map_err(|e| e.to_string())
}

/// 获取到期复习
#[tauri::command]
pub async fn review_plan_get_due(
    exam_id: Option<String>,
    until_date: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DueReviewsResult, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .get_due_reviews(exam_id.as_deref(), until_date.as_deref())
        .map_err(|e| e.to_string())
}

/// 获取到期复习（带完整筛选）
#[tauri::command]
pub async fn review_plan_get_due_with_filter(
    filter: DueReviewsFilter,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DueReviewsResult, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .get_due_reviews_with_filter(&filter)
        .map_err(|e| e.to_string())
}

/// 获取复习统计
#[tauri::command]
pub async fn review_plan_get_stats(
    exam_id: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ReviewStats, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .get_review_stats(exam_id.as_deref())
        .map_err(|e| e.to_string())
}

/// 刷新复习统计
#[tauri::command]
pub async fn review_plan_refresh_stats(
    exam_id: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ReviewStats, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .refresh_review_stats(exam_id.as_deref())
        .map_err(|e| e.to_string())
}

/// 根据题目 ID 获取复习计划
#[tauri::command]
pub async fn review_plan_get_by_question(
    question_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<ReviewPlan>, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .get_plan_by_question(&question_id)
        .map_err(|e| e.to_string())
}

/// 获取复习计划
#[tauri::command]
pub async fn review_plan_get(
    plan_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<ReviewPlan>, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service.get_plan(&plan_id).map_err(|e| e.to_string())
}

/// 暂停复习计划
#[tauri::command]
pub async fn review_plan_suspend(
    plan_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ReviewPlan, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service.suspend_plan(&plan_id).map_err(|e| e.to_string())
}

/// 恢复复习计划
#[tauri::command]
pub async fn review_plan_resume(
    plan_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ReviewPlan, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service.resume_plan(&plan_id).map_err(|e| e.to_string())
}

/// 删除复习计划
#[tauri::command]
pub async fn review_plan_delete(
    plan_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service.delete_plan(&plan_id).map_err(|e| e.to_string())
}

/// 获取复习历史
#[tauri::command]
pub async fn review_plan_get_history(
    plan_id: String,
    limit: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<ReviewHistory>, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .get_review_history(&plan_id, limit)
        .map_err(|e| e.to_string())
}

/// 批量为题目创建复习计划
#[tauri::command]
pub async fn review_plan_batch_create(
    question_ids: Vec<String>,
    exam_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<BatchCreateResult, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .batch_create_from_questions(&question_ids, &exam_id)
        .map_err(|e| e.to_string())
}

/// 为题目集的所有题目创建复习计划
#[tauri::command]
pub async fn review_plan_create_for_exam(
    exam_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<BatchCreateResult, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .create_plans_for_exam(&exam_id)
        .map_err(|e| e.to_string())
}

/// 列出题目集的所有复习计划
#[tauri::command]
pub async fn review_plan_list_by_exam(
    exam_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DueReviewsResult, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .list_plans_by_exam(&exam_id, limit, offset)
        .map_err(|e| e.to_string())
}

/// 获取或创建复习计划
#[tauri::command]
pub async fn review_plan_get_or_create(
    question_id: String,
    exam_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ReviewPlan, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .get_or_create_plan(&question_id, &exam_id)
        .map_err(|e| e.to_string())
}

/// 获取日历热力图数据
#[tauri::command]
pub async fn review_plan_get_calendar_data(
    start_date: Option<String>,
    end_date: Option<String>,
    exam_id: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<CalendarHeatmapData>, String> {
    let service = ReviewPlanService::new(vfs_db.inner().clone());
    service
        .get_calendar_data(
            start_date.as_deref(),
            end_date.as_deref(),
            exam_id.as_deref(),
        )
        .map_err(|e| e.to_string())
}
