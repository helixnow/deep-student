//! # TD-02: `todo_items.completed_pomodoros` 派生计数重算
//!
//! `pomodoro_records` 是事实表；`todo_items.completed_pomodoros` **仅是派生缓存**。
//!
//! ## 历史债务
//!
//! 旧实现里本地路径做 ±1 增量、同步冲突用 MaxValue 字段合并，导致：
//! - 双设备各完成 2 / 3 个番茄 → MaxValue 收敛成 3（丢 2 个）；
//! - 删除一条记录本地 -1 → 对端行级覆盖 / MaxValue 用旧的更大值把计数复活。
//!
//! ## 收敛不变量
//!
//! 在任何一次同步 apply 事务提交时刻，对每个 todo 行：
//!
//! ```text
//! completed_pomodoros == COUNT(pomodoro_records
//!                              WHERE todo_item_id = todo.id
//!                                AND deleted_at IS NULL
//!                                AND type = 'work'
//!                                AND status = 'completed')
//! ```
//!
//! 口径与 `VfsPomodoroRepo` 的本地联动完全一致。只要两台设备的
//! `pomodoro_records` 行集（LWW 行同步）收敛，计数就必然收敛——
//! 与 apply 顺序、批次切分、重放次数无关（重算是幂等的纯函数）。
//!
//! ## 覆盖的场景
//!
//! - **远端 tombstone**：软删（UPSERT 带 `deleted_at`）与 DELETE 操作
//!   （`apply_single_change` 对有 tombstone 列的表写软删）都会让记录退出
//!   计数口径；
//! - **记录换 todo_item_id**：全量重算同时修正旧 todo（-1）与新 todo（+1）；
//! - **空记录归零**：没有任何有效记录的 todo 被清零（含 NULL → 0）；
//! - **部分同步 / 事务回滚**：重算在 apply 的 `BEGIN IMMEDIATE` 事务内、
//!   所有单条 SAVEPOINT 之后执行——整体回滚时重算随之丢弃；单条进检疫
//!   （quarantine）时重算只反映实际落库的行集；
//! - **行级 LWW 覆盖**：远端 `todo_items` 行携带的旧缓存值被覆盖写入后，
//!   紧接着的重算把它拉回事实表口径。
//!
//! ## 回声抑制
//!
//! 重算只改缓存列，不 bump `updated_at` / `local_version`；由触发器产生的
//! `__change_log` 条目会被标记为已同步（与 `recompute_derived_ref_counts`
//! 的 ref_count 口径一致），避免各设备的本地重算互相 ping-pong。

use rusqlite::{params, Connection};

use super::{SyncChangeWithData, SyncError, SyncManager};

/// 事实表（记录来源）
const FACT_TABLE: &str = "pomodoro_records";
/// 派生缓存所在表 / 列
const CACHE_TABLE: &str = "todo_items";
const CACHE_COLUMN: &str = "completed_pomodoros";

/// 计数口径：未软删 + work + completed 且关联了任务的记录。
/// 必须与 `VfsPomodoroRepo::recount_completed_pomodoros_cache` 保持一致。
const COMPLETED_WORK_FILTER: &str = "todo_item_id IS NOT NULL \
     AND deleted_at IS NULL \
     AND type = 'work' \
     AND status = 'completed'";

/// 判断本批变更是否需要触发 completed_pomodoros 重算：
/// - 触及事实表 `pomodoro_records`（新增 / 软删 / tombstone / 换 todo_item_id）；
/// - 或触及 `todo_items` 本身（行级 LWW 会把远端旧缓存值覆盖进来，需要纠正）。
pub(super) fn changes_affect_todo_pomodoro_counts(changes: &[SyncChangeWithData]) -> bool {
    changes
        .iter()
        .any(|change| change.table_name == FACT_TABLE || change.table_name == CACHE_TABLE)
}

/// 在 apply 事务的提交边界调用：仅当批次触及相关表时才做全量重算。
pub(super) fn recompute_todo_completed_pomodoros_if_relevant(
    conn: &Connection,
    changes: &[SyncChangeWithData],
) -> Result<(), SyncError> {
    if !changes_affect_todo_pomodoro_counts(changes) {
        return Ok(());
    }
    recompute_todo_completed_pomodoros(conn)
}

/// 按事实表全量重算 `todo_items.completed_pomodoros`。
///
/// - 幂等：同一数据库状态多次执行结果相同，且第二次起不再改动任何行
///   （`IS NOT` churn guard，无谓 UPDATE 不触发触发器）；
/// - 确定性：不依赖变更到达顺序，只依赖表当前状态；
/// - 覆盖软删 todo：软删行的缓存同样对齐事实表，复活后即为正确值；
/// - 回声抑制：重算产生的 `__change_log` 条目被标记为已同步。
pub(super) fn recompute_todo_completed_pomodoros(conn: &Connection) -> Result<(), SyncError> {
    // 库形状守卫：该同步管线也服务 chat_v2 / mistakes 等库，缺表缺列时静默跳过。
    if !SyncManager::table_has_column(conn, CACHE_TABLE, CACHE_COLUMN)
        || !SyncManager::table_has_column(conn, FACT_TABLE, "todo_item_id")
        || !SyncManager::table_has_column(conn, FACT_TABLE, "status")
    {
        return Ok(());
    }

    let pre_log_max = SyncManager::change_log_max_id(conn);

    // [P3 perf] UPDATE FROM（SQLite >= 3.33，bundled 3.42）单趟 GROUP BY 聚合；
    // [P2 churn] `IS NOT` 限定只更新值实际变化的行（同 recompute_resource_ref_counts）。
    let sql_update = format!(
        "UPDATE todo_items
         SET completed_pomodoros = rc.cnt
         FROM (
             SELECT todo_item_id, COUNT(*) AS cnt
             FROM pomodoro_records
             WHERE {COMPLETED_WORK_FILTER}
             GROUP BY todo_item_id
         ) rc
         WHERE todo_items.id = rc.todo_item_id
           AND todo_items.completed_pomodoros IS NOT rc.cnt"
    );
    conn.execute(&sql_update, []).map_err(|e| {
        SyncError::Database(format!("重算 todo_items.completed_pomodoros 失败: {}", e))
    })?;

    // 空记录归零：UPDATE FROM 是 inner-join 语义，失去全部有效记录的 todo
    // （记录被删 / 换绑到其他 todo）需要第二条语句补清零；NULL 也归一到 0。
    let sql_zero = format!(
        "UPDATE todo_items
         SET completed_pomodoros = 0
         WHERE completed_pomodoros IS NOT 0
           AND id NOT IN (
               SELECT todo_item_id FROM pomodoro_records
               WHERE {COMPLETED_WORK_FILTER}
           )"
    );
    conn.execute(&sql_zero, []).map_err(|e| {
        SyncError::Database(format!("清零 todo_items.completed_pomodoros 失败: {}", e))
    })?;

    // 回声抑制：派生缓存的重算是每台设备各自的本地行为，不得回流云端。
    if let Some(max_id) = pre_log_max {
        let sync_version = chrono::Utc::now().timestamp();
        let _ = conn.execute(
            "UPDATE __change_log SET sync_version = ?1
             WHERE id > ?2
               AND sync_version = 0
               AND table_name = 'todo_items'",
            params![sync_version, max_id],
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_governance::sync::ChangeOperation;
    use serde_json::json;

    /// 模拟一台设备的本地库（两个临时/内存 DB = 双设备）。
    /// 表结构截取自 VFS schema 中与本债务相关的列。
    fn create_device_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS __change_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                record_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
                changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                sync_version INTEGER DEFAULT 0
            );
            CREATE TABLE todo_items (
                id TEXT PRIMARY KEY,
                title TEXT,
                completed_pomodoros INTEGER DEFAULT 0,
                updated_at TEXT,
                deleted_at TEXT,
                local_version INTEGER DEFAULT 0
            );
            CREATE TABLE pomodoro_records (
                id TEXT PRIMARY KEY,
                todo_item_id TEXT,
                start_time TEXT,
                end_time TEXT,
                duration INTEGER NOT NULL DEFAULT 0,
                actual_duration INTEGER NOT NULL DEFAULT 0,
                type TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                local_version INTEGER DEFAULT 0
            );
            "#,
        )
        .unwrap();
        conn
    }

    fn seed_todo(conn: &Connection, todo_id: &str, updated_at: &str) {
        conn.execute(
            "INSERT INTO todo_items (id, title, completed_pomodoros, updated_at)
             VALUES (?1, 'focus task', 0, ?2)",
            params![todo_id, updated_at],
        )
        .unwrap();
    }

    /// 模拟本地"创建番茄记录"：INSERT 事实行 + 同事务内重算派生缓存
    /// （与 VfsPomodoroRepo::create_record 的 TD-02 行为一致）。
    fn create_local_work_record(conn: &Connection, record_id: &str, todo_id: &str, ts: &str) {
        conn.execute(
            "INSERT INTO pomodoro_records
                 (id, todo_item_id, start_time, end_time, duration, actual_duration,
                  type, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3, 1500, 1500, 'work', 'completed', ?3, ?3)",
            params![record_id, todo_id, ts],
        )
        .unwrap();
        recompute_todo_completed_pomodoros(conn).unwrap();
    }

    fn completed_pomodoros(conn: &Connection, todo_id: &str) -> i64 {
        conn.query_row(
            "SELECT COALESCE(completed_pomodoros, -999) FROM todo_items WHERE id = ?1",
            params![todo_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// 远端 work+completed 记录的同步变更（UPSERT；deleted_at 由参数控制）。
    fn work_record_change(
        record_id: &str,
        todo_id: &str,
        created_at: &str,
        updated_at: &str,
        deleted_at: Option<&str>,
    ) -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "pomodoro_records".to_string(),
            record_id: record_id.to_string(),
            operation: ChangeOperation::Update,
            data: Some(json!({
                "id": record_id,
                "todo_item_id": todo_id,
                "start_time": created_at,
                "end_time": created_at,
                "duration": 1500,
                "actual_duration": 1500,
                "type": "work",
                "status": "completed",
                "created_at": created_at,
                "updated_at": updated_at,
                "deleted_at": deleted_at,
            })),
            changed_at: updated_at.to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: Some("device-remote".to_string()),
            source_seq: Some(1),
        }
    }

    /// 远端 todo 行的同步变更：故意携带对端的**旧派生缓存值**，
    /// 模拟真实同步里行级 LWW 会把它覆盖进本地的情况。
    fn todo_change(todo_id: &str, cached_count: i64, updated_at: &str) -> SyncChangeWithData {
        SyncChangeWithData {
            table_name: "todo_items".to_string(),
            record_id: todo_id.to_string(),
            operation: ChangeOperation::Update,
            data: Some(json!({
                "id": todo_id,
                "title": "focus task",
                "completed_pomodoros": cached_count,
                "updated_at": updated_at,
                "deleted_at": null,
            })),
            changed_at: updated_at.to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: Some("device-remote".to_string()),
            source_seq: Some(2),
        }
    }

    /// TD-02 核心不变量：双设备各完成 2 / 3 个番茄，双向同步后两端都收敛到 5，
    /// 即使对端 todo 行携带的旧缓存值（3 / 2）通过行级 LWW 覆盖了本地缓存。
    /// 旧 MaxValue 语义下该场景收敛成 3。
    #[test]
    fn td02_two_devices_2_plus_3_converge_to_5() {
        let device_a = create_device_db();
        let device_b = create_device_db();
        for conn in [&device_a, &device_b] {
            seed_todo(conn, "todo-1", "2026-07-01T00:00:00Z");
        }

        create_local_work_record(&device_a, "rec-a1", "todo-1", "2026-07-01T01:00:00Z");
        create_local_work_record(&device_a, "rec-a2", "todo-1", "2026-07-01T02:00:00Z");
        create_local_work_record(&device_b, "rec-b1", "todo-1", "2026-07-01T01:10:00Z");
        create_local_work_record(&device_b, "rec-b2", "todo-1", "2026-07-01T01:40:00Z");
        create_local_work_record(&device_b, "rec-b3", "todo-1", "2026-07-01T02:20:00Z");
        assert_eq!(completed_pomodoros(&device_a, "todo-1"), 2);
        assert_eq!(completed_pomodoros(&device_b, "todo-1"), 3);

        // B → A：B 的 3 条记录 + B 的 todo 行（缓存 3，updated_at 更新 → LWW 覆盖）
        let b_to_a = vec![
            work_record_change(
                "rec-b1",
                "todo-1",
                "2026-07-01T01:10:00Z",
                "2026-07-01T01:10:00Z",
                None,
            ),
            work_record_change(
                "rec-b2",
                "todo-1",
                "2026-07-01T01:40:00Z",
                "2026-07-01T01:40:00Z",
                None,
            ),
            work_record_change(
                "rec-b3",
                "todo-1",
                "2026-07-01T02:20:00Z",
                "2026-07-01T02:20:00Z",
                None,
            ),
            todo_change("todo-1", 3, "2026-07-01T03:00:00Z"),
        ];
        SyncManager::apply_downloaded_changes(&device_a, &b_to_a, None).unwrap();
        assert_eq!(
            completed_pomodoros(&device_a, "todo-1"),
            5,
            "A 端 2+3 必须收敛为 5，而不是 MaxValue 的 3"
        );

        // A → B：对称方向
        let a_to_b = vec![
            work_record_change(
                "rec-a1",
                "todo-1",
                "2026-07-01T01:00:00Z",
                "2026-07-01T01:00:00Z",
                None,
            ),
            work_record_change(
                "rec-a2",
                "todo-1",
                "2026-07-01T02:00:00Z",
                "2026-07-01T02:00:00Z",
                None,
            ),
            todo_change("todo-1", 2, "2026-07-01T02:30:00Z"),
        ];
        SyncManager::apply_downloaded_changes(&device_b, &a_to_b, None).unwrap();
        assert_eq!(
            completed_pomodoros(&device_b, "todo-1"),
            5,
            "B 端同样收敛为 5：双设备计数一致"
        );
    }

    /// 删除不复活：本地计 2；对端删除其中一条并推送（软删 tombstone + 携带
    /// 旧缓存的 todo 行）。本地存在 pending 修改（旧实现会触发 MaxValue 字段
    /// 合并把 2 复活），修复后必须收敛为 1，且重复 apply 幂等。
    #[test]
    fn td02_remote_tombstone_delete_does_not_resurrect_count() {
        let device_a = create_device_db();
        seed_todo(&device_a, "todo-1", "2026-07-01T00:00:00Z");
        create_local_work_record(&device_a, "rec-1", "todo-1", "2026-07-01T01:00:00Z");
        create_local_work_record(&device_a, "rec-2", "todo-1", "2026-07-01T02:00:00Z");
        assert_eq!(completed_pomodoros(&device_a, "todo-1"), 2);

        // 本地对该 todo 有未同步修改 → 触发 allow_field_merge 分支
        // （旧实现在这里用 MaxValue(2, 1) = 2 把删除复活）
        device_a
            .execute(
                "INSERT INTO __change_log (table_name, record_id, operation, sync_version)
                 VALUES ('todo_items', 'todo-1', 'UPDATE', 0)",
                [],
            )
            .unwrap();

        let changes = vec![
            work_record_change(
                "rec-2",
                "todo-1",
                "2026-07-01T02:00:00Z",
                "2026-07-02T00:00:00Z",
                Some("2026-07-02T00:00:00Z"),
            ),
            todo_change("todo-1", 1, "2026-07-02T00:00:00Z"),
        ];
        SyncManager::apply_downloaded_changes(&device_a, &changes, None).unwrap();

        let deleted_at: Option<String> = device_a
            .query_row(
                "SELECT deleted_at FROM pomodoro_records WHERE id = 'rec-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(deleted_at.is_some(), "远端软删必须落地");
        assert_eq!(
            completed_pomodoros(&device_a, "todo-1"),
            1,
            "删除 -1 不得被旧缓存值 / MaxValue 复活"
        );

        // 重复 apply 幂等（同一 tombstone 批次重放）
        SyncManager::apply_downloaded_changes(&device_a, &changes, None).unwrap();
        assert_eq!(completed_pomodoros(&device_a, "todo-1"), 1);
    }

    /// 重复 apply 幂等：同一批远端记录应用两次，计数与事实行数都不翻倍。
    #[test]
    fn td02_repeated_apply_is_idempotent() {
        let device_a = create_device_db();
        seed_todo(&device_a, "todo-1", "2026-07-01T00:00:00Z");
        create_local_work_record(&device_a, "rec-a1", "todo-1", "2026-07-01T01:00:00Z");
        create_local_work_record(&device_a, "rec-a2", "todo-1", "2026-07-01T02:00:00Z");

        let batch = vec![
            work_record_change(
                "rec-b1",
                "todo-1",
                "2026-07-01T01:10:00Z",
                "2026-07-01T01:10:00Z",
                None,
            ),
            work_record_change(
                "rec-b2",
                "todo-1",
                "2026-07-01T01:40:00Z",
                "2026-07-01T01:40:00Z",
                None,
            ),
            work_record_change(
                "rec-b3",
                "todo-1",
                "2026-07-01T02:20:00Z",
                "2026-07-01T02:20:00Z",
                None,
            ),
            todo_change("todo-1", 3, "2026-07-01T03:00:00Z"),
        ];

        SyncManager::apply_downloaded_changes(&device_a, &batch, None).unwrap();
        assert_eq!(completed_pomodoros(&device_a, "todo-1"), 5);

        SyncManager::apply_downloaded_changes(&device_a, &batch, None).unwrap();
        assert_eq!(
            completed_pomodoros(&device_a, "todo-1"),
            5,
            "重复 apply 不得改变收敛结果"
        );
        let record_rows: i64 = device_a
            .query_row("SELECT COUNT(*) FROM pomodoro_records", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(record_rows, 5, "UPSERT by id：事实行不得重复");
    }

    /// 记录换 todo_item_id：旧 todo 归零、新 todo +1（同一次重算内完成）。
    #[test]
    fn td02_record_moved_to_another_todo_rebalances_and_zeroes_empty_todo() {
        let device_a = create_device_db();
        seed_todo(&device_a, "todo-1", "2026-07-01T00:00:00Z");
        seed_todo(&device_a, "todo-2", "2026-07-01T00:00:00Z");
        create_local_work_record(&device_a, "rec-1", "todo-1", "2026-07-01T01:00:00Z");
        assert_eq!(completed_pomodoros(&device_a, "todo-1"), 1);
        assert_eq!(completed_pomodoros(&device_a, "todo-2"), 0);

        let moved = vec![work_record_change(
            "rec-1",
            "todo-2",
            "2026-07-01T01:00:00Z",
            "2026-07-02T00:00:00Z",
            None,
        )];
        SyncManager::apply_downloaded_changes(&device_a, &moved, None).unwrap();

        assert_eq!(
            completed_pomodoros(&device_a, "todo-1"),
            0,
            "失去全部记录的旧 todo 必须归零"
        );
        assert_eq!(completed_pomodoros(&device_a, "todo-2"), 1);
    }

    /// 远端 DELETE 操作（tombstone 传播路径）：对有 deleted_at 列的表写软删，
    /// 重算随后把计数归零。
    #[test]
    fn td02_remote_delete_operation_zeroes_count() {
        let device_a = create_device_db();
        seed_todo(&device_a, "todo-1", "2026-07-01T00:00:00Z");
        create_local_work_record(&device_a, "rec-1", "todo-1", "2026-07-01T01:00:00Z");
        assert_eq!(completed_pomodoros(&device_a, "todo-1"), 1);

        let delete = vec![SyncChangeWithData {
            table_name: "pomodoro_records".to_string(),
            record_id: "rec-1".to_string(),
            operation: ChangeOperation::Delete,
            data: None,
            changed_at: "2026-07-02T00:00:00Z".to_string(),
            change_log_id: None,
            database_name: Some("vfs".to_string()),
            suppress_change_log: Some(true),
            source_device_id: Some("device-remote".to_string()),
            source_seq: Some(9),
        }];
        SyncManager::apply_downloaded_changes(&device_a, &delete, None).unwrap();

        let deleted_at: Option<String> = device_a
            .query_row(
                "SELECT deleted_at FROM pomodoro_records WHERE id = 'rec-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(deleted_at.is_some(), "DELETE 操作应写入软删 tombstone");
        assert_eq!(
            completed_pomodoros(&device_a, "todo-1"),
            0,
            "空记录归零：tombstone 后计数必须清零"
        );
    }

    /// 部分同步：批内一条变更损坏进检疫、其余照常落库时，
    /// 重算只反映实际提交的行集（提交边界语义）。
    #[test]
    fn td02_partial_apply_with_quarantined_change_reflects_committed_rows_only() {
        let device_a = create_device_db();
        seed_todo(&device_a, "todo-1", "2026-07-01T00:00:00Z");

        let mut broken = work_record_change(
            "rec-bad",
            "todo-1",
            "2026-07-01T01:00:00Z",
            "2026-07-01T01:00:00Z",
            None,
        );
        broken.data = Some(json!("not-an-object")); // 损坏 payload → 进检疫
        let batch = vec![
            broken,
            work_record_change(
                "rec-good",
                "todo-1",
                "2026-07-01T02:00:00Z",
                "2026-07-01T02:00:00Z",
                None,
            ),
        ];

        let result = SyncManager::apply_downloaded_changes(&device_a, &batch, None).unwrap();
        assert_eq!(result.success_count, 1);
        assert_eq!(result.failure_count, 1);
        assert_eq!(
            completed_pomodoros(&device_a, "todo-1"),
            1,
            "重算必须只统计实际落库的记录"
        );
    }

    /// 直接调用重算的口径 / 幂等 / 回声抑制不变量：
    /// - 只统计 未删除 + work + completed 且关联 todo 的记录；
    /// - NULL 与漂移的历史缓存值被归正（含归零）；
    /// - 触发器产生的 __change_log 回声被标记为已同步；
    /// - 第二次重算是纯 no-op（不再产生任何变更日志）。
    #[test]
    fn td02_recompute_scope_idempotency_and_echo_suppression() {
        let conn = create_device_db();
        seed_todo(&conn, "todo-1", "2026-07-01T00:00:00Z");
        seed_todo(&conn, "todo-drift", "2026-07-01T00:00:00Z");
        // 历史漂移：缓存为 NULL / 虚高值
        conn.execute(
            "UPDATE todo_items SET completed_pomodoros = NULL WHERE id = 'todo-1'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE todo_items SET completed_pomodoros = 99 WHERE id = 'todo-drift'",
            [],
        )
        .unwrap();

        let insert_record = |id: &str, todo: Option<&str>, ty: &str, status: &str, del: Option<&str>| {
            conn.execute(
                "INSERT INTO pomodoro_records
                     (id, todo_item_id, start_time, duration, actual_duration,
                      type, status, created_at, updated_at, deleted_at)
                 VALUES (?1, ?2, '2026-07-01T01:00:00Z', 1500, 1500, ?3, ?4,
                         '2026-07-01T01:00:00Z', '2026-07-01T01:00:00Z', ?5)",
                params![id, todo, ty, status, del],
            )
            .unwrap();
        };
        insert_record("r-count", Some("todo-1"), "work", "completed", None);
        insert_record("r-interrupted", Some("todo-1"), "work", "interrupted", None);
        insert_record("r-break", Some("todo-1"), "short_break", "completed", None);
        insert_record(
            "r-deleted",
            Some("todo-1"),
            "work",
            "completed",
            Some("2026-07-01T02:00:00Z"),
        );
        insert_record("r-orphan", None, "work", "completed", None);

        // 触发器模拟真实库的 change_log 联动（在数据准备完成后再挂上，
        // 只捕获重算本身产生的 UPDATE），用于验证回声抑制
        conn.execute_batch(
            r#"
            CREATE TRIGGER trg_todo_items_upd AFTER UPDATE ON todo_items
            BEGIN
                INSERT INTO __change_log (table_name, record_id, operation)
                VALUES ('todo_items', NEW.id, 'UPDATE');
            END;
            "#,
        )
        .unwrap();

        recompute_todo_completed_pomodoros(&conn).unwrap();
        assert_eq!(
            completed_pomodoros(&conn, "todo-1"),
            1,
            "只有未删除的 work+completed 记录计数（NULL 缓存被归正）"
        );
        assert_eq!(
            completed_pomodoros(&conn, "todo-drift"),
            0,
            "无记录的虚高缓存必须归零"
        );

        // 回声抑制：重算确实触发了触发器，但产生的条目全部被标记为已同步
        let (total, pending): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN sync_version = 0 THEN 1 ELSE 0 END), 0)
                 FROM __change_log WHERE table_name = 'todo_items'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(total >= 2, "重算应实际更新了两个 todo 行（触发器留痕）");
        assert_eq!(pending, 0, "派生缓存重算不得留下待上传的回声变更");

        // 幂等：第二次重算是纯 no-op
        let log_rows_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM __change_log", [], |row| row.get(0))
            .unwrap();
        recompute_todo_completed_pomodoros(&conn).unwrap();
        let log_rows_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM __change_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(completed_pomodoros(&conn, "todo-1"), 1);
        assert_eq!(
            log_rows_before, log_rows_after,
            "值未变化时重算不得触发任何 UPDATE（churn guard）"
        );
    }

    /// 库形状守卫：对没有 todo/pomodoro 表的库（chat_v2 / mistakes 等）静默跳过。
    #[test]
    fn td02_recompute_skips_databases_without_todo_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE chat_v2_sessions (id TEXT PRIMARY KEY);")
            .unwrap();
        recompute_todo_completed_pomodoros(&conn).unwrap();
    }
}
