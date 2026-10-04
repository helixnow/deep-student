//! OCR 引擎
//!
//! DeepSeek OCR 适配、PDF OCR 支持

use crate::models::{AppError, ExamCardBBox};
use base64::{engine::general_purpose, Engine as _};
use futures_util::{stream::FuturesUnordered, StreamExt};
use image::imageops::FilterType;
use image::{GenericImageView, ImageOutputFormat};
use log::{debug, error, info, warn};
use serde_json::{json, Value};
use std::future::Future;
use std::io::Cursor;
use std::path::Path;

use super::single_shot_stream::{run_single_shot, send_plain_request, SingleShotOptions};
use super::{
    build_provider_adapter, ApiConfig, ExamSegmentationCard, LLMManager, Result,
    EXAM_SEGMENT_MAX_DIMENSION, EXAM_SEGMENT_MAX_IMAGE_BYTES,
};

// ── 渐进对冲 OCR 用数据结构 ──

/// 预构建的单引擎 OCR 请求（所有字段 owned，可 tokio::spawn）。
///
/// 只保存配置与 OpenAI 形状的请求体：传输层（流式/非流式回退）每次尝试都按
/// 模式重新构建 provider 请求（见 `single_shot_stream`）。
struct PreparedOcrRequest {
    idx: usize,
    engine_name: String,
    model_name: String,
    config: ApiConfig,
    api_key: String,
    request_body: Value,
    is_codex: bool,
}

enum PreparedOcrCandidate {
    Remote(PreparedOcrRequest),
    SystemOcr { idx: usize, image_bytes: Vec<u8> },
}

/// Releasing a half-open probe is mandatory even when a caller drops the OCR future on timeout
/// or cancellation. In Closed/Open states `cancel_probe` is a no-op.
struct OcrCircuitProbeGuard;

impl Drop for OcrCircuitProbeGuard {
    fn drop(&mut self) {
        crate::ocr_circuit_breaker::OCR_CIRCUIT_BREAKER.cancel_probe();
    }
}

impl PreparedOcrCandidate {
    fn idx(&self) -> usize {
        match self {
            Self::Remote(request) => request.idx,
            Self::SystemOcr { idx, .. } => *idx,
        }
    }

    fn engine_name(&self) -> &str {
        match self {
            Self::Remote(request) => &request.engine_name,
            Self::SystemOcr { .. } => "system_ocr",
        }
    }

    fn model_name(&self) -> &str {
        match self {
            Self::Remote(request) => &request.model_name,
            Self::SystemOcr { .. } => "native",
        }
    }
}

type OcrRequestResult = (usize, std::result::Result<String, String>);

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

async fn run_ocr_with_deadline<T, F>(
    engine_idx: usize,
    engine_name: &str,
    timeout: std::time::Duration,
    operation: F,
) -> std::result::Result<T, String>
where
    F: Future<Output = std::result::Result<T, String>>,
{
    tokio::time::timeout(timeout, operation)
        .await
        .unwrap_or_else(|_| {
            let timeout_label = if timeout.subsec_nanos() == 0 {
                format!("{}s", timeout.as_secs())
            } else {
                format!("{}ms", timeout.as_millis())
            };
            Err(format!(
                "Engine #{} ({}) timed out ({})",
                engine_idx, engine_name, timeout_label
            ))
        })
}

/// 对冲 OCR 单引擎传输参数：不在引擎内重试（对冲本身就是冗余），流式按空闲
/// 超时判活——慢但持续出字的稠密页不再被旧的 60s 固定总超时掐断。
const HEDGE_ENGINE_HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const HEDGE_ENGINE_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
const HEDGE_ENGINE_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
const HEDGE_ENGINE_NONSTREAM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

fn hedge_engine_options(req: &PreparedOcrRequest) -> SingleShotOptions {
    let mut opts = SingleShotOptions::new(format!("OCR-Hedge #{} ({})", req.idx, req.engine_name))
        .with_max_retries(0)
        .with_timeouts(
            HEDGE_ENGINE_HEADER_TIMEOUT,
            HEDGE_ENGINE_IDLE_TIMEOUT,
            HEDGE_ENGINE_TOTAL_TIMEOUT,
        );
    opts.nonstream_timeout = HEDGE_ENGINE_NONSTREAM_TIMEOUT;
    opts
}

/// 外层兜底时限：一次流式尝试 + 可能的一次非流式回退。
fn hedge_engine_outer_deadline(opts: &SingleShotOptions) -> std::time::Duration {
    opts.total_timeout + opts.nonstream_timeout + std::time::Duration::from_secs(5)
}

/// 执行普通 OCR 引擎请求（独立于 LLMManager，可 tokio::spawn）。
/// 被取消（对冲已有赢家 / 调用方取消）时 future 被 drop，连同响应流一起关闭连接。
async fn run_single_ocr_request(
    client: reqwest::Client,
    req: PreparedOcrRequest,
) -> std::result::Result<String, String> {
    debug_assert!(!req.is_codex);
    let opts = hedge_engine_options(&req);
    let engine_idx = req.idx;
    let engine_name = req.engine_name.clone();
    let label = opts.label.clone();
    run_ocr_with_deadline(
        engine_idx,
        &engine_name,
        hedge_engine_outer_deadline(&opts),
        async {
            run_single_shot(
                &opts,
                &req.config,
                |mode, request_timeout| {
                    send_plain_request(
                        &client,
                        &req.config,
                        &req.request_body,
                        Some(req.api_key.as_str()),
                        mode,
                        request_timeout,
                        &label,
                    )
                },
                None,
            )
            .await
            .map(|completion| completion.content)
            .map_err(|error| {
                format!(
                    "Engine #{} ({}) failed: {}",
                    req.idx, req.engine_name, error.message
                )
            })
        },
    )
    .await
}

async fn run_single_system_ocr_request(
    idx: usize,
    image_bytes: Vec<u8>,
    timeout_secs: u64,
) -> std::result::Result<String, String> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        crate::ocr_adapters::system_ocr::perform_system_ocr(&image_bytes),
    )
    .await
    {
        Ok(Ok(text)) if !text.trim().is_empty() => Ok(text),
        Ok(Ok(_)) => Err(format!("Engine #{} (system_ocr) returned no text", idx)),
        Ok(Err(error)) => Err(format!("Engine #{} (system_ocr) failed: {}", idx, error)),
        Err(_) => Err(format!(
            "Engine #{} (system_ocr) timed out after {}s",
            idx, timeout_secs
        )),
    }
}

/// ★ C（2026-09-07）：PDF fallback 链的本地系统 OCR 兜底。
/// 读取页面图片文件并调用平台原生 OCR（Windows.Media.Ocr / macOS Vision），
/// 返回整页纯文本。与 free-text 对冲路径的 run_single_system_ocr_request 共用底层。
/// file_manager 由调用方传入（LLMManager 字段），避免引入静态路径解析。
async fn system_ocr_full_page(
    file_manager: &crate::file_manager::FileManager,
    page_path: &str,
) -> std::result::Result<String, String> {
    let abs_path = file_manager.resolve_image_path(page_path);

    let image_bytes = tokio::fs::read(&abs_path)
        .await
        .map_err(|e| format!("read page image failed: {}", e))?;

    const SYSTEM_OCR_TIMEOUT_SECS: u64 = 60;
    match tokio::time::timeout(
        std::time::Duration::from_secs(SYSTEM_OCR_TIMEOUT_SECS),
        crate::ocr_adapters::system_ocr::perform_system_ocr(&image_bytes),
    )
    .await
    {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(error)) => Err(format!("system_ocr failed: {}", error)),
        Err(_) => Err(format!(
            "system_ocr timed out after {}s",
            SYSTEM_OCR_TIMEOUT_SECS
        )),
    }
}

/// Codex 请求需要 LLMManager（OAuth 401 刷新后只重发一次），因此不 spawn，而是作为
/// future 在调用方的 FuturesUnordered 中与后台引擎并发；返回时被 drop 即关闭流。
async fn run_single_codex_ocr_request(
    manager: &LLMManager,
    req: PreparedOcrRequest,
) -> OcrRequestResult {
    debug_assert!(req.is_codex);
    let opts = hedge_engine_options(&req);
    let engine_idx = req.idx;
    let result = run_ocr_with_deadline(
        engine_idx,
        &req.engine_name,
        hedge_engine_outer_deadline(&opts),
        async {
            manager
                .single_shot_completion(
                    &req.config,
                    &req.request_body,
                    Some(req.api_key.as_str()),
                    None,
                    "OCR 对冲请求构建失败",
                    &opts,
                    None,
                )
                .await
                .map(|completion| completion.content)
                .map_err(|error| {
                    format!(
                        "Engine #{} ({}) Codex request failed: {}",
                        engine_idx, req.engine_name, error.message
                    )
                })
        },
    )
    .await;

    (engine_idx, result)
}

async fn next_ocr_result<F>(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<OcrRequestResult>,
    local_requests: &mut FuturesUnordered<F>,
) -> Option<OcrRequestResult>
where
    F: Future<Output = OcrRequestResult>,
{
    if local_requests.is_empty() {
        return rx.recv().await;
    }

    tokio::select! {
        result = local_requests.next() => result,
        result = rx.recv() => match result {
            Some(result) => Some(result),
            // The standard-request channel may close while a local Codex request is still active.
            None => local_requests.next().await,
        },
    }
}

impl LLMManager {
    fn detect_mime_from_image_bytes(data: &[u8]) -> Option<&'static str> {
        match image::guess_format(data).ok()? {
            image::ImageFormat::Png => Some("image/png"),
            image::ImageFormat::Jpeg => Some("image/jpeg"),
            image::ImageFormat::WebP => Some("image/webp"),
            image::ImageFormat::Gif => Some("image/gif"),
            image::ImageFormat::Bmp => Some("image/bmp"),
            _ => None,
        }
    }

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
            let detected_mime =
                Self::detect_mime_from_image_bytes(&data).unwrap_or(default_mime.as_str());

            if data.len() <= EXAM_SEGMENT_MAX_IMAGE_BYTES {
                let encoded = general_purpose::STANDARD.encode(&data);
                return Ok((
                    format!("data:{};base64,{}", detected_mime, encoded),
                    data.len(),
                ));
            }

            let image = image::load_from_memory(&data)
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
        });

        crate::llm_manager::LLMManager::apply_reasoning_config(&mut request_body, config, None);

        // GLM-4.5+ 支持 thinking 参数；OCR 默认关闭以降低延迟
        if crate::llm_manager::adapters::zhipu::ZhipuAdapter::supports_thinking_static(
            &config.model,
        ) {
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

        // 估算请求体大小（用于诊断日志）
        let body_size_estimate = serde_json::to_string(&request_body)
            .map(|s| s.len())
            .unwrap_or(0);
        // 🔒 P1-2 修复：Gemini 系引擎的 URL query 中含 API key，日志必须先脱敏
        info!(
            "[DeepSeek-OCR] 页面 {} 发送请求 (streaming): base_url={}, body_size≈{}KB",
            page_index,
            super::model2_pipeline::sanitize_url_for_log(&config.base_url),
            body_size_estimate / 1024
        );

        // 流式传输：稠密页输出数千 token 时，非流式请求会被网关（524/504）或
        // 固定总超时掐断；流式按空闲超时判活。重试只给 1 次——引擎 fallback 链与
        // 上层页级重试已提供冗余，且 5xx 页级快速失败语义（★E）依赖 details.status。
        let opts = SingleShotOptions::new(format!("{}-OCR(page {})", engine_name, page_index))
            .with_max_retries(1);
        let completion = self
            .single_shot_completion(
                config,
                &request_body,
                None,
                None,
                "DeepSeek-OCR 请求构建失败",
                &opts,
                None,
            )
            .await?;
        let content = completion.content;
        let usage_json = completion.usage.clone().unwrap_or(Value::Null);

        info!(
            "[DeepSeek-OCR] 页面 {} 收到响应: {} 字符 (attempts={}, stream={}, finish={:?})",
            page_index,
            content.len(),
            completion.attempts,
            completion.mode.is_stream(),
            completion.finish_reason
        );

        self.emit_deepseek_debug(
            "info",
            "response",
            page_index,
            &format!(
                "响应完成: attempts={}, stream={}",
                completion.attempts,
                completion.mode.is_stream()
            ),
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
            Some(usage_json.clone()),
        );

        let approx_tokens_out = crate::utils::token_budget::estimate_tokens(&content);

        // 从 API 返回的 usage 数据中提取实际 token 数量
        let usage_value = completion.usage.as_ref();
        let measured_prompt_tokens = usage_value
            .and_then(|u| u.get("prompt_tokens").or_else(|| u.get("input_tokens")))
            .and_then(|v| v.as_u64());
        let measured_completion_tokens = usage_value
            .and_then(|u| {
                u.get("completion_tokens")
                    .or_else(|| u.get("output_tokens"))
            })
            .and_then(|v| v.as_u64());
        let prompt_tokens = measured_prompt_tokens.unwrap_or(0) as u32;
        let completion_tokens =
            measured_completion_tokens.unwrap_or(approx_tokens_out as u64) as u32;

        // 缓存命中量（整卷 OCR 逐页同前缀，命中率有真实意义）：
        // OpenAI prompt_tokens_details.cached_tokens / DeepSeek prompt_cache_hit_tokens /
        // Responses input_tokens_details.cached_tokens；未上报保持 NULL（无测量≠0）
        let cached_tokens = usage_value
            .and_then(|u| {
                u.get("prompt_tokens_details")
                    .or_else(|| u.get("input_tokens_details"))
                    .and_then(|d| d.get("cached_tokens"))
                    .or_else(|| u.get("prompt_cache_hit_tokens"))
                    .or_else(|| u.get("cached_tokens"))
            })
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);

        // 真实 token 来源：双端实测 api / 双端缺失 heuristic / 半测半估 mixed
        let token_source = match (
            measured_prompt_tokens.is_some(),
            measured_completion_tokens.is_some(),
        ) {
            (true, true) => crate::chat_v2::types::TokenSource::Api,
            (false, false) => crate::chat_v2::types::TokenSource::Heuristic,
            _ => crate::chat_v2::types::TokenSource::Mixed,
        };

        crate::llm_usage::record_llm_usage_ext(
            crate::llm_usage::CallerType::ExamSheet,
            &config.model,
            prompt_tokens,
            completion_tokens,
            None,
            cached_tokens,
            None,
            None,
            true,
            None,
            // 生效协议归属（与请求构建同一判定），报表按协议拆分
            Some(super::effective_api_protocol_for_config(config)),
            Some(token_source.to_string()),
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
        use crate::ocr_circuit_breaker::OCR_CIRCUIT_BREAKER;

        let engines = self
            .get_ocr_configs_by_priority(task_type)
            .await
            .unwrap_or_default();

        if engines.is_empty() {
            return Err(AppError::configuration(
                "没有已启用的 OCR 引擎，请在设置中配置",
            ));
        }

        // ★ A3-X2：此前该路径（PDF OCR / VFS 索引用）完全未接入熔断器，所有引擎宕机时
        // 每页都会跑完整 fallback 链路的超时重试，500 页批量会长时间空转。接入全局熔断器：
        // Open 期间快速失败；成功 record_success 恢复，全失败 record_failure 累计。
        if !OCR_CIRCUIT_BREAKER.allow_request() {
            return Err(AppError::llm(
                "OCR 服务暂时不可用（连续失败触发熔断），请稍后重试",
            ));
        }

        let mut last_err = None;
        // ★ E（2026-09-07）5xx 页级快速失败：同一页在同一引擎连续 2 次 5xx/524
        // 即跳到下一引擎，全部引擎 5xx 则走系统 OCR 兜底。此前 524（Cloudflare
        // 网关超时）每页重试 2-3 次、每次吃满上游 2 分钟，7 页 PDF 单 OCR 阶段
        // 就要 15 分钟。4xx 的短路逻辑保持不变（见下方 D 注释）。
        const MAX_5XX_PER_ENGINE: usize = 2;
        let mut consecutive_5xx_per_engine: usize = 0;
        let mut last_engine_index: Option<usize> = None;
        for (idx, (config, engine_type)) in engines.iter().enumerate() {
            // 引擎切换时重置 5xx 计数
            if last_engine_index != Some(idx) {
                consecutive_5xx_per_engine = 0;
                last_engine_index = Some(idx);
            }
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
                    OCR_CIRCUIT_BREAKER.record_success();
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
                    // ★ D（2026-09-07）：4xx 类错误是确定性拒绝（403 限流/权限、
                    // 400 请求格式、401 认证），继续重试只会撞墙。今天实测
                    // cdn.sta1n.cn 403 期间单分钟 300+ 次重试风暴、单页 42 轮
                    // fallback 空转——4xx 必须立即中断本页 fallback 链，
                    // 不再轮到后续引擎重放同一确定性失败。
                    // HTTP 状态由 request_deepseek_ocr_content 写入 details.status。
                    let status = e
                        .details
                        .as_ref()
                        .and_then(|d| d.get("status"))
                        .and_then(|v| v.as_u64());
                    let is_client_error = status.map(|s| (400..500).contains(&s)).unwrap_or(false);
                    if is_client_error {
                        OCR_CIRCUIT_BREAKER.record_failure();
                        return Err(e);
                    }
                    // ★ E：5xx（含 524/502/503/504 网关超时）快速失败——
                    // 同引擎连续 2 次 5xx 说明该引擎当前不可用，跳到下一引擎
                    let is_server_error = status.map(|s| s >= 500).unwrap_or(false);
                    if is_server_error {
                        consecutive_5xx_per_engine += 1;
                        if consecutive_5xx_per_engine >= MAX_5XX_PER_ENGINE {
                            warn!(
                                "[OCR] Engine #{} ({}) hit {} consecutive 5xx errors for page {}, skipping to next engine",
                                idx, engine_type.as_str(), consecutive_5xx_per_engine, page_index
                            );
                            continue;
                        }
                    } else {
                        consecutive_5xx_per_engine = 0;
                    }
                    last_err = Some(e);
                }
            }
        }

        // The remote-only page API excludes native candidates. Reuse the normal
        // enabled candidate list before falling back so an explicit System OCR
        // disable (including one made during the remote request) is respected.
        let system_ocr_enabled = self
            .get_free_text_ocr_candidates_by_priority()
            .await
            .unwrap_or_default()
            .iter()
            .any(|candidate| matches!(candidate, super::OcrRuntimeCandidate::SystemOcr));
        if system_ocr_enabled {
            info!(
                "[OCR] 所有远程引擎失败，尝试本地系统 OCR 兜底（page {}）",
                page_index
            );
            match system_ocr_full_page(&self.file_manager, page_path).await {
                Ok(text) if !text.trim().is_empty() => {
                    OCR_CIRCUIT_BREAKER.record_success();
                    info!(
                        "[OCR] 系统 OCR 兜底成功（page {}, {} chars）",
                        page_index,
                        text.trim().len()
                    );
                    return Ok(vec![ExamSegmentationCard {
                        question_label: "全页内容".to_string(),
                        bbox: ExamCardBBox {
                            x: 0.0,
                            y: 0.0,
                            width: 1.0,
                            height: 1.0,
                        },
                        ocr_text: Some(text.trim().to_string()),
                        tags: vec![],
                        extra_metadata: Some(serde_json::json!({
                            "fallback_mode": "system_ocr_full_page",
                        })),
                        card_id: format!("fp_p{}_r0", page_index),
                    }]);
                }
                Ok(_) => {
                    warn!("[OCR] 系统 OCR 兜底返回空文本（page {}）", page_index);
                }
                Err(error) => {
                    warn!("[OCR] 系统 OCR 兜底失败（page {}）: {}", page_index, error);
                }
            }
        }

        // 所有引擎均失败 → 记录熔断失败
        OCR_CIRCUIT_BREAKER.record_failure();
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
    /// 4. 远程引擎流式传输，按空闲超时（45s 无字节）判活、300s 硬上限；系统 OCR 60s
    /// 5. 赢家返回后取消其余仍在运行的引擎（drop 流，停止计费）
    /// 6. 采用**最先返回成功结果**的那个引擎
    pub async fn call_ocr_free_text_with_fallback(&self, image_path: &str) -> Result<String> {
        self.call_ocr_free_text_with_fallback_filtered(
            image_path,
            false,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
    }

    /// Chat 的 TM 图片降级只允许真正的 OCR 引擎。通用 VLM 已在上一阶段作为视觉
    /// observer 使用，不能在失败后再次伪装成 OCR 能力。
    pub(crate) async fn call_dedicated_ocr_free_text_with_fallback(
        &self,
        image_path: &str,
        cancellation_token: tokio_util::sync::CancellationToken,
    ) -> Result<String> {
        self.call_ocr_free_text_with_fallback_filtered(image_path, true, cancellation_token)
            .await
    }

    async fn call_ocr_free_text_with_fallback_filtered(
        &self,
        image_path: &str,
        dedicated_only: bool,
        cancellation_token: tokio_util::sync::CancellationToken,
    ) -> Result<String> {
        use crate::ocr_adapters::{OcrAdapterFactory, OcrMode};
        use crate::ocr_circuit_breaker::OCR_CIRCUIT_BREAKER;
        use crate::providers::ProviderAdapter;

        /// 系统 OCR（本地原生）单引擎硬超时；远程引擎改为流式空闲超时，
        /// 见 `hedge_engine_options`
        const ENGINE_TIMEOUT_SECS: u64 = 60;
        /// 渐进对冲间隔：N 秒无响应则启动下一个引擎
        const HEDGE_INTERVAL_SECS: u64 = 10;

        // ★ 熔断检查
        if !OCR_CIRCUIT_BREAKER.allow_request() {
            return Err(AppError::llm(
                "OCR 服务暂时不可用（连续失败触发熔断），请稍后重试",
            ));
        }
        let _probe_guard = OcrCircuitProbeGuard;

        let mut engines = self
            .get_free_text_ocr_candidates_by_priority()
            .await
            .unwrap_or_default();
        if dedicated_only {
            engines.retain(|candidate| candidate.engine_type().is_dedicated_ocr());
        }
        if engines.is_empty() {
            // ★ A3-X1：配置错误（非服务过错）——释放探针，不计失败
            OCR_CIRCUIT_BREAKER.cancel_probe();
            return Err(AppError::configuration(
                "没有已启用的 OCR 引擎，请在设置中配置",
            ));
        }

        // 准备图片数据（只做一次）
        let mime = Self::infer_image_mime(image_path);
        let (data_url, _) = match self.prepare_segmentation_image_data(image_path, mime).await {
            Ok(v) => v,
            Err(e) => {
                // ★ A3-X1：图片准备失败属本地输入问题，释放探针不计为引擎失败
                OCR_CIRCUIT_BREAKER.cancel_probe();
                return Err(e);
            }
        };

        // 系统 OCR 直接读取原图并调用本地 API，不构造虚假的 HTTP ApiConfig。
        let system_image_bytes = if engines
            .iter()
            .any(|candidate| matches!(candidate, super::OcrRuntimeCandidate::SystemOcr))
        {
            let path = self.file_manager.resolve_image_path(image_path);
            match tokio::fs::read(path).await {
                Ok(bytes) => Some(bytes),
                Err(error) => {
                    warn!("[OCR-Hedge] System OCR image read failed: {}", error);
                    None
                }
            }
        } else {
            None
        };

        // ── 阶段 1：预构建远程请求，并把系统 OCR 保留为原生候选 ──
        let mut prepared: Vec<PreparedOcrCandidate> = Vec::new();

        for (idx, candidate) in engines.iter().enumerate() {
            let (config, engine_type) = match candidate {
                super::OcrRuntimeCandidate::SystemOcr => {
                    if let Some(image_bytes) = system_image_bytes.as_ref() {
                        prepared.push(PreparedOcrCandidate::SystemOcr {
                            idx,
                            image_bytes: image_bytes.clone(),
                        });
                    }
                    continue;
                }
                super::OcrRuntimeCandidate::Remote {
                    config,
                    engine_type,
                } => (config, engine_type),
            };
            let api_key = match self.decrypt_api_key_if_needed(&config.api_key) {
                Ok(k) => k,
                Err(e) => {
                    warn!(
                        "[OCR-Hedge] Engine #{} ({}) key decrypt failed: {}",
                        idx,
                        engine_type.as_str(),
                        e
                    );
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

            let max_tokens =
                super::effective_max_tokens(config.max_output_tokens, config.max_tokens_limit)
                    .min(adapter.recommended_max_tokens(ocr_mode))
                    .max(2048)
                    .min(8000);

            let mut request_body = json!({
                "model": config.model,
                "messages": messages,
                "temperature": adapter.recommended_temperature(),
                "max_tokens": max_tokens,
            });

            crate::llm_manager::LLMManager::apply_reasoning_config(&mut request_body, config, None);

            if let Some(extra) = adapter.get_extra_request_params() {
                if let Some(obj) = request_body.as_object_mut() {
                    if let Some(extra_obj) = extra.as_object() {
                        for (k, v) in extra_obj {
                            obj.insert(k.to_string(), v.clone());
                        }
                    }
                }
            }
            if crate::llm_manager::adapters::zhipu::ZhipuAdapter::supports_thinking_static(
                &config.model,
            ) {
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

            // 预校验：请求能否构建（配置异常的引擎提前跳过，不计入熔断失败）。
            // 真正发送时按传输模式（流式 / 非流式回退）重新构建。
            let provider: Box<dyn ProviderAdapter> = build_provider_adapter(config);
            let is_codex = match self
                .prepare_provider_request(
                    provider.as_ref(),
                    config,
                    &request_body,
                    Some(&api_key),
                    None,
                    "OCR 对冲请求构建失败",
                )
                .await
            {
                Ok(p) => p.is_codex(),
                Err(e) => {
                    warn!(
                        "[OCR-Hedge] Engine #{} ({}) request build failed: {}",
                        idx,
                        engine_type.as_str(),
                        e.message
                    );
                    continue;
                }
            };

            prepared.push(PreparedOcrCandidate::Remote(PreparedOcrRequest {
                idx,
                engine_name: engine_type.as_str().to_string(),
                model_name: config.model.clone(),
                config: config.clone(),
                api_key,
                request_body,
                is_codex,
            }));
        }

        if prepared.is_empty() {
            // ★ A3-X1：请求全部构建失败属配置问题，释放探针不计失败
            OCR_CIRCUIT_BREAKER.cancel_probe();
            return Err(AppError::configuration(
                "所有 OCR 引擎配置异常，无法构建请求",
            ));
        }

        // ── 阶段 2：渐进对冲执行 ──
        // 赛跑令牌：本函数返回（有赢家 / 全部失败 / 取消）时 drop guard 取消它，
        // 后台仍在跑的落败引擎随之 drop 掉各自的流式响应，不再继续消耗 token。
        let race_cancellation = cancellation_token.child_token();
        let _race_guard = race_cancellation.clone().drop_guard();
        let total = prepared.len();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<OcrRequestResult>();
        let mut local_codex_requests = FuturesUnordered::new();
        let mut spawned = 0usize;
        let mut completed = 0usize;
        let mut last_err_msg: Option<String> = None;

        for (seq, candidate) in prepared.into_iter().enumerate() {
            let engine_name = candidate.engine_name().to_string();
            let model_name = candidate.model_name().to_string();
            let engine_idx = candidate.idx();

            match candidate {
                PreparedOcrCandidate::Remote(req) if req.is_codex => {
                    local_codex_requests.push(run_single_codex_ocr_request(self, req));
                }
                PreparedOcrCandidate::Remote(req) => {
                    let client = self.client.clone();
                    let tx_clone = tx.clone();
                    let candidate_cancellation = race_cancellation.clone();
                    crate::background_tasks::BACKGROUND_TASKS.spawn(async move {
                        let result = tokio::select! {
                            biased;
                            _ = candidate_cancellation.cancelled() => Err("OCR cancelled".to_string()),
                            result = run_single_ocr_request(client, req) => result,
                        };
                        let _ = tx_clone.send((engine_idx, result));
                    });
                }
                PreparedOcrCandidate::SystemOcr { image_bytes, .. } => {
                    let tx_clone = tx.clone();
                    let candidate_cancellation = race_cancellation.clone();
                    crate::background_tasks::BACKGROUND_TASKS.spawn(async move {
                        let result = tokio::select! {
                            biased;
                            _ = candidate_cancellation.cancelled() => Err("OCR cancelled".to_string()),
                            result = run_single_system_ocr_request(
                                engine_idx,
                                image_bytes,
                                ENGINE_TIMEOUT_SECS,
                            ) => result,
                        };
                        let _ = tx_clone.send((engine_idx, result));
                    });
                }
            }
            spawned += 1;

            info!(
                "[OCR-Hedge] Spawned engine #{} ({}, model={}) [{}/{}]",
                engine_idx,
                engine_name,
                model_name,
                seq + 1,
                total
            );

            // 非最后一个引擎 → 等 HEDGE_INTERVAL 看是否有结果
            if seq < total - 1 {
                let deadline =
                    tokio::time::sleep(std::time::Duration::from_secs(HEDGE_INTERVAL_SECS));
                tokio::pin!(deadline);

                loop {
                    tokio::select! {
                        biased;
                        _ = cancellation_token.cancelled() => {
                            OCR_CIRCUIT_BREAKER.cancel_probe();
                            return Err(AppError::llm("OCR cancelled"));
                        }
                        msg = next_ocr_result(&mut rx, &mut local_codex_requests) => {
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
            let next = tokio::select! {
                biased;
                _ = cancellation_token.cancelled() => {
                    OCR_CIRCUIT_BREAKER.cancel_probe();
                    return Err(AppError::llm("OCR cancelled"));
                }
                result = next_ocr_result(&mut rx, &mut local_codex_requests) => result,
            };
            match next {
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
            .parse_ocr_regions_internal(&content, page_path, page_index, Some(effective_engine))
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
            .filter_map(|(idx, region)| {
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

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::service::{make_service_fn, service_fn};
    use hyper::{Body, Request, Response};
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn local_codex_result_survives_closed_background_channel() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<OcrRequestResult>();
        drop(tx);

        let mut local_requests = FuturesUnordered::new();
        local_requests.push(async {
            tokio::task::yield_now().await;
            (7, Ok("codex-result".to_string()))
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            next_ocr_result(&mut rx, &mut local_requests),
        )
        .await
        .expect("local request should not be starved by the closed channel")
        .expect("local request should produce a result");

        assert_eq!(result, (7, Ok("codex-result".to_string())));
    }

    /// A losing hedged engine is cancelled through the race token; its future
    /// (and with it the streamed HTTP response) must be dropped so the provider
    /// stops generating instead of streaming to completion in the background.
    #[tokio::test]
    async fn cancelled_hedge_engine_drops_its_stream() {
        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let first_chunk_sent = Arc::new(AtomicBool::new(false));
        let stream_dropped = Arc::new(AtomicBool::new(false));
        let (sent_flag, dropped_flag) = (first_chunk_sent.clone(), stream_dropped.clone());
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let (sent_flag, dropped_flag) = (sent_flag.clone(), dropped_flag.clone());
                async move {
                    Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                        let (sent_flag, dropped_flag) = (sent_flag.clone(), dropped_flag.clone());
                        async move {
                            let body = hyper::body::to_bytes(request.into_body()).await.unwrap();
                            let body: Value = serde_json::from_slice(&body).unwrap();
                            assert_eq!(body["stream"], json!(true), "hedged OCR must stream");
                            // Endless, steady SSE stream: only a client disconnect ends it.
                            let guard = DropFlag(dropped_flag);
                            let stream = futures_util::stream::unfold(
                                (guard, sent_flag),
                                |(guard, sent_flag)| async move {
                                    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                                    sent_flag.store(true, Ordering::SeqCst);
                                    let chunk = format!(
                                        "data: {}\n\n",
                                        json!({"choices":[{"index":0,"delta":{"content":"x"}}]})
                                    );
                                    Some((
                                        Ok::<_, Infallible>(hyper::body::Bytes::from(chunk)),
                                        (guard, sent_flag),
                                    ))
                                },
                            );
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .header("content-type", "text/event-stream")
                                    .body(Body::wrap_stream(stream))
                                    .unwrap(),
                            )
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let request = PreparedOcrRequest {
            idx: 1,
            engine_name: "mock_engine".to_string(),
            model_name: "mock-ocr".to_string(),
            config: ApiConfig {
                id: "hedge-drop-test".to_string(),
                name: "hedge-drop-test".to_string(),
                model: "mock-ocr".to_string(),
                base_url: format!("http://{address}/v1"),
                ..ApiConfig::default()
            },
            api_key: "test-key".to_string(),
            request_body: json!({"model": "mock-ocr", "messages": []}),
            is_codex: false,
        };
        let race = tokio_util::sync::CancellationToken::new();
        let candidate_cancellation = race.clone();
        let engine = tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = candidate_cancellation.cancelled() => Err("OCR cancelled".to_string()),
                result = run_single_ocr_request(reqwest::Client::new(), request) => result,
            }
        });

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while !first_chunk_sent.load(Ordering::SeqCst) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "stream never started"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        race.cancel();
        assert_eq!(engine.await.unwrap(), Err("OCR cancelled".to_string()));

        while !stream_dropped.load(Ordering::SeqCst) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "server-side stream must be dropped after the losing engine is cancelled"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        server_task.abort();
    }

    #[tokio::test]
    async fn ocr_deadline_covers_stalled_response_body() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let body_started = Arc::new(AtomicBool::new(false));
        let body_started_for_server = body_started.clone();
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let body_started = body_started_for_server.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |_request: Request<Body>| {
                        let body_started = body_started.clone();
                        async move {
                            let prefix = futures_util::stream::once(async move {
                                body_started.store(true, Ordering::SeqCst);
                                Ok::<_, Infallible>(hyper::body::Bytes::from_static(
                                    br#"{"choices":["#,
                                ))
                            });
                            let stalled = futures_util::stream::pending::<
                                std::result::Result<hyper::body::Bytes, Infallible>,
                            >();
                            Ok::<_, Infallible>(Response::new(Body::wrap_stream(
                                prefix.chain(stalled),
                            )))
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let operation = async move {
            let response = reqwest::Client::new()
                .get(format!("http://{address}/ocr"))
                .send()
                .await
                .map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("unexpected HTTP status: {}", response.status()));
            }
            let body = response.text().await.map_err(|error| error.to_string())?;
            serde_json::from_str::<Value>(&body)
                .map(|_| ())
                .map_err(|error| error.to_string())
        };

        let error = run_ocr_with_deadline(
            2,
            "stalled-body",
            std::time::Duration::from_millis(250),
            operation,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error,
            "Engine #2 (stalled-body) timed out (250ms)".to_string()
        );
        assert!(
            body_started.load(Ordering::SeqCst),
            "the response body must start before the total request deadline fires"
        );

        server_task.abort();
    }
}
