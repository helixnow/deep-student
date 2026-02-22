//! ANR (Application Not Responding) 看门狗
//!
//! 检测主线程是否卡顿（无响应），在超时后记录警告日志并上报 Sentry。
//! 在所有平台启用：桌面端 OS 的 hang 检测仅对 Win32 消息循环有效，
//! 无法检测 Tauri 后端线程的阻塞。
//!
//! ## 原理
//! 1. 后台线程每 2.5 秒检查心跳时间戳
//! 2. 应由 Tauri setup 阶段启动定时器定期调用 heartbeat()
//! 3. 如果 heartbeat 超过阈值（10 秒）未更新，判定为 ANR

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static LAST_HEARTBEAT: AtomicU64 = AtomicU64::new(0);
static ANR_REPORTED: AtomicBool = AtomicBool::new(false);

const ANR_TIMEOUT_MS: u64 = 10_000;
const CHECK_INTERVAL: Duration = Duration::from_millis(2_500);

/// 更新心跳时间戳。
/// 应由 Tauri 事件循环或定时任务定期调用。
pub fn heartbeat() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    LAST_HEARTBEAT.store(now, Ordering::Release);

    if ANR_REPORTED.swap(false, Ordering::AcqRel) {
        log::info!("[ANR-Watchdog] Main thread recovered from ANR");
    }
}

/// 启动 ANR 看门狗线程（所有平台）。
pub fn start_anr_watchdog() {
    heartbeat();

    std::thread::Builder::new()
        .name("anr-watchdog".into())
        .spawn(|| {
            loop {
                std::thread::sleep(CHECK_INTERVAL);

                let last = LAST_HEARTBEAT.load(Ordering::Acquire);
                if last == 0 {
                    continue;
                }

                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;

                let frozen_for = now.saturating_sub(last);

                if frozen_for > ANR_TIMEOUT_MS && !ANR_REPORTED.load(Ordering::Acquire) {
                    ANR_REPORTED.store(true, Ordering::Release);

                    log::error!(
                        "[ANR-Watchdog] Main thread unresponsive for {}ms (threshold: {}ms)",
                        frozen_for,
                        ANR_TIMEOUT_MS
                    );

                    sentry::capture_message(
                        &format!("ANR detected: main thread frozen for {}ms", frozen_for),
                        sentry::Level::Error,
                    );
                }
            }
        })
        .expect("Failed to spawn ANR watchdog thread");
}
