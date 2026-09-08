//! WeChat iLink Bot channel plugin.
//!
//! G10-P1：入站消息统一解析为 `TaskCommand`（chat_v2::task_command），
//! Create/Steer 经 ChatV2 headless 通路（`run_headless_agent_turn`）创建/推进
//! 真实任务，不再另起独立聊天模型；Stop 即时取消会话流，Inspect 返回任务摘要，
//! Approve 仅返回桌面端确认指引（远程批准写操作属 P2）。

mod client;
mod guard;
mod qr;

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tokio::sync::watch;

use crate::chat_v2::task_command::{self, RemoteTaskManager};
use crate::database::Database;
use crate::models::AppError;
use crate::plugins::events;
use crate::plugins::manager::PluginManager;
use crate::plugins::types::{
    ChannelPlugin, PluginDescriptor, PluginKind, PluginRuntimeCtx, PluginState,
    PluginStatusSnapshot,
};

use client::{
    extract_text, is_api_error, is_session_expired, IlinkClient, IlinkCredentials,
    DEFAULT_LONG_POLL_TIMEOUT_MS,
};
use guard::{is_bound_user, RateLimiter};

pub const PLUGIN_ID: &str = "ilinkbot";
pub const CREDENTIALS_KEY: &str = "plugin.ilinkbot.credentials";
pub const SETTINGS_PREFIX: &str = "plugin.ilinkbot.";

/// 出站文本分片上限（微信单条消息长度约束）
const OUTBOUND_CHUNK_LIMIT: usize = 2000;
/// 远程任务的 system prompt 追加段（headless 约束说明之外）
const DEFAULT_REMOTE_SYSTEM_APPEND: &str = "你正在通过微信 iLink 机器人远程协助用户。回复使用简洁、友善的简体中文纯文本（微信不渲染 Markdown 表格/图片），结论先行、长度适中。你没有本地文件写入/命令执行权限；涉及写操作的请求请告知用户在桌面端确认。";
/// 同时运行的远程任务上限
const MAX_CONCURRENT_TASKS: usize = 3;

const DESC: PluginDescriptor = PluginDescriptor {
    id: PLUGIN_ID,
    label: "微信 iLink Bot",
    blurb: "通过官方 ClawBot / iLink 协议收发微信消息，并由本地 AI 自动回复。",
    kind: PluginKind::Channel,
};

struct SharedUi {
    qrcode_png: Mutex<Option<String>>,
    qrcode_status: Mutex<Option<String>>,
    last_activity: Mutex<Option<String>>,
    login_cancel: Mutex<Option<watch::Sender<bool>>>,
}

pub struct IlinkBotPlugin {
    client: IlinkClient,
    /// G10-P1：远程任务注册表（TaskCommand 路由/幂等/隔离）
    tasks: Arc<RemoteTaskManager>,
    ui: SharedUi,
    login_running: AtomicBool,
}

impl IlinkBotPlugin {
    pub fn new() -> Self {
        Self {
            client: IlinkClient::new(),
            tasks: Arc::new(RemoteTaskManager::default()),
            ui: SharedUi {
                qrcode_png: Mutex::new(None),
                qrcode_status: Mutex::new(None),
                last_activity: Mutex::new(None),
                login_cancel: Mutex::new(None),
            },
            login_running: AtomicBool::new(false),
        }
    }

    fn load_credentials(db: &Database) -> Result<Option<IlinkCredentials>, AppError> {
        let raw = db
            .get_secret(CREDENTIALS_KEY)
            .map_err(|e| AppError::database(format!("读取凭证失败: {}", e)))?;
        match raw {
            Some(s) if !s.trim().is_empty() => {
                let creds: IlinkCredentials = serde_json::from_str(&s)
                    .map_err(|e| AppError::validation(format!("凭证损坏: {}", e)))?;
                if creds.token.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(creds))
                }
            }
            _ => Ok(None),
        }
    }

    fn save_credentials(db: &Database, creds: &IlinkCredentials) -> Result<(), AppError> {
        let raw = serde_json::to_string(creds)
            .map_err(|e| AppError::internal(format!("序列化凭证失败: {}", e)))?;
        db.save_secret(CREDENTIALS_KEY, &raw)
            .map_err(|e| AppError::database(format!("保存凭证失败: {}", e)))
    }

    fn clear_credentials(db: &Database) -> Result<(), AppError> {
        let _ = db.delete_secret(CREDENTIALS_KEY);
        let _ = db.delete_setting(CREDENTIALS_KEY);
        Ok(())
    }

    fn read_setting(db: &Database, key: &str) -> Option<String> {
        db.get_setting(key).ok().flatten()
    }

    fn read_rate_limit(db: &Database) -> usize {
        Self::read_setting(db, "plugin.ilinkbot.rate_limit_per_min")
            .and_then(|s| s.parse().ok())
            .unwrap_or(10)
    }

    fn set_activity(&self, summary: &str) {
        if let Ok(mut g) = self.ui.last_activity.lock() {
            *g = Some(summary.to_string());
        }
    }

    /// 分片发送回复文本；-14（会话过期）时清凭证并切回 WaitingLogin。
    async fn send_reply(
        &self,
        ctx: &PluginRuntimeCtx,
        creds: &IlinkCredentials,
        peer: &str,
        ctx_token: &str,
        text: &str,
    ) -> Result<(), AppError> {
        let mut send_failures = 0u32;
        for chunk in client::chunk_text(text, OUTBOUND_CHUNK_LIMIT) {
            match self.client.send_text(creds, peer, ctx_token, &chunk).await {
                Ok(_) => {
                    send_failures = 0;
                    let out = format!("已回复: {}", chunk.chars().take(40).collect::<String>());
                    self.set_activity(&out);
                    events::emit_activity(&ctx.app, PLUGIN_ID, "msg_out", &out);
                }
                Err(e) => {
                    let msg_err = e.to_string();
                    if msg_err.contains("-14") || msg_err.contains("session expired") {
                        let _ = Self::clear_credentials(&ctx.database);
                        let manager = ctx.app.state::<PluginManager>();
                        manager
                            .set_state(PLUGIN_ID, PluginState::WaitingLogin, Some(msg_err.clone()))
                            .await;
                        return Err(AppError::configuration(msg_err));
                    }
                    send_failures += 1;
                    let delay = if send_failures >= 3 { 30 } else { 2 };
                    tracing::warn!("[ilinkbot] send failed: {}", e);
                    tokio::time::sleep(Duration::from_secs(delay)).await;
                }
            }
        }
        Ok(())
    }

    async fn run_login_flow(&self, ctx: PluginRuntimeCtx) -> Result<(), AppError> {
        if self
            .login_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        let (tx, mut rx) = watch::channel(false);
        {
            let mut g = self
                .ui
                .login_cancel
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            *g = Some(tx);
        }

        let result = self.login_loop(&ctx, &mut rx).await;
        self.login_running.store(false, Ordering::SeqCst);
        {
            let mut g = self
                .ui
                .login_cancel
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            *g = None;
        }
        result
    }

    async fn login_loop(
        &self,
        ctx: &PluginRuntimeCtx,
        cancel_rx: &mut watch::Receiver<bool>,
    ) -> Result<(), AppError> {
        let manager = ctx.app.state::<PluginManager>();
        manager
            .set_state(PLUGIN_ID, PluginState::WaitingLogin, None)
            .await;

        let mut refresh_count = 0u32;
        let max_refreshes = 3u32;
        let overall_deadline = tokio::time::Instant::now() + Duration::from_secs(480);

        loop {
            if ctx.cancel.is_cancelled() || *cancel_rx.borrow() {
                return Ok(());
            }
            if tokio::time::Instant::now() > overall_deadline {
                return Err(AppError::validation("扫码登录超时，请重试"));
            }

            let qr = self.client.get_bot_qrcode().await?;
            let png = qr::qrcode_png_base64(&qr.qrcode_img_content)?;
            if let Ok(mut g) = self.ui.qrcode_png.lock() {
                *g = Some(png.clone());
            }
            if let Ok(mut g) = self.ui.qrcode_status.lock() {
                *g = Some("wait".into());
            }
            events::emit_qrcode(&ctx.app, PLUGIN_ID, png, "wait");

            loop {
                if ctx.cancel.is_cancelled() || *cancel_rx.borrow() {
                    return Ok(());
                }
                if tokio::time::Instant::now() > overall_deadline {
                    return Err(AppError::validation("扫码登录超时，请重试"));
                }

                let status = match self.client.get_qrcode_status(&qr.qrcode).await {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!("[ilinkbot] qr status error: {}", e);
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                };

                if let Ok(mut g) = self.ui.qrcode_status.lock() {
                    *g = Some(status.status.clone());
                }
                if let Some(png) = self.ui.qrcode_png.lock().ok().and_then(|g| g.clone()) {
                    events::emit_qrcode(&ctx.app, PLUGIN_ID, png, &status.status);
                }

                match status.status.as_str() {
                    "wait" | "scaned" => {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    "expired" => {
                        refresh_count += 1;
                        if refresh_count > max_refreshes {
                            return Err(AppError::validation("二维码多次过期，请稍后重试"));
                        }
                        break; // refresh QR
                    }
                    "confirmed" => {
                        let token = status
                            .bot_token
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| AppError::validation("确认成功但缺少 bot_token"))?;
                        let account_id = status
                            .ilink_bot_id
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| AppError::validation("确认成功但缺少 ilink_bot_id"))?;
                        let user_id = status.ilink_user_id.unwrap_or_default();
                        let base_url = status
                            .baseurl
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| client::DEFAULT_BASE_URL.to_string());

                        let creds = IlinkCredentials {
                            token,
                            base_url,
                            account_id,
                            user_id,
                            get_updates_buf: String::new(),
                            context_tokens: Default::default(),
                        };
                        Self::save_credentials(&ctx.database, &creds)?;
                        self.set_activity("已绑定微信账号");
                        events::emit_activity(&ctx.app, PLUGIN_ID, "login", "扫码绑定成功");
                        if let Ok(mut g) = self.ui.qrcode_png.lock() {
                            *g = None;
                        }
                        if let Ok(mut g) = self.ui.qrcode_status.lock() {
                            *g = Some("confirmed".into());
                        }
                        // Bound but not yet polling — Start/enable will enter poll_loop.
                        manager
                            .set_state(PLUGIN_ID, PluginState::Stopped, None)
                            .await;
                        return Ok(());
                    }
                    other => {
                        tracing::debug!("[ilinkbot] unknown qr status: {}", other);
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        }
    }

    async fn poll_loop(
        &self,
        ctx: PluginRuntimeCtx,
        mut creds: IlinkCredentials,
    ) -> Result<(), AppError> {
        let manager = ctx.app.state::<PluginManager>();
        manager
            .set_state(PLUGIN_ID, PluginState::Running, None)
            .await;

        let rate = RateLimiter::new(Self::read_rate_limit(&ctx.database));
        let model_id = Self::read_setting(&ctx.database, "plugin.ilinkbot.model_config_id");
        let system_prompt = Self::read_setting(&ctx.database, "plugin.ilinkbot.system_prompt");
        // 远程任务的 system prompt 追加段：用户配置优先，否则用默认微信行为约束
        let system_append = Some(
            system_prompt
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_REMOTE_SYSTEM_APPEND)
                .to_string(),
        );

        let mut timeout_ms = DEFAULT_LONG_POLL_TIMEOUT_MS;
        let mut failures = 0u32;
        // 并发远程任务上限（permit 随任务结束释放；Stop/Inspect 不占额度，
        // 停止命令永远不被排在任务完成之后）
        let task_slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_TASKS));

        loop {
            tokio::select! {
                _ = ctx.cancel.cancelled() => {
                    return Ok(());
                }
                result = self.client.get_updates(&creds, timeout_ms) => {
                    match result {
                        Ok(resp) => {
                            if let Some(t) = resp.longpolling_timeout_ms {
                                if t > 0 {
                                    timeout_ms = t;
                                }
                            }
                            if is_session_expired(resp.ret, resp.errcode) {
                                let _ = Self::clear_credentials(&ctx.database);
                                events::emit_activity(&ctx.app, PLUGIN_ID, "warn", "登录已失效，请重新扫码");
                                manager.set_state(PLUGIN_ID, PluginState::WaitingLogin, Some("session expired".into())).await;
                                return Err(AppError::configuration("session expired (-14)"));
                            }
                            if is_api_error(resp.ret, resp.errcode) {
                                failures += 1;
                                let delay = if failures >= 3 { 30 } else { 2 };
                                if failures >= 3 { failures = 0; }
                                tracing::warn!("[ilinkbot] getupdates api error ret={:?} err={:?}", resp.ret, resp.errcode);
                                tokio::time::sleep(Duration::from_secs(delay)).await;
                                continue;
                            }
                            failures = 0;
                            if let Some(buf) = resp.get_updates_buf {
                                if !buf.is_empty() && buf != creds.get_updates_buf {
                                    creds.get_updates_buf = buf;
                                    let _ = Self::save_credentials(&ctx.database, &creds);
                                }
                            }

                            for msg in resp.msgs {
                                // Only user messages
                                if msg.message_type == Some(2) {
                                    continue;
                                }
                                let peer = msg.from_user_id.clone().unwrap_or_default();
                                if peer.is_empty() {
                                    continue;
                                }
                                if let Some(token) = msg.context_token.clone() {
                                    creds.context_tokens.insert(peer.clone(), token);
                                    let _ = Self::save_credentials(&ctx.database, &creds);
                                }
                                let text = extract_text(&msg);
                                if text.trim().is_empty() {
                                    continue;
                                }
                                if !is_bound_user(&creds.user_id, &peer) {
                                    self.set_activity("已忽略非绑定用户消息");
                                    events::emit_activity(&ctx.app, PLUGIN_ID, "warn", "非绑定用户消息已忽略");
                                    continue;
                                }
                                if !rate.check_and_record(&peer) {
                                    let ctx_token = creds.context_tokens.get(&peer).cloned().unwrap_or_default();
                                    if !ctx_token.is_empty() {
                                        let _ = self.client.send_text(&creds, &peer, &ctx_token, "你发送得太快了，请稍后再试。").await;
                                    }
                                    continue;
                                }

                                let summary = format!("收到消息: {}", text.chars().take(40).collect::<String>());
                                self.set_activity(&summary);
                                events::emit_activity(&ctx.app, PLUGIN_ID, "msg_in", &summary);

                                let ctx_token = creds
                                    .context_tokens
                                    .get(&peer)
                                    .cloned()
                                    .or(msg.context_token.clone())
                                    .unwrap_or_default();
                                if ctx_token.is_empty() {
                                    tracing::warn!("[ilinkbot] missing context_token for {}", peer);
                                    continue;
                                }

                                // —— G10-P1：入站统一解析为 TaskCommand，接入 ChatV2 任务运行系统 ——
                                // 显式绑定：account(bot) + device(绑定用户) + channel + thread
                                // （iLink 会话 session_id，缺失回退 peer），不再按 peer 字符串合并。
                                let binding = task_command::RemoteBinding {
                                    account: creds.account_id.clone(),
                                    device_id: creds.user_id.clone(),
                                    channel: task_command::CHANNEL_ILINK_WECHAT.to_string(),
                                    thread_id: msg
                                        .session_id
                                        .clone()
                                        .filter(|s| !s.is_empty())
                                        .unwrap_or_else(|| peer.clone()),
                                    ..Default::default()
                                };
                                // 幂等键：message_id > seq > client_id（都没有则不去重）
                                let dedup_key = msg
                                    .message_id
                                    .map(|id| format!("m{}", id))
                                    .or_else(|| msg.seq.map(|s| format!("s{}", s)))
                                    .or_else(|| {
                                        msg.client_id
                                            .clone()
                                            .filter(|c| !c.is_empty())
                                            .map(|c| format!("c{}", c))
                                    })
                                    .unwrap_or_default();

                                let outcome = self.tasks.dispatch(task_command::InboundRemote {
                                    binding,
                                    message_id: dedup_key,
                                    text: text.clone(),
                                });

                                match outcome {
                                    task_command::DispatchOutcome::IgnoredDuplicate => {}
                                    task_command::DispatchOutcome::Reply(reply) => {
                                        self.send_reply(&ctx, &creds, &peer, &ctx_token, &reply).await?;
                                    }
                                    task_command::DispatchOutcome::StopAck { reply, session_id } => {
                                        // 停止优先：回复与取消都立即执行，不等待任务完成
                                        self.send_reply(&ctx, &creds, &peer, &ctx_token, &reply).await?;
                                        if let Some(sid) = session_id {
                                            let app_c = ctx.app.clone();
                                            tokio::spawn(async move {
                                                let cancelled =
                                                    task_command::cancel_session_stream_with_retry(&app_c, &sid).await;
                                                tracing::info!(
                                                    "[ilinkbot] stop cancel session={} cancelled={}",
                                                    sid,
                                                    cancelled
                                                );
                                            });
                                        }
                                    }
                                    task_command::DispatchOutcome::Launch { ack, plan } => {
                                        self.send_reply(&ctx, &creds, &peer, &ctx_token, &ack).await?;
                                        let permit = match task_slots.clone().try_acquire_owned() {
                                            Ok(p) => p,
                                            Err(_) => {
                                                if let Some(text) = self.tasks.finish_turn(
                                                    &plan.task_id,
                                                    task_command::RemoteTaskStatus::Failed,
                                                    "",
                                                    Some("同时运行的任务已达上限，请稍后再试"),
                                                ) {
                                                    self.send_reply(&ctx, &creds, &peer, &ctx_token, &text).await?;
                                                }
                                                continue;
                                            }
                                        };
                                        let app = ctx.app.clone();
                                        let tasks = Arc::clone(&self.tasks);
                                        let client = self.client.clone();
                                        let creds_c = creds.clone();
                                        let peer_c = peer.clone();
                                        let model_id = model_id.clone();
                                        let system_append = system_append.clone();
                                        tokio::spawn(async move {
                                            // permit 持有至任务结束，限制并发远程任务数
                                            let _permit = permit;
                                            run_remote_task(
                                                app,
                                                tasks,
                                                client,
                                                creds_c,
                                                peer_c,
                                                ctx_token,
                                                plan,
                                                model_id,
                                                system_append,
                                            )
                                            .await;
                                        });
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            if ctx.cancel.is_cancelled() {
                                return Ok(());
                            }
                            failures += 1;
                            let delay = if failures >= 3 { 30 } else { 2 };
                            if failures >= 3 { failures = 0; }
                            tracing::warn!("[ilinkbot] getupdates error: {}", e);
                            tokio::time::sleep(Duration::from_secs(delay)).await;
                        }
                    }
                }
            }
        }
    }
}

/// 后台发送任务结果（分片）；失败只记日志/活动，不影响 poll 循环。
async fn send_chunks(
    client: &IlinkClient,
    creds: &IlinkCredentials,
    peer: &str,
    ctx_token: &str,
    text: &str,
) -> Result<(), AppError> {
    for chunk in client::chunk_text(text, OUTBOUND_CHUNK_LIMIT) {
        client.send_text(creds, peer, ctx_token, &chunk).await?;
    }
    Ok(())
}

/// 执行一个远程任务（G10-P1）：Create 新建会话 / Steer 复用会话，
/// 经 ChatV2 headless 通路（`run_headless_agent_turn`，G01-d 收口）跑完整
/// agent turn；工具面 = headless 只读白名单（写/connector/shell 双层被拒）。
#[allow(clippy::too_many_arguments)]
async fn run_remote_task(
    app: tauri::AppHandle,
    tasks: Arc<RemoteTaskManager>,
    client: IlinkClient,
    creds: IlinkCredentials,
    peer: String,
    ctx_token: String,
    plan: task_command::PlannedTurn,
    model_id: Option<String>,
    system_append: Option<String>,
) {
    // 1. 解析会话：Steer 复用既有会话；Create 新建（绑定 JSON 写入会话 metadata）
    let session_id = match plan.existing_session_id.clone() {
        Some(s) => Some(s),
        None => match task_command::create_remote_task_session(&app, &plan) {
            Ok(s) => Some(s),
            Err(e) => {
                tracing::warn!("[ilinkbot] create remote task session failed: {}", e);
                None
            }
        },
    };
    let Some(session_id) = session_id else {
        if let Some(text) = tasks.finish_turn(
            &plan.task_id,
            task_command::RemoteTaskStatus::Failed,
            "",
            Some("ChatV2 未就绪，任务启动失败"),
        ) {
            let _ = send_chunks(&client, &creds, &peer, &ctx_token, &text).await;
        }
        return;
    };
    // 2. 附着会话：若 Stop 先于附着到达（记录已 Cancelled），放弃启动——
    //    停止命令不被排在任务完成之后
    if !tasks.attach_session(&plan.task_id, &session_id) {
        tracing::info!(
            "[ilinkbot] task {} stopped before session attach, abort launch",
            plan.task_id
        );
        return;
    }
    // 3. 经 headless 通路执行（无人审批、只读白名单、硬超时）
    let turn = task_command::build_session_turn(&plan, session_id.clone(), model_id, system_append);
    let result = crate::chat_v2::headless::run_headless_agent_turn(&app, turn).await;
    let (status, summary, error) = match result {
        Ok(outcome) => (task_command::RemoteTaskStatus::Completed, outcome.content, None),
        Err(m) if m.contains("timed out") => {
            (task_command::RemoteTaskStatus::Timeout, String::new(), Some(m))
        }
        Err(m) if m.contains("cancelled") => {
            (task_command::RemoteTaskStatus::Cancelled, String::new(), Some(m))
        }
        Err(m) => (task_command::RemoteTaskStatus::Failed, String::new(), Some(m)),
    };
    // 4. 回写记录并通知（记录已被 Stop 取消时 finish_turn 返回 None，不再发结果）
    if let Some(text) = tasks.finish_turn(&plan.task_id, status, &summary, error.as_deref()) {
        match send_chunks(&client, &creds, &peer, &ctx_token, &text).await {
            Ok(_) => {
                events::emit_activity(
                    &app,
                    PLUGIN_ID,
                    "msg_out",
                    &format!("任务 #{} 结果已发送", plan.task_id),
                );
            }
            Err(e) => {
                tracing::warn!("[ilinkbot] send task result failed: {}", e);
                events::emit_activity(
                    &app,
                    PLUGIN_ID,
                    "warn",
                    &format!("任务结果发送失败: {}", e),
                );
            }
        }
    }
}

#[async_trait]
impl ChannelPlugin for IlinkBotPlugin {
    fn descriptor(&self) -> &PluginDescriptor {
        &DESC
    }

    fn is_configured(&self, config: &Value) -> bool {
        config
            .get("bound")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    async fn is_bound(&self, database: &Database) -> bool {
        Self::load_credentials(database)
            .ok()
            .flatten()
            .map(|c| !c.token.is_empty())
            .unwrap_or(false)
    }

    async fn run(&self, ctx: PluginRuntimeCtx) -> Result<(), AppError> {
        // If not bound, run login first
        let creds = match Self::load_credentials(&ctx.database)? {
            Some(c) => c,
            None => {
                self.run_login_flow(PluginRuntimeCtx {
                    app: ctx.app.clone(),
                    database: ctx.database.clone(),
                    llm: ctx.llm.clone(),
                    cancel: ctx.cancel.clone(),
                    config: ctx.config.clone(),
                })
                .await?;
                Self::load_credentials(&ctx.database)?
                    .ok_or_else(|| AppError::validation("登录未完成"))?
            }
        };
        if ctx.cancel.is_cancelled() {
            return Ok(());
        }
        self.poll_loop(ctx, creds).await
    }

    async fn status(&self, database: &Database) -> PluginStatusSnapshot {
        let creds = Self::load_credentials(database).ok().flatten();
        let enabled = Self::read_setting(database, "plugin.ilinkbot.enabled")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        let config = self.get_public_config(database).await.unwrap_or_default();
        PluginStatusSnapshot {
            state: PluginState::Stopped,
            enabled,
            configured: self.is_configured(&config),
            bound: creds.as_ref().map(|c| !c.token.is_empty()).unwrap_or(false),
            login_status: self.ui.qrcode_status.lock().ok().and_then(|g| g.clone()),
            account_id: creds.as_ref().map(|c| c.account_id.clone()),
            user_id: creds.as_ref().map(|c| c.user_id.clone()),
            last_error: None,
            last_activity: self.ui.last_activity.lock().ok().and_then(|g| g.clone()),
            qrcode_png_base64: self.ui.qrcode_png.lock().ok().and_then(|g| g.clone()),
            qrcode_status: self.ui.qrcode_status.lock().ok().and_then(|g| g.clone()),
        }
    }

    async fn get_public_config(&self, database: &Database) -> Result<Value, AppError> {
        let rate = Self::read_rate_limit(database);
        let model =
            Self::read_setting(database, "plugin.ilinkbot.model_config_id").unwrap_or_default();
        let system_prompt =
            Self::read_setting(database, "plugin.ilinkbot.system_prompt").unwrap_or_default();
        let enabled = Self::read_setting(database, "plugin.ilinkbot.enabled")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        let bound = self.is_bound(database).await;
        let creds = Self::load_credentials(database).ok().flatten();
        Ok(json!({
            "enabled": enabled,
            "rateLimitPerMin": rate,
            "modelConfigId": model,
            "systemPrompt": system_prompt,
            "bound": bound,
            "hasToken": bound,
            "accountId": creds.as_ref().map(|c| c.account_id.clone()).unwrap_or_default(),
            "userId": creds.as_ref().map(|c| c.user_id.clone()).unwrap_or_default(),
            "baseUrl": creds.as_ref().map(|c| c.base_url.clone()).unwrap_or_default(),
        }))
    }

    async fn set_config(&self, database: &Database, patch: Value) -> Result<(), AppError> {
        if let Some(v) = patch.get("enabled").and_then(|x| x.as_bool()) {
            database
                .save_setting("plugin.ilinkbot.enabled", if v { "true" } else { "false" })
                .map_err(|e| AppError::database(e.to_string()))?;
        }
        if let Some(n) = patch.get("rateLimitPerMin").and_then(|x| x.as_u64()) {
            database
                .save_setting("plugin.ilinkbot.rate_limit_per_min", &n.to_string())
                .map_err(|e| AppError::database(e.to_string()))?;
        }
        if let Some(s) = patch.get("modelConfigId").and_then(|x| x.as_str()) {
            database
                .save_setting("plugin.ilinkbot.model_config_id", s)
                .map_err(|e| AppError::database(e.to_string()))?;
        }
        if let Some(s) = patch.get("systemPrompt").and_then(|x| x.as_str()) {
            database
                .save_setting("plugin.ilinkbot.system_prompt", s)
                .map_err(|e| AppError::database(e.to_string()))?;
        }
        // Never accept token via patch from frontend
        Ok(())
    }

    async fn begin_login(&self, ctx: PluginRuntimeCtx) -> Result<(), AppError> {
        self.run_login_flow(ctx).await
    }

    async fn cancel_login(&self) -> Result<(), AppError> {
        if let Ok(g) = self.ui.login_cancel.lock() {
            if let Some(tx) = g.as_ref() {
                let _ = tx.send(true);
            }
        }
        Ok(())
    }

    async fn logout(&self, database: &Database) -> Result<(), AppError> {
        Self::clear_credentials(database)?;
        if let Ok(mut g) = self.ui.qrcode_png.lock() {
            *g = None;
        }
        if let Ok(mut g) = self.ui.qrcode_status.lock() {
            *g = None;
        }
        self.set_activity("已解绑");
        Ok(())
    }
}
