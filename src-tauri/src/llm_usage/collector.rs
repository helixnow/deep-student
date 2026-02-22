//! LLM Usage - 异步使用数据收集器
//!
//! 本模块提供非阻塞的 LLM 使用数据收集功能。
//! 使用 tokio mpsc channel 实现异步消息传递，确保不阻塞主 LLM 调用流程。
//!
//! # 设计原则
//! - **非阻塞**: 使用 unbounded channel，record 方法立即返回
//! - **后台处理**: 独立 tokio task 处理数据库写入
//! - **容错性**: 数据库错误仅记录日志，不影响主流程
//! - **批量优化**: 支持批量插入以提升性能（可选）
//!
//! # 使用示例
//! ```rust,ignore
//! let collector = UsageCollector::new(db.clone());
//!
//! // 非阻塞记录
//! collector.record(usage_record);
//!
//! // 从 API 响应创建记录
//! collector.record_from_api_response(
//!     CallerType::ChatV2,
//!     "gpt-4o",
//!     100, 50,
//!     Some("session_123"),
//!     Some(1500),
//!     true,
//!     None,
//! );
//!
//! // 优雅关闭
//! collector.shutdown().await;
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tracing::{debug, error, info, warn};

use super::database::LlmUsageDatabase;
use super::types::{CallerType, UsageRecord};

// ============================================================================
// 收集器消息类型
// ============================================================================

/// 收集器内部消息类型
///
/// 用于 channel 通信的消息枚举
enum CollectorMessage {
    /// 记录单条使用数据
    Record(UsageRecord),
    /// 批量记录使用数据
    BatchRecord(Vec<UsageRecord>),
    /// 关闭收集器
    Shutdown,
}

// ============================================================================
// 使用数据收集器
// ============================================================================

/// LLM 使用数据异步收集器
///
/// 提供非阻塞的使用数据收集功能，通过后台任务异步写入数据库。
/// 设计目标是确保数据收集不影响主 LLM 调用的响应时间。
///
/// # 架构
/// ```text
/// ┌─────────────────┐     unbounded channel     ┌─────────────────┐
/// │  LLM Manager    │ ──────────────────────────▶│  Background     │
/// │  (record 调用)   │                            │  Task           │
/// └─────────────────┘                            │  (DB 写入)       │
///                                                └─────────────────┘
/// ```
///
/// # 线程安全
/// - `UsageCollector` 可安全地在多线程间共享（`Arc<UsageCollector>`）
/// - 内部使用 `UnboundedSender` 实现无锁发送
pub struct UsageCollector {
    /// 消息发送端
    sender: UnboundedSender<CollectorMessage>,
    /// 是否已关闭
    is_shutdown: AtomicBool,
}

impl UsageCollector {
    /// 创建新的使用数据收集器
    ///
    /// 初始化 channel 并启动后台处理任务。
    ///
    /// # 参数
    /// * `db` - LLM Usage 数据库实例（Arc 包装）
    ///
    /// # 返回
    /// * `Self` - 收集器实例
    ///
    /// # 示例
    /// ```rust,ignore
    /// let db = Arc::new(LlmUsageDatabase::new(app_data_dir)?);
    /// let collector = UsageCollector::new(db);
    /// ```
    pub fn new(db: Arc<LlmUsageDatabase>) -> Self {
        info!("[UsageCollector] Initializing usage collector...");

        // 创建 unbounded channel（无界队列，避免阻塞发送方）
        let (sender, receiver) = mpsc::unbounded_channel::<CollectorMessage>();

        // 启动后台处理任务
        let collector = Self {
            sender,
            is_shutdown: AtomicBool::new(false),
        };

        // 在独立的 tauri async runtime task 中运行后台处理器
        tauri::async_runtime::spawn(Self::background_processor(db, receiver));

        info!("[UsageCollector] Usage collector initialized successfully");
        collector
    }

    /// 后台处理器任务
    ///
    /// 持续从 channel 接收消息并处理：
    /// - `Record`: 插入单条记录
    /// - `BatchRecord`: 批量插入记录
    /// - `Shutdown`: 退出循环
    ///
    /// # 参数
    /// * `db` - 数据库实例
    /// * `receiver` - 消息接收端
    async fn background_processor(
        db: Arc<LlmUsageDatabase>,
        mut receiver: UnboundedReceiver<CollectorMessage>,
    ) {
        info!("[UsageCollector::Background] Background processor started");

        // 批量缓冲区（用于批量插入优化）
        let mut batch_buffer: Vec<UsageRecord> = Vec::with_capacity(100);
        let batch_size_threshold = 50; // 达到此数量时触发批量插入
        let mut last_flush_time = std::time::Instant::now();
        let flush_interval = std::time::Duration::from_secs(5); // 最长等待时间

        loop {
            // 使用 recv 或超时来实现定期刷新
            let message = tokio::select! {
                msg = receiver.recv() => msg,
                _ = tokio::time::sleep(flush_interval) => {
                    // 超时触发刷新
                    if !batch_buffer.is_empty() {
                        Self::flush_batch(&db, &mut batch_buffer).await;
                        last_flush_time = std::time::Instant::now();
                    }
                    continue;
                }
            };

            match message {
                Some(CollectorMessage::Record(record)) => {
                    batch_buffer.push(record);

                    // 检查是否需要刷新
                    let should_flush = batch_buffer.len() >= batch_size_threshold
                        || last_flush_time.elapsed() >= flush_interval;

                    if should_flush {
                        Self::flush_batch(&db, &mut batch_buffer).await;
                        last_flush_time = std::time::Instant::now();
                    }
                }
                Some(CollectorMessage::BatchRecord(records)) => {
                    batch_buffer.extend(records);

                    // 批量记录后立即刷新
                    Self::flush_batch(&db, &mut batch_buffer).await;
                    last_flush_time = std::time::Instant::now();
                }
                Some(CollectorMessage::Shutdown) => {
                    info!("[UsageCollector::Background] Received shutdown signal");

                    // 刷新剩余数据
                    if !batch_buffer.is_empty() {
                        Self::flush_batch(&db, &mut batch_buffer).await;
                    }

                    break;
                }
                None => {
                    // Channel 已关闭
                    warn!("[UsageCollector::Background] Channel closed unexpectedly");

                    // 刷新剩余数据
                    if !batch_buffer.is_empty() {
                        Self::flush_batch(&db, &mut batch_buffer).await;
                    }

                    break;
                }
            }
        }

        info!("[UsageCollector::Background] Background processor stopped");
    }

    /// 刷新批量缓冲区到数据库
    ///
    /// # 参数
    /// * `db` - 数据库实例
    /// * `buffer` - 待刷新的记录缓冲区
    async fn flush_batch(db: &Arc<LlmUsageDatabase>, buffer: &mut Vec<UsageRecord>) {
        if buffer.is_empty() {
            return;
        }

        let count = buffer.len();
        debug!(
            "[UsageCollector::Background] Flushing {} records to database",
            count
        );

        // 批量插入
        let records = std::mem::take(buffer);
        if let Err(e) = Self::insert_records(db, &records).await {
            error!(
                "[UsageCollector::Background] Failed to insert {} records: {}",
                count, e
            );
            // 注意：这里不重试，避免无限循环
            // 生产环境可考虑添加死信队列或重试机制
        } else {
            debug!(
                "[UsageCollector::Background] Successfully inserted {} records",
                count
            );
        }
    }

    /// 插入记录到数据库
    ///
    /// 将 UsageRecord 转换为数据库格式并插入 llm_usage_logs 表。
    ///
    /// # 参数
    /// * `db` - 数据库实例
    /// * `records` - 待插入的记录列表
    ///
    /// # 返回
    /// * `Result<(), String>` - 成功返回 Ok(()), 失败返回错误信息
    async fn insert_records(
        db: &Arc<LlmUsageDatabase>,
        records: &[UsageRecord],
    ) -> Result<(), String> {
        // 获取数据库连接
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        // 使用事务批量插入
        conn.execute("BEGIN TRANSACTION", [])
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;

        for record in records {
            let result = conn.execute(
                r#"
                INSERT INTO llm_usage_logs (
                    id, timestamp, provider, model, adapter, api_config_id,
                    prompt_tokens, completion_tokens, total_tokens,
                    reasoning_tokens, cached_tokens, token_source,
                    duration_ms, caller_type, session_id,
                    status, error_message, cost_estimate
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9,
                    ?10, ?11, ?12,
                    ?13, ?14, ?15,
                    ?16, ?17, ?18
                )
                "#,
                rusqlite::params![
                    record.id,
                    record.created_at.to_rfc3339(),
                    Self::extract_provider(&record.model_id),
                    record.model_id,
                    Option::<String>::None, // adapter
                    record.config_id,
                    record.prompt_tokens,
                    record.completion_tokens,
                    record.total_tokens,
                    record.reasoning_tokens,
                    record.cached_tokens,
                    "api", // token_source
                    record.duration_ms.map(|d| d as i64),
                    record.caller_type.to_string(),
                    record.caller_id,
                    if record.success { "success" } else { "error" },
                    record.error_message,
                    record.estimated_cost_usd,
                ],
            );

            if let Err(e) = result {
                // 回滚事务
                let _ = conn.execute("ROLLBACK", []);
                return Err(format!("Failed to insert record {}: {}", record.id, e));
            }
        }

        conn.execute("COMMIT", [])
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        Ok(())
    }

    /// 从模型 ID 提取提供商名称
    ///
    /// # 参数
    /// * `model_id` - 模型标识
    ///
    /// # 返回
    /// * `String` - 提供商名称
    fn extract_provider(model_id: &str) -> String {
        let model_lower = model_id.to_lowercase();

        if model_lower.starts_with("gpt-") || model_lower.starts_with("o1") {
            "openai".to_string()
        } else if model_lower.starts_with("claude-") {
            "anthropic".to_string()
        } else if model_lower.starts_with("deepseek") {
            "deepseek".to_string()
        } else if model_lower.starts_with("qwen") {
            "alibaba".to_string()
        } else if model_lower.starts_with("gemini") {
            "google".to_string()
        } else if model_lower.contains("llama") || model_lower.contains("mistral") {
            "siliconflow".to_string()
        } else {
            "unknown".to_string()
        }
    }

    /// 记录使用数据（非阻塞）
    ///
    /// 将使用记录发送到后台处理队列，立即返回。
    /// 如果收集器已关闭，记录将被丢弃并记录警告日志。
    ///
    /// # 参数
    /// * `record` - 使用记录
    ///
    /// # 示例
    /// ```rust,ignore
    /// let record = UsageRecord::new(
    ///     CallerType::ChatV2,
    ///     "gpt-4o".to_string(),
    ///     100,
    ///     50,
    /// );
    /// collector.record(record);
    /// ```
    pub fn record(&self, record: UsageRecord) {
        if self.is_shutdown.load(Ordering::SeqCst) {
            warn!(
                "[UsageCollector] Collector is shutdown, dropping record: {}",
                record.id
            );
            return;
        }

        if let Err(e) = self.sender.send(CollectorMessage::Record(record)) {
            error!("[UsageCollector] Failed to send record: {}", e);
        }
    }

    /// 批量记录使用数据（非阻塞）
    ///
    /// 将多条使用记录发送到后台处理队列。
    ///
    /// # 参数
    /// * `records` - 使用记录列表
    pub fn record_batch(&self, records: Vec<UsageRecord>) {
        if self.is_shutdown.load(Ordering::SeqCst) {
            warn!(
                "[UsageCollector] Collector is shutdown, dropping {} records",
                records.len()
            );
            return;
        }

        if records.is_empty() {
            return;
        }

        if let Err(e) = self.sender.send(CollectorMessage::BatchRecord(records)) {
            error!("[UsageCollector] Failed to send batch records: {}", e);
        }
    }

    /// 从 API 响应创建并记录使用数据
    ///
    /// 便捷方法，用于从 LLM API 响应中提取信息并创建使用记录。
    ///
    /// # 参数
    /// * `caller_type` - 调用方类型
    /// * `model_id` - 模型标识
    /// * `prompt_tokens` - 输入 Token 数
    /// * `completion_tokens` - 输出 Token 数
    /// * `session_id` - 会话 ID（可选）
    /// * `duration_ms` - 请求耗时（毫秒，可选）
    /// * `success` - 是否成功
    /// * `error_message` - 错误信息（失败时）
    ///
    /// # 可选参数
    /// * `reasoning_tokens` - 思维链 Token 数
    /// * `cached_tokens` - 缓存命中 Token 数
    /// * `config_id` - API 配置 ID
    /// * `estimated_cost` - 估算成本（美元）
    ///
    /// # 示例
    /// ```rust,ignore
    /// collector.record_from_api_response(
    ///     CallerType::ChatV2,
    ///     "gpt-4o",
    ///     100,
    ///     50,
    ///     Some("session_123".to_string()),
    ///     Some(1500),
    ///     true,
    ///     None,
    /// );
    /// ```
    #[allow(clippy::too_many_arguments)]
    pub fn record_from_api_response(
        &self,
        caller_type: CallerType,
        model_id: &str,
        prompt_tokens: u32,
        completion_tokens: u32,
        session_id: Option<String>,
        duration_ms: Option<u64>,
        success: bool,
        error_message: Option<String>,
    ) {
        let mut record = UsageRecord::new(
            caller_type,
            model_id.to_string(),
            prompt_tokens,
            completion_tokens,
        );

        if let Some(sid) = session_id {
            record = record.with_caller_id(sid);
        }

        if let Some(duration) = duration_ms {
            record = record.with_duration(duration);
        }

        if !success {
            record =
                record.with_error(error_message.unwrap_or_else(|| "Unknown error".to_string()));
        }

        self.record(record);
    }

    /// 从 API 响应创建并记录使用数据（扩展版本）
    ///
    /// 支持更多可选参数的完整版本。
    ///
    /// # 参数
    /// * `caller_type` - 调用方类型
    /// * `model_id` - 模型标识
    /// * `prompt_tokens` - 输入 Token 数
    /// * `completion_tokens` - 输出 Token 数
    /// * `reasoning_tokens` - 思维链 Token 数（可选）
    /// * `cached_tokens` - 缓存命中 Token 数（可选）
    /// * `session_id` - 会话 ID（可选）
    /// * `config_id` - API 配置 ID（可选）
    /// * `duration_ms` - 请求耗时（毫秒，可选）
    /// * `estimated_cost` - 估算成本（美元，可选）
    /// * `success` - 是否成功
    /// * `error_message` - 错误信息（失败时）
    #[allow(clippy::too_many_arguments)]
    pub fn record_from_api_response_extended(
        &self,
        caller_type: CallerType,
        model_id: &str,
        prompt_tokens: u32,
        completion_tokens: u32,
        reasoning_tokens: Option<u32>,
        cached_tokens: Option<u32>,
        session_id: Option<String>,
        config_id: Option<String>,
        duration_ms: Option<u64>,
        estimated_cost: Option<f64>,
        success: bool,
        error_message: Option<String>,
    ) {
        let mut record = UsageRecord::new(
            caller_type,
            model_id.to_string(),
            prompt_tokens,
            completion_tokens,
        );

        if let Some(sid) = session_id {
            record = record.with_caller_id(sid);
        }

        if let Some(cid) = config_id {
            record = record.with_config_id(cid);
        }

        if let Some(tokens) = reasoning_tokens {
            record = record.with_reasoning_tokens(tokens);
        }

        if let Some(tokens) = cached_tokens {
            record = record.with_cached_tokens(tokens);
        }

        if let Some(duration) = duration_ms {
            record = record.with_duration(duration);
        }

        if let Some(cost) = estimated_cost {
            record = record.with_estimated_cost(cost);
        }

        if !success {
            record =
                record.with_error(error_message.unwrap_or_else(|| "Unknown error".to_string()));
        }

        self.record(record);
    }

    /// 优雅关闭收集器
    ///
    /// 发送关闭信号并等待后台任务完成剩余数据的处理。
    /// 调用后，后续的 record 调用将被忽略。
    ///
    /// # 示例
    /// ```rust,ignore
    /// collector.shutdown().await;
    /// ```
    pub async fn shutdown(&self) {
        if self
            .is_shutdown
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            warn!("[UsageCollector] Collector already shutdown");
            return;
        }

        info!("[UsageCollector] Initiating shutdown...");

        // 发送关闭信号
        if let Err(e) = self.sender.send(CollectorMessage::Shutdown) {
            error!("[UsageCollector] Failed to send shutdown signal: {}", e);
        }

        // 给后台任务一些时间完成
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        info!("[UsageCollector] Shutdown complete");
    }

    /// 检查收集器是否已关闭
    ///
    /// # 返回
    /// * `bool` - 是否已关闭
    pub fn is_shutdown(&self) -> bool {
        self.is_shutdown.load(Ordering::SeqCst)
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 创建测试环境
    async fn setup_test_env() -> (TempDir, Arc<LlmUsageDatabase>, UsageCollector) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db =
            Arc::new(LlmUsageDatabase::new(temp_dir.path()).expect("Failed to create database"));
        let collector = UsageCollector::new(db.clone());

        // 等待后台任务启动
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        (temp_dir, db, collector)
    }

    #[tokio::test]
    async fn test_collector_creation() {
        let (_temp_dir, _db, collector) = setup_test_env().await;

        assert!(!collector.is_shutdown());
    }

    #[tokio::test]
    async fn test_record_single() {
        let (_temp_dir, db, collector) = setup_test_env().await;

        // 记录一条数据
        let record = UsageRecord::new(CallerType::ChatV2, "gpt-4o".to_string(), 100, 50);
        collector.record(record);

        // 等待后台处理（需要等待刷新间隔或达到批量阈值）
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;

        // 验证数据已写入
        let conn = db.get_conn().expect("Failed to get connection");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM llm_usage_logs", [], |row| row.get(0))
            .expect("Failed to count records");

        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn test_record_from_api_response() {
        let (_temp_dir, db, collector) = setup_test_env().await;

        // 使用便捷方法记录
        collector.record_from_api_response(
            CallerType::Translation,
            "claude-3-opus",
            200,
            100,
            Some("session_test".to_string()),
            Some(1500),
            true,
            None,
        );

        // 等待后台处理
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;

        // 验证数据
        let conn = db.get_conn().expect("Failed to get connection");
        let (caller_type, model, session_id): (String, String, Option<String>) = conn
            .query_row(
                "SELECT caller_type, model, session_id FROM llm_usage_logs LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("Failed to query record");

        assert_eq!(caller_type, "translation");
        assert_eq!(model, "claude-3-opus");
        assert_eq!(session_id, Some("session_test".to_string()));
    }

    #[tokio::test]
    async fn test_record_batch() {
        let (_temp_dir, db, collector) = setup_test_env().await;

        // 批量记录
        let records: Vec<UsageRecord> = (0..10)
            .map(|i| UsageRecord::new(CallerType::Anki, "gpt-4o-mini".to_string(), 50 + i, 25 + i))
            .collect();

        collector.record_batch(records);

        // 等待后台处理（批量记录会立即刷新）
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // 验证数据
        let conn = db.get_conn().expect("Failed to get connection");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM llm_usage_logs", [], |row| row.get(0))
            .expect("Failed to count records");

        assert_eq!(count, 10);
    }

    #[tokio::test]
    async fn test_shutdown() {
        let (_temp_dir, db, collector) = setup_test_env().await;

        // 记录一些数据
        for i in 0..5 {
            let record = UsageRecord::new(
                CallerType::Analysis,
                "deepseek-chat".to_string(),
                100 + i,
                50 + i,
            );
            collector.record(record);
        }

        // 关闭收集器
        collector.shutdown().await;

        assert!(collector.is_shutdown());

        // 验证数据已刷新
        let conn = db.get_conn().expect("Failed to get connection");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM llm_usage_logs", [], |row| row.get(0))
            .expect("Failed to count records");

        assert_eq!(count, 5);
    }

    #[tokio::test]
    async fn test_record_after_shutdown() {
        let (_temp_dir, _db, collector) = setup_test_env().await;

        // 关闭收集器
        collector.shutdown().await;

        // 尝试记录（应该被忽略）
        let record = UsageRecord::new(CallerType::ChatV2, "gpt-4o".to_string(), 100, 50);
        collector.record(record);

        // 不应该 panic
        assert!(collector.is_shutdown());
    }

    #[tokio::test]
    async fn test_record_with_error() {
        let (_temp_dir, db, collector) = setup_test_env().await;

        // 记录失败的调用
        collector.record_from_api_response(
            CallerType::ExamSheet,
            "gpt-4o",
            100,
            0,
            None,
            Some(5000),
            false,
            Some("Rate limit exceeded".to_string()),
        );

        // 等待后台处理
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;

        // 验证数据
        let conn = db.get_conn().expect("Failed to get connection");
        let (status, error_message): (String, Option<String>) = conn
            .query_row(
                "SELECT status, error_message FROM llm_usage_logs LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("Failed to query record");

        assert_eq!(status, "error");
        assert_eq!(error_message, Some("Rate limit exceeded".to_string()));
    }

    #[test]
    fn test_extract_provider() {
        assert_eq!(UsageCollector::extract_provider("gpt-4o"), "openai");
        assert_eq!(UsageCollector::extract_provider("gpt-4o-mini"), "openai");
        assert_eq!(UsageCollector::extract_provider("o1-preview"), "openai");
        assert_eq!(
            UsageCollector::extract_provider("claude-3-opus"),
            "anthropic"
        );
        assert_eq!(
            UsageCollector::extract_provider("claude-3-5-sonnet"),
            "anthropic"
        );
        assert_eq!(
            UsageCollector::extract_provider("deepseek-chat"),
            "deepseek"
        );
        assert_eq!(
            UsageCollector::extract_provider("deepseek-coder"),
            "deepseek"
        );
        assert_eq!(UsageCollector::extract_provider("qwen-turbo"), "alibaba");
        assert_eq!(UsageCollector::extract_provider("gemini-pro"), "google");
        assert_eq!(
            UsageCollector::extract_provider("llama-3-70b"),
            "siliconflow"
        );
        assert_eq!(
            UsageCollector::extract_provider("mistral-large"),
            "siliconflow"
        );
        assert_eq!(UsageCollector::extract_provider("custom-model"), "unknown");
    }
}
