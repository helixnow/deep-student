//! Native Wry E2E for production Ink board rendering and inline PDF/image preparation.
//!
//! The isolated page registers the production job and render bridges. Real
//! attachment uploads are prepared through `vfs_ink_prepare`, edited through
//! the page commands, reopened, and rendered into checked immutable artifacts.
//! No mock converter/renderer, pre-encoded converted PNG, or main-app bootstrap.
//!
//! From the project root, build `npm run build:ink-e2e`; then from `src-tauri`,
//! export TAURI_CONFIG from tauri.ink-e2e.conf.json and run
//! `xvfb-run -a cargo +1.98.1 test --test ink_board_render_e2e -- --nocapture`.
//! TAURI_CONFIG is required at compile time. Assets come from the ignored
//! `src-tauri/target/ink-e2e-client/`; HOME/XDG and the migrated VFS are temporary.

use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use deep_student_lib::ink_bridge::{
    InkBoardRenderSpec, InkRenderSpec, PendingFlushBus, PendingRenderBus,
};
use deep_student_lib::ink_jobs::PendingInkJobBus;
use deep_student_lib::vfs::database::setup_migrated_test_db;
use deep_student_lib::vfs::ink::{
    InkAuthor, InkBackground, InkBoardChunk, InkBoardObject, InkBoardSurface, InkManifest,
    InkObject, InkObjectContent, InkPage, InkPageRef, InkRect, InkRuling, InkSample, InkSource,
    InkStrokeStyle, InkTool, INK_BOARD_SCHEMA_VERSION, INK_SCHEMA_VERSION,
};
use deep_student_lib::vfs::repos::ink_board_repo::VfsInkBoardRepo;
use deep_student_lib::vfs::repos::{
    VfsAttachmentRepo, VfsBlobRepo, VfsFileRepo, VfsInkArtifactRepo, VfsInkRepo,
};
use deep_student_lib::vfs::types::VfsUploadAttachmentParams;
use deep_student_lib::vfs::VfsDatabase;
use image::ImageEncoder;
use serde_json::{json, Value};
use tauri::{Listener, Manager};

const TEST_APP_LABEL: &str = "main";
const POSITIVE_PHASE: &str = "positive";
const POSITIVE_SCALED_PHASE: &str = "positive_scaled";
const INVALID_PHASE: &str = "invalid_crop";
const STALE_PHASE: &str = "stale_revision";
const PDF_PREPARE_PHASE: &str = "prepare_inline_pdf";
const IMAGE_PREPARE_PHASE: &str = "prepare_inline_image";
const SOURCE_RENDER_WIDTH: u32 = 160;
const SOURCE_RENDER_HEIGHT: u32 = 120;
const EVENT_READY: &str = "ink-e2e-ready";
const EVENT_RESULT: &str = "ink-e2e-result";
const EVENT_DONE: &str = "ink-e2e-done";

struct PrepareSourceFixture {
    phase: &'static str,
    resource_id: String,
    file_id: String,
    source_hash: String,
    bytes: Vec<u8>,
    snapshot: Value,
    metadata: Value,
}

fn inline_pdf() -> Vec<u8> {
    let drawing = "q\n1 1 1 rg\n0 0 160 120 re f\n0 0 1 rg\n96 72 32 24 re f\nQ\n";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 120] /Resources << >> /Contents 4 0 R >>"
            .to_owned(),
        format!(
            "<< /Length {} >>\nstream\n{}endstream",
            drawing.len(),
            drawing
        ),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1,
        )
        .as_bytes(),
    );
    pdf
}

fn inline_source_png() -> Vec<u8> {
    let mut image = image::RgbaImage::from_pixel(
        SOURCE_RENDER_WIDTH,
        SOURCE_RENDER_HEIGHT,
        image::Rgba([255, 255, 255, 255]),
    );
    for y in 24..48 {
        for x in 96..128 {
            image.put_pixel(x, y, image::Rgba([0, 0, 255, 255]));
        }
    }
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ColorType::Rgba8,
        )
        .expect("encode generated source image, not a converted page");
    bytes
}

fn source_snapshot(db: &VfsDatabase, resource_id: &str, file_id: &str) -> Value {
    let conn = db.get_conn_safe().expect("source snapshot connection");
    let resource = conn
        .query_row(
            "SELECT hash, type, source_id, source_table, storage_mode, data, external_hash, deleted_at FROM resources WHERE id = ?1",
            [resource_id],
            |row| {
                Ok(json!({
                    "hash": row.get::<_, String>(0)?,
                    "type": row.get::<_, String>(1)?,
                    "source_id": row.get::<_, Option<String>>(2)?,
                    "source_table": row.get::<_, Option<String>>(3)?,
                    "storage_mode": row.get::<_, String>(4)?,
                    "data": row.get::<_, Option<String>>(5)?,
                    "external_hash": row.get::<_, Option<String>>(6)?,
                    "deleted_at": row.get::<_, Option<i64>>(7)?,
                }))
            },
        )
        .expect("read inline source identity and bytes");
    let file = VfsFileRepo::get_file_with_conn(&conn, file_id)
        .expect("read source file")
        .expect("source file exists");
    json!({ "resource": resource, "file": file })
}

fn source_metadata(db: &VfsDatabase, resource_id: &str) -> Value {
    let conn = db.get_conn_safe().expect("source metadata connection");
    let raw: Option<String> = conn
        .query_row(
            "SELECT metadata_json FROM resources WHERE id = ?1",
            [resource_id],
            |row| row.get(0),
        )
        .expect("read source metadata");
    serde_json::from_str(raw.as_deref().unwrap_or("{}")).expect("source metadata is JSON")
}

fn upload_prepare_source(
    db: &VfsDatabase,
    phase: &'static str,
    name: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> PrepareSourceFixture {
    let source_hash = VfsBlobRepo::compute_hash(&bytes);
    let uploaded = {
        let conn = db.get_conn_safe().expect("attachment upload connection");
        VfsAttachmentRepo::upload_bytes_with_conn(
            &conn,
            db.blobs_dir(),
            &VfsUploadAttachmentParams {
                name: name.to_owned(),
                mime_type: mime.to_owned(),
                base64_content: String::new(),
                attachment_type: Some(
                    if mime == "image/png" { "image" } else { "file" }.to_owned(),
                ),
            },
            &bytes,
        )
        .expect("upload generated source through the real attachment repository")
    };
    assert!(uploaded.is_new);
    assert_eq!(uploaded.attachment.content_hash, source_hash);
    assert!(
        uploaded.attachment.blob_hash.is_none(),
        "fixture must use inline storage"
    );
    let resource_id = uploaded
        .attachment
        .resource_id
        .expect("inline upload resource");
    let file_id = uploaded.source_id;
    let snapshot = source_snapshot(db, &resource_id, &file_id);
    assert_eq!(snapshot["resource"]["storage_mode"], "inline");
    assert_eq!(
        snapshot["resource"]["type"],
        if mime == "image/png" { "image" } else { "file" }
    );
    assert_ne!(
        snapshot["resource"]["hash"].as_str(),
        Some(source_hash.as_str())
    );
    let stored = STANDARD
        .decode(
            snapshot["resource"]["data"]
                .as_str()
                .expect("inline base64 source"),
        )
        .expect("decode uploaded source");
    assert_eq!(stored, bytes);
    let metadata = source_metadata(db, &resource_id);
    assert!(metadata.get("default_ink_document_id").is_none());
    PrepareSourceFixture {
        phase,
        resource_id,
        file_id,
        source_hash,
        bytes,
        snapshot,
        metadata,
    }
}

fn prepared_stroke(phase: &str, page_ref: &InkPageRef) -> InkObject {
    InkObject {
        id: format!("e2e-{phase}-stroke"),
        author: InkAuthor::User,
        created_at: 3,
        content: InkObjectContent::Stroke {
            samples: vec![
                InkSample {
                    x: page_ref.width / 4.0,
                    y: page_ref.height * 0.75,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
                InkSample {
                    x: page_ref.width / 2.0,
                    y: page_ref.height * 0.75,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
            ],
            style: InkStrokeStyle {
                tool: InkTool::Pen,
                color: "#000000".to_owned(),
                width: page_ref.width / 32.0,
                pressure_enabled: false,
            },
        },
    }
}

fn board_crop() -> InkRect {
    InkRect {
        x: -100.0,
        y: -80.0,
        width: 200.0,
        height: 160.0,
    }
}

fn stroke_object() -> InkBoardObject {
    InkBoardObject {
        id: "e2e-negative-origin-stroke".to_owned(),
        author: InkAuthor::User,
        created_at: 1,
        z_index: 1,
        content: InkObjectContent::Stroke {
            samples: vec![
                InkSample {
                    x: -45.0,
                    y: -35.0,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
                InkSample {
                    x: -20.0,
                    y: -35.0,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
            ],
            style: InkStrokeStyle {
                tool: InkTool::Pen,
                color: "#000000".to_owned(),
                width: 4.0,
                pressure_enabled: false,
            },
        },
    }
}

fn ai_region_object() -> InkBoardObject {
    InkBoardObject {
        id: "e2e-ai-red-region".to_owned(),
        author: InkAuthor::Ai,
        created_at: 2,
        z_index: 2,
        content: InkObjectContent::RegionHighlight {
            rect: InkRect {
                x: 40.0,
                y: 30.0,
                width: 20.0,
                height: 20.0,
            },
            color: "#ff0000ff".to_owned(),
            width: 2.0,
        },
    }
}

fn highlighter_object() -> InkBoardObject {
    InkBoardObject {
        id: "e2e-green-highlighter".to_owned(),
        author: InkAuthor::User,
        created_at: 3,
        z_index: 3,
        content: InkObjectContent::Stroke {
            samples: vec![
                InkSample {
                    x: 40.0,
                    y: 70.0,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
                InkSample {
                    x: 60.0,
                    y: 70.0,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
            ],
            style: InkStrokeStyle {
                tool: InkTool::Highlighter,
                color: "#00ff0080".to_owned(),
                width: 12.0,
                pressure_enabled: false,
            },
        },
    }
}

fn board_chunks() -> Vec<InkBoardChunk> {
    vec![
        InkBoardChunk {
            schema_version: INK_BOARD_SCHEMA_VERSION,
            chunk_id: "e2e-chunk-negative-origin".to_owned(),
            objects: vec![stroke_object()],
        },
        InkBoardChunk {
            schema_version: INK_BOARD_SCHEMA_VERSION,
            chunk_id: "e2e-chunk-ai-and-highlighter".to_owned(),
            objects: vec![ai_region_object(), highlighter_object()],
        },
    ]
}

fn save_board_fixture(db: &VfsDatabase) -> (String, String) {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let created = VfsInkBoardRepo::create_blank_with_conn(
        &conn,
        db.blobs_dir(),
        "Native Ink E2E board",
        InkRuling::Blank,
        "e2e-board-create",
        None,
    )
    .expect("create board through migrated repository");
    let saved = VfsInkBoardRepo::save_chunks_with_conn(
        &conn,
        db.blobs_dir(),
        &created.document_id,
        &created.revision,
        "e2e-board-save",
        &board_chunks(),
        &[],
    )
    .expect("save board chunks through migrated repository");
    assert_ne!(saved.revision, created.revision);
    (created.document_id, saved.revision)
}

fn board_page_id(db: &VfsDatabase, document_id: &str, revision: &str) -> String {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let manifest = VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), document_id)
        .expect("re-read saved board manifest");
    assert_eq!(manifest.revision, revision);
    match manifest.surface.expect("saved board surface") {
        InkBoardSurface::Board { page_id, .. } => page_id,
    }
}

fn render_spec(
    document_id: &str,
    revision: &str,
    page_id: &str,
    crop: InkRect,
    long_edge: u32,
) -> InkRenderSpec {
    InkRenderSpec {
        document_id: document_id.to_owned(),
        expected_revision: revision.to_owned(),
        page_id: page_id.to_owned(),
        crop: None,
        board: Some(InkBoardRenderSpec {
            crop,
            chunk_ids: Vec::new(),
        }),
        long_edge: Some(long_edge),
    }
}

fn render_script(
    positive: &InkRenderSpec,
    positive_scaled: &InkRenderSpec,
    invalid: &InkRenderSpec,
    stale: &InkRenderSpec,
    sources: &[PrepareSourceFixture],
) -> String {
    let positive = serde_json::to_string(positive).expect("encode positive spec");
    let positive_scaled =
        serde_json::to_string(positive_scaled).expect("encode positive scaled spec");
    let invalid = serde_json::to_string(invalid).expect("encode invalid spec");
    let stale = serde_json::to_string(stale).expect("encode stale spec");
    let sources = serde_json::to_string(
        &sources
            .iter()
            .map(|source| {
                json!({
                    "phase": source.phase,
                    "source_resource_id": source.resource_id,
                })
            })
            .collect::<Vec<_>>(),
    )
    .expect("encode uploaded prepare source identities");
    format!(
        r##"
(async () => {{
  const invoke = (command, request) =>
    window.__TAURI_INTERNALS__.invoke(command, {{ request }});
  const emit = (event, payload) =>
    window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{ event, payload }});
  const run = async (phase, request) => {{
    try {{
      const result = await invoke('vfs_ink_render', request);
      await emit('{result}', {{ phase, ok: true, result }});
    }} catch (error) {{
      await emit('{result}', {{ phase, ok: false, error }});
    }}
  }};
  const prepare = async (source) => {{
    const phase = source.phase;
    let step = 'prepare';
    try {{
      const prepared = await invoke('vfs_ink_prepare', {{
        source_resource_id: source.source_resource_id,
        operation_id: phase + '-prepare',
      }});
      const document_id = prepared.document_id;
      step = 'get_prepared_manifest';
      const opened = await invoke('vfs_ink_get', {{ document_id }});
      const pageRef = opened.pages[0];
      if (!pageRef) throw new Error('Prepared source has no canonical page');
      const page_id = pageRef.page_id;
      step = 'get_prepared_page';
      const empty_page = await invoke('vfs_ink_get_page', {{ document_id, page_id }});
      step = 'render_background_control';
      const before_artifact = await invoke('vfs_ink_render', {{
        document_id, page_id, expected_revision: opened.revision, long_edge: {source_width},
      }});
      const stroke = {{
        id: 'e2e-' + phase + '-stroke', author: 'user', created_at: 3,
        content: {{
          kind: 'stroke',
          samples: [
            {{ x: pageRef.width / 4, y: pageRef.height * 0.75, pressure: 0.5 }},
            {{ x: pageRef.width / 2, y: pageRef.height * 0.75, pressure: 0.5 }},
          ],
          style: {{ tool: 'pen', color: '#000000', width: pageRef.width / 32, pressure_enabled: false }},
        }},
      }};
      step = 'save_page_stroke';
      const saved = await invoke('vfs_ink_save_page', {{
        document_id, expected_revision: opened.revision, operation_id: phase + '-save',
        page: {{ ...empty_page, objects: [...empty_page.objects, stroke] }},
      }});
      step = 'reopen_manifest';
      const reopened = await invoke('vfs_ink_get', {{ document_id }});
      step = 'reopen_page';
      const page = await invoke('vfs_ink_get_page', {{ document_id, page_id }});
      step = 'prepare_reuses_saved_document';
      const reused = await invoke('vfs_ink_prepare', {{
        source_resource_id: source.source_resource_id,
        operation_id: phase + '-reuse',
      }});
      step = 'render_saved_page';
      const artifact = await invoke('vfs_ink_render', {{
        document_id, page_id, expected_revision: reopened.revision, long_edge: {source_width},
      }});
      step = 'reopen_after_render';
      const after_render = await invoke('vfs_ink_get', {{ document_id }});
      const after_page = await invoke('vfs_ink_get_page', {{ document_id, page_id }});
      await emit('{result}', {{ phase, ok: true, result: {{
        prepared, opened, empty_page, before_artifact, saved, reopened, page,
        reused, artifact, after_render, after_page,
      }} }});
    }} catch (error) {{
      await emit('{result}', {{
        phase, ok: false, step,
        error: error instanceof Error ? {{ message: error.message, stack: error.stack }} : error,
      }});
    }}
  }};
  await run('{positive_phase}', {positive});
  await run('{positive_scaled_phase}', {positive_scaled});
  await run('{invalid_phase}', {invalid});
  await run('{stale_phase}', {stale});
  for (const source of {sources}) await prepare(source);
  await emit('{done}', {{}});
}})().catch(async (error) => {{
  try {{
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
      event: 'ink-e2e-boot-error',
      payload: {{ error: String((error && error.stack) || error) }},
    }});
  }} catch (_) {{}}
}});
"##,
        result = EVENT_RESULT,
        done = EVENT_DONE,
        positive_phase = POSITIVE_PHASE,
        positive_scaled_phase = POSITIVE_SCALED_PHASE,
        invalid_phase = INVALID_PHASE,
        stale_phase = STALE_PHASE,
        positive = positive,
        positive_scaled = positive_scaled,
        invalid = invalid,
        stale = stale,
        sources = sources,
        source_width = SOURCE_RENDER_WIDTH,
    )
}

fn artifact_count_for_document(db: &VfsDatabase, document_id: &str) -> usize {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let mut statement = conn
        .prepare("SELECT metadata_json FROM ink_render_artifacts")
        .expect("prepare artifact count");
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query artifact rows");
    rows.filter_map(Result::ok)
        .filter(|raw| {
            serde_json::from_str::<Value>(raw)
                .ok()
                .and_then(|value| value["document_id"].as_str().map(str::to_owned))
                .is_some_and(|id| id == document_id)
        })
        .count()
}

fn phase_result(messages: &[Value], requested: &str) -> Value {
    messages
        .iter()
        .find(|message| {
            message["kind"] == "result" && message["payload"]["phase"].as_str() == Some(requested)
        })
        .cloned()
        .unwrap_or_else(|| panic!("missing native render phase {requested}: {messages:?}"))
}

fn error_code(error: &Value) -> String {
    error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or_default()
        .to_owned()
}

fn assert_source_unchanged(db: &VfsDatabase, document_id: &str, revision: &str) {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let manifest = VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), document_id)
        .expect("re-read source board after render");
    assert_eq!(
        manifest.revision, revision,
        "render must not rewrite the board"
    );
    assert_eq!(manifest.chunks.len(), 2, "render must not detach chunks");
    for chunk_ref in &manifest.chunks {
        let blob = VfsBlobRepo::get_blob_with_conn(&conn, &chunk_ref.blob_hash)
            .expect("read chunk blob metadata")
            .expect("chunk blob remains readable");
        assert_eq!(blob.size, chunk_ref.byte_length as i64);
    }
}

fn assert_artifact(
    db: &VfsDatabase,
    document_id: &str,
    revision: &str,
    page_id: &str,
    render_id: &str,
    scale: u32,
) {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let (artifact, bytes) = VfsInkArtifactRepo::load_with_conn(&conn, db.blobs_dir(), render_id)
        .expect("load and hash-check published artifact");
    assert_eq!(artifact.document_id, document_id);
    assert_eq!(artifact.revision, revision);
    assert_eq!(artifact.page_id, page_id);
    assert_eq!(artifact.crop, Some(board_crop()));
    assert_eq!(
        (artifact.width_px, artifact.height_px),
        (200 * scale, 160 * scale)
    );
    assert_eq!(artifact.mime_type, "image/png");
    assert_eq!(artifact.blob_hash, artifact.content_hash);
    assert_eq!(
        VfsBlobRepo::compute_hash(&bytes),
        artifact.content_hash,
        "stored immutable PNG hash must match"
    );

    let rgba = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .expect("decode published PNG")
        .to_rgba8();
    let pixel = |x: u32, y: u32| rgba.get_pixel(x * scale, y * scale).0;
    assert_eq!(
        pixel(10, 10),
        [255, 255, 255, 255],
        "blank board background"
    );
    assert_eq!(
        pixel(65, 45),
        [0, 0, 0, 255],
        "negative-origin crop translation"
    );
    assert_eq!(
        pixel(150, 120),
        [255, 0, 0, 255],
        "AI region inside the crop"
    );
    let highlighter = pixel(150, 150);
    assert_eq!(highlighter[1], 255);
    assert_eq!(highlighter[0], highlighter[2]);
    assert!(
        (120..=135).contains(&highlighter[0]),
        "highlighter must blend over white, got {highlighter:?}"
    );
    assert_eq!(highlighter[3], 255);
}

fn load_prepared_artifact(
    db: &VfsDatabase,
    wire: &Value,
    manifest: &InkManifest,
    source: &PrepareSourceFixture,
) -> (String, image::RgbaImage) {
    let render_id = wire["render_id"].as_str().expect("native paged render ID");
    let conn = db.get_conn_safe().expect("prepared artifact connection");
    let (artifact, bytes) = VfsInkArtifactRepo::load_with_conn(&conn, db.blobs_dir(), render_id)
        .expect("load and hash-check immutable prepared-page artifact");
    assert_eq!(serde_json::to_value(&artifact).unwrap(), *wire);
    assert_eq!(artifact.document_id, manifest.document_id);
    assert_eq!(artifact.revision, manifest.revision);
    assert_eq!(artifact.page_id, manifest.pages[0].page_id);
    assert_eq!(
        artifact.source_hash.as_deref(),
        Some(source.source_hash.as_str())
    );
    let conversion_revision = match &manifest.source {
        InkSource::Resource {
            conversion_revision,
            ..
        } => conversion_revision,
        other => panic!("prepared source must retain its provenance: {other:?}"),
    };
    assert_eq!(
        artifact.conversion_revision.as_ref(),
        Some(conversion_revision)
    );
    assert_eq!(artifact.crop, None);
    assert_eq!(
        (artifact.width_px, artifact.height_px),
        (SOURCE_RENDER_WIDTH, SOURCE_RENDER_HEIGHT)
    );
    assert_eq!(artifact.mime_type, "image/png");
    assert_eq!(artifact.blob_hash, artifact.content_hash);
    assert_eq!(VfsBlobRepo::compute_hash(&bytes), artifact.content_hash);
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .expect("decode real prepared-page render")
        .to_rgba8();
    assert_eq!(
        image.dimensions(),
        (SOURCE_RENDER_WIDTH, SOURCE_RENDER_HEIGHT)
    );
    (artifact.content_hash, image)
}

fn assert_prepared_source(db: &VfsDatabase, source: &PrepareSourceFixture, messages: &[Value]) {
    let message = phase_result(messages, source.phase);
    assert_eq!(
        message["payload"]["ok"].as_bool(),
        Some(true),
        "native prepare/page scenario failed: {message:?}"
    );
    let result = &message["payload"]["result"];
    let prepared: InkManifest =
        serde_json::from_value(result["prepared"].clone()).expect("typed native prepare result");
    let opened: InkManifest =
        serde_json::from_value(result["opened"].clone()).expect("typed reopened prepared manifest");
    let empty_page: InkPage =
        serde_json::from_value(result["empty_page"].clone()).expect("typed initial prepared page");
    let saved: InkManifest =
        serde_json::from_value(result["saved"].clone()).expect("typed native save result");
    let reopened: InkManifest = serde_json::from_value(result["reopened"].clone())
        .expect("typed saved manifest reopened through IPC");
    let page: InkPage = serde_json::from_value(result["page"].clone())
        .expect("typed saved page reopened through IPC");
    assert_eq!(prepared, opened);
    assert_eq!(prepared.schema_version, INK_SCHEMA_VERSION);
    assert_eq!(prepared.pages.len(), 1);
    assert_ne!(prepared.document_id, source.file_id);
    assert_ne!(prepared.document_id, source.resource_id);
    let expected_prefix = if source.phase == PDF_PREPARE_PHASE {
        "ink-pdf-pages-v1-"
    } else {
        "ink-image-pages-v1-"
    };
    match &prepared.source {
        InkSource::Resource {
            resource_id,
            source_hash,
            conversion_revision,
        } => {
            assert_eq!(resource_id, &source.resource_id);
            assert_eq!(source_hash, &source.source_hash);
            assert!(conversion_revision.starts_with(expected_prefix));
        }
        other => panic!("prepared manifest lost source identity: {other:?}"),
    }
    let initial_ref = &prepared.pages[0];
    let background_hash = match &initial_ref.background {
        InkBackground::PdfPage {
            blob_hash,
            source_page_index,
        } => {
            assert_eq!(source.phase, PDF_PREPARE_PHASE);
            assert_eq!(*source_page_index, 0);
            assert_eq!((initial_ref.width, initial_ref.height), (2048.0, 1536.0));
            blob_hash
        }
        InkBackground::Image { blob_hash } => {
            assert_eq!(source.phase, IMAGE_PREPARE_PHASE);
            assert_eq!((initial_ref.width, initial_ref.height), (160.0, 120.0));
            blob_hash
        }
        other => panic!("prepared source must own a converted PNG background: {other:?}"),
    };
    assert_eq!(empty_page.page_id, initial_ref.page_id);
    assert_eq!(empty_page.schema_version, INK_SCHEMA_VERSION);
    assert!(empty_page.objects.is_empty());
    assert_eq!(saved.document_id, prepared.document_id);
    assert_ne!(
        saved.revision, prepared.revision,
        "real page save must advance CAS revision"
    );
    assert_eq!(saved, reopened);
    assert_eq!(saved.pages.len(), 1);
    assert_eq!(saved.source, prepared.source);
    let saved_ref = &saved.pages[0];
    assert_eq!(saved_ref.page_id, initial_ref.page_id);
    assert_eq!(
        (saved_ref.width, saved_ref.height),
        (initial_ref.width, initial_ref.height)
    );
    assert_eq!(saved_ref.background, initial_ref.background);
    assert_ne!(saved_ref.page_blob_hash, initial_ref.page_blob_hash);
    assert_eq!(page.page_id, saved_ref.page_id);
    assert_eq!(page.schema_version, INK_SCHEMA_VERSION);
    assert_eq!(
        page.objects,
        vec![prepared_stroke(source.phase, initial_ref)]
    );
    for key in ["reused", "after_render"] {
        let manifest: InkManifest = serde_json::from_value(result[key].clone())
            .expect("typed reused/post-render canonical manifest");
        assert_eq!(
            manifest, saved,
            "{key} must preserve the saved page revision and background"
        );
    }
    assert_eq!(result["after_page"], result["page"]);

    {
        let conn = db.get_conn_safe().expect("prepared page repository reopen");
        let manifest =
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &saved.document_id)
                .expect("reopen canonical manifest from migrated VFS");
        let stored_page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &saved.document_id,
            &saved_ref.page_id,
        )
        .expect("reopen canonical saved page from migrated VFS");
        assert_eq!(manifest, saved);
        assert_eq!(stored_page, page);
        let page_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &saved_ref.page_blob_hash)
                .unwrap()
                .expect("saved page body blob");
        let page_bytes = std::fs::read(page_path).expect("read saved page body bytes");
        assert_eq!(
            VfsBlobRepo::compute_hash(&page_bytes),
            saved_ref.page_blob_hash
        );
        assert_eq!(
            serde_json::from_slice::<InkPage>(&page_bytes).unwrap(),
            page
        );
        let blob = VfsBlobRepo::get_blob_with_conn(&conn, background_hash)
            .unwrap()
            .expect("converted background blob");
        assert!(
            blob.ref_count > 0,
            "canonical manifest must own the converted PNG"
        );
        assert_eq!(blob.mime_type.as_deref(), Some("image/png"));
        let path = VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), background_hash)
            .unwrap()
            .expect("converted background path");
        let bytes = std::fs::read(path).expect("read converted PNG bytes");
        assert_eq!(bytes.len() as i64, blob.size);
        assert_eq!(VfsBlobRepo::compute_hash(&bytes), *background_hash);
        let background = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .expect("decode PNG actually converted by job bridge")
            .to_rgba8();
        assert_eq!(
            background.dimensions(),
            (initial_ref.width as u32, initial_ref.height as u32)
        );
        assert_eq!(
            background
                .get_pixel(background.width() * 11 / 16, background.height() * 7 / 24)
                .0,
            [0, 0, 255, 255]
        );
        assert_eq!(
            background
                .get_pixel(background.width() * 3 / 8, background.height() * 3 / 4)
                .0,
            [255, 255, 255, 255]
        );
    }

    let (before_hash, before) =
        load_prepared_artifact(db, &result["before_artifact"], &prepared, source);
    let (after_hash, after) = load_prepared_artifact(db, &result["artifact"], &saved, source);
    assert_ne!(
        before_hash, after_hash,
        "render bytes must change when the real stroke is saved"
    );
    assert_ne!(
        result["before_artifact"]["render_id"],
        result["artifact"]["render_id"]
    );
    for image in [&before, &after] {
        assert_eq!(
            image.get_pixel(10, 10).0,
            [255, 255, 255, 255],
            "white source paper"
        );
        assert_eq!(
            image.get_pixel(110, 35).0,
            [0, 0, 255, 255],
            "source marker survives conversion/render"
        );
        assert_eq!(
            image.get_pixel(60, 100).0,
            [255, 255, 255, 255],
            "outside the saved stroke"
        );
    }
    assert_eq!(
        before.get_pixel(60, 90).0,
        [255, 255, 255, 255],
        "background-only control"
    );
    assert_eq!(
        after.get_pixel(60, 90).0,
        [0, 0, 0, 255],
        "real saved stroke over the frozen background"
    );
    assert_eq!(artifact_count_for_document(db, &saved.document_id), 2);

    let jobs = messages
        .iter()
        .filter(|message| {
            message["kind"] == "job"
                && message["payload"]["source_resource_id"].as_str()
                    == Some(source.resource_id.as_str())
        })
        .collect::<Vec<_>>();
    assert_eq!(
        jobs.len(),
        1,
        "first prepare must dispatch exactly one real job; reuse must dispatch none"
    );
    assert_eq!(jobs[0]["payload"]["kind"], "prepare");
    assert_eq!(
        jobs[0]["payload"]["operation_id"],
        format!("{}-prepare", source.phase)
    );
    assert_eq!(
        jobs[0]["payload"]["source_hash"].as_str(),
        Some(source.source_hash.as_str())
    );

    let unchanged = source_snapshot(db, &source.resource_id, &source.file_id);
    assert_eq!(
        unchanged, source.snapshot,
        "source bytes, text hash, type, linkage, and file row must remain unchanged"
    );
    assert_eq!(
        STANDARD
            .decode(unchanged["resource"]["data"].as_str().unwrap())
            .unwrap(),
        source.bytes
    );
    let mut metadata = source_metadata(db, &source.resource_id);
    assert_eq!(
        metadata["default_ink_document_id"].as_str(),
        Some(saved.document_id.as_str())
    );
    let converter_version = metadata["ink_prepare_info"]["converter_version"]
        .as_str()
        .expect("production prepare converter metadata");
    assert_eq!(
        converter_version,
        jobs[0]["payload"]["expected_converter_version"]
            .as_str()
            .unwrap()
    );
    assert_eq!(metadata["ink_prepare_info"]["warnings"], json!([]));
    let fields = metadata.as_object_mut().expect("source metadata object");
    fields.remove("default_ink_document_id");
    fields.remove("ink_prepare_info");
    assert_eq!(
        metadata, source.metadata,
        "preparation may only add its own pointer/converter metadata"
    );
}

fn main() {
    let isolated = tempfile::tempdir().expect("create isolated XDG root");
    let home = isolated.path().join("home");
    let data = isolated.path().join("data");
    let config = isolated.path().join("config");
    let cache = isolated.path().join("cache");
    for directory in [&home, &data, &config, &cache] {
        std::fs::create_dir_all(directory).expect("create isolated XDG directory");
    }
    std::env::set_var("HOME", &home);
    std::env::set_var("XDG_DATA_HOME", &data);
    std::env::set_var("XDG_CONFIG_HOME", &config);
    std::env::set_var("XDG_CACHE_HOME", &cache);

    let (db_dir, db) = setup_migrated_test_db();
    let db = Arc::new(db);
    let sources = [
        upload_prepare_source(
            &db,
            PDF_PREPARE_PHASE,
            "inline-native-source.pdf",
            "application/pdf",
            inline_pdf(),
        ),
        upload_prepare_source(
            &db,
            IMAGE_PREPARE_PHASE,
            "inline-native-source.png",
            "image/png",
            inline_source_png(),
        ),
    ];
    let (document_id, revision) = save_board_fixture(&db);
    let page_id = board_page_id(&db, &document_id, &revision);
    let positive = render_spec(&document_id, &revision, &page_id, board_crop(), 200);
    let positive_scaled = render_spec(&document_id, &revision, &page_id, board_crop(), 400);
    let invalid = render_spec(
        &document_id,
        &revision,
        &page_id,
        InkRect {
            x: -10_000_001.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        },
        200,
    );
    let stale = render_spec(
        &document_id,
        "e2e-revision-before-save",
        &page_id,
        board_crop(),
        200,
    );

    let render_script = render_script(&positive, &positive_scaled, &invalid, &stale, &sources);
    let (sender, receiver) = std::sync::mpsc::channel::<Value>();

    // tauri-codegen reads the default tauri.conf.json next to the crate and only
    // overlays TAURI_CONFIG; the file name passed to the macro is not read as a
    // replacement config. Fail loudly here instead of letting the main dev config
    // (devUrl 1422 / empty assets) drive the test into a silent no-message timeout.
    let context = tauri::generate_context!("tauri.ink-e2e.conf.json");
    assert_eq!(
        context.config().identifier, "com.deepstudent.app.ink-e2e",
        "ink E2E context is not the e2e config: build with TAURI_CONFIG=$(cat src-tauri/tauri.ink-e2e.conf.json) exported at compile time"
    );
    assert!(
        context.config().build.dev_url.is_none(),
        "ink E2E context kept the main devUrl; the TAURI_CONFIG overlay must set build.devUrl=null"
    );
    match context.config().build.frontend_dist.as_ref() {
        Some(tauri::utils::config::FrontendDist::Directory(path)) => assert!(
            path.ends_with("target/ink-e2e-client"),
            "ink E2E frontendDist must be target/ink-e2e-client, got {path:?}"
        ),
        other => panic!(
            "ink E2E frontendDist must be the target/ink-e2e-client directory, got {other:?}; run with TAURI_CONFIG=$(cat src-tauri/tauri.ink-e2e.conf.json)"
        ),
    }
    assert!(
        context
            .assets()
            .get(&tauri::utils::assets::AssetKey::from("index.html"))
            .is_some(),
        "ink E2E context embeds no index.html; run with TAURI_CONFIG=$(cat src-tauri/tauri.ink-e2e.conf.json) and npm run build:ink-e2e"
    );

    let app = tauri::Builder::default()
        .manage(db.clone())
        .manage(PendingRenderBus::default())
        .manage(PendingFlushBus::default())
        .manage(PendingInkJobBus::default())
        .invoke_handler(tauri::generate_handler![
            deep_student_lib::ink_jobs::vfs_ink_prepare,
            deep_student_lib::ink_jobs::vfs_ink_job_result,
            deep_student_lib::vfs::ink_commands::vfs_ink_get,
            deep_student_lib::vfs::ink_commands::vfs_ink_get_page,
            deep_student_lib::vfs::ink_commands::vfs_ink_save_page,
            deep_student_lib::vfs::handlers::vfs_get_blob_base64,
            deep_student_lib::ink_bridge::vfs_ink_render,
            deep_student_lib::ink_bridge::vfs_ink_render_result,
            deep_student_lib::ink_bridge::vfs_ink_flush_result,
            deep_student_lib::staged_upload::staged_upload_begin,
            deep_student_lib::staged_upload::staged_upload_append,
            deep_student_lib::staged_upload::staged_upload_abort,
        ])
        .build(context)
        .expect("build real Wry ink E2E app");

    let ready_sender = sender.clone();
    app.listen(EVENT_READY, move |event| {
        let _ = ready_sender.send(event_message("ready", event.payload()));
    });
    let result_sender = sender.clone();
    app.listen(EVENT_RESULT, move |event| {
        let _ = result_sender.send(event_message("result", event.payload()));
    });
    let done_sender = sender.clone();
    app.listen(EVENT_DONE, move |event| {
        let _ = done_sender.send(event_message("done", event.payload()));
    });
    let boot_sender = sender.clone();
    app.listen("ink-e2e-boot-error", move |event| {
        let _ = boot_sender.send(event_message("boot-error", event.payload()));
    });
    let job_sender = sender.clone();
    app.listen("ink:job-request", move |event| {
        let request: Value =
            serde_json::from_str(event.payload()).expect("real Ink job event JSON");
        let _ = job_sender.send(json!({
            "kind": "job",
            "payload": {
                "request_id": request["request_id"],
                "operation_id": request["operation_id"],
                "kind": request["kind"],
                "source_resource_id": request["payload"]["source_resource_id"],
                "source_hash": request["payload"]["source_hash"],
                "expected_converter_version": request["payload"]["expected_converter_version"],
            },
        }));
    });

    let app_handle = app.handle().clone();
    let watchdog = app_handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(180));
        watchdog.exit(2);
    });

    let scenario = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(150);
        let mut messages = Vec::new();
        let mut injected = false;
        while Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(message) => {
                    let kind = message["kind"].as_str().unwrap_or_default().to_owned();
                    let done = kind == "done";
                    messages.push(message);
                    if kind == "ready" && !injected {
                        injected = true;
                        let window = app_handle
                            .get_webview_window(TEST_APP_LABEL)
                            .expect("configured main webview");
                        let eval_window = window.clone();
                        let script = render_script.clone();
                        window
                            .run_on_main_thread(move || {
                                if let Err(error) = eval_window.eval(script) {
                                    eprintln!(
                                        "[ink-e2e] failed to inject real prepare/page/render requests: {error}"
                                    );
                                }
                            })
                            .expect("schedule real prepare/page/render request injection");
                    }
                    if done || kind == "boot-error" {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        app_handle.exit(0);
        messages
    });

    let exit_code = app.run_return(|_, _| {});
    assert_eq!(
        exit_code, 0,
        "native E2E event loop exited non-zero (watchdog fired or scenario aborted)"
    );
    let messages = scenario.join().expect("native E2E scenario thread");

    let ready = messages.iter().any(|message| message["kind"] == "ready");
    let boot_error = messages
        .iter()
        .find(|message| message["kind"] == "boot-error")
        .cloned();
    assert!(
        ready,
        "real frontend renderBridge never registered: {messages:?}"
    );
    assert!(
        boot_error.is_none(),
        "real frontend bridge boot failed: {boot_error:?}"
    );
    let ready_payload = &messages
        .iter()
        .find(|message| message["kind"] == "ready")
        .unwrap()["payload"];
    assert_eq!(
        ready_payload["prepare"], "production-registerInkJobBridge",
        "rebuild the E2E client with the production job bridge"
    );
    assert_eq!(ready_payload["pdfjsVersion"], "5.4.296");
    assert!(
        messages.iter().any(|message| message["kind"] == "done"),
        "native prepare/page/render scenario did not finish: {messages:?}"
    );

    let positive = phase_result(&messages, POSITIVE_PHASE);
    assert_eq!(
        positive["payload"]["ok"].as_bool(),
        Some(true),
        "real native render failed: {positive:?}"
    );
    let artifact = &positive["payload"]["result"];
    let render_id = artifact["render_id"]
        .as_str()
        .expect("positive render returns render_id");
    assert_eq!(artifact["document_id"].as_str(), Some(document_id.as_str()));
    assert_eq!(artifact["revision"].as_str(), Some(revision.as_str()));
    assert_eq!(artifact["width_px"].as_u64(), Some(200));
    assert_eq!(artifact["height_px"].as_u64(), Some(160));
    assert_artifact(&db, &document_id, &revision, &page_id, render_id, 1);
    assert_source_unchanged(&db, &document_id, &revision);
    assert_eq!(
        artifact_count_for_document(&db, &document_id),
        2,
        "all phases have finished by the time the scenario joins on done, so both the 200 and 400 artifacts exist"
    );

    let positive_scaled = phase_result(&messages, POSITIVE_SCALED_PHASE);
    assert_eq!(
        positive_scaled["payload"]["ok"].as_bool(),
        Some(true),
        "real native scaled render failed: {positive_scaled:?}"
    );
    let scaled_artifact = &positive_scaled["payload"]["result"];
    let scaled_render_id = scaled_artifact["render_id"]
        .as_str()
        .expect("scaled render returns render_id");
    assert_ne!(
        scaled_render_id, render_id,
        "the same crop at a different long edge must not reuse the render id"
    );
    assert_eq!(
        scaled_artifact["document_id"].as_str(),
        Some(document_id.as_str())
    );
    assert_eq!(
        scaled_artifact["revision"].as_str(),
        Some(revision.as_str())
    );
    assert_eq!(scaled_artifact["width_px"].as_u64(), Some(400));
    assert_eq!(scaled_artifact["height_px"].as_u64(), Some(320));
    assert_artifact(&db, &document_id, &revision, &page_id, scaled_render_id, 2);
    assert_source_unchanged(&db, &document_id, &revision);
    assert_eq!(
        artifact_count_for_document(&db, &document_id),
        2,
        "the same crop at another long edge must publish a second artifact"
    );

    let invalid = phase_result(&messages, INVALID_PHASE);
    assert_eq!(
        invalid["payload"]["ok"].as_bool(),
        Some(false),
        "{invalid:?}"
    );
    assert_eq!(
        error_code(&invalid["payload"]["error"]),
        "INVALID_ARGUMENT",
        "{invalid:?}"
    );

    let stale = phase_result(&messages, STALE_PHASE);
    assert_eq!(stale["payload"]["ok"].as_bool(), Some(false), "{stale:?}");
    assert_eq!(
        error_code(&stale["payload"]["error"]),
        "REVISION_CONFLICT",
        "{stale:?}"
    );

    assert_eq!(
        artifact_count_for_document(&db, &document_id),
        2,
        "invalid/stale crops must not publish another artifact"
    );
    assert_source_unchanged(&db, &document_id, &revision);
    for source in &sources {
        assert_prepared_source(&db, source, &messages);
    }

    drop(db_dir);
    println!(
        "ink_board_render_e2e: board render plus inline PDF/image upload -> real prepare/job conversion/staging -> page save/reopen -> checked background/ink artifacts PASSED"
    );
}

fn event_message(kind: &str, raw_payload: &str) -> Value {
    let payload = serde_json::from_str::<Value>(raw_payload)
        .unwrap_or_else(|_| Value::String(raw_payload.to_owned()));
    json!({ "kind": kind, "payload": payload })
}
