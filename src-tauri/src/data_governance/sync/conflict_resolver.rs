//! # 记录级冲突解决器
//!
//! 在下载的云端变更即将覆盖本地之前，检查是否与本地未同步的变更发生冲突；
//! 若发生冲突则根据策略生成一份"冲突副本"并上报给调用方，而非静默 LWW。
//!
//! ## 冲突定义
//!
//! 对一条 (table, record_id) 记录，当云端 change 满足以下所有条件时视为潜在冲突：
//! 1. 本地存在该记录（`get_record_data(...)` 返回 Some）
//! 2. 本地该记录在 `__change_log` 里有 `sync_version = 0` 的未同步变更（意味着本地也改过）
//! 3. 本地数据的"业务指纹"（除同步元数据外的字段 JSON）与云端即将写入的数据不同
//!
//! 任何一条不满足就不是冲突 —— 比如本地只是旧状态、云端单方面更新，就是正常的下行。
//!
//! ## 解决策略
//!
//! - `ConflictPolicy::KeepCloud`：云端写入本地，原本地值追加到 `__sync_conflicts` 表里
//! - `ConflictPolicy::KeepLocal`：本地值保留，云端值追加到 `__sync_conflicts` 表里
//! - `ConflictPolicy::KeepLatest`：时间戳更晚者胜，落败方进 `__sync_conflicts` 表
//!
//! **无论哪种策略，落败方都不会被丢弃**，而是保留在冲突表供 UI 展示 / 用户手动决策。
//!
//! ## 冲突表（每库各一份）
//!
//! ```sql
//! CREATE TABLE __sync_conflicts (
//!     id INTEGER PRIMARY KEY AUTOINCREMENT,
//!     table_name TEXT NOT NULL,
//!     record_id TEXT NOT NULL,
//!     side TEXT NOT NULL CHECK(side IN ('local','cloud')),  -- 哪一端被保留成副本
//!     data_json TEXT NOT NULL,                               -- 被保留的那一端完整数据
//!     winning_device_id TEXT,                                -- 最终胜出的设备
//!     losing_device_id TEXT,                                 -- 被保留为副本的设备
//!     detected_at TEXT NOT NULL DEFAULT (datetime('now')),   -- 冲突检出时间
//!     resolved_at TEXT,                                      -- 用户手动处理时间
//!     resolution TEXT                                        -- keep_local | keep_cloud | merged | discarded
//! );
//! ```
//!
//! 冲突表保留在每个业务数据库内，跟随数据库一起备份/恢复。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::{ChangeOperation, SyncChangeWithData, SyncError, SyncManager};

/// 冲突解决策略
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    /// 云端胜出，本地旧值进冲突表
    KeepCloud,
    /// 本地胜出，云端值进冲突表（拒绝应用）
    KeepLocal,
    /// 时间戳较新者胜出，较旧者进冲突表
    KeepLatest,
}

/// 单次冲突检测的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictOutcome {
    /// 最终生效的一端
    pub winner: ConflictSide,
    /// 进冲突表的一端
    pub loser: ConflictSide,
    /// 胜方数据
    pub winner_data: serde_json::Value,
    /// 败方数据
    pub loser_data: serde_json::Value,
}

/// 冲突端标识
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictSide {
    Local,
    Cloud,
}

/// 冲突表写入参数
#[derive(Debug, Clone)]
pub struct ConflictRecordToSave<'a> {
    pub table_name: &'a str,
    pub record_id: &'a str,
    pub side: ConflictSide,
    pub data: &'a serde_json::Value,
    pub winning_device_id: Option<&'a str>,
    pub losing_device_id: Option<&'a str>,
}

/// 应用了冲突检测的变更应用结果
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConflictAwareApplyResult {
    /// 成功写入的变更数
    pub applied: usize,
    /// 被冲突保护拒绝写入的变更数
    pub rejected: usize,
    /// 生成的冲突记录数（= rejected × 2，因为双方都入表）
    pub conflicts_saved: usize,
    /// 按表聚合的冲突摘要
    pub conflicts_by_table: HashMap<String, usize>,
}

impl ConflictAwareApplyResult {
    pub fn is_clean(&self) -> bool {
        self.rejected == 0
    }
}

/// 冲突解决器
pub struct ConflictResolver {
    policy: ConflictPolicy,
    /// 允许一个灰区容差：本地和云端时间戳相差在此值内视为同时刻（走 policy 的 tie-break）
    clock_skew_tolerance_secs: i64,
}

impl ConflictResolver {
    pub fn new(policy: ConflictPolicy) -> Self {
        Self {
            policy,
            clock_skew_tolerance_secs: 2,
        }
    }

    pub fn with_tolerance(mut self, secs: i64) -> Self {
        self.clock_skew_tolerance_secs = secs.max(0);
        self
    }

    /// 在一个数据库连接上初始化冲突表（幂等）
    ///
    /// 结构变更（批判报告 P0-3）：
    /// - 新增 `data_hash` 列（`sha256(data_json)` 前 16 字节 hex），
    ///   与 `(table_name, record_id, side)` 组合成部分唯一索引，约束条件
    ///   `WHERE resolved_at IS NULL`。
    /// - 语义：同一未解决记录的相同 side + 相同内容只保留一条，避免回放或
    ///   prune gap 跨轮同步时同一对冲突被反复累积。
    /// - 用户一旦把条目标记为 `resolved`，后续再出现同内容的冲突**会**重新记录
    ///   （这是需要的：表示"解决之后又出现了新的分歧"）。
    ///
    /// 升级路径：`CREATE TABLE IF NOT EXISTS` 不会修改已有表结构。对于升级场景，
    /// 后续通过 `ALTER TABLE ADD COLUMN` 补齐 `data_hash` 列；失败则静默（列已存在）。
    pub fn ensure_conflict_table(conn: &Connection) -> Result<(), SyncError> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS __sync_conflicts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                side TEXT NOT NULL CHECK(side IN ('local','cloud')),
                data_json TEXT NOT NULL,
                data_hash TEXT NOT NULL DEFAULT '',
                winning_device_id TEXT,
                losing_device_id TEXT,
                detected_at TEXT NOT NULL DEFAULT (datetime('now')),
                resolved_at TEXT,
                resolution TEXT
            );
            CREATE INDEX IF NOT EXISTS idx__sync_conflicts_unresolved
                ON __sync_conflicts(resolved_at) WHERE resolved_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx__sync_conflicts_record
                ON __sync_conflicts(table_name, record_id);
            "#,
        )
        .map_err(|e| SyncError::Database(format!("创建 __sync_conflicts 失败: {}", e)))?;

        // 升级老表：如果 data_hash 列不存在则追加（best-effort）
        let has_data_hash: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('__sync_conflicts') WHERE name = 'data_hash'",
                [],
                |row| row.get::<_, i64>(0).map(|n| n > 0),
            )
            .unwrap_or(false);
        if !has_data_hash {
            // 老数据库升级：追加列。列默认 ''，老冲突条目 hash 全为空字符串，
            // 它们之间**可能**误合（同一 record+side 的老条目被视为重复）——
            // 这是一次性升级代价，接受：老冲突已经没有正确的 hash 无法精确去重。
            let _ = conn.execute(
                "ALTER TABLE __sync_conflicts ADD COLUMN data_hash TEXT NOT NULL DEFAULT ''",
                [],
            );
        }

        // 部分唯一索引：对"未解决"的冲突做 (table, record, side, data_hash) 去重。
        // 一旦 resolved_at 被写入，这条记录就退出去重空间，允许相同内容再次出现。
        conn.execute_batch(
            r#"
            CREATE UNIQUE INDEX IF NOT EXISTS idx__sync_conflicts_dedup
                ON __sync_conflicts(table_name, record_id, side, data_hash)
                WHERE resolved_at IS NULL;
            "#,
        )
        .map_err(|e| SyncError::Database(format!("创建冲突表去重索引失败: {}", e)))?;

        Ok(())
    }

    /// 计算冲突数据的稳定哈希（用于去重键）
    ///
    /// 用 `canonicalize_for_compare` 规范化后再哈希，这样：
    /// - 字段顺序不同但内容相同的 JSON 会得到相同 hash
    /// - 同步元字段（`sync_version` 等）的差异不会影响去重判定
    /// - 嵌套的 JSON 字符串（SQLite TEXT 列里存 `"[]"` vs Array）语义等价
    fn compute_data_hash(data: &serde_json::Value) -> String {
        use sha2::{Digest, Sha256};
        let canonical = canonicalize_for_compare(data);
        let s = serde_json::to_string(&canonical).unwrap_or_default();
        let h = Sha256::digest(s.as_bytes());
        hex::encode(&h[..16])
    }

    /// 检查指定记录是否有"本地未同步的变更"（即 local_version > sync_version 语义的等价判断）
    ///
    /// 由于项目中 __change_log 只存变更日志而非记录上的 local_version，
    /// 这里使用"该 record_id 在 __change_log 中是否有 sync_version = 0 的条目"作为代理。
    fn local_has_unsynced_change(
        conn: &Connection,
        table_name: &str,
        record_id: &str,
    ) -> Result<bool, SyncError> {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __change_log
                 WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0",
                params![table_name, record_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(count > 0)
    }

    /// 比较两份记录（忽略同步元数据字段）是否"业务上不同"
    ///
    /// ## 以云端字段集为基准
    ///
    /// 云端 payload 经常只包含被写入者关心的字段（例如只改 title 的用户只发 title）。
    /// 为避免"云端缺字段就被判为不等"的误冲突，我们**只比较云端 payload 里出现的字段**。
    /// 这与 apply_single_record 的 COALESCE 语义一致：没出现的字段保留本地，不参与业务等值判断。
    fn differs_semantically(local: &serde_json::Value, cloud: &serde_json::Value) -> bool {
        let cloud_keys: std::collections::HashSet<String> = match cloud {
            serde_json::Value::Object(obj) => obj.keys().cloned().collect(),
            _ => {
                // cloud 非对象，退化到完整比较
                return canonicalize_for_compare(local) != canonicalize_for_compare(cloud);
            }
        };

        let local_subset = match local {
            serde_json::Value::Object(obj) => {
                let filtered: serde_json::Map<String, serde_json::Value> = obj
                    .iter()
                    .filter(|(k, _)| cloud_keys.contains(k.as_str()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                serde_json::Value::Object(filtered)
            }
            _ => local.clone(),
        };

        canonicalize_for_compare(&local_subset) != canonicalize_for_compare(cloud)
    }

    /// 提取记录的 updated_at 时间戳（用于 KeepLatest 策略的仲裁）
    fn extract_updated_at(value: &serde_json::Value) -> Option<chrono::DateTime<chrono::Utc>> {
        let s = value.get("updated_at").and_then(|v| v.as_str())?;
        crate::data_governance::sync::parse_flexible_timestamp_public(s)
    }

    /// 判定一条下载变更是否需要走冲突保护逻辑
    ///
    /// 返回值:
    /// - `None` -> 非冲突（按正常流程应用）
    /// - `Some(outcome)` -> 冲突，按 outcome.winner 决定是否写入，并把 outcome.loser 记入冲突表
    pub fn resolve_one(
        &self,
        conn: &Connection,
        change: &SyncChangeWithData,
        id_column: &str,
    ) -> Result<Option<ConflictOutcome>, SyncError> {
        // DELETE 操作单独处理：
        // - 本地无未同步修改 → 直接删，不冲突
        // - 本地有未同步修改且记录仍存在 → 冲突（把本地当前值存副本，按 policy 决定是否真删）
        if change.operation == ChangeOperation::Delete {
            let has_local_change =
                Self::local_has_unsynced_change(conn, &change.table_name, &change.record_id)?;
            if !has_local_change {
                return Ok(None);
            }
            let local_data = SyncManager::get_record_data(
                conn,
                &change.table_name,
                &change.record_id,
                id_column,
            )?;
            let Some(local_data) = local_data else {
                return Ok(None);
            };
            // 虚拟的"云端已删除"值：用 null 表示
            let cloud_data = serde_json::Value::Null;
            let (winner, loser) = match self.policy {
                ConflictPolicy::KeepCloud => (ConflictSide::Cloud, ConflictSide::Local),
                ConflictPolicy::KeepLocal => (ConflictSide::Local, ConflictSide::Cloud),
                ConflictPolicy::KeepLatest => {
                    // 删除没有 updated_at 语义，用 change.changed_at 代替；同时刻时偏向保留本地（安全优先）
                    let cloud_ts = crate::data_governance::sync::parse_flexible_timestamp_public(
                        &change.changed_at,
                    );
                    let local_ts = Self::extract_updated_at(&local_data);
                    match (local_ts, cloud_ts) {
                        (Some(l), Some(c)) => {
                            let diff = (c - l).num_seconds();
                            if diff > self.clock_skew_tolerance_secs {
                                (ConflictSide::Cloud, ConflictSide::Local)
                            } else {
                                (ConflictSide::Local, ConflictSide::Cloud)
                            }
                        }
                        _ => (ConflictSide::Local, ConflictSide::Cloud),
                    }
                }
            };
            return Ok(Some(ConflictOutcome {
                winner,
                loser,
                winner_data: if winner == ConflictSide::Cloud {
                    cloud_data.clone()
                } else {
                    local_data.clone()
                },
                loser_data: if loser == ConflictSide::Cloud {
                    cloud_data
                } else {
                    local_data
                },
            }));
        }

        // INSERT/UPDATE 路径
        let cloud_data = match &change.data {
            Some(d) => d.clone(),
            None => return Ok(None), // 没有数据的变更（legacy v1）不参与冲突检测
        };

        let has_local_change =
            Self::local_has_unsynced_change(conn, &change.table_name, &change.record_id)?;
        if !has_local_change {
            return Ok(None);
        }

        let local_data = match SyncManager::get_record_data(
            conn,
            &change.table_name,
            &change.record_id,
            id_column,
        )? {
            Some(v) => v,
            None => {
                // 本地有未同步变更（可能已被用户删除），但当前查不到记录 —— 视为非冲突
                return Ok(None);
            }
        };

        if !Self::differs_semantically(&local_data, &cloud_data) {
            // 双方数据相同 → 不是真冲突
            return Ok(None);
        }

        // 有真冲突：按策略裁决
        let (winner, loser) = match self.policy {
            ConflictPolicy::KeepCloud => (ConflictSide::Cloud, ConflictSide::Local),
            ConflictPolicy::KeepLocal => (ConflictSide::Local, ConflictSide::Cloud),
            ConflictPolicy::KeepLatest => {
                let local_ts = Self::extract_updated_at(&local_data);
                let cloud_ts = Self::extract_updated_at(&cloud_data).or_else(|| {
                    crate::data_governance::sync::parse_flexible_timestamp_public(
                        &change.changed_at,
                    )
                });
                match (local_ts, cloud_ts) {
                    (Some(l), Some(c)) => {
                        let diff_secs = (c - l).num_seconds();
                        if diff_secs.abs() <= self.clock_skew_tolerance_secs {
                            // 近似同时刻：偏向保留本地（"已在用"）
                            (ConflictSide::Local, ConflictSide::Cloud)
                        } else if diff_secs > 0 {
                            (ConflictSide::Cloud, ConflictSide::Local)
                        } else {
                            (ConflictSide::Local, ConflictSide::Cloud)
                        }
                    }
                    (Some(_), None) => (ConflictSide::Local, ConflictSide::Cloud),
                    (None, Some(_)) => (ConflictSide::Cloud, ConflictSide::Local),
                    (None, None) => (ConflictSide::Local, ConflictSide::Cloud),
                }
            }
        };

        Ok(Some(ConflictOutcome {
            winner,
            loser,
            winner_data: if winner == ConflictSide::Cloud {
                cloud_data.clone()
            } else {
                local_data.clone()
            },
            loser_data: if loser == ConflictSide::Cloud {
                cloud_data
            } else {
                local_data
            },
        }))
    }

    /// 写一条副本到冲突表
    ///
    /// 去重语义（批判报告 P0-3 修复）：
    /// - 基于 `(table_name, record_id, side, data_hash)` 做部分唯一约束，
    ///   范围仅限 `resolved_at IS NULL`
    /// - 重复写入相同内容会被 `ON CONFLICT(...) DO NOTHING` 吞掉，
    ///   **不会** 递增 id、**不会** 污染冲突面板
    /// - 一旦用户手动 resolve，后续即便同一内容再次出现也会重新记录
    ///   （语义上这是"解决之后又发生了相同内容的新冲突"，需要告知用户）
    pub fn save_conflict_record(
        conn: &Connection,
        rec: ConflictRecordToSave<'_>,
    ) -> Result<(), SyncError> {
        Self::ensure_conflict_table(conn)?;
        let data_str = serde_json::to_string(rec.data)
            .map_err(|e| SyncError::Database(format!("序列化冲突数据失败: {}", e)))?;
        let data_hash = Self::compute_data_hash(rec.data);
        conn.execute(
            "INSERT INTO __sync_conflicts
             (table_name, record_id, side, data_json, data_hash, winning_device_id, losing_device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(table_name, record_id, side, data_hash) WHERE resolved_at IS NULL
             DO NOTHING",
            params![
                rec.table_name,
                rec.record_id,
                match rec.side {
                    ConflictSide::Local => "local",
                    ConflictSide::Cloud => "cloud",
                },
                data_str,
                data_hash,
                rec.winning_device_id,
                rec.losing_device_id,
            ],
        )
        .map_err(|e| SyncError::Database(format!("写入冲突表失败: {}", e)))?;
        Ok(())
    }
}

/// 规范化一个 JSON 对象用于"业务等值"比较：
/// - 对象：剔除同步元字段后按 key 排序
/// - 数组：保持顺序
/// - 字符串：如果外形像 JSON（以 `{` 或 `[` 开头），尝试解析成 JSON 后再规范化。
///   这是为了抹平"SQLite 把 '[]' / '{}' 当字符串存储，但 `get_record_data` 读出时
///   会自动 parse 成 Array/Object"的不对称。
/// - 其余：原样
fn canonicalize_for_compare(value: &serde_json::Value) -> serde_json::Value {
    const STRIP_KEYS: &[&str] = &[
        "sync_version",
        "local_version",
        "updated_at",
        "last_synced_at",
        "last_attempt_at",
        "indexed_at",
        "mm_indexed_at",
        "remote_version",
        "remote_id",
        "sync_status",
        "content_hash",
    ];
    match value {
        serde_json::Value::Object(obj) => {
            let mut sorted: Vec<(String, serde_json::Value)> = obj
                .iter()
                .filter(|(k, _)| !STRIP_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), canonicalize_for_compare(v)))
                .collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            serde_json::Value::Object(sorted.into_iter().collect())
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(canonicalize_for_compare).collect())
        }
        serde_json::Value::String(s) => {
            let trimmed = s.trim_start();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    return canonicalize_for_compare(&parsed);
                }
            }
            serde_json::Value::String(s.clone())
        }
        other => other.clone(),
    }
}
