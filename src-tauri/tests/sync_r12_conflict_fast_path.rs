//! [R12-conflict-fast] resolve 快速路径事务内业务行重读 — 行为级验收
//!
//! ## 背景（FINDINGS-WRAP P2-2 / PROTOCOL-R10 P2-3，本轮关闭）
//!
//! `data_governance_resolve_record_conflict` 的 `already_in_desired_state`
//! 快速路径（决策结果已等于业务表当前状态时只标记冲突 resolved、不走同步
//! 回写）曾用**事务外**读取的 `current_local_snapshot` 判定，`BEGIN IMMEDIATE`
//! 后只重验 `__sync_conflicts` generation。纯本地编辑不触碰 `__sync_conflicts`，
//! 在「快照读 → 拿到写锁」的窗口内发生的本地编辑会被按旧快照误标 resolved
//! （决策未广播、业务行无损，但冲突留痕口径失真）。
//!
//! R12-conflict-fast 把业务行重读搬进事务：`BEGIN IMMEDIATE` 后、标记
//! resolved 前用 `SyncManager::get_record_data` 重读业务行，按同一套
//! `(operation, data)` 重算是否仍处于决策目标状态；不再匹配即 fail-closed
//! 拒绝（「本地记录在冲突确认期间已变化，请刷新后重新确认」）。
//!
//! ## 本文件的两个验收面
//!
//! 1. **匹配时可标 resolved**：业务行未变，快速路径照常成功——重读不得把
//!    正常解决误伤成拒绝（防线不能过度收紧）。
//! 2. **不再匹配则拒绝**：另一连接先持有写锁并修改业务行、延迟提交，命令的
//!    事务外快照读到旧值、`BEGIN IMMEDIATE` 在 busy_timeout（5s）内等到写锁
//!    时业务行已变——事务内重读必须发现并拒绝，冲突行保持未解决、本地新编辑
//!    原样保留。修复前该场景会返回 Ok 并把冲突误标 resolved。
//!
//! 源码结构锁（重读存在、位于标记之前、fail-closed 文案）见
//! `sync_r10_protocol_locks.rs` 的 P2-3 用例。
//!
//! ## 运行方式
//!
//! 端到端用例走 `tauri::Builder::default()` 无窗口 App（同
//! `sync_r06_delete_resolve_tests.rs` / `sync_r07_delete_resolve_lock_tests.rs`
//! 先例）。Linux/Windows 用 `any_thread()` 逃生口；macOS 请用 nextest 或
//! `--test-threads=1` 运行本文件。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use deep_student_lib::data_governance::commands_sync::data_governance_resolve_record_conflict;
use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, ChangeOperation, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};

// ============================================================================
// Fixture（与 sync_r06/r07 delete-resolve 测试同形，临时目录/记录 id 相互隔离）
// ============================================================================

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

/// 制造一条会走快速路径的单侧 DELETE 冲突（side='cloud' / data_json='null'
/// 恰好一行；keep_local 时本地行本就是 LWW 胜方 → already_in_desired_state）。
/// 返回该记录未解决冲突的 id 列表。
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
        "前提校验：应恰好产出一行单侧冲突，实际 {rows:?}"
    );
    let (_, side, data_json) = &rows[0];
    assert_eq!(side, "cloud");
    assert_eq!(data_json, "null");
    vec![rows[0].0]
}

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

/// 进程级共享测试环境：DataSpaceManager 全局只能初始化一次。
fn active_data_dir() -> &'static PathBuf {
    static ACTIVE_DIR: OnceLock<PathBuf> = OnceLock::new();
    ACTIVE_DIR.get_or_init(|| {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "ds-r12-conflict-fast-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&base).unwrap();
        deep_student_lib::data_space::init_data_space_manager(base)
            .expect("初始化测试 DataSpaceManager 失败");
        deep_student_lib::data_space::get_data_space_manager()
            .expect("DataSpaceManager 刚初始化即应可用")
            .active_dir()
    })
}

fn open_active_vfs_db() -> Connection {
    let db_path = active_data_dir().join("databases").join("vfs.db");
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let conn = Connection::open(&db_path).unwrap();
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    ensure_schema(&conn);
    conn
}

/// 无窗口 tauri App（生产命令签名要求具体 AppHandle 类型）。
fn build_headless_app() -> tauri::App {
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "linux", windows))]
    let builder = builder.any_thread();
    builder
        .build(tauri::generate_context!())
        .expect("构建无窗口 tauri App 失败")
}

/// 进程级共享 AppHandle：GTK/tao 事件循环每进程只能创建一次。
/// 首个调用方构建 App 并有意泄漏（存活到进程结束），其余测试复用 handle。
fn shared_app_handle() -> tauri::AppHandle {
    static HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
    HANDLE
        .get_or_init(|| {
            let app = build_headless_app();
            let handle = app.handle().clone();
            std::mem::forget(app);
            handle
        })
        .clone()
}

/// 串行化生产命令调用（内部有全局 BACKUP_GLOBAL_LIMITER，try_acquire 失败即报错）。
fn command_serial_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn resolve_keep_local(record_id: &str, expected_ids: Vec<i64>) -> Result<(), String> {
    let handle = shared_app_handle();
    tauri::async_runtime::block_on(data_governance_resolve_record_conflict(
        handle,
        "vfs".to_string(),
        "items".to_string(),
        record_id.to_string(),
        "keep_local".to_string(),
        None,
        expected_ids,
    ))
}

// ============================================================================
// 验收面 1：业务行未变 → 快速路径照常标 resolved（重读不得误伤正常解决）
// ============================================================================

#[test]
fn r12_fast_path_matching_state_still_marks_resolved() {
    let _serial = command_serial_lock();
    let conn = open_active_vfs_db();
    let record_id = "r12-fast-match-rec";
    let expected_ids = seed_one_sided_delete_conflict(&conn, record_id, 1201);
    drop(conn);

    resolve_keep_local(record_id, expected_ids)
        .expect("业务行未变时快速路径必须照常成功（事务内重读不得误伤）");

    let conn = open_active_vfs_db();
    assert!(
        unresolved_conflict_rows(&conn, record_id).is_empty(),
        "解决后不得残留未解决冲突行"
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
    assert!(resolved_rows >= 1, "冲突行应被标记 resolution='keep_local'");
    assert_eq!(
        record_content(&conn, record_id).as_deref(),
        Some("kept-local"),
        "keep_local 后本地行必须原样保留"
    );
}

// ============================================================================
// 验收面 2：窗口内本地编辑 → 事务内重读必须发现并拒绝（修复前会误标 resolved）
// ============================================================================

/// 复现 P2-3 的竞争窗口：写线程先 `BEGIN IMMEDIATE` 持有写锁并修改业务行
/// （不动 `__sync_conflicts`，generation 重验发现不了），延迟提交；命令的
/// 事务外快照读到旧值、判定 already-desired，`BEGIN IMMEDIATE` 在
/// busy_timeout（5s）内等到写锁时业务行已是新值。
///
/// 修复后：事务内重读发现不匹配 → 返回「本地记录在冲突确认期间已变化」，
/// 冲突行保持未解决、本地新编辑原样保留。修复前：命令返回 Ok，冲突被按
/// 旧快照误标 resolved——本用例即失败。
#[test]
fn r12_fast_path_concurrent_local_edit_is_rejected_in_transaction() {
    let _serial = command_serial_lock();
    let conn = open_active_vfs_db();
    let record_id = "r12-fast-race-rec";
    let expected_ids = seed_one_sided_delete_conflict(&conn, record_id, 1202);
    drop(conn);

    // 写线程：先拿写锁并改业务行（content 是语义字段，updated_at 会被
    // records_semantically_equal_for_sync 剥离，故必须改 content），1.5s 后提交。
    // 命令连接 busy_timeout=5s，足以等到提交。
    let writer = open_active_vfs_db();
    writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
    writer
        .execute(
            "UPDATE items SET content='edited-during-confirm',
                              updated_at='2026-07-10T14:00:00Z'
             WHERE id=?1",
            params![record_id],
        )
        .unwrap();
    let committer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        writer.execute_batch("COMMIT;").unwrap();
    });

    // 写锁被持有期间调用命令：事务外读仍能读到旧值（SHARED 读不被 RESERVED
    // 阻塞），BEGIN IMMEDIATE 则会等到写线程提交后才拿到锁。
    let result = resolve_keep_local(record_id, expected_ids);
    committer.join().unwrap();

    let err = result.expect_err("窗口内业务行已变，快速路径必须拒绝而非按旧快照标 resolved");
    assert!(
        err.contains("本地记录在冲突确认期间已变化"),
        "拒绝文案应指向刷新重确认，实际: {err}"
    );

    let conn = open_active_vfs_db();
    assert_eq!(
        unresolved_conflict_rows(&conn, record_id).len(),
        1,
        "被拒绝的决策不得改动冲突行——必须保持未解决（徽章不释放）"
    );
    let resolved_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts
             WHERE table_name='items' AND record_id=?1 AND resolved_at IS NOT NULL",
            params![record_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(resolved_rows, 0, "不得有任何冲突行被误标 resolved");
    assert_eq!(
        record_content(&conn, record_id).as_deref(),
        Some("edited-during-confirm"),
        "窗口内的本地编辑必须原样保留，不得被回滚或覆盖"
    );
}
