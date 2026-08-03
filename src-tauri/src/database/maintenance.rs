//! 数据库维护屏障原语（fail-close）。
//!
//! 备份/恢复等数据治理操作需要一个应用级的"快照屏障"：屏障内所有数据库
//! 连接必须被排空并关闭文件句柄，屏障期间任何新的连接/读写必须**显式失败**，
//! 绝不允许写入一次性的内存库后被静默丢弃。
//!
//! ## 状态机
//!
//! ```text
//! Active --begin_drain()--> Draining --commit_maintenance()--> Maintenance
//!    ^                         |                                    |
//!    +------abort_drain()------+                                    |
//!    +---------------------force_active() (exit 成功后) ------------+
//! ```
//!
//! 不变量：
//! - 只有 `Active` 状态允许发放新连接（借出前后各检查一次，关闭 CAS 竞争窗口）；
//! - `Draining`/`Maintenance` 下所有借出请求返回明确错误；
//! - 进入屏障失败（排空超时/checkpoint 失败）时状态回滚到 `Active`，磁盘池保持不变；
//! - 退出屏障失败（重新打开磁盘库失败）时状态保持 `Maintenance`（fail-close），
//!   绝不清除标志让调用方误以为已恢复。
//!
//! 状态存储在 `AtomicU8` 中，不依赖任何可能中毒的锁，poison 场景下语义不退化。

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

/// 屏障内拒绝新连接时的统一错误文案（用于错误信息与测试断言）。
pub(crate) const MAINTENANCE_REFUSAL_MESSAGE: &str =
    "处于维护屏障（备份/恢复进行中），拒绝发放新数据库连接以防写入被静默丢弃";

/// 进入屏障时等待在途连接归还的默认时限。
pub(crate) const DEFAULT_DRAIN_DEADLINE: Duration = Duration::from_secs(5);

const PHASE_ACTIVE: u8 = 0;
const PHASE_DRAINING: u8 = 1;
const PHASE_MAINTENANCE: u8 = 2;

/// 维护屏障阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MaintenancePhase {
    /// 正常服务：允许发放连接。
    Active,
    /// 正在进入屏障：拒绝新连接，等待在途连接归还。
    Draining,
    /// 屏障已建立：磁盘连接已全部关闭，占位池对任何请求显式失败。
    Maintenance,
}

/// 无锁维护状态机（见模块级文档）。
#[derive(Debug)]
pub(crate) struct MaintenanceState {
    phase: AtomicU8,
}

impl MaintenanceState {
    pub(crate) const fn new() -> Self {
        Self {
            phase: AtomicU8::new(PHASE_ACTIVE),
        }
    }

    pub(crate) fn phase(&self) -> MaintenancePhase {
        match self.phase.load(Ordering::SeqCst) {
            PHASE_DRAINING => MaintenancePhase::Draining,
            PHASE_MAINTENANCE => MaintenancePhase::Maintenance,
            _ => MaintenancePhase::Active,
        }
    }

    /// 是否允许发放新连接。
    pub(crate) fn is_active(&self) -> bool {
        self.phase() == MaintenancePhase::Active
    }

    /// 对外呈现的"处于维护模式"语义：Draining 与 Maintenance 均视为维护中。
    pub(crate) fn is_in_maintenance(&self) -> bool {
        !self.is_active()
    }

    /// 进入排空阶段。仅允许 Active -> Draining，重复进入返回错误，
    /// 防止两个屏障持有者互相解除对方的保护。
    pub(crate) fn begin_drain(&self) -> Result<(), String> {
        self.phase
            .compare_exchange(
                PHASE_ACTIVE,
                PHASE_DRAINING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map(|_| ())
            .map_err(|current| {
                format!(
                    "维护屏障已被占用（当前阶段: {}），拒绝重复进入以免破坏现有屏障",
                    match current {
                        PHASE_DRAINING => "Draining",
                        PHASE_MAINTENANCE => "Maintenance",
                        _ => "Active",
                    }
                )
            })
    }

    /// 进入屏障失败时的回滚：Draining -> Active。
    ///
    /// 使用 CAS 而非无条件 store，确保不会覆盖并发建立的 Maintenance 状态。
    pub(crate) fn abort_drain(&self) {
        let _ = self.phase.compare_exchange(
            PHASE_DRAINING,
            PHASE_ACTIVE,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }

    /// 排空+checkpoint+换池全部成功后提交屏障：Draining -> Maintenance。
    pub(crate) fn commit_maintenance(&self) {
        self.phase.store(PHASE_MAINTENANCE, Ordering::SeqCst);
    }

    /// 退出屏障成功后恢复服务。
    pub(crate) fn force_active(&self) {
        self.phase.store(PHASE_ACTIVE, Ordering::SeqCst);
    }
}

/// 等待连接池中所有在途租约归还（可证明的排空，替代固定 sleep）。
///
/// r2d2 的 `Pool::state()` 统计的是同一个内部池（包括所有 `Pool` 克隆借出的
/// 连接），因此 `connections == idle_connections` 即证明没有任何线程仍持有
/// `PooledConnection`。超时返回错误并报告未归还的租约数量。
pub(crate) fn drain_pool_until_idle(
    pool: &Pool<SqliteConnectionManager>,
    deadline: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + deadline;
    loop {
        let state = pool.state();
        if state.connections == state.idle_connections {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "等待在途数据库连接归还超时（仍有 {} 个租约未归还），拒绝在连接未排空时建立维护屏障",
                state.connections.saturating_sub(state.idle_connections)
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 执行 `PRAGMA wal_checkpoint(TRUNCATE)` 并严格校验结果。
///
/// checkpoint 失败（包括 busy=1 未能完成合并）必须向上传播：
/// 屏障建立在"WAL 已完整合并进主文件"的前提上，忽略失败会让备份读到缺数据的快照。
pub(crate) fn checkpoint_truncate_strict(conn: &Connection) -> Result<(), String> {
    let (busy, wal_pages, checkpointed): (i64, i64, i64) = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| format!("WAL checkpoint 执行失败: {e}"))?;
    if busy != 0 {
        return Err(format!(
            "WAL checkpoint 未能完成（busy={busy}, wal_pages={wal_pages}, checkpointed={checkpointed}），\
             存在并发读写占用，拒绝在 WAL 未合并的情况下建立维护屏障"
        ));
    }
    Ok(())
}

/// 构建屏障期间的占位连接池：任何 `get()` 都显式失败。
///
/// 之前的实现换入一个可正常读写的 `:memory:` 池，绕过维护标志的调用方
/// 会把数据写进内存库并在退出屏障时被静默丢弃（fail-open）。占位池的
/// init 回调恒定返回错误，`get()` 只会得到显式错误，永远不会成功。
pub(crate) fn fail_closed_placeholder_pool() -> Pool<SqliteConnectionManager> {
    let manager = SqliteConnectionManager::memory().with_init(|_| {
        Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_AUTH),
            Some(MAINTENANCE_REFUSAL_MESSAGE.to_string()),
        ))
    });
    Pool::builder()
        .max_size(1)
        // min_idle=0：禁止后台线程反复尝试建连（每次必然失败）刷错误日志
        .min_idle(Some(0))
        // 快速失败：占位池不存在"稍等即可用"的场景
        .connection_timeout(Duration::from_millis(250))
        // build_unchecked 不预建连接，保证构造永不失败
        .build_unchecked(manager)
}

/// 构建屏障期间的占位单连接：内存库 + 全量拒绝 authorizer。
///
/// `Database` 通过 `conn()` 暴露了裸 `Mutex<Connection>`，无法在借出处
/// 拦截。占位连接安装 deny-all authorizer 后，任何语句在 prepare 阶段
/// 即报 "not authorized"，包括 SELECT——之前的裸内存连接会让读写"成功"，
/// 写入在退出屏障时被静默丢弃。
pub(crate) fn deny_all_placeholder_connection() -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open_in_memory()?;
    conn.authorizer(Some(
        |_: rusqlite::hooks::AuthContext<'_>| -> rusqlite::hooks::Authorization {
            rusqlite::hooks::Authorization::Deny
        },
    ))?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_machine_enforces_single_owner_and_fail_close_transitions() {
        let state = MaintenanceState::new();
        assert!(state.is_active());
        assert!(!state.is_in_maintenance());

        // Active -> Draining，重复进入被拒绝
        state.begin_drain().expect("first drain should start");
        assert_eq!(state.phase(), MaintenancePhase::Draining);
        assert!(state.is_in_maintenance());
        assert!(state.begin_drain().is_err(), "double enter must fail");

        // 进入失败回滚
        state.abort_drain();
        assert!(state.is_active());

        // 完整进入
        state.begin_drain().unwrap();
        state.commit_maintenance();
        assert_eq!(state.phase(), MaintenancePhase::Maintenance);
        assert!(state.is_in_maintenance());

        // abort_drain 不得覆盖已提交的 Maintenance（CAS 保证）
        state.abort_drain();
        assert_eq!(state.phase(), MaintenancePhase::Maintenance);

        state.force_active();
        assert!(state.is_active());
    }

    #[test]
    fn placeholder_pool_never_hands_out_connections() {
        let pool = fail_closed_placeholder_pool();
        let err = pool
            .get()
            .expect_err("placeholder pool must refuse connections");
        // r2d2 将 init 错误折叠为超时错误；关键不变量是 get() 永不成功
        let _ = err.to_string();
    }

    #[test]
    fn deny_all_placeholder_connection_rejects_reads_and_writes() {
        let conn = deny_all_placeholder_connection().expect("placeholder connection");
        // 读也必须失败——静默返回空结果同样会误导调用方
        assert!(
            conn.prepare("SELECT 1").is_err(),
            "SELECT must be denied in maintenance mode"
        );
        assert!(
            conn.execute("CREATE TABLE t (id INTEGER)", []).is_err(),
            "DDL must be denied in maintenance mode"
        );
    }

    #[test]
    fn drain_waits_for_outstanding_lease_and_times_out_otherwise() {
        let pool = Pool::builder()
            .max_size(2)
            .min_idle(Some(0))
            .build(SqliteConnectionManager::memory())
            .expect("memory pool");

        // 无租约时立即返回
        drain_pool_until_idle(&pool, Duration::from_millis(100)).expect("idle pool drains");

        // 持有租约时在时限内必须超时报错，且错误里报告未归还数量
        let lease = pool.get().expect("lease");
        let err = drain_pool_until_idle(&pool, Duration::from_millis(120))
            .expect_err("outstanding lease must block the barrier");
        assert!(
            err.contains("1 个租约"),
            "error should report lease count: {err}"
        );

        drop(lease);
        drain_pool_until_idle(&pool, Duration::from_millis(500))
            .expect("returned lease unblocks the barrier");
    }

    #[test]
    fn strict_checkpoint_succeeds_on_healthy_wal_database() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("chk.db");
        let conn = Connection::open(&path).expect("open");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        conn.execute("CREATE TABLE t (id INTEGER)", [])
            .expect("ddl");
        conn.execute("INSERT INTO t VALUES (1)", []).expect("dml");
        checkpoint_truncate_strict(&conn).expect("healthy checkpoint must pass");
    }
}
