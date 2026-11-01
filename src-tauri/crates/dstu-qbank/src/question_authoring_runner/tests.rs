use super::*;
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Response, Server};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "requires an explicitly configured live provider and read-only source fixture"]
async fn live_provider_whole_source_json_import() {
    let config: ApiConfig = serde_json::from_str(
        &std::env::var("DS_QUESTION_LIVE_CONFIG")
            .expect("provide a temporary provider config in the process environment"),
    )
    .unwrap();
    let source_db = std::env::var("DS_QUESTION_LIVE_SOURCE_DB").unwrap();
    let blob_root = std::path::PathBuf::from(std::env::var("DS_QUESTION_LIVE_BLOB_ROOT").unwrap());
    let source = rusqlite::Connection::open_with_flags(
        source_db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let descriptor:String=source.query_row("SELECT descriptor_json FROM qbank_sources WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",[],|row|row.get(0)).unwrap();
    let mut descriptor: Value = serde_json::from_str(&descriptor).unwrap();
    let pages: Vec<SourcePage> = serde_json::from_value(descriptor["pages"].clone()).unwrap();
    descriptor.as_object_mut().unwrap().remove("pages");
    let bundle = SourceBundle {
        sources: vec![descriptor],
        pages,
        text: String::new(),
        format: "pdf".into(),
    };
    let (temp, vfs) = crate::vfs::database::setup_migrated_test_db();
    let vfs = Arc::new(vfs);
    for page in &bundle.pages {
        let (relative, mime): (String, Option<String>) = source
            .query_row(
                "SELECT relative_path,mime_type FROM blobs WHERE hash=?1",
                [&page.blob_hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let bytes = std::fs::read(blob_root.join(relative)).unwrap();
        let stored = VfsBlobRepo::store_blob(&vfs, &bytes, mime.as_deref(), None).unwrap();
        assert_eq!(stored.hash, page.blob_hash);
    }
    let settings =
        Arc::new(crate::database::Database::new(&temp.path().join("settings.db")).unwrap());
    let files = Arc::new(crate::file_manager::FileManager::new(temp.path().to_path_buf()).unwrap());
    let llm = LLMManager::new(settings, files).unwrap();
    let (document, metadata) = run_document(&llm, &vfs, &bundle, &config, None)
        .await
        .expect("live model must return a complete validated QuestionDocument");
    let exam = crate::vfs::repos::VfsExamRepo::create_exam_sheet(
        &vfs,
        crate::vfs::types::VfsCreateExamSheetParams {
            exam_name: Some("Live isolated import verification".into()),
            temp_id: "live_isolated".into(),
            status: "empty".into(),
            metadata_json: json!({}),
            preview_json: json!({"pages":[]}),
            folder_id: None,
        },
    )
    .unwrap();
    let service = crate::qbank_authoring_service::QuestionAuthoringService::new(vfs.clone());
    let job = service.save_draft(&exam.id, &document, &metadata).unwrap();
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
    assert_eq!(metadata["main_requests"], 1);
    assert_eq!(metadata["json_mode"], true);
    println!("Live provider {}: {} questions from {} original pages, complete JSON validated and committed in isolated database; finish_reason={}",config.model,receipt.imported_count,bundle.pages.len(),metadata["finish_reason"]);
}

#[tokio::test]
async fn docx_embedded_image_sources_keep_commit_identity_and_page_assets() {
    let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
    let db = Arc::new(db);
    let mut image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(8, 8)
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    let mut docx = std::io::Cursor::new(Vec::new());
    docx_rs::Docx::new()
        .add_paragraph(
            docx_rs::Paragraph::new().add_run(
                docx_rs::Run::new()
                    .add_text("A shared diagram")
                    .add_image(docx_rs::Pic::new(image.get_ref())),
            ),
        )
        .build()
        .pack(&mut docx)
        .unwrap();
    let bundle = load_source_bundle(
        &db,
        &base64::engine::general_purpose::STANDARD.encode(docx.into_inner()),
        "docx",
        "diagram.docx",
    )
    .await
    .unwrap();
    bundle.validate_source_identity().unwrap();
    assert_eq!(bundle.sources.len(), 2);
    assert_eq!(bundle.pages.len(), 1);
    let exam = crate::vfs::repos::VfsExamRepo::create_exam_sheet(
        &db,
        crate::vfs::types::VfsCreateExamSheetParams {
            exam_name: Some("docx".into()),
            temp_id: "tmp_docx_identity".into(),
            status: "empty".into(),
            metadata_json: json!({}),
            preview_json: json!({"pages":[]}),
            folder_id: None,
        },
    )
    .unwrap();
    let document:QuestionDocument=serde_json::from_value(json!({"schema_version":2,"mode":"extract","questions":[{"local_id":"q1","original_label":"1","question_type":"short_answer","content":"Read the diagram","source_refs":[{"source_id":"s1","page":null},{"source_id":"s1_img0","page":1}]}]})).unwrap();
    let service = crate::qbank_authoring_service::QuestionAuthoringService::new(db.clone());
    let job = service
        .save_draft(
            &exam.id,
            &document,
            &json!({"sources":bundle.sources,"pages":bundle.pages}),
        )
        .unwrap();
    let receipt = service
        .commit_draft(&job, &["q1".into()], 1)
        .expect("DOCX image source must have stable commit identity");
    assert_eq!(receipt.imported_count, 1);
    let question = crate::vfs::repos::VfsQuestionRepo::get_question(&db, &receipt.question_ids[0])
        .unwrap()
        .unwrap();
    assert_eq!(question.source_refs.len(), 2);
    assert!(question
        .source_refs
        .iter()
        .all(|r| r.source_id.starts_with("qsource_")));
}

#[tokio::test]
async fn complete_twenty_page_import_stays_draft_until_selected_atomic_commit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)",
    )
    .unwrap();
    drop(conn);
    let database = Arc::new(crate::database::Database::new(&path).unwrap());
    let files = Arc::new(crate::file_manager::FileManager::new(temp.path().to_path_buf()).unwrap());
    let llm = Arc::new(LLMManager::new(database, files.clone()).unwrap());
    let (_vfs_temp, vfs) = crate::vfs::database::setup_migrated_test_db();
    let vfs = Arc::new(vfs);
    let mut image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(12, 12)
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    let page = base64::engine::general_purpose::STANDARD.encode(image.into_inner());
    let input = json!(vec![page; 20]).to_string();
    let doc = json!({"schema_version":2,"mode":"extract",
        "materials":[{"local_id":"m1","content":"Full passage shared by both questions","source_refs":[{"source_id":"s1","page":1}],"figures":[]}],
        "groups":[{"local_id":"g1","label":"Reading","material_ids":["m1"],"question_ids":["q1","q2"]}],
        "questions":[
            {"local_id":"q1","group_id":"g1","original_label":"1","content":"First independently answerable question","question_type":"short_answer","answer":null,"answer_origin":"missing","source_refs":[{"source_id":"s1","page":2}]},
            {"local_id":"q2","group_id":"g1","original_label":"2","content":"Second independently answerable question","question_type":"short_answer","answer":null,"answer_origin":"missing","source_refs":[{"source_id":"s1","page":3}]}
        ],"coverage":(1..=20).map(|p|json!({"source_id":"s1","page":p,"status":"processed"})).collect::<Vec<_>>(),"issues":[],"unmatched_answers":[]});
    let calls = Arc::new(AtomicUsize::new(0));
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let h = calls.clone();
    let b = bodies.clone();
    let server=Server::from_tcp(listener).unwrap().serve(make_service_fn(move |_| {
        let doc=doc.clone();let h=h.clone();let b=b.clone();
        async move {Ok::<_,std::convert::Infallible>(service_fn(move |request:hyper::Request<Body>| {
            let doc=doc.clone();let h=h.clone();let b=b.clone();
            async move {
                h.fetch_add(1,Ordering::SeqCst);
                let bytes=hyper::body::to_bytes(request.into_body()).await.unwrap();b.lock().unwrap().push(serde_json::from_slice(&bytes).unwrap());
                let delta=json!({"choices":[{"index":0,"delta":{"content":doc.to_string()},"finish_reason":null}]}).to_string();
                let end=json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}).to_string();
                Ok::<_,std::convert::Infallible>(Response::builder().header("content-type","text/event-stream").body(Body::from(format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n"))).unwrap())
            }
        }))}
    }));
    let server = tokio::spawn(server);
    let config = Arc::new(ApiConfig {
        id: format!("selected-{address}"),
        name: "Selected multimodal".into(),
        model: "mock-multimodal".into(),
        base_url: format!("http://{address}/v1"),
        api_key: "mock".into(),
        enabled: true,
        is_multimodal: true,
        api_protocol: Some("openai_chat_completions".into()),
        max_output_tokens: 65536,
        ..Default::default()
    });
    let importer = crate::question_import_service::QuestionImportService::new(llm, files);
    let result = importer
        .import_document_with_config(
            &vfs,
            crate::question_import_service::ImportRequest {
                content: input,
                format: "image".into(),
                name: Some("Complete source".into()),
                session_id: None,
                folder_id: None,
                model_config_id: Some(config.id.clone()),
                pdf_prefer_ocr: None,
                source_ranges: vec![],
            },
            Some(config),
        )
        .await
        .unwrap();
    server.abort();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies[0]["max_tokens"], 65536);
    assert_eq!(
        bodies[0]["messages"][1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["type"] == "image_url")
            .count(),
        20
    );
    assert!(!result.committed);
    assert_eq!(
        crate::vfs::repos::VfsQuestionRepo::count_questions(&vfs, &result.session_id).unwrap(),
        0
    );
    let authoring = crate::qbank_authoring_service::QuestionAuthoringService::new(vfs.clone());
    let job = result.draft_job_id.unwrap();
    let draft = authoring.get_draft(&job).unwrap();
    let receipt = authoring
        .commit_draft(&job, &["q2".into()], draft.version)
        .unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.imported_count, 1);
    let again = authoring
        .commit_draft(&job, &["q2".into()], draft.version)
        .unwrap();
    assert_eq!(again.question_ids, receipt.question_ids);
    assert_eq!(
        crate::vfs::repos::VfsQuestionRepo::count_questions(&vfs, &result.session_id).unwrap(),
        1
    );
    let question = crate::vfs::repos::VfsQuestionRepo::get_question(&vfs, &receipt.question_ids[0])
        .unwrap()
        .unwrap();
    assert_eq!(question.materials.len(), 1);
    assert!(question.materials[0].content.contains("Full passage"));
}

async fn mock_run(
    full_pages: u32,
    coverage_start: u32,
    coverage_end: u32,
    status: u16,
    scope: Option<(u32, u32)>,
    cancel: Option<CancellationToken>,
) -> (
    Result<(QuestionDocument, Value), AppError>,
    usize,
    Vec<Value>,
) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)",
    )
    .unwrap();
    drop(conn);
    let database = Arc::new(crate::database::Database::new(&path).unwrap());
    let files = Arc::new(crate::file_manager::FileManager::new(temp.path().to_path_buf()).unwrap());
    let llm = Arc::new(LLMManager::new(database, files).unwrap());
    let (_vfs_temp, vfs) = crate::vfs::database::setup_migrated_test_db();
    let vfs = Arc::new(vfs);
    let mut image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(8, 8)
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    let page = base64::engine::general_purpose::STANDARD.encode(image.into_inner());
    let bundle = load_source_bundle(
        &vfs,
        &json!(vec![page; full_pages as usize]).to_string(),
        "image",
        "pages",
    )
    .await
    .unwrap();
    let doc = json!({"schema_version":2,"mode":"extract",
        "materials":[],"groups":[],
        "questions":[{"local_id":"q1","group_id":null,"original_label":"1","content":"Question","question_type":"short_answer","answer":null,"answer_origin":"missing","source_refs":[{"source_id":"s1","page":coverage_start}]}],
        "coverage":(coverage_start..=coverage_end).map(|p|json!({"source_id":"s1","page":p,"status":"processed"})).collect::<Vec<_>>(),
        "issues":[],"unmatched_answers":[]});
    let calls = Arc::new(AtomicUsize::new(0));
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let h = calls.clone();
    let b = bodies.clone();
    let server = Server::from_tcp(listener).unwrap().serve(make_service_fn(move |_| {
        let doc = doc.clone();
        let h = h.clone();
        let b = b.clone();
        async move {
            Ok::<_, std::convert::Infallible>(service_fn(move |request: hyper::Request<Body>| {
                let doc = doc.clone();
                let h = h.clone();
                let b = b.clone();
                async move {
                    h.fetch_add(1, Ordering::SeqCst);
                    let bytes = hyper::body::to_bytes(request.into_body()).await.unwrap();
                    b.lock().unwrap().push(serde_json::from_slice(&bytes).unwrap());
                    if status != 200 {
                        return Ok::<_, std::convert::Infallible>(
                            Response::builder()
                                .status(status)
                                .header("content-type", "application/json")
                                .body(Body::from(
                                    "{\"error\":{\"message\":\"maximum context length exceeded\"}}",
                                ))
                                .unwrap(),
                        );
                    }
                    let delta = json!({"choices":[{"index":0,"delta":{"content":doc.to_string()},"finish_reason":null}]}).to_string();
                    let end = json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}).to_string();
                    Ok::<_, std::convert::Infallible>(
                        Response::builder()
                            .header("content-type", "text/event-stream")
                            .body(Body::from(format!(
                                "data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n"
                            )))
                            .unwrap(),
                    )
                }
            }))
        }
    }));
    let server = tokio::spawn(server);
    let config = Arc::new(ApiConfig {
        id: format!("selected-{address}"),
        name: "Selected multimodal".into(),
        model: "mock-multimodal".into(),
        base_url: format!("http://{address}/v1"),
        api_key: "mock".into(),
        enabled: true,
        is_multimodal: true,
        api_protocol: Some("openai_chat_completions".into()),
        max_output_tokens: 65536,
        ..Default::default()
    });
    let result = if let Some((start, end)) = scope {
        run_document_scoped(
            &llm,
            &vfs,
            &bundle,
            &config,
            &[SourceRange::pages("s1", start, end)],
            cancel,
        )
        .await
    } else {
        run_document(&llm, &vfs, &bundle, &config, cancel).await
    };
    server.abort();
    let total = calls.load(Ordering::SeqCst);
    let bodies = bodies.lock().unwrap().clone();
    (result, total, bodies)
}

#[tokio::test]
async fn one_to_twenty_pages_single_request_and_twenty_one_pages_are_all_preserved() {
    for pages in [1, 19, 20, 21] {
        let (result, calls, bodies) = mock_run(pages, 1, pages, 200, None, None).await;
        assert!(result.is_ok(), "pages={pages}: {result:?}");
        assert_eq!(calls, 1);
        assert_eq!(
            bodies[0]["messages"][1]["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|part| part["type"] == "image_url")
                .count(),
            pages as usize
        );
    }
}

#[tokio::test]
async fn scoped_run_keeps_original_provenance_and_never_claims_completion() {
    let (result, calls, bodies) = mock_run(40, 1, 20, 200, Some((1, 20)), None).await;
    let (_document, metadata) = result.unwrap();
    assert_eq!(calls, 1);
    assert_eq!(
        bodies[0]["messages"][1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|part| part["type"] == "image_url")
            .count(),
        20
    );
    assert_eq!(metadata["source_route"], "scoped_original_range");
    assert_eq!(metadata["complete_document"], false);
    assert_eq!(metadata["main_requests"], 1);
    assert_eq!(metadata["expected_coverage"].as_array().unwrap().len(), 20);
    assert_eq!(metadata["original_coverage"].as_array().unwrap().len(), 40);
    assert_eq!(metadata["source_scope"]["scoped"], true);
    assert_eq!(metadata["source_scope"]["complete_document"], false);
    let selection = metadata["sources"][0]["selection"].clone();
    assert_eq!(selection["selected_page_count"], 20);
    assert_eq!(selection["original_page_count"], 40);
}

#[tokio::test]
async fn provider_limit_returns_explicit_plan_without_retrying_or_skipping_pages() {
    let (result, calls, _) = mock_run(25, 1, 25, 400, None, None).await;
    let error = result.unwrap_err();
    assert_eq!(calls, 1);
    let details = error.details.unwrap();
    assert_eq!(details["code"], "SOURCE_RANGE_PLAN_REQUIRED");
    assert_eq!(details["no_pages_skipped"], true);
    assert_eq!(details["complete_document"], false);
    let ranges = details["plan"]["ranges"].as_array().unwrap();
    assert_eq!(
        ranges
            .iter()
            .map(|range| range["page_count"].as_u64().unwrap())
            .sum::<u64>(),
        25
    );
    assert_eq!(details["plan"]["requires_user_selection"], true);
}

#[tokio::test]
async fn cancelled_run_does_not_call_provider_or_return_partial_scope() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let (result, calls, _) = mock_run(1, 1, 1, 200, None, Some(cancel.clone())).await;
    assert!(result.is_err());
    assert_eq!(calls, 0);

    let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
    let db = Arc::new(db);
    let loaded = load_source_bundle_scoped_cancellable(
        &db,
        "",
        "image",
        "cancel",
        &[SourceRange::pages("s1", 1, 1)],
        Some(cancel),
    )
    .await;
    assert!(loaded.is_err());
}

#[test]
fn scope_does_not_fabricate_processed_coverage() {
    let bundle = SourceBundle {
        sources: vec![json!({"source_id":"s1","page_count":40})],
        pages: (1..=40)
            .map(|page| SourcePage {
                source_id: "s1".into(),
                page,
                blob_hash: "h".into(),
                width: 1,
                height: 1,
                text_hint: None,
            })
            .collect(),
        text: String::new(),
        format: "pdf".into(),
    };
    let scoped = bundle.scoped(&[SourceRange::pages("s1", 1, 20)]).unwrap();
    assert!(scoped.is_scoped());
    assert!(!scoped.scope_complete());
    assert_eq!(scoped.expected_coverage().len(), 20);
    assert_eq!(scoped.original_coverage().len(), 40);

    let mut raw = json!({"coverage":(1..=20).map(|page|json!({"source_id":"s1","page":page,"status":"processed"})).collect::<Vec<_>>()});
    assert!(validate_coverage(&raw, &scoped).is_ok());
    raw["coverage"]
        .as_array_mut()
        .unwrap()
        .extend((21..=40).map(|page| json!({"source_id":"s1","page":page,"status":"unprocessed"})));
    assert!(validate_coverage(&raw, &scoped).is_ok());
    raw["coverage"]
        .as_array_mut()
        .unwrap()
        .push(json!({"source_id":"s1","page":21,"status":"processed"}));
    assert!(validate_coverage(&raw, &scoped).is_err());
    assert!(validate_coverage(
        &json!({"coverage":(1..=20).map(|page|json!({"source_id":"s1","page":page,"status":"processed"})).collect::<Vec<_>>()}),
        &bundle
    )
    .is_err());
}

#[tokio::test]
async fn every_loaded_source_type_has_stable_identity_metadata() {
    let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
    let db = Arc::new(db);
    let mut image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(4, 4)
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    let page = base64::engine::general_purpose::STANDARD.encode(image.into_inner());
    let image_bundle = load_source_bundle(&db, &json!([page, page]).to_string(), "image", "images")
        .await
        .unwrap();
    image_bundle.validate_source_identity().unwrap();
    let source = &image_bundle.sources[0];
    assert!(source["blob_hash"]
        .as_str()
        .is_some_and(|hash| !hash.is_empty()));
    assert!(source["content_hash"]
        .as_str()
        .is_some_and(|hash| hash.len() == 64));

    let text = base64::engine::general_purpose::STANDARD.encode(b"native source text");
    let text_bundle = load_source_bundle(&db, &text, "txt", "text").await.unwrap();
    text_bundle.validate_source_identity().unwrap();
    assert_eq!(text_bundle.sources[0]["text"], "native source text");
}
