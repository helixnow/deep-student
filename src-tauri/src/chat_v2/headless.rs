//! Chat V2 Headless Runner：后端自主发起 agent turn 的执行基建
//!
//! 让 automations 调度器（或其他后端入口）在**没有前端 WebView 参与**的情况下
//! 跑完整的 agent turn（检索 → LLM 流式 → 工具循环 → 落库）。
//!
//! ## 核心设计（参考成熟代理运行时的 cron/heartbeat 与"工具策略预过滤"）
//!
//! 1. **复用现有管线**：构建 `SendMessageRequest` → 经 `handlers::send_message::
//!    run_send_message_pipeline`（StreamGuard + `ChatV2Pipeline::execute`）执行，
//!    事件照常经 Window emit（无前端监听也无害），全部块照常落库，用户之后打开
//!    会话能看到完整过程。
//! 2. **工具集 fail-closed（双层防线）**：
//!    - Schema 层：只注入 `headless_tool_schemas()` 白名单工具的 schema，
//!      依赖前端 WebView 往返的工具（MCP 桥 / ask_user / 前端 CardAgent 桥 /
//!      subagent 拉起等）模型根本看不见；
//!    - 执行层：后端专用的 `SendOptions.execution_allowed_tools` 设为同一份白名单，
//!      tool_loop 在审批/执行**之前**就拦截白名单外的调用并返回明确失败回喂模型，
//!      不会挂起等待任何人工输入。
//! 3. **审批策略**：headless 无人审批。白名单仅收录 Low 敏感度工具
//!    （由单元测试 `all_whitelisted_tools_are_low_sensitivity` 守护），
//!    Medium/High 工具不在白名单内 → 调用被直接拒绝（等效"需人工授权"），
//!    绝不进入审批等待。唯一例外是 **trusted automation 预授权**：会话安装了
//!    经哈希校验的 `TrustedAutomationProfile` 且工具调用通过
//!    `validate_trusted_automation_tool_call` 全部校验时，
//!    `is_trusted_automation_preauthorized` 允许 tool_loop 跳过 ApprovalManager
//!    （fail-closed：任何校验失败/异常都回到人工审批路径）。
//! 4. **超时与预算**：整个 turn 有硬超时（默认 10 分钟，可配），超时后先
//!    触发 CancellationToken 让管线走取消保存路径，再限时等待收尾；
//!    工具轮次上限默认 15（`max_tool_recursion`）。管线 future 全程包在
//!    `catch_unwind` 中：单次 run 的 panic 被隔离为 error 结果回传调用方，
//!    不会沿 spawn 边界拖垮自动化调度器。
//! 5. **会话模式**（采用成熟代理运行时的 cron 的 isolated / session:custom-id）：
//!    - `isolated`：每次新建会话，metadata 标记 `automation_run=true`；
//!    - `named`：复用固定会话，跨运行积累上下文（如"每周学情报告"）。
//!
//! ## 入口
//!
//! - `run_headless_turn(app, HeadlessTurnRequest)`：主入口，负责会话模式
//!   （isolated/named）解析、管线执行与结果摘要；automations 调度器与
//!   手动触发命令均走此入口；
//! - `run_headless_agent_turn(&app, HeadlessSessionTurn)`：低层入口，
//!   供已自管会话 ID 的调用方使用（返回未截断的最终回复全文）。

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use futures::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Window};
use tokio_util::sync::CancellationToken;

use super::automations::{
    trusted_profile_write_tool, AutomationRootAccess, TrustedAutomationProfile,
};
use super::database::ChatV2Database;
use super::error::{ChatV2Error, ChatV2Result};
use super::pipeline::ChatV2Pipeline;
use super::repo::ChatV2Repo;
use super::state::ChatV2State;
use super::tools::attempt_completion::is_attempt_completion;
use super::types::{
    block_status, ChatMessage, ChatSession, McpToolSchema, MessageBlock, PersistStatus,
    SendMessageRequest, SendOptions,
};

static TRUSTED_AUTOMATION_SESSIONS: LazyLock<StdMutex<HashMap<String, TrustedAutomationProfile>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

struct TrustedAutomationSessionGuard {
    session_id: String,
}

impl TrustedAutomationSessionGuard {
    fn install(session_id: &str, profile: Option<&TrustedAutomationProfile>) -> Option<Self> {
        let profile = profile?.clone();
        let replaced = TRUSTED_AUTOMATION_SESSIONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session_id.to_string(), profile);
        if let Some(previous) = replaced {
            // 不应发生：安装发生在会话流原子注册之后，同会话不可能有并发 run。
            // 一旦出现说明上游排他性被破坏，记录以便追查（fail-loud）。
            log::error!(
                "[ChatV2::headless] trusted profile install OVERWROTE existing profile: session={}, previous_hash={}",
                session_id,
                previous.profile_hash
            );
        }
        Some(Self {
            session_id: session_id.to_string(),
        })
    }
}

impl Drop for TrustedAutomationSessionGuard {
    fn drop(&mut self) {
        TRUSTED_AUTOMATION_SESSIONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.session_id);
    }
}

fn command_matches_prefix(command: &str, prefix: &str) -> bool {
    command == prefix
        || command
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.chars().next().is_some_and(char::is_whitespace))
}

fn domain_allowed(host: &str, allowed: &[String]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    allowed.iter().any(|domain| {
        domain
            .strip_prefix("*.")
            .map_or(host == domain.as_str(), |suffix| {
                host != suffix && host.ends_with(&format!(".{suffix}"))
            })
    })
}

fn command_network_hosts(command: &str) -> Vec<String> {
    command
        .split_whitespace()
        .filter_map(|token| {
            let token = token.trim_matches(|ch: char| matches!(ch, '\'' | '"' | ',' | ')' | '('));
            url::Url::parse(token)
                .ok()
                .and_then(|url| url.host_str().map(str::to_string))
        })
        .collect()
}

fn collect_explicit_network_hosts(value: &Value, hosts: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                let normalized = key.to_ascii_lowercase();
                if matches!(
                    normalized.as_str(),
                    "url" | "uri" | "host" | "hostname" | "domain"
                ) {
                    if let Some(raw) = value.as_str() {
                        if let Ok(url) = url::Url::parse(raw) {
                            if let Some(host) = url.host_str() {
                                hosts.push(host.to_string());
                            }
                        } else if !raw.contains('/') && !raw.chars().any(char::is_whitespace) {
                            hosts.push(raw.to_string());
                        }
                    }
                }
                collect_explicit_network_hosts(value, hosts);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_explicit_network_hosts(value, hosts);
            }
        }
        _ => {}
    }
}

pub fn validate_trusted_automation_tool_call(
    session_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> Result<(), String> {
    let profile = TRUSTED_AUTOMATION_SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .cloned();
    let Some(profile) = profile else {
        return Ok(());
    };
    let canonical = if tool_name.starts_with("builtin-") {
        tool_name.to_string()
    } else {
        format!("builtin-{tool_name}")
    };
    if !is_headless_allowed_tool(&canonical) && !profile.allowed_tools.contains(&canonical) {
        return Err(format!(
            "Tool '{tool_name}' is not allowed by the trusted automation profile"
        ));
    }

    let mut explicit_hosts = Vec::new();
    collect_explicit_network_hosts(arguments, &mut explicit_hosts);
    if explicit_hosts
        .iter()
        .any(|host| !domain_allowed(host, &profile.network_domains))
    {
        return Err("Explicit network target is outside trusted-profile domains".to_string());
    }

    let short = canonical.strip_prefix("builtin-").unwrap_or(&canonical);
    if short.starts_with("workspace_")
        || matches!(short, "local_shell_execute" | "local_shell_preflight")
    {
        let root_id = arguments
            .get("root_id")
            .or_else(|| arguments.get("rootId"))
            .and_then(Value::as_str)
            .or_else(|| {
                arguments
                    .get("receipt")
                    .and_then(|receipt| receipt.get("root_id").or_else(|| receipt.get("rootId")))
                    .and_then(Value::as_str)
            })
            .ok_or_else(|| {
                "Trusted automation runtime tools require explicit root_id".to_string()
            })?;
        let root = profile
            .runtime_roots
            .iter()
            .find(|root| root.root_id == root_id)
            .ok_or_else(|| {
                format!("Runtime root '{root_id}' is not allowed by the trusted profile")
            })?;
        if trusted_profile_write_tool(&canonical) && root.access != AutomationRootAccess::ReadWrite
        {
            return Err(format!(
                "Runtime root '{root_id}' is read-only in the trusted profile"
            ));
        }
    }

    if matches!(short, "local_shell_execute" | "local_shell_preflight") {
        let command = arguments
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| "Trusted automation shell calls require command".to_string())?;
        if !profile
            .shell_command_prefixes
            .iter()
            .any(|prefix| command_matches_prefix(command, prefix))
        {
            return Err(
                "Shell command does not match an approved trusted-profile prefix".to_string(),
            );
        }
        let analysis = super::approval_scope::analyze_shell_command(command);
        if analysis.has_shell_operators || analysis.uses_script_runner {
            return Err(
                "Trusted automation shell commands cannot use shell operators or script runners"
                    .to_string(),
            );
        }
        if analysis.write_capable
            && profile.rollback_required
            && arguments.get("track_file_changes").and_then(Value::as_bool) != Some(true)
        {
            return Err(
                "Write-capable trusted automation shell calls require track_file_changes=true"
                    .to_string(),
            );
        }
        if analysis.network_capable {
            if arguments.get("allow_network").and_then(Value::as_bool) != Some(true) {
                return Err("Network-capable shell call requires allow_network=true".to_string());
            }
            let hosts = command_network_hosts(command);
            if hosts.is_empty()
                || hosts
                    .iter()
                    .any(|host| !domain_allowed(host, &profile.network_domains))
            {
                return Err(
                    "Shell network target is absent or outside trusted-profile domains".to_string(),
                );
            }
        }
        let requested_output = arguments
            .get("max_output_bytes")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                "Trusted automation shell calls require explicit max_output_bytes".to_string()
            })?;
        if requested_output > profile.max_output_bytes {
            return Err("Shell max_output_bytes exceeds trusted-profile limit".to_string());
        }
    }
    if short == "workspace_file_read" {
        let max_bytes = arguments
            .get("max_bytes")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                "Trusted automation workspace reads require explicit max_bytes".to_string()
            })?;
        if max_bytes > profile.max_output_bytes {
            return Err("workspace_file_read max_bytes exceeds trusted-profile limit".to_string());
        }
    }
    Ok(())
}

/// rollback_required 语义下，判断某个 trusted 写工具是否有**代码层已实现**的
/// 回滚机制可用（宁可保守：无法确认回滚可用 → 返回 false → 回到人工审批）。
///
/// 现有回滚基建（workspace_change_set.rs + workspace_fs_executor.rs）：
/// - `workspace_file_write` / `workspace_file_move` / `workspace_file_delete` /
///   `workspace_artifact_write`：执行时强制生成 `MutationReceipt` / `ChangeSet`，
///   可经 `workspace_change_revert` 回滚 → 回滚可用；
/// - `workspace_change_revert`：本身就是回滚工具 → 可用；
/// - `local_shell_execute`：仅当 `track_file_changes=true` 时执行器做
///   前后快照并捕获 workspace change set → 可用；否则不可回滚；
/// - 其余写工具（如 `attachment_stage`）当前没有已实现的回滚路径 → 不可用。
fn trusted_write_tool_rollback_available(short_name: &str, arguments: &Value) -> bool {
    match short_name {
        "workspace_file_write"
        | "workspace_file_move"
        | "workspace_file_delete"
        | "workspace_artifact_write"
        | "workspace_change_revert" => true,
        "local_shell_execute" => {
            arguments.get("track_file_changes").and_then(Value::as_bool) == Some(true)
        }
        _ => false,
    }
}

/// trusted automation 预授权判定：tool_loop 在 ApprovalManager 前调用，
/// 返回 `true` 表示该调用已被 pinned profile 完整预授权，可跳过人工审批。
///
/// 安全论证（fail-closed，任何一条不满足即返回 `false` → 走人工审批）：
/// 1. 会话必须安装了 `TrustedAutomationSessionGuard`（即 profile 经
///    `TrustedAutomationProfile::validate()` 哈希校验后被 headless runner
///    显式安装；普通交互会话查不到 profile，永远不会被预授权）；
/// 2. 工具必须在 profile 的 `allowed_tools` 白名单内（canonical 名比对；
///    headless 只读白名单工具是 Low 敏感度，本就不会进 ApprovalManager，
///    因此这里**不**为它们放行，保持预授权面最小化）；
/// 3. 调用参数必须重新通过 `validate_trusted_automation_tool_call` 的全部
///    校验（root 读写、shell 前缀/操作符、网络域、输出预算、回滚证据），
///    校验返回 `Err` 一律不预授权；
/// 4. `rollback_required` 的 profile：写工具还须确认代码层回滚机制可用
///    （见 `trusted_write_tool_rollback_available`），确认不了则 `warn`
///    并回到人工审批——宁可保守。
///
/// 该函数只读全局会话表和入参，不落库、不发事件；异常路径（锁中毒等）
/// 由 `unwrap_or_else(into_inner)` 恢复后仍按上述规则判定。
pub fn is_trusted_automation_preauthorized(
    session_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> bool {
    let profile = TRUSTED_AUTOMATION_SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .cloned();
    // fail-closed：没有安装 trusted profile 的会话一律不预授权
    let Some(profile) = profile else {
        return false;
    };

    let canonical = if tool_name.starts_with("builtin-") {
        tool_name.to_string()
    } else {
        format!("builtin-{tool_name}")
    };
    // 预授权面最小化：只对 profile 显式列出的工具生效
    if !profile.allowed_tools.contains(&canonical) {
        return false;
    }

    // 全量重放 profile 校验（白名单、root 读写、shell 前缀、网络域、输出预算）
    if let Err(error) = validate_trusted_automation_tool_call(session_id, tool_name, arguments) {
        log::warn!(
            "[ChatV2::headless] trusted automation preauthorization denied: session={}, tool={}, reason={}",
            session_id,
            tool_name,
            error
        );
        return false;
    }

    // rollback_required：写工具必须确认回滚机制在代码层可用，否则保守回退审批
    let short = canonical.strip_prefix("builtin-").unwrap_or(&canonical);
    if profile.rollback_required
        && trusted_profile_write_tool(&canonical)
        && !trusted_write_tool_rollback_available(short, arguments)
    {
        log::warn!(
            "[ChatV2::headless] trusted automation write tool '{}' has no verified rollback path; \
             falling back to manual approval (session={}, rollback_required=true)",
            tool_name,
            session_id
        );
        return false;
    }

    log::info!(
        "[ChatV2::headless] trusted_automation_preauthorized: session={}, tool={}, profile_hash={}",
        session_id,
        tool_name,
        profile.profile_hash
    );
    true
}

// ============================================================================
// 常量与默认配置
// ============================================================================

/// headless turn 硬超时默认值（秒）
pub const DEFAULT_HARD_TIMEOUT_SECS: u64 = 600;
/// headless turn 硬超时上限（秒），防止配置过大导致后台任务失控
pub const MAX_HARD_TIMEOUT_SECS: u64 = 3600;
/// 超时取消后给管线保存部分结果的收尾窗口（秒）
pub const CANCEL_GRACE_SECS: u64 = 30;
/// 长时间运行的 headless turn 周期性进度日志间隔（秒）
const PROGRESS_LOG_INTERVAL_SECS: u64 = 60;
/// 工具轮次上限默认值（取较小值，headless 不做长程任务）
pub const DEFAULT_MAX_TOOL_ROUNDS: u32 = 15;
/// 工具轮次上限硬顶
pub const MAX_TOOL_ROUNDS_CAP: u32 = 30;
/// 结果摘要最大字符数
const SUMMARY_MAX_CHARS: usize = 200;

/// 全局配置键：允许用户在设置里覆盖 headless 默认超时/轮次
pub const SETTING_HEADLESS_TIMEOUT_SECS: &str = "chat_v2.headless.timeout_secs";
pub const SETTING_HEADLESS_MAX_TOOL_ROUNDS: &str = "chat_v2.headless.max_tool_rounds";

// ============================================================================
// 工具策略：黑名单（文档口径）与白名单（实际执行口径）
// ============================================================================

/// headless 模式明确禁用的工具（"需要人或前端在场"的全集，按依赖类型分组）。
///
/// 该清单是**文档与测试口径**；实际 fail-closed 由 `headless_allowed_tools()`
/// 白名单实现——任何不在白名单内的工具（包括本清单未穷举的未来工具与全部
/// MCP 动态工具）都会在执行前被拦截。
///
/// 依赖类型说明：
/// - `frontend-bridge`：经 window 事件桥回前端执行（MCP 工具 / 前端 CardAgent）
/// - `human-in-loop`：阻塞等待用户输入（ask_user）
/// - `frontend-driven`：由前端监听事件拉起执行（subagent / workspace worker）
/// - `write-risk`：Medium/High 敏感度，headless 无人审批一律拒绝
pub const HEADLESS_BLOCKED_TOOLS: &[(&str, &str)] = &[
    // —— frontend-bridge：GeneralToolExecutor → ToolRegistry::call_frontend_mcp_tool
    //    经 `mcp-bridge-request` window 事件回前端执行，无 WebView 必死
    ("mcp_*", "frontend-bridge"),
    // —— frontend-bridge：旧 CardForge 前端 CardAgent 桥。执行器
    //    （anki_executor.rs）与前端监听均已删除（2026-08 死链路清理），
    //    此处防御性保留拦截，防止历史会话/外部注入的同名工具调用挂起
    ("anki_generate_cards", "frontend-bridge"),
    // —— human-in-loop：oneshot channel 永久等待用户回答，headless 必挂起
    ("ask_user", "human-in-loop"),
    // —— frontend-driven：workspace_worker_ready 事件由前端拉起子代理会话
    ("subagent_call", "frontend-driven"),
    ("workspace_create", "frontend-driven"),
    ("workspace_create_agent", "frontend-driven"),
    ("workspace_send", "frontend-driven"),
    ("workspace_query", "frontend-driven"),
    ("workspace_set_context", "frontend-driven"),
    ("workspace_get_context", "frontend-driven"),
    ("workspace_update_document", "frontend-driven"),
    ("workspace_read_document", "frontend-driven"),
    ("coordinator_sleep", "frontend-driven"),
    // —— write-risk：High/Medium 敏感度，headless 无人审批
    ("local_shell_execute", "write-risk"),
    ("runtime_root_request", "write-risk"),
    ("mcp_server_propose", "write-risk"),
    ("mcp_server_update", "write-risk"),
    ("mcp_server_set_enabled", "write-risk"),
    ("mcp_server_remove", "write-risk"),
    ("skill_install", "write-risk"),
    ("skill_workshop_propose", "write-risk"),
    ("skill_workshop_apply", "write-risk"),
    ("skill_set_enabled", "write-risk"),
    ("skill_remove", "write-risk"),
    ("skill_trust_request", "write-risk"),
    ("custom_agent_propose", "write-risk"),
    ("custom_agent_apply", "write-risk"),
    ("custom_agent_remove", "write-risk"),
    ("automation_propose", "write-risk"),
    ("automation_set_enabled", "write-risk"),
    ("automation_update", "write-risk"),
    ("automation_delete", "write-risk"),
    ("automation_run_now", "write-risk"),
    ("settings_set", "write-risk"),
    ("model_assignments_set", "write-risk"),
    ("backup_create", "write-risk"),
    ("sync_run", "write-risk"),
    ("index_rebuild", "write-risk"),
    ("webpage_save", "write-risk"),
    ("user_todo_create_item", "write-risk"),
    ("user_todo_complete_item", "write-risk"),
    ("user_todo_update_item", "write-risk"),
    ("user_todo_delete_item", "write-risk"),
    ("user_todo_create_list", "write-risk"),
    ("user_todo_update_list", "write-risk"),
    ("user_todo_delete_list", "write-risk"),
    ("user_todo_restore", "write-risk"),
    ("user_todo_reorder", "write-risk"),
    ("memory_write", "write-risk"),
    ("memory_write_smart", "write-risk"),
    ("memory_write_batch", "write-risk"),
    ("memory_update_by_id", "write-risk"),
    ("memory_delete", "write-risk"),
    ("qbank_reset_progress", "write-risk"),
    ("qbank_export", "write-risk"),
    ("qbank_delete_questions", "write-risk"),
    ("attachment_stage", "write-risk"),
    ("paper_save", "write-risk"),
    ("mindmap_delete", "write-risk"),
    ("review_suspend", "write-risk"),
    ("review_resume", "write-risk"),
    ("review_delete", "write-risk"),
    ("dstu_folder_create", "write-risk"),
    ("dstu_folder_rename", "write-risk"),
    ("dstu_rename", "write-risk"),
    ("dstu_move", "write-risk"),
    ("dstu_delete", "write-risk"),
    ("dstu_restore", "write-risk"),
    ("dstu_set_favorite", "write-risk"),
    ("dstu_purge", "write-risk"),
    ("dstu_upload_file", "write-risk"),
    // —— 绕过风险：tool_pack 会展开执行子工具，可能绕过白名单逐项检查
    ("tool_pack", "write-risk"),
];

/// headless 白名单：允许模型看见并执行的工具全集。
///
/// 收录原则（缺一不可）：
/// 1. 纯后端执行，不依赖前端 WebView 往返；
/// 2. 敏感度为 Low（无人审批下可自动执行）；
/// 3. 对学情简报 / 复习提醒等 automation 场景有实际价值。
pub fn headless_allowed_tools() -> Vec<String> {
    [
        // Agent 元工具（todo_* 经 schema_tool_ids 注入；attempt_completion 是
        // control tool 本就绕过白名单，列入仅为语义完整）
        "attempt_completion",
        "todo_init",
        "todo_update",
        "todo_add",
        "todo_get",
        // 检索（BuiltinRetrievalExecutor / FetchExecutor，Low）
        "builtin-unified_search",
        "builtin-rag_search",
        "builtin-web_search",
        "builtin-web_fetch",
        // 系统观测（阶段七，只读 Low；所有写入仍在 blocked 清单）
        "builtin-settings_get",
        "builtin-model_assignments_get",
        "builtin-llm_usage_query",
        "builtin-backup_status",
        "builtin-backup_job_status",
        "builtin-sync_status",
        // VFS index diagnosis is read-only; rebuild/archive remain blocked.
        "builtin-index_status",
        // 学习概览与番茄钟统计（阶段十，只读 Low）
        "builtin-learning_overview",
        "builtin-pomodoro_today_stats",
        "builtin-pomodoro_daily_stats",
        // 记忆只读面（无人值守不得修改用户长期记忆）
        "builtin-memory_read",
        "builtin-memory_list",
        // VFS 学习资源（BuiltinResourceExecutor，只读，Low）
        "builtin-resource_list",
        "builtin-resource_read",
        "builtin-resource_search",
        "builtin-folder_list",
        "builtin-dstu_list_trash",
        // 用户待办只读面（无人值守不得修改用户真实待办）
        "builtin-user_todo_list_lists",
        "builtin-user_todo_list_items",
        "builtin-user_todo_get_summary",
        "builtin-user_todo_search",
        "builtin-user_todo_list_trash",
        // 题库只读（QBankExecutor，Low）——到期复习卡 / 学情统计
        "builtin-qbank_list",
        "builtin-qbank_list_questions",
        "builtin-qbank_get_question",
        "builtin-qbank_get_stats",
        "builtin-qbank_get_next_question",
        // 复习计划只读（ReviewToolExecutor，Low；schedule/plan_generate 为
        // Medium 不收录）——heartbeat "检查今天到期复习" 场景
        "builtin-review_get_due",
        "builtin-review_stats",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// 白名单的 O(1) 查找缓存（白名单是编译期常量集合，进程内不变）。
static HEADLESS_ALLOWED_TOOL_SET: LazyLock<HashSet<String>> =
    LazyLock::new(|| headless_allowed_tools().into_iter().collect());

/// 判断某工具是否允许出现在 headless 上下文（schema 注入前的预过滤）。
pub fn is_headless_allowed_tool(tool_name: &str) -> bool {
    HEADLESS_ALLOWED_TOOL_SET.contains(tool_name)
}

/// fail-closed 预过滤：从任意 schema 列表中剔除不在白名单内的工具。
///
/// 参考成熟代理运行时的"工具策略预过滤"：被禁工具的 schema 不进入模型上下文，
/// 模型根本看不见，从源头消除误调用。
pub fn filter_headless_tool_schemas(schemas: Vec<McpToolSchema>) -> Vec<McpToolSchema> {
    schemas
        .into_iter()
        .filter(|schema| {
            let keep = is_headless_allowed_tool(&schema.name);
            if !keep {
                log::warn!(
                    "[ChatV2::headless] 工具 '{}' 不在 headless 白名单内，schema 已剔除（fail-closed）",
                    schema.name
                );
            }
            keep
        })
        .collect()
}

/// headless 内置工具 schema 集（白名单工具的 LLM 可见定义）。
///
/// 说明：正常聊天路径的 builtin 工具 schema 由前端 Skills 体系随请求传入；
/// headless 无前端在场，因此在后端维护一份**白名单子集**的精简 schema，
/// 字段语义与前端 `src/features/chat/skills/builtin-tools/` 对应定义保持一致。
pub fn headless_tool_schemas() -> Vec<McpToolSchema> {
    fn tool(name: &str, description: &str, input_schema: Value) -> McpToolSchema {
        McpToolSchema {
            name: name.to_string(),
            server_id: None,
            description: Some(description.to_string()),
            input_schema: Some(input_schema),
        }
    }

    let schemas = vec![
        tool(
            "builtin-unified_search",
            "统一搜索：同时搜索知识库文档、图片/PDF、用户记忆，合并返回最相关结果。默认首选搜索工具。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "【必填】搜索查询文本" },
                    "top_k": { "type": "integer", "description": "每种搜索源返回的最大结果数，默认 10", "default": 10, "minimum": 1, "maximum": 30 },
                    "enable_reranking": { "type": "boolean", "description": "是否启用重排序，默认启用", "default": true }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "builtin-rag_search",
            "在本地知识库中检索相关文档片段。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "【必填】搜索查询文本" },
                    "top_k": { "type": "integer", "description": "返回结果数量，默认 10", "default": 10, "minimum": 1, "maximum": 30 }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "builtin-web_search",
            "搜索互联网获取最新信息。当本地知识库没有答案或需要实时信息时使用。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "【必填】搜索查询文本" },
                    "top_k": { "type": "integer", "description": "返回结果数量，默认 5", "default": 5, "minimum": 1, "maximum": 20 }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "builtin-web_fetch",
            "抓取并解析指定网页的内容。",
            json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "【必填】要抓取的网页 URL" }
                },
                "required": ["url"]
            }),
        ),
        tool(
            "builtin-memory_read",
            "读取指定记忆的完整内容。note_id 从 unified_search 的记忆结果或 memory_list 获取。",
            json!({
                "type": "object",
                "properties": {
                    "note_id": { "type": "string", "description": "【必填】记忆笔记 ID" }
                },
                "required": ["note_id"]
            }),
        ),
        tool(
            "builtin-memory_list",
            "列出记忆目录结构和笔记列表。返回笔记 ID、标题、文件夹路径和更新时间。",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "folder": { "type": "string", "description": "相对于记忆根目录的文件夹路径，留空表示根目录" },
                    "limit": { "type": "integer", "description": "返回数量限制，默认及最多 20", "default": 20, "minimum": 1, "maximum": 20 },
                    "offset": { "type": "integer", "description": "分页偏移量，默认 0", "default": 0, "minimum": 0 }
                }
            }),
        ),
        tool(
            "builtin-resource_list",
            "列出用户的学习资源。可按类型（笔记、教材、整卷、作文、翻译、知识导图）和文件夹筛选。",
            json!({
                "type": "object",
                "properties": {
                    "type": { "type": "string", "enum": ["note", "textbook", "file", "image", "exam", "essay", "translation", "mindmap", "all"], "default": "all", "description": "资源类型" },
                    "folder_id": { "type": "string", "description": "可选：文件夹 ID" },
                    "search": { "type": "string", "description": "可选：按标题/名称过滤的关键词" },
                    "limit": { "type": "integer", "default": 20, "minimum": 1, "maximum": 100, "description": "返回数量限制" }
                }
            }),
        ),
        tool(
            "builtin-resource_read",
            "读取指定学习资源的内容。resource_id 用 DSTU 格式 ID（note_xxx / tb_xxx 等）。多页文档支持 page_start/page_end 按页读取。",
            json!({
                "type": "object",
                "properties": {
                    "resource_id": { "type": "string", "description": "【必填】资源 ID（DSTU 格式）" },
                    "include_metadata": { "type": "boolean", "description": "是否包含元数据，默认 true" },
                    "page_start": { "type": "integer", "minimum": 1, "description": "可选：起始页码（1-based）" },
                    "page_end": { "type": "integer", "minimum": 1, "description": "可选：结束页码（含）" }
                },
                "required": ["resource_id"]
            }),
        ),
        tool(
            "builtin-resource_search",
            "在学习资源中全文搜索，返回匹配的资源列表和相关片段。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "【必填】搜索关键词" },
                    "folder_id": { "type": "string", "description": "可选：限制搜索范围到指定文件夹" },
                    "top_k": { "type": "integer", "default": 10, "minimum": 1, "maximum": 50, "description": "返回结果数量" }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "builtin-folder_list",
            "列出用户的文件夹结构。",
            json!({
                "type": "object",
                "properties": {
                    "parent_id": { "type": "string", "description": "父文件夹 ID，为空或 \"root\" 时列出根目录" },
                    "include_count": { "type": "boolean", "description": "是否包含资源数量统计，默认 true" },
                    "recursive": { "type": "boolean", "description": "是否递归列出子文件夹，默认 false" }
                }
            }),
        ),
        tool(
            "builtin-dstu_list_trash",
            "分页列出 DSTU 回收站内容。这是只读操作，不会恢复或永久删除资源。",
            json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "default": 20, "minimum": 1, "maximum": 20 },
                    "offset": { "type": "integer", "default": 0, "minimum": 0 }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-user_todo_list_lists",
            "[用户待办] 分页列出用户的个人待办列表。",
            json!({
                "type": "object",
                "properties": {
                    "page": { "type": "integer", "minimum": 1, "default": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-user_todo_list_items",
            "[用户待办] 列出用户的待办项。支持按列表 ID 筛选与今日/逾期/即将到期视图。",
            json!({
                "type": "object",
                "properties": {
                    "list_id": { "type": "string", "description": "待办列表 ID（可选）" },
                    "view": { "type": "string", "enum": ["all", "today", "overdue", "upcoming", "completed"], "description": "视图过滤，默认 all" },
                    "include_completed": { "type": "boolean", "description": "是否包含已完成项，默认 false" },
                    "page": { "type": "integer", "minimum": 1, "default": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-user_todo_get_summary",
            "[用户待办] 获取用户待办事项总览摘要（今日、逾期、统计）。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "builtin-user_todo_search",
            "[用户待办] 跨列表分页搜索待办项。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1 },
                    "page": { "type": "integer", "minimum": 1, "default": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-user_todo_list_trash",
            "[用户待办] 分页查看待办项或列表回收站（只读）。",
            json!({
                "type": "object",
                "properties": {
                    "entity_type": { "type": "string", "enum": ["item", "list"] },
                    "page": { "type": "integer", "minimum": 1, "default": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                },
                "required": ["entity_type"],
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-settings_get",
            "按显式安全前缀读取最多 20 个低风险应用设置；密钥、OAuth、MCP、云凭据和审批设置永不返回。",
            json!({
                "type": "object",
                "properties": {
                    "prefix": {
                        "type": "string",
                        "enum": ["theme", "language", "enableNotifications", "maxChatHistory", "markdownRendererMode", "auto_save", "macos.", "sidebar.", "ui.", "thinking.", "textbook."]
                    }
                },
                "required": ["prefix"],
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-model_assignments_get",
            "读取模型职责分配和严格脱敏的分页模型目录；不返回 API key、base URL、headers 或认证配置。",
            json!({
                "type": "object",
                "properties": {
                    "page": { "type": "integer", "minimum": 1, "default": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-llm_usage_query",
            "查询本地 LLM token 用量、趋势和分组统计。成本仅为 estimated；缺少定价的 0 不代表免费。",
            json!({
                "type": "object",
                "oneOf": [
                    {
                        "type": "object",
                        "properties": {
                            "action": { "const": "summary" },
                            "start_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
                            "end_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
                        },
                        "required": ["action", "start_date", "end_date"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "action": { "const": "trends" },
                            "days": { "type": "integer", "minimum": 1, "maximum": 366 },
                            "granularity": { "type": "string", "enum": ["hour", "day"] },
                            "offset": { "type": "integer", "minimum": 0, "default": 0 },
                            "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                        },
                        "required": ["action", "days", "granularity"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "action": { "enum": ["by_model", "by_caller"] },
                            "start_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
                            "end_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
                            "offset": { "type": "integer", "minimum": 0, "default": 0 },
                            "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                        },
                        "required": ["action", "start_date", "end_date"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "action": { "const": "recent" },
                            "offset": { "type": "integer", "minimum": 0, "default": 0 },
                            "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                        },
                        "required": ["action"],
                        "additionalProperties": false
                    }
                ]
            }),
        ),
        tool(
            "builtin-backup_status",
            "分页读取本机备份目录；仅表示 local_backup_catalog，不探测云端。",
            json!({
                "type": "object",
                "properties": {
                    "page": { "type": "integer", "minimum": 1, "default": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-backup_job_status",
            "查询已知后台备份 job 的真实状态和 result.success；只读，不创建或取消任务。",
            json!({
                "type": "object",
                "properties": {
                    "job_id": { "type": "string", "minLength": 1, "maxLength": 80 }
                },
                "required": ["job_id"],
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-sync_status",
            "读取本地 change-log 同步统计。cloud_probed=false，不能据此判断云端可达或两端一致。",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        ),
        tool(
            "builtin-qbank_list",
            "列出用户的所有题目集，返回基本信息和学习统计数据。",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "limit": { "type": "integer", "default": 20, "minimum": 1, "maximum": 20 },
                    "offset": { "type": "integer", "default": 0, "minimum": 0 },
                    "search": { "type": "string", "description": "搜索关键词（匹配题目集名称）" },
                    "include_stats": { "type": "boolean", "default": true, "description": "是否包含统计信息" }
                }
            }),
        ),
        tool(
            "builtin-qbank_list_questions",
            "列出题目集中的题目。支持按状态、难度、标签筛选与分页。",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "session_id": { "type": "string", "description": "【必填】题目集 ID" },
                    "status": { "type": "string", "enum": ["new", "in_progress", "mastered", "review"], "description": "筛选状态" },
                    "difficulty": { "type": "string", "enum": ["easy", "medium", "hard", "very_hard"], "description": "筛选难度" },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "筛选标签" },
                    "page": { "type": "integer", "default": 1, "minimum": 1 },
                    "page_size": { "type": "integer", "default": 20, "minimum": 1, "maximum": 20 }
                },
                "required": ["session_id"]
            }),
        ),
        tool(
            "builtin-qbank_get_question",
            "获取单个题目的详细信息（题干、答案、解析、作答记录）。",
            json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "【必填】题目集 ID" },
                    "card_id": { "type": "string", "description": "【必填】题目卡片 ID" }
                },
                "required": ["session_id", "card_id"]
            }),
        ),
        tool(
            "builtin-qbank_get_stats",
            "获取题目集的学习统计信息（总题数、各状态数量、正确率等）。",
            json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "【必填】题目集 ID" }
                },
                "required": ["session_id"]
            }),
        ),
        tool(
            "builtin-qbank_get_next_question",
            "获取下一道推荐题目（顺序/随机/错题优先/知识点聚焦）。",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "session_id": { "type": "string", "description": "【必填】题目集 ID" },
                    "mode": { "type": "string", "enum": ["sequential", "random", "review_first", "by_tag"], "default": "sequential" },
                    "tag": { "type": "string", "description": "mode=by_tag 时指定要练习的标签" },
                    "current_card_id": { "type": "string", "description": "当前题目 ID（用于顺序模式获取下一题）" },
                    "review_only": { "type": "boolean", "default": false, "description": "只选择 status=review 的错题/待复习题" }
                },
                "required": ["session_id"]
            }),
        ),
        tool(
            "builtin-index_status",
            "读取真实 VFS 索引摘要；可按 resource_id 查询分页 Unit 与有界 OCR/提取文本预览。",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "resource_id": { "type": "string", "pattern": "^res_[A-Za-z0-9_-]+$" },
                    "page": { "type": "integer", "minimum": 1, "default": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                }
            }),
        ),
        tool(
            "builtin-learning_overview",
            "聚合查询学习活动、题库、复习与番茄钟统计；返回分页日明细与部分数据源错误。",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "start_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
                    "end_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
                    "page": { "type": "integer", "minimum": 1, "default": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                }
            }),
        ),
        tool(
            "builtin-pomodoro_today_stats",
            "查询今日番茄钟专注统计。",
            json!({ "type": "object", "additionalProperties": false }),
        ),
        tool(
            "builtin-pomodoro_daily_stats",
            "分页查询最近若干天的番茄钟日统计。",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "days": { "type": "integer", "minimum": 1, "maximum": 90, "default": 7 },
                    "page": { "type": "integer", "minimum": 1, "default": 1 },
                    "page_size": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                }
            }),
        ),
        tool(
            "builtin-review_get_due",
            "查询今天（或指定日期前）到期的间隔重复复习计划，附题目内容预览。",
            json!({
                "type": "object",
                "properties": {
                    "exam_id": { "type": "string", "description": "可选：限定题目集 ID" },
                    "until_date": { "type": "string", "description": "可选：截止日期 YYYY-MM-DD，默认今天" },
                    "difficult_only": { "type": "boolean", "description": "可选：仅返回困难题" },
                    "limit": { "type": "integer", "default": 20, "minimum": 1, "maximum": 100 },
                    "offset": { "type": "integer", "default": 0, "minimum": 0 }
                }
            }),
        ),
        tool(
            "builtin-review_stats",
            "获取间隔重复复习统计（各状态计划数、今日到期、逾期、正确率等）。",
            json!({
                "type": "object",
                "properties": {
                    "exam_id": { "type": "string", "description": "可选：限定题目集 ID" }
                }
            }),
        ),
    ];

    // 防御性自检：schema 集必须是白名单子集（编码期笔误的最后一道闸）
    filter_headless_tool_schemas(schemas)
}

fn trusted_profile_tool_schemas(profile: &TrustedAutomationProfile) -> Vec<McpToolSchema> {
    profile
        .allowed_tools
        .iter()
        .map(|name| McpToolSchema {
            name: name.clone(),
            server_id: None,
            description: Some(
                "Trusted automation tool. Every call is constrained by the pinned profile's runtime roots, command prefixes, network domains, output budget, and rollback policy."
                    .to_string(),
            ),
            input_schema: Some(json!({
                "type": "object",
                "additionalProperties": true,
                "properties": {
                    "root_id": { "type": "string" },
                    "path": { "type": "string" },
                    "command": { "type": "string" },
                    "allow_network": { "type": "boolean" },
                    "max_output_bytes": { "type": "integer", "maximum": profile.max_output_bytes },
                    "max_bytes": { "type": "integer", "maximum": profile.max_output_bytes },
                    "track_file_changes": { "type": "boolean" }
                }
            })),
        })
        .collect()
}

// ============================================================================
// 请求 / 结果类型
// ============================================================================

/// headless 会话模式（采用成熟代理运行时的 cron 的 isolated / session:custom-id）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum HeadlessSessionMode {
    /// 每次运行新建会话（metadata 标记 automation_run=true）
    #[default]
    Isolated,
    /// 复用固定会话，跨运行积累上下文（如"每周学情报告"）
    Named,
}

impl HeadlessSessionMode {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "isolated" => Ok(Self::Isolated),
            "named" => Ok(Self::Named),
            other => Err(format!(
                "Invalid session_mode '{}'. Allowed: isolated, named",
                other
            )),
        }
    }
}

/// headless turn 请求
#[derive(Debug, Clone)]
pub struct HeadlessTurnRequest {
    /// 本次 agent turn 的任务提示词（作为用户消息发送）
    pub prompt: String,
    /// 会话模式
    pub session_mode: HeadlessSessionMode,
    /// named 模式下要复用的既有会话 ID；为空或已失效时新建，
    /// 实际使用的会话 ID 经 `HeadlessTurnResult.session_id` 返回，调用方应回存
    pub named_session_id: Option<String>,
    /// 指定模型（None 走默认对话模型）
    pub model_id: Option<String>,
    /// 触发来源标识（如 "automation:auto_xxx" / "manual"），写入会话 metadata
    pub source: String,
    /// 新建会话时的标题
    pub title: Option<String>,
    /// 硬超时（秒），None 用默认值/全局设置
    pub hard_timeout_secs: Option<u64>,
    /// 工具轮次上限，None 用默认值/全局设置
    pub max_tool_rounds: Option<u32>,
    /// Explicit pre-authorized profile. None preserves the read-only default.
    pub trusted_profile: Option<TrustedAutomationProfile>,
    /// Optional caller-owned token used by durable schedulers to cancel this run.
    pub cancellation_token: Option<CancellationToken>,
}

/// headless turn 结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessTurnResult {
    /// 实际使用的会话 ID（named 模式下调用方应回存以便下次复用）
    pub session_id: String,
    /// 助手消息 ID
    pub assistant_message_id: String,
    /// completed | cancelled | timeout | error
    pub status: String,
    /// 结果摘要（优先使用 attempt_completion 结果，否则使用助手正文；用于通知正文）
    pub summary: String,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
    /// 失败时的错误信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 底层请求：调用方已持有会话 ID（automations 调度器路径）
#[derive(Debug, Clone)]
pub struct HeadlessSessionTurn {
    /// 目标会话 ID（须已存在）
    pub session_id: String,
    /// 任务提示词
    pub prompt: String,
    /// 指定模型（None 走默认对话模型）
    pub model_id: Option<String>,
    /// 额外的 system prompt 追加段（headless 约束说明之外的补充）
    pub system_prompt_append: Option<String>,
    /// 本次 turn 硬超时（防御性钳制到 [1s, `MAX_HARD_TIMEOUT_SECS`]）
    pub timeout: std::time::Duration,
}

/// 底层执行结果
#[derive(Debug, Clone)]
pub struct HeadlessTurnOutcome {
    /// 会话 ID
    pub session_id: String,
    /// 助手消息 ID
    pub assistant_message_id: String,
    /// 助手最终结果（优先使用 attempt_completion 结果，否则拼接 content 块；未截断）
    pub content: String,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
}

// ============================================================================
// 入口 1：高层 runner（会话模式解析 + 摘要）
// ============================================================================

/// 后端自主发起一个完整 agent turn（无前端参与）。
///
/// 基础设施级失败（管线未初始化 / 无可用窗口 / 会话创建失败 / 会话流冲突）
/// 返回 `Err`；管线执行期的失败（LLM 错误、超时等）返回 `Ok` 且
/// `status = cancelled|timeout|error`，因为此时消息/块已按管线取消/错误路径落库，
/// 调用方可据此发失败通知。
pub async fn run_headless_turn(
    app: AppHandle,
    req: HeadlessTurnRequest,
) -> ChatV2Result<HeadlessTurnResult> {
    let started = std::time::Instant::now();

    if let Err(error) = super::kill_switch::admit_or_block_from_app(&app) {
        return Err(ChatV2Error::Other(error));
    }

    if req
        .cancellation_token
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
    {
        return Err(ChatV2Error::Cancelled);
    }

    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(ChatV2Error::Validation(
            "headless turn prompt must not be empty".to_string(),
        ));
    }
    if let Some(profile) = req.trusted_profile.as_ref() {
        profile
            .validate()
            .map_err(|error| ChatV2Error::Validation(error.to_string()))?;
    }

    let chat_v2_db = app
        .try_state::<Arc<ChatV2Database>>()
        .ok_or_else(|| ChatV2Error::Other("ChatV2Database 未初始化，headless 不可用".to_string()))?
        .inner()
        .clone();

    // —— 会话：isolated 新建 / named 复用（失效则新建）
    let session_id = ensure_headless_session(&chat_v2_db, &req)?;

    // —— 超时/轮次预算：一次解析（profile > 请求值 > 全局设置 > 默认值 + 硬顶），
    //    结果贯穿传递给 execute_headless_pipeline，内部不再重算（消除维护漂移）
    let (hard_timeout_secs, max_tool_rounds) = resolve_budget(&app, &req);

    // trusted profile 的会话级安装发生在 execute_headless_pipeline 内部、
    // 流注册成功**之后**：注册的排他性保证同一会话此刻没有其他活跃流，
    // 消除“先安装 profile、后注册失败”窗口内其他流被误预授权的竞态。
    let assistant_message_id = ChatMessage::generate_id();
    let exec = execute_headless_pipeline(
        &app,
        &session_id,
        &assistant_message_id,
        &prompt,
        req.model_id.as_deref(),
        None,
        std::time::Duration::from_secs(hard_timeout_secs),
        Some(max_tool_rounds),
        req.cancellation_token,
        req.trusted_profile.as_ref(),
    )
    .await;

    let summary_source = summarize_assistant_message(&chat_v2_db, &assistant_message_id);
    let summary = truncate_chars(summary_source.trim(), SUMMARY_MAX_CHARS);
    let duration_ms = started.elapsed().as_millis() as u64;

    let (status, error) = match exec {
        Ok(()) => ("completed".to_string(), None),
        Err(HeadlessPipelineTermination::Cancelled) => (
            "cancelled".to_string(),
            Some("headless turn was cancelled".to_string()),
        ),
        Err(HeadlessPipelineTermination::Timeout { seconds }) => (
            "timeout".to_string(),
            Some(format!("headless agent turn timed out after {}s", seconds)),
        ),
        Err(HeadlessPipelineTermination::Failed(error)) => ("error".to_string(), Some(error)),
    };

    log::info!(
        "[ChatV2::headless] headless turn 结束: session={}, status={}, duration_ms={}, summary_chars={}",
        session_id,
        status,
        duration_ms,
        summary.chars().count()
    );

    Ok(HeadlessTurnResult {
        session_id,
        assistant_message_id,
        status,
        summary,
        duration_ms,
        error,
    })
}

// ============================================================================
// 入口 2：底层 runner（automations 调度器路径，自管会话）
// ============================================================================

/// 在既有会话上跑一次 headless agent turn。
///
/// 成功返回 `HeadlessTurnOutcome`（含最终回复全文，供心跳哨兵检测/通知摘要）；
/// 超时/失败返回 `Err(String)`——超时错误信息保证包含 `"timed out"`，
/// 供调用方区分 timeout 与 error。两种失败路径下消息/块均已按管线的
/// 取消/错误分支落库。
pub async fn run_headless_agent_turn(
    app: &AppHandle,
    req: HeadlessSessionTurn,
) -> Result<HeadlessTurnOutcome, String> {
    let started = std::time::Instant::now();

    super::kill_switch::admit_or_block_from_app(app)?;

    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("headless turn prompt must not be empty".to_string());
    }

    let chat_v2_db = app
        .try_state::<Arc<ChatV2Database>>()
        .ok_or_else(|| "ChatV2Database 未初始化，headless 不可用".to_string())?
        .inner()
        .clone();

    // 防御性钳制：0 时长会导致 turn 立即按超时取消；过大时长会让后台任务失控。
    let timeout = clamp_session_turn_timeout(req.timeout, &req.session_id);

    let assistant_message_id = ChatMessage::generate_id();
    execute_headless_pipeline(
        app,
        &req.session_id,
        &assistant_message_id,
        &prompt,
        req.model_id.as_deref(),
        req.system_prompt_append.as_deref(),
        timeout,
        None,
        None,
        None,
    )
    .await
    .map_err(HeadlessPipelineTermination::into_message)?;

    let content = summarize_assistant_message(&chat_v2_db, &assistant_message_id);

    Ok(HeadlessTurnOutcome {
        session_id: req.session_id,
        assistant_message_id,
        content,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

// ============================================================================
// 会话工厂
// ============================================================================

/// 创建 headless 会话（automations / 手动触发共用）。
///
/// `mode` 写入 `ChatSession.mode`（如 "automation"）；`metadata` 由调用方
/// 提供（automation_id / trigger 等），此处统一补充 `headless: true` 标记。
pub fn create_headless_session(
    db: &ChatV2Database,
    mode: &str,
    title: &str,
    metadata: Value,
) -> Result<String, String> {
    let now = chrono::Utc::now();

    let mut metadata = metadata;
    if let Some(obj) = metadata.as_object_mut() {
        obj.entry("headless".to_string()).or_insert(json!(true));
    }

    let session = ChatSession {
        id: ChatSession::generate_id(),
        mode: mode.to_string(),
        title: Some(title.to_string()),
        description: None,
        summary_hash: None,
        // headless 会话标题由创建方给定，锁定以免自动摘要覆盖
        title_locked: true,
        persist_status: PersistStatus::Active,
        created_at: now,
        updated_at: now,
        metadata: Some(metadata),
        group_id: None,
        tags_hash: None,
        tags: None,
    };

    ChatV2Repo::create_session_v2(db, &session).map_err(|e| e.to_string())?;
    log::info!(
        "[ChatV2::headless] 已创建 headless 会话: id={}, mode={}",
        session.id,
        mode
    );
    Ok(session.id)
}

/// 确保高层请求的会话存在（isolated 新建 / named 复用或新建），返回会话 ID。
///
/// named 模式健壮性：引用的会话已被删除、归档（非 Active）**或读取失败**时，
/// 自动回退为新建会话。实际使用的会话 ID 始终通过
/// `HeadlessTurnResult.session_id` 完整返回，调用方（automations.rs 的
/// named_session_id 回写逻辑）据此回存新 ID 供下次复用。
fn ensure_headless_session(db: &ChatV2Database, req: &HeadlessTurnRequest) -> ChatV2Result<String> {
    if req.session_mode == HeadlessSessionMode::Named {
        if let Some(existing_id) = req
            .named_session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            match ChatV2Repo::get_session_v2(db, existing_id) {
                Ok(Some(session)) if session.persist_status == PersistStatus::Active => {
                    log::info!("[ChatV2::headless] named 模式复用既有会话: {}", existing_id);
                    return Ok(existing_id.to_string());
                }
                Ok(_) => {
                    log::warn!(
                        "[ChatV2::headless] named 会话 {} 不存在或非 Active，回退新建（新 ID 经 HeadlessTurnResult.session_id 返回，调用方应回写）",
                        existing_id
                    );
                }
                Err(error) => {
                    // 读取失败不让整轮失败：回退新建（若 DB 整体不可用，
                    // 下方 create_headless_session 会以真实错误失败）
                    log::warn!(
                        "[ChatV2::headless] 读取 named 会话 {} 失败（{}），回退新建",
                        existing_id,
                        error
                    );
                }
            }
        }
    }

    let metadata = match req.session_mode {
        HeadlessSessionMode::Isolated => json!({
            "automation_run": true,
            "source": req.source,
        }),
        HeadlessSessionMode::Named => json!({
            "headless_named": true,
            "source": req.source,
        }),
    };

    let title = req
        .title
        .clone()
        .unwrap_or_else(|| format!("自动化任务 {}", chrono::Local::now().format("%m-%d %H:%M")));

    create_headless_session(db, "automation", &title, metadata).map_err(ChatV2Error::Other)
}

// ============================================================================
// 内部执行核心
// ============================================================================

/// 执行 headless 管线（两个入口共用）。
///
/// 注入 headless 工具白名单（schema + 执行双层 fail-closed），原子注册流，
/// 硬超时命中后触发取消并限时等待管线保存部分结果。
#[derive(Debug)]
enum HeadlessPipelineTermination {
    Cancelled,
    Timeout { seconds: u64 },
    Failed(String),
}

impl HeadlessPipelineTermination {
    fn into_message(self) -> String {
        match self {
            Self::Cancelled => "headless turn was cancelled".to_string(),
            Self::Timeout { seconds } => {
                format!("headless agent turn timed out after {}s", seconds)
            }
            Self::Failed(message) => message,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_headless_pipeline(
    app: &AppHandle,
    session_id: &str,
    assistant_message_id: &str,
    prompt: &str,
    model_id: Option<&str>,
    extra_system_append: Option<&str>,
    hard_timeout: std::time::Duration,
    max_tool_rounds_override: Option<u32>,
    external_cancellation_token: Option<CancellationToken>,
    trusted_profile: Option<&TrustedAutomationProfile>,
) -> Result<(), HeadlessPipelineTermination> {
    // —— 解析托管状态（缺失说明 Chat V2 降级运行，headless 不可用）
    let pipeline = app
        .try_state::<Arc<ChatV2Pipeline>>()
        .ok_or_else(|| {
            HeadlessPipelineTermination::Failed(
                "ChatV2Pipeline 未初始化，headless 不可用".to_string(),
            )
        })?
        .inner()
        .clone();
    let chat_v2_state = app
        .try_state::<Arc<ChatV2State>>()
        .ok_or_else(|| {
            HeadlessPipelineTermination::Failed("ChatV2State 未初始化，headless 不可用".to_string())
        })?
        .inner()
        .clone();

    if let Err(error) = super::kill_switch::admit_or_block(&chat_v2_state) {
        return Err(HeadlessPipelineTermination::Failed(error));
    }

    // —— 事件发射所需的 Window（AppHandle 全局 emit 语义：无前端监听也无害）。
    //    Tauri 窗口在应用存续期间通常存活（最小化/隐藏不影响 emit）。
    //
    //    无窗口容错评估（2026-07）：`run_send_message_pipeline` →
    //    `ChatV2Pipeline::execute(window: Window, ...)` 的签名强依赖具体
    //    `tauri::Window`（emitter 构造 + 工具 ExecutionContext 的 window 桥），
    //    `ChatV2EventEmitter` 的 windowless 形态仅 `#[cfg(test)]` 暴露，且这些
    //    文件属于其他并行改造，headless 侧无法在不改管线签名的前提下安全降级为
    //    "无 UI 事件模式"。此处保守保留 fail-fast，但补充 run 上下文日志便于排查
    //    纯后台驻留场景（所有窗口已销毁）下的任务失败原因。
    let window = resolve_emit_window(app).ok_or_else(|| {
        log::error!(
            "[ChatV2::headless] 没有可用的应用窗口，headless turn 无法启动: session={}, assistant_message={}（纯后台驻留/窗口全部关闭场景；管线事件通道强依赖 Window，暂不支持无窗口降级）",
            session_id,
            assistant_message_id
        );
        HeadlessPipelineTermination::Failed(format!(
            "没有可用的应用窗口，无法创建事件发射通道（session={session_id}）"
        ))
    })?;

    // 轮次预算：run_headless_turn 已经通过 resolve_budget（profile > 请求 >
    // 设置 > 默认 + 硬顶）解析并经 override 传入，这里直接采信不再重算；
    // override 为 None 的低层路径（run_headless_agent_turn）保留原有解析链。
    let max_tool_rounds = max_tool_rounds_override
        .or_else(|| trusted_profile.map(|profile| profile.max_tool_rounds))
        .or_else(|| {
            read_main_db_setting_u64(app, SETTING_HEADLESS_MAX_TOOL_ROUNDS).map(|v| v as u32)
        })
        .unwrap_or(DEFAULT_MAX_TOOL_ROUNDS)
        .clamp(1, MAX_TOOL_ROUNDS_CAP);

    // —— system prompt 追加：headless 约束说明 + 调用方补充段
    let mut system_append = headless_system_prompt_note();
    if let Some(profile) = trusted_profile {
        system_append.push_str(&format!(
            "\n\nTrusted automation profile {} is active. Use only its pinned tools, roots, command prefixes, network domains and budgets; write operations must preserve rollback evidence.",
            profile.profile_hash
        ));
    }
    if let Some(extra) = extra_system_append.map(str::trim).filter(|s| !s.is_empty()) {
        system_append.push_str("\n\n");
        system_append.push_str(extra);
    }

    // —— 构建请求（工具双层 fail-closed：schema 白名单注入 + 执行白名单拦截）
    let mut schemas = headless_tool_schemas();
    let mut allowed_tools = headless_allowed_tools();
    if let Some(profile) = trusted_profile {
        schemas.extend(trusted_profile_tool_schemas(profile));
        allowed_tools.extend(profile.allowed_tools.iter().cloned());
        allowed_tools.sort();
        allowed_tools.dedup();
    }
    let options = SendOptions {
        model_id: model_id.map(|s| s.to_string()),
        // todo_* 元工具经后端 SchemaToolRegistry 注入；attempt_completion 自动追加
        schema_tool_ids: Some(vec![
            "todo_init".to_string(),
            "todo_update".to_string(),
            "todo_add".to_string(),
            "todo_get".to_string(),
        ]),
        // 白名单工具 schema（后端维护的精简副本），模型只能看见这些
        mcp_tool_schemas: Some(schemas),
        // 执行层 fail-closed：白名单外的调用在审批/执行前被直接拦截回喂
        execution_allowed_tools: Some(allowed_tools),
        max_tool_recursion: Some(max_tool_rounds),
        memory_enabled: Some(true),
        rag_enabled: Some(true),
        web_search_enabled: Some(true),
        system_prompt_append: Some(system_append),
        ..Default::default()
    };

    let request = SendMessageRequest {
        session_id: session_id.to_string(),
        content: prompt.to_string(),
        options: Some(options),
        user_message_id: None,
        assistant_message_id: Some(assistant_message_id.to_string()),
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    // —— 原子注册流（named 会话可能与用户手动会话冲突，fail fast）
    if external_cancellation_token
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
    {
        return Err(HeadlessPipelineTermination::Cancelled);
    }

    // The pipeline owns an independent token (minted by the atomic
    // registration). A hard timeout or external cancellation cancels only this
    // token; it must never mutate the caller's token because that token carries
    // user/shutdown intent back to the durable scheduler.
    //
    // 统一走 try_register_stream_owned：同时取得 token 与 generation，
    // 收尾兜底可以做 compare-and-remove（remove_stream_if_generation），
    // 不会误删本次 run 结束后紧接着注册的其他调用方的流。
    let registration = chat_v2_state
        .try_register_stream_owned(session_id)
        .map_err(|_| {
            HeadlessPipelineTermination::Failed(format!(
                "会话 {} 已有活跃流，headless turn 取消（会话可能正被使用）",
                session_id
            ))
        })?;
    let stream_generation = registration.generation();
    let cancel_token = registration.token().clone();

    // trusted profile：流注册成功后才安装（注册的排他性保证此刻该会话没有
    // 其他活跃流，杜绝“先安装、后注册失败”窗口内同会话其他流被误预授权）。
    // guard 存活至本函数返回，覆盖管线全程与 grace 收尾。
    let _trusted_profile_guard =
        TrustedAutomationSessionGuard::install(session_id, trusted_profile);

    log::info!(
        "[ChatV2::headless] 启动 headless turn: session={}, timeout={}s, max_rounds={}, generation={}",
        session_id,
        hard_timeout.as_secs(),
        max_tool_rounds,
        stream_generation
    );

    // —— 执行：复用 send_message 的内部管线路径（StreamGuard + Pipeline::execute），
    //    硬超时命中后先 cancel 让管线走"取消保存部分结果"路径，再限时收尾。
    //    Box::pin 拥有 future 所有权：超时收尾路径可以显式 drop 触发
    //    StreamGuard 的清理，再做流注册泄漏兜底检查。
    //    catch_unwind 隔离 panic：单次 run 的 panic 转化为 error 结果回传，
    //    unwind 过程中 StreamGuard 照常 drop 清理，调度器不受影响。
    let mut pipeline_fut = Box::pin(
        AssertUnwindSafe(super::handlers::send_message::run_send_message_pipeline(
            pipeline,
            chat_v2_state.clone(),
            window,
            request,
            cancel_token.clone(),
        ))
        .catch_unwind(),
    );

    let hard_timeout_sleep = tokio::time::sleep(hard_timeout);
    tokio::pin!(hard_timeout_sleep);

    // 周期性进度日志：长时间运行时每分钟报告一次存活状态与已耗时，
    // 便于从日志区分"仍在推进"与"已挂死等超时"。
    let monitor_started = std::time::Instant::now();
    let progress_interval = std::time::Duration::from_secs(PROGRESS_LOG_INTERVAL_SECS);
    let mut progress_ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + progress_interval,
        progress_interval,
    );

    let termination = loop {
        if let Some(external_token) = external_cancellation_token.as_ref() {
            tokio::select! {
                biased;
                result = &mut pipeline_fut => {
                    return conclude_pipeline_result(result, session_id);
                }
                _ = external_token.cancelled() => {
                    log::info!(
                        "[ChatV2::headless] headless turn received external cancellation: session={}",
                        session_id
                    );
                    break HeadlessPipelineTermination::Cancelled;
                }
                _ = &mut hard_timeout_sleep => {
                    break HeadlessPipelineTermination::Timeout { seconds: hard_timeout.as_secs() };
                }
                _ = progress_ticker.tick() => {
                    log::info!(
                        "[ChatV2::headless] headless turn 进行中: session={}, elapsed_s={}, timeout_s={}",
                        session_id,
                        monitor_started.elapsed().as_secs(),
                        hard_timeout.as_secs()
                    );
                }
            }
        } else {
            tokio::select! {
                result = &mut pipeline_fut => {
                    return conclude_pipeline_result(result, session_id);
                }
                _ = &mut hard_timeout_sleep => {
                    break HeadlessPipelineTermination::Timeout { seconds: hard_timeout.as_secs() };
                }
                _ = progress_ticker.tick() => {
                    log::info!(
                        "[ChatV2::headless] headless turn 进行中: session={}, elapsed_s={}, timeout_s={}",
                        session_id,
                        monitor_started.elapsed().as_secs(),
                        hard_timeout.as_secs()
                    );
                }
            }
        }
    };

    // —— 超时 / 外部取消统一收尾：先 cancel 让管线走取消保存路径，再限时等待
    let reason = match &termination {
        HeadlessPipelineTermination::Cancelled => "external-cancel",
        _ => "hard-timeout",
    };
    if matches!(&termination, HeadlessPipelineTermination::Timeout { .. }) {
        log::warn!(
            "[ChatV2::headless] headless turn 超过硬超时 {}s，触发取消并等待收尾: session={}",
            hard_timeout.as_secs(),
            session_id
        );
    }
    cancel_token.cancel();
    let graceful = match tokio::time::timeout(
        std::time::Duration::from_secs(CANCEL_GRACE_SECS),
        &mut pipeline_fut,
    )
    .await
    {
        // grace 窗口内正常结束（结果按取消/超时语义丢弃，块已由管线落库）
        Ok(Ok(_)) => true,
        // grace 窗口内以 panic 结束：future 已终止，记录根因后按已结束处理
        Ok(Err(payload)) => {
            log::error!(
                "[ChatV2::headless] pipeline 在取消收尾期间 panic（已隔离）: session={}, reason={}, panic={}",
                session_id,
                reason,
                panic_message(payload.as_ref())
            );
            true
        }
        Err(_) => false,
    };
    finalize_overrun_pipeline(
        pipeline_fut,
        graceful,
        &cancel_token,
        &chat_v2_state,
        session_id,
        assistant_message_id,
        stream_generation,
        reason,
    );
    Err(termination)
}

/// `run_send_message_pipeline` 经 `catch_unwind` 包装后的输出类型。
type PipelineRunOutput = Result<Result<String, ChatV2Error>, Box<dyn std::any::Any + Send>>;

/// 从 panic payload 中尽量还原可读的根因文本。
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else {
        "non-string panic payload".to_string()
    }
}

/// 管线在超时前自然结束时的结果归一化（完成 / 取消 / 失败 / panic）。
fn conclude_pipeline_result(
    result: PipelineRunOutput,
    session_id: &str,
) -> Result<(), HeadlessPipelineTermination> {
    match result {
        Ok(Ok(_msg_id)) => {
            log::info!(
                "[ChatV2::headless] headless turn 完成: session={}",
                session_id
            );
            Ok(())
        }
        Ok(Err(ChatV2Error::Cancelled)) => Err(HeadlessPipelineTermination::Cancelled),
        Ok(Err(error)) => Err(HeadlessPipelineTermination::Failed(error.to_string())),
        Err(payload) => {
            let reason = panic_message(payload.as_ref());
            log::error!(
                "[ChatV2::headless] headless pipeline panic（已隔离，单次 run 失败，不影响调度器）: session={}, panic={}",
                session_id,
                reason
            );
            Err(HeadlessPipelineTermination::Failed(format!(
                "headless pipeline panicked: {reason}"
            )))
        }
    }
}

/// 超时/外部取消收尾兜底：确保 cancel token 已触发、pipeline future 被显式
/// drop（触发其内部 StreamGuard 的 remove_stream 清理），并在极端情况下
/// （StreamGuard 未建立的兼容路径竞态）按 generation 精确清除残留的流注册，
/// 防止会话被永久锁定。`graceful=false` 表示 grace 窗口内 future 仍未结束，
/// 此时用 log::error 带 run 上下文记录强制收尾。
#[allow(clippy::too_many_arguments)]
fn finalize_overrun_pipeline<F>(
    pipeline_fut: std::pin::Pin<Box<F>>,
    graceful: bool,
    cancel_token: &CancellationToken,
    chat_v2_state: &Arc<ChatV2State>,
    session_id: &str,
    assistant_message_id: &str,
    stream_generation: u64,
    reason: &str,
) where
    F: std::future::Future + ?Sized,
{
    if !cancel_token.is_cancelled() {
        // 不应发生（调用点先 cancel 再进入收尾）；防御性兜底
        log::error!(
            "[ChatV2::headless] finalize_overrun_pipeline 发现 cancel token 未触发，补触发: session={}, reason={}",
            session_id,
            reason
        );
        cancel_token.cancel();
    }
    if !graceful {
        log::error!(
            "[ChatV2::headless] pipeline future 在 {}s grace 窗口后仍未结束，强制 drop 收尾: session={}, assistant_message={}, reason={}",
            CANCEL_GRACE_SECS,
            session_id,
            assistant_message_id,
            reason
        );
    }
    // 显式 drop：正常情况下 StreamGuard::drop → remove_stream_if_generation
    drop(pipeline_fut);
    // 兜底：StreamGuard::from_registered_token 在 token 已取消的竞态下可能返回
    // None（无 guard），导致注册残留。compare-and-remove 只清理本次 run 的
    // generation：若其他调用方在 future drop 后立即注册了同会话键的新流，
    // generation 不匹配、不受影响。
    if chat_v2_state.remove_stream_if_generation(session_id, stream_generation) {
        log::error!(
            "[ChatV2::headless] 检测到残留的流注册（StreamGuard 未生效），已按 generation 精确清理: session={}, generation={}, reason={}",
            session_id,
            stream_generation,
            reason
        );
    }
}

// ============================================================================
// 内部辅助
// ============================================================================

/// 获取用于事件发射的 Window：优先 main，其次任意存活窗口。
fn resolve_emit_window(app: &AppHandle) -> Option<Window> {
    let webviews = app.webview_windows();
    if let Some(main) = webviews.get("main") {
        return Some(main.as_ref().window());
    }
    webviews.values().next().map(|w| w.as_ref().window())
}

/// 解析高层请求的超时/轮次预算：请求值 > 全局设置 > 默认值，并施加硬顶。
fn resolve_budget(app: &AppHandle, req: &HeadlessTurnRequest) -> (u64, u32) {
    let setting_timeout = read_main_db_setting_u64(app, SETTING_HEADLESS_TIMEOUT_SECS);
    let setting_rounds =
        read_main_db_setting_u64(app, SETTING_HEADLESS_MAX_TOOL_ROUNDS).map(|v| v as u32);

    let timeout = req
        .trusted_profile
        .as_ref()
        .map(|profile| profile.timeout_seconds)
        .or(req.hard_timeout_secs)
        .or(setting_timeout)
        .unwrap_or(DEFAULT_HARD_TIMEOUT_SECS)
        .clamp(30, MAX_HARD_TIMEOUT_SECS);
    let rounds = req
        .trusted_profile
        .as_ref()
        .map(|profile| profile.max_tool_rounds)
        .or(req.max_tool_rounds)
        .or(setting_rounds)
        .unwrap_or(DEFAULT_MAX_TOOL_ROUNDS)
        .clamp(1, MAX_TOOL_ROUNDS_CAP);
    (timeout, rounds)
}

/// 低层入口（`run_headless_agent_turn`）调用方自带超时的防御性钳制：
/// 0 时长会导致 turn 立即按超时取消，过大时长会让后台任务失控。
fn clamp_session_turn_timeout(
    requested: std::time::Duration,
    session_id: &str,
) -> std::time::Duration {
    let clamped_secs = requested.as_secs().clamp(1, MAX_HARD_TIMEOUT_SECS);
    if clamped_secs != requested.as_secs() {
        log::warn!(
            "[ChatV2::headless] session turn 超时被钳制: session={}, requested={}s, effective={}s",
            session_id,
            requested.as_secs(),
            clamped_secs
        );
    }
    std::time::Duration::from_secs(clamped_secs)
}

fn read_main_db_setting_u64(app: &AppHandle, key: &str) -> Option<u64> {
    let state = app.try_state::<crate::commands::AppState>()?;
    state
        .database
        .get_setting(key)
        .ok()
        .flatten()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
}

/// headless 模式的 system prompt 追加说明。
fn headless_system_prompt_note() -> String {
    [
        "<headless_mode>",
        "本次运行为无人值守的后台自动化任务（headless），没有用户在场：",
        "- 不要提问或等待用户输入（ask_user 等交互工具不可用）；",
        "- 仅可使用当前注入的工具；其他工具（含全部 MCP 外部工具、shell、子代理）",
        "  在本模式下被策略禁用，调用会被直接拒绝并提示需人工授权，请勿尝试；",
        "- 任何需要人工授权的操作（安装、删除、外部提案等）请在总结中建议用户手动执行；",
        "- 完成任务后调用 attempt_completion，给出简洁的结果摘要（将用于系统通知正文）。",
        "</headless_mode>",
    ]
    .join("\n")
}

/// 从助手消息中提取最终结果。
///
/// Headless prompt 要求模型以 `attempt_completion` 结束任务，因此正常完成时可能
/// 完全没有 content 块。成功完成工具的 `tool_output.result` 是通知正文的权威来源；
/// 工具失败、输出缺失或结果为空时才回退到 content 块。
fn summarize_assistant_message(db: &ChatV2Database, message_id: &str) -> String {
    let blocks = match ChatV2Repo::get_message_blocks_v2(db, message_id) {
        Ok(blocks) => blocks,
        Err(e) => {
            log::warn!(
                "[ChatV2::headless] 读取消息块失败，内容为空: message={}, err={}",
                message_id,
                e
            );
            return String::new();
        }
    };

    summarize_assistant_blocks(&blocks)
}

fn summarize_assistant_blocks(blocks: &[MessageBlock]) -> String {
    if let Some(result) = blocks.iter().rev().find_map(|block| {
        if block.status != block_status::SUCCESS
            || !block
                .tool_name
                .as_deref()
                .is_some_and(is_attempt_completion)
        {
            return None;
        }

        block
            .tool_output
            .as_ref()?
            .get("result")?
            .as_str()
            .map(str::trim)
            .filter(|result| !result.is_empty())
    }) {
        return result.to_string();
    }

    blocks
        .iter()
        .filter(|b| b.block_type == "content")
        .filter_map(|b| b.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{}…", truncated)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::automations::heartbeat_is_silent;
    use crate::chat_v2::tool_policy::is_tool_allowed_by_execution_policy;
    use crate::chat_v2::tools::{
        AttemptCompletionExecutor, BuiltinResourceExecutor, BuiltinRetrievalExecutor,
        DataGovernanceToolExecutor, DstuToolExecutor, FetchExecutor, IndexWebpageToolExecutor,
        LearningOverviewExecutor, LlmUsageToolExecutor, MemoryToolExecutor, ReviewToolExecutor,
        SettingsModelsToolExecutor, TodoListExecutor, ToolExecutor, ToolExecutorRegistry,
        ToolSensitivity, UserTodoExecutor,
    };
    use serde_json::json;
    use std::sync::Arc;

    /// 构建覆盖白名单全部工具的执行器注册表（顺序与 pipeline 注册一致的子集）
    fn whitelist_registry() -> ToolExecutorRegistry {
        let executors: Vec<Arc<dyn ToolExecutor>> = vec![
            Arc::new(AttemptCompletionExecutor::new()),
            Arc::new(BuiltinRetrievalExecutor::new()),
            Arc::new(BuiltinResourceExecutor::new()),
            Arc::new(DstuToolExecutor::new()),
            Arc::new(FetchExecutor::new()),
            Arc::new(SettingsModelsToolExecutor::new()),
            Arc::new(LlmUsageToolExecutor::new()),
            Arc::new(DataGovernanceToolExecutor::new()),
            Arc::new(LearningOverviewExecutor::new()),
            Arc::new(IndexWebpageToolExecutor::new()),
            Arc::new(TodoListExecutor::new()),
            Arc::new(crate::chat_v2::tools::qbank_executor::QBankExecutor::new()),
            Arc::new(MemoryToolExecutor::new()),
            Arc::new(UserTodoExecutor::new()),
            Arc::new(ReviewToolExecutor::new()),
        ];
        ToolExecutorRegistry::from_vec(executors)
    }

    fn schema_for(name: &str) -> Value {
        headless_tool_schemas()
            .into_iter()
            .find(|schema| schema.name == name)
            .unwrap_or_else(|| panic!("missing headless schema {name}"))
            .input_schema
            .unwrap_or_else(|| panic!("missing input schema for {name}"))
    }

    #[test]
    fn headless_read_schemas_match_production_pagination_contracts() {
        let memory = schema_for("builtin-memory_list");
        assert_eq!(memory["properties"]["limit"]["default"], 20);
        assert_eq!(memory["properties"]["limit"]["maximum"], 20);

        let trash = schema_for("builtin-dstu_list_trash");
        assert_eq!(trash["properties"]["limit"]["default"], 20);
        assert_eq!(trash["properties"]["limit"]["maximum"], 20);

        let banks = schema_for("builtin-qbank_list");
        assert_eq!(banks["properties"]["limit"]["maximum"], 20);
        let questions = schema_for("builtin-qbank_list_questions");
        assert_eq!(questions["properties"]["page_size"]["maximum"], 20);

        let next = schema_for("builtin-qbank_get_next_question");
        assert_eq!(next["properties"]["review_only"]["default"], false);
        assert!(next["properties"]["current_card_id"].is_object());
    }

    // —— headless 工具过滤 ————————————————————————————————

    #[test]
    fn whitelist_excludes_all_blocked_tools() {
        let allowed = headless_allowed_tools();
        for (blocked, reason) in HEADLESS_BLOCKED_TOOLS {
            let hit = allowed.iter().any(|a| {
                let short = a.strip_prefix("builtin-").unwrap_or(a);
                if let Some(prefix) = blocked.strip_suffix('*') {
                    // 通配条目（如 mcp_*）：白名单不得含任何该前缀工具
                    short.starts_with(prefix) || a.starts_with(prefix)
                } else {
                    short == *blocked
                }
            });
            assert!(
                !hit,
                "黑名单工具 '{}'（{}）不得出现在白名单",
                blocked, reason
            );
        }
    }

    #[test]
    fn retired_frontend_anki_tool_stays_fail_closed() {
        let legacy_tool = "anki_generate_cards";
        assert!(
            HEADLESS_BLOCKED_TOOLS
                .iter()
                .any(|(tool, reason)| *tool == legacy_tool && *reason == "frontend-bridge"),
            "legacy frontend bridge name must remain explicitly quarantined"
        );
        assert!(!is_headless_allowed_tool(legacy_tool));
        assert!(headless_tool_schemas().iter().all(|schema| {
            schema.name.strip_prefix("builtin-").unwrap_or(&schema.name) != legacy_tool
        }));
    }

    #[test]
    fn filter_strips_frontend_bridge_and_interactive_tools() {
        let schemas = vec![
            McpToolSchema {
                name: "builtin-memory_read".to_string(),
                server_id: None,
                description: None,
                input_schema: None,
            },
            McpToolSchema {
                name: "builtin-ask_user".to_string(),
                server_id: None,
                description: None,
                input_schema: None,
            },
            McpToolSchema {
                name: "some_mcp_tool".to_string(),
                server_id: Some("srv-1".to_string()),
                description: None,
                input_schema: None,
            },
            McpToolSchema {
                name: "builtin-subagent_call".to_string(),
                server_id: None,
                description: None,
                input_schema: None,
            },
            McpToolSchema {
                name: "builtin-local_shell_execute".to_string(),
                server_id: None,
                description: None,
                input_schema: None,
            },
        ];

        let filtered = filter_headless_tool_schemas(schemas);
        let names: Vec<&str> = filtered.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["builtin-memory_read"]);
    }

    #[test]
    fn headless_schemas_are_subset_of_whitelist() {
        let allowed = headless_allowed_tools();
        for schema in headless_tool_schemas() {
            assert!(
                allowed.contains(&schema.name),
                "schema '{}' 不在白名单内",
                schema.name
            );
        }
        // 非空保证（filter 自检不应误删任何合法 schema）
        assert!(headless_tool_schemas().len() >= 20);
    }

    // —— 执行层 fail-closed（tool_policy 白名单拦截）—————————————

    #[test]
    fn execution_policy_blocks_non_whitelisted_calls_fail_closed() {
        let allowed = Some(headless_allowed_tools());

        // 依赖前端桥 / 人在场的工具全部被拦截
        assert!(!is_tool_allowed_by_execution_policy(
            "builtin-ask_user",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_execution_policy(
            "builtin-subagent_call",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_execution_policy(
            "builtin-local_shell_execute",
            &json!({}),
            &allowed
        ));
        // 外部 MCP 工具（mcp 前缀 / 带 _serverId 路由标记）被拦截
        assert!(!is_tool_allowed_by_execution_policy(
            "mcp_web_search",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_execution_policy(
            "some_random_tool",
            &json!({ "_serverId": "srv-1" }),
            &allowed
        ));
        // Medium/High 敏感度工具（白名单外）被拦截 → 不会进入审批等待
        assert!(!is_tool_allowed_by_execution_policy(
            "builtin-memory_delete",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_execution_policy(
            "builtin-automation_propose",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_execution_policy(
            "builtin-qbank_reset_progress",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_execution_policy(
            "builtin-review_schedule",
            &json!({}),
            &allowed
        ));

        // 白名单内工具照常放行
        assert!(is_tool_allowed_by_execution_policy(
            "builtin-memory_read",
            &json!({}),
            &allowed
        ));
        assert!(!is_tool_allowed_by_execution_policy(
            "builtin-user_todo_create_item",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_execution_policy(
            "builtin-user_todo_search",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_execution_policy(
            "builtin-qbank_get_stats",
            &json!({}),
            &allowed
        ));
        assert!(is_tool_allowed_by_execution_policy(
            "builtin-review_get_due",
            &json!({}),
            &allowed
        ));
        // 控制类元工具始终放行
        assert!(is_tool_allowed_by_execution_policy(
            "attempt_completion",
            &json!({}),
            &allowed
        ));
    }

    // —— 审批 fail-closed：白名单必须全部是 Low 敏感度 ————————————

    /// 核心安全不变量：headless 无人审批，白名单内任何工具到达敏感度检查时
    /// 必须是 Low（否则会进入审批等待→60s 超时挂起）。
    /// 该测试守护"新工具加入白名单前必须确认 Low 敏感度"的约定。
    #[test]
    fn all_whitelisted_tools_are_low_sensitivity() {
        let registry = whitelist_registry();
        for tool_name in headless_allowed_tools() {
            let sensitivity = registry.get_sensitivity(&tool_name);
            assert_eq!(
                sensitivity,
                Some(ToolSensitivity::Low),
                "白名单工具 '{}' 敏感度必须为 Low（实际: {:?}），否则 headless 下会触发审批挂起",
                tool_name,
                sensitivity
            );
        }
    }

    #[test]
    fn headless_dstu_surface_is_strictly_read_only() {
        let allowed = headless_allowed_tools();
        assert!(allowed.iter().any(|tool| tool == "builtin-dstu_list_trash"));
        for write_tool in [
            "builtin-dstu_folder_create",
            "builtin-dstu_folder_rename",
            "builtin-dstu_rename",
            "builtin-dstu_move",
            "builtin-dstu_delete",
            "builtin-dstu_restore",
            "builtin-dstu_set_favorite",
            "builtin-dstu_purge",
            "builtin-dstu_upload_file",
        ] {
            assert!(
                !allowed.iter().any(|tool| tool == write_tool),
                "DSTU write tool '{}' must remain unavailable headlessly",
                write_tool
            );
        }

        let schema_names: Vec<_> = headless_tool_schemas()
            .into_iter()
            .map(|schema| schema.name)
            .collect();
        assert!(schema_names
            .iter()
            .any(|name| name == "builtin-dstu_list_trash"));
        assert!(!schema_names
            .iter()
            .any(|name| name == "builtin-dstu_set_favorite"));
    }

    #[test]
    fn headless_memory_surface_is_strictly_read_only() {
        let allowed = headless_allowed_tools();
        for read_tool in ["builtin-memory_read", "builtin-memory_list"] {
            assert!(allowed.iter().any(|tool| tool == read_tool), "{read_tool}");
        }
        for write_tool in [
            "builtin-memory_write",
            "builtin-memory_write_smart",
            "builtin-memory_write_batch",
            "builtin-memory_update_by_id",
            "builtin-memory_delete",
            "builtin-memory_batch_move",
            "builtin-memory_add_relation",
            "builtin-memory_remove_relation",
            "builtin-memory_update_tags",
            "builtin-memory_export_all",
        ] {
            assert!(
                !allowed.iter().any(|tool| tool == write_tool),
                "memory mutation or privacy export {write_tool} must remain unavailable headlessly"
            );
        }

        let schema_names: Vec<_> = headless_tool_schemas()
            .into_iter()
            .map(|schema| schema.name)
            .collect();
        assert!(schema_names
            .iter()
            .any(|name| name == "builtin-memory_read"));
        assert!(!schema_names
            .iter()
            .any(|name| name == "builtin-memory_write_smart"));
    }

    #[test]
    fn headless_todo_and_automation_surfaces_are_read_only() {
        let allowed = headless_allowed_tools();
        for read_tool in [
            "builtin-user_todo_list_lists",
            "builtin-user_todo_list_items",
            "builtin-user_todo_get_summary",
            "builtin-user_todo_search",
            "builtin-user_todo_list_trash",
        ] {
            assert!(allowed.iter().any(|tool| tool == read_tool), "{read_tool}");
        }
        for write_tool in [
            "builtin-user_todo_create_item",
            "builtin-user_todo_complete_item",
            "builtin-user_todo_update_item",
            "builtin-user_todo_delete_item",
            "builtin-user_todo_create_list",
            "builtin-user_todo_update_list",
            "builtin-user_todo_delete_list",
            "builtin-user_todo_restore",
            "builtin-user_todo_reorder",
            "builtin-automation_propose",
            "builtin-automation_set_enabled",
            "builtin-automation_update",
            "builtin-automation_delete",
            "builtin-automation_run_now",
        ] {
            assert!(
                !allowed.iter().any(|tool| tool == write_tool),
                "write tool {write_tool} must remain unavailable headlessly"
            );
        }
    }

    // —— 其他辅助 ————————————————————————————————————

    #[test]
    fn truncate_chars_handles_multibyte() {
        assert_eq!(truncate_chars("你好世界", 10), "你好世界");
        assert_eq!(truncate_chars("你好世界", 2), "你好…");
        assert_eq!(truncate_chars("", 5), "");
    }

    #[test]
    fn session_mode_serde_and_parse() {
        assert_eq!(
            serde_json::to_string(&HeadlessSessionMode::Isolated).unwrap(),
            "\"isolated\""
        );
        assert_eq!(
            serde_json::from_str::<HeadlessSessionMode>("\"named\"").unwrap(),
            HeadlessSessionMode::Named
        );
        assert_eq!(
            HeadlessSessionMode::parse("Named").unwrap(),
            HeadlessSessionMode::Named
        );
        assert_eq!(
            HeadlessSessionMode::parse("isolated").unwrap(),
            HeadlessSessionMode::Isolated
        );
        assert!(HeadlessSessionMode::parse("bogus").is_err());
    }

    #[test]
    fn headless_system_prompt_mentions_constraints() {
        let note = headless_system_prompt_note();
        assert!(note.contains("headless"));
        assert!(note.contains("attempt_completion"));
    }

    fn completion_block(status: &str, result: &str, block_index: u32) -> MessageBlock {
        let mut block = MessageBlock::new_tool(
            "msg_headless_test".to_string(),
            "attempt_completion",
            json!({ "result": result }),
            block_index,
        );
        block.status = status.to_string();
        block.tool_output = Some(json!({
            "completed": status == block_status::SUCCESS,
            "result": result,
            "command": null,
            "task_completed": status == block_status::SUCCESS,
        }));
        block
    }

    #[test]
    fn summary_uses_successful_completion_tool_without_content() {
        let blocks = vec![completion_block(
            block_status::SUCCESS,
            "已检查 3 项，均正常",
            0,
        )];

        assert_eq!(summarize_assistant_blocks(&blocks), "已检查 3 项，均正常");
    }

    #[test]
    fn completion_tool_heartbeat_result_remains_silent() {
        let blocks = vec![completion_block(block_status::SUCCESS, "HEARTBEAT_OK", 0)];

        let summary = summarize_assistant_blocks(&blocks);
        assert_eq!(summary, "HEARTBEAT_OK");
        assert!(heartbeat_is_silent(&summary));
    }

    #[test]
    fn summary_ignores_failed_completion_tool_output() {
        let mut content = MessageBlock::new_content("msg_headless_test".to_string(), 0);
        content.status = block_status::SUCCESS.to_string();
        content.content = Some("可用的正文结果".to_string());
        let failed = completion_block(block_status::ERROR, "不应展示的伪结果", 1);

        assert_eq!(
            summarize_assistant_blocks(&[content, failed]),
            "可用的正文结果"
        );
    }

    fn trusted_profile_for_policy_test() -> TrustedAutomationProfile {
        let mut profile = TrustedAutomationProfile {
            schema_version: super::super::automations::TRUSTED_AUTOMATION_PROFILE_SCHEMA_VERSION,
            profile_hash: String::new(),
            allowed_tools: vec![
                "builtin-local_shell_execute".to_string(),
                "builtin-workspace_change_revert".to_string(),
            ],
            runtime_roots: vec![super::super::automations::AutomationRuntimeRoot {
                root_id: "workspace".to_string(),
                access: AutomationRootAccess::ReadWrite,
            }],
            shell_command_prefixes: vec!["curl".to_string(), "unzip".to_string()],
            network_domains: vec!["example.com".to_string()],
            max_tool_rounds: 8,
            timeout_seconds: 300,
            max_output_bytes: 65_536,
            rollback_required: true,
        };
        profile.profile_hash = profile.computed_hash().unwrap();
        profile
    }

    #[test]
    fn aut_06_trusted_profile_enforces_root_prefix_network_output_and_rollback() {
        let profile = trusted_profile_for_policy_test();
        let _guard = TrustedAutomationSessionGuard::install("aut-06", Some(&profile)).unwrap();
        assert!(validate_trusted_automation_tool_call(
            "aut-06",
            "builtin-local_shell_execute",
            &json!({
                "root_id": "workspace",
                "command": "unzip bundle.zip",
                "track_file_changes": true,
                "max_output_bytes": 4096
            })
        )
        .is_ok());
        assert!(validate_trusted_automation_tool_call(
            "aut-06",
            "builtin-local_shell_execute",
            &json!({"root_id":"temp", "command":"unzip bundle.zip", "track_file_changes":true})
        )
        .is_err());
        assert!(validate_trusted_automation_tool_call(
            "aut-06",
            "builtin-local_shell_execute",
            &json!({"root_id":"workspace", "command":"rm -rf out", "track_file_changes":true})
        )
        .is_err());
        assert!(validate_trusted_automation_tool_call(
            "aut-06",
            "builtin-local_shell_execute",
            &json!({"root_id":"workspace", "command":"curl https://evil.test/x", "allow_network":true})
        )
        .is_err());
        assert!(validate_trusted_automation_tool_call(
            "aut-06",
            "builtin-local_shell_execute",
            &json!({"root_id":"workspace", "command":"unzip bundle.zip", "track_file_changes":true, "max_output_bytes":65537})
        )
        .is_err());
    }

    #[test]
    fn aut_07_profile_constrains_web_fetch_and_reads_revert_root_from_receipt() {
        let profile = trusted_profile_for_policy_test();
        let _guard = TrustedAutomationSessionGuard::install("aut-07", Some(&profile)).unwrap();
        assert!(validate_trusted_automation_tool_call(
            "aut-07",
            "builtin-web_fetch",
            &json!({"url":"https://example.com/allowed"})
        )
        .is_ok());
        assert!(validate_trusted_automation_tool_call(
            "aut-07",
            "builtin-web_fetch",
            &json!({"url":"https://outside.test/blocked"})
        )
        .is_err());
        assert!(validate_trusted_automation_tool_call(
            "aut-07",
            "builtin-workspace_change_revert",
            &json!({"receipt":{"root_id":"workspace", "path":"notes/a.md"}})
        )
        .is_ok());

        drop(_guard);
        assert!(validate_trusted_automation_tool_call(
            "ordinary-session",
            "builtin-local_shell_execute",
            &json!({})
        )
        .is_ok());
    }

    // —— trusted automation 预授权旁路（ApprovalManager bypass）——————————

    #[test]
    fn preauthorization_denies_sessions_without_trusted_profile() {
        // 未安装 profile 的会话（含普通交互会话）恒不预授权（fail-closed）
        assert!(!is_trusted_automation_preauthorized(
            "no-profile-session",
            "builtin-local_shell_execute",
            &json!({
                "root_id": "workspace",
                "command": "unzip bundle.zip",
                "track_file_changes": true,
                "max_output_bytes": 4096
            })
        ));
    }

    #[test]
    fn preauthorization_allows_fully_validated_profile_call() {
        let profile = trusted_profile_for_policy_test();
        let _guard = TrustedAutomationSessionGuard::install("preauth-ok", Some(&profile)).unwrap();
        assert!(is_trusted_automation_preauthorized(
            "preauth-ok",
            "builtin-local_shell_execute",
            &json!({
                "root_id": "workspace",
                "command": "unzip bundle.zip",
                "track_file_changes": true,
                "max_output_bytes": 4096
            })
        ));
        // 回滚工具本身也可预授权（receipt 里携带合法 root）
        assert!(is_trusted_automation_preauthorized(
            "preauth-ok",
            "builtin-workspace_change_revert",
            &json!({ "receipt": { "root_id": "workspace", "path": "notes/a.md" } })
        ));
    }

    #[test]
    fn preauthorization_denies_calls_outside_profile_allowed_tools() {
        let profile = trusted_profile_for_policy_test();
        let _guard =
            TrustedAutomationSessionGuard::install("preauth-scope", Some(&profile)).unwrap();
        // headless 只读白名单工具不在 profile.allowed_tools → 不预授权
        // （它们是 Low 敏感度，本就不进 ApprovalManager，预授权面保持最小）
        assert!(!is_trusted_automation_preauthorized(
            "preauth-scope",
            "builtin-web_fetch",
            &json!({ "url": "https://example.com/x" })
        ));
    }

    #[test]
    fn preauthorization_denies_calls_failing_profile_validation() {
        let profile = trusted_profile_for_policy_test();
        let _guard =
            TrustedAutomationSessionGuard::install("preauth-invalid", Some(&profile)).unwrap();
        // root 越界
        assert!(!is_trusted_automation_preauthorized(
            "preauth-invalid",
            "builtin-local_shell_execute",
            &json!({
                "root_id": "temp",
                "command": "unzip bundle.zip",
                "track_file_changes": true,
                "max_output_bytes": 4096
            })
        ));
        // 前缀越界
        assert!(!is_trusted_automation_preauthorized(
            "preauth-invalid",
            "builtin-local_shell_execute",
            &json!({
                "root_id": "workspace",
                "command": "rm -rf out",
                "track_file_changes": true,
                "max_output_bytes": 4096
            })
        ));
    }

    #[test]
    fn preauthorization_requires_rollback_evidence_for_write_tools() {
        let profile = trusted_profile_for_policy_test();
        assert!(profile.rollback_required);
        let _guard =
            TrustedAutomationSessionGuard::install("preauth-rollback", Some(&profile)).unwrap();
        // rollback_required 下缺少 track_file_changes 的 shell 写工具 → 保守回退审批
        assert!(!is_trusted_automation_preauthorized(
            "preauth-rollback",
            "builtin-local_shell_execute",
            &json!({
                "root_id": "workspace",
                "command": "unzip bundle.zip",
                "max_output_bytes": 4096
            })
        ));
    }

    #[test]
    fn whitelist_lookup_set_matches_vec() {
        for tool in headless_allowed_tools() {
            assert!(is_headless_allowed_tool(&tool), "{tool} 应在白名单查找集内");
        }
        assert!(!is_headless_allowed_tool("builtin-local_shell_execute"));
        assert!(!is_headless_allowed_tool("mcp_anything"));
    }

    #[test]
    fn session_turn_timeout_is_clamped_defensively() {
        use std::time::Duration;
        assert_eq!(
            clamp_session_turn_timeout(Duration::from_secs(0), "s"),
            Duration::from_secs(1)
        );
        assert_eq!(
            clamp_session_turn_timeout(Duration::from_millis(200), "s"),
            Duration::from_secs(1)
        );
        assert_eq!(
            clamp_session_turn_timeout(Duration::from_secs(300), "s"),
            Duration::from_secs(300)
        );
        assert_eq!(
            clamp_session_turn_timeout(Duration::from_secs(MAX_HARD_TIMEOUT_SECS + 1), "s"),
            Duration::from_secs(MAX_HARD_TIMEOUT_SECS)
        );
    }

    #[test]
    fn panic_message_extracts_common_payload_types() {
        let boxed: Box<dyn std::any::Any + Send> = Box::new("static str panic");
        assert_eq!(panic_message(boxed.as_ref()), "static str panic");
        let boxed: Box<dyn std::any::Any + Send> = Box::new("owned panic".to_string());
        assert_eq!(panic_message(boxed.as_ref()), "owned panic");
        let boxed: Box<dyn std::any::Any + Send> = Box::new(42_u32);
        assert_eq!(panic_message(boxed.as_ref()), "non-string panic payload");
    }

    #[test]
    fn conclude_pipeline_result_maps_all_terminations() {
        assert!(conclude_pipeline_result(Ok(Ok("msg_1".to_string())), "s").is_ok());
        assert!(matches!(
            conclude_pipeline_result(Ok(Err(ChatV2Error::Cancelled)), "s"),
            Err(HeadlessPipelineTermination::Cancelled)
        ));
        assert!(matches!(
            conclude_pipeline_result(Ok(Err(ChatV2Error::Other("boom".to_string()))), "s"),
            Err(HeadlessPipelineTermination::Failed(message)) if message.contains("boom")
        ));
        let payload: Box<dyn std::any::Any + Send> = Box::new("pipeline exploded".to_string());
        assert!(matches!(
            conclude_pipeline_result(Err(payload), "s"),
            Err(HeadlessPipelineTermination::Failed(message))
                if message.contains("panicked") && message.contains("pipeline exploded")
        ));
    }

    #[test]
    fn rollback_availability_matrix_is_conservative() {
        assert!(trusted_write_tool_rollback_available(
            "workspace_file_write",
            &json!({})
        ));
        assert!(trusted_write_tool_rollback_available(
            "workspace_change_revert",
            &json!({})
        ));
        assert!(trusted_write_tool_rollback_available(
            "local_shell_execute",
            &json!({ "track_file_changes": true })
        ));
        assert!(!trusted_write_tool_rollback_available(
            "local_shell_execute",
            &json!({})
        ));
        // 无已实现回滚路径的写工具一律不可用（宁可保守）
        assert!(!trusted_write_tool_rollback_available(
            "attachment_stage",
            &json!({})
        ));
    }
}
