//! OCR 引擎
//!
//! DeepSeek OCR 适配、PDF OCR 支持

use crate::models::{AppError, AppErrorType, ExamCardBBox};
use crate::providers::ProviderAdapter;
use base64::{engine::general_purpose, Engine as _};
use image::imageops::FilterType;
use image::{GenericImageView, ImageOutputFormat};
use log::{debug, error, info, warn};
use serde_json::{json, Value};
use std::io::Cursor;
use std::path::Path;

use super::{
    ApiConfig, ExamSegmentationCard, LLMManager,
    Result, EXAM_SEGMENT_MAX_DIMENSION, EXAM_SEGMENT_MAX_IMAGE_BYTES,
};

// ── 渐进对冲 OCR 用数据结构 ──

/// 预构建的单引擎 OCR 请求（所有字段 owned，可 tokio::spawn）
struct PreparedOcrRequest {
    idx: usize,
    engine_name: String,
    model_name: String,
    model_adapter: String,
    url: String,
    headers: reqwest::header::HeaderMap,
    body: serde_json::Value,
}

/// 安全截取字符串（避免切断 UTF-8 字符边界）— 模块级别，供 spawn 任务使用
fn safe_truncate(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        s
    } else {
        s.char_indices()
            .take_while(|(idx, _)| *idx < max_bytes)
            .last()
            .map(|(idx, ch)| &s[..idx + ch.len_utf8()])
            .unwrap_or("")
    }
}

/// 执行单个 OCR 引擎请求（独立于 LLMManager，可 tokio::spawn）
async fn run_single_ocr_request(
    client: reqwest::Client,
    req: PreparedOcrRequest,
    timeout_secs: u64,
) -> std::result::Result<String, String> {
    let request_future = client
        .post(&req.url)
        .headers(req.headers)
        .json(&req.body)
        .send();

    // 硬超时
    let response = match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        request_future,
    )
    .await
    {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            return Err(format!(
                "Engine #{} ({}) network error: {}",
                req.idx, req.engine_name, e
            ))
        }
        Err(_) => {
            return Err(format!(
                "Engine #{} ({}) timed out ({}s)",
                req.idx, req.engine_name, timeout_secs
            ))
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!(
            "Engine #{} ({}) HTTP {}: {}",
            req.idx,
            req.engine_name,
            status,
            safe_truncate(&error_text, 200)
        ));
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Engine #{} ({}) read failed: {}", req.idx, req.engine_name, e))?;

    let response_json: Value = serde_json::from_str(&response_text)
        .map_err(|e| format!("Engine #{} ({}) JSON parse failed: {}", req.idx, req.engine_name, e))?;

    // Gemini / Anthropic 响应格式转换
    let openai_like = if req.model_adapter == "google" {
        crate::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai(
            &response_json,
            &req.model_name,
        )
        .map_err(|e| format!("Gemini conversion failed: {}", e))?
    } else if matches!(req.model_adapter.as_str(), "anthropic" | "claude") {
        crate::providers::convert_anthropic_response_to_openai(&response_json, &req.model_name)
            .ok_or_else(|| "Anthropic conversion failed".to_string())?
    } else {
        response_json
    };

    let content = openai_like["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok(content)
}

impl LLMManager {
    pub async fn get_pdf_ocr_model_config(&self) -> Result<ApiConfig> {
        let engine_type = self.get_ocr_engine_type().await;
        let config = self.get_ocr_model_config().await?;
        debug!(
            "[OCR] PDF OCR 使用引擎 {}，模型: id={}, model={}",
            engine_type.as_str(),
            config.id,
            config.model
        );
        Ok(config)
    }

    pub(crate) async fn get_exam_segmentation_model_config(&self) -> Result<ApiConfig> {
        self.get_pdf_ocr_model_config().await
    }

    // === Exam sheet segmentation helpers ===

    fn preview_response(text: &str) -> String {
        let trimmed = text.trim();
        if trimmed.len() <= 200 {
            trimmed.to_string()
        } else {
            let mut end = 200;
            while end > 0 && !trimmed.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}...", &trimmed[..end])
        }
    }

    pub(crate) async fn prepare_segmentation_image_data(
        &self,
        path: &str,
        default_mime: &str,
    ) -> Result<(String, usize)> {
        let abs_path = self.file_manager.resolve_image_path(path);
        let default_mime = default_mime.to_string();
        let result = tokio::task::spawn_blocking(move || -> Result<(String, usize)> {
            let data = std::fs::read(&abs_path)
                .map_err(|e| AppError::file_system(format!("读取试卷图片失败: {}", e)))?;

            if data.len() <= EXAM_SEGMENT_MAX_IMAGE_BYTES {
                let encoded = general_purpose::STANDARD.encode(&data);
                return Ok((
                    format!("data:{};base64,{}", default_mime, encoded),
                    data.len(),
                ));
            }

            let image = image::open(&abs_path)
                .map_err(|e| AppError::file_system(format!("加载试卷图片失败: {}", e)))?;
            let (width, height) = image.dimensions();
            let resized =
                if width <= EXAM_SEGMENT_MAX_DIMENSION && height <= EXAM_SEGMENT_MAX_DIMENSION {
                    image
                } else {
                    image.resize(
                        EXAM_SEGMENT_MAX_DIMENSION,
                        EXAM_SEGMENT_MAX_DIMENSION,
                        FilterType::Triangle,
                    )
                };

            let mut cursor = Cursor::new(Vec::new());
            resized
                .write_to(&mut cursor, ImageOutputFormat::Jpeg(85))
                .map_err(|e| AppError::file_system(format!("压缩试卷图片失败: {}", e)))?;
            let buffer = cursor.into_inner();
            let encoded = general_purpose::STANDARD.encode(&buffer);
            Ok((format!("data:image/jpeg;base64,{}", encoded), buffer.len()))
        })
        .await
        .map_err(|e| AppError::file_system(format!("处理试卷图片失败: {:?}", e)))??;

        Ok(result)
    }

    pub(crate) fn infer_image_mime(path: &str) -> &'static str {
        let ext = Path::new(path)
            .extension()
            .and_then(|v| v.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_else(|| "png".to_string());
        match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "gif" => "image/gif",
            _ => "image/png",
        }
    }

    /// 安全截取字符串（避免切断 UTF-8 字符边界）
    fn safe_truncate_str(s: &str, max_bytes: usize) -> &str {
        if s.len() <= max_bytes {
            s
        } else {
            s.char_indices()
                .take_while(|(idx, _)| *idx < max_bytes)
                .last()
                .map(|(idx, ch)| &s[..idx + ch.len_utf8()])
                .unwrap_or("")
        }
    }

    /// DeepSeek-OCR 调试日志发送（发送到前端调试面板）
    fn emit_deepseek_debug(
        &self,
        level: &str,
        stage: &str,
        page_index: usize,
        message: &str,
        data: Option<serde_json::Value>,
    ) {
        use tauri::Emitter;

        // 构造事件 payload
        let payload = serde_json::json!({
            "level": level,
            "stage": stage,
            "page_index": page_index,
            "message": message,
            "data": data,
        });

        // 同时输出到控制台（方便开发调试）
        let prefix = format!("[DeepSeek-OCR-Debug:{}:page-{}]", stage, page_index);
        debug!("{} [{}] {}", prefix, level.to_uppercase(), message);
        if let Some(d) = &data {
            if let Ok(json_str) = serde_json::to_string_pretty(d) {
                debug!("{}   data: {}", prefix, json_str);
            }
        }

        // 发送 Tauri 事件到前端
        if let Some(app_handle) = crate::get_global_app_handle() {
            if let Err(e) = app_handle.emit("deepseek_ocr_log", payload) {
                error!("[DeepSeek-OCR-Debug] 发送事件失败: {}", e);
            }
        }
    }

    /// 辅助函数：移除 HTML 标签，保留纯文本
    async fn request_deepseek_ocr_content(
        &self,
        config: &ApiConfig,
        page_path: &str,
        page_index: usize,
    ) -> Result<String> {
        // S7 fix: 根据实际模型推断引擎类型，而非仅从全局设置获取
        // 确保 adapter/prompt 与实际使用的模型匹配
        let effective_engine =
            crate::ocr_adapters::OcrAdapterFactory::infer_engine_from_model(&config.model);
        let adapter = crate::ocr_adapters::OcrAdapterFactory::create(effective_engine);
        let engine_name = adapter.display_name();

        self.emit_deepseek_debug(
            "info",
            "request",
            page_index,
            &format!("开始调用 {} API", engine_name),
            None,
        );

        let mime = Self::infer_image_mime(page_path);
        let (data_url, _) = self
            .prepare_segmentation_image_data(page_path, mime)
            .await?;

        // 使用适配器构建 prompt（支持 DeepSeek-OCR、PaddleOCR-VL 等）
        let ocr_mode = crate::ocr_adapters::OcrMode::Grounding;
        let prompt_text = adapter.build_prompt(ocr_mode);
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url, "detail": if adapter.requires_high_detail() { "high" } else { "low" } } },
                { "type": "text", "text": prompt_text }
            ]
        })];

        self.emit_deepseek_debug(
            "debug",
            "request",
            page_index,
            &format!("使用的 prompt ({})", engine_name),
            Some(json!({ "prompt": prompt_text, "engine": adapter.engine_type().as_str() })),
        );

        let max_tokens = crate::llm_manager::effective_max_tokens(
            config.max_output_tokens,
            config.max_tokens_limit,
        )
        .min(adapter.recommended_max_tokens(ocr_mode))
        .max(2048)
        .min(8000);
        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": adapter.recommended_temperature(),
            "max_tokens": max_tokens,
            "stream": false,
        });

        // GLM-4.5+ 支持 thinking 参数；OCR 默认关闭以降低延迟
        if crate::llm_manager::adapters::zhipu::ZhipuAdapter::supports_thinking_static(&config.model) {
            let enable = self.is_ocr_thinking_enabled();
            if let Some(obj) = request_body.as_object_mut() {
                obj.insert(
                    "thinking".to_string(),
                    json!({ "type": if enable { "enabled" } else { "disabled" } }),
                );
            }
        }

        if let Some(extra) = adapter.get_extra_request_params() {
            if let Some(obj) = request_body.as_object_mut() {
                if let Some(extra_obj) = extra.as_object() {
                    for (k, v) in extra_obj {
                        obj.insert(k.to_string(), v.clone());
                    }
                } else {
                    obj.insert("extra_params".to_string(), extra);
                }
            }
        }

        if let Some(repetition_penalty) = adapter.recommended_repetition_penalty() {
            if let Some(obj) = request_body.as_object_mut() {
                obj.insert("repetition_penalty".to_string(), json!(repetition_penalty));
            }
        }

        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("DeepSeek-OCR 请求构建失败", e))?;

        // 估算请求体大小（用于诊断日志）
        let body_size_estimate = serde_json::to_string(&preq.body)
            .map(|s| s.len())
            .unwrap_or(0);
        info!(
            "[DeepSeek-OCR] 页面 {} 发送请求: url={}, body_size≈{}KB",
            page_index,
            preq.url,
            body_size_estimate / 1024
        );

        let mut request_builder = self.client.post(&preq.url);
        for (k, v) in preq.headers.iter() {
            request_builder = request_builder.header(k.as_str(), v.as_str());
        }

        let response = request_builder
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("DeepSeek-OCR 请求失败: {}", e)))?;

        info!(
            "[DeepSeek-OCR] 页面 {} 收到响应: status={}",
            page_index,
            response.status()
        );

        let status = response.status();
        let retry_after_header = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::llm(format!("读取 DeepSeek-OCR 响应失败: {}", e)))?;

        if !status.is_success() {
            let mut detail = json!({
                "status": status.as_u16(),
                "body": response_text,
                "provider": "deepseek-ocr",
            });

            if let Some(value) = retry_after_header {
                if let Ok(seconds) = value.parse::<u64>() {
                    if let Some(map) = detail.as_object_mut() {
                        map.insert("retry_after_seconds".to_string(), json!(seconds));
                        map.insert(
                            "retry_after_ms".to_string(),
                            json!(seconds.saturating_mul(1000)),
                        );
                    }
                } else if let Some(map) = detail.as_object_mut() {
                    map.insert("retry_after_raw".to_string(), json!(value));
                }
            }

            return Err(AppError::with_details(
                AppErrorType::LLM,
                format!("DeepSeek-OCR 接口返回错误 {}", status),
                detail,
            ));
        }

        let response_json: Value = serde_json::from_str(&response_text).map_err(|e| {
            AppError::llm(format!(
                "解析 DeepSeek-OCR 响应 JSON 失败: {}, 原始内容: {}",
                e, response_text
            ))
        })?;

        let content = response_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::llm("DeepSeek-OCR 模型返回内容为空"))?
            .to_string();

        self.emit_deepseek_debug(
            "info",
            "response",
            page_index,
            &format!("响应状态: {}", status),
            None,
        );
        self.emit_deepseek_debug(
            "info",
            "response",
            page_index,
            &format!("content 长度: {} 字符", content.len()),
            None,
        );
        self.emit_deepseek_debug(
            "info",
            "response",
            page_index,
            "完整 content 内容",
            Some(json!({ "content": content })),
        );
        self.emit_deepseek_debug(
            "info",
            "response",
            page_index,
            "Token 使用情况",
            Some(response_json["usage"].clone()),
        );

        let approx_tokens_out = crate::utils::token_budget::estimate_tokens(&content);

        // 从 API 返回的 usage 数据中提取实际 token 数量
        let usage_value = response_json.get("usage");
        let prompt_tokens = usage_value
            .and_then(|u| u.get("prompt_tokens").or_else(|| u.get("input_tokens")))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let completion_tokens = usage_value
            .and_then(|u| {
                u.get("completion_tokens")
                    .or_else(|| u.get("output_tokens"))
            })
            .and_then(|v| v.as_u64())
            .unwrap_or(approx_tokens_out as u64) as u32;

        crate::llm_usage::record_llm_usage(
            crate::llm_usage::CallerType::ExamSheet,
            &config.model,
            prompt_tokens,
            completion_tokens,
            None,
            None,
            None,
            None,
            true,
            None,
        );

        Ok(content)
    }

    /// 优先级熔断重试：按优先级依次尝试已启用的 OCR 引擎，
    /// 某个引擎失败时自动切换到下一个。
    ///
    /// `task_type` 控制引擎优先级：
    /// - `Structured`：VLM 优先（GLM-4.6V），适合题目集/复杂布局
    /// - `FreeText`：OCR-VLM 优先（PaddleOCR / DeepSeek-OCR），适合普通文本提取
    pub async fn call_ocr_page_with_fallback(
        &self,
        page_path: &str,
        page_index: usize,
        task_type: crate::ocr_adapters::OcrTaskType,
    ) -> Result<Vec<ExamSegmentationCard>> {
        let engines = self.get_ocr_configs_by_priority(task_type).await.unwrap_or_default();

        if engines.is_empty() {
            return Err(AppError::configuration(
                "没有已启用的 OCR 引擎，请在设置中配置",
            ));
        }

        let mut last_err = None;
        for (idx, (config, engine_type)) in engines.iter().enumerate() {
            debug!(
                "[OCR] Trying engine #{} ({}, model={})",
                idx,
                engine_type.as_str(),
                config.model
            );
            match self
                .call_deepseek_ocr_page_raw(config, page_path, page_index)
                .await
            {
                Ok(cards) => {
                    if idx > 0 {
                        info!(
                            "[OCR] Fallback succeeded: engine #{} ({}) for page {}",
                            idx,
                            engine_type.as_str(),
                            page_index
                        );
                    }
                    return Ok(cards);
                }
                Err(e) => {
                    warn!(
                        "[OCR] Engine #{} ({}) failed for page {}: {}",
                        idx,
                        engine_type.as_str(),
                        page_index,
                        e
                    );
                    last_err = Some(e);
                }
            }
        }

        Err(last_err.unwrap_or_else(|| AppError::configuration("所有 OCR 引擎均失败")))
    }

    /// ★ FreeOCR 模式 + 渐进对冲（progressive hedging）
    ///
    /// 供作文批改 OCR、翻译 OCR、题目导入 OCR 使用。
    ///
    /// **策略：**
    /// 1. 立即启动优先级最高的引擎
    /// 2. 若 10s 内无响应，并行启动下一个引擎（前一个不取消）
    /// 3. 每隔 10s 再追加一个引擎，直到所有引擎均已启动
    /// 4. 每个引擎有独立 60s 硬超时
    /// 5. 采用**最先返回成功结果**的那个引擎
    pub async fn call_ocr_free_text_with_fallback(
        &self,
        image_path: &str,
    ) -> Result<String> {
        use crate::ocr_adapters::{OcrAdapterFactory, OcrMode};
        use crate::ocr_circuit_breaker::OCR_CIRCUIT_BREAKER;
        use crate::providers::ProviderAdapter;

        /// 单引擎硬超时
        const ENGINE_TIMEOUT_SECS: u64 = 60;
        /// 渐进对冲间隔：N 秒无响应则启动下一个引擎
        const HEDGE_INTERVAL_SECS: u64 = 10;

        // ★ 熔断检查
        if !OCR_CIRCUIT_BREAKER.allow_request() {
            return Err(AppError::llm(
                "OCR 服务暂时不可用（连续失败触发熔断），请稍后重试",
            ));
        }

        let engines = self
            .get_ocr_configs_by_priority(crate::ocr_adapters::OcrTaskType::FreeText)
            .await
            .unwrap_or_default();
        if engines.is_empty() {
            return Err(AppError::configuration(
                "没有已启用的 OCR 引擎，请在设置中配置",
            ));
        }

        // 准备图片数据（只做一次）
        let mime = Self::infer_image_mime(image_path);
        let (data_url, _) = self
            .prepare_segmentation_image_data(image_path, mime)
            .await?;

        // ── 阶段 1：预构建所有引擎的 HTTP 请求 ──
        let mut prepared: Vec<PreparedOcrRequest> = Vec::new();

        for (idx, (config, engine_type)) in engines.iter().enumerate() {
            let api_key = match self.decrypt_api_key_if_needed(&config.api_key) {
                Ok(k) => k,
                Err(e) => {
                    warn!("[OCR-Hedge] Engine #{} ({}) key decrypt failed: {}", idx, engine_type.as_str(), e);
                    continue;
                }
            };

            let adapter = OcrAdapterFactory::create(*engine_type);
            let ocr_mode = OcrMode::FreeOcr;
            let prompt_text = adapter.build_prompt(ocr_mode);

            let messages = vec![json!({
                "role": "user",
                "content": [
                    { "type": "image_url", "image_url": { "url": &data_url, "detail": if adapter.requires_high_detail() { "high" } else { "low" } } },
                    { "type": "text", "text": prompt_text }
                ]
            })];

            let max_tokens = super::effective_max_tokens(config.max_output_tokens, config.max_tokens_limit)
                .min(adapter.recommended_max_tokens(ocr_mode))
                .max(2048)
                .min(8000);

            let mut request_body = json!({
                "model": config.model,
                "messages": messages,
                "temperature": adapter.recommended_temperature(),
                "max_tokens": max_tokens,
                "stream": false,
            });

            if let Some(extra) = adapter.get_extra_request_params() {
                if let Some(obj) = request_body.as_object_mut() {
                    if let Some(extra_obj) = extra.as_object() {
                        for (k, v) in extra_obj {
                            obj.insert(k.to_string(), v.clone());
                        }
                    }
                }
            }
            if crate::llm_manager::adapters::zhipu::ZhipuAdapter::supports_thinking_static(&config.model) {
                let enable = self.is_ocr_thinking_enabled();
                if let Some(obj) = request_body.as_object_mut() {
                    obj.insert(
                        "thinking".to_string(),
                        json!({ "type": if enable { "enabled" } else { "disabled" } }),
                    );
                }
            }
            if let Some(rp) = adapter.recommended_repetition_penalty() {
                if let Some(obj) = request_body.as_object_mut() {
                    obj.insert("repetition_penalty".to_string(), json!(rp));
                }
            }

            let provider: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
                "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
                "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
                _ => Box::new(crate::providers::OpenAIAdapter),
            };

            let preq = match provider.build_request(&config.base_url, &api_key, &config.model, &request_body) {
                Ok(p) => p,
                Err(e) => {
                    warn!("[OCR-Hedge] Engine #{} ({}) request build failed: {}", idx, engine_type.as_str(), e);
                    continue;
                }
            };

            let mut header_map = reqwest::header::HeaderMap::new();
            for (k, v) in preq.headers.iter() {
                if let (Ok(name), Ok(val)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(v),
                ) {
                    header_map.insert(name, val);
                }
            }

            prepared.push(PreparedOcrRequest {
                idx,
                engine_name: engine_type.as_str().to_string(),
                model_name: config.model.clone(),
                model_adapter: config.model_adapter.clone(),
                url: preq.url,
                headers: header_map,
                body: preq.body,
            });
        }

        if prepared.is_empty() {
            return Err(AppError::configuration(
                "所有 OCR 引擎配置异常，无法构建请求",
            ));
        }

        // ── 阶段 2：渐进对冲执行 ──
        let total = prepared.len();
        let (tx, mut rx) =
            tokio::sync::mpsc::unbounded_channel::<(usize, std::result::Result<String, String>)>();
        let mut spawned = 0usize;
        let mut completed = 0usize;
        let mut last_err_msg: Option<String> = None;

        for (seq, req) in prepared.into_iter().enumerate() {
            let engine_name = req.engine_name.clone();
            let model_name = req.model_name.clone();
            let engine_idx = req.idx;

            let client = self.client.clone();
            let tx_clone = tx.clone();
            tokio::spawn(async move {
                let result =
                    run_single_ocr_request(client, req, ENGINE_TIMEOUT_SECS).await;
                let _ = tx_clone.send((engine_idx, result));
            });
            spawned += 1;

            info!(
                "[OCR-Hedge] Spawned engine #{} ({}, model={}) [{}/{}]",
                engine_idx, engine_name, model_name, seq + 1, total
            );

            // 非最后一个引擎 → 等 HEDGE_INTERVAL 看是否有结果
            if seq < total - 1 {
                let deadline =
                    tokio::time::sleep(std::time::Duration::from_secs(HEDGE_INTERVAL_SECS));
                tokio::pin!(deadline);

                loop {
                    tokio::select! {
                        msg = rx.recv() => {
                            match msg {
                                Some((eidx, Ok(text))) => {
                                    info!(
                                        "[OCR-Hedge] Engine #{} won the race ({} chars), {} other(s) may still be running",
                                        eidx, text.len(), spawned - completed - 1
                                    );
                                    OCR_CIRCUIT_BREAKER.record_success();
                                    return Ok(text);
                                }
                                Some((eidx, Err(e))) => {
                                    completed += 1;
                                    warn!("[OCR-Hedge] Engine #{} failed: {}", eidx, e);
                                    last_err_msg = Some(e);
                                    if completed >= spawned {
                                        break; // 已启动的全部失败，继续启动下一个
                                    }
                                    // 继续等待其他引擎或超时
                                }
                                None => break,
                            }
                        }
                        _ = &mut deadline => {
                            debug!(
                                "[OCR-Hedge] {}s elapsed with no result, hedging with next engine",
                                HEDGE_INTERVAL_SECS
                            );
                            break; // 启动下一个引擎
                        }
                    }
                }
            }
        }

        // 显式 drop 发送端，使 rx.recv() 在所有 spawn 完成后返回 None
        drop(tx);

        // ── 等待剩余已启动的引擎返回 ──
        while completed < spawned {
            match rx.recv().await {
                Some((eidx, Ok(text))) => {
                    info!(
                        "[OCR-Hedge] Engine #{} succeeded ({} chars)",
                        eidx,
                        text.len()
                    );
                    OCR_CIRCUIT_BREAKER.record_success();
                    return Ok(text);
                }
                Some((eidx, Err(e))) => {
                    completed += 1;
                    warn!("[OCR-Hedge] Engine #{} failed: {}", eidx, e);
                    last_err_msg = Some(e);
                }
                None => break,
            }
        }

        // 所有引擎均失败 → 记录熔断失败
        OCR_CIRCUIT_BREAKER.record_failure();
        Err(AppError::llm(
            last_err_msg.unwrap_or_else(|| "所有 OCR 引擎均失败".to_string()),
        ))
    }

    pub async fn call_deepseek_ocr_page_raw(
        &self,
        config: &ApiConfig,
        page_path: &str,
        page_index: usize,
    ) -> Result<Vec<ExamSegmentationCard>> {
        // S7 fix: 根据实际模型推断引擎类型，传递给解析器
        let effective_engine =
            crate::ocr_adapters::OcrAdapterFactory::infer_engine_from_model(&config.model);

        let content = self
            .request_deepseek_ocr_content(config, page_path, page_index)
            .await?;

        let raw_regions = self
            .parse_ocr_regions_internal(
                &content,
                page_path,
                page_index,
                Some(effective_engine),
            )
            .await?;

        Ok(raw_regions)
    }

    /// 解析单页 DeepSeek-OCR grounding 输出
    async fn parse_ocr_regions_internal(
        &self,
        content: &str,
        page_image_path: &str,
        page_index: usize,
        engine_override: Option<crate::ocr_adapters::OcrEngineType>,
    ) -> Result<Vec<ExamSegmentationCard>> {
        use crate::deepseek_ocr_parser::{parse_deepseek_grounding, project_to_pixels};
        use crate::ocr_adapters::{OcrAdapterFactory, OcrMode};

        // S7 fix: 优先使用调用方传入的有效引擎类型，否则回退到全局设置
        let engine_type = match engine_override {
            Some(e) => e,
            None => self.get_ocr_engine_type().await,
        };

        // 读取图片尺寸
        let abs_path = self.file_manager.resolve_image_path(page_image_path);
        let (img_w, img_h) = tokio::task::spawn_blocking({
            let path = abs_path.clone();
            move || -> Result<(u32, u32)> {
                image::image_dimensions(&path)
                    .map_err(|e| AppError::file_system(format!("读取图片尺寸失败: {}", e)))
            }
        })
        .await
        .map_err(|e| AppError::file_system(format!("读取图片尺寸任务失败: {:?}", e)))??;

        // 解析 grounding 片段（完整预览）
        self.emit_deepseek_debug(
            "debug",
            "parse",
            page_index,
            &format!("content 全量预览 (engine: {:?})", engine_type),
            Some(json!({
                "preview": content,
                "engine": engine_type.as_str()
            })),
        );

        let convert_regions_to_cards = |regions: Vec<crate::ocr_adapters::OcrRegion>| {
            let mut cards = Vec::new();
            let w = img_w as f64;
            let h = img_h as f64;

            for (idx, region) in regions.iter().enumerate() {
                let (nx, ny, nw, nh) = if let Some(bbox) = region.bbox_normalized.as_ref() {
                    if bbox.len() != 4 {
                        continue;
                    }
                    (bbox[0], bbox[1], bbox[2], bbox[3])
                } else if let Some(bbox) = region.bbox_pixels.as_ref() {
                    if bbox.len() != 4 || w == 0.0 || h == 0.0 {
                        continue;
                    }
                    (bbox[0] / w, bbox[1] / h, bbox[2] / w, bbox[3] / h)
                } else {
                    continue;
                };

                let nx = nx.clamp(0.0, 1.0) as f32;
                let ny = ny.clamp(0.0, 1.0) as f32;
                let nw = nw.clamp(0.0, 1.0) as f32;
                let nh = nh.clamp(0.0, 1.0) as f32;
                if nw <= 0.0 || nh <= 0.0 {
                    continue;
                }

                cards.push(ExamSegmentationCard {
                    question_label: if region.label.trim().is_empty() {
                        format!("区域{}", idx)
                    } else {
                        region.label.clone()
                    },
                    bbox: ExamCardBBox {
                        x: nx,
                        y: ny,
                        width: nw,
                        height: nh,
                    },
                    ocr_text: Some(region.text.clone()),
                    tags: vec![],
                    extra_metadata: Some(json!({
                        "engine": engine_type.as_str(),
                        "source": "ocr_adapter",
                    })),
                    card_id: format!("ocr_p{}_r{}", page_index, idx),
                });
            }

            cards
        };

        let fallback_full_page = |text: &str| {
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed.len() <= 10 {
                return Vec::new();
            }

            vec![ExamSegmentationCard {
                question_label: "全页内容".to_string(),
                bbox: ExamCardBBox {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                ocr_text: Some(trimmed.to_string()),
                tags: vec![],
                extra_metadata: Some(json!({
                    "fallback_mode": "full_page_text",
                    "engine": engine_type.as_str()
                })),
                card_id: format!("fp_p{}_r0", page_index),
            }]
        };

        // S6 fix: 统一使用适配器解析所有引擎类型，消除旧解析器重复
        let adapter = OcrAdapterFactory::create(engine_type);
        let spans = match adapter.parse_response(
            content,
            img_w,
            img_h,
            page_index,
            page_image_path,
            OcrMode::Grounding,
        ) {
            Ok(result) => {
                let crate::ocr_adapters::OcrPageResult {
                    regions,
                    markdown_text,
                    ..
                } = result;
                let cards = convert_regions_to_cards(regions);
                if !cards.is_empty() {
                    self.emit_deepseek_debug(
                        "info",
                        "parse",
                        page_index,
                        &format!(
                            "适配器解析成功 ({}): {} 个区域",
                            engine_type.as_str(),
                            cards.len()
                        ),
                        None,
                    );
                    return Ok(cards);
                }
                // 没有坐标区域，回退到全页文本
                let text = markdown_text.as_deref().unwrap_or(content);
                return Ok(fallback_full_page(text));
            }
            Err(e) => {
                self.emit_deepseek_debug(
                    "warn",
                    "parse",
                    page_index,
                    &format!(
                        "适配器解析失败 ({}): {}, 尝试旧解析器回退",
                        engine_type.as_str(),
                        e
                    ),
                    None,
                );
                // 兼容回退：使用旧的 DeepSeek 解析器
                parse_deepseek_grounding(content)
            }
        };

        self.emit_deepseek_debug(
            "info",
            "parse",
            page_index,
            &format!("解析结果: {} 个 spans", spans.len()),
            None,
        );

        if spans.is_empty() {
            self.emit_deepseek_debug(
                "warn",
                "parse",
                page_index,
                &format!(
                    "⚠️ 未解析到 grounding 标记，使用纯文本模式 (engine: {:?})",
                    engine_type
                ),
                None,
            );

            return Ok(fallback_full_page(content));
        }

        // 坐标转换
        self.emit_deepseek_debug(
            "info",
            "convert",
            page_index,
            &format!("图片尺寸: {}x{}", img_w, img_h),
            None,
        );
        let regions = project_to_pixels(&spans, img_w, img_h);
        self.emit_deepseek_debug(
            "info",
            "convert",
            page_index,
            &format!("转换结果: {} 个 regions", regions.len()),
            None,
        );

        // 转换为 ExamSegmentationCard
        let cards = regions
            .iter()
            .enumerate()
            .map(|(idx, region)| {
                if region.bbox_0_1_xywh.len() != 4 {
                    return None;
                }

                Some(ExamSegmentationCard {
                    question_label: if region.label.is_empty() {
                        format!("区域{}", idx)
                    } else {
                        region.label.clone()
                    },
                    bbox: ExamCardBBox {
                        x: region.bbox_0_1_xywh[0] as f32,
                        y: region.bbox_0_1_xywh[1] as f32,
                        width: region.bbox_0_1_xywh[2] as f32,
                        height: region.bbox_0_1_xywh[3] as f32,
                    },
                    ocr_text: Some(region.text.clone()),
                    tags: vec![],
                    extra_metadata: None,
                    card_id: format!("ds_p{}_r{}", page_index, idx),
                })
            })
            .flatten()
            .collect::<Vec<_>>();

        self.emit_deepseek_debug(
            "info",
            "result",
            page_index,
            &format!("DeepSeek-OCR 识别到 {} 个原始区域", cards.len()),
            None,
        );

        Ok(cards)
    }

}
