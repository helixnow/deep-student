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

#[derive(Debug, Clone)]
struct PendingUsageRecord {
    caller_type: CallerType,
    model_id: String,
    prompt_tokens: u32,
    completion_tokens: u32,
    reasoning_tokens: Option<u32>,
    cached_tokens: Option<u32>,
    session_id: Option<String>,
    duration_ms: Option<u64>,
    success: bool,
    error_message: Option<String>,
}

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
        collector.record_from_api_response_extended(
            record.caller_type.clone(),
            &record.model_id,
            record.prompt_tokens,
            record.completion_tokens,
            record.reasoning_tokens,
            record.cached_tokens,
            record.session_id.clone(),
            None,
            record.duration_ms,
            None,
            record.success,
            record.error_message.clone(),
        );
    }

    drained.len()
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

    let record = PendingUsageRecord {
        caller_type,
        model_id: model_id.to_string(),
        prompt_tokens,
        completion_tokens,
        reasoning_tokens,
        cached_tokens,
        session_id,
        duration_ms,
        success,
        error_message,
    };

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

                collector.record_from_api_response_extended(
                    record.caller_type,
                    &record.model_id,
                    record.prompt_tokens,
                    record.completion_tokens,
                    record.reasoning_tokens,
                    record.cached_tokens,
                    record.session_id,
                    None,
                    record.duration_ms,
                    None,
                    record.success,
                    record.error_message,
                );
                log::debug!("[LLM Usage] 使用量记录成功");
            }
            None => {
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
                caller_type: CallerType::ChatV2,
                model_id: format!("m-{}", i),
                prompt_tokens: 1,
                completion_tokens: 1,
                reasoning_tokens: None,
                cached_tokens: None,
                session_id: None,
                duration_ms: None,
                success: true,
                error_message: None,
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
