//! 启动完成闸门（startup readiness gate）。
//!
//! 背景（2026-09，Android "startup_preflight blocked" 排查）：
//! Tauri 在 `RunEvent::Ready` 时**先创建 config 窗口、再执行应用的 setup 闭包**
//! （tauri-2.x `app.rs` 内部 `setup()` 的顺序），因此 WebView 加载前端与 setup
//! 闭包是并发的。且非 async 命令由宏生成为在调用线程内联执行：
//! - 桌面端（Win/macOS/Linux/iOS）：IPC 投递到主线程/事件循环，命令排队等 setup
//!   结束——setup 超过前端 15s 超时会误报 `startup_preflight / blocked`；
//! - Android：IPC 经 `@JavascriptInterface` JNI 在 WebView JavaBridge 后台线程
//!   执行，命令在 setup 半途就会运行——可能因 `State` 尚未 `manage()` 立即报错
//!   （秒出 blocked 屏，改超时无效），或读到默认全 healthy 的组件健康状态
//!   （假绿灯，前端在后端初始化完成前就启动整个 App）。
//!
//! 修复：setup 闭包退出（含恢复模式等所有提前返回路径）时通过 [`StartupReadyGuard`]
//! 标记就绪；启动链路的预检命令先 [`wait_startup_ready`] 有界等待，再读取状态。
//! 闸门是全局静态而非 Tauri State——等待本身可能发生在 `manage()` 之前。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

/// 预检命令等待 setup 完成的上限。超过即判定 setup 卡死，命令报错、前端 fail-closed。
/// 取值依据：真机实测慢启动（首装/升级迁移）量级为数十秒；120s 作为兜底上限。
pub const STARTUP_READY_WAIT: Duration = Duration::from_secs(120);

static READY: AtomicBool = AtomicBool::new(false);
static READY_TX: OnceLock<tokio::sync::watch::Sender<bool>> = OnceLock::new();

fn ready_tx() -> &'static tokio::sync::watch::Sender<bool> {
    READY_TX.get_or_init(|| tokio::sync::watch::channel(false).0)
}

/// 标记 setup 已完成。幂等；watch channel 会保留最新值，
/// 之后订阅的等待者也能立即看到就绪状态。
pub fn mark_startup_ready() {
    READY.store(true, Ordering::Release);
    let _ = ready_tx().send(true);
}

/// setup 是否已完成（同步快路径）。
pub fn is_startup_ready() -> bool {
    READY.load(Ordering::Acquire)
}

/// 有界等待 setup 完成；超时返回 `false`。
pub async fn wait_startup_ready(timeout: Duration) -> bool {
    if is_startup_ready() {
        return true;
    }
    let mut rx = ready_tx().subscribe();
    tokio::time::timeout(timeout, async move {
        loop {
            if *rx.borrow_and_update() {
                break;
            }
            // sender 是静态的、永不 drop；changed() 出错仅可能是通道关闭，
            // 此时退出循环由外层 timeout/标志位兜底。
            if rx.changed().await.is_err() {
                break;
            }
        }
    })
    .await
    .is_ok()
        && is_startup_ready()
}

/// setup 闭包守卫：作用域结束（含所有提前 `return` 与 Err/panic 展开）时自动
/// 标记就绪。注意：setup 返回 Err 时 Tauri 会 panic 终止进程，此时标记无害；
/// 恢复模式等提前返回路径上，相关状态均已最终化，标记是正确语义。
pub struct StartupReadyGuard;

impl StartupReadyGuard {
    pub fn new() -> Self {
        Self
    }
}

impl Default for StartupReadyGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for StartupReadyGuard {
    fn drop(&mut self) {
        mark_startup_ready();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 注意：闸门是进程级全局状态，本模块测试只能依赖"未就绪→就绪"的单向迁移，
    // 且不能断言全局初始状态（其他测试可能已标记）。因此超时路径用独立短超时验证
    // "未标记时等待会超时"这一性质需放在标记之前——用串行顺序写在一个用例里。

    #[tokio::test]
    async fn wait_times_out_when_never_marked_then_succeeds_after_mark() {
        // 全局状态可能已被其他用例标记；若已就绪则本用例无意义，直接通过。
        if is_startup_ready() {
            return;
        }
        // 未标记：短超时等待应返回 false
        assert!(!wait_startup_ready(Duration::from_millis(50)).await);

        // 标记后：等待应立即成功
        mark_startup_ready();
        assert!(is_startup_ready());
        assert!(wait_startup_ready(Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn guard_marks_ready_on_drop() {
        {
            let _guard = StartupReadyGuard::new();
        } // guard drop → mark_startup_ready()
        assert!(is_startup_ready());
        assert!(wait_startup_ready(Duration::from_millis(10)).await);
    }

    #[tokio::test]
    async fn late_subscriber_sees_ready_immediately() {
        mark_startup_ready();
        // 模拟 setup 完成后才到达的命令：无需等待立即通过
        assert!(wait_startup_ready(Duration::from_millis(10)).await);
    }
}
