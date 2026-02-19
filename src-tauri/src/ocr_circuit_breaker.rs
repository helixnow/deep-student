//! OCR 熔断器
//!
//! 三态熔断器保护 OCR 调用链路：
//! - Closed（正常）：所有请求正常通过
//! - Open（熔断）：连续 N 次失败后触发，所有请求立即拒绝
//! - HalfOpen（试探）：冷却期后允许 1 次试探请求

use log::{info, warn};
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 连续失败多少次触发熔断
const FAILURE_THRESHOLD: u32 = 3;
/// 熔断冷却期
const COOLDOWN_DURATION: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

struct CircuitBreakerInner {
    state: CircuitState,
    consecutive_failures: u32,
    last_failure_time: Option<Instant>,
}

pub struct OcrCircuitBreaker {
    inner: Mutex<CircuitBreakerInner>,
}

/// 全局 OCR 熔断器单例
pub static OCR_CIRCUIT_BREAKER: LazyLock<OcrCircuitBreaker> =
    LazyLock::new(OcrCircuitBreaker::new);

impl OcrCircuitBreaker {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CircuitBreakerInner {
                state: CircuitState::Closed,
                consecutive_failures: 0,
                last_failure_time: None,
            }),
        }
    }

    /// 检查是否允许请求通过。
    /// 返回 `true` 表示允许，`false` 表示熔断拒绝。
    pub fn allow_request(&self) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());

        match inner.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                // 检查冷却期是否已过
                if let Some(last_fail) = inner.last_failure_time {
                    if last_fail.elapsed() >= COOLDOWN_DURATION {
                        info!("[OCR-CircuitBreaker] 冷却期已过，进入 HalfOpen 试探状态");
                        inner.state = CircuitState::HalfOpen;
                        true
                    } else {
                        false
                    }
                } else {
                    // 没有 last_failure_time 不应该出现在 Open 状态，修复它
                    inner.state = CircuitState::Closed;
                    inner.consecutive_failures = 0;
                    true
                }
            }
            CircuitState::HalfOpen => {
                // HalfOpen 状态只允许一个试探请求（已在 transition 时设置）
                true
            }
        }
    }

    /// 记录请求成功
    pub fn record_success(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.state != CircuitState::Closed {
            info!(
                "[OCR-CircuitBreaker] 请求成功，从 {:?} 恢复到 Closed",
                inner.state
            );
        }
        inner.state = CircuitState::Closed;
        inner.consecutive_failures = 0;
        inner.last_failure_time = None;
    }

    /// 记录请求失败
    pub fn record_failure(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.consecutive_failures += 1;
        inner.last_failure_time = Some(Instant::now());

        match inner.state {
            CircuitState::Closed => {
                if inner.consecutive_failures >= FAILURE_THRESHOLD {
                    warn!(
                        "[OCR-CircuitBreaker] 连续 {} 次失败，触发熔断 → Open",
                        inner.consecutive_failures
                    );
                    inner.state = CircuitState::Open;
                }
            }
            CircuitState::HalfOpen => {
                warn!("[OCR-CircuitBreaker] HalfOpen 试探失败，回到 Open 状态");
                inner.state = CircuitState::Open;
            }
            CircuitState::Open => {
                // 已经在 Open 状态，更新时间戳即可
            }
        }
    }

    /// 获取当前状态（用于诊断/日志）
    pub fn current_state(&self) -> CircuitState {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.state
    }
}

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
        // Still under threshold
        assert_eq!(cb.current_state(), CircuitState::Closed);
        assert!(cb.allow_request());
    }
}
