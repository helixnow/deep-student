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

use crate::database::maintenance::{self, MaintenanceState};

/// 数据库文件名
const DATABASE_FILENAME: &str = "llm_usage.db";

/// 当前数据库 Schema 版本
/// 当前 Schema 版本（对应 Refinery 迁移的最新版本）
/// 注意：此常量仅用于统计信息显示，实际版本以 refinery_schema_history 表为准
pub const CURRENT_SCHEMA_VERSION: u32 = 20260525;

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
    /// 维护屏障状态机（Active/Draining/Maintenance），无锁、poison 免疫。
    maintenance: MaintenanceState,
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
            maintenance: MaintenanceState::new(),
        };

        db.ensure_schema()?;

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

    /// 维护屏障拒绝借出时的错误。
    fn maintenance_refusal() -> LlmUsageError {
        LlmUsageError::Database(format!(
            "LLM Usage {}",
            maintenance::MAINTENANCE_REFUSAL_MESSAGE
        ))
    }

    /// 获取数据库连接
    ///
    /// fail-close：维护屏障（备份/恢复）期间显式拒绝。借出前后各检查一次
    /// 屏障状态，关闭"检查通过后屏障才开始排空"的竞争窗口——之前的实现
    /// 会把屏障期间的写入落到一次性的内存池，退出屏障后凭空消失。
    ///
    /// # 返回
    /// * `LlmUsageResult<LlmUsagePooledConnection>` - 池化连接
    pub fn get_conn(&self) -> LlmUsageResult<LlmUsagePooledConnection> {
        if !self.maintenance.is_active() {
            return Err(Self::maintenance_refusal());
        }
        let pool = self
            .pool
            .read()
            .map_err(|e| LlmUsageError::Pool(format!("Pool lock poisoned: {}", e)))?;

        let conn = pool
            .get()
            .map_err(|e| LlmUsageError::Pool(format!("Failed to get connection: {}", e)))?;
        if !self.maintenance.is_active() {
            drop(conn);
            return Err(Self::maintenance_refusal());
        }
        Ok(conn)
    }

    /// 获取数据库连接（安全版本，处理 RwLock poison）
    ///
    /// 即使 RwLock 被 poison，也能获取连接。
    /// 适用于需要高可用性的场景。维护屏障下同样显式拒绝（fail-close）。
    ///
    /// # 返回
    /// * `LlmUsageResult<LlmUsagePooledConnection>` - 池化连接
    pub fn get_conn_safe(&self) -> LlmUsageResult<LlmUsagePooledConnection> {
        if !self.maintenance.is_active() {
            return Err(Self::maintenance_refusal());
        }
        let pool = self.pool.read().unwrap_or_else(|poisoned| {
            log::error!("[LlmUsageDatabase] Pool RwLock poisoned! Attempting recovery");
            poisoned.into_inner()
        });

        let conn = pool
            .get()
            .map_err(|e| LlmUsageError::Pool(format!("Failed to get connection: {}", e)))?;
        if !self.maintenance.is_active() {
            drop(conn);
            return Err(Self::maintenance_refusal());
        }
        Ok(conn)
    }

    /// 是否处于维护屏障（Draining 或 Maintenance 阶段）。
    pub fn is_in_maintenance_mode(&self) -> bool {
        self.maintenance.is_in_maintenance()
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
    ///
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

    /// 进入维护模式（fail-close 快照屏障）：
    ///
    /// 1. CAS 抢占状态机（Active→Draining）——此后 `get_conn`/`get_conn_safe`
    ///    立即拒绝新借出，重复进入直接失败；
    /// 2. 持有池写锁并**可证明地排空**在途租约（`connections == idle_connections`）；
    /// 3. 严格执行 `wal_checkpoint(TRUNCATE)`，失败（含 busy）回滚状态并向上传播；
    /// 4. 换入 fail-closed 占位池（任何 `get()` 显式失败）并同步丢弃旧磁盘池，
    ///    关闭全部文件句柄（Windows 上避免 os error 32），不再依赖任何 sleep。
    ///
    /// 之前的实现换入可正常读写的 `:memory:` 池，屏障期间的写入会落到
    /// 内存池并在退出屏障时被静默丢弃（fail-open），且 checkpoint 失败被忽略。
    pub fn enter_maintenance_mode(&self) -> LlmUsageResult<()> {
        self.enter_maintenance_mode_with_drain_deadline(maintenance::DEFAULT_DRAIN_DEADLINE)
    }

    /// 供测试注入较短排空时限；生产路径统一走 `enter_maintenance_mode`。
    fn enter_maintenance_mode_with_drain_deadline(
        &self,
        drain_deadline: Duration,
    ) -> LlmUsageResult<()> {
        self.maintenance
            .begin_drain()
            .map_err(|e| LlmUsageError::Database(format!("LLM Usage: {e}")))?;

        let entered = (|| -> LlmUsageResult<()> {
            // 持有写锁：阻止 get_pool 等并发读者在换池窗口拿到旧磁盘池
            let mut guard = self.pool.write().unwrap_or_else(|poisoned| {
                log::error!(
                    "[LlmUsageDatabase] Pool RwLock poisoned during enter_maintenance_mode! Forcing recovery"
                );
                poisoned.into_inner()
            });
            let old_pool = guard.clone();

            maintenance::drain_pool_until_idle(&old_pool, drain_deadline)
                .map_err(|e| LlmUsageError::Database(format!("LLM Usage 进入维护屏障失败: {e}")))?;

            {
                let conn = old_pool.get().map_err(|e| {
                    LlmUsageError::Pool(format!("维护屏障 checkpoint 前获取连接失败: {e}"))
                })?;
                maintenance::checkpoint_truncate_strict(&conn).map_err(|e| {
                    LlmUsageError::Database(format!("LLM Usage 进入维护屏障失败: {e}"))
                })?;
            }
            maintenance::drain_pool_until_idle(&old_pool, Duration::from_secs(1))
                .map_err(|e| LlmUsageError::Database(format!("LLM Usage 进入维护屏障失败: {e}")))?;

            *guard = maintenance::fail_closed_placeholder_pool();
            drop(guard);
            // 排空保证 old_pool 此刻持有全部（空闲）连接；drop 同步关闭文件句柄
            drop(old_pool);
            Ok(())
        })();

        match entered {
            Ok(()) => {
                self.maintenance.commit_maintenance();
                tracing::info!(
                    "[LlmUsage::Database] 已进入维护屏障：在途连接已排空，文件句柄已关闭"
                );
                Ok(())
            }
            Err(error) => {
                // 失败点均在换池之前，磁盘池保持原样；回滚状态恢复服务
                self.maintenance.abort_drain();
                Err(error)
            }
        }
    }

    /// 退出维护模式：重新打开磁盘数据库文件的连接池
    ///
    /// fail-close：重建磁盘池失败时**保持** Maintenance 状态并返回错误，
    /// 绝不提前恢复 Active。未处于维护屏障时调用为幂等 no-op。
    pub fn exit_maintenance_mode(&self) -> LlmUsageResult<()> {
        if self.maintenance.is_active() {
            tracing::warn!(
                "[LlmUsage::Database] exit_maintenance_mode 在非维护状态被调用，按幂等 no-op 处理"
            );
            return Ok(());
        }
        // 先完整建好磁盘池；失败则保持屏障（fail-close）
        let new_pool = Self::build_pool(&self.db_path)?;

        {
            let mut guard = self.pool.write().unwrap_or_else(|poisoned| {
                log::error!(
                    "[LlmUsageDatabase] Pool RwLock poisoned during exit_maintenance_mode! Forcing recovery"
                );
                poisoned.into_inner()
            });
            *guard = new_pool;
        }
        self.maintenance.force_active();

        tracing::info!("[LlmUsage::Database] 已退出维护屏障，文件连接已恢复");
        Ok(())
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
        if !self.maintenance.is_active() {
            // 换入新磁盘池会重新打开文件句柄，破坏屏障对"无活跃文件连接"的保证
            return Err(LlmUsageError::Database(
                "LLM Usage 处于维护屏障，拒绝重建连接池；请先退出维护屏障".to_string(),
            ));
        }
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

        self.ensure_schema()?;

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

    fn ensure_schema(&self) -> LlmUsageResult<()> {
        #[cfg(feature = "data_governance")]
        {
            mod llm_usage_migrations {
                refinery::embed_migrations!("migrations/llm_usage");
            }

            let mut conn = self.get_conn()?;
            llm_usage_migrations::migrations::runner()
                .set_grouped(false)
                .set_abort_divergent(false)
                .set_abort_missing(false)
                .run(&mut *conn)
                .map_err(|error| {
                    LlmUsageError::Migration(format!(
                        "Failed to initialize llm_usage schema: {}",
                        error
                    ))
                })?;
        }

        Ok(())
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

    /// 回归：维护屏障必须 fail-close——屏障内 get_conn/get_conn_safe 显式失败，
    /// 屏障期间不存在"写入内存池后被静默丢弃"的路径；退出后数据完整。
    #[test]
    fn test_maintenance_barrier_fails_closed_and_preserves_data() {
        let (_temp_dir, db) = setup_test_db();

        db.get_conn()
            .expect("connection before barrier")
            .execute(
                r#"
                INSERT INTO llm_usage_logs (
                    id, timestamp, provider, model, prompt_tokens, completion_tokens,
                    total_tokens, caller_type, status
                ) VALUES (
                    'usage_barrier_test', '2026-01-23T10:30:00.000Z', 'openai', 'gpt-4o',
                    100, 50, 150, 'chat_v2', 'success'
                )
                "#,
                [],
            )
            .expect("write before barrier");

        db.enter_maintenance_mode().expect("enter barrier");
        assert!(db.is_in_maintenance_mode());

        // 屏障内两个借出入口都必须显式失败
        let err = db.get_conn().expect_err("get_conn must refuse");
        assert!(
            err.to_string().contains("维护屏障"),
            "refusal must carry an explicit maintenance message: {err}"
        );
        assert!(db.get_conn_safe().is_err(), "get_conn_safe must refuse");
        // 屏障内禁止重建连接池（会重新打开文件句柄）
        assert!(db.reinitialize().is_err(), "reinitialize must refuse");
        // 重复进入必须失败，不能静默重置现有屏障
        assert!(db.enter_maintenance_mode().is_err());

        db.exit_maintenance_mode().expect("exit barrier");
        assert!(!db.is_in_maintenance_mode());

        let count: i64 = db
            .get_conn()
            .expect("connection after barrier")
            .query_row(
                "SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_barrier_test'",
                [],
                |row| row.get(0),
            )
            .expect("count after barrier");
        assert_eq!(count, 1, "pre-barrier data must survive the barrier");
    }

    /// 回归：在途连接未归还时屏障必须显式失败并回滚（替代固定 sleep 500ms），
    /// 租约归还后屏障可建立；非维护状态下退出为幂等 no-op。
    #[test]
    fn test_maintenance_barrier_drains_in_flight_connections_or_fails() {
        let (_temp_dir, db) = setup_test_db();

        db.exit_maintenance_mode().expect("no-op exit is ok");

        let held = db.get_conn().expect("hold a lease");
        let err = db
            .enter_maintenance_mode_with_drain_deadline(Duration::from_millis(150))
            .expect_err("outstanding lease must block the barrier");
        assert!(
            err.to_string().contains("未归还"),
            "drain timeout should report outstanding leases: {err}"
        );
        // 进入失败必须回滚：连接池继续正常服务
        assert!(!db.is_in_maintenance_mode());
        db.get_conn().expect("barrier rollback restores service");

        drop(held);
        db.enter_maintenance_mode_with_drain_deadline(Duration::from_secs(5))
            .expect("barrier succeeds after lease is returned");
        db.exit_maintenance_mode().expect("exit");
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
