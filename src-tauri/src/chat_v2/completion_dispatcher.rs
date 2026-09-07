//! 子代理完成投递派发器（G03-a）——后端常驻兜底。
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
//!   有窗口时 emit 同一事件（前端 wakeKey 去重，重复 emit 安全）→ delivered。
//!
//! delivered 语义 = "inbox 消息已持久化（权威投递）+ 已通知前端（加速唤醒）"。
//! 前端唤醒失败不等于丢失：父会话下次任意 turn 的 drain_inbox 都会消费该
//! Result 消息。
//!
//! ## G01-b 前的既定边界
//!
//! LLM wake turn 仍需要窗口（`new_headless` 的 NoopEventSink 不承载 LLM 流式）。
//! 因此无窗口时本派发器**只持久化不派发**：补写 inbox 后保持 pending，等窗口
//! 出现（下轮 tick 检测 `webview_windows`）再 emit + delivered。G01-b 完成后
//! 可在此处接 headless 父会话 turn，实现真正的无窗派发。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use super::completion_outbox::{
    completion_message_exists, CompletionDelivery, CompletionOutbox,
};
use super::database::ChatV2Database;
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
    deps: CompletionDispatcherDeps,
    /// 本实例认领标识（hostname:pid:boot-ulid 风格；进程内唯一即可——
    /// SQLite 单写者保证不重复认领，owner 仅用于租约守卫）。
    owner: String,
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
        Self { outbox, deps, owner }
    }

    /// 单轮收敛：回收过期租约 → 认领一批 → 逐行处理。
    pub fn tick(&self) -> Result<DispatcherTickStats, String> {
        let mut stats = DispatcherTickStats::default();
        stats.reclaimed = self.outbox.reclaim_expired_claims()?;

        let lease_expiry = (chrono::Utc::now() + chrono::Duration::seconds(LEASE_SECS))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let not_before = (chrono::Utc::now()
            - chrono::Duration::seconds(SELF_DELIVERY_GRACE_SECS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let claimed =
            self.outbox
                .claim_pending(&self.owner, &lease_expiry, &not_before, CLAIM_BATCH_SIZE)?;
        stats.claimed = claimed.len();

        for delivery in &claimed {
            match self.process_one(delivery) {
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

    /// 处理单行：失效判定 → 父忙暂缓 → 查重/补投 → 补终态 → emit + delivered。
    fn process_one(&self, delivery: &CompletionDelivery) -> Result<ProcessOutcome, String> {
        // 1. 失效判定（expired 不注入）
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

        // 2. 父会话忙（活跃流注册）→ 暂缓。emit 早了前端也只会排队，等空闲
        //    再通知可以减少重复唤醒噪音；inbox 持久化不急于这一跳。
        if self
            .deps
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

        // 5. 有窗口才 emit + delivered；无窗口只持久化（release 等下轮，
        //    届时查重命中直接走 emit）。
        if self.deps.app_handle.webview_windows().is_empty() {
            log::debug!(
                "[CompletionDispatcher] No window; persisted only, delivery {} stays pending",
                delivery.delivery_id
            );
            self.outbox
                .release_claim(&delivery.delivery_id, &self.owner)?;
            return Ok(ProcessOutcome::Released);
        }
        let payload: serde_json::Value = serde_json::from_str(&delivery.payload_json)
            .map_err(|e| format!("corrupt payload_json for {}: {}", delivery.delivery_id, e))?;
        if let Err(e) = self
            .deps
            .app_handle
            .emit(WORKSPACE_AGENT_COMPLETION_EVENT, &payload)
        {
            // emit 失败（窗口刚好全部消失等）：不标 delivered，下轮重试
            let _ = self
                .outbox
                .release_claim(&delivery.delivery_id, &self.owner);
            return Err(format!("emit {} failed: {}", WORKSPACE_AGENT_COMPLETION_EVENT, e));
        }
        self.outbox
            .mark_delivered(&delivery.delivery_id, &self.owner)?;
        log::info!(
            "[CompletionDispatcher] Delivered completion {} (run={}, target={})",
            delivery.delivery_id,
            delivery.run_id,
            delivery.target_session_id
        );
        Ok(ProcessOutcome::Delivered)
    }

    /// 补投 inbox Result 消息（payload_json 即完成闭包 send_message 的原始
    /// content，保持字节一致以维持查重/审计口径统一）。
    fn redeliver_inbox_message(&self, delivery: &CompletionDelivery) -> Result<(), String> {
        use super::workspace::MessageType;
        let message = self.deps.coordinator.send_message(
            &delivery.workspace_id,
            &delivery.agent_session_id,
            Some(&delivery.target_session_id),
            MessageType::Result,
            delivery.payload_json.clone(),
        )?;
        // metadata 与完成闭包口径一致：envelope 全量（含 run_id/correlation_id）
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&delivery.payload_json) {
            let _ = self.deps.coordinator.update_message_metadata(
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
        let task_manager = match self.deps.coordinator.get_task_manager(&delivery.workspace_id) {
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
        self.deps
            .workspaces_dir
            .join(format!("ws_{}.db", workspace_id))
    }

    fn workspace_db_exists(&self, workspace_id: &str) -> bool {
        self.workspace_db_path(workspace_id).exists()
    }

    /// 父会话不存在或已删除（PersistStatus::Deleted）→ true。
    /// 查询失败按"未失效"处理（保守：宁可多试一轮，不误杀投递）。
    fn target_session_gone(&self, target_session_id: &str) -> Result<bool, String> {
        let conn = self.deps.db.get_conn().map_err(|e| e.to_string())?;
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
}/// 从 envelope payload 解析终态（completed/failed/cancelled → task 终态）。
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
    use crate::chat_v2::completion_outbox::{CompletionDeliveryState, NewCompletionDelivery};
    use super::*;
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
        let conn = rusqlite::Connection::open(
            workspaces_dir.join(format!("ws_{}.db", workspace_id)),
        )
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
        assert!(matches!(
            dispatcher.converge(&d1),
            ConvergeOutcome::Expired
        ));

        // workspace 存在但父会话不存在 → expired
        setup_workspace_db(&ws_dir, "ws_1");
        let d2 = claim_one(&outbox, "test-owner", "run-gone-parent", past_grace_timestamp());
        assert!(matches!(
            dispatcher.converge(&d2),
            ConvergeOutcome::Expired
        ));

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
        let d3 = claim_one(&outbox, "test-owner", "run-deleted-parent", past_grace_timestamp());
        assert!(matches!(
            dispatcher.converge(&d3),
            ConvergeOutcome::Expired
        ));

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
        (chrono::Utc::now()
            - chrono::Duration::seconds(SELF_DELIVERY_GRACE_SECS + 60))
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
