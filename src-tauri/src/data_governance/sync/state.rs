use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

use super::SyncError;

const DEFAULT_INSTANCE_ID: &str = "default";

/// 同步状态存储。
///
/// 连接在 `open_default` 时打开一次并完成建表，之后所有操作复用同一连接
/// （此前每次操作都重新 `Connection::open` + `CREATE TABLE IF NOT EXISTS`，
/// 一次同步会触发数百次开库/建表开销）。`Clone` 共享同一底层连接。
#[derive(Debug, Clone)]
pub struct SyncStateStore {
    conn: Arc<Mutex<Connection>>,
}

impl SyncStateStore {
    pub fn open_default() -> Result<Self, SyncError> {
        let base_dir = dirs::data_local_dir()
            .or_else(dirs::data_dir)
            .or_else(dirs::config_dir)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base_dir.join("deep-student").join("sync");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("sync_state.db");

        let conn = Connection::open(&path)
            .map_err(|e| SyncError::Database(format!("打开 sync_state.db 失败: {}", e)))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| {
                SyncError::Database(format!("设置 sync_state busy_timeout 失败: {}", e))
            })?;
        Self::init(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn default_instance_id() -> &'static str {
        DEFAULT_INSTANCE_ID
    }

    fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, SyncError>,
    ) -> Result<T, SyncError> {
        let conn = self.conn.lock().unwrap_or_else(|poisoned| {
            // 仅守护普通 SQL 操作，前一持有者 panic 不会让连接处于损坏状态
            poisoned.into_inner()
        });
        f(&conn)
    }

    fn init(conn: &Connection) -> Result<(), SyncError> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS upload_seq (
                instance_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                last_seq INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (instance_id, device_id)
            );
            CREATE TABLE IF NOT EXISTS consume_cursor (
                instance_id TEXT NOT NULL,
                uploader_device_id TEXT NOT NULL,
                last_seq INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (instance_id, uploader_device_id)
            );
            CREATE TABLE IF NOT EXISTS legacy_processed_key (
                instance_id TEXT NOT NULL,
                object_key TEXT NOT NULL,
                processed_at TEXT NOT NULL,
                PRIMARY KEY (instance_id, object_key)
            );
            CREATE TABLE IF NOT EXISTS tombstone_watermark (
                instance_id TEXT NOT NULL,
                source_device_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                last_applied_offset INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (instance_id, source_device_id, kind)
            );
            CREATE TABLE IF NOT EXISTS tombstone_event_publish (
                instance_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (instance_id, device_id, kind, operation_id),
                UNIQUE (instance_id, device_id, kind, seq)
            );
            CREATE TABLE IF NOT EXISTS instance_binding (
                instance_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                endpoint_hint TEXT NOT NULL,
                bound_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_history (
                old_device_id TEXT NOT NULL,
                new_device_id TEXT NOT NULL,
                rotated_at TEXT NOT NULL,
                reason TEXT NOT NULL,
                PRIMARY KEY (old_device_id, new_device_id)
            );
            "#,
        )
        .map_err(|e| SyncError::Database(format!("初始化 sync_state.db 失败: {}", e)))?;
        Ok(())
    }

    pub fn bind_instance(
        &self,
        instance_id: &str,
        provider: &str,
        endpoint_hint: &str,
    ) -> Result<(), SyncError> {
        self.with_conn(|conn| {
            let existing: Option<(String, String)> = conn
                .query_row(
                    "SELECT provider, endpoint_hint FROM instance_binding WHERE instance_id=?1",
                    params![instance_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| SyncError::Database(format!("读取实例绑定失败: {}", e)))?;

            if let Some((bound_provider, bound_hint)) = existing {
                if bound_provider != provider || bound_hint != endpoint_hint {
                    return Err(SyncError::Network(format!(
                        "云同步实例绑定不匹配：远端 instance_id={} 之前绑定到 {} / {}，当前为 {} / {}。请重置同步基线或确认这是同一份云端数据后再继续。",
                        instance_id, bound_provider, bound_hint, provider, endpoint_hint
                    )));
                }
                return Ok(());
            }

            conn.execute(
                "INSERT INTO instance_binding(instance_id, provider, endpoint_hint, bound_at)
                 VALUES(?1, ?2, ?3, ?4)",
                params![instance_id, provider, endpoint_hint, Utc::now().to_rfc3339()],
            )
            .map_err(|e| SyncError::Database(format!("写入实例绑定失败: {}", e)))?;
            Ok(())
        })
    }

    pub fn get_tombstone_watermark(
        &self,
        instance_id: &str,
        source_device_id: &str,
        kind: &str,
    ) -> Result<u64, SyncError> {
        self.with_conn(|conn| {
            let watermark: Option<i64> = conn
                .query_row(
                    "SELECT last_applied_offset FROM tombstone_watermark
                     WHERE instance_id=?1 AND source_device_id=?2 AND kind=?3",
                    params![instance_id, source_device_id, kind],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| SyncError::Database(format!("读取 tombstone 水位失败: {}", e)))?;
            Ok(watermark.unwrap_or(0).max(0) as u64)
        })
    }

    pub fn set_tombstone_watermark(
        &self,
        instance_id: &str,
        source_device_id: &str,
        kind: &str,
        last_applied_offset: u64,
    ) -> Result<(), SyncError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tombstone_watermark(instance_id, source_device_id, kind, last_applied_offset, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(instance_id, source_device_id, kind)
                 DO UPDATE SET last_applied_offset=max(tombstone_watermark.last_applied_offset, excluded.last_applied_offset),
                               updated_at=excluded.updated_at",
                params![
                    instance_id,
                    source_device_id,
                    kind,
                    i64::try_from(last_applied_offset).unwrap_or(i64::MAX),
                    Utc::now().to_rfc3339()
                ],
            )
            .map_err(|e| SyncError::Database(format!("写入 tombstone 水位失败: {}", e)))?;
            Ok(())
        })
    }

    /// 为不可变删除事件保留稳定序号。同一 operation_id 重试总是返回原序号，
    /// PUT 失败也不会改用新 key 产生重复事件。
    pub fn reserve_tombstone_event_seq(
        &self,
        instance_id: &str,
        device_id: &str,
        kind: &str,
        operation_id: &str,
        cloud_max_seq: u64,
    ) -> Result<u64, SyncError> {
        self.reserve_tombstone_event_seq_with_existing(
            instance_id,
            device_id,
            kind,
            operation_id,
            cloud_max_seq,
            None,
        )
    }

    /// `cloud_existing_seq` 用于本地 sync_state 丢失后的幂等恢复：若云端已存在同一
    /// operation_id，重新绑定原序号，而不是产生第二个删除事件。
    pub fn reserve_tombstone_event_seq_with_existing(
        &self,
        instance_id: &str,
        device_id: &str,
        kind: &str,
        operation_id: &str,
        cloud_max_seq: u64,
        cloud_existing_seq: Option<u64>,
    ) -> Result<u64, SyncError> {
        self.with_conn(|conn| {
            let tx = conn.unchecked_transaction().map_err(|e| {
                SyncError::Database(format!("开始 tombstone 事件序号事务失败: {}", e))
            })?;
            if let Some(existing) = tx
                .query_row(
                    "SELECT seq FROM tombstone_event_publish
                     WHERE instance_id=?1 AND device_id=?2 AND kind=?3 AND operation_id=?4",
                    params![instance_id, device_id, kind, operation_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|e| SyncError::Database(format!("读取 tombstone 事件序号失败: {}", e)))?
            {
                tx.commit().map_err(|e| {
                    SyncError::Database(format!("提交 tombstone 事件序号事务失败: {}", e))
                })?;
                return Ok(existing.max(0) as u64);
            }

            let local_max: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(seq), 0) FROM tombstone_event_publish
                     WHERE instance_id=?1 AND device_id=?2 AND kind=?3",
                    params![instance_id, device_id, kind],
                    |row| row.get(0),
                )
                .map_err(|e| SyncError::Database(format!("读取 tombstone 最大序号失败: {}", e)))?;
            let next = match cloud_existing_seq {
                Some(existing) if existing > 0 => i64::try_from(existing).unwrap_or(i64::MAX),
                _ => local_max
                    .max(i64::try_from(cloud_max_seq).unwrap_or(i64::MAX))
                    .saturating_add(1),
            };
            tx.execute(
                "INSERT INTO tombstone_event_publish
                 (instance_id, device_id, kind, operation_id, seq, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    instance_id,
                    device_id,
                    kind,
                    operation_id,
                    next,
                    Utc::now().to_rfc3339()
                ],
            )
            .map_err(|e| SyncError::Database(format!("保留 tombstone 事件序号失败: {}", e)))?;
            tx.commit().map_err(|e| {
                SyncError::Database(format!("提交 tombstone 事件序号事务失败: {}", e))
            })?;
            Ok(next.max(0) as u64)
        })
    }

    pub fn device_rotations_for_new(
        &self,
        new_device_id: &str,
    ) -> Result<Vec<(String, String)>, SyncError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT old_device_id, reason FROM device_history WHERE new_device_id=?1")
                .map_err(|e| SyncError::Database(format!("读取设备轮换历史失败: {}", e)))?;
            let rows = stmt
                .query_map(params![new_device_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|e| SyncError::Database(format!("查询设备轮换历史失败: {}", e)))?;
            let mut result = Vec::new();
            for row in rows {
                result.push(
                    row.map_err(|e| SyncError::Database(format!("解析设备轮换历史失败: {}", e)))?,
                );
            }
            Ok(result)
        })
    }

    pub fn next_upload_seq(
        &self,
        instance_id: &str,
        device_id: &str,
        cloud_max_seq: u64,
    ) -> Result<u64, SyncError> {
        self.with_conn(|conn| {
            let local: Option<i64> = conn
                .query_row(
                    "SELECT last_seq FROM upload_seq WHERE instance_id=?1 AND device_id=?2",
                    params![instance_id, device_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| SyncError::Database(format!("读取上传序号失败: {}", e)))?;
            let next = local
                .unwrap_or(0)
                .max(i64::try_from(cloud_max_seq).unwrap_or(i64::MAX))
                .saturating_add(1);
            Ok(next as u64)
        })
    }

    pub fn mark_published_seq(
        &self,
        instance_id: &str,
        device_id: &str,
        seq: u64,
    ) -> Result<(), SyncError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO upload_seq(instance_id, device_id, last_seq, updated_at)
                 VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(instance_id, device_id)
                 DO UPDATE SET last_seq=max(upload_seq.last_seq, excluded.last_seq),
                               updated_at=excluded.updated_at",
                params![
                    instance_id,
                    device_id,
                    i64::try_from(seq).unwrap_or(i64::MAX),
                    Utc::now().to_rfc3339()
                ],
            )
            .map_err(|e| SyncError::Database(format!("写入已发布上传序号失败: {}", e)))?;
            Ok(())
        })
    }

    pub fn published_max_seq(&self, instance_id: &str, device_id: &str) -> Result<u64, SyncError> {
        self.with_conn(|conn| {
            let seq: Option<i64> = conn
                .query_row(
                    "SELECT last_seq FROM upload_seq WHERE instance_id=?1 AND device_id=?2",
                    params![instance_id, device_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| SyncError::Database(format!("读取发布序号失败: {}", e)))?;
            Ok(seq.unwrap_or(0).max(0) as u64)
        })
    }

    pub fn get_cursor(
        &self,
        instance_id: &str,
        uploader_device_id: &str,
    ) -> Result<u64, SyncError> {
        self.with_conn(|conn| {
            let seq: Option<i64> = conn
                .query_row(
                    "SELECT last_seq FROM consume_cursor WHERE instance_id=?1 AND uploader_device_id=?2",
                    params![instance_id, uploader_device_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| SyncError::Database(format!("读取消费游标失败: {}", e)))?;
            Ok(seq.unwrap_or(0).max(0) as u64)
        })
    }

    pub fn set_cursor(
        &self,
        instance_id: &str,
        uploader_device_id: &str,
        last_seq: u64,
    ) -> Result<(), SyncError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO consume_cursor(instance_id, uploader_device_id, last_seq, updated_at)
                 VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(instance_id, uploader_device_id)
                 DO UPDATE SET last_seq=max(consume_cursor.last_seq, excluded.last_seq),
                               updated_at=excluded.updated_at",
                params![
                    instance_id,
                    uploader_device_id,
                    i64::try_from(last_seq).unwrap_or(i64::MAX),
                    Utc::now().to_rfc3339()
                ],
            )
            .map_err(|e| SyncError::Database(format!("写入消费游标失败: {}", e)))?;
            Ok(())
        })
    }

    pub fn cursors(&self, instance_id: &str) -> Result<HashMap<String, u64>, SyncError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT uploader_device_id, last_seq FROM consume_cursor WHERE instance_id=?1",
                )
                .map_err(|e| SyncError::Database(format!("读取消费游标失败: {}", e)))?;
            let mut rows = stmt
                .query(params![instance_id])
                .map_err(|e| SyncError::Database(format!("查询消费游标失败: {}", e)))?;
            let mut cursors = HashMap::new();
            while let Some(row) = rows
                .next()
                .map_err(|e| SyncError::Database(format!("遍历消费游标失败: {}", e)))?
            {
                let device_id: String = row
                    .get(0)
                    .map_err(|e| SyncError::Database(format!("读取游标设备失败: {}", e)))?;
                let seq: i64 = row
                    .get(1)
                    .map_err(|e| SyncError::Database(format!("读取游标序号失败: {}", e)))?;
                cursors.insert(device_id, seq.max(0) as u64);
            }
            Ok(cursors)
        })
    }

    pub fn is_legacy_processed(
        &self,
        instance_id: &str,
        object_key: &str,
    ) -> Result<bool, SyncError> {
        self.with_conn(|conn| {
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM legacy_processed_key WHERE instance_id=?1 AND object_key=?2",
                    params![instance_id, object_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| {
                    SyncError::Database(format!("读取 legacy processed key 失败: {}", e))
                })?;
            Ok(exists.is_some())
        })
    }

    pub fn mark_legacy_processed(
        &self,
        instance_id: &str,
        object_key: &str,
    ) -> Result<(), SyncError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO legacy_processed_key(instance_id, object_key, processed_at)
                 VALUES(?1, ?2, ?3)",
                params![instance_id, object_key, Utc::now().to_rfc3339()],
            )
            .map_err(|e| SyncError::Database(format!("写入 legacy processed key 失败: {}", e)))?;
            Ok(())
        })
    }

    /// 记录设备轮换（仅在备份恢复后调用）。
    ///
    /// 恢复操作把本地数据回滚到旧时点，本地"已消费/已应用"状态不再可信，
    /// 因此清空所有实例的消费游标、legacy 处理记录与 tombstone 水位，
    /// 强制下次同步重新消费云端全部变更——变更应用是幂等的（LWW + UPSERT），
    /// 跨实例多余重放只有时间代价、没有正确性代价。
    ///
    /// 注意：**不**清零 `upload_seq`。上传序号由 `next_upload_seq` 取
    /// `max(本地, 云端)+1`，保留本地值只会让序号偏大（无害）；反之全局清零
    /// 会破坏其他实例的单调性依据，在云端列举不全（如 PROPFIND 截断）时
    /// 可能复用已存在的 seq 而被其他设备的消费游标静默跳过。
    pub fn record_device_rotation(
        &self,
        old_device_id: &str,
        new_device_id: &str,
        reason: &str,
    ) -> Result<(), SyncError> {
        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction().map_err(|e| {
                SyncError::Database(format!("开始设备轮换事务失败: {}", e))
            })?;
            transaction.execute(
                "INSERT OR REPLACE INTO device_history(old_device_id, new_device_id, rotated_at, reason)
                 VALUES(?1, ?2, ?3, ?4)",
                params![old_device_id, new_device_id, Utc::now().to_rfc3339(), reason],
            )
            .map_err(|e| SyncError::Database(format!("记录设备轮换失败: {}", e)))?;
            transaction.execute(
                "UPDATE consume_cursor SET last_seq=0, updated_at=?1",
                params![Utc::now().to_rfc3339()],
            )
            .map_err(|e| SyncError::Database(format!("重置消费游标失败: {}", e)))?;
            transaction.execute("DELETE FROM legacy_processed_key", [])
                .map_err(|e| SyncError::Database(format!("清理 legacy processed key 失败: {}", e)))?;
            transaction.execute("DELETE FROM tombstone_watermark", [])
                .map_err(|e| SyncError::Database(format!("重置 tombstone 水位失败: {}", e)))?;
            transaction.commit().map_err(|e| {
                SyncError::Database(format!("提交设备轮换事务失败: {}", e))
            })?;
            Ok(())
        })
    }

    /// 清空本机数据后重置所有“已消费”状态。
    ///
    /// `upload_seq` 故意保留：同一 device_id 在远端可能已有历史对象，序号回退会
    /// 复用旧 key，并被其他设备的 consume cursor 静默跳过。其余状态若保留，
    /// 空白本地库会误以为历史云端变更已经消费，形成永久缺行。
    pub fn reset_default_after_local_purge() -> Result<(), SyncError> {
        let store = Self::open_default()?;
        store.with_conn(|conn| {
            let transaction = conn
                .unchecked_transaction()
                .map_err(|e| SyncError::Database(format!("开始清空同步基线事务失败: {}", e)))?;
            for table in [
                "consume_cursor",
                "legacy_processed_key",
                "tombstone_watermark",
                "instance_binding",
                "device_history",
            ] {
                transaction
                    .execute(&format!("DELETE FROM {}", table), [])
                    .map_err(|e| {
                        SyncError::Database(format!("清空同步状态表 {} 失败: {}", table, e))
                    })?;
            }
            transaction
                .commit()
                .map_err(|e| SyncError::Database(format!("提交清空同步基线事务失败: {}", e)))?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_store() -> SyncStateStore {
        let conn = Connection::open_in_memory().unwrap();
        SyncStateStore::init(&conn).unwrap();
        SyncStateStore {
            conn: Arc::new(Mutex::new(conn)),
        }
    }

    #[test]
    fn tombstone_event_sequence_is_monotonic_and_idempotent() {
        let store = memory_store();
        let first = store
            .reserve_tombstone_event_seq("instance", "device", "assets", "operation-a", 0)
            .unwrap();
        let retry = store
            .reserve_tombstone_event_seq("instance", "device", "assets", "operation-a", 99)
            .unwrap();
        let next = store
            .reserve_tombstone_event_seq("instance", "device", "assets", "operation-b", 7)
            .unwrap();

        assert_eq!(first, 1);
        assert_eq!(retry, first);
        assert_eq!(next, 8);
    }
}
