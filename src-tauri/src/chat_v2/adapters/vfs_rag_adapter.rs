//! VFS RAG 检索适配器
//!
//! ★ 2026-01 简化：VFS RAG 作为唯一知识检索方案
//!
//! 基于 VFS 统一知识管理架构的 RAG 检索适配器，完全替代原有的 RagManager。
//!
//! ## 特性
//! - 统一检索：笔记、教材、题目集、翻译等所有学习资源
//! - 范围过滤：基于 folder_id 层级过滤
//! - 类型过滤：基于 VfsResourceType 过滤
//! - 重排序：可选的 Reranker 语义重排序
//! - 相关性过滤：自动过滤低分结果
//!
//! ## 事件类型
//! | 检索类型 | 事件类型 | 前端块类型 |
//! |---------|---------|----------|
//! | VFS RAG | `rag` | `rag` |

use std::sync::Arc;

use crate::chat_v2::events::{event_types, ChatV2EventEmitter};
use crate::chat_v2::types::SourceInfo;
use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::indexing::{VfsFullSearchService, VfsSearchParams};
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::repos::MODALITY_TEXT;

// ============================================================
// 常量
// ============================================================

/// 最小相关性分数阈值（低于此分数的结果将被过滤）
const MIN_RELEVANCE_SCORE: f32 = 0.3;
/// 相对分数阈值（分数低于最高分 * 此值的结果将被过滤）
const RELATIVE_SCORE_THRESHOLD: f32 = 0.5;

// ============================================================
// VFS RAG 适配器
// ============================================================

/// Chat V2 VFS RAG 适配器
///
/// 基于 VFS 统一知识管理架构的 RAG 检索适配器。
///
/// ## 约束条件
/// - 检索失败时发射 error 事件并返回空列表，不向上抛出异常
/// - block_id 由后端生成
///
/// ## 使用示例
/// ```ignore
/// let adapter = ChatV2VfsRagAdapter::new(emitter.clone(), message_id.clone(), search_service);
/// let sources = adapter.search_vfs("query", None, None, 5).await;
/// ```
pub struct ChatV2VfsRagAdapter {
    emitter: ChatV2EventEmitter,
    message_id: String,
    search_service: Arc<VfsFullSearchService>,
}

impl ChatV2VfsRagAdapter {
    /// 创建新的 VFS RAG 适配器
    pub fn new(
        emitter: ChatV2EventEmitter,
        message_id: String,
        search_service: Arc<VfsFullSearchService>,
    ) -> Self {
        Self {
            emitter,
            message_id,
            search_service,
        }
    }

    /// 从依赖项创建适配器
    pub fn from_deps(
        emitter: ChatV2EventEmitter,
        message_id: String,
        vfs_db: Arc<VfsDatabase>,
        lance_store: Arc<VfsLanceStore>,
        llm_manager: Arc<LLMManager>,
    ) -> Self {
        let search_service = Arc::new(VfsFullSearchService::new(vfs_db, lance_store, llm_manager));
        Self::new(emitter, message_id, search_service)
    }

    /// 生成块 ID
    fn generate_block_id() -> String {
        format!("blk_{}", uuid::Uuid::new_v4())
    }

    /// 从 VfsSearchResult 转换为 SourceInfo
    fn vfs_result_to_source_info(result: &crate::vfs::indexing::VfsSearchResult) -> SourceInfo {
        let title = result
            .resource_title
            .clone()
            .or_else(|| Some(format!("Resource {}", &result.resource_id)));

        let metadata = serde_json::json!({
            "resourceId": result.resource_id,
            "resourceType": result.resource_type,
            "chunkIndex": result.chunk_index,
            "embeddingId": result.embedding_id,
            "sourceType": "vfs_rag",
            // 🔧 P37: 添加 pageIndex 用于 PDF 页面图片渲染
            "pageIndex": result.page_index,
            "sourceId": result.source_id,
        });

        SourceInfo {
            title,
            url: None,
            snippet: Some(result.chunk_text.clone()),
            score: Some(result.score as f32),
            metadata: Some(metadata),
        }
    }

    /// 过滤低相关性结果
    ///
    /// 应用双重阈值过滤：
    /// 1. 绝对阈值：分数必须 >= MIN_RELEVANCE_SCORE
    /// 2. 相对阈值：分数必须 >= 最高分 * RELATIVE_SCORE_THRESHOLD
    fn filter_by_relevance(sources: Vec<SourceInfo>) -> Vec<SourceInfo> {
        if sources.is_empty() {
            return sources;
        }

        // 找出最高分
        let max_score = sources
            .iter()
            .filter_map(|s| s.score)
            .fold(0.0f32, |a, b| a.max(b));

        let relative_min = max_score * RELATIVE_SCORE_THRESHOLD;

        sources
            .into_iter()
            .filter(|s| {
                s.score
                    .map(|score| score >= MIN_RELEVANCE_SCORE && score >= relative_min)
                    .unwrap_or(false)
            })
            .collect()
    }

    /// 执行 VFS RAG 检索并发射事件
    ///
    /// 事件类型：`rag`
    ///
    /// ## 参数
    /// - `query`: 查询文本
    /// - `folder_ids`: 可选的文件夹 ID 列表（用于范围过滤）
    /// - `resource_types`: 可选的资源类型列表（如 ["note", "textbook"]）
    /// - `top_k`: 返回结果数量
    /// - `enable_reranking`: 是否启用重排序
    ///
    /// ## 返回
    /// 检索到的来源信息列表（失败时返回空列表）
    ///
    /// ## 事件
    /// 1. emit_start(event_types::RAG, message_id, block_id, None)
    /// 2. 执行检索
    /// 3. emit_end(event_types::RAG, block_id, Some(results)) 或 emit_error
    pub async fn search_vfs(
        &self,
        query: &str,
        folder_ids: Option<Vec<String>>,
        resource_types: Option<Vec<String>>,
        top_k: u32,
        enable_reranking: bool,
    ) -> Vec<SourceInfo> {
        let block_id = Self::generate_block_id();
        let start_time = std::time::Instant::now();

        // 1. 发射 start 事件
        self.emitter.emit_start(
            event_types::RAG,
            &self.message_id,
            Some(&block_id),
            Some(serde_json::json!({
                "query": query,
                "folderIds": folder_ids,
                "resourceTypes": resource_types,
                "topK": top_k,
                "enableReranking": enable_reranking,
                "source": "vfs",
            })),
            None, // variant_id
        );

        log::info!(
            "[ChatV2::VfsRagAdapter] Starting VFS search: query='{}', folders={:?}, types={:?}, top_k={}",
            query,
            folder_ids,
            resource_types,
            top_k
        );

        // 2. 构建搜索参数
        let params = VfsSearchParams {
            query: query.to_string(),
            folder_ids,
            resource_ids: None,
            resource_types,
            modality: MODALITY_TEXT.to_string(),
            top_k,
        };

        // 3. 执行检索
        let result = self
            .search_service
            .search_cross_dimension_with_resource_info(query, &params, enable_reranking)
            .await;

        let elapsed = start_time.elapsed();

        match result {
            Ok(search_results) => {
                // 4. 转换为 SourceInfo 并过滤低相关性结果
                let raw_sources: Vec<SourceInfo> = search_results
                    .iter()
                    .map(Self::vfs_result_to_source_info)
                    .collect();

                let sources = Self::filter_by_relevance(raw_sources);

                log::info!(
                    "[VfsRag] query='{}' | {} results | {}ms",
                    query.chars().take(50).collect::<String>(),
                    sources.len(),
                    elapsed.as_millis()
                );

                // 5. 发射 end 事件
                let result_payload = serde_json::json!({
                    "sources": sources,
                    "count": sources.len(),
                    "totalTimeMs": elapsed.as_millis(),
                    "source": "vfs",
                });

                self.emitter
                    .emit_end(event_types::RAG, &block_id, Some(result_payload), None);

                sources
            }
            Err(e) => {
                let error_msg = e.to_string();
                log::error!(
                    "[ChatV2::VfsRagAdapter] VFS search failed in {}ms: {}",
                    elapsed.as_millis(),
                    error_msg
                );

                // 发射 error 事件并返回空列表（不抛异常）
                self.emitter
                    .emit_error(event_types::RAG, &block_id, &error_msg, None);

                Vec::new()
            }
        }
    }

    /// 执行简化的 VFS RAG 检索（使用默认参数）
    ///
    /// ## 参数
    /// - `query`: 查询文本
    /// - `top_k`: 返回结果数量
    ///
    /// ## 返回
    /// 检索到的来源信息列表
    pub async fn search_simple(&self, query: &str, top_k: u32) -> Vec<SourceInfo> {
        self.search_vfs(query, None, None, top_k, true).await
    }

    /// 执行指定文件夹范围的 VFS RAG 检索
    ///
    /// ## 参数
    /// - `query`: 查询文本
    /// - `folder_ids`: 文件夹 ID 列表
    /// - `top_k`: 返回结果数量
    ///
    /// ## 返回
    /// 检索到的来源信息列表
    pub async fn search_in_folders(
        &self,
        query: &str,
        folder_ids: Vec<String>,
        top_k: u32,
    ) -> Vec<SourceInfo> {
        self.search_vfs(query, Some(folder_ids), None, top_k, true)
            .await
    }

    /// 执行指定资源类型的 VFS RAG 检索
    ///
    /// ## 参数
    /// - `query`: 查询文本
    /// - `resource_types`: 资源类型列表（如 ["note", "textbook", "exam"]）
    /// - `top_k`: 返回结果数量
    ///
    /// ## 返回
    /// 检索到的来源信息列表
    pub async fn search_by_types(
        &self,
        query: &str,
        resource_types: Vec<String>,
        top_k: u32,
    ) -> Vec<SourceInfo> {
        self.search_vfs(query, None, Some(resource_types), top_k, true)
            .await
    }
}

// ============================================================
// VFS RAG 服务工厂
// ============================================================

/// VFS RAG 服务工厂
///
/// 用于创建和管理 VfsFullSearchService 实例。
pub struct VfsRagServiceFactory;

impl VfsRagServiceFactory {
    /// 创建 VfsFullSearchService 实例
    pub fn create_search_service(
        vfs_db: Arc<VfsDatabase>,
        lance_store: Arc<VfsLanceStore>,
        llm_manager: Arc<LLMManager>,
    ) -> VfsFullSearchService {
        VfsFullSearchService::new(vfs_db, lance_store, llm_manager)
    }

    /// 创建 VfsLanceStore 实例
    pub fn create_lance_store(
        vfs_db: Arc<VfsDatabase>,
    ) -> Result<VfsLanceStore, crate::vfs::error::VfsError> {
        VfsLanceStore::new(vfs_db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_block_id() {
        let id1 = ChatV2VfsRagAdapter::generate_block_id();
        let id2 = ChatV2VfsRagAdapter::generate_block_id();

        assert!(id1.starts_with("blk_"));
        assert!(id2.starts_with("blk_"));
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_filter_by_relevance_empty() {
        let sources: Vec<SourceInfo> = vec![];
        let filtered = ChatV2VfsRagAdapter::filter_by_relevance(sources);
        assert!(filtered.is_empty());
    }

    #[test]
    fn test_filter_by_relevance_filters_low_scores() {
        let sources = vec![
            SourceInfo {
                title: Some("High".to_string()),
                url: None,
                snippet: Some("text".to_string()),
                score: Some(0.9),
                metadata: None,
            },
            SourceInfo {
                title: Some("Medium".to_string()),
                url: None,
                snippet: Some("text".to_string()),
                score: Some(0.5),
                metadata: None,
            },
            SourceInfo {
                title: Some("Low".to_string()),
                url: None,
                snippet: Some("text".to_string()),
                score: Some(0.2), // 低于 MIN_RELEVANCE_SCORE
                metadata: None,
            },
        ];

        let filtered = ChatV2VfsRagAdapter::filter_by_relevance(sources);

        // 0.2 < MIN_RELEVANCE_SCORE (0.3) 所以被过滤
        // 0.5 >= 0.9 * 0.5 = 0.45 所以保留
        assert_eq!(filtered.len(), 2);
        assert!(filtered
            .iter()
            .all(|s| s.score.unwrap() >= MIN_RELEVANCE_SCORE));
    }

    #[test]
    fn test_filter_by_relevance_relative_threshold() {
        let sources = vec![
            SourceInfo {
                title: Some("High".to_string()),
                url: None,
                snippet: Some("text".to_string()),
                score: Some(1.0),
                metadata: None,
            },
            SourceInfo {
                title: Some("Below relative".to_string()),
                url: None,
                snippet: Some("text".to_string()),
                score: Some(0.4), // >= 0.3 但 < 1.0 * 0.5 = 0.5
                metadata: None,
            },
        ];

        let filtered = ChatV2VfsRagAdapter::filter_by_relevance(sources);

        // 0.4 < 1.0 * RELATIVE_SCORE_THRESHOLD (0.5) 所以被过滤
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].score, Some(1.0));
    }
}
