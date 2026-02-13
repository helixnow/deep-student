use futures_util::StreamExt;
use serde_json::json;
/// 翻译管线 - 核心业务逻辑
use std::sync::Arc;

use crate::database::Database;
use crate::llm_manager::{ApiConfig, LLMManager};
use crate::models::AppError;
use crate::providers::ProviderAdapter;
// ★ VFS 统一存储（2025-12-07）
use crate::vfs::database::VfsDatabase;

use super::events::TranslationEventEmitter;
use super::types::{TranslationRequest, TranslationResponse};

/// 翻译管线依赖
pub struct TranslationDeps {
    pub llm: Arc<LLMManager>,
    pub db: Arc<Database>, // 主数据库（配置/设置读取）
    pub emitter: TranslationEventEmitter,
    pub vfs_db: Arc<VfsDatabase>, // ★ VFS 数据库（必需，唯一存储）
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamStatus {
    Completed,
    Cancelled,
}

/// 运行翻译管线
pub async fn run_translation(
    request: TranslationRequest,
    deps: TranslationDeps,
) -> Result<Option<TranslationResponse>, AppError> {
    // 0. 输入验证：检查空文本
    if request.text.trim().is_empty() {
        return Err(AppError::validation("翻译文本不能为空".to_string()));
    }

    // 0.1 输入验证：检查文本长度（防止超大文本导致 API 超时或 OOM）
    const MAX_TEXT_CHARS: usize = 100_000; // 100K 字符上限
    let text_char_count = request.text.chars().count();
    if text_char_count > MAX_TEXT_CHARS {
        return Err(AppError::validation(format!(
            "翻译文本过长（当前 {} 字符，最大 {} 字符）",
            text_char_count, MAX_TEXT_CHARS
        )));
    }

    // 1. 构造翻译 Prompt
    let (system_prompt, user_prompt) = build_translation_prompts(&request)?;

    // 2. 获取翻译模型配置并解密 API Key
    let config = deps.llm.get_translation_model_config().await?;
    let api_key = deps.llm.decrypt_api_key(&config.api_key)?;

    // 3. 流式调用 LLM
    let mut accumulated = String::new();
    let stream_event = format!("translation_stream_{}", request.session_id);

    let stream_status = stream_translate(
        &config,
        &api_key,
        &system_prompt,
        &user_prompt,
        &stream_event,
        deps.llm.clone(),
        |chunk| {
            accumulated.push_str(&chunk);
            deps.emitter
                .emit_data(&request.session_id, chunk, accumulated.clone());
        },
    )
    .await?;

    if matches!(stream_status, StreamStatus::Cancelled) {
        deps.emitter.emit_cancelled(&request.session_id);
        return Ok(None);
    }

    // 🔧 P0-06 修复：移除后端的 VFS 记录创建，由前端统一管理
    // 原因：前端通过 Learning Hub 创建空翻译文件后，后端再创建会导致双写（孤儿记录）
    // 现在只返回翻译结果，前端通过 DSTU adapter 的 updateTranslation 更新记录
    let now = chrono::Utc::now().to_rfc3339();

    println!("✅ [Translation] 翻译完成，由前端管理存储");

    // 5. 发送完成事件（不再创建新记录，只返回翻译结果）
    deps.emitter.emit_complete(
        &request.session_id,
        request.session_id.clone(), // 使用 session_id 作为临时 ID，前端会用实际 node ID
        accumulated.clone(),
        now.clone(),
    );

    Ok(Some(TranslationResponse {
        id: request.session_id.clone(), // 使用 session_id，前端会忽略此值
        translated_text: accumulated,
        created_at: now,
        session_id: request.session_id,
    }))
}

/// 构造翻译 Prompt
fn build_translation_prompts(request: &TranslationRequest) -> Result<(String, String), AppError> {
    // System Prompt
    let mut system_prompt = request.prompt_override.clone().unwrap_or_else(|| {
        "You are a professional translator. Translate the given text accurately while preserving its tone, style, and formatting. Do not add explanations or notes. Only output the translated text.".to_string()
    });

    // 注入风格控制
    if let Some(formality) = &request.formality {
        let style_instruction = match formality.as_str() {
            "formal" => {
                "\n\nUse formal, polite language suitable for business or academic contexts."
            }
            "casual" => "\n\nUse casual, conversational language.",
            _ => "",
        };
        system_prompt.push_str(style_instruction);
    }

    // 注入术语表
    if let Some(glossary) = &request.glossary {
        if !glossary.is_empty() {
            system_prompt.push_str("\n\nGlossary (must use these translations):");
            for (src, tgt) in glossary {
                system_prompt.push_str(&format!("\n- {} → {}", src, tgt));
            }
        }
    }

    // User Prompt
    let user_prompt = if request.src_lang == "auto" {
        format!(
            "Please translate the following text to {}:\n\n{}",
            request.tgt_lang, request.text
        )
    } else {
        format!(
            "Please translate the following text from {} to {}:\n\n{}",
            request.src_lang, request.tgt_lang, request.text
        )
    };

    Ok((system_prompt, user_prompt))
}

/// 流式翻译（核心逻辑）
async fn stream_translate<F>(
    config: &ApiConfig,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    stream_event: &str,
    llm: Arc<LLMManager>,
    mut on_chunk: F,
) -> Result<StreamStatus, AppError>
where
    F: FnMut(String),
{
    let result = async {
        // 构造消息
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

        // 构造请求体
        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": config.max_output_tokens,
            "stream": true, // 关键：启用流式
        });

        // 选择适配器
        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        // 构造 HTTP 请求
        let preq = adapter
            .build_request(&config.base_url, api_key, &config.model, &request_body)
            .map_err(|e| AppError::llm(format!("翻译请求构建失败: {}", e)))?;

        let mut header_map = reqwest::header::HeaderMap::new();
        for (k, v) in preq.headers.iter() {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }

        // 复用 LLMManager 配置好的 HTTP 客户端
        let client = llm.get_http_client();

        // 注册取消监听
        llm.consume_pending_cancel(stream_event).await;
        let mut cancel_rx = llm.subscribe_cancel_stream(stream_event).await;

        // 发送流式请求
        let response = client
            .post(&preq.url)
            .headers(header_map)
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::llm(format!("翻译请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            // 记录完整错误到日志（仅开发调试用）
            eprintln!(
                "❌ [Translation] API error {}: {}",
                status, error_text
            );
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

        // 解析 SSE 流
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut stream_ended = false;
        let mut cancelled = false;

        while !stream_ended && !cancelled {
            if llm.consume_pending_cancel(stream_event).await {
                cancelled = true;
                break;
            }

            tokio::select! {
                changed = cancel_rx.changed() => {
                    if changed.is_ok() && *cancel_rx.borrow() {
                        cancelled = true;
                    }
                }
                chunk_result = stream.next() => {
                    match chunk_result {
                        Some(chunk) => {
                            let bytes = chunk.map_err(|e| AppError::llm(format!("读取流失败: {}", e)))?;
                            buffer.push_str(&String::from_utf8_lossy(&bytes));

                            while let Some(pos) = buffer.find("\n\n") {
                                let line = buffer[..pos].trim().to_string();
                                buffer = buffer[pos + 2..].to_string();

                                if line.is_empty() {
                                    continue;
                                }

                                if line == "data: [DONE]" {
                                    stream_ended = true;
                                    break;
                                }

                                let events = adapter.parse_stream(&line);
                                for event in events {
                                    match event {
                                        crate::providers::StreamEvent::ContentChunk(content) => {
                                            on_chunk(content);
                                        }
                                        crate::providers::StreamEvent::Done => {
                                            stream_ended = true;
                                            break;
                                        }
                                        _ => {}
                                    }
                                }

                                if stream_ended {
                                    break;
                                }
                            }
                        }
                        None => {
                            break;
                        }
                    }
                }
            }
        }

        if cancelled {
            return Ok(StreamStatus::Cancelled);
        }

        Ok(StreamStatus::Completed)
    }.await;

    llm.clear_cancel_stream(stream_event).await;

    result
}
