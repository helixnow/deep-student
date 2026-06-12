//! OCR 熔断器
//!
//! Per-engine 三态熔断器保护 OCR 调用链路：
//! - Closed（正常）：所有请求正常通过，滑动窗口统计失败
//! - Open（熔断）：窗口内失败率超阈值后触发，所有请求立即拒绝
//! - HalfOpen（试探）：冷却期后仅允许 1 次试探请求

use log::{info, warn};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FAILURE_THRESHOLD: u32 = 3;
const COOLDOWN_DURATION: Duration = Duration::from_secs(60);
/// 滑动窗口：仅统计此时间范围内的失败
const SLIDING_WINDOW: Duration = Duration::from_secs(300);
/// ★ 2026-06-12（代理 3 审阅 C3）：HalfOpen 探针超时。
/// 若调用方在 allow_request 与 record_success/record_failure 之间提前返回
/// （配置错误、任务取消、panic 等），探针会永久占位导致该引擎被永久拒绝。
/// 超过此时长未上报结果即视为探针丢失，允许新探针。
/// 取值需大于单次 OCR 调用的最长耗时（对冲链路 60s 硬超时 + 渐进启动间隔）。
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

struct CircuitBreakerInner {
    state: CircuitState,
    failure_timestamps: Vec<Instant>,
    last_failure_time: Option<Instant>,
    /// HalfOpen 状态下是否已有试探请求正在进行
    probe_in_flight: bool,
    /// 当前探针的启动时间（用于探针超时回收，见 PROBE_TIMEOUT）
    probe_started_at: Option<Instant>,
}

pub struct OcrCircuitBreaker {
    inner: Mutex<CircuitBreakerInner>,
    failure_threshold: u32,
    cooldown: Duration,
    window: Duration,
    probe_timeout: Duration,
}

impl OcrCircuitBreaker {
    pub fn new() -> Self {
        Self::with_config(FAILURE_THRESHOLD, COOLDOWN_DURATION, SLIDING_WINDOW)
    }

    pub fn with_config(threshold: u32, cooldown: Duration, window: Duration) -> Self {
        Self {
            inner: Mutex::new(CircuitBreakerInner {
                state: CircuitState::Closed,
                failure_timestamps: Vec::new(),
                last_failure_time: None,
                probe_in_flight: false,
                probe_started_at: None,
            }),
            failure_threshold: threshold.max(1),
            cooldown,
            window,
            probe_timeout: PROBE_TIMEOUT,
        }
    }

    /// 覆盖探针超时（主要用于测试）
    #[cfg(test)]
    fn with_probe_timeout(mut self, probe_timeout: Duration) -> Self {
        self.probe_timeout = probe_timeout;
        self
    }

    pub fn allow_request(&self) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|p| {
            warn!("[CircuitBreaker] Mutex poisoned, recovering");
            p.into_inner()
        });

        match inner.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                if let Some(last_fail) = inner.last_failure_time {
                    if last_fail.elapsed() >= self.cooldown {
                        info!("[CircuitBreaker] 冷却期已过，进入 HalfOpen 试探状态");
                        inner.state = CircuitState::HalfOpen;
                        inner.probe_in_flight = true;
                        inner.probe_started_at = Some(Instant::now());
                        true
                    } else {
                        false
                    }
                } else {
                    inner.state = CircuitState::Closed;
                    inner.failure_timestamps.clear();
                    true
                }
            }
            CircuitState::HalfOpen => {
                // ★ 2026-06-12（代理 3 审阅 C3）：探针超时回收。
                // 调用方可能在 allow_request 后因提前返回/取消而从未上报结果，
                // 旧逻辑会让 probe_in_flight 永久为 true → 引擎被永久拒绝。
                let probe_lost = inner
                    .probe_started_at
                    .map(|t| t.elapsed() >= self.probe_timeout)
                    .unwrap_or(true);

                if inner.probe_in_flight && !probe_lost {
                    false
                } else {
                    if inner.probe_in_flight {
                        warn!("[CircuitBreaker] HalfOpen 探针超时未上报结果，允许新探针");
                    }
                    inner.probe_in_flight = true;
                    inner.probe_started_at = Some(Instant::now());
                    true
                }
            }
        }
    }

    pub fn record_success(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.state != CircuitState::Closed {
            info!(
                "[CircuitBreaker] 请求成功，从 {:?} 恢复到 Closed",
                inner.state
            );
        }
        inner.state = CircuitState::Closed;
        inner.failure_timestamps.clear();
        inner.last_failure_time = None;
        inner.probe_in_flight = false;
        inner.probe_started_at = None;
    }

    pub fn record_failure(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        inner.last_failure_time = Some(now);

        match inner.state {
            CircuitState::Closed => {
                inner.failure_timestamps.push(now);
                // 滑动窗口淘汰
                let cutoff = now - self.window;
                inner.failure_timestamps.retain(|t| *t >= cutoff);

                if inner.failure_timestamps.len() as u32 >= self.failure_threshold {
                    warn!(
                        "[CircuitBreaker] 窗口内 {} 次失败（阈值 {}），触发熔断 → Open",
                        inner.failure_timestamps.len(),
                        self.failure_threshold
                    );
                    inner.state = CircuitState::Open;
                }
            }
            CircuitState::HalfOpen => {
                warn!("[CircuitBreaker] HalfOpen 试探失败，回到 Open 状态");
                inner.state = CircuitState::Open;
                inner.probe_in_flight = false;
                inner.probe_started_at = None;
            }
            CircuitState::Open => {}
        }
    }

    pub fn current_state(&self) -> CircuitState {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.state
    }
}

/// Per-engine 熔断器注册表
pub struct CircuitBreakerRegistry {
    breakers: Mutex<HashMap<String, std::sync::Arc<OcrCircuitBreaker>>>,
}

impl CircuitBreakerRegistry {
    pub fn new() -> Self {
        Self {
            breakers: Mutex::new(HashMap::new()),
        }
    }

    pub fn get_or_create(&self, engine_id: &str) -> std::sync::Arc<OcrCircuitBreaker> {
        let mut map = self.breakers.lock().unwrap_or_else(|p| p.into_inner());
        map.entry(engine_id.to_string())
            .or_insert_with(|| std::sync::Arc::new(OcrCircuitBreaker::new()))
            .clone()
    }

    pub fn get_default(&self) -> std::sync::Arc<OcrCircuitBreaker> {
        self.get_or_create("default")
    }
}

/// 全局 per-engine 熔断器注册表
pub static OCR_CIRCUIT_BREAKERS: std::sync::LazyLock<CircuitBreakerRegistry> =
    std::sync::LazyLock::new(CircuitBreakerRegistry::new);

/// 向后兼容的全局默认熔断器访问
pub static OCR_CIRCUIT_BREAKER: std::sync::LazyLock<std::sync::Arc<OcrCircuitBreaker>> =
    std::sync::LazyLock::new(|| OCR_CIRCUIT_BREAKERS.get_default());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_closed_allows_requests() {
        let cb = OcrCircuitBreaker::new();
        assert!(cb.allow_request());
        assert_eq!(cb.current_state(), CircuitState::Closed);
    }

    #[test]
    fn test_opens_after_threshold_failures() {
        let cb = OcrCircuitBreaker::new();
        for _ in 0..FAILURE_THRESHOLD {
            cb.record_failure();
        }
        assert_eq!(cb.current_state(), CircuitState::Open);
        assert!(!cb.allow_request());
    }

    #[test]
    fn test_success_resets_to_closed() {
        let cb = OcrCircuitBreaker::new();
        cb.record_failure();
        cb.record_failure();
        cb.record_success();
        assert_eq!(cb.current_state(), CircuitState::Closed);
        assert!(cb.allow_request());
    }

    #[test]
    fn test_partial_failures_dont_open() {
        let cb = OcrCircuitBreaker::new();
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.current_state(), CircuitState::Closed);
        assert!(cb.allow_request());
    }

    #[test]
    fn test_half_open_allows_only_one_probe() {
        let cb =
            OcrCircuitBreaker::with_config(1, Duration::from_millis(1), Duration::from_secs(60));
        cb.record_failure();
        assert_eq!(cb.current_state(), CircuitState::Open);

        std::thread::sleep(Duration::from_millis(5));

        // 第一个请求：进入 HalfOpen，允许通过
        assert!(cb.allow_request());
        assert_eq!(cb.current_state(), CircuitState::HalfOpen);

        // 第二个请求：probe_in_flight，拒绝
        assert!(!cb.allow_request());
    }

    #[test]
    fn test_half_open_success_resets() {
        let cb =
            OcrCircuitBreaker::with_config(1, Duration::from_millis(1), Duration::from_secs(60));
        cb.record_failure();
        std::thread::sleep(Duration::from_millis(5));
        assert!(cb.allow_request()); // enter HalfOpen
        cb.record_success();
        assert_eq!(cb.current_state(), CircuitState::Closed);
        assert!(cb.allow_request());
    }

    #[test]
    fn test_half_open_failure_reopens() {
        let cb =
            OcrCircuitBreaker::with_config(1, Duration::from_millis(1), Duration::from_secs(60));
        cb.record_failure();
        std::thread::sleep(Duration::from_millis(5));
        assert!(cb.allow_request()); // enter HalfOpen
        cb.record_failure();
        assert_eq!(cb.current_state(), CircuitState::Open);
    }

    #[test]
    fn test_half_open_probe_timeout_recovers_leak() {
        // 回归 C3：探针在 allow_request 后从未上报结果（提前返回/取消），
        // 超时后必须允许新探针，而不是永久拒绝。
        let cb =
            OcrCircuitBreaker::with_config(1, Duration::from_millis(1), Duration::from_secs(60))
                .with_probe_timeout(Duration::from_millis(30));
        cb.record_failure();
        std::thread::sleep(Duration::from_millis(5));

        // 探针 1 获准但"丢失"（不上报结果）
        assert!(cb.allow_request());
        assert_eq!(cb.current_state(), CircuitState::HalfOpen);
        // 探针未超时前：拒绝
        assert!(!cb.allow_request());

        // 超过探针超时后：允许新探针
        std::thread::sleep(Duration::from_millis(40));
        assert!(cb.allow_request());
        assert_eq!(cb.current_state(), CircuitState::HalfOpen);

        // 新探针成功 → 恢复 Closed
        cb.record_success();
        assert_eq!(cb.current_state(), CircuitState::Closed);
    }

    #[test]
    fn test_per_engine_registry() {
        let registry = CircuitBreakerRegistry::new();
        let deepseek = registry.get_or_create("deepseek");
        let paddle = registry.get_or_create("paddle");

        // DeepSeek 熔断不影响 Paddle
        for _ in 0..FAILURE_THRESHOLD {
            deepseek.record_failure();
        }
        assert_eq!(deepseek.current_state(), CircuitState::Open);
        assert_eq!(paddle.current_state(), CircuitState::Closed);
        assert!(paddle.allow_request());
        assert!(!deepseek.allow_request());
    }

    #[test]
    fn test_sliding_window_expires_old_failures() {
        let cb =
            OcrCircuitBreaker::with_config(3, Duration::from_secs(60), Duration::from_millis(50));
        cb.record_failure();
        cb.record_failure();
        std::thread::sleep(Duration::from_millis(60));
        // 旧的 2 次失败已过期，窗口内只有这 1 次
        cb.record_failure();
        assert_eq!(cb.current_state(), CircuitState::Closed);
    }
}
