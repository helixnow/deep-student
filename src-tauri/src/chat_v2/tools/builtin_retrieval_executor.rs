//! 内置检索工具执行器
//!
//! ★ 2026-01 简化：VFS RAG 作为唯一知识检索方案（支持多模态）
//!
//! 执行五个内置检索工具：
//! - `builtin-rag_search` - 知识检索（统一使用 VFS RAG）
//! - `builtin-multimodal_search` - 多模态检索（图片/PDF 页面）
//! - `builtin-unified_search` - 统一检索（同时搜索文本和多模态内容）
//! - `builtin-memory_search` - 用户记忆检索（独立实现）
//! - `builtin-web_search` - 网络搜索
//!
//! ## 设计说明
//! 该执行器将预调用模式的检索工具转换为 LLM 可主动调用的 MCP 工具。
//! 复用现有的检索逻辑，但通过 ToolExecutor trait 接口执行。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{SourceInfo, ToolCall, ToolResultInfo};
use crate::tools::web_search::{do_search, SearchInput, ToolConfig as WebSearchConfig};
use crate::vfs::VfsResourceRepo;

/// 内置工具命名空间前缀
/// 🔧 使用 'builtin-' 而非 'builtin:' 以兼容 DeepSeek/OpenAI API 的工具名称限制
/// API 要求工具名称符合正则 ^[a-zA-Z0-9_-]+$，不允许冒号
pub const BUILTIN_NAMESPACE: &str = "builtin-";

/// RAG 检索最小分数阈值
const RETRIEVAL_MIN_SCORE: f32 = 0.3;
/// RAG 检索相对分数阈值（相对于最高分）
const RETRIEVAL_RELATIVE_THRESHOLD: f32 = 0.5;
const DEFAULT_RAG_TOP_K: u32 = 10;

// ============================================================================
// 内置检索工具执行器
// ============================================================================

/// 内置检索工具执行器
///
/// ★ 2026-01 简化：VFS RAG 作为唯一知识检索方案（支持多模态）
///
/// 处理以 `builtin-` 开头的检索工具：
/// - `builtin-rag_search` - 知识检索（统一使用 VFS RAG）
/// - `builtin-multimodal_search` - 多模态检索（图片/PDF 页面）
/// - `builtin-unified_search` - 统一检索（同时搜索文本和多模态内容）
/// - `builtin-memory_search` - 用户记忆检索（独立实现）
/// - `builtin-web_search` - 网络搜索
///
/// ## 与预调用模式的区别
/// - 预调用模式：在 LLM 调用前自动执行，结果注入到系统提示
/// - 工具调用模式：LLM 主动决定何时调用，结果作为工具输出返回
pub struct BuiltinRetrievalExecutor;

impl BuiltinRetrievalExecutor {
    /// 创建新的内置检索工具执行器
    pub fn new() -> Self {
        Self
    }

    /// 执行 VFS RAG 知识检索（统一方案）
    async fn execute_vfs_rag(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        use crate::vfs::indexing::{VfsFullSearchService, VfsSearchParams};
        use crate::vfs::lance_store::VfsLanceStore;
        use crate::vfs::repos::{VfsBlobRepo, VfsResourceRepo, MODALITY_TEXT};
        use std::collections::HashMap;

        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("VFS RAG search cancelled before start".to_string());
        }

        // 解析参数
        let query = call
            .arguments
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'query' parameter")?;
        let folder_ids: Option<Vec<String>> = call
            .arguments
            .get("folder_ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        // 🆕 精确到特定资源的过滤
        let resource_ids: Option<Vec<String>> = call
            .arguments
            .get("resource_ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        let resource_types: Option<Vec<String>> = call
            .arguments
            .get("resource_types")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        let top_k = call
            .arguments
            .get("top_k")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .or(ctx.rag_top_k)
            .unwrap_or(DEFAULT_RAG_TOP_K);
        let max_per_resource = call
            .arguments
            .get("max_per_resource")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        let enable_reranking = call
            .arguments
            .get("enable_reranking")
            .and_then(|v| v.as_bool())
            .or(ctx.rag_enable_reranking)
            .unwrap_or(true);

        // 发射 start 事件
        ctx.emitter.emit_start(
            event_types::RAG,
            &ctx.message_id,
            Some(&ctx.block_id),
            Some(json!({
                "query": query,
                "folder_ids": folder_ids,
                "resource_ids": resource_ids,
                "resource_types": resource_types,
                "max_per_resource": max_per_resource,
                "source": "vfs_rag"
            })),
            None,
        );

        let start_time = Instant::now();

        // 获取 VFS 数据库
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 创建 Lance 存储
        let lance_store = std::sync::Arc::new(
            VfsLanceStore::new(std::sync::Arc::clone(vfs_db))
                .map_err(|e| format!("Failed to create Lance store: {}", e))?,
        );

        // 获取 LLM 管理器
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM manager not available")?;

        // 创建搜索服务
        let search_service = VfsFullSearchService::new(
            std::sync::Arc::clone(vfs_db),
            lance_store,
            std::sync::Arc::clone(llm_manager),
        );

        // 构建搜索参数
        let params = VfsSearchParams {
            query: query.to_string(),
            folder_ids,
            resource_ids,
            resource_types,
            modality: MODALITY_TEXT.to_string(),
            top_k,
        };

        // 🆕 取消检查：在执行检索前检查
        if ctx.is_cancelled() {
            return Err("VFS RAG search cancelled before search".to_string());
        }

        // 执行检索（支持取消）
        // ★ 2026-02-10 修复：使用跨维度搜索，与 vfs_rag_search Tauri handler 保持一致
        // 普通搜索 search_with_resource_info 只搜索当前默认嵌入模型的维度，
        // 如果默认模型维度（如 768d）与索引维度（如 1024d）不一致，会返回 0 条结果。
        // 跨维度搜索遍历所有有数据的维度，确保能命中已索引的内容。
        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = search_service.search_cross_dimension_with_resource_info(query, &params, enable_reranking) => res,
                _ = cancel_token.cancelled() => {
                    log::info!("[BuiltinRetrievalExecutor] VFS RAG search cancelled");
                    return Err("VFS RAG search cancelled during execution".to_string());
                }
            }
        } else {
            search_service
                .search_cross_dimension_with_resource_info(query, &params, enable_reranking)
                .await
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(vfs_results) => {
                // 🆕 per-document 去重过滤
                let filtered_results = if max_per_resource > 0 {
                    let mut resource_count: HashMap<String, usize> = HashMap::new();
                    vfs_results
                        .into_iter()
                        .filter(|r| {
                            let count = resource_count.entry(r.resource_id.clone()).or_insert(0);
                            if *count < max_per_resource {
                                *count += 1;
                                true
                            } else {
                                false
                            }
                        })
                        .collect::<Vec<_>>()
                } else {
                    vfs_results
                };

                // 转换为 SourceInfo 格式，并获取图片 URL
                let mut sources: Vec<SourceInfo> = Vec::new();
                for r in filtered_results {
                    // 🔧 修复：优先使用 external_hash 获取 blob 文件路径；inline 图片转 data URL
                    let image_url = VfsResourceRepo::get_resource(vfs_db, &r.resource_id)
                        .ok()
                        .flatten()
                        .and_then(|res| {
                            use crate::vfs::types::VfsResourceType;
                            let mime_type = res.metadata.as_ref().and_then(|m| m.mime_type.clone());
                            if res.resource_type == VfsResourceType::Image {
                                if let Some(hash) = res.external_hash.as_ref() {
                                    VfsBlobRepo::get_blob_path(vfs_db, hash)
                                        .ok()
                                        .flatten()
                                        .map(|p| p.to_string_lossy().to_string())
                                } else if let Some(base64) = res.data.as_deref() {
                                    let mime = mime_type.as_deref().unwrap_or("image/png");
                                    Some(format!("data:{};base64,{}", mime, base64))
                                } else {
                                    None
                                }
                            } else {
                                // 非图片资源：尝试从 extra 字段获取缩略图 URL
                                res.metadata.as_ref().and_then(|m| {
                                    m.extra.as_ref().and_then(|e| {
                                        e.get("thumbnailUrl")
                                            .and_then(|v| v.as_str().map(String::from))
                                    })
                                })
                            }
                        });

                    // 构建图片引用标记（如果有图片 URL）
                    let image_citation = image_url.as_ref().map(|url| {
                        format!(
                            "![{}]({})",
                            r.resource_title.as_deref().unwrap_or("图片"),
                            url
                        )
                    });

                    sources.push(SourceInfo {
                        title: r.resource_title,
                        url: image_url.clone(),
                        snippet: Some(r.chunk_text),
                        score: Some(r.score as f32),
                        metadata: Some(json!({
                            "resourceId": r.resource_id,
                            "sourceId": r.source_id,
                            "resourceType": r.resource_type,
                            "chunkIndex": r.chunk_index,
                            "embeddingId": r.embedding_id,
                            "pageIndex": r.page_index,
                            "sourceType": "vfs_rag",
                            "imageUrl": image_url,
                            "imageCitation": image_citation,
                        })),
                    });
                }

                // 发射 end 事件
                ctx.emitter.emit_end(
                    event_types::RAG,
                    &ctx.block_id,
                    Some(json!({
                        "sources": sources,
                        "durationMs": duration,
                        "source": "vfs_rag",
                    })),
                    None,
                );

                log::debug!(
                    "[BuiltinRetrievalExecutor] VFS RAG search completed: {} sources in {}ms",
                    sources.len(),
                    duration
                );

                // 构建带编号的来源列表，便于 LLM 引用
                let numbered_sources: Vec<Value> = sources
                    .iter()
                    .enumerate()
                    .map(|(i, s)| {
                        let meta = s.metadata.as_ref();
                        let image_url = meta
                            .and_then(|m| m.get("imageUrl"))
                            .and_then(|v| v.as_str());
                        let image_citation = meta
                            .and_then(|m| m.get("imageCitation"))
                            .and_then(|v| v.as_str());
                        let page_index = meta
                            .and_then(|m| m.get("pageIndex"))
                            .and_then(|v| v.as_i64());
                        let resource_id = meta
                            .and_then(|m| m.get("resourceId"))
                            .and_then(|v| v.as_str());
                        let source_id = meta
                            .and_then(|m| m.get("sourceId"))
                            .and_then(|v| v.as_str());

                        json!({
                            "index": i + 1,
                            "citationTag": format!("[知识库-{}]", i + 1),
                            "title": s.title,
                            "url": s.url,
                            "snippet": s.snippet,
                            "score": s.score,
                            "imageUrl": image_url,
                            "imageCitation": image_citation,
                            "pageIndex": page_index,
                            "resourceId": resource_id,
                            "sourceId": source_id,
                        })
                    })
                    .collect();

                Ok(json!({
                    "success": true,
                    "sources": numbered_sources,
                    "count": sources.len(),
                    "durationMs": duration,
                    "source": "vfs_rag",
                    "citationGuide": "引用方式：[知识库-N] 显示角标，[知识库-N:图片] 渲染对应 PDF 页面图片。结果中 pageIndex 字段不为空时表示有图片可渲染。禁止输出 URL 或 Markdown 图片语法。"
                }))
            }
            Err(e) => {
                let error_msg = e.to_string();
                ctx.emitter
                    .emit_error(event_types::RAG, &ctx.block_id, &error_msg, None);
                Err(error_msg)
            }
        }
    }

    /// 兼容存根：memory_search 已迁移至 builtin-memory_search（由 MemoryToolExecutor 处理）
    async fn execute_memory(
        &self,
        _call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        log::warn!("[BuiltinRetrievalExecutor] memory_search is deprecated, use builtin-memory_search instead");

        ctx.emitter.emit_end(
            event_types::MEMORY,
            &ctx.block_id,
            Some(json!({
                "deprecated": true,
                "message": "请使用 builtin-memory_search 工具（由 MemoryToolExecutor 处理）"
            })),
            None,
        );

        Ok(json!({
            "success": false,
            "deprecated": true,
            "error": "memory_search 已废弃，请使用 builtin-memory_search 工具"
        }))
    }

    /// 执行多模态检索（图片/PDF 页面）
    ///
    /// ★ 2026-01 VFS 多模态统一管理：使用 VfsMultimodalService
    /// - 数据存储在 `vfs_emb_multimodal_{dim}` 表
    /// - 通过 `vfs_multimodal_index` Tauri 命令索引
    /// - 通过 `vfs_multimodal_search` Tauri 命令检索
    async fn execute_multimodal_search(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        use crate::vfs::lance_store::VfsLanceStore;
        use crate::vfs::multimodal_service::VfsMultimodalService;
        use crate::vfs::repos::VfsBlobRepo;
        use std::collections::HashMap;

        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Multimodal search cancelled before start".to_string());
        }

        // 解析参数
        let query = call
            .arguments
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'query' parameter")?;
        let folder_ids: Option<Vec<String>> = call
            .arguments
            .get("folder_ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        // 🔧 批判性检查修复：解析 resource_ids 参数
        let resource_ids: Option<Vec<String>> = call
            .arguments
            .get("resource_ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        let resource_types: Option<Vec<String>> = call
            .arguments
            .get("resource_types")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        let top_k = call
            .arguments
            .get("top_k")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_RAG_TOP_K as u64) as usize;
        // 🔧 批判性检查修复：解析 max_per_resource 参数
        let max_per_resource = call
            .arguments
            .get("max_per_resource")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;

        // 发射 start 事件
        ctx.emitter.emit_start(
            event_types::MULTIMODAL_RAG,
            &ctx.message_id,
            Some(&ctx.block_id),
            Some(json!({
                "query": query,
                "folder_ids": folder_ids,
                "resource_ids": resource_ids,
                "max_per_resource": max_per_resource,
                "source": "multimodal_search"
            })),
            None,
        );

        let start_time = Instant::now();

        // 获取必要的上下文
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM manager not available")?;
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 检查多模态 RAG 是否配置
        if !llm_manager.is_multimodal_rag_configured().await {
            let error_msg = "未配置多模态嵌入模型，请在设置中配置 VL Embedding 模型";
            ctx.emitter
                .emit_error(event_types::MULTIMODAL_RAG, &ctx.block_id, error_msg, None);
            return Err(error_msg.to_string());
        }

        // 创建 VFS Lance Store
        let lance_store = std::sync::Arc::new(
            VfsLanceStore::new(std::sync::Arc::clone(vfs_db))
                .map_err(|e| format!("Failed to create VFS Lance store: {}", e))?,
        );

        // 创建 VFS 多模态服务
        let service = VfsMultimodalService::new(
            std::sync::Arc::clone(vfs_db),
            std::sync::Arc::clone(llm_manager),
            lance_store,
        );

        // 🆕 取消检查：在执行检索前检查
        if ctx.is_cancelled() {
            return Err("Multimodal search cancelled before search".to_string());
        }

        // 执行检索（支持取消）
        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = service.search_full(
                    query,
                    top_k,
                    folder_ids.as_deref(),
                    resource_ids.as_deref(),
                    resource_types.as_deref(),
                ) => res,
                _ = cancel_token.cancelled() => {
                    log::info!("[BuiltinRetrievalExecutor] Multimodal search cancelled");
                    return Err("Multimodal search cancelled during execution".to_string());
                }
            }
        } else {
            service
                .search_full(
                    query,
                    top_k,
                    folder_ids.as_deref(),
                    resource_ids.as_deref(),
                    resource_types.as_deref(),
                )
                .await
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(results) => {
                // 🔧 批判性检查修复：per-document 去重过滤
                let filtered_results = if max_per_resource > 0 {
                    let mut resource_count: HashMap<String, usize> = HashMap::new();
                    results
                        .into_iter()
                        .filter(|r| {
                            let count = resource_count.entry(r.resource_id.clone()).or_insert(0);
                            if *count < max_per_resource {
                                *count += 1;
                                true
                            } else {
                                false
                            }
                        })
                        .collect::<Vec<_>>()
                } else {
                    results
                };

                // 转换为 SourceInfo 格式，并获取实际的图片文件路径
                let mut sources: Vec<SourceInfo> = Vec::new();
                for r in &filtered_results {
                    let page_display = r.page_index + 1;

                    // 🔧 修复：通过 blob_hash 获取实际的图片文件路径
                    let image_url = r.blob_hash.as_ref().and_then(|hash| {
                        VfsBlobRepo::get_blob_path(vfs_db, hash)
                            .ok()
                            .flatten()
                            .map(|p| p.to_string_lossy().to_string())
                    });

                    // 构建图片引用标记
                    let image_citation = image_url
                        .as_ref()
                        .map(|url| format!("![Page {}]({})", page_display, url));

                    // ★ 2026-01-26: 通过 resource_id 获取 source_id（DSTU 格式 ID）
                    let source_id = VfsResourceRepo::get_resource(vfs_db, &r.resource_id)
                        .ok()
                        .flatten()
                        .and_then(|res| res.source_id);

                    sources.push(SourceInfo {
                        title: Some(format!("Page {} - {}", page_display, r.resource_type)),
                        url: image_url.clone(),
                        snippet: r.text_content.clone(),
                        score: Some(r.score),
                        metadata: Some(json!({
                            "resourceType": r.resource_type,
                            "resourceId": r.resource_id,
                            "sourceId": source_id,
                            "pageIndex": r.page_index,
                            "blobHash": r.blob_hash,
                            "folderId": r.folder_id,
                            "imageUrl": image_url,
                            "imageCitation": image_citation,
                        })),
                    });
                }

                // 发射 end 事件
                ctx.emitter.emit_end(
                    event_types::MULTIMODAL_RAG,
                    &ctx.block_id,
                    Some(json!({
                        "sources": sources,
                        "durationMs": duration,
                        "source": "multimodal_search",
                    })),
                    None,
                );

                log::debug!(
                    "[BuiltinRetrievalExecutor] VFS Multimodal search completed: {} sources in {}ms",
                    sources.len(),
                    duration
                );

                // 构建带编号的来源列表，便于 LLM 引用
                let numbered_sources: Vec<Value> = sources
                    .iter()
                    .enumerate()
                    .map(|(i, s)| {
                        let meta = s.metadata.as_ref();
                        let image_url = meta
                            .and_then(|m| m.get("imageUrl"))
                            .and_then(|v| v.as_str());
                        let image_citation = meta
                            .and_then(|m| m.get("imageCitation"))
                            .and_then(|v| v.as_str());
                        let page_index = meta
                            .and_then(|m| m.get("pageIndex"))
                            .and_then(|v| v.as_i64());
                        let resource_id = meta
                            .and_then(|m| m.get("resourceId"))
                            .and_then(|v| v.as_str());
                        let source_id = meta
                            .and_then(|m| m.get("sourceId"))
                            .and_then(|v| v.as_str());

                        json!({
                            "index": i + 1,
                            "citationTag": format!("[图片-{}]", i + 1),
                            "title": s.title,
                            "url": s.url,
                            "snippet": s.snippet,
                            "score": s.score,
                            "imageUrl": image_url,
                            "imageCitation": image_citation,
                            "pageIndex": page_index,
                            "resourceId": resource_id,
                            "sourceId": source_id,
                        })
                    })
                    .collect();

                Ok(json!({
                    "success": true,
                    "sources": numbered_sources,
                    "count": sources.len(),
                    "durationMs": duration,
                    "source": "multimodal_search",
                    "citationGuide": "引用方式：[图片-N] 显示角标，[图片-N:图片] 渲染对应页面图片。结果中 pageIndex 字段不为空时表示有图片可渲染。禁止输出 URL 或 Markdown 图片语法。"
                }))
            }
            Err(e) => {
                let error_msg = e.to_string();
                ctx.emitter.emit_error(
                    event_types::MULTIMODAL_RAG,
                    &ctx.block_id,
                    &error_msg,
                    None,
                );
                Err(error_msg)
            }
        }
    }

    /// 执行统一检索（同时搜索文本和多模态内容）
    ///
    /// ★ 2026-01 VFS 统一管理：
    /// - VFS 文本搜索：`vfs_emb_text_{dim}` 表
    /// - VFS 多模态搜索：`vfs_emb_multimodal_{dim}` 表
    async fn execute_unified_search(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        use crate::memory::service::MemoryService;
        use crate::vfs::indexing::{VfsFullSearchService, VfsSearchParams};
        use crate::vfs::lance_store::VfsLanceStore;
        use crate::vfs::multimodal_service::VfsMultimodalService;
        use crate::vfs::repos::{VfsBlobRepo, MODALITY_TEXT};
        use std::collections::HashMap;

        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Unified search cancelled before start".to_string());
        }

        // 解析参数
        let query = call
            .arguments
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'query' parameter")?;
        let folder_ids: Option<Vec<String>> = call
            .arguments
            .get("folder_ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        // 🔧 批判性检查修复：解析 resource_ids 参数
        let resource_ids: Option<Vec<String>> = call
            .arguments
            .get("resource_ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        let resource_types: Option<Vec<String>> = call
            .arguments
            .get("resource_types")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        let top_k = call
            .arguments
            .get("top_k")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_RAG_TOP_K as u64) as usize;
        // 🔧 批判性检查修复：解析 max_per_resource 参数
        let max_per_resource = call
            .arguments
            .get("max_per_resource")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        let _enable_reranking = call
            .arguments
            .get("enable_reranking")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        // 发射 start 事件
        ctx.emitter.emit_start(
            event_types::RAG,
            &ctx.message_id,
            Some(&ctx.block_id),
            Some(json!({
                "query": query,
                "folder_ids": folder_ids,
                "resource_ids": resource_ids,
                "resource_types": resource_types,
                "max_per_resource": max_per_resource,
                "source": "unified_search"
            })),
            None,
        );

        let start_time = Instant::now();
        let mut all_sources: Vec<SourceInfo> = Vec::new();
        // ★ 2026-05 hybrid RAG：将文本与多模态分别收集到独立池，
        //   稍后用 RRF 融合 + VL-Reranker 精排，最后再与记忆合并。
        let mut kb_text_pool: Vec<SourceInfo> = Vec::new();
        let mut kb_mm_pool: Vec<SourceInfo> = Vec::new();

        // 获取必要的上下文
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM manager not available")?;

        // ========== 0. 预计算 query embedding（全局复用） ==========
        if ctx.is_cancelled() {
            return Err("Unified search cancelled before text search".to_string());
        }

        let lance_store = ctx
            .vfs_lance_store
            .clone()
            .map(Ok)
            .unwrap_or_else(|| {
                VfsLanceStore::new(std::sync::Arc::clone(vfs_db)).map(std::sync::Arc::new)
            })
            .map_err(|e| format!("Failed to create Lance store: {}", e))?;

        let search_service = VfsFullSearchService::new(
            std::sync::Arc::clone(vfs_db),
            std::sync::Arc::clone(&lance_store),
            std::sync::Arc::clone(llm_manager),
        );

        let shared_embedding = search_service
            .generate_query_embedding(query)
            .await
            .map_err(|e| format!("Failed to generate query embedding: {}", e))?;

        // ========== 1. VFS 文本搜索（复用 shared_embedding） ==========
        let text_params = VfsSearchParams {
            query: query.to_string(),
            folder_ids: folder_ids.clone(),
            resource_ids: resource_ids.clone(),
            resource_types: resource_types.clone(),
            modality: MODALITY_TEXT.to_string(),
            top_k: top_k as u32,
        };

        let text_result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = search_service.search_with_embedding(query, &shared_embedding, &text_params, false) => res.ok(),
                _ = cancel_token.cancelled() => {
                    log::info!("[BuiltinRetrievalExecutor] Unified search cancelled during text search");
                    return Err("Unified search cancelled during text search".to_string());
                }
            }
        } else {
            search_service
                .search_with_embedding(query, &shared_embedding, &text_params, false)
                .await
                .ok()
        };

        // 获取记忆文件夹下所有资源 ID 集合，从文本搜索结果中排除（源头去重）。
        // 这比事后跨源去重更可靠：不依赖 sourceId/title 匹配。
        let memory_resource_ids: std::collections::HashSet<String> = {
            let memory_service = MemoryService::new(
                std::sync::Arc::clone(vfs_db),
                std::sync::Arc::clone(&lance_store),
                std::sync::Arc::clone(llm_manager),
            );
            memory_service
                .get_root_folder_id()
                .ok()
                .flatten()
                .and_then(|root_id| {
                    use crate::vfs::repos::folder_repo::VfsFolderRepo;
                    let folder_ids =
                        VfsFolderRepo::get_folder_ids_recursive(vfs_db, &root_id).ok()?;
                    if folder_ids.is_empty() {
                        return None;
                    }
                    let conn = vfs_db.get_conn_safe().ok()?;
                    let placeholders = vec!["?"; folder_ids.len()].join(", ");
                    let sql = format!(
                        "SELECT DISTINCT n.resource_id FROM notes n \
                         JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id \
                         WHERE fi.folder_id IN ({}) AND n.deleted_at IS NULL",
                        placeholders
                    );
                    let mut stmt = conn.prepare(&sql).ok()?;
                    let params_vals: Vec<rusqlite::types::Value> = folder_ids
                        .into_iter()
                        .map(rusqlite::types::Value::from)
                        .collect();
                    let rows = stmt
                        .query_map(rusqlite::params_from_iter(params_vals), |row| {
                            row.get::<_, String>(0)
                        })
                        .ok()?;
                    Some(rows.filter_map(|r| r.ok()).collect())
                })
                .unwrap_or_default()
        };

        if let Some(vfs_results) = text_result {
            let text_sources: Vec<SourceInfo> = vfs_results
                .into_iter()
                .filter(|r| {
                    if memory_resource_ids.is_empty() {
                        return true;
                    }
                    !memory_resource_ids.contains(&r.resource_id)
                })
                .map(|r| SourceInfo {
                    title: r.resource_title,
                    url: None,
                    snippet: Some(r.chunk_text),
                    score: Some(r.score as f32),
                    metadata: Some(json!({
                        "resourceId": r.resource_id,
                        "sourceId": r.source_id,
                        "resourceType": r.resource_type,
                        "chunkIndex": r.chunk_index,
                        "embeddingId": r.embedding_id,
                        "sourceType": "text_search",
                    })),
                })
                .collect();
            kb_text_pool.extend(text_sources);
        }

        // ========== 2. VFS 多模态搜索（如果配置了） ==========
        // 🆕 取消检查：在多模态搜索前检查
        if ctx.is_cancelled() {
            return Err("Unified search cancelled before multimodal search".to_string());
        }

        if llm_manager.is_multimodal_rag_configured().await {
            // 创建 VFS 多模态服务
            let mm_service = VfsMultimodalService::new(
                std::sync::Arc::clone(vfs_db),
                std::sync::Arc::clone(llm_manager),
                std::sync::Arc::clone(&lance_store),
            );

            // 🔧 批判性检查修复：传递 resource_ids 参数
            // 多模态搜索（支持取消）
            let mm_result = if let Some(cancel_token) = ctx.cancellation_token() {
                tokio::select! {
                    res = mm_service.search_full(
                        query,
                        top_k,
                        folder_ids.as_deref(),
                        resource_ids.as_deref(),
                        resource_types.as_deref(),
                    ) => res.ok(),
                    _ = cancel_token.cancelled() => {
                        log::info!("[BuiltinRetrievalExecutor] Unified search cancelled during multimodal search");
                        return Err("Unified search cancelled during multimodal search".to_string());
                    }
                }
            } else {
                mm_service
                    .search_full(
                        query,
                        top_k,
                        folder_ids.as_deref(),
                        resource_ids.as_deref(),
                        resource_types.as_deref(),
                    )
                    .await
                    .ok()
            };

            if let Some(mm_results) = mm_result {
                // 🔧 修复：为多模态结果获取实际的图片文件路径
                for r in &mm_results {
                    let page_display = r.page_index + 1;

                    // 通过 blob_hash 获取实际的图片文件路径
                    let image_url = r.blob_hash.as_ref().and_then(|hash| {
                        VfsBlobRepo::get_blob_path(vfs_db, hash)
                            .ok()
                            .flatten()
                            .map(|p| p.to_string_lossy().to_string())
                    });

                    // 构建图片引用标记
                    let image_citation = image_url
                        .as_ref()
                        .map(|url| format!("![Page {}]({})", page_display, url));

                    // ★ 2026-01-26: 通过 resource_id 获取 source_id（DSTU 格式 ID）
                    let source_id = VfsResourceRepo::get_resource(vfs_db, &r.resource_id)
                        .ok()
                        .flatten()
                        .and_then(|res| res.source_id);

                    kb_mm_pool.push(SourceInfo {
                        title: Some(format!("Page {} - {}", page_display, r.resource_type)),
                        url: image_url.clone(),
                        snippet: r.text_content.clone(),
                        score: Some(r.score),
                        metadata: Some(json!({
                            "resourceType": r.resource_type,
                            "resourceId": r.resource_id,
                            "sourceId": source_id,
                            "pageIndex": r.page_index,
                            "blobHash": r.blob_hash,
                            "folderId": r.folder_id,
                            "sourceType": "multimodal_search",
                            "imageUrl": image_url,
                            "imageCitation": image_citation,
                        })),
                    });
                }
            }
        }

        // ========== 2.6 hybrid RAG：RRF 融合 + VL-Reranker 跨模态精排 ==========
        // 业界最佳实践（2025-2026）：
        //   1. 双路独立召回（已完成）
        //   2. RRF（Reciprocal Rank Fusion，k=60）合并不同向量空间结果
        //      —— 基于 rank 而非分数，天然解决跨模态分数不可比问题
        //   3. 统一跨模态 reranker（VL-Reranker）对融合结果精排
        //      —— Qwen3-VL-Reranker 同时支持纯文本和图文输入
        //
        // 配置开关：tool 参数 `enable_reranking`（默认 true）
        let kb_text_count = kb_text_pool.len();
        let kb_mm_count = kb_mm_pool.len();
        let fused_kb: Vec<SourceInfo> = if kb_text_count == 0 && kb_mm_count == 0 {
            Vec::new()
        } else {
            // RRF 融合（top_k * 3 作为融合候选数，给精排留余量）
            let merge_top_k = (top_k * 3).max(top_k).max(20);
            let mut input_lists: Vec<Vec<SourceInfo>> = Vec::with_capacity(2);
            if !kb_text_pool.is_empty() {
                input_lists.push(kb_text_pool);
            }
            if !kb_mm_pool.is_empty() {
                input_lists.push(kb_mm_pool);
            }
            let fused = rrf_fuse_sources(input_lists, merge_top_k);
            log::debug!(
                "[hybrid-rag] RRF 融合: text={} mm={} -> {} 候选",
                kb_text_count,
                kb_mm_count,
                fused.len()
            );

            // VL-Reranker 跨模态精排（如果配置且未禁用）
            if _enable_reranking && !fused.is_empty() {
                if ctx.is_cancelled() {
                    return Err("Unified search cancelled before reranking".to_string());
                }
                if let Some(cancel_token) = ctx.cancellation_token() {
                    tokio::select! {
                        reranked = vl_rerank_sources(query, fused, top_k, llm_manager, vfs_db) => reranked,
                        _ = cancel_token.cancelled() => {
                            log::info!("[hybrid-rag] Unified search cancelled during reranking");
                            return Err("Unified search cancelled during reranking".to_string());
                        }
                    }
                } else {
                    vl_rerank_sources(query, fused, top_k, llm_manager, vfs_db).await
                }
            } else {
                let mut out = fused;
                out.truncate(top_k);
                out
            }
        };
        all_sources.extend(fused_kb);

        // ========== 2.5 用户记忆搜索 ==========
        // 🆕 取消检查：在记忆搜索前检查
        if ctx.is_cancelled() {
            return Err("Unified search cancelled before memory search".to_string());
        }

        // 记忆搜索（复用 shared_embedding，忽略错误，不影响主流程）
        {
            let memory_service = MemoryService::new(
                std::sync::Arc::clone(vfs_db),
                std::sync::Arc::clone(&lance_store),
                std::sync::Arc::clone(llm_manager),
            );

            let memory_top_k = (top_k / 2).max(3).min(10);

            let memory_result = if let Some(cancel_token) = ctx.cancellation_token() {
                tokio::select! {
                    res = memory_service.search_with_embedding(query, &shared_embedding, memory_top_k) => {
                        res.map_err(|e| {
                            log::warn!("[BuiltinRetrievalExecutor] Unified memory search failed: {}", e);
                            e
                        }).ok()
                    },
                    _ = cancel_token.cancelled() => {
                        log::info!("[BuiltinRetrievalExecutor] Unified search cancelled during memory search");
                        None
                    }
                }
            } else {
                memory_service
                    .search_with_embedding(query, &shared_embedding, memory_top_k)
                    .await
                    .map_err(|e| {
                        log::warn!(
                            "[BuiltinRetrievalExecutor] Unified memory search failed: {}",
                            e
                        );
                        e
                    })
                    .ok()
            };

            if let Some(memory_results) = memory_result {
                let memory_count = memory_results.len();

                let compressor =
                    crate::memory::MemoryCompressor::new(std::sync::Arc::clone(llm_manager));
                let compressed = compressor.compress(query, &memory_results).await;

                for r in compressed {
                    all_sources.push(SourceInfo {
                        title: Some(r.note_title),
                        url: None,
                        snippet: Some(r.chunk_text),
                        score: Some(r.score),
                        metadata: Some(json!({
                            "sourceType": "memory",
                            "noteId": r.note_id,
                            "folderPath": r.folder_path,
                        })),
                    });
                }
                log::debug!(
                    "[BuiltinRetrievalExecutor] Memory search in unified: {} results (compressed)",
                    memory_count
                );
            }
        }

        // ========== 3. 合并、排序、截断（保底记忆槽位） ==========
        // ★ 修复记忆淹没问题：
        //   - 问题1：VFS 文本搜索未排除记忆文件夹，同一条记忆可能重复出现
        //   - 问题2：纯分数排序导致记忆条目被大量知识库内容挤出 top_k
        //   - 问题3：独立归一化的分数不可直接比较
        // 方案：分区合并 + 保底槽位 + 跨源去重

        let score_cmp = |a: &SourceInfo, b: &SourceInfo| {
            b.score
                .unwrap_or(0.0)
                .partial_cmp(&a.score.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        };

        // 3a. 分区：记忆 vs 知识库/多模态
        let (mut memory_sources, mut kb_sources): (Vec<_>, Vec<_>) =
            all_sources.into_iter().partition(|s| {
                s.metadata
                    .as_ref()
                    .and_then(|m| m.get("sourceType"))
                    .and_then(|v| v.as_str())
                    == Some("memory")
            });

        // 3b. 跨源去重：从知识库结果中移除与记忆重复的 VFS 笔记
        //     记忆笔记同时被索引在 VFS 中，Step 1 可能返回同一条记忆作为 text_search 结果。
        //     优先使用 noteId 精确匹配，回退到标题匹配。
        if !memory_sources.is_empty() {
            let memory_note_ids: std::collections::HashSet<String> = memory_sources
                .iter()
                .filter_map(|s| {
                    s.metadata
                        .as_ref()
                        .and_then(|m| m.get("noteId"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect();
            let memory_titles: std::collections::HashSet<String> = memory_sources
                .iter()
                .filter_map(|s| s.title.clone())
                .collect();

            let before_dedup = kb_sources.len();
            kb_sources.retain(|s| {
                let meta = s.metadata.as_ref();
                let is_note = meta
                    .and_then(|m| m.get("resourceType"))
                    .and_then(|v| v.as_str())
                    == Some("note");
                if !is_note {
                    return true;
                }
                let source_id = meta
                    .and_then(|m| m.get("sourceId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !source_id.is_empty() && memory_note_ids.contains(source_id) {
                    return false;
                }
                !s.title
                    .as_ref()
                    .map_or(false, |t| memory_titles.contains(t))
            });
            let deduped = before_dedup - kb_sources.len();
            if deduped > 0 {
                log::debug!(
                    "[BuiltinRetrievalExecutor] Deduped {} memory notes from KB results (noteId+title match)",
                    deduped
                );
            }
        }

        // 3c. 各自按分数排序
        memory_sources.sort_by(&score_cmp);
        kb_sources.sort_by(&score_cmp);

        // 3d. 保底记忆槽位：保证至少 min(记忆数, 3) 条记忆出现在最终结果中
        //     如果知识库结果不足以填满剩余槽位，回补给记忆
        const MEMORY_RESERVED_SLOTS: usize = 3;
        let memory_reserved = memory_sources.len().min(MEMORY_RESERVED_SLOTS).min(top_k);
        let kb_slots = top_k.saturating_sub(memory_reserved);
        let kb_actual = kb_sources.len().min(kb_slots);
        // 回补：KB 未填满的槽位还给记忆
        let memory_actual = (memory_reserved + kb_slots.saturating_sub(kb_actual))
            .min(memory_sources.len())
            .min(top_k);

        let mut final_sources = Vec::with_capacity(top_k);
        final_sources.extend(memory_sources.into_iter().take(memory_actual));
        final_sources.extend(kb_sources.into_iter().take(kb_slots));

        // 最终按分数排序（保持一致的输出顺序）
        final_sources.sort_by(&score_cmp);
        let all_sources = final_sources;

        // 🔧 per-document 去重过滤
        // ★ 记忆结果无 resourceId（只有 noteId），跳过 per_resource 限制
        //   记忆已在 MemoryService::search 中做了 note_id 去重
        let all_sources = if max_per_resource > 0 {
            let mut resource_count: HashMap<String, usize> = HashMap::new();
            all_sources
                .into_iter()
                .filter(|s| {
                    let source_type = s
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("sourceType"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if source_type == "memory" {
                        return true; // 记忆结果不参与 per_resource 去重
                    }
                    let resource_id = s
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("resourceId"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let count = resource_count.entry(resource_id.to_string()).or_insert(0);
                    if *count < max_per_resource {
                        *count += 1;
                        true
                    } else {
                        false
                    }
                })
                .collect::<Vec<_>>()
        } else {
            all_sources
        };

        let duration = start_time.elapsed().as_millis() as u64;

        // 发射 end 事件
        ctx.emitter.emit_end(
            event_types::RAG,
            &ctx.block_id,
            Some(json!({
                "sources": all_sources,
                "durationMs": duration,
                "source": "unified_search",
            })),
            None,
        );

        log::debug!(
            "[BuiltinRetrievalExecutor] Unified search completed: {} sources in {}ms",
            all_sources.len(),
            duration
        );

        // 构建带编号的来源列表，便于 LLM 引用
        let mut citation_counters: HashMap<&'static str, usize> = HashMap::new();
        let mut numbered_sources: Vec<Value> = Vec::with_capacity(all_sources.len());
        for (i, s) in all_sources.iter().enumerate() {
            let meta = s.metadata.as_ref();
            // 根据来源类型选择引用标记
            let source_type = meta
                .and_then(|m| m.get("sourceType"))
                .and_then(|v| v.as_str())
                .unwrap_or("text_search");
            let citation_prefix = citation_prefix_for_source_type(source_type);
            let citation_group = citation_group_for_source_type(source_type);
            let citation_index = {
                let entry = citation_counters.entry(citation_group).or_insert(0);
                *entry += 1;
                *entry
            };
            let image_url = meta
                .and_then(|m| m.get("imageUrl"))
                .and_then(|v| v.as_str());
            let image_citation = meta
                .and_then(|m| m.get("imageCitation"))
                .and_then(|v| v.as_str());
            let page_index = meta
                .and_then(|m| m.get("pageIndex"))
                .and_then(|v| v.as_i64());
            let resource_id = meta
                .and_then(|m| m.get("resourceId"))
                .and_then(|v| v.as_str());
            let source_id = meta
                .and_then(|m| m.get("sourceId"))
                .and_then(|v| v.as_str());
            let note_id = meta.and_then(|m| m.get("noteId")).and_then(|v| v.as_str());
            let folder_path = meta
                .and_then(|m| m.get("folderPath"))
                .and_then(|v| v.as_str());
            let read_resource_id = preferred_read_resource_id(resource_id, source_id);

            numbered_sources.push(json!({
                "index": i + 1,
                "citationTag": format!("[{}-{}]", citation_prefix, citation_index),
                "typeIndex": citation_index,
                "title": s.title,
                "url": s.url,
                "snippet": s.snippet,
                "score": s.score,
                "imageUrl": image_url,
                "imageCitation": image_citation,
                "pageIndex": page_index,
                "resourceId": resource_id,
                "sourceId": source_id,
                "readResourceId": read_resource_id,
                // 兼容前端 sourceAdapter：统一输出来源类型与记忆字段
                "source_type": source_type,
                "note_id": note_id,
                "folder_path": folder_path,
            }));
        }

        Ok(json!({
            "success": true,
            "sources": numbered_sources,
            "count": all_sources.len(),
            "durationMs": duration,
            "source": "unified_search",
            "citationGuide": "引用方式：[知识库-N]/[图片-N]/[记忆-N]（N 为同类来源编号）显示角标，[知识库-N:图片]/[图片-N:图片] 渲染对应页面图片。结果中 pageIndex 字段不为空时表示有图片可渲染。需要读取完整文档时优先使用 readResourceId 调用 builtin-resource_read。禁止输出 URL 或 Markdown 图片语法。"
        }))
    }

    /// 执行网络搜索
    async fn execute_web(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Web search cancelled before start".to_string());
        }

        // 解析参数
        let query = call
            .arguments
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'query' parameter")?;
        let mut engine = call
            .arguments
            .get("engine")
            .and_then(|v| v.as_str())
            .map(String::from);
        let top_k = call
            .arguments
            .get("top_k")
            .and_then(|v| v.as_u64())
            .unwrap_or(5) as usize;

        // 🔧 修复 #14/#15/#19: 从数据库读取全部配置覆盖（统一方法）
        let mut config = WebSearchConfig::from_env_and_file().unwrap_or_default();
        let mut selected_engines: Vec<String> = Vec::new();

        if let Some(db) = &ctx.main_db {
            // 统一应用所有 DB 配置覆盖（API keys + 站点过滤 + 策略 + reranker + CN 白名单等）
            config.apply_db_overrides(
                |k| db.get_setting(k).ok().flatten(),
                |k| db.get_secret(k).ok().flatten(),
            );

            // 读取用户选择的搜索引擎
            if let Ok(Some(engines_str)) = db.get_setting("session.selected_search_engines") {
                selected_engines = engines_str
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                log::debug!(
                    "[BuiltinRetrievalExecutor] User selected engines: {:?}",
                    selected_engines
                );
            }

            // 如果 LLM 没有指定引擎，使用用户选择的第一个引擎
            if engine.is_none() && !selected_engines.is_empty() {
                engine = Some(selected_engines[0].clone());
                log::info!(
                    "[BuiltinRetrievalExecutor] Using user-selected engine: {:?}",
                    engine
                );
            }
        }

        // 发射 start 事件
        ctx.emitter.emit_start(
            event_types::WEB_SEARCH,
            &ctx.message_id,
            Some(&ctx.block_id),
            Some(json!({ "query": query, "engine": engine })),
            None,
        );

        let start_time = Instant::now();

        // 构建搜索输入
        let search_input = SearchInput {
            query: query.to_string(),
            top_k,
            engine,
            site: None,
            time_range: None,
            start: None,
            force_engine: None,
        };

        // 🆕 取消检查：在执行搜索前检查
        if ctx.is_cancelled() {
            return Err("Web search cancelled before search".to_string());
        }

        // 执行搜索（支持取消）
        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = do_search(&config, search_input) => res,
                _ = cancel_token.cancelled() => {
                    log::info!("[BuiltinRetrievalExecutor] Web search cancelled");
                    return Err("Web search cancelled during execution".to_string());
                }
            }
        } else {
            do_search(&config, search_input).await
        };
        let duration = start_time.elapsed().as_millis() as u64;

        if result.ok {
            // 转换为 SourceInfo
            let sources: Vec<SourceInfo> = result
                .citations
                .unwrap_or_default()
                .into_iter()
                .map(|citation| SourceInfo {
                    title: Some(citation.file_name),
                    url: Some(citation.document_id),
                    snippet: Some(citation.chunk_text),
                    score: Some(citation.score),
                    metadata: Some(json!({
                        "sourceType": "web_search",
                        "chunkIndex": citation.chunk_index,
                    })),
                })
                .collect();

            // 发射 end 事件
            ctx.emitter.emit_end(
                event_types::WEB_SEARCH,
                &ctx.block_id,
                Some(json!({
                    "sources": sources,
                    "durationMs": duration,
                })),
                None,
            );

            log::debug!(
                "[BuiltinRetrievalExecutor] Web search completed: {} sources in {}ms",
                sources.len(),
                duration
            );

            // 构建带编号的来源列表，便于 LLM 引用
            let numbered_sources: Vec<Value> = sources
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    json!({
                        "index": i + 1,
                        "citationTag": format!("[搜索-{}]", i + 1),
                        "title": s.title,
                        "url": s.url,
                        "snippet": s.snippet,
                        "score": s.score,
                    })
                })
                .collect();

            Ok(json!({
                "success": true,
                "sources": numbered_sources,
                "count": sources.len(),
                "durationMs": duration,
                "citationGuide": "回答时请使用 [搜索-N] 格式引用对应来源，如 [搜索-1]、[搜索-2] 等。引用标记应紧跟在引用内容之后。"
            }))
        } else {
            let error_msg = result
                .error
                .map(|e| {
                    if let Some(s) = e.as_str() {
                        s.to_string()
                    } else {
                        e.to_string()
                    }
                })
                .unwrap_or_else(|| "Web search failed".to_string());
            ctx.emitter
                .emit_error(event_types::WEB_SEARCH, &ctx.block_id, &error_msg, None);
            Err(error_msg)
        }
    }
}

impl Default for BuiltinRetrievalExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for BuiltinRetrievalExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        matches!(
            stripped,
            "rag_search" | "multimodal_search" | "unified_search" | "web_search"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!(
            "[BuiltinRetrievalExecutor] Executing builtin tool: {} (full: {})",
            tool_name,
            call.name
        );

        // 🔧 修复：检索工具不发射 tool_call_start 事件
        // 原因：检索工具已有专门的事件类型（rag, graph_rag, memory, web_search）和专门的块渲染器
        // 如果同时发射 tool_call_start，会导致：
        // 1. 创建两个块（mcp_tool + 检索类型块）
        // 2. mcp_tool 块显示工具注册名（如 builtin-web_search）而非友好名称
        // 检索工具的 execute_* 方法内部会发射对应的 emit_start 事件

        let result = if should_route_to_unified_search(tool_name) {
            self.execute_unified_search(call, ctx).await
        } else {
            match tool_name {
                "memory_search" => self.execute_memory(call, ctx).await,
                "web_search" => self.execute_web(call, ctx).await,
                _ => Err(format!("Unknown builtin tool: {}", tool_name)),
            }
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                // 🔧 修复：检索工具不调用 save_tool_block
                // 原因：
                // 1. save_tool_block 使用硬编码的 mcp_tool 类型，会覆盖正确的检索块类型
                // 2. 检索块已通过 emit_start/end 事件创建，block_type 正确（如 web_search, rag）
                // 3. save_results 会通过 add_retrieval_block! 宏正确保存检索块

                Ok(result)
            }
            Err(e) => {
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration,
                );

                // 🔧 修复：检索工具不调用 save_tool_block（同上）

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // 检索工具是只读操作，低敏感
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "BuiltinRetrievalExecutor"
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 过滤检索结果
///
/// 应用双重阈值过滤：
/// 1. 绝对阈值：分数必须大于 min_score
/// 2. 相对阈值：分数必须大于最高分 * relative_threshold
fn filter_retrieval_results(
    sources: Vec<SourceInfo>,
    min_score: f32,
    relative_threshold: f32,
    max_results: usize,
) -> Vec<SourceInfo> {
    if sources.is_empty() {
        return sources;
    }

    // 找出最高分
    let max_score = sources
        .iter()
        .filter_map(|s| s.score)
        .fold(0.0f32, |a, b| a.max(b));

    // 计算相对阈值
    let relative_min = max_score * relative_threshold;

    // 过滤并截断
    sources
        .into_iter()
        .filter(|s| {
            if let Some(score) = s.score {
                score >= min_score && score >= relative_min
            } else {
                true // 无分数的保留
            }
        })
        .take(max_results)
        .collect()
}

fn should_route_to_unified_search(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "rag_search" | "multimodal_search" | "unified_search"
    )
}

fn citation_prefix_for_source_type(source_type: &str) -> &'static str {
    if source_type.contains("multimodal") {
        "图片"
    } else if source_type == "memory" {
        "记忆"
    } else {
        "知识库"
    }
}

fn citation_group_for_source_type(source_type: &str) -> &'static str {
    if source_type.contains("multimodal") {
        "multimodal"
    } else if source_type == "memory" {
        "memory"
    } else {
        "rag"
    }
}

fn is_readable_resource_id(id: &str) -> bool {
    id.starts_with("note_")
        || id.starts_with("tb_")
        || id.starts_with("file_")
        || id.starts_with("att_")
        || id.starts_with("exam_")
        || id.starts_with("essay_")
        || id.starts_with("essay_session_")
        || id.starts_with("es_")
        || id.starts_with("tr_")
        || id.starts_with("mm_")
        || id.starts_with("res_")
}

fn is_direct_source_id(id: &str) -> bool {
    id.starts_with("note_")
        || id.starts_with("tb_")
        || id.starts_with("file_")
        || id.starts_with("att_")
        || id.starts_with("exam_")
        || id.starts_with("essay_")
        || id.starts_with("essay_session_")
        || id.starts_with("es_")
        || id.starts_with("tr_")
        || id.starts_with("mm_")
}

fn preferred_read_resource_id<'a>(
    resource_id: Option<&'a str>,
    source_id: Option<&'a str>,
) -> Option<&'a str> {
    if let Some(sid) = source_id {
        if is_direct_source_id(sid) {
            return Some(sid);
        }
    }
    if let Some(rid) = resource_id {
        if is_readable_resource_id(rid) {
            return Some(rid);
        }
    }
    source_id.or(resource_id)
}

// ============================================================================
// Hybrid RAG 融合工具：RRF + VL-Reranker
// ============================================================================

/// RRF (Reciprocal Rank Fusion) 算法常数
///
/// 取值 60 是业界标准（来自 Cormack et al. 2009 原始论文）。
/// k 值越大，对 rank 差异越不敏感；越小则前排名权重越高。
const RRF_K: f32 = 60.0;

/// 计算 SourceInfo 的去重键
///
/// 用于跨源去重：同一 (resourceId, pageIndex) 的文本块和页面图片视为同一文档。
/// 退化策略：
/// - 同时有 resourceId + pageIndex：`{resourceId}:p{pageIndex}`
/// - 仅有 resourceId：`{resourceId}`
/// - 都没有：使用 title 作为兜底
fn dedup_key_for_source(s: &SourceInfo) -> String {
    let meta = s.metadata.as_ref();
    let resource_id = meta
        .and_then(|m| m.get("resourceId"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let page_index = meta
        .and_then(|m| m.get("pageIndex"))
        .and_then(|v| v.as_i64());

    if !resource_id.is_empty() {
        if let Some(pi) = page_index {
            return format!("{}:p{}", resource_id, pi);
        }
        return resource_id.to_string();
    }

    s.title
        .clone()
        .unwrap_or_else(|| s.snippet.clone().unwrap_or_else(|| "<unknown>".to_string()))
}

/// 使用 RRF 算法融合多路召回结果
///
/// ## 参数
/// - `result_lists`: 每路召回的有序结果列表（按相关性降序）
/// - `top_k`: 融合后保留的最大数量
///
/// ## 返回
/// 按 RRF 分数降序排列的融合结果。每个结果的 `score` 字段被覆盖为 RRF 分数。
///
/// ## 算法
/// 对每个文档 d，RRF 分数 = Σ 1 / (k + rank_i(d))，其中 rank_i 为 d 在第 i 路结果中的排名（1-based）。
/// 不出现在某路结果中的文档不贡献该路分数。
fn rrf_fuse_sources(result_lists: Vec<Vec<SourceInfo>>, top_k: usize) -> Vec<SourceInfo> {
    if result_lists.is_empty() {
        return Vec::new();
    }
    if result_lists.len() == 1 {
        let mut single = result_lists.into_iter().next().unwrap();
        single.truncate(top_k);
        return single;
    }

    use std::collections::HashMap;
    let mut rrf_scores: HashMap<String, f32> = HashMap::new();
    let mut doc_map: HashMap<String, SourceInfo> = HashMap::new();

    for results in result_lists {
        for (rank, source) in results.into_iter().enumerate() {
            let key = dedup_key_for_source(&source);
            let rrf = 1.0 / (RRF_K + rank as f32 + 1.0);
            *rrf_scores.entry(key.clone()).or_insert(0.0) += rrf;

            // 保留分数更高的版本作为代表（用于展示原始 snippet/title 等）
            doc_map
                .entry(key)
                .and_modify(|existing| {
                    if source.score.unwrap_or(0.0) > existing.score.unwrap_or(0.0) {
                        *existing = source.clone();
                    }
                })
                .or_insert(source);
        }
    }

    let mut sorted: Vec<(String, f32)> = rrf_scores.into_iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    sorted
        .into_iter()
        .take(top_k)
        .filter_map(|(k, rrf)| {
            doc_map.remove(&k).map(|mut s| {
                // 用 RRF 分数覆盖原始分数，保证后续排序一致
                s.score = Some(rrf);
                s
            })
        })
        .collect()
}

/// 使用 VL-Reranker 对融合后的候选集做跨模态精排
///
/// ## 参数
/// - `query`: 查询文本（图片查询暂不支持，未来可扩展）
/// - `candidates`: RRF 融合后的候选列表
/// - `top_k`: 最终返回数量
/// - `llm_manager`: LLM 管理器（用于调用 VL-Reranker API）
/// - `vfs_db`: VFS 数据库（用于加载图片 Blob）
///
/// ## 返回
/// 重排序后的结果。如果 VL-Reranker 未配置或调用失败，返回原始候选（截断到 top_k）。
///
/// ## 实现说明
/// - 文本类候选：仅传入 snippet 文本
/// - 多模态类候选（有 blobHash）：加载图片 Base64 + snippet 一起送入
/// - 失败时降级为原始排序，不阻断检索流程
async fn vl_rerank_sources(
    query: &str,
    candidates: Vec<SourceInfo>,
    top_k: usize,
    llm_manager: &std::sync::Arc<crate::llm_manager::LLMManager>,
    vfs_db: &std::sync::Arc<crate::vfs::database::VfsDatabase>,
) -> Vec<SourceInfo> {
    use crate::multimodal::types::MultimodalInput;
    use crate::vfs::repos::VfsBlobRepo;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    if candidates.is_empty() {
        return Vec::new();
    }

    // 检查 VL-Reranker 是否已配置
    if !llm_manager.is_multimodal_reranking_configured().await {
        log::debug!("[hybrid-rag] VL-Reranker 未配置，跳过精排");
        let mut out = candidates;
        out.truncate(top_k);
        return out;
    }

    // 构造 query 输入
    let query_input = MultimodalInput::text(query);

    // 构造文档输入：有图片则加载，否则用文本
    let mut doc_inputs: Vec<MultimodalInput> = Vec::with_capacity(candidates.len());
    for c in &candidates {
        let meta = c.metadata.as_ref();
        let blob_hash = meta
            .and_then(|m| m.get("blobHash"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let snippet = c.snippet.clone().unwrap_or_default();

        let input = if let Some(hash) = blob_hash {
            // 多模态文档：加载图片
            let image_loaded = (|| -> Option<(String, String)> {
                let blob_path = VfsBlobRepo::get_blob_path(vfs_db, hash).ok().flatten()?;
                let data = std::fs::read(&blob_path).ok()?;
                let base64 = BASE64.encode(&data);
                // 推断 MIME（默认 png；后续可从资源 metadata 取）
                let mime = blob_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| match e.to_lowercase().as_str() {
                        "jpg" | "jpeg" => "image/jpeg".to_string(),
                        "webp" => "image/webp".to_string(),
                        _ => "image/png".to_string(),
                    })
                    .unwrap_or_else(|| "image/png".to_string());
                Some((base64, mime))
            })();

            match image_loaded {
                Some((b64, mime)) => {
                    if snippet.is_empty() {
                        MultimodalInput::image_base64(b64, mime)
                    } else {
                        MultimodalInput::text_and_image(snippet, b64, mime)
                    }
                }
                None => {
                    log::debug!("[hybrid-rag] blob {} 加载失败，降级为纯文本", hash);
                    MultimodalInput::text(snippet)
                }
            }
        } else {
            MultimodalInput::text(snippet)
        };

        doc_inputs.push(input);
    }

    // 调用 VL-Reranker
    match llm_manager
        .call_multimodal_reranker_api(&query_input, &doc_inputs)
        .await
    {
        Ok(results) => {
            // results 包含 (index, relevance_score)，已按分数降序
            let mut reranked: Vec<SourceInfo> = Vec::with_capacity(top_k.min(results.len()));
            for r in results.into_iter().take(top_k) {
                if let Some(mut src) = candidates.get(r.index).cloned() {
                    src.score = Some(r.relevance_score);
                    reranked.push(src);
                }
            }
            log::info!(
                "[hybrid-rag] VL-Reranker 精排完成: {} 候选 -> {} 结果",
                doc_inputs.len(),
                reranked.len()
            );
            reranked
        }
        Err(e) => {
            log::warn!("[hybrid-rag] VL-Reranker 调用失败，降级为 RRF 排序: {}", e);
            let mut out = candidates;
            out.truncate(top_k);
            out
        }
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = BuiltinRetrievalExecutor::new();

        // 处理 builtin- 前缀的工具
        assert!(executor.can_handle("builtin-rag_search"));
        assert!(executor.can_handle("builtin-multimodal_search"));
        assert!(executor.can_handle("builtin-unified_search"));
        assert!(executor.can_handle("builtin-web_search"));

        // ★ 2026-01-20: memory_search 已移至 MemoryToolExecutor
        assert!(!executor.can_handle("builtin-memory_search"));

        // 也处理无前缀工具名（内部兼容）
        assert!(executor.can_handle("rag_search"));
        assert!(!executor.can_handle("note_read"));
        assert!(!executor.can_handle("mcp_brave_search"));
    }

    #[test]
    fn test_strip_namespace() {
        assert_eq!(strip_tool_namespace("builtin-rag_search"), "rag_search");
        assert_eq!(strip_tool_namespace("builtin-web_search"), "web_search");
        assert_eq!(strip_tool_namespace("rag_search"), "rag_search");
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = BuiltinRetrievalExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-rag_search"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn test_filter_retrieval_results() {
        let sources = vec![
            SourceInfo {
                title: Some("Doc1".to_string()),
                url: None,
                snippet: Some("Content 1".to_string()),
                score: Some(0.9),
                metadata: None,
            },
            SourceInfo {
                title: Some("Doc2".to_string()),
                url: None,
                snippet: Some("Content 2".to_string()),
                score: Some(0.5),
                metadata: None,
            },
            SourceInfo {
                title: Some("Doc3".to_string()),
                url: None,
                snippet: Some("Content 3".to_string()),
                score: Some(0.2), // 低于绝对阈值
                metadata: None,
            },
        ];

        let filtered = filter_retrieval_results(sources, 0.3, 0.5, 10);

        // Doc3 应该被过滤掉（分数 0.2 < 0.3）
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].title, Some("Doc1".to_string()));
        assert_eq!(filtered[1].title, Some("Doc2".to_string()));
    }

    #[test]
    fn test_route_to_unified_search() {
        assert!(should_route_to_unified_search("rag_search"));
        assert!(should_route_to_unified_search("multimodal_search"));
        assert!(should_route_to_unified_search("unified_search"));
        assert!(!should_route_to_unified_search("web_search"));
        assert!(!should_route_to_unified_search("memory_search"));
    }

    #[test]
    fn test_citation_prefix_for_source_type() {
        assert_eq!(citation_prefix_for_source_type("text_search"), "知识库");
        assert_eq!(citation_prefix_for_source_type("multimodal_search"), "图片");
        assert_eq!(citation_prefix_for_source_type("memory"), "记忆");
    }

    #[test]
    fn test_citation_group_for_source_type() {
        assert_eq!(citation_group_for_source_type("text_search"), "rag");
        assert_eq!(
            citation_group_for_source_type("multimodal_search"),
            "multimodal"
        );
        assert_eq!(citation_group_for_source_type("memory"), "memory");
    }

    #[test]
    fn test_preferred_read_resource_id() {
        assert_eq!(
            preferred_read_resource_id(Some("res_abc"), Some("note_1")),
            Some("note_1")
        );
        assert_eq!(
            preferred_read_resource_id(Some("res_abc"), Some("res_src")),
            Some("res_abc")
        );
        assert_eq!(
            preferred_read_resource_id(Some("res_abc"), Some("not_a_resource_id")),
            Some("res_abc")
        );
        assert_eq!(
            preferred_read_resource_id(Some("res_abc"), None),
            Some("res_abc")
        );
        assert_eq!(
            preferred_read_resource_id(None, Some("tb_123")),
            Some("tb_123")
        );
        assert_eq!(preferred_read_resource_id(None, None), None);
    }
}
