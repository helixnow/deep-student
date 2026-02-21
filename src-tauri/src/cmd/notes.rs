//! 笔记系统命令模块
//! 从 commands.rs 剥离 (原始行号: 3505-5798)

#![allow(non_snake_case)] // Tauri 命令参数使用 camelCase 与前端保持一致

use crate::commands::AppState;
use crate::models::AppError;
use crate::unified_file_manager;
use crate::vfs::index_service::VfsIndexService;
use crate::vfs::{VfsLanceStore, VfsNoteRepo};
use chrono::Utc;
use rusqlite::params;
use serde::Serialize;
use std::sync::Arc;
use std::sync::LazyLock;
use tauri::{Emitter, State, Window};
use uuid::Uuid;

type Result<T> = std::result::Result<T, AppError>;

// ================= Notes: 独立笔记系统（CRUD） =================

#[tauri::command]
pub async fn notes_list(
    _subject: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::notes_manager::NoteItem>> {
    // 使用 spawn_blocking 避免 Lance 操作导致的死锁
    let notes_manager = state.notes_manager.clone();

    tokio::task::spawn_blocking(move || notes_manager.list_notes_vfs(None, 1000, 0))
        .await
        .map_err(|e| AppError::internal(format!("列出笔记任务失败: {}", e)))?
}

/// 轻量列表：不返回 content_md，用于初次渲染降低载荷
#[tauri::command]
pub async fn notes_list_meta(
    _subject: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::notes_manager::NoteItem>> {
    // 使用 spawn_blocking 避免 Lance 操作导致的死锁
    let notes_manager = state.notes_manager.clone();
    tokio::task::spawn_blocking(move || notes_manager.list_notes_meta())
        .await
        .map_err(|e| AppError::internal(format!("列出笔记元数据任务失败: {}", e)))?
}

#[derive(Debug, serde::Deserialize)]
pub struct NotesListAdvancedOptions {
    pub tags: Option<Vec<String>>,
    pub date_start: Option<String>,
    pub date_end: Option<String>,
    pub has_assets: Option<bool>,
    pub sort_by: Option<String>,
    pub sort_dir: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
    pub keyword: Option<String>,
    pub include_deleted: Option<bool>,
    pub only_deleted: Option<bool>,
}

#[derive(Debug, serde::Serialize)]
pub struct NotesListAdvancedResponse {
    pub items: Vec<crate::notes_manager::NoteItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}
#[tauri::command]
pub async fn notes_list_advanced(
    _subject: String,
    options: NotesListAdvancedOptions,
    state: State<'_, AppState>,
) -> Result<NotesListAdvancedResponse> {
    // 使用 spawn_blocking 避免 Lance 操作导致的死锁
    let notes_manager = state.notes_manager.clone();
    let opt = crate::notes_manager::ListOptions {
        tags: options.tags,
        date_start: options.date_start,
        date_end: options.date_end,
        has_assets: options.has_assets,
        sort_by: options.sort_by,
        sort_dir: options.sort_dir,
        page: options.page.unwrap_or(0),
        page_size: options.page_size.unwrap_or(20),
        keyword: options.keyword,
        include_deleted: options.include_deleted.unwrap_or(false),
        only_deleted: options.only_deleted.unwrap_or(false),
    };
    let page = options.page.unwrap_or(0);
    let page_size = options.page_size.unwrap_or(20);

    let (items, total) =
        tokio::task::spawn_blocking(move || notes_manager.list_notes_advanced(opt))
            .await
            .map_err(|e| AppError::internal(format!("高级列表任务失败: {}", e)))??;

    Ok(NotesListAdvancedResponse {
        items,
        total,
        page,
        page_size,
    })
}

#[derive(Debug, serde::Deserialize)]
pub struct NewNotePayload {
    pub title: String,
    pub content_md: String,
    pub tags: Option<Vec<String>>,
}

#[tauri::command]
pub async fn notes_create(
    _subject: String,
    note: NewNotePayload,
    state: State<'_, AppState>,
    _window: Window,
) -> Result<crate::notes_manager::NoteItem> {
    let tags: Vec<String> = note.tags.unwrap_or_default();

    // 使用 spawn_blocking 避免在异步上下文中阻塞
    let notes_manager = state.notes_manager.clone();
    let title = note.title.clone();
    let content_md = note.content_md.clone();
    let tags_clone = tags.clone();


    let created = tokio::task::spawn_blocking(move || {
        notes_manager.create_note_vfs(&title, &content_md, &tags_clone)
    })
    .await
    .map_err(|e| AppError::internal(format!("创建笔记任务失败: {}", e)))??;

    Ok(created)
}

#[derive(Debug, serde::Deserialize)]
pub struct UpdateNotePayload {
    pub id: String,
    pub title: Option<String>,
    pub content_md: Option<String>,
    pub tags: Option<Vec<String>>,
    pub should_reindex: Option<bool>,
    pub content_hash: Option<String>,
    pub force_reindex: Option<bool>,
    pub expected_updated_at: Option<String>,
}

#[tauri::command]
pub async fn notes_update(
    _subject: String,
    note: UpdateNotePayload,
    state: State<'_, AppState>,
    _window: Window,
) -> Result<crate::notes_manager::NoteItem> {
    // 使用 spawn_blocking 避免在异步上下文中阻塞
    let notes_manager = state.notes_manager.clone();
    let note_id = note.id.clone();
    let title = note.title.clone();
    let content_md = note.content_md.clone();
    let tags = note.tags.clone();
    let expected_updated_at = note.expected_updated_at.clone();


    let updated = tokio::task::spawn_blocking(move || {
        notes_manager.update_note_vfs(
            &note_id,
            title.as_deref(),
            content_md.as_deref(),
            tags.as_deref(),
            expected_updated_at.as_deref(),
        )
    })
    .await
    .map_err(|e| AppError::internal(format!("更新笔记任务失败: {}", e)))??;

    Ok(updated)
}

#[tauri::command]
pub async fn notes_set_favorite(
    subject: String,
    id: String,
    favorite: bool,
    state: State<'_, AppState>,
) -> Result<crate::notes_manager::NoteItem> {
    // 使用 spawn_blocking 避免 Lance 操作导致的死锁
    let notes_manager = state.notes_manager.clone();
    let _subject = subject; // VFS 版本不需要 subject，只需要 note_id
                            // ★ 切换到 VFS 版本
    tokio::task::spawn_blocking(move || notes_manager.set_favorite_vfs(&id, favorite))
        .await
        .map_err(|e| AppError::internal(format!("设置收藏任务失败: {}", e)))?
}

/// 获取单条笔记（包含内容）
#[tauri::command]
pub async fn notes_get(
    subject: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<crate::notes_manager::NoteItem> {
    // 使用 spawn_blocking 避免潜在的死锁
    let notes_manager = state.notes_manager.clone();
    let _subject = subject; // VFS 版本不需要 subject，只需要 note_id
                            // ★ 切换到 VFS 版本
    tokio::task::spawn_blocking(move || notes_manager.get_note_vfs(&id))
        .await
        .map_err(|e| AppError::internal(format!("获取笔记任务失败: {}", e)))?
}

#[tauri::command]
pub async fn notes_delete(subject: String, id: String, state: State<'_, AppState>) -> Result<bool> {
    // 回收站语义：软删除仅标记 deleted_at，不删除 RAG 文档/映射与资产，
    // 以便回收站中仍可通过恢复找回，且检索层已在查询时过滤 deleted_at 笔记。
    // 使用 spawn_blocking 避免 Lance 操作导致的死锁
    let notes_manager = state.notes_manager.clone();
    let _subject = subject; // VFS 版本不需要 subject，只需要 note_id
                            // ★ 切换到 VFS 版本
    tokio::task::spawn_blocking(move || notes_manager.delete_note_vfs(&id))
        .await
        .map_err(|e| AppError::internal(format!("删除笔记任务失败: {}", e)))?
}

// ============== Canvas AI 工具命令 ==============

/// Canvas AI 工具：读取笔记内容
/// 支持读取完整内容或指定章节
#[tauri::command]
pub async fn canvas_note_read(
    _subject: String,
    #[allow(non_snake_case)] noteId: String,
    section: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    log::info!(
        "[Canvas::Command] canvas_note_read: noteId={}, section={:?}",
        noteId,
        section
    );
    let notes_manager = state.notes_manager.clone();
    tokio::task::spawn_blocking(move || {
        notes_manager.canvas_read_content(&noteId, section.as_deref())
    })
    .await
    .map_err(|e| AppError::internal(format!("读取笔记内容任务失败: {}", e)))?
}

/// Canvas AI 工具：追加内容到笔记
/// 可指定追加到特定章节末尾，否则追加到文档末尾
#[tauri::command]
pub async fn canvas_note_append(
    _subject: String,
    #[allow(non_snake_case)] noteId: String,
    content: String,
    section: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    log::info!(
        "[Canvas::Command] canvas_note_append: noteId={}, section={:?}, content_len={}",
        noteId,
        section,
        content.len()
    );
    let notes_manager = state.notes_manager.clone();
    tokio::task::spawn_blocking(move || {
        notes_manager.canvas_append_content(&noteId, &content, section.as_deref())
    })
    .await
    .map_err(|e| AppError::internal(format!("追加笔记内容任务失败: {}", e)))?
}

/// Canvas AI 工具：替换笔记内容
/// 支持普通字符串替换和正则表达式替换
#[tauri::command]
pub async fn canvas_note_replace(
    _subject: String,
    #[allow(non_snake_case)] noteId: String,
    search: String,
    replace: String,
    #[allow(non_snake_case)] isRegex: Option<bool>,
    state: State<'_, AppState>,
) -> Result<u32> {
    log::info!(
        "[Canvas::Command] canvas_note_replace: noteId={}, search_len={}, isRegex={:?}",
        noteId,
        search.len(),
        isRegex
    );
    let notes_manager = state.notes_manager.clone();
    let is_regex = isRegex.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        notes_manager.canvas_replace_content(&noteId, &search, &replace, is_regex)
    })
    .await
    .map_err(|e| AppError::internal(format!("替换笔记内容任务失败: {}", e)))?
}

/// Canvas AI 工具：设置笔记完整内容
/// 完全覆盖现有内容，谨慎使用
#[tauri::command]
pub async fn canvas_note_set(
    _subject: String,
    #[allow(non_snake_case)] noteId: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<()> {
    log::info!(
        "[Canvas::Command] canvas_note_set: noteId={}, content_len={}",
        noteId,
        content.len()
    );
    let notes_manager = state.notes_manager.clone();
    tokio::task::spawn_blocking(move || notes_manager.canvas_set_content(&noteId, &content))
        .await
        .map_err(|e| AppError::internal(format!("设置笔记内容任务失败: {}", e)))?
}

// ============== 回收站（硬删除） ==============

/// 笔记硬删除：彻底从数据库与磁盘移除（包含版本/资产）
#[tauri::command]
pub async fn notes_hard_delete(
    subject: Option<String>,
    id: String,
    state: State<'_, AppState>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
) -> Result<bool> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    // 预先收集 resource_id（用于索引清理）
    let resource_ids: Vec<String> = {
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("VFS 连接失败: {}", e)))?;
        let mut ids = Vec::new();
        if let Ok(Some(note)) = VfsNoteRepo::get_note_with_conn(&conn, &id) {
            ids.push(note.resource_id);
        }
        ids
    };

    // VFS purge_note 会删除：笔记、关联资源
    let deleted = crate::vfs::VfsNoteRepo::purge_note(vfs_db, &id)
        .map(|_| true)
        .unwrap_or(false);

    if deleted {
        // 清理资产目录
        let subject = subject.unwrap_or_else(|| "_global".to_string());
        let _ = state.file_manager.delete_note_assets_dir(&subject, &id);

        // 清理索引（SQLite + Lance）
        let index_service = VfsIndexService::new(vfs_db.clone());
        for rid in resource_ids {
            if let Err(e) = index_service
                .delete_resource_index_full(&rid, &lance_store)
                .await
            {
                log::warn!(
                    "[notes_hard_delete] Failed to delete index for {}: {}",
                    rid,
                    e
                );
            }
        }
    }

    Ok(deleted)
}

/// 清空回收站（对 deleted_at 非空的笔记执行硬删除）
#[tauri::command]
pub async fn notes_empty_trash(
    _subject: Option<String>,
    state: State<'_, AppState>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
) -> Result<usize> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    // 预先收集所有待清理的 resource_id（用于索引清理）
    let resource_ids: Vec<String> = {
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("VFS 连接失败: {}", e)))?;
        let mut ids = Vec::new();

        let mut stmt = conn
            .prepare("SELECT id FROM notes WHERE deleted_at IS NOT NULL")
            .map_err(|e| AppError::database(format!("准备回收站查询失败: {}", e)))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| AppError::database(format!("遍历回收站失败: {}", e)))?;
        for r in rows {
            if let Ok(note_id) = r {
                if let Ok(Some(note)) = VfsNoteRepo::get_note_with_conn(&conn, &note_id) {
                    ids.push(note.resource_id);
                }
            }
        }
        ids.sort();
        ids.dedup();
        ids
    };

    // 批量清空回收站
    let deleted = crate::vfs::VfsNoteRepo::purge_deleted_notes(vfs_db)
        .map_err(|e| AppError::database(format!("VFS 清空回收站失败: {}", e)))?;

    // 清理索引（SQLite + Lance）
    if !resource_ids.is_empty() {
        let index_service = VfsIndexService::new(vfs_db.clone());
        for rid in resource_ids {
            if let Err(e) = index_service
                .delete_resource_index_full(&rid, &lance_store)
                .await
            {
                log::warn!(
                    "[notes_empty_trash] Failed to delete index for {}: {}",
                    rid,
                    e
                );
            }
        }
    }

    Ok(deleted)
}
/// 快捷回收站列表（分页），等价于 notes_list_advanced + only_deleted
#[tauri::command]
pub async fn notes_list_deleted(
    _subject: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
    state: State<'_, AppState>,
) -> Result<NotesListAdvancedResponse> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let page_val = page.unwrap_or(0);
    let page_size_val = page_size.unwrap_or(20);
    let limit = page_size_val as u32;
    let offset = (page_val * page_size_val) as u32;

    let deleted_notes = crate::vfs::VfsNoteRepo::list_deleted_notes(vfs_db, limit, offset)
        .map_err(|e| AppError::database(format!("VFS 查询回收站失败: {}", e)))?;

    // 转换为 NoteItem
    let items: Vec<crate::notes_manager::NoteItem> = deleted_notes
        .into_iter()
        .map(|n| crate::notes_manager::NoteItem {
            id: n.id,
            title: n.title,
            content_md: String::new(), // 列表不返回内容
            tags: n.tags,
            created_at: n.created_at,
            updated_at: n.updated_at,
            is_favorite: n.is_favorite,
        })
        .collect();

    // 获取总数（简化：使用大 limit 查询）
    let total_items = crate::vfs::VfsNoteRepo::list_deleted_notes(vfs_db, 100000, 0)
        .map(|v| v.len() as i64)
        .unwrap_or(items.len() as i64);

    Ok(NotesListAdvancedResponse {
        items,
        total: total_items,
        page: page_val,
        page_size: page_size_val,
    })
}

// 软删除与恢复
#[tauri::command]
pub async fn notes_restore(
    subject: String,
    id: String,
    state: State<'_, AppState>,
    _window: Window,
) -> Result<bool> {
    // 使用 spawn_blocking 避免 Lance 操作导致的死锁
    let notes_manager = state.notes_manager.clone();
    let _subject = subject.clone(); // VFS 版本不需要 subject
    let id_clone = id.clone();

    // ★ 切换到 VFS 版本
    let ok = tokio::task::spawn_blocking(move || notes_manager.restore_note_vfs(&id_clone))
        .await
        .map_err(|e| AppError::internal(format!("恢复笔记任务失败: {}", e)))??;

    if ok {
        let notes_manager2 = state.notes_manager.clone();
        let id_clone2 = id.clone();
        if let Ok(note) =
            tokio::task::spawn_blocking(move || notes_manager2.get_note_vfs(&id_clone2))
                .await
                .map_err(|e| AppError::internal(format!("获取恢复笔记失败: {}", e)))?
        {
            let _ = note;
        }
    }
    Ok(ok)
}

// ============== Notes 资源（图片等） ==============

#[tauri::command]
pub async fn notes_save_asset(
    subject: String,
    note_id: String,
    base64_data: String,
    default_ext: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let ext = default_ext.unwrap_or_else(|| "jpg".to_string());
    let (abs, rel) =
        state
            .file_manager
            .save_note_asset_from_base64(&subject, &note_id, &base64_data, &ext)?;

    Ok(serde_json::json!({ "absolute_path": abs, "relative_path": rel }))
}

#[tauri::command]
pub async fn notes_list_assets(
    subject: String,
    noteId: String,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>> {
    let rows = state.file_manager.list_note_assets(&subject, &noteId)?;
    let out = rows
        .into_iter()
        .map(|(abs, rel)| serde_json::json!({"absolute_path": abs, "relative_path": rel}))
        .collect();
    Ok(out)
}

#[tauri::command]
pub async fn notes_delete_asset(relative_path: String, state: State<'_, AppState>) -> Result<bool> {
    eprintln!("[notes_delete_asset] 收到删除请求: {}", relative_path);
    let deleted = state.file_manager.delete_note_asset(&relative_path)?;
    eprintln!("[notes_delete_asset] 删除结果: {}", deleted);
    Ok(deleted)
}

/// 解析相对资源路径为绝对路径（限定在 app_data_dir 子树内）
#[tauri::command]
pub async fn notes_resolve_asset_path(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let base = state.file_manager.get_writable_app_data_dir();
    let mut p = std::path::PathBuf::from(&relative_path);
    if p.is_absolute() {
        // 校验不越界
        let base_can = std::fs::canonicalize(&base)
            .map_err(|e| AppError::file_system(format!("解析app_data_dir失败: {}", e)))?;
        let can = std::fs::canonicalize(&p).unwrap_or(p.clone());
        if !can.starts_with(&base_can) {
            return Err(AppError::validation("拒绝访问：超出应用数据目录"));
        }
        return Ok(can.to_string_lossy().to_string());
    }
    p = base.join(&relative_path);
    let can = std::fs::canonicalize(&p).unwrap_or(p);
    Ok(can.to_string_lossy().to_string())
}
// 资产索引：扫描并返回数量（不写入数据库）
#[tauri::command]
pub async fn notes_assets_index_scan(
    subject: String,
    noteId: String,
    state: State<'_, AppState>,
) -> Result<usize> {
    use std::fs;
    let rows = state.file_manager.list_note_assets(&subject, &noteId)?;
    let mut count = 0usize;
    for (abs, rel) in rows {
        let _ = fs::metadata(&abs).ok();
        let _ = rel;
        count += 1;
    }
    Ok(count)
}
// 孤儿检测：列出 notes_assets 目录中文件中未在任何笔记 Markdown 中引用的相对路径

static HTML_IMG_SRC_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)<img[^>]+src\s*=\s*["']([^"']+)["']"#).expect("invalid img src regex")
});
static HTML_SRCSET_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)srcset\s*=\s*["']([^"']+)["']"#).expect("invalid srcset regex")
});
static CSS_URL_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)url\(\s*['"]?([^"'()\s]+)['"]?\s*\)"#).expect("invalid css url regex")
});

#[tauri::command]
pub async fn notes_assets_scan_orphans(
    subject: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    use std::collections::HashSet;
    // 1) 收集该 subject 下所有资产相对路径（基于文件系统）
    let base_dir = state.file_manager.get_writable_app_data_dir();
    let assets_root = base_dir.join("notes_assets").join(&subject);
    let mut all: Vec<String> = Vec::new();
    if assets_root.exists() {
        let mut stack = vec![assets_root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir)
                .map_err(|e| AppError::file_system(format!("读取资源目录失败: {}", e)))?
            {
                let entry = entry.map_err(|e| AppError::file_system(e.to_string()))?;
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.is_file() {
                    if let Ok(rel) = path.strip_prefix(&base_dir) {
                        all.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    if all.is_empty() {
        return Ok(Vec::new());
    }

    // 2) 扫描所有未删除的笔记内容，提取可能的资源引用（Markdown/JSON/原始字符串）
    let mut refs: HashSet<String> = HashSet::new();
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let vfs_conn = vfs_db
        .get_conn_safe()
        .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;
    let mut stmt2 = vfs_conn
        .prepare(
            "SELECT COALESCE(r.data, '') FROM notes n JOIN resources r ON r.id = n.resource_id WHERE n.deleted_at IS NULL",
        )
        .map_err(|e| AppError::database(e.to_string()))?;
    let rows2 = stmt2
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| AppError::database(e.to_string()))?;
    for r in rows2 {
        let s: String = r.map_err(|e| AppError::database(e.to_string()))?;
        let trimmed = s.trim();
        // a) Markdown 图片/链接：![]() / []()
        {
            let re = regex::Regex::new(r"!\[[^\]]*\]\(([^)]+)\)|\[[^\]]*\]\(([^)]+)\)").unwrap();
            for cap in re.captures_iter(trimmed) {
                for i in 1..=2 {
                    if let Some(m) = cap.get(i) {
                        add_ref_path(&mut refs, m.as_str());
                    }
                }
            }
        }
        // a.1) HTML <img src="notes_assets/..."> 以及相对路径
        for cap in HTML_IMG_SRC_REGEX.captures_iter(trimmed) {
            if let Some(m) = cap.get(1) {
                add_ref_path(&mut refs, m.as_str());
            }
        }
        // a.2) HTML srcset="notes_assets/.. 2x, ..." -> 分拆每个来源
        for cap in HTML_SRCSET_REGEX.captures_iter(trimmed) {
            if let Some(m) = cap.get(1) {
                for candidate in m.as_str().split(',') {
                    let path = candidate.trim().split_whitespace().next().unwrap_or("");
                    if !path.is_empty() {
                        add_ref_path(&mut refs, path);
                    }
                }
            }
        }
        // a.3) CSS/background: url('notes_assets/...')
        for cap in CSS_URL_REGEX.captures_iter(trimmed) {
            if let Some(m) = cap.get(1) {
                add_ref_path(&mut refs, m.as_str());
            }
        }
        // b) 原始文本里直接出现的 notes_assets 路径
        if trimmed.contains("notes_assets/") || trimmed.contains("notes_assets\\") {
            // 尝试按空白和引号分割简单提取
            for token in trimmed.split(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
                if token.contains("notes_assets/") || token.contains("notes_assets\\") {
                    add_ref_path(&mut refs, token);
                }
            }
        }
        // c) JSON：递归遍历所有字符串字段
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
                collect_json_paths(&json, &mut refs);
            }
        }
    }

    // 3) 归一化比较：支持不同分隔符
    let mut orphans: Vec<String> = Vec::new();
    for p in all.into_iter() {
        let p_fwd = p.replace('\\', "/");
        let p_bwd = p.replace('/', "\\");
        if !(refs.contains(&p) || refs.contains(&p_fwd) || refs.contains(&p_bwd)) {
            orphans.push(p);
        }
    }
    Ok(orphans)
}
// 将一个路径样式的片段尝试归一化并加入引用集合（相对路径）
fn add_ref_path(set: &mut std::collections::HashSet<String>, raw: &str) {
    let s = raw
        .trim()
        .trim_matches(|c| c == '(' || c == ')' || c == '"' || c == '\'');
    if s.is_empty() {
        return;
    }
    // 若包含 notes_assets/ 子树，截取从该处开始
    if let Some(idx) = s.find("notes_assets/") {
        let sub = &s[idx..];
        set.insert(sub.to_string());
        set.insert(sub.replace('\\', "/"));
        set.insert(sub.replace('/', "\\"));
    } else if let Some(idx) = s.find("notes_assets\\") {
        let sub = &s[idx..];
        let fwd = sub.replace('\\', "/");
        set.insert(sub.to_string());
        set.insert(fwd.clone());
        set.insert(fwd.replace('/', "\\"));
    }
}
// 遍历 JSON，提取所有字符串字段中的 notes_assets 相对路径
fn collect_json_paths(v: &serde_json::Value, set: &mut std::collections::HashSet<String>) {
    match v {
        serde_json::Value::String(s) => add_ref_path(set, s),
        serde_json::Value::Array(arr) => {
            for it in arr {
                collect_json_paths(it, set);
            }
        }
        serde_json::Value::Object(map) => {
            for (_k, vv) in map {
                collect_json_paths(vv, set);
            }
        }
        _ => {}
    }
}
// 批量删除资产（相对路径）
#[tauri::command]
pub async fn notes_assets_bulk_delete(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<usize> {
    let mut deleted = 0usize;
    for p in &paths {
        if state.file_manager.delete_note_asset(p)? {
            deleted += 1;
        }
    }
    Ok(deleted)
}

// ============== RAG FTS 索引维护 ==============

/// 重建主库（mistakes.db）的 RAG 文档块 FTS 索引
#[tauri::command]
pub async fn rag_rebuild_fts_index(state: State<'_, AppState>) -> Result<usize> {
    let _ = state;
    println!("ℹ️ Lance RAG 检索使用原生 FTS，无需额外重建");
    Ok(0)
}

/// 重建笔记库（notes.db）的 RAG 文档块 FTS 索引
#[tauri::command]
pub async fn notes_rag_rebuild_fts_index(state: State<'_, AppState>) -> Result<usize> {
    let _ = state;
    println!("ℹ️ Notes RAG 已使用 Lance 内置 FTS，无需重建");
    Ok(0)
}

// Notes 专属 RAG 学科参数（每学科 chunk_size/overlap/rerank）
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct NotesSubjectRagConfig {
    pub chunk_size: i32,
    pub chunk_overlap: i32,
    pub min_chunk_size: i32,
    pub rerank_enabled: bool,
}

#[tauri::command]
pub async fn notes_get_subject_rag_config(
    subject: String,
    state: State<'_, AppState>,
) -> Result<NotesSubjectRagConfig> {
    // 从 notes_database.settings 中读取，没有则使用 rag_configurations 默认
    if let Ok(Some(json)) = state
        .notes_database
        .get_setting(&format!("notes.rag.config.{}", subject))
    {
        if let Ok(cfg) = serde_json::from_str::<NotesSubjectRagConfig>(&json) {
            return Ok(cfg);
        }
    }
    // fallback 默认
    let def = state
        .notes_database
        .get_rag_configuration()
        .map_err(|e| AppError::database(e.to_string()))?;
    Ok(NotesSubjectRagConfig {
        chunk_size: def.as_ref().map(|c| c.chunk_size).unwrap_or(512),
        chunk_overlap: def.as_ref().map(|c| c.chunk_overlap).unwrap_or(50),
        min_chunk_size: def.as_ref().map(|c| c.min_chunk_size).unwrap_or(20),
        rerank_enabled: def
            .as_ref()
            .map(|c| c.default_rerank_enabled)
            .unwrap_or(true),
    })
}

#[tauri::command]
pub async fn notes_update_subject_rag_config(
    subject: String,
    cfg: NotesSubjectRagConfig,
    state: State<'_, AppState>,
) -> Result<bool> {
    // 参数校验（与全局RAG设置保持一致并加上更严格的重叠约束）
    if cfg.chunk_size < 50 || cfg.chunk_size > 2048 {
        return Err(AppError::validation("分块大小必须在50-2048之间"));
    }
    if cfg.min_chunk_size < 10 || cfg.min_chunk_size > cfg.chunk_size {
        return Err(AppError::validation("最小分块大小必须在10和分块大小之间"));
    }
    // 基础约束：重叠 < 分块
    if cfg.chunk_overlap < 0 || cfg.chunk_overlap >= cfg.chunk_size {
        return Err(AppError::validation("重叠大小必须非负且小于分块大小"));
    }
    // 额外安全约束：限制最大重叠比例（避免步长接近1导致爆炸性分块）
    // 要求步长 >= max(64, chunk_size/4)
    let min_stride = std::cmp::max(64, (cfg.chunk_size / 4).max(1));
    let stride = cfg.chunk_size - cfg.chunk_overlap;
    if stride < min_stride {
        return Err(AppError::validation(format!(
            "重叠过大：当前步长{}，需>= {}（重叠<= {}）",
            stride,
            min_stride,
            cfg.chunk_size - min_stride
        )));
    }

    // 保存科目专属配置
    let json = serde_json::to_string(&cfg).map_err(|e| AppError::database(e.to_string()))?;
    state
        .notes_database
        .save_setting(&format!("notes.rag.config.{}", subject), &json)
        .map_err(|e| AppError::database(e.to_string()))?;

    // 同步覆盖 notes 数据库中的默认 rag_configurations，使后续嵌入过程生效
    state
        .notes_database
        .update_rag_configuration(&crate::models::RagConfigRequest {
            chunk_size: cfg.chunk_size,
            chunk_overlap: cfg.chunk_overlap,
            chunking_strategy: "fixed_size".to_string(),
            min_chunk_size: cfg.min_chunk_size,
            default_top_k: 5,
            default_rerank_enabled: cfg.rerank_enabled,
        })
        .map_err(|e| AppError::database(e.to_string()))?;
    Ok(true)
}

// Notes 偏好项（通用 KV）
#[tauri::command]
pub async fn notes_set_pref(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<bool> {
    state
        .notes_database
        .save_setting(&format!("notes.pref.{}", key), &value)
        .map_err(|e| AppError::database(e.to_string()))?;
    Ok(true)
}

#[tauri::command]
pub async fn notes_get_pref(key: String, state: State<'_, AppState>) -> Result<Option<String>> {
    state
        .notes_database
        .get_setting(&format!("notes.pref.{}", key))
        .map_err(|e| AppError::database(e.to_string()))
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct NotesExportCommandRequest {
    pub subjects: Option<Vec<String>>,
    pub output_path: Option<String>,
    pub include_versions: Option<bool>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct NotesExportSingleCommandRequest {
    pub subject: String,
    pub note_id: String,
    pub output_path: Option<String>,
    pub include_versions: Option<bool>,
}

#[derive(Debug, serde::Serialize)]
pub struct NotesExportCommandResponse {
    pub output_path: String,
    pub note_count: usize,
    pub attachment_count: usize,
}

#[tauri::command]
pub async fn notes_export(
    request: NotesExportCommandRequest,
    state: State<'_, AppState>,
    window: Window,
) -> Result<NotesExportCommandResponse> {
    log::info!("收到导出笔记命令，请求：{:?}", request);

    let file_manager = state.file_manager.clone();
    let exporter = crate::notes_exporter::NotesExporter::new_with_vfs(
        state.notes_database.clone(),
        file_manager.clone(),
        state.vfs_db.clone(),
    );
    let include_versions = request.include_versions.unwrap_or(true);
    let output_path = request.output_path.clone();
    let user_destination = output_path.clone();

    let staging_override = if user_destination.is_some() {
        let exports_dir = file_manager.get_app_data_dir().join("exports");
        if let Err(err) = std::fs::create_dir_all(&exports_dir) {
            return Err(AppError::file_system(format!(
                "创建临时导出目录失败: {}",
                err
            )));
        }
        let temp_name = format!(
            "notes_export_staging_{}_{}.zip",
            Utc::now().format("%Y%m%d_%H%M%S"),
            Uuid::new_v4()
        );
        Some(exports_dir.join(temp_name))
    } else {
        None
    };

    log::info!(
        "开始后台导出任务，包含版本：{}，路径：{:?}",
        include_versions,
        output_path
    );

    let summary = tokio::task::spawn_blocking(move || {
        exporter.export(crate::notes_exporter::ExportOptions {
            include_versions,
            output_path: staging_override,
        })
    })
    .await
    .map_err(|e| {
        log::error!("导出笔记任务失败：{}", e);
        AppError::internal(format!("导出笔记任务失败: {}", e))
    })??;

    let mut summary = summary;
    if let Some(dest_path) = user_destination {
        let source_path = summary.output_path.clone();
        unified_file_manager::copy_file(&window, source_path.as_str(), dest_path.as_str())?;
        if dest_path != source_path {
            if let Err(err) = std::fs::remove_file(&source_path) {
                log::warn!(
                    "notes_export: 清理临时导出文件失败 ({}): {}",
                    source_path,
                    err
                );
            }
        }
        summary.output_path = dest_path;
    }

    log::info!(
        "导出笔记命令完成，响应：路径={}, 笔记数={}, 附件数={}",
        summary.output_path,
        summary.note_count,
        summary.attachment_count
    );

    Ok(NotesExportCommandResponse {
        output_path: summary.output_path,
        note_count: summary.note_count,
        attachment_count: summary.attachment_count,
    })
}

#[tauri::command]
pub async fn notes_export_single(
    request: NotesExportSingleCommandRequest,
    state: State<'_, AppState>,
    window: Window,
) -> Result<NotesExportCommandResponse> {
    log::info!("收到单笔记导出命令，请求：{:?}", request);

    let file_manager = state.file_manager.clone();
    let exporter = crate::notes_exporter::NotesExporter::new_with_vfs(
        state.notes_database.clone(),
        file_manager.clone(),
        state.vfs_db.clone(),
    );

    let include_versions = request.include_versions.unwrap_or(true);
    let user_destination = request.output_path.clone();

    let staging_override = if user_destination.is_some() {
        let exports_dir = file_manager.get_app_data_dir().join("exports");
        if let Err(err) = std::fs::create_dir_all(&exports_dir) {
            return Err(AppError::file_system(format!(
                "创建临时导出目录失败: {}",
                err
            )));
        }
        let temp_name = format!(
            "note_export_staging_{}_{}.zip",
            Utc::now().format("%Y%m%d_%H%M%S"),
            Uuid::new_v4()
        );
        Some(exports_dir.join(temp_name))
    } else {
        None
    };

    let summary = tokio::task::spawn_blocking(move || {
        exporter.export_single(crate::notes_exporter::SingleNoteExportOptions {
            note_id: request.note_id.clone(),
            include_versions,
            output_path: staging_override,
        })
    })
    .await
    .map_err(|e| {
        log::error!("导出单条笔记任务失败：{}", e);
        AppError::internal(format!("导出单条笔记任务失败: {}", e))
    })??;

    let mut summary = summary;
    if let Some(dest_path) = user_destination {
        let source_path = summary.output_path.clone();
        unified_file_manager::copy_file(&window, source_path.as_str(), dest_path.as_str())?;
        if dest_path != source_path {
            if let Err(err) = std::fs::remove_file(&source_path) {
                log::warn!(
                    "notes_export_single: 清理临时导出文件失败 ({}): {}",
                    source_path,
                    err
                );
            }
        }
        summary.output_path = dest_path;
    }

    log::info!(
        "单条笔记导出完成，响应：路径={}, 笔记数={}, 附件数={}",
        summary.output_path,
        summary.note_count,
        summary.attachment_count
    );

    Ok(NotesExportCommandResponse {
        output_path: summary.output_path,
        note_count: summary.note_count,
        attachment_count: summary.attachment_count,
    })
}

// Notes 导入
#[derive(Debug, serde::Deserialize)]
pub struct NotesImportCommandRequest {
    pub file_path: String,
    /// 冲突策略：skip（默认）、overwrite、merge_keep_newer
    #[serde(default)]
    pub conflict_strategy: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct NotesImportCommandResponse {
    pub subject_count: usize,
    pub note_count: usize,
    pub attachment_count: usize,
    pub skipped_count: usize,
    pub overwritten_count: usize,
}

#[tauri::command]
pub async fn notes_import(
    request: NotesImportCommandRequest,
    state: State<'_, AppState>,
    window: Window,
) -> Result<NotesImportCommandResponse> {
    log::info!(
        "收到导入笔记命令，文件：{}，冲突策略：{:?}",
        request.file_path,
        request.conflict_strategy
    );

    let importer = crate::notes_exporter::NotesImporter::new_with_vfs(
        state.notes_database.clone(),
        state.file_manager.clone(),
        state.vfs_db.clone(),
    );
    let temp_dir = state
        .file_manager
        .get_writable_app_data_dir()
        .join("temp_notes_import");
    let materialized =
        unified_file_manager::ensure_local_path(&window, &request.file_path, &temp_dir)?;
    let (import_path, cleanup_path) = materialized.into_owned();

    // 解析冲突策略
    let conflict_strategy = match request.conflict_strategy.as_deref() {
        Some("overwrite") => crate::notes_exporter::ImportConflictStrategy::Overwrite,
        Some("merge_keep_newer") => crate::notes_exporter::ImportConflictStrategy::MergeKeepNewer,
        _ => crate::notes_exporter::ImportConflictStrategy::Skip,
    };

    // 创建进度回调（发送事件到前端）
    let window_clone = window.clone();
    let progress_callback =
        std::sync::Arc::new(move |progress: crate::notes_exporter::ImportProgress| {
            let _ = window_clone.emit("notes-import-progress", &progress);
        });

    let options = crate::notes_exporter::ImportOptions {
        conflict_strategy,
        progress_callback: Some(progress_callback),
    };

    log::info!(
        "开始后台导入任务，文件：{:?}，冲突策略：{:?}",
        import_path,
        conflict_strategy
    );

    let summary =
        tokio::task::spawn_blocking(move || importer.import_with_options(import_path, options))
            .await
            .map_err(|e| {
                log::error!("导入笔记任务失败：{}", e);
                AppError::internal(format!("导入笔记任务失败: {}", e))
            })??;

    if let Some(cleanup) = cleanup_path {
        if let Err(err) = std::fs::remove_file(&cleanup) {
            log::warn!(
                "notes_import: 清理临时导入文件失败 ({}): {}",
                cleanup.display(),
                err
            );
        }
    }

    log::info!(
        "导入笔记命令完成，学科数={}, 笔记数={}, 附件数={}, 跳过={}, 覆盖={}",
        summary.subject_count,
        summary.note_count,
        summary.attachment_count,
        summary.skipped_count,
        summary.overwritten_count
    );

    Ok(NotesImportCommandResponse {
        subject_count: summary.subject_count,
        note_count: summary.note_count,
        attachment_count: summary.attachment_count,
        skipped_count: summary.skipped_count,
        overwritten_count: summary.overwritten_count,
    })
}

// Notes DB 运维
#[derive(Debug, serde::Serialize)]
pub struct NotesDbStats {
    pub db_path: String,
    pub file_size_bytes: u64,
    pub total_notes: i64,
    pub total_versions: i64,
    pub total_assets: i64,
}

#[tauri::command]
pub async fn notes_db_stats(state: State<'_, AppState>) -> Result<NotesDbStats> {
    use std::fs;
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let path = vfs_db.db_path().to_path_buf();
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| AppError::database(e.to_string()))?;
    let total_notes: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap_or(0);
    let total_versions: i64 = 0;
    let total_assets: i64 = 0;
    Ok(NotesDbStats {
        db_path: path.to_string_lossy().to_string(),
        file_size_bytes: size,
        total_notes,
        total_versions,
        total_assets,
    })
}

#[tauri::command]
pub async fn notes_db_vacuum(state: State<'_, AppState>) -> Result<bool> {
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| AppError::database(e.to_string()))?;
    conn.execute_batch("VACUUM;")
        .map_err(|e| AppError::database(e.to_string()))?;
    Ok(true)
}

// 列出推荐标签（按使用频次排序）
#[tauri::command]
pub async fn notes_list_tags(
    _subject: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let tags = crate::vfs::VfsNoteRepo::list_tags(vfs_db, 50)
        .map_err(|e| AppError::database(format!("VFS 获取标签失败: {}", e)))?;

    Ok(tags)
}

// ============== Notes FTS 搜索（标题 + 正文） ==============

#[derive(Debug, serde::Serialize)]
pub struct NotesSearchHit {
    pub id: String,
    pub title: String,
    pub snippet: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MentionMistakeHit {
    pub id: String,
    pub subject: String,
    pub title: String,
    pub summary: Option<String>,
    pub tags: Vec<String>,
}
#[derive(Debug, Serialize, Clone)]
pub struct MentionIrecCardHit {
    pub id: String,
    pub title: String,
    pub insight: String,
    pub subject: Option<String>,
    pub tags: Vec<String>,
    pub mistake_id: Option<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct NotesMentionSearchResponse {
    pub mistakes: Vec<MentionMistakeHit>,
    pub irec_cards: Vec<MentionIrecCardHit>,
}

fn escape_like_pattern(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' | '[' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn build_snippet(text: &str, query: &str, max_len: usize) -> Option<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower_text = text.to_lowercase();
    let lower_query = trimmed.to_lowercase();
    let byte_index = lower_text.find(&lower_query)?;
    let char_index = text[..byte_index].chars().count();
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return None;
    }
    let half = max_len / 2;
    let start = char_index.saturating_sub(half);
    let end = (start + max_len).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }
    Some(snippet)
}
#[tauri::command]
pub async fn notes_search(
    _subject: String,
    keyword: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<NotesSearchHit>> {
    let limit = limit.unwrap_or(50).clamp(1, 200) as usize;
    if keyword.trim().is_empty() {
        return Ok(vec![]);
    }

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    // 使用 spawn_blocking 避免阻塞 async 线程
    let keyword_clone = keyword.clone();
    let tag_filters: Vec<String> = keyword_clone
        .split_whitespace()
        .filter_map(|part| part.strip_prefix("tag:"))
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect();
    let vfs_db = vfs_db.clone();
    let items = tokio::task::spawn_blocking(move || {
        let fetch_limit = if tag_filters.is_empty() {
            limit as u32
        } else {
            (limit.saturating_mul(5) as u32).min(1000)
        };

        let notes = if tag_filters.is_empty() {
            crate::vfs::VfsNoteRepo::list_notes(&vfs_db, Some(&keyword_clone), fetch_limit, 0)
                .map_err(|e| AppError::database(format!("VFS 搜索笔记失败: {}", e)))?
        } else {
            crate::vfs::VfsNoteRepo::list_notes(&vfs_db, None, fetch_limit, 0)
                .map_err(|e| AppError::database(format!("VFS 搜索笔记失败: {}", e)))?
                .into_iter()
                .filter(|note| {
                    let note_tags: std::collections::HashSet<String> =
                        note.tags.iter().map(|t| t.trim().to_lowercase()).collect();
                    tag_filters
                        .iter()
                        .all(|t| note_tags.contains(&t.to_lowercase()))
                })
                .collect::<Vec<_>>()
        };

        let mut hits = Vec::with_capacity(notes.len());
        for note in notes.into_iter().take(limit) {
            let snippet = match crate::vfs::VfsNoteRepo::get_note_content(&vfs_db, &note.id) {
                Ok(Some(content)) => build_snippet(&content, &keyword_clone, 160),
                _ => None,
            };
            hits.push(NotesSearchHit {
                id: note.id,
                title: note.title,
                snippet,
            });
        }

        Ok::<Vec<NotesSearchHit>, AppError>(hits)
    })
    .await
    .map_err(|e| AppError::internal(format!("搜索笔记任务失败: {}", e)))??;

    Ok(items)
}
#[tauri::command]
pub async fn notes_mentions_search(
    mut subject: Option<String>,
    keyword: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<NotesMentionSearchResponse> {
    subject = subject.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let trimmed = keyword.trim();
    if trimmed.is_empty() {
        return Ok(NotesMentionSearchResponse::default());
    }

    let limit = limit.unwrap_or(8).clamp(1, 40) as usize;
    let mut response = NotesMentionSearchResponse::default();

    // ===== 错题库检索 =====
    {
        use rusqlite::params;
        let conn = state
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取错题数据库连接失败: {}", e)))?;

        let pattern = format!("%{}%", escape_like_pattern(trimmed));

        let rows: Vec<rusqlite::Result<MentionMistakeHit>> = if let Some(ref subject_value) =
            subject
        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, subject, user_question, mistake_summary, tags
                       FROM mistakes
                      WHERE subject = ?1
                        AND (user_question LIKE ?2 ESCAPE '\\' OR COALESCE(mistake_summary,'') LIKE ?3 ESCAPE '\\')
                      ORDER BY datetime(updated_at) DESC
                      LIMIT ?4",
                )
                .map_err(|e| AppError::database(format!("准备错题检索语句失败: {}", e)))?;
            let rows_iter = stmt
                .query_map(
                    params![
                        subject_value,
                        pattern.clone(),
                        pattern.clone(),
                        limit as i64
                    ],
                    |row| {
                        let tags_json: String = row.get(4)?;
                        let tags: Vec<String> =
                            serde_json::from_str(&tags_json).unwrap_or_default();
                        Ok(MentionMistakeHit {
                            id: row.get(0)?,
                            subject: row.get(1)?,
                            title: row.get(2)?,
                            summary: row.get::<_, Option<String>>(3)?,
                            tags,
                        })
                    },
                )
                .map_err(|e| AppError::database(format!("执行错题检索失败: {}", e)))?;
            rows_iter.collect::<Vec<_>>()
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, subject, user_question, mistake_summary, tags
                       FROM mistakes
                      WHERE (user_question LIKE ?1 ESCAPE '\\' OR COALESCE(mistake_summary,'') LIKE ?2 ESCAPE '\\')
                      ORDER BY datetime(updated_at) DESC
                      LIMIT ?3",
                )
                .map_err(|e| AppError::database(format!("准备错题检索语句失败: {}", e)))?;
            let rows_iter = stmt
                .query_map(
                    params![pattern.clone(), pattern.clone(), limit as i64],
                    |row| {
                        let tags_json: String = row.get(4)?;
                        let tags: Vec<String> =
                            serde_json::from_str(&tags_json).unwrap_or_default();
                        Ok(MentionMistakeHit {
                            id: row.get(0)?,
                            subject: row.get(1)?,
                            title: row.get(2)?,
                            summary: row.get::<_, Option<String>>(3)?,
                            tags,
                        })
                    },
                )
                .map_err(|e| AppError::database(format!("执行错题检索失败: {}", e)))?;
            rows_iter.collect::<Vec<_>>()
        };

        for row in rows {
            if response.mistakes.len() >= limit {
                break;
            }
            match row {
                Ok(item) => response.mistakes.push(item),
                Err(err) => log::debug!("notes_mentions_search 错题结果解析失败: {}", err),
            }
        }
    }

    //     // ===== Irec 卡片检索 =====
    //     if let Ok(service) = resolve_irec_service_by_graph_id(subject.as_deref()).await {
    //         let search_request = SearchRequest {
    //             query: trimmed.to_string(),
    //             limit: Some(limit),
    //             libraries: None,
    //             learning_mode: None,
    //             recommendation_filter_level: None,
    //             tags: None,
    //             guard_center: None,
    //             guard_threshold_low: None,
    //             guard_threshold_high: None,
    //         };
    //
    //         match service.search_cards(search_request).await {
    //             Ok(search_response) => {
    //                 for result in search_response.results.into_iter().take(limit) {
    //                     let card = result.card;
    //                     let _ = subject; // 保留参数引用以避免警告
    //                     let tags = match service.get_card_tags(&card.id).await {
    //                         Ok(card_tags) => card_tags.into_iter().map(|tag| tag.name).collect(),
    //                         Err(err) => {
    //                             log::debug!("notes_mentions_search 获取卡片标签失败: {}", err);
    //                             Vec::new()
    //                         }
    //                     };
    //                     response.irec_cards.push(MentionIrecCardHit {
    //                         id: card.id.clone(),
    //                         title: card.content_problem.clone(),
    //                         insight: card.content_insight.clone(),
    //                         subject: None, // subject 已废弃
    //                         tags,
    //                         mistake_id: card.mistake_id.clone(),
    //                     });
    //                     if response.irec_cards.len() >= limit {
    //                         break;
    //                     }
    //                 }
    //             }
    //             Err(err) => {
    //                 log::debug!("notes_mentions_search Irec 检索失败: {}", err);
    //             }
    //         }
    //     }

    Ok(response)
}

