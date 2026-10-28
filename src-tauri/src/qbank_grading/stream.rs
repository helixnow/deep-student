//! Preserve transport completion separately from a usable grading verdict.

use serde_json::Value;

use crate::llm_manager::ApiConfig;
use crate::models::AppError;
use crate::providers::{ProviderAdapter, StreamEvent};

use super::types::{GradingCompletionStatus, GradingDiagnostics};

pub(super) struct GradingStreamState {
    pub diagnostics: GradingDiagnostics,
    done: bool,
    provider_error: Option<String>,
    provider_status: GradingCompletionStatus,
}

impl GradingStreamState {
    pub fn new(config: &ApiConfig) -> Self {
        Self {
            diagnostics: GradingDiagnostics {
                status: GradingCompletionStatus::Incomplete,
                model: config.model.clone(),
                model_config_id: config.id.clone(),
                max_output_tokens: crate::llm_manager::effective_max_tokens(
                    config.max_output_tokens,
                    config.max_tokens_limit,
                ),
                finish_reason: None,
                usage: None,
                response_chars: 0,
                reasoning_chars: 0,
                http_status: None,
                error_message: None,
            },
            done: false,
            provider_error: None,
            provider_status: GradingCompletionStatus::ProviderError,
        }
    }

    pub fn process_block(
        &mut self,
        adapter: &dyn ProviderAdapter,
        block: &str,
        on_chunk: &mut impl FnMut(String),
    ) -> bool {
        if let Some(payload) = crate::utils::sse_buffer::extract_stream_data_payload(block)
            .and_then(|payload| serde_json::from_str::<Value>(&payload).ok())
        {
            let reason = [
                "/choices/0/finish_reason",
                "/delta/stop_reason",
                "/stop_reason",
                "/response/incomplete_details/reason",
                "/incomplete_details/reason",
                "/candidates/0/finishReason",
            ]
            .into_iter()
            .find_map(|path| {
                payload
                    .pointer(path)
                    .and_then(Value::as_str)
                    .filter(|reason| !reason.is_empty())
            });
            if let Some(reason) = reason {
                self.diagnostics.finish_reason = Some(reason.to_string());
            }
        }
        self.process_events(adapter.parse_stream(block), on_chunk);
        self.done || self.provider_error.is_some()
    }

    pub fn finish_adapter(
        &mut self,
        adapter: &dyn ProviderAdapter,
        on_chunk: &mut impl FnMut(String),
    ) {
        self.process_events(adapter.finish_stream(), on_chunk);
    }

    pub fn http_error(&mut self, status: u16, body: &str) {
        self.diagnostics.http_status = Some(status);
        let message = serde_json::from_str::<Value>(body)
            .ok()
            .map(|value| provider_message(&value))
            .unwrap_or_else(|| body.chars().take(2048).collect());
        self.provider_error = Some(format!("HTTP {status}: {message}"));
    }

    fn process_events(&mut self, events: Vec<StreamEvent>, on_chunk: &mut impl FnMut(String)) {
        for event in events {
            match event {
                StreamEvent::ContentChunk(content) => {
                    self.diagnostics.response_chars += content.chars().count();
                    on_chunk(content);
                }
                StreamEvent::ReasoningChunk(reasoning) => {
                    self.diagnostics.reasoning_chars += reasoning.chars().count();
                    // Activity resets the foreground idle timer without exposing reasoning.
                    on_chunk(String::new());
                }
                StreamEvent::Usage(usage) => {
                    if let (Some(Value::Object(previous)), Value::Object(incoming)) =
                        (self.diagnostics.usage.as_mut(), &usage)
                    {
                        previous.extend(incoming.clone());
                    } else {
                        self.diagnostics.usage = Some(usage);
                    }
                }
                StreamEvent::SafetyBlocked(details) => {
                    let kind = details
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    self.provider_status = match kind {
                        "response.incomplete" => GradingCompletionStatus::Incomplete,
                        "response.cancelled" | "response.canceled" => {
                            GradingCompletionStatus::ProviderError
                        }
                        _ => GradingCompletionStatus::ProviderError,
                    };
                    if let Some(reason) = details.get("reason").and_then(Value::as_str) {
                        if self.diagnostics.finish_reason.is_none() {
                            self.diagnostics.finish_reason = Some(reason.to_string());
                        }
                    }
                    self.provider_error = Some(provider_message(&details));
                }
                StreamEvent::ToolCall(_) => {
                    self.provider_error = Some("批改模型返回了意外的工具调用".to_string());
                }
                StreamEvent::Done => self.done = true,
                _ => {}
            }
        }
    }

    pub fn complete(
        &mut self,
        cancelled: bool,
        transport_error: Option<AppError>,
    ) -> Option<AppError> {
        use GradingCompletionStatus as Status;
        let reason = self
            .diagnostics
            .finish_reason
            .as_deref()
            .unwrap_or_default();
        let (status, error) = if cancelled {
            (
                Status::Cancelled,
                Some(AppError::llm("AI 批改已取消，正式成绩未更新")),
            )
        } else if matches!(
            reason.to_ascii_lowercase().as_str(),
            "length" | "max_tokens" | "max_output_tokens" | "model_context_window_exceeded"
        ) {
            (Status::Truncated, Some(AppError::llm(format!(
                "AI 批改输出被截断（finish_reason={reason}，输出上限 {} token），已保留反馈草稿，仍待批改",
                self.diagnostics.max_output_tokens,
            ))))
        } else if let Some(error) = self.provider_error.take() {
            (
                self.provider_status.clone(),
                Some(AppError::llm(format!(
                    "批改供应商错误：{error}；正式成绩未更新"
                ))),
            )
        } else if let Some(error) = transport_error {
            let status = if matches!(
                error.error_type,
                crate::models::AppErrorType::Configuration
                    | crate::models::AppErrorType::Validation
            ) {
                Status::ConfigurationError
            } else {
                Status::TransportError
            };
            (status, Some(error))
        } else if !reason.is_empty()
            && !matches!(
                reason,
                "stop" | "end_turn" | "stop_sequence" | "STOP" | "completed"
            )
        {
            (
                Status::ProviderError,
                Some(AppError::llm(format!(
                    "批改供应商异常结束（finish_reason={reason}），正式成绩未更新"
                ))),
            )
        } else if self.done
            || matches!(
                reason,
                "stop" | "end_turn" | "stop_sequence" | "STOP" | "completed"
            )
        {
            (Status::Completed, None)
        } else {
            (
                Status::Incomplete,
                Some(AppError::llm(
                    "AI 批改响应异常中断，已保留反馈草稿，仍待批改",
                )),
            )
        };
        self.diagnostics.status = status;
        self.diagnostics.error_message = error.as_ref().map(|error| error.message.clone());
        error
    }
}

fn provider_message(details: &Value) -> String {
    details
        .pointer("/details/message")
        .or_else(|| details.pointer("/error/message"))
        .or_else(|| details.get("message"))
        .or_else(|| details.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("供应商拒绝或中断了批改请求")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::OpenAIAdapter;
    use serde_json::json;

    fn decode(blocks: &[&str]) -> (GradingStreamState, String, Option<AppError>) {
        let config = ApiConfig {
            model: "test-reasoner".into(),
            max_output_tokens: 128_000,
            ..Default::default()
        };
        let adapter = OpenAIAdapter::new();
        adapter
            .build_request("https://example.com/v1", "test", &config.model, &json!({}))
            .unwrap();
        let mut state = GradingStreamState::new(&config);
        let mut text = String::new();
        let mut on_chunk = |chunk: String| text.push_str(&chunk);
        for block in blocks {
            state.process_block(&adapter, block, &mut on_chunk);
        }
        state.finish_adapter(&adapter, &mut on_chunk);
        let error = state.complete(false, None);
        (state, text, error)
    }

    #[test]
    fn normal_finish_without_sentinel_preserves_content_and_trailing_usage() {
        let (state, text, error) = decode(&[
            r#"data: {"choices":[{"delta":{"content":"反馈<verdict>correct</verdict>"},"finish_reason":null}]}"#,
            r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            r#"data: {"choices":[],"usage":{"completion_tokens":42000}}"#,
        ]);
        assert!(error.is_none());
        assert_eq!(state.diagnostics.status, GradingCompletionStatus::Completed);
        assert_eq!(state.diagnostics.max_output_tokens, 128_000);
        assert_eq!(
            state.diagnostics.usage.unwrap()["completion_tokens"],
            42_000
        );
        assert!(text.ends_with("</verdict>"));
    }

    #[test]
    fn length_is_truncated_even_with_a_valid_tag_and_done() {
        let (state, text, error) = decode(&[
            r#"data: {"choices":[{"delta":{"content":"<verdict>correct</verdict>"},"finish_reason":"length"}]}"#,
            "data: [DONE]",
        ]);
        assert_eq!(state.diagnostics.status, GradingCompletionStatus::Truncated);
        assert!(error.unwrap().message.contains("128000"));
        assert!(!text.is_empty());
    }

    #[test]
    fn provider_errors_are_not_hidden_by_done() {
        let (state, text, error) = decode(&[
            r#"data: {"choices":[{"delta":{"content":"草稿"},"finish_reason":null}]}"#,
            r#"data: {"error":{"message":"quota exceeded","code":"quota"}}"#,
            "data: [DONE]",
        ]);
        assert_eq!(
            state.diagnostics.status,
            GradingCompletionStatus::ProviderError
        );
        assert_eq!(text, "草稿");
        assert!(error.unwrap().message.contains("quota exceeded"));
    }

    #[test]
    fn reasoning_only_without_a_terminal_marker_is_incomplete() {
        let (state, text, error) = decode(&[
            r#"data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}"#,
        ]);
        assert_eq!(
            state.diagnostics.status,
            GradingCompletionStatus::Incomplete
        );
        assert_eq!(state.diagnostics.reasoning_chars, 8);
        assert!(text.is_empty());
        assert!(error.is_some());
    }

    #[test]
    fn anthropic_max_tokens_is_truncated_not_completed() {
        let adapter = crate::providers::AnthropicAdapter::new();
        let mut state = GradingStreamState::new(&ApiConfig::default());
        let mut text = String::new();
        let mut on_chunk = |chunk: String| text.push_str(&chunk);
        state.process_block(
            &adapter,
            r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"draft"}}"#,
            &mut on_chunk,
        );
        state.process_block(&adapter, r#"data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8192}}"#, &mut on_chunk);
        state.process_block(&adapter, r#"data: {"type":"message_stop"}"#, &mut on_chunk);
        state.finish_adapter(&adapter, &mut on_chunk);
        assert!(state.complete(false, None).is_some());
        assert_eq!(state.diagnostics.status, GradingCompletionStatus::Truncated);
        assert_eq!(text, "draft");
    }

    #[test]
    fn responses_incomplete_preserves_terminal_draft_and_usage() {
        let adapter = crate::providers::OpenAIResponsesAdapter::new();
        let mut state = GradingStreamState::new(&ApiConfig::default());
        let mut text = String::new();
        let mut on_chunk = |chunk: String| text.push_str(&chunk);
        state.process_block(&adapter, r#"data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"draft"}]}],"usage":{"output_tokens":8192}}}"#,&mut on_chunk);
        state.finish_adapter(&adapter, &mut on_chunk);
        assert!(state.complete(false, None).is_some());
        assert_eq!(state.diagnostics.status, GradingCompletionStatus::Truncated);
        assert_eq!(text, "draft");
        assert_eq!(state.diagnostics.usage.unwrap()["output_tokens"], 8192);
    }

    #[test]
    fn provider_failure_and_transport_eof_have_distinct_statuses() {
        let mut state = GradingStreamState::new(&ApiConfig::default());
        state.http_error(429, r#"{"error":{"message":"rate limit"}}"#);
        let error = state.complete(false, None).unwrap();
        assert_eq!(
            state.diagnostics.status,
            GradingCompletionStatus::ProviderError
        );
        assert!(error.message.contains("429"));
        assert!(error.message.contains("rate limit"));
        let mut state = GradingStreamState::new(&ApiConfig::default());
        state.complete(false, Some(AppError::network("connection reset")));
        assert_eq!(
            state.diagnostics.status,
            GradingCompletionStatus::TransportError
        );
        let mut state = GradingStreamState::new(&ApiConfig::default());
        state.complete(false, Some(AppError::configuration("model not configured")));
        assert_eq!(
            state.diagnostics.status,
            GradingCompletionStatus::ConfigurationError
        );
    }

    #[test]
    fn gemini_stop_finish_reason_completes_without_done_sentinel() {
        let adapter = crate::providers::GeminiAdapter::new();
        let mut state = GradingStreamState::new(&ApiConfig::default());
        let mut text = String::new();
        let mut on_chunk = |chunk: String| text.push_str(&chunk);
        state.process_block(&adapter,r#"data: {"candidates":[{"content":{"parts":[{"text":"feedback <verdict>correct</verdict>"}]},"finishReason":"STOP"}]}"#,&mut on_chunk);
        state.finish_adapter(&adapter, &mut on_chunk);
        assert!(state.complete(false, None).is_none());
        assert_eq!(state.diagnostics.status, GradingCompletionStatus::Completed);
        assert!(text.contains("feedback"));
    }
}
