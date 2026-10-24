use super::*;
use crate::vfs::types::VfsCreateExamSheetParams;

fn setup() -> (tempfile::TempDir, Arc<VfsDatabase>, String) {
    let (temp, db) = crate::vfs::database::setup_migrated_test_db();
    let db = Arc::new(db);
    let exam = VfsExamRepo::create_exam_sheet(
        &db,
        VfsCreateExamSheetParams {
            exam_name: Some("test".into()),
            temp_id: id("tmp"),
            metadata_json: json!({}),
            preview_json: json!({"pages":[]}),
            status: "empty".into(),
            folder_id: None,
        },
    )
    .unwrap();
    (temp, db, exam.id)
}
fn group_document() -> QuestionDocument {
    serde_json::from_value(json!({"schema_version":2,"mode":"extract","materials":[{"local_id":"m1","content":"A full shared passage"}],"groups":[{"local_id":"g1","label":"Reading","material_ids":["m1"],"question_ids":["q1","q2"]}],"questions":[
        {"local_id":"q1","group_id":"g1","content":"First question","question_type":"short_answer"},
        {"local_id":"q2","group_id":"g1","content":"Second question","question_type":"short_answer"}
    ]})).unwrap()
}
#[test]
fn selection_closes_material_dependencies_and_confirmation_is_idempotent() {
    let (_temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db.clone());
    let job = service
        .save_draft(&exam, &group_document(), &json!({}))
        .unwrap();
    assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 0);
    let draft = service.get_draft(&job).unwrap();
    let receipt = service
        .commit_draft(&job, &["q2".into()], draft.version)
        .unwrap();
    assert_eq!(receipt.imported_count, 1);
    assert_eq!(receipt.material_ids.len(), 1);
    assert_eq!(receipt.group_ids.len(), 1);
    assert_eq!(
        service
            .commit_draft(&job, &["q2".into()], draft.version)
            .unwrap()
            .question_ids,
        receipt.question_ids
    );
    assert!(service
        .commit_draft(&job, &["q1".into()], draft.version)
        .is_err());
    assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 1);
}
#[test]
fn invalid_late_question_rolls_back_materials_groups_and_questions() {
    let (_temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db.clone());
    let mut document = group_document();
    document.questions[1].parent_id = Some("missing-parent".into());
    let job = service.save_draft(&exam, &document, &json!({})).unwrap();
    assert!(service
        .commit_draft(&job, &["q1".into(), "q2".into()], 1)
        .is_err());
    let conn = db.get_conn_safe().unwrap();
    for table in [
        "questions",
        "qbank_materials",
        "qbank_groups",
        "qbank_group_materials",
    ] {
        assert_eq!(
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(service.get_draft(&job).unwrap().status, "ready");
}
#[test]
fn material_occ_and_live_dependency_protection() {
    let (_temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db.clone());
    let job = service
        .save_draft(&exam, &group_document(), &json!({}))
        .unwrap();
    let receipt = service
        .commit_draft(&job, &["q1".into(), "q2".into()], 1)
        .unwrap();
    let material = service
        .update_material(&receipt.material_ids[0], "Updated shared passage", 1)
        .unwrap();
    assert_eq!(material.version, 2);
    assert!(service
        .update_material(&material.id, "stale overwrite", 1)
        .is_err());
    assert!(service.delete_material(&material.id, 2).is_err());
}
#[test]
fn more_than_one_hundred_questions_project_without_truncation() {
    let (_temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db.clone());
    let document = QuestionDocument {
        questions: (0..150)
            .map(|i| DraftQuestion {
                local_id: format!("q{i}"),
                content: format!("Question {i}"),
                question_type: "short_answer".into(),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };
    let job = service.save_draft(&exam, &document, &json!({})).unwrap();
    let receipt = service
        .commit_draft(
            &job,
            &document
                .questions
                .iter()
                .map(|q| q.local_id.clone())
                .collect::<Vec<_>>(),
            1,
        )
        .unwrap();
    assert_eq!(receipt.imported_count, 150);
    let sheet = VfsExamRepo::get_exam_sheet(&db, &exam).unwrap().unwrap();
    assert_eq!(
        sheet.preview_json["pages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["cards"].as_array().unwrap().len())
            .sum::<usize>(),
        150
    );
}

#[test]
fn canonical_copy_preserves_materials_and_structured_data_and_restore_preserves_prior_deletions() {
    let (_temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db.clone());
    let mut document = group_document();
    document.questions[0].question_type = "numeric".into();
    document.questions[0].structured_data = Some(json!({"answer_value":42,"tolerance":0.1}));
    let receipt = service.submit_document(&exam, &document, "seed").unwrap();
    let copied = VfsExamRepo::copy_exam_sheet(&db, &exam, None).unwrap();
    let questions = VfsQuestionRepo::list_questions(&db, &copied.id, &Default::default(), 1, 100)
        .unwrap()
        .questions;
    assert_eq!(questions.len(), 2);
    assert!(questions.iter().all(|q| q.materials.len() == 1));
    assert!(questions.iter().any(|q| q
        .structured_data
        .as_ref()
        .is_some_and(|d| d["answer_value"] == 42)));
    assert_ne!(questions[0].group_id.as_ref(), receipt.group_ids.first());
    assert!(questions
        .iter()
        .all(|q| q.group_id.as_deref().unwrap().starts_with("qgroup_")));
    VfsQuestionRepo::delete_question(&db, &receipt.question_ids[0]).unwrap();
    VfsExamRepo::delete_exam_sheet(&db, &exam).unwrap();
    VfsExamRepo::restore_exam(&db, &exam).unwrap();
    assert!(VfsQuestionRepo::get_question(&db, &receipt.question_ids[0])
        .unwrap()
        .is_none());
    assert!(VfsQuestionRepo::get_question(&db, &receipt.question_ids[1])
        .unwrap()
        .is_some());
    assert_eq!(VfsQuestionRepo::count_questions(&db, &exam).unwrap(), 1);
}

#[test]
fn saved_chat_review_can_be_fixed_and_committed_without_regenerating_questions() {
    let (_temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db.clone());
    let mut document = group_document();
    document.coverage = vec![json!({"exam":"legacy summary","total_questions":2})];
    let job = service
        .save_draft(
            &exam,
            &document,
            &json!({"source_format":"chat_qbank_batch_import"}),
        )
        .unwrap();
    assert_eq!(service.list_drafts(&exam).unwrap()[0].job_id, job);
    assert_eq!(service.get_draft(&job).unwrap().status, "needs_review");
    let reviewed = service
        .update_draft_review(
            &job,
            1,
            Some(vec![
                json!({"source_id":"att_test","page":null,"status":"processed"}),
            ]),
            None,
            None,
        )
        .unwrap();
    assert_eq!(reviewed.version, 2);
    assert_eq!(
        reviewed.document.questions[0].content,
        document.questions[0].content
    );
    assert_eq!(
        reviewed.document.materials[0].content,
        document.materials[0].content
    );
    assert!(service
        .update_draft_review(&job, 1, Some(vec![]), None, None)
        .is_err());
    let receipt = service
        .commit_draft(&job, &["q1".into(), "q2".into()], reviewed.version)
        .unwrap();
    assert_eq!(receipt.imported_count, 2);
    assert!(service.list_drafts(&exam).unwrap().is_empty());
    assert!(service
        .update_draft_review(&job, 3, Some(vec![]), None, None)
        .is_err());
}

#[test]
fn scoped_import_remains_partial_after_explicit_selection_commit() {
    let (_temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db);
    let document = group_document();
    let job = service
        .save_draft(
            &exam,
            &document,
            &json!({"complete_document":false,"expected_coverage":[{"source_id":"s1","page":1}]}),
        )
        .unwrap();
    assert_eq!(service.get_draft(&job).unwrap().status, "partial");
    assert!(service
        .update_draft_review(&job, 1, Some(vec![]), None, None)
        .is_err());
    let receipt = service
        .commit_draft(&job, &["q1".into(), "q2".into()], 1)
        .unwrap();
    assert!(receipt.committed && receipt.partial && receipt.needs_review);
}

#[test]
fn selected_source_ranges_merge_page_evidence_without_losing_earlier_pages() {
    let (_temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db.clone());
    for page in [1, 2] {
        let document:QuestionDocument=serde_json::from_value(json!({"schema_version":2,"mode":"extract","questions":[{"local_id":format!("q{page}"),"original_label":page.to_string(),"content":format!("Question {page}"),"question_type":"short_answer","source_refs":[{"source_id":"s1","page":page}]}]})).unwrap();
        let metadata = json!({"complete_document":false,"sources":[{"source_id":"s1","content_hash":"stable-full-document-hash","page_count":2}],"pages":[{"source_id":"s1","page":page,"blob_hash":format!("page-image-{page}"),"width":100,"height":100}]});
        let job = service.save_draft(&exam, &document, &metadata).unwrap();
        service
            .commit_draft(&job, &[format!("q{page}")], 1)
            .unwrap();
    }
    let conn = db.get_conn_safe().unwrap();
    let (count, descriptor): (i64, String) = conn
        .query_row(
            "SELECT count(*),descriptor_json FROM qbank_sources WHERE exam_id=?1",
            [exam],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 1);
    let descriptor: Value = serde_json::from_str(&descriptor).unwrap();
    assert_eq!(descriptor["pages"].as_array().unwrap().len(), 2);
    assert_eq!(descriptor["pages"][1]["blob_hash"], "page-image-2");
}

#[tokio::test]
async fn committed_import_projects_into_real_session_detail_for_every_source_type() {
    let (temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db.clone());
    let mut document = group_document();
    for n in 3..=38 {
        document.questions.push(DraftQuestion {
            local_id: format!("q{n}"),
            content: format!("Question {n}"),
            question_type: "short_answer".into(),
            ..Default::default()
        });
    }
    document.questions[2].question_type = "true_false".into();
    document.questions[2].answer = Some("true".into());
    document.questions[3].question_type = "numeric".into();
    document.questions[3].structured_data = Some(json!({"answer_value":42,"tolerance":0.1}));
    document.questions[4].question_type = "ordering".into();
    document.questions[4].structured_data = Some(
        json!({"items":[{"key":"a","content":"one"},{"key":"b","content":"two"}],"correct_order":["a","b"]}),
    );
    document.questions[5].question_type = "matching".into();
    document.questions[5].structured_data = Some(
        json!({"left":[{"key":"a","content":"one"}],"right":[{"key":"b","content":"two"}],"pairs":[{"left":"a","right":"b"}]}),
    );
    let receipt = service
        .submit_document(&exam, &document, "actual-import-regression")
        .unwrap();
    let settings =
        Arc::new(crate::database::Database::new(&temp.path().join("settings.db")).unwrap());
    let files = Arc::new(crate::file_manager::FileManager::new(temp.path().to_path_buf()).unwrap());
    let sheets =
        crate::exam_sheet_service::ExamSheetService::new(settings, files, db.clone()).unwrap();
    for (source, expected) in [
        ("imported", crate::models::SourceType::ImportFile),
        ("manual", crate::models::SourceType::ManualCreate),
        ("ocr", crate::models::SourceType::OcrImage),
        ("ai_generated", crate::models::SourceType::AiGenerated),
    ] {
        db.get_conn_safe()
            .unwrap()
            .execute(
                "UPDATE questions SET source_type=?1 WHERE exam_id=?2",
                params![source, exam],
            )
            .unwrap();
        let detail = sheets
            .get_exam_sheet_session_detail(&exam)
            .await
            .expect("committed question bank must remain readable");
        let cards: Vec<_> = detail.preview.pages.iter().flat_map(|p| &p.cards).collect();
        assert_eq!(cards.len(), 38);
        assert!(cards.iter().all(|card| card.source_type == expected));
        assert!(cards
            .iter()
            .all(|card| receipt.question_ids.contains(&card.card_id)));
    }
}

#[tokio::test]
#[ignore = "requires a local read-only replay database path"]
async fn replay_saved_import_from_read_only_user_database_in_an_isolated_fixture() {
    let path = std::env::var("DS_AUTHORING_REPLAY_DB").expect("set a local replay DB path");
    let source =
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let (document,metadata):(String,String)=source.query_row("SELECT document_json,metadata_json FROM qbank_import_jobs WHERE status IN ('needs_review','partial','ready') ORDER BY created_at DESC LIMIT 1",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    let document: QuestionDocument = serde_json::from_str(&document).unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    document
        .validate()
        .expect("saved parsed questions remain valid");
    let (temp, db, exam) = setup();
    let service = QuestionAuthoringService::new(db.clone());
    let job = service.save_draft(&exam, &document, &metadata).unwrap();
    let receipt = service
        .commit_draft(
            &job,
            &document
                .questions
                .iter()
                .map(|q| q.local_id.clone())
                .collect::<Vec<_>>(),
            1,
        )
        .unwrap();
    assert_eq!(receipt.imported_count, document.questions.len());
    let questions =
        VfsQuestionRepo::canonical_questions_with_conn(&db.get_conn_safe().unwrap(), &exam)
            .unwrap();
    assert_eq!(questions.len(), document.questions.len());
    assert!(questions
        .iter()
        .filter(|q| q.group_id.is_some())
        .all(|q| !q.materials.is_empty()));
    let settings =
        Arc::new(crate::database::Database::new(&temp.path().join("settings.db")).unwrap());
    let files = Arc::new(crate::file_manager::FileManager::new(temp.path().to_path_buf()).unwrap());
    let sheets = crate::exam_sheet_service::ExamSheetService::new(settings, files, db).unwrap();
    let detail = sheets.get_exam_sheet_session_detail(&exam).await.unwrap();
    assert_eq!(
        detail
            .preview
            .pages
            .iter()
            .map(|p| p.cards.len())
            .sum::<usize>(),
        document.questions.len()
    );
    println!("Read-only saved-draft replay: {} questions, {} materials, {} groups committed and session detail loaded",receipt.imported_count,receipt.material_ids.len(),receipt.group_ids.len());
}
