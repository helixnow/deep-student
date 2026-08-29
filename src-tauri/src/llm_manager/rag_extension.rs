//! RAG 扩展方法
//!
//! 嵌入/重排序模型配置、多模态RAG

use crate::json_validator::{validate, Stage as ValidateStage};
use crate::models::AppError;
use crate::utils::text::safe_truncate_chars;
use log::{debug, error, info, warn};
use serde_json::{json, Value};
use url::Url;

use super::routing::{key_cooldowns, key_fingerprint, tag_establish_failure};
use super::{
    build_provider_adapter, normalize_nonstream_response_to_openai, ApiConfig, LLMManager, Result,
};

// ==================== 嵌入调用错误结构化 ====================

/// 嵌入/重排序 HTTP 错误的结构化分类（写入 `AppError.details["embedding_error"]`）。
///
/// 上游消费方（如 `vfs::embedding_service` 的批内重试）依据该分类做
/// fail-fast / 退避决策，并读取 `retry_after_secs` respect 服务端 Retry-After。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingErrorKind {
    /// 401/403：鉴权失败（key 无效/权限不足），不可通过重试恢复
    Auth,
    /// 429：速率限制，可在 Retry-After 后重试
    RateLimited,
    /// 400/404/422：请求参数/内容问题，不可重试
    InvalidRequest,
    /// 5xx/408：服务端瞬态错误，可退避重试
    Server,
    /// 建立连接阶段的网络错误（超时/DNS/连接失败），可退避重试
    Network,
    /// 其他未识别错误
    Unknown,
}

impl EmbeddingErrorKind {
    fn from_status(status: u16) -> Self {
        match status {
            401 | 403 => Self::Auth,
            429 => Self::RateLimited,
            400 | 404 | 422 => Self::InvalidRequest,
            408 => Self::Server,
            500..=599 => Self::Server,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::RateLimited => "rate_limited",
            Self::InvalidRequest => "invalid_request",
            Self::Server => "server",
            Self::Network => "network",
            Self::Unknown => "unknown",
        }
    }
}

/// 解析 Retry-After 响应头（仅支持秒数形式；HTTP-date 形式返回 None）
fn parse_retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// 为嵌入类调用错误附加结构化元数据：
/// - `details["llm_failover"]`：复用 routing 的建立阶段打标（供 classify_llm_error）
/// - `details["embedding_error"]`：kind / http_status / retry_after_secs
fn tag_embedding_failure(
    err: AppError,
    http_status: Option<u16>,
    retry_after_secs: Option<u64>,
) -> AppError {
    let kind = match http_status {
        Some(status) => EmbeddingErrorKind::from_status(status),
        None => EmbeddingErrorKind::Network,
    };
    let mut err = tag_establish_failure(err, http_status);
    let mut details = err.details.take().unwrap_or_else(|| json!({}));
    if let Some(obj) = details.as_object_mut() {
        obj.insert(
            "embedding_error".to_string(),
            json!({
                "kind": kind.as_str(),
                "http_status": http_status,
                "retry_after_secs": retry_after_secs,
            }),
        );
    }
    err.details = Some(details);
    err
}

/// 从结构化错误中读取服务端建议的 Retry-After 秒数
pub fn embedding_error_retry_after_secs(err: &AppError) -> Option<u64> {
    err.details
        .as_ref()
        .and_then(|d| d.get("embedding_error"))
        .and_then(|e| e.get("retry_after_secs"))
        .and_then(|v| v.as_u64())
}

/// 从结构化错误中读取错误分类字符串（auth/rate_limited/invalid_request/server/network/unknown）
pub fn embedding_error_kind(err: &AppError) -> Option<&str> {
    err.details
        .as_ref()
        .and_then(|d| d.get("embedding_error"))
        .and_then(|e| e.get("kind"))
        .and_then(|v| v.as_str())
}

/// 嵌入 key 冷却表键（vendor 优先，缺失时退化到 base_url 作为租户标识）
fn embedding_cooldown_key(config: &ApiConfig, api_key: &str) -> String {
    let vendor = config
        .vendor_id
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(config.base_url.as_str());
    key_fingerprint(vendor, api_key)
}

// ==================== RAG相关扩展方法 ====================

impl LLMManager {
    /// 获取嵌入模型配置
    ///
    /// 从维度管理的默认设置中获取嵌入模型配置ID
    pub async fn get_embedding_model_config(&self) -> Result<ApiConfig> {
        // 从 settings 读取默认文本嵌入模型配置ID
        let embedding_model_id_opt = self
            .db
            .get_setting("embedding.default_text_model_config_id")
            .map_err(|e| AppError::configuration(format!("读取嵌入模型配置失败: {}", e)))?;

        // M13 fix: 如果没有显式设置默认维度，尝试智能回退
        let embedding_model_id = match embedding_model_id_opt {
            Some(id) => id,
            None => {
                // 兼容模型分配里的 embedding 槽：若已配置则回写维度默认键，消除双轨不一致。
                if let Ok(assignments) = self.get_model_assignments().await {
                    if let Some(id) = assignments.embedding_model_config_id {
                        info!(
                            "[RAG] Falling back to model_assignments.embedding_model_config_id={}",
                            id
                        );
                        let _ = self
                            .db
                            .save_setting("embedding.default_text_model_config_id", &id);
                        id
                    } else {
                        info!(
                            "[RAG] No default embedding dimension set, attempting auto-detect..."
                        );
                        self.auto_detect_embedding_model_id().await.ok_or_else(|| {
                            AppError::configuration(
                                "未配置默认嵌入维度。请在「模型分配 > 嵌入维度管理」中设置默认维度。",
                            )
                        })?
                    }
                } else {
                    info!("[RAG] No default embedding dimension set, attempting auto-detect...");
                    self.auto_detect_embedding_model_id().await.ok_or_else(|| {
                        AppError::configuration(
                            "未配置默认嵌入维度。请在「模型分配 > 嵌入维度管理」中设置默认维度。",
                        )
                    })?
                }
            }
        };

        let configs = self.get_api_configs().await?;
        let config = configs
            .into_iter()
            .find(|config| config.id == embedding_model_id)
            .ok_or_else(|| {
                AppError::configuration("找不到嵌入模型配置，请检查维度绑定的模型是否存在")
            })?;
        if !config.enabled || !config.is_embedding || config.is_multimodal || config.is_reranker {
            return Err(AppError::configuration(
                "默认文本嵌入配置已禁用或能力协议不匹配",
            ));
        }
        Ok(config)
    }

    /// M13 fix: 自动检测嵌入模型ID
    ///
    /// 当用户未显式设置默认维度时，查找已配置的嵌入模型作为回退。
    /// 检查来源：
    /// 1. `embedding.default_text_dimension` + VFS 维度表中绑定的模型
    /// 2. 已启用的嵌入类 API 配置（isEmbedding=true）
    async fn auto_detect_embedding_model_id(&self) -> Option<String> {
        // 先检查是否已设置了默认维度（但缺少 model_config_id 的情况）
        if let Ok(Some(dim_str)) = self.db.get_setting("embedding.default_text_dimension") {
            // 有默认维度但缺 model_config_id —— 说明设置不完整
            info!(
                "[RAG] Default dimension {} set but model_config_id missing",
                dim_str
            );
        }

        // 尝试从已启用的 API 配置中找到嵌入模型
        if let Ok(configs) = self.get_api_configs().await {
            let embedding_configs: Vec<_> = configs
                .iter()
                .filter(|c| c.enabled && c.is_embedding && !c.is_multimodal && !c.is_reranker)
                .collect();

            if embedding_configs.len() == 1 {
                // 只有一个嵌入模型，自动使用
                let config = embedding_configs[0];
                info!(
                    "[RAG] Auto-detected single embedding model: id={}, name={}",
                    config.id, config.name
                );
                let _ = self
                    .db
                    .save_setting("embedding.default_text_model_config_id", &config.id);
                return Some(config.id.clone());
            } else if embedding_configs.len() > 1 {
                // Debug only: VfsIndexWorker polls every few seconds; INFO here floods logs.
                debug!(
                    "[RAG] Found {} embedding models, cannot auto-select. User must configure default.",
                    embedding_configs.len()
                );
            }
        }

        None
    }

    /// 获取重排序模型配置
    pub async fn get_reranker_model_config(&self) -> Result<ApiConfig> {
        let assignments = self.get_model_assignments().await?;
        let reranker_model_id = assignments
            .reranker_model_config_id
            .ok_or_else(|| AppError::configuration("未配置重排序模型"))?;

        let configs = self.get_api_configs().await?;
        let config = configs
            .into_iter()
            .find(|config| config.id == reranker_model_id)
            .ok_or_else(|| AppError::configuration("找不到重排序模型配置"))?;
        if !config.enabled || !config.is_reranker || config.is_multimodal || config.is_embedding {
            return Err(AppError::configuration(
                "文本重排序配置已禁用或能力协议不匹配",
            ));
        }
        Ok(config)
    }

    // ==================== 多模态知识库模型配置获取 ====================

    /// 获取多模态嵌入模型配置（Qwen3-VL-Embedding）
    ///
    /// 从维度管理的默认设置中获取多模态嵌入模型配置ID
    pub async fn get_vl_embedding_model_config(&self) -> Result<ApiConfig> {
        // 从 settings 读取默认多模态嵌入模型配置ID
        let vl_embedding_model_id = self
            .db
            .get_setting("embedding.default_multimodal_model_config_id")
            .map_err(|e| AppError::configuration(format!("读取多模态嵌入模型配置失败: {}", e)))?
            .ok_or_else(|| {
                AppError::configuration(
                "未配置默认多模态嵌入维度。请在「模型分配 > 嵌入维度管理」中设置默认多模态维度。"
            )
            })?;

        let configs = self.get_api_configs().await?;
        let config = configs
            .into_iter()
            .find(|config| config.id == vl_embedding_model_id)
            .ok_or_else(|| {
                AppError::configuration("找不到多模态嵌入模型配置，请检查维度绑定的模型是否存在")
            })?;
        if !config.enabled || !config.is_embedding || !config.is_multimodal || config.is_reranker {
            return Err(AppError::configuration(
                "默认多模态嵌入配置已禁用或能力协议不匹配",
            ));
        }
        Ok(config)
    }

    /// 获取多模态重排序模型配置（Qwen3-VL-Reranker）
    ///
    /// 用于对跨模态检索结果进行精细排序
    pub async fn get_vl_reranker_model_config(&self) -> Result<ApiConfig> {
        let assignments = self.get_model_assignments().await?;
        let vl_reranker_model_id = assignments
            .vl_reranker_model_config_id
            .ok_or_else(|| AppError::configuration("未配置多模态重排序模型 (VL-Reranker)"))?;

        let configs = self.get_api_configs().await?;
        let config = configs
            .into_iter()
            .find(|config| config.id == vl_reranker_model_id)
            .ok_or_else(|| AppError::configuration("找不到多模态重排序模型配置"))?;
        if !config.enabled || !config.is_reranker || !config.is_multimodal || config.is_embedding {
            return Err(AppError::configuration(
                "多模态重排序配置已禁用或能力协议不匹配",
            ));
        }
        Ok(config)
    }

    /// 检查多模态知识库模型是否已配置
    ///
    /// 支持两种索引模式：
    /// - 方案一（VL-Embedding）：需要配置默认多模态嵌入维度
    /// - 方案二（VL 摘要 + 文本嵌入）：已废弃（第一模型移除）
    ///
    /// 只要任一方案可用即返回 true
    pub async fn is_multimodal_rag_configured(&self) -> bool {
        // 方案一：VL-Embedding 直接向量化（从维度管理获取）
        let mode1_available = self.get_vl_embedding_model_config().await.is_ok();

        // 方案二：VL 摘要 + 文本嵌入已废弃
        mode1_available
    }

    /// 检查多模态精排是否已配置
    pub async fn is_multimodal_reranking_configured(&self) -> bool {
        self.get_vl_reranker_model_config().await.is_ok()
    }

    /// 调用多模态嵌入API（Qwen3-VL-Embedding）
    ///
    /// 将图文混合内容编码为统一语义向量。
    /// 内部自动获取已配置的多模态嵌入模型，无需外部传入 model_config_id。
    ///
    /// # 参数
    /// - `inputs`: 多模态输入列表（支持纯文本、纯图片、图文混合）
    ///
    /// # 返回
    /// - 每个输入对应的向量（维度取决于模型配置，默认 4096 维）
    pub async fn call_multimodal_embedding_api(
        &self,
        inputs: &[crate::multimodal::MultimodalInput],
    ) -> Result<Vec<Vec<f32>>> {
        let config = self.get_vl_embedding_model_config().await?;
        self.call_multimodal_embedding_api_with_config(inputs, &config)
            .await
    }

    /// Call the multimodal embedding protocol with a specific model configuration.
    ///
    /// Multi-space retrieval uses the model bound to each active index profile. This is
    /// intentionally separate from `call_embedding_api`: an image query must never be
    /// serialized as a plain text-embedding request merely because dimensions match.
    pub async fn call_multimodal_embedding_api_for_model(
        &self,
        inputs: &[crate::multimodal::MultimodalInput],
        model_config_id: &str,
    ) -> Result<Vec<Vec<f32>>> {
        let configs = self.get_api_configs().await?;
        let config = configs
            .iter()
            .find(|config| config.id == model_config_id)
            .ok_or_else(|| AppError::configuration("找不到多模态嵌入模型配置"))?;
        if !config.enabled {
            return Err(AppError::configuration("多模态嵌入模型配置已禁用"));
        }
        if !config.is_embedding || !config.is_multimodal || config.is_reranker {
            return Err(AppError::configuration("指定模型不支持多模态嵌入协议"));
        }
        self.call_multimodal_embedding_api_with_config(inputs, config)
            .await
    }

    pub(crate) async fn call_multimodal_embedding_api_with_config(
        &self,
        inputs: &[crate::multimodal::MultimodalInput],
        config: &ApiConfig,
    ) -> Result<Vec<Vec<f32>>> {
        use crate::multimodal::VLEmbeddingInputItem;

        if inputs.is_empty() {
            return Ok(Vec::new());
        }

        debug!("调用多模态嵌入API，输入数量: {}", inputs.len());

        let api_key = self.decrypt_api_key_if_needed(&config.api_key)?;

        // 将 MultimodalInput 转换为 API 请求格式
        let api_inputs: Vec<VLEmbeddingInputItem> =
            inputs.iter().map(|input| input.into()).collect();

        // 构造请求体
        // Qwen3-VL-Embedding API 格式：
        // {
        //   "model": "...",
        //   "input": [{"text": "...", "image": "data:..."}, ...],
        //   "encoding_format": "float"
        // }
        let request_body = json!({
            "model": config.model,
            "input": api_inputs,
            "encoding_format": "float"
        });

        // 发送请求
        let url = format!("{}/embeddings", config.base_url.trim_end_matches('/'));
        let mut request_builder = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity");

        if let Ok(parsed_url) = Url::parse(&config.base_url) {
            if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                && parsed_url.host_str().is_some()
            {
                let origin_val = format!(
                    "{}://{}",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                request_builder = request_builder.header("Origin", origin_val);
            }
        }

        let response = request_builder
            .json(&request_body)
            .send()
            .await
            .map_err(|e| {
                tag_embedding_failure(
                    AppError::network(format!("多模态嵌入API请求失败: {}", e)),
                    None,
                    None,
                )
            })?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let retry_after_secs = parse_retry_after_secs(response.headers());
            let error_text = response.text().await.unwrap_or_default();
            // 记录完整错误到日志（仅开发调试用）
            error!("[MultimodalEmbedding] API error {}: {}", status, error_text);
            // 返回用户友好的错误消息，不暴露敏感信息
            let user_message = match status {
                401 => "API 密钥无效或已过期，请检查设置",
                403 => "API 访问被拒绝，请检查账户权限",
                429 => "请求过于频繁，请稍后重试",
                500..=599 => "嵌入服务暂时不可用，请稍后重试",
                _ => "嵌入请求失败，请重试",
            };

            // ★ 2026-07 P1：多模态嵌入同样接入 key 冷却
            if matches!(status, 401 | 403 | 429) {
                let default_secs = self
                    .get_failover_policy()
                    .await
                    .unwrap_or_default()
                    .key_cooldown_secs;
                let cooldown_secs = retry_after_secs.unwrap_or(default_secs).clamp(1, 3600);
                key_cooldowns().set_for(
                    &embedding_cooldown_key(config, &api_key),
                    std::time::Duration::from_secs(cooldown_secs),
                );
                warn!(
                    "[MultimodalEmbedding] HTTP {} for model {}; key cooled down for {}s",
                    status, config.model, cooldown_secs
                );
            }

            return Err(tag_embedding_failure(
                AppError::llm(user_message.to_string()),
                Some(status),
                retry_after_secs,
            ));
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::llm(format!("解析多模态嵌入API响应失败: {}", e)))?;

        // 解析嵌入向量
        let data = response_json["data"]
            .as_array()
            .ok_or_else(|| AppError::llm("多模态嵌入API响应格式无效：缺少data字段"))?;

        let mut embeddings = Vec::new();
        for item in data {
            let embedding = item["embedding"]
                .as_array()
                .ok_or_else(|| AppError::llm("多模态嵌入API响应格式无效：缺少embedding字段"))?;

            let vector: Result<Vec<f32>> = embedding
                .iter()
                .map(|v| {
                    v.as_f64()
                        .map(|f| f as f32)
                        .ok_or_else(|| AppError::llm("嵌入向量包含无效数值"))
                })
                .collect();

            embeddings.push(vector?);
        }

        if embeddings.len() != inputs.len() {
            return Err(AppError::llm(format!(
                "多模态嵌入向量数量({})与输入数量({})不匹配",
                embeddings.len(),
                inputs.len()
            )));
        }

        info!(
            "多模态嵌入API调用成功，返回 {} 个向量，维度: {}",
            embeddings.len(),
            embeddings.first().map(|v| v.len()).unwrap_or(0)
        );
        Ok(embeddings)
    }

    /// 调用多模态重排序API（Qwen3-VL-Reranker）
    ///
    /// 对跨模态检索结果进行精细排序。
    /// 内部自动获取已配置的多模态重排序模型，无需外部传入 model_config_id。
    ///
    /// # 参数
    /// - `query`: 查询内容（可包含文本和/或图片）
    /// - `documents`: 候选文档列表
    ///
    /// # 返回
    /// - 按相关性分数降序排列的结果（包含原始索引和分数）
    pub async fn call_multimodal_reranker_api(
        &self,
        query: &crate::multimodal::MultimodalInput,
        documents: &[crate::multimodal::MultimodalInput],
    ) -> Result<Vec<crate::multimodal::VLRerankerResult>> {
        use crate::multimodal::{VLEmbeddingInputItem, VLRerankerResult};

        if documents.is_empty() {
            return Ok(Vec::new());
        }

        debug!("调用多模态重排序API，候选文档数量: {}", documents.len());

        // 获取多模态重排序模型配置
        let config = self.get_vl_reranker_model_config().await?;
        let api_key = self.decrypt_api_key_if_needed(&config.api_key)?;

        // 转换为 API 格式
        let query_input: VLEmbeddingInputItem = query.into();
        let doc_inputs: Vec<VLEmbeddingInputItem> = documents.iter().map(|d| d.into()).collect();

        // 构造请求体
        // Qwen3-VL-Reranker API 格式：
        // {
        //   "model": "...",
        //   "query": {"text": "...", "image": "..."},
        //   "documents": [{"text": "...", "image": "..."}, ...],
        //   "top_k": n
        // }
        let request_body = json!({
            "model": config.model,
            "query": query_input,
            "documents": doc_inputs,
            "top_k": documents.len(),
            "return_documents": false
        });

        // 发送请求
        let url = format!("{}/rerank", config.base_url.trim_end_matches('/'));
        let mut request_builder = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity");

        if let Ok(parsed_url) = Url::parse(&config.base_url) {
            if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                && parsed_url.host_str().is_some()
            {
                let origin_val = format!(
                    "{}://{}",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                request_builder = request_builder.header("Origin", origin_val);
            }
        }

        let response = request_builder
            .json(&request_body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("多模态重排序API请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            // 记录完整错误到日志（仅开发调试用）
            error!("[MultimodalReranker] API error {}: {}", status, error_text);
            // 返回用户友好的错误消息，不暴露敏感信息
            let user_message = match status.as_u16() {
                401 => "API 密钥无效或已过期，请检查设置",
                403 => "API 访问被拒绝，请检查账户权限",
                429 => "请求过于频繁，请稍后重试",
                500..=599 => "重排序服务暂时不可用，请稍后重试",
                _ => "重排序请求失败，请重试",
            };
            return Err(AppError::llm(user_message.to_string()));
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::llm(format!("解析多模态重排序API响应失败: {}", e)))?;

        // 解析重排序结果
        let results = response_json["results"]
            .as_array()
            .ok_or_else(|| AppError::llm("多模态重排序API响应格式无效：缺少results字段"))?;

        let mut reranked_results = Vec::new();
        for result in results {
            let index = result["index"]
                .as_u64()
                .ok_or_else(|| AppError::llm("重排序结果缺少index字段"))?
                as usize;
            let relevance_score = result["relevance_score"]
                .as_f64()
                .ok_or_else(|| AppError::llm("重排序结果缺少relevance_score字段"))?
                as f32;

            reranked_results.push(VLRerankerResult {
                index,
                relevance_score,
            });
        }

        // 按相关性分数降序排序
        reranked_results.sort_by(|a, b| {
            b.relevance_score
                .partial_cmp(&a.relevance_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        info!(
            "多模态重排序API调用成功，返回 {} 个重排序结果",
            reranked_results.len()
        );
        Ok(reranked_results)
    }

    /// 获取翻译专用模型配置（优先翻译模型，未配置则回退到model2）
    pub async fn get_translation_model_config(&self) -> Result<ApiConfig> {
        let assignments = self.get_model_assignments().await?;

        // 优先使用翻译专用模型
        let model_id = if let Some(translation_id) = &assignments.translation_model_config_id {
            translation_id.clone()
        } else if let Some(model2_id) = &assignments.model2_config_id {
            // 回退到model2
            warn!("未配置翻译专用模型，回退到model2");
            model2_id.clone()
        } else {
            return Err(AppError::configuration("未配置翻译模型或model2"));
        };

        let configs = self.get_api_configs().await?;
        configs
            .into_iter()
            .find(|config| config.id == model_id)
            .ok_or_else(|| AppError::configuration("找不到翻译模型配置"))
    }

    /// 翻译文本（非流式）
    ///
    /// # 参数
    /// - `text`: 待翻译文本
    /// - `src_lang`: 源语言（如 "zh"/"en"/"auto"）
    /// - `tgt_lang`: 目标语言
    /// - `custom_prompt`: 可选的自定义prompt覆盖
    pub async fn translate_text(
        &self,
        text: &str,
        src_lang: &str,
        tgt_lang: &str,
        custom_prompt: Option<&str>,
    ) -> Result<String> {
        info!(
            "开始翻译：{} -> {}, 文本长度：{}",
            src_lang,
            tgt_lang,
            text.len()
        );

        let config = self.get_translation_model_config().await?;
        let api_key = self.decrypt_api_key_if_needed(&config.api_key)?;

        // 复用翻译管线的 prompt 构建（统一语言全名映射和领域预设）
        let translate_req = crate::translation::types::TranslationRequest {
            text: text.to_string(),
            src_lang: src_lang.to_string(),
            tgt_lang: tgt_lang.to_string(),
            prompt_override: custom_prompt.map(|s| s.to_string()),
            session_id: String::new(),
            formality: None,
            glossary: None,
            domain: None,
        };
        let (system_prompt, user_prompt) =
            crate::translation::pipeline::build_translation_prompts(&translate_req)?;

        let messages = vec![
            json!({
                "role": "system",
                "content": system_prompt
            }),
            json!({
                "role": "user",
                "content": user_prompt
            }),
        ];

        // 构造请求
        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": config.max_output_tokens,
            "stream": false,
        });

        let adapter = build_provider_adapter(&config);
        let mut preq = self
            .prepare_provider_request(
                adapter.as_ref(),
                &config,
                &request_body,
                Some(&api_key),
                None,
                "翻译请求构建失败",
            )
            .await?;

        let response = if preq.is_codex() {
            self.send_codex_request_with_single_refresh(&mut preq, None)
                .await?
        } else {
            let mut request_builder = self.client.post(&preq.url);
            for (name, value) in &preq.headers {
                request_builder = request_builder.header(name, value);
            }
            request_builder
                .json(&preq.body)
                .send()
                .await
                .map_err(|e| AppError::llm(format!("翻译请求失败: {}", e)))?
        };

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            // 记录完整错误到日志（仅开发调试用）
            error!("[Translation] API error {}: {}", status, error_text);
            // 返回用户友好的错误消息，不暴露敏感信息
            let user_message = match status.as_u16() {
                401 => "API 密钥无效或已过期，请检查设置",
                403 => "API 访问被拒绝，请检查账户权限",
                429 => "请求过于频繁，请稍后重试",
                500..=599 => "翻译服务暂时不可用，请稍后重试",
                _ => "翻译请求失败，请重试",
            };
            return Err(AppError::llm(user_message.to_string()));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::llm(format!("读取翻译响应失败: {}", e)))?;

        let response_json: Value = serde_json::from_str(&response_text).map_err(|e| {
            AppError::llm(format!(
                "解析翻译响应JSON失败: {}, 原始内容: {}",
                e, response_text
            ))
        })?;

        let openai_like = normalize_nonstream_response_to_openai(&config, &response_json)?;

        // 提取翻译结果
        let translated_text = openai_like["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::llm("翻译响应中未找到内容"))?;

        info!("翻译完成，结果长度：{}", translated_text.len());
        Ok(translated_text.to_string())
    }

    /// 调用嵌入API生成向量
    /// 生成单个文本的嵌入向量 - 为移动端服务提供简化接口
    pub async fn generate_embedding(&self, text: &str) -> Result<Vec<f32>> {
        // 获取默认的嵌入模型配置
        let embedding_config = self.get_embedding_model_config().await?;

        // 调用嵌入API
        let embeddings = self
            .call_embedding_api(vec![text.to_string()], &embedding_config.id)
            .await?;

        // 返回第一个（也是唯一的）嵌入向量
        embeddings
            .into_iter()
            .next()
            .ok_or_else(|| AppError::llm("No embedding returned"))
    }

    pub async fn call_embedding_api(
        &self,
        texts: Vec<String>,
        model_config_id: &str,
    ) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        // 获取API配置
        let configs = self.get_api_configs().await?;
        let config = configs
            .iter()
            .find(|c| c.id == model_config_id)
            .ok_or_else(|| AppError::configuration("找不到嵌入模型配置"))?;
        if !config.enabled || !config.is_embedding || config.is_multimodal || config.is_reranker {
            return Err(AppError::configuration(
                "指定模型不支持文本嵌入协议或已禁用",
            ));
        }

        // 获取模型的 token 限制并创建分块器
        let token_limits = crate::multimodal::embedding_chunker::EmbeddingTokenLimits::default();
        let max_tokens = token_limits.get_limit(&config.model);
        let chunker = crate::multimodal::embedding_chunker::EmbeddingChunker::new(max_tokens);

        // 检查是否需要分块
        let needs_chunking = texts.iter().any(|t| chunker.needs_chunking(t));

        if !needs_chunking {
            // 不需要分块，直接调用 API
            debug!("调用嵌入API，文本数量: {}", texts.len());
            return self.call_embedding_api_raw(texts, config).await;
        }

        // 需要分块处理
        info!(
            "嵌入分块：检测到长文本，启用分块处理 (模型限制: {} tokens)",
            max_tokens
        );

        let chunk_results =
            crate::multimodal::embedding_chunker::batch_chunk_texts(&texts, &chunker);
        let all_chunks: Vec<String> = chunk_results
            .iter()
            .flat_map(|r| r.chunks.clone())
            .collect();

        info!(
            "嵌入分块：{} 个文本分为 {} 个块",
            texts.len(),
            all_chunks.len()
        );

        debug!("调用嵌入API，文本数量: {} (分块后)", all_chunks.len());
        let all_embeddings = self.call_embedding_api_raw(all_chunks, config).await?;

        // 聚合每个原始文本的块嵌入
        let mut result = Vec::with_capacity(texts.len());
        let mut emb_idx = 0;

        for chunk_result in &chunk_results {
            let chunk_count = chunk_result.chunks.len();

            if chunk_count == 0 {
                let dim = all_embeddings.first().map(|v| v.len()).unwrap_or(1024);
                result.push(vec![0.0; dim]);
            } else if chunk_count == 1 {
                result.push(all_embeddings[emb_idx].clone());
            } else {
                let chunk_embeddings: Vec<_> =
                    all_embeddings[emb_idx..emb_idx + chunk_count].to_vec();
                let aggregated =
                    crate::multimodal::embedding_chunker::EmbeddingChunker::aggregate_embeddings(
                        &chunk_embeddings,
                        crate::multimodal::embedding_chunker::ChunkAggregation::MeanPooling,
                    );
                result.push(aggregated);
            }

            emb_idx += chunk_count;
        }

        info!("嵌入分块：聚合完成，返回 {} 个向量", result.len());
        Ok(result)
    }

    /// 内部方法：直接调用嵌入 API（不做分块）
    async fn call_embedding_api_raw(
        &self,
        texts: Vec<String>,
        config: &ApiConfig,
    ) -> Result<Vec<Vec<f32>>> {
        // 解密API密钥
        let api_key = self.decrypt_api_key_if_needed(&config.api_key)?;

        // ★ 2026-07 P1：嵌入调用接入 key 冷却。刚被 429/401 的 key 在冷却期内
        // fail-fast，避免批量索引持续轰炸限速中的端点。冷却由下方错误分支写入。
        let cooldown_key = embedding_cooldown_key(config, &api_key);
        if key_cooldowns().is_cooling(&cooldown_key) {
            warn!(
                "[Embedding] Key for model {} is cooling down; failing fast",
                config.model
            );
            return Err(tag_embedding_failure(
                AppError::llm("嵌入 API 密钥处于限速/鉴权冷却期，请稍后重试"),
                Some(429),
                None,
            ));
        }

        // 构造请求
        let request_body = match config.model_adapter.as_str() {
            "openai" | "general" => {
                json!({
                    "model": config.model,
                    "input": texts,
                    "encoding_format": "float"
                })
            }
            "anthropic" | "claude" => {
                // Claude目前不直接支持嵌入，这里返回错误
                return Err(AppError::configuration("Claude模型不支持嵌入API"));
            }
            _ => {
                // 默认使用OpenAI格式
                json!({
                    "model": config.model,
                    "input": texts,
                    "encoding_format": "float"
                })
            }
        };

        // 发送请求
        let url = format!("{}/embeddings", config.base_url.trim_end_matches('/'));
        let mut request_builder = self.client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream, application/json, text/plain, */*")
            .header("Accept-Encoding", "identity")  // 禁用压缩，避免二进制响应
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");

        if let Ok(parsed_url) = Url::parse(&config.base_url) {
            // config is the specific model config here
            if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                && parsed_url.host_str().is_some()
            {
                let origin_val = format!(
                    "{}://{}",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                let referer_val = format!(
                    "{}://{}/",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                request_builder = request_builder
                    .header("Origin", origin_val)
                    .header("Referer", referer_val);
            }
        }

        let response = request_builder
            .json(&request_body)
            .send()
            .await
            .map_err(|e| {
                // 建立阶段网络失败：打标为可重试的瞬态错误
                tag_embedding_failure(
                    AppError::network(format!("嵌入API请求失败: {}", e)),
                    None,
                    None,
                )
            })?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            // ★ 2026-07 P0：在消费 body 前读取 Retry-After，结构化透传给上游重试逻辑
            let retry_after_secs = parse_retry_after_secs(response.headers());
            let error_text = response.text().await.unwrap_or_default();
            // 记录完整错误到日志（仅开发调试用）
            error!("[Embedding] API error {}: {}", status, error_text);
            // 返回用户友好的错误消息，不暴露敏感信息
            let user_message = match status {
                401 => "API 密钥无效或已过期，请检查设置",
                403 => "API 访问被拒绝，请检查账户权限",
                429 => "请求过于频繁，请稍后重试",
                500..=599 => "嵌入服务暂时不可用，请稍后重试",
                _ => "嵌入请求失败，请重试",
            };

            // ★ 2026-07 P1：429 冷却当前 key（respect Retry-After）；
            // 401/403 同样短冷却，避免坏 key 被批量索引反复重试。
            if matches!(status, 401 | 403 | 429) {
                let default_secs = self
                    .get_failover_policy()
                    .await
                    .unwrap_or_default()
                    .key_cooldown_secs;
                let cooldown_secs = retry_after_secs.unwrap_or(default_secs).clamp(1, 3600);
                key_cooldowns()
                    .set_for(&cooldown_key, std::time::Duration::from_secs(cooldown_secs));
                warn!(
                    "[Embedding] HTTP {} for model {}; key cooled down for {}s (retry_after={:?})",
                    status, config.model, cooldown_secs, retry_after_secs
                );
            }

            return Err(tag_embedding_failure(
                AppError::llm(user_message.to_string()),
                Some(status),
                retry_after_secs,
            ));
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::llm(format!("解析嵌入API响应失败: {}", e)))?;

        // 解析嵌入向量
        let data = response_json["data"]
            .as_array()
            .ok_or_else(|| AppError::llm("嵌入API响应格式无效：缺少data字段"))?;

        let mut embeddings = Vec::new();
        for item in data {
            let embedding = item["embedding"]
                .as_array()
                .ok_or_else(|| AppError::llm("嵌入API响应格式无效：缺少embedding字段"))?;

            let vector: Result<Vec<f32>> = embedding
                .iter()
                .map(|v| {
                    v.as_f64()
                        .map(|f| f as f32)
                        .ok_or_else(|| AppError::llm("嵌入向量包含无效数值"))
                })
                .collect();

            embeddings.push(vector?);
        }

        if embeddings.len() != texts.len() {
            return Err(AppError::llm("嵌入向量数量与输入文本数量不匹配"));
        }

        // 记录 Embedding API 使用量
        // Embedding API 的 usage 格式：{ "prompt_tokens": N, "total_tokens": N }
        let measured_prompt_tokens = response_json
            .get("usage")
            .and_then(|u| u.get("prompt_tokens").or_else(|| u.get("total_tokens")))
            .and_then(|v| v.as_u64());

        crate::llm_usage::record_llm_usage_ext(
            crate::llm_usage::CallerType::Embedding,
            &config.model,
            measured_prompt_tokens.unwrap_or(0) as u32,
            0, // Embedding 不产生 completion tokens
            None,
            None,
            None,
            None,
            true,
            None,
            // OpenAI 兼容 /embeddings 端点（报表按协议拆分）
            Some("openai_embeddings".to_string()),
            // 真实 token 来源：API 实测才标 api，未上报的 0 不得伪装成 api
            Some(
                if measured_prompt_tokens.is_some() {
                    crate::chat_v2::types::TokenSource::Api
                } else {
                    crate::chat_v2::types::TokenSource::Heuristic
                }
                .to_string(),
            ),
        );

        info!("嵌入API调用成功，返回 {} 个向量", embeddings.len());
        Ok(embeddings)
    }

    /// 调用重排序API
    pub async fn call_reranker_api(
        &self,
        query: String,
        chunks: Vec<crate::models::RetrievedChunk>,
        model_config_id: &str,
    ) -> Result<Vec<crate::models::RetrievedChunk>> {
        debug!("调用重排序API，候选文档数量: {}", chunks.len());

        // 获取API配置
        let configs = self.get_api_configs().await?;
        let config = configs
            .iter()
            .find(|c| c.id == model_config_id)
            .ok_or_else(|| AppError::configuration("找不到重排序模型配置"))?;
        if !config.enabled || !config.is_reranker || config.is_multimodal || config.is_embedding {
            return Err(AppError::configuration(
                "指定模型不支持文本重排序协议或已禁用",
            ));
        }

        // 解密API密钥
        let api_key = self.decrypt_api_key_if_needed(&config.api_key)?;

        // 构造重排序请求
        let documents: Vec<String> = chunks
            .iter()
            .map(|chunk| chunk.chunk.text.clone())
            .collect();

        let request_body = json!({
            "model": config.model,
            "query": query,
            "documents": documents,
            "top_k": chunks.len(),
            "return_documents": true
        });

        // 发送请求
        let url = format!("{}/rerank", config.base_url.trim_end_matches('/'));
        let mut request_builder = self.client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream, application/json, text/plain, */*")
            .header("Accept-Encoding", "identity")  // 禁用压缩，避免二进制响应
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");

        if let Ok(parsed_url) = Url::parse(&config.base_url) {
            // config is the specific model config here
            if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                && parsed_url.host_str().is_some()
            {
                let origin_val = format!(
                    "{}://{}",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                let referer_val = format!(
                    "{}://{}/",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                request_builder = request_builder
                    .header("Origin", origin_val)
                    .header("Referer", referer_val);
            }
        }

        let response = request_builder
            .json(&request_body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("重排序API请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            // 记录完整错误到日志（仅开发调试用）
            error!("[Reranker] API error {}: {}", status, error_text);
            // 返回用户友好的错误消息，不暴露敏感信息
            let user_message = match status.as_u16() {
                401 => "API 密钥无效或已过期，请检查设置",
                403 => "API 访问被拒绝，请检查账户权限",
                429 => "请求过于频繁，请稍后重试",
                500..=599 => "重排序服务暂时不可用，请稍后重试",
                _ => "重排序请求失败，请重试",
            };
            return Err(AppError::llm(user_message.to_string()));
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::llm(format!("解析重排序API响应失败: {}", e)))?;

        // 解析重排序结果
        let results = response_json["results"]
            .as_array()
            .ok_or_else(|| AppError::llm("重排序API响应格式无效：缺少results字段"))?;

        let mut reranked_chunks = Vec::new();
        for result in results {
            let index = result["index"]
                .as_u64()
                .ok_or_else(|| AppError::llm("重排序结果缺少index字段"))?
                as usize;
            let relevance_score = result["relevance_score"]
                .as_f64()
                .ok_or_else(|| AppError::llm("重排序结果缺少relevance_score字段"))?
                as f32;

            if index < chunks.len() {
                let mut reranked_chunk = chunks[index].clone();
                reranked_chunk.score = relevance_score;
                reranked_chunks.push(reranked_chunk);
            }
        }

        // 记录 Reranker API 使用量
        // Reranker API 通常也有 usage 字段
        let usage = response_json
            .get("usage")
            .or_else(|| response_json.get("meta"));
        let measured_prompt_tokens = usage
            .and_then(|u| u.get("billed_units").and_then(|b| b.get("search_units")))
            .or_else(|| usage.and_then(|u| u.get("tokens")))
            .and_then(|v| v.as_u64());

        crate::llm_usage::record_llm_usage_ext(
            crate::llm_usage::CallerType::Reranker,
            &config.model,
            measured_prompt_tokens.unwrap_or(0) as u32,
            0, // Reranker 不产生 completion tokens
            None,
            None,
            None,
            None,
            true,
            None,
            // Cohere/Jina 风格 /rerank 端点（报表按协议拆分）
            Some("rerank".to_string()),
            // 真实 token 来源：API 实测才标 api，未上报的 0 不得伪装成 api
            Some(
                if measured_prompt_tokens.is_some() {
                    crate::chat_v2::types::TokenSource::Api
                } else {
                    crate::chat_v2::types::TokenSource::Heuristic
                }
                .to_string(),
            ),
        );

        info!(
            "重排序API调用成功，返回 {} 个重排序结果",
            reranked_chunks.len()
        );
        Ok(reranked_chunks)
    }

    /// 从model2响应中解析tags和mistake_type
    fn extract_tags_from_model2_response(&self, response: &str) -> Result<(Vec<String>, String)> {
        // 0. 尝试直接从原始响应中解析 JSON（去掉 ```json 围栏等），优先走无损路径
        if let Some((tags, mistake_type)) = self.try_parse_direct_json(response) {
            let json_value =
                serde_json::json!({"tags": tags.clone(), "mistake_type": mistake_type.clone()});
            if validate(ValidateStage::Recommendation, &json_value).is_ok() {
                return Ok((tags, mistake_type));
            }
        }
        // 1. 解析 ```json 代码块
        if let Some((tags, mistake_type)) = self.try_extract_json_block(response) {
            let json_value =
                serde_json::json!({"tags": tags.clone(), "mistake_type": mistake_type.clone()});
            if validate(ValidateStage::Recommendation, &json_value).is_ok() {
                return Ok((tags, mistake_type));
            }
        }
        // 2. 尝试查找 JSON 片段
        if let Some((tags, mistake_type)) = self.try_find_json_fragment(response) {
            let json_value =
                serde_json::json!({"tags": tags.clone(), "mistake_type": mistake_type.clone()});
            if validate(ValidateStage::Recommendation, &json_value).is_ok() {
                return Ok((tags, mistake_type));
            }
        }

        // 3. 若仍失败，返回错误（不再调用旧的五层强化解析器，防止错误降级）
        let error_message = format!(
            "所有JSON解析策略都失败。响应内容: {}",
            if response.chars().count() > 200 {
                format!("{}...", response.chars().take(200).collect::<String>())
            } else {
                response.to_string()
            }
        );
        error!("[FATAL] JSON解析失败 - {}", error_message);
        Err(AppError::llm(error_message))
    }

    /// 从记忆文本中提取标签（严格LLM，无启发式回退）
    pub async fn extract_tags_for_memory(&self, content: &str) -> Result<Vec<String>> {
        self.generate_tags_via_llm(content).await
    }

    /// 统一标签提取入口（严格LLM，无启发式回退）
    pub async fn extract_tags_from_text(&self, text: &str) -> Result<Vec<String>> {
        self.generate_tags_via_llm(text).await
    }

    /// 使用统一模型二严格生成标签（只允许JSON解析失败时报错，禁止任何启发式/硬编码回退）
    async fn generate_tags_via_llm(&self, text: &str) -> Result<Vec<String>> {
        if text.trim().is_empty() {
            return Err(AppError::validation("空文本无法提取标签".to_string()));
        }

        use crate::models::ChatMessage;
        use chrono::Utc;
        let context = std::collections::HashMap::new();

        // 🚀 优化：改进标签生成prompt，区分"无标签"（合法）和"解析失败"（错误）
        let instruction = format!(
            "你是标签抽取器。请从以下文本中抽取3-8个与知识图谱相关的标签。\n\
            \n\
            **输出格式（严格遵守）：**\n\
            \n\
            情况1 - 成功提取标签：\n\
            {{\n\
              \"tags\": [\"标签1\", \"标签2\", \"标签3\"]\n\
            }}\n\
            \n\
            情况2 - 文本过于简单或无法提取标签：\n\
            {{\n\
              \"tags\": [],\n\
              \"reason\": \"该文本为简单问候语/数字/符号，无学科知识标签\"\n\
            }}\n\
            \n\
            **要求：**\n\
            1. 必须返回有效JSON，不要添加解释、前缀、后缀或markdown代码块\n\
            2. 如果无法提取标签，必须在reason字段说明原因（如：文本太短、非学科内容等）\n\
            3. 标签应为简短术语（2-6个字），语言与输入一致\n\
            4. 优先提取学科知识点、概念、方法、题型等\n\
            5. 不要提取过于宽泛的标签（如\"化学\"、\"物理\"等科目名）\n\
            \n\
            **文本：**\n\
            {}\n\
            \n\
            请直接输出JSON：",
            text.trim()
        );

        let user_msg = ChatMessage {
            role: "user".to_string(),
            content: instruction,
            timestamp: Utc::now(),
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64: None,
            doc_attachments: None,
            multimodal_content: None,
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: None,
            persistent_stable_id: None,
            metadata: None,
        };

        let result = self
            .call_unified_model_2(
                &context,
                &[user_msg],
                "",
                false,
                None,
                Some("tag_generation"),
                None,
            )
            .await?;
        // R4 #3：非流式出口的 GLM 泄漏清理。call_unified_model_2 内部经
        // failover 可能换模型，调用点拿不到最终路由，无法按
        // for_provider_model 门控；本出口为机器解析的严格 JSON（下方
        // serde_json::from_str），泄漏的 <|begin_of_box|>{...}<|end_of_box|>
        // 包装会直接解析失败，而合法 JSON 不存在被误删的 token 形态
        // （行首独占 token 行 / 流首尾包装），故始终启用保守过滤。
        // 对无泄漏输出过滤为恒等。
        let cleaned = {
            let mut filter = crate::utils::model_special_tokens::ModelWrapTokenStreamFilter::new(
                crate::utils::model_special_tokens::ModelWrapTokenPolicy::GlmOrQwen,
            );
            let mut output = filter.process(&result.assistant_message);
            output.push_str(&filter.flush());
            output
        };
        let raw = cleaned.trim();

        // 🔍 调试：记录LLM原始返回
        debug!(
            "[标签生成] LLM原始返回（前500字符）: {}",
            if raw.chars().count() > 500 {
                format!(
                    "{}...(共{}字符)",
                    safe_truncate_chars(raw, 500),
                    raw.chars().count()
                )
            } else {
                raw.to_string()
            }
        );

        // 尝试解析严格的JSON
        let value: serde_json::Value = serde_json::from_str(raw)
            .or_else(|first_err| {
                // 兼容 ```json 块
                if let Some(cap) = regex::Regex::new(r"(?s)```json\s*(.*?)\s*```")
                    .ok()
                    .and_then(|re| re.captures(raw).and_then(|c| c.get(1)))
                {
                    let extracted = cap.as_str();
                    debug!("[标签生成] 尝试从代码块中提取JSON: {}", extracted);
                    serde_json::from_str(extracted)
                } else {
                    // 详细错误信息，包含原始返回内容
                    let preview = if raw.chars().count() > 200 {
                        format!("{}...", safe_truncate_chars(raw, 200))
                    } else {
                        raw.to_string()
                    };
                    error!(
                        "[标签生成] JSON解析失败 | 原始错误: {} | LLM返回预览: {}",
                        first_err, preview
                    );
                    Err(serde_json::Error::io(std::io::Error::other(format!(
                        "LLM返回内容不是有效JSON | 原始返回: {}",
                        preview
                    ))))
                }
            })
            .map_err(|e| {
                AppError::llm(format!(
                    "标签JSON解析失败: {} | LLM返回长度: {} | 预览: {}",
                    e,
                    raw.len(),
                    if raw.chars().count() > 100 {
                        format!("{}...", safe_truncate_chars(raw, 100))
                    } else {
                        raw.to_string()
                    }
                ))
            })?;

        // 🚀 优化：支持三种结构，并区分"无标签"（合法）和"格式错误"（非法）
        // 1. 直接数组: ["tag1", "tag2"]
        // 2. 有标签对象: {"tags": ["tag1", "tag2"]}
        // 3. 无标签但有理由: {"tags": [], "reason": "..."}
        let tags: Vec<String> = if let Some(arr) = value.as_array() {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        } else if let Some(obj) = value.as_object() {
            if let Some(arr) = obj.get("tags").and_then(|v| v.as_array()) {
                let tag_list: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();

                // 如果标签为空但有reason字段，这是合法的"无标签"情况
                if tag_list.is_empty() {
                    if let Some(reason) = obj.get("reason").and_then(|v| v.as_str()) {
                        debug!("[标签生成] LLM判断无有效标签 | 原因: {}", reason);
                    } else {
                        warn!("[标签生成] 返回空标签数组但未说明原因（建议LLM添加reason字段）");
                    }
                }
                tag_list
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        if tags.is_empty() {
            return Err(AppError::llm("模型未返回有效标签".to_string()));
        }

        // 去重与长度限制
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for t in tags.into_iter() {
            let norm = t.trim();
            if norm.is_empty() || norm.chars().count() > 24 {
                continue;
            }
            if seen.insert(norm.to_string()) {
                out.push(norm.to_string());
            }
        }
        if out.is_empty() {
            return Err(AppError::llm("标签集合为空".to_string()));
        }
        Ok(out)
    }

    /// 从原始响应中提取标签（同步版本）
    pub fn extract_tags_from_raw_response(&self, response: &str) -> Result<Vec<String>> {
        if response.trim().is_empty() {
            return Ok(Vec::new());
        }

        if let Some((tags, _)) = self.try_parse_direct_json(response) {
            return Ok(tags);
        }

        if let Some((tags, _)) = self.try_extract_json_block(response) {
            return Ok(tags);
        }

        if let Some((tags, _)) = self.try_find_json_fragment(response) {
            return Ok(tags);
        }

        Ok(Vec::new())
    }

    // 启发式方法已弃用：严格使用LLM进行标签生成

    /// 尝试直接解析整个响应为JSON
    fn try_parse_direct_json(&self, response: &str) -> Option<(Vec<String>, String)> {
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(response.trim()) {
            return self.extract_from_json_value(&json_value);
        }
        None
    }

    /// 尝试提取JSON代码块（```json ... ```）
    fn try_extract_json_block(&self, response: &str) -> Option<(Vec<String>, String)> {
        // 查找 ```json 或 ``` 包围的代码块
        // 关键修复：使用(?s)使.匹配换行符，处理多行JSON
        let patterns = [
            (r"(?s)```json\s*(.*?)\s*```", "json代码块"),
            (r"(?s)```\s*(.*?)\s*```", "普通代码块"),
        ];

        for (pattern, desc) in &patterns {
            if let Ok(re) = regex::Regex::new(pattern) {
                if let Some(captures) = re.captures(response) {
                    if let Some(json_content) = captures.get(1) {
                        let content = json_content.as_str().trim();
                        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(content) {
                            debug!("成功从{}解析JSON", desc);
                            if let Some(result) = self.extract_from_json_value(&json_value) {
                                return Some(result);
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// 尝试查找JSON片段（寻找{...}结构）
    fn try_find_json_fragment(&self, response: &str) -> Option<(Vec<String>, String)> {
        // 查找可能的JSON对象
        let mut brace_count: i32 = 0;
        let mut start_char_pos = None;
        let chars: Vec<char> = response.chars().collect();

        for (char_idx, &ch) in chars.iter().enumerate() {
            match ch {
                '{' => {
                    if brace_count == 0 {
                        start_char_pos = Some(char_idx);
                    }
                    brace_count += 1;
                }
                '}' if brace_count > 0 => {
                    brace_count -= 1;
                    if brace_count == 0 {
                        if let Some(start) = start_char_pos {
                            // 使用字符索引而不是字节索引来安全切片
                            let json_candidate: String = chars[start..=char_idx].iter().collect();
                            if let Ok(json_value) =
                                serde_json::from_str::<serde_json::Value>(&json_candidate)
                            {
                                debug!("成功从JSON片段解析");
                                if let Some(result) = self.extract_from_json_value(&json_value) {
                                    return Some(result);
                                }
                            }
                        }
                        start_char_pos = None;
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// 从JSON值中提取tags和mistake_type
    fn extract_from_json_value(
        &self,
        json_value: &serde_json::Value,
    ) -> Option<(Vec<String>, String)> {
        // 提取tags - 支持多种可能的字段名
        let tags = self.extract_tags_from_json(json_value);

        // 提取mistake_type - 支持多种可能的字段名
        let mistake_type = self.extract_mistake_type_from_json(json_value);

        // 至少要有一个有效值才返回结果
        if !tags.is_empty() || mistake_type != "计算题" {
            Some((tags, mistake_type))
        } else {
            None
        }
    }

    /// 从JSON中提取tags数组
    fn extract_tags_from_json(&self, json_value: &serde_json::Value) -> Vec<String> {
        // 尝试多种可能的字段名
        let tag_fields = ["tags", "labels", "keywords", "标签", "关键词"];

        for field in &tag_fields {
            if let Some(tags_value) = json_value.get(field) {
                if let Some(tags_array) = tags_value.as_array() {
                    let tags: Vec<String> = tags_array
                        .iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    if !tags.is_empty() {
                        return tags;
                    }
                }
            }
        }

        vec![]
    }
    /// 从JSON中提取mistake_type字符串
    fn extract_mistake_type_from_json(&self, json_value: &serde_json::Value) -> String {
        // 尝试多种可能的字段名
        let type_fields = [
            "mistake_type",
            "type",
            "题目类型",
            "question_type",
            "problem_type",
            "类型",
            "category",
            "分类",
        ];

        for field in &type_fields {
            if let Some(type_value) = json_value.get(field) {
                if let Some(type_str) = type_value.as_str() {
                    let type_str = type_str.trim();
                    if !type_str.is_empty() {
                        return type_str.to_string();
                    }
                }
            }
        }

        "计算题".to_string()
    }
}
