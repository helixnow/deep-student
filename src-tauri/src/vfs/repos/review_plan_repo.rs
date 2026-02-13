//! VFS 复习计划表 CRUD 操作
//!
//! 复习计划实体管理，基于 SM-2 算法实现间隔重复。
//!
//! ## 核心方法
//! - `create_plan`: 创建复习计划
//! - `get_plan`: 获取复习计划
//! - `get_plan_by_question`: 根据题目 ID 获取复习计划
//! - `update_plan`: 更新复习计划
//! - `delete_plan`: 删除复习计划
//! - `list_due_reviews`: 列出到期复习
//! - `get_stats`: 获取复习统计

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::ReviewPlanRepo] Row parse error (skipped): {}", e);
            None
        }
    }
}

// ============================================================================
// 数据类型定义
// ============================================================================

/// 复习计划状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPlanStatus {
    /// 新建，从未复习
    #[default]
    New,
    /// 学习中（repetitions < 2）
    Learning,
    /// 复习中（repetitions >= 2）
    Reviewing,
    /// 已毕业（间隔超过 21 天且连续正确 >= 3 次）
    Graduated,
    /// 暂停复习
    Suspended,
}

impl ReviewPlanStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReviewPlanStatus::New => "new",
            ReviewPlanStatus::Learning => "learning",
            ReviewPlanStatus::Reviewing => "reviewing",
            ReviewPlanStatus::Graduated => "graduated",
            ReviewPlanStatus::Suspended => "suspended",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "new" => ReviewPlanStatus::New,
            "learning" => ReviewPlanStatus::Learning,
            "reviewing" => ReviewPlanStatus::Reviewing,
            "graduated" => ReviewPlanStatus::Graduated,
            "suspended" => ReviewPlanStatus::Suspended,
            _ => ReviewPlanStatus::New,
        }
    }
}

/// 复习计划实体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewPlan {
    pub id: String,
    pub question_id: String,
    pub exam_id: String,
    pub ease_factor: f64,
    pub interval_days: u32,
    pub repetitions: u32,
    pub next_review_date: String,
    pub last_review_date: Option<String>,
    pub status: ReviewPlanStatus,
    pub total_reviews: u32,
    pub total_correct: u32,
    pub consecutive_failures: u32,
    pub is_difficult: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 复习历史记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewHistory {
    pub id: String,
    pub plan_id: String,
    pub question_id: String,
    pub quality: u8,
    pub passed: bool,
    pub ease_factor_before: f64,
    pub ease_factor_after: f64,
    pub interval_before: u32,
    pub interval_after: u32,
    pub repetitions_before: u32,
    pub repetitions_after: u32,
    pub reviewed_at: String,
    pub user_answer: Option<String>,
    pub time_spent_seconds: Option<u32>,
}

/// 创建复习计划参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateReviewPlanParams {
    pub question_id: String,
    pub exam_id: String,
    /// 初始易度因子（可选，默认 2.5）
    pub initial_ease_factor: Option<f64>,
}

/// 更新复习计划参数（由 SM-2 算法计算后调用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateReviewPlanParams {
    pub ease_factor: f64,
    pub interval_days: u32,
    pub repetitions: u32,
    pub next_review_date: String,
    pub last_review_date: String,
    pub status: ReviewPlanStatus,
    pub total_reviews: u32,
    pub total_correct: u32,
    pub consecutive_failures: u32,
    pub is_difficult: bool,
}

/// 日历热力图数据（按日期聚合的复习统计）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarHeatmapData {
    pub date: String,
    pub count: u32,
    pub passed: u32,
    pub failed: u32,
}

/// 记录复习历史参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordReviewHistoryParams {
    pub plan_id: String,
    pub question_id: String,
    pub quality: u8,
    pub passed: bool,
    pub ease_factor_before: f64,
    pub ease_factor_after: f64,
    pub interval_before: u32,
    pub interval_after: u32,
    pub repetitions_before: u32,
    pub repetitions_after: u32,
    pub user_answer: Option<String>,
    pub time_spent_seconds: Option<u32>,
}

/// 到期复习筛选参数
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DueReviewsFilter {
    /// 题目集 ID（可选，为空则查所有）
    pub exam_id: Option<String>,
    /// 截止日期（包含，默认今天）
    pub until_date: Option<String>,
    /// 状态筛选（可选）
    pub status: Option<Vec<ReviewPlanStatus>>,
    /// 是否只查困难题
    pub difficult_only: Option<bool>,
    /// 分页
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// 到期复习列表结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DueReviewsResult {
    pub plans: Vec<ReviewPlan>,
    pub total: i64,
    pub has_more: bool,
}

/// 复习统计
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewStats {
    pub exam_id: Option<String>,
    pub total_plans: u32,
    pub new_count: u32,
    pub learning_count: u32,
    pub reviewing_count: u32,
    pub graduated_count: u32,
    pub suspended_count: u32,
    pub due_today: u32,
    pub overdue_count: u32,
    pub difficult_count: u32,
    pub total_reviews: u32,
    pub total_correct: u32,
    pub avg_correct_rate: f64,
    pub avg_ease_factor: f64,
    pub updated_at: String,
}

// ============================================================================
// VFS 复习计划表 Repo
// ============================================================================

/// VFS 复习计划表 Repo
pub struct VfsReviewPlanRepo;

impl VfsReviewPlanRepo {
    // ========================================================================
    // 创建
    // ========================================================================

    /// 创建复习计划
    pub fn create_plan(db: &VfsDatabase, params: &CreateReviewPlanParams) -> VfsResult<ReviewPlan> {
        let conn = db.get_conn_safe()?;
        Self::create_plan_with_conn(&conn, params)
    }

    /// 创建复习计划（使用现有连接）
    pub fn create_plan_with_conn(
        conn: &Connection,
        params: &CreateReviewPlanParams,
    ) -> VfsResult<ReviewPlan> {
        // 检查是否已存在
        if Self::get_plan_by_question_with_conn(conn, &params.question_id)?.is_some() {
            return Err(VfsError::AlreadyExists {
                resource_type: "review_plan".to_string(),
                id: params.question_id.clone(),
            });
        }

        let id = format!("rp_{}", nanoid::nanoid!(10));
        let now = chrono::Utc::now().to_rfc3339();
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let ease_factor = params
            .initial_ease_factor
            .unwrap_or(crate::spaced_repetition::DEFAULT_EASE_FACTOR);

        conn.execute(
            r#"
            INSERT INTO review_plans (
                id, question_id, exam_id, ease_factor, interval_days, repetitions,
                next_review_date, last_review_date, status, total_reviews, total_correct,
                consecutive_failures, is_difficult, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, 0, 0, ?5, NULL, 'new', 0, 0, 0, 0, ?6, ?6
            )
            "#,
            params![
                id,
                params.question_id,
                params.exam_id,
                ease_factor,
                today,
                now,
            ],
        )?;

        info!(
            "[VFS::ReviewPlanRepo] Created review plan id={} for question_id={}",
            id, params.question_id
        );

        Self::get_plan_with_conn(conn, &id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "review_plan".to_string(),
            id: id.clone(),
        })
    }

    // ========================================================================
    // 查询
    // ========================================================================

    /// 根据 ID 获取复习计划
    pub fn get_plan(db: &VfsDatabase, plan_id: &str) -> VfsResult<Option<ReviewPlan>> {
        let conn = db.get_conn_safe()?;
        Self::get_plan_with_conn(&conn, plan_id)
    }

    /// 根据 ID 获取复习计划（使用现有连接）
    pub fn get_plan_with_conn(conn: &Connection, plan_id: &str) -> VfsResult<Option<ReviewPlan>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, question_id, exam_id, ease_factor, interval_days, repetitions,
                   next_review_date, last_review_date, status, total_reviews, total_correct,
                   consecutive_failures, is_difficult, created_at, updated_at
            FROM review_plans
            WHERE id = ?1
            "#,
        )?;

        let plan = stmt
            .query_row(params![plan_id], Self::row_to_plan)
            .optional()?;

        Ok(plan)
    }

    /// 根据题目 ID 获取复习计划
    pub fn get_plan_by_question(
        db: &VfsDatabase,
        question_id: &str,
    ) -> VfsResult<Option<ReviewPlan>> {
        let conn = db.get_conn_safe()?;
        Self::get_plan_by_question_with_conn(&conn, question_id)
    }

    /// 根据题目 ID 获取复习计划（使用现有连接）
    pub fn get_plan_by_question_with_conn(
        conn: &Connection,
        question_id: &str,
    ) -> VfsResult<Option<ReviewPlan>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, question_id, exam_id, ease_factor, interval_days, repetitions,
                   next_review_date, last_review_date, status, total_reviews, total_correct,
                   consecutive_failures, is_difficult, created_at, updated_at
            FROM review_plans
            WHERE question_id = ?1
            "#,
        )?;

        let plan = stmt
            .query_row(params![question_id], Self::row_to_plan)
            .optional()?;

        Ok(plan)
    }

    /// 列出到期复习
    pub fn list_due_reviews(
        db: &VfsDatabase,
        filter: &DueReviewsFilter,
    ) -> VfsResult<DueReviewsResult> {
        let conn = db.get_conn_safe()?;
        Self::list_due_reviews_with_conn(&conn, filter)
    }

    /// 列出到期复习（使用现有连接）
    pub fn list_due_reviews_with_conn(
        conn: &Connection,
        filter: &DueReviewsFilter,
    ) -> VfsResult<DueReviewsResult> {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let until_date = filter.until_date.as_deref().unwrap_or(&today);
        let limit = filter.limit.unwrap_or(50);
        let offset = filter.offset.unwrap_or(0);

        // 构建 WHERE 子句
        let mut conditions = vec!["next_review_date <= ?1".to_string()];
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(until_date.to_string())];
        let mut param_idx = 2;

        // 排除暂停状态
        conditions.push("status != 'suspended'".to_string());

        // 题目集筛选
        if let Some(exam_id) = &filter.exam_id {
            conditions.push(format!("exam_id = ?{}", param_idx));
            params_vec.push(Box::new(exam_id.clone()));
            param_idx += 1;
        }

        // 状态筛选
        if let Some(statuses) = &filter.status {
            if !statuses.is_empty() {
                let placeholders: Vec<String> = statuses
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("status IN ({})", placeholders.join(", ")));
                for s in statuses {
                    params_vec.push(Box::new(s.as_str().to_string()));
                }
                param_idx += statuses.len();
            }
        }

        // 困难题筛选
        if filter.difficult_only == Some(true) {
            conditions.push("is_difficult = 1".to_string());
        }

        let where_clause = conditions.join(" AND ");

        // 查询总数
        let count_sql = format!("SELECT COUNT(*) FROM review_plans WHERE {}", where_clause);
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let total: i64 = conn.query_row(&count_sql, params_refs.as_slice(), |row| row.get(0))?;

        // 查询数据
        let query_sql = format!(
            r#"
            SELECT id, question_id, exam_id, ease_factor, interval_days, repetitions,
                   next_review_date, last_review_date, status, total_reviews, total_correct,
                   consecutive_failures, is_difficult, created_at, updated_at
            FROM review_plans
            WHERE {}
            ORDER BY next_review_date ASC, is_difficult DESC, consecutive_failures DESC
            LIMIT ?{} OFFSET ?{}
            "#,
            where_clause,
            param_idx,
            param_idx + 1
        );

        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&query_sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_plan)?;

        let plans: Vec<ReviewPlan> = rows.filter_map(log_and_skip_err).collect();
        let has_more = (offset + limit) < total as u32;

        debug!(
            "[VFS::ReviewPlanRepo] Listed {} due reviews, total={}",
            plans.len(),
            total
        );

        Ok(DueReviewsResult {
            plans,
            total,
            has_more,
        })
    }

    /// 列出题目集的所有复习计划
    pub fn list_plans_by_exam(
        db: &VfsDatabase,
        exam_id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> VfsResult<DueReviewsResult> {
        let conn = db.get_conn_safe()?;
        Self::list_plans_by_exam_with_conn(&conn, exam_id, limit, offset)
    }

    /// 列出题目集的所有复习计划（使用现有连接）
    pub fn list_plans_by_exam_with_conn(
        conn: &Connection,
        exam_id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> VfsResult<DueReviewsResult> {
        let limit = limit.unwrap_or(100);
        let offset = offset.unwrap_or(0);

        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM review_plans WHERE exam_id = ?1",
            params![exam_id],
            |row| row.get(0),
        )?;

        let mut stmt = conn.prepare(
            r#"
            SELECT id, question_id, exam_id, ease_factor, interval_days, repetitions,
                   next_review_date, last_review_date, status, total_reviews, total_correct,
                   consecutive_failures, is_difficult, created_at, updated_at
            FROM review_plans
            WHERE exam_id = ?1
            ORDER BY next_review_date ASC
            LIMIT ?2 OFFSET ?3
            "#,
        )?;

        let rows = stmt.query_map(params![exam_id, limit, offset], Self::row_to_plan)?;
        let plans: Vec<ReviewPlan> = rows.filter_map(log_and_skip_err).collect();
        let has_more = (offset + limit) < total as u32;

        Ok(DueReviewsResult {
            plans,
            total,
            has_more,
        })
    }

    // ========================================================================
    // 更新
    // ========================================================================

    /// 更新复习计划
    pub fn update_plan(
        db: &VfsDatabase,
        plan_id: &str,
        params: &UpdateReviewPlanParams,
    ) -> VfsResult<ReviewPlan> {
        let conn = db.get_conn_safe()?;
        Self::update_plan_with_conn(&conn, plan_id, params)
    }

    /// 更新复习计划（使用现有连接）
    pub fn update_plan_with_conn(
        conn: &Connection,
        plan_id: &str,
        params: &UpdateReviewPlanParams,
    ) -> VfsResult<ReviewPlan> {
        let now = chrono::Utc::now().to_rfc3339();

        let affected = conn.execute(
            r#"
            UPDATE review_plans SET
                ease_factor = ?1,
                interval_days = ?2,
                repetitions = ?3,
                next_review_date = ?4,
                last_review_date = ?5,
                status = ?6,
                total_reviews = ?7,
                total_correct = ?8,
                consecutive_failures = ?9,
                is_difficult = ?10,
                updated_at = ?11
            WHERE id = ?12
            "#,
            params![
                params.ease_factor,
                params.interval_days,
                params.repetitions,
                params.next_review_date,
                params.last_review_date,
                params.status.as_str(),
                params.total_reviews,
                params.total_correct,
                params.consecutive_failures,
                if params.is_difficult { 1 } else { 0 },
                now,
                plan_id,
            ],
        )?;

        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "review_plan".to_string(),
                id: plan_id.to_string(),
            });
        }

        debug!("[VFS::ReviewPlanRepo] Updated review plan id={}", plan_id);

        Self::get_plan_with_conn(conn, plan_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "review_plan".to_string(),
            id: plan_id.to_string(),
        })
    }

    /// 暂停复习计划
    pub fn suspend_plan(db: &VfsDatabase, plan_id: &str) -> VfsResult<ReviewPlan> {
        let conn = db.get_conn_safe()?;
        Self::suspend_plan_with_conn(&conn, plan_id)
    }

    /// 暂停复习计划（使用现有连接）
    pub fn suspend_plan_with_conn(conn: &Connection, plan_id: &str) -> VfsResult<ReviewPlan> {
        let now = chrono::Utc::now().to_rfc3339();

        let affected = conn.execute(
            "UPDATE review_plans SET status = 'suspended', updated_at = ?1 WHERE id = ?2",
            params![now, plan_id],
        )?;

        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "review_plan".to_string(),
                id: plan_id.to_string(),
            });
        }

        info!("[VFS::ReviewPlanRepo] Suspended review plan id={}", plan_id);

        Self::get_plan_with_conn(conn, plan_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "review_plan".to_string(),
            id: plan_id.to_string(),
        })
    }

    /// 恢复复习计划
    pub fn resume_plan(db: &VfsDatabase, plan_id: &str) -> VfsResult<ReviewPlan> {
        let conn = db.get_conn_safe()?;
        Self::resume_plan_with_conn(&conn, plan_id)
    }

    /// 恢复复习计划（使用现有连接）
    pub fn resume_plan_with_conn(conn: &Connection, plan_id: &str) -> VfsResult<ReviewPlan> {
        let now = chrono::Utc::now().to_rfc3339();
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

        // 获取当前状态以确定恢复后的状态
        let plan = Self::get_plan_with_conn(conn, plan_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "review_plan".to_string(),
            id: plan_id.to_string(),
        })?;

        // 根据 repetitions 确定恢复后的状态
        let new_status = if plan.repetitions == 0 {
            "new"
        } else if plan.repetitions < 2 {
            "learning"
        } else if plan.interval_days >= 21 && plan.repetitions >= 3 {
            "graduated"
        } else {
            "reviewing"
        };

        conn.execute(
            "UPDATE review_plans SET status = ?1, next_review_date = ?2, updated_at = ?3 WHERE id = ?4",
            params![new_status, today, now, plan_id],
        )?;

        info!(
            "[VFS::ReviewPlanRepo] Resumed review plan id={} with status={}",
            plan_id, new_status
        );

        Self::get_plan_with_conn(conn, plan_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "review_plan".to_string(),
            id: plan_id.to_string(),
        })
    }

    // ========================================================================
    // 删除
    // ========================================================================

    /// 删除复习计划
    pub fn delete_plan(db: &VfsDatabase, plan_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_plan_with_conn(&conn, plan_id)
    }

    /// 删除复习计划（使用现有连接）
    pub fn delete_plan_with_conn(conn: &Connection, plan_id: &str) -> VfsResult<()> {
        let affected = conn.execute("DELETE FROM review_plans WHERE id = ?1", params![plan_id])?;

        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "review_plan".to_string(),
                id: plan_id.to_string(),
            });
        }

        info!("[VFS::ReviewPlanRepo] Deleted review plan id={}", plan_id);
        Ok(())
    }

    /// 根据题目 ID 删除复习计划
    pub fn delete_plan_by_question(db: &VfsDatabase, question_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_plan_by_question_with_conn(&conn, question_id)
    }

    /// 根据题目 ID 删除复习计划（使用现有连接）
    pub fn delete_plan_by_question_with_conn(
        conn: &Connection,
        question_id: &str,
    ) -> VfsResult<()> {
        conn.execute(
            "DELETE FROM review_plans WHERE question_id = ?1",
            params![question_id],
        )?;

        debug!(
            "[VFS::ReviewPlanRepo] Deleted review plan for question_id={}",
            question_id
        );
        Ok(())
    }

    // ========================================================================
    // 历史记录
    // ========================================================================

    /// 记录复习历史
    pub fn record_history(
        db: &VfsDatabase,
        params: &RecordReviewHistoryParams,
    ) -> VfsResult<ReviewHistory> {
        let conn = db.get_conn_safe()?;
        Self::record_history_with_conn(&conn, params)
    }

    /// 记录复习历史（使用现有连接）
    pub fn record_history_with_conn(
        conn: &Connection,
        params: &RecordReviewHistoryParams,
    ) -> VfsResult<ReviewHistory> {
        let id = format!("rh_{}", nanoid::nanoid!(10));
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            r#"
            INSERT INTO review_history (
                id, plan_id, question_id, quality, passed,
                ease_factor_before, ease_factor_after, interval_before, interval_after,
                repetitions_before, repetitions_after, reviewed_at, user_answer, time_spent_seconds
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
            )
            "#,
            params![
                id,
                params.plan_id,
                params.question_id,
                params.quality,
                if params.passed { 1 } else { 0 },
                params.ease_factor_before,
                params.ease_factor_after,
                params.interval_before,
                params.interval_after,
                params.repetitions_before,
                params.repetitions_after,
                now,
                params.user_answer,
                params.time_spent_seconds,
            ],
        )?;

        debug!(
            "[VFS::ReviewPlanRepo] Recorded review history id={} for plan_id={}",
            id, params.plan_id
        );

        Ok(ReviewHistory {
            id,
            plan_id: params.plan_id.clone(),
            question_id: params.question_id.clone(),
            quality: params.quality,
            passed: params.passed,
            ease_factor_before: params.ease_factor_before,
            ease_factor_after: params.ease_factor_after,
            interval_before: params.interval_before,
            interval_after: params.interval_after,
            repetitions_before: params.repetitions_before,
            repetitions_after: params.repetitions_after,
            reviewed_at: now,
            user_answer: params.user_answer.clone(),
            time_spent_seconds: params.time_spent_seconds,
        })
    }

    /// 获取复习历史
    pub fn get_history(
        db: &VfsDatabase,
        plan_id: &str,
        limit: Option<u32>,
    ) -> VfsResult<Vec<ReviewHistory>> {
        let conn = db.get_conn_safe()?;
        Self::get_history_with_conn(&conn, plan_id, limit)
    }

    /// 获取复习历史（使用现有连接）
    pub fn get_history_with_conn(
        conn: &Connection,
        plan_id: &str,
        limit: Option<u32>,
    ) -> VfsResult<Vec<ReviewHistory>> {
        let limit_val = limit.unwrap_or(100);

        let mut stmt = conn.prepare(
            r#"
            SELECT id, plan_id, question_id, quality, passed,
                   ease_factor_before, ease_factor_after, interval_before, interval_after,
                   repetitions_before, repetitions_after, reviewed_at, user_answer, time_spent_seconds
            FROM review_history
            WHERE plan_id = ?1
            ORDER BY reviewed_at DESC
            LIMIT ?2
            "#,
        )?;

        let rows = stmt.query_map(params![plan_id, limit_val], |row| {
            Ok(ReviewHistory {
                id: row.get(0)?,
                plan_id: row.get(1)?,
                question_id: row.get(2)?,
                quality: row.get(3)?,
                passed: row.get::<_, i32>(4)? != 0,
                ease_factor_before: row.get(5)?,
                ease_factor_after: row.get(6)?,
                interval_before: row.get(7)?,
                interval_after: row.get(8)?,
                repetitions_before: row.get(9)?,
                repetitions_after: row.get(10)?,
                reviewed_at: row.get(11)?,
                user_answer: row.get(12)?,
                time_spent_seconds: row.get(13)?,
            })
        })?;

        let history: Vec<ReviewHistory> = rows.filter_map(log_and_skip_err).collect();
        Ok(history)
    }

    // ========================================================================
    // 统计
    // ========================================================================

    /// 获取复习统计
    pub fn get_stats(db: &VfsDatabase, exam_id: Option<&str>) -> VfsResult<ReviewStats> {
        let conn = db.get_conn_safe()?;
        Self::get_stats_with_conn(&conn, exam_id)
    }

    /// 获取复习统计（使用现有连接）
    pub fn get_stats_with_conn(conn: &Connection, exam_id: Option<&str>) -> VfsResult<ReviewStats> {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let (where_clause, exam_id_param): (String, Option<String>) = if let Some(eid) = exam_id {
            ("WHERE exam_id = ?1".to_string(), Some(eid.to_string()))
        } else {
            (String::new(), None)
        };

        let stats_sql = format!(
            r#"
            SELECT
                COUNT(*) as total_plans,
                SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
                SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END) as learning_count,
                SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) as reviewing_count,
                SUM(CASE WHEN status = 'graduated' THEN 1 ELSE 0 END) as graduated_count,
                SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended_count,
                SUM(CASE WHEN next_review_date <= ?2 AND status != 'suspended' THEN 1 ELSE 0 END) as due_today,
                SUM(CASE WHEN next_review_date < ?2 AND status != 'suspended' THEN 1 ELSE 0 END) as overdue_count,
                SUM(CASE WHEN is_difficult = 1 THEN 1 ELSE 0 END) as difficult_count,
                SUM(total_reviews) as total_reviews,
                SUM(total_correct) as total_correct,
                AVG(ease_factor) as avg_ease_factor
            FROM review_plans
            {}
            "#,
            where_clause
        );

        let stats: (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, f64) =
            if let Some(eid) = &exam_id_param {
                conn.query_row(&stats_sql, params![eid, today], |row| {
                    Ok((
                        row.get(0)?,
                        row.get::<_, i64>(1).unwrap_or(0),
                        row.get::<_, i64>(2).unwrap_or(0),
                        row.get::<_, i64>(3).unwrap_or(0),
                        row.get::<_, i64>(4).unwrap_or(0),
                        row.get::<_, i64>(5).unwrap_or(0),
                        row.get::<_, i64>(6).unwrap_or(0),
                        row.get::<_, i64>(7).unwrap_or(0),
                        row.get::<_, i64>(8).unwrap_or(0),
                        row.get::<_, i64>(9).unwrap_or(0),
                        row.get::<_, i64>(10).unwrap_or(0),
                        row.get::<_, f64>(11).unwrap_or(2.5),
                    ))
                })?
            } else {
                conn.query_row(
                    &stats_sql
                        .replace("?1", "NULL")
                        .replace("WHERE exam_id = NULL", ""),
                    params![today],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get::<_, i64>(1).unwrap_or(0),
                            row.get::<_, i64>(2).unwrap_or(0),
                            row.get::<_, i64>(3).unwrap_or(0),
                            row.get::<_, i64>(4).unwrap_or(0),
                            row.get::<_, i64>(5).unwrap_or(0),
                            row.get::<_, i64>(6).unwrap_or(0),
                            row.get::<_, i64>(7).unwrap_or(0),
                            row.get::<_, i64>(8).unwrap_or(0),
                            row.get::<_, i64>(9).unwrap_or(0),
                            row.get::<_, i64>(10).unwrap_or(0),
                            row.get::<_, f64>(11).unwrap_or(2.5),
                        ))
                    },
                )?
            };

        let avg_correct_rate = if stats.9 > 0 {
            stats.10 as f64 / stats.9 as f64
        } else {
            0.0
        };

        Ok(ReviewStats {
            exam_id: exam_id.map(|s| s.to_string()),
            total_plans: stats.0 as u32,
            new_count: stats.1 as u32,
            learning_count: stats.2 as u32,
            reviewing_count: stats.3 as u32,
            graduated_count: stats.4 as u32,
            suspended_count: stats.5 as u32,
            due_today: stats.6 as u32,
            overdue_count: stats.7 as u32,
            difficult_count: stats.8 as u32,
            total_reviews: stats.9 as u32,
            total_correct: stats.10 as u32,
            avg_correct_rate,
            avg_ease_factor: stats.11,
            updated_at: now,
        })
    }

    /// 刷新并缓存统计（Upsert 到 review_stats 表）
    pub fn refresh_stats(db: &VfsDatabase, exam_id: Option<&str>) -> VfsResult<ReviewStats> {
        let conn = db.get_conn_safe()?;
        Self::refresh_stats_with_conn(&conn, exam_id)
    }

    /// 刷新并缓存统计（使用现有连接）
    pub fn refresh_stats_with_conn(
        conn: &Connection,
        exam_id: Option<&str>,
    ) -> VfsResult<ReviewStats> {
        let stats = Self::get_stats_with_conn(conn, exam_id)?;

        // Upsert 到 review_stats 表
        conn.execute(
            r#"
            INSERT INTO review_stats (
                exam_id, total_plans, new_count, learning_count, reviewing_count,
                graduated_count, suspended_count, due_today, overdue_count, difficult_count,
                total_reviews, total_correct, avg_correct_rate, avg_ease_factor, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(exam_id) DO UPDATE SET
                total_plans = excluded.total_plans,
                new_count = excluded.new_count,
                learning_count = excluded.learning_count,
                reviewing_count = excluded.reviewing_count,
                graduated_count = excluded.graduated_count,
                suspended_count = excluded.suspended_count,
                due_today = excluded.due_today,
                overdue_count = excluded.overdue_count,
                difficult_count = excluded.difficult_count,
                total_reviews = excluded.total_reviews,
                total_correct = excluded.total_correct,
                avg_correct_rate = excluded.avg_correct_rate,
                avg_ease_factor = excluded.avg_ease_factor,
                updated_at = excluded.updated_at
            "#,
            params![
                stats.exam_id,
                stats.total_plans,
                stats.new_count,
                stats.learning_count,
                stats.reviewing_count,
                stats.graduated_count,
                stats.suspended_count,
                stats.due_today,
                stats.overdue_count,
                stats.difficult_count,
                stats.total_reviews,
                stats.total_correct,
                stats.avg_correct_rate,
                stats.avg_ease_factor,
                stats.updated_at,
            ],
        )?;

        debug!(
            "[VFS::ReviewPlanRepo] Refreshed stats for exam_id={:?}",
            exam_id
        );

        Ok(stats)
    }

    // ========================================================================
    // 日历热力图数据
    // ========================================================================

    /// 获取日历热力图数据：按日期聚合复习历史
    pub fn get_calendar_data(
        db: &VfsDatabase,
        start_date: Option<&str>,
        end_date: Option<&str>,
        exam_id: Option<&str>,
    ) -> VfsResult<Vec<CalendarHeatmapData>> {
        let conn = db.get_conn_safe()?;
        Self::get_calendar_data_with_conn(&conn, start_date, end_date, exam_id)
    }

    /// 获取日历热力图数据（使用现有连接）
    pub fn get_calendar_data_with_conn(
        conn: &Connection,
        start_date: Option<&str>,
        end_date: Option<&str>,
        exam_id: Option<&str>,
    ) -> VfsResult<Vec<CalendarHeatmapData>> {
        let mut conditions: Vec<String> = Vec::new();
        let mut param_values: Vec<String> = Vec::new();

        if let Some(sd) = start_date {
            param_values.push(sd.to_string());
            conditions.push(format!("DATE(rh.reviewed_at) >= ?{}", param_values.len()));
        }
        if let Some(ed) = end_date {
            param_values.push(ed.to_string());
            conditions.push(format!("DATE(rh.reviewed_at) <= ?{}", param_values.len()));
        }
        if let Some(eid) = exam_id {
            param_values.push(eid.to_string());
            conditions.push(format!("rp.exam_id = ?{}", param_values.len()));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        // Join with review_plans to support exam_id filtering
        let sql = format!(
            r#"
            SELECT
                DATE(rh.reviewed_at) as review_date,
                COUNT(*) as total_count,
                SUM(CASE WHEN rh.passed = 1 THEN 1 ELSE 0 END) as passed_count,
                SUM(CASE WHEN rh.passed = 0 THEN 1 ELSE 0 END) as failed_count
            FROM review_history rh
            INNER JOIN review_plans rp ON rh.plan_id = rp.id
            {}
            GROUP BY DATE(rh.reviewed_at)
            ORDER BY review_date ASC
            "#,
            where_clause
        );

        let param_refs: Vec<&dyn rusqlite::ToSql> = param_values
            .iter()
            .map(|p| p as &dyn rusqlite::ToSql)
            .collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            Ok(CalendarHeatmapData {
                date: row.get(0)?,
                count: row.get::<_, i64>(1)? as u32,
                passed: row.get::<_, i64>(2).unwrap_or(0) as u32,
                failed: row.get::<_, i64>(3).unwrap_or(0) as u32,
            })
        })?;

        let data: Vec<CalendarHeatmapData> = rows.filter_map(log_and_skip_err).collect();

        debug!(
            "[VFS::ReviewPlanRepo] get_calendar_data: {} entries (start={:?}, end={:?}, exam={:?})",
            data.len(),
            start_date,
            end_date,
            exam_id
        );

        Ok(data)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 行转换为 ReviewPlan
    fn row_to_plan(row: &Row) -> rusqlite::Result<ReviewPlan> {
        let status_str: String = row.get(8)?;
        let is_difficult: i32 = row.get(12)?;

        Ok(ReviewPlan {
            id: row.get(0)?,
            question_id: row.get(1)?,
            exam_id: row.get(2)?,
            ease_factor: row.get(3)?,
            interval_days: row.get(4)?,
            repetitions: row.get(5)?,
            next_review_date: row.get(6)?,
            last_review_date: row.get(7)?,
            status: ReviewPlanStatus::from_str(&status_str),
            total_reviews: row.get(9)?,
            total_correct: row.get(10)?,
            consecutive_failures: row.get(11)?,
            is_difficult: is_difficult != 0,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
        })
    }
}
