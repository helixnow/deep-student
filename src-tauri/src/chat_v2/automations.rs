//! Chat V2 周期自动化：定义存储、到期判定与后台调度器。
//!
//! v1：到点发送系统通知 + 创建带 reminder 的用户待办。
//! v2（2026-07-08）：新增 `action_type: notify | agent_turn`——`agent_turn`
//! 到点在隔离会话上真跑一轮 headless agent（见 `chat_v2/headless.rs`），
//! 完成后发系统通知（成功/失败摘要）；另内置可选的 Heartbeat 心跳自动化
//! （interval 调度，模型无事输出 `HEARTBEAT_OK` 时静默吞掉不打扰用户）。
//!
//! 存储说明：定义与运行记录分别持久化在 `automation_definitions` 和
//! `automation_runs`；旧 settings JSON 只作为一次性迁移源和回滚快照保留。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use rand::Rng;
use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

use crate::chat_v2::headless::{run_headless_turn, HeadlessSessionMode, HeadlessTurnRequest};
use crate::database::Database;
use crate::models::{AppError, AppErrorType};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsTodoRepo;
use crate::vfs::types::VfsCreateTodoItemParams;

pub const AUTOMATIONS_KEY: &str = "chat_v2.automations";
pub const AUTOMATIONS_CHANGED_EVENT: &str = "chat_v2://automations_changed";

pub const MAX_AUTOMATIONS: usize = 20;
pub const MAX_PROMPT_LEN: usize = 4000;
pub const MAX_NAME_LEN: usize = 100;
pub const MAX_RUN_HISTORY: usize = 50;
pub const MAX_STORED_RUNS_PER_AUTOMATION: usize = 200;
pub const AUTOMATION_BACKGROUND_KEY: &str = "chat_v2.automation_background_enabled";
pub const AUTOMATION_LEGACY_MIGRATED_KEY: &str = "chat_v2.automations_table_migrated";
pub const SCHEDULER_POLL_SECS: u64 = 15;
/// catch_up_all 单 tick 单任务最多补跑的错过槽位数（防长离线补齐过慢）
pub const CATCH_UP_BATCH: usize = 5;
pub const DEFAULT_MAX_RETRIES: u8 = 2;
pub const DEFAULT_RETRY_BACKOFF_SECS: u64 = 60;
/// 单次重试退避的上限（24 小时）：防止较大的 retry_backoff_seconds 基数
/// 经指数放大后把下一次尝试推迟到数天之后。
pub const MAX_RETRY_BACKOFF_SECS: u64 = 86_400;
pub const DEFAULT_TIMEOUT_SECS: u64 = 600;
pub const AUTOMATION_VERSION_CONFLICT_CODE: &str = "AUTOMATION_VERSION_CONFLICT";
const AUTOMATION_LEASE_GRACE_SECS: u64 = 60;

static AUTOMATION_APP_EXITING: AtomicBool = AtomicBool::new(false);
static AUTOMATION_SHUTDOWN_TOKEN: LazyLock<CancellationToken> =
    LazyLock::new(CancellationToken::new);
static AUTOMATION_BOOT_ID: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());
/// Kill Switch / 用户显式暂停：调度器仍存活，但跳过一切派发。
static AUTOMATION_SCHEDULER_PAUSED: AtomicBool = AtomicBool::new(false);

pub fn mark_automation_app_exiting() {
    AUTOMATION_APP_EXITING.store(true, Ordering::SeqCst);
    AUTOMATION_SHUTDOWN_TOKEN.cancel();
    cancel_active_automation_runs_for_shutdown();
}

pub fn automation_app_is_exiting() -> bool {
    AUTOMATION_APP_EXITING.load(Ordering::SeqCst)
}

/// Pause the automation scheduler (used by Kill Switch emergency_stop).
pub fn pause_automation_scheduler() {
    AUTOMATION_SCHEDULER_PAUSED.store(true, Ordering::SeqCst);
    tracing::warn!("[AutomationScheduler] paused (kill switch / emergency stop)");
}

/// Resume scheduled automation dispatch (explicit user confirmation after Kill Switch).
pub fn resume_automation_scheduler() {
    AUTOMATION_SCHEDULER_PAUSED.store(false, Ordering::SeqCst);
    tracing::info!("[AutomationScheduler] resumed");
}

pub fn is_automation_scheduler_paused() -> bool {
    AUTOMATION_SCHEDULER_PAUSED.load(Ordering::SeqCst)
}

/// Whether tick / run_now may dispatch work. False while paused or app exiting.
pub fn automation_dispatch_allowed() -> bool {
    !is_automation_scheduler_paused() && !automation_app_is_exiting()
}

/// interval 调度允许的分钟数范围
pub const MIN_INTERVAL_MINUTES: u32 = 5;
pub const MAX_INTERVAL_MINUTES: u32 = 24 * 60;

/// 预置心跳自动化的固定 ID（幂等创建的判据之一）
pub const HEARTBEAT_AUTOMATION_ID: &str = "auto_heartbeat_default";
/// 心跳默认间隔（分钟）
pub const DEFAULT_HEARTBEAT_INTERVAL_MINUTES: u32 = 30;
/// 心跳"无事"哨兵串：最终回复仅为该串时静默吞掉、不发任何通知
pub const HEARTBEAT_OK_SENTINEL: &str = "HEARTBEAT_OK";

/// 默认心跳检查清单 prompt（v1 硬编码模板，后续可做成用户可编辑文件）。
/// 注意：只引用 headless 白名单内的工具（见 `headless::headless_allowed_tools`）。
pub const DEFAULT_HEARTBEAT_PROMPT: &str = "\
你是 Deep Student 的后台心跳检查代理。请依次检查以下清单（只使用可用的只读工具，工具不可用则跳过该项）：\n\
1. 用 builtin-user_todo_get_summary 检查今天到期或已逾期的待办事项；\n\
2. 用 builtin-qbank_list（include_stats=true）留意最近 3 天没有练习记录、或错误率偏高需要复习的题库/错题本；\n\
3. 如需补充上下文，可用 builtin-unified_search 搜索相关学习记录。\n\
输出规则：\n\
- 如果所有检查都没有需要用户关注的事项，只输出 HEARTBEAT_OK，不要输出任何其他内容；\n\
- 如果有需要关注的事项，用简洁中文逐条列出（数量 + 建议动作），且不要出现 HEARTBEAT_OK 字样；\n\
- 不要向用户提问，不要执行任何写操作或高敏感操作。";

type Result<T> = std::result::Result<T, AppError>;

fn automation_version_conflict_error(
    automation_id: &str,
    expected_version: u64,
    current: &AutomationDefinition,
) -> AppError {
    AppError::with_details(
        AppErrorType::Conflict,
        "Automation changed after it was read. Refresh the automation list and retry with the current version.",
        json!({
            "code": AUTOMATION_VERSION_CONFLICT_CODE,
            "automationId": automation_id,
            "expectedVersion": expected_version,
            "currentVersion": current.version,
            "current": automation_to_list_item(current, Local::now()),
            "retryable": true,
        }),
    )
}

pub fn serialize_automation_update_error(error: AppError, agent_facing: bool) -> String {
    let AppError {
        error_type,
        message,
        details,
    } = error;
    if !matches!(error_type, AppErrorType::Conflict) {
        return message;
    }

    let mut payload = details.unwrap_or_else(|| json!({}));
    if agent_facing {
        if let Some(current) = payload.get_mut("current").and_then(Value::as_object_mut) {
            let mut fields_truncated = Vec::new();
            for field in ["prompt", "agent_prompt"] {
                let Some(source) = current.get(field).and_then(Value::as_str) else {
                    continue;
                };
                let (bounded, truncated) = truncate_agent_text(source);
                current.insert(field.to_string(), json!(bounded));
                if truncated {
                    fields_truncated.push(field);
                }
            }
            current.insert(
                "promptTruncated".to_string(),
                json!(!fields_truncated.is_empty()),
            );
            current.insert("fieldsTruncated".to_string(), json!(fields_truncated));
        }
    }
    if let Some(object) = payload.as_object_mut() {
        object
            .entry("code".to_string())
            .or_insert_with(|| json!(AUTOMATION_VERSION_CONFLICT_CODE));
        object.insert("errorType".to_string(), json!("conflict"));
        object.insert("message".to_string(), json!(message.clone()));
    }
    serde_json::to_string(&payload).unwrap_or(message)
}

/// UI command 层统一错误载荷：`{"code":"...","message":"..."}` JSON 字符串。
///
/// - Conflict → 走 `serialize_automation_update_error`（保留前端已依赖的
///   `AUTOMATION_VERSION_CONFLICT` code 与 details 结构）
/// - 其余错误按 `AppErrorType` 映射稳定 code，与 ChatV2Error 的命令契约对齐
pub fn automation_command_error(error: AppError) -> String {
    if matches!(error.error_type, AppErrorType::Conflict) {
        return serialize_automation_update_error(error, false);
    }
    let code = match error.error_type {
        AppErrorType::Validation => "VALIDATION_ERROR",
        AppErrorType::Database => "DATABASE_ERROR",
        AppErrorType::NotFound => "NOT_FOUND",
        AppErrorType::Network => "NETWORK_ERROR",
        AppErrorType::FileSystem => "IO_ERROR",
        AppErrorType::LLM => "LLM_ERROR",
        AppErrorType::Configuration => "CONFIGURATION_ERROR",
        AppErrorType::Conflict | AppErrorType::Unknown => "AUTOMATION_ERROR",
    };
    serde_json::to_string(&json!({ "code": code, "message": error.message }))
        .unwrap_or(error.message)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    #[default]
    Daily,
    Weekly,
    Weekdays,
    Monthly,
    /// 周期间隔调度（每 N 分钟），供心跳等场景使用
    Interval,
    /// 一次性任务：在 `date` + `time`（`timezone` 或系统本地时区）执行一次，
    /// 触发即消耗（claim 时 next_run_at 置 NULL），成功终态后自动 enabled=0
    Once,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CatchUpPolicy {
    Skip,
    #[default]
    RunOnce,
    CatchUpAll,
}

impl CatchUpPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skip => "skip",
            Self::RunOnce => "run_once",
            Self::CatchUpAll => "catch_up_all",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "skip" => Ok(Self::Skip),
            "run_once" => Ok(Self::RunOnce),
            "catch_up_all" => Ok(Self::CatchUpAll),
            other => Err(AppError::validation(format!(
                "Invalid catch_up_policy '{}'. Allowed: skip, run_once, catch_up_all",
                other
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutomationSchedule {
    pub kind: ScheduleKind,
    /// 24h `HH:MM`（daily/weekly 必填；interval 可为空）
    #[serde(default)]
    pub time: String,
    /// 0=Sunday … 6=Saturday (required when kind=weekly, unless `weekdays` is set)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekday: Option<u8>,
    /// weekly 调度的一周多天扩展（编号口径与 `weekday` 完全一致：0=Sunday … 6=Saturday）。
    /// 与单数 `weekday` 同时存在时以 `weekdays` 优先；缺失时行为与旧版单日一致，
    /// 存量 schedule JSON 无该字段可原样解析（serde default = None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekdays: Option<Vec<u8>>,
    /// monthly 调度的日期（1-31；短月份自动落在该月最后一天）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_of_month: Option<u8>,
    /// 间隔分钟数（kind=interval 必填，范围 5–1440）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
    /// 一次性任务日期 `YYYY-MM-DD`（kind=once 必填）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// IANA 时区，例如 Asia/Shanghai；为空时兼容旧数据并使用系统本地时区。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

/// 到点动作类型（serde default = notify，向后兼容旧存量 JSON）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AutomationActionType {
    /// 仅发系统通知 + 建待办（v1 行为）
    #[default]
    Notify,
    /// 创建隔离会话并真跑一轮 headless agent turn
    AgentTurn,
}

pub const TRUSTED_AUTOMATION_PROFILE_SCHEMA_VERSION: u16 = 1;
pub const TRUSTED_AUTOMATION_MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRootAccess {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRuntimeRoot {
    pub root_id: String,
    pub access: AutomationRootAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedAutomationProfile {
    pub schema_version: u16,
    pub profile_hash: String,
    pub allowed_tools: Vec<String>,
    pub runtime_roots: Vec<AutomationRuntimeRoot>,
    pub shell_command_prefixes: Vec<String>,
    pub network_domains: Vec<String>,
    pub max_tool_rounds: u32,
    pub timeout_seconds: u64,
    pub max_output_bytes: u64,
    pub rollback_required: bool,
}

impl TrustedAutomationProfile {
    pub fn computed_hash(&self) -> Result<String> {
        let mut canonical = self.clone();
        canonical.profile_hash.clear();
        let bytes = serde_json::to_vec(&canonical).map_err(|error| {
            AppError::internal(format!("Failed to hash automation profile: {error}"))
        })?;
        Ok(hex::encode(Sha256::digest(bytes)))
    }

    pub fn seal(mut self) -> Result<Self> {
        if self.profile_hash.trim().is_empty() {
            self.profile_hash = self.computed_hash()?;
        }
        self.validate()?;
        Ok(self)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != TRUSTED_AUTOMATION_PROFILE_SCHEMA_VERSION {
            return Err(AppError::validation(
                "Unsupported trusted automation profile schema version".to_string(),
            ));
        }
        if self.profile_hash.len() != 64
            || !self
                .profile_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.computed_hash()? != self.profile_hash.to_ascii_lowercase()
        {
            return Err(AppError::validation(
                "Trusted automation profile hash does not match its contents".to_string(),
            ));
        }
        validate_sorted_unique_nonempty(&self.allowed_tools, "allowed_tools")?;
        validate_sorted_unique(&self.shell_command_prefixes, "shell_command_prefixes")?;
        validate_sorted_unique(&self.network_domains, "network_domains")?;
        if self.runtime_roots.is_empty() {
            return Err(AppError::validation(
                "runtime_roots must not be empty".to_string(),
            ));
        }
        let supported_tools = trusted_profile_supported_extra_tools();
        if let Some(tool) = self
            .allowed_tools
            .iter()
            .find(|tool| !supported_tools.contains(tool.as_str()))
        {
            return Err(AppError::validation(format!(
                "Tool '{tool}' is not eligible for trusted automation"
            )));
        }
        if self.allowed_tools.iter().any(|tool| {
            matches!(
                tool.as_str(),
                "builtin-local_shell_execute" | "builtin-local_shell_preflight"
            )
        }) && self.shell_command_prefixes.is_empty()
        {
            return Err(AppError::validation(
                "Trusted automation shell tools require shell_command_prefixes".to_string(),
            ));
        }
        let mut previous_root = None;
        for root in &self.runtime_roots {
            let id = root.root_id.trim();
            if id != root.root_id || id.is_empty() || id.contains('/') || id.contains('\\') {
                return Err(AppError::validation(
                    "runtime root ids must be normalized identifiers".to_string(),
                ));
            }
            if previous_root.is_some_and(|previous: &str| previous >= id) {
                return Err(AppError::validation(
                    "runtime_roots must be sorted and unique".to_string(),
                ));
            }
            if id.starts_with("authorized_") && root.access == AutomationRootAccess::ReadWrite {
                return Err(AppError::validation(
                    "authorized runtime roots are always read-only".to_string(),
                ));
            }
            if !matches!(id, "workspace" | "artifacts" | "temp") && !id.starts_with("authorized_") {
                return Err(AppError::validation(format!(
                    "Unsupported automation runtime root '{id}'"
                )));
            }
            previous_root = Some(id);
        }
        for prefix in &self.shell_command_prefixes {
            if prefix.trim() != prefix
                || prefix.is_empty()
                || prefix
                    .chars()
                    .any(|ch| matches!(ch, ';' | '|' | '&' | '>' | '<' | '\n' | '\r' | '`'))
                || prefix.contains("$(")
            {
                return Err(AppError::validation(format!(
                    "Unsafe shell command prefix '{prefix}'"
                )));
            }
        }
        for domain in &self.network_domains {
            let bare = domain.strip_prefix("*.").unwrap_or(domain);
            if domain != &domain.to_ascii_lowercase()
                || bare.is_empty()
                || bare.starts_with('.')
                || bare.ends_with('.')
                || !bare
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
            {
                return Err(AppError::validation(format!(
                    "Invalid network domain '{domain}'"
                )));
            }
        }
        if !(1..=30).contains(&self.max_tool_rounds) {
            return Err(AppError::validation(
                "max_tool_rounds must be between 1 and 30".to_string(),
            ));
        }
        if !(30..=3_600).contains(&self.timeout_seconds) {
            return Err(AppError::validation(
                "profile timeout_seconds must be between 30 and 3600".to_string(),
            ));
        }
        if self.max_output_bytes == 0 || self.max_output_bytes > TRUSTED_AUTOMATION_MAX_OUTPUT_BYTES
        {
            return Err(AppError::validation(
                "max_output_bytes is outside the trusted automation limit".to_string(),
            ));
        }
        let has_write = self
            .allowed_tools
            .iter()
            .any(|tool| trusted_profile_write_tool(tool))
            || self
                .runtime_roots
                .iter()
                .any(|root| root.access == AutomationRootAccess::ReadWrite);
        if has_write && !self.rollback_required {
            return Err(AppError::validation(
                "Trusted automation write access requires rollback_required=true".to_string(),
            ));
        }
        Ok(())
    }
}

fn validate_sorted_unique(values: &[String], field: &str) -> Result<()> {
    if values
        .iter()
        .any(|value| value.trim() != value || value.is_empty())
        || values.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(AppError::validation(format!(
            "{field} must be normalized, sorted, and unique"
        )));
    }
    Ok(())
}

fn validate_sorted_unique_nonempty(values: &[String], field: &str) -> Result<()> {
    if values.is_empty() {
        return Err(AppError::validation(format!("{field} must not be empty")));
    }
    validate_sorted_unique(values, field)
}

pub fn trusted_profile_supported_extra_tools() -> HashSet<&'static str> {
    HashSet::from([
        "builtin-attachment_stage",
        "builtin-local_shell_execute",
        "builtin-local_shell_preflight",
        "builtin-workspace_artifact_write",
        "builtin-workspace_change_revert",
        "builtin-workspace_file_delete",
        "builtin-workspace_file_list",
        "builtin-workspace_file_move",
        "builtin-workspace_file_read",
        "builtin-workspace_file_write",
    ])
}

pub fn trusted_profile_write_tool(tool: &str) -> bool {
    matches!(
        tool.strip_prefix("builtin-").unwrap_or(tool),
        "attachment_stage"
            | "local_shell_execute"
            | "workspace_artifact_write"
            | "workspace_change_revert"
            | "workspace_file_delete"
            | "workspace_file_move"
            | "workspace_file_write"
    )
}

impl AutomationActionType {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "notify" => Ok(Self::Notify),
            "agent_turn" => Ok(Self::AgentTurn),
            other => Err(AppError::validation(format!(
                "Invalid action_type '{}'. Allowed: notify, agent_turn",
                other
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutomationDefinition {
    pub id: String,
    pub name: String,
    pub schedule: AutomationSchedule,
    pub prompt: String,
    pub enabled: bool,
    pub created_at: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    /// 到点动作类型（默认 notify，旧记录反序列化自动兼容）
    #[serde(default)]
    pub action_type: AutomationActionType,
    /// 是否是心跳自动化（最终回复含 HEARTBEAT_OK 时静默、不发通知）
    #[serde(default)]
    pub heartbeat: bool,
    /// agent_turn 专用：独立的 agent 任务提示词（缺省回退到 prompt）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_prompt: Option<String>,
    /// agent_turn 专用：会话模式（isolated=每次新建 / named=固定会话跨运行积累上下文，
    /// 如"每周学情报告"；默认 isolated）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_mode: Option<HeadlessSessionMode>,
    /// agent_turn 专用：指定模型（None 走默认对话模型）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// named 模式实际使用的会话 ID（首次运行后由调度器回存，跨运行复用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub catch_up_policy: CatchUpPolicy,
    #[serde(default = "default_max_retries")]
    pub max_retries: u8,
    #[serde(default = "default_retry_backoff_seconds")]
    pub retry_backoff_seconds: u64,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_profile: Option<TrustedAutomationProfile>,
    /// Optimistic-lock revision for user-editable configuration. Runtime
    /// bookkeeping such as last/next run timestamps must not bump this value.
    #[serde(default = "default_version")]
    pub version: u64,
}

const fn default_max_retries() -> u8 {
    DEFAULT_MAX_RETRIES
}

const fn default_retry_backoff_seconds() -> u64 {
    DEFAULT_RETRY_BACKOFF_SECS
}

const fn default_timeout_seconds() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

const fn default_version() -> u64 {
    1
}

/// agent_turn 实际使用的提示词：agent_prompt 非空优先，否则回退 prompt
pub fn effective_agent_prompt(automation: &AutomationDefinition) -> String {
    automation
        .agent_prompt
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| automation.prompt.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutomationRunRecord {
    #[serde(default)]
    pub id: String,
    pub automation_id: String,
    pub fired_at: String,
    pub delivered: Vec<String>,
    /// agent_turn 运行产生的隔离会话 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 运行结果状态（success / error / timeout / heartbeat_ok / spawn_error）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default)]
    pub trigger_type: String,
    #[serde(default)]
    pub scheduled_for: String,
    #[serde(default = "default_run_attempt")]
    pub attempt: u32,
    #[serde(default = "default_run_attempt")]
    pub max_attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 追加字段（前端可忽略）：run 执行时长（毫秒，finished_at - started_at）。
    /// 由查询侧派生，不落库；未完成的 run 为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

const fn default_run_attempt() -> u32 {
    1
}

/// 从 started_at / finished_at 派生 run 时长（毫秒）；任一缺失或不可解析返回 None。
fn run_duration_ms(started_at: Option<&str>, finished_at: Option<&str>) -> Option<i64> {
    let started = DateTime::parse_from_rfc3339(started_at?).ok()?;
    let finished = DateTime::parse_from_rfc3339(finished_at?).ok()?;
    Some(
        finished
            .signed_duration_since(started)
            .num_milliseconds()
            .max(0),
    )
}

pub fn parse_time_hhmm(raw: &str) -> Result<NaiveTime> {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    let is_strict_hhmm = bytes.len() == 5
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[2] == b':'
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit();

    if !is_strict_hhmm {
        return Err(AppError::validation(format!(
            "Invalid time '{}': expected HH:MM (24h)",
            raw
        )));
    }

    NaiveTime::parse_from_str(trimmed, "%H:%M")
        .map_err(|_| AppError::validation(format!("Invalid time '{}': expected HH:MM (24h)", raw)))
}

/// once 调度允许的过期宽限：创建/更新时目标时刻最多可比当前时间早 1 分钟
const ONCE_PAST_GRACE_SECS: i64 = 60;

/// 解析 once 调度的目标日期（`YYYY-MM-DD`）
fn parse_once_date(schedule: &AutomationSchedule) -> Result<NaiveDate> {
    let raw = schedule
        .date
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::validation("date (YYYY-MM-DD) is required for once schedule".to_string())
        })?;
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| AppError::validation(format!("Invalid date '{}': expected YYYY-MM-DD", raw)))
}

/// weekly 调度实际生效的星期集合：非空 `weekdays` 优先（去重后升序返回），
/// 否则回退单数 `weekday` 的单元素集合；两者皆缺返回 None。
/// 编号口径统一为 0=Sunday … 6=Saturday（chrono `num_days_from_sunday`）。
fn weekly_effective_weekdays(schedule: &AutomationSchedule) -> Option<Vec<u8>> {
    if let Some(weekdays) = schedule.weekdays.as_ref() {
        if !weekdays.is_empty() {
            let mut sorted = weekdays.clone();
            sorted.sort_unstable();
            sorted.dedup();
            return Some(sorted);
        }
    }
    schedule.weekday.map(|weekday| vec![weekday])
}

/// weekdays 数组的通用校验（值域 0–6、非空、无重复）。
fn validate_weekdays_list(weekdays: &[u8]) -> Result<()> {
    if weekdays.is_empty() {
        return Err(AppError::validation(
            "weekdays must not be empty (0=Sunday … 6=Saturday)".to_string(),
        ));
    }
    if weekdays.iter().any(|weekday| *weekday > 6) {
        return Err(AppError::validation(
            "weekdays values must be between 0 (Sunday) and 6 (Saturday)".to_string(),
        ));
    }
    let mut deduped = weekdays.to_vec();
    deduped.sort_unstable();
    deduped.dedup();
    if deduped.len() != weekdays.len() {
        return Err(AppError::validation(
            "weekdays must not contain duplicates".to_string(),
        ));
    }
    Ok(())
}

/// 入库前的 weekly 形状规范化（在 `validate_schedule` 通过后调用，只整形不校验）：
/// - `weekdays` 去重升序；
/// - 单元素集合收敛为纯 `weekday` 形态（与存量单日数据形状一致）；
/// - 多元素时 `weekday` 同步为集合最小值——这是降级安全的关键：旧版本二进制
///   反序列化时忽略未知的 `weekdays` 字段，必须能读到单数 `weekday` 才不会把
///   weekly 调度判成"missing weekday"。前端编辑器遵循同一约定，此处兜底
///   agent 工具/命令请求等未附带 `weekday` 的入口。
pub fn normalize_schedule_shape(schedule: &mut AutomationSchedule) {
    if schedule.kind != ScheduleKind::Weekly {
        return;
    }
    let Some(mut weekdays) = schedule.weekdays.take() else {
        return;
    };
    weekdays.sort_unstable();
    weekdays.dedup();
    match weekdays.len() {
        0 => {}
        1 => schedule.weekday = Some(weekdays[0]),
        _ => {
            schedule.weekday = Some(weekdays[0]);
            schedule.weekdays = Some(weekdays);
        }
    }
}

pub fn validate_schedule(schedule: &AutomationSchedule) -> Result<()> {
    if let Some(timezone) = schedule.timezone.as_deref() {
        timezone
            .parse::<Tz>()
            .map_err(|_| AppError::validation(format!("Invalid IANA timezone '{}'", timezone)))?;
    }
    if schedule.kind != ScheduleKind::Once && schedule.date.is_some() {
        return Err(AppError::validation(
            "date is only allowed for once schedule".to_string(),
        ));
    }
    if schedule.kind != ScheduleKind::Weekly && schedule.weekdays.is_some() {
        return Err(AppError::validation(
            "weekdays is only allowed for weekly schedule".to_string(),
        ));
    }
    match schedule.kind {
        ScheduleKind::Daily => {
            parse_time_hhmm(&schedule.time)?;
            if schedule.weekday.is_some() {
                return Err(AppError::validation(
                    "weekday must not be set for daily schedule".to_string(),
                ));
            }
            if schedule.interval_minutes.is_some() {
                return Err(AppError::validation(
                    "interval_minutes must not be set for daily schedule".to_string(),
                ));
            }
            if schedule.day_of_month.is_some() {
                return Err(AppError::validation(
                    "day_of_month must not be set for daily schedule".to_string(),
                ));
            }
        }
        ScheduleKind::Weekly => {
            parse_time_hhmm(&schedule.time)?;
            // 多天扩展：weekdays 优先；仅有单数 weekday 时行为与旧版一致
            if let Some(weekdays) = schedule.weekdays.as_ref() {
                validate_weekdays_list(weekdays)?;
            } else {
                let weekday = schedule.weekday.ok_or_else(|| {
                    AppError::validation(
                        "weekday is required for weekly schedule (0=Sun … 6=Sat)".to_string(),
                    )
                })?;
                if weekday > 6 {
                    return Err(AppError::validation(
                        "weekday must be between 0 (Sunday) and 6 (Saturday)".to_string(),
                    ));
                }
            }
            // weekdays 与 weekday 并存时，weekday 也做值域校验（避免落库脏数据）
            if schedule.weekdays.is_some() {
                if let Some(weekday) = schedule.weekday {
                    if weekday > 6 {
                        return Err(AppError::validation(
                            "weekday must be between 0 (Sunday) and 6 (Saturday)".to_string(),
                        ));
                    }
                }
            }
            if schedule.interval_minutes.is_some() {
                return Err(AppError::validation(
                    "interval_minutes must not be set for weekly schedule".to_string(),
                ));
            }
            if schedule.day_of_month.is_some() {
                return Err(AppError::validation(
                    "day_of_month must not be set for weekly schedule".to_string(),
                ));
            }
        }
        ScheduleKind::Weekdays => {
            parse_time_hhmm(&schedule.time)?;
            if schedule.weekday.is_some()
                || schedule.interval_minutes.is_some()
                || schedule.day_of_month.is_some()
            {
                return Err(AppError::validation(
                    "weekdays schedule only accepts time and timezone".to_string(),
                ));
            }
        }
        ScheduleKind::Monthly => {
            parse_time_hhmm(&schedule.time)?;
            let day = schedule.day_of_month.ok_or_else(|| {
                AppError::validation("day_of_month is required for monthly schedule".to_string())
            })?;
            if !(1..=31).contains(&day) {
                return Err(AppError::validation(
                    "day_of_month must be between 1 and 31".to_string(),
                ));
            }
            if schedule.weekday.is_some() || schedule.interval_minutes.is_some() {
                return Err(AppError::validation(
                    "weekday and interval_minutes must not be set for monthly schedule".to_string(),
                ));
            }
        }
        ScheduleKind::Interval => {
            if !schedule.time.trim().is_empty() || schedule.timezone.is_some() {
                return Err(AppError::validation(
                    "interval schedule does not accept time or timezone".to_string(),
                ));
            }
            if schedule.weekday.is_some() {
                return Err(AppError::validation(
                    "weekday must not be set for interval schedule".to_string(),
                ));
            }
            if schedule.day_of_month.is_some() {
                return Err(AppError::validation(
                    "day_of_month must not be set for interval schedule".to_string(),
                ));
            }
            let minutes = schedule.interval_minutes.ok_or_else(|| {
                AppError::validation(
                    "interval_minutes is required for interval schedule".to_string(),
                )
            })?;
            if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&minutes) {
                return Err(AppError::validation(format!(
                    "interval_minutes must be between {} and {}",
                    MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES
                )));
            }
        }
        ScheduleKind::Once => {
            parse_time_hhmm(&schedule.time)?;
            let date = parse_once_date(schedule)?;
            if schedule.weekday.is_some()
                || schedule.interval_minutes.is_some()
                || schedule.day_of_month.is_some()
            {
                return Err(AppError::validation(
                    "once schedule only accepts date, time, and timezone".to_string(),
                ));
            }
            // 创建/更新时拒绝已经过期超过 1 分钟的一次性任务
            let slot = scheduled_slot_on_date(schedule, date)?.ok_or_else(|| {
                AppError::internal("Failed to resolve once schedule slot".to_string())
            })?;
            if slot + chrono::Duration::seconds(ONCE_PAST_GRACE_SECS) < Local::now() {
                return Err(AppError::validation(format!(
                    "once schedule time '{} {}' has already passed",
                    schedule.date.as_deref().unwrap_or_default(),
                    schedule.time
                )));
            }
        }
    }
    Ok(())
}

pub fn validate_automation_fields(name: &str, prompt: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::validation("name must not be empty".to_string()));
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(AppError::validation(format!(
            "name must be at most {} characters",
            MAX_NAME_LEN
        )));
    }
    if prompt.trim().is_empty() {
        return Err(AppError::validation("prompt must not be empty".to_string()));
    }
    if prompt.chars().count() > MAX_PROMPT_LEN {
        return Err(AppError::validation(format!(
            "prompt must be at most {} characters",
            MAX_PROMPT_LEN
        )));
    }
    Ok(())
}

pub fn generate_automation_id(now: DateTime<Utc>) -> String {
    let millis = now.timestamp_millis();
    let suffix: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(4)
        .map(char::from)
        .collect();
    format!("auto_{}_{}", millis, suffix.to_ascii_lowercase())
}

fn db_error(context: &str, error: impl std::fmt::Display) -> AppError {
    AppError::database(format!("{}: {}", context, error))
}

fn session_mode_to_db(value: Option<HeadlessSessionMode>) -> Option<&'static str> {
    value.map(|mode| match mode {
        HeadlessSessionMode::Isolated => "isolated",
        HeadlessSessionMode::Named => "named",
    })
}

fn row_to_automation(row: &Row<'_>) -> rusqlite::Result<AutomationDefinition> {
    let schedule_json: String = row.get("schedule_json")?;
    let schedule = serde_json::from_str(&schedule_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            schedule_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    let action_type_raw: String = row.get("action_type")?;
    let action_type = match action_type_raw.as_str() {
        "agent_turn" => AutomationActionType::AgentTurn,
        _ => AutomationActionType::Notify,
    };
    let session_mode_raw: Option<String> = row.get("session_mode")?;
    let session_mode = match session_mode_raw.as_deref() {
        Some("named") => Some(HeadlessSessionMode::Named),
        Some("isolated") => Some(HeadlessSessionMode::Isolated),
        _ => None,
    };
    let catch_up_raw: String = row.get("catch_up_policy")?;
    let catch_up_policy = match catch_up_raw.as_str() {
        "skip" => CatchUpPolicy::Skip,
        "catch_up_all" => CatchUpPolicy::CatchUpAll,
        _ => CatchUpPolicy::RunOnce,
    };
    // Older live connections can still expose the pre-profile table shape
    // during a rolling upgrade. Treat that row as an untrusted legacy
    // automation instead of making the entire scheduler unavailable.
    let trusted_profile_json: Option<String> = row
        .get::<_, Option<String>>("trusted_profile_json")
        .unwrap_or(None);
    let trusted_profile = trusted_profile_json
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            serde_json::from_str(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    value.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()?;

    Ok(AutomationDefinition {
        id: row.get("id")?,
        name: row.get("name")?,
        schedule,
        prompt: row.get("prompt")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        created_at: row.get("created_at")?,
        session_id: row.get("source_session_id")?,
        last_run_at: row.get("last_run_at")?,
        next_run_at: row.get("next_run_at")?,
        action_type,
        heartbeat: row.get::<_, i64>("heartbeat")? != 0,
        agent_prompt: row.get("agent_prompt")?,
        session_mode,
        model_id: row.get("model_id")?,
        agent_session_id: row.get("agent_session_id")?,
        catch_up_policy,
        max_retries: row.get::<_, i64>("max_retries")?.clamp(0, 10) as u8,
        retry_backoff_seconds: row.get::<_, i64>("retry_backoff_seconds")?.max(5) as u64,
        timeout_seconds: row.get::<_, i64>("timeout_seconds")?.max(30) as u64,
        trusted_profile,
        version: row.get::<_, i64>("version")?.max(1) as u64,
    })
}

fn insert_automation_with_conn(
    conn: &rusqlite::Connection,
    automation: &AutomationDefinition,
) -> Result<()> {
    let schedule_json = serde_json::to_string(&automation.schedule)
        .map_err(|error| AppError::internal(format!("Failed to serialize schedule: {}", error)))?;
    let updated_at = Utc::now().to_rfc3339();
    let trusted_profile_json = automation
        .trusted_profile
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| {
            AppError::internal(format!("Failed to serialize trusted profile: {error}"))
        })?;
    conn.execute(
        "INSERT INTO automation_definitions (
            id, name, schedule_json, prompt, enabled, created_at, updated_at,
            source_session_id, last_run_at, next_run_at, action_type, heartbeat,
            agent_prompt, session_mode, model_id, agent_session_id, catch_up_policy,
            max_retries, retry_backoff_seconds, timeout_seconds, trusted_profile_json, version
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
         )",
        params![
            automation.id,
            automation.name,
            schedule_json,
            automation.prompt,
            automation.enabled as i64,
            automation.created_at,
            updated_at,
            automation.session_id,
            automation.last_run_at,
            automation.next_run_at,
            match automation.action_type {
                AutomationActionType::Notify => "notify",
                AutomationActionType::AgentTurn => "agent_turn",
            },
            automation.heartbeat as i64,
            automation.agent_prompt,
            session_mode_to_db(automation.session_mode),
            automation.model_id,
            automation.agent_session_id,
            automation.catch_up_policy.as_str(),
            automation.max_retries as i64,
            automation.retry_backoff_seconds as i64,
            automation.timeout_seconds as i64,
            trusted_profile_json,
            automation.version as i64,
        ],
    )
    .map_err(|error| db_error("Failed to insert automation", error))?;
    Ok(())
}

pub fn insert_automation(db: &Database, automation: &AutomationDefinition) -> Result<()> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    insert_automation_with_conn(&conn, automation)
}

#[derive(Debug, Clone)]
pub struct AutomationCreateFields {
    pub name: String,
    pub schedule: AutomationSchedule,
    pub prompt: String,
    pub enabled: bool,
    pub action_type: AutomationActionType,
    pub heartbeat: bool,
    pub agent_prompt: Option<String>,
    pub session_mode: Option<HeadlessSessionMode>,
    pub model_id: Option<String>,
    pub catch_up_policy: CatchUpPolicy,
    pub max_retries: u8,
    pub retry_backoff_seconds: u64,
    pub timeout_seconds: u64,
    pub trusted_profile: Option<TrustedAutomationProfile>,
    pub source_session_id: String,
}

pub fn create_automation(
    db: &Database,
    mut fields: AutomationCreateFields,
) -> Result<AutomationDefinition> {
    validate_automation_fields(&fields.name, &fields.prompt)?;
    validate_schedule(&fields.schedule)?;
    normalize_schedule_shape(&mut fields.schedule);
    if fields.max_retries > 10 {
        return Err(AppError::validation(
            "max_retries must be between 0 and 10".to_string(),
        ));
    }
    if !(5..=86_400).contains(&fields.retry_backoff_seconds) {
        return Err(AppError::validation(
            "retry_backoff_seconds must be between 5 and 86400".to_string(),
        ));
    }
    if !(30..=3_600).contains(&fields.timeout_seconds) {
        return Err(AppError::validation(
            "timeout_seconds must be between 30 and 3600".to_string(),
        ));
    }
    let trusted_profile = fields
        .trusted_profile
        .map(TrustedAutomationProfile::seal)
        .transpose()?;
    if trusted_profile.is_some() {
        if fields.action_type != AutomationActionType::AgentTurn {
            return Err(AppError::validation(
                "trusted_profile requires action_type=agent_turn".to_string(),
            ));
        }
    }
    if fields.action_type == AutomationActionType::Notify
        && (fields.agent_prompt.is_some()
            || fields.session_mode.is_some()
            || fields.model_id.is_some())
    {
        return Err(AppError::validation(
            "agent fields require action_type=agent_turn".to_string(),
        ));
    }
    if fields
        .agent_prompt
        .as_ref()
        .is_some_and(|prompt| prompt.chars().count() > MAX_PROMPT_LEN)
    {
        return Err(AppError::validation(format!(
            "agent_prompt must be at most {} characters",
            MAX_PROMPT_LEN
        )));
    }

    let now = Utc::now();
    let next_run_at = fields
        .enabled
        .then(|| {
            compute_next_trigger(&fields.schedule, now.with_timezone(&Local))
                .map(|value| value.with_timezone(&Utc).to_rfc3339())
        })
        .transpose()?;
    let automation = AutomationDefinition {
        id: generate_automation_id(now),
        name: fields.name.trim().to_string(),
        schedule: fields.schedule,
        prompt: fields.prompt.trim().to_string(),
        enabled: fields.enabled,
        created_at: now.to_rfc3339(),
        session_id: fields.source_session_id,
        last_run_at: None,
        next_run_at,
        action_type: fields.action_type,
        heartbeat: fields.heartbeat,
        agent_prompt: fields.agent_prompt,
        session_mode: fields.session_mode,
        model_id: fields.model_id,
        agent_session_id: None,
        catch_up_policy: fields.catch_up_policy,
        max_retries: fields.max_retries,
        retry_backoff_seconds: fields.retry_backoff_seconds,
        timeout_seconds: fields.timeout_seconds,
        trusted_profile,
        version: 1,
    };

    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start automation create", error))?;
    let count: i64 = tx
        .query_row("SELECT COUNT(*) FROM automation_definitions", [], |row| {
            row.get(0)
        })
        .map_err(|error| db_error("Failed to count automations", error))?;
    if count >= MAX_AUTOMATIONS as i64 {
        return Err(AppError::validation(format!(
            "Automation limit reached (max {})",
            MAX_AUTOMATIONS
        )));
    }
    insert_automation_with_conn(&tx, &automation)?;
    tx.commit()
        .map_err(|error| db_error("Failed to commit automation create", error))?;
    Ok(automation)
}

/// One-time migration from the legacy settings JSON. The old value is retained
/// as a rollback snapshot; the marker prevents it from being imported twice.
pub fn migrate_legacy_automations(db: &Database) -> Result<usize> {
    if db.get_setting(AUTOMATION_LEGACY_MIGRATED_KEY)?.as_deref() == Some("true") {
        return Ok(0);
    }

    let legacy = db.get_setting(AUTOMATIONS_KEY)?;
    let definitions: Vec<AutomationDefinition> = match legacy {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).map_err(|error| {
            AppError::internal(format!("Failed to parse legacy automations: {}", error))
        })?,
        _ => Vec::new(),
    };

    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start automation migration", error))?;
    let mut migrated = 0;
    let now = Local::now();
    for mut automation in definitions {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM automation_definitions WHERE id = ?1)",
                params![automation.id],
                |row| row.get(0),
            )
            .map_err(|error| db_error("Failed to check migrated automation", error))?;
        if exists {
            continue;
        }
        if automation.next_run_at.is_none() && automation.enabled {
            automation.next_run_at = compute_next_trigger(&automation.schedule, now)
                .ok()
                .map(|value| value.with_timezone(&Utc).to_rfc3339());
        }
        insert_automation_with_conn(&tx, &automation)?;
        migrated += 1;
    }
    tx.commit()
        .map_err(|error| db_error("Failed to commit automation migration", error))?;
    drop(conn);
    db.save_setting(AUTOMATION_LEGACY_MIGRATED_KEY, "true")?;
    Ok(migrated)
}

pub fn load_automations(db: &Database) -> Result<Vec<AutomationDefinition>> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let mut stmt = conn
        .prepare("SELECT * FROM automation_definitions ORDER BY created_at ASC, id ASC")
        .map_err(|error| db_error("Failed to prepare automation list", error))?;
    let rows = stmt
        .query_map([], row_to_automation)
        .map_err(|error| db_error("Failed to query automations", error))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| db_error("Failed to decode automations", error))
}

pub fn save_automations(db: &Database, automations: &[AutomationDefinition]) -> Result<()> {
    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start automation save", error))?;
    tx.execute("DELETE FROM automation_definitions", [])
        .map_err(|error| db_error("Failed to replace automations", error))?;
    for automation in automations {
        insert_automation_with_conn(&tx, automation)?;
    }
    tx.commit()
        .map_err(|error| db_error("Failed to commit automations", error))?;
    Ok(())
}

/// Shared locked read/modify/write service used by both Agent tools and UI commands.
pub fn set_automation_enabled(
    db: &Database,
    automation_id: &str,
    expected_version: u64,
    enabled: bool,
) -> Result<(AutomationDefinition, AutomationDefinition)> {
    let expected_version_db = i64::try_from(expected_version).map_err(|_| {
        AppError::validation("expected_version must be a positive 64-bit integer".to_string())
    })?;
    if expected_version == 0 {
        return Err(AppError::validation(
            "expected_version must be at least 1".to_string(),
        ));
    }
    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start automation update", error))?;
    let previous = tx
        .query_row(
            "SELECT * FROM automation_definitions WHERE id = ?1",
            params![automation_id],
            row_to_automation,
        )
        .optional()
        .map_err(|error| db_error("Failed to load automation", error))?
        .ok_or_else(|| AppError::validation(format!("Automation '{}' not found", automation_id)))?;
    if previous.version != expected_version {
        return Err(automation_version_conflict_error(
            automation_id,
            expected_version,
            &previous,
        ));
    }
    if previous.enabled == enabled {
        let current = previous.clone();
        tx.commit()
            .map_err(|error| db_error("Failed to commit automation no-op", error))?;
        return Ok((previous, current));
    }
    // once：compute_next_trigger 恒返回固定时点（可能已过）。若该时点已被
    // claim 消耗（claim 会把 last_run_at 写为该时点），重新启用不得把已过
    // 时点写回 next_run_at，否则"一次性"任务会被再次触发。
    let next_run_at = if enabled {
        compute_next_trigger(&previous.schedule, Local::now())
            .ok()
            .filter(|slot| !once_slot_already_consumed(&previous, *slot))
            .map(|value| value.with_timezone(&Utc).to_rfc3339())
    } else {
        None
    };
    let affected = tx
        .execute(
            "UPDATE automation_definitions
         SET enabled = ?2, next_run_at = ?3, updated_at = ?4, version = version + 1
         WHERE id = ?1 AND version = ?5",
            params![
                automation_id,
                enabled as i64,
                next_run_at,
                Utc::now().to_rfc3339(),
                expected_version_db,
            ],
        )
        .map_err(|error| db_error("Failed to update automation", error))?;
    if affected == 0 {
        return Err(automation_version_conflict_error(
            automation_id,
            expected_version,
            &previous,
        ));
    }
    let mut running_run_ids: Vec<String> = Vec::new();
    if !enabled {
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE automation_runs
             SET status = 'cancelled', finished_at = ?2, next_attempt_at = NULL, updated_at = ?2
             WHERE automation_id = ?1 AND status IN ('queued', 'retrying')",
            params![automation_id, now],
        )
        .map_err(|error| db_error("Failed to cancel pending automation retries", error))?;
        // 正在 running 的 run 无法直接改状态（执行器持有），改为取消其
        // CancellationToken；run 的 cancelled 终态由执行侧落库。
        let mut stmt = tx
            .prepare(
                "SELECT id FROM automation_runs
                 WHERE automation_id = ?1 AND status = 'running'",
            )
            .map_err(|error| db_error("Failed to prepare running run lookup", error))?;
        let rows = stmt
            .query_map(params![automation_id], |row| row.get(0))
            .map_err(|error| db_error("Failed to query running automation runs", error))?;
        running_run_ids = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| db_error("Failed to decode running automation runs", error))?;
    }
    let current = tx
        .query_row(
            "SELECT * FROM automation_definitions WHERE id = ?1",
            params![automation_id],
            row_to_automation,
        )
        .map_err(|error| db_error("Failed to reload automation", error))?;
    tx.commit()
        .map_err(|error| db_error("Failed to commit automation update", error))?;
    for run_id in running_run_ids {
        let token = ACTIVE_AUTOMATION_RUNS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&run_id)
            .map(|entry| entry.token.clone());
        if let Some(token) = token {
            tracing::info!(
                "[AutomationScheduler] disabling '{}' cancels active run '{}'",
                automation_id,
                run_id
            );
            token.cancel();
        }
    }
    Ok((previous, current))
}

#[derive(Debug, Clone, Default)]
pub struct AutomationUpdateFields {
    pub name: Option<String>,
    pub schedule: Option<AutomationSchedule>,
    pub prompt: Option<String>,
    pub action_type: Option<AutomationActionType>,
    pub agent_prompt: Option<Option<String>>,
    pub session_mode: Option<Option<HeadlessSessionMode>>,
    pub model_id: Option<Option<String>>,
    pub catch_up_policy: Option<CatchUpPolicy>,
    pub max_retries: Option<u8>,
    pub retry_backoff_seconds: Option<u64>,
    pub timeout_seconds: Option<u64>,
    pub trusted_profile: Option<Option<TrustedAutomationProfile>>,
}

pub fn update_automation_full(
    db: &Database,
    automation_id: &str,
    expected_version: u64,
    mut fields: AutomationUpdateFields,
) -> Result<(AutomationDefinition, AutomationDefinition)> {
    let expected_version_db = i64::try_from(expected_version).map_err(|_| {
        AppError::validation("expected_version must be a positive 64-bit integer".to_string())
    })?;
    if expected_version == 0 {
        return Err(AppError::validation(
            "expected_version must be at least 1".to_string(),
        ));
    }
    if fields.name.is_none()
        && fields.schedule.is_none()
        && fields.prompt.is_none()
        && fields.action_type.is_none()
        && fields.agent_prompt.is_none()
        && fields.session_mode.is_none()
        && fields.model_id.is_none()
        && fields.catch_up_policy.is_none()
        && fields.max_retries.is_none()
        && fields.retry_backoff_seconds.is_none()
        && fields.timeout_seconds.is_none()
        && fields.trusted_profile.is_none()
    {
        return Err(AppError::validation(
            "At least one editable field is required".to_string(),
        ));
    }
    if let Some(schedule) = fields.schedule.as_mut() {
        validate_schedule(schedule)?;
        normalize_schedule_shape(schedule);
    }
    if let Some(name) = fields.name.as_ref() {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::validation("name must not be empty".to_string()));
        }
        if name.chars().count() > MAX_NAME_LEN {
            return Err(AppError::validation(format!(
                "name must be at most {} characters",
                MAX_NAME_LEN
            )));
        }
    }
    if let Some(prompt) = fields.prompt.as_ref() {
        if prompt.trim().is_empty() {
            return Err(AppError::validation("prompt must not be empty".to_string()));
        }
        if prompt.chars().count() > MAX_PROMPT_LEN {
            return Err(AppError::validation(format!(
                "prompt must be at most {} characters",
                MAX_PROMPT_LEN
            )));
        }
    }
    if fields
        .agent_prompt
        .as_ref()
        .and_then(Option::as_ref)
        .is_some_and(|prompt| prompt.chars().count() > MAX_PROMPT_LEN)
    {
        return Err(AppError::validation(format!(
            "agent_prompt must be at most {} characters",
            MAX_PROMPT_LEN
        )));
    }
    if fields.max_retries.is_some_and(|value| value > 10) {
        return Err(AppError::validation(
            "max_retries must be between 0 and 10".to_string(),
        ));
    }
    if fields
        .retry_backoff_seconds
        .is_some_and(|value| !(5..=86_400).contains(&value))
    {
        return Err(AppError::validation(
            "retry_backoff_seconds must be between 5 and 86400".to_string(),
        ));
    }
    if fields
        .timeout_seconds
        .is_some_and(|value| !(30..=3_600).contains(&value))
    {
        return Err(AppError::validation(
            "timeout_seconds must be between 30 and 3600".to_string(),
        ));
    }
    fields.trusted_profile = match fields.trusted_profile.take() {
        Some(Some(profile)) => Some(Some(profile.seal()?)),
        Some(None) => Some(None),
        None => None,
    };

    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start automation update", error))?;
    let previous = tx
        .query_row(
            "SELECT * FROM automation_definitions WHERE id = ?1",
            params![automation_id],
            row_to_automation,
        )
        .optional()
        .map_err(|error| db_error("Failed to load automation", error))?
        .ok_or_else(|| AppError::validation(format!("Automation '{}' not found", automation_id)))?;
    if previous.version != expected_version {
        return Err(automation_version_conflict_error(
            automation_id,
            expected_version,
            &previous,
        ));
    }
    let mut current = previous.clone();
    if let Some(name) = fields.name {
        current.name = name.trim().to_string();
    }
    if let Some(schedule) = fields.schedule {
        current.schedule = schedule;
        current.next_run_at = if current.enabled {
            compute_next_trigger(&current.schedule, Local::now())
                .ok()
                .map(|value| value.with_timezone(&Utc).to_rfc3339())
        } else {
            None
        };
    }
    if let Some(prompt) = fields.prompt {
        current.prompt = prompt.trim().to_string();
    }
    if let Some(action_type) = fields.action_type {
        current.action_type = action_type;
        if action_type == AutomationActionType::Notify {
            current.agent_prompt = None;
            current.session_mode = None;
            current.model_id = None;
            current.agent_session_id = None;
            current.trusted_profile = None;
        }
    }
    if let Some(agent_prompt) = fields.agent_prompt {
        current.agent_prompt = agent_prompt
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
    if let Some(session_mode) = fields.session_mode {
        current.session_mode = session_mode;
        if session_mode != Some(HeadlessSessionMode::Named) {
            current.agent_session_id = None;
        }
    }
    if let Some(model_id) = fields.model_id {
        current.model_id = model_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
    if let Some(catch_up_policy) = fields.catch_up_policy {
        current.catch_up_policy = catch_up_policy;
    }
    if let Some(max_retries) = fields.max_retries {
        current.max_retries = max_retries;
    }
    if let Some(retry_backoff_seconds) = fields.retry_backoff_seconds {
        current.retry_backoff_seconds = retry_backoff_seconds;
    }
    if let Some(timeout_seconds) = fields.timeout_seconds {
        current.timeout_seconds = timeout_seconds;
    }
    if let Some(trusted_profile) = fields.trusted_profile {
        current.trusted_profile = trusted_profile;
    }
    if current.action_type == AutomationActionType::Notify
        && (current.agent_prompt.is_some()
            || current.session_mode.is_some()
            || current.model_id.is_some()
            || current.trusted_profile.is_some())
    {
        return Err(AppError::validation(
            "agent fields require action_type=agent_turn".to_string(),
        ));
    }
    let schedule_json = serde_json::to_string(&current.schedule)
        .map_err(|error| AppError::internal(format!("Failed to serialize schedule: {}", error)))?;
    let trusted_profile_json = current
        .trusted_profile
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| {
            AppError::internal(format!("Failed to serialize trusted profile: {error}"))
        })?;
    let affected = tx
        .execute(
            "UPDATE automation_definitions
         SET name = ?2, schedule_json = ?3, prompt = ?4, action_type = ?5,
             agent_prompt = ?6, session_mode = ?7, model_id = ?8,
             agent_session_id = ?9, catch_up_policy = ?10, max_retries = ?11,
             retry_backoff_seconds = ?12, timeout_seconds = ?13,
             next_run_at = ?14, trusted_profile_json = ?15, updated_at = ?16, version = version + 1
         WHERE id = ?1 AND version = ?17",
            params![
                automation_id,
                &current.name,
                &schedule_json,
                &current.prompt,
                match current.action_type {
                    AutomationActionType::Notify => "notify",
                    AutomationActionType::AgentTurn => "agent_turn",
                },
                current.agent_prompt.as_deref(),
                session_mode_to_db(current.session_mode),
                current.model_id.as_deref(),
                current.agent_session_id.as_deref(),
                current.catch_up_policy.as_str(),
                current.max_retries as i64,
                current.retry_backoff_seconds as i64,
                current.timeout_seconds as i64,
                current.next_run_at.as_deref(),
                trusted_profile_json,
                Utc::now().to_rfc3339(),
                expected_version_db,
            ],
        )
        .map_err(|error| db_error("Failed to update automation", error))?;
    if affected == 0 {
        return Err(automation_version_conflict_error(
            automation_id,
            expected_version,
            &previous,
        ));
    }
    let current = tx
        .query_row(
            "SELECT * FROM automation_definitions WHERE id = ?1",
            params![automation_id],
            row_to_automation,
        )
        .map_err(|error| db_error("Failed to reload automation", error))?;
    tx.commit()
        .map_err(|error| db_error("Failed to commit automation update", error))?;
    Ok((previous, current))
}

pub fn update_automation(
    db: &Database,
    automation_id: &str,
    expected_version: u64,
    schedule: Option<AutomationSchedule>,
    prompt: Option<String>,
) -> Result<(AutomationDefinition, AutomationDefinition)> {
    if schedule.is_none() && prompt.is_none() {
        return Err(AppError::validation(
            "At least one of schedule or prompt is required".to_string(),
        ));
    }
    update_automation_full(
        db,
        automation_id,
        expected_version,
        AutomationUpdateFields {
            schedule,
            prompt,
            ..AutomationUpdateFields::default()
        },
    )
}

pub fn delete_automation(
    db: &Database,
    automation_id: &str,
    expected_version: u64,
) -> Result<AutomationDefinition> {
    let expected_version_db = i64::try_from(expected_version).map_err(|_| {
        AppError::validation("expected_version must be a positive 64-bit integer".to_string())
    })?;
    if expected_version == 0 {
        return Err(AppError::validation(
            "expected_version must be at least 1".to_string(),
        ));
    }
    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start automation delete", error))?;
    let deleted = tx
        .query_row(
            "SELECT * FROM automation_definitions WHERE id = ?1",
            params![automation_id],
            row_to_automation,
        )
        .optional()
        .map_err(|error| db_error("Failed to load automation", error))?
        .ok_or_else(|| AppError::validation(format!("Automation '{}' not found", automation_id)))?;
    if deleted.version != expected_version {
        return Err(automation_version_conflict_error(
            automation_id,
            expected_version,
            &deleted,
        ));
    }
    if deleted.heartbeat || deleted.id == HEARTBEAT_AUTOMATION_ID {
        return Err(AppError::validation(
            "The built-in heartbeat automation cannot be deleted; disable it instead".to_string(),
        ));
    }
    let has_active_runs: bool = tx
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM automation_runs
                 WHERE automation_id = ?1
                   AND status IN ('queued', 'running', 'retrying')
             )",
            params![automation_id],
            |row| row.get(0),
        )
        .map_err(|error| db_error("Failed to check active automation runs", error))?;
    if has_active_runs {
        return Err(AppError::validation(
            "Cancel active runs before deleting this automation".to_string(),
        ));
    }
    let affected = tx
        .execute(
            "DELETE FROM automation_definitions WHERE id = ?1 AND version = ?2",
            params![automation_id, expected_version_db],
        )
        .map_err(|error| db_error("Failed to delete automation", error))?;
    if affected == 0 {
        return Err(automation_version_conflict_error(
            automation_id,
            expected_version,
            &deleted,
        ));
    }
    tx.commit()
        .map_err(|error| db_error("Failed to commit automation delete", error))?;
    Ok(deleted)
}

pub fn automation_list_response(db: &Database) -> Result<Value> {
    let automations = load_automations(db)?;
    let now = Local::now();
    let items: Vec<Value> = automations
        .iter()
        .map(|automation| automation_to_list_item(automation, now))
        .collect();
    Ok(json!({
        "count": items.len(),
        "max": MAX_AUTOMATIONS,
        "automations": items,
    }))
}

fn truncate_agent_text(value: &str) -> (String, bool) {
    let mut chars = value.chars();
    let bounded: String = chars.by_ref().take(2_000).collect();
    (bounded, chars.next().is_some())
}

/// Agent-facing representation. Settings commands deliberately use the full
/// mapping so prompt editing never loses data.
pub fn automation_to_agent_list_item(
    automation: &AutomationDefinition,
    now: DateTime<Local>,
) -> Value {
    let mut value = automation_to_list_item(automation, now);
    let mut fields_truncated = Vec::new();
    for (field, source) in [
        ("prompt", Some(automation.prompt.as_str())),
        ("agent_prompt", automation.agent_prompt.as_deref()),
    ] {
        if let Some(source) = source {
            let (bounded, truncated) = truncate_agent_text(source);
            value[field] = json!(bounded);
            if truncated {
                fields_truncated.push(field);
            }
        }
    }
    value["promptTruncated"] = json!(fields_truncated
        .iter()
        .any(|field| *field == "prompt" || *field == "agent_prompt"));
    value["fieldsTruncated"] = json!(fields_truncated);
    value
}

pub fn automation_agent_list_response(db: &Database) -> Result<Value> {
    let automations = load_automations(db)?;
    let now = Local::now();
    let items: Vec<Value> = automations
        .iter()
        .map(|automation| automation_to_agent_list_item(automation, now))
        .collect();
    Ok(json!({
        "count": items.len(),
        "max": MAX_AUTOMATIONS,
        "automations": items,
    }))
}

pub fn emit_automations_changed(app_handle: &AppHandle, action: &str, automation_id: &str) {
    if let Err(error) = app_handle.emit(
        AUTOMATIONS_CHANGED_EVENT,
        json!({ "action": action, "automationId": automation_id }),
    ) {
        tracing::warn!(
            "[AutomationScheduler] failed to emit automations_changed (action={}, automation={}): {}",
            action,
            automation_id,
            error
        );
    }
}

/// once 任务的唯一时点是否已被调度 claim 消耗。
///
/// `claim_scheduled_run` 会把 `last_run_at` 写为被消耗的时点，因此
/// `last_run_at >= slot` 即视为已消耗；手动试跑（manual run）不写
/// `last_run_at`，不会误判。非 once 调度恒返回 false。
fn once_slot_already_consumed(automation: &AutomationDefinition, slot: DateTime<Local>) -> bool {
    automation.schedule.kind == ScheduleKind::Once
        && parse_last_run_at(automation.last_run_at.as_deref())
            .ok()
            .flatten()
            .is_some_and(|last| last >= slot)
}

/// once 任务是否已完成（唯一时点已被调度消耗并固化为 disabled）。
///
/// `last_run_at` 只由调度 claim 写入（手动试跑不写），因此
/// once + disabled + next_run_at=NULL + last_run_at 有值 ⇒ 时点已执行完毕，
/// 后续更新不会使其再次触发（区别于用户到点前手动停用的情况）。
fn once_automation_completed(automation: &AutomationDefinition) -> bool {
    automation.schedule.kind == ScheduleKind::Once
        && !automation.enabled
        && automation.next_run_at.is_none()
        && automation.last_run_at.is_some()
}

/// once 任务在其唯一时点的 run 走到终态后固化为“已完成”暂停态：
/// enabled=0（保留定义与历史，不删除；属运行时账务，不 bump version）。
/// 仅当 next_run_at 已为 NULL（时点已被 claim 消耗）时生效——到点前的手动试跑
/// 不应吞掉尚未触发的调度时点。
fn finalize_once_automation(
    db: &Database,
    app_handle: Option<&AppHandle>,
    automation: &AutomationDefinition,
) {
    if automation.schedule.kind != ScheduleKind::Once {
        return;
    }
    let changed = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))
        .and_then(|conn| {
            conn.execute(
                "UPDATE automation_definitions
                 SET enabled = 0, updated_at = ?2
                 WHERE id = ?1 AND enabled = 1 AND next_run_at IS NULL",
                params![automation.id, Utc::now().to_rfc3339()],
            )
            .map_err(|error| db_error("Failed to finalize once automation", error))
        });
    match changed {
        Ok(1) => {
            tracing::info!(
                "[AutomationScheduler] once automation '{}' completed; disabled",
                automation.id
            );
            if let Some(app_handle) = app_handle {
                emit_automations_changed(app_handle, "once_completed", &automation.id);
            }
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(
            "[AutomationScheduler] failed to finalize once automation '{}': {}",
            automation.id,
            error
        ),
    }
}

pub fn load_automation_runs(db: &Database) -> Result<Vec<AutomationRunRecord>> {
    list_automation_runs(db, None, MAX_RUN_HISTORY)
}

pub fn save_automation_runs(db: &Database, runs: &[AutomationRunRecord]) -> Result<()> {
    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start run history save", error))?;
    tx.execute("DELETE FROM automation_runs", [])
        .map_err(|error| db_error("Failed to replace run history", error))?;
    for record in runs {
        insert_run_record(&tx, record)?;
    }
    tx.commit()
        .map_err(|error| db_error("Failed to commit run history", error))?;
    Ok(())
}

pub fn append_automation_run(db: &Database, record: AutomationRunRecord) -> Result<()> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    insert_run_record(&conn, &record)
}

fn insert_run_record(conn: &rusqlite::Connection, record: &AutomationRunRecord) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let id = if record.id.trim().is_empty() {
        format!("run_{}", uuid::Uuid::new_v4())
    } else {
        record.id.clone()
    };
    let scheduled_for = if record.scheduled_for.trim().is_empty() {
        record.fired_at.clone()
    } else {
        record.scheduled_for.clone()
    };
    let trigger_type = if record.trigger_type.trim().is_empty() {
        "schedule"
    } else {
        record.trigger_type.as_str()
    };
    let status = record.status.as_deref().unwrap_or("success");
    let delivered_json = serde_json::to_string(&record.delivered).map_err(|error| {
        AppError::internal(format!("Failed to serialize delivery list: {}", error))
    })?;
    conn.execute(
        "INSERT OR REPLACE INTO automation_runs (
            id, automation_id, dedupe_key, trigger_type, scheduled_for, status,
            attempt, max_attempts, claimed_at, started_at, finished_at,
            next_attempt_at, session_id, delivered_json, summary, error,
            created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18
         )",
        params![
            id,
            record.automation_id,
            format!("legacy:{}", id),
            trigger_type,
            scheduled_for,
            status,
            record.attempt as i64,
            record.max_attempts as i64,
            record.started_at.as_deref().unwrap_or(&record.fired_at),
            record.started_at.as_deref().unwrap_or(&record.fired_at),
            record
                .finished_at
                .as_deref()
                .or(Some(record.fired_at.as_str())),
            record.next_attempt_at,
            record.session_id,
            delivered_json,
            record.summary,
            record.error,
            record.fired_at,
            now,
        ],
    )
    .map_err(|error| db_error("Failed to append automation run", error))?;
    Ok(())
}

pub fn list_automation_runs(
    db: &Database,
    automation_id: Option<&str>,
    limit: usize,
) -> Result<Vec<AutomationRunRecord>> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let sql = if automation_id.is_some() {
        "SELECT id, automation_id, trigger_type, scheduled_for, status, attempt,
                max_attempts, started_at, finished_at, next_attempt_at, session_id,
                delivered_json, summary, error, created_at
         FROM automation_runs WHERE automation_id = ?1
         ORDER BY created_at DESC LIMIT ?2"
    } else {
        "SELECT id, automation_id, trigger_type, scheduled_for, status, attempt,
                max_attempts, started_at, finished_at, next_attempt_at, session_id,
                delivered_json, summary, error, created_at
         FROM automation_runs
         ORDER BY created_at DESC LIMIT ?2"
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|error| db_error("Failed to prepare run history", error))?;
    let map_row = |row: &Row<'_>| -> rusqlite::Result<AutomationRunRecord> {
        let delivered_json: String = row.get("delivered_json")?;
        let delivered = serde_json::from_str(&delivered_json).unwrap_or_default();
        let scheduled_for: String = row.get("scheduled_for")?;
        let started_at: Option<String> = row.get("started_at")?;
        let finished_at: Option<String> = row.get("finished_at")?;
        Ok(AutomationRunRecord {
            id: row.get("id")?,
            automation_id: row.get("automation_id")?,
            fired_at: scheduled_for.clone(),
            delivered,
            session_id: row.get("session_id")?,
            status: Some(row.get("status")?),
            trigger_type: row.get("trigger_type")?,
            scheduled_for,
            attempt: row.get::<_, i64>("attempt")?.max(1) as u32,
            max_attempts: row.get::<_, i64>("max_attempts")?.max(1) as u32,
            duration_ms: run_duration_ms(started_at.as_deref(), finished_at.as_deref()),
            started_at,
            finished_at,
            next_attempt_at: row.get("next_attempt_at")?,
            summary: row.get("summary")?,
            error: row.get("error")?,
        })
    };
    let rows = if let Some(automation_id) = automation_id {
        stmt.query_map(params![automation_id, limit.clamp(1, 200) as i64], map_row)
    } else {
        stmt.query_map(
            params![Option::<String>::None, limit.clamp(1, 200) as i64],
            map_row,
        )
    }
    .map_err(|error| db_error("Failed to query run history", error))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| db_error("Failed to decode run history", error))
}

/// Read a bounded page of automation run history for Agent tool output.
pub fn list_automation_runs_page(
    db: &Database,
    automation_id: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<(Vec<AutomationRunRecord>, usize)> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let (sql, count_sql) = if automation_id.is_some() {
        (
            "SELECT id, automation_id, trigger_type, scheduled_for, status, attempt, max_attempts, started_at, finished_at, next_attempt_at, session_id, delivered_json, summary, error, created_at FROM automation_runs WHERE automation_id = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3",
            "SELECT COUNT(*) FROM automation_runs WHERE automation_id = ?1",
        )
    } else {
        (
            "SELECT id, automation_id, trigger_type, scheduled_for, status, attempt, max_attempts, started_at, finished_at, next_attempt_at, session_id, delivered_json, summary, error, created_at FROM automation_runs ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
            "SELECT COUNT(*) FROM automation_runs",
        )
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|error| db_error("Failed to prepare paged run history", error))?;
    let map_row = |row: &Row<'_>| -> rusqlite::Result<AutomationRunRecord> {
        let delivered_json: String = row.get("delivered_json")?;
        let scheduled_for: String = row.get("scheduled_for")?;
        let started_at: Option<String> = row.get("started_at")?;
        let finished_at: Option<String> = row.get("finished_at")?;
        Ok(AutomationRunRecord {
            id: row.get("id")?,
            automation_id: row.get("automation_id")?,
            fired_at: scheduled_for.clone(),
            delivered: serde_json::from_str(&delivered_json).unwrap_or_default(),
            session_id: row.get("session_id")?,
            status: Some(row.get("status")?),
            trigger_type: row.get("trigger_type")?,
            scheduled_for,
            attempt: row.get::<_, i64>("attempt")?.max(1) as u32,
            max_attempts: row.get::<_, i64>("max_attempts")?.max(1) as u32,
            duration_ms: run_duration_ms(started_at.as_deref(), finished_at.as_deref()),
            started_at,
            finished_at,
            next_attempt_at: row.get("next_attempt_at")?,
            summary: row.get("summary")?,
            error: row.get("error")?,
        })
    };
    let limit = limit.clamp(1, 20) as i64;
    let offset = offset.min(i64::MAX as usize) as i64;
    let rows = if let Some(automation_id) = automation_id {
        stmt.query_map(params![automation_id, limit, offset], map_row)
    } else {
        stmt.query_map(params![limit, offset], map_row)
    }
    .map_err(|error| db_error("Failed to query paged run history", error))?;
    let runs = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| db_error("Failed to decode paged run history", error))?;
    let total: i64 = if let Some(automation_id) = automation_id {
        conn.query_row(count_sql, params![automation_id], |row| row.get(0))
    } else {
        conn.query_row(count_sql, [], |row| row.get(0))
    }
    .map_err(|error| db_error("Failed to count run history", error))?;
    Ok((runs, total.max(0) as usize))
}

fn scheduled_slot_on_date(
    schedule: &AutomationSchedule,
    date: chrono::NaiveDate,
) -> Result<Option<DateTime<Local>>> {
    // interval 调度不走"当日时点"路径（is_due 中单独判定）
    if schedule.kind == ScheduleKind::Interval {
        return Ok(None);
    }
    let time = parse_time_hhmm(&schedule.time)?;
    let build_slot = |date: chrono::NaiveDate| -> Result<DateTime<Local>> {
        let local = date.and_time(time);
        if let Some(timezone) = schedule.timezone.as_deref() {
            let timezone = timezone.parse::<Tz>().map_err(|_| {
                AppError::validation(format!("Invalid IANA timezone '{}'", timezone))
            })?;
            for minute_offset in 0..=180 {
                let candidate = local + chrono::Duration::minutes(minute_offset);
                if let Some(value) = timezone.from_local_datetime(&candidate).earliest() {
                    return Ok(value.with_timezone(&Local));
                }
            }
            Err(AppError::internal(
                "Failed to build timezone slot".to_string(),
            ))
        } else {
            for minute_offset in 0..=180 {
                let candidate = local + chrono::Duration::minutes(minute_offset);
                if let Some(value) = candidate.and_local_timezone(Local).earliest() {
                    return Ok(value);
                }
            }
            Err(AppError::internal(
                "Failed to build local schedule slot".to_string(),
            ))
        }
    };
    match schedule.kind {
        ScheduleKind::Interval => unreachable!("interval handled above"),
        ScheduleKind::Once => {
            // 仅在目标日期当天有唯一时点
            if date != parse_once_date(schedule)? {
                return Ok(None);
            }
            Ok(Some(build_slot(date)?))
        }
        ScheduleKind::Daily => Ok(Some(build_slot(date)?)),
        ScheduleKind::Weekly => {
            let targets = weekly_effective_weekdays(schedule).ok_or_else(|| {
                AppError::validation("weekly schedule missing weekday".to_string())
            })?;
            if !targets.contains(&(date.weekday().num_days_from_sunday() as u8)) {
                return Ok(None);
            }
            Ok(Some(build_slot(date)?))
        }
        ScheduleKind::Weekdays => {
            if date.weekday().number_from_monday() > 5 {
                return Ok(None);
            }
            Ok(Some(build_slot(date)?))
        }
        ScheduleKind::Monthly => {
            let requested = schedule.day_of_month.unwrap_or(1) as u32;
            let (next_year, next_month) = if date.month() == 12 {
                (date.year() + 1, 1)
            } else {
                (date.year(), date.month() + 1)
            };
            let last_day = chrono::NaiveDate::from_ymd_opt(next_year, next_month, 1)
                .and_then(|value| value.pred_opt())
                .map(|value| value.day())
                .unwrap_or(28);
            if date.day() != requested.min(last_day) {
                return Ok(None);
            }
            Ok(Some(build_slot(date)?))
        }
    }
}

/// Returns today's scheduled slot if the schedule applies today.
pub fn scheduled_slot_today(
    schedule: &AutomationSchedule,
    now: DateTime<Local>,
) -> Result<Option<DateTime<Local>>> {
    let date = if let Some(timezone) = schedule.timezone.as_deref() {
        let timezone = timezone
            .parse::<Tz>()
            .map_err(|_| AppError::validation(format!("Invalid IANA timezone '{}'", timezone)))?;
        now.with_timezone(&timezone).date_naive()
    } else {
        now.date_naive()
    };
    scheduled_slot_on_date(schedule, date)
}

/// Due when today's slot time has passed and the automation has not run since that slot.
/// If the app was offline, the first check after coming back on the same calendar day still fires.
///
/// ## ⚠️ 双轨语义（勿单独改动一侧）
/// 触发判定存在两条并行路径，语义边界不同：
/// 1. **持久化轨**（生产调度主路径）：`tick_automations` 只信任 DB 里的
///    `next_run_at`，通过 `claim_scheduled_run` 的 CAS（`WHERE next_run_at = ?`）
///    原子消耗时点；catch-up 由 `next_after_claim` + `catch_up_policy` 决定。
/// 2. **计算轨**（本函数）：基于 `schedule` + `last_run_at` 现算"今天的槽位
///    是否已过"，用于展示/兜底判定，不消耗时点。
///
/// 边界差异提示：
/// - 时区：本函数用 `scheduled_slot_today`，按 schedule.timezone（缺省本地时区）
///   解析"今天"；持久化轨的 `next_run_at` 是 UTC 字符串，比较前必须统一时区。
/// - catch-up：本函数只看"同一日历日"，跨天错过不 fire；持久化轨按
///   `catch_up_policy`（skip/run_once/catch_up_all）处理跨天补跑。
/// 修改任一侧的触发语义时，必须同步检查另一侧与 `compute_next_trigger`。
pub fn is_due(
    automation: &AutomationDefinition,
    now: DateTime<Local>,
    last_run_at: Option<DateTime<Local>>,
) -> Result<bool> {
    if !automation.enabled {
        return Ok(false);
    }

    // interval 调度：首次运行从创建/启用时刻起等待完整间隔，避免列表显示
    // “30 分钟后”但调度器下一 tick 立即执行。
    if automation.schedule.kind == ScheduleKind::Interval {
        let minutes = automation
            .schedule
            .interval_minutes
            .unwrap_or(DEFAULT_HEARTBEAT_INTERVAL_MINUTES);
        return Ok(match last_run_at {
            None => {
                if let Some(next) = automation.next_run_at.as_deref() {
                    parse_utc_datetime(next)?.with_timezone(&Local) <= now
                } else {
                    DateTime::parse_from_rfc3339(&automation.created_at)
                        .map(|created| {
                            now.signed_duration_since(created.with_timezone(&Local))
                                >= chrono::Duration::minutes(minutes as i64)
                        })
                        .unwrap_or(false)
                }
            }
            Some(last) => {
                now.signed_duration_since(last) >= chrono::Duration::minutes(minutes as i64)
            }
        });
    }

    let Some(slot) = scheduled_slot_today(&automation.schedule, now)? else {
        return Ok(false);
    };

    if now < slot {
        return Ok(false);
    }

    Ok(match last_run_at {
        None => true,
        Some(last) => last < slot,
    })
}

pub fn parse_last_run_at(raw: Option<&str>) -> Result<Option<DateTime<Local>>> {
    let Some(text) = raw else {
        return Ok(None);
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let dt = DateTime::parse_from_rfc3339(trimmed)
        .map_err(|e| AppError::internal(format!("Invalid last_run_at: {}", e)))?
        .with_timezone(&Local);
    Ok(Some(dt))
}

pub fn compute_next_trigger(
    schedule: &AutomationSchedule,
    now: DateTime<Local>,
) -> Result<DateTime<Local>> {
    if schedule.kind == ScheduleKind::Interval {
        let minutes = schedule
            .interval_minutes
            .unwrap_or(DEFAULT_HEARTBEAT_INTERVAL_MINUTES);
        return Ok(now + chrono::Duration::minutes(minutes as i64));
    }
    if schedule.kind == ScheduleKind::Once {
        // once 返回固定时刻（可能已过）：验证层拒绝过期创建；已过的时点由
        // 调度侧按 catch_up_policy 处理（skip -> 标记 skipped，run_once -> 补跑一次）
        let date = parse_once_date(schedule)?;
        return scheduled_slot_on_date(schedule, date)?
            .ok_or_else(|| AppError::internal("Failed to resolve once schedule slot".to_string()));
    }
    let start_date = if let Some(timezone) = schedule.timezone.as_deref() {
        let timezone = timezone
            .parse::<Tz>()
            .map_err(|_| AppError::validation(format!("Invalid IANA timezone '{}'", timezone)))?;
        now.with_timezone(&timezone).date_naive()
    } else {
        now.date_naive()
    };
    let horizon = if schedule.kind == ScheduleKind::Monthly {
        40
    } else {
        8
    };
    for day_offset in 0..horizon {
        let date = start_date + chrono::Duration::days(day_offset);
        if let Some(slot) = scheduled_slot_on_date(schedule, date)? {
            if day_offset == 0 && slot <= now {
                continue;
            }
            return Ok(slot);
        }
    }
    Err(AppError::internal(
        "Could not compute next trigger".to_string(),
    ))
}

pub fn automation_to_list_item(automation: &AutomationDefinition, now: DateTime<Local>) -> Value {
    let last_run_at = automation.last_run_at.clone();
    let next_trigger = automation.next_run_at.clone().or_else(|| {
        if !automation.enabled {
            return None;
        }
        match compute_next_trigger(&automation.schedule, now) {
            // once 的固定时点已被 claim 消耗：不再有下一次触发，不能把已过
            // 时点当"下次执行"展示
            Ok(slot) if once_slot_already_consumed(automation, slot) => None,
            Ok(slot) => Some(slot.with_timezone(&Utc).to_rfc3339()),
            Err(_) => Some("unknown".to_string()),
        }
    });

    // notify 类型没有会话概念，诚实输出 null（前端 normalizeAutomation 对
    // null 归一为 isolated，不会崩）；agent_turn 未显式设置时输出运行时
    // 实际生效的缺省值 isolated。
    let session_mode = match automation.action_type {
        AutomationActionType::Notify => Value::Null,
        AutomationActionType::AgentTurn => json!(automation.session_mode.unwrap_or_default()),
    };

    json!({
        "id": automation.id,
        "name": automation.name,
        "schedule": automation.schedule,
        "prompt": automation.prompt,
        "enabled": automation.enabled,
        "created_at": automation.created_at,
        "session_id": automation.session_id,
        "last_run_at": last_run_at,
        "next_trigger_at": next_trigger,
        "action_type": automation.action_type,
        "heartbeat": automation.heartbeat,
        "agent_prompt": automation.agent_prompt,
        "session_mode": session_mode,
        "model_id": automation.model_id,
        "agent_session_id": automation.agent_session_id,
        "catch_up_policy": automation.catch_up_policy,
        "max_retries": automation.max_retries,
        "retry_backoff_seconds": automation.retry_backoff_seconds,
        "timeout_seconds": automation.timeout_seconds,
        "trusted_profile": automation.trusted_profile,
        "version": automation.version,
    })
}

/// OS 通知文案语言（后端无 i18n 框架，仅支持 zh/en 双语其一）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationLang {
    Zh,
    En,
}

/// 读取应用已保存的界面语言（settings 表 `language` 键，取值 zh-CN | en-US，
/// 由设置保存路径 / Agent settings_set 工具写入）。
///
/// 键缺失或读取失败时回落中文：与既有硬编码行为一致，也与前端
/// `DEFAULT_SETTINGS.language = 'zh-CN'` 对齐。注意 i18next 的即时语言
/// 存在 localStorage（后端不可读），该键可能滞后于 UI 实际语言，属
/// 尽力而为的最佳可得来源。
fn notification_language(db: &Database) -> NotificationLang {
    match db.get_setting("language") {
        Ok(Some(value)) if value.trim().to_ascii_lowercase().starts_with("en") => {
            NotificationLang::En
        }
        _ => NotificationLang::Zh,
    }
}

fn notification_title_running(lang: NotificationLang, name: &str) -> String {
    match lang {
        NotificationLang::Zh => format!("自动化：{}", name),
        NotificationLang::En => format!("Automation: {}", name),
    }
}

fn notification_title_success(lang: NotificationLang, name: &str) -> String {
    match lang {
        NotificationLang::Zh => format!("自动化完成：{}", name),
        NotificationLang::En => format!("Automation completed: {}", name),
    }
}

fn notification_title_failed(lang: NotificationLang, name: &str) -> String {
    match lang {
        NotificationLang::Zh => format!("自动化失败：{}", name),
        NotificationLang::En => format!("Automation failed: {}", name),
    }
}

/// agent_turn 成功通知正文（完成投递与调度补投共用，消除文案漂移）。
fn notification_success_body(
    lang: NotificationLang,
    summary: &str,
    session_id: Option<&str>,
) -> String {
    match (lang, session_id) {
        (NotificationLang::Zh, Some(session_id)) if summary.is_empty() => {
            format!("已完成，打开 Deep Student 查看会话（{}）", session_id)
        }
        (NotificationLang::Zh, Some(_)) => {
            format!("{}\n打开 Deep Student 查看完整会话", summary)
        }
        (NotificationLang::En, Some(session_id)) if summary.is_empty() => {
            format!(
                "Completed. Open Deep Student to view the session ({}).",
                session_id
            )
        }
        (NotificationLang::En, Some(_)) => {
            format!("{}\nOpen Deep Student to view the full session.", summary)
        }
        (_, None) => summary.to_string(),
    }
}

fn notification_failed_fallback_body(lang: NotificationLang) -> String {
    match lang {
        NotificationLang::Zh => "自动化运行失败".to_string(),
        NotificationLang::En => "Automation run failed".to_string(),
    }
}

fn truncate_prompt_for_notification(prompt: &str, lang: NotificationLang) -> String {
    let preview: String = prompt.chars().take(100).collect();
    let truncated = prompt.chars().count() > 100;
    match lang {
        NotificationLang::Zh if truncated => format!("{}… 打开 Deep Student 执行此任务", preview),
        NotificationLang::Zh => format!("{} 打开 Deep Student 执行此任务", preview),
        NotificationLang::En if truncated => {
            format!("{}… Open Deep Student to run this task.", preview)
        }
        NotificationLang::En => format!("{} Open Deep Student to run this task.", preview),
    }
}

fn create_automation_todo(
    app_handle: &AppHandle,
    vfs_db: &VfsDatabase,
    run_id: &str,
    name: &str,
    prompt: &str,
    now: DateTime<Local>,
) -> bool {
    let inbox = match VfsTodoRepo::ensure_default_inbox(vfs_db) {
        Ok(inbox) => inbox,
        Err(e) => {
            tracing::warn!("[AutomationScheduler] ensure_default_inbox failed: {}", e);
            return false;
        }
    };

    let reminder = now.format("%Y-%m-%dT%H:%M").to_string();
    let params = VfsCreateTodoItemParams {
        todo_list_id: inbox.id,
        title: name.to_string(),
        description: Some(prompt.to_string()),
        priority: "none".to_string(),
        due_date: None,
        due_time: None,
        reminder: Some(reminder),
        tags: None,
        parent_id: None,
        attachments: None,
        repeat_json: None,
    };

    let mut conn = match vfs_db.get_conn_safe() {
        Ok(conn) => conn,
        Err(error) => {
            tracing::warn!(
                "[AutomationScheduler] open VFS todo database failed: {}",
                error
            );
            return false;
        }
    };
    let tx = match conn.transaction_with_behavior(TransactionBehavior::Immediate) {
        Ok(tx) => tx,
        Err(error) => {
            tracing::warn!(
                "[AutomationScheduler] begin todo delivery failed: {}",
                error
            );
            return false;
        }
    };
    let existing: Option<String> = match tx
        .query_row(
            "SELECT todo_item_id FROM automation_todo_deliveries WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
    {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(
                "[AutomationScheduler] read todo delivery receipt failed: {}",
                error
            );
            return false;
        }
    };
    if existing.is_some() {
        return true;
    }

    let item = match VfsTodoRepo::create_todo_item_with_conn(&tx, params) {
        Ok(item) => item,
        Err(error) => {
            tracing::warn!("[AutomationScheduler] create_todo_item failed: {}", error);
            return false;
        }
    };
    if let Err(error) = tx.execute(
        "INSERT INTO automation_todo_deliveries (run_id, todo_item_id, created_at)
         VALUES (?1, ?2, ?3)",
        params![run_id, item.id, Utc::now().to_rfc3339()],
    ) {
        tracing::warn!(
            "[AutomationScheduler] persist todo delivery receipt failed: {}",
            error
        );
        return false;
    }
    if let Err(error) = tx.commit() {
        tracing::warn!(
            "[AutomationScheduler] commit todo delivery failed: {}",
            error
        );
        return false;
    }

    let _ = app_handle.emit(
        "todo://changed",
        json!({ "source": "automation", "action": "create_item" }),
    );
    true
}

#[derive(Debug, Clone)]
struct ClaimedAutomationRun {
    run_id: String,
    automation: AutomationDefinition,
    scheduled_for: String,
    trigger_type: &'static str,
    attempt: i64,
}

fn parse_utc_datetime(raw: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| AppError::internal(format!("Invalid automation timestamp: {}", error)))
}

/// 进程生命周期内不变（hostname + pid + boot id），缓存避免热路径上
/// 每次 claim / 恢复扫描都做一次 hostname 系统调用。
static SCHEDULER_IDENTITY: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}:{}:{}",
        hostname::get()
            .ok()
            .and_then(|value| value.into_string().ok())
            .unwrap_or_else(|| "local".to_string()),
        std::process::id(),
        AUTOMATION_BOOT_ID.as_str(),
    )
});

fn scheduler_identity() -> String {
    SCHEDULER_IDENTITY.clone()
}

fn lease_expires_at(now: DateTime<Utc>, timeout_seconds: u64) -> String {
    (now + chrono::Duration::seconds(
        timeout_seconds.saturating_add(AUTOMATION_LEASE_GRACE_SECS) as i64
    ))
    .to_rfc3339()
}

/// lease 必须覆盖实际硬超时：headless 侧 trusted_profile.timeout_seconds 优先于
/// automation.timeout_seconds（见 headless::resolve_budget），取两者较大值防止
/// 执行器仍活着时 lease 先过期被误判为 stale。
fn effective_lease_timeout_seconds(automation: &AutomationDefinition) -> u64 {
    automation.timeout_seconds.max(
        automation
            .trusted_profile
            .as_ref()
            .map(|profile| profile.timeout_seconds)
            .unwrap_or(0),
    )
}

/// 返回 None 表示不再有下一次触发（once 触发即消耗）。
fn next_after_claim(
    automation: &AutomationDefinition,
    scheduled_for: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>> {
    if automation.schedule.kind == ScheduleKind::Once {
        return Ok(None);
    }
    let base = if automation.catch_up_policy == CatchUpPolicy::CatchUpAll {
        scheduled_for
    } else {
        now
    };
    compute_next_trigger(&automation.schedule, base.with_timezone(&Local))
        .map(|value| Some(value.with_timezone(&Utc)))
}

/// Atomically advances one definition and inserts its unique run row. A second
/// process observing the same slot loses the conditional UPDATE and cannot
/// execute the run twice.
fn claim_scheduled_run(
    db: &Database,
    automation_id: &str,
    expected_next_run_at: &str,
    now: DateTime<Utc>,
) -> Result<Option<ClaimedAutomationRun>> {
    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start automation claim", error))?;
    let automation = tx
        .query_row(
            "SELECT * FROM automation_definitions WHERE id = ?1 AND enabled = 1",
            params![automation_id],
            row_to_automation,
        )
        .optional()
        .map_err(|error| db_error("Failed to load due automation", error))?;
    let Some(mut automation) = automation else {
        return Ok(None);
    };
    if automation.next_run_at.as_deref() != Some(expected_next_run_at) {
        return Ok(None);
    }
    let scheduled_for = parse_utc_datetime(expected_next_run_at)?;
    if scheduled_for > now {
        return Ok(None);
    }
    let has_active_run: bool = tx
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM automation_runs
                 WHERE automation_id = ?1
                   AND status IN ('queued', 'running', 'retrying')
             )",
            params![automation_id],
            |row| row.get(0),
        )
        .map_err(|error| db_error("Failed to check active automation runs", error))?;
    if has_active_run {
        return Ok(None);
    }

    let next_run_at =
        next_after_claim(&automation, scheduled_for, now)?.map(|value| value.to_rfc3339());
    let changed = tx
        .execute(
            "UPDATE automation_definitions
             SET last_run_at = ?3, next_run_at = ?4, updated_at = ?5
             WHERE id = ?1 AND enabled = 1 AND next_run_at = ?2",
            params![
                automation_id,
                expected_next_run_at,
                scheduled_for.to_rfc3339(),
                next_run_at,
                now.to_rfc3339(),
            ],
        )
        .map_err(|error| db_error("Failed to advance automation schedule", error))?;
    if changed != 1 {
        return Ok(None);
    }

    let run_id = format!("run_{}", uuid::Uuid::new_v4());
    let dedupe_key = format!("schedule:{}:{}", automation_id, scheduled_for.to_rfc3339());
    let lease_expires_at = lease_expires_at(now, effective_lease_timeout_seconds(&automation));
    tx.execute(
        "INSERT INTO automation_runs (
            id, automation_id, dedupe_key, trigger_type, scheduled_for, status,
            attempt, max_attempts, claimed_by, claimed_at, lease_expires_at,
            started_at, delivered_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'schedule', ?4, 'running', 1, ?5, ?6, ?7, ?8, ?7, '[]', ?7, ?7)",
        params![
            run_id,
            automation_id,
            dedupe_key,
            scheduled_for.to_rfc3339(),
            automation.max_retries as i64 + 1,
            scheduler_identity(),
            now.to_rfc3339(),
            lease_expires_at,
        ],
    )
    .map_err(|error| db_error("Failed to create automation run", error))?;
    tx.commit()
        .map_err(|error| db_error("Failed to commit automation claim", error))?;

    automation.last_run_at = Some(scheduled_for.to_rfc3339());
    automation.next_run_at = next_run_at;
    Ok(Some(ClaimedAutomationRun {
        run_id,
        automation,
        scheduled_for: scheduled_for.to_rfc3339(),
        trigger_type: "schedule",
        attempt: 1,
    }))
}

fn create_manual_run(
    db: &Database,
    automation_id: &str,
    expected_version: u64,
) -> Result<ClaimedAutomationRun> {
    let expected_version_db = i64::try_from(expected_version).map_err(|_| {
        AppError::validation("expected_version must be a positive 64-bit integer".to_string())
    })?;
    if expected_version == 0 {
        return Err(AppError::validation(
            "expected_version must be at least 1".to_string(),
        ));
    }
    let now = Utc::now();
    let run_id = format!("run_{}", uuid::Uuid::new_v4());
    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start manual automation run", error))?;
    let automation = tx
        .query_row(
            "SELECT * FROM automation_definitions WHERE id = ?1 AND version = ?2",
            params![automation_id, expected_version_db],
            row_to_automation,
        )
        .optional()
        .map_err(|error| db_error("Failed to load automation", error))?;
    let automation = match automation {
        Some(automation) => automation,
        None => {
            let current = tx
                .query_row(
                    "SELECT * FROM automation_definitions WHERE id = ?1",
                    params![automation_id],
                    row_to_automation,
                )
                .optional()
                .map_err(|error| db_error("Failed to load current automation", error))?
                .ok_or_else(|| {
                    AppError::validation(format!("Automation '{}' not found", automation_id))
                })?;
            return Err(automation_version_conflict_error(
                automation_id,
                expected_version,
                &current,
            ));
        }
    };
    // 手动触发与调度触发共用同一互斥语义：已有活跃 run 时拒绝，避免并发重入
    // （agent_turn 的进程内单飞守卫只覆盖本进程，这里是持久化层面的保护）
    let active_run_id: Option<String> = tx
        .query_row(
            "SELECT id FROM automation_runs
             WHERE automation_id = ?1 AND status IN ('queued', 'running', 'retrying')
             ORDER BY created_at DESC LIMIT 1",
            params![automation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| db_error("Failed to check active automation runs", error))?;
    if let Some(active_run_id) = active_run_id {
        return Err(AppError::with_details(
            AppErrorType::Conflict,
            format!(
                "Automation '{}' already has an active run '{}'; wait for it to finish or cancel it first",
                automation_id, active_run_id
            ),
            json!({
                "code": "AUTOMATION_RUN_ALREADY_ACTIVE",
                "automationId": automation_id,
                "activeRunId": active_run_id,
                "retryable": true,
            }),
        ));
    }
    let lease_expires_at = lease_expires_at(now, effective_lease_timeout_seconds(&automation));
    tx.execute(
        "INSERT INTO automation_runs (
            id, automation_id, dedupe_key, trigger_type, scheduled_for, status,
            retry_requested, attempt, max_attempts, claimed_by, claimed_at, lease_expires_at,
            started_at, delivered_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'manual', ?4, 'running', 1, 1, ?5, ?6, ?4, ?7, ?4, '[]', ?4, ?4)",
        params![
            run_id,
            automation.id,
            format!("manual:{}", run_id),
            now.to_rfc3339(),
            automation.max_retries as i64 + 1,
            scheduler_identity(),
            lease_expires_at,
        ],
    )
    .map_err(|error| db_error("Failed to create manual automation run", error))?;
    tx.commit()
        .map_err(|error| db_error("Failed to commit manual automation run", error))?;
    Ok(ClaimedAutomationRun {
        run_id,
        automation,
        scheduled_for: now.to_rfc3339(),
        trigger_type: "manual",
        attempt: 1,
    })
}

fn complete_run(
    db: &Database,
    run_id: &str,
    expected_attempt: i64,
    status: &str,
    delivered: &[String],
    session_id: Option<&str>,
    summary: Option<&str>,
    error: Option<&str>,
) -> Result<bool> {
    let conn = db
        .get_conn_safe()
        .map_err(|cause| db_error("Failed to open automation database", cause))?;
    let now = Utc::now().to_rfc3339();
    let delivered_json = serde_json::to_string(delivered).map_err(|cause| {
        AppError::internal(format!("Failed to serialize delivery list: {}", cause))
    })?;
    let changed = conn
        .execute(
            "UPDATE automation_runs
         SET status = ?2, delivered_json = ?3, session_id = ?4, summary = ?5,
             error = ?6, finished_at = ?7, next_attempt_at = NULL,
             lease_expires_at = NULL, updated_at = ?7
         WHERE id = ?1 AND attempt = ?8 AND status IN ('running', ?2)",
            params![
                run_id,
                status,
                delivered_json,
                session_id,
                summary,
                error,
                now,
                expected_attempt,
            ],
        )
        .map_err(|cause| db_error("Failed to complete automation run", cause))?;
    if changed == 1 {
        prune_run_history(&conn, run_id)?;
    }
    Ok(changed == 1)
}

fn load_run_deliveries(db: &Database, run_id: &str) -> Result<Vec<String>> {
    let conn = db
        .get_conn_safe()
        .map_err(|cause| db_error("Failed to open automation database", cause))?;
    let raw: String = conn
        .query_row(
            "SELECT delivered_json FROM automation_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|cause| db_error("Failed to load automation deliveries", cause))?;
    serde_json::from_str(&raw).map_err(|cause| {
        AppError::internal(format!("Failed to decode automation deliveries: {}", cause))
    })
}

fn set_run_delivery_marker(
    db: &Database,
    run_id: &str,
    expected_attempt: i64,
    expected_status: &str,
    channel: &str,
    present: bool,
) -> Result<bool> {
    let mut conn = db
        .get_conn_safe()
        .map_err(|cause| db_error("Failed to open automation database", cause))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|cause| db_error("Failed to start delivery update", cause))?;
    let current: Option<(i64, String, String)> = tx
        .query_row(
            "SELECT attempt, status, delivered_json FROM automation_runs WHERE id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|cause| db_error("Failed to load delivery state", cause))?;
    let Some((attempt, status, raw)) = current else {
        return Ok(false);
    };
    if attempt != expected_attempt || status != expected_status {
        return Ok(false);
    }
    let mut delivered: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
    let already_present = delivered.iter().any(|entry| entry == channel);
    if present == already_present {
        return Ok(true);
    }
    if present {
        delivered.push(channel.to_string());
    } else {
        delivered.retain(|entry| entry != channel);
    }
    let serialized = serde_json::to_string(&delivered).map_err(|cause| {
        AppError::internal(format!("Failed to serialize delivery state: {}", cause))
    })?;
    let changed = tx
        .execute(
            "UPDATE automation_runs SET delivered_json = ?2, updated_at = ?3
             WHERE id = ?1 AND attempt = ?4 AND status = ?5",
            params![
                run_id,
                serialized,
                Utc::now().to_rfc3339(),
                expected_attempt,
                expected_status,
            ],
        )
        .map_err(|cause| db_error("Failed to update delivery state", cause))?;
    tx.commit()
        .map_err(|cause| db_error("Failed to commit delivery state", cause))?;
    Ok(changed == 1)
}

fn set_notification_retry_at(
    db: &Database,
    run_id: &str,
    expected_attempt: i64,
    expected_status: &str,
    retry_at: Option<String>,
) -> Result<()> {
    let conn = db
        .get_conn_safe()
        .map_err(|cause| db_error("Failed to open automation database", cause))?;
    conn.execute(
        "UPDATE automation_runs SET next_attempt_at = ?2, updated_at = ?3
         WHERE id = ?1 AND attempt = ?4 AND status = ?5",
        params![
            run_id,
            retry_at,
            Utc::now().to_rfc3339(),
            expected_attempt,
            expected_status,
        ],
    )
    .map_err(|cause| db_error("Failed to update notification retry time", cause))?;
    Ok(())
}

/// 主窗口当前是否可见且持有焦点（用户正在看应用）。
///
/// 用于抑制与前端 in-app toast 重复的 OS 完成通知。任一状态查询失败或
/// 窗口缺失时按"不活跃"处理——保守地照常投递 OS 通知，宁多勿漏。
fn main_window_is_active(app_handle: &AppHandle) -> bool {
    let Some(window) = app_handle.get_webview_window("main") else {
        return false;
    };
    let focused = window.is_focused().unwrap_or(false);
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    focused && visible && !minimized
}

/// [`deliver_run_notification`] 的结果：区分「本次真的投递了 OS 通知」
/// 与其余已处理分支，供 run_completed 事件的 `osNotificationDelivered`
/// 字段精确取值（前端据此决定是否补 in-app toast）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunNotificationOutcome {
    /// 本次调用真正向 OS 投递了一条通知
    DeliveredOs,
    /// 主窗口活跃，按约定抑制 OS 通知（前端 in-app toast 覆盖）
    SuppressedWindowActive,
    /// 用户策略为「从不」系统通知（settings 表 system-notification-policy），
    /// 全局拦截；完成类通知由前端 in-app toast 兜底
    SuppressedByPolicy,
    /// 该 run 此前已投递过 OS 通知（at-most-once 早退，本次未新发）
    AlreadyDelivered,
    /// 预约被并发状态推翻或跨进程投递失败（pending 标记保留，调度补投）
    Failed,
}

impl RunNotificationOutcome {
    /// 与旧布尔返回语义一致：非 Failed 即视为「已妥善处理」
    fn handled(self) -> bool {
        !matches!(self, Self::Failed)
    }

    /// 本次调用是否真的发出了 OS 通知
    fn delivered_os(self) -> bool {
        matches!(self, Self::DeliveredOs)
    }
}

/// 投递一条 run 相关的 OS 通知（at-most-once：先落 marker 再跨进程投递）。
///
/// `suppress_if_window_active=true` 用于「完成通知」类投递：主窗口可见且
/// 聚焦时前端会基于 `chat_v2_automation_run_completed` 事件弹 in-app toast，
/// OS 通知会构成双重打扰，此时跳过 OS 投递并清掉 pending 标记（视为已
/// 由前端通道覆盖；不写 "notification" marker，delivered 列表保持诚实）。
/// notify 类型的"到点提醒"本身就是交付物且无前端 toast，必须传 false。
fn deliver_run_notification(
    db: &Database,
    app_handle: &AppHandle,
    run_id: &str,
    expected_attempt: i64,
    expected_status: &str,
    title: &str,
    body: &str,
    suppress_if_window_active: bool,
) -> RunNotificationOutcome {
    let existing = load_run_deliveries(db, run_id).unwrap_or_default();
    if existing.iter().any(|entry| entry == "notification") {
        let _ = set_run_delivery_marker(
            db,
            run_id,
            expected_attempt,
            expected_status,
            "notification_pending",
            false,
        );
        return RunNotificationOutcome::AlreadyDelivered;
    }

    // 用户全局「从不」档：拦截所有自动化 OS 通知（含 notify 类到点提醒）。
    // 处理方式与窗口活跃抑制一致——清 pending、不再重试，避免策略开启期间
    // 积压的补投在用户改回其他档位后突然轰炸。
    if crate::system_notification::notifications_disabled(db) {
        let _ = set_run_delivery_marker(
            db,
            run_id,
            expected_attempt,
            expected_status,
            "notification_pending",
            false,
        );
        if expected_status != "running" {
            let _ = set_notification_retry_at(db, run_id, expected_attempt, expected_status, None);
        }
        tracing::debug!(
            "[AutomationScheduler] system notifications disabled by policy; suppressed OS notification for run '{}'",
            run_id
        );
        return RunNotificationOutcome::SuppressedByPolicy;
    }

    if suppress_if_window_active && main_window_is_active(app_handle) {
        let _ = set_run_delivery_marker(
            db,
            run_id,
            expected_attempt,
            expected_status,
            "notification_pending",
            false,
        );
        if expected_status != "running" {
            let _ = set_notification_retry_at(db, run_id, expected_attempt, expected_status, None);
        }
        tracing::debug!(
            "[AutomationScheduler] main window active; suppressed OS notification for run '{}' (in-app toast covers it)",
            run_id
        );
        return RunNotificationOutcome::SuppressedWindowActive;
    }

    // Reserve before crossing into the OS notification service. Desktop APIs
    // do not expose an idempotent acknowledgement, so this deliberately gives
    // notifications at-most-once behavior across a process crash.
    match set_run_delivery_marker(
        db,
        run_id,
        expected_attempt,
        expected_status,
        "notification",
        true,
    ) {
        Ok(true) => {}
        Ok(false) => return RunNotificationOutcome::Failed,
        Err(error) => {
            tracing::warn!(
                "[AutomationScheduler] reserve notification failed: {}",
                error
            );
            return RunNotificationOutcome::Failed;
        }
    }

    if send_notification(app_handle, run_id, title, body) {
        let _ = set_run_delivery_marker(
            db,
            run_id,
            expected_attempt,
            expected_status,
            "notification_pending",
            false,
        );
        if expected_status != "running" {
            let _ = set_notification_retry_at(db, run_id, expected_attempt, expected_status, None);
        }
        RunNotificationOutcome::DeliveredOs
    } else {
        if let Err(error) = set_run_delivery_marker(
            db,
            run_id,
            expected_attempt,
            expected_status,
            "notification",
            false,
        ) {
            tracing::warn!(
                "[AutomationScheduler] release notification reservation failed: {}",
                error
            );
        }
        if expected_status != "running" {
            let retry_at = (Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
            let _ = set_notification_retry_at(
                db,
                run_id,
                expected_attempt,
                expected_status,
                Some(retry_at),
            );
        }
        RunNotificationOutcome::Failed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunFinalizeOutcome {
    Finished,
    RetryScheduled,
    Superseded,
}

fn prune_run_history(conn: &rusqlite::Connection, run_id: &str) -> Result<()> {
    let automation_id: Option<String> = conn
        .query_row(
            "SELECT automation_id FROM automation_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|cause| db_error("Failed to resolve automation run owner", cause))?;
    let Some(automation_id) = automation_id else {
        return Ok(());
    };
    conn.execute(
        "DELETE FROM automation_runs
         WHERE automation_id = ?1
           AND status NOT IN ('queued', 'running', 'retrying')
           AND id NOT IN (
               SELECT id FROM automation_runs
               WHERE automation_id = ?1
               ORDER BY created_at DESC, id DESC
               LIMIT ?2
           )",
        params![automation_id, MAX_STORED_RUNS_PER_AUTOMATION as i64],
    )
    .map_err(|cause| db_error("Failed to prune automation run history", cause))?;
    Ok(())
}

fn retry_or_finish_run(
    db: &Database,
    run_id: &str,
    expected_attempt: i64,
    automation: &AutomationDefinition,
    terminal_status: &str,
    session_id: Option<&str>,
    error: &str,
    notify_on_terminal: bool,
) -> Result<RunFinalizeOutcome> {
    let conn = db
        .get_conn_safe()
        .map_err(|cause| db_error("Failed to open automation database", cause))?;
    let (attempt, max_attempts, current_status, delivered_json): (i64, i64, String, String) = conn
        .query_row(
            "SELECT attempt, max_attempts, status, delivered_json
             FROM automation_runs WHERE id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|cause| db_error("Failed to load automation attempt", cause))?;
    if attempt != expected_attempt || current_status != "running" {
        return Ok(RunFinalizeOutcome::Superseded);
    }
    if attempt < max_attempts {
        let exponent = (attempt - 1).clamp(0, 10) as u32;
        // 指数退避封顶 24h：基数最大 86400s，放大后不能把重试推迟到数天后
        let delay = automation
            .retry_backoff_seconds
            .saturating_mul(2_u64.saturating_pow(exponent))
            .min(MAX_RETRY_BACKOFF_SECS);
        let next_attempt = Utc::now() + chrono::Duration::seconds(delay as i64);
        let changed = conn
            .execute(
                "UPDATE automation_runs
             SET status = 'retrying', error = ?2, session_id = ?3,
                 next_attempt_at = ?4, finished_at = NULL,
                 lease_expires_at = NULL, updated_at = ?5
             WHERE id = ?1 AND status = 'running' AND attempt = ?6",
                params![
                    run_id,
                    error,
                    session_id,
                    next_attempt.to_rfc3339(),
                    Utc::now().to_rfc3339(),
                    expected_attempt,
                ],
            )
            .map_err(|cause| db_error("Failed to schedule automation retry", cause))?;
        if changed == 1 {
            tracing::info!(
                "[AutomationScheduler] run '{}' of '{}' failed on attempt {}/{} ({}); retry in {}s at {}",
                run_id,
                automation.id,
                attempt,
                max_attempts,
                terminal_status,
                delay,
                next_attempt.to_rfc3339()
            );
        }
        Ok(if changed == 1 {
            RunFinalizeOutcome::RetryScheduled
        } else {
            RunFinalizeOutcome::Superseded
        })
    } else {
        let mut delivered: Vec<String> = serde_json::from_str(&delivered_json).unwrap_or_default();
        if notify_on_terminal
            && !delivered.iter().any(|entry| entry == "notification")
            && !delivered
                .iter()
                .any(|entry| entry == "notification_pending")
        {
            delivered.push("notification_pending".to_string());
        }
        drop(conn);
        let changed = complete_run(
            db,
            run_id,
            expected_attempt,
            terminal_status,
            &delivered,
            session_id,
            None,
            Some(error),
        )?;
        Ok(if changed {
            RunFinalizeOutcome::Finished
        } else {
            RunFinalizeOutcome::Superseded
        })
    }
}

fn process_due_automation(
    db: &Arc<Database>,
    vfs_db: Option<&Arc<VfsDatabase>>,
    app_handle: &AppHandle,
    claimed: ClaimedAutomationRun,
    now: DateTime<Local>,
) -> Option<Value> {
    if !automation_dispatch_allowed()
        || crate::chat_v2::kill_switch::admit_or_block_from_app(app_handle).is_err()
    {
        tracing::info!(
            "[AutomationScheduler] skip dispatch for run={} (scheduler paused / kill switch)",
            claimed.run_id
        );
        // Run was already claimed; mark cancelled so it does not stay stuck as running.
        match complete_run(
            db,
            &claimed.run_id,
            claimed.attempt,
            "cancelled",
            &[],
            None,
            Some("Skipped: AgentKillSwitch / automation scheduler paused"),
            None,
        ) {
            // once 的时点在 claim 时已被消耗，取消同样是终态，需要固化收尾，
            // 否则该 once 定义会以 enabled=1 + next_run_at=NULL 悬空。
            Ok(true) => finalize_once_automation(db, Some(app_handle), &claimed.automation),
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(
                    "[AutomationScheduler] failed to cancel claimed run '{}' during pause: {}",
                    claimed.run_id,
                    error
                );
            }
        }
        // 前端依赖该事件刷新列表：kill switch 取消已 claim 的 run 也要通知
        emit_automations_changed(app_handle, "run_cancelled", &claimed.automation.id);
        return None;
    }

    let automation = &claimed.automation;

    if automation.action_type == AutomationActionType::AgentTurn {
        match spawn_claimed_agent_turn(app_handle.clone(), db.clone(), claimed.clone()) {
            Ok(()) => tracing::info!(
                "[AutomationScheduler] fired agent_turn automation '{}' run={}",
                automation.name,
                claimed.run_id
            ),
            Err(error) => {
                tracing::warn!(
                    "[AutomationScheduler] agent_turn automation '{}' failed to start: {}",
                    automation.name,
                    error
                );
                let finalize_outcome = retry_or_finish_run(
                    db,
                    &claimed.run_id,
                    claimed.attempt,
                    automation,
                    "spawn_error",
                    None,
                    &error,
                    !automation.heartbeat,
                )
                .unwrap_or_else(|persist_error| {
                    tracing::error!(
                        "[AutomationScheduler] failed to persist spawn_error for run '{}': {}",
                        claimed.run_id,
                        persist_error
                    );
                    RunFinalizeOutcome::Finished
                });
                if finalize_outcome == RunFinalizeOutcome::Finished {
                    finalize_once_automation(db, Some(app_handle), automation);
                }
                if finalize_outcome == RunFinalizeOutcome::Finished && !automation.heartbeat {
                    // spawn_error 终态不经过 run_completed 事件（无前端 toast），
                    // OS 通知是唯一告知渠道，不做窗口活跃抑制。
                    let lang = notification_language(db);
                    let _ = deliver_run_notification(
                        db,
                        app_handle,
                        &claimed.run_id,
                        claimed.attempt,
                        "spawn_error",
                        &notification_title_failed(lang, &automation.name),
                        &truncate_for_notification(&error, 120),
                        false,
                    );
                }
            }
        }
        return None;
    }

    let lang = notification_language(db);
    let notification_body = truncate_prompt_for_notification(&automation.prompt, lang);
    // notify 类型的到点提醒是交付物本身（前端无对应 toast），永不抑制
    let _ = deliver_run_notification(
        db,
        app_handle,
        &claimed.run_id,
        claimed.attempt,
        "running",
        &notification_title_running(lang, &automation.name),
        &notification_body,
        false,
    );

    let already_delivered = load_run_deliveries(db, &claimed.run_id).unwrap_or_default();
    if !already_delivered.iter().any(|entry| entry == "todo") {
        let todo_created = vfs_db.is_some_and(|vfs_db| {
            create_automation_todo(
                app_handle,
                vfs_db,
                &claimed.run_id,
                &automation.name,
                &automation.prompt,
                now,
            )
        });
        if todo_created {
            if let Err(error) = set_run_delivery_marker(
                db,
                &claimed.run_id,
                claimed.attempt,
                "running",
                "todo",
                true,
            ) {
                tracing::warn!(
                    "[AutomationScheduler] failed to persist todo delivery for '{}': {}",
                    claimed.run_id,
                    error
                );
            }
        }
    }

    let delivered = load_run_deliveries(db, &claimed.run_id).unwrap_or_default();
    let notification_delivered = delivered.iter().any(|entry| entry == "notification");
    let todo_delivered = delivered.iter().any(|entry| entry == "todo");
    let error_message = match (notification_delivered, todo_delivered) {
        (false, false) => "Notification and todo delivery both failed",
        (false, true) => "Notification delivery failed",
        (true, false) => "Todo delivery failed",
        (true, true) => "",
    };

    let finalize_outcome = if error_message.is_empty() {
        match complete_run(
            db,
            &claimed.run_id,
            claimed.attempt,
            "success",
            &delivered,
            None,
            Some(&automation.prompt),
            None,
        ) {
            Ok(true) => RunFinalizeOutcome::Finished,
            Ok(false) => RunFinalizeOutcome::Superseded,
            Err(error) => {
                tracing::warn!(
                    "[AutomationScheduler] failed to finish run '{}' for '{}': {}",
                    claimed.run_id,
                    automation.id,
                    error
                );
                RunFinalizeOutcome::Superseded
            }
        }
    } else {
        retry_or_finish_run(
            db,
            &claimed.run_id,
            claimed.attempt,
            automation,
            "error",
            None,
            error_message,
            false,
        )
        .unwrap_or_else(|persist_error| {
            tracing::error!(
                "[AutomationScheduler] failed to persist notify delivery outcome for run '{}': {}",
                claimed.run_id,
                persist_error
            );
            RunFinalizeOutcome::Superseded
        })
    };

    if finalize_outcome == RunFinalizeOutcome::Finished {
        finalize_once_automation(db, Some(app_handle), automation);
    }

    let persisted_status = match finalize_outcome {
        RunFinalizeOutcome::Finished if error_message.is_empty() => "success",
        RunFinalizeOutcome::Finished => "error",
        RunFinalizeOutcome::RetryScheduled => "retrying",
        RunFinalizeOutcome::Superseded => "superseded",
    };
    emit_automations_changed(app_handle, "run_completed", &automation.id);
    Some(json!({
        "status": persisted_status,
        "automationId": automation.id,
        "runId": claimed.run_id,
        "delivered": delivered,
        "error": (!error_message.is_empty()).then_some(error_message),
    }))
}

// ============================================================================
// agent_turn：headless 运行、单飞与心跳
// ============================================================================

/// 单飞注册表：同一 automation 不并发重入
static RUNNING_AGENT_AUTOMATIONS: LazyLock<StdMutex<HashSet<String>>> =
    LazyLock::new(|| StdMutex::new(HashSet::new()));
#[derive(Clone)]
struct ActiveAutomationRunEntry {
    generation: u64,
    token: CancellationToken,
}

static NEXT_ACTIVE_AUTOMATION_RUN_GENERATION: AtomicU64 = AtomicU64::new(1);
static ACTIVE_AUTOMATION_RUNS: LazyLock<StdMutex<HashMap<String, ActiveAutomationRunEntry>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

struct ActiveAutomationRunGuard {
    run_id: String,
    generation: u64,
}

impl ActiveAutomationRunGuard {
    fn register(run_id: &str) -> (Self, CancellationToken) {
        let token = CancellationToken::new();
        let generation = NEXT_ACTIVE_AUTOMATION_RUN_GENERATION.fetch_add(1, Ordering::Relaxed);
        ACTIVE_AUTOMATION_RUNS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                run_id.to_string(),
                ActiveAutomationRunEntry {
                    generation,
                    token: token.clone(),
                },
            );
        (
            Self {
                run_id: run_id.to_string(),
                generation,
            },
            token,
        )
    }
}

impl Drop for ActiveAutomationRunGuard {
    fn drop(&mut self) {
        let mut active = ACTIVE_AUTOMATION_RUNS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active
            .get(&self.run_id)
            .is_some_and(|current| current.generation == self.generation)
        {
            active.remove(&self.run_id);
        }
    }
}

fn automation_run_has_live_executor(run_id: &str) -> bool {
    ACTIVE_AUTOMATION_RUNS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(run_id)
}

fn automation_run_is_running(db: &Database, run_id: &str, attempt: i64) -> Result<bool> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM automation_runs
             WHERE id = ?1 AND attempt = ?2 AND status = 'running'
         )",
        params![run_id, attempt],
        |row| row.get(0),
    )
    .map_err(|error| db_error("Failed to verify automation run state", error))
}

fn cancel_active_automation_runs_for_shutdown() {
    cancel_active_automation_run_tokens("shutdown");
}

/// Cancel in-flight automation agent turns (Kill Switch emergency_stop).
pub fn cancel_active_automation_runs_for_emergency_stop() {
    cancel_active_automation_run_tokens("emergency_stop");
}

fn cancel_active_automation_run_tokens(reason: &str) {
    let tokens: Vec<CancellationToken> = ACTIVE_AUTOMATION_RUNS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
        .map(|entry| entry.token.clone())
        .collect();
    let count = tokens.len();
    for token in tokens {
        token.cancel();
    }
    if count > 0 {
        tracing::warn!(
            "[AutomationScheduler] cancelled {} active automation run token(s) ({})",
            count,
            reason
        );
    }
}

/// RAII 单飞守卫：drop（含 panic 路径）时释放占用
pub struct AgentAutomationRunGuard {
    automation_id: String,
}

impl AgentAutomationRunGuard {
    /// 尝试占用；已有同 ID 在运行时返回 None
    pub fn try_acquire(automation_id: &str) -> Option<Self> {
        let mut running = RUNNING_AGENT_AUTOMATIONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if running.contains(automation_id) {
            return None;
        }
        running.insert(automation_id.to_string());
        Some(Self {
            automation_id: automation_id.to_string(),
        })
    }
}

impl Drop for AgentAutomationRunGuard {
    fn drop(&mut self) {
        let mut running = RUNNING_AGENT_AUTOMATIONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        running.remove(&self.automation_id);
    }
}

/// 心跳回复是否应静默吞掉（最终回复必须只有 HEARTBEAT_OK 哨兵串）
pub fn heartbeat_is_silent(content: &str) -> bool {
    content.trim() == HEARTBEAT_OK_SENTINEL
}

fn truncate_for_notification(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let preview: String = trimmed.chars().take(max_chars).collect();
    if trimmed.chars().count() > max_chars {
        format!("{}…", preview)
    } else {
        preview
    }
}

fn notification_id_for_run(run_id: &str) -> i32 {
    let hash = run_id
        .as_bytes()
        .iter()
        .fold(2_166_136_261_u32, |value, byte| {
            (value ^ u32::from(*byte)).wrapping_mul(16_777_619)
        });
    (hash & i32::MAX as u32) as i32
}

fn send_notification(app_handle: &AppHandle, run_id: &str, title: &str, body: &str) -> bool {
    match app_handle
        .notification()
        .builder()
        .id(notification_id_for_run(run_id))
        .title(title)
        .body(body)
        .show()
    {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(
                "[AutomationScheduler] notification failed for '{}': {}",
                title,
                e
            );
            false
        }
    }
}

/// 拉起一次 agent_turn 自动化运行（单飞 + 后台执行）。
///
/// 同步部分：占用单飞守卫、消费触发（last_run_at）；随后 spawn 后台任务执行
/// headless turn（隔离会话由 headless runner 创建，超时取任务配置），
/// 隔离会话 ID 经完成事件与运行历史返回。
pub fn spawn_agent_turn_automation(
    app_handle: AppHandle,
    db: Arc<Database>,
    automation_id: &str,
    expected_version: u64,
    agent_facing: bool,
    trigger: &'static str,
) -> std::result::Result<(), String> {
    let Some(guard) = AgentAutomationRunGuard::try_acquire(automation_id) else {
        return Err(format!(
            "Automation '{}' is already running (single-flight)",
            automation_id
        ));
    };
    let claimed = create_manual_run(&db, automation_id, expected_version)
        .map_err(|error| serialize_automation_update_error(error, agent_facing))?;
    debug_assert_eq!(
        trigger, "manual",
        "public spawn path is reserved for manual runs"
    );
    spawn_claimed_agent_turn_with_guard(app_handle, db, claimed, guard);
    Ok(())
}

fn spawn_claimed_agent_turn(
    app_handle: AppHandle,
    db: Arc<Database>,
    claimed: ClaimedAutomationRun,
) -> std::result::Result<(), String> {
    let Some(guard) = AgentAutomationRunGuard::try_acquire(&claimed.automation.id) else {
        return Err(format!(
            "Automation '{}' is already running (single-flight)",
            claimed.automation.id
        ));
    };

    spawn_claimed_agent_turn_with_guard(app_handle, db, claimed, guard);
    Ok(())
}

fn spawn_claimed_agent_turn_with_guard(
    app_handle: AppHandle,
    db: Arc<Database>,
    claimed: ClaimedAutomationRun,
    guard: AgentAutomationRunGuard,
) {
    let (active_run_guard, cancellation_token) =
        ActiveAutomationRunGuard::register(&claimed.run_id);
    // Cancellation can commit after the run row is claimed but before its
    // in-memory token is registered. Re-read the durable state after
    // registration so that such a cancellation wins deterministically.
    // 读取失败按"未运行"处理（放弃启动，run 行留待 lease 过期回收），但必须留痕。
    let run_is_running = automation_run_is_running(&db, &claimed.run_id, claimed.attempt)
        .unwrap_or_else(|error| {
            tracing::warn!(
                "[AutomationScheduler] failed to verify run '{}' before spawn; deferring to lease recovery: {}",
                claimed.run_id,
                error
            );
            false
        });
    if !run_is_running {
        cancellation_token.cancel();
        return;
    }
    crate::background_tasks::spawn(async move {
        let _guard = guard;
        let _active_run_guard = active_run_guard;
        execute_agent_turn_automation(app_handle, db, claimed, cancellation_token).await;
    });
}

/// 执行一次 agent_turn 自动化并投递结果通知（后台任务体）。
async fn execute_agent_turn_automation(
    app_handle: AppHandle,
    db: Arc<Database>,
    claimed: ClaimedAutomationRun,
    cancellation_token: CancellationToken,
) {
    let automation = claimed.automation;
    match automation_run_is_running(&db, &claimed.run_id, claimed.attempt) {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            tracing::warn!(
                "[AutomationScheduler] failed to verify run '{}' before executing; deferring to lease recovery: {}",
                claimed.run_id,
                error
            );
            return;
        }
    }

    // 心跳空转优化：非手动触发的心跳在拉起 headless turn 前先做一次纯 DB
    // 检查（到期复习计划 / 到期或逾期待办计数），全空则跳过整个 LLM 调用，
    // 直接按既有 heartbeat_ok 成功路径落库（幂等语义与静默行为不变）。
    if automation.heartbeat && claimed.trigger_type != "manual" {
        let idle = app_handle
            .try_state::<Arc<VfsDatabase>>()
            .map(|vfs_db| match heartbeat_has_pending_work(&vfs_db) {
                Ok(has_work) => !has_work,
                Err(error) => {
                    // 预检失败时 fail-open：照常执行 LLM 检查，不吞掉心跳
                    tracing::debug!(
                        "[AutomationScheduler] heartbeat '{}' idle precheck failed ({}); falling back to LLM run",
                        automation.name,
                        error
                    );
                    false
                }
            })
            .unwrap_or(false);
        if idle {
            tracing::debug!(
                "[AutomationScheduler] heartbeat '{}' idle precheck found no due reviews or todos; skipping LLM call for run={}",
                automation.name,
                claimed.run_id
            );
            finalize_heartbeat_idle_skip(
                &app_handle,
                &db,
                &automation,
                &claimed.run_id,
                claimed.attempt,
            );
            return;
        }
    }

    // 会话由 headless runner 创建/复用：
    // - isolated（默认）：每次新建，metadata 标注 automation_run/source；
    // - named：复用 agent_session_id 指向的固定会话（跨运行积累上下文）
    let session_mode = automation.session_mode.unwrap_or_default();
    // 通知/会话标题语言：每次运行时读取一次已保存的界面语言设置
    let lang = notification_language(&db);
    let request = HeadlessTurnRequest {
        prompt: effective_agent_prompt(&automation),
        session_mode,
        named_session_id: automation.agent_session_id.clone(),
        model_id: automation.model_id.clone(),
        source: format!("automation:{}:{}", automation.id, claimed.trigger_type),
        title: Some(notification_title_running(lang, &automation.name)),
        hard_timeout_secs: Some(automation.timeout_seconds),
        max_tool_rounds: automation
            .trusted_profile
            .as_ref()
            .map(|profile| profile.max_tool_rounds),
        trusted_profile: automation.trusted_profile.clone(),
        cancellation_token: Some(cancellation_token.clone()),
    };
    let result = run_headless_turn(app_handle.clone(), request).await;

    // named 模式：回存实际使用的会话 ID（首次运行/旧会话失效重建时会变化）
    if session_mode == HeadlessSessionMode::Named {
        if let Ok(outcome) = result.as_ref() {
            if automation.agent_session_id.as_deref() != Some(outcome.session_id.as_str()) {
                if let Err(e) = update_automation_agent_session_id(
                    &db,
                    &automation.id,
                    automation.version,
                    &outcome.session_id,
                ) {
                    tracing::warn!(
                        "[AutomationScheduler] failed to persist named session id for '{}': {}",
                        automation.id,
                        e
                    );
                }
            }
        }
    }

    let status: String;
    let summary: String;
    let session_id: Option<String>;

    match result {
        Ok(outcome) => {
            session_id = Some(outcome.session_id.clone());
            if outcome.status == "completed" {
                if automation.heartbeat && heartbeat_is_silent(&outcome.summary) {
                    // 心跳无事：静默吞掉，不发任何通知
                    status = "heartbeat_ok".to_string();
                    summary = HEARTBEAT_OK_SENTINEL.to_string();
                    tracing::info!(
                        "[AutomationScheduler] heartbeat '{}' reported OK; suppressing notification",
                        automation.name
                    );
                } else {
                    status = "success".to_string();
                    summary = truncate_for_notification(&outcome.summary, 120);
                }
            } else {
                // timeout | error（消息/块已按管线取消/错误路径落库）
                status = outcome.status.clone();
                summary = truncate_for_notification(
                    outcome.error.as_deref().unwrap_or("headless turn failed"),
                    160,
                );
                tracing::warn!(
                    "[AutomationScheduler] agent_turn automation '{}' ended with status={}: {:?}",
                    automation.name,
                    outcome.status,
                    outcome.error
                );
            }
        }
        Err(e) => {
            // 基础设施级失败（管线未初始化 / 无窗口 / 会话流冲突等）。
            // A pre-start external cancellation is represented by the typed
            // ChatV2 cancellation error rather than inferred from token state.
            session_id = None;
            status = if matches!(&e, crate::chat_v2::error::ChatV2Error::Cancelled) {
                "cancelled".to_string()
            } else {
                "error".to_string()
            };
            summary = truncate_for_notification(&e.to_string(), 160);
            tracing::warn!(
                "[AutomationScheduler] agent_turn automation '{}' failed: {}",
                automation.name,
                e
            );
        }
    }

    // Shutdown cancellation is not a user decision and must not consume an
    // attempt or turn the durable run into `cancelled`. The next process boot
    // immediately recovers this foreign lease.
    if status == "cancelled" && automation_app_is_exiting() {
        tracing::info!(
            "[AutomationScheduler] leaving run '{}' recoverable during shutdown",
            claimed.run_id
        );
        return;
    }

    let successful = matches!(status.as_str(), "success" | "heartbeat_ok");
    let completion_deliveries = if status == "success" && !automation.heartbeat {
        vec!["notification_pending".to_string()]
    } else {
        Vec::new()
    };
    let finalize_outcome = if successful {
        match complete_run(
            &db,
            &claimed.run_id,
            claimed.attempt,
            &status,
            &completion_deliveries,
            session_id.as_deref(),
            Some(&summary),
            None,
        ) {
            Ok(true) => RunFinalizeOutcome::Finished,
            Ok(false) => RunFinalizeOutcome::Superseded,
            Err(error) => {
                tracing::warn!("[AutomationScheduler] failed to complete run: {}", error);
                RunFinalizeOutcome::Superseded
            }
        }
    } else if status == "cancelled" {
        match complete_run(
            &db,
            &claimed.run_id,
            claimed.attempt,
            "cancelled",
            &[],
            session_id.as_deref(),
            Some(&summary),
            Some(&summary),
        ) {
            Ok(true) => RunFinalizeOutcome::Finished,
            Ok(false) => RunFinalizeOutcome::Superseded,
            Err(error) => {
                tracing::warn!(
                    "[AutomationScheduler] failed to persist cancellation: {}",
                    error
                );
                RunFinalizeOutcome::Superseded
            }
        }
    } else {
        match retry_or_finish_run(
            &db,
            &claimed.run_id,
            claimed.attempt,
            &automation,
            &status,
            session_id.as_deref(),
            &summary,
            !automation.heartbeat,
        ) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!("[AutomationScheduler] failed to persist retry: {}", error);
                RunFinalizeOutcome::Superseded
            }
        }
    };

    if finalize_outcome == RunFinalizeOutcome::Superseded {
        emit_automations_changed(&app_handle, "run_superseded", &automation.id);
        return;
    }
    let retry_scheduled = finalize_outcome == RunFinalizeOutcome::RetryScheduled;
    if finalize_outcome == RunFinalizeOutcome::Finished {
        // once 任务的唯一 run 走到终态（成功/失败/取消均已消耗其时点）即完成
        finalize_once_automation(&db, Some(&app_handle), &automation);
    }

    // 通知投递闭环：记录后端本次是否真的发出了 OS 通知，随 run_completed
    // 事件下发（osNotificationDelivered）。前端据此精确互补：已投递则不再弹
    // in-app toast（消双通知），未投递则由前端兜底（消焦点竞态下的丢通知）。
    let mut os_notification_delivered = false;
    if successful && status == "success" {
        let body = notification_success_body(lang, &summary, session_id.as_deref());
        // 完成通知：紧随其后的 run_completed 事件会让前端在窗口可见时弹
        // in-app toast，主窗口活跃时抑制 OS 通知避免双重打扰
        os_notification_delivered = deliver_run_notification(
            &db,
            &app_handle,
            &claimed.run_id,
            claimed.attempt,
            "success",
            &notification_title_success(lang, &automation.name),
            &body,
            true,
        )
        .delivered_os();
    } else if !successful && !retry_scheduled && status != "cancelled" && !automation.heartbeat {
        os_notification_delivered = deliver_run_notification(
            &db,
            &app_handle,
            &claimed.run_id,
            claimed.attempt,
            &status,
            &notification_title_failed(lang, &automation.name),
            &summary,
            true,
        )
        .delivered_os();
    }

    let emitted_status = if retry_scheduled {
        "retrying"
    } else {
        status.as_str()
    };
    if let Err(error) = app_handle.emit(
        "chat_v2_automation_run_completed",
        json!({
            "automationId": automation.id,
            "automationName": automation.name,
            "sessionId": session_id,
            "runId": claimed.run_id,
            // 前端用 runId:attempt 做精确通知去重（同一 run 手动重试会复用
            // runId 但 attempt 递增）
            "attempt": claimed.attempt,
            "status": emitted_status,
            "summary": summary,
            "heartbeat": automation.heartbeat,
            // 后端实际发出 OS 通知才为 true（抑制/早退/失败均为 false）
            "osNotificationDelivered": os_notification_delivered,
        }),
    ) {
        tracing::warn!(
            "[AutomationScheduler] failed to emit run_completed for run '{}': {}",
            claimed.run_id,
            error
        );
    }
    emit_automations_changed(&app_handle, "run_completed", &automation.id);
}

// ============================================================================
// Heartbeat 预置自动化
// ============================================================================

/// 心跳空转预检：纯 DB 查询判断是否有需要 LLM 检查的实质工作。
///
/// 口径与默认心跳 prompt 的前两项检查对齐：
/// - 今日到期或已逾期的待办（同 `VfsTodoRepo::counts_snapshot` 的 today 口径）；
/// - 到期复习计划（同 `VfsReviewPlanRepo::list_due_reviews`：`next_review_date <= 今天`
///   且非 suspended）。
///
/// 返回 `Ok(true)` 表示有待处理内容，应照常拉起 headless turn。
/// 查询失败返回 `Err`，调用方 fail-open（照常执行 LLM 检查）。
fn heartbeat_has_pending_work(vfs_db: &VfsDatabase) -> std::result::Result<bool, String> {
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|error| format!("open VFS database failed: {}", error))?;
    let today = Local::now().format("%Y-%m-%d").to_string();

    let due_todos: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM todo_items
             WHERE status = 'pending' AND due_date <= ?1 AND deleted_at IS NULL",
            params![today],
            |row| row.get(0),
        )
        .map_err(|error| format!("count due todos failed: {}", error))?;
    if due_todos > 0 {
        return Ok(true);
    }

    let due_reviews: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM review_plans
             WHERE next_review_date <= ?1 AND status != 'suspended'",
            params![today],
            |row| row.get(0),
        )
        .map_err(|error| format!("count due reviews failed: {}", error))?;
    Ok(due_reviews > 0)
}

/// 空转心跳跳过 LLM 调用后的收尾：按既有 `heartbeat_ok` 成功路径落库并广播，
/// 与 `execute_agent_turn_automation` 中模型输出哨兵串的静默分支保持一致
/// （消费触发、终态 run 记录、`run_completed` 事件；不发任何通知）。
fn finalize_heartbeat_idle_skip(
    app_handle: &AppHandle,
    db: &Database,
    automation: &AutomationDefinition,
    run_id: &str,
    attempt: i64,
) {
    let finished = match complete_run(
        db,
        run_id,
        attempt,
        "heartbeat_ok",
        &[],
        None,
        Some(HEARTBEAT_OK_SENTINEL),
        None,
    ) {
        Ok(changed) => changed,
        Err(error) => {
            tracing::warn!(
                "[AutomationScheduler] failed to complete idle heartbeat run '{}': {}",
                run_id,
                error
            );
            false
        }
    };
    if !finished {
        emit_automations_changed(app_handle, "run_superseded", &automation.id);
        return;
    }
    finalize_once_automation(db, Some(app_handle), automation);
    if let Err(error) = app_handle.emit(
        "chat_v2_automation_run_completed",
        json!({
            "automationId": automation.id,
            "automationName": automation.name,
            "sessionId": Value::Null,
            "runId": run_id,
            "attempt": attempt,
            "status": "heartbeat_ok",
            "summary": HEARTBEAT_OK_SENTINEL,
            "heartbeat": automation.heartbeat,
            // 空转心跳不发任何通知，与主路径字段保持一致
            "osNotificationDelivered": false,
        }),
    ) {
        tracing::warn!(
            "[AutomationScheduler] failed to emit run_completed for idle heartbeat run '{}': {}",
            run_id,
            error
        );
    }
    emit_automations_changed(app_handle, "run_completed", &automation.id);
}

/// 默认心跳自动化定义（enabled=false，用户/前端显式开启后生效）
pub fn default_heartbeat_definition(now: DateTime<Utc>) -> AutomationDefinition {
    AutomationDefinition {
        id: HEARTBEAT_AUTOMATION_ID.to_string(),
        name: "学习心跳检查".to_string(),
        schedule: AutomationSchedule {
            kind: ScheduleKind::Interval,
            time: String::new(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: Some(DEFAULT_HEARTBEAT_INTERVAL_MINUTES),
            date: None,
            timezone: None,
        },
        prompt: DEFAULT_HEARTBEAT_PROMPT.to_string(),
        enabled: false,
        created_at: now.to_rfc3339(),
        session_id: String::new(),
        last_run_at: None,
        next_run_at: None,
        action_type: AutomationActionType::AgentTurn,
        heartbeat: true,
        agent_prompt: None,
        session_mode: None,
        model_id: None,
        agent_session_id: None,
        catch_up_policy: CatchUpPolicy::RunOnce,
        max_retries: DEFAULT_MAX_RETRIES,
        retry_backoff_seconds: DEFAULT_RETRY_BACKOFF_SECS,
        timeout_seconds: DEFAULT_TIMEOUT_SECS,
        trusted_profile: None,
        version: 1,
    }
}

/// 纯函数：列表中不存在心跳自动化时补齐预置项。返回是否新增。
pub fn ensure_heartbeat_in_list(
    automations: &mut Vec<AutomationDefinition>,
    now: DateTime<Utc>,
) -> bool {
    let exists = automations
        .iter()
        .any(|a| a.heartbeat || a.id == HEARTBEAT_AUTOMATION_ID);
    if exists {
        return false;
    }
    automations.push(default_heartbeat_definition(now));
    true
}

/// 幂等确保预置心跳自动化存在（默认 disabled，30 分钟间隔）。
///
/// 空转优化（"无到期任务则跳过 LLM 调用"）见 `heartbeat_has_pending_work` /
/// `execute_agent_turn_automation` 中的心跳预检分支。
pub fn ensure_heartbeat_automation(db: &Database) -> Result<bool> {
    let exists = load_automations(db)?
        .iter()
        .any(|item| item.heartbeat || item.id == HEARTBEAT_AUTOMATION_ID);
    if exists {
        return Ok(false);
    }
    match insert_automation(db, &default_heartbeat_definition(Utc::now())) {
        Ok(()) => {
            tracing::info!(
                "[AutomationScheduler] Provisioned default heartbeat automation (disabled, {}min)",
                DEFAULT_HEARTBEAT_INTERVAL_MINUTES
            );
            Ok(true)
        }
        Err(error) if error.to_string().contains("UNIQUE") => Ok(false),
        Err(error) => Err(error),
    }
}

// ============================================================================
// Tauri 命令：立即运行自动化
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationScheduleCommandRequest {
    pub kind: ScheduleKind,
    #[serde(default)]
    pub time: String,
    #[serde(default)]
    pub weekday: Option<u8>,
    /// weekly 多天扩展（0=Sun … 6=Sat）；与 weekday 并存时 weekdays 优先
    #[serde(default)]
    pub weekdays: Option<Vec<u8>>,
    #[serde(default)]
    pub day_of_month: Option<u8>,
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
}

impl From<AutomationScheduleCommandRequest> for AutomationSchedule {
    fn from(value: AutomationScheduleCommandRequest) -> Self {
        Self {
            kind: value.kind,
            time: value.time,
            weekday: value.weekday,
            weekdays: value.weekdays,
            day_of_month: value.day_of_month,
            interval_minutes: value.interval_minutes,
            date: value.date,
            timezone: value.timezone,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationUpdateCommandRequest {
    pub automation_id: String,
    pub expected_version: u64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub schedule: Option<AutomationScheduleCommandRequest>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub action_type: Option<AutomationActionType>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub agent_prompt: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub session_mode: Option<Option<HeadlessSessionMode>>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub model_id: Option<Option<String>>,
    #[serde(default)]
    pub catch_up_policy: Option<CatchUpPolicy>,
    #[serde(default)]
    pub max_retries: Option<u8>,
    #[serde(default)]
    pub retry_backoff_seconds: Option<u64>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub trusted_profile: Option<Option<TrustedAutomationProfile>>,
}

fn deserialize_optional_nullable<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationCreateCommandRequest {
    pub name: String,
    pub schedule: AutomationScheduleCommandRequest,
    pub prompt: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub action_type: AutomationActionType,
    #[serde(default)]
    pub agent_prompt: Option<String>,
    #[serde(default)]
    pub session_mode: Option<HeadlessSessionMode>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub catch_up_policy: CatchUpPolicy,
    #[serde(default = "default_max_retries")]
    pub max_retries: u8,
    #[serde(default = "default_retry_backoff_seconds")]
    pub retry_backoff_seconds: u64,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub trusted_profile: Option<TrustedAutomationProfile>,
}

const fn default_true() -> bool {
    true
}

async fn run_automation_command_blocking<F>(operation: F) -> std::result::Result<Value, String>
where
    F: FnOnce() -> std::result::Result<Value, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Automation command task failed: {error}"))?
}

#[tauri::command]
pub async fn chat_v2_automation_list(
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    run_automation_command_blocking(move || {
        automation_list_response(&db).map_err(automation_command_error)
    })
    .await
}

#[tauri::command]
pub async fn chat_v2_automation_create(
    request: AutomationCreateCommandRequest,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    let app_handle = app_handle.clone();
    run_automation_command_blocking(move || {
        let automation = create_automation(
            &db,
            AutomationCreateFields {
                name: request.name,
                schedule: request.schedule.into(),
                prompt: request.prompt,
                enabled: request.enabled,
                action_type: request.action_type,
                heartbeat: false,
                agent_prompt: request.agent_prompt,
                session_mode: request.session_mode,
                model_id: request.model_id,
                catch_up_policy: request.catch_up_policy,
                max_retries: request.max_retries,
                retry_backoff_seconds: request.retry_backoff_seconds,
                timeout_seconds: request.timeout_seconds,
                trusted_profile: request.trusted_profile,
                source_session_id: "ui".to_string(),
            },
        )
        .map_err(automation_command_error)?;
        emit_automations_changed(&app_handle, "create", &automation.id);
        Ok(json!({
            "success": true,
            "automation": automation_to_list_item(&automation, Local::now()),
        }))
    })
    .await
}

#[tauri::command]
pub async fn chat_v2_automation_set_enabled(
    automation_id: String,
    expected_version: u64,
    enabled: bool,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    let app_handle = app_handle.clone();
    run_automation_command_blocking(move || {
        let (previous, current) =
            set_automation_enabled(&db, &automation_id, expected_version, enabled)
                .map_err(automation_command_error)?;
        emit_automations_changed(&app_handle, "set_enabled", &automation_id);
        Ok(json!({
            "success": true,
            "previous": automation_to_list_item(&previous, Local::now()),
            "current": automation_to_list_item(&current, Local::now()),
        }))
    })
    .await
}

#[tauri::command]
pub async fn chat_v2_automation_update(
    request: AutomationUpdateCommandRequest,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    let app_handle = app_handle.clone();
    run_automation_command_blocking(move || {
        let automation_id = request.automation_id.trim().to_string();
        if automation_id.is_empty() {
            return Err(automation_command_error(AppError::validation(
                "automationId must not be empty".to_string(),
            )));
        }
        let (previous, current) = update_automation_full(
            &db,
            &automation_id,
            request.expected_version,
            AutomationUpdateFields {
                name: request.name,
                schedule: request.schedule.map(Into::into),
                prompt: request.prompt,
                action_type: request.action_type,
                agent_prompt: request.agent_prompt,
                session_mode: request.session_mode,
                model_id: request.model_id,
                catch_up_policy: request.catch_up_policy,
                max_retries: request.max_retries,
                retry_backoff_seconds: request.retry_backoff_seconds,
                timeout_seconds: request.timeout_seconds,
                trusted_profile: request.trusted_profile,
            },
        )
        .map_err(automation_command_error)?;
        emit_automations_changed(&app_handle, "update", &automation_id);
        let mut response = json!({
            "success": true,
            "previous": automation_to_list_item(&previous, Local::now()),
            "current": automation_to_list_item(&current, Local::now()),
            "next_trigger": current.next_run_at,
        });
        // 追加式提示：已完成的 once 任务改配置不会使其复燃（需显式重新
        // 启用或手动运行），前端可据此提示用户，忽略该字段亦不影响行为。
        if once_automation_completed(&current) {
            response["once_completed"] = json!(true);
            response["once_completed_notice"] = json!(
                "该一次性任务的时点已执行完成，本次更新不会使其再次触发；如需再次运行请重新启用或手动运行。"
            );
        }
        Ok(response)
    })
    .await
}

#[tauri::command]
pub async fn chat_v2_automation_runs(
    automation_id: Option<String>,
    limit: Option<usize>,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    run_automation_command_blocking(move || {
        let runs = list_automation_runs(&db, automation_id.as_deref(), limit.unwrap_or(50))
            .map_err(automation_command_error)?;
        let count = runs.len();
        Ok(json!({ "runs": runs, "count": count }))
    })
    .await
}

pub fn retry_automation_run(db: &Database, run_id: &str) -> Result<()> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let now = Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            "UPDATE automation_runs
             SET status = 'retrying', next_attempt_at = ?2, finished_at = NULL,
                 error = NULL, trigger_type = 'retry', retry_requested = 1,
                 lease_expires_at = NULL,
                 delivered_json = CASE WHEN EXISTS (
                     SELECT 1 FROM automation_definitions a
                     WHERE a.id = automation_runs.automation_id
                       AND a.action_type = 'agent_turn'
                 ) THEN '[]' ELSE delivered_json END,
                 max_attempts = MAX(max_attempts, attempt + 1), updated_at = ?2
             WHERE id = ?1 AND status IN ('error', 'timeout', 'spawn_error', 'cancelled')",
            params![run_id, now],
        )
        .map_err(|error| db_error("Failed to retry automation run", error))?;
    if changed != 1 {
        return Err(AppError::validation("Run is not retryable".to_string()));
    }
    Ok(())
}

pub fn cancel_automation_run(db: &Database, run_id: &str) -> Result<()> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let now = Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            "UPDATE automation_runs
             SET status = 'cancelled', finished_at = ?2, next_attempt_at = NULL,
                 lease_expires_at = NULL, retry_requested = 0, updated_at = ?2
             WHERE id = ?1 AND status IN ('queued', 'running', 'retrying')",
            params![run_id, now],
        )
        .map_err(|error| db_error("Failed to cancel automation run", error))?;
    if changed != 1 {
        return Err(AppError::validation("Run is not cancellable".to_string()));
    }
    prune_run_history(&conn, run_id)?;
    let automation_id: Option<String> = conn
        .query_row(
            "SELECT automation_id FROM automation_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| db_error("Failed to resolve cancelled run owner", error))?;
    drop(conn);
    if let Some(token) = ACTIVE_AUTOMATION_RUNS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(run_id)
        .map(|entry| entry.token.clone())
    {
        token.cancel();
    }
    // 取消同样是 run 的终态：once 任务被消耗的时点不会再触发，直接固化收尾
    // （活着的执行器随后只会观察到 superseded，不会重复 finalize）。
    if let Some(automation_id) = automation_id {
        if let Ok(Some(automation)) = get_automation(db, &automation_id) {
            finalize_once_automation(db, None, &automation);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn chat_v2_automation_retry_run(
    run_id: String,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    let app_handle = app_handle.clone();
    run_automation_command_blocking(move || {
        retry_automation_run(&db, &run_id).map_err(automation_command_error)?;
        emit_automations_changed(&app_handle, "retry", "");
        Ok(json!({ "success": true, "runId": run_id }))
    })
    .await
}

#[tauri::command]
pub async fn chat_v2_automation_cancel_run(
    run_id: String,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    let app_handle = app_handle.clone();
    run_automation_command_blocking(move || {
        cancel_automation_run(&db, &run_id).map_err(automation_command_error)?;
        emit_automations_changed(&app_handle, "cancel_run", "");
        Ok(json!({ "success": true, "runId": run_id }))
    })
    .await
}

#[tauri::command]
pub async fn chat_v2_automation_summary(
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    run_automation_command_blocking(move || automation_summary_response(&db)).await
}

fn automation_summary_response(db: &Database) -> std::result::Result<Value, String> {
    automation_summary_response_inner(db).map_err(automation_command_error)
}

fn automation_summary_response_inner(db: &Database) -> Result<Value> {
    let db_err = |error: rusqlite::Error| db_error("Failed to query automation summary", error);
    let (enabled, running, failed, next_run_at, once_completed, last_failed_run_at) = {
        let conn = db
            .get_conn_safe()
            .map_err(|error| db_error("Failed to open automation database", error))?;
        let enabled: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automation_definitions WHERE enabled = 1",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        let running: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automation_runs WHERE status = 'running'",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        let failed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automation_runs
                 WHERE status IN ('error', 'timeout', 'spawn_error')
                   AND finished_at >= ?1",
                params![(Utc::now() - chrono::Duration::hours(24)).to_rfc3339()],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        let next_run_at: Option<String> = conn
            .query_row(
                "SELECT MIN(run_at) FROM (
                     SELECT next_run_at AS run_at
                     FROM automation_definitions
                     WHERE enabled = 1 AND next_run_at IS NOT NULL
                     UNION ALL
                     SELECT r.next_attempt_at AS run_at
                     FROM automation_runs r
                     JOIN automation_definitions a ON a.id = r.automation_id
                     WHERE r.status = 'retrying'
                       AND (a.enabled = 1 OR r.retry_requested = 1)
                       AND r.next_attempt_at IS NOT NULL
                 )",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        // once 完成后固化为 enabled=0 + next_run_at=NULL + last_run_at=消耗时点
        // （finalize_once_automation / claim）。仅靠 enabled=0 会把"用户在触发前
        // 手动停用"的 once 误计为已完成，因此叠加 last_run_at 判据。
        let once_completed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automation_definitions
                 WHERE enabled = 0
                   AND next_run_at IS NULL
                   AND last_run_at IS NOT NULL
                   AND json_extract(schedule_json, '$.kind') = 'once'",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        let last_failed_run_at: Option<String> = conn
            .query_row(
                "SELECT MAX(finished_at) FROM automation_runs
                 WHERE status IN ('error', 'timeout', 'spawn_error')
                   AND finished_at >= ?1",
                params![(Utc::now() - chrono::Duration::hours(24)).to_rfc3339()],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        (
            enabled,
            running,
            failed,
            next_run_at,
            once_completed,
            last_failed_run_at,
        )
    };

    // `automation_background_enabled` acquires the same database mutex. Keep
    // this read outside the summary-query guard to avoid a recursive lock.
    let background_enabled = automation_background_enabled(db);
    Ok(json!({
        "enabledCount": enabled,
        "runningCount": running,
        "failedCount": failed,
        "nextRunAt": next_run_at,
        "backgroundEnabled": background_enabled,
        "onceCompletedCount": once_completed,
        "lastFailedRunAt": last_failed_run_at,
    }))
}

pub fn automation_background_enabled(db: &Database) -> bool {
    db.get_setting(AUTOMATION_BACKGROUND_KEY)
        .ok()
        .flatten()
        .map(|value| value != "false")
        .unwrap_or(true)
}

pub fn should_keep_automation_background(db: &Database) -> bool {
    automation_background_enabled(db)
        && load_automations(db)
            .map(|items| items.into_iter().any(|item| item.enabled))
            .unwrap_or(false)
}

#[tauri::command]
pub async fn chat_v2_automation_set_background_enabled(
    enabled: bool,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    let app_handle = app_handle.clone();
    run_automation_command_blocking(move || {
        db.save_setting(
            AUTOMATION_BACKGROUND_KEY,
            if enabled { "true" } else { "false" },
        )
        .map_err(|error| {
            automation_command_error(db_error("Failed to persist background flag", error))
        })?;
        emit_automations_changed(&app_handle, "background", "");
        Ok(json!({ "success": true, "enabled": enabled }))
    })
    .await
}

#[tauri::command]
pub async fn chat_v2_automation_delete(
    automation_id: String,
    expected_version: u64,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    let app_handle = app_handle.clone();
    run_automation_command_blocking(move || {
        let deleted = delete_automation(&db, &automation_id, expected_version)
            .map_err(automation_command_error)?;
        emit_automations_changed(&app_handle, "delete", &automation_id);
        Ok(json!({
            "success": true,
            "automationId": automation_id,
            "deleted": automation_to_list_item(&deleted, Local::now()),
            "reversible": false,
        }))
    })
    .await
}

pub fn run_automation_now_core(
    automation_id: &str,
    expected_version: u64,
    app_handle: AppHandle,
    db: Arc<Database>,
    agent_facing: bool,
) -> std::result::Result<Value, String> {
    // agent 工具路径（agent_facing=true）保持明文 message；UI 路径统一 {code,message}
    let ui_err = |error: AppError| -> String {
        if agent_facing {
            error.to_string()
        } else {
            automation_command_error(error)
        }
    };

    if !automation_dispatch_allowed() {
        return Err(ui_err(AppError::validation(
            "Automation dispatch is paused (AgentKillSwitch / scheduler pause). Resume agents and automations first."
                .to_string(),
        )));
    }
    crate::chat_v2::kill_switch::admit_or_block_from_app(&app_handle)
        .map_err(|message| ui_err(AppError::validation(message)))?;

    let automation = get_automation(&db, automation_id)
        .map_err(|error| ui_err(error))?
        .ok_or_else(|| {
            ui_err(AppError::new(
                AppErrorType::NotFound,
                format!("Automation '{}' not found", automation_id),
            ))
        })?;
    if automation.version != expected_version {
        return Err(serialize_automation_update_error(
            automation_version_conflict_error(automation_id, expected_version, &automation),
            agent_facing,
        ));
    }

    let result = match automation.action_type {
        AutomationActionType::AgentTurn => {
            let timeout_seconds = automation.timeout_seconds;
            spawn_agent_turn_automation(
                app_handle.clone(),
                db,
                automation_id,
                expected_version,
                agent_facing,
                "manual",
            )?;
            json!({
                "status": "started",
                "automationId": automation_id,
                "timeoutSecs": timeout_seconds,
            })
        }
        AutomationActionType::Notify => {
            let vfs_db = app_handle
                .try_state::<Arc<VfsDatabase>>()
                .map(|state| state.inner().clone());
            // claim（互斥检查 + run 行落库）保持同步，冲突/版本错误立刻返回；
            // 实际投递（OS 通知 + 待办创建）会阻塞，移入后台执行。终态由
            // process_due_automation 内部落库（complete_run / retry_or_finish_run），
            // 不依赖本命令返回；即使后台任务 panic，run 行也会经 lease 过期
            // 由 recover_stale_automation_runs 回收，状态不丢。
            let claimed =
                create_manual_run(&db, automation_id, expected_version).map_err(|error| {
                    if agent_facing {
                        serialize_automation_update_error(error, true)
                    } else {
                        automation_command_error(error)
                    }
                })?;
            let run_id = claimed.run_id.clone();
            let db_task = db.clone();
            let app_handle_task = app_handle.clone();
            crate::background_tasks::spawn(async move {
                let delivery_run_id = claimed.run_id.clone();
                let joined = tokio::task::spawn_blocking(move || {
                    process_due_automation(
                        &db_task,
                        vfs_db.as_ref(),
                        &app_handle_task,
                        claimed,
                        Local::now(),
                    )
                })
                .await;
                match joined {
                    Ok(outcome) => tracing::info!(
                        "[AutomationScheduler] manual notify run '{}' delivered: {:?}",
                        delivery_run_id,
                        outcome
                    ),
                    Err(error) => tracing::warn!(
                        "[AutomationScheduler] manual notify run '{}' delivery task failed (lease recovery will finalize it): {}",
                        delivery_run_id,
                        error
                    ),
                }
            });
            // 与 agent_turn 分支对齐的异步启动响应；最终结果经
            // automations_changed(run_completed) 事件与运行历史获取。
            json!({
                "status": "started",
                "automationId": automation_id,
                "runId": run_id,
            })
        }
    };
    emit_automations_changed(&app_handle, "run_now", automation_id);
    Ok(result)
}

/// 立即运行一条自动化（绕过调度时点）。
///
/// - `agent_turn` 类型：拉起 headless 运行后立即返回（单飞保护）；
/// - `notify` 类型：同步 claim run 后异步投递通知+待办，立即返回
///   `status=started`，终态见运行历史 / `automations_changed` 事件。
#[tauri::command]
pub async fn chat_v2_automation_run_now(
    automation_id: String,
    expected_version: u64,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let db = db.inner().clone();
    let app_handle = app_handle.clone();
    run_automation_command_blocking(move || {
        run_automation_now_core(&automation_id, expected_version, app_handle, db, false)
    })
    .await
}

pub fn update_automation_last_run_at(
    db: &Database,
    automation_id: &str,
    fired_at: &str,
) -> Result<()> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    conn.execute(
        "UPDATE automation_definitions
         SET last_run_at = ?2, updated_at = ?3
         WHERE id = ?1",
        params![automation_id, fired_at, Utc::now().to_rfc3339()],
    )
    .map_err(|error| db_error("Failed to update automation last run", error))?;
    Ok(())
}

/// named 模式：回存实际使用的固定会话 ID（同样走存储互斥锁）
pub fn update_automation_agent_session_id(
    db: &Database,
    automation_id: &str,
    expected_version: u64,
    session_id: &str,
) -> Result<()> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let changed = conn
        .execute(
            "UPDATE automation_definitions
         SET agent_session_id = ?2, updated_at = ?3
         WHERE id = ?1 AND version = ?4
           AND action_type = 'agent_turn' AND session_mode = 'named'",
            params![
                automation_id,
                session_id,
                Utc::now().to_rfc3339(),
                expected_version as i64,
            ],
        )
        .map_err(|error| db_error("Failed to update automation session", error))?;
    if changed == 0 {
        tracing::debug!(
            "[AutomationScheduler] skipped stale named-session write for '{}'",
            automation_id
        );
    }
    Ok(())
}

fn get_automation(db: &Database, automation_id: &str) -> Result<Option<AutomationDefinition>> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    conn.query_row(
        "SELECT * FROM automation_definitions WHERE id = ?1",
        params![automation_id],
        row_to_automation,
    )
    .optional()
    .map_err(|error| db_error("Failed to load automation", error))
}

fn initialize_next_run(db: &Database, automation: &AutomationDefinition) -> Result<()> {
    if !automation.enabled || automation.next_run_at.is_some() {
        return Ok(());
    }
    // once：next_run_at 为 NULL 表示时点已被 claim 消耗（run 进行中或等待 finalize），
    // 重新初始化会把已过时点写回并造成二次触发，这里跳过。
    if automation.schedule.kind == ScheduleKind::Once {
        if let Ok(slot) = compute_next_trigger(&automation.schedule, Local::now()) {
            if slot <= Local::now() {
                return Ok(());
            }
        }
    }
    let next = compute_next_trigger(&automation.schedule, Local::now())?
        .with_timezone(&Utc)
        .to_rfc3339();
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    conn.execute(
        "UPDATE automation_definitions
         SET next_run_at = ?2, updated_at = ?3
         WHERE id = ?1 AND enabled = 1 AND next_run_at IS NULL",
        params![automation.id, next, Utc::now().to_rfc3339()],
    )
    .map_err(|error| db_error("Failed to initialize next automation run", error))?;
    Ok(())
}

fn due_retry_ids(db: &Database, now: DateTime<Utc>) -> Result<Vec<String>> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let mut stmt = conn
        .prepare(
            "SELECT r.id
             FROM automation_runs r
             JOIN automation_definitions a ON a.id = r.automation_id
             WHERE r.status = 'retrying' AND r.next_attempt_at <= ?1
             ORDER BY r.next_attempt_at ASC LIMIT 8",
        )
        .map_err(|error| db_error("Failed to prepare automation retries", error))?;
    let rows = stmt
        .query_map(params![now.to_rfc3339()], |row| row.get(0))
        .map_err(|error| db_error("Failed to query automation retries", error))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| db_error("Failed to decode automation retries", error))
}

fn claim_retry_run(db: &Database, run_id: &str) -> Result<Option<ClaimedAutomationRun>> {
    // A cancelled headless pipeline can need a short grace period to persist
    // partial output. Reusing the same run row before its executor exits would
    // consume a retry attempt on the single-flight guard instead of doing work.
    if automation_run_has_live_executor(run_id) {
        return Ok(None);
    }
    let mut conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("Failed to start retry claim", error))?;
    let run: Option<(String, String, i64, bool)> = tx
        .query_row(
            "SELECT automation_id, scheduled_for, attempt, retry_requested
             FROM automation_runs
             WHERE id = ?1 AND status = 'retrying' AND next_attempt_at <= ?2",
            params![run_id, Utc::now().to_rfc3339()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| db_error("Failed to load retry run", error))?;
    let Some((automation_id, scheduled_for, previous_attempt, retry_requested)) = run else {
        return Ok(None);
    };
    let automation = tx
        .query_row(
            "SELECT * FROM automation_definitions WHERE id = ?1",
            params![automation_id],
            row_to_automation,
        )
        .optional()
        .map_err(|error| db_error("Failed to load retry automation", error))?;
    let Some(automation) = automation else {
        return Ok(None);
    };
    if !automation.enabled && !retry_requested {
        tx.execute(
            "UPDATE automation_runs
             SET status = 'cancelled', finished_at = ?2, lease_expires_at = NULL,
                 updated_at = ?2
             WHERE id = ?1",
            params![run_id, Utc::now().to_rfc3339()],
        )
        .map_err(|error| db_error("Failed to cancel disabled retry", error))?;
        tx.commit()
            .map_err(|error| db_error("Failed to commit retry cancellation", error))?;
        return Ok(None);
    }
    let has_other_running: bool = tx
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM automation_runs
                 WHERE automation_id = ?1 AND id != ?2
                   AND status IN ('queued', 'running')
             )",
            params![automation_id, run_id],
            |row| row.get(0),
        )
        .map_err(|error| db_error("Failed to check concurrent automation runs", error))?;
    if has_other_running {
        return Ok(None);
    }
    let now = Utc::now().to_rfc3339();
    let lease_expires_at =
        lease_expires_at(Utc::now(), effective_lease_timeout_seconds(&automation));
    let changed = tx
        .execute(
            "UPDATE automation_runs
             SET status = 'running', trigger_type = 'retry', attempt = attempt + 1,
                 claimed_by = ?2, claimed_at = ?3, lease_expires_at = ?4,
                 started_at = ?3, finished_at = NULL, next_attempt_at = NULL,
                 updated_at = ?3
             WHERE id = ?1 AND status = 'retrying'",
            params![run_id, scheduler_identity(), now, lease_expires_at],
        )
        .map_err(|error| db_error("Failed to claim retry", error))?;
    if changed != 1 {
        return Ok(None);
    }
    tx.commit()
        .map_err(|error| db_error("Failed to commit retry claim", error))?;
    Ok(Some(ClaimedAutomationRun {
        run_id: run_id.to_string(),
        automation,
        scheduled_for,
        trigger_type: "retry",
        attempt: previous_attempt + 1,
    }))
}

fn recover_stale_automation_runs(db: &Database, app_handle: Option<&AppHandle>) -> Result<usize> {
    let candidates: Vec<(String, String, Option<String>, Option<String>, i64, bool)> = {
        let conn = db
            .get_conn_safe()
            .map_err(|error| db_error("Failed to open automation database", error))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, automation_id, claimed_by, lease_expires_at, attempt,
                        retry_requested
                 FROM automation_runs WHERE status = 'running'",
            )
            .map_err(|error| db_error("Failed to prepare stale runs", error))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .map_err(|error| db_error("Failed to query stale runs", error))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| db_error("Failed to decode stale runs", error))?
    };

    let mut recovered = 0;
    let current_owner = scheduler_identity();
    let now = Utc::now();
    for (run_id, automation_id, claimed_by, lease_expires_at_raw, attempt, retry_requested) in
        candidates
    {
        let Some(automation) = get_automation(db, &automation_id)? else {
            continue;
        };
        let foreign_owner = claimed_by.as_deref() != Some(current_owner.as_str());
        let lease_expired = lease_expires_at_raw
            .as_deref()
            .and_then(|value| parse_utc_datetime(value).ok())
            .is_none_or(|expires_at| expires_at <= now);
        if !foreign_owner && !lease_expired {
            continue;
        }
        // lease 过期但本进程执行器还活着：只是运行超出 lease 预算（例如实际硬超时
        // 大于 lease 计算基准），续租等待其自行落终态，而不是误判失败重试
        // （与 claim_retry_run 的活执行器保护对称）。
        if automation_run_has_live_executor(&run_id) {
            let renewed_lease = lease_expires_at(now, effective_lease_timeout_seconds(&automation));
            let conn = db
                .get_conn_safe()
                .map_err(|error| db_error("Failed to open automation database", error))?;
            if let Err(error) = conn.execute(
                "UPDATE automation_runs
                 SET lease_expires_at = ?2, updated_at = ?3
                 WHERE id = ?1 AND status = 'running'",
                params![run_id, renewed_lease, now.to_rfc3339()],
            ) {
                tracing::warn!(
                    "[AutomationScheduler] failed to renew lease for live run '{}' (automation '{}'): {}",
                    run_id,
                    automation_id,
                    error
                );
            } else {
                tracing::warn!(
                    "[AutomationScheduler] run '{}' (automation '{}') outlived its lease but its executor is alive; lease renewed",
                    run_id,
                    automation_id
                );
            }
            continue;
        }
        if !automation.enabled && !retry_requested {
            cancel_automation_run(db, &run_id)?;
            recovered += 1;
            continue;
        }
        if automation.action_type == AutomationActionType::Notify {
            let delivered = load_run_deliveries(db, &run_id).unwrap_or_default();
            let notification_done = delivered.iter().any(|entry| entry == "notification");
            let todo_done = delivered.iter().any(|entry| entry == "todo");
            if notification_done && todo_done {
                complete_run(
                    db,
                    &run_id,
                    attempt,
                    "success",
                    &delivered,
                    None,
                    Some(&automation.prompt),
                    None,
                )?;
                finalize_once_automation(db, app_handle, &automation);
                recovered += 1;
                continue;
            }
        }
        let outcome = retry_or_finish_run(
            db,
            &run_id,
            attempt,
            &automation,
            "error",
            None,
            "Application stopped before the automation run completed",
            automation.action_type == AutomationActionType::AgentTurn && !automation.heartbeat,
        )?;
        if outcome == RunFinalizeOutcome::Finished {
            finalize_once_automation(db, app_handle, &automation);
        }
        recovered += 1;
    }
    Ok(recovered)
}

fn deliver_pending_agent_notifications(db: &Database, app_handle: &AppHandle) -> Result<usize> {
    let candidates: Vec<(
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = {
        let conn = db
            .get_conn_safe()
            .map_err(|error| db_error("Failed to open automation database", error))?;
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.attempt, r.status, r.session_id, r.summary, r.error,
                        r.delivered_json, a.name
                 FROM automation_runs r
                 JOIN automation_definitions a ON a.id = r.automation_id
                 WHERE r.status IN ('success', 'error', 'timeout', 'spawn_error')
                   AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?1)
                   AND EXISTS (
                       SELECT 1 FROM json_each(r.delivered_json)
                       WHERE json_each.value = 'notification_pending'
                   )
                 ORDER BY r.updated_at ASC
                 LIMIT 8",
            )
            .map_err(|error| db_error("Failed to prepare pending notifications", error))?;
        let rows = stmt
            .query_map(params![Utc::now().to_rfc3339()], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })
            .map_err(|error| db_error("Failed to query pending notifications", error))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| db_error("Failed to decode pending notifications", error))?
    };

    let lang = notification_language(db);
    let mut delivered_count = 0;
    for (run_id, attempt, status, session_id, summary, error, delivered_json, name) in candidates {
        let delivered: Vec<String> = serde_json::from_str(&delivered_json).unwrap_or_default();
        if !delivered
            .iter()
            .any(|entry| entry == "notification_pending")
        {
            continue;
        }
        let successful = status == "success";
        let body = if successful {
            notification_success_body(lang, &summary.unwrap_or_default(), session_id.as_deref())
        } else {
            error
                .or(summary)
                .unwrap_or_else(|| notification_failed_fallback_body(lang))
        };
        let title = if successful {
            notification_title_success(lang, &name)
        } else {
            notification_title_failed(lang, &name)
        };
        // 补投的同样是完成通知：用户此刻正盯着主窗口时（可从运行历史看到
        // 结果）不再用迟到的 OS 通知打扰
        if deliver_run_notification(
            db, app_handle, &run_id, attempt, &status, &title, &body, true,
        )
        .handled()
        {
            delivered_count += 1;
        }
    }
    Ok(delivered_count)
}

/// 该 schedule 两次触发的理论最大间隔的 2 倍；超过即视为时钟异常/脏数据。
/// once/monthly 返回 None（放行，不做防护）。
fn schedule_skew_threshold(schedule: &AutomationSchedule) -> Option<chrono::Duration> {
    match schedule.kind {
        ScheduleKind::Daily => Some(chrono::Duration::hours(48)),
        // weekly 周期 7 天
        ScheduleKind::Weekly => Some(chrono::Duration::days(14)),
        // weekdays 最大间隔为周五->周一 3 天
        ScheduleKind::Weekdays => Some(chrono::Duration::days(6)),
        ScheduleKind::Interval => schedule
            .interval_minutes
            .map(|minutes| chrono::Duration::minutes(minutes as i64 * 2)),
        ScheduleKind::Monthly | ScheduleKind::Once => None,
    }
}

/// next_run_at 比 now 晚超过阈值时按当前时间重算并回写（CAS 防并发覆盖）。
/// 返回 Some(new_next_run_at) 表示已修复。
fn repair_skewed_next_run(
    db: &Database,
    automation: &AutomationDefinition,
    expected_next_run_at: &str,
    now: DateTime<Local>,
    now_utc: DateTime<Utc>,
) -> Result<Option<String>> {
    let Some(threshold) = schedule_skew_threshold(&automation.schedule) else {
        return Ok(None);
    };
    let scheduled_for = parse_utc_datetime(expected_next_run_at)?;
    if scheduled_for.signed_duration_since(now_utc) <= threshold {
        return Ok(None);
    }
    let fresh = compute_next_trigger(&automation.schedule, now)?
        .with_timezone(&Utc)
        .to_rfc3339();
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    let changed = conn
        .execute(
            "UPDATE automation_definitions
             SET next_run_at = ?3, updated_at = ?4
             WHERE id = ?1 AND enabled = 1 AND next_run_at = ?2",
            params![
                automation.id,
                expected_next_run_at,
                fresh,
                now_utc.to_rfc3339(),
            ],
        )
        .map_err(|error| db_error("Failed to repair skewed next_run_at", error))?;
    if changed != 1 {
        return Ok(None);
    }
    tracing::warn!(
        "[AutomationScheduler] next_run_at of '{}' ({}) exceeds the schedule's max gap; clock skew or stale data suspected, recomputed to {}",
        automation.id,
        expected_next_run_at,
        fresh
    );
    Ok(Some(fresh))
}

pub fn tick_automations(
    db: &Arc<Database>,
    vfs_db: Option<&Arc<VfsDatabase>>,
    app_handle: &AppHandle,
) -> Result<()> {
    if !automation_dispatch_allowed() {
        tracing::debug!(
            "[AutomationScheduler] tick skipped: paused={}, exiting={}",
            is_automation_scheduler_paused(),
            automation_app_is_exiting()
        );
        return Ok(());
    }
    // 错误隔离：孤儿恢复 / 补投通知任一失败（如数据库瞬时繁忙）不阻断本轮
    // 到期调度，下一 tick 会自然重试这两步。
    if let Err(error) = recover_stale_automation_runs(db, Some(app_handle)) {
        tracing::warn!(
            "[AutomationScheduler] stale run recovery failed this tick: {}",
            error
        );
    }
    if let Err(error) = deliver_pending_agent_notifications(db, app_handle) {
        tracing::warn!(
            "[AutomationScheduler] pending notification delivery failed this tick: {}",
            error
        );
    }
    let automations = load_automations(db)?;
    let now = Local::now();

    for run_id in due_retry_ids(db, now.with_timezone(&Utc))? {
        match claim_retry_run(db, &run_id) {
            Ok(Some(claimed)) => {
                process_due_automation(db, vfs_db, app_handle, claimed, now);
            }
            Ok(None) => {}
            // 单个 run 的 claim 失败不中断本轮其余重试，且日志带上 run id
            Err(error) => tracing::warn!(
                "[AutomationScheduler] failed to claim retry run '{}': {}",
                run_id,
                error
            ),
        }
    }

    for automation in automations {
        if !automation.enabled {
            continue;
        }
        // 单个自动化的调度错误（脏 next_run_at、claim 失败等）只记录并跳过；
        // 不能让一个坏定义把整个 tick 打断，否则其后迭代到的自动化永远不会
        // 被调度，且旧日志里没有 automation id 无从排查。
        let automation_id = automation.id.clone();
        let tick_result: Result<()> = (|| {
            let Some(next_run_at) = automation.next_run_at.as_deref() else {
                initialize_next_run(db, &automation)?;
                return Ok(());
            };
            let now_utc = now.with_timezone(&Utc);
            let mut expected_next_run_at = next_run_at.to_string();
            // 时钟回拨/脏数据防护：next_run_at 远超该 schedule 理论最大间隔的 2 倍
            // 视为异常，按当前时间重算（once/monthly 放行）。
            if let Some(repaired) =
                repair_skewed_next_run(db, &automation, &expected_next_run_at, now, now_utc)?
            {
                expected_next_run_at = repaired;
            }
            // catch_up_all 允许单 tick 补多个错过的槽位，防长离线补齐过慢；
            // 其余策略保持每 tick 单槽。agent_turn 的活跃 run 互斥会让第二次
            // claim 自然落空（本轮只补得动同步完成的 notify 类）。
            let max_slots = if automation.catch_up_policy == CatchUpPolicy::CatchUpAll {
                CATCH_UP_BATCH
            } else {
                1
            };
            for _ in 0..max_slots {
                let scheduled_for = parse_utc_datetime(&expected_next_run_at)?;
                if scheduled_for > now_utc {
                    break;
                }
                let Some(claimed) =
                    claim_scheduled_run(db, &automation.id, &expected_next_run_at, now_utc)?
                else {
                    break;
                };
                let advanced_next = claimed.automation.next_run_at.clone();
                let lateness = now_utc.signed_duration_since(scheduled_for);
                if automation.catch_up_policy == CatchUpPolicy::Skip
                    && lateness > chrono::Duration::seconds(SCHEDULER_POLL_SECS as i64 * 2)
                {
                    complete_run(
                        db,
                        &claimed.run_id,
                        claimed.attempt,
                        "skipped",
                        &[],
                        None,
                        Some("Skipped by catch-up policy after the app was unavailable"),
                        None,
                    )?;
                    // once 的时点被 skip 消耗后同样进入“已完成”暂停态
                    finalize_once_automation(db, Some(app_handle), &claimed.automation);
                } else {
                    process_due_automation(db, vfs_db, app_handle, claimed, now);
                }
                match advanced_next {
                    Some(next) => expected_next_run_at = next,
                    None => break,
                }
            }
            Ok(())
        })();
        if let Err(error) = tick_result {
            tracing::warn!(
                "[AutomationScheduler] scheduling tick failed for automation '{}': {}",
                automation_id,
                error
            );
        }
    }

    Ok(())
}

/// 后台调度器：15 秒轮询，定义和 run claim 均持久化。
pub async fn start_automation_scheduler(
    database: Arc<Database>,
    vfs_db: Option<Arc<VfsDatabase>>,
    app_handle: AppHandle,
) {
    tracing::info!("[AutomationScheduler] 自动化调度器已启动");

    let initialization_database = database.clone();
    let initialization_app_handle = app_handle.clone();
    if let Err(error) = tokio::task::spawn_blocking(move || {
        if let Err(error) = migrate_legacy_automations(&initialization_database) {
            tracing::warn!("[AutomationScheduler] legacy migration failed: {}", error);
        }
        match recover_stale_automation_runs(
            &initialization_database,
            Some(&initialization_app_handle),
        ) {
            Ok(count) if count > 0 => tracing::info!(
                "[AutomationScheduler] recovered {} stale automation runs",
                count
            ),
            Ok(_) => {}
            Err(error) => {
                tracing::warn!("[AutomationScheduler] stale run recovery failed: {}", error)
            }
        }

        // 幂等预置心跳自动化（默认 disabled，用户显式开启后按 interval 触发）
        if let Err(e) = ensure_heartbeat_automation(&initialization_database) {
            tracing::warn!(
                "[AutomationScheduler] ensure_heartbeat_automation failed: {}",
                e
            );
        }
    })
    .await
    {
        tracing::warn!(
            "[AutomationScheduler] initialization task failed: {}",
            error
        );
    }

    loop {
        if AUTOMATION_SHUTDOWN_TOKEN.is_cancelled() {
            break;
        }
        // Pause keeps the loop alive but tick_automations no-ops until resume.
        let tick_database = database.clone();
        let tick_vfs_db = vfs_db.clone();
        let tick_app_handle = app_handle.clone();
        match tokio::task::spawn_blocking(move || {
            tick_automations(&tick_database, tick_vfs_db.as_ref(), &tick_app_handle)
        })
        .await
        {
            Ok(Err(error)) => tracing::warn!("[AutomationScheduler] tick failed: {}", error),
            Err(error) => tracing::warn!("[AutomationScheduler] tick task failed: {}", error),
            Ok(Ok(())) => {}
        }
        tokio::select! {
            _ = AUTOMATION_SHUTDOWN_TOKEN.cancelled() => break,
            _ = sleep(Duration::from_secs(SCHEDULER_POLL_SECS)) => {}
        }
    }
    tracing::info!("[AutomationScheduler] 自动化调度器已停止");
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::TempDir;

    fn setup_automation_db() -> (TempDir, Database) {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let db = Database::new(&temp_dir.path().join("automations.db")).expect("database");
        let conn = db.get_conn_safe().expect("connection");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
            [],
        )
        .expect("create settings table");
        conn.execute_batch(include_str!(
            "../../migrations/mistakes/V20260714__automation_scheduler.sql"
        ))
        .expect("create automation tables");
        conn.execute_batch(include_str!(
            "../../migrations/mistakes/V20260715__harden_automation_runtime.sql"
        ))
        .expect("harden automation runtime");
        conn.execute_batch(include_str!(
            "../../migrations/mistakes/V20260721__trusted_automation_profile.sql"
        ))
        .expect("add trusted automation profile");
        drop(conn);
        (temp_dir, db)
    }

    #[test]
    fn automation_summary_releases_database_guard_before_reading_settings() {
        let (_temp_dir, db) = setup_automation_db();
        db.save_setting(AUTOMATION_BACKGROUND_KEY, "false")
            .expect("disable background automation");
        let db = Arc::new(db);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker_db = db.clone();
        let worker = std::thread::spawn(move || {
            let _ = sender.send(automation_summary_response(&worker_db));
        });

        let summary = receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("automation summary must not deadlock on the database mutex")
            .expect("automation summary response");
        worker.join().expect("summary worker");

        assert_eq!(summary["enabledCount"], 0);
        assert_eq!(summary["runningCount"], 0);
        assert_eq!(summary["failedCount"], 0);
        assert_eq!(summary["nextRunAt"], Value::Null);
        assert_eq!(summary["backgroundEnabled"], false);
    }

    fn local_at(y: i32, m: u32, d: u32, hh: u32, mm: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, m, d, hh, mm, 0)
            .single()
            .expect("valid local datetime")
    }

    fn sample_daily(time: &str) -> AutomationDefinition {
        AutomationDefinition {
            id: "auto_test".to_string(),
            name: "Daily review".to_string(),
            schedule: AutomationSchedule {
                kind: ScheduleKind::Daily,
                time: time.to_string(),
                weekday: None,
                weekdays: None,
                day_of_month: None,
                interval_minutes: None,
                date: None,
                timezone: None,
            },
            prompt: "Summarize mistakes".to_string(),
            enabled: true,
            created_at: Utc::now().to_rfc3339(),
            session_id: "sess_test".to_string(),
            last_run_at: None,
            next_run_at: None,
            action_type: AutomationActionType::Notify,
            heartbeat: false,
            agent_prompt: None,
            session_mode: None,
            model_id: None,
            agent_session_id: None,
            catch_up_policy: CatchUpPolicy::RunOnce,
            max_retries: DEFAULT_MAX_RETRIES,
            retry_backoff_seconds: DEFAULT_RETRY_BACKOFF_SECS,
            timeout_seconds: DEFAULT_TIMEOUT_SECS,
            trusted_profile: None,
            version: 1,
        }
    }

    fn sample_interval(minutes: u32) -> AutomationDefinition {
        AutomationDefinition {
            id: "auto_interval".to_string(),
            name: "Heartbeat".to_string(),
            schedule: AutomationSchedule {
                kind: ScheduleKind::Interval,
                time: String::new(),
                weekday: None,
                weekdays: None,
                day_of_month: None,
                interval_minutes: Some(minutes),
                date: None,
                timezone: None,
            },
            prompt: DEFAULT_HEARTBEAT_PROMPT.to_string(),
            enabled: true,
            created_at: Utc::now().to_rfc3339(),
            session_id: String::new(),
            last_run_at: None,
            next_run_at: None,
            action_type: AutomationActionType::AgentTurn,
            heartbeat: true,
            agent_prompt: None,
            session_mode: None,
            model_id: None,
            agent_session_id: None,
            catch_up_policy: CatchUpPolicy::RunOnce,
            max_retries: DEFAULT_MAX_RETRIES,
            retry_backoff_seconds: DEFAULT_RETRY_BACKOFF_SECS,
            timeout_seconds: DEFAULT_TIMEOUT_SECS,
            trusted_profile: None,
            version: 1,
        }
    }

    #[test]
    fn parse_time_accepts_hhmm() {
        assert_eq!(
            parse_time_hhmm("09:30").unwrap(),
            NaiveTime::from_hms_opt(9, 30, 0).unwrap()
        );
        assert_eq!(
            parse_time_hhmm(" 23:59\n").unwrap(),
            NaiveTime::from_hms_opt(23, 59, 0).unwrap()
        );
    }

    #[test]
    fn parse_time_accepts_24_hour_boundaries() {
        assert_eq!(
            parse_time_hhmm("00:00").unwrap(),
            NaiveTime::from_hms_opt(0, 0, 0).unwrap()
        );
        assert_eq!(
            parse_time_hhmm("23:59").unwrap(),
            NaiveTime::from_hms_opt(23, 59, 0).unwrap()
        );
        assert!(parse_time_hhmm("24:00").is_err());
        assert!(parse_time_hhmm("23:60").is_err());
    }

    #[test]
    fn parse_time_rejects_non_hhmm_shapes() {
        for invalid in [
            "",
            "9:30",
            "09:3",
            "009:30",
            "09:030",
            "09-30",
            "09:30:00",
            "09 :30",
            "０９:３０",
        ] {
            assert!(
                parse_time_hhmm(invalid).is_err(),
                "unexpectedly accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn parse_last_run_at_preserves_rfc3339_timezone_instant() {
        let parsed = parse_last_run_at(Some("2026-07-08T09:30:00+08:00"))
            .unwrap()
            .unwrap();
        let expected = Utc.with_ymd_and_hms(2026, 7, 8, 1, 30, 0).single().unwrap();

        assert_eq!(parsed.with_timezone(&Utc), expected);
    }

    #[test]
    fn validate_schedule_daily_rejects_weekday() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Daily,
            time: "08:00".to_string(),
            weekday: Some(1),
            weekdays: None,
            day_of_month: None,
            interval_minutes: None,
            date: None,
            timezone: None,
        };
        assert!(validate_schedule(&schedule).is_err());
    }

    #[test]
    fn validate_schedule_weekly_requires_weekday() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Weekly,
            time: "08:00".to_string(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: None,
            date: None,
            timezone: None,
        };
        assert!(validate_schedule(&schedule).is_err());
    }

    #[test]
    fn normalize_schedule_shape_weekly_canonicalizes() {
        let base = AutomationSchedule {
            kind: ScheduleKind::Weekly,
            time: "08:00".to_string(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: None,
            date: None,
            timezone: None,
        };

        // 多天：weekday 回填为最小值，集合去重升序
        let mut multi = base.clone();
        multi.weekdays = Some(vec![5, 3, 1, 3]);
        normalize_schedule_shape(&mut multi);
        assert_eq!(multi.weekday, Some(1));
        assert_eq!(multi.weekdays, Some(vec![1, 3, 5]));

        // 单元素集合收敛为纯 weekday 形态（与存量单日数据一致）
        let mut single = base.clone();
        single.weekdays = Some(vec![4]);
        normalize_schedule_shape(&mut single);
        assert_eq!(single.weekday, Some(4));
        assert_eq!(single.weekdays, None);

        // 无 weekdays / 非 weekly 均不改动
        let mut plain = base.clone();
        plain.weekday = Some(2);
        normalize_schedule_shape(&mut plain);
        assert_eq!(plain.weekday, Some(2));
        assert_eq!(plain.weekdays, None);
        let mut daily = base;
        daily.kind = ScheduleKind::Daily;
        normalize_schedule_shape(&mut daily);
        assert_eq!(daily.weekday, None);
        assert_eq!(daily.weekdays, None);
    }

    #[test]
    fn validate_name_and_prompt_limits() {
        assert!(validate_automation_fields("", "ok").is_err());
        assert!(validate_automation_fields("x", &"a".repeat(MAX_PROMPT_LEN + 1)).is_err());
        assert!(validate_automation_fields(&"n".repeat(MAX_NAME_LEN + 1), "ok").is_err());
        assert!(validate_automation_fields("ok", "prompt").is_ok());
    }

    #[test]
    fn is_due_daily_before_time() {
        let auto = sample_daily("09:00");
        let now = local_at(2026, 7, 8, 8, 30);
        assert!(!is_due(&auto, now, None).unwrap());
    }

    #[test]
    fn is_due_daily_after_time_never_run() {
        let auto = sample_daily("09:00");
        let now = local_at(2026, 7, 8, 10, 0);
        assert!(is_due(&auto, now, None).unwrap());
    }

    #[test]
    fn is_due_daily_already_ran_today() {
        let auto = sample_daily("09:00");
        let now = local_at(2026, 7, 8, 10, 0);
        let last = local_at(2026, 7, 8, 9, 5);
        assert!(!is_due(&auto, now, Some(last)).unwrap());
    }

    #[test]
    fn is_due_daily_catch_up_after_offline_same_day() {
        let auto = sample_daily("09:00");
        let now = local_at(2026, 7, 8, 11, 0);
        let last = local_at(2026, 7, 7, 9, 5);
        assert!(is_due(&auto, now, Some(last)).unwrap());
    }

    #[test]
    fn is_due_weekly_wrong_weekday() {
        let auto = AutomationDefinition {
            schedule: AutomationSchedule {
                kind: ScheduleKind::Weekly,
                time: "09:00".to_string(),
                weekday: Some(1), // Monday
                weekdays: None,
                day_of_month: None,
                interval_minutes: None,
                date: None,
                timezone: None,
            },
            ..sample_daily("09:00")
        };
        // 2026-07-08 is Wednesday
        let now = local_at(2026, 7, 8, 10, 0);
        assert!(!is_due(&auto, now, None).unwrap());
    }

    #[test]
    fn is_due_weekly_on_scheduled_day() {
        let auto = AutomationDefinition {
            schedule: AutomationSchedule {
                kind: ScheduleKind::Weekly,
                time: "09:00".to_string(),
                weekday: Some(3), // Wednesday
                weekdays: None,
                day_of_month: None,
                interval_minutes: None,
                date: None,
                timezone: None,
            },
            ..sample_daily("09:00")
        };
        let now = local_at(2026, 7, 8, 10, 0);
        assert!(is_due(&auto, now, None).unwrap());
    }

    #[test]
    fn compute_next_trigger_daily_later_today() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Daily,
            time: "18:00".to_string(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: None,
            date: None,
            timezone: None,
        };
        let now = local_at(2026, 7, 8, 10, 0);
        let next = compute_next_trigger(&schedule, now).unwrap();
        assert_eq!(next, local_at(2026, 7, 8, 18, 0));
    }

    #[test]
    fn compute_next_trigger_daily_tomorrow() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Daily,
            time: "08:00".to_string(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: None,
            date: None,
            timezone: None,
        };
        let now = local_at(2026, 7, 8, 10, 0);
        let next = compute_next_trigger(&schedule, now).unwrap();
        assert_eq!(next, local_at(2026, 7, 9, 8, 0));
    }

    #[test]
    fn generate_automation_id_format() {
        let id = generate_automation_id(Utc.with_ymd_and_hms(2026, 7, 8, 12, 0, 0).unwrap());
        assert!(id.starts_with("auto_"));
        let parts: Vec<_> = id.split('_').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[2].len(), 4);
    }

    // ========================================================================
    // v2：action_type / interval / heartbeat / 单飞
    // ========================================================================

    /// 存量 JSON（无 action_type/heartbeat/interval_minutes）必须能反序列化并落到默认值
    #[test]
    fn legacy_definition_deserializes_with_defaults() {
        let legacy = r#"{
            "id": "auto_1",
            "name": "old",
            "schedule": { "kind": "daily", "time": "09:00" },
            "prompt": "p",
            "enabled": true,
            "created_at": "2026-01-01T00:00:00Z",
            "session_id": "sess_x"
        }"#;
        let def: AutomationDefinition = serde_json::from_str(legacy).expect("legacy parses");
        assert_eq!(def.action_type, AutomationActionType::Notify);
        assert!(!def.heartbeat);
        assert!(def.schedule.interval_minutes.is_none());
        // headless 相关新增字段全部落到默认值
        assert!(def.agent_prompt.is_none());
        assert!(def.session_mode.is_none());
        assert!(def.model_id.is_none());
        assert!(def.agent_session_id.is_none());
    }

    /// agent_prompt 非空优先；为空/纯空白回退 prompt
    #[test]
    fn effective_agent_prompt_falls_back_to_prompt() {
        let mut auto = sample_daily("09:00");
        assert_eq!(effective_agent_prompt(&auto), "Summarize mistakes");

        auto.agent_prompt = Some("   ".to_string());
        assert_eq!(effective_agent_prompt(&auto), "Summarize mistakes");

        auto.agent_prompt = Some("检查到期复习卡并生成今日复习简报".to_string());
        assert_eq!(
            effective_agent_prompt(&auto),
            "检查到期复习卡并生成今日复习简报"
        );
    }

    #[test]
    fn shared_crud_services_preserve_updates_and_return_previous_values() {
        let (_temp_dir, db) = setup_automation_db();
        let definition = sample_daily("09:00");
        save_automations(&db, std::slice::from_ref(&definition)).expect("seed automation");

        let (previous_enabled, disabled) =
            set_automation_enabled(&db, &definition.id, definition.version, false)
                .expect("disable");
        assert!(previous_enabled.enabled);
        assert!(!disabled.enabled);

        let new_schedule = AutomationSchedule {
            kind: ScheduleKind::Weekly,
            time: "08:30".to_string(),
            weekday: Some(1),
            weekdays: None,
            day_of_month: None,
            interval_minutes: None,
            date: None,
            timezone: None,
        };
        let (previous_update, updated) = update_automation(
            &db,
            &definition.id,
            disabled.version,
            Some(new_schedule.clone()),
            Some("new prompt".to_string()),
        )
        .expect("update");
        assert!(
            !previous_update.enabled,
            "set_enabled update must be preserved"
        );
        assert_eq!(updated.schedule, new_schedule);
        assert_eq!(updated.prompt, "new prompt");

        let deleted = delete_automation(&db, &definition.id, updated.version).expect("delete");
        assert_eq!(deleted.id, definition.id);
        assert!(load_automations(&db).expect("load").is_empty());
    }

    #[test]
    fn enabling_an_already_enabled_automation_is_idempotent() {
        let (_temp_dir, db) = setup_automation_db();
        let mut automation = sample_daily("09:00");
        automation.next_run_at = Some(
            Utc.with_ymd_and_hms(2026, 7, 15, 1, 0, 0)
                .unwrap()
                .to_rfc3339(),
        );
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();

        let (previous, current) =
            set_automation_enabled(&db, &automation.id, automation.version, true)
                .expect("idempotent enable");

        assert_eq!(previous, current);
        assert_eq!(current.version, automation.version);
        assert_eq!(current.next_run_at, automation.next_run_at);
    }

    #[test]
    fn runtime_bookkeeping_does_not_bump_configuration_version() {
        let (_temp_dir, db) = setup_automation_db();
        let mut automation = sample_daily("09:00");
        automation.action_type = AutomationActionType::AgentTurn;
        automation.session_mode = Some(HeadlessSessionMode::Named);
        automation.next_run_at = None;
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();

        initialize_next_run(&db, &automation).unwrap();
        update_automation_last_run_at(&db, &automation.id, &Utc::now().to_rfc3339()).unwrap();
        update_automation_agent_session_id(&db, &automation.id, automation.version, "sess_runtime")
            .unwrap();

        let current = load_automations(&db).unwrap().remove(0);
        assert_eq!(current.version, automation.version);
        assert!(current.next_run_at.is_some());
        assert!(current.last_run_at.is_some());
        assert_eq!(current.agent_session_id.as_deref(), Some("sess_runtime"));
    }

    #[test]
    fn update_prompt_preserves_independent_agent_prompt() {
        let (_temp_dir, db) = setup_automation_db();
        let mut definition = sample_daily("09:00");
        definition.action_type = AutomationActionType::AgentTurn;
        definition.agent_prompt = Some("old effective prompt".to_string());
        save_automations(&db, std::slice::from_ref(&definition)).expect("seed automation");

        let (_, updated) = update_automation(
            &db,
            &definition.id,
            definition.version,
            None,
            Some("new effective prompt".to_string()),
        )
        .expect("update prompt");
        assert_eq!(effective_agent_prompt(&updated), "old effective prompt");
        assert_eq!(
            updated.agent_prompt.as_deref(),
            Some("old effective prompt")
        );
    }

    #[test]
    fn ui_update_dto_accepts_camel_case_interval_minutes() {
        let request: AutomationUpdateCommandRequest = serde_json::from_value(json!({
            "automationId": "auto_test",
            "expectedVersion": 1,
            "schedule": { "kind": "interval", "intervalMinutes": 30 }
        }))
        .expect("camelCase DTO");
        assert_eq!(request.expected_version, 1);
        assert_eq!(
            request.schedule.expect("schedule").interval_minutes,
            Some(30)
        );
    }

    #[test]
    fn ui_update_dto_requires_camel_case_expected_version() {
        let missing = serde_json::from_value::<AutomationUpdateCommandRequest>(json!({
            "automationId": "auto_test",
            "name": "Renamed"
        }))
        .unwrap_err();
        assert!(missing.to_string().contains("expectedVersion"));

        let snake_case = serde_json::from_value::<AutomationUpdateCommandRequest>(json!({
            "automationId": "auto_test",
            "expected_version": 1,
            "name": "Renamed"
        }))
        .unwrap_err();
        assert!(snake_case.to_string().contains("expectedVersion"));
    }

    #[test]
    fn agent_mapping_is_bounded_while_ui_mapping_remains_full() {
        let mut definition = sample_daily("09:00");
        definition.prompt = "界".repeat(2_100);
        definition.agent_prompt = Some("代".repeat(2_200));
        let ui = automation_to_list_item(&definition, Local::now());
        let agent = automation_to_agent_list_item(&definition, Local::now());
        assert_eq!(ui["version"], 1);
        assert_eq!(agent["version"], 1);
        assert_eq!(ui["prompt"].as_str().unwrap().chars().count(), 2_100);
        assert_eq!(ui["agent_prompt"].as_str().unwrap().chars().count(), 2_200);
        assert_eq!(agent["prompt"].as_str().unwrap().chars().count(), 2_000);
        assert_eq!(
            agent["agent_prompt"].as_str().unwrap().chars().count(),
            2_000
        );
        assert_eq!(agent["promptTruncated"], true);
        assert_eq!(agent["fieldsTruncated"], json!(["prompt", "agent_prompt"]));
    }

    /// session_mode 字段的 serde 兼容（isolated/named 小写）
    #[test]
    fn definition_session_mode_roundtrip() {
        let mut auto = sample_daily("09:00");
        auto.action_type = AutomationActionType::AgentTurn;
        auto.session_mode = Some(HeadlessSessionMode::Named);
        auto.agent_session_id = Some("sess_fixed".to_string());

        let raw = serde_json::to_string(&auto).unwrap();
        assert!(raw.contains("\"session_mode\":\"named\""));

        let parsed: AutomationDefinition = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.session_mode, Some(HeadlessSessionMode::Named));
        assert_eq!(parsed.agent_session_id.as_deref(), Some("sess_fixed"));
    }

    /// 存量 run 记录（无 session_id/status）也必须兼容
    #[test]
    fn legacy_run_record_deserializes_with_defaults() {
        let legacy = r#"{
            "automation_id": "auto_1",
            "fired_at": "2026-01-01T00:00:00Z",
            "delivered": ["notification"]
        }"#;
        let record: AutomationRunRecord = serde_json::from_str(legacy).expect("legacy parses");
        assert!(record.session_id.is_none());
        assert!(record.status.is_none());
    }

    #[test]
    fn action_type_serde_uses_snake_case() {
        assert_eq!(
            serde_json::to_value(AutomationActionType::Notify).unwrap(),
            json!("notify")
        );
        assert_eq!(
            serde_json::to_value(AutomationActionType::AgentTurn).unwrap(),
            json!("agent_turn")
        );
        assert_eq!(
            AutomationActionType::parse("agent_turn").unwrap(),
            AutomationActionType::AgentTurn
        );
        assert_eq!(
            AutomationActionType::parse("NOTIFY").unwrap(),
            AutomationActionType::Notify
        );
        assert!(AutomationActionType::parse("bogus").is_err());
    }

    #[test]
    fn validate_schedule_interval_bounds() {
        let mut schedule = AutomationSchedule {
            kind: ScheduleKind::Interval,
            time: String::new(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: Some(30),
            date: None,
            timezone: None,
        };
        assert!(validate_schedule(&schedule).is_ok());

        schedule.interval_minutes = Some(MIN_INTERVAL_MINUTES - 1);
        assert!(validate_schedule(&schedule).is_err());

        schedule.interval_minutes = Some(MAX_INTERVAL_MINUTES + 1);
        assert!(validate_schedule(&schedule).is_err());

        schedule.interval_minutes = None;
        assert!(validate_schedule(&schedule).is_err());

        schedule.interval_minutes = Some(30);
        schedule.weekday = Some(1);
        assert!(validate_schedule(&schedule).is_err());
    }

    #[test]
    fn validate_schedule_daily_rejects_interval_minutes() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Daily,
            time: "08:00".to_string(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: Some(30),
            date: None,
            timezone: None,
        };
        assert!(validate_schedule(&schedule).is_err());
    }

    #[test]
    fn is_due_interval_never_run_waits_until_next_run() {
        let mut auto = sample_interval(30);
        let now = local_at(2026, 7, 8, 10, 0);
        auto.next_run_at = Some(
            local_at(2026, 7, 8, 10, 30)
                .with_timezone(&Utc)
                .to_rfc3339(),
        );
        assert!(!is_due(&auto, now, None).unwrap());
        let after = local_at(2026, 7, 8, 10, 31);
        assert!(is_due(&auto, after, None).unwrap());
    }

    #[test]
    fn is_due_interval_within_interval_not_due() {
        let auto = sample_interval(30);
        let now = local_at(2026, 7, 8, 10, 0);
        let last = local_at(2026, 7, 8, 9, 45);
        assert!(!is_due(&auto, now, Some(last)).unwrap());
    }

    #[test]
    fn is_due_interval_after_interval_is_due() {
        let auto = sample_interval(30);
        let now = local_at(2026, 7, 8, 10, 0);
        let last = local_at(2026, 7, 8, 9, 30);
        assert!(is_due(&auto, now, Some(last)).unwrap());
        let earlier = local_at(2026, 7, 8, 9, 0);
        assert!(is_due(&auto, now, Some(earlier)).unwrap());
    }

    #[test]
    fn is_due_interval_disabled_never_due() {
        let auto = AutomationDefinition {
            enabled: false,
            ..sample_interval(30)
        };
        let now = local_at(2026, 7, 8, 10, 0);
        assert!(!is_due(&auto, now, None).unwrap());
    }

    #[test]
    fn compute_next_trigger_interval_adds_minutes() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Interval,
            time: String::new(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: Some(45),
            date: None,
            timezone: None,
        };
        let now = local_at(2026, 7, 8, 10, 0);
        let next = compute_next_trigger(&schedule, now).unwrap();
        assert_eq!(next, local_at(2026, 7, 8, 10, 45));
    }

    // ========================================================================
    // once：一次性任务
    // ========================================================================

    fn once_schedule(date: &str, time: &str) -> AutomationSchedule {
        AutomationSchedule {
            kind: ScheduleKind::Once,
            time: time.to_string(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: None,
            date: Some(date.to_string()),
            timezone: None,
        }
    }

    #[test]
    fn validate_schedule_once_requires_valid_future_date() {
        // 缺 date
        let mut schedule = once_schedule("2999-01-01", "09:00");
        schedule.date = None;
        assert!(validate_schedule(&schedule).is_err());

        // 非法 date
        assert!(validate_schedule(&once_schedule("2999-13-01", "09:00")).is_err());
        assert!(validate_schedule(&once_schedule("not-a-date", "09:00")).is_err());

        // 过期超过 1 分钟
        assert!(validate_schedule(&once_schedule("2020-01-01", "09:00")).is_err());

        // 未来时点合法
        assert!(validate_schedule(&once_schedule("2999-01-01", "09:00")).is_ok());

        // 其它 kind 不允许携带 date
        let mut daily = sample_daily("09:00").schedule;
        daily.date = Some("2999-01-01".to_string());
        assert!(validate_schedule(&daily).is_err());

        // once 不允许 weekday / interval / day_of_month
        let mut bad = once_schedule("2999-01-01", "09:00");
        bad.weekday = Some(1);
        assert!(validate_schedule(&bad).is_err());
    }

    #[test]
    fn compute_next_trigger_once_returns_fixed_instant() {
        let mut schedule = once_schedule("2026-08-01", "09:00");
        schedule.timezone = Some("UTC".to_string());
        let before = Utc
            .with_ymd_and_hms(2026, 7, 1, 0, 0, 0)
            .unwrap()
            .with_timezone(&Local);
        let expected = Utc.with_ymd_and_hms(2026, 8, 1, 9, 0, 0).unwrap();
        assert_eq!(
            compute_next_trigger(&schedule, before)
                .unwrap()
                .with_timezone(&Utc),
            expected
        );
        // 已过时点仍返回固定时刻（错过后的补跑/跳过由调度侧按 catch_up_policy 决定）
        let after = Utc
            .with_ymd_and_hms(2026, 9, 1, 0, 0, 0)
            .unwrap()
            .with_timezone(&Local);
        assert_eq!(
            compute_next_trigger(&schedule, after)
                .unwrap()
                .with_timezone(&Utc),
            expected
        );
    }

    #[test]
    fn once_serde_roundtrip_uses_date_field() {
        let schedule = once_schedule("2026-08-01", "09:00");
        let raw = serde_json::to_string(&schedule).unwrap();
        assert!(raw.contains("\"kind\":\"once\""));
        assert!(raw.contains("\"date\":\"2026-08-01\""));
        let parsed: AutomationSchedule = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, schedule);
    }

    #[test]
    fn once_claim_consumes_slot_and_clears_next_run() {
        let (_temp_dir, db) = setup_automation_db();
        let now = Utc.with_ymd_and_hms(2026, 8, 1, 9, 0, 30).unwrap();
        let mut automation = sample_daily("09:00");
        automation.schedule = once_schedule("2026-08-01", "09:00");
        automation.schedule.timezone = Some("UTC".to_string());
        automation.next_run_at = Some(
            Utc.with_ymd_and_hms(2026, 8, 1, 9, 0, 0)
                .unwrap()
                .to_rfc3339(),
        );
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();

        let claimed = claim_scheduled_run(
            &db,
            &automation.id,
            automation.next_run_at.as_deref().unwrap(),
            now,
        )
        .unwrap()
        .expect("once slot claimable");
        assert!(claimed.automation.next_run_at.is_none());
        let stored = load_automations(&db).unwrap().remove(0);
        assert!(stored.next_run_at.is_none());
        assert!(
            stored.enabled,
            "still enabled until the run reaches a terminal state"
        );

        complete_run(
            &db,
            &claimed.run_id,
            claimed.attempt,
            "success",
            &[],
            None,
            None,
            None,
        )
        .unwrap();
        finalize_once_automation(&db, None, &claimed.automation);
        let finalized = load_automations(&db).unwrap().remove(0);
        assert!(
            !finalized.enabled,
            "once automation is parked after completion"
        );
        assert!(finalized.next_run_at.is_none());
    }

    #[test]
    fn reenabling_a_consumed_once_automation_does_not_rearm_the_past_slot() {
        let (_temp_dir, db) = setup_automation_db();
        let slot = Utc.with_ymd_and_hms(2020, 1, 1, 9, 0, 0).unwrap();
        let mut automation = sample_daily("09:00");
        automation.schedule = once_schedule("2020-01-01", "09:00");
        automation.schedule.timezone = Some("UTC".to_string());
        // 模拟 finalize_once_automation 之后的固化态：时点已被 claim 消耗
        automation.enabled = false;
        automation.next_run_at = None;
        automation.last_run_at = Some(slot.to_rfc3339());
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();

        let (_, enabled) =
            set_automation_enabled(&db, &automation.id, automation.version, true).unwrap();
        assert!(enabled.enabled);
        assert!(
            enabled.next_run_at.is_none(),
            "consumed once slot must not be re-armed"
        );
        // 展示层同样不能把已消耗的时点当"下次触发"
        let item = automation_to_list_item(&enabled, Local::now());
        assert_eq!(item["next_trigger_at"], Value::Null);
    }

    #[test]
    fn reenabling_an_unconsumed_once_automation_restores_its_future_slot() {
        let (_temp_dir, db) = setup_automation_db();
        let mut automation = sample_daily("09:00");
        automation.schedule = once_schedule("2999-01-01", "09:00");
        automation.schedule.timezone = Some("UTC".to_string());
        automation.enabled = false;
        automation.next_run_at = None;
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();

        let (_, enabled) =
            set_automation_enabled(&db, &automation.id, automation.version, true).unwrap();
        assert_eq!(
            enabled.next_run_at,
            Some(
                Utc.with_ymd_and_hms(2999, 1, 1, 9, 0, 0)
                    .unwrap()
                    .to_rfc3339()
            ),
        );
    }

    #[test]
    fn run_listing_appends_duration_ms() {
        let (_temp_dir, db) = setup_automation_db();
        let automation = sample_daily("09:00");
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();
        let run = create_manual_run(&db, &automation.id, automation.version).unwrap();
        // 未完成的 run 不派生 duration
        let running = list_automation_runs(&db, Some(&automation.id), 1).unwrap();
        assert!(running[0].duration_ms.is_none());

        complete_run(
            &db,
            &run.run_id,
            run.attempt,
            "success",
            &[],
            None,
            None,
            None,
        )
        .unwrap();
        let runs = list_automation_runs(&db, Some(&automation.id), 1).unwrap();
        let duration = runs[0].duration_ms.expect("finished run exposes duration");
        assert!(duration >= 0);
        // 追加字段以 duration_ms 键序列化（前端可忽略）
        let serialized = serde_json::to_value(&runs[0]).unwrap();
        assert!(serialized.get("duration_ms").is_some());
    }

    #[test]
    fn retry_backoff_is_capped_at_24_hours() {
        let (_temp_dir, db) = setup_automation_db();
        let mut automation = sample_daily("09:00");
        automation.max_retries = 5;
        automation.retry_backoff_seconds = 86_400;
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();
        let run = create_manual_run(&db, &automation.id, automation.version).unwrap();
        // attempt=3 时未封顶的指数退避是 86400*4s，必须被压回 24h 以内
        db.get_conn_safe()
            .unwrap()
            .execute(
                "UPDATE automation_runs SET attempt = 3 WHERE id = ?1",
                params![run.run_id],
            )
            .unwrap();
        let before = Utc::now();
        let outcome = retry_or_finish_run(
            &db,
            &run.run_id,
            3,
            &automation,
            "error",
            None,
            "boom",
            false,
        )
        .unwrap();
        assert_eq!(outcome, RunFinalizeOutcome::RetryScheduled);
        let next_attempt_at = list_automation_runs(&db, Some(&automation.id), 1).unwrap()[0]
            .next_attempt_at
            .clone()
            .expect("retrying run has next_attempt_at");
        let next = DateTime::parse_from_rfc3339(&next_attempt_at)
            .unwrap()
            .with_timezone(&Utc);
        assert!(next <= before + chrono::Duration::seconds(MAX_RETRY_BACKOFF_SECS as i64 + 60));
    }

    #[test]
    fn manual_run_is_rejected_while_another_run_is_active() {
        let (_temp_dir, db) = setup_automation_db();
        let automation = sample_daily("09:00");
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();
        let first = create_manual_run(&db, &automation.id, automation.version).unwrap();

        let error = create_manual_run(&db, &automation.id, automation.version)
            .expect_err("second manual run must be rejected");
        assert!(matches!(&error.error_type, AppErrorType::Conflict));
        let details = error.details.as_ref().expect("structured details");
        assert_eq!(details["code"], "AUTOMATION_RUN_ALREADY_ACTIVE");
        assert_eq!(details["activeRunId"], first.run_id);
    }

    #[test]
    fn skew_threshold_matches_schedule_kinds() {
        assert_eq!(
            schedule_skew_threshold(&sample_daily("09:00").schedule),
            Some(chrono::Duration::hours(48))
        );
        assert_eq!(
            schedule_skew_threshold(&sample_interval(30).schedule),
            Some(chrono::Duration::minutes(60))
        );
        assert_eq!(
            schedule_skew_threshold(&once_schedule("2999-01-01", "09:00")),
            None
        );
    }

    #[test]
    fn effective_lease_timeout_prefers_trusted_profile_budget() {
        let mut automation = sample_daily("09:00");
        automation.timeout_seconds = 120;
        assert_eq!(effective_lease_timeout_seconds(&automation), 120);
        automation.trusted_profile = Some(trusted_profile_for_test());
        // trusted_profile_for_test 的 timeout_seconds = 300 > 120
        assert_eq!(effective_lease_timeout_seconds(&automation), 300);
    }

    #[test]
    fn heartbeat_sentinel_detection() {
        assert!(heartbeat_is_silent("HEARTBEAT_OK"));
        assert!(heartbeat_is_silent("  HEARTBEAT_OK\n"));
        assert!(!heartbeat_is_silent("检查完成：HEARTBEAT_OK"));
        assert!(!heartbeat_is_silent("今日有 3 张卡片到期，建议复习"));
        assert!(!heartbeat_is_silent(""));
    }

    #[test]
    fn ensure_heartbeat_in_list_is_idempotent() {
        let now = Utc.with_ymd_and_hms(2026, 7, 8, 12, 0, 0).unwrap();
        let mut automations: Vec<AutomationDefinition> = vec![sample_daily("09:00")];

        // 首次补齐
        assert!(ensure_heartbeat_in_list(&mut automations, now));
        assert_eq!(automations.len(), 2);
        let hb = automations
            .iter()
            .find(|a| a.heartbeat)
            .expect("heartbeat present");
        assert_eq!(hb.id, HEARTBEAT_AUTOMATION_ID);
        assert_eq!(hb.action_type, AutomationActionType::AgentTurn);
        assert!(!hb.enabled, "heartbeat must default to disabled");
        assert_eq!(
            hb.schedule.interval_minutes,
            Some(DEFAULT_HEARTBEAT_INTERVAL_MINUTES)
        );
        assert!(validate_schedule(&hb.schedule).is_ok());

        // 再次调用不重复插入
        assert!(!ensure_heartbeat_in_list(&mut automations, now));
        assert_eq!(automations.len(), 2);
    }

    #[test]
    fn agent_automation_run_guard_is_single_flight() {
        let guard = AgentAutomationRunGuard::try_acquire("auto_sf_test");
        assert!(guard.is_some());
        // 占用期间不可重入
        assert!(AgentAutomationRunGuard::try_acquire("auto_sf_test").is_none());
        // 其他 ID 不受影响
        let other = AgentAutomationRunGuard::try_acquire("auto_sf_other");
        assert!(other.is_some());
        drop(guard);
        // 释放后可再次占用
        assert!(AgentAutomationRunGuard::try_acquire("auto_sf_test").is_some());
    }

    #[test]
    fn default_heartbeat_prompt_mentions_sentinel() {
        assert!(DEFAULT_HEARTBEAT_PROMPT.contains(HEARTBEAT_OK_SENTINEL));
        // 心跳列表项序列化包含 action_type 供工具/前端识别
        let hb = default_heartbeat_definition(Utc::now());
        let item = automation_to_list_item(&hb, Local::now());
        assert_eq!(item["action_type"], json!("agent_turn"));
        assert_eq!(item["heartbeat"], json!(true));
    }

    #[test]
    fn monthly_schedule_uses_month_end_and_honors_timezone() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Monthly,
            time: "09:00".to_string(),
            weekday: None,
            weekdays: None,
            day_of_month: Some(31),
            interval_minutes: None,
            date: None,
            timezone: Some("UTC".to_string()),
        };
        let now = Utc
            .with_ymd_and_hms(2026, 2, 27, 12, 0, 0)
            .single()
            .unwrap()
            .with_timezone(&Local);
        let next = compute_next_trigger(&schedule, now).unwrap();
        assert_eq!(
            next.with_timezone(&Utc),
            Utc.with_ymd_and_hms(2026, 2, 28, 9, 0, 0).single().unwrap()
        );
    }

    #[test]
    fn weekdays_schedule_skips_weekend() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Weekdays,
            time: "09:00".to_string(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: None,
            date: None,
            timezone: Some("UTC".to_string()),
        };
        let friday_after_slot = Utc
            .with_ymd_and_hms(2026, 7, 17, 12, 0, 0)
            .single()
            .unwrap()
            .with_timezone(&Local);
        assert_eq!(
            compute_next_trigger(&schedule, friday_after_slot)
                .unwrap()
                .with_timezone(&Utc),
            Utc.with_ymd_and_hms(2026, 7, 20, 9, 0, 0).single().unwrap()
        );
    }

    #[test]
    fn scheduled_claim_is_atomic_and_deduplicated() {
        let (_temp_dir, db) = setup_automation_db();
        let now = Utc.with_ymd_and_hms(2026, 7, 14, 12, 0, 0).unwrap();
        let scheduled_for = Utc.with_ymd_and_hms(2026, 7, 14, 9, 0, 0).unwrap();
        let mut automation = sample_daily("09:00");
        automation.next_run_at = Some(scheduled_for.to_rfc3339());
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();

        let first = claim_scheduled_run(
            &db,
            &automation.id,
            automation.next_run_at.as_deref().unwrap(),
            now,
        )
        .unwrap();
        let second = claim_scheduled_run(
            &db,
            &automation.id,
            automation.next_run_at.as_deref().unwrap(),
            now,
        )
        .unwrap();

        assert_eq!(
            first.as_ref().map(|claimed| claimed.automation.version),
            Some(automation.version),
        );
        assert!(second.is_none());
        assert_eq!(
            list_automation_runs(&db, Some(&automation.id), 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            load_automations(&db).unwrap().remove(0).version,
            automation.version,
        );
    }

    #[test]
    fn scheduled_claim_waits_for_an_existing_active_run() {
        let (_temp_dir, db) = setup_automation_db();
        let now = Utc.with_ymd_and_hms(2026, 7, 14, 12, 0, 0).unwrap();
        let scheduled_for = Utc.with_ymd_and_hms(2026, 7, 14, 9, 0, 0).unwrap();
        let mut automation = sample_daily("09:00");
        automation.next_run_at = Some(scheduled_for.to_rfc3339());
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();
        let active = create_manual_run(&db, &automation.id, automation.version).unwrap();

        let claimed = claim_scheduled_run(
            &db,
            &automation.id,
            automation.next_run_at.as_deref().unwrap(),
            now,
        )
        .unwrap();

        assert!(claimed.is_none());
        assert_eq!(
            load_automations(&db).unwrap().remove(0).next_run_at,
            automation.next_run_at,
        );
        complete_run(
            &db,
            &active.run_id,
            active.attempt,
            "success",
            &[],
            None,
            None,
            None,
        )
        .unwrap();
    }

    #[test]
    fn catch_up_policies_advance_from_the_expected_base() {
        let scheduled_for = Utc.with_ymd_and_hms(2026, 7, 10, 9, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 7, 13, 12, 0, 0).unwrap();
        let mut automation = sample_daily("09:00");
        automation.schedule.timezone = Some("UTC".to_string());

        automation.catch_up_policy = CatchUpPolicy::CatchUpAll;
        assert_eq!(
            next_after_claim(&automation, scheduled_for, now).unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 7, 11, 9, 0, 0).unwrap())
        );
        for policy in [CatchUpPolicy::RunOnce, CatchUpPolicy::Skip] {
            automation.catch_up_policy = policy;
            assert_eq!(
                next_after_claim(&automation, scheduled_for, now).unwrap(),
                Some(Utc.with_ymd_and_hms(2026, 7, 14, 9, 0, 0).unwrap())
            );
        }
    }

    #[test]
    fn explicit_retry_adds_an_attempt_and_can_be_claimed() {
        let (_temp_dir, db) = setup_automation_db();
        let automation = sample_daily("09:00");
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();
        let run = create_manual_run(&db, &automation.id, automation.version).unwrap();
        complete_run(
            &db,
            &run.run_id,
            run.attempt,
            "error",
            &[],
            None,
            None,
            Some("failed"),
        )
        .unwrap();

        set_automation_enabled(&db, &automation.id, automation.version, false).unwrap();
        retry_automation_run(&db, &run.run_id).unwrap();
        let retrying = list_automation_runs(&db, Some(&automation.id), 1).unwrap();
        assert_eq!(retrying[0].status.as_deref(), Some("retrying"));
        assert!(retrying[0].max_attempts >= 2);

        let claimed = claim_retry_run(&db, &run.run_id).unwrap().unwrap();
        assert_eq!(claimed.trigger_type, "retry");
        assert_eq!(claimed.attempt, 2);
        let running = list_automation_runs(&db, Some(&automation.id), 1).unwrap();
        assert_eq!(running[0].status.as_deref(), Some("running"));
        assert_eq!(running[0].attempt, 2);
    }

    #[test]
    fn explicit_retry_waits_for_the_cancelled_executor_to_exit() {
        let (_temp_dir, db) = setup_automation_db();
        let automation = sample_daily("09:00");
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();
        let run = create_manual_run(&db, &automation.id, automation.version).unwrap();
        let (active_guard, token) = ActiveAutomationRunGuard::register(&run.run_id);

        cancel_automation_run(&db, &run.run_id).unwrap();
        assert!(token.is_cancelled());
        retry_automation_run(&db, &run.run_id).unwrap();

        assert!(claim_retry_run(&db, &run.run_id).unwrap().is_none());
        assert!(!complete_run(
            &db,
            &run.run_id,
            run.attempt,
            "cancelled",
            &[],
            None,
            None,
            None,
        )
        .unwrap());
        assert_eq!(
            list_automation_runs(&db, Some(&automation.id), 1).unwrap()[0]
                .status
                .as_deref(),
            Some("retrying")
        );

        drop(active_guard);
        let retry = claim_retry_run(&db, &run.run_id).unwrap().unwrap();
        assert_eq!(retry.attempt, 2);
        assert!(!complete_run(
            &db,
            &run.run_id,
            run.attempt,
            "error",
            &[],
            None,
            None,
            Some("stale executor result"),
        )
        .unwrap());
        let running = list_automation_runs(&db, Some(&automation.id), 1).unwrap();
        assert_eq!(running[0].status.as_deref(), Some("running"));
        assert_eq!(running[0].attempt, 2);
    }

    #[test]
    fn active_run_guard_does_not_remove_a_newer_token() {
        let run_id = format!("run_guard_{}", uuid::Uuid::new_v4());
        let (first_guard, first_token) = ActiveAutomationRunGuard::register(&run_id);
        let (second_guard, second_token) = ActiveAutomationRunGuard::register(&run_id);
        assert!(!first_token.is_cancelled());
        assert!(!second_token.is_cancelled());

        drop(first_guard);
        let current_token = ACTIVE_AUTOMATION_RUNS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&run_id)
            .map(|entry| entry.token.clone())
            .expect("newer token remains registered");
        current_token.cancel();
        assert!(!first_token.is_cancelled());
        assert!(second_token.is_cancelled());

        drop(second_guard);
        assert!(!automation_run_has_live_executor(&run_id));
    }

    #[test]
    fn stale_running_run_is_recovered_into_retry() {
        let (_temp_dir, db) = setup_automation_db();
        let mut automation = sample_daily("09:00");
        automation.timeout_seconds = 30;
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();
        let run = create_manual_run(&db, &automation.id, automation.version).unwrap();
        let stale_at = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        db.get_conn_safe()
            .unwrap()
            .execute(
                "UPDATE automation_runs
                 SET claimed_by = 'previous-process', claimed_at = ?2,
                     started_at = ?2, lease_expires_at = ?2, retry_requested = 0
                 WHERE id = ?1",
                params![run.run_id, stale_at],
            )
            .unwrap();

        assert_eq!(recover_stale_automation_runs(&db, None).unwrap(), 1);
        let runs = list_automation_runs(&db, Some(&automation.id), 1).unwrap();
        assert_eq!(runs[0].status.as_deref(), Some("retrying"));
        assert!(runs[0].next_attempt_at.is_some());
    }

    #[test]
    fn stale_run_for_a_disabled_automation_is_cancelled() {
        let (_temp_dir, db) = setup_automation_db();
        let mut automation = sample_daily("09:00");
        automation.timeout_seconds = 30;
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();
        let run = create_manual_run(&db, &automation.id, automation.version).unwrap();
        set_automation_enabled(&db, &automation.id, automation.version, false).unwrap();
        let stale_at = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        db.get_conn_safe()
            .unwrap()
            .execute(
                "UPDATE automation_runs
                 SET claimed_by = 'previous-process', claimed_at = ?2,
                     started_at = ?2, lease_expires_at = ?2, retry_requested = 0
                 WHERE id = ?1",
                params![run.run_id, stale_at],
            )
            .unwrap();

        assert_eq!(recover_stale_automation_runs(&db, None).unwrap(), 1);
        let runs = list_automation_runs(&db, Some(&automation.id), 1).unwrap();
        assert_eq!(runs[0].status.as_deref(), Some("cancelled"));
        assert!(runs[0].next_attempt_at.is_none());
    }

    #[test]
    fn legacy_json_migration_is_idempotent_and_retains_snapshot() {
        let (_temp_dir, db) = setup_automation_db();
        let mut existing = sample_daily("08:00");
        existing.id = "auto_existing".to_string();
        save_automations(&db, &[existing]).unwrap();
        let legacy = serde_json::to_string(&vec![sample_daily("09:00")]).unwrap();
        db.save_setting(AUTOMATIONS_KEY, &legacy).unwrap();

        assert_eq!(migrate_legacy_automations(&db).unwrap(), 1);
        assert_eq!(migrate_legacy_automations(&db).unwrap(), 0);
        assert_eq!(load_automations(&db).unwrap().len(), 2);
        assert_eq!(
            db.get_setting(AUTOMATIONS_KEY).unwrap().as_deref(),
            Some(legacy.as_str())
        );
    }

    #[test]
    fn full_update_can_clear_nullable_agent_fields() {
        let (_temp_dir, db) = setup_automation_db();
        let mut automation = sample_daily("09:00");
        automation.action_type = AutomationActionType::AgentTurn;
        automation.agent_prompt = Some("agent instructions".to_string());
        automation.session_mode = Some(HeadlessSessionMode::Named);
        automation.model_id = Some("model-a".to_string());
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();

        let request: AutomationUpdateCommandRequest = serde_json::from_value(json!({
            "automationId": automation.id,
            "expectedVersion": automation.version,
            "actionType": "notify",
            "agentPrompt": null,
            "sessionMode": null,
            "modelId": null
        }))
        .unwrap();
        assert_eq!(request.agent_prompt, Some(None));
        assert_eq!(request.session_mode, Some(None));
        assert_eq!(request.model_id, Some(None));

        let (_, updated) = update_automation_full(
            &db,
            &automation.id,
            request.expected_version,
            AutomationUpdateFields {
                action_type: request.action_type,
                agent_prompt: request.agent_prompt,
                session_mode: request.session_mode,
                model_id: request.model_id,
                ..AutomationUpdateFields::default()
            },
        )
        .unwrap();
        assert_eq!(updated.action_type, AutomationActionType::Notify);
        assert!(updated.agent_prompt.is_none());
        assert!(updated.session_mode.is_none());
        assert!(updated.model_id.is_none());

        let (_, renamed) = update_automation_full(
            &db,
            &automation.id,
            updated.version,
            AutomationUpdateFields {
                name: Some("Renamed automation".to_string()),
                ..AutomationUpdateFields::default()
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "Renamed automation");
    }

    #[test]
    fn full_update_rejects_stale_version_without_overwriting_current_value() {
        let (_temp_dir, db) = setup_automation_db();
        let automation = sample_daily("09:00");
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();

        let (_, updated) = update_automation_full(
            &db,
            &automation.id,
            automation.version,
            AutomationUpdateFields {
                name: Some("First update".to_string()),
                ..AutomationUpdateFields::default()
            },
        )
        .unwrap();
        let error = update_automation_full(
            &db,
            &automation.id,
            automation.version,
            AutomationUpdateFields {
                name: Some("Stale overwrite".to_string()),
                ..AutomationUpdateFields::default()
            },
        )
        .expect_err("stale update must be rejected");

        assert_eq!(updated.version, automation.version + 1);
        assert!(matches!(&error.error_type, AppErrorType::Conflict));
        let details = error.details.as_ref().expect("structured conflict details");
        assert_eq!(details["code"], AUTOMATION_VERSION_CONFLICT_CODE);
        assert_eq!(details["expectedVersion"], automation.version);
        assert_eq!(details["currentVersion"], updated.version);
        assert_eq!(details["current"]["name"], "First update");
        assert_eq!(details["current"]["version"], updated.version);
        let serialized = serialize_automation_update_error(error, true);
        let payload: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(payload["code"], AUTOMATION_VERSION_CONFLICT_CODE);
        assert_eq!(payload["current"]["version"], updated.version);
        let current = load_automations(&db).unwrap().remove(0);
        assert_eq!(current.name, "First update");
        assert_eq!(current.version, updated.version);
    }

    #[test]
    fn dst_gap_moves_to_the_first_valid_local_minute() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Daily,
            time: "02:30".to_string(),
            weekday: None,
            weekdays: None,
            day_of_month: None,
            interval_minutes: None,
            date: None,
            timezone: Some("America/New_York".to_string()),
        };
        let now = Utc
            .with_ymd_and_hms(2026, 3, 8, 5, 0, 0)
            .unwrap()
            .with_timezone(&Local);
        assert_eq!(
            compute_next_trigger(&schedule, now)
                .unwrap()
                .with_timezone(&Utc),
            Utc.with_ymd_and_hms(2026, 3, 8, 7, 0, 0).unwrap()
        );
    }

    #[test]
    fn cancel_run_signals_the_active_headless_token() {
        let (_temp_dir, db) = setup_automation_db();
        let automation = sample_daily("09:00");
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();
        let run = create_manual_run(&db, &automation.id, automation.version).unwrap();
        let (_guard, token) = ActiveAutomationRunGuard::register(&run.run_id);

        cancel_automation_run(&db, &run.run_id).unwrap();
        assert!(token.is_cancelled());
    }

    fn trusted_profile_for_test() -> TrustedAutomationProfile {
        let mut profile = TrustedAutomationProfile {
            schema_version: TRUSTED_AUTOMATION_PROFILE_SCHEMA_VERSION,
            profile_hash: String::new(),
            allowed_tools: vec!["builtin-local_shell_execute".to_string()],
            runtime_roots: vec![AutomationRuntimeRoot {
                root_id: "workspace".to_string(),
                access: AutomationRootAccess::ReadWrite,
            }],
            shell_command_prefixes: vec!["unzip".to_string()],
            network_domains: vec!["example.com".to_string()],
            max_tool_rounds: 8,
            timeout_seconds: 300,
            max_output_bytes: 64 * 1024,
            rollback_required: true,
        };
        profile.profile_hash = profile.computed_hash().unwrap();
        profile
    }

    #[test]
    fn aut_01_legacy_definition_defaults_to_no_trusted_profile() {
        let raw = serde_json::to_value(sample_daily("09:00")).unwrap();
        let mut legacy = raw.as_object().unwrap().clone();
        legacy.remove("trusted_profile");
        let parsed: AutomationDefinition = serde_json::from_value(Value::Object(legacy)).unwrap();
        assert!(parsed.trusted_profile.is_none());
    }

    #[test]
    fn aut_02_profile_hash_is_content_locked() {
        let mut unsealed = trusted_profile_for_test();
        unsealed.profile_hash.clear();
        let sealed = unsealed.seal().unwrap();
        assert_eq!(sealed.profile_hash, sealed.computed_hash().unwrap());

        let mut profile = trusted_profile_for_test();
        assert!(profile.validate().is_ok());
        profile.max_tool_rounds += 1;
        assert!(profile.validate().is_err());
    }

    #[test]
    fn aut_03_profile_rejects_untrusted_tools_and_unsafe_prefixes() {
        let mut profile = trusted_profile_for_test();
        profile.allowed_tools = vec!["builtin-tool_pack".to_string()];
        profile.profile_hash = profile.computed_hash().unwrap();
        assert!(profile.validate().is_err());

        let mut profile = trusted_profile_for_test();
        profile.shell_command_prefixes = vec!["unzip; rm".to_string()];
        profile.profile_hash = profile.computed_hash().unwrap();
        assert!(profile.validate().is_err());
    }

    #[test]
    fn aut_04_profile_rejects_rw_authorized_root_and_missing_rollback() {
        let mut profile = trusted_profile_for_test();
        profile.runtime_roots[0] = AutomationRuntimeRoot {
            root_id: "authorized_abc".to_string(),
            access: AutomationRootAccess::ReadWrite,
        };
        profile.profile_hash = profile.computed_hash().unwrap();
        assert!(profile.validate().is_err());

        let mut profile = trusted_profile_for_test();
        profile.rollback_required = false;
        profile.profile_hash = profile.computed_hash().unwrap();
        assert!(profile.validate().is_err());
    }

    #[test]
    fn aut_05_profile_enforces_budget_caps() {
        let mut profile = trusted_profile_for_test();
        profile.max_tool_rounds = 31;
        profile.max_output_bytes = TRUSTED_AUTOMATION_MAX_OUTPUT_BYTES + 1;
        profile.profile_hash = profile.computed_hash().unwrap();
        assert!(profile.validate().is_err());
    }
}
