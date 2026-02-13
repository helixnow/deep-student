//! Chat V2 全局状态管理
//!
//! 管理活跃的流式会话，支持取消操作。
//! 🆕 P1修复：添加 TaskTracker 追踪异步任务，确保优雅关闭。

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

/// Chat V2 全局状态（注册到 Tauri AppState）
///
/// 用于管理活跃的流式会话，支持取消正在进行的流式生成。
///
/// ## 使用示例
/// ```ignore
/// // 在 lib.rs 中注册
/// .manage(ChatV2State::new())
///
/// // 在命令中使用
/// let cancel_token = state.register_stream(&session_id);
///
/// // 取消流式生成
/// state.cancel_stream(&session_id);
/// ```
pub struct ChatV2State {
    /// 活跃的流式会话：session_id -> CancellationToken
    pub active_streams: Mutex<HashMap<String, CancellationToken>>,
    /// 🆕 P1修复：任务追踪器，用于追踪所有 tokio::spawn 的任务
    /// 确保任务在应用关闭时能被正确清理
    task_tracker: TaskTracker,
}

impl ChatV2State {
    /// 创建新的 Chat V2 状态实例
    pub fn new() -> Self {
        Self {
            active_streams: Mutex::new(HashMap::new()),
            task_tracker: TaskTracker::new(),
        }
    }

    /// 🆕 P1修复：创建被追踪的异步任务
    ///
    /// 使用 TaskTracker 追踪任务，确保任务在关闭时能被正确清理。
    /// 替代直接使用 `tokio::spawn`。
    ///
    /// # Arguments
    /// * `future` - 要执行的 Future
    ///
    /// # Returns
    /// 返回 JoinHandle，可用于等待任务完成
    pub fn spawn_tracked<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.task_tracker.spawn(future)
    }

    /// 🆕 P1修复：获取当前追踪的任务数量
    pub fn tracked_task_count(&self) -> usize {
        self.task_tracker.len()
    }

    /// 🆕 P1修复：关闭任务追踪器，不再接受新任务
    pub fn close_task_tracker(&self) {
        self.task_tracker.close();
        log::info!("[ChatV2::state] Task tracker closed, no new tasks will be accepted");
    }

    /// 🆕 P1修复：等待所有追踪的任务完成
    ///
    /// 在应用关闭时调用，确保所有任务完成或超时。
    ///
    /// # Arguments
    /// * `timeout` - 最大等待时间
    ///
    /// # Returns
    /// - `true`: 所有任务在超时前完成
    /// - `false`: 超时，部分任务可能仍在运行
    pub async fn shutdown_tasks(&self, timeout: Duration) -> bool {
        self.task_tracker.close();
        let task_count = self.task_tracker.len();

        if task_count == 0 {
            log::info!("[ChatV2::state] No tracked tasks to wait for");
            return true;
        }

        log::info!(
            "[ChatV2::state] Waiting for {} tracked tasks to complete (timeout: {:?})",
            task_count,
            timeout
        );

        match tokio::time::timeout(timeout, self.task_tracker.wait()).await {
            Ok(()) => {
                log::info!("[ChatV2::state] All tracked tasks completed successfully");
                true
            }
            Err(_) => {
                log::warn!(
                    "[ChatV2::state] Timeout waiting for tasks, {} tasks may still be running",
                    self.task_tracker.len()
                );
                false
            }
        }
    }

    /// 注册新的流式会话
    ///
    /// 返回一个 CancellationToken，可用于：
    /// - 在流水线各阶段检查是否被取消：`token.is_cancelled()`
    /// - 在异步操作中等待取消：`token.cancelled().await`
    ///
    /// # Arguments
    /// * `session_id` - 会话 ID
    ///
    /// # Returns
    /// 返回该会话的 CancellationToken
    pub fn register_stream(&self, session_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        // 🔧 P0修复：使用 lock().unwrap_or_else() 处理 mutex poisoning
        // 如果 mutex 被 poison，获取内部数据并继续（数据可能不一致但不会 panic）
        let mut guard = self.active_streams.lock().unwrap_or_else(|poisoned| {
            log::error!(
                "[ChatV2::state] Mutex poisoned during register_stream! Attempting recovery"
            );
            poisoned.into_inner()
        });
        guard.insert(session_id.to_string(), token.clone());
        log::info!(
            "[ChatV2::state] Registered stream for session: {}",
            session_id
        );
        token
    }

    /// 取消流式会话
    ///
    /// 触发 CancellationToken 的取消信号，通知流水线停止处理。
    ///
    /// # Arguments
    /// * `session_id` - 会话 ID
    ///
    /// # Returns
    /// - `true`: 成功取消
    /// - `false`: 会话不存在或已完成
    pub fn cancel_stream(&self, session_id: &str) -> bool {
        let mut guard = self.active_streams.lock().unwrap_or_else(|poisoned| {
            log::error!("[ChatV2::state] Mutex poisoned during cancel_stream! Attempting recovery");
            poisoned.into_inner()
        });
        if let Some(token) = guard.remove(session_id) {
            token.cancel();
            log::info!(
                "[ChatV2::state] Cancelled stream for session: {}",
                session_id
            );
            true
        } else {
            log::warn!(
                "[ChatV2::state] No active stream found for session: {}",
                session_id
            );
            false
        }
    }

    /// 移除流式会话（完成或出错后调用）
    ///
    /// 清理资源，不触发取消信号。
    ///
    /// # Arguments
    /// * `session_id` - 会话 ID
    pub fn remove_stream(&self, session_id: &str) {
        let mut guard = self.active_streams.lock().unwrap_or_else(|poisoned| {
            log::error!("[ChatV2::state] Mutex poisoned during remove_stream! Attempting recovery");
            poisoned.into_inner()
        });
        guard.remove(session_id);
        log::debug!("[ChatV2::state] Removed stream for session: {}", session_id);
    }

    /// 检查会话是否有活跃的流式生成
    ///
    /// # Arguments
    /// * `session_id` - 会话 ID
    ///
    /// # Returns
    /// - `true`: 有活跃的流式生成
    /// - `false`: 无活跃的流式生成
    pub fn has_active_stream(&self, session_id: &str) -> bool {
        let guard = self.active_streams.lock().unwrap_or_else(|poisoned| {
            log::error!(
                "[ChatV2::state] Mutex poisoned during has_active_stream! Attempting recovery"
            );
            poisoned.into_inner()
        });
        guard.contains_key(session_id)
    }

    /// 获取活跃流式会话数量
    pub fn active_stream_count(&self) -> usize {
        let guard = self.active_streams.lock().unwrap_or_else(|poisoned| {
            log::error!(
                "[ChatV2::state] Mutex poisoned during active_stream_count! Attempting recovery"
            );
            poisoned.into_inner()
        });
        guard.len()
    }

    /// 原子地尝试注册流式会话（P0 竞态条件修复）
    ///
    /// 在同一个锁内检查是否已存在流并注册新流，避免并发请求同时通过检查。
    ///
    /// # Returns
    /// - `Ok(CancellationToken)`: 注册成功
    /// - `Err(())`: 会话已有活跃流
    pub fn try_register_stream(&self, session_id: &str) -> Result<CancellationToken, ()> {
        let mut guard = self.active_streams.lock().unwrap_or_else(|poisoned| {
            log::error!(
                "[ChatV2::state] Mutex poisoned during try_register_stream! Attempting recovery"
            );
            poisoned.into_inner()
        });

        if guard.contains_key(session_id) {
            log::warn!(
                "[ChatV2::state] Session {} already has active stream, rejecting",
                session_id
            );
            return Err(());
        }

        let token = CancellationToken::new();
        guard.insert(session_id.to_string(), token.clone());
        log::info!(
            "[ChatV2::state] Registered stream for session: {}",
            session_id
        );
        Ok(token)
    }

    // 🔧 P1修复：为多变体模式添加注册已存在 token 的方法
    /// 注册已存在的 CancellationToken（用于多变体模式的 child token）
    ///
    /// 在多变体模式下，每个变体有自己的 child token，需要用 `session_id:variant_id` 作为 key 注册
    /// 这样可以精确取消单个变体，而不是取消整个会话
    ///
    /// # Arguments
    /// * `key` - 注册键（格式：`session_id:variant_id`）
    /// * `token` - 已存在的 CancellationToken（通常是 child_token）
    pub fn register_existing_token(&self, key: &str, token: CancellationToken) {
        let mut guard = self.active_streams.lock().unwrap_or_else(|poisoned| {
            log::error!("[ChatV2::state] Mutex poisoned during register_existing_token! Attempting recovery");
            poisoned.into_inner()
        });
        guard.insert(key.to_string(), token);
        log::debug!("[ChatV2::state] Registered existing token for key: {}", key);
    }
}

impl Default for ChatV2State {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII guard that ensures `remove_stream` is called when dropped.
///
/// 防止 spawned future 发生 panic 时 `remove_stream` 永远不被调用，
/// 导致会话永久锁定（session permanently locked）。
///
/// ## 使用方式
/// 在 `spawn_tracked` 的 async block 开头创建 guard，
/// 当 block 正常完成、被取消或 panic 时，guard 的 Drop 都会触发 `remove_stream`。
///
/// ```ignore
/// chat_v2_state.spawn_tracked(async move {
///     let _guard = StreamGuard::new(state_clone.clone(), session_id.clone());
///     // ... 业务逻辑 ...
///     // remove_stream 由 _guard 自动调用，无需手动清理
/// });
/// ```
pub struct StreamGuard {
    state: Arc<ChatV2State>,
    session_id: String,
}

impl StreamGuard {
    /// 创建新的 StreamGuard
    ///
    /// # Arguments
    /// * `state` - ChatV2State 的 Arc 引用
    /// * `session_id` - 需要在 drop 时清理的会话 ID
    pub fn new(state: Arc<ChatV2State>, session_id: String) -> Self {
        Self { state, session_id }
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.state.remove_stream(&self.session_id);
        // 判断是否因 panic 触发的 drop（用于日志分级）
        if std::thread::panicking() {
            log::error!(
                "[ChatV2::StreamGuard] Panic detected! Auto-cleaned stream for session: {} (panic guard triggered)",
                self.session_id
            );
        } else {
            log::debug!(
                "[ChatV2::StreamGuard] Auto-cleaned stream for session: {}",
                self.session_id
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_and_cancel_stream() {
        let state = ChatV2State::new();

        // 注册流式会话
        let token = state.register_stream("sess_123");
        assert!(!token.is_cancelled());
        assert!(state.has_active_stream("sess_123"));

        // 取消流式会话
        let cancelled = state.cancel_stream("sess_123");
        assert!(cancelled);
        assert!(token.is_cancelled());
        assert!(!state.has_active_stream("sess_123"));
    }

    #[test]
    fn test_cancel_nonexistent_stream() {
        let state = ChatV2State::new();

        // 取消不存在的会话
        let cancelled = state.cancel_stream("sess_nonexistent");
        assert!(!cancelled);
    }

    #[test]
    fn test_remove_stream() {
        let state = ChatV2State::new();

        // 注册并移除
        let token = state.register_stream("sess_456");
        state.remove_stream("sess_456");

        // 移除后 token 不应被取消
        assert!(!token.is_cancelled());
        assert!(!state.has_active_stream("sess_456"));
    }

    #[test]
    fn test_active_stream_count() {
        let state = ChatV2State::new();

        assert_eq!(state.active_stream_count(), 0);

        state.register_stream("sess_1");
        assert_eq!(state.active_stream_count(), 1);

        state.register_stream("sess_2");
        assert_eq!(state.active_stream_count(), 2);

        state.cancel_stream("sess_1");
        assert_eq!(state.active_stream_count(), 1);

        state.remove_stream("sess_2");
        assert_eq!(state.active_stream_count(), 0);
    }

    #[test]
    fn test_try_register_stream_success() {
        let state = ChatV2State::new();

        let result = state.try_register_stream("sess_atomic");
        assert!(result.is_ok());
        assert!(state.has_active_stream("sess_atomic"));
    }

    #[test]
    fn test_try_register_stream_reject_duplicate() {
        let state = ChatV2State::new();

        let first = state.try_register_stream("sess_dup");
        assert!(first.is_ok());

        let second = state.try_register_stream("sess_dup");
        assert!(second.is_err());
    }

    #[test]
    fn test_stream_guard_cleanup_on_normal_drop() {
        let state = Arc::new(ChatV2State::new());
        state.register_stream("sess_guard_1");
        assert!(state.has_active_stream("sess_guard_1"));

        // Guard 在作用域结束时自动调用 remove_stream
        {
            let _guard = StreamGuard::new(Arc::clone(&state), "sess_guard_1".to_string());
        }

        // Guard drop 后，流应该被清理
        assert!(!state.has_active_stream("sess_guard_1"));
    }

    #[test]
    fn test_stream_guard_idempotent_double_cleanup() {
        let state = Arc::new(ChatV2State::new());
        state.register_stream("sess_guard_2");

        {
            let _guard = StreamGuard::new(Arc::clone(&state), "sess_guard_2".to_string());
            // 手动调用 remove_stream（模拟旧代码路径）
            state.remove_stream("sess_guard_2");
            assert!(!state.has_active_stream("sess_guard_2"));
        }
        // Guard drop 时再次调用 remove_stream，应该是无害的幂等操作
        assert!(!state.has_active_stream("sess_guard_2"));
    }

    #[test]
    fn test_stream_guard_cleanup_on_panic() {
        let state = Arc::new(ChatV2State::new());
        state.register_stream("sess_guard_panic");
        assert!(state.has_active_stream("sess_guard_panic"));

        // 模拟 panic 场景：catch_unwind 捕获 panic，guard 的 Drop 仍然执行
        let state_clone = Arc::clone(&state);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = StreamGuard::new(state_clone, "sess_guard_panic".to_string());
            panic!("simulated panic inside spawned task");
        }));

        assert!(result.is_err(), "Should have caught a panic");
        // 关键断言：即使发生 panic，guard 的 Drop 也清理了流
        assert!(
            !state.has_active_stream("sess_guard_panic"),
            "Stream should be cleaned up even after panic"
        );
    }
}
