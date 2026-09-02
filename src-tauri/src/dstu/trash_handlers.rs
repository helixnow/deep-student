//! DSTU 回收站命令处理器
//!
//! 提供统一的软删除、恢复、列表和永久删除命令。

use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use tauri::{State, Window};
use tracing::{error, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::repos::{
    VfsEssayRepo, VfsExamRepo, VfsFileRepo, VfsFolderRepo, VfsMindMapRepo, VfsNoteRepo,
    VfsTextbookRepo, VfsTranslationRepo,
};

use super::error::DstuError;
use super::handler_utils::{emit_watch_event, parse_timestamp, purge_resource_by_type_if_trashed};
use super::types::{DstuNode, DstuNodeType, DstuWatchEvent};

// ============================================================================
// 向量索引清理辅助函数
// ============================================================================

/// 根据类型和 ID 查找 resource_id（用于向量索引清理）
///
/// 文件夹没有 resource_id，返回 None。
fn lookup_resource_id(db: &VfsDatabase, item_type: &str, item_id: &str) -> Option<String> {
    let conn = db.get_conn_safe().ok()?;
    let sql = match item_type {
        "note" => "SELECT resource_id FROM notes WHERE id = ?1",
        "textbook" | "image" | "file" => "SELECT resource_id FROM files WHERE id = ?1",
        "exam" => "SELECT resource_id FROM exam_sheets WHERE id = ?1",
        "translation" => "SELECT resource_id FROM translations WHERE id = ?1",
        "essay" => {
            if item_id.starts_with("essay_session_") {
                // essay_session 没有直接的 resource_id
                return None;
            }
            "SELECT resource_id FROM essays WHERE id = ?1"
        }
        "mindmap" => "SELECT resource_id FROM mindmaps WHERE id = ?1",
        _ => return None,
    };
    conn.query_row(sql, params![item_id], |row| row.get::<_, Option<String>>(0))
        .ok()
        .flatten()
}

/// 异步清理资源的**完整**索引（Lance 向量 + vfs_index_units/segments + 维度计数）
///
/// ★ 2026-06-10 修复（审阅问题 F3）：原实现只删 Lance 向量，
/// 遗留 vfs_index_units/segments 悬挂行并导致 embedding_dim 计数漂移，
/// 且 index_state 停留 'indexed' 使恢复后的资源永远不会被重新索引。
/// 现统一走 `VfsIndexService::delete_resource_index_full`。
///
/// 失败仅记录警告，不阻塞删除流程。
async fn cleanup_vector_index(
    db: &Arc<VfsDatabase>,
    lance_store: &VfsLanceStore,
    resource_id: &str,
) {
    let index_service = crate::vfs::index_service::VfsIndexService::new(Arc::clone(db));
    match index_service
        .delete_resource_index_full(resource_id, lance_store)
        .await
    {
        Ok(result) => {
            info!(
                "[DSTU::trash] Cleaned up full index for resource {} ({} units, {} vectors)",
                resource_id,
                result.deleted_unit_count,
                result.lance_row_ids.len()
            );
        }
        Err(e) => {
            warn!(
                "[DSTU::trash] Failed to clean up full index for {}: {}",
                resource_id, e
            );
        }
    }
}

/// 恢复后将资源标记为待重新索引
///
/// ★ 2026-06-10 修复（审阅问题 F3）：软删除时索引数据已被完整清理，
/// 恢复时必须 mark_pending，否则资源恢复后永久退出语义检索。
fn mark_resource_pending_after_restore(db: &Arc<VfsDatabase>, item_type: &str, item_id: &str) {
    if let Some(resource_id) = lookup_resource_id(db, item_type, item_id) {
        match crate::vfs::repos::VfsIndexStateRepo::mark_pending(db, &resource_id) {
            Ok(()) => {
                info!(
                    "[DSTU::trash] Marked restored resource {} as pending for re-index",
                    resource_id
                );
            }
            Err(e) => {
                warn!(
                    "[DSTU::trash] Failed to mark restored resource {} pending: {}",
                    resource_id, e
                );
            }
        }
    }
}

/// 软删除资源或文件夹
///
/// 根据类型调用对应的软删除函数。
#[tauri::command]
pub async fn dstu_soft_delete(
    id: String,
    item_type: String,
    window: Window,
    db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
) -> Result<(), DstuError> {
    info!(
        "[DSTU::trash] dstu_soft_delete: id={}, type={}",
        id, item_type
    );

    // 统一语义后，所有 delete_xxx 都是软删除
    let result = match item_type.as_str() {
        "folder" => VfsFolderRepo::delete_folder(&db, &id),
        "note" => VfsNoteRepo::delete_note(&db, &id),
        "textbook" => VfsTextbookRepo::delete_textbook(&db, &id),
        "exam" => VfsExamRepo::delete_exam_sheet(&db, &id),
        "translation" => VfsTranslationRepo::delete_translation(&db, &id),
        "essay" => {
            // 只支持 essay_session，禁止旧 essay 轮次的向后兼容
            VfsEssayRepo::delete_session(&db, &id)
        }
        "image" | "file" => VfsFileRepo::delete_file(&db, &id),
        "mindmap" => VfsMindMapRepo::delete_mindmap(&db, &id),
        _ => {
            warn!(
                "[DSTU::trash] Unknown item type for soft delete: {}",
                item_type
            );
            return Err(DstuError::InvalidPath(format!(
                "Unknown item type: {}",
                item_type
            )));
        }
    };

    match result {
        Ok(()) => {
            info!(
                "[DSTU::trash] dstu_soft_delete: SUCCESS - type={}, id={}",
                item_type, id
            );

            // ★ P1 修复：软删除后清理向量索引，防止已删除资源仍可通过 RAG 检索到
            // ★ F3 修复：改用完整清理（向量 + units/segments + index_state 重置）
            if let Some(resource_id) = lookup_resource_id(&db, &item_type, &id) {
                cleanup_vector_index(db.inner(), lance_store.inner(), &resource_id).await;
            }

            // 发射删除事件
            let path = format!("/{}s/{}", item_type, id);
            emit_watch_event(&window, DstuWatchEvent::deleted(&path));
            Ok(())
        }
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_soft_delete: FAILED - type={}, id={}, error={}",
                item_type, id, e
            );
            Err(DstuError::VfsError(e.to_string()))
        }
    }
}

/// 恢复软删除的资源或文件夹
#[tauri::command]
pub async fn dstu_trash_restore(
    id: String,
    item_type: String,
    window: Window,
    db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), DstuError> {
    info!("[DSTU::trash] dstu_restore: id={}, type={}", id, item_type);

    let result = match item_type.as_str() {
        "folder" => VfsFolderRepo::restore_folder(&db, &id),
        "note" => VfsNoteRepo::restore_note(&db, &id),
        "textbook" => VfsTextbookRepo::restore_textbook(&db, &id),
        "exam" => VfsExamRepo::restore_exam(&db, &id),
        "translation" => VfsTranslationRepo::restore_translation(&db, &id),
        "essay" => {
            // 只支持 essay_session，禁止旧 essay 轮次的向后兼容
            VfsEssayRepo::restore_session(&db, &id)
        }
        "image" | "file" => VfsFileRepo::restore_file(&db, &id),
        "mindmap" => VfsMindMapRepo::restore_mindmap(&db, &id).map(|_| ()),
        _ => {
            warn!("[DSTU::trash] Unknown item type for restore: {}", item_type);
            return Err(DstuError::InvalidPath(format!(
                "Unknown item type: {}",
                item_type
            )));
        }
    };

    match result {
        Ok(()) => {
            info!(
                "[DSTU::trash] dstu_trash_restore: SUCCESS - type={}, id={}",
                item_type, id
            );
            // ★ F3 修复：恢复后标记待重索引（软删除时索引已被完整清理）
            mark_resource_pending_after_restore(&db, &item_type, &id);
            // 发射恢复事件
            let path = format!("/_trash/{}", id);
            emit_watch_event(&window, DstuWatchEvent::restored(&path, None));
            Ok(())
        }
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_trash_restore: FAILED - type={}, id={}, error={}",
                item_type, id, e
            );
            Err(DstuError::VfsError(e.to_string()))
        }
    }
}

/// 列出回收站内容
///
/// 从所有资源类型中获取已软删除的项目，按删除时间（updated_at）全局降序排序，
/// 然后应用统一的分页参数（offset + limit）。
#[tauri::command]
pub async fn dstu_list_trash(
    limit: Option<u32>,
    offset: Option<u32>,
    item_types: Option<Vec<String>>,
    db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<DstuNode>, DstuError> {
    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);

    list_trash_with_db(db.inner(), limit, offset, item_types.as_deref())
}

/// Window-independent production core used by the Tauri command and Agent
/// executor. All resource repositories and global pagination semantics remain
/// identical to the desktop path.
pub(crate) fn list_trash_with_db(
    db: &VfsDatabase,
    limit: u32,
    offset: u32,
    item_types: Option<&[String]>,
) -> Result<Vec<DstuNode>, DstuError> {
    info!(
        "[DSTU::trash] dstu_list_trash: limit={}, offset={}, types={:?}",
        limit, offset, item_types
    );
    let type_filter = item_types.map(|types| {
        types
            .iter()
            .map(|value| value.to_ascii_lowercase())
            .collect::<HashSet<_>>()
    });

    let mut nodes: Vec<DstuNode> = Vec::new();

    // 1. 获取已删除的文件夹
    let deleted_folders = if !wants_trash_type(&type_filter, "folder") {
        Vec::new()
    } else {
        match VfsFolderRepo::list_deleted_folders(db, limit + offset, 0) {
            Ok(folders) => folders,
            Err(e) => {
                error!(
                    "[DSTU::trash] dstu_list_trash: list_deleted_folders FAILED - error={}",
                    e
                );
                return Err(DstuError::VfsError(e.to_string()));
            }
        }
    };
    for folder in deleted_folders {
        let mut node = DstuNode::folder(
            folder.id.clone(),
            format!("/_trash/{}", folder.id),
            folder.title,
        );
        node.created_at = folder.created_at;
        node.updated_at = folder.updated_at;
        nodes.push(node);
    }

    // 2. 获取已删除的笔记
    let deleted_notes = if !wants_trash_type(&type_filter, "note") {
        Vec::new()
    } else {
        match VfsNoteRepo::list_deleted_notes(db, limit + offset, 0) {
            Ok(notes) => notes,
            Err(e) => {
                error!(
                    "[DSTU::trash] dstu_list_trash: list_deleted_notes FAILED - error={}",
                    e
                );
                return Err(DstuError::VfsError(e.to_string()));
            }
        }
    };
    for note in deleted_notes {
        let mut node = DstuNode::resource(
            note.id.clone(),
            format!("/_trash/{}", note.id),
            note.title.clone(),
            DstuNodeType::Note,
            note.resource_id.clone(),
        );
        node.created_at = parse_timestamp(&note.created_at);
        node.updated_at = parse_timestamp(&note.updated_at);
        node.metadata = None;
        nodes.push(node);
    }

    // 3. 获取已删除的教材
    let deleted_textbooks = if !wants_trash_type(&type_filter, "textbook") {
        Vec::new()
    } else {
        match VfsTextbookRepo::list_deleted_textbooks(db, limit + offset, 0) {
            Ok(textbooks) => textbooks,
            Err(e) => {
                error!(
                    "[DSTU::trash] dstu_list_trash: list_deleted_textbooks FAILED - error={}",
                    e
                );
                return Err(DstuError::VfsError(e.to_string()));
            }
        }
    };
    for textbook in deleted_textbooks {
        let mut node = DstuNode::resource(
            textbook.id.clone(),
            format!("/_trash/{}", textbook.id),
            textbook.file_name.clone(),
            DstuNodeType::Textbook,
            textbook
                .resource_id
                .clone()
                .unwrap_or_else(|| textbook.id.clone()),
        );
        node.size = Some(textbook.size as u64);
        node.created_at = parse_timestamp(&textbook.created_at);
        node.updated_at = parse_timestamp(&textbook.updated_at);
        node.metadata = None;
        nodes.push(node);
    }

    // 4. 获取已删除的题目集
    let deleted_exams = if !wants_trash_type(&type_filter, "exam") {
        Vec::new()
    } else {
        match VfsExamRepo::list_deleted_exams(db, limit + offset, 0) {
            Ok(exams) => exams,
            Err(e) => {
                error!(
                    "[DSTU::trash] dstu_list_trash: list_deleted_exams FAILED - error={}",
                    e
                );
                return Err(DstuError::VfsError(e.to_string()));
            }
        }
    };
    for exam in deleted_exams {
        let mut node = DstuNode::resource(
            exam.id.clone(),
            format!("/_trash/{}", exam.id),
            exam.exam_name
                .clone()
                .unwrap_or_else(|| "未命名题目集".to_string()),
            DstuNodeType::Exam,
            exam.id.clone(), // exam 没有 resource_id，使用 id
        );
        node.created_at = parse_timestamp(&exam.created_at);
        node.updated_at = parse_timestamp(&exam.updated_at);
        node.metadata = None;
        nodes.push(node);
    }

    // 5. 获取已删除的翻译
    if wants_trash_type(&type_filter, "translation") {
        let deleted_translations =
            match VfsTranslationRepo::list_deleted_translations(db, limit + offset, 0) {
                Ok(translations) => translations,
                Err(e) => {
                    error!(
                    "[DSTU::trash] dstu_list_trash: list_deleted_translations FAILED - error={}",
                    e
                );
                    return Err(DstuError::VfsError(e.to_string()));
                }
            };
        for translation in deleted_translations {
            let mut node = DstuNode::resource(
                translation.id.clone(),
                format!("/_trash/{}", translation.id),
                translation
                    .title
                    .clone()
                    .unwrap_or_else(|| "未命名翻译".to_string()),
                DstuNodeType::Translation,
                translation.resource_id.clone(),
            );
            node.created_at = parse_timestamp(&translation.created_at);
            // updated_at 是 Option<String>，使用 created_at 作为回退
            node.updated_at = translation
                .updated_at
                .as_ref()
                .map(|s| parse_timestamp(s))
                .unwrap_or_else(|| node.created_at);
            node.metadata = None;
            nodes.push(node);
        }
    }

    // 6. 获取已删除的作文会话（Learning Hub 使用 essay_session_* 作为“作文资源”）
    let deleted_sessions = if !wants_trash_type(&type_filter, "essay") {
        Vec::new()
    } else {
        match VfsEssayRepo::list_deleted_sessions(db, limit + offset, 0) {
            Ok(sessions) => sessions,
            Err(e) => {
                error!(
                    "[DSTU::trash] dstu_list_trash: list_deleted_sessions FAILED - error={}",
                    e
                );
                return Err(DstuError::VfsError(e.to_string()));
            }
        }
    };
    for session in deleted_sessions {
        let mut node = DstuNode::resource(
            session.id.clone(),
            format!("/_trash/{}", session.id),
            session.title.clone(),
            DstuNodeType::Essay,
            session.id.clone(),
        );
        node.created_at = parse_timestamp(&session.created_at);
        node.updated_at = parse_timestamp(&session.updated_at);
        node.metadata = None;
        nodes.push(node);
    }

    // 注意：禁止旧 essay 轮次（essay_*）的向后兼容，只支持 essay_session

    let deleted_files = if !wants_trash_type(&type_filter, "file") {
        Vec::new()
    } else {
        match VfsFileRepo::list_deleted_files(db, limit + offset, 0) {
            Ok(files) => files,
            Err(e) => {
                error!(
                    "[DSTU::trash] dstu_list_trash: list_deleted_files FAILED - error={}",
                    e
                );
                return Err(DstuError::VfsError(e.to_string()));
            }
        }
    };
    for file in deleted_files {
        let node_type = if file.file_type == "image" {
            DstuNodeType::Image
        } else {
            DstuNodeType::File
        };
        let mut node = DstuNode::resource(
            file.id.clone(),
            format!("/_trash/{}", file.id),
            file.file_name.clone(),
            node_type,
            file.resource_id.clone().unwrap_or_else(|| file.id.clone()),
        );
        node.size = Some(file.size as u64);
        node.created_at = parse_timestamp(&file.created_at);
        node.updated_at = parse_timestamp(&file.updated_at);
        node.metadata = None;
        nodes.push(node);
    }

    // 7. 获取已删除的知识导图
    let deleted_mindmaps = if !wants_trash_type(&type_filter, "mindmap") {
        Vec::new()
    } else {
        match VfsMindMapRepo::list_deleted_mindmaps(db, limit + offset, 0) {
            Ok(mindmaps) => mindmaps,
            Err(e) => {
                error!(
                    "[DSTU::trash] dstu_list_trash: list_deleted_mindmaps FAILED - error={}",
                    e
                );
                return Err(DstuError::VfsError(e.to_string()));
            }
        }
    };
    for mindmap in deleted_mindmaps {
        let resource_id = if mindmap.resource_id.is_empty() {
            mindmap.id.clone()
        } else {
            mindmap.resource_id.clone()
        };
        let mut node = DstuNode::resource(
            mindmap.id.clone(),
            format!("/_trash/{}", mindmap.id),
            mindmap.title.clone(),
            DstuNodeType::MindMap,
            resource_id,
        );
        node.created_at = parse_timestamp(&mindmap.created_at);
        node.updated_at = parse_timestamp(&mindmap.updated_at);
        node.metadata = None;
        nodes.push(node);
    }

    // 全局按删除时间降序排序（updated_at 在软删除时被更新为删除时间）
    nodes.sort_by_key(|b| std::cmp::Reverse(b.updated_at));

    // 应用全局分页
    let start = offset as usize;
    let nodes: Vec<DstuNode> = if start < nodes.len() {
        nodes[start..]
            .iter()
            .take(limit as usize)
            .cloned()
            .collect()
    } else {
        Vec::new()
    };

    info!(
        "[DSTU::trash] dstu_list_trash: SUCCESS - found {} items",
        nodes.len()
    );
    Ok(nodes)
}

fn wants_trash_type(filter: &Option<HashSet<String>>, type_name: &str) -> bool {
    match filter {
        None => true,
        Some(set) => set.iter().any(|value| {
            value == type_name
                || value == &format!("{type_name}s")
                || (type_name == "file"
                    && matches!(
                        value.as_str(),
                        "image" | "images" | "attachment" | "attachments"
                    ))
                || (type_name == "textbook" && matches!(value.as_str(), "textbooks"))
        }),
    }
}

fn collect_column_strings(conn: &Connection, sql: &str) -> Result<Vec<String>, DstuError> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| DstuError::VfsError(e.to_string()))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| DstuError::VfsError(e.to_string()))?;
    Ok(rows.flatten().collect())
}

fn purge_deleted_rows_by_id<F>(
    conn: &Connection,
    sql: &str,
    mut purge_one: F,
) -> Result<usize, DstuError>
where
    F: FnMut(&str) -> Result<(), String>,
{
    let ids = collect_column_strings(conn, sql)?;
    for id in &ids {
        purge_one(id).map_err(DstuError::VfsError)?;
    }
    Ok(ids.len())
}

fn cleanup_note_asset_dirs(app_data_dir: &Path, note_ids: &[String]) {
    if note_ids.is_empty() {
        return;
    }
    let notes_assets_root = app_data_dir.join("notes_assets");
    if !notes_assets_root.is_dir() {
        return;
    }
    let Ok(base_dir) = notes_assets_root.canonicalize() else {
        return;
    };
    let Ok(subjects) = std::fs::read_dir(&notes_assets_root) else {
        return;
    };
    for subject in subjects.flatten() {
        let subject_path = subject.path();
        if !subject_path.is_dir() {
            continue;
        }
        for note_id in note_ids {
            if note_id.is_empty()
                || note_id.contains('/')
                || note_id.contains('\\')
                || note_id.contains("..")
            {
                continue;
            }
            let dir = subject_path.join(note_id);
            if !dir.is_dir() {
                continue;
            }
            let Ok(canonical) = dir.canonicalize() else {
                continue;
            };
            if !canonical.starts_with(&base_dir) || !canonical.is_dir() {
                continue;
            }
            if let Err(e) = std::fs::remove_dir_all(&canonical) {
                warn!(
                    "[DSTU::trash] Failed to remove note assets dir {}: {}",
                    canonical.display(),
                    e
                );
            }
        }
    }
}

/// 清空回收站
///
/// `item_types` 为空时清空全部类型；笔记工作台传入 note/mindmap/folder，
/// 避免误删学习中心里独立进入回收站的教材/附件。
#[tauri::command]
pub async fn dstu_empty_trash(
    item_types: Option<Vec<String>>,
    window: Window,
    db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
) -> Result<usize, DstuError> {
    info!("[DSTU::trash] dstu_empty_trash types={:?}", item_types);
    let type_filter = item_types.map(|types| {
        types
            .into_iter()
            .map(|value| value.to_ascii_lowercase())
            .collect::<HashSet<_>>()
    });

    let conn = db
        .get_conn_safe()
        .map_err(|e| DstuError::VfsError(e.to_string()))?;
    let blobs_dir = db.blobs_dir().to_path_buf();
    let app_data_dir = db.app_data_dir();

    let resource_ids_to_cleanup = {
        let mut ids = Vec::new();
        for sql in [
            "SELECT resource_id FROM notes WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
            "SELECT resource_id FROM files WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
            "SELECT resource_id FROM exam_sheets WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
            "SELECT resource_id FROM translations WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
            "SELECT resource_id FROM mindmaps WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
            "SELECT e.resource_id FROM essays e INNER JOIN essay_sessions s ON e.session_id = s.id WHERE s.deleted_at IS NOT NULL AND e.resource_id IS NOT NULL",
        ] {
            ids.extend(collect_column_strings(&conn, sql).unwrap_or_default());
        }
        ids
    };
    let note_ids_to_cleanup =
        collect_column_strings(&conn, "SELECT id FROM notes WHERE deleted_at IS NOT NULL")
            .unwrap_or_default();

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| DstuError::VfsError(e.to_string()))?;

    let purge_result = (|| -> Result<usize, DstuError> {
        let mut total_deleted = 0;
        if wants_trash_type(&type_filter, "folder") {
            total_deleted += VfsFolderRepo::purge_deleted_folders_with_conn(&conn, &blobs_dir)
                .map_err(|e| DstuError::VfsError(e.to_string()))?;
        }
        if wants_trash_type(&type_filter, "note") {
            total_deleted += VfsNoteRepo::purge_deleted_notes_with_conn(&conn)
                .map_err(|e| DstuError::VfsError(e.to_string()))?;
        }
        if wants_trash_type(&type_filter, "exam") {
            total_deleted += purge_deleted_rows_by_id(
                &conn,
                "SELECT id FROM exam_sheets WHERE deleted_at IS NOT NULL",
                |id| {
                    VfsExamRepo::purge_exam_sheet_with_conn(&conn, &blobs_dir, id)
                        .map_err(|e| e.to_string())
                },
            )?;
        }
        if wants_trash_type(&type_filter, "translation") {
            total_deleted += purge_deleted_rows_by_id(
                &conn,
                "SELECT id FROM translations WHERE deleted_at IS NOT NULL",
                |id| {
                    VfsTranslationRepo::purge_translation_with_conn(&conn, id)
                        .map_err(|e| e.to_string())
                },
            )?;
        }
        if wants_trash_type(&type_filter, "essay") {
            total_deleted += purge_deleted_rows_by_id(
                &conn,
                "SELECT id FROM essay_sessions WHERE deleted_at IS NOT NULL",
                |id| {
                    VfsEssayRepo::purge_session_with_conn(&conn, id)
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                },
            )?;
        }
        if wants_trash_type(&type_filter, "textbook") {
            total_deleted += VfsTextbookRepo::purge_deleted_textbooks_with_conn(&conn, &blobs_dir)
                .map_err(|e| DstuError::VfsError(e.to_string()))?;
        }
        if wants_trash_type(&type_filter, "file") {
            total_deleted += VfsFileRepo::purge_deleted_files_with_conn(&conn, &blobs_dir)
                .map_err(|e| DstuError::VfsError(e.to_string()))?;
        }
        if wants_trash_type(&type_filter, "mindmap") {
            total_deleted += VfsMindMapRepo::purge_deleted_mindmaps_with_conn(&conn)
                .map_err(|e| DstuError::VfsError(e.to_string()))?;
        }
        Ok(total_deleted)
    })();

    let total_deleted = match purge_result {
        Ok(count) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| DstuError::VfsError(e.to_string()))?;
            count
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    };

    if let Err(e) =
        crate::vfs::repos::VfsBlobRepo::cleanup_unreferenced_with_conn(&conn, &blobs_dir)
    {
        warn!(
            "[DSTU::trash] dstu_empty_trash: post-purge blob sweep failed: {}",
            e
        );
    }
    cleanup_note_asset_dirs(&app_data_dir, &note_ids_to_cleanup);

    info!(
        "[DSTU::trash] dstu_empty_trash: SUCCESS - deleted {} items",
        total_deleted
    );

    if total_deleted > 0 {
        emit_watch_event(&window, DstuWatchEvent::purged("/_trash"));
    }

    if !resource_ids_to_cleanup.is_empty() {
        let lance_for_cleanup = Arc::clone(lance_store.inner());
        let db_for_cleanup = Arc::clone(db.inner());
        crate::background_tasks::BACKGROUND_TASKS.spawn(async move {
            let index_service =
                crate::vfs::index_service::VfsIndexService::new(Arc::clone(&db_for_cleanup));
            for rid in &resource_ids_to_cleanup {
                if let Err(e) = index_service
                    .delete_resource_index_full(rid, &lance_for_cleanup)
                    .await
                {
                    warn!(
                        "[DSTU::trash] dstu_empty_trash: index cleanup failed for {}: {}",
                        rid, e
                    );
                }
            }
            info!(
                "[DSTU::trash] dstu_empty_trash: cleaned up index for {} resources",
                resource_ids_to_cleanup.len()
            );
        });
    }

    Ok(total_deleted)
}

/// 永久删除单个资源
#[tauri::command]
pub async fn dstu_permanently_delete(
    id: String,
    item_type: String,
    window: Window,
    db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
) -> Result<(), DstuError> {
    info!(
        "[DSTU::trash] dstu_permanently_delete: id={}, type={}",
        id, item_type
    );

    // ★ P1 修复：在 purge 之前查找 resource_id（purge 会删除数据库记录）
    // ★ P1 修复：essay_session 需要收集子 essays 的 resource_ids
    let resource_id = lookup_resource_id(&db, &item_type, &id);
    let session_essay_resource_ids: Vec<String> =
        if item_type == "essay" && id.starts_with("essay_session_") {
            if let Ok(conn) = db.get_conn_safe() {
                conn.prepare(
                "SELECT resource_id FROM essays WHERE session_id = ?1 AND resource_id IS NOT NULL",
            )
            .and_then(|mut stmt| {
                stmt.query_map(params![&id], |row| row.get::<_, String>(0))
                    .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
    let note_ids_to_cleanup: Vec<String> = if item_type == "note" || item_type == "notes" {
        vec![id.clone()]
    } else if item_type == "folder" || item_type == "folders" {
        if let Ok(conn) = db.get_conn_safe() {
            conn.prepare(
                r#"
                WITH RECURSIVE folder_tree AS (
                    SELECT id FROM folders WHERE id = ?1
                    UNION ALL
                    SELECT f.id FROM folders f
                    JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT fi.item_id
                FROM folder_items fi
                WHERE fi.item_type = 'note'
                  AND fi.folder_id IN (SELECT id FROM folder_tree)
                "#,
            )
            .and_then(|mut stmt| {
                stmt.query_map(params![&id], |row| row.get::<_, String>(0))
                    .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    // The trash predicate and destructive statements share one writer transaction. This
    // prevents a concurrent restore from turning a stale preflight check into a hard delete.
    let result = purge_resource_by_type_if_trashed(db.inner(), &item_type, &id);

    match result {
        Ok(()) => {
            info!(
                "[DSTU::trash] dstu_permanently_delete: SUCCESS - type={}, id={}",
                item_type, id
            );
            cleanup_note_asset_dirs(&db.app_data_dir(), &note_ids_to_cleanup);

            // ★ P1 修复：永久删除后清理向量索引（如果软删除时未清理）
            // ★ F3 修复：vfs_index_units 对 resources 无外键，purge 后必须显式清理 units/segments
            if let Some(ref rid) = resource_id {
                cleanup_vector_index(db.inner(), lance_store.inner(), rid).await;
            }

            // ★ P1 修复：essay_session 的子 essays 索引清理
            if !session_essay_resource_ids.is_empty() {
                let lance_for_cleanup = Arc::clone(lance_store.inner());
                let db_for_cleanup = Arc::clone(db.inner());
                crate::background_tasks::BACKGROUND_TASKS.spawn(async move {
                    let index_service = crate::vfs::index_service::VfsIndexService::new(
                        Arc::clone(&db_for_cleanup),
                    );
                    for rid in &session_essay_resource_ids {
                        if let Err(e) = index_service
                            .delete_resource_index_full(rid, &lance_for_cleanup)
                            .await
                        {
                            log::warn!(
                                "[DSTU::trash] dstu_permanently_delete: child essay index cleanup failed for {}: {}",
                                rid, e
                            );
                        }
                    }
                    log::info!(
                        "[DSTU::trash] dstu_permanently_delete: cleaned up index for {} child essays",
                        session_essay_resource_ids.len()
                    );
                });
            }

            // 发射永久删除事件
            let path = format!("/_trash/{}", id);
            emit_watch_event(&window, DstuWatchEvent::purged(&path));
            Ok(())
        }
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_permanently_delete: FAILED - type={}, id={}, error={}",
                item_type, id, e
            );
            Err(DstuError::VfsError(e))
        }
    }
}
