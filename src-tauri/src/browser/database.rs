//! Browser 独立数据库（`browser.db`）
//!
//! - 路径：`{active_dir}/browser.db`（与 chat_v2 / mistakes / llm_usage 同级）
//! - 懒加载：构造时不建库；首次 [`BrowserDatabase::ensure_open`] 才建池 + Refinery 迁移
//! - 迁移：模块内 `embed_migrations!("migrations/browser")`，**不**进 `DatabaseId` / `run_all()`
//! - 治理：一期豁免（对齐 `message_queue.db`）

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;
use tracing::{debug, info};

use super::error::{BrowserError, BrowserResult};

/// 数据库文件名
pub const DATABASE_FILENAME: &str = "browser.db";

/// 当前 Schema 版本（对应 Refinery 最新迁移；展示用，权威以 `refinery_schema_history` 为准）
pub const CURRENT_SCHEMA_VERSION: u32 = 20260711;

/// 小连接池上限（浏览器读写量远低于 ChatV2）
const POOL_MAX_SIZE: u32 = 4;

/// SQLite 连接池
pub type BrowserPool = Pool<SqliteConnectionManager>;

/// 池化连接
pub type BrowserPooledConnection = r2d2::PooledConnection<SqliteConnectionManager>;

/// Browser 独立数据库管理器（懒打开）
pub struct BrowserDatabase {
    /// 活动数据目录（插槽根）；`browser.db` 位于其下
    active_dir: PathBuf,
    db_path: PathBuf,
    /// `None` = 尚未 ensure_open（flag 关时保持此状态）
    pool: RwLock<Option<BrowserPool>>,
}

impl BrowserDatabase {
    /// 创建未打开的管理器（不触碰磁盘、不跑迁移）
    pub fn new(active_dir: impl Into<PathBuf>) -> Self {
        let active_dir = active_dir.into();
        let db_path = active_dir.join(DATABASE_FILENAME);
        Self {
            active_dir,
            db_path,
            pool: RwLock::new(None),
        }
    }

    /// 从 DataSpaceManager 解析 active_dir 并构造（未打开）
    ///
    /// 对齐 ChatV2 / LlmUsage：`get_data_space_manager()?.active_dir()`。
    pub fn from_data_space() -> BrowserResult<Self> {
        let active_dir = resolve_active_dir()?;
        Ok(Self::new(active_dir))
    }

    /// 活动数据目录
    pub fn active_dir(&self) -> &Path {
        &self.active_dir
    }

    /// 数据库文件路径（可能尚不存在）
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// 是否已打开连接池
    pub fn is_open(&self) -> bool {
        self.pool
            .read()
            .map(|g| g.is_some())
            .unwrap_or_else(|p| p.into_inner().is_some())
    }

    /// 懒打开：建目录 → 建池 → WAL → Refinery 迁移。幂等。
    pub fn ensure_open(&self) -> BrowserResult<()> {
        {
            let guard = self
                .pool
                .read()
                .map_err(|e| BrowserError::Pool(format!("Pool lock poisoned: {e}")))?;
            if guard.is_some() {
                return Ok(());
            }
        }

        let mut guard = self
            .pool
            .write()
            .map_err(|e| BrowserError::Pool(format!("Pool lock poisoned: {e}")))?;
        if guard.is_some() {
            return Ok(());
        }

        info!(
            "[Browser::Database] Lazy-opening browser.db at {}",
            self.db_path.display()
        );

        if let Err(e) = fs::create_dir_all(&self.active_dir) {
            return Err(BrowserError::Database(format!(
                "Failed to create active_dir {}: {e}",
                self.active_dir.display()
            )));
        }

        let pool = Self::build_pool(&self.db_path)?;
        Self::run_migrations(&pool)?;
        *guard = Some(pool);

        info!(
            "[Browser::Database] browser.db ready (schema {})",
            CURRENT_SCHEMA_VERSION
        );
        Ok(())
    }

    /// 获取连接（未打开则先 ensure_open）
    pub fn get_conn(&self) -> BrowserResult<BrowserPooledConnection> {
        self.ensure_open()?;
        let guard = self
            .pool
            .read()
            .map_err(|e| BrowserError::Pool(format!("Pool lock poisoned: {e}")))?;
        let pool = guard.as_ref().ok_or(BrowserError::NotOpen)?;
        pool.get()
            .map_err(|e| BrowserError::Pool(format!("Failed to get connection: {e}")))
    }

    /// 仅在已打开时取连接；否则 `NotOpen`（不触发建库）
    pub fn try_get_conn(&self) -> BrowserResult<BrowserPooledConnection> {
        let guard = self
            .pool
            .read()
            .map_err(|e| BrowserError::Pool(format!("Pool lock poisoned: {e}")))?;
        let pool = guard.as_ref().ok_or(BrowserError::NotOpen)?;
        pool.get()
            .map_err(|e| BrowserError::Pool(format!("Failed to get connection: {e}")))
    }

    /// 从 Refinery 历史表读版本；未打开返回 0
    pub fn get_schema_version(&self) -> BrowserResult<u32> {
        if !self.is_open() {
            return Ok(0);
        }
        let conn = self.try_get_conn()?;
        let version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(version)
    }

    pub fn is_foreign_keys_enabled(&self) -> BrowserResult<bool> {
        let conn = self.get_conn()?;
        let enabled: i64 = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        Ok(enabled == 1)
    }

    /// 关闭池并释放文件句柄（不删库文件）。下次 [`ensure_open`] 可再开。
    pub fn close(&self) -> BrowserResult<()> {
        let mut guard = self
            .pool
            .write()
            .map_err(|e| BrowserError::Pool(format!("Pool lock poisoned: {e}")))?;
        if let Some(pool) = guard.take() {
            // 尝试 checkpoint，失败仅告警
            if let Ok(conn) = pool.get() {
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            }
            drop(pool);
            info!("[Browser::Database] Connection pool closed");
        }
        Ok(())
    }

    fn build_pool(db_path: &Path) -> BrowserResult<BrowserPool> {
        debug!(
            "[Browser::Database] Building pool for {}",
            db_path.display()
        );

        let manager = SqliteConnectionManager::file(db_path).with_init(|conn| {
            conn.pragma_update(None, "foreign_keys", "ON")?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            conn.pragma_update(None, "busy_timeout", 3000i64)?;
            Ok(())
        });

        Pool::builder()
            .max_size(POOL_MAX_SIZE)
            .min_idle(Some(1))
            .connection_timeout(Duration::from_secs(10))
            .build(manager)
            .map_err(|e| BrowserError::Pool(format!("Failed to create connection pool: {e}")))
    }

    fn run_migrations(pool: &BrowserPool) -> BrowserResult<()> {
        #[cfg(feature = "data_governance")]
        {
            mod browser_migrations {
                refinery::embed_migrations!("migrations/browser");
            }

            let mut conn = pool
                .get()
                .map_err(|e| BrowserError::Pool(format!("Failed to get connection: {e}")))?;
            browser_migrations::migrations::runner()
                .set_grouped(false)
                .set_abort_divergent(false)
                .set_abort_missing(false)
                .run(&mut *conn)
                .map_err(|e| {
                    BrowserError::Migration(format!("Failed to migrate browser.db: {e}"))
                })?;
        }

        #[cfg(not(feature = "data_governance"))]
        {
            let _ = pool;
            tracing::warn!(
                "[Browser::Database] data_governance feature off; skipping Refinery migrations"
            );
        }

        Ok(())
    }
}

/// 解析当前活动插槽目录（与 ChatV2 / LlmUsage 一致）
pub fn resolve_active_dir() -> BrowserResult<PathBuf> {
    crate::data_space::get_data_space_manager()
        .map(|mgr| mgr.active_dir())
        .ok_or_else(|| BrowserError::DataSpace("DataSpaceManager not initialized".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, BrowserDatabase) {
        let tmp = TempDir::new().expect("tempdir");
        let db = BrowserDatabase::new(tmp.path());
        (tmp, db)
    }

    #[test]
    fn new_does_not_create_file() {
        let (tmp, db) = setup();
        assert!(!db.is_open());
        assert!(!tmp.path().join(DATABASE_FILENAME).exists());
        assert_eq!(db.get_schema_version().unwrap(), 0);
    }

    #[test]
    fn ensure_open_creates_and_migrates() {
        let (tmp, db) = setup();
        db.ensure_open().expect("ensure_open");
        assert!(db.is_open());
        assert!(tmp.path().join(DATABASE_FILENAME).exists());
        assert_eq!(db.get_schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert!(db.is_foreign_keys_enabled().unwrap());

        // 幂等
        db.ensure_open().expect("second ensure_open");
        assert_eq!(db.get_schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn tables_exist_after_migrate() {
        let (_tmp, db) = setup();
        db.ensure_open().unwrap();
        let conn = db.get_conn().unwrap();
        for table in [
            "sessions",
            "history",
            "downloads",
            "site_permissions",
            "settings",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "missing table {table}");
        }
    }

    #[test]
    fn try_get_conn_before_open_fails() {
        let (_tmp, db) = setup();
        assert!(matches!(db.try_get_conn(), Err(BrowserError::NotOpen)));
    }

    #[test]
    fn close_releases_pool() {
        let (tmp, db) = setup();
        db.ensure_open().unwrap();
        db.close().unwrap();
        assert!(!db.is_open());
        assert!(tmp.path().join(DATABASE_FILENAME).exists());
        db.ensure_open().unwrap();
        assert!(db.is_open());
    }

    #[test]
    fn wal_mode_enabled() {
        let (_tmp, db) = setup();
        let conn = db.get_conn().unwrap();
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }
}
