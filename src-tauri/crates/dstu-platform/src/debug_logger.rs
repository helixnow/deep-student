/**
 * 后端调试日志记录模块
 * 用于记录数据库操作、API调用、流式处理等关键信息
 */
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
    write_lock: Arc<Mutex<()>>,
}

impl DebugLogger {
    const MAX_LOG_AGE_DAYS: i64 = 7;
    const MAX_LOG_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024; // 10MB
    const MAX_ROTATED_FILES: usize = 5;

    /// 创建写入平台标准日志根目录的结构化日志记录器。
    pub fn new(log_dir: PathBuf) -> Self {
        if let Err(e) = std::fs::create_dir_all(log_dir.join("frontend")) {
            error!("Failed to create frontend log directory: {}", e);
        }
        if let Err(e) = std::fs::create_dir_all(log_dir.join("backend")) {
            error!("Failed to create backend log directory: {}", e);
        }
        if let Err(e) = std::fs::create_dir_all(log_dir.join("debug")) {
            error!("Failed to create debug log directory: {}", e);
        }

        let logger = Self {
            log_dir,
            log_queue: Arc::new(Mutex::new(Vec::new())),
            write_lock: Arc::new(Mutex::new(())),
        };

        logger.cleanup_old_logs();

        logger
    }

    fn bounded_text(value: &str, max_chars: usize) -> String {
        crate::debug_log_service::redact_sensitive_text(value)
            .chars()
            .take(max_chars)
            .collect()
    }

    fn safe_file_component(value: &str) -> String {
        let value: String = value
            .chars()
            .take(80)
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                    ch.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect();
        if value.is_empty() {
            "unknown".to_string()
        } else {
            value
        }
    }

    fn bounded_context(mut context: Option<LogContext>) -> Option<LogContext> {
        if let Some(value) = context.as_mut() {
            value.user_id = value
                .user_id
                .as_deref()
                .map(|text| Self::bounded_text(text, 256));
            value.session_id = value
                .session_id
                .as_deref()
                .map(|text| Self::bounded_text(text, 256));
            value.mistake_id = value
                .mistake_id
                .as_deref()
                .map(|text| Self::bounded_text(text, 256));
            value.stream_id = value
                .stream_id
                .as_deref()
                .map(|text| Self::bounded_text(text, 256));
            value.business_id = value
                .business_id
                .as_deref()
                .map(|text| Self::bounded_text(text, 256));
        }
        context
    }

    /// 清理过期日志。大小限制由写入时轮转处理，不能直接删除当前活跃文件。
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
                    Ok(meta) => meta
                        .modified()
                        .ok()
                        .and_then(|t| {
                            let duration = t.elapsed().ok()?;
                            Some(duration.as_secs() > (Self::MAX_LOG_AGE_DAYS as u64 * 86400))
                        })
                        .unwrap_or(false),
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
                "[DebugLogger] Cleaned up {} old log files ({:.1} MB)",
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
        let level = if error.is_some() || status_code.is_some_and(|code| code >= 400) {
            LogLevel::ERROR
        } else {
            LogLevel::INFO
        };

        let data = serde_json::json!({
            "method": method,
            "url": Self::sanitize_api_url(url),
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
        let redacted_data = crate::debug_log_service::redact_sensitive_fields(&data);
        let redacted_data = if serde_json::to_vec(&redacted_data)
            .map(|bytes| bytes.len() > 256 * 1024)
            .unwrap_or(true)
        {
            serde_json::json!({ "_truncated": true, "_reason": "entry exceeded 256 KiB" })
        } else {
            redacted_data
        };
        let log_entry = LogEntry {
            timestamp: Utc::now().to_rfc3339(),
            level: level.clone(),
            module: Self::bounded_text(module, 128),
            operation: Self::bounded_text(operation, 256),
            data: redacted_data,
            context: Self::bounded_context(context),
            // 调用方提供的 JS/Rust 原始 stack 才能指向故障现场；IPC 处理线程的
            // Rust backtrace 既无诊断价值又会让每条前端错误膨胀数十 KB。
            stack_trace: None,
        };

        // 添加到队列
        {
            let mut queue = self.log_queue.lock().unwrap_or_else(|e| e.into_inner());
            queue.push(log_entry.clone());
        }
        // 错误级别在 IPC 返回前完成写盘；普通日志由 5 秒周期任务批量刷盘。
        if matches!(level, LogLevel::ERROR) {
            self.flush_logs().await;
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
        let logger = self.clone();
        if let Err(error) =
            tauri::async_runtime::spawn_blocking(move || logger.flush_logs_sync()).await
        {
            error!("[DebugLogger] flush task failed: {}", error);
        }
    }

    fn flush_logs_sync(&self) {
        let _write_guard = match self.write_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let logs = {
            let mut queue = match self.log_queue.lock() {
                Ok(queue) => queue,
                Err(_) => return,
            };

            if queue.is_empty() {
                return;
            }

            std::mem::take(&mut *queue)
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
            let module_key = Self::safe_file_component(&log.module);
            let target_dir = if module_key.starts_with("frontend") {
                "frontend".to_string()
            } else {
                "backend".to_string()
            };
            let key = format!("{}_{}", date, module_key);
            grouped_logs.entry((target_dir, key)).or_default().push(log);
        }

        for ((target_dir, key), group_logs) in grouped_logs {
            let file_path = self.log_dir.join(target_dir).join(format!("{}.log", key));

            if let Err(e) = self.write_logs_to_file(&file_path, &group_logs) {
                error!("Failed to write logs to {}: {}", file_path.display(), e);
                // 写盘失败时恢复队列，避免瞬时文件系统错误直接吞掉诊断现场。
                self.log_queue
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend(group_logs);
            }
        }
    }

    pub fn write_frontend_entries(&self, logs: Vec<LogEntry>) -> Result<(), String> {
        let _write_guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut normalized_logs = Vec::new();
        let mut accepted_bytes = 0usize;
        let offered_count = logs.len();
        for mut log in logs.into_iter().rev().take(500) {
            log.timestamp = Self::bounded_text(&log.timestamp, 64);
            log.module = Self::bounded_text(&log.module, 128);
            log.operation = Self::bounded_text(&log.operation, 256);
            let redacted_data = crate::debug_log_service::redact_sensitive_fields(&log.data);
            log.data = if serde_json::to_vec(&redacted_data)
                .map(|bytes| bytes.len() > 256 * 1024)
                .unwrap_or(true)
            {
                serde_json::json!({ "_truncated": true, "_reason": "entry exceeded 256 KiB" })
            } else {
                redacted_data
            };
            log.stack_trace = log
                .stack_trace
                .as_deref()
                .map(|value| Self::bounded_text(value, 64_000));
            log.context = Self::bounded_context(log.context);
            let entry_bytes = serde_json::to_vec(&log)
                .map(|bytes| bytes.len())
                .unwrap_or(0);
            if accepted_bytes.saturating_add(entry_bytes) > 10 * 1024 * 1024 {
                break;
            }
            accepted_bytes = accepted_bytes.saturating_add(entry_bytes);
            normalized_logs.push(log);
        }
        normalized_logs.reverse();
        if normalized_logs.len() < offered_count {
            normalized_logs.insert(
                0,
                LogEntry {
                    timestamp: Utc::now().to_rfc3339(),
                    level: LogLevel::WARN,
                    module: "FRONTEND".to_string(),
                    operation: "LOG_BATCH_TRUNCATED".to_string(),
                    data: serde_json::json!({
                        "offered_count": offered_count,
                        "persisted_count": normalized_logs.len(),
                        "limit_bytes": 10 * 1024 * 1024,
                    }),
                    context: None,
                    stack_trace: None,
                },
            );
        }
        if normalized_logs.is_empty() {
            return Ok(());
        }
        let file_path = self
            .log_dir
            .join("frontend")
            .join(format!("{}_frontend.log", Utc::now().format("%Y-%m-%d")));
        self.write_logs_to_file(&file_path, &normalized_logs)
            .map_err(|e| e.to_string())
    }

    fn write_logs_to_file(
        &self,
        file_path: &PathBuf,
        logs: &[LogEntry],
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut payload = String::new();
        for log in logs {
            payload.push_str(&serde_json::to_string(log)?);
            payload.push('\n');
        }

        self.rotate_if_needed(file_path, payload.len() as u64)?;

        let mut open_options = OpenOptions::new();
        open_options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open_options.mode(0o600);
        }
        let mut file = open_options.open(file_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(payload.as_bytes())?;
        file.flush()?;
        file.sync_data()?;
        Ok(())
    }

    fn rotate_if_needed(
        &self,
        file_path: &PathBuf,
        incoming_bytes: u64,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let current_bytes = fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
        if current_bytes == 0
            || current_bytes.saturating_add(incoming_bytes) <= Self::MAX_LOG_FILE_SIZE_BYTES
        {
            return Ok(());
        }

        for index in (1..=Self::MAX_ROTATED_FILES).rev() {
            let source = if index == 1 {
                file_path.clone()
            } else {
                Self::rotated_path(file_path, index - 1)
            };
            let destination = Self::rotated_path(file_path, index);
            if !source.exists() {
                continue;
            }
            if destination.exists() {
                fs::remove_file(&destination)?;
            }
            fs::rename(source, destination)?;
        }
        Ok(())
    }

    fn rotated_path(file_path: &std::path::Path, index: usize) -> PathBuf {
        let mut file_name = file_path.file_name().unwrap_or_default().to_os_string();
        file_name.push(format!(".{}", index));
        file_path.with_file_name(file_name)
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
                let messages: Vec<_> = arr
                    .iter()
                    .map(|message| {
                        let role = message
                            .get("role")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown");
                        let content_size = message
                            .get("content")
                            .map(|content| content.to_string().chars().count())
                            .unwrap_or_default();
                        serde_json::json!({
                            "role": role,
                            "content_size": content_size,
                            "has_tool_calls": message.get("tool_calls").is_some(),
                            "has_tool_result": message.get("tool_result").is_some()
                        })
                    })
                    .collect();
                serde_json::json!({
                    "_redacted": true,
                    "_count": arr.len(),
                    "messages": messages
                })
            })
        })
    }

    fn sanitize_api_url(raw_url: &str) -> String {
        let Ok(mut parsed) = url::Url::parse(raw_url) else {
            return "[unparseable URL redacted]".to_string();
        };
        let _ = parsed.set_username("");
        let _ = parsed.set_password(None);
        let query_pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        if !query_pairs.is_empty() {
            parsed.set_query(None);
            let mut query = parsed.query_pairs_mut();
            for (name, value) in query_pairs {
                let normalized = name.to_ascii_lowercase();
                let sensitive = normalized.contains("key")
                    || normalized.contains("token")
                    || normalized.contains("secret")
                    || normalized.contains("signature")
                    || normalized.contains("credential")
                    || normalized.contains("auth")
                    || normalized == "code"
                    || normalized == "sig";
                query.append_pair(&name, if sensitive { "[REDACTED]" } else { &value });
            }
        }
        parsed.to_string()
    }

    fn sanitize_api_body(&self, body: Option<&serde_json::Value>) -> Option<serde_json::Value> {
        body.map(|value| {
            let serialized_size = value.to_string().len();
            let Some(object) = value.as_object() else {
                return serde_json::json!({
                    "_redacted": true,
                    "_type": if value.is_array() { "array" } else { "scalar" },
                    "_size": serialized_size
                });
            };
            let mut summary = serde_json::Map::new();
            summary.insert("_redacted".to_string(), serde_json::Value::Bool(true));
            summary.insert("_size".to_string(), serde_json::json!(serialized_size));
            summary.insert(
                "_keys".to_string(),
                serde_json::json!(object.keys().collect::<Vec<_>>()),
            );
            for safe_key in [
                "model",
                "stream",
                "max_tokens",
                "max_completion_tokens",
                "max_output_tokens",
            ] {
                if let Some(safe_value) = object.get(safe_key) {
                    summary.insert(safe_key.to_string(), safe_value.clone());
                }
            }
            for content_key in ["messages", "input", "contents", "tools", "output"] {
                if let Some(content) = object.get(content_key) {
                    let count = content
                        .as_array()
                        .map(Vec::len)
                        .or_else(|| content.as_object().map(serde_json::Map::len))
                        .unwrap_or(1);
                    summary.insert(format!("{content_key}_count"), serde_json::json!(count));
                }
            }
            if let Some(error) = object.get("error").and_then(serde_json::Value::as_object) {
                summary.insert(
                    "error_type".to_string(),
                    error
                        .get("type")
                        .or_else(|| error.get("code"))
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            serde_json::Value::Object(summary)
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
    let logger = get_global_logger().unwrap_or_else(|| {
        let log_dir = app
            .path()
            .app_log_dir()
            .or_else(|_| app.path().app_data_dir().map(|path| path.join("logs")))
            .unwrap_or_else(|_| std::env::temp_dir().join("deep-student").join("logs"));
        DebugLogger::new(log_dir)
    });
    tauri::async_runtime::spawn_blocking(move || logger.write_frontend_entries(logs))
        .await
        .map_err(|e| format!("frontend log task failed: {}", e))?
}

// 全局日志记录器实例
static GLOBAL_LOGGER: LazyLock<Arc<Mutex<Option<DebugLogger>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(None)));

/// 初始化全局日志记录器
pub fn init_global_logger(log_dir: PathBuf) {
    *GLOBAL_LOGGER.lock().unwrap_or_else(|e| e.into_inner()) = Some(DebugLogger::new(log_dir));
}

/// 获取全局日志记录器
pub fn get_global_logger() -> Option<DebugLogger> {
    GLOBAL_LOGGER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

pub fn start_periodic_flush() {
    tauri::async_runtime::spawn(async {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Some(logger) = get_global_logger() {
                logger.flush_logs().await;
            }
        }
    });
}

pub async fn flush_global_logger() {
    if let Some(logger) = get_global_logger() {
        logger.flush_logs().await;
    }
}

/// 便捷宏用于记录日志
#[macro_export]
macro_rules! debug_log {
    ($level:expr, $module:expr, $operation:expr, $data:expr) => {
        if let Some(logger) = $crate::debug_logger::get_global_logger() {
            tokio::spawn(async move {
                logger.log($level, $module, $operation, $data, None).await;
            });
        }
    };
    ($level:expr, $module:expr, $operation:expr, $data:expr, $context:expr) => {
        if let Some(logger) = $crate::debug_logger::get_global_logger() {
            tokio::spawn(async move {
                logger
                    .log($level, $module, $operation, $data, Some($context))
                    .await;
            });
        }
    };
}
