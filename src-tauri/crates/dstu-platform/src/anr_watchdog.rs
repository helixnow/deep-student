//! 异步运行时看门狗（原名 "ANR 看门狗"）
//!
//! ⚠️ 监控对象说明（审阅 19 P2-1 / 34 P2-6 修正，2026-07-08）：
//! 心跳由 tauri::async_runtime（tokio 多线程 runtime）上的定时任务驱动，
//! 因此本看门狗检测的是 **tokio 异步运行时饥饿/饿死**（例如所有 worker
//! 被同步 IO / 全局数据库锁占满，导致任何 invoke 命令都无法调度），
//! 而 **不是** UI/事件循环主线程卡死——主线程真死锁时 tokio 心跳照常跳动，
//! 本看门狗不会告警。真正的主线程 ANR 检测需要从主线程发心跳
//! （如 `run_on_main_thread` 定期打点），成本与收益见
//! docs/reviews/fable5-audit-2026-07-08/fixes/S10-platform-build-test.md。
//!
//! 在所有平台启用：桌面端 OS 的 hang 检测仅对 Win32 消息循环有效，
//! 无法检测 Tauri 后端异步运行时的阻塞。
//!
//! ## 原理
//! 1. 后台线程每 2.5 秒检查心跳时间戳
//! 2. 由 Tauri setup 阶段在 async runtime 上启动定时器定期调用 heartbeat()
//! 3. 如果 heartbeat 超过阈值（10 秒）未更新，判定为异步运行时无响应
//!
//! 时间基准使用单调时钟（Instant），不受系统休眠唤醒/NTP 校时/手动改时间
//! 引起的墙钟跳变影响（审阅 19 P3-1）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// 单调时钟起点（进程内首次使用时固定）
static MONOTONIC_EPOCH: OnceLock<Instant> = OnceLock::new();
static LAST_HEARTBEAT: AtomicU64 = AtomicU64::new(0);
static STALL_REPORTED: AtomicBool = AtomicBool::new(false);

const STALL_TIMEOUT_MS: u64 = 10_000;
const CHECK_INTERVAL: Duration = Duration::from_millis(2_500);

fn monotonic_now_ms() -> u64 {
    let epoch = *MONOTONIC_EPOCH.get_or_init(Instant::now);
    epoch.elapsed().as_millis() as u64
}

/// 更新心跳时间戳。
/// 由跑在 tauri::async_runtime 上的定时任务定期调用（见 lib.rs setup）。
pub fn heartbeat() {
    LAST_HEARTBEAT.store(monotonic_now_ms(), Ordering::Release);

    if STALL_REPORTED.swap(false, Ordering::AcqRel) {
        log::info!("[RuntimeWatchdog] Async runtime recovered from stall");
    }
}

/// 启动异步运行时看门狗线程（所有平台）。
pub fn start_anr_watchdog() {
    heartbeat();

    std::thread::Builder::new()
        .name("async-runtime-watchdog".into())
        .spawn(|| loop {
            std::thread::sleep(CHECK_INTERVAL);

            let last = LAST_HEARTBEAT.load(Ordering::Acquire);
            let frozen_for = monotonic_now_ms().saturating_sub(last);

            if frozen_for > STALL_TIMEOUT_MS && !STALL_REPORTED.load(Ordering::Acquire) {
                STALL_REPORTED.store(true, Ordering::Release);

                log::error!(
                    "[RuntimeWatchdog] Async runtime (tokio) starved for {}ms (threshold: {}ms) — all invoke commands are likely stalled; note this does NOT monitor the UI main thread",
                    frozen_for,
                    STALL_TIMEOUT_MS
                );

                sentry::Hub::main().capture_message(
                    &format!(
                        "Async runtime starved: tokio heartbeat stalled for {}ms (not a UI main-thread ANR)",
                        frozen_for
                    ),
                    sentry::Level::Error,
                );
            }
        })
        .expect("Failed to spawn async runtime watchdog thread");
}
