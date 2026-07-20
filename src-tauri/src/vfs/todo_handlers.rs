//! Todo Tauri 命令处理器
//!
//! 提供待办列表和待办项的 CRUD 命令，供前端直接调用。
//! 所有命令以 `todo_` 前缀命名。

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error_details::CommandError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsError;
use crate::vfs::repos::todo_repo::{
    TagCountEntry, TodoBatchIdsResult, TodoBatchItemsResult, TodoItemWithChildStats,
    TodoStatsOverview, TodoTrashCounts,
};
use crate::vfs::repos::{VfsPomodoroRepo, VfsTodoRepo};
use crate::vfs::types::*;

/// ACR 4.0 / DESIGN §5.6：用户侧写路径成功后广播 `todo://changed`（source:"user"），
/// 保证 finder/todo 视图的 flash 与刷新链路对用户写入同样成立
/// （agent 侧写入由 user_todo_executor 以 source:"agent" 发出）。
/// pub(crate)：pomodoro_handlers 的联动写路径（completed_pomodoros 回退）复用。
pub(crate) fn emit_todo_changed(app: &AppHandle, action: &str, entity_ids: &[String]) {
    let payload = serde_json::json!({
        "source": "user",
        "action": action,
        "entityIds": entity_ids,
    });
    if let Err(e) = app.emit("todo://changed", payload) {
        log::debug!("[todo_handlers] Failed to emit todo://changed: {}", e);
    }
}

// ============================================================================
// TD-11：稳定错误契约
// ============================================================================

/// todo_* 命令的统一结果类型：Err 为稳定 `CommandError` envelope
/// （{ code, message, data?, traceId? }），前端 src/features/todo/api.ts
/// 只依赖 `code` 分派行为，`message` 仅供展示。
///
/// 注：本文件内的 pomodoro_* 命令仍返回 `String`——其前端入口
/// src/features/pomodoro/api.ts 尚未迁移到 envelope 解析，属 TD-11 范围外。
type CmdResult<T> = Result<T, CommandError>;

/// VfsError → CommandError envelope，附 trace_id 并落后端日志，
/// 便于用 trace_id 关联前端上报与后端日志（可观测性）。
fn cmd_err(command: &'static str, err: VfsError) -> CommandError {
    let envelope = err
        .to_command_error()
        .with_trace_id(uuid::Uuid::new_v4().to_string());
    log::warn!(
        "[todo_handlers] {} failed: code={} trace_id={} message={}",
        command,
        envelope.code,
        envelope.trace_id.as_deref().unwrap_or("-"),
        envelope.message
    );
    envelope
}

/// 非 VfsError 来源（业务校验/LLM 调用等）的 envelope 构造，行为同 `cmd_err`
fn cmd_err_custom(command: &'static str, code: &'static str, message: String) -> CommandError {
    let envelope =
        CommandError::new(code, message).with_trace_id(uuid::Uuid::new_v4().to_string());
    log::warn!(
        "[todo_handlers] {} failed: code={} trace_id={} message={}",
        command,
        envelope.code,
        envelope.trace_id.as_deref().unwrap_or("-"),
        envelope.message
    );
    envelope
}

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
    #[serde(default)]
    pub estimated_pomodoros: Option<i32>,
    /// 兼容接收旧客户端字段，但该值已是事实表派生缓存，显式写入会被拒绝。
    #[serde(default)]
    pub completed_pomodoros: Option<i32>,
    /// R1-04：可选乐观锁基线（camelCase: expectedUpdatedAt）；缺省 None 兼容存量前端
    #[serde(default)]
    pub expected_updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderItemsInput {
    pub list_id: String,
    pub item_ids: Vec<String>,
    /// R1-04：可选乐观锁基线（校验列表 updated_at）；缺省 None 兼容存量前端
    #[serde(default)]
    pub expected_updated_at: Option<String>,
}

/// `todo_reorder_lists` 参数（camelCase: listIds）——
/// 必须精确覆盖全部未删除清单，按传入顺序重写 sort_order 0..n。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderListsInput {
    pub list_ids: Vec<String>,
}

/// `todo_move_item` 参数（camelCase: itemId / targetListId）——
/// 条目连同子树移入目标清单尾部。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveTodoItemInput {
    pub item_id: String,
    pub target_list_id: String,
}

// ============================================================================
// TodoList 命令
// ============================================================================

#[tauri::command]
pub fn todo_create_list(app: AppHandle, input: CreateTodoListInput) -> CmdResult<VfsTodoList> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let params = VfsCreateTodoListParams {
        title: input.title,
        description: input.description,
        icon: input.icon,
        color: input.color,
        is_default: false,
    };

    let list = VfsTodoRepo::create_todo_list(&vfs_db, params)
        .map_err(|e| cmd_err("todo_create_list", e))?;
    emit_todo_changed(&app, "create_list", std::slice::from_ref(&list.id));
    Ok(list)
}

#[tauri::command]
pub fn todo_get_list(app: AppHandle, list_id: String) -> CmdResult<Option<VfsTodoList>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::get_todo_list(&vfs_db, &list_id).map_err(|e| cmd_err("todo_get_list", e))
}

#[tauri::command]
pub fn todo_list_lists(app: AppHandle) -> CmdResult<Vec<VfsTodoList>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_todo_lists(&vfs_db).map_err(|e| cmd_err("todo_list_lists", e))
}

#[tauri::command]
pub fn todo_update_list(app: AppHandle, input: UpdateTodoListInput) -> CmdResult<VfsTodoList> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let params = VfsUpdateTodoListParams {
        title: input.title,
        description: input.description,
        icon: input.icon,
        color: input.color,
    };
    let list = VfsTodoRepo::update_todo_list(&vfs_db, &input.id, params)
        .map_err(|e| cmd_err("todo_update_list", e))?;
    emit_todo_changed(&app, "update_list", std::slice::from_ref(&list.id));
    Ok(list)
}

#[tauri::command]
pub fn todo_delete_list(app: AppHandle, list_id: String) -> CmdResult<()> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::delete_todo_list(&vfs_db, &list_id)
        .map_err(|e| cmd_err("todo_delete_list", e))?;
    emit_todo_changed(&app, "delete_list", std::slice::from_ref(&list_id));
    Ok(())
}

#[tauri::command]
pub fn todo_toggle_list_favorite(app: AppHandle, list_id: String) -> CmdResult<VfsTodoList> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let list = VfsTodoRepo::toggle_todo_list_favorite(&vfs_db, &list_id)
        .map_err(|e| cmd_err("todo_toggle_list_favorite", e))?;
    emit_todo_changed(&app, "update_list", std::slice::from_ref(&list.id));
    Ok(list)
}

#[tauri::command]
pub fn todo_ensure_inbox(app: AppHandle, title: Option<String>) -> CmdResult<VfsTodoList> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::ensure_default_inbox_with_title(&vfs_db, title.as_deref())
        .map_err(|e| cmd_err("todo_ensure_inbox", e))
}

/// 清单排序持久化：按传入顺序把 sort_order 重写为 0..n（须精确覆盖全部未删清单）
#[tauri::command]
pub fn todo_reorder_lists(app: AppHandle, input: ReorderListsInput) -> CmdResult<()> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::reorder_todo_lists(&vfs_db, &input.list_ids)
        .map_err(|e| cmd_err("todo_reorder_lists", e))?;
    emit_todo_changed(&app, "reorder_lists", &input.list_ids);
    Ok(())
}

// ============================================================================
// 回收站命令
// ============================================================================

#[tauri::command]
pub fn todo_list_deleted_lists(
    app: AppHandle,
    limit: Option<u32>,
    offset: Option<u32>,
) -> CmdResult<Vec<VfsTodoList>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_deleted_todo_lists(&vfs_db, limit.unwrap_or(100), offset.unwrap_or(0))
        .map_err(|e| cmd_err("todo_list_deleted_lists", e))
}

#[tauri::command]
pub fn todo_restore_list(app: AppHandle, list_id: String) -> CmdResult<VfsTodoList> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let list = VfsTodoRepo::restore_todo_list(&vfs_db, &list_id)
        .map_err(|e| cmd_err("todo_restore_list", e))?;
    emit_todo_changed(&app, "restore_list", std::slice::from_ref(&list.id));
    Ok(list)
}

#[tauri::command]
pub fn todo_purge_list(app: AppHandle, list_id: String) -> CmdResult<()> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::purge_todo_list(&vfs_db, &list_id).map_err(|e| cmd_err("todo_purge_list", e))?;
    emit_todo_changed(&app, "purge_list", std::slice::from_ref(&list_id));
    Ok(())
}

#[tauri::command]
pub fn todo_purge_deleted_lists(app: AppHandle) -> CmdResult<usize> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let purged = VfsTodoRepo::purge_deleted_todo_lists(&vfs_db)
        .map_err(|e| cmd_err("todo_purge_deleted_lists", e))?;
    if purged > 0 {
        emit_todo_changed(&app, "purge_deleted_lists", &[]);
    }
    Ok(purged)
}

#[tauri::command]
pub fn todo_restore_item(app: AppHandle, item_id: String) -> CmdResult<VfsTodoItem> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let item = VfsTodoRepo::restore_todo_item(&vfs_db, &item_id)
        .map_err(|e| cmd_err("todo_restore_item", e))?;
    emit_todo_changed(&app, "restore", std::slice::from_ref(&item.id));
    Ok(item)
}

#[tauri::command]
pub fn todo_list_deleted_items(
    app: AppHandle,
    limit: Option<u32>,
    offset: Option<u32>,
) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_deleted_todo_items(&vfs_db, limit.unwrap_or(100), offset.unwrap_or(0))
        .map_err(|e| cmd_err("todo_list_deleted_items", e))
}

#[tauri::command]
pub fn todo_purge_item(app: AppHandle, item_id: String) -> CmdResult<()> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::purge_todo_item(&vfs_db, &item_id).map_err(|e| cmd_err("todo_purge_item", e))?;
    emit_todo_changed(&app, "purge_item", std::slice::from_ref(&item_id));
    Ok(())
}

#[tauri::command]
pub fn todo_purge_deleted_items(app: AppHandle) -> CmdResult<usize> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let purged = VfsTodoRepo::purge_deleted_todo_items(&vfs_db)
        .map_err(|e| cmd_err("todo_purge_deleted_items", e))?;
    if purged > 0 {
        emit_todo_changed(&app, "purge_deleted_items", &[]);
    }
    Ok(purged)
}

// ============================================================================
// TodoItem 命令
// ============================================================================

#[tauri::command]
pub fn todo_create_item(app: AppHandle, input: CreateTodoItemInput) -> CmdResult<VfsTodoItem> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let params = VfsCreateTodoItemParams {
        todo_list_id: input.todo_list_id,
        title: input.title,
        description: input.description,
        priority: input.priority,
        due_date: input.due_date,
        due_time: input.due_time,
        reminder: input.reminder,
        tags: input.tags,
        parent_id: input.parent_id,
        attachments: input.attachments,
        repeat_json: input.repeat_json,
    };
    let item = VfsTodoRepo::create_todo_item(&vfs_db, params)
        .map_err(|e| cmd_err("todo_create_item", e))?;
    emit_todo_changed(&app, "create", std::slice::from_ref(&item.id));
    Ok(item)
}

#[tauri::command]
pub fn todo_get_item(app: AppHandle, item_id: String) -> CmdResult<Option<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::get_todo_item(&vfs_db, &item_id).map_err(|e| cmd_err("todo_get_item", e))
}

/// 移动端支撑：可选 `limit`/`offset`（None 时保持全量，兼容旧前端）。
/// ★ 2026-07-19：由"全量拉取 + 内存 skip/take"改为 SQL LIMIT/OFFSET，
/// 分页真正下推到 DB（命令签名与返回形状不变）。
#[tauri::command]
pub fn todo_list_items(
    app: AppHandle,
    list_id: String,
    include_completed: bool,
    limit: Option<u32>,
    offset: Option<u32>,
) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_items_by_list_paged(&vfs_db, &list_id, include_completed, limit, offset)
        .map_err(|e| cmd_err("todo_list_items", e))
}

#[tauri::command]
pub fn todo_update_item(app: AppHandle, input: UpdateTodoItemInput) -> CmdResult<VfsTodoItem> {
    if input.completed_pomodoros.is_some() {
        return Err(cmd_err_custom(
            "todo_update_item",
            "VFS_INVALID_ARGUMENT",
            "completedPomodoros is derived from pomodoro records and cannot be updated directly"
                .to_string(),
        ));
    }
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
        estimated_pomodoros: input.estimated_pomodoros,
        expected_updated_at: input.expected_updated_at,
    };
    let item = VfsTodoRepo::update_todo_item(&vfs_db, &input.id, params)
        .map_err(|e| cmd_err("todo_update_item", e))?;
    emit_todo_changed(&app, "update", std::slice::from_ref(&item.id));
    Ok(item)
}

/// R1-04：`expectedUpdatedAt` 为可选参数（serde 缺省 None，兼容存量 invoke）
#[tauri::command]
#[allow(non_snake_case)]
pub fn todo_toggle_item(
    app: AppHandle,
    item_id: String,
    expectedUpdatedAt: Option<String>,
) -> CmdResult<VfsTodoItem> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let item = VfsTodoRepo::toggle_todo_item(&vfs_db, &item_id, expectedUpdatedAt)
        .map_err(|e| cmd_err("todo_toggle_item", e))?;
    emit_todo_changed(&app, "toggle", std::slice::from_ref(&item.id));
    Ok(item)
}

#[tauri::command]
pub fn todo_delete_item(app: AppHandle, item_id: String) -> CmdResult<()> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::delete_todo_item(&vfs_db, &item_id)
        .map_err(|e| cmd_err("todo_delete_item", e))?;
    emit_todo_changed(&app, "delete", std::slice::from_ref(&item_id));
    Ok(())
}

#[tauri::command]
pub fn todo_reorder_items(app: AppHandle, input: ReorderItemsInput) -> CmdResult<()> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::reorder_items(
        &vfs_db,
        &input.list_id,
        &input.item_ids,
        input.expected_updated_at.as_deref(),
    )
    .map_err(|e| cmd_err("todo_reorder_items", e))?;
    emit_todo_changed(&app, "reorder", std::slice::from_ref(&input.list_id));
    Ok(())
}

/// 跨清单移动：条目连同子树移到目标清单尾部（子树内 parent 关系保留）
#[tauri::command]
pub fn todo_move_item(app: AppHandle, input: MoveTodoItemInput) -> CmdResult<VfsTodoItem> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let item = VfsTodoRepo::move_todo_item(&vfs_db, &input.item_id, &input.target_list_id)
        .map_err(|e| cmd_err("todo_move_item", e))?;
    emit_todo_changed(&app, "move", std::slice::from_ref(&item.id));
    Ok(item)
}

// ============================================================================
// 查询命令
// ============================================================================

/// 移动端支撑：可选 `limit`/`offset`（None 时保持全量，兼容旧前端）；
/// SQL 级分页（见 todo_list_items）。
#[tauri::command]
pub fn todo_list_today(
    app: AppHandle,
    include_completed: bool,
    limit: Option<u32>,
    offset: Option<u32>,
) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_today_items_paged(&vfs_db, include_completed, limit, offset)
        .map_err(|e| cmd_err("todo_list_today", e))
}

/// 移动端支撑：可选 `limit`/`offset`（None 时保持全量，兼容旧前端）；
/// SQL 级分页（见 todo_list_items）。
#[tauri::command]
pub fn todo_list_overdue(
    app: AppHandle,
    include_completed: bool,
    limit: Option<u32>,
    offset: Option<u32>,
) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_overdue_items_paged(&vfs_db, include_completed, limit, offset)
        .map_err(|e| cmd_err("todo_list_overdue", e))
}

#[tauri::command]
pub fn todo_list_upcoming(
    app: AppHandle,
    days: i64,
    include_completed: bool,
) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_upcoming_items(&vfs_db, days, include_completed)
        .map_err(|e| cmd_err("todo_list_upcoming", e))
}

/// 所有设置了提醒的待处理任务（前端提醒调度器轮询用）
#[tauri::command]
pub fn todo_list_reminders(app: AppHandle) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_reminder_items(&vfs_db).map_err(|e| cmd_err("todo_list_reminders", e))
}

/// 全部待处理任务（跨清单，四象限矩阵视图用）
#[tauri::command]
pub fn todo_list_all_pending(app: AppHandle) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_all_pending_items(&vfs_db)
        .map_err(|e| cmd_err("todo_list_all_pending", e))
}

#[tauri::command]
pub fn todo_list_completed(
    app: AppHandle,
    list_id: Option<String>,
) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_completed_items(&vfs_db, list_id.as_deref())
        .map_err(|e| cmd_err("todo_list_completed", e))
}

/// 待办搜索（可选 `limit`/`offset`，limit 缺省 50 与历史上限一致）。
/// ★ 2026-07-19：此前 repo 硬编码 LIMIT 50 后 handler 再内存切片，
/// offset >= 50 恒为空。改走 SQL 分页（search_items_paginated），
/// offset 现在作用于完整匹配集。
#[tauri::command]
pub fn todo_search(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let (items, _total) = VfsTodoRepo::search_items_paginated(
        &vfs_db,
        &query,
        limit.unwrap_or(50),
        offset.unwrap_or(0),
    )
    .map_err(|e| cmd_err("todo_search", e))?;
    Ok(items)
}

#[tauri::command]
pub fn todo_get_active_summary(app: AppHandle) -> CmdResult<Option<TodoActiveSummary>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::get_active_todo_summary(&vfs_db)
        .map_err(|e| cmd_err("todo_get_active_summary", e))
}

/// 计数快照：侧栏/徽标一次性拉取全部视图计数（聚合 COUNT，不拉行数据）。
/// 返回 camelCase：todayCount / upcomingCount / inboxCount / allPendingCount /
/// perList: [{ listId, pendingCount }]。
#[tauri::command]
pub fn todo_counts_snapshot(
    app: AppHandle,
) -> CmdResult<crate::vfs::repos::todo_repo::TodoCountsSnapshot> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::counts_snapshot(&vfs_db).map_err(|e| cmd_err("todo_counts_snapshot", e))
}

// ============================================================================
// 批量操作命令（2026-07-20 新增；契约见 .parallel-notes/backend.md。
// 全部单事务：要么全部提交要么全部回滚；不存在/状态不适用的 ID 记入
// skippedIds 而非报错。）
// ============================================================================

/// 批量完成（已完成的条目幂等返回；重复任务照常派生下一次实例）。
/// ★ 2026-07-20 r3 补齐：仅在有实际写库变更时广播（整批幂等命中不再发事件），
/// 且事件 entityIds 包含重复任务派生的新实例 id。
#[tauri::command]
pub fn todo_batch_complete(
    app: AppHandle,
    item_ids: Vec<String>,
) -> CmdResult<TodoBatchItemsResult> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let (result, event_ids) = VfsTodoRepo::batch_complete_items(&vfs_db, &item_ids)
        .map_err(|e| cmd_err("todo_batch_complete", e))?;
    if !event_ids.is_empty() {
        emit_todo_changed(&app, "batch_complete", &event_ids);
    }
    Ok(result)
}

/// 批量改期：dueDate 为 null/空串 → 清空到期日（联动清空时间）；
/// dueTime 为 null → 保留各条目现有时间，空串 → 清空。
#[tauri::command]
pub fn todo_batch_reschedule(
    app: AppHandle,
    item_ids: Vec<String>,
    due_date: Option<String>,
    due_time: Option<String>,
) -> CmdResult<TodoBatchItemsResult> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let result = VfsTodoRepo::batch_reschedule_items(&vfs_db, &item_ids, due_date, due_time)
        .map_err(|e| cmd_err("todo_batch_reschedule", e))?;
    if !result.items.is_empty() {
        let ids: Vec<String> = result.items.iter().map(|i| i.id.clone()).collect();
        emit_todo_changed(&app, "batch_reschedule", &ids);
    }
    Ok(result)
}

/// 批量设置优先级（★ 2026-07-20 r3 补齐；行为镜像 todo_batch_reschedule：
/// 单事务、500 上限、priority 非法整体拒绝、软删/不存在条目进 skippedIds）
#[tauri::command]
pub fn todo_batch_set_priority(
    app: AppHandle,
    item_ids: Vec<String>,
    priority: String,
) -> CmdResult<TodoBatchItemsResult> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let result = VfsTodoRepo::batch_set_priority_items(&vfs_db, &item_ids, &priority)
        .map_err(|e| cmd_err("todo_batch_set_priority", e))?;
    if !result.items.is_empty() {
        let ids: Vec<String> = result.items.iter().map(|i| i.id.clone()).collect();
        emit_todo_changed(&app, "batch_set_priority", &ids);
    }
    Ok(result)
}

/// 批量移动到目标清单（连同子树；输入中互为祖先-后代时后代随祖先迁移并跳过）
#[tauri::command]
pub fn todo_batch_move(
    app: AppHandle,
    item_ids: Vec<String>,
    target_list_id: String,
) -> CmdResult<TodoBatchItemsResult> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let result = VfsTodoRepo::batch_move_items(&vfs_db, &item_ids, &target_list_id)
        .map_err(|e| cmd_err("todo_batch_move", e))?;
    if !result.items.is_empty() {
        let ids: Vec<String> = result.items.iter().map(|i| i.id.clone()).collect();
        emit_todo_changed(&app, "batch_move", &ids);
    }
    Ok(result)
}

/// 批量软删除（连同子树，进入回收站）
#[tauri::command]
pub fn todo_batch_delete(
    app: AppHandle,
    item_ids: Vec<String>,
) -> CmdResult<TodoBatchIdsResult> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let result = VfsTodoRepo::batch_delete_items(&vfs_db, &item_ids)
        .map_err(|e| cmd_err("todo_batch_delete", e))?;
    if !result.affected_ids.is_empty() {
        emit_todo_changed(&app, "batch_delete", &result.affected_ids);
    }
    Ok(result)
}

/// 批量从回收站恢复（恢复自身 + 同批次删除的后代）
#[tauri::command]
pub fn todo_batch_restore(
    app: AppHandle,
    item_ids: Vec<String>,
) -> CmdResult<TodoBatchItemsResult> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let result = VfsTodoRepo::batch_restore_items(&vfs_db, &item_ids)
        .map_err(|e| cmd_err("todo_batch_restore", e))?;
    if !result.items.is_empty() {
        let ids: Vec<String> = result.items.iter().map(|i| i.id.clone()).collect();
        emit_todo_changed(&app, "batch_restore", &ids);
    }
    Ok(result)
}

/// 批量彻底删除（仅回收站中的条目；不可恢复）
#[tauri::command]
pub fn todo_batch_purge(
    app: AppHandle,
    item_ids: Vec<String>,
) -> CmdResult<TodoBatchIdsResult> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let result = VfsTodoRepo::batch_purge_items(&vfs_db, &item_ids)
        .map_err(|e| cmd_err("todo_batch_purge", e))?;
    if !result.affected_ids.is_empty() {
        emit_todo_changed(&app, "batch_purge", &result.affected_ids);
    }
    Ok(result)
}

/// 回收站计数（条目 + 清单），供徽标/分页控件一次拉取
#[tauri::command]
pub fn todo_trash_counts(app: AppHandle) -> CmdResult<TodoTrashCounts> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::trash_counts(&vfs_db).map_err(|e| cmd_err("todo_trash_counts", e))
}

// ============================================================================
// 统计聚合命令（2026-07-20 新增）
// ============================================================================

/// 待办统计总览：总量/今日/逾期 + 近 N 天完成趋势 + 按清单/优先级/标签分布
/// （days 默认 30，clamp 1-366；一次调用拿全统计视图数据）
#[tauri::command]
pub fn todo_stats_overview(app: AppHandle, days: Option<u32>) -> CmdResult<TodoStatsOverview> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::stats_overview(&vfs_db, days.unwrap_or(30))
        .map_err(|e| cmd_err("todo_stats_overview", e))
}

/// 全量标签词表（★ 2026-07-20 r3 补齐；无 100 上限，排除软删条目/清单，
/// count 降序、同 count 按 tag 升序——替代借道 todo_stats_overview.byTag 的旁路）
#[tauri::command]
pub fn todo_list_all_tags(app: AppHandle) -> CmdResult<Vec<TagCountEntry>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_all_tags(&vfs_db).map_err(|e| cmd_err("todo_list_all_tags", e))
}

/// 清单条目 + 直接子任务计数（一条聚合 SQL，消除"列表 + 每行子任务 COUNT"
/// 的 N+1；排序/过滤/分页语义与 todo_list_items 完全一致）
#[tauri::command]
pub fn todo_list_items_with_stats(
    app: AppHandle,
    list_id: String,
    include_completed: bool,
    limit: Option<u32>,
    offset: Option<u32>,
) -> CmdResult<Vec<TodoItemWithChildStats>> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_items_with_child_stats(&vfs_db, &list_id, include_completed, limit, offset)
        .map_err(|e| cmd_err("todo_list_items_with_stats", e))
}

// ============================================================================
// AI 拆解子任务
// ============================================================================

/// 从模型输出中提取 JSON 字符串数组（容忍 markdown 代码块包裹与前后杂文）
fn parse_breakdown_titles(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    let cleaned = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```JSON")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string()
    } else {
        trimmed.to_string()
    };

    // 优先整体解析；失败则截取第一个 [...] 片段再解析
    let candidate = if serde_json::from_str::<serde_json::Value>(&cleaned).is_ok() {
        cleaned
    } else {
        match (cleaned.find('['), cleaned.rfind(']')) {
            (Some(start), Some(end)) if end > start => cleaned[start..=end].to_string(),
            _ => return Vec::new(),
        }
    };

    let Ok(value) = serde_json::from_str::<serde_json::Value>(&candidate) else {
        return Vec::new();
    };
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| {
            // 兼容 ["t1"] 与 [{"title":"t1"}] 两种形态
            v.as_str().map(|s| s.to_string()).or_else(|| {
                v.get("title")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.chars().count() > 60 {
                s.chars().take(60).collect()
            } else {
                s
            }
        })
        .take(8)
        .collect()
}

/// AI 拆解子任务：调用工具模型把任务拆解为若干可执行子任务并直接落库
#[tauri::command]
pub async fn todo_ai_breakdown(
    app: AppHandle,
    state: State<'_, crate::commands::AppState>,
    item_id: String,
) -> CmdResult<Vec<VfsTodoItem>> {
    let vfs_db: Arc<VfsDatabase> = {
        let s: State<Arc<VfsDatabase>> = app.state();
        s.inner().clone()
    };

    let item = VfsTodoRepo::get_todo_item(&vfs_db, &item_id)
        .map_err(|e| cmd_err("todo_ai_breakdown", e))?
        .ok_or_else(|| {
            cmd_err(
                "todo_ai_breakdown",
                VfsError::ItemNotFound {
                    item_type: "todo".to_string(),
                    item_id: item_id.clone(),
                },
            )
        })?;

    if item.parent_id.is_some() {
        return Err(cmd_err_custom(
            "todo_ai_breakdown",
            "VFS_INVALID_OPERATION",
            "子任务不支持再次拆解".to_string(),
        ));
    }

    // 已有子任务标题，提示模型避免重复
    let siblings = VfsTodoRepo::list_items_by_list(&vfs_db, &item.todo_list_id, false)
        .map_err(|e| cmd_err("todo_ai_breakdown", e))?;
    let existing: Vec<String> = siblings
        .iter()
        .filter(|i| i.parent_id.as_deref() == Some(item_id.as_str()))
        .map(|i| i.title.clone())
        .collect();

    let mut prompt = String::from(
        "你是任务规划助手。把下面的任务拆解为 3-6 个具体、可独立执行的子任务。\n\
         输出要求：只输出一个 JSON 字符串数组，例如 [\"子任务一\",\"子任务二\"]。\
         不要 markdown 代码块，不要编号，不要任何解释文字。\n\
         每条不超过 30 字，语言与任务标题保持一致，按执行顺序排列。\n\n",
    );
    prompt.push_str(&format!("任务标题：{}\n", item.title));
    if let Some(desc) = item.description.as_deref() {
        if !desc.trim().is_empty() {
            let snippet: String = desc.chars().take(500).collect();
            prompt.push_str(&format!("任务备注：{}\n", snippet));
        }
    }
    if let Some(due) = item.due_date.as_deref() {
        prompt.push_str(&format!("截止日期：{}\n", due));
    }
    if !existing.is_empty() {
        prompt.push_str(&format!(
            "已有子任务（不要重复生成）：{}\n",
            existing.join("、")
        ));
    }

    let output = state
        .llm_manager
        .call_model2_raw_prompt(
            &prompt,
            None,
            crate::llm_usage::CallerType::Other("todo_breakdown".to_string()),
        )
        .await
        .map_err(|e| cmd_err_custom("todo_ai_breakdown", "INTERNAL_ERROR", e.to_string()))?;

    let titles = parse_breakdown_titles(&output.assistant_message);
    if titles.is_empty() {
        return Err(cmd_err_custom(
            "todo_ai_breakdown",
            "AI_EMPTY_RESULT",
            "AI 未能生成有效的子任务，请重试".to_string(),
        ));
    }

    // ★ 2026-07-19：逐条插入包进一个 SAVEPOINT——中途失败（如触发器拒绝）
    // 会留下"拆解了一半"的子任务且已向调用方报错，用户重试又生成一批重复项。
    // 全部成功才提交，失败整体回滚。
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| cmd_err("todo_ai_breakdown", e))?;
    conn.execute("SAVEPOINT todo_ai_breakdown", [])
        .map_err(|e| cmd_err("todo_ai_breakdown", e.into()))?;

    let insert_result = (|| -> CmdResult<Vec<VfsTodoItem>> {
        let mut created = Vec::with_capacity(titles.len());
        for title in titles {
            let params = VfsCreateTodoItemParams {
                todo_list_id: item.todo_list_id.clone(),
                title,
                description: None,
                priority: "none".to_string(),
                due_date: None,
                due_time: None,
                reminder: None,
                tags: None,
                parent_id: Some(item_id.clone()),
                attachments: None,
                repeat_json: None,
            };
            let sub = VfsTodoRepo::create_todo_item_with_conn(&conn, params)
                .map_err(|e| cmd_err("todo_ai_breakdown", e))?;
            created.push(sub);
        }
        Ok(created)
    })();

    match insert_result {
        Ok(created) => {
            conn.execute("RELEASE SAVEPOINT todo_ai_breakdown", [])
                .map_err(|e| cmd_err("todo_ai_breakdown", e.into()))?;
            let entity_ids: Vec<String> = created.iter().map(|item| item.id.clone()).collect();
            emit_todo_changed(&app, "create", &entity_ids);
            Ok(created)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK TO SAVEPOINT todo_ai_breakdown", []);
            let _ = conn.execute("RELEASE SAVEPOINT todo_ai_breakdown", []);
            Err(e)
        }
    }
}

// ============================================================================
// 番茄钟命令
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePomodoroInput {
    #[serde(default)]
    pub todo_item_id: Option<String>,
    pub start_time: String,
    #[serde(default)]
    pub end_time: Option<String>,
    pub duration: i32,
    pub actual_duration: i32,
    #[serde(default = "default_pomodoro_type")]
    pub r#type: String,
    #[serde(default = "default_pomodoro_status")]
    pub status: String,
}

fn default_pomodoro_type() -> String {
    "work".to_string()
}

fn default_pomodoro_status() -> String {
    "completed".to_string()
}

#[tauri::command]
pub fn pomodoro_create_record(
    app: AppHandle,
    input: CreatePomodoroInput,
) -> Result<PomodoroRecord, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let params = CreatePomodoroRecordParams {
        todo_item_id: input.todo_item_id,
        start_time: input.start_time,
        end_time: input.end_time,
        duration: input.duration,
        actual_duration: input.actual_duration,
        r#type: input.r#type,
        status: input.status,
    };
    let record = VfsPomodoroRepo::create_record(&vfs_db, params).map_err(|e| e.to_string())?;
    // work+completed 且关联任务时，repo 会按事实表重算
    // todo_items.completed_pomodoros 派生缓存；广播刷新使 todo 视图即时更新。
    if record.r#type == "work" && record.status == "completed" {
        if let Some(ref item_id) = record.todo_item_id {
            emit_todo_changed(&app, "update", std::slice::from_ref(item_id));
        }
    }
    Ok(record)
}

#[tauri::command]
pub fn pomodoro_get_record(
    app: AppHandle,
    record_id: String,
) -> Result<Option<PomodoroRecord>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::get_record(&vfs_db, &record_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pomodoro_list_by_todo(
    app: AppHandle,
    todo_item_id: String,
) -> Result<Vec<PomodoroRecord>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::list_by_todo_item(&vfs_db, &todo_item_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pomodoro_today_stats(app: AppHandle) -> Result<PomodoroTodayStats, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::get_today_stats(&vfs_db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pomodoro_list_today(app: AppHandle) -> Result<Vec<PomodoroRecord>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::list_today_records(&vfs_db).map_err(|e| e.to_string())
}

/// 近 N 天按本地日期聚合的番茄统计（趋势/热力图数据源）
#[tauri::command]
pub fn pomodoro_daily_stats(
    app: AppHandle,
    days: Option<u32>,
) -> Result<Vec<PomodoroDailyStat>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsPomodoroRepo::get_daily_stats(&vfs_db, days.unwrap_or(7)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_breakdown_titles;

    #[test]
    fn parses_plain_string_array() {
        let titles = parse_breakdown_titles(r#"["查资料","写提纲","完成初稿"]"#);
        assert_eq!(titles, vec!["查资料", "写提纲", "完成初稿"]);
    }

    #[test]
    fn parses_fenced_and_object_array() {
        let raw = "```json\n[{\"title\":\"step one\"},{\"title\":\"step two\"}]\n```";
        let titles = parse_breakdown_titles(raw);
        assert_eq!(titles, vec!["step one", "step two"]);
    }

    #[test]
    fn extracts_array_from_surrounding_text() {
        let raw = "好的，拆解如下：[\"a\",\"b\"] 希望有帮助";
        assert_eq!(parse_breakdown_titles(raw), vec!["a", "b"]);
    }

    #[test]
    fn rejects_garbage_and_filters_empty() {
        assert!(parse_breakdown_titles("无法拆解").is_empty());
        assert_eq!(parse_breakdown_titles(r#"["", "ok"]"#), vec!["ok"]);
    }
}
