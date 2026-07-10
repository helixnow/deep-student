//! Chat V2 周期自动化：定义存储、到期判定与后台调度器。
//!
//! v1：到点发送系统通知 + 创建带 reminder 的用户待办。
//! v2（2026-07-08）：新增 `action_type: notify | agent_turn`——`agent_turn`
//! 到点在隔离会话上真跑一轮 headless agent（见 `chat_v2/headless.rs`），
//! 完成后发系统通知（成功/失败摘要）；另内置可选的 Heartbeat 心跳自动化
//! （interval 调度，模型无事输出 `HEARTBEAT_OK` 时静默吞掉不打扰用户）。
//!
//! 存储说明：自动化定义存于 settings 表 `chat_v2.automations` 单 key 的 JSON，
//! 因此"表结构迁移"即 serde 向后兼容——所有新增字段带 `#[serde(default)]`，
//! 旧记录反序列化自动落到默认值（notify / 非心跳），天然幂等。

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use chrono::{DateTime, Datelike, Local, NaiveTime, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::time::{sleep, Duration};

use crate::chat_v2::headless::{
    run_headless_turn, HeadlessSessionMode, HeadlessTurnRequest,
};
use crate::database::Database;
use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsTodoRepo;
use crate::vfs::types::VfsCreateTodoItemParams;

pub const AUTOMATIONS_KEY: &str = "chat_v2.automations";
pub const AUTOMATION_RUNS_KEY: &str = "chat_v2.automation_runs";

pub const MAX_AUTOMATIONS: usize = 20;
pub const MAX_PROMPT_LEN: usize = 4000;
pub const MAX_NAME_LEN: usize = 100;
pub const MAX_RUN_HISTORY: usize = 50;

/// agent_turn 类型自动化单次运行超时（秒）
pub const AGENT_TURN_TIMEOUT_SECS: u64 = 600;

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

/// 🔧 P1-1 修复（08 报告）：`chat_v2.automations` / `chat_v2.automation_runs`
/// 存于 settings 表单一 key 的整表 JSON，所有写路径都是「load → 改内存 → save 全量覆盖」。
/// 调度器（每 60s 回写 last_run_at）与工具执行器（propose / set_enabled）并发时
/// 会互相覆盖：刚审批通过的自动化凭空消失、last_run_at 丢失导致重复通知、停用失效。
/// 单进程内所有读改写序列必须持同一把锁。
static AUTOMATIONS_STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 在自动化存储互斥锁内执行读改写序列。
///
/// 注意：不可重入 —— 闭包内不得再调用任何自身也加锁的复合操作
/// （`update_automation_last_run_at` / `append_automation_run` 已各自加锁）。
pub fn with_automations_lock<T>(f: impl FnOnce() -> T) -> T {
    let _guard = AUTOMATIONS_STORE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    Daily,
    Weekly,
    /// 周期间隔调度（每 N 分钟），供心跳等场景使用
    Interval,
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
    /// 间隔分钟数（kind=interval 必填，范围 5–1440）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
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
    pub automation_id: String,
    pub fired_at: String,
    pub delivered: Vec<String>,
    /// agent_turn 运行产生的隔离会话 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 运行结果状态（success / error / timeout / heartbeat_ok / spawn_error）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

pub fn parse_time_hhmm(raw: &str) -> Result<NaiveTime> {
    NaiveTime::parse_from_str(raw.trim(), "%H:%M").map_err(|_| {
        AppError::validation(format!("Invalid time '{}': expected HH:MM (24h)", raw))
    })
}

pub fn validate_schedule(schedule: &AutomationSchedule) -> Result<()> {
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
        }
        ScheduleKind::Weekly => {
            parse_time_hhmm(&schedule.time)?;
            let weekday = schedule.weekday.ok_or_else(|| {
                AppError::validation("weekday is required for weekly schedule (0=Sun … 6=Sat)".to_string())
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
        }
        ScheduleKind::Interval => {
            if schedule.weekday.is_some() {
                return Err(AppError::validation(
                    "weekday must not be set for interval schedule".to_string(),
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

pub fn load_automations(db: &Database) -> Result<Vec<AutomationDefinition>> {
    match db.get_setting(AUTOMATIONS_KEY)? {
        Some(json_str) => {
            let list: Vec<AutomationDefinition> = serde_json::from_str(&json_str).map_err(|e| {
                AppError::internal(format!("Failed to parse {}: {}", AUTOMATIONS_KEY, e))
            })?;
            Ok(list)
        }
        None => Ok(Vec::new()),
    }
}

pub fn save_automations(db: &Database, automations: &[AutomationDefinition]) -> Result<()> {
    let json_str = serde_json::to_string(automations)
        .map_err(|e| AppError::internal(format!("Failed to serialize automations: {}", e)))?;
    db.save_setting(AUTOMATIONS_KEY, &json_str)?;
    Ok(())
}

pub fn load_automation_runs(db: &Database) -> Result<Vec<AutomationRunRecord>> {
    match db.get_setting(AUTOMATION_RUNS_KEY)? {
        Some(json_str) => {
            let list: Vec<AutomationRunRecord> = serde_json::from_str(&json_str).map_err(|e| {
                AppError::internal(format!("Failed to parse {}: {}", AUTOMATION_RUNS_KEY, e))
            })?;
            Ok(list)
        }
        None => Ok(Vec::new()),
    }
}

pub fn save_automation_runs(db: &Database, runs: &[AutomationRunRecord]) -> Result<()> {
    let json_str = serde_json::to_string(runs)
        .map_err(|e| AppError::internal(format!("Failed to serialize automation runs: {}", e)))?;
    db.save_setting(AUTOMATION_RUNS_KEY, &json_str)?;
    Ok(())
}

pub fn append_automation_run(db: &Database, record: AutomationRunRecord) -> Result<()> {
    // 🔧 P1-1 修复：读改写序列加互斥，避免并发丢失 run 记录
    with_automations_lock(|| {
        let mut runs = load_automation_runs(db)?;
        runs.push(record);
        if runs.len() > MAX_RUN_HISTORY {
            let drain = runs.len() - MAX_RUN_HISTORY;
            runs.drain(0..drain);
        }
        save_automation_runs(db, &runs)
    })
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
    match schedule.kind {
        ScheduleKind::Interval => unreachable!("interval handled above"),
        ScheduleKind::Daily => Ok(Some(
            date.and_time(time)
                .and_local_timezone(Local)
                .single()
                .ok_or_else(|| AppError::internal("Failed to build local datetime for daily slot".to_string()))?,
        )),
        ScheduleKind::Weekly => {
            let target = schedule.weekday.ok_or_else(|| {
                AppError::validation("weekly schedule missing weekday".to_string())
            })?;
            if date.weekday().num_days_from_sunday() as u8 != target {
                return Ok(None);
            }
            Ok(Some(
                date.and_time(time)
                    .and_local_timezone(Local)
                    .single()
                    .ok_or_else(|| {
                        AppError::internal("Failed to build local datetime for weekly slot".to_string())
                    })?,
            ))
        }
    }
}

/// Returns today's scheduled slot if the schedule applies today.
pub fn scheduled_slot_today(
    schedule: &AutomationSchedule,
    now: DateTime<Local>,
) -> Result<Option<DateTime<Local>>> {
    scheduled_slot_on_date(schedule, now.date_naive())
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

    // interval 调度：距上次运行超过间隔即到期（从未运行则立即到期）
    if automation.schedule.kind == ScheduleKind::Interval {
        let minutes = automation
            .schedule
            .interval_minutes
            .unwrap_or(DEFAULT_HEARTBEAT_INTERVAL_MINUTES);
        return Ok(match last_run_at {
            None => true,
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
    for day_offset in 0..8 {
        let date = now.date_naive() + chrono::Duration::days(day_offset);
        if let Some(slot) = scheduled_slot_on_date(schedule, date)? {
            if day_offset == 0 && slot <= now {
                continue;
            }
            return Ok(slot);
        }
    }
    Err(AppError::internal(
        "Could not compute next trigger within 7 days".to_string(),
    ))
}

pub fn automation_to_list_item(automation: &AutomationDefinition, now: DateTime<Local>) -> Value {
    let last_run_at = automation.last_run_at.clone();
    let next_trigger = compute_next_trigger(&automation.schedule, now)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|_| "unknown".to_string());

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
            tracing::warn!("[AutomationScheduler] notification failed for '{}': {}", name, e);
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
            tracing::warn!(
                "[AutomationScheduler] ensure_default_inbox failed: {}",
                e
            );
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

fn process_due_automation(
    db: &Arc<Database>,
    vfs_db: Option<&Arc<VfsDatabase>>,
    app_handle: &AppHandle,
    automation: &AutomationDefinition,
    now: DateTime<Local>,
) {
    let fired_at = now.with_timezone(&Utc).to_rfc3339();

    // agent_turn 类型：先消费本次触发（防止失败时每 60s 重试轰炸），再拉起 headless 运行
    if automation.action_type == AutomationActionType::AgentTurn {
        if let Err(e) = update_automation_last_run_at(db, &automation.id, &fired_at) {
            tracing::warn!(
                "[AutomationScheduler] failed to update last_run_at for '{}': {}",
                automation.id,
                e
            );
        }
        match spawn_agent_turn_automation(
            app_handle.clone(),
            db.clone(),
            automation.clone(),
            "schedule",
        ) {
            Ok(()) => {
                tracing::info!(
                    "[AutomationScheduler] fired agent_turn automation '{}'",
                    automation.name
                );
            }
            Err(e) => {
                tracing::warn!(
                    "[AutomationScheduler] agent_turn automation '{}' failed to start: {}",
                    automation.name,
                    e
                );
                // 心跳启动失败保持静默（避免周期性打扰）；普通 agent_turn 通知一次失败
                if !automation.heartbeat {
                    let _ = send_notification(
                        app_handle,
                        &format!("自动化失败：{}", automation.name),
                        &truncate_for_notification(&e, 120),
                    );
                }
                if let Err(err) = append_automation_run(
                    db,
                    AutomationRunRecord {
                        automation_id: automation.id.clone(),
                        fired_at,
                        delivered: Vec::new(),
                        session_id: None,
                        status: Some("spawn_error".to_string()),
                    },
                ) {
                    tracing::warn!(
                        "[AutomationScheduler] failed to append spawn_error record for '{}': {}",
                        automation.id,
                        err
                    );
                }
            }
        }
        return;
    }

    // notify 类型：v1 行为（系统通知 + 待办）
    let mut delivered = Vec::new();

    if send_automation_notification(app_handle, &automation.name, &automation.prompt) {
        delivered.push("notification".to_string());
    }

    if let Some(vfs_db) = vfs_db {
        if create_automation_todo(app_handle, vfs_db, &automation.name, &automation.prompt, now) {
            delivered.push("todo".to_string());
        }
    } else {
        tracing::warn!(
            "[AutomationScheduler] VFS database unavailable; skipping todo for '{}'",
            automation.name
        );
    }

    if let Err(e) = append_automation_run(
        db,
        AutomationRunRecord {
            automation_id: automation.id.clone(),
            fired_at: fired_at.clone(),
            delivered: delivered.clone(),
            session_id: None,
            status: None,
        },
    ) {
        tracing::warn!(
            "[AutomationScheduler] failed to append run history for '{}': {}",
            automation.id,
            e
        );
    }

    if let Err(e) = update_automation_last_run_at(db, &automation.id, &fired_at) {
        tracing::warn!(
            "[AutomationScheduler] failed to update last_run_at for '{}': {}",
            automation.id,
            e
        );
    }

    tracing::info!(
        "[AutomationScheduler] fired automation '{}' delivered={:?}",
        automation.name,
        delivered
    );
}

// ============================================================================
// agent_turn：headless 运行、单飞与心跳
// ============================================================================

/// 单飞注册表：同一 automation 不并发重入
static RUNNING_AGENT_AUTOMATIONS: LazyLock<StdMutex<HashSet<String>>> =
    LazyLock::new(|| StdMutex::new(HashSet::new()));

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
/// headless turn（隔离会话由 headless runner 创建，超时保护见
/// `AGENT_TURN_TIMEOUT_SECS`），隔离会话 ID 经完成事件与运行历史返回。
pub fn spawn_agent_turn_automation(
    app_handle: AppHandle,
    db: Arc<Database>,
    automation: AutomationDefinition,
    trigger: &'static str,
) -> std::result::Result<(), String> {
    let Some(guard) = AgentAutomationRunGuard::try_acquire(&automation.id) else {
        return Err(format!(
            "Automation '{}' is already running (single-flight)",
            automation.id
        ));
    };

    // 消费触发（manual 路径也更新，schedule 路径已在 process_due_automation 更新过，幂等）
    let fired_at = Utc::now().to_rfc3339();
    if let Err(e) = update_automation_last_run_at(&db, &automation.id, &fired_at) {
        tracing::warn!(
            "[AutomationScheduler] failed to update last_run_at for '{}': {}",
            automation.id,
            e
        );
    }

    tauri::async_runtime::spawn(async move {
        // 守卫移入任务：运行结束（含 panic）才释放单飞占用
        let _guard = guard;
        execute_agent_turn_automation(app_handle, db, automation, trigger, fired_at).await;
    });

    Ok(())
}

/// 执行一次 agent_turn 自动化并投递结果通知（后台任务体）。
async fn execute_agent_turn_automation(
    app_handle: AppHandle,
    db: Arc<Database>,
    automation: AutomationDefinition,
    trigger: &'static str,
    fired_at: String,
) {
    // 会话由 headless runner 创建/复用：
    // - isolated（默认）：每次新建，metadata 标注 automation_run/source；
    // - named：复用 agent_session_id 指向的固定会话（跨运行积累上下文）
    let session_mode = automation.session_mode.unwrap_or_default();
    let request = HeadlessTurnRequest {
        prompt: effective_agent_prompt(&automation),
        session_mode,
        named_session_id: automation.agent_session_id.clone(),
        model_id: automation.model_id.clone(),
        source: format!("automation:{}:{}", automation.id, trigger),
        title: Some(format!("自动化：{}", automation.name)),
        hard_timeout_secs: Some(AGENT_TURN_TIMEOUT_SECS),
        max_tool_rounds: None,
    };
    let result = run_headless_turn(app_handle.clone(), request).await;

    // named 模式：回存实际使用的会话 ID（首次运行/旧会话失效重建时会变化）
    if session_mode == HeadlessSessionMode::Named {
        if let Ok(outcome) = result.as_ref() {
            if automation.agent_session_id.as_deref() != Some(outcome.session_id.as_str()) {
                if let Err(e) = update_automation_agent_session_id(
                    &db,
                    &automation.id,
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
                        format!("已完成，打开 Deep Student 查看会话（{}）", outcome.session_id)
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
                // 心跳失败保持静默（周期任务失败以日志/运行历史为准，避免打扰）
                if !automation.heartbeat {
                    if send_notification(
                        &app_handle,
                        &format!("自动化失败：{}", automation.name),
                        &summary,
                    ) {
                        delivered.push("notification".to_string());
                    }
                }
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
            if !automation.heartbeat {
                if send_notification(
                    &app_handle,
                    &format!("自动化失败：{}", automation.name),
                    &summary,
                ) {
                    delivered.push("notification".to_string());
                }
            }
            tracing::warn!(
                "[AutomationScheduler] agent_turn automation '{}' failed: {}",
                automation.name,
                e
            );
        }
    }

    // 广播完成事件（前端在线时可据此提示"可点开会话"）
    let _ = app_handle.emit(
        "chat_v2_automation_run_completed",
        json!({
            "automationId": automation.id,
            "automationName": automation.name,
            "sessionId": session_id,
            "status": status,
            "summary": summary,
            "heartbeat": automation.heartbeat,
        }),
    );

    if let Err(e) = append_automation_run(
        &db,
        AutomationRunRecord {
            automation_id: automation.id.clone(),
            fired_at,
            delivered,
            session_id,
            status: Some(status),
        },
    ) {
        tracing::warn!(
            "[AutomationScheduler] failed to append agent_turn run record for '{}': {}",
            automation.id,
            e
        );
    }
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
            interval_minutes: Some(DEFAULT_HEARTBEAT_INTERVAL_MINUTES),
        },
        prompt: DEFAULT_HEARTBEAT_PROMPT.to_string(),
        enabled: false,
        created_at: now.to_rfc3339(),
        session_id: String::new(),
        last_run_at: None,
        action_type: AutomationActionType::AgentTurn,
        heartbeat: true,
        agent_prompt: None,
        session_mode: None,
        model_id: None,
        agent_session_id: None,
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
    with_automations_lock(|| {
        let mut automations = load_automations(db)?;
        let added = ensure_heartbeat_in_list(&mut automations, Utc::now());
        if added {
            save_automations(db, &automations)?;
            tracing::info!(
                "[AutomationScheduler] Provisioned default heartbeat automation (disabled, {}min)",
                DEFAULT_HEARTBEAT_INTERVAL_MINUTES
            );
        }
        Ok(added)
    })
}

// ============================================================================
// Tauri 命令：立即运行自动化
// ============================================================================

/// 立即运行一条自动化（绕过调度时点）。
///
/// - `agent_turn` 类型：拉起 headless 运行，立即返回隔离会话 ID（单飞保护）；
/// - `notify` 类型：立即执行通知+待办投递。
#[tauri::command]
pub async fn chat_v2_automation_run_now(
    automation_id: String,
    app_handle: AppHandle,
    db: tauri::State<'_, Arc<Database>>,
) -> std::result::Result<Value, String> {
    let automation = load_automations(&db)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|a| a.id == automation_id)
        .ok_or_else(|| format!("Automation '{}' not found", automation_id))?;

    match automation.action_type {
        AutomationActionType::AgentTurn => {
            spawn_agent_turn_automation(app_handle, db.inner().clone(), automation, "manual")?;
            // 隔离会话 ID 经 `chat_v2_automation_run_completed` 事件与运行历史返回
            Ok(json!({
                "status": "started",
                "automationId": automation_id,
                "timeoutSecs": AGENT_TURN_TIMEOUT_SECS,
            }))
        }
        AutomationActionType::Notify => {
            let vfs_db = app_handle.try_state::<Arc<VfsDatabase>>().map(|s| s.inner().clone());
            process_due_automation(
                &db.inner().clone(),
                vfs_db.as_ref(),
                &app_handle,
                &automation,
                Local::now(),
            );
            Ok(json!({
                "status": "notified",
                "automationId": automation_id,
            }))
        }
    }
}

pub fn update_automation_last_run_at(db: &Database, automation_id: &str, fired_at: &str) -> Result<()> {
    // 🔧 P1-1 修复：读改写序列加互斥。调度器持旧快照整表覆盖会抹掉
    // 刚 propose 的新自动化 / 刚 set_enabled 的启停状态
    with_automations_lock(|| {
        let mut automations = load_automations(db)?;
        if let Some(item) = automations.iter_mut().find(|a| a.id == automation_id) {
            item.last_run_at = Some(fired_at.to_string());
            save_automations(db, &automations)?;
        }
        Ok(())
    })
}

/// named 模式：回存实际使用的固定会话 ID（同样走存储互斥锁）
pub fn update_automation_agent_session_id(
    db: &Database,
    automation_id: &str,
    session_id: &str,
) -> Result<()> {
    with_automations_lock(|| {
        let mut automations = load_automations(db)?;
        if let Some(item) = automations.iter_mut().find(|a| a.id == automation_id) {
            item.agent_session_id = Some(session_id.to_string());
            save_automations(db, &automations)?;
        }
        Ok(())
    })
}

pub fn tick_automations(
    db: &Arc<Database>,
    vfs_db: Option<&Arc<VfsDatabase>>,
    app_handle: &AppHandle,
) -> Result<()> {
    let automations = load_automations(db)?;
    let now = Local::now();

    for automation in automations {
        if !automation.enabled {
            continue;
        }

        let last_run = match parse_last_run_at(automation.last_run_at.as_deref()) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    "[AutomationScheduler] skip '{}': bad last_run_at: {}",
                    automation.id,
                    e
                );
                continue;
            }
        };

        let due = match is_due(&automation, now, last_run) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    "[AutomationScheduler] skip '{}': is_due error: {}",
                    automation.id,
                    e
                );
                continue;
            }
        };

        if due {
            process_due_automation(db, vfs_db, app_handle, &automation, now);
        }
    }

    Ok(())
}

/// 后台调度器：每 60 秒检查一次到期自动化。
pub async fn start_automation_scheduler(
    database: Arc<Database>,
    vfs_db: Option<Arc<VfsDatabase>>,
    app_handle: AppHandle,
) {
    tracing::info!("[AutomationScheduler] 自动化调度器已启动");

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
        sleep(Duration::from_secs(60)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

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
                interval_minutes: None,
            },
            prompt: "Summarize mistakes".to_string(),
            enabled: true,
            created_at: Utc::now().to_rfc3339(),
            session_id: "sess_test".to_string(),
            last_run_at: None,
            action_type: AutomationActionType::Notify,
            heartbeat: false,
            agent_prompt: None,
            session_mode: None,
            model_id: None,
            agent_session_id: None,
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
                interval_minutes: Some(minutes),
            },
            prompt: DEFAULT_HEARTBEAT_PROMPT.to_string(),
            enabled: true,
            created_at: Utc::now().to_rfc3339(),
            session_id: String::new(),
            last_run_at: None,
            action_type: AutomationActionType::AgentTurn,
            heartbeat: true,
            agent_prompt: None,
            session_mode: None,
            model_id: None,
            agent_session_id: None,
        }
    }

    #[test]
    fn parse_time_accepts_hhmm() {
        assert_eq!(parse_time_hhmm("09:30").unwrap(), NaiveTime::from_hms_opt(9, 30, 0).unwrap());
        assert!(parse_time_hhmm("25:00").is_err());
        assert!(parse_time_hhmm("9:30").is_err());
    }

    #[test]
    fn validate_schedule_daily_rejects_weekday() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Daily,
            time: "08:00".to_string(),
            weekday: Some(1),
            interval_minutes: None,
        };
        assert!(validate_schedule(&schedule).is_err());
    }

    #[test]
    fn validate_schedule_weekly_requires_weekday() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Weekly,
            time: "08:00".to_string(),
            weekday: None,
            interval_minutes: None,
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
                interval_minutes: None,
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
                interval_minutes: None,
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
            interval_minutes: None,
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
            interval_minutes: None,
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
            interval_minutes: Some(30),
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
            interval_minutes: Some(30),
        };
        assert!(validate_schedule(&schedule).is_err());
    }

    #[test]
    fn is_due_interval_never_run_is_due() {
        let auto = sample_interval(30);
        let now = local_at(2026, 7, 8, 10, 0);
        assert!(is_due(&auto, now, None).unwrap());
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
            interval_minutes: Some(45),
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
}
