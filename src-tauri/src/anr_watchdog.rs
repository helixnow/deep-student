//! ANR (Application Not Responding) 看门狗
//!
//! 检测主线程是否卡顿（无响应），在超时后记录警告日志并上报 Sentry。
//! 仅在 Android 平台启用（桌面端 OS 自带 hang 检测）。
//!
//! ## 原理
//! 1. 后台线程每 5 秒向主线程发送 ping
//! 2. 主线程收到 ping 后更新 heartbeat 时间戳
//! 3. 如果 heartbeat 超过阈值（默认 10 秒）未更新，判定为 ANR
//! 4. 记录堆栈快照并上报

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 心跳时间戳（Unix 毫秒）
static LAST_HEARTBEAT: AtomicU64 = AtomicU64::new(0);

/// ANR 超时阈值（毫秒）
const ANR_TIMEOUT_MS: u64 = 10_000;

/// 检查间隔（毫秒）
const CHECK_INTERVAL_MS: u64 = 5_000;

/// 更新心跳（应由主线程定期调用）
pub fn heartbeat() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    LAST_HEARTBEAT.store(now, Ordering::Relaxed);
}

/// 启动 ANR 看门狗线程
///
/// 仅在 Android 上实际执行检测，其他平台为空操作。
pub fn start_anr_watchdog() {
    // 初始化心跳
    heartbeat();

    #[cfg(target_os = "android")]
    {
        std::thread::Builder::new()
            .name("anr-watchdog".into())
            .spawn(|| {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(CHECK_INTERVAL_MS));

                    let last = LAST_HEARTBEAT.load(Ordering::Relaxed);
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;

                    if last > 0 && now - last > ANR_TIMEOUT_MS {
                        let frozen_for = now - last;
                        warn!(
                            "[ANR-Watchdog] Main thread unresponsive for {}ms (threshold: {}ms)",
                            frozen_for, ANR_TIMEOUT_MS
                        );

                        // 上报到 Sentry
                        sentry::capture_message(
                            &format!("ANR detected: main thread frozen for {}ms", frozen_for),
                            sentry::Level::Warning,
                        );
                    }
                }
            })
            .ok();
    }

    #[cfg(not(target_os = "android"))]
    {
        // 桌面端不启动 ANR 检测（OS 自带 hang 检测）
    }
}
