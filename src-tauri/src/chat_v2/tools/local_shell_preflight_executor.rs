use std::path::Path;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::approval_scope::{analyze_shell_command, redact_shell_command_for_display};
use crate::chat_v2::context::local_shell_contract_for_platform;
use crate::chat_v2::runtime_roots::{
    explicit_runtime_root_id_from_args, normalize_runtime_relative_path,
    resolve_effective_runtime_root_id_for_session, runtime_root_by_id, RuntimeRoot,
    RuntimeRootAccess, RuntimeRootKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;

pub mod tool_names {
    pub const SHELL_PREFLIGHT: &str = "local_shell_preflight";
}

pub struct LocalShellPreflightExecutor;

impl LocalShellPreflightExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        strip_tool_namespace(tool_name)
    }

    fn sha256_hex(input: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(input.as_bytes());
        hex::encode(hasher.finalize())
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

    fn command_tokens_lower(command: &str) -> Vec<String> {
        command
            .split_whitespace()
            .take(3)
            .map(|token| {
                token
                    .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '`')
                    .to_ascii_lowercase()
            })
            .collect()
    }

    fn has_dangerous_command_prefix(command: &str) -> bool {
        let tokens = Self::command_tokens_lower(command);
        let first = tokens.first().map(String::as_str).unwrap_or("");
        let second = tokens.get(1).map(String::as_str).unwrap_or("");

        matches!(
            first,
            "rm" | "del"
                | "erase"
                | "rmdir"
                | "rd"
                | "mv"
                | "move"
                | "cp"
                | "copy"
                | "remove-item"
                | "move-item"
                | "copy-item"
                | "set-content"
                | "add-content"
                | "new-item"
                | "start-process"
                | "curl"
                | "wget"
        ) || (first == "git"
            && matches!(
                second,
                "push" | "reset" | "checkout" | "clean" | "rebase" | "merge" | "commit"
            ))
            || (matches!(first, "npm" | "pnpm" | "yarn") && second == "install")
    }

    fn is_low_risk_readonly_prefix(command: &str) -> bool {
        let tokens = Self::command_tokens_lower(command);
        let first = tokens.first().map(String::as_str).unwrap_or("");
        let second = tokens.get(1).map(String::as_str).unwrap_or("");

        matches!(first, "pwd" | "ls" | "dir" | "rg" | "grep" | "cat" | "type")
            || (first == "git" && matches!(second, "status" | "diff" | "log"))
    }

    fn inspect_cwd(root: &RuntimeRoot, cwd: &Path) -> (String, bool, Vec<String>) {
        let target = root.path.join(cwd);
        let display = if cwd.as_os_str().is_empty() {
            ".".to_string()
        } else {
            cwd.to_string_lossy().to_string()
        };
        let mut reasons = Vec::new();

        if !root.path.exists() {
            reasons.push("runtime root does not exist yet".to_string());
            return (display, false, reasons);
        }

        if !target.exists() {
            reasons.push("cwd does not exist".to_string());
            return (display, false, reasons);
        }

        let root_canon = match root.path.canonicalize() {
            Ok(path) => path,
            Err(error) => {
                reasons.push(format!("failed to canonicalize runtime root: {}", error));
                return (display, false, reasons);
            }
        };
        let target_canon = match target.canonicalize() {
            Ok(path) => path,
            Err(error) => {
                reasons.push(format!("failed to canonicalize cwd: {}", error));
                return (display, false, reasons);
            }
        };

        if !target_canon.starts_with(root_canon) {
            reasons.push("cwd escapes the selected runtime root".to_string());
            return (display, false, reasons);
        }
        if !target_canon.is_dir() {
            reasons.push("cwd is not a directory".to_string());
            return (display, false, reasons);
        }

        (display, true, reasons)
    }

    async fn execute_preflight(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let command = args
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let explicit_root_id = explicit_runtime_root_id_from_args(args);
        let skill_root_id_input = args
            .get("skill_root_id")
            .or_else(|| args.get("skillRootId"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let cwd_input = args
            .get("cwd")
            .or_else(|| args.get("working_dir"))
            .or_else(|| args.get("workingDir"))
            .and_then(|v| v.as_str());
        let timeout_ms = args
            .get("timeout_ms")
            .or_else(|| args.get("timeoutMs"))
            .and_then(|v| v.as_u64())
            .unwrap_or(30_000)
            .clamp(1_000, 120_000);
        let purpose = args
            .get("purpose")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let mut reasons = Vec::new();
        let platform = std::env::consts::OS;
        let shell = local_shell_contract_for_platform(platform);
        if !shell.execution_supported {
            reasons.push(format!(
                "local shell execution is unsupported on platform '{}'",
                platform
            ));
        }
        let state = ctx.window.state::<AppState>();
        let effective_root_id = resolve_effective_runtime_root_id_for_session(
            &ctx.window.app_handle(),
            &state.database,
            ctx.chat_v2_db.as_deref(),
            &ctx.session_id,
            ctx.skill_package_roots.as_ref(),
            explicit_root_id.as_deref(),
        );
        let root_id_input = Some(effective_root_id.as_str());
        let root_result = runtime_root_by_id(
            &ctx.window.app_handle(),
            &state.database,
            &ctx.session_id,
            ctx.skill_package_roots.as_ref(),
            root_id_input,
            true,
        );
        let cwd_result = normalize_runtime_relative_path(cwd_input);
        let analysis = analyze_shell_command(&command);
        let (display_command, command_redacted) = redact_shell_command_for_display(&command);
        let display_analysis = analyze_shell_command(&display_command);
        let raw_command_policy = state
            .database
            .get_setting(crate::chat_v2::shell_command_policy::SETTING_KEY)
            .ok()
            .flatten();
        let command_policy = crate::chat_v2::shell_command_policy::enforce_for_call(
            raw_command_policy.as_deref(),
            &command,
            true,
        );

        if command.is_empty() {
            reasons.push("command is required".to_string());
        }
        if command.len() > 8192 {
            reasons.push("command is too long for local shell preflight".to_string());
        }
        // 🔒 封侧门：命令正文命中技能包目录 → 直接标 blocked，
        // 指引改用 skill_install（scan → install）或技能管理 UI。
        let touches_skills_directory =
            crate::chat_v2::skills::command_mentions_skills_directory(&command);
        if touches_skills_directory {
            reasons.push(
                "command touches a skill package directory; local shell is blocked here — \
                 use skill_scan first, then skill_install with expected_sha256, or the Skills management UI"
                    .to_string(),
            );
        }
        if analysis.has_shell_operators {
            reasons.push("command contains shell operators or redirection".to_string());
        }
        if analysis.uses_script_runner {
            reasons.push("command uses a script/code runner".to_string());
        }
        if Self::has_dangerous_command_prefix(&command) {
            reasons.push("command prefix is write-capable or externally effectful".to_string());
        }
        if command_policy.effective_effect
            == crate::chat_v2::shell_command_policy::ShellRuleEffect::Deny
        {
            reasons.push("command is denied by the configured terminal command rules".to_string());
        } else if command_policy.configured_effect
            == crate::chat_v2::shell_command_policy::ShellRuleEffect::Allow
            && command_policy.effective_effect
                != crate::chat_v2::shell_command_policy::ShellRuleEffect::Allow
        {
            reasons.push(
                "matching allow rule cannot bypass approval for a protected command".to_string(),
            );
        }

        let (root, root_error) = match root_result {
            Ok(root) => (Some(root), None),
            Err(error) => {
                reasons.push(error.clone());
                (None, Some(error))
            }
        };
        let skill_cwd_blocked = root
            .as_ref()
            .map(|root| root.kind == RuntimeRootKind::SkillPackage)
            .unwrap_or(false);
        if skill_cwd_blocked {
            reasons.push(
                "shell execution cannot run directly inside skill package roots; use skill_root_id for SKILL_DIR injection"
                    .to_string(),
            );
        }
        // 🔒 与 execute 侧一致：只读 root（workspace / authorized）不放行写入类命令
        let readonly_write_blocked = root
            .as_ref()
            .map(|root| {
                root.access == RuntimeRootAccess::ReadOnly
                    && super::local_shell_execute_executor::LocalShellExecuteExecutor::command_appears_write_capable(&command)
            })
            .unwrap_or(false);
        if readonly_write_blocked {
            reasons.push(
                "runtime root is read-only for the agent runtime and the command looks write-capable; \
                 use root_id=artifacts or root_id=temp for writes"
                    .to_string(),
            );
        }
        let (cwd_relative, cwd_valid, cwd_error) = match cwd_result {
            Ok(cwd) => {
                if let Some(root) = root.as_ref() {
                    let (display, valid, cwd_reasons) = Self::inspect_cwd(root, &cwd);
                    reasons.extend(cwd_reasons);
                    (display, valid, None)
                } else {
                    let display = if cwd.as_os_str().is_empty() {
                        ".".to_string()
                    } else {
                        cwd.to_string_lossy().to_string()
                    };
                    (display, false, None)
                }
            }
            Err(error) => {
                reasons.push(error.clone());
                (".".to_string(), false, Some(error))
            }
        };

        // skill_root_id only plans a SKILL_DIR env injection at execute time;
        // it never relaxes the cwd restriction on skill package roots.
        let skill_dir_root_id: Option<String> = match skill_root_id_input {
            None => None,
            Some(skill_root_id) => {
                let resolved = runtime_root_by_id(
                    &ctx.window.app_handle(),
                    &state.database,
                    &ctx.session_id,
                    ctx.skill_package_roots.as_ref(),
                    Some(skill_root_id),
                    true,
                );
                match resolved {
                    Ok(root) if root.kind == RuntimeRootKind::SkillPackage => Some(root.id),
                    Ok(root) => {
                        reasons.push(format!(
                            "skill_root_id must reference a skill package root (skill:<skillId>); '{}' is not a skill package root",
                            root.id
                        ));
                        None
                    }
                    Err(error) => {
                        reasons.push(format!(
                            "Failed to resolve skill_root_id '{}': {}",
                            skill_root_id, error
                        ));
                        None
                    }
                }
            }
        };
        let skill_root_invalid = skill_root_id_input.is_some() && skill_dir_root_id.is_none();

        let blocked = command.is_empty()
            || command.len() > 8192
            || !shell.execution_supported
            || command_policy.effective_effect
                == crate::chat_v2::shell_command_policy::ShellRuleEffect::Deny
            || touches_skills_directory
            || skill_cwd_blocked
            || readonly_write_blocked
            || root_error.is_some()
            || cwd_error.is_some()
            || !cwd_valid
            || skill_root_invalid
            || reasons
                .iter()
                .any(|reason| reason.contains("escapes the selected runtime root"));
        let risk_level = if blocked {
            "blocked"
        } else if analysis.has_shell_operators
            || analysis.uses_script_runner
            || Self::has_dangerous_command_prefix(&command)
        {
            "high"
        } else if cwd_valid && Self::is_low_risk_readonly_prefix(&command) {
            "low"
        } else {
            "medium"
        };

        Ok(json!({
            "command": display_command,
            "command_hash": Self::sha256_hex(&analysis.trimmed),
            "command_redacted": command_redacted,
            "command_prefix": display_analysis.command_prefix,
            "first_token": display_analysis.first_token,
            "root": root.as_ref().map(Self::root_json),
            "root_id": root.as_ref().map(|root| root.id.clone()).unwrap_or_else(|| root_id_input.unwrap_or("workspace").to_string()),
            "skill_root_id": skill_root_id_input,
            "skill_dir_injection": skill_dir_root_id.as_ref().map(|root_id| json!({
                "variable": "SKILL_DIR",
                "root_id": root_id,
            })),
            "cwd": cwd_relative,
            "cwd_valid": cwd_valid,
            "timeout_ms": timeout_ms,
            "purpose": purpose,
            "risk_level": risk_level,
            "reasons": reasons,
            "command_policy": command_policy,
            "has_shell_operators": analysis.has_shell_operators,
            "uses_script_runner": analysis.uses_script_runner,
            "would_execute": false,
            "platform": platform,
            "os": shell.os,
            "shell_path": shell.shell_path,
            "sandbox_backend": shell.sandbox_backend,
            "shell_kind": shell.shell_kind,
            "shell_invocation": shell.invocation,
            "output_encoding": shell.output_encoding,
            "non_interactive": true,
            "pty_available": false,
            "persistent_shell_session": false,
            "network_default": "deny",
            "execution_supported": shell.execution_supported,
            "requires_approval_before_execute": command_policy.effective_effect
                != crate::chat_v2::shell_command_policy::ShellRuleEffect::Allow,
        }))
    }
}

#[async_trait]
impl ToolExecutor for LocalShellPreflightExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        Self::strip_namespace(tool_name) == tool_names::SHELL_PREFLIGHT
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = self.execute_preflight(&call.arguments, ctx).await;
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
                    log::warn!(
                        "[LocalShellPreflightExecutor] Failed to save tool block: {}",
                        e
                    );
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
                    log::warn!(
                        "[LocalShellPreflightExecutor] Failed to save tool block: {}",
                        e
                    );
                }
                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "LocalShellPreflightExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_root(path: &Path) -> RuntimeRoot {
        RuntimeRoot {
            id: "workspace".to_string(),
            kind: RuntimeRootKind::Workspace,
            path: path.to_path_buf(),
            access: RuntimeRootAccess::ReadOnly,
            label: "Workspace".to_string(),
            description: String::new(),
            session_scoped: false,
            configured: true,
        }
    }

    #[test]
    fn classifies_readonly_prefix_as_low_risk_candidate() {
        assert!(LocalShellPreflightExecutor::is_low_risk_readonly_prefix(
            "git status --short"
        ));
        assert!(LocalShellPreflightExecutor::is_low_risk_readonly_prefix(
            "rg skill"
        ));
        assert!(!LocalShellPreflightExecutor::is_low_risk_readonly_prefix(
            "cargo test"
        ));
    }

    #[test]
    fn classifies_write_capable_prefixes_as_dangerous() {
        assert!(LocalShellPreflightExecutor::has_dangerous_command_prefix(
            "rm -rf target"
        ));
        assert!(LocalShellPreflightExecutor::has_dangerous_command_prefix(
            "git push origin main"
        ));
        assert!(LocalShellPreflightExecutor::has_dangerous_command_prefix(
            "npm install"
        ));
        assert!(!LocalShellPreflightExecutor::has_dangerous_command_prefix(
            "git status"
        ));
    }

    /// SECURITY: 封侧门谓词——preflight 对命中技能目录的命令标 blocked。
    /// 覆盖 Windows 反斜杠与正斜杠两种路径写法。
    #[test]
    fn skills_directory_commands_are_flagged_for_blocking() {
        assert!(crate::chat_v2::skills::command_mentions_skills_directory(
            r"Remove-Item -Recurse C:\Users\x\.deep-student\skills\foo"
        ));
        assert!(crate::chat_v2::skills::command_mentions_skills_directory(
            "ls ~/.cursor/skills-cursor"
        ));
        assert!(crate::chat_v2::skills::command_mentions_skills_directory(
            "cat .agents/skills/foo/SKILL.md"
        ));
        assert!(!crate::chat_v2::skills::command_mentions_skills_directory(
            "rg skill src/"
        ));
    }

    #[test]
    fn cwd_must_exist_and_be_a_directory() {
        let temp = tempfile::tempdir().expect("temp root");
        let root = test_root(temp.path());

        let (_, valid, reasons) =
            LocalShellPreflightExecutor::inspect_cwd(&root, Path::new("missing"));
        assert!(!valid);
        assert!(reasons.iter().any(|reason| reason == "cwd does not exist"));

        fs::write(temp.path().join("file.txt"), b"not a directory").expect("write fixture");
        let (_, valid, reasons) =
            LocalShellPreflightExecutor::inspect_cwd(&root, Path::new("file.txt"));
        assert!(!valid);
        assert!(reasons
            .iter()
            .any(|reason| reason == "cwd is not a directory"));
    }

    #[test]
    fn platform_contract_matches_executor_backends() {
        let macos = local_shell_contract_for_platform("macos");
        assert_eq!(macos.shell_path, Some("/bin/sh"));
        assert_eq!(macos.shell_kind, "posix_sh");
        assert!(macos.execution_supported);

        let windows = local_shell_contract_for_platform("windows");
        assert_eq!(
            windows.shell_path,
            Some(r"System32\WindowsPowerShell\v1.0\powershell.exe")
        );
        assert_eq!(windows.shell_kind, "windows_powershell");
        assert_eq!(windows.output_encoding, Some("utf-8"));
        assert!(windows.execution_supported);

        let linux = local_shell_contract_for_platform("linux");
        assert_eq!(linux.shell_path, None);
        assert_eq!(linux.sandbox_backend, "unavailable");
        assert_eq!(linux.shell_kind, "unavailable");
        assert_eq!(linux.output_encoding, Some("unknown"));
        assert!(!linux.execution_supported);
    }

    #[test]
    fn preflight_command_audit_redacts_secrets_but_hashes_the_original() {
        let command = "curl --token raw-secret-value https://example.test";
        let analysis = analyze_shell_command(command);
        let (display, redacted) = redact_shell_command_for_display(command);

        assert!(redacted);
        assert_eq!(display, "curl --token [REDACTED] https://example.test");
        assert!(!display.contains("raw-secret-value"));
        assert_eq!(
            LocalShellPreflightExecutor::sha256_hex(&analysis.trimmed),
            LocalShellPreflightExecutor::sha256_hex(command)
        );
    }
}
