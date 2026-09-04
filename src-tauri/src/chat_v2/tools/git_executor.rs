//! 语义 Git 工具组执行器（git_status / git_diff / git_log / git_branch / git_commit）。
//!
//! 设计要点：
//! - 只暴露严格结构化参数，不接受 raw command / args；命令由后端按固定模板构造。
//! - 复用 `LocalShellExecuteExecutor` 的沙箱执行通道（`execute_shell_with_options`），
//!   仅此执行器开启 `allow_git_metadata_write`（放开当前所选 root 的 `.git` 写保护，
//!   供 `git add` / `git commit` / `git branch` / `git switch` 使用）；普通
//!   `local_shell_execute` 永远保持 `.git` 写保护。
//! - 能力面固定为 status / diff / log / branch(list|create|switch|delete) / commit。
//!   不提供 network（fetch/pull/push/clone）、push、reset、clean、stash、rebase、
//!   merge 或任何 force 变体；分支删除固定使用安全的 `-d`（拒绝未合并分支）。
//! - `git_commit` 固定执行两段：先 `git add -- <paths...>`，成功后
//!   `git commit -m <message>`。故意不拼成 `git add ... && git commit ...`
//!   单条命令：immutable shell guard 对含 shell 操作符的复合命令要求
//!   local_shell_execute 专用的审批证据（`shell_guard_approved`），语义 Git
//!   工具走自己的 High 敏感度审批，拆成两条简单命令可在该 guard 下以
//!   ordinary_command 通过，同时保持"add 失败则不 commit"的语义。
//! - 敏感等级：status/diff/log 与 branch list 为 Medium（只读）；
//!   branch create/switch/delete 与 commit 为 High（写 `.git` / 工作区）。
//! - 参数安全：所有路径与分支名/提交信息经平台对应的安全 quoting
//!   （POSIX 单引号 / Windows PowerShell 单引号）后进入固定命令模板；
//!   路径必须是所选 runtime root 内的相对路径（禁止绝对路径、`..`、前导 `-`），
//!   写操作的 root 内 containment 由 shell 执行通道二次强制。

use std::path::{Component, Path};
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Map, Value};

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::local_shell_execute_executor::{LocalShellExecuteExecutor, ShellExecuteOptions};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

pub mod tool_names {
    pub const GIT_STATUS: &str = "git_status";
    pub const GIT_DIFF: &str = "git_diff";
    pub const GIT_LOG: &str = "git_log";
    pub const GIT_BRANCH: &str = "git_branch";
    pub const GIT_COMMIT: &str = "git_commit";
}

const MAX_PATHS: usize = 200;
const MAX_PATH_CHARS: usize = 512;
const MAX_BRANCH_NAME_CHARS: usize = 200;
const MAX_MESSAGE_CHARS: usize = 4000;
const DEFAULT_LOG_LIMIT: u32 = 20;
const MAX_LOG_LIMIT: u32 = 100;
const GIT_DIFF_MAX_OUTPUT_BYTES: u64 = 256 * 1024;

/// 语义 Git 工具组执行器。内部持有一个 shell 执行器实例，仅用于
/// `execute_shell_with_options` 通道；不注册、不处理 local_shell_execute。
pub struct GitToolExecutor {
    shell: LocalShellExecuteExecutor,
}

impl Default for GitToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

/// POSIX（/bin/sh）单引号 quoting：无法表达的单引号拆为 '\'' 三段式。
fn quote_arg_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Windows PowerShell 单引号 quoting：单引号成对加倍，无其他转义语义。
fn quote_arg_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// 按运行平台选择 quoting；命令由后端固定模板构造，模型参数永远作为
/// 单个 quoted token 进入命令行。
fn quote_arg(value: &str) -> String {
    #[cfg(windows)]
    {
        if super::shell_sandbox::windows_has_git_bash() {
            quote_arg_posix(value)
        } else {
            quote_arg_powershell(value)
        }
    }
    #[cfg(not(windows))]
    {
        quote_arg_posix(value)
    }
}

fn invalid_argument(field: &str, reason: impl Into<String>) -> String {
    format!("Invalid '{}': {}", field, reason.into())
}

fn arguments_object(arguments: &Value) -> Result<&Map<String, Value>, String> {
    arguments
        .as_object()
        .ok_or_else(|| invalid_argument("arguments", "expected a JSON object"))
}

fn ensure_allowed_keys(arguments: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if let Some(key) = arguments
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid_argument(
            key,
            "unknown field for this tool; additional properties are not allowed",
        ));
    }
    Ok(())
}

/// 校验单个 git 路径参数：必须是相对路径，禁止绝对路径、`..` 组件、
/// 前导 `-`（防 option 注入）与控制字符。`--` 分隔符之外的纵深防护由
/// shell 执行通道的 root containment 校验承担。
fn validate_repo_relative_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(invalid_argument("paths", "path entries must not be blank"));
    }
    if trimmed.chars().count() > MAX_PATH_CHARS {
        return Err(invalid_argument(
            "paths",
            format!("path entries must contain at most {MAX_PATH_CHARS} characters"),
        ));
    }
    if trimmed.starts_with('-') {
        return Err(invalid_argument(
            "paths",
            format!("path '{trimmed}' must not start with '-'"),
        ));
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err(invalid_argument(
            "paths",
            format!("path '{trimmed}' contains a control character"),
        ));
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err(invalid_argument(
            "paths",
            format!("path '{trimmed}' must be relative to the selected root"),
        ));
    }
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(invalid_argument(
            "paths",
            format!("path '{trimmed}' must not contain '..'"),
        ));
    }
    Ok(trimmed.to_string())
}

fn optional_paths(
    arguments: &Map<String, Value>,
    required: bool,
) -> Result<Option<Vec<String>>, String> {
    let Some(value) = arguments.get("paths") else {
        if required {
            return Err(invalid_argument(
                "paths",
                "field is required and must be a non-empty array",
            ));
        }
        return Ok(None);
    };
    let items = value
        .as_array()
        .ok_or_else(|| invalid_argument("paths", "expected an array of relative paths"))?;
    if items.is_empty() {
        if required {
            return Err(invalid_argument(
                "paths",
                "must contain at least one path; git_commit never stages the whole tree",
            ));
        }
        return Ok(Some(Vec::new()));
    }
    if items.len() > MAX_PATHS {
        return Err(invalid_argument(
            "paths",
            format!("must contain at most {MAX_PATHS} entries"),
        ));
    }
    let mut paths = Vec::with_capacity(items.len());
    for item in items {
        let raw = item
            .as_str()
            .ok_or_else(|| invalid_argument("paths", "entries must be strings"))?;
        paths.push(validate_repo_relative_path(raw)?);
    }
    Ok(Some(paths))
}

/// 分支名校验：非空、禁止前导 `-`（防 option 注入）、禁止空白/控制字符
/// 与 `..`；其余 refname 规则（~ ^ : ? * [ 等）由 git 自身拒绝并回报。
fn validate_branch_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(invalid_argument("name", "branch name must not be blank"));
    }
    if trimmed.chars().count() > MAX_BRANCH_NAME_CHARS {
        return Err(invalid_argument(
            "name",
            format!("branch name must contain at most {MAX_BRANCH_NAME_CHARS} characters"),
        ));
    }
    if trimmed.starts_with('-') {
        return Err(invalid_argument(
            "name",
            "branch name must not start with '-'",
        ));
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(invalid_argument(
            "name",
            "branch name must not contain whitespace or control characters",
        ));
    }
    if trimmed.contains("..") {
        return Err(invalid_argument(
            "name",
            "branch name must not contain '..'",
        ));
    }
    Ok(trimmed.to_string())
}

fn git_command(subcommand: &str) -> String {
    format!("git --no-pager --no-optional-locks --literal-pathspecs {subcommand}")
}

fn build_git_status_command() -> String {
    git_command("status --porcelain=v1 --branch")
}

fn build_git_diff_command(staged: bool, paths: Option<&[String]>) -> String {
    let mut command = git_command("diff");
    if staged {
        command.push_str(" --staged");
    }
    if let Some(paths) = paths {
        if !paths.is_empty() {
            command.push_str(" --");
            for path in paths {
                command.push(' ');
                command.push_str(&quote_arg(path));
            }
        }
    }
    command
}

fn build_git_log_command(limit: u32) -> String {
    git_command(&format!(
        "log -n {limit} --format='%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e'"
    ))
}

fn build_git_branch_list_command() -> String {
    git_command(
        "branch --format='%(HEAD)%x1f%(refname:short)%x1f%(objectname:short)%x1f%(subject)%x1e'",
    )
}

fn build_git_branch_create_command(name: &str) -> String {
    git_command(&format!("branch -- {}", quote_arg(name)))
}

fn build_git_branch_switch_command(name: &str) -> String {
    git_command(&format!("switch -- {}", quote_arg(name)))
}

/// 安全删除：固定 `-d`（拒绝删除未合并分支），不提供 force。
fn build_git_branch_delete_command(name: &str) -> String {
    git_command(&format!("branch -d -- {}", quote_arg(name)))
}

fn build_git_add_command(paths: &[String]) -> String {
    let mut command = git_command("add --");
    for path in paths {
        command.push(' ');
        command.push_str(&quote_arg(path));
    }
    command
}

fn build_git_commit_command(message: &str, paths: &[String]) -> String {
    let mut command = git_command(&format!(
        "-c commit.gpgSign=false commit -m {} --",
        quote_arg(message)
    ));
    for path in paths {
        command.push(' ');
        command.push_str(&quote_arg(path));
    }
    command
}

/// 从 shell 输出中提取给模型的紧凑摘要（完整审计字段已在工具块中持久化）。
fn shell_step_json(output: &Value) -> Value {
    json!({
        "command": output.get("command").cloned().unwrap_or(Value::Null),
        "exit_code": output.get("exit_code").cloned().unwrap_or(Value::Null),
        "success": output
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        "stdout": output
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
        "stderr": output
            .get("stderr")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
        "file_change_summary": output.get("file_change_summary").cloned().unwrap_or(Value::Null),
        "change_set": output.get("change_set").cloned().unwrap_or(Value::Null),
        "change_set_complete": output.get("change_set_complete").cloned().unwrap_or(Value::Null),
        "change_set_error": output.get("change_set_error").cloned().unwrap_or(Value::Null),
    })
}

fn shell_output_failed(output: &Value) -> Option<String> {
    let success = output
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if success {
        return None;
    }
    let exit_code = output
        .get("exit_code")
        .and_then(|v| v.as_i64())
        .map(|code| code.to_string())
        .unwrap_or_else(|| "<none>".to_string());
    let stderr = output
        .get("stderr")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let stderr_tail = stderr
        .char_indices()
        .rev()
        .take(1_000)
        .last()
        .map(|(idx, _)| &stderr[idx..])
        .unwrap_or("");
    Some(if stderr_tail.is_empty() {
        format!("git command failed with exit code {exit_code}")
    } else {
        format!("git command failed with exit code {exit_code}: {stderr_tail}")
    })
}

struct GitToolFailure {
    message: String,
    output: Option<Value>,
}

impl GitToolFailure {
    fn plain(message: String) -> Self {
        Self {
            message,
            output: None,
        }
    }

    fn with_output(message: String, output: Value) -> Self {
        Self {
            message,
            output: Some(output),
        }
    }
}

impl GitToolExecutor {
    pub fn new() -> Self {
        Self {
            shell: LocalShellExecuteExecutor::new(),
        }
    }

    fn shell_arguments(command: String, write: bool) -> Value {
        let mut args = Map::new();
        args.insert("command".to_string(), Value::String(command));
        args.insert(
            "root_id".to_string(),
            Value::String("workspace".to_string()),
        );
        args.insert("inherit_env".to_string(), Value::Bool(false));
        args.insert("env".to_string(), json!({ "GIT_TERMINAL_PROMPT": "0" }));
        // 只读命令跳过快照；写命令必须保留文件变更追踪（workspace 写命令
        // 在 shell 通道强制 track_file_changes=true 才能录制 change_set）。
        if !write {
            args.insert("track_file_changes".to_string(), Value::Bool(false));
        }
        Value::Object(args)
    }

    /// 经语义 Git 专用 options 执行一条固定模板的 git 命令。
    /// `allow_git_metadata_write: true` 仅在此处设置，模型 JSON 无法触达。
    async fn run_git(
        &self,
        command: String,
        write: bool,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let args = Self::shell_arguments(command, write);
        /*
            // diff 才可能有大输出；写命令保持默认输出上限即可。这里只对
            // 读命令按需放宽（见 execute_git_diff）。
            let _ = &args;
        */
        self.shell
            .execute_shell_with_options(
                &args,
                ctx,
                ShellExecuteOptions {
                    structured_command_approved: true,
                    force_read_only: !write,
                    allow_git_metadata_write: write,
                },
            )
            .await
    }

    async fn execute_git_status(
        &self,
        arguments: &Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        ensure_allowed_keys(arguments, &[])?;
        let output = self.run_git(build_git_status_command(), false, ctx).await?;
        if let Some(error) = shell_output_failed(&output) {
            return Err(error);
        }
        Ok(json!({
            "action": "status",
            "format": "porcelain",
            "root_id": output.get("root_id").cloned().unwrap_or(Value::Null),
            "porcelain": output.get("stdout").cloned().unwrap_or(Value::Null),
        }))
    }

    async fn execute_git_diff(
        &self,
        arguments: &Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        ensure_allowed_keys(arguments, &["staged", "paths"])?;
        let staged = arguments
            .get("staged")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| invalid_argument("staged", "expected a boolean"))
            })
            .transpose()?
            .unwrap_or(false);
        let paths = optional_paths(arguments, false)?;
        let command = build_git_diff_command(staged, paths.as_deref());
        let mut args = Self::shell_arguments(command, false);
        args.as_object_mut()
            .expect("shell arguments are an object")
            .insert(
                "max_output_bytes".to_string(),
                Value::Number(GIT_DIFF_MAX_OUTPUT_BYTES.into()),
            );
        let output = self
            .shell
            .execute_shell_with_options(
                &args,
                ctx,
                ShellExecuteOptions {
                    structured_command_approved: true,
                    force_read_only: true,
                    allow_git_metadata_write: false,
                },
            )
            .await?;
        if let Some(error) = shell_output_failed(&output) {
            return Err(error);
        }
        Ok(json!({
            "action": "diff",
            "staged": staged,
            "paths": paths.unwrap_or_default(),
            "root_id": output.get("root_id").cloned().unwrap_or(Value::Null),
            "diff": output.get("stdout").cloned().unwrap_or(Value::Null),
            "stdout_truncated": output
                .get("stdout_truncated")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        }))
    }

    async fn execute_git_log(
        &self,
        arguments: &Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        ensure_allowed_keys(arguments, &["limit"])?;
        let limit = match arguments.get("limit") {
            None | Some(Value::Null) => DEFAULT_LOG_LIMIT,
            Some(value) => {
                let raw = value
                    .as_u64()
                    .ok_or_else(|| invalid_argument("limit", "expected an integer"))?;
                let limit = u32::try_from(raw)
                    .map_err(|_| invalid_argument("limit", "must be between 1 and 100"))?;
                if !(1..=MAX_LOG_LIMIT).contains(&limit) {
                    return Err(invalid_argument("limit", "must be between 1 and 100"));
                }
                limit
            }
        };
        let output = self
            .run_git(build_git_log_command(limit), false, ctx)
            .await?;
        if let Some(error) = shell_output_failed(&output) {
            return Err(error);
        }
        Ok(json!({
            "action": "log",
            "limit": limit,
            "root_id": output.get("root_id").cloned().unwrap_or(Value::Null),
            "log": output.get("stdout").cloned().unwrap_or(Value::Null),
        }))
    }

    async fn execute_git_branch(
        &self,
        arguments: &Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        ensure_allowed_keys(arguments, &["action", "name"])?;
        let action = arguments
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid_argument("action", "field is required and must be a string"))?;
        match action {
            "list" => {
                let output = self
                    .run_git(build_git_branch_list_command(), false, ctx)
                    .await?;
                if let Some(error) = shell_output_failed(&output) {
                    return Err(error);
                }
                Ok(json!({
                    "action": "list",
                    "root_id": output.get("root_id").cloned().unwrap_or(Value::Null),
                    "branches": output.get("stdout").cloned().unwrap_or(Value::Null),
                }))
            }
            "create" | "switch" | "delete" => {
                let name = arguments
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        invalid_argument("name", "field is required for create/switch/delete")
                    })?;
                let name = validate_branch_name(name)?;
                let command = match action {
                    "create" => build_git_branch_create_command(&name),
                    "switch" => build_git_branch_switch_command(&name),
                    _ => build_git_branch_delete_command(&name),
                };
                let output = self.run_git(command, true, ctx).await?;
                if let Some(error) = shell_output_failed(&output) {
                    return Err(error);
                }
                Ok(json!({
                    "action": action,
                    "name": name,
                    "root_id": output.get("root_id").cloned().unwrap_or(Value::Null),
                    "stdout": output.get("stdout").cloned().unwrap_or(Value::Null),
                    "stderr": output.get("stderr").cloned().unwrap_or(Value::Null),
                    "file_change_summary": output.get("file_change_summary").cloned().unwrap_or(Value::Null),
                    "change_set": output.get("change_set").cloned().unwrap_or(Value::Null),
                    "change_set_complete": output.get("change_set_complete").cloned().unwrap_or(Value::Null),
                    "change_set_error": output.get("change_set_error").cloned().unwrap_or(Value::Null),
                }))
            }
            other => Err(invalid_argument(
                "action",
                format!("unknown action '{other}'; expected one of list/create/switch/delete"),
            )),
        }
    }

    async fn execute_git_commit(
        &self,
        arguments: &Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Result<Value, GitToolFailure> {
        ensure_allowed_keys(arguments, &["message", "paths"]).map_err(GitToolFailure::plain)?;
        let message = arguments
            .get("message")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                GitToolFailure::plain(invalid_argument(
                    "message",
                    "field is required and must be a string",
                ))
            })?;
        let message = message.trim();
        if message.is_empty() {
            return Err(GitToolFailure::plain(invalid_argument(
                "message",
                "must not be blank",
            )));
        }
        if message.chars().count() > MAX_MESSAGE_CHARS {
            return Err(GitToolFailure::plain(invalid_argument(
                "message",
                format!("must contain at most {MAX_MESSAGE_CHARS} characters"),
            )));
        }
        let paths = optional_paths(arguments, true)
            .map_err(GitToolFailure::plain)?
            .expect("required paths validated");

        // 固定两段式：git add -- <paths> 成功后 git commit -m <message>。
        // 不拼 `&&` 复合命令的原因见模块头注释。
        let add_output = self
            .run_git(build_git_add_command(&paths), true, ctx)
            .await
            .map_err(GitToolFailure::plain)?;
        if let Some(error) = shell_output_failed(&add_output) {
            return Err(GitToolFailure::with_output(
                format!("git add staged nothing or failed: {error}"),
                json!({
                    "action": "commit",
                    "paths": paths,
                    "add": shell_step_json(&add_output),
                    "commit": Value::Null,
                }),
            ));
        }
        let commit_output = self
            .run_git(build_git_commit_command(message, &paths), true, ctx)
            .await
            .map_err(|error| {
                GitToolFailure::with_output(
                    format!("git add succeeded but git commit could not start: {error}"),
                    json!({
                        "action": "commit",
                        "paths": paths,
                        "add": shell_step_json(&add_output),
                        "commit": Value::Null,
                    }),
                )
            })?;
        if let Some(error) = shell_output_failed(&commit_output) {
            return Err(GitToolFailure::with_output(
                format!("git add succeeded but git commit failed: {error}"),
                json!({
                    "action": "commit",
                    "paths": paths,
                    "add": shell_step_json(&add_output),
                    "commit": shell_step_json(&commit_output),
                }),
            ));
        }
        Ok(json!({
            "action": "commit",
            "paths": paths,
            "root_id": commit_output
                .get("root_id")
                .cloned()
                .unwrap_or(Value::Null),
            "add": shell_step_json(&add_output),
            "commit": shell_step_json(&commit_output),
        }))
    }
}

#[async_trait]
impl ToolExecutor for GitToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            tool_names::GIT_STATUS
                | tool_names::GIT_DIFF
                | tool_names::GIT_LOG
                | tool_names::GIT_BRANCH
                | tool_names::GIT_COMMIT
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result: Result<Value, GitToolFailure> = match arguments_object(&call.arguments) {
            Ok(arguments) => match strip_tool_namespace(&call.name) {
                tool_names::GIT_STATUS => self
                    .execute_git_status(arguments, ctx)
                    .await
                    .map_err(GitToolFailure::plain),
                tool_names::GIT_DIFF => self
                    .execute_git_diff(arguments, ctx)
                    .await
                    .map_err(GitToolFailure::plain),
                tool_names::GIT_LOG => self
                    .execute_git_log(arguments, ctx)
                    .await
                    .map_err(GitToolFailure::plain),
                tool_names::GIT_BRANCH => self
                    .execute_git_branch(arguments, ctx)
                    .await
                    .map_err(GitToolFailure::plain),
                tool_names::GIT_COMMIT => self.execute_git_commit(arguments, ctx).await,
                other => Err(GitToolFailure::plain(format!("Unknown git tool: {other}"))),
            },
            Err(error) => Err(GitToolFailure::plain(error)),
        };
        let duration_ms = started.elapsed().as_millis() as u64;

        let tool_result = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                )
            }
            Err(failure) => {
                ctx.emit_tool_call_error(&failure.message);
                match failure.output {
                    Some(output) => ToolResultInfo::failure_with_output(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        output,
                        failure.message,
                        duration_ms,
                    ),
                    None => ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        failure.message,
                        duration_ms,
                    ),
                }
            }
        };

        if let Err(error) = ctx.save_tool_block(&tool_result) {
            log::warn!("[GitToolExecutor] Failed to persist tool block: {}", error);
        }
        Ok(tool_result)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        // 名称级缺省：git_branch 混合读写，按 High 收口（fail-closed）；
        // 具体调用经 sensitivity_level_for_call 按 action 细分。
        match strip_tool_namespace(tool_name) {
            tool_names::GIT_BRANCH | tool_names::GIT_COMMIT => ToolSensitivity::High,
            _ => ToolSensitivity::Medium,
        }
    }

    fn sensitivity_level_for_call(&self, tool_name: &str, arguments: &Value) -> ToolSensitivity {
        if strip_tool_namespace(tool_name) == tool_names::GIT_BRANCH {
            let action = arguments.get("action").and_then(|v| v.as_str());
            return if action == Some("list") {
                ToolSensitivity::Medium
            } else {
                ToolSensitivity::High
            };
        }
        self.sensitivity_level(tool_name)
    }

    fn has_dynamic_sensitivity(&self, tool_name: &str) -> bool {
        strip_tool_namespace(tool_name) == tool_names::GIT_BRANCH
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        match strip_tool_namespace(tool_name) {
            tool_names::GIT_STATUS | tool_names::GIT_DIFF | tool_names::GIT_LOG => {
                ToolConcurrency::ReadOnly
            }
            _ => ToolConcurrency::Serial,
        }
    }

    fn manages_cancellation(&self, _tool_name: &str) -> bool {
        true
    }

    fn result_char_budget(&self, _tool_name: &str) -> Option<usize> {
        None
    }

    fn name(&self) -> &'static str {
        "GitToolExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_quoting_wraps_and_escapes_single_quotes() {
        assert_eq!(quote_arg_posix("src/main.rs"), "'src/main.rs'");
        assert_eq!(
            quote_arg_posix("dir with spaces/a.rs"),
            "'dir with spaces/a.rs'"
        );
        assert_eq!(quote_arg_posix("it's"), "'it'\\''s'");
        assert_eq!(
            quote_arg_posix("fix: handle 'x' & `y` $(z)"),
            "'fix: handle '\\''x'\\'' & `y` $(z)'"
        );
    }

    #[test]
    fn powershell_quoting_doubles_single_quotes() {
        assert_eq!(quote_arg_powershell("src/main.rs"), "'src/main.rs'");
        assert_eq!(quote_arg_powershell("it's"), "'it''s'");
        assert_eq!(
            quote_arg_powershell("a`b $x; y"),
            "'a`b $x; y'",
            "single-quoted PowerShell strings need no backtick/dollar escaping"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn platform_quoting_is_posix_off_windows() {
        assert_eq!(quote_arg("it's"), quote_arg_posix("it's"));
    }

    #[test]
    fn status_and_branch_list_commands_are_fixed() {
        assert_eq!(
            build_git_status_command(),
            "git --no-pager --no-optional-locks --literal-pathspecs status --porcelain=v1 --branch"
        );
        assert!(build_git_branch_list_command().starts_with(
            "git --no-pager --no-optional-locks --literal-pathspecs branch --format="
        ));
    }

    #[test]
    fn diff_command_supports_staged_and_quoted_paths() {
        assert_eq!(
            build_git_diff_command(false, None),
            "git --no-pager --no-optional-locks --literal-pathspecs diff"
        );
        assert_eq!(
            build_git_diff_command(true, None),
            "git --no-pager --no-optional-locks --literal-pathspecs diff --staged"
        );
        let paths = vec!["src/a b.rs".to_string(), "README.md".to_string()];
        assert_eq!(
            build_git_diff_command(false, Some(&paths)),
            "git --no-pager --no-optional-locks --literal-pathspecs diff -- 'src/a b.rs' 'README.md'"
        );
        assert_eq!(
            build_git_diff_command(true, Some(&paths)),
            "git --no-pager --no-optional-locks --literal-pathspecs diff --staged -- 'src/a b.rs' 'README.md'"
        );
        assert_eq!(
            build_git_diff_command(false, Some(&[])),
            "git --no-pager --no-optional-locks --literal-pathspecs diff",
            "empty path list must not emit a bare --"
        );
    }

    #[test]
    fn log_command_embeds_validated_limit() {
        assert!(build_git_log_command(1).contains("log -n 1"));
        assert!(build_git_log_command(100).contains("log -n 100"));
    }

    #[test]
    fn branch_commands_quote_names_and_delete_uses_safe_dash_d() {
        assert_eq!(
            build_git_branch_create_command("feat/x"),
            "git --no-pager --no-optional-locks --literal-pathspecs branch -- 'feat/x'"
        );
        assert_eq!(
            build_git_branch_switch_command("feat/x"),
            "git --no-pager --no-optional-locks --literal-pathspecs switch -- 'feat/x'"
        );
        assert_eq!(
            build_git_branch_delete_command("feat/x"),
            "git --no-pager --no-optional-locks --literal-pathspecs branch -d -- 'feat/x'"
        );
        for command in [
            build_git_branch_create_command("x"),
            build_git_branch_switch_command("x"),
            build_git_branch_delete_command("x"),
        ] {
            assert!(!command.contains("--force"), "{command}");
            assert!(!command.contains(" -f"), "{command}");
            assert!(!command.contains(" -D"), "{command}");
        }
    }

    #[test]
    fn commit_commands_are_add_then_commit_with_quoted_operands() {
        let paths = vec!["src/a.rs".to_string(), "docs/b.md".to_string()];
        assert_eq!(
            build_git_add_command(&paths),
            "git --no-pager --no-optional-locks --literal-pathspecs add -- 'src/a.rs' 'docs/b.md'"
        );
        assert_eq!(
            build_git_commit_command("fix: it's broken", &paths),
            "git --no-pager --no-optional-locks --literal-pathspecs -c commit.gpgSign=false commit -m 'fix: it'\\''s broken' -- 'src/a.rs' 'docs/b.md'"
        );
    }

    #[test]
    fn paths_must_be_relative_and_non_empty() {
        for bad in ["", "/abs/path", "../up", "a/../../b", "-m", "--force"] {
            assert!(
                validate_repo_relative_path(bad).is_err(),
                "must reject: {bad:?}"
            );
        }
        for good in ["src/a.rs", "a b/c.md", ".hidden/file"] {
            assert!(
                validate_repo_relative_path(good).is_ok(),
                "must accept: {good:?}"
            );
        }
    }

    #[test]
    fn commit_requires_non_empty_paths() {
        let args = json!({ "message": "m" });
        let map = arguments_object(&args).unwrap();
        assert!(optional_paths(map, true).is_err());

        let args = json!({ "message": "m", "paths": [] });
        let map = arguments_object(&args).unwrap();
        assert!(optional_paths(map, true).is_err());

        let args = json!({ "paths": ["src/a.rs"] });
        let map = arguments_object(&args).unwrap();
        assert_eq!(
            optional_paths(map, true).unwrap(),
            Some(vec!["src/a.rs".to_string()])
        );
    }

    #[test]
    fn diff_paths_are_optional_but_still_validated() {
        let args = json!({});
        let map = arguments_object(&args).unwrap();
        assert_eq!(optional_paths(map, false).unwrap(), None);

        let args = json!({ "paths": ["../escape"] });
        let map = arguments_object(&args).unwrap();
        assert!(optional_paths(map, false).is_err());
    }

    #[test]
    fn branch_names_reject_option_injection_and_whitespace() {
        for bad in ["", "-D", "--force", "feat x", "a..b", "a\nb"] {
            assert!(validate_branch_name(bad).is_err(), "must reject: {bad:?}");
        }
        for good in ["main", "feat/x-y", "release_2026.09"] {
            assert!(validate_branch_name(good).is_ok(), "must accept: {good:?}");
        }
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let args = json!({ "command": "git push" });
        let map = arguments_object(&args).unwrap();
        assert!(ensure_allowed_keys(map, &["root_id"]).is_err());
    }

    #[test]
    fn sensitivity_matrix_matches_read_medium_write_high() {
        let executor = GitToolExecutor::new();
        for tool in [
            "git_status",
            "builtin-git_status",
            "git_diff",
            "mcp_git_diff",
            "git_log",
        ] {
            assert_eq!(
                executor.sensitivity_level(tool),
                ToolSensitivity::Medium,
                "{tool} must be Medium"
            );
            assert_eq!(
                executor.sensitivity_level_for_call(tool, &json!({})),
                ToolSensitivity::Medium,
                "{tool} must stay Medium per call"
            );
        }
        assert_eq!(
            executor.sensitivity_level("builtin-git_commit"),
            ToolSensitivity::High
        );
        // git_branch 名称级 High（fail-closed），list 按调用降为 Medium
        assert_eq!(
            executor.sensitivity_level("builtin-git_branch"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level_for_call("builtin-git_branch", &json!({"action": "list"})),
            ToolSensitivity::Medium
        );
        for action in ["create", "switch", "delete"] {
            assert_eq!(
                executor
                    .sensitivity_level_for_call("builtin-git_branch", &json!({ "action": action })),
                ToolSensitivity::High,
                "branch {action} must be High"
            );
        }
        // 缺 action 的调用保持 fail-closed High
        assert_eq!(
            executor.sensitivity_level_for_call("builtin-git_branch", &json!({})),
            ToolSensitivity::High
        );
        assert!(executor.has_dynamic_sensitivity("builtin-git_branch"));
        assert!(!executor.has_dynamic_sensitivity("builtin-git_commit"));
    }

    #[test]
    fn concurrency_is_readonly_for_reads_and_serial_for_writes() {
        let executor = GitToolExecutor::new();
        for tool in ["git_status", "git_diff", "git_log"] {
            assert_eq!(
                executor.concurrency_class(tool),
                ToolConcurrency::ReadOnly,
                "{tool} must be ReadOnly"
            );
        }
        for tool in ["git_branch", "git_commit"] {
            assert_eq!(
                executor.concurrency_class(tool),
                ToolConcurrency::Serial,
                "{tool} must be Serial"
            );
        }
    }

    #[test]
    fn can_handle_matches_all_five_tools_with_any_namespace() {
        let executor = GitToolExecutor::new();
        for tool in [
            "git_status",
            "builtin-git_status",
            "mcp_git_diff",
            "git_log",
            "builtin-git_branch",
            "git_commit",
        ] {
            assert!(executor.can_handle(tool), "must handle {tool}");
        }
        for tool in ["git_push", "git_reset", "local_shell_execute", "git"] {
            assert!(!executor.can_handle(tool), "must not handle {tool}");
        }
    }
}
