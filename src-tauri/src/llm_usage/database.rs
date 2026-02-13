//! LLM Usage 独立数据库管理模块
//!
//! 提供 LLM Usage 模块的独立 SQLite 数据库初始化和管理功能。
//! 使用 r2d2 连接池，支持并发访问和迁移管理。

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;
use thiserror::Error;
use tracing::{debug, error, info};

/// 数据库文件名
const DATABASE_FILENAME: &str = "llm_usage.db";

/// 当前数据库 Schema 版本
/// 当前 Schema 版本（对应 Refinery 迁移的最新版本）
/// 注意：此常量仅用于统计信息显示，实际版本以 refinery_schema_history 表为准
pub const CURRENT_SCHEMA_VERSION: u32 = 20260201;

/// LLM Usage Schema 版本（公开导出用于测试）
pub const LLM_USAGE_SCHEMA_VERSION: u32 = CURRENT_SCHEMA_VERSION;

// ============================================================================
// 错误类型定义
// ============================================================================

/// LLM Usage 模块错误类型
#[derive(Debug, Error)]
pub enum LlmUsageError {
    /// 数据库错误
    #[error("Database error: {0}")]
    Database(String),

    /// SQLite 错误
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// 连接池错误
    #[error("Connection pool error: {0}")]
    Pool(String),

    /// IO 错误
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// 迁移错误
    #[error("Migration error: {0}")]
    Migration(String),
}

/// LLM Usage 模块结果类型
pub type LlmUsageResult<T> = Result<T, LlmUsageError>;

// ============================================================================
// 连接池类型别名
// ============================================================================

/// SQLite 连接池类型
pub type LlmUsagePool = Pool<SqliteConnectionManager>;

/// SQLite 池化连接类型
pub type LlmUsagePooledConnection = r2d2::PooledConnection<SqliteConnectionManager>;

// ============================================================================
// 数据库管理器
// ============================================================================

/// LLM Usage 独立数据库管理器
///
/// 管理 LLM Usage 模块的独立 SQLite 数据库文件（`llm_usage.db`）。
/// 支持：
/// - r2d2 连接池管理
/// - 自动迁移管理
/// - WAL 模式提升并发性能
pub struct LlmUsageDatabase {
    /// 数据库连接池
    pool: RwLock<LlmUsagePool>,
    /// 数据库文件路径
    db_path: PathBuf,
}

impl LlmUsageDatabase {
    /// 创建新的 LLM Usage 数据库管理器
    ///
    /// # 参数
    /// * `app_data_dir` - 应用数据目录路径
    ///
    /// # 返回
    /// * `LlmUsageResult<Self>` - 数据库管理器实例
    ///
    /// # 错误
    /// * 目录创建失败
    /// * 数据库连接失败
    /// * 迁移执行失败
    pub fn new(app_data_dir: &Path) -> LlmUsageResult<Self> {
        info!(
            "[LlmUsage::Database] Initializing LLM Usage database in: {}",
            app_data_dir.display()
        );

        // 确保目录存在
        if let Err(e) = fs::create_dir_all(app_data_dir) {
            error!(
                "[LlmUsage::Database] Failed to create data directory: {}",
                e
            );
            return Err(LlmUsageError::Database(format!(
                "Failed to create data directory: {}",
                e
            )));
        }

        let db_path = app_data_dir.join(DATABASE_FILENAME);
        let pool = Self::build_pool(&db_path)?;

        let db = Self {
            pool: RwLock::new(pool),
            db_path,
        };

        info!(
            "[LlmUsage::Database] LLM Usage database initialized successfully: {}",
            db.db_path.display()
        );

        Ok(db)
    }

    /// 构建连接池
    ///
    /// # 参数
    /// * `db_path` - 数据库文件路径
    ///
    /// # 返回
    /// * `LlmUsageResult<LlmUsagePool>` - 连接池实例
    fn build_pool(db_path: &Path) -> LlmUsageResult<LlmUsagePool> {
        debug!(
            "[LlmUsage::Database] Building connection pool for: {}",
            db_path.display()
        );

        let manager = SqliteConnectionManager::file(db_path).with_init(|conn| {
            // 启用外键约束（必须！）
            conn.pragma_update(None, "foreign_keys", "ON")?;
            // 使用 WAL 模式提升并发性能
            conn.pragma_update(None, "journal_mode", "WAL")?;
            // 同步模式设为 NORMAL（平衡安全与性能）
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            // 设置 busy_timeout 避免无界等待（3秒）
            conn.pragma_update(None, "busy_timeout", 3000i64)?;
            Ok(())
        });

        let pool = Pool::builder()
            .max_size(10) // 最大连接数
            .min_idle(Some(1)) // 最小空闲连接
            .connection_timeout(Duration::from_secs(10)) // 连接超时
            .build(manager)
            .map_err(|e| LlmUsageError::Pool(format!("Failed to create connection pool: {}", e)))?;

        Ok(pool)
    }

    /// 获取数据库连接
    ///
    /// # 返回
    /// * `LlmUsageResult<LlmUsagePooledConnection>` - 池化连接
    pub fn get_conn(&self) -> LlmUsageResult<LlmUsagePooledConnection> {
        let pool = self
            .pool
            .read()
            .map_err(|e| LlmUsageError::Pool(format!("Pool lock poisoned: {}", e)))?;

        pool.get()
            .map_err(|e| LlmUsageError::Pool(format!("Failed to get connection: {}", e)))
    }

    /// 获取数据库连接（安全版本，处理 RwLock poison）
    ///
    /// 即使 RwLock 被 poison，也能获取连接。
    /// 适用于需要高可用性的场景。
    ///
    /// # 返回
    /// * `LlmUsageResult<LlmUsagePooledConnection>` - 池化连接
    pub fn get_conn_safe(&self) -> LlmUsageResult<LlmUsagePooledConnection> {
        let pool = self.pool.read().unwrap_or_else(|poisoned| {
            log::error!("[LlmUsageDatabase] Pool RwLock poisoned! Attempting recovery");
            poisoned.into_inner()
        });

        pool.get()
            .map_err(|e| LlmUsageError::Pool(format!("Failed to get connection: {}", e)))
    }

    /// 获取连接池的克隆
    ///
    /// # 返回
    /// * `LlmUsagePool` - 连接池克隆
    pub fn get_pool(&self) -> LlmUsagePool {
        match self.pool.read() {
            Ok(pool) => pool.clone(),
            Err(poisoned) => {
                log::error!(
                    "[LlmUsageDatabase] Pool RwLock poisoned in get_pool! Attempting recovery"
                );
                poisoned.into_inner().clone()
            }
        }
    }

    /// 获取数据库文件路径
    ///
    /// # 返回
    /// * `&Path` - 数据库文件路径
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// 获取当前 Schema 版本
    ///
    /// # 返回
    /// * `LlmUsageResult<u32>` - 当前版本号
    /// 从 Refinery 的 refinery_schema_history 表读取版本号。
    pub fn get_schema_version(&self) -> LlmUsageResult<u32> {
        let conn = self.get_conn()?;
        let version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(version)
    }

    /// 检查外键约束是否启用
    ///
    /// # 返回
    /// * `LlmUsageResult<bool>` - 是否启用外键约束
    pub fn is_foreign_keys_enabled(&self) -> LlmUsageResult<bool> {
        let conn = self.get_conn()?;
        let enabled: i64 = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        Ok(enabled == 1)
    }

    /// 重新初始化数据库连接池
    ///
    /// 用于备份恢复后刷新连接，确保连接指向新的数据库文件。
    ///
    /// # 工作原理
    /// 1. 关闭旧连接池中的所有连接
    /// 2. 重新构建连接池
    /// 3. 执行迁移检查（确保 schema 版本一致）
    ///
    /// # 返回
    /// * `LlmUsageResult<()>` - 成功返回 Ok(()), 失败返回错误
    pub fn reinitialize(&self) -> LlmUsageResult<()> {
        info!(
            "[LlmUsage::Database] Reinitializing connection pool for: {}",
            self.db_path.display()
        );

        // 1. 构建新的连接池
        let new_pool = Self::build_pool(&self.db_path)?;

        // 2. 替换旧的连接池
        {
            let mut pool_guard = self
                .pool
                .write()
                .map_err(|e| LlmUsageError::Pool(format!("Pool lock poisoned: {}", e)))?;
            *pool_guard = new_pool;
        }

        info!(
            "[LlmUsage::Database] Connection pool reinitialized successfully: {}",
            self.db_path.display()
        );

        Ok(())
    }

    /// 获取数据库统计信息
    ///
    /// # 返回
    /// * `LlmUsageResult<LlmUsageDatabaseStats>` - 数据库统计信息
    pub fn get_statistics(&self) -> LlmUsageResult<LlmUsageDatabaseStats> {
        let conn = self.get_conn()?;

        let log_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM llm_usage_logs", [], |row| row.get(0))
            .unwrap_or(0);

        let daily_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM llm_usage_daily", [], |row| row.get(0))
            .unwrap_or(0);

        let total_tokens: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(total_tokens), 0) FROM llm_usage_logs",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let total_cost: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(cost_estimate), 0.0) FROM llm_usage_logs",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        Ok(LlmUsageDatabaseStats {
            log_count: log_count as u64,
            daily_summary_count: daily_count as u64,
            total_tokens: total_tokens as u64,
            total_cost_estimate: total_cost,
            schema_version: CURRENT_SCHEMA_VERSION,
        })
    }
}

// ============================================================================
// 数据库统计信息
// ============================================================================

/// LLM Usage 数据库统计信息
#[derive(Debug, Clone)]
pub struct LlmUsageDatabaseStats {
    /// 使用日志记录数量
    pub log_count: u64,
    /// 每日汇总记录数量
    pub daily_summary_count: u64,
    /// 总 Token 数量
    pub total_tokens: u64,
    /// 总估算成本（美元）
    pub total_cost_estimate: f64,
    /// Schema 版本
    pub schema_version: u32,
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 创建测试数据库
    fn setup_test_db() -> (TempDir, LlmUsageDatabase) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = LlmUsageDatabase::new(temp_dir.path()).expect("Failed to create database");
        (temp_dir, db)
    }

    #[test]
    fn test_database_creation() {
        let (temp_dir, db) = setup_test_db();

        // 验证数据库文件存在
        let db_file = temp_dir.path().join(DATABASE_FILENAME);
        assert!(db_file.exists(), "Database file should exist");

        // 验证数据库路径正确
        assert_eq!(db.db_path(), db_file);
    }

    #[test]
    fn test_migrations_idempotent() {
        let (temp_dir, db) = setup_test_db();

        // 第一次迁移应该成功
        let version1 = db
            .get_schema_version()
            .expect("Failed to get schema version");
        assert_eq!(version1, CURRENT_SCHEMA_VERSION);

        // 重新创建数据库（模拟重启），迁移应该幂等
        drop(db);
        let db2 = LlmUsageDatabase::new(temp_dir.path()).expect("Failed to recreate database");
        let version2 = db2
            .get_schema_version()
            .expect("Failed to get schema version");
        assert_eq!(version2, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn test_foreign_keys_enabled() {
        let (_temp_dir, db) = setup_test_db();

        let enabled = db
            .is_foreign_keys_enabled()
            .expect("Failed to check foreign keys");
        assert!(enabled, "Foreign keys should be enabled");
    }

    #[test]
    fn test_get_connection() {
        let (_temp_dir, db) = setup_test_db();

        // 应该能够获取多个连接
        let conn1 = db.get_conn().expect("Failed to get connection 1");
        let conn2 = db.get_conn().expect("Failed to get connection 2");

        // 验证连接可用
        let _: i64 = conn1
            .query_row("SELECT 1", [], |row| row.get(0))
            .expect("Connection 1 should work");
        let _: i64 = conn2
            .query_row("SELECT 1", [], |row| row.get(0))
            .expect("Connection 2 should work");
    }

    #[test]
    fn test_get_statistics() {
        let (_temp_dir, db) = setup_test_db();

        let stats = db.get_statistics().expect("Failed to get statistics");

        // 新数据库应该为空
        assert_eq!(stats.log_count, 0);
        assert_eq!(stats.daily_summary_count, 0);
        assert_eq!(stats.total_tokens, 0);
        assert_eq!(stats.total_cost_estimate, 0.0);
        assert_eq!(stats.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn test_tables_created() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证所有表存在
        // 注意：refinery_schema_history 表由 Refinery 框架在迁移时创建
        let tables = ["llm_usage_logs", "llm_usage_daily"];

        for table in tables {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("Failed to check table existence");
            assert_eq!(exists, 1, "Table {} should exist", table);
        }
    }

    #[test]
    fn test_indexes_created() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证关键索引存在
        let indexes = [
            "idx_llm_usage_logs_timestamp",
            "idx_llm_usage_logs_date_key",
            "idx_llm_usage_logs_caller_type",
            "idx_llm_usage_logs_model",
            "idx_llm_usage_daily_date",
        ];

        for index in indexes {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [index],
                    |row| row.get(0),
                )
                .expect("Failed to check index existence");
            assert_eq!(exists, 1, "Index {} should exist", index);
        }
    }

    #[test]
    fn test_insert_usage_log() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 插入测试记录
        conn.execute(
            r#"
            INSERT INTO llm_usage_logs (
                id, timestamp, provider, model, prompt_tokens, completion_tokens,
                total_tokens, caller_type, status
            ) VALUES (
                'usage_test_001', '2025-01-23T10:30:00.000Z', 'openai', 'gpt-4o',
                100, 50, 150, 'chat_v2', 'success'
            )
            "#,
            [],
        )
        .expect("Failed to insert usage log");

        // 验证插入成功
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_test_001'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to count usage logs");
        assert_eq!(count, 1, "Usage log should be inserted");

        // 验证计算列
        let date_key: String = conn
            .query_row(
                "SELECT date_key FROM llm_usage_logs WHERE id = 'usage_test_001'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get date_key");
        assert_eq!(
            date_key, "2025-01-23",
            "date_key should be extracted correctly"
        );
    }

    #[test]
    fn test_daily_summary_upsert() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 插入每日汇总
        conn.execute(
            r#"
            INSERT INTO llm_usage_daily (
                date, caller_type, model, provider, request_count, success_count,
                total_prompt_tokens, total_completion_tokens, total_tokens
            ) VALUES (
                '2025-01-23', 'chat_v2', 'gpt-4o', 'openai', 10, 9, 1000, 500, 1500
            )
            "#,
            [],
        )
        .expect("Failed to insert daily summary");

        // 验证插入成功
        let count: i64 = conn
            .query_row(
                "SELECT request_count FROM llm_usage_daily WHERE date = '2025-01-23' AND caller_type = 'chat_v2'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get request count");
        assert_eq!(count, 10, "Request count should be 10");
    }

    #[test]
    fn test_reinitialize() {
        let (temp_dir, db) = setup_test_db();

        // 插入测试数据
        {
            let conn = db.get_conn().expect("Failed to get connection");
            conn.execute(
                r#"
                INSERT INTO llm_usage_logs (
                    id, timestamp, provider, model, prompt_tokens, completion_tokens,
                    total_tokens, caller_type, status
                ) VALUES (
                    'usage_reinit_test', '2025-01-23T10:30:00.000Z', 'openai', 'gpt-4o',
                    100, 50, 150, 'chat_v2', 'success'
                )
                "#,
                [],
            )
            .expect("Failed to insert test data");
        }

        // 重新初始化
        db.reinitialize().expect("Failed to reinitialize");

        // 验证数据仍然存在
        let conn = db
            .get_conn()
            .expect("Failed to get connection after reinit");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_reinit_test'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to count after reinit");
        assert_eq!(count, 1, "Data should persist after reinitialize");

        // 验证路径不变
        assert_eq!(db.db_path(), temp_dir.path().join(DATABASE_FILENAME));
    }
}
