//! 用户可反馈的诊断包。
//!
//! 默认收集平台日志目录与旧版本遗留日志，统一脱敏后写入 ZIP。
//! 完整 LLM 请求日志属于高敏感内容，只有用户明确选择时才包含。

use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;
use zip::write::FileOptions;

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_BUNDLE_BYTES: u64 = 100 * 1024 * 1024;

static SECRET_PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(
                r#"(?i)\b((?:https?|tauri|asset|file)://[^\s"'<>?#]+)[?#][^\s"'<>]*"#,
            )
            .expect("valid URL query regex"),
            "${1}",
        ),
        (
            Regex::new(
                r#"(?i)(["']?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|cookie|set[_-]?cookie|credential|password|passwd|private[_-]?key|secret[_-]?key|client[_-]?secret|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]{4,}"#,
            )
            .expect("valid secret field regex"),
            "${1}[REDACTED]",
        ),
        (
            Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}")
                .expect("valid bearer regex"),
            "${1}[REDACTED]",
        ),
        (
            Regex::new(r"(?i)([?&](?:key|api_key|token|access_token)=)[^&\s]+")
                .expect("valid query secret regex"),
            "${1}[REDACTED]",
        ),
        (
            Regex::new(r"\bsk-[A-Za-z0-9_-]{12,}\b").expect("valid API key regex"),
            "[REDACTED_API_KEY]",
        ),
        (
            Regex::new(
                r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
            )
            .expect("valid private key regex"),
            "[REDACTED_PRIVATE_KEY]",
        ),
    ]
});

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportOptions {
    pub destination: String,
    #[serde(default)]
    pub include_debug_logs: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportResult {
    pub path: String,
    pub file_count: usize,
    pub skipped_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
struct DiagnosticsManifest {
    generated_at: String,
    app_version: &'static str,
    build_number: &'static str,
    git_hash: &'static str,
    os: &'static str,
    arch: &'static str,
    include_debug_logs: bool,
    file_count: usize,
    skipped: Vec<String>,
    notes: Vec<&'static str>,
}

struct LogSource {
    label: &'static str,
    path: PathBuf,
}

struct TemporaryFileGuard(Option<PathBuf>);

impl TemporaryFileGuard {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for TemporaryFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn sanitize_log_text(input: &str, include_detailed_content: bool) -> String {
    let mut value = strip_legacy_llm_audit(input);
    value = redact_json_content(&value, include_detailed_content);
    value = crate::crash_logger::scrub_pii(&value);
    for (pattern, replacement) in SECRET_PATTERNS.iter() {
        value = pattern.replace_all(&value, *replacement).into_owned();
    }
    value
}

fn redact_json_content(input: &str, include_detailed_content: bool) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(input) {
        let redacted = crate::debug_log_service::redact_sensitive_fields(&value);
        let redacted = redact_user_content(&redacted, include_detailed_content);
        return serde_json::to_string_pretty(&redacted).unwrap_or_else(|_| input.to_string());
    }

    let mut output = String::with_capacity(input.len());
    for line in input.lines() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            let redacted = crate::debug_log_service::redact_sensitive_fields(&value);
            let redacted = redact_user_content(&redacted, include_detailed_content);
            output.push_str(&serde_json::to_string(&redacted).unwrap_or_else(|_| line.to_string()));
        } else {
            output.push_str(line);
        }
        output.push('\n');
    }
    output
}

fn redact_user_content(value: &serde_json::Value, include_detailed: bool) -> serde_json::Value {
    if include_detailed {
        return value.clone();
    }
    match value {
        serde_json::Value::Object(map) => {
            let mut output = serde_json::Map::with_capacity(map.len());
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                let contains_user_content = matches!(
                    normalized.as_str(),
                    "content"
                        | "text"
                        | "query"
                        | "prompt"
                        | "request"
                        | "response"
                        | "requestbody"
                        | "responsebody"
                        | "chathistory"
                        | "expectedchathistory"
                        | "actualchathistory"
                        | "thinkingcontent"
                        | "ragsources"
                );
                output.insert(
                    key.clone(),
                    if contains_user_content {
                        match child {
                            serde_json::Value::String(text) => serde_json::Value::String(format!(
                                "[CONTENT REDACTED: {} chars]",
                                text.chars().count()
                            )),
                            serde_json::Value::Array(items) => serde_json::Value::String(format!(
                                "[CONTENT REDACTED: {} items]",
                                items.len()
                            )),
                            _ => serde_json::Value::String("[CONTENT REDACTED]".to_string()),
                        }
                    } else {
                        redact_user_content(child, false)
                    },
                );
            }
            serde_json::Value::Object(output)
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| redact_user_content(item, false))
                .collect(),
        ),
        _ => value.clone(),
    }
}

/// 旧版会把格式化后的完整 LLM 请求体写入主日志。丢弃该多行块，只保留占位信息。
fn strip_legacy_llm_audit(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut skipping_payload = false;

    for line in input.lines() {
        if line.contains("[LLM_AUDIT:") {
            output.push_str("[LLM_AUDIT] request payload omitted from diagnostics\n");
            skipping_payload = true;
            continue;
        }

        if skipping_payload {
            let looks_like_new_record =
                line.starts_with("[[") || line.starts_with('[') && line.contains("][");
            if !looks_like_new_record {
                continue;
            }
            skipping_payload = false;
        }
        output.push_str(line);
        output.push('\n');
    }
    output
}

fn collect_sources(app: &AppHandle, include_debug_logs: bool) -> Result<Vec<LogSource>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("deep-student"));
    let log_root = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| app_data.join("logs"));
    let mut sources = vec![LogSource {
        label: "current",
        path: log_root,
    }];

    let legacy = [
        ("legacy/app-data-logs", app_data.join("logs"), false),
        (
            "legacy/app-data-debug-logs",
            app_data.join("debug-logs"),
            true,
        ),
        (
            "legacy/slotA-logs",
            app_data.join("slots").join("slotA").join("logs"),
            false,
        ),
        (
            "legacy/slotA-debug-logs",
            app_data.join("slots").join("slotA").join("debug-logs"),
            true,
        ),
        (
            "legacy/slotB-logs",
            app_data.join("slots").join("slotB").join("logs"),
            false,
        ),
        (
            "legacy/slotB-debug-logs",
            app_data.join("slots").join("slotB").join("debug-logs"),
            true,
        ),
    ];

    for (label, path, sensitive) in legacy {
        if path.exists() && (!sensitive || include_debug_logs) {
            sources.push(LogSource { label, path });
        }
    }
    Ok(sources)
}

fn normalized_zip_path(label: &str, relative: &Path) -> String {
    let relative = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    format!("{}/{}", label.trim_matches('/'), relative)
}

fn export_bundle_sync(
    app: &AppHandle,
    options: DiagnosticsExportOptions,
) -> Result<DiagnosticsExportResult, String> {
    let destination = PathBuf::from(&options.destination);
    if !destination.is_absolute() {
        return Err("诊断包保存路径必须是绝对路径".to_string());
    }
    if destination.is_dir() {
        return Err("诊断包保存路径不能是目录".to_string());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "诊断包保存路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("创建保存目录失败: {}", e))?;

    let temporary = parent.join(format!(
        ".deep-student-diagnostics-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let file = fs::File::create(&temporary).map_err(|e| format!("创建诊断包失败: {}", e))?;
    let mut temporary_guard = TemporaryFileGuard(Some(temporary.clone()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置诊断包权限失败: {}", e))?;
    }
    let mut zip = zip::ZipWriter::new(file);
    let zip_options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);

    let sources = collect_sources(app, options.include_debug_logs)?;
    let mut canonical_roots = HashSet::new();
    let mut file_count = 0usize;
    let mut total_source_bytes = 0u64;
    let mut skipped = Vec::new();

    for source in sources {
        let canonical_root = source.path.canonicalize().unwrap_or(source.path.clone());
        if !canonical_roots.insert(canonical_root.clone()) {
            continue;
        }

        for entry in WalkDir::new(&canonical_root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if path == destination || path == temporary {
                continue;
            }
            if !options.include_debug_logs
                && path
                    .components()
                    .any(|part| part.as_os_str() == "debug-logs")
            {
                continue;
            }

            let relative = match path.strip_prefix(&canonical_root) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let archive_path = normalized_zip_path(source.label, relative);
            let file_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if file_bytes > MAX_FILE_BYTES {
                skipped.push(format!("{}: file exceeds 20 MB", archive_path));
                continue;
            }
            if total_source_bytes.saturating_add(file_bytes) > MAX_BUNDLE_BYTES {
                skipped.push(format!("{}: bundle exceeds 100 MB", archive_path));
                continue;
            }

            let raw = match fs::read(path) {
                Ok(value) => value,
                Err(error) => {
                    skipped.push(format!("{}: {}", archive_path, error));
                    continue;
                }
            };
            let text = String::from_utf8_lossy(&raw);
            let sanitized = sanitize_log_text(&text, options.include_debug_logs);
            zip.start_file(archive_path.as_str(), zip_options)
                .map_err(|e| format!("写入诊断包失败: {}", e))?;
            zip.write_all(sanitized.as_bytes())
                .map_err(|e| format!("写入诊断包失败: {}", e))?;
            total_source_bytes = total_source_bytes.saturating_add(file_bytes);
            file_count += 1;
        }
    }

    let manifest = DiagnosticsManifest {
        generated_at: Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION"),
        build_number: env!("BUILD_NUMBER"),
        git_hash: env!("GIT_HASH"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        include_debug_logs: options.include_debug_logs,
        file_count,
        skipped: skipped.clone(),
        notes: vec![
            "Absolute user paths and common credential formats were redacted.",
            "Legacy LLM request payloads were removed from runtime logs.",
            "Common user-content fields are summarized unless detailed request logs were explicitly included.",
            "The bundle intentionally contains no databases or user documents.",
        ],
    };
    zip.start_file("manifest.json", zip_options)
        .map_err(|e| format!("写入清单失败: {}", e))?;
    let manifest_json =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("生成清单失败: {}", e))?;
    zip.write_all(&manifest_json)
        .map_err(|e| format!("写入清单失败: {}", e))?;
    zip.finish()
        .map_err(|e| format!("完成诊断包失败: {}", e))?
        .sync_all()
        .map_err(|e| format!("同步诊断包失败: {}", e))?;

    let backup = destination.with_extension(format!("diagnostics-backup-{}", uuid::Uuid::new_v4()));
    let replacing_existing = destination.exists();
    if replacing_existing {
        fs::rename(&destination, &backup).map_err(|e| format!("无法替换已有诊断包: {}", e))?;
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        if replacing_existing {
            if let Err(restore_error) = fs::rename(&backup, &destination) {
                return Err(format!(
                    "保存诊断包失败: {}；原文件恢复失败（备份保留在 {}）: {}",
                    error,
                    backup.display(),
                    restore_error
                ));
            }
        }
        return Err(format!("保存诊断包失败: {}", error));
    }
    if replacing_existing {
        let _ = fs::remove_file(&backup);
    }
    temporary_guard.disarm();
    let size_bytes = fs::metadata(&destination).map(|m| m.len()).unwrap_or(0);

    Ok(DiagnosticsExportResult {
        path: destination.to_string_lossy().to_string(),
        file_count,
        skipped_count: skipped.len(),
        size_bytes,
    })
}

#[tauri::command]
pub async fn export_diagnostics_bundle(
    app: AppHandle,
    options: DiagnosticsExportOptions,
) -> Result<DiagnosticsExportResult, String> {
    crate::debug_logger::flush_global_logger().await;
    if !crate::debug_log_service::flush_pending_debug_log_writes().await {
        return Err("等待详细请求日志写入超时，请稍后重试".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || export_bundle_sync(&app, options))
        .await
        .map_err(|e| format!("诊断包任务失败: {}", e))?
}
