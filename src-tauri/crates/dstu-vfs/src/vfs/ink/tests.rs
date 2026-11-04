use super::*;

// `dstu-vfs` enables serde_json/arbitrary_precision. Internally tagged content
// is buffered before field decoding, so decimal floats use serde_json::Number's
// private-map representation there; the domain adapter restores ordinary f64 fields.

const MANIFEST_FIXTURE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../tests/fixtures/ink/ink-manifest-v1.json"
));
const PAGE_FIXTURE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../tests/fixtures/ink/page-v1.json"
));
const BOARD_V2_FIXTURE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../tests/fixtures/ink/valid-board-v2.json"
));

fn fixture_page_ref() -> InkPageRef {
    let manifest: InkManifest = serde_json::from_slice(MANIFEST_FIXTURE)
        .expect("hand-authored manifest fixture must deserialize");
    manifest.pages[0].clone()
}

#[test]
fn ink_parse_manifest_fixture_succeeds() {
    let manifest = parse_manifest(MANIFEST_FIXTURE).expect("valid manifest fixture must parse");

    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.document_id, "doc-ink-demo-0001");
    assert_eq!(manifest.revision, "r-000007");
    assert_eq!(manifest.title, "手写批注示例");
    assert_eq!(manifest.pages.len(), 1);

    match &manifest.source {
        InkSource::Resource {
            resource_id,
            source_hash,
            conversion_revision,
        } => {
            assert_eq!(resource_id, "res-pdf-src-0042");
            assert_eq!(
                source_hash,
                "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"
            );
            assert_eq!(conversion_revision, "conv-1");
        }
        InkSource::Blank {} => panic!("fixture source must be resource-backed"),
    }

    let page_ref = &manifest.pages[0];
    assert_eq!(page_ref.page_id, "page-0001");
    assert_eq!(page_ref.width, 800.0);
    assert_eq!(page_ref.height, 1000.0);
    assert_eq!(
        page_ref.page_blob_hash,
        "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809"
    );
    assert!(matches!(
        &page_ref.background,
        InkBackground::Blank {
            ruling: InkRuling::Lined
        }
    ));

    let receipt = manifest
        .last_operation
        .as_ref()
        .expect("fixture has a receipt");
    assert_eq!(receipt.operation_id, "op-000007");
    assert_eq!(
        receipt.input_hash,
        "deadbeefcafebabe0123456789abcdefdeadbeefcafebabe0123456789abcdef"
    );
    assert_eq!(receipt.previous_revision.as_deref(), Some("r-000006"));
    assert_eq!(receipt.result_revision, "r-000007");
}

#[test]
fn ink_parse_page_fixture_succeeds() {
    let page_ref = fixture_page_ref();
    let directly_deserialized: InkPage =
        serde_json::from_slice(PAGE_FIXTURE).expect("valid page fixture must deserialize directly");
    let page = parse_page(PAGE_FIXTURE, &page_ref).expect("valid page fixture must parse");
    assert_eq!(page, directly_deserialized);

    assert_eq!(page.schema_version, 1);
    assert_eq!(page.page_id, "page-0001");
    assert_eq!(page.objects.len(), 7);

    match &page.objects[0].content {
        InkObjectContent::Stroke { samples, style } => {
            assert_eq!(page.objects[0].id, "obj-0001");
            assert_eq!(page.objects[0].author, InkAuthor::User);
            assert_eq!(page.objects[0].created_at, 0);
            assert_eq!(samples.len(), 2);
            assert_eq!(samples[0].x, 12.5);
            assert_eq!(samples[0].y, 20.0);
            assert_eq!(samples[0].pressure, 0.4);
            assert_eq!(samples[0].elapsed_ms, Some(0.0));
            assert_eq!(samples[1].elapsed_ms, Some(16.0));
            assert_eq!(style.tool, InkTool::Pen);
            assert_eq!(style.color, "#1f2937");
            assert_eq!(style.width, 2.0);
            assert!(style.pressure_enabled);
        }
        _ => panic!("first fixture object must be a stroke"),
    }

    match &page.objects[1].content {
        InkObjectContent::Stroke { samples, style } => {
            assert_eq!(page.objects[1].author, InkAuthor::Ai);
            assert_eq!(samples.len(), 1);
            assert_eq!(samples[0].pressure, 0.65);
            assert_eq!(samples[0].elapsed_ms, None);
            assert_eq!(style.tool, InkTool::Highlighter);
            assert!(!style.pressure_enabled);
        }
        _ => panic!("second fixture object must be a stroke"),
    }

    match &page.objects[2].content {
        InkObjectContent::Text {
            rect,
            text,
            font_size,
            color,
        } => {
            assert_eq!(rect.x, 60.0);
            assert_eq!(rect.y, 40.0);
            assert_eq!(rect.width, 300.0);
            assert_eq!(rect.height, 48.0);
            assert_eq!(text, "<b>plain text, not markup</b> 手写字");
            assert_eq!(*font_size, 18.0);
            assert_eq!(color, "#1f2937");
        }
        _ => panic!("third fixture object must be text"),
    }

    assert!(matches!(
        &page.objects[3].content,
        InkObjectContent::Rect { .. }
    ));
    assert!(matches!(
        &page.objects[4].content,
        InkObjectContent::Ellipse { .. }
    ));
    assert!(matches!(
        &page.objects[5].content,
        InkObjectContent::RegionHighlight { .. }
    ));
    match &page.objects[6].content {
        InkObjectContent::Arrow {
            from,
            to,
            color,
            width,
        } => {
            assert_eq!(from.x, 50.0);
            assert_eq!(from.y, 800.0);
            assert_eq!(to.x, 150.0);
            assert_eq!(to.y, 880.5);
            assert_eq!(color, "#ef4444");
            assert_eq!(*width, 3.0);
        }
        _ => panic!("last fixture object must be an arrow"),
    }
}

#[test]
fn ink_manifest_fixture_round_trip_preserves_wire_contract() {
    let manifest = parse_manifest(MANIFEST_FIXTURE).expect("valid manifest fixture must parse");
    let serialized = serde_json::to_vec(&manifest).expect("manifest serialization must succeed");
    let wire: serde_json::Value =
        serde_json::from_slice(&serialized).expect("serialized JSON is valid");

    assert_eq!(wire["document_id"].as_str(), Some("doc-ink-demo-0001"));
    assert_eq!(wire["schema_version"].as_u64(), Some(1));
    assert_eq!(wire["source"]["kind"].as_str(), Some("resource"));
    assert_eq!(
        wire["pages"][0]["background"]["kind"].as_str(),
        Some("blank")
    );
    assert_eq!(
        wire["last_operation"]["result_revision"].as_str(),
        Some("r-000007")
    );
    assert!(wire.get("documentId").is_none());

    let reparsed = parse_manifest(&serialized).expect("round-tripped manifest must parse");
    assert_eq!(reparsed, manifest);
}

#[test]
fn ink_page_fixture_round_trip_preserves_wire_contract() {
    let page_ref = fixture_page_ref();
    let page = parse_page(PAGE_FIXTURE, &page_ref).expect("valid page fixture must parse");
    let serialized = serde_json::to_vec(&page).expect("page serialization must succeed");
    let wire: serde_json::Value =
        serde_json::from_slice(&serialized).expect("serialized JSON is valid");

    assert_eq!(wire["page_id"].as_str(), Some("page-0001"));
    assert_eq!(
        wire["objects"][0]["content"]["kind"].as_str(),
        Some("stroke")
    );
    assert_eq!(wire["objects"][2]["content"]["kind"].as_str(), Some("text"));
    assert!(wire["objects"][1]["content"]["samples"][0]
        .get("elapsed_ms")
        .is_none());

    let reparsed = parse_page(&serialized, &page_ref).expect("round-tripped page must parse");
    assert_eq!(reparsed, page);
}

fn manifest_fixture_value() -> serde_json::Value {
    serde_json::from_slice(MANIFEST_FIXTURE).expect("manifest fixture JSON is valid")
}

fn page_fixture_value() -> serde_json::Value {
    serde_json::from_slice(PAGE_FIXTURE).expect("page fixture JSON is valid")
}

fn board_v2_fixture_value() -> serde_json::Value {
    serde_json::from_slice(BOARD_V2_FIXTURE).expect("board v2 fixture JSON is valid")
}

fn set_json(value: &mut serde_json::Value, pointer: &str, replacement: serde_json::Value) {
    *value.pointer_mut(pointer).expect("mutation pointer exists") = replacement;
}

fn has_error_code<T>(result: Result<T, InkError>, expected: InkErrorCode) -> bool {
    match result {
        Err(error) => {
            assert_eq!(error.code, expected);
            true
        }
        Ok(_) => false,
    }
}

fn add_unknown_field(mut value: serde_json::Value, pointer: &str) -> serde_json::Value {
    value
        .pointer_mut(pointer)
        .expect("unknown-field target exists")
        .as_object_mut()
        .expect("unknown-field target is an object")
        .insert("unexpected_field".to_owned(), serde_json::json!(true));
    value
}

fn invalid_page_with_samples(count: usize) -> serde_json::Value {
    let mut page = page_fixture_value();
    let samples = (0..count)
        .map(|_| serde_json::json!({"x": 12.0, "y": 20.0, "pressure": 0.5}))
        .collect();
    set_json(
        &mut page,
        "/objects/0/content/samples",
        serde_json::Value::Array(samples),
    );
    page
}

fn invalid_page_with_objects(count: usize) -> serde_json::Value {
    let mut page = page_fixture_value();
    let rect = serde_json::json!({
        "author": "user",
        "created_at": 0,
        "content": {
            "kind": "rect",
            "rect": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
            "color": "#000000",
            "width": 1.0
        }
    });
    let objects = (0..count)
        .map(|index| {
            let mut object = rect.clone();
            object["id"] = serde_json::json!(format!("object-{index}"));
            object
        })
        .collect();
    set_json(&mut page, "/objects", serde_json::Value::Array(objects));
    page
}

#[test]
fn ink_manifest_constraints_reject_invalid_cases() {
    let replacements = [
        (
            "unsupported_schema",
            "/schema_version",
            serde_json::json!(3),
        ),
        ("zero_pages", "/pages", serde_json::json!([])),
        (
            "dimension_below_min",
            "/pages/0/width",
            serde_json::json!(0.0),
        ),
        (
            "dimension_above_max",
            "/pages/0/height",
            serde_json::json!(16385.0),
        ),
        ("empty_document_id", "/document_id", serde_json::json!("")),
        (
            "whitespace_document_id",
            "/document_id",
            serde_json::json!(" \t "),
        ),
        (
            "unicode_document_id_char_limit",
            "/document_id",
            serde_json::json!("文".repeat(129)),
        ),
        (
            "slash_document_id",
            "/document_id",
            serde_json::json!("doc/one"),
        ),
        (
            "backslash_document_id",
            "/document_id",
            serde_json::json!("doc\\one"),
        ),
        (
            "control_document_id",
            "/document_id",
            serde_json::json!("doc\n1"),
        ),
        (
            "long_document_id",
            "/document_id",
            serde_json::json!("d".repeat(129)),
        ),
        ("empty_revision", "/revision", serde_json::json!("")),
        (
            "long_revision",
            "/revision",
            serde_json::json!("r".repeat(129)),
        ),
        ("empty_title", "/title", serde_json::json!("")),
        ("long_title", "/title", serde_json::json!("文".repeat(257))),
        (
            "empty_resource_id",
            "/source/resource_id",
            serde_json::json!(""),
        ),
        (
            "invalid_source_hash",
            "/source/source_hash",
            serde_json::json!("ABCDEF"),
        ),
        (
            "uppercase_source_hash",
            "/source/source_hash",
            serde_json::json!("A".repeat(64)),
        ),
        (
            "invalid_resource_id",
            "/source/resource_id",
            serde_json::json!("resource/one"),
        ),
        (
            "empty_conversion_revision",
            "/source/conversion_revision",
            serde_json::json!(""),
        ),
        (
            "invalid_page_hash",
            "/pages/0/page_blob_hash",
            serde_json::json!("G".repeat(64)),
        ),
        (
            "invalid_background_hash",
            "/pages/0/background",
            serde_json::json!({"kind":"image","blob_hash":"bad"}),
        ),
        (
            "invalid_receipt_hash",
            "/last_operation/input_hash",
            serde_json::json!("xyz"),
        ),
        (
            "invalid_operation_id",
            "/last_operation/operation_id",
            serde_json::json!("op/1"),
        ),
        (
            "empty_previous_revision",
            "/last_operation/previous_revision",
            serde_json::json!("  "),
        ),
        (
            "receipt_revision_mismatch",
            "/last_operation/result_revision",
            serde_json::json!("r-other"),
        ),
    ];
    let mut failures = Vec::new();
    for (name, pointer, replacement) in replacements {
        let mut value = manifest_fixture_value();
        set_json(&mut value, pointer, replacement);
        let bytes = serde_json::to_vec(&value).expect("mutated JSON serializes");
        match parse_manifest(&bytes) {
            Ok(_) => failures.push(name),
            Err(error) if name == "unsupported_schema" => {
                assert_eq!(error.code, InkErrorCode::UnsupportedSchema, "{name}");
            }
            Err(error) if name.starts_with("long_") || name == "unicode_document_id_char_limit" => {
                assert_eq!(error.code, InkErrorCode::LimitExceeded, "{name}");
            }
            Err(error) => assert_eq!(error.code, InkErrorCode::InvalidArgument, "{name}"),
        }
    }

    let base = manifest_fixture_value();
    let page_ref = base["pages"][0].clone();
    let mut duplicate_pages = base.clone();
    set_json(
        &mut duplicate_pages,
        "/pages",
        serde_json::json!([page_ref.clone(), page_ref]),
    );
    if !has_error_code(
        parse_manifest(&serde_json::to_vec(&duplicate_pages).expect("JSON serializes")),
        InkErrorCode::InvalidArgument,
    ) {
        failures.push("duplicate_page_ids");
    }

    let mut too_many_pages = base.clone();
    let pages = (0..=INK_PAGES_MAX)
        .map(|index| {
            let mut page = base["pages"][0].clone();
            page["page_id"] = serde_json::json!(format!("page-{index}"));
            page
        })
        .collect();
    set_json(
        &mut too_many_pages,
        "/pages",
        serde_json::Value::Array(pages),
    );
    if !has_error_code(
        parse_manifest(&serde_json::to_vec(&too_many_pages).expect("JSON serializes")),
        InkErrorCode::LimitExceeded,
    ) {
        failures.push("too_many_pages");
    }

    let mut nonfinite = serde_json::from_slice::<InkManifest>(MANIFEST_FIXTURE)
        .expect("fixture deserializes before direct domain mutation");
    nonfinite.pages[0].width = f64::NAN;
    if !has_error_code(validate_manifest(&nonfinite), InkErrorCode::InvalidArgument) {
        failures.push("nonfinite_dimension_nan");
    }
    nonfinite.pages[0].width = f64::INFINITY;
    if !has_error_code(validate_manifest(&nonfinite), InkErrorCode::InvalidArgument) {
        failures.push("nonfinite_dimension_infinity");
    }

    assert!(
        failures.is_empty(),
        "manifest cases accepted unexpectedly: {failures:?}"
    );
}

#[test]
fn ink_page_constraints_reject_invalid_cases() {
    let replacements = [
        (
            "unsupported_schema",
            "/schema_version",
            serde_json::json!(2),
        ),
        (
            "page_identity_mismatch",
            "/page_id",
            serde_json::json!("another-page"),
        ),
        ("empty_object_id", "/objects/0/id", serde_json::json!("")),
        (
            "whitespace_object_id",
            "/objects/0/id",
            serde_json::json!(" \t "),
        ),
        (
            "slash_object_id",
            "/objects/0/id",
            serde_json::json!("obj/1"),
        ),
        (
            "long_object_id",
            "/objects/0/id",
            serde_json::json!("o".repeat(129)),
        ),
        (
            "negative_created_at",
            "/objects/0/created_at",
            serde_json::json!(-1),
        ),
        (
            "empty_stroke",
            "/objects/0/content/samples",
            serde_json::json!([]),
        ),
        (
            "sample_x_below_page",
            "/objects/0/content/samples/0/x",
            serde_json::json!(-0.1),
        ),
        (
            "sample_x_above_page",
            "/objects/0/content/samples/0/x",
            serde_json::json!(800.1),
        ),
        (
            "sample_y_above_page",
            "/objects/0/content/samples/0/y",
            serde_json::json!(1000.1),
        ),
        (
            "pressure_below_range",
            "/objects/0/content/samples/0/pressure",
            serde_json::json!(-0.1),
        ),
        (
            "pressure_above_range",
            "/objects/0/content/samples/0/pressure",
            serde_json::json!(1.01),
        ),
        (
            "negative_elapsed",
            "/objects/0/content/samples/0/elapsed_ms",
            serde_json::json!(-1.0),
        ),
        (
            "elapsed_order_decreases",
            "/objects/0/content/samples/0/elapsed_ms",
            serde_json::json!(17.0),
        ),
        (
            "stroke_width_zero",
            "/objects/0/content/style/width",
            serde_json::json!(0.0),
        ),
        (
            "stroke_width_above_max",
            "/objects/0/content/style/width",
            serde_json::json!(257.0),
        ),
        (
            "stroke_color_invalid",
            "/objects/0/content/style/color",
            serde_json::json!("red"),
        ),
        (
            "text_font_below_min",
            "/objects/2/content/font_size",
            serde_json::json!(0.0),
        ),
        (
            "text_font_above_max",
            "/objects/2/content/font_size",
            serde_json::json!(257.0),
        ),
        (
            "text_color_invalid",
            "/objects/2/content/color",
            serde_json::json!("#12345Z"),
        ),
        (
            "rect_zero_width",
            "/objects/3/content/rect/width",
            serde_json::json!(0.0),
        ),
        (
            "rect_outside_page",
            "/objects/3/content/rect/width",
            serde_json::json!(700.1),
        ),
        (
            "rect_style_width_invalid",
            "/objects/3/content/width",
            serde_json::json!(257.0),
        ),
        (
            "rect_color_invalid",
            "/objects/3/content/color",
            serde_json::json!("blue"),
        ),
        (
            "arrow_endpoint_outside_page",
            "/objects/6/content/to/x",
            serde_json::json!(800.1),
        ),
        (
            "arrow_width_zero",
            "/objects/6/content/width",
            serde_json::json!(0.0),
        ),
        (
            "arrow_color_invalid",
            "/objects/6/content/color",
            serde_json::json!("#12"),
        ),
        (
            "text_over_budget",
            "/objects/2/content/text",
            serde_json::json!("x".repeat(10_001)),
        ),
    ];
    let page_ref = fixture_page_ref();
    let mut failures = Vec::new();
    for (name, pointer, replacement) in replacements {
        let mut value = page_fixture_value();
        set_json(&mut value, pointer, replacement);
        let bytes = serde_json::to_vec(&value).expect("mutated JSON serializes");
        match parse_page(&bytes, &page_ref) {
            Ok(_) => failures.push(name),
            Err(error) if name == "unsupported_schema" => {
                assert_eq!(error.code, InkErrorCode::UnsupportedSchema, "{name}");
            }
            Err(error) if name == "long_object_id" || name == "text_over_budget" => {
                assert_eq!(error.code, InkErrorCode::LimitExceeded, "{name}");
            }
            Err(error) => assert_eq!(error.code, InkErrorCode::InvalidArgument, "{name}"),
        }
    }

    let mut duplicate_objects = page_fixture_value();
    set_json(
        &mut duplicate_objects,
        "/objects/1/id",
        serde_json::json!("obj-0001"),
    );
    if parse_page(
        &serde_json::to_vec(&duplicate_objects).expect("JSON serializes"),
        &page_ref,
    )
    .is_ok()
    {
        failures.push("duplicate_object_ids");
    }

    let too_many_objects = invalid_page_with_objects(INK_PAGE_OBJECTS_MAX + 1);
    if parse_page(
        &serde_json::to_vec(&too_many_objects).expect("JSON serializes"),
        &page_ref,
    )
    .is_ok()
    {
        failures.push("too_many_objects");
    }

    let too_many_samples = invalid_page_with_samples(INK_PAGE_SAMPLES_MAX + 1);
    if parse_page(
        &serde_json::to_vec(&too_many_samples).expect("JSON serializes"),
        &page_ref,
    )
    .is_ok()
    {
        failures.push("too_many_samples");
    }

    let mut empty_stroke_page = page_fixture_value();
    set_json(
        &mut empty_stroke_page,
        "/objects/0/content/samples",
        serde_json::json!([]),
    );
    if parse_page(
        &serde_json::to_vec(&empty_stroke_page).expect("JSON serializes"),
        &page_ref,
    )
    .is_ok()
    {
        failures.push("empty_stroke_minimum");
    }

    let page = serde_json::from_slice::<InkPage>(PAGE_FIXTURE)
        .expect("fixture deserializes before direct domain mutation");
    let nonfinite_cases = [
        ("sample_x_nan", "sample_x", f64::NAN),
        ("sample_y_infinity", "sample_y", f64::INFINITY),
        ("pressure_nan", "pressure", f64::NAN),
        ("elapsed_infinity", "elapsed", f64::INFINITY),
        ("stroke_width_nan", "stroke_width", f64::NAN),
        ("text_rect_x_nan", "text_rect_x", f64::NAN),
        ("text_font_infinity", "font_size", f64::INFINITY),
        ("arrow_endpoint_nan", "arrow_to_x", f64::NAN),
    ];
    for (name, field, number) in nonfinite_cases {
        let mut mutated = page.clone();
        match field {
            "sample_x" => match &mut mutated.objects[0].content {
                InkObjectContent::Stroke { samples, .. } => samples[0].x = number,
                _ => unreachable!(),
            },
            "sample_y" => match &mut mutated.objects[0].content {
                InkObjectContent::Stroke { samples, .. } => samples[0].y = number,
                _ => unreachable!(),
            },
            "pressure" => match &mut mutated.objects[0].content {
                InkObjectContent::Stroke { samples, .. } => samples[0].pressure = number,
                _ => unreachable!(),
            },
            "elapsed" => match &mut mutated.objects[0].content {
                InkObjectContent::Stroke { samples, .. } => samples[0].elapsed_ms = Some(number),
                _ => unreachable!(),
            },
            "stroke_width" => match &mut mutated.objects[0].content {
                InkObjectContent::Stroke { style, .. } => style.width = number,
                _ => unreachable!(),
            },
            "text_rect_x" => match &mut mutated.objects[2].content {
                InkObjectContent::Text { rect, .. } => rect.x = number,
                _ => unreachable!(),
            },
            "font_size" => match &mut mutated.objects[2].content {
                InkObjectContent::Text { font_size, .. } => *font_size = number,
                _ => unreachable!(),
            },
            "arrow_to_x" => match &mut mutated.objects[6].content {
                InkObjectContent::Arrow { to, .. } => to.x = number,
                _ => unreachable!(),
            },
            _ => unreachable!(),
        }
        if !has_error_code(
            validate_page(&mutated, &page_ref),
            InkErrorCode::InvalidArgument,
        ) {
            failures.push(name);
        }
    }

    assert!(
        failures.is_empty(),
        "page cases accepted unexpectedly: {failures:?}"
    );
}

#[test]
fn ink_serde_rejects_unknown_fields_on_domain_structs_and_tagged_variants() {
    let mut manifest_cases = vec![
        (
            "manifest struct",
            add_unknown_field(manifest_fixture_value(), ""),
        ),
        (
            "page-ref struct",
            add_unknown_field(manifest_fixture_value(), "/pages/0"),
        ),
        (
            "receipt struct",
            add_unknown_field(manifest_fixture_value(), "/last_operation"),
        ),
        (
            "resource source variant",
            add_unknown_field(manifest_fixture_value(), "/source"),
        ),
    ];
    let mut blank_source = manifest_fixture_value();
    set_json(
        &mut blank_source,
        "/source",
        serde_json::json!({"kind":"blank","unexpected_field":true}),
    );
    manifest_cases.push(("blank source struct variant", blank_source));
    for (name, background) in [
        (
            "blank background variant",
            serde_json::json!({"kind":"blank","ruling":"blank"}),
        ),
        (
            "image background variant",
            serde_json::json!({"kind":"image","blob_hash":"1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809"}),
        ),
        (
            "pdf background variant",
            serde_json::json!({"kind":"pdf_page","blob_hash":"1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809","source_page_index":0}),
        ),
    ] {
        let mut value = manifest_fixture_value();
        set_json(&mut value, "/pages/0/background", background);
        manifest_cases.push((name, add_unknown_field(value, "/pages/0/background")));
    }

    let mut serde_rejections = Vec::new();
    for (name, value) in manifest_cases {
        let bytes = serde_json::to_vec(&value).expect("JSON serializes");
        if serde_json::from_slice::<InkManifest>(&bytes).is_ok() {
            serde_rejections.push(name);
        }
    }

    let mut page_cases = vec![
        ("page struct", add_unknown_field(page_fixture_value(), "")),
        (
            "object struct",
            add_unknown_field(page_fixture_value(), "/objects/0"),
        ),
        (
            "sample struct",
            add_unknown_field(page_fixture_value(), "/objects/0/content/samples/0"),
        ),
        (
            "stroke style struct",
            add_unknown_field(page_fixture_value(), "/objects/0/content/style"),
        ),
        (
            "rect struct",
            add_unknown_field(page_fixture_value(), "/objects/2/content/rect"),
        ),
        (
            "point struct",
            add_unknown_field(page_fixture_value(), "/objects/6/content/from"),
        ),
    ];
    for (name, index) in [
        ("stroke content variant", 0),
        ("text content variant", 2),
        ("rect content variant", 3),
        ("ellipse content variant", 4),
        ("region-highlight content variant", 5),
        ("arrow content variant", 6),
    ] {
        let value = page_fixture_value();
        let pointer = format!("/objects/{index}/content");
        page_cases.push((name, add_unknown_field(value, &pointer)));
    }
    for (name, value) in page_cases {
        let bytes = serde_json::to_vec(&value).expect("JSON serializes");
        if serde_json::from_slice::<InkPage>(&bytes).is_ok() {
            serde_rejections.push(name);
        }
    }

    assert!(
        serde_rejections.is_empty(),
        "serde accepted unknown fields in these characterized cases: {serde_rejections:?}"
    );
}

#[test]
fn ink_parser_rejects_malformed_trailing_and_forged_number_inputs() {
    let page_ref = fixture_page_ref();
    let mut rejected = Vec::new();
    match parse_page(b"{not-json", &page_ref) {
        Ok(_) => rejected.push("malformed_json"),
        Err(error) => assert_eq!(error.code, InkErrorCode::InvalidArgument),
    }

    let mut trailing = PAGE_FIXTURE.to_vec();
    trailing.extend_from_slice(b" null");
    if parse_page(&trailing, &page_ref).is_ok() {
        rejected.push("trailing_json_value");
    }

    let mut string_number = page_fixture_value();
    set_json(
        &mut string_number,
        "/objects/0/content/samples/0/x",
        serde_json::json!("12.5"),
    );
    match parse_page(
        &serde_json::to_vec(&string_number).expect("JSON serializes"),
        &page_ref,
    ) {
        Ok(_) => rejected.push("numeric_string"),
        Err(error) => assert_eq!(error.code, InkErrorCode::InvalidArgument),
    }

    let forged_number = serde_json::json!({"$serde_json::private::Number":"12.5"});
    let mut forged_tagged_float = page_fixture_value();
    set_json(
        &mut forged_tagged_float,
        "/objects/0/content/samples/0/x",
        forged_number.clone(),
    );
    match parse_page(
        &serde_json::to_vec(&forged_tagged_float).expect("JSON serializes"),
        &page_ref,
    ) {
        Ok(_) => rejected.push("forged_private_number_map_inside_tagged_content"),
        Err(error) => assert_eq!(error.code, InkErrorCode::InvalidArgument),
    }

    let mut forged_struct_float = manifest_fixture_value();
    set_json(&mut forged_struct_float, "/pages/0/width", forged_number);
    match parse_manifest(&serde_json::to_vec(&forged_struct_float).expect("JSON serializes")) {
        Ok(_) => rejected.push("forged_private_number_map_in_struct_field"),
        Err(error) => assert_eq!(error.code, InkErrorCode::InvalidArgument),
    }

    assert!(
        rejected.is_empty(),
        "parser accepted malformed inputs: {rejected:?}"
    );
}

#[test]
fn ink_parser_enforces_manifest_and_page_byte_limits() {
    let manifest_oversized = vec![b' '; INK_MANIFEST_MAX_BYTES + 1];
    let page_oversized = vec![b' '; INK_PAGE_MAX_BYTES + 1];
    let page_ref = fixture_page_ref();

    assert_eq!(
        parse_manifest(&manifest_oversized).unwrap_err().code,
        InkErrorCode::LimitExceeded
    );
    assert_eq!(
        parse_page(&page_oversized, &page_ref).unwrap_err().code,
        InkErrorCode::LimitExceeded
    );
}

#[test]
fn ink_manifest_and_page_accept_limit_boundaries() {
    let mut manifest = manifest_fixture_value();
    manifest["document_id"] = serde_json::json!("文".repeat(128));
    manifest["revision"] = serde_json::json!("修".repeat(128));
    manifest["last_operation"]["result_revision"] = manifest["revision"].clone();
    manifest["title"] = serde_json::json!("注".repeat(256));
    manifest["source"]["resource_id"] = serde_json::json!("资".repeat(128));
    manifest["last_operation"]["operation_id"] = serde_json::json!("o".repeat(128));
    manifest["last_operation"]["previous_revision"] = serde_json::json!("p".repeat(128));
    let pages = (0..INK_PAGES_MAX)
        .map(|index| {
            let mut page = manifest["pages"][0].clone();
            page["page_id"] = serde_json::json!(format!("page-{index}"));
            page["width"] = serde_json::json!(INK_DIMENSION_MIN);
            page["height"] = serde_json::json!(INK_DIMENSION_MAX);
            page
        })
        .collect();
    manifest["pages"] = serde_json::Value::Array(pages);
    let manifest_bytes = serde_json::to_vec(&manifest).expect("manifest serializes");
    assert!(manifest_bytes.len() <= INK_MANIFEST_MAX_BYTES);
    assert!(
        parse_manifest(&manifest_bytes).is_ok(),
        "document and field maxima are inclusive"
    );

    let samples = (0..INK_PAGE_SAMPLES_MAX)
        .map(|_| serde_json::json!({"x": 1.0, "y": 1.0, "pressure": 0.5}))
        .collect::<Vec<_>>();
    let mut objects = vec![
        serde_json::json!({
            "id":"stroke-boundary", "author":"user", "created_at":0,
            "content":{"kind":"stroke", "samples":samples,
                "style":{"tool":"pen","color":"#000000","width":INK_WIDTH_MAX,"pressure_enabled":true}}
        }),
        serde_json::json!({
            "id":"text-boundary", "author":"user", "created_at":0,
            "content":{"kind":"text", "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},
                "text":"<".repeat(INK_TEXT_MAX_CHARS), "font_size":INK_FONT_SIZE_MAX,"color":"#000000"}
        }),
    ];
    objects.extend((2..INK_PAGE_OBJECTS_MAX).map(|index| {
        serde_json::json!({
            "id":format!("object-{index}"), "author":"ai", "created_at":0,
            "content":{"kind":"rect", "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},
                "color":"#000000", "width":INK_WIDTH_MAX}
        })
    }));
    let page = serde_json::json!({"schema_version":1,"page_id":"page-0001","objects":objects});
    let page_bytes = serde_json::to_vec(&page).expect("page serializes");
    assert!(
        page_bytes.len() <= INK_PAGE_MAX_BYTES,
        "boundary page fixture must stay under byte cap"
    );
    assert!(
        parse_page(&page_bytes, &fixture_page_ref()).is_ok(),
        "page object/sample/text/style maxima are inclusive"
    );
}

#[test]
fn ink_board_v2_fixture_parses_and_round_trips_surface_contract() {
    // Raw serde gate: isolate the surface adapter from the manifest and domain
    // validation, so any regression surfaces serde's exact error (this crate
    // enables serde_json/arbitrary_precision; see InkBoardSurface Deserialize).
    let fixture: serde_json::Value =
        serde_json::from_slice(BOARD_V2_FIXTURE).expect("board v2 fixture JSON is valid");
    let surface_bytes =
        serde_json::to_vec(&fixture["surface"]).expect("board v2 surface serializes");
    let direct_surface: InkBoardSurface = serde_json::from_slice(&surface_bytes)
        .unwrap_or_else(|error| panic!("board v2 surface must deserialize directly: {error}"));
    assert_eq!(
        direct_surface,
        InkBoardSurface::Board {
            page_id: "page-board-0001".to_owned(),
            ruling: InkRuling::Blank,
            bounds: InkBoardBounds {
                x: -100.0,
                y: -80.0,
                width: 200.0,
                height: 160.0,
            },
        }
    );

    let manifest = parse_manifest(BOARD_V2_FIXTURE).expect("valid board v2 fixture must parse");
    let serialized =
        serde_json::to_vec(&manifest).expect("board v2 manifest serialization must succeed");
    let wire: serde_json::Value =
        serde_json::from_slice(&serialized).expect("serialized JSON is valid");

    assert_eq!(wire["schema_version"].as_u64(), Some(2));
    assert_eq!(wire["document_id"].as_str(), Some("doc-board-demo-0001"));
    assert_eq!(wire["revision"].as_str(), Some("r-000001"));
    assert_eq!(wire["title"].as_str(), Some("空白无限画布"));
    assert_eq!(wire["source"]["kind"].as_str(), Some("blank"));
    assert_eq!(
        wire["pages"].as_array().map(|pages| pages.len()),
        Some(0),
        "v2 board manifests carry chunks instead of fixed pages"
    );

    assert_eq!(wire["surface"]["kind"].as_str(), Some("board"));
    assert_eq!(wire["surface"]["page_id"].as_str(), Some("page-board-0001"));
    assert_eq!(wire["surface"]["ruling"].as_str(), Some("blank"));
    assert_eq!(wire["surface"]["bounds"]["x"].as_f64(), Some(-100.0));
    assert_eq!(wire["surface"]["bounds"]["y"].as_f64(), Some(-80.0));
    assert_eq!(wire["surface"]["bounds"]["width"].as_f64(), Some(200.0));
    assert_eq!(wire["surface"]["bounds"]["height"].as_f64(), Some(160.0));
    assert_eq!(
        wire["surface"]["bounds"]
            .as_object()
            .map(|bounds| bounds.len()),
        Some(4),
        "surface bounds must be exactly x/y/width/height"
    );
    assert_eq!(
        wire["chunks"].as_array().map(|chunks| chunks.len()),
        Some(0)
    );
    assert!(wire.get("last_operation").is_none());

    let reparsed = parse_manifest(&serialized).expect("round-tripped board v2 manifest must parse");
    assert_eq!(reparsed, manifest);
}

#[test]
fn ink_board_v2_rejects_resource_source_and_empty_ids() {
    let mut resource_source = board_v2_fixture_value();
    set_json(
        &mut resource_source,
        "/source",
        serde_json::json!({
            "kind": "resource",
            "resource_id": "res-pdf-src-0042",
            "source_hash": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
            "conversion_revision": "conv-1"
        }),
    );
    assert!(
        parse_manifest(&serde_json::to_vec(&resource_source).expect("JSON serializes")).is_err(),
        "v2 boards must not mix a resource source into a blank board"
    );

    let mut malformed_resource_source = board_v2_fixture_value();
    set_json(
        &mut malformed_resource_source,
        "/source",
        serde_json::json!({"kind": "resource", "resource_id": "res-pdf-src-0042"}),
    );
    assert!(
        parse_manifest(&serde_json::to_vec(&malformed_resource_source).expect("JSON serializes"))
            .is_err(),
        "malformed v2 resource source must be rejected"
    );

    for (name, pointer) in [
        ("empty_document_id", "/document_id"),
        ("empty_surface_page_id", "/surface/page_id"),
    ] {
        let mut value = board_v2_fixture_value();
        set_json(&mut value, pointer, serde_json::json!(""));
        let error =
            parse_manifest(&serde_json::to_vec(&value).expect("JSON serializes")).expect_err(name);
        assert_eq!(error.code, InkErrorCode::InvalidArgument, "{name}");
    }
}

#[test]
fn ink_board_v2_rejects_invalid_surface_geometry() {
    let cases = [
        (
            "negative_width",
            "/surface/bounds/width",
            serde_json::json!(-1.0),
        ),
        (
            "zero_width",
            "/surface/bounds/width",
            serde_json::json!(0.0),
        ),
        (
            "x_below_signed_safe_range",
            "/surface/bounds/x",
            serde_json::json!(-10_000_001.0),
        ),
        (
            "y_above_signed_safe_range",
            "/surface/bounds/y",
            serde_json::json!(10_000_001.0),
        ),
    ];

    for (name, pointer, replacement) in cases {
        let mut value = board_v2_fixture_value();
        set_json(&mut value, pointer, replacement);
        let error =
            parse_manifest(&serde_json::to_vec(&value).expect("JSON serializes")).expect_err(name);
        assert_eq!(error.code, InkErrorCode::InvalidArgument, "{name}");
    }
}

#[test]
fn ink_board_v2_rejects_unknown_surface_fields() {
    for (name, pointer) in [
        ("surface_struct", "/surface"),
        ("bounds_struct", "/surface/bounds"),
    ] {
        let value = add_unknown_field(board_v2_fixture_value(), pointer);
        let error =
            parse_manifest(&serde_json::to_vec(&value).expect("JSON serializes")).expect_err(name);
        assert_eq!(error.code, InkErrorCode::InvalidArgument, "{name}");
    }
}

#[test]
fn ink_v1_manifest_rejects_surface_and_chunks_fields() {
    let board_surface = board_v2_fixture_value()["surface"].clone();
    for (name, field, field_value) in [
        ("v1_surface_field", "surface", board_surface),
        ("v1_chunks_field", "chunks", serde_json::json!([])),
    ] {
        let mut value = manifest_fixture_value();
        value
            .as_object_mut()
            .expect("manifest fixture is an object")
            .insert(field.to_owned(), field_value);
        let error =
            parse_manifest(&serde_json::to_vec(&value).expect("JSON serializes")).expect_err(name);
        assert_eq!(error.code, InkErrorCode::InvalidArgument, "{name}");
    }
}
