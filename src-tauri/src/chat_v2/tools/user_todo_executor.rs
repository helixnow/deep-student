//! 用户待办管理工具执行器
//!
//! 允许 LLM 管理用户的 VFS 待办列表和待办项。
//! 工具前缀：`user_todo_`
//!
//! ## 工具列表
//! - `user_todo_list_lists`: 列出所有待办列表
//! - `user_todo_create_item`: 创建待办项
//! - `user_todo_complete_item`: 完成待办项
//! - `user_todo_list_items`: 列出待办项
//! - `user_todo_get_summary`: 获取待办摘要

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::vfs::repos::VfsTodoRepo;
use crate::vfs::types::{VfsCreateTodoItemParams, VfsUpdateTodoItemParams};

// ============================================================================
// 常量
// ============================================================================

pub const USER_TODO_LIST_LISTS: &str = "user_todo_list_lists";
pub const USER_TODO_CREATE_ITEM: &str = "user_todo_create_item";
pub const USER_TODO_COMPLETE_ITEM: &str = "user_todo_complete_item";
pub const USER_TODO_LIST_ITEMS: &str = "user_todo_list_items";
pub const USER_TODO_GET_SUMMARY: &str = "user_todo_get_summary";
pub const USER_TODO_UPDATE_ITEM: &str = "user_todo_update_item";

// ============================================================================
// Schema
// ============================================================================

pub fn get_user_todo_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_LIST_LISTS,
                "description": "列出用户的所有待办列表。返回列表的ID、标题等信息。",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_CREATE_ITEM,
                "description": "在用户的待办列表中创建新的待办项。如果不指定 list_id，将使用默认收件箱。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "待办项标题"
                        },
                        "description": {
                            "type": "string",
                            "description": "详细描述（可选）"
                        },
                        "priority": {
                            "type": "string",
                            "enum": ["none", "low", "medium", "high", "urgent"],
                            "description": "优先级，默认 none"
                        },
                        "due_date": {
                            "type": "string",
                            "description": "截止日期，格式 YYYY-MM-DD（可选）"
                        },
                        "due_time": {
                            "type": "string",
                            "description": "截止时间，格式 HH:MM（可选）"
                        },
                        "list_id": {
                            "type": "string",
                            "description": "目标待办列表ID（可选，默认使用收件箱）"
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "标签列表（可选）"
                        }
                    },
                    "required": ["title"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_COMPLETE_ITEM,
                "description": "将待办项标记为已完成。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "item_id": {
                            "type": "string",
                            "description": "待办项ID"
                        }
                    },
                    "required": ["item_id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_LIST_ITEMS,
                "description": "列出待办列表中的待办项。可按列表ID筛选，也可查看今日、逾期等视图。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "list_id": {
                            "type": "string",
                            "description": "待办列表ID（可选）"
                        },
                        "view": {
                            "type": "string",
                            "enum": ["all", "today", "overdue", "upcoming", "completed"],
                            "description": "视图过滤，默认 all"
                        },
                        "include_completed": {
                            "type": "boolean",
                            "description": "是否包含已完成项，默认 false"
                        }
                    },
                    "required": []
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_GET_SUMMARY,
                "description": "获取用户待办事项的总览摘要，包括今日待办、逾期项、统计数据等。",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_UPDATE_ITEM,
                "description": "更新待办项的属性（标题、描述、优先级、日期等）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "item_id": {
                            "type": "string",
                            "description": "待办项ID"
                        },
                        "title": {
                            "type": "string",
                            "description": "新标题（可选）"
                        },
                        "description": {
                            "type": "string",
                            "description": "新描述（可选）"
                        },
                        "priority": {
                            "type": "string",
                            "enum": ["none", "low", "medium", "high", "urgent"],
                            "description": "新优先级（可选）"
                        },
                        "due_date": {
                            "type": "string",
                            "description": "新截止日期 YYYY-MM-DD（可选）"
                        },
                        "due_time": {
                            "type": "string",
                            "description": "新截止时间 HH:MM（可选）"
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "新标签列表（可选）"
                        }
                    },
                    "required": ["item_id"]
                }
            }
        }),
    ]
}

// ============================================================================
// UserTodoExecutor
// ============================================================================

pub struct UserTodoExecutor;

impl UserTodoExecutor {
    pub fn new() -> Self {
        Self
    }

    fn execute_list_lists(&self, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let lists = VfsTodoRepo::list_todo_lists(vfs_db).map_err(|e| e.to_string())?;

        let items: Vec<Value> = lists
            .iter()
            .map(|l| {
                json!({
                    "id": l.id,
                    "title": l.title,
                    "description": l.description,
                    "isDefault": l.is_default,
                    "isFavorite": l.is_favorite,
                })
            })
            .collect();

        Ok(json!({
            "success": true,
            "lists": items,
            "count": items.len(),
        }))
    }

    fn execute_create_item(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: title")?
            .to_string();

        let list_id = if let Some(id) = args.get("list_id").and_then(|v| v.as_str()) {
            id.to_string()
        } else {
            // 确保默认收件箱存在
            let inbox = VfsTodoRepo::ensure_default_inbox(vfs_db).map_err(|e| e.to_string())?;
            inbox.id
        };

        let params = VfsCreateTodoItemParams {
            todo_list_id: list_id.clone(),
            title: title.clone(),
            description: args
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            priority: args
                .get("priority")
                .and_then(|v| v.as_str())
                .unwrap_or("none")
                .to_string(),
            due_date: args
                .get("due_date")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            due_time: args
                .get("due_time")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            tags: args.get("tags").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            }),
            parent_id: None,
            attachments: None,
        };

        let item = VfsTodoRepo::create_todo_item(vfs_db, params).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "item": {
                "id": item.id,
                "title": item.title,
                "priority": item.priority,
                "dueDate": item.due_date,
                "dueTime": item.due_time,
                "listId": item.todo_list_id,
            },
            "message": format!("已创建待办项「{}」", title),
        }))
    }

    fn execute_complete_item(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let item_id = args
            .get("item_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: item_id")?;

        // 幂等语义：已完成则直接返回成功，不会 toggle 回 pending
        let existing = VfsTodoRepo::get_todo_item(vfs_db, item_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("待办项 {} 不存在", item_id))?;

        if existing.status == "completed" {
            return Ok(json!({
                "success": true,
                "item": {
                    "id": existing.id,
                    "title": existing.title,
                    "status": existing.status,
                },
                "message": format!("待办项「{}」已经是完成状态", existing.title),
            }));
        }

        let item = VfsTodoRepo::toggle_todo_item(vfs_db, item_id).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "item": {
                "id": item.id,
                "title": item.title,
                "status": item.status,
            },
            "message": format!("待办项「{}」已标记为完成", item.title),
        }))
    }

    fn execute_list_items(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let view = args.get("view").and_then(|v| v.as_str()).unwrap_or("all");
        let include_completed = args
            .get("include_completed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let items = match view {
            "today" => VfsTodoRepo::list_today_items(vfs_db, include_completed)
                .map_err(|e| e.to_string())?,
            "overdue" => VfsTodoRepo::list_overdue_items(vfs_db, include_completed)
                .map_err(|e| e.to_string())?,
            "upcoming" => VfsTodoRepo::list_upcoming_items(vfs_db, 7, include_completed)
                .map_err(|e| e.to_string())?,
            "completed" => VfsTodoRepo::list_completed_items(
                vfs_db,
                args.get("list_id").and_then(|v| v.as_str()),
            )
            .map_err(|e| e.to_string())?,
            _ => {
                if let Some(list_id) = args.get("list_id").and_then(|v| v.as_str()) {
                    VfsTodoRepo::list_items_by_list(vfs_db, list_id, include_completed)
                        .map_err(|e| e.to_string())?
                } else {
                    // Default: list today + overdue
                    let mut all = VfsTodoRepo::list_today_items(vfs_db, include_completed)
                        .map_err(|e| e.to_string())?;
                    let overdue = VfsTodoRepo::list_overdue_items(vfs_db, include_completed)
                        .map_err(|e| e.to_string())?;
                    all.extend(overdue);
                    all
                }
            }
        };

        let items_json: Vec<Value> = items
            .iter()
            .map(|i| {
                json!({
                    "id": i.id,
                    "title": i.title,
                    "status": i.status,
                    "priority": i.priority,
                    "dueDate": i.due_date,
                    "dueTime": i.due_time,
                    "listId": i.todo_list_id,
                })
            })
            .collect();

        Ok(json!({
            "success": true,
            "items": items_json,
            "count": items_json.len(),
            "view": view,
        }))
    }

    fn execute_get_summary(&self, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let summary = VfsTodoRepo::get_active_todo_summary(vfs_db).map_err(|e| e.to_string())?;

        match summary {
            Some(s) => {
                let formatted = VfsTodoRepo::format_active_summary_for_prompt(&s);
                Ok(json!({
                    "success": true,
                    "stats": {
                        "totalPending": s.stats.total_pending,
                        "todayDue": s.stats.today_due,
                        "overdueCount": s.stats.overdue_count,
                        "todayCompleted": s.stats.today_completed,
                    },
                    "todayItems": s.today_items.len(),
                    "overdueItems": s.overdue_items.len(),
                    "formattedSummary": formatted,
                }))
            }
            None => Ok(json!({
                "success": true,
                "stats": { "totalPending": 0, "todayDue": 0, "overdueCount": 0, "todayCompleted": 0 },
                "message": "没有待办事项",
            })),
        }
    }

    fn execute_update_item(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let item_id = args
            .get("item_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: item_id")?;

        let params = VfsUpdateTodoItemParams {
            title: args
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            description: args
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            status: None,
            priority: args
                .get("priority")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            due_date: args
                .get("due_date")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            due_time: args
                .get("due_time")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            reminder: None,
            tags: args.get("tags").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            }),
            parent_id: None,
            attachments: None,
            repeat_json: None,
            estimated_pomodoros: None,
            completed_pomodoros: None,
        };

        let item =
            VfsTodoRepo::update_todo_item(vfs_db, item_id, params).map_err(|e| e.to_string())?;

        Ok(json!({
            "success": true,
            "item": {
                "id": item.id,
                "title": item.title,
                "priority": item.priority,
                "dueDate": item.due_date,
                "dueTime": item.due_time,
            },
            "message": format!("已更新待办项「{}」", item.title),
        }))
    }
}

impl Default for UserTodoExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for UserTodoExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        matches!(
            stripped,
            "user_todo_list_lists"
                | "user_todo_create_item"
                | "user_todo_complete_item"
                | "user_todo_list_items"
                | "user_todo_get_summary"
                | "user_todo_update_item"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let tool_name = strip_tool_namespace(&call.name);
        let result = match tool_name {
            "user_todo_list_lists" => self.execute_list_lists(ctx),
            "user_todo_create_item" => self.execute_create_item(&call.arguments, ctx),
            "user_todo_complete_item" => self.execute_complete_item(&call.arguments, ctx),
            "user_todo_list_items" => self.execute_list_items(&call.arguments, ctx),
            "user_todo_get_summary" => self.execute_get_summary(ctx),
            "user_todo_update_item" => self.execute_update_item(&call.arguments, ctx),
            _ => Err(format!("未知的用户待办工具: {}", call.name)),
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));

                let tool_result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                );

                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("[UserTodoExecutor] Failed to save tool block: {}", e);
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

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[UserTodoExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "UserTodoExecutor"
    }
}
