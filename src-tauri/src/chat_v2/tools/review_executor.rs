//! 间隔重复复习计划工具执行器（review_* 工具组）
//!
//! 将 `spaced_repetition`（SM-2 算法）与 `review_plan_service`（复习计划服务）
//! 暴露给 agent，是 "批改/刷题 → 错题入库 → 安排复习" 杀手级链路的最后一环。
//!
//! ## 工具列表
//! - `review_get_due`: 查询今日/指定日期前到期的复习项（含题目内容预览）
//! - `review_schedule`: 为指定题目（question_id / card_id）批量创建复习计划
//! - `review_plan_generate`: 为整个题目集一键生成复习计划（阶段复习计划）
//! - `review_submit`: 提交一次复习结果（0-5 质量评分），由 SM-2 算法计算下次复习时间
//! - `review_stats`: 复习统计概览（各状态数量、到期/逾期、正确率、可选日历热力图）
//! - `review_suspend`: 暂停单个复习计划
//! - `review_resume`: 恢复单个复习计划
//! - `review_delete`: 永久删除单个复习计划
//!
//! ## 与既有服务的对接
//! - 全部业务逻辑走 `crate::review_plan_service::ReviewPlanService`（基于 ctx.vfs_db 构造），
//!   不重复实现 SM-2 计算；
//! - card_id → question_id 的映射复用 `ctx.question_bank_service`（与 qbank_* 工具同源）。
//!
//! ## 敏感度
//! - 读（get_due / stats）: Low
//! - 提交复习结果（review_submit）: Low（用户练习主动作，与 qbank_submit_answer 对齐）
//! - 写计划（review_schedule / review_plan_generate / review_suspend / review_resume）: Medium
//! - 永久删除（review_delete）: High
//!
//! ## 事件发射（强制，见 tools/mod.rs 头注释）
//! - 开始: `ctx.emit_tool_call_start`
//! - 成功: `ctx.emit_tool_call_end`
//! - 失败: `ctx.emit_tool_call_error`

use std::time::Instant;

use async_trait::async_trait;
use chrono::NaiveDate;
use serde_json::{json, Value};
use tauri::Emitter;

use super::arg_utils::{get_string_array_arg, with_localized_message};
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::review_plan_service::ReviewPlanService;
use crate::vfs::repos::question_repo::VfsQuestionRepo;
use crate::vfs::repos::review_plan_repo::{DueReviewsFilter, ReviewPlan, ReviewPlanStatus};

/// 到期查询单页上限
const MAX_DUE_LIMIT: u32 = 100;

/// 批量安排复习计划的单次题目数上限
const MAX_SCHEDULE_BATCH: usize = 500;

pub struct ReviewToolExecutor;

impl ReviewToolExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 基于 ctx.vfs_db 构造复习计划服务
    fn service(ctx: &ExecutionContext) -> Result<ReviewPlanService, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        Ok(ReviewPlanService::new(vfs_db.clone()))
    }

    /// 校验 YYYY-MM-DD 日期格式
    fn validate_date(value: &str, field: &str) -> Result<(), String> {
        let bytes = value.as_bytes();
        let has_exact_shape = bytes.len() == 10
            && bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit());

        if !has_exact_shape {
            return Err(format!(
                "参数 '{}' 日期格式无效: {}（应为 YYYY-MM-DD）",
                field, value
            ));
        }

        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map(|_| ())
            .map_err(|_| {
                format!(
                    "参数 '{}' 日期格式无效: {}（应为 YYYY-MM-DD）",
                    field, value
                )
            })
    }

    fn plan_state_to_json(plan: &ReviewPlan) -> Value {
        json!({
            "plan_id": plan.id,
            "question_id": plan.question_id,
            "exam_id": plan.exam_id,
            "status": plan.status.as_str(),
            "next_review_date": plan.next_review_date,
            "last_review_date": plan.last_review_date,
            "interval_days": plan.interval_days,
            "repetitions": plan.repetitions,
            "ease_factor": plan.ease_factor,
            "total_reviews": plan.total_reviews,
            "total_correct": plan.total_correct,
            "is_difficult": plan.is_difficult,
            // Agent mutations must use this exact revision as expected_updated_at.
            "updatedAt": plan.updated_at,
        })
    }

    /// 复习计划 → JSON（附题目内容预览，便于 agent 直接组织复习）
    fn plan_to_json(plan: &ReviewPlan, ctx: &ExecutionContext, with_question: bool) -> Value {
        let mut item = Self::plan_state_to_json(plan);

        if with_question {
            if let Some(vfs_db) = ctx.vfs_db.as_ref() {
                if let Ok(Some(q)) = VfsQuestionRepo::get_question(vfs_db, &plan.question_id) {
                    item["question"] = json!({
                        "card_id": q.card_id.clone().unwrap_or_else(|| q.id.clone()),
                        "label": q.question_label,
                        "content_preview": q.content.chars().take(120).collect::<String>(),
                        "question_type": q.question_type,
                        "tags": q.tags,
                    });
                }
            }
        }

        item
    }

    /// 解析 status 参数（字符串数组 → ReviewPlanStatus 数组）
    fn parse_status_filter(args: &Value) -> Option<Vec<ReviewPlanStatus>> {
        get_string_array_arg(args, "status")
            .map(|list| list.iter().map(|s| ReviewPlanStatus::from_str(s)).collect())
    }

    fn required_plan_id(args: &Value) -> Result<&str, String> {
        args.get("plan_id")
            .or_else(|| args.get("planId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Missing required parameter: plan_id (from review_get_due)".to_string())
    }

    fn required_expected_updated_at(args: &Value) -> Result<&str, String> {
        args.get("expected_updated_at")
            .or_else(|| args.get("expectedUpdatedAt"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "Missing required parameter: expected_updated_at (use updatedAt from review_get_due)"
                    .to_string()
            })
    }

    fn mutation_error(
        service: &ReviewPlanService,
        action: &str,
        plan_id: &str,
        expected_updated_at: &str,
        error: anyhow::Error,
    ) -> String {
        if error.to_string().contains("REVIEW_CONFLICT") {
            let current = service
                .get_plan(plan_id)
                .ok()
                .flatten()
                .map(|plan| Self::plan_state_to_json(&plan))
                .unwrap_or(Value::Null);
            return with_localized_message(
                json!({
                    "code": "REVIEW_CONFLICT",
                    "action": action,
                    "plan_id": plan_id,
                    "expected_updated_at": expected_updated_at,
                    "current": current,
                    "retryable": false,
                    "hint": "重新读取计划，使用返回的 updatedAt 再决定是否重试；不要用过期版本重复提交。",
                }),
                "chat.tools.review.conflict",
                json!({ "action": action, "plan_id": plan_id }),
                "复习计划已被其他操作更新，请读取当前计划后再决定下一步。",
                "The review plan changed elsewhere. Read the current plan before deciding the next step.",
            )
            .to_string();
        }

        format!("复习计划{}失败: {}", action, error)
    }

    fn review_changed_payload(action: &str, plan_id: &str, run_id: &str) -> Value {
        json!({
            "source": "agent",
            "action": action,
            "operation": format!("review_{action}"),
            "planId": plan_id,
            "plan_id": plan_id,
            "entityIds": [plan_id],
            "runId": run_id,
        })
    }

    fn after_successful_mutation<F>(
        result: Result<Value, String>,
        action: &str,
        plan_id: &str,
        run_id: &str,
        emit: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(Value),
    {
        let value = result?;
        emit(Self::review_changed_payload(action, plan_id, run_id));
        Ok(value)
    }

    fn emit_review_changed(ctx: &ExecutionContext, payload: Value) {
        if let Err(error) = ctx.window_ref().emit("review://changed", payload) {
            log::debug!(
                "[ReviewToolExecutor] Failed to emit review://changed: {}",
                error
            );
        }
    }

    // ========================================================================
    // review_get_due
    // ========================================================================

    async fn execute_get_due(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = Self::service(ctx)?;
        let args = &call.arguments;

        let exam_id = args.get("exam_id").and_then(|v| v.as_str());
        let until_date = args.get("until_date").and_then(|v| v.as_str());
        if let Some(date) = until_date {
            Self::validate_date(date, "until_date")?;
        }
        let difficult_only = args.get("difficult_only").and_then(|v| v.as_bool());
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| (v as u32).clamp(1, MAX_DUE_LIMIT))
            .unwrap_or(20);
        let offset = args
            .get("offset")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(0);

        let filter = DueReviewsFilter {
            exam_id: exam_id.map(String::from),
            until_date: until_date.map(String::from),
            status: Self::parse_status_filter(args),
            difficult_only,
            limit: Some(limit),
            offset: Some(offset),
        };

        let result = service
            .get_due_reviews_with_filter(&filter)
            .map_err(|e| format!("查询到期复习失败: {}", e))?;

        let items: Vec<Value> = result
            .plans
            .iter()
            .map(|p| Self::plan_to_json(p, ctx, true))
            .collect();

        Ok(json!({
            "total": result.total,
            "has_more": result.has_more,
            "due_reviews": items,
            "limit": limit,
            "offset": offset,
            "hint": "可用 qbank_get_question 取题目完整内容出题给用户练习；用户作答后调用 review_submit 提交 0-5 质量评分，SM-2 会自动排期下次复习。",
        }))
    }

    // ========================================================================
    // review_schedule
    // ========================================================================

    async fn execute_schedule(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = Self::service(ctx)?;
        let args = &call.arguments;

        let exam_id = args
            .get("exam_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'exam_id' parameter（题目集 ID，即 qbank 工具返回的 session_id）")?;

        let mut question_ids = get_string_array_arg(args, "question_ids").unwrap_or_default();
        let card_ids = get_string_array_arg(args, "card_ids").unwrap_or_default();

        if question_ids.is_empty() && card_ids.is_empty() {
            return Err(
                "必须提供 question_ids 或 card_ids 至少一项。若想为整个题目集生成计划，请改用 review_plan_generate。"
                    .to_string(),
            );
        }

        // card_id → question_id 映射（复用 qbank 同源服务）
        let mut unresolved_card_ids: Vec<String> = Vec::new();
        if !card_ids.is_empty() {
            let qb_service = ctx
                .question_bank_service
                .as_ref()
                .ok_or("QuestionBank service not available（card_ids 映射需要该服务，可改传 question_ids）")?;
            for card_id in &card_ids {
                match qb_service.get_question_by_card_id(exam_id, card_id) {
                    Ok(Some(q)) => question_ids.push(q.id),
                    _ => unresolved_card_ids.push(card_id.clone()),
                }
            }
        }

        question_ids.sort();
        question_ids.dedup();

        if question_ids.is_empty() {
            return Err(format!(
                "所有 card_ids 都无法解析为题目: {:?}（请确认 exam_id 与 card_id 是否匹配）",
                unresolved_card_ids
            ));
        }
        if question_ids.len() > MAX_SCHEDULE_BATCH {
            return Err(format!(
                "单次最多为 {} 道题目安排复习（当前 {} 道）",
                MAX_SCHEDULE_BATCH,
                question_ids.len()
            ));
        }

        let result = service
            .batch_create_from_questions(&question_ids, exam_id)
            .map_err(|e| format!("安排复习计划失败: {}", e))?;

        let plans_preview: Vec<Value> = result
            .plans
            .iter()
            .take(20)
            .map(|p| {
                json!({
                    "plan_id": p.id,
                    "question_id": p.question_id,
                    "next_review_date": p.next_review_date,
                    "updatedAt": p.updated_at,
                })
            })
            .collect();

        let mut payload = json!({
            "success": true,
            "exam_id": exam_id,
            "created": result.created,
            "skipped": result.skipped,
            "failed": result.failed,
            "plans_preview": plans_preview,
            "message": format!(
                "已为 {} 道题目创建复习计划（{} 道已有计划跳过，{} 道失败）",
                result.created, result.skipped, result.failed
            ),
            "hint": "到期后可用 review_get_due 查询并组织复习；复习后用 review_submit 提交评分。",
        });
        if !unresolved_card_ids.is_empty() {
            payload["unresolved_card_ids"] = json!(unresolved_card_ids);
        }
        Self::emit_review_changed(
            ctx,
            json!({ "action": "schedule", "examId": exam_id, "runId": ctx.run_id() }),
        );
        Ok(payload)
    }

    // ========================================================================
    // review_plan_generate
    // ========================================================================

    async fn execute_plan_generate(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = Self::service(ctx)?;
        let exam_id = call
            .arguments
            .get("exam_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'exam_id' parameter（题目集 ID，即 qbank 工具返回的 session_id）")?;

        let result = service
            .create_plans_for_exam(exam_id)
            .map_err(|e| format!("生成复习计划失败: {}", e))?;

        // 刷新统计给出计划全貌
        let stats = service.refresh_review_stats(Some(exam_id)).ok();

        let mut payload = json!({
            "success": true,
            "exam_id": exam_id,
            "created": result.created,
            "skipped": result.skipped,
            "failed": result.failed,
            "message": format!(
                "已为题目集生成复习计划：新建 {} 个，已存在跳过 {} 个，失败 {} 个",
                result.created, result.skipped, result.failed
            ),
            "hint": "新建计划默认次日首次复习（SM-2 首间隔 1 天）。每天用 review_get_due 查询到期项即可开始复习。",
        });
        if let Some(s) = stats {
            payload["stats"] = json!({
                "total_plans": s.total_plans,
                "due_today": s.due_today,
                "overdue": s.overdue_count,
            });
        }
        Self::emit_review_changed(
            ctx,
            json!({ "action": "plan_generate", "examId": exam_id, "runId": ctx.run_id() }),
        );
        Ok(payload)
    }

    // ========================================================================
    // review_submit
    // ========================================================================

    async fn execute_submit(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = Self::service(ctx)?;
        let args = &call.arguments;

        let quality_raw = args
            .get("quality")
            .and_then(|v| v.as_i64())
            .ok_or("Missing 'quality' parameter（0-5 整数评分）")?;
        if !(0..=5).contains(&quality_raw) {
            return Err(format!(
                "quality 必须在 0-5 之间（当前: {}）。0=完全不记得, 3=勉强正确, 5=完美回忆",
                quality_raw
            ));
        }
        let quality = quality_raw as u8;
        let expected_updated_at = Self::required_expected_updated_at(args)?;

        // plan_id 优先；也支持 question_id 自动解析
        let plan_id = match args.get("plan_id").and_then(|v| v.as_str()) {
            Some(pid) => pid.to_string(),
            None => {
                let question_id = args.get("question_id").and_then(|v| v.as_str()).ok_or(
                    "必须提供 plan_id 或 question_id 之一（plan_id 来自 review_get_due 返回）",
                )?;
                service
                    .get_plan_by_question(question_id)
                    .map_err(|e| format!("查询复习计划失败: {}", e))?
                    .ok_or_else(|| {
                        format!(
                            "题目 {} 尚无复习计划，请先用 review_schedule 创建",
                            question_id
                        )
                    })?
                    .id
            }
        };

        let user_answer = args
            .get("user_answer")
            .and_then(|v| v.as_str())
            .map(String::from);
        let time_spent_seconds = args
            .get("time_spent_seconds")
            .and_then(|v| v.as_u64())
            .map(|v| v.min(86_400) as u32);

        let result = service
            .process_review_with_expected(
                &plan_id,
                quality,
                user_answer,
                time_spent_seconds,
                Some(expected_updated_at),
            )
            .map_err(|error| {
                Self::mutation_error(&service, "submit", &plan_id, expected_updated_at, error)
            })?;

        let payload = json!({
            "success": true,
            "plan_id": result.plan.id,
            "question_id": result.plan.question_id,
            "passed": result.passed,
            "new_interval_days": result.new_interval,
            "next_review_date": result.next_review_date,
            "status": result.plan.status.as_str(),
            "repetitions": result.plan.repetitions,
            "ease_factor": result.plan.ease_factor,
            "is_difficult": result.plan.is_difficult,
            "updatedAt": result.plan.updated_at,
            "message": if result.passed {
                format!("复习通过，下次复习: {}（间隔 {} 天）", result.next_review_date, result.new_interval)
            } else {
                format!("本次未通过，计划已重置，明天（{}）重新复习", result.next_review_date)
            },
        });
        Self::emit_review_changed(
            ctx,
            json!({ "action": "submit", "planId": plan_id, "runId": ctx.run_id() }),
        );
        Ok(payload)
    }

    // ========================================================================
    // review_stats
    // ========================================================================

    async fn execute_stats(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = Self::service(ctx)?;
        let args = &call.arguments;

        let exam_id = args.get("exam_id").and_then(|v| v.as_str());
        let stats = service
            .get_review_stats(exam_id)
            .map_err(|e| format!("获取复习统计失败: {}", e))?;

        let mut payload = json!({
            "exam_id": stats.exam_id,
            "total_plans": stats.total_plans,
            "by_status": {
                "new": stats.new_count,
                "learning": stats.learning_count,
                "reviewing": stats.reviewing_count,
                "graduated": stats.graduated_count,
                "suspended": stats.suspended_count,
            },
            "due_today": stats.due_today,
            "overdue": stats.overdue_count,
            "difficult": stats.difficult_count,
            "total_reviews": stats.total_reviews,
            "total_correct": stats.total_correct,
            "avg_correct_rate": stats.avg_correct_rate,
            "avg_ease_factor": stats.avg_ease_factor,
            "updated_at": stats.updated_at,
        });

        // 可选：日历热力图（记忆曲线概览）
        let include_calendar = args
            .get("include_calendar")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if include_calendar {
            let start_date = args.get("start_date").and_then(|v| v.as_str());
            let end_date = args.get("end_date").and_then(|v| v.as_str());
            if let Some(d) = start_date {
                Self::validate_date(d, "start_date")?;
            }
            if let Some(d) = end_date {
                Self::validate_date(d, "end_date")?;
            }
            let calendar = service
                .get_calendar_data(start_date, end_date, exam_id)
                .map_err(|e| format!("获取日历数据失败: {}", e))?;
            payload["calendar"] = json!(calendar
                .iter()
                .map(|c| json!({ "date": c.date, "count": c.count }))
                .collect::<Vec<_>>());
        }

        Ok(payload)
    }

    // ========================================================================
    // review_suspend / review_resume / review_delete
    // ========================================================================

    fn suspend_plan(
        service: &ReviewPlanService,
        plan_id: &str,
        expected_updated_at: &str,
    ) -> Result<Value, String> {
        let plan = service
            .suspend_plan_if_unchanged(plan_id, expected_updated_at)
            .map_err(|error| {
                Self::mutation_error(service, "suspend", plan_id, expected_updated_at, error)
            })?;

        Ok(json!({
            "success": true,
            "plan": Self::plan_state_to_json(&plan),
            "message_key": "review.plan_suspended",
            "message_params": { "plan_id": plan.id },
            "reversible": true,
        }))
    }

    fn resume_plan(
        service: &ReviewPlanService,
        plan_id: &str,
        expected_updated_at: &str,
    ) -> Result<Value, String> {
        let plan = service
            .resume_plan_if_unchanged(plan_id, expected_updated_at)
            .map_err(|error| {
                Self::mutation_error(service, "resume", plan_id, expected_updated_at, error)
            })?;

        Ok(json!({
            "success": true,
            "plan": Self::plan_state_to_json(&plan),
            "message_key": "review.plan_resumed",
            "message_params": { "plan_id": plan.id },
            "reversible": true,
        }))
    }

    fn delete_plan(
        service: &ReviewPlanService,
        plan_id: &str,
        expected_updated_at: &str,
    ) -> Result<Value, String> {
        let plan = service
            .get_plan(plan_id)
            .map_err(|e| format!("Failed to load review plan before deletion: {}", e))?
            .ok_or_else(|| format!("Review plan not found: {}", plan_id))?;

        service
            .delete_plan_if_unchanged(plan_id, expected_updated_at)
            .map_err(|error| {
                Self::mutation_error(service, "delete", plan_id, expected_updated_at, error)
            })?;

        Ok(json!({
            "success": true,
            "deleted": true,
            "plan_id": plan.id,
            "question_id": plan.question_id,
            "exam_id": plan.exam_id,
            "previous_status": plan.status.as_str(),
            "message_key": "review.plan_deleted",
            "message_params": { "plan_id": plan.id },
            "reversible": false,
        }))
    }

    async fn execute_suspend(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = Self::service(ctx)?;
        let plan_id = Self::required_plan_id(&call.arguments)?;
        let expected_updated_at = Self::required_expected_updated_at(&call.arguments)?;
        Self::after_successful_mutation(
            Self::suspend_plan(&service, plan_id, expected_updated_at),
            "suspend",
            plan_id,
            ctx.run_id(),
            |payload| Self::emit_review_changed(ctx, payload),
        )
    }

    async fn execute_resume(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = Self::service(ctx)?;
        let plan_id = Self::required_plan_id(&call.arguments)?;
        let expected_updated_at = Self::required_expected_updated_at(&call.arguments)?;
        Self::after_successful_mutation(
            Self::resume_plan(&service, plan_id, expected_updated_at),
            "resume",
            plan_id,
            ctx.run_id(),
            |payload| Self::emit_review_changed(ctx, payload),
        )
    }

    async fn execute_delete(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = Self::service(ctx)?;
        let plan_id = Self::required_plan_id(&call.arguments)?;
        let expected_updated_at = Self::required_expected_updated_at(&call.arguments)?;
        Self::after_successful_mutation(
            Self::delete_plan(&service, plan_id, expected_updated_at),
            "delete",
            plan_id,
            ctx.run_id(),
            |payload| Self::emit_review_changed(ctx, payload),
        )
    }
}

impl Default for ReviewToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for ReviewToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let name = strip_tool_namespace(tool_name);
        matches!(
            name,
            "review_get_due"
                | "review_schedule"
                | "review_plan_generate"
                | "review_submit"
                | "review_stats"
                | "review_suspend"
                | "review_resume"
                | "review_delete"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!("[ReviewToolExecutor] Executing tool: {}", tool_name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            "review_get_due" => self.execute_get_due(call, ctx).await,
            "review_schedule" => self.execute_schedule(call, ctx).await,
            "review_plan_generate" => self.execute_plan_generate(call, ctx).await,
            "review_submit" => self.execute_submit(call, ctx).await,
            "review_stats" => self.execute_stats(call, ctx).await,
            "review_suspend" => self.execute_suspend(call, ctx).await,
            "review_resume" => self.execute_resume(call, ctx).await,
            "review_delete" => self.execute_delete(call, ctx).await,
            _ => Err(format!("Unknown review tool: {}", tool_name)),
        };

        let elapsed_ms = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(value) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": value,
                    "durationMs": elapsed_ms,
                })));

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    value,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[ReviewToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                log::error!("[ReviewToolExecutor] Tool {} failed: {}", tool_name, e);

                ctx.emit_tool_call_error(&e);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[ReviewToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            "review_delete" => ToolSensitivity::High,
            // 写计划类操作
            "review_schedule"
            | "review_plan_generate"
            | "review_submit"
            | "review_suspend"
            | "review_resume" => ToolSensitivity::Medium,
            // 只读操作。
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "ReviewToolExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = ReviewToolExecutor::new();
        assert!(executor.can_handle("review_get_due"));
        assert!(executor.can_handle("builtin-review_get_due"));
        assert!(executor.can_handle("review_schedule"));
        assert!(executor.can_handle("review_plan_generate"));
        assert!(executor.can_handle("review_submit"));
        assert!(executor.can_handle("review_stats"));
        assert!(executor.can_handle("review_suspend"));
        assert!(executor.can_handle("builtin-review_resume"));
        assert!(executor.can_handle("review_delete"));
        assert!(!executor.can_handle("review_plan_delete"));
        assert!(!executor.can_handle("qbank_list"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = ReviewToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("review_schedule"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-review_plan_generate"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-review_suspend"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-review_resume"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-review_delete"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("review_get_due"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("review_submit"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("review_stats"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn test_validate_date() {
        assert!(ReviewToolExecutor::validate_date("2026-07-08", "until_date").is_ok());
        assert!(ReviewToolExecutor::validate_date("2026-7-8", "until_date").is_err());
        assert!(ReviewToolExecutor::validate_date("not-a-date", "until_date").is_err());
        assert!(ReviewToolExecutor::validate_date("2026-13-40", "until_date").is_err());
    }

    #[test]
    fn test_parse_status_filter() {
        let args = serde_json::json!({ "status": ["new", "reviewing", "unknown_status"] });
        let parsed = ReviewToolExecutor::parse_status_filter(&args).expect("should parse");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0], ReviewPlanStatus::New);
        assert_eq!(parsed[1], ReviewPlanStatus::Reviewing);
        // 未知字符串按仓储层约定回退到 New
        assert_eq!(parsed[2], ReviewPlanStatus::New);

        let empty_args = serde_json::json!({});
        assert!(ReviewToolExecutor::parse_status_filter(&empty_args).is_none());
    }

    #[test]
    fn test_parse_status_filter_accepts_stringified_array() {
        // 部分模型会把数组序列化为 JSON 字符串
        let args = serde_json::json!({ "status": "[\"graduated\", \"suspended\"]" });
        let parsed = ReviewToolExecutor::parse_status_filter(&args).expect("should parse");
        assert_eq!(
            parsed,
            vec![ReviewPlanStatus::Graduated, ReviewPlanStatus::Suspended]
        );
    }

    #[test]
    fn review_mutations_require_a_non_empty_plan_id() {
        assert!(ReviewToolExecutor::required_plan_id(&json!({})).is_err());
        assert!(ReviewToolExecutor::required_plan_id(&json!({"plan_id": "  "})).is_err());
        assert_eq!(
            ReviewToolExecutor::required_plan_id(&json!({"planId": " rp_123 "}))
                .expect("camelCase alias"),
            "rp_123"
        );
    }

    #[test]
    fn review_suspend_resume_delete_normal_path() {
        use crate::vfs::repos::review_plan_repo::{CreateReviewPlanParams, VfsReviewPlanRepo};
        use std::sync::Arc;

        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().expect("open migrated VFS database");
        conn.pragma_update(None, "foreign_keys", "OFF")
            .expect("disable foreign keys for isolated review-plan fixture");
        let plan = VfsReviewPlanRepo::create_plan_with_conn(
            &conn,
            &CreateReviewPlanParams {
                question_id: "question_review_tool_contract".to_string(),
                exam_id: "exam_review_tool_contract".to_string(),
                initial_ease_factor: None,
            },
        )
        .expect("create review plan fixture");
        drop(conn);

        let service = ReviewPlanService::new(Arc::new(db));
        let suspended = ReviewToolExecutor::suspend_plan(&service, &plan.id, &plan.updated_at)
            .expect("suspend review plan");
        assert_eq!(suspended["plan"]["status"], "suspended");
        assert_eq!(suspended["reversible"], true);

        let suspended_updated_at = suspended["plan"]["updatedAt"]
            .as_str()
            .expect("suspended plan revision")
            .to_string();
        let resumed = ReviewToolExecutor::resume_plan(&service, &plan.id, &suspended_updated_at)
            .expect("resume review plan");
        assert_eq!(resumed["plan"]["status"], "new");
        assert_eq!(resumed["reversible"], true);

        let resumed_updated_at = resumed["plan"]["updatedAt"]
            .as_str()
            .expect("resumed plan revision")
            .to_string();
        let deleted = ReviewToolExecutor::delete_plan(&service, &plan.id, &resumed_updated_at)
            .expect("delete review plan");
        assert_eq!(deleted["plan_id"], plan.id);
        assert_eq!(deleted["reversible"], false);
        assert!(service
            .get_plan(&plan.id)
            .expect("read deleted plan")
            .is_none());
    }

    #[test]
    fn review_change_event_emits_after_success_for_each_mutation() {
        use std::cell::RefCell;

        let emitted = RefCell::new(Vec::new());
        for action in ["suspend", "resume", "delete"] {
            let result = ReviewToolExecutor::after_successful_mutation(
                Ok(json!({ "success": true })),
                action,
                "rp_event_contract",
                "tool_call_event_contract",
                |payload| emitted.borrow_mut().push(payload),
            );
            assert!(result.is_ok());
        }

        let events = emitted.into_inner();
        assert_eq!(events.len(), 3);
        for (event, action) in events.iter().zip(["suspend", "resume", "delete"]) {
            assert_eq!(event["source"], "agent");
            assert_eq!(event["action"], action);
            assert_eq!(event["operation"], format!("review_{action}"));
            assert_eq!(event["planId"], "rp_event_contract");
            assert_eq!(event["plan_id"], "rp_event_contract");
            assert_eq!(event["entityIds"], json!(["rp_event_contract"]));
            assert_eq!(event["runId"], "tool_call_event_contract");
        }
    }

    #[test]
    fn review_change_event_is_not_emitted_after_mutation_failure() {
        use std::cell::Cell;

        for action in ["suspend", "resume", "delete"] {
            let emitted = Cell::new(false);
            let result = ReviewToolExecutor::after_successful_mutation(
                Err("mutation failed".to_string()),
                action,
                "rp_event_contract",
                "tool_call_event_contract",
                |_| emitted.set(true),
            );

            assert_eq!(
                result.expect_err("failure must propagate"),
                "mutation failed"
            );
            assert!(!emitted.get(), "{action} failure must not emit an event");
        }
    }
}
