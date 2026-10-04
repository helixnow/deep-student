//! Streamed transport for single-shot structured requests (OCR / VLM page
//! analysis / question parsing).
//!
//! These callers want one complete answer, not incremental UI updates, and
//! historically sent `stream: false` with a fixed total timeout (60s–300s).
//! That shape fails in two ways on long outputs (dense exam pages, reasoning
//! models that think first):
//!
//! - Gateways cut idle non-streaming requests (Cloudflare ~100s → 524,
//!   nginx 60s → 504) even though the upstream model is still generating.
//! - A fixed total timeout kills slow-but-progressing requests and the retry
//!   starts from scratch, paying for the same tokens again.
//!
//! [`run_single_shot`] sends `stream: true` through the provider adapter, so
//! bytes flow continuously and the request is bounded by an *idle* timeout
//! (no bytes for N seconds; reasoning deltas and SSE keep-alives count as
//! activity) plus a generous hard cap, instead of a total-time guess. The
//! returned text is the accumulated `ContentChunk` stream; reasoning is
//! discarded (only counted) so downstream JSON extraction is unchanged.
//!
//! If a provider rejects streaming (HTTP 400/422 mentioning `stream`), the
//! request is retried once non-streaming and that config is remembered for the
//! rest of the process, so subsequent calls go straight to non-streaming.

use std::collections::HashSet;
use std::future::Future;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use log::{info, warn};
use serde_json::{json, Value};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::model2_pipeline::PreparedProviderRequest;
use super::{
    build_provider_adapter, normalize_nonstream_response_to_openai, ApiConfig, LLMManager, Result,
};
use crate::models::{AppError, AppErrorType};
use crate::providers::{ProviderAdapter, StreamEvent};
use crate::utils::sse_buffer::SseEventBuffer;

/// Default: no response headers within this window → retry (stream mode only;
/// a streaming server answers headers before generation finishes).
pub(crate) const DEFAULT_HEADER_TIMEOUT: Duration = Duration::from_secs(180);
/// Default: no bytes at all for this long while streaming → retry.
pub(crate) const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Default hard cap for one streamed attempt (a progressing stream is never
/// cut before this).
pub(crate) const DEFAULT_TOTAL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Default total timeout for the non-streaming fallback.
pub(crate) const DEFAULT_NONSTREAM_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// SSE framing inflates output ~5-20x; 32 MiB comfortably covers 16K output
/// tokens plus reasoning while still bounding a runaway response.
pub(crate) const DEFAULT_MAX_STREAM_BYTES: usize = 32 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
const RETRY_AFTER_CAP: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransportMode {
    Stream,
    NonStream,
}

impl TransportMode {
    pub(crate) fn is_stream(self) -> bool {
        matches!(self, Self::Stream)
    }
}

/// Timeouts / limits / retry budget for [`run_single_shot`]. All durations are
/// injectable so tests can exercise the idle/total logic in milliseconds.
#[derive(Debug, Clone)]
pub(crate) struct SingleShotOptions {
    pub label: String,
    pub header_timeout: Duration,
    pub idle_timeout: Duration,
    pub total_timeout: Duration,
    pub nonstream_timeout: Duration,
    pub max_stream_bytes: usize,
    /// Retries after the first attempt for transient failures (408/429/5xx
    /// incl. Cloudflare 52x, network errors, idle timeouts, truncated streams).
    pub max_retries: u32,
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    pub cancel: Option<CancellationToken>,
}

impl SingleShotOptions {
    pub(crate) fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            header_timeout: DEFAULT_HEADER_TIMEOUT,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            total_timeout: DEFAULT_TOTAL_TIMEOUT,
            nonstream_timeout: DEFAULT_NONSTREAM_TIMEOUT,
            max_stream_bytes: DEFAULT_MAX_STREAM_BYTES,
            max_retries: 2,
            backoff_base: Duration::from_secs(2),
            backoff_max: Duration::from_secs(30),
            cancel: None,
        }
    }

    pub(crate) fn with_max_retries(mut self, max_retries: u32) -> Self {
        self.max_retries = max_retries;
        self
    }

    pub(crate) fn with_cancel(mut self, cancel: CancellationToken) -> Self {
        self.cancel = Some(cancel);
        self
    }

    pub(crate) fn with_timeouts(
        mut self,
        header_timeout: Duration,
        idle_timeout: Duration,
        total_timeout: Duration,
    ) -> Self {
        self.header_timeout = header_timeout;
        self.idle_timeout = idle_timeout;
        self.total_timeout = total_timeout;
        self
    }

    /// Upper bound of one attempt in the given mode (used for outer deadlines).
    pub(crate) fn attempt_budget(&self, mode: TransportMode) -> Duration {
        match mode {
            TransportMode::Stream => self.total_timeout,
            TransportMode::NonStream => self.nonstream_timeout,
        }
    }
}

/// Result of a single-shot completion.
#[derive(Debug, Clone)]
pub(crate) struct SingleShotCompletion {
    /// Accumulated answer text (reasoning excluded).
    pub content: String,
    /// Bytes of reasoning/thinking text received (activity only, not returned).
    pub reasoning_bytes: usize,
    pub finish_reason: Option<String>,
    /// Provider usage object (raw field names; merged across usage events).
    pub usage: Option<Value>,
    /// Transport that produced the answer.
    pub mode: TransportMode,
    /// Number of HTTP attempts made (including the stream→non-stream fallback).
    pub attempts: u32,
    /// Set only when a delta callback had already received content and the
    /// stream then broke: the content is partial and was deliberately not
    /// retried (a retry would re-deliver duplicates).
    pub interrupted: Option<String>,
    /// The delta callback asked to stop.
    pub aborted: bool,
}

/// One HTTP response handed back by a sender, plus the adapter whose request
/// state matches it (adapters are stateful across `build_request`/parse).
pub(crate) struct SingleShotResponse {
    pub response: reqwest::Response,
    pub adapter: Box<dyn ProviderAdapter>,
    pub is_codex: bool,
}

pub(crate) type DeltaCallback<'a> = &'a mut (dyn FnMut(&str) -> bool + Send);

// ---------------------------------------------------------------------------
// Process-lifetime memory of configs that reject `stream: true`.
// ---------------------------------------------------------------------------

static STREAM_UNSUPPORTED: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn stream_fallback_key(config: &ApiConfig) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        config.id,
        config.base_url.trim(),
        config.model
    )
}

pub(crate) fn is_stream_known_unsupported(config: &ApiConfig) -> bool {
    STREAM_UNSUPPORTED
        .lock()
        .map(|set| set.contains(&stream_fallback_key(config)))
        .unwrap_or(false)
}

fn remember_stream_unsupported(config: &ApiConfig) {
    if let Ok(mut set) = STREAM_UNSUPPORTED.lock() {
        set.insert(stream_fallback_key(config));
    }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// Transient HTTP statuses worth retrying: 408/429 and 5xx (incl. Cloudflare
/// 520-524 and Anthropic 529). 501/505 are deterministic.
pub(crate) fn is_retryable_http_status(status: u16) -> bool {
    match status {
        408 | 429 => true,
        501 | 505 => false,
        500..=599 => true,
        _ => false,
    }
}

/// Whether a 400/422 body says the `stream` parameter itself is rejected.
pub(crate) fn body_rejects_streaming(status: u16, body: &str) -> bool {
    if !matches!(status, 400 | 422) {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    lower.contains("stream")
}

enum AttemptFailure {
    Retryable {
        error: AppError,
        retry_after: Option<Duration>,
    },
    StreamUnsupported(AppError),
    Fatal(AppError),
    Cancelled,
}

fn cancelled_error(label: &str) -> AppError {
    AppError::llm(format!("{label} 请求已取消"))
}

fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn http_failure(
    label: &str,
    mode: TransportMode,
    status: u16,
    body: &str,
    retry_after: Option<Duration>,
) -> AttemptFailure {
    let redacted = crate::debug_log_service::redact_sensitive_text(body);
    let mut details = json!({
        "status": status,
        "body": truncate_utf8(&redacted, 2000),
        "stream": mode.is_stream(),
    });
    if let Some(wait) = retry_after {
        details["retry_after_seconds"] = json!(wait.as_secs());
        details["retry_after_ms"] = json!(wait.as_millis() as u64);
    }
    let error = AppError::with_details(
        AppErrorType::LLM,
        format!(
            "{label} 接口返回错误 {status}: {}",
            truncate_utf8(&redacted, 300)
        ),
        details,
    );
    if mode.is_stream() && body_rejects_streaming(status, body) {
        AttemptFailure::StreamUnsupported(error)
    } else if is_retryable_http_status(status) {
        AttemptFailure::Retryable { error, retry_after }
    } else {
        AttemptFailure::Fatal(error)
    }
}

fn parse_retry_after(response: &reqwest::Response) -> Option<Duration> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
}

fn is_json_content_type(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|mime| {
            let mime = mime.trim().to_ascii_lowercase();
            mime == "application/json" || mime.ends_with("+json")
        })
}

async fn wait_cancelled(token: Option<&CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

// ---------------------------------------------------------------------------
// Stream accumulation
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Accumulated {
    content: String,
    reasoning_bytes: usize,
    finish_reason: Option<String>,
    usage: Option<Value>,
    delivered: bool,
    aborted: bool,
    done: bool,
}

impl Accumulated {
    fn merge_usage(&mut self, incoming: Value) {
        let Value::Object(incoming) = incoming else {
            return;
        };
        let merged = self
            .usage
            .get_or_insert_with(|| Value::Object(Default::default()));
        let Some(merged) = merged.as_object_mut() else {
            return;
        };
        for (key, value) in incoming {
            // Anthropic splits usage across message_start/message_delta; keep
            // the first non-zero value instead of clobbering it with a 0.
            let keep_existing = value.as_i64() == Some(0)
                && merged
                    .get(&key)
                    .and_then(Value::as_i64)
                    .is_some_and(|existing| existing != 0);
            if !keep_existing {
                merged.insert(key, value);
            }
        }
    }

    fn push_content(&mut self, text: &str, on_delta: &mut Option<DeltaCallback<'_>>) {
        if text.is_empty() {
            return;
        }
        self.content.push_str(text);
        if let Some(callback) = on_delta.as_deref_mut() {
            self.delivered = true;
            if !callback(text) {
                self.aborted = true;
            }
        }
    }
}

/// Best-effort finish reason from a raw SSE block across provider formats.
fn finish_reason_from_block(block: &str) -> Option<String> {
    let payload = crate::utils::sse_buffer::extract_stream_data_payload(block)?;
    let value: Value = serde_json::from_str(payload.trim()).ok()?;
    let as_reason = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
    };
    as_reason(value.pointer("/choices/0/finish_reason"))
        .or_else(|| as_reason(value.pointer("/delta/stop_reason")))
        .or_else(|| as_reason(value.pointer("/candidates/0/finishReason")))
        .or_else(|| as_reason(value.pointer("/response/incomplete_details/reason")))
        .or_else(|| {
            (value.get("type").and_then(Value::as_str) == Some("response.completed"))
                .then(|| "completed".to_string())
        })
}

fn handle_events(
    label: &str,
    events: Vec<StreamEvent>,
    acc: &mut Accumulated,
    on_delta: &mut Option<DeltaCallback<'_>>,
) -> std::result::Result<(), AttemptFailure> {
    for event in events {
        match event {
            StreamEvent::ContentChunk(text) => acc.push_content(&text, on_delta),
            StreamEvent::ReasoningChunk(text) => acc.reasoning_bytes += text.len(),
            StreamEvent::Usage(usage) => acc.merge_usage(usage),
            StreamEvent::Done => acc.done = true,
            StreamEvent::SafetyBlocked(info) => {
                let reason = info.get("reason").and_then(Value::as_str).unwrap_or("");
                let is_provider_error =
                    info.get("type").and_then(Value::as_str) == Some("provider_error");
                if reason == "length" {
                    // Output budget exhausted: same as a non-streaming response
                    // with finish_reason=length — hand back what we have.
                    acc.finish_reason = Some("length".to_string());
                    acc.done = true;
                } else if is_provider_error
                    && matches!(reason, "stream_error" | "insufficient_system_resource")
                {
                    return Err(AttemptFailure::Retryable {
                        error: AppError::with_details(
                            AppErrorType::Network,
                            format!("{label} 流式响应中途报错: {reason}"),
                            info,
                        ),
                        retry_after: None,
                    });
                } else {
                    return Err(AttemptFailure::Fatal(AppError::with_details(
                        AppErrorType::LLM,
                        format!(
                            "{label} 请求被供应商终止: {}",
                            if reason.is_empty() { "blocked" } else { reason }
                        ),
                        info,
                    )));
                }
            }
            _ => {}
        }
        if acc.aborted || acc.done {
            break;
        }
    }
    Ok(())
}

fn handle_block(
    label: &str,
    block: &str,
    adapter: &dyn ProviderAdapter,
    acc: &mut Accumulated,
    on_delta: &mut Option<DeltaCallback<'_>>,
) -> std::result::Result<(), AttemptFailure> {
    if let Some(reason) = finish_reason_from_block(block) {
        acc.finish_reason.get_or_insert(reason);
    }
    let is_done_marker = SseEventBuffer::check_done_marker(block);
    handle_events(label, adapter.parse_stream(block), acc, on_delta)?;
    if is_done_marker {
        acc.done = true;
    }
    Ok(())
}

/// Read an SSE body to completion. On failure the partially accumulated state
/// is returned alongside the failure so the driver can decide (retry vs.
/// hand back a partial already delivered to a callback).
async fn read_sse_body(
    response: reqwest::Response,
    adapter: &dyn ProviderAdapter,
    opts: &SingleShotOptions,
    deadline: Instant,
    on_delta: &mut Option<DeltaCallback<'_>>,
) -> (Accumulated, Option<AttemptFailure>) {
    let label = opts.label.as_str();
    let mut acc = Accumulated::default();
    let mut stream = response.bytes_stream();
    let mut buffer = SseEventBuffer::new();
    let mut received = 0usize;

    loop {
        let next = tokio::select! {
            biased;
            _ = wait_cancelled(opts.cancel.as_ref()) => {
                return (acc, Some(AttemptFailure::Cancelled));
            }
            _ = tokio::time::sleep_until(deadline) => {
                let error = AppError::network(format!(
                    "{label} 流式响应超过总时长上限 {}s",
                    opts.total_timeout.as_secs()
                ));
                return (acc, Some(AttemptFailure::Fatal(error)));
            }
            next = tokio::time::timeout(opts.idle_timeout, stream.next()) => next,
        };
        let chunk = match next {
            Err(_) => {
                let error = AppError::network(format!(
                    "{label} 流式响应空闲超过 {}s 无数据",
                    opts.idle_timeout.as_secs_f32()
                ));
                return (
                    acc,
                    Some(AttemptFailure::Retryable {
                        error,
                        retry_after: None,
                    }),
                );
            }
            Ok(None) => break,
            Ok(Some(Err(error))) => {
                let error =
                    AppError::network(format!("{label} 流式读取中断: {}", error.without_url()));
                return (
                    acc,
                    Some(AttemptFailure::Retryable {
                        error,
                        retry_after: None,
                    }),
                );
            }
            Ok(Some(Ok(chunk))) => chunk,
        };

        received = received.saturating_add(chunk.len());
        if received > opts.max_stream_bytes {
            let error = AppError::llm(format!(
                "{label} 流式响应超过大小上限 {} bytes",
                opts.max_stream_bytes
            ));
            return (acc, Some(AttemptFailure::Fatal(error)));
        }
        for block in buffer.process_bytes(&chunk) {
            if let Err(failure) = handle_block(label, &block, adapter, &mut acc, on_delta) {
                return (acc, Some(failure));
            }
            if acc.done || acc.aborted {
                return (acc, None);
            }
        }
    }

    // Transport EOF: drain a trailing event without a blank-line terminator,
    // then let stateful adapters resolve a finish_reason without `[DONE]`.
    for block in buffer.flush() {
        if block.trim().is_empty() {
            continue;
        }
        if let Err(failure) = handle_block(label, &block, adapter, &mut acc, on_delta) {
            return (acc, Some(failure));
        }
        if acc.done || acc.aborted {
            return (acc, None);
        }
    }
    if let Err(failure) = handle_events(label, adapter.finish_stream(), &mut acc, on_delta) {
        return (acc, Some(failure));
    }
    if !acc.done && !acc.aborted && adapter.requires_explicit_stream_completion() {
        let error = AppError::network(format!("{label} 流式响应提前结束（未收到结束标记）"));
        return (
            acc,
            Some(AttemptFailure::Retryable {
                error,
                retry_after: None,
            }),
        );
    }
    (acc, None)
}

/// Read a (small) body fully, bounded by `deadline`, `limit` and cancellation.
async fn read_body_limited(
    response: reqwest::Response,
    label: &str,
    limit: usize,
    deadline: Instant,
    cancel: Option<&CancellationToken>,
    truncate: bool,
) -> std::result::Result<String, AttemptFailure> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = wait_cancelled(cancel) => return Err(AttemptFailure::Cancelled),
            _ = tokio::time::sleep_until(deadline) => {
                return Err(AttemptFailure::Retryable {
                    error: AppError::network(format!("{label} 读取响应超时")),
                    retry_after: None,
                });
            }
            next = stream.next() => next,
        };
        match next {
            None => break,
            Some(Err(error)) => {
                return Err(AttemptFailure::Retryable {
                    error: AppError::network(format!(
                        "{label} 读取响应失败: {}",
                        error.without_url()
                    )),
                    retry_after: None,
                })
            }
            Some(Ok(chunk)) => {
                if body.len().saturating_add(chunk.len()) > limit {
                    if truncate {
                        let room = limit.saturating_sub(body.len());
                        body.extend_from_slice(&chunk[..room]);
                        break;
                    }
                    return Err(AttemptFailure::Fatal(AppError::llm(format!(
                        "{label} 响应超过大小上限 {limit} bytes"
                    ))));
                }
                body.extend_from_slice(&chunk);
            }
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Parse a complete non-streaming body (or an SSE body served with a JSON
/// content type / Codex bridged SSE) into an accumulated answer.
fn parse_complete_body(
    label: &str,
    body: &str,
    config: &ApiConfig,
    adapter: &dyn ProviderAdapter,
    is_codex: bool,
    on_delta: &mut Option<DeltaCallback<'_>>,
) -> std::result::Result<Accumulated, AttemptFailure> {
    let parsed: Option<Value> = serde_json::from_str::<Value>(body.trim()).ok().or_else(|| {
        is_codex
            .then(|| crate::openai_codex::codex_sse_to_responses_json(body).ok())
            .flatten()
    });

    let Some(response_json) = parsed else {
        // Not JSON: some gateways send SSE with a JSON content type.
        if body.contains("data:") {
            let mut acc = Accumulated::default();
            let mut buffer = SseEventBuffer::new();
            let mut blocks = buffer.process_bytes(body.as_bytes());
            blocks.extend(buffer.flush());
            for block in blocks {
                if block.trim().is_empty() {
                    continue;
                }
                handle_block(label, &block, adapter, &mut acc, on_delta)?;
                if acc.done || acc.aborted {
                    break;
                }
            }
            return Ok(acc);
        }
        return Err(AttemptFailure::Fatal(AppError::llm(format!(
            "{label} 响应不是有效 JSON: {}",
            truncate_utf8(body, 200)
        ))));
    };

    let openai_like = normalize_nonstream_response_to_openai(config, &response_json)
        .map_err(AttemptFailure::Fatal)?;
    let mut acc = Accumulated::default();
    let content = openai_like
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    acc.push_content(content, on_delta);
    acc.finish_reason = openai_like
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    acc.usage = response_json
        .get("usage")
        .filter(|usage| usage.is_object())
        .or_else(|| openai_like.get("usage").filter(|usage| usage.is_object()))
        .cloned();
    acc.done = true;
    Ok(acc)
}

fn into_completion(acc: Accumulated, mode: TransportMode, attempts: u32) -> SingleShotCompletion {
    SingleShotCompletion {
        content: acc.content,
        reasoning_bytes: acc.reasoning_bytes,
        finish_reason: acc.finish_reason,
        usage: acc.usage,
        mode,
        attempts,
        interrupted: None,
        aborted: acc.aborted,
    }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/// Run a single-shot completion with streaming transport, retries and the
/// stream-unsupported fallback.
///
/// `send(mode, request_timeout)` must build a *fresh* provider request for the
/// given transport mode (with `stream` set accordingly) and send it, applying
/// `request_timeout` as the per-request reqwest timeout. Its errors of type
/// `Network` are retried; anything else is fatal.
pub(crate) async fn run_single_shot<S, Fut>(
    opts: &SingleShotOptions,
    config: &ApiConfig,
    mut send: S,
    mut on_delta: Option<DeltaCallback<'_>>,
) -> Result<SingleShotCompletion>
where
    S: FnMut(TransportMode, Duration) -> Fut,
    Fut: Future<Output = Result<SingleShotResponse>>,
{
    let label = opts.label.as_str();
    let mut mode = if is_stream_known_unsupported(config) {
        TransportMode::NonStream
    } else {
        TransportMode::Stream
    };
    let mut fallback_used = false;
    let mut retries = 0u32;
    let mut attempts = 0u32;

    loop {
        if opts.cancel.as_ref().is_some_and(|t| t.is_cancelled()) {
            return Err(cancelled_error(label));
        }
        attempts += 1;
        let request_timeout = opts.attempt_budget(mode);
        let started = Instant::now();
        let deadline = started + request_timeout;
        // A streaming server answers headers before generation finishes; a
        // non-streaming one only after, so only stream mode gets a header bound.
        let header_bound = match mode {
            TransportMode::Stream => opts.header_timeout.min(request_timeout),
            TransportMode::NonStream => request_timeout,
        };

        let sent = tokio::select! {
            biased;
            _ = wait_cancelled(opts.cancel.as_ref()) => return Err(cancelled_error(label)),
            sent = tokio::time::timeout(header_bound, send(mode, request_timeout)) => sent,
        };

        let outcome: std::result::Result<Accumulated, (Accumulated, AttemptFailure)> = match sent {
            Err(_) => Err((
                Accumulated::default(),
                AttemptFailure::Retryable {
                    error: AppError::network(format!(
                        "{label} 等待响应头超时（{}s）",
                        header_bound.as_secs_f32()
                    )),
                    retry_after: None,
                },
            )),
            Ok(Err(error)) => {
                let failure = if matches!(error.error_type, AppErrorType::Network) {
                    AttemptFailure::Retryable {
                        error,
                        retry_after: None,
                    }
                } else {
                    AttemptFailure::Fatal(error)
                };
                Err((Accumulated::default(), failure))
            }
            Ok(Ok(SingleShotResponse {
                response,
                adapter,
                is_codex,
            })) => {
                let status = response.status();
                if !status.is_success() {
                    let retry_after = parse_retry_after(&response);
                    let body = read_body_limited(
                        response,
                        label,
                        MAX_ERROR_BODY_BYTES,
                        deadline,
                        opts.cancel.as_ref(),
                        true,
                    )
                    .await
                    .unwrap_or_default();
                    Err((
                        Accumulated::default(),
                        http_failure(label, mode, status.as_u16(), &body, retry_after),
                    ))
                } else if mode.is_stream() && !(is_json_content_type(&response) && !is_codex) {
                    match read_sse_body(response, adapter.as_ref(), opts, deadline, &mut on_delta)
                        .await
                    {
                        (acc, None) => Ok(acc),
                        (acc, Some(failure)) => Err((acc, failure)),
                    }
                } else {
                    // Non-streaming fallback, or a provider that ignored
                    // `stream: true` and answered with one JSON document.
                    match read_body_limited(
                        response,
                        label,
                        opts.max_stream_bytes,
                        deadline,
                        opts.cancel.as_ref(),
                        false,
                    )
                    .await
                    {
                        Ok(body) => parse_complete_body(
                            label,
                            &body,
                            config,
                            adapter.as_ref(),
                            is_codex,
                            &mut on_delta,
                        )
                        .map_err(|failure| (Accumulated::default(), failure)),
                        Err(failure) => Err((Accumulated::default(), failure)),
                    }
                }
            }
        };

        let (partial, failure) = match outcome {
            Ok(acc) => {
                if attempts > 1 {
                    info!(
                        "[SingleShot] {label} 第 {attempts} 次尝试成功（{}，{} 字符）",
                        if mode.is_stream() {
                            "stream"
                        } else {
                            "non-stream"
                        },
                        acc.content.len()
                    );
                }
                return Ok(into_completion(acc, mode, attempts));
            }
            Err(pair) => pair,
        };

        // Content already handed to the caller cannot be retried without
        // duplicating it; return the partial answer and let the caller decide.
        if partial.delivered {
            match failure {
                AttemptFailure::Cancelled => return Err(cancelled_error(label)),
                AttemptFailure::Retryable { error, .. }
                | AttemptFailure::Fatal(error)
                | AttemptFailure::StreamUnsupported(error) => {
                    warn!(
                        "[SingleShot] {label} 流式中断，已向调用方交付 {} 字符，不再重试: {}",
                        partial.content.len(),
                        error.message
                    );
                    let mut completion = into_completion(partial, mode, attempts);
                    completion.interrupted = Some(error.message);
                    return Ok(completion);
                }
            }
        }

        match failure {
            AttemptFailure::Cancelled => return Err(cancelled_error(label)),
            AttemptFailure::Fatal(error) => return Err(error),
            AttemptFailure::StreamUnsupported(error) => {
                if fallback_used {
                    return Err(error);
                }
                fallback_used = true;
                remember_stream_unsupported(config);
                warn!(
                    "[SingleShot] {label} 供应商拒绝流式请求，改用非流式重试并在本进程内记住该配置 (model={}): {}",
                    config.model, error.message
                );
                mode = TransportMode::NonStream;
                continue;
            }
            AttemptFailure::Retryable { error, retry_after } => {
                if retries >= opts.max_retries {
                    return Err(error);
                }
                retries += 1;
                let backoff = opts
                    .backoff_base
                    .saturating_mul(1u32 << (retries - 1).min(16))
                    .min(opts.backoff_max);
                let delay = retry_after
                    .map(|d| d.min(RETRY_AFTER_CAP))
                    .unwrap_or(backoff);
                warn!(
                    "[SingleShot] {label} 瞬态失败，{}ms 后重试 ({}/{}): {}",
                    delay.as_millis(),
                    retries,
                    opts.max_retries,
                    error.message
                );
                tokio::select! {
                    biased;
                    _ = wait_cancelled(opts.cancel.as_ref()) => return Err(cancelled_error(label)),
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
}

/// Send one already-prepared provider request with the given timeout.
pub(crate) async fn send_prepared_request(
    client: &reqwest::Client,
    codex_manager: Option<&LLMManager>,
    mut request: PreparedProviderRequest,
    adapter: Box<dyn ProviderAdapter>,
    mode: TransportMode,
    request_timeout: Duration,
    label: &str,
) -> Result<SingleShotResponse> {
    if request.is_codex() {
        let manager = codex_manager
            .ok_or_else(|| AppError::configuration("OpenAI Codex 请求缺少 LLMManager 上下文"))?;
        let response = match mode {
            TransportMode::Stream => {
                manager
                    .send_codex_stream_request_with_single_refresh(
                        &mut request,
                        Some(request_timeout),
                    )
                    .await?
            }
            TransportMode::NonStream => {
                manager
                    .send_codex_request_with_single_refresh(&mut request, Some(request_timeout))
                    .await?
            }
        };
        return Ok(SingleShotResponse {
            response,
            adapter,
            is_codex: true,
        });
    }

    let mut builder = client.post(&request.url).timeout(request_timeout).header(
        "Accept",
        if mode.is_stream() {
            "text/event-stream, application/json"
        } else {
            "application/json"
        },
    );
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    let response =
        builder.json(&request.body).send().await.map_err(|error| {
            AppError::network(format!("{label} 请求失败: {}", error.without_url()))
        })?;
    Ok(SingleShotResponse {
        response,
        adapter,
        is_codex: false,
    })
}

fn body_for_mode(request_body: &Value, mode: TransportMode) -> Value {
    let mut body = request_body.clone();
    if let Some(object) = body.as_object_mut() {
        object.insert("stream".to_string(), Value::Bool(mode.is_stream()));
        if !mode.is_stream() {
            object.remove("stream_options");
        }
    }
    body
}

/// Build-and-send for configs that do not need an `LLMManager` (no Codex
/// OAuth). Used by OCR engines spawned onto the runtime.
pub(crate) async fn send_plain_request(
    client: &reqwest::Client,
    config: &ApiConfig,
    request_body: &Value,
    api_key: Option<&str>,
    mode: TransportMode,
    request_timeout: Duration,
    label: &str,
) -> Result<SingleShotResponse> {
    let adapter = build_provider_adapter(config);
    let body = body_for_mode(request_body, mode);
    let request = LLMManager::prepare_plain_provider_request(
        adapter.as_ref(),
        config,
        &body,
        api_key,
        None,
        label,
    )?;
    send_prepared_request(client, None, request, adapter, mode, request_timeout, label).await
}

impl LLMManager {
    /// Single-shot structured completion over a streamed transport.
    ///
    /// `request_body` is an OpenAI-shaped chat body; its `stream` field is
    /// overwritten per attempt. Returns the accumulated answer text.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn single_shot_completion(
        &self,
        config: &ApiConfig,
        request_body: &Value,
        api_key: Option<&str>,
        session_id: Option<&str>,
        build_error_context: &str,
        opts: &SingleShotOptions,
        on_delta: Option<DeltaCallback<'_>>,
    ) -> Result<SingleShotCompletion> {
        let label = opts.label.as_str();
        run_single_shot(
            opts,
            config,
            |mode, request_timeout| async move {
                let adapter = build_provider_adapter(config);
                let body = body_for_mode(request_body, mode);
                let request = self
                    .prepare_provider_request(
                        adapter.as_ref(),
                        config,
                        &body,
                        api_key,
                        session_id,
                        build_error_context,
                    )
                    .await?;
                send_prepared_request(
                    &self.client,
                    Some(self),
                    request,
                    adapter,
                    mode,
                    request_timeout,
                    label,
                )
                .await
            },
            on_delta,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::OpenAIAdapter;
    use hyper::service::{make_service_fn, service_fn};
    use hyper::{Body, Request, Response};
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    type Handler = Arc<dyn Fn(usize, Value) -> Response<Body> + Send + Sync + 'static>;

    struct MockServer {
        url: String,
        hits: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for MockServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn spawn_server(handler: Handler) -> MockServer {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_server = hits.clone();
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let handler = handler.clone();
                let hits = hits_for_server.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                        let handler = handler.clone();
                        let hits = hits.clone();
                        async move {
                            let bytes = hyper::body::to_bytes(request.into_body())
                                .await
                                .unwrap_or_default();
                            let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                            let attempt = hits.fetch_add(1, Ordering::SeqCst);
                            Ok::<_, Infallible>(handler(attempt, body))
                        }
                    }))
                }
            }));
        let task = tokio::spawn(async move {
            let _ = server.await;
        });
        MockServer {
            url: format!("http://{address}/v1/chat/completions"),
            hits,
            task,
        }
    }

    fn sse(events: &[&str]) -> String {
        events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect()
    }

    fn content_event(text: &str) -> String {
        json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}).to_string()
    }

    fn finish_event() -> String {
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}).to_string()
    }

    fn sse_response(body: String) -> Response<Body> {
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(body))
            .unwrap()
    }

    /// SSE response whose chunks arrive one by one with `interval` between them.
    fn paced_sse_response(
        chunks: Vec<String>,
        interval: Duration,
        stall_at_end: bool,
    ) -> Response<Body> {
        let stream = futures_util::stream::unfold(
            (chunks.into_iter(), true),
            move |(mut iter, first)| async move {
                if !first {
                    tokio::time::sleep(interval).await;
                }
                match iter.next() {
                    Some(chunk) => Some((
                        Ok::<_, Infallible>(hyper::body::Bytes::from(chunk)),
                        (iter, false),
                    )),
                    None => {
                        if stall_at_end {
                            std::future::pending::<()>().await;
                        }
                        None
                    }
                }
            },
        );
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::wrap_stream(stream))
            .unwrap()
    }

    fn test_config(id: &str) -> ApiConfig {
        ApiConfig {
            id: id.to_string(),
            name: id.to_string(),
            model: "mock-model".to_string(),
            base_url: "http://127.0.0.1".to_string(),
            ..ApiConfig::default()
        }
    }

    fn fast_opts() -> SingleShotOptions {
        let mut opts = SingleShotOptions::new("test").with_timeouts(
            Duration::from_secs(5),
            Duration::from_millis(300),
            Duration::from_secs(10),
        );
        opts.nonstream_timeout = Duration::from_secs(5);
        opts.backoff_base = Duration::from_millis(10);
        opts.backoff_max = Duration::from_millis(20);
        opts
    }

    /// Sender used by the tests: plain OpenAI chat body, stream flag per mode.
    fn sender(
        url: String,
        seen_modes: Arc<Mutex<Vec<TransportMode>>>,
    ) -> impl FnMut(
        TransportMode,
        Duration,
    )
        -> std::pin::Pin<Box<dyn Future<Output = Result<SingleShotResponse>> + Send>> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        move |mode, timeout| {
            seen_modes.lock().unwrap().push(mode);
            let client = client.clone();
            let url = url.clone();
            Box::pin(async move {
                let response = client
                    .post(url)
                    .timeout(timeout)
                    .json(&json!({"model":"mock-model","messages":[],"stream": mode.is_stream()}))
                    .send()
                    .await
                    .map_err(|e| AppError::network(e.to_string()))?;
                Ok(SingleShotResponse {
                    response,
                    adapter: Box::new(OpenAIAdapter::new()),
                    is_codex: false,
                })
            })
        }
    }

    #[tokio::test]
    async fn accumulates_content_and_ignores_reasoning() {
        let server = spawn_server(Arc::new(|_, body| {
            assert_eq!(body["stream"], json!(true));
            let reasoning =
                json!({"choices":[{"index":0,"delta":{"reasoning_content":"thinking..."}}]})
                    .to_string();
            let usage = json!({"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}})
                .to_string();
            sse_response(sse(&[
                &reasoning,
                &content_event("[{\"a\":"),
                &content_event("1}]"),
                &finish_event(),
                &usage,
                "[DONE]",
            ]))
        }));
        let modes = Arc::new(Mutex::new(Vec::new()));
        let completion = run_single_shot(
            &fast_opts(),
            &test_config("accumulate"),
            sender(server.url.clone(), modes.clone()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(completion.content, "[{\"a\":1}]");
        assert_eq!(completion.reasoning_bytes, "thinking...".len());
        assert_eq!(completion.finish_reason.as_deref(), Some("stop"));
        assert_eq!(
            completion.usage.as_ref().unwrap()["prompt_tokens"],
            json!(11)
        );
        assert_eq!(completion.mode, TransportMode::Stream);
        assert_eq!(completion.attempts, 1);
    }

    #[tokio::test]
    async fn slow_but_steady_stream_outlives_fixed_total_timeouts() {
        // 16 chunks, 120ms apart (~1.8s total): far beyond the 300ms idle
        // window that would have been a fixed total timeout before.
        let server = spawn_server(Arc::new(|_, _| {
            let mut chunks: Vec<String> = (0..15)
                .map(|i| format!("data: {}\n\n", content_event(&i.to_string())))
                .collect();
            chunks.push(format!("data: {}\n\ndata: [DONE]\n\n", finish_event()));
            paced_sse_response(chunks, Duration::from_millis(120), false)
        }));
        let started = std::time::Instant::now();
        let completion = run_single_shot(
            &fast_opts(),
            &test_config("steady"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap();
        assert!(started.elapsed() > Duration::from_millis(1500));
        assert_eq!(completion.content, "01234567891011121314");
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn idle_stream_times_out_and_retries() {
        let server = spawn_server(Arc::new(|attempt, _| {
            if attempt == 0 {
                // One chunk then silence.
                paced_sse_response(
                    vec![format!("data: {}\n\n", content_event("partial"))],
                    Duration::from_millis(10),
                    true,
                )
            } else {
                sse_response(sse(&[&content_event("ok"), &finish_event(), "[DONE]"]))
            }
        }));
        let started = std::time::Instant::now();
        let completion = run_single_shot(
            &fast_opts(),
            &test_config("idle-retry"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(completion.content, "ok", "retry must start from scratch");
        assert_eq!(completion.attempts, 2);
        assert!(started.elapsed() >= Duration::from_millis(300));
    }

    #[tokio::test]
    async fn idle_timeout_surfaces_after_retry_budget() {
        let server = spawn_server(Arc::new(|_, _| {
            paced_sse_response(Vec::new(), Duration::from_millis(10), true)
        }));
        let opts = fast_opts().with_max_retries(1);
        let error = run_single_shot(
            &opts,
            &test_config("idle-exhausted"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("空闲"), "{}", error.message);
        assert_eq!(server.hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn total_cap_is_fatal_and_not_retried() {
        let server = spawn_server(Arc::new(|_, _| {
            let chunks = (0..100)
                .map(|_| format!("data: {}\n\n", content_event("x")))
                .collect();
            paced_sse_response(chunks, Duration::from_millis(50), false)
        }));
        let opts = fast_opts().with_timeouts(
            Duration::from_secs(5),
            Duration::from_millis(300),
            Duration::from_millis(600),
        );
        let error = run_single_shot(
            &opts,
            &test_config("total-cap"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("总时长"), "{}", error.message);
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retries_cloudflare_524() {
        let server = spawn_server(Arc::new(|attempt, _| {
            if attempt == 0 {
                Response::builder()
                    .status(524)
                    .body(Body::from("error code: 524"))
                    .unwrap()
            } else {
                sse_response(sse(&[&content_event("ok"), &finish_event(), "[DONE]"]))
            }
        }));
        let completion = run_single_shot(
            &fast_opts(),
            &test_config("524"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(completion.content, "ok");
        assert_eq!(completion.attempts, 2);
    }

    #[tokio::test]
    async fn client_errors_are_not_retried_and_keep_status_details() {
        let server = spawn_server(Arc::new(|_, _| {
            Response::builder()
                .status(401)
                .body(Body::from(r#"{"error":{"message":"bad key"}}"#))
                .unwrap()
        }));
        let error = run_single_shot(
            &fast_opts(),
            &test_config("401"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.details.as_ref().unwrap()["status"], json!(401));
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stream_rejection_falls_back_to_nonstream_and_is_remembered() {
        let server = spawn_server(Arc::new(|_, body| {
            if body["stream"] == json!(true) {
                Response::builder()
                    .status(400)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"error":{"message":"Streaming is not supported for this model"}}"#,
                    ))
                    .unwrap()
            } else {
                Response::builder()
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "choices":[{"index":0,"message":{"role":"assistant","content":"plain"},"finish_reason":"stop"}],
                            "usage":{"prompt_tokens":3,"completion_tokens":1}
                        })
                        .to_string(),
                    ))
                    .unwrap()
            }
        }));
        let config = test_config("stream-unsupported-fallback");
        let modes = Arc::new(Mutex::new(Vec::new()));
        let completion = run_single_shot(
            &fast_opts(),
            &config,
            sender(server.url.clone(), modes.clone()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(completion.content, "plain");
        assert_eq!(completion.mode, TransportMode::NonStream);
        assert_eq!(
            completion.usage.as_ref().unwrap()["prompt_tokens"],
            json!(3)
        );
        assert!(is_stream_known_unsupported(&config));

        // Second call goes straight to non-streaming.
        let second = run_single_shot(
            &fast_opts(),
            &config,
            sender(server.url.clone(), modes.clone()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(second.content, "plain");
        assert_eq!(second.attempts, 1);
        assert_eq!(
            *modes.lock().unwrap(),
            vec![
                TransportMode::Stream,
                TransportMode::NonStream,
                TransportMode::NonStream
            ]
        );
    }

    #[tokio::test]
    async fn provider_ignoring_stream_flag_is_parsed_as_json() {
        let server = spawn_server(Arc::new(|_, _| {
            Response::builder()
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"choices":[{"index":0,"message":{"role":"assistant","content":"json-body"},"finish_reason":"stop"}]})
                        .to_string(),
                ))
                .unwrap()
        }));
        let completion = run_single_shot(
            &fast_opts(),
            &test_config("ignored-stream"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(completion.content, "json-body");
    }

    #[tokio::test]
    async fn byte_cap_is_enforced_without_retry() {
        let server = spawn_server(Arc::new(|_, _| {
            let big = "x".repeat(4096);
            sse_response(sse(&[&content_event(&big), &content_event(&big), "[DONE]"]))
        }));
        let mut opts = fast_opts();
        opts.max_stream_bytes = 2048;
        let error = run_single_shot(
            &opts,
            &test_config("byte-cap"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("大小上限"), "{}", error.message);
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn eof_without_terminal_marker_is_retried() {
        let server = spawn_server(Arc::new(|attempt, _| {
            if attempt == 0 {
                sse_response(sse(&[&content_event("trunc")]))
            } else {
                sse_response(sse(&[&content_event("full"), &finish_event(), "[DONE]"]))
            }
        }));
        let completion = run_single_shot(
            &fast_opts(),
            &test_config("missing-terminal"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(completion.content, "full");
        assert_eq!(completion.attempts, 2);
    }

    #[tokio::test]
    async fn delivered_partial_is_returned_instead_of_retried() {
        let server = spawn_server(Arc::new(|_, _| {
            paced_sse_response(
                vec![format!("data: {}\n\n", content_event("[{\"q\":1},"))],
                Duration::from_millis(10),
                true,
            )
        }));
        let mut seen = String::new();
        let mut callback = |delta: &str| {
            seen.push_str(delta);
            true
        };
        let completion = run_single_shot(
            &fast_opts(),
            &test_config("partial"),
            sender(server.url.clone(), Arc::default()),
            Some(&mut callback),
        )
        .await
        .unwrap();
        assert!(completion.interrupted.is_some());
        assert_eq!(completion.content, "[{\"q\":1},");
        assert_eq!(seen, "[{\"q\":1},");
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_drops_the_stream_promptly() {
        let server = spawn_server(Arc::new(|_, _| {
            paced_sse_response(Vec::new(), Duration::from_millis(10), true)
        }));
        let token = CancellationToken::new();
        let opts = fast_opts()
            .with_timeouts(
                Duration::from_secs(5),
                Duration::from_secs(5),
                Duration::from_secs(10),
            )
            .with_cancel(token.clone());
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel.cancel();
        });
        let started = std::time::Instant::now();
        let error = run_single_shot(
            &opts,
            &test_config("cancel"),
            sender(server.url.clone(), Arc::default()),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("取消"), "{}", error.message);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn retryable_status_policy() {
        for status in [408, 429, 500, 502, 503, 504, 520, 522, 524, 529] {
            assert!(is_retryable_http_status(status), "{status}");
        }
        for status in [400, 401, 403, 404, 413, 422, 501, 505] {
            assert!(!is_retryable_http_status(status), "{status}");
        }
        assert!(body_rejects_streaming(
            400,
            "Unsupported parameter: 'stream'"
        ));
        assert!(!body_rejects_streaming(400, "max_tokens too large"));
        assert!(!body_rejects_streaming(500, "stream failed"));
    }
}
