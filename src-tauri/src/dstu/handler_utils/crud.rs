//! CRUD 操作处理器
//!
//! 包含 dstu_list, dstu_get, dstu_create, dstu_update, dstu_delete 等基本操作

use std::sync::Arc;

use crate::dstu::types::DstuNode;
use crate::vfs::{
    repos::VfsMindMapRepo, VfsDatabase, VfsEssayRepo, VfsExamRepo, VfsFileRepo,
    VfsNoteRepo, VfsTextbookRepo, VfsTranslationRepo,
};

use super::{
    essay_to_dstu_node, exam_to_dstu_node,
    file_to_dstu_node, mindmap_to_dstu_node,
    note_to_dstu_node, session_to_dstu_node, textbook_to_dstu_node, translation_to_dstu_node,
};

// ============================================================================
// 辅助函数
// ============================================================================

/// 根据类型和 ID 获取资源
pub async fn get_resource_by_type_and_id(
    vfs_db: &Arc<VfsDatabase>,
    resource_type: &str,
    id: &str,
) -> Result<Option<DstuNode>, String> {
    match resource_type {
        "notes" => {
            match VfsNoteRepo::get_note(vfs_db, id) {
                Ok(note) => {
                    log::info!(
                        "[DSTU::crud] get_resource_by_type_and_id: SUCCESS - type=note, id={}",
                        id
                    );
                    Ok(note.map(|n| note_to_dstu_node(&n)))
                }
                Err(e) => {
                    log::error!("[DSTU::crud] get_resource_by_type_and_id: FAILED - type=note, id={}, error={}", id, e);
                    Err(e.to_string())
                }
            }
        }
        "textbooks" => match VfsTextbookRepo::get_textbook(vfs_db, id) {
            Ok(textbook) => {
                log::info!(
                    "[DSTU::crud] get_resource_by_type_and_id: SUCCESS - type=textbook, id={}",
                    id
                );
                Ok(textbook.map(|t| textbook_to_dstu_node(&t)))
            }
            Err(e) => {
                log::error!("[DSTU::crud] get_resource_by_type_and_id: FAILED - type=textbook, id={}, error={}", id, e);
                Err(e.to_string())
            }
        },
        "translations" => {
            match VfsTranslationRepo::get_translation(vfs_db, id) {
                Ok(translation) => {
                    log::info!("[DSTU::crud] get_resource_by_type_and_id: SUCCESS - type=translation, id={}", id);
                    Ok(translation.map(|t| translation_to_dstu_node(&t)))
                }
                Err(e) => {
                    log::error!("[DSTU::crud] get_resource_by_type_and_id: FAILED - type=translation, id={}, error={}", id, e);
                    Err(e.to_string())
                }
            }
        }
        "exams" => {
            match VfsExamRepo::get_exam_sheet(vfs_db, id) {
                Ok(exam) => {
                    log::info!(
                        "[DSTU::crud] get_resource_by_type_and_id: SUCCESS - type=exam, id={}",
                        id
                    );
                    Ok(exam.map(|e| exam_to_dstu_node(&e)))
                }
                Err(e) => {
                    log::error!("[DSTU::crud] get_resource_by_type_and_id: FAILED - type=exam, id={}, error={}", id, e);
                    Err(e.to_string())
                }
            }
        }
        "essays" => match VfsEssayRepo::get_essay(vfs_db, id) {
            Ok(Some(e)) => {
                log::info!(
                    "[DSTU::crud] get_resource_by_type_and_id: SUCCESS - type=essay, id={}",
                    id
                );
                Ok(Some(essay_to_dstu_node(&e)))
            }
            Ok(None) => match VfsEssayRepo::get_session(vfs_db, id) {
                Ok(session) => {
                    log::info!("[DSTU::crud] get_resource_by_type_and_id: SUCCESS - type=essay_session, id={}", id);
                    Ok(session.map(|s| session_to_dstu_node(&s)))
                }
                Err(e) => {
                    log::error!("[DSTU::crud] get_resource_by_type_and_id: FAILED - type=essay_session, id={}, error={}", id, e);
                    Err(e.to_string())
                }
            },
            Err(e) => {
                log::error!("[DSTU::crud] get_resource_by_type_and_id: FAILED - type=essay, id={}, error={}", id, e);
                Err(e.to_string())
            }
        },
        "files" | "attachments" => {
            match VfsFileRepo::get_file(vfs_db, id) {
                Ok(file) => {
                    log::info!(
                        "[DSTU::crud] get_resource_by_type_and_id: SUCCESS - type=file, id={}",
                        id
                    );
                    Ok(file.map(|f| file_to_dstu_node(&f)))
                }
                Err(e) => {
                    log::error!("[DSTU::crud] get_resource_by_type_and_id: FAILED - type=file, id={}, error={}", id, e);
                    Err(e.to_string())
                }
            }
        }
        "mindmaps" => match VfsMindMapRepo::get_mindmap(vfs_db, id) {
            Ok(mindmap) => {
                log::info!(
                    "[DSTU::crud] get_resource_by_type_and_id: SUCCESS - type=mindmap, id={}",
                    id
                );
                Ok(mindmap.map(|m| mindmap_to_dstu_node(&m)))
            }
            Err(e) => {
                log::error!("[DSTU::crud] get_resource_by_type_and_id: FAILED - type=mindmap, id={}, error={}", id, e);
                Err(e.to_string())
            }
        },
        _ => {
            log::error!(
                "[DSTU::crud] get_resource_by_type_and_id: unsupported type={}",
                resource_type
            );
            Err(format!("Unsupported resource type: {}", resource_type))
        }
    }
}

/// 根据 VfsFolderItem 获取资源详情并转换为 DstuNode
pub async fn fetch_resource_as_dstu_node(
    vfs_db: &Arc<VfsDatabase>,
    item: &crate::vfs::VfsFolderItem,
    _folder_path: &str,
) -> Result<Option<DstuNode>, String> {
    match item.item_type.as_str() {
        "note" => match VfsNoteRepo::get_note(vfs_db, &item.item_id) {
            Ok(Some(note)) => Ok(Some(note_to_dstu_node(&note))),
            Ok(None) => Ok(None),
            Err(e) => Err(e.to_string()),
        },
        "textbook" => match VfsTextbookRepo::get_textbook(vfs_db, &item.item_id) {
            Ok(Some(tb)) => Ok(Some(textbook_to_dstu_node(&tb))),
            Ok(None) => Ok(None),
            Err(e) => Err(e.to_string()),
        },
        "exam" => match VfsExamRepo::get_exam_sheet(vfs_db, &item.item_id) {
            Ok(Some(exam)) => Ok(Some(exam_to_dstu_node(&exam))),
            Ok(None) => Ok(None),
            Err(e) => Err(e.to_string()),
        },
        "translation" => match VfsTranslationRepo::get_translation(vfs_db, &item.item_id) {
            Ok(Some(tr)) => Ok(Some(translation_to_dstu_node(&tr))),
            Ok(None) => Ok(None),
            Err(e) => Err(e.to_string()),
        },
        "essay" => match VfsEssayRepo::get_essay(vfs_db, &item.item_id) {
            Ok(Some(essay)) => Ok(Some(essay_to_dstu_node(&essay))),
            Ok(None) => match VfsEssayRepo::get_session(vfs_db, &item.item_id) {
                Ok(Some(session)) => Ok(Some(session_to_dstu_node(&session))),
                Ok(None) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            Err(e) => Err(e.to_string()),
        },
        "image" | "file" => match VfsFileRepo::get_file(vfs_db, &item.item_id) {
            Ok(Some(f)) => Ok(Some(file_to_dstu_node(&f))),
            Ok(None) => Ok(None),
            Err(e) => Err(e.to_string()),
        },
        "mindmap" => match VfsMindMapRepo::get_mindmap(vfs_db, &item.item_id) {
            Ok(Some(m)) => Ok(Some(mindmap_to_dstu_node(&m))),
            Ok(None) => Ok(None),
            Err(e) => Err(e.to_string()),
        },
        _ => {
            log::warn!("[DSTU::crud] Unknown item type: {}", item.item_type);
            Ok(None)
        }
    }
}

/// 获取资源的文件夹路径
pub async fn get_resource_folder_path(
    vfs_db: &Arc<VfsDatabase>,
    source_id: &str,
) -> Result<String, String> {
    crate::vfs::ref_handlers::get_resource_path_internal(vfs_db, source_id)
        .map_err(|e| e.to_string())
}

/// UUID 格式 ID 回退查找
///
/// 当 infer_resource_type_from_id 将 UUID 推断为 folder 但未找到时，
/// 尝试在其他资源表中查找（兼容从旧数据库迁移的资源）。
///
/// 按以下顺序尝试：textbooks → notes → exams → translations → essays
pub fn fallback_lookup_uuid_resource(vfs_db: &Arc<VfsDatabase>, uuid_id: &str) -> Option<DstuNode> {
    log::info!(
        "[DSTU::crud] fallback_lookup_uuid_resource: trying fallback for UUID id={}",
        uuid_id
    );

    // 1. 尝试教材（最可能是从旧数据库迁移的 UUID 格式）
    if let Ok(Some(textbook)) = VfsTextbookRepo::get_textbook(vfs_db, uuid_id) {
        log::info!(
            "[DSTU::crud] fallback_lookup_uuid_resource: found as textbook, id={}",
            uuid_id
        );
        return Some(textbook_to_dstu_node(&textbook));
    }

    // 2. 尝试笔记
    if let Ok(Some(note)) = VfsNoteRepo::get_note(vfs_db, uuid_id) {
        log::info!(
            "[DSTU::crud] fallback_lookup_uuid_resource: found as note, id={}",
            uuid_id
        );
        return Some(note_to_dstu_node(&note));
    }

    // 3. 尝试题目集
    if let Ok(Some(exam)) = VfsExamRepo::get_exam_sheet(vfs_db, uuid_id) {
        log::info!(
            "[DSTU::crud] fallback_lookup_uuid_resource: found as exam, id={}",
            uuid_id
        );
        return Some(exam_to_dstu_node(&exam));
    }

    // 4. 尝试翻译
    if let Ok(Some(translation)) = VfsTranslationRepo::get_translation(vfs_db, uuid_id) {
        log::info!(
            "[DSTU::crud] fallback_lookup_uuid_resource: found as translation, id={}",
            uuid_id
        );
        return Some(translation_to_dstu_node(&translation));
    }

    // 5. 尝试作文
    if let Ok(Some(essay)) = VfsEssayRepo::get_essay(vfs_db, uuid_id) {
        log::info!(
            "[DSTU::crud] fallback_lookup_uuid_resource: found as essay, id={}",
            uuid_id
        );
        return Some(essay_to_dstu_node(&essay));
    }

    log::warn!(
        "[DSTU::crud] fallback_lookup_uuid_resource: not found in any table, id={}",
        uuid_id
    );
    None
}
