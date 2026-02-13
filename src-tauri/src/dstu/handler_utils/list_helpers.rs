//! 列表辅助函数
//!
//! 包含智能文件夹模式的资源列表函数

use std::collections::HashSet;
use std::sync::Arc;

use crate::dstu::types::{DstuListOptions, DstuNode, DstuNodeType};
use crate::vfs::repos::VfsMindMapRepo;
use crate::vfs::{
    VfsDatabase, VfsEssayRepo, VfsExamRepo, VfsFileRepo, VfsNoteRepo, VfsTextbookRepo,
    VfsTranslationRepo,
};

use super::{
    exam_to_dstu_node, file_to_dstu_node, get_resource_folder_path, mindmap_to_dstu_node,
    note_to_dstu_node, session_to_dstu_node, textbook_to_dstu_node, translation_to_dstu_node,
};

/// 按类型列出资源，但返回文件夹路径（智能文件夹模式）
pub async fn list_resources_by_type_with_folder_path(
    vfs_db: &Arc<VfsDatabase>,
    type_filter: DstuNodeType,
    options: &DstuListOptions,
) -> Result<Vec<DstuNode>, String> {
    let mut results = Vec::new();
    let limit = options.get_limit();
    let offset = options.get_offset();

    match type_filter {
        DstuNodeType::Note => {
            let required_tags: Vec<String> = options
                .tags
                .as_ref()
                .map(|tags| {
                    tags.iter()
                        .map(|t| t.trim().to_lowercase())
                        .filter(|t| !t.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let has_tag_filter = !required_tags.is_empty();

            if !has_tag_filter {
                let notes = match VfsNoteRepo::list_notes(
                    vfs_db,
                    options.search.as_deref(),
                    limit,
                    offset,
                ) {
                    Ok(n) => n,
                    Err(e) => {
                        log::error!("[DSTU::list_helpers] list_resources_by_type_with_folder_path: FAILED - list_notes error={}", e);
                        return Err(e.to_string());
                    }
                };
                for note in notes {
                    let folder_path = get_resource_folder_path(vfs_db, &note.id).await?;
                    let mut node = note_to_dstu_node(&note);
                    // P1-10: 写回真实文件夹路径
                    node.path = folder_path;
                    results.push(node);
                }
                return Ok(results);
            }

            let page_size = limit.max(50).min(200);
            let mut skipped = 0u32;
            let mut page_offset = 0u32;
            let mut rounds = 0u32;
            loop {
                let notes = match VfsNoteRepo::list_notes(
                    vfs_db,
                    options.search.as_deref(),
                    page_size,
                    page_offset,
                ) {
                    Ok(n) => n,
                    Err(e) => {
                        log::error!("[DSTU::list_helpers] list_resources_by_type_with_folder_path: FAILED - list_notes error={}", e);
                        return Err(e.to_string());
                    }
                };
                if notes.is_empty() {
                    break;
                }

                for note in notes {
                    let note_tags: std::collections::HashSet<String> =
                        note.tags.iter().map(|t| t.trim().to_lowercase()).collect();
                    if !required_tags.iter().all(|t| note_tags.contains(t)) {
                        continue;
                    }
                    if skipped < offset {
                        skipped += 1;
                        continue;
                    }

                    let folder_path = get_resource_folder_path(vfs_db, &note.id).await?;
                    let mut node = note_to_dstu_node(&note);
                    // P1-10: 写回真实文件夹路径
                    node.path = folder_path;
                    results.push(node);
                    if results.len() >= limit as usize {
                        break;
                    }
                }

                if results.len() >= limit as usize {
                    break;
                }
                page_offset = page_offset.saturating_add(page_size);
                rounds += 1;
                if rounds > 10_000 {
                    log::warn!("[DSTU::list_helpers] list notes aborted after too many pages");
                    break;
                }
            }
        }
        DstuNodeType::Textbook => {
            let textbooks = match VfsTextbookRepo::list_textbooks(vfs_db, limit, offset) {
                Ok(t) => t,
                Err(e) => {
                    log::error!("[DSTU::list_helpers] list_resources_by_type_with_folder_path: FAILED - list_textbooks error={}", e);
                    return Err(e.to_string());
                }
            };
            for tb in textbooks {
                let folder_path = get_resource_folder_path(vfs_db, &tb.id).await?;
                let mut node = textbook_to_dstu_node(&tb);
                // P1-10: 写回真实文件夹路径
                node.path = folder_path;
                results.push(node);
            }
        }
        DstuNodeType::Exam => {
            let exams = match VfsExamRepo::list_exam_sheets(
                vfs_db,
                options.search.as_deref(),
                limit,
                offset,
            ) {
                Ok(e) => e,
                Err(e) => {
                    log::error!("[DSTU::list_helpers] list_resources_by_type_with_folder_path: FAILED - list_exam_sheets error={}", e);
                    return Err(e.to_string());
                }
            };
            for exam in exams {
                let folder_path = get_resource_folder_path(vfs_db, &exam.id).await?;
                let mut node = exam_to_dstu_node(&exam);
                // P1-10: 写回真实文件夹路径
                node.path = folder_path;
                results.push(node);
            }
        }
        DstuNodeType::Translation => {
            let translations = match VfsTranslationRepo::list_translations(
                vfs_db,
                options.search.as_deref(),
                limit,
                offset,
            ) {
                Ok(t) => t,
                Err(e) => {
                    log::error!("[DSTU::list_helpers] list_resources_by_type_with_folder_path: FAILED - list_translations error={}", e);
                    return Err(e.to_string());
                }
            };
            for tr in translations {
                let folder_path = get_resource_folder_path(vfs_db, &tr.id).await?;
                let mut node = translation_to_dstu_node(&tr);
                // P1-10: 写回真实文件夹路径
                node.path = folder_path;
                results.push(node);
            }
        }
        DstuNodeType::Essay => {
            let sessions = match VfsEssayRepo::list_sessions(vfs_db, limit, offset) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("[DSTU::list_helpers] list_resources_by_type_with_folder_path: FAILED - list_sessions error={}", e);
                    return Err(e.to_string());
                }
            };
            for session in sessions {
                let folder_path = get_resource_folder_path(vfs_db, &session.id).await?;
                let mut node = session_to_dstu_node(&session);
                // P1-10: 写回真实文件夹路径
                node.path = folder_path;
                results.push(node);
            }
        }
        DstuNodeType::Image => {
            let files = match VfsFileRepo::list_files_by_type(
                vfs_db,
                "image",
                limit as u32,
                offset as u32,
            ) {
                Ok(a) => a,
                Err(e) => {
                    log::error!("[DSTU::list_helpers] list_resources_by_type_with_folder_path: FAILED - list images error={}", e);
                    return Err(e.to_string());
                }
            };
            for file in files {
                let folder_path = get_resource_folder_path(vfs_db, &file.id).await?;
                let mut node = file_to_dstu_node(&file);
                node.path = folder_path;
                results.push(node);
            }
        }
        DstuNodeType::File => {
            let files = match VfsFileRepo::list_files_by_type(
                vfs_db,
                "document",
                limit as u32,
                offset as u32,
            ) {
                Ok(a) => a,
                Err(e) => {
                    log::error!("[DSTU::list_helpers] list_resources_by_type_with_folder_path: FAILED - list files error={}", e);
                    return Err(e.to_string());
                }
            };
            for file in files {
                let folder_path = get_resource_folder_path(vfs_db, &file.id).await?;
                let mut node = file_to_dstu_node(&file);
                node.path = folder_path;
                results.push(node);
            }
        }
        DstuNodeType::Folder => {
            log::warn!(
                "[DSTU::list_helpers] Folder type filter is not supported in smart folder mode"
            );
        }
        DstuNodeType::Retrieval => {
            // Retrieval 类型目前由 RAG 模块管理，不在 VFS 中列出
            log::debug!("[DSTU::list_helpers] Retrieval type is managed by RAG module, returning empty list");
        }
        DstuNodeType::MindMap => {
            let mindmaps = match VfsMindMapRepo::list_mindmaps(vfs_db) {
                Ok(m) => m,
                Err(e) => {
                    log::error!("[DSTU::list_helpers] list_resources_by_type_with_folder_path: FAILED - list_mindmaps error={}", e);
                    return Err(e.to_string());
                }
            };
            for mm in mindmaps {
                let folder_path = get_resource_folder_path(vfs_db, &mm.id).await?;
                let mut node = mindmap_to_dstu_node(&mm);
                node.path = folder_path;
                results.push(node);
            }
        }
    }

    Ok(results)
}

/// 列出未分配到任何文件夹的笔记
pub async fn list_unassigned_notes(
    vfs_db: &Arc<VfsDatabase>,
    assigned_ids: &HashSet<String>,
) -> Result<Vec<DstuNode>, String> {
    let all_notes = match VfsNoteRepo::list_notes(vfs_db, None, 1000, 0) {
        Ok(notes) => notes,
        Err(e) => {
            log::error!(
                "[DSTU::list_helpers] list_unassigned_notes: FAILED - list_notes error={}",
                e
            );
            return Err(e.to_string());
        }
    };

    let mut results = Vec::new();
    for note in all_notes {
        if !assigned_ids.contains(&note.id) {
            results.push(note_to_dstu_node(&note));
        }
    }

    Ok(results)
}

/// 列出未分配到任何文件夹的教材
pub async fn list_unassigned_textbooks(
    vfs_db: &Arc<VfsDatabase>,
    assigned_ids: &HashSet<String>,
) -> Result<Vec<DstuNode>, String> {
    let all_textbooks = match VfsTextbookRepo::list_textbooks(vfs_db, 1000, 0) {
        Ok(textbooks) => textbooks,
        Err(e) => {
            log::error!(
                "[DSTU::list_helpers] list_unassigned_textbooks: FAILED - list_textbooks error={}",
                e
            );
            return Err(e.to_string());
        }
    };

    let mut results = Vec::new();
    for textbook in all_textbooks {
        if !assigned_ids.contains(&textbook.id) {
            results.push(textbook_to_dstu_node(&textbook));
        }
    }

    Ok(results)
}

/// 列出未分配到任何文件夹的题目集
pub async fn list_unassigned_exams(
    vfs_db: &Arc<VfsDatabase>,
    assigned_ids: &HashSet<String>,
) -> Result<Vec<DstuNode>, String> {
    let all_exams = match VfsExamRepo::list_exam_sheets(vfs_db, None, 1000, 0) {
        Ok(exams) => exams,
        Err(e) => {
            log::error!(
                "[DSTU::list_helpers] list_unassigned_exams: FAILED - list_exam_sheets error={}",
                e
            );
            return Err(e.to_string());
        }
    };

    let mut results = Vec::new();
    for exam in all_exams {
        if !assigned_ids.contains(&exam.id) {
            results.push(exam_to_dstu_node(&exam));
        }
    }

    Ok(results)
}

/// 列出未分配到任何文件夹的翻译
pub async fn list_unassigned_translations(
    vfs_db: &Arc<VfsDatabase>,
    assigned_ids: &HashSet<String>,
) -> Result<Vec<DstuNode>, String> {
    let all_translations = match VfsTranslationRepo::list_translations(vfs_db, None, 1000, 0) {
        Ok(translations) => translations,
        Err(e) => {
            log::error!("[DSTU::list_helpers] list_unassigned_translations: FAILED - list_translations error={}", e);
            return Err(e.to_string());
        }
    };

    let mut results = Vec::new();
    for translation in all_translations {
        if !assigned_ids.contains(&translation.id) {
            results.push(translation_to_dstu_node(&translation));
        }
    }

    Ok(results)
}

/// 列出未分配到任何文件夹的作文
pub async fn list_unassigned_essays(
    vfs_db: &Arc<VfsDatabase>,
    assigned_ids: &HashSet<String>,
) -> Result<Vec<DstuNode>, String> {
    let all_sessions = match VfsEssayRepo::list_sessions(vfs_db, 1000, 0) {
        Ok(sessions) => sessions,
        Err(e) => {
            log::error!(
                "[DSTU::list_helpers] list_unassigned_essays: FAILED - list_sessions error={}",
                e
            );
            return Err(e.to_string());
        }
    };

    let mut results = Vec::new();
    for session in all_sessions {
        if !assigned_ids.contains(&session.id) {
            results.push(session_to_dstu_node(&session));
        }
    }

    Ok(results)
}
