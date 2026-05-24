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
    log::debug!(
        "[LLM Usage] 记录使用量: model={}, prompt={}, completion={}, reasoning={:?}, success={}",
        model_id,
        prompt_tokens,
        completion_tokens,
        reasoning_tokens,
        success
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
    if let Some(sid) = session_id {
        record = record.with_caller_id(sid);
    }
    if let Some(duration) = duration_ms {
        record = record.with_duration(duration);
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
                model_id: format!("m-{}", i),
                config_id: None,
                provider_id: None,
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
                reasoning_tokens: None,
                cached_tokens: None,
                estimated_cost_usd: None,
                duration_ms: None,
                success: true,
                error_message: None,
                created_at: chrono::Utc::now(),
                workspace_id: None,
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
