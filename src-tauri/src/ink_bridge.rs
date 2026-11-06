#[cfg(test)]
mod tests {
    use super::{
        background_blob_hash, build_board_render_request, build_render_request, load_frozen_inputs,
        render_id_for, InkArtifactDraft, InkBoardRenderSpec, InkBridgeError, InkRenderCommandError,
        InkRenderIdentity, InkRenderResult, InkRenderSpec, PendingFlushBus, PendingRenderBus,
    };
    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        ink::{
            InkAuthor, InkBackground, InkBoardBounds, InkBoardChunk, InkBoardObject,
            InkBoardSurface, InkManifest, InkObjectContent, InkPage, InkPageRef, InkRect,
            InkRuling, InkSource, INK_BOARD_SCHEMA_VERSION, INK_BOARD_WORLD_LIMIT,
        },
        repos::{
            blob_repo::VfsBlobRepo,
            file_repo::VfsFileRepo,
            ink_artifact_repo::VfsInkArtifactRepo,
            ink_board_repo::VfsInkBoardRepo,
            ink_prepare_repo::{InkPreparedPage, VfsInkPrepareRepo},
            ink_repo::VfsInkRepo,
        },
    };
    use rusqlite::{params, OptionalExtension};
    use serde_json::{json, Value};
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    fn identity(request_id: &str, render_id: &str) -> InkRenderIdentity {
        InkRenderIdentity {
            request_id: request_id.to_owned(),
            render_id: render_id.to_owned(),
            session_id: None,
            tool_call_id: None,
        }
    }

    fn result(request_id: &str, render_id: &str) -> InkRenderResult {
        InkRenderResult {
            request_id: request_id.to_owned(),
            render_id: render_id.to_owned(),
            staged_upload_id: "upload-1".to_owned(),
            width_px: 640,
            height_px: 480,
        }
    }

    fn minimal_pdf() -> Vec<u8> {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        let xref_offset = pdf.len();
        pdf.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
                objects.len() + 1,
            )
            .as_bytes(),
        );
        pdf
    }

    fn prepared_page_png() -> Vec<u8> {
        use image::ImageEncoder;
        let pixels: Vec<u8> = (0..120 * 160).flat_map(|_| [221, 221, 221, 255]).collect();
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&pixels, 120, 160, image::ColorType::Rgba8)
            .expect("encode fixed prepared PNG fixture");
        bytes
    }

    fn rendered_png_fixture() -> Vec<u8> {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[19, 81, 143, 255], 1, 1, image::ColorType::Rgba8)
            .expect("encode rendered artifact PNG fixture");
        bytes
    }

    fn create_prepared_pdf(
        db: &VfsDatabase,
        operation: &str,
    ) -> (String, String, InkManifest, String) {
        let conn = db.get_conn_safe().unwrap();
        let source_bytes = minimal_pdf();
        let source_blob = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            &source_bytes,
            Some("application/pdf"),
            Some("pdf"),
        )
        .unwrap();
        let source_file = VfsFileRepo::create_file_with_conn(
            &conn,
            &source_blob.hash,
            "prepared-source.pdf",
            source_bytes.len() as i64,
            "document",
            Some("application/pdf"),
            Some(&source_blob.hash),
            None,
        )
        .unwrap();
        let resource_id = source_file.resource_id.expect("source PDF resource");
        let background_png = prepared_page_png();
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            &background_png,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let manifest = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &resource_id,
            &source_blob.hash,
            "pdf-render-test-v1",
            &[InkPreparedPage {
                width: 120.0,
                height: 160.0,
                background_blob_hash: background.hash.clone(),
                source_page_index: Some(0),
            }],
            operation,
            None,
        )
        .unwrap();
        (resource_id, source_file.id, manifest, background.hash)
    }

    fn set_pdf_highlights(
        conn: &rusqlite::Connection,
        resource_id: &str,
        highlights: Value,
        updated_at: i64,
    ) {
        let raw: Option<String> = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [resource_id],
                |row| row.get(0),
            )
            .unwrap();
        let mut metadata: Value = raw
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .unwrap()
            .unwrap_or_else(|| json!({}));
        if !metadata.get("extra").is_some_and(Value::is_object) {
            metadata["extra"] = json!({});
        }
        metadata["extra"]["highlights"] = highlights;
        conn.execute(
            "UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![metadata.to_string(), updated_at, resource_id],
        )
        .unwrap();
    }

    fn frozen_spec(manifest: &InkManifest) -> InkRenderSpec {
        InkRenderSpec {
            document_id: manifest.document_id.clone(),
            expected_revision: manifest.revision.clone(),
            page_id: manifest.pages[0].page_id.clone(),
            crop: None,
            board: None,
            long_edge: Some(160),
        }
    }

    fn board_chunk_fixture() -> InkBoardChunk {
        InkBoardChunk {
            schema_version: INK_BOARD_SCHEMA_VERSION,
            chunk_id: "chunk-negative-origin".to_owned(),
            objects: vec![InkBoardObject {
                id: "obj-negative-origin".to_owned(),
                author: InkAuthor::User,
                created_at: 0,
                z_index: 0,
                content: InkObjectContent::Rect {
                    rect: InkRect {
                        x: -20.0,
                        y: -10.0,
                        width: 40.0,
                        height: 20.0,
                    },
                    color: "#000000".to_owned(),
                    width: 2.0,
                },
            }],
        }
    }

    /// Create and save a real v2 board through the migrated repositories, then
    /// re-read the canonical manifest so callers use the committed revision.
    fn saved_board_fixture(db: &VfsDatabase) -> (InkManifest, InkBoardChunk) {
        let conn = db.get_conn_safe().unwrap();
        let created = VfsInkBoardRepo::create_blank_with_conn(
            &conn,
            db.blobs_dir(),
            "Bridge board fixture",
            InkRuling::Blank,
            "board-bridge-create",
            None,
        )
        .expect("migrated board create");
        let chunk = board_chunk_fixture();
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-bridge-save",
            std::slice::from_ref(&chunk),
            &[],
        )
        .expect("migrated board save");
        assert_ne!(saved.revision, created.revision);
        let reread = VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &saved.document_id)
            .expect("reget saved board manifest");
        assert_eq!(reread.revision, saved.revision);
        assert_eq!(reread.chunks.len(), 1);
        (reread, chunk)
    }

    fn board_render_spec(
        manifest: &InkManifest,
        expected_revision: &str,
        crop: InkRect,
    ) -> InkRenderSpec {
        let page_id = match manifest.surface.as_ref().expect("board surface") {
            InkBoardSurface::Board { page_id, .. } => page_id.clone(),
        };
        InkRenderSpec {
            document_id: manifest.document_id.clone(),
            expected_revision: expected_revision.to_owned(),
            page_id,
            crop: None,
            board: Some(InkBoardRenderSpec {
                crop,
                chunk_ids: Vec::new(),
            }),
            long_edge: Some(2048),
        }
    }

    fn board_crop() -> InkRect {
        InkRect {
            x: -100.0,
            y: -100.0,
            width: 200.0,
            height: 200.0,
        }
    }

    fn load_frozen_board_error(db: &VfsDatabase, spec: &InkRenderSpec) -> InkRenderCommandError {
        match load_frozen_inputs(db, spec) {
            Ok(_) => panic!("expected the frozen board inputs to be rejected"),
            Err(error) => error,
        }
    }

    fn artifact_draft(
        frozen: &super::FrozenRenderInputs,
        page_id: &str,
        revision: &str,
        render_id: &str,
        crop: InkRect,
    ) -> InkArtifactDraft {
        InkArtifactDraft {
            artifact_id: render_id.to_owned(),
            render_id: render_id.to_owned(),
            document_id: frozen.manifest.document_id.clone(),
            page_id: page_id.to_owned(),
            revision: revision.to_owned(),
            source_hash: frozen.source_hash.clone(),
            source_annotation_revision: frozen.source_annotation_revision.clone(),
            conversion_revision: frozen.conversion_revision.clone(),
            crop: Some(crop),
            width_px: 1,
            height_px: 1,
        }
    }

    #[test]
    fn frozen_render_request_keeps_manifest_revision_page_ref_and_page_together() {
        let page_ref = InkPageRef {
            page_id: "page-1".to_owned(),
            width: 100.0,
            height: 80.0,
            background: InkBackground::Blank {
                ruling: crate::vfs::ink::InkRuling::Blank,
            },
            page_blob_hash: "page-hash-at-revision-7".to_owned(),
        };
        let manifest = InkManifest {
            schema_version: 1,
            document_id: "doc-1".to_owned(),
            revision: "revision-7".to_owned(),
            title: "Frozen".to_owned(),
            source: InkSource::Blank {},
            pages: vec![page_ref.clone()],
            last_operation: None,
            surface: None,
            chunks: Vec::new(),
        };
        let page = InkPage {
            schema_version: 1,
            page_id: "page-1".to_owned(),
            objects: Vec::new(),
        };

        let request = build_render_request(&manifest, &page_ref, page.clone(), "render-7")
            .expect("valid frozen request");

        assert_eq!(request.document_id, "doc-1");
        assert_eq!(request.revision, "revision-7");
        assert_eq!(request.page_ref.as_ref(), Some(&page_ref));
        assert_eq!(request.page.as_ref(), Some(&page));
        assert_eq!(request.render_id, "render-7");
    }

    #[test]
    fn invalid_board_or_missing_frozen_inputs_fail_before_webview_dispatch() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (_resource_id, _source_file_id, manifest, _background_hash) =
            create_prepared_pdf(&db, "bridge-invalid-board-dispatch");
        let paged = load_frozen_inputs(&db, &frozen_spec(&manifest)).expect("paged frozen inputs");
        let board_spec = InkRenderSpec {
            document_id: manifest.document_id.clone(),
            expected_revision: manifest.revision.clone(),
            page_id: manifest.pages[0].page_id.clone(),
            crop: None,
            board: Some(InkBoardRenderSpec {
                crop: board_crop(),
                chunk_ids: Vec::new(),
            }),
            long_edge: None,
        };

        let mixed = InkRenderSpec {
            crop: Some(InkRect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            ..board_spec.clone()
        };
        let error = super::validate_render_spec(&mixed).expect_err("mixed paged/board mode");
        assert_eq!(error.code, "INVALID_ARGUMENT");

        let error = super::build_frozen_render_request(&board_spec, &paged, "render-board-missing")
            .expect_err("board request without frozen board inputs");
        assert_eq!(error.code, "RENDER_UNAVAILABLE");
    }

    #[test]
    fn frozen_render_request_rejects_page_ref_not_in_manifest() {
        let page_ref = InkPageRef {
            page_id: "page-foreign".to_owned(),
            width: 100.0,
            height: 80.0,
            background: InkBackground::Blank {
                ruling: crate::vfs::ink::InkRuling::Blank,
            },
            page_blob_hash: "page-hash".to_owned(),
        };
        let manifest = InkManifest {
            schema_version: 1,
            document_id: "doc-1".to_owned(),
            revision: "revision-7".to_owned(),
            title: "Frozen".to_owned(),
            source: InkSource::Blank {},
            pages: vec![],
            last_operation: None,
            surface: None,
            chunks: Vec::new(),
        };
        let page = InkPage {
            schema_version: 1,
            page_id: "page-foreign".to_owned(),
            objects: Vec::new(),
        };

        assert!(build_render_request(&manifest, &page_ref, page, "render-7").is_err());
    }

    #[tokio::test]
    async fn matching_main_webview_result_completes_and_repeat_is_rejected() {
        let bus = PendingRenderBus::default();
        let pending = bus.register(identity("req-1", "render-1")).unwrap();
        let completion = result("req-1", "render-1");

        bus.complete_from_labels("main", Some("main"), completion.clone())
            .unwrap();
        assert_eq!(
            pending
                .wait(Duration::from_secs(1), &CancellationToken::new())
                .await,
            Ok(completion.clone())
        );
        assert_eq!(
            bus.complete_from_labels("main", Some("main"), completion),
            Err(InkBridgeError::NotPending)
        );
    }

    #[test]
    fn duplicate_request_identity_is_rejected_while_pending() {
        let bus = PendingRenderBus::default();
        let _pending = bus.register(identity("req-1", "render-1")).unwrap();

        assert_eq!(
            bus.register(identity("req-1", "render-2")).err(),
            Some(InkBridgeError::DuplicateRequest)
        );
    }

    #[tokio::test]
    async fn foreign_webview_and_mismatched_render_cannot_consume_request() {
        let bus = PendingRenderBus::default();
        let pending = bus.register(identity("req-1", "render-1")).unwrap();

        assert_eq!(
            bus.complete_from_labels("settings", Some("main"), result("req-1", "render-1")),
            Err(InkBridgeError::ForeignWebview)
        );
        assert_eq!(
            bus.complete_from_labels("main", Some("main"), result("req-1", "render-old")),
            Err(InkBridgeError::IdentityMismatch)
        );

        let completion = result("req-1", "render-1");
        bus.complete_from_labels("main", Some("main"), completion.clone())
            .unwrap();
        assert_eq!(
            pending
                .wait(Duration::from_secs(1), &CancellationToken::new())
                .await,
            Ok(completion)
        );
    }

    #[tokio::test]
    async fn cancellation_removes_pending_request() {
        let bus = PendingRenderBus::default();
        let pending = bus.register(identity("req-1", "render-1")).unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            pending.wait(Duration::from_secs(30), &cancellation).await,
            Err(InkBridgeError::Cancelled)
        );
        assert_eq!(
            bus.complete_from_labels("main", Some("main"), result("req-1", "render-1")),
            Err(InkBridgeError::NotPending)
        );
    }

    #[tokio::test]
    async fn timeout_removes_pending_request() {
        let bus = PendingRenderBus::default();
        let pending = bus.register(identity("req-1", "render-1")).unwrap();

        assert_eq!(
            pending
                .wait(Duration::ZERO, &CancellationToken::new())
                .await,
            Err(InkBridgeError::Timeout)
        );
        assert_eq!(
            bus.complete_from_labels("main", Some("main"), result("req-1", "render-1")),
            Err(InkBridgeError::NotPending)
        );
    }

    #[test]
    fn frozen_pdf_inputs_use_real_highlight_wire_and_annotation_revision_in_render_identity() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (resource_id, _source_file_id, manifest, _background_hash) =
            create_prepared_pdf(&db, "bridge-fixture-wire");
        let conn = db.get_conn_safe().unwrap();
        let wire = json!([{
            "id": "pdf-highlight-0",
            "pageIndex": 0,
            "text": "source text",
            "color": "#0000ff80",
            "rects": [{ "x": 0.1, "y": 0.1, "width": 0.75, "height": 0.5 }],
            "createdAt": 42,
            "coordVersion": 2
        }]);
        set_pdf_highlights(&conn, &resource_id, wire.clone(), 1_900_000_000_001);
        let spec = frozen_spec(&manifest);

        let first = load_frozen_inputs(&db, &spec)
            .expect("prepared frozen PNG and source highlight should load");
        assert_eq!(first.highlights, wire.as_array().unwrap().clone());
        assert_eq!(
            first
                .page_ref
                .as_ref()
                .expect("paged v1 fixture")
                .background,
            manifest.pages[0].background
        );
        assert_eq!(
            first.source_hash.as_deref(),
            match &manifest.source {
                InkSource::Resource { source_hash, .. } => Some(source_hash.as_str()),
                _ => None,
            }
        );
        let first_render_id = render_id_for(&spec, &first).unwrap();

        let changed_wire = json!([{
            "id": "pdf-highlight-0",
            "pageIndex": 0,
            "text": "changed source text",
            "color": "#0000ff80",
            "rects": [{ "x": 0.1, "y": 0.1, "width": 0.75, "height": 0.5 }],
            "createdAt": 42,
            "coordVersion": 2
        }]);
        set_pdf_highlights(&conn, &resource_id, changed_wire, 1_900_000_000_002);
        let second =
            load_frozen_inputs(&db, &spec).expect("updated annotation metadata remains readable");
        assert_ne!(
            first.source_annotation_revision,
            second.source_annotation_revision
        );
        assert_ne!(first_render_id, render_id_for(&spec, &second).unwrap());
    }

    #[test]
    fn frozen_pdf_inputs_reject_changed_actual_source_blob_even_when_manifest_is_unchanged() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (resource_id, source_file_id, manifest, _background_hash) =
            create_prepared_pdf(&db, "bridge-fixture-source-change");
        let conn = db.get_conn_safe().unwrap();
        let replacement_bytes = minimal_pdf();
        let mut replacement_bytes = replacement_bytes;
        replacement_bytes.extend_from_slice(b"% changed");
        let replacement = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            &replacement_bytes,
            Some("application/pdf"),
            Some("pdf"),
        )
        .unwrap();
        conn.execute(
            "UPDATE files SET blob_hash = ?1, sha256 = ?1, size = ?2 WHERE id = ?3",
            params![
                replacement.hash,
                replacement_bytes.len() as i64,
                source_file_id
            ],
        )
        .unwrap();
        conn.execute(
            "UPDATE resources SET hash = ?1 WHERE id = ?2",
            params![replacement.hash, resource_id],
        )
        .unwrap();

        match load_frozen_inputs(&db, &frozen_spec(&manifest)) {
            Err(error) => assert_eq!(error.code, "SOURCE_CHANGED"),
            Ok(_) => panic!("actual changed source must not mix with frozen highlights"),
        }
    }

    #[test]
    fn frozen_pdf_page_remains_readable_after_original_source_file_is_purged() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (resource_id, source_file_id, manifest, background_hash) =
            create_prepared_pdf(&db, "bridge-fixture-purged-source");
        let conn = db.get_conn_safe().unwrap();
        let wire = json!([{
            "id": "pdf-highlight-purged-source",
            "pageIndex": 0,
            "text": "persisted source annotation",
            "color": "#0000ff80",
            "rects": [{ "x": 0.1, "y": 0.1, "width": 0.75, "height": 0.5 }],
            "createdAt": 42,
            "coordVersion": 2
        }]);
        set_pdf_highlights(&conn, &resource_id, wire.clone(), 1_900_000_000_003);
        let source_hash = match &manifest.source {
            InkSource::Resource { source_hash, .. } => source_hash.as_str(),
            InkSource::Blank {} => panic!("prepared PDF manifest must retain source provenance"),
        };
        VfsFileRepo::purge_file_with_conn(&conn, db.blobs_dir(), &source_file_id).unwrap();
        VfsBlobRepo::cleanup_unreferenced_with_conn(&conn, db.blobs_dir()).unwrap();
        assert!(
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), source_hash)
                .unwrap()
                .is_none()
        );

        let frozen = load_frozen_inputs(&db, &frozen_spec(&manifest))
            .expect("Ink-owned prepared PNG should remain readable without original PDF file");
        assert!(
            frozen.highlights.is_empty(),
            "purged source annotations should no longer be read from the deleted resource"
        );
        let frozen_page_ref = frozen.page_ref.as_ref().expect("paged v1 fixture");
        let frozen_background =
            background_blob_hash(&frozen_page_ref.background).expect("prepared page background");
        assert_eq!(frozen_background, background_hash);
        let frozen_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), frozen_background)
                .unwrap()
                .expect("prepared PNG blob path");
        assert!(std::fs::read(frozen_path)
            .unwrap()
            .starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(
            frozen
                .page_ref
                .as_ref()
                .expect("paged v1 fixture")
                .background,
            manifest.pages[0].background
        );
    }

    fn mutate_frozen_snapshot(
        db: &VfsDatabase,
        manifest: &InkManifest,
        resource_id: &str,
        drift: &str,
    ) {
        let conn = db.get_conn_safe().unwrap();
        match drift {
            "annotation" => set_pdf_highlights(
                &conn,
                resource_id,
                json!([{
                    "id": "annotation-after-render",
                    "pageIndex": 0,
                    "text": "changed source annotation",
                    "color": "#0000ff80",
                    "rects": [{ "x": 0.12, "y": 0.1, "width": 0.75, "height": 0.5 }],
                    "createdAt": 43,
                    "coordVersion": 2
                }]),
                1_900_000_000_010,
            ),
            "source" => {
                let replacement_bytes = [minimal_pdf(), b"% source changed".to_vec()].concat();
                let replacement = VfsBlobRepo::store_blob_with_conn(
                    &conn,
                    db.blobs_dir(),
                    &replacement_bytes,
                    Some("application/pdf"),
                    Some("pdf"),
                )
                .unwrap();
                let source_file_id: String = conn
                    .query_row(
                        "SELECT source_id FROM resources WHERE id = ?1",
                        [resource_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                conn.execute(
                    "UPDATE files SET blob_hash = ?1, sha256 = ?1, size = ?2 WHERE id = ?3",
                    params![
                        replacement.hash,
                        replacement_bytes.len() as i64,
                        source_file_id
                    ],
                )
                .unwrap();
                conn.execute(
                    "UPDATE resources SET hash = ?1 WHERE id = ?2",
                    params![replacement.hash, resource_id],
                )
                .unwrap();
            }
            "revision" => {
                let _updated = VfsInkRepo::rename_with_conn(
                    &conn,
                    db.blobs_dir(),
                    &manifest.document_id,
                    &manifest.revision,
                    "publish-drift-rename",
                    "Changed during render",
                )
                .unwrap();
            }
            other => panic!("unknown publication drift fixture: {other}"),
        }
    }

    fn assert_publication_drift_rejected_without_artifact_or_blob_ref(
        drift: &str,
        expected_error: &str,
    ) {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (resource_id, _source_file_id, manifest, _background_hash) =
            create_prepared_pdf(&db, &format!("bridge-publish-{drift}"));
        let spec = frozen_spec(&manifest);
        let expected = load_frozen_inputs(&db, &spec).expect("initial frozen snapshot");
        mutate_frozen_snapshot(&db, &manifest, &resource_id, drift);

        let png = rendered_png_fixture();
        let png_hash = VfsBlobRepo::compute_hash(&png);
        let draft = InkArtifactDraft {
            artifact_id: format!("render-publish-{drift}"),
            render_id: format!("render-publish-{drift}"),
            document_id: manifest.document_id.clone(),
            page_id: manifest.pages[0].page_id.clone(),
            revision: manifest.revision.clone(),
            source_hash: expected.source_hash.clone(),
            source_annotation_revision: expected.source_annotation_revision.clone(),
            conversion_revision: expected.conversion_revision.clone(),
            crop: None,
            width_px: 1,
            height_px: 1,
        };

        let result = super::publish_ink_snapshot(&db, &spec, &expected, draft, &png);
        assert_eq!(result.unwrap_err().code, expected_error);
        let conn = db.get_conn_safe().unwrap();
        let artifacts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ink_render_artifacts WHERE render_id = ?1",
                [format!("render-publish-{drift}")],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            artifacts, 0,
            "rejected snapshot must not publish an artifact row"
        );
        let png_ref_count: Option<i32> = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&png_hash],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(
            png_ref_count.unwrap_or(0),
            0,
            "rejected snapshot must not retain the rendered PNG ref"
        );
    }

    #[test]
    fn checked_render_publication_rejects_source_annotation_drift_without_artifact_or_png_reference(
    ) {
        assert_publication_drift_rejected_without_artifact_or_blob_ref(
            "annotation",
            "REVISION_CONFLICT",
        );
    }

    #[test]
    fn checked_render_publication_rejects_source_blob_drift_without_artifact_or_png_reference() {
        assert_publication_drift_rejected_without_artifact_or_blob_ref("source", "SOURCE_CHANGED");
    }

    #[test]
    fn checked_render_publication_rejects_manifest_revision_drift_without_artifact_or_png_reference(
    ) {
        assert_publication_drift_rejected_without_artifact_or_blob_ref(
            "revision",
            "REVISION_CONFLICT",
        );
    }

    #[tokio::test]
    async fn pending_flush_failure_is_observable_without_webview() {
        let bus = PendingFlushBus::default();
        let receiver = bus.register("flush-1", "document-1").unwrap();
        let entry = bus.pending.lock().unwrap().remove("flush-1").unwrap();
        entry
            .sender
            .send(super::InkFlushResponse {
                request_id: "flush-1".to_owned(),
                document_id: "document-1".to_owned(),
                ok: false,
                error_code: Some("EDITOR_BUSY".to_owned()),
            })
            .unwrap();
        let response = receiver.await.unwrap();
        assert!(!response.ok);
        assert_eq!(response.error_code.as_deref(), Some("EDITOR_BUSY"));
    }

    #[test]
    fn board_frozen_inputs_map_negative_origin_chunk_and_expected_revision() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (manifest, chunk) = saved_board_fixture(&db);
        let spec = board_render_spec(&manifest, &manifest.revision, board_crop());

        let first = load_frozen_inputs(&db, &spec).expect("frozen board inputs");
        assert!(first.page_ref.is_none(), "board mode has no page_ref");
        assert!(first.page.is_none(), "board mode has no page");
        let board = first.board.as_ref().expect("frozen board payload");
        assert_eq!(board.crop, board_crop());
        assert_eq!(board.chunk_refs, manifest.chunks);
        assert_eq!(board.chunk_refs.len(), 1);
        let chunk_ref = &board.chunk_refs[0];
        let chunk_bytes = serde_json::to_vec(&chunk).unwrap();
        assert_eq!(chunk_ref.chunk_id, chunk.chunk_id);
        assert_eq!(chunk_ref.blob_hash, VfsBlobRepo::compute_hash(&chunk_bytes));
        assert_eq!(chunk_ref.blob_hash.len(), 64);
        assert_eq!(chunk_ref.byte_length, chunk_bytes.len() as u64);
        assert_eq!(chunk_ref.object_count, 1);
        assert_eq!(chunk_ref.sample_count, 0);
        assert_eq!(
            chunk_ref.bounds,
            InkBoardBounds {
                x: -21.0,
                y: -11.0,
                width: 42.0,
                height: 22.0,
            }
        );
        assert_eq!(board.chunks, vec![chunk], "chunk objects stay unaltered");
        let first_render_id = render_id_for(&spec, &first).unwrap();

        let second = load_frozen_inputs(&db, &spec).expect("repeated frozen board inputs");
        assert_eq!(render_id_for(&spec, &second).unwrap(), first_render_id);
    }

    #[test]
    fn board_render_request_uses_frozen_board_payload_without_page_ref() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (manifest, _chunk) = saved_board_fixture(&db);
        let spec = board_render_spec(&manifest, &manifest.revision, board_crop());
        let frozen = load_frozen_inputs(&db, &spec).expect("frozen board inputs");
        let board = frozen.board.clone().expect("frozen board payload");

        let request = build_board_render_request(
            &frozen.manifest,
            &board.surface,
            board.crop,
            board.chunks.clone(),
            "render-board-1",
        )
        .expect("frozen board request");

        assert_eq!(request.render_id, "render-board-1");
        assert_eq!(request.document_id, frozen.manifest.document_id);
        assert_eq!(request.revision, frozen.manifest.revision);
        assert!(request.page_ref.is_none());
        assert!(request.page.is_none());
        assert!(request.background.is_none());
        assert!(request.highlights.is_empty());
        assert!(request.source_annotation_revision.is_none());
        assert!(request.crop.is_none());
        assert_eq!(request.long_edge, 2048);
        let payload = request.board.expect("board payload");
        assert_eq!(payload.schema_version, INK_BOARD_SCHEMA_VERSION);
        assert_eq!(payload.surface, board.surface);
        assert_eq!(payload.crop, board.crop);
        assert_eq!(payload.chunks, board.chunks);
    }

    #[test]
    fn board_frozen_inputs_reject_stale_revision_and_out_of_world_crop() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (manifest, _chunk) = saved_board_fixture(&db);

        let stale_spec = board_render_spec(&manifest, "r_stale_before_save", board_crop());
        let error = load_frozen_board_error(&db, &stale_spec);
        assert_eq!(error.code, "REVISION_CONFLICT");
        assert_eq!(
            error.current_revision.as_deref(),
            Some(manifest.revision.as_str())
        );

        let cases = [
            (
                "x below world limit",
                InkRect {
                    x: -INK_BOARD_WORLD_LIMIT - 1.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                },
            ),
            (
                "y below world limit",
                InkRect {
                    x: 0.0,
                    y: -INK_BOARD_WORLD_LIMIT - 1.0,
                    width: 10.0,
                    height: 10.0,
                },
            ),
            (
                "right edge beyond world limit",
                InkRect {
                    x: INK_BOARD_WORLD_LIMIT,
                    y: 0.0,
                    width: 1.0,
                    height: 10.0,
                },
            ),
            (
                "bottom edge beyond world limit",
                InkRect {
                    x: 0.0,
                    y: INK_BOARD_WORLD_LIMIT,
                    width: 10.0,
                    height: 1.0,
                },
            ),
            (
                "zero width",
                InkRect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 10.0,
                },
            ),
            (
                "negative height",
                InkRect {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: -1.0,
                },
            ),
            (
                "NaN x",
                InkRect {
                    x: f64::NAN,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                },
            ),
            (
                "infinite width",
                InkRect {
                    x: 0.0,
                    y: 0.0,
                    width: f64::INFINITY,
                    height: 10.0,
                },
            ),
        ];
        for (label, crop) in cases {
            let spec = board_render_spec(&manifest, &manifest.revision, crop);
            let error = load_frozen_board_error(&db, &spec);
            assert_eq!(error.code, "INVALID_ARGUMENT", "{label}: {error:?}");
        }
    }

    #[test]
    fn board_frozen_render_request_selector_returns_board_payload_and_signed_crop() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (manifest, _chunk) = saved_board_fixture(&db);
        let spec = board_render_spec(&manifest, &manifest.revision, board_crop());
        let frozen = load_frozen_inputs(&db, &spec).expect("frozen board inputs");
        let render_id = render_id_for(&spec, &frozen).unwrap();
        let mut default_spec = spec.clone();
        default_spec.long_edge = None;
        assert_eq!(
            render_id_for(&default_spec, &frozen).unwrap(),
            render_id,
            "unspecified long edge must normalize to the 2048 default"
        );

        let (request, page_id, crop) =
            super::build_frozen_render_request(&spec, &frozen, &render_id)
                .expect("shared selector must preserve board dispatch");
        let surface_page_id = match frozen.board.as_ref().expect("board").surface.clone() {
            InkBoardSurface::Board { page_id, .. } => page_id,
        };
        assert_eq!(page_id, surface_page_id);
        assert_eq!(crop, Some(board_crop()));
        assert!(request.page_ref.is_none());
        assert!(request.page.is_none());
        let payload = request.board.expect("board payload");
        assert_eq!(payload.surface, frozen.board.as_ref().unwrap().surface);
        assert_eq!(payload.crop, board_crop());
        assert_eq!(payload.chunks, frozen.board.as_ref().unwrap().chunks);

        let mut scaled_spec = spec.clone();
        scaled_spec.long_edge = Some(200);
        let scaled_render_id = render_id_for(&scaled_spec, &frozen).unwrap();
        let (scaled_request, _, _) =
            super::build_frozen_render_request(&scaled_spec, &frozen, &scaled_render_id)
                .expect("shared selector must honor the board long edge");
        assert_eq!(scaled_request.long_edge, 200);

        let mut large_spec = spec.clone();
        large_spec.long_edge = Some(400);
        let large_render_id = render_id_for(&large_spec, &frozen).unwrap();
        assert_ne!(scaled_render_id, large_render_id);
        let (large_request, _, _) =
            super::build_frozen_render_request(&large_spec, &frozen, &large_render_id)
                .expect("shared selector must honor a distinct board long edge");
        assert_eq!(large_request.long_edge, 400);
    }

    #[test]
    fn board_artifact_publish_persists_signed_world_crop_and_renderer_render_id() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (manifest, _chunk) = saved_board_fixture(&db);
        let spec = board_render_spec(&manifest, &manifest.revision, board_crop());
        let frozen = load_frozen_inputs(&db, &spec).expect("frozen board inputs");
        let page_id = match frozen.board.as_ref().expect("board").surface.clone() {
            InkBoardSurface::Board { page_id, .. } => page_id,
        };
        let render_id = render_id_for(&spec, &frozen).unwrap();
        let draft = artifact_draft(
            &frozen,
            &page_id,
            &manifest.revision,
            &render_id,
            board_crop(),
        );
        let png = rendered_png_fixture();

        let stored = super::publish_ink_snapshot(&db, &spec, &frozen, draft, &png)
            .expect("board artifact publish");
        assert_eq!(stored.render_id, render_id);
        assert_eq!(stored.render_id, render_id_for(&spec, &frozen).unwrap());
        assert_eq!(stored.page_id, page_id);
        assert_eq!(stored.revision, manifest.revision);
        assert_eq!(stored.crop, Some(board_crop()));

        let conn = db.get_conn_safe().unwrap();
        let (reopened, bytes) =
            VfsInkArtifactRepo::load_with_conn(&conn, db.blobs_dir(), &render_id).unwrap();
        assert_eq!(reopened, stored);
        assert_eq!(bytes, png);
        assert_eq!(reopened.crop, Some(board_crop()));
        assert_eq!(reopened.page_id, page_id);
        assert_eq!(reopened.revision, manifest.revision);
    }

    #[test]
    fn board_artifact_publish_rejects_stale_expected_revision_without_artifact() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (manifest, _chunk) = saved_board_fixture(&db);
        let current_spec = board_render_spec(&manifest, &manifest.revision, board_crop());
        let frozen = load_frozen_inputs(&db, &current_spec).expect("frozen board inputs");
        let page_id = match frozen.board.as_ref().expect("board").surface.clone() {
            InkBoardSurface::Board { page_id, .. } => page_id,
        };
        let render_id = render_id_for(&current_spec, &frozen).unwrap();
        let draft = artifact_draft(
            &frozen,
            &page_id,
            &manifest.revision,
            &render_id,
            board_crop(),
        );
        let stale_spec = board_render_spec(&manifest, "r_stale_before_render", board_crop());

        let error =
            super::publish_ink_snapshot(&db, &stale_spec, &frozen, draft, &rendered_png_fixture())
                .unwrap_err();
        assert_eq!(error.code, "REVISION_CONFLICT");
        let conn = db.get_conn_safe().unwrap();
        let artifacts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ink_render_artifacts WHERE render_id = ?1",
                [&render_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(artifacts, 0);
    }

    #[test]
    fn paged_artifact_publish_still_rejects_negative_crop() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (_resource_id, _source_file_id, manifest, _background_hash) =
            create_prepared_pdf(&db, "bridge-paged-negative-crop");
        let spec = frozen_spec(&manifest);
        let frozen = load_frozen_inputs(&db, &spec).expect("frozen paged inputs");
        let page_id = manifest.pages[0].page_id.clone();
        let render_id = render_id_for(&spec, &frozen).unwrap();
        let negative_crop = InkRect {
            x: -1.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        let draft = artifact_draft(
            &frozen,
            &page_id,
            &manifest.revision,
            &render_id,
            negative_crop,
        );

        let error =
            super::publish_ink_snapshot(&db, &spec, &frozen, draft, &rendered_png_fixture())
                .unwrap_err();
        assert_eq!(error.code, "INVALID_RENDER");
        let conn = db.get_conn_safe().unwrap();
        let artifacts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ink_render_artifacts WHERE render_id = ?1",
                [&render_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(artifacts, 0);
    }
}

use crate::vfs::{
    database::VfsDatabase,
    error::VfsError,
    ink::{
        InkBackground, InkBoardBounds, InkBoardChunk, InkBoardChunkRef, InkBoardSurface,
        InkManifest, InkPage, InkPageRef, InkRect, InkRuling, InkSource, INK_BOARD_SCHEMA_VERSION,
        INK_BOARD_WORLD_LIMIT,
    },
    repos::{
        ink_board_repo::VfsInkBoardRepo, ink_source::validate_ink_source_with_conn, InkArtifact,
        InkArtifactDraft, VfsBlobRepo, VfsInkArtifactRepo, VfsInkRepo,
    },
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const RENDER_EVENT: &str = "ink:render-request";
const FLUSH_EVENT: &str = "ink:flush-request";
const RENDER_TIMEOUT: Duration = Duration::from_secs(120);
const FLUSH_TIMEOUT: Duration = Duration::from_secs(30);
const PNG_MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_IMAGE_BLOB_BYTES: i64 = 64 * 1024 * 1024;
const RENDERER_PROFILE: &str = "deepstudent-ink-canvas-v1";
/// Renderer profile for the explicit v2 board payload (signed world crop +
/// ordered chunk mapping). Kept separate so existing v1 render ids stay stable.
const RENDERER_PROFILE_BOARD_V2: &str = "deepstudent-ink-canvas-v2-board";
/// One board render may materialize at most 16 MiB of chunk JSON.
const BOARD_RENDER_JSON_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Explicit board render payload. Absence of this field means paged v1 mode;
/// board mode never reuses `InkRenderSpec::crop` or a synthetic fixed page.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkBoardRenderSpec {
    /// Absolute signed world rectangle represented by the output raster.
    pub crop: InkRect,
    /// Optional canonical chunk subset in caller order. Empty means all chunks
    /// whose bounds intersect `crop`, bounded by the batch budget.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chunk_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkRenderSpec {
    pub document_id: String,
    pub expected_revision: String,
    pub page_id: String,
    /// v1 paged crop; always nonnegative and inside the frozen page.
    #[serde(default)]
    pub crop: Option<InkRect>,
    /// Explicit v2 board render payload; mutually exclusive with `crop`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<InkBoardRenderSpec>,
    #[serde(default)]
    pub long_edge: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InkRenderBackground {
    Image {
        blob_hash: String,
    },
    PdfPage {
        blob_hash: String,
        source_page_index: u32,
    },
}

/// Explicit v2 board payload for the renderer event. Board objects stay in
/// their canonical chunks; they are never coerced into an `InkPage`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkBoardRenderPayload {
    pub schema_version: u32,
    pub surface: InkBoardSurface,
    /// Absolute signed world rectangle to rasterize.
    pub crop: InkRect,
    pub chunks: Vec<InkBoardChunk>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkRenderRequest {
    pub request_id: String,
    pub render_id: String,
    pub document_id: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_ref: Option<InkPageRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<InkPage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<InkBoardRenderPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<InkRect>,
    pub long_edge: u32,
    pub highlights: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_annotation_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<InkRenderBackground>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Build an immutable event payload exclusively from one manifest/page snapshot.
pub fn build_render_request(
    manifest: &InkManifest,
    page_ref: &InkPageRef,
    page: InkPage,
    render_id: &str,
) -> Result<InkRenderRequest, InkBridgeError> {
    if render_id.trim().is_empty()
        || manifest.revision.trim().is_empty()
        || manifest.document_id.trim().is_empty()
        || page.page_id != page_ref.page_id
        || !manifest.pages.contains(page_ref)
    {
        return Err(InkBridgeError::InvalidIdentity);
    }
    Ok(InkRenderRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        render_id: render_id.to_owned(),
        document_id: manifest.document_id.clone(),
        revision: manifest.revision.clone(),
        page_ref: Some(page_ref.clone()),
        page: Some(page),
        board: None,
        crop: None,
        long_edge: 2048,
        highlights: Vec::new(),
        source_annotation_revision: None,
        background: match &page_ref.background {
            InkBackground::Blank { .. } => None,
            InkBackground::Image { blob_hash } => Some(InkRenderBackground::Image {
                blob_hash: blob_hash.clone(),
            }),
            InkBackground::PdfPage {
                blob_hash,
                source_page_index,
            } => Some(InkRenderBackground::PdfPage {
                blob_hash: blob_hash.clone(),
                source_page_index: *source_page_index,
            }),
        },
        session_id: None,
        tool_call_id: None,
    })
}

/// Build an explicit v2 board event payload from immutable chunk snapshots.
pub fn build_board_render_request(
    manifest: &InkManifest,
    surface: &InkBoardSurface,
    crop: InkRect,
    chunks: Vec<InkBoardChunk>,
    render_id: &str,
) -> Result<InkRenderRequest, InkBridgeError> {
    let page_id = match surface {
        InkBoardSurface::Board { page_id, .. } => page_id,
    };
    if render_id.trim().is_empty()
        || manifest.revision.trim().is_empty()
        || manifest.document_id.trim().is_empty()
        || manifest.schema_version != INK_BOARD_SCHEMA_VERSION
        || manifest.surface.as_ref() != Some(surface)
        || manifest.chunks.is_empty() && !chunks.is_empty()
    {
        return Err(InkBridgeError::InvalidIdentity);
    }
    Ok(InkRenderRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        render_id: render_id.to_owned(),
        document_id: manifest.document_id.clone(),
        revision: manifest.revision.clone(),
        page_ref: None,
        page: None,
        board: Some(InkBoardRenderPayload {
            schema_version: manifest.schema_version,
            surface: surface.clone(),
            crop,
            chunks,
        }),
        crop: None,
        long_edge: 2048,
        highlights: Vec::new(),
        source_annotation_revision: None,
        background: None,
        session_id: None,
        tool_call_id: None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InkRenderIdentity {
    pub request_id: String,
    pub render_id: String,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InkRenderResult {
    pub request_id: String,
    pub render_id: String,
    pub staged_upload_id: String,
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkRenderResponse {
    pub request_id: String,
    pub render_id: String,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub staged_upload_id: Option<String>,
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub error_stack: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InkBridgeError {
    InvalidIdentity,
    DuplicateRequest,
    ForeignWebview,
    IdentityMismatch,
    NotPending,
    Cancelled,
    Timeout,
    RenderFailed { code: String, message: String },
}

/// Identity-scoped request/response API for renderer requests.
#[derive(Default, Clone)]
pub struct PendingRenderBus {
    pending: Arc<Mutex<HashMap<String, PendingResponse>>>,
}

struct PendingResponse {
    render_id: String,
    session_id: Option<String>,
    tool_call_id: Option<String>,
    sender: oneshot::Sender<Result<InkRenderResult, InkBridgeError>>,
}

impl PendingRenderBus {
    pub fn register(&self, identity: InkRenderIdentity) -> Result<PendingRender, InkBridgeError> {
        if identity.request_id.is_empty()
            || identity.render_id.is_empty()
            || identity.session_id.is_some() != identity.tool_call_id.is_some()
        {
            return Err(InkBridgeError::InvalidIdentity);
        }
        let (sender, receiver) = oneshot::channel();
        let mut pending = self.pending.lock().expect("pending render bus poisoned");
        if pending.contains_key(&identity.request_id) {
            return Err(InkBridgeError::DuplicateRequest);
        }
        pending.insert(
            identity.request_id.clone(),
            PendingResponse {
                render_id: identity.render_id.clone(),
                session_id: identity.session_id.clone(),
                tool_call_id: identity.tool_call_id.clone(),
                sender,
            },
        );
        drop(pending);
        Ok(PendingRender {
            identity,
            receiver: Some(receiver),
            bus: self.clone(),
        })
    }

    /// Validate the real window label against the app's configured main window.
    pub fn complete_from_webview(
        &self,
        app: &AppHandle,
        window: &WebviewWindow,
        result: InkRenderResult,
    ) -> Result<(), InkBridgeError> {
        let configured_main_label = configured_main_label(app);
        self.complete_from_labels(window.label(), configured_main_label, result)
    }

    fn complete_response_from_webview(
        &self,
        app: &AppHandle,
        window: &WebviewWindow,
        response: InkRenderResponse,
    ) -> Result<(), InkBridgeError> {
        let configured_main_label = configured_main_label(app);
        let source_label = window.label();
        if configured_main_label != Some(source_label) {
            return Err(InkBridgeError::ForeignWebview);
        }
        let staged_upload_id = response
            .staged_upload_id
            .ok_or(InkBridgeError::InvalidIdentity)?;
        let width_px = response.width_px.ok_or(InkBridgeError::InvalidIdentity)?;
        let height_px = response.height_px.ok_or(InkBridgeError::InvalidIdentity)?;
        if staged_upload_id.trim().is_empty()
            || staged_upload_id.len() > 128
            || !(1..=2048).contains(&width_px)
            || !(1..=2048).contains(&height_px)
            || u64::from(width_px) * u64::from(height_px) > 16_000_000
            || response.error_code.is_some()
            || response.error_message.is_some()
            || response.error_stack.is_some()
        {
            return Err(InkBridgeError::InvalidIdentity);
        }
        let request_id = response.request_id.clone();
        let render_id = response.render_id.clone();
        let completion = Ok(InkRenderResult {
            request_id: response.request_id,
            render_id: response.render_id,
            staged_upload_id,
            width_px,
            height_px,
        });
        self.finish_from_labels(
            source_label,
            configured_main_label,
            &request_id,
            &render_id,
            response.session_id,
            response.tool_call_id,
            completion,
        )
    }

    fn fail_response_from_webview(
        &self,
        app: &AppHandle,
        window: &WebviewWindow,
        response: InkRenderResponse,
    ) -> Result<(), InkBridgeError> {
        let configured_main_label = configured_main_label(app);
        if response.staged_upload_id.is_some()
            || response.width_px.is_some()
            || response.height_px.is_some()
            || response
                .error_code
                .as_deref()
                .is_none_or(|code| code.is_empty() || code.len() > 64)
            || response
                .error_message
                .as_deref()
                .is_none_or(|message| message.is_empty() || message.len() > 2048)
            || response
                .error_stack
                .as_deref()
                .is_some_and(|stack| stack.len() > 8192)
        {
            return Err(InkBridgeError::InvalidIdentity);
        }
        self.fail_from_labels(window.label(), configured_main_label, response)
    }

    fn complete_from_labels(
        &self,
        source_label: &str,
        configured_main_label: Option<&str>,
        result: InkRenderResult,
    ) -> Result<(), InkBridgeError> {
        let request_id = result.request_id.clone();
        let render_id = result.render_id.clone();
        self.finish_from_labels(
            source_label,
            configured_main_label,
            &request_id,
            &render_id,
            None,
            None,
            Ok(result),
        )
    }

    fn fail_from_labels(
        &self,
        source_label: &str,
        configured_main_label: Option<&str>,
        response: InkRenderResponse,
    ) -> Result<(), InkBridgeError> {
        let code = response.error_code.ok_or(InkBridgeError::InvalidIdentity)?;
        let message = response
            .error_message
            .ok_or(InkBridgeError::InvalidIdentity)?;
        self.finish_from_labels(
            source_label,
            configured_main_label,
            &response.request_id,
            &response.render_id,
            response.session_id,
            response.tool_call_id,
            Err(InkBridgeError::RenderFailed { code, message }),
        )
    }

    fn finish_from_labels(
        &self,
        source_label: &str,
        configured_main_label: Option<&str>,
        request_id: &str,
        render_id: &str,
        session_id: Option<String>,
        tool_call_id: Option<String>,
        result: Result<InkRenderResult, InkBridgeError>,
    ) -> Result<(), InkBridgeError> {
        if configured_main_label != Some(source_label) {
            return Err(InkBridgeError::ForeignWebview);
        }
        let mut pending = self.pending.lock().expect("pending render bus poisoned");
        let Some(expected) = pending.get(request_id) else {
            return Err(InkBridgeError::NotPending);
        };
        if expected.render_id != render_id {
            return Err(InkBridgeError::IdentityMismatch);
        }
        if expected.session_id != session_id || expected.tool_call_id != tool_call_id {
            return Err(InkBridgeError::IdentityMismatch);
        }
        let response = pending
            .remove(request_id)
            .expect("pending response was checked while holding the same lock");
        drop(pending);
        response
            .sender
            .send(result)
            .map_err(|_| InkBridgeError::NotPending)?;
        Ok(())
    }

    fn remove_if_matching(&self, identity: &InkRenderIdentity) {
        let mut pending = self.pending.lock().expect("pending render bus poisoned");
        if pending
            .get(&identity.request_id)
            .is_some_and(|response| response.render_id == identity.render_id)
        {
            pending.remove(&identity.request_id);
        }
    }

    fn fail_from_app(&self, request_id: &str, error: InkBridgeError) -> Result<(), InkBridgeError> {
        let mut pending = self.pending.lock().expect("pending render bus poisoned");
        let response = pending
            .remove(request_id)
            .ok_or(InkBridgeError::NotPending)?;
        drop(pending);
        response
            .sender
            .send(Err(error))
            .map_err(|_| InkBridgeError::NotPending)
    }
}

pub struct PendingRender {
    identity: InkRenderIdentity,
    receiver: Option<oneshot::Receiver<Result<InkRenderResult, InkBridgeError>>>,
    bus: PendingRenderBus,
}

impl PendingRender {
    pub fn identity(&self) -> &InkRenderIdentity {
        &self.identity
    }

    pub async fn wait(
        mut self,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<InkRenderResult, InkBridgeError> {
        let Some(receiver) = self.receiver.take() else {
            return Err(InkBridgeError::NotPending);
        };
        tokio::select! {
            biased;
            result = receiver => result.map_err(|_| InkBridgeError::NotPending).and_then(|result| result),
            _ = cancellation.cancelled() => Err(InkBridgeError::Cancelled),
            _ = tokio::time::sleep(timeout) => Err(InkBridgeError::Timeout),
        }
    }
}

impl Drop for PendingRender {
    fn drop(&mut self) {
        self.bus.remove_if_matching(&self.identity);
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InkFlushRequest {
    pub request_id: String,
    pub document_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InkFlushResponse {
    pub request_id: String,
    pub document_id: String,
    pub ok: bool,
    pub error_code: Option<String>,
}

#[derive(Default, Clone)]
pub struct PendingFlushBus {
    pending: Arc<Mutex<HashMap<String, PendingFlushEntry>>>,
}

struct PendingFlushEntry {
    document_id: String,
    sender: oneshot::Sender<InkFlushResponse>,
}

impl PendingFlushBus {
    fn register(
        &self,
        request_id: &str,
        document_id: &str,
    ) -> Result<oneshot::Receiver<InkFlushResponse>, InkBridgeError> {
        let (sender, receiver) = oneshot::channel();
        let mut pending = self.pending.lock().expect("pending ink flush bus poisoned");
        if pending.contains_key(request_id) {
            return Err(InkBridgeError::DuplicateRequest);
        }
        pending.insert(
            request_id.to_owned(),
            PendingFlushEntry {
                document_id: document_id.to_owned(),
                sender,
            },
        );
        Ok(receiver)
    }

    fn complete_from_webview(
        &self,
        app: &AppHandle,
        window: &WebviewWindow,
        response: InkFlushResponse,
    ) -> Result<(), InkBridgeError> {
        if configured_main_label(app) != Some(window.label()) {
            return Err(InkBridgeError::ForeignWebview);
        }
        let mut pending = self.pending.lock().expect("pending ink flush bus poisoned");
        let entry = pending
            .get(&response.request_id)
            .ok_or(InkBridgeError::NotPending)?;
        if entry.document_id != response.document_id {
            return Err(InkBridgeError::IdentityMismatch);
        }
        let entry = pending
            .remove(&response.request_id)
            .expect("flush entry checked under same lock");
        drop(pending);
        entry
            .sender
            .send(response)
            .map_err(|_| InkBridgeError::NotPending)
    }

    fn remove(&self, request_id: &str) {
        self.pending
            .lock()
            .expect("pending ink flush bus poisoned")
            .remove(request_id);
    }
}

fn configured_main_label(app: &AppHandle) -> Option<&str> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .map(|window| window.label.as_str())
}

#[derive(Debug, Clone, Serialize)]
pub struct InkRenderCommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
}

impl InkRenderCommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            current_revision: None,
        }
    }

    fn revision_conflict(current_revision: Option<String>) -> Self {
        Self {
            code: "REVISION_CONFLICT".to_owned(),
            message:
                "The Ink document or source annotations changed before the render was published."
                    .to_owned(),
            current_revision,
        }
    }
}

impl From<InkBridgeError> for InkRenderCommandError {
    fn from(error: InkBridgeError) -> Self {
        match error {
            InkBridgeError::InvalidIdentity | InkBridgeError::IdentityMismatch => Self::new(
                "INVALID_ARGUMENT",
                "Ink render response identity is invalid.",
            ),
            InkBridgeError::DuplicateRequest => Self::new(
                "INVALID_ARGUMENT",
                "Ink render request ID is already in use.",
            ),
            InkBridgeError::ForeignWebview => Self::new(
                "UNTRUSTED_WEBVIEW",
                "Only the configured main webview may answer an Ink render request.",
            ),
            InkBridgeError::NotPending => Self::new(
                "STALE_RENDER_RESPONSE",
                "The Ink render request is no longer pending.",
            ),
            InkBridgeError::Cancelled => Self::new("CANCELLED", "Ink rendering was cancelled."),
            InkBridgeError::Timeout => Self::new(
                "RENDER_UNAVAILABLE",
                "The main webview did not complete the Ink render before timeout.",
            ),
            InkBridgeError::RenderFailed { code, message } => Self::new(&code, message),
        }
    }
}

#[derive(Clone, PartialEq)]
pub(crate) struct FrozenBoardInputs {
    pub(crate) surface: InkBoardSurface,
    pub(crate) crop: InkRect,
    pub(crate) chunk_refs: Vec<InkBoardChunkRef>,
    pub(crate) chunks: Vec<InkBoardChunk>,
}

#[derive(Clone)]
pub(crate) struct FrozenRenderInputs {
    pub(crate) manifest: InkManifest,
    pub(crate) page_ref: Option<InkPageRef>,
    pub(crate) page: Option<InkPage>,
    pub(crate) board: Option<FrozenBoardInputs>,
    pub(crate) highlights: Vec<Value>,
    pub(crate) source_annotation_revision: Option<String>,
    pub(crate) source_hash: Option<String>,
    pub(crate) conversion_revision: Option<String>,
}

impl FrozenRenderInputs {
    fn page_id(&self) -> Result<&str, InkRenderCommandError> {
        if let Some(page_ref) = &self.page_ref {
            return Ok(&page_ref.page_id);
        }
        self.board
            .as_ref()
            .map(|board| match &board.surface {
                InkBoardSurface::Board { page_id, .. } => page_id.as_str(),
            })
            .ok_or_else(|| {
                InkRenderCommandError::new(
                    "RENDER_UNAVAILABLE",
                    "Frozen Ink inputs have no page or board surface.",
                )
            })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct InkFrozenRenderInputs {
    revision: String,
    source: InkSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_ref: Option<InkPageRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<InkPage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    board: Option<InkBoardRenderPayload>,
    highlights: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_annotation_revision: Option<String>,
}

fn annotation_snapshot(
    conn: &rusqlite::Connection,
    resource_id: &str,
) -> Result<(Vec<Value>, Option<String>), String> {
    let row = conn
        .query_row(
            "SELECT CAST(updated_at AS TEXT), metadata_json FROM resources WHERE id = ?1",
            [resource_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((updated_at, raw_metadata)) = row else {
        return Ok((Vec::new(), None));
    };
    let metadata: Value = match raw_metadata {
        Some(raw) => serde_json::from_str(&raw).map_err(|error| error.to_string())?,
        None => Value::Null,
    };
    let highlights = metadata
        .get("extra")
        .and_then(|extra| extra.get("highlights"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let highlight_bytes = serde_json::to_vec(&highlights).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(updated_at.as_bytes());
    hasher.update(&highlight_bytes);
    Ok((
        highlights,
        Some(format!("annotations-{}", hex::encode(hasher.finalize()))),
    ))
}

pub(crate) fn load_frozen_inputs(
    db: &VfsDatabase,
    spec: &InkRenderSpec,
) -> Result<FrozenRenderInputs, InkRenderCommandError> {
    validate_render_spec(spec)?;
    let mut conn = db
        .get_conn_safe()
        .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))?;
    let tx = conn
        .transaction()
        .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))?;
    let inputs = load_frozen_inputs_with_conn(&tx, db.blobs_dir(), spec)?;
    tx.commit()
        .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))?;
    Ok(inputs)
}

pub(crate) fn load_frozen_inputs_with_conn(
    conn: &rusqlite::Connection,
    blobs_dir: &std::path::Path,
    spec: &InkRenderSpec,
) -> Result<FrozenRenderInputs, InkRenderCommandError> {
    validate_render_spec(spec)?;
    let manifest = VfsInkRepo::get_manifest_with_conn(conn, blobs_dir, &spec.document_id)
        .map_err(|error| InkRenderCommandError::new("RESOURCE_NOT_FOUND", error.to_string()))?;
    if manifest.revision != spec.expected_revision {
        return Err(InkRenderCommandError::revision_conflict(Some(
            manifest.revision,
        )));
    }
    if let Some(board_spec) = &spec.board {
        return load_frozen_board_inputs_with_conn(conn, blobs_dir, spec, manifest, board_spec);
    }
    let page_ref = manifest
        .pages
        .iter()
        .find(|page| page.page_id == spec.page_id)
        .cloned()
        .ok_or_else(|| {
            InkRenderCommandError::new("RESOURCE_NOT_FOUND", "Ink page was not found.")
        })?;
    let page = VfsInkRepo::get_page_with_conn(conn, blobs_dir, &spec.document_id, &spec.page_id)
        .map_err(|error| InkRenderCommandError::new("RESOURCE_NOT_FOUND", error.to_string()))?;
    let (source_hash, conversion_revision, annotations_resource) = match &manifest.source {
        InkSource::Blank {} => (None, None, None),
        InkSource::Resource {
            resource_id,
            source_hash,
            conversion_revision,
        } => {
            if source_resource_matches(conn, blobs_dir, resource_id, source_hash)? {
                (
                    Some(source_hash.clone()),
                    Some(conversion_revision.clone()),
                    Some(resource_id.as_str()),
                )
            } else {
                (
                    Some(source_hash.clone()),
                    Some(conversion_revision.clone()),
                    None,
                )
            }
        }
    };
    if let Some(hash) = background_blob_hash(&page_ref.background) {
        let blob = VfsBlobRepo::get_blob_with_conn(conn, hash)
            .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))?
            .ok_or_else(|| {
                InkRenderCommandError::new(
                    "RESOURCE_NOT_FOUND",
                    "Frozen Ink page background is missing.",
                )
            })?;
        if blob.size < 0 || blob.size > MAX_IMAGE_BLOB_BYTES {
            return Err(InkRenderCommandError::new(
                "LIMIT_EXCEEDED",
                "Frozen Ink page background exceeds the render input limit.",
            ));
        }
    }
    let (highlights, source_annotation_revision) = match annotations_resource {
        Some(resource_id) => annotation_snapshot(conn, resource_id)
            .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error))?,
        None => (Vec::new(), None),
    };
    Ok(FrozenRenderInputs {
        manifest,
        page_ref: Some(page_ref),
        page: Some(page),
        board: None,
        highlights,
        source_annotation_revision,
        source_hash,
        conversion_revision,
    })
}

fn load_frozen_board_inputs_with_conn(
    conn: &rusqlite::Connection,
    blobs_dir: &std::path::Path,
    spec: &InkRenderSpec,
    manifest: InkManifest,
    board_spec: &InkBoardRenderSpec,
) -> Result<FrozenRenderInputs, InkRenderCommandError> {
    if manifest.schema_version != INK_BOARD_SCHEMA_VERSION {
        return Err(InkRenderCommandError::new(
            "INVALID_ARGUMENT",
            "Board render requires a v2 board document.",
        ));
    }
    let surface = manifest.surface.clone().ok_or_else(|| {
        InkRenderCommandError::new("RESOURCE_NOT_FOUND", "Ink board surface is missing.")
    })?;
    let surface_page_id = match &surface {
        InkBoardSurface::Board { page_id, .. } => page_id,
    };
    if surface_page_id != &spec.page_id {
        return Err(InkRenderCommandError::new(
            "RESOURCE_NOT_FOUND",
            "Ink board surface page was not found.",
        ));
    }
    let crop = board_spec.crop;
    let refs_by_id = manifest
        .chunks
        .iter()
        .map(|chunk_ref| (chunk_ref.chunk_id.as_str(), chunk_ref))
        .collect::<HashMap<_, _>>();
    let selected = if board_spec.chunk_ids.is_empty() {
        manifest
            .chunks
            .iter()
            .filter(|chunk_ref| board_bounds_intersect(chunk_ref.bounds, crop))
            .collect::<Vec<_>>()
    } else {
        let mut seen = std::collections::HashSet::new();
        let mut selected = Vec::with_capacity(board_spec.chunk_ids.len());
        for chunk_id in &board_spec.chunk_ids {
            if !seen.insert(chunk_id.as_str()) {
                return Err(InkRenderCommandError::new(
                    "INVALID_ARGUMENT",
                    "Ink board render chunk selection contains duplicates.",
                ));
            }
            let chunk_ref = refs_by_id.get(chunk_id.as_str()).ok_or_else(|| {
                InkRenderCommandError::new(
                    "RESOURCE_NOT_FOUND",
                    "Requested Ink board chunk was not found.",
                )
            })?;
            selected.push(*chunk_ref);
        }
        selected
    };
    let total_bytes = selected.iter().try_fold(0u64, |total, chunk_ref| {
        total.checked_add(chunk_ref.byte_length)
    });
    if total_bytes.map_or(true, |total| total > BOARD_RENDER_JSON_MAX_BYTES) {
        return Err(InkRenderCommandError::new(
            "LIMIT_EXCEEDED",
            "Ink board render chunk batch exceeds the 16 MiB budget.",
        ));
    }
    let chunk_ids = selected
        .iter()
        .map(|chunk_ref| chunk_ref.chunk_id.clone())
        .collect::<Vec<_>>();
    let chunks =
        VfsInkBoardRepo::get_chunks_with_conn(conn, blobs_dir, &spec.document_id, &chunk_ids)
            .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))?;
    if chunks.len() != chunk_ids.len() {
        return Err(InkRenderCommandError::new(
            "RENDER_UNAVAILABLE",
            "Ink board chunk snapshot was incomplete.",
        ));
    }
    let chunk_refs = selected.into_iter().cloned().collect::<Vec<_>>();
    Ok(FrozenRenderInputs {
        manifest,
        page_ref: None,
        page: None,
        board: Some(FrozenBoardInputs {
            surface,
            crop,
            chunk_refs,
            chunks,
        }),
        highlights: Vec::new(),
        source_annotation_revision: None,
        source_hash: None,
        conversion_revision: None,
    })
}

fn board_bounds_intersect(bounds: InkBoardBounds, crop: InkRect) -> bool {
    bounds.x < crop.x + crop.width
        && bounds.x + bounds.width > crop.x
        && bounds.y < crop.y + crop.height
        && bounds.y + bounds.height > crop.y
}

fn source_resource_matches(
    conn: &rusqlite::Connection,
    blobs_dir: &std::path::Path,
    resource_id: &str,
    frozen_hash: &str,
) -> Result<bool, InkRenderCommandError> {
    validate_ink_source_with_conn(conn, blobs_dir, resource_id, Some(frozen_hash))
        .map(|source| source.is_some())
        .map_err(|error| match &error {
            VfsError::Conflict { key, .. } if key == "ink.source_changed" => {
                InkRenderCommandError::new("SOURCE_CHANGED", error.to_string())
            }
            VfsError::Conflict { key, .. } if key == "ink.limit_exceeded" => {
                InkRenderCommandError::new("LIMIT_EXCEEDED", error.to_string())
            }
            _ => InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()),
        })
}

fn background_blob_hash(background: &InkBackground) -> Option<&str> {
    match background {
        InkBackground::Blank { .. } => None,
        InkBackground::Image { blob_hash } | InkBackground::PdfPage { blob_hash, .. } => {
            Some(blob_hash)
        }
    }
}

fn validate_render_spec(spec: &InkRenderSpec) -> Result<(), InkRenderCommandError> {
    if spec.document_id.trim().is_empty()
        || spec.page_id.trim().is_empty()
        || spec.expected_revision.trim().is_empty()
    {
        return Err(InkRenderCommandError::new(
            "INVALID_ARGUMENT",
            "Document, page, and expected revision are required.",
        ));
    }
    if spec
        .long_edge
        .is_some_and(|value| value == 0 || value > 2048)
    {
        return Err(InkRenderCommandError::new(
            "LIMIT_EXCEEDED",
            "Ink render long edge must be between 1 and 2048 pixels.",
        ));
    }
    if let Some(crop) = spec.crop {
        if spec.board.is_some() {
            return Err(InkRenderCommandError::new(
                "INVALID_ARGUMENT",
                "Paged crop and board render cannot be combined.",
            ));
        }
        if !crop.x.is_finite()
            || !crop.y.is_finite()
            || !crop.width.is_finite()
            || !crop.height.is_finite()
            || crop.x < 0.0
            || crop.y < 0.0
            || crop.width <= 0.0
            || crop.height <= 0.0
        {
            return Err(InkRenderCommandError::new(
                "INVALID_ARGUMENT",
                "Ink render crop is invalid.",
            ));
        }
    }
    if let Some(board) = &spec.board {
        if spec.crop.is_some() {
            return Err(InkRenderCommandError::new(
                "INVALID_ARGUMENT",
                "Paged crop and board render cannot be combined.",
            ));
        }
        let crop = board.crop;
        if !crop.x.is_finite()
            || !crop.y.is_finite()
            || !crop.width.is_finite()
            || !crop.height.is_finite()
            || crop.width <= 0.0
            || crop.height <= 0.0
            || crop.x < -INK_BOARD_WORLD_LIMIT
            || crop.y < -INK_BOARD_WORLD_LIMIT
            || crop.x + crop.width > INK_BOARD_WORLD_LIMIT
            || crop.y + crop.height > INK_BOARD_WORLD_LIMIT
        {
            return Err(InkRenderCommandError::new(
                "INVALID_ARGUMENT",
                "Ink board render crop is outside the finite world range.",
            ));
        }
        if board.chunk_ids.len() > 256
            || board
                .chunk_ids
                .iter()
                .any(|chunk_id| chunk_id.trim().is_empty())
        {
            return Err(InkRenderCommandError::new(
                "INVALID_ARGUMENT",
                "Ink board render chunk selection is invalid.",
            ));
        }
    }
    Ok(())
}

fn render_id_for(
    spec: &InkRenderSpec,
    inputs: &FrozenRenderInputs,
) -> Result<String, InkRenderCommandError> {
    let identity = if let Some(board) = &inputs.board {
        let chunk_mapping = board
            .chunk_refs
            .iter()
            .map(|chunk_ref| {
                (
                    chunk_ref.chunk_id.as_str(),
                    chunk_ref.blob_hash.as_str(),
                    chunk_ref.byte_length,
                    chunk_ref.object_count,
                    chunk_ref.sample_count,
                    chunk_ref.bounds,
                )
            })
            .collect::<Vec<_>>();
        serde_json::to_vec(&(
            &spec.document_id,
            &spec.expected_revision,
            &board.crop,
            inputs.manifest.schema_version,
            &inputs.manifest.revision,
            chunk_mapping,
            spec.long_edge.unwrap_or(2048),
            RENDERER_PROFILE_BOARD_V2,
        ))
    } else {
        serde_json::to_vec(&(
            spec,
            &inputs.manifest.revision,
            &inputs.source_hash,
            &inputs.conversion_revision,
            &inputs.source_annotation_revision,
            RENDERER_PROFILE,
        ))
    }
    .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))?;
    Ok(hex::encode(Sha256::digest(identity)))
}

fn same_frozen_inputs(left: &FrozenRenderInputs, right: &FrozenRenderInputs) -> bool {
    left.manifest.revision == right.manifest.revision
        && left.page_ref == right.page_ref
        && left.page == right.page
        && left.board == right.board
        && left.highlights == right.highlights
        && left.source_annotation_revision == right.source_annotation_revision
        && left.source_hash == right.source_hash
        && left.conversion_revision == right.conversion_revision
}

fn publish_ink_snapshot(
    db: &VfsDatabase,
    spec: &InkRenderSpec,
    expected: &FrozenRenderInputs,
    draft: InkArtifactDraft,
    png: &[u8],
) -> Result<InkArtifact, InkRenderCommandError> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))?;
    VfsInkArtifactRepo::store_png_checked_with_conn(
        &conn,
        db.blobs_dir(),
        draft,
        png,
        |writer_conn| {
            let current = load_frozen_inputs_with_conn(writer_conn, db.blobs_dir(), spec).map_err(
                |error| {
                    let key = if error.code == "SOURCE_CHANGED" {
                        "ink.artifact.source_changed"
                    } else {
                        "ink.artifact.snapshot_changed"
                    };
                    VfsError::Conflict {
                        key: key.to_owned(),
                        message: error.message,
                    }
                },
            )?;
            if !same_frozen_inputs(expected, &current) {
                return Err(VfsError::Conflict {
                    key: "ink.artifact.snapshot_changed".to_owned(),
                    message: "Frozen Ink inputs changed before artifact publication.".to_owned(),
                });
            }
            Ok(())
        },
    )
    .map_err(|error| match error {
        VfsError::Conflict { key, message } if key == "ink.artifact.source_changed" => {
            InkRenderCommandError::new("SOURCE_CHANGED", message)
        }
        VfsError::Conflict { key, message } if key == "ink.artifact.snapshot_changed" => {
            InkRenderCommandError::new("REVISION_CONFLICT", message)
        }
        other => InkRenderCommandError::new("INVALID_RENDER", other.to_string()),
    })
}

async fn flush_editor_before_render(
    app: &AppHandle,
    flush_bus: &PendingFlushBus,
    document_id: &str,
) -> Result<(), InkRenderCommandError> {
    let main = app
        .get_webview_window("main")
        .filter(|window| configured_main_label(app) == Some(window.label()))
        .ok_or_else(|| {
            InkRenderCommandError::new(
                "RENDER_UNAVAILABLE",
                "Configured main webview is unavailable.",
            )
        })?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let receiver = flush_bus
        .register(&request_id, document_id)
        .map_err(InkRenderCommandError::from)?;
    let request = InkFlushRequest {
        request_id: request_id.clone(),
        document_id: document_id.to_owned(),
    };
    if let Err(error) = main.emit(FLUSH_EVENT, request) {
        flush_bus.remove(&request_id);
        return Err(InkRenderCommandError::new(
            "RENDER_UNAVAILABLE",
            error.to_string(),
        ));
    }
    let result = tokio::time::timeout(FLUSH_TIMEOUT, receiver).await;
    flush_bus.remove(&request_id);
    match result {
        Ok(Ok(response)) if response.ok => Ok(()),
        Ok(Ok(_)) => Err(InkRenderCommandError::new(
            "EDITOR_BUSY",
            "The Ink editor could not flush its pending changes.",
        )),
        Ok(Err(_)) | Err(_) => Err(InkRenderCommandError::new(
            "EDITOR_BUSY",
            "The Ink editor flush request did not complete.",
        )),
    }
}

pub(crate) async fn flush_ink_editor(
    app: &AppHandle,
    document_id: &str,
) -> Result<(), InkRenderCommandError> {
    let flush_bus = app.state::<PendingFlushBus>().inner().clone();
    flush_editor_before_render(app, &flush_bus, document_id).await
}

fn build_frozen_render_request(
    spec: &InkRenderSpec,
    inputs: &FrozenRenderInputs,
    render_id: &str,
) -> Result<(InkRenderRequest, String, Option<InkRect>), InkRenderCommandError> {
    if spec.board.is_some() != inputs.board.is_some() {
        return Err(InkRenderCommandError::new(
            "RENDER_UNAVAILABLE",
            "Frozen Ink inputs do not match the render mode.",
        ));
    }
    if let Some(board_inputs) = inputs.board.as_ref() {
        let mut request = build_board_render_request(
            &inputs.manifest,
            &board_inputs.surface,
            board_inputs.crop,
            board_inputs.chunks.clone(),
            render_id,
        )
        .map_err(InkRenderCommandError::from)?;
        request.long_edge = spec.long_edge.unwrap_or(2048);
        let page_id = match &board_inputs.surface {
            InkBoardSurface::Board { page_id, .. } => page_id.clone(),
        };
        return Ok((request, page_id, Some(board_inputs.crop)));
    }
    let page_ref = inputs.page_ref.as_ref().ok_or_else(|| {
        InkRenderCommandError::new("RENDER_UNAVAILABLE", "Paged Ink render inputs are missing.")
    })?;
    let page = inputs.page.clone().ok_or_else(|| {
        InkRenderCommandError::new("RENDER_UNAVAILABLE", "Paged Ink render inputs are missing.")
    })?;
    let page_id = page_ref.page_id.clone();
    if let Some(crop) = spec.crop {
        if crop.x + crop.width > page_ref.width || crop.y + crop.height > page_ref.height {
            return Err(InkRenderCommandError::new(
                "INVALID_ARGUMENT",
                "Ink render crop must be inside the frozen page.",
            ));
        }
    }
    let mut request = build_render_request(&inputs.manifest, page_ref, page, render_id)
        .map_err(InkRenderCommandError::from)?;
    request.crop = spec.crop;
    request.long_edge = spec.long_edge.unwrap_or(2048);
    request.highlights = inputs.highlights.clone();
    request.source_annotation_revision = inputs.source_annotation_revision.clone();
    Ok((request, page_id, spec.crop))
}

pub async fn render_ink_snapshot(
    app: &AppHandle,
    db: Arc<VfsDatabase>,
    spec: InkRenderSpec,
    session_id: Option<&str>,
    tool_call_id: Option<&str>,
    cancellation: Option<CancellationToken>,
) -> Result<InkArtifact, InkRenderCommandError> {
    if session_id.is_some() != tool_call_id.is_some() {
        return Err(InkRenderCommandError::new(
            "INVALID_ARGUMENT",
            "Tool render requests require both session_id and tool_call_id.",
        ));
    }
    let flush_bus = app.state::<PendingFlushBus>().inner().clone();
    flush_editor_before_render(app, &flush_bus, &spec.document_id).await?;
    let initial_spec = spec.clone();
    let snapshot_db = db.clone();
    let inputs = tauri::async_runtime::spawn_blocking(move || {
        load_frozen_inputs(&snapshot_db, &initial_spec)
    })
    .await
    .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))??;
    let render_id = render_id_for(&spec, &inputs)?;
    let identity = InkRenderIdentity {
        request_id: uuid::Uuid::new_v4().to_string(),
        render_id: render_id.clone(),
        session_id: session_id.map(str::to_owned),
        tool_call_id: tool_call_id.map(str::to_owned),
    };
    let (mut request, page_id, crop) = build_frozen_render_request(&spec, &inputs, &render_id)?;
    request.request_id = identity.request_id.clone();
    request.session_id = identity.session_id.clone();
    request.tool_call_id = identity.tool_call_id.clone();

    let main = app
        .get_webview_window("main")
        .filter(|window| configured_main_label(app) == Some(window.label()))
        .ok_or_else(|| {
            InkRenderCommandError::new(
                "RENDER_UNAVAILABLE",
                "Configured main webview is unavailable.",
            )
        })?;
    let bus = app.state::<PendingRenderBus>().inner().clone();
    let pending = bus
        .register(identity)
        .map_err(InkRenderCommandError::from)?;
    main.emit(RENDER_EVENT, request)
        .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))?;
    let cancel = cancellation.unwrap_or_default();
    let rendered = pending
        .wait(RENDER_TIMEOUT, &cancel)
        .await
        .map_err(InkRenderCommandError::from)?;

    let db_for_store = db.clone();
    let publish_spec = spec.clone();
    let expected_inputs = inputs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let staged = crate::staged_upload::take_staged_upload(&rendered.staged_upload_id)
            .map_err(|error| InkRenderCommandError::new("INVALID_RENDER", error))?;
        let png = staged
            .read_bounded(PNG_MAX_BYTES)
            .map_err(|error| InkRenderCommandError::new("LIMIT_EXCEEDED", error))?;
        if rendered.width_px == 0
            || rendered.height_px == 0
            || rendered.width_px > 2048
            || rendered.height_px > 2048
            || u64::from(rendered.width_px) * u64::from(rendered.height_px) > 16_000_000
        {
            return Err(InkRenderCommandError::new(
                "LIMIT_EXCEEDED",
                "Rendered PNG dimensions exceed the Ink snapshot limits.",
            ));
        }
        let draft = InkArtifactDraft {
            artifact_id: rendered.render_id.clone(),
            render_id: rendered.render_id,
            document_id: expected_inputs.manifest.document_id.clone(),
            page_id,
            revision: expected_inputs.manifest.revision.clone(),
            source_hash: expected_inputs.source_hash.clone(),
            source_annotation_revision: expected_inputs.source_annotation_revision.clone(),
            conversion_revision: expected_inputs.conversion_revision.clone(),
            crop,
            width_px: rendered.width_px,
            height_px: rendered.height_px,
        };
        publish_ink_snapshot(&db_for_store, &publish_spec, &expected_inputs, draft, &png)
    })
    .await
    .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))?
}

#[tauri::command]
pub async fn vfs_ink_get_render_inputs(
    app: AppHandle,
    window: WebviewWindow,
    document_id: String,
    expected_revision: String,
    page_id: String,
    board: Option<InkBoardRenderSpec>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<InkFrozenRenderInputs, InkRenderCommandError> {
    if configured_main_label(&app) != Some(window.label()) {
        return Err(InkRenderCommandError::new(
            "UNTRUSTED_WEBVIEW",
            "Only the configured main webview may read frozen Ink render inputs.",
        ));
    }
    let request = InkRenderSpec {
        document_id,
        expected_revision,
        page_id,
        crop: None,
        board,
        long_edge: None,
    };
    let db = vfs_db.inner().clone();
    let inputs = tauri::async_runtime::spawn_blocking(move || load_frozen_inputs(&db, &request))
        .await
        .map_err(|error| InkRenderCommandError::new("RENDER_UNAVAILABLE", error.to_string()))??;
    let schema_version = inputs.manifest.schema_version;
    let board = inputs.board.map(|board| InkBoardRenderPayload {
        schema_version,
        surface: board.surface,
        crop: board.crop,
        chunks: board.chunks,
    });
    Ok(InkFrozenRenderInputs {
        revision: inputs.manifest.revision,
        source: inputs.manifest.source,
        page_ref: inputs.page_ref,
        page: inputs.page,
        board,
        highlights: inputs.highlights,
        source_annotation_revision: inputs.source_annotation_revision,
    })
}

#[tauri::command]
pub async fn vfs_ink_render(
    app: AppHandle,
    window: WebviewWindow,
    request: InkRenderSpec,
    session_id: Option<String>,
    tool_call_id: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<InkArtifact, InkRenderCommandError> {
    if configured_main_label(&app) != Some(window.label()) {
        return Err(InkRenderCommandError::new(
            "UNTRUSTED_WEBVIEW",
            "Only the configured main webview may start a UI Ink render.",
        ));
    }
    render_ink_snapshot(
        &app,
        vfs_db.inner().clone(),
        request,
        session_id.as_deref(),
        tool_call_id.as_deref(),
        None,
    )
    .await
}

#[tauri::command]
pub fn vfs_ink_render_result(
    app: AppHandle,
    window: WebviewWindow,
    response: InkRenderResponse,
    bus: State<'_, PendingRenderBus>,
) -> Result<(), InkRenderCommandError> {
    if response.error_code.is_some() || response.error_message.is_some() {
        bus.fail_response_from_webview(&app, &window, response)
            .map_err(InkRenderCommandError::from)
    } else {
        bus.complete_response_from_webview(&app, &window, response)
            .map_err(InkRenderCommandError::from)
    }
}

#[tauri::command]
pub fn vfs_ink_flush_result(
    app: AppHandle,
    window: WebviewWindow,
    response: InkFlushResponse,
    bus: State<'_, PendingFlushBus>,
) -> Result<(), InkRenderCommandError> {
    bus.complete_from_webview(&app, &window, response)
        .map_err(InkRenderCommandError::from)
}
