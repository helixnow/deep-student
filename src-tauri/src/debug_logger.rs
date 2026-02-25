/**
 * 后端调试日志记录模块
 * 用于记录数据库操作、API调用、流式处理等关键信息
 */
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tracing::{error, info, warn};
fn console_logging_enabled() -> bool {
    match std::env::var("DSTU_CONSOLE_LOG") {
        Ok(v) => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        Err(_) => false,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum LogLevel {
    DEBUG,
    INFO,
    WARN,
    ERROR,
    TRACE,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogContext {
    pub user_id: Option<String>,
    pub session_id: Option<String>,
    pub mistake_id: Option<String>,
    pub stream_id: Option<String>,
    pub business_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub level: LogLevel,
    pub module: String,
    pub operation: String,
    pub data: serde_json::Value,
    pub context: Option<LogContext>,
    pub stack_trace: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DebugLogger {
    log_dir: PathBuf,
    log_queue: Arc<Mutex<Vec<LogEntry>>>,
}

impl DebugLogger {
    const MAX_LOG_AGE_DAYS: i64 = 7;
    const MAX_LOG_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024; // 10MB

    pub fn new(app_data_dir: PathBuf) -> Self {
        let log_dir = app_data_dir.join("logs");

        // 确保日志目录存在
        if let Err(e) = std::fs::create_dir_all(&log_dir.join("frontend")) {
            error!("Failed to create frontend log directory: {}", e);
        }
        if let Err(e) = std::fs::create_dir_all(&log_dir.join("backend")) {
            error!("Failed to create backend log directory: {}", e);
        }
        if let Err(e) = std::fs::create_dir_all(&log_dir.join("debug")) {
            error!("Failed to create debug log directory: {}", e);
        }

        let logger = Self {
            log_dir,
            log_queue: Arc::new(Mutex::new(Vec::new())),
        };

        logger.cleanup_old_logs();

        logger
    }

    /// 清理过期和超大日志文件
    fn cleanup_old_logs(&self) {
        let mut removed_count = 0u32;
        let mut removed_bytes = 0u64;

        for subdir in &["frontend", "backend", "debug"] {
            let dir = self.log_dir.join(subdir);
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }

                let should_remove = match entry.metadata() {
                    Ok(meta) => {
                        let modified = meta.modified().ok().and_then(|t| {
                            let duration = t.elapsed().ok()?;
                            Some(duration.as_secs() > (Self::MAX_LOG_AGE_DAYS as u64 * 86400))
                        }).unwrap_or(false);

                        let oversized = meta.len() > Self::MAX_LOG_FILE_SIZE_BYTES;

                        modified || oversized
                    }
                    Err(_) => false,
                };

                if should_remove {
                    if let Ok(meta) = entry.metadata() {
                        removed_bytes += meta.len();
                    }
                    if std::fs::remove_file(&path).is_ok() {
                        removed_count += 1;
                    }
                }
            }
        }

        if removed_count > 0 {
            info!(
                "[DebugLogger] Cleaned up {} old/oversized log files ({:.1} MB)",
                removed_count,
                removed_bytes as f64 / (1024.0 * 1024.0)
            );
        }
    }

    /// 记录数据库操作相关日志
    pub async fn log_database_operation(
        &self,
        operation: &str,
        table: &str,
        query: &str,
        params: Option<&serde_json::Value>,
        result: Option<&serde_json::Value>,
        error: Option<&str>,
        duration_ms: Option<u64>,
    ) {
        let level = if error.is_some() {
            LogLevel::ERROR
        } else {
            LogLevel::DEBUG
        };

        let data = serde_json::json!({
            "table": table,
            "query": query,
            "params": params,
            "result": self.sanitize_database_result(result),
            "error": error,
            "duration_ms": duration_ms
        });

        self.log(level, "DATABASE", operation, data, None).await;
    }

    /// 记录聊天记录相关操作
    pub async fn log_chat_record_operation(
        &self,
        operation: &str,
        mistake_id: &str,
        chat_history: Option<&serde_json::Value>,
        expected_vs_actual: Option<(usize, usize)>,
        error: Option<&str>,
    ) {
        let level = if error.is_some() {
            LogLevel::ERROR
        } else {
            LogLevel::INFO
        };

        let data = serde_json::json!({
            "mistake_id": mistake_id,
            "chat_history_length": chat_history.and_then(|ch| ch.as_array().map(|arr| arr.len())),
            "chat_history": self.sanitize_chat_history(chat_history),
            "expected_vs_actual": expected_vs_actual,
            "error": error,
            "timestamp": Utc::now().to_rfc3339()
        });

        let context = LogContext {
            user_id: None,
            session_id: None,
            mistake_id: Some(mistake_id.to_string()),
            stream_id: None,
            business_id: Some(mistake_id.to_string()),
        };

        self.log(level, "CHAT_RECORD", operation, data, Some(context))
            .await;
    }

    /// 记录RAG操作
    pub async fn log_rag_operation(
        &self,
        operation: &str,
        query: Option<&str>,
        top_k: Option<usize>,
        sources_found: Option<usize>,
        sources_returned: Option<usize>,
        error: Option<&str>,
        duration_ms: Option<u64>,
    ) {
        let level = if error.is_some() {
            LogLevel::ERROR
        } else {
            LogLevel::INFO
        };

        let data = serde_json::json!({
            "query_length": query.map(|q| q.chars().count()),
            "query_preview": query.map(|q| crate::utils::text::safe_truncate(q, 100)),
            "top_k": top_k,
            "sources_found": sources_found,
            "sources_returned": sources_returned,
            "error": error,
            "duration_ms": duration_ms,
            "sources_missing": sources_found.and_then(|found|
                sources_returned.map(|returned| found.saturating_sub(returned))
            )
        });

        self.log(level, "RAG", operation, data, None).await;
    }

    /// 记录流式处理操作
    pub async fn log_streaming_operation(
        &self,
        operation: &str,
        stream_id: &str,
        event_type: &str,
        payload_size: Option<usize>,
        error: Option<&str>,
    ) {
        let level = if error.is_some() {
            LogLevel::ERROR
        } else {
            LogLevel::DEBUG
        };

        let data = serde_json::json!({
            "stream_id": stream_id,
            "event_type": event_type,
            "payload_size": payload_size,
            "error": error,
            "timestamp": Utc::now().to_rfc3339()
        });

        let context = LogContext {
            user_id: None,
            session_id: None,
            mistake_id: None,
            stream_id: Some(stream_id.to_string()),
            business_id: None,
        };

        self.log(level, "STREAMING", operation, data, Some(context))
            .await;
    }

    /// 记录API调用
    pub async fn log_api_call(
        &self,
        operation: &str,
        method: &str,
        url: &str,
        request_body: Option<&serde_json::Value>,
        response_body: Option<&serde_json::Value>,
        status_code: Option<u16>,
        error: Option<&str>,
        duration_ms: Option<u64>,
    ) {
        let level = if error.is_some() || status_code.map_or(false, |code| code >= 400) {
            LogLevel::ERROR
        } else {
            LogLevel::INFO
        };

        let data = serde_json::json!({
            "method": method,
            "url": url,
            "request_body": self.sanitize_api_body(request_body),
            "response_body": self.sanitize_api_body(response_body),
            "status_code": status_code,
            "error": error,
            "duration_ms": duration_ms
        });

        self.log(level, "API", operation, data, None).await;
    }

    /// 记录状态变化
    pub async fn log_state_change(
        &self,
        component: &str,
        operation: &str,
        old_state: Option<&serde_json::Value>,
        new_state: Option<&serde_json::Value>,
        trigger: Option<&str>,
    ) {
        let data = serde_json::json!({
            "component": component,
            "old_state": self.sanitize_state(old_state),
            "new_state": self.sanitize_state(new_state),
            "state_diff": self.calculate_state_diff(old_state, new_state),
            "trigger": trigger
        });

        self.log(LogLevel::TRACE, "STATE_CHANGE", operation, data, None)
            .await;
    }

    /// 通用日志记录方法
    pub async fn log(
        &self,
        level: LogLevel,
        module: &str,
        operation: &str,
        data: serde_json::Value,
        context: Option<LogContext>,
    ) {
        let log_entry = LogEntry {
            timestamp: Utc::now().to_rfc3339(),
            level: level.clone(),
            module: module.to_string(),
            operation: operation.to_string(),
            data,
            context,
            stack_trace: if matches!(level, LogLevel::ERROR) {
                Some(format!("{:?}", std::backtrace::Backtrace::capture()))
            } else {
                None
            },
        };

        // 添加到队列
        {
            let mut queue = self.log_queue.lock().unwrap_or_else(|e| e.into_inner());
            queue.push(log_entry.clone());

            // 如果是错误级别，立即写入
            if matches!(level, LogLevel::ERROR) {
                drop(queue);
                // 使用 spawn 来避免 Send 问题
                let logger = self.clone();
                tokio::spawn(async move {
                    logger.flush_logs().await;
                });
            }
        }

        // 可选：输出到控制台（默认关闭，设置 DSTU_CONSOLE_LOG=true 启用）
        if console_logging_enabled() {
            match level {
                LogLevel::ERROR => error!(
                    "[{}] [{}] {}: {:?}",
                    module, operation, log_entry.timestamp, log_entry.data
                ),
                LogLevel::WARN => warn!(
                    "[{}] [{}] {}: {:?}",
                    module, operation, log_entry.timestamp, log_entry.data
                ),
                LogLevel::INFO => info!(
                    "[{}] [{}] {}: {:?}",
                    module, operation, log_entry.timestamp, log_entry.data
                ),
                _ => tracing::debug!(
                    "[{}] [{}] {}: {:?}",
                    module,
                    operation,
                    log_entry.timestamp,
                    log_entry.data
                ),
            }
        }
    }

    /// 刷新日志到文件
    pub async fn flush_logs(&self) {
        let logs = {
            let mut queue = match self.log_queue.lock() {
                Ok(queue) => queue,
                Err(_) => return,
            };

            if queue.is_empty() {
                return;
            }

            let logs = queue.clone();
            queue.clear();
            logs
        };

        // 按日期和模块分组写入不同文件
        let mut grouped_logs: HashMap<(String, String), Vec<LogEntry>> = HashMap::new();

        for log in logs {
            let date = log
                .timestamp
                .split('T')
                .next()
                .unwrap_or("unknown")
                .to_string();
            let module_key = log.module.to_lowercase();
            let target_dir = if module_key.starts_with("frontend") {
                "frontend".to_string()
            } else {
                "backend".to_string()
            };
            let key = format!("{}_{}", date, module_key);
            grouped_logs
                .entry((target_dir, key))
                .or_insert_with(Vec::new)
                .push(log);
        }

        for ((target_dir, key), group_logs) in grouped_logs {
            let file_path = self.log_dir.join(target_dir).join(format!("{}.log", key));

            if let Err(e) = self.write_logs_to_file(&file_path, &group_logs) {
                error!("Failed to write logs to {}: {}", file_path.display(), e);
            }
        }
    }

    fn write_logs_to_file(
        &self,
        file_path: &PathBuf,
        logs: &[LogEntry],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(file_path)?;

        for log in logs {
            let log_line = serde_json::to_string(log)?;
            writeln!(file, "{}", log_line)?;
        }

        file.flush()?;
        Ok(())
    }

    fn sanitize_database_result(
        &self,
        result: Option<&serde_json::Value>,
    ) -> Option<serde_json::Value> {
        result.map(|r| {
            if let Some(arr) = r.as_array() {
                if arr.len() > 10 {
                    let preview: Vec<_> = arr.iter().take(5).cloned().collect();
                    serde_json::json!({
                        "_truncated": true,
                        "_count": arr.len(),
                        "_preview": preview
                    })
                } else {
                    r.clone()
                }
            } else {
                r.clone()
            }
        })
    }

    fn sanitize_chat_history(
        &self,
        chat_history: Option<&serde_json::Value>,
    ) -> Option<serde_json::Value> {
        chat_history.and_then(|ch| {
            ch.as_array().map(|arr| {
                if arr.len() > 10 {
                    let preview: Vec<_> = arr.iter().take(3).cloned().collect();
                    let latest: Vec<_> = arr
                        .iter()
                        .rev()
                        .take(2)
                        .cloned()
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    serde_json::json!({
                        "_truncated": true,
                        "_count": arr.len(),
                        "_preview": preview,
                        "_latest": latest
                    })
                } else {
                    serde_json::Value::Array(arr.clone())
                }
            })
        })
    }

    fn sanitize_api_body(&self, body: Option<&serde_json::Value>) -> Option<serde_json::Value> {
        body.map(|b| {
            let body_str = b.to_string();
            if body_str.len() > 1000 {
                let preview: String = body_str.chars().take(500).collect();
                serde_json::json!({
                    "_truncated": true,
                    "_size": body_str.len(),
                    "_preview": preview
                })
            } else {
                b.clone()
            }
        })
    }

    fn sanitize_state(&self, state: Option<&serde_json::Value>) -> Option<serde_json::Value> {
        state.map(|s| {
            // 移除大型数组和对象，只保留关键信息
            if let Some(obj) = s.as_object() {
                let mut sanitized = serde_json::Map::new();
                for (key, value) in obj {
                    match key.as_str() {
                        "chatHistory" | "thinkingContent" => {
                            if let Some(arr) = value.as_array() {
                                sanitized.insert(
                                    key.clone(),
                                    serde_json::json!({
                                        "_type": "array",
                                        "_length": arr.len()
                                    }),
                                );
                            } else {
                                sanitized.insert(
                                    key.clone(),
                                    serde_json::json!({
                                        "_type": "object",
                                        "_size": value.to_string().len()
                                    }),
                                );
                            }
                        }
                        _ => {
                            sanitized.insert(key.clone(), value.clone());
                        }
                    }
                }
                serde_json::Value::Object(sanitized)
            } else {
                s.clone()
            }
        })
    }

    fn calculate_state_diff(
        &self,
        old_state: Option<&serde_json::Value>,
        new_state: Option<&serde_json::Value>,
    ) -> serde_json::Value {
        match (old_state, new_state) {
            (Some(old), Some(new)) => {
                if let (Some(old_obj), Some(new_obj)) = (old.as_object(), new.as_object()) {
                    let mut diff = serde_json::Map::new();

                    // 检查所有键
                    let mut all_keys = std::collections::HashSet::new();
                    all_keys.extend(old_obj.keys());
                    all_keys.extend(new_obj.keys());

                    for key in all_keys {
                        let old_val = old_obj.get(key);
                        let new_val = new_obj.get(key);

                        if old_val != new_val {
                            diff.insert(
                                key.clone(),
                                serde_json::json!({
                                    "from": old_val,
                                    "to": new_val
                                }),
                            );
                        }
                    }

                    serde_json::Value::Object(diff)
                } else {
                    serde_json::json!({
                        "changed": old != new,
                        "from": old,
                        "to": new
                    })
                }
            }
            _ => serde_json::json!({
                "from": old_state,
                "to": new_state
            }),
        }
    }

    /// 记录LLM用量与性能（脱敏）
    pub async fn log_llm_usage(
        &self,
        stage: &str, // start | end
        provider: &str,
        model: &str,
        adapter: &str,
        request_bytes: usize,
        response_bytes: usize,
        approx_tokens_in: usize,
        approx_tokens_out: usize,
        duration_ms: Option<u128>,
        extra: Option<&serde_json::Value>,
    ) {
        let data = serde_json::json!({
            "stage": stage,
            "provider": provider,
            "model": model,
            "adapter": adapter,
            "request_bytes": request_bytes,
            "response_bytes": response_bytes,
            "approx_tokens_in": approx_tokens_in,
            "approx_tokens_out": approx_tokens_out,
            "duration_ms": duration_ms,
            "extra": extra
        });
        self.log(LogLevel::INFO, "LLM_USAGE", "usage", data, None)
            .await;
    }
}

// Tauri命令，用于从前端写入日志
#[tauri::command]
pub async fn write_debug_logs(app: tauri::AppHandle, logs: Vec<LogEntry>) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let logger = DebugLogger::new(app_data_dir);

    // 写入前端日志到frontend目录
    let frontend_dir = logger.log_dir.join("frontend");
    std::fs::create_dir_all(&frontend_dir).map_err(|e| e.to_string())?;

    // 按日期分组
    let mut grouped_logs: HashMap<String, Vec<LogEntry>> = HashMap::new();

    for log in logs {
        let date = log
            .timestamp
            .split('T')
            .next()
            .unwrap_or("unknown")
            .to_string();
        let key = format!("{}_{}", date, log.module.to_lowercase());
        grouped_logs.entry(key).or_insert_with(Vec::new).push(log);
    }

    for (key, group_logs) in grouped_logs {
        let file_path = frontend_dir.join(format!("{}.log", key));
        logger
            .write_logs_to_file(&file_path, &group_logs)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

// 全局日志记录器实例
static GLOBAL_LOGGER: LazyLock<Arc<Mutex<Option<DebugLogger>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(None)));

/// 初始化全局日志记录器
pub fn init_global_logger(app_data_dir: PathBuf) {
    *GLOBAL_LOGGER.lock().unwrap_or_else(|e| e.into_inner()) = Some(DebugLogger::new(app_data_dir));
}

/// 获取全局日志记录器
pub fn get_global_logger() -> Option<DebugLogger> {
    GLOBAL_LOGGER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// 便捷宏用于记录日志
#[macro_export]
macro_rules! debug_log {
    ($level:expr, $module:expr, $operation:expr, $data:expr) => {
        if let Some(logger) = crate::debug_logger::get_global_logger() {
            tokio::spawn(async move {
                logger.log($level, $module, $operation, $data, None).await;
            });
        }
    };
    ($level:expr, $module:expr, $operation:expr, $data:expr, $context:expr) => {
        if let Some(logger) = crate::debug_logger::get_global_logger() {
            tokio::spawn(async move {
                logger
                    .log($level, $module, $operation, $data, Some($context))
                    .await;
            });
        }
    };
}
