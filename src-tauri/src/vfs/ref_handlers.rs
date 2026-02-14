//! VFS 引用模式命令处理器（Prompt 2 核心）
//!
//! 提供引用模式上下文注入的 Tauri 命令。
//! 引用模式的核心思想：存储时只保存 sourceId + resourceHash，
//! 发送时动态解析获取最新路径和内容。
//!
//! ## 核心命令
//! - `vfs_get_resource_refs`: 根据 sourceId 列表获取资源引用
//! - `vfs_resolve_resource_refs`: 解析引用获取完整路径和内容
//! - `vfs_get_resource_ref_count`: 获取资源的引用计数（用于软删除前检查）

use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;
use tracing::{debug, info, warn};

use crate::document_parser::DocumentParser;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;
use crate::vfs::indexing::VfsContentExtractor;
use crate::vfs::ocr_utils::{join_ocr_pages_text, parse_ocr_pages_json};
use crate::vfs::repos::{VfsFileRepo, VfsFolderRepo};
use crate::vfs::types::{
    resolve_image_inject_modes, resolve_pdf_inject_modes, GetResourceRefsInput,
    MultimodalContentBlock, ResolvedResource, VfsContextRefData, VfsFolderItem, VfsResourceRef,
    VfsResourceType,
};

/// 最大批量处理资源数（契约 F）
const MAX_BATCH_RESOURCES: usize = 50;

// ============================================================================
// Tauri 命令
// ============================================================================

/// 获取资源引用列表
///
/// 根据 sourceId 列表（note_xxx, tb_xxx, fld_xxx 等）获取对应的资源引用。
/// 如果 sourceId 是文件夹 ID 且 include_folder_contents 为 true，
/// 则递归获取文件夹内所有资源。
///
/// ## 参数
/// - `params.source_ids`: 资源 ID 列表
/// - `params.include_folder_contents`: 是否展开文件夹内容
/// - `params.max_items`: 最大返回项数（默认 50）
///
/// ## 返回
/// - `Ok(VfsContextRefData)`: 资源引用列表
/// - `Err(String)`: 错误信息
#[tauri::command]
pub async fn vfs_get_resource_refs(
    params: GetResourceRefsInput,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<VfsContextRefData, String> {
    info!(
        "[VFS::RefHandlers] vfs_get_resource_refs: source_ids={:?}, include_folder_contents={}, max_items={}",
        params.source_ids, params.include_folder_contents, params.max_items
    );

    let max_items = (params.max_items as usize).min(MAX_BATCH_RESOURCES);
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    let mut refs: Vec<VfsResourceRef> = Vec::new();
    let mut total_count = 0usize;

    for source_id in &params.source_ids {
        // 检查是否超过最大数量
        if refs.len() >= max_items {
            break;
        }

        // 判断资源类型并获取引用
        if source_id.starts_with("fld_") && params.include_folder_contents {
            // 文件夹：递归获取内容
            match get_folder_refs_with_conn(&conn, source_id, max_items - refs.len()) {
                Ok(folder_refs) => {
                    total_count += folder_refs.len();
                    for r in folder_refs {
                        if refs.len() >= max_items {
                            break;
                        }
                        refs.push(r);
                    }
                }
                Err(e) => {
                    warn!(
                        "[VFS::RefHandlers] Failed to get folder refs for {}: {}",
                        source_id, e
                    );
                }
            }
        } else {
            // 单个资源
            match get_resource_ref_with_conn(&conn, source_id) {
                Ok(Some(r)) => {
                    total_count += 1;
                    refs.push(r);
                }
                Ok(None) => {
                    debug!(
                        "[VFS::RefHandlers] Resource not found for sourceId: {}",
                        source_id
                    );
                }
                Err(e) => {
                    warn!(
                        "[VFS::RefHandlers] Failed to get resource ref for {}: {}",
                        source_id, e
                    );
                }
            }
        }
    }

    let truncated = total_count > max_items;

    info!(
        "[VFS::RefHandlers] Got {} refs (total_count={}, truncated={})",
        refs.len(),
        total_count,
        truncated
    );

    Ok(VfsContextRefData {
        refs,
        truncated,
        total_count,
    })
}

/// 解析资源引用列表
///
/// 将资源引用解析为完整的资源信息，包括路径和内容。
/// 用于发送消息时动态获取最新的资源状态。
///
/// ## 参数
/// - `refs`: 资源引用列表
///
/// ## 返回
/// - `Ok(Vec<ResolvedResource>)`: 解析后的资源列表
/// - `Err(String)`: 错误信息
#[tauri::command]
pub async fn vfs_resolve_resource_refs(
    refs: Vec<VfsResourceRef>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<ResolvedResource>, String> {
    info!(
        "[VFS::RefHandlers] vfs_resolve_resource_refs: {} refs",
        refs.len()
    );

    // ★ OCR 诊断日志：打印每个 ref 的详细信息，包括 inject_modes
    for (i, r) in refs.iter().enumerate() {
        info!(
            "[OCR_DIAG] ref[{}]: source_id={}, type={:?}, name={}, inject_modes={:?}",
            i, r.source_id, r.resource_type, r.name, r.inject_modes
        );
    }

    if refs.len() > MAX_BATCH_RESOURCES {
        return Err(format!(
            "Too many refs to resolve: {} (max: {})",
            refs.len(),
            MAX_BATCH_RESOURCES
        ));
    }

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    let blobs_dir = vfs_db.blobs_dir();

    let mut resolved: Vec<ResolvedResource> = Vec::with_capacity(refs.len());

    for r in &refs {
        match resolve_single_ref_with_conn(&conn, blobs_dir, r) {
            Ok(resource) => {
                // ★ OCR 诊断日志：打印解析结果摘要
                info!(
                    "[OCR_DIAG] resolved: source_id={}, found={}, has_content={}, content_len={}, has_multimodal_blocks={}, content_preview={}",
                    resource.source_id,
                    resource.found,
                    resource.content.is_some(),
                    resource.content.as_ref().map(|c| c.len()).unwrap_or(0),
                    resource.multimodal_blocks.is_some(),
                    resource.content.as_ref().map(|c| {
                        let preview: String = c.chars().take(200).collect();
                        format!("\"{}...\"", preview)
                    }).unwrap_or_else(|| "None".to_string())
                );
                resolved.push(resource);
            }
            Err(e) => {
                warn!(
                    "[VFS::RefHandlers] Failed to resolve ref {}: {}",
                    r.source_id, e
                );
                // 资源不存在时返回 found=false 的记录
                resolved.push(ResolvedResource {
                    source_id: r.source_id.clone(),
                    resource_hash: r.resource_hash.clone(),
                    resource_type: r.resource_type.clone(),
                    name: r.name.clone(),
                    path: String::new(),
                    content: None,
                    found: false,
                    warning: None,
                    multimodal_blocks: None,
                });
            }
        }
    }

    info!(
        "[VFS::RefHandlers] Resolved {} refs, {} found",
        resolved.len(),
        resolved.iter().filter(|r| r.found).count()
    );

    Ok(resolved)
}

/// 获取资源的引用计数
///
/// 通过 sourceId（如 note_xxx, exam_xxx, mm_xxx）查询该资源被多少个会话引用。
/// 查询 resources 表的 ref_count 字段。
///
/// ## 参数
/// - `source_id`: 业务 ID（如 note_xxx, exam_xxx, mm_xxx, tb_xxx）
///
/// ## 返回
/// - `Ok(i32)`: 引用计数
/// - `Err(String)`: 错误信息
#[tauri::command]
pub async fn vfs_get_resource_ref_count(
    source_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<i32, String> {
    info!(
        "[VFS::RefHandlers] vfs_get_resource_ref_count: source_id={}",
        source_id
    );

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    // ★ 2026-02-09 修复：通过 get_source_id_type 获取正确的表名，
    //   再通过 table.resource_id → resources.ref_count 查找。
    //   旧的 generic path (resources WHERE source_id = ?1) 对大多数类型返回 0，
    //   因为 resources.source_id 在创建时未被设置。
    let ref_count: i32 = if source_id.starts_with("essay_session_") {
        // essay_session_ 没有 resource_id，聚合其下所有 essays 的 ref_count
        conn.query_row(
            r#"
            SELECT COALESCE(SUM(COALESCE(r.ref_count, 0)), 0)
            FROM essays e
            LEFT JOIN resources r ON e.resource_id = r.id
            WHERE e.session_id = ?1 AND e.deleted_at IS NULL
            "#,
            params![source_id],
            |row| row.get(0),
        )
        .unwrap_or(0)
    } else if let Some((_, table_name, _)) = get_source_id_type(&source_id) {
        // 通用路径：通过 table.resource_id → resources.ref_count
        let sql = format!(
            r#"
            SELECT COALESCE(r.ref_count, 0)
            FROM {} t
            LEFT JOIN resources r ON t.resource_id = r.id
            WHERE t.id = ?1 AND t.deleted_at IS NULL
            "#,
            table_name
        );
        conn.query_row(&sql, params![source_id], |row| row.get(0))
            .unwrap_or(0)
    } else {
        // 未知类型，回退到旧的 source_id 查找
        conn.query_row(
            "SELECT COALESCE(ref_count, 0) FROM resources WHERE source_id = ?1",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Query failed: {}", e))?
        .unwrap_or(0)
    };

    info!(
        "[VFS::RefHandlers] Resource {} has {} refs",
        source_id, ref_count
    );

    Ok(ref_count)
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 根据 sourceId 获取单个资源引用
fn get_resource_ref_with_conn(
    conn: &Connection,
    source_id: &str,
) -> VfsResult<Option<VfsResourceRef>> {
    // 根据 sourceId 前缀判断资源类型
    let (mut resource_type, table_name, title_column) = match get_source_id_type(source_id) {
        Some(info) => info,
        None => {
            debug!("[VFS::RefHandlers] Unknown sourceId format: {}", source_id);
            return Ok(None);
        }
    };

    // ★ 附件类型需要查询数据库获取精确类型（image 或 file）
    if source_id.starts_with("att_") {
        resource_type = get_attachment_type_with_conn(conn, source_id);
    }

    // ★ 2026-02-09 修复：essay_sessions 表没有 resource_id 列，需要特殊处理
    if source_id.starts_with("essay_session_") {
        return get_essay_session_ref_with_conn(conn, source_id);
    }

    let title_expr = qualify_title_expr_with_alias(title_column, "t");

    // 查询资源信息和哈希
    let sql = format!(
        r#"
        SELECT {title_expr}, r.hash
        FROM {table_name} t
        LEFT JOIN resources r ON t.resource_id = r.id
        WHERE t.id = ?1
          AND t.deleted_at IS NULL
          AND (r.deleted_at IS NULL OR r.id IS NULL)
        "#,
        title_expr = title_expr,
        table_name = table_name
    );

    let result: Option<(String, Option<String>)> = conn
        .query_row(&sql, params![source_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;

    match result {
        Some((title, hash_opt)) => {
            let hash = hash_opt.unwrap_or_default();
            Ok(Some(VfsResourceRef {
                source_id: source_id.to_string(),
                resource_hash: hash,
                resource_type,
                name: title,
                inject_modes: None, // 服务端创建的引用不设置注入模式，使用默认行为
            }))
        }
        None => Ok(None),
    }
}

fn qualify_title_expr_with_alias(title_column: &str, alias: &str) -> String {
    match title_column {
        "COALESCE(exam_name, id)" => format!("COALESCE({}.exam_name, {}.id)", alias, alias),
        "COALESCE(title, id)" => format!("COALESCE({}.title, {}.id)", alias, alias),
        _ if title_column.contains('(') => title_column.to_string(),
        _ => format!("{}.{}", alias, title_column),
    }
}

/// ★ 2026-02-09 新增：获取作文会话的资源引用
///
/// essay_sessions 表没有 resource_id 列，是一个聚合容器。
/// 使用会话的 title + 关联最新 essay 的 resource hash 构建引用。
fn get_essay_session_ref_with_conn(
    conn: &Connection,
    session_id: &str,
) -> VfsResult<Option<VfsResourceRef>> {
    // 查询会话标题
    let title: Option<String> = conn
        .query_row(
            "SELECT COALESCE(title, id) FROM essay_sessions WHERE id = ?1 AND deleted_at IS NULL",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?;

    let title = match title {
        Some(t) => t,
        None => return Ok(None), // 会话不存在或已删除
    };

    // 获取该会话下最新 essay 的 resource hash（如果有）
    // 用于变更检测，当会话下的任何轮次内容变化时 hash 会变
    // ★ 2026-02-09 修复：空会话（无轮次）时使用 session.updated_at 作为变更标识
    let hash: String = conn
        .query_row(
            r#"
            SELECT COALESCE(r.hash, '')
            FROM essays e
            LEFT JOIN resources r ON e.resource_id = r.id
            WHERE e.session_id = ?1 AND e.deleted_at IS NULL
            ORDER BY e.round_number DESC, e.updated_at DESC
            LIMIT 1
            "#,
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();

    // 空会话回退：使用 session 的 updated_at 生成标识
    let hash = if hash.is_empty() {
        conn.query_row(
            "SELECT COALESCE(updated_at, '') FROM essay_sessions WHERE id = ?1 AND deleted_at IS NULL",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default()
    } else {
        hash
    };

    Ok(Some(VfsResourceRef {
        source_id: session_id.to_string(),
        resource_hash: hash,
        resource_type: VfsResourceType::Essay,
        name: title,
        inject_modes: None,
    }))
}

/// 获取文件夹内所有资源的引用
fn get_folder_refs_with_conn(
    conn: &Connection,
    folder_id: &str,
    max_items: usize,
) -> VfsResult<Vec<VfsResourceRef>> {
    // 递归获取所有子文件夹 ID
    let folder_ids = VfsFolderRepo::get_folder_ids_recursive_with_conn(conn, folder_id)?;

    // 获取所有内容项
    let items = VfsFolderRepo::get_items_by_folders_with_conn(conn, &folder_ids)?;

    let mut refs: Vec<VfsResourceRef> = Vec::new();

    for item in items {
        if refs.len() >= max_items {
            break;
        }

        // 获取每个内容项的资源引用
        if let Ok(Some(r)) = get_resource_ref_for_item_with_conn(conn, &item) {
            refs.push(r);
        }
    }

    Ok(refs)
}

/// 根据文件夹内容项获取资源引用
fn get_resource_ref_for_item_with_conn(
    conn: &Connection,
    item: &VfsFolderItem,
) -> VfsResult<Option<VfsResourceRef>> {
    get_resource_ref_with_conn(conn, &item.item_id)
}

/// 解析单个资源引用
fn resolve_single_ref_with_conn(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    r: &VfsResourceRef,
) -> VfsResult<ResolvedResource> {
    info!(
        "[PDF_DEBUG] resolve_single_ref_with_conn START: source_id={}, type={:?}, name={}",
        r.source_id, r.resource_type, r.name
    );

    // 根据 sourceId 前缀判断资源类型
    let (_, table_name, title_column) = match get_source_id_type(&r.source_id) {
        Some(info) => info,
        None => {
            warn!(
                "[OCR_DIAG] get_source_id_type returned None for source_id={}, cannot resolve",
                r.source_id
            );
            return Ok(ResolvedResource {
                source_id: r.source_id.clone(),
                resource_hash: r.resource_hash.clone(),
                resource_type: r.resource_type.clone(),
                name: r.name.clone(),
                path: String::new(),
                content: None,
                found: false,
                warning: None,
                multimodal_blocks: None,
            });
        }
    };

    // 查询资源是否存在
    let exists_sql = format!(
        "SELECT 1 FROM {} WHERE id = ?1 AND deleted_at IS NULL",
        table_name
    );
    let exists: bool = conn
        .query_row(&exists_sql, params![r.source_id], |_| Ok(true))
        .unwrap_or(false);

    info!(
        "[OCR_DIAG] resource exists check: source_id={}, table={}, exists={}",
        r.source_id, table_name, exists
    );

    if !exists {
        warn!(
            "[OCR_DIAG] resource NOT FOUND in table '{}': source_id={}",
            table_name, r.source_id
        );
        return Ok(ResolvedResource {
            source_id: r.source_id.clone(),
            resource_hash: r.resource_hash.clone(),
            resource_type: r.resource_type.clone(),
            name: r.name.clone(),
            path: String::new(),
            content: None,
            found: false,
            warning: None,
            multimodal_blocks: None,
        });
    }

    // 获取资源路径（通过 folder_items 表查找）
    let path = get_resource_path_with_conn(conn, &r.source_id, &r.resource_type)?;

    // 获取最新的标题
    let title = get_resource_title_with_conn(conn, &r.source_id, &r.resource_type)?
        .unwrap_or_else(|| r.name.clone());

    // 获取资源内容
    info!(
        "[PDF_DEBUG] calling get_resource_content_with_conn: source_id={}, type={:?}",
        r.source_id, r.resource_type
    );
    let raw_content =
        get_resource_content_with_conn(conn, blobs_dir, &r.source_id, &r.resource_type)?;
    info!(
        "[PDF_DEBUG] raw_content result: source_id={}, has_content={}, content_len={}",
        r.source_id,
        raw_content.is_some(),
        raw_content.as_ref().map(|c| c.len()).unwrap_or(0)
    );

    // ★ 对于附件，根据类型和 inject_modes 区分处理（修复 2025-12-09, 2026-02 支持 inject_modes）
    // - Image: 根据 inject_modes.image 返回 base64 图片或 OCR 文本
    // - File/Textbook (PDF): 根据 inject_modes.pdf 返回文本/OCR/图片
    // ★ T02 重构：File/Textbook 类型使用统一的 extract_file_text_with_strategy 函数
    info!("[PDF_DEBUG] processing content by type: source_id={}, resource_type={:?}, inject_modes={:?}",
          r.source_id, r.resource_type, r.inject_modes);

    let is_pdf = title.to_lowercase().ends_with(".pdf");

    // ★ P2-1 修复（二轮审阅）：提前解析 PDF inject_modes，避免在 content 和 multimodal_blocks 阶段重复调用
    let pdf_resolved_modes = if is_pdf
        && matches!(
            r.resource_type,
            VfsResourceType::File | VfsResourceType::Textbook
        ) {
        let pdf_modes = r
            .inject_modes
            .as_ref()
            .and_then(|m| m.pdf.as_ref())
            .cloned();
        // is_multimodal=true 因为 ref_handlers 路径不知道目标模型类型，
        // 由前端 formatToBlocks 根据实际模型类型做最终裁剪
        let (include_text, include_ocr, include_image, downgraded) =
            resolve_pdf_inject_modes(pdf_modes.as_ref(), true);
        Some((include_text, include_ocr, include_image, downgraded))
    } else {
        None
    };

    let (content, warning) = match &r.resource_type {
        VfsResourceType::Image => {
            // ★ 图片：根据 inject_modes 决定返回内容
            let image_modes = r
                .inject_modes
                .as_ref()
                .and_then(|m| m.image.as_ref())
                .cloned();

            info!(
                "[OCR_DIAG] Image branch entered: source_id={}, inject_modes={:?}, image_modes={:?}",
                r.source_id, r.inject_modes, image_modes
            );

            // ★ 3.3 修复：使用统一的 SSOT 默认模式策略
            // is_multimodal=true 因为 ref_handlers 路径不知道目标模型类型，
            // 由前端 formatToBlocks 根据实际模型类型做最终裁剪
            let (include_image, include_ocr, _downgraded) =
                resolve_image_inject_modes(image_modes.as_ref(), true);

            info!(
                "[OCR_DIAG] Image: resolved modes: include_image={}, include_ocr={}",
                include_image, include_ocr
            );

            info!(
                "[OCR_DIAG] Image type: include_image={}, include_ocr={}, source_id={}",
                include_image, include_ocr, r.source_id
            );

            let mut content_parts: Vec<String> = Vec::new();

            // 图片模式：返回 base64
            if include_image {
                if let Some(ref base64_content) = raw_content {
                    info!(
                        "[PDF_DEBUG] Image type: adding raw base64, len={}",
                        base64_content.len()
                    );
                    content_parts.push(base64_content.clone());
                }
            }

            // OCR 模式：返回 OCR 文本
            if include_ocr {
                if let Some(ocr_text) = get_image_ocr_text_with_conn(conn, &r.source_id) {
                    info!(
                        "[PDF_DEBUG] Image type: adding OCR text, len={}",
                        ocr_text.len()
                    );
                    let formatted_ocr = format!(
                        "<image_ocr name=\"{}\">{}</image_ocr>",
                        escape_xml_attr(&title),
                        escape_xml_content(&ocr_text)
                    );
                    // ★ NEW-P1b 修复（二轮审阅）：移除死代码分支，两个分支操作相同
                    content_parts.push(formatted_ocr);
                } else {
                    info!("[PDF_DEBUG] Image type: no OCR text available");
                }
            }

            // 合并内容
            if content_parts.is_empty() {
                if !include_image && include_ocr {
                    // 用户只选了 OCR 但没有 OCR 文本，返回提示
                    (Some(format!("[图片无 OCR 文本: {}]", title)), None)
                } else {
                    (None, None)
                }
            } else {
                // 同时选择 Image 和 OCR 时，合并所有内容（base64 + OCR 文本）
                (Some(content_parts.join("\n\n")), None)
            }
        }
        VfsResourceType::File | VfsResourceType::Textbook => {
            // ★ 文件/教材：根据是否是 PDF 和 inject_modes 决定返回内容
            if is_pdf {
                // PDF 文件：根据 inject_modes.pdf 决定返回内容
                // ★ P2-1 修复（二轮审阅）：复用提前解析的 pdf_resolved_modes
                let (include_text, include_ocr, _include_image, _downgraded) =
                    pdf_resolved_modes.unwrap_or((true, true, true, false));

                info!(
                    "[PDF_DEBUG] PDF file: include_text={}, include_ocr={}",
                    include_text, include_ocr
                );

                let mut content_parts: Vec<String> = Vec::new();

                // OCR 模式：返回 OCR 页级文本
                if include_ocr {
                    if let Some(ocr_text) = get_ocr_pages_text_with_conn(conn, &r.source_id) {
                        info!(
                            "[PDF_DEBUG] PDF: adding OCR pages text, len={}",
                            ocr_text.len()
                        );
                        let formatted_ocr = format!(
                            "<pdf_ocr name=\"{}\">{}</pdf_ocr>",
                            escape_xml_attr(&title),
                            escape_xml_content(&ocr_text)
                        );
                        content_parts.push(formatted_ocr);
                    } else {
                        info!("[PDF_DEBUG] PDF: no OCR pages text available");
                    }
                }

                // 文本模式：返回解析提取的文本
                if include_text {
                    let text = extract_file_text_with_strategy(
                        conn,
                        &r.source_id,
                        &title,
                        raw_content.as_deref(),
                    );

                    if let Some(t) = text {
                        if !t.is_empty() {
                            info!("[PDF_DEBUG] PDF: adding extracted text, len={}", t.len());
                            content_parts.push(t);
                        }
                    }
                }

                // 合并内容
                if content_parts.is_empty() {
                    warn!("[PDF_DEBUG] No text available for PDF source_id={}, returning filename hint", r.source_id);
                    (
                        Some(format!("[文档: {}]", title)),
                        Some(format!("「{}」文本提取失败，该文档内容未能送入对话", title)),
                    )
                } else {
                    (Some(content_parts.join("\n\n")), None)
                }
            } else {
                // 非 PDF 文件：使用原有逻辑
                info!(
                    "[PDF_DEBUG] File/Textbook (non-PDF): calling extract_file_text_with_strategy"
                );
                let text = extract_file_text_with_strategy(
                    conn,
                    &r.source_id,
                    &title,
                    raw_content.as_deref(),
                );

                match text {
                    Some(t) if !t.is_empty() => {
                        info!(
                            "[PDF_DEBUG] extract_file_text_with_strategy returned {} chars",
                            t.len()
                        );
                        (Some(t), None)
                    }
                    _ => {
                        warn!("[PDF_DEBUG] No text available for source_id={}, returning filename hint", r.source_id);
                        (
                            Some(format!("[文档: {}]", title)),
                            Some(format!("「{}」文本提取失败，该文档内容未能送入对话", title)),
                        )
                    }
                }
            }
        }
        VfsResourceType::MindMap => {
            // ★ 2026-02-10 修复：MindMap 内容为 JSON 结构，需提取节点纯文本后注入
            // 避免将原始 JSON 语法噪声发送给 LLM
            info!(
                "[PDF_DEBUG] MindMap type: extracting node text from JSON, raw_content_len={}",
                raw_content.as_ref().map(|c| c.len()).unwrap_or(0)
            );
            if let Some(ref json_data) = raw_content {
                if let Some(extracted) = VfsContentExtractor::extract_mindmap_text(json_data) {
                    if !extracted.is_empty() {
                        info!(
                            "[PDF_DEBUG] MindMap: extracted {} chars of node text",
                            extracted.len()
                        );
                        (Some(extracted), None)
                    } else {
                        info!(
                            "[PDF_DEBUG] MindMap: extract_mindmap_text returned empty, using raw"
                        );
                        (raw_content, None)
                    }
                } else {
                    info!("[PDF_DEBUG] MindMap: extract_mindmap_text returned None, using raw");
                    (raw_content, None)
                }
            } else {
                (None, None)
            }
        }
        VfsResourceType::Note
        | VfsResourceType::Translation
        | VfsResourceType::Essay
        | VfsResourceType::Exam
        | VfsResourceType::Retrieval => {
            // Note/Translation/Essay/Exam/Retrieval：直接使用 resources.data 内容
            info!(
                "[PDF_DEBUG] {:?} type: using raw_content directly, has_content={}",
                r.resource_type,
                raw_content.is_some()
            );
            (raw_content, None)
        }
    };

    info!(
        "[PDF_DEBUG] final content: source_id={}, has_content={}, content_len={}",
        r.source_id,
        content.is_some(),
        content.as_ref().map(|c| c.len()).unwrap_or(0)
    );

    // ★ 获取多模态内容块（用于多模态模型直接传按页图片）
    // 根据 inject_modes 决定是否返回图片块
    let multimodal_blocks = match &r.resource_type {
        VfsResourceType::Exam => {
            get_exam_multimodal_blocks_with_conn(conn, blobs_dir, &r.source_id)
        }
        VfsResourceType::File | VfsResourceType::Textbook => {
            // PDF 文件：根据 inject_modes.pdf 是否包含 Image 决定是否返回多模态块
            if is_pdf {
                // ★ P2-1 修复（二轮审阅）：复用提前解析的 pdf_resolved_modes，不再重复调用
                let include_image = pdf_resolved_modes.map(|(_, _, img, _)| img).unwrap_or(true);

                if include_image {
                    let blocks =
                        get_file_multimodal_blocks_with_conn(conn, blobs_dir, &r.source_id);
                    info!(
                        "[PDF_DEBUG] multimodal_blocks for PDF: source_id={}, blocks_count={}",
                        r.source_id,
                        blocks.as_ref().map(|b| b.len()).unwrap_or(0)
                    );
                    blocks
                } else {
                    info!("[PDF_DEBUG] multimodal_blocks skipped for PDF (inject_modes.pdf does not include Image): source_id={}", r.source_id);
                    None
                }
            } else {
                // 非 PDF 文件不返回多模态块
                None
            }
        }
        // Note/Translation/Essay/MindMap/Image/Retrieval：无多模态块
        VfsResourceType::Note
        | VfsResourceType::Translation
        | VfsResourceType::Essay
        | VfsResourceType::MindMap
        | VfsResourceType::Image
        | VfsResourceType::Retrieval => None,
    };

    Ok(ResolvedResource {
        source_id: r.source_id.clone(),
        resource_hash: r.resource_hash.clone(),
        resource_type: r.resource_type.clone(),
        name: title,
        path,
        content,
        found: true,
        warning,
        multimodal_blocks,
    })
}

/// 获取资源的完整路径
///
/// 使用递归 CTE 查询构建路径
fn get_resource_path_with_conn(
    conn: &Connection,
    source_id: &str,
    _resource_type: &VfsResourceType,
) -> VfsResult<String> {
    // ★ FIX: 使用 source_id 作为路径末段而非标题
    // 之前使用标题（如 "有机合成完整笔记"）会导致前端 dstu.get(path) 时
    // extract_resource_info 无法从中提取 resource ID，报错：
    // "Invalid DSTU path: Path must contain a resource ID: {title}"
    // node.name 已包含人类可读标题用于显示，path 应包含可解析的 resource ID

    // 查找资源所在的文件夹
    let folder_id: Option<String> = conn
        .query_row(
            "SELECT folder_id FROM folder_items WHERE item_id = ?1",
            params![source_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();

    match folder_id {
        Some(fid) => {
            // 构建文件夹路径
            let folder_path = build_folder_path_with_conn(conn, &fid)?;
            Ok(format!("{}/{}", folder_path, source_id))
        }
        None => {
            // 资源在根级
            Ok(source_id.to_string())
        }
    }
}

/// 构建文件夹路径（向上追溯到根）
fn build_folder_path_with_conn(conn: &Connection, folder_id: &str) -> VfsResult<String> {
    // 使用 CTE 向上追溯到根
    let mut stmt = conn.prepare(
        r#"
        WITH RECURSIVE folder_path AS (
            SELECT id, parent_id, title, 1 as depth
            FROM folders WHERE id = ?1
            UNION ALL
            SELECT f.id, f.parent_id, f.title, fp.depth + 1
            FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
            WHERE fp.depth < 11
        )
        SELECT title FROM folder_path ORDER BY depth DESC
        "#,
    )?;

    let titles: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;

    Ok(titles.join("/"))
}

/// 获取资源内容
fn get_resource_content_with_conn(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    source_id: &str,
    resource_type: &VfsResourceType,
) -> VfsResult<Option<String>> {
    info!(
        "[PDF_DEBUG] get_resource_content_with_conn: source_id={}, resource_type={:?}",
        source_id, resource_type
    );

    // ★ 2026-02-09 修复：essay_session_ 没有 resource_id，需要聚合所有轮次内容
    if source_id.starts_with("essay_session_") {
        return get_essay_session_content_with_conn(conn, source_id);
    }

    // 先获取 resource_id
    let (inferred_type, table_name, _) = match get_source_id_type(source_id) {
        Some(info) => info,
        None => {
            info!(
                "[PDF_DEBUG] get_source_id_type returned None for source_id={}",
                source_id
            );
            return Ok(None);
        }
    };
    info!(
        "[PDF_DEBUG] get_source_id_type: source_id={}, inferred_type={:?}, table_name={}",
        source_id, inferred_type, table_name
    );

    let resource_id_sql = format!("SELECT resource_id FROM {} WHERE id = ?1", table_name);
    let resource_id: Option<String> = conn
        .query_row(&resource_id_sql, params![source_id], |row| row.get(0))
        .optional()?
        .flatten();
    info!(
        "[PDF_DEBUG] resource_id query: source_id={}, resource_id={:?}",
        source_id, resource_id
    );

    if let Some(res_id) = resource_id {
        // 从 resources 表获取内容
        // ★ 2026-01-30 修复：显式处理 NULL 值，避免 "Invalid column type Null" 错误
        let content: Option<String> = conn
            .query_row(
                "SELECT data FROM resources WHERE id = ?1",
                params![res_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        info!(
            "[PDF_DEBUG] resources table query: res_id={}, has_content={}, content_len={}",
            res_id,
            content.is_some(),
            content.as_ref().map(|c| c.len()).unwrap_or(0)
        );

        // ★ 修复：如果 content 为空字符串或 NULL，不要直接返回，回退到 blob 读取逻辑
        if let Some(ref c) = content {
            if !c.is_empty() {
                return Ok(content);
            }
            info!(
                "[PDF_DEBUG] resources.data is empty string, falling back to blob/special handling"
            );
        } else {
            info!("[PDF_DEBUG] resources.data is NULL, falling back to blob/special handling");
        }
    }

    info!("[PDF_DEBUG] No resource_id found, falling back to special type handling: resource_type={:?}", resource_type);

    // 特殊处理某些类型
    match resource_type {
        // ★ 已移除 Textbook 分支，合并到 Image/File/Textbook 分支
        // VfsResourceType::Textbook => { ... }
        VfsResourceType::Exam => {
            // 题目集返回 preview_json
            info!("[PDF_DEBUG] Exam branch: returning preview_json");
            let preview: Option<String> = conn
                .query_row(
                    "SELECT preview_json FROM exam_sheets WHERE id = ?1",
                    params![source_id],
                    |row| row.get(0),
                )
                .optional()?;
            info!(
                "[PDF_DEBUG] Exam preview_json len={}",
                preview.as_ref().map(|p| p.len()).unwrap_or(0)
            );
            Ok(preview)
        }
        VfsResourceType::Image | VfsResourceType::File | VfsResourceType::Textbook => {
            // ★ 修复：Textbook 类型也需要从 blob 读取 PDF 内容
            info!("[PDF_DEBUG] Image/File/Textbook branch: calling VfsFileRepo::get_content_with_conn");
            let result = VfsFileRepo::get_content_with_conn(conn, blobs_dir, source_id);
            match &result {
                Ok(Some(content)) => info!(
                    "[PDF_DEBUG] VfsFileRepo returned content, len={}",
                    content.len()
                ),
                Ok(None) => info!("[PDF_DEBUG] VfsFileRepo returned None"),
                Err(e) => info!("[PDF_DEBUG] VfsFileRepo returned error: {}", e),
            }
            result
        }
        VfsResourceType::MindMap => {
            // MindMap 内容在 resources.data 中（JSON 格式），此处返回 None 走上层逻辑
            info!(
                "[PDF_DEBUG] MindMap branch: returning None (content should be in resources.data)"
            );
            Ok(None)
        }
        // Note/Translation/Essay/Retrieval：内容在 resources.data 中，此处返回 None 走上层逻辑
        VfsResourceType::Note
        | VfsResourceType::Translation
        | VfsResourceType::Essay
        | VfsResourceType::Retrieval => {
            info!(
                "[PDF_DEBUG] {:?} branch: returning None (content should be in resources.data)",
                resource_type
            );
            Ok(None)
        }
    }
}

/// ★ 2026-02-09 新增：获取作文会话的聚合内容
///
/// essay_sessions 没有 resource_id，需要从关联的 essays 中聚合内容。
/// 参照 DSTU content_helpers 的实现，汇总所有轮次。
///
/// ## 参数
/// - `conn`: 数据库连接
/// - `session_id`: 会话 ID (essay_session_xxx)
///
/// ## 返回
/// - `Ok(Some(String))`: 聚合后的所有轮次内容
/// - `Ok(None)`: 会话不存在或无轮次
fn get_essay_session_content_with_conn(
    conn: &Connection,
    session_id: &str,
) -> VfsResult<Option<String>> {
    const MAX_CHARS: usize = 20000;
    const MAX_ROUNDS: usize = 10;

    // 1. 获取会话信息
    let session_info: Option<(String, Option<String>, i32)> = conn
        .query_row(
            r#"
            SELECT COALESCE(title, ''), essay_type, total_rounds
            FROM essay_sessions
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;

    let (title, essay_type, total_rounds) = match session_info {
        Some(info) => info,
        None => return Ok(None),
    };

    // 2. 获取该会话下的所有作文轮次
    let mut stmt = conn.prepare(
        r#"
        SELECT e.round_number, r.data
        FROM essays e
        LEFT JOIN resources r ON e.resource_id = r.id
        WHERE e.session_id = ?1 AND e.deleted_at IS NULL
        ORDER BY e.round_number ASC, e.created_at ASC
        "#,
    )?;

    let rows: Vec<(i32, Option<String>)> = stmt
        .query_map(params![session_id], |row| {
            Ok((row.get(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        // 有会话但无轮次 → 返回会话元信息
        let display_title = if title.is_empty() {
            "未命名".to_string()
        } else {
            title
        };
        return Ok(Some(format!(
            "# 作文会话: {}\n类型: {}, 总轮次: {}",
            display_title,
            essay_type.as_deref().unwrap_or("未知"),
            total_rounds
        )));
    }

    // 3. 聚合内容（带字符数上限保护）
    let mut parts: Vec<String> = Vec::new();
    let mut total_chars: usize = 0;
    let mut truncated = false;

    let display_title = if title.is_empty() {
        "未命名".to_string()
    } else {
        title
    };
    let header = format!(
        "# 作文会话: {}\n类型: {}, 总轮次: {}",
        display_title,
        essay_type.as_deref().unwrap_or("未知"),
        total_rounds
    );
    total_chars += header.chars().count();
    parts.push(header);

    let rounds_to_take = MAX_ROUNDS.min(rows.len());
    if rows.len() > rounds_to_take {
        truncated = true;
    }

    for (round_number, content) in rows.iter().take(rounds_to_take) {
        let round_header = format!("\n## 第 {} 轮", round_number);
        total_chars += round_header.chars().count();
        if total_chars >= MAX_CHARS {
            truncated = true;
            break;
        }
        parts.push(round_header);

        if let Some(c) = content {
            let remaining = MAX_CHARS.saturating_sub(total_chars);
            let char_count = c.chars().count();
            if char_count > remaining {
                let truncated_content: String = c.chars().take(remaining).collect();
                parts.push(truncated_content);
                total_chars = MAX_CHARS;
                truncated = true;
                break;
            }
            total_chars += char_count;
            parts.push(c.clone());
        }
    }

    if truncated {
        parts.push("\n\n[内容过长，已截断]".to_string());
    }

    info!(
        "[VFS::RefHandlers] essay_session content: session_id={}, rounds={}, chars={}",
        session_id, rounds_to_take, total_chars
    );

    Ok(Some(parts.join("\n")))
}

/// 获取图片的 OCR 文本
///
/// 从 files 表关联的 resources.ocr_text 获取图片的 OCR 文本
///
/// ## 参数
/// - `conn`: 数据库连接
/// - `source_id`: 图片附件 ID (file_xxx, att_xxx)
///
/// ## 返回
/// - `Some(String)`: OCR 文本
/// - `None`: 没有 OCR 文本
pub fn get_image_ocr_text_with_conn(conn: &Connection, source_id: &str) -> Option<String> {
    info!(
        "[OCR_DIAG] get_image_ocr_text_with_conn: querying OCR text for source_id={}",
        source_id
    );

    // ★ 诊断：先检查 files 表中是否存在该 source_id
    let check_files_sql = r#"
        SELECT a.id, a.resource_id, a.file_name
        FROM files a
        WHERE a.id = ?1 OR a.resource_id = ?1
        ORDER BY CASE WHEN a.id = ?1 THEN 0 ELSE 1 END
        LIMIT 1
    "#;
    match conn.query_row(check_files_sql, params![source_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    }) {
        Ok((file_id, resource_id, file_name)) => {
            info!(
                "[OCR_DIAG] files table match: source_id={} -> file_id={}, resource_id={:?}, file_name={:?}",
                source_id, file_id, resource_id, file_name
            );
        }
        Err(e) => {
            warn!(
                "[OCR_DIAG] files table NO MATCH for source_id={}: {}. This means the SQL JOIN will fail and no OCR text can be retrieved.",
                source_id, e
            );
        }
    }

    // ★ 诊断：检查关联的 resource 是否有 ocr_text
    let check_ocr_sql = r#"
        SELECT r.id, r.ocr_text IS NOT NULL AS has_ocr, LENGTH(r.ocr_text) AS ocr_len
        FROM files a
        JOIN resources r ON a.resource_id = r.id
        WHERE a.id = ?1 OR a.resource_id = ?1
        ORDER BY CASE WHEN a.id = ?1 THEN 0 ELSE 1 END
        LIMIT 1
    "#;
    match conn.query_row(check_ocr_sql, params![source_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, bool>(1)?,
            row.get::<_, Option<i64>>(2)?,
        ))
    }) {
        Ok((resource_id, has_ocr, ocr_len)) => {
            info!(
                "[OCR_DIAG] resource OCR status: source_id={} -> resource_id={}, has_ocr={}, ocr_len={:?}",
                source_id, resource_id, has_ocr, ocr_len
            );
        }
        Err(e) => {
            warn!(
                "[OCR_DIAG] resource OCR check failed for source_id={}: {}",
                source_id, e
            );
        }
    }

    // 尝试从 files 表关联的 resource 获取 OCR 文本
    let sql = r#"
        SELECT r.ocr_text
        FROM files a
        JOIN resources r ON a.resource_id = r.id
        WHERE a.id = ?1 OR a.resource_id = ?1
        ORDER BY CASE WHEN a.id = ?1 THEN 0 ELSE 1 END
        LIMIT 1
    "#;

    match conn.query_row(sql, params![source_id], |row| {
        row.get::<_, Option<String>>(0)
    }) {
        Ok(Some(text)) if !text.trim().is_empty() => {
            info!(
                "[OCR_DIAG] OCR text FOUND for source_id={}, len={}, preview=\"{}\"",
                source_id,
                text.len(),
                text.chars().take(100).collect::<String>()
            );
            Some(text)
        }
        Ok(Some(_)) => {
            warn!(
                "[OCR_DIAG] OCR text exists but is EMPTY/WHITESPACE for source_id={}",
                source_id
            );
            None
        }
        Ok(None) => {
            warn!(
                "[OCR_DIAG] OCR text is NULL in database for source_id={}. Possible causes: (1) OCR pipeline not yet completed, (2) OCR failed silently, (3) image was not processed",
                source_id
            );
            None
        }
        Err(e) => {
            warn!(
                "[OCR_DIAG] OCR text query FAILED for source_id={}: {}. Possible cause: source_id not found in files table (JOIN returned no rows)",
                source_id, e
            );
            None
        }
    }
}

/// 获取文件的 extracted_text 字段
///
/// 公开供其他模块调用（统一文本抽取策略）
pub fn get_extracted_text_with_conn(conn: &Connection, source_id: &str) -> Option<String> {
    let sql = r#"
        SELECT extracted_text
        FROM files
        WHERE id = ?1 OR resource_id = ?1
        ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END
        LIMIT 1
    "#;
    conn.query_row(sql, params![source_id], |row| row.get(0))
        .ok()
        .flatten()
        .filter(|t: &String| !t.trim().is_empty())
}

/// 从 ocr_pages_json 获取 PDF 的页级 OCR 文本
///
/// 将所有非空页的 OCR 文本拼接返回
///
/// 公开供其他模块调用（统一文本抽取策略）
pub fn get_ocr_pages_text_with_conn(conn: &Connection, source_id: &str) -> Option<String> {
    let sql = r#"
        SELECT ocr_pages_json
        FROM files
        WHERE id = ?1 OR resource_id = ?1
        ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END
        LIMIT 1
    "#;

    let ocr_json: Option<String> = conn
        .query_row(sql, params![source_id], |row| row.get(0))
        .ok()
        .flatten();

    let ocr_json = ocr_json?;
    if ocr_json.trim().is_empty() {
        return None;
    }

    let pages = parse_ocr_pages_json(&ocr_json);
    if pages.is_empty() {
        return None;
    }

    join_ocr_pages_text(&pages, "第", "页")
}

/// 获取资源标题
fn get_resource_title_with_conn(
    conn: &Connection,
    source_id: &str,
    resource_type: &VfsResourceType,
) -> VfsResult<Option<String>> {
    let (_, table_name, title_column) = match get_source_id_type(source_id) {
        Some(info) => info,
        None => return Ok(None),
    };

    let sql = format!(
        "SELECT {} FROM {} WHERE id = ?1 AND deleted_at IS NULL",
        title_column, table_name
    );

    let title: Option<String> = conn
        .query_row(&sql, params![source_id], |row| row.get(0))
        .optional()?;

    Ok(title)
}

/// 根据 sourceId 前缀获取资源类型信息
///
/// 返回 (VfsResourceType, 表名, 标题列名)
///
/// ★ 注意：附件类型 (att_) 需要查询数据库才能确定是 Image 还是 File
/// ★ 2026-02-09 修复：essay_session_ 必须在 essay_ 之前检查，否则会被错误匹配到 essays 表
fn get_source_id_type(source_id: &str) -> Option<(VfsResourceType, &'static str, &'static str)> {
    if source_id.starts_with("note_") {
        Some((VfsResourceType::Note, "notes", "title"))
    } else if source_id.starts_with("mm_") {
        Some((VfsResourceType::MindMap, "mindmaps", "title"))
    } else if source_id.starts_with("tb_") {
        // ★ 2026-02-09 修复：tb_ 映射为 Textbook（与前端 inferTypeFromSourceId 一致）
        // 数据仍存储在 files 表（Migration032 后教材统一到 files 表）
        Some((VfsResourceType::Textbook, "files", "file_name"))
    } else if source_id.starts_with("file_") || source_id.starts_with("att_") {
        Some((VfsResourceType::File, "files", "file_name"))
    } else if source_id.starts_with("exam_") {
        Some((
            VfsResourceType::Exam,
            "exam_sheets",
            "COALESCE(exam_name, id)",
        ))
    } else if source_id.starts_with("tr_") {
        Some((
            VfsResourceType::Translation,
            "translations",
            "COALESCE(title, id)",
        ))
    } else if source_id.starts_with("essay_session_") {
        // ★ 2026-02-09: essay_session_ 必须在 essay_ 之前检查！
        // essay_sessions 表没有 resource_id 列，需要在调用方做特殊处理
        Some((
            VfsResourceType::Essay,
            "essay_sessions",
            "COALESCE(title, id)",
        ))
    } else if source_id.starts_with("essay_") {
        Some((VfsResourceType::Essay, "essays", "COALESCE(title, id)"))
    } else {
        None
    }
}

/// 查询附件的实际类型（image 或 file）
///
/// 从 files 表的 type 字段获取精确类型
fn get_attachment_type_with_conn(conn: &Connection, source_id: &str) -> VfsResourceType {
    let result: Option<String> = conn
        .query_row(
            "SELECT type FROM files WHERE id = ?1 AND deleted_at IS NULL",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();

    match result.as_deref() {
        Some("image") => VfsResourceType::Image,
        Some("file") => VfsResourceType::File,
        _ => VfsResourceType::File, // 默认当作文档
    }
}

/// ★ 获取题目集的多模态内容块
///
/// 从 exam_sheets.preview_json 解析页面图片和 OCR 文本，
/// 返回图文交替的 MultimodalContentBlock 列表。
///
/// ## 参数
/// - `conn`: 数据库连接
/// - `blobs_dir`: Blob 文件存储目录
/// - `exam_id`: 题目集 ID (exam_xxx)
///
/// ## 返回
/// - `Some(Vec<MultimodalContentBlock>)`: 多模态内容块列表
/// - `None`: 无多模态内容或解析失败
fn get_exam_multimodal_blocks_with_conn(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    exam_id: &str,
) -> Option<Vec<MultimodalContentBlock>> {
    use crate::vfs::repos::VfsBlobRepo;
    use base64::Engine;

    // 获取 preview_json
    let sql = "SELECT preview_json FROM exam_sheets WHERE id = ?1";
    let preview_json: Option<String> = conn
        .query_row(sql, params![exam_id], |row| row.get(0))
        .ok()?;

    let preview_json = preview_json?;
    let preview: serde_json::Value = match serde_json::from_str(&preview_json) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                "[VFS::RefHandlers] Failed to parse preview_json for exam_id={}: {}",
                exam_id, e
            );
            return None;
        }
    };

    let mut blocks = Vec::new();

    // 遍历 pages
    if let Some(pages) = preview.get("pages").and_then(|p| p.as_array()) {
        for page in pages {
            // 获取页面图片
            if let Some(blob_hash) = page.get("blobHash").and_then(|h| h.as_str()) {
                // 从 blobs 获取图片文件路径
                if let Ok(Some(blob_path)) =
                    VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, blob_hash)
                {
                    // 读取文件内容并编码为 base64
                    if let Ok(content) = std::fs::read(&blob_path) {
                        let base64_content =
                            base64::engine::general_purpose::STANDARD.encode(&content);
                        let mime_type = page
                            .get("mimeType")
                            .and_then(|m| m.as_str())
                            .unwrap_or("image/png")
                            .to_string();
                        blocks.push(MultimodalContentBlock::image(mime_type, base64_content));
                    }
                }
            }

            // 获取该页的 OCR 文本
            if let Some(cards) = page.get("cards").and_then(|c| c.as_array()) {
                let mut page_text = String::new();
                for card in cards {
                    if let Some(label) = card.get("questionLabel").and_then(|l| l.as_str()) {
                        if let Some(ocr) = card.get("ocrText").and_then(|o| o.as_str()) {
                            page_text.push_str(&format!(
                                "<question label=\"{}\">{}</question>\n",
                                escape_xml_attr(label),
                                escape_xml_content(ocr)
                            ));
                        }
                    }
                }
                if !page_text.is_empty() {
                    blocks.push(MultimodalContentBlock::text(page_text));
                }
            }
        }
    }

    if blocks.is_empty() {
        None
    } else {
        debug!(
            "[VFS::RefHandlers] Got {} multimodal blocks for exam {}",
            blocks.len(),
            exam_id
        );
        Some(blocks)
    }
}

/// 获取 PDF 文件的多模态内容块（从 preview_json 中获取按页图片和 OCR 文本）
///
/// 与 `get_exam_multimodal_blocks_with_conn` 类似，但从 files 表获取数据
/// 同时返回图片块和对应的 OCR 文本块
fn get_file_multimodal_blocks_with_conn(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    file_id: &str,
) -> Option<Vec<MultimodalContentBlock>> {
    use crate::vfs::repos::VfsBlobRepo;
    use base64::Engine;

    // 获取 preview_json、ocr_pages_json 和 file_name
    let sql = r#"
        SELECT preview_json, ocr_pages_json, file_name
        FROM files
        WHERE id = ?1 OR resource_id = ?1
        ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END
        LIMIT 1
    "#;
    let (preview_json, ocr_pages_json, file_name): (
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(sql, params![file_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .ok()?;

    let preview_json = preview_json?;
    if preview_json.trim().is_empty() {
        return None;
    }

    let preview: serde_json::Value = match serde_json::from_str(&preview_json) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                "[VFS::RefHandlers] Failed to parse preview_json for file_id={}: {}",
                file_id, e
            );
            return None;
        }
    };

    // 解析 ocr_pages_json（兼容不同格式）
    let ocr_pages: Vec<Option<String>> = ocr_pages_json
        .as_deref()
        .map(parse_ocr_pages_json)
        .unwrap_or_default();

    let mut blocks = Vec::new();
    let display_name = file_name.unwrap_or_else(|| file_id.to_string());

    // 遍历 pages
    if let Some(pages) = preview.get("pages").and_then(|p| p.as_array()) {
        for (page_index, page) in pages.iter().enumerate() {
            // ★ P0 架构改造：优先使用压缩版本的 blob hash
            // 支持 compressedBlobHash/compressed_blob_hash 字段（预处理时生成）
            let compressed_hash = page
                .get("compressedBlobHash")
                .or_else(|| page.get("compressed_blob_hash"))
                .and_then(|h| h.as_str());

            // 获取页面原始图片 hash（支持 blobHash 或 blob_hash）
            let original_hash = page
                .get("blobHash")
                .or_else(|| page.get("blob_hash"))
                .and_then(|h| h.as_str());

            let mut selected_content: Option<(Vec<u8>, bool)> = None;
            if let (Some(ch), Some(oh)) = (compressed_hash, original_hash) {
                if ch != oh {
                    if let Ok(Some(blob_path)) =
                        VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, ch)
                    {
                        if let Ok(content) = std::fs::read(&blob_path) {
                            selected_content = Some((content, true));
                        }
                    }
                }
            }

            if selected_content.is_none() {
                if let Some(hash) = original_hash {
                    if let Ok(Some(blob_path)) =
                        VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, hash)
                    {
                        if let Ok(content) = std::fs::read(&blob_path) {
                            selected_content = Some((content, false));
                        }
                    }
                }
            }

            if let Some((content, is_compressed)) = selected_content {
                let base64_content = base64::engine::general_purpose::STANDARD.encode(&content);
                let mime_type = if is_compressed {
                    "image/jpeg".to_string()
                } else {
                    page.get("mimeType")
                        .or_else(|| page.get("mime_type"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("image/png")
                        .to_string()
                };
                let page_number = page_index + 1;
                let label = format!(
                    "[PDF@{}:{}] {} 第{}页",
                    file_id, page_number, display_name, page_number
                );
                blocks.push(MultimodalContentBlock::text(format!(
                    "<pdf_page name=\"{}\" source_id=\"{}\" page=\"{}\">{}</pdf_page>",
                    escape_xml_attr(&display_name),
                    escape_xml_attr(file_id),
                    page_number,
                    escape_xml_content(&label)
                )));
                blocks.push(MultimodalContentBlock::image(mime_type, base64_content));
            }

            // 添加该页的 OCR 文本块（如果有）
            if let Some(Some(ocr_text)) = ocr_pages.get(page_index) {
                if !ocr_text.trim().is_empty() {
                    blocks.push(MultimodalContentBlock::text(format!(
                        "<page number=\"{}\">{}</page>",
                        page_index + 1,
                        escape_xml_content(ocr_text)
                    )));
                }
            }
        }
    }

    if blocks.is_empty() {
        None
    } else {
        debug!(
            "[VFS::RefHandlers] Got {} multimodal blocks for file {}",
            blocks.len(),
            file_id
        );
        Some(blocks)
    }
}

// ============================================================================
// 统一文本抽取策略（公共函数）
// ============================================================================

/// ★ 统一文本抽取策略（T02 修复）
///
/// 对 File/Textbook 类型资源，按以下优先级获取文本：
/// 1. 获取 OCR 结果 (`ocr_pages_json`)
/// 2. 获取直接解析结果 (`extracted_text`)
/// 3. 如果两者都不足，尝试 `DocumentParser` 实时解析
/// 4. 取"更长者"作为最终结果
///
/// ## 参数
/// - `conn`: 数据库连接
/// - `source_id`: 资源 ID（file_xxx, tb_xxx, att_xxx）
/// - `file_name`: 文件名（用于 DocumentParser 确定类型）
/// - `base64_content`: 可选的 base64 编码文件内容（用于 DocumentParser 回退）
///
/// ## 返回
/// - `Some(String)`: 提取的文本内容
/// - `None`: 无法提取文本（返回前应生成占位提示）
pub fn extract_file_text_with_strategy(
    conn: &Connection,
    source_id: &str,
    file_name: &str,
    base64_content: Option<&str>,
) -> Option<String> {
    const TEXT_THRESHOLD: usize = 1000;

    // 1. 获取 OCR 结果 (ocr_pages_json)
    let ocr_text = get_ocr_pages_text_with_conn(conn, source_id);
    let ocr_len = ocr_text.as_ref().map(|t| t.len()).unwrap_or(0);
    debug!(
        "[TextExtract] OCR text for source_id={}: len={}",
        source_id, ocr_len
    );

    // 2. 获取直接解析结果 (extracted_text)
    let extracted_text = get_extracted_text_with_conn(conn, source_id);
    let mut parsed_text = extracted_text.clone();

    // 3. 如果没有 extracted_text 或内容过短，尝试 DocumentParser 实时解析
    if parsed_text.is_none() || parsed_text.as_ref().map(|t| t.len()).unwrap_or(0) < TEXT_THRESHOLD
    {
        if let Some(base64) = base64_content {
            if !base64.is_empty() {
                debug!(
                    "[TextExtract] Trying DocumentParser for source_id={}, base64_len={}",
                    source_id,
                    base64.len()
                );
                let parser = DocumentParser::new();
                if let Ok(text) = parser.extract_text_from_base64(file_name, base64) {
                    if text.len() > parsed_text.as_ref().map(|t| t.len()).unwrap_or(0) {
                        debug!("[TextExtract] DocumentParser result: {} chars", text.len());
                        parsed_text = Some(text);
                    }
                }
            }
        }
    }
    let parsed_len = parsed_text.as_ref().map(|t| t.len()).unwrap_or(0);
    debug!(
        "[TextExtract] Parsed text for source_id={}: len={}",
        source_id, parsed_len
    );

    // 4. 取大者（OCR 和 解析结果比较）
    if ocr_len > parsed_len {
        debug!(
            "[TextExtract] Using OCR text (larger): {} > {}",
            ocr_len, parsed_len
        );
        ocr_text
    } else if parsed_len > 0 {
        debug!(
            "[TextExtract] Using parsed text: {} >= {}",
            parsed_len, ocr_len
        );
        parsed_text
    } else if ocr_len > 0 {
        debug!("[TextExtract] Using OCR text (only available): {}", ocr_len);
        ocr_text
    } else {
        debug!(
            "[TextExtract] No text available for source_id={}",
            source_id
        );
        None
    }
}

/// 转义 XML 属性值
fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// 转义 XML 内容
fn escape_xml_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

// ============================================================================
// 公共辅助函数（供其他模块调用）
// ============================================================================

/// ★ 获取资源的文件夹路径（供 DSTU 层调用）
///
/// 根据 sourceId 获取资源的完整文件夹层级路径。
///
/// ## 参数
/// - `vfs_db`: VFS 数据库实例
/// - `source_id`: 资源 ID（note_xxx, tb_xxx 等）
///
/// ## 返回
/// - `Ok(String)`: 完整路径，如 "高考复习/函数/note_abc123"（末段是 source_id，非标题）
/// - `Err(VfsError)`: 错误信息
pub fn get_resource_path_internal(vfs_db: &Arc<VfsDatabase>, source_id: &str) -> VfsResult<String> {
    let conn = vfs_db.get_conn_safe()?;

    // 获取资源类型
    let resource_type = match get_source_id_type(source_id) {
        Some((rt, _, _)) => rt,
        None => return Ok(source_id.to_string()), // 未知类型，返回 sourceId 作为路径
    };

    get_resource_path_with_conn(&conn, source_id, &resource_type)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------------
    // 测试辅助函数：创建内存数据库
    // ------------------------------------------------------------------------

    /// 创建内存数据库并初始化 files 表
    fn create_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");

        // 创建 files 表，包含 OCR 和 extracted_text 字段
        conn.execute(
            r#"
            CREATE TABLE files (
                id TEXT PRIMARY KEY,
                file_name TEXT NOT NULL,
                extracted_text TEXT,
                ocr_pages_json TEXT,
                resource_id TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create files table");

        conn
    }

    /// 插入测试文件记录
    fn insert_test_file(
        conn: &Connection,
        id: &str,
        file_name: &str,
        extracted_text: Option<&str>,
        ocr_pages_json: Option<&str>,
    ) {
        conn.execute(
            r#"
            INSERT INTO files (id, file_name, extracted_text, ocr_pages_json)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![id, file_name, extracted_text, ocr_pages_json],
        )
        .expect("Failed to insert test file");
    }

    fn insert_test_file_with_resource_id(
        conn: &Connection,
        id: &str,
        resource_id: &str,
        file_name: &str,
        extracted_text: Option<&str>,
        ocr_pages_json: Option<&str>,
    ) {
        conn.execute(
            r#"
            INSERT INTO files (id, resource_id, file_name, extracted_text, ocr_pages_json)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![id, resource_id, file_name, extracted_text, ocr_pages_json],
        )
        .expect("Failed to insert test file with resource_id");
    }

    // ------------------------------------------------------------------------
    // extract_file_text_with_strategy 测试
    // ------------------------------------------------------------------------

    #[test]
    fn test_extract_file_text_ocr_priority() {
        // 测试：当 OCR 文本比 extracted_text 更长时，应优先使用 OCR
        let conn = create_test_db();

        let ocr_json = r#"["这是第一页的OCR文本，内容很长很长很长很长很长很长很长很长很长很长很长很长", "这是第二页的OCR文本，同样很长很长很长很长很长很长很长很长很长很长很长很长"]"#;
        let extracted = "短文本";

        insert_test_file(
            &conn,
            "file_001",
            "test.pdf",
            Some(extracted),
            Some(ocr_json),
        );

        let result = extract_file_text_with_strategy(&conn, "file_001", "test.pdf", None);

        assert!(result.is_some());
        let text = result.unwrap();
        // OCR 文本应包含页码标记
        assert!(text.contains("--- 第 1 页 ---"));
        assert!(text.contains("--- 第 2 页 ---"));
        assert!(text.contains("这是第一页的OCR文本"));
    }

    #[test]
    fn test_extract_file_text_extracted_fallback() {
        // 测试：当没有 OCR 时，应使用 extracted_text
        let conn = create_test_db();

        let extracted =
            "这是从文档中提取的文本内容，比较长，足够使用。包含很多字符以确保测试有效。";

        insert_test_file(&conn, "file_002", "test.docx", Some(extracted), None);

        let result = extract_file_text_with_strategy(&conn, "file_002", "test.docx", None);

        assert!(result.is_some());
        assert_eq!(result.unwrap(), extracted);
    }

    #[test]
    fn test_extract_file_text_empty_ocr() {
        // 测试：当 OCR 为空数组时，应回退到 extracted_text
        let conn = create_test_db();

        let ocr_json = r#"[null, "", null]"#;
        let extracted = "提取的文本内容";

        insert_test_file(
            &conn,
            "file_003",
            "test.pdf",
            Some(extracted),
            Some(ocr_json),
        );

        let result = extract_file_text_with_strategy(&conn, "file_003", "test.pdf", None);

        assert!(result.is_some());
        assert_eq!(result.unwrap(), extracted);
    }

    #[test]
    fn test_extract_file_text_no_content() {
        // 测试：当既没有 OCR 也没有 extracted_text 时，返回 None
        let conn = create_test_db();

        insert_test_file(&conn, "file_004", "test.pdf", None, None);

        let result = extract_file_text_with_strategy(&conn, "file_004", "test.pdf", None);

        assert!(result.is_none());
    }

    #[test]
    fn test_extract_file_text_nonexistent_file() {
        // 测试：当文件不存在时，返回 None
        let conn = create_test_db();

        let result = extract_file_text_with_strategy(&conn, "file_nonexistent", "test.pdf", None);

        assert!(result.is_none());
    }

    #[test]
    fn test_extract_file_text_by_resource_id() {
        // 测试：当传入的是 resource_id 时，也应能读取 OCR / extracted_text
        let conn = create_test_db();
        let ocr_json = r#"["resource id OCR text"]"#;

        insert_test_file_with_resource_id(
            &conn,
            "file_010",
            "res_010",
            "test.pdf",
            Some("resource id extracted text"),
            Some(ocr_json),
        );

        let by_resource = extract_file_text_with_strategy(&conn, "res_010", "test.pdf", None);
        assert!(by_resource.is_some());
        let text = by_resource.unwrap();
        assert!(text.contains("resource id"));
    }

    #[test]
    fn test_extract_file_text_longer_wins() {
        // 测试：取"更长者"策略 - extracted_text 更长时使用它
        let conn = create_test_db();

        let ocr_json = r#"["短OCR"]"#;
        let extracted = "这是一段非常非常非常非常非常非常非常非常非常非常非常非常非常长的提取文本，远远超过OCR的长度";

        insert_test_file(
            &conn,
            "file_005",
            "test.pdf",
            Some(extracted),
            Some(ocr_json),
        );

        let result = extract_file_text_with_strategy(&conn, "file_005", "test.pdf", None);

        assert!(result.is_some());
        let text = result.unwrap();
        // 应该使用更长的 extracted_text
        assert!(text.contains("非常非常非常"));
        assert!(!text.contains("--- 第")); // 不应包含 OCR 页码标记
    }

    #[test]
    fn test_extract_file_text_whitespace_only_extracted() {
        // 测试：当 extracted_text 只包含空白时，应被忽略
        let conn = create_test_db();

        let ocr_json = r#"["有效的OCR文本内容"]"#;
        let extracted = "   \n\t  ";

        insert_test_file(
            &conn,
            "file_006",
            "test.pdf",
            Some(extracted),
            Some(ocr_json),
        );

        let result = extract_file_text_with_strategy(&conn, "file_006", "test.pdf", None);

        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("有效的OCR文本内容"));
    }

    // ------------------------------------------------------------------------
    // get_ocr_pages_text_with_conn 测试
    // ------------------------------------------------------------------------

    #[test]
    fn test_get_ocr_pages_text_valid() {
        let conn = create_test_db();

        let ocr_json = r#"["第一页内容", "第二页内容", "第三页内容"]"#;
        insert_test_file(&conn, "file_ocr_1", "test.pdf", None, Some(ocr_json));

        let result = get_ocr_pages_text_with_conn(&conn, "file_ocr_1");

        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("--- 第 1 页 ---"));
        assert!(text.contains("第一页内容"));
        assert!(text.contains("--- 第 2 页 ---"));
        assert!(text.contains("第二页内容"));
        assert!(text.contains("--- 第 3 页 ---"));
        assert!(text.contains("第三页内容"));
    }

    #[test]
    fn test_get_ocr_pages_text_with_nulls() {
        let conn = create_test_db();

        // 某些页面为 null
        let ocr_json = r#"["第一页", null, "第三页", null]"#;
        insert_test_file(&conn, "file_ocr_2", "test.pdf", None, Some(ocr_json));

        let result = get_ocr_pages_text_with_conn(&conn, "file_ocr_2");

        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("--- 第 1 页 ---"));
        assert!(text.contains("第一页"));
        assert!(text.contains("--- 第 3 页 ---"));
        assert!(text.contains("第三页"));
        // 不应包含空页
        assert!(!text.contains("--- 第 2 页 ---"));
        assert!(!text.contains("--- 第 4 页 ---"));
    }

    #[test]
    fn test_get_ocr_pages_text_empty_array() {
        let conn = create_test_db();

        let ocr_json = r#"[]"#;
        insert_test_file(&conn, "file_ocr_3", "test.pdf", None, Some(ocr_json));

        let result = get_ocr_pages_text_with_conn(&conn, "file_ocr_3");

        assert!(result.is_none());
    }

    #[test]
    fn test_get_ocr_pages_text_all_empty() {
        let conn = create_test_db();

        let ocr_json = r#"["", "  ", null]"#;
        insert_test_file(&conn, "file_ocr_4", "test.pdf", None, Some(ocr_json));

        let result = get_ocr_pages_text_with_conn(&conn, "file_ocr_4");

        assert!(result.is_none());
    }

    #[test]
    fn test_get_ocr_pages_text_invalid_json() {
        let conn = create_test_db();

        let ocr_json = "not a valid json";
        insert_test_file(&conn, "file_ocr_5", "test.pdf", None, Some(ocr_json));

        let result = get_ocr_pages_text_with_conn(&conn, "file_ocr_5");

        assert!(result.is_none());
    }

    // ------------------------------------------------------------------------
    // get_extracted_text_with_conn 测试
    // ------------------------------------------------------------------------

    #[test]
    fn test_get_extracted_text_valid() {
        let conn = create_test_db();

        insert_test_file(
            &conn,
            "file_ext_1",
            "test.pdf",
            Some("提取的文本内容"),
            None,
        );

        let result = get_extracted_text_with_conn(&conn, "file_ext_1");

        assert!(result.is_some());
        assert_eq!(result.unwrap(), "提取的文本内容");
    }

    #[test]
    fn test_get_extracted_text_empty() {
        let conn = create_test_db();

        insert_test_file(&conn, "file_ext_2", "test.pdf", Some(""), None);

        let result = get_extracted_text_with_conn(&conn, "file_ext_2");

        assert!(result.is_none());
    }

    #[test]
    fn test_get_extracted_text_whitespace_only() {
        let conn = create_test_db();

        insert_test_file(&conn, "file_ext_3", "test.pdf", Some("   \n\t  "), None);

        let result = get_extracted_text_with_conn(&conn, "file_ext_3");

        assert!(result.is_none());
    }

    #[test]
    fn test_get_extracted_text_none() {
        let conn = create_test_db();

        insert_test_file(&conn, "file_ext_4", "test.pdf", None, None);

        let result = get_extracted_text_with_conn(&conn, "file_ext_4");

        assert!(result.is_none());
    }

    // ------------------------------------------------------------------------
    // get_source_id_type 测试
    // ------------------------------------------------------------------------

    #[test]
    fn test_get_source_id_type() {
        // 笔记
        let (t, table, col) = get_source_id_type("note_abc123").unwrap();
        assert_eq!(t, VfsResourceType::Note);
        assert_eq!(table, "notes");
        assert_eq!(col, "title");

        // 教材（★ 2026-02-09：tb_ 映射为 Textbook，与前端一致；数据仍在 files 表）
        let (t, table, col) = get_source_id_type("tb_xyz789").unwrap();
        assert_eq!(t, VfsResourceType::Textbook);
        assert_eq!(table, "files");
        assert_eq!(col, "file_name");

        // 题目集
        let (t, table, _) = get_source_id_type("exam_def456").unwrap();
        assert_eq!(t, VfsResourceType::Exam);
        assert_eq!(table, "exam_sheets");

        // 翻译（★ 2026-02-09 改进：title_column 改为 COALESCE(title, id)）
        let (t, table, col) = get_source_id_type("tr_ghi789").unwrap();
        assert_eq!(t, VfsResourceType::Translation);
        assert_eq!(table, "translations");
        assert_eq!(col, "COALESCE(title, id)");

        // ★ 2026-02-09 修复：作文会话必须映射到 essay_sessions 表
        let (t, table, col) = get_source_id_type("essay_session_abc123").unwrap();
        assert_eq!(t, VfsResourceType::Essay);
        assert_eq!(table, "essay_sessions");
        assert_eq!(col, "COALESCE(title, id)");

        // 作文轮次仍然映射到 essays 表
        let (t, table, _) = get_source_id_type("essay_jkl012").unwrap();
        assert_eq!(t, VfsResourceType::Essay);
        assert_eq!(table, "essays");

        // 附件（默认返回 File，实际类型需通过 get_attachment_type_with_conn 查询）
        let (t, table, col) = get_source_id_type("att_mno345").unwrap();
        assert_eq!(t, VfsResourceType::File);
        assert_eq!(table, "files");
        assert_eq!(col, "file_name");

        // 未知
        assert!(get_source_id_type("unknown_abc").is_none());
        assert!(get_source_id_type("abc123").is_none());
    }

    /// ★ 2026-02-09：essay_session_ 前缀不能被 essay_ 吞掉
    #[test]
    fn test_get_source_id_type_essay_session_priority() {
        // essay_session_ 必须匹配到 essay_sessions 表
        let (t, table, _) = get_source_id_type("essay_session_e8ZwCj4Og_").unwrap();
        assert_eq!(t, VfsResourceType::Essay);
        assert_eq!(table, "essay_sessions");

        // 普通 essay_ 仍然匹配到 essays 表
        let (t, table, _) = get_source_id_type("essay_abc123").unwrap();
        assert_eq!(t, VfsResourceType::Essay);
        assert_eq!(table, "essays");

        // essay_session_ 后面带各种字符
        let (t, table, _) = get_source_id_type("essay_session_XyZ_123").unwrap();
        assert_eq!(t, VfsResourceType::Essay);
        assert_eq!(table, "essay_sessions");
    }

    #[test]
    fn test_get_resource_ref_with_conn_exam_coalesce_title() {
        let conn = create_test_db();

        conn.execute(
            r#"
            CREATE TABLE resources (
                id TEXT PRIMARY KEY,
                hash TEXT,
                deleted_at TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create resources table");

        conn.execute(
            r#"
            CREATE TABLE exam_sheets (
                id TEXT PRIMARY KEY,
                exam_name TEXT,
                resource_id TEXT,
                deleted_at TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create exam_sheets table");

        conn.execute(
            "INSERT INTO resources (id, hash, deleted_at) VALUES (?1, ?2, NULL)",
            params!["res_exam_1", "hash_exam_1"],
        )
        .expect("Failed to insert test resource");

        conn.execute(
            "INSERT INTO exam_sheets (id, exam_name, resource_id, deleted_at) VALUES (?1, NULL, ?2, NULL)",
            params!["exam_test_1", "res_exam_1"],
        )
        .expect("Failed to insert test exam");

        let result =
            get_resource_ref_with_conn(&conn, "exam_test_1").expect("query should succeed");
        let resource_ref = result.expect("resource ref should exist");

        // exam_name 为空时应回退到 id，且 SQL 不应报语法错误
        assert_eq!(resource_ref.name, "exam_test_1");
        assert_eq!(resource_ref.resource_hash, "hash_exam_1");
        assert_eq!(resource_ref.resource_type, VfsResourceType::Exam);
    }

    #[test]
    fn test_get_resource_ref_with_conn_translation_coalesce_title() {
        let conn = create_test_db();

        conn.execute(
            r#"
            CREATE TABLE resources (
                id TEXT PRIMARY KEY,
                hash TEXT,
                deleted_at TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create resources table");

        conn.execute(
            r#"
            CREATE TABLE translations (
                id TEXT PRIMARY KEY,
                title TEXT,
                resource_id TEXT,
                deleted_at TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create translations table");

        conn.execute(
            "INSERT INTO resources (id, hash, deleted_at) VALUES (?1, ?2, NULL)",
            params!["res_tr_1", "hash_tr_1"],
        )
        .expect("Failed to insert test resource");

        conn.execute(
            "INSERT INTO translations (id, title, resource_id, deleted_at) VALUES (?1, NULL, ?2, NULL)",
            params!["tr_test_1", "res_tr_1"],
        )
        .expect("Failed to insert test translation");

        let result = get_resource_ref_with_conn(&conn, "tr_test_1").expect("query should succeed");
        let resource_ref = result.expect("resource ref should exist");

        assert_eq!(resource_ref.name, "tr_test_1");
        assert_eq!(resource_ref.resource_hash, "hash_tr_1");
        assert_eq!(resource_ref.resource_type, VfsResourceType::Translation);
    }

    #[test]
    fn test_get_resource_ref_with_conn_essay_coalesce_title() {
        let conn = create_test_db();

        conn.execute(
            r#"
            CREATE TABLE resources (
                id TEXT PRIMARY KEY,
                hash TEXT,
                deleted_at TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create resources table");

        conn.execute(
            r#"
            CREATE TABLE essays (
                id TEXT PRIMARY KEY,
                title TEXT,
                resource_id TEXT,
                deleted_at TEXT
            )
            "#,
            [],
        )
        .expect("Failed to create essays table");

        conn.execute(
            "INSERT INTO resources (id, hash, deleted_at) VALUES (?1, ?2, NULL)",
            params!["res_essay_1", "hash_essay_1"],
        )
        .expect("Failed to insert test resource");

        conn.execute(
            "INSERT INTO essays (id, title, resource_id, deleted_at) VALUES (?1, NULL, ?2, NULL)",
            params!["essay_test_1", "res_essay_1"],
        )
        .expect("Failed to insert test essay");

        let result =
            get_resource_ref_with_conn(&conn, "essay_test_1").expect("query should succeed");
        let resource_ref = result.expect("resource ref should exist");

        assert_eq!(resource_ref.name, "essay_test_1");
        assert_eq!(resource_ref.resource_hash, "hash_essay_1");
        assert_eq!(resource_ref.resource_type, VfsResourceType::Essay);
    }

    #[test]
    fn test_vfs_context_ref_data_default() {
        let data = VfsContextRefData::default();
        assert!(data.refs.is_empty());
        assert!(!data.truncated);
        assert_eq!(data.total_count, 0);
    }

    #[test]
    fn test_vfs_resource_ref_serialization() {
        let ref_data = VfsResourceRef {
            source_id: "note_abc123".to_string(),
            resource_hash: "sha256hash".to_string(),
            resource_type: VfsResourceType::Note,
            name: "Test Note".to_string(),
            inject_modes: None,
        };

        let json = serde_json::to_string(&ref_data).unwrap();
        assert!(json.contains("\"sourceId\":\"note_abc123\""));
        assert!(json.contains("\"resourceHash\":\"sha256hash\""));
        assert!(json.contains("\"type\":\"note\""));
        assert!(json.contains("\"name\":\"Test Note\""));
    }

    #[test]
    fn test_resolved_resource_serialization() {
        let resolved = ResolvedResource {
            source_id: "note_abc123".to_string(),
            resource_hash: "sha256hash".to_string(),
            resource_type: VfsResourceType::Note,
            name: "Test Note".to_string(),
            path: "高考复习/函数/Test Note".to_string(),
            content: Some("note content".to_string()),
            found: true,
            warning: None,
            multimodal_blocks: None,
        };

        let json = serde_json::to_string(&resolved).unwrap();
        assert!(json.contains("\"sourceId\":\"note_abc123\""));
        assert!(json.contains("\"path\":\"高考复习/函数/Test Note\""));
        assert!(json.contains("\"found\":true"));
    }

    #[test]
    fn test_get_resource_refs_input_deserialization() {
        let json = r#"{
            "sourceIds": ["note_abc", "tb_xyz"],
            "includeFolderContents": true,
            "maxItems": 30
        }"#;

        let input: GetResourceRefsInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.source_ids, vec!["note_abc", "tb_xyz"]);
        assert!(input.include_folder_contents);
        assert_eq!(input.max_items, 30);
    }

    #[test]
    fn test_get_resource_refs_input_defaults() {
        let json = r#"{
            "sourceIds": ["note_abc"]
        }"#;

        let input: GetResourceRefsInput = serde_json::from_str(json).unwrap();
        assert!(!input.include_folder_contents);
        assert_eq!(input.max_items, 50); // default
    }
}
