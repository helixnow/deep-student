//! 运行时接线：headless 端口实现、后台循环、Tauri 命令。
//!
//! 全部走既有 headless 管线（`run_headless_agent_turn`）：
//! - 不依赖窗口——窗口关闭到托盘后 Super-agent 照常工作；
//! - 工具面 = headless 只读白名单（fail-closed）；写/shell/connector 一律不可用，
//!   “收到消息”不授予任何本地写权限；
//! - 准入走 `kill_switch`，一键断电同样能停住 Super-agent。

use std::sync::Arc;
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

/// 应用启动时调用：打开存储、创建 Hub、恢复在途项、启动后台循环。
pub fn init(app: &AppHandle) -> Result<Arc<SuperAgentHub>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("superagent");
    let store = Arc::new(SuperAgentStore::open(&dir.join("superagent.db"))?);
    let hub = SuperAgentHub::new(store, Arc::new(HeadlessPorts::new(app.clone())));
    app.manage(hub.clone());
    // 默认关闭：未启用时不恢复、不启动任何后台任务，对普通会话模式零影响。
    // 只有用户在设置页打开开关（或上次已打开）才会启动后台循环。
    if hub.is_enabled() {
        activate(&hub);
    }
    log::info!("[SuperAgent] initialized (enabled={})", hub.is_enabled());
    Ok(hub)
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
    let hub = app.try_state::<Arc<SuperAgentHub>>()?;
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

#[tauri::command]
pub async fn superagent_status(
    hub: State<'_, Arc<SuperAgentHub>>,
) -> Result<SuperAgentStatus, String> {
    Ok(SuperAgentStatus {
        enabled: hub.is_enabled(),
        stats: hub.store().stats()?,
        workers: hub.store().list_workers(false)?,
        router_busy: hub.is_busy(super::types::TARGET_ROUTER),
    })
}

#[tauri::command]
pub async fn superagent_set_enabled(
    hub: State<'_, Arc<SuperAgentHub>>,
    enabled: bool,
) -> Result<(), String> {
    hub.set_enabled(enabled)?;
    if enabled {
        activate(&hub);
    }
    Ok(())
}

#[tauri::command]
pub async fn superagent_ingest(
    hub: State<'_, Arc<SuperAgentHub>>,
    trigger: IncomingTrigger,
) -> Result<IngestOutcome, String> {
    hub.ingest(trigger)
}

#[tauri::command]
pub async fn superagent_get_config(
    hub: State<'_, Arc<SuperAgentHub>>,
) -> Result<HubConfig, String> {
    Ok(hub.config())
}

#[tauri::command]
pub async fn superagent_set_config(
    hub: State<'_, Arc<SuperAgentHub>>,
    config: HubConfig,
) -> Result<(), String> {
    hub.set_config(config)
}

#[tauri::command]
pub async fn superagent_feed(
    hub: State<'_, Arc<SuperAgentHub>>,
    limit: Option<usize>,
) -> Result<Vec<super::feed::FeedItem>, String> {
    super::feed::build_feed(hub.store(), limit.unwrap_or(100).clamp(1, 500))
}

#[tauri::command]
pub async fn superagent_list_replies(
    hub: State<'_, Arc<SuperAgentHub>>,
    limit: Option<usize>,
) -> Result<Vec<Reply>, String> {
    hub.store().list_replies(limit.unwrap_or(50).min(500))
}

#[tauri::command]
pub async fn superagent_close_worker(
    hub: State<'_, Arc<SuperAgentHub>>,
    worker_id: String,
) -> Result<(), String> {
    hub.store().close_worker(&worker_id)
}

#[tauri::command]
pub async fn superagent_revive_worker(
    hub: State<'_, Arc<SuperAgentHub>>,
    worker_id: String,
) -> Result<(), String> {
    hub.revive_worker(&worker_id)
}
