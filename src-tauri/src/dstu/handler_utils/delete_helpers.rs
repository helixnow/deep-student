//! 删除操作辅助函数
//!
//! 包含软删除、恢复、清除等操作的辅助函数

use std::sync::Arc;

use rusqlite::{params, Connection};

use crate::dstu::error::DstuError;
use crate::vfs::{
    repos::VfsMindMapRepo, VfsDatabase, VfsEssayRepo, VfsExamRepo, VfsFileRepo, VfsFolderRepo,
    VfsBlobRepo, VfsNoteRepo, VfsTextbookRepo, VfsTranslationRepo,
};

fn helper_error(action: &str, resource_type: &str, id: &str, error: impl ToString) -> String {
    DstuError::vfs_error(format!(
        "{} failed (type={}, id={}): {}",
        action,
        resource_type,
        id,
        error.to_string()
    ))
    .to_string()
}

fn invalid_type_error(resource_type: &str, id: &str) -> String {
    DstuError::invalid_node_type(format!("{} (id={})", resource_type, id)).to_string()
}

/// 根据资源类型执行软删除
pub fn delete_resource_by_type(
    vfs_db: &Arc<VfsDatabase>,
    resource_type: &str,
    id: &str,
) -> Result<(), String> {
    match resource_type {
        "notes" | "note" => {
            VfsNoteRepo::delete_note_with_folder_item(vfs_db, id)
                .map_err(|e| helper_error("delete", resource_type, id, e))?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=note, id={}",
                id
            );
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::delete_textbook_with_folder_item(vfs_db, id)
                .map_err(|e| helper_error("delete", resource_type, id, e))?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=textbook, id={}",
                id
            );
        }
        "translations" | "translation" => {
            VfsTranslationRepo::delete_translation_with_folder_item(vfs_db, id)
                .map_err(|e| helper_error("delete", resource_type, id, e))?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=translation, id={}",
                id
            );
        }
        "exams" | "exam" => {
            VfsExamRepo::delete_exam_sheet_with_folder_item(vfs_db, id)
                .map_err(|e| helper_error("delete", resource_type, id, e))?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=exam, id={}",
                id
            );
        }
        "essays" | "essay" => {
            if id.starts_with("essay_session_") {
                VfsEssayRepo::delete_session_with_folder_item(vfs_db, id)
                    .map_err(|e| helper_error("delete", resource_type, id, e))?;
                log::info!("[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=essay_session, id={}", id);
            } else {
                VfsEssayRepo::delete_essay_with_folder_item(vfs_db, id)
                    .map_err(|e| helper_error("delete", resource_type, id, e))?;
                log::info!(
                    "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=essay, id={}",
                    id
                );
            }
        }
        "folders" | "folder" => {
            VfsFolderRepo::delete_folder(vfs_db, id)
                .map_err(|e| helper_error("delete", resource_type, id, e))?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=folder, id={}",
                id
            );
        }
        "images" | "files" | "attachments" | "image" | "file" | "attachment" => {
            // P0-FIX: 使用软删除而非硬删除，支持回收站恢复
            VfsFileRepo::delete_file(vfs_db, id)
                .map_err(|e| helper_error("delete", resource_type, id, e))?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=file, id={}",
                id
            );
        }
        "mindmaps" | "mindmap" => {
            VfsMindMapRepo::delete_mindmap(vfs_db, id)
                .map_err(|e| helper_error("delete", resource_type, id, e))?;
            log::info!(
                "[DSTU::delete_helpers] delete_resource_by_type: SUCCESS - type=mindmap, id={}",
                id
            );
        }
        _ => {
            return Err(invalid_type_error(resource_type, id));
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
                .map_err(|e| helper_error("delete_with_conn", resource_type, id, e))?;
            log::info!("[DSTU::delete_helpers] delete_resource_by_type_with_conn: SUCCESS - type=note, id={}", id);
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::delete_textbook_with_folder_item_with_conn(conn, id)
                .map_err(|e| helper_error("delete_with_conn", resource_type, id, e))?;
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
            return Err(invalid_type_error(resource_type, id));
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
            VfsNoteRepo::purge_note(vfs_db, id)
                .map_err(|e| helper_error("purge", resource_type, id, e))?;
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::purge_textbook(vfs_db, id)
                .map_err(|e| helper_error("purge", resource_type, id, e))?;
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
                let _ = VfsEssayRepo::purge_session(vfs_db, id)
                    .map_err(|e| helper_error("purge", resource_type, id, e))?;
                // 兜底清理 folder_items（如果存在）
                let _ = VfsFolderRepo::remove_item_by_item_id(vfs_db, "essay", id);
            } else {
                VfsEssayRepo::purge_essay(vfs_db, id)
                    .map_err(|e| helper_error("purge", resource_type, id, e))?;
            }
        }
        "folders" | "folder" => {
            VfsFolderRepo::purge_folder(vfs_db, id)
                .map_err(|e| helper_error("purge", resource_type, id, e))?;
        }
        "images" | "files" | "attachments" | "image" | "file" | "attachment" => {
            VfsFileRepo::purge_file(vfs_db, id)
                .map_err(|e| helper_error("purge", resource_type, id, e))?;
        }
        "mindmaps" | "mindmap" => {
            VfsMindMapRepo::purge_mindmap(vfs_db, id)
                .map_err(|e| helper_error("purge", resource_type, id, e))?;
        }
        _ => {
            return Err(invalid_type_error(resource_type, id));
        }
    }
    log::info!(
        "[DSTU::delete_helpers] purge_resource_by_type: SUCCESS - type={}, id={}",
        resource_type,
        id
    );
    Ok(())
}

/// Atomically verify that a resource is still in the trash, then permanently delete it.
///
/// The former DSTU purge flow performed this check on a separate connection before
/// calling a repository purge method. A concurrent restore could therefore land in
/// between the check and the delete. `BEGIN IMMEDIATE` holds SQLite's writer lock
/// across both operations, and the repository `*_with_conn` methods keep every
/// destructive statement on that same connection.
pub fn purge_resource_by_type_if_trashed(
    vfs_db: &Arc<VfsDatabase>,
    resource_type: &str,
    id: &str,
) -> Result<(), String> {
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| helper_error("purge", resource_type, id, e))?;

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| helper_error("purge", resource_type, id, e))?;

    let result = (|| -> Result<(), String> {
        let trash_sql = match resource_type {
            "notes" | "note" => "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
            "textbooks" | "textbook" | "images" | "image" | "files" | "file"
            | "attachments" | "attachment" => {
                "SELECT 1 FROM files WHERE id = ?1 AND deleted_at IS NOT NULL"
            }
            "exams" | "exam" => {
                "SELECT 1 FROM exam_sheets WHERE id = ?1 AND deleted_at IS NOT NULL"
            }
            "translations" | "translation" => {
                "SELECT 1 FROM translations WHERE id = ?1 AND deleted_at IS NOT NULL"
            }
            "essays" | "essay" if id.starts_with("essay_session_") => {
                "SELECT 1 FROM essay_sessions WHERE id = ?1 AND deleted_at IS NOT NULL"
            }
            "essays" | "essay" => "SELECT 1 FROM essays WHERE id = ?1 AND deleted_at IS NOT NULL",
            "folders" | "folder" => {
                "SELECT 1 FROM folders WHERE id = ?1 AND deleted_at IS NOT NULL"
            }
            "mindmaps" | "mindmap" => {
                "SELECT 1 FROM mindmaps WHERE id = ?1 AND deleted_at IS NOT NULL"
            }
            _ => return Err(invalid_type_error(resource_type, id)),
        };

        let is_trashed = conn
            .query_row(trash_sql, params![id], |_| Ok(()))
            .is_ok();
        if !is_trashed {
            return Err(format!(
                "资源 {} (type={}) 不在回收站中，无法永久删除。请先将其移到回收站。",
                id, resource_type
            ));
        }

        match resource_type {
            "notes" | "note" => VfsNoteRepo::purge_note_with_conn(&conn, id),
            "textbooks" | "textbook" => {
                VfsTextbookRepo::purge_textbook_with_conn(&conn, vfs_db.blobs_dir(), id)
            }
            "translations" | "translation" => VfsTranslationRepo::purge_translation_with_conn(&conn, id),
            "exams" | "exam" => {
                VfsExamRepo::purge_exam_sheet_with_conn(&conn, vfs_db.blobs_dir(), id)
            }
            "essays" | "essay" if id.starts_with("essay_session_") => {
                VfsEssayRepo::purge_session_with_conn(&conn, id).map(|_| ())
            }
            "essays" | "essay" => VfsEssayRepo::purge_essay_with_conn(&conn, id),
            "folders" | "folder" => VfsFolderRepo::purge_folder_with_conn(&conn, vfs_db.blobs_dir(), id),
            "images" | "files" | "attachments" | "image" | "file" | "attachment" => {
                VfsFileRepo::purge_file_with_conn(&conn, vfs_db.blobs_dir(), id)
            }
            "mindmaps" | "mindmap" => VfsMindMapRepo::purge_mindmap_with_conn(&conn, id),
            _ => unreachable!("resource type was validated above"),
        }
        .map_err(|e| helper_error("purge", resource_type, id, e))?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| helper_error("purge", resource_type, id, e))?;

            // The repository entry points normally perform this post-commit
            // sweep themselves. This path deliberately calls their
            // connection-scoped variants to retain the atomic trash check, so
            // preserve the same two-stage blob cleanup behavior here.
            if matches!(
                resource_type,
                "textbooks"
                    | "textbook"
                    | "exams"
                    | "exam"
                    | "folders"
                    | "folder"
                    | "images"
                    | "image"
                    | "files"
                    | "file"
                    | "attachments"
                    | "attachment"
            ) {
                if let Err(e) = VfsBlobRepo::cleanup_unreferenced_with_conn(&conn, vfs_db.blobs_dir()) {
                    log::warn!(
                        "[DSTU::delete_helpers] Post-purge blob sweep failed (will retry later): {}",
                        e
                    );
                }
            }
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// 根据资源类型执行恢复
pub fn restore_resource_by_type(
    vfs_db: &Arc<VfsDatabase>,
    resource_type: &str,
    id: &str,
) -> Result<(), String> {
    match resource_type {
        "notes" | "note" => {
            VfsNoteRepo::restore_note(vfs_db, id)
                .map_err(|e| helper_error("restore", resource_type, id, e))?;
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::restore_textbook(vfs_db, id)
                .map_err(|e| helper_error("restore", resource_type, id, e))?;
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
            return Err(invalid_type_error(resource_type, id));
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
            VfsNoteRepo::restore_note_with_conn(conn, id)
                .map_err(|e| helper_error("restore_with_conn", resource_type, id, e))?;
        }
        "textbooks" | "textbook" => {
            VfsTextbookRepo::restore_textbook_with_conn(conn, id)
                .map_err(|e| helper_error("restore_with_conn", resource_type, id, e))?;
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
            return Err(invalid_type_error(resource_type, id));
        }
    }
    log::info!(
        "[DSTU::delete_helpers] restore_resource_by_type_with_conn: SUCCESS - type={}, id={}",
        resource_type,
        id
    );
    Ok(())
}
