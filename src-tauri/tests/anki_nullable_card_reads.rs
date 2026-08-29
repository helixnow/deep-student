//! Wave2-E 第 7 轮（r7-07）：anki_cards 读侧 nullable 加固回归测试
//!
//! ⚠️ 执行纪律：本文件第 7 轮只写不跑，cargo test 统一到第 8 轮执行
//! （`cargo test --test anki_nullable_card_reads`）。
//!
//! 契约对象：第 5 轮 r5-03（docs/dev/wave2-E-r5-03-nullable.md）落地的读侧
//! nullable 防御 —— 历史库 / 导入 / 同步产生的 anki_cards 行可能在
//! `front` / `back` / `text` / `tags_json` / `images_json` / `extra_fields_json`
//! 留下 NULL；修复前手写 mapper 直取 `String` 会让整条查询以
//! `InvalidColumnType` 失败（一行坏 → 整批卡片读不出来）。修复后语义：
//! NULL → 默认值（`front`/`back` → 空串；`tags`/`images` → 空 Vec；
//! `extra_fields` → 空 HashMap；`text` 本身是 `Option`，保持 None）。
//!
//! ## 为什么要手建「历史形态」库
//!
//! 当前迁移产物（migrations/mistakes/V20260130__init.sql）里 `front`/`back`
//! 已带 NOT NULL，直接对迁移后的库 INSERT NULL 会被约束拒绝——恰好说明
//! 该缺陷只存在于历史库（旧建表语句无 NOT NULL；兼容性 ALTER TABLE 补列
//! 也允许 NULL）。而 `Database::new` 只开连接不建表（生产 schema 由
//! MigrationCoordinator 负责），所以本测试先用裸 rusqlite 建出历史形态的
//! 最小 schema，再用 `Database::new` 打开同一文件，即可用**公开读 API**
//! 真实复现「NULL 行进库后被读出」的场景。
//!
//! ## 覆盖的公开读 API（对应 r5-03 改动点）
//!
//! - `Database::get_cards_for_task`（内联 mapper）
//! - `Database::get_cards_for_document`（内联 mapper）
//! - `Database::get_cards_by_ids`（内联 mapper）
//! - `Database::get_cards_for_document_for_session`（共享 `map_anki_card_row`）
//! - `Database::get_recent_anki_cards`（内联 mapper）
//! - `Database::list_anki_library_cards`（内联 mapper + fsrs LEFT JOIN）
//! - `FsrsReviewService::list_feedback_rows`（front / tags_json 兜底）
//!
//! ## 第 8 轮 in-crate 欠账（本文件无法覆盖，见 r7 文档）
//!
//! - `fsrs_review_service::get_due_inner::map_due_row`：SQL 已 COALESCE，
//!   读侧 Option 属双保险，需 in-crate 单测直接构造无 COALESCE 场景。
//! - `fsrs_review_service::load_review_cards_for_states`（私有）：
//!   「NULL → 兜底默认」与「非法 JSON → 仍报 AppError::database 硬错误」的
//!   区分语义只能 in-crate #[cfg(test)] 锁定。
//! - `is_error_card` 为 NULL 不在 r5-03 契约内（mapper 仍硬取 i32），
//!   本测试的历史 schema 保留其 NOT NULL DEFAULT 0，不扩大契约面。

use std::sync::Arc;

use deep_student_lib::database::Database;
use deep_student_lib::fsrs_review_service::FsrsReviewService;
use rusqlite::{params, Connection};
use tempfile::TempDir;

/// 历史形态最小 schema：只含读查询引用到的表和列；
/// 六个目标文本列全部**不带** NOT NULL（复现旧建表语句 / 兼容性补列）。
const LEGACY_SCHEMA: &str = "
    CREATE TABLE document_tasks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        original_document_name TEXT NOT NULL DEFAULT '',
        segment_index INTEGER NOT NULL DEFAULT 0,
        content_segment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Completed',
        created_at TEXT NOT NULL DEFAULT '2026-08-01T00:00:00.000Z',
        updated_at TEXT NOT NULL DEFAULT '2026-08-01T00:00:00.000Z',
        anki_generation_options_json TEXT NOT NULL DEFAULT '{}',
        source_session_id TEXT,
        deleted_at TEXT
    );
    CREATE TABLE anki_cards (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        front TEXT,
        back TEXT,
        text TEXT,
        tags_json TEXT,
        images_json TEXT,
        extra_fields_json TEXT,
        is_error_card INTEGER NOT NULL DEFAULT 0,
        error_content TEXT,
        card_order_in_task INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        template_id TEXT,
        source_type TEXT,
        source_id TEXT,
        deleted_at TEXT
    );
    CREATE TABLE fsrs_card_states (
        id TEXT PRIMARY KEY,
        anki_card_id TEXT NOT NULL,
        state INTEGER NOT NULL DEFAULT 0,
        stability REAL,
        difficulty REAL,
        due_ms INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        reps INTEGER NOT NULL DEFAULT 0,
        last_review_ms INTEGER,
        suspended INTEGER DEFAULT 0,
        deleted_at TEXT
    );
";

fn open_legacy_db() -> (TempDir, Arc<Database>) {
    let tmp = TempDir::new().expect("create temp dir");
    let db_path = tmp.path().join("mistakes.db");
    {
        let conn = Connection::open(&db_path).expect("open raw sqlite");
        conn.execute_batch(LEGACY_SCHEMA)
            .expect("create legacy schema");
    }
    let db = Arc::new(Database::new(&db_path).expect("open Database over legacy file"));
    (tmp, db)
}

fn seed_task(db: &Database, task_id: &str, document_id: &str, session_id: &str) {
    let conn = db.get_conn_safe().expect("conn");
    conn.execute(
        "INSERT INTO document_tasks (id, document_id, original_document_name, source_session_id)
         VALUES (?1, ?2, 'legacy.md', ?3)",
        params![task_id, document_id, session_id],
    )
    .expect("insert task");
}

/// 直插一行历史卡：任一目标列传 None 即落 NULL。
#[allow(clippy::too_many_arguments)]
fn seed_card(
    db: &Database,
    card_id: &str,
    task_id: &str,
    front: Option<&str>,
    back: Option<&str>,
    text: Option<&str>,
    tags_json: Option<&str>,
    images_json: Option<&str>,
    extra_fields_json: Option<&str>,
    created_at: &str,
) {
    let conn = db.get_conn_safe().expect("conn");
    conn.execute(
        "INSERT INTO anki_cards (
            id, task_id, front, back, text, tags_json, images_json, extra_fields_json,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            card_id,
            task_id,
            front,
            back,
            text,
            tags_json,
            images_json,
            extra_fields_json,
            created_at
        ],
    )
    .expect("insert legacy card");
}

/// 全 NULL 行 + 健康对照行 + 非法 JSON 行，三卡同任务。
fn seed_standard_fixture(db: &Database) {
    seed_task(db, "task-legacy", "doc-legacy", "sess-legacy");
    // 六个目标列全 NULL 的历史坏行
    seed_card(
        db,
        "card-null",
        "task-legacy",
        None,
        None,
        None,
        None,
        None,
        None,
        "2026-08-20T08:00:01.000Z",
    );
    // 健康对照行：读侧兜底不得污染正常数据
    seed_card(
        db,
        "card-ok",
        "task-legacy",
        Some("front-ok"),
        Some("back-ok"),
        Some("text {{c1::ok}}"),
        Some(r#"["tag-a","tag-b"]"#),
        Some(r#"["img-1.png"]"#),
        Some(r#"{"hint":"h1"}"#),
        "2026-08-20T08:00:02.000Z",
    );
    // 非 NULL 但内容损坏的 JSON：mapper 软解析（.ok()）应兜底为空集合，
    // 而非让整条查询失败（与 load_review_cards_for_states 的硬错误语义不同，
    // 后者归第 8 轮 in-crate 锁定）。
    seed_card(
        db,
        "card-badjson",
        "task-legacy",
        Some("front-bad"),
        Some("back-bad"),
        None,
        Some("{not-json"),
        Some("also-not-json"),
        Some("[broken"),
        "2026-08-20T08:00:03.000Z",
    );
}

fn assert_null_card_defaults(card: &deep_student_lib::models::AnkiCard) {
    assert_eq!(card.id, "card-null");
    assert_eq!(card.front, "", "NULL front 必须兜底为空串");
    assert_eq!(card.back, "", "NULL back 必须兜底为空串");
    assert_eq!(card.text, None, "text 本身是 Option，NULL 保持 None");
    assert!(card.tags.is_empty(), "NULL tags_json 必须兜底为空 Vec");
    assert!(card.images.is_empty(), "NULL images_json 必须兜底为空 Vec");
    assert!(
        card.extra_fields.is_empty(),
        "NULL extra_fields_json 必须兜底为空 HashMap"
    );
}

fn assert_ok_card_intact(card: &deep_student_lib::models::AnkiCard) {
    assert_eq!(card.id, "card-ok");
    assert_eq!(card.front, "front-ok");
    assert_eq!(card.back, "back-ok");
    assert_eq!(card.text.as_deref(), Some("text {{c1::ok}}"));
    assert_eq!(card.tags, vec!["tag-a".to_string(), "tag-b".to_string()]);
    assert_eq!(card.images, vec!["img-1.png".to_string()]);
    assert_eq!(
        card.extra_fields.get("hint").map(String::as_str),
        Some("h1")
    );
}

#[test]
fn get_cards_for_task_defaults_null_columns_instead_of_failing_the_batch() {
    let (_tmp, db) = open_legacy_db();
    seed_standard_fixture(&db);

    // 修复前的行为：card-null 触发 InvalidColumnType，三张卡一张都读不出。
    let cards = db
        .get_cards_for_task("task-legacy")
        .expect("NULL 行不得让整批读取失败");
    assert_eq!(cards.len(), 3, "坏行兜底后整批可读");

    assert_null_card_defaults(&cards[0]);
    assert_ok_card_intact(&cards[1]);

    // 非法 JSON 软解析：不失败、不污染其他字段
    let bad = &cards[2];
    assert_eq!(bad.id, "card-badjson");
    assert_eq!(bad.front, "front-bad");
    assert!(bad.tags.is_empty(), "非法 tags_json 软解析为空 Vec");
    assert!(bad.images.is_empty(), "非法 images_json 软解析为空 Vec");
    assert!(
        bad.extra_fields.is_empty(),
        "非法 extra_fields_json 软解析为空 HashMap"
    );
}

#[test]
fn document_id_and_recent_reads_share_the_same_null_defaults() {
    let (_tmp, db) = open_legacy_db();
    seed_standard_fixture(&db);

    // 三条内联 mapper 的读路径必须与 get_cards_for_task 行为一致
    let by_document = db
        .get_cards_for_document("doc-legacy")
        .expect("按文档读取不得失败");
    assert_eq!(by_document.len(), 3);
    assert_null_card_defaults(&by_document[0]);
    assert_ok_card_intact(&by_document[1]);

    let by_ids = db
        .get_cards_by_ids(&["card-null".to_string(), "card-ok".to_string()])
        .expect("按 ID 读取不得失败");
    assert_eq!(by_ids.len(), 2);
    assert_null_card_defaults(&by_ids[0]);
    assert_ok_card_intact(&by_ids[1]);

    let recent = db.get_recent_anki_cards(10).expect("最近卡片读取不得失败");
    assert_eq!(recent.len(), 3, "状态恢复读路径同样容忍 NULL 行");
    // created_at DESC：card-null 排最后
    assert_null_card_defaults(&recent[2]);
}

#[test]
fn session_scoped_read_uses_shared_mapper_defaults_and_keeps_ownership_guard() {
    let (_tmp, db) = open_legacy_db();
    seed_standard_fixture(&db);

    // 共享 mapper map_anki_card_row 路径
    let owned = db
        .get_cards_for_document_for_session("doc-legacy", "sess-legacy")
        .expect("会话内读取不得失败")
        .expect("归属校验通过时应返回卡片");
    assert_eq!(owned.len(), 3);
    assert_null_card_defaults(&owned[0]);
    assert_ok_card_intact(&owned[1]);

    // nullable 兜底不得放宽归属校验（fail-closed 语义不变）
    let foreign = db
        .get_cards_for_document_for_session("doc-legacy", "sess-other")
        .expect("会话外读取不得失败");
    assert!(foreign.is_none(), "非归属会话仍须返回 None");
}

#[test]
fn library_listing_survives_null_rows_and_reports_full_totals() {
    let (_tmp, db) = open_legacy_db();
    seed_standard_fixture(&db);
    // 给对照卡补一条调度状态，覆盖 LEFT JOIN 两侧
    {
        let conn = db.get_conn_safe().expect("conn");
        conn.execute(
            "INSERT INTO fsrs_card_states (id, anki_card_id, state, stability, due_ms, lapses, reps, last_review_ms)
             VALUES ('fs-ok', 'card-ok', 2, 3.0, 0, 1, 3, 1000)",
            [],
        )
        .expect("insert fsrs state");
    }

    let (cards, total) = db
        .list_anki_library_cards(None, None, None, 1, 50)
        .expect("卡库分页读取不得失败");
    // 修复前 NULL 行会让整页查询失败；修复后总数与页内都包含坏行
    assert_eq!(total, 3);
    assert_eq!(cards.len(), 3);

    let null_row = cards
        .iter()
        .find(|c| c.card.id == "card-null")
        .expect("NULL 行必须出现在卡库列表中");
    assert_eq!(null_row.card.front, "");
    assert_eq!(null_row.card.back, "");
    assert!(null_row.card.tags.is_empty());
    assert!(null_row.card.images.is_empty());
    assert!(null_row.card.extra_fields.is_empty());
    assert!(!null_row.enqueued, "无调度行的坏卡保持未入队");
    assert_eq!(null_row.state, None);

    let ok_row = cards
        .iter()
        .find(|c| c.card.id == "card-ok")
        .expect("对照卡在列");
    assert_eq!(ok_row.card.front, "front-ok");
    assert!(ok_row.enqueued, "有调度行的卡正常入队");
    assert_eq!(ok_row.state, Some(2));
}

#[test]
fn fsrs_feedback_rows_default_null_front_and_tags() {
    let (_tmp, db) = open_legacy_db();
    seed_standard_fixture(&db);
    // 让全 NULL 卡带上复习状态，走 list_feedback_rows 的联表读路径
    {
        let conn = db.get_conn_safe().expect("conn");
        conn.execute(
            "INSERT INTO fsrs_card_states (id, anki_card_id, state, stability, due_ms, lapses, reps, last_review_ms)
             VALUES ('fs-null', 'card-null', 2, 2.5, 0, 4, 6, 1000)",
            [],
        )
        .expect("insert fsrs state");
    }

    let service = FsrsReviewService::new(db.clone());
    let rows = service
        .list_feedback_rows(10)
        .expect("反馈回流读取不得因 NULL front/tags_json 失败");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.anki_card_id, "card-null");
    assert_eq!(row.front, "", "NULL front 兜底为空串");
    assert!(row.tags.is_empty(), "NULL tags_json 兜底为空 Vec");
    assert_eq!(row.lapses, 4);
    assert_eq!(row.stability, Some(2.5));
}
