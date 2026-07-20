//! automation_propose / automation_list / automation_set_enabled 工具执行器

use std::time::Instant;

use async_trait::async_trait;
use chrono::{DateTime, Local};
use serde_json::{json, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::automations::{
    automation_agent_list_response, automation_to_agent_list_item, cancel_automation_run,
    compute_next_trigger, create_automation, delete_automation, emit_automations_changed,
    list_automation_runs_page, retry_automation_run, run_automation_now_core,
    serialize_automation_update_error, set_automation_enabled, update_automation_full,
    validate_automation_fields, validate_schedule, AutomationActionType, AutomationCreateFields,
    AutomationSchedule, AutomationUpdateFields, CatchUpPolicy, ScheduleKind,
    TrustedAutomationProfile, AUTOMATION_VERSION_CONFLICT_CODE, DEFAULT_MAX_RETRIES,
    DEFAULT_RETRY_BACKOFF_SECS, DEFAULT_TIMEOUT_SECS, MAX_PROMPT_LEN,
};
use crate::chat_v2::headless::HeadlessSessionMode;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;
use crate::database::Database;

pub mod tool_names {
    pub const AUTOMATION_PROPOSE: &str = "automation_propose";
    pub const AUTOMATION_LIST: &str = "automation_list";
    pub const AUTOMATION_SET_ENABLED: &str = "automation_set_enabled";
    pub const AUTOMATION_UPDATE: &str = "automation_update";
    pub const AUTOMATION_DELETE: &str = "automation_delete";
    pub const AUTOMATION_RUN_NOW: &str = "automation_run_now";
    pub const AUTOMATION_RUNS: &str = "automation_runs";
    pub const AUTOMATION_RETRY_RUN: &str = "automation_retry_run";
    pub const AUTOMATION_CANCEL_RUN: &str = "automation_cancel_run";
}

const PROPOSE_ALLOWED_KEYS: &[&str] = &[
    "name",
    "schedule",
    "prompt",
    "enabled",
    "action_type",
    "agent_prompt",
    "session_mode",
    "model_id",
    "catch_up_policy",
    "max_retries",
    "retry_backoff_seconds",
    "timeout_seconds",
    "trusted_profile",
];
const SET_ENABLED_ALLOWED_KEYS: &[&str] = &["id", "expected_version", "enabled"];
const UPDATE_ALLOWED_KEYS: &[&str] = &[
    "id",
    "expected_version",
    "name",
    "schedule",
    "prompt",
    "action_type",
    "agent_prompt",
    "session_mode",
    "model_id",
    "catch_up_policy",
    "max_retries",
    "retry_backoff_seconds",
    "timeout_seconds",
    "trusted_profile",
];
const ID_ONLY_ALLOWED_KEYS: &[&str] = &["id"];
const ID_VERSION_ALLOWED_KEYS: &[&str] = &["id", "expected_version"];
const RUNS_ALLOWED_KEYS: &[&str] = &["automation_id", "status", "page", "page_size"];
const SCHEDULE_ALLOWED_KEYS: &[&str] = &[
    "kind",
    "time",
    "date",
    "weekday",
    "day_of_month",
    "interval_minutes",
    "timezone",
];
/// 运行历史中会出现的全部状态值（与 automations.rs 落库值一致）
const RUN_STATUS_VALUES: &[&str] = &[
    "queued",
    "running",
    "retrying",
    "success",
    "error",
    "timeout",
    "spawn_error",
    "cancelled",
    "heartbeat_ok",
];
const AUTOMATION_OCC_REQUIRED_CODE: &str = "AUTOMATION_OCC_REQUIRED";
const AUTOMATION_RUN_ALREADY_ACTIVE_CODE: &str = "AUTOMATION_RUN_ALREADY_ACTIVE";

fn automation_occ_required_error() -> String {
    json!({
        "code": AUTOMATION_OCC_REQUIRED_CODE,
        "errorType": "validation",
        "message": "expected_version is required; call automation_list and use its current version",
        "messageFallback": {
            "zh-CN": "必须先调用 automation_list，并将当前 version 原样传为 expected_version。",
            "en-US": "Call automation_list first and pass its current version as expected_version."
        },
        "requiredField": "expected_version",
        "retryable": false,
    })
    .to_string()
}

/// 把绝对触发时刻转成模型可直接转述的相对描述（中文，本地时区）。
fn describe_relative_time(target: DateTime<Local>, now: DateTime<Local>) -> String {
    let secs = (target - now).num_seconds();
    if secs <= 0 {
        return "即将触发".to_string();
    }
    let minutes = secs / 60;
    if minutes < 1 {
        return "1 分钟内".to_string();
    }
    if minutes < 60 {
        return format!("约 {} 分钟后", minutes);
    }
    let hours = minutes / 60;
    if hours < 24 {
        let rem = minutes % 60;
        if rem == 0 {
            return format!("约 {} 小时后", hours);
        }
        return format!("约 {} 小时 {} 分钟后", hours, rem);
    }
    let days = (target.date_naive() - now.date_naive()).num_days();
    match days {
        1 => format!("明天 {}", target.format("%H:%M")),
        2 => format!("后天 {}", target.format("%H:%M")),
        n => format!("{} 天后（{}）", n.max(1), target.format("%m-%d %H:%M")),
    }
}

/// 人话调度描述，供 propose 预览与 list 输出使用。
fn describe_schedule(schedule: &AutomationSchedule) -> String {
    const WEEKDAYS: [&str; 7] = ["日", "一", "二", "三", "四", "五", "六"];
    match schedule.kind {
        ScheduleKind::Daily => format!("每天 {}", schedule.time),
        ScheduleKind::Weekdays => format!("工作日（周一至周五）{}", schedule.time),
        ScheduleKind::Weekly => {
            let day = schedule
                .weekday
                .and_then(|w| WEEKDAYS.get(w as usize).copied())
                .unwrap_or("?");
            format!("每周{} {}", day, schedule.time)
        }
        ScheduleKind::Monthly => format!(
            "每月 {} 日 {}（短月份自动落到月末）",
            schedule.day_of_month.unwrap_or(1),
            schedule.time
        ),
        ScheduleKind::Interval => format!(
            "每 {} 分钟",
            schedule.interval_minutes.unwrap_or_default()
        ),
        ScheduleKind::Once => format!(
            "仅 {} {} 触发一次（触发后自动完成，不再重复）",
            schedule.date.as_deref().unwrap_or("指定日期"),
            schedule.time
        ),
    }
}

/// 把已知错误码/错误文案映射成模型可以向用户解释并给出下一步建议的说明。
fn friendly_automation_error(error: String) -> String {
    if let Ok(mut payload) = serde_json::from_str::<Value>(&error) {
        if let Some(object) = payload.as_object_mut() {
            let code = object
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let hint = match code.as_str() {
                c if c == AUTOMATION_VERSION_CONFLICT_CODE => Some(
                    "该自动化在你读取之后被修改过（可能是用户在设置页改的）。请重新调用 automation_list 获取最新 version 和内容，与用户确认改动仍然成立后，用新的 expected_version 重试；不要用猜测的版本号覆盖。",
                ),
                AUTOMATION_OCC_REQUIRED_CODE => Some(
                    "先调用 automation_list 拿到该自动化当前的 version，并原样作为 expected_version 传入后重试。",
                ),
                AUTOMATION_RUN_ALREADY_ACTIVE_CODE => Some(
                    "该自动化已有一次运行在排队或执行中，不能重复启动。可先用 automation_runs 查看当前运行状态，等它结束后再试，或用 automation_cancel_run 取消进行中的运行后重试。",
                ),
                _ => None,
            };
            if let Some(hint) = hint {
                object.insert("hint".to_string(), json!(hint));
            }
            return payload.to_string();
        }
    }
    if error.contains("Automation limit reached") {
        return format!(
            "{error}（自动化数量已达上限）。请先用 automation_list 查看现有任务，与用户确认删除或停用不再需要的任务后再创建新的。"
        );
    }
    if error.contains(AUTOMATION_RUN_ALREADY_ACTIVE_CODE) {
        return format!(
            "{error}。该自动化已有运行在排队或执行中：可用 automation_runs 查看状态，等待其完成，或用 automation_cancel_run 取消后再重试。"
        );
    }
    error
}

pub struct AutomationExecutor;

impl AutomationExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        strip_tool_namespace(tool_name)
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

    fn database_arc(ctx: &ExecutionContext) -> std::sync::Arc<Database> {
        if let Some(db) = ctx.main_db.as_ref() {
            return db.clone();
        }
        ctx.window_ref().state::<AppState>().database.clone()
    }

    fn reject_unknown_fields(args: &Value, allowed: &[&str]) -> Result<(), String> {
        let Some(obj) = args.as_object() else {
            return Err("Arguments must be a JSON object".to_string());
        };
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

    fn parse_required_string(args: &Value, key: &str) -> Result<String, String> {
        args.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("'{}' is required and must be a non-empty string", key))
    }

    fn parse_schedule(value: &Value) -> Result<AutomationSchedule, String> {
        let obj = value
            .as_object()
            .ok_or("'schedule' must be a JSON object")?;
        for key in obj.keys() {
            if !SCHEDULE_ALLOWED_KEYS.contains(&key.as_str()) {
                return Err(format!(
                    "Unknown schedule field '{}'. Allowed: {}",
                    key,
                    SCHEDULE_ALLOWED_KEYS.join(", ")
                ));
            }
        }

        let kind_raw = obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("'schedule.kind' is required")?;
        let kind = match kind_raw.trim().to_ascii_lowercase().as_str() {
            "daily" => ScheduleKind::Daily,
            "weekly" => ScheduleKind::Weekly,
            "weekdays" => ScheduleKind::Weekdays,
            "monthly" => ScheduleKind::Monthly,
            "interval" => ScheduleKind::Interval,
            "once" => ScheduleKind::Once,
            other => {
                return Err(format!(
                "Invalid schedule.kind '{}'. Allowed: daily, weekly, weekdays, monthly, interval, once",
                other
            ))
            }
        };

        // interval 调度不需要 time；其余（含 once）必填
        let time = match obj.get("time").and_then(Value::as_str) {
            Some(t) => t.trim().to_string(),
            None if kind == ScheduleKind::Interval => String::new(),
            None => return Err("'schedule.time' is required (HH:MM, 24h)".to_string()),
        };

        // once 调度的目标日期（YYYY-MM-DD）；格式/过期校验交给 validate_schedule
        let date = match obj.get("date") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("'schedule.date' must be a YYYY-MM-DD string")?
                    .to_string(),
            ),
        };
        if kind == ScheduleKind::Once && date.is_none() {
            return Err("'schedule.date' is required when kind is 'once' (YYYY-MM-DD)".to_string());
        }

        let weekday = match obj.get("weekday") {
            None => None,
            Some(v) => {
                let n = v
                    .as_u64()
                    .ok_or("'schedule.weekday' must be an integer 0-6")?;
                if n > 6 {
                    return Err(
                        "'schedule.weekday' must be between 0 (Sunday) and 6 (Saturday)"
                            .to_string(),
                    );
                }
                Some(n as u8)
            }
        };

        let interval_minutes = match obj.get("interval_minutes") {
            None => None,
            Some(v) => {
                let n = v
                    .as_u64()
                    .ok_or("'schedule.interval_minutes' must be a positive integer")?;
                Some(
                    u32::try_from(n)
                        .map_err(|_| "'schedule.interval_minutes' is out of range".to_string())?,
                )
            }
        };

        let day_of_month = match obj.get("day_of_month") {
            None => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .and_then(|value| u8::try_from(value).ok())
                    .ok_or("'schedule.day_of_month' must be an integer 1-31")?,
            ),
        };
        let timezone = match obj.get("timezone") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("'schedule.timezone' must be a non-empty IANA timezone string")?
                    .to_string(),
            ),
        };

        let schedule = AutomationSchedule {
            kind,
            time,
            date,
            weekday,
            day_of_month,
            interval_minutes,
            timezone,
        };
        validate_schedule(&schedule).map_err(|e| e.to_string())?;
        Ok(schedule)
    }

    fn parse_action_type(args: &Value) -> Result<AutomationActionType, String> {
        match args.get("action_type") {
            None => Ok(AutomationActionType::Notify),
            Some(v) => {
                let raw = v
                    .as_str()
                    .ok_or("'action_type' must be a string: notify | agent_turn")?;
                AutomationActionType::parse(raw).map_err(|e| e.to_string())
            }
        }
    }

    fn parse_optional_action_type(args: &Value) -> Result<Option<AutomationActionType>, String> {
        match args.get("action_type") {
            None => Ok(None),
            Some(value) => {
                let raw = value.as_str().ok_or_else(|| {
                    "'action_type' must be a string: notify | agent_turn".to_string()
                })?;
                AutomationActionType::parse(raw)
                    .map(Some)
                    .map_err(|error| error.to_string())
            }
        }
    }

    fn parse_catch_up_policy(
        args: &Value,
        required: bool,
    ) -> Result<Option<CatchUpPolicy>, String> {
        match args.get("catch_up_policy") {
            None if required => Ok(Some(CatchUpPolicy::RunOnce)),
            None => Ok(None),
            Some(value) => {
                let raw = value.as_str().ok_or_else(|| {
                    "'catch_up_policy' must be skip | run_once | catch_up_all".to_string()
                })?;
                CatchUpPolicy::parse(raw)
                    .map(Some)
                    .map_err(|error| error.to_string())
            }
        }
    }

    fn parse_optional_u64(
        args: &Value,
        key: &str,
        min: u64,
        max: u64,
    ) -> Result<Option<u64>, String> {
        let Some(value) = args.get(key) else {
            return Ok(None);
        };
        let value = value
            .as_u64()
            .ok_or_else(|| format!("'{}' must be an integer", key))?;
        if !(min..=max).contains(&value) {
            return Err(format!("'{}' must be between {} and {}", key, min, max));
        }
        Ok(Some(value))
    }

    fn parse_required_version(args: &Value) -> Result<u64, String> {
        Self::parse_optional_u64(args, "expected_version", 1, i64::MAX as u64)?
            .ok_or_else(automation_occ_required_error)
    }

    fn parse_nullable_string(
        args: &Value,
        key: &str,
        max_chars: Option<usize>,
    ) -> Result<Option<Option<String>>, String> {
        let Some(value) = args.get(key) else {
            return Ok(None);
        };
        if value.is_null() {
            return Ok(Some(None));
        }
        let value = value
            .as_str()
            .ok_or_else(|| format!("'{}' must be a string or null", key))?
            .trim()
            .to_string();
        if max_chars.is_some_and(|max| value.chars().count() > max) {
            return Err(format!(
                "'{}' must be at most {} characters",
                key,
                max_chars.unwrap_or_default()
            ));
        }
        Ok(Some((!value.is_empty()).then_some(value)))
    }

    fn parse_nullable_session_mode(
        args: &Value,
    ) -> Result<Option<Option<HeadlessSessionMode>>, String> {
        let Some(value) = args.get("session_mode") else {
            return Ok(None);
        };
        if value.is_null() {
            return Ok(Some(None));
        }
        let raw = value
            .as_str()
            .ok_or_else(|| "'session_mode' must be isolated | named | null".to_string())?;
        HeadlessSessionMode::parse(raw).map(|mode| Some(Some(mode)))
    }

    /// 解析 agent_turn 专属字段（agent_prompt / session_mode / model_id）。
    ///
    /// notify 类型带这些字段视为参数错误（fail-closed，避免模型误解语义）。
    fn parse_agent_fields(
        args: &Value,
        action_type: AutomationActionType,
    ) -> Result<(Option<String>, Option<HeadlessSessionMode>, Option<String>), String> {
        let agent_prompt = match args.get("agent_prompt") {
            None => None,
            Some(v) => {
                let raw = v
                    .as_str()
                    .ok_or("'agent_prompt' must be a string")?
                    .trim()
                    .to_string();
                if raw.is_empty() {
                    None
                } else {
                    if raw.chars().count() > MAX_PROMPT_LEN {
                        return Err(format!(
                            "agent_prompt must be at most {} characters",
                            MAX_PROMPT_LEN
                        ));
                    }
                    Some(raw)
                }
            }
        };

        let session_mode = match args.get("session_mode") {
            None => None,
            Some(v) => {
                let raw = v
                    .as_str()
                    .ok_or("'session_mode' must be a string: isolated | named")?;
                Some(HeadlessSessionMode::parse(raw)?)
            }
        };

        let model_id = match args.get("model_id") {
            None => None,
            Some(v) => Some(
                v.as_str()
                    .ok_or("'model_id' must be a string")?
                    .trim()
                    .to_string(),
            )
            .filter(|value| !value.is_empty()),
        };

        if action_type == AutomationActionType::Notify
            && (agent_prompt.is_some() || session_mode.is_some() || model_id.is_some())
        {
            return Err(
                "agent_prompt / session_mode / model_id are only valid when action_type is 'agent_turn'"
                    .to_string(),
            );
        }

        Ok((agent_prompt, session_mode, model_id))
    }

    fn execute_propose(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, PROPOSE_ALLOWED_KEYS)?;

        let name = Self::parse_required_string(args, "name")?;
        let prompt = Self::parse_required_string(args, "prompt")?;
        validate_automation_fields(&name, &prompt).map_err(|e| e.to_string())?;

        let schedule_value = args.get("schedule").ok_or("'schedule' is required")?;
        let schedule = Self::parse_schedule(schedule_value)?;

        let enabled = match args.get("enabled") {
            None => true,
            Some(value) => value.as_bool().ok_or("'enabled' must be a boolean")?,
        };

        let action_type = Self::parse_action_type(args)?;
        let (agent_prompt, session_mode, model_id) = Self::parse_agent_fields(args, action_type)?;
        let catch_up_policy = Self::parse_catch_up_policy(args, true)?.unwrap_or_default();
        let max_retries = Self::parse_optional_u64(args, "max_retries", 0, 10)?
            .unwrap_or(DEFAULT_MAX_RETRIES as u64) as u8;
        let retry_backoff_seconds =
            Self::parse_optional_u64(args, "retry_backoff_seconds", 5, 86_400)?
                .unwrap_or(DEFAULT_RETRY_BACKOFF_SECS);
        let timeout_seconds = Self::parse_optional_u64(args, "timeout_seconds", 30, 3_600)?
            .unwrap_or(DEFAULT_TIMEOUT_SECS);
        let trusted_profile = args
            .get("trusted_profile")
            .map(|value| serde_json::from_value::<TrustedAutomationProfile>(value.clone()))
            .transpose()
            .map_err(|error| format!("Invalid trusted_profile: {error}"))?;

        Self::with_database(ctx, |db| {
            let definition = create_automation(
                db,
                AutomationCreateFields {
                    name: name.clone(),
                    schedule: schedule.clone(),
                    prompt: prompt.clone(),
                    enabled,
                    action_type,
                    heartbeat: false,
                    agent_prompt: agent_prompt.clone(),
                    session_mode,
                    model_id: model_id.clone(),
                    catch_up_policy,
                    max_retries,
                    retry_backoff_seconds,
                    timeout_seconds,
                    trusted_profile: trusted_profile.clone(),
                    source_session_id: ctx.session_id.clone(),
                },
            )
            .map_err(|error| error.to_string())?;
            let id = definition.id;
            let version = definition.version;
            emit_automations_changed(ctx.window_ref().app_handle(), "create", &id);

            let now_local = Local::now();
            let next_trigger_dt = compute_next_trigger(&schedule, now_local).ok();
            let next_trigger = next_trigger_dt
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "unknown".to_string());
            let next_trigger_relative = next_trigger_dt
                .map(|dt| describe_relative_time(dt, now_local));
            let schedule_description = describe_schedule(&schedule);

            let behavior = match action_type {
                AutomationActionType::Notify => {
                    "At the scheduled time the app will send a system notification and create a todo reminder; it will not run an agent task automatically."
                }
                AutomationActionType::AgentTurn => {
                    "At the scheduled time the app will run a headless agent turn in an isolated session (frontend-bridge tools, ask_user and high-sensitivity tools are unavailable), then send a system notification with the result summary."
                }
            };

            Ok(json!({
                "status": "created",
                "id": id,
                "name": name,
                "enabled": enabled,
                "action_type": action_type,
                "session_mode": session_mode.unwrap_or_default(),
                "model_id": model_id,
                "schedule": schedule,
                "schedule_description": &schedule_description,
                "next_trigger_at": next_trigger,
                "next_trigger_relative": &next_trigger_relative,
                "message": format!(
                    "Automation '{}' created ({}). First run: {}. {} Use automation_list to review or automation_set_enabled to disable.",
                    name,
                    schedule_description,
                    next_trigger_relative.as_deref().unwrap_or("unknown"),
                    behavior
                ),
                "storage": "automation_definitions",
                "previous": Value::Null,
                "reversible": false,
                "reversibleWithApproval": true,
                "restoreWith": {
                    "tool": tool_names::AUTOMATION_DELETE,
                    "arguments": { "id": id, "expected_version": version }
                },
                "undoReason": "Deleting a created automation is High risk and requires fresh user confirmation.",
            }))
        })
    }

    fn execute_list(ctx: &ExecutionContext) -> Result<Value, String> {
        Self::with_database(ctx, |db| {
            let mut response = automation_agent_list_response(db).map_err(|e| e.to_string())?;
            let now = Local::now();
            if let Some(items) = response
                .get_mut("automations")
                .and_then(Value::as_array_mut)
            {
                for item in items.iter_mut() {
                    // 下次运行相对描述（模型可直接转述"约 2 小时后"）
                    let relative = item
                        .get("next_trigger_at")
                        .and_then(Value::as_str)
                        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
                        .map(|dt| describe_relative_time(dt.with_timezone(&Local), now));
                    item["next_trigger_relative"] = match relative {
                        Some(text) => json!(text),
                        None => Value::Null,
                    };

                    // 人话调度描述 + once 已完成标记
                    if let Ok(schedule) =
                        serde_json::from_value::<AutomationSchedule>(item["schedule"].clone())
                    {
                        item["schedule_description"] = json!(describe_schedule(&schedule));
                        if schedule.kind == ScheduleKind::Once {
                            let has_run = item
                                .get("last_run_at")
                                .and_then(Value::as_str)
                                .is_some();
                            let no_next = item
                                .get("next_trigger_at")
                                .and_then(Value::as_str)
                                .map(|raw| raw == "unknown")
                                .unwrap_or(true);
                            item["once_completed"] = json!(has_run && no_next);
                        }
                    }

                    // 上次运行状态（取该自动化最近一条运行记录）
                    let id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if let Some(id) = id {
                        if item.get("last_run_at").and_then(Value::as_str).is_some() {
                            if let Ok((runs, _)) =
                                list_automation_runs_page(db, Some(&id), 1, 0)
                            {
                                if let Some(run) = runs.first() {
                                    item["last_run_status"] = json!(run.status);
                                    item["last_run_summary"] = json!(run.summary);
                                    item["last_run_error"] = json!(run.error);
                                }
                            }
                        }
                    }
                }
            }
            // 容量提示：count/max 顶层字段已有，补一条人话描述方便模型转述
            if let (Some(count), Some(max)) = (
                response.get("count").and_then(Value::as_u64),
                response.get("max").and_then(Value::as_u64),
            ) {
                response["capacity"] = json!(format!(
                    "{}/{} 已使用，还可创建 {} 条",
                    count,
                    max,
                    max.saturating_sub(count)
                ));
            }
            Ok(response)
        })
    }

    fn execute_set_enabled(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, SET_ENABLED_ALLOWED_KEYS)?;

        let id = Self::parse_required_string(args, "id")?;
        let expected_version = Self::parse_required_version(args)?;
        let enabled = args
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or("'enabled' is required and must be a boolean")?;

        Self::with_database(ctx, |db| {
            let (previous, current) = set_automation_enabled(db, &id, expected_version, enabled)
                .map_err(|error| serialize_automation_update_error(error, true))?;
            emit_automations_changed(ctx.window_ref().app_handle(), "set_enabled", &id);

            let now = Local::now();
            let next_trigger = compute_next_trigger(&current.schedule, now)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|_| "unknown".to_string());

            Ok(json!({
                "success": true,
                "status": if enabled { "enabled" } else { "disabled" },
                "id": id,
                "name": current.name,
                "enabled": enabled,
                "next_trigger_at": next_trigger,
                "previous": automation_to_agent_list_item(&previous, Local::now()),
                "current": automation_to_agent_list_item(&current, Local::now()),
                "reversible": true,
                "restoreWith": {
                    "tool": tool_names::AUTOMATION_SET_ENABLED,
                    "arguments": {
                        "id": id,
                        "expected_version": current.version,
                        "enabled": previous.enabled
                    }
                },
                "message": format!(
                    "Automation '{}' is now {}.",
                    current.name,
                    if enabled { "enabled" } else { "disabled" }
                ),
            }))
        })
    }

    fn execute_update(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, UPDATE_ALLOWED_KEYS)?;
        let id = Self::parse_required_string(args, "id")?;
        let expected_version = Self::parse_required_version(args)?;
        let name = args
            .get("name")
            .map(|_| Self::parse_required_string(args, "name"))
            .transpose()?;
        let schedule = args.get("schedule").map(Self::parse_schedule).transpose()?;
        let prompt = args
            .get("prompt")
            .map(|_| Self::parse_required_string(args, "prompt"))
            .transpose()?;
        let action_type = Self::parse_optional_action_type(args)?;
        let agent_prompt = Self::parse_nullable_string(args, "agent_prompt", Some(MAX_PROMPT_LEN))?;
        let session_mode = Self::parse_nullable_session_mode(args)?;
        let model_id = Self::parse_nullable_string(args, "model_id", None)?;
        let catch_up_policy = Self::parse_catch_up_policy(args, false)?;
        let max_retries = Self::parse_optional_u64(args, "max_retries", 0, 10)?.map(|v| v as u8);
        let retry_backoff_seconds =
            Self::parse_optional_u64(args, "retry_backoff_seconds", 5, 86_400)?;
        let timeout_seconds = Self::parse_optional_u64(args, "timeout_seconds", 30, 3_600)?;
        let trusted_profile = args
            .get("trusted_profile")
            .map(|value| {
                if value.is_null() {
                    Ok(None)
                } else {
                    serde_json::from_value::<TrustedAutomationProfile>(value.clone())
                        .map(Some)
                        .map_err(|error| format!("Invalid trusted_profile: {error}"))
                }
            })
            .transpose()?;
        Self::with_database(ctx, |db| {
            let (previous, current) = update_automation_full(
                db,
                &id,
                expected_version,
                AutomationUpdateFields {
                    name,
                    schedule,
                    prompt,
                    action_type,
                    agent_prompt,
                    session_mode,
                    model_id,
                    catch_up_policy,
                    max_retries,
                    retry_backoff_seconds,
                    timeout_seconds,
                    trusted_profile,
                },
            )
            .map_err(|error| serialize_automation_update_error(error, true))?;
            let next_trigger = compute_next_trigger(&current.schedule, Local::now())
                .map(|value| value.to_rfc3339())
                .map_err(|error| error.to_string())?;
            emit_automations_changed(ctx.window_ref().app_handle(), "update", &id);
            let previous_prompt = crate::chat_v2::automations::effective_agent_prompt(&previous);
            let directly_reversible = previous_prompt.chars().count() <= 2_000;
            Ok(json!({
                "success": true,
                "automation": automation_to_agent_list_item(&current, Local::now()),
                "previous": automation_to_agent_list_item(&previous, Local::now()),
                "current": automation_to_agent_list_item(&current, Local::now()),
                "nextTriggerAt": next_trigger,
                "reversible": directly_reversible,
                "restoreWith": directly_reversible.then(|| json!({
                    "tool": tool_names::AUTOMATION_UPDATE,
                    "arguments": {
                        "id": id,
                        "expected_version": current.version,
                        "name": previous.name,
                        "schedule": previous.schedule,
                        "prompt": previous.prompt,
                        "action_type": previous.action_type,
                        "agent_prompt": previous.agent_prompt,
                        "session_mode": previous.session_mode,
                        "model_id": previous.model_id,
                        "catch_up_policy": previous.catch_up_policy,
                        "max_retries": previous.max_retries,
                        "retry_backoff_seconds": previous.retry_backoff_seconds,
                        "timeout_seconds": previous.timeout_seconds
                    }
                })),
                "undoReason": (!directly_reversible).then_some("旧提示词超过 Agent 返回上限，无法在不泄漏/截断内容的情况下生成精确撤销参数"),
            }))
        })
    }

    fn execute_delete(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, ID_VERSION_ALLOWED_KEYS)?;
        let id = Self::parse_required_string(args, "id")?;
        let expected_version = Self::parse_required_version(args)?;
        Self::with_database(ctx, |db| {
            let deleted = delete_automation(db, &id, expected_version)
                .map_err(|error| serialize_automation_update_error(error, true))?;
            emit_automations_changed(ctx.window_ref().app_handle(), "delete", &id);
            Ok(json!({
                "success": true,
                "automationId": id,
                "deleted": automation_to_agent_list_item(&deleted, Local::now()),
                "previous": automation_to_agent_list_item(&deleted, Local::now()),
                "reversible": false,
                "restoreWith": Value::Null,
            }))
        })
    }

    fn execute_run_now(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, ID_VERSION_ALLOWED_KEYS)?;
        let id = Self::parse_required_string(args, "id")?;
        let expected_version = Self::parse_required_version(args)?;
        let output = run_automation_now_core(
            &id,
            expected_version,
            ctx.window_ref().app_handle().clone(),
            Self::database_arc(ctx),
            true,
        )?;
        Ok(json!({
            "success": true,
            "result": output,
            "previous": Value::Null,
            "reversible": false,
            "restoreWith": Value::Null,
        }))
    }

    fn execute_runs(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, RUNS_ALLOWED_KEYS)?;
        let automation_id = match args.get("automation_id") {
            None | Some(Value::Null) => None,
            Some(_) => Some(Self::parse_required_string(args, "automation_id")?),
        };
        let status = match args.get("status") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let raw = value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        format!("'status' must be one of: {}", RUN_STATUS_VALUES.join(", "))
                    })?
                    .to_ascii_lowercase();
                if !RUN_STATUS_VALUES.contains(&raw.as_str()) {
                    return Err(format!(
                        "Invalid status '{}'. Allowed: {}",
                        raw,
                        RUN_STATUS_VALUES.join(", ")
                    ));
                }
                Some(raw)
            }
        };
        let page =
            Self::parse_optional_u64(args, "page", 1, i64::MAX as u64)?.unwrap_or(1) as usize;
        let page_size = Self::parse_optional_u64(args, "page_size", 1, 20)?.unwrap_or(20) as usize;
        let offset = page.saturating_sub(1).saturating_mul(page_size);
        Self::with_database(ctx, |db| {
            let (runs, total) =
                list_automation_runs_page(db, automation_id.as_deref(), page_size, offset)
                    .map_err(|error| error.to_string())?;
            let has_more = offset.saturating_add(page_size) < total;
            // 状态过滤在当前页内进行（total/hasMore 仍以未过滤计），schema 中已向模型说明
            let (runs, filtered_note) = match status.as_deref() {
                None => (runs, None),
                Some(status) => {
                    let filtered: Vec<_> = runs
                        .into_iter()
                        .filter(|run| run.status.as_deref() == Some(status))
                        .collect();
                    (
                        filtered,
                        Some("status filter applied within this page; page through for more matches"),
                    )
                }
            };
            let returned = runs.len();
            Ok(json!({
                "runs": runs,
                "returned": returned,
                "total": total,
                "page": page,
                "pageSize": page_size,
                "hasMore": has_more,
                "statusFilter": status,
                "note": filtered_note,
            }))
        })
    }

    fn execute_retry_run(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, ID_ONLY_ALLOWED_KEYS)?;
        let id = Self::parse_required_string(args, "id")?;
        Self::with_database(ctx, |db| {
            retry_automation_run(db, &id).map_err(|error| error.to_string())?;
            emit_automations_changed(ctx.window_ref().app_handle(), "retry", "");
            Ok(json!({ "success": true, "runId": id, "reversible": false }))
        })
    }

    fn execute_cancel_run(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, ID_ONLY_ALLOWED_KEYS)?;
        let id = Self::parse_required_string(args, "id")?;
        Self::with_database(ctx, |db| {
            cancel_automation_run(db, &id).map_err(|error| error.to_string())?;
            emit_automations_changed(ctx.window_ref().app_handle(), "cancel_run", "");
            Ok(json!({ "success": true, "runId": id, "reversible": false }))
        })
    }
}

impl Default for AutomationExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for AutomationExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            Self::strip_namespace(tool_name),
            tool_names::AUTOMATION_PROPOSE
                | tool_names::AUTOMATION_LIST
                | tool_names::AUTOMATION_SET_ENABLED
                | tool_names::AUTOMATION_UPDATE
                | tool_names::AUTOMATION_DELETE
                | tool_names::AUTOMATION_RUN_NOW
                | tool_names::AUTOMATION_RUNS
                | tool_names::AUTOMATION_RETRY_RUN
                | tool_names::AUTOMATION_CANCEL_RUN
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let tool_name = Self::strip_namespace(&call.name);
        let result = match tool_name {
            tool_names::AUTOMATION_PROPOSE => Self::execute_propose(&call.arguments, ctx),
            tool_names::AUTOMATION_LIST => {
                if call.arguments.as_object().is_some_and(|o| !o.is_empty()) {
                    Err("automation_list accepts no arguments".to_string())
                } else {
                    Self::execute_list(ctx)
                }
            }
            tool_names::AUTOMATION_SET_ENABLED => Self::execute_set_enabled(&call.arguments, ctx),
            tool_names::AUTOMATION_UPDATE => Self::execute_update(&call.arguments, ctx),
            tool_names::AUTOMATION_DELETE => Self::execute_delete(&call.arguments, ctx),
            tool_names::AUTOMATION_RUN_NOW => Self::execute_run_now(&call.arguments, ctx),
            tool_names::AUTOMATION_RUNS => Self::execute_runs(&call.arguments, ctx),
            tool_names::AUTOMATION_RETRY_RUN => Self::execute_retry_run(&call.arguments, ctx),
            tool_names::AUTOMATION_CANCEL_RUN => Self::execute_cancel_run(&call.arguments, ctx),
            _ => Err(format!("Unknown automation tool: {}", call.name)),
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
                let tool_result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                );
                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("[AutomationExecutor] Failed to save tool block: {}", e);
                }
                Ok(tool_result)
            }
            Err(error) => {
                let error = friendly_automation_error(error);
                ctx.emit_tool_call_error(&error);
                let tool_result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                );
                if let Err(e) = ctx.save_tool_block(&tool_result) {
                    log::warn!("[AutomationExecutor] Failed to save tool block: {}", e);
                }
                Ok(tool_result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match Self::strip_namespace(tool_name) {
            tool_names::AUTOMATION_PROPOSE | tool_names::AUTOMATION_DELETE => ToolSensitivity::High,
            tool_names::AUTOMATION_SET_ENABLED
            | tool_names::AUTOMATION_UPDATE
            | tool_names::AUTOMATION_RUN_NOW
            | tool_names::AUTOMATION_RETRY_RUN
            | tool_names::AUTOMATION_CANCEL_RUN => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "AutomationExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_propose_fields() {
        let err = AutomationExecutor::reject_unknown_fields(
            &json!({
                "name": "n",
                "schedule": { "kind": "daily", "time": "09:00" },
                "prompt": "p",
                "extra": true
            }),
            PROPOSE_ALLOWED_KEYS,
        )
        .unwrap_err();
        assert!(err.contains("Unknown field"));
    }

    #[test]
    fn rejects_invalid_schedule_time() {
        let err = AutomationExecutor::parse_schedule(&json!({
            "kind": "daily",
            "time": "9:00"
        }))
        .unwrap_err();
        assert!(err.contains("HH:MM") || err.contains("Invalid time"));
    }

    #[test]
    fn rejects_weekly_without_weekday() {
        let err = AutomationExecutor::parse_schedule(&json!({
            "kind": "weekly",
            "time": "09:00"
        }))
        .unwrap_err();
        assert!(err.contains("weekday"));
    }

    #[test]
    fn parses_interval_schedule_without_time() {
        let schedule = AutomationExecutor::parse_schedule(&json!({
            "kind": "interval",
            "interval_minutes": 30
        }))
        .expect("interval schedule parses");
        assert_eq!(schedule.kind, ScheduleKind::Interval);
        assert_eq!(schedule.interval_minutes, Some(30));
    }

    #[test]
    fn parses_monthly_and_weekday_schedules_with_timezone() {
        let monthly = AutomationExecutor::parse_schedule(&json!({
            "kind": "monthly",
            "time": "09:00",
            "day_of_month": 31,
            "timezone": "Asia/Shanghai"
        }))
        .unwrap();
        assert_eq!(monthly.kind, ScheduleKind::Monthly);
        assert_eq!(monthly.day_of_month, Some(31));
        assert_eq!(monthly.timezone.as_deref(), Some("Asia/Shanghai"));

        let weekdays = AutomationExecutor::parse_schedule(&json!({
            "kind": "weekdays",
            "time": "08:30",
            "timezone": "UTC"
        }))
        .unwrap();
        assert_eq!(weekdays.kind, ScheduleKind::Weekdays);
    }

    #[test]
    fn rejects_interval_without_minutes() {
        let err = AutomationExecutor::parse_schedule(&json!({
            "kind": "interval"
        }))
        .unwrap_err();
        assert!(err.contains("interval_minutes"));
    }

    #[test]
    fn parses_once_schedule_with_date() {
        let schedule = AutomationExecutor::parse_schedule(&json!({
            "kind": "once",
            "time": "09:00",
            "date": "2099-01-02"
        }))
        .expect("once schedule parses");
        assert_eq!(schedule.kind, ScheduleKind::Once);
        assert_eq!(schedule.date.as_deref(), Some("2099-01-02"));
    }

    #[test]
    fn rejects_once_schedule_without_date() {
        let err = AutomationExecutor::parse_schedule(&json!({
            "kind": "once",
            "time": "09:00"
        }))
        .unwrap_err();
        assert!(err.contains("date"));
    }

    #[test]
    fn describes_schedules_in_natural_language() {
        let daily = AutomationExecutor::parse_schedule(&json!({
            "kind": "daily",
            "time": "21:00"
        }))
        .unwrap();
        assert!(describe_schedule(&daily).contains("每天 21:00"));

        let once = AutomationExecutor::parse_schedule(&json!({
            "kind": "once",
            "time": "09:00",
            "date": "2099-01-02"
        }))
        .unwrap();
        let text = describe_schedule(&once);
        assert!(text.contains("2099-01-02"));
        assert!(text.contains("一次"));
    }

    #[test]
    fn friendly_error_adds_hint_for_known_codes() {
        let raw = json!({
            "code": AUTOMATION_VERSION_CONFLICT_CODE,
            "message": "conflict"
        })
        .to_string();
        let enriched: Value = serde_json::from_str(&friendly_automation_error(raw)).unwrap();
        assert!(enriched["hint"]
            .as_str()
            .unwrap()
            .contains("automation_list"));

        let raw = json!({
            "code": AUTOMATION_RUN_ALREADY_ACTIVE_CODE,
            "message": "active"
        })
        .to_string();
        let enriched: Value = serde_json::from_str(&friendly_automation_error(raw)).unwrap();
        assert!(enriched["hint"].as_str().unwrap().contains("automation_runs"));

        let plain = friendly_automation_error("Automation limit reached (max 20)".to_string());
        assert!(plain.contains("automation_list"));
    }

    #[test]
    fn parses_action_type_with_default_notify() {
        assert_eq!(
            AutomationExecutor::parse_action_type(&json!({})).unwrap(),
            AutomationActionType::Notify
        );
        assert_eq!(
            AutomationExecutor::parse_action_type(&json!({ "action_type": "agent_turn" })).unwrap(),
            AutomationActionType::AgentTurn
        );
        assert_eq!(
            AutomationExecutor::parse_action_type(&json!({ "action_type": "notify" })).unwrap(),
            AutomationActionType::Notify
        );
        assert!(AutomationExecutor::parse_action_type(&json!({ "action_type": "bogus" })).is_err());
        assert!(AutomationExecutor::parse_action_type(&json!({ "action_type": 1 })).is_err());
    }

    #[test]
    fn parses_agent_fields_for_agent_turn() {
        let (agent_prompt, session_mode, model_id) = AutomationExecutor::parse_agent_fields(
            &json!({
                "agent_prompt": "检查到期复习卡并生成今日复习简报",
                "session_mode": "named",
                "model_id": "builtin-deepseek-chat"
            }),
            AutomationActionType::AgentTurn,
        )
        .expect("agent fields parse");
        assert_eq!(
            agent_prompt.as_deref(),
            Some("检查到期复习卡并生成今日复习简报")
        );
        assert_eq!(session_mode, Some(HeadlessSessionMode::Named));
        assert_eq!(model_id.as_deref(), Some("builtin-deepseek-chat"));
    }

    #[test]
    fn rejects_agent_fields_for_notify_action() {
        let err = AutomationExecutor::parse_agent_fields(
            &json!({ "agent_prompt": "p" }),
            AutomationActionType::Notify,
        )
        .unwrap_err();
        assert!(err.contains("agent_turn"));
    }

    #[test]
    fn rejects_invalid_session_mode() {
        let err = AutomationExecutor::parse_agent_fields(
            &json!({ "session_mode": "shared" }),
            AutomationActionType::AgentTurn,
        )
        .unwrap_err();
        assert!(err.contains("session_mode") || err.contains("isolated"));
    }

    #[test]
    fn blank_agent_prompt_falls_back_to_none() {
        let (agent_prompt, _, _) = AutomationExecutor::parse_agent_fields(
            &json!({ "agent_prompt": "  " }),
            AutomationActionType::AgentTurn,
        )
        .expect("blank agent_prompt is treated as absent");
        assert!(agent_prompt.is_none());
    }

    #[test]
    fn update_requires_a_positive_expected_version() {
        let missing = AutomationExecutor::parse_required_version(&json!({
            "id": "auto_test",
            "name": "Renamed"
        }))
        .unwrap_err();
        assert!(missing.contains("expected_version"));
        assert!(missing.contains("automation_list"));

        assert!(AutomationExecutor::parse_required_version(&json!({
            "expected_version": 0
        }))
        .is_err());
        assert_eq!(
            AutomationExecutor::parse_required_version(&json!({
                "expected_version": 7
            }))
            .unwrap(),
            7
        );
    }

    #[test]
    fn update_parsers_preserve_missing_and_clear_empty_values() {
        assert_eq!(
            AutomationExecutor::parse_nullable_string(&json!({}), "model_id", None).unwrap(),
            None
        );
        assert_eq!(
            AutomationExecutor::parse_nullable_string(
                &json!({ "model_id": "" }),
                "model_id",
                None,
            )
            .unwrap(),
            Some(None)
        );
        assert_eq!(
            AutomationExecutor::parse_nullable_session_mode(&json!({ "session_mode": null }))
                .unwrap(),
            Some(None)
        );
        assert_eq!(
            AutomationExecutor::parse_catch_up_policy(
                &json!({ "catch_up_policy": "catch_up_all" }),
                false,
            )
            .unwrap(),
            Some(CatchUpPolicy::CatchUpAll)
        );
    }

    #[test]
    fn handles_expected_tool_names() {
        let executor = AutomationExecutor::new();
        assert!(executor.can_handle("automation_propose"));
        assert!(executor.can_handle("builtin-automation_list"));
        assert!(executor.can_handle("builtin-automation_set_enabled"));
        assert!(executor.can_handle("automation_update"));
        assert!(executor.can_handle("builtin-automation_delete"));
        assert!(executor.can_handle("builtin-automation_run_now"));
        assert!(executor.can_handle("builtin-automation_runs"));
        assert!(executor.can_handle("builtin-automation_retry_run"));
        assert!(executor.can_handle("builtin-automation_cancel_run"));
    }

    #[test]
    fn sensitivity_levels() {
        let executor = AutomationExecutor::new();
        assert_eq!(
            executor.sensitivity_level("automation_propose"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("automation_set_enabled"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("automation_list"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("automation_update"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("automation_run_now"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("automation_delete"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("automation_runs"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("automation_retry_run"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("automation_cancel_run"),
            ToolSensitivity::Medium
        );
    }

    #[test]
    fn missing_expected_version_returns_structured_occ_required_error() {
        let error: Value = serde_json::from_str(
            &AutomationExecutor::parse_required_version(&json!({}))
                .expect_err("missing version must fail"),
        )
        .expect("structured OCC error");
        assert_eq!(error["code"], AUTOMATION_OCC_REQUIRED_CODE);
        assert_eq!(error["requiredField"], "expected_version");
        assert_eq!(error["retryable"], false);
    }
}
