//! Anki AI-native 收尾接线的真实 SQLite 回归测试。
//!
//! 覆盖三个机器字段/设置边界：
//! 1. 偏好观察经 extract/consolidate 后写入 settings，重载后可强化并检索；
//! 2. Image Occlusion 的 `_occlusion` 与普通 extra_fields 一起入库、回读；
//! 3. `_original_generation` 以 HashMap<String, String> 的二次编码形态落库，
//!    后续编辑卡片正文时保持初始快照不变。

use std::collections::HashMap;

use deep_student_lib::anki_gold_set::{
    extract_original_from_extras, extract_original_generation, insert_original_generation_once,
};
use deep_student_lib::anki_image_occlusion::{
    build_occlusion_draft_marker, extract_occlusion_draft_fields, parse_occlusion_field,
    OcclusionConfig, OCCLUSION_FIELD, OCCLUSION_TAG,
};
use deep_student_lib::anki_preference_memory::{
    consolidate, extract_preferences, retrieve_preference_prompt, PreferenceStore,
    SessionObservation,
};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::database::Database;
use deep_student_lib::models::{AnkiCard, DocumentTask, TaskStatus};
use tempfile::TempDir;

const PREFERENCE_STORE_KEY: &str = "chatanki_preference_memory_store";

fn setup_db() -> (TempDir, Database) {
    let temp_dir = TempDir::new().expect("create temp dir");
    let root = temp_dir.path().to_path_buf();
    let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("migrate mistakes database");
    let db = Database::new(&root.join("mistakes.db")).expect("open mistakes database");
    (temp_dir, db)
}

fn seed_task(db: &Database, task_id: &str, document_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    let task = DocumentTask {
        id: task_id.to_string(),
        document_id: document_id.to_string(),
        original_document_name: "wiring-test.md".to_string(),
        segment_index: 0,
        content_segment: "integration fixture".to_string(),
        status: TaskStatus::Streaming,
        created_at: now.clone(),
        updated_at: now,
        error_message: None,
        anki_generation_options_json: "{}".to_string(),
    };
    db.save_document_task_with_cards_atomic(&task, &[])
        .expect("seed document task");
}

fn make_card(
    id: &str,
    task_id: &str,
    front: &str,
    back: &str,
    text: Option<&str>,
    tags: Vec<String>,
    extra_fields: HashMap<String, String>,
) -> AnkiCard {
    let now = chrono::Utc::now().to_rfc3339();
    AnkiCard {
        id: id.to_string(),
        task_id: task_id.to_string(),
        front: front.to_string(),
        back: back.to_string(),
        text: text.map(str::to_string),
        tags,
        images: Vec::new(),
        is_error_card: false,
        error_content: None,
        created_at: now.clone(),
        updated_at: now,
        extra_fields,
        template_id: None,
    }
}

#[test]
fn preference_write_round_trip_reinforces_and_retrieves() {
    let (_temp_dir, db) = setup_db();
    let observation = SessionObservation {
        extra_requirements: Some(
            "请用中文回答，不要翻译专业术语，每份材料最多 7 张卡，请用学术填空题模板".to_string(),
        ),
        template_used: Some("学术填空题".to_string()),
        generated_count: 7,
        ..Default::default()
    };
    let candidates = extract_preferences(&observation);
    assert_eq!(candidates.len(), 4, "四类显式偏好都应被抽取");

    let mut store = PreferenceStore::default();
    let first = consolidate(&mut store, &candidates, 1_000);
    assert_eq!(first.added.len(), 4);
    db.save_setting(
        PREFERENCE_STORE_KEY,
        &serde_json::to_string(&store).expect("serialize preference store"),
    )
    .expect("persist preference store");

    let persisted = db
        .get_setting(PREFERENCE_STORE_KEY)
        .expect("read preference setting")
        .expect("preference setting exists");
    let mut reloaded: PreferenceStore =
        serde_json::from_str(&persisted).expect("deserialize persisted preference store");
    assert_eq!(reloaded.entries.len(), 4);
    assert!(reloaded
        .entries
        .iter()
        .all(|entry| entry.evidence_count == 1));

    let second = consolidate(&mut reloaded, &candidates, 2_000);
    assert_eq!(second.reinforced.len(), 4);
    assert!(second.added.is_empty());
    db.save_setting(
        PREFERENCE_STORE_KEY,
        &serde_json::to_string(&reloaded).expect("serialize reinforced store"),
    )
    .expect("overwrite preference store atomically");

    let persisted = db
        .get_setting(PREFERENCE_STORE_KEY)
        .expect("read reinforced setting")
        .expect("reinforced setting exists");
    let final_store: PreferenceStore =
        serde_json::from_str(&persisted).expect("deserialize reinforced store");
    assert!(final_store
        .entries
        .iter()
        .all(|entry| entry.evidence_count == 2 && entry.last_seen_ms == 2_000));

    let hint = retrieve_preference_prompt(
        &final_store,
        "把讲义做成学术填空题",
        &["学术填空题".to_string()],
        400,
    );
    assert!(hint.contains("中文"), "{hint}");
    assert!(hint.contains("不要翻译"), "{hint}");
    assert!(hint.contains("7 张"), "{hint}");
    assert!(hint.contains("学术填空题"), "{hint}");
}

#[test]
fn occlusion_extra_fields_survive_anki_database_round_trip() {
    let (_temp_dir, db) = setup_db();
    seed_task(&db, "task-occlusion-wiring", "doc-occlusion-wiring");

    let marker = build_occlusion_draft_marker(
        "vfs://images/neural-network.png",
        "[IMAGE_DESC: 输入层；隐藏层；输出层]",
        &OcclusionConfig::default(),
    )
    .expect("valid image description should produce marker");
    let fields = extract_occlusion_draft_fields(&marker).expect("marker should produce fields");

    let mut extras = fields.extra_fields.clone();
    extras.insert("model_note".to_string(), "模型原有扩展字段".to_string());
    let card = make_card(
        "card-occlusion-wiring",
        "task-occlusion-wiring",
        "神经网络有哪些层？",
        "输入层、隐藏层、输出层",
        None,
        vec!["模型标签".to_string(), OCCLUSION_TAG.to_string()],
        extras,
    );
    assert!(db.insert_anki_card(&card).expect("insert occlusion card"));

    let cards = db
        .get_cards_for_task("task-occlusion-wiring")
        .expect("reload occlusion card");
    assert_eq!(cards.len(), 1);
    let loaded = &cards[0];
    assert_eq!(
        loaded.extra_fields.get("model_note").map(String::as_str),
        Some("模型原有扩展字段")
    );
    assert!(loaded.extra_fields.contains_key(OCCLUSION_FIELD));
    assert!(loaded.tags.iter().any(|tag| tag == OCCLUSION_TAG));

    let parsed = parse_occlusion_field(&loaded.extra_fields).expect("stored spec should parse");
    assert_eq!(parsed.image_ref, "vfs://images/neural-network.png");
    let labels: Vec<&str> = parsed
        .boxes
        .iter()
        .map(|item| item.label.as_str())
        .collect();
    assert_eq!(labels, vec!["输入层", "隐藏层", "输出层"]);
    assert_eq!(
        parsed
            .boxes
            .iter()
            .map(|item| item.cloze_index)
            .collect::<Vec<_>>(),
        vec![Some(1), Some(2), Some(3)]
    );
}

#[test]
fn original_generation_snapshot_survives_card_edits() {
    let (_temp_dir, db) = setup_db();
    seed_task(&db, "task-original-wiring", "doc-original-wiring");

    let mut extras = HashMap::new();
    assert!(
        insert_original_generation_once(&mut extras, "什么是栈？", "一种数据结构", None)
            .expect("write original generation snapshot")
    );
    extras.insert("source".to_string(), "generator".to_string());
    let card = make_card(
        "card-original-wiring",
        "task-original-wiring",
        "什么是栈？",
        "一种数据结构",
        None,
        vec!["数据结构".to_string()],
        extras,
    );
    assert!(db.insert_anki_card(&card).expect("insert generated card"));

    let mut loaded = db
        .get_cards_for_task("task-original-wiring")
        .expect("load generated card")
        .pop()
        .expect("generated card exists");
    let snapshot =
        extract_original_from_extras(&loaded.extra_fields).expect("in-memory snapshot parses");
    assert_eq!(snapshot.front, "什么是栈？");
    assert_eq!(snapshot.back, "一种数据结构");
    assert_eq!(snapshot.text, None);

    loaded.front = "栈遵循什么访问顺序？".to_string();
    loaded.back = "后进先出（LIFO）".to_string();
    loaded.text = Some("用户补充说明".to_string());
    assert_eq!(
        db.update_anki_card_rows(&loaded)
            .expect("persist user edit"),
        1
    );

    let edited = db
        .get_cards_for_task("task-original-wiring")
        .expect("reload edited card")
        .pop()
        .expect("edited card exists");
    assert_eq!(edited.front, "栈遵循什么访问顺序？");
    assert_eq!(edited.back, "后进先出（LIFO）");
    let unchanged =
        extract_original_from_extras(&edited.extra_fields).expect("snapshot remains parseable");
    assert_eq!(unchanged.front, "什么是栈？");
    assert_eq!(unchanged.back, "一种数据结构");
    assert_eq!(
        edited.extra_fields.get("source").map(String::as_str),
        Some("generator")
    );

    let raw_extra_fields_json: String = db
        .get_conn_safe()
        .expect("database connection")
        .query_row(
            "SELECT extra_fields_json FROM anki_cards WHERE id = ?1",
            ["card-original-wiring"],
            |row| row.get(0),
        )
        .expect("read raw extra_fields_json");
    let raw_snapshot = extract_original_generation(&raw_extra_fields_json)
        .expect("double-encoded database snapshot parses");
    assert_eq!(raw_snapshot, unchanged);
}
