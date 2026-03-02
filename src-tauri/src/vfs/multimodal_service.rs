//! VFS 多模态嵌入服务
//!
//! ★ 2026-01: 统一多模态数据管理，将多模态向量存入 VFS 管理的 Lance 表。
//!
//! ## 设计要点
//!
//! - **统一存储**：多模态向量存入 `vfs_emb_multimodal_{dim}` 表
//! - **复用基础设施**：复用现有 MultimodalEmbeddingService 生成向量
//! - **兼容迁移**：支持从旧 `mm_pages_v2_*` 表迁移数据
//!
//! ## 与旧 multimodal 模块的差异
//! - 旧模块：`mm_pages_v2_vl_d{dim}` / `mm_pages_v2_text_d{dim}`
//! - 新模块：`vfs_emb_multimodal_{dim}`（统一命名）

use rusqlite::OptionalExtension;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::database::Database;
use crate::llm_manager::LLMManager;
use crate::multimodal::embedding_service::MultimodalEmbeddingService;
use crate::multimodal::page_indexer::AttachmentPreview;
use crate::multimodal::types::{IndexProgressEvent, MultimodalInput};
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::lance_store::{VfsLanceRow, VfsLanceStore};
use crate::vfs::repos::{embedding_dim_repo, VfsBlobRepo, MODALITY_MULTIMODAL};

// ============================================================================
// 类型定义
// ============================================================================

/// 多模态页面数据
#[derive(Debug, Clone)]
pub struct VfsMultimodalPage {
    /// 页面索引（0-based）
    pub page_index: i32,
    /// 图片 Base64 数据
    pub image_base64: Option<String>,
    /// 图片 MIME 类型
    pub image_mime: Option<String>,
    /// OCR 文本或 VLM 摘要
    pub text_content: Option<String>,
    /// 图片 Blob 哈希（用于加载原图）
    pub blob_hash: Option<String>,
}

/// 多模态索引结果
#[derive(Debug, Clone)]
pub struct VfsMultimodalIndexResult {
    /// 成功索引的页面数
    pub indexed_pages: usize,
    /// 向量维度
    pub dimension: usize,
    /// 失败的页面索引列表
    pub failed_pages: Vec<i32>,
}

/// 多模态检索结果
#[derive(Debug, Clone)]
pub struct VfsMultimodalSearchResult {
    /// 资源 ID
    pub resource_id: String,
    /// 资源类型
    pub resource_type: String,
    /// 页面索引
    pub page_index: i32,
    /// 文本内容（OCR 或摘要）
    pub text_content: Option<String>,
    /// 图片 Blob 哈希
    pub blob_hash: Option<String>,
    /// 相关度分数
    pub score: f32,
    /// 文件夹 ID
    pub folder_id: Option<String>,
}

// ============================================================================
// VfsMultimodalService 实现
// ============================================================================

/// VFS 多模态嵌入服务
///
/// 统一管理多模态向量的生成、存储和检索。
pub struct VfsMultimodalService {
    vfs_db: Arc<VfsDatabase>,
    llm_manager: Arc<LLMManager>,
    lance_store: Arc<VfsLanceStore>,
    embedding_service: MultimodalEmbeddingService,
}

impl VfsMultimodalService {
    /// 创建新的多模态服务实例
    pub fn new(
        vfs_db: Arc<VfsDatabase>,
        llm_manager: Arc<LLMManager>,
        lance_store: Arc<VfsLanceStore>,
    ) -> Self {
        let embedding_service = MultimodalEmbeddingService::new(Arc::clone(&llm_manager));
        Self {
            vfs_db,
            llm_manager,
            lance_store,
            embedding_service,
        }
    }

    /// 检查多模态嵌入模型是否已配置
    pub async fn is_configured(&self) -> bool {
        self.embedding_service.is_configured().await
    }

    /// 索引资源的多模态页面
    ///
    /// ## 参数
    /// - `resource_id`: VFS 资源 ID
    /// - `resource_type`: 资源类型（textbook/exam/image 等）
    /// - `folder_id`: 可选的文件夹 ID
    /// - `pages`: 待索引的页面列表
    ///
    /// ## 返回
    /// 索引结果，包含成功/失败的页面数
    pub async fn index_resource_pages(
        &self,
        resource_id: &str,
        resource_type: &str,
        folder_id: Option<&str>,
        pages: Vec<VfsMultimodalPage>,
    ) -> VfsResult<VfsMultimodalIndexResult> {
        self.index_resource_pages_with_progress(resource_id, resource_type, folder_id, pages, None)
            .await
    }

    /// 索引资源的多模态页面（带进度回调）
    pub async fn index_resource_pages_with_progress(
        &self,
        resource_id: &str,
        resource_type: &str,
        folder_id: Option<&str>,
        pages: Vec<VfsMultimodalPage>,
        progress_tx: Option<mpsc::UnboundedSender<IndexProgressEvent>>,
    ) -> VfsResult<VfsMultimodalIndexResult> {
        if pages.is_empty() {
            return Ok(VfsMultimodalIndexResult {
                indexed_pages: 0,
                dimension: 0,
                failed_pages: vec![],
            });
        }

        info!(
            "[VfsMultimodalService] Indexing {} pages for resource {} (type={})",
            pages.len(),
            resource_id,
            resource_type
        );

        // 1. 检查模型配置
        if !self.is_configured().await {
            return Err(VfsError::Other(
                "未配置多模态嵌入模型，请在设置中配置 VL Embedding 模型".to_string(),
            ));
        }

        // 2. 准备多模态输入
        let mut inputs: Vec<(i32, MultimodalInput)> = Vec::new();
        let mut failed_pages: Vec<i32> = Vec::new();

        for page in &pages {
            let input = if let (Some(base64), Some(mime)) = (&page.image_base64, &page.image_mime) {
                // 有图片数据：使用图文混合输入
                if let Some(text) = &page.text_content {
                    MultimodalInput::text_and_image(text, base64, mime)
                } else {
                    MultimodalInput::image_base64(base64, mime)
                }
            } else if let Some(text) = &page.text_content {
                // 只有文本：使用纯文本输入
                MultimodalInput::text(text)
            } else {
                // 无有效内容
                warn!(
                    "[VfsMultimodalService] Page {} has no valid content, skipping",
                    page.page_index
                );
                failed_pages.push(page.page_index);
                continue;
            };

            inputs.push((page.page_index, input));
        }

        if inputs.is_empty() {
            return Ok(VfsMultimodalIndexResult {
                indexed_pages: 0,
                dimension: 0,
                failed_pages,
            });
        }

        // 3. 批量生成嵌入向量（带进度回调）
        let mm_inputs: Vec<MultimodalInput> = inputs.iter().map(|(_, i)| i.clone()).collect();
        let total_pages = pages.len() as i32;
        let skipped_pages = failed_pages.len() as i32;
        let embed_progress_tx = if progress_tx.is_some() {
            let (tx, mut rx) = mpsc::unbounded_channel::<
                crate::multimodal::embedding_service::EmbeddingProgress,
            >();
            let progress_tx = progress_tx.clone();
            let source_type = resource_type.to_string();
            let source_id = resource_id.to_string();
            let total_pages = total_pages;
            let skipped_pages = skipped_pages;
            tokio::spawn(async move {
                if let Some(progress_tx) = progress_tx {
                    while let Some(progress) = rx.recv().await {
                        let phase = if progress.phase == "summarizing" {
                            "summarizing"
                        } else {
                            "embedding"
                        };
                        let completed = progress.completed as i32;
                        let current = (completed + skipped_pages).min(total_pages);
                        let event = IndexProgressEvent::new(&source_type, &source_id, total_pages)
                            .with_phase(phase, &progress.message)
                            .with_progress(current, completed, skipped_pages);
                        let _ = progress_tx.send(event);
                    }
                }
            });
            Some(tx)
        } else {
            None
        };

        let embeddings = self
            .embedding_service
            .embed_batch_with_progress(&mm_inputs, embed_progress_tx)
            .await
            .map_err(|e| VfsError::Other(format!("多模态嵌入生成失败: {}", e)))?;

        if embeddings.is_empty() {
            return Err(VfsError::Other("多模态嵌入 API 返回空结果".to_string()));
        }

        let dimension = embeddings.first().map(|v| v.len()).unwrap_or(0);

        // 4. 构建 Lance 行并存储
        let now = chrono::Utc::now().to_rfc3339();
        let mut rows: Vec<VfsLanceRow> = Vec::new();
        let page_map: HashMap<i32, &VfsMultimodalPage> =
            pages.iter().map(|page| (page.page_index, page)).collect();
        let folder_id = folder_id.map(String::from);

        for ((page_index, _), embedding) in inputs.iter().zip(embeddings.into_iter()) {
            let page = page_map
                .get(page_index)
                .ok_or_else(|| VfsError::Other(format!("页面索引不存在: {}", page_index)))?;

            let metadata = serde_json::json!({
                "page_index": page_index,
                "blob_hash": page.blob_hash,
                "source_id": resource_id,
            });

            rows.push(VfsLanceRow {
                embedding_id: format!("{}_mm_p{}", resource_id, page_index),
                resource_id: resource_id.to_string(),
                resource_type: resource_type.to_string(),
                folder_id: folder_id.clone(),
                chunk_index: *page_index,
                text: page.text_content.clone().unwrap_or_default(),
                metadata_json: Some(metadata.to_string()),
                created_at: now.clone(),
                embedding,
            });
        }

        // 5. 无空窗替换：先按 embedding_id 写入，再按页面索引清理陈旧向量
        // - write_chunks 内部会按 embedding_id 先删后写，确保同页向量被更新
        // - 写入成功后再删除 "不在当前页面集合" 的历史行，避免先删后写的空窗
        self.lance_store
            .write_chunks(MODALITY_MULTIMODAL, &rows)
            .await?;

        // 清理旧维度表中的历史向量，避免跨维度残留污染检索。
        if let Err(e) = self
            .lance_store
            .delete_by_resource_except_dim(MODALITY_MULTIMODAL, resource_id, dimension)
            .await
        {
            warn!(
                "[VfsMultimodalService] Failed to cleanup stale multimodal dims for {}: {}",
                resource_id, e
            );
        }

        // 清理已不属于当前页面集合的旧向量（如页数减少）
        // 失败时保留已写入的新数据，仅记录告警，避免把本次索引整体判定为失败。
        let table = self
            .lance_store
            .ensure_table(MODALITY_MULTIMODAL, dimension)
            .await?;
        let keep_page_indices = rows
            .iter()
            .map(|r| r.chunk_index.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let escaped_resource_id = resource_id.replace('\'', "''");
        let cleanup_expr = format!(
            "resource_id = '{}' AND chunk_index NOT IN ({})",
            escaped_resource_id, keep_page_indices
        );
        if let Err(e) = table.delete(cleanup_expr.as_str()).await {
            warn!(
                "[VfsMultimodalService] Failed to cleanup stale multimodal rows for {}: {}",
                resource_id, e
            );
        }

        let count = rows.len();

        // 6. 更新维度统计
        // ★ 审计修复：统一使用 embedding_dim_repo（替代已废弃的 VfsDimensionRepo）
        {
            let conn = self.vfs_db.get_conn()?;
            embedding_dim_repo::register(&conn, dimension as i32, MODALITY_MULTIMODAL)?;
            embedding_dim_repo::increment_count(
                &conn,
                dimension as i32,
                MODALITY_MULTIMODAL,
                count as i64,
            )?;
        }

        info!(
            "[VfsMultimodalService] Successfully indexed {} pages for resource {} (dim={})",
            count, resource_id, dimension
        );

        if let Some(progress_tx) = progress_tx {
            let total_pages = pages.len() as i32;
            let event = IndexProgressEvent::new(resource_type, resource_id, total_pages)
                .with_phase("saving", "正在保存索引...")
                .with_progress(total_pages, count as i32, failed_pages.len() as i32);
            let _ = progress_tx.send(event);
        }

        Ok(VfsMultimodalIndexResult {
            indexed_pages: count,
            dimension,
            failed_pages,
        })
    }

    /// 多模态向量检索
    ///
    /// ## 参数
    /// - `query`: 查询文本
    /// - `top_k`: 返回的最大结果数
    /// - `folder_ids`: 可选的文件夹 ID 过滤
    /// - `resource_types`: 可选的资源类型过滤
    pub async fn search(
        &self,
        query: &str,
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsMultimodalSearchResult>> {
        self.search_full(query, top_k, folder_ids, None, resource_types)
            .await
    }

    /// 🔧 批判性检查修复：支持 resource_ids 过滤的完整搜索方法
    pub async fn search_full(
        &self,
        query: &str,
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsMultimodalSearchResult>> {
        // 1. 检查模型配置
        if !self.is_configured().await {
            return Err(VfsError::Other("未配置多模态嵌入模型".to_string()));
        }

        // 2. 生成查询向量
        let query_input = MultimodalInput::text(query);
        let query_embedding = self
            .embedding_service
            .embed_single(&query_input)
            .await
            .map_err(|e| VfsError::Other(format!("查询向量生成失败: {}", e)))?;

        // 3. 执行向量检索（使用支持 resource_ids 的完整方法）
        let lance_results = self
            .lance_store
            .vector_search_full(
                MODALITY_MULTIMODAL,
                &query_embedding,
                top_k,
                folder_ids,
                resource_ids,
                resource_types,
            )
            .await?;

        // 4. 转换结果
        let results: Vec<VfsMultimodalSearchResult> = lance_results
            .into_iter()
            .map(|r| {
                VfsMultimodalSearchResult {
                    resource_id: r.resource_id,
                    resource_type: r.resource_type,
                    page_index: r.page_index.unwrap_or(r.chunk_index),
                    text_content: Some(r.text),
                    blob_hash: r.source_id, // source_id 存储的是 blob_hash
                    score: r.score,
                    folder_id: r.folder_id,
                }
            })
            .collect();

        Ok(results)
    }

    /// 删除资源的多模态索引
    ///
    /// ★ 审计修复：删除后刷新 record_count
    pub async fn delete_resource_index(&self, resource_id: &str) -> VfsResult<()> {
        self.lance_store
            .delete_by_resource(MODALITY_MULTIMODAL, resource_id)
            .await?;

        // ★ 审计修复：刷新 record_count，防止删除后计数漂移
        if let Ok(conn) = self.vfs_db.get_conn() {
            if let Err(e) = embedding_dim_repo::refresh_counts_from_segments(&conn) {
                warn!(
                    "[VfsMultimodalService] Failed to refresh counts after deleting {}: {}",
                    resource_id, e
                );
            }
        }

        info!(
            "[VfsMultimodalService] Deleted multimodal index for resource {}",
            resource_id
        );

        Ok(())
    }

    /// 获取多模态索引统计信息
    pub async fn get_stats(&self) -> VfsResult<VfsMultimodalStats> {
        // ★ 审计修复：统一使用 embedding_dim_repo（替代已废弃的 VfsDimensionRepo）
        let conn = self.vfs_db.get_conn()?;
        let dims = embedding_dim_repo::list_by_modality(&conn, MODALITY_MULTIMODAL)?;
        drop(conn);

        let mm_dims = &dims;

        let total_records: i64 = mm_dims.iter().map(|d| d.record_count).sum();
        let dimensions: Vec<i32> = mm_dims.iter().map(|d| d.dimension).collect();

        Ok(VfsMultimodalStats {
            total_records: total_records as usize,
            dimensions,
        })
    }

    /// 按资源类型和 ID 索引资源（兼容旧 API）
    ///
    /// ★ 2026-01: 兼容 mm_index_resource 的 VFS 版本
    /// ★ 2026-01 修复: 从业务表 (textbooks/exam_sheets/attachments) 读取 preview_json
    ///
    /// ## 参数
    /// - `_main_db`: 主数据库（保留用于将来扩展）
    /// - `source_type`: 资源类型（exam/textbook/attachment/image）
    /// - `source_id`: 资源业务 ID
    /// - `folder_id`: 可选的文件夹 ID
    /// - `_force_rebuild`: 是否强制重建索引
    ///
    /// ## 流程
    /// 1. 根据 source_type 从对应业务表获取 preview_json
    /// 2. 从 Blob 文件加载图片数据
    /// 3. 调用 index_resource_pages 生成向量
    /// 4. 更新业务表的多模态索引状态
    pub async fn index_resource_by_source(
        &self,
        _main_db: Arc<Database>,
        source_type: &str,
        source_id: &str,
        folder_id: Option<&str>,
        _force_rebuild: bool,
    ) -> VfsResult<VfsMultimodalIndexResult> {
        self.index_resource_by_source_with_progress(
            _main_db,
            source_type,
            source_id,
            folder_id,
            _force_rebuild,
            None,
        )
        .await
    }

    /// 按资源类型和 ID 索引资源（带进度回调）
    pub async fn index_resource_by_source_with_progress(
        &self,
        _main_db: Arc<Database>,
        source_type: &str,
        source_id: &str,
        folder_id: Option<&str>,
        _force_rebuild: bool,
        progress_tx: Option<mpsc::UnboundedSender<IndexProgressEvent>>,
    ) -> VfsResult<VfsMultimodalIndexResult> {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        use rusqlite::params;

        info!(
            "[VfsMultimodalService] index_resource_by_source: type={}, id={}",
            source_type, source_id
        );

        let conn = self.vfs_db.get_conn_safe()?;

        // 1. 根据 source_type 从对应业务表获取 preview_json 和 resource_id
        let (preview_json_str, resource_id): (Option<String>, Option<String>) = match source_type {
            "textbook" => conn
                .query_row(
                    "SELECT preview_json, resource_id FROM files WHERE id = ?1",
                    params![source_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()?
                .unwrap_or((None, None)),
            "exam" => conn
                .query_row(
                    "SELECT preview_json, resource_id FROM exam_sheets WHERE id = ?1",
                    params![source_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()?
                .unwrap_or((None, None)),
            "attachment" | "image" | "file" => conn
                .query_row(
                    "SELECT preview_json, resource_id FROM files WHERE id = ?1",
                    params![source_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()?
                .unwrap_or((None, None)),
            _ => {
                warn!(
                    "[VfsMultimodalService] Unsupported source_type: {}",
                    source_type
                );
                (None, None)
            }
        };

        let resource_id = resource_id.ok_or_else(|| VfsError::NotFound {
            resource_type: source_type.to_string(),
            id: source_id.to_string(),
        })?;

        // 2. 解析 preview_json 并提取页面
        let pages = if let Some(json_str) = preview_json_str {
            let preview: AttachmentPreview = serde_json::from_str(&json_str)
                .map_err(|e| VfsError::Other(format!("Failed to parse preview_json: {}", e)))?;

            let mut extracted_pages = Vec::with_capacity(preview.pages.len());

            for page_preview in &preview.pages {
                let blob_hash = match &page_preview.blob_hash {
                    Some(hash) => hash,
                    None => continue,
                };

                // 从 VFS Blob 获取文件路径并读取数据
                let blob_path = match VfsBlobRepo::get_blob_path(&self.vfs_db, blob_hash)? {
                    Some(p) => p,
                    None => {
                        warn!("[VfsMultimodalService] Blob path not found: {}", blob_hash);
                        continue;
                    }
                };

                // 读取文件内容
                let blob_data = match tokio::fs::read(&blob_path).await {
                    Ok(data) => data,
                    Err(e) => {
                        warn!(
                            "[VfsMultimodalService] Failed to read blob file {:?}: {}",
                            blob_path, e
                        );
                        continue;
                    }
                };

                let image_base64 = BASE64.encode(&blob_data);
                let mime_type = page_preview
                    .mime_type
                    .clone()
                    .unwrap_or_else(|| "image/png".to_string());

                extracted_pages.push(VfsMultimodalPage {
                    page_index: page_preview.page_index as i32,
                    image_base64: Some(image_base64),
                    image_mime: Some(mime_type),
                    text_content: None,
                    blob_hash: Some(blob_hash.clone()),
                });
            }

            extracted_pages
        } else if source_type == "image" {
            // ★ T01 修复: 图片类型没有 preview_json 时，直接使用原图作为单页索引
            // 查询 blob_hash 和 mime_type
            let image_info: (Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT blob_hash, mime_type FROM files WHERE id = ?1",
                    params![source_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()?
                .unwrap_or((None, None));

            if let (Some(blob_hash), mime_type) = image_info {
                // 从 VFS Blob 获取文件路径并读取数据
                match VfsBlobRepo::get_blob_path(&self.vfs_db, &blob_hash)? {
                    Some(blob_path) => match tokio::fs::read(&blob_path).await {
                        Ok(blob_data) => {
                            let image_base64 = BASE64.encode(&blob_data);
                            let mime = mime_type.unwrap_or_else(|| "image/png".to_string());
                            info!(
                                    "[VfsMultimodalService] Image fallback: using blob_hash={} for single-page index",
                                    blob_hash
                                );
                            vec![VfsMultimodalPage {
                                page_index: 0,
                                image_base64: Some(image_base64),
                                image_mime: Some(mime),
                                text_content: None,
                                blob_hash: Some(blob_hash),
                            }]
                        }
                        Err(e) => {
                            warn!(
                                "[VfsMultimodalService] Failed to read image blob file: {}",
                                e
                            );
                            vec![]
                        }
                    },
                    None => {
                        warn!(
                            "[VfsMultimodalService] Image blob_hash not found in blobs: {}",
                            blob_hash
                        );
                        vec![]
                    }
                }
            } else {
                warn!(
                    "[VfsMultimodalService] Image {} has no blob_hash, cannot index",
                    source_id
                );
                vec![]
            }
        } else {
            warn!(
                "[VfsMultimodalService] Resource {} has no preview_json in business table",
                source_id
            );
            vec![]
        };

        if let Some(progress_tx) = progress_tx.as_ref() {
            let event = IndexProgressEvent::new(source_type, source_id, pages.len() as i32)
                .with_phase("preparing", "准备多模态索引...")
                .with_progress(0, 0, 0);
            let _ = progress_tx.send(event);
        }

        if pages.is_empty() {
            warn!(
                "[VfsMultimodalService] No pages found for resource {} (type={})",
                source_id, source_type
            );
            // 标记为 disabled（无可索引内容）
            Self::update_mm_index_state_in_business_table(
                &conn,
                source_type,
                source_id,
                "disabled",
                None,
                0,
                0,
            )?;
            if let Some(progress_tx) = progress_tx.as_ref() {
                let event = IndexProgressEvent::new(source_type, source_id, 0)
                    .with_phase("completed", "无可索引内容")
                    .with_progress(0, 0, 0);
                let _ = progress_tx.send(event);
            }
            return Ok(VfsMultimodalIndexResult {
                indexed_pages: 0,
                dimension: 0,
                failed_pages: vec![],
            });
        }

        // 3. 标记为 indexing
        Self::update_mm_index_state_in_business_table(
            &conn,
            source_type,
            source_id,
            "indexing",
            None,
            0,
            0,
        )?;

        // 4. 调用 index_resource_pages
        let result = self
            .index_resource_pages_with_progress(
                &resource_id,
                source_type,
                folder_id,
                pages.clone(),
                progress_tx.clone(),
            )
            .await;

        // 5. 根据结果更新状态
        match &result {
            Ok(index_result) => {
                // 构建已索引页面的 JSON
                let indexed_pages_json = if index_result.indexed_pages > 0 {
                    let now = chrono::Utc::now().to_rfc3339();
                    let page_metas: Vec<serde_json::Value> = pages
                        .iter()
                        .filter(|page| !index_result.failed_pages.contains(&page.page_index))
                        .map(|page| {
                            serde_json::json!({
                                "page_index": page.page_index,
                                "blob_hash": page.blob_hash,
                                "embedding_dim": index_result.dimension,
                                "indexing_mode": "vl_embedding",
                                "indexed_at": now,
                            })
                        })
                        .collect();
                    Some(serde_json::to_string(&page_metas).unwrap_or_default())
                } else {
                    None
                };

                Self::update_mm_index_state_in_business_table(
                    &conn,
                    source_type,
                    source_id,
                    "indexed",
                    indexed_pages_json.as_deref(),
                    index_result.dimension as i32,
                    index_result.indexed_pages as i32,
                )?;

                if let Some(progress_tx) = progress_tx.as_ref() {
                    let total_pages = pages.len() as i32;
                    let event = IndexProgressEvent::new(source_type, source_id, total_pages)
                        .with_phase(
                            "completed",
                            &format!("索引完成: {} 页", index_result.indexed_pages),
                        )
                        .with_progress(
                            total_pages,
                            index_result.indexed_pages as i32,
                            index_result.failed_pages.len() as i32,
                        );
                    let _ = progress_tx.send(event);
                }
            }
            Err(e) => {
                Self::update_mm_index_state_in_business_table(
                    &conn,
                    source_type,
                    source_id,
                    "failed",
                    Some(&e.to_string()),
                    0,
                    0,
                )?;

                if let Some(progress_tx) = progress_tx.as_ref() {
                    let event = IndexProgressEvent::new(source_type, source_id, pages.len() as i32)
                        .with_phase("failed", &e.to_string())
                        .with_progress(0, 0, 0);
                    let _ = progress_tx.send(event);
                }
            }
        }

        result
    }

    /// 更新业务表中的多模态索引状态
    ///
    /// ★ 2026-01 新增: 统一更新 mm_index_state, mm_indexed_pages_json
    /// ★ 注意: textbooks/attachments 表没有 mm_embedding_dim/mm_indexed_at 列
    ///        只有 exam_sheets 有这些列
    fn update_mm_index_state_in_business_table(
        conn: &rusqlite::Connection,
        source_type: &str,
        source_id: &str,
        state: &str,
        indexed_pages_json_or_error: Option<&str>,
        _embedding_dim: i32,
        indexed_count: i32,
    ) -> VfsResult<()> {
        use rusqlite::params;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        // ★ 批判性检查修复: 根据不同表的实际列结构选择 SQL
        // - textbooks: mm_index_state, mm_index_error, mm_indexed_pages_json (无 mm_embedding_dim/mm_indexed_at)
        // - files: mm_index_state, mm_index_error, mm_indexed_pages_json (无 mm_embedding_dim/mm_indexed_at)
        // - exam_sheets: mm_index_state, mm_index_error, mm_indexed_pages_json, mm_embedding_dim, mm_indexed_at

        let log_table = match source_type {
            "textbook" => "files", // ★ 修复: textbooks 表已重命名为 files
            "exam" => "exam_sheets",
            "attachment" | "image" | "file" => "files",
            _ => return Ok(()),
        };

        let updated = match (source_type, state) {
            // files 表 (textbooks 已重命名为 files)
            ("textbook", "indexed") => conn.execute(
                "UPDATE files SET mm_index_state = ?1, mm_indexed_pages_json = ?2, updated_at = ?3 WHERE id = ?4",
                params![state, indexed_pages_json_or_error, now, source_id],
            )?,
            ("textbook", "failed") => conn.execute(
                "UPDATE files SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4",
                params![state, indexed_pages_json_or_error, now, source_id],
            )?,
            ("textbook", _) => conn.execute(
                "UPDATE files SET mm_index_state = ?1, updated_at = ?2 WHERE id = ?3",
                params![state, now, source_id],
            )?,

            // exam_sheets 表 (有 mm_embedding_dim 和 mm_indexed_at)
            ("exam", "indexed") => conn.execute(
                "UPDATE exam_sheets SET mm_index_state = ?1, mm_indexed_pages_json = ?2, mm_embedding_dim = ?3, mm_indexed_at = ?4, updated_at = ?4 WHERE id = ?5",
                params![state, indexed_pages_json_or_error, _embedding_dim, now, source_id],
            )?,
            ("exam", "failed") => conn.execute(
                "UPDATE exam_sheets SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4",
                params![state, indexed_pages_json_or_error, now, source_id],
            )?,
            ("exam", _) => conn.execute(
                "UPDATE exam_sheets SET mm_index_state = ?1, updated_at = ?2 WHERE id = ?3",
                params![state, now, source_id],
            )?,

            // files 表
            ("attachment" | "image" | "file", "indexed") => conn.execute(
                "UPDATE files SET mm_index_state = ?1, mm_indexed_pages_json = ?2, updated_at = ?3 WHERE id = ?4",
                params![state, indexed_pages_json_or_error, now, source_id],
            )?,
            ("attachment" | "image" | "file", "failed") => conn.execute(
                "UPDATE files SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4",
                params![state, indexed_pages_json_or_error, now, source_id],
            )?,
            ("attachment" | "image" | "file", _) => conn.execute(
                "UPDATE files SET mm_index_state = ?1, updated_at = ?2 WHERE id = ?3",
                params![state, now, source_id],
            )?,

            _ => return Ok(()),
        };

        if updated > 0 {
            info!(
                "[VfsMultimodalService] Updated mm_index_state in {}: {} -> {} (count={})",
                log_table, source_id, state, indexed_count
            );
        }

        // 同步更新 resources.mm_index_state，避免状态漂移
        let resource_id: Option<String> = match source_type {
            "textbook" | "attachment" | "image" | "file" => conn
                .query_row(
                    "SELECT resource_id FROM files WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten(),
            "exam" => conn
                .query_row(
                    "SELECT resource_id FROM exam_sheets WHERE id = ?1",
                    params![source_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten(),
            _ => None,
        };

        if let Some(res_id) = resource_id {
            let error_val = if state == "failed" {
                indexed_pages_json_or_error
            } else {
                None
            };
            let _ = conn.execute(
                "UPDATE resources SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4",
                params![state, error_val, now, res_id],
            );
        }

        Ok(())
    }
}

/// 多模态索引统计
#[derive(Debug, Clone)]
pub struct VfsMultimodalStats {
    pub total_records: usize,
    pub dimensions: Vec<i32>,
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_multimodal_page() {
        let page = VfsMultimodalPage {
            page_index: 0,
            image_base64: Some("test".to_string()),
            image_mime: Some("image/png".to_string()),
            text_content: Some("Test content".to_string()),
            blob_hash: Some("abc123".to_string()),
        };

        assert_eq!(page.page_index, 0);
        assert!(page.image_base64.is_some());
    }
}
