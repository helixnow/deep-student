//! R13 迁移触发同步传播契约（迁移写入必须进 change_log）。
//!
//! 背景：schema 迁移中的数据规范化（normalization UPDATE）是"本地写入"，
//! 上传路径唯一的变更来源是 `__change_log`（见
//! `SyncManager::get_pending_changes` 的传播契约注释）。多设备混版本场景下，
//! 已升级设备清洗出的干净数据只有经由 `trg__change_log_*` 触发器落进
//! change_log（sync_version = 0）才会传播到其他设备；否则各设备只能依赖
//! 自己本地执行同一迁移完成自愈，云上仍可能被旧设备的脏行反向覆盖。
//!
//! 本文件锁定两侧事实（不修改传播协议逻辑）：
//!
//! 1. 【合规锁定】mistakes V20260824（anki_cards 可选 JSON / source 规范化）
//!    晚于 V20260131 装配的 anki_cards 触发器，且 mistakes 迁移链从未
//!    DROP/重建 anki_cards 触发器 —— 规范化 UPDATE 与墓碑清扫都会以
//!    pending 状态进入 change_log，并被 get_pending_changes 拾取上传。
//! 2. 【历史缺口标记】vfs V20260302（folder_items 时间戳规范化）早于
//!    V20260523 才装配的 folder_items 触发器 —— 该修复从未经 change_log
//!    传播。本文件将此缺口作为"已知行为"锁定，防止无声漂移；
//!    修复传播协议不在本轮范围内，新的规范化迁移必须先装触发器再清洗。

use deep_student_lib::data_governance::migration::MigrationCoordinator;
use deep_student_lib::data_governance::sync::SyncManager;
use rusqlite::{params, Connection};
use tempfile::TempDir;

/// 用真实迁移协调器把四个受治理数据库建到当前最新版本，返回 mistakes 连接。
///
/// 与 sync_schema_coverage_tests.rs 相同的建库方式：真实表、真实触发器、
/// 真实索引，避免手写 schema 与现网漂移。
fn migrate_real_mistakes_db() -> (TempDir, Connection) {
    let temp_dir = TempDir::new().expect("create temp app data dir");
    let root = temp_dir.path().to_path_buf();
    let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
    let report = coordinator.run_all().expect("real migrations should run");
    assert!(
        report.success,
        "migration report should be successful: {report:?}"
    );
    let conn = Connection::open(root.join("mistakes.db")).expect("open migrated mistakes database");
    (temp_dir, conn)
}

/// 把当前 change_log 中所有条目标记为已同步，模拟"升级前所有历史变更
/// 已完成上传"的稳态设备。之后新产生的 sync_version = 0 条目即为
/// 本次操作（迁移）新引入的待传播变更。
fn mark_all_change_log_synced(conn: &Connection) {
    conn.execute(
        "UPDATE __change_log SET sync_version = strftime('%s', 'now') WHERE sync_version = 0",
        [],
    )
    .expect("mark existing change_log entries as synced");
}

/// 查询指定表当前 pending（sync_version = 0）的 (record_id, operation) 列表。
fn pending_rows_for_table(conn: &Connection, table: &str) -> Vec<(String, String)> {
    let mut stmt = conn
        .prepare(
            "SELECT record_id, operation FROM __change_log
             WHERE sync_version = 0 AND table_name = ?1 ORDER BY id",
        )
        .expect("prepare pending query");
    let rows = stmt
        .query_map(params![table], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query pending rows");
    rows.map(|r| r.expect("read pending row")).collect()
}

fn change_log_max_id(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(id), 0) FROM __change_log", [], |row| {
        row.get(0)
    })
    .expect("read change_log max id")
}

/// 【合规锁定】V20260824 的可选 JSON 规范化 UPDATE 必须进 change_log。
///
/// 场景：稳态老设备（历史变更均已上传）库里存有云同步来的脏行
/// （tags_json / images_json / extra_fields_json 为 NULL 或空白），
/// 升级到 V20260824 后：
/// - 被清洗的行必须以 pending UPDATE 进入 change_log（可被上传传播）；
/// - 干净行一个条目都不许多（WHERE 限定防 change_log 洪泛 / 多设备回声）；
/// - updated_at 不许被触碰（迁移注释承诺：字段级合并不得让修复赢过更新的
///   远端写入）。
#[test]
fn v20260824_normalization_updates_enter_change_log_as_pending() {
    let (_guard, conn) = migrate_real_mistakes_db();

    conn.execute(
        "INSERT INTO document_tasks
             (id, document_id, original_document_name, segment_index, content_segment,
              status, anki_generation_options_json)
         VALUES ('task-1', 'doc-1', 'doc.md', 0, 'segment', 'Completed', '{}')",
        [],
    )
    .expect("seed parent document task");

    // 脏行：三个可选 JSON 字段分别命中 NULL / 空串 / 纯空白三个规范化分支。
    conn.execute(
        "INSERT INTO anki_cards
             (id, task_id, front, back, tags_json, images_json, extra_fields_json,
              updated_at)
         VALUES ('card-dirty', 'task-1', 'dirty front', 'dirty back', NULL, '', '  ',
                 '2026-08-10T00:00:00.000Z')",
        [],
    )
    .expect("seed dirty anki card");

    // 干净对照行：front/back 与脏行不同，避免落入同一 dedup 键。
    conn.execute(
        "INSERT INTO anki_cards
             (id, task_id, front, back, tags_json, images_json, extra_fields_json)
         VALUES ('card-clean', 'task-1', 'clean front', 'clean back', '[]', '[]', '{}')",
        [],
    )
    .expect("seed clean anki card");

    mark_all_change_log_synced(&conn);

    // 老库升级到 V20260824：规范化 SQL 与现网逐字一致（幂等，可安全回放）。
    conn.execute_batch(include_str!(
        "../migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql"
    ))
    .expect("replay V20260824 normalization migration");

    // 规范化本身生效
    let (tags, images, extra, updated_at): (String, String, String, String) = conn
        .query_row(
            "SELECT tags_json, images_json, extra_fields_json, updated_at
             FROM anki_cards WHERE id = 'card-dirty'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read normalized card");
    assert_eq!(tags, "[]", "NULL tags_json should be normalized");
    assert_eq!(images, "[]", "empty images_json should be normalized");
    assert_eq!(extra, "{}", "blank extra_fields_json should be normalized");
    assert_eq!(
        updated_at, "2026-08-10T00:00:00.000Z",
        "normalization must not touch updated_at (field merge must not let \
         this repair win over newer remote writes)"
    );

    // 传播契约：脏行的规范化 UPDATE 必须以 pending 状态进入 change_log
    let pending = pending_rows_for_table(&conn, "anki_cards");
    assert!(
        pending
            .iter()
            .any(|(id, op)| id == "card-dirty" && op == "UPDATE"),
        "normalization UPDATE must land in __change_log as pending; got {pending:?}"
    );
    // 干净行不许被触碰（防 change_log 洪泛：SQLite 只对实际 UPDATE 的行触发）
    assert!(
        pending.iter().all(|(id, _)| id != "card-clean"),
        "untouched clean rows must not produce change_log entries; got {pending:?}"
    );

    // 上传入口视角：get_pending_changes 必须能看到这条迁移写入
    let visible = SyncManager::get_pending_changes(&conn, Some("anki_cards"), None)
        .expect("read pending changes via sync entrypoint");
    assert!(
        visible
            .entries
            .iter()
            .any(|entry| entry.table_name == "anki_cards" && entry.record_id == "card-dirty"),
        "migration write must be visible to the upload path (get_pending_changes)"
    );

    // 幂等回声防护：再次回放同一迁移（多设备各自升级 / 重试场景），
    // 已规范化的行不许再产生任何新的 change_log 条目。
    let max_id_before_replay = change_log_max_id(&conn);
    conn.execute_batch(include_str!(
        "../migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql"
    ))
    .expect("second replay of V20260824 should be idempotent");
    let echo_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE id > ?1",
            params![max_id_before_replay],
            |row| row.get(0),
        )
        .expect("count echo entries");
    assert_eq!(
        echo_count, 0,
        "idempotent replay must not flood __change_log with echo entries"
    );
}

/// 【合规锁定】V20260824 的 NULL-source 碰撞清扫（软删墓碑）也必须进 change_log。
///
/// 场景：早期 runtime 建表没有 source_type/source_id 的 NOT NULL 约束，
/// 老库可以合法持有多条规范化后 dedup 键相同的活行。V20260824 会把除最新
/// 一条外的行软删（deleted_at 置位）。该墓碑必须以 pending UPDATE 传播，
/// 否则其他设备会继续把已裁决删除的行当活数据上传。
///
/// 建库方式：先用真实 init 建全库，再把 anki_cards 单表替换为"早期
/// runtime 形状"（source 列无 NOT NULL），随后按真实文件依次装配
/// V20260131 触发器与 V20260724 dedup 唯一索引 —— 触发器与索引均为现网
/// 逐字 SQL，只有表约束按事故形态放宽。
#[test]
fn v20260824_null_source_tombstone_sweep_enters_change_log() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let conn = Connection::open(temp_dir.path().join("mistakes.db")).expect("open raw mistakes db");

    conn.execute_batch(include_str!("../migrations/mistakes/V20260130__init.sql"))
        .expect("apply real mistakes init");

    // 事故形态：早期 runtime 建表 / 云同步导入的行早于 NOT NULL 约束。
    conn.execute_batch(
        "DROP TABLE anki_cards;
         CREATE TABLE anki_cards (
             id TEXT PRIMARY KEY,
             task_id TEXT,
             front TEXT NOT NULL,
             back TEXT NOT NULL,
             tags_json TEXT,
             images_json TEXT,
             is_error_card INTEGER NOT NULL DEFAULT 0,
             error_content TEXT,
             card_order_in_task INTEGER DEFAULT 0,
             created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             extra_fields_json TEXT,
             template_id TEXT,
             source_type TEXT,
             source_id TEXT,
             text TEXT,
             device_id TEXT,
             local_version INTEGER DEFAULT 0,
             deleted_at TEXT
         );",
    )
    .expect("recreate legacy runtime-shaped anki_cards");

    // 现网触发器（V20260131）与现网 dedup 唯一索引（V20260724）逐字装配。
    conn.execute_batch(include_str!(
        "../migrations/mistakes/V20260131__add_change_log.sql"
    ))
    .expect("apply real change_log migration");
    conn.execute_batch(include_str!(
        "../migrations/mistakes/V20260724__anki_dedup_index_exclude_deleted.sql"
    ))
    .expect("apply real dedup unique index migration");

    // 两条活行：source 均为 NULL，规范化后 dedup 键相同 → 必须清扫其一。
    conn.execute_batch(
        "INSERT INTO anki_cards (id, front, back, updated_at, created_at)
         VALUES ('legacy-old', 'F', 'B', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
         INSERT INTO anki_cards (id, front, back, updated_at, created_at)
         VALUES ('legacy-new', 'F', 'B', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');",
    )
    .expect("seed colliding NULL-source rows");

    mark_all_change_log_synced(&conn);

    conn.execute_batch(include_str!(
        "../migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql"
    ))
    .expect("run V20260824 on legacy-shaped library");

    // 裁决结果：最新行存活，旧行墓碑化，双方 source 均被规范化。
    let (new_deleted, new_source): (Option<String>, String) = conn
        .query_row(
            "SELECT deleted_at, source_type FROM anki_cards WHERE id = 'legacy-new'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read winner row");
    assert!(new_deleted.is_none(), "newest row must stay live");
    assert_eq!(new_source, "", "winner source_type must be normalized");
    let old_deleted: Option<String> = conn
        .query_row(
            "SELECT deleted_at FROM anki_cards WHERE id = 'legacy-old'",
            [],
            |row| row.get(0),
        )
        .expect("read loser row");
    assert!(
        old_deleted.is_some(),
        "older colliding row must be tombstoned"
    );

    // 传播契约：墓碑清扫与 source 规范化都必须以 pending UPDATE 进 change_log。
    let pending = pending_rows_for_table(&conn, "anki_cards");
    for id in ["legacy-old", "legacy-new"] {
        assert!(
            pending
                .iter()
                .any(|(record, op)| record == id && op == "UPDATE"),
            "migration write for {id} must be pending in __change_log; got {pending:?}"
        );
    }
    let visible = SyncManager::get_pending_changes(&conn, Some("anki_cards"), None)
        .expect("read pending changes via sync entrypoint");
    assert!(
        visible.entries.iter().any(|e| e.record_id == "legacy-old"),
        "tombstone sweep must be visible to the upload path"
    );
}

/// 【历史缺口标记：GAP，锁定现状，勿据此新增同类迁移】
///
/// vfs V20260302 规范化 folder_items 时间戳时，folder_items 尚无任何
/// trg__change_log_* 触发器（首次覆盖要到 V20260523）——因此该规范化
/// 从未经 change_log 传播，混版本多设备只能依赖每台设备本地执行同一
/// 迁移自愈；升级设备无法替旧设备清洗云端数据。
///
/// 本测试按真实迁移文件复现该历史时点并断言 change_log 为空：
/// - 若有人给 V20260302 补写传播（协议大改，本轮明确禁止），此测试会
///   失败并强制显式评审；
/// - 新的规范化迁移必须先装触发器再清洗（见
///   `SyncManager::get_pending_changes` 的传播契约注释），不得复制此缺口。
#[test]
fn gap_v20260302_folder_items_normalization_never_entered_change_log() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let conn = Connection::open(temp_dir.path().join("vfs.db")).expect("open raw vfs db");

    // V20260302 执行时点的真实历史 schema 前缀：init + change_log。
    // （V20260201..V20260227 不触碰 folder_items 触发器，folder_items 的
    //  同步覆盖首次出现在 V20260523，晚于本迁移。）
    conn.execute_batch(include_str!("../migrations/vfs/V20260130__init.sql"))
        .expect("apply real vfs init");
    conn.execute_batch(include_str!(
        "../migrations/vfs/V20260131__add_change_log.sql"
    ))
    .expect("apply real vfs change_log migration");

    // 历史脏行：TEXT 时间戳写进了 INTEGER 语义列（根级挂载，无 FK 依赖）。
    conn.execute(
        "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order,
                                   created_at, updated_at)
         VALUES ('fi_legacy0001', NULL, 'note', 'note-1', 0,
                 '2026-02-14T08:00:00Z', '2026-02-14T09:00:00Z')",
        [],
    )
    .expect("seed dirty TEXT-timestamp folder item");

    conn.execute_batch(include_str!(
        "../migrations/vfs/V20260302__normalize_folder_items_timestamps.sql"
    ))
    .expect("run V20260302 normalization");

    // 规范化本身在本地生效……
    let (created_type, updated_type): (String, String) = conn
        .query_row(
            "SELECT typeof(created_at), typeof(updated_at)
             FROM folder_items WHERE id = 'fi_legacy0001'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read normalized types");
    assert_eq!(created_type, "integer", "created_at should be normalized");
    assert_eq!(updated_type, "integer", "updated_at should be normalized");

    // ……但对同步完全不可见：这就是被锁定的缺口。
    let folder_item_log_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE table_name = 'folder_items'",
            [],
            |row| row.get(0),
        )
        .expect("count folder_items change_log rows");
    assert_eq!(
        folder_item_log_rows, 0,
        "KNOWN GAP (locked): V20260302 predates folder_items change_log \
         triggers (V20260523), so its normalization never propagates via \
         sync; devices self-heal only by running the migration locally. \
         If this assertion fails, someone made migration writes propagate \
         retroactively — that is a sync-protocol change requiring review."
    );
}
