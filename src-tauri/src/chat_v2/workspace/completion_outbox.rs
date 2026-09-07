//! 子代理完成投递持久账本（G03-a）——repo 层。
//!
//! 权威状态在 chat_v2 主库 `completion_outbox` 表（迁移 V20260908）。
//! 旧链路里"worker 完成 → 唤醒父会话"的责任 100% 在前端 subagentIdleWake
//! 内存队列：父 store 2 分钟重试上限后永久放弃、进程重启即丢。本表把完成
//! 信封固化为持久行，后端 CompletionDispatcher 以租约轮询收敛到 delivered。
//!
//! ## 事务边界（跨库对账口径）
//!
//! 完成闭包涉及两个库：inbox Result 消息与 task 终态在 workspace 独立库
//! （`ws_{id}.db`），outbox 在 chat_v2 主库，无法同事务。约定顺序：
//!
//! 1. outbox INSERT（pending）——**先落账本**，保证"完成事实"有源可循；
//! 2. workspace 库：send_message（inbox）→ task 终态；
//! 3. outbox UPDATE delivered——闭包自投递完成；
//! 4. emit（前端快路径）。
//!
//! 崩溃遗留的 pending 行由 dispatcher 对账：按 run_id 在 workspace message
//! 表查重，命中即收敛 delivered，未命中则补投 send_message 后收敛。
//! 反向（先写终态后写账本）会让"已投递但无账本痕迹"成为永久盲区，禁止。
//!
//! ## 状态机
//!
//! - `pending` → `claimed`（dispatcher 租约认领）/ `delivered`（闭包自投递）
//!   / `expired`（目标失效判定先于认领时）
//! - `claimed` → `delivered` / `expired`（owner 守卫）/ `pending`（租约过期
//!   被 reclaim，或处理暂缓被 release）
//! - `delivered` / `expired` 为终态。

use std::sync::Arc;

use chrono::Utc;
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

// 本文件物理上位于 workspace/ 目录，但经 `#[path]` 挂在 `chat_v2` 模块下
// （chat_v2/mod.rs），引用按模块树解析。
use crate::chat_v2::database::ChatV2Database;

/// 投递状态（与迁移 V20260908 的 CHECK 约束一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionDeliveryState {
    Pending,
    Claimed,
    Delivered,
    Expired,
}

impl CompletionDeliveryState {
    pub const ALL: [Self; 4] = [Self::Pending, Self::Claimed, Self::Delivered, Self::Expired];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Delivered => "delivered",
            Self::Expired => "expired",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|s| s.as_str() == raw)
    }
}

/// `completion_outbox` 表的完整行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionDelivery {
    pub delivery_id: String,
    pub task_id: Option<String>,
    pub run_id: String,
    pub workspace_id: String,
    pub agent_session_id: String,
    pub target_session_id: String,
    pub target_generation: Option<String>,
    pub payload_json: String,
    pub state: CompletionDeliveryState,
    pub claim_owner: Option<String>,
    pub claim_expiry: Option<String>,
    pub attempt_count: i64,
    pub created_at: String,
    pub delivered_at: Option<String>,
}

impl CompletionDelivery {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let state_raw: String = row.get("state")?;
        let state = CompletionDeliveryState::parse(&state_raw).ok_or_else(|| {
            let index = row.as_ref().column_index("state").unwrap_or(usize::MAX);
            rusqlite::Error::InvalidColumnType(index, state_raw.clone(), rusqlite::types::Type::Text)
        })?;
        Ok(Self {
            delivery_id: row.get("delivery_id")?,
            task_id: row.get("task_id")?,
            run_id: row.get("run_id")?,
            workspace_id: row.get("workspace_id")?,
            agent_session_id: row.get("agent_session_id")?,
            target_session_id: row.get("target_session_id")?,
            target_generation: row.get("target_generation")?,
            payload_json: row.get("payload_json")?,
            state,
            claim_owner: row.get("claim_owner")?,
            claim_expiry: row.get("claim_expiry")?,
            attempt_count: row.get("attempt_count")?,
            created_at: row.get("created_at")?,
            delivered_at: row.get("delivered_at")?,
        })
    }
}

/// 新建投递的写入参数。
#[derive(Debug, Clone)]
pub struct NewCompletionDelivery {
    pub delivery_id: String,
    pub task_id: Option<String>,
    pub run_id: String,
    pub workspace_id: String,
    pub agent_session_id: String,
    pub target_session_id: String,
    pub target_generation: Option<String>,
    pub payload_json: String,
    pub created_at: String,
}

impl NewCompletionDelivery {
    /// 生成固定毫秒宽度的时间戳：等宽 RFC3339 的字典序与时间序一致，
    /// claim 的 created_at 宽限期比较与 claim_expiry 过期比较依赖该性质。
    pub fn now_timestamp() -> String {
        Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

/// enqueue 结果：插入成功，或同 run_id 行已存在（幂等命中）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueOutcome {
    Inserted,
    DuplicateRun,
}

/// 完成投递账本 repo。所有状态迁移以单条原子 UPDATE 完成。
#[derive(Clone)]
pub struct CompletionOutbox {
    db: Arc<ChatV2Database>,
}

impl CompletionOutbox {
    pub fn new(db: Arc<ChatV2Database>) -> Self {
        Self { db }
    }

    /// 完成事实入帐（pending）。`run_id` 唯一：重复入帐（完成闭包重入等）
    /// 静默命中 [`EnqueueOutcome::DuplicateRun`]，不产生第二行。
    pub fn enqueue(&self, new: &NewCompletionDelivery) -> Result<EnqueueOutcome, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO completion_outbox (
                    delivery_id, task_id, run_id, workspace_id, agent_session_id,
                    target_session_id, target_generation, payload_json,
                    state, attempt_count, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 0, ?9)",
                params![
                    new.delivery_id,
                    new.task_id,
                    new.run_id,
                    new.workspace_id,
                    new.agent_session_id,
                    new.target_session_id,
                    new.target_generation,
                    new.payload_json,
                    new.created_at,
                ],
            )
            .map_err(|e| format!("failed to enqueue completion delivery: {}", e))?;
        Ok(if changed == 1 {
            EnqueueOutcome::Inserted
        } else {
            EnqueueOutcome::DuplicateRun
        })
    }

    /// 按主键读取。
    pub fn get(&self, delivery_id: &str) -> Result<Option<CompletionDelivery>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT * FROM completion_outbox WHERE delivery_id = ?1",
            params![delivery_id],
            CompletionDelivery::from_row,
        )
        .optional()
        .map_err(|e| format!("failed to read completion delivery: {}", e))
    }

    /// 按幂等键读取。
    pub fn get_by_run_id(&self, run_id: &str) -> Result<Option<CompletionDelivery>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT * FROM completion_outbox WHERE run_id = ?1",
            params![run_id],
            CompletionDelivery::from_row,
        )
        .optional()
        .map_err(|e| format!("failed to read completion delivery by run_id: {}", e))
    }

    /// 完成闭包自投递成功后直接收敛：pending|claimed → delivered。
    ///
    /// 不走 claim（闭包自身即投递者）。允许从 claimed 收敛是防御 dispatcher
    /// 恰好先认领了同一行的竞态：无论谁先，事实都是"已投递"。
    /// 返回是否有行被收敛（false = 行不存在或已终态，幂等）。
    pub fn mark_delivered_by_delivery_id(&self, delivery_id: &str) -> Result<bool, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE completion_outbox \
                 SET state = 'delivered', delivered_at = ?2, claim_owner = NULL, claim_expiry = NULL \
                 WHERE delivery_id = ?1 AND state IN ('pending', 'claimed')",
                params![delivery_id, NewCompletionDelivery::now_timestamp()],
            )
            .map_err(|e| format!("failed to mark completion delivered: {}", e))?;
        Ok(changed == 1)
    }

    /// dispatcher：回收过期租约（claimed 且 claim_expiry 已过 → pending）。
    /// 处理崩溃/卡住的认领；owner 存活的行由 owner 自己负责，不会被误收
    /// （lease 时长覆盖单次处理耗时一个数量级以上）。
    pub fn reclaim_expired_claims(&self) -> Result<usize, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE completion_outbox \
                 SET state = 'pending', claim_owner = NULL, claim_expiry = NULL \
                 WHERE state = 'claimed' AND claim_expiry IS NOT NULL AND claim_expiry <= ?1",
                params![NewCompletionDelivery::now_timestamp()],
            )
            .map_err(|e| format!("failed to reclaim expired completion claims: {}", e))?;
        Ok(changed)
    }

    /// dispatcher：原子认领一批 pending 行。
    ///
    /// `not_before`：只认领 created_at 早于该时刻的行——给在途完成闭包一个
    /// 自投递宽限期，避免 dispatcher 与闭包对同一行并发补投。单条
    /// UPDATE...IN(SELECT) 在 SQLite 单写者语义下原子，多 dispatcher 实例
    /// 不会重复认领同一行。
    pub fn claim_pending(
        &self,
        owner: &str,
        lease_expiry: &str,
        not_before: &str,
        limit: i64,
    ) -> Result<Vec<CompletionDelivery>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE completion_outbox \
             SET state = 'claimed', claim_owner = ?1, claim_expiry = ?2, \
                 attempt_count = attempt_count + 1 \
             WHERE delivery_id IN (
                 SELECT delivery_id FROM completion_outbox \
                 WHERE state = 'pending' AND created_at <= ?3 \
                 ORDER BY created_at \
                 LIMIT ?4
             )",
            params![owner, lease_expiry, not_before, limit],
        )
        .map_err(|e| format!("failed to claim pending completions: {}", e))?;

        // 取回本批：owner + 本次租约到期时间双重限定。
        let mut stmt = conn
            .prepare(
                "SELECT * FROM completion_outbox \
                 WHERE state = 'claimed' AND claim_owner = ?1 AND claim_expiry = ?2 \
                 ORDER BY created_at",
            )
            .map_err(|e| format!("failed to prepare claimed completions query: {}", e))?;
        let rows = stmt
            .query_map(params![owner, lease_expiry], CompletionDelivery::from_row)
            .map_err(|e| format!("failed to list claimed completions: {}", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("failed to parse completion delivery: {}", e))?);
        }
        Ok(out)
    }

    /// dispatcher：处理暂缓（父会话忙 / 无窗口 / task 待用户决策），
    /// 归还租约回 pending 等下轮。owner 守卫防止误放他人认领。
    pub fn release_claim(&self, delivery_id: &str, owner: &str) -> Result<bool, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE completion_outbox \
                 SET state = 'pending', claim_owner = NULL, claim_expiry = NULL \
                 WHERE delivery_id = ?1 AND state = 'claimed' AND claim_owner = ?2",
                params![delivery_id, owner],
            )
            .map_err(|e| format!("failed to release completion claim: {}", e))?;
        Ok(changed == 1)
    }

    /// dispatcher：投递完成（owner 守卫）。claimed → delivered。
    pub fn mark_delivered(&self, delivery_id: &str, owner: &str) -> Result<bool, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE completion_outbox \
                 SET state = 'delivered', delivered_at = ?3, claim_owner = NULL, claim_expiry = NULL \
                 WHERE delivery_id = ?1 AND state = 'claimed' AND claim_owner = ?2",
                params![delivery_id, owner, NewCompletionDelivery::now_timestamp()],
            )
            .map_err(|e| format!("failed to mark completion delivered: {}", e))?;
        Ok(changed == 1)
    }

    /// dispatcher：目标失效（父会话已删除 / workspace 已删除 / 超尝试上限）。
    /// 允许从 pending 或本 owner 的 claimed 收敛，终态不注入。
    pub fn mark_expired(&self, delivery_id: &str, owner: Option<&str>) -> Result<bool, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let changed = match owner {
            Some(owner) => conn.execute(
                "UPDATE completion_outbox \
                 SET state = 'expired', claim_owner = NULL, claim_expiry = NULL \
                 WHERE delivery_id = ?1 AND (state = 'pending' \
                     OR (state = 'claimed' AND claim_owner = ?2))",
                params![delivery_id, owner],
            ),
            None => conn.execute(
                "UPDATE completion_outbox \
                 SET state = 'expired', claim_owner = NULL, claim_expiry = NULL \
                 WHERE delivery_id = ?1 AND state = 'pending'",
                params![delivery_id],
            ),
        }
        .map_err(|e| format!("failed to expire completion delivery: {}", e))?;
        Ok(changed == 1)
    }
}

/// 查重：workspace 库 message 表是否已存在该 run_id 的 Result 消息。
///
/// 完成闭包的 `send_message(MessageType::Result, content=envelope_json)` 把
/// envelope 原文写入 content，`run_id` 经 json_extract 可比。本函数在
/// dispatcher 补投前调用，命中即无需再写（直接走 emit + delivered 收敛）。
pub fn completion_message_exists(
    ws_conn: &rusqlite::Connection,
    workspace_id: &str,
    run_id: &str,
) -> Result<bool, String> {
    let count: i64 = ws_conn
        .query_row(
            "SELECT COUNT(*) FROM message \
             WHERE workspace_id = ?1 AND message_type = 'result' \
               AND json_extract(content, '$.run_id') = ?2",
            params![workspace_id, run_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("failed to check completion message existence: {}", e))?;
    Ok(count > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_governance::migration::coordinator::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use tempfile::TempDir;

    /// 创建已应用全部 chat_v2 迁移的测试库（生产一致的迁移路径：
    /// MigrationCoordinator → refinery embed_migrations!，含本模块对应的
    /// V20260908 completion_outbox 表）。
    fn setup_test_db() -> (TempDir, Arc<ChatV2Database>) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("ChatV2 migrations should apply cleanly");
        let db = ChatV2Database::new(temp_dir.path()).expect("Failed to create database");
        (temp_dir, Arc::new(db))
    }

    fn new_delivery(delivery_id: &str, run_id: &str) -> NewCompletionDelivery {
        NewCompletionDelivery {
            delivery_id: delivery_id.to_string(),
            task_id: Some(format!("task_{run_id}")),
            run_id: run_id.to_string(),
            workspace_id: "ws_1".to_string(),
            agent_session_id: "agent_1".to_string(),
            target_session_id: "parent_1".to_string(),
            target_generation: Some("corr_1".to_string()),
            payload_json: r#"{"type":"agent_completion","run_id":"r"}"#.to_string(),
            created_at: NewCompletionDelivery::now_timestamp(),
        }
    }

    fn future_expiry() -> String {
        (Utc::now() + chrono::Duration::seconds(60))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn past_timestamp() -> String {
        (Utc::now() - chrono::Duration::seconds(3600))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn g03_migration_creates_completion_outbox_table() {
        let (_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("conn");
        let table: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master \
                 WHERE type = 'table' AND name = 'completion_outbox'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("query sqlite_master");
        assert_eq!(table.as_deref(), Some("completion_outbox"));
        for index in [
            "idx_completion_outbox_run",
            "idx_completion_outbox_state",
            "idx_completion_outbox_target",
        ] {
            let found: Option<String> = conn
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    params![index],
                    |row| row.get(0),
                )
                .optional()
                .expect("query index");
            assert_eq!(found.as_deref(), Some(index), "missing index {}", index);
        }
    }

    #[test]
    fn g03_enqueue_is_idempotent_by_run_id() {
        let (_dir, db) = setup_test_db();
        let outbox = CompletionOutbox::new(db);

        let first = outbox.enqueue(&new_delivery("d-1", "run-1")).unwrap();
        assert_eq!(first, EnqueueOutcome::Inserted);

        // 同 run_id 不同 delivery_id：幂等命中，不产生第二行
        let dup = outbox.enqueue(&new_delivery("d-2", "run-1")).unwrap();
        assert_eq!(dup, EnqueueOutcome::DuplicateRun);
        assert!(outbox.get("d-2").unwrap().is_none());
        assert_eq!(
            outbox.get_by_run_id("run-1").unwrap().unwrap().delivery_id,
            "d-1"
        );

        // 不同 run_id：正常入帐
        let other = outbox.enqueue(&new_delivery("d-3", "run-2")).unwrap();
        assert_eq!(other, EnqueueOutcome::Inserted);
    }

    #[test]
    fn g03_claim_grace_period_skips_fresh_rows() {
        let (_dir, db) = setup_test_db();
        let outbox = CompletionOutbox::new(db);
        outbox.enqueue(&new_delivery("d-1", "run-1")).unwrap();

        // not_before 取当前时刻：刚创建的行（created_at <= now 恒真）可被认领……
        let claimed = outbox
            .claim_pending("owner-a", &future_expiry(), &NewCompletionDelivery::now_timestamp(), 10)
            .unwrap();
        assert_eq!(claimed.len(), 1);

        // 重新造一行：not_before 取过去时刻（宽限期内），新行 created_at=now
        // 晚于 not_before → 不得被认领
        outbox.enqueue(&new_delivery("d-2", "run-2")).unwrap();
        let grace_not_before = (Utc::now() - chrono::Duration::seconds(60))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let claimed = outbox
            .claim_pending("owner-a", &future_expiry(), &grace_not_before, 10)
            .unwrap();
        assert!(
            claimed.iter().all(|d| d.delivery_id != "d-2"),
            "宽限期内的行不得被认领"
        );

        // 宽限期过后（not_before 覆盖其 created_at）该行可被认领
        let claimed = outbox
            .claim_pending("owner-a", &future_expiry(), &NewCompletionDelivery::now_timestamp(), 10)
            .unwrap();
        assert!(
            claimed.iter().any(|d| d.delivery_id == "d-2"),
            "宽限期外的行应可被认领"
        );
    }

    #[test]
    fn g03_claim_excludes_already_claimed_and_terminal() {
        let (_dir, db) = setup_test_db();
        let outbox = CompletionOutbox::new(db);
        outbox.enqueue(&new_delivery("d-1", "run-1")).unwrap();
        outbox.enqueue(&new_delivery("d-2", "run-2")).unwrap();

        let not_before = NewCompletionDelivery::now_timestamp();
        let claimed = outbox
            .claim_pending("owner-a", &future_expiry(), &not_before, 10)
            .unwrap();
        assert_eq!(claimed.len(), 2);

        // 已被 owner-a 认领的行对 owner-b 不可见
        let claimed_b = outbox
            .claim_pending("owner-b", &future_expiry(), &not_before, 10)
            .unwrap();
        assert!(claimed_b.is_empty());

        // delivered 终态不再被认领
        assert!(outbox.mark_delivered("d-1", "owner-a").unwrap());
        let claimed_a2 = outbox
            .claim_pending("owner-a", &future_expiry(), &NewCompletionDelivery::now_timestamp(), 10)
            .unwrap();
        assert!(claimed_a2.iter().all(|d| d.delivery_id != "d-1"));
    }

    #[test]
    fn g03_reclaim_expired_claims_returns_rows_to_pending() {
        let (_dir, db) = setup_test_db();
        let outbox = CompletionOutbox::new(db);
        outbox.enqueue(&new_delivery("d-1", "run-1")).unwrap();
        outbox.enqueue(&new_delivery("d-2", "run-2")).unwrap();

        // d-1 租约已过期（崩溃遗留），d-2 租约有效
        let not_before = NewCompletionDelivery::now_timestamp();
        let claimed = outbox
            .claim_pending("owner-dead", &past_timestamp(), &not_before, 1)
            .unwrap();
        assert_eq!(claimed.len(), 1);
        let claimed_alive = outbox
            .claim_pending("owner-alive", &future_expiry(), &not_before, 10)
            .unwrap();
        assert_eq!(claimed_alive.len(), 1);

        let reclaimed = outbox.reclaim_expired_claims().unwrap();
        assert_eq!(reclaimed, 1, "只有过期租约被回收");
        let row = outbox.get(&claimed[0].delivery_id).unwrap().unwrap();
        assert_eq!(row.state, CompletionDeliveryState::Pending);
        assert!(row.claim_owner.is_none());
        // 有效租约不受影响
        let alive = outbox
            .get(&claimed_alive[0].delivery_id)
            .unwrap()
            .unwrap();
        assert_eq!(alive.state, CompletionDeliveryState::Claimed);
        assert_eq!(alive.claim_owner.as_deref(), Some("owner-alive"));

        // 回收后可被重新认领
        let reclaimed_claim = outbox
            .claim_pending("owner-b", &future_expiry(), &NewCompletionDelivery::now_timestamp(), 10)
            .unwrap();
        assert_eq!(reclaimed_claim.len(), 1);
        assert_eq!(reclaimed_claim[0].delivery_id, claimed[0].delivery_id);
        // attempt_count 随认领单调递增
        assert_eq!(reclaimed_claim[0].attempt_count, 2);
    }

    #[test]
    fn g03_release_claim_and_owner_guards() {
        let (_dir, db) = setup_test_db();
        let outbox = CompletionOutbox::new(db);
        outbox.enqueue(&new_delivery("d-1", "run-1")).unwrap();

        let claimed = outbox
            .claim_pending("owner-a", &future_expiry(), &NewCompletionDelivery::now_timestamp(), 10)
            .unwrap();
        assert_eq!(claimed.len(), 1);

        // owner 守卫：他人不能 release / delivered / claimed-expire 本行
        assert!(!outbox.release_claim("d-1", "owner-b").unwrap());
        assert!(!outbox.mark_delivered("d-1", "owner-b").unwrap());
        assert!(!outbox.mark_expired("d-1", Some("owner-b")).unwrap());
        assert_eq!(
            outbox.get("d-1").unwrap().unwrap().state,
            CompletionDeliveryState::Claimed
        );

        // release 后回 pending，可再认领
        assert!(outbox.release_claim("d-1", "owner-a").unwrap());
        assert_eq!(
            outbox.get("d-1").unwrap().unwrap().state,
            CompletionDeliveryState::Pending
        );
        let reclaimed = outbox
            .claim_pending("owner-b", &future_expiry(), &NewCompletionDelivery::now_timestamp(), 10)
            .unwrap();
        assert_eq!(reclaimed.len(), 1);
        assert!(outbox.mark_delivered("d-1", "owner-b").unwrap());
        let row = outbox.get("d-1").unwrap().unwrap();
        assert_eq!(row.state, CompletionDeliveryState::Delivered);
        assert!(row.delivered_at.is_some());
    }

    #[test]
    fn g03_terminal_states_reject_further_transitions() {
        let (_dir, db) = setup_test_db();
        let outbox = CompletionOutbox::new(db);
        outbox.enqueue(&new_delivery("d-1", "run-1")).unwrap();
        outbox.enqueue(&new_delivery("d-2", "run-2")).unwrap();

        // 闭包自投递收敛路径：pending → delivered（无需 claim）
        assert!(outbox.mark_delivered_by_delivery_id("d-1").unwrap());
        // 幂等：再次收敛返回 false，状态不倒退
        assert!(!outbox.mark_delivered_by_delivery_id("d-1").unwrap());
        assert_eq!(
            outbox.get("d-1").unwrap().unwrap().state,
            CompletionDeliveryState::Delivered
        );

        // expired 终态
        assert!(outbox.mark_expired("d-2", None).unwrap());
        assert!(!outbox.mark_expired("d-2", None).unwrap());
        assert!(!outbox.mark_delivered_by_delivery_id("d-2").unwrap());
        let claimed = outbox
            .claim_pending("owner-a", &future_expiry(), &NewCompletionDelivery::now_timestamp(), 10)
            .unwrap();
        assert!(claimed.is_empty(), "终态行不得被认领");
    }

    #[test]
    fn g03_completion_message_exists_matches_by_run_id() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
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
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (id, workspace_id, sender_session_id, message_type, content, created_at) \
             VALUES ('m1', 'ws_1', 'agent_1', 'result', '{\"type\":\"agent_completion\",\"run_id\":\"run-1\"}', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (id, workspace_id, sender_session_id, message_type, content, created_at) \
             VALUES ('m2', 'ws_1', 'agent_1', 'progress', '{\"run_id\":\"run-2\"}', 't')",
            [],
        )
        .unwrap();

        assert!(completion_message_exists(&conn, "ws_1", "run-1").unwrap());
        // progress 类型不算完成投递
        assert!(!completion_message_exists(&conn, "ws_1", "run-2").unwrap());
        // 其他 workspace 隔离
        assert!(!completion_message_exists(&conn, "ws_2", "run-1").unwrap());
    }

    #[test]
    fn g03_target_state_check_constraint() {
        let (_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("conn");
        let err = conn
            .execute(
                "INSERT INTO completion_outbox (
                    delivery_id, run_id, workspace_id, agent_session_id,
                    target_session_id, payload_json, state, created_at
                 ) VALUES ('d-x', 'run-x', 'ws', 'agent', 'parent', '{}', 'bogus', 't')",
                [],
            )
            .expect_err("CHECK constraint must reject unknown state");
        assert!(err.to_string().contains("CHECK"), "got: {}", err);
    }
}
