//! automation_propose / automation_list / automation_set_enabled 工具执行器

use std::time::Instant;

use async_trait::async_trait;
use chrono::{Local, Utc};
use serde_json::{json, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::automations::{
    automation_to_list_item, compute_next_trigger, generate_automation_id, load_automations,
    save_automations, validate_automation_fields, validate_schedule, with_automations_lock,
    AutomationActionType, AutomationDefinition, AutomationSchedule, MAX_AUTOMATIONS, MAX_PROMPT_LEN,
    ScheduleKind,
};
use crate::chat_v2::headless::HeadlessSessionMode;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;
use crate::database::Database;

pub mod tool_names {
    pub const AUTOMATION_PROPOSE: &str = "automation_propose";
    pub const AUTOMATION_LIST: &str = "automation_list";
    pub const AUTOMATION_SET_ENABLED: &str = "automation_set_enabled";
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
];
const SET_ENABLED_ALLOWED_KEYS: &[&str] = &["id", "enabled"];
const SCHEDULE_ALLOWED_KEYS: &[&str] = &["kind", "time", "weekday", "interval_minutes"];

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
        let state = ctx.window.state::<AppState>();
        f(&state.database)
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
            "interval" => ScheduleKind::Interval,
            other => {
                return Err(format!(
                    "Invalid schedule.kind '{}'. Allowed: daily, weekly, interval",
                    other
                ))
            }
        };

        // interval 调度不需要 time；daily/weekly 必填
        let time = match obj.get("time").and_then(Value::as_str) {
            Some(t) => t.trim().to_string(),
            None if kind == ScheduleKind::Interval => String::new(),
            None => return Err("'schedule.time' is required (HH:MM, 24h)".to_string()),
        };

        let weekday = match obj.get("weekday") {
            None => None,
            Some(v) => {
                let n = v
                    .as_u64()
                    .ok_or("'schedule.weekday' must be an integer 0-6")?;
                if n > 6 {
                    return Err("'schedule.weekday' must be between 0 (Sunday) and 6 (Saturday)".to_string());
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
                Some(u32::try_from(n).map_err(|_| {
                    "'schedule.interval_minutes' is out of range".to_string()
                })?)
            }
        };

        let schedule = AutomationSchedule {
            kind,
            time,
            weekday,
            interval_minutes,
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
            Some(v) => v
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
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

        let schedule_value = args
            .get("schedule")
            .ok_or("'schedule' is required")?;
        let schedule = Self::parse_schedule(schedule_value)?;

        let enabled = args
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let action_type = Self::parse_action_type(args)?;
        let (agent_prompt, session_mode, model_id) = Self::parse_agent_fields(args, action_type)?;

        Self::with_database(ctx, |db| {
            // 🔧 P1-1 修复：load → 上限检查 → push → save 整段持自动化存储互斥锁，
            // 消除与调度器 last_run_at 回写的丢失更新，以及 MAX 上限的 TOCTOU
            let id = with_automations_lock(|| -> Result<String, String> {
                let mut automations = load_automations(db).map_err(|e| e.to_string())?;
                if automations.len() >= MAX_AUTOMATIONS {
                    return Err(format!(
                        "Automation limit reached (max {}). Disable or remove an existing automation first.",
                        MAX_AUTOMATIONS
                    ));
                }

                let now_utc = Utc::now();
                let id = generate_automation_id(now_utc);
                let definition = AutomationDefinition {
                    id: id.clone(),
                    name: name.clone(),
                    schedule: schedule.clone(),
                    prompt: prompt.clone(),
                    enabled,
                    created_at: now_utc.to_rfc3339(),
                    session_id: ctx.session_id.clone(),
                    last_run_at: None,
                    action_type,
                    heartbeat: false,
                    agent_prompt: agent_prompt.clone(),
                    session_mode,
                    model_id: model_id.clone(),
                    agent_session_id: None,
                };

                automations.push(definition);
                save_automations(db, &automations).map_err(|e| e.to_string())?;
                Ok(id)
            })?;

            let now_local = Local::now();
            let next_trigger = compute_next_trigger(&schedule, now_local)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|_| "unknown".to_string());

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
                "next_trigger_at": next_trigger,
                "message": format!(
                    "Automation '{}' created. {} Use automation_list to review or automation_set_enabled to disable.",
                    name, behavior
                ),
                "settings_key": "chat_v2.automations",
            }))
        })
    }

    fn execute_list(ctx: &ExecutionContext) -> Result<Value, String> {
        Self::with_database(ctx, |db| {
            let automations = load_automations(db).map_err(|e| e.to_string())?;
            let now = Local::now();
            let items: Vec<Value> = automations
                .iter()
                .map(|a| automation_to_list_item(a, now))
                .collect();
            Ok(json!({
                "count": items.len(),
                "max": MAX_AUTOMATIONS,
                "automations": items,
            }))
        })
    }

    fn execute_set_enabled(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        Self::reject_unknown_fields(args, SET_ENABLED_ALLOWED_KEYS)?;

        let id = Self::parse_required_string(args, "id")?;
        let enabled = args
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or("'enabled' is required and must be a boolean")?;

        Self::with_database(ctx, |db| {
            // 🔧 P1-1 修复：load → 改 enabled → save 整段持自动化存储互斥锁，
            // 避免与调度器回写竞争导致「停用失效、自动化继续触发」
            let (name, schedule) = with_automations_lock(|| -> Result<_, String> {
                let mut automations = load_automations(db).map_err(|e| e.to_string())?;
                let item = automations
                    .iter_mut()
                    .find(|a| a.id == id)
                    .ok_or_else(|| format!("Automation '{}' not found", id))?;

                item.enabled = enabled;
                let name = item.name.clone();
                let schedule = item.schedule.clone();
                save_automations(db, &automations).map_err(|e| e.to_string())?;
                Ok((name, schedule))
            })?;

            let now = Local::now();
            let next_trigger = compute_next_trigger(&schedule, now)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|_| "unknown".to_string());

            Ok(json!({
                "status": if enabled { "enabled" } else { "disabled" },
                "id": id,
                "name": name,
                "enabled": enabled,
                "next_trigger_at": next_trigger,
                "message": format!(
                    "Automation '{}' is now {}.",
                    name,
                    if enabled { "enabled" } else { "disabled" }
                ),
            }))
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
                if call.arguments.as_object().map_or(false, |o| !o.is_empty()) {
                    Err("automation_list accepts no arguments".to_string())
                } else {
                    Self::execute_list(ctx)
                }
            }
            tool_names::AUTOMATION_SET_ENABLED => Self::execute_set_enabled(&call.arguments, ctx),
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
            tool_names::AUTOMATION_PROPOSE => ToolSensitivity::High,
            tool_names::AUTOMATION_SET_ENABLED => ToolSensitivity::Medium,
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
    fn rejects_interval_without_minutes() {
        let err = AutomationExecutor::parse_schedule(&json!({
            "kind": "interval"
        }))
        .unwrap_err();
        assert!(err.contains("interval_minutes"));
    }

    #[test]
    fn parses_action_type_with_default_notify() {
        assert_eq!(
            AutomationExecutor::parse_action_type(&json!({})).unwrap(),
            AutomationActionType::Notify
        );
        assert_eq!(
            AutomationExecutor::parse_action_type(&json!({ "action_type": "agent_turn" }))
                .unwrap(),
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
    fn handles_expected_tool_names() {
        let executor = AutomationExecutor::new();
        assert!(executor.can_handle("automation_propose"));
        assert!(executor.can_handle("builtin-automation_list"));
        assert!(executor.can_handle("builtin-automation_set_enabled"));
        assert!(!executor.can_handle("automation_delete"));
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
    }

}
