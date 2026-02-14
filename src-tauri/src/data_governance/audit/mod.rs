//! # Audit 模块
//!
//! 统一审计日志系统，记录所有数据治理操作。
//!
//! ## 设计原则
//!
//! 1. **结构化日志**：所有操作记录为结构化数据
//! 2. **可查询**：支持按操作类型、时间范围查询
//! 3. **持久化**：写入专用 SQLite 表
//!
//! ## 审计内容
//!
//! - 迁移操作（Migration）
//! - 备份操作（Backup）
//! - 恢复操作（Restore）
//! - 同步操作（Sync）

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

#[cfg(feature = "data_governance")]

/// 审计日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLog {
    /// 唯一 ID
    pub id: String,
    /// 时间戳
    pub timestamp: DateTime<Utc>,
    /// 操作类型
    pub operation: AuditOperation,
    /// 操作目标（数据库名或文件路径）
    pub target: String,
    /// 状态
    pub status: AuditStatus,
    /// 耗时（毫秒）
    pub duration_ms: Option<u64>,
    /// 详细信息（JSON）
    pub details: serde_json::Value,
    /// 错误信息（如果有）
    pub error_message: Option<String>,
}

/// 审计操作类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuditOperation {
    /// 迁移操作
    Migration {
        from_version: u32,
        to_version: u32,
        applied_count: usize,
    },
    /// 备份操作
    Backup {
        backup_type: BackupType,
        file_count: usize,
        total_size: u64,
    },
    /// 恢复操作
    Restore { backup_path: String },
    /// 同步操作
    Sync {
        direction: SyncDirection,
        records_affected: usize,
    },
    /// 维护操作（审计清理、缓存清理等）
    Maintenance {
        action: String,
    },
}

/// 备份类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BackupType {
    /// 完整备份
    Full,
    /// 增量备份
    Incremental,
    /// 自动备份
    Auto,
}

/// 同步方向
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SyncDirection {
    /// 上传到云端
    Upload,
    /// 从云端下载
    Download,
    /// 双向同步
    Bidirectional,
}

/// 审计状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuditStatus {
    /// 开始
    Started,
    /// 完成
    Completed,
    /// 失败
    Failed,
    /// 部分成功
    Partial,
}

impl AuditLog {
    /// 创建新的审计日志
    pub fn new(operation: AuditOperation, target: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            operation,
            target: target.into(),
            status: AuditStatus::Started,
            duration_ms: None,
            details: serde_json::Value::Null,
            error_message: None,
        }
    }

    /// 标记为完成
    pub fn complete(mut self, duration_ms: u64) -> Self {
        self.status = AuditStatus::Completed;
        self.duration_ms = Some(duration_ms);
        self
    }

    /// 标记为失败
    pub fn fail(mut self, error: impl Into<String>) -> Self {
        self.status = AuditStatus::Failed;
        self.error_message = Some(error.into());
        self
    }

    /// 添加详细信息
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = details;
        self
    }
}

/// 审计数据库连接管理
///
/// 用于在 Tauri State 中管理审计日志数据库连接。
pub struct AuditDatabase {
    /// 数据库连接
    conn: std::sync::Mutex<Connection>,
}

impl AuditDatabase {
    /// 创建新的审计数据库连接
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: std::sync::Mutex::new(conn),
        }
    }

    /// 从路径打开审计数据库
    pub fn open(path: &std::path::Path) -> Result<Self, AuditError> {
        let conn = Connection::open(path).map_err(|e| AuditError::Database(e.to_string()))?;
        Ok(Self::new(conn))
    }

    /// 获取数据库连接
    pub fn get_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, AuditError> {
        self.conn
            .lock()
            .map_err(|e| AuditError::Database(format!("Failed to acquire lock: {}", e)))
    }

    /// 初始化审计表
    pub fn init(&self) -> Result<(), AuditError> {
        let conn = self.get_conn()?;
        AuditRepository::init(&conn)
    }
}

/// 审计日志仓库
pub struct AuditRepository;

impl AuditRepository {
    /// 创建审计表的 SQL
    pub const CREATE_TABLE_SQL: &'static str = r#"
        CREATE TABLE IF NOT EXISTS __audit_log (
            id TEXT PRIMARY KEY NOT NULL,
            timestamp TEXT NOT NULL,
            operation_type TEXT NOT NULL,
            operation_data TEXT NOT NULL,
            target TEXT NOT NULL,
            status TEXT NOT NULL,
            duration_ms INTEGER,
            details TEXT,
            error_message TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON __audit_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_log_operation_type ON __audit_log(operation_type);
        CREATE INDEX IF NOT EXISTS idx_audit_log_status ON __audit_log(status);
    "#;

    /// 插入审计日志的 SQL
    const INSERT_SQL: &'static str = r#"
        INSERT INTO __audit_log (
            id, timestamp, operation_type, operation_data, target,
            status, duration_ms, details, error_message
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    "#;

    /// 初始化审计表
    pub fn init(conn: &Connection) -> Result<(), AuditError> {
        conn.execute_batch(Self::CREATE_TABLE_SQL)
            .map_err(|e| AuditError::Database(e.to_string()))?;
        Ok(())
    }

    /// 保存审计日志
    pub fn save(conn: &Connection, log: &AuditLog) -> Result<(), AuditError> {
        let operation_type = Self::operation_type_str(&log.operation);
        let operation_data = serde_json::to_string(&log.operation)?;
        let status_str = Self::status_to_str(&log.status);
        let details_str = serde_json::to_string(&log.details)?;
        let timestamp_str = log.timestamp.to_rfc3339();

        conn.execute(
            Self::INSERT_SQL,
            params![
                log.id,
                timestamp_str,
                operation_type,
                operation_data,
                log.target,
                status_str,
                log.duration_ms,
                details_str,
                log.error_message,
            ],
        )
        .map_err(|e| AuditError::Database(e.to_string()))?;

        Ok(())
    }

    /// 查询审计日志
    pub fn query(conn: &Connection, filter: AuditFilter) -> Result<Vec<AuditLog>, AuditError> {
        let mut sql = String::from(
            "SELECT id, timestamp, operation_type, operation_data, target,
                    status, duration_ms, details, error_message
             FROM __audit_log WHERE 1=1",
        );
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut param_idx = 1;

        // 构建动态查询条件
        if let Some(ref op_type) = filter.operation_type {
            sql.push_str(&format!(" AND operation_type = ?{}", param_idx));
            params_vec.push(Box::new(op_type.clone()));
            param_idx += 1;
        }

        if let Some(ref from_time) = filter.from_time {
            sql.push_str(&format!(" AND timestamp >= ?{}", param_idx));
            params_vec.push(Box::new(from_time.to_rfc3339()));
            param_idx += 1;
        }

        if let Some(ref to_time) = filter.to_time {
            sql.push_str(&format!(" AND timestamp <= ?{}", param_idx));
            params_vec.push(Box::new(to_time.to_rfc3339()));
            param_idx += 1;
        }

        if let Some(ref status) = filter.status {
            sql.push_str(&format!(" AND status = ?{}", param_idx));
            params_vec.push(Box::new(Self::status_to_str(status)));
            // param_idx += 1; // 不再需要，但保留以便将来扩展
        }

        // 按时间倒序排列
        sql.push_str(" ORDER BY timestamp DESC");

        // 限制返回数量
        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT {}", limit));
        }

        // 分页偏移
        if let Some(offset) = filter.offset {
            if offset > 0 {
                sql.push_str(&format!(" OFFSET {}", offset));
            }
        }

        // 执行查询
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AuditError::Database(e.to_string()))?;

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|b| b.as_ref()).collect();

        let rows = stmt
            .query_map(params_refs.as_slice(), Self::row_to_audit_log)
            .map_err(|e| AuditError::Database(e.to_string()))?;

        let mut logs = Vec::new();
        for row_result in rows {
            let log = row_result.map_err(|e| AuditError::Database(e.to_string()))?;
            logs.push(log?);
        }

        Ok(logs)
    }

    /// 分页查询审计日志（返回列表 + 满足条件的总数）
    ///
    /// 与 `query` 类似，但额外返回满足过滤条件的总记录数，
    /// 以便前端计算分页。
    pub fn query_paged(
        conn: &Connection,
        filter: AuditFilter,
    ) -> Result<AuditQueryResult, AuditError> {
        // 构建 WHERE 子句（与 query 共用逻辑）
        let mut where_clause = String::from(" WHERE 1=1");
        let mut count_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut param_idx = 1;

        if let Some(ref op_type) = filter.operation_type {
            where_clause.push_str(&format!(" AND operation_type = ?{}", param_idx));
            count_params.push(Box::new(op_type.clone()));
            param_idx += 1;
        }

        if let Some(ref from_time) = filter.from_time {
            where_clause.push_str(&format!(" AND timestamp >= ?{}", param_idx));
            count_params.push(Box::new(from_time.to_rfc3339()));
            param_idx += 1;
        }

        if let Some(ref to_time) = filter.to_time {
            where_clause.push_str(&format!(" AND timestamp <= ?{}", param_idx));
            count_params.push(Box::new(to_time.to_rfc3339()));
            param_idx += 1;
        }

        if let Some(ref status) = filter.status {
            where_clause.push_str(&format!(" AND status = ?{}", param_idx));
            count_params.push(Box::new(Self::status_to_str(status).to_string()));
            // param_idx += 1;
        }

        // 1) 查询总数
        let count_sql = format!("SELECT COUNT(*) FROM __audit_log{}", where_clause);
        let count_refs: Vec<&dyn rusqlite::ToSql> =
            count_params.iter().map(|b| b.as_ref()).collect();
        let total: i64 = conn
            .query_row(&count_sql, count_refs.as_slice(), |row| row.get(0))
            .map_err(|e| AuditError::Database(e.to_string()))?;

        // 2) 查询数据（复用 query 方法，已含 offset/limit）
        let logs = Self::query(conn, filter)?;

        Ok(AuditQueryResult {
            logs,
            total: total as u64,
        })
    }

    /// 按 ID 查询单条审计日志
    pub fn find_by_id(conn: &Connection, id: &str) -> Result<Option<AuditLog>, AuditError> {
        let sql = "SELECT id, timestamp, operation_type, operation_data, target,
                          status, duration_ms, details, error_message
                   FROM __audit_log WHERE id = ?1";

        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| AuditError::Database(e.to_string()))?;

        let mut rows = stmt
            .query_map(params![id], Self::row_to_audit_log)
            .map_err(|e| AuditError::Database(e.to_string()))?;

        if let Some(row_result) = rows.next() {
            let log = row_result.map_err(|e| AuditError::Database(e.to_string()))?;
            return Ok(Some(log?));
        }

        Ok(None)
    }

    /// 统计指定类型的操作数量
    pub fn count_by_type(conn: &Connection, operation_type: &str) -> Result<u64, AuditError> {
        let sql = "SELECT COUNT(*) FROM __audit_log WHERE operation_type = ?1";
        let count: i64 = conn
            .query_row(sql, params![operation_type], |row| row.get(0))
            .map_err(|e| AuditError::Database(e.to_string()))?;
        Ok(count as u64)
    }

    /// 获取最近的 N 条日志
    pub fn recent(conn: &Connection, limit: usize) -> Result<Vec<AuditLog>, AuditError> {
        Self::query(
            conn,
            AuditFilter {
                limit: Some(limit),
                ..Default::default()
            },
        )
    }

    // ==================== 清理方法 ====================

    /// 清理旧审计日志，保留最近 N 条
    ///
    /// 按时间倒序保留最近的 `keep_count` 条记录，删除其余所有记录。
    ///
    /// ## 返回
    /// 被删除的记录数量
    pub fn cleanup_keep_recent(conn: &Connection, keep_count: usize) -> Result<u64, AuditError> {
        let sql = "DELETE FROM __audit_log WHERE id NOT IN (
            SELECT id FROM __audit_log ORDER BY timestamp DESC LIMIT ?1
        )";
        let deleted = conn
            .execute(sql, params![keep_count as i64])
            .map_err(|e| AuditError::Database(e.to_string()))?;
        Ok(deleted as u64)
    }

    /// 清理指定时间之前的审计日志
    ///
    /// 删除 `before` 时间之前的所有记录。
    ///
    /// ## 返回
    /// 被删除的记录数量
    pub fn cleanup_before(conn: &Connection, before: &DateTime<Utc>) -> Result<u64, AuditError> {
        let sql = "DELETE FROM __audit_log WHERE timestamp < ?1";
        let deleted = conn
            .execute(sql, params![before.to_rfc3339()])
            .map_err(|e| AuditError::Database(e.to_string()))?;
        Ok(deleted as u64)
    }

    /// 获取审计日志总数
    pub fn count_all(conn: &Connection) -> Result<u64, AuditError> {
        let sql = "SELECT COUNT(*) FROM __audit_log";
        let count: i64 = conn
            .query_row(sql, [], |row| row.get(0))
            .map_err(|e| AuditError::Database(e.to_string()))?;
        Ok(count as u64)
    }

    /// 清理超过指定天数的审计日志
    ///
    /// 便捷方法，删除 `max_age_days` 天之前的所有记录。
    ///
    /// ## 返回
    /// 被删除的记录数量
    pub fn cleanup_old_entries(conn: &Connection, max_age_days: u32) -> Result<u64, AuditError> {
        let before = Utc::now() - chrono::Duration::days(max_age_days as i64);
        Self::cleanup_before(conn, &before)
    }

    /// 获取审计日志条目总数（别名）
    ///
    /// 与 `count_all` 语义一致，提供更直观的方法名。
    pub fn get_entry_count(conn: &Connection) -> Result<u64, AuditError> {
        Self::count_all(conn)
    }

    // ==================== 便捷方法：Migration ====================

    /// 记录迁移开始
    pub fn log_migration_start(
        conn: &Connection,
        target: &str,
        from_version: u32,
        to_version: u32,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Migration {
                from_version,
                to_version,
                applied_count: 0,
            },
            target,
        );
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    /// 记录迁移完成
    pub fn log_migration_complete(
        conn: &Connection,
        target: &str,
        from_version: u32,
        to_version: u32,
        applied_count: usize,
        duration_ms: u64,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Migration {
                from_version,
                to_version,
                applied_count,
            },
            target,
        )
        .complete(duration_ms);
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    /// 记录迁移失败
    pub fn log_migration_failed(
        conn: &Connection,
        target: &str,
        from_version: u32,
        to_version: u32,
        error: &str,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Migration {
                from_version,
                to_version,
                applied_count: 0,
            },
            target,
        )
        .fail(error);
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    // ==================== 便捷方法：Backup ====================

    /// 记录备份开始
    pub fn log_backup_start(
        conn: &Connection,
        target: &str,
        backup_type: BackupType,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Backup {
                backup_type,
                file_count: 0,
                total_size: 0,
            },
            target,
        );
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    /// 记录备份完成
    pub fn log_backup_complete(
        conn: &Connection,
        target: &str,
        backup_type: BackupType,
        file_count: usize,
        total_size: u64,
        duration_ms: u64,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Backup {
                backup_type,
                file_count,
                total_size,
            },
            target,
        )
        .complete(duration_ms);
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    /// 记录备份失败
    pub fn log_backup_failed(
        conn: &Connection,
        target: &str,
        backup_type: BackupType,
        error: &str,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Backup {
                backup_type,
                file_count: 0,
                total_size: 0,
            },
            target,
        )
        .fail(error);
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    // ==================== 便捷方法：Restore ====================

    /// 记录恢复开始
    pub fn log_restore_start(conn: &Connection, backup_path: &str) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Restore {
                backup_path: backup_path.to_string(),
            },
            backup_path,
        );
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    /// 记录恢复完成
    pub fn log_restore_complete(
        conn: &Connection,
        backup_path: &str,
        duration_ms: u64,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Restore {
                backup_path: backup_path.to_string(),
            },
            backup_path,
        )
        .complete(duration_ms);
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    /// 记录恢复失败
    pub fn log_restore_failed(
        conn: &Connection,
        backup_path: &str,
        error: &str,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Restore {
                backup_path: backup_path.to_string(),
            },
            backup_path,
        )
        .fail(error);
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    // ==================== 便捷方法：Sync ====================

    /// 记录同步开始
    pub fn log_sync_start(
        conn: &Connection,
        target: &str,
        direction: SyncDirection,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Sync {
                direction,
                records_affected: 0,
            },
            target,
        );
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    /// 记录同步完成
    pub fn log_sync_complete(
        conn: &Connection,
        target: &str,
        direction: SyncDirection,
        records_affected: usize,
        duration_ms: u64,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Sync {
                direction,
                records_affected,
            },
            target,
        )
        .complete(duration_ms);
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    /// 记录同步失败
    pub fn log_sync_failed(
        conn: &Connection,
        target: &str,
        direction: SyncDirection,
        error: &str,
    ) -> Result<String, AuditError> {
        let log = AuditLog::new(
            AuditOperation::Sync {
                direction,
                records_affected: 0,
            },
            target,
        )
        .fail(error);
        let id = log.id.clone();
        Self::save(conn, &log)?;
        Ok(id)
    }

    // ==================== 私有辅助方法 ====================

    /// 从数据库行解析 AuditLog
    fn row_to_audit_log(row: &Row) -> rusqlite::Result<Result<AuditLog, AuditError>> {
        let id: String = row.get(0)?;
        let timestamp_str: String = row.get(1)?;
        let _operation_type: String = row.get(2)?;
        let operation_data: String = row.get(3)?;
        let target: String = row.get(4)?;
        let status_str: String = row.get(5)?;
        let duration_ms: Option<u64> = row.get(6)?;
        let details_str: Option<String> = row.get(7)?;
        let error_message: Option<String> = row.get(8)?;

        // 解析时间戳
        let timestamp = match DateTime::parse_from_rfc3339(&timestamp_str) {
            Ok(dt) => dt.with_timezone(&Utc),
            Err(e) => {
                return Ok(Err(AuditError::Database(format!(
                    "Invalid timestamp: {}",
                    e
                ))))
            }
        };

        // 解析操作类型
        let operation: AuditOperation = match serde_json::from_str(&operation_data) {
            Ok(op) => op,
            Err(e) => return Ok(Err(AuditError::Serialization(e))),
        };

        // 解析状态
        let status = Self::str_to_status(&status_str);

        // 解析详情
        let details = match details_str {
            Some(ref s) if !s.is_empty() => {
                serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
            }
            _ => serde_json::Value::Null,
        };

        Ok(Ok(AuditLog {
            id,
            timestamp,
            operation,
            target,
            status,
            duration_ms,
            details,
            error_message,
        }))
    }

    /// 操作类型转字符串
    fn operation_type_str(op: &AuditOperation) -> &'static str {
        match op {
            AuditOperation::Migration { .. } => "Migration",
            AuditOperation::Backup { .. } => "Backup",
            AuditOperation::Restore { .. } => "Restore",
            AuditOperation::Sync { .. } => "Sync",
            AuditOperation::Maintenance { .. } => "Maintenance",
        }
    }

    /// 状态转字符串
    fn status_to_str(status: &AuditStatus) -> &'static str {
        match status {
            AuditStatus::Started => "Started",
            AuditStatus::Completed => "Completed",
            AuditStatus::Failed => "Failed",
            AuditStatus::Partial => "Partial",
        }
    }

    /// 字符串转状态
    fn str_to_status(s: &str) -> AuditStatus {
        match s {
            "Started" => AuditStatus::Started,
            "Completed" => AuditStatus::Completed,
            "Failed" => AuditStatus::Failed,
            "Partial" => AuditStatus::Partial,
            _ => AuditStatus::Started,
        }
    }
}

/// 审计日志查询过滤器
#[derive(Debug, Default)]
pub struct AuditFilter {
    /// 操作类型（可选）
    pub operation_type: Option<String>,
    /// 开始时间（可选）
    pub from_time: Option<DateTime<Utc>>,
    /// 结束时间（可选）
    pub to_time: Option<DateTime<Utc>>,
    /// 状态（可选）
    pub status: Option<AuditStatus>,
    /// 最大返回数量
    pub limit: Option<usize>,
    /// 偏移量（用于分页）
    pub offset: Option<usize>,
}

/// 带分页信息的审计日志查询结果
#[derive(Debug)]
pub struct AuditQueryResult {
    /// 审计日志列表
    pub logs: Vec<AuditLog>,
    /// 满足过滤条件的总记录数（不受 limit/offset 影响）
    pub total: u64,
}

/// 审计错误
#[derive(Debug, thiserror::Error)]
pub enum AuditError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Not implemented: {0}")]
    NotImplemented(String),
}
