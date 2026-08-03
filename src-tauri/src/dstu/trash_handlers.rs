//! DSTU 回收站命令处理器
//!
//! 提供统一的软删除、恢复、列表和永久删除命令。

use rusqlite::params;
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
    db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<DstuNode>, DstuError> {
    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);

    list_trash_with_db(db.inner(), limit, offset)
}

/// Window-independent production core used by the Tauri command and Agent
/// executor. All resource repositories and global pagination semantics remain
/// identical to the desktop path.
pub(crate) fn list_trash_with_db(
    db: &VfsDatabase,
    limit: u32,
    offset: u32,
) -> Result<Vec<DstuNode>, DstuError> {
    info!(
        "[DSTU::trash] dstu_list_trash: limit={}, offset={}",
        limit, offset
    );

    let mut nodes: Vec<DstuNode> = Vec::new();

    // 1. 获取已删除的文件夹
    let deleted_folders = match VfsFolderRepo::list_deleted_folders(db, limit + offset, 0) {
        Ok(folders) => folders,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_list_trash: list_deleted_folders FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
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
    let deleted_notes = match VfsNoteRepo::list_deleted_notes(db, limit + offset, 0) {
        Ok(notes) => notes,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_list_trash: list_deleted_notes FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
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
    let deleted_textbooks = match VfsTextbookRepo::list_deleted_textbooks(db, limit + offset, 0) {
        Ok(textbooks) => textbooks,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_list_trash: list_deleted_textbooks FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
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
    let deleted_exams = match VfsExamRepo::list_deleted_exams(db, limit + offset, 0) {
        Ok(exams) => exams,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_list_trash: list_deleted_exams FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
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
    {
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
    let deleted_sessions = match VfsEssayRepo::list_deleted_sessions(db, limit + offset, 0) {
        Ok(sessions) => sessions,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_list_trash: list_deleted_sessions FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
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

    let deleted_files = match VfsFileRepo::list_deleted_files(db, limit + offset, 0) {
        Ok(files) => files,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_list_trash: list_deleted_files FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
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
    let deleted_mindmaps = match VfsMindMapRepo::list_deleted_mindmaps(db, limit + offset, 0) {
        Ok(mindmaps) => mindmaps,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_list_trash: list_deleted_mindmaps FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
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

/// 清空回收站
///
///
/// 永久删除所有已软删除的资源。
#[tauri::command]
pub async fn dstu_empty_trash(
    window: Window,
    db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
) -> Result<usize, DstuError> {
    info!("[DSTU::trash] dstu_empty_trash");

    // ★ P1 修复：在 purge 之前收集所有待清理的 resource_ids
    let resource_ids_to_cleanup: Vec<String> = {
        if let Ok(conn) = db.get_conn_safe() {
            let mut ids = Vec::new();
            // 收集已删除的 notes, files, exam_sheets, translations, mindmaps, essays 的 resource_id
            // ★ P1 修复：补充 essays 表（包括已删除的独立 essay 和被删除 session 下的子 essay）
            for sql in &[
                "SELECT resource_id FROM notes WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
                "SELECT resource_id FROM files WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
                "SELECT resource_id FROM exam_sheets WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
                "SELECT resource_id FROM translations WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
                "SELECT resource_id FROM mindmaps WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL",
                // 被删除 session 下的子 essay 的 resource_id
                "SELECT e.resource_id FROM essays e INNER JOIN essay_sessions s ON e.session_id = s.id WHERE s.deleted_at IS NOT NULL AND e.resource_id IS NOT NULL",
            ] {
                if let Ok(mut stmt) = conn.prepare(sql) {
                    if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                        for rid in rows.flatten() {
                            ids.push(rid);
                        }
                    }
                }
            }
            ids
        } else {
            Vec::new()
        }
    };

    let mut total_deleted = 0;

    // 永久删除各类资源
    match VfsFolderRepo::purge_deleted_folders(&db) {
        Ok(count) => total_deleted += count,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_empty_trash: purge_deleted_folders FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    }

    match VfsNoteRepo::purge_deleted_notes(&db) {
        Ok(count) => total_deleted += count,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_empty_trash: purge_deleted_notes FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    }

    // 题目集：逐个永久删除已软删除的记录
    let deleted_exams = match VfsExamRepo::list_deleted_exams(&db, 1000, 0) {
        Ok(exams) => exams,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_empty_trash: list_deleted_exams FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    };
    for exam in &deleted_exams {
        if let Err(e) = VfsExamRepo::purge_exam_sheet(&db, &exam.id) {
            error!(
                "[DSTU::trash] dstu_empty_trash: purge_exam_sheet FAILED - id={}, error={}",
                exam.id, e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    }
    total_deleted += deleted_exams.len();

    // 翻译：逐个永久删除
    let deleted_translations = match VfsTranslationRepo::list_deleted_translations(&db, 1000, 0) {
        Ok(translations) => translations,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_empty_trash: list_deleted_translations FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    };
    for tr in &deleted_translations {
        if let Err(e) = VfsTranslationRepo::purge_translation(&db, &tr.id) {
            error!(
                "[DSTU::trash] dstu_empty_trash: purge_translation FAILED - id={}, error={}",
                tr.id, e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    }
    total_deleted += deleted_translations.len();

    // 作文会话：逐个永久删除（连带删除轮次）
    let deleted_sessions = match VfsEssayRepo::list_deleted_sessions(&db, 1000, 0) {
        Ok(sessions) => sessions,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_empty_trash: list_deleted_sessions FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    };
    for session in &deleted_sessions {
        if let Err(e) = VfsEssayRepo::purge_session(&db, &session.id) {
            error!(
                "[DSTU::trash] dstu_empty_trash: purge_session FAILED - id={}, error={}",
                session.id, e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    }
    total_deleted += deleted_sessions.len();

    // 注意：禁止旧 essay 轮次（essay_*）的向后兼容，只支持 essay_session

    match VfsFileRepo::purge_deleted_files(&db) {
        Ok(count) => total_deleted += count,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_empty_trash: purge_deleted_files FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    }

    // 知识导图
    match VfsMindMapRepo::purge_deleted_mindmaps(&db) {
        Ok(count) => total_deleted += count,
        Err(e) => {
            error!(
                "[DSTU::trash] dstu_empty_trash: purge_deleted_mindmaps FAILED - error={}",
                e
            );
            return Err(DstuError::VfsError(e.to_string()));
        }
    }

    info!(
        "[DSTU::trash] dstu_empty_trash: SUCCESS - deleted {} items",
        total_deleted
    );

    // 发射批量永久删除事件（通知前端刷新回收站视图）
    if total_deleted > 0 {
        emit_watch_event(&window, DstuWatchEvent::purged("/_trash"));
    }

    // ★ P1 修复：purge 成功后异步清理所有索引数据
    // ★ F3 修复：改用完整清理（向量 + units/segments + 维度计数刷新）
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

    // The trash predicate and destructive statements share one writer transaction. This
    // prevents a concurrent restore from turning a stale preflight check into a hard delete.
    let result = purge_resource_by_type_if_trashed(db.inner(), &item_type, &id);

    match result {
        Ok(()) => {
            info!(
                "[DSTU::trash] dstu_permanently_delete: SUCCESS - type={}, id={}",
                item_type, id
            );

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
