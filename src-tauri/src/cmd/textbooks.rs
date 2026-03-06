//! 教材库命令模块
//! 从 commands.rs 剥离 (原始行号: 7077-7400)

use crate::commands::{read_file_bytes, AppState};
use crate::document_parser::DocumentParser;
use crate::models::AppError;
use crate::textbooks_db::{ListQuery as TextbooksListQuery, Textbook as TextbookDto, TextbooksDb};
use crate::unified_file_manager;
use crate::vfs::repos::pdf_preview::{render_pdf_preview_with_progress, PdfPreviewConfig};
// ★ 2026-02 移除：VfsIndexService 和 UnitBuildInput 不再需要
// sync_resource_units 调用已移除，由 Pipeline 统一处理
use crate::vfs::{PdfProcessingService, ProcessingStage};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, State, Window};
use tracing::{info, warn};

/// PDF 导入进度事件
#[derive(Debug, Clone, Serialize)]
pub struct TextbookImportProgress {
    /// 当前文件名
    pub file_name: String,
    /// 当前阶段: "hashing" | "copying" | "rendering" | "saving" | "done" | "error"
    pub stage: String,
    /// 当前页码（仅 rendering 阶段有效）
    pub current_page: Option<usize>,
    /// 总页数（仅 rendering 阶段有效）
    pub total_pages: Option<usize>,
    /// 进度百分比 0-100
    pub progress: u8,
    /// 错误信息（仅 error 阶段有效）
    pub error: Option<String>,
}

type Result<T> = std::result::Result<T, AppError>;

fn attach_textbook_to_folder(
    vfs_db: &crate::vfs::VfsDatabase,
    textbook_id: &str,
    folder_id: Option<&str>,
) {
    if let Some(fid) = folder_id {
        let folder_item = crate::vfs::VfsFolderItem::new(
            Some(fid.to_string()),
            "file".to_string(),
            textbook_id.to_string(),
        );
        if let Err(e) = crate::vfs::VfsFolderRepo::add_item_to_folder(vfs_db, &folder_item) {
            warn!(
                "[Textbooks] Failed to attach textbook {} to folder {}: {}",
                textbook_id, fid, e
            );
        }
    }
}

fn emit_textbook_watch_event(window: &Window, textbook_id: &str, event_type: &str) {
    let dstu_path = format!("/{}", textbook_id);
    let watch_event = serde_json::json!({
        "type": event_type,
        "path": dstu_path,
    });

    if let Err(err) = window.emit(&format!("dstu:change:{}", dstu_path), &watch_event) {
        warn!(
            "[Textbooks] Failed to emit dstu:change:{} for {}: {}",
            event_type, textbook_id, err
        );
    }
    if let Err(err) = window.emit("dstu:change", &watch_event) {
        warn!(
            "[Textbooks] Failed to emit global dstu:change:{} for {}: {}",
            event_type, textbook_id, err
        );
    }
}

fn start_textbook_pipeline_if_needed(
    pdf_processing_service: &Arc<PdfProcessingService>,
    textbook_id: &str,
    extension: &str,
) {
    if extension != "pdf" {
        return;
    }

    let textbook_id = textbook_id.to_string();
    let pdf_service = pdf_processing_service.clone();
    tokio::spawn(async move {
        info!(
            "[Textbooks] Starting PDF pipeline for textbook: {}",
            textbook_id
        );
        if let Err(e) = pdf_service
            .start_pipeline(&textbook_id, Some(ProcessingStage::OcrProcessing))
            .await
        {
            warn!(
                "[Textbooks] Failed to start PDF pipeline for textbook {}: {}",
                textbook_id, e
            );
        }
    });
}

// ==================== 教材库（独立数据库）命令 ====================

#[tauri::command]
pub async fn textbooks_add(
    window: Window,
    state: State<'_, AppState>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
    sources: Vec<String>,
    folder_id: Option<String>,
) -> Result<Vec<TextbookDto>> {
    if sources.is_empty() {
        return Ok(vec![]);
    }

    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    // 辅助函数：发送进度事件
    let emit_progress = |window: &Window,
                         file_name: &str,
                         stage: &str,
                         current_page: Option<usize>,
                         total_pages: Option<usize>,
                         progress: u8,
                         error: Option<String>| {
        log::info!(
            "📤 [Textbook] 发送进度事件: file={}, stage={}, page={:?}/{:?}, progress={}%",
            file_name,
            stage,
            current_page,
            total_pages,
            progress
        );
        let payload = TextbookImportProgress {
            file_name: file_name.to_string(),
            stage: stage.to_string(),
            current_page,
            total_pages,
            progress,
            error,
        };
        if let Err(err) = window.emit("textbook-import-progress", &payload) {
            warn!(
                "[Textbooks] 发送 textbook-import-progress 事件失败: file={}, stage={}, err={}",
                file_name, stage, err
            );
        }
    };

    let mut out: Vec<TextbookDto> = Vec::new();
    let mut skipped_reasons: Vec<String> = Vec::new();

    for src in &sources {
        // ★ Android 修复：使用三层降级策略解析文件名和扩展名
        // Layer 1: URI 路径提取（适用于 ExternalStorage / raw: 路径）
        // Layer 2: Magic bytes 检测（适用于 Media Provider / Downloads 等不透明 ID）
        // Layer 3: 无法识别 → 跳过并记录原因
        let (resolved_name, resolved_ext) = unified_file_manager::resolve_file_info(&window, src);
        let display_name = resolved_name.as_str();

        info!(
            "[Textbooks] Resolved file info: uri={}, name={}, ext={:?}",
            src, display_name, resolved_ext
        );

        // ★ 校验提前：在哈希和复制之前验证扩展名
        let extension = match resolved_ext {
            Some(ref ext) if ext == "pdf" => ext.clone(),
            Some(ref ext) => {
                let supported_extensions = [
                    "docx", "txt", "md", "xlsx", "xls", "ods", "html", "htm", "pptx", "epub",
                    "rtf", "csv", "json", "xml",
                ];
                if supported_extensions.contains(&ext.as_str()) {
                    ext.clone()
                } else {
                    let reason = format!("{}: 不支持的文件格式 ({})", display_name, ext);
                    warn!("[Textbooks] {}", reason);
                    emit_progress(
                        &window,
                        display_name,
                        "error",
                        None,
                        None,
                        0,
                        Some(format!("不支持的文件格式: {}", ext)),
                    );
                    skipped_reasons.push(reason);
                    continue;
                }
            }
            None => {
                let reason = format!("{}: 无法识别文件格式", display_name);
                warn!("[Textbooks] {}", reason);
                emit_progress(
                    &window,
                    display_name,
                    "error",
                    None,
                    None,
                    0,
                    Some("无法识别文件格式，请确认文件类型后重试".to_string()),
                );
                skipped_reasons.push(reason);
                continue;
            }
        };

        // 阶段1：计算哈希
        emit_progress(&window, display_name, "hashing", None, None, 5, None);
        let sha256 = match unified_file_manager::hash_file_sha256(&window, src) {
            Ok(h) => h,
            Err(e) => {
                let reason = format!("{}: 读取文件失败 ({})", display_name, e);
                warn!("[Textbooks] {}", reason);
                emit_progress(
                    &window,
                    display_name,
                    "error",
                    None,
                    None,
                    0,
                    Some(format!("读取文件失败: {}", e)),
                );
                skipped_reasons.push(reason);
                continue;
            }
        };

        // 若已存在，恢复并重新挂载到目标位置
        if let Some(tb) = crate::vfs::VfsTextbookRepo::get_by_sha256(vfs_db, &sha256)
            .map_err(|e| AppError::database(format!("VFS 查询教材失败: {}", e)))?
        {
            let mut watch_event_type = "created";
            if tb.status != "active" {
                crate::vfs::VfsTextbookRepo::restore_textbook(vfs_db, &tb.id)
                    .map_err(|e| AppError::database(format!("VFS 恢复教材失败: {}", e)))?;
                watch_event_type = "restored";
            }
            attach_textbook_to_folder(vfs_db, &tb.id, folder_id.as_deref());
            emit_textbook_watch_event(&window, &tb.id, watch_event_type);
            start_textbook_pipeline_if_needed(pdf_processing_service.inner(), &tb.id, &extension);
            emit_progress(&window, display_name, "done", None, None, 100, None);
            out.push(tb.to_textbook());
            continue;
        }

        let size = unified_file_manager::get_file_size(&window, src).unwrap_or(0);
        let file_name = display_name.to_string();

        // 阶段3：根据文件类型处理
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        let blobs_dir = vfs_db.blobs_dir();

        let (preview_json_str, extracted_text, page_count) = if extension == "pdf" {
            // PDF 文件：使用 PDF 预渲染流程
            emit_progress(&window, &file_name, "rendering", Some(0), None, 15, None);
            let pdf_bytes = read_file_bytes(window.clone(), src.to_string())
                .await
                .map_err(|e| {
                    emit_progress(
                        &window,
                        &file_name,
                        "error",
                        None,
                        None,
                        0,
                        Some(format!("读取 PDF 失败: {}", e)),
                    );
                    AppError::file_system(format!("读取 PDF 文件失败: {}", e))
                })?;

            let window_clone = window.clone();
            let file_name_clone = file_name.clone();
            let progress_callback = move |current_page: usize, total_pages: usize| {
                let render_progress =
                    ((current_page as f32 / total_pages as f32) * 70.0) as u8 + 15;
                let payload = TextbookImportProgress {
                    file_name: file_name_clone.clone(),
                    stage: "rendering".to_string(),
                    current_page: Some(current_page),
                    total_pages: Some(total_pages),
                    progress: render_progress.min(85),
                    error: None,
                };
                if let Err(err) = window_clone.emit("textbook-import-progress", &payload) {
                    warn!(
                        "[Textbooks] 发送渲染进度事件失败: file={}, page={}/{}, err={}",
                        file_name_clone, current_page, total_pages, err
                    );
                }
            };

            match render_pdf_preview_with_progress(
                &conn,
                &blobs_dir,
                &pdf_bytes,
                &PdfPreviewConfig::default(),
                progress_callback,
            ) {
                Ok(result) => {
                    let preview_str = result
                        .preview_json
                        .as_ref()
                        .and_then(|p| serde_json::to_string(p).ok());
                    info!(
                        "[Textbooks] PDF preview rendered: {} pages, text_len={}, has_preview={}",
                        result.page_count,
                        result.extracted_text.as_ref().map(|t| t.len()).unwrap_or(0),
                        preview_str.is_some()
                    );
                    (
                        preview_str,
                        result.extracted_text,
                        Some(result.page_count as i32),
                    )
                }
                Err(e) => {
                    warn!(
                        "[Textbooks] PDF preview failed, storing without preview: {}",
                        e
                    );
                    (None, None, None)
                }
            }
        } else {
            // 非 PDF 文件：使用 DocumentParser 提取文本
            emit_progress(&window, &file_name, "parsing", None, None, 15, None);
            let parser = DocumentParser::new();
            match parser.extract_text_from_path(src) {
                Ok(text) => {
                    info!(
                        "[Textbooks] Document text extracted: {} chars from {}",
                        text.len(),
                        file_name
                    );
                    (None, Some(text), Some(1))
                }
                Err(e) => {
                    warn!(
                        "[Textbooks] Document parsing failed for {}: {}",
                        file_name, e
                    );
                    emit_progress(
                        &window,
                        &file_name,
                        "error",
                        None,
                        None,
                        0,
                        Some(format!("文档解析失败: {}", e)),
                    );
                    skipped_reasons.push(format!("{}: 文档解析失败 ({})", display_name, e));
                    continue;
                }
            }
        };

        // 阶段4：入库
        emit_progress(&window, &file_name, "saving", None, None, 90, None);
        let tb = crate::vfs::VfsTextbookRepo::create_textbook_with_preview(
            &conn,
            &sha256,
            &file_name,
            size as i64,
            None,      // blob_hash
            Some(src), // original_path
            preview_json_str.as_deref(),
            extracted_text.as_deref(),
            page_count,
        )
        .map_err(|e| {
            emit_progress(
                &window,
                &file_name,
                "error",
                None,
                None,
                0,
                Some(format!("入库失败: {}", e)),
            );
            AppError::database(format!("VFS 创建教材失败: {}", e))
        })?;

        // ★ 创建教材后，将其挂载到指定文件夹（若有 folder_id）
        if let Some(ref fid) = folder_id {
            let folder_item = crate::vfs::VfsFolderItem::new(
                Some(fid.to_string()),
                "file".to_string(),
                tb.id.clone(),
            );
            crate::vfs::VfsFolderRepo::add_item_to_folder_with_conn(&conn, &folder_item)
                .map_err(|e| AppError::database(format!("VFS 挂载教材失败: {}", e)))?;
        }

        // ★ 2026-02 修复：移除 sync_resource_units 调用
        // 原因：Pipeline 的 stage_vector_indexing 会统一处理 Units 同步
        // 这里提前同步会导致 index_resource 内部再次同步时产生冲突
        emit_progress(&window, &file_name, "indexing", None, None, 95, None);

        // ★ 2026-02 修复：PDF 上传后异步触发 Pipeline（从 OCR 阶段开始）
        // Stage 1-2（文本提取、页面渲染）已在上面完成
        start_textbook_pipeline_if_needed(pdf_processing_service.inner(), &tb.id, &extension);
        emit_textbook_watch_event(&window, &tb.id, "created");

        // 阶段5：完成
        emit_progress(&window, &file_name, "done", None, None, 100, None);
        out.push(tb.to_textbook());
    }

    // ★ Android 修复：当所有文件都被跳过时，通过 progress 事件发送汇总原因
    if out.is_empty() && !skipped_reasons.is_empty() {
        let summary = skipped_reasons.join("; ");
        info!("[Textbooks] All files skipped. Reasons: {}", summary);
        emit_progress(&window, "", "error", None, None, 0, Some(summary));
    }

    Ok(out)
}

#[tauri::command]
pub async fn textbooks_list(
    state: State<'_, AppState>,
    query: Option<TextbooksListQuery>,
) -> Result<Vec<TextbookDto>> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let q = query.unwrap_or(TextbooksListQuery {
        q: None,
        favorite: None,
        status: None,
        limit: Some(500),
        offset: Some(0),
        sort_by: Some("time".into()),
        order: Some("desc".into()),
    });

    let limit = q.limit.unwrap_or(500) as u32;
    let offset = q.offset.unwrap_or(0) as u32;
    // VFS 版本：include_global = true 以包含全局教材
    let vfs_items = TextbooksDb::list_vfs(vfs_db, None, true, limit, offset)?;

    // 转换为旧版 TextbookDto 以保持兼容性
    let items: Vec<TextbookDto> = vfs_items.into_iter().map(|v| v.to_textbook()).collect();
    Ok(items)
}

#[tauri::command]
pub async fn textbooks_remove(
    window: Window,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool> {
    warn!(
        "[Textbooks] textbooks_remove is deprecated; prefer DSTU trash/purge flows for new callers. id={}",
        id
    );
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let deleted = TextbooksDb::delete_vfs(vfs_db, &id)?;

    if deleted {
        emit_textbook_watch_event(&window, &id, "purged");
    }

    Ok(deleted)
}

/// 采用已有文件（不复制），直接计算哈希并入库
#[tauri::command]
pub async fn textbooks_adopt(
    window: Window,
    state: State<'_, AppState>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
    paths: Vec<String>,
    folder_id: Option<String>,
) -> Result<Vec<TextbookDto>> {
    if paths.is_empty() {
        return Ok(vec![]);
    }

    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let mut out: Vec<TextbookDto> = Vec::new();
    for p in paths {
        let size = unified_file_manager::get_file_size(&window, &p)?;
        if size == 0 {
            continue;
        }
        let sha256 = unified_file_manager::hash_file_sha256(&window, &p)?;
        let (resolved_name, resolved_ext) = unified_file_manager::resolve_file_info(&window, &p);
        let file_name = resolved_name;
        let extension = resolved_ext.unwrap_or_else(|| {
            std::path::Path::new(&file_name)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or_default()
                .to_lowercase()
        });

        if let Some(tb) = crate::vfs::VfsTextbookRepo::get_by_sha256(vfs_db, &sha256)
            .map_err(|e| AppError::database(format!("VFS 查询教材失败: {}", e)))?
        {
            let mut watch_event_type = "created";
            if tb.status != "active" {
                crate::vfs::VfsTextbookRepo::restore_textbook(vfs_db, &tb.id)
                    .map_err(|e| AppError::database(format!("VFS 恢复教材失败: {}", e)))?;
                watch_event_type = "restored";
            }
            attach_textbook_to_folder(vfs_db, &tb.id, folder_id.as_deref());
            emit_textbook_watch_event(&window, &tb.id, watch_event_type);
            start_textbook_pipeline_if_needed(pdf_processing_service.inner(), &tb.id, &extension);
            out.push(tb.to_textbook());
            continue;
        }

        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;
        let blobs_dir = vfs_db.blobs_dir();

        let (preview_json_str, extracted_text, page_count) = if extension == "pdf" {
            let pdf_bytes = read_file_bytes(window.clone(), p.clone())
                .await
                .map_err(|e| AppError::file_system(format!("读取 PDF 文件失败: {}", e)))?;

            match render_pdf_preview_with_progress(
                &conn,
                &blobs_dir,
                &pdf_bytes,
                &PdfPreviewConfig::default(),
                |_current_page, _total_pages| {},
            ) {
                Ok(result) => (
                    result
                        .preview_json
                        .as_ref()
                        .and_then(|preview| serde_json::to_string(preview).ok()),
                    result.extracted_text,
                    Some(result.page_count as i32),
                ),
                Err(e) => {
                    warn!(
                        "[Textbooks] PDF preview failed during adopt, storing without preview: {}",
                        e
                    );
                    (None, None, None)
                }
            }
        } else {
            let parser = DocumentParser::new();
            match parser.extract_text_from_path(&p) {
                Ok(text) => (None, Some(text), Some(1)),
                Err(e) => {
                    warn!(
                        "[Textbooks] Document parsing failed during adopt for {}: {}",
                        file_name, e
                    );
                    (None, None, None)
                }
            }
        };

        let tb = crate::vfs::VfsTextbookRepo::create_textbook_with_preview(
            &conn,
            &sha256,
            &file_name,
            size as i64,
            None,     // blob_hash
            Some(&p), // original_path
            preview_json_str.as_deref(),
            extracted_text.as_deref(),
            page_count,
        )
        .map_err(|e| AppError::database(format!("VFS 创建教材失败: {}", e)))?;

        attach_textbook_to_folder(vfs_db, &tb.id, folder_id.as_deref());

        emit_textbook_watch_event(&window, &tb.id, "created");
        start_textbook_pipeline_if_needed(pdf_processing_service.inner(), &tb.id, &extension);

        out.push(tb.to_textbook());
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurgeTrashOptions {
    pub delete_files: Option<bool>,
}

/// 恢复回收站中的教材
#[tauri::command]
pub async fn textbooks_recover(state: State<'_, AppState>, id: String) -> Result<bool> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    crate::vfs::VfsTextbookRepo::restore_textbook(vfs_db, &id)
        .map_err(|e| AppError::database(format!("VFS 恢复教材失败: {}", e)))?;
    Ok(true)
}

/// 清空回收站（可选物理删除文件）
#[tauri::command]
pub async fn textbooks_purge_trash(
    _window: Window,
    state: State<'_, AppState>,
    options: Option<PurgeTrashOptions>,
) -> Result<serde_json::Value> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let delete_files = options.and_then(|o| o.delete_files).unwrap_or(false);
    let mut deleted_files: Vec<String> = Vec::new();

    if delete_files {
        // 先获取所有已删除的教材，删除物理文件
        let trashed = crate::vfs::VfsTextbookRepo::list_deleted_textbooks(vfs_db, 10000, 0)
            .map_err(|e| AppError::database(format!("VFS 列出回收站失败: {}", e)))?;
        for tb in &trashed {
            if let Some(ref path) = tb.original_path {
                // content:// 等虚拟 URI 无法通过 std::fs 操作，跳过物理删除
                if unified_file_manager::is_virtual_uri(path) {
                    continue;
                }
                if std::path::Path::new(path).exists() {
                    if let Err(e) = std::fs::remove_file(path) {
                        warn!("[Textbooks] 删除文件失败: {} ({})", path, e);
                    } else {
                        deleted_files.push(path.clone());
                    }
                }
            }
        }
    }

    let purged = crate::vfs::VfsFileRepo::purge_deleted_files(vfs_db)
        .map_err(|e| AppError::database(format!("VFS 清空回收站失败: {}", e)))?;
    Ok(serde_json::json!({ "purged": purged, "deleted_files": deleted_files }))
}

/// 永久删除单个教材（可选物理删除）
#[tauri::command]
pub async fn textbooks_delete_permanent(
    _window: Window,
    state: State<'_, AppState>,
    id: String,
    delete_file: Option<bool>,
) -> Result<bool> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    // 如果需要删除物理文件，先获取教材信息
    if delete_file.unwrap_or(false) {
        if let Ok(Some(tb)) = crate::vfs::VfsTextbookRepo::get_textbook(vfs_db, &id) {
            if let Some(ref path) = tb.original_path {
                // content:// 等虚拟 URI 无法通过 std::fs 操作，跳过物理删除
                if !unified_file_manager::is_virtual_uri(path) {
                    let p = std::path::Path::new(path);
                    if p.exists() {
                        if let Err(err) = std::fs::remove_file(p) {
                            warn!(
                                "[Textbooks] 永久删除教材时清理文件失败: {} ({})",
                                p.display(),
                                err
                            );
                        }
                    }
                }
            }
        }
    }

    crate::vfs::VfsTextbookRepo::purge_textbook_with_folder_item(vfs_db, &id)
        .map_err(|e| AppError::database(format!("VFS 永久删除教材失败: {}", e)))?;
    Ok(true)
}

/// 更新教材阅读进度（打开时间和页码）
#[tauri::command]
pub async fn textbooks_update_reading_progress(
    state: State<'_, AppState>,
    id: String,
    last_page: Option<i64>,
) -> Result<bool> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let params = crate::textbooks_db::VfsUpdateTextbookParams {
        last_page: last_page.map(|p| p as i32),
        ..Default::default()
    };
    TextbooksDb::update_vfs(vfs_db, &id, params)?;
    Ok(true)
}

/// 设置教材收藏状态
#[tauri::command]
pub async fn textbooks_set_favorite(
    state: State<'_, AppState>,
    id: String,
    favorite: bool,
) -> Result<bool> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let params = crate::textbooks_db::VfsUpdateTextbookParams {
        favorite: Some(favorite),
        ..Default::default()
    };
    TextbooksDb::update_vfs(vfs_db, &id, params)?;
    Ok(true)
}

/// 更新教材页数
#[tauri::command]
pub async fn textbooks_update_page_count(
    state: State<'_, AppState>,
    id: String,
    page_count: i64,
) -> Result<bool> {
    // ★ 切换到 VFS 版本
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let params = crate::textbooks_db::VfsUpdateTextbookParams {
        page_count: Some(page_count as i32),
        ..Default::default()
    };
    TextbooksDb::update_vfs(vfs_db, &id, params)?;
    Ok(true)
}

/// 更新教材书签
#[tauri::command]
pub async fn textbooks_update_bookmarks(
    state: State<'_, AppState>,
    id: String,
    bookmarks: Vec<serde_json::Value>,
) -> Result<bool> {
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
    let params = crate::textbooks_db::VfsUpdateTextbookParams {
        bookmarks: Some(bookmarks),
        ..Default::default()
    };
    TextbooksDb::update_vfs(vfs_db, &id, params)?;
    Ok(true)
}
