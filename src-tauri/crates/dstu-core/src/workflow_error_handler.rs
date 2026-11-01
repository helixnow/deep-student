//! Unified Workflow Error Handler
//!
//! This module provides centralized error handling and recovery mechanisms
//! for all workflow failures across the application.

use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;

/// Workflow error types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum WorkflowErrorType {
    LLMTimeout,
    LLMParsingFailed,
    DatabaseConnectionLost,
    VectorDimensionMismatch,
    ConcurrencyConflict,
    NetworkError,
    ResourceExhausted,
    ValidationFailed,
    UnknownError,
}

/// Workflow error context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowError {
    pub id: String,
    pub error_type: WorkflowErrorType,
    pub workflow_name: String,
    pub step_name: String,
    pub error_message: String,
    pub context: HashMap<String, String>,
    pub timestamp: DateTime<Utc>,
    pub retry_count: u32,
    pub is_recoverable: bool,
}

/// Recovery strategy
#[derive(Debug, Clone)]
pub enum RecoveryStrategy {
    Retry { max_attempts: u32, backoff_ms: u64 },
    Fallback { fallback_fn: String },
    Skip { continue_workflow: bool },
    Abort { cleanup_required: bool },
}

/// Workflow error handler configuration
#[derive(Debug, Clone)]
pub struct ErrorHandlerConfig {
    pub max_retry_attempts: u32,
    pub base_backoff_ms: u64,
    pub enable_circuit_breaker: bool,
    pub circuit_breaker_threshold: u32,
    pub enable_metrics: bool,
}

impl Default for ErrorHandlerConfig {
    fn default() -> Self {
        Self {
            max_retry_attempts: 3,
            base_backoff_ms: 1000,
            enable_circuit_breaker: true,
            circuit_breaker_threshold: 10,
            enable_metrics: true,
        }
    }
}

/// Circuit breaker state
#[derive(Debug, Clone)]
enum CircuitBreakerState {
    Closed,
    Open { opened_at: DateTime<Utc> },
    HalfOpen,
}

/// Circuit breaker for preventing cascade failures
#[derive(Debug)]
struct CircuitBreaker {
    state: CircuitBreakerState,
    failure_count: u32,
    threshold: u32,
    timeout_ms: u64,
}

impl CircuitBreaker {
    fn new(threshold: u32) -> Self {
        Self {
            state: CircuitBreakerState::Closed,
            failure_count: 0,
            threshold,
            timeout_ms: 60000, // 1 minute
        }
    }

    fn can_execute(&mut self) -> bool {
        match &self.state {
            CircuitBreakerState::Closed => true,
            CircuitBreakerState::Open { opened_at } => {
                if Utc::now()
                    .signed_duration_since(*opened_at)
                    .num_milliseconds()
                    > self.timeout_ms as i64
                {
                    self.state = CircuitBreakerState::HalfOpen;
                    true
                } else {
                    false
                }
            }
            CircuitBreakerState::HalfOpen => true,
        }
    }

    fn record_success(&mut self) {
        self.failure_count = 0;
        self.state = CircuitBreakerState::Closed;
    }

    fn record_failure(&mut self) {
        self.failure_count += 1;
        if self.failure_count >= self.threshold {
            self.state = CircuitBreakerState::Open {
                opened_at: Utc::now(),
            };
        }
    }
}

/// Unified workflow error handler
pub struct WorkflowErrorHandler {
    config: ErrorHandlerConfig,
    error_strategies: HashMap<WorkflowErrorType, RecoveryStrategy>,
    circuit_breakers: Arc<RwLock<HashMap<String, CircuitBreaker>>>,
    error_sender: mpsc::UnboundedSender<WorkflowError>,
    error_receiver: Arc<RwLock<Option<mpsc::UnboundedReceiver<WorkflowError>>>>,
    metrics: Arc<RwLock<HashMap<String, u64>>>,
}

impl WorkflowErrorHandler {
    /// Create a new workflow error handler
    pub fn new(config: ErrorHandlerConfig) -> Self {
        let (error_sender, error_receiver) = mpsc::unbounded_channel();

        let mut error_strategies = HashMap::new();

        // Configure default recovery strategies
        error_strategies.insert(
            WorkflowErrorType::LLMTimeout,
            RecoveryStrategy::Retry {
                max_attempts: 3,
                backoff_ms: 2000,
            },
        );

        error_strategies.insert(
            WorkflowErrorType::LLMParsingFailed,
            RecoveryStrategy::Fallback {
                fallback_fn: "use_simple_parser".to_string(),
            },
        );

        error_strategies.insert(
            WorkflowErrorType::DatabaseConnectionLost,
            RecoveryStrategy::Retry {
                max_attempts: 5,
                backoff_ms: 1000,
            },
        );

        error_strategies.insert(
            WorkflowErrorType::VectorDimensionMismatch,
            RecoveryStrategy::Fallback {
                fallback_fn: "auto_fix_dimensions".to_string(),
            },
        );

        error_strategies.insert(
            WorkflowErrorType::ConcurrencyConflict,
            RecoveryStrategy::Retry {
                max_attempts: 2,
                backoff_ms: 500,
            },
        );

        error_strategies.insert(
            WorkflowErrorType::NetworkError,
            RecoveryStrategy::Retry {
                max_attempts: 3,
                backoff_ms: 1500,
            },
        );

        error_strategies.insert(
            WorkflowErrorType::ResourceExhausted,
            RecoveryStrategy::Skip {
                continue_workflow: false,
            },
        );

        error_strategies.insert(
            WorkflowErrorType::ValidationFailed,
            RecoveryStrategy::Fallback {
                fallback_fn: "use_default_values".to_string(),
            },
        );

        error_strategies.insert(
            WorkflowErrorType::UnknownError,
            RecoveryStrategy::Abort {
                cleanup_required: true,
            },
        );

        Self {
            config,
            error_strategies,
            circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
            error_sender,
            error_receiver: Arc::new(RwLock::new(Some(error_receiver))),
            metrics: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Handle a workflow error with automatic recovery
    pub async fn handle_error(&self, error: WorkflowError) -> Result<RecoveryAction> {
        // Update metrics
        if self.config.enable_metrics {
            if let Ok(mut metrics) = self.metrics.write() {
                let key = format!("{}_{:?}", error.workflow_name, error.error_type);
                *metrics.entry(key).or_insert(0) += 1;
            }
        }

        // Check circuit breaker
        if self.config.enable_circuit_breaker {
            let breaker_key = format!("{}_{}", error.workflow_name, error.step_name);

            if let Ok(mut breakers) = self.circuit_breakers.write() {
                let breaker = breakers
                    .entry(breaker_key.clone())
                    .or_insert_with(|| CircuitBreaker::new(self.config.circuit_breaker_threshold));

                if !breaker.can_execute() {
                    println!(
                        "🚫 Circuit breaker OPEN for {}, skipping execution",
                        breaker_key
                    );
                    return Ok(RecoveryAction::CircuitBreakerOpen);
                }
            }
        }

        // Get recovery strategy
        let strategy = self
            .error_strategies
            .get(&error.error_type)
            .cloned()
            .unwrap_or(RecoveryStrategy::Abort {
                cleanup_required: true,
            });

        // Execute recovery strategy
        let action = match strategy {
            RecoveryStrategy::Retry {
                max_attempts,
                backoff_ms,
            } => {
                if error.retry_count < max_attempts {
                    // Calculate exponential backoff
                    let delay = backoff_ms * (2_u64.pow(error.retry_count));
                    tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;

                    println!(
                        "🔄 Retrying workflow step: {} (attempt {}/{})",
                        error.step_name,
                        error.retry_count + 1,
                        max_attempts
                    );

                    RecoveryAction::Retry
                } else {
                    println!("❌ Max retry attempts exceeded for {}", error.step_name);
                    RecoveryAction::Abort {
                        cleanup_required: true,
                    }
                }
            }

            RecoveryStrategy::Fallback { fallback_fn } => {
                println!(
                    "🔀 Using fallback strategy: {} for {}",
                    fallback_fn, error.step_name
                );
                RecoveryAction::Fallback(fallback_fn)
            }

            RecoveryStrategy::Skip { continue_workflow } => {
                println!(
                    "⏭️ Skipping failed step: {}, continue: {}",
                    error.step_name, continue_workflow
                );
                RecoveryAction::Skip { continue_workflow }
            }

            RecoveryStrategy::Abort {
                cleanup_required: _,
            } => {
                println!(
                    "🛑 Aborting workflow due to unrecoverable error in {}",
                    error.step_name
                );
                RecoveryAction::Abort {
                    cleanup_required: true,
                }
            }
        };

        // Send error to monitoring system
        if let Err(e) = self.error_sender.send(error.clone()) {
            eprintln!("Failed to send error to monitoring: {}", e);
        }

        Ok(action)
    }

    /// Record successful execution (for circuit breaker)
    pub fn record_success(&self, workflow_name: &str, step_name: &str) {
        if self.config.enable_circuit_breaker {
            let breaker_key = format!("{}_{}", workflow_name, step_name);

            if let Ok(mut breakers) = self.circuit_breakers.write() {
                if let Some(breaker) = breakers.get_mut(&breaker_key) {
                    breaker.record_success();
                }
            }
        }
    }

    /// Record failed execution (for circuit breaker)
    pub fn record_failure(&self, workflow_name: &str, step_name: &str) {
        if self.config.enable_circuit_breaker {
            let breaker_key = format!("{}_{}", workflow_name, step_name);

            if let Ok(mut breakers) = self.circuit_breakers.write() {
                let breaker = breakers
                    .entry(breaker_key)
                    .or_insert_with(|| CircuitBreaker::new(self.config.circuit_breaker_threshold));
                breaker.record_failure();
            }
        }
    }

    /// Get error metrics
    pub fn get_metrics(&self) -> HashMap<String, u64> {
        if let Ok(metrics) = self.metrics.read() {
            metrics.clone()
        } else {
            HashMap::new()
        }
    }

    /// Start error monitoring background task
    pub async fn start_monitoring(&self) -> Result<()> {
        let receiver = {
            let mut receiver_guard = self
                .error_receiver
                .write()
                .map_err(|_| anyhow!("Lock poisoned"))?;
            receiver_guard
                .take()
                .ok_or_else(|| anyhow!("Monitoring already started"))?
        };

        tokio::spawn(async move {
            let mut receiver = receiver;
            while let Some(error) = receiver.recv().await {
                // Log error for monitoring
                println!(
                    "📊 Workflow Error Logged: {} in {}::{} - {}",
                    error.id, error.workflow_name, error.step_name, error.error_message
                );

                // Here you could send to external monitoring systems
                // like Prometheus, DataDog, etc.
            }
        });

        Ok(())
    }
}

/// Recovery action to be taken
#[derive(Debug, Clone)]
pub enum RecoveryAction {
    Retry,
    Fallback(String),
    Skip { continue_workflow: bool },
    Abort { cleanup_required: bool },
    CircuitBreakerOpen,
}

/// Convenience macro for creating workflow errors
#[macro_export]
macro_rules! workflow_error {
    ($error_type:expr, $workflow:expr, $step:expr, $message:expr) => {
        WorkflowError {
            id: uuid::Uuid::new_v4().to_string(),
            error_type: $error_type,
            workflow_name: $workflow.to_string(),
            step_name: $step.to_string(),
            error_message: $message.to_string(),
            context: std::collections::HashMap::new(),
            timestamp: chrono::Utc::now(),
            retry_count: 0,
            is_recoverable: true,
        }
    };

    ($error_type:expr, $workflow:expr, $step:expr, $message:expr, $context:expr) => {
        WorkflowError {
            id: uuid::Uuid::new_v4().to_string(),
            error_type: $error_type,
            workflow_name: $workflow.to_string(),
            step_name: $step.to_string(),
            error_message: $message.to_string(),
            context: $context,
            timestamp: chrono::Utc::now(),
            retry_count: 0,
            is_recoverable: true,
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_error_handler_retry() {
        let config = ErrorHandlerConfig::default();
        let handler = WorkflowErrorHandler::new(config);

        let error = workflow_error!(
            WorkflowErrorType::LLMTimeout,
            "test_workflow",
            "llm_call",
            "Request timeout"
        );

        let action = handler.handle_error(error).await.unwrap();

        match action {
            RecoveryAction::Retry => println!("✅ Retry action returned as expected"),
            _ => panic!("Expected retry action"),
        }
    }

    #[tokio::test]
    async fn test_circuit_breaker() {
        let config = ErrorHandlerConfig {
            circuit_breaker_threshold: 2,
            ..Default::default()
        };
        let handler = WorkflowErrorHandler::new(config);

        // Record failures to trigger circuit breaker
        handler.record_failure("test_workflow", "test_step");
        handler.record_failure("test_workflow", "test_step");

        let error = workflow_error!(
            WorkflowErrorType::LLMTimeout,
            "test_workflow",
            "test_step",
            "Request timeout"
        );

        let action = handler.handle_error(error).await.unwrap();

        match action {
            RecoveryAction::CircuitBreakerOpen => {
                println!("✅ Circuit breaker triggered as expected")
            }
            _ => panic!("Expected circuit breaker to be open"),
        }
    }
}
