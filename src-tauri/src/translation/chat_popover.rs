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
use tauri::{Emitter, State, Window};
use tracing::{info, warn};

use crate::commands::AppState;
use crate::models::AppError;

use super::pipeline::{lang_full_name, stream_translate, StreamStatus};

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
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ChatTranslationEvent {
    Chunk { delta: String, accumulated: String },
    Complete,
    Error { message: String },
    Cancelled,
}

/// 输入校验
const MAX_SOURCE_CHARS: usize = 8_000; // popover 是即时翻译场景，不需要支持超长
const MAX_CONTEXT_CHARS: usize = 200;

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
        user_prompt.push_str("«");
        user_prompt.push_str(&req.source);
        user_prompt.push_str("»");
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
        user_prompt.push_str("«");
        user_prompt.push_str(&req.source);
        user_prompt.push_str("»");
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

    // 3. 流式调用 + 转发事件
    let window_for_chunk = window.clone();
    let event_for_chunk = event_name.clone();
    let mut accumulated = String::new();
    let stream_result = stream_translate(
        &config,
        &api_key,
        &system_prompt,
        &user_prompt,
        &event_name,
        state.llm_manager.clone(),
        |chunk| {
            accumulated.push_str(&chunk);
            emit_event(
                &window_for_chunk,
                &event_for_chunk,
                ChatTranslationEvent::Chunk {
                    delta: chunk,
                    accumulated: accumulated.clone(),
                },
            );
        },
    )
    .await;

    match stream_result {
        Ok(StreamStatus::Completed) => {
            emit_event(&window, &event_name, ChatTranslationEvent::Complete);
            info!(
                "[ChatTranslation] complete event={} chars={}",
                event_name,
                accumulated.chars().count()
            );
            Ok(())
        }
        Ok(StreamStatus::Cancelled) => {
            emit_event(&window, &event_name, ChatTranslationEvent::Cancelled);
            info!("[ChatTranslation] cancelled event={}", event_name);
            Ok(())
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
