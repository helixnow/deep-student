//! VFS 数据库管理模块
//!
//! 提供 VFS 的独立 SQLite 数据库初始化和管理功能。
//! 使用 r2d2 连接池，支持并发访问。
//!
//! ## 设计原则
//! - **单一数据库**：使用单个 `vfs.db`
//! - **文件夹组织**：资源通过 folder_items 表组织，不依赖科目
//! - **连接池管理**：使用 r2d2 管理连接池
//!
//! ## 迁移系统
//! Schema 迁移已统一到 data_governance 模块，使用 Refinery 框架。
//! 迁移文件位于 src-tauri/migrations/vfs/ 目录。

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;
use tracing::{debug, error, info, warn};

use super::error::{VfsError, VfsResult};

/// 数据库文件名
const DATABASE_FILENAME: &str = "vfs.db";

/// 当前 Schema 版本（对应 Refinery 迁移的最新版本）
/// 注意：此常量仅用于统计信息显示，实际版本以 refinery_schema_history 表为准
pub const CURRENT_SCHEMA_VERSION: u32 = 20260212;

/// SQLite 连接池类型
pub type VfsPool = Pool<SqliteConnectionManager>;

/// SQLite 池化连接类型
pub type VfsPooledConnection = r2d2::PooledConnection<SqliteConnectionManager>;

/// VFS 数据库管理器
///
/// 管理 VFS 模块的独立 SQLite 数据库文件（`vfs.db`）。
/// 支持：
/// - r2d2 连接池管理
/// - 自动迁移管理
/// - WAL 模式提升并发性能
pub struct VfsDatabase {
    /// 数据库连接池
    pool: RwLock<VfsPool>,
    /// 数据库文件路径
    db_path: PathBuf,
    /// Blob 存储目录
    blobs_dir: PathBuf,
}

impl VfsDatabase {
    /// 创建新的 VFS 数据库管理器
    ///
    /// # Arguments
    /// * `app_data_dir` - 应用数据目录路径（databases 目录）
    ///
    /// # Returns
    /// * `VfsResult<Self>` - 数据库管理器实例
    ///
    /// # Errors
    /// * 目录创建失败
    /// * 数据库连接失败
    /// * 迁移执行失败
    pub fn new(app_data_dir: &Path) -> VfsResult<Self> {
        info!(
            "[VFS::Database] Initializing VFS database in: {}",
            app_data_dir.display()
        );

        // 确保 databases 目录存在
        let databases_dir = app_data_dir.join("databases");
        if let Err(e) = fs::create_dir_all(&databases_dir) {
            error!(
                "[VFS::Database] Failed to create databases directory: {}",
                e
            );
            return Err(VfsError::Io(format!(
                "Failed to create databases directory: {}",
                e
            )));
        }

        // 确保 vfs_blobs 目录存在
        let blobs_dir = app_data_dir.join("vfs_blobs");
        if let Err(e) = fs::create_dir_all(&blobs_dir) {
            error!(
                "[VFS::Database] Failed to create vfs_blobs directory: {}",
                e
            );
            return Err(VfsError::Io(format!(
                "Failed to create vfs_blobs directory: {}",
                e
            )));
        }

        let db_path = databases_dir.join(DATABASE_FILENAME);
        let pool = Self::build_pool(&db_path)?;

        let db = Self {
            pool: RwLock::new(pool),
            db_path,
            blobs_dir,
        };

        info!(
            "[VFS::Database] VFS database initialized successfully: {}",
            db.db_path.display()
        );

        Ok(db)
    }

    /// 构建连接池
    fn build_pool(db_path: &Path) -> VfsResult<VfsPool> {
        debug!(
            "[VFS::Database] Building connection pool for: {}",
            db_path.display()
        );

        let manager = SqliteConnectionManager::file(db_path).with_init(|conn| {
            // 启用外键约束（必须！）
            conn.pragma_update(None, "foreign_keys", "ON")?;
            // 使用 WAL 模式提升并发性能
            conn.pragma_update(None, "journal_mode", "WAL")?;
            // 同步模式设为 NORMAL（平衡安全与性能）
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            // 设置 busy_timeout 避免无界等待（5秒，与主数据库保持一致）
            conn.pragma_update(None, "busy_timeout", 5000i64)?;
            Ok(())
        });

        let pool = Pool::builder()
            .max_size(15) // 最大连接数 - SQLite 单写者模型下无需太多连接
            .min_idle(Some(2)) // 最小空闲连接
            .connection_timeout(Duration::from_secs(5)) // 连接超时 - MEDIUM-003修复：从10秒降低到5秒
            .max_lifetime(Some(Duration::from_secs(1800))) // 连接最大生命周期30分钟
            .idle_timeout(Some(Duration::from_secs(600))) // 空闲连接超时10分钟
            .build(manager)
            .map_err(|e| VfsError::Pool(format!("Failed to create connection pool: {}", e)))?;

        Ok(pool)
    }

    /// 获取数据库连接
    ///
    /// # Returns
    /// * `VfsResult<VfsPooledConnection>` - 池化连接
    pub fn get_conn(&self) -> VfsResult<VfsPooledConnection> {
        let pool = self
            .pool
            .read()
            .map_err(|e| VfsError::Pool(format!("Pool lock poisoned: {}", e)))?;

        pool.get()
            .map_err(|e| VfsError::Pool(format!("Failed to get connection: {}", e)))
    }

    /// 获取数据库连接（安全版本，处理 RwLock poison）
    ///
    /// 即使 RwLock 被 poison，也能恢复连接池并获取连接。
    /// 恢复后会执行 ROLLBACK 以清理因 panic 残留的部分事务状态。
    ///
    /// # Returns
    /// * `VfsResult<VfsPooledConnection>` - 池化连接
    ///
    /// # P2-017修复
    /// 添加重试逻辑，在连接池繁忙时重试最多3次
    pub fn get_conn_safe(&self) -> VfsResult<VfsPooledConnection> {
        let mut was_poisoned = false;
        let pool = self.pool.read().unwrap_or_else(|poisoned| {
            error!("[VFS::Database] RwLock poisoned in get_conn_safe! Attempting recovery");
            was_poisoned = true;
            poisoned.into_inner()
        });

        // 重试逻辑：最多尝试3次
        const MAX_RETRIES: usize = 3;
        let mut last_error = None;

        for attempt in 0..MAX_RETRIES {
            match pool.get() {
                Ok(conn) => {
                    if was_poisoned {
                        // 从 poison 恢复后，执行 ROLLBACK 清理可能残留的部分事务
                        let _ = conn.execute("ROLLBACK", []);
                        warn!(
                            "[VFS::Database] get_conn_safe: recovered from poison, issued ROLLBACK"
                        );
                    }
                    if attempt > 0 {
                        debug!(
                            "[VFS::Database] get_conn_safe: succeeded on retry attempt {}",
                            attempt
                        );
                    }
                    return Ok(conn);
                }
                Err(e) => {
                    warn!(
                        "[VFS::Database] get_conn_safe: attempt {} failed: {}",
                        attempt + 1,
                        e
                    );
                    last_error = Some(e);

                    // 在重试前短暂等待（指数退避）- HIGH-006修复：防止溢出，添加上限
                    if attempt < MAX_RETRIES - 1 {
                        let backoff_ms = (50u64.saturating_mul(1u64 << attempt.min(10))).min(5000);
                        std::thread::sleep(Duration::from_millis(backoff_ms));
                    }
                }
            }
        }

        // 所有重试都失败 - HIGH-005修复：避免unwrap() panic
        error!(
            "[VFS::Database] get_conn_safe: all {} attempts failed",
            MAX_RETRIES
        );
        Err(VfsError::Pool(format!(
            "Failed to get connection after {} retries: {}",
            MAX_RETRIES,
            last_error
                .map(|e| e.to_string())
                .unwrap_or_else(|| "Unknown error".to_string())
        )))
    }

    /// 获取连接池的克隆
    ///
    /// # Errors
    /// * 如果 RwLock 被 poison，返回错误
    pub fn get_pool(&self) -> VfsResult<VfsPool> {
        self.pool.read().map(|pool| pool.clone()).map_err(|e| {
            error!("[VFS::Database] RwLock poisoned in get_pool: {}", e);
            VfsError::Pool(format!("RwLock poisoned: {}", e))
        })
    }

    /// 获取数据库文件路径
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// 获取 Blob 存储目录
    pub fn blobs_dir(&self) -> &Path {
        &self.blobs_dir
    }

    /// 进入维护模式：将连接池切换为内存数据库，释放对磁盘文件的占用
    ///
    /// 用于恢复流程中替换实际数据库文件，避免 Windows 上文件锁定（os error 32）。
    pub fn enter_maintenance_mode(&self) -> VfsResult<()> {
        // 先尝试 WAL checkpoint
        if let Ok(conn) = self.get_conn() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }

        let mem_manager = SqliteConnectionManager::memory();
        let mem_pool = Pool::builder()
            .max_size(1)
            .build(mem_manager)
            .map_err(|e| VfsError::Pool(format!("创建内存连接池失败: {}", e)))?;

        {
            let mut guard = self
                .pool
                .write()
                .map_err(|e| VfsError::Pool(format!("Pool lock poisoned: {}", e)))?;
            *guard = mem_pool;
        }

        info!("[VFS::Database] 已进入维护模式，文件连接已释放");
        Ok(())
    }

    /// 退出维护模式：重新打开磁盘数据库文件的连接池
    pub fn exit_maintenance_mode(&self) -> VfsResult<()> {
        let new_pool = Self::build_pool(&self.db_path)?;

        {
            let mut guard = self
                .pool
                .write()
                .map_err(|e| VfsError::Pool(format!("Pool lock poisoned: {}", e)))?;
            *guard = new_pool;
        }

        info!("[VFS::Database] 已退出维护模式，文件连接已恢复");
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
    /// * `VfsResult<()>` - 成功返回 Ok(()), 失败返回错误
    pub fn reinitialize(&self) -> VfsResult<()> {
        info!(
            "[VFS::Database] Reinitializing connection pool for: {}",
            self.db_path.display()
        );

        // 1. 构建新的连接池
        let new_pool = Self::build_pool(&self.db_path)?;

        // 2. 替换旧的连接池
        {
            let mut pool_guard = self
                .pool
                .write()
                .map_err(|e| VfsError::Pool(format!("Pool lock poisoned: {}", e)))?;
            *pool_guard = new_pool;
        }

        info!(
            "[VFS::Database] Connection pool reinitialized successfully: {}",
            self.db_path.display()
        );

        Ok(())
    }

    /// 检查外键约束是否启用
    pub fn is_foreign_keys_enabled(&self) -> VfsResult<bool> {
        let conn = self.get_conn()?;
        let enabled: i64 = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        Ok(enabled == 1)
    }

    /// 获取当前 Schema 版本
    ///
    /// 从 Refinery 的 refinery_schema_history 表读取版本号。
    pub fn get_schema_version(&self) -> VfsResult<u32> {
        let conn = self.get_conn()?;

        // 从 Refinery 的 schema history 表读取版本
        let version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        Ok(version)
    }

    /// 获取数据库统计信息（单次查询获取所有计数，减少数据库往返）
    pub fn get_statistics(&self) -> VfsResult<VfsDatabaseStats> {
        let conn = self.get_conn()?;

        let (
            resource_count,
            note_count,
            textbook_count,
            exam_count,
            translation_count,
            essay_count,
            blob_count,
        ) = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM resources) AS resource_count,
                    (SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL) AS note_count,
                    (SELECT COUNT(*) FROM files WHERE status = 'active') AS textbook_count,
                    (SELECT COUNT(*) FROM exam_sheets) AS exam_count,
                    (SELECT COUNT(*) FROM translations) AS translation_count,
                    (SELECT COUNT(*) FROM essays) AS essay_count,
                    (SELECT COUNT(*) FROM blobs) AS blob_count",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .unwrap_or_else(|e| {
                error!("[VFS::Database] Failed to query statistics: {}", e);
                (0, 0, 0, 0, 0, 0, 0)
            });

        Ok(VfsDatabaseStats {
            resource_count: resource_count as u64,
            note_count: note_count as u64,
            textbook_count: textbook_count as u64,
            exam_count: exam_count as u64,
            translation_count: translation_count as u64,
            essay_count: essay_count as u64,
            blob_count: blob_count as u64,
            schema_version: CURRENT_SCHEMA_VERSION,
        })
    }
}

/// VFS 数据库统计信息
#[derive(Debug, Clone)]
pub struct VfsDatabaseStats {
    /// 资源数量
    pub resource_count: u64,
    /// 笔记数量
    pub note_count: u64,
    /// 教材数量
    pub textbook_count: u64,
    /// 题目集数量
    pub exam_count: u64,
    /// 翻译数量
    pub translation_count: u64,
    /// 作文数量
    pub essay_count: u64,
    /// Blob 数量
    pub blob_count: u64,
    /// Schema 版本
    pub schema_version: u32,
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tempfile::TempDir;

    /// 创建测试数据库
    fn setup_test_db() -> (TempDir, VfsDatabase) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to create database");
        (temp_dir, db)
    }

    #[test]
    fn test_database_creation() {
        let (temp_dir, db) = setup_test_db();

        // 验证数据库文件存在
        let db_file = temp_dir.path().join("databases").join(DATABASE_FILENAME);
        assert!(db_file.exists(), "Database file should exist");

        // 验证 blobs 目录存在
        let blobs_dir = temp_dir.path().join("vfs_blobs");
        assert!(blobs_dir.exists(), "Blobs directory should exist");

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
        let db2 = VfsDatabase::new(temp_dir.path()).expect("Failed to recreate database");
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
        assert_eq!(stats.resource_count, 0);
        assert_eq!(stats.note_count, 0);
        assert_eq!(stats.textbook_count, 0);
        assert_eq!(stats.exam_count, 0);
        assert_eq!(stats.translation_count, 0);
        assert_eq!(stats.essay_count, 0);
        assert_eq!(stats.blob_count, 0);
        assert_eq!(stats.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn test_tables_created() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证所有表存在（包括 002_folders 迁移的表）
        // 注意：refinery_schema_history 表由 Refinery 框架在迁移时创建
        let tables = [
            "resources",
            "notes",
            "textbooks",
            "exam_sheets",
            "translations",
            "essays",
            "blobs",
            "folders",
            "folder_items",
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

    // ============================================================================
    // 002_folders 迁移测试
    // ============================================================================

    #[test]
    fn test_folders_table_created() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 插入根级文件夹
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        conn.execute(
            "INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
             VALUES ('fld_root1', NULL, '数学笔记', 1, 0, ?1, ?1)",
            params![now],
        ).expect("Failed to insert root folder");

        // 验证插入成功
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // 验证字段正确
        let title: String = conn
            .query_row(
                "SELECT title FROM folders WHERE id = 'fld_root1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "数学笔记");
    }

    #[test]
    fn test_folder_items_table_created() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // 先创建文件夹
        conn.execute(
            "INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
             VALUES ('fld_test', NULL, '测试文件夹', 1, 0, ?1, ?1)",
            params![now],
        ).expect("Failed to insert folder");

        // 插入 folder_item
        conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
             VALUES ('fi_1', 'fld_test', 'note', 'note_abc123', 0, ?1)",
            params![now],
        )
        .expect("Failed to insert folder item");

        // 验证插入成功
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM folder_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_folders_parent_cascade_delete() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // 创建父文件夹
        conn.execute(
            "INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
             VALUES ('fld_parent', NULL, '父文件夹', 1, 0, ?1, ?1)",
            params![now],
        ).unwrap();

        // 创建子文件夹
        conn.execute(
            "INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
             VALUES ('fld_child', 'fld_parent', '子文件夹', 1, 0, ?1, ?1)",
            params![now],
        ).unwrap();

        // 创建孙文件夹
        conn.execute(
            "INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
             VALUES ('fld_grandchild', 'fld_child', '孙文件夹', 1, 0, ?1, ?1)",
            params![now],
        ).unwrap();

        // 验证有 3 个文件夹
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 3);

        // 删除父文件夹
        conn.execute("DELETE FROM folders WHERE id = 'fld_parent'", [])
            .unwrap();

        // 验证级联删除：所有子文件夹都被删除
        let count_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            count_after, 0,
            "All child folders should be cascade deleted"
        );
    }

    #[test]
    fn test_folder_items_folder_set_null() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // 创建文件夹
        conn.execute(
            "INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
             VALUES ('fld_test', NULL, '测试文件夹', 1, 0, ?1, ?1)",
            params![now],
        ).unwrap();

        // 在文件夹中添加内容项
        conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
             VALUES ('fi_1', 'fld_test', 'note', 'note_abc', 0, ?1)",
            params![now],
        )
        .unwrap();

        // 验证 folder_id 有值
        let folder_id: Option<String> = conn
            .query_row(
                "SELECT folder_id FROM folder_items WHERE id = 'fi_1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(folder_id, Some("fld_test".to_string()));

        // 删除文件夹
        conn.execute("DELETE FROM folders WHERE id = 'fld_test'", [])
            .unwrap();

        // 验证 folder_items 仍存在，但 folder_id 被置为 NULL
        let folder_id_after: Option<String> = conn
            .query_row(
                "SELECT folder_id FROM folder_items WHERE id = 'fi_1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            folder_id_after, None,
            "folder_id should be set to NULL after folder deletion"
        );

        // 验证 item 仍存在
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM folder_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "folder_item should still exist");
    }

    #[test]
    fn test_folder_items_unique_constraint() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // 插入第一个 item
        conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
             VALUES ('fi_1', NULL, 'note', 'note_abc', 0, ?1)",
            params![now],
        )
        .expect("First insert should succeed");

        // 迁移 011 后，唯一索引基于 (folder_id, item_type, item_id)
        // 因此相同的 (item_type, item_id) 组合应该失败
        let result = conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
             VALUES ('fi_2', NULL, 'note', 'note_abc', 1, ?1)",
            params![now],
        );

        assert!(
            result.is_err(),
            "Duplicate (folder_id, item_type, item_id) should fail"
        );
    }

    #[test]
    fn test_folders_indexes_created() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 迁移 009 后，索引结构已改变
        // 验证 folders 表新索引
        let folder_indexes = [
            "idx_folders_parent",
            "idx_folders_parent_sort",
            "idx_folders_deleted_only",
        ];

        for idx in folder_indexes {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |row| row.get(0),
                )
                .expect("Failed to check index existence");
            assert_eq!(exists, 1, "Index {} should exist", idx);
        }

        // 验证 folder_items 表新索引
        let item_indexes = [
            "idx_folder_items_item_unique",
            "idx_folder_items_folder",
            "idx_folder_items_folder_sort",
        ];

        for idx in item_indexes {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |row| row.get(0),
                )
                .expect("Failed to check index existence");
            assert_eq!(exists, 1, "Index {} should exist", idx);
        }
    }

    #[test]
    fn test_hash_unique_constraint() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 插入第一条资源
        conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('res_1', 'hash_123', 'note', 'inline', 'content', 0, 1234567890, 1234567890)",
            [],
        ).expect("First insert should succeed");

        // 尝试插入相同 hash 应该失败
        let result = conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('res_2', 'hash_123', 'note', 'inline', 'content2', 0, 1234567890, 1234567890)",
            [],
        );

        assert!(result.is_err(), "Duplicate hash should fail");
    }

    #[test]
    fn test_resources_no_subject() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 迁移 011 后 resources 表不再有 subject 字段
        // 插入资源（不带 subject）
        conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('res_1', 'hash_1', 'note', 'inline', 'math content', 0, 1234567890, 1234567890)",
            [],
        ).unwrap();

        conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('res_2', 'hash_2', 'note', 'inline', 'physics content', 0, 1234567890, 1234567890)",
            [],
        ).unwrap();

        conn.execute(
            "INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('res_3', 'hash_3', 'translation', 'inline', 'translation content', 0, 1234567890, 1234567890)",
            [],
        ).unwrap();

        // 查询所有资源
        let all_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
            .unwrap();
        assert_eq!(all_count, 3);
    }

    // ============================================================================
    // 005_folder_path_cache 迁移测试
    // ============================================================================

    #[test]
    fn test_migration_005_cached_path_column() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证 folder_items 表有 cached_path 字段
        let has_column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('folder_items') WHERE name = 'cached_path'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check column existence");
        assert_eq!(has_column, 1, "folder_items should have cached_path column");

        // 验证 cached_path 索引存在
        let has_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_folder_items_path'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check index existence");
        assert_eq!(has_index, 1, "idx_folder_items_path index should exist");
    }

    #[test]
    fn test_migration_005_cached_path_nullable() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // 创建文件夹
        conn.execute(
            "INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
             VALUES ('fld_test', NULL, '测试文件夹', 1, 0, ?1, ?1)",
            params![now],
        ).expect("Failed to insert folder");

        // 插入 folder_item（不带 cached_path，验证可 NULL）
        conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
             VALUES ('fi_1', 'fld_test', 'note', 'note_abc123', 0, ?1)",
            params![now],
        )
        .expect("Failed to insert folder item without cached_path");

        // 验证 cached_path 为 NULL
        let cached_path: Option<String> = conn
            .query_row(
                "SELECT cached_path FROM folder_items WHERE id = 'fi_1'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query cached_path");
        assert!(
            cached_path.is_none(),
            "cached_path should be NULL initially"
        );

        // 更新 cached_path
        conn.execute(
            "UPDATE folder_items SET cached_path = '/测试文件夹/笔记标题' WHERE id = 'fi_1'",
            [],
        )
        .expect("Failed to update cached_path");

        // 验证 cached_path 更新成功
        let updated_path: Option<String> = conn
            .query_row(
                "SELECT cached_path FROM folder_items WHERE id = 'fi_1'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query updated cached_path");
        assert_eq!(updated_path, Some("/测试文件夹/笔记标题".to_string()));
    }

    #[test]
    fn test_migration_005_path_index_query() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // 创建文件夹
        conn.execute(
            "INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
             VALUES ('fld_root', NULL, '根文件夹', 1, 0, ?1, ?1)",
            params![now],
        ).expect("Failed to insert folder");

        // 插入多个带 cached_path 的 folder_items
        conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
             VALUES ('fi_1', 'fld_root', 'note', 'note_1', 0, ?1, '/根文件夹/笔记1')",
            params![now],
        ).expect("Failed to insert fi_1");

        conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
             VALUES ('fi_2', 'fld_root', 'note', 'note_2', 1, ?1, '/根文件夹/笔记2')",
            params![now],
        ).expect("Failed to insert fi_2");

        conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
             VALUES ('fi_3', 'fld_root', 'textbook', 'tb_1', 2, ?1, '/根文件夹/教材')",
            params![now],
        ).expect("Failed to insert fi_3");

        // 按路径前缀查询（利用索引）
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folder_items WHERE cached_path LIKE '/根文件夹/%'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query by path prefix");
        assert_eq!(count, 3, "Should find 3 items under /根文件夹/");

        // 精确路径查询
        let item_id: String = conn
            .query_row(
                "SELECT item_id FROM folder_items WHERE cached_path = '/根文件夹/笔记1'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query exact path");
        assert_eq!(item_id, "note_1");
    }

    // ============================================================================
    // 011_remove_subject 迁移测试
    // ============================================================================

    #[test]
    fn test_migration_011_subject_columns_removed() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证 folders 表没有 subject 字段
        let has_folders_subject: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('folders') WHERE name = 'subject'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check folders.subject existence");
        assert_eq!(
            has_folders_subject, 0,
            "folders should NOT have subject column after migration 011"
        );

        // 验证 folder_items 表没有 subject 字段
        let has_items_subject: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('folder_items') WHERE name = 'subject'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check folder_items.subject existence");
        assert_eq!(
            has_items_subject, 0,
            "folder_items should NOT have subject column after migration 011"
        );

        // 验证 resources 表没有 subject 字段
        let has_resources_subject: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('resources') WHERE name = 'subject'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check resources.subject existence");
        assert_eq!(
            has_resources_subject, 0,
            "resources should NOT have subject column after migration 011"
        );
    }

    #[test]
    fn test_migration_009_path_cache_table() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证 path_cache 表存在
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='path_cache'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check path_cache table existence");
        assert_eq!(table_exists, 1, "path_cache table should exist");

        // 验证 path_cache 表结构
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('path_cache')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(
            columns.contains(&"item_type".to_string()),
            "path_cache should have item_type column"
        );
        assert!(
            columns.contains(&"item_id".to_string()),
            "path_cache should have item_id column"
        );
        assert!(
            columns.contains(&"full_path".to_string()),
            "path_cache should have full_path column"
        );
        assert!(
            columns.contains(&"folder_path".to_string()),
            "path_cache should have folder_path column"
        );
        assert!(
            columns.contains(&"updated_at".to_string()),
            "path_cache should have updated_at column"
        );

        // 验证 path_cache 索引
        let path_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_path_cache_path'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check idx_path_cache_path existence");
        assert_eq!(path_index, 1, "idx_path_cache_path index should exist");

        let folder_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_path_cache_folder'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check idx_path_cache_folder existence");
        assert_eq!(folder_index, 1, "idx_path_cache_folder index should exist");
    }

    #[test]
    fn test_migration_011_indexes() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证新索引存在
        let new_indexes = [
            "idx_folders_parent",
            "idx_folders_sort",
            "idx_folders_deleted",
            "idx_folder_items_folder",
            "idx_folder_items_type_id",
            "idx_folder_items_unique_v2",
        ];

        for idx in new_indexes {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |row| row.get(0),
                )
                .expect("Failed to check index existence");
            assert_eq!(exists, 1, "Index {} should exist", idx);
        }

        // 验证 subject 相关索引已删除
        let old_indexes = ["idx_folders_subject", "idx_folder_items_subject"];

        for idx in old_indexes {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |row| row.get(0),
                )
                .expect("Failed to check index existence");
            assert_eq!(exists, 0, "Old subject index {} should be dropped", idx);
        }
    }

    #[test]
    fn test_migration_011_folders_without_subject() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // 迁移 011 后可以不带 subject 字段插入文件夹
        conn.execute(
            "INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
             VALUES ('fld_test', NULL, '测试文件夹', 1, 0, ?1, ?1)",
            params![now],
        ).expect("Failed to insert folder");

        // 验证文件夹插入成功
        let title: String = conn
            .query_row(
                "SELECT title FROM folders WHERE id = 'fld_test'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query folder");
        assert_eq!(title, "测试文件夹");
    }

    #[test]
    fn test_migration_009_path_cache_crud() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        // 插入 path_cache 记录
        conn.execute(
            "INSERT INTO path_cache (item_type, item_id, full_path, folder_path, updated_at)
             VALUES ('note', 'note_abc123', '/高考复习/函数/note_abc123', '/高考复习/函数', datetime('now'))",
            [],
        ).expect("Failed to insert path_cache");

        // 查询验证
        let full_path: String = conn
            .query_row(
                "SELECT full_path FROM path_cache WHERE item_type = 'note' AND item_id = 'note_abc123'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query path_cache");
        assert_eq!(full_path, "/高考复习/函数/note_abc123");

        // 更新
        conn.execute(
            "UPDATE path_cache SET full_path = '/新位置/note_abc123', folder_path = '/新位置'
             WHERE item_type = 'note' AND item_id = 'note_abc123'",
            [],
        )
        .expect("Failed to update path_cache");

        let updated_path: String = conn
            .query_row(
                "SELECT full_path FROM path_cache WHERE item_type = 'note' AND item_id = 'note_abc123'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query updated path_cache");
        assert_eq!(updated_path, "/新位置/note_abc123");

        // 删除
        conn.execute(
            "DELETE FROM path_cache WHERE item_type = 'note' AND item_id = 'note_abc123'",
            [],
        )
        .expect("Failed to delete path_cache");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM path_cache WHERE item_type = 'note' AND item_id = 'note_abc123'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to count path_cache");
        assert_eq!(count, 0, "path_cache record should be deleted");
    }

    #[test]
    fn test_migration_011_folder_items_unique_constraint() {
        let (_temp_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("Failed to get connection");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // 插入第一个 item
        conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
             VALUES ('fi_1', NULL, 'note', 'note_abc', 0, ?1)",
            params![now],
        )
        .expect("First insert should succeed");

        // 尝试插入相同的 (folder_id, item_type, item_id) 组合应该失败
        let result = conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
             VALUES ('fi_2', NULL, 'note', 'note_abc', 1, ?1)",
            params![now],
        );

        assert!(
            result.is_err(),
            "Duplicate (folder_id, item_type, item_id) should fail with unique constraint"
        );
    }

    #[test]
    fn test_migration_011_idempotent() {
        let (temp_dir, db) = setup_test_db();

        // 第一次迁移应该成功
        let version1 = db
            .get_schema_version()
            .expect("Failed to get schema version");
        assert_eq!(version1, CURRENT_SCHEMA_VERSION);

        // 重新创建数据库（模拟重启），迁移应该幂等
        drop(db);
        let db2 = VfsDatabase::new(temp_dir.path()).expect("Failed to recreate database");
        let version2 = db2
            .get_schema_version()
            .expect("Failed to get schema version");
        assert_eq!(version2, CURRENT_SCHEMA_VERSION);

        // 验证迁移 011 后结构正确
        let conn = db2.get_conn().expect("Failed to get connection");

        // folders 表不应该有 subject 列
        let has_subject: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('folders') WHERE name = 'subject'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check column");
        assert_eq!(
            has_subject, 0,
            "subject column should be removed after migration 011"
        );
    }
}
