//! mcp_server_propose 工具执行器
//!
//! High 敏感度：审批通过后写入 `mcp.tools.list`（secure store），可选自动连测与失败回滚。
//! Secret 值全程不经 agent 之手；`env_required` 只收变量名。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::Utc;
use serde_json::{json, Map, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::mcp_settings_store::{
    emit_mcp_list_changed, read_mcp_tools_list, restore_list_snapshot, write_mcp_tools_list,
    MCP_TOOLS_LIST_KEY,
};
use super::self_inspect_executor::redact_sensitive_json;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;
use crate::database::Database;

pub mod tool_names {
    pub const MCP_SERVER_PROPOSE: &str = "mcp_server_propose";
}

/// env 占位符：与 mcp_manage_executor 共享（用户未填 secret 前保持 disabled）
pub(crate) const ENV_PLACEHOLDER: &str = "<REQUIRED>";
const STDIO_TEST_TIMEOUT: Duration = Duration::from_secs(15);
const REMOTE_TEST_TIMEOUT: Duration = Duration::from_secs(30);

const ALLOWED_TOP_LEVEL_KEYS: &[&str] = &[
    "name",
    "transport",
    "command",
    "args",
    "env_required",
    "url",
    "purpose",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum McpTransport {
    Stdio,
    Sse,
    Http,
    WebSocket,
    StreamableHttp,
}

impl McpTransport {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            McpTransport::Stdio => "stdio",
            McpTransport::Sse => "sse",
            McpTransport::Http => "http",
            McpTransport::WebSocket => "websocket",
            McpTransport::StreamableHttp => "streamable_http",
        }
    }

    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "stdio" => Ok(McpTransport::Stdio),
            "sse" => Ok(McpTransport::Sse),
            "http" => Ok(McpTransport::Http),
            "websocket" | "ws" => Ok(McpTransport::WebSocket),
            "streamable_http" | "streamable-http" | "streamablehttp" => {
                Ok(McpTransport::StreamableHttp)
            }
            other => Err(format!(
                "Unsupported transport '{}'. Allowed: stdio, sse, http, websocket, streamable_http",
                other
            )),
        }
    }
}

/// 连测错误脱敏：截断疑似凭据片段并限制长度（propose / manage 共用）。
pub(crate) fn sanitize_test_error(raw: &str) -> String {
    let mut out = raw.to_string();
    for token in ["Bearer ", "api_key=", "apiKey=", "token=", "password="] {
        if let Some(idx) = out.to_ascii_lowercase().find(&token.to_ascii_lowercase()) {
            out.truncate(idx + token.len());
            out.push_str("<redacted>");
        }
    }
    if out.len() > 500 {
        out.truncate(500);
        out.push('…');
    }
    out
}

/// 对一条 server entry 做一次真实连测（propose / manage 共用）。
/// env 中的占位符不会作为真实环境变量传给子进程。
pub(crate) async fn run_connection_test(transport: McpTransport, entry: &Value) -> Value {
    let noop_progress = |_: &str| {};
    let test_future = async {
        match transport {
            McpTransport::Stdio => {
                let command = entry
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let args: Vec<String> = entry
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|a| a.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                let env: HashMap<String, String> = entry
                    .get("env")
                    .and_then(|v| v.as_object())
                    .map(|map| {
                        map.iter()
                            .filter_map(|(k, v)| {
                                v.as_str()
                                    .filter(|s| *s != ENV_PLACEHOLDER)
                                    .map(|s| (k.clone(), s.to_string()))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                crate::cmd::mcp::mcp_test_helpers::test_stdio(
                    command,
                    args,
                    Some(env),
                    None,
                    None,
                    &noop_progress,
                )
                .await
            }
            McpTransport::WebSocket => {
                let url = entry
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                crate::cmd::mcp::mcp_test_helpers::test_websocket(url).await
            }
            McpTransport::Sse => {
                let endpoint = entry
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                crate::cmd::mcp::mcp_test_helpers::test_sse(endpoint, None, None).await
            }
            McpTransport::Http => {
                let endpoint = entry
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                crate::cmd::mcp::mcp_test_helpers::test_http(endpoint, None, None).await
            }
            McpTransport::StreamableHttp => {
                let url = entry
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                crate::cmd::mcp::mcp_test_helpers::test_streamable_http_rmcp(url, None).await
            }
        }
    };

    let timeout = match transport {
        McpTransport::Stdio => STDIO_TEST_TIMEOUT,
        _ => REMOTE_TEST_TIMEOUT,
    };

    match tokio::time::timeout(timeout, test_future).await {
        Ok(result) => result,
        Err(_) => json!({
            "success": false,
            "error": format!("connection test timed out after {}s", timeout.as_secs()),
        }),
    }
}

#[derive(Debug, Clone)]
struct ProposeInput {
    name: String,
    transport: McpTransport,
    purpose: String,
    command: Option<String>,
    args: Vec<String>,
    env_required: Vec<String>,
    url: Option<String>,
}

pub struct McpProposeExecutor;

impl McpProposeExecutor {
    pub fn new() -> Self {
        Self
    }

    fn with_database<F, T>(ctx: &ExecutionContext, f: F) -> Result<T, String>
    where
        F: FnOnce(&Database) -> Result<T, String>,
    {
        if let Some(db) = ctx.main_db.as_ref() {
            return f(db.as_ref());
        }
        let state = ctx.window_ref().state::<AppState>();
        f(&state.database)
    }

    fn reject_unknown_fields(args: &Value) -> Result<(), String> {
        let Some(obj) = args.as_object() else {
            return Err("Arguments must be a JSON object".to_string());
        };
        for key in obj.keys() {
            if !ALLOWED_TOP_LEVEL_KEYS.contains(&key.as_str()) {
                return Err(format!(
                    "Unknown field '{}'. Allowed fields: {}",
                    key,
                    ALLOWED_TOP_LEVEL_KEYS.join(", ")
                ));
            }
        }
        if obj.contains_key("env") {
            return Err(
                "Field 'env' is not allowed: secrets are not handled by the agent. Use env_required (variable names only); the user fills values in Settings.".to_string(),
            );
        }
        Ok(())
    }

    pub(crate) fn parse_required_string(args: &Value, key: &str) -> Result<String, String> {
        let value = args
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("'{}' is required and must be a non-empty string", key))?;
        Ok(value.to_string())
    }

    fn parse_transport(args: &Value) -> Result<McpTransport, String> {
        let raw = Self::parse_required_string(args, "transport")?;
        McpTransport::parse(&raw)
    }

    pub(crate) fn parse_string_array(
        args: &Value,
        key: &str,
        required: bool,
    ) -> Result<Vec<String>, String> {
        let Some(value) = args.get(key) else {
            return if required {
                Err(format!("'{}' is required", key))
            } else {
                Ok(Vec::new())
            };
        };
        let array = value
            .as_array()
            .ok_or_else(|| format!("'{}' must be an array of strings", key))?;
        let mut out = Vec::new();
        for (idx, item) in array.iter().enumerate() {
            let name = item
                .as_str()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| format!("'{}[{}]' must be a non-empty string", key, idx))?;
            if name.contains('=') {
                return Err(format!(
                    "'{}[{}]' looks like an env assignment; only variable names are allowed (secrets are filled by the user in Settings)",
                    key, idx
                ));
            }
            out.push(name.to_string());
        }
        Ok(out)
    }

    pub(crate) fn validate_https_url(url: &str) -> Result<(), String> {
        let trimmed = url.trim();
        if !trimmed.to_ascii_lowercase().starts_with("https://") {
            return Err("Remote MCP url must use https://".to_string());
        }
        Ok(())
    }

    fn parse_input(args: &Value) -> Result<ProposeInput, String> {
        Self::reject_unknown_fields(args)?;
        let name = Self::parse_required_string(args, "name")?;
        let purpose = Self::parse_required_string(args, "purpose")?;
        let transport = Self::parse_transport(args)?;

        match transport {
            McpTransport::Stdio => {
                let command = Some(Self::parse_required_string(args, "command")?);
                let args_list = Self::parse_string_array(args, "args", false)?;
                let env_required = Self::parse_string_array(args, "env_required", false)?;
                if args.get("url").is_some() {
                    return Err("'url' is not valid for stdio transport".to_string());
                }
                Ok(ProposeInput {
                    name,
                    transport,
                    purpose,
                    command,
                    args: args_list,
                    env_required,
                    url: None,
                })
            }
            McpTransport::Sse
            | McpTransport::Http
            | McpTransport::WebSocket
            | McpTransport::StreamableHttp => {
                if args.get("command").is_some() || args.get("args").is_some() {
                    return Err(format!(
                        "'command' and 'args' are only valid for stdio transport (got transport={})",
                        transport.as_str()
                    ));
                }
                let url = Self::parse_required_string(args, "url")?;
                Self::validate_https_url(&url)?;
                let env_required = Self::parse_string_array(args, "env_required", false)?;
                if !env_required.is_empty() {
                    return Err(
                        "env_required is only supported for stdio transport; remote transports use Settings for api keys".to_string(),
                    );
                }
                Ok(ProposeInput {
                    name,
                    transport,
                    purpose,
                    command: None,
                    args: Vec::new(),
                    env_required: Vec::new(),
                    url: Some(url),
                })
            }
        }
    }

    fn server_name(entry: &Value) -> Option<&str> {
        entry
            .get("name")
            .or_else(|| entry.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }

    fn server_command_args(entry: &Value) -> Option<(String, Vec<String>)> {
        let command = entry.get("command").and_then(Value::as_str)?.trim();
        if command.is_empty() {
            return None;
        }
        let args = entry
            .get("args")
            .and_then(|v| {
                if let Some(arr) = v.as_array() {
                    Some(
                        arr.iter()
                            .filter_map(|a| a.as_str().map(str::trim).filter(|s| !s.is_empty()))
                            .map(str::to_string)
                            .collect::<Vec<_>>(),
                    )
                } else {
                    v.as_str().map(|s| {
                        s.split(',')
                            .map(str::trim)
                            .filter(|part| !part.is_empty())
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                }
            })
            .unwrap_or_default();
        Some((command.to_string(), args))
    }

    fn find_duplicate(existing: &[Value], input: &ProposeInput) -> Option<String> {
        let target_name = input.name.to_ascii_lowercase();
        for entry in existing {
            if let Some(name) = Self::server_name(entry) {
                if name.eq_ignore_ascii_case(&input.name)
                    || name.to_ascii_lowercase() == target_name
                {
                    return Some(format!(
                        "MCP server with name '{}' is already configured",
                        name
                    ));
                }
            }
            if input.transport == McpTransport::Stdio {
                if let (Some(cmd), Some((existing_cmd, existing_args))) =
                    (input.command.as_ref(), Self::server_command_args(entry))
                {
                    if existing_cmd == *cmd && existing_args == input.args {
                        let display_name = Self::server_name(entry).unwrap_or("existing server");
                        return Some(format!(
                            "MCP server '{}' already uses the same command and args",
                            display_name
                        ));
                    }
                }
            }
        }
        None
    }

    fn build_server_entry(input: &ProposeInput) -> (Value, bool) {
        let needs_secrets = !input.env_required.is_empty();
        let enabled = !needs_secrets;
        let id = input.name.clone();

        let mut entry = Map::new();
        entry.insert("id".to_string(), json!(id));
        entry.insert("name".to_string(), json!(input.name));
        entry.insert("transportType".to_string(), json!(input.transport.as_str()));
        entry.insert("enabled".to_string(), json!(enabled));

        match input.transport {
            McpTransport::Stdio => {
                entry.insert(
                    "command".to_string(),
                    json!(input.command.clone().unwrap_or_default()),
                );
                entry.insert("args".to_string(), json!(input.args));
                if needs_secrets {
                    let mut env = Map::new();
                    for key in &input.env_required {
                        env.insert(key.clone(), json!(ENV_PLACEHOLDER));
                    }
                    entry.insert("env".to_string(), Value::Object(env));
                } else {
                    entry.insert("env".to_string(), json!({}));
                }
            }
            McpTransport::WebSocket => {
                entry.insert(
                    "url".to_string(),
                    json!(input.url.clone().unwrap_or_default()),
                );
            }
            McpTransport::Http => {
                entry.insert(
                    "url".to_string(),
                    json!(input.url.clone().unwrap_or_default()),
                );
            }
            McpTransport::Sse | McpTransport::StreamableHttp => {
                let url = input.url.clone().unwrap_or_default();
                entry.insert("url".to_string(), json!(url));
                entry.insert(
                    "fetch".to_string(),
                    json!({
                        "type": input.transport.as_str(),
                        "url": url,
                    }),
                );
            }
        }

        (Value::Object(entry), enabled)
    }

    fn provenance_key(name: &str) -> String {
        format!("mcp.propose.provenance.{}", name)
    }

    fn write_provenance(
        db: &Database,
        input: &ProposeInput,
        session_id: &str,
        enabled_on_install: bool,
    ) -> Result<(), String> {
        let payload = json!({
            "purpose": input.purpose,
            "session_id": session_id,
            "proposed_at": Utc::now().to_rfc3339(),
            "transport": input.transport.as_str(),
            "enabled_on_install": enabled_on_install,
        });
        let serialized = serde_json::to_string(&payload)
            .map_err(|e| format!("failed to serialize provenance: {}", e))?;
        db.save_setting(&Self::provenance_key(&input.name), &serialized)
            .map_err(|e| format!("failed to write provenance: {}", e))
    }

    fn server_summary(entry: &Value, input: &ProposeInput) -> Value {
        let mut summary = Map::new();
        summary.insert("name".to_string(), json!(input.name));
        summary.insert("transport".to_string(), json!(input.transport.as_str()));
        summary.insert(
            "enabled".to_string(),
            json!(entry
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)),
        );
        if input.transport == McpTransport::Stdio {
            summary.insert(
                "command".to_string(),
                json!(entry.get("command").and_then(Value::as_str).unwrap_or("")),
            );
            summary.insert(
                "args".to_string(),
                entry.get("args").cloned().unwrap_or(json!([])),
            );
            if !input.env_required.is_empty() {
                summary.insert("env_required".to_string(), json!(input.env_required));
            }
        } else {
            summary.insert("url".to_string(), json!("<remote-endpoint>"));
        }
        redact_sensitive_json(Value::Object(summary))
    }

    async fn execute_proposal(
        ctx: &ExecutionContext,
        input: ProposeInput,
    ) -> Result<Value, String> {
        // 读→查重→写 临界区：与 mcp_manage_executor 共享同一把进程内锁
        let (snapshot, entry, should_test) = {
            let _guard = super::mcp_settings_store::mcp_list_mutation_guard();
            let existing = Self::with_database(ctx, read_mcp_tools_list)?;
            if let Some(reason) = Self::find_duplicate(&existing, &input) {
                return Err(reason);
            }

            let snapshot = restore_list_snapshot(&existing);
            let (entry, should_test) = Self::build_server_entry(&input);
            let mut updated = existing;
            updated.push(entry.clone());

            Self::with_database(ctx, |db| write_mcp_tools_list(db, &updated))?;
            (snapshot, entry, should_test)
        };
        Self::with_database(ctx, |db| {
            Self::write_provenance(db, &input, &ctx.session_id, should_test)
        })?;

        if should_test {
            let test_result = run_connection_test(input.transport, &entry).await;
            let success = test_result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if !success {
                Self::with_database(ctx, |db| write_mcp_tools_list(db, &snapshot))?;
                let error = test_result
                    .get("error")
                    .or_else(|| test_result.get("message"))
                    .and_then(Value::as_str)
                    .map(sanitize_test_error)
                    .unwrap_or_else(|| "connection test failed".to_string());
                return Err(format!(
                    "MCP connection test failed: {}. Configuration has been rolled back.",
                    error
                ));
            }

            let tools_count = test_result
                .get("tools")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);

            emit_mcp_list_changed(ctx.window_ref(), "mcp_server_propose");
            return Ok(redact_sensitive_json(json!({
                "status": "installed_and_tested",
                "message": format!("MCP server '{}' added and connection test succeeded ({} tools discovered).", input.name, tools_count),
                "server": Self::server_summary(&entry, &input),
                "test": {
                    "success": true,
                    "transport": input.transport.as_str(),
                    "tools_count": tools_count,
                },
                "settings_key": MCP_TOOLS_LIST_KEY,
            })));
        }

        emit_mcp_list_changed(ctx.window_ref(), "mcp_server_propose");
        Ok(redact_sensitive_json(json!({
            "status": "pending_secrets",
            "message": format!(
                "Configuration written (disabled). Open Settings > MCP Tools, fill env variables [{}], then enable the server.",
                input.env_required.join(", ")
            ),
            "server": Self::server_summary(&entry, &input),
            "env_required": input.env_required,
            "settings_key": MCP_TOOLS_LIST_KEY,
        })))
    }
}

impl Default for McpProposeExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for McpProposeExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == tool_names::MCP_SERVER_PROPOSE
            || tool_name
                .strip_prefix("builtin-")
                .is_some_and(|name| name == tool_names::MCP_SERVER_PROPOSE)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = async {
            let input = Self::parse_input(&call.arguments)?;
            Self::execute_proposal(ctx, input).await
        }
        .await;

        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                );
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[McpProposeExecutor] Failed to save tool block: {}", e);
                }
                Ok(result)
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                );
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[McpProposeExecutor] Failed to save tool block: {}", e);
                }
                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::High
    }

    fn name(&self) -> &'static str {
        "McpProposeExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_fields() {
        let err = McpProposeExecutor::parse_input(&json!({
            "name": "brave",
            "transport": "stdio",
            "command": "npx",
            "purpose": "search",
            "extra": true
        }))
        .unwrap_err();
        assert!(err.contains("Unknown field"));
    }

    #[test]
    fn rejects_env_field_with_values() {
        let err = McpProposeExecutor::parse_input(&json!({
            "name": "brave",
            "transport": "stdio",
            "command": "npx",
            "purpose": "search",
            "env": { "BRAVE_API_KEY": "secret" }
        }))
        .unwrap_err();
        assert!(err.contains("env"));
    }

    #[test]
    fn rejects_env_required_with_value_shape() {
        let err = McpProposeExecutor::parse_input(&json!({
            "name": "brave",
            "transport": "stdio",
            "command": "npx",
            "purpose": "search",
            "env_required": ["BRAVE_API_KEY=abc"]
        }))
        .unwrap_err();
        assert!(err.contains("env assignment"));
    }

    #[test]
    fn rejects_non_https_url() {
        let err = McpProposeExecutor::parse_input(&json!({
            "name": "remote",
            "transport": "sse",
            "url": "http://example.com/mcp",
            "purpose": "remote mcp"
        }))
        .unwrap_err();
        assert!(err.contains("https"));
    }

    #[test]
    fn detects_duplicate_name() {
        let existing = vec![json!({
            "id": "brave",
            "name": "brave",
            "transportType": "stdio",
            "command": "npx",
            "args": ["-y", "other"]
        })];
        let input = ProposeInput {
            name: "brave".to_string(),
            transport: McpTransport::Stdio,
            purpose: "search".to_string(),
            command: Some("npx".to_string()),
            args: vec!["-y".to_string(), "@pkg".to_string()],
            env_required: vec![],
            url: None,
        };
        let dup = McpProposeExecutor::find_duplicate(&existing, &input);
        assert!(dup.is_some());
    }

    #[test]
    fn detects_duplicate_command_args() {
        let existing = vec![json!({
            "id": "pkg",
            "name": "pkg",
            "transportType": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-brave-search"]
        })];
        let input = ProposeInput {
            name: "brave-search".to_string(),
            transport: McpTransport::Stdio,
            purpose: "search".to_string(),
            command: Some("npx".to_string()),
            args: vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-brave-search".to_string(),
            ],
            env_required: vec![],
            url: None,
        };
        let dup = McpProposeExecutor::find_duplicate(&existing, &input);
        assert!(dup.is_some());
    }

    #[test]
    fn builds_placeholder_env_and_disabled() {
        let input = ProposeInput {
            name: "brave".to_string(),
            transport: McpTransport::Stdio,
            purpose: "search".to_string(),
            command: Some("npx".to_string()),
            args: vec!["-y".to_string(), "@pkg".to_string()],
            env_required: vec!["BRAVE_API_KEY".to_string()],
            url: None,
        };
        let (entry, enabled) = McpProposeExecutor::build_server_entry(&input);
        assert!(!enabled);
        assert_eq!(entry.get("enabled").and_then(Value::as_bool), Some(false));
        assert_eq!(
            entry.pointer("/env/BRAVE_API_KEY").and_then(Value::as_str),
            Some(ENV_PLACEHOLDER)
        );
    }

    #[test]
    fn builds_enabled_stdio_without_secrets() {
        let input = ProposeInput {
            name: "fs".to_string(),
            transport: McpTransport::Stdio,
            purpose: "filesystem".to_string(),
            command: Some("npx".to_string()),
            args: vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-filesystem".to_string(),
            ],
            env_required: vec![],
            url: None,
        };
        let (entry, enabled) = McpProposeExecutor::build_server_entry(&input);
        assert!(enabled);
        assert_eq!(entry.get("enabled").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn restore_snapshot_roundtrip() {
        let snapshot = vec![json!({"id": "a"})];
        let restored = restore_list_snapshot(&snapshot);
        assert_eq!(restored, snapshot);
    }

    #[test]
    fn handles_expected_tool_names() {
        let executor = McpProposeExecutor::new();
        assert!(executor.can_handle("mcp_server_propose"));
        assert!(executor.can_handle("builtin-mcp_server_propose"));
        assert!(!executor.can_handle("mcp_server_propose_extra"));
    }

    #[test]
    fn sensitivity_is_high() {
        let executor = McpProposeExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-mcp_server_propose"),
            ToolSensitivity::High
        );
    }
}
