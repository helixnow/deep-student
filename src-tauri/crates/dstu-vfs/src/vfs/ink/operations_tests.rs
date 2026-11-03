use super::*;
use crate::vfs::ink::{parse_manifest, parse_page};
use sha2::{Digest, Sha256};

const MANIFEST_FIXTURE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../tests/fixtures/ink/ink-manifest-v1.json"
));
const PAGE_FIXTURE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../tests/fixtures/ink/page-v1.json"
));

fn fixture_state() -> (InkManifest, Vec<InkPage>) {
    let manifest = parse_manifest(MANIFEST_FIXTURE).expect("manifest fixture is valid");
    let pages = manifest
        .pages
        .iter()
        .map(|page_ref| parse_page(PAGE_FIXTURE, page_ref).expect("page fixture is valid"))
        .collect();
    (manifest, pages)
}

fn fixture_mapping() -> InkRenderMapping {
    InkRenderMapping {
        render_id: "render-000007".to_owned(),
        document_id: "doc-ink-demo-0001".to_owned(),
        revision: "r-000007".to_owned(),
        page_id: "page-0001".to_owned(),
        crop: InkRect {
            x: 100.0,
            y: 200.0,
            width: 400.0,
            height: 500.0,
        },
    }
}

fn add_text_operation(object_id: &str, rect: InkNormalizedRect) -> InkOperation {
    InkOperation::AddText {
        page_id: "page-0001".to_owned(),
        object_id: object_id.to_owned(),
        created_at: 1_700_000_005_000,
        coordinate_space: InkCoordinateSpace::Page,
        based_on_render_id: "render-000007".to_owned(),
        rect,
        text: "operation test".to_owned(),
        font_size: 18.0,
        color: "#1f2937".to_owned(),
    }
}

fn hash_page(page: &InkPage) -> String {
    let bytes = serde_json::to_vec(page).expect("page serializes");
    hex::encode(Sha256::digest(bytes))
}

fn human_text_object(id: &str, text: &str, x: f64) -> InkObject {
    InkObject {
        id: id.to_owned(),
        author: InkAuthor::User,
        created_at: 1_700_000_006_000,
        content: InkObjectContent::Text {
            rect: InkRect {
                x,
                y: 100.0,
                width: 120.0,
                height: 32.0,
            },
            text: text.to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        },
    }
}

#[test]
fn ink_operations_add_normalized_text_and_crop_mapped_arrow() {
    let (manifest, pages) = fixture_state();
    let operations = [
        InkOperation::AddText {
            page_id: "page-0001".to_owned(),
            object_id: "op-text-1".to_owned(),
            created_at: 1_700_000_001_000,
            coordinate_space: InkCoordinateSpace::Page,
            based_on_render_id: "render-000007".to_owned(),
            rect: InkNormalizedRect {
                x: 0.25,
                y: 0.1,
                width: 0.5,
                height: 0.04,
            },
            text: "normalized text".to_owned(),
            font_size: 18.0,
            color: "#1f2937".to_owned(),
        },
        InkOperation::AddArrow {
            page_id: "page-0001".to_owned(),
            object_id: "op-arrow-1".to_owned(),
            created_at: 1_700_000_001_001,
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: "render-000007".to_owned(),
            from: InkNormalizedPoint { x: 0.25, y: 0.5 },
            to: InkNormalizedPoint { x: 0.75, y: 0.75 },
            color: "#ef4444".to_owned(),
            width: 3.0,
        },
    ];

    let result = apply_operations(&manifest, &pages, &operations, &[fixture_mapping()])
        .expect("valid normalized operations must apply");
    let page = result
        .pages
        .iter()
        .find(|page| page.page_id == "page-0001")
        .expect("target page remains present");

    let text = page
        .objects
        .iter()
        .find(|object| object.id == "op-text-1")
        .expect("text object is appended");
    assert_eq!(text.author, InkAuthor::Ai);
    assert_eq!(text.created_at, 1_700_000_001_000);
    assert_eq!(
        text.content,
        InkObjectContent::Text {
            rect: InkRect {
                x: 200.0,
                y: 100.0,
                width: 400.0,
                height: 40.0,
            },
            text: "normalized text".to_owned(),
            font_size: 18.0,
            color: "#1f2937".to_owned(),
        }
    );

    let arrow = page
        .objects
        .iter()
        .find(|object| object.id == "op-arrow-1")
        .expect("arrow object is appended");
    assert_eq!(
        arrow.content,
        InkObjectContent::Arrow {
            from: InkPoint { x: 200.0, y: 450.0 },
            to: InkPoint { x: 400.0, y: 575.0 },
            color: "#ef4444".to_owned(),
            width: 3.0,
        }
    );
    assert_eq!(result.affected_page_ids, vec!["page-0001".to_owned()]);
    assert_eq!(result.object_changes.len(), 2);
    assert!(result.object_changes.iter().all(|change| {
        change.page_id == "page-0001"
            && change.before.is_none()
            && change
                .after
                .as_ref()
                .is_some_and(|object| object.id == change.object_id)
    }));
}

#[test]
fn ink_operations_append_blank_page_with_requested_geometry_and_ruling() {
    let (manifest, pages) = fixture_state();
    let operation = InkOperation::AppendBlankPage {
        page_id: "page-0002".to_owned(),
        width: 800.0,
        height: 1000.0,
        ruling: InkRuling::Grid,
    };

    let result = apply_operations(&manifest, &pages, &[operation], &[])
        .expect("valid blank-page operation must apply");

    assert_eq!(result.manifest.pages.len(), 2);
    let page_ref = &result.manifest.pages[1];
    assert_eq!(page_ref.page_id, "page-0002");
    assert_eq!(page_ref.width, 800.0);
    assert_eq!(page_ref.height, 1000.0);
    assert_eq!(
        page_ref.background,
        InkBackground::Blank {
            ruling: InkRuling::Grid,
        }
    );
    assert_eq!(
        result.pages.last(),
        Some(&InkPage {
            schema_version: INK_SCHEMA_VERSION,
            page_id: "page-0002".to_owned(),
            objects: Vec::new(),
        })
    );
    assert_eq!(result.appended_page_ids, vec!["page-0002".to_owned()]);
}

#[test]
fn ink_operation_wire_round_trip_preserves_literal_decimal_floats() {
    let operations = vec![
        InkOperation::AddText {
            page_id: "page-0001".to_owned(),
            object_id: "wire-text".to_owned(),
            created_at: 1_700_000_003_000,
            coordinate_space: InkCoordinateSpace::Page,
            based_on_render_id: "render-000007".to_owned(),
            rect: InkNormalizedRect {
                x: 0.123,
                y: 0.456,
                width: 0.789,
                height: 0.125,
            },
            text: "decimal wire test".to_owned(),
            font_size: 18.25,
            color: "#1f2937".to_owned(),
        },
        InkOperation::UpdateObject {
            page_id: "page-0001".to_owned(),
            object_id: "obj-0001".to_owned(),
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: "render-000007".to_owned(),
            content: InkOperationContent::Arrow {
                from: InkNormalizedPoint { x: 0.125, y: 0.375 },
                to: InkNormalizedPoint { x: 0.625, y: 0.875 },
                color: "#ef4444".to_owned(),
                width: 2.75,
            },
        },
    ];

    let wire = serde_json::to_vec(&operations).expect("operation request serializes");
    let decoded: Vec<InkOperation> =
        serde_json::from_slice(&wire).expect("decimal operation request deserializes");
    assert_eq!(decoded, operations);
}

#[test]
fn ink_operations_reject_empty_and_oversized_batches() {
    let (manifest, pages) = fixture_state();
    let error = apply_operations(&manifest, &pages, &[], &[]).expect_err("empty batch rejected");
    assert_eq!(error.code, InkOperationErrorCode::BatchSizeInvalid);

    let operations = (0..101)
        .map(|index| InkOperation::AppendBlankPage {
            page_id: format!("page-new-{index}"),
            width: 800.0,
            height: 1000.0,
            ruling: InkRuling::Blank,
        })
        .collect::<Vec<_>>();
    let error =
        apply_operations(&manifest, &pages, &operations, &[]).expect_err("batch over 100 rejected");
    assert_eq!(error.code, InkOperationErrorCode::BatchSizeInvalid);
}

#[test]
fn ink_operations_reject_mapping_geometry_and_missing_object_errors() {
    let (manifest, pages) = fixture_state();
    let valid_rect = InkNormalizedRect {
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.05,
    };

    let error = apply_operations(
        &manifest,
        &pages,
        &[add_text_operation("missing-map", valid_rect)],
        &[],
    )
    .expect_err("missing mapping rejected");
    assert_eq!(error.code, InkOperationErrorCode::RenderMappingRequired);

    let mut stale_mapping = fixture_mapping();
    stale_mapping.revision = "r-old".to_owned();
    let error = apply_operations(
        &manifest,
        &pages,
        &[add_text_operation("stale-map", valid_rect)],
        &[stale_mapping],
    )
    .expect_err("stale mapping rejected");
    assert_eq!(error.code, InkOperationErrorCode::RevisionConflict);

    let outside_rect = InkNormalizedRect {
        x: 0.9,
        y: 0.1,
        width: 0.2,
        height: 0.1,
    };
    let error = apply_operations(
        &manifest,
        &pages,
        &[add_text_operation("outside", outside_rect)],
        &[fixture_mapping()],
    )
    .expect_err("out-of-range normalized geometry rejected");
    assert_eq!(error.code, InkOperationErrorCode::GeometryInvalid);

    let missing_object = InkOperation::RemoveObject {
        page_id: "page-0001".to_owned(),
        object_id: "does-not-exist".to_owned(),
    };
    let error = apply_operations(&manifest, &pages, &[missing_object], &[])
        .expect_err("missing object removal rejected");
    assert_eq!(error.code, InkOperationErrorCode::ObjectNotFound);
}

#[test]
fn ink_operations_reject_duplicate_ids_invalid_content_and_stroke_updates() {
    let (manifest, pages) = fixture_state();
    let duplicate = add_text_operation(
        "obj-0003",
        InkNormalizedRect {
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.05,
        },
    );
    let error = apply_operations(&manifest, &pages, &[duplicate], &[fixture_mapping()])
        .expect_err("duplicate object ID rejected");
    assert_eq!(error.code, InkOperationErrorCode::DuplicateId);

    let invalid_style = InkOperation::AddRect {
        page_id: "page-0001".to_owned(),
        object_id: "invalid-style".to_owned(),
        created_at: 1_700_000_005_001,
        coordinate_space: InkCoordinateSpace::Page,
        based_on_render_id: "render-000007".to_owned(),
        rect: InkNormalizedRect {
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.05,
        },
        color: "not-a-color".to_owned(),
        width: -1.0,
    };
    let error = apply_operations(&manifest, &pages, &[invalid_style], &[fixture_mapping()])
        .expect_err("invalid shape style rejected");
    assert_eq!(error.code, InkOperationErrorCode::ContentInvalid);

    let stroke_update = InkOperation::UpdateObject {
        page_id: "page-0001".to_owned(),
        object_id: "obj-0001".to_owned(),
        coordinate_space: InkCoordinateSpace::Page,
        based_on_render_id: "render-000007".to_owned(),
        content: InkOperationContent::Text {
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.05,
            },
            text: "not a model stroke".to_owned(),
            font_size: 18.0,
            color: "#1f2937".to_owned(),
        },
    };
    let error = apply_operations(&manifest, &pages, &[stroke_update], &[fixture_mapping()])
        .expect_err("stroke replacement is forbidden");
    assert_eq!(error.code, InkOperationErrorCode::UnsupportedStrokeUpdate);
}

#[test]
fn ink_operations_late_failure_keeps_inputs_unchanged() {
    let (manifest, pages) = fixture_state();
    let original_manifest = manifest.clone();
    let original_pages = pages.clone();
    let operations = [
        add_text_operation(
            "first-new-object",
            InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.05,
            },
        ),
        InkOperation::RemoveObject {
            page_id: "page-0001".to_owned(),
            object_id: "missing-after-add".to_owned(),
        },
    ];

    let error = apply_operations(&manifest, &pages, &operations, &[fixture_mapping()])
        .expect_err("second operation fails the batch");
    assert_eq!(error.code, InkOperationErrorCode::ObjectNotFound);
    assert_eq!(manifest, original_manifest);
    assert_eq!(pages, original_pages);
}

#[test]
fn ink_operations_remove_returns_reversible_before_record() {
    let (manifest, pages) = fixture_state();
    let removed = pages[0]
        .objects
        .iter()
        .find(|object| object.id == "obj-0004")
        .expect("fixture has a rectangle object")
        .clone();
    let operation = InkOperation::RemoveObject {
        page_id: "page-0001".to_owned(),
        object_id: "obj-0004".to_owned(),
    };
    let result = apply_operations(&manifest, &pages, &[operation], &[])
        .expect("existing object can be removed");
    let change = result
        .object_changes
        .iter()
        .find(|change| change.object_id == "obj-0004")
        .expect("removal before record exists");

    assert_eq!(change.before.as_ref(), Some(&removed));
    assert!(change.after.is_none());
    assert!(!result.pages[0]
        .objects
        .iter()
        .any(|object| object.id == "obj-0004"));
    assert!(result.pages[0]
        .objects
        .iter()
        .any(|object| object.id == "obj-0001"));
}

#[test]
fn ink_operations_change_receipts_preserve_unrelated_objects() {
    let (manifest, pages) = fixture_state();
    let old_text = pages[0]
        .objects
        .iter()
        .find(|object| object.id == "obj-0003")
        .expect("fixture has text object")
        .clone();
    let operation = InkOperation::UpdateObject {
        page_id: "page-0001".to_owned(),
        object_id: "obj-0003".to_owned(),
        coordinate_space: InkCoordinateSpace::Page,
        based_on_render_id: "render-000007".to_owned(),
        content: InkOperationContent::Text {
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.06,
            },
            text: "AI replacement".to_owned(),
            font_size: 20.0,
            color: "#1f2937".to_owned(),
        },
    };
    let result = apply_operations(&manifest, &pages, &[operation], &[fixture_mapping()])
        .expect("valid object update succeeds");
    let change = result
        .object_changes
        .iter()
        .find(|change| change.object_id == "obj-0003")
        .expect("before/after record exists");
    assert_eq!(change.before.as_ref(), Some(&old_text));
    assert_eq!(
        change.after.as_ref().map(|object| &object.content),
        Some(&InkObjectContent::Text {
            rect: InkRect {
                x: 80.0,
                y: 200.0,
                width: 240.0,
                height: 60.0
            },
            text: "AI replacement".to_owned(),
            font_size: 20.0,
            color: "#1f2937".to_owned(),
        })
    );
    assert!(result.pages[0]
        .objects
        .iter()
        .any(|object| object.id == "obj-0001"));
    assert!(result.pages[0]
        .objects
        .iter()
        .any(|object| object.id == "obj-0004"));
}

#[test]
fn ink_undo_removes_ai_object_but_preserves_later_human_addition() {
    let (manifest, pages) = fixture_state();
    let operation = add_text_operation(
        "ai-object",
        InkNormalizedRect {
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.05,
        },
    );
    let ai_result = apply_operations(&manifest, &pages, &[operation], &[fixture_mapping()])
        .expect("AI add succeeds");

    let mut later_manifest = ai_result.manifest.clone();
    let mut later_pages = ai_result.pages.clone();
    later_pages[0]
        .objects
        .push(human_text_object("human-later", "keep me", 550.0));
    later_manifest.pages[0].page_blob_hash = hash_page(&later_pages[0]);

    let undone = undo_operations(
        &later_manifest,
        &later_pages,
        &ai_result.object_changes,
        &[],
    )
    .expect("undo succeeds without overwriting an unrelated human addition");

    assert!(!undone.pages[0]
        .objects
        .iter()
        .any(|object| object.id == "ai-object"));
    assert!(undone.pages[0]
        .objects
        .iter()
        .any(|object| object.id == "human-later"));
    assert!(undone.pages[0]
        .objects
        .iter()
        .any(|object| object.id == "obj-0001"));
}

#[test]
fn ink_undo_restores_exact_before_object_including_author_and_timestamp() {
    let (manifest, pages) = fixture_state();
    let before = pages[0]
        .objects
        .iter()
        .find(|object| object.id == "obj-0003")
        .expect("fixture text object exists")
        .clone();
    let operation = InkOperation::UpdateObject {
        page_id: "page-0001".to_owned(),
        object_id: "obj-0003".to_owned(),
        coordinate_space: InkCoordinateSpace::Page,
        based_on_render_id: "render-000007".to_owned(),
        content: InkOperationContent::Text {
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.06,
            },
            text: "replace before undo".to_owned(),
            font_size: 20.0,
            color: "#1f2937".to_owned(),
        },
    };
    let ai_result = apply_operations(&manifest, &pages, &[operation], &[fixture_mapping()])
        .expect("AI update succeeds");

    let undone = undo_operations(
        &ai_result.manifest,
        &ai_result.pages,
        &ai_result.object_changes,
        &[],
    )
    .expect("undo restores the exact prior object");
    let restored = undone.pages[0]
        .objects
        .iter()
        .find(|object| object.id == "obj-0003")
        .expect("restored object exists");
    assert_eq!(restored, &before);
    assert_eq!(restored.author, InkAuthor::User);
    assert_eq!(restored.created_at, before.created_at);
}

#[test]
fn ink_undo_same_object_human_edit_conflicts_without_partial_changes() {
    let (manifest, pages) = fixture_state();
    let operations = [
        add_text_operation(
            "ai-added",
            InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.05,
            },
        ),
        InkOperation::UpdateObject {
            page_id: "page-0001".to_owned(),
            object_id: "obj-0003".to_owned(),
            coordinate_space: InkCoordinateSpace::Page,
            based_on_render_id: "render-000007".to_owned(),
            content: InkOperationContent::Text {
                rect: InkNormalizedRect {
                    x: 0.1,
                    y: 0.2,
                    width: 0.3,
                    height: 0.06,
                },
                text: "AI update".to_owned(),
                font_size: 20.0,
                color: "#1f2937".to_owned(),
            },
        },
    ];
    let ai_result = apply_operations(&manifest, &pages, &operations, &[fixture_mapping()])
        .expect("AI batch succeeds");
    let mut human_pages = ai_result.pages.clone();
    let human_object = human_pages[0]
        .objects
        .iter_mut()
        .find(|object| object.id == "obj-0003")
        .expect("AI-updated object exists");
    human_object.content = InkObjectContent::Text {
        rect: InkRect {
            x: 50.0,
            y: 50.0,
            width: 150.0,
            height: 40.0,
        },
        text: "human edit wins".to_owned(),
        font_size: 16.0,
        color: "#1f2937".to_owned(),
    };
    let mut human_manifest = ai_result.manifest.clone();
    human_manifest.pages[0].page_blob_hash = hash_page(&human_pages[0]);
    let original_after_human_edit = human_pages.clone();
    let original_human_manifest = human_manifest.clone();

    let error = undo_operations(
        &human_manifest,
        &human_pages,
        &ai_result.object_changes,
        &[],
    )
    .expect_err("changed AI-owned object must reject the whole undo");

    assert_eq!(error.code, InkOperationErrorCode::RevisionConflict);
    assert_eq!(human_pages, original_after_human_edit);
    assert_eq!(human_manifest, original_human_manifest);
}

#[test]
fn ink_undo_rejects_appended_page_with_later_human_content() {
    let (manifest, pages) = fixture_state();
    let appended = apply_operations(
        &manifest,
        &pages,
        &[InkOperation::AppendBlankPage {
            page_id: "page-appended".to_owned(),
            width: 800.0,
            height: 1000.0,
            ruling: InkRuling::Blank,
        }],
        &[],
    )
    .expect("page append succeeds");
    let mut later_manifest = appended.manifest.clone();
    let mut later_pages = appended.pages.clone();
    later_pages[1]
        .objects
        .push(human_text_object("human-page-content", "retain", 200.0));
    later_manifest.pages[1].page_blob_hash = hash_page(&later_pages[1]);
    let original_manifest = later_manifest.clone();
    let original_pages = later_pages.clone();

    let error = undo_operations(
        &later_manifest,
        &later_pages,
        &[],
        &appended.appended_page_ids,
    )
    .expect_err("appended page with later human content cannot be deleted");

    assert_eq!(error.code, InkOperationErrorCode::RevisionConflict);
    assert_eq!(later_manifest, original_manifest);
    assert_eq!(later_pages, original_pages);
}

#[test]
fn ink_undo_removes_an_empty_appended_page() {
    let (manifest, pages) = fixture_state();
    let appended = apply_operations(
        &manifest,
        &pages,
        &[InkOperation::AppendBlankPage {
            page_id: "page-appended-empty".to_owned(),
            width: 800.0,
            height: 1000.0,
            ruling: InkRuling::Lined,
        }],
        &[],
    )
    .expect("page append succeeds");

    let undone = undo_operations(
        &appended.manifest,
        &appended.pages,
        &[],
        &appended.appended_page_ids,
    )
    .expect("empty appended page can be undone");
    assert_eq!(undone.manifest.pages.len(), 1);
    assert_eq!(undone.pages, pages);
}
