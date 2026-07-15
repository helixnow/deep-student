//! Tool approval policy resolution shared by scheduling and execution.
//!
//! Settings remain string-valued for compatibility with the existing settings
//! table and generic settings IPC. More specific rules win:
//!
//! 1. `tool_approval.override.{source}::{tool}`
//! 2. `tool_approval.override.{tool}` (legacy)
//! 3. `tool_approval.source.{source}`
//! 4. `tool_approval.domain.{domain}`
//! 5. `tool_approval.global_bypass`
//! 6. executor-declared sensitivity

use serde_json::Value;

use super::tool_policy::canonical_tool_short_name;
use super::tools::ToolSensitivity;

pub const GLOBAL_BYPASS_KEY: &str = "tool_approval.global_bypass";

/// Return the stable source identifier used by grouped approval rules.
///
/// External MCP calls carry `_serverId` after the pipeline reverse-map. Builtin
/// calls intentionally share the `builtin` source, while MCP calls lacking a
/// concrete server id use the conservative `mcp` fallback bucket.
pub fn tool_approval_source(tool_name: &str, arguments: &Value) -> String {
    if let Some(server_id) = arguments
        .get("_serverId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return server_id.to_string();
    }

    if tool_name.starts_with("mcp_") || tool_name.starts_with("mcp.tools.") {
        "mcp".to_string()
    } else {
        "builtin".to_string()
    }
}

/// Derive a stable, intentionally mechanical capability family.
///
/// Tool families already use names such as `note_read`, `qbank_search`, and
/// `memory_create`. Taking the first non-empty underscore-delimited segment
/// makes new tools inherit a useful group without maintaining a second registry.
pub fn tool_approval_domain(tool_name: &str) -> String {
    let short_name = canonical_tool_short_name(tool_name);
    short_name
        .split('_')
        .find(|segment| !segment.is_empty())
        .unwrap_or("other")
        .to_ascii_lowercase()
}

pub fn scoped_tool_override_key(tool_name: &str, arguments: &Value) -> String {
    format!(
        "tool_approval.override.{}::{}",
        tool_approval_source(tool_name, arguments),
        tool_name
    )
}

pub fn legacy_tool_override_key(tool_name: &str) -> String {
    format!("tool_approval.override.{tool_name}")
}

pub fn source_override_key(tool_name: &str, arguments: &Value) -> String {
    format!(
        "tool_approval.source.{}",
        tool_approval_source(tool_name, arguments)
    )
}

pub fn domain_override_key(tool_name: &str) -> String {
    format!("tool_approval.domain.{}", tool_approval_domain(tool_name))
}

fn parse_sensitivity(value: &str) -> Option<ToolSensitivity> {
    match value.trim().to_ascii_lowercase().as_str() {
        "low" => Some(ToolSensitivity::Low),
        "medium" => Some(ToolSensitivity::Medium),
        "high" => Some(ToolSensitivity::High),
        _ => None,
    }
}

/// Resolve the effective sensitivity for one concrete call.
///
/// `get_setting` is injected so the resolver stays independent of the database
/// and can be exhaustively unit tested. Invalid values are treated as absent.
pub fn resolve_effective_sensitivity<F>(
    base: Option<ToolSensitivity>,
    tool_name: &str,
    arguments: &Value,
    mut get_setting: F,
) -> Option<ToolSensitivity>
where
    F: FnMut(&str) -> Option<String>,
{
    let candidate_keys = [
        scoped_tool_override_key(tool_name, arguments),
        legacy_tool_override_key(tool_name),
        source_override_key(tool_name, arguments),
        domain_override_key(tool_name),
    ];

    let configured = candidate_keys
        .iter()
        .find_map(|key| get_setting(key).and_then(|value| parse_sensitivity(&value)))
        .or_else(|| {
            get_setting(GLOBAL_BYPASS_KEY)
                .filter(|value| value.trim().eq_ignore_ascii_case("true"))
                .map(|_| ToolSensitivity::Low)
        });

    let resolved = configured.or(base);
    if resolved == Some(ToolSensitivity::Low)
        && super::approval_scope::ignores_broad_approval_bypass_for_args(tool_name, arguments)
    {
        // Runtime-authority tools require a concrete scope approval. A broad
        // policy may still raise their sensitivity but can never lower it.
        base
    } else {
        resolved
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;

    fn resolve(
        settings: &[(&str, &str)],
        base: Option<ToolSensitivity>,
        tool_name: &str,
        arguments: &Value,
    ) -> Option<ToolSensitivity> {
        let settings: HashMap<&str, &str> = settings.iter().copied().collect();
        resolve_effective_sensitivity(base, tool_name, arguments, |key| {
            settings.get(key).map(|value| (*value).to_string())
        })
    }

    #[test]
    fn derives_stable_source_and_domain() {
        assert_eq!(
            tool_approval_source("search", &json!({"_serverId": " docs-prod "})),
            "docs-prod"
        );
        assert_eq!(tool_approval_source("mcp_search", &json!({})), "mcp");
        assert_eq!(
            tool_approval_source("builtin-note_read", &json!({})),
            "builtin"
        );
        assert_eq!(tool_approval_domain("builtin-note_read"), "note");
        assert_eq!(tool_approval_domain("mcp_qbank_search"), "qbank");
    }

    #[test]
    fn source_scoped_tool_rule_isolated_between_servers() {
        let settings = [("tool_approval.override.server-a::search", "low")];
        assert_eq!(
            resolve(
                &settings,
                Some(ToolSensitivity::High),
                "search",
                &json!({"_serverId": "server-a"}),
            ),
            Some(ToolSensitivity::Low)
        );
        assert_eq!(
            resolve(
                &settings,
                Some(ToolSensitivity::High),
                "search",
                &json!({"_serverId": "server-b"}),
            ),
            Some(ToolSensitivity::High)
        );
    }

    #[test]
    fn resolves_rules_from_most_specific_to_global() {
        let settings = [
            (GLOBAL_BYPASS_KEY, "true"),
            ("tool_approval.domain.note", "medium"),
            ("tool_approval.source.builtin", "high"),
            ("tool_approval.override.note_read", "medium"),
            ("tool_approval.override.builtin::note_read", "low"),
        ];
        assert_eq!(
            resolve(
                &settings,
                Some(ToolSensitivity::High),
                "note_read",
                &json!({}),
            ),
            Some(ToolSensitivity::Low)
        );

        let without_scoped = &settings[..4];
        assert_eq!(
            resolve(
                without_scoped,
                Some(ToolSensitivity::High),
                "note_read",
                &json!({}),
            ),
            Some(ToolSensitivity::Medium)
        );
    }

    #[test]
    fn invalid_specific_rule_falls_through_to_group_rule() {
        let settings = [
            ("tool_approval.override.builtin::note_read", "inherit"),
            ("tool_approval.domain.note", "low"),
        ];
        assert_eq!(
            resolve(
                &settings,
                Some(ToolSensitivity::High),
                "note_read",
                &json!({}),
            ),
            Some(ToolSensitivity::Low)
        );
    }

    #[test]
    fn precise_approval_tools_cannot_be_lowered_by_group_or_global_rules() {
        for settings in [
            vec![(GLOBAL_BYPASS_KEY, "true")],
            vec![("tool_approval.source.builtin", "low")],
            vec![(
                "tool_approval.override.builtin::builtin-local_shell_execute",
                "low",
            )],
        ] {
            assert_eq!(
                resolve(
                    &settings,
                    Some(ToolSensitivity::High),
                    "builtin-local_shell_execute",
                    &json!({}),
                ),
                Some(ToolSensitivity::High)
            );
        }

        assert_eq!(
            resolve(
                &[(GLOBAL_BYPASS_KEY, "true")],
                Some(ToolSensitivity::High),
                "mcp_run_command",
                &json!({"_serverId":"custom-terminal","command":"rm -rf build"}),
            ),
            Some(ToolSensitivity::High)
        );
    }

    #[test]
    fn explicit_group_rule_can_raise_a_low_risk_tool() {
        assert_eq!(
            resolve(
                &[("tool_approval.domain.note", "high")],
                Some(ToolSensitivity::Low),
                "note_read",
                &json!({}),
            ),
            Some(ToolSensitivity::High)
        );
    }
}
