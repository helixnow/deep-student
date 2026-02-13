//! 媒体预处理流水线服务（PDF + 图片）
//!
//! 负责在媒体文件上传后自动执行预处理流水线：
//!
//! ## PDF 处理流程
//! - Stage 1: 文本提取 (text_extraction) - 已在上传时完成
//! - Stage 2: 页面渲染 (page_rendering) - 已在上传时完成
//! - Stage 3: OCR 处理 (ocr_processing) - 复用 VFS Blob 中的预渲染图片
//! - Stage 4: 向量索引 (vector_indexing)
//!
//! ## 图片处理流程（v2.0 新增）
//! - Stage 1: 图片压缩 (image_compression) - 可选，大于阈值才压缩
//! - Stage 2: OCR 识别 (ocr_processing) - 单张图片 OCR
//! - Stage 3: 向量索引 (vector_indexing)
//!
//! ## 设计原则
//! - 异步执行：上传立即返回，后台处理
//! - 状态可见：前端实时显示处理进度
//! - 可取消：支持取消正在进行的处理
//! - 可重试：失败后可重试
//! - 图片复用：PDF Stage 3 复用 Stage 2 预渲染的图片，无需重新渲染
//! - 统一架构：PDF 和图片共享相同的事件系统和状态管理
//!
//! ## 参考文档
//! - docs/design/pdf-preprocessing-pipeline.md

use base64::Engine;
use dashmap::DashMap;
use futures::stream::{self, StreamExt};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, RwLock};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use crate::database::Database;

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[MediaProcessingService] Row parse error (skipped): {}", e);
            None
        }
    }
}
use crate::file_manager::FileManager;
use crate::llm_manager::LLMManager;
use crate::models::PdfOcrTextBlock;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::index_service::VfsIndexService;
use crate::vfs::indexing::VfsFullIndexingService;
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};
use crate::vfs::types::PdfPreviewJson;
use crate::vfs::unit_builder::UnitBuildInput;

// ============================================================================
// 处理状态枚举
// ============================================================================

/// 媒体类型枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaType {
    /// PDF 文档
    Pdf,
    /// 图片
    Image,
}

impl MediaType {
    pub fn as_str(&self) -> &'static str {
        match self {
            MediaType::Pdf => "pdf",
            MediaType::Image => "image",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pdf" => Some(MediaType::Pdf),
            "image" => Some(MediaType::Image),
            _ => None,
        }
    }

    /// 从 MIME 类型推断媒体类型
    pub fn from_mime(mime: &str) -> Option<Self> {
        if mime == "application/pdf" {
            Some(MediaType::Pdf)
        } else if mime.starts_with("image/") {
            Some(MediaType::Image)
        } else {
            None
        }
    }
}

/// 处理阶段枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessingStage {
    /// 等待处理
    Pending,
    /// 文本提取中（PDF 专用）
    TextExtraction,
    /// 页面渲染中（PDF 专用）
    PageRendering,
    /// 页面压缩中（PDF 专用）
    PageCompression,
    /// 图片压缩中（图片专用）
    ImageCompression,
    /// OCR 处理中（PDF 多页 / 图片单张）
    OcrProcessing,
    /// 向量索引中
    VectorIndexing,
    /// 处理完成
    Completed,
    /// 处理失败
    Error,
}

impl ProcessingStage {
    /// 转换为数据库存储的字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            ProcessingStage::Pending => "pending",
            ProcessingStage::TextExtraction => "text_extraction",
            ProcessingStage::PageRendering => "page_rendering",
            ProcessingStage::PageCompression => "page_compression",
            ProcessingStage::ImageCompression => "image_compression",
            ProcessingStage::OcrProcessing => "ocr_processing",
            ProcessingStage::VectorIndexing => "vector_indexing",
            ProcessingStage::Completed => "completed",
            ProcessingStage::Error => "error",
        }
    }

    /// 从字符串解析
    pub fn from_str(s: &str) -> Self {
        let normalized = s.trim().to_lowercase();
        match normalized.as_str() {
            "pending" => ProcessingStage::Pending,
            "text_extraction" => ProcessingStage::TextExtraction,
            "page_rendering" => ProcessingStage::PageRendering,
            "page_compression" => ProcessingStage::PageCompression,
            "image_compression" => ProcessingStage::ImageCompression,
            "ocr_processing" => ProcessingStage::OcrProcessing,
            "vector_indexing" => ProcessingStage::VectorIndexing,
            "completed" => ProcessingStage::Completed,
            "error" => ProcessingStage::Error,
            _ => ProcessingStage::Pending,
        }
    }
}

/// 处理进度
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingProgress {
    /// 当前阶段
    pub stage: String,
    /// 当前处理的页码（PDF 渲染/OCR 时使用，图片始终为 1）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_page: Option<usize>,
    /// 总页数（PDF 专用，图片始终为 1）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_pages: Option<usize>,
    /// 总进度百分比 (0-100)
    pub percent: f32,
    /// 已就绪的注入模式
    /// - PDF: ["text", "image", "ocr"]
    /// - 图片: ["image", "ocr"]
    pub ready_modes: Vec<String>,
    /// 媒体类型（v2.0 新增）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

impl Default for ProcessingProgress {
    fn default() -> Self {
        Self {
            stage: "pending".to_string(),
            current_page: None,
            total_pages: None,
            percent: 0.0,
            ready_modes: vec![],
            media_type: None,
        }
    }
}

/// 处理状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingStatus {
    /// 文件 ID
    pub file_id: String,
    /// 当前阶段
    pub stage: String,
    /// 进度
    pub progress: ProcessingProgress,
    /// 错误信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 开始时间戳（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    /// 完成时间戳（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
}

// ============================================================================
// OCR 策略配置
// ============================================================================

/// PDF 文本提取阈值默认值（字符数）
/// 如果提取的文本少于此阈值，则认为是扫描版 PDF，需要触发 OCR
const DEFAULT_PDF_TEXT_THRESHOLD: usize = 100;

/// OCR 策略配置（与设置面板保持一致）
#[derive(Debug, Clone)]
struct OcrStrategyConfig {
    /// 是否启用自动 OCR
    pub enabled: bool,
    /// 多模态模型跳过 OCR（当前统一跳过）
    pub skip_for_multimodal: bool,
    /// PDF 文本阈值（字符数，低于此值触发 OCR）
    pub pdf_text_threshold: usize,
    /// 是否对图片启用 OCR
    pub ocr_images: bool,
    /// 是否对扫描版 PDF 启用 OCR
    pub ocr_scanned_pdf: bool,
}

impl Default for OcrStrategyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            // 默认不跳过 OCR，确保文本索引有内容
            skip_for_multimodal: false,
            pdf_text_threshold: DEFAULT_PDF_TEXT_THRESHOLD,
            ocr_images: true,
            ocr_scanned_pdf: true,
        }
    }
}

impl OcrStrategyConfig {
    /// 从数据库设置加载配置
    fn load_from_db(db: &Database) -> Self {
        let mut config = Self::default();

        if let Ok(Some(v)) = db.get_setting("ocr.enabled") {
            config.enabled = v.to_lowercase() == "true";
        }
        if let Ok(Some(v)) = db.get_setting("ocr.skip_for_multimodal") {
            config.skip_for_multimodal = v.to_lowercase() == "true";
        }
        if let Ok(Some(v)) = db.get_setting("ocr.pdf_text_threshold") {
            if let Ok(n) = v.parse::<usize>() {
                config.pdf_text_threshold = n;
            }
        }
        if let Ok(Some(v)) = db.get_setting("ocr.images") {
            config.ocr_images = v.to_lowercase() == "true";
        }
        if let Ok(Some(v)) = db.get_setting("ocr.scanned_pdf") {
            config.ocr_scanned_pdf = v.to_lowercase() == "true";
        }

        config
    }
}

// ============================================================================
// 事件类型
// ============================================================================

/// 进度事件（统一媒体处理事件）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProcessingProgressEvent {
    pub file_id: String,
    pub status: ProcessingProgress,
    pub media_type: String,
}

/// 完成事件（统一媒体处理事件）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProcessingCompletedEvent {
    pub file_id: String,
    pub ready_modes: Vec<String>,
    pub media_type: String,
}

/// 错误事件（统一媒体处理事件）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProcessingErrorEvent {
    pub file_id: String,
    pub error: String,
    pub stage: String,
    pub media_type: String,
}

// 兼容旧事件类型别名
pub type PdfProcessingProgressEvent = MediaProcessingProgressEvent;
pub type PdfProcessingCompletedEvent = MediaProcessingCompletedEvent;
pub type PdfProcessingErrorEvent = MediaProcessingErrorEvent;

// ============================================================================
// OCR 处理常量
// ============================================================================

/// OCR 最大并发数
const MAX_OCR_CONCURRENCY: usize = 4;
/// OCR 最大重试次数
const MAX_OCR_RETRY_ATTEMPTS: usize = 3;
/// 初始退避时间（毫秒）
const INITIAL_BACKOFF_MS: u64 = 1000;
/// 最大退避时间（毫秒）
const MAX_BACKOFF_MS: u64 = 20_000;

// ============================================================================
// OCR 结果类型
// ============================================================================

/// 单页 OCR 结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageResult {
    /// 页码（0-indexed）
    pub page_index: usize,
    /// OCR 识别的文本块
    pub blocks: Vec<PdfOcrTextBlock>,
}

/// OCR 结果 JSON（存储在 ocr_pages_json 字段）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPagesJson {
    /// 总页数
    pub total_pages: usize,
    /// 每页的 OCR 结果
    pub pages: Vec<OcrPageResult>,
    /// OCR 完成时间
    pub completed_at: String,
}

// ============================================================================
// 服务实现
// ============================================================================

// ============================================================================
// 图片压缩配置
// ============================================================================

/// 图片压缩配置
pub struct ImageCompressionConfig {
    /// 是否启用压缩（默认 true）
    pub enabled: bool,
    /// 压缩阈值：超过此大小才压缩（默认 1MB）
    pub size_threshold: usize,
    /// 像素阈值：超过此像素才压缩（默认 2 百万像素 = 2MP）
    pub pixel_threshold: usize,
    /// 压缩质量（默认 "medium"）
    pub quality: String, // "low" | "medium" | "high" | "auto"
}

impl Default for ImageCompressionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            size_threshold: 1 * 1024 * 1024, // 1MB
            pixel_threshold: 2_000_000,      // 2MP
            quality: "medium".to_string(),
        }
    }
}

// ============================================================================
// 服务实现
// ============================================================================

/// 媒体预处理服务（PDF + 图片）
///
/// ## 依赖
/// - `db`: VFS 数据库（用于获取 blob 路径和更新 OCR 结果）
/// - `llm_manager`: LLM 管理器（用于调用 OCR API）
/// - `file_manager`: 文件管理器（用于解析图片路径和图片压缩）
pub struct PdfProcessingService {
    /// VFS 数据库
    db: Arc<VfsDatabase>,
    /// 设置数据库（用于 OCR 策略）
    settings_db: Arc<Database>,
    /// LLM 管理器（用于 OCR API 调用）
    llm_manager: Arc<LLMManager>,
    /// 文件管理器（用于图片路径解析）
    file_manager: Arc<FileManager>,
    /// 运行中的任务追踪：file_id -> (CancellationToken, generation)
    /// ★ P0 修复：增加 generation 标识，避免 cancel+restart 竞态条件
    running_tasks: DashMap<String, (CancellationToken, u64)>,
    /// 任务 generation 计数器（单调递增，用于区分同 file_id 的不同任务）
    generation_counter: AtomicU64,
    /// App Handle（用于发送事件）
    app_handle: RwLock<Option<AppHandle>>,
}

impl PdfProcessingService {
    /// 创建新的 PDF 预处理服务
    ///
    /// ## 参数
    /// - `db`: VFS 数据库
    /// - `llm_manager`: LLM 管理器（用于 OCR API）
    /// - `file_manager`: 文件管理器
    pub fn new(
        db: Arc<VfsDatabase>,
        settings_db: Arc<Database>,
        llm_manager: Arc<LLMManager>,
        file_manager: Arc<FileManager>,
    ) -> Self {
        Self {
            db,
            settings_db,
            llm_manager,
            file_manager,
            running_tasks: DashMap::new(),
            generation_counter: AtomicU64::new(0),
            app_handle: RwLock::new(None),
        }
    }

    fn load_ocr_config(&self) -> OcrStrategyConfig {
        OcrStrategyConfig::load_from_db(&self.settings_db)
    }

    /// 设置 App Handle
    pub async fn set_app_handle(&self, app_handle: AppHandle) {
        let mut handle = self.app_handle.write().await;
        *handle = Some(app_handle);
    }

    /// 获取 App Handle
    async fn get_app_handle(&self) -> Option<AppHandle> {
        let handle = self.app_handle.read().await;
        handle.clone()
    }

    /// 启动媒体预处理流水线
    ///
    /// 异步执行，立即返回。处理在后台进行。
    /// 自动检测媒体类型（PDF/图片）并选择正确的处理流程。
    ///
    /// ## 参数
    /// - `file_id`: 文件 ID
    /// - `start_from_stage`: 从哪个阶段开始
    ///   - PDF: 默认从 OCR 阶段开始（文本提取和页面渲染已在上传时完成）
    ///   - 图片: 默认从压缩阶段开始
    pub async fn start_pipeline(
        self: &Arc<Self>,
        file_id: &str,
        start_from_stage: Option<ProcessingStage>,
    ) -> VfsResult<()> {
        let file_id = file_id.to_string();

        // 检测媒体类型
        let media_type = self.detect_media_type(&file_id)?;
        info!(
            "[MediaProcessingService] Detected media type: {:?} for file: {}",
            media_type, file_id
        );

        // 根据媒体类型选择默认起始阶段
        let start_stage = start_from_stage.unwrap_or_else(|| match media_type {
            MediaType::Pdf => ProcessingStage::OcrProcessing,
            MediaType::Image => ProcessingStage::ImageCompression,
        });

        // ★ P0 修复：使用原子操作检查并插入，避免 TOCTOU 竞态条件
        // ★ P0-2 修复：使用 generation counter 避免 cancel+restart 竞态
        let cancel_token = CancellationToken::new();
        let generation = self.generation_counter.fetch_add(1, Ordering::SeqCst);
        {
            use dashmap::mapref::entry::Entry;
            match self.running_tasks.entry(file_id.clone()) {
                Entry::Occupied(_) => {
                    warn!(
                        "[MediaProcessingService] Pipeline already running for file: {}",
                        file_id
                    );
                    return Ok(());
                }
                Entry::Vacant(entry) => {
                    entry.insert((cancel_token.clone(), generation));
                }
            }
        }

        // 更新数据库状态
        self.update_processing_status(&file_id, start_stage, None, None)
            .await?;

        // 克隆 self 用于异步任务
        let service = Arc::clone(self);
        let file_id_clone = file_id.clone();
        let initial_stage = start_stage; // 保存初始阶段用于错误报告
        let mt = media_type; // 捕获媒体类型

        // 启动后台任务
        tokio::spawn(async move {
            // ★ P0 修复：使用 defer 模式确保 running_tasks 在任何情况下都被清理
            // 包括 panic、早期 return、正常完成
            let file_id_for_cleanup = file_id_clone.clone();
            let service_for_cleanup = Arc::clone(&service);

            // 使用 scopeguard 模式：创建一个在 drop 时清理的闭包
            struct CleanupOnDrop<F: FnOnce()>(Option<F>);
            impl<F: FnOnce()> Drop for CleanupOnDrop<F> {
                fn drop(&mut self) {
                    if let Some(f) = self.0.take() {
                        f();
                    }
                }
            }

            // ★ P0-2 修复：cleanup guard 仅删除同 generation 的条目
            // 防止 cancel+start 场景中旧任务的 guard 误删新任务条目
            let task_generation = generation;
            let _cleanup_guard = CleanupOnDrop(Some(move || {
                service_for_cleanup
                    .running_tasks
                    .remove_if(&file_id_for_cleanup, |_, (_, gen)| *gen == task_generation);
                debug!(
                    "[MediaProcessingService] Task cleanup guard triggered for file: {} (gen={})",
                    file_id_for_cleanup, task_generation
                );
            }));

            let result = match mt {
                MediaType::Pdf => {
                    service
                        .run_pdf_pipeline_internal(
                            &file_id_clone,
                            start_stage,
                            cancel_token.clone(),
                        )
                        .await
                }
                MediaType::Image => {
                    service
                        .run_image_pipeline_internal(
                            &file_id_clone,
                            start_stage,
                            cancel_token.clone(),
                        )
                        .await
                }
            };

            // 注意：running_tasks.remove 现在由 _cleanup_guard 在 drop 时自动执行

            match result {
                Ok(()) => {
                    info!(
                        "[MediaProcessingService] Pipeline completed for file: {} (type: {:?})",
                        file_id_clone, mt
                    );
                }
                Err(e) => {
                    error!(
                        "[MediaProcessingService] Pipeline failed for file {} (type: {:?}): {}",
                        file_id_clone, mt, e
                    );
                    // 更新数据库状态为 error（使用初始阶段作为失败阶段）
                    if let Err(db_err) =
                        service.set_error(&file_id_clone, &e.to_string(), initial_stage)
                    {
                        error!(
                            "[MediaProcessingService] Failed to set error status: {}",
                            db_err
                        );
                    }
                    // 发送错误事件（同时发送旧事件和新事件以兼容）
                    if let Some(app_handle) = service.get_app_handle().await {
                        // 新统一事件
                        let _ = app_handle.emit(
                            "media-processing-error",
                            MediaProcessingErrorEvent {
                                file_id: file_id_clone.clone(),
                                error: e.to_string(),
                                stage: initial_stage.as_str().to_string(),
                                media_type: mt.as_str().to_string(),
                            },
                        );
                        // 旧 PDF 兼容事件
                        if mt == MediaType::Pdf {
                            let _ = app_handle.emit(
                                "pdf-processing-error",
                                MediaProcessingErrorEvent {
                                    file_id: file_id_clone.clone(),
                                    error: e.to_string(),
                                    stage: initial_stage.as_str().to_string(),
                                    media_type: mt.as_str().to_string(),
                                },
                            );
                        }
                    }
                }
            }
        });

        info!(
            "[MediaProcessingService] Pipeline started for file: {} (type: {:?}, from stage: {:?})",
            file_id, media_type, start_stage
        );

        Ok(())
    }

    /// 检测媒体类型
    fn detect_media_type(&self, file_id: &str) -> VfsResult<MediaType> {
        let conn = self.db.get_conn_safe()?;
        let mime_type: String = conn
            .query_row(
                "SELECT mime_type FROM files WHERE id = ?1",
                params![file_id],
                |row| row.get(0),
            )
            .map_err(|e| VfsError::Database(format!("Failed to get mime_type: {}", e)))?;

        MediaType::from_mime(&mime_type).ok_or_else(|| VfsError::InvalidArgument {
            param: "mime_type".to_string(),
            reason: format!(
                "Unsupported media type: {} for file: {}",
                mime_type, file_id
            ),
        })
    }

    /// PDF 流水线内部执行
    async fn run_pdf_pipeline_internal(
        &self,
        file_id: &str,
        start_stage: ProcessingStage,
        cancel_token: CancellationToken,
    ) -> VfsResult<()> {
        // 获取文件信息
        let conn = self.db.get_conn_safe()?;
        let (page_count, has_extracted_text, extracted_text_len, has_preview, has_ocr): (
            Option<i32>,
            bool,
            i64,
            bool,
            bool,
        ) = conn
            .query_row(
                r#"
                SELECT page_count,
                       extracted_text IS NOT NULL,
                       COALESCE(LENGTH(extracted_text), 0),
                       preview_json IS NOT NULL,
                       ocr_pages_json IS NOT NULL
                FROM files WHERE id = ?1
                "#,
                params![file_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get::<_, i32>(1)? != 0,
                        row.get(2)?,
                        row.get::<_, i32>(3)? != 0,
                        row.get::<_, i32>(4)? != 0,
                    ))
                },
            )
            .map_err(|e| VfsError::Database(format!("Failed to get file info: {}", e)))?;

        let total_pages = page_count.unwrap_or(0) as usize;
        let extracted_text_len = extracted_text_len.max(0) as usize;
        let ocr_config = self.load_ocr_config();

        // 确定初始就绪模式
        // ★ P0 架构改造：image 模式必须等到页面压缩完成后才就绪
        let mut ready_modes: Vec<String> = vec![];
        if has_extracted_text {
            ready_modes.push("text".to_string());
        }
        // 注意：不再根据 has_preview 直接添加 image，需要检查压缩状态
        if has_ocr {
            ready_modes.push("ocr".to_string());
        }

        // ★ P0 架构改造：Stage 2.5 页面压缩（在 OCR 之前）
        // 为每个 PDF 页面生成压缩版本，发送时直接使用压缩版本
        if has_preview {
            if cancel_token.is_cancelled() {
                return Ok(());
            }

            // 获取 preview_json
            let preview_json: Option<String> = conn
                .query_row(
                    "SELECT preview_json FROM files WHERE id = ?1",
                    params![file_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| VfsError::Database(format!("Failed to get preview_json: {}", e)))?;

            if let Some(ref pj) = preview_json {
                // 检查是否已经有压缩版本
                let needs_compression = self.check_pdf_pages_need_compression(pj)?;

                if needs_compression {
                    info!(
                        "[PdfProcessingService] Starting page compression for file: {} ({} pages)",
                        file_id, total_pages
                    );

                    // 更新状态为 page_compression
                    self.update_processing_status(
                        file_id,
                        ProcessingStage::PageCompression,
                        None,
                        None,
                    )
                    .await?;

                    // 更新状态并发送进度事件（此时 image 还未就绪）
                    // ★ P1-1 修复：压缩范围 5%-20%
                    let progress = ProcessingProgress {
                        stage: "page_compression".to_string(),
                        current_page: Some(0),
                        total_pages: Some(total_pages),
                        percent: 5.0,
                        ready_modes: ready_modes.clone(),
                        media_type: Some("pdf".to_string()),
                    };
                    self.update_processing_status(
                        file_id,
                        ProcessingStage::PageCompression,
                        Some(&progress),
                        None,
                    )
                    .await?;
                    self.emit_progress(file_id, progress, MediaType::Pdf).await;

                    // 执行页面压缩
                    match self
                        .stage_pdf_page_compression(file_id, pj, total_pages, &cancel_token)
                        .await
                    {
                        Ok(()) => {
                            // ★ P0 改造：压缩完成后，image 模式才就绪
                            if total_pages > 0 && !ready_modes.contains(&"image".to_string()) {
                                ready_modes.push("image".to_string());
                            } else if total_pages == 0 {
                                warn!(
                                    "[PdfProcessingService] Page compression completed but no pages for file: {}",
                                    file_id
                                );
                            }
                            info!(
                                "[PdfProcessingService] Page compression completed for file: {}, ready_modes: {:?}",
                                file_id, ready_modes
                            );
                        }
                        Err(e) => {
                            warn!(
                                "[PdfProcessingService] Page compression failed for file {}: {}",
                                file_id, e
                            );
                            // ★ P0 修复：压缩失败时仍然标记 image 就绪（使用原图回退）
                            if total_pages > 0 && !ready_modes.contains(&"image".to_string()) {
                                ready_modes.push("image".to_string());
                            } else if total_pages == 0 {
                                warn!(
                                    "[PdfProcessingService] Page compression failed and no pages for file: {}",
                                    file_id
                                );
                            }
                            warn!(
                                "[PdfProcessingService] Using original pages as fallback for file: {}",
                                file_id
                            );
                        }
                    }
                } else {
                    // 已经有压缩版本，image 模式就绪
                    if total_pages > 0 && !ready_modes.contains(&"image".to_string()) {
                        ready_modes.push("image".to_string());
                    } else if total_pages == 0 {
                        warn!(
                            "[PdfProcessingService] Preview has no pages for file: {}",
                            file_id
                        );
                    }
                    info!(
                        "[PdfProcessingService] Pages already compressed for file: {}, ready_modes: {:?}",
                        file_id, ready_modes
                    );
                }
            }
        }

        // Stage 3: OCR 处理（如果需要）
        let should_run_pdf_ocr = ocr_config.enabled
            && ocr_config.ocr_scanned_pdf
            && !ocr_config.skip_for_multimodal
            && extracted_text_len < ocr_config.pdf_text_threshold;

        if start_stage <= ProcessingStage::OcrProcessing && !has_ocr && has_preview {
            if !should_run_pdf_ocr {
                info!(
                    "[PdfProcessingService] OCR skipped for file {}: enabled={}, skip_for_multimodal={}, text_len={}, threshold={}",
                    file_id,
                    ocr_config.enabled,
                    ocr_config.skip_for_multimodal,
                    extracted_text_len,
                    ocr_config.pdf_text_threshold
                );
            } else {
                if cancel_token.is_cancelled() {
                    return Ok(());
                }

                // 更新状态
                self.update_processing_status(file_id, ProcessingStage::OcrProcessing, None, None)
                    .await?;

                // 发送进度事件
                // ★ P1-1 修复：进度单调递增（压缩 0-20% → OCR 20-75% → 向量 75-95%）
                self.emit_progress(
                    file_id,
                    ProcessingProgress {
                        stage: "ocr_processing".to_string(),
                        current_page: Some(0),
                        total_pages: Some(total_pages),
                        percent: 20.0,
                        ready_modes: ready_modes.clone(),
                        media_type: Some("pdf".to_string()),
                    },
                    MediaType::Pdf,
                )
                .await;

                // 获取 preview_json 用于 OCR 处理（可能已更新了压缩版本）
                let preview_json: Option<String> = conn
                    .query_row(
                        "SELECT preview_json FROM files WHERE id = ?1",
                        params![file_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| {
                        VfsError::Database(format!("Failed to get preview_json: {}", e))
                    })?;

                if let Some(ref pj) = preview_json {
                    // 执行 OCR 处理（复用预渲染图片）
                    match self
                        .stage_ocr_processing(file_id, pj, &mut ready_modes, &cancel_token)
                        .await
                    {
                        Ok(_) => {
                            info!(
                                "[PdfProcessingService] OCR processing completed for file: {}",
                                file_id
                            );
                        }
                        Err(e) => {
                            warn!(
                                "[PdfProcessingService] OCR processing failed for file {}: {}",
                                file_id, e
                            );
                            // OCR 失败不中断流水线，不标记 error
                        }
                    }
                } else {
                    warn!(
                        "[PdfProcessingService] No preview_json available for OCR, skipping file: {}",
                        file_id
                    );
                }
            }
        } else if !has_ocr && !has_preview {
            info!(
                "[PdfProcessingService] OCR skipped: no preview available for file: {}",
                file_id
            );
        }

        // 如果已有 OCR，添加到就绪模式
        if has_ocr && !ready_modes.contains(&"ocr".to_string()) {
            ready_modes.push("ocr".to_string());
        }

        // Stage 4: 向量索引（如果需要）
        if start_stage <= ProcessingStage::VectorIndexing {
            if cancel_token.is_cancelled() {
                return Ok(());
            }

            // 更新状态
            self.update_processing_status(file_id, ProcessingStage::VectorIndexing, None, None)
                .await?;

            // 执行向量索引
            // 注意：索引失败不会中断流水线，错误会被记录
            if let Err(e) = self
                .stage_vector_indexing(file_id, &mut ready_modes, MediaType::Pdf)
                .await
            {
                warn!(
                    "[PdfProcessingService] Vector indexing stage failed for file {}: {}",
                    file_id, e
                );
                // 索引失败不中断流水线，不标记 error
            }
        }

        // 标记完成
        let now_ms = chrono::Utc::now().timestamp_millis();
        let progress = ProcessingProgress {
            stage: "completed".to_string(),
            current_page: None,
            total_pages: Some(total_pages),
            percent: 100.0,
            ready_modes: ready_modes.clone(),
            media_type: Some("pdf".to_string()),
        };

        self.update_processing_status(
            file_id,
            ProcessingStage::Completed,
            Some(&progress),
            Some(now_ms),
        )
        .await?;

        // 发送完成事件
        self.emit_completed(file_id, ready_modes, MediaType::Pdf)
            .await;

        Ok(())
    }

    // ========================================================================
    // 图片处理流水线（v2.0 新增）
    // ========================================================================

    /// 图片流水线内部执行
    ///
    /// ## 处理流程
    /// - Stage 1: 图片压缩 (image_compression) - 可选，大图才压缩
    /// - Stage 2: OCR 识别 (ocr_processing) - 单张图片 OCR
    /// - Stage 3: 向量索引 (vector_indexing)
    async fn run_image_pipeline_internal(
        &self,
        file_id: &str,
        start_stage: ProcessingStage,
        cancel_token: CancellationToken,
    ) -> VfsResult<()> {
        info!(
            "[MediaProcessingService] Starting image pipeline for file: {} (from stage: {:?})",
            file_id, start_stage
        );

        // 获取文件信息
        let conn = self.db.get_conn_safe()?;
        let (blob_hash, resource_id, file_size, has_ocr, mime_type): (
            Option<String>,
            Option<String>,
            Option<i64>,
            bool,
            Option<String>,
        ) = conn
            .query_row(
                r#"
                SELECT f.blob_hash, f.resource_id, f.size, r.ocr_text IS NOT NULL, f.mime_type
                FROM files f
                LEFT JOIN resources r ON r.id = f.resource_id
                WHERE f.id = ?1
                "#,
                params![file_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get::<_, i32>(3)? != 0,
                        row.get(4)?,
                    ))
                },
            )
            .map_err(|e| VfsError::Database(format!("Failed to get file info: {}", e)))?;

        let blobs_dir = self.db.blobs_dir();

        // 初始化就绪模式
        // ★ P0 架构改造：image 模式必须等到压缩完成后才就绪
        // 原因：发送时不再压缩，必须使用预处理的压缩结果
        let mut ready_modes: Vec<String> = vec![];
        // 检查是否已有压缩版本（compressed_blob_hash 不为空且 blob 存在）
        let has_compressed: bool = conn
            .query_row(
                "SELECT compressed_blob_hash FROM files WHERE id = ?1",
                params![file_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .unwrap_or(None)
            .flatten()
            .map(|h| {
                !h.trim().is_empty()
                    && VfsBlobRepo::get_blob_path_with_conn(&conn, &blobs_dir, &h)
                        .ok()
                        .flatten()
                        .is_some()
            })
            .unwrap_or(false);

        if has_compressed {
            // 已经有压缩版本，image 模式就绪
            ready_modes.push("image".to_string());
        }
        if has_ocr {
            ready_modes.push("ocr".to_string());
        }

        let ocr_config = self.load_ocr_config();
        let should_run_image_ocr =
            ocr_config.enabled && ocr_config.ocr_images && !ocr_config.skip_for_multimodal;

        info!(
            "[OCR_DIAG] Image pipeline OCR decision: file_id={}, has_ocr={}, should_run_image_ocr={}, ocr_config=(enabled={}, ocr_images={}, skip_for_multimodal={}), blob_hash={:?}, resource_id={:?}",
            file_id, has_ocr, should_run_image_ocr,
            ocr_config.enabled, ocr_config.ocr_images, ocr_config.skip_for_multimodal,
            blob_hash, resource_id
        );

        // Stage 1: 图片压缩
        if start_stage <= ProcessingStage::ImageCompression {
            if cancel_token.is_cancelled() {
                return Ok(());
            }

            // 更新状态
            self.update_processing_status(file_id, ProcessingStage::ImageCompression, None, None)
                .await?;

            // 发送进度事件
            self.emit_progress(
                file_id,
                ProcessingProgress {
                    stage: "image_compression".to_string(),
                    current_page: Some(1),
                    total_pages: Some(1),
                    percent: 10.0,
                    ready_modes: ready_modes.clone(),
                    media_type: Some("image".to_string()),
                },
                MediaType::Image,
            )
            .await;

            // 执行压缩（如果需要）
            let compression_config = ImageCompressionConfig::default();
            if compression_config.enabled {
                if let Some(ref bh) = blob_hash {
                    match self
                        .stage_image_compression(file_id, bh, file_size, &compression_config)
                        .await
                    {
                        Ok(_compressed) => {
                            // ★ P0 架构改造：压缩完成后，image 模式才就绪
                            if !ready_modes.contains(&"image".to_string()) {
                                ready_modes.push("image".to_string());
                            }
                            info!(
                                "[MediaProcessingService] Image compression completed for file: {}, ready_modes: {:?}",
                                file_id, ready_modes
                            );
                        }
                        Err(e) => {
                            warn!(
                                "[MediaProcessingService] Image compression failed for file {}: {}",
                                file_id, e
                            );
                            // ★ P0 修复：压缩失败时仍然标记 image 就绪（使用原图回退）
                            // 否则用户将无法发送这个附件
                            if !ready_modes.contains(&"image".to_string()) {
                                ready_modes.push("image".to_string());
                            }
                            warn!(
                                "[MediaProcessingService] Using original image as fallback for file: {}",
                                file_id
                            );
                        }
                    }
                } else {
                    // 没有 blob_hash，检查是否有 inline 内容
                    let base64_content =
                        VfsFileRepo::get_content_with_conn(&conn, &blobs_dir, file_id)?;
                    if base64_content.is_some() {
                        if !ready_modes.contains(&"image".to_string()) {
                            ready_modes.push("image".to_string());
                        }
                    } else {
                        warn!(
                            "[MediaProcessingService] Image compression skipped: no content for file {}",
                            file_id
                        );
                    }
                }
            } else {
                // 压缩功能禁用，确保内容存在后标记 image 就绪
                let has_content = if blob_hash.is_some() {
                    true
                } else {
                    VfsFileRepo::get_content_with_conn(&conn, &blobs_dir, file_id)?.is_some()
                };
                if has_content && !ready_modes.contains(&"image".to_string()) {
                    ready_modes.push("image".to_string());
                } else if !has_content {
                    warn!(
                        "[MediaProcessingService] Image compression disabled but content missing for file {}",
                        file_id
                    );
                }
            }

            // 发送进度更新（现在 ready_modes 包含 image）
            self.emit_progress(
                file_id,
                ProcessingProgress {
                    stage: "image_compression".to_string(),
                    current_page: Some(1),
                    total_pages: Some(1),
                    percent: 25.0,
                    ready_modes: ready_modes.clone(),
                    media_type: Some("image".to_string()),
                },
                MediaType::Image,
            )
            .await;
        }

        // Stage 2: OCR 处理（如果需要）
        if start_stage <= ProcessingStage::OcrProcessing && !has_ocr && should_run_image_ocr {
            info!(
                "[OCR_DIAG] Image OCR Stage 2 ENTERED: file_id={}, start_stage={:?}",
                file_id, start_stage
            );
            if cancel_token.is_cancelled() {
                return Ok(());
            }

            // 更新状态
            self.update_processing_status(file_id, ProcessingStage::OcrProcessing, None, None)
                .await?;

            // 发送进度事件
            self.emit_progress(
                file_id,
                ProcessingProgress {
                    stage: "ocr_processing".to_string(),
                    current_page: Some(1),
                    total_pages: Some(1),
                    percent: 40.0,
                    ready_modes: ready_modes.clone(),
                    media_type: Some("image".to_string()),
                },
                MediaType::Image,
            )
            .await;

            // 执行 OCR
            let mt = mime_type.as_deref().unwrap_or("image/png");
            if let Some(ref bh) = blob_hash {
                match self.stage_image_ocr(file_id, bh, mt).await {
                    Ok(ocr_text) => {
                        info!(
                            "[MediaProcessingService] Image OCR completed for file: {} ({} chars)",
                            file_id,
                            ocr_text.len()
                        );
                        ready_modes.push("ocr".to_string());
                    }
                    Err(e) => {
                        warn!(
                            "[MediaProcessingService] Image OCR failed for file {}: {}",
                            file_id, e
                        );
                        // OCR 失败不中断流水线，不标记 error
                    }
                }
            } else {
                let blobs_dir = self.db.blobs_dir();
                let base64_content =
                    VfsFileRepo::get_content_with_conn(&conn, &blobs_dir, file_id)?;
                if let Some(data) = base64_content {
                    match self.stage_image_ocr_with_base64(file_id, data, mt).await {
                        Ok(ocr_text) => {
                            info!(
                                "[MediaProcessingService] Image OCR completed for file: {} ({} chars)",
                                file_id,
                                ocr_text.len()
                            );
                            ready_modes.push("ocr".to_string());
                        }
                        Err(e) => {
                            warn!(
                                "[MediaProcessingService] Image OCR failed for file {}: {}",
                                file_id, e
                            );
                            // OCR 失败不中断流水线，不标记 error
                        }
                    }
                } else {
                    warn!(
                        "[MediaProcessingService] Image OCR skipped: no content for file {}",
                        file_id
                    );
                }
            }

            // 发送进度更新
            self.emit_progress(
                file_id,
                ProcessingProgress {
                    stage: "ocr_processing".to_string(),
                    current_page: Some(1),
                    total_pages: Some(1),
                    percent: 60.0,
                    ready_modes: ready_modes.clone(),
                    media_type: Some("image".to_string()),
                },
                MediaType::Image,
            )
            .await;
        } else if !has_ocr && !should_run_image_ocr {
            info!(
                "[MediaProcessingService] Image OCR skipped for file {}: enabled={}, skip_for_multimodal={}",
                file_id,
                ocr_config.enabled,
                ocr_config.skip_for_multimodal
            );
        }

        // Stage 3: 向量索引
        if start_stage <= ProcessingStage::VectorIndexing && resource_id.is_some() {
            if cancel_token.is_cancelled() {
                return Ok(());
            }

            // 更新状态
            self.update_processing_status(file_id, ProcessingStage::VectorIndexing, None, None)
                .await?;

            // 执行向量索引
            if let Err(e) = self
                .stage_vector_indexing(file_id, &mut ready_modes, MediaType::Image)
                .await
            {
                warn!(
                    "[MediaProcessingService] Vector indexing stage failed for file {}: {}",
                    file_id, e
                );
                // 索引失败不中断流水线
            }
        }

        // 标记完成
        let now_ms = chrono::Utc::now().timestamp_millis();
        let progress = ProcessingProgress {
            stage: "completed".to_string(),
            current_page: Some(1),
            total_pages: Some(1),
            percent: 100.0,
            ready_modes: ready_modes.clone(),
            media_type: Some("image".to_string()),
        };

        self.update_processing_status(
            file_id,
            ProcessingStage::Completed,
            Some(&progress),
            Some(now_ms),
        )
        .await?;

        // 发送完成事件
        self.emit_completed(file_id, ready_modes, MediaType::Image)
            .await;

        Ok(())
    }

    /// Stage 1: 图片压缩
    ///
    /// ★ P0 架构改造：强制预处理压缩
    /// 对所有图片执行压缩（使用 `low` 质量），存储结果供发送时使用。
    /// 发送时不再进行实时压缩，完全依赖预处理结果。
    ///
    /// ## 返回
    /// - `Ok(true)`: 压缩完成
    /// - `Ok(false)`: 压缩跳过（图片已经很小或压缩效果不明显）
    async fn stage_image_compression(
        &self,
        file_id: &str,
        blob_hash: &str,
        _file_size: Option<i64>,
        _config: &ImageCompressionConfig,
    ) -> VfsResult<bool> {
        // ★ P0 改造：移除大小阈值检查，对所有图片都进行压缩
        // 原因：发送时不再压缩，必须在预处理阶段完成

        // 获取原始图片数据
        let conn = self.db.get_conn_safe()?;
        let blobs_dir = self.db.blobs_dir();
        let has_text: bool = conn
            .query_row(
                "SELECT extracted_text IS NOT NULL FROM files WHERE id = ?1",
                params![file_id],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            != 0;
        let mut ready_modes = Vec::new();
        if has_text {
            ready_modes.push("text".to_string());
        }
        let blob_path = VfsBlobRepo::get_blob_path_with_conn(&conn, blobs_dir, blob_hash)?
            .ok_or_else(|| VfsError::NotFound {
                resource_type: "Blob".to_string(),
                id: blob_hash.to_string(),
            })?;

        // 读取原始图片
        let image_data = tokio::fs::read(&blob_path).await?;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&image_data);

        // ★ P0 改造：强制使用 `low` 质量进行压缩
        // 与发送时的默认策略保持一致（多图/PDF 场景）
        let compressed_base64 = self
            .file_manager
            .adjust_image_quality_base64(&base64_data, "low");

        let original_size = base64_data.len();
        let compressed_size = compressed_base64.len();

        // 如果压缩后没有显著减少（<10%），使用原始图片但标记为"已压缩"
        // 这样发送时就知道不需要再压缩
        let (final_data, final_hash) = if compressed_size >= original_size * 9 / 10 {
            info!(
                "[MediaProcessingService] Compression not effective for file {}: {} -> {} bytes, using original",
                file_id, original_size, compressed_size
            );
            // 使用原始数据，但仍然标记 compressed_blob_hash 为原始 hash
            // 这样 VFS 解析时知道已经处理过了
            (image_data.clone(), blob_hash.to_string())
        } else {
            // 解码压缩后的数据
            let compressed_data = base64::engine::general_purpose::STANDARD
                .decode(&compressed_base64)
                .map_err(|e| {
                    VfsError::Other(format!("Failed to decode compressed image: {}", e))
                })?;

            // 计算压缩后的哈希
            let mut hasher = Sha256::new();
            hasher.update(&compressed_data);
            let compressed_hash = format!("{:x}", hasher.finalize());

            // 存储压缩后的 blob（如果还不存在）
            if VfsBlobRepo::get_blob_path_with_conn(&conn, blobs_dir, &compressed_hash)?.is_none() {
                VfsBlobRepo::store_blob_with_conn(
                    &conn,
                    blobs_dir,
                    &compressed_data,
                    Some("image/jpeg"),
                    Some("jpg"),
                )?;
            }

            info!(
                "[MediaProcessingService] Image compressed for file {}: {} -> {} bytes ({:.1}% reduction, hash: {})",
                file_id, original_size, compressed_size,
                (1.0 - compressed_size as f64 / original_size as f64) * 100.0,
                compressed_hash
            );

            (compressed_data, compressed_hash)
        };

        // 更新文件记录，标记压缩已完成
        conn.execute(
            "UPDATE files SET compressed_blob_hash = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![final_hash, file_id],
        )?;

        // 返回 true 表示压缩阶段已完成（无论是否真正压缩）
        Ok(true)
    }

    // ========================================================================
    // ★ P0 架构改造：PDF 页面压缩
    // ========================================================================

    /// 检查 PDF 页面是否需要压缩
    ///
    /// 通过检查 preview_json 中是否已存在 compressed_blob_hash 字段来判断
    fn check_pdf_pages_need_compression(&self, preview_json: &str) -> VfsResult<bool> {
        let preview: PdfPreviewJson = serde_json::from_str(preview_json)
            .map_err(|e| VfsError::Serialization(format!("Failed to parse preview_json: {}", e)))?;

        if preview.pages.is_empty() {
            return Ok(false);
        }

        let conn = self.db.get_conn_safe()?;
        let blobs_dir = self.db.blobs_dir();

        // 只要有任意页面缺少压缩版本或压缩 blob 不存在，就需要压缩
        for page in preview.pages.iter() {
            let Some(ref ch) = page.compressed_blob_hash else {
                return Ok(true);
            };
            if ch.trim().is_empty() {
                return Ok(true);
            }
            if VfsBlobRepo::get_blob_path_with_conn(&conn, &blobs_dir, ch)?.is_none() {
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Stage 2.5: PDF 页面压缩
    ///
    /// 为每个 PDF 页面生成压缩版本，更新 preview_json 中的 compressed_blob_hash 字段。
    /// 发送时直接使用压缩版本，不再实时压缩。
    async fn stage_pdf_page_compression(
        &self,
        file_id: &str,
        preview_json: &str,
        total_pages: usize,
        cancel_token: &CancellationToken,
    ) -> VfsResult<()> {
        use base64::Engine;
        use sha2::{Digest, Sha256};

        let mut preview: PdfPreviewJson = serde_json::from_str(preview_json)
            .map_err(|e| VfsError::Serialization(format!("Failed to parse preview_json: {}", e)))?;

        let conn = self.db.get_conn_safe()?;
        let blobs_dir = self.db.blobs_dir();
        let app_handle = self.get_app_handle().await;
        let has_text: bool = conn
            .query_row(
                "SELECT extracted_text IS NOT NULL FROM files WHERE id = ?1",
                params![file_id],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            != 0;
        let mut ready_modes = Vec::new();
        if has_text {
            ready_modes.push("text".to_string());
        }

        let mut compressed_count = 0usize;
        let mut skipped_count = 0usize;

        for (index, page) in preview.pages.iter_mut().enumerate() {
            if cancel_token.is_cancelled() {
                info!(
                    "[PdfProcessingService] Page compression cancelled at page {}/{}",
                    index, total_pages
                );
                break;
            }

            // 跳过已经有压缩版本的页面
            if page.compressed_blob_hash.is_some() {
                skipped_count += 1;
                continue;
            }

            // 获取原始页面图片
            let blob_path =
                match VfsBlobRepo::get_blob_path_with_conn(&conn, blobs_dir, &page.blob_hash)? {
                    Some(path) => path,
                    None => {
                        warn!(
                            "[PdfProcessingService] Blob not found for page {}: {}",
                            index, page.blob_hash
                        );
                        continue;
                    }
                };

            // 读取原始图片
            let image_data = match tokio::fs::read(&blob_path).await {
                Ok(data) => data,
                Err(e) => {
                    warn!(
                        "[PdfProcessingService] Failed to read page {} blob: {}",
                        index, e
                    );
                    continue;
                }
            };

            let base64_data = base64::engine::general_purpose::STANDARD.encode(&image_data);
            let original_size = base64_data.len();

            // 使用 low 质量进行压缩
            let compressed_base64 = self
                .file_manager
                .adjust_image_quality_base64(&base64_data, "low");

            let compressed_size = compressed_base64.len();

            // 检查压缩效果
            if compressed_size >= original_size * 9 / 10 {
                // 压缩效果不明显，使用原始 hash
                page.compressed_blob_hash = Some(page.blob_hash.clone());
                skipped_count += 1;
                debug!(
                    "[PdfProcessingService] Page {} compression not effective, using original",
                    index
                );
            } else {
                // 解码并存储压缩后的图片
                let compressed_data = base64::engine::general_purpose::STANDARD
                    .decode(&compressed_base64)
                    .map_err(|e| {
                        VfsError::Other(format!(
                            "Failed to decode compressed page {}: {}",
                            index, e
                        ))
                    })?;

                // 计算压缩后的哈希
                let mut hasher = Sha256::new();
                hasher.update(&compressed_data);
                let compressed_hash = format!("{:x}", hasher.finalize());

                // 存储压缩后的 blob（如果不存在）
                if VfsBlobRepo::get_blob_path_with_conn(&conn, blobs_dir, &compressed_hash)?
                    .is_none()
                {
                    VfsBlobRepo::store_blob_with_conn(
                        &conn,
                        blobs_dir,
                        &compressed_data,
                        Some("image/jpeg"),
                        Some("jpg"),
                    )?;
                }

                page.compressed_blob_hash = Some(compressed_hash.clone());
                compressed_count += 1;

                debug!(
                    "[PdfProcessingService] Page {} compressed: {} -> {} bytes ({:.1}% reduction)",
                    index,
                    original_size,
                    compressed_size,
                    (1.0 - compressed_size as f64 / original_size as f64) * 100.0
                );
            }

            // 发送进度事件（统一事件）
            // ★ P1-1 修复：压缩范围 5%-20%
            if app_handle.is_some() {
                let progress_percent = if total_pages == 0 {
                    5.0
                } else {
                    5.0 + (index as f32 / total_pages as f32) * 15.0
                };
                let progress = ProcessingProgress {
                    stage: "page_compression".to_string(),
                    current_page: Some(index + 1),
                    total_pages: Some(total_pages),
                    percent: progress_percent, // 5% - 20%
                    ready_modes: ready_modes.clone(),
                    media_type: Some("pdf".to_string()),
                };
                self.emit_progress(file_id, progress, MediaType::Pdf).await;
            }
        }

        // 更新 preview_json
        let updated_preview_json = serde_json::to_string(&preview)
            .map_err(|e| VfsError::Other(format!("Failed to serialize preview_json: {}", e)))?;

        conn.execute(
            "UPDATE files SET preview_json = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![updated_preview_json, file_id],
        )?;

        info!(
            "[PdfProcessingService] Page compression completed for file {}: {} compressed, {} skipped",
            file_id, compressed_count, skipped_count
        );

        Ok(())
    }

    /// Stage 2: 图片 OCR
    ///
    /// 对单张图片进行 OCR 识别。
    async fn stage_image_ocr(
        &self,
        file_id: &str,
        blob_hash: &str,
        mime_type: &str,
    ) -> VfsResult<String> {
        // 获取图片数据
        let conn = self.db.get_conn_safe()?;
        let blobs_dir = self.db.blobs_dir();
        let blob_path = VfsBlobRepo::get_blob_path_with_conn(&conn, blobs_dir, blob_hash)?
            .ok_or_else(|| VfsError::NotFound {
                resource_type: "Blob".to_string(),
                id: blob_hash.to_string(),
            })?;

        // 读取图片并转为 base64
        let image_data = tokio::fs::read(&blob_path).await?;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&image_data);
        self.stage_image_ocr_with_base64(file_id, base64_data, mime_type)
            .await
    }

    /// 使用 base64 直接执行图片 OCR（支持 inline 图片）
    async fn stage_image_ocr_with_base64(
        &self,
        file_id: &str,
        base64_data: String,
        mime_type: &str,
    ) -> VfsResult<String> {
        info!(
            "[OCR_DIAG] stage_image_ocr_with_base64 START: file_id={}, mime_type={}, base64_len={}",
            file_id, mime_type, base64_data.len()
        );

        let conn = self.db.get_conn_safe()?;

        // ★ 诊断：检查 file_id 关联的 resource_id
        let resource_id_check: Option<String> = conn
            .query_row(
                "SELECT resource_id FROM files WHERE id = ?1",
                params![file_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        info!(
            "[OCR_DIAG] file->resource mapping: file_id={} -> resource_id={:?}",
            file_id, resource_id_check
        );

        // 调用 OCR API
        use crate::llm_manager::ImagePayload;
        let adapter = self.llm_manager.get_ocr_adapter().await;
        info!(
            "[OCR_DIAG] OCR adapter obtained, calling OCR model for file_id={}",
            file_id
        );
        // M11 fix: 使用 build_custom_prompt 确保自定义内容与适配器兼容
        let custom_instruction = "请仔细识别这张图片中的所有文字内容，包括印刷文字和手写文字。输出识别结果，保持原有的格式和结构。如果图片中没有文字，请输出'无文字内容'。";
        let prompt =
            adapter.build_custom_prompt(custom_instruction, crate::ocr_adapters::OcrMode::FreeOcr);
        let image_payload = ImagePayload {
            mime: mime_type.to_string(),
            base64: base64_data,
        };

        let result = self
            .llm_manager
            .call_ocr_model_raw_prompt(&prompt, Some(vec![image_payload]))
            .await
            .map_err(|e| {
                warn!(
                    "[OCR_DIAG] OCR API call FAILED for file_id={}: {}",
                    file_id, e
                );
                VfsError::Other(format!("OCR API call failed: {}", e))
            })?;

        let ocr_text = result.assistant_message;
        info!(
            "[OCR_DIAG] OCR API returned for file_id={}: text_len={}, preview=\"{}\"",
            file_id,
            ocr_text.len(),
            ocr_text.chars().take(100).collect::<String>()
        );

        // ★ 2026-02 修复：OCR 返回空文本时不写入数据库
        // 空字符串会导致 has_ocr_text=true 但 ocr_text_len=0，
        // 后续 get_image_ocr_text 读取时会判定为 EMPTY 并返回 None，
        // 最终导致用户选择 OCR 模式但拿不到任何内容。
        // 不写入空值，让 ocr_text 保持 NULL，后续重试时可以重新触发 OCR。
        if ocr_text.trim().is_empty() {
            warn!(
                "[OCR_DIAG] OCR API returned EMPTY text for file_id={}, NOT writing to DB (keeping ocr_text as NULL so retry is possible). \
                 Possible causes: (1) OCR model does not support vision, (2) API returned empty response, (3) image has no recognizable text",
                file_id
            );
            return Ok(ocr_text);
        }

        // 存储 OCR 结果到关联的 resource.ocr_text
        let rows_affected = conn.execute(
            r#"
            UPDATE resources SET ocr_text = ?1, updated_at = datetime('now')
            WHERE id = (SELECT resource_id FROM files WHERE id = ?2)
            "#,
            params![ocr_text, file_id],
        )?;
        info!(
            "[OCR_DIAG] OCR text saved to resources table: file_id={}, rows_affected={}{}",
            file_id,
            rows_affected,
            if rows_affected == 0 { " ⚠️ NO ROWS UPDATED - resource_id lookup may have failed!" } else { "" }
        );

        // 更新 processing_progress 中的 ready_modes
        let progress_json: Option<String> = conn
            .query_row(
                "SELECT processing_progress FROM files WHERE id = ?1",
                params![file_id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(ref pj) = progress_json {
            if let Ok(mut progress) = serde_json::from_str::<ProcessingProgress>(pj) {
                if !progress.ready_modes.contains(&"ocr".to_string()) {
                    progress.ready_modes.push("ocr".to_string());
                    if let Ok(new_json) = serde_json::to_string(&progress) {
                        conn.execute(
                            "UPDATE files SET processing_progress = ?1, updated_at = datetime('now') WHERE id = ?2",
                            params![new_json, file_id],
                        )?;
                    }
                }
            }
        }

        Ok(ocr_text)
    }

    /// 更新数据库中的处理状态（支持媒体类型）
    async fn update_processing_status(
        &self,
        file_id: &str,
        stage: ProcessingStage,
        progress: Option<&ProcessingProgress>,
        completed_at: Option<i64>,
    ) -> VfsResult<()> {
        let conn = self.db.get_conn_safe()?;

        // ★ P1-4 修复：带 busy-retry 的事务开始
        // 并发处理多文件时 BEGIN IMMEDIATE 可能因 SQLITE_BUSY 失败
        {
            let max_retries = 3u32;
            let mut attempt = 0u32;
            loop {
                match conn.execute("BEGIN IMMEDIATE", []) {
                    Ok(_) => break,
                    Err(e) if attempt < max_retries => {
                        let msg = e.to_string();
                        if msg.contains("database is locked") || msg.contains("SQLITE_BUSY") {
                            attempt += 1;
                            let backoff_ms = 50 * (1u64 << attempt); // 100ms, 200ms, 400ms
                            warn!(
                                "[PdfProcessingService] BEGIN IMMEDIATE busy for file {}, retry {}/{} in {}ms",
                                file_id, attempt, max_retries, backoff_ms
                            );
                            sleep(std::time::Duration::from_millis(backoff_ms)).await;
                            continue;
                        }
                        return Err(VfsError::Database(format!("BEGIN IMMEDIATE failed: {}", e)));
                    }
                    Err(e) => {
                        return Err(VfsError::Database(format!(
                            "BEGIN IMMEDIATE failed after {} retries: {}",
                            max_retries, e
                        )));
                    }
                }
            }
        }

        let result = (|| -> VfsResult<()> {
            let progress_json = progress.map(|p| serde_json::to_string(p).unwrap_or_default());
            let now_ms = chrono::Utc::now().timestamp_millis();

            if stage == ProcessingStage::Completed {
                // 完成
                conn.execute(
                    r#"
                    UPDATE files
                    SET processing_status = ?1,
                        processing_progress = ?2,
                        processing_completed_at = ?3,
                        processing_error = NULL,
                        updated_at = datetime('now')
                    WHERE id = ?4
                    "#,
                    params![
                        stage.as_str(),
                        progress_json,
                        completed_at.unwrap_or(now_ms),
                        file_id
                    ],
                )?;
            } else if stage == ProcessingStage::Error {
                // 错误 - 不设置 completed_at
                conn.execute(
                    r#"
                    UPDATE files
                    SET processing_status = ?1,
                        processing_progress = ?2,
                        updated_at = datetime('now')
                    WHERE id = ?3
                    "#,
                    params![stage.as_str(), progress_json, file_id],
                )?;
            } else {
                // 处理中
                conn.execute(
                    r#"
                    UPDATE files
                    SET processing_status = ?1,
                        processing_progress = ?2,
                        processing_started_at = COALESCE(processing_started_at, ?3),
                        updated_at = datetime('now')
                    WHERE id = ?4
                    "#,
                    params![stage.as_str(), progress_json, now_ms, file_id],
                )?;
            }

            Ok(())
        })();

        // 提交或回滚
        match result {
            Ok(()) => {
                conn.execute("COMMIT", [])?;
                debug!(
                    "[PdfProcessingService] Updated status for file {}: {:?}",
                    file_id, stage
                );
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 设置处理错误
    pub fn set_error(&self, file_id: &str, error: &str, stage: ProcessingStage) -> VfsResult<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        conn.execute(
            r#"
            UPDATE files
            SET processing_status = 'error',
                processing_error = ?1,
                processing_completed_at = ?2,
                updated_at = datetime('now')
            WHERE id = ?3
            "#,
            params![error, now_ms, file_id],
        )?;

        error!(
            "[PdfProcessingService] Set error for file {}: {} (stage: {:?})",
            file_id, error, stage
        );

        Ok(())
    }

    /// 获取处理状态
    pub fn get_status(&self, file_id: &str) -> VfsResult<Option<ProcessingStatus>> {
        let conn = self.db.get_conn_safe()?;

        let result: Option<(
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
        )> = conn
            .query_row(
                r#"
                SELECT processing_status, processing_progress, processing_error,
                       processing_started_at, processing_completed_at
                FROM files WHERE id = ?1
                "#,
                params![file_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;

        match result {
            Some((status, progress_json, error, started_at, completed_at)) => {
                let stage = status.as_deref().unwrap_or("pending");
                let progress: ProcessingProgress = progress_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();

                Ok(Some(ProcessingStatus {
                    file_id: file_id.to_string(),
                    stage: stage.to_string(),
                    progress,
                    error,
                    started_at,
                    completed_at,
                }))
            }
            None => Ok(None),
        }
    }

    /// 取消处理
    pub fn cancel(&self, file_id: &str) -> VfsResult<bool> {
        if let Some((_, (token, gen))) = self.running_tasks.remove(file_id) {
            token.cancel();
            info!(
                "[PdfProcessingService] Cancelled pipeline for file: {} (gen={})",
                file_id, gen
            );
            Ok(true)
        } else {
            debug!(
                "[PdfProcessingService] No running pipeline to cancel for file: {}",
                file_id
            );
            Ok(false)
        }
    }

    /// 重试失败的处理
    ///
    /// ## P1 修复：根据媒体类型选择正确的重试起始阶段
    /// - PDF：从 OcrProcessing 开始（文本提取和页面渲染在上传时已完成）
    /// - 图片：从 ImageCompression 开始（完整重新处理）
    pub async fn retry(self: &Arc<Self>, file_id: &str) -> VfsResult<()> {
        // 获取当前状态
        let status = self.get_status(file_id)?;

        match status {
            Some(s) if s.stage == "error" => {
                // 检测媒体类型，选择正确的重试起始阶段
                let media_type = self.detect_media_type(file_id)?;
                let start_stage = match media_type {
                    MediaType::Pdf => ProcessingStage::OcrProcessing,
                    MediaType::Image => ProcessingStage::ImageCompression,
                };

                info!(
                    "[MediaProcessingService] Retrying file {} from stage {:?} (media_type={:?})",
                    file_id, start_stage, media_type
                );

                // 重置状态并重新开始
                self.update_processing_status(file_id, ProcessingStage::Pending, None, None)
                    .await?;
                self.start_pipeline(file_id, Some(start_stage)).await
            }
            Some(s) => {
                warn!(
                    "[PdfProcessingService] Cannot retry file {} in stage: {}",
                    file_id, s.stage
                );
                Ok(())
            }
            None => Err(VfsError::NotFound {
                resource_type: "File".to_string(),
                id: file_id.to_string(),
            }),
        }
    }

    /// 检查是否有运行中的任务
    pub fn is_running(&self, file_id: &str) -> bool {
        self.running_tasks.contains_key(file_id)
    }

    /// 获取所有运行中的任务数量
    pub fn running_count(&self) -> usize {
        self.running_tasks.len()
    }

    /// ★ P0-1 修复：启动时恢复 stuck 任务
    ///
    /// 应用重启后，running_tasks 内存映射为空，但数据库中可能存在
    /// 处于中间状态（ocr_processing / vector_indexing / page_compression 等）的文件。
    /// 这些文件不会自动恢复，用户也无法通过 retry 修复（retry 仅处理 error 状态）。
    ///
    /// 此方法将所有 stuck 文件重置为 pending 状态，允许后续重新处理。
    pub fn recover_stuck_tasks(&self) -> VfsResult<usize> {
        let conn = self.db.get_conn_safe()?;

        // 查找所有处于中间处理状态的文件
        // 排除 pending/completed/error —— 这些是稳定终态
        let stuck_ids: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    r#"SELECT id FROM files
                   WHERE processing_status IN (
                       'text_extraction', 'page_rendering', 'page_compression',
                       'image_compression', 'ocr_processing', 'vector_indexing'
                   )"#,
                )
                .map_err(|e| VfsError::Database(format!("Failed to prepare stuck query: {}", e)))?;

            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| VfsError::Database(format!("Failed to query stuck tasks: {}", e)))?;

            rows.filter_map(log_and_skip_err).collect()
        };

        if stuck_ids.is_empty() {
            debug!("[MediaProcessingService] No stuck tasks found at startup");
            return Ok(0);
        }

        let count = stuck_ids.len();
        info!(
            "[MediaProcessingService] Found {} stuck tasks at startup, resetting to pending",
            count
        );

        for file_id in &stuck_ids {
            let affected = conn
                .execute(
                    r#"UPDATE files
                   SET processing_status = 'pending',
                       processing_error = 'recovered: interrupted by app restart',
                       updated_at = datetime('now')
                   WHERE id = ?1"#,
                    params![file_id],
                )
                .unwrap_or(0);

            if affected > 0 {
                info!(
                    "[MediaProcessingService] Reset stuck file {} to pending",
                    file_id
                );
            }
        }

        Ok(count)
    }

    // ========================================================================
    // 事件发送
    // ========================================================================

    /// 发送进度事件（支持媒体类型）
    async fn emit_progress(
        &self,
        file_id: &str,
        progress: ProcessingProgress,
        media_type: MediaType,
    ) {
        // 兼容轮询链路：将最新进度持久化到 DB，避免前端只能在 completed 才看到 ready_modes 变化。
        if let Ok(conn) = self.db.get_conn_safe() {
            let progress_json = serde_json::to_string(&progress).unwrap_or_default();
            if let Err(e) = conn.execute(
                r#"
                UPDATE files
                SET processing_status = ?1,
                    processing_progress = ?2,
                    updated_at = datetime('now')
                WHERE id = ?3
                "#,
                params![progress.stage.clone(), progress_json, file_id],
            ) {
                warn!(
                    "[MediaProcessingService] Failed to persist progress for {}: {}",
                    file_id, e
                );
            }
        }

        if let Some(app_handle) = self.get_app_handle().await {
            let mut prog = progress.clone();
            prog.media_type = Some(media_type.as_str().to_string());

            let event = MediaProcessingProgressEvent {
                file_id: file_id.to_string(),
                status: prog.clone(),
                media_type: media_type.as_str().to_string(),
            };

            // 发送新统一事件
            if let Err(e) = app_handle.emit("media-processing-progress", &event) {
                warn!(
                    "[MediaProcessingService] Failed to emit media-processing-progress event: {}",
                    e
                );
            }

            // 发送旧 PDF 兼容事件（仅 PDF）
            if media_type == MediaType::Pdf {
                if let Err(e) = app_handle.emit("pdf-processing-progress", &event) {
                    warn!(
                        "[MediaProcessingService] Failed to emit pdf-processing-progress event: {}",
                        e
                    );
                }
            }
        }
    }

    /// 发送完成事件（支持媒体类型）
    async fn emit_completed(&self, file_id: &str, ready_modes: Vec<String>, media_type: MediaType) {
        if let Some(app_handle) = self.get_app_handle().await {
            let event = MediaProcessingCompletedEvent {
                file_id: file_id.to_string(),
                ready_modes: ready_modes.clone(),
                media_type: media_type.as_str().to_string(),
            };

            // 发送新统一事件
            if let Err(e) = app_handle.emit("media-processing-completed", &event) {
                warn!(
                    "[MediaProcessingService] Failed to emit media-processing-completed event: {}",
                    e
                );
            }

            // 发送旧 PDF 兼容事件（仅 PDF）
            if media_type == MediaType::Pdf {
                if let Err(e) = app_handle.emit("pdf-processing-completed", &event) {
                    warn!(
                        "[MediaProcessingService] Failed to emit pdf-processing-completed event: {}",
                        e
                    );
                }
            }
        }
    }

    /// 发送错误事件（支持媒体类型）
    pub async fn emit_error(&self, file_id: &str, error: &str, stage: &str, media_type: MediaType) {
        if let Some(app_handle) = self.get_app_handle().await {
            let event = MediaProcessingErrorEvent {
                file_id: file_id.to_string(),
                error: error.to_string(),
                stage: stage.to_string(),
                media_type: media_type.as_str().to_string(),
            };

            // 发送新统一事件
            if let Err(e) = app_handle.emit("media-processing-error", &event) {
                warn!(
                    "[MediaProcessingService] Failed to emit media-processing-error event: {}",
                    e
                );
            }

            // 发送旧 PDF 兼容事件（仅 PDF）
            if media_type == MediaType::Pdf {
                if let Err(e) = app_handle.emit("pdf-processing-error", &event) {
                    warn!(
                        "[MediaProcessingService] Failed to emit pdf-processing-error event: {}",
                        e
                    );
                }
            }
        }
    }

    // ========================================================================
    // Stage 4: 向量索引
    // ========================================================================

    /// 执行向量索引阶段（PDF 和图片共用）
    ///
    /// 在 OCR 完成后自动触发向量索引，使文件内容可被 RAG 检索。
    ///
    /// ## 流程
    /// 1. 获取文件信息
    /// 2. 同步资源到 vfs_index_units 表
    /// 3. 调用 VfsFullIndexingService 生成嵌入并存储
    ///
    /// ## 参数
    /// - `file_id`: 文件 ID
    /// - `ready_modes`: 当前已就绪的模式
    /// - `media_type`: 媒体类型
    ///
    /// ## 错误处理
    /// 索引失败不影响文件的可用性，错误会被记录但不会中断流水线
    async fn stage_vector_indexing(
        &self,
        file_id: &str,
        ready_modes: &mut Vec<String>,
        media_type: MediaType,
    ) -> VfsResult<()> {
        info!(
            "[PdfProcessingService] Starting vector indexing for file: {}",
            file_id
        );

        // ★ 2026-02 修复：重复索引防护 - 检查是否已在索引中
        {
            use crate::vfs::repos::index_unit_repo::{self, IndexState};
            let conn = self.db.get_conn_safe()?;

            // 先获取文件的 resource_id
            let resource_id: Option<String> = conn
                .query_row(
                    "SELECT resource_id FROM files WHERE id = ?1",
                    params![file_id],
                    |row| row.get(0),
                )
                .optional()?;

            if let Some(ref res_id) = resource_id {
                let existing_units = index_unit_repo::get_by_resource(&conn, res_id)?;

                // 检查是否有任何 unit 正在索引中
                let any_indexing = existing_units.iter().any(|u| {
                    u.text_state == IndexState::Indexing || u.mm_state == IndexState::Indexing
                });

                if any_indexing {
                    warn!(
                        "[PdfProcessingService] Resource {} is already being indexed, skipping",
                        file_id
                    );
                    return Ok(());
                }
            }
        }

        // 1. 获取 AppHandle 以访问 Tauri State
        let app_handle = self
            .get_app_handle()
            .await
            .ok_or_else(|| VfsError::InvalidOperation {
                operation: "vector_indexing".to_string(),
                reason: "AppHandle not set, cannot perform vector indexing".to_string(),
            })?;

        // 2. 获取 LLMManager
        let llm_manager: Arc<LLMManager> = app_handle
            .try_state::<Arc<LLMManager>>()
            .ok_or_else(|| VfsError::InvalidOperation {
                operation: "vector_indexing".to_string(),
                reason: "LLMManager not found in Tauri state".to_string(),
            })?
            .inner()
            .clone();

        // 3. 获取文件信息
        let file = VfsFileRepo::get_file(&self.db, file_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "File".to_string(),
            id: file_id.to_string(),
        })?;

        // 4. 检查是否有 resource_id（文件必须有关联的资源才能索引）
        let resource_id = file
            .resource_id
            .as_ref()
            .ok_or_else(|| VfsError::InvalidOperation {
                operation: "vector_indexing".to_string(),
                reason: format!("File {} has no associated resource", file_id),
            })?;

        // 5. 发送进度事件：开始向量索引
        // ★ P1-1 修复：向量索引范围 75%-95%，与 OCR 结束的 75% 衔接
        self.emit_progress(
            file_id,
            ProcessingProgress {
                stage: "vector_indexing".to_string(),
                current_page: None,
                total_pages: file.page_count.map(|p| p as usize),
                percent: 75.0,
                ready_modes: ready_modes.clone(),
                media_type: Some(media_type.as_str().to_string()),
            },
            media_type,
        )
        .await;

        // 6. 同步 Units（确保 vfs_index_units 表有最新数据）
        let index_service = VfsIndexService::new(self.db.clone());

        // 根据文件类型判断 resource_type
        let is_pdf = file.file_name.to_lowercase().ends_with(".pdf")
            || file
                .mime_type
                .as_ref()
                .map(|m| m.contains("pdf"))
                .unwrap_or(false);
        let resource_type = if is_pdf {
            "textbook".to_string() // PDF 使用 textbook 以支持多页处理
        } else {
            "file".to_string()
        };

        // ★ P1-2 修复：从数据库读取 ocr_text 用于 Unit 元数据补全
        // 图片 OCR 文本存储在 resources.ocr_text（由 stage_image_ocr 写入），
        // 传入 UnitBuildInput 使 FileBuilder 能正确设置 unit.text_content
        let ocr_text_for_unit: Option<String> = {
            let conn = self.db.get_conn_safe()?;
            conn.query_row(
                r#"
                SELECT r.ocr_text
                FROM files f
                LEFT JOIN resources r ON r.id = f.resource_id
                WHERE f.id = ?1
                "#,
                params![file_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap_or(None)
            .filter(|t| !t.trim().is_empty())
        };

        let unit_input = UnitBuildInput {
            resource_id: resource_id.clone(),
            resource_type,
            data: None,
            ocr_text: ocr_text_for_unit,
            ocr_pages_json: file.ocr_pages_json.clone(),
            blob_hash: file.blob_hash.clone(),
            page_count: file.page_count,
            extracted_text: file.extracted_text.clone(),
            preview_json: file.preview_json.clone(),
        };

        match index_service.sync_resource_units(unit_input) {
            Ok(units) => {
                info!(
                    "[PdfProcessingService] Synced {} units for file {}",
                    units.len(),
                    file_id
                );
            }
            Err(e) => {
                warn!(
                    "[PdfProcessingService] Failed to sync units for file {}: {}",
                    file_id, e
                );
                // 继续处理，不中断流水线
            }
        }

        // 7. 发送进度事件：同步完成，开始嵌入生成
        self.emit_progress(
            file_id,
            ProcessingProgress {
                stage: "vector_indexing".to_string(),
                current_page: None,
                total_pages: file.page_count.map(|p| p as usize),
                percent: 85.0,
                ready_modes: ready_modes.clone(),
                media_type: Some(media_type.as_str().to_string()),
            },
            media_type,
        )
        .await;

        // 8. 创建 LanceStore 和 FullIndexingService
        let lance_store = match VfsLanceStore::new(self.db.clone()) {
            Ok(store) => Arc::new(store),
            Err(e) => {
                warn!(
                    "[PdfProcessingService] Failed to create LanceStore for file {}: {}",
                    file_id, e
                );
                // LanceStore 创建失败，跳过向量索引但不中断流水线
                return Ok(());
            }
        };

        let full_indexing_service = match VfsFullIndexingService::new(
            self.db.clone(),
            llm_manager,
            lance_store,
        ) {
            Ok(service) => service,
            Err(e) => {
                warn!(
                    "[PdfProcessingService] Failed to create VfsFullIndexingService for file {}: {}",
                    file_id, e
                );
                return Ok(());
            }
        };

        // 9. 执行索引
        match full_indexing_service
            .index_resource(resource_id, None, None)
            .await
        {
            Ok((chunk_count, _dim)) => {
                info!(
                    "[PdfProcessingService] Vector indexing completed for file {}: {} chunks indexed",
                    file_id, chunk_count
                );

                // 添加 indexed 到就绪模式
                if !ready_modes.contains(&"indexed".to_string()) {
                    ready_modes.push("indexed".to_string());
                }
            }
            Err(e) => {
                warn!(
                    "[PdfProcessingService] Vector indexing failed for file {}: {}",
                    file_id, e
                );
                // 索引失败不中断流水线，文件仍可使用
            }
        }

        // 10. 发送进度事件：索引完成
        self.emit_progress(
            file_id,
            ProcessingProgress {
                stage: "vector_indexing".to_string(),
                current_page: None,
                total_pages: file.page_count.map(|p| p as usize),
                percent: 95.0,
                ready_modes: ready_modes.clone(),
                media_type: Some(media_type.as_str().to_string()),
            },
            media_type,
        )
        .await;

        Ok(())
    }

    // ========================================================================
    // Stage 3: OCR 处理（复用预渲染图片）
    // ========================================================================

    /// 执行 Stage 3: OCR 处理
    ///
    /// ## 核心逻辑
    /// 1. 解析 preview_json 获取每页的 blob_hash
    /// 2. 从 VFS Blob 存储获取预渲染图片路径（复用 Stage 2 渲染结果）
    /// 3. 并发调用 OCR API（最多 4 并发）
    /// 4. 将 OCR 结果存入 ocr_pages_json 字段
    ///
    /// ## 图片复用
    /// Stage 2 已将 PDF 页面渲染为 PNG 图片存储在 vfs_blobs 中。
    /// Stage 3 直接复用这些图片，无需重新渲染。
    /// - 预渲染图片格式：PNG
    /// - 预渲染图片 DPI：150
    /// - 存储位置：`vfs_blobs/{hash[0:2]}/{hash}.png`
    async fn stage_ocr_processing(
        &self,
        file_id: &str,
        preview_json: &str,
        ready_modes: &mut Vec<String>,
        cancel_token: &CancellationToken,
    ) -> VfsResult<String> {
        info!(
            "[PdfProcessingService] Starting OCR processing for file: {}",
            file_id
        );

        // 1. 解析 preview_json 获取所有页面的 blob_hash
        let preview: PdfPreviewJson = serde_json::from_str(preview_json).map_err(|e| {
            error!("[PdfProcessingService] Failed to parse preview_json: {}", e);
            VfsError::Serialization(format!("Failed to parse preview_json: {}", e))
        })?;

        let total_pages = preview.pages.len();
        if total_pages == 0 {
            warn!(
                "[PdfProcessingService] No pages in preview_json for file: {}",
                file_id
            );
            return Ok("{}".to_string());
        }

        // 2. 获取 blob 目录
        let blobs_dir = self.db.blobs_dir().to_path_buf();

        // 3. 获取 OCR 模型配置
        let config = Arc::new(
            self.llm_manager
                .get_pdf_ocr_model_config()
                .await
                .map_err(|e| {
                    error!(
                        "[PdfProcessingService] Failed to get OCR model config: {}",
                        e
                    );
                    VfsError::Other(format!("Failed to get OCR model config: {}", e))
                })?,
        );

        info!(
            "[PdfProcessingService] Using OCR model: {} for {} pages",
            config.model, total_pages
        );

        // 4. 并发处理 OCR
        let completed_counter = Arc::new(AtomicUsize::new(0));
        let failed_pages = Arc::new(Mutex::new(Vec::<(usize, String)>::new()));
        let all_results = Arc::new(Mutex::new(Vec::<OcrPageResult>::new()));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_OCR_CONCURRENCY));

        // 发送初始进度
        // ★ P1-1 修复：OCR 范围 20%-75%
        self.emit_progress(
            file_id,
            ProcessingProgress {
                stage: "ocr_processing".to_string(),
                current_page: Some(0),
                total_pages: Some(total_pages),
                percent: 20.0,
                ready_modes: ready_modes.clone(),
                media_type: Some("pdf".to_string()),
            },
            MediaType::Pdf,
        )
        .await;

        // 5. 使用 futures::stream 并发处理每一页
        let db = self.db.clone();
        let llm_manager = self.llm_manager.clone();
        let file_id_owned = file_id.to_string();
        let ready_modes_clone = ready_modes.clone();
        let app_handle_for_progress = self.get_app_handle().await;

        let tasks: Vec<_> = preview
            .pages
            .iter()
            .enumerate()
            .map(|(_, page)| {
                let page_index = page.page_index;
                let blob_hash = page.blob_hash.clone();
                let blobs_dir = blobs_dir.clone();
                let config = config.clone();
                let llm_manager = llm_manager.clone();
                let semaphore = semaphore.clone();
                let completed_counter = completed_counter.clone();
                let failed_pages = failed_pages.clone();
                let all_results = all_results.clone();
                let cancel_token = cancel_token.clone();
                let file_id = file_id_owned.clone();
                let db = db.clone();
                let ready_modes_for_task = ready_modes_clone.clone();
                let app_handle_clone = app_handle_for_progress.clone();

                async move {
                    // ★ P0 修复：正确处理信号量获取错误，避免 panic
                    let _permit = match semaphore.acquire().await {
                        Ok(permit) => permit,
                        Err(e) => {
                            error!("[PdfProcessingService] Failed to acquire semaphore: {}", e);
                            failed_pages.lock().await.push((page_index, format!("Semaphore error: {}", e)));
                            return;
                        }
                    };

                    // 检查取消
                    if cancel_token.is_cancelled() {
                        return;
                    }

                    // 获取 blob 文件路径
                    let conn = match db.get_conn_safe() {
                        Ok(c) => c,
                        Err(e) => {
                            failed_pages.lock().await.push((page_index, e.to_string()));
                            return;
                        }
                    };

                    let blob_path = match VfsBlobRepo::get_blob_path_with_conn(
                        &conn,
                        &blobs_dir,
                        &blob_hash,
                    ) {
                        Ok(Some(path)) => path,
                        Ok(None) => {
                            let err = format!("Blob not found: {}", blob_hash);
                            error!("[PdfProcessingService] {}", err);
                            failed_pages.lock().await.push((page_index, err));
                            return;
                        }
                        Err(e) => {
                            failed_pages.lock().await.push((page_index, e.to_string()));
                            return;
                        }
                    };

                    // 执行 OCR（带重试）
                    let ocr_result = Self::call_ocr_with_retry(
                        &llm_manager,
                        &config,
                        &blob_path,
                        page_index,
                        &cancel_token,
                    )
                    .await;

                    match ocr_result {
                        Ok(blocks) => {
                            let completed = completed_counter.fetch_add(1, Ordering::SeqCst) + 1;
                            all_results.lock().await.push(OcrPageResult {
                                page_index,
                                blocks,
                            });

                            // 发送进度更新（50% - 90% 之间，基于 OCR 完成比例）
                            // ★ P1-1 修复：OCR 进度范围 20%-75%，保证单调递增
                            let ocr_progress = 20.0 + (completed as f64 / total_pages as f64) * 55.0;
                            if let Some(ref app_handle) = app_handle_clone {
                                use tauri::Emitter;
                                let progress = ProcessingProgress {
                                    stage: "ocr_processing".to_string(),
                                    current_page: Some(completed),
                                    total_pages: Some(total_pages),
                                    percent: ocr_progress as f32,
                                    ready_modes: ready_modes_for_task.clone(),
                                    media_type: Some("pdf".to_string()),
                                };
                                let event = MediaProcessingProgressEvent {
                                    file_id: file_id.clone(),
                                    status: progress.clone(),
                                    media_type: "pdf".to_string(),
                                };
                                let _ = app_handle.emit("media-processing-progress", &event);
                                let _ = app_handle.emit("pdf-processing-progress", &event);
                            }

                            debug!(
                                "[PdfProcessingService] OCR completed for page {}/{} of file {} ({}%)",
                                completed, total_pages, file_id, ocr_progress as i32
                            );
                        }
                        Err(e) => {
                            error!(
                                "[PdfProcessingService] OCR failed for page {} of file {}: {}",
                                page_index, file_id, e
                            );
                            failed_pages.lock().await.push((page_index, e));
                        }
                    }
                }
            })
            .collect();

        // 并发执行所有 OCR 任务
        stream::iter(tasks)
            .for_each_concurrent(MAX_OCR_CONCURRENCY, |task| task)
            .await;

        // 6. 检查结果
        let failed = failed_pages.lock().await;
        let mut results = all_results.lock().await;
        let success_count = results.len();
        let failed_count = failed.len();

        info!(
            "[PdfProcessingService] OCR processing completed for file {}: success={}, failed={}",
            file_id, success_count, failed_count
        );

        // 按页码排序
        results.sort_by_key(|r| r.page_index);

        // 7. 构建 ocr_pages_json
        let ocr_json = OcrPagesJson {
            total_pages,
            pages: results.clone(),
            completed_at: chrono::Utc::now().to_rfc3339(),
        };

        let ocr_json_str = serde_json::to_string(&ocr_json).map_err(|e| {
            VfsError::Serialization(format!("Failed to serialize OCR result: {}", e))
        })?;

        // 8. 更新数据库
        // ★ P1-3 修复：部分成功也标记 OCR 可用（成功率 >= 50%）
        // 原策略要求 100% 成功才标记 ocr ready，导致 99/100 页成功也不可用
        let success_rate = if total_pages > 0 {
            success_count as f64 / total_pages as f64
        } else {
            0.0
        };
        let ocr_usable = success_rate >= 0.5; // 50% 以上成功即可用
        self.update_file_ocr(file_id, &ocr_json_str, ocr_usable)
            .await?;

        // 同步内存中的 ready_modes
        if ocr_usable {
            if !ready_modes.contains(&"ocr".to_string()) {
                ready_modes.push("ocr".to_string());
            }
            if failed_count > 0 {
                info!(
                    "[PdfProcessingService] OCR partially succeeded for file {}: {}/{} pages OK ({:.0}%), marking ocr as ready",
                    file_id, success_count, total_pages, success_rate * 100.0
                );
            }
        } else {
            warn!(
                "[PdfProcessingService] OCR mostly failed for file {}: {}/{} pages failed ({:.0}% success), not marking ocr as ready",
                file_id, failed_count, total_pages, success_rate * 100.0
            );
        }

        Ok(ocr_json_str)
    }

    /// 调用 OCR API（带重试机制）
    ///
    /// 使用指数退避重试策略处理速率限制错误
    async fn call_ocr_with_retry(
        llm_manager: &Arc<LLMManager>,
        config: &crate::llm_manager::ApiConfig,
        image_path: &PathBuf,
        page_index: usize,
        cancel_token: &CancellationToken,
    ) -> Result<Vec<PdfOcrTextBlock>, String> {
        let path_str = image_path.to_string_lossy().to_string();
        let mut attempt = 0;
        let mut backoff = INITIAL_BACKOFF_MS;

        loop {
            if cancel_token.is_cancelled() {
                return Err("Cancelled".to_string());
            }

            match llm_manager
                .call_deepseek_ocr_page_raw(config, &path_str, page_index)
                .await
            {
                Ok(cards) => {
                    // 转换 ExamSegmentationCard -> PdfOcrTextBlock
                    let blocks: Vec<PdfOcrTextBlock> = cards
                        .iter()
                        .map(|c| PdfOcrTextBlock {
                            text: c.ocr_text.clone().unwrap_or_default(),
                            bbox: c.bbox.clone(),
                        })
                        .collect();
                    return Ok(blocks);
                }
                Err(e) => {
                    // 检查是否是速率限制错误
                    if Self::is_rate_limit_error(&e) && attempt < MAX_OCR_RETRY_ATTEMPTS {
                        attempt += 1;
                        warn!(
                            "[PdfProcessingService] OCR rate limited for page {}, retrying ({}/{}), backoff={}ms",
                            page_index, attempt, MAX_OCR_RETRY_ATTEMPTS, backoff
                        );
                        sleep(Duration::from_millis(backoff)).await;
                        backoff = (backoff * 2).min(MAX_BACKOFF_MS);
                        continue;
                    }

                    return Err(e.to_string());
                }
            }
        }
    }

    /// 检查是否是速率限制错误
    fn is_rate_limit_error(error: &crate::models::AppError) -> bool {
        if let Some(details) = &error.details {
            if details.get("status").and_then(|v| v.as_u64()) == Some(429) {
                return true;
            }
        }

        let message = error.message.to_ascii_lowercase();
        message.contains("429")
            || message.contains("rate limit")
            || message.contains("too many requests")
    }

    /// 更新文件的 OCR 结果到数据库
    ///
    /// ★ P1-3 修复：`ocr_usable` 参数改为成功率 >=50% 即为 true（原为全部成功）
    /// ★ P1-4 修复：增加 SQLITE_BUSY retry 逻辑，与 update_processing_status 一致
    async fn update_file_ocr(
        &self,
        file_id: &str,
        ocr_json: &str,
        ocr_usable: bool,
    ) -> VfsResult<()> {
        let conn = self.db.get_conn_safe()?;

        // ★ P1-4 修复：带 busy-retry 的事务开始
        // 并发处理多文件时 BEGIN IMMEDIATE 可能因 SQLITE_BUSY 失败
        {
            let max_retries = 3u32;
            let mut attempt = 0u32;
            loop {
                match conn.execute("BEGIN IMMEDIATE", []) {
                    Ok(_) => break,
                    Err(e) if attempt < max_retries => {
                        let msg = e.to_string();
                        if msg.contains("database is locked") || msg.contains("SQLITE_BUSY") {
                            attempt += 1;
                            let backoff_ms = 50 * (1u64 << attempt); // 100ms, 200ms, 400ms
                            warn!(
                                "[PdfProcessingService] update_file_ocr BEGIN IMMEDIATE busy for file {}, retry {}/{} in {}ms",
                                file_id, attempt, max_retries, backoff_ms
                            );
                            sleep(std::time::Duration::from_millis(backoff_ms)).await;
                            continue;
                        }
                        return Err(VfsError::Database(format!("BEGIN IMMEDIATE failed: {}", e)));
                    }
                    Err(e) => {
                        error!(
                            "[PdfProcessingService] update_file_ocr BEGIN IMMEDIATE failed after {} retries for file {}: {}",
                            max_retries, file_id, e
                        );
                        return Err(VfsError::Database(format!(
                            "BEGIN IMMEDIATE failed after {} retries: {}",
                            max_retries, e
                        )));
                    }
                }
            }
        }

        let result = (|| -> VfsResult<()> {
            // 1. 更新 OCR 数据
            conn.execute(
                r#"
                UPDATE files
                SET ocr_pages_json = ?1,
                    updated_at = datetime('now')
                WHERE id = ?2
                "#,
                params![ocr_json, file_id],
            )?;

            // 2. 更新 processing_progress 中的 ready_modes
            // ★ P1-3 修复：成功率 >=50% 即标记 ocr 可用
            if ocr_usable {
                // 先获取当前进度
                let current_progress: Option<String> = conn
                    .query_row(
                        "SELECT processing_progress FROM files WHERE id = ?1",
                        params![file_id],
                        |row| row.get(0),
                    )
                    .ok();

                if let Some(progress_str) = current_progress {
                    if let Ok(mut progress) =
                        serde_json::from_str::<ProcessingProgress>(&progress_str)
                    {
                        if !progress.ready_modes.contains(&"ocr".to_string()) {
                            progress.ready_modes.push("ocr".to_string());
                            let updated_json = serde_json::to_string(&progress).unwrap_or_default();
                            conn.execute(
                                "UPDATE files SET processing_progress = ?1 WHERE id = ?2",
                                params![updated_json, file_id],
                            )?;
                        }
                    }
                }
            }

            Ok(())
        })();

        match result {
            Ok(()) => {
                conn.execute("COMMIT", [])?;
                info!(
                    "[PdfProcessingService] Updated OCR result for file: {} (ocr_usable={})",
                    file_id, ocr_usable
                );
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }
}

// 实现比较操作以支持 start_stage <= ProcessingStage::XXX
impl PartialOrd for ProcessingStage {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ProcessingStage {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let self_order = match self {
            ProcessingStage::Pending => 0,
            ProcessingStage::TextExtraction => 1,
            ProcessingStage::PageRendering => 2,
            ProcessingStage::PageCompression => 3,
            ProcessingStage::ImageCompression => 2, // 与 PageRendering 同级（图片专用）
            ProcessingStage::OcrProcessing => 4,
            ProcessingStage::VectorIndexing => 5,
            ProcessingStage::Completed => 6,
            ProcessingStage::Error => 7,
        };
        let other_order = match other {
            ProcessingStage::Pending => 0,
            ProcessingStage::TextExtraction => 1,
            ProcessingStage::PageRendering => 2,
            ProcessingStage::PageCompression => 3,
            ProcessingStage::ImageCompression => 2, // 与 PageRendering 同级（图片专用）
            ProcessingStage::OcrProcessing => 4,
            ProcessingStage::VectorIndexing => 5,
            ProcessingStage::Completed => 6,
            ProcessingStage::Error => 7,
        };
        self_order.cmp(&other_order)
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_processing_stage_as_str() {
        assert_eq!(ProcessingStage::Pending.as_str(), "pending");
        assert_eq!(ProcessingStage::OcrProcessing.as_str(), "ocr_processing");
        assert_eq!(ProcessingStage::Completed.as_str(), "completed");
    }

    #[test]
    fn test_processing_stage_from_str() {
        assert_eq!(
            ProcessingStage::from_str("pending"),
            ProcessingStage::Pending
        );
        assert_eq!(
            ProcessingStage::from_str("ocr_processing"),
            ProcessingStage::OcrProcessing
        );
        assert_eq!(
            ProcessingStage::from_str("unknown"),
            ProcessingStage::Pending
        );
    }

    #[test]
    fn test_processing_stage_order() {
        assert!(ProcessingStage::Pending < ProcessingStage::TextExtraction);
        assert!(ProcessingStage::OcrProcessing < ProcessingStage::VectorIndexing);
        assert!(ProcessingStage::VectorIndexing < ProcessingStage::Completed);
    }

    #[test]
    fn test_processing_progress_default() {
        let progress = ProcessingProgress::default();
        assert_eq!(progress.stage, "pending");
        assert_eq!(progress.percent, 0.0);
        assert!(progress.ready_modes.is_empty());
    }
}
