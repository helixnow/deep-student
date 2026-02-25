//! Stage 2: VLM Grounding Service — VLM 一体化页面分析
//!
//! Visual-First 管线的核心阶段：使用视觉语言模型对试卷页面图片进行一体化分析。
//!
//! 功能：
//! 1. 题目切分 — 识别页面中所有题目的边界
//! 2. OCR — 提取每道题目的完整文本（含选项、LaTeX 公式）
//! 3. 图文关联 — 检测配图/插图并语义关联到对应题目
//! 4. 跨页续接 — 标记跨页题目的续接关系
//!
//! 所有信息来自单次 VLM 调用，天然对齐，无需跨模型匹配。

use base64::Engine;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::{info, warn};

use crate::llm_manager::LLMManager;
use crate::models::AppError;
use crate::page_rasterizer::PageSlice;

// ============================================================================
// 数据类型
// ============================================================================

/// VLM 单页分析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlmPageAnalysis {
    pub questions: Vec<VlmQuestion>,
}

/// VLM 识别出的单道题目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlmQuestion {
    /// 题号标签（"1", "2", "5-8" 等）
    #[serde(default)]
    pub label: String,
    /// 题目区域归一化边界框 [x1, y1, x2, y2]，值域 0.0-1.0
    #[serde(default = "default_bbox")]
    pub bbox: [f64; 4],
    /// VLM OCR 的完整题目文本（含选项、LaTeX 公式）
    #[serde(default)]
    pub raw_text: String,
    /// 是否为共享配图的题组
    #[serde(default)]
    pub is_group: bool,
    /// 题组子题号
    #[serde(default)]
    pub sub_questions: Vec<String>,
    /// 该题关联的所有图片/配图
    #[serde(default)]
    pub figures: Vec<VlmFigure>,
    /// 是否接续上一页未完成的题目
    #[serde(default)]
    pub continues_from_previous: bool,
    /// 是否在本页未完成、续接到下一页
    #[serde(default)]
    pub continues_to_next: bool,
}

/// VLM 识别出的图片/配图
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlmFigure {
    /// 图片区域归一化边界框 [x1, y1, x2, y2]，值域 0.0-1.0
    #[serde(default = "default_bbox")]
    pub bbox: [f64; 4],
    /// 图片标签 ("图1", "配图", "选项图" 等)
    #[serde(default)]
    pub fig_label: String,
}

fn default_bbox() -> [f64; 4] {
    [0.0, 0.0, 0.0, 0.0]
}

// ============================================================================
// DOCX 图文混合 VLM 直提类型
// ============================================================================

/// VLM 从图文混合 DOCX 直接提取的题目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlmExtractedQuestion {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub question_type: String,
    #[serde(default)]
    pub options: Vec<VlmExtractedOption>,
    #[serde(default)]
    pub answer: String,
    #[serde(default)]
    pub explanation: String,
    /// 关联的图片索引（对应输入图片数组的下标）
    #[serde(default)]
    pub image_indices: Vec<usize>,
    #[serde(default)]
    pub difficulty: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlmExtractedOption {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub content: String,
}

// ============================================================================
// Service
// ============================================================================

pub struct VlmGroundingService {
    llm_manager: Arc<LLMManager>,
}

impl VlmGroundingService {
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager }
    }

    /// 分析单个页面（通过 blob_hash 从 VFS 加载图片）
    ///
    /// 当前管线以串行方式逐页调用（保证 checkpoint 顺序一致性）。
    /// 未来如需并发，应在调用方使用 `Semaphore` 控制并发数，
    /// 并改造 checkpoint 逻辑以支持乱序完成。
    pub async fn analyze_page_by_blob(
        &self,
        vfs_db: &crate::vfs::database::VfsDatabase,
        page: &PageSlice,
    ) -> Result<VlmPageAnalysis, AppError> {
        let image_bytes = crate::page_rasterizer::load_page_image_bytes(vfs_db, &page.blob_hash)?;
        let (mime, _) = detect_image_format(&image_bytes);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
        let data_url = format!("data:{};base64,{}", mime, b64);

        self.analyze_single_page(&data_url, page.text_hint.as_deref())
            .await
    }

    /// 分析单个页面图片
    ///
    /// `image_data_url` 为 `data:image/jpeg;base64,...` 格式。
    /// `text_hint` 为可选的机器提取文本层（辅助 VLM 识别模糊内容）。
    pub async fn analyze_single_page(
        &self,
        image_data_url: &str,
        text_hint: Option<&str>,
    ) -> Result<VlmPageAnalysis, AppError> {
        let config = self.get_vlm_config().await?;
        let api_key = self.llm_manager.decrypt_api_key_if_needed(&config.api_key)?;

        let prompt = Self::build_analysis_prompt(text_hint);

        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": image_data_url, "detail": "high" } },
                { "type": "text", "text": prompt }
            ]
        })];

        let max_tokens = crate::llm_manager::effective_max_tokens(
            config.max_output_tokens,
            config.max_tokens_limit,
        )
        .max(4096)
        .min(16384);

        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "stream": false,
        });

        let provider: Box<dyn crate::providers::ProviderAdapter> =
            match config.model_adapter.as_str() {
                "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
                "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
                _ => Box::new(crate::providers::OpenAIAdapter),
            };

        let preq = provider
            .build_request(&config.base_url, &api_key, &config.model, &request_body)
            .map_err(|e| AppError::llm(format!("VLM 请求构建失败: {:?}", e)))?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .map_err(|e| AppError::internal(format!("创建 HTTP 客户端失败: {}", e)))?;

        const MAX_RETRIES: u32 = 3;
        let mut last_error = String::new();

        for attempt in 0..=MAX_RETRIES {
            if attempt > 0 {
                let delay = std::time::Duration::from_secs(2u64.pow(attempt));
                warn!(
                    "[VLM-Grounding] 第 {} 次重试，等待 {}s",
                    attempt,
                    delay.as_secs()
                );
                tokio::time::sleep(delay).await;
            }

            let mut rb = client.post(&preq.url);
            for (k, v) in preq.headers.iter() {
                rb = rb.header(k.as_str(), v.as_str());
            }

            if attempt == 0 {
                info!(
                    "[VLM-Grounding] 发送分析请求: model={}, url={}",
                    config.model, preq.url
                );
            }

            let response = match rb.json(&preq.body).send().await {
                Ok(r) => r,
                Err(e) => {
                    last_error = format!("VLM 请求失败: {}", e);
                    if attempt < MAX_RETRIES {
                        continue;
                    }
                    return Err(AppError::network(last_error));
                }
            };

            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|e| AppError::network(format!("读取 VLM 响应失败: {}", e)))?;

            if matches!(status.as_u16(), 429 | 502 | 503 | 504) {
                last_error = format!(
                    "VLM API 返回 {}: {}",
                    status,
                    &body[..body.len().min(200)]
                );
                if attempt < MAX_RETRIES {
                    warn!("[VLM-Grounding] {}", last_error);
                    continue;
                }
                return Err(AppError::llm(last_error));
            }

            if !status.is_success() {
                return Err(AppError::llm(format!(
                    "VLM API 返回错误 {}: {}",
                    status,
                    &body[..body.len().min(500)]
                )));
            }

            let resp_json: Value = serde_json::from_str(&body)
                .map_err(|e| AppError::llm(format!("解析 VLM 响应 JSON 失败: {}", e)))?;

            let content = resp_json
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .ok_or_else(|| AppError::llm("VLM 响应格式错误：无法提取 content"))?;

            info!(
                "[VLM-Grounding] 收到响应: {} 字符{}",
                content.len(),
                if attempt > 0 {
                    format!(" (第 {} 次重试成功)", attempt)
                } else {
                    String::new()
                }
            );

            return Self::parse_vlm_response(content);
        }

        Err(AppError::llm(last_error))
    }

    /// 描述单张图片内容（轻量 VLM 调用）
    ///
    /// 用于 DOCX 原生导入：对文档中嵌入的配图/示意图/图表进行文字描述，
    /// 描述会嵌入到题目文本中供 LLM 结构化时理解图片含义。
    pub async fn describe_image(&self, image_bytes: &[u8]) -> Result<String, AppError> {
        let (mime, _) = detect_image_format(image_bytes);
        let b64 = base64::engine::general_purpose::STANDARD.encode(image_bytes);
        let data_url = format!("data:{};base64,{}", mime, b64);

        let config = self.get_vlm_config().await?;
        let api_key = self.llm_manager.decrypt_api_key_if_needed(&config.api_key)?;

        let prompt = r#"请详细描述这张图片的内容。这是一份试题/学习材料中的配图。

要求：
1. 如果是数学/物理/化学等图形，精确描述图中的坐标、标注、数值、方程
2. 如果是表格，用文字或 Markdown 表格转录完整内容
3. 如果是示意图/流程图，描述各部分的关系和标注
4. 如果包含文字，完整转录（数学公式用 LaTeX 格式）
5. 只输出描述，不要其他多余内容"#;

        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url, "detail": "high" } },
                { "type": "text", "text": prompt }
            ]
        })];

        let max_tokens = crate::llm_manager::effective_max_tokens(
            config.max_output_tokens,
            config.max_tokens_limit,
        )
        .max(2048)
        .min(4096);

        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "stream": false,
        });

        let provider: Box<dyn crate::providers::ProviderAdapter> =
            match config.model_adapter.as_str() {
                "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
                "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
                _ => Box::new(crate::providers::OpenAIAdapter),
            };

        let preq = provider
            .build_request(&config.base_url, &api_key, &config.model, &request_body)
            .map_err(|e| AppError::llm(format!("VLM 图片描述请求构建失败: {:?}", e)))?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| AppError::internal(format!("创建 HTTP 客户端失败: {}", e)))?;

        let mut rb = client.post(&preq.url);
        for (k, v) in preq.headers.iter() {
            rb = rb.header(k.as_str(), v.as_str());
        }

        let response = rb
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("VLM 图片描述请求失败: {}", e)))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| AppError::network(format!("读取 VLM 响应失败: {}", e)))?;

        if !status.is_success() {
            return Err(AppError::llm(format!(
                "VLM 图片描述 API 返回 {}: {}",
                status,
                &body[..body.len().min(300)]
            )));
        }

        let resp_json: Value = serde_json::from_str(&body)
            .map_err(|e| AppError::llm(format!("解析 VLM 响应 JSON 失败: {}", e)))?;

        let content = resp_json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("");

        Ok(content.trim().to_string())
    }

    /// 从 DOCX 图文混合文档中直接提取题目（流式回调）
    ///
    /// 将所有嵌入图片 + 提取的文本一起发送给 VLM，
    /// VLM 直接看到真实图片并自行判断图片与题目的对应关系。
    /// 完全绕过 text+marker 方案，消除图片-题目错配问题。
    ///
    /// `on_question` 每解析完一道题就回调一次，支持实时显示和逐题保存。
    /// 返回最终解析的总题目数。
    pub async fn extract_docx_questions_stream(
        &self,
        image_data_urls: &[String],
        extracted_text: &str,
        mut on_question: impl FnMut(VlmExtractedQuestion) -> bool,
    ) -> Result<usize, AppError> {
        if image_data_urls.is_empty() {
            return Err(AppError::validation("图片列表为空"));
        }

        let config = self.get_vlm_config().await?;
        let api_key = self.llm_manager.decrypt_api_key_if_needed(&config.api_key)?;

        // 构建多图 + 文本的 content 数组
        let mut content_parts: Vec<Value> = Vec::with_capacity(image_data_urls.len() + 1);

        for (idx, url) in image_data_urls.iter().enumerate() {
            // 在每张图片前加文本标注，帮助 VLM 建立索引
            content_parts.push(json!({
                "type": "text",
                "text": format!("【图片{}】", idx)
            }));
            content_parts.push(json!({
                "type": "image_url",
                "image_url": { "url": url, "detail": "high" }
            }));
        }

        // 构建提取指令
        let prompt = Self::build_docx_extraction_prompt(image_data_urls.len(), extracted_text);
        content_parts.push(json!({
            "type": "text",
            "text": prompt
        }));

        let messages = vec![json!({
            "role": "user",
            "content": content_parts
        })];

        let max_tokens = crate::llm_manager::effective_max_tokens(
            config.max_output_tokens,
            config.max_tokens_limit,
        )
        .max(8192)
        .min(32768);

        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "stream": true,
        });

        let provider: Box<dyn crate::providers::ProviderAdapter> =
            match config.model_adapter.as_str() {
                "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
                "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
                _ => Box::new(crate::providers::OpenAIAdapter),
            };

        let preq = provider
            .build_request(&config.base_url, &api_key, &config.model, &request_body)
            .map_err(|e| AppError::llm(format!("VLM DOCX 提取请求构建失败: {:?}", e)))?;

        // 流式请求不设全局 timeout，改用 connect timeout + 读 chunk 超时
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| AppError::internal(format!("创建 HTTP 客户端失败: {}", e)))?;

        info!(
            "[VLM-Grounding] DOCX 图文提取 (streaming): {} 张图片, model={}, url={}",
            image_data_urls.len(),
            config.model,
            preq.url
        );

        const MAX_RETRIES: u32 = 2;
        let mut last_error = String::new();

        for attempt in 0..=MAX_RETRIES {
            if attempt > 0 {
                let delay = std::time::Duration::from_secs(3u64.pow(attempt));
                warn!(
                    "[VLM-Grounding] DOCX 提取第 {} 次重试，等待 {}s",
                    attempt,
                    delay.as_secs()
                );
                tokio::time::sleep(delay).await;
            }

            let mut rb = client.post(&preq.url);
            for (k, v) in preq.headers.iter() {
                rb = rb.header(k.as_str(), v.as_str());
            }

            let response = match rb.json(&preq.body).send().await {
                Ok(r) => r,
                Err(e) => {
                    last_error = format!("VLM DOCX 提取请求失败: {}", e);
                    if attempt < MAX_RETRIES {
                        continue;
                    }
                    return Err(AppError::network(last_error));
                }
            };

            let status = response.status();

            // 非流式错误响应（4xx/5xx 可重试）
            if matches!(status.as_u16(), 429 | 502 | 503 | 504) {
                let body = response.text().await.unwrap_or_default();
                last_error = format!(
                    "VLM API 返回 {}: {}",
                    status,
                    &body[..body.len().min(200)]
                );
                if attempt < MAX_RETRIES {
                    warn!("[VLM-Grounding] {}", last_error);
                    continue;
                }
                return Err(AppError::llm(last_error));
            }

            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                return Err(AppError::llm(format!(
                    "VLM DOCX 提取 API 返回错误 {}: {}",
                    status,
                    &body[..body.len().min(500)]
                )));
            }

            // ===== SSE 流式读取 + 增量 JSON 解析 =====
            use futures_util::StreamExt;
            let mut stream = response.bytes_stream();
            let mut sse_buffer = crate::utils::sse_buffer::SseLineBuffer::new();
            let mut json_parser =
                crate::llm_manager::IncrementalJsonArrayParser::new();
            let mut full_content = String::new();
            let mut stream_ended = false;
            let mut chunk_count: usize = 0;
            let mut question_count: usize = 0;
            let mut aborted = false;

            while let Some(chunk_result) = stream.next().await {
                if aborted {
                    break;
                }
                match chunk_result {
                    Ok(chunk) => {
                        let chunk_str = String::from_utf8_lossy(&chunk);
                        let complete_lines = sse_buffer.process_chunk(&chunk_str);

                        for line in complete_lines {
                            if crate::utils::sse_buffer::SseLineBuffer::check_done_marker(&line) {
                                stream_ended = true;
                                break;
                            }
                            let events = provider.parse_stream(&line);
                            for event in events {
                                match event {
                                    crate::providers::StreamEvent::ContentChunk(content) => {
                                        full_content.push_str(&content);
                                        chunk_count += 1;

                                        // 增量解析：每个 SSE token 喂给 JSON 解析器
                                        if let Some(objects) = json_parser.feed(&content) {
                                            for obj in objects {
                                                if let Ok(vq) = serde_json::from_value::<VlmExtractedQuestion>(obj) {
                                                    question_count += 1;
                                                    if !on_question(vq) {
                                                        aborted = true;
                                                        break;
                                                    }
                                                }
                                            }
                                        }

                                        if chunk_count % 50 == 0 {
                                            info!(
                                                "[VLM-Grounding] DOCX 流式进度: {} chunks, {} 字符, {} 题",
                                                chunk_count,
                                                full_content.len(),
                                                question_count
                                            );
                                        }
                                    }
                                    crate::providers::StreamEvent::Done => {
                                        stream_ended = true;
                                        break;
                                    }
                                    _ => {}
                                }
                                if aborted {
                                    break;
                                }
                            }
                            if stream_ended || aborted {
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        if !full_content.is_empty() {
                            warn!(
                                "[VLM-Grounding] 流式读取错误但已有 {} 字符/{} 题，继续处理: {}",
                                full_content.len(),
                                question_count,
                                e
                            );
                            break;
                        }
                        last_error = format!("VLM 流式读取失败: {}", e);
                        if attempt < MAX_RETRIES {
                            warn!("[VLM-Grounding] {}", last_error);
                            break;
                        }
                        return Err(AppError::network(last_error));
                    }
                }
                if stream_ended {
                    break;
                }
            }

            // 处理 SSE 缓冲器和 JSON 解析器中的剩余数据
            if let Some(remaining) = sse_buffer.flush() {
                if !remaining.trim().is_empty() {
                    let events = provider.parse_stream(&remaining);
                    for event in events {
                        if let crate::providers::StreamEvent::ContentChunk(content) = event {
                            if let Some(objects) = json_parser.feed(&content) {
                                for obj in objects {
                                    if let Ok(vq) = serde_json::from_value::<VlmExtractedQuestion>(obj) {
                                        question_count += 1;
                                        let _ = on_question(vq);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // finalize: 处理 JSON 解析器缓冲区中可能的不完整对象
            if let Some(objects) = json_parser.finalize() {
                for obj in objects {
                    if let Ok(vq) = serde_json::from_value::<VlmExtractedQuestion>(obj) {
                        question_count += 1;
                        let _ = on_question(vq);
                    }
                }
            }

            if question_count == 0 && full_content.is_empty() {
                last_error = "VLM 流式响应为空".to_string();
                if attempt < MAX_RETRIES {
                    continue;
                }
                return Err(AppError::llm(last_error));
            }

            // 如果增量解析没拿到任何题目，回退到完整解析
            if question_count == 0 && !full_content.is_empty() {
                warn!(
                    "[VLM-Grounding] 增量解析未提取到题目，回退完整解析 ({} 字符)",
                    full_content.len()
                );
                match Self::parse_docx_extraction_response(&full_content) {
                    Ok(questions) => {
                        for vq in questions {
                            question_count += 1;
                            if !on_question(vq) {
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        return Err(e);
                    }
                }
            }

            info!(
                "[VLM-Grounding] DOCX 提取流式完成: {} chunks, {} 字符, {} 道题目",
                chunk_count,
                full_content.len(),
                question_count
            );

            return Ok(question_count);
        }

        Err(AppError::llm(last_error))
    }

    /// 构建 DOCX 图文提取的 VLM prompt
    fn build_docx_extraction_prompt(image_count: usize, extracted_text: &str) -> String {
        // 截断文本到合理长度（留足上下文给图片 token），按字符截断防止 UTF-8 断裂
        let max_text_chars = 8000;
        let text_section = if extracted_text.chars().count() > max_text_chars {
            let truncated: String = extracted_text.chars().take(max_text_chars).collect();
            format!("{}...(截断)", truncated)
        } else {
            extracted_text.to_string()
        };

        format!(
            r#"你是一个试题提取专家。上面是从一份 DOCX 文档中提取的 {count} 张嵌入图片（编号为图片0到图片{last}）。

**文档提取的文本内容**（仅供参考，图片内容请直接看图）：
---
{text}
---

**你的任务**：
1. 结合图片和文本，识别文档中的**所有题目**
2. 准确判断每张图片属于哪道题目（通过图片内容和文本上下文判断）
3. 提取每道题的完整结构化信息

**输出 JSON 数组**，每个元素代表一道题目（只输出 JSON，不要其他内容）：

```json
[
  {{
    "content": "题干文本（不含选项；表格用 Markdown 格式；公式用 LaTeX：$...$）",
    "question_type": "single_choice",
    "options": [{{"key": "A", "content": "选项内容"}}, ...],
    "answer": "A",
    "explanation": "解析（如果文档中有）",
    "image_indices": [0],
    "difficulty": "medium",
    "tags": ["力学"]
  }}
]
```

**字段说明**：
- `question_type`: single_choice / multiple_choice / fill_blank / short_answer / calculation / proof / essay
- `options`: 仅选择题需要，其他题型留空数组 `[]`
- `image_indices`: 属于该题的图片编号数组（对应上方【图片N】），无图则 `[]`
- `difficulty`: easy / medium / hard（无法判断则留 "medium"）

**重要规则**：
1. 所有数学/化学/物理公式必须用 LaTeX 格式
2. 每张图片最多归属一道题目（装饰性图片如水印/页眉不需要归属）
3. 如果图片本身就是题目内容（整道题是图片），在 content 中用文字描述图片内容
4. 如果多道题共享一张图片（题组），将图片归属到题组的第一道题
5. 题目按文档中出现的顺序排列
6. 只输出 JSON 数组，不要输出任何其他内容
7. **选择题的 content 只包含题干**，不要把选项文本（A/B/C/D 的内容）写进 content，选项放到 options 数组中
8. 如果题干包含表格，请使用标准 Markdown 表格格式（必须有表头分隔行 `|---|---|`），例如：
   | 列1 | 列2 |
   |---|---|
   | 数据1 | 数据2 |"#,
            count = image_count,
            last = image_count.saturating_sub(1),
            text = text_section,
        )
    }

    /// 解析 DOCX 图文提取的 VLM 响应
    fn parse_docx_extraction_response(
        content: &str,
    ) -> Result<Vec<VlmExtractedQuestion>, AppError> {
        let stripped = {
            let trimmed = content.trim();
            if let Some(rest) = trimmed.strip_prefix("```json") {
                rest.trim_start()
                    .strip_suffix("```")
                    .unwrap_or(rest)
                    .trim()
            } else if let Some(rest) = trimmed.strip_prefix("```") {
                rest.trim_start()
                    .strip_suffix("```")
                    .unwrap_or(rest)
                    .trim()
            } else {
                trimmed
            }
        };

        // 提取 JSON 数组
        let json_str = if let Some(start) = stripped.find('[') {
            if let Some(end) = stripped.rfind(']') {
                &stripped[start..=end]
            } else {
                stripped
            }
        } else {
            stripped
        };

        if let Ok(questions) = serde_json::from_str::<Vec<VlmExtractedQuestion>>(json_str) {
            info!(
                "[VLM-Grounding] DOCX 提取成功: {} 道题目",
                questions.len()
            );
            return Ok(questions);
        }

        // 尝试包裹对象格式 {"questions": [...]}
        if let Ok(obj) = serde_json::from_str::<Value>(json_str) {
            if let Some(qs) = obj.get("questions").and_then(|v| v.as_array()) {
                if let Ok(questions) =
                    serde_json::from_value::<Vec<VlmExtractedQuestion>>(Value::Array(qs.clone()))
                {
                    info!(
                        "[VLM-Grounding] DOCX 提取成功 (wrapped): {} 道题目",
                        questions.len()
                    );
                    return Ok(questions);
                }
            }
        }

        warn!(
            "[VLM-Grounding] 无法解析 DOCX 提取响应: {}",
            &json_str[..json_str.len().min(500)]
        );
        Err(AppError::llm("VLM 响应无法解析为题目列表"))
    }

    /// 检测是否有可用的 VLM 模型
    pub async fn is_available(llm_manager: &Arc<LLMManager>) -> bool {
        let configs = match llm_manager.get_api_configs().await {
            Ok(c) => c,
            Err(_) => return false,
        };
        configs.iter().any(|c| c.enabled && c.is_multimodal)
    }

    /// 从 VLM 响应文本中提取结构化分析结果
    fn parse_vlm_response(content: &str) -> Result<VlmPageAnalysis, AppError> {
        let stripped = {
            let trimmed = content.trim();
            if let Some(rest) = trimmed.strip_prefix("```json") {
                rest.trim_start()
                    .strip_suffix("```")
                    .unwrap_or(rest)
                    .trim()
            } else if let Some(rest) = trimmed.strip_prefix("```") {
                rest.trim_start()
                    .strip_suffix("```")
                    .unwrap_or(rest)
                    .trim()
            } else {
                trimmed
            }
        };

        let json_str = if let Some(start) = stripped.find('[') {
            if let Some(end) = stripped.rfind(']') {
                &stripped[start..=end]
            } else {
                stripped
            }
        } else if let Some(start) = stripped.find('{') {
            if let Some(end) = stripped.rfind('}') {
                &stripped[start..=end]
            } else {
                stripped
            }
        } else {
            stripped
        };

        if let Ok(analysis) = serde_json::from_str::<VlmPageAnalysis>(json_str) {
            return Ok(analysis);
        }

        if let Ok(questions) = serde_json::from_str::<Vec<VlmQuestion>>(json_str) {
            return Ok(VlmPageAnalysis { questions });
        }

        if let Ok(obj) = serde_json::from_str::<Value>(json_str) {
            if let Some(qs) = obj.get("questions").and_then(|v| v.as_array()) {
                if let Ok(questions) =
                    serde_json::from_value::<Vec<VlmQuestion>>(Value::Array(qs.clone()))
                {
                    return Ok(VlmPageAnalysis { questions });
                }
            }
        }

        warn!(
            "[VLM-Grounding] 无法解析 VLM 响应为结构化数据，原始内容: {}",
            &json_str[..json_str.len().min(500)]
        );
        Err(AppError::llm("VLM 响应无法解析为题目分析结果"))
    }

    /// 构建 VLM 分析 prompt
    ///
    /// 当 `text_hint` 可用时，在 prompt 中附加文本层作为参考，
    /// 提高小字体 / 模糊公式的识别准确率。
    fn build_analysis_prompt(text_hint: Option<&str>) -> String {
        // text_hint 截断到 1500 字符（约 750 token），
        // 确保 prompt（~800 tok） + hint（~750 tok） + image（~2000 tok）< 4096，
        // 留出足够的输出空间（>= 8000 tok）给结构化 JSON。
        let hint_section = match text_hint {
            Some(hint) if !hint.is_empty() => {
                let max_hint_chars = 1500;
                let truncated = if hint.chars().count() > max_hint_chars {
                    let t: String = hint.chars().take(max_hint_chars).collect();
                    format!("{}...(截断)", t)
                } else {
                    hint.to_string()
                };
                format!(
                    r#"

**机器提取的文本参考**（可能有误，仅供辅助识别模糊内容，以图片为准）：
---
{}
---
"#,
                    truncated
                )
            }
            _ => String::new(),
        };

        format!(
            r#"请分析这张试卷/题目页面图片，识别其中的所有题目和配图。{}
**任务**：
1. 识别页面中每道题目的完整内容（题号、题干、选项、答案、解析）
2. 识别页面中所有图片/配图/插图，并确定它们属于哪道题目
3. 给出每道题目和每张图片在页面中的位置坐标
4. 如果页面开头有未完成的题目（接续上一页），标记 continues_from_previous
5. 如果页面末尾有未完成的题目（续接下一页），标记 continues_to_next

**输出要求**：
请输出 JSON 数组，每个元素代表一道题目（只输出 JSON，不要其他内容）：

```json
[
  {{
    "label": "1",
    "bbox": [0.05, 0.02, 0.95, 0.17],
    "raw_text": "1. 下列关于力的说法正确的是（  ）\nA. 力是物体...\nB. 力可以...\nC. ...\nD. ...",
    "is_group": false,
    "sub_questions": [],
    "figures": [
      {{
        "bbox": [0.60, 0.03, 0.92, 0.15],
        "fig_label": "配图"
      }}
    ],
    "continues_from_previous": false,
    "continues_to_next": false
  }}
]
```

**字段说明**：
- `label`: 题号（如 "1", "2", "5-8"）
- `bbox`: 题目区域坐标 [x1, y1, x2, y2]，左上角到右下角，归一化到 0-1
- `raw_text`: 题目的完整文本（含题号、题干、选项等），数学公式用 LaTeX 格式
- `is_group`: 是否为题组（多道题共享一段材料或配图时为 true）
- `sub_questions`: 题组时的子题号列表
- `figures`: 该题关联的配图列表
  - `bbox`: 图片区域坐标 [x1, y1, x2, y2]，归一化到 0-1
  - `fig_label`: 图片标签（"图1", "配图", "选项图"等）
- `continues_from_previous`: 此题是否接续上一页（页面开头的不完整题目）
- `continues_to_next`: 此题是否在下一页继续（页面末尾的不完整题目）

**重要规则**：
1. 所有数学公式必须用 LaTeX 格式：行内 $E=mc^2$，独立 $$\int_0^1 f(x)dx$$
2. 每道题的 raw_text 必须包含完整内容（题干+选项+答案+解析，如果页面上有的话）
3. 如果多道题共享一张配图（如阅读理解），将它们标记为 is_group=true
4. bbox 坐标格式为 [x1, y1, x2, y2]：(x1,y1) 是左上角，(x2,y2) 是右下角，值域 0-1
5. 如果题目没有配图，figures 留空数组
6. 注意区分题目配图和装饰性元素（页眉页脚、水印等不需要标记）
7. 如果页面开头的内容明显是上一页题目的延续（如选项 C/D 开头、答案解析开头），标记 continues_from_previous=true
8. 如果页面末尾的题目明显未结束（题干不完整、选项缺失），标记 continues_to_next=true"#,
            hint_section
        )
    }

    /// 获取 VLM 模型配置
    ///
    /// 优先级（从高到低）：
    /// 1. GLM-4.6V+ / GLM-5.xV（大尺寸 VLM，非 Thinking 变体）
    /// 2. GLM-4.5V（非 Thinking 变体）
    /// 3. Qwen3-VL
    /// 4. Qwen2.5-VL
    /// 5. 其他 Qwen-VL
    /// 6. GLM-4.xV 兜底（包含 Thinking/小参数等）
    /// 7. 任意多模态模型
    pub(crate) async fn get_vlm_config(
        &self,
    ) -> Result<crate::llm_manager::ApiConfig, AppError> {
        let configs = self
            .llm_manager
            .get_api_configs()
            .await
            .map_err(|e| AppError::configuration(format!("获取模型配置失败: {}", e)))?;

        // ===== Tier 0: 从 OCR 引擎配置中查找 GLM-4.6V =====
        // OCR 引擎（ocr.available_models）和普通模型列表是两套独立存储，
        // 一键分配会把 GLM-4.6V 加到 OCR 引擎但不一定在普通模型列表中。
        let ocr_models = self.llm_manager.get_available_ocr_models().await;
        // 按 priority 排序，优先使用主引擎
        let mut ocr_glm: Vec<&crate::llm_manager::OcrModelConfig> = ocr_models
            .iter()
            .filter(|m| m.enabled && m.engine_type == "glm4v_ocr")
            .collect();
        ocr_glm.sort_by_key(|m| m.priority);

        // 黑名单：GLM-4.1V / GLM-4.0V / GLM-4V- 质量差，即使在 OCR 引擎中也跳过
        let is_blacklisted = |model: &str| {
            let lower = model.to_lowercase();
            lower.contains("glm-4.1v")
                || lower.contains("glm-4.0v")
                || lower.contains("glm-4v-")
        };

        for ocr_cfg in &ocr_glm {
            if let Some(config) = configs.iter().find(|c| c.id == ocr_cfg.config_id && c.enabled) {
                if is_blacklisted(&config.model) {
                    info!(
                        "[VLM-Grounding] 跳过黑名单 OCR 引擎模型: {} ({})",
                        config.model, config.name
                    );
                    continue;
                }
                info!(
                    "[VLM-Grounding] 使用 OCR 引擎中的 VLM 模型 (Tier0-GLM): {} ({})",
                    config.model, config.name
                );
                return Ok(config.clone());
            }
        }

        // 也检查 OCR 引擎中的 Qwen-VL / GenericVlm（按 priority 排序）
        let mut ocr_vlm: Vec<&crate::llm_manager::OcrModelConfig> = ocr_models
            .iter()
            .filter(|m| {
                m.enabled
                    && matches!(
                        m.engine_type.as_str(),
                        "generic_vlm" | "paddle_ocr_vl" | "paddle_ocr_vl_v1"
                    )
            })
            .collect();
        ocr_vlm.sort_by_key(|m| m.priority);

        // ===== Tier 1-5: 从普通模型列表中按名称匹配 =====

        // GLM-4.6V+ 或 GLM-5.xV（排除 thinking 小模型）
        let glm_top_tier =
            regex::Regex::new(r"(?i)glm-(?:4\.[6-9]|4\.\d{2,}|5(?:\.\d+)?)v").unwrap();
        // GLM-4.5V（非 thinking）
        let glm_4_5 = regex::Regex::new(r"(?i)glm-4\.5v").unwrap();
        let is_thinking = |m: &str| m.contains("thinking");

        let vlm_model_priorities: Vec<Box<dyn Fn(&str) -> bool>> = vec![
            // Tier 1: GLM-4.6V+ / GLM-5.xV（非 thinking）
            Box::new(move |m: &str| glm_top_tier.is_match(m) && !is_thinking(m)),
            // Tier 2: GLM-4.5V（非 thinking）
            Box::new(move |m: &str| glm_4_5.is_match(m) && !is_thinking(m)),
            // Tier 3: Qwen3-VL
            Box::new(|m: &str| m.contains("qwen3-vl")),
            // Tier 4: Qwen2.5-VL
            Box::new(|m: &str| m.contains("qwen2.5-vl")),
            // Tier 5: 其他 Qwen-VL
            Box::new(|m: &str| m.contains("qwen-vl")),
        ];

        for matcher in &vlm_model_priorities {
            if let Some(config) = configs
                .iter()
                .find(|c| c.enabled && c.is_multimodal && matcher(&c.model.to_lowercase()))
            {
                info!(
                    "[VLM-Grounding] 使用 VLM 模型: {} ({})",
                    config.model, config.name
                );
                return Ok(config.clone());
            }
        }

        // ===== Tier 6: OCR 引擎中的通用 VLM 模型 =====
        for ocr_cfg in &ocr_vlm {
            if let Some(config) = configs.iter().find(|c| c.id == ocr_cfg.config_id && c.enabled) {
                if is_blacklisted(&config.model) {
                    info!(
                        "[VLM-Grounding] 跳过黑名单 OCR 通用 VLM: {} ({})",
                        config.model, config.name
                    );
                    continue;
                }
                info!(
                    "[VLM-Grounding] 使用 OCR 引擎中的通用 VLM: {} ({})",
                    config.model, config.name
                );
                return Ok(config.clone());
            }
        }

        // ===== Tier 7: 任意多模态模型（排除黑名单） =====
        if let Some(config) = configs.iter().find(|c| c.enabled && c.is_multimodal && !is_blacklisted(&c.model)) {
            info!(
                "[VLM-Grounding] 回退使用多模态模型: {} ({})",
                config.model, config.name
            );
            return Ok(config.clone());
        }

        Err(AppError::configuration(
            "未找到可用的 VLM 模型（需要 GLM-4.6V / Qwen-VL 等多模态模型），请在设置中配置",
        ))
    }

    /// 按归一化坐标从页面图片中裁切配图区域
    pub fn crop_figure_from_page(
        page_image_bytes: &[u8],
        figure_bbox: &[f64; 4],
    ) -> Result<Vec<u8>, AppError> {
        let img = image::load_from_memory(page_image_bytes)
            .map_err(|e| AppError::internal(format!("加载页面图片失败: {}", e)))?;

        let (img_w, img_h) = img.dimensions();

        let x1 = figure_bbox[0].min(figure_bbox[2]).clamp(0.0, 1.0);
        let y1 = figure_bbox[1].min(figure_bbox[3]).clamp(0.0, 1.0);
        let x2 = figure_bbox[0].max(figure_bbox[2]).clamp(0.0, 1.0);
        let y2 = figure_bbox[1].max(figure_bbox[3]).clamp(0.0, 1.0);

        let px = (x1 * img_w as f64).round() as u32;
        let py = (y1 * img_h as f64).round() as u32;
        let pw = ((x2 - x1) * img_w as f64).round().max(1.0) as u32;
        let ph = ((y2 - y1) * img_h as f64).round().max(1.0) as u32;

        let px = px.min(img_w.saturating_sub(1));
        let py = py.min(img_h.saturating_sub(1));
        let pw = pw.min(img_w - px);
        let ph = ph.min(img_h - py);

        if pw == 0 || ph == 0 {
            return Err(AppError::validation("裁切区域无效：宽度或高度为 0"));
        }

        let cropped = image::imageops::crop_imm(&img, px, py, pw, ph).to_image();

        let mut buffer = std::io::Cursor::new(Vec::new());
        cropped
            .write_to(&mut buffer, image::ImageOutputFormat::Png)
            .map_err(|e| AppError::internal(format!("编码裁切图片失败: {}", e)))?;

        Ok(buffer.into_inner())
    }
}

fn detect_image_format(data: &[u8]) -> (&'static str, &'static str) {
    if data.starts_with(b"\x89PNG") {
        ("image/png", "png")
    } else if data.starts_with(b"\xFF\xD8\xFF") {
        ("image/jpeg", "jpg")
    } else if data.starts_with(b"RIFF") && data.len() > 12 && &data[8..12] == b"WEBP" {
        ("image/webp", "webp")
    } else {
        ("image/png", "png")
    }
}
