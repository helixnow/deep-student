//! 论文保存与引用格式化工具执行器
//!
//! ## 工具
//! - `builtin-paper_save` — 下载学术论文 PDF 并保存到 VFS（支持批量 ≤5）
//!   - 支持 arXiv ID、DOI、直接 PDF URL
//!   - DOI 自动通过 Unpaywall API 解析开放获取 PDF
//!   - SHA256 去重：已存在的论文直接返回 VFS 文件 ID
//! - `builtin-cite_format` — 将论文元数据格式化为标准引用格式
//!   - 支持 BibTeX、GB/T 7714、APA 三种格式
//!
//! ## 设计说明
//! - PDF 下载后走 VFS 完整链路：blob 存储 → 文件创建 → 文本提取 → 索引 → 异步 OCR
//! - 使用 ExecutionContext.vfs_db 操作 VFS 数据库
//! - 使用 ExecutionContext.pdf_processing_service 触发异步 OCR/压缩 Pipeline

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde_json::{json, Value};
use std::time::Duration;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

// ============================================================================
// 常量
// ============================================================================

/// 单次批量下载上限
const MAX_BATCH_SIZE: usize = 5;

/// PDF 下载超时（秒）
const PDF_DOWNLOAD_TIMEOUT_SECS: u64 = 60;

/// PDF 最大文件大小（50MB，与 VFS 一致）
const MAX_PDF_SIZE: usize = 50 * 1024 * 1024;

/// Unpaywall API 端点（通过 DOI 查找开放获取 PDF）
const UNPAYWALL_API_URL: &str = "https://api.unpaywall.org/v2";

/// Unpaywall 请求超时
const UNPAYWALL_TIMEOUT_SECS: u64 = 15;

/// User-Agent
const UA: &str = "DeepStudent/1.0 (Academic Paper Save; mailto:support@deepstudent.app)";

/// 下载进度发射最小间隔（每 500KB 或每 5%）
const PROGRESS_BYTES_INTERVAL: usize = 512 * 1024; // 512KB

// ============================================================================
// 进度状态
// ============================================================================

/// 单篇论文的处理阶段
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum PaperStage {
    Resolving,
    Downloading,
    Deduplicating,
    Storing,
    Processing,
    Indexing,
    Done,
    Error,
}

/// 单篇论文的进度状态
#[derive(Clone, serde::Serialize)]
struct PaperProgressItem {
    /// 索引
    #[serde(rename = "i")]
    index: usize,
    /// 标题
    #[serde(rename = "t")]
    title: String,
    /// 当前阶段
    #[serde(rename = "s")]
    stage: PaperStage,
    /// 下载进度 0-100
    #[serde(rename = "pct")]
    percent: u8,
    /// 已下载字节
    #[serde(rename = "dl", skip_serializing_if = "Option::is_none")]
    downloaded: Option<u64>,
    /// 总字节
    #[serde(rename = "total", skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    /// 文件 ID（完成后）
    #[serde(rename = "fid", skip_serializing_if = "Option::is_none")]
    file_id: Option<String>,
    /// 是否去重
    #[serde(rename = "dedup", skip_serializing_if = "std::ops::Not::not")]
    deduplicated: bool,
    /// 错误信息
    #[serde(rename = "err", skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// 当前下载源标签
    #[serde(rename = "src", skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    /// 可用的下载源列表（供前端手动切换）
    #[serde(rename = "srcs", skip_serializing_if = "Option::is_none")]
    sources: Option<Vec<SourceCandidate>>,
}

/// 下载源候选
#[derive(Clone, serde::Serialize)]
struct SourceCandidate {
    /// 源标签（如 "arXiv", "arXiv Mirror", "Unpaywall"）
    label: String,
    /// 下载 URL
    url: String,
}

impl PaperProgressItem {
    fn new(index: usize, title: &str) -> Self {
        Self {
            index,
            title: title.to_string(),
            stage: PaperStage::Resolving,
            percent: 0,
            downloaded: None,
            total_bytes: None,
            file_id: None,
            deduplicated: false,
            error: None,
            source: None,
            sources: None,
        }
    }
}

/// 通过 emit_chunk 发射当前进度快照（NDJSON格式）
fn emit_progress(ctx: &ExecutionContext, papers: &[PaperProgressItem]) {
    if let Ok(json_line) = serde_json::to_string(&json!({ "papers": papers })) {
        ctx.emitter.emit_chunk(
            event_types::TOOL_CALL,
            &ctx.block_id,
            &format!("{}\n", json_line),
            None,
        );
    }
}

// ============================================================================
// 论文保存执行器
// ============================================================================

pub struct PaperSaveExecutor {
    /// HTTP 客户端（PDF 下载用，长超时）
    download_client: reqwest::Client,
    /// HTTP 客户端（Unpaywall API 用，短超时）
    unpaywall_client: reqwest::Client,
}

impl PaperSaveExecutor {
    pub fn new() -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(UA));

        let download_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(PDF_DOWNLOAD_TIMEOUT_SECS))
            .default_headers(headers.clone())
            .build()
            .expect("Failed to create PDF download HTTP client");

        let unpaywall_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(UNPAYWALL_TIMEOUT_SECS))
            .default_headers(headers)
            .build()
            .expect("Failed to create Unpaywall HTTP client");

        Self {
            download_client,
            unpaywall_client,
        }
    }


    // ========================================================================
    // paper_save — 批量下载论文到 VFS
    // ========================================================================

    async fn execute_paper_save(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🔧 诊断日志：在入口处记录 arguments 的原始类型和内容预览
        {
            let raw = call.arguments.to_string();
            log::info!(
                "[PaperSave] execute_paper_save called. args_type={}, args_len={}, preview={}",
                if call.arguments.is_object() { "object" }
                else if call.arguments.is_array() { "array" }
                else if call.arguments.is_string() { "string" }
                else if call.arguments.is_null() { "null" }
                else { "other" },
                raw.len(),
                &raw[..raw.len().min(300)]
            );
        }

        // 健壮化参数提取：处理多种 arguments 格式
        let papers_owned: Vec<Value>;

        // 截断错误检查（优先）
        if call.arguments.get("_truncation_error").is_some() {
            return Err(
                "Tool call arguments were truncated by LLM max_tokens limit. Please retry with a shorter prompt."
                    .to_string(),
            );
        }

        // 辅助函数：从 Value 中提取 papers 数组（处理 "papers" 值可能是 array / string / object 等各种类型）
        fn extract_papers_from_value(val: &Value) -> Option<Vec<Value>> {
            // 尝试从 "papers" key 提取
            if let Some(papers_val) = val.get("papers") {
                let val_type = if papers_val.is_array() { "array" }
                    else if papers_val.is_string() { "string" }
                    else if papers_val.is_object() { "object" }
                    else if papers_val.is_null() { "null" }
                    else { "other" };
                log::info!("[PaperSave] Found 'papers' key, value type={}, preview={}", val_type, {
                    let s = papers_val.to_string();
                    s[..s.len().min(200)].to_string()
                });
                if let Some(arr) = papers_val.as_array() {
                    // 正常：{"papers": [...]}
                    return Some(arr.clone());
                }
                if let Some(s) = papers_val.as_str() {
                    // 双重编码：{"papers": "[{...}]"} — papers 值是 JSON 字符串
                    log::warn!("[PaperSave] 'papers' value is a JSON string (len={}), double-decoding", s.len());
                    if let Ok(inner) = serde_json::from_str::<Value>(s) {
                        if let Some(arr) = inner.as_array() {
                            return Some(arr.clone());
                        }
                        // 解析出来是单个对象
                        if inner.is_object() {
                            return Some(vec![inner]);
                        }
                    }
                }
                if papers_val.is_object() {
                    // 单篇论文直接放在 papers key 下：{"papers": {"title": "..."}}
                    log::warn!("[PaperSave] 'papers' value is a single object, wrapping in array");
                    return Some(vec![papers_val.clone()]);
                }
            }
            // 尝试从 "paper" (单数) key 提取
            if let Some(paper_val) = val.get("paper") {
                log::warn!("[PaperSave] LLM used 'paper' (singular) instead of 'papers', auto-correcting");
                if let Some(arr) = paper_val.as_array() {
                    return Some(arr.clone());
                }
                if let Some(s) = paper_val.as_str() {
                    if let Ok(inner) = serde_json::from_str::<Value>(s) {
                        if let Some(arr) = inner.as_array() {
                            return Some(arr.clone());
                        }
                        if inner.is_object() {
                            return Some(vec![inner]);
                        }
                    }
                }
                if paper_val.is_object() {
                    return Some(vec![paper_val.clone()]);
                }
            }
            // 如果对象自身是单篇论文 {"title": "...", "doi": "..."}
            if val.is_object() && val.get("title").is_some() {
                log::warn!("[PaperSave] LLM sent a single paper object without 'papers' wrapper, auto-wrapping");
                return Some(vec![val.clone()]);
            }
            None
        }

        if let Some(arr) = call.arguments.as_array() {
            // LLM 直接传了裸数组而非 {"papers": [...]}
            log::warn!("[PaperSave] arguments is a bare array, wrapping as papers");
            papers_owned = arr.clone();
        } else if let Some(extracted) = extract_papers_from_value(&call.arguments) {
            papers_owned = extracted;
        } else if let Some(s) = call.arguments.as_str() {
            // 整个 arguments 是 JSON 字符串（双重编码）
            log::warn!(
                "[PaperSave] arguments is a JSON string (len={}), attempting double-decode",
                s.len()
            );
            let parsed: Value =
                serde_json::from_str(s).map_err(|e| format!("Failed to parse arguments string: {}", e))?;
            papers_owned = extract_papers_from_value(&parsed).ok_or_else(|| {
                format!(
                    "After double-decode, still missing 'papers' (array). Parsed keys: {:?}",
                    parsed.as_object().map(|o| o.keys().collect::<Vec<_>>())
                )
            })?;
        } else {
            // 诊断日志：打印实际 arguments 结构
            let keys: Vec<String> = call
                .arguments
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            let type_name = if call.arguments.is_object() {
                "object"
            } else if call.arguments.is_string() {
                "string"
            } else if call.arguments.is_array() {
                "array"
            } else if call.arguments.is_null() {
                "null"
            } else {
                "other"
            };
            let raw = call.arguments.to_string();
            log::error!(
                "[PaperSave] Cannot extract 'papers' from arguments. type={}, keys={:?}, raw_preview={}",
                type_name,
                keys,
                &raw[..raw.len().min(500)]
            );
            return Err(format!(
                "Missing required parameter 'papers' (array). Got arguments type={}, keys={:?}",
                type_name, keys
            ));
        }

        let papers = &papers_owned;

        if papers.is_empty() {
            return Err("'papers' array is empty".to_string());
        }
        if papers.len() > MAX_BATCH_SIZE {
            return Err(format!(
                "Batch size {} exceeds limit {}. Please split into multiple calls.",
                papers.len(),
                MAX_BATCH_SIZE
            ));
        }

        let folder_id = call
            .arguments
            .get("folder_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let vfs_db = ctx
            .vfs_db
            .as_ref()
            .ok_or("VFS database not available")?;

        // 初始化进度状态数组
        let mut progress: Vec<PaperProgressItem> = papers
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let title = p
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Untitled Paper");
                PaperProgressItem::new(i, title)
            })
            .collect();

        // 发射初始进度
        emit_progress(ctx, &progress);

        let mut results = Vec::new();

        for (i, paper) in papers.iter().enumerate() {
            if ctx.is_cancelled() {
                progress[i].stage = PaperStage::Error;
                progress[i].error = Some("cancelled".to_string());
                emit_progress(ctx, &progress);
                results.push(json!({
                    "index": i,
                    "success": false,
                    "error": "cancelled",
                }));
                break;
            }

            let result = self
                .save_single_paper(paper, folder_id.as_deref(), vfs_db, ctx, &mut progress, i)
                .await;

            match result {
                Ok(mut info) => {
                    if let Some(obj) = info.as_object_mut() {
                        obj.insert("index".to_string(), json!(i));
                    }
                    results.push(info);
                }
                Err(e) => {
                    let title = progress[i].title.clone();
                    log::warn!(
                        "[PaperSave] Failed to save paper '{}': {}",
                        title,
                        e
                    );
                    progress[i].stage = PaperStage::Error;
                    progress[i].error = Some(e.clone());
                    emit_progress(ctx, &progress);
                    results.push(json!({
                        "index": i,
                        "success": false,
                        "title": title,
                        "error": e,
                    }));
                }
            }
        }

        let success_count = results.iter().filter(|r| r.get("success").and_then(|v| v.as_bool()).unwrap_or(false)).count();

        Ok(json!({
            "total": papers.len(),
            "success_count": success_count,
            "failed_count": papers.len() - success_count,
            "results": results,
        }))
    }

    /// 保存单篇论文（带进度发射 + 多源自动回退）
    async fn save_single_paper(
        &self,
        paper: &Value,
        folder_id: Option<&str>,
        vfs_db: &Arc<crate::vfs::database::VfsDatabase>,
        ctx: &ExecutionContext,
        progress: &mut Vec<PaperProgressItem>,
        idx: usize,
    ) -> Result<Value, String> {
        let url = paper.get("url").and_then(|v| v.as_str());
        let doi = paper.get("doi").and_then(|v| v.as_str());
        let arxiv_id = paper.get("arxiv_id").and_then(|v| v.as_str());
        let title = paper
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled Paper");

        // ── Stage: Resolving ──
        progress[idx].stage = PaperStage::Resolving;
        emit_progress(ctx, progress);

        let candidates = self.resolve_all_pdf_urls(url, doi, arxiv_id).await;
        if candidates.is_empty() {
            return Err("No URL, arXiv ID, or DOI provided. At least one is required.".to_string());
        }

        // 将可用源列表写入进度（供前端手动切换）
        progress[idx].sources = Some(
            candidates
                .iter()
                .map(|(u, label)| SourceCandidate {
                    label: label.clone(),
                    url: u.clone(),
                })
                .collect(),
        );

        // ── 多源自动回退下载 ──
        let mut pdf_bytes: Option<Vec<u8>> = None;
        let mut last_error = String::new();

        for (candidate_url, source_label) in &candidates {
            if ctx.is_cancelled() {
                return Err("Download cancelled".to_string());
            }

            log::info!(
                "[PaperSave] Trying '{}' source={} url={}",
                title,
                source_label,
                candidate_url
            );

            progress[idx].stage = PaperStage::Downloading;
            progress[idx].source = Some(source_label.clone());
            progress[idx].percent = 0;
            progress[idx].downloaded = None;
            progress[idx].total_bytes = None;
            emit_progress(ctx, progress);

            match self
                .download_pdf_with_progress(candidate_url, ctx, progress, idx)
                .await
            {
                Ok(bytes) => {
                    pdf_bytes = Some(bytes);
                    break;
                }
                Err(e) => {
                    log::warn!(
                        "[PaperSave] Source '{}' failed for '{}': {}",
                        source_label,
                        title,
                        e
                    );
                    last_error = format!("[{}] {}", source_label, e);
                    // 继续尝试下一个源
                }
            }
        }

        let pdf_bytes = match pdf_bytes {
            Some(b) => b,
            None => {
                return Err(format!(
                    "All {} sources failed. Last error: {}",
                    candidates.len(),
                    last_error
                ));
            }
        };

        log::info!(
            "[PaperSave] Downloaded {} bytes for '{}'",
            pdf_bytes.len(),
            title
        );

        // ── Stage: Deduplicating ──
        progress[idx].stage = PaperStage::Deduplicating;
        progress[idx].percent = 100;
        emit_progress(ctx, progress);

        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&pdf_bytes);
        let sha256 = format!("{:x}", hasher.finalize());

        let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

        use crate::vfs::VfsFileRepo;
        if let Ok(Some(existing)) = VfsFileRepo::get_by_sha256_with_conn(&conn, &sha256) {
            if existing.status == "active" {
                log::info!(
                    "[PaperSave] Paper '{}' already exists: {}",
                    title,
                    existing.id
                );
                progress[idx].stage = PaperStage::Done;
                progress[idx].deduplicated = true;
                progress[idx].file_id = Some(existing.id.clone());
                emit_progress(ctx, progress);
                return Ok(json!({
                    "success": true,
                    "deduplicated": true,
                    "file_id": existing.id,
                    "title": title,
                    "message": format!("论文已存在于资料库中（文件ID: {}）", existing.id),
                }));
            }
        }

        // ── Stage: Storing ──
        progress[idx].stage = PaperStage::Storing;
        emit_progress(ctx, progress);

        use crate::vfs::VfsBlobRepo;
        let blobs_dir = vfs_db.blobs_dir();
        let blob_hash = VfsBlobRepo::store_blob_with_conn(
            &conn,
            &blobs_dir,
            &pdf_bytes,
            Some("application/pdf"),
            None,
        )
        .map_err(|e| format!("Blob storage failed: {}", e))?
        .hash;

        // ── Stage: Processing ──
        progress[idx].stage = PaperStage::Processing;
        emit_progress(ctx, progress);

        use crate::vfs::repos::pdf_preview::{render_pdf_preview, PdfPreviewConfig};
        let (preview_json, extracted_text, page_count) =
            match render_pdf_preview(&conn, &blobs_dir, &pdf_bytes, &PdfPreviewConfig::default()) {
                Ok(result) => {
                    let preview_str = result
                        .preview_json
                        .as_ref()
                        .and_then(|p| serde_json::to_string(p).ok());
                    (
                        preview_str,
                        result.extracted_text,
                        Some(result.page_count as i32),
                    )
                }
                Err(e) => {
                    log::warn!("[PaperSave] PDF preview failed for '{}': {}", title, e);
                    (None, None, None)
                }
            };

        let safe_title = sanitize_filename(title);
        let file_name = if safe_title.to_lowercase().ends_with(".pdf") {
            safe_title
        } else {
            format!("{}.pdf", safe_title)
        };

        // 🔧 修复：不指定 folder_id 时存到根目录（None），
        // 使论文直接出现在学习资源"全部文件"视图中。
        // 之前错误地使用 AttachmentConfig::get_or_create_root_folder()
        // 导致论文被存到"附件"隐藏文件夹中。
        let target_folder_id = match folder_id {
            Some(id) if !id.is_empty() => Some(id.to_string()),
            _ => None, // 根目录
        };

        let file = VfsFileRepo::create_file_with_doc_data_in_folder(
            &conn,
            &sha256,
            &file_name,
            pdf_bytes.len() as i64,
            "pdf",
            Some("application/pdf"),
            Some(&blob_hash),
            None,
            target_folder_id.as_deref(),
            preview_json.as_deref(),
            extracted_text.as_deref(),
            page_count,
        )
        .map_err(|e| format!("File creation failed: {}", e))?;

        log::info!(
            "[PaperSave] File created: {} (name={}, pages={:?})",
            file.id,
            file_name,
            page_count
        );

        // ── Stage: Indexing ──
        progress[idx].stage = PaperStage::Indexing;
        emit_progress(ctx, progress);

        if let Some(ref resource_id) = file.resource_id {
            use crate::vfs::index_service::VfsIndexService;
            use crate::vfs::unit_builder::UnitBuildInput;
            let index_service = VfsIndexService::new(vfs_db.clone());
            let input = UnitBuildInput {
                resource_id: resource_id.clone(),
                resource_type: "file".to_string(),
                data: None,
                ocr_text: None,
                ocr_pages_json: None,
                blob_hash: Some(blob_hash.clone()),
                page_count: file.page_count,
                extracted_text: file.extracted_text.clone(),
                preview_json: file.preview_json.clone(),
            };
            match index_service.sync_resource_units(input) {
                Ok(units) => {
                    log::info!(
                        "[PaperSave] Indexed {} units for file {}",
                        units.len(),
                        file.id
                    );
                }
                Err(e) => {
                    log::warn!(
                        "[PaperSave] Index sync failed for file {}: {}",
                        file.id,
                        e
                    );
                }
            }
        }

        // 触发异步 PDF 处理 Pipeline
        if let Some(ref pdf_service) = ctx.pdf_processing_service {
            use crate::vfs::pdf_processing_service::ProcessingStage;
            let file_id = file.id.clone();
            let service = pdf_service.clone();
            tokio::spawn(async move {
                log::info!("[PaperSave] Starting media pipeline for file: {}", file_id);
                if let Err(e) = service
                    .start_pipeline(&file_id, Some(ProcessingStage::OcrProcessing))
                    .await
                {
                    log::error!(
                        "[PaperSave] Media pipeline failed for file {}: {}",
                        file_id,
                        e
                    );
                }
            });
        }

        // ── Stage: Done ──
        progress[idx].stage = PaperStage::Done;
        progress[idx].file_id = Some(file.id.clone());
        emit_progress(ctx, progress);

        Ok(json!({
            "success": true,
            "deduplicated": false,
            "file_id": file.id,
            "title": title,
            "file_name": file_name,
            "size_bytes": pdf_bytes.len(),
            "page_count": page_count,
            "has_text": extracted_text.is_some(),
            "message": format!("论文已保存到资料库（{}页，文件ID: {}）", page_count.unwrap_or(0), file.id),
        }))
    }

    /// 解析所有可用的 PDF 下载源（支持多源自动回退）
    ///
    /// 返回 `Vec<(url, source_label)>`，按优先级排序：
    /// - 直接 URL（最高优先级）
    /// - arXiv 主站 + 镜像站
    /// - DOI → Unpaywall 开放获取
    async fn resolve_all_pdf_urls(
        &self,
        url: Option<&str>,
        doi: Option<&str>,
        arxiv_id: Option<&str>,
    ) -> Vec<(String, String)> {
        let mut candidates: Vec<(String, String)> = Vec::new();

        // 1. 直接 URL
        if let Some(u) = url {
            if !u.is_empty() {
                candidates.push((u.to_string(), "Direct".to_string()));
            }
        }

        // 2. arXiv 主站 + 镜像
        if let Some(id) = arxiv_id {
            if !id.is_empty() {
                let clean_id = id
                    .trim()
                    .strip_prefix("arXiv:")
                    .or_else(|| id.strip_prefix("arxiv:"))
                    .unwrap_or(id);
                // 主站
                let main_url = format!("https://arxiv.org/pdf/{}", clean_id);
                if !candidates.iter().any(|(u, _)| u == &main_url) {
                    candidates.push((main_url, "arXiv".to_string()));
                }
                // 镜像站（export 子域，不同 CDN）
                candidates.push((
                    format!("https://export.arxiv.org/pdf/{}", clean_id),
                    "arXiv Export".to_string(),
                ));
            }
        }

        // 3. DOI → Unpaywall 开放获取
        if let Some(d) = doi {
            if !d.is_empty() {
                let clean_doi = d
                    .trim()
                    .strip_prefix("https://doi.org/")
                    .unwrap_or(d);
                match self.resolve_doi_to_pdf(clean_doi).await {
                    Ok(pdf_url) => {
                        if !candidates.iter().any(|(u, _)| u == &pdf_url) {
                            candidates.push((pdf_url, "Unpaywall".to_string()));
                        }
                    }
                    Err(e) => {
                        log::debug!("[PaperSave] Unpaywall resolve failed for DOI '{}': {}", d, e);
                    }
                }
            }
        }

        // 4. 如果直接 URL 看起来像 arXiv，补充镜像源
        if let Some(u) = url {
            if u.contains("arxiv.org/pdf/") {
                if let Some(id_part) = u.split("arxiv.org/pdf/").nth(1) {
                    let clean = id_part.trim_end_matches(".pdf").trim_end_matches('/');
                    let export_url = format!("https://export.arxiv.org/pdf/{}", clean);
                    if !candidates.iter().any(|(existing, _)| existing == &export_url) {
                        candidates.push((export_url, "arXiv Export".to_string()));
                    }
                }
            }
        }

        candidates
    }

    /// 通过 Unpaywall API 将 DOI 解析为开放获取 PDF URL
    async fn resolve_doi_to_pdf(&self, doi: &str) -> Result<String, String> {
        let url = format!(
            "{}/{}?email=support@deepstudent.app",
            UNPAYWALL_API_URL, doi
        );

        log::debug!("[PaperSave] Unpaywall lookup: {}", url);

        let response = self
            .unpaywall_client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Unpaywall request failed: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Unpaywall returned HTTP {} for DOI '{}'. The paper may not have an open access version.",
                response.status().as_u16(),
                doi
            ));
        }

        let body: Value = response
            .json()
            .await
            .map_err(|e| format!("Unpaywall parse failed: {}", e))?;

        // 尝试 best_oa_location.url_for_pdf
        if let Some(pdf_url) = body
            .get("best_oa_location")
            .and_then(|loc| loc.get("url_for_pdf"))
            .and_then(|v| v.as_str())
        {
            if !pdf_url.is_empty() {
                return Ok(pdf_url.to_string());
            }
        }

        // 回退：遍历所有 oa_locations
        if let Some(locations) = body.get("oa_locations").and_then(|v| v.as_array()) {
            for loc in locations {
                if let Some(pdf_url) = loc.get("url_for_pdf").and_then(|v| v.as_str()) {
                    if !pdf_url.is_empty() {
                        return Ok(pdf_url.to_string());
                    }
                }
            }
        }

        Err(format!(
            "No open access PDF found for DOI '{}'. The paper may be behind a paywall.",
            doi
        ))
    }

    /// 下载 PDF 文件（带流式进度上报）
    async fn download_pdf_with_progress(
        &self,
        url: &str,
        ctx: &ExecutionContext,
        progress: &mut Vec<PaperProgressItem>,
        idx: usize,
    ) -> Result<Vec<u8>, String> {
        // 安全检查：只允许 HTTPS（除 localhost）
        if !url.starts_with("https://") && !url.starts_with("http://localhost/") && !url.starts_with("http://localhost:") && url != "http://localhost" {
            return Err(format!("Only HTTPS URLs are allowed: {}", url));
        }

        let response = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                result = self.download_client.get(url).send() => {
                    result.map_err(|e| format!("PDF download failed: {}", e))?
                }
                _ = cancel_token.cancelled() => {
                    return Err("Download cancelled".to_string());
                }
            }
        } else {
            self.download_client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("PDF download failed: {}", e))?
        };

        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "PDF download returned HTTP {} from {}",
                status.as_u16(),
                url
            ));
        }

        // Content-Length 预防 OOM + 用于进度计算
        let total_size = response.content_length();
        if let Some(cl) = total_size {
            if cl as usize > MAX_PDF_SIZE {
                return Err(format!(
                    "PDF too large: {} MB (limit: {} MB)",
                    cl / (1024 * 1024),
                    MAX_PDF_SIZE / (1024 * 1024)
                ));
            }
            progress[idx].total_bytes = Some(cl);
        }

        // 流式读取 response body，每 PROGRESS_BYTES_INTERVAL 发射一次进度
        let mut buffer = Vec::with_capacity(total_size.unwrap_or(1024 * 1024) as usize);
        let mut downloaded: u64 = 0;
        let mut last_emit_at: u64 = 0;
        let mut response = response;

        loop {
            let chunk_result = if let Some(cancel_token) = ctx.cancellation_token() {
                tokio::select! {
                    result = response.chunk() => result,
                    _ = cancel_token.cancelled() => {
                        return Err("Download cancelled".to_string());
                    }
                }
            } else {
                response.chunk().await
            };

            match chunk_result {
                Ok(Some(chunk)) => {
                    downloaded += chunk.len() as u64;

                    if buffer.len() + chunk.len() > MAX_PDF_SIZE {
                        return Err(format!(
                            "PDF too large: >{} MB (limit: {} MB)",
                            MAX_PDF_SIZE / (1024 * 1024),
                            MAX_PDF_SIZE / (1024 * 1024)
                        ));
                    }

                    buffer.extend_from_slice(&chunk);

                    // 节流进度发射
                    if downloaded - last_emit_at >= PROGRESS_BYTES_INTERVAL as u64 {
                        last_emit_at = downloaded;
                        progress[idx].downloaded = Some(downloaded);
                        progress[idx].percent = if let Some(total) = total_size {
                            ((downloaded as f64 / total as f64) * 100.0).min(99.0) as u8
                        } else {
                            0 // 未知大小时不显示百分比
                        };
                        emit_progress(ctx, progress);
                    }
                }
                Ok(None) => break, // 下载完成
                Err(e) => {
                    return Err(format!("PDF read failed: {}", e));
                }
            }
        }

        // 最终进度
        progress[idx].downloaded = Some(downloaded);
        progress[idx].percent = 100;
        emit_progress(ctx, progress);

        // PDF 签名验证
        if buffer.len() < 4 || &buffer[..4] != b"%PDF" {
            return Err("Downloaded file is not a valid PDF (missing %PDF header)".to_string());
        }

        Ok(buffer)
    }

    // ========================================================================
    // cite_format — 引用格式化
    // ========================================================================

    fn execute_cite_format(&self, call: &ToolCall) -> Result<Value, String> {
        let papers = call
            .arguments
            .get("papers")
            .and_then(|v| v.as_array())
            .ok_or("Missing required parameter 'papers' (array)")?;

        let format = call
            .arguments
            .get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("bibtex");

        let mut citations = Vec::new();

        for paper in papers {
            let citation = match format {
                "bibtex" => Self::format_bibtex(paper),
                "gbt7714" => Self::format_gbt7714(paper),
                "apa" => Self::format_apa(paper),
                _ => Err(format!("Unsupported format: '{}'. Use 'bibtex', 'gbt7714', or 'apa'.", format)),
            }?;
            citations.push(json!({
                "title": paper.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "citation": citation,
            }));
        }

        Ok(json!({
            "format": format,
            "count": citations.len(),
            "citations": citations,
        }))
    }

    /// 格式化为 BibTeX
    fn format_bibtex(paper: &Value) -> Result<String, String> {
        let title = paper.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled");
        let year = paper.get("year").and_then(|v| v.as_u64()).unwrap_or(0);
        let doi = paper.get("doi").and_then(|v| v.as_str()).unwrap_or("");
        let venue = paper.get("venue").and_then(|v| v.as_str()).unwrap_or("");

        let authors = Self::extract_authors_list(paper);
        let author_str = authors.join(" and ");

        // 生成 cite key: 第一作者姓 + 年份
        let cite_key = {
            let first_author = authors.first().map(|s| s.as_str()).unwrap_or("unknown");
            let last_name = first_author.split_whitespace().last().unwrap_or("unknown");
            let clean = last_name
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase();
            format!("{}{}", clean, year)
        };

        let mut bib = format!("@article{{{},\n", cite_key);
        bib.push_str(&format!("  title = {{{}}},\n", title));
        if !author_str.is_empty() {
            bib.push_str(&format!("  author = {{{}}},\n", author_str));
        }
        if year > 0 {
            bib.push_str(&format!("  year = {{{}}},\n", year));
        }
        if !venue.is_empty() {
            bib.push_str(&format!("  journal = {{{}}},\n", venue));
        }
        if !doi.is_empty() {
            bib.push_str(&format!("  doi = {{{}}},\n", doi));
        }
        bib.push('}');

        Ok(bib)
    }

    /// 格式化为 GB/T 7714
    fn format_gbt7714(paper: &Value) -> Result<String, String> {
        let title = paper.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled");
        let year = paper.get("year").and_then(|v| v.as_u64()).unwrap_or(0);
        let doi = paper.get("doi").and_then(|v| v.as_str()).unwrap_or("");
        let venue = paper.get("venue").and_then(|v| v.as_str()).unwrap_or("");

        let authors = Self::extract_authors_list(paper);

        // GB/T 7714 格式：作者. 标题[J]. 期刊, 年份.
        let author_str = if authors.len() > 3 {
            format!("{}, 等", authors[..3].join(", "))
        } else {
            authors.join(", ")
        };

        let mut citation = String::new();
        if !author_str.is_empty() {
            citation.push_str(&author_str);
            citation.push_str(". ");
        }
        citation.push_str(title);
        citation.push_str("[J]. ");
        if !venue.is_empty() {
            citation.push_str(venue);
            citation.push_str(", ");
        }
        if year > 0 {
            citation.push_str(&format!("{}", year));
        }
        citation.push('.');
        if !doi.is_empty() {
            citation.push_str(&format!(" DOI: {}.", doi));
        }

        Ok(citation)
    }

    /// 格式化为 APA 格式
    fn format_apa(paper: &Value) -> Result<String, String> {
        let title = paper.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled");
        let year = paper.get("year").and_then(|v| v.as_u64()).unwrap_or(0);
        let doi = paper.get("doi").and_then(|v| v.as_str()).unwrap_or("");
        let venue = paper.get("venue").and_then(|v| v.as_str()).unwrap_or("");

        let authors = Self::extract_authors_list(paper);

        // APA: Last, F. M., & Last, F. M. (Year). Title. Journal. DOI
        let apa_authors: Vec<String> = authors
            .iter()
            .map(|name| {
                let parts: Vec<&str> = name.split_whitespace().collect();
                if parts.len() >= 2 {
                    let last = parts.last().unwrap();
                    let initials: String = parts[..parts.len() - 1]
                        .iter()
                        .map(|p| format!("{}.", p.chars().next().unwrap_or('?')))
                        .collect::<Vec<_>>()
                        .join(" ");
                    format!("{}, {}", last, initials)
                } else {
                    name.clone()
                }
            })
            .collect();

        let author_str = if apa_authors.len() > 7 {
            format!(
                "{}, ... {}",
                apa_authors[..6].join(", "),
                apa_authors.last().unwrap()
            )
        } else if apa_authors.len() == 2 {
            format!("{}, & {}", apa_authors[0], apa_authors[1])
        } else if apa_authors.len() > 2 {
            let last = apa_authors.last().unwrap().clone();
            let rest = apa_authors[..apa_authors.len() - 1].join(", ");
            format!("{}, & {}", rest, last)
        } else {
            apa_authors.join(", ")
        };

        let mut citation = String::new();
        if !author_str.is_empty() {
            citation.push_str(&author_str);
            citation.push(' ');
        }
        if year > 0 {
            citation.push_str(&format!("({}). ", year));
        }
        citation.push_str(title);
        citation.push('.');
        if !venue.is_empty() {
            citation.push_str(&format!(" *{}*.", venue));
        }
        if !doi.is_empty() {
            let clean_doi = doi.strip_prefix("https://doi.org/").unwrap_or(doi);
            citation.push_str(&format!(" https://doi.org/{}", clean_doi));
        }

        Ok(citation)
    }

    /// 提取作者列表
    fn extract_authors_list(paper: &Value) -> Vec<String> {
        if let Some(arr) = paper.get("authors").and_then(|v| v.as_array()) {
            arr.iter()
                .filter_map(|a| a.as_str().map(|s| s.to_string()))
                .collect()
        } else if let Some(s) = paper.get("authors").and_then(|v| v.as_str()) {
            s.split(", ").map(|s| s.to_string()).collect()
        } else {
            vec![]
        }
    }
}

impl Default for PaperSaveExecutor {
    fn default() -> Self {
        Self::new()
    }
}

/// 文件名净化：移除非法字符
fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ if c.is_control() => '_',
            _ => c,
        })
        .collect();

    // 按字符数截断（非字节数），避免多字节字符边界 panic
    let max_chars = 100;
    if sanitized.chars().count() > max_chars {
        sanitized.chars().take(max_chars).collect()
    } else {
        sanitized
    }
}

#[async_trait]
impl ToolExecutor for PaperSaveExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        matches!(stripped, "paper_save" | "cite_format")
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!(
            "[PaperSave] Executing: {} (full: {})",
            tool_name,
            call.name
        );

        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id),
            None,
        );

        let result = match tool_name {
            "paper_save" => self.execute_paper_save(call, ctx).await,
            "cite_format" => self.execute_cite_format(call),
            _ => Err(format!("Unknown paper tool: {}", tool_name)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emitter.emit_end(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({
                        "result": output,
                        "durationMs": duration,
                    })),
                    None,
                );

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[PaperSave] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &e, None);

                log::warn!(
                    "[PaperSave] Tool {} failed: {} ({}ms)",
                    call.name,
                    e,
                    duration
                );

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[PaperSave] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn name(&self) -> &'static str {
        "PaperSaveExecutor"
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            // paper_save 下载外部文件到本地，敏感等级 Medium
            "paper_save" => ToolSensitivity::Medium,
            // cite_format 纯格式化，无副作用
            "cite_format" => ToolSensitivity::Low,
            _ => ToolSensitivity::Medium,
        }
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = PaperSaveExecutor::new();
        assert!(executor.can_handle("builtin-paper_save"));
        assert!(executor.can_handle("builtin-cite_format"));
        assert!(!executor.can_handle("builtin-arxiv_search"));
        assert!(!executor.can_handle("builtin-web_search"));
    }

    #[test]
    fn test_sensitivity() {
        let executor = PaperSaveExecutor::new();
        assert!(matches!(
            executor.sensitivity_level("builtin-paper_save"),
            ToolSensitivity::Medium
        ));
        assert!(matches!(
            executor.sensitivity_level("builtin-cite_format"),
            ToolSensitivity::Low
        ));
    }

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(
            sanitize_filename("A Survey of Transformers"),
            "A Survey of Transformers"
        );
        assert_eq!(
            sanitize_filename("What/Why:How?"),
            "What_Why_How_"
        );
        assert_eq!(
            sanitize_filename("Test <file> \"name\""),
            "Test _file_ _name_"
        );
    }

    #[test]
    fn test_sanitize_filename_chinese_truncation() {
        // 101 个中文字符 → 截断为 100 个字符（不会在多字节边界 panic）
        let long_chinese = "基".repeat(101);
        let result = sanitize_filename(&long_chinese);
        assert_eq!(result.chars().count(), 100);
        // 确保结果仍是有效 UTF-8（不会截断到字节边界）
        assert!(result.is_ascii() || result.len() > 100);
    }

    #[test]
    fn test_format_bibtex() {
        let paper = json!({
            "title": "Attention Is All You Need",
            "authors": ["Ashish Vaswani", "Noam Shazeer"],
            "year": 2017,
            "venue": "NeurIPS",
            "doi": "10.5555/3295222.3295349",
        });
        let bib = PaperSaveExecutor::format_bibtex(&paper).unwrap();
        assert!(bib.contains("@article{vaswani2017"));
        assert!(bib.contains("Attention Is All You Need"));
        assert!(bib.contains("Ashish Vaswani and Noam Shazeer"));
    }

    #[test]
    fn test_format_gbt7714() {
        let paper = json!({
            "title": "Attention Is All You Need",
            "authors": ["Ashish Vaswani", "Noam Shazeer"],
            "year": 2017,
            "venue": "NeurIPS",
        });
        let citation = PaperSaveExecutor::format_gbt7714(&paper).unwrap();
        assert!(citation.contains("Ashish Vaswani, Noam Shazeer."));
        assert!(citation.contains("Attention Is All You Need[J]."));
        assert!(citation.contains("NeurIPS, 2017."));
    }

    #[test]
    fn test_format_apa() {
        let paper = json!({
            "title": "Attention Is All You Need",
            "authors": ["Ashish Vaswani", "Noam Shazeer"],
            "year": 2017,
            "venue": "NeurIPS",
            "doi": "10.5555/3295222.3295349",
        });
        let citation = PaperSaveExecutor::format_apa(&paper).unwrap();
        assert!(citation.contains("Vaswani, A."));
        assert!(citation.contains("(2017)"));
        assert!(citation.contains("*NeurIPS*"));
    }

    #[test]
    fn test_format_gbt7714_many_authors() {
        let paper = json!({
            "title": "Test Paper",
            "authors": ["Author A", "Author B", "Author C", "Author D", "Author E"],
            "year": 2024,
        });
        let citation = PaperSaveExecutor::format_gbt7714(&paper).unwrap();
        // GB/T 7714: >3 authors → 前3 + "等"
        assert!(citation.contains("Author A, Author B, Author C, 等."));
    }
}
