//! 教材库命令模块
//! 从 commands.rs 剥离 (原始行号: 7077-7400)

use crate::commands::AppState;
use crate::document_parser::DocumentParser;
use crate::models::AppError;
use crate::textbooks_db::{Textbook as TextbookDto, TextbooksDb};
use crate::unified_file_manager;
use crate::vfs::repos::pdf_preview::{render_pdf_preview_with_progress, PdfPreviewConfig};
// ★ 2026-02 移除：VfsIndexService 和 UnitBuildInput 不再需要
// sync_resource_units 调用已移除，由 Pipeline 统一处理
use crate::vfs::{PdfProcessingService, ProcessingStage};
use rusqlite::OptionalExtension;
use serde::Serialize;
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
        // ★ 移动端修复：当 URI 提取的文件名是不透明 document ID（如 446、document:123）时，
        // 生成用户友好的显示名称，避免在 UI 上显示无意义的数字 ID
        let uri_raw_name = unified_file_manager::extract_file_name(src);
        let display_name_owned = if unified_file_manager::is_opaque_document_id(&uri_raw_name) {
            let ext_suffix = resolved_ext
                .as_ref()
                .map(|e| format!(".{}", e))
                .unwrap_or_default();
            format!(
                "导入文档_{}{}",
                chrono::Utc::now().format("%Y%m%d_%H%M%S"),
                ext_suffix
            )
        } else {
            resolved_name.clone()
        };
        let display_name = display_name_owned.as_str();

        info!(
            "[Textbooks] Resolved file info: uri={}, name={}, ext={:?}",
            src, display_name, resolved_ext
        );

        // ★ 校验提前：在哈希和复制之前验证扩展名
        // ★ 2026-06-12（审阅问题 R2）：补齐 "markdown"/"xlsb"。
        // 前端 DOCUMENT_EXTENSIONS 含这两个扩展名且 DocumentParser 支持解析，
        // 旧白名单缺失导致同一拖拽批次中它们被静默拒绝。
        let extension = match resolved_ext {
            Some(ref ext) if ext == "pdf" => ext.clone(),
            Some(ref ext) => {
                let supported_extensions = [
                    "docx", "txt", "md", "markdown", "xlsx", "xls", "xlsb", "ods", "html", "htm",
                    "pptx", "epub", "rtf", "csv", "json", "xml",
                ];
                // ★ 代码/纯文本扩展名（与前端/附件白名单同一清单）按 txt 解析路径处理
                if supported_extensions.contains(&ext.as_str())
                    || crate::document_parser::is_plain_text_code_extension(ext)
                {
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

                // ★ 2026-06-12（审阅问题 M7）：从回收站恢复时同步更新为本次导入的文件名。
                // 旧行为静默复用旧名称，用户重命名后再导入会看到"消失的文件"。
                if tb.file_name != display_name {
                    if let Ok(conn) = vfs_db.get_conn_safe() {
                        if let Err(e) = crate::vfs::VfsTextbookRepo::rename_textbook_with_conn(
                            &conn,
                            &tb.id,
                            display_name,
                        ) {
                            warn!("[Textbooks] 恢复后重命名失败: {} ({})", tb.id, e);
                        }
                    }
                }
            }

            // ★ 2026-06-12（审阅问题 R1）：老记录若缺少 blob 内容，趁重新导入自愈补存。
            if tb.blob_hash.is_none() {
                let vfs_db_heal = std::sync::Arc::clone(vfs_db);
                let window_heal = window.clone();
                let src_heal = src.to_string();
                let ext_heal = extension.clone();
                let tb_id_heal = tb.id.clone();
                let heal_result = tauri::async_runtime::spawn_blocking(move || {
                    let bytes = unified_file_manager::read_all_bytes(&window_heal, &src_heal)?;
                    let conn = vfs_db_heal
                        .get_conn_safe()
                        .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;
                    crate::vfs::VfsTextbookRepo::attach_blob_if_missing_with_conn(
                        &conn,
                        vfs_db_heal.blobs_dir(),
                        &tb_id_heal,
                        &bytes,
                        None,
                        Some(&ext_heal),
                    )
                    .map_err(|e| AppError::database(format!("补存 blob 失败: {}", e)))
                })
                .await;
                match heal_result {
                    Ok(Ok(true)) => {
                        info!("[Textbooks] Healed blob for existing textbook {}", tb.id)
                    }
                    Ok(Ok(false)) => {}
                    Ok(Err(e)) => warn!("[Textbooks] Blob heal failed for {}: {}", tb.id, e),
                    Err(e) => warn!("[Textbooks] Blob heal task panicked for {}: {}", tb.id, e),
                }
            }

            attach_textbook_to_folder(vfs_db, &tb.id, folder_id.as_deref());
            emit_textbook_watch_event(&window, &tb.id, watch_event_type);
            start_textbook_pipeline_if_needed(pdf_processing_service.inner(), &tb.id, &extension);
            emit_progress(&window, display_name, "done", None, None, 100, None);
            out.push(tb.to_textbook());
            continue;
        }

        let file_name = display_name.to_string();

        // ★ 2026-06-12（审阅问题 R1/R4/R5 重构）：
        // - R1: 文件内容一次性读入并复制进 VFS blob 存储（旧实现只记 original_path，
        //   原文件移动/外置盘弹出后资源永久失效）
        // - R4: 复用同一份字节做哈希后的 blob 写入与解析，不再重复读盘
        // - R5: blob 写入 + PDF 渲染 + 文档解析整体放入 spawn_blocking，
        //   不再阻塞 tokio 异步线程（渲染 50 页大 PDF 可达数十秒）
        emit_progress(&window, &file_name, "copying", None, None, 10, None);

        struct HeavyOutcome {
            blob_hash: Option<String>,
            preview_json_str: Option<String>,
            extracted_text: Option<String>,
            page_count: Option<i32>,
            /// ★ pptx/epub 页级文本（JSON 数组，写入 files.ocr_pages_json）
            pages_json: Option<String>,
            /// ★ PDF 渲染失败原因（写入 files.processing_error，状态显式化）
            render_error: Option<String>,
            size: u64,
        }

        let vfs_db_task = std::sync::Arc::clone(vfs_db);
        let window_task = window.clone();
        let src_task = src.to_string();
        let file_name_task = file_name.clone();
        let extension_task = extension.clone();
        let is_pdf = extension == "pdf";

        if is_pdf {
            emit_progress(&window, &file_name, "rendering", Some(0), None, 15, None);
        } else {
            emit_progress(&window, &file_name, "parsing", None, None, 15, None);
        }

        let heavy = tauri::async_runtime::spawn_blocking(
            move || -> std::result::Result<HeavyOutcome, AppError> {
                let file_bytes =
                    unified_file_manager::read_all_bytes(&window_task, &src_task)
                        .map_err(|e| AppError::file_system(format!("读取文件失败: {}", e)))?;
                let size = file_bytes.len() as u64;

                // ★ PDF 导入前校验：文件头 + 加密检测（避免无效/加密 PDF 进入 VFS 后预览必然失败）
                if is_pdf {
                    if file_bytes.len() < 5 || !file_bytes.starts_with(b"%PDF-") {
                        return Err(AppError::validation(format!(
                            "文件 '{}' 不是有效的 PDF 文档（缺少 PDF 文件头）",
                            file_name_task
                        )));
                    }
                    DocumentParser::new()
                        .check_pdf_encryption_bytes(&file_bytes, &file_name_task)
                        .map_err(|e| AppError::validation(format!("{}", e)))?;
                }

                let conn = vfs_db_task
                    .get_conn_safe()
                    .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;
                let blobs_dir = vfs_db_task.blobs_dir();

                // 1. 复制内容进 VFS blob（内容寻址，重复导入自动去重）
                let blob = crate::vfs::repos::VfsBlobRepo::store_blob_with_conn(
                    &conn,
                    blobs_dir,
                    &file_bytes,
                    None,
                    Some(&extension_task),
                )
                .map_err(|e| AppError::database(format!("复制文件进 VFS 失败: {}", e)))?;

                // 2. 渲染 / 解析
                let mut pages_json: Option<String> = None;
                let mut render_error: Option<String> = None;
                let (preview_json_str, extracted_text, page_count) = if is_pdf {
                    let window_clone = window_task.clone();
                    let file_name_clone = file_name_task.clone();
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
                        if let Err(err) =
                            window_clone.emit("textbook-import-progress", &payload)
                        {
                            warn!(
                                "[Textbooks] 发送渲染进度事件失败: file={}, page={}/{}, err={}",
                                file_name_clone, current_page, total_pages, err
                            );
                        }
                    };

                    match render_pdf_preview_with_progress(
                        &conn,
                        blobs_dir,
                        &file_bytes,
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
                            // ★ 状态显式化：记录可读失败原因，入库后写入 processing_error
                            render_error = Some(format!(
                                "PDF 渲染失败，预览与文本提取不可用：{}。可尝试删除后重新导入，或检查 PDF 是否损坏/加密",
                                e
                            ));
                            (None, None, None)
                        }
                    }
                } else {
                    let parser = DocumentParser::new();

                    // ★ pptx/epub 优先页级拆分（按 slide/章节），使检索命中可定位；
                    // 其他格式或拆分失败回退整篇提取（page_count=1）
                    match parser.extract_paged_text_from_bytes(&file_name_task, &file_bytes) {
                        Ok(Some(pages)) if !pages.is_empty() => {
                            let joined = pages.join("\n\n").trim().to_string();
                            info!(
                                "[Textbooks] Paged document text extracted: {} pages, {} chars from {}",
                                pages.len(),
                                joined.len(),
                                file_name_task
                            );
                            let count = pages.len() as i32;
                            pages_json = serde_json::to_string(&pages).ok();
                            (None, Some(joined), Some(count))
                        }
                        Ok(_) | Err(_) => {
                            match parser.extract_text_from_bytes(&file_name_task, file_bytes) {
                                Ok(text) => {
                                    info!(
                                        "[Textbooks] Document text extracted: {} chars from {}",
                                        text.len(),
                                        file_name_task
                                    );
                                    (None, Some(text), Some(1))
                                }
                                Err(e) => {
                                    return Err(AppError::file_system(format!(
                                        "文档解析失败: {}",
                                        e
                                    )));
                                }
                            }
                        }
                    }
                };

                Ok(HeavyOutcome {
                    blob_hash: Some(blob.hash),
                    preview_json_str,
                    extracted_text,
                    page_count,
                    pages_json,
                    render_error,
                    size,
                })
            },
        )
        .await;

        let outcome = match heavy {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(e)) => {
                warn!("[Textbooks] Processing failed for {}: {}", file_name, e);
                emit_progress(
                    &window,
                    &file_name,
                    "error",
                    None,
                    None,
                    0,
                    Some(e.to_string()),
                );
                skipped_reasons.push(format!("{}: {}", display_name, e));
                continue;
            }
            Err(e) => {
                warn!(
                    "[Textbooks] Processing task panicked for {}: {}",
                    file_name, e
                );
                emit_progress(
                    &window,
                    &file_name,
                    "error",
                    None,
                    None,
                    0,
                    Some(format!("处理任务异常终止: {}", e)),
                );
                skipped_reasons.push(format!("{}: 处理任务异常终止", display_name));
                continue;
            }
        };

        // 阶段4：入库
        emit_progress(&window, &file_name, "saving", None, None, 90, None);
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;
        let tb = crate::vfs::VfsTextbookRepo::create_textbook_with_preview(
            &conn,
            &sha256,
            &file_name,
            outcome.size as i64,
            outcome.blob_hash.as_deref(),
            Some(src), // original_path 保留为来源提示（打开所在目录等用途）
            outcome.preview_json_str.as_deref(),
            outcome.extracted_text.as_deref(),
            outcome.page_count,
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

        // ★ pptx/epub 页级文本：写入 ocr_pages_json，使检索命中可定位页/章节
        if let Some(ref pages_json) = outcome.pages_json {
            if let Err(e) = conn.execute(
                "UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2",
                rusqlite::params![pages_json, tb.id],
            ) {
                warn!(
                    "[Textbooks] Failed to write ocr_pages_json for {}: {}",
                    tb.id, e
                );
            }
        }

        // ★ PDF 渲染失败：显式记录 error 状态与可读原因（此前仅日志，用户不可见）
        if let Some(ref render_error) = outcome.render_error {
            if let Err(e) = conn.execute(
                "UPDATE files SET processing_status = 'error', processing_error = ?1 WHERE id = ?2",
                rusqlite::params![render_error, tb.id],
            ) {
                warn!(
                    "[Textbooks] Failed to write render failure status for {}: {}",
                    tb.id, e
                );
            }
        }

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

/// ★ 2026-06-12（审阅 UI/UX：失联重新关联）
/// 重新关联失联的教材/文件：校验所选文件内容哈希与记录一致后更新 original_path，
/// 并把内容补存进 VFS blob（彻底自愈，之后不再依赖外部路径）。
#[tauri::command]
pub async fn textbooks_relink(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    new_path: String,
) -> Result<TextbookDto> {
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let tb = crate::vfs::VfsTextbookRepo::get_textbook(vfs_db, &id)
        .map_err(|e| AppError::database(format!("VFS 查询教材失败: {}", e)))?
        .ok_or_else(|| AppError::not_found(format!("教材不存在: {}", id)))?;

    // 哈希校验放入 blocking 线程（大文件读取耗时）
    let window_hash = window.clone();
    let path_hash = new_path.clone();
    let new_sha256 = tauri::async_runtime::spawn_blocking(move || {
        unified_file_manager::hash_file_sha256(&window_hash, &path_hash)
    })
    .await
    .map_err(|e| AppError::file_system(format!("哈希计算任务异常: {}", e)))??;

    if new_sha256 != tb.sha256 {
        return Err(AppError::validation(
            "所选文件与原文件内容不一致，请选择同一个文件",
        ));
    }

    // 更新 original_path + 自愈补存 blob
    let vfs_db_task = std::sync::Arc::clone(vfs_db);
    let window_task = window.clone();
    let new_path_task = new_path.clone();
    let id_task = id.clone();
    let extension = std::path::Path::new(&tb.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    tauri::async_runtime::spawn_blocking(move || -> std::result::Result<(), AppError> {
        let conn = vfs_db_task
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        conn.execute(
            "UPDATE files SET original_path = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![new_path_task, now, id_task],
        )
        .map_err(|e| AppError::database(format!("更新 original_path 失败: {}", e)))?;

        let bytes = unified_file_manager::read_all_bytes(&window_task, &new_path_task)?;
        crate::vfs::VfsTextbookRepo::attach_blob_if_missing_with_conn(
            &conn,
            vfs_db_task.blobs_dir(),
            &id_task,
            &bytes,
            None,
            extension.as_deref(),
        )
        .map_err(|e| AppError::database(format!("补存 blob 失败: {}", e)))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::file_system(format!("重新关联任务异常: {}", e)))??;

    let updated = crate::vfs::VfsTextbookRepo::get_textbook(vfs_db, &id)
        .map_err(|e| AppError::database(format!("VFS 查询教材失败: {}", e)))?
        .ok_or_else(|| AppError::not_found(format!("教材不存在: {}", id)))?;

    emit_textbook_watch_event(&window, &id, "updated");
    Ok(updated.to_textbook())
}

/// ★ 2026-06-12（审阅问题 R1/R4 配套）
/// 查询 files 行对应的 VFS blob 绝对路径（若存在）。
/// 前端用它把 PDF 预览切到 pdfstream:// 流式加载，避免整文件 base64 过 IPC。
#[tauri::command]
pub async fn vfs_get_file_blob_path(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>> {
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

    let blob_hash: Option<Option<String>> = conn
        .query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| AppError::database(format!("查询 blob_hash 失败: {}", e)))?;

    let Some(Some(hash)) = blob_hash else {
        return Ok(None);
    };

    let path = crate::vfs::VfsBlobRepo::get_blob_path_with_conn(&conn, vfs_db.blobs_dir(), &hash)
        .map_err(|e| AppError::database(format!("查询 blob 路径失败: {}", e)))?;

    Ok(path
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string()))
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
