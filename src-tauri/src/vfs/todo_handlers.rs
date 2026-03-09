//! Todo Tauri 命令处理器
//!
//! 提供待办列表和待办项的 CRUD 命令，供前端直接调用。
//! 所有命令以 `todo_` 前缀命名。

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsTodoRepo;
use crate::vfs::types::*;

// ============================================================================
// 前端输入类型
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoListInput {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoListInput {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoItemInput {
    pub todo_list_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<String>>,
}

fn default_priority() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoItemInput {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default)]
    pub reminder: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<String>>,
    #[serde(default)]
    pub repeat_json: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderItemsInput {
    pub list_id: String,
    pub item_ids: Vec<String>,
}

// ============================================================================
// TodoList 命令
// ============================================================================

#[tauri::command]
pub fn todo_create_list(
    app: AppHandle,
    input: CreateTodoListInput,
) -> Result<VfsTodoList, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let params = VfsCreateTodoListParams {
        title: input.title,
        description: input.description,
        icon: input.icon,
        color: input.color,
        is_default: false,
    };

    VfsTodoRepo::create_todo_list(&vfs_db, params)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_get_list(app: AppHandle, list_id: String) -> Result<Option<VfsTodoList>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::get_todo_list(&vfs_db, &list_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_list_lists(app: AppHandle) -> Result<Vec<VfsTodoList>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_todo_lists(&vfs_db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_update_list(
    app: AppHandle,
    input: UpdateTodoListInput,
) -> Result<VfsTodoList, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let params = VfsUpdateTodoListParams {
        title: input.title,
        description: input.description,
        icon: input.icon,
        color: input.color,
    };
    VfsTodoRepo::update_todo_list(&vfs_db, &input.id, params).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_delete_list(app: AppHandle, list_id: String) -> Result<(), String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::delete_todo_list(&vfs_db, &list_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_toggle_list_favorite(
    app: AppHandle,
    list_id: String,
) -> Result<VfsTodoList, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::toggle_todo_list_favorite(&vfs_db, &list_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_ensure_inbox(app: AppHandle) -> Result<VfsTodoList, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::ensure_default_inbox(&vfs_db).map_err(|e| e.to_string())
}

// ============================================================================
// TodoItem 命令
// ============================================================================

#[tauri::command]
pub fn todo_create_item(
    app: AppHandle,
    input: CreateTodoItemInput,
) -> Result<VfsTodoItem, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let params = VfsCreateTodoItemParams {
        todo_list_id: input.todo_list_id,
        title: input.title,
        description: input.description,
        priority: input.priority,
        due_date: input.due_date,
        due_time: input.due_time,
        tags: input.tags,
        parent_id: input.parent_id,
        attachments: input.attachments,
    };
    VfsTodoRepo::create_todo_item(&vfs_db, params).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_get_item(app: AppHandle, item_id: String) -> Result<Option<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::get_todo_item(&vfs_db, &item_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_list_items(
    app: AppHandle,
    list_id: String,
    include_completed: bool,
) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_items_by_list(&vfs_db, &list_id, include_completed)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_update_item(
    app: AppHandle,
    input: UpdateTodoItemInput,
) -> Result<VfsTodoItem, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let params = VfsUpdateTodoItemParams {
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        due_date: input.due_date,
        due_time: input.due_time,
        reminder: input.reminder,
        tags: input.tags,
        parent_id: input.parent_id,
        attachments: input.attachments,
        repeat_json: input.repeat_json,
    };
    VfsTodoRepo::update_todo_item(&vfs_db, &input.id, params).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_toggle_item(app: AppHandle, item_id: String) -> Result<VfsTodoItem, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::toggle_todo_item(&vfs_db, &item_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_delete_item(app: AppHandle, item_id: String) -> Result<(), String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::delete_todo_item(&vfs_db, &item_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_reorder_items(app: AppHandle, input: ReorderItemsInput) -> Result<(), String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::reorder_items(&vfs_db, &input.list_id, &input.item_ids)
        .map_err(|e| e.to_string())
}

// ============================================================================
// 查询命令
// ============================================================================

#[tauri::command]
pub fn todo_list_today(app: AppHandle) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_today_items(&vfs_db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_list_overdue(app: AppHandle) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_overdue_items(&vfs_db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_list_upcoming(app: AppHandle, days: i64) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_upcoming_items(&vfs_db, days).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_search(app: AppHandle, query: String) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::search_items(&vfs_db, &query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_get_active_summary(
    app: AppHandle,
) -> Result<Option<TodoActiveSummary>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::get_active_todo_summary(&vfs_db).map_err(|e| e.to_string())
}
