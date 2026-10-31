//! # 记录级时点恢复（最小版，R11-history）
//!
//! 在两类"批量覆盖本地记录"的危险操作**执行前**，把受影响记录的当前状态
//! 快照到本地表 `__sync_record_history`，事后可按批次一键回退：
//!
//! 1. **库级策略覆盖**：`apply_downloaded_changes_with_conflict_guard` 中
//!    `ConflictResolver` 裁决 Cloud 胜、即将覆盖/删除本地行时
//!    （挂钩点在 `conflict_resolver.rs::resolve_one`，同一次 guard 调用共享
//!    一个批次 id）；
//! 2. **冲突面板解决（含批量）**：`data_governance_resolve_record_conflict`
//!    写回业务表之前（每次命令调用一个批次；前端批量解决是 N 次顺序调用，
//!    即 N 个可独立回退的批次）。
//!
//! ## 设计约束
//!
//! - **快照只在本地**：`__sync_record_history` 是 `__` 前缀的同步元数据表，
//!   不进入变更采集（change_log 采集只针对业务表触发器），**不上云**；
//!   跟随数据库文件一起被本地备份/恢复。
//! - **回退必须能传播且不被再覆盖**：回退通过
//!   `apply_downloaded_changes_force_exact_with_hooks` 以
//!   `suppress_change_log=false` 写回——业务表触发器产生的 change_log 条目
//!   保持 `sync_version=0`（待上传），其他设备能看到回退结果；同时把
//!   `updated_at` 提升到当前行/DELETE 版本之后，旧的云端胜方值在后续下载
//!   重放中输掉 LWW 门，不会把回退结果又覆盖回去（见
//!   `sync_r11_history.rs`）。
//! - **回退自身可撤销**：回退前先把当前状态快照成 `rollback_undo` 批次。
//! - **保留策略**：每库最多保留 [`DEFAULT_MAX_BATCHES`] 个批次，新批次
//!   落地时自动清理最旧的批次（按批次内最大行 id 排序）。
//!
//! ## 表结构
//!
//! ```sql
//! CREATE TABLE __sync_record_history (
//!     id INTEGER PRIMARY KEY AUTOINCREMENT,
//!     batch_id TEXT NOT NULL,       -- 同一次危险操作共享一个批次
//!     reason TEXT NOT NULL,         -- policy_override | conflict_resolve | rollback_undo
//!     table_name TEXT NOT NULL,
//!     record_id TEXT NOT NULL,
//!     existed INTEGER NOT NULL,     -- 快照时记录是否存在（0=不存在，回退=删除）
//!     data_json TEXT,               -- existed=1 时的完整行 JSON
//!     created_at TEXT NOT NULL DEFAULT (datetime('now')),
//!     rolled_back_at TEXT           -- 该批次被回退的时间（批内所有行一致）
//! );
//! ```

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::{ChangeOperation, SyncChangeWithData, SyncError, SyncManager};

/// 快照原因：库级策略覆盖（conflict guard 中 Cloud 胜方覆盖本地）
pub const REASON_POLICY_OVERRIDE: &str = "policy_override";
/// 快照原因：冲突面板解决（单条或前端批量循环）
pub const REASON_CONFLICT_RESOLVE: &str = "conflict_resolve";
/// 快照原因：回退操作自身的撤销点（回退前的当前状态）
pub const REASON_ROLLBACK_UNDO: &str = "rollback_undo";

/// 每个数据库保留的快照批次上限。超出时最旧批次（含 rollback_undo）被清理。
pub const DEFAULT_MAX_BATCHES: usize = 50;

/// 生成一个新的快照批次 id（时间戳 + 随机后缀，可读且全局唯一）
pub fn new_batch_id() -> String {
    format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ"),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    )
}

/// 初始化快照表（幂等，可在事务内调用）
pub fn ensure_history_table(conn: &Connection) -> Result<(), SyncError> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS __sync_record_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            existed INTEGER NOT NULL CHECK(existed IN (0,1)),
            data_json TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            rolled_back_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx__sync_record_history_batch
            ON __sync_record_history(batch_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx__sync_record_history_dedup
            ON __sync_record_history(batch_id, table_name, record_id);
        "#,
    )
    .map_err(|e| SyncError::Database(format!("创建 __sync_record_history 失败: {}", e)))?;
    Ok(())
}

/// 用调用方已持有的当前行数据写一条快照（`current=None` 表示记录当前不存在）。
///
/// 同一批次内同一 (table, record) 只保留**第一次**快照（覆盖前的原始状态），
/// 重复调用被唯一索引吞掉并返回 `Ok(false)`。
///
/// 新批次的第一行落地时自动执行保留策略清理（见 [`prune_batches_to_cap`]）。
pub fn snapshot_record_with_data(
    conn: &Connection,
    batch_id: &str,
    reason: &str,
    table_name: &str,
    record_id: &str,
    current: Option<&serde_json::Value>,
) -> Result<bool, SyncError> {
    ensure_history_table(conn)?;
    let data_json = match current {
        Some(value) => Some(
            serde_json::to_string(value)
                .map_err(|e| SyncError::Database(format!("序列化快照数据失败: {}", e)))?,
        ),
        None => None,
    };
    let inserted = conn
        .execute(
            "INSERT INTO __sync_record_history
             (batch_id, reason, table_name, record_id, existed, data_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(batch_id, table_name, record_id) DO NOTHING",
            params![
                batch_id,
                reason,
                table_name,
                record_id,
                i64::from(current.is_some()),
                data_json,
            ],
        )
        .map_err(|e| SyncError::Database(format!("写入记录快照失败: {}", e)))?;

    if inserted > 0 {
        let batch_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __sync_record_history WHERE batch_id = ?1",
                params![batch_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if batch_rows == 1 {
            // 新批次首行：执行保留策略（不因清理失败阻断快照本身）
            let _ = prune_batches_to_cap(conn, DEFAULT_MAX_BATCHES);
        }
    }
    Ok(inserted > 0)
}

/// 读取业务表当前行后写快照（不在事务内持有行数据时的便捷入口）
pub fn snapshot_record(
    conn: &Connection,
    batch_id: &str,
    reason: &str,
    table_name: &str,
    record_id: &str,
    id_column: &str,
) -> Result<bool, SyncError> {
    let current = SyncManager::get_record_data(conn, table_name, record_id, id_column)?;
    snapshot_record_with_data(
        conn,
        batch_id,
        reason,
        table_name,
        record_id,
        current.as_ref(),
    )
}

/// 保留策略：只保留最新的 `max_batches` 个批次，更旧的批次整批删除。
///
/// 批次新旧按批内最大行 id 排序（AUTOINCREMENT 单调，比 `created_at`
/// 字符串更稳，不受同秒并发影响）。返回被删除的行数。
pub fn prune_batches_to_cap(conn: &Connection, max_batches: usize) -> Result<u64, SyncError> {
    ensure_history_table(conn)?;
    let deleted = conn
        .execute(
            "DELETE FROM __sync_record_history WHERE batch_id NOT IN (
                 SELECT batch_id FROM __sync_record_history
                 GROUP BY batch_id
                 ORDER BY MAX(id) DESC
                 LIMIT ?1
             )",
            params![max_batches as i64],
        )
        .map_err(|e| SyncError::Database(format!("清理历史快照失败: {}", e)))?;
    Ok(deleted as u64)
}

/// 快照批次摘要（供 UI 列表）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotBatchSummary {
    pub batch_id: String,
    pub reason: String,
    pub created_at: String,
    pub record_count: u64,
    pub rolled_back_at: Option<String>,
}

/// 列出最近的快照批次（新的在前）
pub fn list_batches(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<SnapshotBatchSummary>, SyncError> {
    let table_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_record_history')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !table_exists {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT batch_id, reason, MIN(created_at), COUNT(*), MAX(rolled_back_at)
             FROM __sync_record_history
             GROUP BY batch_id
             ORDER BY MAX(id) DESC
             LIMIT ?1",
        )
        .map_err(|e| SyncError::Database(format!("准备快照批次查询失败: {}", e)))?;
    let rows = stmt
        .query_map(params![limit as i64], |row| {
            Ok(SnapshotBatchSummary {
                batch_id: row.get(0)?,
                reason: row.get(1)?,
                created_at: row.get(2)?,
                record_count: row.get::<_, i64>(3)?.max(0) as u64,
                rolled_back_at: row.get(4)?,
            })
        })
        .map_err(|e| SyncError::Database(format!("查询快照批次失败: {}", e)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| SyncError::Database(format!("解析快照批次失败: {}", e)))?);
    }
    Ok(out)
}

/// 单批回退的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackOutcome {
    pub batch_id: String,
    /// 恢复（UPSERT 回快照值）的记录数
    pub restored: usize,
    /// 因快照时不存在而被删除的记录数
    pub deleted: usize,
    /// 已处于快照状态、无需改动的记录数
    pub skipped: usize,
    /// 回退前自动创建的撤销点批次 id
    pub undo_batch_id: String,
}

/// 读取一份记录里参与 UPSERT / DELETE LWW 的时间戳下界。
fn record_lww_millis(data: &serde_json::Value) -> Option<i64> {
    ["updated_at", "deleted_at"]
        .iter()
        .filter_map(|key| {
            data.get(*key)
                .and_then(SyncManager::timestamp_value_to_lww_string)
                .and_then(|value| SyncManager::lww_timestamp_millis(&value))
        })
        .max()
}

/// 生成严格晚于当前胜方的回退时间戳。
///
/// 不能只使用本机 `now`：同步入口允许远端 wall clock 在
/// `MAX_DRIFT_MS` 范围内超前。若刚应用一条未来数十秒的合法云端胜方后立即
/// 回退，单纯写 `now` 会让旧云端值在下一次重放时再次赢得 LWW；硬删除还会
/// 被 `__sync_delete_versions` 阻止复活。这里同时观察当前行、目标快照和
/// DELETE 版本账本，并在最大物理毫秒后加一。
fn next_rollback_timestamp(
    conn: &Connection,
    table_name: &str,
    record_id: &str,
    current: Option<&serde_json::Value>,
    snapshot: Option<&serde_json::Value>,
) -> Result<(i64, String), SyncError> {
    let now_millis = chrono::Utc::now().timestamp_millis();
    let mut observed_millis = current
        .and_then(record_lww_millis)
        .into_iter()
        .chain(snapshot.and_then(record_lww_millis))
        .max();

    let has_delete_versions: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type='table' AND name='__sync_delete_versions'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if has_delete_versions {
        let delete_timestamp: Option<String> = conn
            .query_row(
                "SELECT changed_at FROM __sync_delete_versions
                 WHERE table_name = ?1 AND record_id = ?2",
                params![table_name, record_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| SyncError::Database(format!("读取回退 DELETE 版本失败: {}", e)))?;
        if let Some(delete_millis) = delete_timestamp
            .as_deref()
            .and_then(SyncManager::lww_timestamp_millis)
        {
            observed_millis =
                Some(observed_millis.map_or(delete_millis, |value| value.max(delete_millis)));
        }
    }

    let rollback_millis = match observed_millis {
        Some(value) if value >= now_millis => value.saturating_add(1),
        _ => now_millis,
    };
    let rollback_rfc3339 = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(rollback_millis)
        .ok_or_else(|| SyncError::Database("生成回退 LWW 时间戳失败".to_string()))?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok((rollback_millis, rollback_rfc3339))
}

/// 把 `updated_at` 提升到回退 LWW 时间（保留原值的数值/字符串形态）。
fn refresh_updated_at(data: &mut serde_json::Value, rollback_millis: i64, rollback_rfc3339: &str) {
    if let Some(obj) = data.as_object_mut() {
        if let Some(current) = obj.get("updated_at") {
            let refreshed = if current.is_number() {
                serde_json::Value::Number(rollback_millis.into())
            } else {
                serde_json::Value::String(rollback_rfc3339.to_string())
            };
            obj.insert("updated_at".to_string(), refreshed);
        }
    }
}

/// 按批次回退：把批内每条记录恢复到快照时的状态。
///
/// - 快照时存在 → 以刷新过 `updated_at` 的快照值 UPSERT 回业务表；
/// - 快照时不存在 → 删除该记录；
/// - 全程 `suppress_change_log=false`：回退产生的变更进入 change_log
///   （`sync_version=0` 待上传），下次同步广播给其他设备；
/// - 回退前把当前状态快照成 `rollback_undo` 批次（回退可再撤销）；
/// - 同一批次只能回退一次（`rolled_back_at` 非空即拒绝）。
pub fn rollback_batch(
    conn: &Connection,
    batch_id: &str,
    id_column_map: Option<&HashMap<String, String>>,
    database_name: Option<&str>,
) -> Result<RollbackOutcome, SyncError> {
    ensure_history_table(conn)?;

    let already_rolled_back: Option<String> = conn
        .query_row(
            "SELECT MAX(rolled_back_at) FROM __sync_record_history WHERE batch_id = ?1",
            params![batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| SyncError::Database(format!("读取快照批次状态失败: {}", e)))?
        .flatten();
    if already_rolled_back.is_some() {
        return Err(SyncError::Database(format!(
            "快照批次 {} 已回退过，不能重复回退（回退本身已生成新的撤销点批次）",
            batch_id
        )));
    }

    let snapshots: Vec<(String, String, bool, Option<String>)> = {
        let mut stmt = conn
            .prepare(
                "SELECT table_name, record_id, existed, data_json
                 FROM __sync_record_history WHERE batch_id = ?1 ORDER BY id ASC",
            )
            .map_err(|e| SyncError::Database(format!("准备快照读取失败: {}", e)))?;
        let rows = stmt
            .query_map(params![batch_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? != 0,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| SyncError::Database(format!("读取快照失败: {}", e)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| SyncError::Database(format!("解析快照失败: {}", e)))?);
        }
        out
    };
    if snapshots.is_empty() {
        return Err(SyncError::Database(format!(
            "快照批次 {} 不存在或已被保留策略清理",
            batch_id
        )));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let undo_batch_id = new_batch_id();

    let mut changes: Vec<SyncChangeWithData> = Vec::with_capacity(snapshots.len());
    let mut skipped = 0usize;
    let mut restored = 0usize;
    let mut deleted = 0usize;
    for (table_name, record_id, existed, data_json) in &snapshots {
        let id_column = id_column_map
            .and_then(|m| m.get(table_name))
            .map(String::as_str)
            .unwrap_or("id");
        let current = SyncManager::get_record_data(conn, table_name, record_id, id_column)?;
        let (operation, data, changed_at) = if *existed {
            let raw = data_json.as_deref().ok_or_else(|| {
                SyncError::Database(format!(
                    "快照数据缺失: {}.{}（existed=1 但 data_json 为空）",
                    table_name, record_id
                ))
            })?;
            let mut value: serde_json::Value = serde_json::from_str(raw)
                .map_err(|e| SyncError::Database(format!("解析快照数据失败: {}", e)))?;
            // 已经处于快照状态：无需改动（也避免无谓刷新 updated_at 触发上传）
            if let Some(current_value) = &current {
                if SyncManager::records_semantically_equal_for_sync(current_value, &value) {
                    skipped += 1;
                    continue;
                }
            }
            let (rollback_millis, rollback_rfc3339) = next_rollback_timestamp(
                conn,
                table_name,
                record_id,
                current.as_ref(),
                Some(&value),
            )?;
            refresh_updated_at(&mut value, rollback_millis, &rollback_rfc3339);
            restored += 1;
            (ChangeOperation::Update, Some(value), rollback_rfc3339)
        } else {
            if current.is_none() {
                skipped += 1;
                continue;
            }
            let (_, rollback_rfc3339) =
                next_rollback_timestamp(conn, table_name, record_id, current.as_ref(), None)?;
            deleted += 1;
            (ChangeOperation::Delete, None, rollback_rfc3339)
        };
        changes.push(SyncChangeWithData {
            table_name: table_name.clone(),
            record_id: record_id.clone(),
            operation,
            data,
            changed_at,
            change_log_id: None,
            database_name: database_name.map(str::to_string),
            // 回退结果必须进 change_log 才能上传广播、并以新时间戳压过旧值
            suppress_change_log: Some(false),
            source_device_id: None,
            source_seq: None,
        });
    }

    let mark_batch_id = batch_id.to_string();
    let mark_now = now.clone();
    if changes.is_empty() {
        // 所有记录都已处于快照状态：只标记批次已回退（幂等语义）
        conn.execute(
            "UPDATE __sync_record_history SET rolled_back_at = ?1 WHERE batch_id = ?2",
            params![&now, batch_id],
        )
        .map_err(|e| SyncError::Database(format!("标记快照批次已回退失败: {}", e)))?;
        return Ok(RollbackOutcome {
            batch_id: batch_id.to_string(),
            restored,
            deleted,
            skipped,
            undo_batch_id,
        });
    }

    // 撤销点内容在事务内采集（preflight），与业务写回同一原子边界
    let undo_targets: Vec<(String, String, String)> = changes
        .iter()
        .map(|change| {
            let id_column = id_column_map
                .and_then(|m| m.get(&change.table_name))
                .map(String::as_str)
                .unwrap_or("id")
                .to_string();
            (
                change.table_name.clone(),
                change.record_id.clone(),
                id_column,
            )
        })
        .collect();
    let undo_batch_for_hook = undo_batch_id.clone();

    SyncManager::apply_downloaded_changes_force_exact_with_hooks(
        conn,
        &changes,
        id_column_map,
        move |transaction_conn| {
            for (table_name, record_id, id_column) in &undo_targets {
                snapshot_record(
                    transaction_conn,
                    &undo_batch_for_hook,
                    REASON_ROLLBACK_UNDO,
                    table_name,
                    record_id,
                    id_column,
                )?;
            }
            Ok(())
        },
        move |transaction_conn, _apply_result| {
            transaction_conn
                .execute(
                    "UPDATE __sync_record_history SET rolled_back_at = ?1 WHERE batch_id = ?2",
                    params![&mark_now, &mark_batch_id],
                )
                .map_err(|e| SyncError::Database(format!("标记快照批次已回退失败: {}", e)))?;
            Ok(())
        },
    )?;

    Ok(RollbackOutcome {
        batch_id: batch_id.to_string(),
        restored,
        deleted,
        skipped,
        undo_batch_id,
    })
}
