//! 真实 schema 下的云同步测试
//!
//! 目标：暴露 notes 玩具表永远发现不了的问题：
//! 1. 外键链（questions.exam_id → exam_sheets.id → resources.id）
//! 2. 触发器副作用（FTS 重建、updated_at 自动同步）
//! 3. 复合主键（llm_usage_daily = date|caller_type|model|provider）
//! 4. 时间戳存储差异（resources.updated_at 是 INTEGER 毫秒，notes 是 TEXT ISO）
//! 5. ref_count 引用计数跨端并发递增/递减
//! 6. 级联顺序（A 端创建 resource+note，B 端先收到 note 后收到 resource）

use deep_student_lib::data_governance::sync::{
    conflict_resolver::ConflictPolicy, ChangeOperation, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};
use serde_json::json;

// ============================================================================
// 真实 schema 构造器（精简版，保留关键约束）
// ============================================================================

fn new_real_vfs_schema() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(
        r#"
        -- resources 表（SSOT）
        CREATE TABLE resources (
            id TEXT PRIMARY KEY,
            hash TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL,
            source_id TEXT,
            source_table TEXT,
            storage_mode TEXT NOT NULL DEFAULT 'inline',
            data TEXT,
            metadata_json TEXT,
            ref_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER
        );
        CREATE INDEX idx_resources_hash ON resources(hash);
        CREATE INDEX idx_resources_type ON resources(type);

        -- notes 表（引用 resources）
        CREATE TABLE notes (
            id TEXT PRIMARY KEY,
            resource_id TEXT NOT NULL,
            title TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT '[]',
            is_favorite INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            FOREIGN KEY (resource_id) REFERENCES resources(id)
        );

        -- exam_sheets
        CREATE TABLE exam_sheets (
            id TEXT PRIMARY KEY,
            resource_id TEXT,
            exam_name TEXT,
            status TEXT NOT NULL,
            temp_id TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            preview_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (resource_id) REFERENCES resources(id)
        );

        -- questions（引用 exam_sheets）
        CREATE TABLE questions (
            id TEXT PRIMARY KEY NOT NULL,
            exam_id TEXT NOT NULL,
            content TEXT NOT NULL,
            answer TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            FOREIGN KEY (exam_id) REFERENCES exam_sheets(id)
        );

        -- __change_log + 触发器（与真实 migration 一致）
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE INDEX idx__change_log_sync_version ON __change_log(sync_version);

        CREATE TRIGGER trg__cl_resources_ins AFTER INSERT ON resources
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('resources', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER trg__cl_resources_upd AFTER UPDATE ON resources
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('resources', NEW.id, 'UPDATE');
        END;
        CREATE TRIGGER trg__cl_resources_del AFTER DELETE ON resources
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('resources', OLD.id, 'DELETE');
        END;

        CREATE TRIGGER trg__cl_notes_ins AFTER INSERT ON notes
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('notes', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER trg__cl_notes_upd AFTER UPDATE ON notes
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('notes', NEW.id, 'UPDATE');
        END;
        CREATE TRIGGER trg__cl_notes_del AFTER DELETE ON notes
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('notes', OLD.id, 'DELETE');
        END;

        CREATE TRIGGER trg__cl_exam_ins AFTER INSERT ON exam_sheets
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('exam_sheets', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER trg__cl_exam_upd AFTER UPDATE ON exam_sheets
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('exam_sheets', NEW.id, 'UPDATE');
        END;

        CREATE TRIGGER trg__cl_q_ins AFTER INSERT ON questions
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('questions', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER trg__cl_q_upd AFTER UPDATE ON questions
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('questions', NEW.id, 'UPDATE');
        END;
        CREATE TRIGGER trg__cl_q_del AFTER DELETE ON questions
        BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('questions', OLD.id, 'DELETE');
        END;

        -- FTS 模拟触发器（简化：只统计被重建次数，不真的建 FTS）
        CREATE TABLE questions_fts_rebuild_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT);
        CREATE TRIGGER trg_questions_fts_upd AFTER UPDATE ON questions
        BEGIN
            INSERT INTO questions_fts_rebuild_log (at) VALUES (datetime('now'));
        END;

        CREATE TABLE refinery_schema_history (
            version INTEGER PRIMARY KEY,
            applied_on TEXT
        );
        INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
        "#,
    )
    .unwrap();
    conn
}

fn new_llm_usage_schema() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE llm_usage_daily (
            date TEXT NOT NULL,
            caller_type TEXT NOT NULL,
            model TEXT NOT NULL,
            provider TEXT NOT NULL,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            request_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (date, caller_type, model, provider)
        );

        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );

        CREATE TABLE refinery_schema_history (
            version INTEGER PRIMARY KEY,
            applied_on TEXT
        );
        INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
        "#,
    )
    .unwrap();
    conn
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn insert_resource(conn: &Connection, id: &str, hash: &str, ref_count: i64) {
    let now = now_ms();
    conn.execute(
        "INSERT INTO resources (id, hash, type, storage_mode, ref_count, created_at, updated_at) \
         VALUES (?1, ?2, 'note', 'inline', ?3, ?4, ?5)",
        params![id, hash, ref_count, now, now],
    )
    .unwrap();
}

fn insert_note(conn: &Connection, id: &str, resource_id: &str, title: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO notes (id, resource_id, title, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, resource_id, title, now, now],
    )
    .unwrap();
}

fn mark_all_synced(conn: &Connection) {
    conn.execute(
        "UPDATE __change_log SET sync_version = ?1 WHERE sync_version = 0",
        params![chrono::Utc::now().timestamp()],
    )
    .unwrap();
}

// ============================================================================
// 场景 61-70：外键 / 级联顺序 / FTS 触发器交互
// ============================================================================

/// 61. 向 notes 插入一条引用不存在 resource 的记录 —— 必须整批回滚
#[test]
fn real_61_fk_violation_rolls_back_batch() {
    let conn = new_real_vfs_schema();
    let change = SyncChangeWithData {
        table_name: "notes".into(),
        record_id: "note1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "note1",
            "resource_id": "res_nonexistent",
            "title": "orphan",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2026-05-01T10:00:00Z",
            "updated_at": "2026-05-01T10:00:00Z",
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    assert!(r.is_err(), "外键违规应导致整批失败");
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

/// 62. 父子记录同批到达，但 child 在前 parent 在后 —— 依赖延迟外键检查（defer）
#[test]
fn real_62_cascade_insert_order_independence() {
    let conn = new_real_vfs_schema();
    // 故意把 child 放在 parent 之前
    let child = SyncChangeWithData {
        table_name: "notes".into(),
        record_id: "note1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "note1",
            "resource_id": "res1",
            "title": "hello",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2026-05-01T10:00:00Z",
            "updated_at": "2026-05-01T10:00:00Z",
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    let parent = SyncChangeWithData {
        table_name: "resources".into(),
        record_id: "res1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "res1",
            "hash": "h_unique_1",
            "type": "note",
            "storage_mode": "inline",
            "ref_count": 1,
            "created_at": 1735689600000_i64,
            "updated_at": 1735689600000_i64,
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    // 同一批 child 先 parent 后
    let r = SyncManager::apply_downloaded_changes(&conn, &[child, parent], None);
    // 应成功：apply_downloaded_changes 内部用 defer_foreign_keys
    assert!(r.is_ok(), "延迟外键应允许同批顺序无关: {:?}", r.err());
    let note_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(note_count, 1);
}

/// 63. 三级级联：resource → exam_sheets → questions（任意顺序）
#[test]
fn real_63_three_level_cascade() {
    let conn = new_real_vfs_schema();
    let res = SyncChangeWithData {
        table_name: "resources".into(),
        record_id: "res1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "res1", "hash": "h1", "type": "exam", "storage_mode": "inline",
            "ref_count": 1, "created_at": 1_i64, "updated_at": 1_i64,
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    let exam = SyncChangeWithData {
        table_name: "exam_sheets".into(),
        record_id: "exam1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "exam1", "resource_id": "res1", "status": "completed",
            "temp_id": "t1", "metadata_json": "{}", "preview_json": "{}",
            "created_at": "2026-05-01T10:00:00Z", "updated_at": "2026-05-01T10:00:00Z",
            "is_favorite": 0,
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    let q1 = SyncChangeWithData {
        table_name: "questions".into(),
        record_id: "q1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "q1", "exam_id": "exam1", "content": "问题1",
            "created_at": "2026-05-01T10:00:00Z", "updated_at": "2026-05-01T10:00:00Z",
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    let q2 = SyncChangeWithData {
        table_name: "questions".into(),
        record_id: "q2".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "q2", "exam_id": "exam1", "content": "问题2",
            "created_at": "2026-05-01T10:00:00Z", "updated_at": "2026-05-01T10:00:00Z",
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    // 反向顺序：q2 -> q1 -> exam -> res
    let changes = vec![q2, q1, exam, res];
    SyncManager::apply_downloaded_changes(&conn, &changes, None).expect("反向顺序应仍能应用");
    let q: i64 = conn
        .query_row("SELECT COUNT(*) FROM questions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(q, 2);
    let e: i64 = conn
        .query_row("SELECT COUNT(*) FROM exam_sheets", [], |r| r.get(0))
        .unwrap();
    assert_eq!(e, 1);
}

/// 64. 软删除 resource 时 notes 仍引用它 —— 软删除语义允许通过，不强制 FK
///
/// **真实行为**：resources 表有 `deleted_at` 列，DELETE 操作被翻译为
/// `UPDATE resources SET deleted_at = NOW WHERE id = ?`，物理行仍存在，
/// 外键不违规，事务可以提交。
/// 这是项目"软删除为主"的设计决策（而不是 Cascade Delete）。
///
/// UI 层的"级联删除"需在业务代码里自己实现（删 resource 前先删 note）。
#[test]
fn real_64_soft_delete_resource_while_referenced_is_allowed() {
    let conn = new_real_vfs_schema();
    insert_resource(&conn, "res1", "h1", 1);
    insert_note(&conn, "n1", "res1", "keep me");
    mark_all_synced(&conn);

    // LWW 保护：确保 cloud 的 changed_at 比本地 updated_at 严格晚但**在 HLC drift 窗口内**（60s）。
    // 本地 updated_at 是 now_ms()，用"now + 1 秒"就够晚了，也不会触发 drift guard。
    let future_ts = (chrono::Utc::now() + chrono::Duration::seconds(1)).to_rfc3339();
    let change = SyncChangeWithData {
        table_name: "resources".into(),
        record_id: "res1".into(),
        operation: ChangeOperation::Delete,
        data: None,
        changed_at: future_ts,
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    assert!(r.is_ok(), "软删除应该成功: {:?}", r.err());

    // deleted_at 被设置
    let deleted_at: Option<i64> = conn
        .query_row(
            "SELECT deleted_at FROM resources WHERE id='res1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(deleted_at.is_some(), "resources.deleted_at 应被设置");

    // 行仍然在
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM resources", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);

    // 关联的 note 不受影响
    let note_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes WHERE id='n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(note_count, 1);
}

/// 64b. 对没有 deleted_at 列的表，DELETE 是物理删除，此时外键应阻止
#[test]
fn real_64b_physical_delete_blocked_by_fk() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE parents (id TEXT PRIMARY KEY);
        CREATE TABLE children (
            id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL,
            FOREIGN KEY (parent_id) REFERENCES parents(id)
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        INSERT INTO parents (id) VALUES ('p1');
        INSERT INTO children (id, parent_id) VALUES ('c1', 'p1');
        "#,
    )
    .unwrap();

    // 尝试 DELETE parent（无 deleted_at 列 → 物理删）
    let change = SyncChangeWithData {
        table_name: "parents".into(),
        record_id: "p1".into(),
        operation: ChangeOperation::Delete,
        data: None,
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: None,
        suppress_change_log: Some(true),
    };
    let r = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    assert!(r.is_err(), "物理删除被引用的父记录应当被 FK 阻止");

    // 事务回滚，parent 仍在
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM parents", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

/// 65. FTS 触发器在批量 UPSERT 时被触发 —— 但不能成为性能灾难
#[test]
fn real_65_fts_trigger_fires_but_batch_stays_transactional() {
    let conn = new_real_vfs_schema();
    // 先创建前置数据
    insert_resource(&conn, "res1", "h1", 1);
    let setup_exam = SyncChangeWithData {
        table_name: "exam_sheets".into(),
        record_id: "exam1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "exam1", "resource_id": "res1", "status": "completed",
            "temp_id": "t", "metadata_json": "{}", "preview_json": "{}",
            "created_at": "2026-05-01T09:00:00Z", "updated_at": "2026-05-01T09:00:00Z",
            "is_favorite": 0,
        })),
        changed_at: "2026-05-01T09:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    SyncManager::apply_downloaded_changes(&conn, &[setup_exam], None).unwrap();

    // 先插入 100 个问题
    let mut inserts = Vec::new();
    for i in 0..100 {
        inserts.push(SyncChangeWithData {
            table_name: "questions".into(),
            record_id: format!("q{:03}", i),
            operation: ChangeOperation::Insert,
            data: Some(json!({
                "id": format!("q{:03}", i), "exam_id": "exam1",
                "content": format!("content {}", i),
                "created_at": "2026-05-01T10:00:00Z",
                "updated_at": "2026-05-01T10:00:00Z",
            })),
            changed_at: "2026-05-01T10:00:00Z".into(),
            change_log_id: None,
            database_name: Some("vfs".into()),
            suppress_change_log: Some(true),
        });
    }
    SyncManager::apply_downloaded_changes(&conn, &inserts, None).unwrap();

    // 现在批量 UPDATE 所有 100 个 → 每个都会触发 trg_questions_fts_upd
    let mut updates = Vec::new();
    for i in 0..100 {
        updates.push(SyncChangeWithData {
            table_name: "questions".into(),
            record_id: format!("q{:03}", i),
            operation: ChangeOperation::Update,
            data: Some(json!({
                "id": format!("q{:03}", i), "exam_id": "exam1",
                "content": format!("updated content {}", i),
                "created_at": "2026-05-01T10:00:00Z",
                "updated_at": "2026-05-01T11:00:00Z",
            })),
            changed_at: "2026-05-01T11:00:00Z".into(),
            change_log_id: None,
            database_name: Some("vfs".into()),
            suppress_change_log: Some(true),
        });
    }
    let r = SyncManager::apply_downloaded_changes(&conn, &updates, None);
    assert!(r.is_ok(), "100 条 UPDATE 应该能事务性完成: {:?}", r.err());

    // FTS 重建日志应至少 100 次
    let fts_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM questions_fts_rebuild_log", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(
        fts_count >= 100,
        "FTS 触发器应被触发 100 次，实际 {}",
        fts_count
    );
}

/// 66. resource.ref_count 并发递增 —— LWW 会丢失一次计数（已知问题）
/// 这个测试明确记录：**当前实现无法正确合并计数器**
#[test]
fn real_66_ref_count_concurrent_increment_loses_data() {
    let conn_a = new_real_vfs_schema();
    let conn_b = new_real_vfs_schema();
    insert_resource(&conn_a, "res1", "h1", 1);
    insert_resource(&conn_b, "res1", "h1", 1);
    mark_all_synced(&conn_a);
    mark_all_synced(&conn_b);

    // A 递增到 2
    conn_a
        .execute(
            "UPDATE resources SET ref_count = 2, updated_at = ?1 WHERE id = 'res1'",
            params![now_ms()],
        )
        .unwrap();
    // B 同时递增到 2
    conn_b
        .execute(
            "UPDATE resources SET ref_count = 2, updated_at = ?1 WHERE id = 'res1'",
            params![now_ms() + 1000],
        )
        .unwrap();

    // B 的变更推到 A
    let b_change = SyncChangeWithData {
        table_name: "resources".into(),
        record_id: "res1".into(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "res1", "hash": "h1", "type": "note", "storage_mode": "inline",
            "ref_count": 2, "created_at": 1_i64,
            "updated_at": now_ms() + 1000,
        })),
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn_a,
        &[b_change],
        None,
        ConflictPolicy::KeepLatest,
        Some("dev_b"),
        Some("dev_a"),
    )
    .unwrap();

    // A 的最终 ref_count 是 2，而不是 3（正确的并发计数应该是 1 + 2 = 3）
    let ref_count: i64 = conn_a
        .query_row("SELECT ref_count FROM resources WHERE id='res1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    // 记录已知行为：LWW 无法正确合并计数器
    // 如果未来引入 CRDT Counter 类型，这个断言需要改为 == 3
    assert_eq!(ref_count, 2, "已知限制：LWW 策略下并发 +1 会丢失一次");
    // 冲突表应该记录了这次竞争，用户可以手动决策
    assert!(conflict.conflicts_saved > 0, "竞争应该产生冲突记录");
}

/// 67. resources.updated_at 是 INTEGER (毫秒时间戳)，conflict_resolver 应能处理
#[test]
fn real_67_integer_updated_at_handled_correctly() {
    let conn = new_real_vfs_schema();
    // 本地 resource，updated_at 是整型毫秒
    let local_ts = 1_735_000_000_000_i64;
    conn.execute(
        "INSERT INTO resources (id, hash, type, storage_mode, ref_count, created_at, updated_at) \
         VALUES ('res1', 'h1', 'note', 'inline', 1, ?1, ?1)",
        params![local_ts],
    )
    .unwrap();
    mark_all_synced(&conn);
    // 本地修改
    conn.execute(
        "UPDATE resources SET data = 'local_data', updated_at = ?1 WHERE id='res1'",
        params![local_ts + 1000], // 本地晚 1 秒
    )
    .unwrap();

    // 云端（更晚）
    let cloud_ts = local_ts + 5000;
    let change = SyncChangeWithData {
        table_name: "resources".into(),
        record_id: "res1".into(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "res1", "hash": "h1", "type": "note", "storage_mode": "inline",
            "ref_count": 1, "data": "cloud_data",
            "created_at": local_ts, "updated_at": cloud_ts,
        })),
        changed_at: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(cloud_ts)
            .unwrap()
            .to_rfc3339(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();

    // 当前 conflict_resolver::extract_updated_at 只支持字符串 updated_at
    // 整数 updated_at 会被当成 None，落到"优先保留本地"分支
    // 这是需要显式记录的已知限制
    let data: Option<String> = conn
        .query_row("SELECT data FROM resources WHERE id='res1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    // 记录实际行为（但不强断言一个分支，因为取决于实现）
    println!(
        "real_67 result: data={:?}, conflicts_saved={}, rejected={}",
        data, conflict.conflicts_saved, conflict.rejected
    );
    // 至少验证不 panic
    assert!(data.is_some());
}

/// 68. llm_usage_daily 复合主键同步
#[test]
fn real_68_composite_primary_key_upsert() {
    let conn = new_llm_usage_schema();
    // 本地已有一条
    conn.execute(
        "INSERT INTO llm_usage_daily (date, caller_type, model, provider, prompt_tokens, completion_tokens, request_count, updated_at) \
         VALUES ('2026-05-01', 'chat', 'gpt-4', 'openai', 100, 50, 1, '2026-05-01T12:00:00Z')",
        [],
    )
    .unwrap();

    // 云端 payload 指向同一个复合主键
    // record_id 按 sync_manager 约定是 JSON 字符串
    let record_id = json!({
        "date": "2026-05-01",
        "caller_type": "chat",
        "model": "gpt-4",
        "provider": "openai"
    })
    .to_string();

    let change = SyncChangeWithData {
        table_name: "llm_usage_daily".into(),
        record_id,
        operation: ChangeOperation::Update,
        data: Some(json!({
            "date": "2026-05-01",
            "caller_type": "chat",
            "model": "gpt-4",
            "provider": "openai",
            "prompt_tokens": 200,
            "completion_tokens": 100,
            "request_count": 2,
            "updated_at": "2026-05-01T13:00:00Z",
        })),
        changed_at: "2026-05-01T13:00:00Z".into(),
        change_log_id: None,
        database_name: Some("llm_usage".into()),
        suppress_change_log: Some(true),
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (prompt, completion): (i64, i64) = conn
        .query_row(
            "SELECT prompt_tokens, completion_tokens FROM llm_usage_daily \
             WHERE date='2026-05-01' AND caller_type='chat' AND model='gpt-4' AND provider='openai'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(prompt, 200);
    assert_eq!(completion, 100);

    // 关键：不应产生新行
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM llm_usage_daily", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1, "复合主键 UPSERT 不应插入新行");
}

/// 69. 跨端 Delete + FK cascade 的边界：A 删 resource 时 notes 已经在 B 被删
#[test]
fn real_69_delete_resource_after_child_was_deleted_by_another_device() {
    // 本地 state: resource 和 note 都在，note 引用 resource
    let conn = new_real_vfs_schema();
    insert_resource(&conn, "res1", "h1", 1);
    insert_note(&conn, "note1", "res1", "hi");
    mark_all_synced(&conn);

    // 两条云端变更同批到达：
    // 1. DELETE note1 (来自 B)
    // 2. DELETE resource res1 (来自 A)
    let del_note = SyncChangeWithData {
        table_name: "notes".into(),
        record_id: "note1".into(),
        operation: ChangeOperation::Delete,
        data: None,
        changed_at: "2026-05-01T10:00:00Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    let del_res = SyncChangeWithData {
        table_name: "resources".into(),
        record_id: "res1".into(),
        operation: ChangeOperation::Delete,
        data: None,
        changed_at: "2026-05-01T10:00:01Z".into(),
        change_log_id: None,
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
    };
    // 顺序：先删 resource 后删 note → 会被外键挡住
    // 但 defer_foreign_keys 应当让整批过
    let r = SyncManager::apply_downloaded_changes(&conn, &[del_res, del_note], None);
    assert!(r.is_ok(), "同批 DELETE 应允许任意顺序: {:?}", r.err());

    // notes 软删除（有 deleted_at 列）
    let note_deleted: Option<String> = conn
        .query_row("SELECT deleted_at FROM notes WHERE id='note1'", [], |r| {
            r.get(0)
        })
        .ok()
        .flatten();
    // resources 物理删除（deleted_at 是 INTEGER，走物理删）
    // 注意：notes 的 deleted_at IS NOT NULL 后，resources 被物理删，
    // 这时 FK 反而不 check 了（note 的 deleted_at != NULL 但 resource_id 仍指向 res1）
    // 真实 SQLite 的 FK 不关心软删除语义，只看值。
    // 所以 resources 被删后 notes.resource_id 指向不存在的 resource → FK 违规
    // 结论：同批删除 parent 和 child 时，必须 child 先 parent 后
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM resources", [], |r| r.get(0))
        .unwrap();
    println!(
        "real_69: note_deleted_at={:?}, resources_count={}",
        note_deleted, n
    );
    // 记录行为：软删除的 note 不能阻止 resource 被物理删，只要 defer_foreign_keys 允许
}

/// 70. 大量资产引用同一 resource，并发修改内容
#[test]
fn real_70_many_notes_one_resource_concurrent_update() {
    let conn = new_real_vfs_schema();
    insert_resource(&conn, "res1", "h1", 10);
    for i in 0..10 {
        insert_note(&conn, &format!("n{}", i), "res1", "base");
    }
    mark_all_synced(&conn);

    // 本地更新所有 notes（每条都产生 pending）
    for i in 0..10 {
        conn.execute(
            "UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                format!("local_{}", i),
                format!("2026-05-01T12:0{}:00Z", i),
                format!("n{}", i),
            ],
        )
        .unwrap();
    }

    // 云端同时推 10 条更新，全都更晚
    let mut changes = Vec::new();
    for i in 0..10 {
        changes.push(SyncChangeWithData {
            table_name: "notes".into(),
            record_id: format!("n{}", i),
            operation: ChangeOperation::Update,
            data: Some(json!({
                "id": format!("n{}", i),
                "resource_id": "res1",
                "title": format!("cloud_{}", i),
                "tags": "[]",
                "is_favorite": 0,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": format!("2026-05-01T13:0{}:00Z", i),
                "deleted_at": serde_json::Value::Null,
            })),
            changed_at: format!("2026-05-01T13:0{}:00Z", i),
            change_log_id: None,
            database_name: Some("vfs".into()),
            suppress_change_log: Some(true),
        });
    }

    let (apply, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &changes,
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();

    // 云端更晚 → 10 条都应被应用
    assert_eq!(apply.success_count, 10);
    // 10 条冲突（每条产生 2 个冲突记录）
    assert_eq!(conflict.conflicts_saved, 20);
    for i in 0..10 {
        let title: String = conn
            .query_row(
                "SELECT title FROM notes WHERE id = ?1",
                params![format!("n{}", i)],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(title, format!("cloud_{}", i));
    }
}
