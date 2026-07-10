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
//!
//! ## 与既有服务的对接
//! - 全部业务逻辑走 `crate::review_plan_service::ReviewPlanService`（基于 ctx.vfs_db 构造），
//!   不重复实现 SM-2 计算；
//! - card_id → question_id 的映射复用 `ctx.question_bank_service`（与 qbank_* 工具同源）。
//!
//! ## 敏感度
//! - 读（get_due / stats）: Low
//! - 提交复习结果（review_submit）: Low（用户练习主动作，与 qbank_submit_answer 对齐）
//! - 写计划（review_schedule / review_plan_generate）: Medium
//! - 删除类操作不暴露
//!
//! ## 事件发射（强制，见 tools/mod.rs 头注释）
//! - 开始: `ctx.emit_tool_call_start`
//! - 成功: `ctx.emit_tool_call_end`
//! - 失败: `ctx.emit_tool_call_error`

use std::time::Instant;

use async_trait::async_trait;
use chrono::NaiveDate;
use serde_json::{json, Value};

use super::arg_utils::get_string_array_arg;
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
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map(|_| ())
            .map_err(|_| format!("参数 '{}' 日期格式无效: {}（应为 YYYY-MM-DD）", field, value))
    }

    /// 复习计划 → JSON（附题目内容预览，便于 agent 直接组织复习）
    fn plan_to_json(plan: &ReviewPlan, ctx: &ExecutionContext, with_question: bool) -> Value {
        let mut item = json!({
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
        });

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
        get_string_array_arg(args, "status").map(|list| {
            list.iter()
                .map(|s| ReviewPlanStatus::from_str(s))
                .collect()
        })
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
            .process_review(&plan_id, quality, user_answer, time_spent_seconds)
            .map_err(|e| format!("提交复习结果失败: {}", e))?;

        Ok(json!({
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
            "message": if result.passed {
                format!("复习通过，下次复习: {}（间隔 {} 天）", result.next_review_date, result.new_interval)
            } else {
                format!("本次未通过，计划已重置，明天（{}）重新复习", result.next_review_date)
            },
        }))
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
            // 写计划类操作
            "review_schedule" | "review_plan_generate" => ToolSensitivity::Medium,
            // 读 + 用户练习主动作（与 qbank_submit_answer 对齐为 Low）
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

        assert!(!executor.can_handle("review_delete"));
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
            executor.sensitivity_level("review_get_due"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("review_submit"),
            ToolSensitivity::Low
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
        assert_eq!(parsed, vec![ReviewPlanStatus::Graduated, ReviewPlanStatus::Suspended]);
    }
}
