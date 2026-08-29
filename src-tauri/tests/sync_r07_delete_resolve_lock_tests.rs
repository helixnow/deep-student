//! [R07-tests] 单侧 cloud-only DELETE 冲突可解决性 — R06-del-resolve 锁定测试
//!
//! ## 背景
//!
//! R06-del-resolve 使"LWW 门败方 DELETE 只写一行 side='cloud' / data_json='null'"
//! 的单侧冲突可以被解决（缺失的 local 快照回退为当前业务表行）。
//! `sync_r06_delete_resolve_tests.rs` 已钉住 keep_local（保留本地行）路径；
//! 本文件补锁其余出口，防止后续改动悄悄退化：
//!
//! - `keep_cloud`：接受云端删除意图 → 本地行必须被删除、冲突标记 resolved；
//! - `merged` + `null`：手动合并写入 null 等价于删除，同样必须可用；
//! - 乐观并发防线：expected_conflict_ids 与现状不符时决策必须整体拒绝，
//!   本地行与冲突行都不得被改动（对单侧形状同样生效）。
//!
//! ## 运行方式
//!
//! 端到端用例走 `tauri::Builder::default()` 无窗口 App（同
//! `sync_r06_delete_resolve_tests.rs` / `tool_pack_integration_tests.rs` 先例）。
//! Linux/Windows 用 `any_thread()` 逃生口；macOS 请用 nextest 或
//! `--test-threads=1` 运行本文件。

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
// Fixture（与 sync_r06_delete_resolve_tests 同形，记录 id / 临时目录相互隔离）
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

/// 制造单侧 DELETE 冲突（side='cloud' / data_json='null' 恰好一行），
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
    let (id, side, data_json) = &rows[0];
    assert_eq!(side, "cloud");
    assert_eq!(data_json, "null");
    vec![*id]
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

fn resolved_rows_with(conn: &Connection, record_id: &str, resolution: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM __sync_conflicts
         WHERE table_name='items' AND record_id=?1
           AND resolved_at IS NOT NULL AND resolution=?2",
        params![record_id, resolution],
        |row| row.get(0),
    )
    .unwrap()
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
            "ds-r07-del-resolve-lock-{}-{nonce}",
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
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .unwrap();
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

/// 进程级共享 AppHandle：GTK/tao 事件循环每进程只能创建一次，
/// 本文件多个测试并发各建一个 App 会在第二次初始化时 panic。
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

/// 串行化生产命令调用（内部有全局 BACKUP_GLOBAL_LIMITER）。
fn command_serial_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ============================================================================
// keep_cloud：接受云端删除意图
// ============================================================================

/// 单侧 DELETE 冲突选 keep_cloud（接受删除）：本地行必须被删除、
/// 冲突行标记 resolution='keep_cloud'、面板与徽章释放。
#[test]
fn r07_one_sided_delete_conflict_keep_cloud_applies_delete() {
    let _serial = command_serial_lock();
    let conn = open_active_vfs_db();
    let record_id = "r07-keep-cloud-rec";
    let expected_ids = seed_one_sided_delete_conflict(&conn, record_id, 701);
    drop(conn);

    let handle = shared_app_handle();

    tauri::async_runtime::block_on(data_governance_resolve_record_conflict(
        handle.clone(),
        "vfs".to_string(),
        "items".to_string(),
        record_id.to_string(),
        "keep_cloud".to_string(),
        None,
        expected_ids,
    ))
    .expect("单侧 DELETE 冲突（接受删除）应可成功解决");

    let conn = open_active_vfs_db();
    assert_eq!(
        record_content(&conn, record_id),
        None,
        "keep_cloud 后本地行必须被删除（云端删除意图生效）"
    );
    assert!(
        unresolved_conflict_rows(&conn, record_id).is_empty(),
        "解决后不得残留未解决冲突行"
    );
    assert!(
        resolved_rows_with(&conn, record_id, "keep_cloud") >= 1,
        "冲突行应被标记为 resolution='keep_cloud' 留痕"
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

// ============================================================================
// merged + null：手动合并等价删除
// ============================================================================

/// 单侧 DELETE 冲突走手动合并、写入 JSON null：等价接受删除，
/// 行被删、冲突标记 resolution='merged'。
#[test]
fn r07_one_sided_delete_conflict_merged_null_applies_delete() {
    let _serial = command_serial_lock();
    let conn = open_active_vfs_db();
    let record_id = "r07-merged-null-rec";
    let expected_ids = seed_one_sided_delete_conflict(&conn, record_id, 702);
    drop(conn);

    let handle = shared_app_handle();

    tauri::async_runtime::block_on(data_governance_resolve_record_conflict(
        handle,
        "vfs".to_string(),
        "items".to_string(),
        record_id.to_string(),
        "merged".to_string(),
        Some("null".to_string()),
        expected_ids,
    ))
    .expect("merged + null 应等价接受删除并成功解决");

    let conn = open_active_vfs_db();
    assert_eq!(
        record_content(&conn, record_id),
        None,
        "merged null 后本地行必须被删除"
    );
    assert!(
        unresolved_conflict_rows(&conn, record_id).is_empty(),
        "解决后不得残留未解决冲突行"
    );
    assert!(
        resolved_rows_with(&conn, record_id, "merged") >= 1,
        "冲突行应被标记为 resolution='merged' 留痕"
    );
}

// ============================================================================
// 乐观并发防线：expected ids 失配必须整体拒绝
// ============================================================================

/// expected_conflict_ids 与现状不符（模拟另一端已刷新/新增冲突）时，
/// 单侧 DELETE 冲突的决策必须被拒绝：本地行原样保留、冲突保持未解决，
/// 之后用正确 ids 仍可正常解决（拒绝无副作用）。
#[test]
fn r07_one_sided_delete_conflict_stale_expected_ids_rejected_without_side_effects() {
    let _serial = command_serial_lock();
    let conn = open_active_vfs_db();
    let record_id = "r07-stale-ids-rec";
    let expected_ids = seed_one_sided_delete_conflict(&conn, record_id, 703);
    drop(conn);

    let handle = shared_app_handle();

    // 故意传一个不存在的冲突 id（旧客户端 / 并发刷新场景）
    let stale_ids = vec![expected_ids[0] + 999_999];
    let error = tauri::async_runtime::block_on(data_governance_resolve_record_conflict(
        handle.clone(),
        "vfs".to_string(),
        "items".to_string(),
        record_id.to_string(),
        "keep_cloud".to_string(),
        None,
        stale_ids,
    ))
    .expect_err("失配的 expected_conflict_ids 必须整体拒绝决策");
    assert!(
        error.contains("刷新"),
        "错误应引导用户刷新冲突列表: {error}"
    );

    let conn = open_active_vfs_db();
    assert_eq!(
        record_content(&conn, record_id).as_deref(),
        Some("kept-local"),
        "被拒绝的决策不得改动本地行"
    );
    assert_eq!(
        unresolved_conflict_rows(&conn, record_id).len(),
        1,
        "被拒绝的决策不得消耗冲突行"
    );
    drop(conn);

    // 用正确 ids 重试必须成功（拒绝无残留副作用）
    tauri::async_runtime::block_on(data_governance_resolve_record_conflict(
        handle,
        "vfs".to_string(),
        "items".to_string(),
        record_id.to_string(),
        "keep_local".to_string(),
        None,
        expected_ids,
    ))
    .expect("拒绝后用正确 ids 重试应成功");

    let conn = open_active_vfs_db();
    assert!(
        unresolved_conflict_rows(&conn, record_id).is_empty(),
        "重试成功后冲突应全部解决"
    );
    assert_eq!(
        record_content(&conn, record_id).as_deref(),
        Some("kept-local"),
        "keep_local 后本地行保留"
    );
}
