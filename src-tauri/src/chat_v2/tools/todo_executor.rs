//! TodoList 工具执行器
//!
//! 实现 Agent 任务管理机制，支持永续执行。
//!
//! ## 工具列表
//! - `todo_init`: 初始化任务列表，分解任务为子步骤
//! - `todo_update`: 更新单个任务状态
//! - `todo_add`: 动态添加任务
//! - `todo_get`: 获取当前任务状态
//!
//! ## 永续执行机制
//! 当 `todo_update` 被调用且仍有未完成任务时，返回 `continue_execution: true`，
//! 告诉 Pipeline 继续递归执行，绕过轮次限制。

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

// ============================================================================
// 常量定义
// ============================================================================

/// 工具名称前缀
pub const TODO_NAMESPACE: &str = "todo";

/// 工具名称
pub mod tool_names {
    pub const TODO_INIT: &str = "todo_init";
    pub const TODO_UPDATE: &str = "todo_update";
    pub const TODO_ADD: &str = "todo_add";
    pub const TODO_GET: &str = "todo_get";
}

// ============================================================================
// 类型定义
// ============================================================================

/// 任务步骤状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    /// 待处理
    Pending,
    /// 执行中
    Running,
    /// 已完成
    Completed,
    /// 失败
    Failed,
    /// 已跳过
    Skipped,
}

impl Default for TodoStatus {
    fn default() -> Self {
        Self::Pending
    }
}

impl std::fmt::Display for TodoStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TodoStatus::Pending => write!(f, "pending"),
            TodoStatus::Running => write!(f, "running"),
            TodoStatus::Completed => write!(f, "completed"),
            TodoStatus::Failed => write!(f, "failed"),
            TodoStatus::Skipped => write!(f, "skipped"),
        }
    }
}

/// 单个任务步骤
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoStep {
    /// 步骤 ID（格式：step_{index}）
    pub id: String,
    /// 步骤描述
    pub description: String,
    /// 步骤状态
    pub status: TodoStatus,
    /// 执行结果摘要（完成或失败时填写）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// 创建时间戳
    pub created_at: i64,
    /// 更新时间戳
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

impl TodoStep {
    pub fn new(id: String, description: String) -> Self {
        Self {
            id,
            description,
            status: TodoStatus::Pending,
            result: None,
            created_at: chrono::Utc::now().timestamp_millis(),
            updated_at: None,
        }
    }
}

/// 任务列表
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TodoList {
    /// 任务列表 ID
    pub id: String,
    /// 任务标题/目标
    pub title: String,
    /// 步骤列表
    pub steps: Vec<TodoStep>,
    /// 创建时间戳
    pub created_at: i64,
    /// 更新时间戳
    pub updated_at: i64,
}

impl TodoList {
    pub fn new(title: String, steps: Vec<TodoStep>) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id: format!(
                "todo_{}",
                uuid::Uuid::new_v4().to_string().replace("-", "")[..8].to_string()
            ),
            title,
            steps,
            created_at: now,
            updated_at: now,
        }
    }

    /// 获取已完成的步骤数
    pub fn completed_count(&self) -> usize {
        self.steps
            .iter()
            .filter(|s| s.status == TodoStatus::Completed)
            .count()
    }

    /// 获取总步骤数
    pub fn total_count(&self) -> usize {
        self.steps.len()
    }

    /// 检查是否所有任务都已完成（或失败/跳过）
    pub fn is_all_done(&self) -> bool {
        self.steps.iter().all(|s| {
            matches!(
                s.status,
                TodoStatus::Completed | TodoStatus::Failed | TodoStatus::Skipped
            )
        })
    }

    /// 获取下一个待处理的步骤
    pub fn next_pending(&self) -> Option<&TodoStep> {
        self.steps.iter().find(|s| s.status == TodoStatus::Pending)
    }

    /// 获取当前正在执行的步骤
    pub fn current_running(&self) -> Option<&TodoStep> {
        self.steps.iter().find(|s| s.status == TodoStatus::Running)
    }
}

// ============================================================================
// 全局状态存储（会话级隔离）
// ============================================================================

use std::sync::LazyLock;

/// 全局 TodoList 存储（按会话 ID 隔离）
static TODO_STORE: LazyLock<RwLock<HashMap<String, TodoList>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// 获取会话的 TodoList
pub fn get_todo_list(session_id: &str) -> Option<TodoList> {
    TODO_STORE.read().ok()?.get(session_id).cloned()
}

/// 设置会话的 TodoList
fn set_todo_list(session_id: &str, list: TodoList) {
    if let Ok(mut store) = TODO_STORE.write() {
        store.insert(session_id.to_string(), list);
    }
}

/// 清除会话的 TodoList
#[allow(dead_code)]
fn clear_todo_list(session_id: &str) {
    if let Ok(mut store) = TODO_STORE.write() {
        store.remove(session_id);
    }
}

// ============================================================================
// 数据库持久化（消息内继续执行支持）
// ============================================================================

/// 持久化 TodoList 到数据库
///
/// 当 Pipeline 因网络错误等原因中断时，可以从数据库恢复 TodoList 状态
pub fn persist_todo_list(
    db: &ChatV2Database,
    session_id: &str,
    message_id: &str,
    variant_id: Option<&str>,
    list: &TodoList,
) -> Result<(), String> {
    let conn = db.get_conn().map_err(|e| e.to_string())?;
    persist_todo_list_with_conn(&conn, session_id, message_id, variant_id, list)
}

/// 持久化 TodoList 到数据库（使用现有连接）
pub fn persist_todo_list_with_conn(
    conn: &Connection,
    session_id: &str,
    message_id: &str,
    variant_id: Option<&str>,
    list: &TodoList,
) -> Result<(), String> {
    let steps_json = serde_json::to_string(&list.steps)
        .map_err(|e| format!("Failed to serialize steps: {}", e))?;

    conn.execute(
        r#"
        INSERT OR REPLACE INTO chat_v2_todo_lists
        (session_id, message_id, variant_id, todo_list_id, title, steps_json, is_all_done, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            session_id,
            message_id,
            variant_id,
            &list.id,
            &list.title,
            steps_json,
            if list.is_all_done() { 1 } else { 0 },
            list.created_at,
            list.updated_at,
        ],
    ).map_err(|e| format!("Failed to persist TodoList: {}", e))?;

    log::debug!(
        "[TodoListExecutor] Persisted TodoList {} for session {} (message: {})",
        list.id,
        session_id,
        message_id
    );

    Ok(())
}

/// 从数据库加载 TodoList
pub fn load_persisted_todo_list(
    db: &ChatV2Database,
    session_id: &str,
) -> Result<Option<(TodoList, String, Option<String>)>, String> {
    let conn = db.get_conn().map_err(|e| e.to_string())?;
    load_persisted_todo_list_with_conn(&conn, session_id)
}

/// 从数据库加载 TodoList（使用现有连接）
///
/// 返回: (TodoList, message_id, variant_id)
pub fn load_persisted_todo_list_with_conn(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(TodoList, String, Option<String>)>, String> {
    let result = conn.query_row(
        r#"
        SELECT todo_list_id, title, steps_json, created_at, updated_at, message_id, variant_id
        FROM chat_v2_todo_lists
        WHERE session_id = ?1 AND is_all_done = 0
        "#,
        params![session_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,         // todo_list_id
                row.get::<_, String>(1)?,         // title
                row.get::<_, String>(2)?,         // steps_json
                row.get::<_, i64>(3)?,            // created_at
                row.get::<_, i64>(4)?,            // updated_at
                row.get::<_, String>(5)?,         // message_id
                row.get::<_, Option<String>>(6)?, // variant_id
            ))
        },
    );

    match result {
        Ok((todo_list_id, title, steps_json, created_at, updated_at, message_id, variant_id)) => {
            let steps: Vec<TodoStep> = serde_json::from_str(&steps_json)
                .map_err(|e| format!("Failed to deserialize steps: {}", e))?;

            let list = TodoList {
                id: todo_list_id,
                title,
                steps,
                created_at,
                updated_at,
            };

            log::info!(
                "[TodoListExecutor] Loaded persisted TodoList {} for session {} (message: {})",
                list.id,
                session_id,
                message_id
            );

            Ok(Some((list, message_id, variant_id)))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Failed to load TodoList: {}", e)),
    }
}

/// 删除已完成的 TodoList 持久化记录
pub fn delete_persisted_todo_list(db: &ChatV2Database, session_id: &str) -> Result<(), String> {
    let conn = db.get_conn().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM chat_v2_todo_lists WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| format!("Failed to delete TodoList: {}", e))?;
    Ok(())
}

/// 恢复 TodoList 到内存（从数据库加载并设置到内存存储）
pub fn restore_todo_list_from_db(
    db: &ChatV2Database,
    session_id: &str,
) -> Result<Option<TodoList>, String> {
    if let Some((list, _message_id, _variant_id)) = load_persisted_todo_list(db, session_id)? {
        set_todo_list(session_id, list.clone());
        Ok(Some(list))
    } else {
        Ok(None)
    }
}

// ============================================================================
// 工具 Schema 定义
// ============================================================================

/// 获取 todo_init 工具 Schema
pub fn get_todo_init_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool_names::TODO_INIT,
            "description": "开始任务时调用，将复杂任务分解为可执行的子步骤列表。每个步骤应该是具体、可验证的操作。",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "任务的整体目标或标题"
                    },
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "description": {
                                    "type": "string",
                                    "description": "步骤描述，具体说明要做什么"
                                }
                            },
                            "required": ["description"]
                        },
                        "description": "任务步骤列表，按执行顺序排列"
                    }
                },
                "required": ["title", "steps"]
            }
        }
    })
}

/// 获取 todo_update 工具 Schema
pub fn get_todo_update_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool_names::TODO_UPDATE,
            "description": "更新任务步骤的状态。每完成一个步骤都应调用此工具。",
            "parameters": {
                "type": "object",
                "properties": {
                    "stepId": {
                        "type": "string",
                        "description": "要更新的步骤 ID"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["running", "completed", "failed", "skipped"],
                        "description": "新状态"
                    },
                    "result": {
                        "type": "string",
                        "description": "执行结果摘要（完成或失败时提供）"
                    }
                },
                "required": ["stepId", "status"]
            }
        }
    })
}

/// 获取 todo_add 工具 Schema
pub fn get_todo_add_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool_names::TODO_ADD,
            "description": "在执行过程中发现需要额外步骤时，动态添加新任务。",
            "parameters": {
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "新步骤的描述"
                    },
                    "afterStepId": {
                        "type": "string",
                        "description": "插入位置，在此步骤之后插入。省略则添加到末尾。"
                    }
                },
                "required": ["description"]
            }
        }
    })
}

/// 获取 todo_get 工具 Schema
pub fn get_todo_get_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool_names::TODO_GET,
            "description": "获取当前任务列表及所有步骤的状态。",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
}

/// 获取所有 TODO 工具 Schema
pub fn get_all_schemas() -> Vec<Value> {
    vec![
        get_todo_init_schema(),
        get_todo_update_schema(),
        get_todo_add_schema(),
        get_todo_get_schema(),
    ]
}

// ============================================================================
// TodoListExecutor 执行器
// ============================================================================

/// TodoList 工具执行器
pub struct TodoListExecutor;

impl TodoListExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 执行 todo_init
    fn execute_init(&self, args: &Value, session_id: &str) -> Result<(Value, bool), String> {
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: title")?
            .to_string();

        let steps_array = args
            .get("steps")
            .and_then(|v| v.as_array())
            .ok_or("缺少必需参数: steps")?;

        let steps: Vec<TodoStep> = steps_array
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let desc = s
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名步骤")
                    .to_string();
                TodoStep::new(format!("step_{}", i + 1), desc)
            })
            .collect();

        if steps.is_empty() {
            return Err("步骤列表不能为空".to_string());
        }

        let todo_list = TodoList::new(title.clone(), steps);
        let total = todo_list.total_count();
        let completed = todo_list.completed_count();
        let is_all_done = todo_list.is_all_done();

        let response = json!({
            "success": true,
            "todoListId": todo_list.id,
            "title": todo_list.title,
            "totalSteps": total,
            "completedCount": completed,
            "totalCount": total,
            "isAllDone": is_all_done,
            "steps": todo_list.steps,
            "message": format!("已创建任务列表「{}」，共 {} 个步骤", title, total)
        });

        set_todo_list(session_id, todo_list);

        // 初始化后，任务未完成，需要继续执行
        Ok((response, true))
    }

    /// 执行 todo_update
    fn execute_update(&self, args: &Value, session_id: &str) -> Result<(Value, bool), String> {
        let step_id = args
            .get("stepId")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: stepId")?;

        let status_str = args
            .get("status")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: status")?;

        // 支持 LLM 可能使用的别名：in_progress -> running
        let status = match status_str {
            "running" | "in_progress" => TodoStatus::Running,
            "completed" | "done" => TodoStatus::Completed,
            "failed" | "error" => TodoStatus::Failed,
            "skipped" | "skip" => TodoStatus::Skipped,
            _ => return Err(format!("无效的状态: {}", status_str)),
        };

        let result = args
            .get("result")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mut todo_list =
            get_todo_list(session_id).ok_or("未找到任务列表，请先调用 todo_init")?;

        // 查找并更新步骤
        let step = todo_list
            .steps
            .iter_mut()
            .find(|s| s.id == step_id)
            .ok_or(format!("未找到步骤: {}", step_id))?;

        step.status = status;
        step.result = result;
        step.updated_at = Some(chrono::Utc::now().timestamp_millis());
        todo_list.updated_at = chrono::Utc::now().timestamp_millis();

        let is_all_done = todo_list.is_all_done();
        let completed = todo_list.completed_count();
        let total = todo_list.total_count();
        let next_step = todo_list.next_pending().map(|s| s.clone());
        // 🔧 P6修复：返回完整的 steps 数组，供前端显示当时的状态
        let steps_snapshot = todo_list.steps.clone();
        let title = todo_list.title.clone();

        set_todo_list(session_id, todo_list);

        let response = json!({
            "success": true,
            "stepId": step_id,
            "newStatus": status_str,
            "progress": format!("{}/{}", completed, total),
            "completedCount": completed,
            "totalCount": total,
            "isAllDone": is_all_done,
            "nextStep": next_step,
            "title": title,
            "steps": steps_snapshot,
            "message": if is_all_done {
                "🎉 所有任务已完成！".to_string()
            } else {
                format!("已更新步骤状态，进度: {}/{}", completed, total)
            }
        });

        // 如果还有未完成的任务，继续执行
        let continue_execution = !is_all_done;
        Ok((response, continue_execution))
    }

    /// 执行 todo_add
    fn execute_add(&self, args: &Value, session_id: &str) -> Result<(Value, bool), String> {
        let description = args
            .get("description")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: description")?
            .to_string();

        let after_step_id = args.get("afterStepId").and_then(|v| v.as_str());

        let mut todo_list =
            get_todo_list(session_id).ok_or("未找到任务列表，请先调用 todo_init")?;

        // 生成新步骤 ID
        let new_step_id = format!("step_{}", todo_list.steps.len() + 1);
        let new_step = TodoStep::new(new_step_id.clone(), description.clone());

        // 插入位置
        if let Some(after_id) = after_step_id {
            if let Some(pos) = todo_list.steps.iter().position(|s| s.id == after_id) {
                todo_list.steps.insert(pos + 1, new_step);
            } else {
                todo_list.steps.push(new_step);
            }
        } else {
            todo_list.steps.push(new_step);
        }

        todo_list.updated_at = chrono::Utc::now().timestamp_millis();

        let total = todo_list.total_count();
        let completed = todo_list.completed_count();
        let is_all_done = todo_list.is_all_done();
        // 🔧 P6修复：返回完整的 steps 数组，供前端显示当时的状态
        let steps_snapshot = todo_list.steps.clone();
        let title = todo_list.title.clone();

        set_todo_list(session_id, todo_list);

        let response = json!({
            "success": true,
            "stepId": new_step_id,
            "description": description,
            "totalSteps": total,
            "completedCount": completed,
            "totalCount": total,
            "isAllDone": is_all_done,
            "title": title,
            "steps": steps_snapshot,
            "message": format!("已添加新步骤: {}", description)
        });

        Ok((response, !is_all_done))
    }

    /// 执行 todo_get
    fn execute_get(&self, session_id: &str) -> Result<(Value, bool), String> {
        let todo_list = get_todo_list(session_id).ok_or("未找到任务列表，请先调用 todo_init")?;

        let completed = todo_list.completed_count();
        let total = todo_list.total_count();
        let is_all_done = todo_list.is_all_done();

        let response = json!({
            "success": true,
            "todoListId": todo_list.id,
            "title": todo_list.title,
            "progress": format!("{}/{}", completed, total),
            "completedCount": completed,
            "totalCount": total,
            "isAllDone": is_all_done,
            "steps": todo_list.steps,
            "nextStep": todo_list.next_pending(),
            "currentRunning": todo_list.current_running()
        });

        Ok((response, !is_all_done))
    }
}

impl Default for TodoListExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for TodoListExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        // 支持 builtin- 前缀和无前缀两种格式
        let stripped = strip_tool_namespace(tool_name);
        matches!(
            stripped,
            "todo_init" | "todo_update" | "todo_add" | "todo_get"
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

        // 使用 session_id 作为隔离键（如果为空则使用 message_id）
        let session_key = if ctx.session_id.is_empty() {
            &ctx.message_id
        } else {
            &ctx.session_id
        };

        // 执行工具（去除 builtin: 前缀后匹配）
        let tool_name = strip_tool_namespace(&call.name);
        let result = match tool_name {
            "todo_init" => self.execute_init(&call.arguments, session_key),
            "todo_update" => self.execute_update(&call.arguments, session_key),
            "todo_add" => self.execute_add(&call.arguments, session_key),
            "todo_get" => self.execute_get(session_key),
            _ => Err(format!("未知的 TODO 工具: {}", call.name)),
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok((output, continue_execution)) => {
                // 发射结束事件
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));

                log::info!(
                    "[TodoListExecutor] Tool {} completed: continue_execution={}",
                    call.name,
                    continue_execution
                );

                // 构建结果，包含 continue_execution 标志
                let mut tool_result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output.clone(),
                    duration_ms,
                );

                // 在 output 中嵌入 continue_execution 标志
                if let Some(obj) = tool_result.output.as_object_mut() {
                    obj.insert("continue_execution".to_string(), json!(continue_execution));
                }

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("[TodoListExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[TodoListExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // TODO 工具是低敏感的，无需审批
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "TodoListExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_todo_step_creation() {
        let step = TodoStep::new("step_1".to_string(), "测试步骤".to_string());
        assert_eq!(step.id, "step_1");
        assert_eq!(step.status, TodoStatus::Pending);
        assert!(step.result.is_none());
    }

    #[test]
    fn test_todo_list_creation() {
        let steps = vec![
            TodoStep::new("step_1".to_string(), "步骤1".to_string()),
            TodoStep::new("step_2".to_string(), "步骤2".to_string()),
        ];
        let list = TodoList::new("测试任务".to_string(), steps);

        assert_eq!(list.total_count(), 2);
        assert_eq!(list.completed_count(), 0);
        assert!(!list.is_all_done());
    }

    #[test]
    fn test_todo_list_completion() {
        let mut list = TodoList::new(
            "测试".to_string(),
            vec![TodoStep::new("step_1".to_string(), "步骤1".to_string())],
        );

        list.steps[0].status = TodoStatus::Completed;
        assert!(list.is_all_done());
        assert_eq!(list.completed_count(), 1);
    }

    #[test]
    fn test_schema_generation() {
        let schemas = get_all_schemas();
        assert_eq!(schemas.len(), 4);

        let init_schema = &schemas[0];
        assert_eq!(init_schema["function"]["name"], tool_names::TODO_INIT);
    }
}
