//! 运行时接线：headless 端口实现、后台循环、Tauri 命令。
//!
//! 全部走既有 headless 管线（`run_headless_agent_turn`）：
//! - 不依赖窗口——窗口关闭到托盘后 Super-agent 照常工作；
//! - 工具面 = headless 只读白名单（fail-closed）；写/shell/connector 一律不可用，
//!   “收到消息”不授予任何本地写权限；
//! - 准入走 `kill_switch`，一键断电同样能停住 Super-agent。

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use super::hub::{HubConfig, IngestOutcome, SuperAgentHub, TurnPorts};
use super::store::{StoreStats, SuperAgentStore};
use super::types::{now_ms, IncomingTrigger, Reply, Worker};
use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::headless::{
    create_headless_session, run_headless_agent_turn, HeadlessSessionTurn,
};
use crate::chat_v2::repo::ChatV2Repo;

pub const EVENT_REPLY: &str = "superagent_reply";
pub const EVENT_ACTIVITY: &str = "superagent_activity";

const TICK: Duration = Duration::from_secs(3);
const SWEEP_EVERY: Duration = Duration::from_secs(30);

pub struct HeadlessPorts {
    app: AppHandle,
}

impl HeadlessPorts {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn chat_db(&self) -> Result<Arc<ChatV2Database>, String> {
        self.app
            .try_state::<Arc<ChatV2Database>>()
            .map(|s| s.inner().clone())
            .ok_or_else(|| "ChatV2Database 未初始化".to_string())
    }
}

#[async_trait]
impl TurnPorts for HeadlessPorts {
    async fn create_session(
        &self,
        kind: &str,
        title: &str,
        metadata: Value,
    ) -> Result<String, String> {
        let db = self.chat_db()?;
        let mut metadata = metadata;
        if let Some(obj) = metadata.as_object_mut() {
            obj.entry("headless_named").or_insert(json!(true));
            obj.entry("superagent_kind").or_insert(json!(kind));
        }
        // mode 沿用 "automation"：与 automations 的 headless 会话同类，不污染普通会话列表
        create_headless_session(&db, "automation", title, metadata)
    }

    async fn run_turn(
        &self,
        session_id: &str,
        prompt: String,
        system_append: &str,
        model_id: Option<String>,
        timeout_secs: u64,
    ) -> Result<String, String> {
        // 会话被用户删除/归档时给出可识别的错误，Hub 据此重建 Router 会话
        let db = self.chat_db()?;
        match ChatV2Repo::get_session_v2(&db, session_id) {
            Ok(Some(_)) => {}
            Ok(None) => return Err(format!("session not found: {session_id}")),
            Err(e) => return Err(format!("读取会话失败: {e}")),
        }
        run_headless_agent_turn(
            &self.app,
            HeadlessSessionTurn {
                session_id: session_id.to_string(),
                prompt,
                model_id,
                system_prompt_append: Some(system_append.to_string()),
                timeout: Duration::from_secs(timeout_secs),
                cancellation_token: None,
            },
        )
        .await
        .map(|outcome| outcome.content)
    }

    fn emit_reply(&self, reply: &Reply) {
        let _ = self.app.emit(EVENT_REPLY, reply);
    }

    fn emit_activity(&self, kind: &str, payload: Value) {
        let _ = self.app.emit(
            EVENT_ACTIVITY,
            json!({"kind": kind, "at": now_ms(), "data": payload}),
        );
    }

    fn admit(&self) -> Result<(), String> {
        crate::chat_v2::kill_switch::admit_or_block_from_app(&self.app)
    }
}

/// Super-agent 运行时句柄（Tauri 托管状态）。
///
/// 存储按需创建：从未启用过的用户不会在磁盘上留下 `superagent/superagent.db`。
/// 已有数据库（曾经启用过）时启动即打开，以便恢复上次的开关状态与在途项。
pub struct SuperAgentRuntime {
    app: AppHandle,
    db_path: PathBuf,
    hub: OnceLock<Arc<SuperAgentHub>>,
    open_lock: Mutex<()>,
}

impl SuperAgentRuntime {
    /// 已创建的 Hub；数据库文件存在但尚未打开时顺带打开。从未启用过则返回 `None`。
    pub fn existing(&self) -> Result<Option<Arc<SuperAgentHub>>, String> {
        if let Some(hub) = self.hub.get() {
            return Ok(Some(hub.clone()));
        }
        if !self.db_path.exists() {
            return Ok(None);
        }
        self.get_or_create().map(Some)
    }

    /// 取得 Hub，必要时创建存储（启用开关、保存配置时使用）。
    pub fn get_or_create(&self) -> Result<Arc<SuperAgentHub>, String> {
        if let Some(hub) = self.hub.get() {
            return Ok(hub.clone());
        }
        let _guard = self.open_lock.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(hub) = self.hub.get() {
            return Ok(hub.clone());
        }
        let store = Arc::new(SuperAgentStore::open(&self.db_path)?);
        let hub = SuperAgentHub::new(store, Arc::new(HeadlessPorts::new(self.app.clone())));
        let _ = self.hub.set(hub.clone());
        Ok(hub)
    }
}

/// 应用启动时调用：登记运行时；仅当已有数据库且上次处于启用状态时恢复并启动后台循环。
pub fn init(app: &AppHandle) -> Result<(), String> {
    let db_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("superagent")
        .join("superagent.db");
    let runtime = SuperAgentRuntime {
        app: app.clone(),
        db_path,
        hub: OnceLock::new(),
        open_lock: Mutex::new(()),
    };
    // 默认关闭：未启用时不恢复、不启动任何后台任务，对普通会话模式零影响。
    let enabled = match runtime.existing()? {
        Some(hub) if hub.is_enabled() => {
            activate(&hub);
            true
        }
        _ => false,
    };
    app.manage(runtime);
    log::info!("[SuperAgent] initialized (enabled={enabled})");
    Ok(())
}

/// 启用后的一次性激活：启动恢复 + 后台循环。可重复调用（幂等）。
fn activate(hub: &Arc<SuperAgentHub>) {
    if let Err(e) = hub.recover_once() {
        log::warn!("[SuperAgent] recover failed: {e}");
    }
    if hub.claim_loop_start() {
        let looped = hub.clone();
        let _ = crate::background_tasks::spawn(async move { run_loop(looped).await });
    }
}

async fn run_loop(hub: Arc<SuperAgentHub>) {
    let mut last_sweep = Instant::now();
    loop {
        tokio::select! {
            _ = hub.notify.notified() => {}
            _ = tokio::time::sleep(TICK) => {}
        }
        if !hub.is_enabled() {
            continue;
        }
        hub.pump();
        if last_sweep.elapsed() >= SWEEP_EVERY {
            last_sweep = Instant::now();
            if let Err(e) = hub.watchdog_sweep(now_ms()) {
                log::warn!("[SuperAgent] watchdog sweep failed: {e}");
            }
        }
    }
}

/// 供其他模块（automations / 渠道插件）喂入事件的便捷入口。
/// 未启用或未初始化时静默返回 `None`，不影响调用方。
pub fn emit_trigger(app: &AppHandle, incoming: IncomingTrigger) -> Option<IngestOutcome> {
    let hub = app
        .try_state::<SuperAgentRuntime>()?
        .existing()
        .ok()
        .flatten()?;
    match hub.ingest(incoming) {
        Ok(outcome) => Some(outcome),
        Err(e) => {
            log::warn!("[SuperAgent] emit_trigger failed: {e}");
            None
        }
    }
}

// ============================================================================
// Tauri 命令
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperAgentStatus {
    pub enabled: bool,
    pub stats: StoreStats,
    pub workers: Vec<Worker>,
    pub router_busy: bool,
}

/// 前端（页面输入框 / 调试）允许声明的事件来源。渠道类来源（ilink、automation、review……）
/// 只能由后端模块经 [`emit_trigger`] 喂入，页面不能冒充。
const FRONTEND_SOURCES: &[&str] = &["chat", "manual"];

fn check_frontend_source(source: &str) -> Result<(), String> {
    if FRONTEND_SOURCES.contains(&source) {
        Ok(())
    } else {
        Err(format!(
            "不允许从前端以来源 \"{source}\" 投递事件（仅限 {}）",
            FRONTEND_SOURCES.join(" / ")
        ))
    }
}

fn disabled_status() -> SuperAgentStatus {
    SuperAgentStatus {
        enabled: false,
        stats: StoreStats::default(),
        workers: Vec::new(),
        router_busy: false,
    }
}

fn require_hub(rt: &SuperAgentRuntime) -> Result<Arc<SuperAgentHub>, String> {
    rt.existing()?
        .ok_or_else(|| "Super-agent 尚未启用".to_string())
}

#[tauri::command]
pub async fn superagent_status(
    rt: State<'_, SuperAgentRuntime>,
) -> Result<SuperAgentStatus, String> {
    let Some(hub) = rt.existing()? else {
        return Ok(disabled_status());
    };
    Ok(SuperAgentStatus {
        enabled: hub.is_enabled(),
        stats: hub.store().stats()?,
        workers: hub.store().list_workers(false)?,
        router_busy: hub.is_busy(super::types::TARGET_ROUTER),
    })
}

#[tauri::command]
pub async fn superagent_set_enabled(
    rt: State<'_, SuperAgentRuntime>,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        let hub = rt.get_or_create()?;
        hub.set_enabled(true)?;
        activate(&hub);
    } else if let Some(hub) = rt.existing()? {
        hub.set_enabled(false)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn superagent_ingest(
    rt: State<'_, SuperAgentRuntime>,
    trigger: IncomingTrigger,
) -> Result<IngestOutcome, String> {
    check_frontend_source(&trigger.source)?;
    match rt.existing()? {
        Some(hub) => hub.ingest(trigger),
        None => Ok(IngestOutcome::Disabled),
    }
}

#[tauri::command]
pub async fn superagent_get_config(rt: State<'_, SuperAgentRuntime>) -> Result<HubConfig, String> {
    Ok(rt.existing()?.map(|hub| hub.config()).unwrap_or_default())
}

#[tauri::command]
pub async fn superagent_set_config(
    rt: State<'_, SuperAgentRuntime>,
    config: HubConfig,
) -> Result<(), String> {
    rt.get_or_create()?.set_config(config)
}

#[tauri::command]
pub async fn superagent_feed(
    rt: State<'_, SuperAgentRuntime>,
    limit: Option<usize>,
) -> Result<Vec<super::feed::FeedItem>, String> {
    match rt.existing()? {
        Some(hub) => super::feed::build_feed(hub.store(), limit.unwrap_or(100).clamp(1, 500)),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn superagent_list_replies(
    rt: State<'_, SuperAgentRuntime>,
    limit: Option<usize>,
) -> Result<Vec<Reply>, String> {
    match rt.existing()? {
        Some(hub) => hub.store().list_replies(limit.unwrap_or(50).min(500)),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn superagent_close_worker(
    rt: State<'_, SuperAgentRuntime>,
    worker_id: String,
) -> Result<(), String> {
    require_hub(&rt)?.store().close_worker(&worker_id)
}

#[tauri::command]
pub async fn superagent_revive_worker(
    rt: State<'_, SuperAgentRuntime>,
    worker_id: String,
) -> Result<(), String> {
    require_hub(&rt)?.revive_worker(&worker_id)
}

#[cfg(test)]
mod tests {
    use super::check_frontend_source;

    #[test]
    fn frontend_can_only_ingest_chat_or_manual_events() {
        assert!(check_frontend_source("chat").is_ok());
        assert!(check_frontend_source("manual").is_ok());
        for spoofed in ["ilink", "automation", "review", "internal", "watchdog", ""] {
            assert!(
                check_frontend_source(spoofed).is_err(),
                "{spoofed} must be rejected"
            );
        }
    }
}
