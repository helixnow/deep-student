//! Goal 模式工具执行器（P0）
//!
//! 实现会话级持久目标的模型侧工具：目标跨轮次持续存在，本轮结束后由
//! goal 运行时自动发起续跑轮继续推进，直到目标被标记完成。
//!
//! ## 工具列表
//! - `goal_create`: 创建会话目标（每会话至多一个未完成目标）
//! - `goal_update`: 标记目标终态/挂起态（complete / blocked / waiting_user）
//! - `goal_get`: 获取当前目标与预算消耗
//!
//! ## 权限划分
//! 模型仅可经 `goal_update` 设 complete / blocked / waiting_user；
//! pause / resume 走 IPC（用户控制）；usage_limited / budget_limited 由
//! 系统（goal 运行时）设置。本执行器在 `goal_update` 入口强制该白名单。

use std::time::Instant;

use async_trait::async_trait;
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::Emitter;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::events::build_goal_updated_payload;
use crate::chat_v2::repo::{ChatV2Repo, GoalRecord};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

// ============================================================================
// 常量定义
// ============================================================================

/// 工具名称
pub mod tool_names {
    pub const GOAL_CREATE: &str = "goal_create";
    pub const GOAL_UPDATE: &str = "goal_update";
    pub const GOAL_GET: &str = "goal_get";
}

/// goal_update 允许模型设置的状态（其余状态由用户 IPC 或系统控制）
const MODEL_SETTABLE_STATUSES: &[&str] = &["complete", "blocked", "waiting_user"];

// ============================================================================
// 工具 Schema 定义
// ============================================================================

/// 获取 goal_create 工具 Schema
pub fn get_goal_create_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool_names::GOAL_CREATE,
            "description": "创建一个新的会话目标。目标会跨轮次持续存在：本轮结束后系统会自动发起续跑轮继续推进，直到目标被标记完成。只有在用户明确提出一个需要多步推进的目标时才使用。token_budget 为正整数 token 预算，除非用户明确要求否则省略。",
            "parameters": {
                "type": "object",
                "properties": {
                    "objective": {
                        "type": "string",
                        "description": "要达成的目标描述，需具体、可验证"
                    },
                    "token_budget": {
                        "type": "integer",
                        "description": "token 预算上限（正整数）。除非用户明确要求，否则省略。"
                    }
                },
                "required": ["objective"]
            }
        }
    })
}

/// 获取 goal_update 工具 Schema
pub fn get_goal_update_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool_names::GOAL_UPDATE,
            "description": "更新当前会话目标的状态。仅允许：complete（目标已达成——必须经过逐条证据核实，不得凭印象）、blocked（同一阻塞条件已连续多轮无法推进）、waiting_user（需要用户回答/输入才能继续，目标挂起直到用户回复）。pause/resume/预算类状态由用户或系统控制，模型不得设置。",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["complete", "blocked", "waiting_user"],
                        "description": "新状态"
                    }
                },
                "required": ["status"]
            }
        }
    })
}

/// 获取 goal_get 工具 Schema
pub fn get_goal_get_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool_names::GOAL_GET,
            "description": "获取当前会话目标，含状态、token 预算、已用 token/时间与剩余预算。",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
}

/// 获取所有 Goal 工具 Schema
pub fn get_all_schemas() -> Vec<Value> {
    vec![
        get_goal_create_schema(),
        get_goal_update_schema(),
        get_goal_get_schema(),
    ]
}

// ============================================================================
// GoalExecutor 执行器
// ============================================================================

/// Goal 模式工具执行器
pub struct GoalExecutor;

impl GoalExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 取 chat_v2 连接并执行 repo 操作（错误统一映射为工具错误字符串）
    fn with_conn<T>(
        ctx: &ExecutionContext,
        f: impl FnOnce(&Connection) -> crate::chat_v2::error::ChatV2Result<T>,
    ) -> Result<T, String> {
        let db = ctx
            .chat_v2_db
            .as_ref()
            .ok_or_else(|| "chat_v2_db unavailable in ExecutionContext".to_string())?;
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
        f(&conn).map_err(|e| e.to_string())
    }

    /// 发射 goal_updated 会话级事件（通道 `chat_v2_session_{session_id}`）。
    ///
    /// 经 ExecutionContext 现有的 tauri_window 通道发送；无窗口环境
    /// （headless / 测试）跳过——轮末由 goal 运行时补发权威状态。
    fn emit_goal_updated(ctx: &ExecutionContext, goal: Option<&GoalRecord>) {
        let Some(window) = ctx.tauri_window.as_ref() else {
            return;
        };
        let channel = format!("chat_v2_session_{}", ctx.session_id);
        let payload = build_goal_updated_payload(&ctx.session_id, goal);
        if let Err(e) = window.emit(&channel, &payload) {
            log::warn!("[GoalExecutor] Failed to emit goal_updated event: {}", e);
        }
    }

    /// 从参数解析 token_budget：缺省 None；出现则必须为正整数
    fn parse_token_budget(args: &Value) -> Result<Option<i64>, String> {
        match args.get("token_budget") {
            None | Some(Value::Null) => Ok(None),
            Some(raw) => match raw.as_i64() {
                Some(v) if v > 0 => Ok(Some(v)),
                _ => Err("token_budget 必须是正整数".to_string()),
            },
        }
    }

    /// 执行 goal_create
    fn execute_create(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let objective = args
            .get("objective")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: objective")?
            .trim()
            .to_string();
        if objective.is_empty() {
            return Err("objective 不能为空".to_string());
        }
        let token_budget = Self::parse_token_budget(args)?;

        // 业务规则：会话已有未完成（非 complete）目标时拒绝创建
        let existing = Self::with_conn(ctx, |conn| {
            ChatV2Repo::goal_get_with_conn(conn, &ctx.session_id)
        })?;
        if let Some(existing) = existing {
            if existing.status != "complete" {
                return Err(
                    "cannot create a new goal because this session has an unfinished goal; complete the existing goal first or ask the user to clear it"
                        .to_string(),
                );
            }
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        let record = GoalRecord {
            session_id: ctx.session_id.clone(),
            goal_id: format!("goal_{}", uuid::Uuid::new_v4().simple()),
            objective,
            status: "active".to_string(),
            token_budget,
            tokens_used: 0,
            time_used_seconds: 0,
            continuation_count: 0,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        };
        Self::with_conn(ctx, |conn| ChatV2Repo::goal_insert_with_conn(conn, &record))?;

        Self::emit_goal_updated(ctx, Some(&record));

        Ok(json!({
            "success": true,
            "goal": record,
            "message": "目标已激活。它跨轮次持续存在，本轮结束后会自动续跑。推进过程中保持目标完整，不要缩小范围；确证全部完成后再调用 goal_update(complete)。"
        }))
    }

    /// 执行 goal_update
    fn execute_update(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let status = args
            .get("status")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: status")?;
        if !MODEL_SETTABLE_STATUSES.contains(&status) {
            return Err(
                "update_goal can only mark the existing goal complete, blocked, or waiting_user; pause, resume, and budget-related status changes are controlled by the user or system"
                    .to_string(),
            );
        }

        let existing = Self::with_conn(ctx, |conn| {
            ChatV2Repo::goal_get_with_conn(conn, &ctx.session_id)
        })?
        .ok_or_else(|| "cannot update goal because this session has no goal".to_string())?;

        // 乐观并发：以当前 goal_id 为期望值更新，失配说明并发变更
        let updated = Self::with_conn(ctx, |conn| {
            ChatV2Repo::goal_update_status_with_conn(
                conn,
                &ctx.session_id,
                &existing.goal_id,
                status,
            )
        })?
        .ok_or_else(|| {
            "goal was modified concurrently; call goal_get to fetch the latest state and retry"
                .to_string()
        })?;

        Self::emit_goal_updated(ctx, Some(&updated));

        let message = match status {
            "complete" => "目标已标记完成，自动续跑停止。",
            "blocked" => "目标已标记阻塞，自动续跑停止。向用户说明阻塞原因与需要的帮助。",
            "waiting_user" => "目标已挂起等待用户输入。用户回复后目标将继续推进。",
            _ => unreachable!("status whitelist checked above"),
        };
        Ok(json!({
            "success": true,
            "goal": updated,
            "message": message,
        }))
    }

    /// 执行 goal_get
    fn execute_get(&self, ctx: &ExecutionContext) -> Result<Value, String> {
        let goal = Self::with_conn(ctx, |conn| {
            ChatV2Repo::goal_get_with_conn(conn, &ctx.session_id)
        })?;

        let remaining_tokens = match goal.as_ref().and_then(|g| g.token_budget) {
            Some(budget) => json!(budget - goal.as_ref().map(|g| g.tokens_used).unwrap_or(0)),
            None => json!("unbounded"),
        };
        let message = if goal.is_some() {
            "目标存在。推进过程中保持目标完整，不要缩小范围；确证全部完成后再调用 goal_update(complete)。"
        } else {
            "当前会话没有目标。只有用户明确提出需要多步推进的目标时才调用 goal_create。"
        };

        Ok(json!({
            "success": true,
            "goal": goal,
            "remaining_tokens": remaining_tokens,
            "message": message,
        }))
    }
}

impl Default for GoalExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for GoalExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        // 支持 builtin- 前缀和无前缀两种格式
        let stripped = strip_tool_namespace(tool_name);
        matches!(
            stripped,
            tool_names::GOAL_CREATE | tool_names::GOAL_UPDATE | tool_names::GOAL_GET
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        // 发射开始事件
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        // 执行工具（去除 builtin- 前缀后匹配）
        let tool_name = strip_tool_namespace(&call.name);
        let result = match tool_name {
            tool_names::GOAL_CREATE => self.execute_create(&call.arguments, ctx),
            tool_names::GOAL_UPDATE => self.execute_update(&call.arguments, ctx),
            tool_names::GOAL_GET => self.execute_get(ctx),
            _ => Err(format!("未知的 Goal 工具: {}", call.name)),
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                // 发射结束事件
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));

                log::info!("[GoalExecutor] Tool {} completed", call.name);

                let tool_result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                );

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("[GoalExecutor] Failed to save tool block: {}", e);
                }

                Ok(tool_result)
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                );

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[GoalExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // Goal 工具是低敏感的（会话内状态，权限划分由执行器入口白名单强制）
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "GoalExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle_with_and_without_prefix() {
        let executor = GoalExecutor::new();
        for name in [
            "goal_create",
            "goal_update",
            "goal_get",
            "builtin-goal_create",
            "builtin-goal_update",
            "builtin-goal_get",
        ] {
            assert!(executor.can_handle(name), "{} must be handled", name);
        }
        assert!(!executor.can_handle("todo_init"));
        assert!(!executor.can_handle("goal_delete"));
    }

    #[test]
    fn test_schema_generation() {
        let schemas = get_all_schemas();
        assert_eq!(schemas.len(), 3);
        assert_eq!(schemas[0]["function"]["name"], tool_names::GOAL_CREATE);
        assert_eq!(schemas[1]["function"]["name"], tool_names::GOAL_UPDATE);
        assert_eq!(schemas[2]["function"]["name"], tool_names::GOAL_GET);
        // goal_update 的 status 枚举只允许模型可设的三值
        let status_enum = schemas[1]["function"]["parameters"]["properties"]["status"]["enum"]
            .as_array()
            .unwrap();
        assert_eq!(
            status_enum,
            &vec![json!("complete"), json!("blocked"), json!("waiting_user")]
        );
    }

    #[test]
    fn test_parse_token_budget() {
        assert_eq!(GoalExecutor::parse_token_budget(&json!({})).unwrap(), None);
        assert_eq!(
            GoalExecutor::parse_token_budget(&json!({"token_budget": 1000})).unwrap(),
            Some(1000)
        );
        assert!(GoalExecutor::parse_token_budget(&json!({"token_budget": 0})).is_err());
        assert!(GoalExecutor::parse_token_budget(&json!({"token_budget": -5})).is_err());
        assert!(GoalExecutor::parse_token_budget(&json!({"token_budget": "1000"})).is_err());
    }
}
