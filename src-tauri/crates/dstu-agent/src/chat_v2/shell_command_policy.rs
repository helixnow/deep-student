//! User-managed shell command rules.
//!
//! The policy is stored atomically as JSON in the generic settings table. A
//! deny rule is authoritative for every shell implementation. Allow rules are
//! only advisory until `enforce_for_call` confirms that the dedicated local
//! shell and the existing command analysis both consider the call read-only.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::approval_scope::{analyze_shell_command, ShellCommandAnalysis};
use super::tools::ToolSensitivity;

pub const SETTING_KEY: &str = "tool_approval.shell_command_rules";
const MAX_RULES: usize = 2_000;
const MAX_RULE_VALUE_BYTES: usize = 8_192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellRuleEffect {
    Allow,
    Ask,
    Deny,
}

fn default_effect() -> ShellRuleEffect {
    ShellRuleEffect::Ask
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellRuleMatchKind {
    Exact,
    Prefix,
    Executable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellRuleMatch {
    pub kind: ShellRuleMatchKind,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellCommandRule {
    pub id: String,
    pub effect: ShellRuleEffect,
    #[serde(rename = "match")]
    pub matcher: ShellRuleMatch,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellCommandPolicy {
    pub version: u8,
    #[serde(default = "default_effect")]
    pub default_effect: ShellRuleEffect,
    #[serde(default)]
    pub rules: Vec<ShellCommandRule>,
}

impl Default for ShellCommandPolicy {
    fn default() -> Self {
        Self {
            version: 1,
            default_effect: ShellRuleEffect::Ask,
            rules: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShellPolicyDecision {
    pub configured_effect: ShellRuleEffect,
    pub effective_effect: ShellRuleEffect,
    pub matched_rule_id: Option<String>,
    pub matched_kind: Option<ShellRuleMatchKind>,
    pub protected: bool,
    pub reason: &'static str,
    pub config_valid: bool,
}

pub fn parse_policy(raw: &str) -> Result<ShellCommandPolicy, String> {
    let policy: ShellCommandPolicy = serde_json::from_str(raw)
        .map_err(|error| format!("invalid shell command policy JSON: {error}"))?;
    validate_policy(&policy)?;
    Ok(policy)
}

pub fn validate_policy(policy: &ShellCommandPolicy) -> Result<(), String> {
    if policy.version != 1 {
        return Err(format!(
            "unsupported shell command policy version {}",
            policy.version
        ));
    }
    if policy.rules.len() > MAX_RULES {
        return Err(format!("shell command policy exceeds {MAX_RULES} rules"));
    }
    let mut ids = HashSet::new();
    for rule in &policy.rules {
        let id = rule.id.trim();
        let value = rule.matcher.value.trim();
        if id.is_empty() || id.len() > 128 {
            return Err("shell command rule id must contain 1..=128 bytes".to_string());
        }
        if !ids.insert(id) {
            return Err(format!("duplicate shell command rule id '{id}'"));
        }
        if value.is_empty() || value.len() > MAX_RULE_VALUE_BYTES {
            return Err(format!(
                "shell command rule '{id}' has an invalid empty/oversized value"
            ));
        }
        if rule.note.as_ref().is_some_and(|note| note.len() > 1_000) {
            return Err(format!("shell command rule '{id}' note is too long"));
        }
    }
    Ok(())
}

fn normalized_command(command: &str) -> String {
    command.trim().replace("\r\n", "\n").replace('\r', "\n")
}

fn executable_name(value: &str) -> String {
    value
        .trim_matches(|ch: char| matches!(ch, '"' | '\'' | '`'))
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn prefix_matches(command: &str, prefix: &str) -> bool {
    command == prefix
        || command
            .strip_prefix(prefix)
            .is_some_and(|tail| tail.chars().next().is_some_and(char::is_whitespace))
}

fn rule_matches(rule: &ShellCommandRule, command: &str, analysis: &ShellCommandAnalysis) -> bool {
    let value = normalized_command(&rule.matcher.value);
    match rule.matcher.kind {
        ShellRuleMatchKind::Exact => command == value,
        ShellRuleMatchKind::Prefix => prefix_matches(command, &value),
        ShellRuleMatchKind::Executable => analysis
            .effective_first_token
            .as_deref()
            .map(executable_name)
            .is_some_and(|executable| executable == executable_name(&value)),
    }
}

fn configured_decision<'a>(
    policy: &'a ShellCommandPolicy,
    command: &str,
    analysis: &ShellCommandAnalysis,
) -> (ShellRuleEffect, Option<&'a ShellCommandRule>) {
    // Deny always wins. Ask then wins over allow so overlapping broad allow
    // rules can be narrowed without relying on list order.
    for effect in [
        ShellRuleEffect::Deny,
        ShellRuleEffect::Ask,
        ShellRuleEffect::Allow,
    ] {
        if let Some(rule) = policy
            .rules
            .iter()
            .filter(|rule| rule.enabled && rule.effect == effect)
            .find(|rule| rule_matches(rule, command, analysis))
        {
            return (effect, Some(rule));
        }
    }
    (policy.default_effect, None)
}

fn is_unshadowable_shell_builtin(executable: &str) -> bool {
    #[cfg(windows)]
    {
        // The Windows sandbox launches trusted PowerShell with -NoProfile.
        matches!(executable, "pwd" | "echo")
    }

    #[cfg(not(windows))]
    {
        // The Unix sandbox launches /bin/sh directly. Keep this to commands
        // implemented by the shell so a writable PATH entry cannot replace them.
        matches!(executable, "pwd" | "echo" | "printf" | "type")
    }
}

fn is_trusted_absolute_os_executable(token: &str) -> bool {
    let path = Path::new(token);
    if !path.is_absolute() {
        return false;
    }

    #[cfg(windows)]
    {
        let Some(system_root) = std::env::var_os("SystemRoot") else {
            return false;
        };
        let system_root = Path::new(&system_root);
        return path.parent().is_some_and(|parent| {
            let parent = parent.to_string_lossy();
            parent.eq_ignore_ascii_case(&system_root.join("System32").to_string_lossy())
                || parent.eq_ignore_ascii_case(&system_root.join("Sysnative").to_string_lossy())
        });
    }

    #[cfg(not(windows))]
    {
        path.parent().is_some_and(|parent| {
            matches!(
                parent.to_str(),
                Some("/bin" | "/sbin" | "/usr/bin" | "/usr/sbin")
            )
        })
    }
}

fn is_readonly_allow_candidate(analysis: &ShellCommandAnalysis) -> bool {
    if analysis.trimmed.is_empty() || analysis.has_shell_operators || analysis.uses_script_runner {
        return false;
    }
    let executable = analysis
        .effective_first_token
        .as_deref()
        .map(executable_name)
        .unwrap_or_default();
    if is_unshadowable_shell_builtin(&executable) {
        return !analysis.write_capable && !analysis.network_capable;
    }

    let Some(first_token) = analysis.first_token.as_deref() else {
        return false;
    };
    if !is_trusted_absolute_os_executable(first_token) {
        return false;
    }

    // `rg` can spawn arbitrary preprocessors (`--pre`) and Git's nominally
    // read-only commands can invoke fsmonitor, textconv, or external diff
    // programs from flags and repository config. Neither family may bypass an
    // approval until execution uses a structured argv policy that rejects all
    // subprocess-capable options and configuration.
    matches!(
        executable.as_str(),
        "ls" | "dir"
            | "grep"
            | "cat"
            | "head"
            | "tail"
            | "wc"
            | "stat"
            | "which"
            | "where"
            | "whoami"
            | "id"
            | "uname"
            | "realpath"
            | "readlink"
    )
}

/// Resolve one command. Invalid persisted JSON fails closed to Ask.
///
/// `is_dedicated_local_shell` must only be true for the backend-owned local
/// executor. External MCP shell tools can be denied by the list but can never
/// use it to bypass their own precise approval.
pub fn enforce_for_call(
    raw_policy: Option<&str>,
    command: &str,
    is_dedicated_local_shell: bool,
) -> ShellPolicyDecision {
    let analysis = analyze_shell_command(command);
    let (policy, config_valid) = match raw_policy {
        None => (ShellCommandPolicy::default(), true),
        Some(raw) => match parse_policy(raw) {
            Ok(policy) => (policy, true),
            Err(_) => (ShellCommandPolicy::default(), false),
        },
    };
    let (configured_effect, matched) = configured_decision(&policy, &analysis.trimmed, &analysis);
    let protected = !is_dedicated_local_shell || !is_readonly_allow_candidate(&analysis);
    let (effective_effect, reason) = match configured_effect {
        ShellRuleEffect::Deny => (ShellRuleEffect::Deny, "matched_deny"),
        ShellRuleEffect::Ask => (ShellRuleEffect::Ask, "matched_or_default_ask"),
        ShellRuleEffect::Allow if protected => {
            (ShellRuleEffect::Ask, "allow_blocked_by_safety_gate")
        }
        ShellRuleEffect::Allow => (ShellRuleEffect::Allow, "safe_local_allow"),
    };
    ShellPolicyDecision {
        configured_effect,
        effective_effect,
        matched_rule_id: matched.map(|rule| rule.id.clone()),
        matched_kind: matched.map(|rule| rule.matcher.kind),
        protected,
        reason,
        config_valid,
    }
}

/// Apply a resolved command decision to the executor sensitivity. Ask is a
/// lower bound, not merely "leave the default unchanged": an MCP shell that
/// incorrectly declares itself Low must still prompt.
pub fn apply_to_sensitivity(
    decision: &ShellPolicyDecision,
    base: Option<ToolSensitivity>,
) -> Option<ToolSensitivity> {
    match decision.effective_effect {
        ShellRuleEffect::Allow => Some(ToolSensitivity::Low),
        ShellRuleEffect::Ask => match base {
            Some(ToolSensitivity::High) => Some(ToolSensitivity::High),
            _ => Some(ToolSensitivity::Medium),
        },
        ShellRuleEffect::Deny => Some(ToolSensitivity::High),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(rules: serde_json::Value) -> String {
        serde_json::json!({"version":1,"default_effect":"ask","rules":rules}).to_string()
    }

    #[test]
    fn invalid_json_and_empty_rule_fail_closed() {
        assert_eq!(
            enforce_for_call(Some("{"), "ls", true).effective_effect,
            ShellRuleEffect::Ask
        );
        assert!(!enforce_for_call(Some("{"), "ls", true).config_valid);
        let empty = policy(serde_json::json!([{
            "id":"empty","effect":"allow","match":{"kind":"prefix","value":""}
        }]));
        assert!(parse_policy(&empty).is_err());
        assert_eq!(
            enforce_for_call(Some(&empty), "ls", true).effective_effect,
            ShellRuleEffect::Ask
        );
    }

    #[test]
    fn deny_wins_over_ask_and_allow() {
        let raw = policy(serde_json::json!([
            {"id":"allow-ls","effect":"allow","match":{"kind":"executable","value":"ls"}},
            {"id":"ask-ls","effect":"ask","match":{"kind":"prefix","value":"ls"}},
            {"id":"deny-exact","effect":"deny","match":{"kind":"exact","value":"ls -la"}}
        ]));
        let decision = enforce_for_call(Some(&raw), "ls -la", true);
        assert_eq!(decision.effective_effect, ShellRuleEffect::Deny);
        assert_eq!(decision.matched_rule_id.as_deref(), Some("deny-exact"));
    }

    #[test]
    fn prefix_requires_token_boundary() {
        let raw = policy(serde_json::json!([{
            "id":"deny-rm","effect":"deny","match":{"kind":"prefix","value":"rm"}
        }]));
        assert_eq!(
            enforce_for_call(Some(&raw), "rm -f x", true).effective_effect,
            ShellRuleEffect::Deny
        );
        assert_eq!(
            enforce_for_call(Some(&raw), "rmdir x", true).effective_effect,
            ShellRuleEffect::Ask
        );
    }

    #[test]
    fn safe_local_allow_does_not_cross_external_or_effectful_boundaries() {
        // Allow rules are advisory: bare PATH executables stay Ask, while
        // trusted absolute paths / unshadowable builtins may become Allow.
        let raw = policy(serde_json::json!([{
            "id":"allow-ls","effect":"allow","match":{"kind":"executable","value":"ls"}
        },{
            "id":"allow-echo","effect":"allow","match":{"kind":"executable","value":"echo"}
        },{
            "id":"allow-rg","effect":"allow","match":{"kind":"executable","value":"rg"}
        },{
            "id":"allow-git","effect":"allow","match":{"kind":"executable","value":"git"}
        },{
            "id":"allow-curl","effect":"allow","match":{"kind":"executable","value":"curl"}
        },{
            "id":"allow-rm","effect":"allow","match":{"kind":"executable","value":"rm"}
        },{
            "id":"allow-python","effect":"allow","match":{"kind":"executable","value":"python"}
        }]));
        assert_eq!(
            enforce_for_call(Some(&raw), "ls -la", true).effective_effect,
            ShellRuleEffect::Ask
        );
        assert_eq!(
            enforce_for_call(Some(&raw), "echo ready", false).effective_effect,
            ShellRuleEffect::Ask
        );
        for command in [
            "ls | cat",
            "ls && curl https://example.com",
            "ls > listing.txt",
            "ls $(curl https://example.com)",
            "git status; rm -rf x",
            "git push origin main",
            "git config --global user.name example",
            "git branch -D old-branch",
            "rg --pre=/tmp/processor pattern .",
            "curl https://example.com",
            "rm -f x",
            "python -c 'print(1)'",
            "sudo ls",
            "du -sh .",
        ] {
            assert_ne!(
                enforce_for_call(Some(&raw), command, true).effective_effect,
                ShellRuleEffect::Allow,
                "{command}"
            );
        }
        assert_eq!(
            enforce_for_call(Some(&raw), "git status --short", true).effective_effect,
            ShellRuleEffect::Ask
        );
        assert_eq!(
            enforce_for_call(Some(&raw), "echo ready", true).effective_effect,
            ShellRuleEffect::Allow
        );
        #[cfg(not(windows))]
        assert_eq!(
            enforce_for_call(Some(&raw), "/bin/ls -la", true).effective_effect,
            ShellRuleEffect::Allow
        );
    }

    #[test]
    fn allow_never_downgrades_path_shadowable_or_subprocess_capable_commands() {
        let default_allow = serde_json::json!({
            "version": 1,
            "default_effect": "allow",
            "rules": []
        })
        .to_string();

        for command in [
            "ls -la",
            "cat README.md",
            "grep needle README.md",
            "stat README.md",
        ] {
            assert_eq!(
                enforce_for_call(Some(&default_allow), command, true).effective_effect,
                ShellRuleEffect::Ask,
                "bare PATH-resolved executable must not bypass approval: {command}"
            );
        }

        for command in [
            "/usr/bin/rg --pre=/tmp/processor needle .",
            "/usr/bin/git status --short",
            "/usr/bin/git diff --ext-diff",
            "/usr/bin/git show --textconv HEAD:file",
            "/usr/bin/git -c core.fsmonitor=/tmp/hook status",
            "/usr/bin/git -c diff.external=/tmp/differ diff",
        ] {
            assert_eq!(
                enforce_for_call(Some(&default_allow), command, true).effective_effect,
                ShellRuleEffect::Ask,
                "subprocess-capable command family must not bypass approval: {command}"
            );
        }

        assert_eq!(
            enforce_for_call(Some(&default_allow), "echo ready", true).effective_effect,
            ShellRuleEffect::Allow
        );
        #[cfg(not(windows))]
        assert_eq!(
            enforce_for_call(Some(&default_allow), "/usr/bin/grep needle README.md", true)
                .effective_effect,
            ShellRuleEffect::Allow
        );
    }

    #[test]
    fn executable_rules_match_auditable_basename_case_insensitively() {
        let raw = policy(serde_json::json!([{
            "id":"deny-git","effect":"deny","match":{"kind":"executable","value":"GIT"}
        }]));
        assert_eq!(
            enforce_for_call(Some(&raw), "/usr/bin/git status", true).effective_effect,
            ShellRuleEffect::Deny
        );
    }

    #[test]
    fn ask_forces_low_executor_to_medium_and_default_deny_blocks() {
        let decision = enforce_for_call(None, "ls", true);
        assert_eq!(
            apply_to_sensitivity(&decision, Some(ToolSensitivity::Low)),
            Some(ToolSensitivity::Medium)
        );

        let default_deny = serde_json::json!({
            "version": 1,
            "default_effect": "deny",
            "rules": []
        })
        .to_string();
        assert_eq!(
            enforce_for_call(Some(&default_deny), "ls", true).effective_effect,
            ShellRuleEffect::Deny
        );
    }

    #[test]
    fn prefix_does_not_match_a_longer_partial_token() {
        let raw = policy(serde_json::json!([{
            "id":"deny-git-stat","effect":"deny","match":{"kind":"prefix","value":"git stat"}
        }]));
        assert_eq!(
            enforce_for_call(Some(&raw), "git stat --short", true).effective_effect,
            ShellRuleEffect::Deny
        );
        assert_eq!(
            enforce_for_call(Some(&raw), "git status --short", true).effective_effect,
            ShellRuleEffect::Ask
        );
    }
}
