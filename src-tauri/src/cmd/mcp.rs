//! MCP 相关命令
//!
//! 从 commands.rs 拆分：MCP 状态、连接测试、配置管理

use crate::commands::AppState;
use crate::models::AppError;
use std::collections::HashMap;
#[cfg(feature = "mcp")]
use std::path::{Path, PathBuf};
#[cfg(feature = "mcp")]
use tauri::Emitter;
use tauri::{AppHandle, State, Window};

#[cfg(feature = "mcp")]
use crate::mcp::stdio_proxy::{
    close_stdio_session as mcp_close_stdio_session, send_stdio_message as mcp_send_stdio_message,
    start_stdio_session as mcp_start_stdio_session,
};

type Result<T> = std::result::Result<T, AppError>;

// MCP 相关命令
// =================================================

#[tauri::command]
pub async fn get_mcp_status(state: State<'_, AppState>) -> Result<serde_json::Value> {
    // 后端 MCP 已熔断，返回兼容状态供旧 UI 使用；前端组件已改为读取前端 SDK 状态
    let mut status = serde_json::json!({
        "available": false,
        "enabled": false,
        "connected": false,
        "enabled_reason": null,
        "server_info": null,
        "tools_count": 0,
        "last_error": "backend_mcp_disabled",
        "namespace_prefix": state.database.get_setting("mcp.tools.namespace_prefix").ok().flatten().unwrap_or_default(),
        "conflict_resolution": state.database.get_setting("mcp.tools.conflict_resolution").ok().flatten().unwrap_or_else(|| "use_namespace".into()),
        "cache_state": {
            "ttl_ms": state.database.get_setting("mcp.tools.cache_ttl_ms").ok().flatten().and_then(|v| v.parse::<u64>().ok()).unwrap_or(300_000),
            "last_built_at": null
        }
    });

    // MCP 启用状态由消息级选择决定（会话选择非空即视为启用）
    if let Ok(Some(selected)) = state.database.get_setting("session.selected_mcp_tools") {
        let enabled_now = !selected.trim().is_empty();
        status["enabled"] = serde_json::json!(enabled_now);
        if !enabled_now {
            status["enabled_reason"] = serde_json::json!("会话未选择MCP工具");
        }
    }

    // 后端已禁用，不再返回服务器详情

    Ok(status)
}

#[tauri::command]
pub async fn get_mcp_tools(_state: State<'_, AppState>) -> Result<Vec<serde_json::Value>> {
    // 后端 MCP 已禁用，返回空（由前端SDK提供工具列表）
    Ok(vec![])
}

#[cfg(feature = "mcp")]
#[tauri::command]
pub async fn test_mcp_connection(
    app_handle: AppHandle,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    framing: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let emitter = move |step: &str| {
        let _ = app_handle.emit("mcp-test-progress", serde_json::json!({ "step": step }));
    };
    let env = env.unwrap_or_default();
    let entries = crate::chat_v2::tools::mcp_settings_store::read_mcp_tools_list(&state.database)
        .map_err(AppError::internal)?;
    let validated = validate_stdio_start_against_entries(
        &entries,
        &command,
        &args,
        &env,
        cwd.as_deref(),
        framing.as_deref(),
    )
    .map_err(AppError::internal)?;

    Ok(mcp_test_helpers::test_stdio(
        validated.command,
        validated.args,
        Some(validated.env),
        Some(validated.cwd),
        Some(validated.framing),
        &emitter,
    )
    .await)
}

#[cfg(not(feature = "mcp"))]
#[tauri::command]
pub async fn test_mcp_connection(
    _app_handle: AppHandle,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    framing: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let _ = (command, args, env, cwd, framing, state);
    Ok(serde_json::json!({"success": false, "error": "backend_mcp_disabled"}))
}

/// 测试 MCP WebSocket 连接
#[cfg(feature = "mcp")]
#[tauri::command]
pub async fn test_mcp_websocket(
    url: String,
    env: Option<HashMap<String, String>>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let _ = env; // 兼容旧参数（预留环境变量），当前未使用
    Ok(mcp_test_helpers::test_websocket(url).await)
}

#[cfg(not(feature = "mcp"))]
#[tauri::command]
pub async fn test_mcp_websocket(
    url: String,
    env: Option<HashMap<String, String>>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let _ = (url, env, state);
    Ok(serde_json::json!({"success": false, "error": "backend_mcp_disabled"}))
}

/// 测试 MCP SSE 连接
#[cfg(feature = "mcp")]
#[tauri::command]
pub async fn test_mcp_sse(
    endpoint: String,
    api_key: String,
    env: Option<HashMap<String, String>>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let trimmed = api_key.trim().to_string();
    let api_key = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    Ok(mcp_test_helpers::test_sse(endpoint, api_key, env).await)
}

#[cfg(not(feature = "mcp"))]
#[tauri::command]
pub async fn test_mcp_sse(
    endpoint: String,
    api_key: String,
    env: Option<HashMap<String, String>>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let _ = (endpoint, api_key, env, state);
    Ok(serde_json::json!({"success": false, "error": "backend_mcp_disabled"}))
}

/// 测试 MCP HTTP 连接 (Streamable HTTP)
#[cfg(feature = "mcp")]
#[tauri::command]
pub async fn test_mcp_http(
    endpoint: String,
    api_key: String,
    env: Option<HashMap<String, String>>,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let trimmed = api_key.trim().to_string();
    let api_key = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    Ok(mcp_test_helpers::test_http(endpoint, api_key, env).await)
}

#[cfg(not(feature = "mcp"))]
#[tauri::command]
pub async fn test_mcp_http(
    endpoint: String,
    api_key: String,
    env: Option<HashMap<String, String>>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let _ = (endpoint, api_key, env, state);
    Ok(serde_json::json!({"success": false, "error": "backend_mcp_disabled"}))
}
#[cfg(feature = "mcp")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedStdioStart {
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    framing: String,
    cwd: String,
}

#[cfg(feature = "mcp")]
fn normalize_stdio_args(args: &[String]) -> Vec<String> {
    args.iter()
        .map(|arg| arg.trim())
        .filter(|arg| !arg.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(feature = "mcp")]
fn stdio_entry_args(entry: &serde_json::Value) -> Option<Vec<String>> {
    match entry
        .get("args")
        .or_else(|| entry.get("fetch").and_then(|fetch| fetch.get("args")))
    {
        Some(serde_json::Value::Array(arr)) => {
            let raw = arr
                .iter()
                .map(|arg| arg.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()?;
            Some(normalize_stdio_args(&raw))
        }
        Some(serde_json::Value::String(s)) => Some(
            s.split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(str::to_string)
                .collect(),
        ),
        None => Some(Vec::new()),
        Some(_) => None,
    }
}

#[cfg(feature = "mcp")]
fn stdio_entry_env(entry: &serde_json::Value) -> Option<HashMap<String, String>> {
    let Some(value) = entry
        .get("env")
        .or_else(|| entry.get("fetch").and_then(|fetch| fetch.get("env")))
    else {
        return Some(HashMap::new());
    };
    let object = value.as_object()?;
    object
        .iter()
        .map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect()
}

#[cfg(feature = "mcp")]
fn stdio_entry_cwd(entry: &serde_json::Value) -> Option<&str> {
    entry
        .get("cwd")
        .or_else(|| entry.get("working_dir"))
        .or_else(|| entry.get("workingDir"))
        .or_else(|| {
            entry.get("fetch").and_then(|fetch| {
                fetch
                    .get("cwd")
                    .or_else(|| fetch.get("working_dir"))
                    .or_else(|| fetch.get("workingDir"))
            })
        })
        .and_then(serde_json::Value::as_str)
}

#[cfg(feature = "mcp")]
fn normalize_stdio_framing(value: Option<&str>) -> String {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("content_length") | Some("content-length") | Some("contentlength") => {
            "content_length".to_string()
        }
        _ => "jsonl".to_string(),
    }
}

#[cfg(feature = "mcp")]
fn stdio_entry_framing(entry: &serde_json::Value) -> String {
    let value = entry
        .get("framing")
        .or_else(|| entry.get("framingMode"))
        .or_else(|| entry.get("fetch").and_then(|fetch| fetch.get("framing")))
        .and_then(serde_json::Value::as_str);
    normalize_stdio_framing(value)
}

#[cfg(feature = "mcp")]
fn canonicalize_stdio_cwd(cwd: Option<&str>) -> std::result::Result<PathBuf, String> {
    let current_dir = std::env::current_dir()
        .map_err(|e| format!("cannot resolve current working directory: {}", e))?;
    let requested = cwd.map(str::trim).filter(|value| !value.is_empty());
    let path = match requested {
        Some(value) if Path::new(value).is_absolute() => PathBuf::from(value),
        Some(value) => current_dir.join(value),
        None => current_dir,
    };
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("cannot canonicalize cwd '{}': {}", path.display(), e))?;
    if !canonical.is_dir() {
        return Err(format!("cwd is not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

#[cfg(feature = "mcp")]
fn canonical_executable_candidate(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if canonical.metadata().ok()?.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(canonical)
}

#[cfg(feature = "mcp")]
fn env_value<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    #[cfg(windows)]
    {
        env.iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    }
    #[cfg(not(windows))]
    {
        env.get(key).map(String::as_str)
    }
}

#[cfg(all(feature = "mcp", windows))]
fn executable_candidates(
    base: PathBuf,
    command: &str,
    env: &HashMap<String, String>,
) -> Vec<PathBuf> {
    let mut candidates = vec![base.clone()];
    if Path::new(command).extension().is_none() {
        let pathext = env_value(env, "PATHEXT")
            .map(str::to_string)
            .or_else(|| std::env::var("PATHEXT").ok())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
        for extension in pathext
            .split(';')
            .map(str::trim)
            .filter(|ext| !ext.is_empty())
        {
            let mut candidate = base.as_os_str().to_os_string();
            if extension.starts_with('.') {
                candidate.push(extension);
            } else {
                candidate.push(format!(".{}", extension));
            }
            candidates.push(PathBuf::from(candidate));
        }
    }
    candidates
}

#[cfg(all(feature = "mcp", not(windows)))]
fn executable_candidates(
    base: PathBuf,
    _command: &str,
    _env: &HashMap<String, String>,
) -> Vec<PathBuf> {
    vec![base]
}

#[cfg(feature = "mcp")]
fn resolve_stdio_executable(
    command: &str,
    env: &HashMap<String, String>,
    cwd: &Path,
) -> std::result::Result<PathBuf, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("command is empty".to_string());
    }

    let command_path = Path::new(command);
    let has_path_separator = command.contains('/') || command.contains('\\');
    if command_path.is_absolute() || has_path_separator {
        let base = if command_path.is_absolute() {
            command_path.to_path_buf()
        } else {
            cwd.join(command_path)
        };
        for candidate in executable_candidates(base, command, env) {
            if let Some(canonical) = canonical_executable_candidate(&candidate) {
                return Ok(canonical);
            }
        }
        return Err(format!("executable not found: {}", command));
    }

    let path_value = env_value(env, "PATH")
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    for directory in std::env::split_paths(&path_value) {
        let directory = if directory.as_os_str().is_empty() {
            cwd.to_path_buf()
        } else if directory.is_absolute() {
            directory
        } else {
            cwd.join(directory)
        };
        let base = directory.join(command);
        for candidate in executable_candidates(base, command, env) {
            if let Some(canonical) = canonical_executable_candidate(&candidate) {
                return Ok(canonical);
            }
        }
    }
    Err(format!(
        "executable '{}' is not reachable via PATH",
        command
    ))
}

#[cfg(feature = "mcp")]
fn canonical_paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(feature = "mcp")]
fn canonical_path_string(path: &Path, label: &str) -> std::result::Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{} path is not valid UTF-8: {}", label, path.display()))
}

/// `mcp_stdio_start` is an approved-config launcher, not a generic process API.
/// Validation returns the canonical, immutable values that must be used for
/// spawning so a request cannot pass by basename and then execute a different
/// binary through PATH, cwd, env, or framing changes.
#[cfg(feature = "mcp")]
fn validate_stdio_start_against_entries(
    entries: &[serde_json::Value],
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    cwd: Option<&str>,
    framing: Option<&str>,
) -> std::result::Result<ValidatedStdioStart, String> {
    let requested_args = normalize_stdio_args(args);
    let requested_env = env.clone();
    let requested_framing = normalize_stdio_framing(framing);
    let requested_cwd =
        canonicalize_stdio_cwd(cwd).map_err(|e| format!("mcp_stdio_start rejected: {}", e))?;
    let requested_executable = resolve_stdio_executable(command, &requested_env, &requested_cwd)
        .map_err(|e| format!("mcp_stdio_start rejected: {}", e))?;

    for entry in entries {
        let enabled = entry
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !enabled {
            continue;
        }
        let transport = entry
            .get("transportType")
            .or_else(|| entry.get("transport"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("stdio");
        if !transport.eq_ignore_ascii_case("stdio") {
            continue;
        }
        let entry_command = entry
            .get("command")
            .or_else(|| entry.get("fetch").and_then(|fetch| fetch.get("command")))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let Some(entry_args) = stdio_entry_args(entry) else {
            continue;
        };
        if entry_command.is_empty() || entry_args != requested_args {
            continue;
        }
        let Some(entry_env) = stdio_entry_env(entry) else {
            continue;
        };
        let entry_framing = stdio_entry_framing(entry);
        if entry_env != requested_env || entry_framing != requested_framing {
            continue;
        }
        let Ok(entry_cwd) = canonicalize_stdio_cwd(stdio_entry_cwd(entry)) else {
            continue;
        };
        if !canonical_paths_equal(&entry_cwd, &requested_cwd) {
            continue;
        }
        let Ok(entry_executable) = resolve_stdio_executable(entry_command, &entry_env, &entry_cwd)
        else {
            continue;
        };
        if !canonical_paths_equal(&entry_executable, &requested_executable) {
            continue;
        }

        return Ok(ValidatedStdioStart {
            command: canonical_path_string(&entry_executable, "executable")?,
            args: entry_args,
            env: entry_env,
            framing: entry_framing,
            cwd: canonical_path_string(&entry_cwd, "cwd")?,
        });
    }

    Err(
        "mcp_stdio_start rejected: executable, args, env, cwd, and framing must exactly match an enabled MCP stdio server in the approved configuration (mcp.tools.list)"
            .to_string(),
    )
}

#[tauri::command]
pub async fn mcp_stdio_start(
    window: Window,
    state: State<'_, AppState>,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    framing: Option<String>,
    cwd: Option<String>,
) -> Result<String> {
    #[cfg(feature = "mcp")]
    {
        let env = env.unwrap_or_default();
        let entries =
            crate::chat_v2::tools::mcp_settings_store::read_mcp_tools_list(&state.database)
                .map_err(AppError::internal)?;
        let validated = validate_stdio_start_against_entries(
            &entries,
            &command,
            &args,
            &env,
            cwd.as_deref(),
            framing.as_deref(),
        )
        .map_err(AppError::internal)?;
        mcp_start_stdio_session(
            window,
            validated.command,
            validated.args,
            validated.env,
            Some(validated.framing),
            Some(validated.cwd),
        )
        .await
        .map_err(|e| AppError::internal(format!("{}", e)))
    }
    #[cfg(not(feature = "mcp"))]
    {
        let _ = (window, state, command, args, env, framing, cwd);
        Err(AppError::internal("backend_mcp_disabled".to_string()))
    }
}

#[tauri::command]
pub async fn mcp_stdio_send(session_id: String, payload: String) -> Result<()> {
    #[cfg(feature = "mcp")]
    {
        mcp_send_stdio_message(&session_id, &payload)
            .await
            .map_err(|e| AppError::internal(format!("{}", e)))
    }
    #[cfg(not(feature = "mcp"))]
    {
        let _ = (session_id, payload);
        Err(AppError::internal("backend_mcp_disabled".to_string()))
    }
}

#[tauri::command]
pub async fn mcp_stdio_close(session_id: String) -> Result<()> {
    #[cfg(feature = "mcp")]
    {
        mcp_close_stdio_session(&session_id)
            .await
            .map_err(|e| AppError::internal(format!("{}", e)))
    }
    #[cfg(not(feature = "mcp"))]
    {
        let _ = session_id;
        Err(AppError::internal("backend_mcp_disabled".to_string()))
    }
}

/// 使用 rmcp（或内部回退）测试 Streamable HTTP MCP 服务器
#[cfg(feature = "mcp")]
#[tauri::command]
pub async fn test_rmcp_streamable_http(
    url: String,
    api_key: Option<String>,
) -> Result<serde_json::Value> {
    Ok(mcp_test_helpers::test_streamable_http_rmcp(url, api_key).await)
}

#[cfg(not(feature = "mcp"))]
#[tauri::command]
pub async fn test_rmcp_streamable_http(
    url: String,
    api_key: Option<String>,
) -> Result<serde_json::Value> {
    let _ = (url, api_key);
    Ok(serde_json::json!({"success": false, "error": "backend_mcp_disabled"}))
}
#[tauri::command]
pub async fn save_mcp_config(
    config: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<bool> {
    // 保存MCP配置到数据库
    let db = &state.database;
    // 基础配置：移除对 mcp.enabled 的保存（启用仅由消息级选择控制）

    // 传输配置
    if let Some(transport) = config.get("transport") {
        if let Some(transport_type) = transport.get("type").and_then(|v| v.as_str()) {
            db.save_setting("mcp.transport.type", transport_type)?;

            match transport_type {
                "stdio" => {
                    if let Some(command) = transport.get("command").and_then(|v| v.as_str()) {
                        db.save_setting("mcp.transport.command", command)?;
                    }
                    if let Some(args) = transport.get("args").and_then(|v| v.as_array()) {
                        let args_str = args
                            .iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(",");
                        db.save_setting("mcp.transport.args", &args_str)?;
                    }
                    if let Some(framing) = transport.get("framing").and_then(|v| v.as_str()) {
                        db.save_setting("mcp.transport.framing", framing)?;
                    }
                }
                "websocket" => {
                    if let Some(url) = transport.get("url").and_then(|v| v.as_str()) {
                        db.save_setting("mcp.transport.url", url)?;
                    }
                }
                _ => {}
            }
        }
    }

    // 工具配置
    if let Some(tools) = config.get("tools") {
        if let Some(cache_ttl_ms) = tools.get("cache_ttl_ms").and_then(|v| v.as_u64()) {
            db.save_setting("mcp.tools.cache_ttl_ms", &cache_ttl_ms.to_string())?;
        }
        if let Some(advertise_all) = tools.get("advertise_all_tools").and_then(|v| v.as_bool()) {
            db.save_setting("mcp.tools.advertise_all_tools", &advertise_all.to_string())?;
        }
        if let Some(whitelist) = tools.get("whitelist").and_then(|v| v.as_array()) {
            let whitelist_str = whitelist
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(",");
            db.save_setting("mcp.tools.whitelist", &whitelist_str)?;
        }
        if let Some(blacklist) = tools.get("blacklist").and_then(|v| v.as_array()) {
            let blacklist_str = blacklist
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(",");
            db.save_setting("mcp.tools.blacklist", &blacklist_str)?;
        }
    }

    // 性能配置
    if let Some(performance) = config.get("performance") {
        if let Some(timeout_ms) = performance.get("timeout_ms").and_then(|v| v.as_u64()) {
            db.save_setting("mcp.performance.timeout_ms", &timeout_ms.to_string())?;
        }
        if let Some(rate_limit) = performance
            .get("rate_limit_per_second")
            .and_then(|v| v.as_u64())
        {
            db.save_setting(
                "mcp.performance.rate_limit_per_second",
                &rate_limit.to_string(),
            )?;
        }
        if let Some(cache_max_size) = performance.get("cache_max_size").and_then(|v| v.as_u64()) {
            db.save_setting(
                "mcp.performance.cache_max_size",
                &cache_max_size.to_string(),
            )?;
        }
        if let Some(cache_ttl_ms) = performance.get("cache_ttl_ms").and_then(|v| v.as_u64()) {
            db.save_setting("mcp.performance.cache_ttl_ms", &cache_ttl_ms.to_string())?;
        }
    }

    println!("🔧 [MCP] Configuration saved to database");
    Ok(true)
}

#[tauri::command]
pub async fn reload_mcp_client(state: State<'_, AppState>) -> Result<serde_json::Value> {
    // 后端 MCP 已禁用。清理缓存并返回提示
    state.llm_manager.clear_mcp_tool_cache().await;
    Ok(serde_json::json!({"success": true, "message": "Backend MCP disabled; frontend SDK in use"}))
}
/// 预热前端 MCP 工具清单缓存（降低首条消息不广告的概率）
#[tauri::command]
pub async fn preheat_mcp_tools(
    window: Window,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let count = state.llm_manager.preheat_mcp_tools_public(&window).await;
    Ok(serde_json::json!({ "ok": true, "count": count }))
}
#[cfg(feature = "mcp")]
pub mod mcp_test_helpers {
    use crate::mcp::{
        client::{DefaultNotificationHandler, McpClient, RootsCapability, SamplingCapability},
        global::create_stdio_transport,
        http_transport::{HttpConfig, HttpTransport},
        sse_transport::{SSEConfig, SSETransport},
        transport::{Transport, WebSocketTransport},
        types::{ClientCapabilities, ClientInfo, McpError, Prompt, Resource, ServerInfo, Tool},
        McpFraming,
    };
    use log::warn;
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    use serde_json::json;
    use std::collections::HashMap;
    use std::time::Duration;
    use tokio::time::{sleep, Instant};

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
    const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(250);
    const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);
    const CACHE_TTL: Duration = Duration::from_secs(300);
    const CACHE_MAX: usize = 128;
    const RATE_LIMIT: usize = 16;

    struct ProbeOutcome {
        server: ServerInfo,
        tools: Vec<Tool>,
        prompts: Vec<Prompt>,
        resources: Vec<Resource>,
        warnings: Vec<String>,
    }

    pub async fn test_stdio(
        command: String,
        args: Vec<String>,
        env: Option<HashMap<String, String>>,
        cwd: Option<String>,
        framing: Option<String>,
        on_progress: &(dyn Fn(&str) + Send + Sync),
    ) -> serde_json::Value {
        on_progress("spawn_process");
        let normalized_args: Vec<String> = args
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
        let env_map = env.unwrap_or_default();
        // 默认 JSONL（MCP 规范）；Content-Length 仅在显式请求时启用。
        let framing_mode = match framing.as_deref() {
            Some("content_length") | Some("content-length") | Some("contentlength") => {
                McpFraming::ContentLength
            }
            _ => McpFraming::JsonLines,
        };
        let cwd_path = cwd.as_ref().map(std::path::PathBuf::from);
        match create_stdio_transport(
            &command,
            &normalized_args,
            &framing_mode,
            &env_map,
            cwd_path.as_ref(),
        )
        .await
        {
            Ok(transport_impl) => {
                let transport: Box<dyn Transport> = Box::new(transport_impl);
                probe_transport_with_progress(transport, "stdio", on_progress).await
            }
            Err(err) => {
                json!({"success": false, "transport": "stdio", "error": format!("无法启动进程: {}", err)})
            }
        }
    }

    pub async fn test_websocket(url: String) -> serde_json::Value {
        let ws_transport = WebSocketTransport::new(url.clone());
        match ws_transport.connect().await {
            Ok(()) => {
                let transport: Box<dyn Transport> = Box::new(ws_transport);
                probe_transport(transport, "websocket").await
            }
            Err(err) => {
                json!({"success": false, "transport": "websocket", "error": format!("无法建立 WebSocket 连接: {}", err)})
            }
        }
    }

    pub async fn test_sse(
        endpoint: String,
        api_key: Option<String>,
        headers: Option<HashMap<String, String>>,
    ) -> serde_json::Value {
        let header_map = map_env_to_headers(headers);
        let config = SSEConfig {
            endpoint,
            api_key,
            oauth: None,
            auth_provider: None,
            headers: header_map,
            timeout: CLIENT_TIMEOUT,
        };
        match SSETransport::new(config).await {
            Ok(transport_impl) => probe_transport(Box::new(transport_impl), "sse").await,
            Err(err) => {
                json!({"success": false, "transport": "sse", "error": format!("SSE 初始化失败: {}", err)})
            }
        }
    }

    pub async fn test_http(
        endpoint: String,
        api_key: Option<String>,
        headers: Option<HashMap<String, String>>,
    ) -> serde_json::Value {
        let header_map = map_env_to_headers(headers);
        let config = HttpConfig {
            url: endpoint,
            api_key,
            oauth: None,
            auth_provider: None,
            headers: header_map,
            timeout: CLIENT_TIMEOUT,
        };
        match HttpTransport::new(config).await {
            Ok(transport_impl) => probe_transport(Box::new(transport_impl), "http").await,
            Err(err) => {
                json!({"success": false, "transport": "http", "error": format!("HTTP 初始化失败: {}", err)})
            }
        }
    }

    pub async fn test_streamable_http_rmcp(
        url: String,
        api_key: Option<String>,
    ) -> serde_json::Value {
        match crate::mcp::rmcp::test_rmcp_streamable_http(&url, api_key.clone()).await {
            Ok(outcome) => json!({
                "success": outcome.success,
                "step": outcome.step,
                "message": outcome.message,
            }),
            Err(err) => json!({
                "success": false,
                "error": err.to_string(),
            }),
        }
    }

    fn map_env_to_headers(env: Option<HashMap<String, String>>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(map) = env {
            for (key, value) in map {
                let name = match HeaderName::from_bytes(key.trim().as_bytes()) {
                    Ok(name) => name,
                    Err(_) => {
                        warn!("忽略无法解析的头部键: {}", key);
                        continue;
                    }
                };
                let header_value = match HeaderValue::from_str(value.trim()) {
                    Ok(value) => value,
                    Err(_) => {
                        warn!("忽略无法解析的头部值 {} = {}", key, value);
                        continue;
                    }
                };
                headers.insert(name, header_value);
            }
        }
        headers
    }

    async fn probe_transport_with_progress(
        transport: Box<dyn Transport>,
        transport_label: &str,
        on_progress: &(dyn Fn(&str) + Send + Sync),
    ) -> serde_json::Value {
        match gather_probe_with_progress(transport, transport_label, on_progress).await {
            Ok(outcome) => {
                on_progress("done");
                format_probe_outcome(outcome, transport_label)
            }
            Err(err) => json!({
                "success": false,
                "transport": transport_label,
                "error": err,
            }),
        }
    }

    async fn probe_transport(
        transport: Box<dyn Transport>,
        transport_label: &str,
    ) -> serde_json::Value {
        match gather_probe(transport, transport_label).await {
            Ok(outcome) => format_probe_outcome(outcome, transport_label),
            Err(err) => json!({
                "success": false,
                "transport": transport_label,
                "error": err,
            }),
        }
    }

    fn format_probe_outcome(outcome: ProbeOutcome, transport_label: &str) -> serde_json::Value {
        let tools_preview: Vec<_> = outcome
            .tools
            .iter()
            .take(8)
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description.clone().unwrap_or_default(),
                })
            })
            .collect();

        let prompts_preview: Vec<_> = outcome
            .prompts
            .iter()
            .take(8)
            .map(|prompt| {
                json!({
                    "name": prompt.name,
                    "description": prompt.description.clone().unwrap_or_default(),
                })
            })
            .collect();

        let resources_preview: Vec<_> = outcome
            .resources
            .iter()
            .take(8)
            .map(|resource| {
                json!({
                    "uri": &resource.uri,
                    "name": &resource.name,
                    "description": resource.description.as_deref().unwrap_or(""),
                })
            })
            .collect();

        json!({
            "success": true,
            "transport": transport_label,
            "server": {
                "name": outcome.server.name,
                "version": outcome.server.version,
                "protocol_version": outcome.server.protocol_version,
            },
            "tools_count": outcome.tools.len(),
            "prompts_count": outcome.prompts.len(),
            "resources_count": outcome.resources.len(),
            "tools_preview": tools_preview,
            "prompts_preview": prompts_preview,
            "resources_preview": resources_preview,
            "warnings": outcome.warnings,
        })
    }

    async fn gather_probe(
        transport: Box<dyn Transport>,
        transport_label: &str,
    ) -> Result<ProbeOutcome, String> {
        gather_probe_with_progress(transport, transport_label, &|_| {}).await
    }

    async fn gather_probe_with_progress(
        transport: Box<dyn Transport>,
        transport_label: &str,
        on_progress: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<ProbeOutcome, String> {
        let client_info = ClientInfo {
            name: format!("dstu-mcp-tester-{}", transport_label),
            version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: "2025-06-18".to_string(),
            capabilities: ClientCapabilities {
                roots: Some(RootsCapability {
                    list_changed: Some(true),
                }),
                sampling: Some(SamplingCapability { enabled: true }),
                experimental: None,
            },
        };

        let client = McpClient::with_options(
            transport,
            client_info,
            Box::new(DefaultNotificationHandler),
            CLIENT_TIMEOUT,
            CACHE_MAX,
            CACHE_TTL,
            RATE_LIMIT,
        );

        on_progress("connecting");
        if let Err(err) = connect_with_retry(&client, CONNECT_TIMEOUT).await {
            let _ = client.disconnect().await;
            return Err(format!("连接失败: {}", err));
        }

        on_progress("initializing");
        let server_info = match client.initialize().await {
            Ok(info) => info,
            Err(err) => {
                let _ = client.disconnect().await;
                return Err(format!("初始化失败: {}", err));
            }
        };

        on_progress("listing_tools");
        let tools = match client.list_tools().await {
            Ok(list) => list,
            Err(err) => {
                let _ = client.disconnect().await;
                return Err(format!("tools/list 调用失败: {}", err));
            }
        };

        let mut warnings = Vec::new();

        on_progress("listing_prompts");
        let prompts = match client.list_prompts().await {
            Ok(list) => list,
            Err(err) => {
                warnings.push(format!("prompts/list 调用失败: {}", err));
                Vec::new()
            }
        };

        on_progress("listing_resources");
        let resources = match client.list_resources().await {
            Ok(list) => list,
            Err(err) => {
                warnings.push(format!("resources/list 调用失败: {}", err));
                Vec::new()
            }
        };

        on_progress("disconnecting");
        if let Err(err) = client.disconnect().await {
            warnings.push(format!("断开连接时出现问题: {}", err));
        }

        Ok(ProbeOutcome {
            server: server_info,
            tools,
            prompts,
            resources,
            warnings,
        })
    }

    async fn connect_with_retry(client: &McpClient, timeout: Duration) -> Result<(), McpError> {
        let start = Instant::now();
        #[allow(unused_assignments)]
        let mut last_error = String::new();

        loop {
            match client.connect().await {
                Ok(_) => return Ok(()),
                Err(err) => {
                    last_error = err.to_string();
                    if start.elapsed() >= timeout {
                        return Err(McpError::ConnectionError(format!(
                            "连接超时: {}",
                            last_error
                        )));
                    }
                    sleep(CONNECT_RETRY_DELAY).await;
                }
            }
        }
    }
}

#[cfg(all(test, feature = "mcp"))]
mod stdio_start_validation_tests {
    use super::*;
    use serde_json::json;

    fn current_exe() -> String {
        std::fs::canonicalize(std::env::current_exe().expect("current executable"))
            .expect("canonical current executable")
            .to_str()
            .expect("test executable path must be UTF-8")
            .to_string()
    }

    fn current_cwd() -> String {
        std::fs::canonicalize(std::env::current_dir().expect("current directory"))
            .expect("canonical current directory")
            .to_str()
            .expect("test cwd must be UTF-8")
            .to_string()
    }

    fn approved_env() -> HashMap<String, String> {
        HashMap::from([("FS_ROOT".to_string(), "approved-root".to_string())])
    }

    fn write_test_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(path, b"#!/bin/sh\nexit 0\n").expect("write test executable");
            let mut permissions = std::fs::metadata(path)
                .expect("test executable metadata")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).expect("mark test executable");
        }
        #[cfg(windows)]
        std::fs::write(path, b"@exit /b 0\r\n").expect("write test executable");
    }

    fn entries() -> Vec<serde_json::Value> {
        vec![
            json!({
                "id": "fs",
                "name": "fs",
                "transportType": "stdio",
                "enabled": true,
                "command": current_exe(),
                "args": ["--approved"],
                "env": { "FS_ROOT": "approved-root" },
                "cwd": current_cwd(),
                "framing": "jsonl"
            }),
            json!({
                "id": "disabled",
                "name": "disabled",
                "transportType": "stdio",
                "enabled": false,
                "command": current_exe(),
                "args": ["--disabled"],
            }),
        ]
    }

    #[test]
    fn accepts_exact_match_of_enabled_entry() {
        let validated = validate_stdio_start_against_entries(
            &entries(),
            &current_exe(),
            &["  --approved  ".to_string()],
            &approved_env(),
            Some(&current_cwd()),
            Some("JSONL"),
        )
        .expect("approved entry should validate");

        assert_eq!(validated.command, current_exe());
        assert_eq!(validated.args, vec!["--approved"]);
        assert_eq!(validated.env, approved_env());
        assert_eq!(validated.cwd, current_cwd());
        assert_eq!(validated.framing, "jsonl");
    }

    /// SECURITY: mismatched args and disabled entries are always rejected.
    #[test]
    fn rejects_mismatched_args_and_disabled_entries() {
        let err = validate_stdio_start_against_entries(
            &entries(),
            &current_exe(),
            &["--evil".to_string()],
            &approved_env(),
            Some(&current_cwd()),
            Some("jsonl"),
        )
        .unwrap_err();
        assert!(err.contains("rejected"));

        assert!(validate_stdio_start_against_entries(
            &entries(),
            &current_exe(),
            &["--disabled".to_string()],
            &HashMap::new(),
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn rejects_unconfigured_executable_used_by_connection_test_or_session_start() {
        let temp = tempfile::tempdir().expect("temp dir");
        let executable = temp.path().join(if cfg!(windows) {
            "unapproved.cmd"
        } else {
            "unapproved"
        });
        write_test_executable(&executable);

        let error = validate_stdio_start_against_entries(
            &entries(),
            executable.to_str().expect("UTF-8 executable path"),
            &[],
            &HashMap::new(),
            None,
            None,
        )
        .expect_err("an unconfigured process must never be launched by either stdio entrypoint");
        assert!(error.contains("approved configuration"));
    }

    /// SECURITY: env keys and values must both match the approved entry.
    #[test]
    fn rejects_env_value_mismatch_missing_and_extra_keys() {
        let args = vec!["--approved".to_string()];

        let wrong_value = HashMap::from([("FS_ROOT".to_string(), "evil-root".to_string())]);
        assert!(validate_stdio_start_against_entries(
            &entries(),
            &current_exe(),
            &args,
            &wrong_value,
            Some(&current_cwd()),
            Some("jsonl"),
        )
        .is_err());

        assert!(validate_stdio_start_against_entries(
            &entries(),
            &current_exe(),
            &args,
            &HashMap::new(),
            Some(&current_cwd()),
            Some("jsonl"),
        )
        .is_err());

        let mut extra_key = approved_env();
        extra_key.insert("PATH".to_string(), "/tmp/evil".to_string());
        assert!(validate_stdio_start_against_entries(
            &entries(),
            &current_exe(),
            &args,
            &extra_key,
            Some(&current_cwd()),
            Some("jsonl"),
        )
        .is_err());
    }

    #[test]
    fn rejects_canonical_cwd_and_framing_mismatches() {
        let other_cwd = tempfile::tempdir().expect("temp cwd");
        let other_cwd = other_cwd.path().to_str().expect("UTF-8 temp path");

        assert!(validate_stdio_start_against_entries(
            &entries(),
            &current_exe(),
            &["--approved".to_string()],
            &approved_env(),
            Some(other_cwd),
            Some("jsonl"),
        )
        .is_err());

        assert!(validate_stdio_start_against_entries(
            &entries(),
            &current_exe(),
            &["--approved".to_string()],
            &approved_env(),
            Some(&current_cwd()),
            Some("content-length"),
        )
        .is_err());
    }

    #[test]
    fn normalizes_default_framing_and_cwd_aliases() {
        let entries = vec![json!({
            "transportType": "stdio",
            "enabled": true,
            "command": current_exe(),
            "args": [],
            "env": {},
            "workingDir": current_cwd(),
            "framingMode": "content-length"
        })];

        let validated = validate_stdio_start_against_entries(
            &entries,
            &current_exe(),
            &[],
            &HashMap::new(),
            Some(&current_cwd()),
            Some("content_length"),
        )
        .expect("equivalent framing aliases should match");
        assert_eq!(validated.framing, "content_length");

        let nested_entry = vec![json!({
            "transportType": "stdio",
            "enabled": true,
            "fetch": {
                "command": current_exe(),
                "args": [],
                "env": {},
                "cwd": current_cwd(),
                "framing": "contentlength"
            }
        })];
        let validated = validate_stdio_start_against_entries(
            &nested_entry,
            &current_exe(),
            &[],
            &HashMap::new(),
            Some(&current_cwd()),
            Some("content_length"),
        )
        .expect("fetch framing and launch fields should be supported");
        assert_eq!(validated.framing, "content_length");

        let default_entry = vec![json!({
            "transportType": "stdio",
            "enabled": true,
            "command": current_exe(),
            "args": [],
            "env": {}
        })];
        let validated = validate_stdio_start_against_entries(
            &default_entry,
            &current_exe(),
            &[],
            &HashMap::new(),
            None,
            Some("unknown-framing"),
        )
        .expect("runtime-compatible unknown framing should normalize to jsonl");
        assert_eq!(validated.framing, "jsonl");
        assert_eq!(validated.cwd, current_cwd());
    }

    #[test]
    fn resolves_path_command_to_the_approved_canonical_executable() {
        let executable = std::env::current_exe().expect("current executable");
        let parent = executable.parent().expect("executable parent");
        let basename = executable
            .file_name()
            .and_then(|name| name.to_str())
            .expect("UTF-8 executable name");
        let path = parent.to_str().expect("UTF-8 executable parent");
        let env = HashMap::from([("PATH".to_string(), path.to_string())]);
        let entries = vec![json!({
            "transportType": "stdio",
            "enabled": true,
            "command": current_exe(),
            "args": [],
            "env": { "PATH": path }
        })];

        let validated =
            validate_stdio_start_against_entries(&entries, basename, &[], &env, None, None)
                .expect("bare command should resolve to approved executable");
        assert_eq!(validated.command, current_exe());
    }

    /// SECURITY PoC: identical basenames in different directories are not the
    /// same approved executable, even when both files exist and are runnable.
    #[test]
    fn rejects_same_basename_from_a_different_directory() {
        let temp = tempfile::tempdir().expect("temp dir");
        let trusted_dir = temp.path().join("trusted");
        let malicious_dir = temp.path().join("malicious");
        std::fs::create_dir_all(&trusted_dir).expect("trusted dir");
        std::fs::create_dir_all(&malicious_dir).expect("malicious dir");

        let basename = if cfg!(windows) {
            "same-name.cmd"
        } else {
            "same-name"
        };
        let trusted = trusted_dir.join(basename);
        let malicious = malicious_dir.join(basename);
        write_test_executable(&trusted);
        write_test_executable(&malicious);

        let entries = vec![json!({
            "transportType": "stdio",
            "enabled": true,
            "command": trusted.to_str().expect("UTF-8 trusted path"),
            "args": [],
            "env": {}
        })];

        assert!(validate_stdio_start_against_entries(
            &entries,
            malicious.to_str().expect("UTF-8 malicious path"),
            &[],
            &HashMap::new(),
            None,
            None,
        )
        .is_err());
    }

    /// 端到端：对真实 spawn 的最小标准 MCP server（规范 camelCase 字段）
    /// 跑完整 probe——initialize 握手 + tools/list 必须解析出工具。
    /// 回归：Tool.input_schema 缺 serde rename 时 tools/list 必然失败。
    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_probe_parses_spec_camel_case_tools() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("mcp-probe-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let server_path = dir.join("mini_server.py");
        std::fs::write(
            &server_path,
            r#"#!/usr/bin/env python3
import json, sys

def reply(i, result=None):
    sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":i,"result":result}) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    m = json.loads(line)
    method, mid = m.get("method"), m.get("id")
    if method == "initialize":
        reply(mid, {"protocolVersion": m["params"]["protocolVersion"],
                    "capabilities": {"tools": {"listChanged": True}},
                    "serverInfo": {"name": "mini", "version": "0.1"}})
    elif method in ("notifications/initialized", "initialized"):
        pass
    elif method == "tools/list":
        reply(mid, {"tools": [{"name": "echo_upper",
                               "description": "upper",
                               "inputSchema": {"type": "object",
                                               "properties": {"text": {"type": "string"}}}}]})
    elif method == "prompts/list":
        reply(mid, {"prompts": []})
    elif method == "resources/list":
        reply(mid, {"resources": []})
    elif mid is not None:
        reply(mid, {})
"#,
        )
        .expect("write mini server");
        std::fs::set_permissions(&server_path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod mini server");

        let python = if std::path::Path::new("/usr/bin/python3").exists() {
            "/usr/bin/python3"
        } else {
            "python3"
        };
        let outcome = mcp_test_helpers::test_stdio(
            python.to_string(),
            vec![server_path.to_str().expect("UTF-8 server path").to_string()],
            None,
            None,
            None,
            &|_| {},
        )
        .await;

        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            outcome.get("success").and_then(|v| v.as_bool()),
            Some(true),
            "probe should succeed: {}",
            outcome
        );
        assert_eq!(
            outcome.get("tools_count").and_then(|v| v.as_u64()),
            Some(1),
            "spec camelCase tools must parse: {}",
            outcome
        );
        let preview = outcome
            .get("tools_preview")
            .and_then(|t| t.as_array())
            .expect("tools_preview array");
        assert_eq!(
            preview[0].get("name").and_then(|n| n.as_str()),
            Some("echo_upper")
        );
    }
}
