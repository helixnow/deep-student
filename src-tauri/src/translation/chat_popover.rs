//! 聊天弹窗翻译 - 短轻量、纯流式、无持久化
//!
//! 职责：
//! - 为 `TranslationPopover`（聊天里选中文字翻译）提供专用流式命令
//! - 自动使用用户配置的 `translation_model_config_id`（fallback 到 model2）
//! - 不写 VFS、不走 standalone 翻译页 pipeline；事件名独立避免互相干扰
//!
//! 与 `pipeline.rs` 的关系：
//! - 复用 `stream_translate`（核心 SSE/取消/适配器调度逻辑）
//! - 复用 `lang_full_name`（语言代码 → 全称映射）
//! - 不复用 `run_translation`（它绑定 VFS、emitter、120s 超时，不适合 popover）

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{Emitter, State, Window};
use tracing::{info, warn};

use crate::commands::AppState;
use crate::models::AppError;

use super::pipeline::{lang_full_name, stream_translate, StreamOptions, StreamStatus};

/// 显示模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatTranslationMode {
    Aligned,
    Plain,
}

/// 聊天翻译请求
#[derive(Debug, Clone, Deserialize)]
pub struct ChatTranslationRequest {
    /// 前端生成的请求 ID（也用作 stream_event 后缀，必须唯一）
    pub request_id: String,
    /// 要翻译的文本
    pub source: String,
    /// 源语言代码（如 'auto', 'zh-CN', 'en'）
    pub src_lang: String,
    /// 目标语言代码（如 'zh-CN', 'en'）
    pub tgt_lang: String,
    /// 选区前的上下文（最多 200 字符），用于消歧
    #[serde(default)]
    pub context_before: Option<String>,
    /// 选区后的上下文（最多 200 字符），用于消歧
    #[serde(default)]
    pub context_after: Option<String>,
}

/// 流事件 payload（独立于 standalone 翻译事件，结构更精简）
///
/// 协议演进（向后兼容，只增不改名）：
/// - `chunk.delta`：增量文本，前端自行拼接。当前实现只发 delta，
///   避免旧协议"每个 chunk 回传全量 accumulated"造成的 O(n²) IPC 拷贝。
/// - `chunk.accumulated`：旧协议的全量累积字段，保留为可选仅供兼容；
///   为 `None` 时不参与序列化（旧前端若收不到该字段会退回 delta 拼接）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ChatTranslationEvent {
    Chunk {
        delta: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        accumulated: Option<String>,
    },
    Complete,
    Error {
        message: String,
    },
    Cancelled,
}

/// 输入校验
const MAX_SOURCE_CHARS: usize = 8_000; // popover 是即时翻译场景，不需要支持超长
const MAX_CONTEXT_CHARS: usize = 200;

/// 低延迟路径参数：popover 场景快速失败优于长时间等待
/// （前端自身 90s 超时兜底，后端 30s 空闲即中断，让用户更早拿到可重试的错误）
const POPOVER_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const POPOVER_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
const POPOVER_MAX_REQUEST_ATTEMPTS: u32 = 2;
const POPOVER_TEMPERATURE: f32 = 0.2;
const POPOVER_MIN_MAX_TOKENS: u32 = 512;

/// 按源文本长度估算输出 token 上限，避免用模型全局大上限拖慢首包/尾包。
/// aligned 模式输出为 NDJSON（src+tgt+JSON 结构开销），预算放大更多。
fn popover_max_tokens(source_chars: usize, mode: ChatTranslationMode) -> u32 {
    let multiplier: usize = match mode {
        ChatTranslationMode::Aligned => 6,
        ChatTranslationMode::Plain => 3,
    };
    let estimated = source_chars.saturating_mul(multiplier).saturating_add(256);
    (estimated.min(u32::MAX as usize) as u32).max(POPOVER_MIN_MAX_TOKENS)
}

fn truncate_context(s: Option<String>) -> String {
    match s {
        Some(text) => {
            let text = text.trim();
            if text.is_empty() {
                String::new()
            } else if text.chars().count() > MAX_CONTEXT_CHARS {
                text.chars().take(MAX_CONTEXT_CHARS).collect()
            } else {
                text.to_string()
            }
        }
        None => String::new(),
    }
}

fn build_aligned_prompts(req: &ChatTranslationRequest) -> (String, String) {
    let src_name = lang_full_name(&req.src_lang);
    let tgt_name = lang_full_name(&req.tgt_lang);
    let context_before = truncate_context(req.context_before.clone());
    let context_after = truncate_context(req.context_after.clone());

    let system_prompt = format!(
        "You are a professional translator. Translate text from {src_name} to {tgt_name}.\n\n\
        Output rules:\n\
        - Output one JSON object per line. No markdown fences, no commentary, no preamble.\n\
        - Each object: {{\"src\":\"...\",\"tgt\":\"...\"}}\n\
        - Concatenating all \"src\" fields must reproduce the source text exactly (including whitespace and punctuation).\n\
        - Break the source into natural phrase-level chunks (noun phrases, verb phrases, clauses). Aim for 3-8 segments depending on length.\n\
        - When you finish all segments, end with one final line: {{\"done\":true}}\n\
        - Do NOT translate the context. Use it only to choose the right meaning of ambiguous words.",
        src_name = src_name,
        tgt_name = tgt_name,
    );

    let mut user_prompt = String::new();
    if !context_before.is_empty() || !context_after.is_empty() {
        user_prompt.push_str("Context (do NOT translate, for disambiguation only):\n");
        user_prompt.push_str(&context_before);
        user_prompt.push('«');
        user_prompt.push_str(&req.source);
        user_prompt.push('»');
        user_prompt.push_str(&context_after);
        user_prompt.push_str("\n\n");
    }
    user_prompt.push_str("Source to translate:\n");
    user_prompt.push_str(&req.source);

    (system_prompt, user_prompt)
}

fn build_plain_prompts(req: &ChatTranslationRequest) -> (String, String) {
    let src_name = lang_full_name(&req.src_lang);
    let tgt_name = lang_full_name(&req.tgt_lang);
    let context_before = truncate_context(req.context_before.clone());
    let context_after = truncate_context(req.context_after.clone());

    let system_prompt = format!(
        "You are a professional translator. Translate text from {src_name} to {tgt_name}.\n\n\
        Output rules:\n\
        - Output ONLY the translation. No source text, no commentary, no markdown.\n\
        - Preserve the source's tone, formatting cues (line breaks, punctuation), and proper nouns.\n\
        - Use the surrounding context (if provided) only to disambiguate words; do not translate the context itself.",
        src_name = src_name,
        tgt_name = tgt_name,
    );

    let mut user_prompt = String::new();
    if !context_before.is_empty() || !context_after.is_empty() {
        user_prompt.push_str("Context (do NOT translate):\n");
        user_prompt.push_str(&context_before);
        user_prompt.push('«');
        user_prompt.push_str(&req.source);
        user_prompt.push('»');
        user_prompt.push_str(&context_after);
        user_prompt.push_str("\n\n");
    }
    user_prompt.push_str("Source to translate:\n");
    user_prompt.push_str(&req.source);

    (system_prompt, user_prompt)
}

fn validate_request(req: &ChatTranslationRequest) -> Result<(), AppError> {
    if req.request_id.trim().is_empty() {
        return Err(AppError::validation("request_id 不能为空"));
    }
    if req.source.trim().is_empty() {
        return Err(AppError::validation("待翻译文本为空"));
    }
    if req.source.chars().count() > MAX_SOURCE_CHARS {
        return Err(AppError::validation(format!(
            "聊天翻译文本过长（{} 字符，最大 {}）",
            req.source.chars().count(),
            MAX_SOURCE_CHARS
        )));
    }
    Ok(())
}

fn stream_event_name(request_id: &str) -> String {
    format!("chat_translation_{}", request_id)
}

fn emit_event(window: &Window, event: &str, payload: ChatTranslationEvent) {
    if let Err(e) = window.emit(event, payload) {
        warn!("[ChatTranslation] 发送事件失败 ({}): {}", event, e);
    }
}

/// 通用入口：解析模型 → 流式调用 → 转发事件
async fn run_chat_translation(
    request: ChatTranslationRequest,
    mode: ChatTranslationMode,
    window: Window,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    validate_request(&request)?;

    let event_name = stream_event_name(&request.request_id);
    info!(
        "[ChatTranslation] start mode={:?} src={} tgt={} chars={} event={}",
        mode,
        request.src_lang,
        request.tgt_lang,
        request.source.chars().count(),
        event_name,
    );

    // 1. 解析翻译模型配置（优先 translation_model_config_id，自动 fallback 到 model2）
    let config = match state.llm_manager.get_translation_model_config().await {
        Ok(cfg) => cfg,
        Err(e) => {
            let msg = format!("翻译模型未配置：{}", e);
            emit_event(
                &window,
                &event_name,
                ChatTranslationEvent::Error {
                    message: msg.clone(),
                },
            );
            return Err(AppError::llm(msg));
        }
    };

    let api_key = match state.llm_manager.decrypt_api_key(&config.api_key) {
        Ok(k) => k,
        Err(e) => {
            let msg = format!("API 密钥解密失败：{}", e);
            emit_event(
                &window,
                &event_name,
                ChatTranslationEvent::Error {
                    message: msg.clone(),
                },
            );
            return Err(AppError::llm(msg));
        }
    };

    // 2. 构造 prompts
    let (system_prompt, user_prompt) = match mode {
        ChatTranslationMode::Aligned => build_aligned_prompts(&request),
        ChatTranslationMode::Plain => build_plain_prompts(&request),
    };

    // 3. 流式调用 + 转发事件（只发增量 delta；全量文本由前端拼接）
    // 低延迟参数：紧凑 max_tokens（按源长估算并受模型上限约束）+ 快速失败超时
    let model_cap =
        crate::llm_manager::effective_max_tokens(config.max_output_tokens, config.max_tokens_limit);
    let options = StreamOptions {
        temperature: POPOVER_TEMPERATURE,
        max_tokens: Some(popover_max_tokens(request.source.chars().count(), mode).min(model_cap)),
        idle_timeout: POPOVER_IDLE_TIMEOUT,
        total_timeout: POPOVER_TOTAL_TIMEOUT,
        max_request_attempts: POPOVER_MAX_REQUEST_ATTEMPTS,
    };
    let window_for_chunk = window.clone();
    let event_for_chunk = event_name.clone();
    let mut accumulated_chars: usize = 0; // 仅用于日志统计，不再拼接/回传全量文本
    let stream_result = stream_translate(
        &config,
        &api_key,
        &system_prompt,
        &user_prompt,
        &event_name,
        state.llm_manager.clone(),
        &options,
        |chunk| {
            accumulated_chars += chunk.chars().count();
            emit_event(
                &window_for_chunk,
                &event_for_chunk,
                ChatTranslationEvent::Chunk {
                    delta: chunk,
                    accumulated: None,
                },
            );
        },
    )
    .await;

    match stream_result {
        Ok(StreamStatus::Completed) => {
            // 空结果保护：流正常结束但没有任何产出（供应商静默失败），按错误上报
            if accumulated_chars == 0 {
                let msg = "翻译服务返回空结果，请重试。".to_string();
                emit_event(
                    &window,
                    &event_name,
                    ChatTranslationEvent::Error {
                        message: msg.clone(),
                    },
                );
                warn!("[ChatTranslation] empty result event={}", event_name);
                return Err(AppError::llm(msg));
            }
            emit_event(&window, &event_name, ChatTranslationEvent::Complete);
            info!(
                "[ChatTranslation] complete event={} chars={}",
                event_name, accumulated_chars
            );
            Ok(())
        }
        Ok(StreamStatus::Cancelled) => {
            emit_event(&window, &event_name, ChatTranslationEvent::Cancelled);
            info!("[ChatTranslation] cancelled event={}", event_name);
            Ok(())
        }
        // ★ A6-02：流意外中断按错误处理，避免把不完整译文当作完成
        Ok(StreamStatus::Incomplete) => {
            let msg = "翻译流式响应异常中断，结果不完整。请重试。".to_string();
            emit_event(
                &window,
                &event_name,
                ChatTranslationEvent::Error {
                    message: msg.clone(),
                },
            );
            warn!(
                "[ChatTranslation] incomplete event={} msg={}",
                event_name, msg
            );
            Err(AppError::llm(msg))
        }
        Err(e) => {
            let msg = e.to_string();
            emit_event(
                &window,
                &event_name,
                ChatTranslationEvent::Error {
                    message: msg.clone(),
                },
            );
            warn!("[ChatTranslation] error event={} msg={}", event_name, msg);
            Err(e)
        }
    }
}

/// 命令：流式短语对照翻译（NDJSON 输出）
///
/// 前端事件订阅：`chat_translation_${request_id}`
/// 取消：调用通用命令 `cancel_stream` 传入相同事件名
#[tauri::command]
pub async fn stream_chat_translation_aligned(
    request: ChatTranslationRequest,
    window: Window,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    run_chat_translation(request, ChatTranslationMode::Aligned, window, state).await
}

/// 命令：流式纯译文翻译（单栏渐进显示）
#[tauri::command]
pub async fn stream_chat_translation_plain(
    request: ChatTranslationRequest,
    window: Window,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    run_chat_translation(request, ChatTranslationMode::Plain, window, state).await
}
