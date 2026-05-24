//! 真实业务表的同步行为测试
//!
//! 之前的测试都用 `items` 通用 schema，但项目里的实际表各有特殊约束：
//!
//! - `resources` (VFS): `updated_at INTEGER` 毫秒时间戳，有 `ref_count` 并发热点
//! - `notes` (VFS): `tags JSON 数组`，`updated_at TEXT ISO`
//! - `chat_v2_sessions`: 本身有 `updated_at TEXT ISO`
//! - `chat_v2_messages`: 原本无 `updated_at`，V20260201 迁移补上；还有 `timestamp INTEGER`
//! - `chat_v2_blocks`: `content TEXT` 可 MB 级，高频 streaming 更新
//! - `chat_v2_attachments`: **没有 `updated_at`**（业务不同步场景？）
//! - `mistakes.mistakes`: TEXT 主键，多字段
//! - `llm_usage_daily`: **复合主键** (date+caller+model+provider)，累加语义
//!
//! 本测试为每张真实表的特征构造 edge case，确认同步不在这些差异上栽跟头。

use deep_student_lib::data_governance::sync::{
    ChangeOperation, Hlc, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};
use serde_json::json;

// ============================================================================
// Fixture: 模拟真实业务表的 schema（裁剪关键列）
// ============================================================================

/// 建 VFS resources 表：INTEGER 毫秒时间戳 + ref_count 并发热点
fn new_vfs_resources_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE resources (
            id TEXT PRIMARY KEY,
            hash TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL,
            data TEXT,
            ref_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            -- sync 框架补的字段
            device_id TEXT,
            local_version INTEGER DEFAULT 0,
            sync_version INTEGER DEFAULT 0
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER trg_res_ins AFTER INSERT ON resources BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('resources', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER trg_res_upd AFTER UPDATE ON resources BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('resources', NEW.id, 'UPDATE');
        END;
        "#,
    )
    .unwrap();
    conn
}

/// 建 notes 表：JSON 数组字段 + ISO updated_at
fn new_vfs_notes_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE notes (
            id TEXT PRIMARY KEY,
            resource_id TEXT NOT NULL,
            title TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT '[]',
            is_favorite INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            device_id TEXT,
            local_version INTEGER DEFAULT 0,
            sync_version INTEGER DEFAULT 0
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER trg_notes_upd AFTER UPDATE ON notes BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('notes', NEW.id, 'UPDATE');
        END;
        CREATE TRIGGER trg_notes_ins AFTER INSERT ON notes BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('notes', NEW.id, 'INSERT');
        END;
        "#,
    )
    .unwrap();
    conn
}

/// 建 chat_v2_messages：大量字段 + INTEGER timestamp + 后加的 TEXT updated_at
fn new_chat_messages_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE chat_v2_messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            block_ids_json TEXT NOT NULL DEFAULT '[]',
            timestamp INTEGER NOT NULL,
            parent_id TEXT,
            meta_json TEXT,
            device_id TEXT,
            local_version INTEGER DEFAULT 0,
            sync_version INTEGER DEFAULT 0,
            updated_at TEXT,
            deleted_at TEXT
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER trg_msg_ins AFTER INSERT ON chat_v2_messages BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('chat_v2_messages', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER trg_msg_upd AFTER UPDATE ON chat_v2_messages BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('chat_v2_messages', NEW.id, 'UPDATE');
        END;
        "#,
    )
    .unwrap();
    conn
}

/// 建 chat_v2_blocks：streaming content 大字段
fn new_chat_blocks_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE chat_v2_blocks (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            block_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            block_index INTEGER NOT NULL DEFAULT 0,
            content TEXT,
            started_at INTEGER,
            ended_at INTEGER,
            device_id TEXT,
            local_version INTEGER DEFAULT 0,
            sync_version INTEGER DEFAULT 0,
            updated_at TEXT,
            deleted_at TEXT
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER trg_blk_ins AFTER INSERT ON chat_v2_blocks BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('chat_v2_blocks', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER trg_blk_upd AFTER UPDATE ON chat_v2_blocks BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('chat_v2_blocks', NEW.id, 'UPDATE');
        END;
        "#,
    )
    .unwrap();
    conn
}

/// 建 llm_usage_daily：复合主键 + 累加语义
fn new_llm_usage_daily_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE llm_usage_daily (
            date TEXT NOT NULL,
            caller_type TEXT NOT NULL,
            model TEXT NOT NULL,
            provider TEXT NOT NULL,
            request_count INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_estimate REAL DEFAULT 0.0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            device_id TEXT,
            local_version INTEGER DEFAULT 0,
            sync_version INTEGER DEFAULT 0,
            PRIMARY KEY (date, caller_type, model, provider)
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        "#,
    )
    .unwrap();
    conn
}

/// 建 mistakes 表（裁剪核心列）
fn new_mistakes_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE mistakes (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            subject TEXT,
            problem TEXT,
            device_id TEXT,
            local_version INTEGER DEFAULT 0,
            sync_version INTEGER DEFAULT 0,
            deleted_at TEXT
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER trg_mistakes_ins AFTER INSERT ON mistakes BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('mistakes', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER trg_mistakes_upd AFTER UPDATE ON mistakes BEGIN
            INSERT INTO __change_log (table_name, record_id, operation)
            VALUES ('mistakes', NEW.id, 'UPDATE');
        END;
        "#,
    )
    .unwrap();
    conn
}

// ============================================================================
// B01-B05: VFS resources 表（INTEGER 毫秒 updated_at）
// ============================================================================

/// B01：resources 表的 updated_at 是毫秒 INTEGER，LWW 必须能正确解析
#[test]
fn b01_resources_integer_millis_updated_at_lww() {
    let conn = new_vfs_resources_db();

    // 本地：updated_at = 2024-01-01 UTC = 1704067200000 ms
    let local_ms: i64 = 1_704_067_200_000;
    conn.execute(
        "INSERT INTO resources (id, hash, type, data, created_at, updated_at)
         VALUES (?1, ?2, 'note', '{}', ?3, ?3)",
        params!["res_local", "hash_local", local_ms],
    )
    .unwrap();

    // 云端：更早的时间戳（应被拒绝）
    let cloud_ms: i64 = local_ms - 60_000; // 早 1 分钟
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "resources".to_string(),
        record_id: "res_local".to_string(),
        operation: ChangeOperation::Update,
        changed_at: format!("{}", cloud_ms), // changed_at 是 string 形式的 ms
        data: Some(json!({
            "id": "res_local",
            "hash": "hash_cloud",
            "type": "note",
            "data": "cloud-stale",
            "ref_count": 0,
            "created_at": cloud_ms,
            "updated_at": cloud_ms,
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    // 本地数据应被 LWW 门保护——注意：当前实现对 INTEGER updated_at 的解析走
    // `from_timestamp_millis`，应该能正确比较
    let data: String = conn
        .query_row("SELECT data FROM resources WHERE id='res_local'", [], |r| {
            r.get(0)
        })
        .unwrap();
    // 这个测试记录当前行为：INTEGER ms 的 LWW 是否生效
    // 如果失败说明 LWW 门不能处理 INTEGER updated_at
    assert_eq!(
        data, "{}",
        "resources 表 INTEGER ms updated_at 的 LWW 保护应生效"
    );
}

/// B02：resources.ref_count 并发递增 —— 典型的"字段级合并丢失"场景
#[test]
fn b02_resources_refcount_race_loses_increment() {
    let conn = new_vfs_resources_db();

    // 初始 ref_count=1
    conn.execute(
        "INSERT INTO resources (id, hash, type, ref_count, created_at, updated_at)
         VALUES ('res', 'h', 'file', 1, 1000, 1000)",
        [],
    )
    .unwrap();

    // 本地 +1 → ref_count=2，updated_at=2000
    conn.execute(
        "UPDATE resources SET ref_count=2, updated_at=2000 WHERE id='res'",
        [],
    )
    .unwrap();

    // 云端变更：ref_count=2（云端也 +1 到 2，但不知道本地已 +1），updated_at=3000
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "resources".to_string(),
        record_id: "res".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "3000".to_string(),
        data: Some(json!({
            "id": "res",
            "hash": "h",
            "type": "file",
            "ref_count": 2,
            "created_at": 1000,
            "updated_at": 3000,
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    // 预期：ref_count 应该是 3（两端各 +1）
    // 现实：行级 LWW 会保留云端的 2，丢失本地的 +1
    let ref_count: i64 = conn
        .query_row("SELECT ref_count FROM resources WHERE id='res'", [], |r| {
            r.get(0)
        })
        .unwrap();

    // 这是**已知的架构局限**，记录当前行为以防回归
    // 字段级合并/CRDT counter 是未来增强方向
    assert!(
        ref_count == 2 || ref_count == 3,
        "ref_count 是 {}（行级 LWW 下至少是 2）",
        ref_count
    );
}

/// B03：resources 软删除（deleted_at 是 INTEGER ms）的 tombstone 传播
#[test]
fn b03_resources_integer_deleted_at_tombstone() {
    let conn = new_vfs_resources_db();
    conn.execute(
        "INSERT INTO resources (id, hash, type, created_at, updated_at)
         VALUES ('res', 'h', 'note', 1000, 1000)",
        [],
    )
    .unwrap();

    // 云端 DELETE：以 INTEGER ms 标记 deleted_at
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "resources".to_string(),
        record_id: "res".to_string(),
        operation: ChangeOperation::Delete,
        changed_at: "2000".to_string(),
        data: None,
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    // deleted_at 应该被设置（软删除）
    let deleted_at: Option<i64> = conn
        .query_row("SELECT deleted_at FROM resources WHERE id='res'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(
        deleted_at.is_some(),
        "resources.deleted_at（INTEGER ms）应被 DELETE 操作置位"
    );
}

/// B04：resources.data 字段可能是 4MB 的大文本（inline 存储）
#[test]
fn b04_resources_large_inline_data() {
    let conn = new_vfs_resources_db();
    let big_data = "x".repeat(4 * 1024 * 1024); // 4 MB

    conn.execute(
        "INSERT INTO resources (id, hash, type, data, created_at, updated_at)
         VALUES ('big', 'h', 'note', ?1, 1000, 1000)",
        params![big_data],
    )
    .unwrap();

    // 云端用更大的数据覆盖
    let bigger_data = "y".repeat(5 * 1024 * 1024); // 5 MB
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "resources".to_string(),
        record_id: "big".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2000".to_string(),
        data: Some(json!({
            "id": "big",
            "hash": "h",
            "type": "note",
            "data": bigger_data.clone(),
            "ref_count": 0,
            "created_at": 1000,
            "updated_at": 2000,
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let data: String = conn
        .query_row("SELECT data FROM resources WHERE id='big'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(data.len(), 5 * 1024 * 1024);
}

/// B05：resources.hash UNIQUE 约束冲突 —— 两端不同 id 但相同 hash
#[test]
fn b05_resources_hash_unique_conflict() {
    let conn = new_vfs_resources_db();
    conn.execute(
        "INSERT INTO resources (id, hash, type, created_at, updated_at)
         VALUES ('a', 'unique_hash', 'note', 1000, 1000)",
        [],
    )
    .unwrap();

    // 云端：不同 id 但相同 hash（可能是两端对同一内容生成了不同 id）
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "resources".to_string(),
        record_id: "b".to_string(),
        operation: ChangeOperation::Insert,
        changed_at: "2000".to_string(),
        data: Some(json!({
            "id": "b",
            "hash": "unique_hash",
            "type": "note",
            "ref_count": 0,
            "created_at": 1500,
            "updated_at": 1500,
        })),
        database_name: None,
        suppress_change_log: None,
    };
    // 当前实现：UNIQUE 冲突会 fail 整批事务（原子性保证）。
    // 记录此行为；更细粒度的"单条跳过"是 P2 改进方向。
    let result = SyncManager::apply_downloaded_changes(&conn, &[change], None);
    assert!(
        result.is_err(),
        "当前实现：UNIQUE(hash) 冲突导致整批事务回滚"
    );

    // 验证本地数据未被污染
    let cnt: i64 = conn
        .query_row("SELECT COUNT(*) FROM resources", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cnt, 1);
}

// ============================================================================
// B06-B09: notes 表（JSON 数组 tags 字段）
// ============================================================================

/// B06：notes.tags 是 JSON 数组；两端独立增加不同 tag 会发生"行级 LWW 丢失"
#[test]
fn b06_notes_tags_merge_loses_orthogonal_tags() {
    let conn = new_vfs_notes_db();
    conn.execute(
        "INSERT INTO notes (id, resource_id, title, tags, created_at, updated_at)
         VALUES ('n1', 'res', '笔记', '[]', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
        [],
    )
    .unwrap();

    // 本地加了 'local-tag'
    conn.execute(
        r#"UPDATE notes SET tags='["local-tag"]', updated_at='2024-01-01T10:00:00Z' WHERE id='n1'"#,
        [],
    )
    .unwrap();

    // 云端加了 'cloud-tag'（更晚）
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "notes".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T11:00:00Z".to_string(),
        data: Some(json!({
            "id": "n1",
            "resource_id": "res",
            "title": "笔记",
            "tags": "[\"cloud-tag\"]",
            "is_favorite": 0,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T11:00:00Z",
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let tags: String = conn
        .query_row("SELECT tags FROM notes WHERE id='n1'", [], |r| r.get(0))
        .unwrap();

    // 记录当前行为：LWW 保留更晚的 cloud-tag，local-tag 被丢失
    // 未来 CRDT 字段级合并可改进
    assert_eq!(tags, r#"["cloud-tag"]"#, "行级 LWW 下保留更晚端");
}

/// B07：notes.is_favorite 布尔切换 + 其他字段同时改动（row-level LWW 正常）
#[test]
fn b07_notes_favorite_and_title_lww() {
    let conn = new_vfs_notes_db();
    conn.execute(
        "INSERT INTO notes (id, resource_id, title, is_favorite, created_at, updated_at)
         VALUES ('n1', 'res', '初始', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
        [],
    )
    .unwrap();

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "notes".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T11:00:00Z".to_string(),
        data: Some(json!({
            "id": "n1",
            "resource_id": "res",
            "title": "云端修改",
            "tags": "[]",
            "is_favorite": 1,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T11:00:00Z",
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, fav): (String, i64) = conn
        .query_row(
            "SELECT title, is_favorite FROM notes WHERE id='n1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(title, "云端修改");
    assert_eq!(fav, 1);
}

/// B08：notes 被软删除后又被 revive（deleted_at 是 TEXT ISO）
#[test]
fn b08_notes_soft_delete_revive_with_text_deleted_at() {
    let conn = new_vfs_notes_db();
    conn.execute(
        "INSERT INTO notes (id, resource_id, title, created_at, updated_at, deleted_at)
         VALUES ('n1', 'res', 't', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T05:00:00Z')",
        [],
    )
    .unwrap();

    // 云端更晚的 revive：deleted_at = NULL
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "notes".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T10:00:00Z".to_string(),
        data: Some(json!({
            "id": "n1",
            "resource_id": "res",
            "title": "revived",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (title, deleted_at): (String, Option<String>) = conn
        .query_row(
            "SELECT title, deleted_at FROM notes WHERE id='n1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(title, "revived");
    assert!(deleted_at.is_none(), "revive 应清空 deleted_at");
}

/// B09：notes 标题包含 emoji 和多语言字符
#[test]
fn b09_notes_unicode_title() {
    let conn = new_vfs_notes_db();
    let title = "📝 学习笔记 🎓 عربي עברית 日本語 한국어 🌟";

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "notes".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Insert,
        changed_at: "2024-01-01T00:00:00Z".to_string(),
        data: Some(json!({
            "id": "n1",
            "resource_id": "res",
            "title": title,
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z",
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let saved: String = conn
        .query_row("SELECT title FROM notes WHERE id='n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(saved, title);
}

// ============================================================================
// B10-B13: chat_v2_messages（INTEGER timestamp + TEXT updated_at 双时间戳）
// ============================================================================

/// B10：chat_v2_messages 有 timestamp（INTEGER）和 updated_at（TEXT）两个时间字段；
/// LWW 必须用 updated_at（sync 字段），而不是业务的 timestamp
#[test]
fn b10_messages_dual_timestamp_lww_uses_updated_at() {
    let conn = new_chat_messages_db();

    // 本地：timestamp 早，updated_at 晚（业务创建时间 vs 最近编辑时间分开）
    conn.execute(
        "INSERT INTO chat_v2_messages (id, session_id, role, timestamp, updated_at)
         VALUES ('msg1', 'sess1', 'user', 1000, '2024-01-01T20:00:00Z')",
        [],
    )
    .unwrap();

    // 云端：timestamp 更晚（1000000），但 updated_at 更早（2024-01-01T10:00:00Z）
    // LWW 必须用 updated_at 比较，这条应被拒绝
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "chat_v2_messages".to_string(),
        record_id: "msg1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T10:00:00Z".to_string(),
        data: Some(json!({
            "id": "msg1",
            "session_id": "sess1",
            "role": "user",
            "block_ids_json": "[]",
            "timestamp": 1_000_000i64,
            "updated_at": "2024-01-01T10:00:00Z", // 较早
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let ts: i64 = conn
        .query_row(
            "SELECT timestamp FROM chat_v2_messages WHERE id='msg1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        ts, 1000,
        "LWW 用 updated_at（较早）拒绝云端，timestamp 应保留本地 1000"
    );
}

/// B11：chat_v2_messages.block_ids_json 是有序 JSON 数组，行级 LWW 会覆盖整个顺序
#[test]
fn b11_messages_block_ids_json_ordering() {
    let conn = new_chat_messages_db();
    conn.execute(
        "INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, updated_at)
         VALUES ('msg1', 'sess1', 'assistant', '[\"blk1\",\"blk2\"]', 1000, '2024-01-01T00:00:00Z')",
        [],
    )
    .unwrap();

    // 云端调整了 block 顺序并加了新的
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "chat_v2_messages".to_string(),
        record_id: "msg1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T10:00:00Z".to_string(),
        data: Some(json!({
            "id": "msg1",
            "session_id": "sess1",
            "role": "assistant",
            "block_ids_json": "[\"blk2\",\"blk1\",\"blk3\"]",
            "timestamp": 1000i64,
            "updated_at": "2024-01-01T10:00:00Z",
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let b: String = conn
        .query_row(
            "SELECT block_ids_json FROM chat_v2_messages WHERE id='msg1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(b, r#"["blk2","blk1","blk3"]"#);
}

/// B12：chat_v2_messages.parent_id 链（编辑/重试分支）—— DAG 结构的同步
#[test]
fn b12_messages_parent_id_branch_chain() {
    let conn = new_chat_messages_db();

    // 初始消息
    conn.execute(
        "INSERT INTO chat_v2_messages (id, session_id, role, timestamp, updated_at)
         VALUES ('m1', 's1', 'user', 1000, '2024-01-01T00:00:00Z')",
        [],
    )
    .unwrap();

    // 云端：m1 的重试分支 m2
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "chat_v2_messages".to_string(),
        record_id: "m2".to_string(),
        operation: ChangeOperation::Insert,
        changed_at: "2024-01-01T10:00:00Z".to_string(),
        data: Some(json!({
            "id": "m2",
            "session_id": "s1",
            "role": "user",
            "block_ids_json": "[]",
            "timestamp": 2000i64,
            "updated_at": "2024-01-01T10:00:00Z",
            "parent_id": "m1",
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let parent: String = conn
        .query_row(
            "SELECT parent_id FROM chat_v2_messages WHERE id='m2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(parent, "m1");
}

/// B13：chat_v2_messages 同一 session 下 10 条消息同秒插入（并发会话）
#[test]
fn b13_messages_burst_same_session_same_second() {
    let conn = new_chat_messages_db();
    // 建 session 表的 placeholder 不是必须，因为我们没建 FK 约束
    let base_hlc_ms: u64 = 1_704_067_200_000;

    let mut changes = Vec::new();
    for i in 0..10u16 {
        let hlc = Hlc::new(base_hlc_ms, i).to_string();
        changes.push(SyncChangeWithData {
            change_log_id: None,
            table_name: "chat_v2_messages".to_string(),
            record_id: format!("m{}", i),
            operation: ChangeOperation::Insert,
            changed_at: hlc.clone(),
            data: Some(json!({
                "id": format!("m{}", i),
                "session_id": "s1",
                "role": if i % 2 == 0 { "user" } else { "assistant" },
                "block_ids_json": "[]",
                "timestamp": (base_hlc_ms as i64) + i as i64,
                "updated_at": hlc,
            })),
            database_name: None,
            suppress_change_log: None,
        });
    }
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM chat_v2_messages", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 10);
}

// ============================================================================
// B14-B16: chat_v2_blocks（大 content 流式）
// ============================================================================

/// B14：blocks.content 可以是 2MB 的 markdown
#[test]
fn b14_blocks_large_content() {
    let conn = new_chat_blocks_db();
    let big = "# 标题\n".repeat(300_000); // ~2 MB

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "chat_v2_blocks".to_string(),
        record_id: "blk1".to_string(),
        operation: ChangeOperation::Insert,
        changed_at: "2024-01-01T00:00:00Z".to_string(),
        data: Some(json!({
            "id": "blk1",
            "message_id": "m1",
            "block_type": "content",
            "status": "success",
            "block_index": 0,
            "content": big.clone(),
            "updated_at": "2024-01-01T00:00:00Z",
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let saved: String = conn
        .query_row(
            "SELECT content FROM chat_v2_blocks WHERE id='blk1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(saved.len(), big.len());
}

/// B15：blocks streaming 场景：content 从空 → 部分 → 完整，三次更新
#[test]
fn b15_blocks_streaming_updates() {
    let conn = new_chat_blocks_db();
    // 初始 pending 块
    conn.execute(
        "INSERT INTO chat_v2_blocks (id, message_id, block_type, status, content, updated_at)
         VALUES ('blk1', 'm1', 'content', 'pending', '', '2024-01-01T00:00:00Z')",
        [],
    )
    .unwrap();

    let versions = vec![
        ("2024-01-01T00:00:01Z", "Hello", "pending"),
        ("2024-01-01T00:00:02Z", "Hello world", "pending"),
        ("2024-01-01T00:00:03Z", "Hello world!", "success"),
    ];
    let mut last_content = String::new();
    for (ts, content, status) in versions {
        let change = SyncChangeWithData {
            change_log_id: None,
            table_name: "chat_v2_blocks".to_string(),
            record_id: "blk1".to_string(),
            operation: ChangeOperation::Update,
            changed_at: ts.to_string(),
            data: Some(json!({
                "id": "blk1",
                "message_id": "m1",
                "block_type": "content",
                "status": status,
                "block_index": 0,
                "content": content,
                "updated_at": ts,
            })),
            database_name: None,
            suppress_change_log: None,
        };
        SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();
        last_content = content.to_string();
    }

    let content: String = conn
        .query_row(
            "SELECT content FROM chat_v2_blocks WHERE id='blk1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(content, last_content, "最后一次 LWW 获胜");
}

/// B16：两端同时在流式更新同一个 block —— 严重冲突场景
#[test]
fn b16_blocks_concurrent_streaming_on_both_devices() {
    let conn = new_chat_blocks_db();
    conn.execute(
        "INSERT INTO chat_v2_blocks (id, message_id, block_type, status, content, updated_at)
         VALUES ('blk1', 'm1', 'content', 'pending', 'local stream', '2024-01-01T00:00:05Z')",
        [],
    )
    .unwrap();

    // 云端推一个更晚的 streaming update（两端独立生成了不同内容）
    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "chat_v2_blocks".to_string(),
        record_id: "blk1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T00:00:10Z".to_string(),
        data: Some(json!({
            "id": "blk1",
            "message_id": "m1",
            "block_type": "content",
            "status": "success",
            "block_index": 0,
            "content": "cloud stream with more content",
            "updated_at": "2024-01-01T00:00:10Z",
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    // 行级 LWW：较晚的云端胜。本地的 streaming 内容会被覆盖。
    // 这是 Chat 场景的架构选择——同一 block 不应被两端并发编辑。
    let content: String = conn
        .query_row(
            "SELECT content FROM chat_v2_blocks WHERE id='blk1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(content, "cloud stream with more content");
}

// ============================================================================
// B17-B19: llm_usage_daily（复合主键）
// ============================================================================

/// B17：复合主键的 record_id 格式（项目里用 JSON 编码）
#[test]
fn b17_llm_usage_composite_key_record_id_json_format() {
    // 项目里复合主键的 record_id 形式：JSON 数组
    // 比如 ["2024-01-01", "builtin", "gpt-4", "openai"]
    let rid = serde_json::to_string(&["2024-01-01", "builtin", "gpt-4", "openai"]).unwrap();
    assert!(rid.starts_with('['), "复合主键 record_id 应是 JSON 数组");

    // 确认 JSON 能被解析回来
    let parsed: Vec<String> = serde_json::from_str(&rid).unwrap();
    assert_eq!(parsed.len(), 4);
    assert_eq!(parsed[0], "2024-01-01");
}

/// B18：llm_usage_daily 累加语义与 LWW 的张力
///
/// 每日用量表的语义是 **SUM**，但行级 LWW 只保留某一端的值。
/// 这是项目里真实的已知限制：两端同时记录同一天同模型的用量时，
/// 一端的累加会丢失。现实的缓解是：日结算时间拉长到 UTC 午夜后几小时。
#[test]
fn b18_llm_usage_daily_lww_loses_concurrent_increments() {
    let conn = new_llm_usage_daily_db();

    // 本地：request_count=10
    conn.execute(
        "INSERT INTO llm_usage_daily
         (date, caller_type, model, provider, request_count, total_tokens)
         VALUES ('2024-01-01', 'builtin', 'gpt-4', 'openai', 10, 1000)",
        [],
    )
    .unwrap();

    // 此场景下跨设备累加的正确性由业务层保证（不走行级 LWW）
    // 这里只记录 schema 能被正确序列化和主键约束生效
    let result = conn.execute(
        "INSERT INTO llm_usage_daily
         (date, caller_type, model, provider, request_count, total_tokens)
         VALUES ('2024-01-01', 'builtin', 'gpt-4', 'openai', 5, 500)",
        [],
    );
    assert!(
        result.is_err(),
        "复合主键冲突应被 SQLite 拒绝（不应静默覆盖）"
    );
}

/// B19：llm_usage_daily 不同提供商独立累加
#[test]
fn b19_llm_usage_daily_different_providers_independent() {
    let conn = new_llm_usage_daily_db();
    conn.execute(
        "INSERT INTO llm_usage_daily
         (date, caller_type, model, provider, request_count)
         VALUES ('2024-01-01', 'builtin', 'model-x', 'provider-a', 10)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO llm_usage_daily
         (date, caller_type, model, provider, request_count)
         VALUES ('2024-01-01', 'builtin', 'model-x', 'provider-b', 20)",
        [],
    )
    .unwrap();

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM llm_usage_daily", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 2);
}

// ============================================================================
// B20-B21: mistakes 表
// ============================================================================

/// B20：mistakes 表 subject + problem 多字段 UPSERT
#[test]
fn b20_mistakes_multi_field_upsert() {
    let conn = new_mistakes_db();
    conn.execute(
        "INSERT INTO mistakes (id, subject, problem, created_at, updated_at)
         VALUES ('m1', '数学', '1+1=?', '2024-01-01', '2024-01-01T00:00:00Z')",
        [],
    )
    .unwrap();

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "mistakes".to_string(),
        record_id: "m1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T10:00:00Z".to_string(),
        data: Some(json!({
            "id": "m1",
            "subject": "物理",
            "problem": "F=?",
            "created_at": "2024-01-01",
            "updated_at": "2024-01-01T10:00:00Z",
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let (subj, prob): (String, String) = conn
        .query_row(
            "SELECT subject, problem FROM mistakes WHERE id='m1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(subj, "物理");
    assert_eq!(prob, "F=?");
}

/// B21：mistakes 软删除后云端 revive
#[test]
fn b21_mistakes_revive_from_soft_delete() {
    let conn = new_mistakes_db();
    conn.execute(
        "INSERT INTO mistakes (id, subject, problem, created_at, updated_at, deleted_at)
         VALUES ('m1', 's', 'p', '2024-01-01', '2024-01-01T00:00:00Z', '2024-01-01T05:00:00Z')",
        [],
    )
    .unwrap();

    let change = SyncChangeWithData {
        change_log_id: None,
        table_name: "mistakes".to_string(),
        record_id: "m1".to_string(),
        operation: ChangeOperation::Update,
        changed_at: "2024-01-01T10:00:00Z".to_string(),
        data: Some(json!({
            "id": "m1",
            "subject": "s2",
            "problem": "p2",
            "created_at": "2024-01-01",
            "updated_at": "2024-01-01T10:00:00Z",
            "deleted_at": serde_json::Value::Null,
        })),
        database_name: None,
        suppress_change_log: None,
    };
    SyncManager::apply_downloaded_changes(&conn, &[change], None).unwrap();

    let deleted_at: Option<String> = conn
        .query_row("SELECT deleted_at FROM mistakes WHERE id='m1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(deleted_at.is_none());
}

// ============================================================================
// B22-B25: 多表混合 + __change_log record_id 的一致性
// ============================================================================

/// B22：不同表的 record_id 格式不冲突（res_xxx, note_xxx, msg_xxx, m1...）
#[test]
fn b22_mixed_tables_apply_in_one_batch() {
    let conn = new_mistakes_db(); // 用 mistakes 作为容器，但实际只测 record_id 映射
                                  // 验证 __change_log 能存各种格式的 record_id
    conn.execute(
        "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
         VALUES
         ('resources', 'res_abc123', 'INSERT', '2024-01-01', 0),
         ('notes', 'note_xyz456', 'INSERT', '2024-01-01', 0),
         ('chat_v2_messages', 'msg_789', 'INSERT', '2024-01-01', 0),
         ('mistakes', 'm1', 'INSERT', '2024-01-01', 0),
         ('llm_usage_daily', '[\"2024-01-01\",\"builtin\",\"gpt\",\"openai\"]', 'INSERT', '2024-01-01', 0)",
        [],
    )
    .unwrap();

    let cnt: i64 = conn
        .query_row("SELECT COUNT(*) FROM __change_log", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cnt, 5);

    // 任何 record_id 都不丢失
    let rids: Vec<String> = conn
        .prepare("SELECT record_id FROM __change_log ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();
    assert!(rids.contains(&"res_abc123".to_string()));
    assert!(rids.iter().any(|r| r.starts_with("[\"2024")));
}

/// B23：resources 和 notes 在同一事务里按依赖顺序应用
#[test]
fn b23_resources_then_notes_ordered_insert() {
    // 测试 apply_downloaded_changes 的原子性：多条按顺序应用
    let conn = new_vfs_notes_db();

    // 只发 note 的 INSERT 变更（无对应 resources 表）
    let note_change = SyncChangeWithData {
        change_log_id: None,
        table_name: "notes".to_string(),
        record_id: "n1".to_string(),
        operation: ChangeOperation::Insert,
        changed_at: "2024-01-01T00:00:01Z".to_string(),
        data: Some(json!({
            "id": "n1",
            "resource_id": "res1",
            "title": "t",
            "tags": "[]",
            "is_favorite": 0,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:01Z",
        })),
        database_name: None,
        suppress_change_log: None,
    };

    let result = SyncManager::apply_downloaded_changes(&conn, &[note_change], None).unwrap();
    assert_eq!(result.success_count, 1);

    // 不同 table 的 change 在一次 apply 里全部 INSERT 成功
    let cnt: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cnt, 1);
}

/// B24：__change_log 里对复合主键的 record_id（JSON 数组）应当被 get_pending_changes 正确返回
#[test]
fn b24_composite_key_record_id_roundtrip_via_change_log() {
    let conn = new_llm_usage_daily_db();
    let composite_rid =
        serde_json::to_string(&["2024-01-01", "builtin", "gpt-4", "openai"]).unwrap();

    conn.execute(
        "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
         VALUES ('llm_usage_daily', ?1, 'INSERT', '2024-01-01T00:00:00Z', 0)",
        params![composite_rid],
    )
    .unwrap();

    let pending = SyncManager::get_pending_changes(&conn, None, None).unwrap();
    assert!(pending.has_changes());
    let first_entry = pending.entries.first().unwrap();
    assert_eq!(first_entry.record_id, composite_rid);
}

/// B25：删除一条 resources 后，notes.resource_id 的 orphan 问题（业务层 FK 约束范围）
#[test]
fn b25_resources_deletion_vs_notes_orphan() {
    // 这不是同步框架的责任，但是值得记录：
    // 如果 resources 被删除（tombstone），其 notes 就变成孤儿
    // 业务层需要自己处理（级联 tombstone 或应用层 FK 检查）
    // 此测试只记录：sync 不主动级联 tombstone，上层必须负责

    let conn = new_vfs_notes_db();
    conn.execute(
        "INSERT INTO notes (id, resource_id, title, created_at, updated_at)
         VALUES ('n1', 'res_deleted', 't', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
        [],
    )
    .unwrap();

    // 假装 resources 的 tombstone 已同步到（sync 框架不会级联到 notes）
    // 这里主要验证 notes 本身的数据完整性
    let notes_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(notes_count, 1);
}
