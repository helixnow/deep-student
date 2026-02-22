//! DSTU Tauri 命令处理器
//!
//! 提供 DSTU 访达协议层的所有 Tauri 命令

use std::sync::Arc;

use rusqlite::OptionalExtension;
use serde_json::Value;
use tauri::{State, Window};

use super::error::DstuError;

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: std::result::Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("[DstuHandlers] Row parse error (skipped): {}", e);
            None
        }
    }
}
use super::path_parser::build_simple_resource_path;
use super::types::{
    BatchMoveRequest, BatchMoveResult, DstuCreateOptions, DstuListOptions, DstuNode, DstuNodeType,
    DstuParsedPath, DstuWatchEvent, FailedMoveItem, ResourceLocation,
};

// 从子模块导入路径工具和节点转换器
use super::handler_utils::{
    delete_resource_by_type,
    delete_resource_by_type_with_conn,
    emit_watch_event,
    essay_to_dstu_node,
    exam_to_dstu_node,
    extract_resource_info,
    fallback_lookup_uuid_resource, // UUID 回退查找
    fetch_resource_as_dstu_node,
    file_to_dstu_node,
    // 内容辅助函数
    get_content_by_type,
    // CRUD 辅助函数
    get_resource_by_type_and_id,
    infer_resource_type_from_id,
    is_uuid_format, // UUID 格式检测
    item_type_to_dstu_node_type,
    // 列表辅助函数
    list_resources_by_type_with_folder_path,
    list_unassigned_essays,
    list_unassigned_exams,
    list_unassigned_notes,
    list_unassigned_textbooks,
    list_unassigned_translations,
    mindmap_to_dstu_node,
    note_to_dstu_node,
    purge_resource_by_type,
    restore_resource_by_type,
    restore_resource_by_type_with_conn,
    search_all,
    // 搜索辅助函数
    search_by_index,
    session_to_dstu_node,
    textbook_to_dstu_node,
    translation_to_dstu_node,
};

use super::trash_handlers::is_resource_in_trash;

use crate::vfs::{
    repos::VfsMindMapRepo, VfsBlobRepo, VfsCreateEssaySessionParams, VfsCreateExamSheetParams,
    VfsCreateMindMapParams, VfsCreateNoteParams, VfsDatabase, VfsEssayRepo, VfsExamRepo, VfsFileRepo, VfsFolderItem, VfsFolderRepo, VfsNoteRepo, VfsTextbookRepo,
    VfsTranslationRepo, VfsUpdateMindMapParams, VfsUpdateNoteParams,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

// ============================================================================
// 输入验证常量
// ============================================================================

/// 最大内容大小: 1MB (用于防止内存耗尽攻击) - HIGH-004修复：从10MB降低到1MB
const MAX_CONTENT_SIZE: usize = 1 * 1024 * 1024; // 1MB

/// 最大元数据大小: 64KB (序列化后的JSON大小)
const MAX_METADATA_SIZE: usize = 64 * 1024; // 64KB

/// 最大名称长度: 256字符
const MAX_NAME_LENGTH: usize = 256;

/// 批量操作的最大数量限制 (防止 DoS 和超时)
const MAX_BATCH_SIZE: usize = 100;

// ============================================================================
// Tauri 命令
// ============================================================================

/// 列出目录内容
#[tauri::command]
pub async fn dstu_list(
    path: String,
    options: Option<DstuListOptions>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<DstuNode>, String> {
    let options = options.unwrap_or_default();

    log::info!(
        "[DSTU::handlers] dstu_list: folder_id={:?}, type_filter={:?}, path={}",
        options.get_folder_id(),
        options.get_type_filter(),
        path
    );

    dstu_list_folder_first(&options, &vfs_db).await
}

/// 文件夹优先模式的列表实现
async fn dstu_list_folder_first(
    options: &DstuListOptions,
    vfs_db: &Arc<VfsDatabase>,
) -> Result<Vec<DstuNode>, String> {
    let mut results = Vec::new();

    // 🔧 P0-07 修复: 统一 root 约定，支持 null、""、"root" 作为根目录
    let folder_id = options.folder_id.as_ref().map(|s| s.as_str());
    let is_root = folder_id.is_none()
        || folder_id == Some("")
        || folder_id == Some("root")
        || folder_id == Some("null");

    if let Some(ref fid) = options.folder_id {
        log::info!(
            "[DSTU::handlers] dstu_list_folder_first: listing folder {} (is_root={})",
            fid,
            is_root
        );
    }

    // ★ 优先处理收藏模式，避免被 is_root 拦截
    if let Some(true) = options.is_favorite {
        log::info!(
            "[DSTU::handlers] dstu_list_folder_first: favorite-only mode, loading all resources"
        );

        // 加载所有类型的资源（不筛选类型）
        for node_type in &[
            DstuNodeType::Note,
            DstuNodeType::Textbook,
            DstuNodeType::Exam,
            DstuNodeType::Translation,
            DstuNodeType::Essay,
            DstuNodeType::Image,
            DstuNodeType::File,
            DstuNodeType::MindMap,
        ] {
            let type_results =
                list_resources_by_type_with_folder_path(vfs_db, *node_type, options).await?;
            results.extend(type_results);
        }

        // 收藏筛选
        log::info!(
            "[DSTU::handlers] dstu_list_folder_first: filtering by favorite=true, before={}",
            results.len()
        );
        results.retain(|node| {
            if let Some(metadata) = &node.metadata {
                metadata
                    .get("isFavorite")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                    || metadata
                        .get("favorite")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    || metadata
                        .get("is_favorite")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
            } else {
                false
            }
        });
        log::info!(
            "[DSTU::handlers] dstu_list_folder_first: after favorite filter, count={}",
            results.len()
        );

        // 排序
        let sort_by = options.sort_by.as_deref().unwrap_or("updatedAt");
        let ascending = options
            .sort_order
            .as_deref()
            .map(|s| s == "asc")
            .unwrap_or(false);
        results.sort_by(|a, b| {
            let cmp = match sort_by {
                "name" => a.name.cmp(&b.name),
                "createdAt" => a.created_at.cmp(&b.created_at),
                _ => a.updated_at.cmp(&b.updated_at),
            };
            if ascending {
                cmp
            } else {
                cmp.reverse()
            }
        });
        return Ok(results);
    }

    // ★ 优先处理 typeFilter（智能文件夹模式），确保资源类型筛选生效
    if let Some(type_filter) = options.get_type_filter() {
        if is_root || options.folder_id.is_none() {
            // 智能文件夹模式：按类型列出所有资源
            log::info!(
                "[DSTU::handlers] dstu_list_folder_first: smart folder mode, type_filter={:?}",
                type_filter
            );
            return list_resources_by_type_with_folder_path(vfs_db, type_filter, options).await;
        }
    }

    if is_root {
        let _folder_id = "root"; // 用于日志
                                // 列出根级文件夹
        let root_folders = match crate::vfs::VfsFolderRepo::list_folders_by_parent(vfs_db, None) {
            Ok(folders) => folders,
            Err(e) => return Err(e.to_string()),
        };
        for folder in root_folders {
            results.push(DstuNode::folder(&folder.id, &folder.title, &folder.title));
        }

        // 列出根级资源（folder_id IS NULL 的资源）
        let root_items = match crate::vfs::VfsFolderRepo::list_items_by_folder(vfs_db, None) {
            Ok(items) => items,
            Err(e) => return Err(e.to_string()),
        };

        for item in root_items {
            if let Some(node) = fetch_resource_as_dstu_node(
                vfs_db,
                &item,
                &item
                    .cached_path
                    .clone()
                    .unwrap_or_else(|| item.item_id.clone()),
            )
            .await?
            {
                results.push(node);
            }
        }

        // ★ 修复：获取所有已分配的资源 ID（包括所有文件夹，不只是根级别）
        // 这样 list_unassigned_* 函数才能正确排除已移动到其他文件夹的资源
        let all_assigned_ids = match crate::vfs::VfsFolderRepo::list_all_assigned_item_ids(vfs_db) {
            Ok(ids) => ids,
            Err(e) => return Err(e.to_string()),
        };

        // 列出未分配资源（不在任何文件夹中的资源）
        results.extend(list_unassigned_notes(vfs_db, &all_assigned_ids).await?);
        results.extend(list_unassigned_textbooks(vfs_db, &all_assigned_ids).await?);
        results.extend(list_unassigned_exams(vfs_db, &all_assigned_ids).await?);
        results.extend(list_unassigned_translations(vfs_db, &all_assigned_ids).await?);
        results.extend(list_unassigned_essays(vfs_db, &all_assigned_ids).await?);

        return Ok(results);
    } else if let Some(ref actual_folder_id) = options.folder_id {
        // 获取指定文件夹（非根目录）
        let _folder = match crate::vfs::VfsFolderRepo::get_folder(vfs_db, actual_folder_id) {
            Ok(Some(f)) => f,
            Ok(None) => {
                log::warn!(
                    "[DSTU::handlers] dstu_list: folder not found: {}",
                    actual_folder_id
                );
                return Err("文件夹不存在".to_string());
            }
            Err(e) => return Err(e.to_string()),
        };

        let folder_path = crate::vfs::VfsFolderRepo::build_folder_path(vfs_db, actual_folder_id)
            .map_err(|e| e.to_string())?;

        // 列出子文件夹
        let sub_folders =
            crate::vfs::VfsFolderRepo::list_folders_by_parent(vfs_db, Some(actual_folder_id))
                .map_err(|e| e.to_string())?;
        for sub_folder in sub_folders {
            let sub_path = format!("{}/{}", folder_path, sub_folder.title);
            results.push(DstuNode::folder(
                &sub_folder.id,
                &sub_path,
                &sub_folder.title,
            ));
        }

        // 列出文件夹内的资源
        let items = crate::vfs::VfsFolderRepo::list_items_by_folder(vfs_db, Some(actual_folder_id))
            .map_err(|e| e.to_string())?;

        for item in items {
            if let Some(type_filter) = options.get_type_filter() {
                if let Some(node_type) = item_type_to_dstu_node_type(&item.item_type) {
                    if node_type != type_filter {
                        continue;
                    }
                }
            }

            let resource_path = item
                .cached_path
                .clone()
                .unwrap_or_else(|| format!("{}/{}", folder_path, &item.item_id));

            if let Some(node) = fetch_resource_as_dstu_node(vfs_db, &item, &resource_path).await? {
                results.push(node);
            }
        }
    } else if let Some(type_filter) = options.get_type_filter() {
        results = list_resources_by_type_with_folder_path(vfs_db, type_filter, options).await?;
    }
    // 注意：收藏模式已在函数开头优先处理，不会到达这里

    // 排序
    let sort_by = options.sort_by.as_deref().unwrap_or("updatedAt");
    let ascending = options
        .sort_order
        .as_deref()
        .map(|s| s == "asc")
        .unwrap_or(false);

    results.sort_by(|a, b| {
        let cmp = match sort_by {
            "name" => a.name.cmp(&b.name),
            "createdAt" => a.created_at.cmp(&b.created_at),
            _ => a.updated_at.cmp(&b.updated_at),
        };
        if ascending {
            cmp
        } else {
            cmp.reverse()
        }
    });

    // 分页
    let offset = options.get_offset() as usize;
    let limit = options.get_limit() as usize;
    if offset > 0 {
        results = results.into_iter().skip(offset).collect();
    }
    if results.len() > limit {
        results.truncate(limit);
    }

    Ok(results)
}

// ============================================================================
// 资源获取命令
// ============================================================================

/// 获取资源详情
///
/// 获取指定路径的资源节点详情。
///
/// ## 参数
/// - `path`: DSTU 路径（支持完整路径如 `/数学/notes/note_xxx` 或简化路径如 `/note_xxx` 或 `note_xxx`）
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 资源节点，不存在时返回 None
#[tauri::command]
pub async fn dstu_get(
    path: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<DstuNode>, String> {
    log::info!("[DSTU::handlers] dstu_get: path={}", path);

    // 统一路径解析：新格式 /{resource_id}
    let (resource_type, id) = match extract_resource_info(&path) {
        Ok((rt, rid)) => (rt, rid),
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_get: FAILED - path={}, error={}",
                path,
                e
            );
            return Err(e.to_string());
        }
    };

    // 根据类型直接查找资源
    let node = match resource_type.as_str() {
        "notes" => match VfsNoteRepo::get_note(&vfs_db, &id) {
            Ok(Some(note)) => Some(note_to_dstu_node(&note)),
            Ok(None) => None,
            Err(e) => {
                log::error!(
                    "[DSTU::handlers] dstu_get: FAILED - get_note error, id={}, error={}",
                    id,
                    e
                );
                return Err(e.to_string());
            }
        },
        "textbooks" => match VfsTextbookRepo::get_textbook(&vfs_db, &id) {
            Ok(Some(textbook)) => Some(textbook_to_dstu_node(&textbook)),
            Ok(None) => None,
            Err(e) => {
                log::error!(
                    "[DSTU::handlers] dstu_get: FAILED - get_textbook error, id={}, error={}",
                    id,
                    e
                );
                return Err(e.to_string());
            }
        },
        "exams" => match VfsExamRepo::get_exam_sheet(&vfs_db, &id) {
            Ok(Some(exam)) => Some(exam_to_dstu_node(&exam)),
            Ok(None) => None,
            Err(e) => {
                log::error!(
                    "[DSTU::handlers] dstu_get: FAILED - get_exam_sheet error, id={}, error={}",
                    id,
                    e
                );
                return Err(e.to_string());
            }
        },
        "translations" => {
            match VfsTranslationRepo::get_translation(&vfs_db, &id) {
                Ok(Some(translation)) => Some(translation_to_dstu_node(&translation)),
                Ok(None) => None,
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_get: FAILED - get_translation error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            }
        }
        "essays" => {
            // 先尝试 essays 表
            match VfsEssayRepo::get_essay(&vfs_db, &id) {
                Ok(Some(essay)) => Some(essay_to_dstu_node(&essay)),
                Ok(None) => {
                    // 再尝试 essay_sessions 表
                    match VfsEssayRepo::get_session(&vfs_db, &id) {
                        Ok(Some(session)) => Some(session_to_dstu_node(&session)),
                        Ok(None) => None,
                        Err(e) => {
                            log::error!("[DSTU::handlers] dstu_get: FAILED - get_session error, id={}, error={}", id, e);
                            return Err(e.to_string());
                        }
                    }
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_get: FAILED - get_essay error, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            }
        }
        "folders" => {
            match crate::vfs::VfsFolderRepo::get_folder(&vfs_db, &id) {
                Ok(Some(folder)) => {
                    let folder_path = build_simple_resource_path(&folder.id);
                    Some(DstuNode::folder(&folder.id, &folder_path, &folder.title))
                }
                Ok(None) => {
                    // UUID 格式但不是文件夹时，尝试回退查找其他资源类型
                    // 这是为了兼容从旧数据库迁移的资源（如教材可能使用 UUID 作为 ID）
                    if is_uuid_format(&id) {
                        log::info!("[DSTU::handlers] dstu_get: folder not found for UUID, trying fallback lookup, id={}", id);
                        fallback_lookup_uuid_resource(&vfs_db, &id)
                    } else {
                        None
                    }
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_get: FAILED - get_folder error, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            }
        }
        "mindmaps" => match VfsMindMapRepo::get_mindmap(&vfs_db, &id) {
            Ok(Some(mindmap)) => Some(mindmap_to_dstu_node(&mindmap)),
            Ok(None) => None,
            Err(e) => {
                log::error!(
                    "[DSTU::handlers] dstu_get: FAILED - get_mindmap error, id={}, error={}",
                    id,
                    e
                );
                return Err(e.to_string());
            }
        },
        "files" => match VfsFileRepo::get_file(&vfs_db, &id) {
            Ok(Some(file)) => Some(file_to_dstu_node(&file)),
            Ok(None) => None,
            Err(e) => {
                log::error!(
                    "[DSTU::handlers] dstu_get: FAILED - get_file error, id={}, error={}",
                    id,
                    e
                );
                return Err(e.to_string());
            }
        },
        _ => {
            log::warn!(
                "[DSTU::handlers] dstu_get: unsupported type={}",
                resource_type
            );
            None
        }
    };

    if node.is_some() {
        log::info!(
            "[DSTU::handlers] dstu_get: SUCCESS - type={}, id={}",
            resource_type,
            id
        );
    } else {
        log::warn!(
            "[DSTU::handlers] dstu_get: NOT FOUND - type={}, id={}",
            resource_type,
            id
        );
    }

    Ok(node)
}

/// 创建资源
///
/// 在指定路径下创建新资源。
///
/// ## 参数
/// - `path`: 父目录路径（如 `/数学/notes`）
/// - `options`: 创建选项（类型、名称、内容等）
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 新创建的资源节点
#[tauri::command]
pub async fn dstu_create(
    path: String,
    options: DstuCreateOptions,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DstuNode, String> {
    log::info!(
        "[DSTU::handlers] dstu_create: path={}, type={:?}, name={}",
        path,
        options.node_type,
        options.name
    );

    // ============================================================================
    // 输入验证：防止内存耗尽和DoS攻击
    // ============================================================================

    // 验证名称长度
    if options.name.len() > MAX_NAME_LENGTH {
        let error_msg = format!(
            "名称长度超出限制: {} 字符 (最大允许: {} 字符)",
            options.name.len(),
            MAX_NAME_LENGTH
        );
        log::error!("[DSTU::handlers] dstu_create: FAILED - {}", error_msg);
        return Err(error_msg);
    }

    // 验证内容大小
    if let Some(ref content) = options.content {
        let content_bytes = content.len();
        if content_bytes > MAX_CONTENT_SIZE {
            let error_msg = format!(
                "内容大小超出限制: {} 字节 ({:.2} MB) (最大允许: {} 字节 ({} MB))",
                content_bytes,
                content_bytes as f64 / (1024.0 * 1024.0),
                MAX_CONTENT_SIZE,
                MAX_CONTENT_SIZE / (1024 * 1024)
            );
            log::error!("[DSTU::handlers] dstu_create: FAILED - {}", error_msg);
            return Err(error_msg);
        }
    }

    // 验证元数据大小
    if let Some(ref metadata) = options.metadata {
        // 序列化元数据以检查实际大小
        let metadata_json = match serde_json::to_string(metadata) {
            Ok(json) => json,
            Err(e) => {
                let error_msg = format!("元数据序列化失败: {}", e);
                log::error!("[DSTU::handlers] dstu_create: FAILED - {}", error_msg);
                return Err(error_msg);
            }
        };

        let metadata_bytes = metadata_json.len();
        if metadata_bytes > MAX_METADATA_SIZE {
            let error_msg = format!(
                "元数据大小超出限制: {} 字节 ({:.2} KB) (最大允许: {} 字节 ({} KB))",
                metadata_bytes,
                metadata_bytes as f64 / 1024.0,
                MAX_METADATA_SIZE,
                MAX_METADATA_SIZE / 1024
            );
            log::error!("[DSTU::handlers] dstu_create: FAILED - {}", error_msg);
            return Err(error_msg);
        }
    }

    log::info!(
        "[DSTU::handlers] dstu_create: 输入验证通过 - name_len={}, content_size={}, metadata_size={}",
        options.name.len(),
        options.content.as_ref().map_or(0, |c| c.len()),
        options.metadata.as_ref().map_or(0, |m| serde_json::to_string(m).map_or(0, |j| j.len()))
    );

    // ============================================================================
    // 解析目标文件夹（Learning Hub 生命周期：创建应产生 folder_items 记录，根目录也不例外）
    // ============================================================================

    let metadata = options.metadata.clone().unwrap_or_default();

    // 1) 优先从 metadata.folderId 解析（前端 createEmpty 会透传 currentPath.folderId）
    let folder_id_from_metadata: Option<String> = metadata
        .get("folderId")
        .and_then(|v| v.as_str())
        .and_then(|s| match s {
            "" | "root" => None,
            other if other.starts_with("fld_") => Some(other.to_string()),
            _ => None,
        });

    // 2) 其次从 path 解析（兼容 /fld_xxx 形式）
    let folder_id_from_path: Option<String> = if folder_id_from_metadata.is_some() {
        None
    } else if path == "/" {
        None
    } else {
        let trimmed = path.trim_start_matches('/');
        if trimmed.starts_with("fld_") {
            Some(trimmed.to_string())
        } else {
            None
        }
    };

    // None 表示根目录：仍应创建 folder_items 记录（便于后续移动/路径缓存）
    let folder_id: Option<String> = folder_id_from_metadata.or(folder_id_from_path);

    // 从 options.node_type 获取资源类型
    let resource_type = match options.node_type {
        DstuNodeType::Note => "notes",
        DstuNodeType::Textbook => "textbooks",
        DstuNodeType::Exam => "exams",
        DstuNodeType::Translation => "translations",
        DstuNodeType::Essay => "essays",
        DstuNodeType::Folder => "folders",
        DstuNodeType::MindMap => "mindmaps",
        DstuNodeType::Image => "images",
        DstuNodeType::File => "files",
        _ => {
            log::error!(
                "[DSTU::handlers] dstu_create: FAILED - unsupported type {:?}",
                options.node_type
            );
            return Err(format!(
                "Unsupported resource type: {:?}",
                options.node_type
            ));
        }
    };

    log::info!(
        "[DSTU::handlers] dstu_create: folder_id={:?}, resource_type={}",
        folder_id,
        resource_type
    );

    let content = options.content.clone().unwrap_or_default();

    // 根据类型路由到对应 Repo
    let node = match resource_type {
        "notes" => {
            // 如果名称为空，使用默认标题
            let note_title = if options.name.trim().is_empty() {
                log::warn!("[DSTU::handlers] dstu_create: note name is empty, using fallback title 'Untitled'");
                "Untitled".to_string()
            } else {
                options.name.clone()
            };
            log::info!(
                "[DSTU::handlers] dstu_create: 创建笔记 - 输入名称='{}', 最终标题='{}'",
                options.name,
                note_title
            );
            match VfsNoteRepo::create_note_in_folder(
                &vfs_db,
                VfsCreateNoteParams {
                    title: note_title,
                    content: content.clone(),
                    tags: vec![],
                },
                folder_id.as_deref(),
            ) {
                Ok(note) => {
                    log::info!(
                        "[DSTU::handlers] dstu_create: SUCCESS - type=note, id={}, title='{}'",
                        note.id,
                        note.title
                    );
                    let dstu_node = note_to_dstu_node(&note);
                    log::info!(
                        "[DSTU::handlers] dstu_create: 返回 DstuNode - id={}, name='{}'",
                        dstu_node.id,
                        dstu_node.name
                    );
                    dstu_node
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_create: FAILED - type=note, error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            }
        }
        "textbooks" => {
            // 教材创建需要文件上传，这里仅支持元数据创建
            return Err(
                "Textbook creation requires file upload, use vfs_create_textbook instead"
                    .to_string(),
            );
        }
        "translations" => {
            // 从 metadata 提取翻译参数
            let source = metadata
                .get("sourceText")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let translated = metadata
                .get("translatedText")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let src_lang = metadata
                .get("srcLang")
                .and_then(|v| v.as_str())
                .unwrap_or("auto")
                .to_string();
            let tgt_lang = metadata
                .get("tgtLang")
                .and_then(|v| v.as_str())
                .unwrap_or("en")
                .to_string();

            // 修复名称不匹配问题 - 传递 options.name 作为 title
            let title = if options.name.trim().is_empty() {
                None
            } else {
                Some(options.name.clone())
            };
            log::info!(
                "[DSTU::handlers] dstu_create: 创建翻译 - 输入名称='{}', 最终标题='{:?}'",
                options.name,
                title
            );

            let translation = match VfsTranslationRepo::create_translation_in_folder(
                &vfs_db,
                crate::vfs::types::VfsCreateTranslationParams {
                    title,
                    source,
                    translated,
                    src_lang,
                    tgt_lang,
                    engine: None,
                    model: None,
                },
                folder_id.as_deref(),
            ) {
                Ok(t) => {
                    log::info!(
                        "[DSTU::handlers] dstu_create: SUCCESS - type=translation, id={}",
                        t.id
                    );
                    t
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_create: FAILED - type=translation, error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 设置额外元数据（收藏、评分等）
            if let Some(favorite) = metadata.get("isFavorite").and_then(|v| v.as_bool()) {
                if favorite {
                    let _ = VfsTranslationRepo::set_favorite(&vfs_db, &translation.id, true);
                }
            }
            if let Some(rating) = metadata.get("qualityRating").and_then(|v| v.as_i64()) {
                let _ =
                    VfsTranslationRepo::set_quality_rating(&vfs_db, &translation.id, rating as i32);
            }

            translation_to_dstu_node(&translation)
        }
        "essays" => {
            // 从 metadata 提取作文会话参数
            let essay_type = metadata
                .get("essayType")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let grade_level = metadata
                .get("gradeLevel")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let custom_prompt = metadata
                .get("customPrompt")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let params = VfsCreateEssaySessionParams {
                title: options.name.clone(),
                essay_type: essay_type.clone(),
                grade_level: grade_level.clone(),
                custom_prompt,
            };

            let session =
                match VfsEssayRepo::create_session_in_folder(&vfs_db, params, folder_id.as_deref())
                {
                    Ok(s) => {
                        log::info!(
                            "[DSTU::handlers] dstu_create: SUCCESS - type=essay, id={}",
                            s.id
                        );
                        s
                    }
                    Err(e) => {
                        log::error!(
                            "[DSTU::handlers] dstu_create: FAILED - type=essay, error={}",
                            e
                        );
                        return Err(e.to_string());
                    }
                };

            // 直接从 session 构建 DstuNode
            let essay_path = build_simple_resource_path(&session.id);

            // 解析时间戳
            let created_at_str = &session.created_at;
            let created_at = chrono::DateTime::parse_from_rfc3339(created_at_str)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_else(|e| {
                    log::warn!("[DSTU::handlers] Failed to parse created_at '{}': {}, using epoch fallback", created_at_str, e);
                    0_i64
                });
            let updated_at_str = &session.updated_at;
            let updated_at = chrono::DateTime::parse_from_rfc3339(updated_at_str)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_else(|e| {
                    log::warn!("[DSTU::handlers] Failed to parse updated_at '{}': {}, using epoch fallback", updated_at_str, e);
                    created_at
                });

            DstuNode::resource(
                &session.id,
                &essay_path,
                &session.title,
                DstuNodeType::Essay,
                &session.id, // 使用 session.id 作为 resource_id
            )
            .with_timestamps(created_at, updated_at)
            .with_metadata(serde_json::json!({
                "essayType": essay_type,
                "gradeLevel": grade_level,
                "totalRounds": session.total_rounds,
                "isFavorite": session.is_favorite,
            }))
        }
        "exams" => {
            // 创建空的题目集记录
            // 修复名称不匹配问题 - 优先使用 options.name，确保返回的名称与输入一致
            let exam_name = if options.name.trim().is_empty() {
                // 如果 options.name 为空，尝试从 metadata 获取
                metadata
                    .get("examName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            } else {
                // 优先使用 options.name
                Some(options.name.clone())
            };

            log::info!(
                "[DSTU::handlers] dstu_create: 创建题目集 - 输入名称='{}', 最终名称='{:?}'",
                options.name,
                exam_name
            );

            // 生成临时 ID
            let temp_id = format!("temp_{}", uuid::Uuid::new_v4());

            let params = VfsCreateExamSheetParams {
                exam_name,
                temp_id: temp_id.clone(),
                metadata_json: serde_json::json!({
                    "status": "empty",
                    "pageCount": 0,
                    "questionCount": 0
                }),
                preview_json: serde_json::json!({
                    "temp_id": temp_id,
                    "exam_name": options.name,
                    "pages": []
                }),
                status: "empty".to_string(),
                folder_id: None, // 由 folder_items 决定位置，DSTU 统一通过 create_exam_sheet_in_folder 维护
            };

            let exam = match VfsExamRepo::create_exam_sheet_in_folder(
                &vfs_db,
                params,
                folder_id.as_deref(),
            ) {
                Ok(ex) => {
                    log::info!(
                        "[DSTU::handlers] dstu_create: SUCCESS - type=exam, id={}",
                        ex.id
                    );
                    ex
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_create: FAILED - type=exam, error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            exam_to_dstu_node(&exam)
        }
        "mindmaps" => {
            // 从 metadata 提取知识导图参数
            let theme = metadata
                .get("theme")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "default".to_string());
            let default_view = metadata
                .get("defaultView")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "outline".to_string());
            let description = metadata
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let params = VfsCreateMindMapParams {
                title: options.name.clone(),
                content: content.clone(),
                description,
                default_view,
                theme: Some(theme),
            };

            let mindmap = match VfsMindMapRepo::create_mindmap_in_folder(
                &vfs_db,
                params,
                folder_id.as_deref(),
            ) {
                Ok(m) => {
                    log::info!(
                        "[DSTU::handlers] dstu_create: SUCCESS - type=mindmap, id={}",
                        m.id
                    );
                    m
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_create: FAILED - type=mindmap, error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            mindmap_to_dstu_node(&mindmap)
        }
        "images" | "files" => {
            // 验证 file_base64 参数
            let file_base64 = match &options.file_base64 {
                Some(b64) if !b64.is_empty() => b64,
                _ => {
                    log::error!("[DSTU::handlers] dstu_create: FAILED - file_base64 is required for images/files");
                    return Err("file_base64 is required for images/files creation".to_string());
                }
            };

            // 验证 Base64 数据大小（避免超大字符串导致内存压力）
            const MAX_IMAGE_SIZE: usize = 10 * 1024 * 1024; // 10MB
            const MAX_FILE_SIZE: usize = 50 * 1024 * 1024; // 50MB
            let max_file_size = if resource_type == "images" {
                MAX_IMAGE_SIZE
            } else {
                MAX_FILE_SIZE
            };
            let max_base64_len = ((max_file_size + 2) / 3) * 4 + 16; // 4/3 编码开销 + 少量余量
            if file_base64.len() > max_base64_len {
                log::error!(
                    "[DSTU::handlers] dstu_create: FAILED - base64 payload too large: {} bytes",
                    file_base64.len()
                );
                return Err(format!(
                    "Base64 payload exceeds limit: {} bytes (max: {} bytes)",
                    file_base64.len(),
                    max_base64_len
                ));
            }

            // 解码 Base64 数据
            let file_data = match BASE64.decode(file_base64) {
                Ok(data) => data,
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_create: FAILED - base64 decode error: {}",
                        e
                    );
                    return Err(format!("Invalid base64 data: {}", e));
                }
            };

            // 验证文件大小
            if file_data.len() > max_file_size {
                log::error!(
                    "[DSTU::handlers] dstu_create: FAILED - file too large: {} bytes",
                    file_data.len()
                );
                return Err(format!(
                    "File size exceeds limit: {} bytes (max: {} bytes)",
                    file_data.len(),
                    max_file_size
                ));
            }

            // 从 metadata 提取 MIME 类型和文件大小
            let default_mime = if resource_type == "images" {
                "image/jpeg"
            } else {
                "application/octet-stream"
            };
            let raw_mime = metadata
                .get("mimeType")
                .and_then(|v| v.as_str())
                .unwrap_or(default_mime);
            let mime_type = if resource_type == "images" {
                if raw_mime.starts_with("image/") {
                    raw_mime
                } else {
                    log::warn!(
                        "[DSTU::handlers] dstu_create: invalid image mime type '{}', fallback to {}",
                        raw_mime,
                        default_mime
                    );
                    default_mime
                }
            } else if raw_mime.contains('/') {
                raw_mime
            } else {
                log::warn!(
                    "[DSTU::handlers] dstu_create: invalid mime type '{}', fallback to {}",
                    raw_mime,
                    default_mime
                );
                default_mime
            };

            // 根据 MIME 类型推断扩展名
            let extension = match mime_type {
                "image/jpeg" => "jpg",
                "image/png" => "png",
                "image/gif" => "gif",
                "image/webp" => "webp",
                "image/bmp" => "bmp",
                "image/svg+xml" => "svg",
                "application/pdf" => "pdf",
                "text/plain" => "txt",
                "text/markdown" => "md",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation" => {
                    "pptx"
                }
                _ => mime_type.split('/').last().unwrap_or("bin"),
            };

            // 存储文件到 Blob
            let blob = match VfsBlobRepo::store_blob(
                &vfs_db,
                &file_data,
                Some(mime_type),
                Some(extension),
            ) {
                Ok(b) => {
                    log::info!("[DSTU::handlers] dstu_create: blob stored, hash={}", b.hash);
                    b
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_create: FAILED - blob store error: {}",
                        e
                    );
                    return Err(format!("Failed to store blob: {}", e));
                }
            };

            // 创建文件记录
            let file_type = if resource_type == "images" {
                "image"
            } else {
                "file"
            };
            let file_name = if options.name.trim().is_empty() {
                format!("unnamed.{}", extension)
            } else {
                options.name.clone()
            };

            let file = match VfsFileRepo::create_file_in_folder(
                &vfs_db,
                &blob.hash, // sha256: 使用 blob 的 hash
                &file_name,
                file_data.len() as i64,
                file_type,
                Some(mime_type),
                Some(&blob.hash), // blob_hash
                None,             // original_path
                folder_id.as_deref(),
            ) {
                Ok(f) => {
                    log::info!(
                        "[DSTU::handlers] dstu_create: SUCCESS - type={}, id={}, name='{}'",
                        file_type,
                        f.id,
                        f.file_name
                    );
                    f
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_create: FAILED - type={}, error={}",
                        file_type,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            file_to_dstu_node(&file)
        }
        _ => {
            return Err(DstuError::invalid_node_type(resource_type).to_string());
        }
    };

    // 发射创建事件
    emit_watch_event(&window, DstuWatchEvent::created(&node.path, node.clone()));

    log::info!("[DSTU::handlers] dstu_create: created {}", node.path);
    Ok(node)
}

/// 更新资源内容
///
/// 更新指定资源的内容。对于笔记等资源，会自动触发版本管理。
///
/// ## 参数
/// - `path`: 资源路径
/// - `content`: 新内容
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 更新后的资源节点
#[tauri::command]
pub async fn dstu_update(
    path: String,
    content: String,
    resource_type: String,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DstuNode, String> {
    log::info!(
        "[DSTU::handlers] dstu_update: path={}, type={}, content_len={}",
        path,
        resource_type,
        content.len()
    );

    // ============================================================================
    // 输入验证：防止内存耗尽和DoS攻击
    // ============================================================================

    // 验证内容大小
    let content_bytes = content.len();
    if content_bytes > MAX_CONTENT_SIZE {
        let error_msg = format!(
            "内容大小超出限制: {} 字节 ({:.2} MB) (最大允许: {} 字节 ({} MB))",
            content_bytes,
            content_bytes as f64 / (1024.0 * 1024.0),
            MAX_CONTENT_SIZE,
            MAX_CONTENT_SIZE / (1024 * 1024)
        );
        log::error!("[DSTU::handlers] dstu_update: FAILED - {}", error_msg);
        return Err(error_msg);
    }

    log::info!(
        "[DSTU::handlers] dstu_update: 输入验证通过 - content_size={}",
        content_bytes
    );

    // 从简单路径中提取 ID
    let id = path.trim_start_matches('/').to_string();
    if id.is_empty() {
        log::error!("[DSTU::handlers] dstu_update: FAILED - empty path");
        return Err(DstuError::invalid_path("Update path must contain resource ID").to_string());
    }

    // 根据类型路由到对应 Repo
    let node = match resource_type.as_str() {
        "notes" | "note" => {
            let updated_note = match VfsNoteRepo::update_note(
                &vfs_db,
                &id,
                VfsUpdateNoteParams {
                    content: Some(content),
                    title: None,
                    tags: None,
                    expected_updated_at: None,
                },
            ) {
                Ok(n) => {
                    log::info!(
                        "[DSTU::handlers] dstu_update: SUCCESS - type=note, id={}",
                        id
                    );
                    n
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_update: FAILED - type=note, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            note_to_dstu_node(&updated_note)
        }
        "textbooks" | "textbook" => {
            // 教材内容是 PDF，不支持直接更新内容
            return Err("Textbook content update not supported".to_string());
        }
        "translations" | "translation" | "exams" | "exam" | "essays" | "essay" | "images"
        | "image" | "files" | "file" => {
            // TODO: 实现其他类型的 Repo 调用
            return Err(format!(
                "{} update not yet implemented via DSTU",
                resource_type
            ));
        }
        _ => {
            return Err(DstuError::invalid_node_type(&resource_type).to_string());
        }
    };

    // 发射更新事件
    emit_watch_event(&window, DstuWatchEvent::updated(&path, node.clone()));

    log::info!("[DSTU::handlers] dstu_update: updated {}", path);
    Ok(node)
}

/// 删除资源
///
/// 删除指定路径的资源（软删除）。
///
/// ## 参数
/// - `path`: 资源路径（支持完整路径如 `/数学/notes/note_xxx` 或 ID 如 `note_xxx`）
/// - `vfs_db`: VFS 数据库实例
#[tauri::command]
pub async fn dstu_delete(
    path: String,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<(), String> {
    log::info!("[DSTU::handlers] dstu_delete: path={}", path);

    // 统一路径解析：支持简化 ID 和新格式路径
    let (mut resource_type, id) = match extract_resource_info(&path) {
        Ok((rt, rid)) => (rt, rid),
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_delete: FAILED - path={}, error={}",
                path,
                e
            );
            return Err(e.to_string());
        }
    };

    // UUID fallback 机制：如果是 folders 类型但实际可能是其他资源（兼容旧数据库迁移）
    if resource_type == "folders" && is_uuid_format(&id) {
        // 尝试先用 fallback 查找实际类型
        if let Some(node) = fallback_lookup_uuid_resource(&vfs_db, &id) {
            let actual_type = match node.node_type {
                DstuNodeType::Textbook => "textbooks",
                DstuNodeType::Note => "notes",
                DstuNodeType::Exam => "exams",
                DstuNodeType::Translation => "translations",
                DstuNodeType::Essay => "essays",
                _ => "folders",
            };
            log::info!(
                "[DSTU::handlers] dstu_delete: UUID fallback found actual type={}, id={}",
                actual_type,
                id
            );
            resource_type = actual_type.to_string();
        }
    }

    // ★ P1 修复：在删除前查找 resource_id，用于删除后清理向量索引
    let resource_id: Option<String> = vfs_db.get_conn_safe().ok().and_then(|conn| {
        let sql = match resource_type.as_str() {
            "notes" | "note" => Some("SELECT resource_id FROM notes WHERE id = ?1"),
            "textbooks" | "textbook" | "images" | "image" | "files" | "file" | "attachments" | "attachment" =>
                Some("SELECT resource_id FROM files WHERE id = ?1"),
            "exams" | "exam" => Some("SELECT resource_id FROM exam_sheets WHERE id = ?1"),
            "translations" | "translation" => Some("SELECT resource_id FROM translations WHERE id = ?1"),
            "mindmaps" | "mindmap" => Some("SELECT resource_id FROM mindmaps WHERE id = ?1"),
            _ => None,
        };
        sql.and_then(|s| {
            conn.query_row(s, rusqlite::params![id], |row| row.get::<_, Option<String>>(0))
                .ok()
                .flatten()
        })
    });

    // 使用辅助函数执行删除
    delete_resource_by_type(&vfs_db, &resource_type, &id)?;

    // 发射删除事件
    emit_watch_event(&window, DstuWatchEvent::deleted(&path));

    // ★ P1 修复：删除成功后异步清理向量索引
    if let Some(rid) = resource_id {
        let lance_for_cleanup = Arc::clone(lance_store.inner());
        tokio::spawn(async move {
            let _ = lance_for_cleanup.delete_by_resource("text", &rid).await;
            let _ = lance_for_cleanup.delete_by_resource("multimodal", &rid).await;
            log::info!("[DSTU::handlers] dstu_delete: cleaned up vectors for {}", rid);
        });
    }

    log::info!(
        "[DSTU::handlers] dstu_delete: deleted type={}, id={}",
        resource_type,
        id
    );
    Ok(())
}

/// 移动/重命名资源
///
/// 将资源从一个路径移动到另一个路径。可用于：
/// - 跨科目移动（更新 subject 字段）
/// - 重命名
///
/// ## 参数
/// - `src`: 源路径
/// - `dst`: 目标路径
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 移动后的资源节点
#[tauri::command]
pub async fn dstu_move(
    src: String,
    dst: String,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DstuNode, String> {
    log::info!("[DSTU::handlers] dstu_move: src={}, dst={}", src, dst);

    // 统一路径解析
    let (src_type, src_id) = match extract_resource_info(&src) {
        Ok((rt, rid)) => (rt, rid),
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_move: FAILED - src={}, error={}",
                src,
                e
            );
            return Err(e.to_string());
        }
    };
    let resource_type = src_type;

    let item_type = match resource_type.as_str() {
        "notes" => "note",
        "textbooks" => "textbook",
        "exams" => "exam",
        "translations" => "translation",
        "essays" => "essay",
        "folders" => "folder",
        "mindmaps" => "mindmap",
        "files" | "images" | "attachments" => "file",
        _ => {
            return Err(DstuError::invalid_node_type(resource_type).to_string());
        }
    };

    let dest_folder_id = if dst.trim().is_empty() || dst.trim() == "/" {
        None
    } else {
        let (dst_type, dst_id) = match extract_resource_info(&dst) {
            Ok((rt, rid)) => (rt, rid),
            Err(e) => {
                log::error!(
                    "[DSTU::handlers] dstu_move: FAILED - dst={}, error={}",
                    dst,
                    e
                );
                return Err(e.to_string());
            }
        };
        if dst_type != "folders" {
            return Err("Destination must be a folder".to_string());
        }
        Some(dst_id)
    };

    if let Err(e) =
        VfsFolderRepo::move_item_to_folder(&vfs_db, item_type, &src_id, dest_folder_id.as_deref())
    {
        log::error!(
            "[DSTU::handlers] dstu_move: FAILED - type={}, id={}, error={}",
            item_type,
            src_id,
            e
        );
        return Err(e.to_string());
    }

    let node = match get_resource_by_type_and_id(&vfs_db, &resource_type, &src_id).await {
        Ok(Some(n)) => n,
        Ok(None) => {
            log::error!(
                "[DSTU::handlers] dstu_move: FAILED - resource not found after move, id={}",
                src_id
            );
            return Err(DstuError::not_found(&src).to_string());
        }
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_move: FAILED - get_resource error, id={}, error={}",
                src_id,
                e
            );
            return Err(e);
        }
    };

    // 发射移动事件
    emit_watch_event(
        &window,
        DstuWatchEvent::moved(&src, &node.path, node.clone()),
    );

    log::info!("[DSTU::handlers] dstu_move: moved {} to {}", src, node.path);
    Ok(node)
}

/// 重命名资源
///
/// 更新资源的显示名称/标题。
///
/// ## 参数
/// - `path`: 资源路径（如 `/数学/notes/note_xxx`）
/// - `new_name`: 新名称
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 重命名后的资源节点
#[tauri::command]
pub async fn dstu_rename(
    path: String,
    new_name: String,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DstuNode, String> {
    log::info!(
        "[DSTU::handlers] dstu_rename: path={}, new_name={}",
        path,
        new_name
    );

    // 统一路径解析
    let (resource_type, id) = match extract_resource_info(&path) {
        Ok((rt, rid)) => (rt, rid),
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_rename: FAILED - path={}, error={}",
                path,
                e
            );
            return Err(e.to_string());
        }
    };

    // 根据类型路由到对应 Repo
    let node = match resource_type.as_str() {
        "notes" => {
            // 更新笔记标题
            let updated_note = match VfsNoteRepo::update_note(
                &vfs_db,
                &id,
                VfsUpdateNoteParams {
                    title: Some(new_name.clone()),
                    content: None,
                    tags: None,
                    expected_updated_at: None,
                },
            ) {
                Ok(n) => {
                    log::info!(
                        "[DSTU::handlers] dstu_rename: SUCCESS - type=note, id={}",
                        id
                    );
                    n
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - type=note, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            note_to_dstu_node(&updated_note)
        }
        "exams" => {
            // 更新题目集名称
            let updated_exam = match VfsExamRepo::update_exam_name(&vfs_db, &id, &new_name) {
                Ok(e) => {
                    log::info!(
                        "[DSTU::handlers] dstu_rename: SUCCESS - type=exam, id={}",
                        id
                    );
                    e
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - type=exam, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            exam_to_dstu_node(&updated_exam)
        }
        "essays" => {
            // 更新作文会话标题（注意：essay_sessions 表，不是 essays 表）
            match VfsEssayRepo::update_session(
                &vfs_db,
                &id,
                Some(&new_name),
                None,
                None,
                None,
                None,
            ) {
                Ok(_) => log::info!(
                    "[DSTU::handlers] dstu_rename: updated essay session, id={}",
                    id
                ),
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_rename: FAILED - update_session error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            }

            // 重新获取会话
            let session = match VfsEssayRepo::get_session(&vfs_db, &id) {
                Ok(Some(s)) => s,
                Ok(None) => {
                    log::error!("[DSTU::handlers] dstu_rename: FAILED - essay not found after rename, id={}", id);
                    return Err(DstuError::not_found(&path).to_string());
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - get_session error, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            let essay_path = build_simple_resource_path(&session.id);
            let created_at_str = &session.created_at;
            let created_at = chrono::DateTime::parse_from_rfc3339(created_at_str)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_else(|e| {
                    log::warn!("[DSTU::handlers] Failed to parse created_at '{}': {}, using epoch fallback", created_at_str, e);
                    0_i64
                });
            let updated_at_str = &session.updated_at;
            let updated_at = chrono::DateTime::parse_from_rfc3339(updated_at_str)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_else(|e| {
                    log::warn!("[DSTU::handlers] Failed to parse updated_at '{}': {}, using epoch fallback", updated_at_str, e);
                    created_at
                });

            DstuNode::resource(
                &session.id,
                &essay_path,
                &session.title,
                DstuNodeType::Essay,
                &session.id,
            )
            .with_timestamps(created_at, updated_at)
            .with_metadata(serde_json::json!({
                "totalRounds": session.total_rounds,
                "isFavorite": session.is_favorite,
            }))
        }
        "translations" => {
            // 更新翻译标题
            let updated_translation =
                match VfsTranslationRepo::update_title(&vfs_db, &id, &new_name) {
                    Ok(t) => {
                        log::info!(
                            "[DSTU::handlers] dstu_rename: SUCCESS - type=translation, id={}",
                            id
                        );
                        t
                    }
                    Err(e) => {
                        log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - type=translation, id={}, error={}",
                        id,
                        e
                    );
                        return Err(e.to_string());
                    }
                };

            translation_to_dstu_node(&updated_translation)
        }
        "textbooks" => {
            // 更新教材文件名
            let updated_textbook = match VfsTextbookRepo::update_file_name(&vfs_db, &id, &new_name)
            {
                Ok(t) => {
                    log::info!(
                        "[DSTU::handlers] dstu_rename: SUCCESS - type=textbook, id={}",
                        id
                    );
                    t
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - type=textbook, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            textbook_to_dstu_node(&updated_textbook)
        }
        "files" => {
            // 更新文件名
            let updated_file = match VfsFileRepo::update_file_name(&vfs_db, &id, &new_name) {
                Ok(f) => {
                    log::info!(
                        "[DSTU::handlers] dstu_rename: SUCCESS - type=file, id={}",
                        id
                    );
                    f
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - type=file, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            file_to_dstu_node(&updated_file)
        }
        "images" => {
            // 图片通过 VfsFileRepo 管理
            let updated_file = match VfsFileRepo::update_file_name(&vfs_db, &id, &new_name) {
                Ok(f) => {
                    log::info!(
                        "[DSTU::handlers] dstu_rename: SUCCESS - type=image, id={}",
                        id
                    );
                    f
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - type=image, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            file_to_dstu_node(&updated_file)
        }
        "mindmaps" => {
            // 更新知识导图标题
            let update_params = VfsUpdateMindMapParams {
                title: Some(new_name.clone()),
                description: None,
                content: None,
                default_view: None,
                theme: None,
                settings: None,
                expected_updated_at: None,
                version_source: None,
            };
            let updated_mindmap = match VfsMindMapRepo::update_mindmap(&vfs_db, &id, update_params)
            {
                Ok(m) => {
                    log::info!(
                        "[DSTU::handlers] dstu_rename: SUCCESS - type=mindmap, id={}",
                        id
                    );
                    m
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - type=mindmap, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            mindmap_to_dstu_node(&updated_mindmap)
        }
        "folders" => {
            // 获取文件夹
            let mut folder = match VfsFolderRepo::get_folder(&vfs_db, &id) {
                Ok(Some(f)) => f,
                Ok(None) => {
                    log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - folder not found, id={}",
                        id
                    );
                    return Err(DstuError::not_found(&path).to_string());
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_rename: FAILED - get_folder error, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 更新文件夹标题
            folder.title = new_name.clone();

            // 保存更新
            match VfsFolderRepo::update_folder(&vfs_db, &folder) {
                Ok(_) => {
                    log::info!(
                        "[DSTU::handlers] dstu_rename: SUCCESS - type=folder, id={}",
                        id
                    );
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_rename: FAILED - update_folder error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            }

            // 构建 DstuNode
            let folder_path = build_simple_resource_path(&folder.id);
            DstuNode::folder(&folder.id, &folder_path, &folder.title)
                .with_timestamps(folder.created_at, folder.updated_at)
                .with_metadata(serde_json::json!({
                    "isExpanded": folder.is_expanded,
                    "isFavorite": folder.is_favorite,
                    "icon": folder.icon,
                    "color": folder.color,
                }))
        }
        _ => {
            return Err(DstuError::invalid_node_type(resource_type).to_string());
        }
    };

    // 27-DSTU统一虚拟路径架构改造：重命名后清空 cached_path
    // 因为 cached_path 中包含资源标题，重命名后需要重新计算
    if let Err(e) = vfs_db.get_conn_safe().and_then(|conn| {
        conn.execute(
            "UPDATE folder_items SET cached_path = NULL WHERE item_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| crate::vfs::error::VfsError::Database(e.to_string()))
    }) {
        log::warn!(
            "[DSTU::handlers] dstu_rename: failed to clear cached_path for {}: {}",
            id,
            e
        );
    }

    // 发射更新事件
    emit_watch_event(&window, DstuWatchEvent::updated(&path, node.clone()));

    log::info!(
        "[DSTU::handlers] dstu_rename: renamed {} to {} (cached_path cleared)",
        path,
        new_name
    );
    Ok(node)
}

/// 复制资源
///
/// 将资源复制到另一个路径。
///
/// ## 参数
/// - `src`: 源路径
/// - `dst`: 目标路径
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 复制后的新资源节点
#[tauri::command]
pub async fn dstu_copy(
    src: String,
    dst: String,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DstuNode, String> {
    log::info!("[DSTU::handlers] dstu_copy: src={}, dst={}", src, dst);

    // 统一路径解析
    let (src_resource_type, src_id) = match extract_resource_info(&src) {
        Ok((rt, rid)) => (rt, rid),
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_copy: FAILED - src={}, error={}",
                src,
                e
            );
            return Err(e.to_string());
        }
    };

    // 解析目标文件夹 ID（参考 dstu_move 的实现）
    let dest_folder_id: Option<String> = if dst.trim().is_empty() || dst.trim() == "/" {
        None // 根目录
    } else {
        let (dst_type, dst_id) = match extract_resource_info(&dst) {
            Ok((rt, rid)) => (rt, rid),
            Err(e) => {
                log::error!(
                    "[DSTU::handlers] dstu_copy: FAILED - invalid dst path, error={}",
                    e
                );
                return Err(format!("Invalid destination path: {}", e));
            }
        };
        if dst_type != "folders" {
            return Err("Destination must be a folder".to_string());
        }
        Some(dst_id)
    };

    // 复制 = 创建新资源并复制内容
    let node = match src_resource_type.as_str() {
        "notes" => {
            // 获取原笔记
            let note = match VfsNoteRepo::get_note(&vfs_db, &src_id) {
                Ok(Some(n)) => n,
                Ok(None) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - note not found, id={}",
                        src_id
                    );
                    return Err(DstuError::not_found(&src).to_string());
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - get_note error, id={}, error={}",
                        src_id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            let content = match VfsNoteRepo::get_note_content(&vfs_db, &src_id) {
                Ok(Some(c)) => c,
                Ok(None) => String::new(),
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_copy: FAILED - get_note_content error, id={}, error={}", src_id, e);
                    return Err(e.to_string());
                }
            };

            // 创建新笔记（复制）
            let new_note = match VfsNoteRepo::create_note(
                &vfs_db,
                VfsCreateNoteParams {
                    title: format!("{} (副本)", note.title),
                    content,
                    tags: note.tags.clone(),
                },
            ) {
                Ok(n) => {
                    log::info!(
                        "[DSTU::handlers] dstu_copy: SUCCESS - created copy, id={}",
                        n.id
                    );
                    n
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - create_note error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 如果指定了目标文件夹，将新资源添加到文件夹
            if let Some(ref folder_id) = dest_folder_id {
                let folder_item = VfsFolderItem::new(
                    Some(folder_id.clone()),
                    "note".to_string(),
                    new_note.id.clone(),
                );
                if let Err(e) = VfsFolderRepo::add_item_to_folder(&vfs_db, &folder_item) {
                    log::warn!(
                        "[DSTU::handlers] dstu_copy: failed to add note to folder {}: {}",
                        folder_id,
                        e
                    );
                }
            }

            note_to_dstu_node(&new_note)
        }
        "textbooks" => {
            // 获取原教材
            let textbook = match VfsTextbookRepo::get_textbook(&vfs_db, &src_id) {
                Ok(Some(t)) => t,
                Ok(None) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - textbook not found, id={}",
                        src_id
                    );
                    return Err(DstuError::not_found(&src).to_string());
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - get_textbook error, id={}, error={}",
                        src_id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 教材复制需要复制 blob 引用
            // 由于 blob 是内容寻址的（sha256），我们需要生成新的 sha256 或标记为副本
            // 为了简化，我们创建一个新的文件名但指向同一个 blob
            let new_file_name = format!("{} (副本)", textbook.file_name.trim_end_matches(".pdf"));
            let new_file_name = if textbook.file_name.ends_with(".pdf") {
                format!("{}.pdf", new_file_name)
            } else {
                new_file_name
            };

            // 使用新的 sha256（在原 sha256 基础上添加时间戳以确保唯一）
            let new_sha256 = format!(
                "{}_{}",
                textbook.sha256,
                chrono::Utc::now().timestamp_millis()
            );

            let new_textbook = match VfsTextbookRepo::create_textbook(
                &vfs_db,
                &new_sha256,
                &new_file_name,
                textbook.size,
                textbook.blob_hash.as_deref(),
                textbook.original_path.as_deref(),
            ) {
                Ok(t) => {
                    log::info!(
                        "[DSTU::handlers] dstu_copy: SUCCESS - created textbook copy, id={}",
                        t.id
                    );
                    t
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - create_textbook error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 如果指定了目标文件夹，将新资源添加到文件夹
            if let Some(ref folder_id) = dest_folder_id {
                let folder_item = VfsFolderItem::new(
                    Some(folder_id.clone()),
                    "textbook".to_string(),
                    new_textbook.id.clone(),
                );
                if let Err(e) = VfsFolderRepo::add_item_to_folder(&vfs_db, &folder_item) {
                    log::warn!(
                        "[DSTU::handlers] dstu_copy: failed to add textbook to folder {}: {}",
                        folder_id,
                        e
                    );
                }
            }

            textbook_to_dstu_node(&new_textbook)
        }
        "translations" => {
            // 获取原翻译
            let translation = match VfsTranslationRepo::get_translation(&vfs_db, &src_id) {
                Ok(Some(t)) => t,
                Ok(None) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - translation not found, id={}",
                        src_id
                    );
                    return Err(DstuError::not_found(&src).to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_copy: FAILED - get_translation error, id={}, error={}", src_id, e);
                    return Err(e.to_string());
                }
            };

            // 获取翻译内容
            let content = match VfsTranslationRepo::get_translation_content(&vfs_db, &src_id) {
                Ok(Some(c)) => c,
                Ok(None) => String::from(r#"{"source":"","translated":""}"#),
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_copy: FAILED - get_translation_content error, id={}, error={}", src_id, e);
                    return Err(e.to_string());
                }
            };

            // 解析内容 JSON
            let content_json: Value = serde_json::from_str(&content)
                .unwrap_or_else(|_| serde_json::json!({"source": "", "translated": ""}));
            let source = content_json
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let translated = content_json
                .get("translated")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // 创建新翻译
            let new_title = translation.title.map(|t| format!("{} (副本)", t));
            let new_translation = match VfsTranslationRepo::create_translation(
                &vfs_db,
                crate::vfs::types::VfsCreateTranslationParams {
                    title: new_title,
                    source,
                    translated,
                    src_lang: translation.src_lang.clone(),
                    tgt_lang: translation.tgt_lang.clone(),
                    engine: translation.engine.clone(),
                    model: translation.model.clone(),
                },
            ) {
                Ok(t) => {
                    log::info!(
                        "[DSTU::handlers] dstu_copy: SUCCESS - created translation copy, id={}",
                        t.id
                    );
                    t
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - create_translation error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 如果指定了目标文件夹，将新资源添加到文件夹
            if let Some(ref folder_id) = dest_folder_id {
                let folder_item = VfsFolderItem::new(
                    Some(folder_id.clone()),
                    "translation".to_string(),
                    new_translation.id.clone(),
                );
                if let Err(e) = VfsFolderRepo::add_item_to_folder(&vfs_db, &folder_item) {
                    log::warn!(
                        "[DSTU::handlers] dstu_copy: failed to add translation to folder {}: {}",
                        folder_id,
                        e
                    );
                }
            }

            translation_to_dstu_node(&new_translation)
        }
        "exams" => {
            // 获取原题目集
            let exam = match VfsExamRepo::get_exam_sheet(&vfs_db, &src_id) {
                Ok(Some(e)) => e,
                Ok(None) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - exam not found, id={}",
                        src_id
                    );
                    return Err(DstuError::not_found(&src).to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_copy: FAILED - get_exam_sheet error, id={}, error={}", src_id, e);
                    return Err(e.to_string());
                }
            };

            // 创建新题目集
            let new_exam_name = exam.exam_name.map(|n| format!("{} (副本)", n));
            let new_temp_id = format!("copy_{}", nanoid::nanoid!(10));

            let new_exam = match VfsExamRepo::create_exam_sheet(
                &vfs_db,
                VfsCreateExamSheetParams {
                    exam_name: new_exam_name,
                    temp_id: new_temp_id,
                    metadata_json: exam.metadata_json.clone(),
                    preview_json: exam.preview_json.clone(),
                    status: exam.status.clone(),
                    folder_id: dest_folder_id.clone(),
                },
            ) {
                Ok(e) => {
                    log::info!(
                        "[DSTU::handlers] dstu_copy: SUCCESS - created exam copy, id={}",
                        e.id
                    );
                    e
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - create_exam_sheet error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 如果指定了目标文件夹，将新资源添加到文件夹
            if let Some(ref folder_id) = dest_folder_id {
                let folder_item = VfsFolderItem::new(
                    Some(folder_id.clone()),
                    "exam".to_string(),
                    new_exam.id.clone(),
                );
                if let Err(e) = VfsFolderRepo::add_item_to_folder(&vfs_db, &folder_item) {
                    log::warn!(
                        "[DSTU::handlers] dstu_copy: failed to add exam to folder {}: {}",
                        folder_id,
                        e
                    );
                }
            }

            exam_to_dstu_node(&new_exam)
        }
        "essays" => {
            // essays 使用 session 模型
            let session = match VfsEssayRepo::get_session(&vfs_db, &src_id) {
                Ok(Some(s)) => s,
                Ok(None) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - essay session not found, id={}",
                        src_id
                    );
                    return Err(DstuError::not_found(&src).to_string());
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - get_session error, id={}, error={}",
                        src_id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 创建新会话（只复制会话元数据，不复制关联的作文轮次）
            let new_session = match VfsEssayRepo::create_session(
                &vfs_db,
                VfsCreateEssaySessionParams {
                    title: format!("{} (副本)", session.title),
                    essay_type: session.essay_type.clone(),
                    grade_level: session.grade_level.clone(),
                    custom_prompt: session.custom_prompt.clone(),
                },
            ) {
                Ok(s) => {
                    log::info!(
                        "[DSTU::handlers] dstu_copy: SUCCESS - created essay session copy, id={}",
                        s.id
                    );
                    s
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - create_session error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 如果指定了目标文件夹，将新资源添加到文件夹
            if let Some(ref folder_id) = dest_folder_id {
                let folder_item = VfsFolderItem::new(
                    Some(folder_id.clone()),
                    "essay".to_string(),
                    new_session.id.clone(),
                );
                if let Err(e) = VfsFolderRepo::add_item_to_folder(&vfs_db, &folder_item) {
                    log::warn!(
                        "[DSTU::handlers] dstu_copy: failed to add essay to folder {}: {}",
                        folder_id,
                        e
                    );
                }
            }

            session_to_dstu_node(&new_session)
        }
        "files" | "images" => {
            // files 和 images 共享 VfsFileRepo
            let file = match VfsFileRepo::get_file(&vfs_db, &src_id) {
                Ok(Some(f)) => f,
                Ok(None) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - file not found, id={}",
                        src_id
                    );
                    return Err(DstuError::not_found(&src).to_string());
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - get_file error, id={}, error={}",
                        src_id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 创建新文件记录（指向同一个 blob）
            let new_file_name = format!("{} (副本)", file.file_name);
            // 使用新的 sha256 以确保唯一性
            let new_sha256 = format!("{}_{}", file.sha256, chrono::Utc::now().timestamp_millis());

            let new_file = match VfsFileRepo::create_file(
                &vfs_db,
                &new_sha256,
                &new_file_name,
                file.size,
                &file.file_type,
                file.mime_type.as_deref(),
                file.blob_hash.as_deref(),
                file.original_path.as_deref(),
            ) {
                Ok(f) => {
                    log::info!(
                        "[DSTU::handlers] dstu_copy: SUCCESS - created file copy, id={}",
                        f.id
                    );
                    f
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - create_file error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 如果指定了目标文件夹，将新资源添加到文件夹
            if let Some(ref folder_id) = dest_folder_id {
                let folder_item = VfsFolderItem::new(
                    Some(folder_id.clone()),
                    "file".to_string(),
                    new_file.id.clone(),
                );
                if let Err(e) = VfsFolderRepo::add_item_to_folder(&vfs_db, &folder_item) {
                    log::warn!(
                        "[DSTU::handlers] dstu_copy: failed to add file to folder {}: {}",
                        folder_id,
                        e
                    );
                }
            }

            file_to_dstu_node(&new_file)
        }
        "mindmaps" => {
            // 获取原知识导图
            let mindmap = match VfsMindMapRepo::get_mindmap(&vfs_db, &src_id) {
                Ok(Some(m)) => m,
                Ok(None) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - mindmap not found, id={}",
                        src_id
                    );
                    return Err(DstuError::not_found(&src).to_string());
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - get_mindmap error, id={}, error={}",
                        src_id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            // 获取导图内容
            let content = match VfsMindMapRepo::get_mindmap_content(&vfs_db, &src_id) {
                Ok(Some(c)) => c,
                Ok(None) => {
                    r#"{"version":"1.0","root":{"id":"root","text":"根节点","children":[]}}"#
                        .to_string()
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_copy: FAILED - get_mindmap_content error, id={}, error={}", src_id, e);
                    return Err(e.to_string());
                }
            };

            // M-078 修复：使用 create_mindmap_in_folder（事务版），确保导图创建和 folder 关联在同一事务中
            let new_mindmap = match VfsMindMapRepo::create_mindmap_in_folder(
                &vfs_db,
                VfsCreateMindMapParams {
                    title: format!("{} (副本)", mindmap.title),
                    description: mindmap.description.clone(),
                    content,
                    default_view: mindmap.default_view.clone(),
                    theme: mindmap.theme.clone(),
                },
                dest_folder_id.as_deref(),
            ) {
                Ok(m) => {
                    log::info!(
                        "[DSTU::handlers] dstu_copy: SUCCESS - created mindmap copy, id={}",
                        m.id
                    );
                    m
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - create_mindmap error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            mindmap_to_dstu_node(&new_mindmap)
        }
        "folders" => {
            // 检查循环引用：目标文件夹不能是源文件夹或其子文件夹
            if let Some(ref dest_id) = dest_folder_id {
                if is_subfolder_of(&vfs_db, dest_id, &src_id)? {
                    log::error!(
                        "[DSTU::handlers] dstu_copy: FAILED - circular reference detected, src={}, dest={}",
                        src_id, dest_id
                    );
                    return Err("Cannot copy a folder into itself or its subfolder".to_string());
                }
            }
            // 递归复制文件夹
            copy_folder_recursive(&vfs_db, &src_id, dest_folder_id.clone(), 0)?
        }
        _ => {
            return Err(DstuError::invalid_node_type(src_resource_type).to_string());
        }
    };

    // 发射创建事件
    emit_watch_event(&window, DstuWatchEvent::created(&node.path, node.clone()));

    log::info!(
        "[DSTU::handlers] dstu_copy: copied {} to {}",
        src,
        node.path
    );
    Ok(node)
}

/// 检查目标文件夹是否是源文件夹或其子文件夹（循环引用检测）
///
/// ## 参数
/// - `vfs_db`: VFS 数据库实例
/// - `potential_child`: 潜在的子文件夹 ID（目标文件夹）
/// - `potential_parent`: 潜在的父文件夹 ID（源文件夹）
///
/// ## 返回
/// - `Ok(true)`: 目标是源文件夹或其子文件夹
/// - `Ok(false)`: 目标不是源文件夹的子文件夹
fn is_subfolder_of(
    vfs_db: &Arc<VfsDatabase>,
    potential_child: &str,
    potential_parent: &str,
) -> Result<bool, String> {
    // 如果目标和源相同，则是循环引用
    if potential_child == potential_parent {
        return Ok(true);
    }

    // 遍历 potential_child 的所有父文件夹，检查是否包含 potential_parent
    let mut current_id = potential_child.to_string();
    let mut depth = 0;
    const MAX_DEPTH: i32 = 100;

    while depth < MAX_DEPTH {
        // 获取当前文件夹的信息
        let folder = match VfsFolderRepo::get_folder(vfs_db, &current_id) {
            Ok(Some(f)) => f,
            Ok(None) => return Ok(false), // 文件夹不存在，到达终点
            Err(e) => return Err(e.to_string()),
        };

        // 获取父文件夹 ID
        let parent_id = match folder.parent_id {
            Some(pid) => pid,
            None => return Ok(false), // 到达根目录，没有找到循环引用
        };

        // 检查父文件夹是否是 potential_parent
        if parent_id == potential_parent {
            return Ok(true);
        }

        current_id = parent_id;
        depth += 1;
    }

    // 超过最大深度，视为没有循环引用
    Ok(false)
}

/// 递归复制文件夹的最大深度限制（防止无限循环）
const MAX_COPY_DEPTH: usize = 10;

/// 递归复制文件夹
///
/// ## 参数
/// - `vfs_db`: VFS 数据库实例
/// - `src_folder_id`: 源文件夹 ID
/// - `dest_parent_id`: 目标父文件夹 ID（None 表示根目录）
/// - `depth`: 当前递归深度
///
/// ## 返回
/// 新创建的文件夹节点
fn copy_folder_recursive(
    vfs_db: &Arc<VfsDatabase>,
    src_folder_id: &str,
    dest_parent_id: Option<String>,
    depth: usize,
) -> Result<DstuNode, String> {
    // 1. 检查递归深度限制
    if depth >= MAX_COPY_DEPTH {
        log::warn!(
            "[DSTU::handlers] copy_folder_recursive: max depth reached, src_folder_id={}",
            src_folder_id
        );
        return Err(format!(
            "文件夹复制深度超出限制（最大 {} 层）",
            MAX_COPY_DEPTH
        ));
    }

    // 2. 获取原文件夹信息
    let folder = match VfsFolderRepo::get_folder(vfs_db, src_folder_id) {
        Ok(Some(f)) => f,
        Ok(None) => {
            log::error!(
                "[DSTU::handlers] copy_folder_recursive: folder not found, id={}",
                src_folder_id
            );
            return Err(format!("文件夹不存在: {}", src_folder_id));
        }
        Err(e) => {
            log::error!(
                "[DSTU::handlers] copy_folder_recursive: get_folder error, id={}, error={}",
                src_folder_id,
                e
            );
            return Err(e.to_string());
        }
    };

    // 3. 创建新文件夹（标题加 "(副本)" 后缀，仅在顶层）
    let new_title = if depth == 0 {
        format!("{} (副本)", folder.title)
    } else {
        folder.title.clone()
    };

    let new_folder = crate::vfs::VfsFolder::new(
        new_title,
        dest_parent_id.clone(),
        folder.icon.clone(),
        folder.color.clone(),
    );

    if let Err(e) = VfsFolderRepo::create_folder(vfs_db, &new_folder) {
        log::error!(
            "[DSTU::handlers] copy_folder_recursive: create_folder error, error={}",
            e
        );
        return Err(e.to_string());
    }

    log::info!(
        "[DSTU::handlers] copy_folder_recursive: created folder copy, src={}, new_id={}",
        src_folder_id,
        new_folder.id
    );

    // 4. 获取原文件夹下的子文件夹
    let sub_folders = match VfsFolderRepo::list_folders_by_parent(vfs_db, Some(src_folder_id)) {
        Ok(folders) => folders,
        Err(e) => {
            log::warn!(
                "[DSTU::handlers] copy_folder_recursive: list_folders_by_parent error, id={}, error={}",
                src_folder_id,
                e
            );
            Vec::new()
        }
    };

    // 5. 递归复制子文件夹
    for sub_folder in sub_folders {
        if let Err(e) = copy_folder_recursive(
            vfs_db,
            &sub_folder.id,
            Some(new_folder.id.clone()),
            depth + 1,
        ) {
            log::warn!(
                "[DSTU::handlers] copy_folder_recursive: failed to copy subfolder {}: {}",
                sub_folder.id,
                e
            );
            // 继续复制其他子文件夹
        }
    }

    // 6. 获取原文件夹内的资源项
    let items = match VfsFolderRepo::list_items_by_folder(vfs_db, Some(src_folder_id)) {
        Ok(items) => items,
        Err(e) => {
            log::warn!(
                "[DSTU::handlers] copy_folder_recursive: list_items_by_folder error, id={}, error={}",
                src_folder_id,
                e
            );
            Vec::new()
        }
    };

    // 7. 复制每个资源到新文件夹
    for item in items {
        if let Err(e) = copy_resource_to_folder(vfs_db, &item, &new_folder.id) {
            log::warn!(
                "[DSTU::handlers] copy_folder_recursive: failed to copy item {}/{}: {}",
                item.item_type,
                item.item_id,
                e
            );
            // 继续复制其他资源
        }
    }

    // 8. 返回新文件夹节点
    let folder_path = build_simple_resource_path(&new_folder.id);
    Ok(
        DstuNode::folder(&new_folder.id, &folder_path, &new_folder.title)
            .with_timestamps(new_folder.created_at, new_folder.updated_at)
            .with_metadata(serde_json::json!({
                "isExpanded": new_folder.is_expanded,
                "isFavorite": new_folder.is_favorite,
                "icon": new_folder.icon,
                "color": new_folder.color,
            })),
    )
}

/// 复制单个资源到目标文件夹
///
/// ## 参数
/// - `vfs_db`: VFS 数据库实例
/// - `item`: 源文件夹项
/// - `dest_folder_id`: 目标文件夹 ID
fn copy_resource_to_folder(
    vfs_db: &Arc<VfsDatabase>,
    item: &VfsFolderItem,
    dest_folder_id: &str,
) -> Result<(), String> {
    match item.item_type.as_str() {
        "note" => {
            // 复制笔记
            let note = match VfsNoteRepo::get_note(vfs_db, &item.item_id) {
                Ok(Some(n)) => n,
                Ok(None) => return Err(format!("笔记不存在: {}", item.item_id)),
                Err(e) => return Err(e.to_string()),
            };

            let content = match VfsNoteRepo::get_note_content(vfs_db, &item.item_id) {
                Ok(Some(c)) => c,
                Ok(None) => String::new(),
                Err(e) => return Err(e.to_string()),
            };

            let new_note = match VfsNoteRepo::create_note(
                vfs_db,
                VfsCreateNoteParams {
                    title: note.title.clone(),
                    content,
                    tags: note.tags.clone(),
                },
            ) {
                Ok(n) => n,
                Err(e) => return Err(e.to_string()),
            };

            // 添加到目标文件夹
            let folder_item = VfsFolderItem::new(
                Some(dest_folder_id.to_string()),
                "note".to_string(),
                new_note.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder(vfs_db, &folder_item).map_err(|e| e.to_string())?;

            log::debug!(
                "[DSTU::handlers] copy_resource_to_folder: copied note {} -> {}",
                item.item_id,
                new_note.id
            );
        }
        "textbook" => {
            // 复制教材
            let textbook = match VfsTextbookRepo::get_textbook(vfs_db, &item.item_id) {
                Ok(Some(t)) => t,
                Ok(None) => return Err(format!("教材不存在: {}", item.item_id)),
                Err(e) => return Err(e.to_string()),
            };

            let new_sha256 = format!(
                "{}_{}",
                textbook.sha256,
                chrono::Utc::now().timestamp_millis()
            );

            let new_textbook = match VfsTextbookRepo::create_textbook(
                vfs_db,
                &new_sha256,
                &textbook.file_name,
                textbook.size,
                textbook.blob_hash.as_deref(),
                textbook.original_path.as_deref(),
            ) {
                Ok(t) => t,
                Err(e) => return Err(e.to_string()),
            };

            let folder_item = VfsFolderItem::new(
                Some(dest_folder_id.to_string()),
                "textbook".to_string(),
                new_textbook.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder(vfs_db, &folder_item).map_err(|e| e.to_string())?;

            log::debug!(
                "[DSTU::handlers] copy_resource_to_folder: copied textbook {} -> {}",
                item.item_id,
                new_textbook.id
            );
        }
        "translation" => {
            // 复制翻译
            let translation = match VfsTranslationRepo::get_translation(vfs_db, &item.item_id) {
                Ok(Some(t)) => t,
                Ok(None) => return Err(format!("翻译不存在: {}", item.item_id)),
                Err(e) => return Err(e.to_string()),
            };

            let content = match VfsTranslationRepo::get_translation_content(vfs_db, &item.item_id) {
                Ok(Some(c)) => c,
                Ok(None) => String::from(r#"{"source":"","translated":""}"#),
                Err(e) => return Err(e.to_string()),
            };

            let content_json: Value = serde_json::from_str(&content)
                .unwrap_or_else(|_| serde_json::json!({"source": "", "translated": ""}));
            let source = content_json
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let translated = content_json
                .get("translated")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let new_translation = match VfsTranslationRepo::create_translation(
                vfs_db,
                crate::vfs::types::VfsCreateTranslationParams {
                    title: translation.title.clone(),
                    source,
                    translated,
                    src_lang: translation.src_lang.clone(),
                    tgt_lang: translation.tgt_lang.clone(),
                    engine: translation.engine.clone(),
                    model: translation.model.clone(),
                },
            ) {
                Ok(t) => t,
                Err(e) => return Err(e.to_string()),
            };

            let folder_item = VfsFolderItem::new(
                Some(dest_folder_id.to_string()),
                "translation".to_string(),
                new_translation.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder(vfs_db, &folder_item).map_err(|e| e.to_string())?;

            log::debug!(
                "[DSTU::handlers] copy_resource_to_folder: copied translation {} -> {}",
                item.item_id,
                new_translation.id
            );
        }
        "exam" => {
            // 复制题目集
            let exam = match VfsExamRepo::get_exam_sheet(vfs_db, &item.item_id) {
                Ok(Some(e)) => e,
                Ok(None) => return Err(format!("题目集不存在: {}", item.item_id)),
                Err(e) => return Err(e.to_string()),
            };

            let new_temp_id = format!("copy_{}", nanoid::nanoid!(10));

            let new_exam = match VfsExamRepo::create_exam_sheet(
                vfs_db,
                VfsCreateExamSheetParams {
                    exam_name: exam.exam_name.clone(),
                    temp_id: new_temp_id,
                    metadata_json: exam.metadata_json.clone(),
                    preview_json: exam.preview_json.clone(),
                    status: exam.status.clone(),
                    folder_id: Some(dest_folder_id.to_string()),
                },
            ) {
                Ok(e) => e,
                Err(e) => return Err(e.to_string()),
            };

            let folder_item = VfsFolderItem::new(
                Some(dest_folder_id.to_string()),
                "exam".to_string(),
                new_exam.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder(vfs_db, &folder_item).map_err(|e| e.to_string())?;

            log::debug!(
                "[DSTU::handlers] copy_resource_to_folder: copied exam {} -> {}",
                item.item_id,
                new_exam.id
            );
        }
        "essay" => {
            // 复制作文会话
            let session = match VfsEssayRepo::get_session(vfs_db, &item.item_id) {
                Ok(Some(s)) => s,
                Ok(None) => return Err(format!("作文会话不存在: {}", item.item_id)),
                Err(e) => return Err(e.to_string()),
            };

            let new_session = match VfsEssayRepo::create_session(
                vfs_db,
                VfsCreateEssaySessionParams {
                    title: session.title.clone(),
                    essay_type: session.essay_type.clone(),
                    grade_level: session.grade_level.clone(),
                    custom_prompt: session.custom_prompt.clone(),
                },
            ) {
                Ok(s) => s,
                Err(e) => return Err(e.to_string()),
            };

            let folder_item = VfsFolderItem::new(
                Some(dest_folder_id.to_string()),
                "essay".to_string(),
                new_session.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder(vfs_db, &folder_item).map_err(|e| e.to_string())?;

            log::debug!(
                "[DSTU::handlers] copy_resource_to_folder: copied essay {} -> {}",
                item.item_id,
                new_session.id
            );
        }
        "file" | "image" => {
            // 复制文件/图片
            let file = match VfsFileRepo::get_file(vfs_db, &item.item_id) {
                Ok(Some(f)) => f,
                Ok(None) => return Err(format!("文件不存在: {}", item.item_id)),
                Err(e) => return Err(e.to_string()),
            };

            let new_sha256 = format!("{}_{}", file.sha256, chrono::Utc::now().timestamp_millis());

            let new_file = match VfsFileRepo::create_file(
                vfs_db,
                &new_sha256,
                &file.file_name,
                file.size,
                &file.file_type,
                file.mime_type.as_deref(),
                file.blob_hash.as_deref(),
                file.original_path.as_deref(),
            ) {
                Ok(f) => f,
                Err(e) => return Err(e.to_string()),
            };

            let folder_item = VfsFolderItem::new(
                Some(dest_folder_id.to_string()),
                "file".to_string(),
                new_file.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder(vfs_db, &folder_item).map_err(|e| e.to_string())?;

            log::debug!(
                "[DSTU::handlers] copy_resource_to_folder: copied file {} -> {}",
                item.item_id,
                new_file.id
            );
        }
        "mindmap" => {
            // 复制知识导图
            let mindmap =
                match crate::vfs::repos::VfsMindMapRepo::get_mindmap(vfs_db, &item.item_id) {
                    Ok(Some(m)) => m,
                    Ok(None) => return Err(format!("知识导图不存在: {}", item.item_id)),
                    Err(e) => return Err(e.to_string()),
                };

            let content =
                match crate::vfs::repos::VfsMindMapRepo::get_mindmap_content(vfs_db, &item.item_id)
                {
                    Ok(Some(c)) => c,
                    Ok(None) => {
                        r#"{"version":"1.0","root":{"id":"root","text":"根节点","children":[]}}"#
                            .to_string()
                    }
                    Err(e) => return Err(e.to_string()),
                };

            let new_mindmap = match crate::vfs::repos::VfsMindMapRepo::create_mindmap(
                vfs_db,
                VfsCreateMindMapParams {
                    title: mindmap.title.clone(),
                    description: mindmap.description.clone(),
                    content,
                    default_view: mindmap.default_view.clone(),
                    theme: mindmap.theme.clone(),
                },
            ) {
                Ok(m) => m,
                Err(e) => return Err(e.to_string()),
            };

            let folder_item = VfsFolderItem::new(
                Some(dest_folder_id.to_string()),
                "mindmap".to_string(),
                new_mindmap.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder(vfs_db, &folder_item).map_err(|e| e.to_string())?;

            log::debug!(
                "[DSTU::handlers] copy_resource_to_folder: copied mindmap {} -> {}",
                item.item_id,
                new_mindmap.id
            );
        }
        _ => {
            log::warn!(
                "[DSTU::handlers] copy_resource_to_folder: unsupported item type: {}",
                item.item_type
            );
            // 跳过不支持的类型
        }
    }

    Ok(())
}

/// 搜索资源
///
/// 全文搜索资源。
///
/// ## 参数
/// - `query`: 搜索关键词
/// - `options`: 搜索选项（类型过滤、分页等）
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 匹配的资源列表
#[tauri::command]
pub async fn dstu_search(
    query: String,
    options: Option<DstuListOptions>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<DstuNode>, String> {
    log::info!("[DSTU::handlers] dstu_search: query={}", query);

    let options = options.unwrap_or_default();
    let results = search_all(&vfs_db, &query, &options)?;
    log::info!(
        "[DSTU::handlers] dstu_search: found {} results",
        results.len()
    );
    Ok(results)
}

/// 获取资源内容
#[tauri::command]
pub async fn dstu_get_content(
    path: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<String, String> {
    log::info!("[DSTU::handlers] dstu_get_content: path={}", path);

    let (resource_type, id) = match extract_resource_info(&path) {
        Ok((rt, rid)) => (rt, rid),
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_get_content: FAILED - path={}, error={}",
                path,
                e
            );
            return Err(e.to_string());
        }
    };

    get_content_by_type(&vfs_db, &resource_type, &id)
}

/// 获取题目集识别内容（支持多模态模式）
///
/// 用于上下文注入时获取题目集识别的格式化内容。
///
/// ## 参数
/// - `exam_id`: 题目集识别 ID（不需要完整路径，直接传 ID）
/// - `is_multimodal`: 是否为多模态模式
///   - `true`: 返回图片 + 文本交替的 ContentBlock[]
///   - `false`: 返回纯 XML 格式文本
///
/// ## 返回
/// - `Vec<ContentBlock>`: 格式化后的内容块列表
#[tauri::command]
pub async fn dstu_get_exam_content(
    exam_id: String,
    is_multimodal: bool,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<crate::chat_v2::resource_types::ContentBlock>, String> {
    log::info!(
        "[DSTU::handlers] dstu_get_exam_content: exam_id={}, is_multimodal={}",
        exam_id,
        is_multimodal
    );

    // 调用 exam_formatter 进行格式化
    super::exam_formatter::format_exam_for_context(&vfs_db.inner().clone(), &exam_id, is_multimodal)
        .await
}

/// 设置资源元数据
///
/// 更新资源的元数据字段。
///
/// ## 参数
/// - `path`: 资源路径
/// - `metadata`: 元数据（JSON 格式）
/// - `vfs_db`: VFS 数据库实例
#[tauri::command]
pub async fn dstu_set_metadata(
    path: String,
    metadata: Value,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!("[DSTU::handlers] dstu_set_metadata: path={}", path);

    // 🔧 P0-13 修复：支持简单路径（/{id}）和真实路径（/folder/subfolder/id）
    // 原因：DstuNode.path 始终为 /{id}，但原实现只支持 cached_path（真实路径）
    let normalized_path = if path.starts_with('/') {
        path.clone()
    } else {
        format!("/{}", path)
    };

    let (resource_type, id) = match crate::vfs::VfsFolderRepo::get_folder_item_by_cached_path(
        &vfs_db,
        &normalized_path,
    ) {
        Ok(Some(folder_item)) => {
            log::info!("[DSTU::handlers] dstu_set_metadata: found by cached_path, item_type={}, item_id={}", folder_item.item_type, folder_item.item_id);
            // 类型映射：folder_items.item_type 是单数形式，匹配需要复数形式
            let resource_type = match folder_item.item_type.as_str() {
                "note" => "notes",
                "textbook" => "textbooks",
                "exam" => "exams",
                "translation" => "translations",
                "essay" => "essays",
                "image" => "images",
                "file" => "files",
                "folder" => "folders",
                other => {
                    log::warn!(
                        "[DSTU::handlers] dstu_set_metadata: unsupported item_type: {}",
                        other
                    );
                    return Err(DstuError::invalid_node_type(other).to_string());
                }
            };
            (resource_type.to_string(), folder_item.item_id.clone())
        }
        Ok(None) => {
            // 🔧 P0-13 修复：回退到简单路径解析
            // 简单路径格式：/{id}，如 /note_abc123
            let segments: Vec<&str> = normalized_path
                .split('/')
                .filter(|s| !s.is_empty())
                .collect();
            if segments.len() == 1 {
                let id = segments[0].to_string();
                let resource_type = infer_resource_type_from_id(&id);

                if resource_type == "unknown" {
                    log::warn!(
                        "[DSTU::handlers] dstu_set_metadata: FAILED - cannot infer type from id={}",
                        id
                    );
                    return Err("资源不存在".to_string());
                }

                log::info!(
                    "[DSTU::handlers] dstu_set_metadata: fallback to simple path, type={}, id={}",
                    resource_type,
                    id
                );
                (resource_type.to_string(), id)
            } else {
                log::warn!("[DSTU::handlers] dstu_set_metadata: FAILED - resource not found by cached_path, path={}", normalized_path);
                return Err("资源不存在".to_string());
            }
        }
        Err(e) => {
            log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_folder_item_by_cached_path error, path={}, error={}", path, e);
            return Err(e.to_string());
        }
    };

    // 根据类型更新元数据
    // 对于笔记：更新 title 和 tags
    // 对于其他类型：TODO
    let node = match resource_type.as_str() {
        "notes" => {
            // 从 metadata 中提取 title 和 tags
            let title = metadata
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let tags = metadata.get("tags").and_then(|v| {
                v.as_array().map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                })
            });

            let updated_note = match VfsNoteRepo::update_note(
                &vfs_db,
                &id,
                VfsUpdateNoteParams {
                    content: None,
                    title,
                    tags,
                    expected_updated_at: None,
                },
            ) {
                Ok(n) => {
                    log::info!(
                        "[DSTU::handlers] dstu_set_metadata: SUCCESS - type=note, id={}",
                        id
                    );
                    n
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_set_metadata: FAILED - type=note, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            };

            note_to_dstu_node(&updated_note)
        }
        "translations" => {
            // 翻译元数据更新
            // 更新收藏状态
            if let Some(favorite) = metadata.get("isFavorite").and_then(|v| v.as_bool()) {
                match VfsTranslationRepo::set_favorite(&vfs_db, &id, favorite) {
                    Ok(_) => log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set translation favorite={}, id={}",
                        favorite,
                        id
                    ),
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set_favorite error, id={}, error={}", id, e);
                        return Err(e.to_string());
                    }
                }
            }
            // 更新评分
            if let Some(rating) = metadata.get("qualityRating").and_then(|v| v.as_i64()) {
                match VfsTranslationRepo::set_quality_rating(&vfs_db, &id, rating as i32) {
                    Ok(_) => log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set translation rating={}, id={}",
                        rating,
                        id
                    ),
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set_quality_rating error, id={}, error={}", id, e);
                        return Err(e.to_string());
                    }
                }
            }
            // 更新翻译内容（源文本和译文）
            if metadata.get("sourceText").is_some() || metadata.get("translatedText").is_some() {
                let translation = match VfsTranslationRepo::get_translation(&vfs_db, &id) {
                    Ok(Some(t)) => t,
                    Ok(None) => {
                        log::warn!("[DSTU::handlers] dstu_set_metadata: FAILED - translation not found, id={}", id);
                        return Err("资源不存在".to_string());
                    }
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_translation error, id={}, error={}", id, e);
                        return Err(e.to_string());
                    }
                };

                // 更新 resources.data 中的内容
                let source = metadata
                    .get("sourceText")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let translated = metadata
                    .get("translatedText")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let content = serde_json::json!({
                    "source": source,
                    "translated": translated
                });
                let content_str = match serde_json::to_string(&content) {
                    Ok(s) => s,
                    Err(e) => {
                        log::error!(
                            "[DSTU::handlers] dstu_set_metadata: FAILED - json serialize error={}",
                            e
                        );
                        return Err(e.to_string());
                    }
                };

                // 更新 resources 表
                let conn = match vfs_db.get_conn_safe() {
                    Ok(c) => c,
                    Err(e) => {
                        log::error!(
                            "[DSTU::handlers] dstu_set_metadata: FAILED - get_conn error={}",
                            e
                        );
                        return Err(e.to_string());
                    }
                };
                if let Err(e) = conn.execute(
                    "UPDATE resources SET data = ?1 WHERE id = ?2",
                    rusqlite::params![content_str, translation.resource_id],
                ) {
                    log::error!(
                        "[DSTU::handlers] dstu_set_metadata: FAILED - execute error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            }

            // 重新获取并返回节点
            let updated = match VfsTranslationRepo::get_translation(&vfs_db, &id) {
                Ok(Some(t)) => t,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_metadata: FAILED - translation not found after update, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_translation error after update, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            translation_to_dstu_node(&updated)
        }
        "essays" => {
            // 🔧 P0-09 修复: 实现作文元数据更新
            // essay_session_* 与 essay_* 需要分开处理
            if id.starts_with("essay_session_") {
                let title = metadata.get("title").and_then(|v| v.as_str());
                let is_favorite = metadata.get("isFavorite").and_then(|v| v.as_bool());
                let essay_type = metadata.get("essayType").and_then(|v| v.as_str());
                let grade_level = metadata.get("gradeLevel").and_then(|v| v.as_str());
                let custom_prompt = metadata.get("customPrompt").and_then(|v| v.as_str());

                if title.is_none()
                    && is_favorite.is_none()
                    && essay_type.is_none()
                    && grade_level.is_none()
                    && custom_prompt.is_none()
                {
                    return Err(
                        "Essay session metadata update requires at least one field".to_string()
                    );
                }

                if let Err(e) = VfsEssayRepo::update_session(
                    &vfs_db,
                    &id,
                    title,
                    is_favorite,
                    essay_type,
                    grade_level,
                    custom_prompt,
                ) {
                    log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - update_session error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }

                let session = match VfsEssayRepo::get_session(&vfs_db, &id) {
                    Ok(Some(s)) => s,
                    Ok(None) => {
                        log::warn!("[DSTU::handlers] dstu_set_metadata: FAILED - session not found after update, id={}", id);
                        return Err("操作失败".to_string());
                    }
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_session error after update, id={}, error={}", id, e);
                        return Err(e.to_string());
                    }
                };
                session_to_dstu_node(&session)
            } else {
                if let Some(favorite) = metadata.get("isFavorite").and_then(|v| v.as_bool()) {
                    let conn = match vfs_db.get_conn_safe() {
                        Ok(c) => c,
                        Err(e) => {
                            log::error!(
                                "[DSTU::handlers] dstu_set_metadata: FAILED - get_conn error={}",
                                e
                            );
                            return Err(e.to_string());
                        }
                    };
                    let now = chrono::Utc::now()
                        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                        .to_string();
                    if let Err(e) = conn.execute(
                        "UPDATE essays SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
                        rusqlite::params![favorite as i32, now, id],
                    ) {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set essay favorite error={}", e);
                        return Err(e.to_string());
                    }
                    log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set essay favorite={}, id={}",
                        favorite,
                        id
                    );
                }

                if let Some(title) = metadata.get("title").and_then(|v| v.as_str()) {
                    match VfsEssayRepo::update_title(&vfs_db, &id, title) {
                        Ok(_) => log::info!(
                            "[DSTU::handlers] dstu_set_metadata: set essay title={}, id={}",
                            title,
                            id
                        ),
                        Err(e) => {
                            log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - update_title error={}", e);
                            return Err(e.to_string());
                        }
                    }
                }

                if let Some(grade_level) = metadata.get("gradeLevel").and_then(|v| v.as_str()) {
                    let conn = match vfs_db.get_conn_safe() {
                        Ok(c) => c,
                        Err(e) => {
                            log::error!(
                                "[DSTU::handlers] dstu_set_metadata: FAILED - get_conn error={}",
                                e
                            );
                            return Err(e.to_string());
                        }
                    };
                    let now = chrono::Utc::now()
                        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                        .to_string();
                    if let Err(e) = conn.execute(
                        "UPDATE essays SET grade_level = ?1, updated_at = ?2 WHERE id = ?3",
                        rusqlite::params![grade_level, now, id],
                    ) {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set essay grade_level error={}", e);
                        return Err(e.to_string());
                    }
                    log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set essay gradeLevel={}, id={}",
                        grade_level,
                        id
                    );
                }

                if let Some(essay_type) = metadata.get("essayType").and_then(|v| v.as_str()) {
                    let conn = match vfs_db.get_conn_safe() {
                        Ok(c) => c,
                        Err(e) => {
                            log::error!(
                                "[DSTU::handlers] dstu_set_metadata: FAILED - get_conn error={}",
                                e
                            );
                            return Err(e.to_string());
                        }
                    };
                    let now = chrono::Utc::now()
                        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                        .to_string();
                    if let Err(e) = conn.execute(
                        "UPDATE essays SET essay_type = ?1, updated_at = ?2 WHERE id = ?3",
                        rusqlite::params![essay_type, now, id],
                    ) {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set essay essay_type error={}", e);
                        return Err(e.to_string());
                    }
                    log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set essay essayType={}, id={}",
                        essay_type,
                        id
                    );
                }

                let updated = match VfsEssayRepo::get_essay(&vfs_db, &id) {
                    Ok(Some(e)) => e,
                    Ok(None) => {
                        log::warn!("[DSTU::handlers] dstu_set_metadata: FAILED - essay not found after update, id={}", id);
                        return Err("操作失败".to_string());
                    }
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_essay error after update, id={}, error={}", id, e);
                        return Err(e.to_string());
                    }
                };
                essay_to_dstu_node(&updated)
            }
        }
        "textbooks" | "textbook" => {
            // 更新教材阅读进度
            if let Some(reading_progress) = metadata.get("readingProgress") {
                if let Some(page) = reading_progress.get("page").and_then(|v| v.as_i64()) {
                    match VfsTextbookRepo::update_reading_progress(&vfs_db, &id, page as i32) {
                        Ok(_) => log::info!(
                            "[DSTU::handlers] dstu_set_metadata: set textbook last_page={}, id={}",
                            page,
                            id
                        ),
                        Err(e) => {
                            log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set textbook reading_progress error={}", e);
                            return Err(e.to_string());
                        }
                    }
                }
            }
            // 更新收藏状态（支持 favorite 和 isFavorite 两种 key）
            let favorite_value = metadata
                .get("isFavorite")
                .and_then(|v| v.as_bool())
                .or_else(|| metadata.get("favorite").and_then(|v| v.as_bool()));
            if let Some(favorite) = favorite_value {
                match VfsTextbookRepo::set_favorite(&vfs_db, &id, favorite) {
                    Ok(_) => log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set textbook favorite={}, id={}",
                        favorite,
                        id
                    ),
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set textbook favorite error={}", e);
                        return Err(e.to_string());
                    }
                }
            }
            // 更新标题/文件名
            let title_value = metadata
                .get("title")
                .and_then(|v| v.as_str())
                .or_else(|| metadata.get("fileName").and_then(|v| v.as_str()));
            if let Some(title) = title_value {
                match VfsTextbookRepo::update_file_name(&vfs_db, &id, title) {
                    Ok(_) => log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set textbook title={}, id={}",
                        title,
                        id
                    ),
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set textbook title error={}", e);
                        return Err(e.to_string());
                    }
                }
            }
            // 返回更新后的节点
            let updated = match VfsTextbookRepo::get_textbook(&vfs_db, &id) {
                Ok(Some(t)) => t,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_metadata: FAILED - textbook not found after update, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_textbook error after update, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            textbook_to_dstu_node(&updated)
        }
        "exams" | "exam" => {
            // 更新收藏状态
            if let Some(favorite) = metadata.get("isFavorite").and_then(|v| v.as_bool()) {
                match VfsExamRepo::set_favorite(&vfs_db, &id, favorite) {
                    Ok(_) => log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set exam favorite={}, id={}",
                        favorite,
                        id
                    ),
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set exam favorite error={}", e);
                        return Err(e.to_string());
                    }
                }
            }
            // 更新名称
            if let Some(name) = metadata.get("name").and_then(|v| v.as_str()) {
                match VfsExamRepo::update_exam_name(&vfs_db, &id, name) {
                    Ok(_) => log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set exam name={}, id={}",
                        name,
                        id
                    ),
                    Err(e) => {
                        log::error!(
                            "[DSTU::handlers] dstu_set_metadata: FAILED - set exam name error={}",
                            e
                        );
                        return Err(e.to_string());
                    }
                }
            }
            // 返回更新后的节点
            let updated = match VfsExamRepo::get_exam_sheet(&vfs_db, &id) {
                Ok(Some(e)) => e,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_metadata: FAILED - exam not found after update, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_exam_sheet error after update, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            exam_to_dstu_node(&updated)
        }
        "files" | "file" | "images" | "image" => {
            // 更新收藏状态
            if let Some(favorite) = metadata.get("isFavorite").and_then(|v| v.as_bool()) {
                match VfsFileRepo::set_favorite(&vfs_db, &id, favorite) {
                    Ok(_) => log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set file favorite={}, id={}",
                        favorite,
                        id
                    ),
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set file favorite error={}", e);
                        return Err(e.to_string());
                    }
                }
            }
            // 更新文件名
            if let Some(file_name) = metadata.get("fileName").and_then(|v| v.as_str()) {
                match VfsFileRepo::update_file_name(&vfs_db, &id, file_name) {
                    Ok(_) => log::info!(
                        "[DSTU::handlers] dstu_set_metadata: set file name={}, id={}",
                        file_name,
                        id
                    ),
                    Err(e) => {
                        log::error!(
                            "[DSTU::handlers] dstu_set_metadata: FAILED - set file name error={}",
                            e
                        );
                        return Err(e.to_string());
                    }
                }
            }
            // 返回更新后的节点
            let updated = match VfsFileRepo::get_file(&vfs_db, &id) {
                Ok(Some(f)) => f,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_metadata: FAILED - file not found after update, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_file error after update, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            file_to_dstu_node(&updated)
        }
        "mindmaps" | "mindmap" => {
            let mut updated_any = false;

            // 更新收藏状态
            if let Some(favorite) = metadata.get("isFavorite").and_then(|v| v.as_bool()) {
                match VfsMindMapRepo::set_favorite(&vfs_db, &id, favorite) {
                    Ok(_) => {
                        log::info!(
                            "[DSTU::handlers] dstu_set_metadata: set mindmap favorite={}, id={}",
                            favorite,
                            id
                        );
                        updated_any = true;
                    }
                    Err(e) => {
                        log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - set mindmap favorite error={}", e);
                        return Err(e.to_string());
                    }
                }
            }

            // 更新标题和描述（使用 VfsUpdateMindMapParams）
            let title = metadata
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let description = metadata
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if title.is_some() || description.is_some() {
                let update_params = VfsUpdateMindMapParams {
                    title: title.clone(),
                    description: description.clone(),
                    content: None,
                    default_view: None,
                    theme: None,
                    settings: None,
                    expected_updated_at: None,
                    version_source: None,
                };
                match VfsMindMapRepo::update_mindmap(&vfs_db, &id, update_params) {
                    Ok(_) => {
                        log::info!("[DSTU::handlers] dstu_set_metadata: updated mindmap title={:?}, description={:?}, id={}", title, description, id);
                        updated_any = true;
                    }
                    Err(e) => {
                        log::error!(
                            "[DSTU::handlers] dstu_set_metadata: FAILED - update mindmap error={}",
                            e
                        );
                        return Err(e.to_string());
                    }
                }
            }

            if !updated_any {
                log::warn!("[DSTU::handlers] dstu_set_metadata: no valid metadata fields provided for mindmap, id={}", id);
            }

            // 返回更新后的节点
            let updated = match VfsMindMapRepo::get_mindmap(&vfs_db, &id) {
                Ok(Some(m)) => m,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_metadata: FAILED - mindmap not found after update, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_mindmap error after update, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            mindmap_to_dstu_node(&updated)
        }
        "folders" | "folder" => {
            // 获取文件夹
            let folder = match crate::vfs::VfsFolderRepo::get_folder(&vfs_db, &id) {
                Ok(Some(f)) => f,
                Ok(None) => {
                    log::warn!(
                        "[DSTU::handlers] dstu_set_metadata: FAILED - folder not found, id={}",
                        id
                    );
                    return Err(DstuError::not_found(&path).to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - get_folder error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };

            let mut updated_folder = folder.clone();
            let mut has_changes = false;

            // 处理 isFavorite / favorite
            if let Some(is_favorite) = metadata
                .get("isFavorite")
                .or(metadata.get("favorite"))
                .and_then(|v| v.as_bool())
            {
                updated_folder.is_favorite = is_favorite;
                has_changes = true;
                log::info!(
                    "[DSTU::handlers] dstu_set_metadata: set folder favorite={}, id={}",
                    is_favorite,
                    id
                );
            }

            // 处理 title
            if let Some(title) = metadata.get("title").and_then(|v| v.as_str()) {
                updated_folder.title = title.to_string();
                has_changes = true;
                log::info!(
                    "[DSTU::handlers] dstu_set_metadata: set folder title={}, id={}",
                    title,
                    id
                );
            }

            // 处理 icon
            if let Some(icon) = metadata.get("icon").and_then(|v| v.as_str()) {
                updated_folder.icon = Some(icon.to_string());
                has_changes = true;
                log::info!(
                    "[DSTU::handlers] dstu_set_metadata: set folder icon={}, id={}",
                    icon,
                    id
                );
            }

            // 处理 color
            if let Some(color) = metadata.get("color").and_then(|v| v.as_str()) {
                updated_folder.color = Some(color.to_string());
                has_changes = true;
                log::info!(
                    "[DSTU::handlers] dstu_set_metadata: set folder color={}, id={}",
                    color,
                    id
                );
            }

            if has_changes {
                if let Err(e) = crate::vfs::VfsFolderRepo::update_folder(&vfs_db, &updated_folder) {
                    log::error!("[DSTU::handlers] dstu_set_metadata: FAILED - update_folder error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            } else {
                log::warn!("[DSTU::handlers] dstu_set_metadata: no valid metadata fields provided for folder, id={}", id);
            }

            // 返回更新后的节点
            let folder_path = build_simple_resource_path(&updated_folder.id);
            DstuNode::folder(&updated_folder.id, &folder_path, &updated_folder.title)
                .with_timestamps(updated_folder.created_at, updated_folder.updated_at)
                .with_metadata(serde_json::json!({
                    "isExpanded": updated_folder.is_expanded,
                    "isFavorite": updated_folder.is_favorite,
                    "icon": updated_folder.icon,
                    "color": updated_folder.color,
                }))
        }
        _ => {
            return Err(DstuError::invalid_node_type(resource_type).to_string());
        }
    };

    // 真实路径架构：若资源标题变化，需要重新计算 cached_path，这里先清空缓存
    if let Err(e) = vfs_db.get_conn_safe().and_then(|conn| {
        conn.execute(
            "UPDATE folder_items SET cached_path = NULL WHERE item_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| crate::vfs::error::VfsError::Database(e.to_string()))
    }) {
        log::warn!(
            "[DSTU::handlers] dstu_set_metadata: failed to clear cached_path for {}: {}",
            id,
            e
        );
    }

    // 发射更新事件
    emit_watch_event(&window, DstuWatchEvent::updated(&path, node));

    log::info!("[DSTU::handlers] dstu_set_metadata: updated {}", path);
    Ok(())
}

// ============================================================================
// 回收站操作：恢复和永久删除
// ============================================================================

/// 恢复已删除的资源
///
/// 将软删除的资源恢复为活动状态。
///
/// ## 参数
/// - `path`: 资源路径
/// - `vfs_db`: VFS 数据库实例
#[tauri::command]
pub async fn dstu_restore(
    path: String,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<DstuNode, String> {
    log::info!("[DSTU::handlers] dstu_restore: path={}", path);

    // 统一路径解析
    let (resource_type, id) = match extract_resource_info(&path) {
        Ok((rt, rid)) => (rt, rid),
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_restore: FAILED - path={}, error={}",
                path,
                e
            );
            return Err(e.to_string());
        }
    };

    // 使用统一的 restore_resource_by_type 处理所有类型
    if let Err(e) = restore_resource_by_type(&vfs_db, &resource_type, &id) {
        log::error!(
            "[DSTU::handlers] dstu_restore: FAILED - type={}, id={}, error={}",
            resource_type,
            id,
            e
        );
        return Err(e);
    }

    // 恢复成功后获取资源节点信息
    let node = match resource_type.as_str() {
        "notes" | "note" => match VfsNoteRepo::get_note(&vfs_db, &id) {
            Ok(Some(n)) => Some(note_to_dstu_node(&n)),
            Ok(None) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: note not found after restore, id={}",
                    id
                );
                None
            }
            Err(e) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: get_note error, id={}, error={}",
                    id,
                    e
                );
                None
            }
        },
        "textbooks" | "textbook" => match VfsTextbookRepo::get_textbook(&vfs_db, &id) {
            Ok(Some(t)) => Some(textbook_to_dstu_node(&t)),
            Ok(None) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: textbook not found after restore, id={}",
                    id
                );
                None
            }
            Err(e) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: get_textbook error, id={}, error={}",
                    id,
                    e
                );
                None
            }
        },
        "translations" | "translation" => match VfsTranslationRepo::get_translation(&vfs_db, &id) {
            Ok(Some(t)) => Some(translation_to_dstu_node(&t)),
            Ok(None) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: translation not found after restore, id={}",
                    id
                );
                None
            }
            Err(e) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: get_translation error, id={}, error={}",
                    id,
                    e
                );
                None
            }
        },
        "exams" | "exam" => match VfsExamRepo::get_exam_sheet(&vfs_db, &id) {
            Ok(Some(e)) => Some(exam_to_dstu_node(&e)),
            Ok(None) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: exam not found after restore, id={}",
                    id
                );
                None
            }
            Err(e) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: get_exam_sheet error, id={}, error={}",
                    id,
                    e
                );
                None
            }
        },
        "essays" | "essay" => {
            if id.starts_with("essay_session_") {
                match VfsEssayRepo::get_session(&vfs_db, &id) {
                    Ok(Some(s)) => Some(session_to_dstu_node(&s)),
                    Ok(None) => {
                        log::warn!("[DSTU::handlers] dstu_restore: essay_session not found after restore, id={}", id);
                        None
                    }
                    Err(e) => {
                        log::warn!(
                            "[DSTU::handlers] dstu_restore: get_session error, id={}, error={}",
                            id,
                            e
                        );
                        None
                    }
                }
            } else {
                match VfsEssayRepo::get_essay(&vfs_db, &id) {
                    Ok(Some(e)) => Some(essay_to_dstu_node(&e)),
                    Ok(None) => {
                        log::warn!(
                            "[DSTU::handlers] dstu_restore: essay not found after restore, id={}",
                            id
                        );
                        None
                    }
                    Err(e) => {
                        log::warn!(
                            "[DSTU::handlers] dstu_restore: get_essay error, id={}, error={}",
                            id,
                            e
                        );
                        None
                    }
                }
            }
        }
        "folders" | "folder" => match VfsFolderRepo::get_folder(&vfs_db, &id) {
            Ok(Some(f)) => Some(DstuNode::folder(&f.id, &path, &f.title)),
            Ok(None) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: folder not found after restore, id={}",
                    id
                );
                None
            }
            Err(e) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: get_folder error, id={}, error={}",
                    id,
                    e
                );
                None
            }
        },
        "images" | "files" | "attachments" | "image" | "file" | "attachment" => {
            match VfsFileRepo::get_file(&vfs_db, &id) {
                Ok(Some(f)) => Some(file_to_dstu_node(&f)),
                Ok(None) => {
                    log::warn!(
                        "[DSTU::handlers] dstu_restore: file not found after restore, id={}",
                        id
                    );
                    None
                }
                Err(e) => {
                    log::warn!(
                        "[DSTU::handlers] dstu_restore: get_file error, id={}, error={}",
                        id,
                        e
                    );
                    None
                }
            }
        }
        "mindmaps" | "mindmap" => match VfsMindMapRepo::get_mindmap(&vfs_db, &id) {
            Ok(Some(m)) => Some(mindmap_to_dstu_node(&m)),
            Ok(None) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: mindmap not found after restore, id={}",
                    id
                );
                None
            }
            Err(e) => {
                log::warn!(
                    "[DSTU::handlers] dstu_restore: get_mindmap error, id={}, error={}",
                    id,
                    e
                );
                None
            }
        },
        _ => None,
    };

    // 发射恢复事件
    emit_watch_event(&window, DstuWatchEvent::restored(&path, node.clone()));

    log::info!("[DSTU::handlers] dstu_restore: restored {}", path);

    // 返回恢复的节点，如果获取失败则返回错误
    match node {
        Some(n) => Ok(n),
        None => Err(format!(
            "Resource restored but failed to retrieve node info: {}",
            path
        )),
    }
}

/// 永久删除资源
///
/// 永久删除资源，不可恢复。
///
/// ## 参数
/// - `path`: 资源路径
/// - `vfs_db`: VFS 数据库实例
#[tauri::command]
pub async fn dstu_purge(
    path: String,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<(), String> {
    log::info!("[DSTU::handlers] dstu_purge: path={}", path);

    // 统一路径解析
    let (resource_type, id) = match extract_resource_info(&path) {
        Ok((rt, rid)) => (rt, rid),
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_purge: FAILED - path={}, error={}",
                path,
                e
            );
            return Err(e.to_string());
        }
    };

    // ★ P1 防护：验证资源已在回收站，防止对活跃资源执行永久删除
    {
        let trash_check_type = match resource_type.as_str() {
            "notes" | "note" => "note",
            "textbooks" | "textbook" => "textbook",
            "images" | "image" | "files" | "file" | "attachments" | "attachment" => "file",
            "exams" | "exam" => "exam",
            "translations" | "translation" => "translation",
            "essays" | "essay" => "essay",
            "folders" | "folder" => "folder",
            "mindmaps" | "mindmap" => "mindmap",
            _ => "",
        };
        if !trash_check_type.is_empty() && !is_resource_in_trash(&vfs_db, trash_check_type, &id) {
            log::warn!(
                "[DSTU::handlers] dstu_purge: REJECTED - resource not in trash, type={}, id={}",
                resource_type, id
            );
            return Err(format!(
                "资源 {} (type={}) 不在回收站中，无法永久删除。请先将其移到回收站。",
                id, resource_type
            ));
        }
    }

    // ★ P1 修复：在 purge 之前查找 resource_id（purge 会删除数据库记录）
    let resource_id: Option<String> = vfs_db.get_conn_safe().ok().and_then(|conn| {
        let sql = match resource_type.as_str() {
            "notes" | "note" => Some("SELECT resource_id FROM notes WHERE id = ?1"),
            "textbooks" | "textbook" | "images" | "image" | "files" | "file" | "attachments" | "attachment" =>
                Some("SELECT resource_id FROM files WHERE id = ?1"),
            "exams" | "exam" => Some("SELECT resource_id FROM exam_sheets WHERE id = ?1"),
            "translations" | "translation" => Some("SELECT resource_id FROM translations WHERE id = ?1"),
            "mindmaps" | "mindmap" => Some("SELECT resource_id FROM mindmaps WHERE id = ?1"),
            _ => None,
        };
        sql.and_then(|s| {
            conn.query_row(s, rusqlite::params![id], |row| row.get::<_, Option<String>>(0))
                .ok()
                .flatten()
        })
    });

    // 使用统一的 purge_resource_by_type 处理所有类型
    if let Err(e) = purge_resource_by_type(&vfs_db, &resource_type, &id) {
        log::error!(
            "[DSTU::handlers] dstu_purge: FAILED - type={}, id={}, error={}",
            resource_type,
            id,
            e
        );
        return Err(e);
    }

    // 发射永久删除事件
    emit_watch_event(&window, DstuWatchEvent::purged(&path));

    // ★ P1 修复：purge 成功后异步清理向量索引
    if let Some(rid) = resource_id {
        let lance_for_cleanup = Arc::clone(lance_store.inner());
        tokio::spawn(async move {
            let _ = lance_for_cleanup.delete_by_resource("text", &rid).await;
            let _ = lance_for_cleanup.delete_by_resource("multimodal", &rid).await;
            log::info!("[DSTU::handlers] dstu_purge: cleaned up vectors for {}", rid);
        });
    }

    log::info!("[DSTU::handlers] dstu_purge: permanently deleted {}", path);
    Ok(())
}

// ============================================================================
// dstu_set_favorite: 设置资源收藏状态
// ============================================================================

/// 设置资源的收藏状态
///
/// ## 参数
/// - `path`: 资源路径（如 `/数学/notes/note_xxx`）
/// - `favorite`: 是否收藏
/// - `vfs_db`: VFS 数据库实例
///
/// ## 支持的资源类型
/// - notes: 笔记
/// - textbooks: 教材
/// - exams: 题目集
/// - folders: 文件夹
/// - images: 图片附件
/// - files: 文档附件
#[tauri::command]
pub async fn dstu_set_favorite(
    path: String,
    favorite: bool,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<(), String> {
    log::info!(
        "[DSTU::handlers] dstu_set_favorite: path={}, favorite={}",
        path,
        favorite
    );

    // 统一路径解析
    let (resource_type, id) = match extract_resource_info(&path) {
        Ok((rt, rid)) => (rt, rid),
        Err(e) => {
            log::error!(
                "[DSTU::handlers] dstu_set_favorite: FAILED - path={}, error={}",
                path,
                e
            );
            return Err(e.to_string());
        }
    };

    // 根据类型路由到对应 Repo
    let node = match resource_type.as_str() {
        "notes" => {
            match VfsNoteRepo::set_favorite(&vfs_db, &id, favorite) {
                Ok(_) => log::info!(
                    "[DSTU::handlers] dstu_set_favorite: SUCCESS - type=note, id={}, favorite={}",
                    id,
                    favorite
                ),
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_set_favorite: FAILED - type=note, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            }
            // 获取更新后的笔记
            let note = match VfsNoteRepo::get_note(&vfs_db, &id) {
                Ok(Some(n)) => n,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_favorite: FAILED - note not found after set_favorite, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - get_note error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            note_to_dstu_node(&note)
        }
        "textbooks" => {
            match VfsTextbookRepo::set_favorite(&vfs_db, &id, favorite) {
                Ok(_) => log::info!("[DSTU::handlers] dstu_set_favorite: SUCCESS - type=textbook, id={}, favorite={}", id, favorite),
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - type=textbook, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            }
            // 获取更新后的教材
            let textbook = match VfsTextbookRepo::get_textbook(&vfs_db, &id) {
                Ok(Some(t)) => t,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_favorite: FAILED - textbook not found after set_favorite, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - get_textbook error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            textbook_to_dstu_node(&textbook)
        }
        "exams" => {
            match VfsExamRepo::set_favorite(&vfs_db, &id, favorite) {
                Ok(_) => log::info!(
                    "[DSTU::handlers] dstu_set_favorite: SUCCESS - type=exam, id={}, favorite={}",
                    id,
                    favorite
                ),
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_set_favorite: FAILED - type=exam, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            }
            // 获取更新后的题目集
            let exam = match VfsExamRepo::get_exam_sheet(&vfs_db, &id) {
                Ok(Some(e)) => e,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_favorite: FAILED - exam not found after set_favorite, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - get_exam_sheet error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            exam_to_dstu_node(&exam)
        }
        "folders" => {
            match VfsFolderRepo::set_favorite(&vfs_db, &id, favorite) {
                Ok(_) => log::info!(
                    "[DSTU::handlers] dstu_set_favorite: SUCCESS - type=folder, id={}, favorite={}",
                    id,
                    favorite
                ),
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_set_favorite: FAILED - type=folder, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            }
            // 获取更新后的文件夹
            let folder = match VfsFolderRepo::get_folder(&vfs_db, &id) {
                Ok(Some(f)) => f,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_favorite: FAILED - folder not found after set_favorite, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - get_folder error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            // 文件夹需要特殊处理，返回folder节点
            let folder_path = format!("/{}", folder.id);
            let created_at = folder.created_at;
            let updated_at = folder.updated_at;

            DstuNode::folder(&folder.id, &folder_path, &folder.title)
                .with_timestamps(created_at, updated_at)
                .with_metadata(serde_json::json!({
                    "isExpanded": folder.is_expanded,
                    "icon": folder.icon,
                    "color": folder.color,
                }))
        }
        "images" | "files" => {
            match VfsFileRepo::set_favorite(&vfs_db, &id, favorite) {
                Ok(_) => log::info!(
                    "[DSTU::handlers] dstu_set_favorite: SUCCESS - type={}, id={}, favorite={}",
                    resource_type,
                    id,
                    favorite
                ),
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_set_favorite: FAILED - type={}, id={}, error={}",
                        resource_type,
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            }
            let file = match VfsFileRepo::get_file(&vfs_db, &id) {
                Ok(Some(f)) => f,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_favorite: FAILED - file not found after set_favorite, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - get_file error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            file_to_dstu_node(&file)
        }
        // 添加 translations 支持
        "translations" => {
            match VfsTranslationRepo::set_favorite(&vfs_db, &id, favorite) {
                Ok(_) => log::info!("[DSTU::handlers] dstu_set_favorite: SUCCESS - type=translation, id={}, favorite={}", id, favorite),
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - type=translation, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            }
            // 获取更新后的翻译
            let translation = match VfsTranslationRepo::get_translation(&vfs_db, &id) {
                Ok(Some(t)) => t,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_favorite: FAILED - translation not found after set_favorite, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - get_translation error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            translation_to_dstu_node(&translation)
        }
        // 添加 essays 支持
        "essays" => {
            // 先尝试作为 essay_session 处理
            match VfsEssayRepo::update_session(&vfs_db, &id, None, Some(favorite), None, None, None)
            {
                Ok(_) => {
                    log::info!("[DSTU::handlers] dstu_set_favorite: SUCCESS - type=essay_session, id={}, favorite={}", id, favorite);
                    // 获取更新后的会话
                    match VfsEssayRepo::get_session(&vfs_db, &id) {
                        Ok(Some(session)) => session_to_dstu_node(&session),
                        Ok(None) => {
                            // 可能是 essay 而不是 essay_session，尝试获取 essay
                            log::warn!("[DSTU::handlers] dstu_set_favorite: session not found, trying essay, id={}", id);
                            match VfsEssayRepo::get_essay(&vfs_db, &id) {
                                Ok(Some(essay)) => essay_to_dstu_node(&essay),
                                Ok(None) => {
                                    log::warn!("[DSTU::handlers] dstu_set_favorite: FAILED - essay not found, id={}", id);
                                    return Err("操作失败".to_string());
                                }
                                Err(e) => {
                                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - get_essay error, id={}, error={}", id, e);
                                    return Err(e.to_string());
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - get_session error, id={}, error={}", id, e);
                            return Err(e.to_string());
                        }
                    }
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_set_favorite: FAILED - type=essay, id={}, error={}",
                        id,
                        e
                    );
                    return Err(e.to_string());
                }
            }
        }
        // 添加 mindmaps 支持
        "mindmaps" => {
            match VfsMindMapRepo::set_favorite(&vfs_db, &id, favorite) {
                Ok(_) => log::info!("[DSTU::handlers] dstu_set_favorite: SUCCESS - type=mindmap, id={}, favorite={}", id, favorite),
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - type=mindmap, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            }
            // 获取更新后的知识导图
            let mindmap = match VfsMindMapRepo::get_mindmap(&vfs_db, &id) {
                Ok(Some(m)) => m,
                Ok(None) => {
                    log::warn!("[DSTU::handlers] dstu_set_favorite: FAILED - mindmap not found after set_favorite, id={}", id);
                    return Err("操作失败".to_string());
                }
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_set_favorite: FAILED - get_mindmap error, id={}, error={}", id, e);
                    return Err(e.to_string());
                }
            };
            mindmap_to_dstu_node(&mindmap)
        }
        _ => {
            return Err(format!(
                "Resource type '{}' does not support favorite operation",
                resource_type
            ));
        }
    };

    // 发射更新事件
    emit_watch_event(&window, DstuWatchEvent::updated(&path, node));

    log::info!(
        "[DSTU::handlers] dstu_set_favorite: set {} to favorite={}",
        path,
        favorite
    );
    Ok(())
}

// ============================================================================
// dstu_list_deleted: 列出已删除的资源（回收站）
// ============================================================================

/// 列出已删除的资源（回收站）
///
/// ## 参数
/// - `resource_type`: 资源类型（"notes" | "textbooks" | "exams" | "translations" | "essays"）
/// - `subject`: 科目过滤（可选，translations 不支持科目过滤）
/// - `limit`: 返回数量限制
/// - `offset`: 分页偏移
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 已删除的资源列表
#[tauri::command]
pub async fn dstu_list_deleted(
    resource_type: String,
    limit: Option<u32>,
    offset: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<DstuNode>, String> {
    log::info!("[DSTU::handlers] dstu_list_deleted: type={}", resource_type);

    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);

    match resource_type.as_str() {
        "notes" => {
            let notes = match VfsNoteRepo::list_deleted_notes(&vfs_db, limit, offset) {
                Ok(n) => n,
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_list_deleted: FAILED - list_deleted_notes error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            let nodes: Vec<DstuNode> = notes
                .into_iter()
                .map(|n| {
                    let path = build_simple_resource_path(&n.id);
                    // 解析时间戳
                    let created_at = chrono::DateTime::parse_from_rfc3339(&n.created_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0);
                    let updated_at = chrono::DateTime::parse_from_rfc3339(&n.updated_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0);

                    DstuNode {
                        id: n.id.clone(),
                        source_id: n.id.clone(),
                        name: n.title.clone(),
                        path,
                        node_type: DstuNodeType::Note,
                        size: None,
                        created_at,
                        updated_at,
                        children: None,
                        child_count: None,
                        resource_id: Some(n.resource_id),
                        resource_hash: None,
                        preview_type: Some("markdown".to_string()),
                        metadata: Some(serde_json::json!({
                            "tags": n.tags,
                            "is_favorite": n.is_favorite,
                            "deleted_at": n.deleted_at,
                        })),
                    }
                })
                .collect();

            Ok(nodes)
        }
        "textbooks" => {
            let textbooks = match VfsTextbookRepo::list_deleted_textbooks(&vfs_db, limit, offset) {
                Ok(t) => t,
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_list_deleted: FAILED - list_deleted_textbooks error={}", e);
                    return Err(e.to_string());
                }
            };

            let nodes: Vec<DstuNode> = textbooks
                .into_iter()
                .map(|tb| {
                    let path = build_simple_resource_path(&tb.id);
                    // 解析时间戳
                    let created_at = chrono::DateTime::parse_from_rfc3339(&tb.created_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0);
                    let updated_at = chrono::DateTime::parse_from_rfc3339(&tb.updated_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0);

                    DstuNode {
                        id: tb.id.clone(),
                        source_id: tb.id.clone(),
                        name: tb.file_name.clone(),
                        path,
                        node_type: DstuNodeType::Textbook,
                        size: Some(tb.size as u64),
                        created_at,
                        updated_at,
                        children: None,
                        child_count: None,
                        resource_id: tb.resource_id,
                        resource_hash: None,
                        preview_type: Some("pdf".to_string()),
                        metadata: Some(serde_json::json!({
                            "file_name": tb.file_name,
                            "page_count": tb.page_count,
                            "isFavorite": tb.is_favorite,
                        })),
                    }
                })
                .collect();

            Ok(nodes)
        }
        "exams" => {
            let exams = match VfsExamRepo::list_deleted_exams(&vfs_db, limit, offset) {
                Ok(e) => e,
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_list_deleted: FAILED - list_deleted_exams error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            };

            let nodes: Vec<DstuNode> = exams
                .into_iter()
                .map(|exam| {
                    let path = build_simple_resource_path(&exam.id);
                    // 解析时间戳
                    let created_at = chrono::DateTime::parse_from_rfc3339(&exam.created_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0);
                    let updated_at = chrono::DateTime::parse_from_rfc3339(&exam.updated_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0);

                    let name = exam
                        .exam_name
                        .clone()
                        .unwrap_or_else(|| "未命名题目集".to_string());
                    let resource_id = exam
                        .resource_id
                        .clone()
                        .unwrap_or_else(|| format!("res_{}", exam.id));

                    DstuNode {
                        id: exam.id.clone(),
                        source_id: exam.id.clone(),
                        name,
                        path,
                        node_type: DstuNodeType::Exam,
                        size: None,
                        created_at,
                        updated_at,
                        children: None,
                        child_count: None,
                        resource_id: Some(resource_id),
                        resource_hash: None,
                        preview_type: Some("exam".to_string()),
                        metadata: Some(serde_json::json!({
                            "status": exam.status,
                            "temp_id": exam.temp_id,
                            "linked_mistake_ids": exam.linked_mistake_ids,
                        })),
                    }
                })
                .collect();

            Ok(nodes)
        }
        "translations" => {
            // 翻译无科目，忽略 subject 参数
            let translations = match VfsTranslationRepo::list_deleted_translations(
                &vfs_db, limit, offset,
            ) {
                Ok(t) => t,
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_list_deleted: FAILED - list_deleted_translations error={}", e);
                    return Err(e.to_string());
                }
            };

            let nodes: Vec<DstuNode> = translations
                .into_iter()
                .map(|tr| {
                    let path = build_simple_resource_path(&tr.id);
                    // 解析时间戳
                    let created_at = chrono::DateTime::parse_from_rfc3339(&tr.created_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0);

                    DstuNode {
                        id: tr.id.clone(),
                        source_id: tr.id.clone(),
                        name: format!("{} → {}", tr.src_lang, tr.tgt_lang),
                        path,
                        node_type: DstuNodeType::Translation,
                        size: None,
                        created_at,
                        updated_at: created_at, // 翻译没有 updated_at，使用 created_at
                        children: None,
                        child_count: None,
                        resource_id: Some(tr.resource_id),
                        resource_hash: None,
                        preview_type: Some("translation".to_string()),
                        metadata: Some(serde_json::json!({
                            "src_lang": tr.src_lang,
                            "tgt_lang": tr.tgt_lang,
                            "engine": tr.engine,
                            "model": tr.model,
                            "is_favorite": tr.is_favorite,
                            "quality_rating": tr.quality_rating,
                        })),
                    }
                })
                .collect();

            Ok(nodes)
        }
        "essays" => {
            // 只支持 essay_session（禁止旧 essay 轮次数据的向后兼容）
            let sessions = match VfsEssayRepo::list_deleted_sessions(&vfs_db, limit, offset) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("[DSTU::handlers] dstu_list_deleted: FAILED - list_deleted_sessions error={}", e);
                    return Err(e.to_string());
                }
            };

            let nodes: Vec<DstuNode> = sessions
                .into_iter()
                .map(|session| {
                    let path = build_simple_resource_path(&session.id);
                    let created_at = chrono::DateTime::parse_from_rfc3339(&session.created_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0);
                    let updated_at = chrono::DateTime::parse_from_rfc3339(&session.updated_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(created_at);

                    DstuNode {
                        id: session.id.clone(),
                        source_id: session.id.clone(),
                        name: session.title.clone(),
                        path,
                        node_type: DstuNodeType::Essay,
                        size: None,
                        created_at,
                        updated_at,
                        children: None,
                        child_count: None,
                        resource_id: Some(session.id.clone()),
                        resource_hash: None,
                        preview_type: Some("essay".to_string()),
                        metadata: Some(serde_json::json!({
                            "essay_type": session.essay_type,
                            "grade_level": session.grade_level,
                            "total_rounds": session.total_rounds,
                            "latest_score": session.latest_score,
                            "is_favorite": session.is_favorite,
                            "is_session": true,
                        })),
                    }
                })
                .collect();

            Ok(nodes)
        }
        _ => Err(format!(
            "Resource type '{}' does not support list_deleted operation",
            resource_type
        )),
    }
}

// ============================================================================
// dstu_purge_all: 清空回收站
// ============================================================================

/// 清空指定类型的回收站（永久删除所有已删除的资源）
///
/// ## 参数
/// - `resource_type`: 资源类型（"notes" | "textbooks"）
/// - `subject`: 科目过滤（可选，仅对 notes 有效）
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 删除的资源数量
#[tauri::command]
pub async fn dstu_purge_all(
    resource_type: String,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<usize, String> {
    log::info!("[DSTU::handlers] dstu_purge_all: type={}", resource_type);

    // ★ P1 修复：在 purge 之前收集所有待清理的 resource_ids
    let resource_ids_to_cleanup: Vec<String> = {
        if let Ok(conn) = vfs_db.get_conn_safe() {
            let sql = match resource_type.as_str() {
                "notes" => Some("SELECT resource_id FROM notes WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL"),
                // purge_deleted_textbooks 使用 status='deleted' 选择，保持一致
                "textbooks" => Some("SELECT resource_id FROM files WHERE status = 'deleted' AND resource_id IS NOT NULL"),
                _ => None,
            };
            if let Some(sql) = sql {
                if let Ok(mut stmt) = conn.prepare(sql) {
                    stmt.query_map([], |row| row.get::<_, String>(0))
                        .map(|rows| rows.flatten().collect())
                        .unwrap_or_default()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    };

    let count = match resource_type.as_str() {
        "notes" => match VfsNoteRepo::purge_deleted_notes(&vfs_db) {
            Ok(c) => {
                log::info!(
                    "[DSTU::handlers] dstu_purge_all: SUCCESS - type=notes, count={}",
                    c
                );
                c
            }
            Err(e) => {
                log::error!(
                    "[DSTU::handlers] dstu_purge_all: FAILED - type=notes, error={}",
                    e
                );
                return Err(e.to_string());
            }
        },
        "textbooks" => {
            // textbooks 目前不支持按 subject 过滤清空
            match VfsTextbookRepo::purge_deleted_textbooks(&vfs_db) {
                Ok(c) => {
                    log::info!(
                        "[DSTU::handlers] dstu_purge_all: SUCCESS - type=textbooks, count={}",
                        c
                    );
                    c
                }
                Err(e) => {
                    log::error!(
                        "[DSTU::handlers] dstu_purge_all: FAILED - type=textbooks, error={}",
                        e
                    );
                    return Err(e.to_string());
                }
            }
        }
        _ => {
            return Err(format!(
                "Resource type '{}' does not support purge_all operation",
                resource_type
            ));
        }
    };

    // 发射批量清除事件
    let path = format!("/{}/_trash", resource_type);
    emit_watch_event(&window, DstuWatchEvent::purged(&path));

    // ★ P1 修复：purge 成功后异步清理向量索引
    if !resource_ids_to_cleanup.is_empty() {
        let lance_for_cleanup = Arc::clone(lance_store.inner());
        tokio::spawn(async move {
            for rid in &resource_ids_to_cleanup {
                let _ = lance_for_cleanup.delete_by_resource("text", rid).await;
                let _ = lance_for_cleanup.delete_by_resource("multimodal", rid).await;
            }
            log::info!(
                "[DSTU::handlers] dstu_purge_all: cleaned up vectors for {} resources",
                resource_ids_to_cleanup.len()
            );
        });
    }

    log::info!(
        "[DSTU::handlers] dstu_purge_all: purged {} {} resources",
        count,
        resource_type
    );
    Ok(count)
}

// ============================================================================
// dstu_delete_many: 批量删除（移到回收站）
// ============================================================================

/// 批量删除资源（软删除，移到回收站）
///
/// ★ CONC-08 修复：添加事务保护，确保批量删除的原子性
/// 所有删除操作在同一事务中执行，部分失败会回滚全部
///
/// ## 参数
/// - `paths`: 资源路径列表
/// - `window`: 窗口实例（用于发射事件）
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 成功删除的数量
#[tauri::command]
pub async fn dstu_delete_many(
    paths: Vec<String>,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<crate::vfs::lance_store::VfsLanceStore>>,
) -> Result<usize, String> {
    log::info!("[DSTU::handlers] dstu_delete_many: {} paths", paths.len());

    // 批量操作数量限制检查
    if paths.len() > MAX_BATCH_SIZE {
        return Err(format!(
            "批量操作数量超出限制：最多允许 {} 个，实际 {} 个",
            MAX_BATCH_SIZE,
            paths.len()
        ));
    }

    if paths.is_empty() {
        return Ok(0);
    }

    // 预解析所有路径，验证有效性
    let mut parsed_items: Vec<(String, String, String)> = Vec::with_capacity(paths.len());
    for path in &paths {
        let (resource_type, id) = match extract_resource_info(path) {
            Ok((rt, rid)) => (rt, rid),
            Err(e) => {
                log::warn!("[DSTU::handlers] Invalid path {}: {}", path, e);
                return Err(format!("无效的资源路径 '{}': {}", path, e));
            }
        };
        parsed_items.push((path.clone(), resource_type, id));
    }

    // ★ P1 修复：在删除前收集 resource_ids，用于事务成功后清理向量索引
    let resource_ids_to_cleanup: Vec<String> = {
        if let Ok(conn) = vfs_db.get_conn_safe() {
            parsed_items.iter().filter_map(|(_, resource_type, id)| {
                let sql = match resource_type.as_str() {
                    "notes" | "note" => Some("SELECT resource_id FROM notes WHERE id = ?1"),
                    "textbooks" | "textbook" | "images" | "image" | "files" | "file" | "attachments" | "attachment" =>
                        Some("SELECT resource_id FROM files WHERE id = ?1"),
                    "exams" | "exam" => Some("SELECT resource_id FROM exam_sheets WHERE id = ?1"),
                    "translations" | "translation" => Some("SELECT resource_id FROM translations WHERE id = ?1"),
                    "mindmaps" | "mindmap" => Some("SELECT resource_id FROM mindmaps WHERE id = ?1"),
                    _ => None,
                };
                sql.and_then(|s| {
                    conn.query_row(s, rusqlite::params![id], |row| row.get::<_, Option<String>>(0))
                        .ok()
                        .flatten()
                })
            }).collect()
        } else {
            Vec::new()
        }
    };

    let vfs_db_clone = vfs_db.inner().clone();
    let items_for_delete = parsed_items.clone();

    // 在事务中执行所有删除操作
    let deleted_paths: Vec<String> = tokio::task::spawn_blocking(move || {
        let conn = vfs_db_clone.get_conn_safe().map_err(|e| e.to_string())?;

        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])
            .map_err(|e| format!("开始事务失败: {}", e))?;

        let transaction_result = (|| -> Result<Vec<String>, String> {
            let mut deleted = Vec::with_capacity(items_for_delete.len());

            for (path, resource_type, id) in &items_for_delete {
                // 使用支持外部事务的删除函数
                delete_resource_by_type_with_conn(&conn, resource_type, id)?;
                deleted.push(path.clone());
            }

            Ok(deleted)
        })();

        match transaction_result {
            Ok(deleted) => {
                conn.execute("COMMIT", [])
                    .map_err(|e| format!("提交事务失败: {}", e))?;
                log::info!(
                    "[DSTU::handlers] dstu_delete_many: 事务提交成功，删除 {} 项资源",
                    deleted.len()
                );
                Ok(deleted)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                log::error!("[DSTU::handlers] dstu_delete_many: 事务回滚，原因: {}", e);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // 事务成功后，发射所有删除事件
    let success_count = deleted_paths.len();
    for path in deleted_paths {
        emit_watch_event(&window, DstuWatchEvent::deleted(&path));
    }

    // ★ P1 修复：事务成功后，异步清理向量索引（不阻塞返回）
    if !resource_ids_to_cleanup.is_empty() {
        let lance_for_cleanup = Arc::clone(lance_store.inner());
        tokio::spawn(async move {
            for rid in &resource_ids_to_cleanup {
                let _ = lance_for_cleanup.delete_by_resource("text", rid).await;
                let _ = lance_for_cleanup.delete_by_resource("multimodal", rid).await;
            }
            log::info!(
                "[DSTU::handlers] dstu_delete_many: cleaned up vectors for {} resources",
                resource_ids_to_cleanup.len()
            );
        });
    }

    log::info!(
        "[DSTU::handlers] dstu_delete_many: deleted {} of {} items (atomic transaction)",
        success_count,
        paths.len()
    );
    Ok(success_count)
}

// ============================================================================
// dstu_restore_many: 批量恢复
// ============================================================================

/// 批量恢复已删除的资源（原子性事务）
///
/// ★ CONC-09 修复：所有恢复操作在单个事务中执行，保证原子性：
/// - 要么全部成功，要么全部失败回滚
/// - 事务成功后才发射恢复事件
///
/// ## 参数
/// - `paths`: 资源路径列表
/// - `window`: 窗口实例（用于发射事件）
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 成功恢复的数量
#[tauri::command]
pub async fn dstu_restore_many(
    paths: Vec<String>,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<usize, String> {
    log::info!("[DSTU::handlers] dstu_restore_many: {} paths", paths.len());

    // 批量操作数量限制检查
    if paths.len() > MAX_BATCH_SIZE {
        return Err(format!(
            "批量操作数量超出限制：最多允许 {} 个，实际 {} 个",
            MAX_BATCH_SIZE,
            paths.len()
        ));
    }

    if paths.is_empty() {
        return Ok(0);
    }

    let vfs_db_clone = vfs_db.inner().clone();
    let paths_clone = paths.clone();

    // 在事务中执行所有恢复操作，收集成功恢复的路径用于后续发射事件
    let restored_paths: Vec<String> = tokio::task::spawn_blocking(move || {
        let conn = vfs_db_clone.get_conn_safe().map_err(|e| e.to_string())?;

        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])
            .map_err(|e| format!("开始事务失败: {}", e))?;

        let transaction_result = (|| -> Result<Vec<String>, String> {
            let mut restored = Vec::with_capacity(paths_clone.len());

            for path in &paths_clone {
                // 统一路径解析
                let (resource_type, id) = match extract_resource_info(path) {
                    Ok((rt, rid)) => (rt, rid),
                    Err(e) => {
                        return Err(format!("路径解析失败 ({}): {}", path, e));
                    }
                };

                // 使用事务版本的 restore_resource_by_type
                restore_resource_by_type_with_conn(&conn, &resource_type, &id)
                    .map_err(|e| format!("恢复失败 (type={}, id={}): {}", resource_type, id, e))?;

                restored.push(path.clone());
            }

            Ok(restored)
        })();

        // 根据结果提交或回滚事务
        match transaction_result {
            Ok(restored) => {
                conn.execute("COMMIT", [])
                    .map_err(|e| format!("提交事务失败: {}", e))?;
                log::info!(
                    "[DSTU::handlers] dstu_restore_many: 事务提交成功，恢复 {} 项资源",
                    restored.len()
                );
                Ok(restored)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                log::error!("[DSTU::handlers] dstu_restore_many: 事务回滚，原因: {}", e);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let success_count = restored_paths.len();

    // 事务成功后，发射所有恢复事件
    for path in &restored_paths {
        emit_watch_event(&window, DstuWatchEvent::restored(path, None));
    }

    log::info!(
        "[DSTU::handlers] dstu_restore_many: SUCCESS - 原子性恢复 {} 项资源",
        success_count
    );
    Ok(success_count)
}

// ============================================================================
// dstu_move_many: 批量移动
// ============================================================================

/// 批量移动资源到指定目录
///
/// ## 参数
/// - `paths`: 源路径列表
/// - `dest_folder`: 目标文件夹路径（如 /数学/notes）
/// - `window`: 窗口实例
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 成功移动的数量
#[tauri::command]
pub async fn dstu_move_many(
    paths: Vec<String>,
    dest_folder: String,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<usize, String> {
    log::info!(
        "[DSTU::handlers] dstu_move_many: {} paths to {}",
        paths.len(),
        dest_folder
    );

    // 批量操作数量限制检查
    if paths.len() > MAX_BATCH_SIZE {
        return Err(format!(
            "批量操作数量超出限制：最多允许 {} 个，实际 {} 个",
            MAX_BATCH_SIZE,
            paths.len()
        ));
    }

    // 目标文件夹路径解析
    let dest_folder_id = if dest_folder.trim().is_empty() || dest_folder.trim() == "/" {
        None
    } else {
        let (dst_type, dst_id) = match extract_resource_info(&dest_folder) {
            Ok((rt, rid)) => (rt, rid),
            Err(e) => {
                log::error!(
                    "[DSTU::handlers] dstu_move_many: FAILED - dest={}, error={}",
                    dest_folder,
                    e
                );
                return Err(e.to_string());
            }
        };
        if dst_type != "folders" {
            return Err("Destination must be a folder".to_string());
        }
        Some(dst_id)
    };

    let mut success_count = 0;

    for path in &paths {
        // 统一路径解析
        let (resource_type, id) = match extract_resource_info(path) {
            Ok((rt, rid)) => (rt, rid),
            Err(_) => continue,
        };

        let item_type = match resource_type.as_str() {
            "notes" => "note",
            "textbooks" => "textbook",
            "exams" => "exam",
            "translations" => "translation",
            "essays" => "essay",
            "folders" => "folder",
            "mindmaps" => "mindmap",
            "files" | "images" | "attachments" => "file",
            _ => continue,
        };

        let result =
            VfsFolderRepo::move_item_to_folder(&vfs_db, item_type, &id, dest_folder_id.as_deref());
        if result.is_ok() {
            success_count += 1;

            if let Ok(Some(node)) = get_resource_by_type_and_id(&vfs_db, &resource_type, &id).await
            {
                let new_path = node.path.clone();
                emit_watch_event(&window, DstuWatchEvent::moved(path, &new_path, node));
            }
        } else if let Err(e) = result {
            log::warn!(
                "[DSTU::handlers] dstu_move_many: FAILED - type={}, id={}, error={}",
                item_type,
                id,
                e
            );
        }
    }

    log::info!(
        "[DSTU::handlers] dstu_move_many: moved {} of {} items",
        success_count,
        paths.len()
    );
    Ok(success_count)
}

// ============================================================================
// dstu_watch / dstu_unwatch: 资源变化监听
// ============================================================================

/// 注册资源变化监听（当前实现为前端事件通道占位）
#[tauri::command]
pub async fn dstu_watch(path: String) -> Result<(), String> {
    log::info!("[DSTU::handlers] dstu_watch: path={}", path);
    Ok(())
}

/// 取消资源变化监听（当前实现为前端事件通道占位）
#[tauri::command]
pub async fn dstu_unwatch(path: String) -> Result<(), String> {
    log::info!("[DSTU::handlers] dstu_unwatch: path={}", path);
    Ok(())
}

// ============================================================================
// dstu_search_in_folder: 文件夹内搜索
// ============================================================================

/// 在指定文件夹内搜索资源
///
/// ## 参数
/// - `folder_id`: VFS 文件夹 ID（可选，null 表示根目录）
/// - `query`: 搜索关键词
/// - `options`: 搜索选项
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 匹配的资源列表
#[tauri::command]
pub async fn dstu_search_in_folder(
    folder_id: Option<String>,
    query: String,
    options: Option<DstuListOptions>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<DstuNode>, String> {
    log::info!(
        "[DSTU::handlers] dstu_search_in_folder: folder={:?}, query={}",
        folder_id,
        query
    );

    let options = options.unwrap_or_default();

    // 如果有 folder_id，先获取文件夹内的所有项
    if let Some(ref fid) = folder_id {
        // 需要获取文件夹的 subject
        let _folder = match crate::vfs::VfsFolderRepo::get_folder(&vfs_db, fid) {
            Ok(Some(f)) => f,
            Ok(None) => {
                log::error!(
                    "[DSTU::handlers] dstu_get_nodes_in_folder: FAILED - folder not found, id={}",
                    fid
                );
                return Err(format!("Folder not found: {}", fid));
            }
            Err(e) => {
                log::error!("[DSTU::handlers] dstu_get_nodes_in_folder: FAILED - get_folder error, id={}, error={}", fid, e);
                return Err(e.to_string());
            }
        };
        let items = match crate::vfs::VfsFolderRepo::list_items_by_folder(&vfs_db, Some(fid)) {
            Ok(i) => i,
            Err(e) => {
                log::error!("[DSTU::handlers] dstu_get_nodes_in_folder: FAILED - list_items_by_folder error, folder_id={}, error={}", fid, e);
                return Err(e.to_string());
            }
        };

        // 获取文件夹内所有 item_id 集合（用于索引召回过滤）
        let folder_item_ids: std::collections::HashSet<String> =
            items.iter().map(|item| item.item_id.clone()).collect();

        // 获取每个项的详细信息并按标题/文件名过滤
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();
        for item in items {
            let node = match item.item_type.as_str() {
                "note" => {
                    if let Ok(Some(note)) = VfsNoteRepo::get_note(&vfs_db, &item.item_id) {
                        if note.title.to_lowercase().contains(&query_lower) {
                            Some(note_to_dstu_node(&note))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                "textbook" => {
                    if let Ok(Some(tb)) = VfsTextbookRepo::get_textbook(&vfs_db, &item.item_id) {
                        if tb.file_name.to_lowercase().contains(&query_lower) {
                            Some(textbook_to_dstu_node(&tb))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                "file" => {
                    if let Ok(Some(f)) = VfsFileRepo::get_file(&vfs_db, &item.item_id) {
                        if f.file_name.to_lowercase().contains(&query_lower) {
                            Some(file_to_dstu_node(&f))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                "translation" => {
                    if let Ok(Some(t)) = VfsTranslationRepo::get_translation(&vfs_db, &item.item_id) {
                        if t.title.as_deref().unwrap_or("").to_lowercase().contains(&query_lower) {
                            Some(translation_to_dstu_node(&t))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                "exam" => {
                    if let Ok(Some(e)) = VfsExamRepo::get_exam_sheet(&vfs_db, &item.item_id) {
                        if e.exam_name.as_deref().unwrap_or("").to_lowercase().contains(&query_lower) {
                            Some(exam_to_dstu_node(&e))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                "mindmap" => {
                    if let Ok(Some(m)) = VfsMindMapRepo::get_mindmap(&vfs_db, &item.item_id) {
                        if m.title.to_lowercase().contains(&query_lower) {
                            Some(mindmap_to_dstu_node(&m))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                _ => None,
            };

            if let Some(n) = node {
                results.push(n);
            }
        }

        // ★ 索引内容召回：追加内容匹配的结果，限定在当前文件夹范围内
        let existing_ids: std::collections::HashSet<String> =
            results.iter().map(|n| n.id.clone()).collect();
        let index_limit = options.limit.unwrap_or(50);
        if let Ok(index_results) = search_by_index(&vfs_db, &query, index_limit, &existing_ids) {
            for node in index_results {
                // 只保留属于当前文件夹的资源
                if folder_item_ids.contains(&node.id) {
                    results.push(node);
                }
            }
        }

        // 按更新时间排序
        results.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        // 限制结果数量
        if let Some(limit) = options.limit {
            results.truncate(limit as usize);
        }

        return Ok(results);
    }

    // 没有指定文件夹，使用全局搜索
    dstu_search(query, Some(options), vfs_db).await
}

// ============================================================================
// 辅助函数：列出未分配到 folder_items 的资源（向后兼容旧数据）
// ============================================================================

// ============================================================================
// E1: 路径解析命令
// ============================================================================

/// 解析 DSTU 真实路径
///
/// 将路径字符串解析为结构化的 `DstuParsedPath`。
/// 支持新路径格式（文件夹层级路径）和旧路径格式（类型路径）。
///
/// ## 新路径格式
/// - `/{folder_path}/{resource_id}`
/// - 例如：`/高考复习/函数/note_abc123`
///
/// ## 特殊路径
/// - `/` - 根目录
/// - `/@trash` - 回收站
/// - `/@recent` - 最近使用
///
/// ## 参数
/// - `path`: DSTU 路径字符串
///
/// ## 返回
/// 解析后的路径结构
#[tauri::command]
pub async fn dstu_parse_path(path: String) -> Result<DstuParsedPath, String> {
    log::info!("[DSTU::handlers] dstu_parse_path: path={}", path);

    // 处理空路径
    if path.is_empty() || path == "/" {
        return Ok(DstuParsedPath::root());
    }

    // 规范化路径
    let normalized = if path.starts_with('/') {
        path.clone()
    } else {
        format!("/{}", path)
    };
    let normalized = normalized.trim_end_matches('/');

    // 检查虚拟路径
    if normalized.starts_with("/@") {
        let virtual_name = &normalized[2..];
        return Ok(DstuParsedPath::virtual_path(virtual_name));
    }

    // 分割路径段
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();

    if segments.is_empty() {
        return Ok(DstuParsedPath::root());
    }

    // 检查最后一段是否是资源 ID（有前缀）
    // 使用安全的模式匹配避免潜在panic
    let last_segment = match segments.last() {
        Some(s) => *s,
        None => return Ok(DstuParsedPath::root()),
    };
    let resource_type = DstuParsedPath::infer_resource_type(last_segment);

    if resource_type.is_some() {
        // 最后一段是资源 ID
        let resource_id = last_segment.to_string();
        let folder_path = if segments.len() > 1 {
            Some(format!("/{}", segments[..segments.len() - 1].join("/")))
        } else {
            None // 根目录下的资源
        };

        Ok(DstuParsedPath {
            full_path: normalized.to_string(),
            folder_path,
            resource_id: Some(resource_id),
            resource_type,
            is_root: false,
            is_virtual: false,
        })
    } else {
        // 纯文件夹路径
        Ok(DstuParsedPath {
            full_path: normalized.to_string(),
            folder_path: Some(normalized.to_string()),
            resource_id: None,
            resource_type: None,
            is_root: false,
            is_virtual: false,
        })
    }
}

/// 构建 DSTU 真实路径
///
/// 根据文件夹 ID 和资源 ID 构建完整路径。
///
/// ## 参数
/// - `folder_id`: 目标文件夹 ID（None = 根目录）
/// - `resource_id`: 资源 ID
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 完整路径字符串
#[tauri::command]
pub async fn dstu_build_path(
    folder_id: Option<String>,
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<String, String> {
    log::info!(
        "[DSTU::handlers] dstu_build_path: folder_id={:?}, resource_id={}",
        folder_id,
        resource_id
    );

    let folder_path = match folder_id {
        Some(ref fid) => {
            // 获取文件夹路径
            crate::vfs::VfsFolderRepo::build_folder_path(&vfs_db, fid).map_err(|e| e.to_string())?
        }
        None => String::new(), // 根目录
    };

    let full_path = if folder_path.is_empty() {
        format!("/{}", resource_id)
    } else {
        format!("{}/{}", folder_path, resource_id)
    };

    log::info!("[DSTU::handlers] dstu_build_path: result={}", full_path);
    Ok(full_path)
}

// ============================================================================
// E2: 资源定位命令
// ============================================================================

/// 获取资源定位信息
///
/// 根据资源 ID 获取其完整的定位信息，包括所在文件夹和路径。
///
/// ## 参数
/// - `resource_id`: 资源 ID
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 资源定位信息
#[tauri::command]
pub async fn dstu_get_resource_location(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ResourceLocation, String> {
    log::info!(
        "[DSTU::handlers] dstu_get_resource_location: resource_id={}",
        resource_id
    );

    // 推断资源类型
    let resource_type =
        DstuParsedPath::infer_resource_type(&resource_id).unwrap_or_else(|| "unknown".to_string());

    // 从 folder_items 表查找资源所在的文件夹
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    let folder_item: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT folder_id, cached_path FROM folder_items WHERE item_id = ?1",
            rusqlite::params![&resource_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let (folder_id, cached_path) = folder_item.unwrap_or((None, None));

    // 构建路径
    let folder_path = match &folder_id {
        Some(fid) => crate::vfs::VfsFolderRepo::build_folder_path(&vfs_db, fid)
            .unwrap_or_else(|_| String::new()),
        None => String::new(),
    };

    let full_path = cached_path.unwrap_or_else(|| {
        if folder_path.is_empty() {
            format!("/{}", resource_id)
        } else {
            format!("{}/{}", folder_path, resource_id)
        }
    });

    log::info!(
        "[DSTU::handlers] dstu_get_resource_location: SUCCESS - folder_id={:?}, path={}",
        folder_id,
        full_path
    );

    Ok(ResourceLocation {
        id: resource_id,
        resource_type,
        folder_id,
        folder_path,
        full_path,
        hash: None, // TODO: 获取资源 hash
    })
}

/// 根据路径获取资源
///
/// 解析路径并获取对应的资源节点。
///
/// ## 参数
/// - `path`: DSTU 路径
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 资源节点，不存在时返回 None
#[tauri::command]
pub async fn dstu_get_resource_by_path(
    path: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Option<DstuNode>, String> {
    log::info!("[DSTU::handlers] dstu_get_resource_by_path: path={}", path);

    // 先解析路径
    let parsed = dstu_parse_path(path.clone()).await?;

    // 如果是根目录或虚拟路径，返回文件夹节点
    if parsed.is_root {
        return Ok(Some(DstuNode::folder("root", "/", "根目录")));
    }

    if parsed.is_virtual {
        let name = parsed.full_path.trim_start_matches("/@");
        return Ok(Some(DstuNode::folder(
            &format!("@{}", name),
            &parsed.full_path,
            name,
        )));
    }

    // 如果有资源 ID，获取资源详情
    if let Some(ref resource_id) = parsed.resource_id {
        // 根据资源类型获取详情
        let resource_type = parsed.resource_type.as_deref().unwrap_or("unknown");

        match resource_type {
            "note" => match VfsNoteRepo::get_note(&vfs_db, resource_id) {
                Ok(Some(note)) => Ok(Some(note_to_dstu_node(&note))),
                Ok(None) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            "textbook" => match VfsTextbookRepo::get_textbook(&vfs_db, resource_id) {
                Ok(Some(tb)) => Ok(Some(textbook_to_dstu_node(&tb))),
                Ok(None) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            "exam" => match VfsExamRepo::get_exam_sheet(&vfs_db, resource_id) {
                Ok(Some(exam)) => Ok(Some(exam_to_dstu_node(&exam))),
                Ok(None) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            "translation" => match VfsTranslationRepo::get_translation(&vfs_db, resource_id) {
                Ok(Some(tr)) => Ok(Some(translation_to_dstu_node(&tr))),
                Ok(None) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            "essay" => match VfsEssayRepo::get_session(&vfs_db, resource_id) {
                Ok(Some(session)) => Ok(Some(session_to_dstu_node(&session))),
                Ok(None) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            "folder" => match crate::vfs::VfsFolderRepo::get_folder(&vfs_db, resource_id) {
                Ok(Some(folder)) => Ok(Some(DstuNode::folder(
                    &folder.id,
                    &parsed.full_path,
                    &folder.title,
                ))),
                Ok(None) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            _ => {
                log::warn!(
                    "[DSTU::handlers] dstu_get_resource_by_path: unknown resource type: {}",
                    resource_type
                );
                Ok(None)
            }
        }
    } else {
        // 纯文件夹路径，尝试通过路径查找文件夹
        // TODO: 实现通过路径查找文件夹
        Ok(None)
    }
}

// ============================================================================
// E3: 移动操作命令
// ============================================================================

/// 移动资源到指定文件夹
///
/// 只更新 folder_items.folder_id，不修改资源表的 subject 字段。
///
/// ## 参数
/// - `resource_id`: 资源 ID
/// - `target_folder_id`: 目标文件夹 ID（None = 根目录）
/// - `window`: 窗口实例（用于发射事件）
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 更新后的资源定位信息
#[tauri::command]
pub async fn dstu_move_to_folder(
    resource_id: String,
    target_folder_id: Option<String>,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<ResourceLocation, String> {
    log::info!(
        "[DSTU::handlers] dstu_move_to_folder: resource_id={}, target_folder_id={:?}",
        resource_id,
        target_folder_id
    );

    // 推断资源类型
    let resource_type =
        DstuParsedPath::infer_resource_type(&resource_id).unwrap_or_else(|| "unknown".to_string());

    let vfs_db_clone = vfs_db.inner().clone();
    let resource_id_for_blocking = resource_id.clone();
    let resource_type_for_blocking = resource_type.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = vfs_db_clone.get_conn_safe().map_err(|e| e.to_string())?;

        // 获取移动前的旧路径
        let old_path: String = conn
            .query_row(
                "SELECT cached_path FROM folder_items WHERE item_id = ?1",
                rusqlite::params![&resource_id_for_blocking],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| format!("/{}", resource_id_for_blocking));

        // 构建目标文件夹路径
        let folder_path = match &target_folder_id {
            Some(fid) => {
                crate::vfs::VfsFolderRepo::build_folder_path_with_conn(&conn, fid)
                    .unwrap_or_else(|_| String::new())
            }
            None => String::new(),
        };

        // 构建完整路径
        let full_path = if folder_path.is_empty() {
            format!("/{}", resource_id_for_blocking)
        } else {
            format!("{}/{}", folder_path, resource_id_for_blocking)
        };

        // 检查 folder_items 中是否已存在该资源
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM folder_items WHERE item_id = ?1",
                rusqlite::params![&resource_id_for_blocking],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if existing.is_some() {
            // 更新现有记录
            conn.execute(
                "UPDATE folder_items SET folder_id = ?1, cached_path = ?2, updated_at = datetime('now') WHERE item_id = ?3",
                rusqlite::params![&target_folder_id, &full_path, &resource_id_for_blocking],
            )
            .map_err(|e| e.to_string())?;
        } else {
            // 创建新记录
            let item_id = format!("fi_{}", nanoid::nanoid!(10));

            conn.execute(
                r#"
                INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, cached_path, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, 0, ?5, datetime('now'), datetime('now'))
                "#,
                rusqlite::params![&item_id, &target_folder_id, &resource_type_for_blocking, &resource_id_for_blocking, &full_path],
            )
            .map_err(|e| e.to_string())?;
        }

        log::info!(
            "[DSTU::handlers] dstu_move_to_folder: SUCCESS - resource_id={}, target_folder_id={:?}",
            resource_id_for_blocking, target_folder_id
        );

        Ok::<(ResourceLocation, String), String>((ResourceLocation {
            id: resource_id_for_blocking,
            resource_type: resource_type_for_blocking,
            folder_id: target_folder_id,
            folder_path,
            full_path,
            hash: None,
        }, old_path))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    // 解构结果并发射移动事件
    let (location, old_path) = result?;

    // 创建 DstuNode 用于事件
    let node_type = DstuNodeType::from_str(&resource_type).unwrap_or(DstuNodeType::File);
    let now = chrono::Utc::now().timestamp_millis();
    let node = DstuNode {
        id: location.id.clone(),
        source_id: location.id.clone(),
        name: location.id.clone(), // 使用 ID 作为名称（实际名称需要额外查询）
        path: location.full_path.clone(),
        node_type,
        size: None,
        created_at: now,
        updated_at: now,
        children: None,
        child_count: None,
        resource_id: None,
        resource_hash: None,
        preview_type: None,
        metadata: None,
    };

    // 发射 moved 事件
    emit_watch_event(
        &window,
        DstuWatchEvent::moved(&old_path, &location.full_path, node),
    );

    Ok(location)
}

/// 批量移动资源（逐项处理，结构化结果）
///
/// 逐项处理移动操作，成功项提交、失败项记录并跳过：
/// - 返回结构化结果，包含成功列表和失败列表
/// - 事务内逐项处理：单项失败不影响其他项
/// - 仅对成功项发射移动事件
///
/// ## 参数
/// - `request`: 批量移动请求
/// - `window`: 窗口实例（用于发射事件）
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 批量移动结果，包含成功和失败的详细信息
#[tauri::command]
pub async fn dstu_batch_move(
    request: BatchMoveRequest,
    window: Window,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<BatchMoveResult, String> {
    log::info!(
        "[DSTU::handlers] dstu_batch_move: item_ids={:?}, target_folder_id={:?}",
        request.item_ids,
        request.target_folder_id
    );

    let total_count = request.item_ids.len();
    if total_count == 0 {
        return Ok(BatchMoveResult {
            successes: Vec::new(),
            failed_items: Vec::new(),
            total_count: 0,
        });
    }

    let vfs_db_clone = vfs_db.inner().clone();
    let item_ids = request.item_ids.clone();
    let target_folder_id = request.target_folder_id.clone();

    // 逐项处理数据库操作，收集成功和失败信息
    // 成功项: Vec<(ResourceLocation, old_path, resource_type)>
    // 失败项: Vec<FailedMoveItem>
    let (move_results, failed_items): (
        Vec<(ResourceLocation, String, String)>,
        Vec<FailedMoveItem>,
    ) = tokio::task::spawn_blocking(move || {
        let conn = vfs_db_clone.get_conn_safe().map_err(|e| e.to_string())?;

        // 构建目标文件夹路径（只需要构建一次）
        let folder_path = match &target_folder_id {
            Some(fid) => crate::vfs::VfsFolderRepo::build_folder_path_with_conn(&conn, fid)
                .unwrap_or_else(|_| String::new()),
            None => String::new(),
        };

        let mut successes = Vec::with_capacity(item_ids.len());
        let mut failures: Vec<FailedMoveItem> = Vec::new();

        for resource_id in &item_ids {
            match move_single_item(&conn, resource_id, &target_folder_id, &folder_path) {
                Ok((location, old_path, resource_type)) => {
                    successes.push((location, old_path, resource_type));
                }
                Err(err_msg) => {
                    log::warn!(
                        "[DSTU::handlers] dstu_batch_move: 移动失败 item_id={}, error={}",
                        resource_id,
                        err_msg
                    );
                    failures.push(FailedMoveItem {
                        item_id: resource_id.clone(),
                        error: err_msg,
                    });
                }
            }
        }

        Ok::<_, String>((successes, failures))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // 对成功项发射移动事件
    let successes: Vec<ResourceLocation> = move_results
        .into_iter()
        .map(|(location, old_path, resource_type)| {
            // 创建 DstuNode 用于事件
            let node_type = DstuNodeType::from_str(&resource_type).unwrap_or(DstuNodeType::File);
            let now = chrono::Utc::now().timestamp_millis();
            let node = DstuNode {
                id: location.id.clone(),
                source_id: location.id.clone(),
                name: location.id.clone(),
                path: location.full_path.clone(),
                node_type,
                size: None,
                created_at: now,
                updated_at: now,
                children: None,
                child_count: None,
                resource_id: None,
                resource_hash: None,
                preview_type: None,
                metadata: None,
            };

            // 发射 moved 事件
            emit_watch_event(
                &window,
                DstuWatchEvent::moved(&old_path, &location.full_path, node),
            );

            location
        })
        .collect();

    if failed_items.is_empty() {
        log::info!(
            "[DSTU::handlers] dstu_batch_move: SUCCESS - 移动 {} 项资源",
            successes.len()
        );
    } else {
        log::warn!(
            "[DSTU::handlers] dstu_batch_move: 部分完成 - 成功 {}, 失败 {} (失败项: {:?})",
            successes.len(),
            failed_items.len(),
            failed_items.iter().map(|f| &f.item_id).collect::<Vec<_>>()
        );
    }

    Ok(BatchMoveResult {
        successes,
        failed_items,
        total_count,
    })
}

/// 移动单个资源项的辅助函数（逐项独立执行，单项失败不影响其他项）
fn move_single_item(
    conn: &rusqlite::Connection,
    resource_id: &str,
    target_folder_id: &Option<String>,
    folder_path: &str,
) -> Result<(ResourceLocation, String, String), String> {
    // 推断资源类型
    let resource_type =
        DstuParsedPath::infer_resource_type(resource_id).unwrap_or_else(|| "unknown".to_string());

    // 获取移动前的旧路径
    let old_path: String = conn
        .query_row(
            "SELECT cached_path FROM folder_items WHERE item_id = ?1",
            rusqlite::params![resource_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("查询旧路径失败 ({}): {}", resource_id, e))?
        .unwrap_or_else(|| format!("/{}", resource_id));

    // 构建完整路径
    let full_path = if folder_path.is_empty() {
        format!("/{}", resource_id)
    } else {
        format!("{}/{}", folder_path, resource_id)
    };

    // 检查 folder_items 中是否已存在该资源
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM folder_items WHERE item_id = ?1",
            rusqlite::params![resource_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("查询现有记录失败 ({}): {}", resource_id, e))?;

    if existing.is_some() {
        // 更新现有记录
        conn.execute(
            "UPDATE folder_items SET folder_id = ?1, cached_path = ?2, updated_at = datetime('now') WHERE item_id = ?3",
            rusqlite::params![target_folder_id, &full_path, resource_id],
        )
        .map_err(|e| format!("更新 folder_items 失败 ({}): {}", resource_id, e))?;
    } else {
        // 创建新记录
        let item_id = format!("fi_{}", nanoid::nanoid!(10));

        conn.execute(
            r#"
            INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, cached_path, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 0, ?5, datetime('now'), datetime('now'))
            "#,
            rusqlite::params![&item_id, target_folder_id, &resource_type, resource_id, &full_path],
        )
        .map_err(|e| format!("插入 folder_items 失败 ({}): {}", resource_id, e))?;
    }

    let location = ResourceLocation {
        id: resource_id.to_string(),
        resource_type: resource_type.clone(),
        folder_id: target_folder_id.clone(),
        folder_path: folder_path.to_string(),
        full_path,
        hash: None,
    };

    Ok((location, old_path, resource_type))
}

// ============================================================================
// E4: 路径缓存命令
// ============================================================================

/// 刷新路径缓存
///
/// 更新 folder_items 表中的 cached_path 字段。
///
/// ## 参数
/// - `resource_id`: 资源 ID（None = 全量刷新）
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 更新的条目数
#[tauri::command]
pub async fn dstu_refresh_path_cache(
    resource_id: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<usize, String> {
    log::info!(
        "[DSTU::handlers] dstu_refresh_path_cache: resource_id={:?}",
        resource_id
    );

    let vfs_db_clone = vfs_db.inner().clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = vfs_db_clone.get_conn_safe().map_err(|e| e.to_string())?;

        // 先收集所有数据
        let items: Vec<(String, Option<String>, String)> = if let Some(ref rid) = resource_id {
            // 刷新单个资源
            let mut stmt = conn
                .prepare("SELECT id, folder_id, item_id FROM folder_items WHERE item_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows: Vec<_> = stmt
                .query_map(rusqlite::params![rid], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .filter_map(log_and_skip_err)
                .collect();
            rows
        } else {
            // 全量刷新
            let mut stmt = conn
                .prepare("SELECT id, folder_id, item_id FROM folder_items")
                .map_err(|e| e.to_string())?;
            let rows: Vec<_> = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .filter_map(log_and_skip_err)
                .collect();
            rows
        };

        let mut updated_count = 0;

        for (item_row_id, folder_id, item_id) in items {
            // 构建路径
            let folder_path = match &folder_id {
                Some(fid) => crate::vfs::VfsFolderRepo::build_folder_path_with_conn(&conn, fid)
                    .unwrap_or_else(|_| String::new()),
                None => String::new(),
            };

            let full_path = if folder_path.is_empty() {
                format!("/{}", item_id)
            } else {
                format!("{}/{}", folder_path, item_id)
            };

            // 更新缓存
            conn.execute(
                "UPDATE folder_items SET cached_path = ?1 WHERE id = ?2",
                rusqlite::params![&full_path, &item_row_id],
            )
            .map_err(|e| e.to_string())?;

            updated_count += 1;
        }

        log::info!(
            "[DSTU::handlers] dstu_refresh_path_cache: SUCCESS - updated {} entries",
            updated_count
        );
        Ok::<usize, String>(updated_count)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    result
}

/// 根据资源 ID 获取路径
///
/// ## 参数
/// - `resource_id`: 资源 ID
/// - `vfs_db`: VFS 数据库实例
///
/// ## 返回
/// 资源的完整路径
#[tauri::command]
pub async fn dstu_get_path_by_id(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<String, String> {
    log::info!(
        "[DSTU::handlers] dstu_get_path_by_id: resource_id={}",
        resource_id
    );

    // 调用 VFS 的路径获取函数
    let path = crate::vfs::ref_handlers::get_resource_path_internal(&vfs_db, &resource_id)
        .map_err(|e| e.to_string())?;

    log::info!(
        "[DSTU::handlers] dstu_get_path_by_id: SUCCESS - path={}",
        path
    );
    Ok(path)
}

// ============================================================================
// E5: Subject 迁移命令（文档 28 Prompt 6）
// ============================================================================

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_resource_id() {
        let id = generate_resource_id(&DstuNodeType::Note);
        assert!(id.starts_with("note_"));
        assert_eq!(id.len(), 15); // "note_" + 10 chars

        let id = generate_resource_id(&DstuNodeType::Textbook);
        assert!(id.starts_with("tb_"));

        let id = generate_resource_id(&DstuNodeType::Translation);
        assert!(id.starts_with("tr_"));
    }

    #[test]
    fn test_create_type_folder() {
        let folder = create_type_folder(DstuNodeType::Note);
        assert_eq!(folder.node_type, DstuNodeType::Folder);
        assert_eq!(folder.name, "笔记");
        assert_eq!(folder.path, "/notes");

        let folder = create_type_folder(DstuNodeType::Translation);
        assert_eq!(folder.path, "/translations");
    }

    // ============================================================================
    // 路径和路由测试（纯函数，不依赖 VfsDatabase）
    // ============================================================================

    /// 验证简化路径格式
    #[test]
    fn test_simple_path_format() {
        // 验证简化路径格式正确性
        let resource_type = "notes";
        let id = "note_abc123";

        let simple_path = format!("/{}", id);
        assert_eq!(simple_path, "/note_abc123");
    }

    // 这些函数已被 build_simple_resource_path 替代

    /// 验证 build_simple_resource_path 函数
    #[test]
    fn test_build_simple_resource_path() {
        let path = build_simple_resource_path("note_123");
        assert_eq!(path, "/note_123");

        let path2 = build_simple_resource_path("tr_456");
        assert_eq!(path2, "/tr_456");
    }
}
