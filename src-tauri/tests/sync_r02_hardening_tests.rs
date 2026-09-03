//! R02 引擎加固回归测试（补强版）
//!
//! 针对 R02 合入的四项引擎修复,在 `sync/mod.rs` 单元回归之外补一层
//! 集成粒度的验证(不经 Tauri runtime,直接调 `SyncManager` 公开 API):
//!
//! 1. 双设备 tag 并集收敛:两台设备**都有本地 pending 修改**时交换变更,
//!    一端走 Cloud 胜(强制应用 + 字段级合并),另一端走 Local 胜(安全字段折叠),
//!    两端必须收敛到同一个排序后的 tag 并集。
//! 2. Local 胜折叠后,折叠字段必须出现在**下一轮上传 payload** 里
//!    (触发器照常记 pending,`get_pending_changes` + `enrich_changes_with_data`
//!    产出的数据携带并集后的值)。
//! 3. 无 tombstone(无 `deleted_at`)的 junction 表(复合主键):
//!    较旧的 DELETE 被 LWW 拒绝且不写 `__sync_delete_versions`;
//!    较新的 DELETE 正常生效并登记删除版本,阻止迟到 UPSERT 复活。
//! 4. 慢钟败方进 `__sync_conflicts`(side='cloud')且重复投递不增殖:
//!    同内容不同时间戳的重复投递去重为一条;不同内容各留一条;
//!    与本地语义等价的回声不入表。

use deep_student_lib::data_governance::sync::{
    ApplyChangesResult, ChangeOperation, ConflictAwareApplyResult, ConflictPolicy,
    SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};
use serde_json::json;

// ============================================================================
// Fixtures
// ============================================================================

/// `notes` 在字段级合并注册表里登记了 `tags`(TagSetUnion)和
/// `is_favorite`(BooleanOr),用它验证冲突路径上的可交换合并。
/// 触发器与生产形态一致:changed_at 取业务行的 updated_at。
fn new_notes_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE notes (
            id TEXT PRIMARY KEY,
            body TEXT NOT NULL DEFAULT '',
            tags TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER trg_notes_ins AFTER INSERT ON notes BEGIN
            INSERT INTO __change_log (table_name, record_id, operation, changed_at)
            VALUES ('notes', NEW.id, 'INSERT', NEW.updated_at);
        END;
        CREATE TRIGGER trg_notes_upd AFTER UPDATE ON notes BEGIN
            INSERT INTO __change_log (table_name, record_id, operation, changed_at)
            VALUES ('notes', NEW.id, 'UPDATE', NEW.updated_at);
        END;
        "#,
    )
    .unwrap();
    conn
}

fn insert_note(
    conn: &Connection,
    id: &str,
    body: &str,
    tags: &str,
    is_favorite: i64,
    updated_at: &str,
) {
    conn.execute(
        "INSERT INTO notes (id, body, tags, is_favorite, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, body, tags, is_favorite, updated_at],
    )
    .unwrap();
}

fn note_row(conn: &Connection, id: &str) -> (String, i64, String) {
    conn.query_row(
        "SELECT tags, is_favorite, updated_at FROM notes WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap()
}

fn mark_all_synced(conn: &Connection) {
    let ts = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE __change_log SET sync_version = ?1 WHERE sync_version = 0",
        params![ts],
    )
    .unwrap();
}

fn count_pending(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// 模拟真实上传管线:pending change log → enrich(读当前行数据)→ 出站变更。
/// 与生产上传路径使用同一对公开函数,而不是手写 payload。
fn build_outbound_changes(conn: &Connection, source_device_id: &str) -> Vec<SyncChangeWithData> {
    let pending = SyncManager::get_pending_changes(conn, None, None).unwrap();
    let mut changes = SyncManager::enrich_changes_with_data(conn, &pending.entries, None).unwrap();
    for change in &mut changes {
        change.source_device_id = Some(source_device_id.to_string());
    }
    changes
}

fn apply_from_cloud(
    conn: &Connection,
    changes: &[SyncChangeWithData],
    cloud_device: &str,
    local_device: &str,
) -> (ApplyChangesResult, ConflictAwareApplyResult) {
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        conn,
        changes,
        None,
        ConflictPolicy::KeepLatest,
        Some(cloud_device),
        Some(local_device),
    )
    .unwrap()
}

// ============================================================================
// 1. 双设备 tag 并集收敛(两边都有 pending)
// ============================================================================

/// 设备 A(较新钟)和设备 B(较旧钟)各自离线给同一条笔记打了不同 tag,
/// 两边的 change log 都有 pending 条目。交换一轮变更后:
/// - B 端(收到较新的 A 变更)走 Cloud 胜 → 强制应用必须带字段级合并
/// - A 端(收到较旧的 B 变更)走 Local 胜 → 安全字段折叠进本地行
/// 两端 tags 必须收敛到同一个排序后的并集,is_favorite 收敛到布尔 OR。
#[test]
fn r02x_two_device_tag_union_converges_when_both_sides_have_pending() {
    let dev_a = new_notes_db();
    let dev_b = new_notes_db();

    // A 较新(10:00),B 较旧(09:00);A 收藏了笔记,B 没有
    insert_note(
        &dev_a,
        "note-1",
        "shared",
        r#"["alpha"]"#,
        1,
        "2026-03-01T10:00:00Z",
    );
    insert_note(
        &dev_b,
        "note-1",
        "shared",
        r#"["beta"]"#,
        0,
        "2026-03-01T09:00:00Z",
    );
    assert_eq!(count_pending(&dev_a), 1, "A 端应有 pending");
    assert_eq!(count_pending(&dev_b), 1, "B 端应有 pending");

    // 通过真实上传管线构造两端的出站变更
    let from_a = build_outbound_changes(&dev_a, "device-a");
    let from_b = build_outbound_changes(&dev_b, "device-b");
    assert_eq!(from_a.len(), 1);
    assert_eq!(from_b.len(), 1);

    // 双向交换(顺序无关紧要,两边各自独立裁决)
    let (result_b, conflict_b) = apply_from_cloud(&dev_b, &from_a, "device-a", "device-b");
    let (result_a, conflict_a) = apply_from_cloud(&dev_a, &from_b, "device-b", "device-a");

    // B 端:cloud(A, 10:00)胜过 local(09:00)→ 强制应用
    assert_eq!(result_b.success_count, 1, "B 端 Cloud 胜应强制应用");
    assert!(conflict_b.conflicts_saved > 0, "B 端冲突双方应留痕");
    // A 端:local(10:00)胜过 cloud(B, 09:00)→ 整行拒绝
    assert_eq!(result_a.success_count, 0, "A 端 Local 胜不应应用云端整行");
    assert_eq!(conflict_a.rejected, 1, "A 端应把云端整行记为 rejected");

    let (tags_a, fav_a, updated_a) = note_row(&dev_a, "note-1");
    let (tags_b, fav_b, updated_b) = note_row(&dev_b, "note-1");

    // 并集经 BTreeSet 排序,两端字节级一致
    assert_eq!(
        tags_a, r#"["alpha","beta"]"#,
        "Local 胜端 tags 必须折叠成并集"
    );
    assert_eq!(
        tags_b, r#"["alpha","beta"]"#,
        "Cloud 胜端 tags 必须合并成并集而非整行覆盖"
    );
    assert_eq!(tags_a, tags_b, "两端 tags 必须字节级收敛");
    assert_eq!(fav_a, 1, "A 端 is_favorite 保持 OR 结果");
    assert_eq!(fav_b, 1, "B 端 is_favorite 必须 OR 成 true");
    // 行级 LWW 语义:两端 updated_at 都落在胜者(A)的时间戳上
    assert_eq!(updated_a, "2026-03-01T10:00:00Z");
    assert_eq!(updated_b, "2026-03-01T10:00:00Z");

    // B 端自己的原始 pending 未被 echo 抑制吞掉,下一轮上传携带的也是并集
    let next_from_b = build_outbound_changes(&dev_b, "device-b");
    assert!(
        !next_from_b.is_empty(),
        "B 端原始 pending 不应被 Cloud 胜的 echo 抑制误伤"
    );
    for change in &next_from_b {
        let data = change.data.as_ref().unwrap();
        assert_eq!(
            data.get("tags").and_then(|v| v.as_str()),
            Some(r#"["alpha","beta"]"#),
            "B 端下一轮上传的 tags 应为并集"
        );
    }
}

// ============================================================================
// 2. Local 胜后下一轮上传含折叠字段
// ============================================================================

/// Local 胜时折叠写入不得抑制 change log:触发器照常记 pending,
/// 下一轮 `get_pending_changes` + `enrich_changes_with_data` 产出的
/// 上传 payload 必须携带折叠后的并集 tags 与 OR 后的 is_favorite,
/// 行级 updated_at 保持本地胜者的值。
#[test]
fn r02x_local_win_fold_lands_in_next_upload_payload() {
    let conn = new_notes_db();
    insert_note(
        &conn,
        "note-fold",
        "shared",
        r#"["local"]"#,
        0,
        "2026-03-02T12:00:00Z",
    );
    let pending_before = count_pending(&conn);
    assert_eq!(pending_before, 1);

    // 云端较旧(11:00)但带着对端的 tag 和收藏标记
    let cloud_change = SyncChangeWithData {
        table_name: "notes".to_string(),
        record_id: "note-fold".to_string(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "note-fold",
            "body": "shared",
            "tags": ["remote"],
            "is_favorite": 1,
            "updated_at": "2026-03-02T11:00:00Z",
        })),
        changed_at: "2026-03-02T11:00:00Z".to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some("device-cloud".to_string()),
        source_seq: Some(1),
    };
    let (result, conflict) =
        apply_from_cloud(&conn, &[cloud_change], "device-cloud", "device-local");
    assert_eq!(result.success_count, 0, "Local 胜不应用云端整行");
    assert_eq!(conflict.rejected, 1);

    // 折叠写入(tags 并集 + is_favorite OR)应触发触发器,产生新的 pending
    let pending_after = count_pending(&conn);
    assert!(
        pending_after > pending_before,
        "折叠写入必须走触发器产生新的 pending(before={}, after={})",
        pending_before,
        pending_after
    );

    // 下一轮上传管线:payload 必须携带折叠后的字段
    let outbound = build_outbound_changes(&conn, "device-local");
    assert!(!outbound.is_empty(), "下一轮上传应有变更可发");
    for change in &outbound {
        assert_eq!(change.table_name, "notes");
        assert_eq!(change.record_id, "note-fold");
        let data = change.data.as_ref().expect("UPDATE payload 应携带整行数据");
        assert_eq!(
            data.get("tags").and_then(|v| v.as_str()),
            Some(r#"["local","remote"]"#),
            "上传 payload 的 tags 应为折叠后的并集"
        );
        assert_eq!(
            data.get("is_favorite").and_then(|v| v.as_i64()),
            Some(1),
            "上传 payload 的 is_favorite 应为 OR 结果"
        );
        assert_eq!(
            data.get("updated_at").and_then(|v| v.as_str()),
            Some("2026-03-02T12:00:00Z"),
            "行级 updated_at 保持本地胜者的值"
        );
    }

    // 非可交换字段(body)不受折叠影响,保持本地值
    let body: String = conn
        .query_row("SELECT body FROM notes WHERE id = 'note-fold'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(body, "shared");
}

// ============================================================================
// 3. 无 tombstone 的复合主键表:较旧 DELETE 被拒,较新 DELETE 生效
// ============================================================================

/// junction 表典型形态:复合主键、无 `deleted_at`(hard delete)、有 `updated_at`
/// 供 LWW 门比较。record_id 使用 JSON 对象编码复合主键。
///
/// 表名取 `items` 是刻意的:RowSync 白名单只在 debug 构建放行
/// `items/notes/...` 等测试 fixture 名(要求存在 id + updated_at 列),
/// 而分类注册表里的真实 junction 表(chat_v2_session_mistakes /
/// review_session_mistakes)都没有 updated_at,LWW 门无从比较;
/// llm_usage_daily 虽有 updated_at 但分类是 DerivedRebuild,不允许行同步。
/// 这里用复合主键 (id, tag_id) 的 items 覆盖"junction 形态 + 无 tombstone"的
/// DELETE 新旧裁决路径。
fn new_composite_pk_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE items (
            id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (id, tag_id)
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

fn junction_delete_change(
    record_id: &str,
    changed_at: &str,
    device: &str,
    seq: u64,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: ChangeOperation::Delete,
        data: None,
        changed_at: changed_at.to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some(device.to_string()),
        source_seq: Some(seq),
    }
}

fn junction_row_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM items WHERE id = 'n1' AND tag_id = 't1'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

fn delete_version_count(conn: &Connection, record_id: &str) -> i64 {
    let table_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_delete_versions')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    if !table_exists {
        return 0;
    }
    conn.query_row(
        "SELECT COUNT(*) FROM __sync_delete_versions WHERE table_name = 'items' AND record_id = ?1",
        params![record_id],
        |r| r.get(0),
    )
    .unwrap()
}

/// 较旧的 DELETE 不得物理删除更新的本地行(INV-1:hard delete 不可恢复),
/// 且被拒的 DELETE 不得登记删除版本(否则会反过来阻断本地较新行的正常收敛)。
/// 较新的 DELETE 正常生效并登记版本,阻止迟到的 UPSERT 复活。
#[test]
fn r02x_composite_pk_stale_delete_rejected_fresh_delete_applies() {
    let conn = new_composite_pk_db();
    let record_key = json!({"id": "n1", "tag_id": "t1"});
    let record_id = record_key.to_string();

    conn.execute(
        "INSERT INTO items (id, tag_id, updated_at) VALUES ('n1', 't1', '2026-04-01T13:00:00Z')",
        [],
    )
    .unwrap();

    // 1) 较旧 DELETE(12:00 < 13:00)→ 被 LWW 拒绝
    let stale_delete =
        junction_delete_change(&record_id, "2026-04-01T12:00:00Z", "device-stale", 1);
    let (result, _) = apply_from_cloud(&conn, &[stale_delete], "device-stale", "device-local");
    assert_eq!(result.success_count, 0);
    assert_eq!(
        result.skipped_count, 1,
        "较旧 DELETE 必须被 LWW 拒绝: {:?}",
        result.failures
    );
    assert_eq!(
        junction_row_count(&conn),
        1,
        "更新的本地行不得被迟到 DELETE 物理删除"
    );
    assert_eq!(
        delete_version_count(&conn, &record_id),
        0,
        "被拒的 DELETE 不得写 __sync_delete_versions"
    );

    // 2) 较新 DELETE(14:00 > 13:00)→ 正常生效
    let fresh_delete =
        junction_delete_change(&record_id, "2026-04-01T14:00:00Z", "device-fresh", 2);
    let (result, _) = apply_from_cloud(&conn, &[fresh_delete], "device-fresh", "device-local");
    assert_eq!(
        result.success_count, 1,
        "较新 DELETE 应正常生效: {:?}",
        result.failures
    );
    assert_eq!(junction_row_count(&conn), 0, "较新 DELETE 应物理删除本地行");
    assert_eq!(
        delete_version_count(&conn, &record_id),
        1,
        "生效的 DELETE 应登记删除版本"
    );

    // 3) 迟到的 UPSERT(12:30 < 14:00)不得复活已删除的行
    let late_upsert = SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.clone(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "n1",
            "tag_id": "t1",
            "updated_at": "2026-04-01T12:30:00Z",
        })),
        changed_at: "2026-04-01T12:30:00Z".to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some("device-stale".to_string()),
        source_seq: Some(3),
    };
    let (result, _) = apply_from_cloud(&conn, &[late_upsert], "device-stale", "device-local");
    assert_eq!(result.success_count, 0);
    assert_eq!(
        junction_row_count(&conn),
        0,
        "删除版本必须阻止迟到 UPSERT 复活已删除的行"
    );
}

// ============================================================================
// 4. 慢钟败方进冲突表且重复投递不增殖
// ============================================================================

fn slow_clock_upsert(
    body: &str,
    payload_ts: &str,
    changed_at: &str,
    seq: u64,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "notes".to_string(),
        record_id: "note-slow".to_string(),
        operation: ChangeOperation::Update,
        data: Some(json!({
            "id": "note-slow",
            "body": body,
            "tags": "[]",
            "is_favorite": 0,
            "updated_at": payload_ts,
        })),
        changed_at: changed_at.to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: Some("device-slow".to_string()),
        source_seq: Some(seq),
    }
}

fn cloud_side_conflict_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM __sync_conflicts
         WHERE table_name = 'notes' AND record_id = 'note-slow' AND side = 'cloud'
           AND resolved_at IS NULL",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// 慢钟设备的写入全部输掉 LWW 时:
/// - 败方 payload 必须落 `__sync_conflicts`(side='cloud'),不得静默丢弃
/// - 同内容重复投递(哪怕 changed_at / payload updated_at 抖动)去重为一条
/// - 不同内容的败方写入各留一条(增长只按"不同分歧",不按投递次数)
/// - 与本地语义等价的回声(仅时间戳差异)不入表
/// - 本地较新值全程不被覆盖
#[test]
fn r02x_slow_clock_loser_recorded_once_across_redeliveries() {
    let conn = new_notes_db();
    insert_note(
        &conn,
        "note-slow",
        "newer-local",
        "[]",
        0,
        "2026-05-01T13:00:00Z",
    );
    mark_all_synced(&conn); // 无 pending → 走非冲突路径的 LWW SkipStale

    // 同一败方 payload 反复投递:单批重复 + 跨轮重放 + 时间戳抖动
    let v1_a = slow_clock_upsert("slow-v1", "2026-05-01T12:00:00Z", "2026-05-01T12:00:00Z", 1);
    let v1_b = slow_clock_upsert("slow-v1", "2026-05-01T12:00:00Z", "2026-05-01T11:59:00Z", 2);
    let v1_c = slow_clock_upsert("slow-v1", "2026-05-01T11:00:00Z", "2026-05-01T11:00:00Z", 3);

    // 单批内含重复
    let (result, _) = apply_from_cloud(
        &conn,
        &[v1_a.clone(), v1_a.clone()],
        "device-slow",
        "device-local",
    );
    assert_eq!(result.success_count, 0, "慢钟写入必须输掉 LWW");
    assert_eq!(cloud_side_conflict_count(&conn), 1, "单批重复应去重为一条");

    // 跨轮重放,changed_at 与 payload updated_at 抖动都不应产生新条目
    // (data_hash 基于剔除同步元字段后的规范化内容)
    for change in [&v1_a, &v1_b, &v1_c] {
        for _ in 0..3 {
            let (result, _) =
                apply_from_cloud(&conn, &[(*change).clone()], "device-slow", "device-local");
            assert_eq!(result.success_count, 0);
        }
    }
    assert_eq!(
        cloud_side_conflict_count(&conn),
        1,
        "同内容重复投递(含时间戳抖动)不得增殖冲突条目"
    );

    // 不同内容的败方写入 → 第二条(每个分歧各自可见,不丢)
    let v2 = slow_clock_upsert("slow-v2", "2026-05-01T12:30:00Z", "2026-05-01T12:30:00Z", 4);
    let (result, _) = apply_from_cloud(&conn, &[v2.clone()], "device-slow", "device-local");
    assert_eq!(result.success_count, 0);
    assert_eq!(
        cloud_side_conflict_count(&conn),
        2,
        "不同内容的败方写入应各留一条"
    );
    // v2 重放依旧不增殖
    let (_, _) = apply_from_cloud(&conn, &[v2], "device-slow", "device-local");
    assert_eq!(cloud_side_conflict_count(&conn), 2);

    // 语义回声:内容与本地一致、仅时间戳更旧 → 不入冲突表
    let echo = slow_clock_upsert(
        "newer-local",
        "2026-05-01T12:45:00Z",
        "2026-05-01T12:45:00Z",
        5,
    );
    let (result, _) = apply_from_cloud(&conn, &[echo], "device-slow", "device-local");
    assert_eq!(result.success_count, 0);
    assert_eq!(
        cloud_side_conflict_count(&conn),
        2,
        "与本地语义等价的回声不得入冲突表"
    );

    // 本地较新值全程未被覆盖
    let body: String = conn
        .query_row("SELECT body FROM notes WHERE id = 'note-slow'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(body, "newer-local");

    // 败方 payload 可见且可追溯到慢钟设备
    let (data_json, losing_device): (String, Option<String>) = conn
        .query_row(
            "SELECT data_json, losing_device_id FROM __sync_conflicts
             WHERE table_name = 'notes' AND record_id = 'note-slow' AND side = 'cloud'
             ORDER BY id LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(data_json.contains("slow-v1"), "败方 payload 应完整可见");
    assert_eq!(losing_device.as_deref(), Some("device-slow"));
}
