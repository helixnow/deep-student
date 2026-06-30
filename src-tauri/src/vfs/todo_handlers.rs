//! Todo Tauri 命令处理器
//!
//! 提供待办列表和待办项的 CRUD 命令，供前端直接调用。
//! 所有命令以 `todo_` 前缀命名。

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsPomodoroRepo, VfsTodoRepo};
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
    #[serde(default)]
    pub completed_pomodoros: Option<i32>,
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
pub fn todo_create_list(app: AppHandle, input: CreateTodoListInput) -> Result<VfsTodoList, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    let params = VfsCreateTodoListParams {
        title: input.title,
        description: input.description,
        icon: input.icon,
        color: input.color,
        is_default: false,
    };

    VfsTodoRepo::create_todo_list(&vfs_db, params).map_err(|e| e.to_string())
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
pub fn todo_update_list(app: AppHandle, input: UpdateTodoListInput) -> Result<VfsTodoList, String> {
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
pub fn todo_toggle_list_favorite(app: AppHandle, list_id: String) -> Result<VfsTodoList, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::toggle_todo_list_favorite(&vfs_db, &list_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_ensure_inbox(app: AppHandle, title: Option<String>) -> Result<VfsTodoList, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::ensure_default_inbox_with_title(&vfs_db, title.as_deref())
        .map_err(|e| e.to_string())
}

// ============================================================================
// 回收站命令
// ============================================================================

#[tauri::command]
pub fn todo_list_deleted_lists(
    app: AppHandle,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<VfsTodoList>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_deleted_todo_lists(&vfs_db, limit.unwrap_or(100), offset.unwrap_or(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_restore_list(app: AppHandle, list_id: String) -> Result<VfsTodoList, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::restore_todo_list(&vfs_db, &list_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_purge_list(app: AppHandle, list_id: String) -> Result<(), String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::purge_todo_list(&vfs_db, &list_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_purge_deleted_lists(app: AppHandle) -> Result<usize, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::purge_deleted_todo_lists(&vfs_db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_restore_item(app: AppHandle, item_id: String) -> Result<VfsTodoItem, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::restore_todo_item(&vfs_db, &item_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_list_deleted_items(
    app: AppHandle,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_deleted_todo_items(&vfs_db, limit.unwrap_or(100), offset.unwrap_or(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_purge_item(app: AppHandle, item_id: String) -> Result<(), String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::purge_todo_item(&vfs_db, &item_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_purge_deleted_items(app: AppHandle) -> Result<usize, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::purge_deleted_todo_items(&vfs_db).map_err(|e| e.to_string())
}

// ============================================================================
// TodoItem 命令
// ============================================================================

#[tauri::command]
pub fn todo_create_item(app: AppHandle, input: CreateTodoItemInput) -> Result<VfsTodoItem, String> {
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
    VfsTodoRepo::list_items_by_list(&vfs_db, &list_id, include_completed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_update_item(app: AppHandle, input: UpdateTodoItemInput) -> Result<VfsTodoItem, String> {
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
        completed_pomodoros: input.completed_pomodoros,
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
    VfsTodoRepo::reorder_items(&vfs_db, &input.list_id, &input.item_ids).map_err(|e| e.to_string())
}

// ============================================================================
// 查询命令
// ============================================================================

#[tauri::command]
pub fn todo_list_today(
    app: AppHandle,
    include_completed: bool,
) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_today_items(&vfs_db, include_completed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_list_overdue(
    app: AppHandle,
    include_completed: bool,
) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_overdue_items(&vfs_db, include_completed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_list_upcoming(
    app: AppHandle,
    days: i64,
    include_completed: bool,
) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_upcoming_items(&vfs_db, days, include_completed).map_err(|e| e.to_string())
}

/// 所有设置了提醒的待处理任务（前端提醒调度器轮询用）
#[tauri::command]
pub fn todo_list_reminders(app: AppHandle) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_reminder_items(&vfs_db).map_err(|e| e.to_string())
}

/// 全部待处理任务（跨清单，四象限矩阵视图用）
#[tauri::command]
pub fn todo_list_all_pending(app: AppHandle) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_all_pending_items(&vfs_db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_list_completed(
    app: AppHandle,
    list_id: Option<String>,
) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::list_completed_items(&vfs_db, list_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_search(app: AppHandle, query: String) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::search_items(&vfs_db, &query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn todo_get_active_summary(app: AppHandle) -> Result<Option<TodoActiveSummary>, String> {
    let vfs_db: State<Arc<VfsDatabase>> = app.state();
    VfsTodoRepo::get_active_todo_summary(&vfs_db).map_err(|e| e.to_string())
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
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| v.get("title").and_then(|t| t.as_str()).map(|s| s.to_string()))
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
) -> Result<Vec<VfsTodoItem>, String> {
    let vfs_db: Arc<VfsDatabase> = {
        let s: State<Arc<VfsDatabase>> = app.state();
        s.inner().clone()
    };

    let item = VfsTodoRepo::get_todo_item(&vfs_db, &item_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;

    if item.parent_id.is_some() {
        return Err("子任务不支持再次拆解".to_string());
    }

    // 已有子任务标题，提示模型避免重复
    let siblings = VfsTodoRepo::list_items_by_list(&vfs_db, &item.todo_list_id, false)
        .map_err(|e| e.to_string())?;
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
        .map_err(|e| e.to_string())?;

    let titles = parse_breakdown_titles(&output.assistant_message);
    if titles.is_empty() {
        return Err("AI 未能生成有效的子任务，请重试".to_string());
    }

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
        let sub = VfsTodoRepo::create_todo_item(&vfs_db, params).map_err(|e| e.to_string())?;
        created.push(sub);
    }
    Ok(created)
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
    VfsPomodoroRepo::create_record(&vfs_db, params).map_err(|e| e.to_string())
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
