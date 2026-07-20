//! 笔记系统命令模块
//! 从 commands.rs 剥离 (原始行号: 3505-5798)

#![allow(non_snake_case)] // Tauri 命令参数使用 camelCase 与前端保持一致

use crate::commands::AppState;
use crate::data_governance::file_deletion_queue::{
    active_data_dir_from_runtime_base, asset_key_from_relative_path, enqueue_asset_deletion,
};
use crate::dstu::handler_utils::node_converters::note_to_dstu_node;
use crate::models::AppError;
use crate::unified_file_manager;
use crate::vfs::index_service::VfsIndexService;
use crate::vfs::repos::note_repo::{NoteBacklink, NoteOutgoingLink};
use crate::vfs::types::VfsCreateNoteParams;
use crate::vfs::{VfsLanceStore, VfsNoteRepo};
use chrono::Utc;
use encoding_rs::{GB18030, GBK, UTF_16BE, UTF_16LE};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::LazyLock;
use tauri::{Emitter, State, Window};
use uuid::Uuid;

type Result<T> = std::result::Result<T, AppError>;

fn strip_bom(content: String) -> String {
    content
        .strip_prefix('\u{feff}')
        .unwrap_or(&content)
        .to_string()
}

fn decode_markdown_bytes(bytes: &[u8]) -> (String, &'static str) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        if let Ok(content) = String::from_utf8(bytes[3..].to_vec()) {
            return (strip_bom(content), "UTF-8 BOM");
        }
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (decoded, _, _) = UTF_16LE.decode(&bytes[2..]);
        return (strip_bom(decoded.into_owned()), "UTF-16LE");
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (decoded, _, _) = UTF_16BE.decode(&bytes[2..]);
        return (strip_bom(decoded.into_owned()), "UTF-16BE");
    }

    if let Ok(content) = String::from_utf8(bytes.to_vec()) {
        return (strip_bom(content), "UTF-8");
    }

    let (decoded_gbk, _, had_gbk_errors) = GBK.decode(bytes);
    if !had_gbk_errors {
        return (strip_bom(decoded_gbk.into_owned()), "GBK");
    }

    let (decoded_gb18030, _, _) = GB18030.decode(bytes);
    (strip_bom(decoded_gb18030.into_owned()), "GB18030")
}

fn read_markdown_file_with_encoding(path: &Path) -> Result<(String, &'static str)> {
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::file_system(format!("读取 Markdown 文件失败: {}", e)))?;
    Ok(decode_markdown_bytes(&bytes))
}

fn derive_markdown_note_title(raw_path: &str) -> String {
    let candidate = Path::new(raw_path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().trim().to_string())
        .filter(|title| !title.is_empty());

    candidate.unwrap_or_else(|| format!("导入笔记_{}", Utc::now().format("%Y%m%d_%H%M%S")))
}

fn normalize_folder_id(folder_id: Option<&str>) -> Option<String> {
    folder_id.and_then(|id| {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// ★ 移动端修复：当标题为通用占位符（如 Android 不透明 URI 导致的 "文件"）时，
/// 尝试从 Markdown 内容提取第一个 H1 标题作为笔记名称。
fn extract_first_heading(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let title = heading.trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

/// 判断标题是否为通用占位符（无法从 URI 解析出真实文件名时的回退值）。
/// ★ 移动端修复：同时检测 Android 不透明 document ID（纯数字、xxx:digits 模式）
fn is_generic_note_title(title: &str) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty() || trimmed == "文件" {
        return true;
    }
    // 纯数字（如 Downloads provider 的 446）
    if trimmed.chars().all(|c| c.is_ascii_digit()) && !trimmed.is_empty() {
        return true;
    }
    // 含冒号且冒号后全是数字（如 document:1000019790、msf:62）
    if let Some(pos) = trimmed.find(':') {
        let after = &trimmed[pos + 1..];
        if !after.is_empty() && after.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    false
}

fn import_markdown_note_from_local_path(
    vfs_db: &crate::vfs::database::VfsDatabase,
    import_path: &Path,
    note_title: &str,
    folder_id: Option<&str>,
) -> Result<crate::dstu::types::DstuNode> {
    let (content, encoding) = read_markdown_file_with_encoding(import_path)?;

    // ★ 移动端修复：当标题为通用占位符时，从 Markdown 内容提取第一个 H1 标题
    let effective_title = if is_generic_note_title(note_title) {
        extract_first_heading(&content)
            .unwrap_or_else(|| format!("导入笔记_{}", Utc::now().format("%Y%m%d_%H%M%S")))
    } else {
        note_title.to_string()
    };

    log::info!(
        "开始导入 Markdown 笔记，title='{}'（原始='{}'），encoding={}，materialized_path={}",
        effective_title,
        note_title,
        encoding,
        import_path.display()
    );

    // 链接图维护已收敛到 repo 层（VfsNoteRepo::create_note 同事务写 note_links）
    let note = VfsNoteRepo::create_note_in_folder(
        vfs_db,
        VfsCreateNoteParams {
            title: effective_title,
            content,
            tags: vec![],
        },
        folder_id,
    )
    .map_err(|e| AppError::database(format!("导入 Markdown 笔记失败: {}", e)))?;

    Ok(note_to_dstu_node(&note))
}

fn cleanup_materialized_import_file(context: &str, cleanup_path: Option<std::path::PathBuf>) {
    if let Some(cleanup) = cleanup_path {
        if let Err(err) = std::fs::remove_file(&cleanup) {
            log::warn!(
                "{}: 清理临时导入文件失败 ({}): {}",
                context,
                cleanup.display(),
                err
            );
        }
    }
}

fn cleanup_materialized_import_files<I>(context: &str, cleanup_paths: I)
where
    I: IntoIterator<Item = Option<std::path::PathBuf>>,
{
    for cleanup_path in cleanup_paths {
        cleanup_materialized_import_file(context, cleanup_path);
    }
}

/// 归一化 subject 参数：前端历史上常漏传/传空，统一回退到 "_global"（与资产目录约定一致）
fn normalize_subject(subject: Option<String>) -> String {
    subject
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "_global".to_string())
}

fn collect_note_asset_deletion_entries_inner(
    runtime_base: &Path,
    current: &Path,
    out: &mut Vec<(String, Option<u64>)>,
) {
    let Ok(children) = std::fs::read_dir(current) else {
        return;
    };
    for child in children {
        let Ok(child) = child else {
            continue;
        };
        let path: PathBuf = child.path();
        if path.is_dir() {
            collect_note_asset_deletion_entries_inner(runtime_base, &path, out);
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(runtime_base)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let Some(key) = asset_key_from_relative_path(&rel) else {
            log::warn!("[notes] 跳过资产目录删除队列：无法归一化相对路径 {}", rel);
            continue;
        };
        let size = std::fs::metadata(&path).ok().map(|m| m.len());
        out.push((key, size));
    }
}

// ================= Notes: 独立笔记系统（CRUD） =================

/// DEPRECATED: 全量列表（含 content_md）载荷过大，新代码请使用
/// `notes_list_meta`（轻量元数据）或 `notes_list_advanced`（分页 + 过滤 + total）。
///
/// 移动端支撑：新增可选 `limit`/`offset`；默认 limit 从 1000 降到 200
/// （grep 确认 src/ 无存量 `invoke('notes_list')` 调用点，无兼容风险）。
#[tauri::command]
pub async fn notes_list(
    _subject: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::notes_manager::NoteItem>> {
    // 使用 spawn_blocking 避免 Lance 操作导致的死锁
    let notes_manager = state.notes_manager.clone();
    let limit = limit.unwrap_or(200);
    let offset = offset.unwrap_or(0);

    tokio::task::spawn_blocking(move || notes_manager.list_notes_vfs(None, limit, offset))
        .await
        .map_err(|e| AppError::internal(format!("列出笔记任务失败: {}", e)))?
}

/// 轻量列表：不返回 content_md，用于初次渲染降低载荷
#[tauri::command]
pub async fn notes_list_meta(
    _subject: Option<String>,
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
    _subject: Option<String>,
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
    _subject: Option<String>,
    note: NewNotePayload,
    state: State<'_, AppState>,
    _window: Window,
) -> Result<crate::notes_manager::NoteItem> {
    let tags: Vec<String> = note.tags.unwrap_or_default();

    // 使用 spawn_blocking 避免在异步上下文中阻塞
    // 链接图维护已收敛到 repo 层（VfsNoteRepo::create_note 同事务写 note_links）
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
    _subject: Option<String>,
    note: UpdateNotePayload,
    state: State<'_, AppState>,
    _window: Window,
) -> Result<crate::notes_manager::NoteItem> {
    // 使用 spawn_blocking 避免在异步上下文中阻塞
    // 链接图维护已收敛到 repo 层（VfsNoteRepo::update_note 正文变化时同事务重写出链）
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
    subject: Option<String>,
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
    subject: Option<String>,
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
pub async fn notes_delete(
    subject: Option<String>,
    id: String,
    state: State<'_, AppState>,
) -> Result<bool> {
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
    _subject: Option<String>,
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
    _subject: Option<String>,
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
    // 链接图维护已收敛到 repo 层（底层 update_note 正文变化时同事务重写出链）
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
    _subject: Option<String>,
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
    // 链接图维护已收敛到 repo 层（底层 update_note 正文变化时同事务重写出链）
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
    _subject: Option<String>,
    #[allow(non_snake_case)] noteId: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<()> {
    log::info!(
        "[Canvas::Command] canvas_note_set: noteId={}, content_len={}",
        noteId,
        content.len()
    );
    // 链接图维护已收敛到 repo 层（底层 update_note 正文变化时同事务重写出链）
    let notes_manager = state.notes_manager.clone();
    tokio::task::spawn_blocking(move || notes_manager.canvas_set_content(&noteId, &content))
        .await
        .map_err(|e| AppError::internal(format!("设置笔记内容任务失败: {}", e)))?
}

// ============== 回收站（硬删除） ==============

/// 笔记硬删除：彻底从数据库与磁盘移除（包含版本/资产）
///
/// ★ IO 硬化：SQLite 查询 / purge / 文件系统操作统一放入 spawn_blocking
/// （与 notes_empty_trash 对齐），避免阻塞 async runtime。
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
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let vfs_db_for_index = vfs_db.clone();
    let file_manager = state.file_manager.clone();
    let subject = normalize_subject(subject);
    let note_id = id.clone();

    let (deleted, resource_ids) = tokio::task::spawn_blocking(move || {
        // 预先收集 resource_id（用于索引清理）
        // ★ 修复：硬删除通常作用于已软删除（回收站）的笔记，必须用 including_deleted 版本，
        // 否则 resource_id 收集为空，索引（SQLite + Lance）永远不会被清理。
        let resource_ids: Vec<String> = {
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| AppError::database(format!("VFS 连接失败: {}", e)))?;
            let mut ids = Vec::new();
            if let Ok(Some(note)) =
                VfsNoteRepo::get_note_including_deleted_with_conn(&conn, &note_id)
            {
                ids.push(note.resource_id);
            }
            ids
        };

        // purge 前收集资产删除队列条目（大小必须在删除前采集）
        let runtime_base = file_manager.get_writable_app_data_dir();
        let assets_dir = runtime_base
            .join("notes_assets")
            .join(&subject)
            .join(&note_id);
        let mut pending_asset_deletions: Vec<(String, Option<u64>)> = Vec::new();
        collect_note_asset_deletion_entries_inner(
            &runtime_base,
            &assets_dir,
            &mut pending_asset_deletions,
        );

        // VFS purge_note 会删除：笔记、关联资源
        // ★ P0-4：不再用 unwrap_or(false) 吞掉错误；NotFound 视为「未删除」，其余错误向上传播
        let deleted = match crate::vfs::VfsNoteRepo::purge_note(&vfs_db, &note_id) {
            Ok(()) => true,
            Err(crate::vfs::VfsError::NotFound { .. }) => false,
            Err(e) => {
                return Err(AppError::database(format!("硬删除笔记失败: {}", e)));
            }
        };

        if deleted {
            // 清理资产目录；成功后写入资产删除队列（云同步清理）
            match file_manager.delete_note_assets_dir(&subject, &note_id) {
                Ok(_) => {
                    let active_dir = active_data_dir_from_runtime_base(&runtime_base);
                    for (key, size) in pending_asset_deletions {
                        if let Err(err) = enqueue_asset_deletion(&active_dir, &key, size) {
                            log::warn!(
                                "[notes_hard_delete] 写入资产删除队列失败（不阻塞删除）: key={}, err={}",
                                key,
                                err
                            );
                        }
                    }
                }
                Err(e) => log::warn!(
                    "[notes_hard_delete] Failed to delete note assets dir for {}: {}",
                    note_id,
                    e
                ),
            }
        }

        Ok::<(bool, Vec<String>), AppError>((deleted, resource_ids))
    })
    .await
    .map_err(|e| AppError::internal(format!("硬删除笔记任务失败: {}", e)))??;

    if deleted {
        // 清理索引（SQLite + Lance）
        let index_service = VfsIndexService::new(vfs_db_for_index);
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
///
/// ★ P0-3 修复：purge 前收集待删 note_id，purge 成功后逐个删除磁盘资产目录
/// （notes_assets/<subject>/<note_id>），并写入资产删除队列（云同步清理），
/// 与 notes_hard_delete 的资产清理语义对齐，消除资产泄漏。
#[tauri::command]
pub async fn notes_empty_trash(
    _subject: Option<String>,
    state: State<'_, AppState>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
) -> Result<usize> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let vfs_db_for_index = vfs_db.clone();
    let file_manager = state.file_manager.clone();

    // 同步 IO（SQLite + 文件系统）统一放入 spawn_blocking，避免阻塞 async runtime
    let (deleted, resource_ids) = tokio::task::spawn_blocking(move || {
        // 1) 一次查询收集待删笔记的 id 与 resource_id（避免逐条 get_note）
        let mut note_ids: Vec<String> = Vec::new();
        let mut resource_ids: Vec<String> = Vec::new();
        {
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| AppError::database(format!("VFS 连接失败: {}", e)))?;
            let mut stmt = conn
                .prepare("SELECT id, resource_id FROM notes WHERE deleted_at IS NOT NULL")
                .map_err(|e| AppError::database(format!("准备回收站查询失败: {}", e)))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| AppError::database(format!("遍历回收站失败: {}", e)))?;
            for row in rows.flatten() {
                note_ids.push(row.0);
                resource_ids.push(row.1);
            }
            resource_ids.sort();
            resource_ids.dedup();
        }

        // 2) purge 前收集各笔记的资产目录与删除队列条目。
        //    资产按 notes_assets/<subject>/<note_id> 组织；当前前端统一 "_global"，
        //    但历史数据可能分布在其他 subject 下，故扫描全部 subject 目录。
        let runtime_base = file_manager.get_writable_app_data_dir();
        let notes_assets_root = runtime_base.join("notes_assets");
        let mut pending_dirs: Vec<(String, String, Vec<(String, Option<u64>)>)> = Vec::new();
        if !note_ids.is_empty() && notes_assets_root.is_dir() {
            if let Ok(subject_entries) = std::fs::read_dir(&notes_assets_root) {
                for subject_entry in subject_entries.flatten() {
                    let subject_path = subject_entry.path();
                    if !subject_path.is_dir() {
                        continue;
                    }
                    let Some(subject_name) =
                        subject_entry.file_name().to_str().map(|s| s.to_string())
                    else {
                        continue;
                    };
                    for note_id in &note_ids {
                        let note_dir = subject_path.join(note_id);
                        if note_dir.is_dir() {
                            let mut entries = Vec::new();
                            collect_note_asset_deletion_entries_inner(
                                &runtime_base,
                                &note_dir,
                                &mut entries,
                            );
                            pending_dirs.push((subject_name.clone(), note_id.clone(), entries));
                        }
                    }
                }
            }
        }

        // 3) 批量清空回收站（repo 层每条 purge 均有 SAVEPOINT 事务保护）
        let deleted = crate::vfs::VfsNoteRepo::purge_deleted_notes(&vfs_db)
            .map_err(|e| AppError::database(format!("VFS 清空回收站失败: {}", e)))?;

        // 4) purge 成功后删除磁盘资产目录；成功删除的目录写入资产删除队列
        let active_dir = active_data_dir_from_runtime_base(&runtime_base);
        for (subject, note_id, entries) in pending_dirs {
            match file_manager.delete_note_assets_dir(&subject, &note_id) {
                Ok(_) => {
                    for (key, size) in entries {
                        if let Err(err) = enqueue_asset_deletion(&active_dir, &key, size) {
                            log::warn!(
                                "[notes_empty_trash] 写入资产删除队列失败（不阻塞清空）: key={}, err={}",
                                key,
                                err
                            );
                        }
                    }
                }
                Err(e) => log::warn!(
                    "[notes_empty_trash] 删除笔记资产目录失败 {}/{}: {}",
                    subject,
                    note_id,
                    e
                ),
            }
        }

        Ok::<(usize, Vec<String>), AppError>((deleted, resource_ids))
    })
    .await
    .map_err(|e| AppError::internal(format!("清空回收站任务失败: {}", e)))??;

    // 5) 清理索引（SQLite + Lance）
    if !resource_ids.is_empty() {
        let index_service = VfsIndexService::new(vfs_db_for_index);
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
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let page_val = page.unwrap_or(0);
    let page_size_val = page_size.unwrap_or(20);
    let limit = page_size_val as u32;
    let offset = (page_val * page_size_val) as u32;

    // 同步 SQLite 查询放入 spawn_blocking
    let (items, total_items) = tokio::task::spawn_blocking(move || {
        let deleted_notes = crate::vfs::VfsNoteRepo::list_deleted_notes(&vfs_db, limit, offset)
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

        let total_items =
            crate::vfs::VfsNoteRepo::count_deleted_notes(&vfs_db).unwrap_or(items.len() as i64);

        Ok::<_, AppError>((items, total_items))
    })
    .await
    .map_err(|e| AppError::internal(format!("查询回收站任务失败: {}", e)))??;

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
    subject: Option<String>,
    id: String,
    state: State<'_, AppState>,
    _window: Window,
) -> Result<bool> {
    // 使用 spawn_blocking 避免 Lance 操作导致的死锁
    let notes_manager = state.notes_manager.clone();
    let _subject = subject; // 兼容旧前端仅传 id 的调用；VFS 版本不需要 subject

    // ★ 切换到 VFS 版本
    // （原先恢复成功后还会二次 get_note_vfs 并丢弃结果，属无意义查询，已移除）
    let ok = tokio::task::spawn_blocking(move || notes_manager.restore_note_vfs(&id))
        .await
        .map_err(|e| AppError::internal(format!("恢复笔记任务失败: {}", e)))??;

    Ok(ok)
}

// ============== Notes 资源（图片等） ==============

#[tauri::command]
pub async fn notes_save_asset(
    subject: Option<String>,
    note_id: String,
    base64_data: String,
    default_ext: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let subject = normalize_subject(subject);
    let ext = default_ext.unwrap_or_else(|| "jpg".to_string());
    // base64 解码 + 文件写入属同步 IO，放入 spawn_blocking
    let file_manager = state.file_manager.clone();
    let (abs, rel) = tokio::task::spawn_blocking(move || {
        file_manager.save_note_asset_from_base64(&subject, &note_id, &base64_data, &ext)
    })
    .await
    .map_err(|e| AppError::internal(format!("保存笔记资产任务失败: {}", e)))??;

    Ok(serde_json::json!({ "absolute_path": abs, "relative_path": rel }))
}

#[tauri::command]
pub async fn notes_list_assets(
    subject: Option<String>,
    noteId: String,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>> {
    let subject = normalize_subject(subject);
    let file_manager = state.file_manager.clone();
    let rows =
        tokio::task::spawn_blocking(move || file_manager.list_note_assets(&subject, &noteId))
            .await
            .map_err(|e| AppError::internal(format!("列出笔记资产任务失败: {}", e)))??;
    let out = rows
        .into_iter()
        .map(|(abs, rel)| serde_json::json!({"absolute_path": abs, "relative_path": rel}))
        .collect();
    Ok(out)
}

#[tauri::command]
pub async fn notes_delete_asset(relative_path: String, state: State<'_, AppState>) -> Result<bool> {
    log::info!("[notes_delete_asset] 收到删除请求: {}", relative_path);
    let file_manager = state.file_manager.clone();
    let deleted = tokio::task::spawn_blocking(move || {
        let queue_key = asset_key_from_relative_path(&relative_path);
        let runtime_base = file_manager.get_writable_app_data_dir();
        let active_dir = active_data_dir_from_runtime_base(&runtime_base);
        // 大小必须在删除前采集
        let size = queue_key.as_deref().and_then(|key| {
            let local_rel = key
                .strip_prefix("active/")
                .or_else(|| key.strip_prefix("app_data/"))
                .unwrap_or(&relative_path);
            std::fs::metadata(active_dir.join(local_rel))
                .ok()
                .map(|m| m.len())
        });
        let deleted = file_manager.delete_note_asset(&relative_path)?;
        if deleted {
            if let Some(key) = queue_key {
                if let Err(err) = enqueue_asset_deletion(&active_dir, &key, size) {
                    log::warn!(
                        "[notes_delete_asset] 写入资产删除队列失败（不阻塞删除）: key={}, err={}",
                        key,
                        err
                    );
                }
            }
        }
        Ok::<bool, AppError>(deleted)
    })
    .await
    .map_err(|e| AppError::internal(format!("删除笔记资产任务失败: {}", e)))??;
    log::info!("[notes_delete_asset] 删除结果: {}", deleted);
    Ok(deleted)
}

/// 解析相对资源路径为绝对路径（限定在 app_data_dir 子树内）
///
/// ★ P2-4 修复：相对路径分支同样执行 canonicalize + starts_with 越界校验，
/// 并统一拒绝包含 `..` 上跳的路径（与 delete_note_asset 的校验强度对齐）。
#[tauri::command]
pub async fn notes_resolve_asset_path(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let file_manager = state.file_manager.clone();
    tokio::task::spawn_blocking(move || {
        let base = file_manager.get_writable_app_data_dir();
        let base_can = std::fs::canonicalize(&base)
            .map_err(|e| AppError::file_system(format!("解析app_data_dir失败: {}", e)))?;

        let p = std::path::PathBuf::from(&relative_path);
        let candidate = if p.is_absolute() {
            p
        } else {
            base.join(&relative_path)
        };

        // 词法层面先拒绝任何 `..` 上跳（canonicalize 对不存在的路径无能为力）
        if candidate
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(AppError::validation("拒绝访问：路径包含上级目录跳转"));
        }

        match std::fs::canonicalize(&candidate) {
            Ok(can) => {
                if !can.starts_with(&base_can) {
                    return Err(AppError::validation("拒绝访问：超出应用数据目录"));
                }
                Ok(can.to_string_lossy().to_string())
            }
            Err(_) => {
                // 目标暂不存在：保持旧行为返回拼接路径，但仍要求位于 base 子树内
                if !(candidate.starts_with(&base) || candidate.starts_with(&base_can)) {
                    return Err(AppError::validation("拒绝访问：超出应用数据目录"));
                }
                Ok(candidate.to_string_lossy().to_string())
            }
        }
    })
    .await
    .map_err(|e| AppError::internal(format!("解析资产路径任务失败: {}", e)))?
}
// 资产索引：扫描并返回数量（不写入数据库）
#[tauri::command]
pub async fn notes_assets_index_scan(
    subject: Option<String>,
    noteId: String,
    state: State<'_, AppState>,
) -> Result<usize> {
    let subject = normalize_subject(subject);
    let file_manager = state.file_manager.clone();
    tokio::task::spawn_blocking(move || {
        let rows = file_manager.list_note_assets(&subject, &noteId)?;
        Ok::<usize, AppError>(rows.len())
    })
    .await
    .map_err(|e| AppError::internal(format!("资产索引扫描任务失败: {}", e)))?
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
// ★ P2-2：Markdown 图片/链接正则预编译（原先在每条笔记的循环内 Regex::new().unwrap()）
static MD_LINK_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"!\[[^\]]*\]\(([^)]+)\)|\[[^\]]*\]\(([^)]+)\)")
        .expect("invalid md link regex")
});

#[tauri::command]
pub async fn notes_assets_scan_orphans(
    subject: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    let subject = normalize_subject(subject);
    let file_manager = state.file_manager.clone();
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    // 全库正文扫描 + 文件系统遍历属重 IO，放入 spawn_blocking（P2-2）
    tokio::task::spawn_blocking(move || {
        use std::collections::HashSet;
        // 1) 收集该 subject 下所有资产相对路径（基于文件系统）
        let base_dir = file_manager.get_writable_app_data_dir();
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
            for cap in MD_LINK_REGEX.captures_iter(trimmed) {
                for i in 1..=2 {
                    if let Some(m) = cap.get(i) {
                        add_ref_path(&mut refs, m.as_str());
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
                        let path = candidate.split_whitespace().next().unwrap_or("");
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
        Ok::<Vec<String>, AppError>(orphans)
    })
    .await
    .map_err(|e| AppError::internal(format!("孤儿资产扫描任务失败: {}", e)))?
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
    let file_manager = state.file_manager.clone();
    tokio::task::spawn_blocking(move || {
        let runtime_base = file_manager.get_writable_app_data_dir();
        let active_dir = active_data_dir_from_runtime_base(&runtime_base);
        let mut deleted = 0usize;
        for p in &paths {
            let queue_key = asset_key_from_relative_path(p);
            // 大小必须在删除前采集（删除后 metadata 必然失败）
            let size = queue_key.as_deref().and_then(|key| {
                let local_rel = key
                    .strip_prefix("active/")
                    .or_else(|| key.strip_prefix("app_data/"))
                    .unwrap_or(p);
                std::fs::metadata(active_dir.join(local_rel))
                    .ok()
                    .map(|m| m.len())
            });
            if file_manager.delete_note_asset(p)? {
                if let Some(key) = queue_key {
                    if let Err(err) = enqueue_asset_deletion(&active_dir, &key, size) {
                        log::warn!(
                            "[notes_assets_bulk_delete] 写入资产删除队列失败（不阻塞删除）: key={}, err={}",
                            key,
                            err
                        );
                    }
                } else {
                    log::warn!(
                        "[notes_assets_bulk_delete] 跳过资产删除队列：无法归一化相对路径 {}",
                        p
                    );
                }
                deleted += 1;
            }
        }
        Ok::<usize, AppError>(deleted)
    })
    .await
    .map_err(|e| AppError::internal(format!("批量删除资产任务失败: {}", e)))?
}

// ============== RAG FTS 索引维护 ==============

/// @deprecated 空壳命令：RAG 检索已迁移到 Lance 原生 FTS，无索引可重建，恒返回 0。
/// 保留注册仅为兼容尚未清理的旧前端调用点（防断链）；新代码请勿调用。
/// 笔记全文检索索引（notes_fts）由触发器自动维护，无需手动重建。
#[tauri::command]
pub async fn rag_rebuild_fts_index(state: State<'_, AppState>) -> Result<usize> {
    let _ = state;
    log::info!("[deprecated] rag_rebuild_fts_index：Lance RAG 使用原生 FTS，无需重建，恒返回 0");
    Ok(0)
}

/// @deprecated 空壳命令：Notes RAG 已使用 Lance 内置 FTS，无索引可重建，恒返回 0。
/// 保留注册仅为兼容尚未清理的旧前端调用点（防断链）；新代码请勿调用。
#[tauri::command]
pub async fn notes_rag_rebuild_fts_index(state: State<'_, AppState>) -> Result<usize> {
    let _ = state;
    log::info!(
        "[deprecated] notes_rag_rebuild_fts_index：Notes RAG 使用 Lance 内置 FTS，无需重建，恒返回 0"
    );
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
    /// @deprecated 版本历史表已删除（V20260214 迁移），该开关不再产生任何版本数据；
    /// 仅为兼容旧调用而保留，传任何值均不影响导出内容。
    pub include_versions: Option<bool>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct NotesExportSingleCommandRequest {
    /// 学科分区（历史参数）。前端统一使用 "_global"；
    /// ★ P0-1 契约修复：原为必填 String，前端未传导致反序列化失败，改为可选。
    #[serde(default)]
    pub subject: Option<String>,
    pub note_id: String,
    pub output_path: Option<String>,
    /// @deprecated 版本历史表已删除（V20260214 迁移），该开关不再产生任何版本数据；
    /// 仅为兼容旧调用而保留。
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesImportMarkdownRequest {
    pub file_path: String,
    #[serde(default)]
    pub title_hint: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesImportMarkdownBatchItem {
    pub file_path: String,
    #[serde(default)]
    pub title_hint: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesImportMarkdownBatchRequest {
    pub items: Vec<NotesImportMarkdownBatchItem>,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct NotesImportMarkdownBatchFailure {
    pub file_path: String,
    pub message: String,
}

#[derive(Debug, serde::Serialize)]
pub struct NotesImportMarkdownBatchResponse {
    pub imported: Vec<crate::dstu::types::DstuNode>,
    pub failed: Vec<NotesImportMarkdownBatchFailure>,
}

#[tauri::command]
pub async fn notes_import_markdown(
    request: NotesImportMarkdownRequest,
    state: State<'_, AppState>,
    window: Window,
) -> Result<crate::dstu::types::DstuNode> {
    let raw_path = request.file_path.trim().to_string();
    if raw_path.is_empty() {
        return Err(AppError::validation("Markdown 文件路径不能为空"));
    }

    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let temp_dir = state
        .file_manager
        .get_writable_app_data_dir()
        .join("temp_markdown_note_import");
    let materialized = unified_file_manager::ensure_local_path(&window, &raw_path, &temp_dir)?;
    let (import_path, cleanup_path) = materialized.into_owned();
    let folder_id = normalize_folder_id(request.folder_id.as_deref());
    let note_title = derive_markdown_note_title(
        request
            .title_hint
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&raw_path),
    );

    log::info!(
        "收到 Markdown 笔记导入命令，文件：{}，folder_id={:?}",
        raw_path,
        folder_id
    );

    let import_result: Result<crate::dstu::types::DstuNode> =
        tokio::task::spawn_blocking(move || {
            import_markdown_note_from_local_path(
                &vfs_db,
                &import_path,
                &note_title,
                folder_id.as_deref(),
            )
        })
        .await
        .map_err(|e| AppError::internal(format!("导入 Markdown 笔记任务失败: {}", e)))?;

    cleanup_materialized_import_file("notes_import_markdown", cleanup_path);

    import_result
}

#[tauri::command]
pub async fn notes_import_markdown_batch(
    request: NotesImportMarkdownBatchRequest,
    state: State<'_, AppState>,
    window: Window,
) -> Result<NotesImportMarkdownBatchResponse> {
    if request.items.is_empty() {
        return Ok(NotesImportMarkdownBatchResponse {
            imported: vec![],
            failed: vec![],
        });
    }

    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let folder_id = normalize_folder_id(request.folder_id.as_deref());
    let temp_dir = state
        .file_manager
        .get_writable_app_data_dir()
        .join("temp_markdown_note_import");

    let mut materialized_items = Vec::with_capacity(request.items.len());
    for item in request.items {
        let raw_path = item.file_path.trim().to_string();
        if raw_path.is_empty() {
            cleanup_materialized_import_files(
                "notes_import_markdown_batch",
                materialized_items
                    .drain(..)
                    .map(|(_, _, cleanup_path, _)| cleanup_path),
            );
            return Err(AppError::validation("Markdown 文件路径不能为空"));
        }

        let materialized =
            match unified_file_manager::ensure_local_path(&window, &raw_path, &temp_dir) {
                Ok(path) => path,
                Err(error) => {
                    cleanup_materialized_import_files(
                        "notes_import_markdown_batch",
                        materialized_items
                            .drain(..)
                            .map(|(_, _, cleanup_path, _)| cleanup_path),
                    );
                    return Err(error);
                }
            };
        let (import_path, cleanup_path) = materialized.into_owned();
        let note_title = derive_markdown_note_title(
            item.title_hint
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&raw_path),
        );
        materialized_items.push((raw_path, import_path, cleanup_path, note_title));
    }

    let cleanup_paths: Vec<Option<std::path::PathBuf>> = materialized_items
        .iter()
        .map(|(_, _, cleanup_path, _)| cleanup_path.clone())
        .collect();
    let task_items: Vec<(String, std::path::PathBuf, String)> = materialized_items
        .into_iter()
        .map(|(raw_path, import_path, _cleanup_path, note_title)| {
            (raw_path, import_path, note_title)
        })
        .collect();
    let folder_id_for_task = folder_id.clone();
    let batch_result = tokio::task::spawn_blocking(move || {
        let mut imported = Vec::new();
        let mut failed = Vec::new();

        for (raw_path, import_path, note_title) in &task_items {
            match import_markdown_note_from_local_path(
                &vfs_db,
                import_path,
                note_title,
                folder_id_for_task.as_deref(),
            ) {
                Ok(node) => imported.push(node),
                Err(error) => failed.push(NotesImportMarkdownBatchFailure {
                    file_path: raw_path.clone(),
                    message: error.to_string(),
                }),
            }
        }

        NotesImportMarkdownBatchResponse { imported, failed }
    })
    .await
    .map_err(|e| AppError::internal(format!("批量导入 Markdown 笔记任务失败: {}", e)))?;

    cleanup_materialized_import_files("notes_import_markdown_batch", cleanup_paths);

    Ok(batch_result)
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_materialized_import_files, decode_markdown_bytes, derive_markdown_note_title,
        extract_first_heading, is_generic_note_title,
    };
    use std::fs;

    fn unique_temp_path(file_name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("{}_{}", uuid::Uuid::new_v4(), file_name))
    }

    #[test]
    fn decode_markdown_bytes_strips_utf8_bom() {
        let bytes = vec![0xEF, 0xBB, 0xBF, b'#', b' ', b'H', b'i'];
        let (content, encoding) = decode_markdown_bytes(&bytes);
        assert_eq!(content, "# Hi");
        assert_eq!(encoding, "UTF-8 BOM");
    }

    #[test]
    fn decode_markdown_bytes_supports_utf16le() {
        let bytes = vec![0xFF, 0xFE, 0x23, 0x00, 0x20, 0x00, 0x48, 0x00, 0x69, 0x00];
        let (content, encoding) = decode_markdown_bytes(&bytes);
        assert_eq!(content, "# Hi");
        assert_eq!(encoding, "UTF-16LE");
    }

    #[test]
    fn derive_markdown_note_title_uses_file_stem() {
        assert_eq!(derive_markdown_note_title("/tmp/线代笔记.md"), "线代笔记");
    }

    #[test]
    fn extract_first_heading_finds_h1() {
        assert_eq!(
            extract_first_heading("# 线性代数笔记\n\n内容..."),
            Some("线性代数笔记".to_string())
        );
    }

    #[test]
    fn extract_first_heading_skips_h2() {
        assert_eq!(extract_first_heading("## 二级标题\n\n内容"), None);
    }

    #[test]
    fn extract_first_heading_returns_none_for_no_heading() {
        assert_eq!(extract_first_heading("普通文本\n没有标题"), None);
    }

    #[test]
    fn extract_first_heading_trims_whitespace() {
        assert_eq!(
            extract_first_heading("#   带空格的标题  \n"),
            Some("带空格的标题".to_string())
        );
    }

    #[test]
    fn is_generic_note_title_detects_placeholder() {
        assert!(is_generic_note_title("文件"));
        assert!(is_generic_note_title("  文件  "));
        assert!(is_generic_note_title(""));
        assert!(is_generic_note_title("   "));
    }

    #[test]
    fn is_generic_note_title_detects_opaque_document_ids() {
        assert!(is_generic_note_title("446"));
        assert!(is_generic_note_title("1000019790"));
        assert!(is_generic_note_title("document:1000019790"));
        assert!(is_generic_note_title("msf:62"));
        assert!(is_generic_note_title("image:12345"));
    }

    #[test]
    fn is_generic_note_title_allows_real_names() {
        assert!(!is_generic_note_title("线代笔记"));
        assert!(!is_generic_note_title("notes"));
        assert!(!is_generic_note_title("file:with_colon_text"));
        assert!(!is_generic_note_title("chapter1"));
    }

    #[test]
    fn cleanup_materialized_import_files_removes_existing_files() {
        let first = unique_temp_path("md_import_cleanup_1.md");
        let second = unique_temp_path("md_import_cleanup_2.md");

        fs::write(&first, "a").expect("write first temp file");
        fs::write(&second, "b").expect("write second temp file");

        cleanup_materialized_import_files(
            "notes_import_markdown_batch",
            vec![Some(first.clone()), Some(second.clone())],
        );

        assert!(!first.exists(), "first temp file should be deleted");
        assert!(!second.exists(), "second temp file should be deleted");
    }
}

// Notes DB 运维
#[derive(Debug, serde::Serialize)]
pub struct NotesDbStats {
    pub db_path: String,
    pub file_size_bytes: u64,
    pub total_notes: i64,
    /// 版本历史已移除（V20260214 迁移 DROP notes_versions），恒为 0，仅为兼容旧前端保留字段
    pub total_versions: i64,
    /// notes_assets 目录下的文件总数（★ P2-5：原先恒 0，现为真实统计）
    pub total_assets: i64,
    /// notes_assets 目录下的文件总字节数
    pub total_asset_bytes: u64,
}

#[tauri::command]
pub async fn notes_db_stats(state: State<'_, AppState>) -> Result<NotesDbStats> {
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let file_manager = state.file_manager.clone();

    tokio::task::spawn_blocking(move || {
        let path = vfs_db.db_path().to_path_buf();
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let total_notes: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .unwrap_or(0);
        // 版本历史表已删除，保持 0（见字段注释）
        let total_versions: i64 = 0;

        // ★ P2-5：递归统计 notes_assets 目录的文件数与字节数
        let mut total_assets: i64 = 0;
        let mut total_asset_bytes: u64 = 0;
        let assets_root = file_manager
            .get_writable_app_data_dir()
            .join("notes_assets");
        if assets_root.is_dir() {
            let mut stack = vec![assets_root];
            while let Some(dir) = stack.pop() {
                let Ok(children) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in children.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if path.is_file() {
                        total_assets += 1;
                        total_asset_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                    }
                }
            }
        }

        Ok::<NotesDbStats, AppError>(NotesDbStats {
            db_path: path.to_string_lossy().to_string(),
            file_size_bytes: size,
            total_notes,
            total_versions,
            total_assets,
            total_asset_bytes,
        })
    })
    .await
    .map_err(|e| AppError::internal(format!("统计笔记库任务失败: {}", e)))?
}

#[tauri::command]
pub async fn notes_db_vacuum(state: State<'_, AppState>) -> Result<bool> {
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    // VACUUM 可能耗时较长，放入 spawn_blocking（P2-3）
    tokio::task::spawn_blocking(move || {
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        conn.execute_batch("VACUUM;")
            .map_err(|e| AppError::database(e.to_string()))?;
        Ok::<bool, AppError>(true)
    })
    .await
    .map_err(|e| AppError::internal(format!("VACUUM 任务失败: {}", e)))?
}

// 列出推荐标签（按使用频次排序）
#[tauri::command]
pub async fn notes_list_tags(
    _subject: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    // 全表扫描 tags JSON 属同步 IO，放入 spawn_blocking（P2-3）
    tokio::task::spawn_blocking(move || {
        crate::vfs::VfsNoteRepo::list_tags(&vfs_db, 50)
            .map_err(|e| AppError::database(format!("VFS 获取标签失败: {}", e)))
    })
    .await
    .map_err(|e| AppError::internal(format!("获取标签任务失败: {}", e)))?
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

/// 笔记 mention 命中（`[[` 自动补全的主数据源）
#[derive(Debug, Serialize, Clone)]
pub struct MentionNoteHit {
    pub id: String,
    pub title: String,
    /// 标题命中为 None；正文命中附带摘要
    pub snippet: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct NotesMentionSearchResponse {
    /// 笔记命中（★ 2026-07-25 新增：mention 场景的主结果，按标题优先检索笔记库）
    pub notes: Vec<MentionNoteHit>,
    /// 错题库命中（历史字段：语义为错题而非笔记，保留以兼容旧前端）
    pub mistakes: Vec<MentionMistakeHit>,
    /// @deprecated Irec 检索已下线，恒为空数组；保留字段防旧前端解构报错
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

/// 笔记全文检索（标题 + 正文）。
///
/// ★ 2026-07-25 接线 SOTA 检索路径：
/// - 普通关键词走 `VfsNoteRepo::search_notes_with_snippets`：
///   notes_fts（FTS5 trigram，bm25 标题权重 5:1）+ <3 字符 LIKE 回退，
///   单查询取回正文并生成摘要（无 N+1）。
/// - `tag:xxx` 前缀走规范化 note_tags 表 JOIN（AND 语义，精确匹配，
///   消除历史内存过滤 + LIKE 假阳性）；可与剩余关键词组合。
/// - 返回结构 NotesSearchHit 保持不变，前端无感知。
#[tauri::command]
pub async fn notes_search(
    _subject: Option<String>,
    keyword: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<NotesSearchHit>> {
    let limit = limit.unwrap_or(50).clamp(1, 200) as u32;
    if keyword.trim().is_empty() {
        return Ok(vec![]);
    }

    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    // 解析 tag: 前缀；剩余 token 作为普通关键词
    let mut tag_filters: Vec<String> = Vec::new();
    let mut text_tokens: Vec<&str> = Vec::new();
    for part in keyword.split_whitespace() {
        match part.strip_prefix("tag:") {
            Some(tag) if !tag.trim().is_empty() => tag_filters.push(tag.trim().to_string()),
            Some(_) => {}
            None => text_tokens.push(part),
        }
    }
    let text_keyword = text_tokens.join(" ");

    // 使用 spawn_blocking 避免阻塞 async 线程
    let items = tokio::task::spawn_blocking(move || {
        let hits = if tag_filters.is_empty() {
            crate::vfs::VfsNoteRepo::search_notes_with_snippets(&vfs_db, &text_keyword, limit)
                .map_err(|e| AppError::database(format!("VFS 搜索笔记失败: {}", e)))?
        } else {
            let kw = if text_keyword.trim().is_empty() {
                None
            } else {
                Some(text_keyword.as_str())
            };
            crate::vfs::VfsNoteRepo::search_notes_by_tags_with_snippets(
                &vfs_db,
                kw,
                &tag_filters,
                limit,
            )
            .map_err(|e| AppError::database(format!("VFS 标签搜索笔记失败: {}", e)))?
        };

        Ok::<Vec<NotesSearchHit>, AppError>(
            hits.into_iter()
                .map(|(note, snippet)| NotesSearchHit {
                    id: note.id,
                    title: note.title,
                    snippet,
                })
                .collect(),
        )
    })
    .await
    .map_err(|e| AppError::internal(format!("搜索笔记任务失败: {}", e)))??;

    Ok(items)
}
/// Mention（`[[` / `@`）联想检索。
///
/// ★ 2026-07-25 重写：
/// - 修复"搜的是错题不是笔记"：新增 `notes` 字段作为主结果，按笔记**标题**
///   优先检索（前缀命中 > 短标题 > 最近编辑），标题命中不足时用 FTS 正文
///   命中补齐（附摘要）。
/// - IO 硬化：SQLite 查询统一放入 spawn_blocking，不再在 async 路径同步拿连接。
/// - `mistakes` 保留历史语义（错题命中）以兼容旧前端；`irec_cards` 恒为空
///   （Irec 检索已下线，原实现见 git 历史）。
#[tauri::command]
pub async fn notes_mentions_search(
    subject: Option<String>,
    keyword: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<NotesMentionSearchResponse> {
    let subject = subject.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let trimmed = keyword.trim().to_string();
    if trimmed.is_empty() {
        return Ok(NotesMentionSearchResponse::default());
    }

    let limit = limit.unwrap_or(8).clamp(1, 40) as usize;
    let database = state.database.clone();
    let vfs_db = state.vfs_db.clone();

    tokio::task::spawn_blocking(move || {
        let mut response = NotesMentionSearchResponse::default();

        // ===== 笔记检索（标题优先，FTS 正文补齐） =====
        if let Some(vfs_db) = vfs_db.as_deref() {
            let title_hits = VfsNoteRepo::search_note_titles(vfs_db, &trimmed, limit as u32)
                .map_err(|e| AppError::database(format!("笔记标题检索失败: {}", e)))?;
            let mut seen: std::collections::HashSet<String> =
                title_hits.iter().map(|n| n.id.clone()).collect();
            for note in title_hits {
                response.notes.push(MentionNoteHit {
                    id: note.id,
                    title: note.title,
                    snippet: None,
                    tags: note.tags,
                });
            }

            if response.notes.len() < limit {
                let remaining = (limit - response.notes.len()) as u32;
                // 标题命中不足时，用全文检索（bm25 标题加权）补齐并附摘要
                let body_hits = VfsNoteRepo::search_notes_with_snippets(
                    vfs_db,
                    &trimmed,
                    remaining.saturating_mul(2).min(80),
                )
                .map_err(|e| AppError::database(format!("笔记全文检索失败: {}", e)))?;
                for (note, snippet) in body_hits {
                    if response.notes.len() >= limit {
                        break;
                    }
                    if !seen.insert(note.id.clone()) {
                        continue;
                    }
                    response.notes.push(MentionNoteHit {
                        id: note.id,
                        title: note.title,
                        snippet,
                        tags: note.tags,
                    });
                }
            }
        }

        // ===== 错题库检索（历史行为保留，供 mention 面板的"错题"分组） =====
        {
            use rusqlite::params;
            let conn = database
                .get_conn_safe()
                .map_err(|e| AppError::database(format!("获取错题数据库连接失败: {}", e)))?;

            let pattern = format!("%{}%", escape_like_pattern(&trimmed));

            let rows: Vec<rusqlite::Result<MentionMistakeHit>> =
                if let Some(ref subject_value) = subject {
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

        // Irec 卡片检索已下线：irec_cards 恒为空（字段保留见结构体注释）

        Ok::<NotesMentionSearchResponse, AppError>(response)
    })
    .await
    .map_err(|e| AppError::internal(format!("mention 检索任务失败: {}", e)))?
}

// ============== 笔记链接图（note_links，V20260725 迁移） ==============
//
// 数据维护策略（★ 2026-07-20 收敛到 repo 层单一咽喉）：
// - 增量：VfsNoteRepo::create_note / update_note 在正文落库的同一事务内
//   写 note_links，所有写路径（本模块 / DSTU / canvas / memory 等）自动受益；
// - 兜底：启动期一次性全量回填（VfsNoteRepo::backfill_note_links_once，
//   修复历史存量缺口）+ 手动 notes_rebuild_links 命令；
// - 硬删除 / 新建 / 重命名的解析状态由数据库触发器自动跟随。

fn map_vfs_error(context: &str, e: crate::vfs::VfsError) -> AppError {
    match e {
        crate::vfs::VfsError::NotFound { .. } => AppError::not_found(format!("{}: {}", context, e)),
        other => AppError::database(format!("{}: {}", context, other)),
    }
}

/// 反链查询：哪些笔记链接到了指定笔记。
///
/// 命中条件：按 id 解析成功的链接，或标题恰好等于本笔记标题的未解析链接
/// （容忍重建滞后）；自链与软删除来源不计入。
#[tauri::command]
pub async fn notes_get_backlinks(
    _subject: Option<String>,
    noteId: String,
    state: State<'_, AppState>,
) -> Result<Vec<NoteBacklink>> {
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    tokio::task::spawn_blocking(move || {
        VfsNoteRepo::backlinks_for(&vfs_db, &noteId).map_err(|e| map_vfs_error("查询反链失败", e))
    })
    .await
    .map_err(|e| AppError::internal(format!("查询反链任务失败: {}", e)))?
}

/// 出链查询：指定笔记链接到了哪些目标（含未解析链接，按正文位置排序）。
#[tauri::command]
pub async fn notes_get_outgoing_links(
    _subject: Option<String>,
    noteId: String,
    state: State<'_, AppState>,
) -> Result<Vec<NoteOutgoingLink>> {
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    tokio::task::spawn_blocking(move || {
        VfsNoteRepo::outgoing_links_for(&vfs_db, &noteId)
            .map_err(|e| map_vfs_error("查询出链失败", e))
    })
    .await
    .map_err(|e| AppError::internal(format!("查询出链任务失败: {}", e)))?
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesRebuildLinksResponse {
    /// 处理的活跃笔记数
    pub note_count: usize,
    /// 写入的链接行数
    pub link_count: usize,
}

/// 全库重建链接图：逐批解析所有活跃笔记正文，重写 note_links。
///
/// 分批事务（默认每批 200 条，可传 batchSize 覆盖），spawn_blocking 执行；
/// 用于首次启用链接图、数据修复或导入大量笔记后的一致性兜底。
#[tauri::command]
pub async fn notes_rebuild_links(
    _subject: Option<String>,
    batchSize: Option<u32>,
    state: State<'_, AppState>,
) -> Result<NotesRebuildLinksResponse> {
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let batch_size = batchSize.unwrap_or(200).clamp(1, 2000) as usize;

    let (note_count, link_count) = tokio::task::spawn_blocking(move || {
        VfsNoteRepo::rebuild_note_links(&vfs_db, batch_size)
            .map_err(|e| AppError::database(format!("重建链接图失败: {}", e)))
    })
    .await
    .map_err(|e| AppError::internal(format!("重建链接图任务失败: {}", e)))??;

    log::info!(
        "[notes_rebuild_links] 完成：notes={}, links={}",
        note_count,
        link_count
    );
    Ok(NotesRebuildLinksResponse {
        note_count,
        link_count,
    })
}

/// 未链接提及：正文/标题中出现了指定笔记标题、但尚未链接到它的候选笔记。
///
/// 走 notes_fts（标题作为 phrase，<3 字符回退 LIKE），排除自身与已链接来源；
/// 返回结构复用 NotesSearchHit（id/title/snippet）。
#[tauri::command]
pub async fn notes_unlinked_mentions(
    _subject: Option<String>,
    noteId: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<NotesSearchHit>> {
    let vfs_db = state
        .vfs_db
        .clone()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let limit = limit.unwrap_or(20).clamp(1, 100);

    tokio::task::spawn_blocking(move || {
        let hits = VfsNoteRepo::unlinked_mention_candidates(&vfs_db, &noteId, limit)
            .map_err(|e| map_vfs_error("查询未链接提及失败", e))?;
        Ok::<Vec<NotesSearchHit>, AppError>(
            hits.into_iter()
                .map(|(note, snippet)| NotesSearchHit {
                    id: note.id,
                    title: note.title,
                    snippet,
                })
                .collect(),
        )
    })
    .await
    .map_err(|e| AppError::internal(format!("查询未链接提及任务失败: {}", e)))?
}
