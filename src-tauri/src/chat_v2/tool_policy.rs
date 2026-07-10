use serde_json::Value;

use super::tools::{attempt_completion, SkillsExecutor};

pub fn canonical_tool_short_name(tool_name: &str) -> &str {
    tool_name
        .strip_prefix(super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
        .or_else(|| tool_name.strip_prefix("builtin:"))
        .or_else(|| tool_name.strip_prefix("mcp.tools."))
        .or_else(|| tool_name.strip_prefix("mcp_"))
        .unwrap_or(tool_name)
}

pub fn is_control_tool(tool_name: &str) -> bool {
    if SkillsExecutor::is_load_skills_tool(tool_name)
        || attempt_completion::is_attempt_completion(tool_name)
    {
        return true;
    }

    matches!(
        tool_name,
        "coordinator_sleep" | "builtin-coordinator_sleep" | "workspace_coordinator_sleep"
    )
}

pub fn is_tool_allowed_by_skill_policy(
    tool_name: &str,
    arguments: &Value,
    skill_allowed_tools: &Option<Vec<String>>,
) -> bool {
    if is_control_tool(tool_name) {
        return true;
    }

    let Some(allowed_tools) = skill_allowed_tools.as_ref() else {
        return true;
    };

    allowed_tools
        .iter()
        .filter(|entry| !entry.trim().is_empty())
        .any(|entry| tool_allow_entry_matches(entry.trim(), tool_name, arguments))
}

/// 工具名是否属于 MCP 命名空间（`mcp_*` / `mcp.tools.*`）
fn is_mcp_namespaced(name: &str) -> bool {
    name.starts_with("mcp.tools.") || name.starts_with("mcp_")
}

/// 工具名是否属于 builtin 命名空间（`builtin-*` / `builtin:*`）
fn is_builtin_namespaced(name: &str) -> bool {
    name.starts_with(super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
        || name.starts_with("builtin:")
}

/// 从参数中提取 pipeline reverse-map 注入的 MCP 服务器 ID
fn server_id_from_args(arguments: &Value) -> Option<&str> {
    arguments
        .get("_serverId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 判断一次工具调用是否来自 MCP 源：
/// - 名称带 `mcp_` / `mcp.tools.` 前缀；或
/// - 名称非 builtin 且参数携带 `_serverId`（外部 MCP 路由会注入该字段，
///   builtin 工具不注入）
fn tool_call_is_mcp_sourced(tool_name: &str, arguments: &Value) -> bool {
    if is_mcp_namespaced(tool_name) {
        return true;
    }
    !is_builtin_namespaced(tool_name) && server_id_from_args(arguments).is_some()
}

/// 🔧 P2-4 修复（08 报告）：按源隔离匹配，消除命名空间塌陷。
///
/// 之前双方剥前缀后按短名互比，allowedTools 写 `builtin-web_search`（或 `web_search`）
/// 的技能会同时放行任意 MCP 服务器暴露的同名工具（`mcp_web_search`），与
/// approval_scope 声明的「两个不同 server 暴露同名工具，批准一个绝不能自动批准另一个」
/// 原则冲突。现在的规则：
/// - 完整名精确相等：始终匹配；
/// - `server::tool` 条目：仅在调用携带相同 `_serverId` 时匹配（显式源限定）；
/// - 短名（剥前缀）匹配：仅在「调用与条目同为非 MCP 源」或「同为 MCP 命名空间」
///   时生效，builtin/裸名条目不再跨源放行 MCP 同名工具，反之亦然。
pub fn tool_allow_entry_matches(allowed_entry: &str, tool_name: &str, arguments: &Value) -> bool {
    // 1. 完整原始名精确匹配（技能作者显式写全名）
    if allowed_entry == tool_name {
        return true;
    }

    // 2. `server::tool` 显式源限定条目
    if let Some((allowed_server, allowed_tool)) = allowed_entry.split_once("::") {
        let Some(server_id) = server_id_from_args(arguments) else {
            return false;
        };
        if allowed_server != server_id {
            return false;
        }

        let tool_short = canonical_tool_short_name(tool_name);
        let allowed_tool_short = canonical_tool_short_name(allowed_tool);
        return allowed_tool == tool_name
            || allowed_tool == tool_short
            || allowed_tool_short == tool_name
            || allowed_tool_short == tool_short;
    }

    // 3. 短名匹配：仅限同源命名空间（builtin↔builtin/裸名、mcp↔mcp）
    let tool_is_mcp = tool_call_is_mcp_sourced(tool_name, arguments);
    let allowed_is_mcp = is_mcp_namespaced(allowed_entry);
    if tool_is_mcp != allowed_is_mcp {
        return false;
    }

    let tool_short = canonical_tool_short_name(tool_name);
    let allowed_short = canonical_tool_short_name(allowed_entry);

    allowed_entry == tool_short || allowed_short == tool_name || allowed_short == tool_short
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn skill_policy_allows_exact_and_canonical_builtin_names() {
        let allowed = Some(vec!["builtin-web_search".to_string()]);
        assert!(is_tool_allowed_by_skill_policy(
            "builtin-web_search",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "web_search",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-note_read",
            &json!({}),
            &allowed
        ));
    }

    #[test]
    fn skill_policy_empty_list_blocks_business_tools_but_allows_control_tools() {
        let allowed = Some(Vec::new());
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-web_search",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "builtin-load_skills",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "attempt_completion",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "builtin:load_skills",
            &json!({}),
            &allowed
        ));
    }

    #[test]
    fn skill_policy_does_not_treat_mcp_prefixed_sleep_as_control_tool() {
        let allowed = Some(Vec::new());
        assert!(!is_tool_allowed_by_skill_policy(
            "mcp_coordinator_sleep",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "mcp.tools.coordinator_sleep",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "workspace_coordinator_sleep",
            &json!({}),
            &allowed
        ));
    }

    #[test]
    fn skill_policy_matches_server_scoped_tools() {
        let allowed = Some(vec!["server-a::builtin-fetch".to_string()]);
        assert!(is_tool_allowed_by_skill_policy(
            "fetch",
            &json!({ "_serverId": "server-a" }),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "fetch",
            &json!({ "_serverId": "server-b" }),
            &allowed
        ));
    }

    /// 🔧 P2-4 回归：builtin 白名单条目不得跨源放行任意 MCP 服务器的同名工具
    #[test]
    fn skill_policy_builtin_entry_does_not_allow_mcp_tools() {
        let allowed = Some(vec!["builtin-web_search".to_string()]);
        assert!(!is_tool_allowed_by_skill_policy(
            "mcp_web_search",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "mcp.tools.web_search",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "mcp_web_search",
            &json!({ "_serverId": "evil-server" }),
            &allowed
        ));
        // builtin / 裸名调用仍正常匹配
        assert!(is_tool_allowed_by_skill_policy(
            "builtin-web_search",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "web_search",
            &json!({}),
            &allowed
        ));
    }

    /// 🔧 P2-4 回归：裸名条目也不得放行携带 _serverId 的外部 MCP 同名工具
    #[test]
    fn skill_policy_bare_entry_does_not_allow_mcp_sourced_calls() {
        let allowed = Some(vec!["web_search".to_string()]);
        // 外部 MCP 路由（带 _serverId 或 mcp 前缀）必须用 server::tool 显式声明
        assert!(!is_tool_allowed_by_skill_policy(
            "web_search",
            &json!({ "_serverId": "some-mcp-server" }),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "mcp_web_search",
            &json!({}),
            &allowed
        ));
        // 无 _serverId 的裸名调用（builtin 执行器）仍匹配
        assert!(is_tool_allowed_by_skill_policy(
            "web_search",
            &json!({}),
            &allowed
        ));
    }

    /// 🔧 P2-4 回归：mcp 条目仍可匹配 mcp 前缀形态互换，但不匹配 builtin 工具
    #[test]
    fn skill_policy_mcp_entry_matches_only_mcp_namespace() {
        let allowed = Some(vec!["mcp_note_set".to_string()]);
        assert!(is_tool_allowed_by_skill_policy(
            "mcp_note_set",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_skill_policy(
            "mcp.tools.note_set",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "builtin-note_set",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_skill_policy(
            "note_set",
            &json!({}),
            &allowed
        ));
    }
}
