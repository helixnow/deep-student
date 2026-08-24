//! [R06-del-resolve] 单侧 DELETE 冲突的"可解决性"回归测试
//!
//! ## 背景（FINDINGS-R05 复审残留，R06-del-resolve 已修复）
//!
//! 生产同步链路曾存在一条自相矛盾的契约：
//!
//! 1. **写入端**：本地行无 pending 修改时，慢钟设备的 DELETE 输掉 LWW 门后，
//!    删除意图只写**一行** `__sync_conflicts(side='cloud', data_json='null')`
//!    ——没有配对的 local 侧快照（见 `sync_r05_regression_tests.rs` 已钉住的
//!    `r05_slow_clock_delete_losing_lww_lands_in_sync_conflicts`，count=1）。
//! 2. **消费端**：`data_governance_resolve_record_conflict` 曾无条件要求
//!    local + cloud **双侧**快照，任何 resolution 都在读取阶段就失败，
//!    这类冲突永远无法通过 UI 解决，冲突面板 / 计数徽章被永久占位。
//!
//! R06-del-resolve 的修复落在**消费端**（写入端形状保持不变，作为契约钉住）：
//!
//! - 缺失 local 侧快照时回退为当前业务表行（LWW 胜方即本地行，本就没有
//!   独立快照的必要）；
//! - 决策结果与业务表当前状态一致时（keep_local 且本地行已是胜方），
//!   不再走会被语义等价幂等跳过卡死的同步回写，直接把冲突行标记为已解决。
//!
//! ## 本文件的测试分层
//!
//! - `r06_lww_gate_losing_delete_writes_only_cloud_side_snapshot`
//!   纯库层（内存 SQLite，无 tauri runtime）：钉住"写入端只产出单侧"这一
//!   既定契约（resolve 端已能消费该形状），任何环境都可跑。
//! - `r06_one_sided_delete_conflict_should_be_resolvable`
//!   端到端：真实调用生产 `#[tauri::command]`，单侧 DELETE 冲突用 keep_local
//!   成功解决——冲突行标记 resolved、本地行保留、徽章释放。
//!
//! 端到端用例走 `tauri::Builder::default()`（同 `tool_pack_integration_tests.rs`
//! 的既有先例，Linux CI 无显示环境下可构建 App；本文件不创建任何窗口）。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use deep_student_lib::data_governance::commands_sync::{
    data_governance_list_record_conflicts, data_governance_resolve_record_conflict,
};
use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, ChangeOperation, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};

// ============================================================================
// Fixture
// ============================================================================

/// 业务表 + __change_log（与 sync_r05_regression_tests 同形；无触发器，
/// pending 状态由测试自行控制）。幂等，可对同一连接/文件重复调用。
fn ensure_schema(conn: &Connection) {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            content TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        "#,
    )
    .unwrap();
}

fn stale_delete_change(record_id: &str, source_seq: u64) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: ChangeOperation::Delete,
        data: None,
        // 早于本地 updated_at（13:00Z）→ 输掉 LWW 门
        changed_at: "2026-07-10T12:00:00Z".to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some("device-slow".to_string()),
        source_seq: Some(source_seq),
    }
}

/// 制造一条"单侧 DELETE 冲突"：本地行较新且**无** pending 修改，
/// 慢钟 DELETE 走 LWW 门被拒 → 只写 side='cloud' / data_json='null' 一行。
/// 返回该记录未解决冲突的 id 列表（应恰好一个元素）。
fn seed_one_sided_delete_conflict(conn: &Connection, record_id: &str, source_seq: u64) -> Vec<i64> {
    conn.execute(
        "INSERT INTO items(id, content, updated_at) VALUES(?1, 'kept-local', '2026-07-10T13:00:00Z')",
        params![record_id],
    )
    .unwrap();

    let (result, _) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        conn,
        &[stale_delete_change(record_id, source_seq)],
        None,
        ConflictPolicy::KeepLatest,
        Some("device-slow"),
        Some("device-local"),
    )
    .unwrap();
    assert_eq!(result.success_count, 0, "较旧 DELETE 不得生效");
    assert_eq!(result.failure_count, 0, "LWW 拒绝不是失败");

    let rows = unresolved_conflict_rows(conn, record_id);
    assert_eq!(
        rows.len(),
        1,
        "前提校验：LWW 门败方 DELETE 应恰好产出一行冲突（单侧），实际 {rows:?}"
    );
    let (id, side, data_json) = &rows[0];
    assert_eq!(side, "cloud", "唯一一行应是云端删除意图");
    assert_eq!(data_json, "null", "DELETE 败方以 Null payload 表示");
    vec![*id]
}

/// 读取某记录所有未解决冲突行：(id, side, data_json)
fn unresolved_conflict_rows(conn: &Connection, record_id: &str) -> Vec<(i64, String, String)> {
    let mut stmt = conn
        .prepare(
            "SELECT id, side, data_json FROM __sync_conflicts
             WHERE table_name='items' AND record_id=?1 AND resolved_at IS NULL
             ORDER BY id ASC",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![record_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    rows.map(Result::unwrap).collect()
}

fn record_content(conn: &Connection, record_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT content FROM items WHERE id=?1",
        params![record_id],
        |row| row.get(0),
    )
    .ok()
}

// ============================================================================
// 纯库层：钉住"写入端只产出单侧"（任何环境可跑）
// ============================================================================

/// LWW 门败方 DELETE 只写 side='cloud' 一行，**没有** local 侧快照。
/// 这是既定的写入端契约：本地行是 LWW 胜方、原样保留，无需独立快照；
/// resolve 命令（R06-del-resolve 起）对缺失的 local 侧回退当前业务表行。
#[test]
fn r06_lww_gate_losing_delete_writes_only_cloud_side_snapshot() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn);
    seed_one_sided_delete_conflict(&conn, "rec-shape", 1);

    let local_side_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts
             WHERE table_name='items' AND record_id='rec-shape' AND side='local'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        local_side_rows, 0,
        "LWW 门路径不写 local 侧快照 —— resolve 命令要求的双侧数据在此形状下不存在"
    );
    assert_eq!(
        record_content(&conn, "rec-shape").as_deref(),
        Some("kept-local"),
        "本地行必须原样保留"
    );
}

// ============================================================================
// 端到端：真实调用生产 resolve 命令
// ============================================================================

/// 进程级共享测试环境：DataSpaceManager 全局只能初始化一次，
/// 指向独立临时目录；vfs.db 由各测试共用（记录 id 各自隔离）。
fn active_data_dir() -> &'static PathBuf {
    static ACTIVE_DIR: OnceLock<PathBuf> = OnceLock::new();
    ACTIVE_DIR.get_or_init(|| {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("ds-r06-del-resolve-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        deep_student_lib::data_space::init_data_space_manager(base)
            .expect("初始化测试 DataSpaceManager 失败");
        deep_student_lib::data_space::get_data_space_manager()
            .expect("DataSpaceManager 刚初始化即应可用")
            .active_dir()
    })
}

/// 打开活动数据空间里的 vfs.db（`data_governance_resolve_record_conflict`
/// 解析 `database_name="vfs"` 时读的就是这个文件）。
fn open_active_vfs_db() -> Connection {
    let db_path = active_data_dir().join("databases").join("vfs.db");
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let conn = Connection::open(&db_path).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    ensure_schema(&conn);
    conn
}

/// 无窗口 tauri App（默认 runtime）。生产命令签名是具体的
/// `tauri::AppHandle`（Wry），mock runtime 的 handle 类型不兼容，
/// 只能走默认 Builder —— 与 `tool_pack_integration_tests.rs` 相同的先例。
///
/// Linux/Windows 上用 `any_thread()`：libtest 默认在工作线程跑测试，
/// tao 事件循环要求主线程会直接 panic（nextest 单测试单进程 +
/// `--test-threads=1` 在主线程执行所以 CI 不受影响，但本地
/// `cargo test` 需要 any_thread 才能跑）。macOS 无此逃生口，
/// 请用 nextest 或 `--test-threads=1` 运行本文件。
fn build_headless_app() -> tauri::App {
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "linux", windows))]
    let builder = builder.any_thread();
    builder
        .build(tauri::generate_context!())
        .expect("构建无窗口 tauri App 失败")
}

/// 串行化对生产命令的调用：命令内部有全局 BACKUP_GLOBAL_LIMITER
/// （try_acquire，占用中直接报错），并发跑会互相干扰。
fn command_serial_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 【R06-del-resolve 修复后的行为】单侧 DELETE 冲突可被解决：
/// keep_local 后冲突行标记 resolved、本地行保留、徽章释放。
#[test]
fn r06_one_sided_delete_conflict_should_be_resolvable() {
    let _serial = command_serial_lock();
    let conn = open_active_vfs_db();
    let record_id = "r06-fix-rec";
    let expected_ids = seed_one_sided_delete_conflict(&conn, record_id, 202);
    drop(conn);

    let app = build_headless_app();
    let handle = app.handle().clone();

    tauri::async_runtime::block_on(data_governance_resolve_record_conflict(
        handle.clone(),
        "vfs".to_string(),
        "items".to_string(),
        record_id.to_string(),
        "keep_local".to_string(),
        None,
        expected_ids,
    ))
    .expect("单侧 DELETE 冲突（保留本地）应可成功解决");

    let conn = open_active_vfs_db();
    assert!(
        unresolved_conflict_rows(&conn, record_id).is_empty(),
        "解决后不得残留未解决冲突行（徽章必须释放）"
    );
    let resolved_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts
             WHERE table_name='items' AND record_id=?1
               AND resolved_at IS NOT NULL AND resolution='keep_local'",
            params![record_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        resolved_rows >= 1,
        "冲突行应被标记为 resolved（resolution='keep_local'）而非被物理删除"
    );
    assert_eq!(
        record_content(&conn, record_id).as_deref(),
        Some("kept-local"),
        "keep_local 后本地行必须保留"
    );

    let listed =
        tauri::async_runtime::block_on(data_governance_list_record_conflicts(handle, None, None))
            .expect("列出冲突不应失败");
    assert!(
        !listed
            .iter()
            .any(|row| row.database_name == "vfs" && row.record_id == record_id),
        "解决后冲突面板不得再列出该组"
    );
}
