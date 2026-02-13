//! 删除操作辅助函数
//!
//! 包含软删除、恢复、清除等操作的辅助函数

use std::sync::Arc;

use rusqlite::Connection;

use crate::dstu::error::DstuError;
use crate::vfs::{
    repos::VfsMindMapRepo, VfsDatabase, VfsEssayRepo, VfsExamRepo, VfsFileRepo, VfsFolderRepo,
    VfsNoteRepo, VfsTextbookRepo, VfsTranslationRepo,
};

/// 根据资源类型执行软删除
pub fn delete_resource_by_type(
    vfs_db: &Arc<VfsDatabase>,
    resource_type: &str,
    id: &str,
) -> Result<(), String> {
    match resource_type {
        "notes" | "note" => {
            VfsNoteRepo::delete_note_with_folder_item(vfs_db, id).map_err(|e| e.to_string())?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=note, id={}",
                id
            );
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::delete_textbook_with_folder_item(vfs_db, id)
                .map_err(|e| e.to_string())?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=textbook, id={}",
                id
            );
        }
        "translations" | "translation" => {
            VfsTranslationRepo::delete_translation_with_folder_item(vfs_db, id)
                .map_err(|e| e.to_string())?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=translation, id={}",
                id
            );
        }
        "exams" | "exam" => {
            VfsExamRepo::delete_exam_sheet_with_folder_item(vfs_db, id)
                .map_err(|e| e.to_string())?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=exam, id={}",
                id
            );
        }
        "essays" | "essay" => {
            if id.starts_with("essay_session_") {
                VfsEssayRepo::delete_session_with_folder_item(vfs_db, id)
                    .map_err(|e| e.to_string())?;
                log::info!("[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=essay_session, id={}", id);
            } else {
                VfsEssayRepo::delete_essay_with_folder_item(vfs_db, id)
                    .map_err(|e| e.to_string())?;
                log::info!(
                    "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=essay, id={}",
                    id
                );
            }
        }
        "folders" | "folder" => {
            VfsFolderRepo::delete_folder(vfs_db, id).map_err(|e| e.to_string())?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=folder, id={}",
                id
            );
        }
        "images" | "files" | "attachments" | "image" | "file" | "attachment" => {
            // P0-FIX: 使用软删除而非硬删除，支持回收站恢复
            VfsFileRepo::delete_file(vfs_db, id).map_err(|e| e.to_string())?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=file, id={}",
                id
            );
        }
        "mindmaps" | "mindmap" => {
            VfsMindMapRepo::delete_mindmap(vfs_db, id).map_err(|e| e.to_string())?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=mindmap, id={}",
                id
            );
        }
        _ => {
            return Err(DstuError::invalid_node_type(resource_type).to_string());
        }
    }
    Ok(())
}

/// 根据资源类型执行软删除（使用现有连接，支持外部事务）
///
/// ★ CONC-08 修复：供批量删除使用，支持在事务中调用
pub fn delete_resource_by_type_with_conn(
    conn: &Connection,
    resource_type: &str,
    id: &str,
) -> Result<(), String> {
    match resource_type {
        "notes" | "note" => {
            VfsNoteRepo::delete_note_with_folder_item_with_conn(conn, id)
                .map_err(|e| e.to_string())?;
            log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=note, id={}", id);
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::delete_textbook_with_folder_item_with_conn(conn, id)
                .map_err(|e| e.to_string())?;
            log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=textbook, id={}", id);
        }
        "translations" | "translation" => {
            VfsTranslationRepo::delete_translation_with_folder_item_with_conn(conn, id)
                .map_err(|e| e.to_string())?;
            log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=translation, id={}", id);
        }
        "exams" | "exam" => {
            VfsExamRepo::delete_exam_sheet_with_folder_item_with_conn(conn, id)
                .map_err(|e| e.to_string())?;
            log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=exam, id={}", id);
        }
        "essays" | "essay" => {
            if id.starts_with("essay_session_") {
                VfsEssayRepo::delete_session_with_folder_item_with_conn(conn, id)
                    .map_err(|e| e.to_string())?;
                log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=essay_session, id={}", id);
            } else {
                VfsEssayRepo::delete_essay_with_folder_item_with_conn(conn, id)
                    .map_err(|e| e.to_string())?;
                log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=essay, id={}", id);
            }
        }
        "folders" | "folder" => {
            VfsFolderRepo::delete_folder_with_conn(conn, id).map_err(|e| e.to_string())?;
            log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=folder, id={}", id);
        }
        "images" | "files" | "attachments" | "image" | "file" | "attachment" => {
            // P0-FIX: 使用软删除而非硬删除，支持回收站恢复
            VfsFileRepo::delete_file_with_conn(conn, id).map_err(|e| e.to_string())?;
            log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=file, id={}", id);
        }
        "mindmaps" | "mindmap" => {
            VfsMindMapRepo::delete_mindmap_with_conn(conn, id).map_err(|e| e.to_string())?;
            log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=mindmap, id={}", id);
        }
        _ => {
            return Err(DstuError::invalid_node_type(resource_type).to_string());
        }
    }
    Ok(())
}

/// 根据资源类型执行永久删除
pub fn purge_resource_by_type(
    vfs_db: &Arc<VfsDatabase>,
    resource_type: &str,
    id: &str,
) -> Result<(), String> {
    match resource_type {
        "notes" | "note" => {
            VfsNoteRepo::purge_note(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::purge_textbook(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "translations" | "translation" => {
            VfsTranslationRepo::purge_translation(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "exams" | "exam" => {
            VfsExamRepo::purge_exam_sheet(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "essays" | "essay" => {
            if id.starts_with("essay_session_") {
                // 会话没有软删除依赖，直接永久删除（同时删除其所有轮次）
                let _ = VfsEssayRepo::purge_session(vfs_db, id).map_err(|e| e.to_string())?;
                // 兜底清理 folder_items（如果存在）
                let _ = VfsFolderRepo::remove_item_by_item_id(vfs_db, "essay", id);
            } else {
                VfsEssayRepo::purge_essay(vfs_db, id).map_err(|e| e.to_string())?;
            }
        }
        "folders" | "folder" => {
            VfsFolderRepo::purge_folder(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "images" | "files" | "attachments" | "image" | "file" | "attachment" => {
            VfsFileRepo::purge_file(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "mindmaps" | "mindmap" => {
            VfsMindMapRepo::purge_mindmap(vfs_db, id).map_err(|e| e.to_string())?;
        }
        _ => {
            return Err(DstuError::invalid_node_type(resource_type).to_string());
        }
    }
    log::info!(
        "[DSTU::delete_helpers] purge_resource_by_type: SUCCESS - type={}, id={}",
        resource_type,
        id
    );
    Ok(())
}

/// 根据资源类型执行恢复
pub fn restore_resource_by_type(
    vfs_db: &Arc<VfsDatabase>,
    resource_type: &str,
    id: &str,
) -> Result<(), String> {
    match resource_type {
        "notes" | "note" => {
            VfsNoteRepo::restore_note(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::restore_textbook(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "translations" | "translation" => {
            VfsTranslationRepo::restore_translation(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "exams" | "exam" => {
            VfsExamRepo::restore_exam(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "essays" | "essay" => {
            if id.starts_with("essay_session_") {
                VfsEssayRepo::restore_session(vfs_db, id).map_err(|e| e.to_string())?;
            } else {
                VfsEssayRepo::restore_essay(vfs_db, id).map_err(|e| e.to_string())?;
            }
        }
        "folders" | "folder" => {
            VfsFolderRepo::restore_folder(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "images" | "files" | "attachments" | "image" | "file" | "attachment" => {
            // P0-FIX: 支持从回收站恢复文件
            VfsFileRepo::restore_file(vfs_db, id).map_err(|e| e.to_string())?;
        }
        "mindmaps" | "mindmap" => {
            VfsMindMapRepo::restore_mindmap(vfs_db, id).map_err(|e| e.to_string())?;
        }
        _ => {
            return Err(DstuError::invalid_node_type(resource_type).to_string());
        }
    }
    log::info!(
        "[DSTU::delete_helpers] restore_resource_by_type: SUCCESS - type={}, id={}",
        resource_type,
        id
    );
    Ok(())
}

/// 根据资源类型执行恢复（使用现有连接，用于事务批量操作）
///
/// ★ CONC-09 修复：支持在事务中批量恢复资源
pub fn restore_resource_by_type_with_conn(
    conn: &Connection,
    resource_type: &str,
    id: &str,
) -> Result<(), String> {
    match resource_type {
        "notes" | "note" => {
            VfsNoteRepo::restore_note_with_conn(conn, id).map_err(|e| e.to_string())?;
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::restore_textbook_with_conn(conn, id).map_err(|e| e.to_string())?;
        }
        "translations" | "translation" => {
            VfsTranslationRepo::restore_translation_with_conn(conn, id)
                .map_err(|e| e.to_string())?;
        }
        "exams" | "exam" => {
            VfsExamRepo::restore_exam_with_conn(conn, id).map_err(|e| e.to_string())?;
        }
        "essays" | "essay" => {
            if id.starts_with("essay_session_") {
                VfsEssayRepo::restore_session_with_conn(conn, id).map_err(|e| e.to_string())?;
            } else {
                VfsEssayRepo::restore_essay_with_conn(conn, id).map_err(|e| e.to_string())?;
            }
        }
        "folders" | "folder" => {
            VfsFolderRepo::restore_folder_with_conn(conn, id).map_err(|e| e.to_string())?;
        }
        "images" | "files" | "attachments" | "image" | "file" | "attachment" => {
            VfsFileRepo::restore_file_with_conn(conn, id).map_err(|e| e.to_string())?;
        }
        "mindmaps" | "mindmap" => {
            let _ =
                VfsMindMapRepo::restore_mindmap_with_conn(conn, id).map_err(|e| e.to_string())?;
        }
        _ => {
            return Err(DstuError::invalid_node_type(resource_type).to_string());
        }
    }
    log::info!(
        "[DSTU::delete_helpers] restore_resource_by_type_with_conn: SUCCESS - type={}, id={}",
        resource_type,
        id
    );
    Ok(())
}
