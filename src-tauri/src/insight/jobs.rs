//! insight_jobs 持久任务队列 + 巩固 worker（阶段三：受控演化）
//!
//! 纪律：
//! - enqueue 幂等（dedupe_key UNIQUE + INSERT OR IGNORE）；
//! - claim 用租约（lease_owner + leased_at），崩溃任务租约过期后被回收；
//! - 失败退避（next_attempt_at = now + backoff(attempt)），超过 max_attempts 转 error；
//! - worker 可中断：每个任务之间检查 should_continue；
//! - 启动恢复：recover_stale_leases 把过期 running 任务重置回 queued。

use std::sync::Arc;

use rusqlite::{params, Connection};

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;

use super::repo;

/// 租约时长（秒）：超过即视为 worker 已死，任务可被回收
const LEASE_SECS: i64 = 120;
/// 退避基数（秒）：attempt^n * BASE，上限 1 小时
const BACKOFF_BASE_SECS: i64 = 30;

fn db_err(e: rusqlite::Error) -> AppError {
    AppError::database(e.to_string())
}

fn generate_job_id() -> String {
    format!("ijob_{}", nanoid::nanoid!(10))
}

// ============================================================================
// 队列操作（全部 *with_conn / 自持连接，事务由调用方控制）
// ============================================================================

/// 入队（幂等）：同 dedupe_key 的待处理任务已存在时静默跳过。
/// 返回 Some(job_id) 表示新入队；None 表示已存在。
pub fn enqueue_with_conn(
    conn: &Connection,
    job_type: &str,
    dedupe_key: &str,
    payload_json: &str,
) -> Result<Option<String>, AppError> {
    // 已有同键未完成（queued/running）任务 → 不重排
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM insight_jobs
             WHERE dedupe_key = ?1 AND status IN ('queued', 'running') AND deleted_at IS NULL",
            params![dedupe_key],
            |row| row.get(0),
        )
        .ok();
    if existing.is_some() {
        return Ok(None);
    }
    let id = generate_job_id();
    let now = repo::now_iso();
    conn.execute(
        "INSERT INTO insight_jobs
         (id, job_type, dedupe_key, status, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?5)",
        params![id, job_type, dedupe_key, payload_json, now],
    )
    .map_err(db_err)?;
    Ok(Some(id))
}

pub fn enqueue(
    vfs_db: &VfsDatabase,
    job_type: &str,
    dedupe_key: &str,
    payload_json: &str,
) -> Result<Option<String>, AppError> {
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| AppError::database(e.to_string()))?;
    enqueue_with_conn(&conn, job_type, dedupe_key, payload_json)
}

/// 启动恢复：过期租约的 running 任务重置回 queued（幂等，可在每次 run_once 前调用）
pub fn recover_stale_leases_with_conn(conn: &Connection) -> Result<usize, AppError> {
    let n = conn.execute(
        "UPDATE insight_jobs
         SET status = 'queued', lease_owner = NULL, leased_at = NULL, updated_at = ?1
         WHERE status = 'running'
           AND deleted_at IS NULL
           AND (leased_at IS NULL
                OR leased_at < datetime('now', ?2))",
        params![repo::now_iso(), format!("-{LEASE_SECS} seconds")],
    )
    .map_err(db_err)?;
    Ok(n)
}

/// 认领一批到期任务（租约标记）。返回 (id, job_type, payload_json, attempt)。
pub fn claim_due_with_conn(
    conn: &Connection,
    worker_id: &str,
    limit: usize,
) -> Result<Vec<(String, String, String, i64)>, AppError> {
    let now = repo::now_iso();
    let mut stmt = conn
        .prepare(
            "SELECT id, job_type, payload_json, attempt FROM insight_jobs
             WHERE status = 'queued'
               AND deleted_at IS NULL
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
             ORDER BY created_at ASC
             LIMIT ?2",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![now, limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;

    let mut claimed = Vec::with_capacity(rows.len());
    for (id, job_type, payload, attempt) in rows {
        // 乐观认领：只有仍处于 queued 的行才被本 worker 拿走
        let n = conn
            .execute(
                "UPDATE insight_jobs
                 SET status = 'running', lease_owner = ?2, leased_at = ?3,
                     attempt = attempt + 1, updated_at = ?3
                 WHERE id = ?1 AND status = 'queued'",
                params![id, worker_id, now],
            )
            .map_err(db_err)?;
        if n == 1 {
            claimed.push((id, job_type, payload, attempt + 1));
        }
    }
    Ok(claimed)
}

pub fn complete_with_conn(conn: &Connection, job_id: &str) -> Result<(), AppError> {
    conn.execute(
        "UPDATE insight_jobs
         SET status = 'done', lease_owner = NULL, leased_at = NULL, updated_at = ?2
         WHERE id = ?1",
        params![job_id, repo::now_iso()],
    )
    .map_err(db_err)?;
    Ok(())
}

/// 失败：attempt < max_attempts → 退避重排；否则转 error（不再自动重试）
pub fn fail_with_conn(conn: &Connection, job_id: &str, error: &str) -> Result<(), AppError> {
    let (attempt, max_attempts): (i64, i64) = conn
        .query_row(
            "SELECT attempt, max_attempts FROM insight_jobs WHERE id = ?1",
            params![job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_err)?;
    if attempt < max_attempts {
        let backoff = BACKOFF_BASE_SECS * (1i64 << attempt.min(7));
        conn.execute(
            "UPDATE insight_jobs
             SET status = 'queued', lease_owner = NULL, leased_at = NULL,
                 next_attempt_at = datetime('now', ?2), last_error = ?3, updated_at = ?4
             WHERE id = ?1",
            params![job_id, format!("+{backoff} seconds"), error, repo::now_iso()],
        )
        .map_err(db_err)?;
    } else {
        conn.execute(
            "UPDATE insight_jobs
             SET status = 'error', lease_owner = NULL, leased_at = NULL,
                 last_error = ?2, updated_at = ?3
             WHERE id = ?1",
            params![job_id, error, repo::now_iso()],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

// ============================================================================
// Worker
// ============================================================================

/// 巩固 worker。闲时驱动（前端在确认/纠正后或空闲时调 insight_run_jobs）。
pub struct InsightJobWorker {
    vfs_db: Arc<VfsDatabase>,
    /// mistakes 库（SRS 投影落在 anki_cards）
    mistakes_db: Option<Arc<crate::database::Database>>,
    worker_id: String,
}

impl InsightJobWorker {
    pub fn new(
        vfs_db: Arc<VfsDatabase>,
        mistakes_db: Option<Arc<crate::database::Database>>,
    ) -> Self {
        Self {
            vfs_db,
            mistakes_db,
            worker_id: format!("worker_{}", nanoid::nanoid!(6)),
        }
    }

    /// 处理一批到期任务。`should_continue` 在每个任务之间检查（可中断）。
    /// 返回处理完成的任务数。
    pub fn run_once(
        &self,
        batch_size: usize,
        should_continue: &dyn Fn() -> bool,
    ) -> Result<usize, AppError> {
        let conn = self
            .vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        recover_stale_leases_with_conn(&conn)?;
        let jobs = claim_due_with_conn(&conn, &self.worker_id, batch_size)?;
        drop(conn);

        let mut done = 0usize;
        for (job_id, job_type, payload, _attempt) in jobs {
            if !should_continue() {
                break;
            }
            let conn = self
                .vfs_db
                .get_conn_safe()
                .map_err(|e| AppError::database(e.to_string()))?;
            let result = self.execute_job(&conn, &job_type, &payload);
            match result {
                Ok(()) => {
                    complete_with_conn(&conn, &job_id)?;
                    done += 1;
                }
                Err(e) => {
                    tracing::warn!("[InsightJobs] job {job_id} ({job_type}) failed: {e}");
                    fail_with_conn(&conn, &job_id, &e.to_string())?;
                }
            }
        }
        Ok(done)
    }

    fn execute_job(
        &self,
        conn: &Connection,
        job_type: &str,
        payload_json: &str,
    ) -> Result<(), AppError> {
        match job_type {
            "srs_projection" => self.execute_srs_projection(conn, payload_json),
            // 合并提案 / 原则卡合成在后续切片落地
            other => Err(AppError::validation(format!("未知任务类型: {other}"))),
        }
    }

    /// SRS 投影（D4：物化 + 回链）：
    /// - document_tasks 合成行：id = task_insight_{insight_id}（upsert）；
    /// - anki_cards 物化卡：id = ac_insight_{insight_id}，
    ///   source_type='inspiration'、source_id=insight_id；
    /// - 源卡修订 → 原地 UPDATE front/back（保留 FSRS 调度状态，卡 id 不变）。
    fn execute_srs_projection(
        &self,
        conn: &Connection,
        payload_json: &str,
    ) -> Result<(), AppError> {
        let payload: serde_json::Value = serde_json::from_str(payload_json)
            .map_err(|e| AppError::validation(format!("任务 payload 非法: {e}")))?;
        let insight_id = payload
            .get("insight_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::validation("srs_projection 缺少 insight_id"))?;

        // 源卡已删除/归档 → 投影同步软删除（派生传播）
        let card = repo::get_card(conn, insight_id)?;
        let mistakes = self
            .mistakes_db
            .as_ref()
            .ok_or_else(|| AppError::database("mistakes 库不可用"))?;
        let mconn = mistakes
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        let task_id = format!("task_insight_{insight_id}");
        let card_id = format!("ac_insight_{insight_id}");

        let Some(card) = card else {
            // 墓碑传播：投影卡软删除
            mconn.execute(
                "UPDATE anki_cards SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
                params![card_id, repo::now_iso()],
            )
            .map_err(db_err)?;
            return Ok(());
        };
        if card.status != super::types::InsightStatus::Active {
            return Ok(());
        }
        let rev = card
            .current_revision
            .as_ref()
            .ok_or_else(|| AppError::database("灵感卡缺少当前修订"))?;

        let front = if rev.stuck_point.trim().is_empty() {
            format!("【{}】\n{}", card.title, rev.situation)
        } else {
            format!("【{}】\n{}\n\n卡点：{}", card.title, rev.situation, rev.stuck_point)
        };
        let mut back = format!("转折：{}", rev.turning_point);
        if !rev.rule.trim().is_empty() {
            back.push_str(&format!("\n规则：{}", rev.rule));
        }
        if !rev.validity_conditions.trim().is_empty() {
            back.push_str(&format!("\n成立条件：{}", rev.validity_conditions));
        }

        let now = repo::now_iso();
        // 合成任务行（upsert；content_segment 存当前规则文本便于排查）
        mconn.execute(
            "INSERT INTO document_tasks
             (id, document_id, original_document_name, segment_index, content_segment,
              status, created_at, updated_at, anki_generation_options_json)
             VALUES (?1, ?2, ?3, 0, ?4, 'Completed', ?5, ?5, '{}')
             ON CONFLICT(id) DO UPDATE SET
               original_document_name = excluded.original_document_name,
               content_segment = excluded.content_segment,
               updated_at = excluded.updated_at",
            params![
                task_id,
                format!("insight:{insight_id}"),
                card.title,
                rev.rule,
                now,
            ],
        )
        .map_err(db_err)?;

        // 物化卡（存在则原地更新内容，保留 FSRS 状态与复习历史）
        let exists: bool = mconn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM anki_cards WHERE id = ?1)",
                params![card_id],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        if exists {
            mconn.execute(
                "UPDATE anki_cards
                 SET front = ?2, back = ?3, updated_at = ?4, deleted_at = NULL
                 WHERE id = ?1",
                params![card_id, front, back, now],
            )
            .map_err(db_err)?;
        } else {
            mconn.execute(
                "INSERT INTO anki_cards
                 (id, task_id, front, back, tags_json, source_type, source_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, '[]', 'inspiration', ?5, ?6, ?6)",
                params![card_id, task_id, front, back, insight_id, now],
            )
            .map_err(db_err)?;
        }
        Ok(())
    }
}
