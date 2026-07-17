//! self_inspect 工具执行器
//!
//! Low 敏感度只读自查：runtime root、技能注册/加载状态、MCP 配置摘要、web 搜索配置可见性。
//! 输出经白名单提取 + 敏感键脱敏闸门，不读取 tool_approval.*、信任状态或 secure store 明文。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::runtime_roots::{
    redact_path_for_display, resolve_group_preferred_runtime_root, runtime_roots_for_session,
    skill_package_runtime_root, RuntimeRoot,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;
use crate::database::Database;

pub mod tool_names {
    pub const SELF_INSPECT: &str = "self_inspect";
}

const WEB_SEARCH_SETTINGS_PREFIX: &str = "web_search.";

const SENSITIVE_JSON_KEY_PATTERNS: &[&str] = &[
    "api_key",
    "apikey",
    "token",
    "secret",
    "password",
    "credential",
    "private_key",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InspectSection {
    All,
    Roots,
    Skills,
    Mcp,
    Search,
}

impl InspectSection {
    fn as_str(self) -> &'static str {
        match self {
            InspectSection::All => "all",
            InspectSection::Roots => "roots",
            InspectSection::Skills => "skills",
            InspectSection::Mcp => "mcp",
            InspectSection::Search => "search",
        }
    }

    fn includes_roots(self) -> bool {
        matches!(self, InspectSection::All | InspectSection::Roots)
    }

    fn includes_skills(self) -> bool {
        matches!(self, InspectSection::All | InspectSection::Skills)
    }

    fn includes_mcp(self) -> bool {
        matches!(self, InspectSection::All | InspectSection::Mcp)
    }

    fn includes_search(self) -> bool {
        matches!(self, InspectSection::All | InspectSection::Search)
    }
}

pub struct SelfInspectExecutor;

impl SelfInspectExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        strip_tool_namespace(tool_name)
    }

    fn parse_section(args: &Value) -> Result<InspectSection, String> {
        let raw = args
            .get("section")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("all");
        match raw.to_ascii_lowercase().as_str() {
            "all" => Ok(InspectSection::All),
            "roots" => Ok(InspectSection::Roots),
            "skills" => Ok(InspectSection::Skills),
            "mcp" => Ok(InspectSection::Mcp),
            "search" => Ok(InspectSection::Search),
            other => Err(format!(
                "Unsupported section '{}'. Allowed values: roots, skills, mcp, search, all",
                other
            )),
        }
    }

    fn root_json(root: &RuntimeRoot) -> Value {
        serde_json::to_value(root).unwrap_or_else(|_| {
            json!({
                "id": root.id,
                "label": root.label,
                "path": root.path.to_string_lossy(),
            })
        })
    }

    fn collect_runtime_roots(ctx: &ExecutionContext, limitations: &mut Vec<String>) -> Value {
        let mut entries: Vec<Value> = Vec::new();

        let state = ctx.window.state::<AppState>();
        let app = ctx.window.app_handle();
        match runtime_roots_for_session(app, &state.database, &ctx.session_id, false) {
            Ok(roots) => {
                entries.extend(roots.iter().map(Self::root_json));
            }
            Err(error) => {
                limitations.push(format!("failed to enumerate runtime roots: {}", error));
            }
        }

        if let Some(skill_package_roots) = ctx.skill_package_roots.as_ref() {
            let mut skill_ids: Vec<&String> = skill_package_roots.keys().collect();
            skill_ids.sort();
            for skill_id in skill_ids {
                if let Some(path) = skill_package_roots.get(skill_id) {
                    match skill_package_runtime_root(skill_id, path) {
                        Ok(root) => entries.push(Self::root_json(&root)),
                        Err(error) => limitations.push(format!(
                            "failed to resolve skill package root for '{}': {}",
                            skill_id, error
                        )),
                    }
                }
            }
        }

        let preferred = ctx.chat_v2_db.as_ref().and_then(|db| {
            resolve_group_preferred_runtime_root(db.as_ref(), &ctx.session_id).map(|pref| {
                json!({
                    "root_id": pref.root_id,
                    "project_root_path": pref
                        .project_root_path
                        .as_deref()
                        .map(redact_path_for_display),
                })
            })
        });

        json!({
            "roots": entries,
            "group_preferred_runtime_root": preferred,
        })
    }

    fn collect_skills(ctx: &ExecutionContext, limitations: &mut Vec<String>) -> Value {
        let mut loaded_ids: Vec<String> = Vec::new();
        let mut active_ids: Vec<String> = Vec::new();
        let mut session_state_available = false;

        if let Some(chat_v2_db) = ctx.chat_v2_db.as_ref() {
            match ChatV2Repo::load_session_state_v2(chat_v2_db, &ctx.session_id) {
                Ok(Some(session_state)) => {
                    session_state_available = true;
                    let skill_state = session_state.resolved_skill_state();
                    loaded_ids = skill_state.resolved_loaded_skill_ids();
                    active_ids = skill_state.resolved_active_skill_ids();
                }
                Ok(None) => {
                    session_state_available = true;
                }
                Err(_) => {
                    limitations.push("failed to load session skill state".to_string());
                }
            }
        } else {
            limitations
                .push("session skill state unavailable in this execution context".to_string());
        }

        let mut registered: Vec<Value> = Vec::new();
        if let Some(skill_contents) = ctx.skill_contents.as_ref() {
            let mut skill_ids: Vec<&String> = skill_contents.keys().collect();
            skill_ids.sort();
            for skill_id in skill_ids {
                let content_length = skill_contents
                    .get(skill_id)
                    .map(|content| content.len())
                    .unwrap_or(0);
                registered.push(json!({
                    "id": skill_id,
                    "content_length": content_length,
                    "loaded": if session_state_available {
                        Value::Bool(loaded_ids.contains(skill_id))
                    } else {
                        Value::Null
                    },
                    "active": if session_state_available {
                        Value::Bool(active_ids.contains(skill_id))
                    } else {
                        Value::Null
                    },
                }));
            }
        }

        let note = if session_state_available {
            "loaded/active reflect the current session skill state; registered skills come from the runtime skill registry."
        } else {
            "Only registered skill ids are listed; loaded/active state was unavailable in this execution context."
        };

        json!({
            "registered_skills": registered,
            "loaded_skill_ids": if session_state_available { json!(loaded_ids) } else { Value::Null },
            "active_skill_ids": if session_state_available { json!(active_ids) } else { Value::Null },
            "session_skill_state_available": session_state_available,
            "note": note,
        })
    }

    fn collect_mcp(main_db: Option<&Database>, limitations: &mut Vec<String>) -> Value {
        let Some(database) = main_db else {
            limitations.push("main database unavailable in this execution context".to_string());
            return json!({
                "available": false,
                "servers": [],
                "note": "MCP configuration is stored in settings (mcp.tools.list); it was not readable in this execution context.",
            });
        };

        let items = match super::mcp_settings_store::read_mcp_tools_list(database) {
            Ok(list) => list,
            Err(error) => {
                limitations.push(format!("failed to read mcp.tools.list: {}", error));
                return json!({
                    "available": false,
                    "servers": [],
                    "note": "Failed to read mcp.tools.list from secure settings.",
                });
            }
        };

        let servers = items
            .iter()
            .filter_map(Self::sanitize_mcp_server_entry)
            .collect::<Vec<_>>();

        json!({
            "available": true,
            "servers": servers,
            "note": "Only server name, transport type, and enabled flag are exposed; command, args, env, url, headers, and tokens are omitted.",
        })
    }

    /// MCP 字段白名单：只保留 name / transport / enabled。
    fn sanitize_mcp_server_entry(entry: &Value) -> Option<Value> {
        let name = entry
            .get("name")
            .or_else(|| entry.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        let transport = entry
            .get("transportType")
            .or_else(|| entry.get("transport"))
            .or_else(|| entry.get("type"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown");
        let enabled = entry
            .get("enabled")
            .and_then(Value::as_bool)
            .or_else(|| {
                entry
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .map(|disabled| !disabled)
            })
            .unwrap_or(true);

        Some(json!({
            "name": name,
            "transport": transport,
            "enabled": enabled,
        }))
    }

    fn collect_search(
        main_db: Option<&Database>,
        runtime_enabled: bool,
        limitations: &mut Vec<String>,
    ) -> Value {
        let mut settings_entries: Vec<Value> = Vec::new();

        if let Some(database) = main_db {
            match database.get_settings_by_prefix(WEB_SEARCH_SETTINGS_PREFIX) {
                Ok(rows) => {
                    for (key, value, _updated_at) in rows {
                        if key.starts_with("tool_approval.") {
                            continue;
                        }
                        settings_entries.push(json!({
                            "key": key,
                            "configured": !value.trim().is_empty(),
                        }));
                    }
                    settings_entries.sort_by(|a, b| {
                        a.get("key")
                            .and_then(Value::as_str)
                            .cmp(&b.get("key").and_then(Value::as_str))
                    });
                }
                Err(error) => {
                    limitations.push(format!("failed to read web_search.* settings: {}", error));
                }
            }
        } else {
            limitations.push("main database unavailable in this execution context".to_string());
        }

        json!({
            "runtime_enabled": runtime_enabled,
            "settings": settings_entries,
            "note": "Only setting key names and configured flags are shown; values are never returned. Keys stored only in secure store may be invisible here.",
        })
    }

    fn assemble_payload(
        section: InspectSection,
        roots: Option<Value>,
        skills: Option<Value>,
        mcp: Option<Value>,
        search: Option<Value>,
        limitations: Vec<String>,
    ) -> Value {
        let mut payload = Map::new();
        payload.insert("section".to_string(), json!(section.as_str()));
        if let Some(roots) = roots {
            payload.insert("roots".to_string(), roots);
        }
        if let Some(skills) = skills {
            payload.insert("skills".to_string(), skills);
        }
        if let Some(mcp) = mcp {
            payload.insert("mcp".to_string(), mcp);
        }
        if let Some(search) = search {
            payload.insert("search".to_string(), search);
        }
        if !limitations.is_empty() {
            payload.insert("limitations".to_string(), json!(limitations));
        }
        Value::Object(payload)
    }

    fn build_report(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let section = Self::parse_section(args)?;
        let mut limitations: Vec<String> = Vec::new();
        let main_db = ctx.main_db.as_ref().map(|db| db.as_ref());

        let roots = section
            .includes_roots()
            .then(|| Self::collect_runtime_roots(ctx, &mut limitations));
        let skills = section
            .includes_skills()
            .then(|| Self::collect_skills(ctx, &mut limitations));
        let mcp = section
            .includes_mcp()
            .then(|| Self::collect_mcp(main_db, &mut limitations));
        let search = section
            .includes_search()
            .then(|| Self::collect_search(main_db, ctx.web_search_enabled, &mut limitations));

        let payload = Self::assemble_payload(section, roots, skills, mcp, search, limitations);
        Ok(redact_sensitive_json(payload))
    }
}

impl Default for SelfInspectExecutor {
    fn default() -> Self {
        Self::new()
    }
}

/// 输出前最后一道防线：命中敏感键名的字段值一律替换为占位符。
pub fn redact_sensitive_json(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, child) in map {
                if is_sensitive_json_key(&key) {
                    out.insert(key, json!("<redacted>"));
                } else {
                    out.insert(key, redact_sensitive_json(child));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact_sensitive_json).collect()),
        other => other,
    }
}

fn is_sensitive_json_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SENSITIVE_JSON_KEY_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
}

#[async_trait]
impl ToolExecutor for SelfInspectExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        Self::strip_namespace(tool_name) == tool_names::SELF_INSPECT
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = self.build_report(&call.arguments, ctx);
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
                    log::warn!("[SelfInspectExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[SelfInspectExecutor] Failed to save tool block: {}", e);
                }
                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        // self_inspect 是只读自查（脱敏状态概览），可并行 + 自动重试
        ToolConcurrency::ReadOnly
    }

    fn name(&self) -> &'static str {
        "SelfInspectExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_expected_tool_names() {
        let executor = SelfInspectExecutor::new();
        assert!(executor.can_handle("self_inspect"));
        assert!(executor.can_handle("builtin-self_inspect"));
        assert!(!executor.can_handle("self_inspect_extra"));
    }

    #[test]
    fn sensitivity_is_low() {
        let executor = SelfInspectExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-self_inspect"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn parses_section_with_default_all() {
        assert_eq!(
            SelfInspectExecutor::parse_section(&json!({})).unwrap(),
            InspectSection::All
        );
        assert_eq!(
            SelfInspectExecutor::parse_section(&json!({"section": "search"})).unwrap(),
            InspectSection::Search
        );
        assert!(SelfInspectExecutor::parse_section(&json!({"section": "secrets"})).is_err());
    }

    #[test]
    fn redact_sensitive_json_replaces_nested_sensitive_values() {
        let input = json!({
            "search": {
                "settings": [
                    { "key": "web_search.api_key.tavily", "configured": true },
                    { "key": "web_search.engine", "configured": true }
                ]
            },
            "nested": {
                "apiKey": "super-secret",
                "token": "abc123",
                "password": "hunter2",
                "private_key": "-----BEGIN",
                "safe": "visible"
            }
        });
        let output = redact_sensitive_json(input);
        let serialized = serde_json::to_string(&output).unwrap();
        assert!(!serialized.contains("super-secret"));
        assert!(!serialized.contains("abc123"));
        assert!(!serialized.contains("hunter2"));
        assert!(!serialized.contains("BEGIN"));
        assert!(serialized.contains("visible"));
        assert_eq!(
            output.pointer("/nested/apiKey").and_then(Value::as_str),
            Some("<redacted>")
        );
        assert_eq!(
            output.pointer("/nested/token").and_then(Value::as_str),
            Some("<redacted>")
        );
    }

    #[test]
    fn mcp_whitelist_only_exposes_allowed_fields() {
        let entry = json!({
            "id": "brave-search",
            "name": "Brave Search",
            "transportType": "stdio",
            "enabled": true,
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-brave-search"],
            "env": { "BRAVE_API_KEY": "secret-value" },
            "url": "https://example.com/mcp",
            "headers": { "Authorization": "Bearer token" },
            "apiKey": "plain-key"
        });
        let sanitized = SelfInspectExecutor::sanitize_mcp_server_entry(&entry).unwrap();
        assert_eq!(
            sanitized.get("name").and_then(Value::as_str),
            Some("Brave Search")
        );
        assert_eq!(
            sanitized.get("transport").and_then(Value::as_str),
            Some("stdio")
        );
        assert_eq!(
            sanitized.get("enabled").and_then(Value::as_bool),
            Some(true)
        );
        assert!(sanitized.get("command").is_none());
        assert!(sanitized.get("env").is_none());
        assert!(sanitized.get("url").is_none());
        assert!(sanitized.get("headers").is_none());
        assert!(sanitized.get("apiKey").is_none());

        let serialized = serde_json::to_string(&sanitized).unwrap();
        assert!(!serialized.contains("secret-value"));
        assert!(!serialized.contains("plain-key"));
        assert!(!serialized.contains("Bearer"));
    }

    #[test]
    fn section_filter_limits_payload_keys() {
        let roots_only = SelfInspectExecutor::assemble_payload(
            InspectSection::Roots,
            Some(json!({ "roots": [] })),
            None,
            None,
            None,
            Vec::new(),
        );
        assert!(roots_only.get("roots").is_some());
        assert!(roots_only.get("skills").is_none());
        assert!(roots_only.get("mcp").is_none());
        assert!(roots_only.get("search").is_none());

        let search_only = SelfInspectExecutor::assemble_payload(
            InspectSection::Search,
            None,
            None,
            None,
            Some(json!({ "runtime_enabled": true, "settings": [] })),
            Vec::new(),
        );
        assert!(search_only.get("search").is_some());
        assert!(search_only.get("roots").is_none());
    }
}
