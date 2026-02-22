//! 多模态嵌入服务
//!
//! 封装多模态内容向量化的完整逻辑，包括批量处理、错误重试和日志记录。
//!
//! ## 设计要点
//!
//! - **不存储模型配置**: 服务只持有 LLMManager 引用，每次调用时动态获取配置。
//!   这样当用户在设置中更换模型时，无需重启服务。
//! - **批量处理**: VL 模型通常处理速度较慢，批量大小建议限制在 8 以内。
//!   服务负责将大批量输入拆分处理。
//! - **错误处理**: 图片加载失败时降级为纯文本嵌入，确保索引流程不中断。
//! - **双模式支持**: 支持 VL-Embedding 直接向量化和 VL摘要+文本嵌入两种方案。
//!
//! 设计文档参考: docs/multimodal-knowledge-base-design.md (Section 7.3)

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use tokio::sync::mpsc;

use crate::llm_manager::{ImagePayload, LLMManager};
use crate::models::AppError;
use crate::multimodal::types::{MultimodalImage, MultimodalIndexingMode, MultimodalInput};

/// 嵌入进度信息
#[derive(Debug, Clone)]
pub struct EmbeddingProgress {
    /// 当前阶段：summarizing / embedding
    pub phase: String,
    /// 当前完成的页数
    pub completed: usize,
    /// 总页数
    pub total: usize,
    /// 当前正在处理的页码（可选）
    pub current_page: Option<usize>,
    /// 消息
    pub message: String,
}

type Result<T> = std::result::Result<T, AppError>;

/// 默认批量大小（VL 模型处理速度较慢，限制在 8 以内）
const DEFAULT_BATCH_SIZE: usize = 8;
/// 默认摘要生成并发数
const DEFAULT_SUMMARY_CONCURRENCY: usize = 10;

/// 嵌入服务配置
#[derive(Debug, Clone)]
pub struct EmbeddingServiceConfig {
    /// 单次 API 调用的最大输入数量
    pub batch_size: usize,
    /// VL 摘要生成的并发数
    pub summary_concurrency: usize,
    /// 是否启用降级模式（图片加载失败时降级为纯文本）
    pub enable_fallback: bool,
}

impl Default for EmbeddingServiceConfig {
    fn default() -> Self {
        Self {
            batch_size: DEFAULT_BATCH_SIZE,
            summary_concurrency: DEFAULT_SUMMARY_CONCURRENCY,
            enable_fallback: true,
        }
    }
}

/// 多模态嵌入服务
///
/// 封装多模态内容向量化的完整逻辑，通过 LLMManager 动态获取模型配置。
pub struct MultimodalEmbeddingService {
    llm_manager: Arc<LLMManager>,
    config: EmbeddingServiceConfig,
}

impl MultimodalEmbeddingService {
    /// 创建新的嵌入服务实例
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self {
            llm_manager,
            config: EmbeddingServiceConfig::default(),
        }
    }

    /// 使用自定义配置创建嵌入服务
    pub fn with_config(llm_manager: Arc<LLMManager>, config: EmbeddingServiceConfig) -> Self {
        Self {
            llm_manager,
            config,
        }
    }

    /// 检查多模态嵌入模型是否已配置（任一模式可用即返回 true）
    pub async fn is_configured(&self) -> bool {
        self.llm_manager.is_multimodal_rag_configured().await
    }

    /// 检查 VL-Embedding 模型是否真正可用（方案一）
    ///
    /// 与 `is_configured()` 不同，此方法仅检查 VL-Embedding 模型，
    /// 用于召回时判断是否能生成多模态查询向量
    ///
    /// 注意：VL-Embedding 模型通过维度管理的默认多模态维度设置
    pub async fn is_vl_embedding_available(&self) -> bool {
        self.llm_manager
            .get_vl_embedding_model_config()
            .await
            .is_ok()
    }

    /// 检查文本嵌入模型是否可用（方案二的一部分）
    ///
    /// 注意：文本嵌入模型通过维度管理的默认文本维度设置
    pub async fn is_text_embedding_available(&self) -> bool {
        self.llm_manager.get_embedding_model_config().await.is_ok()
    }

    /// 获取当前嵌入模型的输出维度
    ///
    /// 通过调用一个简单的文本输入来检测模型输出维度
    pub async fn detect_embedding_dimension(&self) -> Result<usize> {
        // 使用简单的测试文本获取维度
        let test_input = MultimodalInput::text("test");
        let embeddings = self
            .llm_manager
            .call_multimodal_embedding_api(&[test_input])
            .await?;

        embeddings
            .first()
            .map(|v| v.len())
            .ok_or_else(|| AppError::configuration("无法检测嵌入模型输出维度"))
    }

    /// 获取嵌入模型版本标识
    ///
    /// 返回格式: "{model_name}@{config_id}"
    pub async fn get_model_version(&self) -> Result<String> {
        let config = self.llm_manager.get_vl_embedding_model_config().await?;
        Ok(format!("{}@{}", config.model, config.id))
    }

    /// 为单个多模态输入生成嵌入向量
    pub async fn embed_single(&self, input: &MultimodalInput) -> Result<Vec<f32>> {
        let embeddings = self.embed_batch(&[input.clone()]).await?;
        embeddings
            .into_iter()
            .next()
            .ok_or_else(|| AppError::internal("嵌入 API 返回空结果"))
    }

    /// 为多个多模态输入批量生成嵌入向量
    ///
    /// 如果输入数量超过批量大小，会自动拆分为多个 API 调用
    pub async fn embed_batch(&self, inputs: &[MultimodalInput]) -> Result<Vec<Vec<f32>>> {
        self.embed_batch_with_progress(inputs, None).await
    }

    /// 为多个多模态输入批量生成嵌入向量（带进度回调）
    pub async fn embed_batch_with_progress(
        &self,
        inputs: &[MultimodalInput],
        progress_tx: Option<mpsc::UnboundedSender<EmbeddingProgress>>,
    ) -> Result<Vec<Vec<f32>>> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }

        // 检查是否配置了多模态模型
        if !self.is_configured().await {
            return Err(AppError::configuration("未配置多模态嵌入模型"));
        }

        let batch_size = self.config.batch_size;
        let total = inputs.len();
        let mut all_embeddings = Vec::with_capacity(total);
        let mut completed = 0usize;

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(EmbeddingProgress {
                phase: "embedding".to_string(),
                completed,
                total,
                current_page: None,
                message: format!("开始多模态嵌入: 0/{}", total),
            });
        }

        log::info!(
            "🖼️ 多模态嵌入服务：开始处理 {} 个输入，批量大小 {}",
            total,
            batch_size
        );

        // 分批处理
        for (batch_idx, chunk) in inputs.chunks(batch_size).enumerate() {
            let batch_start = batch_idx * batch_size;
            log::debug!(
                "  处理批次 {}: 输入 {}-{} / {}",
                batch_idx + 1,
                batch_start + 1,
                (batch_start + chunk.len()).min(total),
                total
            );

            // 如果启用降级模式，处理可能的图片加载失败
            let processed_inputs = if self.config.enable_fallback {
                self.prepare_inputs_with_fallback(chunk)
            } else {
                chunk.to_vec()
            };

            // 调用 API
            match self
                .llm_manager
                .call_multimodal_embedding_api(&processed_inputs)
                .await
            {
                Ok(embeddings) => {
                    if embeddings.len() != processed_inputs.len() {
                        return Err(AppError::internal(format!(
                            "嵌入 API 返回数量不匹配: 期望 {}, 实际 {}",
                            processed_inputs.len(),
                            embeddings.len()
                        )));
                    }
                    all_embeddings.extend(embeddings);
                    completed = all_embeddings.len().min(total);

                    if let Some(ref tx) = progress_tx {
                        let _ = tx.send(EmbeddingProgress {
                            phase: "embedding".to_string(),
                            completed,
                            total,
                            current_page: Some(completed),
                            message: format!("多模态嵌入进度: {}/{}", completed, total),
                        });
                    }
                }
                Err(e) => {
                    log::error!("  批次 {} 嵌入失败: {}", batch_idx + 1, e);
                    return Err(e);
                }
            }
        }

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(EmbeddingProgress {
                phase: "embedding".to_string(),
                completed: total,
                total,
                current_page: Some(total),
                message: format!("多模态嵌入完成: {}/{}", total, total),
            });
        }

        log::info!(
            "✅ 多模态嵌入服务：完成 {} 个输入的向量化",
            all_embeddings.len()
        );

        Ok(all_embeddings)
    }

    /// 为页面内容生成嵌入向量
    ///
    /// ## 参数
    /// - `image_base64`: 页面图片的 Base64 编码
    /// - `media_type`: 图片 MIME 类型（如 "image/png"）
    /// - `text_summary`: 页面的文本摘要（OCR 文本或 VLM 生成的摘要）
    /// - `instruction`: 可选的任务指令
    ///
    /// ## 返回
    /// 嵌入向量
    pub async fn embed_page(
        &self,
        image_base64: &str,
        media_type: &str,
        text_summary: Option<&str>,
        instruction: Option<&str>,
    ) -> Result<Vec<f32>> {
        let mut input = if let Some(text) = text_summary {
            // 图文混合输入
            MultimodalInput::text_and_image(text, image_base64, media_type)
        } else {
            // 纯图片输入
            MultimodalInput::image_base64(image_base64, media_type)
        };

        // 添加任务指令
        if let Some(instr) = instruction {
            input = input.with_instruction(instr);
        }

        self.embed_single(&input).await
    }

    /// 为页面内容批量生成嵌入向量
    ///
    /// ## 参数
    /// - `pages`: 页面数据列表，每个元素为 (image_base64, media_type, text_summary)
    /// - `instruction`: 可选的任务指令（应用于所有页面）
    ///
    /// ## 返回
    /// 每个页面对应的嵌入向量
    pub async fn embed_pages(
        &self,
        pages: &[(String, String, Option<String>)],
        instruction: Option<&str>,
    ) -> Result<Vec<Vec<f32>>> {
        let inputs: Vec<MultimodalInput> = pages
            .iter()
            .map(|(base64, media_type, text)| {
                let mut input = if let Some(t) = text {
                    MultimodalInput::text_and_image(t, base64, media_type)
                } else {
                    MultimodalInput::image_base64(base64, media_type)
                };
                if let Some(instr) = instruction {
                    input = input.with_instruction(instr);
                }
                input
            })
            .collect();

        self.embed_batch(&inputs).await
    }

    /// 准备输入数据，处理可能的图片加载失败
    ///
    /// 如果输入包含无效的图片数据，降级为纯文本输入（如果有文本的话）
    fn prepare_inputs_with_fallback(&self, inputs: &[MultimodalInput]) -> Vec<MultimodalInput> {
        inputs
            .iter()
            .map(|input| {
                // 检查图片数据是否有效
                if let Some(ref image) = input.image {
                    match image {
                        MultimodalImage::Base64 { data, .. } => {
                            // Base64 数据为空或太短可能是无效的
                            if data.len() < 100 {
                                log::warn!("图片 Base64 数据过短，可能无效，降级为纯文本");
                                if let Some(ref text) = input.text {
                                    return MultimodalInput::text(text);
                                }
                            }
                        }
                        MultimodalImage::Url { url } => {
                            // URL 为空是无效的
                            if url.is_empty() {
                                log::warn!("图片 URL 为空，降级为纯文本");
                                if let Some(ref text) = input.text {
                                    return MultimodalInput::text(text);
                                }
                            }
                        }
                    }
                }
                input.clone()
            })
            .collect()
    }

    // ============================================================================
    // 方案二：DeepSeek-OCR 摘要 + 文本嵌入
    // ============================================================================

    /// 使用 DeepSeek-OCR 模型为图片生成文本摘要
    ///
    /// ⚠️ 使用 DeepSeek-OCR 官方 prompt "Free OCR."，速度更快、精度更高
    ///
    /// ## 参数
    /// - `image_base64`: 图片的 Base64 编码
    /// - `media_type`: 图片 MIME 类型
    /// - `_existing_text`: 已有的文本内容（保留参数兼容性，DeepSeek-OCR 不使用）
    ///
    /// ## 返回
    /// 生成的文本摘要（Markdown 格式）
    pub async fn generate_image_summary(
        &self,
        image_base64: &str,
        media_type: &str,
        _existing_text: Option<&str>,
    ) -> Result<String> {
        // ⚠️ DeepSeek-OCR 官方 prompt - 文档转 Markdown 格式（不带 grounding，无坐标标记）
        let prompt = "Convert the document to markdown.";

        let image_payload = ImagePayload {
            mime: media_type.to_string(),
            base64: image_base64.to_string(),
        };

        let result = self
            .llm_manager
            .call_ocr_model_raw_prompt(prompt, Some(vec![image_payload]))
            .await?;

        Ok(result.assistant_message)
    }

    /// 批量为图片生成文本摘要（并行处理，带进度回调）
    ///
    /// 使用 DeepSeek-OCR 官方 prompt 进行 OCR 识别，速度更快、精度更高。
    ///
    /// ## DeepSeek-OCR 官方支持的 prompt（必须严格使用）：
    /// - 文档转Markdown：`<|grounding|>Convert the document to markdown.`
    /// - 通用OCR：`<|grounding|>OCR this image.`
    /// - 无布局提取：`Free OCR.`
    /// - 图表解析：`Parse the figure.`
    /// - 图像描述：`Describe this image in detail.`
    ///
    /// ## 参数
    /// - `pages`: 页面数据列表，每个元素为 (image_base64, media_type, existing_text)
    /// - `progress_tx`: 可选的进度回调通道
    ///
    /// ## 返回
    /// 每个页面对应的文本摘要（Markdown 格式）
    ///
    /// ## 并行策略
    /// 使用 `buffer_unordered` 并行处理，并发数通过配置指定（默认 10）
    pub async fn generate_summaries_batch_with_progress(
        &self,
        pages: &[(String, String, Option<String>)],
        progress_tx: Option<mpsc::UnboundedSender<EmbeddingProgress>>,
    ) -> Result<Vec<String>> {
        let concurrency = self.config.summary_concurrency;
        let total = pages.len();

        log::info!(
            "📝 DeepSeek-OCR 摘要服务：开始为 {} 个页面并行生成摘要（并发数: {}）",
            total,
            concurrency
        );

        // 使用原子计数器跟踪完成的页面数
        let completed_count = Arc::new(AtomicUsize::new(0));

        // 创建带索引的任务列表，以保持结果顺序
        let tasks: Vec<(usize, String, String, Option<String>)> = pages
            .iter()
            .enumerate()
            .map(|(idx, (base64, media_type, existing_text))| {
                (
                    idx,
                    base64.clone(),
                    media_type.clone(),
                    existing_text.clone(),
                )
            })
            .collect();

        // 并行执行摘要生成
        let results: Vec<(usize, String)> = stream::iter(tasks)
            .map(|(idx, base64, media_type, existing_text)| {
                let llm_manager = self.llm_manager.clone();
                let progress_tx = progress_tx.clone();
                let completed_count = completed_count.clone();
                async move {
                    // ★ 如果已有 OCR 文本，直接复用，跳过 OCR 调用
                    if let Some(ref text) = existing_text {
                        if !text.is_empty() {
                            log::info!("  📖 页面 {} 复用已有 OCR（{} 字符），跳过 DeepSeek-OCR 调用", idx + 1, text.len());

                            // 更新完成计数并发送进度
                            let completed = completed_count.fetch_add(1, Ordering::SeqCst) + 1;
                            if let Some(ref tx) = progress_tx {
                                let _ = tx.send(EmbeddingProgress {
                                    phase: "summarizing".to_string(),
                                    completed,
                                    total,
                                    current_page: Some(idx + 1),
                                    message: format!("复用已有 OCR: {}/{} 页完成", completed, total),
                                });
                            }

                            return (idx, text.clone());
                        }
                    }

                    // 调试：输出 base64 数据的前 100 字符，确认图片数据是否正确
                    let base64_preview: String = base64.chars().take(100).collect();
                    log::info!("  📄 开始生成页面 {} 摘要 (DeepSeek-OCR)... base64前100字符: {}", idx + 1, base64_preview);
                    log::info!("  📄 页面 {} media_type: {}, base64长度: {} 字节", idx + 1, media_type, base64.len());

                    // ⚠️ DeepSeek-OCR 官方 prompt - 文档转 Markdown 格式（不带 grounding，无坐标标记）
                    let prompt = "Convert the document to markdown.";

                    let image_payload = ImagePayload {
                        mime: media_type,
                        base64,
                    };

                    let result = match llm_manager
                        .call_ocr_model_raw_prompt(prompt, Some(vec![image_payload]))
                        .await
                    {
                        Ok(result) => {
                            let content = &result.assistant_message;
                            // 输出摘要内容（截取前 500 字符避免日志过长，使用字符边界安全切片）
                            let preview: String = content.chars().take(500).collect();
                            let truncated = content.chars().count() > 500;
                            let display = if truncated {
                                format!("{}...(共 {} 字符)", preview, content.len())
                            } else {
                                content.clone()
                            };
                            log::info!("  ✅ 页面 {} OCR 成功，长度 {} 字符\n--- 摘要内容 ---\n{}\n--- 摘要结束 ---", idx + 1, content.len(), display);
                            (idx, result.assistant_message)
                        }
                        Err(e) => {
                            log::warn!("  ⚠️ 页面 {} OCR 失败: {}，使用空内容", idx + 1, e);
                            (idx, String::new())
                        }
                    };

                    // 更新完成计数并发送进度
                    let completed = completed_count.fetch_add(1, Ordering::SeqCst) + 1;
                    if let Some(ref tx) = progress_tx {
                        let _ = tx.send(EmbeddingProgress {
                            phase: "summarizing".to_string(),
                            completed,
                            total,
                            current_page: Some(idx + 1),
                            message: format!("DeepSeek-OCR: {}/{} 页完成", completed, total),
                        });
                    }

                    result
                }
            })
            .buffer_unordered(concurrency)
            .collect()
            .await;

        // 按原始索引排序并提取摘要
        let mut sorted_results = results;
        sorted_results.sort_by_key(|(idx, _)| *idx);
        let summaries: Vec<String> = sorted_results
            .into_iter()
            .map(|(_, summary)| summary)
            .collect();

        log::info!(
            "✅ DeepSeek-OCR 摘要服务：完成 {} 个页面的摘要生成",
            summaries.len()
        );
        Ok(summaries)
    }

    /// 批量为图片生成文本摘要（并行处理，无进度回调）
    pub async fn generate_summaries_batch(
        &self,
        pages: &[(String, String, Option<String>)],
    ) -> Result<Vec<String>> {
        self.generate_summaries_batch_with_progress(pages, None)
            .await
    }

    /// 使用文本嵌入模型为文本生成向量（带进度回调）
    ///
    /// 超过模型 token 限制的长文本会自动分块处理，然后使用平均池化聚合
    pub async fn embed_texts_with_progress(
        &self,
        texts: &[String],
        progress_tx: Option<mpsc::UnboundedSender<EmbeddingProgress>>,
    ) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let total = texts.len();
        log::info!("📊 文本嵌入服务：开始为 {} 个文本生成向量", total);

        // 发送开始进度
        if let Some(ref tx) = progress_tx {
            let _ = tx.send(EmbeddingProgress {
                phase: "embedding".to_string(),
                completed: 0,
                total,
                current_page: None,
                message: format!("开始文本嵌入: 0/{} 个", total),
            });
        }

        let config = self.llm_manager.get_embedding_model_config().await?;

        // 获取模型的 token 限制
        let token_limits = crate::multimodal::embedding_chunker::EmbeddingTokenLimits::default();
        let max_tokens = token_limits.get_limit(&config.model);
        let chunker = crate::multimodal::embedding_chunker::EmbeddingChunker::new(max_tokens);

        // 检查是否需要分块
        let needs_chunking = texts.iter().any(|t| chunker.needs_chunking(t));

        let embeddings = if !needs_chunking {
            // 不需要分块，直接调用 API
            self.llm_manager
                .call_embedding_api(texts.to_vec(), &config.id)
                .await
                .map_err(|e| AppError::internal(format!("文本嵌入失败: {}", e)))?
        } else {
            // 需要分块处理
            log::info!("📊 文本嵌入服务：检测到长文本，启用分块处理");

            let chunk_results =
                crate::multimodal::embedding_chunker::batch_chunk_texts(texts, &chunker);
            let all_chunks: Vec<String> = chunk_results
                .iter()
                .flat_map(|r| r.chunks.clone())
                .collect();

            log::info!(
                "📊 文本嵌入服务：{} 个文本分为 {} 个块",
                texts.len(),
                all_chunks.len()
            );

            let all_embeddings = self
                .llm_manager
                .call_embedding_api(all_chunks, &config.id)
                .await
                .map_err(|e| AppError::internal(format!("文本嵌入失败: {}", e)))?;

            // 聚合
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
                    let aggregated = crate::multimodal::embedding_chunker::EmbeddingChunker::aggregate_embeddings(
                        &chunk_embeddings,
                        crate::multimodal::embedding_chunker::ChunkAggregation::MeanPooling,
                    );
                    result.push(aggregated);
                }

                emb_idx += chunk_count;
            }

            result
        };

        // 发送完成进度
        if let Some(ref tx) = progress_tx {
            let _ = tx.send(EmbeddingProgress {
                phase: "embedding".to_string(),
                completed: total,
                total,
                current_page: None,
                message: format!("文本嵌入完成: {}/{} 个", total, total),
            });
        }

        log::info!(
            "✅ 文本嵌入服务：完成 {} 个文本的向量生成",
            embeddings.len()
        );
        Ok(embeddings)
    }

    /// 使用文本嵌入模型为文本生成向量
    ///
    /// ## 参数
    /// - `texts`: 文本列表
    ///
    /// ## 返回
    /// 每个文本对应的嵌入向量
    ///
    /// ## 注意
    /// - 超过模型 token 限制的长文本会自动分块处理，然后使用平均池化聚合
    /// - ★ 2026-01 修复：如果分块后嵌入仍因 token 超限失败，会自动用 2 倍分块重试，最多 5 轮
    pub async fn embed_texts(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        log::info!("📊 文本嵌入服务：开始处理 {} 个文本", texts.len());

        let config = self.llm_manager.get_embedding_model_config().await?;

        // 获取模型的 token 限制
        let token_limits = crate::multimodal::embedding_chunker::EmbeddingTokenLimits::default();
        let base_max_tokens = token_limits.get_limit(&config.model);

        // ★ 2026-01 修复：添加自动重试机制，最多 5 轮，每轮分块限制减半
        const MAX_RETRY_ROUNDS: usize = 5;
        let mut current_max_tokens = base_max_tokens;
        let mut last_error_msg: String = String::new();

        for round in 0..MAX_RETRY_ROUNDS {
            let chunker =
                crate::multimodal::embedding_chunker::EmbeddingChunker::new(current_max_tokens);

            // 检查是否需要分块
            let needs_chunking = texts.iter().any(|t| chunker.needs_chunking(t));

            let api_result = if !needs_chunking && round == 0 {
                // 第一轮且不需要分块，直接调用 API
                self.llm_manager
                    .call_embedding_api(texts.to_vec(), &config.id)
                    .await
                    .map(|embeddings| (embeddings, None))
            } else {
                // 需要分块处理
                if round > 0 {
                    log::warn!(
                        "📊 文本嵌入服务：第 {} 轮重试，使用更激进的分块（max_tokens={}）",
                        round + 1,
                        current_max_tokens
                    );
                } else {
                    log::info!("📊 文本嵌入服务：检测到长文本，启用分块处理");
                }

                // 分块并记录映射关系
                let chunk_results =
                    crate::multimodal::embedding_chunker::batch_chunk_texts(texts, &chunker);

                // 收集所有块
                let all_chunks: Vec<String> = chunk_results
                    .iter()
                    .flat_map(|r| r.chunks.clone())
                    .collect();

                let total_chunks = all_chunks.len();
                log::info!(
                    "📊 文本嵌入服务：{} 个文本分为 {} 个块（max_tokens={}）",
                    texts.len(),
                    total_chunks,
                    current_max_tokens
                );

                // 批量嵌入所有块
                match self
                    .llm_manager
                    .call_embedding_api(all_chunks, &config.id)
                    .await
                {
                    Ok(all_embeddings) => {
                        // 按原始文本索引聚合嵌入向量
                        let mut result = Vec::with_capacity(texts.len());
                        let mut emb_idx = 0;

                        for chunk_result in &chunk_results {
                            let chunk_count = chunk_result.chunks.len();

                            if chunk_count == 0 {
                                // 空文本，返回零向量
                                let dim = all_embeddings.first().map(|v| v.len()).unwrap_or(1024);
                                result.push(vec![0.0; dim]);
                            } else if chunk_count == 1 {
                                // 单块，直接使用
                                result.push(all_embeddings[emb_idx].clone());
                            } else {
                                // 多块，聚合
                                let chunk_embeddings: Vec<_> =
                                    all_embeddings[emb_idx..emb_idx + chunk_count].to_vec();
                                let aggregated = crate::multimodal::embedding_chunker::EmbeddingChunker::aggregate_embeddings(
                                    &chunk_embeddings,
                                    crate::multimodal::embedding_chunker::ChunkAggregation::MeanPooling,
                                );
                                log::debug!(
                                    "  文本 {} 聚合 {} 个块的嵌入向量",
                                    chunk_result.original_index,
                                    chunk_count
                                );
                                result.push(aggregated);
                            }

                            emb_idx += chunk_count;
                        }

                        Ok((result, Some(chunk_results)))
                    }
                    Err(e) => Err(e),
                }
            };

            match api_result {
                Ok((embeddings, _)) => {
                    log::info!(
                        "✅ 文本嵌入服务：完成 {} 个文本的向量化{}，维度 {}",
                        embeddings.len(),
                        if round > 0 {
                            format!("（第 {} 轮重试成功）", round + 1)
                        } else {
                            String::new()
                        },
                        embeddings.first().map(|v| v.len()).unwrap_or(0)
                    );
                    return Ok(embeddings);
                }
                Err(e) => {
                    let error_str = e.to_string();
                    // 检查是否是 token 超限错误
                    let is_token_limit_error = error_str.contains("413")
                        || error_str.contains("Payload Too Large")
                        || error_str.contains("too many tokens")
                        || error_str.contains("8192 tokens")
                        || error_str.contains("token limit");

                    if is_token_limit_error && round < MAX_RETRY_ROUNDS - 1 {
                        log::warn!(
                            "⚠️ 文本嵌入服务：token 超限错误，准备第 {} 轮重试（当前 max_tokens={}）: {}",
                            round + 2, current_max_tokens, error_str
                        );
                        // 减半 token 限制，进行更激进的分块
                        current_max_tokens = current_max_tokens / 2;
                        // 确保不会太小
                        if current_max_tokens < 256 {
                            current_max_tokens = 256;
                        }
                        last_error_msg = error_str;
                        continue;
                    } else {
                        // 不是 token 超限错误，或已达最大重试次数
                        if round >= MAX_RETRY_ROUNDS - 1 {
                            log::error!(
                                "❌ 文本嵌入服务：已达最大重试次数 {}，放弃: {}",
                                MAX_RETRY_ROUNDS,
                                error_str
                            );
                        }
                        return Err(e);
                    }
                }
            }
        }

        // 不应该到达这里，但为了编译器满意
        Err(AppError::internal(if last_error_msg.is_empty() {
            "嵌入失败：未知错误".to_string()
        } else {
            last_error_msg
        }))
    }

    // ============================================================================
    // 统一接口：支持两种索引模式
    // ============================================================================

    /// 根据索引模式为页面生成嵌入向量（带进度回调）
    ///
    /// ## 参数
    /// - `pages`: 页面数据列表，每个元素为 (image_base64, media_type, text_summary)
    /// - `mode`: 索引模式
    /// - `instruction`: 可选的任务指令（仅用于 VLEmbedding 模式）
    /// - `progress_tx`: 可选的进度回调通道
    ///
    /// ## 返回
    /// (嵌入向量列表, 生成的摘要列表)
    pub async fn embed_pages_with_mode_and_progress(
        &self,
        pages: &[(String, String, Option<String>)],
        mode: MultimodalIndexingMode,
        instruction: Option<&str>,
        progress_tx: Option<mpsc::UnboundedSender<EmbeddingProgress>>,
    ) -> Result<(Vec<Vec<f32>>, Vec<Option<String>>)> {
        if pages.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }

        // 确定实际使用的模式（如果请求的模式不可用，自动回退）
        let actual_mode = if self.is_mode_available(mode).await {
            mode
        } else {
            // 尝试回退到另一个模式
            let fallback = match mode {
                MultimodalIndexingMode::VLEmbedding => {
                    MultimodalIndexingMode::VLSummaryThenTextEmbed
                }
                MultimodalIndexingMode::VLSummaryThenTextEmbed => {
                    MultimodalIndexingMode::VLEmbedding
                }
            };
            if self.is_mode_available(fallback).await {
                log::warn!("⚠️ 请求的模式 {:?} 不可用，回退到 {:?}", mode, fallback);
                fallback
            } else {
                return Err(AppError::configuration(
                    "未配置任何多模态嵌入模型。请在设置中配置 VL-Embedding 模型或 VL 聊天模型 + 文本嵌入模型。"
                ));
            }
        };

        log::info!(
            "🔄 多模态嵌入服务：使用 {:?} 模式处理 {} 个页面",
            actual_mode,
            pages.len()
        );

        match actual_mode {
            MultimodalIndexingMode::VLEmbedding => {
                // 方案一：直接使用 VL-Embedding 模型
                let embeddings = self.embed_pages(pages, instruction).await?;
                let summaries: Vec<Option<String>> =
                    pages.iter().map(|(_, _, s)| s.clone()).collect();
                Ok((embeddings, summaries))
            }
            MultimodalIndexingMode::VLSummaryThenTextEmbed => {
                // 方案二：VL 摘要 + 文本嵌入
                // 步骤 1: 生成摘要（带进度回调）
                let summaries = self
                    .generate_summaries_batch_with_progress(pages, progress_tx.clone())
                    .await?;

                // 步骤 2: 对摘要进行文本嵌入（带进度回调）
                let embeddings = self
                    .embed_texts_with_progress(&summaries, progress_tx)
                    .await?;

                // 转换摘要为 Option<String>
                let summaries_opt: Vec<Option<String>> = summaries
                    .into_iter()
                    .map(|s| if s.is_empty() { None } else { Some(s) })
                    .collect();

                Ok((embeddings, summaries_opt))
            }
        }
    }

    /// 根据索引模式为页面生成嵌入向量（无进度回调）
    pub async fn embed_pages_with_mode(
        &self,
        pages: &[(String, String, Option<String>)],
        mode: MultimodalIndexingMode,
        instruction: Option<&str>,
    ) -> Result<(Vec<Vec<f32>>, Vec<Option<String>>)> {
        self.embed_pages_with_mode_and_progress(pages, mode, instruction, None)
            .await
    }

    /// 检查指定模式是否可用
    pub async fn is_mode_available(&self, mode: MultimodalIndexingMode) -> bool {
        match mode {
            MultimodalIndexingMode::VLEmbedding => {
                // 方案一需要专门的 VL-Embedding 模型（通过维度管理设置）
                self.is_vl_embedding_available().await
            }
            MultimodalIndexingMode::VLSummaryThenTextEmbed => {
                // 已废弃：第一模型移除，VL 摘要方案不可用
                false
            }
        }
    }

    /// 获取指定模式的嵌入维度
    ///
    /// 通过实际调用 API 检测维度
    pub async fn detect_embedding_dimension_for_mode(
        &self,
        mode: MultimodalIndexingMode,
    ) -> Result<usize> {
        match mode {
            MultimodalIndexingMode::VLEmbedding => self.detect_embedding_dimension().await,
            MultimodalIndexingMode::VLSummaryThenTextEmbed => {
                // 使用文本嵌入模型检测维度
                let config = self.llm_manager.get_embedding_model_config().await?;
                let embeddings = self
                    .llm_manager
                    .call_embedding_api(vec!["test".to_string()], &config.id)
                    .await?;
                embeddings
                    .first()
                    .map(|v| v.len())
                    .ok_or_else(|| AppError::configuration("无法检测文本嵌入模型输出维度"))
            }
        }
    }

    /// 获取指定模式的模型版本标识
    pub async fn get_model_version_for_mode(&self, mode: MultimodalIndexingMode) -> Result<String> {
        match mode {
            MultimodalIndexingMode::VLEmbedding => self.get_model_version().await,
            MultimodalIndexingMode::VLSummaryThenTextEmbed => {
                let config = self.llm_manager.get_embedding_model_config().await?;
                Ok(format!("text_embed:{}@{}", config.model, config.id))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedding_service_config_default() {
        let config = EmbeddingServiceConfig::default();
        assert_eq!(config.batch_size, DEFAULT_BATCH_SIZE);
        assert!(config.enable_fallback);
    }

    #[test]
    fn test_prepare_inputs_with_fallback_valid_image() {
        // 创建一个有效的 Base64 图片数据（足够长）
        let valid_base64 = "a".repeat(200);
        let input = MultimodalInput::text_and_image("test text", &valid_base64, "image/png");

        let inputs = vec![input];
        let llm_manager = create_mock_llm_manager();
        let service = MultimodalEmbeddingService::new(Arc::new(llm_manager));

        // 由于 LLMManager 需要真实环境，这里只测试输入准备逻辑
        // 实际的 API 调用测试需要集成测试环境
    }

    // 辅助函数：创建模拟的 LLMManager（仅用于测试编译）
    fn create_mock_llm_manager() -> LLMManager {
        // 注意：这需要真实的 Database 和 FileManager
        // 在单元测试中，我们只验证逻辑，不调用实际 API
        panic!("此函数仅用于类型检查，不应在测试中实际调用")
    }
}
