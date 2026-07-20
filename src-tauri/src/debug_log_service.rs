//! 调试日志持久化服务
//!
//! 将 LLM 请求体以 JSON 文件持久化到 `{app_log_dir}/debug-logs/` 目录，
//! 支持按过滤级别控制复制内容，以及按时间或手动清理旧日志。

use chrono::Local;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::LazyLock;

const DEBUG_LOGS_DIR: &str = "debug-logs";
const MAX_DEBUG_LOG_BYTES: usize = 5 * 1024 * 1024;

static SECRET_VALUE_PATTERNS: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
    vec![
        regex::Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}\b")
            .expect("valid bearer regex"),
        regex::Regex::new(r"\bsk-[A-Za-z0-9_-]{12,}\b").expect("valid API key regex"),
        regex::Regex::new(r"(?i)([?&](?:key|api_key|token|access_token)=)[^&\s]+")
            .expect("valid query credential regex"),
        regex::Regex::new(r"(?i)https?://[^/@\s:]+:[^/@\s]+@")
            .expect("valid URL userinfo regex"),
        regex::Regex::new(
            r"(?is)-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----.*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----",
        )
        .expect("valid private key regex"),
        regex::Regex::new(
            r#"(?i)(?:api[-_ ]?key|x[-_ ]?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|cookie|password|passwd|client[-_ ]?secret|private[-_ ]?key)\s*[:=]\s*["']?[^"',\s}\]]{4,}"#,
        )
        .expect("valid textual credential regex"),
    ]
});

pub fn redact_sensitive_text(input: &str) -> String {
    let mut output = input.to_string();
    for pattern in SECRET_VALUE_PATTERNS.iter() {
        output = pattern.replace_all(&output, "[REDACTED]").into_owned();
    }
    output
}

// ============================================================================
// 过滤级别
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DebugFilterLevel {
    /// 完整：保留 base64 图片与完整 tool schema，但凭据字段始终脱敏
    Full,
    /// 标准：base64 替换为占位符，tools 简化为摘要（默认）
    Standard,
    /// 精简：仅保留元数据骨架（model、消息角色列表、工具名列表）
    Compact,
}

impl DebugFilterLevel {
    pub fn from_str_lossy(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "full" => Self::Full,
            "compact" => Self::Compact,
            _ => Self::Standard,
        }
    }
}

/// 按过滤级别对请求体脱敏
pub fn sanitize_for_level(body: &Value, level: DebugFilterLevel) -> Value {
    let body = redact_sensitive_fields(body);
    match level {
        DebugFilterLevel::Full => body,
        DebugFilterLevel::Standard => sanitize_standard(&body),
        DebugFilterLevel::Compact => sanitize_compact(&body),
    }
}

/// API 密钥、口令与授权头在任何过滤级别都不得落盘。
pub fn redact_sensitive_fields(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut redacted = serde_json::Map::with_capacity(map.len());
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                let is_secret = matches!(
                    normalized.as_str(),
                    "apikey"
                        | "authorization"
                        | "token"
                        | "accesstoken"
                        | "refreshtoken"
                        | "idtoken"
                        | "cookie"
                        | "setcookie"
                        | "credential"
                        | "credentials"
                        | "password"
                        | "passwd"
                        | "secret"
                        | "secretkey"
                        | "clientsecret"
                        | "privatekey"
                ) || normalized.ends_with("apikey")
                    || normalized.ends_with("token")
                    || normalized.ends_with("password")
                    || normalized.ends_with("secret")
                    || normalized.ends_with("privatekey")
                    || normalized.ends_with("cookie");
                redacted.insert(
                    key.clone(),
                    if is_secret {
                        Value::String("[REDACTED]".to_string())
                    } else {
                        redact_sensitive_fields(child)
                    },
                );
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_sensitive_fields).collect()),
        Value::String(value) => Value::String(redact_sensitive_text(value)),
        _ => value.clone(),
    }
}

/// 标准脱敏：替换 base64 图片（含准确大小信息）+ 简化 tools
fn sanitize_standard(body: &Value) -> Value {
    let mut s = body.clone();
    redact_embedded_binary_values(&mut s);

    if let Some(messages) = s.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for message in messages.iter_mut() {
            if let Some(content) = message.get_mut("content").and_then(|c| c.as_array_mut()) {
                for part in content.iter_mut() {
                    if part.get("type").and_then(|t| t.as_str()) == Some("image_url") {
                        if let Some(url_val) =
                            part.get_mut("image_url").and_then(|iu| iu.get_mut("url"))
                        {
                            if let Some(url_str) = url_val.as_str() {
                                if url_str.starts_with("data:") {
                                    let total_len = url_str.len();
                                    // 计算纯 base64 部分长度（去掉 data:xxx;base64, 前缀）
                                    let base64_len = url_str
                                        .find(",")
                                        .map(|i| total_len - i - 1)
                                        .unwrap_or(total_len);
                                    let approx_bytes = base64_len * 3 / 4;
                                    *url_val = json!(format!(
                                        "[base64 image: ~{}KB, {} chars]",
                                        approx_bytes / 1024,
                                        base64_len
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(tools) = s.get_mut("tools").and_then(|t| t.as_array_mut()) {
        let count = tools.len();
        let names: Vec<String> = tools
            .iter()
            .filter_map(|t| {
                t.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        *tools = vec![json!({
            "_summary": format!("{} tools: [{}]", count, names.join(", "))
        })];
    }

    s
}

fn redact_embedded_binary_values(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                let binary_field = matches!(
                    normalized.as_str(),
                    "data" | "url" | "image" | "imageurl" | "inlineimage"
                );
                if binary_field {
                    if let Value::String(text) = child {
                        let trimmed = text.trim();
                        let likely_base64 = trimmed.starts_with("data:")
                            || (trimmed.len() > 4_096
                                && trimmed.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric()
                                        || matches!(byte, b'+' | b'/' | b'=' | b'_' | b'-')
                                }));
                        if likely_base64 {
                            let original_chars = text.chars().count();
                            *child = json!({
                                "_redacted": true,
                                "_type": "embedded_binary",
                                "_original_chars": original_chars,
                            });
                            continue;
                        }
                    }
                }
                redact_embedded_binary_values(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_embedded_binary_values(item);
            }
        }
        _ => {}
    }
}

/// 精简脱敏：只保留骨架信息
fn sanitize_compact(body: &Value) -> Value {
    let mut result = json!({});
    let obj = result.as_object_mut().unwrap();

    if let Some(model) = body.get("model") {
        obj.insert("model".into(), model.clone());
    }
    if let Some(stream) = body.get("stream") {
        obj.insert("stream".into(), stream.clone());
    }

    // messages → 仅保留角色列表 + 内容类型
    if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
        let summary: Vec<Value> = messages
            .iter()
            .map(|msg| {
                let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("?");
                let content_type = if msg.get("content").and_then(|c| c.as_array()).is_some() {
                    "multimodal"
                } else {
                    "text"
                };
                let content_len = match msg.get("content") {
                    Some(Value::String(s)) => s.len(),
                    Some(Value::Array(arr)) => arr.len(),
                    _ => 0,
                };
                json!({
                    "role": role,
                    "content_type": content_type,
                    "content_size": content_len,
                })
            })
            .collect();
        obj.insert("messages_summary".into(), json!(summary));
    }

    // tools → 仅保留名称列表
    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| {
                t.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
            })
            .collect();
        obj.insert("tool_names".into(), json!(names));
    }

    // 透传其他标量参数
    for key in &[
        "temperature",
        "max_tokens",
        "max_completion_tokens",
        "enable_thinking",
        "thinking_budget",
        "tool_choice",
    ] {
        if let Some(v) = body.get(*key) {
            obj.insert((*key).to_string(), v.clone());
        }
    }
    // thinking 对象
    if let Some(v) = body.get("thinking") {
        obj.insert("thinking".to_string(), v.clone());
    }

    result
}

// ============================================================================
// 文件持久化
// ============================================================================

/// 确保 debug-logs 目录存在，返回路径
pub fn ensure_debug_log_dir(log_root: &Path) -> PathBuf {
    let dir = log_root.join(DEBUG_LOGS_DIR);
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

static SEQ_COUNTER: AtomicU32 = AtomicU32::new(0);
static PENDING_WRITES: AtomicUsize = AtomicUsize::new(0);

struct PendingWriteGuard;

impl Drop for PendingWriteGuard {
    fn drop(&mut self) {
        PENDING_WRITES.fetch_sub(1, Ordering::Release);
    }
}

pub async fn flush_pending_debug_log_writes() -> bool {
    let started = std::time::Instant::now();
    while PENDING_WRITES.load(Ordering::Acquire) > 0 {
        if started.elapsed() >= std::time::Duration::from_secs(10) {
            warn!(
                "[DebugLog] Timed out waiting for {} pending writes",
                PENDING_WRITES.load(Ordering::Acquire)
            );
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    true
}

/// 单次清理检查的文件数阈值（超过此数自动淘汰最旧的 10%）
const AUTO_CLEANUP_THRESHOLD: usize = 500;

/// 写入一条凭据脱敏、大小受限的详细调试日志，返回预期文件路径。
///
/// 序列化在调用线程完成（获取路径需要同步返回），实际磁盘写入通过
/// Tauri blocking 线程池异步执行，并以临时文件 + rename 原子提交。
/// 自动维护文件数上限（超过 500 个时淘汰最旧文件）。
pub fn write_debug_log_entry(
    log_dir: &Path,
    tag: &str,
    model: &str,
    url: &str,
    stream_event: &str,
    request_body: &Value,
) -> Option<PathBuf> {
    let timestamp = Local::now();
    let time_str = timestamp.format("%Y-%m-%dT%H-%M-%S%.3f").to_string();
    let seq = SEQ_COUNTER.fetch_add(1, Ordering::Relaxed) % 10000;
    let model_short = model.split('/').next_back().unwrap_or(model);
    let model_safe: String = model_short
        .chars()
        .take(80)
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let tag_safe: String = tag
        .chars()
        .take(80)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();

    let filename = format!(
        "{}_{:04}_{}_{}.json",
        time_str,
        seq,
        if model_safe.is_empty() {
            "unknown"
        } else {
            model_safe.as_str()
        },
        if tag_safe.is_empty() {
            "unknown"
        } else {
            tag_safe.as_str()
        },
    );
    let filepath = log_dir.join(&filename);

    let entry = json!({
        "version": 1,
        "timestamp": timestamp.to_rfc3339(),
        "tag": redact_sensitive_text(tag),
        "model": redact_sensitive_text(model),
        "url": redact_sensitive_text(url),
        "stream_event": redact_sensitive_text(stream_event),
        "request_body": redact_sensitive_fields(request_body),
    });

    let mut json_str = match serde_json::to_string_pretty(&entry) {
        Ok(s) => s,
        Err(e) => {
            warn!("[DebugLog] Serialize failed: {}", e);
            return None;
        }
    };
    if json_str.len() > MAX_DEBUG_LOG_BYTES {
        let truncated_entry = json!({
            "version": 1,
            "timestamp": timestamp.to_rfc3339(),
            "tag": redact_sensitive_text(tag),
            "model": redact_sensitive_text(model),
            "url": redact_sensitive_text(url),
            "stream_event": redact_sensitive_text(stream_event),
            "request_body": {
                "_truncated": true,
                "_reason": "request log exceeded 5 MiB",
                "_serialized_bytes": json_str.len(),
            },
        });
        json_str = serde_json::to_string_pretty(&truncated_entry).unwrap_or_else(|_| {
            "{\"version\":1,\"request_body\":{\"_truncated\":true}}".to_string()
        });
    }

    let result_path = filepath.clone();
    let log_dir_owned = log_dir.to_path_buf();
    let filename_clone = filename.clone();
    let json_len = json_str.len();

    PENDING_WRITES.fetch_add(1, Ordering::Release);
    tauri::async_runtime::spawn_blocking(move || {
        let _pending_guard = PendingWriteGuard;
        let temporary = filepath.with_extension(format!("json.tmp-{}", seq));
        let write_result = (|| -> std::io::Result<()> {
            fs::create_dir_all(&log_dir_owned)?;
            let mut options = OpenOptions::new();
            options.create(true).write(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(json_str.as_bytes())?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &filepath)?;
            #[cfg(unix)]
            fs::File::open(&log_dir_owned)?.sync_all()?;
            Ok(())
        })();
        match write_result {
            Ok(_) => info!("[DebugLog] Wrote: {} ({} bytes)", filename_clone, json_len),
            Err(e) => {
                let _ = fs::remove_file(&temporary);
                warn!("[DebugLog] Write failed {}: {}", filename_clone, e);
            }
        }
        if seq % 50 == 0 {
            auto_cleanup_if_needed(&log_dir_owned);
        }
    });

    Some(result_path)
}

// ============================================================================
// 日志查询与清理
// ============================================================================

#[derive(Debug, Serialize)]
pub struct DebugLogsInfo {
    pub count: usize,
    pub total_size_bytes: u64,
    pub total_size_display: String,
    pub oldest_file: Option<String>,
    pub newest_file: Option<String>,
}

fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

/// 列出 debug-logs 目录下的 .json 文件（按文件名排序）
fn list_log_files(log_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = log_roots
        .iter()
        .flat_map(|root| list_log_files_in(&root.join(DEBUG_LOGS_DIR)))
        .collect::<Vec<_>>();
    files.sort();
    files.dedup();
    files
}

pub fn get_debug_logs_info(log_roots: &[PathBuf]) -> DebugLogsInfo {
    let files = list_log_files(log_roots);
    let total_size: u64 = files
        .iter()
        .filter_map(|f| fs::metadata(f).ok())
        .map(|m| m.len())
        .sum();
    let oldest = files.first().and_then(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
    });
    let newest = files.last().and_then(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
    });

    DebugLogsInfo {
        count: files.len(),
        total_size_bytes: total_size,
        total_size_display: format_size(total_size),
        oldest_file: oldest,
        newest_file: newest,
    }
}

/// 删除所有调试日志
pub fn clear_all_debug_logs(log_roots: &[PathBuf]) -> Result<usize, String> {
    let files = list_log_files(log_roots);
    let mut removed = 0;
    for f in &files {
        if fs::remove_file(f).is_ok() {
            removed += 1;
        }
    }
    info!("[DebugLog] Cleared {} / {} log files", removed, files.len());
    Ok(removed)
}

/// 删除超过 max_age_days 天的日志
pub fn cleanup_old_debug_logs(log_roots: &[PathBuf], max_age_days: u32) -> Result<usize, String> {
    let files = list_log_files(log_roots);
    let cutoff =
        std::time::SystemTime::now() - std::time::Duration::from_secs(max_age_days as u64 * 86400);
    let mut removed = 0;

    for f in &files {
        let modified = fs::metadata(f)
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::SystemTime::now());
        if modified < cutoff && fs::remove_file(f).is_ok() {
            removed += 1;
        }
    }
    info!(
        "[DebugLog] Cleaned up {} old log files (>{} days)",
        removed, max_age_days
    );
    Ok(removed)
}

/// 自动清理：超过阈值时删除最旧的文件
fn auto_cleanup_if_needed(log_dir: &Path) {
    let files = list_log_files_in(log_dir);
    if files.len() <= AUTO_CLEANUP_THRESHOLD {
        return;
    }
    let to_remove = files.len() / 10; // 淘汰最旧 10%
    let mut removed = 0;
    for f in files.iter().take(to_remove) {
        if fs::remove_file(f).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        info!(
            "[DebugLog] Auto-cleanup: removed {} oldest files (total was {})",
            removed,
            files.len()
        );
    }
}

/// 列出指定目录下的 .json 文件（按文件名排序）
fn list_log_files_in(dir: &Path) -> Vec<PathBuf> {
    if !dir.exists() {
        return vec![];
    }
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    files.sort();
    files
}

/// 读取当前或旧版本调试日志文件。
pub fn read_debug_log_file(path: &Path, log_roots: &[PathBuf]) -> Result<String, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("路径解析失败: {}", e))?;
    let allowed = log_roots.iter().any(|root| {
        let allowed_dir = root.join(DEBUG_LOGS_DIR);
        let allowed_canonical = allowed_dir.canonicalize().unwrap_or(allowed_dir);
        canonical.starts_with(allowed_canonical)
    });
    if !allowed {
        return Err("非法路径：不在 debug-logs 目录中".to_string());
    }
    if canonical.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err("非法文件类型：仅允许读取 .json 文件".to_string());
    }
    fs::read_to_string(&canonical).map_err(|e| format!("读取调试日志失败: {}", e))
}
