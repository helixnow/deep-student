//! Chat V2 独立数据库管理模块
//!
//! 提供 Chat V2 模块的独立 SQLite 数据库初始化和管理功能。
//! 使用 r2d2 连接池，支持并发访问和迁移管理。

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;
use tracing::{debug, error, info};

use super::error::{ChatV2Error, ChatV2Result};

/// 数据库文件名
const DATABASE_FILENAME: &str = "chat_v2.db";

/// 当前数据库 Schema 版本
/// 当前 Schema 版本（对应 Refinery 迁移的最新版本）
/// 注意：此常量仅用于统计信息显示，实际版本以 refinery_schema_history 表为准
pub const CURRENT_SCHEMA_VERSION: u32 = 20260301;

/// SQLite 连接池类型
pub type ChatV2Pool = Pool<SqliteConnectionManager>;

/// SQLite 池化连接类型
pub type ChatV2PooledConnection = r2d2::PooledConnection<SqliteConnectionManager>;

/// Chat V2 独立数据库管理器
///
/// 管理 Chat V2 模块的独立 SQLite 数据库文件（`chat_v2.db`）。
/// 支持：
/// - r2d2 连接池管理
/// - 自动迁移管理
/// - WAL 模式提升并发性能
pub struct ChatV2Database {
    /// 数据库连接池
    pool: RwLock<ChatV2Pool>,
    /// 数据库文件路径
    db_path: PathBuf,
    /// 维护模式标志：备份/恢复操作进行时设为 true，
    /// 用于阻止写操作访问内存连接池导致数据丢失。
    maintenance_mode: std::sync::atomic::AtomicBool,
}

impl ChatV2Database {
    /// 创建新的 Chat V2 数据库管理器
    ///
    /// # Arguments
    /// * `app_data_dir` - 应用数据目录路径
    ///
    /// # Returns
    /// * `ChatV2Result<Self>` - 数据库管理器实例
    ///
    /// # Errors
    /// * 目录创建失败
    /// * 数据库连接失败
    /// * 迁移执行失败
    pub fn new(app_data_dir: &Path) -> ChatV2Result<Self> {
        info!(
            "[ChatV2::Database] Initializing Chat V2 database in: {}",
            app_data_dir.display()
        );

        // 确保目录存在
        if let Err(e) = fs::create_dir_all(app_data_dir) {
            error!("[ChatV2::Database] Failed to create data directory: {}", e);
            return Err(ChatV2Error::Database(format!(
                "Failed to create data directory: {}",
                e
            )));
        }

        let db_path = app_data_dir.join(DATABASE_FILENAME);
        let pool = Self::build_pool(&db_path)?;

        let db = Self {
            pool: RwLock::new(pool),
            db_path,
            maintenance_mode: std::sync::atomic::AtomicBool::new(false),
        };

        info!(
            "[ChatV2::Database] Chat V2 database initialized successfully: {}",
            db.db_path.display()
        );

        Ok(db)
    }

    /// 构建连接池
    fn build_pool(db_path: &Path) -> ChatV2Result<ChatV2Pool> {
        debug!(
            "[ChatV2::Database] Building connection pool for: {}",
            db_path.display()
        );

        let manager = SqliteConnectionManager::file(db_path).with_init(|conn| {
            conn.pragma_update(None, "foreign_keys", "ON")?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            conn.pragma_update(None, "busy_timeout", 3000i64)?;
            // P2 修复：启用增量自动 VACUUM，批量删除后可回收空间
            conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
            Ok(())
        });

        let pool = Pool::builder()
            .max_size(10) // 最大连接数
            .min_idle(Some(1)) // 最小空闲连接
            .connection_timeout(Duration::from_secs(10)) // 连接超时
            .build(manager)
            .map_err(|e| {
                ChatV2Error::Database(format!("Failed to create connection pool: {}", e))
            })?;

        Ok(pool)
    }

    /// 获取数据库连接
    ///
    /// # Returns
    /// * `ChatV2Result<ChatV2PooledConnection>` - 池化连接
    pub fn get_conn(&self) -> ChatV2Result<ChatV2PooledConnection> {
        let pool = self
            .pool
            .read()
            .map_err(|e| ChatV2Error::Database(format!("Pool lock poisoned: {}", e)))?;

        pool.get()
            .map_err(|e| ChatV2Error::Database(format!("Failed to get connection: {}", e)))
    }

    /// 获取数据库连接（安全版本，处理 RwLock poison）
    ///
    /// # Returns
    /// * `ChatV2Result<ChatV2PooledConnection>` - 池化连接
    pub fn get_conn_safe(&self) -> ChatV2Result<ChatV2PooledConnection> {
        // P0 修复：维护模式下拒绝返回连接，避免写入内存数据库导致数据丢失
        if self
            .maintenance_mode
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(ChatV2Error::Database(
                "Database is in maintenance mode (backup/restore in progress)".to_string(),
            ));
        }

        let pool = self.pool.read().unwrap_or_else(|poisoned| {
            log::error!("[ChatV2Database] Pool RwLock poisoned! Attempting recovery");
            poisoned.into_inner()
        });

        pool.get()
            .map_err(|e| ChatV2Error::Database(format!("Failed to get connection: {}", e)))
    }

    /// 检查是否处于维护模式
    pub fn is_in_maintenance_mode(&self) -> bool {
        self.maintenance_mode
            .load(std::sync::atomic::Ordering::Acquire)
    }

    /// 获取连接池的克隆
    pub fn get_pool(&self) -> ChatV2Pool {
        match self.pool.read() {
            Ok(pool) => pool.clone(),
            Err(poisoned) => {
                log::error!(
                    "[ChatV2Database] Pool RwLock poisoned in get_pool! Attempting recovery"
                );
                poisoned.into_inner().clone()
            }
        }
    }

    /// 获取数据库文件路径
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// 检查外键约束是否启用
    pub fn is_foreign_keys_enabled(&self) -> ChatV2Result<bool> {
        let conn = self.get_conn()?;
        let enabled: i64 = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        Ok(enabled == 1)
    }

    /// 获取当前 Schema 版本
    ///
    /// 从 Refinery 的 refinery_schema_history 表读取版本号。
    pub fn get_schema_version(&self) -> ChatV2Result<u32> {
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

    /// 进入维护模式：将连接池切换为内存数据库，释放对磁盘文件的占用
    ///
    /// 用于恢复流程中替换实际数据库文件，避免 Windows 上文件锁定（os error 32）。
    pub fn enter_maintenance_mode(&self) -> ChatV2Result<()> {
        // 先尝试 WAL checkpoint（仍使用文件连接）
        if let Ok(conn) = self.get_conn() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }

        // 然后设置维护模式标志，阻止后续 get_conn_safe 返回文件连接
        self.maintenance_mode
            .store(true, std::sync::atomic::Ordering::Release);

        let mem_manager = SqliteConnectionManager::memory();
        let mem_pool = Pool::builder()
            .max_size(1)
            .build(mem_manager)
            .map_err(|e| {
                self.maintenance_mode
                    .store(false, std::sync::atomic::Ordering::Release);
                ChatV2Error::Database(format!("创建内存连接池失败: {}", e))
            })?;

        let mut guard = self.pool.write().map_err(|e| {
            self.maintenance_mode
                .store(false, std::sync::atomic::Ordering::Release);
            ChatV2Error::Database(format!("Pool lock poisoned: {}", e))
        })?;
        *guard = mem_pool;

        info!("[ChatV2::Database] 已进入维护模式，文件连接已释放");
        Ok(())
    }

    /// 退出维护模式：重新打开磁盘数据库文件的连接池
    pub fn exit_maintenance_mode(&self) -> ChatV2Result<()> {
        let new_pool = Self::build_pool(&self.db_path)?;

        {
            let mut guard = self
                .pool
                .write()
                .map_err(|e| ChatV2Error::Database(format!("Pool lock poisoned: {}", e)))?;
            *guard = new_pool;
        }

        // 恢复文件连接后清除维护模式标志
        self.maintenance_mode
            .store(false, std::sync::atomic::Ordering::Release);

        info!("[ChatV2::Database] 已退出维护模式，文件连接已恢复");
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
    /// # Returns
    /// * `ChatV2Result<()>` - 成功返回 Ok(()), 失败返回错误
    pub fn reinitialize(&self) -> ChatV2Result<()> {
        info!(
            "[ChatV2::Database] Reinitializing connection pool for: {}",
            self.db_path.display()
        );

        // 1. 构建新的连接池
        let new_pool = Self::build_pool(&self.db_path)?;

        // 2. 替换旧的连接池
        {
            let mut pool_guard = self
                .pool
                .write()
                .map_err(|e| ChatV2Error::Database(format!("Pool lock poisoned: {}", e)))?;
            *pool_guard = new_pool;
        }

        info!(
            "[ChatV2::Database] Connection pool reinitialized successfully: {}",
            self.db_path.display()
        );

        Ok(())
    }

    /// 获取数据库统计信息
    pub fn get_statistics(&self) -> ChatV2Result<ChatV2DatabaseStats> {
        let conn = self.get_conn()?;

        let session_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chat_v2_sessions", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        let message_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chat_v2_messages", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        let block_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chat_v2_blocks", [], |row| row.get(0))
            .unwrap_or(0);

        let attachment_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chat_v2_attachments", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        Ok(ChatV2DatabaseStats {
            session_count: session_count as u64,
            message_count: message_count as u64,
            block_count: block_count as u64,
            attachment_count: attachment_count as u64,
            schema_version: CURRENT_SCHEMA_VERSION,
        })
    }
}

/// Chat V2 数据库统计信息
#[derive(Debug, Clone)]
pub struct ChatV2DatabaseStats {
    /// 会话数量
    pub session_count: u64,
    /// 消息数量
    pub message_count: u64,
    /// 块数量
    pub block_count: u64,
    /// 附件数量
    pub attachment_count: u64,
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

    /// Log row-parse errors instead of silently discarding them.
    fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
        match result {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("[ChatV2Database::test] Row parse error (skipped): {}", e);
                None
            }
        }
    }

    /// 创建测试数据库
    fn setup_test_db() -> (TempDir, ChatV2Database) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = ChatV2Database::new(temp_dir.path()).expect("Failed to create database");
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
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 使用 data_governance 的迁移系统初始化数据库
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);

        // 第一次迁移（只迁移 chat_v2）
        let report = coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("Failed to run migrations");

        // 验证 chat_v2 迁移成功
        assert!(report.success, "Migration should succeed");

        // 创建数据库连接
        let db = ChatV2Database::new(temp_dir.path()).expect("Failed to create database");
        let version1 = db
            .get_schema_version()
            .expect("Failed to get schema version");
        assert_eq!(version1, CURRENT_SCHEMA_VERSION);

        // 再次迁移（应该幂等）
        drop(db);
        let report2 = coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("Failed to run migrations again");

        assert!(report2.success, "Second migration should succeed");

        let db2 = ChatV2Database::new(temp_dir.path()).expect("Failed to recreate database");
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
        assert_eq!(stats.session_count, 0);
        assert_eq!(stats.message_count, 0);
        assert_eq!(stats.block_count, 0);
        assert_eq!(stats.attachment_count, 0);
        assert_eq!(stats.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn test_tables_created() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证所有表存在（包括迁移 002 新增的 chat_v2_session_mistakes）
        let tables = [
            "chat_v2_sessions",
            "chat_v2_messages",
            "chat_v2_blocks",
            "chat_v2_attachments",
            "chat_v2_session_state",
            "chat_v2_session_mistakes",
        ];

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
    fn test_session_mistakes_table() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 创建测试会话
        conn.execute(
            "INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at) VALUES ('sess_test', 'analysis', datetime('now'), datetime('now'))",
            [],
        ).expect("Failed to insert session");

        // 创建会话-错题关联
        conn.execute(
            "INSERT INTO chat_v2_session_mistakes (session_id, mistake_id, relation_type, created_at) VALUES ('sess_test', 'mistake_1', 'primary', datetime('now'))",
            [],
        ).expect("Failed to insert session mistake");

        // 验证插入成功
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_v2_session_mistakes WHERE session_id = 'sess_test'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to count session mistakes");
        assert_eq!(count, 1, "Session mistake should be inserted");

        // 删除会话，验证级联删除
        conn.execute("DELETE FROM chat_v2_sessions WHERE id = 'sess_test'", [])
            .expect("Failed to delete session");

        let count_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_v2_session_mistakes WHERE session_id = 'sess_test'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to count session mistakes after delete");
        assert_eq!(count_after, 0, "Session mistakes should be cascade deleted");
    }

    #[test]
    fn test_attachments_block_id_column() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证 chat_v2_attachments 表包含 block_id 字段
        let mut has_block_id = false;
        let mut stmt = conn
            .prepare("PRAGMA table_info(chat_v2_attachments)")
            .expect("Failed to prepare");
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query");
        for col in columns {
            if let Ok(name) = col {
                if name == "block_id" {
                    has_block_id = true;
                    break;
                }
            }
        }
        assert!(
            has_block_id,
            "chat_v2_attachments should have block_id column"
        );
    }

    #[test]
    fn test_session_state_extended_columns() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证 chat_v2_session_state 表包含扩展字段
        let expected_columns = vec![
            "model_id",
            "temperature",
            "context_limit",
            "max_tokens",
            "enable_thinking",
            "disable_tools",
            "model2_override_id",
            "attachments_json",
            "rag_enabled",
            "rag_library_ids_json",
            "rag_top_k",
            "graph_rag_enabled",
            "memory_enabled",
            "web_search_enabled",
            "anki_enabled",
            "anki_template_id",
            "anki_options_json",
            "pending_context_refs_json", // 🆕 Prompt 7: 迁移 004 新增
            "loaded_skill_ids_json",     // 🆕 迁移 013 新增
            "active_skill_id",           // 🆕 迁移 014 新增
            "active_skill_ids_json",     // 🆕 迁移 015 新增（多选支持）
        ];

        let mut stmt = conn
            .prepare("PRAGMA table_info(chat_v2_session_state)")
            .expect("Failed to prepare");
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query")
            .filter_map(log_and_skip_err)
            .collect();

        for expected_col in expected_columns {
            assert!(
                columns.contains(&expected_col.to_string()),
                "chat_v2_session_state should have {} column",
                expected_col
            );
        }
    }

    #[test]
    fn test_cascade_delete() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 创建测试会话
        conn.execute(
            "INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at) VALUES ('sess_test', 'general_chat', datetime('now'), datetime('now'))",
            [],
        ).expect("Failed to insert session");

        // 创建测试消息
        conn.execute(
            "INSERT INTO chat_v2_messages (id, session_id, role, timestamp) VALUES ('msg_test', 'sess_test', 'user', 1000)",
            [],
        ).expect("Failed to insert message");

        // 创建测试块
        conn.execute(
            "INSERT INTO chat_v2_blocks (id, message_id, block_type, status) VALUES ('blk_test', 'msg_test', 'content', 'success')",
            [],
        ).expect("Failed to insert block");

        // 删除会话
        conn.execute("DELETE FROM chat_v2_sessions WHERE id = 'sess_test'", [])
            .expect("Failed to delete session");

        // 验证消息和块被级联删除
        let message_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_v2_messages WHERE session_id = 'sess_test'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to count messages");
        assert_eq!(message_count, 0, "Messages should be cascade deleted");

        let block_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_v2_blocks WHERE message_id = 'msg_test'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to count blocks");
        assert_eq!(block_count, 0, "Blocks should be cascade deleted");
    }
}
