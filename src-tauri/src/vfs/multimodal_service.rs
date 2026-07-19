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
use crate::multimodal::types::{IndexProgressEvent, MultimodalImage, MultimodalInput};
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::lance_store::{VfsLanceRow, VfsLanceStore};
use crate::vfs::repos::index_unit_repo::IndexState as UnitIndexState;
use crate::vfs::repos::{
    embedding_dim_repo, index_segment_repo, index_unit_repo, CreateSegmentInput, CreateUnitInput,
    VfsBlobRepo, VfsIndexStateRepo, VfsIndexUnit, MODALITY_MULTIMODAL,
};

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
    /// Lance 行 ID
    pub embedding_id: String,
    /// 资源 ID
    pub resource_id: String,
    /// Unit ID（一页一 Unit）
    pub unit_id: Option<String>,
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

fn normalize_multimodal_rrf_score(score: f64, best_score: f64) -> f32 {
    if !score.is_finite() || !best_score.is_finite() || best_score <= 0.0 {
        0.0
    } else {
        (score / best_score).clamp(0.0, 1.0) as f32
    }
}

fn unified_multimodal_request(
    query_input: &MultimodalInput,
    top_k: usize,
    folder_ids: Option<&[String]>,
    resource_ids: Option<&[String]>,
    resource_types: Option<&[String]>,
) -> VfsResult<crate::vfs::UnifiedRetrievalRequest> {
    let (query_image_base64, query_image_media_type) = match query_input.image.as_ref() {
        Some(MultimodalImage::Base64 { data, media_type }) => {
            (Some(data.clone()), Some(media_type.clone()))
        }
        Some(MultimodalImage::Url { .. }) => {
            return Err(VfsError::InvalidArgument {
                param: "queryInput.image".to_string(),
                reason: "profile-aware VFS retrieval requires Base64 image bytes; URL-only image queries are unsupported"
                    .to_string(),
            });
        }
        None => (None, None),
    };
    let query_text = query_input.text.clone().map(|text| {
        query_input
            .instruction
            .as_deref()
            .map(str::trim)
            .filter(|instruction| !instruction.is_empty())
            .map(|instruction| format!("{}\n\n{}", instruction, text))
            .unwrap_or(text)
    });
    let query_modality = match (query_text.is_some(), query_image_base64.is_some()) {
        (true, true) => crate::vfs::QueryModality::Mixed,
        (false, true) => crate::vfs::QueryModality::Image,
        (true, false) => crate::vfs::QueryModality::Text,
        (false, false) => {
            return Err(VfsError::InvalidArgument {
                param: "queryInput".to_string(),
                reason: "multimodal retrieval requires text or image input".to_string(),
            });
        }
    };

    Ok(crate::vfs::UnifiedRetrievalRequest {
        query_text,
        query_image_base64,
        query_image_media_type,
        query_modality,
        top_k,
        folder_ids: folder_ids.map(<[String]>::to_vec),
        resource_ids: resource_ids.map(<[String]>::to_vec),
        resource_types: resource_types.map(<[String]>::to_vec),
    })
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
        self.index_resource_pages_with_options(
            resource_id,
            resource_type,
            folder_id,
            pages,
            true,
            None,
        )
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
        self.index_resource_pages_with_options(
            resource_id,
            resource_type,
            folder_id,
            pages,
            true,
            progress_tx,
        )
        .await
    }

    async fn index_resource_pages_with_options(
        &self,
        resource_id: &str,
        resource_type: &str,
        folder_id: Option<&str>,
        mut pages: Vec<VfsMultimodalPage>,
        force_rebuild: bool,
        progress_tx: Option<mpsc::UnboundedSender<IndexProgressEvent>>,
    ) -> VfsResult<VfsMultimodalIndexResult> {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

        if pages.is_empty() {
            self.clear_resource_multimodal_index(resource_id).await?;
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

        // 1. 检查模型配置。OCR/TM 不参与该路径，页面始终直接交给 ME。
        if !self.is_configured().await {
            return Err(VfsError::Other(
                "未配置多模态嵌入模型，请在设置中配置 VL Embedding 模型".to_string(),
            ));
        }

        // 2. 补齐图片数据并验证可持久化 provenance。
        let mut failed_pages: Vec<i32> = Vec::new();
        for page in &mut pages {
            if page.blob_hash.is_none() {
                // 兼容旧 inline API：将 Base64 原图先内容寻址持久化，再建立 Unit/Segment。
                // 没有 durable blob_hash 的向量无法可靠引用或重建，禁止只写临时向量。
                let Some(encoded) = page.image_base64.as_deref() else {
                    failed_pages.push(page.page_index);
                    continue;
                };
                let encoded = encoded
                    .rsplit_once(";base64,")
                    .map_or(encoded, |(_, data)| data);
                let data = match BASE64.decode(encoded) {
                    Ok(data) if !data.is_empty() => data,
                    _ => {
                        failed_pages.push(page.page_index);
                        continue;
                    }
                };
                let mime = page.image_mime.as_deref().unwrap_or("image/png");
                let extension = match mime {
                    "image/jpeg" => "jpg",
                    "image/webp" => "webp",
                    "image/gif" => "gif",
                    _ => "png",
                };
                let blob =
                    VfsBlobRepo::store_blob(&self.vfs_db, &data, Some(mime), Some(extension))?;
                page.blob_hash = Some(blob.hash);
            }
            let blob_hash = page.blob_hash.clone().unwrap_or_default();
            if page.image_base64.is_none() {
                let Some(blob_path) = VfsBlobRepo::get_blob_path(&self.vfs_db, &blob_hash)? else {
                    failed_pages.push(page.page_index);
                    continue;
                };
                match tokio::fs::read(&blob_path).await {
                    Ok(data) => page.image_base64 = Some(BASE64.encode(data)),
                    Err(e) => {
                        warn!(
                            "[VfsMultimodalService] Failed to read page blob {}: {}",
                            blob_hash, e
                        );
                        failed_pages.push(page.page_index);
                    }
                }
            }
            if page.image_mime.is_none() {
                page.image_mime = Some("image/png".to_string());
            }
        }
        if !failed_pages.is_empty() {
            return Err(VfsError::Other(format!(
                "多模态页面缺少可读取的原图或 blob_hash: {:?}",
                failed_pages
            )));
        }

        // 3. 同步一页一 Unit。该操作只拥有图片侧字段，不覆盖已有 OCR 文本。
        let units = {
            let conn = self.vfs_db.get_conn_safe()?;
            conn.execute("SAVEPOINT sync_mm_units", [])?;
            let synced = index_unit_repo::sync_multimodal_units(
                &conn,
                resource_id,
                pages
                    .iter()
                    .map(|page| CreateUnitInput {
                        resource_id: resource_id.to_string(),
                        unit_index: page.page_index,
                        image_blob_hash: page.blob_hash.clone(),
                        image_mime_type: page.image_mime.clone(),
                        text_content: None,
                        text_source: None,
                    })
                    .collect(),
                force_rebuild,
            );
            match synced {
                Ok(result) => {
                    embedding_dim_repo::refresh_counts_from_segments(&conn)?;
                    conn.execute("RELEASE SAVEPOINT sync_mm_units", [])?;
                    result.units
                }
                Err(error) => {
                    let _ = conn.execute("ROLLBACK TO SAVEPOINT sync_mm_units", []);
                    let _ = conn.execute("RELEASE SAVEPOINT sync_mm_units", []);
                    return Err(error);
                }
            }
        };

        let all_current = {
            let conn = self.vfs_db.get_conn_safe()?;
            units.iter().all(|unit| {
                unit.mm_state == UnitIndexState::Indexed
                    && index_segment_repo::get_by_unit_and_modality(
                        &conn,
                        &unit.id,
                        MODALITY_MULTIMODAL,
                    )
                    .map(|segments| segments.len() == 1)
                    .unwrap_or(false)
            })
        };
        if !force_rebuild && all_current {
            let dimension = units
                .first()
                .and_then(|unit| unit.mm_embedding_dim)
                .unwrap_or(0) as usize;
            return Ok(VfsMultimodalIndexResult {
                indexed_pages: units.len(),
                dimension,
                failed_pages,
            });
        }

        // Freeze one concrete ME configuration for the entire logical batch.
        // Sub-batches must never re-read assignment state independently.
        let model_config = self
            .llm_manager
            .get_vl_embedding_model_config()
            .await
            .map_err(|error| VfsError::Other(format!("读取多模态嵌入模型配置失败: {}", error)))?;
        let model_fingerprint =
            embedding_dim_repo::model_fingerprint_for_config(&model_config, MODALITY_MULTIMODAL)?;

        self.set_units_mm_state(&units, UnitIndexState::Indexing, None)?;
        self.set_resource_mm_state(resource_id, "indexing", None)?;

        let unit_map: HashMap<i32, &VfsIndexUnit> =
            units.iter().map(|unit| (unit.unit_index, unit)).collect();
        // 原图优先：即使 Unit 中存在 OCR 文本，也不把 OCR 作为 ME 输入前置。
        let inputs: Vec<(i32, MultimodalInput)> = pages
            .iter()
            .map(|page| {
                (
                    page.page_index,
                    MultimodalInput::image_base64(
                        page.image_base64.as_deref().unwrap_or_default(),
                        page.image_mime.as_deref().unwrap_or("image/png"),
                    ),
                )
            })
            .collect();

        // 4. 批量生成嵌入向量（底层按 8 页拆批，避免单次请求过大）
        let mm_inputs: Vec<MultimodalInput> = inputs.iter().map(|(_, i)| i.clone()).collect();
        let total_pages = pages.len() as i32;
        let skipped_pages = failed_pages.len() as i32;
        let embed_progress_tx = if progress_tx.is_some() {
            let (tx, mut rx) =
                mpsc::channel::<crate::multimodal::embedding_service::EmbeddingProgress>(64);
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

        let embeddings = match self
            .embedding_service
            .embed_batch_with_progress_for_config(&mm_inputs, &model_config, embed_progress_tx)
            .await
        {
            Ok(embeddings) => embeddings,
            Err(error) => {
                let message = format!("多模态嵌入生成失败: {}", error);
                self.set_units_mm_state(&units, UnitIndexState::Failed, Some(&message))?;
                self.set_resource_mm_state(resource_id, "failed", Some(&message))?;
                return Err(VfsError::Other(message));
            }
        };

        if embeddings.is_empty() {
            return Err(VfsError::Other("多模态嵌入 API 返回空结果".to_string()));
        }

        if embeddings.len() != inputs.len() {
            let message = format!(
                "多模态嵌入数量不匹配: expected={}, actual={}",
                inputs.len(),
                embeddings.len()
            );
            self.set_units_mm_state(&units, UnitIndexState::Failed, Some(&message))?;
            self.set_resource_mm_state(resource_id, "failed", Some(&message))?;
            return Err(VfsError::Other(message));
        }

        if let Err(error) = self
            .ensure_mm_assignment_unchanged(
                &model_config.id,
                &model_config.model,
                &model_fingerprint,
            )
            .await
        {
            self.reset_mm_pending(&units, resource_id)?;
            return Err(error);
        }
        let dimension = embeddings.first().map(|v| v.len()).unwrap_or(0);
        if dimension == 0
            || embeddings
                .iter()
                .any(|embedding| embedding.len() != dimension)
        {
            let message = "多模态嵌入维度为空或批次内不一致".to_string();
            self.set_units_mm_state(&units, UnitIndexState::Failed, Some(&message))?;
            self.set_resource_mm_state(resource_id, "failed", Some(&message))?;
            return Err(VfsError::Other(message));
        }

        // 相同维度不等于相同向量空间。必须先激活具体 ME 模型 profile，
        // `write_chunks` 才会打开该 profile 对应的 Lance 表。
        let index_profile = self.lance_store.ensure_model_profile_with_fingerprint(
            MODALITY_MULTIMODAL,
            dimension,
            &model_config.id,
            Some(&model_config.model),
            &model_fingerprint,
        )?;

        // 5. 构建 Lance 行并存储
        let now = chrono::Utc::now().to_rfc3339();
        let mut rows: Vec<VfsLanceRow> = Vec::new();
        let generations = units
            .iter()
            .map(|unit| {
                self.lance_store
                    .next_unit_generation(&unit.id, MODALITY_MULTIMODAL)
                    .map(|generation| (unit.unit_index, generation))
            })
            .collect::<VfsResult<HashMap<i32, i64>>>()?;
        let page_map: HashMap<i32, &VfsMultimodalPage> =
            pages.iter().map(|page| (page.page_index, page)).collect();
        let folder_id = folder_id.map(String::from);

        for ((page_index, _), embedding) in inputs.iter().zip(embeddings) {
            let page = page_map
                .get(page_index)
                .ok_or_else(|| VfsError::Other(format!("页面索引不存在: {}", page_index)))?;

            let unit = unit_map
                .get(page_index)
                .ok_or_else(|| VfsError::Other(format!("页面 {} 缺少索引 Unit", page_index)))?;
            let generation = *generations
                .get(page_index)
                .ok_or_else(|| VfsError::Other(format!("页面 {} 缺少 generation", page_index)))?;
            let metadata = serde_json::json!({
                "page_index": page_index,
                "blob_hash": page.blob_hash,
                "source_id": resource_id,
                "unit_id": unit.id,
                "content_hash": unit.content_hash,
                "modality": MODALITY_MULTIMODAL,
                "index_profile_id": index_profile.id,
                "generation": generation,
            });
            let content_suffix = unit
                .content_hash
                .as_deref()
                .unwrap_or("nohash")
                .chars()
                .take(12)
                .collect::<String>();
            let profile_suffix = index_profile
                .id
                .chars()
                .rev()
                .take(12)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>();

            rows.push(VfsLanceRow {
                embedding_id: format!(
                    "{}_mm_p{}_g{}_{}_{}_{}",
                    resource_id,
                    page_index,
                    generation,
                    profile_suffix,
                    content_suffix,
                    nanoid::nanoid!(8)
                ),
                resource_id: resource_id.to_string(),
                unit_id: unit.id.clone(),
                resource_type: resource_type.to_string(),
                folder_id: folder_id.clone(),
                chunk_index: *page_index,
                text: page.text_content.clone().unwrap_or_default(),
                metadata_json: Some(metadata.to_string()),
                created_at: now.clone(),
                index_profile_id: index_profile.id.clone(),
                generation,
                embedding,
            });
        }

        // 6. 无空窗替换：先写新行，再切换 SQLite Segment 账本。
        // - write_chunks 内部会按 embedding_id 先删后写，确保同页向量被更新
        // - 写入成功后再删除 "不在当前页面集合" 的历史行，避免先删后写的空窗
        if let Err(error) = self
            .ensure_mm_assignment_unchanged(
                &model_config.id,
                &model_config.model,
                &model_fingerprint,
            )
            .await
        {
            self.reset_mm_pending(&units, resource_id)?;
            return Err(error);
        }
        if let Err(error) = self
            .lance_store
            .write_chunks(MODALITY_MULTIMODAL, &rows)
            .await
        {
            if matches!(&error, VfsError::InvalidState { .. }) {
                self.reset_mm_pending(&units, resource_id)?;
            }
            return Err(error);
        }

        let count = rows.len();

        // 7. Segment 与 Unit 状态在同一个 savepoint 中切换；旧 row ID 同事务入队。
        let metadata_result: VfsResult<()> = (|| {
            let conn = self.vfs_db.get_conn_safe()?;
            conn.execute("SAVEPOINT commit_mm_segments", [])?;
            let commit_result: VfsResult<()> = (|| {
                for row in &rows {
                    let unit = unit_map.get(&row.chunk_index).ok_or_else(|| {
                        VfsError::Other(format!("Lance row page {} has no Unit", row.chunk_index))
                    })?;
                    index_unit_repo::set_index_profile(
                        &conn,
                        &unit.id,
                        MODALITY_MULTIMODAL,
                        &index_profile.id,
                        row.generation,
                    )?;
                    index_segment_repo::replace_by_unit_and_modality(
                        &conn,
                        resource_id,
                        &unit.id,
                        MODALITY_MULTIMODAL,
                        vec![CreateSegmentInput {
                            unit_id: unit.id.clone(),
                            segment_index: 0,
                            modality: MODALITY_MULTIMODAL.to_string(),
                            embedding_dim: dimension as i32,
                            lance_row_id: row.embedding_id.clone(),
                            content_text: if row.text.is_empty() {
                                None
                            } else {
                                Some(row.text.clone())
                            },
                            content_hash: unit.content_hash.clone(),
                            start_pos: None,
                            end_pos: None,
                            metadata_json: row.metadata_json.clone(),
                        }],
                    )?;
                    index_unit_repo::set_mm_indexed(&conn, &unit.id, dimension as i32)?;
                }
                embedding_dim_repo::refresh_counts_from_segments(&conn)?;
                Ok(())
            })();
            match commit_result {
                Ok(()) => {
                    conn.execute("RELEASE SAVEPOINT commit_mm_segments", [])?;
                    Ok(())
                }
                Err(error) => {
                    let _ = conn.execute("ROLLBACK TO SAVEPOINT commit_mm_segments", []);
                    let _ = conn.execute("RELEASE SAVEPOINT commit_mm_segments", []);
                    Err(error)
                }
            }
        })();
        if let Err(error) = metadata_result {
            let message = format!("多模态 Segment 账本提交失败: {}", error);
            let embedding_ids = rows
                .iter()
                .map(|row| row.embedding_id.clone())
                .collect::<Vec<_>>();
            if let Err(cleanup_error) = self
                .lance_store
                .discard_uncommitted_rows(MODALITY_MULTIMODAL, resource_id, &embedding_ids)
                .await
            {
                warn!(
                    "[VfsMultimodalService] Failed to reclaim uncommitted rows for {}: {}",
                    resource_id, cleanup_error
                );
            }
            self.set_units_mm_state(&units, UnitIndexState::Failed, Some(&message))?;
            self.set_resource_mm_state(resource_id, "failed", Some(&message))?;
            return Err(VfsError::Other(message));
        }

        // The new page generations are now active.  Reclaim retired rows only
        // after the SQLite switch so readers never observe a delete-first gap.
        for row in &rows {
            if let Err(error) = self
                .lance_store
                .delete_by_unit_except_ids(
                    MODALITY_MULTIMODAL,
                    resource_id,
                    &row.unit_id,
                    std::slice::from_ref(&row.embedding_id),
                )
                .await
            {
                warn!(
                    "[VfsMultimodalService] Deferred cleanup for Unit {} failed: {}",
                    row.unit_id, error
                );
            }
        }
        if let Err(error) = self
            .lance_store
            .delete_by_resource_except_dim(MODALITY_MULTIMODAL, resource_id, dimension)
            .await
        {
            warn!(
                "[VfsMultimodalService] Failed to cleanup retired multimodal profiles for {}: {}",
                resource_id, error
            );
        }
        self.set_resource_mm_state(resource_id, "indexed", None)?;

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

    fn set_units_mm_state(
        &self,
        units: &[VfsIndexUnit],
        state: UnitIndexState,
        error: Option<&str>,
    ) -> VfsResult<()> {
        let conn = self.vfs_db.get_conn_safe()?;
        for unit in units {
            index_unit_repo::set_mm_state(&conn, &unit.id, state.clone(), error)?;
        }
        Ok(())
    }

    async fn ensure_mm_assignment_unchanged(
        &self,
        expected_config_id: &str,
        expected_model: &str,
        expected_fingerprint: &str,
    ) -> VfsResult<()> {
        let current = self
            .llm_manager
            .get_vl_embedding_model_config()
            .await
            .map_err(|error| {
                VfsError::InvalidState {
                    message: format!(
                        "Multimodal embedding assignment became unavailable while a batch was running: {}",
                        error
                    ),
                }
            })?;
        let current_fingerprint =
            embedding_dim_repo::model_fingerprint_for_config(&current, MODALITY_MULTIMODAL)?;
        if current.id != expected_config_id
            || current.model != expected_model
            || current_fingerprint != expected_fingerprint
        {
            return Err(VfsError::InvalidState {
                message: format!(
                    "Multimodal embedding assignment changed while the batch was running: {}/{} -> {}/{}",
                    expected_config_id, expected_model, current.id, current.model
                ),
            });
        }
        Ok(())
    }

    fn reset_mm_pending(&self, units: &[VfsIndexUnit], resource_id: &str) -> VfsResult<()> {
        self.set_units_mm_state(units, UnitIndexState::Pending, None)?;
        self.set_resource_mm_state(resource_id, "pending", None)
    }

    fn set_resource_mm_state(
        &self,
        resource_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> VfsResult<()> {
        if state == "failed" {
            VfsIndexStateRepo::mark_mm_failed(
                &self.vfs_db,
                resource_id,
                error.unwrap_or("multimodal indexing failed"),
            )
        } else {
            VfsIndexStateRepo::set_mm_index_state(&self.vfs_db, resource_id, state, error)
        }
    }

    async fn clear_resource_multimodal_index(&self, resource_id: &str) -> VfsResult<()> {
        {
            let conn = self.vfs_db.get_conn_safe()?;
            conn.execute("SAVEPOINT clear_mm_index", [])?;
            let clear_result: VfsResult<()> = (|| {
                index_unit_repo::clear_multimodal_index(&conn, resource_id)?;
                embedding_dim_repo::refresh_counts_from_segments(&conn)?;
                Ok(())
            })();
            match clear_result {
                Ok(()) => conn.execute("RELEASE SAVEPOINT clear_mm_index", [])?,
                Err(error) => {
                    let _ = conn.execute("ROLLBACK TO SAVEPOINT clear_mm_index", []);
                    let _ = conn.execute("RELEASE SAVEPOINT clear_mm_index", []);
                    return Err(error);
                }
            };
        }
        // 队列是持久兜底；直删是快路径。直删失败不会丢失删除意图。
        if let Err(error) = self
            .lance_store
            .delete_by_resource(MODALITY_MULTIMODAL, resource_id)
            .await
        {
            warn!(
                "[VfsMultimodalService] Direct Lance cleanup failed for {}: {}; queued for retry",
                resource_id, error
            );
        }
        self.set_resource_mm_state(resource_id, "disabled", None)?;
        Ok(())
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
        let query_input = MultimodalInput::text(query);
        self.search_input_full(
            &query_input,
            top_k,
            folder_ids,
            resource_ids,
            resource_types,
        )
        .await
    }

    /// 使用文本、图片或图文混合输入执行同一多模态向量空间检索。
    pub async fn search_input_full(
        &self,
        query_input: &MultimodalInput,
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsMultimodalSearchResult>> {
        let retriever = crate::vfs::VfsUnifiedRetriever::new(
            Arc::clone(&self.vfs_db),
            Arc::clone(&self.lance_store),
            Arc::clone(&self.llm_manager),
        );
        let response = retriever
            .search_multimodal(unified_multimodal_request(
                query_input,
                top_k,
                folder_ids,
                resource_ids,
                resource_types,
            )?)
            .await?;
        let best_rrf_score = response
            .result
            .hits
            .first()
            .map(|fused| fused.rrf_score)
            .unwrap_or(0.0);

        let results: Vec<VfsMultimodalSearchResult> = response
            .result
            .hits
            .into_iter()
            .map(|fused| {
                let (metadata_blob_hash, unit_id) =
                    Self::multimodal_provenance_from_value(&fused.hit.metadata);
                VfsMultimodalSearchResult {
                    embedding_id: fused.hit.embedding_id,
                    resource_id: fused.hit.identity.resource_id,
                    unit_id,
                    resource_type: fused
                        .hit
                        .resource_type
                        .unwrap_or_else(|| "unknown".to_string()),
                    page_index: fused
                        .hit
                        .identity
                        .page_index
                        .unwrap_or(fused.hit.identity.chunk_index),
                    text_content: Some(fused.hit.text),
                    // blob_hash 必须来自持久化 metadata，绝不从 resource/source UUID 推导。
                    blob_hash: fused.hit.blob_hash.or(metadata_blob_hash),
                    score: normalize_multimodal_rrf_score(fused.rrf_score, best_rrf_score),
                    folder_id: fused.hit.folder_id,
                }
            })
            .collect();

        Ok(results)
    }

    fn parse_multimodal_provenance(
        metadata_json: Option<&str>,
    ) -> (Option<String>, Option<String>) {
        let Some(metadata_json) = metadata_json else {
            return (None, None);
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(metadata_json) else {
            return (None, None);
        };
        Self::multimodal_provenance_from_value(&value)
    }

    fn multimodal_provenance_from_value(
        value: &serde_json::Value,
    ) -> (Option<String>, Option<String>) {
        let blob_hash = value
            .get("blob_hash")
            .and_then(|value| value.as_str())
            .map(ToString::to_string);
        let unit_id = value
            .get("unit_id")
            .and_then(|value| value.as_str())
            .map(ToString::to_string);
        (blob_hash, unit_id)
    }

    /// 删除资源的多模态索引
    ///
    /// ★ 审计修复：删除后刷新 record_count
    pub async fn delete_resource_index(&self, resource_id: &str) -> VfsResult<()> {
        self.clear_resource_multimodal_index(resource_id).await?;

        info!(
            "[VfsMultimodalService] Deleted multimodal index for resource {}",
            resource_id
        );

        Ok(())
    }

    /// 批量处理待索引的多模态 Units。
    ///
    /// `limit` 以待处理 Unit 为取样上限，返回值以资源为成功/失败计数。只要资源中
    /// 有一页 pending，就按该资源当前全部图片 Unit 重建，避免模型维度切换或页级
    /// 更新时产生半新半旧的资源账本。
    pub async fn process_pending_batch(&self, limit: u32) -> VfsResult<(usize, usize)> {
        let pending = {
            let conn = self.vfs_db.get_conn_safe()?;
            index_unit_repo::list_pending_mm(&conn, limit.clamp(1, 100) as i32)?
        };
        let mut resource_ids = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for unit in pending {
            if seen.insert(unit.resource_id.clone()) {
                resource_ids.push(unit.resource_id);
            }
        }

        let mut success = 0usize;
        let mut failed = 0usize;
        for resource_id in resource_ids {
            let (resource_type, folder_id, pages) = {
                let conn = self.vfs_db.get_conn_safe()?;
                let resource_type = conn
                    .query_row(
                        "SELECT type FROM resources WHERE id = ?1",
                        rusqlite::params![resource_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .unwrap_or_else(|| "file".to_string());
                let folder_id = Self::resolve_resource_folder_id(&conn, &resource_id)?;
                let pages = index_unit_repo::get_by_resource(&conn, &resource_id)?
                    .into_iter()
                    .filter(|unit| unit.mm_required && unit.image_blob_hash.is_some())
                    .map(|unit| VfsMultimodalPage {
                        page_index: unit.unit_index,
                        image_base64: None,
                        image_mime: unit.image_mime_type,
                        // OCR/native text remains a separate Unit artifact and is not sent to ME.
                        text_content: None,
                        blob_hash: unit.image_blob_hash,
                    })
                    .collect::<Vec<_>>();
                (resource_type, folder_id, pages)
            };

            match self
                .index_resource_pages_with_options(
                    &resource_id,
                    &resource_type,
                    folder_id.as_deref(),
                    pages,
                    true,
                    None,
                )
                .await
            {
                Ok(_) => success += 1,
                Err(error) => {
                    failed += 1;
                    warn!(
                        "[VfsMultimodalService] Pending resource {} failed: {}",
                        resource_id, error
                    );
                }
            }
        }
        Ok((success, failed))
    }

    fn resolve_resource_folder_id(
        conn: &rusqlite::Connection,
        resource_id: &str,
    ) -> VfsResult<Option<String>> {
        Ok(conn
            .query_row(
                r#"SELECT fi.folder_id
                   FROM folder_items fi
                   WHERE fi.deleted_at IS NULL
                     AND (
                       fi.item_id = ?1
                       OR EXISTS (SELECT 1 FROM files f WHERE f.id = fi.item_id AND f.resource_id = ?1)
                       OR EXISTS (SELECT 1 FROM exam_sheets e WHERE e.id = fi.item_id AND e.resource_id = ?1)
                     )
                   ORDER BY fi.updated_at DESC, fi.created_at DESC
                   LIMIT 1"#,
                rusqlite::params![resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
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

                let mime_type = page_preview
                    .mime_type
                    .clone()
                    .unwrap_or_else(|| "image/png".to_string());

                extracted_pages.push(VfsMultimodalPage {
                    page_index: page_preview.page_index as i32,
                    // 延迟到统一索引入口读取，避免 preview 解析阶段同时持有原图 bytes 和 Base64。
                    image_base64: None,
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
                let mime = mime_type.unwrap_or_else(|| "image/png".to_string());
                info!(
                    "[VfsMultimodalService] Image fallback: using blob_hash={} for single-page index",
                    blob_hash
                );
                vec![VfsMultimodalPage {
                    page_index: 0,
                    image_base64: None,
                    image_mime: Some(mime),
                    text_content: None,
                    blob_hash: Some(blob_hash),
                }]
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
            // 空页面也是一次有效更新：必须清理旧 Segment/Lance 行，不能只改状态。
            self.clear_resource_multimodal_index(&resource_id).await?;
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

        // 4. 调用 index_resource_pages；force_rebuild 会真实重置并重建整份资源。
        let result = self
            .index_resource_pages_with_options(
                &resource_id,
                source_type,
                folder_id,
                pages.clone(),
                _force_rebuild,
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
                let retryable_conflict = matches!(&e, VfsError::InvalidState { .. });
                let error_message = e.to_string();
                Self::update_mm_index_state_in_business_table(
                    &conn,
                    source_type,
                    source_id,
                    if retryable_conflict {
                        "pending"
                    } else {
                        "failed"
                    },
                    if retryable_conflict {
                        None
                    } else {
                        Some(error_message.as_str())
                    },
                    0,
                    0,
                )?;

                if let Some(progress_tx) = progress_tx.as_ref() {
                    let event = IndexProgressEvent::new(source_type, source_id, pages.len() as i32)
                        .with_phase(
                            if retryable_conflict {
                                "pending"
                            } else {
                                "failed"
                            },
                            &error_message,
                        )
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
            if state == "failed" {
                VfsIndexStateRepo::mark_mm_failed_with_conn(
                    conn,
                    &res_id,
                    error_val.unwrap_or("multimodal indexing failed"),
                )?;
            } else {
                VfsIndexStateRepo::set_mm_index_state_with_conn(conn, &res_id, state, error_val)?;
            }
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
    fn legacy_multimodal_search_inputs_build_unified_profile_requests() {
        let folders = vec!["folder-a".to_string()];
        let resources = vec!["resource-a".to_string()];
        let types = vec!["textbook".to_string()];
        let text = MultimodalInput::text("query").with_instruction("retrieve pages");
        let text_request =
            unified_multimodal_request(&text, 7, Some(&folders), Some(&resources), Some(&types))
                .expect("text request");
        assert_eq!(text_request.query_modality, crate::vfs::QueryModality::Text);
        assert_eq!(text_request.top_k, 7);
        assert_eq!(text_request.folder_ids.as_deref(), Some(folders.as_slice()));
        assert_eq!(
            text_request.resource_ids.as_deref(),
            Some(resources.as_slice())
        );
        assert_eq!(
            text_request.resource_types.as_deref(),
            Some(types.as_slice())
        );
        assert_eq!(
            text_request.query_text.as_deref(),
            Some("retrieve pages\n\nquery")
        );

        let image = MultimodalInput::image_base64("bytes", "image/png");
        let image_request =
            unified_multimodal_request(&image, 3, None, None, None).expect("image request");
        assert_eq!(
            image_request.query_modality,
            crate::vfs::QueryModality::Image
        );
        assert_eq!(image_request.query_image_base64.as_deref(), Some("bytes"));

        let mixed = MultimodalInput::text_and_image("query", "bytes", "image/webp");
        let mixed_request =
            unified_multimodal_request(&mixed, 5, None, None, None).expect("mixed request");
        assert_eq!(
            mixed_request.query_modality,
            crate::vfs::QueryModality::Mixed
        );
    }

    #[test]
    fn url_only_image_cannot_bypass_profile_aware_retrieval() {
        let input = MultimodalInput::image_url("https://example.invalid/image.png");
        let error = unified_multimodal_request(&input, 5, None, None, None)
            .expect_err("URL must not fall back to dimension-only Lance lookup");
        assert!(error.to_string().contains("Base64 image bytes"));
    }

    #[test]
    fn multimodal_compatibility_scores_preserve_rrf_order() {
        let best = 0.032;
        assert_eq!(normalize_multimodal_rrf_score(best, best), 1.0);
        assert_eq!(normalize_multimodal_rrf_score(best / 2.0, best), 0.5);
        assert_eq!(normalize_multimodal_rrf_score(f64::NAN, best), 0.0);
    }

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

    #[test]
    fn parses_blob_and_unit_provenance_without_using_source_id() {
        let metadata = serde_json::json!({
            "page_index": 3,
            "blob_hash": "blob_real_page_hash",
            "source_id": "resource_uuid_not_a_blob",
            "unit_id": "unit_page_3"
        })
        .to_string();
        let (blob_hash, unit_id) =
            VfsMultimodalService::parse_multimodal_provenance(Some(&metadata));
        assert_eq!(blob_hash.as_deref(), Some("blob_real_page_hash"));
        assert_eq!(unit_id.as_deref(), Some("unit_page_3"));
    }
}
