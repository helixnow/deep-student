//! MCP 连接测试辅助（stdio / WebSocket / SSE / HTTP / Streamable HTTP 探测）。
//!
//! 拆分前位于 app 的 `cmd::mcp::mcp_test_helpers`（只依赖 `crate::mcp`）；
//! app 的 `cmd::mcp::mcp_test_helpers` 现为本模块的 `pub use` 重导出，旧路径继续可用。
//! chat_v2 的 `mcp_server_propose` 连测与设置页 `test_mcp_*` 命令共用这里的实现。

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

pub async fn test_streamable_http_rmcp(url: String, api_key: Option<String>) -> serde_json::Value {
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
        version: dstu_core::APP_VERSION.to_string(),
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
                    return Err(McpError::ConnectionError(format!("连接超时: {}", last_error)));
                }
                sleep(CONNECT_RETRY_DELAY).await;
            }
        }
    }
}
