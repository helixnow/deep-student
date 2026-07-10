//! MCP 相关命令
//!
//! 从 commands.rs 拆分：MCP 状态、连接测试、配置管理

use crate::commands::AppState;
use crate::models::AppError;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State, Window};

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
    _state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let emitter = move |step: &str| {
        let _ = app_handle.emit("mcp-test-progress", serde_json::json!({ "step": step }));
    };
    Ok(mcp_test_helpers::test_stdio(command, args, env, cwd, framing, &emitter).await)
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
/// 归一化命令 token 便于与已审批条目比对：
/// 取 basename、小写、去 `.exe`/`.cmd`/`.bat` 后缀（Windows 下前端可能传 `npx.cmd`）。
#[cfg(feature = "mcp")]
fn normalize_stdio_command_token(token: &str) -> String {
    let basename = token
        .trim()
        .rsplit(|ch| ch == '/' || ch == '\\')
        .next()
        .unwrap_or(token)
        .to_ascii_lowercase();
    basename
        .strip_suffix(".exe")
        .or_else(|| basename.strip_suffix(".cmd"))
        .or_else(|| basename.strip_suffix(".bat"))
        .map(str::to_string)
        .unwrap_or(basename)
}

#[cfg(feature = "mcp")]
fn stdio_entry_args(entry: &serde_json::Value) -> Vec<String> {
    match entry.get("args") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|a| a.as_str().map(str::trim).filter(|s| !s.is_empty()))
            .map(str::to_string)
            .collect(),
        Some(serde_json::Value::String(s)) => s
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// 🔒 P1（17 号报告 P1-5）：`mcp_stdio_start` 不再是任意进程执行接口。
/// 请求的 (command, args) 必须与 `mcp.tools.list` 中一条**已启用**（即用户审批/配置过）
/// 的 stdio 条目完全匹配；env 只允许该条目声明过的键；cwd 只允许与条目配置一致。
#[cfg(feature = "mcp")]
fn validate_stdio_start_against_entries(
    entries: &[serde_json::Value],
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    cwd: Option<&str>,
) -> std::result::Result<(), String> {
    let requested_command = normalize_stdio_command_token(command);
    let requested_args: Vec<String> = args
        .iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect();

    let matched = entries.iter().find(|entry| {
        let enabled = entry
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !enabled {
            return false;
        }
        let transport = entry
            .get("transportType")
            .or_else(|| entry.get("transport"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("stdio");
        if transport != "stdio" {
            return false;
        }
        let entry_command = entry
            .get("command")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if entry_command.is_empty()
            || normalize_stdio_command_token(entry_command) != requested_command
        {
            return false;
        }
        stdio_entry_args(entry) == requested_args
    });

    let Some(entry) = matched else {
        return Err(
            "mcp_stdio_start rejected: command/args do not match any enabled MCP stdio server \
             in the approved configuration (mcp.tools.list)"
                .to_string(),
        );
    };

    // env 白名单：仅允许条目里声明过的变量名（防 PATH/COMSPEC 等注入）
    if !env.is_empty() {
        let declared: std::collections::HashSet<&str> = entry
            .get("env")
            .and_then(|v| v.as_object())
            .map(|m| m.keys().map(String::as_str).collect())
            .unwrap_or_default();
        for key in env.keys() {
            if !declared.contains(key.as_str()) {
                return Err(format!(
                    "mcp_stdio_start rejected: env var '{}' is not declared in the approved MCP configuration",
                    key
                ));
            }
        }
    }

    // cwd：仅允许与已审批条目一致（条目未配置 cwd 时拒绝任何非空 cwd）
    if let Some(requested_cwd) = cwd.map(str::trim).filter(|c| !c.is_empty()) {
        let entry_cwd = entry
            .get("cwd")
            .or_else(|| entry.get("working_dir"))
            .or_else(|| entry.get("workingDir"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if entry_cwd.is_empty() || entry_cwd != requested_cwd {
            return Err(
                "mcp_stdio_start rejected: cwd is not part of the approved MCP configuration"
                    .to_string(),
            );
        }
    }

    Ok(())
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
        validate_stdio_start_against_entries(&entries, &command, &args, &env, cwd.as_deref())
            .map_err(AppError::internal)?;
        mcp_start_stdio_session(window, command, args, env, framing, cwd)
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

    fn entries() -> Vec<serde_json::Value> {
        vec![
            json!({
                "id": "fs",
                "name": "fs",
                "transportType": "stdio",
                "enabled": true,
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem"],
                "env": { "FS_ROOT": "C:/data" }
            }),
            json!({
                "id": "disabled",
                "name": "disabled",
                "transportType": "stdio",
                "enabled": false,
                "command": "node",
                "args": ["server.js"],
            }),
        ]
    }

    #[test]
    fn accepts_exact_match_of_enabled_entry() {
        let args = vec![
            "-y".to_string(),
            "@modelcontextprotocol/server-filesystem".to_string(),
        ];
        assert!(validate_stdio_start_against_entries(
            &entries(),
            "npx",
            &args,
            &HashMap::new(),
            None
        )
        .is_ok());
        // Windows 前端可能传 npx.cmd
        assert!(validate_stdio_start_against_entries(
            &entries(),
            "npx.cmd",
            &args,
            &HashMap::new(),
            None
        )
        .is_ok());
    }

    /// SECURITY: 任意命令 / 不匹配的 args / 已禁用条目一律拒绝
    #[test]
    fn rejects_arbitrary_commands_and_mismatched_args() {
        let err = validate_stdio_start_against_entries(
            &entries(),
            "powershell",
            &["-enc".to_string(), "ZQB2AGkAbA==".to_string()],
            &HashMap::new(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("rejected"));

        assert!(validate_stdio_start_against_entries(
            &entries(),
            "npx",
            &["-y".to_string(), "@evil/pkg".to_string()],
            &HashMap::new(),
            None
        )
        .is_err());

        // 已禁用条目不可被拉起
        assert!(validate_stdio_start_against_entries(
            &entries(),
            "node",
            &["server.js".to_string()],
            &HashMap::new(),
            None
        )
        .is_err());
    }

    /// SECURITY: env 只允许条目声明过的键；cwd 未配置时拒绝
    #[test]
    fn rejects_undeclared_env_and_cwd() {
        let args = vec![
            "-y".to_string(),
            "@modelcontextprotocol/server-filesystem".to_string(),
        ];
        let mut declared_env = HashMap::new();
        declared_env.insert("FS_ROOT".to_string(), "C:/data".to_string());
        assert!(validate_stdio_start_against_entries(
            &entries(),
            "npx",
            &args,
            &declared_env,
            None
        )
        .is_ok());

        let mut injected_env = HashMap::new();
        injected_env.insert("PATH".to_string(), "C:/evil".to_string());
        assert!(validate_stdio_start_against_entries(
            &entries(),
            "npx",
            &args,
            &injected_env,
            None
        )
        .is_err());

        assert!(validate_stdio_start_against_entries(
            &entries(),
            "npx",
            &args,
            &HashMap::new(),
            Some("C:/anywhere")
        )
        .is_err());
    }
}
