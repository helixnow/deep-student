//! 全局后台任务追踪器
//!
//! 解决 Audit 2 R-2.6 的问题：
//! 此前多处 `tokio::spawn` 没有持有 JoinHandle，导致应用关闭时这些任务被静默
//! 取消，可能让向量索引清理或画像刷新等"尽力而为"任务残留半完成状态。
//!
//! 该模块导出一个全局 `TaskTracker`，所有"fire-and-forget"风格的后台任务都
//! 应使用 [`BACKGROUND_TASKS`] 注册：
//!
//! ```ignore
//! crate::background_tasks::BACKGROUND_TASKS.spawn(async move {
//!     // ... 后台清理逻辑 ...
//! });
//! ```
//!
//! 在应用退出前调用 [`shutdown`]，最长等待 5 秒让在途任务完成；超时则放弃。

use std::sync::LazyLock;
use std::time::Duration;
use tokio_util::task::TaskTracker;

/// 全局后台任务追踪器。
///
/// 任何"无人 await"的 `tokio::spawn` 都应改用 `BACKGROUND_TASKS.spawn(...)`，
/// 让应用关闭时能感知这些任务并优雅等待。
pub static BACKGROUND_TASKS: LazyLock<TaskTracker> = LazyLock::new(TaskTracker::new);

/// 应用退出时的最长等待时间。
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// 关闭追踪器并等待已注册的任务完成，最多等待 [`SHUTDOWN_TIMEOUT`]。
///
/// - `close()` 之后追踪器不再接受新任务，但已注册任务仍会运行。
/// - `wait()` 在所有任务完成后返回；用 `tokio::time::timeout` 包一层避免无限阻塞。
///
/// 这是一个 best-effort 收尾：超时后未完成的任务会随进程退出被取消。
pub async fn shutdown() {
    BACKGROUND_TASKS.close();
    let pending = BACKGROUND_TASKS.len();
    if pending == 0 {
        return;
    }
    log::info!(
        "[background_tasks] shutdown: waiting up to {:?} for {} pending task(s)",
        SHUTDOWN_TIMEOUT,
        pending
    );
    match tokio::time::timeout(SHUTDOWN_TIMEOUT, BACKGROUND_TASKS.wait()).await {
        Ok(()) => log::info!("[background_tasks] shutdown: all background tasks finished"),
        Err(_) => log::warn!(
            "[background_tasks] shutdown: timed out after {:?}, {} task(s) may still be running",
            SHUTDOWN_TIMEOUT,
            BACKGROUND_TASKS.len()
        ),
    }
}
