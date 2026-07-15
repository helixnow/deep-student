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
use serde_json::{json, Value};
use tauri::Emitter;

use super::arg_utils::{ensure_localized_error, with_localized_message};
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::vfs::repos::VfsTodoRepo;
use crate::vfs::types::{
    VfsCreateTodoItemParams, VfsCreateTodoListParams, VfsTodoItem, VfsTodoList,
    VfsUpdateTodoItemParams, VfsUpdateTodoListParams,
};

const MAX_PAGE_SIZE: usize = 20;
const MAX_CONTENT_CHARS: usize = 2_000;

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("缺少必需参数: {key}"))
}

fn validate_text_len(value: &str, key: &str, max_chars: usize) -> Result<(), String> {
    if value.chars().count() > max_chars {
        return Err(format!("参数 {key} 最多允许 {max_chars} 个字符"));
    }
    Ok(())
}

fn optional_text(args: &Value, key: &str, max_chars: usize) -> Result<Option<String>, String> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => {
            validate_text_len(value, key, max_chars)?;
            Ok(Some(value.clone()))
        }
        Some(_) => Err(format!("参数 {key} 必须是字符串")),
    }
}

fn parse_tags(args: &Value) -> Result<Option<Vec<String>>, String> {
    let Some(value) = args.get("tags") else {
        return Ok(None);
    };
    let values = value.as_array().ok_or("参数 tags 必须是字符串数组")?;
    if values.len() > 50 {
        return Err("参数 tags 最多允许 50 项".to_string());
    }
    values
        .iter()
        .map(|value| {
            let value = value.as_str().ok_or("参数 tags 必须全部是字符串")?;
            validate_text_len(value, "tags[]", 200)?;
            Ok(value.to_string())
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn pagination(args: &Value) -> Result<(usize, usize, usize), String> {
    let page = args.get("page").and_then(Value::as_u64).unwrap_or(1);
    let page_size = args
        .get("page_size")
        .or_else(|| args.get("pageSize"))
        .and_then(Value::as_u64)
        .unwrap_or(MAX_PAGE_SIZE as u64);
    if page == 0 || !(1..=MAX_PAGE_SIZE as u64).contains(&page_size) {
        return Err(format!(
            "page 必须 >= 1，page_size 必须在 1..={MAX_PAGE_SIZE}"
        ));
    }
    let page = usize::try_from(page).map_err(|_| "page 超出范围".to_string())?;
    let page_size = usize::try_from(page_size).map_err(|_| "page_size 超出范围".to_string())?;
    let offset = page
        .checked_sub(1)
        .and_then(|value| value.checked_mul(page_size))
        .ok_or_else(|| "分页参数超出范围".to_string())?;
    Ok((page, page_size, offset))
}

fn todo_view(args: &Value) -> Result<&str, String> {
    let view = args.get("view").and_then(Value::as_str).unwrap_or("all");
    match view {
        "all" | "today" | "overdue" | "upcoming" | "completed" => Ok(view),
        other => Err(format!("不支持的 view: {other}")),
    }
}

fn truncate_content(value: Option<&str>) -> (Option<String>, bool) {
    let Some(value) = value else {
        return (None, false);
    };
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(MAX_CONTENT_CHARS).collect();
    let was_truncated = chars.next().is_some();
    (Some(truncated), was_truncated)
}

fn truncate_required_content(value: &str) -> (String, bool) {
    let (value, truncated) = truncate_content(Some(value));
    (value.unwrap_or_default(), truncated)
}

fn todo_list_json(list: &VfsTodoList) -> Value {
    let (description, content_truncated) = truncate_content(list.description.as_deref());
    let (title, title_truncated) = truncate_required_content(&list.title);
    let (icon, icon_truncated) = truncate_content(list.icon.as_deref());
    let (color, color_truncated) = truncate_content(list.color.as_deref());
    let fields_truncated: Vec<&str> = [
        ("title", title_truncated),
        ("description", content_truncated),
        ("icon", icon_truncated),
        ("color", color_truncated),
    ]
    .into_iter()
    .filter_map(|(field, truncated)| truncated.then_some(field))
    .collect();
    json!({
        "id": list.id,
        "title": title,
        "description": description,
        "icon": icon,
        "color": color,
        "sortOrder": list.sort_order,
        "isDefault": list.is_default,
        "isFavorite": list.is_favorite,
        "createdAt": list.created_at,
        "updatedAt": list.updated_at,
        "deletedAt": list.deleted_at,
        "contentTruncated": content_truncated,
        "fieldsTruncated": fields_truncated,
    })
}

fn todo_item_json(item: &VfsTodoItem) -> Value {
    let (description, content_truncated) = truncate_content(item.description.as_deref());
    let (title, title_truncated) = truncate_required_content(&item.title);
    let (due_date, due_date_truncated) = truncate_content(item.due_date.as_deref());
    let (due_time, due_time_truncated) = truncate_content(item.due_time.as_deref());
    let (reminder, reminder_truncated) = truncate_content(item.reminder.as_deref());
    let mut tags_truncated = false;
    let tags = serde_json::from_str::<Vec<Value>>(&item.tags_json)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .map(|value| {
            let (value, truncated) = truncate_required_content(&value);
            tags_truncated |= truncated;
            value
        })
        .collect::<Vec<_>>();
    let fields_truncated: Vec<&str> = [
        ("title", title_truncated),
        ("description", content_truncated),
        ("tags", tags_truncated),
        ("dueDate", due_date_truncated),
        ("dueTime", due_time_truncated),
        ("reminder", reminder_truncated),
    ]
    .into_iter()
    .filter_map(|(field, truncated)| truncated.then_some(field))
    .collect();
    json!({
        "id": item.id,
        "listId": item.todo_list_id,
        "title": title,
        "description": description,
        "status": item.status,
        "priority": item.priority,
        "dueDate": due_date,
        "dueTime": due_time,
        "reminder": reminder,
        "tags": tags,
        "sortOrder": item.sort_order,
        "parentId": item.parent_id,
        "completedAt": item.completed_at,
        "repeat": item.repeat_json.as_deref().and_then(crate::vfs::repos::todo_repo::parse_repeat_rule).map(|rule| json!({
            "freq": rule.freq,
            "interval": rule.interval,
            "byWeekday": rule.by_weekday,
        })),
        "createdAt": item.created_at,
        "updatedAt": item.updated_at,
        "deletedAt": item.deleted_at,
        "contentTruncated": content_truncated,
        "fieldsTruncated": fields_truncated,
    })
}

fn paginated_payload(
    key: &str,
    values: Vec<Value>,
    total: usize,
    page: usize,
    page_size: usize,
) -> Value {
    let count = values.len();
    let has_more = page
        .checked_mul(page_size)
        .is_some_and(|consumed| consumed < total);
    let mut payload = json!({
        "success": true,
        "count": count,
        "total": total,
        "page": page,
        "page_size": page_size,
        "has_more": has_more,
        "truncated": has_more,
    });
    payload
        .as_object_mut()
        .expect("pagination payload is an object")
        .insert(key.to_string(), Value::Array(values));
    payload
}

fn with_undo_contract(
    mut payload: Value,
    reversible: bool,
    restore_with: Option<Value>,
    undo_reason: Option<&str>,
    reversible_with_approval: bool,
) -> Value {
    let object = payload
        .as_object_mut()
        .expect("tool result payload must be an object");
    object.insert("reversible".to_string(), json!(reversible));
    object.insert(
        "restoreWith".to_string(),
        restore_with.unwrap_or(Value::Null),
    );
    if let Some(reason) = undo_reason {
        object.insert("undoReason".to_string(), json!(reason));
    }
    if reversible_with_approval {
        object.insert("reversibleWithApproval".to_string(), json!(true));
    }
    payload
}

/// 通知前端待办数据已被 AI 修改（前端据此刷新打开中的 Todo 页面）
///
/// R1-04 / R2-01 / docs/dev/acr/DESIGN.md §5.6：载荷含 entityIds；runId = toolCallId。
fn emit_todo_changed(ctx: &ExecutionContext, action: &str, entity_ids: &[String]) {
    let payload = json!({
        "source": "ai",
        "action": action,
        "entityIds": entity_ids,
        "runId": ctx.run_id(),
    });
    if let Err(e) = ctx.window.emit("todo://changed", payload) {
        log::debug!("[UserTodoExecutor] Failed to emit todo://changed: {}", e);
    }
}

fn todo_occ_required(action: &str) -> String {
    with_localized_message(
        json!({
            "code": "TODO_OCC_REQUIRED",
            "hint": "重新调用 user_todo_list_items 获取 updatedAt 后再操作 / Call user_todo_list_items again and use its updatedAt value.",
            "retryable": false,
        }),
        "chat.tools.todo.occ_required",
        json!({ "action": action, "requiredField": "expected_updated_at" }),
        format!("{action}前必须提供 expected_updated_at"),
        "expected_updated_at is required before this todo operation.",
    )
    .to_string()
}

fn todo_conflict(message: impl Into<String>, current: Option<Value>) -> String {
    let message = message.into();
    let current_updated_at = current
        .as_ref()
        .and_then(|value| value.get("updatedAt"))
        .cloned()
        .unwrap_or(Value::Null);
    with_localized_message(
        json!({
            "code": "TODO_CONFLICT",
            "hint": "待办已被其他写入更新；重新调用 user_todo_list_items 后再操作，勿盲目重试 / The todo changed elsewhere. Read it again before retrying.",
            "retryable": false,
            "current": current.unwrap_or(Value::Null),
            "currentUpdatedAt": current_updated_at,
        }),
        "chat.tools.todo.conflict",
        json!({ "detail": message }),
        message,
        "The todo was changed by another write. Read its latest version before retrying.",
    )
    .to_string()
}

fn todo_item_conflict(
    vfs_db: &crate::vfs::VfsDatabase,
    item_id: &str,
    message: impl Into<String>,
) -> String {
    let current = VfsTodoRepo::get_todo_item(vfs_db, item_id)
        .ok()
        .flatten()
        .map(|item| todo_item_json(&item));
    todo_conflict(message, current)
}

fn todo_list_conflict(
    vfs_db: &crate::vfs::VfsDatabase,
    list_id: &str,
    message: impl Into<String>,
) -> String {
    let current = VfsTodoRepo::get_todo_list(vfs_db, list_id)
        .ok()
        .flatten()
        .map(|list| todo_list_json(&list));
    todo_conflict(message, current)
}

fn localized_todo_failure(error: impl Into<String>) -> String {
    ensure_localized_error(
        error,
        "TODO_OPERATION_FAILED",
        "chat.tools.todo.error",
        "待办操作失败",
        "The todo operation failed.",
    )
}

fn expected_todo_revision<'a>(args: &'a Value, action: &str) -> Result<&'a str, String> {
    args.get("expected_updated_at")
        .or_else(|| args.get("expectedUpdatedAt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| todo_occ_required(action))
}

/// Preserve the difference between an omitted field (leave unchanged) and an
/// explicit clear request. The local Skill schema cannot express JSON null,
/// so clear operations use dedicated boolean flags.
fn optional_clearable_string(
    args: &Value,
    key: &str,
    clear_key: &str,
) -> Result<Option<String>, String> {
    let clear = args
        .get(clear_key)
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if clear && args.get(key).is_some() {
        return Err(format!("参数 {key} 与 {clear_key}=true 不能同时提供"));
    }
    if clear {
        return Ok(Some(String::new()));
    }
    match args.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => {
            validate_text_len(value, key, MAX_CONTENT_CHARS)?;
            Ok(Some(value.clone()))
        }
        Some(_) => Err(format!("参数 {key} 必须是字符串")),
    }
}

fn optional_repeat_json(args: &Value) -> Result<Option<String>, String> {
    let clear = args
        .get("clear_repeat")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if clear && args.get("repeat").is_some() {
        return Err("参数 repeat 与 clear_repeat=true 不能同时提供".to_string());
    }
    if clear {
        return Ok(Some(String::new()));
    }
    let Some(value) = args.get("repeat").or_else(|| args.get("repeat_json")) else {
        return Ok(None);
    };

    match value {
        Value::String(value) => {
            validate_text_len(value, "repeat", MAX_CONTENT_CHARS)?;
            Ok(Some(value.clone()))
        }
        Value::Object(_) => {
            let value = serde_json::to_string(value)
                .map_err(|error| format!("repeat 序列化失败: {error}"))?;
            validate_text_len(&value, "repeat", MAX_CONTENT_CHARS)?;
            Ok(Some(value))
        }
        _ => Err("参数 repeat 必须是重复规则对象或 JSON 字符串".to_string()),
    }
}

// ============================================================================
// 常量
// ============================================================================

pub const USER_TODO_LIST_LISTS: &str = "user_todo_list_lists";
pub const USER_TODO_CREATE_ITEM: &str = "user_todo_create_item";
pub const USER_TODO_COMPLETE_ITEM: &str = "user_todo_complete_item";
pub const USER_TODO_LIST_ITEMS: &str = "user_todo_list_items";
pub const USER_TODO_GET_SUMMARY: &str = "user_todo_get_summary";
pub const USER_TODO_UPDATE_ITEM: &str = "user_todo_update_item";
pub const USER_TODO_DELETE_ITEM: &str = "user_todo_delete_item";
pub const USER_TODO_CREATE_LIST: &str = "user_todo_create_list";
pub const USER_TODO_UPDATE_LIST: &str = "user_todo_update_list";
pub const USER_TODO_DELETE_LIST: &str = "user_todo_delete_list";
pub const USER_TODO_SEARCH: &str = "user_todo_search";
pub const USER_TODO_LIST_TRASH: &str = "user_todo_list_trash";
pub const USER_TODO_RESTORE: &str = "user_todo_restore";
pub const USER_TODO_REORDER: &str = "user_todo_reorder";

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
                    "properties": {
                        "page": { "type": "integer", "minimum": 1, "default": 1 },
                        "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                    },
                    "additionalProperties": false,
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
                        "reminder": {
                            "type": "string",
                            "description": "提醒时间，格式 YYYY-MM-DDTHH:MM（可选）"
                        },
                        "list_id": {
                            "type": "string",
                            "description": "目标待办列表ID（可选，默认使用收件箱）"
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "标签列表（可选）"
                        },
                        "parent_id": {
                            "type": "string",
                            "description": "父待办项 ID（可选，用于创建子任务）"
                        },
                        "repeat": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "freq": { "type": "string", "enum": ["daily", "weekly", "monthly", "yearly", "weekdays"] },
                                "interval": { "type": "integer", "minimum": 1, "maximum": 999 },
                                "byWeekday": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 }, "uniqueItems": true }
                            },
                            "required": ["freq"],
                            "description": "重复规则（可选）"
                        }
                    },
                    "required": ["title"],
                    "additionalProperties": false
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
                        },
                        "expected_updated_at": {
                            "type": "string",
                            "minLength": 1,
                            "description": "list_items 返回的 updatedAt OCC 基线"
                        }
                    },
                    "required": ["item_id", "expected_updated_at"],
                    "additionalProperties": false
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
                        },
                        "page": { "type": "integer", "minimum": 1, "default": 1 },
                        "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                    },
                    "required": [],
                    "additionalProperties": false
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
                "name": USER_TODO_DELETE_ITEM,
                "description": "将待办项软删除到回收站（Medium，可恢复；强制 OCC）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "item_id": { "type": "string", "minLength": 1 },
                        "expected_updated_at": { "type": "string", "minLength": 1 }
                    },
                    "required": ["item_id", "expected_updated_at"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_CREATE_LIST,
                "description": "创建待办清单。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                        "description": { "type": "string", "maxLength": 2000 },
                        "icon": { "type": "string", "maxLength": 64 },
                        "color": { "type": "string", "maxLength": 32 }
                    },
                    "required": ["title"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_UPDATE_LIST,
                "description": "更新待办清单（强制 OCC）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "list_id": { "type": "string", "minLength": 1 },
                        "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                        "description": { "type": "string", "maxLength": 2000 },
                        "icon": { "type": "string", "maxLength": 64 },
                        "color": { "type": "string", "maxLength": 32 },
                        "expected_updated_at": { "type": "string", "minLength": 1 }
                    },
                    "required": ["list_id", "expected_updated_at"],
                    "anyOf": [
                        { "required": ["title"] },
                        { "required": ["description"] },
                        { "required": ["icon"] },
                        { "required": ["color"] }
                    ],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_DELETE_LIST,
                "description": "将非默认清单及其待办软删除到回收站（High，每次 ask_user，不可记住授权；强制 OCC）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "list_id": { "type": "string", "minLength": 1 },
                        "expected_updated_at": { "type": "string", "minLength": 1 }
                    },
                    "required": ["list_id", "expected_updated_at"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_SEARCH,
                "description": "跨清单分页搜索待办项（每页最多 20 条）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "minLength": 1, "maxLength": 200 },
                        "page": { "type": "integer", "minimum": 1, "default": 1 },
                        "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_LIST_TRASH,
                "description": "分页列出待办项或清单回收站。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "entity_type": { "type": "string", "enum": ["item", "list"] },
                        "page": { "type": "integer", "minimum": 1, "default": 1 },
                        "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                    },
                    "required": ["entity_type"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_RESTORE,
                "description": "从回收站恢复一个待办项或清单（Medium）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "entity_type": { "type": "string", "enum": ["item", "list"] },
                        "entity_id": { "type": "string", "minLength": 1 }
                    },
                    "required": ["entity_type", "entity_id"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": USER_TODO_REORDER,
                "description": "按 item_ids 的完整顺序重排清单待办项（Medium，强制 OCC）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "list_id": { "type": "string", "minLength": 1 },
                        "item_ids": { "type": "array", "minItems": 1, "maxItems": 500, "items": { "type": "string", "minLength": 1 } },
                        "expected_updated_at": { "type": "string", "minLength": 1 }
                    },
                    "required": ["list_id", "item_ids", "expected_updated_at"],
                    "additionalProperties": false
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
                        "reminder": {
                            "type": "string",
                            "description": "新提醒时间 YYYY-MM-DDTHH:MM；省略保持不变"
                        },
                        "clear_reminder": {
                            "type": "boolean",
                            "description": "设为 true 清空提醒；不可与 reminder 同时提供"
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "新标签列表（可选）"
                        },
                        "parent_id": {
                            "type": "string",
                            "description": "新父待办项 ID；省略保持不变"
                        },
                        "clear_parent": {
                            "type": "boolean",
                            "description": "设为 true 移到顶层；不可与 parent_id 同时提供"
                        },
                        "repeat": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "freq": { "type": "string", "enum": ["daily", "weekly", "monthly", "yearly", "weekdays"] },
                                "interval": { "type": "integer", "minimum": 1, "maximum": 999 },
                                "byWeekday": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 } }
                            },
                            "required": ["freq"],
                            "description": "新重复规则；省略保持不变"
                        },
                        "clear_repeat": {
                            "type": "boolean",
                            "description": "设为 true 清空重复规则；不可与 repeat 同时提供"
                        },
                        "expected_updated_at": {
                            "type": "string",
                            "minLength": 1,
                            "description": "list_items 返回的 updatedAt OCC 基线"
                        }
                    },
                    "required": ["item_id", "expected_updated_at"],
                    "additionalProperties": false
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

    fn execute_list_lists(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let lists = VfsTodoRepo::list_todo_lists(vfs_db).map_err(|e| e.to_string())?;
        let (page, page_size, offset) = pagination(args)?;
        let total = lists.len();
        let values = lists
            .iter()
            .skip(offset)
            .take(page_size)
            .map(todo_list_json)
            .collect();
        Ok(paginated_payload("lists", values, total, page, page_size))
    }

    fn execute_create_item(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: title")?
            .to_string();
        validate_text_len(&title, "title", 200)?;

        let list_id = if args.get("list_id").is_some() {
            let id = required_string(args, "list_id")?;
            validate_text_len(&id, "list_id", 512)?;
            id
        } else {
            // 确保默认收件箱存在
            let inbox = VfsTodoRepo::ensure_default_inbox(vfs_db).map_err(|e| e.to_string())?;
            inbox.id
        };

        let params = VfsCreateTodoItemParams {
            todo_list_id: list_id.clone(),
            title: title.clone(),
            description: optional_text(args, "description", MAX_CONTENT_CHARS)?,
            priority: optional_text(args, "priority", 16)?.unwrap_or_else(|| "none".to_string()),
            due_date: optional_text(args, "due_date", 32)?,
            due_time: optional_text(args, "due_time", 32)?,
            reminder: optional_text(args, "reminder", 64)?,
            tags: parse_tags(args)?,
            parent_id: optional_text(args, "parent_id", 512)?
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            attachments: None,
            repeat_json: optional_repeat_json(args)?.filter(|value| !value.trim().is_empty()),
        };

        let item = VfsTodoRepo::create_todo_item(vfs_db, params).map_err(|e| e.to_string())?;
        emit_todo_changed(
            ctx,
            "create_item",
            &[item.id.clone(), item.todo_list_id.clone()],
        );

        Ok(with_localized_message(
            json!({
                "success": true,
                "item": todo_item_json(&item),
                "previous": Value::Null,
                "reversible": true,
                "restoreWith": {
                    "tool": USER_TODO_DELETE_ITEM,
                    "arguments": { "item_id": item.id, "expected_updated_at": item.updated_at }
                },
            }),
            "chat.tools.todo.item_created",
            json!({ "title": title }),
            format!("已创建待办项「{}」", title),
            format!("Created todo item \"{}\".", title),
        ))
    }

    fn execute_complete_item(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let item_id = args
            .get("item_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: item_id")?;
        let expected_updated_at = expected_todo_revision(args, "完成待办")?;

        // 幂等语义：已完成则直接返回成功，不会 toggle 回 pending
        let existing = VfsTodoRepo::get_todo_item(vfs_db, item_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("待办项 {} 不存在", item_id))?;

        if existing.updated_at != expected_updated_at {
            return Err(todo_conflict(
                "待办已被其他写入更新",
                Some(todo_item_json(&existing)),
            ));
        }

        if existing.status == "completed" {
            let display_title = truncate_required_content(&existing.title).0;
            return Ok(with_undo_contract(
                with_localized_message(
                    json!({
                        "success": true,
                        "item": todo_item_json(&existing),
                        "previous": todo_item_json(&existing),
                    }),
                    "chat.tools.todo.item_already_completed",
                    json!({ "title": display_title }),
                    format!("待办项「{}」已经是完成状态", display_title),
                    format!("Todo item \"{}\" is already completed.", display_title),
                ),
                false,
                None,
                Some("本次调用未产生状态变化，无需撤销"),
                false,
            ));
        }

        let item =
            VfsTodoRepo::toggle_todo_item(vfs_db, item_id, Some(expected_updated_at.to_string()))
                .map_err(|e| {
                let message = e.to_string();
                if message.contains("TODO_CONFLICT") {
                    todo_item_conflict(vfs_db, item_id, message)
                } else {
                    message
                }
            })?;
        emit_todo_changed(
            ctx,
            "complete_item",
            &[item.id.clone(), item.todo_list_id.clone()],
        );
        let display_title = truncate_required_content(&item.title).0;

        Ok(with_undo_contract(
            with_localized_message(
                json!({
                    "success": true,
                    "item": todo_item_json(&item),
                    "previous": todo_item_json(&existing),
                }),
                "chat.tools.todo.item_completed",
                json!({ "title": display_title }),
                format!("待办项「{}」已标记为完成", display_title),
                format!("Marked todo item \"{}\" as completed.", display_title),
            ),
            false,
            None,
            Some("update_item 工具不暴露 status，无法安全重放未完成状态"),
            false,
        ))
    }

    fn execute_list_items(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let view = todo_view(args)?;
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
            "all" => {
                if let Some(list_id) = args.get("list_id").and_then(|v| v.as_str()) {
                    VfsTodoRepo::list_items_by_list(vfs_db, list_id, include_completed)
                        .map_err(|e| e.to_string())?
                } else {
                    let mut items =
                        VfsTodoRepo::list_all_pending_items(vfs_db).map_err(|e| e.to_string())?;
                    if include_completed {
                        items.extend(
                            VfsTodoRepo::list_completed_items(vfs_db, None)
                                .map_err(|e| e.to_string())?,
                        );
                    }
                    items
                }
            }
            other => return Err(format!("不支持的 view: {other}")),
        };

        let (page, page_size, offset) = pagination(args)?;
        let total = items.len();
        let values = items
            .iter()
            .skip(offset)
            .take(page_size)
            .map(todo_item_json)
            .collect();
        let mut payload = paginated_payload("items", values, total, page, page_size);
        payload["view"] = json!(view);
        Ok(payload)
    }

    fn execute_get_summary(&self, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let summary = VfsTodoRepo::get_active_todo_summary(vfs_db).map_err(|e| e.to_string())?;

        match summary {
            Some(s) => {
                let formatted = VfsTodoRepo::format_active_summary_for_prompt(&s);
                let (formatted, formatted_truncated) = truncate_required_content(&formatted);
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
                    "fieldsTruncated": if formatted_truncated { json!(["formattedSummary"]) } else { json!([]) },
                }))
            }
            None => Ok(with_localized_message(
                json!({
                    "success": true,
                    "stats": { "totalPending": 0, "todayDue": 0, "overdueCount": 0, "todayCompleted": 0 },
                }),
                "chat.tools.todo.empty",
                json!({}),
                "没有待办事项",
                "There are no todo items.",
            )),
        }
    }

    fn execute_update_item(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        let item_id = args
            .get("item_id")
            .and_then(|v| v.as_str())
            .ok_or("缺少必需参数: item_id")?;
        let expected_updated_at = expected_todo_revision(args, "更新待办")?;
        let previous = VfsTodoRepo::get_todo_item(vfs_db, item_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("待办项 {item_id} 不存在"))?;

        let title = optional_text(args, "title", 200)?;
        if title
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("参数 title 不得为空".to_string());
        }
        let params = VfsUpdateTodoItemParams {
            title,
            description: optional_text(args, "description", MAX_CONTENT_CHARS)?,
            status: None,
            priority: optional_text(args, "priority", 16)?,
            due_date: optional_text(args, "due_date", 32)?,
            due_time: optional_text(args, "due_time", 32)?,
            reminder: optional_clearable_string(args, "reminder", "clear_reminder")?,
            tags: parse_tags(args)?,
            parent_id: optional_clearable_string(args, "parent_id", "clear_parent")?,
            attachments: None,
            repeat_json: optional_repeat_json(args)?,
            estimated_pomodoros: None,
            completed_pomodoros: None,
            // ACR R2-01：透传可选 OCC 基线（snake / camel）
            expected_updated_at: Some(expected_updated_at.to_string()),
        };

        let item = VfsTodoRepo::update_todo_item(vfs_db, item_id, params).map_err(|e| {
            let msg = e.to_string();
            if msg.contains("TODO_CONFLICT") {
                todo_item_conflict(vfs_db, item_id, msg)
            } else {
                msg
            }
        })?;
        emit_todo_changed(
            ctx,
            "update_item",
            &[item.id.clone(), item.todo_list_id.clone()],
        );
        let display_title = truncate_required_content(&item.title).0;

        Ok(with_undo_contract(
            with_localized_message(
                json!({
                    "success": true,
                    "updatedAt": item.updated_at.clone(),
                    "item": todo_item_json(&item),
                    "previous": todo_item_json(&previous),
                }),
                "chat.tools.todo.item_updated",
                json!({ "title": display_title }),
                format!("已更新待办项「{}」", display_title),
                format!("Updated todo item \"{}\".", display_title),
            ),
            false,
            None,
            Some("部分字段采用三态清空语义，当前工具无法无损重放所有旧字段"),
            false,
        ))
    }

    fn execute_delete_item(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let item_id = required_string(args, "item_id")?;
        let expected = expected_todo_revision(args, "删除待办")?;
        let previous = VfsTodoRepo::delete_todo_item_if_version(vfs_db, &item_id, expected)
            .map_err(|error| {
                let message = error.to_string();
                if message.contains("TODO_CONFLICT") {
                    todo_item_conflict(vfs_db, &item_id, message)
                } else {
                    message
                }
            })?;
        emit_todo_changed(
            ctx,
            "delete_item",
            &[previous.id.clone(), previous.todo_list_id.clone()],
        );
        Ok(json!({
            "success": true,
            "itemId": previous.id,
            "listId": previous.todo_list_id,
            "softDeleted": true,
            "previous": todo_item_json(&previous),
            "reversible": true,
            "restoreWith": { "tool": USER_TODO_RESTORE, "arguments": { "entity_type": "item", "entity_id": previous.id } }
        }))
    }

    fn execute_create_list(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let title = required_string(args, "title")?;
        validate_text_len(&title, "title", 200)?;
        let list = VfsTodoRepo::create_todo_list(
            vfs_db,
            VfsCreateTodoListParams {
                title,
                description: optional_text(args, "description", MAX_CONTENT_CHARS)?,
                icon: optional_text(args, "icon", 64)?,
                color: optional_text(args, "color", 32)?,
                is_default: false,
            },
        )
        .map_err(|e| e.to_string())?;
        emit_todo_changed(ctx, "create_list", &[list.id.clone()]);
        Ok(with_undo_contract(
            json!({
                "success": true,
                "list": todo_list_json(&list),
                "previous": Value::Null,
            }),
            false,
            Some(
                json!({ "tool": USER_TODO_DELETE_LIST, "arguments": { "list_id": list.id, "expected_updated_at": list.updated_at } }),
            ),
            Some("撤销创建需要执行 High 风险的清单删除并重新取得用户确认"),
            true,
        ))
    }

    fn execute_update_list(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let list_id = required_string(args, "list_id")?;
        let expected = expected_todo_revision(args, "更新清单")?;
        if !["title", "description", "icon", "color"]
            .iter()
            .any(|key| args.get(*key).is_some())
        {
            return Err("更新清单时至少提供 title/description/icon/color 之一".to_string());
        }
        let title = optional_text(args, "title", 200)?;
        if title
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("参数 title 不得为空".to_string());
        }
        let (previous, current) = VfsTodoRepo::update_todo_list_if_version(
            vfs_db,
            &list_id,
            VfsUpdateTodoListParams {
                title,
                description: optional_text(args, "description", MAX_CONTENT_CHARS)?,
                icon: optional_text(args, "icon", 64)?,
                color: optional_text(args, "color", 32)?,
            },
            expected,
        )
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("TODO_CONFLICT") {
                todo_list_conflict(vfs_db, &list_id, message)
            } else {
                message
            }
        })?;
        emit_todo_changed(ctx, "update_list", &[current.id.clone()]);
        Ok(with_undo_contract(
            json!({
                "success": true,
                "list": todo_list_json(&current),
                "previous": todo_list_json(&previous),
            }),
            false,
            None,
            Some("当前清单更新参数无法表达所有可选字段的精确清空/恢复"),
            false,
        ))
    }

    fn execute_delete_list(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let list_id = required_string(args, "list_id")?;
        let expected = expected_todo_revision(args, "删除清单")?;
        let previous = VfsTodoRepo::delete_todo_list_if_version(vfs_db, &list_id, expected)
            .map_err(|error| {
                let message = error.to_string();
                if message.contains("TODO_CONFLICT") {
                    todo_list_conflict(vfs_db, &list_id, message)
                } else {
                    message
                }
            })?;
        emit_todo_changed(ctx, "delete_list", &[previous.id.clone()]);
        Ok(json!({
            "success": true,
            "listId": previous.id,
            "softDeleted": true,
            "previous": todo_list_json(&previous),
            "reversible": true,
            "restoreWith": { "tool": USER_TODO_RESTORE, "arguments": { "entity_type": "list", "entity_id": previous.id } }
        }))
    }

    fn execute_search(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let query = required_string(args, "query")?;
        validate_text_len(&query, "query", 200)?;
        let (page, page_size, offset) = pagination(args)?;
        let (items, total) =
            VfsTodoRepo::search_items_paginated(vfs_db, &query, page_size as u32, offset as u32)
                .map_err(|e| e.to_string())?;
        Ok(paginated_payload(
            "items",
            items.iter().map(todo_item_json).collect(),
            total,
            page,
            page_size,
        ))
    }

    fn execute_list_trash(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let entity_type = required_string(args, "entity_type")?;
        let (page, page_size, offset) = pagination(args)?;
        let (values, total) = match entity_type.as_str() {
            "item" => {
                let items =
                    VfsTodoRepo::list_deleted_todo_items(vfs_db, page_size as u32, offset as u32)
                        .map_err(|e| e.to_string())?;
                let total =
                    VfsTodoRepo::count_deleted_todo_items(vfs_db).map_err(|e| e.to_string())?;
                (
                    items
                        .iter()
                        .map(|item| {
                            let mut value = todo_item_json(item);
                            value["entityType"] = json!("item");
                            value
                        })
                        .collect(),
                    total,
                )
            }
            "list" => {
                let lists =
                    VfsTodoRepo::list_deleted_todo_lists(vfs_db, page_size as u32, offset as u32)
                        .map_err(|e| e.to_string())?;
                let total =
                    VfsTodoRepo::count_deleted_todo_lists(vfs_db).map_err(|e| e.to_string())?;
                (
                    lists
                        .iter()
                        .map(|list| {
                            let mut value = todo_list_json(list);
                            value["entityType"] = json!("list");
                            value
                        })
                        .collect(),
                    total,
                )
            }
            _ => return Err("entity_type 必须是 item 或 list".to_string()),
        };
        Ok(paginated_payload("items", values, total, page, page_size))
    }

    fn execute_restore(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let entity_type = required_string(args, "entity_type")?;
        let entity_id = required_string(args, "entity_id")?;
        let (entity, entity_ids, restore_with, reversible, undo_reason, with_approval) =
            match entity_type.as_str() {
                "item" => {
                    let item = VfsTodoRepo::restore_todo_item(vfs_db, &entity_id)
                        .map_err(|e| e.to_string())?;
                    let ids = vec![item.id.clone(), item.todo_list_id.clone()];
                    let restore_with = json!({
                        "tool": USER_TODO_DELETE_ITEM,
                        "arguments": { "item_id": item.id, "expected_updated_at": item.updated_at }
                    });
                    (todo_item_json(&item), ids, restore_with, true, None, false)
                }
                "list" => {
                    let list = VfsTodoRepo::restore_todo_list(vfs_db, &entity_id)
                        .map_err(|e| e.to_string())?;
                    let ids = vec![list.id.clone()];
                    let restore_with = json!({
                        "tool": USER_TODO_DELETE_LIST,
                        "arguments": { "list_id": list.id, "expected_updated_at": list.updated_at }
                    });
                    (
                        todo_list_json(&list),
                        ids,
                        restore_with,
                        false,
                        Some("撤销清单恢复需要执行 High 风险的清单删除并重新取得用户确认"),
                        true,
                    )
                }
                _ => return Err("entity_type 必须是 item 或 list".to_string()),
            };
        emit_todo_changed(ctx, "restore", &entity_ids);
        Ok(with_undo_contract(
            json!({
                "success": true,
                "entityType": entity_type,
                "entity": entity,
                "previous": { "entityType": entity_type, "id": entity_id, "deleted": true },
            }),
            reversible,
            Some(restore_with),
            undo_reason,
            with_approval,
        ))
    }

    fn execute_reorder(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let list_id = required_string(args, "list_id")?;
        let expected = expected_todo_revision(args, "重排清单")?;
        let item_ids: Vec<String> = args
            .get("item_ids")
            .and_then(Value::as_array)
            .ok_or("缺少必需参数: item_ids")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or("item_ids 必须全部是字符串")
            })
            .collect::<Result<_, _>>()?;
        if item_ids.is_empty() || item_ids.len() > 500 {
            return Err("item_ids 数量必须在 1..=500".to_string());
        }
        let previous = VfsTodoRepo::list_items_by_list(vfs_db, &list_id, true)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        VfsTodoRepo::reorder_items(vfs_db, &list_id, &item_ids, Some(expected)).map_err(
            |error| {
                let message = error.to_string();
                if message.contains("TODO_CONFLICT") {
                    todo_list_conflict(vfs_db, &list_id, message)
                } else {
                    message
                }
            },
        )?;
        let current_list = VfsTodoRepo::get_todo_list(vfs_db, &list_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("待办清单 {list_id} 不存在"))?;
        emit_todo_changed(ctx, "reorder", &[list_id.clone()]);
        Ok(json!({
            "success": true,
            "listId": list_id,
            "reorderedCount": item_ids.len(),
            "previous": { "itemIds": previous },
            "reversible": true,
            "restoreWith": { "tool": USER_TODO_REORDER, "arguments": { "list_id": list_id, "item_ids": previous, "expected_updated_at": current_list.updated_at } }
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
                | "user_todo_delete_item"
                | "user_todo_create_list"
                | "user_todo_update_list"
                | "user_todo_delete_list"
                | "user_todo_search"
                | "user_todo_list_trash"
                | "user_todo_restore"
                | "user_todo_reorder"
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
            "user_todo_list_lists" => self.execute_list_lists(&call.arguments, ctx),
            "user_todo_create_item" => self.execute_create_item(&call.arguments, ctx),
            "user_todo_complete_item" => self.execute_complete_item(&call.arguments, ctx),
            "user_todo_list_items" => self.execute_list_items(&call.arguments, ctx),
            "user_todo_get_summary" => self.execute_get_summary(ctx),
            "user_todo_update_item" => self.execute_update_item(&call.arguments, ctx),
            "user_todo_delete_item" => self.execute_delete_item(&call.arguments, ctx),
            "user_todo_create_list" => self.execute_create_list(&call.arguments, ctx),
            "user_todo_update_list" => self.execute_update_list(&call.arguments, ctx),
            "user_todo_delete_list" => self.execute_delete_list(&call.arguments, ctx),
            "user_todo_search" => self.execute_search(&call.arguments, ctx),
            "user_todo_list_trash" => self.execute_list_trash(&call.arguments, ctx),
            "user_todo_restore" => self.execute_restore(&call.arguments, ctx),
            "user_todo_reorder" => self.execute_reorder(&call.arguments, ctx),
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
                let error = localized_todo_failure(error);
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

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            USER_TODO_DELETE_LIST => ToolSensitivity::High,
            USER_TODO_CREATE_ITEM
            | USER_TODO_COMPLETE_ITEM
            | USER_TODO_UPDATE_ITEM
            | USER_TODO_DELETE_ITEM
            | USER_TODO_CREATE_LIST
            | USER_TODO_UPDATE_LIST
            | USER_TODO_RESTORE
            | USER_TODO_REORDER => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "UserTodoExecutor"
    }
}

#[cfg(test)]
mod occ_contract_tests {
    use super::*;

    #[test]
    fn todo_revision_is_required_for_mutations() {
        let args = json!({});
        let error: Value = serde_json::from_str(
            &expected_todo_revision(&args, "更新待办").expect_err("baseline required"),
        )
        .expect("structured error");
        assert_eq!(error["code"], "TODO_OCC_REQUIRED");
        assert_eq!(error["retryable"], false);
        assert_eq!(error["messageKey"], "chat.tools.todo.occ_required");
        assert!(error["messageFallback"]["en-US"].is_string());

        assert_eq!(
            expected_todo_revision(&json!({"expected_updated_at": " rev-1 "}), "更新待办")
                .expect("baseline"),
            "rev-1"
        );
    }

    #[test]
    fn todo_conflicts_use_one_structured_code() {
        let error: Value = serde_json::from_str(&todo_conflict(
            "changed",
            Some(json!({"id": "todo-1", "updatedAt": "revision-2"})),
        ))
        .expect("structured conflict");
        assert_eq!(error["code"], "TODO_CONFLICT");
        assert_eq!(error["retryable"], false);
        assert_eq!(error["current"]["id"], "todo-1");
        assert_eq!(error["currentUpdatedAt"], "revision-2");
        assert_eq!(error["messageKey"], "chat.tools.todo.conflict");
        assert!(error["hint"]
            .as_str()
            .is_some_and(|hint| hint.contains("list_items")));
    }

    #[test]
    fn executor_failure_boundary_localizes_plain_errors_and_preserves_domain_errors() {
        let plain: Value = serde_json::from_str(&localized_todo_failure("缺少必需参数: title"))
            .expect("localized plain error");
        assert_eq!(plain["code"], "TODO_OPERATION_FAILED");
        assert_eq!(plain["messageKey"], "chat.tools.todo.error");
        assert!(plain["messageFallback"]["en-US"].is_string());

        let conflict: Value =
            serde_json::from_str(&localized_todo_failure(todo_conflict("changed", None)))
                .expect("localized conflict");
        assert_eq!(conflict["code"], "TODO_CONFLICT");
        assert_eq!(conflict["messageKey"], "chat.tools.todo.conflict");
        assert_eq!(conflict["messageParams"]["code"], "TODO_CONFLICT");
    }

    #[test]
    fn optional_todo_fields_preserve_omit_and_support_clear() {
        assert_eq!(
            optional_clearable_string(&json!({}), "reminder", "clear_reminder").unwrap(),
            None
        );
        assert_eq!(
            optional_clearable_string(
                &json!({"clear_reminder": true}),
                "reminder",
                "clear_reminder"
            )
            .unwrap(),
            Some(String::new())
        );
        assert_eq!(
            optional_clearable_string(
                &json!({"reminder": "2026-07-14T08:00"}),
                "reminder",
                "clear_reminder"
            )
            .unwrap(),
            Some("2026-07-14T08:00".to_string())
        );

        assert_eq!(optional_repeat_json(&json!({})).unwrap(), None);
        let repeat = optional_repeat_json(&json!({
            "repeat": {"freq": "weekly", "interval": 2, "byWeekday": [1, 3, 5]}
        }))
        .unwrap()
        .expect("repeat JSON");
        let parsed: Value = serde_json::from_str(&repeat).expect("valid JSON");
        assert_eq!(parsed["freq"], "weekly");
        assert_eq!(parsed["byWeekday"], json!([1, 3, 5]));
        assert_eq!(
            optional_repeat_json(&json!({"clear_repeat": true})).unwrap(),
            Some(String::new())
        );
        assert!(optional_repeat_json(&json!({
            "repeat": {"freq": "daily"},
            "clear_repeat": true
        }))
        .is_err());
    }

    #[test]
    fn real_todo_writes_are_not_low_sensitivity() {
        let executor = UserTodoExecutor::new();
        for tool in [
            USER_TODO_CREATE_ITEM,
            USER_TODO_COMPLETE_ITEM,
            USER_TODO_UPDATE_ITEM,
            USER_TODO_DELETE_ITEM,
            USER_TODO_CREATE_LIST,
            USER_TODO_UPDATE_LIST,
            USER_TODO_RESTORE,
            USER_TODO_REORDER,
        ] {
            assert_eq!(
                executor.sensitivity_level(tool),
                ToolSensitivity::Medium,
                "{tool}"
            );
        }
        assert_eq!(
            executor.sensitivity_level(USER_TODO_DELETE_LIST),
            ToolSensitivity::High
        );
        for tool in [
            USER_TODO_LIST_LISTS,
            USER_TODO_LIST_ITEMS,
            USER_TODO_GET_SUMMARY,
            USER_TODO_SEARCH,
            USER_TODO_LIST_TRASH,
        ] {
            assert_eq!(
                executor.sensitivity_level(tool),
                ToolSensitivity::Low,
                "{tool}"
            );
        }
    }

    #[test]
    fn undo_contract_never_claims_an_unexecutable_restore() {
        let direct = with_undo_contract(
            json!({"success": true}),
            false,
            None,
            Some("cannot replay"),
            false,
        );
        assert_eq!(direct["reversible"], false);
        assert!(direct["restoreWith"].is_null());
        assert_eq!(direct["undoReason"], "cannot replay");

        let approval = with_undo_contract(
            json!({"success": true}),
            false,
            Some(json!({"tool": USER_TODO_DELETE_LIST})),
            Some("high approval required"),
            true,
        );
        assert_eq!(approval["reversible"], false);
        assert_eq!(approval["reversibleWithApproval"], true);
        assert_eq!(approval["restoreWith"]["tool"], USER_TODO_DELETE_LIST);
    }

    #[test]
    fn user_text_is_unicode_safely_bounded_and_reports_fields() {
        let long = "你".repeat(MAX_CONTENT_CHARS + 3);
        let item = VfsTodoItem {
            id: "ti_test".to_string(),
            todo_list_id: "tdl_test".to_string(),
            title: long.clone(),
            description: Some(long.clone()),
            status: "pending".to_string(),
            priority: "none".to_string(),
            due_date: None,
            due_time: None,
            reminder: None,
            tags_json: serde_json::to_string(&vec![long]).unwrap(),
            sort_order: 0,
            parent_id: None,
            completed_at: None,
            repeat_json: None,
            attachments_json: "[]".to_string(),
            estimated_pomodoros: None,
            completed_pomodoros: None,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            deleted_at: None,
        };
        let value = todo_item_json(&item);
        assert_eq!(
            value["title"].as_str().unwrap().chars().count(),
            MAX_CONTENT_CHARS
        );
        assert_eq!(
            value["description"].as_str().unwrap().chars().count(),
            MAX_CONTENT_CHARS
        );
        assert_eq!(
            value["tags"][0].as_str().unwrap().chars().count(),
            MAX_CONTENT_CHARS
        );
        assert_eq!(
            value["fieldsTruncated"],
            json!(["title", "description", "tags"])
        );
    }

    #[test]
    fn executor_validates_text_tags_pagination_and_views() {
        assert!(optional_text(&json!({"title": "x".repeat(201)}), "title", 200).is_err());
        assert!(parse_tags(&json!({"tags": ["ok", 7]})).is_err());
        assert!(pagination(&json!({"page": 1, "page_size": 21})).is_err());
        assert_eq!(todo_view(&json!({})).unwrap(), "all");
        assert!(todo_view(&json!({"view": "unknown"})).is_err());
    }
}
