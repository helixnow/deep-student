//! Super-agent 持久化存储（独立 SQLite 文件 `superagent.db`）。
//!
//! 为什么不用 chat_v2 主库：实验性功能，避免触碰 data_governance 的迁移/备份
//! 注册表；整库可随时删除而不影响主数据。状态全部落盘，满足"计算无状态、
//! 状态持久化"——进程重启后由 [`super::watchdog::recover`] 收敛遗留的在途项。
//!
//! 表：
//! - `sa_triggers`    事件本体（不可变）
//! - `sa_deliveries`  事件 → 目标（router / worker）的投递记录与状态机
//! - `sa_workers`     Worker 记录
//! - `sa_subs`        Thread ↔ Worker 的多对多订阅
//! - `sa_replies`     Router 对用户的回复
//! - `sa_kv`          杂项键值（router 会话 id 等）

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::types::{Reply, Trigger, Worker, WorkerStatus};

/// 单条投递的最大重试次数，超过后丢弃（避免毒消息永久占用批次）。
pub const MAX_DELIVERY_ATTEMPTS: i64 = 3;

pub struct SuperAgentStore {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sa_triggers (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    sender TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    dedupe_key TEXT,
    created_ms INTEGER NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sa_triggers_thread ON sa_triggers(thread_key, created_ms);
CREATE INDEX IF NOT EXISTS idx_sa_triggers_dedupe ON sa_triggers(source, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_sa_triggers_sender ON sa_triggers(source, sender, created_ms);

CREATE TABLE IF NOT EXISTS sa_deliveries (
    trigger_id TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,           -- pending | claimed | done | dropped
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_ms INTEGER,
    PRIMARY KEY (trigger_id, target)
);
CREATE INDEX IF NOT EXISTS idx_sa_deliveries_target ON sa_deliveries(target, status);

CREATE TABLE IF NOT EXISTS sa_workers (
    id TEXT PRIMARY KEY,
    thread_key TEXT NOT NULL,
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    brief_sent INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    status TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    last_progress_ms INTEGER NOT NULL,
    run_started_ms INTEGER,
    runs INTEGER NOT NULL DEFAULT 0,
    last_output_hash TEXT,
    repeat_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sa_workers_thread ON sa_workers(thread_key);

CREATE TABLE IF NOT EXISTS sa_subs (
    thread_key TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    last_event_ms INTEGER NOT NULL,
    PRIMARY KEY (thread_key, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_sa_subs_worker ON sa_subs(worker_id);

CREATE TABLE IF NOT EXISTS sa_replies (
    id TEXT PRIMARY KEY,
    thread_key TEXT NOT NULL,
    text TEXT NOT NULL,
    created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sa_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStats {
    pub pending_router: i64,
    pub pending_workers: i64,
    pub claimed: i64,
    pub workers_total: i64,
    pub workers_running: i64,
    pub subscriptions: i64,
}

fn map_trigger(row: &Row<'_>) -> rusqlite::Result<Trigger> {
    Ok(Trigger {
        id: row.get("id")?,
        source: row.get("source")?,
        thread_key: row.get("thread_key")?,
        sender: row.get("sender")?,
        kind: row.get("kind")?,
        body: row.get("body")?,
        dedupe_key: row.get("dedupe_key")?,
        created_ms: row.get("created_ms")?,
        priority: row.get("priority")?,
    })
}

fn map_worker(row: &Row<'_>) -> rusqlite::Result<Worker> {
    let status: String = row.get("status")?;
    Ok(Worker {
        id: row.get("id")?,
        thread_key: row.get("thread_key")?,
        title: row.get("title")?,
        brief: row.get("brief")?,
        brief_sent: row.get::<_, i64>("brief_sent")? != 0,
        session_id: row.get("session_id")?,
        status: WorkerStatus::parse(&status),
        created_ms: row.get("created_ms")?,
        last_progress_ms: row.get("last_progress_ms")?,
        run_started_ms: row.get("run_started_ms")?,
        runs: row.get("runs")?,
        last_output_hash: row.get("last_output_hash")?,
        repeat_count: row.get("repeat_count")?,
    })
}

impl SuperAgentStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create superagent dir: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open superagent.db: {e}"))?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        Self::from_conn(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Self {
        Self::from_conn(Connection::open_in_memory().expect("memory db")).expect("schema")
    }

    fn from_conn(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("init superagent schema: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let guard = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(&guard).map_err(|e| e.to_string())
    }

    // ------------------------------------------------------------------
    // Triggers & deliveries
    // ------------------------------------------------------------------

    /// 写入 Trigger 并为每个目标创建 pending 投递（单事务）。
    pub fn insert_trigger(&self, trigger: &Trigger, targets: &[String]) -> Result<(), String> {
        let mut guard = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let tx = guard.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO sa_triggers (id, source, thread_key, sender, kind, body, dedupe_key, created_ms, priority)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                trigger.id,
                trigger.source,
                trigger.thread_key,
                trigger.sender,
                trigger.kind,
                trigger.body,
                trigger.dedupe_key,
                trigger.created_ms,
                trigger.priority
            ],
        )
        .map_err(|e| e.to_string())?;
        for target in targets {
            tx.execute(
                "INSERT OR IGNORE INTO sa_deliveries (trigger_id, target, status) VALUES (?1, ?2, 'pending')",
                params![trigger.id, target],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// 为已存在的 Trigger 追加一个投递目标（Router 转发给 Worker 时使用）。
    pub fn add_delivery(&self, trigger_id: &str, target: &str) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO sa_deliveries (trigger_id, target, status) VALUES (?1, ?2, 'pending')
                 ON CONFLICT(trigger_id, target) DO UPDATE SET status='pending', attempts=0, claimed_ms=NULL
                 WHERE status IN ('done','dropped')",
                params![trigger_id, target],
            )?;
            Ok(())
        })
    }

    pub fn has_recent_dedupe(
        &self,
        source: &str,
        dedupe_key: &str,
        since_ms: i64,
    ) -> Result<bool, String> {
        self.with(|c| {
            c.query_row(
                "SELECT 1 FROM sa_triggers WHERE source=?1 AND dedupe_key=?2 AND created_ms>=?3 LIMIT 1",
                params![source, dedupe_key, since_ms],
                |_| Ok(()),
            )
            .optional()
            .map(|r| r.is_some())
        })
    }

    pub fn count_recent_from(
        &self,
        source: &str,
        sender: &str,
        since_ms: i64,
    ) -> Result<i64, String> {
        self.with(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM sa_triggers WHERE source=?1 AND sender=?2 AND created_ms>=?3",
                params![source, sender, since_ms],
                |r| r.get(0),
            )
        })
    }

    pub fn get_trigger(&self, id: &str) -> Result<Option<Trigger>, String> {
        self.with(|c| {
            c.query_row(
                "SELECT * FROM sa_triggers WHERE id=?1",
                params![id],
                map_trigger,
            )
            .optional()
        })
    }

    /// 某 Thread 最近的 Trigger（按时间升序返回，最多 `limit` 条，早于 `before_ms`）。
    pub fn thread_triggers(
        &self,
        thread_key: &str,
        before_ms: i64,
        limit: usize,
    ) -> Result<Vec<Trigger>, String> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT * FROM sa_triggers WHERE thread_key=?1 AND created_ms<?2
                 ORDER BY created_ms DESC, id DESC LIMIT ?3",
            )?;
            let mut rows = stmt
                .query_map(params![thread_key, before_ms, limit as i64], map_trigger)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.reverse();
            Ok(rows)
        })
    }

    /// 领取目标的 pending 投递（优先级降序、时间升序），标记 claimed。
    pub fn claim(&self, target: &str, limit: usize, now_ms: i64) -> Result<Vec<Trigger>, String> {
        let mut guard = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let tx = guard.transaction().map_err(|e| e.to_string())?;
        let triggers = {
            let mut stmt = tx
                .prepare(
                    "SELECT t.* FROM sa_deliveries d JOIN sa_triggers t ON t.id = d.trigger_id
                     WHERE d.target=?1 AND d.status='pending'
                     ORDER BY t.priority DESC, t.created_ms ASC, t.id ASC LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![target, limit as i64], map_trigger)
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for t in &triggers {
            tx.execute(
                "UPDATE sa_deliveries SET status='claimed', claimed_ms=?3 WHERE trigger_id=?1 AND target=?2",
                params![t.id, target, now_ms],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(triggers)
    }

    pub fn complete(&self, target: &str, ids: &[String]) -> Result<(), String> {
        self.with(|c| {
            for id in ids {
                c.execute(
                    "UPDATE sa_deliveries SET status='done', claimed_ms=NULL WHERE trigger_id=?1 AND target=?2",
                    params![id, target],
                )?;
            }
            Ok(())
        })
    }

    /// 处理失败：放回 pending 并累加尝试次数；达到上限则丢弃。返回被丢弃的条数。
    pub fn release(&self, target: &str, ids: &[String]) -> Result<usize, String> {
        self.with(|c| {
            let mut dropped = 0;
            for id in ids {
                c.execute(
                    "UPDATE sa_deliveries SET attempts=attempts+1,
                        status=CASE WHEN attempts+1>=?3 THEN 'dropped' ELSE 'pending' END,
                        claimed_ms=NULL
                     WHERE trigger_id=?1 AND target=?2",
                    params![id, target, MAX_DELIVERY_ATTEMPTS],
                )?;
                let status: String = c.query_row(
                    "SELECT status FROM sa_deliveries WHERE trigger_id=?1 AND target=?2",
                    params![id, target],
                    |r| r.get(0),
                )?;
                if status == "dropped" {
                    dropped += 1;
                }
            }
            Ok(dropped)
        })
    }

    /// 非失败原因的归还（例如进程重启恢复）：不累加尝试次数。
    pub fn requeue_claimed(
        &self,
        target: Option<&str>,
        claimed_before_ms: i64,
    ) -> Result<usize, String> {
        self.with(|c| match target {
            Some(t) => c.execute(
                "UPDATE sa_deliveries SET status='pending', claimed_ms=NULL
                 WHERE status='claimed' AND target=?1 AND COALESCE(claimed_ms,0)<=?2",
                params![t, claimed_before_ms],
            ),
            None => c.execute(
                "UPDATE sa_deliveries SET status='pending', claimed_ms=NULL
                 WHERE status='claimed' AND COALESCE(claimed_ms,0)<=?1",
                params![claimed_before_ms],
            ),
        })
    }

    /// 有 pending 投递的目标及其条数。
    pub fn pending_by_target(&self) -> Result<Vec<(String, i64)>, String> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT target, COUNT(*) FROM sa_deliveries WHERE status='pending' GROUP BY target",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn oldest_pending_ms(&self, target: &str) -> Result<Option<i64>, String> {
        self.with(|c| {
            c.query_row(
                "SELECT MIN(t.created_ms) FROM sa_deliveries d JOIN sa_triggers t ON t.id=d.trigger_id
                 WHERE d.target=?1 AND d.status='pending'",
                params![target],
                |r| r.get::<_, Option<i64>>(0),
            )
        })
    }

    // ------------------------------------------------------------------
    // Workers
    // ------------------------------------------------------------------

    pub fn create_worker(&self, w: &Worker) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO sa_workers (id, thread_key, title, brief, brief_sent, session_id, status,
                    created_ms, last_progress_ms, run_started_ms, runs, last_output_hash, repeat_count)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    w.id,
                    w.thread_key,
                    w.title,
                    w.brief,
                    w.brief_sent as i64,
                    w.session_id,
                    w.status.as_str(),
                    w.created_ms,
                    w.last_progress_ms,
                    w.run_started_ms,
                    w.runs,
                    w.last_output_hash,
                    w.repeat_count
                ],
            )?;
            Ok(())
        })
    }

    pub fn get_worker(&self, id: &str) -> Result<Option<Worker>, String> {
        self.with(|c| {
            c.query_row(
                "SELECT * FROM sa_workers WHERE id=?1",
                params![id],
                map_worker,
            )
            .optional()
        })
    }

    pub fn list_workers(&self, include_closed: bool) -> Result<Vec<Worker>, String> {
        self.with(|c| {
            let sql = if include_closed {
                "SELECT * FROM sa_workers ORDER BY created_ms DESC"
            } else {
                "SELECT * FROM sa_workers WHERE status!='closed' ORDER BY created_ms DESC"
            };
            let mut stmt = c.prepare(sql)?;
            let rows = stmt
                .query_map([], map_worker)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn set_worker_session(&self, id: &str, session_id: &str) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "UPDATE sa_workers SET session_id=?2 WHERE id=?1",
                params![id, session_id],
            )?;
            Ok(())
        })
    }

    pub fn mark_brief_sent(&self, id: &str) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "UPDATE sa_workers SET brief_sent=1 WHERE id=?1",
                params![id],
            )?;
            Ok(())
        })
    }

    /// 试图把 Worker 置为 running（CAS：仅当当前非 running/closed）。成功返回 true。
    pub fn try_begin_run(&self, id: &str, now_ms: i64) -> Result<bool, String> {
        self.with(|c| {
            let n = c.execute(
                "UPDATE sa_workers SET status='running', run_started_ms=?2, runs=runs+1
                 WHERE id=?1 AND status NOT IN ('running','closed')",
                params![id, now_ms],
            )?;
            Ok(n == 1)
        })
    }

    /// 结束一次运行。`output_hash` 与上次相同则 repeat_count+1，否则清零。
    pub fn finish_run(
        &self,
        id: &str,
        status: WorkerStatus,
        output_hash: Option<&str>,
        now_ms: i64,
    ) -> Result<(), String> {
        self.with(|c| {
            let prev: Option<String> = c
                .query_row("SELECT last_output_hash FROM sa_workers WHERE id=?1", params![id], |r| r.get(0))
                .optional()?
                .flatten();
            let same = matches!((&prev, output_hash), (Some(a), Some(b)) if a == b);
            c.execute(
                "UPDATE sa_workers SET status=?2, run_started_ms=NULL, last_progress_ms=?3,
                    last_output_hash=COALESCE(?4,last_output_hash),
                    repeat_count=CASE WHEN ?5 THEN repeat_count+1 WHEN ?4 IS NULL THEN repeat_count ELSE 0 END
                 WHERE id=?1 AND status!='closed'",
                params![id, status.as_str(), now_ms, output_hash, same],
            )?;
            Ok(())
        })
    }

    pub fn set_worker_status(&self, id: &str, status: WorkerStatus) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "UPDATE sa_workers SET status=?2, run_started_ms=CASE WHEN ?2='running' THEN run_started_ms ELSE NULL END WHERE id=?1",
                params![id, status.as_str()],
            )?;
            Ok(())
        })
    }

    pub fn close_worker(&self, id: &str) -> Result<(), String> {
        self.with(|c| {
            c.execute("UPDATE sa_workers SET status='closed', run_started_ms=NULL WHERE id=?1", params![id])?;
            c.execute("DELETE FROM sa_subs WHERE worker_id=?1", params![id])?;
            c.execute(
                "UPDATE sa_deliveries SET status='dropped', claimed_ms=NULL WHERE target=?1 AND status IN ('pending','claimed')",
                params![id],
            )?;
            Ok(())
        })
    }

    // ------------------------------------------------------------------
    // Subscriptions
    // ------------------------------------------------------------------

    pub fn subscribe(&self, thread_key: &str, worker_id: &str, now_ms: i64) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO sa_subs (thread_key, worker_id, created_ms, last_event_ms) VALUES (?1,?2,?3,?3)
                 ON CONFLICT(thread_key, worker_id) DO UPDATE SET last_event_ms=excluded.last_event_ms",
                params![thread_key, worker_id, now_ms],
            )?;
            Ok(())
        })
    }

    pub fn unsubscribe(&self, thread_key: &str, worker_id: &str) -> Result<bool, String> {
        self.with(|c| {
            let n = c.execute(
                "DELETE FROM sa_subs WHERE thread_key=?1 AND worker_id=?2",
                params![thread_key, worker_id],
            )?;
            Ok(n > 0)
        })
    }

    /// 订阅了某 Thread 且未关闭的 Worker。
    pub fn subscribers(&self, thread_key: &str) -> Result<Vec<String>, String> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT s.worker_id FROM sa_subs s JOIN sa_workers w ON w.id=s.worker_id
                 WHERE s.thread_key=?1 AND w.status!='closed' ORDER BY s.created_ms",
            )?;
            let rows = stmt
                .query_map(params![thread_key], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn subscriptions_of(&self, worker_id: &str) -> Result<Vec<String>, String> {
        self.with(|c| {
            let mut stmt =
                c.prepare("SELECT thread_key FROM sa_subs WHERE worker_id=?1 ORDER BY created_ms")?;
            let rows = stmt
                .query_map(params![worker_id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn touch_subscription(&self, thread_key: &str, now_ms: i64) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "UPDATE sa_subs SET last_event_ms=?2 WHERE thread_key=?1",
                params![thread_key, now_ms],
            )?;
            Ok(())
        })
    }

    /// 超过 `idle_before_ms` 没有事件的订阅。
    pub fn stale_subscriptions(
        &self,
        idle_before_ms: i64,
    ) -> Result<Vec<(String, String)>, String> {
        self.with(|c| {
            let mut stmt =
                c.prepare("SELECT thread_key, worker_id FROM sa_subs WHERE last_event_ms<?1")?;
            let rows = stmt
                .query_map(params![idle_before_ms], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    // ------------------------------------------------------------------
    // Replies / kv / stats
    // ------------------------------------------------------------------

    /// 保留期清理：删除 `cutoff_ms` 之前、所有投递都已结束（done / dropped）的事件及其投递，
    /// 更早的回复，以及最后进展早于 cutoff 的已关闭 Worker（连同其订阅）。返回删除的行数。
    pub fn prune_before(&self, cutoff_ms: i64) -> Result<usize, String> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let finished = "SELECT t.id FROM sa_triggers t WHERE t.created_ms < ?1 AND NOT EXISTS (
                 SELECT 1 FROM sa_deliveries d WHERE d.trigger_id = t.id AND d.status IN ('pending', 'claimed'))";
            tx.execute(
                &format!("DELETE FROM sa_deliveries WHERE trigger_id IN ({finished})"),
                params![cutoff_ms],
            )?;
            let mut n = tx.execute(
                &format!("DELETE FROM sa_triggers WHERE id IN ({finished})"),
                params![cutoff_ms],
            )?;
            n += tx.execute(
                "DELETE FROM sa_replies WHERE created_ms < ?1",
                params![cutoff_ms],
            )?;
            tx.execute(
                "DELETE FROM sa_subs WHERE worker_id IN (SELECT id FROM sa_workers WHERE status = 'closed' AND last_progress_ms < ?1)",
                params![cutoff_ms],
            )?;
            n += tx.execute(
                "DELETE FROM sa_workers WHERE status = 'closed' AND last_progress_ms < ?1",
                params![cutoff_ms],
            )?;
            tx.commit()?;
            Ok(n)
        })
    }

    pub fn add_reply(&self, reply: &Reply) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO sa_replies (id, thread_key, text, created_ms) VALUES (?1,?2,?3,?4)",
                params![reply.id, reply.thread_key, reply.text, reply.created_ms],
            )?;
            Ok(())
        })
    }

    pub fn list_replies(&self, limit: usize) -> Result<Vec<Reply>, String> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT id, thread_key, text, created_ms FROM sa_replies ORDER BY created_ms DESC, id DESC LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(params![limit as i64], |r| {
                    Ok(Reply {
                        id: r.get(0)?,
                        thread_key: r.get(1)?,
                        text: r.get(2)?,
                        created_ms: r.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// 供 UI 时间线使用：用户输入与对用户有意义的系统事件（Worker 回报/失败、Watchdog）。
    /// 不含 Router 自己写给 Worker 的转交说明。按时间升序返回最近 `limit` 条。
    pub fn feed_triggers(&self, limit: usize) -> Result<Vec<Trigger>, String> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT * FROM sa_triggers
                 WHERE source NOT IN ('router')
                   AND (source != 'internal' OR kind LIKE 'worker.%' OR kind LIKE 'watchdog.%' OR kind LIKE 'dispatch.%')
                 ORDER BY created_ms DESC, id DESC LIMIT ?1",
            )?;
            let mut rows = stmt
                .query_map(params![limit as i64], map_trigger)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.reverse();
            Ok(rows)
        })
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        self.with(|c| {
            c.query_row("SELECT value FROM sa_kv WHERE key=?1", params![key], |r| {
                r.get(0)
            })
            .optional()
        })
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO sa_kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }

    pub fn stats(&self) -> Result<StoreStats, String> {
        self.with(|c| {
            let count = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0));
            Ok(StoreStats {
                pending_router: count("SELECT COUNT(*) FROM sa_deliveries WHERE target='router' AND status='pending'")?,
                pending_workers: count("SELECT COUNT(*) FROM sa_deliveries WHERE target!='router' AND status='pending'")?,
                claimed: count("SELECT COUNT(*) FROM sa_deliveries WHERE status='claimed'")?,
                workers_total: count("SELECT COUNT(*) FROM sa_workers WHERE status!='closed'")?,
                workers_running: count("SELECT COUNT(*) FROM sa_workers WHERE status='running'")?,
                subscriptions: count("SELECT COUNT(*) FROM sa_subs")?,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trig(id: &str, thread: &str, ts: i64, priority: i32) -> Trigger {
        Trigger {
            id: id.into(),
            source: "manual".into(),
            thread_key: thread.into(),
            sender: "u1".into(),
            kind: "message".into(),
            body: format!("body-{id}"),
            dedupe_key: Some(format!("d-{id}")),
            created_ms: ts,
            priority,
        }
    }

    fn worker(id: &str, thread: &str) -> Worker {
        Worker {
            id: id.into(),
            thread_key: thread.into(),
            title: "t".into(),
            brief: "b".into(),
            brief_sent: false,
            session_id: None,
            status: WorkerStatus::Idle,
            created_ms: 1,
            last_progress_ms: 1,
            run_started_ms: None,
            runs: 0,
            last_output_hash: None,
            repeat_count: 0,
        }
    }

    #[test]
    fn claim_orders_by_priority_then_time_and_batches() {
        let s = SuperAgentStore::open_in_memory();
        s.insert_trigger(&trig("a", "t", 10, 0), &["router".into()])
            .unwrap();
        s.insert_trigger(&trig("b", "t", 20, 2), &["router".into()])
            .unwrap();
        s.insert_trigger(&trig("c", "t", 30, 0), &["router".into()])
            .unwrap();
        let got = s.claim("router", 2, 100).unwrap();
        assert_eq!(
            got.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        // 已 claimed 的不会被再次领取
        let rest = s.claim("router", 10, 101).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, "c");
    }

    #[test]
    fn release_drops_after_max_attempts() {
        let s = SuperAgentStore::open_in_memory();
        s.insert_trigger(&trig("a", "t", 10, 0), &["router".into()])
            .unwrap();
        let ids = vec!["a".to_string()];
        for round in 1..=MAX_DELIVERY_ATTEMPTS {
            let claimed = s.claim("router", 5, round).unwrap();
            assert_eq!(claimed.len(), 1, "round {round}");
            let dropped = s.release("router", &ids).unwrap();
            assert_eq!(dropped, if round == MAX_DELIVERY_ATTEMPTS { 1 } else { 0 });
        }
        assert!(s.claim("router", 5, 999).unwrap().is_empty());
    }

    #[test]
    fn requeue_claimed_does_not_burn_attempts() {
        let s = SuperAgentStore::open_in_memory();
        s.insert_trigger(&trig("a", "t", 10, 0), &["router".into()])
            .unwrap();
        for i in 0..10 {
            assert_eq!(s.claim("router", 5, i).unwrap().len(), 1);
            assert_eq!(s.requeue_claimed(None, i + 1).unwrap(), 1);
        }
    }

    #[test]
    fn subscriptions_are_many_to_many_and_skip_closed_workers() {
        let s = SuperAgentStore::open_in_memory();
        s.create_worker(&worker("w1", "pr1")).unwrap();
        s.create_worker(&worker("w2", "pr1")).unwrap();
        s.subscribe("pr1", "w1", 1).unwrap();
        s.subscribe("pr1", "w2", 1).unwrap();
        s.subscribe("pr2", "w1", 1).unwrap();
        assert_eq!(s.subscribers("pr1").unwrap(), ["w1", "w2"]);
        assert_eq!(s.subscriptions_of("w1").unwrap().len(), 2);
        s.close_worker("w2").unwrap();
        assert_eq!(s.subscribers("pr1").unwrap(), ["w1"]);
        assert!(s.unsubscribe("pr1", "w1").unwrap());
        assert!(s.subscribers("pr1").unwrap().is_empty());
    }

    #[test]
    fn worker_run_cas_and_repeat_counter() {
        let s = SuperAgentStore::open_in_memory();
        s.create_worker(&worker("w1", "t")).unwrap();
        assert!(s.try_begin_run("w1", 10).unwrap());
        assert!(
            !s.try_begin_run("w1", 11).unwrap(),
            "running worker must not start twice"
        );
        s.finish_run("w1", WorkerStatus::Idle, Some("h1"), 20)
            .unwrap();
        assert_eq!(s.get_worker("w1").unwrap().unwrap().repeat_count, 0);
        s.try_begin_run("w1", 21).unwrap();
        s.finish_run("w1", WorkerStatus::Idle, Some("h1"), 30)
            .unwrap();
        assert_eq!(s.get_worker("w1").unwrap().unwrap().repeat_count, 1);
        s.try_begin_run("w1", 31).unwrap();
        s.finish_run("w1", WorkerStatus::Idle, Some("h2"), 40)
            .unwrap();
        assert_eq!(s.get_worker("w1").unwrap().unwrap().repeat_count, 0);
    }

    #[test]
    fn dedupe_and_rate_queries() {
        let s = SuperAgentStore::open_in_memory();
        s.insert_trigger(&trig("a", "t", 100, 0), &[]).unwrap();
        assert!(s.has_recent_dedupe("manual", "d-a", 50).unwrap());
        assert!(!s.has_recent_dedupe("manual", "d-a", 150).unwrap());
        assert_eq!(s.count_recent_from("manual", "u1", 0).unwrap(), 1);
    }

    #[test]
    fn feed_includes_user_and_worker_events_but_not_router_notes() {
        let s = SuperAgentStore::open_in_memory();
        let mk = |id: &str, source: &str, kind: &str, ts: i64| {
            let mut t = trig(id, "t", ts, 0);
            t.source = source.into();
            t.kind = kind.into();
            t
        };
        s.insert_trigger(&mk("u1", "chat", "message", 1), &[])
            .unwrap();
        s.insert_trigger(&mk("r1", "router", "router.note", 2), &[])
            .unwrap();
        s.insert_trigger(&mk("w1", "internal", "worker.report", 3), &[])
            .unwrap();
        s.insert_trigger(&mk("x1", "internal", "something.else", 4), &[])
            .unwrap();
        let ids: Vec<_> = s
            .feed_triggers(10)
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, ["u1", "w1"]);
    }

    #[test]
    fn add_delivery_revives_done_delivery() {
        let s = SuperAgentStore::open_in_memory();
        s.insert_trigger(&trig("a", "t", 10, 0), &["router".into()])
            .unwrap();
        s.claim("router", 5, 1).unwrap();
        s.complete("router", &["a".into()]).unwrap();
        s.add_delivery("a", "w1").unwrap();
        assert_eq!(s.claim("w1", 5, 2).unwrap().len(), 1);
    }

    #[test]
    fn prune_keeps_in_flight_and_recent_history() {
        let s = SuperAgentStore::open_in_memory();
        // 旧且已处理完 → 清理；旧但仍待处理 → 保留；新 → 保留
        s.insert_trigger(&trig("old_done", "t", 10, 0), &["router".into()])
            .unwrap();
        s.claim("router", 1, 11).unwrap();
        s.complete("router", &["old_done".into()]).unwrap();
        s.insert_trigger(&trig("old_pending", "t", 20, 0), &["router".into()])
            .unwrap();
        s.insert_trigger(&trig("fresh", "t", 5_000, 0), &["router".into()])
            .unwrap();
        s.add_reply(&Reply {
            id: "r_old".into(),
            thread_key: "t".into(),
            text: "x".into(),
            created_ms: 10,
        })
        .unwrap();
        let mut closed = worker("w_closed", "t");
        closed.status = WorkerStatus::Closed;
        s.create_worker(&closed).unwrap();
        s.create_worker(&worker("w_idle", "t")).unwrap();

        // 3 = old_done 事件 + 旧回复 + 已关闭 Worker
        assert_eq!(s.prune_before(1_000).unwrap(), 3);
        assert!(s.get_trigger("old_done").unwrap().is_none());
        assert!(s.get_trigger("old_pending").unwrap().is_some());
        assert!(s.get_trigger("fresh").unwrap().is_some());
        assert!(s.list_replies(10).unwrap().is_empty());
        assert!(s.get_worker("w_closed").unwrap().is_none());
        assert!(s.get_worker("w_idle").unwrap().is_some());
        // 仍在途的投递不受影响
        assert_eq!(s.claim("router", 5, 6_000).unwrap().len(), 2);
    }
}
