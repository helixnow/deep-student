//! DatabaseManager - 连接池管理器
//!
//! 从 database.rs 拆分，负责：
//! - r2d2 连接池管理
//! - 数据库切换
//! - 备份/恢复维护屏障（fail-close）
//!
//! NOTE: 旧版顺序迁移系统（`initialize_schema`/`handle_migration`/
//! `migrate_to_version`/`ensure_compatibility`/`ensure_post_migration_patches`）
//! 已删除：生产路径从未调用（`DatabaseManager::new` 不建 schema），
//! schema 的唯一事实源是 `data_governance/migration/coordinator.rs` 的
//! Refinery 迁移脚本。此处不得再引入任何运行时 ALTER。

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

use super::maintenance::{self, MaintenanceState};
use super::{SqlitePool, SqlitePooledConnection};

pub struct DatabaseManager {
    pool: RwLock<SqlitePool>,
    db_path: RwLock<PathBuf>,
    /// 维护屏障状态机（Active/Draining/Maintenance），无锁、poison 免疫。
    maintenance: MaintenanceState,
}

impl DatabaseManager {
    /// 创建新的数据库管理器，使用 r2d2 连接池
    pub fn new(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建数据库目录失败: {:?}", parent))?;
        }

        let pool = Self::build_pool(db_path)?;

        let db_manager = DatabaseManager {
            pool: RwLock::new(pool),
            db_path: RwLock::new(db_path.to_path_buf()),
            maintenance: MaintenanceState::new(),
        };

        Ok(db_manager)
    }

    /// 获取数据库连接
    ///
    /// fail-close：维护屏障（备份/恢复）期间显式拒绝。借出前后各检查一次
    /// 屏障状态，关闭"检查通过后屏障才建立"的竞争窗口——排空循环会等待
    /// 竞争窗口内借出的连接归还，而这里的复查保证该连接不会被业务使用。
    pub fn get_conn(&self) -> Result<SqlitePooledConnection> {
        if !self.maintenance.is_active() {
            anyhow::bail!("主数据库连接池{}", maintenance::MAINTENANCE_REFUSAL_MESSAGE);
        }
        let pool = self.pool.read().unwrap_or_else(|poisoned| {
            log::error!("[DatabaseManager] Pool RwLock poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        let conn = pool.get().with_context(|| "从连接池获取连接失败")?;
        // 借出后复查：若屏障已在借出期间开始排空，立即归还并显式失败
        if !self.maintenance.is_active() {
            drop(conn);
            anyhow::bail!("主数据库连接池{}", maintenance::MAINTENANCE_REFUSAL_MESSAGE);
        }
        Ok(conn)
    }

    /// 当前使用的数据库路径
    pub fn current_db_path(&self) -> PathBuf {
        match self.db_path.read() {
            Ok(path) => path.clone(),
            Err(poisoned) => {
                log::error!("[DatabaseManager] db_path RwLock poisoned! Attempting recovery");
                poisoned.into_inner().clone()
            }
        }
    }

    fn build_pool(db_path: &Path) -> Result<SqlitePool> {
        let manager = r2d2_sqlite::SqliteConnectionManager::file(db_path).with_init(|c| {
            // 基础 PRAGMA 设置
            c.pragma_update(None, "foreign_keys", "ON")?;
            c.pragma_update(None, "journal_mode", "WAL")?;
            c.pragma_update(None, "synchronous", "NORMAL")?;
            // 防止写入互斥等待无界：设置 busy_timeout 以快速失败并交给上层重试/提示
            // 单位毫秒，3 秒足以让短事务释放写锁
            c.pragma_update(None, "busy_timeout", 3000i64)?;
            Ok(())
        });

        let pool = r2d2::Pool::builder()
            .max_size(15)
            .min_idle(Some(2))
            .connection_timeout(Duration::from_secs(10))
            .build(manager)
            .with_context(|| format!("创建数据库连接池失败: {:?}", db_path))?;

        Ok(pool)
    }

    /// 切换数据库文件并刷新连接池
    ///
    /// fail-close：维护屏障期间拒绝切换——换入新磁盘池会重新打开文件句柄，
    /// 破坏屏障对"无活跃文件连接"的保证。
    pub fn switch_database(&self, new_path: &Path) -> Result<()> {
        if !self.maintenance.is_active() {
            anyhow::bail!("主数据库连接池处于维护屏障，拒绝切换数据库文件");
        }
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建数据库目录失败: {:?}", parent))?;
        }

        let new_pool = Self::build_pool(new_path)?;

        {
            let mut guard = match self.pool.write() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    log::error!("[DatabaseManager] Pool RwLock poisoned during switch_database! Forcing recovery");
                    poisoned.into_inner()
                }
            };
            *guard = new_pool;
        }

        {
            let mut path_guard = match self.db_path.write() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    log::error!("[DatabaseManager] db_path RwLock poisoned during switch_database! Forcing recovery");
                    poisoned.into_inner()
                }
            };
            *path_guard = new_path.to_path_buf();
        }

        Ok(())
    }

    /// 是否处于维护屏障（Draining 或 Maintenance 阶段）。
    pub fn is_in_maintenance_mode(&self) -> bool {
        self.maintenance.is_in_maintenance()
    }

    /// 进入维护模式（fail-close 快照屏障）：
    ///
    /// 1. CAS 抢占状态机（Active→Draining）——此后 `get_conn` 立即拒绝新借出，
    ///    重复进入直接失败，防止两个屏障持有者互相解除保护；
    /// 2. 持有池写锁并**可证明地排空**在途租约（`connections == idle_connections`），
    ///    替代旧实现"换池 + 固定 sleep(500ms) 祈祷后台任务归还"的做法；
    /// 3. 严格执行 `wal_checkpoint(TRUNCATE)`，失败（含 busy）回滚状态并向上传播；
    /// 4. 换入 fail-closed 占位池（任何 `get()` 显式失败，绝不发放可写的内存连接），
    ///    并同步丢弃旧磁盘池——排空保证此刻它持有全部连接，drop 即关闭文件句柄。
    pub fn enter_maintenance_mode(&self) -> Result<()> {
        self.enter_maintenance_mode_with_drain_deadline(maintenance::DEFAULT_DRAIN_DEADLINE)
    }

    /// 供测试注入较短排空时限；生产路径统一走 `enter_maintenance_mode`。
    fn enter_maintenance_mode_with_drain_deadline(&self, drain_deadline: Duration) -> Result<()> {
        self.maintenance
            .begin_drain()
            .map_err(|e| anyhow::anyhow!("主数据库连接池: {e}"))?;

        let entered = (|| -> Result<()> {
            // 持有写锁：阻止 get_pool 等并发读者在换池窗口拿到旧磁盘池
            let mut guard = self.pool.write().unwrap_or_else(|poisoned| {
                log::error!("[DatabaseManager] Pool RwLock poisoned during enter_maintenance_mode! Forcing recovery");
                poisoned.into_inner()
            });
            let old_pool = guard.clone();

            // 可证明排空：等待所有在途租约归还（含竞争窗口内借出后被复查拒绝的租约）
            maintenance::drain_pool_until_idle(&old_pool, drain_deadline)
                .map_err(|e| anyhow::anyhow!("主数据库连接池进入维护屏障失败: {e}"))?;

            // 排空后严格 checkpoint；失败必须传播，不能忽略
            {
                let conn = old_pool
                    .get()
                    .with_context(|| "维护屏障 checkpoint 前获取连接失败")?;
                maintenance::checkpoint_truncate_strict(&conn)
                    .map_err(|e| anyhow::anyhow!("主数据库连接池进入维护屏障失败: {e}"))?;
            }
            // checkpoint 连接归还后应立即重新排空（同一线程刚归还，限短时限）
            maintenance::drain_pool_until_idle(&old_pool, Duration::from_secs(1))
                .map_err(|e| anyhow::anyhow!("主数据库连接池进入维护屏障失败: {e}"))?;

            *guard = maintenance::fail_closed_placeholder_pool();
            drop(guard);
            // old_pool 此刻是磁盘池最后的句柄且全部连接空闲；drop 同步关闭
            // 所有文件句柄（Windows 上避免 os error 32），无需 sleep。
            drop(old_pool);
            Ok(())
        })();

        match entered {
            Ok(()) => {
                self.maintenance.commit_maintenance();
                log::info!("[DatabaseManager] 已进入维护屏障：在途连接已排空，文件句柄已关闭");
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
    /// 绝不提前恢复 Active 让业务拿到占位池的显式失败之外的任何结果。
    /// 未处于维护屏障时调用为幂等 no-op。
    pub fn exit_maintenance_mode(&self) -> Result<()> {
        if self.maintenance.is_active() {
            log::warn!(
                "[DatabaseManager] exit_maintenance_mode 在非维护状态被调用，按幂等 no-op 处理"
            );
            return Ok(());
        }
        let path = self.current_db_path();
        // 先完整建好磁盘池；失败则保持屏障（fail-close）
        let new_pool = Self::build_pool(&path)?;

        {
            let mut guard = match self.pool.write() {
                Ok(g) => g,
                Err(poisoned) => {
                    log::error!("[DatabaseManager] Pool RwLock poisoned during exit_maintenance_mode! Forcing recovery");
                    poisoned.into_inner()
                }
            };
            *guard = new_pool;
        }
        self.maintenance.force_active();

        log::info!("[DatabaseManager] 已退出维护屏障，文件连接已恢复");
        Ok(())
    }

    /// 从现有连接池创建 DatabaseManager（用于兼容性）
    pub fn from_pool(pool: SqlitePool, db_path: PathBuf) -> Self {
        DatabaseManager {
            pool: RwLock::new(pool),
            db_path: RwLock::new(db_path),
            maintenance: MaintenanceState::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_manager() -> (TempDir, DatabaseManager) {
        let temp_dir = TempDir::new().expect("temp dir");
        let manager =
            DatabaseManager::new(&temp_dir.path().join("main.db")).expect("database manager");
        {
            let conn = manager.get_conn().expect("initial connection");
            conn.execute_batch(
                "CREATE TABLE barrier_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
            )
            .expect("create probe table");
        }
        (temp_dir, manager)
    }

    /// 回归：进入屏障后新连接必须显式失败，屏障期间不允许任何写入
    /// 落到一次性池后被静默丢弃；退出屏障后屏障前的数据完整可见。
    #[test]
    fn maintenance_barrier_fails_closed_and_preserves_data() {
        let (_dir, manager) = setup_manager();

        manager
            .get_conn()
            .unwrap()
            .execute("INSERT INTO barrier_probe (value) VALUES ('before')", [])
            .expect("write before barrier");

        manager
            .enter_maintenance_mode()
            .expect("enter maintenance barrier");
        assert!(manager.is_in_maintenance_mode());

        // 屏障内：新连接显式失败（fail-close），而不是拿到内存库"成功"写入
        let refused = manager.get_conn();
        assert!(refused.is_err(), "maintenance must refuse new connections");
        assert!(
            refused.unwrap_err().to_string().contains("维护屏障"),
            "refusal must carry an explicit maintenance message"
        );

        // 屏障内：切换数据库文件同样被拒绝
        assert!(manager.switch_database(&manager.current_db_path()).is_err());

        manager
            .exit_maintenance_mode()
            .expect("exit maintenance barrier");
        assert!(!manager.is_in_maintenance_mode());

        let count: i64 = manager
            .get_conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM barrier_probe", [], |row| row.get(0))
            .expect("count after barrier");
        assert_eq!(count, 1, "pre-barrier data must survive the barrier");
    }

    /// 回归：屏障是独占的——重复进入必须失败，不能静默重置他人建立的屏障；
    /// 退出后可重新进入；非维护状态下退出是幂等 no-op。
    #[test]
    fn maintenance_barrier_is_exclusive_and_exit_is_idempotent() {
        let (_dir, manager) = setup_manager();

        manager.exit_maintenance_mode().expect("no-op exit is ok");

        manager.enter_maintenance_mode().expect("first enter");
        assert!(
            manager.enter_maintenance_mode().is_err(),
            "double enter must fail instead of silently re-entering"
        );

        manager.exit_maintenance_mode().expect("exit");
        manager
            .enter_maintenance_mode()
            .expect("re-enter after exit");
        manager.exit_maintenance_mode().expect("final exit");
    }

    /// 回归：在途连接未归还时，屏障必须在排空阶段显式失败并回滚为 Active
    /// （替代旧实现固定 sleep(500ms) 后无条件继续）；租约归还后可进入。
    #[test]
    fn maintenance_barrier_drains_in_flight_connections_or_fails() {
        let (_dir, manager) = setup_manager();

        let held = manager.get_conn().expect("hold a lease");
        let err = manager
            .enter_maintenance_mode_with_drain_deadline(Duration::from_millis(150))
            .expect_err("outstanding lease must block the barrier");
        assert!(
            err.to_string().contains("未归还"),
            "drain timeout should report outstanding leases: {err}"
        );
        // 进入失败必须回滚：连接池继续正常服务
        assert!(!manager.is_in_maintenance_mode());
        manager
            .get_conn()
            .expect("barrier rollback must restore service");

        drop(held);
        manager
            .enter_maintenance_mode_with_drain_deadline(Duration::from_secs(5))
            .expect("barrier succeeds after lease is returned");
        manager.exit_maintenance_mode().expect("exit");
    }
}
