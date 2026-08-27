//! LLM 使用量统计模块
//!
//! 提供独立的 `llm_usage.db` 数据库，记录所有 LLM 调用的 token 使用统计。

pub mod collector;
pub mod database;
pub mod handlers;
pub mod repo;
pub mod types;

pub use collector::UsageCollector;
pub use database::{LlmUsageDatabase, LlmUsageError, LlmUsageResult, LLM_USAGE_SCHEMA_VERSION};
pub use types::*;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

type PendingUsageRecord = UsageRecord;

const MAX_PENDING_USAGE_RECORDS: usize = 1000;

fn pending_usage_queue() -> &'static Mutex<VecDeque<PendingUsageRecord>> {
    static QUEUE: OnceLock<Mutex<VecDeque<PendingUsageRecord>>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn enqueue_pending(record: PendingUsageRecord) {
    let queue = pending_usage_queue();
    let mut guard = queue.lock().unwrap_or_else(|poisoned| {
        log::error!("[LLM Usage] Pending queue mutex poisoned! Attempting recovery");
        poisoned.into_inner()
    });

    if guard.len() >= MAX_PENDING_USAGE_RECORDS {
        guard.pop_front();
        log::warn!(
            "[LLM Usage] Pending queue full ({}), dropping oldest usage record",
            MAX_PENDING_USAGE_RECORDS
        );
    }
    guard.push_back(record);
}

fn flush_pending(collector: &Arc<UsageCollector>) -> usize {
    let drained: Vec<PendingUsageRecord> = {
        let queue = pending_usage_queue();
        let mut guard = queue.lock().unwrap_or_else(|poisoned| {
            log::error!("[LLM Usage] Pending queue mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        guard.drain(..).collect()
    };

    for record in &drained {
        collector.record(record.clone());
    }

    drained.len()
}

pub fn record_usage_record(record: UsageRecord) {
    match crate::get_global_app_handle() {
        Some(app_handle) => match app_handle.try_state::<Arc<UsageCollector>>() {
            Some(collector) => {
                let flushed = flush_pending(&collector);
                if flushed > 0 {
                    log::info!(
                        "[LLM Usage] Flushed {} pending usage records before writing current record",
                        flushed
                    );
                }

                collector.record(record);
                log::debug!("[LLM Usage] 使用量记录成功");
            }
            None => {
                let model_id = record.model_id.clone();
                let prompt_tokens = record.prompt_tokens;
                let completion_tokens = record.completion_tokens;
                enqueue_pending(record);
                log::warn!(
                    "[LLM Usage] UsageCollector 未初始化，已缓存记录: model={}, tokens={}+{}",
                    model_id,
                    prompt_tokens,
                    completion_tokens
                );
            }
        },
        None => {
            let model_id = record.model_id.clone();
            let prompt_tokens = record.prompt_tokens;
            let completion_tokens = record.completion_tokens;
            enqueue_pending(record);
            log::warn!(
                "[LLM Usage] app_handle 不可用，已缓存记录: model={}, tokens={}+{}",
                model_id,
                prompt_tokens,
                completion_tokens
            );
        }
    }
}

/// 记录 LLM 使用量到数据库
///
/// 此函数是 LLM 使用量记录的统一入口，所有 LLM 调用都应通过此函数记录使用量。
/// 当 app_handle 或 UsageCollector 暂不可用时，先写入内存缓冲队列，并在后续可用时自动冲刷，避免静默丢失。
pub fn record_llm_usage(
    caller_type: CallerType,
    model_id: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
    reasoning_tokens: Option<u32>,
    cached_tokens: Option<u32>,
    session_id: Option<String>,
    duration_ms: Option<u64>,
    success: bool,
    error_message: Option<String>,
) {
    record_llm_usage_ext(
        caller_type,
        model_id,
        prompt_tokens,
        completion_tokens,
        reasoning_tokens,
        cached_tokens,
        session_id,
        duration_ms,
        success,
        error_message,
        None,
        None,
    );
}

/// 记录 LLM 使用量（扩展版）：额外携带适配器/协议与 token 来源
///
/// - `adapter`: 生效的协议/适配器（如 openai_chat_completions / openai_responses /
///   anthropic_messages / google_generate_content），缺省落库 NULL；
/// - `token_source`: token 数据来源（对齐 `chat_v2::types::TokenSource` 的字符串：
///   api / tiktoken / heuristic / mixed），缺省落库 schema 默认 "api"。
///
/// 不携带缓存写入量（落库 NULL = 无测量）；能拿到 `cache_write_tokens` 的
/// 调用方请使用 [`record_llm_usage_cache_ext`]。
#[allow(clippy::too_many_arguments)]
pub fn record_llm_usage_ext(
    caller_type: CallerType,
    model_id: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
    reasoning_tokens: Option<u32>,
    cached_tokens: Option<u32>,
    session_id: Option<String>,
    duration_ms: Option<u64>,
    success: bool,
    error_message: Option<String>,
    adapter: Option<String>,
    token_source: Option<String>,
) {
    record_llm_usage_cache_ext(
        caller_type,
        model_id,
        prompt_tokens,
        completion_tokens,
        reasoning_tokens,
        cached_tokens,
        None,
        session_id,
        duration_ms,
        success,
        error_message,
        adapter,
        token_source,
    );
}

/// 记录 LLM 使用量（缓存遥测全量版）：在扩展版之上再携带缓存写入量
///
/// - `cache_write_tokens`: 缓存写入 Token（Anthropic `cache_creation_input_tokens`、
///   OpenAI/DeepSeek Responses `input_tokens_details.cache_write_tokens`）。
///   None 落库 NULL = 无测量，不等于 0；报表据此计算缓存 write/read 比。
///
/// 只携带 session 维度；能解析出 variant / run 维度的调用方（model2 流式
/// 路径）请使用 [`record_llm_usage_cache_ext_with_identity`]。
#[allow(clippy::too_many_arguments)]
pub fn record_llm_usage_cache_ext(
    caller_type: CallerType,
    model_id: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
    reasoning_tokens: Option<u32>,
    cached_tokens: Option<u32>,
    cache_write_tokens: Option<u32>,
    session_id: Option<String>,
    duration_ms: Option<u64>,
    success: bool,
    error_message: Option<String>,
    adapter: Option<String>,
    token_source: Option<String>,
) {
    record_llm_usage_cache_ext_with_identity(
        caller_type,
        model_id,
        prompt_tokens,
        completion_tokens,
        reasoning_tokens,
        cached_tokens,
        cache_write_tokens,
        UsageStreamIdentity {
            session_id,
            variant_id: None,
            run_id: None,
        },
        duration_ms,
        success,
        error_message,
        adapter,
        token_source,
    );
}

/// Chat V2 流式遥测身份（分列 session / variant / run）
///
/// 第 5 轮修复：model2 流式路径此前把 run-scoped `stream_event`
/// （`chat_v2_event_{session}_var_{scope}_run_{run}[__stream_generation__{n}]`）
/// 整体当 session_id 落库，跨轮 steady-state 缓存统计把每次执行都当成
/// 独立会话。分列后：
/// - `session_id`: 真实会话 ID（落库 `session_id` 既有列）；
/// - `variant_id`: 多变体/流作用域 ID（新列，NULL = 未知）；
/// - `run_id`: 单次 pipeline 执行的 run key（新列，NULL = 未知）。
#[derive(Debug, Clone, Default)]
pub struct UsageStreamIdentity {
    /// 真实会话 ID；非 chat_v2 流可回退为调用方自定义标识
    pub session_id: Option<String>,
    /// 多变体/流作用域 ID（stream_event 的 `_var_` 段）
    pub variant_id: Option<String>,
    /// 单次 pipeline 执行的 run key（stream_event 的 `_run_` 段）
    pub run_id: Option<String>,
}

/// 记录 LLM 使用量（缓存遥测全量版 + 分列遥测身份）
///
/// 与 [`record_llm_usage_cache_ext`] 等价，但以 [`UsageStreamIdentity`]
/// 携带 session / variant / run 三列身份，避免把 run-scoped 事件名
/// 误当会话 ID。
#[allow(clippy::too_many_arguments)]
pub fn record_llm_usage_cache_ext_with_identity(
    caller_type: CallerType,
    model_id: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
    reasoning_tokens: Option<u32>,
    cached_tokens: Option<u32>,
    cache_write_tokens: Option<u32>,
    identity: UsageStreamIdentity,
    duration_ms: Option<u64>,
    success: bool,
    error_message: Option<String>,
    adapter: Option<String>,
    token_source: Option<String>,
) {
    log::debug!(
        "[LLM Usage] 记录使用量: model={}, prompt={}, completion={}, reasoning={:?}, cached={:?}, cache_write={:?}, success={}, adapter={:?}, token_source={:?}, session={:?}, variant={:?}, run={:?}",
        model_id,
        prompt_tokens,
        completion_tokens,
        reasoning_tokens,
        cached_tokens,
        cache_write_tokens,
        success,
        adapter,
        token_source,
        identity.session_id,
        identity.variant_id,
        identity.run_id
    );

    let mut record = UsageRecord::new(
        caller_type,
        model_id.to_string(),
        prompt_tokens,
        completion_tokens,
    );

    if let Some(tokens) = reasoning_tokens {
        record = record.with_reasoning_tokens(tokens);
    }
    if let Some(tokens) = cached_tokens {
        record = record.with_cached_tokens(tokens);
    }
    if let Some(tokens) = cache_write_tokens {
        record = record.with_cache_write_tokens(tokens);
    }
    if let Some(sid) = identity.session_id {
        record = record.with_caller_id(sid);
    }
    if let Some(variant) = identity.variant_id {
        record = record.with_variant_id(variant);
    }
    if let Some(run) = identity.run_id {
        record = record.with_run_id(run);
    }
    if let Some(duration) = duration_ms {
        record = record.with_duration(duration);
    }
    if let Some(adapter) = adapter {
        record = record.with_adapter(adapter);
    }
    if let Some(source) = token_source {
        record = record.with_token_source(source);
    }
    if !success {
        record = record.with_error(error_message.unwrap_or_else(|| "Unknown error".to_string()));
    }

    record_usage_record(record);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_queue_is_bounded() {
        let queue = pending_usage_queue();
        queue
            .lock()
            .unwrap_or_else(|p| {
                log::error!("[LLM Usage] Test: pending queue mutex poisoned! Recovering");
                p.into_inner()
            })
            .clear();

        for i in 0..(MAX_PENDING_USAGE_RECORDS + 10) {
            enqueue_pending(PendingUsageRecord {
                id: UsageRecord::generate_id(),
                caller_type: CallerType::ChatV2,
                caller_id: None,
                variant_id: None,
                run_id: None,
                model_id: format!("m-{}", i),
                config_id: None,
                provider_id: None,
                adapter: None,
                token_source: None,
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
                reasoning_tokens: None,
                cached_tokens: None,
                cache_write_tokens: None,
                estimated_cost_usd: None,
                duration_ms: None,
                success: true,
                error_message: None,
                created_at: chrono::Utc::now(),
            });
        }

        let guard = queue.lock().unwrap_or_else(|p| {
            log::error!("[LLM Usage] Test: pending queue mutex poisoned! Recovering");
            p.into_inner()
        });
        assert_eq!(guard.len(), MAX_PENDING_USAGE_RECORDS);
        assert_eq!(guard.front().map(|r| r.model_id.as_str()), Some("m-10"));
    }
}
