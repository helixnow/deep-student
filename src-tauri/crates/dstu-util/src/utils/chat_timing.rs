use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::{Mutex, MutexGuard};

/// 聊天流事件级别的计时注册表
///
/// Key 使用 stream_event（例如 `chat_stream_{id}` / `summary_stream_{id}`），
/// Value 为“发送消息”时间（统一从服务端视角的用户消息时间戳推导）。
static STREAM_TIMINGS: LazyLock<Mutex<HashMap<String, DateTime<Utc>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_registry(label: &str) -> MutexGuard<'static, HashMap<String, DateTime<Utc>>> {
    match STREAM_TIMINGS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::error!(
                "[ChatTiming] Registry mutex poisoned ({})! Attempting recovery",
                label
            );
            poisoned.into_inner()
        }
    }
}

/// 在开始分析时注册某个事件通道的“起点时间”（应尽量贴近用户发送消息时间）。
pub fn set_stream_start(stream_event: &str, sent_at: DateTime<Utc>) {
    let mut registry = lock_registry("set_stream_start");
    registry.insert(stream_event.to_string(), sent_at);
}

/// 在流式会话完全结束（或发生致命错误）后清理该事件通道的计时信息，避免内存泄漏。
pub fn clear_stream_start(stream_event: &str) {
    let mut registry = lock_registry("clear_stream_start");
    registry.remove(stream_event);
}

/// 返回自起点以来的毫秒数；若尚未注册起点则返回 None。
pub fn elapsed_ms_since_start(stream_event: &str) -> Option<i64> {
    let registry = lock_registry("elapsed_ms_since_start");
    registry.get(stream_event).map(|start| {
        let now = Utc::now();
        let delta = now.signed_duration_since(*start);
        delta.num_milliseconds()
    })
}

/// 生成统一的日志前缀，例如 "[+123ms] "；若没有起点信息则返回空字符串。
pub fn format_elapsed_prefix(stream_event: &str) -> String {
    match elapsed_ms_since_start(stream_event) {
        Some(ms) if ms >= 0 => format!("[+{}ms] ", ms),
        Some(ms) => format!("[{}ms] ", ms),
        None => String::new(),
    }
}
