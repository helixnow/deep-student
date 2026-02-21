//! 页面索引器
//!
//! 将资源的 preview_json 解析为多模态向量并持久化。
//!
//! ## 核心流程
//!
//! 1. **页面解析**: 从 preview_json 提取页面列表
//! 2. **内容构建**: 对每页加载图片（从 Blob）和文本（OCR/摘要）
//! 3. **多模态输入**: 组装为 MultimodalInput
//! 4. **批量嵌入**: 调用 MultimodalEmbeddingService
//! 5. **持久化**: 写入 LanceDB 和 SQLite
//!
//! ## 增量索引
//!
//! 通过比对 blob_hash 检测页面变化：
//! - 新增页面: 创建嵌入
//! - 图片变化: 更新嵌入
//! - 页面删除: 清理嵌入
//! - 无变化: 跳过
//!
//! 设计文档参考: docs/multimodal-knowledge-base-design.md (Section 7.5)

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};

use tokio::sync::mpsc;

use crate::database::Database;
use crate::models::{AppError, ExamCardPreview, ExamSheetPreviewResult};
use crate::multimodal::embedding_service::MultimodalEmbeddingService;
use crate::multimodal::types::{
    IndexProgressEvent, IndexResult, MultimodalIndexingMode, PageIndexLog,
    PageIndexTask, SourceType,
};
use crate::multimodal::vector_store::{MultimodalPageRecord, MultimodalVectorStore};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{
    PageIndexMeta, VfsBlobRepo, VfsExamRepo, VfsFileRepo, VfsIndexStateRepo, VfsResourceRepo,
    VfsTextbookRepo, INDEX_STATE_INDEXED,
};

type Result<T> = std::result::Result<T, AppError>;

/// 索引指令（用于嵌入优化）
const DOCUMENT_INSTRUCTION: &str = "Represent this document page for retrieval";

/// PDF 附件/教材预览结构
///
/// 支持两种命名格式：
/// - snake_case: dpi, page_count（旧格式）
/// - camelCase: renderDpi, totalPages（PdfPreviewJson 使用）
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AttachmentPreview {
    pub pages: Vec<AttachmentPreviewPage>,
    #[serde(default, alias = "renderDpi")]
    pub dpi: Option<u32>,
    #[serde(default, alias = "totalPages")]
    pub page_count: Option<usize>,
    #[serde(default, alias = "renderedAt")]
    pub rendered_at: Option<String>,
}

/// PDF 附件/教材的单页预览数据
///
/// 支持两种命名格式：
/// - snake_case: page_index, blob_hash, mime_type（旧格式）
/// - camelCase: pageIndex, blobHash, mimeType（PdfPagePreview 使用）
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AttachmentPreviewPage {
    #[serde(alias = "pageIndex")]
    pub page_index: usize,
    #[serde(alias = "blobHash")]
    pub blob_hash: Option<String>,
    #[serde(default, alias = "width")]
    pub width: Option<u32>,
    #[serde(default, alias = "height")]
    pub height: Option<u32>,
    #[serde(default, alias = "mimeType")]
    pub mime_type: Option<String>,
}

/// 教材预览结构（与 PDF 附件类似）
pub type TextbookPreview = AttachmentPreview;
pub type TextbookPreviewPage = AttachmentPreviewPage;

/// 待索引的页面数据
#[derive(Debug, Clone)]
struct PageToIndex {
    page_index: i32,
    blob_hash: String,
    image_base64: String,
    media_type: String,
    text_summary: Option<String>,
}

/// 页面索引器
///
/// 将资源的 preview_json 解析为多模态向量并持久化
pub struct PageIndexer {
    database: Arc<Database>,
    vfs_db: Arc<VfsDatabase>,
    embedding_service: Arc<MultimodalEmbeddingService>,
    vector_store: Arc<MultimodalVectorStore>,
    /// 进度事件发送通道（可选）
    progress_tx: Option<mpsc::UnboundedSender<IndexProgressEvent>>,
}

impl PageIndexer {
    /// 创建新的页面索引器
    pub fn new(
        database: Arc<Database>,
        vfs_db: Arc<VfsDatabase>,
        embedding_service: Arc<MultimodalEmbeddingService>,
        vector_store: Arc<MultimodalVectorStore>,
    ) -> Self {
        Self {
            database,
            vfs_db,
            embedding_service,
            vector_store,
            progress_tx: None,
        }
    }

    /// 创建带进度回调的页面索引器
    pub fn with_progress(
        database: Arc<Database>,
        vfs_db: Arc<VfsDatabase>,
        embedding_service: Arc<MultimodalEmbeddingService>,
        vector_store: Arc<MultimodalVectorStore>,
        progress_tx: mpsc::UnboundedSender<IndexProgressEvent>,
    ) -> Self {
        Self {
            database,
            vfs_db,
            embedding_service,
            vector_store,
            progress_tx: Some(progress_tx),
        }
    }

    /// 发送进度事件
    fn emit_progress(&self, event: IndexProgressEvent) {
        if let Some(ref tx) = self.progress_tx {
            let _ = tx.send(event);
        }
    }

    /// 索引题目集识别资源
    ///
    /// ## 参数
    /// - `exam_id`: 题目集识别 ID
    /// - `preview`: 预览数据
    /// - `sub_library_id`: 可选的知识库 ID
    /// - `force_rebuild`: 是否强制重建（忽略增量检测）
    /// - `indexing_mode`: 索引模式
    pub async fn index_exam(
        &self,
        exam_id: &str,
        preview: &ExamSheetPreviewResult,
        sub_library_id: Option<&str>,
        force_rebuild: bool,
        indexing_mode: MultimodalIndexingMode,
    ) -> Result<IndexResult> {
        log::info!(
            "📄 开始索引题目集识别: {} ({} 页) - 模式: {:?}",
            exam_id,
            preview.pages.len(),
            indexing_mode
        );

        // 解析页面数据
        let pages_to_index = self
            .prepare_exam_pages(preview, force_rebuild, exam_id)
            .await?;

        if pages_to_index.is_empty() {
            log::info!("✅ 题目集识别 {} 无需索引更新", exam_id);
            return Ok(IndexResult::success(
                0,
                preview.pages.len() as i32,
                preview.pages.len() as i32,
            ));
        }

        // 执行索引
        self.index_pages(
            SourceType::Exam,
            exam_id,
            sub_library_id,
            &pages_to_index,
            preview.pages.len() as i32,
            indexing_mode,
        )
        .await
    }

    /// 索引 PDF 附件
    ///
    /// ## 参数
    /// - `attachment_id`: 附件 ID
    /// - `preview_json`: preview_json 字符串
    /// - `extracted_text`: 可选的提取文本（用于文本摘要）
    /// - `sub_library_id`: 可选的知识库 ID
    /// - `force_rebuild`: 是否强制重建
    /// - `indexing_mode`: 索引模式
    pub async fn index_attachment(
        &self,
        attachment_id: &str,
        preview_json: &str,
        extracted_text: Option<&str>,
        sub_library_id: Option<&str>,
        force_rebuild: bool,
        indexing_mode: MultimodalIndexingMode,
    ) -> Result<IndexResult> {
        // 解析 preview_json
        let preview: AttachmentPreview = serde_json::from_str(preview_json)
            .map_err(|e| AppError::internal(format!("解析附件 preview_json 失败: {}", e)))?;

        log::info!(
            "📎 开始索引 PDF 附件: {} ({} 页) - 模式: {:?}",
            attachment_id,
            preview.pages.len(),
            indexing_mode
        );

        // 准备页面数据
        let pages_to_index = self
            .prepare_attachment_pages(&preview, extracted_text, force_rebuild, attachment_id)
            .await?;

        if pages_to_index.is_empty() {
            log::info!("✅ PDF 附件 {} 无需索引更新", attachment_id);
            return Ok(IndexResult::success(
                0,
                preview.pages.len() as i32,
                preview.pages.len() as i32,
            ));
        }

        // 执行索引
        self.index_pages(
            SourceType::Attachment,
            attachment_id,
            sub_library_id,
            &pages_to_index,
            preview.pages.len() as i32,
            indexing_mode,
        )
        .await
    }

    /// 索引教材
    ///
    /// ## 参数
    /// - `textbook_id`: 教材 ID
    /// - `preview_json`: preview_json 字符串
    /// - `sub_library_id`: 可选的知识库 ID
    /// - `force_rebuild`: 是否强制重建
    /// - `indexing_mode`: 索引模式
    pub async fn index_textbook(
        &self,
        textbook_id: &str,
        preview_json: &str,
        sub_library_id: Option<&str>,
        force_rebuild: bool,
        indexing_mode: MultimodalIndexingMode,
    ) -> Result<IndexResult> {
        // 解析 preview_json
        let preview: TextbookPreview = serde_json::from_str(preview_json)
            .map_err(|e| AppError::internal(format!("解析教材 preview_json 失败: {}", e)))?;

        log::info!(
            "📚 开始索引教材: {} ({} 页) - 模式: {:?}",
            textbook_id,
            preview.pages.len(),
            indexing_mode
        );

        // 准备页面数据
        let pages_to_index = self
            .prepare_textbook_pages(&preview, force_rebuild, textbook_id)
            .await?;

        if pages_to_index.is_empty() {
            log::info!("✅ 教材 {} 无需索引更新", textbook_id);
            return Ok(IndexResult::success(
                0,
                preview.pages.len() as i32,
                preview.pages.len() as i32,
            ));
        }

        // 执行索引
        self.index_pages(
            SourceType::Textbook,
            textbook_id,
            sub_library_id,
            &pages_to_index,
            preview.pages.len() as i32,
            indexing_mode,
        )
        .await
    }

    /// 索引独立图片资源
    ///
    /// 对独立图片进行 OCR 摘要并生成向量嵌入。
    /// 图片被视为单页资源（page_index = 0）。
    ///
    /// ## 参数
    /// - `image_id`: 图片资源 ID（VFS resources 表中的 ID）
    /// - `sub_library_id`: 可选的知识库 ID
    /// - `force_rebuild`: 是否强制重建
    /// - `indexing_mode`: 索引模式
    pub async fn index_image(
        &self,
        image_id: &str,
        sub_library_id: Option<&str>,
        force_rebuild: bool,
        indexing_mode: MultimodalIndexingMode,
    ) -> Result<IndexResult> {
        log::info!("🖼️ 开始索引图片: {} - 模式: {:?}", image_id, indexing_mode);

        // 从 VFS 加载图片数据
        let (blob_hash, base64, media_type) = match self.load_image(image_id) {
            Ok(data) => data,
            Err(e) => {
                let err_msg = format!("加载图片失败: {}", e);
                log::error!("  ❌ {}", err_msg);
                self.set_mm_index_state(SourceType::Image, image_id, "failed", Some(&err_msg));
                return Err(e);
            }
        };

        // 检查是否需要索引
        if !force_rebuild {
            let existing_hashes = self.get_existing_page_hashes(SourceType::Image, image_id)?;
            if let Some(existing_hash) = existing_hashes.get(&0) {
                if existing_hash == &blob_hash {
                    log::info!("✅ 图片 {} 无需索引更新 (blob_hash 未变化)", image_id);
                    return Ok(IndexResult::success(0, 1, 1));
                }
            }
        }

        // 构建单页数据
        let pages_to_index = vec![PageToIndex {
            page_index: 0,
            blob_hash,
            image_base64: base64,
            media_type,
            text_summary: None, // OCR 摘要将由嵌入服务生成
        }];

        // 执行索引
        self.index_pages(
            SourceType::Image,
            image_id,
            sub_library_id,
            &pages_to_index,
            1,
            indexing_mode,
        )
        .await
    }

    /// 根据任务配置索引资源
    ///
    /// 确保任何错误都会被捕获并设置 mm_index_state = 'failed'
    pub async fn index_by_task(&self, task: &PageIndexTask) -> Result<IndexResult> {
        let result = self.index_by_task_inner(task).await;

        // 如果索引失败，确保设置 mm_index_state = 'failed'
        if let Err(ref e) = result {
            let err_msg = format!("{}", e);
            log::error!(
                "  ❌ [{:?}:{}] 索引失败: {}",
                task.source_type,
                task.source_id,
                err_msg
            );
            self.set_mm_index_state(task.source_type, &task.source_id, "failed", Some(&err_msg));
        }

        result
    }

    /// 索引任务的内部实现
    async fn index_by_task_inner(&self, task: &PageIndexTask) -> Result<IndexResult> {
        match task.source_type {
            SourceType::Exam => {
                // 从数据库加载题目集识别数据
                let exam = self
                    .load_exam(&task.source_id)
                    .map_err(|e| AppError::internal(format!("加载题目集数据失败: {}", e)))?;
                let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
                    .map_err(|e| {
                        AppError::internal(format!("解析题目集 preview_json 失败: {}", e))
                    })?;
                self.index_exam(
                    &task.source_id,
                    &preview,
                    task.sub_library_id.as_deref(),
                    task.force_rebuild,
                    task.indexing_mode,
                )
                .await
            }
            SourceType::Attachment => {
                // 从数据库加载附件数据
                let (preview_json, extracted_text) = self
                    .load_attachment(&task.source_id)
                    .map_err(|e| AppError::internal(format!("加载附件数据失败: {}", e)))?;
                self.index_attachment(
                    &task.source_id,
                    &preview_json,
                    extracted_text.as_deref(),
                    task.sub_library_id.as_deref(),
                    task.force_rebuild,
                    task.indexing_mode,
                )
                .await
            }
            SourceType::Textbook => {
                // 从数据库加载教材数据
                let preview_json = self
                    .load_textbook(&task.source_id)
                    .map_err(|e| AppError::internal(format!("加载教材数据失败: {}", e)))?;
                self.index_textbook(
                    &task.source_id,
                    &preview_json,
                    task.sub_library_id.as_deref(),
                    task.force_rebuild,
                    task.indexing_mode,
                )
                .await
            }
            SourceType::Image => {
                // 索引独立图片资源
                self.index_image(
                    &task.source_id,
                    task.sub_library_id.as_deref(),
                    task.force_rebuild,
                    task.indexing_mode,
                )
                .await
            }
            _ => Err(AppError::configuration(format!(
                "不支持的来源类型: {:?}",
                task.source_type
            ))),
        }
    }

    /// 删除资源的所有索引
    pub async fn delete_index(&self, source_type: SourceType, source_id: &str) -> Result<()> {
        log::info!("🗑️ 删除索引: {:?} {}", source_type, source_id);

        // 删除 LanceDB 向量
        self.vector_store
            .delete_by_source(source_type, source_id)
            .await?;

        // 删除 VFS 中的索引元数据（替代 mm_page_embeddings）
        match source_type {
            SourceType::Textbook => {
                if let Err(e) = VfsTextbookRepo::clear_mm_index(&self.vfs_db, source_id) {
                    log::warn!("清除教材索引元数据失败: {}", e);
                }
            }
            _ => {
                // 其他类型暂不处理（图片等使用 resources 表）
            }
        }

        log::info!("✅ 索引删除完成: {:?} {}", source_type, source_id);
        Ok(())
    }

    // ============================================================================
    // 私有方法
    // ============================================================================

    /// 准备题目集识别页面数据
    async fn prepare_exam_pages(
        &self,
        preview: &ExamSheetPreviewResult,
        force_rebuild: bool,
        source_id: &str,
    ) -> Result<Vec<PageToIndex>> {
        let existing_hashes = if force_rebuild {
            HashMap::new()
        } else {
            self.get_existing_page_hashes(SourceType::Exam, source_id)?
        };

        let mut pages_to_index = Vec::new();

        for page in &preview.pages {
            let blob_hash = match &page.blob_hash {
                Some(h) if !h.is_empty() => h.clone(),
                _ => continue, // 跳过没有 blob_hash 的页面
            };

            // 增量检测：检查 blob_hash 是否变化
            if !force_rebuild {
                if let Some(existing_hash) = existing_hashes.get(&(page.page_index as i32)) {
                    if existing_hash == &blob_hash {
                        log::debug!("  跳过页面 {} (blob_hash 未变化)", page.page_index);
                        continue;
                    }
                }
            }

            // 加载图片数据
            match self.load_blob_base64(&blob_hash).await {
                Ok((base64, media_type)) => {
                    // 提取 OCR 文本作为摘要
                    let text_summary = Self::extract_ocr_text_from_cards(&page.cards);

                    pages_to_index.push(PageToIndex {
                        page_index: page.page_index as i32,
                        blob_hash,
                        image_base64: base64,
                        media_type,
                        text_summary,
                    });
                }
                Err(e) => {
                    log::warn!("  加载页面 {} 图片失败: {}", page.page_index, e);
                }
            }
        }

        Ok(pages_to_index)
    }

    /// 准备 PDF 附件页面数据
    async fn prepare_attachment_pages(
        &self,
        preview: &AttachmentPreview,
        extracted_text: Option<&str>,
        force_rebuild: bool,
        source_id: &str,
    ) -> Result<Vec<PageToIndex>> {
        let existing_hashes = if force_rebuild {
            HashMap::new()
        } else {
            self.get_existing_page_hashes(SourceType::Attachment, source_id)?
        };

        let mut pages_to_index = Vec::new();

        // 如果有提取文本，按页数分割（简单均分）
        let text_per_page = extracted_text.map(|t| {
            let lines: Vec<&str> = t.lines().collect();
            let pages_count = preview.pages.len().max(1);
            let lines_per_page = (lines.len() / pages_count).max(1);
            lines
                .chunks(lines_per_page)
                .map(|chunk| chunk.join("\n"))
                .collect::<Vec<_>>()
        });

        for page in &preview.pages {
            let blob_hash = match &page.blob_hash {
                Some(h) if !h.is_empty() => h.clone(),
                _ => continue,
            };

            // 增量检测
            if !force_rebuild {
                if let Some(existing_hash) = existing_hashes.get(&(page.page_index as i32)) {
                    if existing_hash == &blob_hash {
                        continue;
                    }
                }
            }

            // 加载图片
            match self.load_blob_base64(&blob_hash).await {
                Ok((base64, media_type)) => {
                    // 获取该页的文本摘要
                    let text_summary = text_per_page
                        .as_ref()
                        .and_then(|texts| texts.get(page.page_index).cloned());

                    pages_to_index.push(PageToIndex {
                        page_index: page.page_index as i32,
                        blob_hash,
                        image_base64: base64,
                        media_type,
                        text_summary,
                    });
                }
                Err(e) => {
                    log::warn!("  加载附件页面 {} 图片失败: {}", page.page_index, e);
                }
            }
        }

        Ok(pages_to_index)
    }

    /// 准备教材页面数据
    async fn prepare_textbook_pages(
        &self,
        preview: &TextbookPreview,
        force_rebuild: bool,
        source_id: &str,
    ) -> Result<Vec<PageToIndex>> {
        log::info!(
            "  🔍 准备教材页面: {} 页, force_rebuild={}",
            preview.pages.len(),
            force_rebuild
        );

        let existing_hashes = if force_rebuild {
            log::info!("  ⚡ 强制重建模式，跳过增量检测");
            HashMap::new()
        } else {
            log::info!("  🔎 查询已有索引...");
            match self.get_existing_page_hashes(SourceType::Textbook, source_id) {
                Ok(hashes) => {
                    log::info!("  📊 已有索引: {} 页", hashes.len());
                    hashes
                }
                Err(e) => {
                    log::error!("  ❌ 查询已有索引失败: {}", e);
                    return Err(e);
                }
            }
        };

        let mut pages_to_index = Vec::new();
        let mut skipped_no_hash = 0;
        let mut skipped_unchanged = 0;
        let mut load_errors = 0;

        for page in &preview.pages {
            let blob_hash = match &page.blob_hash {
                Some(h) if !h.is_empty() => h.clone(),
                _ => {
                    skipped_no_hash += 1;
                    continue;
                }
            };

            // 增量检测
            if !force_rebuild {
                if let Some(existing_hash) = existing_hashes.get(&(page.page_index as i32)) {
                    if existing_hash == &blob_hash {
                        skipped_unchanged += 1;
                        continue;
                    }
                }
            }

            // 加载图片
            match self.load_blob_base64(&blob_hash).await {
                Ok((base64, media_type)) => {
                    // ★ 尝试从 VFS 加载已有 OCR（重索引时复用）
                    let existing_ocr =
                        VfsTextbookRepo::get_page_ocr(&self.vfs_db, source_id, page.page_index)
                            .ok()
                            .flatten();

                    if existing_ocr.is_some() {
                        log::debug!("  📖 P{}: 复用已有 OCR", page.page_index);
                    }

                    pages_to_index.push(PageToIndex {
                        page_index: page.page_index as i32,
                        blob_hash,
                        image_base64: base64,
                        media_type,
                        text_summary: existing_ocr, // 复用已有 OCR
                    });
                }
                Err(e) => {
                    load_errors += 1;
                    log::warn!("  ⚠️ 加载教材页面 {} 图片失败: {}", page.page_index, e);
                }
            }
        }

        log::info!(
            "  📋 页面准备完成: 待索引={}, 跳过(无hash)={}, 跳过(未变)={}, 加载失败={}",
            pages_to_index.len(),
            skipped_no_hash,
            skipped_unchanged,
            load_errors
        );

        Ok(pages_to_index)
    }

    /// 执行页面索引（逐页处理，支持部分成功）
    ///
    /// ## 改进设计
    /// - 逐页处理嵌入，成功的页面立即保存
    /// - 失败的页面记录错误但不中断整体流程
    /// - 生成详细的每页索引日志，便于调试
    ///
    /// ## 参数
    /// - `source_type`: 来源类型
    /// - `source_id`: 来源 ID
    /// - `sub_library_id`: 可选的知识库 ID
    /// - `pages`: 待索引的页面列表
    /// - `total_pages`: 总页数（用于统计）
    /// - `indexing_mode`: 索引模式（VLEmbedding 或 VLSummaryThenTextEmbed）
    async fn index_pages(
        &self,
        source_type: SourceType,
        source_id: &str,
        sub_library_id: Option<&str>,
        pages: &[PageToIndex],
        total_pages: i32,
        indexing_mode: MultimodalIndexingMode,
    ) -> Result<IndexResult> {
        let skipped_unchanged = total_pages - pages.len() as i32;
        let mut page_logs: Vec<PageIndexLog> = Vec::new();
        let mut indexed_count = 0i32;
        let mut failed_count = 0i32;

        // ★ 设置 mm_index_state = 'indexing'
        self.set_mm_index_state(source_type, source_id, "indexing", None);

        // 为跳过的页面（未变化）添加日志
        // 注意：这些页面在 prepare_*_pages 阶段已被过滤，不在 pages 列表中

        if pages.is_empty() {
            self.emit_progress(
                IndexProgressEvent::new(source_type.as_str(), source_id, total_pages)
                    .with_phase(
                        "completed",
                        &format!("索引完成，跳过 {} 页（无变化）", skipped_unchanged),
                    )
                    .with_progress(total_pages, 0, skipped_unchanged),
            );
            return Ok(IndexResult::with_logs(
                0,
                skipped_unchanged,
                0,
                total_pages,
                page_logs,
            ));
        }

        // ========== 确定实际使用的索引模式（带回退逻辑）==========
        let actual_mode = if self
            .embedding_service
            .is_mode_available(indexing_mode)
            .await
        {
            indexing_mode
        } else {
            // 尝试回退到另一个模式
            let fallback = match indexing_mode {
                MultimodalIndexingMode::VLEmbedding => {
                    MultimodalIndexingMode::VLSummaryThenTextEmbed
                }
                MultimodalIndexingMode::VLSummaryThenTextEmbed => {
                    MultimodalIndexingMode::VLEmbedding
                }
            };
            if self.embedding_service.is_mode_available(fallback).await {
                log::warn!(
                    "⚠️ [{:?}:{}] 请求的模式 {:?} 不可用，回退到 {:?}",
                    source_type,
                    source_id,
                    indexing_mode,
                    fallback
                );
                fallback
            } else {
                let err_msg = "未配置任何多模态嵌入模型。请在设置中配置 VL-Embedding 模型或 VL 聊天模型 + 文本嵌入模型。";
                log::error!("  ❌ {}", err_msg);
                return Err(AppError::configuration(err_msg));
            }
        };

        log::info!(
            "📄 [{:?}:{}] 开始索引 {} 页 (模式: {:?})",
            source_type,
            source_id,
            pages.len(),
            actual_mode
        );

        // 发送准备阶段进度
        self.emit_progress(
            IndexProgressEvent::new(source_type.as_str(), source_id, total_pages)
                .with_phase(
                    "preparing",
                    &format!("准备索引 {} 页 (模式: {:?})...", pages.len(), actual_mode),
                )
                .with_progress(0, 0, skipped_unchanged),
        );

        // 获取模型版本（使用实际模式）
        let model_version = match self
            .embedding_service
            .get_model_version_for_mode(actual_mode)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                let err_msg = format!("获取模型版本失败: {}", e);
                log::error!("  ❌ {}", err_msg);
                return Err(AppError::configuration(err_msg));
            }
        };

        let vector_type = actual_mode.vector_table_suffix();
        let now = Utc::now();
        let now_str = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

        // ========== 逐页处理（支持部分成功）==========
        for (idx, page) in pages.iter().enumerate() {
            let page_start = std::time::Instant::now();
            let page_num = page.page_index + 1; // 1-based 用于显示

            // 发送当前页进度
            self.emit_progress(
                IndexProgressEvent::new(source_type.as_str(), source_id, total_pages)
                    .with_phase(
                        "processing",
                        &format!("处理第 {} 页 ({}/{})", page_num, idx + 1, pages.len()),
                    )
                    .with_progress(idx as i32, indexed_count, skipped_unchanged),
            );

            // 构建单页输入
            let input = vec![(
                page.image_base64.clone(),
                page.media_type.clone(),
                page.text_summary.clone(),
            )];

            // 调用嵌入服务（单页，使用实际模式）
            let embed_result = self
                .embedding_service
                .embed_pages_with_mode_and_progress(
                    &input,
                    actual_mode,
                    Some(DOCUMENT_INSTRUCTION),
                    None,
                )
                .await;

            match embed_result {
                Ok((embeddings, summaries)) => {
                    if embeddings.is_empty() {
                        let err_msg = "嵌入服务返回空结果";
                        log::warn!("  ⚠️ P{}: {}", page_num, err_msg);
                        page_logs.push(PageIndexLog::failed(page.page_index, err_msg));
                        failed_count += 1;
                        continue;
                    }

                    let embedding = &embeddings[0];
                    let summary = summaries.get(0).and_then(|s| s.clone());
                    let dim = embedding.len();

                    // ★ 立即保存 OCR 到 VFS（与向量存储解耦）
                    if let Some(ref ocr_text) = summary {
                        match source_type {
                            SourceType::Textbook => {
                                if let Err(e) = VfsTextbookRepo::save_page_ocr(
                                    &self.vfs_db,
                                    source_id,
                                    page.page_index as usize,
                                    ocr_text,
                                ) {
                                    log::warn!("  ⚠️ P{}: VFS OCR 保存失败: {}", page_num, e);
                                } else {
                                    log::debug!("  📝 P{}: OCR 已保存到 VFS (textbook)", page_num);
                                }
                            }
                            SourceType::Image => {
                                // 图片类型：直接使用 source_id 作为 resource_id 保存
                                // 注意：图片的 source_id 就是 resource_id（格式如 res_xxx）
                                if let Err(e) = VfsResourceRepo::save_ocr_text(
                                    &self.vfs_db,
                                    source_id,
                                    ocr_text,
                                ) {
                                    log::warn!("  ⚠️ Image OCR 保存失败: {}", e);
                                } else {
                                    log::debug!(
                                        "  📝 Image OCR 已保存到 VFS (resource_id={})",
                                        source_id
                                    );
                                }
                            }
                            SourceType::Attachment => {
                                if let Err(e) = VfsFileRepo::save_page_ocr(
                                    &self.vfs_db,
                                    source_id,
                                    page.page_index as usize,
                                    ocr_text,
                                ) {
                                    log::warn!(
                                        "  ⚠️ P{}: VFS OCR 保存失败 (file): {}",
                                        page_num,
                                        e
                                    );
                                } else {
                                    log::debug!("  📝 P{}: OCR 已保存到 VFS (file)", page_num);
                                }
                            }
                            SourceType::Exam => {
                                // 题目集类型：保存页级 OCR 到 exam_sheets.ocr_pages_json
                                if let Err(e) = VfsExamRepo::save_page_ocr(
                                    &self.vfs_db,
                                    source_id,
                                    page.page_index as usize,
                                    ocr_text,
                                ) {
                                    log::warn!(
                                        "  ⚠️ P{}: VFS OCR 保存失败 (exam): {}",
                                        page_num,
                                        e
                                    );
                                } else {
                                    log::debug!("  📝 P{}: OCR 已保存到 VFS (exam)", page_num);
                                }
                            }
                            _ => {
                                // Note 类型等暂不保存到 VFS
                            }
                        }
                    }

                    // 构建记录
                    let page_id = format!("page_{}", nanoid::nanoid!(12));
                    let record = MultimodalPageRecord {
                        page_id: page_id.clone(),
                        source_type: source_type.as_str().to_string(),
                        source_id: source_id.to_string(),
                        sub_library_id: sub_library_id.map(|s| s.to_string()),
                        page_index: page.page_index,
                        blob_hash: Some(page.blob_hash.clone()),
                        text_summary: summary.clone(),
                        metadata_json: None,
                        created_at: now_str.clone(),
                        embedding: embedding.clone(),
                    };

                    // 写入 LanceDB（单页）
                    if let Err(e) = self
                        .vector_store
                        .upsert_pages(&[record.clone()], vector_type)
                        .await
                    {
                        let err_msg = format!("LanceDB写入失败: {}", e);
                        log::warn!("  ⚠️ P{}: {}", page_num, err_msg);
                        page_logs.push(PageIndexLog::failed(page.page_index, err_msg));
                        failed_count += 1;
                        continue;
                    }

                    // 写入 VFS 索引元数据（替代 mm_page_embeddings）
                    if source_type == SourceType::Textbook {
                        let meta = PageIndexMeta {
                            page_index: page.page_index,
                            blob_hash: page.blob_hash.clone(),
                            embedding_dim: dim as i32,
                            indexing_mode: actual_mode.as_str().to_string(),
                            indexed_at: now_str.clone(),
                        };
                        if let Err(e) =
                            VfsTextbookRepo::save_page_mm_index(&self.vfs_db, source_id, &meta)
                        {
                            log::warn!("  ⚠️ P{}: VFS索引元数据保存失败: {}", page_num, e);
                        }
                    } else if let Err(e) = self.update_resource_mm_index_meta(
                        source_type,
                        source_id,
                        dim as i32,
                        actual_mode.as_str(),
                        &now_str,
                    ) {
                        log::warn!("  ⚠️ P{}: 更新资源多模态索引元数据失败: {}", page_num, e);
                    }

                    let duration_ms = page_start.elapsed().as_millis() as u64;
                    indexed_count += 1;

                    // 记录成功日志
                    page_logs.push(PageIndexLog::success(
                        page.page_index,
                        summary.as_deref(),
                        dim,
                        duration_ms,
                    ));

                    log::info!(
                        "  ✅ P{}: dim={}, summary={}字符, {}ms",
                        page_num,
                        dim,
                        summary.as_ref().map(|s| s.len()).unwrap_or(0),
                        duration_ms
                    );
                }
                Err(e) => {
                    let err_msg = format!("嵌入生成失败: {}", e);
                    log::warn!("  ⚠️ P{}: {}", page_num, err_msg);
                    page_logs.push(PageIndexLog::failed(page.page_index, err_msg));
                    failed_count += 1;
                }
            }
        }

        // 生成结果和日志摘要
        let result = IndexResult::with_logs(
            indexed_count,
            skipped_unchanged,
            failed_count,
            total_pages,
            page_logs,
        );

        // 输出可读日志摘要
        log::info!("\n{}", result.to_log_summary());

        // ★ 更新资源的 index_state（让前端显示正确的索引状态）
        if indexed_count > 0 || skipped_unchanged > 0 {
            if let Err(e) = self.update_resource_index_state(source_type, source_id) {
                log::warn!("  ⚠️ 更新资源索引状态失败: {}", e);
            }
        }

        // ★ 根据索引结果设置 mm_index_state
        if indexed_count == 0 && skipped_unchanged == 0 && failed_count > 0 {
            // 全部失败
            self.set_mm_index_state(source_type, source_id, "failed", Some("所有页面索引失败"));
        } else if indexed_count > 0 || skipped_unchanged > 0 {
            // 有成功的页面 - mm_index_state 已在 update_resource_mm_index_meta 中设置为 indexed
            // 这里不需要额外操作
        }

        // 发送完成事件
        let completion_msg = if failed_count > 0 {
            format!(
                "索引完成：{} 页成功，{} 页失败，{} 页跳过",
                indexed_count, failed_count, skipped_unchanged
            )
        } else {
            format!(
                "索引完成：{} 页已索引，{} 页已跳过",
                indexed_count, skipped_unchanged
            )
        };

        self.emit_progress(
            IndexProgressEvent::new(source_type.as_str(), source_id, total_pages)
                .with_phase("completed", &completion_msg)
                .with_progress(total_pages, indexed_count, skipped_unchanged),
        );

        Ok(result)
    }

    /// 获取已存在页面的 blob_hash 映射（从 VFS 表读取，替代 mm_page_embeddings）
    fn get_existing_page_hashes(
        &self,
        source_type: SourceType,
        source_id: &str,
    ) -> Result<HashMap<i32, String>> {
        match source_type {
            SourceType::Textbook => {
                // 从 VFS textbooks 表读取
                VfsTextbookRepo::get_mm_indexed_blob_hashes(&self.vfs_db, source_id)
                    .map_err(|e| AppError::database(format!("获取教材索引元数据失败: {}", e)))
            }
            _ => {
                // 其他类型暂返回空映射（后续可扩展 resources 表）
                Ok(HashMap::new())
            }
        }
    }

    /// 加载 Blob 内容并转换为 Base64
    async fn load_blob_base64(&self, blob_hash: &str) -> Result<(String, String)> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        // 获取 Blob 路径
        let blob_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, self.vfs_db.blobs_dir(), blob_hash)
                .map_err(|e| AppError::database(format!("获取 Blob 路径失败: {}", e)))?
                .ok_or_else(|| AppError::not_found(format!("Blob 不存在: {}", blob_hash)))?;

        // 读取文件
        let data = std::fs::read(&blob_path)
            .map_err(|e| AppError::file_system(format!("读取 Blob 文件失败: {}", e)))?;

        // 编码为 Base64
        let base64 = BASE64.encode(&data);

        // 推断 MIME 类型
        let media_type = Self::infer_media_type(&blob_path);

        Ok((base64, media_type))
    }

    /// 从题目集识别卡片提取 OCR 文本
    fn extract_ocr_text_from_cards(cards: &[ExamCardPreview]) -> Option<String> {
        let texts: Vec<&str> = cards
            .iter()
            .map(|card| card.ocr_text.as_str())
            .filter(|t| !t.is_empty())
            .collect();

        if texts.is_empty() {
            None
        } else {
            Some(texts.join("\n"))
        }
    }

    /// 推断文件 MIME 类型
    fn infer_media_type(path: &Path) -> String {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg".to_string(),
            "png" => "image/png".to_string(),
            "gif" => "image/gif".to_string(),
            "webp" => "image/webp".to_string(),
            "bmp" => "image/bmp".to_string(),
            _ => "image/png".to_string(), // 默认 PNG
        }
    }

    /// 从数据库加载题目集识别数据
    fn load_exam(&self, exam_id: &str) -> Result<ExamRecord> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        conn.query_row(
            "SELECT id, preview_json FROM exam_sheets WHERE id = ?1",
            params![exam_id],
            |row| {
                Ok(ExamRecord {
                    id: row.get(0)?,
                    preview_json: row
                        .get::<_, String>(1)
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or_default(),
                })
            },
        )
        .map_err(|e| AppError::not_found(format!("题目集识别不存在: {} ({})", exam_id, e)))
    }

    /// 从数据库加载附件数据
    fn load_attachment(&self, attachment_id: &str) -> Result<(String, Option<String>)> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        conn.query_row(
            "SELECT preview_json, extracted_text FROM files WHERE id = ?1",
            params![attachment_id],
            |row| {
                let preview: Option<String> = row.get(0)?;
                let text: Option<String> = row.get(1)?;
                Ok((preview.unwrap_or_default(), text))
            },
        )
        .map_err(|e| AppError::not_found(format!("附件不存在: {} ({})", attachment_id, e)))
    }

    /// 从数据库加载教材数据
    fn load_textbook(&self, textbook_id: &str) -> Result<String> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        conn.query_row(
            "SELECT preview_json FROM files WHERE id = ?1",
            params![textbook_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| AppError::not_found(format!("教材不存在: {} ({})", textbook_id, e)))?
        .ok_or_else(|| AppError::not_found(format!("教材无预览数据: {}", textbook_id)))
    }

    /// 从 VFS 加载图片资源数据
    ///
    /// ## 返回
    /// (blob_hash, base64, media_type)
    fn load_image(&self, image_id: &str) -> Result<(String, String, String)> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        // 从 resources 表查询图片资源
        // 支持两种情况：
        // 1. type = 'image' (独立图片资源)
        // 2. type = 'file' 且 mime_type LIKE 'image/%' (文件附件中的图片)
        let (blob_hash, mime_type): (String, String) = conn
            .query_row(
                r#"
            SELECT r.hash, COALESCE(a.mime_type, 'image/png') as mime_type
            FROM resources r
            LEFT JOIN files f ON a.resource_id = r.id
            WHERE r.id = ?1
              AND (r.type = 'image' OR (r.type = 'file' AND a.mime_type LIKE 'image/%'))
            "#,
                params![image_id],
                |row| {
                    let hash: String = row.get(0)?;
                    let mime: String = row.get(1)?;
                    Ok((hash, mime))
                },
            )
            .map_err(|e| {
                AppError::not_found(format!("图片资源不存在或类型不匹配: {} ({})", image_id, e))
            })?;

        // 加载图片内容
        let blob_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, self.vfs_db.blobs_dir(), &blob_hash)
                .map_err(|e| AppError::database(format!("获取 Blob 路径失败: {}", e)))?
                .ok_or_else(|| AppError::not_found(format!("图片 Blob 不存在: {}", blob_hash)))?;

        let data = std::fs::read(&blob_path)
            .map_err(|e| AppError::file_system(format!("读取图片文件失败: {}", e)))?;

        let base64 = BASE64.encode(&data);

        log::debug!(
            "  📷 加载图片: id={}, hash={}, mime={}, size={}KB",
            image_id,
            blob_hash,
            mime_type,
            data.len() / 1024
        );

        Ok((blob_hash, base64, mime_type))
    }

    /// 设置资源的多模态索引状态
    ///
    /// 更新对应资源表的 mm_index_state 字段
    fn set_mm_index_state(
        &self,
        source_type: SourceType,
        source_id: &str,
        state: &str,
        error: Option<&str>,
    ) {
        let conn = match self.vfs_db.get_conn_safe() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("  ⚠️ 设置 mm_index_state 失败: {}", e);
                return;
            }
        };

        let result = match source_type {
            SourceType::Textbook => conn.execute(
                "UPDATE textbooks SET mm_index_state = ?1, mm_index_error = ?2 WHERE id = ?3",
                params![state, error, source_id],
            ),
            SourceType::Attachment => conn.execute(
                "UPDATE files SET mm_index_state = ?1, mm_index_error = ?2 WHERE id = ?3",
                params![state, error, source_id],
            ),
            SourceType::Exam => conn.execute(
                "UPDATE exam_sheets SET mm_index_state = ?1, mm_index_error = ?2 WHERE id = ?3",
                params![state, error, source_id],
            ),
            SourceType::Image => conn.execute(
                "UPDATE resources SET mm_index_state = ?1, mm_index_error = ?2 WHERE id = ?3",
                params![state, error, source_id],
            ),
            _ => Ok(0),
        };

        if let Err(e) = result {
            log::warn!("  ⚠️ 设置 mm_index_state 失败: {}", e);
        } else {
            log::debug!(
                "  📝 设置 {}:{} mm_index_state = {}",
                source_type.as_str(),
                source_id,
                state
            );

            // ★ 同步 resources.mm_index_state，避免状态漂移
            let resource_id: Option<String> = match source_type {
                SourceType::Textbook => conn
                    .query_row(
                        "SELECT resource_id FROM files WHERE id = ?1",
                        params![source_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .ok()
                    .and_then(|value| value.flatten()),
                SourceType::Exam => conn
                    .query_row(
                        "SELECT resource_id FROM exam_sheets WHERE id = ?1",
                        params![source_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .ok()
                    .and_then(|value| value.flatten()),
                SourceType::Attachment => conn
                    .query_row(
                        "SELECT resource_id FROM files WHERE id = ?1",
                        params![source_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .ok()
                    .and_then(|value| value.flatten()),
                SourceType::Image => None,
                SourceType::Note => None,
            };

            if let Some(res_id) = resource_id {
                if let Err(e) = conn.execute(
                    "UPDATE resources SET mm_index_state = ?1, mm_index_error = ?2 WHERE id = ?3",
                    params![state, error, res_id],
                ) {
                    log::warn!("  ⚠️ 同步 resources.mm_index_state 失败: {}", e);
                }
            }
        }
    }

    /// 更新资源的索引状态
    ///
    /// 多模态索引完成后，更新对应资源的 `index_state` 为 `indexed`，
    /// 以便前端正确显示索引状态。
    fn update_resource_index_state(&self, source_type: SourceType, source_id: &str) -> Result<()> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        // 根据 source_type 获取对应的 resource_id
        let resource_id: Option<String> = match source_type {
            SourceType::Textbook => {
                // 教材：从 textbooks 表获取 resource_id
                conn.query_row(
                    "SELECT resource_id FROM files WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询教材 resource_id 失败: {}", e)))?
                .flatten()
            }
            SourceType::Exam => {
                // 题目集识别：从 exam_sheets 表获取 resource_id
                conn.query_row(
                    "SELECT resource_id FROM exam_sheets WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询题目集识别 resource_id 失败: {}", e)))?
                .flatten()
            }
            SourceType::Attachment => {
                // 附件：从 files 表获取 resource_id
                conn.query_row(
                    "SELECT resource_id FROM files WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询附件 resource_id 失败: {}", e)))?
                .flatten()
            }
            SourceType::Image => {
                // 图片：source_id 就是 resource_id
                Some(source_id.to_string())
            }
            SourceType::Note => {
                // 笔记：从 notes 表获取 resource_id
                conn.query_row(
                    "SELECT resource_id FROM notes WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询笔记 resource_id 失败: {}", e)))?
                .flatten()
            }
        };

        if let Some(res_id) = resource_id {
            let resource_hash: Option<String> = conn
                .query_row(
                    "SELECT hash FROM resources WHERE id = ?1",
                    params![res_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询资源 hash 失败: {}", e)))?
                .flatten();

            // 更新资源的 index_state + index_hash（避免 isStale 误判）
            VfsIndexStateRepo::set_index_state_with_conn(
                &conn,
                &res_id,
                INDEX_STATE_INDEXED,
                resource_hash.as_deref(),
                None, // error 可选
            )
            .map_err(|e| AppError::database(format!("更新资源索引状态失败: {}", e)))?;

            log::info!("  ✅ 已更新资源 {} 的索引状态为 indexed", res_id);
        } else {
            log::debug!(
                "  ℹ️ 未找到 {}:{} 的 resource_id，跳过状态更新",
                source_type.as_str(),
                source_id
            );
        }

        Ok(())
    }

    fn update_resource_mm_index_meta(
        &self,
        source_type: SourceType,
        source_id: &str,
        dim: i32,
        indexing_mode: &str,
        indexed_at: &str,
    ) -> Result<()> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        let resource_id: Option<String> = match source_type {
            SourceType::Textbook => conn
                .query_row(
                    "SELECT resource_id FROM files WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询教材 resource_id 失败: {}", e)))?
                .flatten(),
            SourceType::Exam => conn
                .query_row(
                    "SELECT resource_id FROM exam_sheets WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询题目集识别 resource_id 失败: {}", e)))?
                .flatten(),
            SourceType::Attachment => conn
                .query_row(
                    "SELECT resource_id FROM files WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询附件 resource_id 失败: {}", e)))?
                .flatten(),
            SourceType::Image => Some(source_id.to_string()),
            SourceType::Note => conn
                .query_row(
                    "SELECT resource_id FROM notes WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| AppError::database(format!("查询笔记 resource_id 失败: {}", e)))?
                .flatten(),
        };

        let Some(resource_id) = resource_id else {
            return Ok(());
        };

        let indexed_at_ms = chrono::DateTime::parse_from_rfc3339(indexed_at)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or_else(|e| {
                log::warn!(
                    "[PageIndexer] Failed to parse indexed_at '{}': {}, using epoch fallback",
                    indexed_at,
                    e
                );
                0_i64
            });

        // 更新 resources 表的多模态索引元数据和状态
        conn.execute(
            "UPDATE resources SET mm_embedding_dim = ?1, mm_indexing_mode = ?2, mm_indexed_at = ?3, mm_index_state = 'indexed', updated_at = ?4 WHERE id = ?5",
            params![dim, indexing_mode, indexed_at_ms, indexed_at_ms, resource_id],
        )
        .map_err(|e| AppError::database(format!("更新资源多模态索引元数据失败: {}", e)))?;

        // 同时更新对应子表的 mm_index_state
        match source_type {
            SourceType::Textbook => {
                conn.execute(
                    "UPDATE textbooks SET mm_index_state = 'indexed' WHERE id = ?1",
                    params![source_id],
                )
                .ok();
            }
            SourceType::Attachment => {
                conn.execute(
                    "UPDATE files SET mm_index_state = 'indexed' WHERE id = ?1",
                    params![source_id],
                )
                .ok();
            }
            SourceType::Exam => {
                conn.execute(
                    "UPDATE exam_sheets SET mm_index_state = 'indexed' WHERE id = ?1",
                    params![source_id],
                )
                .ok();
            }
            _ => {}
        }

        Ok(())
    }
}

/// 题目集识别记录（内部使用）
struct ExamRecord {
    #[allow(dead_code)]
    id: String,
    preview_json: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_infer_media_type() {
        assert_eq!(
            PageIndexer::infer_media_type(Path::new("test.jpg")),
            "image/jpeg"
        );
        assert_eq!(
            PageIndexer::infer_media_type(Path::new("test.png")),
            "image/png"
        );
        assert_eq!(
            PageIndexer::infer_media_type(Path::new("test.webp")),
            "image/webp"
        );
        assert_eq!(
            PageIndexer::infer_media_type(Path::new("test.unknown")),
            "image/png"
        );
    }

    #[test]
    fn test_extract_ocr_text_empty() {
        let cards: Vec<ExamCardPreview> = vec![];
        assert!(PageIndexer::extract_ocr_text_from_cards(&cards).is_none());
    }

    /// 测试 TextbookPreview 能正确解析 camelCase 格式的 JSON（PdfPreviewJson 格式）
    #[test]
    fn test_textbook_preview_camel_case_parsing() {
        // 这是 PdfPreviewJson 序列化出来的实际格式
        let json = r#"{
            "pages": [
                {"pageIndex": 0, "blobHash": "abc123", "width": 100, "height": 200, "mimeType": "image/png"},
                {"pageIndex": 1, "blobHash": "def456", "width": 100, "height": 200, "mimeType": "image/png"}
            ],
            "renderDpi": 150,
            "totalPages": 2,
            "renderedAt": "2026-01-16T12:00:00Z"
        }"#;

        let result: std::result::Result<TextbookPreview, serde_json::Error> =
            serde_json::from_str(json);
        assert!(
            result.is_ok(),
            "Failed to parse camelCase JSON: {:?}",
            result.err()
        );

        let preview = result.unwrap();
        assert_eq!(preview.pages.len(), 2);
        assert_eq!(preview.pages[0].page_index, 0);
        assert_eq!(preview.pages[0].blob_hash, Some("abc123".to_string()));
        assert_eq!(preview.pages[1].page_index, 1);
        assert_eq!(preview.dpi, Some(150));
        assert_eq!(preview.page_count, Some(2));
    }
}
