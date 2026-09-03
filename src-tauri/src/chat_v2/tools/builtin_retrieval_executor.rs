//! 内置检索工具执行器
//!
//! ★ 2026-01 简化：VFS RAG 作为唯一知识检索方案（支持多模态）
//! ★ 2026-07 SOTA 改造：
//! - `rag_search` / `multimodal_search` / `unified_search` 统一走规划检索路径
//!   （`execute_planned_search` → `VfsUnifiedRetriever`）
//! - `unified_search` 并入用户记忆检索（保底槽位 + 跨源去重），citationTag 使用 `[记忆-N]`
//! - emit_end payload 与 tool_output 共用同一份 numbered sources（citationTag/typeIndex 契约）
//! - 分数阈值（绝对 + 相对，保底 top1）与 snippet 字符预算控制
//! - rerank 失败不再静默回退：失败信息汇入 routeFailures
//!
//! 执行的内置工具：
//! - `builtin-rag_search` - 知识检索（统一使用 VFS RAG）
//! - `builtin-multimodal_search` - 多模态检索（图片/PDF 页面）
//! - `builtin-unified_search` - 统一检索（知识库文本 + 多模态 + 用户记忆）
//! - `builtin-web_search` - 网络搜索
//! - `builtin-memory_search` - 已废弃存根（由 MemoryToolExecutor 处理）
//!
//! ## 设计说明
//! 该执行器将预调用模式的检索工具转换为 LLM 可主动调用的 MCP 工具。
//! 复用现有的检索逻辑，但通过 ToolExecutor trait 接口执行。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::arg_utils::{ensure_localized_error, with_localized_message};
use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{SourceInfo, ToolCall, ToolResultInfo};
use crate::tools::web_search::{do_search, SearchInput, ToolConfig as WebSearchConfig};

/// 内置工具命名空间前缀
/// 🔧 使用 'builtin-' 而非 'builtin:' 以兼容 DeepSeek/OpenAI API 的工具名称限制
/// API 要求工具名称符合正则 ^[a-zA-Z0-9_-]+$，不允许冒号
pub const BUILTIN_NAMESPACE: &str = "builtin-";

/// RAG 检索最小分数阈值（仅对量纲可比的 reranker 相关度生效）
const RETRIEVAL_MIN_SCORE: f32 = 0.3;
/// RAG 检索相对分数阈值（相对于最高分，对任意量纲适用）
const RETRIEVAL_RELATIVE_THRESHOLD: f32 = 0.5;
const DEFAULT_RAG_TOP_K: u32 = 10;
/// 工具 JSON 中单条 snippet 的最大字符数（与 prompt_builder 的单条来源上限一致）
const MAX_SNIPPET_CHARS_PER_SOURCE: usize = 1500;
/// 工具 JSON 中所有 snippet 的总字符预算（与 prompt_builder 的 RAG 总预算一致）
const MAX_SNIPPET_TOTAL_CHARS: usize = 6000;
/// 统一检索中记忆来源的保底槽位数（防止记忆被知识库结果挤出 top_k）
const MEMORY_RESERVED_SLOTS: usize = 3;

fn localized_retrieval_failure(error: impl Into<String>) -> String {
    ensure_localized_error(
        error,
        "RETRIEVAL_OPERATION_FAILED",
        "chat.tools.retrieval.error",
        "检索操作失败",
        "The retrieval operation failed.",
    )
}

// ============================================================================
// 内置检索工具执行器
// ============================================================================

/// 缓存的 Lance 存储（按 VfsDatabase 实例区分）
struct CachedLanceStore {
    vfs_db_ptr: usize,
    store: std::sync::Arc<crate::vfs::VfsLanceStore>,
}

/// 内置检索工具执行器
///
/// ★ 2026-01 简化：VFS RAG 作为唯一知识检索方案（支持多模态）
///
/// 处理以 `builtin-` 开头的检索工具：
/// - `builtin-rag_search` - 知识检索（统一使用 VFS RAG）
/// - `builtin-multimodal_search` - 多模态检索（图片/PDF 页面）
/// - `builtin-unified_search` - 统一检索（知识库文本 + 多模态 + 用户记忆）
/// - `builtin-web_search` - 网络搜索
///
/// ## 与预调用模式的区别
/// - 预调用模式：在 LLM 调用前自动执行，结果注入到系统提示
/// - 工具调用模式：LLM 主动决定何时调用，结果作为工具输出返回
pub struct BuiltinRetrievalExecutor {
    /// P2-7：按 VfsDatabase 实例缓存 VfsLanceStore，复用 Lance 连接与表状态，
    /// 避免每次检索重建连接（仅在 ExecutionContext 未注入 vfs_lance_store 时生效）。
    lance_store_cache: std::sync::Mutex<Option<CachedLanceStore>>,
}

impl BuiltinRetrievalExecutor {
    /// 创建新的内置检索工具执行器
    pub fn new() -> Self {
        Self {
            lance_store_cache: std::sync::Mutex::new(None),
        }
    }

    /// 获取（或复用）VFS Lance 存储：优先使用 ctx 注入的实例，其次执行器级缓存
    fn lance_store_for(
        &self,
        ctx: &ExecutionContext,
    ) -> Result<std::sync::Arc<crate::vfs::VfsLanceStore>, String> {
        if let Some(store) = ctx.vfs_lance_store.clone() {
            return Ok(store);
        }
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let vfs_db_ptr = std::sync::Arc::as_ptr(vfs_db) as usize;
        let mut cache = self
            .lance_store_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = cache.as_ref() {
            if cached.vfs_db_ptr == vfs_db_ptr {
                return Ok(std::sync::Arc::clone(&cached.store));
            }
        }
        let store = crate::vfs::VfsLanceStore::new(std::sync::Arc::clone(vfs_db))
            .map(std::sync::Arc::new)
            .map_err(|error| format!("Failed to create Lance store: {}", error))?;
        *cache = Some(CachedLanceStore {
            vfs_db_ptr,
            store: std::sync::Arc::clone(&store),
        });
        Ok(store)
    }

    /// 兼容存根：memory_search 已迁移至 builtin-memory_search（由 MemoryToolExecutor 处理）
    async fn execute_memory(
        &self,
        _call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        log::warn!("[BuiltinRetrievalExecutor] memory_search is deprecated, use builtin-memory_search instead");

        let deprecation = with_localized_message(
            json!({ "deprecated": true }),
            "chat.tools.retrieval.memory_search_deprecated",
            json!({ "replacementTool": "builtin-memory_search" }),
            "请使用 builtin-memory_search 工具（由 MemoryToolExecutor 处理）",
            "Use builtin-memory_search instead; it is handled by MemoryToolExecutor.",
        );
        ctx.emitter.emit_end(
            event_types::MEMORY,
            &ctx.block_id,
            Some(deprecation.clone()),
            None,
        );

        let mut result = deprecation;
        result["success"] = json!(false);
        result["errorCode"] = json!("RETRIEVAL_TOOL_DEPRECATED");
        result["error"] = result["message"].clone();
        Ok(result)
    }

    /// 执行规划检索（rag_search / multimodal_search / unified_search 统一入口）
    ///
    /// ★ 2026-01 VFS 统一管理：
    /// - VFS 文本搜索：`vfs_emb_text_{dim}` 表
    /// - VFS 多模态搜索：`vfs_emb_multimodal_{dim}` 表
    ///
    /// ★ 2026-07 SOTA 改造：
    /// - unified_search 并入用户记忆路由（受 memory 开关控制，失败隔离进 routeFailures）
    /// - emit_end payload 与 tool_output 共用同一份 numbered sources
    /// - 阈值过滤 + snippet 字符预算 + rerank 失败上报
    async fn execute_planned_search(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        tool_name: &str,
    ) -> Result<Value, String> {
        use crate::memory::service::MemoryService;
        use crate::vfs::retrieval_planner::QueryModality;
        use crate::vfs::{UnifiedRetrievalRequest, VfsUnifiedRetriever};
        use std::collections::HashMap;

        if ctx.is_cancelled() {
            return Err("Unified retrieval cancelled before start".to_string());
        }

        let string_arg = |names: &[&str]| {
            names.iter().find_map(|name| {
                call.arguments
                    .get(*name)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
        };
        let vec_arg = |names: &[&str]| {
            names.iter().find_map(|name| {
                call.arguments
                    .get(*name)
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                    })
            })
        };
        let query_text = string_arg(&["queryText", "query_text", "query"]);
        let query_image_base64 = string_arg(&["queryImageBase64", "query_image_base64"]);
        let query_image_media_type = string_arg(&["queryImageMediaType", "query_image_media_type"]);
        let query_modality = match string_arg(&["queryMode", "query_mode"])
            .as_deref()
            .map(|value| value.to_ascii_lowercase())
            .as_deref()
        {
            Some("text") => QueryModality::Text,
            Some("image") => QueryModality::Image,
            Some("mixed") => QueryModality::Mixed,
            Some(other) => return Err(format!("Unsupported queryMode: {}", other)),
            None if query_text.is_some() && query_image_base64.is_some() => QueryModality::Mixed,
            None if query_image_base64.is_some() => QueryModality::Image,
            None => QueryModality::Text,
        };
        let folder_ids = vec_arg(&["folder_ids", "folderIds"]);
        let resource_ids = vec_arg(&["resource_ids", "resourceIds"]);
        let resource_types = vec_arg(&["resource_types", "resourceTypes"]);
        // P2-8：top_k 上限与前端 schema 对齐（builtinMcpServer.ts）：
        // rag_search/multimodal_search 声明 maximum=100，unified_search 声明 maximum=30。
        let top_k_cap = if tool_name == "unified_search" {
            30
        } else {
            100
        };
        let top_k = call
            .arguments
            .get("top_k")
            .or_else(|| call.arguments.get("topK"))
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .or(ctx.rag_top_k.map(|value| value as usize))
            .unwrap_or(DEFAULT_RAG_TOP_K as usize)
            .clamp(1, top_k_cap);
        let max_per_resource = call
            .arguments
            .get("max_per_resource")
            .or_else(|| call.arguments.get("maxPerResource"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let enable_reranking = call
            .arguments
            .get("enable_reranking")
            .or_else(|| call.arguments.get("enableReranking"))
            .and_then(Value::as_bool)
            .or(ctx.rag_enable_reranking)
            .unwrap_or(true);

        ctx.emitter.emit_start(
            event_types::RAG,
            &ctx.message_id,
            Some(&ctx.block_id),
            Some(json!({
                "query": query_text,
                "queryMode": query_modality,
                "hasQueryImage": query_image_base64.is_some(),
                "folderIds": folder_ids,
                "resourceIds": resource_ids,
                "resourceTypes": resource_types,
                "source": tool_name,
            })),
            None,
        );

        let started = Instant::now();
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM manager not available")?;
        let lance_store = self.lance_store_for(ctx)?;
        let retriever = VfsUnifiedRetriever::new(
            std::sync::Arc::clone(vfs_db),
            std::sync::Arc::clone(&lance_store),
            std::sync::Arc::clone(llm_manager),
        );
        let request = UnifiedRetrievalRequest {
            query_text: query_text.clone(),
            query_image_base64: query_image_base64.clone(),
            query_image_media_type: query_image_media_type.clone(),
            query_modality,
            top_k,
            folder_ids,
            resource_ids,
            resource_types,
        };

        let response = if planned_search_scope(tool_name) == PlannedSearchScope::MultimodalOnly {
            if let Some(cancel_token) = ctx.cancellation_token() {
                tokio::select! {
                    result = retriever.search_multimodal(request) => result,
                    _ = cancel_token.cancelled() => {
                        return Err("Multimodal retrieval cancelled during execution".to_string());
                    }
                }
            } else {
                retriever.search_multimodal(request).await
            }
        } else {
            if let Some(cancel_token) = ctx.cancellation_token() {
                tokio::select! {
                    result = retriever.search(request) => result,
                    _ = cancel_token.cancelled() => {
                        return Err("Unified retrieval cancelled during execution".to_string());
                    }
                }
            } else {
                retriever.search(request).await
            }
        }
        .map_err(|error| error.to_string())?;

        let mut route_failures = response.result.failures.clone();
        // 🆕 SOTA：统一层（unified_retriever）正在引入 rerank 注入点与
        // normalized_score 字段。此处以序列化视图防御式消费：若 fused hit 携带
        // normalizedScore/rerankScore（0..1 量纲）则优先作为展示分数，否则回退 RRF。
        let total_hits = response.result.hits.len();
        let mut normalized_hits = 0usize;
        let mut sources: Vec<SourceInfo> = response
            .result
            .hits
            .into_iter()
            .map(|fused| {
                let fused_value = serde_json::to_value(&fused).unwrap_or(Value::Null);
                let normalized_score = ["normalizedScore", "rerankScore"]
                    .iter()
                    .find_map(|key| fused_value.get(*key))
                    .and_then(Value::as_f64);
                if normalized_score.is_some() {
                    normalized_hits += 1;
                }
                let hit = fused.hit;
                let source_type = if hit.blob_hash.is_some()
                    || fused.provenance.iter().any(|provenance| {
                        matches!(
                            provenance.route_kind,
                            crate::vfs::retrieval_planner::RetrievalRouteKind::MultimodalImage
                                | crate::vfs::retrieval_planner::RetrievalRouteKind::MultimodalText
                        )
                    }) {
                    "multimodal_search"
                } else {
                    "text_search"
                };
                let image_citation = hit.image_url.as_ref().map(|url| {
                    format!(
                        "![Page {}]({})",
                        hit.identity.page_index.unwrap_or(0) + 1,
                        url
                    )
                });
                SourceInfo {
                    title: hit.title,
                    url: hit.image_url.clone(),
                    snippet: Some(hit.text),
                    score: Some(normalized_score.unwrap_or(fused.rrf_score) as f32),
                    // 视觉上下文接口约定：多模态命中必须保证 blobHash/pageIndex 完整，
                    // 下游 context_compiler 依赖这两个字段决定是否把页图注入 LLM。
                    metadata: Some(json!({
                        "resourceType": hit.resource_type,
                        "resourceId": hit.identity.resource_id,
                        "sourceId": hit.source_id,
                        "chunkIndex": hit.identity.chunk_index,
                        "pageIndex": hit.identity.page_index,
                        "blobHash": hit.blob_hash,
                        "folderId": hit.folder_id,
                        "sourceType": source_type,
                        "imageUrl": hit.image_url,
                        "imageCitation": image_citation,
                        "rrfScore": fused.rrf_score,
                        "normalizedScore": normalized_score,
                        "retrievalProvenance": fused.provenance,
                    })),
                }
            })
            .collect();
        // 统一层已给出归一化分数（0..1）时，绝对阈值也可安全应用
        let upstream_scores_normalized = total_hits > 0 && normalized_hits == total_hits;

        // ========== 记忆路由准备（P0-1）：仅 unified_search 且 memory 开关开启 ==========
        let include_memory =
            tool_name == "unified_search" && ctx.memory_enabled && query_text.is_some();
        let memory_service = if include_memory {
            Some(MemoryService::new(
                std::sync::Arc::clone(vfs_db),
                std::sync::Arc::clone(&lance_store),
                std::sync::Arc::clone(llm_manager),
            ))
        } else {
            None
        };

        // 源头去重：记忆笔记同时被 VFS 文本索引覆盖，先从知识库结果中排除，
        // 避免同一条记忆以 [知识库-N] 与 [记忆-N] 双重身份出现。
        if let Some(memory_service) = memory_service.as_ref() {
            let memory_resource_ids = memory_note_resource_ids(vfs_db, memory_service);
            if !memory_resource_ids.is_empty() {
                sources.retain(|source| {
                    !source
                        .metadata
                        .as_ref()
                        .and_then(|metadata| metadata.get("resourceId"))
                        .and_then(Value::as_str)
                        .is_some_and(|resource_id| memory_resource_ids.contains(resource_id))
                });
            }
        }

        // ========== rerank（P2-9：失败信息汇入 routeFailures，不再静默） ==========
        let rerank_requested = enable_reranking && !sources.is_empty();
        let mut rerank_applied = false;
        if rerank_requested {
            let (rerank_kind, outcome) = match select_reranker_kind(query_modality, &sources) {
                PlannedRerankerKind::Text => {
                    let outcome = if let Some(query) = query_text.as_deref() {
                        text_rerank_sources(query, sources, top_k, llm_manager).await
                    } else {
                        RerankOutcome::skipped(sources, top_k)
                    };
                    ("text", outcome)
                }
                PlannedRerankerKind::Multimodal => (
                    "multimodal",
                    vl_rerank_sources_with_query(
                        query_text.as_deref(),
                        query_image_base64.as_deref(),
                        query_image_media_type.as_deref(),
                        sources,
                        top_k,
                        llm_manager,
                        vfs_db,
                    )
                    .await,
                ),
            };
            sources = outcome.sources;
            rerank_applied = outcome.applied;
            if let Some(error) = outcome.failure {
                route_failures.push(crate::vfs::retrieval_planner::RetrievalRouteFailure {
                    route_id: format!("rerank:{}", rerank_kind),
                    profile_id: None,
                    dimension: None,
                    error,
                    timed_out: false,
                    query_derivation: None,
                });
            }
        } else {
            sources.truncate(top_k);
        }

        // ========== 分数阈值过滤（P1-4）：绝对 + 相对，保底 top1 ==========
        // RRF 分数（~1/60 量级）与 reranker 相关度（0..1）量纲不同：
        // 绝对阈值仅在 rerank 生效或统一层给出归一化分数时应用，
        // 相对阈值对任意量纲均适用。
        let absolute_min = if rerank_applied || upstream_scores_normalized {
            Some(RETRIEVAL_MIN_SCORE)
        } else {
            None
        };
        sources = apply_score_thresholds(sources, absolute_min, RETRIEVAL_RELATIVE_THRESHOLD);

        if max_per_resource > 0 {
            let mut counts: HashMap<String, usize> = HashMap::new();
            sources.retain(|source| {
                let resource_id = source
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("resourceId"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let count = counts.entry(resource_id.to_string()).or_default();
                let keep = *count < max_per_resource;
                *count += usize::from(keep);
                keep
            });
        }

        // ========== 记忆检索 + 保底槽位合并（P0-1） ==========
        // 记忆路由失败被隔离进 routeFailures，绝不影响知识库结果。
        if let Some(memory_service) = memory_service.as_ref() {
            let query = query_text.as_deref().unwrap_or_default();
            let (mut memory_sources, memory_failure) =
                retrieve_memory_sources(memory_service, llm_manager, query, top_k, ctx).await;
            if let Some(failure) = memory_failure {
                route_failures.push(failure);
            }
            if !memory_sources.is_empty() {
                dedup_kb_against_memory(&mut sources, &memory_sources);
                // 保底槽位：保证至少 min(记忆数, MEMORY_RESERVED_SLOTS) 条记忆进入结果；
                // 知识库未填满的槽位回补给记忆。
                let memory_reserved = memory_sources.len().min(MEMORY_RESERVED_SLOTS).min(top_k);
                let kb_slots = top_k.saturating_sub(memory_reserved);
                let kb_actual = sources.len().min(kb_slots);
                let memory_actual = (memory_reserved + kb_slots.saturating_sub(kb_actual))
                    .min(memory_sources.len())
                    .min(top_k);
                sources.truncate(kb_actual);
                memory_sources.truncate(memory_actual);
                sources.extend(memory_sources);
            }
        }

        // ========== 统一输出（P0-3）：emit_end 与 tool_output 共用同一份 sources ==========
        // citationTag/typeIndex 按类型独立计数（`[类型-N]` 契约，前端按此解析）。
        // 🆕 P0：编号由回复级 Citation Ledger 分配——同一次助手回复内的多次工具调用
        // 对同一来源恒定复用同一编号，前端可直接信任 citationTag/typeIndex 不再重排。
        let ledger = crate::chat_v2::context::citation_ledger_for_reply(
            &ctx.session_id,
            &ctx.message_id,
            ctx.variant_id.as_deref(),
        );
        let numbered_sources = {
            let mut ledger = ledger
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Value::Array(build_numbered_sources(&sources, &mut ledger))
        };
        let duration = started.elapsed().as_millis() as u64;
        let route_failures_value = serde_json::to_value(&route_failures).unwrap_or(Value::Null);
        let plan_value = serde_json::to_value(&response.plan).unwrap_or(Value::Null);
        let capability_value =
            serde_json::to_value(&response.capability_snapshot).unwrap_or(Value::Null);
        let rerank_value = json!({
            "requested": rerank_requested,
            "applied": rerank_applied,
        });

        // P0-2 决策：多模态检索不再使用独立的 multimodal_rag 事件（前端 handler 死路径），
        // 统一发 `rag` 事件，payload 以 source（工具名）+ queryMode 区分检索形态。
        ctx.emitter.emit_end(
            event_types::RAG,
            &ctx.block_id,
            Some(json!({
                "sources": numbered_sources.clone(),
                "count": sources.len(),
                "durationMs": duration,
                "source": tool_name,
                "queryMode": query_modality,
                "routeFailures": route_failures_value.clone(),
                "rerank": rerank_value.clone(),
                "retrievalPlan": plan_value.clone(),
                "capabilitySnapshot": capability_value.clone(),
            })),
            None,
        );

        log::debug!(
            "[BuiltinRetrievalExecutor] Planned search '{}' completed: {} sources in {}ms (rerank_applied={})",
            tool_name,
            sources.len(),
            duration,
            rerank_applied
        );

        // 🆕 citationGuide 精简：编号在本次回复内全局一致（跨多次检索复用），
        // 引用紧跟被支撑的句子；禁止 URL/路径/Markdown 图片。
        let (guide_zh, guide_en, source_types) = if include_memory {
            (
                "在被支撑句子后紧跟 [知识库-N]/[图片-N]/[记忆-N]（编号本次回复内全局一致，重复检索到的同一来源编号不变）。页面图片用 [知识库-N:图片]/[图片-N:图片]。读全文用 readResourceId→builtin-resource_read，读完整记忆用 noteId→builtin-memory_read（压缩摘要条目 noteId 为 null，改用 sourceNoteIds 中的真实 ID）。禁止输出 URL、文件路径或 Markdown 图片。",
                "Append [知识库-N], [图片-N], or [记忆-N] right after each supported claim; N is stable across searches within this reply. Use [知识库-N:图片]/[图片-N:图片] to render page images. Read full docs via readResourceId with builtin-resource_read; full memories via noteId with builtin-memory_read (compressed memory entries have a null noteId; use the real IDs in sourceNoteIds instead). Never output URLs, file paths, or Markdown images.",
                json!(["knowledge", "image", "memory"]),
            )
        } else {
            (
                "在被支撑句子后紧跟 [知识库-N]/[图片-N]（编号本次回复内全局一致，重复检索到的同一来源编号不变）。页面图片用 [知识库-N:图片]/[图片-N:图片]。读全文用 readResourceId→builtin-resource_read。禁止输出 URL、文件路径或 Markdown 图片。",
                "Append [知识库-N] or [图片-N] right after each supported claim; N is stable across searches within this reply. Use [知识库-N:图片]/[图片-N:图片] to render page images. Read full docs via readResourceId with builtin-resource_read. Never output URLs, file paths, or Markdown images.",
                json!(["knowledge", "image"]),
            )
        };
        Ok(with_localized_message(
            json!({
                "success": true,
                "sources": numbered_sources,
                "count": sources.len(),
                "durationMs": duration,
                "source": tool_name,
                "routeFailures": route_failures_value,
                "rerank": rerank_value,
                "retrievalPlan": plan_value,
                "capabilitySnapshot": capability_value,
                "citationGuide": format!("{guide_zh} / {guide_en}"),
            }),
            "chat.tools.retrieval.unified_citation_guide",
            json!({ "sourceTypes": source_types }),
            guide_zh,
            guide_en,
        ))
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

            // 构建带编号的来源列表，便于 LLM 引用
            // P0-3：emit_end payload 与 tool_output 共用同一份 numbered sources
            let numbered_sources: Vec<Value> = sources
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    json!({
                        "index": i + 1,
                        "citationTag": format!("[搜索-{}]", i + 1),
                        "typeIndex": i + 1,
                        "title": s.title,
                        "url": s.url,
                        "snippet": s.snippet,
                        "score": s.score,
                        "source_type": "web_search",
                    })
                })
                .collect();
            let numbered_sources = Value::Array(numbered_sources);

            // 发射 end 事件
            ctx.emitter.emit_end(
                event_types::WEB_SEARCH,
                &ctx.block_id,
                Some(json!({
                    "sources": numbered_sources.clone(),
                    "count": sources.len(),
                    "durationMs": duration,
                })),
                None,
            );

            log::debug!(
                "[BuiltinRetrievalExecutor] Web search completed: {} sources in {}ms",
                sources.len(),
                duration
            );

            let guide_zh = "回答时请使用 [搜索-N] 格式引用对应来源，如 [搜索-1]、[搜索-2] 等。引用标记应紧跟在引用内容之后。";
            let guide_en = "Cite each matching source as [搜索-N], such as [搜索-1] or [搜索-2], immediately after the supported claim.";
            Ok(with_localized_message(
                json!({
                    "success": true,
                    "sources": numbered_sources,
                    "count": sources.len(),
                    "durationMs": duration,
                    "citationGuide": format!("{guide_zh} / {guide_en}"),
                }),
                "chat.tools.retrieval.web_citation_guide",
                json!({ "sourceType": "web" }),
                guide_zh,
                guide_en,
            ))
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
            self.execute_planned_search(call, ctx, tool_name).await
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
                let e = localized_retrieval_failure(e);
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

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        // 各类检索（rag/multimodal/unified/web_search）均为纯只读，可并行 + 自动重试
        ToolConcurrency::ReadOnly
    }

    fn name(&self) -> &'static str {
        "BuiltinRetrievalExecutor"
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 双重分数阈值过滤（P1-4）
///
/// 1. 绝对阈值 `min_score`：仅在分数量纲可比时传入（如 reranker 相关度 0..1）；
///    RRF 分数（~1/60 量级）不适用绝对阈值，调用方传 None。
/// 2. 相对阈值：分数须 ≥ 最高分 × `relative_threshold`（对任意量纲适用）。
///
/// 输入按分数降序排列；无分数的条目保留；至少保留排名最高的一条（保底 top1）。
fn apply_score_thresholds(
    sources: Vec<SourceInfo>,
    min_score: Option<f32>,
    relative_threshold: f32,
) -> Vec<SourceInfo> {
    if sources.len() <= 1 {
        return sources;
    }
    let max_score = sources
        .iter()
        .filter_map(|source| source.score)
        .fold(f32::MIN, f32::max);
    if !max_score.is_finite() || max_score <= 0.0 {
        return sources;
    }
    let relative_min = max_score * relative_threshold;

    let mut fallback_top: Option<SourceInfo> = None;
    let mut filtered: Vec<SourceInfo> = Vec::with_capacity(sources.len());
    for (rank, source) in sources.into_iter().enumerate() {
        let keep = source.score.map_or(true, |score| {
            score >= relative_min && min_score.map_or(true, |min| score >= min)
        });
        if keep {
            filtered.push(source);
        } else if rank == 0 {
            fallback_top = Some(source);
        }
    }
    if filtered.is_empty() {
        return fallback_top.into_iter().collect();
    }
    filtered
}

/// 按字符预算截断 snippet，返回（截断后的文本, 实际占用的字符数）
fn truncate_snippet_chars(text: &str, max_chars: usize) -> (String, usize) {
    let total = text.chars().count();
    if total <= max_chars {
        return (text.to_string(), total);
    }
    if max_chars == 0 {
        return (String::new(), 0);
    }
    let mut truncated: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    truncated.push('…');
    (truncated, max_chars)
}

/// 来源身份键：Citation Ledger「同源同号」的判定依据。
///
/// 与 `CitationLedger::assign` 的契约一致（见 chat_v2/context.rs）：
/// - 知识库（rag）：resource + chunk（`res:{id}|c:{chunk}`）
/// - 多模态（multimodal）：resource + page，回退 blob_hash + page
/// - 记忆（memory）：noteId（`note:{id}`）
/// - 兜底：URL → 标题 → snippet，保证任意来源都有稳定身份
fn citation_identity(source: &SourceInfo, group: &str) -> String {
    let metadata = source.metadata.as_ref();
    let meta_str = |key: &str| {
        metadata
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
    };
    let meta_key = |key: &str| {
        metadata
            .and_then(|value| value.get(key))
            .filter(|value| !value.is_null())
            .map(|value| value.to_string())
            .unwrap_or_default()
    };
    match group {
        "memory" => {
            if let Some(note_id) = meta_str("noteId") {
                return format!("note:{}", note_id);
            }
        }
        "multimodal" => {
            let page = meta_key("pageIndex");
            if let Some(resource_id) = meta_str("resourceId").filter(|id| !id.is_empty()) {
                return format!("res:{}|p:{}", resource_id, page);
            }
            if let Some(blob_hash) = meta_str("blobHash").filter(|hash| !hash.is_empty()) {
                return format!("blob:{}|p:{}", blob_hash, page);
            }
        }
        _ => {
            if let Some(resource_id) = meta_str("resourceId").filter(|id| !id.is_empty()) {
                return format!("res:{}|c:{}", resource_id, meta_key("chunkIndex"));
            }
            if let Some(source_id) = meta_str("sourceId").filter(|id| !id.is_empty()) {
                return format!("src:{}|c:{}", source_id, meta_key("chunkIndex"));
            }
        }
    }
    if let Some(url) = source.url.as_deref().filter(|url| !url.is_empty()) {
        return format!("url:{}", url);
    }
    if let Some(title) = source.title.as_deref().filter(|title| !title.is_empty()) {
        return format!("title:{}", title);
    }
    format!("snippet:{}", source.snippet.as_deref().unwrap_or_default())
}

/// 构建带引用标记的来源列表（emit_end payload 与 tool_output 共用的唯一 sources 形状）
///
/// - citationTag/typeIndex 由回复级 Citation Ledger 分配：同一次助手回复内的多次
///   工具调用对同一来源恒定复用同一编号（`[类型-N]` 契约，前端直接信任不重排）
/// - snippet 应用单条与总量字符预算（P1-5），避免低价值长文本挤占上下文
/// - 平铺 blob_hash/note_id/folder_path 等字段，兼容前端 sourceAdapter
fn build_numbered_sources(
    sources: &[SourceInfo],
    ledger: &mut crate::chat_v2::context::CitationLedger,
) -> Vec<Value> {
    let mut snippet_budget = MAX_SNIPPET_TOTAL_CHARS;
    let mut numbered = Vec::with_capacity(sources.len());
    for (index, source) in sources.iter().enumerate() {
        let metadata = source.metadata.as_ref();
        let source_type = metadata
            .and_then(|value| value.get("sourceType"))
            .and_then(Value::as_str)
            .unwrap_or("text_search");
        let citation_prefix = citation_prefix_for_source_type(source_type);
        let citation_group = citation_group_for_source_type(source_type);
        let identity = citation_identity(source, citation_group);
        let citation_index = ledger.assign(citation_group, &identity).type_index;
        let snippet = source.snippet.as_deref().map(|snippet| {
            let allowance = MAX_SNIPPET_CHARS_PER_SOURCE.min(snippet_budget);
            let (text, used) = truncate_snippet_chars(snippet, allowance);
            snippet_budget = snippet_budget.saturating_sub(used);
            text
        });
        let resource_id = metadata
            .and_then(|value| value.get("resourceId"))
            .and_then(Value::as_str);
        let source_id = metadata
            .and_then(|value| value.get("sourceId"))
            .and_then(Value::as_str);
        let note_id = metadata
            .and_then(|value| value.get("noteId"))
            .cloned()
            .unwrap_or(Value::Null);
        numbered.push(json!({
            "index": index + 1,
            "citationTag": format!("[{}-{}]", citation_prefix, citation_index),
            "typeIndex": citation_index,
            "title": source.title,
            "url": source.url,
            "snippet": snippet,
            "score": source.score,
            "imageUrl": metadata.and_then(|value| value.get("imageUrl")),
            "imageCitation": metadata.and_then(|value| value.get("imageCitation")),
            "pageIndex": metadata.and_then(|value| value.get("pageIndex")),
            "chunkIndex": metadata.and_then(|value| value.get("chunkIndex")),
            "resourceId": resource_id,
            "resourceType": metadata.and_then(|value| value.get("resourceType")),
            "sourceId": source_id,
            "readResourceId": preferred_read_resource_id(resource_id, source_id),
            "source_type": source_type,
            "blob_hash": metadata.and_then(|value| value.get("blobHash")),
            "retrievalProvenance": metadata.and_then(|value| value.get("retrievalProvenance")),
            // 记忆来源字段（兼容前端 sourceAdapter 与 builtin-memory_read 的 noteId 入参）
            // 压缩摘要条目 noteId 为 null，真实成员 ID 见 sourceNoteIds（可逐个 memory_read）
            "noteId": note_id.clone(),
            "note_id": note_id,
            "sourceNoteIds": metadata.and_then(|value| value.get("sourceNoteIds")),
            "folder_path": metadata.and_then(|value| value.get("folderPath")),
        }));
    }
    numbered
}

/// 记忆文件夹下所有已索引笔记的 VFS resource_id 集合
///
/// 记忆笔记同时被 VFS 文本索引覆盖，unified_search 在源头把它们从
/// 知识库结果中排除。这比事后跨源去重更可靠：不依赖 sourceId/title 匹配。
fn memory_note_resource_ids(
    vfs_db: &std::sync::Arc<crate::vfs::database::VfsDatabase>,
    memory_service: &crate::memory::service::MemoryService,
) -> std::collections::HashSet<String> {
    memory_service
        .get_root_folder_id()
        .ok()
        .flatten()
        .and_then(|root_id| {
            use crate::vfs::repos::folder_repo::VfsFolderRepo;
            let folder_ids = VfsFolderRepo::get_folder_ids_recursive(vfs_db, &root_id).ok()?;
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
            Some(rows.filter_map(|row| row.ok()).collect())
        })
        .unwrap_or_default()
}

/// 统一检索的记忆路由（P0-1）
///
/// - 结果经 MemoryCompressor 压缩（低于阈值时跳过压缩）
/// - 失败被隔离为 RetrievalRouteFailure 汇入 routeFailures，绝不影响知识库结果
/// - 取消时静默返回空结果（不作为失败上报）
///
/// 使用信号说明（调查结论，2026-07）：`[记忆-N]` 的编号由后端 CitationLedger
/// 分配，但"模型最终回复里实际引用了哪几号"只在前端渲染层可见——后端不解析
/// 最终回复文本，管线内没有廉价挂点。引用级 `_used` 强化需要前端回传 citation
/// 使用情况，当前未实现（不为此新建前后端通信通道）。读取级强化已覆盖：
/// LLM 按 noteId / 压缩摘要的 sourceNoteIds 调 builtin-memory_read 时，
/// memory_executor 会异步记 `_used` 强使用信号。
async fn retrieve_memory_sources(
    memory_service: &crate::memory::service::MemoryService,
    llm_manager: &std::sync::Arc<crate::llm_manager::LLMManager>,
    query: &str,
    top_k: usize,
    ctx: &ExecutionContext,
) -> (
    Vec<SourceInfo>,
    Option<crate::vfs::retrieval_planner::RetrievalRouteFailure>,
) {
    let memory_top_k = (top_k / 2).max(3).min(10);
    let result = if let Some(cancel_token) = ctx.cancellation_token() {
        tokio::select! {
            result = memory_service.search(query, memory_top_k) => result,
            _ = cancel_token.cancelled() => {
                log::info!("[BuiltinRetrievalExecutor] memory route cancelled during unified search");
                return (Vec::new(), None);
            }
        }
    } else {
        memory_service.search(query, memory_top_k).await
    };
    match result {
        Ok(results) => {
            let memory_count = results.len();
            let compressor =
                crate::memory::MemoryCompressor::new(std::sync::Arc::clone(llm_manager));
            let compressed = compressor.compress(query, &results).await;
            let sources = compressed
                .into_iter()
                .map(|result| {
                    // 压缩摘要没有单一真实 noteId（置 null），改经 sourceNoteIds
                    // 暴露压缩前所有成员的真实 ID，供 memory_read 溯源
                    let mut metadata = json!({
                        "sourceType": "memory",
                        "noteId": result.note_id,
                        "folderPath": result.folder_path,
                    });
                    if !result.source_note_ids.is_empty() {
                        metadata["sourceNoteIds"] = json!(result.source_note_ids);
                    }
                    SourceInfo {
                        title: Some(result.note_title),
                        url: None,
                        snippet: Some(result.chunk_text),
                        score: Some(result.score),
                        metadata: Some(metadata),
                    }
                })
                .collect();
            log::debug!(
                "[BuiltinRetrievalExecutor] Memory route in unified search: {} results (compressed)",
                memory_count
            );
            (sources, None)
        }
        Err(error) => {
            log::warn!(
                "[BuiltinRetrievalExecutor] Unified memory route failed: {}",
                error
            );
            (
                Vec::new(),
                Some(crate::vfs::retrieval_planner::RetrievalRouteFailure {
                    route_id: "memory:unified".to_string(),
                    profile_id: None,
                    dimension: None,
                    error: error.to_string(),
                    timed_out: false,
                    query_derivation: None,
                }),
            )
        }
    }
}

/// 二次跨源去重：按 noteId / 标题移除仍以 note 形式混入知识库结果的记忆条目
/// （源头 resource_id 排除失败时的兜底）
fn dedup_kb_against_memory(kb_sources: &mut Vec<SourceInfo>, memory_sources: &[SourceInfo]) {
    use std::collections::HashSet;

    let mut memory_note_ids: HashSet<&str> = memory_sources
        .iter()
        .filter_map(|source| {
            source
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("noteId"))
                .and_then(Value::as_str)
        })
        .collect();
    // 压缩摘要条目 noteId 为 null，其成员真实 ID 在 sourceNoteIds 中，一并纳入去重
    for source in memory_sources {
        let Some(ids) = source
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("sourceNoteIds"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        memory_note_ids.extend(ids.iter().filter_map(Value::as_str));
    }
    let memory_titles: HashSet<&str> = memory_sources
        .iter()
        .filter_map(|source| source.title.as_deref())
        .collect();

    let before_dedup = kb_sources.len();
    kb_sources.retain(|source| {
        let metadata = source.metadata.as_ref();
        let is_note = metadata
            .and_then(|value| value.get("resourceType"))
            .and_then(Value::as_str)
            == Some("note");
        if !is_note {
            return true;
        }
        let source_id = metadata
            .and_then(|value| value.get("sourceId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !source_id.is_empty() && memory_note_ids.contains(source_id) {
            return false;
        }
        !source
            .title
            .as_deref()
            .is_some_and(|title| memory_titles.contains(title))
    });
    let deduped = before_dedup - kb_sources.len();
    if deduped > 0 {
        log::debug!(
            "[BuiltinRetrievalExecutor] Deduped {} memory notes from KB results (noteId+title match)",
            deduped
        );
    }
}

fn should_route_to_unified_search(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "rag_search" | "multimodal_search" | "unified_search"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlannedSearchScope {
    Unified,
    MultimodalOnly,
}

fn planned_search_scope(tool_name: &str) -> PlannedSearchScope {
    if tool_name == "multimodal_search" {
        PlannedSearchScope::MultimodalOnly
    } else {
        PlannedSearchScope::Unified
    }
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
// Rerank：文本 Reranker / VL-Reranker（P2-9：失败不再静默）
// ============================================================================

/// rerank 结果：候选列表 + 是否实际生效 + 失败原因
///
/// - `applied=false, failure=None`：正常降级（未配置 reranker / 无可 rerank 的查询）
/// - `applied=false, failure=Some`：rerank 失败回退 RRF 排序，失败信息汇入 routeFailures
struct RerankOutcome {
    sources: Vec<SourceInfo>,
    applied: bool,
    failure: Option<String>,
}

impl RerankOutcome {
    fn skipped(mut sources: Vec<SourceInfo>, top_k: usize) -> Self {
        sources.truncate(top_k);
        Self {
            sources,
            applied: false,
            failure: None,
        }
    }

    fn fallback(mut sources: Vec<SourceInfo>, top_k: usize, failure: impl Into<String>) -> Self {
        sources.truncate(top_k);
        Self {
            sources,
            applied: false,
            failure: Some(failure.into()),
        }
    }

    fn applied(sources: Vec<SourceInfo>) -> Self {
        Self {
            sources,
            applied: true,
            failure: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlannedRerankerKind {
    Text,
    Multimodal,
}

fn select_reranker_kind(
    query_modality: crate::vfs::retrieval_planner::QueryModality,
    candidates: &[SourceInfo],
) -> PlannedRerankerKind {
    let has_multimodal_candidate = candidates.iter().any(|candidate| {
        let metadata = candidate.metadata.as_ref();
        metadata
            .and_then(|value| value.get("blobHash"))
            .is_some_and(|value| !value.is_null())
            || metadata
                .and_then(|value| value.get("sourceType"))
                .and_then(Value::as_str)
                == Some("multimodal_search")
    });
    if query_modality.has_image() || has_multimodal_candidate {
        PlannedRerankerKind::Multimodal
    } else {
        PlannedRerankerKind::Text
    }
}

async fn text_rerank_sources(
    query: &str,
    candidates: Vec<SourceInfo>,
    top_k: usize,
    llm_manager: &std::sync::Arc<crate::llm_manager::LLMManager>,
) -> RerankOutcome {
    if candidates.is_empty() {
        return RerankOutcome::skipped(candidates, top_k);
    }
    let config = match llm_manager.get_reranker_model_config().await {
        Ok(config) if config.enabled && config.is_reranker && !config.is_multimodal => config,
        Ok(_) => {
            log::warn!("[hybrid-rag] Text reranker assignment has incompatible capabilities");
            return RerankOutcome::fallback(
                candidates,
                top_k,
                "text reranker assignment has incompatible capabilities",
            );
        }
        // 未配置 reranker 属于正常降级，不作为失败上报
        Err(_) => return RerankOutcome::skipped(candidates, top_k),
    };
    let chunks = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| crate::models::RetrievedChunk {
            chunk: crate::models::DocumentChunk {
                id: format!("rerank-source-{}", index),
                document_id: candidate
                    .metadata
                    .as_ref()
                    .and_then(|value| value.get("resourceId"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                chunk_index: candidate
                    .metadata
                    .as_ref()
                    .and_then(|value| value.get("chunkIndex"))
                    .and_then(Value::as_u64)
                    .unwrap_or(index as u64) as usize,
                text: candidate.snippet.clone().unwrap_or_default(),
                metadata: std::collections::HashMap::new(),
            },
            score: candidate.score.unwrap_or_default(),
        })
        .collect();
    match llm_manager
        .call_reranker_api(query.to_string(), chunks, &config.id)
        .await
    {
        Ok(results) => {
            let mut reranked = Vec::with_capacity(top_k.min(results.len()));
            for result in results.into_iter().take(top_k) {
                let Some(index) = result
                    .chunk
                    .id
                    .strip_prefix("rerank-source-")
                    .and_then(|value| value.parse::<usize>().ok())
                else {
                    continue;
                };
                if let Some(mut source) = candidates.get(index).cloned() {
                    source.score = Some(result.score);
                    reranked.push(source);
                }
            }
            if reranked.is_empty() {
                RerankOutcome::fallback(
                    candidates,
                    top_k,
                    "text reranker returned no usable results",
                )
            } else {
                RerankOutcome::applied(reranked)
            }
        }
        Err(error) => {
            log::warn!(
                "[hybrid-rag] Text reranker failed, retaining RRF: {}",
                error
            );
            RerankOutcome::fallback(
                candidates,
                top_k,
                format!("text reranker failed: {}", error),
            )
        }
    }
}

/// 使用 VL-Reranker 对候选集做跨模态精排
///
/// ## 实现说明
/// - 文本类候选：仅传入 snippet 文本
/// - 多模态类候选（有 blobHash）：加载图片 Base64 + snippet 一起送入
/// - 失败时降级为原始（RRF）排序，失败信息通过 RerankOutcome 上报，不阻断检索流程
async fn vl_rerank_sources_with_query(
    query_text: Option<&str>,
    query_image_base64: Option<&str>,
    query_image_media_type: Option<&str>,
    candidates: Vec<SourceInfo>,
    top_k: usize,
    llm_manager: &std::sync::Arc<crate::llm_manager::LLMManager>,
    vfs_db: &std::sync::Arc<crate::vfs::database::VfsDatabase>,
) -> RerankOutcome {
    use crate::multimodal::types::MultimodalInput;
    use crate::vfs::repos::VfsBlobRepo;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    if candidates.is_empty() {
        return RerankOutcome::skipped(candidates, top_k);
    }

    let _config = match llm_manager.get_vl_reranker_model_config().await {
        Ok(config) if config.enabled && config.is_reranker && config.is_multimodal => config,
        Ok(_) => {
            log::warn!("[hybrid-rag] VL reranker assignment has incompatible capabilities");
            return RerankOutcome::fallback(
                candidates,
                top_k,
                "VL reranker assignment has incompatible capabilities",
            );
        }
        // 未配置 VL reranker 属于正常降级，不作为失败上报
        Err(_) => return RerankOutcome::skipped(candidates, top_k),
    };

    // 构造 query 输入
    let query_input = match (
        query_text.filter(|value| !value.trim().is_empty()),
        query_image_base64.filter(|value| !value.trim().is_empty()),
    ) {
        (Some(text), Some(image)) => MultimodalInput::text_and_image(
            text,
            image,
            query_image_media_type.unwrap_or("image/png"),
        ),
        (None, Some(image)) => {
            MultimodalInput::image_base64(image, query_image_media_type.unwrap_or("image/png"))
        }
        (Some(text), None) => MultimodalInput::text(text),
        (None, None) => return RerankOutcome::skipped(candidates, top_k),
    };

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
            if reranked.is_empty() {
                RerankOutcome::fallback(candidates, top_k, "VL reranker returned no usable results")
            } else {
                RerankOutcome::applied(reranked)
            }
        }
        Err(e) => {
            log::warn!("[hybrid-rag] VL-Reranker 调用失败，降级为 RRF 排序: {}", e);
            RerankOutcome::fallback(candidates, top_k, format!("VL reranker failed: {}", e))
        }
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn source_with_score(title: &str, score: f32) -> SourceInfo {
        SourceInfo {
            title: Some(title.to_string()),
            url: None,
            snippet: Some(format!("Content of {}", title)),
            score: Some(score),
            metadata: None,
        }
    }

    fn kb_source(title: &str) -> SourceInfo {
        SourceInfo {
            title: Some(title.to_string()),
            url: None,
            snippet: Some("kb text".to_string()),
            score: Some(0.8),
            metadata: Some(json!({
                "sourceType": "text_search",
                "resourceType": "note",
                // citation_identity 以 resourceId 为一等身份：不同文档必须取不同值，
                // 否则编号会按「同一资源的不同 chunk」复用。
                "resourceId": format!("res_kb_{}", title),
                "sourceId": format!("note_{}", title),
            })),
        }
    }

    fn mm_source(title: &str) -> SourceInfo {
        SourceInfo {
            title: Some(title.to_string()),
            url: None,
            snippet: Some("page text".to_string()),
            score: Some(0.7),
            metadata: Some(json!({
                "sourceType": "multimodal_search",
                "pageIndex": 0,
                "blobHash": "hash123",
            })),
        }
    }

    fn memory_source(title: &str, note_id: &str) -> SourceInfo {
        SourceInfo {
            title: Some(title.to_string()),
            url: None,
            snippet: Some("memory text".to_string()),
            score: Some(0.9),
            metadata: Some(json!({
                "sourceType": "memory",
                "noteId": note_id,
                "folderPath": "偏好",
            })),
        }
    }

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
    fn score_thresholds_filter_low_scores_with_absolute_min() {
        let sources = vec![
            source_with_score("Doc1", 0.9),
            source_with_score("Doc2", 0.5),
            source_with_score("Doc3", 0.2), // 低于绝对阈值与相对阈值
        ];
        let filtered = apply_score_thresholds(sources, Some(0.3), 0.5);
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].title, Some("Doc1".to_string()));
        assert_eq!(filtered[1].title, Some("Doc2".to_string()));
    }

    #[test]
    fn score_thresholds_keep_top1_when_all_below_absolute_min() {
        let sources = vec![
            source_with_score("Doc1", 0.2),
            source_with_score("Doc2", 0.1),
        ];
        let filtered = apply_score_thresholds(sources, Some(0.3), 0.5);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].title, Some("Doc1".to_string()));
    }

    #[test]
    fn score_thresholds_apply_relative_only_for_rrf_scale() {
        // RRF 量级分数：不传绝对阈值，仅相对阈值生效
        let sources = vec![
            source_with_score("Doc1", 0.032),
            source_with_score("Doc2", 0.016), // == max * 0.5，保留
            source_with_score("Doc3", 0.010), // < max * 0.5，过滤
        ];
        let filtered = apply_score_thresholds(sources, None, 0.5);
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn snippet_truncation_respects_budget() {
        let (text, used) = truncate_snippet_chars("abcdef", 4);
        assert_eq!(used, 4);
        assert_eq!(text, "abc…");

        let (text, used) = truncate_snippet_chars("abc", 10);
        assert_eq!(used, 3);
        assert_eq!(text, "abc");

        let (text, used) = truncate_snippet_chars("abc", 0);
        assert_eq!(used, 0);
        assert_eq!(text, "");
    }

    #[test]
    fn numbered_sources_use_type_local_citation_indexes() {
        let sources = vec![
            kb_source("DocA"),
            mm_source("Page 1"),
            kb_source("DocB"),
            memory_source("用户偏好", "note_mem_1"),
        ];
        let mut ledger = crate::chat_v2::context::CitationLedger::new();
        let numbered = build_numbered_sources(&sources, &mut ledger);
        assert_eq!(numbered[0]["citationTag"], "[知识库-1]");
        assert_eq!(numbered[0]["typeIndex"], 1);
        assert_eq!(numbered[1]["citationTag"], "[图片-1]");
        assert_eq!(numbered[2]["citationTag"], "[知识库-2]");
        assert_eq!(numbered[2]["typeIndex"], 2);
        assert_eq!(numbered[3]["citationTag"], "[记忆-1]");
        assert_eq!(numbered[3]["note_id"], "note_mem_1");
        assert_eq!(numbered[3]["noteId"], "note_mem_1");
        // 全局 index 保持连续
        assert_eq!(numbered[3]["index"], 4);
    }

    #[test]
    fn numbered_sources_expose_multimodal_fields_for_frontend_adapter() {
        let mut ledger = crate::chat_v2::context::CitationLedger::new();
        let numbered = build_numbered_sources(&[mm_source("Page 1")], &mut ledger);
        assert_eq!(numbered[0]["source_type"], "multimodal_search");
        assert_eq!(numbered[0]["blob_hash"], "hash123");
        assert_eq!(numbered[0]["pageIndex"], 0);
    }

    #[test]
    fn dedup_removes_memory_notes_from_kb_results() {
        let memory = vec![memory_source("用户偏好", "note_DocA")];
        let mut kb = vec![kb_source("DocA"), kb_source("DocB")];
        // kb_source 的 sourceId 为 note_{title}，DocA 与记忆 noteId 相同 → 被去重
        dedup_kb_against_memory(&mut kb, &memory);
        assert_eq!(kb.len(), 1);
        assert_eq!(kb[0].title, Some("DocB".to_string()));
    }

    #[test]
    fn dedup_uses_source_note_ids_for_compressed_memory_entries() {
        // 压缩摘要条目：noteId 为 null，成员真实 ID 在 sourceNoteIds 中
        let memory = vec![SourceInfo {
            title: Some("用户记忆摘要".to_string()),
            url: None,
            snippet: Some("compressed summary".to_string()),
            score: Some(0.9),
            metadata: Some(json!({
                "sourceType": "memory",
                "noteId": Value::Null,
                "sourceNoteIds": ["note_DocA", "note_DocB"],
                "folderPath": "",
            })),
        }];
        let mut kb = vec![kb_source("DocA"), kb_source("DocC")];
        dedup_kb_against_memory(&mut kb, &memory);
        assert_eq!(kb.len(), 1);
        assert_eq!(kb[0].title, Some("DocC".to_string()));
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
    fn multimodal_search_uses_dedicated_me_only_scope() {
        assert_eq!(
            planned_search_scope("multimodal_search"),
            PlannedSearchScope::MultimodalOnly
        );
        assert_eq!(
            planned_search_scope("rag_search"),
            PlannedSearchScope::Unified
        );
        assert_eq!(
            planned_search_scope("unified_search"),
            PlannedSearchScope::Unified
        );
    }

    #[test]
    fn executor_failure_boundary_localizes_retrieval_errors() {
        let error: Value =
            serde_json::from_str(&localized_retrieval_failure("未配置多模态嵌入模型"))
                .expect("localized retrieval error");
        assert_eq!(error["code"], "RETRIEVAL_OPERATION_FAILED");
        assert_eq!(error["messageKey"], "chat.tools.retrieval.error");
        assert!(error["messageFallback"]["en-US"].is_string());
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
    fn reranker_selection_tracks_query_and_candidate_modality() {
        use crate::vfs::retrieval_planner::QueryModality;

        let text_source = SourceInfo {
            title: None,
            url: None,
            snippet: Some("text".to_string()),
            score: Some(0.1),
            metadata: Some(json!({ "sourceType": "text_search" })),
        };
        assert_eq!(
            select_reranker_kind(QueryModality::Text, &[text_source.clone()]),
            PlannedRerankerKind::Text
        );
        assert_eq!(
            select_reranker_kind(QueryModality::Image, &[text_source]),
            PlannedRerankerKind::Multimodal
        );
        let multimodal_source = SourceInfo {
            title: None,
            url: None,
            snippet: Some("image page".to_string()),
            score: Some(0.1),
            metadata: Some(json!({ "sourceType": "multimodal_search" })),
        };
        assert_eq!(
            select_reranker_kind(QueryModality::Text, &[multimodal_source]),
            PlannedRerankerKind::Multimodal
        );
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
