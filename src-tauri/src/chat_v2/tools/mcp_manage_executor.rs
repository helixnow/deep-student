//! mcp_server_update / mcp_server_set_enabled / mcp_server_remove 工具执行器
//!
//! 与 `mcp_server_propose` 同族的 MCP server 治理正门：
//! - `mcp_server_update`（High，必审批、never-remember）：按 server id/名称修改已有
//!   配置（name、transport、command、args、env_required、url）。与 propose 相同的
//!   凭据红线：显式拒绝 `env` 明文字段，`env_required` 只收变量名；修改后如无新增
//!   密钥需求且 server 处于启用态则自动连测，失败回滚旧配置。
//! - `mcp_server_set_enabled`（Medium，可 remember，scope 绑定 server + 启停方向）：
//!   启用/停用已有 server。启用前校验 env 占位符已填完（fail-closed）。
//! - `mcp_server_remove`（High，必审批、never-remember）：删除 server 配置。
//!   参数必须携带 `expected_transport`（来自 self_inspect 的 mcp 段），审批卡与
//!   执行期都据此展示/复核 transport 摘要，防止凭名字误删。
//!
//! 三个工具写入成功后经 `emit_mcp_list_changed` 通知前端重载 MCP 连接
//! （settings_changed 域事件 → systemSettingsChanged → bootstrapMcpFromSettings）。
//! 读→改→写 全程持 `mcp_list_mutation_guard` 进程内锁（不跨 await）。

use std::time::Instant;

use async_trait::async_trait;
use chrono::Utc;
use serde_json::{json, Map, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::mcp_propose_executor::{
    run_connection_test, sanitize_test_error, McpProposeExecutor, McpTransport, ENV_PLACEHOLDER,
};
use super::mcp_settings_store::{
    emit_mcp_list_changed, mcp_list_mutation_guard, read_mcp_tools_list, write_mcp_tools_list,
    MCP_TOOLS_LIST_KEY,
};
use super::self_inspect_executor::redact_sensitive_json;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;
use crate::database::Database;

pub mod tool_names {
    pub const MCP_SERVER_UPDATE: &str = "mcp_server_update";
    pub const MCP_SERVER_SET_ENABLED: &str = "mcp_server_set_enabled";
    pub const MCP_SERVER_REMOVE: &str = "mcp_server_remove";
}

/// update 允许的顶层字段（`env` 被显式拒绝，见 reject_unknown_fields）
const UPDATE_ALLOWED_KEYS: &[&str] = &[
    "server_id",
    "name",
    "transport",
    "command",
    "args",
    "env_required",
    "url",
    "reason",
];
const SET_ENABLED_ALLOWED_KEYS: &[&str] = &["server_id", "enabled", "reason"];
const REMOVE_ALLOWED_KEYS: &[&str] = &["server_id", "expected_transport", "reason"];

/// manage 侧审计记录键前缀（与 propose 的 `mcp.propose.provenance.` 并存）
const MANAGE_PROVENANCE_PREFIX: &str = "mcp.manage.provenance.";
const PROPOSE_PROVENANCE_PREFIX: &str = "mcp.propose.provenance.";

#[derive(Debug, Clone, Default)]
struct UpdateInput {
    server_id: String,
    name: Option<String>,
    transport: Option<McpTransport>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env_required: Option<Vec<String>>,
    url: Option<String>,
}

/// apply_update 的结果：更新后的 entry + 决策摘要
struct UpdateOutcome {
    entry: Value,
    transport: McpTransport,
    needs_secrets: bool,
    enabled: bool,
    changed_fields: Vec<String>,
    env_required: Vec<String>,
}

pub struct McpManageExecutor;

impl Default for McpManageExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl McpManageExecutor {
    pub fn new() -> Self {
        Self
    }

    fn short_name(tool_name: &str) -> &str {
        // 与 McpProposeExecutor 一致：只剥 builtin- 前缀。
        // 不能用 strip_tool_namespace（会把裸名 mcp_server_* 误剥成 server_*）。
        tool_name.strip_prefix("builtin-").unwrap_or(tool_name)
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

    // ------------------------------------------------------------------
    // 通用参数解析 / entry 访问
    // ------------------------------------------------------------------

    fn reject_unknown_fields(args: &Value, allowed: &[&str]) -> Result<(), String> {
        let Some(obj) = args.as_object() else {
            return Err("Arguments must be a JSON object".to_string());
        };
        // 凭据红线：与 propose 相同，env 明文通道直接拒绝
        if obj.contains_key("env") {
            return Err(
                "Field 'env' is not allowed: secrets are not handled by the agent. Use env_required (variable names only); the user fills values in Settings.".to_string(),
            );
        }
        for key in obj.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(format!(
                    "Unknown field '{}'. Allowed fields: {}",
                    key,
                    allowed.join(", ")
                ));
            }
        }
        Ok(())
    }

    fn parse_server_id(args: &Value) -> Result<String, String> {
        McpProposeExecutor::parse_required_string(args, "server_id")
    }

    fn entry_id(entry: &Value) -> Option<&str> {
        entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }

    fn entry_name(entry: &Value) -> Option<&str> {
        entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }

    fn entry_transport_raw(entry: &Value) -> &str {
        entry
            .get("transportType")
            .or_else(|| entry.get("transport"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            // 与前端 toServerConfigs 的缺省一致
            .unwrap_or("sse")
    }

    fn entry_enabled(entry: &Value) -> bool {
        // 存量条目缺省视为启用（与前端 toServerConfigs / Settings 兼容口径一致）
        entry.get("enabled").and_then(Value::as_bool).unwrap_or(true)
    }

    /// 先精确匹配 id，再按 name（忽略大小写）匹配，避免同名歧义时误改别的条目
    fn find_server_index(list: &[Value], server_id: &str) -> Option<usize> {
        let needle = server_id.trim();
        list.iter()
            .position(|e| Self::entry_id(e) == Some(needle))
            .or_else(|| {
                list.iter().position(|e| {
                    Self::entry_name(e)
                        .map(|n| n.eq_ignore_ascii_case(needle))
                        .unwrap_or(false)
                })
            })
    }

    fn server_not_found(server_id: &str) -> String {
        format!(
            "MCP server '{}' was not found in {}. Use self_inspect (section=mcp) to list configured servers.",
            server_id, MCP_TOOLS_LIST_KEY
        )
    }

    /// entry 中缺失/仍为占位符的 env 变量名（启用前必须为空）
    fn missing_env_vars(entry: &Value) -> Vec<String> {
        entry
            .get("env")
            .and_then(Value::as_object)
            .map(|env| {
                env.iter()
                    .filter(|(_, v)| {
                        v.as_str()
                            .map(|s| s.trim().is_empty() || s == ENV_PLACEHOLDER)
                            .unwrap_or(true)
                    })
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 脱敏后的 entry 摘要（不外泄 env 值与远程 url）
    fn entry_summary(entry: &Value) -> Value {
        let mut summary = Map::new();
        if let Some(id) = Self::entry_id(entry) {
            summary.insert("id".to_string(), json!(id));
        }
        if let Some(name) = Self::entry_name(entry) {
            summary.insert("name".to_string(), json!(name));
        }
        summary.insert(
            "transport".to_string(),
            json!(Self::entry_transport_raw(entry)),
        );
        summary.insert("enabled".to_string(), json!(Self::entry_enabled(entry)));
        if let Some(command) = entry.get("command").and_then(Value::as_str) {
            summary.insert("command".to_string(), json!(command));
            summary.insert(
                "args".to_string(),
                entry.get("args").cloned().unwrap_or(json!([])),
            );
        }
        if entry.get("url").is_some() {
            summary.insert("url".to_string(), json!("<remote-endpoint>"));
        }
        let env_keys: Vec<String> = entry
            .get("env")
            .and_then(Value::as_object)
            .map(|env| env.keys().cloned().collect())
            .unwrap_or_default();
        if !env_keys.is_empty() {
            summary.insert("env_keys".to_string(), json!(env_keys));
        }
        redact_sensitive_json(Value::Object(summary))
    }

    fn write_manage_provenance(
        db: &Database,
        server_id: &str,
        action: &str,
        session_id: &str,
        detail: Value,
    ) -> Result<(), String> {
        let payload = json!({
            "action": action,
            "session_id": session_id,
            "at": Utc::now().to_rfc3339(),
            "detail": detail,
        });
        let serialized = serde_json::to_string(&payload)
            .map_err(|e| format!("failed to serialize provenance: {}", e))?;
        db.save_setting(
            &format!("{}{}", MANAGE_PROVENANCE_PREFIX, server_id),
            &serialized,
        )
        .map_err(|e| format!("failed to write provenance: {}", e))
    }

    // ------------------------------------------------------------------
    // mcp_server_update
    // ------------------------------------------------------------------

    fn parse_update_input(args: &Value) -> Result<UpdateInput, String> {
        Self::reject_unknown_fields(args, UPDATE_ALLOWED_KEYS)?;
        let server_id = Self::parse_server_id(args)?;

        let name = match args.get("name") {
            None => None,
            Some(_) => Some(McpProposeExecutor::parse_required_string(args, "name")?),
        };
        let transport = match args.get("transport") {
            None => None,
            Some(_) => {
                let raw = McpProposeExecutor::parse_required_string(args, "transport")?;
                Some(McpTransport::parse(&raw)?)
            }
        };
        let command = match args.get("command") {
            None => None,
            Some(_) => Some(McpProposeExecutor::parse_required_string(args, "command")?),
        };
        let args_list = match args.get("args") {
            None => None,
            Some(_) => Some(McpProposeExecutor::parse_string_array(args, "args", true)?),
        };
        // env_required 复用 propose 的解析：拒绝 NAME=value 形态（只收变量名）
        let env_required = match args.get("env_required") {
            None => None,
            Some(_) => Some(McpProposeExecutor::parse_string_array(
                args,
                "env_required",
                true,
            )?),
        };
        let url = match args.get("url") {
            None => None,
            Some(_) => {
                let raw = McpProposeExecutor::parse_required_string(args, "url")?;
                McpProposeExecutor::validate_https_url(&raw)?;
                Some(raw)
            }
        };

        let input = UpdateInput {
            server_id,
            name,
            transport,
            command,
            args: args_list,
            env_required,
            url,
        };
        if input.name.is_none()
            && input.transport.is_none()
            && input.command.is_none()
            && input.args.is_none()
            && input.env_required.is_none()
            && input.url.is_none()
        {
            return Err(
                "At least one field to change is required (name, transport, command, args, env_required, url)".to_string(),
            );
        }
        Ok(input)
    }

    /// 对已有 entry 应用 update（纯函数，便于单测）。
    /// 不做重名检查（需要整表上下文，由 execute_update 负责）。
    fn apply_update(existing: &Value, input: &UpdateInput) -> Result<UpdateOutcome, String> {
        let mut entry = existing
            .as_object()
            .cloned()
            .ok_or("existing MCP server entry is not a JSON object")?;
        let mut changed: Vec<String> = Vec::new();

        let old_transport = McpTransport::parse(Self::entry_transport_raw(existing)).ok();
        let transport = match (input.transport, old_transport) {
            (Some(t), _) => t,
            (None, Some(t)) => t,
            (None, None) => {
                return Err(format!(
                    "Existing entry has unrecognized transport '{}'; pass 'transport' explicitly to normalize it.",
                    Self::entry_transport_raw(existing)
                ))
            }
        };
        let transport_changed = old_transport != Some(transport);
        if transport_changed {
            changed.push("transport".to_string());
        }
        // 始终写规范化的 transportType（legacy 别名如 streamable-http 一并归一）
        entry.insert("transportType".to_string(), json!(transport.as_str()));

        if let Some(name) = &input.name {
            if Self::entry_name(existing) != Some(name.as_str()) {
                changed.push("name".to_string());
            }
            entry.insert("name".to_string(), json!(name));
            // id 保持稳定：前端 serverId 引用与 provenance 键都锚定 id
        }

        match transport {
            McpTransport::Stdio => {
                if input.url.is_some() {
                    return Err("'url' is not valid for stdio transport".to_string());
                }
                let command = input
                    .command
                    .clone()
                    .or_else(|| {
                        existing
                            .get("command")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                            .map(str::to_string)
                    })
                    .ok_or("'command' is required when switching to stdio transport")?;
                if input.command.is_some()
                    && existing.get("command").and_then(Value::as_str) != Some(command.as_str())
                {
                    changed.push("command".to_string());
                }
                entry.insert("command".to_string(), json!(command));

                if let Some(args_list) = &input.args {
                    changed.push("args".to_string());
                    entry.insert("args".to_string(), json!(args_list));
                } else if !entry.contains_key("args") {
                    entry.insert("args".to_string(), json!([]));
                }

                // env 合并策略：只按 env_required 的变量名集合增删，保留用户已填的值
                if let Some(names) = &input.env_required {
                    changed.push("env_required".to_string());
                    let old_env = existing
                        .get("env")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    let mut env = Map::new();
                    for key in names {
                        let kept = old_env
                            .get(key)
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|v| !v.is_empty());
                        env.insert(
                            key.clone(),
                            json!(kept.unwrap_or(ENV_PLACEHOLDER)),
                        );
                    }
                    entry.insert("env".to_string(), Value::Object(env));
                } else if transport_changed {
                    // 远程 → stdio 且未声明 env_required：从空 env 开始
                    entry.insert("env".to_string(), json!({}));
                }
                entry.remove("url");
                entry.remove("fetch");
                // 前端 resolveUrl 会优先取 legacy endpoint 字段，一并清掉
                entry.remove("endpoint");
            }
            McpTransport::Sse
            | McpTransport::Http
            | McpTransport::WebSocket
            | McpTransport::StreamableHttp => {
                if input.command.is_some() || input.args.is_some() {
                    return Err(format!(
                        "'command' and 'args' are only valid for stdio transport (got transport={})",
                        transport.as_str()
                    ));
                }
                if input
                    .env_required
                    .as_ref()
                    .is_some_and(|names| !names.is_empty())
                {
                    return Err(
                        "env_required is only supported for stdio transport; remote transports use Settings for api keys".to_string(),
                    );
                }
                let url = input
                    .url
                    .clone()
                    .or_else(|| {
                        // transport 未变时才继承旧 url；stdio → 远程必须显式给 url
                        if transport_changed {
                            None
                        } else {
                            existing
                                .get("url")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|v| !v.is_empty())
                                .map(str::to_string)
                        }
                    })
                    .ok_or("'url' is required for remote transports")?;
                if input.url.is_some() {
                    changed.push("url".to_string());
                }
                entry.insert("url".to_string(), json!(url));
                match transport {
                    McpTransport::Sse | McpTransport::StreamableHttp => {
                        entry.insert(
                            "fetch".to_string(),
                            json!({ "type": transport.as_str(), "url": url }),
                        );
                    }
                    _ => {
                        entry.remove("fetch");
                    }
                }
                entry.remove("command");
                entry.remove("args");
                entry.remove("env");
                // legacy endpoint 优先级高于 url（前端 resolveUrl），改 url 时必须清掉
                entry.remove("endpoint");
            }
        }

        if changed.is_empty() {
            return Err("No effective change: the provided values match the current configuration".to_string());
        }

        let updated = Value::Object(entry);
        let missing = Self::missing_env_vars(&updated);
        let needs_secrets = !missing.is_empty();
        // 新增密钥需求 → 强制 disabled 等用户填值；否则保留原 enabled
        let enabled = if needs_secrets {
            false
        } else {
            Self::entry_enabled(existing)
        };
        let mut entry = updated;
        entry
            .as_object_mut()
            .expect("entry is object")
            .insert("enabled".to_string(), json!(enabled));

        Ok(UpdateOutcome {
            entry,
            transport,
            needs_secrets,
            enabled,
            changed_fields: changed,
            env_required: missing,
        })
    }

    /// 重名检查：改名后不得与其他条目的 id/name 冲突
    fn find_name_conflict(list: &[Value], self_index: usize, new_name: &str) -> Option<String> {
        for (idx, entry) in list.iter().enumerate() {
            if idx == self_index {
                continue;
            }
            let hit = Self::entry_name(entry)
                .map(|n| n.eq_ignore_ascii_case(new_name))
                .unwrap_or(false)
                || Self::entry_id(entry)
                    .map(|n| n.eq_ignore_ascii_case(new_name))
                    .unwrap_or(false);
            if hit {
                return Some(format!(
                    "MCP server with name '{}' is already configured",
                    new_name
                ));
            }
        }
        None
    }

    async fn execute_update(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let input = Self::parse_update_input(args)?;

        // 读→改→写 临界区（不跨 await）
        let (old_entry, outcome, entry_id) = {
            let _guard = mcp_list_mutation_guard();
            let mut list = Self::with_database(ctx, read_mcp_tools_list)?;
            let index = Self::find_server_index(&list, &input.server_id)
                .ok_or_else(|| Self::server_not_found(&input.server_id))?;
            if let Some(name) = &input.name {
                if let Some(conflict) = Self::find_name_conflict(&list, index, name) {
                    return Err(conflict);
                }
            }
            let old_entry = list[index].clone();
            let outcome = Self::apply_update(&old_entry, &input)?;
            let entry_id = Self::entry_id(&old_entry)
                .unwrap_or(input.server_id.as_str())
                .to_string();
            list[index] = outcome.entry.clone();
            Self::with_database(ctx, |db| write_mcp_tools_list(db, &list))?;
            (old_entry, outcome, entry_id)
        };

        if let Err(e) = Self::with_database(ctx, |db| {
            Self::write_manage_provenance(
                db,
                &entry_id,
                "updated",
                &ctx.session_id,
                json!({ "changed_fields": outcome.changed_fields }),
            )
        }) {
            log::warn!("[McpManageExecutor] provenance write failed: {}", e);
        }

        // 无新增密钥需求且 server 启用中 → 自动连测，失败回滚旧配置
        if outcome.enabled && !outcome.needs_secrets {
            let test_result = run_connection_test(outcome.transport, &outcome.entry).await;
            let success = test_result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !success {
                // 目标条目定点回滚（不整表覆盖，避免吞掉并发变更）
                {
                    let _guard = mcp_list_mutation_guard();
                    let mut list = Self::with_database(ctx, read_mcp_tools_list)?;
                    if let Some(idx) = Self::find_server_index(&list, &entry_id) {
                        list[idx] = old_entry.clone();
                        Self::with_database(ctx, |db| write_mcp_tools_list(db, &list))?;
                    }
                }
                let error = test_result
                    .get("error")
                    .or_else(|| test_result.get("message"))
                    .and_then(Value::as_str)
                    .map(sanitize_test_error)
                    .unwrap_or_else(|| "connection test failed".to_string());
                return Err(format!(
                    "MCP connection test failed after update: {}. The previous configuration has been restored.",
                    error
                ));
            }

            let tools_count = test_result
                .get("tools")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            emit_mcp_list_changed(ctx.window_ref(), tool_names::MCP_SERVER_UPDATE);
            return Ok(redact_sensitive_json(json!({
                "status": "updated_and_tested",
                "server_id": entry_id,
                "changed_fields": outcome.changed_fields,
                "server": Self::entry_summary(&outcome.entry),
                "test": {
                    "success": true,
                    "transport": outcome.transport.as_str(),
                    "tools_count": tools_count,
                },
                "settings_key": MCP_TOOLS_LIST_KEY,
            })));
        }

        emit_mcp_list_changed(ctx.window_ref(), tool_names::MCP_SERVER_UPDATE);
        if outcome.needs_secrets {
            return Ok(redact_sensitive_json(json!({
                "status": "pending_secrets",
                "server_id": entry_id,
                "changed_fields": outcome.changed_fields,
                "message": format!(
                    "Configuration updated (disabled). Open Settings > MCP Tools, fill env variables [{}], then enable the server.",
                    outcome.env_required.join(", ")
                ),
                "env_required": outcome.env_required,
                "server": Self::entry_summary(&outcome.entry),
                "settings_key": MCP_TOOLS_LIST_KEY,
            })));
        }
        Ok(redact_sensitive_json(json!({
            "status": "updated_disabled",
            "server_id": entry_id,
            "changed_fields": outcome.changed_fields,
            "message": "Configuration updated. The server is currently disabled, so no connection test was run; enable it with mcp_server_set_enabled to connect.",
            "server": Self::entry_summary(&outcome.entry),
            "settings_key": MCP_TOOLS_LIST_KEY,
        })))
    }

    // ------------------------------------------------------------------
    // mcp_server_set_enabled
    // ------------------------------------------------------------------

    async fn execute_set_enabled(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        Self::reject_unknown_fields(args, SET_ENABLED_ALLOWED_KEYS)?;
        let server_id = Self::parse_server_id(args)?;
        let enabled = args
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or("'enabled' is required (true = 启用, false = 停用)")?;

        let (entry_id, previous_enabled, summary) = {
            let _guard = mcp_list_mutation_guard();
            let mut list = Self::with_database(ctx, read_mcp_tools_list)?;
            let index = Self::find_server_index(&list, &server_id)
                .ok_or_else(|| Self::server_not_found(&server_id))?;
            let entry = &list[index];
            let entry_id = Self::entry_id(entry).unwrap_or(server_id.as_str()).to_string();
            let previous_enabled = Self::entry_enabled(entry);

            if enabled {
                let missing = Self::missing_env_vars(entry);
                if !missing.is_empty() {
                    return Err(format!(
                        "Cannot enable '{}': env variables [{}] are not filled yet. Ask the user to fill them in Settings > MCP Tools first.",
                        entry_id,
                        missing.join(", ")
                    ));
                }
            }

            list[index]
                .as_object_mut()
                .ok_or("MCP server entry is not a JSON object")?
                .insert("enabled".to_string(), json!(enabled));
            Self::with_database(ctx, |db| write_mcp_tools_list(db, &list))?;
            let summary = Self::entry_summary(&list[index]);
            (entry_id, previous_enabled, summary)
        };

        emit_mcp_list_changed(ctx.window_ref(), tool_names::MCP_SERVER_SET_ENABLED);
        Ok(redact_sensitive_json(json!({
            "server_id": entry_id,
            "enabled": enabled,
            "previous_enabled": previous_enabled,
            "server": summary,
            "message": if enabled {
                "Server enabled. The frontend MCP client will reconnect and advertise its tools shortly."
            } else {
                "Server disabled. The frontend MCP client will drop the connection; configuration and filled env values are kept."
            },
            "settings_key": MCP_TOOLS_LIST_KEY,
        })))
    }

    // ------------------------------------------------------------------
    // mcp_server_remove
    // ------------------------------------------------------------------

    async fn execute_remove(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, REMOVE_ALLOWED_KEYS)?;
        let server_id = Self::parse_server_id(args)?;
        let expected_transport_raw =
            McpProposeExecutor::parse_required_string(args, "expected_transport")?;
        let expected_transport = McpTransport::parse(&expected_transport_raw)?;

        let (entry_id, entry_name, transport_raw, summary) = {
            let _guard = mcp_list_mutation_guard();
            let mut list = Self::with_database(ctx, read_mcp_tools_list)?;
            let index = Self::find_server_index(&list, &server_id)
                .ok_or_else(|| Self::server_not_found(&server_id))?;
            let entry = &list[index];

            // 审批卡上展示的 transport 必须与存储一致（防止凭名字误删）
            let actual_raw = Self::entry_transport_raw(entry).to_string();
            let matches = McpTransport::parse(&actual_raw)
                .map(|t| t == expected_transport)
                .unwrap_or_else(|_| actual_raw.eq_ignore_ascii_case(&expected_transport_raw));
            if !matches {
                return Err(format!(
                    "expected_transport '{}' does not match the stored transport '{}' for server '{}'. Re-run self_inspect (section=mcp) and retry with the actual transport.",
                    expected_transport_raw, actual_raw, server_id
                ));
            }

            let entry_id = Self::entry_id(entry).unwrap_or(server_id.as_str()).to_string();
            let entry_name = Self::entry_name(entry).unwrap_or(entry_id.as_str()).to_string();
            let summary = Self::entry_summary(entry);
            list.remove(index);
            Self::with_database(ctx, |db| write_mcp_tools_list(db, &list))?;
            (entry_id, entry_name, actual_raw, summary)
        };

        // provenance 清理（best-effort：失败只降级为警告）
        let mut cleanup_warnings: Vec<String> = Vec::new();
        let cleanup = Self::with_database(ctx, |db| {
            let mut warnings = Vec::new();
            for key in [
                format!("{}{}", PROPOSE_PROVENANCE_PREFIX, entry_name),
                format!("{}{}", MANAGE_PROVENANCE_PREFIX, entry_id),
            ] {
                if let Err(e) = db.delete_setting(&key) {
                    warnings.push(format!("failed to delete provenance '{}': {}", key, e));
                }
            }
            Ok(warnings)
        });
        match cleanup {
            Ok(warnings) => cleanup_warnings.extend(warnings),
            Err(e) => cleanup_warnings.push(e),
        }

        emit_mcp_list_changed(ctx.window_ref(), tool_names::MCP_SERVER_REMOVE);
        let mut output = json!({
            "removed": true,
            "server_id": entry_id,
            "name": entry_name,
            "transport": transport_raw,
            "server": summary,
            "message": "MCP server configuration removed. The frontend MCP client will drop the connection; this cannot be undone (filled env values are deleted with the entry).",
            "settings_key": MCP_TOOLS_LIST_KEY,
        });
        if !cleanup_warnings.is_empty() {
            output["cleanup_warnings"] = json!(cleanup_warnings);
        }
        Ok(redact_sensitive_json(output))
    }
}

#[async_trait]
impl ToolExecutor for McpManageExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            Self::short_name(tool_name),
            tool_names::MCP_SERVER_UPDATE
                | tool_names::MCP_SERVER_SET_ENABLED
                | tool_names::MCP_SERVER_REMOVE
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match Self::short_name(&call.name) {
            tool_names::MCP_SERVER_UPDATE => self.execute_update(&call.arguments, ctx).await,
            tool_names::MCP_SERVER_SET_ENABLED => {
                self.execute_set_enabled(&call.arguments, ctx).await
            }
            tool_names::MCP_SERVER_REMOVE => self.execute_remove(&call.arguments, ctx).await,
            other => Err(format!("Unsupported MCP manage tool: {}", other)),
        };

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
                    log::warn!("[McpManageExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[McpManageExecutor] Failed to save tool block: {}", e);
                }
                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match Self::short_name(tool_name) {
            // 配置修改与删除是权限升级/破坏性操作：High + never-remember
            // （见 approval_scope::PRIVILEGE_ESCALATION_TOOLS）
            tool_names::MCP_SERVER_UPDATE | tool_names::MCP_SERVER_REMOVE => ToolSensitivity::High,
            tool_names::MCP_SERVER_SET_ENABLED => ToolSensitivity::Medium,
            // fail-closed：未知名称维持 High
            _ => ToolSensitivity::High,
        }
    }

    fn name(&self) -> &'static str {
        "McpManageExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_entry() -> Value {
        json!({
            "id": "brave",
            "name": "brave",
            "transportType": "stdio",
            "enabled": true,
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-brave-search"],
            "env": { "BRAVE_API_KEY": "user-filled-secret" }
        })
    }

    fn remote_entry() -> Value {
        json!({
            "id": "remote",
            "name": "remote",
            "transportType": "sse",
            "enabled": true,
            "url": "https://example.com/sse",
            "fetch": { "type": "sse", "url": "https://example.com/sse" }
        })
    }

    #[test]
    fn can_handle_covers_all_three_tools_with_prefixes() {
        let executor = McpManageExecutor::new();
        for name in [
            "mcp_server_update",
            "builtin-mcp_server_update",
            "mcp_server_set_enabled",
            "builtin-mcp_server_set_enabled",
            "mcp_server_remove",
            "builtin-mcp_server_remove",
        ] {
            assert!(executor.can_handle(name), "{name}");
        }
        assert!(!executor.can_handle("mcp_server_propose"));
        assert!(!executor.can_handle("mcp_server_update_extra"));
    }

    #[test]
    fn sensitivity_mapping_matches_governance_contract() {
        let executor = McpManageExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-mcp_server_update"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-mcp_server_remove"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-mcp_server_set_enabled"),
            ToolSensitivity::Medium
        );
    }

    #[test]
    fn update_rejects_env_field_with_values() {
        let err = McpManageExecutor::parse_update_input(&json!({
            "server_id": "brave",
            "env": { "BRAVE_API_KEY": "secret" }
        }))
        .unwrap_err();
        assert!(err.contains("env"));
        assert!(err.contains("env_required"));
    }

    #[test]
    fn update_rejects_env_required_with_value_shape() {
        let err = McpManageExecutor::parse_update_input(&json!({
            "server_id": "brave",
            "env_required": ["BRAVE_API_KEY=abc"]
        }))
        .unwrap_err();
        assert!(err.contains("env assignment"));
    }

    #[test]
    fn update_rejects_unknown_fields_and_empty_patch() {
        let err = McpManageExecutor::parse_update_input(&json!({
            "server_id": "brave",
            "extra": true
        }))
        .unwrap_err();
        assert!(err.contains("Unknown field"));

        let err = McpManageExecutor::parse_update_input(&json!({ "server_id": "brave" }))
            .unwrap_err();
        assert!(err.contains("At least one field"));
    }

    #[test]
    fn update_rejects_non_https_url() {
        let err = McpManageExecutor::parse_update_input(&json!({
            "server_id": "remote",
            "url": "http://example.com/mcp"
        }))
        .unwrap_err();
        assert!(err.contains("https"));
    }

    #[test]
    fn apply_update_keeps_filled_env_values_and_adds_placeholders() {
        let input = McpManageExecutor::parse_update_input(&json!({
            "server_id": "brave",
            "env_required": ["BRAVE_API_KEY", "NEW_VAR"]
        }))
        .unwrap();
        let outcome = McpManageExecutor::apply_update(&stdio_entry(), &input).unwrap();
        // 已填值保留、新变量占位；有占位 → 强制 disabled
        assert_eq!(
            outcome
                .entry
                .pointer("/env/BRAVE_API_KEY")
                .and_then(Value::as_str),
            Some("user-filled-secret")
        );
        assert_eq!(
            outcome.entry.pointer("/env/NEW_VAR").and_then(Value::as_str),
            Some(ENV_PLACEHOLDER)
        );
        assert!(outcome.needs_secrets);
        assert!(!outcome.enabled);
        assert_eq!(outcome.env_required, vec!["NEW_VAR".to_string()]);
    }

    #[test]
    fn apply_update_env_required_can_drop_variables() {
        let input = McpManageExecutor::parse_update_input(&json!({
            "server_id": "brave",
            "env_required": []
        }))
        .unwrap();
        let outcome = McpManageExecutor::apply_update(&stdio_entry(), &input).unwrap();
        assert_eq!(
            outcome.entry.get("env"),
            Some(&json!({})),
            "empty env_required drops all env variables"
        );
        assert!(!outcome.needs_secrets);
        assert!(outcome.enabled);
    }

    #[test]
    fn apply_update_transport_switch_to_remote_requires_url_and_clears_stdio_keys() {
        let missing_url = McpManageExecutor::parse_update_input(&json!({
            "server_id": "brave",
            "transport": "sse"
        }))
        .unwrap();
        let err = McpManageExecutor::apply_update(&stdio_entry(), &missing_url).unwrap_err();
        assert!(err.contains("url"));

        let with_url = McpManageExecutor::parse_update_input(&json!({
            "server_id": "brave",
            "transport": "sse",
            "url": "https://example.com/sse"
        }))
        .unwrap();
        let outcome = McpManageExecutor::apply_update(&stdio_entry(), &with_url).unwrap();
        assert!(outcome.entry.get("command").is_none());
        assert!(outcome.entry.get("env").is_none());
        assert_eq!(
            outcome
                .entry
                .get("transportType")
                .and_then(Value::as_str),
            Some("sse")
        );
        assert_eq!(
            outcome.entry.pointer("/fetch/url").and_then(Value::as_str),
            Some("https://example.com/sse")
        );
    }

    #[test]
    fn apply_update_remote_rejects_stdio_only_fields() {
        let input = McpManageExecutor::parse_update_input(&json!({
            "server_id": "remote",
            "command": "npx"
        }))
        .unwrap();
        let err = McpManageExecutor::apply_update(&remote_entry(), &input).unwrap_err();
        assert!(err.contains("stdio"));
    }

    #[test]
    fn apply_update_rename_keeps_id_stable() {
        let input = McpManageExecutor::parse_update_input(&json!({
            "server_id": "brave",
            "name": "brave-search"
        }))
        .unwrap();
        let outcome = McpManageExecutor::apply_update(&stdio_entry(), &input).unwrap();
        assert_eq!(
            outcome.entry.get("id").and_then(Value::as_str),
            Some("brave")
        );
        assert_eq!(
            outcome.entry.get("name").and_then(Value::as_str),
            Some("brave-search")
        );
        assert!(outcome.changed_fields.contains(&"name".to_string()));
    }

    #[test]
    fn find_server_index_prefers_exact_id_then_name() {
        let list = vec![
            json!({ "id": "a", "name": "Alpha" }),
            json!({ "id": "b", "name": "beta" }),
        ];
        assert_eq!(McpManageExecutor::find_server_index(&list, "b"), Some(1));
        assert_eq!(
            McpManageExecutor::find_server_index(&list, "ALPHA"),
            Some(0)
        );
        assert_eq!(McpManageExecutor::find_server_index(&list, "gamma"), None);
    }

    #[test]
    fn find_name_conflict_ignores_self() {
        let list = vec![
            json!({ "id": "a", "name": "Alpha" }),
            json!({ "id": "b", "name": "beta" }),
        ];
        assert!(McpManageExecutor::find_name_conflict(&list, 0, "Alpha").is_none());
        assert!(McpManageExecutor::find_name_conflict(&list, 1, "alpha").is_some());
    }

    #[test]
    fn missing_env_vars_flags_placeholder_and_empty() {
        let entry = json!({
            "env": {
                "FILLED": "value",
                "PLACEHOLDER": ENV_PLACEHOLDER,
                "EMPTY": ""
            }
        });
        let mut missing = McpManageExecutor::missing_env_vars(&entry);
        missing.sort();
        assert_eq!(missing, vec!["EMPTY".to_string(), "PLACEHOLDER".to_string()]);
    }

    #[test]
    fn entry_summary_redacts_remote_url_and_env_values() {
        let summary = McpManageExecutor::entry_summary(&stdio_entry());
        let text = summary.to_string();
        assert!(!text.contains("user-filled-secret"));
        assert!(text.contains("BRAVE_API_KEY"));

        let remote = McpManageExecutor::entry_summary(&remote_entry());
        assert_eq!(
            remote.get("url").and_then(Value::as_str),
            Some("<remote-endpoint>")
        );
    }

    #[test]
    fn set_enabled_and_remove_reject_unknown_fields() {
        assert!(McpManageExecutor::reject_unknown_fields(
            &json!({ "server_id": "a", "enabled": true, "reason": "x" }),
            SET_ENABLED_ALLOWED_KEYS,
        )
        .is_ok());
        assert!(McpManageExecutor::reject_unknown_fields(
            &json!({ "server_id": "a", "env": {} }),
            SET_ENABLED_ALLOWED_KEYS,
        )
        .is_err());
        assert!(McpManageExecutor::reject_unknown_fields(
            &json!({ "server_id": "a", "expected_transport": "stdio", "extra": 1 }),
            REMOVE_ALLOWED_KEYS,
        )
        .is_err());
    }
}
