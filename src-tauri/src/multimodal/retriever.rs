//! 多模态检索器
//!
//! 实现完整的多模态检索流程，支持多维度混合检索、双路召回、融合和精排。
//!
//! ## 检索架构
//!
//! 1. **维度发现**: 扫描 LanceDB 中有数据的表，提取维度列表
//! 2. **模型路由**: 查询维度注册表，获取每个维度对应的嵌入模型配置
//! 3. **并行向量化**: 为每个维度调用对应模型生成查询向量
//! 4. **多维度召回**: 在各维度表中分别召回，支持任意维度
//! 5. **结果融合**: 使用 RRF 算法合并多维度结果
//! 6. **精排**: 使用 VL-Reranker 对候选项重新排序
//!
//! ## 多维度支持
//!
//! 系统支持任意维度的向量，每个嵌入模型负责特定维度：
//! - 索引时：不同模型生成不同维度向量，存入对应表（如 mm_pages_v2_d768, mm_pages_v2_d4096）
//! - 召回时：查询文本分别提供给各嵌入模型生成查询向量，在各维度表中分别召回
//! - 汇总：使用 RRF 融合多维度结果，最后统一精排
//!
//! 设计文档参考: docs/multimodal-knowledge-base-design.md (Section 7.6)

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use crate::database::Database;
use crate::models::AppError;
use crate::multimodal::embedding_service::MultimodalEmbeddingService;
use crate::multimodal::reranker_service::{MultimodalRerankerService, RerankableItem};
use crate::multimodal::types::{
    MultimodalInput, MultimodalRetrievalConfig, MultimodalRetrievalResult, RetrievalSource,
    SourceType,
};
use crate::multimodal::vector_store::{MultimodalVectorStore, SearchResult};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsBlobRepo, VfsTextbookRepo, VfsResourceRepo, VfsFileRepo, VfsExamRepo};

type Result<T> = std::result::Result<T, AppError>;

/// RRF (Reciprocal Rank Fusion) 算法常数
const RRF_K: f32 = 60.0;

/// 多模态检索器
///
/// 实现完整的多模态检索流程
pub struct MultimodalRetriever {
    database: Arc<Database>,
    vfs_db: Arc<VfsDatabase>,
    embedding_service: Arc<MultimodalEmbeddingService>,
    reranker_service: Arc<MultimodalRerankerService>,
    vector_store: Arc<MultimodalVectorStore>,
}

impl MultimodalRetriever {
    /// 创建新的检索器实例
    pub fn new(
        database: Arc<Database>,
        vfs_db: Arc<VfsDatabase>,
        embedding_service: Arc<MultimodalEmbeddingService>,
        reranker_service: Arc<MultimodalRerankerService>,
        vector_store: Arc<MultimodalVectorStore>,
    ) -> Self {
        Self {
            database,
            vfs_db,
            embedding_service,
            reranker_service,
            vector_store,
        }
    }

    /// 执行多模态检索（多维度召回）
    ///
    /// ## 参数
    /// - `query`: 查询内容（文本/图片/混合）
    /// - `config`: 检索配置
    ///
    /// ## 返回
    /// 检索结果列表，按相关性排序
    ///
    /// ## 多维度召回流程
    /// 1. 发现所有有数据的维度表
    /// 2. 为每个维度生成对应的查询向量（使用对应的嵌入模型）
    /// 3. 在各维度表中分别召回
    /// 4. 使用 RRF 算法融合多维度结果
    /// 5. 精排并返回
    pub async fn retrieve(
        &self,
        query: &MultimodalInput,
        config: &MultimodalRetrievalConfig,
    ) -> Result<Vec<MultimodalRetrievalResult>> {
        log::info!("🔍 开始多模态检索（多维度+多类型模式）");

        // Step 1: 发现所有有数据的维度（按向量类型区分）
        let dims_by_type = self.vector_store.list_available_dimensions_by_type().await?;
        if dims_by_type.is_empty() {
            log::info!("  ⚠️ 未发现任何索引数据");
            return Ok(Vec::new());
        }
        log::info!("  📊 发现向量表: {:?}", dims_by_type);

        // Step 2: 按类型分别召回
        let mm_results = self
            .search_multimodal_by_type(query, &dims_by_type, config.mm_top_k, &config.sub_library_ids)
            .await?;
        log::debug!("  多类型召回总计: {} 条", mm_results.len());

        // Step 3: 转换为统一结果格式
        let mut candidates: Vec<MultimodalRetrievalResult> = mm_results
            .into_iter()
            .map(|r| self.search_result_to_retrieval_result(r))
            .collect();

        // Step 4: 去重
        candidates = self.deduplicate_results(candidates);
        log::debug!("  去重后: {} 条", candidates.len());

        // Step 5: 截断到融合数量
        candidates.truncate(config.merge_top_k);

        // Step 6: 精排（如果启用）
        if config.enable_reranking && self.reranker_service.is_configured().await {
            log::info!("  🔄 执行多模态精排...");
            candidates = self.rerank_results(query, candidates, config.final_top_k).await?;
        } else {
            candidates.truncate(config.final_top_k);
        }

        // Step 7: 加载图片内容（可选）
        candidates = self.load_result_images(candidates).await;

        log::info!("✅ 多模态检索完成: {} 条结果", candidates.len());
        Ok(candidates)
    }

    /// 仅执行多模态路召回（不精排）
    ///
    /// 用于快速检索场景
    pub async fn retrieve_fast(
        &self,
        query: &MultimodalInput,
        top_k: usize,
        sub_library_ids: Option<&[String]>,
    ) -> Result<Vec<MultimodalRetrievalResult>> {
        // 生成查询向量
        let query_embedding = self.embedding_service.embed_single(query).await?;

        // 多模态路召回
        let mm_results = self
            .search_multimodal(&query_embedding, top_k, &sub_library_ids.map(|s| s.to_vec()))
            .await?;

        // 转换为统一结果格式
        let candidates: Vec<MultimodalRetrievalResult> = mm_results
            .into_iter()
            .map(|r| self.search_result_to_retrieval_result(r))
            .collect();

        Ok(candidates)
    }

    /// 按向量类型分别搜索多模态页面向量表
    ///
    /// 对于不同类型的向量（vl/text），使用对应的嵌入模型生成查询向量，
    /// 然后在对应类型的表中搜索，最后使用 RRF 融合结果
    async fn search_multimodal_by_type(
        &self,
        query: &MultimodalInput,
        dims_by_type: &HashMap<String, Vec<usize>>,
        top_k: usize,
        sub_library_ids: &Option<Vec<String>>,
    ) -> Result<Vec<SearchResult>> {
        let mut all_results: Vec<Vec<SearchResult>> = Vec::new();

        // 1. 处理 VL 类型（使用 VL-Embedding 模型）
        // 注意：必须检查 VL-Embedding 模型是否真正可用，而不是 is_configured()
        // 因为 is_configured() 对方案二也返回 true，但方案二无法生成多模态查询向量
        if let Some(vl_dims) = dims_by_type.get("vl") {
            if !vl_dims.is_empty() && self.embedding_service.is_vl_embedding_available().await {
                if let Ok(vl_embedding) = self.embedding_service.embed_single(query).await {
                    let vl_dim = vl_embedding.len();
                    if vl_dims.contains(&vl_dim) {
                        log::debug!("  🔍 VL 模式: 在 vl_d{} 表中搜索...", vl_dim);
                        let results = self
                            .vector_store
                            .search_in_dimension_typed(
                                "vl",
                                vl_dim,
                                &vl_embedding,
                                top_k,
                                sub_library_ids.as_ref().map(|v| v.as_slice()),
                            )
                            .await?;
                        log::debug!("    VL 召回 {} 条", results.len());
                        if !results.is_empty() {
                            all_results.push(results);
                        }
                    }
                }
            }
        }

        // 2. 处理 Text 类型（使用文本嵌入模型）
        // 需要同时满足：有 text 类型表、有文本嵌入模型、查询包含文本
        if let Some(text_dims) = dims_by_type.get("text") {
            if !text_dims.is_empty() && self.embedding_service.is_text_embedding_available().await {
                // 仅当查询包含文本时才使用文本嵌入
                if let Some(ref text) = query.text {
                    if let Ok(embeddings) = self.embedding_service.embed_texts(&[text.clone()]).await {
                        if let Some(text_embedding) = embeddings.into_iter().next() {
                            let text_dim = text_embedding.len();
                            if text_dims.contains(&text_dim) {
                                log::debug!("  🔍 Text 模式: 在 text_d{} 表中搜索...", text_dim);
                                let results = self
                                    .vector_store
                                    .search_in_dimension_typed(
                                        "text",
                                        text_dim,
                                        &text_embedding,
                                        top_k,
                                        sub_library_ids.as_ref().map(|v| v.as_slice()),
                                    )
                                    .await?;
                                log::debug!("    Text 召回 {} 条", results.len());
                                if !results.is_empty() {
                                    all_results.push(results);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. 融合结果
        if all_results.is_empty() {
            return Ok(Vec::new());
        }
        if all_results.len() == 1 {
            return Ok(all_results.into_iter().next().unwrap());
        }

        let fused = self.fuse_multi_dim_results(all_results, top_k);
        log::debug!("  📊 RRF 融合后: {} 条", fused.len());

        Ok(fused)
    }

    /// 多维度搜索多模态页面向量表（旧方法，保留用于向后兼容）
    #[allow(dead_code)]
    async fn search_multimodal_multi_dim(
        &self,
        query: &MultimodalInput,
        dimensions: &[usize],
        top_k: usize,
        sub_library_ids: &Option<Vec<String>>,
    ) -> Result<Vec<SearchResult>> {
        if dimensions.is_empty() {
            return Ok(Vec::new());
        }

        // 一次性为所有目标维度生成查询向量（避免重复调用嵌入 API）
        let embeddings_by_dim = self.generate_query_embeddings_for_dims(query, dimensions).await;

        if embeddings_by_dim.is_empty() {
            log::warn!("  ⚠️ 无法为任何目标维度生成查询向量");
            return Ok(Vec::new());
        }

        log::debug!(
            "  📊 成功生成 {} 个维度的查询向量: {:?}",
            embeddings_by_dim.len(),
            embeddings_by_dim.keys().collect::<Vec<_>>()
        );

        // 收集各维度的召回结果
        let mut all_results_by_dim: Vec<Vec<SearchResult>> = Vec::new();

        for (&dim, query_embedding) in &embeddings_by_dim {
            log::debug!("  🔍 在维度 {} 中搜索...", dim);

            // 在该维度表中搜索（默认使用 VL 类型）
            let results = self
                .vector_store
                .search_in_dimension_typed(
                    "vl",
                    dim,
                    query_embedding,
                    top_k,
                    sub_library_ids.as_ref().map(|v| v.as_slice()),
                )
                .await?;

            log::debug!("    维度 {} 召回 {} 条", dim, results.len());
            if !results.is_empty() {
                all_results_by_dim.push(results);
            }
        }

        // 如果只有一个维度，直接返回
        if all_results_by_dim.len() == 1 {
            return Ok(all_results_by_dim.into_iter().next().unwrap());
        }

        // 使用 RRF 融合多维度结果
        if all_results_by_dim.is_empty() {
            return Ok(Vec::new());
        }

        let fused = self.fuse_multi_dim_results(all_results_by_dim, top_k);
        log::debug!("  📊 RRF 融合后: {} 条", fused.len());

        Ok(fused)
    }

    /// 为所有目标维度生成查询向量（缓存避免重复调用）
    ///
    /// 返回维度 -> 嵌入向量的映射
    async fn generate_query_embeddings_for_dims(
        &self,
        query: &MultimodalInput,
        target_dims: &[usize],
    ) -> HashMap<usize, Vec<f32>> {
        let mut embeddings_by_dim: HashMap<usize, Vec<f32>> = HashMap::new();

        // 尝试使用 VL-Embedding 模型（仅调用一次）
        if self.embedding_service.is_configured().await {
            if let Ok(embedding) = self.embedding_service.embed_single(query).await {
                let dim = embedding.len();
                if target_dims.contains(&dim) {
                    log::debug!("  VL-Embedding 生成 {} 维向量", dim);
                    embeddings_by_dim.insert(dim, embedding);
                }
            }
        }

        // 尝试使用文本嵌入模型（仅调用一次，仅当查询包含文本时）
        if let Some(ref text) = query.text {
            if let Ok(embeddings) = self.embedding_service.embed_texts(&[text.clone()]).await {
                if let Some(embedding) = embeddings.into_iter().next() {
                    let dim = embedding.len();
                    if target_dims.contains(&dim) && !embeddings_by_dim.contains_key(&dim) {
                        log::debug!("  文本嵌入生成 {} 维向量", dim);
                        embeddings_by_dim.insert(dim, embedding);
                    }
                }
            }
        }

        embeddings_by_dim
    }

    /// 使用 RRF 算法融合多维度召回结果
    fn fuse_multi_dim_results(
        &self,
        results_by_dim: Vec<Vec<SearchResult>>,
        top_k: usize,
    ) -> Vec<SearchResult> {
        // 构建文档 ID -> 结果 的映射
        let mut doc_map: HashMap<String, SearchResult> = HashMap::new();
        let mut rrf_scores: HashMap<String, f32> = HashMap::new();

        for results in &results_by_dim {
            for (rank, result) in results.iter().enumerate() {
                let doc_id = format!(
                    "{}:{}:{}",
                    result.record.source_type,
                    result.record.source_id,
                    result.record.page_index
                );

                // 计算 RRF 分数
                let rrf_score = 1.0 / (RRF_K + rank as f32 + 1.0);
                *rrf_scores.entry(doc_id.clone()).or_insert(0.0) += rrf_score;

                // 保存最高原始分数的结果
                doc_map
                    .entry(doc_id)
                    .and_modify(|existing| {
                        if result.score > existing.score {
                            *existing = result.clone();
                        }
                    })
                    .or_insert_with(|| result.clone());
            }
        }

        // 按 RRF 分数排序
        let mut sorted_docs: Vec<(String, f32)> = rrf_scores.into_iter().collect();
        sorted_docs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // 提取结果，更新分数为 RRF 分数
        sorted_docs
            .into_iter()
            .take(top_k)
            .filter_map(|(doc_id, rrf_score)| {
                doc_map.remove(&doc_id).map(|mut result| {
                    result.score = rrf_score;
                    result
                })
            })
            .collect()
    }

    /// 搜索多模态页面向量表（单维度，保留向后兼容）
    #[allow(dead_code)]
    async fn search_multimodal(
        &self,
        query_embedding: &[f32],
        top_k: usize,
        sub_library_ids: &Option<Vec<String>>,
    ) -> Result<Vec<SearchResult>> {
        self.vector_store
            .search(
                query_embedding,
                top_k,
                sub_library_ids.as_ref().map(|v| v.as_slice()),
            )
            .await
    }

    /// 将搜索结果转换为统一的检索结果格式
    fn search_result_to_retrieval_result(&self, result: SearchResult) -> MultimodalRetrievalResult {
        let source_type = SourceType::from_str(&result.record.source_type)
            .unwrap_or(SourceType::Attachment);

        // 优先从 VFS 加载 OCR，回退到 LanceDB 中的 text_summary
        let ocr_text = self.load_ocr_from_vfs(
            source_type,
            &result.record.source_id,
            result.record.page_index,
        ).unwrap_or_else(|| result.record.text_summary.clone().unwrap_or_default());

        MultimodalRetrievalResult::from_page(
            source_type,
            &result.record.source_id,
            result.record.page_index,
            result.score,
        )
        .with_blob_hash(result.record.blob_hash.unwrap_or_default())
        .with_text(ocr_text)
    }

    /// 从 VFS 加载 OCR 文本
    ///
    /// 根据资源类型从不同的 VFS 表加载 OCR：
    /// - Textbook: 从 textbooks.ocr_pages_json 加载
    /// - Image: 从 resources.ocr_text 加载
    fn load_ocr_from_vfs(
        &self,
        source_type: SourceType,
        source_id: &str,
        page_index: i32,
    ) -> Option<String> {
        match source_type {
            SourceType::Textbook => {
                VfsTextbookRepo::get_page_ocr(&self.vfs_db, source_id, page_index as usize)
                    .ok()
                    .flatten()
            }
            SourceType::Image => {
                // 图片的 source_id 就是 resource_id，直接使用
                VfsResourceRepo::get_ocr_text(&self.vfs_db, source_id)
                    .ok()
                    .flatten()
            }
            SourceType::Attachment => {
                VfsFileRepo::get_page_ocr(&self.vfs_db, source_id, page_index as usize)
                    .ok()
                    .flatten()
            }
            SourceType::Exam => {
                // 题目集：从 exam_sheets.ocr_pages_json 加载页级 OCR
                VfsExamRepo::get_page_ocr(&self.vfs_db, source_id, page_index as usize)
                    .ok()
                    .flatten()
            }
            _ => None,
        }
    }

    /// 去重结果（基于 source_id + page_index）
    fn deduplicate_results(
        &self,
        results: Vec<MultimodalRetrievalResult>,
    ) -> Vec<MultimodalRetrievalResult> {
        let mut seen = HashSet::new();
        let mut deduped = Vec::new();

        for result in results {
            let key = format!(
                "{}:{}:{}",
                result.source_type.as_str(),
                result.source_id,
                result.page_index.unwrap_or(-1)
            );

            if !seen.contains(&key) {
                seen.insert(key);
                deduped.push(result);
            }
        }

        deduped
    }

    /// 使用多模态重排序精排结果
    async fn rerank_results(
        &self,
        query: &MultimodalInput,
        candidates: Vec<MultimodalRetrievalResult>,
        top_k: usize,
    ) -> Result<Vec<MultimodalRetrievalResult>> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }

        // 加载候选项的图片内容用于精排
        let candidates_with_images = self.load_result_images(candidates).await;

        // 转换为可重排序项目
        let rerank_items: Vec<RerankableResult> = candidates_with_images
            .into_iter()
            .map(|r| RerankableResult(r))
            .collect();

        // 执行重排序
        let reranked = self
            .reranker_service
            .rerank(query, &rerank_items, top_k)
            .await?;

        // 提取结果
        Ok(reranked.into_iter().map(|r| r.0).collect())
    }

    /// 加载结果的图片内容
    async fn load_result_images(
        &self,
        mut results: Vec<MultimodalRetrievalResult>,
    ) -> Vec<MultimodalRetrievalResult> {
        for result in &mut results {
            if let Some(ref blob_hash) = result.blob_hash {
                if !blob_hash.is_empty() && result.image_base64.is_none() {
                    match self.load_blob_base64(blob_hash).await {
                        Ok((base64, media_type)) => {
                            result.image_base64 = Some(base64);
                            result.image_media_type = Some(media_type);
                        }
                        Err(e) => {
                            log::warn!("加载图片失败 (blob: {}): {}", blob_hash, e);
                        }
                    }
                }
            }
        }
        results
    }

    /// 加载 Blob 内容并转换为 Base64
    async fn load_blob_base64(&self, blob_hash: &str) -> Result<(String, String)> {
        let conn = self.vfs_db.get_conn_safe().map_err(|e| {
            AppError::database(format!("获取 VFS 连接失败: {}", e))
        })?;

        // 获取 Blob 路径
        let blob_path = VfsBlobRepo::get_blob_path_with_conn(&conn, self.vfs_db.blobs_dir(), blob_hash)
            .map_err(|e| AppError::database(format!("获取 Blob 路径失败: {}", e)))?
            .ok_or_else(|| AppError::not_found(format!("Blob 不存在: {}", blob_hash)))?;

        // 读取文件
        let data = std::fs::read(&blob_path).map_err(|e| {
            AppError::file_system(format!("读取 Blob 文件失败: {}", e))
        })?;

        // 编码为 Base64
        let base64 = BASE64.encode(&data);

        // 推断 MIME 类型
        let ext = blob_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let media_type = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "image/png",
        }
        .to_string();

        Ok((base64, media_type))
    }
}

/// RRF 融合辅助函数
///
/// 将多路召回结果使用 Reciprocal Rank Fusion 算法融合
#[allow(dead_code)]
fn rrf_fusion<T, F>(
    results_list: Vec<Vec<T>>,
    get_id: F,
    k: f32,
) -> Vec<(String, f32)>
where
    F: Fn(&T) -> String,
{
    let mut scores: HashMap<String, f32> = HashMap::new();

    for results in results_list {
        for (rank, item) in results.iter().enumerate() {
            let id = get_id(item);
            let rrf_score = 1.0 / (k + rank as f32 + 1.0);
            *scores.entry(id).or_insert(0.0) += rrf_score;
        }
    }

    let mut sorted: Vec<(String, f32)> = scores.into_iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    sorted
}

/// 可重排序的检索结果包装器
#[derive(Clone)]
struct RerankableResult(MultimodalRetrievalResult);

impl RerankableItem for RerankableResult {
    fn item_id(&self) -> &str {
        &self.0.id
    }

    fn original_score(&self) -> f32 {
        self.0.score
    }

    fn to_multimodal_input(&self) -> MultimodalInput {
        // 根据内容类型构建多模态输入
        match (&self.0.image_base64, &self.0.text_content) {
            (Some(base64), Some(text)) => {
                let media_type = self.0.image_media_type.as_deref().unwrap_or("image/png");
                MultimodalInput::text_and_image(text, base64, media_type)
            }
            (Some(base64), None) => {
                let media_type = self.0.image_media_type.as_deref().unwrap_or("image/png");
                MultimodalInput::image_base64(base64, media_type)
            }
            (None, Some(text)) => MultimodalInput::text(text),
            (None, None) => MultimodalInput::text(""),
        }
    }

    fn with_score(&self, score: f32) -> Self {
        let mut result = self.0.clone();
        result.score = score;
        RerankableResult(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rrf_fusion() {
        // 模拟两路召回结果
        let results1 = vec!["doc1", "doc2", "doc3"];
        let results2 = vec!["doc2", "doc1", "doc4"];

        let fused = rrf_fusion(
            vec![results1, results2],
            |s| s.to_string(),
            RRF_K,
        );

        // doc2 在两路中都排名靠前，应该有最高分
        assert!(!fused.is_empty());
        // 验证 doc1 和 doc2 都在结果中
        let ids: Vec<&str> = fused.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"doc1"));
        assert!(ids.contains(&"doc2"));
    }

    #[test]
    fn test_rerankable_result_text_only() {
        let result = MultimodalRetrievalResult::from_page(
            SourceType::Exam,
            "exam_1",
            0,
            0.8,
        )
        .with_text("Some OCR text");

        let wrapper = RerankableResult(result);
        let input = wrapper.to_multimodal_input();

        assert!(input.is_text_only());
        assert_eq!(input.text, Some("Some OCR text".to_string()));
    }

    #[test]
    fn test_rerankable_result_with_image() {
        let mut result = MultimodalRetrievalResult::from_page(
            SourceType::Attachment,
            "doc_1",
            1,
            0.7,
        );
        result.image_base64 = Some("abc123".to_string());
        result.image_media_type = Some("image/png".to_string());
        result.text_content = Some("Description".to_string());

        let wrapper = RerankableResult(result);
        let input = wrapper.to_multimodal_input();

        assert!(input.has_image());
        assert_eq!(input.text, Some("Description".to_string()));
    }
}
