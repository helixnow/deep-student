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

use chrono::{DateTime, Datelike, Local, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use rand::Rng;
use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
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
pub const DEFAULT_MAX_RETRIES: u8 = 2;
pub const DEFAULT_RETRY_BACKOFF_SECS: u64 = 60;
pub const DEFAULT_TIMEOUT_SECS: u64 = 600;
pub const AUTOMATION_VERSION_CONFLICT_CODE: &str = "AUTOMATION_VERSION_CONFLICT";

static AUTOMATION_APP_EXITING: AtomicBool = AtomicBool::new(false);

pub fn mark_automation_app_exiting() {
    AUTOMATION_APP_EXITING.store(true, Ordering::SeqCst);
}

pub fn automation_app_is_exiting() -> bool {
    AUTOMATION_APP_EXITING.load(Ordering::SeqCst)
}

/// interval 调度允许的分钟数范围
pub const MIN_INTERVAL_MINUTES: u32 = 5;
pub const MAX_INTERVAL_MINUTES: u32 = 24 * 60;

/// 预置心跳自动化的固定 ID（幂等创建的判据之一）
pub const HEARTBEAT_AUTOMATION_ID: &str = "auto_heartbeat_default";
/// 心跳默认间隔（分钟）
pub const DEFAULT_HEARTBEAT_INTERVAL_MINUTES: u32 = 30;
/// 心跳"无事"哨兵串：最终回复包含该串时静默吞掉、不发任何通知
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
    /// 0=Sunday … 6=Saturday (required when kind=weekly)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekday: Option<u8>,
    /// monthly 调度的日期（1-31；短月份自动落在该月最后一天）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_of_month: Option<u8>,
    /// 间隔分钟数（kind=interval 必填，范围 5–1440）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
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
}

const fn default_run_attempt() -> u32 {
    1
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

pub fn validate_schedule(schedule: &AutomationSchedule) -> Result<()> {
    if let Some(timezone) = schedule.timezone.as_deref() {
        timezone
            .parse::<Tz>()
            .map_err(|_| AppError::validation(format!("Invalid IANA timezone '{}'", timezone)))?;
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
    conn.execute(
        "INSERT INTO automation_definitions (
            id, name, schedule_json, prompt, enabled, created_at, updated_at,
            source_session_id, last_run_at, next_run_at, action_type, heartbeat,
            agent_prompt, session_mode, model_id, agent_session_id, catch_up_policy,
            max_retries, retry_backoff_seconds, timeout_seconds, version
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
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
    pub source_session_id: String,
}

pub fn create_automation(
    db: &Database,
    fields: AutomationCreateFields,
) -> Result<AutomationDefinition> {
    validate_automation_fields(&fields.name, &fields.prompt)?;
    validate_schedule(&fields.schedule)?;
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
        .prepare(
            "SELECT id, name, schedule_json, prompt, enabled, created_at, updated_at,
                    source_session_id, last_run_at, next_run_at, action_type, heartbeat,
                    agent_prompt, session_mode, model_id, agent_session_id, catch_up_policy,
                    max_retries, retry_backoff_seconds, timeout_seconds, version
             FROM automation_definitions
             ORDER BY created_at ASC, id ASC",
        )
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
    let next_run_at = if enabled {
        compute_next_trigger(&previous.schedule, Local::now())
            .ok()
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
    if !enabled {
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE automation_runs
             SET status = 'cancelled', finished_at = ?2, next_attempt_at = NULL, updated_at = ?2
             WHERE automation_id = ?1 AND status IN ('queued', 'retrying')",
            params![automation_id, now],
        )
        .map_err(|error| db_error("Failed to cancel pending automation retries", error))?;
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
}

pub fn update_automation_full(
    db: &Database,
    automation_id: &str,
    expected_version: u64,
    fields: AutomationUpdateFields,
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
    {
        return Err(AppError::validation(
            "At least one editable field is required".to_string(),
        ));
    }
    if let Some(schedule) = fields.schedule.as_ref() {
        validate_schedule(schedule)?;
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
        let prompt = prompt.trim().to_string();
        current.prompt = prompt.clone();
        if current.action_type == AutomationActionType::AgentTurn && current.agent_prompt.is_some()
        {
            current.agent_prompt = Some(prompt);
        }
    }
    if let Some(action_type) = fields.action_type {
        current.action_type = action_type;
        if action_type == AutomationActionType::Notify {
            current.agent_prompt = None;
            current.session_mode = None;
            current.model_id = None;
            current.agent_session_id = None;
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
    if current.action_type == AutomationActionType::Notify
        && (current.agent_prompt.is_some()
            || current.session_mode.is_some()
            || current.model_id.is_some())
    {
        return Err(AppError::validation(
            "agent fields require action_type=agent_turn".to_string(),
        ));
    }
    let schedule_json = serde_json::to_string(&current.schedule)
        .map_err(|error| AppError::internal(format!("Failed to serialize schedule: {}", error)))?;
    let affected = tx
        .execute(
            "UPDATE automation_definitions
         SET name = ?2, schedule_json = ?3, prompt = ?4, action_type = ?5,
             agent_prompt = ?6, session_mode = ?7, model_id = ?8,
             agent_session_id = ?9, catch_up_policy = ?10, max_retries = ?11,
             retry_backoff_seconds = ?12, timeout_seconds = ?13,
             next_run_at = ?14, updated_at = ?15, version = version + 1
         WHERE id = ?1 AND version = ?16",
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
    let _ = app_handle.emit(
        AUTOMATIONS_CHANGED_EVENT,
        json!({ "action": action, "automationId": automation_id }),
    );
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
            started_at: row.get("started_at")?,
            finished_at: row.get("finished_at")?,
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
    let mut stmt = conn.prepare(sql).map_err(|error| db_error("Failed to prepare paged run history", error))?;
    let map_row = |row: &Row<'_>| -> rusqlite::Result<AutomationRunRecord> {
        let delivered_json: String = row.get("delivered_json")?;
        let scheduled_for: String = row.get("scheduled_for")?;
        Ok(AutomationRunRecord {
            id: row.get("id")?, automation_id: row.get("automation_id")?,
            fired_at: scheduled_for.clone(), delivered: serde_json::from_str(&delivered_json).unwrap_or_default(),
            session_id: row.get("session_id")?, status: Some(row.get("status")?),
            trigger_type: row.get("trigger_type")?, scheduled_for,
            attempt: row.get::<_, i64>("attempt")?.max(1) as u32,
            max_attempts: row.get::<_, i64>("max_attempts")?.max(1) as u32,
            started_at: row.get("started_at")?, finished_at: row.get("finished_at")?,
            next_attempt_at: row.get("next_attempt_at")?, summary: row.get("summary")?, error: row.get("error")?,
        })
    };
    let limit = limit.clamp(1, 20) as i64;
    let offset = offset.min(i64::MAX as usize) as i64;
    let rows = if let Some(automation_id) = automation_id {
        stmt.query_map(params![automation_id, limit, offset], map_row)
    } else {
        stmt.query_map(params![limit, offset], map_row)
    }.map_err(|error| db_error("Failed to query paged run history", error))?;
    let runs = rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| db_error("Failed to decode paged run history", error))?;
    let total: i64 = if let Some(automation_id) = automation_id {
        conn.query_row(count_sql, params![automation_id], |row| row.get(0))
    } else {
        conn.query_row(count_sql, [], |row| row.get(0))
    }.map_err(|error| db_error("Failed to count run history", error))?;
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
        ScheduleKind::Daily => Ok(Some(build_slot(date)?)),
        ScheduleKind::Weekly => {
            let target = schedule.weekday.ok_or_else(|| {
                AppError::validation("weekly schedule missing weekday".to_string())
            })?;
            if date.weekday().num_days_from_sunday() as u8 != target {
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
        automation.enabled.then(|| {
            compute_next_trigger(&automation.schedule, now)
                .map(|dt| dt.with_timezone(&Utc).to_rfc3339())
                .unwrap_or_else(|_| "unknown".to_string())
        })
    });

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
        "session_mode": automation.session_mode.unwrap_or_default(),
        "model_id": automation.model_id,
        "agent_session_id": automation.agent_session_id,
        "catch_up_policy": automation.catch_up_policy,
        "max_retries": automation.max_retries,
        "retry_backoff_seconds": automation.retry_backoff_seconds,
        "timeout_seconds": automation.timeout_seconds,
        "version": automation.version,
    })
}

fn truncate_prompt_for_notification(prompt: &str) -> String {
    let preview: String = prompt.chars().take(100).collect();
    if prompt.chars().count() > 100 {
        format!("{}… 打开 Deep Student 执行此任务", preview)
    } else {
        format!("{} 打开 Deep Student 执行此任务", preview)
    }
}

fn send_automation_notification(app_handle: &AppHandle, name: &str, prompt: &str) -> bool {
    let body = truncate_prompt_for_notification(prompt);
    match app_handle
        .notification()
        .builder()
        .title(format!("自动化：{}", name))
        .body(body)
        .show()
    {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(
                "[AutomationScheduler] notification failed for '{}': {}",
                name,
                e
            );
            false
        }
    }
}

fn create_automation_todo(
    app_handle: &AppHandle,
    vfs_db: &VfsDatabase,
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

    match VfsTodoRepo::create_todo_item(vfs_db, params) {
        Ok(_) => {
            let _ = app_handle.emit(
                "todo://changed",
                json!({ "source": "automation", "action": "create_item" }),
            );
            true
        }
        Err(e) => {
            tracing::warn!("[AutomationScheduler] create_todo_item failed: {}", e);
            false
        }
    }
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

fn scheduler_identity() -> String {
    format!(
        "{}:{}",
        hostname::get()
            .ok()
            .and_then(|value| value.into_string().ok())
            .unwrap_or_else(|| "local".to_string()),
        std::process::id()
    )
}

fn next_after_claim(
    automation: &AutomationDefinition,
    scheduled_for: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>> {
    let base = if automation.catch_up_policy == CatchUpPolicy::CatchUpAll {
        scheduled_for
    } else {
        now
    };
    compute_next_trigger(&automation.schedule, base.with_timezone(&Local))
        .map(|value| value.with_timezone(&Utc))
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

    let next_run_at = next_after_claim(&automation, scheduled_for, now)?.to_rfc3339();
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
    tx.execute(
        "INSERT INTO automation_runs (
            id, automation_id, dedupe_key, trigger_type, scheduled_for, status,
            attempt, max_attempts, claimed_by, claimed_at, started_at,
            delivered_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'schedule', ?4, 'running', 1, ?5, ?6, ?7, ?7, '[]', ?7, ?7)",
        params![
            run_id,
            automation_id,
            dedupe_key,
            scheduled_for.to_rfc3339(),
            automation.max_retries as i64 + 1,
            scheduler_identity(),
            now.to_rfc3339(),
        ],
    )
    .map_err(|error| db_error("Failed to create automation run", error))?;
    tx.commit()
        .map_err(|error| db_error("Failed to commit automation claim", error))?;

    automation.last_run_at = Some(scheduled_for.to_rfc3339());
    automation.next_run_at = Some(next_run_at);
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
    tx.execute(
        "INSERT INTO automation_runs (
            id, automation_id, dedupe_key, trigger_type, scheduled_for, status,
            attempt, max_attempts, claimed_by, claimed_at, started_at,
            delivered_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'manual', ?4, 'running', 1, ?5, ?6, ?4, ?4, '[]', ?4, ?4)",
        params![
            run_id,
            automation.id,
            format!("manual:{}", run_id),
            now.to_rfc3339(),
            automation.max_retries as i64 + 1,
            scheduler_identity(),
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
             error = ?6, finished_at = ?7, next_attempt_at = NULL, updated_at = ?7
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
               ORDER BY created_at DESC
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
) -> Result<RunFinalizeOutcome> {
    let conn = db
        .get_conn_safe()
        .map_err(|cause| db_error("Failed to open automation database", cause))?;
    let (attempt, max_attempts, current_status): (i64, i64, String) = conn
        .query_row(
            "SELECT attempt, max_attempts, status FROM automation_runs WHERE id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|cause| db_error("Failed to load automation attempt", cause))?;
    if attempt != expected_attempt || current_status != "running" {
        return Ok(RunFinalizeOutcome::Superseded);
    }
    if attempt < max_attempts {
        let exponent = (attempt - 1).clamp(0, 10) as u32;
        let delay = automation
            .retry_backoff_seconds
            .saturating_mul(2_u64.saturating_pow(exponent));
        let next_attempt = Utc::now() + chrono::Duration::seconds(delay as i64);
        let changed = conn
            .execute(
                "UPDATE automation_runs
             SET status = 'retrying', error = ?2, session_id = ?3,
                 next_attempt_at = ?4, finished_at = NULL, updated_at = ?5
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
        Ok(if changed == 1 {
            RunFinalizeOutcome::RetryScheduled
        } else {
            RunFinalizeOutcome::Superseded
        })
    } else {
        let changed = complete_run(
            db,
            run_id,
            expected_attempt,
            terminal_status,
            &[],
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
) {
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
                )
                .unwrap_or(RunFinalizeOutcome::Finished);
                if finalize_outcome == RunFinalizeOutcome::Finished && !automation.heartbeat {
                    let _ = send_notification(
                        app_handle,
                        &format!("自动化失败：{}", automation.name),
                        &truncate_for_notification(&error, 120),
                    );
                }
            }
        }
        return;
    }

    let mut delivered = Vec::new();
    if send_automation_notification(app_handle, &automation.name, &automation.prompt) {
        delivered.push("notification".to_string());
    }
    if let Some(vfs_db) = vfs_db {
        if create_automation_todo(
            app_handle,
            vfs_db,
            &automation.name,
            &automation.prompt,
            now,
        ) {
            delivered.push("todo".to_string());
        }
    }

    let status = if delivered.is_empty() {
        "error"
    } else {
        "success"
    };
    if let Err(error) = complete_run(
        db,
        &claimed.run_id,
        claimed.attempt,
        status,
        &delivered,
        None,
        Some(&automation.prompt),
        (status == "error").then_some("Notification and todo delivery both failed"),
    ) {
        tracing::warn!(
            "[AutomationScheduler] failed to finish run '{}' for '{}': {}",
            claimed.run_id,
            automation.id,
            error
        );
    }
    emit_automations_changed(app_handle, "run_completed", &automation.id);
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

/// 心跳回复是否应静默吞掉（最终回复包含 HEARTBEAT_OK 哨兵串）
pub fn heartbeat_is_silent(content: &str) -> bool {
    content.contains(HEARTBEAT_OK_SENTINEL)
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

fn send_notification(app_handle: &AppHandle, title: &str, body: &str) -> bool {
    match app_handle
        .notification()
        .builder()
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
    tauri::async_runtime::spawn(async move {
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
    // 会话由 headless runner 创建/复用：
    // - isolated（默认）：每次新建，metadata 标注 automation_run/source；
    // - named：复用 agent_session_id 指向的固定会话（跨运行积累上下文）
    let session_mode = automation.session_mode.unwrap_or_default();
    let request = HeadlessTurnRequest {
        prompt: effective_agent_prompt(&automation),
        session_mode,
        named_session_id: automation.agent_session_id.clone(),
        model_id: automation.model_id.clone(),
        source: format!("automation:{}:{}", automation.id, claimed.trigger_type),
        title: Some(format!("自动化：{}", automation.name)),
        hard_timeout_secs: Some(automation.timeout_seconds),
        max_tool_rounds: None,
        cancellation_token: Some(cancellation_token.clone()),
    };
    let result = run_headless_turn(app_handle.clone(), request).await;
    let was_cancelled = cancellation_token.is_cancelled();

    // named 模式：回存实际使用的会话 ID（首次运行/旧会话失效重建时会变化）
    if session_mode == HeadlessSessionMode::Named {
        if let Ok(outcome) = result.as_ref() {
            if automation.agent_session_id.as_deref() != Some(outcome.session_id.as_str()) {
                if let Err(e) =
                    update_automation_agent_session_id(&db, &automation.id, &outcome.session_id)
                {
                    tracing::warn!(
                        "[AutomationScheduler] failed to persist named session id for '{}': {}",
                        automation.id,
                        e
                    );
                }
            }
        }
    }

    let mut delivered: Vec<String> = Vec::new();
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
                    let body = if summary.is_empty() {
                        format!(
                            "已完成，打开 Deep Student 查看会话（{}）",
                            outcome.session_id
                        )
                    } else {
                        format!("{}\n打开 Deep Student 查看完整会话", summary)
                    };
                    if send_notification(
                        &app_handle,
                        &format!("自动化完成：{}", automation.name),
                        &body,
                    ) {
                        delivered.push("notification".to_string());
                    }
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
            // 基础设施级失败（管线未初始化 / 无窗口 / 会话流冲突等）
            session_id = None;
            status = "error".to_string();
            summary = truncate_for_notification(&e.to_string(), 160);
            tracing::warn!(
                "[AutomationScheduler] agent_turn automation '{}' failed: {}",
                automation.name,
                e
            );
        }
    }

    let successful = matches!(status.as_str(), "success" | "heartbeat_ok");
    let finalize_outcome = if successful {
        match complete_run(
            &db,
            &claimed.run_id,
            claimed.attempt,
            &status,
            &delivered,
            session_id.as_deref(),
            Some(&summary),
            None,
        ) {
            Ok(true) => RunFinalizeOutcome::Finished,
            Ok(false) => RunFinalizeOutcome::Superseded,
            Err(error) => {
                tracing::warn!("[AutomationScheduler] failed to complete run: {}", error);
                RunFinalizeOutcome::Finished
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
        ) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!("[AutomationScheduler] failed to persist retry: {}", error);
                RunFinalizeOutcome::Finished
            }
        }
    };

    if finalize_outcome == RunFinalizeOutcome::Superseded {
        emit_automations_changed(&app_handle, "run_superseded", &automation.id);
        return;
    }
    let retry_scheduled = finalize_outcome == RunFinalizeOutcome::RetryScheduled;

    if !successful && !retry_scheduled && !automation.heartbeat && !was_cancelled {
        if send_notification(
            &app_handle,
            &format!("自动化失败：{}", automation.name),
            &summary,
        ) {
            delivered.push("notification".to_string());
            let _ = complete_run(
                &db,
                &claimed.run_id,
                claimed.attempt,
                &status,
                &delivered,
                session_id.as_deref(),
                Some(&summary),
                Some(&summary),
            );
        }
    }

    let emitted_status = if was_cancelled {
        "cancelled"
    } else if retry_scheduled {
        "retrying"
    } else {
        status.as_str()
    };
    let _ = app_handle.emit(
        "chat_v2_automation_run_completed",
        json!({
            "automationId": automation.id,
            "automationName": automation.name,
            "sessionId": session_id,
            "runId": claimed.run_id,
            "status": emitted_status,
            "summary": summary,
            "heartbeat": automation.heartbeat,
        }),
    );
    emit_automations_changed(&app_handle, "run_completed", &automation.id);
}

// ============================================================================
// Heartbeat 预置自动化
// ============================================================================

/// 默认心跳自动化定义（enabled=false，用户/前端显式开启后生效）
pub fn default_heartbeat_definition(now: DateTime<Utc>) -> AutomationDefinition {
    AutomationDefinition {
        id: HEARTBEAT_AUTOMATION_ID.to_string(),
        name: "学习心跳检查".to_string(),
        schedule: AutomationSchedule {
            kind: ScheduleKind::Interval,
            time: String::new(),
            weekday: None,
            day_of_month: None,
            interval_minutes: Some(DEFAULT_HEARTBEAT_INTERVAL_MINUTES),
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
/// TODO(优化): "无到期任务则跳过 LLM 调用"——在拉起 headless turn 前先做
/// 一次纯 DB 检查（到期复习计划 / 逾期待办计数），全空则本轮直接跳过，
/// 省掉一次模型调用（对齐成熟代理运行时的 heartbeat 的空转优化）。
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
    #[serde(default)]
    pub day_of_month: Option<u8>,
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub timezone: Option<String>,
}

impl From<AutomationScheduleCommandRequest> for AutomationSchedule {
    fn from(value: AutomationScheduleCommandRequest) -> Self {
        Self {
            kind: value.kind,
            time: value.time,
            weekday: value.weekday,
            day_of_month: value.day_of_month,
            interval_minutes: value.interval_minutes,
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
}

const fn default_true() -> bool {
    true
}

#[tauri::command]
pub fn chat_v2_automation_list(
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    automation_list_response(&db).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn chat_v2_automation_create(
    request: AutomationCreateCommandRequest,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
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
            source_session_id: "ui".to_string(),
        },
    )
    .map_err(|error| error.to_string())?;
    emit_automations_changed(&app_handle, "create", &automation.id);
    Ok(json!({
        "success": true,
        "automation": automation_to_list_item(&automation, Local::now()),
    }))
}

#[tauri::command]
pub fn chat_v2_automation_set_enabled(
    automation_id: String,
    expected_version: u64,
    enabled: bool,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let (previous, current) =
        set_automation_enabled(&db, &automation_id, expected_version, enabled)
            .map_err(|error| serialize_automation_update_error(error, false))?;
    emit_automations_changed(&app_handle, "set_enabled", &automation_id);
    Ok(json!({
        "success": true,
        "previous": automation_to_list_item(&previous, Local::now()),
        "current": automation_to_list_item(&current, Local::now()),
    }))
}

#[tauri::command]
pub fn chat_v2_automation_update(
    request: AutomationUpdateCommandRequest,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let automation_id = request.automation_id.trim().to_string();
    if automation_id.is_empty() {
        return Err("automationId must not be empty".to_string());
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
        },
    )
    .map_err(|error| serialize_automation_update_error(error, false))?;
    emit_automations_changed(&app_handle, "update", &automation_id);
    Ok(json!({
        "success": true,
        "previous": automation_to_list_item(&previous, Local::now()),
        "current": automation_to_list_item(&current, Local::now()),
        "next_trigger": current.next_run_at,
    }))
}

#[tauri::command]
pub fn chat_v2_automation_runs(
    automation_id: Option<String>,
    limit: Option<usize>,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let runs = list_automation_runs(&db, automation_id.as_deref(), limit.unwrap_or(50))
        .map_err(|error| error.to_string())?;
    let count = runs.len();
    Ok(json!({ "runs": runs, "count": count }))
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
                 error = NULL, max_attempts = MAX(max_attempts, attempt + 1), updated_at = ?2
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
                 updated_at = ?2
             WHERE id = ?1 AND status IN ('queued', 'running', 'retrying')",
            params![run_id, now],
        )
        .map_err(|error| db_error("Failed to cancel automation run", error))?;
    if changed != 1 {
        return Err(AppError::validation("Run is not cancellable".to_string()));
    }
    prune_run_history(&conn, run_id)?;
    drop(conn);
    if let Some(token) = ACTIVE_AUTOMATION_RUNS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(run_id)
        .map(|entry| entry.token.clone())
    {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub fn chat_v2_automation_retry_run(
    run_id: String,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    retry_automation_run(&db, &run_id).map_err(|error| error.to_string())?;
    emit_automations_changed(&app_handle, "retry", "");
    Ok(json!({ "success": true, "runId": run_id }))
}

#[tauri::command]
pub fn chat_v2_automation_cancel_run(
    run_id: String,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    cancel_automation_run(&db, &run_id).map_err(|error| error.to_string())?;
    emit_automations_changed(&app_handle, "cancel_run", "");
    Ok(json!({ "success": true, "runId": run_id }))
}

#[tauri::command]
pub fn chat_v2_automation_summary(
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let conn = db.get_conn_safe().map_err(|error| error.to_string())?;
    let enabled: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM automation_definitions WHERE enabled = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let running: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM automation_runs WHERE status = 'running'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let failed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM automation_runs
             WHERE status IN ('error', 'timeout', 'spawn_error')
               AND finished_at >= ?1",
            params![(Utc::now() - chrono::Duration::hours(24)).to_rfc3339()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
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
                 WHERE a.enabled = 1 AND r.status = 'retrying'
                   AND r.next_attempt_at IS NOT NULL
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "enabledCount": enabled,
        "runningCount": running,
        "failedCount": failed,
        "nextRunAt": next_run_at,
        "backgroundEnabled": automation_background_enabled(&db),
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
pub fn chat_v2_automation_set_background_enabled(
    enabled: bool,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    db.save_setting(
        AUTOMATION_BACKGROUND_KEY,
        if enabled { "true" } else { "false" },
    )
    .map_err(|error| error.to_string())?;
    emit_automations_changed(&app_handle, "background", "");
    Ok(json!({ "success": true, "enabled": enabled }))
}

#[tauri::command]
pub fn chat_v2_automation_delete(
    automation_id: String,
    expected_version: u64,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let deleted = delete_automation(&db, &automation_id, expected_version)
        .map_err(|error| serialize_automation_update_error(error, false))?;
    emit_automations_changed(&app_handle, "delete", &automation_id);
    Ok(json!({
        "success": true,
        "automationId": automation_id,
        "deleted": automation_to_list_item(&deleted, Local::now()),
        "reversible": false,
    }))
}

pub fn run_automation_now_core(
    automation_id: &str,
    expected_version: u64,
    app_handle: AppHandle,
    db: Arc<Database>,
    agent_facing: bool,
) -> std::result::Result<Value, String> {
    let automation = get_automation(&db, automation_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Automation '{}' not found", automation_id))?;
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
            let claimed = create_manual_run(&db, automation_id, expected_version)
                .map_err(|error| serialize_automation_update_error(error, agent_facing))?;
            let run_id = claimed.run_id.clone();
            process_due_automation(&db, vfs_db.as_ref(), &app_handle, claimed, Local::now());
            json!({ "status": "notified", "automationId": automation_id, "runId": run_id })
        }
    };
    emit_automations_changed(&app_handle, "run_now", automation_id);
    Ok(result)
}

/// 立即运行一条自动化（绕过调度时点）。
///
/// - `agent_turn` 类型：拉起 headless 运行，立即返回隔离会话 ID（单飞保护）；
/// - `notify` 类型：立即执行通知+待办投递。
#[tauri::command]
pub async fn chat_v2_automation_run_now(
    automation_id: String,
    expected_version: u64,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    run_automation_now_core(
        &automation_id,
        expected_version,
        app_handle,
        db.inner().clone(),
        false,
    )
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
    session_id: &str,
) -> Result<()> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| db_error("Failed to open automation database", error))?;
    conn.execute(
        "UPDATE automation_definitions
         SET agent_session_id = ?2, updated_at = ?3
         WHERE id = ?1",
        params![automation_id, session_id, Utc::now().to_rfc3339()],
    )
    .map_err(|error| db_error("Failed to update automation session", error))?;
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
             WHERE r.status = 'retrying' AND r.next_attempt_at <= ?1 AND a.enabled = 1
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
    let run: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT automation_id, scheduled_for, attempt FROM automation_runs
             WHERE id = ?1 AND status = 'retrying' AND next_attempt_at <= ?2",
            params![run_id, Utc::now().to_rfc3339()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| db_error("Failed to load retry run", error))?;
    let Some((automation_id, scheduled_for, previous_attempt)) = run else {
        return Ok(None);
    };
    let automation = tx
        .query_row(
            "SELECT * FROM automation_definitions WHERE id = ?1 AND enabled = 1",
            params![automation_id],
            row_to_automation,
        )
        .optional()
        .map_err(|error| db_error("Failed to load retry automation", error))?;
    let Some(automation) = automation else {
        tx.execute(
            "UPDATE automation_runs SET status = 'cancelled', finished_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![run_id, Utc::now().to_rfc3339()],
        )
        .map_err(|error| db_error("Failed to cancel disabled retry", error))?;
        tx.commit()
            .map_err(|error| db_error("Failed to commit retry cancellation", error))?;
        return Ok(None);
    };
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
    let changed = tx
        .execute(
            "UPDATE automation_runs
             SET status = 'running', trigger_type = 'retry', attempt = attempt + 1,
                 claimed_by = ?2, claimed_at = ?3, started_at = ?3,
                 finished_at = NULL, next_attempt_at = NULL, updated_at = ?3
             WHERE id = ?1 AND status = 'retrying'",
            params![run_id, scheduler_identity(), now],
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

fn recover_stale_automation_runs(db: &Database) -> Result<usize> {
    let candidates: Vec<(String, String, String, i64)> = {
        let conn = db
            .get_conn_safe()
            .map_err(|error| db_error("Failed to open automation database", error))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, automation_id, COALESCE(claimed_at, started_at, created_at), attempt
                 FROM automation_runs WHERE status = 'running'",
            )
            .map_err(|error| db_error("Failed to prepare stale runs", error))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|error| db_error("Failed to query stale runs", error))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| db_error("Failed to decode stale runs", error))?
    };

    let mut recovered = 0;
    for (run_id, automation_id, claimed_at, attempt) in candidates {
        let Some(automation) = get_automation(db, &automation_id)? else {
            continue;
        };
        let claimed_at = parse_utc_datetime(&claimed_at)?;
        let stale_after = automation.timeout_seconds.saturating_add(60);
        if Utc::now().signed_duration_since(claimed_at)
            < chrono::Duration::seconds(stale_after as i64)
        {
            continue;
        }
        if !automation.enabled {
            cancel_automation_run(db, &run_id)?;
            recovered += 1;
            continue;
        }
        let _ = retry_or_finish_run(
            db,
            &run_id,
            attempt,
            &automation,
            "error",
            None,
            "Application stopped before the automation run completed",
        )?;
        recovered += 1;
    }
    Ok(recovered)
}

pub fn tick_automations(
    db: &Arc<Database>,
    vfs_db: Option<&Arc<VfsDatabase>>,
    app_handle: &AppHandle,
) -> Result<()> {
    recover_stale_automation_runs(db)?;
    let automations = load_automations(db)?;
    let now = Local::now();

    for run_id in due_retry_ids(db, now.with_timezone(&Utc))? {
        if let Some(claimed) = claim_retry_run(db, &run_id)? {
            process_due_automation(db, vfs_db, app_handle, claimed, now);
        }
    }

    for automation in automations {
        if !automation.enabled {
            continue;
        }
        let Some(next_run_at) = automation.next_run_at.as_deref() else {
            initialize_next_run(db, &automation)?;
            continue;
        };
        let scheduled_for = parse_utc_datetime(next_run_at)?;
        if scheduled_for > now.with_timezone(&Utc) {
            continue;
        }
        if let Some(claimed) =
            claim_scheduled_run(db, &automation.id, next_run_at, now.with_timezone(&Utc))?
        {
            let lateness = now.with_timezone(&Utc).signed_duration_since(scheduled_for);
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
                continue;
            }
            process_due_automation(db, vfs_db, app_handle, claimed, now);
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

    if let Err(error) = migrate_legacy_automations(&database) {
        tracing::warn!("[AutomationScheduler] legacy migration failed: {}", error);
    }
    match recover_stale_automation_runs(&database) {
        Ok(count) if count > 0 => tracing::info!(
            "[AutomationScheduler] recovered {} stale automation runs",
            count
        ),
        Ok(_) => {}
        Err(error) => tracing::warn!("[AutomationScheduler] stale run recovery failed: {}", error),
    }

    // 幂等预置心跳自动化（默认 disabled，用户显式开启后按 interval 触发）
    if let Err(e) = ensure_heartbeat_automation(&database) {
        tracing::warn!(
            "[AutomationScheduler] ensure_heartbeat_automation failed: {}",
            e
        );
    }

    loop {
        if let Err(e) = tick_automations(&database, vfs_db.as_ref(), &app_handle) {
            tracing::warn!("[AutomationScheduler] tick failed: {}", e);
        }
        sleep(Duration::from_secs(SCHEDULER_POLL_SECS)).await;
    }
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
        drop(conn);
        (temp_dir, db)
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
                day_of_month: None,
                interval_minutes: None,
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
                day_of_month: None,
                interval_minutes: Some(minutes),
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
            day_of_month: None,
            interval_minutes: None,
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
            day_of_month: None,
            interval_minutes: None,
            timezone: None,
        };
        assert!(validate_schedule(&schedule).is_err());
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
                day_of_month: None,
                interval_minutes: None,
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
                day_of_month: None,
                interval_minutes: None,
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
            day_of_month: None,
            interval_minutes: None,
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
            day_of_month: None,
            interval_minutes: None,
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
            day_of_month: None,
            interval_minutes: None,
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
        automation.next_run_at = None;
        save_automations(&db, std::slice::from_ref(&automation)).unwrap();

        initialize_next_run(&db, &automation).unwrap();
        update_automation_last_run_at(&db, &automation.id, &Utc::now().to_rfc3339()).unwrap();
        update_automation_agent_session_id(&db, &automation.id, "sess_runtime").unwrap();

        let current = load_automations(&db).unwrap().remove(0);
        assert_eq!(current.version, automation.version);
        assert!(current.next_run_at.is_some());
        assert!(current.last_run_at.is_some());
        assert_eq!(current.agent_session_id.as_deref(), Some("sess_runtime"));
    }

    #[test]
    fn update_prompt_changes_effective_agent_prompt() {
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
        assert_eq!(effective_agent_prompt(&updated), "new effective prompt");
        assert_eq!(
            updated.agent_prompt.as_deref(),
            Some("new effective prompt")
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
            day_of_month: None,
            interval_minutes: Some(30),
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
            day_of_month: None,
            interval_minutes: Some(30),
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
            day_of_month: None,
            interval_minutes: Some(45),
            timezone: None,
        };
        let now = local_at(2026, 7, 8, 10, 0);
        let next = compute_next_trigger(&schedule, now).unwrap();
        assert_eq!(next, local_at(2026, 7, 8, 10, 45));
    }

    #[test]
    fn heartbeat_sentinel_detection() {
        assert!(heartbeat_is_silent("HEARTBEAT_OK"));
        assert!(heartbeat_is_silent("  HEARTBEAT_OK\n"));
        assert!(heartbeat_is_silent("检查完成：HEARTBEAT_OK"));
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
            day_of_month: Some(31),
            interval_minutes: None,
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
            day_of_month: None,
            interval_minutes: None,
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
            Utc.with_ymd_and_hms(2026, 7, 11, 9, 0, 0).unwrap()
        );
        for policy in [CatchUpPolicy::RunOnce, CatchUpPolicy::Skip] {
            automation.catch_up_policy = policy;
            assert_eq!(
                next_after_claim(&automation, scheduled_for, now).unwrap(),
                Utc.with_ymd_and_hms(2026, 7, 14, 9, 0, 0).unwrap()
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
                "UPDATE automation_runs SET claimed_at = ?2, started_at = ?2 WHERE id = ?1",
                params![run.run_id, stale_at],
            )
            .unwrap();

        assert_eq!(recover_stale_automation_runs(&db).unwrap(), 1);
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
                "UPDATE automation_runs SET claimed_at = ?2, started_at = ?2 WHERE id = ?1",
                params![run.run_id, stale_at],
            )
            .unwrap();

        assert_eq!(recover_stale_automation_runs(&db).unwrap(), 1);
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
            day_of_month: None,
            interval_minutes: None,
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
}
