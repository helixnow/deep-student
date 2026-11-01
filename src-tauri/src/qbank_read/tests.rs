//! `vfs::qbank_read` 的单测。
//!
//! 读取逻辑已下沉到 vfs（它只读 vfs 表）；但种子数据要用题库领域的
//! `QuestionAuthoringService` 写入，测试因此留在 app crate，避免 vfs 反向依赖领域模块。
//! 模块路径保持 `qbank_read::tests::…`（见 lib.rs 里的同名重导出模块）。

use super::*;
use crate::qbank_authoring_service::QuestionAuthoringService;
use crate::qbank_document::QuestionDocument;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsExamRepo;
use crate::vfs::types::VfsCreateExamSheetParams;
use serde_json::json;
use std::sync::Arc;
#[test]
fn canonical_context_reads_current_questions_and_deduplicates_materials() {
    let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
    let db = Arc::new(db);
    let exam = VfsExamRepo::create_exam_sheet(
        &db,
        VfsCreateExamSheetParams {
            exam_name: Some("test".into()),
            temp_id: "tmp".into(),
            preview_json: json!({"pages":[{"cards":[{"ocr_text":"STALE SNAPSHOT"}]}]}),
            metadata_json: json!({}),
            status: "empty".into(),
            folder_id: None,
        },
    )
    .unwrap();
    let doc:QuestionDocument=serde_json::from_value(json!({"schema_version":2,"mode":"extract","materials":[{"local_id":"m1","content":"Shared passage"}],"groups":[{"local_id":"g1","label":"Reading","material_ids":["m1"],"question_ids":["q1","q2"]}],"questions":[{"local_id":"q1","content":"First","question_type":"short_answer","group_id":"g1"},{"local_id":"q2","content":"Second","question_type":"short_answer","group_id":"g1"}]})).unwrap();
    let authoring = QuestionAuthoringService::new(db.clone());
    let receipt = authoring.submit_document(&exam.id, &doc, "seed").unwrap();
    let conn = db.get_conn_safe().unwrap();
    conn.execute(
        "UPDATE questions SET content='CURRENT EDIT' WHERE id=?1",
        [&receipt.question_ids[0]],
    )
    .unwrap();
    let context = context_with_conn(&conn, &exam.id).unwrap().unwrap();
    assert_eq!(context["materials"].as_array().unwrap().len(), 1);
    assert_eq!(context["questions"].as_array().unwrap().len(), 2);
    let text = context_text(&context);
    assert!(text.contains("CURRENT EDIT"));
    assert!(!text.contains("STALE SNAPSHOT"));
    assert_eq!(text.matches("Shared passage").count(), 1);
}
