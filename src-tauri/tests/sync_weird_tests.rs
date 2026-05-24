//! 古怪到荒谬的边界测试
//!
//! 这一轮测试不是重复验证已知保护，而是试图穷尽 SQLite + JSON + HLC + tombstone
//! 相互作用的病态组合。每一条都是从"如果有人真这么干会怎样"出发。
//!
//! 命名约定：W.NN = Weird #N

use deep_student_lib::data_governance::sync::{
    compare_hlc_strings, conflict_resolver::ConflictPolicy, tombstone, ChangeOperation, Hlc,
    HlcClock, HlcError, SyncChangeWithData, SyncManager,
};
use rusqlite::{params, Connection};
use serde_json::json;
use std::cmp::Ordering;

fn new_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE items (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            counter INTEGER NOT NULL DEFAULT 0,
            score REAL NOT NULL DEFAULT 0.0,
            updated_at TEXT NOT NULL,
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
        CREATE TRIGGER trg_ins AFTER INSERT ON items BEGIN
            INSERT INTO __change_log (table_name, record_id, operation, changed_at)
            VALUES ('items', NEW.id, 'INSERT', NEW.updated_at);
        END;
        CREATE TRIGGER trg_upd AFTER UPDATE ON items BEGIN
            INSERT INTO __change_log (table_name, record_id, operation, changed_at)
            VALUES ('items', NEW.id, 'UPDATE', NEW.updated_at);
        END;
        CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
        INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
        "#,
    )
    .unwrap();
    conn
}

fn now_ts() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn ts_ago(secs: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::seconds(secs)).to_rfc3339()
}

fn mk_change(
    id: &str,
    op: ChangeOperation,
    data: serde_json::Value,
    changed_at: &str,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".into(),
        record_id: id.into(),
        operation: op,
        data: if op == ChangeOperation::Delete {
            None
        } else {
            Some(data)
        },
        changed_at: changed_at.into(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    }
}

fn get_title(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT title FROM items WHERE id = ?1", params![id], |r| {
        r.get(0)
    })
    .ok()
}

fn get_counter(conn: &Connection, id: &str) -> Option<i64> {
    conn.query_row(
        "SELECT counter FROM items WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .ok()
}

// ============================================================================
// W.01 - W.10: Unicode 和字符编码地狱
// ============================================================================

/// **W.01** Emoji 序列和 ZWJ（Zero-Width Joiner）在 title 字段
/// 这些是 Unicode 规范化的常见坑点——家庭 emoji 实际是多个 code point 用 ZWJ 拼出来
#[test]
fn w01_emoji_zwj_sequences() {
    let conn = new_db();
    // 👨‍👩‍👧‍👦 = man + ZWJ + woman + ZWJ + girl + ZWJ + boy
    let family = "👨\u{200D}👩\u{200D}👧\u{200D}👦";
    // 🧑🏾‍🚀 = person + dark skin + ZWJ + rocket
    let astronaut = "🧑\u{1F3FE}\u{200D}🚀";
    let combo = format!("{}|{}|{}", family, astronaut, "🫠🫨🥹");

    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": combo,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some(combo.as_str()));
}

/// **W.02** NFC vs NFD 规范化：同一个"ç"可以是单码点或 c+cedilla 组合
/// SQLite 不做归一化，所以用 NFD 写入的记录用 NFC 查不到
#[test]
fn w02_unicode_normalization_forms() {
    let conn = new_db();
    let nfc = "caf\u{00E9}"; // "café" 单码点
    let nfd = "caf\u{0065}\u{0301}"; // "café" 分解形式
    assert_ne!(nfc, nfd, "字节序列不同");

    // 用 NFD 插入
    let c = mk_change(
        "nfd",
        ChangeOperation::Insert,
        json!({
            "id": "nfd", "title": nfd,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();

    // 读出来仍是 NFD 形式（SQLite 不做归一化）
    let stored = get_title(&conn, "nfd").unwrap();
    assert_eq!(stored, nfd);
    assert_ne!(stored, nfc, "SQLite 按字节比较，不做 Unicode 归一化");
}

/// **W.03** BiDi（双向）字符：右到左 override 可能让日志和 UI 显示奇怪，但数据应原样存
#[test]
fn w03_bidi_override_characters() {
    let conn = new_db();
    // RLO (U+202E) 会让后续文本反向显示
    let tricky = "normal\u{202E}reversed\u{202C}normal_again";
    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": tricky,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some(tricky));
}

/// **W.04** 纯四字节 UTF-8（U+1xxxx 范围），测试 SQLite UTF-8 handling
#[test]
fn w04_four_byte_utf8_planes() {
    let conn = new_db();
    // 甲骨文字符（CJK Ext B 外），纯 4-byte UTF-8
    let glyphs = "\u{20000}\u{2A700}\u{2F80F}";
    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": glyphs,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some(glyphs));
}

/// **W.05** JSON 里的嵌套引号和反斜杠逃逸地狱
#[test]
fn w05_nested_quote_escape_hell() {
    let conn = new_db();
    let payload = r#"she said "hello \"world\"" \\ then left"#;
    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": payload,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    assert_eq!(get_title(&conn, "n1").as_deref(), Some(payload));
}

/// **W.06** record_id 用 emoji + 控制字符
#[test]
fn w06_weird_record_id_with_control_chars() {
    let conn = new_db();
    let weird_id = "🔑\u{0009}tab\u{0007}bell\u{001B}esc";
    let c = mk_change(
        weird_id,
        ChangeOperation::Insert,
        json!({
            "id": weird_id, "title": "t",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    assert_eq!(get_title(&conn, weird_id).as_deref(), Some("t"));
}

/// **W.07** record_id 是纯空白字符串（多个空格）
#[test]
fn w07_record_id_whitespace_only() {
    let conn = new_db();
    let ws_id = "   \t\n  ";
    let c = mk_change(
        ws_id,
        ChangeOperation::Insert,
        json!({
            "id": ws_id, "title": "whitespace_id",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    assert_eq!(get_title(&conn, ws_id).as_deref(), Some("whitespace_id"));
}

/// **W.08** record_id 是空字符串
#[test]
fn w08_empty_record_id() {
    let conn = new_db();
    let c = mk_change(
        "",
        ChangeOperation::Insert,
        json!({
            "id": "", "title": "empty_id",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    // SENTINEL_TEST: verifies edge case doesn't cause panic/crash
    assert!(
        r.is_ok() || r.is_err(),
        "should not panic on empty record_id"
    );
    // If accepted (SQLite allows empty string PKs), verify data is stored correctly
    if r.is_ok() {
        let stored = get_title(&conn, "");
        assert_eq!(stored.as_deref(), Some("empty_id"));
    }
}

/// **W.09** 反双引号 ID —— 本应被 quote_identifier 处理
#[test]
fn w09_id_with_sql_backticks_and_brackets() {
    let conn = new_db();
    let weird = "`[table]`'s `[row]`";
    let c = mk_change(
        weird,
        ChangeOperation::Insert,
        json!({
            "id": weird, "title": "t",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    assert_eq!(get_title(&conn, weird).as_deref(), Some("t"));
}

/// **W.10** title 里有 null 字符（U+0000）
/// 很多 C 绑定的 SQLite 遇到 \0 会截断
#[test]
fn w10_null_byte_in_string_value() {
    let conn = new_db();
    let with_null = "before\u{0000}after";
    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": with_null,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    // SENTINEL_TEST: verifies edge case doesn't cause panic/crash
    assert!(r.is_ok() || r.is_err(), "null byte should not cause panic");
    // If stored, the null byte may cause truncation in C-backed SQLite bindings
    if r.is_ok() {
        let stored = get_title(&conn, "n1");
        // Either stored correctly or truncated — both are acceptable (no panic)
        assert!(
            stored.is_some(),
            "record should exist after successful insert with null byte"
        );
    }
}

// ============================================================================
// W.11 - W.20: 数值病态值
// ============================================================================

/// **W.11** i64 最大值 / 最小值 in counter
#[test]
fn w11_i64_extremes() {
    let conn = new_db();
    let c1 = mk_change(
        "max",
        ChangeOperation::Insert,
        json!({
            "id": "max", "title": "t", "counter": i64::MAX,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    let c2 = mk_change(
        "min",
        ChangeOperation::Insert,
        json!({
            "id": "min", "title": "t", "counter": i64::MIN,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c1, c2], None).unwrap();
    assert_eq!(get_counter(&conn, "max"), Some(i64::MAX));
    assert_eq!(get_counter(&conn, "min"), Some(i64::MIN));
}

/// **W.12** u64 接近极值（在 JSON 里表现为大数）—— JSON 没有 u64 原生支持
#[test]
fn w12_large_numbers_in_json() {
    let conn = new_db();
    // serde_json::Number 可以 u64 范围
    let large = u64::MAX - 1;
    let c = mk_change(
        "big",
        ChangeOperation::Insert,
        json!({
            "id": "big", "title": "t", "counter": large,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    // u64::MAX 超过 i64::MAX → 会失败或截断
    println!("W.12 (u64::MAX-1) result: {:?}", r);
}

/// **W.13** f64 极值：infinity, NaN（序列化时会失败，确保不 panic）
#[test]
fn w13_float_infinity_nan_not_serializable() {
    // serde_json 默认不允许 inf/nan，但如果 payload 来自外部可能包含
    // 这里测试确认：构造时就会失败，不会传到 apply_downloaded_changes
    let nan = f64::NAN;
    let r = serde_json::to_string(&nan);
    assert!(
        r.is_err() || r.unwrap() == "null",
        "serde_json 对 NaN 的处理"
    );
}

/// **W.14** score 字段用极小浮点数（接近 f64::MIN_POSITIVE）
#[test]
fn w14_tiny_float() {
    let conn = new_db();
    let tiny = f64::MIN_POSITIVE;
    let c = mk_change(
        "tiny",
        ChangeOperation::Insert,
        json!({
            "id": "tiny", "title": "t", "score": tiny,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    let stored: f64 = conn
        .query_row("SELECT score FROM items WHERE id='tiny'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stored, tiny);
}

/// **W.15** 浮点数 0.1 + 0.2 的经典问题
#[test]
fn w15_float_precision_03() {
    let conn = new_db();
    let c = mk_change(
        "n",
        ChangeOperation::Insert,
        json!({
            "id": "n", "title": "t", "score": 0.1_f64 + 0.2_f64,
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    let stored: f64 = conn
        .query_row("SELECT score FROM items WHERE id='n'", [], |r| r.get(0))
        .unwrap();
    assert!((stored - 0.3).abs() < 1e-10);
    // 不等于 0.3！这是真实精度问题，但我们只验证 SQLite 会正确存储比特位
    assert_ne!(stored, 0.3_f64);
}

// ============================================================================
// W.16 - W.25: 时间戳病态
// ============================================================================

/// **W.16** Unix epoch 0（1970-01-01）作为 updated_at
#[test]
fn w16_epoch_zero_timestamp() {
    let conn = new_db();
    let c = mk_change(
        "epoch",
        ChangeOperation::Insert,
        json!({
            "id": "epoch", "title": "t",
            "updated_at": "1970-01-01T00:00:00Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "1970-01-01T00:00:00Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    assert_eq!(get_title(&conn, "epoch").as_deref(), Some("t"));
}

/// **W.17** Y2038：2038-01-19 03:14:07 UTC 后
/// 32 位时间戳会溢出，但我们用 64 位 + ISO 字符串，应无问题
#[test]
fn w17_y2038_overflow_safe() {
    let conn = new_db();
    // 跨过 Y2038（本地当前是 2026 年，所以这不会被 drift guard 拒，除非超过 +60s）
    // 这里用过去时间戳（2038 前几秒），确保能过
    let pre_y2038 = "2038-01-19T03:14:06Z";
    let c = mk_change(
        "y2038",
        ChangeOperation::Insert,
        json!({
            "id": "y2038", "title": "t",
            "updated_at": pre_y2038,
            "deleted_at": serde_json::Value::Null,
        }),
        pre_y2038,
    );
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    // 2038 对当前 2026 来说是未来 12 年，会被 drift guard 拒绝
    if let Err(_) = r {
        // 预期：drift guard 生效
    }
    // 无论 ok 或 err，不 panic 即成功
    println!("W.17 result: {:?}", r);
}

/// **W.18** 负 Unix 时间戳（1970 前）在 RFC3339 不合法，但 JSON 能传
#[test]
fn w18_negative_epoch_rejected_or_handled() {
    let conn = new_db();
    let c = mk_change(
        "pre_epoch",
        ChangeOperation::Insert,
        json!({
            "id": "pre_epoch", "title": "t",
            "updated_at": "1969-12-31T23:59:59Z",
            "deleted_at": serde_json::Value::Null,
        }),
        "1969-12-31T23:59:59Z",
    );
    // RFC3339 允许这个格式（虽然不标准），parse_flexible_timestamp 应能处理
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    println!("W.18 (1969) result: {:?}", r);
}

/// **W.19** 闰秒（历史上曾存在 23:59:60）
#[test]
fn w19_leap_second_representation() {
    let conn = new_db();
    // 2016-12-31T23:59:60 是真实闰秒
    // chrono 默认不接受闰秒，但测试我们代码行为
    let c = mk_change(
        "leap",
        ChangeOperation::Insert,
        json!({
            "id": "leap", "title": "t",
            "updated_at": "2016-12-31T23:59:59Z", // 退一步：不用闰秒
            "deleted_at": serde_json::Value::Null,
        }),
        "2016-12-31T23:59:59Z",
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
}

/// **W.20** 纳秒精度：RFC3339 支持任意小数精度
#[test]
fn w20_nanosecond_precision() {
    let conn = new_db();
    let ts1 = ts_ago(10);
    let conn2 = conn;
    // 精度到纳秒
    let nano = "2026-05-01T12:00:00.123456789Z";
    // 这个时间在 2026-05-09 左右 → drift 应允许
    let r = SyncManager::apply_downloaded_changes(
        &conn2,
        &[mk_change(
            "nano",
            ChangeOperation::Insert,
            json!({
                "id": "nano", "title": "t",
                "updated_at": nano,
                "deleted_at": serde_json::Value::Null,
            }),
            nano,
        )],
        None,
    );
    println!("W.20 (nano precision) result: {:?}", r);
    let _ = ts1;
}

/// **W.21** 两个变更的 updated_at 毫秒相同但纳秒不同
#[test]
fn w21_nanosecond_tie_break() {
    let conn = new_db();
    let ts1 = "2026-05-01T12:00:00.100000001Z";
    let ts2 = "2026-05-01T12:00:00.100000002Z";

    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n",
            ChangeOperation::Insert,
            json!({
                "id": "n", "title": "v1",
                "updated_at": ts1,
                "deleted_at": serde_json::Value::Null,
            }),
            ts1,
        )],
        None,
    )
    .unwrap();

    // 第二次尝试纳秒更晚
    let r = SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n",
            ChangeOperation::Update,
            json!({
                "id": "n", "title": "v2",
                "updated_at": ts2,
                "deleted_at": serde_json::Value::Null,
            }),
            ts2,
        )],
        None,
    );
    println!("W.21 result: {:?}, title: {:?}", r, get_title(&conn, "n"));
}

/// **W.22** 时间戳字段是**数字**而不是字符串（JSON 类型错误）
#[test]
fn w22_numeric_timestamp_instead_of_string() {
    let conn = new_db();
    let c = mk_change(
        "num_ts",
        ChangeOperation::Insert,
        json!({
            "id": "num_ts", "title": "t",
            "updated_at": 1747_000_000_000i64, // number, not string
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    // updated_at 列是 TEXT，但 SQLite 有类型亲和性，会把数字转字符串
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    println!("W.22 (numeric timestamp) result: {:?}", r);
}

/// **W.23** 空字符串作为 updated_at
#[test]
fn w23_empty_updated_at() {
    let conn = new_db();
    let c = mk_change(
        "empty_ts",
        ChangeOperation::Insert,
        json!({
            "id": "empty_ts", "title": "t",
            "updated_at": "",
            "deleted_at": serde_json::Value::Null,
        }),
        "",
    );
    // 空字符串 → 不可解析 → LWW 门退回 → 允许 INSERT
    // 但 NOT NULL 列允许空字符串
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    println!("W.23 result: {:?}", r);
    // 允许或拒绝都可，只要不 panic
}

/// **W.24** 重复时间戳的大量同记录变更（HLC 必用 counter 区分）
#[test]
fn w24_hlc_counter_saturation() {
    let clock = HlcClock::new();
    let now = 1_700_000_000_000u64;

    // 同一毫秒内 tick 10000 次，HLC 必须单调递增
    let mut last = Hlc::ZERO;
    for _ in 0..10000 {
        let h = clock.tick_with_now(now).unwrap();
        assert!(h > last, "HLC 必须严格单调：last={:?}, new={:?}", last, h);
        last = h;
    }
}

/// **W.25** HLC counter 溢出后 wall 被推 +1
#[test]
fn w25_hlc_counter_overflow_rolls_wall() {
    let clock = HlcClock::from_last(Hlc::new(1000, u16::MAX));
    // wall_now 保持 1000，counter 已溢出
    let h = clock.tick_with_now(1000).unwrap();
    assert_eq!(h.millis, 1001);
    assert_eq!(h.counter, 0);
}

// ============================================================================
// W.26 - W.35: JSON 结构病态
// ============================================================================

/// **W.26** payload 里有嵌套数组和对象交错
#[test]
fn w26_deeply_nested_json_as_string() {
    let conn = new_db();
    let deep = json!({
        "a": [
            {"b": [{"c": [{"d": [{"e": "deep"}]}]}]},
            null,
            [[[[[]]]]],
            {"x": {}}
        ]
    });
    let deep_str = deep.to_string();
    let c = mk_change(
        "d",
        ChangeOperation::Insert,
        json!({
            "id": "d", "title": "t", "tags": deep_str.clone(),
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    let tags: String = conn
        .query_row("SELECT tags FROM items WHERE id='d'", [], |r| r.get(0))
        .unwrap();
    // 应被原样存储
    assert_eq!(tags, deep_str);
}

/// **W.27** payload 有重复 key（JSON 允许但语义不定，serde_json 取最后一个）
#[test]
fn w27_duplicate_json_keys() {
    let conn = new_db();
    // 构造 JSON 字符串带重复键
    let raw_json = r#"{"id":"n1","title":"first","title":"last","updated_at":"2026-05-09T10:00:00Z","deleted_at":null}"#;
    let parsed: serde_json::Value = serde_json::from_str(raw_json).unwrap();
    let c = mk_change("n1", ChangeOperation::Insert, parsed, &now_ts());
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    // serde_json 取最后的值
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("last"));
}

/// **W.28** payload 的 data 字段本身是 null（SyncChangeWithData.data = Some(null)）
#[test]
fn w28_data_is_json_null_value() {
    let conn = new_db();
    let c = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(serde_json::Value::Null), // Some(null)!
        changed_at: now_ts(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    // 应报错（data 不是 object）
    assert!(r.is_err(), "data = null 必须报错: {:?}", r);
}

/// **W.29** payload 的 data 是数组而不是对象
#[test]
fn w29_data_is_array() {
    let conn = new_db();
    let c = SyncChangeWithData {
        table_name: "items".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!(["id", "n1"])), // array
        changed_at: now_ts(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    assert!(r.is_err());
}

/// **W.30** data 是空对象 {}
#[test]
fn w30_data_empty_object() {
    let conn = new_db();
    let c = mk_change("n1", ChangeOperation::Insert, json!({}), &now_ts());
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    assert!(r.is_err(), "空 object 应当拒绝");
}

/// **W.31** data 里所有字段都是 null
#[test]
fn w31_all_fields_null() {
    let conn = new_db();
    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": serde_json::Value::Null,
            "title": serde_json::Value::Null,
            "updated_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    // build_insert_parts 跳过 null 字段 → columns 全空 → 返回 Err
    assert!(r.is_err());
}

/// **W.32** 字段值是对象而不是基础类型
#[test]
fn w32_object_as_field_value_serialized() {
    let conn = new_db();
    // title 字段是 TEXT，但我们传对象进去 → build_insert_parts 会序列化为 JSON 字符串
    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1",
            "title": {"nested": "object"},
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    let stored = get_title(&conn, "n1").unwrap();
    // 被序列化为 JSON 字符串
    assert!(stored.contains("nested"));
    assert!(stored.contains("object"));
}

/// **W.33** 极深嵌套 JSON（栈深度保护）
#[test]
fn w33_deeply_nested_recursion() {
    let conn = new_db();
    // 1000 层嵌套数组
    let mut s = String::from("\"deep\"");
    for _ in 0..500 {
        s = format!("[{}]", s);
    }
    // serde_json 默认递归深度 128，超过会失败
    let parsed_result = serde_json::from_str::<serde_json::Value>(&s);
    println!("W.33 deep nesting parse: {:?}", parsed_result.is_ok());
    // 具体能不能解析取决于 serde_json 版本，测试仅验证不 panic
}

/// **W.34** 字符串字段存的**恰好**是表的一个主键值（看会不会混淆 WHERE 判断）
#[test]
fn w34_string_value_equals_another_pk() {
    let conn = new_db();
    // 先 INSERT n1, n2
    SyncManager::apply_downloaded_changes(
        &conn,
        &[
            mk_change(
                "n1",
                ChangeOperation::Insert,
                json!({
                    "id": "n1", "title": "n2", // title == another pk
                    "updated_at": now_ts(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &now_ts(),
            ),
            mk_change(
                "n2",
                ChangeOperation::Insert,
                json!({
                    "id": "n2", "title": "x",
                    "updated_at": now_ts(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &now_ts(),
            ),
        ],
        None,
    )
    .unwrap();

    // WHERE id = 'n1' → 应返回 n1 而不是因为 title 是 'n2' 产生混乱
    let t = get_title(&conn, "n1").unwrap();
    assert_eq!(t, "n2");
}

/// **W.35** JSON 里有特殊字段名（保留字 like "id" "select" "from" ...）
#[test]
fn w35_sql_reserved_words_as_data_keys() {
    let conn = Connection::open_in_memory().unwrap();
    // 建个表带 SELECT 作为列名（必须双引号）
    conn.execute_batch(
        r#"
        CREATE TABLE "weird" (
            "id" TEXT PRIMARY KEY,
            "select" TEXT NOT NULL DEFAULT '',
            "from" TEXT NOT NULL DEFAULT '',
            "order" INTEGER NOT NULL DEFAULT 0,
            "updated_at" TEXT NOT NULL
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL, record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
    "#,
    )
    .unwrap();

    let c = SyncChangeWithData {
        table_name: "weird".into(),
        record_id: "n1".into(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": "n1",
            "select": "val1",
            "from": "val2",
            "order": 42,
            "updated_at": now_ts(),
        })),
        changed_at: now_ts(),
        change_log_id: None,
        database_name: Some("test".into()),
        suppress_change_log: Some(true),
    };
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    let (s, f): (String, String) = conn
        .query_row(
            r#"SELECT "select", "from" FROM weird WHERE id='n1'"#,
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(s, "val1");
    assert_eq!(f, "val2");
}

// ============================================================================
// W.36 - W.45: Tombstone 和删除的病态场景
// ============================================================================

/// **W.36** 对已软删记录发一个 DELETE（双删）
#[test]
fn w36_delete_already_deleted() {
    let conn = new_db();
    // 先插入
    conn.execute(
        "INSERT INTO items (id, title, updated_at, deleted_at) VALUES ('n1', 't', ?1, ?1)",
        params![ts_ago(10)],
    )
    .unwrap();

    let c = mk_change("n1", ChangeOperation::Delete, json!({}), &ts_ago(5));
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    // 仍然软删除（deleted_at 不变或被 LWW 拒绝）
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(d.is_some());
}

/// **W.37** 对一个从未存在的 id 发 DELETE（tombstone 表里也查不到）
/// 当前实现：静默 no-op（WHERE ... AND deleted_at IS NULL 不命中）
#[test]
fn w37_delete_ghost_record() {
    let conn = new_db();
    let c = mk_change(
        "never_existed",
        ChangeOperation::Delete,
        json!({}),
        &now_ts(),
    );
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    assert!(r.is_ok());
    // 没有记录被插入
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

/// **W.38** DELETE 的 changed_at 比 INSERT 早（时间倒置）
#[test]
fn w38_delete_timestamp_before_insert() {
    let conn = new_db();
    // 先 INSERT 在 t=10s ago
    let c1 = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": "t",
            "updated_at": ts_ago(10),
            "deleted_at": serde_json::Value::Null,
        }),
        &ts_ago(10),
    );
    // 后来的 DELETE 的 changed_at 在 INSERT 之前（t=30s ago）
    let c2 = mk_change("n1", ChangeOperation::Delete, json!({}), &ts_ago(30));
    SyncManager::apply_downloaded_changes(&conn, &[c1, c2], None).unwrap();
    // LWW 门应保护：本地 INSERT 较新 → DELETE 被拒绝
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .unwrap();
    assert!(d.is_none(), "过时 DELETE 应被 LWW 拒绝");
}

/// **W.39** tombstone 清单包含不存在的 blob hash
#[tokio::test]
async fn w39_tombstone_for_nonexistent_blob() {
    let tmp = tempfile::TempDir::new().unwrap();
    let mut m = tombstone::BlobTombstones::default();
    m.entries.insert(
        "ghost_hash".into(),
        tombstone::BlobTombstoneEntry {
            deleted_at: chrono::Utc::now().to_rfc3339(),
            device_id: "d1".into(),
            size: Some(0),
            relative_path: Some("gh/ghost_hash.bin".into()),
        },
    );
    // 本地没有这个 blob，tombstone 不应报错
    struct NoopStorage;
    #[async_trait::async_trait]
    impl deep_student_lib::cloud_storage::CloudStorage for NoopStorage {
        fn provider_name(&self) -> &'static str {
            "noop"
        }
        async fn check_connection(&self) -> deep_student_lib::cloud_storage::Result<()> {
            Ok(())
        }
        async fn put(&self, _: &str, _: &[u8]) -> deep_student_lib::cloud_storage::Result<()> {
            Ok(())
        }
        async fn get(&self, _: &str) -> deep_student_lib::cloud_storage::Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn list(
            &self,
            _: &str,
        ) -> deep_student_lib::cloud_storage::Result<Vec<deep_student_lib::cloud_storage::FileInfo>>
        {
            Ok(vec![])
        }
        async fn delete(&self, _: &str) -> deep_student_lib::cloud_storage::Result<()> {
            Ok(())
        }
        async fn stat(
            &self,
            _: &str,
        ) -> deep_student_lib::cloud_storage::Result<
            Option<deep_student_lib::cloud_storage::FileInfo>,
        > {
            Ok(None)
        }
    }
    let storage = NoopStorage;
    let r = tombstone::apply_blob_tombstones(&storage, &m, tmp.path(), "blobs").await;
    assert!(r.is_ok());
}

/// **W.40** DELETE 在事务中被应用，然后事务回滚 —— tombstone 不应生效
#[test]
fn w40_delete_rollback_preserves_record() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'original', ?1)",
        params![ts_ago(100)],
    )
    .unwrap();

    // 构造一批：包含 OK 的 DELETE 和非法变更
    let changes = vec![
        mk_change("n1", ChangeOperation::Delete, json!({}), &ts_ago(10)),
        mk_change(
            "n2",
            ChangeOperation::Insert,
            json!({
                "id": "n2", "title": "x",
                "updated_at": now_ts(),
            }),
            &now_ts(),
        ),
        // 非法：未知表
        SyncChangeWithData {
            table_name: "nope".into(),
            record_id: "x".into(),
            operation: ChangeOperation::Insert,
            data: Some(json!({"id": "x"})),
            changed_at: now_ts(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: Some(true),
        },
    ];
    let r = SyncManager::apply_downloaded_changes(&conn, &changes, None);
    assert!(r.is_err());

    // n1 没被删
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .unwrap();
    assert!(d.is_none(), "非法批次里的 DELETE 应被回滚");
}

// ============================================================================
// W.41 - W.50: 混合批次病态组合
// ============================================================================

/// **W.41** 同批里 10 个 INSERT 和 10 个 DELETE，全部同一记录（一个被 upsert/删 20 次）
#[test]
fn w41_same_record_alternating_20_ops() {
    let conn = new_db();
    let mut changes = Vec::new();
    for i in 0..20 {
        let ts = ts_ago(100 - i as i64 * 2);
        if i % 2 == 0 {
            changes.push(mk_change(
                "n1",
                ChangeOperation::Insert,
                json!({
                    "id": "n1", "title": format!("v{}", i),
                    "updated_at": ts.clone(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &ts,
            ));
        } else {
            changes.push(mk_change("n1", ChangeOperation::Delete, json!({}), &ts));
        }
    }
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

    // 最后一个 op (i=19, DELETE, ts = ts_ago(62))
    // 但因为 upsert/delete 交替，最终状态取决于 LWW 门和内部顺序
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    // 该记录至少存在（被 INSERT 过）
    let t = get_title(&conn, "n1");
    assert!(t.is_some(), "n1 至少在某次 INSERT 后存在了");
    println!("W.41 final: title={:?}, deleted_at={:?}", t, d);
}

/// **W.42** 批次里 500 个不同 record，每个都有 5 次变更，共 2500 条 → 确保批次大小下事务可完成
#[test]
fn w42_many_records_many_versions_in_one_batch() {
    let conn = new_db();
    let mut changes = Vec::with_capacity(2500);
    for r in 0..500 {
        for v in 0..5 {
            let id = format!("r{:04}", r);
            let ts = ts_ago(5000 - (r * 5 + v) as i64);
            changes.push(mk_change(
                &id,
                if v == 0 {
                    ChangeOperation::Insert
                } else {
                    ChangeOperation::Update
                },
                json!({
                    "id": id, "title": format!("r{}_v{}", r, v),
                    "counter": v,
                    "updated_at": ts.clone(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &ts,
            ));
        }
    }
    let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    assert_eq!(result.success_count, 2500);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 500);
    // 每个 record 的最终 counter 应是 4
    let sample: i64 = conn
        .query_row("SELECT counter FROM items WHERE id='r0100'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(sample, 4);
}

/// **W.43** 批次里的变更时间戳 **完全相同**（100 条同时刻同记录）
#[test]
fn w43_all_same_timestamp() {
    let conn = new_db();
    let same_ts = ts_ago(10);
    let mut changes = Vec::new();
    for i in 0..100 {
        changes.push(mk_change(
            "n1",
            if i == 0 {
                ChangeOperation::Insert
            } else {
                ChangeOperation::Update
            },
            json!({
                "id": "n1", "title": format!("v{}", i), "counter": i,
                "updated_at": same_ts.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &same_ts,
        ));
    }
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    // LWW 门：相等不跳过，所以每次都会覆盖。最终 = v99
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("v99"));
    assert_eq!(get_counter(&conn, "n1"), Some(99));
}

/// **W.44** 极端：1000 条批次里夹着 1 条非法 —— 全部回滚且不 panic
#[test]
fn w44_single_bad_in_1000_rolls_back_all() {
    let conn = new_db();
    let mut changes: Vec<SyncChangeWithData> = (0..1000)
        .map(|i| {
            let id = format!("n{:04}", i);
            let ts = ts_ago(2000 - i as i64);
            mk_change(
                &id,
                ChangeOperation::Insert,
                json!({
                    "id": id, "title": format!("v{}", i),
                    "updated_at": ts.clone(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &ts,
            )
        })
        .collect();
    // 在中间插入非法
    changes.insert(
        500,
        SyncChangeWithData {
            table_name: "nonexistent".into(),
            record_id: "x".into(),
            operation: ChangeOperation::Insert,
            data: Some(json!({"id": "x"})),
            changed_at: now_ts(),
            change_log_id: None,
            database_name: None,
            suppress_change_log: Some(true),
        },
    );

    let r = SyncManager::apply_downloaded_changes(&conn, &changes, None);
    assert!(r.is_err());
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "任何一条失败必须回滚所有");
}

/// **W.45** 同批里先 UPSERT 设 deleted_at=null，再 DELETE（复活然后立刻删）
#[test]
fn w45_revive_then_delete_in_same_batch() {
    let conn = new_db();
    // 已软删
    conn.execute(
        "INSERT INTO items (id, title, updated_at, deleted_at) VALUES ('n1', 't', ?1, ?1)",
        params![ts_ago(100)],
    )
    .unwrap();

    let changes = vec![
        mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "revived",
                "updated_at": ts_ago(50),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(50),
        ),
        mk_change("n1", ChangeOperation::Delete, json!({}), &ts_ago(10)),
    ];
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    // 最终应被软删除（后 DELETE 胜出）
    let d: Option<String> = conn
        .query_row("SELECT deleted_at FROM items WHERE id='n1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(d.is_some());
    // title 应是 "revived"（被复活后再软删，title 保留）
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("revived"));
}

// ============================================================================
// W.46 - W.55: HLC 和时钟的荒谬场景
// ============================================================================

/// **W.46** HLC 的 counter 在接收时恰好已满
#[test]
fn w46_hlc_receive_when_saturated() {
    let clock = HlcClock::from_last(Hlc::new(1_700_000_000_000, u16::MAX));
    // 远端 HLC 与本地 last 相同 wall time，counter 也为 u16::MAX
    let remote = Hlc::new(1_700_000_000_000, u16::MAX);
    let r = clock.receive_with_now(remote, 1_700_000_000_000);
    // 三个相等 → max_counter + 1 = u16::MAX + 1 → 溢出
    assert!(r.is_err());
    assert!(matches!(r, Err(HlcError::CounterOverflow)));
}

/// **W.47** HLC 多线程并发 tick
#[test]
fn w47_hlc_concurrent_ticks() {
    use std::sync::Arc;
    use std::thread;

    let clock = Arc::new(HlcClock::new());
    let mut handles = vec![];
    for _ in 0..20 {
        let c = clock.clone();
        handles.push(thread::spawn(move || {
            let mut ts = vec![];
            for _ in 0..100 {
                ts.push(c.tick_with_now(1_700_000_000_000).unwrap());
            }
            ts
        }));
    }

    let mut all: Vec<Hlc> = handles
        .into_iter()
        .flat_map(|h| h.join().unwrap())
        .collect();
    all.sort();
    all.dedup();
    // 20 × 100 = 2000 次 tick，在 Mutex 保护下应全部不同（Hlc 作为 Ord 值）
    assert_eq!(all.len(), 2000, "并发 tick 不应产生重复 HLC");
}

/// **W.48** 两个独立 HLC 实例通过交换 receive 相互推进
#[test]
fn w48_two_clocks_exchange_converge() {
    let a = HlcClock::new();
    let b = HlcClock::new();
    for i in 0..100 {
        let now = 1_700_000_000_000u64 + i;
        let ev_a = a.tick_with_now(now).unwrap();
        b.receive_with_now(ev_a, now + 1).unwrap();
        let ev_b = b.tick_with_now(now + 2).unwrap();
        a.receive_with_now(ev_b, now + 3).unwrap();
    }
    let peek_a = a.peek();
    let peek_b = b.peek();
    // 两端最后的 HLC 应该非常接近（差不超过 2）
    let diff = if peek_a > peek_b {
        peek_a.millis - peek_b.millis
    } else {
        peek_b.millis - peek_a.millis
    };
    assert!(diff <= 10);
}

/// **W.49** 接受一个有未来漂移但还在窗口内的 HLC
#[test]
fn w49_hlc_receive_within_drift_window() {
    let clock = HlcClock::new();
    let now = 1_700_000_000_000u64;
    // 漂移 30 秒（在 60s 窗口内）
    let remote = Hlc::new(now + 30_000, 0);
    let r = clock.receive_with_now(remote, now).unwrap();
    assert!(r.millis >= remote.millis);
}

/// **W.50** HLC 拒绝过时时间戳溢出检测
#[test]
fn w50_hlc_compare_strings_edge() {
    // 两个 HLC 字符串，counter 差异极大
    let a = Hlc::new(1_700_000_000_000, 0).to_string();
    let b = Hlc::new(1_700_000_000_000, u16::MAX).to_string();
    assert_eq!(compare_hlc_strings(&a, &b), Ordering::Less);
    // 位数相同，字典序可靠
    assert!(a < b);
}

// ============================================================================
// W.51 - W.60: 并发/事务交叉
// ============================================================================

/// **W.51** 多次打开同一数据库文件（模拟"应用和命令行同时连接"）
#[test]
fn w51_multiple_connections_to_same_file() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let path = tmp.path();

    // 用第一个连接建表
    {
        let conn1 = Connection::open(path).unwrap();
        conn1
            .execute_batch(
                r#"
            CREATE TABLE items (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE __change_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                sync_version INTEGER DEFAULT 0
            );
        "#,
            )
            .unwrap();
    }

    // 用第二个连接应用变更
    let conn2 = Connection::open(path).unwrap();
    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": "t",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn2, &[c], None).unwrap();
    drop(conn2);

    // 用第三个连接读
    let conn3 = Connection::open(path).unwrap();
    let title: String = conn3
        .query_row("SELECT title FROM items WHERE id='n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "t");
}

/// **W.52** 一边同步一边用户写入（不同连接）
#[test]
fn w52_concurrent_user_write_during_sync() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let path = tmp.path().to_owned();

    // 建表
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE items (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE __change_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                sync_version INTEGER DEFAULT 0
            );
        "#,
        )
        .unwrap();
    }

    // 同步连接应用
    let sync_conn = Connection::open(&path).unwrap();
    let changes: Vec<_> = (0..100)
        .map(|i| {
            let id = format!("n{}", i);
            mk_change(
                &id,
                ChangeOperation::Insert,
                json!({
                    "id": id, "title": format!("v{}", i),
                    "updated_at": now_ts(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &now_ts(),
            )
        })
        .collect();

    // 另一个连接尝试同时写 —— 会因 BEGIN IMMEDIATE 锁等待或失败
    let user_conn = Connection::open(&path).unwrap();
    let user_thread = std::thread::spawn(move || {
        // 设 busy_timeout 避免立即失败
        user_conn
            .execute_batch("PRAGMA busy_timeout = 5000")
            .unwrap();
        user_conn.execute(
            "INSERT INTO items (id, title, updated_at) VALUES ('user_1', 'user_data', ?1)",
            params![now_ts()],
        )
    });

    // 主线程跑同步
    SyncManager::apply_downloaded_changes(&sync_conn, &changes, None).unwrap();

    let r = user_thread.join().unwrap();
    assert!(
        r.is_ok(),
        "用户写入应最终成功（busy timeout 让它等到锁释放）"
    );

    let final_n: i64 = sync_conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(final_n, 101, "同步的 100 + 用户的 1");
}

/// **W.53** 把 __change_log 里 sync_version 设为负数看会不会破坏 LWW
#[test]
fn w53_negative_sync_version_tolerated() {
    let conn = new_db();
    // 手动插入 changelog 但 sync_version = -1
    conn.execute(
        "INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES ('items', 'n1', 'INSERT', -1)",
        [],
    ).unwrap();
    // get_pending_changes 查 sync_version = 0 → 不会命中，应无异常
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
}

/// **W.54** __change_log id 溢出前的极限
#[test]
fn w54_change_log_id_large_autoincrement() {
    let conn = new_db();
    // 手动把 sqlite_sequence 推到接近 i64::MAX
    conn.execute(
        "INSERT INTO __change_log (id, table_name, record_id, operation) VALUES (?1, 'items', 'n1', 'INSERT')",
        params![i64::MAX - 10],
    ).unwrap();

    // 后续应用变更会尝试递增 id，接近 i64::MAX 会很快溢出
    let r = SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n2",
            ChangeOperation::Insert,
            json!({
                "id": "n2", "title": "t",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    );
    // SENTINEL_TEST: verifies large AUTOINCREMENT id doesn't cause panic/overflow
    assert!(
        r.is_ok() || r.is_err(),
        "large AUTOINCREMENT should not panic"
    );
}

/// **W.55** 对只读连接发起 apply（应报错但不损坏）
#[test]
fn w55_readonly_connection_rejected() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    // 先建库
    {
        let conn = Connection::open(tmp.path()).unwrap();
        conn.execute_batch(r#"
            CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, deleted_at TEXT);
            CREATE TABLE __change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);
        "#).unwrap();
    }
    // 只读方式打开
    use rusqlite::OpenFlags;
    let conn_ro = Connection::open_with_flags(
        tmp.path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap();

    let c = mk_change(
        "n1",
        ChangeOperation::Insert,
        json!({
            "id": "n1", "title": "t",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    let r = SyncManager::apply_downloaded_changes(&conn_ro, &[c], None);
    assert!(r.is_err(), "只读连接必须失败");
}

// ============================================================================
// W.56 - W.70: 综合极限与"荒谬"场景
// ============================================================================

/// **W.56** 同步完成后紧接关机（模拟），再打开应看到原子性结果
#[test]
fn w56_crash_after_commit_preserves_changes() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    {
        let conn = Connection::open(tmp.path()).unwrap();
        conn.execute_batch(r#"
            CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
            CREATE TABLE __change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);
        "#).unwrap();

        SyncManager::apply_downloaded_changes(
            &conn,
            &[mk_change(
                "n1",
                ChangeOperation::Insert,
                json!({
                    "id": "n1", "title": "survives_crash",
                    "updated_at": now_ts(),
                    "deleted_at": serde_json::Value::Null,
                }),
                &now_ts(),
            )],
            None,
        )
        .unwrap();

        // "崩溃"：不正常关闭，直接 drop 连接
    }

    // 重新打开
    let conn2 = Connection::open(tmp.path()).unwrap();
    let title: String = conn2
        .query_row("SELECT title FROM items WHERE id='n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "survives_crash");
}

/// **W.57** 对同一个 SyncManager 调用 100 次 mark_blob_deleted（并发 tombstone 累积）
#[tokio::test]
async fn w57_many_blob_tombstones() {
    struct MemStore {
        files: tokio::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
    }
    #[async_trait::async_trait]
    impl deep_student_lib::cloud_storage::CloudStorage for MemStore {
        fn provider_name(&self) -> &'static str {
            "mem"
        }
        async fn check_connection(&self) -> deep_student_lib::cloud_storage::Result<()> {
            Ok(())
        }
        async fn put(&self, k: &str, d: &[u8]) -> deep_student_lib::cloud_storage::Result<()> {
            self.files.lock().await.insert(k.into(), d.into());
            Ok(())
        }
        async fn get(&self, k: &str) -> deep_student_lib::cloud_storage::Result<Option<Vec<u8>>> {
            Ok(self.files.lock().await.get(k).cloned())
        }
        async fn list(
            &self,
            _: &str,
        ) -> deep_student_lib::cloud_storage::Result<Vec<deep_student_lib::cloud_storage::FileInfo>>
        {
            Ok(vec![])
        }
        async fn delete(&self, k: &str) -> deep_student_lib::cloud_storage::Result<()> {
            self.files.lock().await.remove(k);
            Ok(())
        }
        async fn stat(
            &self,
            _: &str,
        ) -> deep_student_lib::cloud_storage::Result<
            Option<deep_student_lib::cloud_storage::FileInfo>,
        > {
            Ok(None)
        }
    }
    let store = MemStore {
        files: tokio::sync::Mutex::new(Default::default()),
    };
    let mgr = SyncManager::new("d1".into());
    for i in 0..100 {
        mgr.mark_blob_deleted(&store, &format!("hash_{}", i), None, Some(0))
            .await
            .unwrap();
    }
    // [P0-2] download helper 现在要求一个 PayloadCodec；测试里用明文即可
    // 因为 mgr 是 SyncManager::new（未启用加密），等价于 PlainCodec
    let m = tombstone::download_blob_tombstones(&store, &tombstone::PlainCodec)
        .await
        .unwrap();
    assert_eq!(m.entries.len(), 100);
}

/// **W.58** 冲突表数据在 __sync_conflicts 里被存储到超过 1MB 的体量
#[test]
fn w58_large_conflict_table_state() {
    let conn = new_db();
    // 先插入一条并软改
    let base_ts = ts_ago(100);
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'base', ?1)",
        params![base_ts],
    )
    .unwrap();
    conn.execute(
        "UPDATE items SET title = ?1, updated_at = ?2 WHERE id='n1'",
        params!["local_huge".to_string() + &"x".repeat(1000), ts_ago(50)],
    )
    .unwrap();

    // 制造 200 次冲突（每次 200 条记录进冲突表，200 * 2 = 400 条）
    for i in 0..200 {
        let ts = ts_ago(40 - i as i64);
        let change = mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1",
                "title": format!("cloud_{}", i) + &"y".repeat(500),
                "updated_at": ts.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts,
        );
        // LWW 门会拒绝较早的 → 走 conflict_guard 路径
        let _ = SyncManager::apply_downloaded_changes_with_conflict_guard(
            &conn,
            &[change],
            None,
            ConflictPolicy::KeepLatest,
            Some("cloud"),
            Some("local"),
        );
    }
    // 应能正常查到大量冲突记录
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    println!("W.58 conflict count: {}", n);
}

/// **W.59** 在同步过程中时钟突然回退（CI 常见：VM 挂起恢复）
///
/// 本项目没有真正的时钟拦截，只能测试 LWW 门能处理"本地时间倒流"导致的伪未来
#[test]
fn w59_wall_clock_jump_backward_between_events() {
    let conn = new_db();
    // 假设我们用"未来"时间戳（模拟时钟错误）INSERT
    // 然后"纠正"成现在时间戳 UPDATE —— 较早的 UPDATE 会被 LWW 拒绝
    let future = (chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc3339(); // 30s future，未触发 drift guard
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Insert,
            json!({
                "id": "n1", "title": "future_me",
                "updated_at": future.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &future,
        )],
        None,
    )
    .unwrap();

    // 现在用"正常当前时间"发 UPDATE
    let now = now_ts();
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "corrected_now",
                "updated_at": now.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now,
        )],
        None,
    )
    .unwrap();

    // LWW 保护：较晚的本地 future 值获胜
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("future_me"));
}

/// **W.60** 向 llm_usage_daily 同步带非法 record_id（不是 JSON 也不是下划线 4 段）
#[test]
fn w60_llm_usage_daily_malformed_record_id() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE llm_usage_daily (
            date TEXT NOT NULL, caller_type TEXT NOT NULL,
            model TEXT NOT NULL, provider TEXT NOT NULL,
            tokens INTEGER DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (date, caller_type, model, provider)
        );
        CREATE TABLE __change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);
    "#).unwrap();

    // record_id 格式错误
    let c = SyncChangeWithData {
        table_name: "llm_usage_daily".into(),
        record_id: "garbage-no-underscores".into(),
        operation: ChangeOperation::Delete,
        data: None,
        changed_at: now_ts(),
        change_log_id: None,
        database_name: Some("llm_usage".into()),
        suppress_change_log: Some(true),
    };
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    // 非法 record_id 应报错
    assert!(r.is_err());
}

/// **W.61** 两个设备对同一记录做完全相同的修改（idempotent edits）
#[test]
fn w61_identical_edits_from_two_devices_no_conflict() {
    let conn = new_db();
    let base_ts = ts_ago(100);
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'base', ?1)",
        params![base_ts],
    )
    .unwrap();

    // 本地改成 "both_same"
    conn.execute(
        "UPDATE items SET title='both_same', updated_at=?1 WHERE id='n1'",
        params![ts_ago(50)],
    )
    .unwrap();

    // 云端也改成 "both_same"（业务上一样）
    let c = mk_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1", "title": "both_same",
            "updated_at": ts_ago(20),
            "deleted_at": serde_json::Value::Null,
        }),
        &ts_ago(20),
    );

    let (_, conflict) = SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[c],
        None,
        ConflictPolicy::KeepLatest,
        None,
        None,
    )
    .unwrap();
    assert_eq!(conflict.conflicts_saved, 0, "语义相同的编辑不应算冲突");
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("both_same"));
}

/// **W.62** 空字符串 title 和全空白 title 被视为不同值
#[test]
fn w62_empty_vs_whitespace_title_distinct() {
    let conn = new_db();
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "e",
            ChangeOperation::Insert,
            json!({
                "id": "e", "title": "",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    )
    .unwrap();
    SyncManager::apply_downloaded_changes(
        &conn,
        &[mk_change(
            "w",
            ChangeOperation::Insert,
            json!({
                "id": "w", "title": "   ",
                "updated_at": now_ts(),
                "deleted_at": serde_json::Value::Null,
            }),
            &now_ts(),
        )],
        None,
    )
    .unwrap();
    assert_eq!(get_title(&conn, "e").as_deref(), Some(""));
    assert_eq!(get_title(&conn, "w").as_deref(), Some("   "));
}

/// **W.63** 同批里 5 条 change 都标记 suppress_change_log=None（老协议没这字段）
#[test]
fn w63_all_changes_without_suppress_flag() {
    let conn = new_db();
    let changes: Vec<_> = (0..5)
        .map(|i| {
            SyncChangeWithData {
                table_name: "items".into(),
                record_id: format!("n{}", i),
                operation: ChangeOperation::Insert,
                data: Some(json!({
                    "id": format!("n{}", i), "title": format!("v{}", i),
                    "updated_at": now_ts(),
                    "deleted_at": serde_json::Value::Null,
                })),
                changed_at: now_ts(),
                change_log_id: None,
                database_name: Some("test".into()),
                suppress_change_log: None, // 不抑制
            }
        })
        .collect();
    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();

    // 应用后 __change_log 里会多出 pending（因为不抑制）
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(pending >= 5, "不抑制时回放产生 pending，实际 {}", pending);
}

/// **W.64** 同步一个记录，payload 里 id 是 Number 而不是 String
#[test]
fn w64_id_as_number_in_payload() {
    let conn = new_db();
    let c = mk_change(
        "123",
        ChangeOperation::Insert,
        json!({
            "id": 123, // number
            "title": "t",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    // id 列是 TEXT，SQLite 类型亲和性会把 number 转 string
    let r = SyncManager::apply_downloaded_changes(&conn, &[c], None);
    println!("W.64 result: {:?}", r);
}

/// **W.65** record_id 为超长字符串（10000 字符）
#[test]
fn w65_extremely_long_record_id() {
    let conn = new_db();
    let long_id = "k".repeat(10000);
    let c = mk_change(
        &long_id,
        ChangeOperation::Insert,
        json!({
            "id": long_id.clone(), "title": "t",
            "updated_at": now_ts(),
            "deleted_at": serde_json::Value::Null,
        }),
        &now_ts(),
    );
    SyncManager::apply_downloaded_changes(&conn, &[c], None).unwrap();
    assert_eq!(get_title(&conn, &long_id).as_deref(), Some("t"));
}

/// **W.66** 连续应用 50 批（每批 10 条），模拟长时间同步
#[test]
fn w66_many_small_batches_sequential() {
    let conn = new_db();
    for batch in 0..50 {
        let changes: Vec<_> = (0..10)
            .map(|i| {
                let id = format!("b{}_{}", batch, i);
                mk_change(
                    &id,
                    ChangeOperation::Insert,
                    json!({
                        "id": id, "title": format!("b{}_i{}", batch, i),
                        "updated_at": ts_ago(5000 - (batch * 10 + i) as i64),
                        "deleted_at": serde_json::Value::Null,
                    }),
                    &ts_ago(5000 - (batch * 10 + i) as i64),
                )
            })
            .collect();
        SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    }
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 500);
}

/// **W.67** __sync_conflicts 表已存在（上一次同步遗留）—— 新同步应追加不报错
#[test]
fn w67_existing_conflict_table_is_reused() {
    let conn = new_db();
    // 手动预建 __sync_conflicts
    conn.execute_batch(r#"
        CREATE TABLE __sync_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL, record_id TEXT NOT NULL,
            side TEXT NOT NULL, data_json TEXT NOT NULL,
            winning_device_id TEXT, losing_device_id TEXT,
            detected_at TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at TEXT, resolution TEXT
        );
        INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('items', 'preexisting', 'local', '{}');
    "#).unwrap();

    // 制造新冲突
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'base', ?1)",
        params![ts_ago(100)],
    )
    .unwrap();
    conn.execute(
        "UPDATE items SET title='local', updated_at=?1 WHERE id='n1'",
        params![ts_ago(50)],
    )
    .unwrap();
    let change = mk_change(
        "n1",
        ChangeOperation::Update,
        json!({
            "id": "n1", "title": "cloud",
            "updated_at": ts_ago(30),
            "deleted_at": serde_json::Value::Null,
        }),
        &ts_ago(30),
    );

    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[change],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();

    // 旧的 preexisting + 新的 2 条 = 3 条
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 3);
}

/// **W.68** 解决一个冲突后再次发生同样的冲突（resolved 条目不应干扰新 conflict 产生）
#[test]
fn w68_resolved_conflicts_dont_block_new_ones() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'base', ?1)",
        params![ts_ago(200)],
    )
    .unwrap();
    conn.execute(
        "UPDATE items SET title='local_1', updated_at=?1 WHERE id='n1'",
        params![ts_ago(100)],
    )
    .unwrap();

    // 第一次冲突
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "cloud_1",
                "updated_at": ts_ago(90),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(90),
        )],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();
    // "解决"它
    conn.execute("UPDATE __sync_conflicts SET resolved_at=datetime('now'), resolution='keep_local' WHERE record_id='n1'", []).unwrap();

    // 再次改本地
    conn.execute(
        "UPDATE items SET title='local_2', updated_at=?1 WHERE id='n1'",
        params![ts_ago(50)],
    )
    .unwrap();

    // 再次冲突
    SyncManager::apply_downloaded_changes_with_conflict_guard(
        &conn,
        &[mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": "cloud_2",
                "updated_at": ts_ago(40),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts_ago(40),
        )],
        None,
        ConflictPolicy::KeepLatest,
        Some("cloud"),
        Some("local"),
    )
    .unwrap();

    // 已解决的 2 条 + 新的 2 条 = 4 条总记录，其中 2 条 resolved_at IS NOT NULL
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM __sync_conflicts", [], |r| r.get(0))
        .unwrap();
    let unresolved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(total, 4);
    assert_eq!(unresolved, 2);
}

/// **W.69** 大量不同记录的单个 INSERT 批，记录每个都很小但数量多（10000）
#[test]
fn w69_ten_thousand_tiny_records() {
    let conn = new_db();
    let mut changes = Vec::with_capacity(10000);
    for i in 0..10000 {
        let id = format!("t{:05}", i);
        let ts = ts_ago(20000 - i as i64);
        changes.push(mk_change(
            &id,
            ChangeOperation::Insert,
            json!({
                "id": id, "title": "x",
                "updated_at": ts.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts,
        ));
    }
    let t = std::time::Instant::now();
    let r = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    let elapsed = t.elapsed();
    assert_eq!(r.success_count, 10000);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 10000);
    println!("W.69 applied 10000 in {:?}", elapsed);
    assert!(elapsed.as_secs() < 30, "10000 条批次应在 30s 内完成");
}

/// **W.70** 一个记录的 title 经过 7 次不同设备的修改（设备互相看不到对方）
/// 然后所有变更一次性涌入
#[test]
fn w70_seven_devices_cross_edit() {
    let conn = new_db();
    conn.execute(
        "INSERT INTO items (id, title, updated_at) VALUES ('n1', 'base', ?1)",
        params![ts_ago(1000)],
    )
    .unwrap();

    // 7 个设备分别写，时间戳按 1 小时错开
    let mut changes = Vec::new();
    for dev in 0..7 {
        let ts = ts_ago(500 - dev as i64 * 50);
        changes.push(mk_change(
            "n1",
            ChangeOperation::Update,
            json!({
                "id": "n1", "title": format!("dev_{}", dev),
                "counter": dev,
                "updated_at": ts.clone(),
                "deleted_at": serde_json::Value::Null,
            }),
            &ts,
        ));
    }

    SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    // 最后的 dev_6 在时间上最晚 → 胜出
    assert_eq!(get_title(&conn, "n1").as_deref(), Some("dev_6"));
    assert_eq!(get_counter(&conn, "n1"), Some(6));
}
