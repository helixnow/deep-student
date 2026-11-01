//! 错误恢复和重试机制模块
//! 🎯 改进：提供统一的错误处理和重试逻辑

use crate::models::AppError;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{info, warn};
/// 通用结果类型
type Result<T> = std::result::Result<T, AppError>;

/// 重试配置
#[derive(Debug, Clone)]
pub struct RetryConfig {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
    pub exponential_base: f64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_delay_ms: 100,
            max_delay_ms: 5000,
            exponential_base: 2.0,
        }
    }
}

/// 重试策略
#[derive(Debug, Clone)]
pub enum RetryStrategy {
    /// 固定延迟
    Fixed(Duration),
    /// 指数退避
    ExponentialBackoff {
        base_delay: Duration,
        max_delay: Duration,
        multiplier: f64,
    },
    /// 线性增长
    Linear {
        base_delay: Duration,
        increment: Duration,
        max_delay: Duration,
    },
}

impl Default for RetryStrategy {
    fn default() -> Self {
        Self::ExponentialBackoff {
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_millis(5000),
            multiplier: 2.0,
        }
    }
}

/// 重试执行器
pub struct RetryExecutor {
    config: RetryConfig,
    strategy: RetryStrategy,
}

impl RetryExecutor {
    pub fn new(config: RetryConfig, strategy: RetryStrategy) -> Self {
        Self { config, strategy }
    }

    pub fn with_default_config() -> Self {
        Self {
            config: RetryConfig::default(),
            strategy: RetryStrategy::default(),
        }
    }

    /// 执行带重试的异步操作
    pub async fn execute_async<F, Fut, T, E>(&self, operation: F) -> Result<T>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = std::result::Result<T, E>>,
        E: std::fmt::Display + std::fmt::Debug,
    {
        let mut last_error = None;

        for attempt in 0..=self.config.max_retries {
            match operation().await {
                Ok(result) => {
                    if attempt > 0 {
                        info!("[ErrorRecovery] 操作在第 {} 次尝试后成功", attempt + 1);
                    }
                    return Ok(result);
                }
                Err(e) => {
                    last_error = Some(e);

                    if attempt < self.config.max_retries {
                        let delay = self.calculate_delay(attempt);
                        warn!(
                            "[ErrorRecovery] 操作失败 (尝试 {}/{}): {:?}",
                            attempt + 1,
                            self.config.max_retries + 1,
                            last_error
                        );
                        info!("[ErrorRecovery] 等待 {:?} 后重试...", delay);
                        sleep(delay).await;
                    }
                }
            }
        }

        // 所有重试都失败了
        if let Some(e) = last_error {
            Err(AppError::operation_failed(format!(
                "操作在 {} 次尝试后仍然失败: {}",
                self.config.max_retries + 1,
                e
            )))
        } else {
            Err(AppError::operation_failed("未知错误".to_string()))
        }
    }

    /// 执行带重试的同步操作
    pub fn execute_sync<F, T, E>(&self, operation: F) -> Result<T>
    where
        F: Fn() -> std::result::Result<T, E>,
        E: std::fmt::Display + std::fmt::Debug,
    {
        let mut last_error = None;

        for attempt in 0..=self.config.max_retries {
            match operation() {
                Ok(result) => {
                    if attempt > 0 {
                        info!("[ErrorRecovery] 操作在第 {} 次尝试后成功", attempt + 1);
                    }
                    return Ok(result);
                }
                Err(e) => {
                    last_error = Some(e);

                    if attempt < self.config.max_retries {
                        let delay = self.calculate_delay(attempt);
                        warn!(
                            "[ErrorRecovery] 操作失败 (尝试 {}/{}): {:?}",
                            attempt + 1,
                            self.config.max_retries + 1,
                            last_error
                        );
                        info!("[ErrorRecovery] 等待 {:?} 后重试...", delay);
                        std::thread::sleep(delay);
                    }
                }
            }
        }

        // 所有重试都失败了
        if let Some(e) = last_error {
            Err(AppError::operation_failed(format!(
                "操作在 {} 次尝试后仍然失败: {}",
                self.config.max_retries + 1,
                e
            )))
        } else {
            Err(AppError::operation_failed("未知错误".to_string()))
        }
    }

    /// 计算延迟时间
    fn calculate_delay(&self, attempt: u32) -> Duration {
        match &self.strategy {
            RetryStrategy::Fixed(delay) => *delay,
            RetryStrategy::ExponentialBackoff {
                base_delay,
                max_delay,
                multiplier,
            } => {
                let delay_ms =
                    (base_delay.as_millis() as f64 * multiplier.powi(attempt as i32)) as u64;
                Duration::from_millis(delay_ms.min(max_delay.as_millis() as u64))
            }
            RetryStrategy::Linear {
                base_delay,
                increment,
                max_delay,
            } => {
                let delay_ms =
                    base_delay.as_millis() as u64 + (increment.as_millis() as u64 * attempt as u64);
                Duration::from_millis(delay_ms.min(max_delay.as_millis() as u64))
            }
        }
    }
}

/// 数据库操作重试器
pub struct DatabaseRetryExecutor;

impl DatabaseRetryExecutor {
    /// 为数据库操作创建重试执行器
    pub fn new() -> RetryExecutor {
        RetryExecutor::new(
            RetryConfig {
                max_retries: 3,
                base_delay_ms: 100,
                max_delay_ms: 2000,
                exponential_base: 2.0,
            },
            RetryStrategy::ExponentialBackoff {
                base_delay: Duration::from_millis(100),
                max_delay: Duration::from_millis(2000),
                multiplier: 2.0,
            },
        )
    }
}

/// 网络操作重试器
pub struct NetworkRetryExecutor;

impl NetworkRetryExecutor {
    /// 为网络操作创建重试执行器
    pub fn new() -> RetryExecutor {
        RetryExecutor::new(
            RetryConfig {
                max_retries: 5,
                base_delay_ms: 200,
                max_delay_ms: 10000,
                exponential_base: 1.5,
            },
            RetryStrategy::ExponentialBackoff {
                base_delay: Duration::from_millis(200),
                max_delay: Duration::from_millis(10000),
                multiplier: 1.5,
            },
        )
    }
}

/// 文件操作重试器
pub struct FileRetryExecutor;

impl FileRetryExecutor {
    /// 为文件操作创建重试执行器
    pub fn new() -> RetryExecutor {
        RetryExecutor::new(
            RetryConfig {
                max_retries: 2,
                base_delay_ms: 50,
                max_delay_ms: 500,
                exponential_base: 2.0,
            },
            RetryStrategy::ExponentialBackoff {
                base_delay: Duration::from_millis(50),
                max_delay: Duration::from_millis(500),
                multiplier: 2.0,
            },
        )
    }
}

/// 便捷宏：数据库操作重试
#[macro_export]
macro_rules! retry_database_operation {
    ($operation:expr) => {{
        use $crate::error_recovery::DatabaseRetryExecutor;
        let executor = DatabaseRetryExecutor::new();
        executor.execute_sync(|| $operation)
    }};
}

/// 便捷宏：异步数据库操作重试
#[macro_export]
macro_rules! retry_database_operation_async {
    ($operation:expr) => {{
        use $crate::error_recovery::DatabaseRetryExecutor;
        let executor = DatabaseRetryExecutor::new();
        executor.execute_async(|| async { $operation }).await
    }};
}

/// 便捷宏：网络操作重试
#[macro_export]
macro_rules! retry_network_operation {
    ($operation:expr) => {{
        use $crate::error_recovery::NetworkRetryExecutor;
        let executor = NetworkRetryExecutor::new();
        executor.execute_async(|| async { $operation }).await
    }};
}

/// 便捷宏：文件操作重试
#[macro_export]
macro_rules! retry_file_operation {
    ($operation:expr) => {{
        use $crate::error_recovery::FileRetryExecutor;
        let executor = FileRetryExecutor::new();
        executor.execute_sync(|| $operation)
    }};
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn test_retry_success_after_failures() {
        let counter = Arc::new(AtomicU32::new(0));
        let counter_clone = counter.clone();

        let executor = RetryExecutor::with_default_config();

        let result = executor
            .execute_async(|| {
                let counter = counter_clone.clone();
                async move {
                    let count = counter.fetch_add(1, Ordering::SeqCst);
                    if count < 2 {
                        Err("模拟失败")
                    } else {
                        Ok("成功")
                    }
                }
            })
            .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "成功");
        assert_eq!(counter.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn test_retry_all_failures() {
        let counter = Arc::new(AtomicU32::new(0));
        let counter_clone = counter.clone();

        let executor = RetryExecutor::new(
            RetryConfig {
                max_retries: 2,
                base_delay_ms: 1,
                max_delay_ms: 10,
                exponential_base: 2.0,
            },
            RetryStrategy::Fixed(Duration::from_millis(1)),
        );

        let result = executor.execute_sync(|| {
            let counter = counter_clone.clone();
            counter.fetch_add(1, Ordering::SeqCst);
            Err::<(), &str>("总是失败")
        });

        assert!(result.is_err());
        assert_eq!(counter.load(Ordering::SeqCst), 3); // 3次尝试（初始 + 2次重试）
    }
}
