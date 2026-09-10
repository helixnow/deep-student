//! 子代理完成投递派发器（G03-a 账本兜底 + G03-d 无窗唤醒轮）——后端常驻。
//!
//! 完成投递的权威账本是 chat_v2 主库 `completion_outbox` 表（repo 见
//! [`crate::chat_v2::workspace::completion_outbox`]）。worker 完成闭包正常
//! 路径会即时把行收敛为 delivered；本派发器只收敛**异常遗留**的 pending 行
//! （进程崩溃在闭包中段、窗口缺席等），把"唤醒父会话"的可靠性从前端内存
//! 队列收归后端持久账本。
//!
//! ## 与前端快路径的幂等分工
//!
//! - 前端 `SubagentIdleWakeController`：窗口在场时的快路径。收到
//!   `workspace_agent_completion` 即按父会话空闲状态排队唤醒；唤醒失败不再
//!   永久丢弃（权威在账本）。
//! - 本派发器：兜底。claim 遗留 pending 行 → workspace 库按 run_id 查重
//!   （已投递则跳过补写）→ 缺则补投 inbox Result 消息 → 补 task 终态 →
//!   按窗口在场与否二选一收敛：
//!   - **有窗**（G03-a 行为不变）：emit 同一事件（前端 wakeKey 去重，重复
//!     emit 安全）→ delivered；
//!   - **无窗**（G03-d）：先收敛 delivered，再排一个**后端 headless 唤醒轮**
//!     ——完成摘要经 wake 语义（不落用户消息库）注入父会话，走
//!     [`crate::chat_v2::headless::run_headless_agent_turn`] 的完整管线
//!     （G01-d headless emitter + G01-b NoopStreamSink，不依赖任何窗口）。
//!
//! delivered 语义 = "inbox 消息已持久化（权威投递）+ 唤醒责任已消费"（前端
//! emit 或后端唤醒轮，二者其一）。
//!
//! ## 防重入（复用现有状态机，无新迁移）
//!
//! delivered 是终态：行一旦收敛就永不再被 claim，同一 outbox 行只唤醒一次；
//! `mark_delivered` 的 owner 守卫同时挡住"闭包自投递与派发器并发收敛同一行"
//! 的竞态（失败方 won=false，不再排唤醒轮）。唤醒轮失败/进程在 delivered 后
//! 崩溃都不回滚：inbox Result 消息仍在，父会话后续 turn 的 drain_inbox 兜底。
//!
//! ## 防风暴
//!
//! - 并发上限：同时在跑的唤醒轮 ≤ [`MAX_CONCURRENT_WAKES`]，超出在信号量上
//!   排队（不丢弃）；tick 只排程不等待，毫秒级返回。
//! - 递归有界：唤醒轮的工具面是 headless 白名单——`workspace_create` /
//!   `subagent_call` 等拉起子代理的工具不在其中（前端桥缺席，fail-closed），
//!   唤醒轮自身无法再产生完成行；即便经其他路径产生，每行仍只醒一次，
//!   代际失效（expired）机制兜底。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde::Serialize;
use tauri::{Emitter, Manager};

use super::completion_outbox::{completion_message_exists, CompletionDelivery, CompletionOutbox};
use super::database::ChatV2Database;
use super::headless::{run_headless_agent_turn, HeadlessSessionTurn};
use super::repo::ChatV2Repo;
use super::state::ChatV2State;
use super::types::PersistStatus;
use super::workspace::{SubagentTaskStatus, WorkspaceCoordinator};

/// 前端快路径监听的事件名（与 workspace_handlers 完成闭包 emit 的一致）。
pub const WORKSPACE_AGENT_COMPLETION_EVENT: &str = "workspace_agent_completion";

/// tick 间隔：完成闭包正常路径即时收敛，派发器只是兜底，低频轮询即可。
const TICK_INTERVAL: Duration = Duration::from_secs(5);
/// 单次认领租约时长。单次处理是毫秒级本地 DB 操作，60s 已覆盖一个数量级
/// 以上的卡顿；过期租约由 reclaim 回收重投。
const LEASE_SECS: i64 = 60;
/// 自投递宽限期：只认领创建早于 (now - grace) 的 pending 行，避开在途完成
/// 闭包（其正常路径毫秒级完成），几乎消除"闭包与派发器并发补投"的窗口。
const SELF_DELIVERY_GRACE_SECS: i64 = 15;
/// 单批认领上限。
const CLAIM_BATCH_SIZE: i64 = 20;
/// 尝试次数上限（防御死循环：父会话长期忙/窗口长期缺席等异常累积）。
/// 超过后标 expired——此时 inbox 多半已持久化，只是通知链路始终未通。
const MAX_ATTEMPTS: i64 = 50;

// ============================================================================
// G03-d：无窗唤醒轮（headless wake turn）
// ============================================================================

/// 同时在跑的唤醒轮上限，超出在信号量上排队（不丢弃）。
const MAX_CONCURRENT_WAKES: usize = 3;
/// 单个唤醒轮的硬超时（秒）：通知消化型任务，取用偏保守的 5 分钟；
/// 防御性钳制由 headless 侧 `clamp_session_turn_timeout` 完成。
// TODO(G08)：唤醒轮 budget 接入 `chat_v2::budget` BudgetLedger（派生绑定
// 父会话树根账本），与 hooks 预算门对齐——G08 落地后在此接线。
const WAKE_TURN_TIMEOUT_SECS: u64 = 300;
/// 唤醒消息中结果摘要的最大字符数（与前端快路径 WAKE_SUMMARY_MAX_CHARS 一致）。
const WAKE_SUMMARY_MAX_CHARS: usize = 2000;
/// 唤醒轮的 system prompt 追加段（headless 约束说明之外的唤醒语境）。
const WAKE_TURN_SYSTEM_APPEND: &str = "本回合由后端在无窗口值守模式下触发：一条子代理完成通知已作为当前输入注入。请消化该结果、视需要推进原任务，并给出简洁的进展汇总。不要重复派发已完成的子任务。";

/// 一次父会话无窗唤醒轮的输入。
#[derive(Debug, Clone)]
pub struct WakeTurnRequest {
    /// 父会话 ID
    pub session_id: String,
    /// 唤醒内容（wake 语义：作为本轮 user content 输入管线，不落用户消息库）
    pub prompt: String,
    /// 触发该唤醒的 outbox 行（日志/审计关联）
    pub delivery_id: String,
    pub run_id: String,
}

/// 唤醒轮执行器：生产为 headless runner（`run_headless_agent_turn`），
/// 测试注入内存替身。返回 `Err` 不触发重投——inbox Result 消息已权威持久化，
/// 唤醒轮只是加速器。
type WakeRunner =
    Arc<dyn Fn(WakeTurnRequest) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// 窗口存在性探针（可测试接缝；生产 = app 的 webview 窗口非空）。
type WindowProbe = Arc<dyn Fn() -> bool + Send + Sync>;

/// 完成事件出口（有窗路径；生产 = `app_handle.emit`）。
type CompletionEmitter = Arc<dyn Fn(&serde_json::Value) -> Result<(), String> + Send + Sync>;

/// 无窗唤醒轮调度器：并发上限 + 注入式执行器。
///
/// 排队语义：`schedule` 立即返回（tick 不被长任务拖住）；唤醒轮在后台任务中
/// 先 acquire 信号量——达到上限时在等待队列排队，不丢弃——再经 runner 执行。
#[derive(Clone)]
struct HeadlessWakeScheduler {
    permits: Arc<tokio::sync::Semaphore>,
    runner: WakeRunner,
}

impl HeadlessWakeScheduler {
    fn new(runner: WakeRunner) -> Self {
        Self {
            permits: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_WAKES)),
            runner,
        }
    }

    /// 取位并执行一个唤醒轮（schedule 的工作主体；测试直接 await 它以避免
    /// 后台 spawn 的时序依赖）。
    async fn run_with_permit(
        permits: Arc<tokio::sync::Semaphore>,
        runner: WakeRunner,
        req: WakeTurnRequest,
    ) {
        // 信号量从不关闭，acquire 只会排队等位
        let Ok(_permit) = permits.acquire_owned().await else {
            return;
        };
        let started = std::time::Instant::now();
        let result = runner(req.clone()).await;
        match result {
            Ok(()) => log::info!(
                "[CompletionDispatcher] Headless wake turn completed: delivery={}, run={}, session={}, duration_ms={}",
                req.delivery_id,
                req.run_id,
                req.session_id,
                started.elapsed().as_millis()
            ),
            // 唤醒失败不回滚 delivered：inbox Result 消息已权威持久化，
            // 父会话后续 turn 的 drain_inbox 兜底消费。
            Err(error) => log::warn!(
                "[CompletionDispatcher] Headless wake turn failed: delivery={}, run={}, session={}, error={}（inbox 已持久化，后续 turn 兜底）",
                req.delivery_id,
                req.run_id,
                req.session_id,
                error
            ),
        }
    }

    /// 排一个唤醒轮到后台。返回 false = 进程关闭中（N10 准入关闭），
    /// 调用方仅记录——行已 delivered，inbox 兜底语义不变。
    fn schedule(&self, req: WakeTurnRequest) -> bool {
        crate::background_tasks::spawn(Self::run_with_permit(
            Arc::clone(&self.permits),
            Arc::clone(&self.runner),
            req,
        ))
        .is_some()
    }
}

/// 由完成信封组装唤醒轮的 user content（wake 语义，不落用户消息库）。
///
/// 口径与前端快路径（workspace/events.ts sendWake）对齐：通知头 + 截断摘要 +
/// 继续处理指引；差异是后端无窗轮的工具面为 headless 白名单（workspace_query
/// 等前端桥工具缺席），指引文案相应收窄。payload 损坏时退化为最小通知
/// （inbox 里的原始信封仍是权威内容，唤醒轮只负责"推一把"）。
fn wake_prompt_from_delivery(delivery: &CompletionDelivery) -> String {
    let payload: serde_json::Value =
        serde_json::from_str(&delivery.payload_json).unwrap_or_else(|_| serde_json::json!({}));
    let status = payload
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("unknown");
    let summary_source = payload
        .get("final_output")
        .or_else(|| payload.get("error"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    let summary = if summary_source.chars().count() > WAKE_SUMMARY_MAX_CHARS {
        let truncated: String = summary_source
            .chars()
            .take(WAKE_SUMMARY_MAX_CHARS)
            .collect();
        format!("{truncated}…（已截断）")
    } else {
        summary_source.to_string()
    };

    [
        format!(
            "[子代理完成通知] agent={} status={}",
            delivery.agent_session_id, status
        ),
        if summary.is_empty() {
            "（子代理未产出文本摘要）".to_string()
        } else {
            format!("结果摘要：\n{summary}")
        },
        "请基于该结果继续处理原任务。若该子代理结果已在之前的回合处理过，无需重复处理。"
            .to_string(),
        "如还有其他后台子代理未完成，其结果会在完成后另行注入，不要重复派发相同任务。".to_string(),
    ]
    .join("\n\n")
}

/// 生产唤醒轮执行器：经 headless runner 在父会话上跑完整管线
/// （G01-d headless emitter + G01-b NoopStreamSink；wake 语义由
/// `run_headless_agent_turn` 内部构建，content 不落用户消息库）。
fn default_wake_runner(app: tauri::AppHandle) -> WakeRunner {
    Arc::new(move |req: WakeTurnRequest| {
        let app = app.clone();
        Box::pin(async move {
            run_headless_agent_turn(
                &app,
                HeadlessSessionTurn {
                    session_id: req.session_id,
                    prompt: req.prompt,
                    model_id: None,
                    system_prompt_append: Some(WAKE_TURN_SYSTEM_APPEND.to_string()),
                    timeout: Duration::from_secs(WAKE_TURN_TIMEOUT_SECS),
                },
            )
            .await
            .map(|_| ())
        })
    })
}

/// 派发器依赖。全部为主库/协调器级句柄，不持有 workspace 库连接
/// （workspace 库仅做只读裸查询，写路径统一经 coordinator）。
pub struct CompletionDispatcherDeps {
    pub db: Arc<ChatV2Database>,
    pub coordinator: Arc<WorkspaceCoordinator>,
    pub chat_v2_state: Arc<ChatV2State>,
    pub app_handle: tauri::AppHandle,
    /// `app_data_dir/workspaces`：用于判定 workspace db 文件是否仍存在
    /// （已删除工作区的遗留行直接 expired，避免 get_instance 惰性重建空库）。
    pub workspaces_dir: PathBuf,
}

/// 常驻派发器。通过 [`spawn_completion_dispatcher`] 启动。
pub struct CompletionDispatcher {
    outbox: CompletionOutbox,
    /// 本实例认领标识（hostname:pid:boot-ulid 风格；进程内唯一即可——
    /// SQLite 单写者保证不重复认领，owner 仅用于租约守卫）。
    owner: String,
    /// 单行收敛内核（剥离 AppHandle 后可单测）。
    worker: DeliveryWorker,
}

/// 单行收敛的执行内核：持有除 AppHandle 外的全部依赖，窗口探针 / 事件出口 /
/// 唤醒轮执行器均为可注入接缝（生产由 [`CompletionDispatcher::new`] 装配，
/// 测试注入内存替身走真实 `process_one` 路径）。
struct DeliveryWorker {
    outbox: CompletionOutbox,
    db: Arc<ChatV2Database>,
    coordinator: Arc<WorkspaceCoordinator>,
    chat_v2_state: Arc<ChatV2State>,
    workspaces_dir: PathBuf,
    owner: String,
    has_window: WindowProbe,
    emit_completion: CompletionEmitter,
    wake: HeadlessWakeScheduler,
}

/// 单轮 tick 的处理统计（日志/测试观测用）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DispatcherTickStats {
    pub reclaimed: usize,
    pub claimed: usize,
    pub delivered: usize,
    pub released: usize,
    pub expired: usize,
    pub failed: usize,
}

impl CompletionDispatcher {
    pub fn new(deps: CompletionDispatcherDeps) -> Self {
        let outbox = CompletionOutbox::new(deps.db.clone());
        let owner = format!(
            "completion-dispatcher:{}:{}",
            std::process::id(),
            ulid::Ulid::new()
        );

        // G03-d 生产装配：窗口探针 / 完成事件出口 / 唤醒轮执行器。
        let app = deps.app_handle.clone();
        let has_window: WindowProbe = Arc::new(move || !app.webview_windows().is_empty());
        let app = deps.app_handle.clone();
        let emit_completion: CompletionEmitter = Arc::new(move |payload| {
            app.emit(WORKSPACE_AGENT_COMPLETION_EVENT, payload)
                .map_err(|e| e.to_string())
        });
        let wake = HeadlessWakeScheduler::new(default_wake_runner(deps.app_handle.clone()));

        let worker = DeliveryWorker {
            outbox: outbox.clone(),
            db: deps.db.clone(),
            coordinator: deps.coordinator.clone(),
            chat_v2_state: deps.chat_v2_state.clone(),
            workspaces_dir: deps.workspaces_dir.clone(),
            owner: owner.clone(),
            has_window,
            emit_completion,
            wake,
        };
        Self {
            outbox,
            owner,
            worker,
        }
    }

    /// 单轮收敛：回收过期租约 → 认领一批 → 逐行处理。
    pub fn tick(&self) -> Result<DispatcherTickStats, String> {
        let mut stats = DispatcherTickStats::default();
        stats.reclaimed = self.outbox.reclaim_expired_claims()?;

        let lease_expiry = (chrono::Utc::now() + chrono::Duration::seconds(LEASE_SECS))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let not_before = (chrono::Utc::now() - chrono::Duration::seconds(SELF_DELIVERY_GRACE_SECS))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let claimed =
            self.outbox
                .claim_pending(&self.owner, &lease_expiry, &not_before, CLAIM_BATCH_SIZE)?;
        stats.claimed = claimed.len();

        for delivery in &claimed {
            match self.worker.process_one(delivery) {
                Ok(ProcessOutcome::Delivered) => stats.delivered += 1,
                Ok(ProcessOutcome::Released) => stats.released += 1,
                Ok(ProcessOutcome::Expired) => stats.expired += 1,
                Err(error) => {
                    stats.failed += 1;
                    log::warn!(
                        "[CompletionDispatcher] Failed to process delivery {} (run={}): {}",
                        delivery.delivery_id,
                        delivery.run_id,
                        error
                    );
                    // 失败一律归还租约，下轮重试（attempt_count 上限兜底）
                    let _ = self
                        .outbox
                        .release_claim(&delivery.delivery_id, &self.owner);
                    stats.released += 1;
                }
            }
        }
        Ok(stats)
    }
}

impl DeliveryWorker {
    /// 处理单行：失效判定 → 父忙暂缓 → 查重/补投 → 补终态 →
    /// 有窗 emit / 无窗 headless 唤醒轮 → delivered。
    fn process_one(&self, delivery: &CompletionDelivery) -> Result<ProcessOutcome, String> {
        // 1. 失效判定（expired 只落库不唤醒，自然也不会走到唤醒分支）
        if delivery.attempt_count > MAX_ATTEMPTS {
            self.outbox
                .mark_expired(&delivery.delivery_id, Some(&self.owner))?;
            log::warn!(
                "[CompletionDispatcher] Expired delivery {} after {} attempts",
                delivery.delivery_id,
                delivery.attempt_count
            );
            return Ok(ProcessOutcome::Expired);
        }
        if !self.workspace_db_exists(&delivery.workspace_id) {
            self.outbox
                .mark_expired(&delivery.delivery_id, Some(&self.owner))?;
            log::info!(
                "[CompletionDispatcher] Expired delivery {}: workspace {} database gone",
                delivery.delivery_id,
                delivery.workspace_id
            );
            return Ok(ProcessOutcome::Expired);
        }
        if self.target_session_gone(&delivery.target_session_id)? {
            self.outbox
                .mark_expired(&delivery.delivery_id, Some(&self.owner))?;
            log::info!(
                "[CompletionDispatcher] Expired delivery {}: target session {} gone",
                delivery.delivery_id,
                delivery.target_session_id
            );
            return Ok(ProcessOutcome::Expired);
        }

        // 2. 父会话忙（活跃流注册）→ 暂缓。唤醒/emit 早了也只会排队，等空闲
        //    再通知可以减少重复唤醒噪音；inbox 持久化不急于这一跳。
        if self
            .chat_v2_state
            .has_active_stream(&delivery.target_session_id)
        {
            self.outbox
                .release_claim(&delivery.delivery_id, &self.owner)?;
            return Ok(ProcessOutcome::Released);
        }

        // 3. 查重 → 缺则补投 inbox Result 消息（权威投递）。
        let ws_db_path = self.workspace_db_path(&delivery.workspace_id);
        let already_persisted = {
            let ws_conn = rusqlite::Connection::open(&ws_db_path)
                .map_err(|e| format!("open workspace db for dedup check: {}", e))?;
            let _ = ws_conn.execute_batch("PRAGMA busy_timeout = 5000;");
            completion_message_exists(&ws_conn, &delivery.workspace_id, &delivery.run_id)?
        };
        if !already_persisted {
            self.redeliver_inbox_message(delivery)?;
        }

        // 4. task 终态补偿：仅 pending/running 补齐（unknown 留给用户决策路径，
        //    终态本就收敛）。失败仅记录——消息投递优先于 task 簿记。
        self.compensate_task_terminal_state(delivery);

        // 5. 有窗 → emit 前端快路径 + delivered（G03-a 行为不变）；
        //    无窗 → delivered + 后端 headless 唤醒轮（G03-d）。
        if (self.has_window)() {
            let payload: serde_json::Value = serde_json::from_str(&delivery.payload_json)
                .map_err(|e| format!("corrupt payload_json for {}: {}", delivery.delivery_id, e))?;
            if let Err(e) = (self.emit_completion)(&payload) {
                // emit 失败（窗口刚好全部消失等）：不标 delivered，下轮重试
                let _ = self
                    .outbox
                    .release_claim(&delivery.delivery_id, &self.owner);
                return Err(format!(
                    "emit {} failed: {}",
                    WORKSPACE_AGENT_COMPLETION_EVENT, e
                ));
            }
            self.outbox
                .mark_delivered(&delivery.delivery_id, &self.owner)?;
            log::info!(
                "[CompletionDispatcher] Delivered completion {} (run={}, target={})",
                delivery.delivery_id,
                delivery.run_id,
                delivery.target_session_id
            );
            return Ok(ProcessOutcome::Delivered);
        }

        // 无窗分支：先收敛 delivered——delivered 终态即"唤醒责任已消费"标记
        // （复用现有状态机防重入：终态行永不再被 claim，同一行只唤醒一次），
        // 再排后端 headless 唤醒轮。mark_delivered 的 owner 守卫失败
        // （won=false）说明完成闭包自投递并发抢先收敛，唤醒责任随之移交
        // 闭包 emit 的前端快路径，本行不再排唤醒轮。
        let won = self
            .outbox
            .mark_delivered(&delivery.delivery_id, &self.owner)?;
        if !won {
            log::info!(
                "[CompletionDispatcher] Delivery {} already settled concurrently; skipping duplicate wake",
                delivery.delivery_id
            );
            return Ok(ProcessOutcome::Delivered);
        }
        let scheduled = self.wake.schedule(WakeTurnRequest {
            session_id: delivery.target_session_id.clone(),
            prompt: wake_prompt_from_delivery(delivery),
            delivery_id: delivery.delivery_id.clone(),
            run_id: delivery.run_id.clone(),
        });
        if !scheduled {
            log::warn!(
                "[CompletionDispatcher] Wake turn spawn rejected (shutdown); delivery {} stays delivered with inbox fallback",
                delivery.delivery_id
            );
        }
        log::info!(
            "[CompletionDispatcher] Delivered completion {} (run={}, target={}) via headless wake turn (scheduled={})",
            delivery.delivery_id,
            delivery.run_id,
            delivery.target_session_id,
            scheduled
        );
        Ok(ProcessOutcome::Delivered)
    }

    /// 补投 inbox Result 消息（payload_json 即完成闭包 send_message 的原始
    /// content，保持字节一致以维持查重/审计口径统一）。
    fn redeliver_inbox_message(&self, delivery: &CompletionDelivery) -> Result<(), String> {
        use super::workspace::MessageType;
        let message = self.coordinator.send_message(
            &delivery.workspace_id,
            &delivery.agent_session_id,
            Some(&delivery.target_session_id),
            MessageType::Result,
            delivery.payload_json.clone(),
        )?;
        // metadata 与完成闭包口径一致：envelope 全量（含 run_id/correlation_id）
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&delivery.payload_json) {
            let _ = self.coordinator.update_message_metadata(
                &delivery.workspace_id,
                &message.id,
                &value,
            );
        }
        Ok(())
    }

    /// 把仍处于 pending/running 的关联 task 补到 envelope 对应的终态。
    /// Unknown 不碰（用户决策态）；其他失败（含并发下已被迁移）仅记录。
    fn compensate_task_terminal_state(&self, delivery: &CompletionDelivery) {
        let Some(task_id) = delivery.task_id.as_deref() else {
            return;
        };
        let Some(target) = envelope_terminal_status(delivery) else {
            return;
        };
        let task_manager = match self.coordinator.get_task_manager(&delivery.workspace_id) {
            Ok(tm) => tm,
            Err(e) => {
                log::warn!(
                    "[CompletionDispatcher] No task manager for {}: {}",
                    delivery.workspace_id,
                    e
                );
                return;
            }
        };
        let task = match task_manager.get_task(task_id) {
            Ok(Some(task)) => task,
            _ => return,
        };
        if !matches!(
            task.status,
            SubagentTaskStatus::Pending | SubagentTaskStatus::Running
        ) {
            return;
        }
        let summary = envelope_summary(delivery);
        if let Err(e) = task_manager.update_status(task_id, target.clone(), summary.as_deref()) {
            log::warn!(
                "[CompletionDispatcher] Failed to compensate task {} to {:?}: {:?}",
                task_id,
                target,
                e
            );
        }
    }

    fn workspace_db_path(&self, workspace_id: &str) -> PathBuf {
        self.workspaces_dir.join(format!("ws_{}.db", workspace_id))
    }

    fn workspace_db_exists(&self, workspace_id: &str) -> bool {
        self.workspace_db_path(workspace_id).exists()
    }

    /// 父会话不存在或已删除（PersistStatus::Deleted）→ true。
    /// 查询失败按"未失效"处理（保守：宁可多试一轮，不误杀投递）。
    fn target_session_gone(&self, target_session_id: &str) -> Result<bool, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        match ChatV2Repo::get_session_with_conn(&conn, target_session_id) {
            Ok(Some(session)) => Ok(matches!(session.persist_status, PersistStatus::Deleted)),
            Ok(None) => Ok(true),
            Err(e) => {
                log::warn!(
                    "[CompletionDispatcher] Failed to check target session {}: {}",
                    target_session_id,
                    e
                );
                Ok(false)
            }
        }
    }
}

enum ProcessOutcome {
    Delivered,
    Released,
    Expired,
}
/// 从 envelope payload 解析终态（completed/failed/cancelled → task 终态）。
fn envelope_terminal_status(delivery: &CompletionDelivery) -> Option<SubagentTaskStatus> {
    let value: serde_json::Value = serde_json::from_str(&delivery.payload_json).ok()?;
    match value.get("status").and_then(|s| s.as_str()) {
        Some("completed") => Some(SubagentTaskStatus::Completed),
        Some("failed") => Some(SubagentTaskStatus::Failed),
        Some("cancelled") => Some(SubagentTaskStatus::Cancelled),
        _ => None,
    }
}

/// task 终态补偿用的摘要：优先 final_output，否则 error；截断到与完成闭包
/// 相同的 4000 字符预算。
fn envelope_summary(delivery: &CompletionDelivery) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(&delivery.payload_json).ok()?;
    let raw = value
        .get("final_output")
        .or_else(|| value.get("error"))
        .and_then(|s| s.as_str())?;
    const MAX_CHARS: usize = 4000;
    let truncated: String = raw.chars().take(MAX_CHARS).collect();
    Some(truncated)
}

/// 启动常驻派发器（`background_tasks::spawn`，N10 关闭期返回 None——
/// 调用方不得假定任务已提交；None 时遗留行等下次启动收敛，无额外风险）。
pub fn spawn_completion_dispatcher(
    deps: CompletionDispatcherDeps,
) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let dispatcher = CompletionDispatcher::new(deps);
    crate::background_tasks::spawn(async move {
        let mut interval = tokio::time::interval(TICK_INTERVAL);
        // interval 首次 tick 立即返回——跳过首次，给应用启动一个 stabilize 窗口
        interval.tick().await;
        loop {
            interval.tick().await;
            match dispatcher.tick() {
                Ok(stats) => {
                    if stats.claimed > 0 || stats.reclaimed > 0 {
                        log::info!(
                            "[CompletionDispatcher] tick: claimed={} delivered={} released={} expired={} failed={} reclaimed={}",
                            stats.claimed,
                            stats.delivered,
                            stats.released,
                            stats.expired,
                            stats.failed,
                            stats.reclaimed
                        );
                    }
                }
                Err(e) => {
                    log::warn!("[CompletionDispatcher] tick failed: {}", e);
                }
            }
        }
    })
}

/// 供 restore 路径挂载的一次性启动守卫的序列化证明（测试钩子之外的
/// 生产挂载点见 workspace_handlers::workspace_restore_executions）。
#[derive(Debug, Serialize)]
pub struct DispatcherInfo {
    pub owner: String,
    pub tick_interval_ms: u64,
    pub lease_secs: i64,
    pub max_attempts: i64,
}

impl CompletionDispatcher {
    pub fn info(&self) -> DispatcherInfo {
        DispatcherInfo {
            owner: self.owner.clone(),
            tick_interval_ms: TICK_INTERVAL.as_millis() as u64,
            lease_secs: LEASE_SECS,
            max_attempts: MAX_ATTEMPTS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::completion_outbox::{CompletionDeliveryState, NewCompletionDelivery};
    use crate::data_governance::migration::coordinator::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use rusqlite::params;
    use tempfile::TempDir;

    /// 与 connector_ledger 测试同款的 chat_v2 测试库（含 V20260908 迁移）。
    fn setup_chat_db() -> (TempDir, Arc<ChatV2Database>) {
        let temp_dir = TempDir::new().expect("temp dir");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("ChatV2 migrations should apply cleanly");
        let db = ChatV2Database::new(temp_dir.path()).expect("database");
        (temp_dir, Arc::new(db))
    }

    /// 建立最小 workspace 库（只含 message/subagent_task 表——dispatcher
    /// 只读查询路径只触碰这两张表）。
    fn setup_workspace_db(workspaces_dir: &std::path::Path, workspace_id: &str) {
        std::fs::create_dir_all(workspaces_dir).expect("workspaces dir");
        let conn =
            rusqlite::Connection::open(workspaces_dir.join(format!("ws_{}.db", workspace_id)))
                .expect("workspace db");
        conn.execute_batch(
            "CREATE TABLE message (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                sender_session_id TEXT NOT NULL,
                target_session_id TEXT,
                message_type TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                metadata_json TEXT
            );
            CREATE TABLE subagent_task (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                agent_session_id TEXT NOT NULL,
                skill_id TEXT,
                initial_task TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                result_summary TEXT
            );",
        )
        .expect("workspace schema");
    }

    fn insert_parent_session(db: &Arc<ChatV2Database>, session_id: &str) {
        let conn = db.get_conn().expect("conn");
        conn.execute(
            "INSERT INTO chat_v2_sessions (
                id, mode, title, persist_status, created_at, updated_at
             ) VALUES (?1, 'chat', 'parent', 'active', '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z')",
            params![session_id],
        )
        .expect("insert parent session");
    }

    fn envelope_json(run_id: &str, task_id: &str, target: &str, workspace: &str) -> String {
        serde_json::json!({
            "type": "agent_completion",
            "workspace_id": workspace,
            "agent_session_id": "agent_1",
            "parent_session_id": target,
            "task_id": task_id,
            "run_id": run_id,
            "status": "completed",
            "final_output": "done",
            "completed_at": "2026-09-08T00:00:00Z",
        })
        .to_string()
    }

    /// 无窗口依赖的 dispatcher 测试替身：把 emit/窗口判定抽象掉，直接驱动
    /// process_one 的持久化分支。生产 emit 路径由 tauri AppHandle 承载，
    /// 无法在单测构造；这里验证"投递幂等 + 失效判定 + 终态补偿"。
    struct TestDispatcher {
        outbox: CompletionOutbox,
        db: Arc<ChatV2Database>,
        workspaces_dir: PathBuf,
        owner: String,
    }

    /// 测试替身的收敛结果（emit/窗口分支不在单测覆盖内）。
    #[derive(Debug, PartialEq, Eq)]
    enum ConvergeOutcome {
        Delivered,
        Expired,
        NeedsRedelivery,
    }

    impl TestDispatcher {
        /// 复刻 process_one 的失效判定 + 查重收敛（无 emit/window 分支）。
        fn converge(&self, delivery: &CompletionDelivery) -> ConvergeOutcome {
            if delivery.attempt_count > MAX_ATTEMPTS {
                self.outbox
                    .mark_expired(&delivery.delivery_id, Some(&self.owner))
                    .unwrap();
                return ConvergeOutcome::Expired;
            }
            if !self
                .workspaces_dir
                .join(format!("ws_{}.db", delivery.workspace_id))
                .exists()
            {
                self.outbox
                    .mark_expired(&delivery.delivery_id, Some(&self.owner))
                    .unwrap();
                return ConvergeOutcome::Expired;
            }
            {
                let conn = self.db.get_conn().expect("conn");
                match ChatV2Repo::get_session_with_conn(&conn, &delivery.target_session_id) {
                    Ok(Some(session))
                        if !matches!(session.persist_status, PersistStatus::Deleted) => {}
                    Ok(_) => {
                        self.outbox
                            .mark_expired(&delivery.delivery_id, Some(&self.owner))
                            .unwrap();
                        return ConvergeOutcome::Expired;
                    }
                    Err(_) => {}
                }
            }
            let ws_conn = rusqlite::Connection::open(
                self.workspaces_dir
                    .join(format!("ws_{}.db", delivery.workspace_id)),
            )
            .expect("ws conn");
            if completion_message_exists(&ws_conn, &delivery.workspace_id, &delivery.run_id)
                .expect("dedup check")
            {
                self.outbox
                    .mark_delivered(&delivery.delivery_id, &self.owner)
                    .unwrap();
                return ConvergeOutcome::Delivered;
            }
            ConvergeOutcome::NeedsRedelivery
        }
    }

    fn claim_one(
        outbox: &CompletionOutbox,
        owner: &str,
        run_id: &str,
        created_at: String,
    ) -> CompletionDelivery {
        outbox
            .enqueue(&NewCompletionDelivery {
                delivery_id: format!("d-{run_id}"),
                task_id: Some(format!("task_{run_id}")),
                run_id: run_id.to_string(),
                workspace_id: "ws_1".to_string(),
                agent_session_id: "agent_1".to_string(),
                target_session_id: "parent_1".to_string(),
                target_generation: None,
                payload_json: envelope_json(run_id, &format!("task_{run_id}"), "parent_1", "ws_1"),
                created_at,
            })
            .unwrap();
        let lease = (chrono::Utc::now() + chrono::Duration::seconds(60))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let not_before = NewCompletionDelivery::now_timestamp();
        outbox
            .claim_pending(owner, &lease, &not_before, 10)
            .unwrap()
            .into_iter()
            .next()
            .expect("claimed")
    }

    #[test]
    fn g03_dedup_hit_converges_to_delivered_without_redelivery() {
        let (_dir, db) = setup_chat_db();
        let ws_dir = db.db_path().parent().unwrap().join("workspaces");
        setup_workspace_db(&ws_dir, "ws_1");
        insert_parent_session(&db, "parent_1");

        // 预置：inbox 已有该 run 的 result 消息（完成闭包已持久化）
        let ws_conn = rusqlite::Connection::open(ws_dir.join("ws_ws_1.db")).unwrap();
        ws_conn
            .execute(
                "INSERT INTO message (id, workspace_id, sender_session_id, message_type, content, created_at) \
                 VALUES ('m1', 'ws_1', 'agent_1', 'result', ?1, 't')",
                params![envelope_json("run-1", "task_run-1", "parent_1", "ws_1")],
            )
            .unwrap();
        drop(ws_conn);

        let outbox = CompletionOutbox::new(db.clone());
        let dispatcher = TestDispatcher {
            outbox: outbox.clone(),
            db,
            workspaces_dir: ws_dir,
            owner: "test-owner".to_string(),
        };
        let delivery = claim_one(&outbox, "test-owner", "run-1", past_grace_timestamp());

        match dispatcher.converge(&delivery) {
            ConvergeOutcome::Delivered => {}
            other => panic!("expected Delivered, got {:?}", other),
        }
        let row = outbox.get(&delivery.delivery_id).unwrap().unwrap();
        assert_eq!(row.state, CompletionDeliveryState::Delivered);
    }

    #[test]
    fn g03_missing_workspace_db_and_missing_parent_expire() {
        let (_dir, db) = setup_chat_db();
        let ws_dir = db.db_path().parent().unwrap().join("workspaces");
        // 注意：不建 ws_1 的库文件
        let outbox = CompletionOutbox::new(db.clone());
        let dispatcher = TestDispatcher {
            outbox: outbox.clone(),
            db: db.clone(),
            workspaces_dir: ws_dir.clone(),
            owner: "test-owner".to_string(),
        };

        // workspace db 不存在 → expired
        let d1 = claim_one(&outbox, "test-owner", "run-gone-ws", past_grace_timestamp());
        assert!(matches!(dispatcher.converge(&d1), ConvergeOutcome::Expired));

        // workspace 存在但父会话不存在 → expired
        setup_workspace_db(&ws_dir, "ws_1");
        let d2 = claim_one(
            &outbox,
            "test-owner",
            "run-gone-parent",
            past_grace_timestamp(),
        );
        assert!(matches!(dispatcher.converge(&d2), ConvergeOutcome::Expired));

        // 父会话软删 → expired
        insert_parent_session(&db, "parent_1");
        {
            let conn = db.get_conn().unwrap();
            conn.execute(
                "UPDATE chat_v2_sessions SET persist_status = 'deleted' WHERE id = 'parent_1'",
                [],
            )
            .unwrap();
        }
        let d3 = claim_one(
            &outbox,
            "test-owner",
            "run-deleted-parent",
            past_grace_timestamp(),
        );
        assert!(matches!(dispatcher.converge(&d3), ConvergeOutcome::Expired));

        // expired 终态不再被认领
        let lease = (chrono::Utc::now() + chrono::Duration::seconds(60))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let claimed = outbox
            .claim_pending(
                "test-owner",
                &lease,
                &NewCompletionDelivery::now_timestamp(),
                10,
            )
            .unwrap();
        assert!(claimed.is_empty());
    }

    #[test]
    fn g03_attempt_cap_expires() {
        let (_dir, db) = setup_chat_db();
        let ws_dir = db.db_path().parent().unwrap().join("workspaces");
        setup_workspace_db(&ws_dir, "ws_1");
        insert_parent_session(&db, "parent_1");

        let outbox = CompletionOutbox::new(db.clone());
        let dispatcher = TestDispatcher {
            outbox: outbox.clone(),
            db,
            workspaces_dir: ws_dir,
            owner: "test-owner".to_string(),
        };
        let delivery = claim_one(&outbox, "test-owner", "run-cap", past_grace_timestamp());
        // 直接把 attempt_count 顶到上限之上（模拟长期无法投递的累积）
        {
            let conn = dispatcher.db.get_conn().unwrap();
            conn.execute(
                "UPDATE completion_outbox SET attempt_count = ?2 WHERE delivery_id = ?1",
                params![delivery.delivery_id, MAX_ATTEMPTS + 1],
            )
            .unwrap();
        }
        let inflated = outbox.get(&delivery.delivery_id).unwrap().unwrap();
        assert!(matches!(
            dispatcher.converge(&inflated),
            ConvergeOutcome::Expired
        ));
    }

    #[test]
    fn g03_missing_inbox_message_requires_redelivery() {
        let (_dir, db) = setup_chat_db();
        let ws_dir = db.db_path().parent().unwrap().join("workspaces");
        setup_workspace_db(&ws_dir, "ws_1");
        insert_parent_session(&db, "parent_1");

        let outbox = CompletionOutbox::new(db.clone());
        let dispatcher = TestDispatcher {
            outbox: outbox.clone(),
            db,
            workspaces_dir: ws_dir,
            owner: "test-owner".to_string(),
        };
        let delivery = claim_one(&outbox, "test-owner", "run-fresh", past_grace_timestamp());
        assert!(matches!(
            dispatcher.converge(&delivery),
            ConvergeOutcome::NeedsRedelivery
        ));
    }

    fn past_grace_timestamp() -> String {
        (chrono::Utc::now() - chrono::Duration::seconds(SELF_DELIVERY_GRACE_SECS + 60))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn g03_envelope_status_mapping() {
        let delivery = CompletionDelivery {
            delivery_id: "d".into(),
            task_id: Some("t".into()),
            run_id: "r".into(),
            workspace_id: "w".into(),
            agent_session_id: "a".into(),
            target_session_id: "p".into(),
            target_generation: None,
            payload_json: r#"{"status":"failed","error":"boom"}"#.into(),
            state: CompletionDeliveryState::Pending,
            claim_owner: None,
            claim_expiry: None,
            attempt_count: 0,
            created_at: "t".into(),
            delivered_at: None,
        };
        assert_eq!(
            envelope_terminal_status(&delivery),
            Some(SubagentTaskStatus::Failed)
        );
        assert_eq!(envelope_summary(&delivery).as_deref(), Some("boom"));
    }
}
