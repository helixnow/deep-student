//! Atomic persistence for bounded AI operations on Ink documents.

use std::{collections::BTreeSet, path::Path};

use rusqlite::Connection;
use serde::Serialize;

use crate::vfs::{
    error::{VfsError, VfsResult},
    ink::{
        apply_operations, undo_operations, InkManifest, InkObject, InkObjectChange, InkOperation,
        InkOperationError, InkOperationErrorCode, InkOperationReceipt, InkOperationsResult,
        InkRect, InkRenderMapping,
    },
    repos::{ink_artifact_repo::VfsInkArtifactRepo, ink_repo::VfsInkRepo, VfsBlobRepo},
};

const OPERATION_REUSED: &str = "ink.operation_id_reused";
const OPERATION_UNKNOWN: &str = "ink.operation_state_unknown";
const REVISION_CONFLICT: &str = "ink.revision_conflict";

#[derive(Serialize)]
struct ApplyInput<'a> {
    document_id: &'a str,
    expected_revision: &'a str,
    operations: &'a [InkOperation],
    mappings: &'a [InkRenderMapping],
}

#[derive(Serialize)]
struct UndoInput<'a> {
    document_id: &'a str,
    expected_revision: &'a str,
    changes: Vec<UndoChange<'a>>,
    appended_page_ids: &'a [String],
}

#[derive(Serialize)]
struct UndoChange<'a> {
    page_id: &'a str,
    object_id: &'a str,
    before: Option<&'a InkObject>,
    after: Option<&'a InkObject>,
}

pub struct VfsInkOperationRepo;

impl VfsInkOperationRepo {
    pub fn apply_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        ops: &[InkOperation],
        mappings: &[InkRenderMapping],
    ) -> VfsResult<(InkManifest, InkOperationsResult)> {
        validate_operation_id(operation_id)?;
        if ops.is_empty() || ops.len() > 100 {
            return Err(invalid_operations(
                "Ink operation batch must contain 1 to 100 operations",
            ));
        }
        let input_hash = hash_input(&ApplyInput {
            document_id,
            expected_revision,
            operations: ops,
            mappings,
        })?;
        let manifest = VfsInkRepo::get_manifest_with_conn(conn, blobs_dir, document_id)?;

        // The manifest holds the latest receipt, so resolve exact retries before validating
        // mappings against the now-advanced document revision.
        if let Some(receipt) = manifest.last_operation.as_ref() {
            if receipt.operation_id == operation_id {
                if receipt.input_hash != input_hash {
                    return Err(conflict(
                        OPERATION_REUSED,
                        "Operation ID was already used with different input",
                    ));
                }
                if receipt.previous_revision.as_deref() != Some(expected_revision)
                    || manifest.revision != receipt.result_revision
                {
                    return Err(conflict(
                        OPERATION_UNKNOWN,
                        "The previous operation result can no longer be proven",
                    ));
                }
                let pages = load_pages(conn, blobs_dir, &manifest)?;
                let result = InkOperationsResult {
                    manifest: manifest.clone(),
                    pages,
                    affected_page_ids: affected_page_ids(ops),
                    object_changes: Vec::new(),
                    appended_page_ids: appended_page_ids(ops),
                };
                return Ok((manifest, result));
            }
        }
        if manifest.revision != expected_revision {
            return Err(conflict(
                OPERATION_UNKNOWN,
                "A stale revision cannot prove whether this operation already committed",
            ));
        }

        validate_render_mappings(conn, blobs_dir, &manifest, mappings)?;
        let pages = load_pages(conn, blobs_dir, &manifest)?;
        let mut result =
            apply_operations(&manifest, &pages, ops, mappings).map_err(map_operation_error)?;

        let previous_revision = manifest.revision.clone();
        let revision = format!("r_{}", nanoid::nanoid!(16));
        result.manifest.revision = revision.clone();
        result.manifest.last_operation = Some(InkOperationReceipt {
            operation_id: operation_id.to_owned(),
            input_hash,
            previous_revision: Some(previous_revision),
            result_revision: revision,
        });
        let changed_pages = result
            .affected_page_ids
            .iter()
            .filter_map(|page_id| result.pages.iter().find(|page| page.page_id == *page_id))
            .cloned()
            .collect::<Vec<_>>();
        let committed = VfsInkRepo::commit_document_with_conn(
            conn,
            blobs_dir,
            document_id,
            expected_revision,
            operation_id,
            result.manifest.clone(),
            &changed_pages,
        )?;
        result.manifest = committed.clone();
        Ok((committed, result))
    }

    pub fn undo_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        changes: &[InkObjectChange],
        appended_page_ids: &[String],
    ) -> VfsResult<(InkManifest, InkOperationsResult)> {
        validate_operation_id(operation_id)?;
        let input_hash = hash_input(&UndoInput {
            document_id,
            expected_revision,
            changes: changes
                .iter()
                .map(|change| UndoChange {
                    page_id: &change.page_id,
                    object_id: &change.object_id,
                    before: change.before.as_ref(),
                    after: change.after.as_ref(),
                })
                .collect(),
            appended_page_ids,
        })?;
        let manifest = VfsInkRepo::get_manifest_with_conn(conn, blobs_dir, document_id)?;

        if let Some(receipt) = manifest.last_operation.as_ref() {
            if receipt.operation_id == operation_id {
                if receipt.input_hash != input_hash {
                    return Err(conflict(
                        OPERATION_REUSED,
                        "Undo operation ID was already used with different input",
                    ));
                }
                if receipt.previous_revision.as_deref() != Some(expected_revision)
                    || manifest.revision != receipt.result_revision
                {
                    return Err(conflict(
                        OPERATION_UNKNOWN,
                        "The previous undo result can no longer be proven",
                    ));
                }
                let pages = load_pages(conn, blobs_dir, &manifest)?;
                let result = InkOperationsResult {
                    manifest: manifest.clone(),
                    pages,
                    affected_page_ids: undo_affected_page_ids(changes, appended_page_ids),
                    object_changes: Vec::new(),
                    appended_page_ids: Vec::new(),
                };
                return Ok((manifest, result));
            }
        }
        if manifest.revision != expected_revision {
            return Err(conflict(
                OPERATION_UNKNOWN,
                "A stale revision cannot prove whether this undo already committed",
            ));
        }

        let pages = load_pages(conn, blobs_dir, &manifest)?;
        let mut result = undo_operations(&manifest, &pages, changes, appended_page_ids)
            .map_err(map_operation_error)?;
        let previous_revision = manifest.revision.clone();
        let revision = format!("r_{}", nanoid::nanoid!(16));
        result.manifest.revision = revision.clone();
        result.manifest.last_operation = Some(InkOperationReceipt {
            operation_id: operation_id.to_owned(),
            input_hash,
            previous_revision: Some(previous_revision),
            result_revision: revision,
        });
        let changed_pages = result
            .affected_page_ids
            .iter()
            .filter_map(|page_id| result.pages.iter().find(|page| page.page_id == *page_id))
            .cloned()
            .collect::<Vec<_>>();
        let committed = VfsInkRepo::commit_document_with_conn(
            conn,
            blobs_dir,
            document_id,
            expected_revision,
            operation_id,
            result.manifest.clone(),
            &changed_pages,
        )?;
        result.manifest = committed.clone();
        Ok((committed, result))
    }
}

fn load_pages(
    conn: &Connection,
    blobs_dir: &Path,
    manifest: &InkManifest,
) -> VfsResult<Vec<crate::vfs::ink::InkPage>> {
    manifest
        .pages
        .iter()
        .map(|page_ref| {
            VfsInkRepo::get_page_with_conn(
                conn,
                blobs_dir,
                &manifest.document_id,
                &page_ref.page_id,
            )
        })
        .collect()
}

fn validate_render_mappings(
    conn: &Connection,
    blobs_dir: &Path,
    manifest: &InkManifest,
    mappings: &[InkRenderMapping],
) -> VfsResult<()> {
    let mut seen = BTreeSet::new();
    for mapping in mappings {
        if !seen.insert(mapping.render_id.as_str()) {
            return Err(invalid_operations("Render mapping IDs must be unique"));
        }
        let artifact = VfsInkArtifactRepo::load_for_document_with_conn(
            conn,
            blobs_dir,
            &mapping.render_id,
            &manifest.document_id,
            &manifest.revision,
        )
        .map_err(|_| render_provenance_conflict())?
        .0;
        let page = manifest
            .pages
            .iter()
            .find(|page| page.page_id == mapping.page_id)
            .ok_or_else(render_provenance_conflict)?;
        let expected_crop = artifact.crop.unwrap_or(InkRect {
            x: 0.0,
            y: 0.0,
            width: page.width,
            height: page.height,
        });
        if mapping.document_id != manifest.document_id
            || mapping.revision != manifest.revision
            || artifact.page_id != mapping.page_id
            || mapping.crop != expected_crop
        {
            return Err(render_provenance_conflict());
        }
    }
    Ok(())
}

fn map_operation_error(error: InkOperationError) -> VfsError {
    if error.code == InkOperationErrorCode::RevisionConflict {
        conflict(REVISION_CONFLICT, &error.message)
    } else {
        invalid_operations(&error.message)
    }
}

fn undo_affected_page_ids(
    changes: &[InkObjectChange],
    appended_page_ids: &[String],
) -> Vec<String> {
    let mut page_ids = Vec::new();
    for page_id in changes
        .iter()
        .map(|change| &change.page_id)
        .chain(appended_page_ids.iter())
    {
        if !page_ids.contains(page_id) {
            page_ids.push(page_id.clone());
        }
    }
    page_ids
}

fn hash_input<T: Serialize>(input: &T) -> VfsResult<String> {
    let bytes =
        serde_json::to_vec(input).map_err(|error| VfsError::Serialization(error.to_string()))?;
    Ok(VfsBlobRepo::compute_hash(&bytes))
}

fn validate_operation_id(operation_id: &str) -> VfsResult<()> {
    if operation_id.trim().is_empty()
        || operation_id.chars().count() > 128
        || operation_id
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err(invalid_operations("Ink operation ID is invalid"));
    }
    Ok(())
}

fn affected_page_ids(ops: &[InkOperation]) -> Vec<String> {
    let mut page_ids = Vec::new();
    for operation in ops {
        let page_id = match operation {
            InkOperation::AppendBlankPage { page_id, .. }
            | InkOperation::AddText { page_id, .. }
            | InkOperation::AddRect { page_id, .. }
            | InkOperation::AddEllipse { page_id, .. }
            | InkOperation::AddArrow { page_id, .. }
            | InkOperation::AddRegionHighlight { page_id, .. }
            | InkOperation::UpdateObject { page_id, .. }
            | InkOperation::RemoveObject { page_id, .. } => page_id,
        };
        if !page_ids.contains(page_id) {
            page_ids.push(page_id.clone());
        }
    }
    page_ids
}

fn appended_page_ids(ops: &[InkOperation]) -> Vec<String> {
    ops.iter()
        .filter_map(|operation| match operation {
            InkOperation::AppendBlankPage { page_id, .. } => Some(page_id.clone()),
            _ => None,
        })
        .collect()
}

fn invalid_operations(message: &str) -> VfsError {
    VfsError::InvalidArgument {
        param: "operations".to_owned(),
        reason: message.to_owned(),
    }
}

fn render_provenance_conflict() -> VfsError {
    VfsError::Conflict {
        key: "ink.artifact.provenance_mismatch".to_owned(),
        message:
            "Ink render artifact does not match the requested document revision, page, or crop"
                .to_owned(),
    }
}

fn conflict(key: &str, message: &str) -> VfsError {
    VfsError::Conflict {
        key: key.to_owned(),
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        error::VfsError,
        ink::{
            InkAuthor, InkCoordinateSpace, InkNormalizedPoint, InkNormalizedRect, InkObject,
            InkObjectContent, InkOperation, InkRect, InkRenderMapping, InkRuling, InkSample,
            InkStrokeStyle, InkTool,
        },
        repos::{
            ink_artifact_repo::{InkArtifactDraft, VfsInkArtifactRepo},
            ink_repo::VfsInkRepo,
        },
    };

    use super::VfsInkOperationRepo;

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn setup() -> (tempfile::TempDir, VfsDatabase) {
        setup_migrated_test_db()
    }

    fn create_document(conn: &Connection, db: &VfsDatabase) -> crate::vfs::ink::InkManifest {
        create_document_with_operation_id(conn, db, "create-ai-ops")
    }

    fn create_document_with_operation_id(
        conn: &Connection,
        db: &VfsDatabase,
        operation_id: &str,
    ) -> crate::vfs::ink::InkManifest {
        VfsInkRepo::create_blank_with_conn(
            conn,
            db.blobs_dir(),
            "AI operations",
            InkRuling::Blank,
            100.0,
            100.0,
            operation_id,
            None,
        )
        .unwrap()
    }

    fn freeze_render(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
    ) -> InkRenderMapping {
        let page = &manifest.pages[0];
        let crop = InkRect {
            x: 0.0,
            y: 0.0,
            width: page.width,
            height: page.height,
        };
        store_render(
            conn,
            db,
            "frozen-ai-render",
            &manifest.document_id,
            &page.page_id,
            &manifest.revision,
            Some(crop),
            crop,
        )
    }

    fn store_render(
        conn: &Connection,
        db: &VfsDatabase,
        render_id: &str,
        document_id: &str,
        page_id: &str,
        revision: &str,
        artifact_crop: Option<InkRect>,
        logical_crop: InkRect,
    ) -> InkRenderMapping {
        VfsInkArtifactRepo::store_png_with_conn(
            conn,
            db.blobs_dir(),
            InkArtifactDraft {
                artifact_id: render_id.to_owned(),
                render_id: render_id.to_owned(),
                document_id: document_id.to_owned(),
                page_id: page_id.to_owned(),
                revision: revision.to_owned(),
                source_hash: None,
                source_annotation_revision: None,
                conversion_revision: None,
                crop: artifact_crop,
                width_px: 1,
                height_px: 1,
            },
            PNG_1X1,
        )
        .unwrap();
        InkRenderMapping {
            render_id: render_id.to_owned(),
            document_id: document_id.to_owned(),
            revision: revision.to_owned(),
            page_id: page_id.to_owned(),
            crop: logical_crop,
        }
    }

    fn freeze_full_page_render(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
    ) -> InkRenderMapping {
        let page = &manifest.pages[0];
        let full_page = InkRect {
            x: 0.0,
            y: 0.0,
            width: page.width,
            height: page.height,
        };
        store_render(
            conn,
            db,
            "frozen-full-page-render",
            &manifest.document_id,
            &page.page_id,
            &manifest.revision,
            None,
            full_page,
        )
    }

    fn operations(page_id: &str) -> [InkOperation; 2] {
        operations_for(page_id, "frozen-ai-render")
    }

    fn operations_for(page_id: &str, render_id: &str) -> [InkOperation; 2] {
        [
            InkOperation::AddText {
                page_id: page_id.to_owned(),
                object_id: "ai-text-1".to_owned(),
                created_at: 1_800_000_000_000,
                coordinate_space: InkCoordinateSpace::Page,
                based_on_render_id: render_id.to_owned(),
                rect: InkNormalizedRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.4,
                    height: 0.1,
                },
                text: "Atomic note".to_owned(),
                font_size: 16.0,
                color: "#1f2937".to_owned(),
            },
            InkOperation::AddArrow {
                page_id: page_id.to_owned(),
                object_id: "ai-arrow-1".to_owned(),
                created_at: 1_800_000_000_001,
                coordinate_space: InkCoordinateSpace::RenderCrop,
                based_on_render_id: render_id.to_owned(),
                from: InkNormalizedPoint { x: 0.2, y: 0.3 },
                to: InkNormalizedPoint { x: 0.8, y: 0.7 },
                color: "#ef4444".to_owned(),
                width: 2.0,
            },
        ]
    }

    fn human_stroke() -> InkObject {
        InkObject {
            id: "human-later-stroke".to_owned(),
            author: InkAuthor::User,
            created_at: 1_800_000_000_100,
            content: InkObjectContent::Stroke {
                samples: vec![InkSample {
                    x: 20.0,
                    y: 25.0,
                    pressure: 0.5,
                    elapsed_ms: Some(0.0),
                }],
                style: InkStrokeStyle {
                    tool: InkTool::Pen,
                    color: "#000000".to_owned(),
                    width: 2.0,
                    pressure_enabled: true,
                },
            },
        }
    }

    fn user_edited_ai_object() -> InkObject {
        InkObject {
            id: "ai-text-1".to_owned(),
            author: InkAuthor::User,
            created_at: 1_800_000_000_100,
            content: InkObjectContent::Text {
                rect: InkRect {
                    x: 12.0,
                    y: 14.0,
                    width: 40.0,
                    height: 12.0,
                },
                text: "human changed this AI text".to_owned(),
                font_size: 16.0,
                color: "#1f2937".to_owned(),
            },
        }
    }

    fn storage_counts(conn: &Connection) -> (i64, i64, i64, i64) {
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM resources), (SELECT COUNT(*) FROM blobs), (SELECT COALESCE(SUM(ref_count), 0) FROM blobs)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
    }

    fn assert_revision_conflict(error: VfsError) {
        assert!(matches!(
            error,
            VfsError::Conflict { key, .. } if key == "ink.revision_conflict"
        ));
    }

    fn assert_rejected_without_mutation(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
        operation_id: &str,
        ops: &[InkOperation],
        mapping: InkRenderMapping,
    ) {
        let counts = storage_counts(conn);
        let page = VfsInkRepo::get_page_with_conn(
            conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.pages[0].page_id,
        )
        .unwrap();

        assert!(VfsInkOperationRepo::apply_with_conn(
            conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.revision,
            operation_id,
            ops,
            &[mapping],
        )
        .is_err());

        assert_eq!(storage_counts(conn), counts);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(conn, db.blobs_dir(), &manifest.document_id)
                .unwrap(),
            *manifest,
        );
        assert_eq!(
            VfsInkRepo::get_page_with_conn(
                conn,
                db.blobs_dir(),
                &manifest.document_id,
                &manifest.pages[0].page_id,
            )
            .unwrap(),
            page,
        );
    }

    #[test]
    fn applies_text_and_arrow_atomically_and_reopens_canonical_state() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let mapping = freeze_render(&conn, &db, &original);
        let ops = operations(&original.pages[0].page_id);

        let (committed, result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "apply-ai-ops",
            &ops,
            &[mapping],
        )
        .unwrap();

        assert_ne!(committed.revision, original.revision);
        let receipt = committed.last_operation.as_ref().unwrap();
        assert_eq!(receipt.operation_id, "apply-ai-ops");
        assert_eq!(
            receipt.previous_revision.as_deref(),
            Some(original.revision.as_str())
        );
        assert_eq!(receipt.result_revision, committed.revision);
        assert_eq!(result.manifest, committed);
        assert_eq!(result.object_changes.len(), 2);
        assert!(result.object_changes.iter().all(|change| {
            change.before.is_none()
                && change
                    .after
                    .as_ref()
                    .is_some_and(|object| object.author == InkAuthor::Ai)
        }));

        let reopened_manifest =
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &committed.document_id)
                .unwrap();
        let reopened_page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &committed.document_id,
            &original.pages[0].page_id,
        )
        .unwrap();
        assert_eq!(reopened_manifest, committed);
        assert_eq!(reopened_page.objects.len(), 2);
        assert!(reopened_page
            .objects
            .iter()
            .any(|object| object.id == "ai-text-1"));
        assert!(reopened_page
            .objects
            .iter()
            .any(|object| object.id == "ai-arrow-1"));
    }

    #[test]
    fn full_page_render_without_artifact_crop_accepts_full_page_mapping() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let mapping = freeze_full_page_render(&conn, &db, &original);
        let ops = operations_for(&original.pages[0].page_id, &mapping.render_id);

        let (committed, result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "apply-full-page-render",
            &ops,
            &[mapping],
        )
        .unwrap();

        assert_ne!(committed.revision, original.revision);
        assert_eq!(result.object_changes.len(), 2);
        let page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &committed.document_id,
            &original.pages[0].page_id,
        )
        .unwrap();
        assert_eq!(page.objects.len(), 2);
    }

    #[test]
    fn forged_missing_cross_document_and_stale_render_mappings_are_rejected_without_mutation() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let valid = freeze_render(&conn, &db, &original);
        let ops = operations(&original.pages[0].page_id);

        let mut forged_crop = valid.clone();
        forged_crop.crop.width -= 1.0;
        assert_rejected_without_mutation(
            &conn,
            &db,
            &original,
            "reject-forged-crop",
            &ops,
            forged_crop,
        );

        let missing_artifact = InkRenderMapping {
            render_id: "not-a-frozen-render".to_owned(),
            ..valid.clone()
        };
        let missing_ops = operations_for(&original.pages[0].page_id, &missing_artifact.render_id);
        assert_rejected_without_mutation(
            &conn,
            &db,
            &original,
            "reject-missing-artifact",
            &missing_ops,
            missing_artifact,
        );

        let other_document = create_document_with_operation_id(&conn, &db, "create-other-doc");
        let other_page = &other_document.pages[0];
        let other_crop = InkRect {
            x: 0.0,
            y: 0.0,
            width: other_page.width,
            height: other_page.height,
        };
        let cross_document = store_render(
            &conn,
            &db,
            "foreign-document-render",
            &other_document.document_id,
            &other_page.page_id,
            &other_document.revision,
            Some(other_crop),
            other_crop,
        );
        let cross_document_ops =
            operations_for(&original.pages[0].page_id, &cross_document.render_id);
        assert_rejected_without_mutation(
            &conn,
            &db,
            &original,
            "reject-cross-document-render",
            &cross_document_ops,
            cross_document,
        );

        let stale_revision = store_render(
            &conn,
            &db,
            "stale-revision-render",
            &original.document_id,
            &original.pages[0].page_id,
            &original.revision,
            Some(valid.crop),
            valid.crop,
        );
        let old_page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.pages[0].page_id,
        )
        .unwrap();
        let current = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "advance-before-stale-render",
            &old_page,
        )
        .unwrap();
        let stale_ops = operations_for(&current.pages[0].page_id, &stale_revision.render_id);
        assert_rejected_without_mutation(
            &conn,
            &db,
            &current,
            "reject-stale-render-revision",
            &stale_ops,
            stale_revision,
        );
    }

    #[test]
    fn reused_operation_id_with_different_input_is_rejected_without_mutation() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let mapping = freeze_render(&conn, &db, &original);
        let ops = operations(&original.pages[0].page_id);
        let (committed, _) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "reuse-op-id",
            &ops,
            &[mapping.clone()],
        )
        .unwrap();
        let counts_after_commit = storage_counts(&conn);
        let page_after_commit = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &committed.document_id,
            &original.pages[0].page_id,
        )
        .unwrap();
        let mut changed_ops = ops.clone();
        if let InkOperation::AddText { text, .. } = &mut changed_ops[0] {
            *text = "Different payload".to_owned();
        }

        assert!(VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "reuse-op-id",
            &changed_ops,
            &[mapping],
        )
        .is_err());

        assert_eq!(storage_counts(&conn), counts_after_commit);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &original.document_id)
                .unwrap(),
            committed,
        );
        assert_eq!(
            VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &original.document_id,
                &original.pages[0].page_id,
            )
            .unwrap(),
            page_after_commit,
        );
    }

    #[test]
    fn invalid_second_operation_leaves_first_operation_uncommitted() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let mapping = freeze_render(&conn, &db, &original);
        let mut ops = operations(&original.pages[0].page_id);
        if let InkOperation::AddArrow { color, .. } = &mut ops[1] {
            *color = "invalid-color".to_owned();
        }
        let before_counts = storage_counts(&conn);

        assert!(VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "apply-invalid-ai-ops",
            &ops,
            &[mapping],
        )
        .is_err());

        assert_eq!(storage_counts(&conn), before_counts);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &original.document_id)
                .unwrap(),
            original,
        );
        assert!(VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.pages[0].page_id,
        )
        .unwrap()
        .objects
        .is_empty());
    }

    #[test]
    fn undo_preserves_human_stroke_added_after_ai_commit() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let mapping = freeze_render(&conn, &db, &original);
        let ops = operations(&original.pages[0].page_id);
        let (ai_manifest, ai_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "undo-preserve-ai-add",
            &ops,
            &[mapping],
        )
        .unwrap();
        let mut page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &ai_manifest.document_id,
            &ai_manifest.pages[0].page_id,
        )
        .unwrap();
        page.objects.push(human_stroke());
        let human_manifest = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &ai_manifest.document_id,
            &ai_manifest.revision,
            "human-stroke-after-ai",
            &page,
        )
        .unwrap();

        let (undone, result) = VfsInkOperationRepo::undo_with_conn(
            &conn,
            db.blobs_dir(),
            &human_manifest.document_id,
            &human_manifest.revision,
            "undo-ai-add",
            &ai_result.object_changes,
            &ai_result.appended_page_ids,
        )
        .unwrap();

        assert_ne!(undone.revision, human_manifest.revision);
        assert_eq!(result.manifest, undone);
        let reopened = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &undone.document_id,
            &undone.pages[0].page_id,
        )
        .unwrap();
        assert!(reopened
            .objects
            .iter()
            .any(|object| object.id == "human-later-stroke"));
        assert!(!reopened
            .objects
            .iter()
            .any(|object| object.id == "ai-text-1"));
        assert!(!reopened
            .objects
            .iter()
            .any(|object| object.id == "ai-arrow-1"));
    }

    #[test]
    fn undo_rejects_changed_ai_object_without_mutation() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let mapping = freeze_render(&conn, &db, &original);
        let ops = operations(&original.pages[0].page_id);
        let (ai_manifest, ai_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "undo-conflict-ai-add",
            &ops,
            &[mapping],
        )
        .unwrap();
        let mut page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &ai_manifest.document_id,
            &ai_manifest.pages[0].page_id,
        )
        .unwrap();
        let ai_object = page
            .objects
            .iter_mut()
            .find(|object| object.id == "ai-text-1")
            .unwrap();
        *ai_object = user_edited_ai_object();
        let human_manifest = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &ai_manifest.document_id,
            &ai_manifest.revision,
            "human-edit-ai-object",
            &page,
        )
        .unwrap();
        let before_counts = storage_counts(&conn);
        let before_page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &human_manifest.document_id,
            &human_manifest.pages[0].page_id,
        )
        .unwrap();

        assert_revision_conflict(
            VfsInkOperationRepo::undo_with_conn(
                &conn,
                db.blobs_dir(),
                &human_manifest.document_id,
                &human_manifest.revision,
                "undo-conflicting-ai-add",
                &ai_result.object_changes,
                &ai_result.appended_page_ids,
            )
            .unwrap_err(),
        );

        assert_eq!(storage_counts(&conn), before_counts);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &human_manifest.document_id,)
                .unwrap(),
            human_manifest,
        );
        assert_eq!(
            VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &human_manifest.document_id,
                &human_manifest.pages[0].page_id,
            )
            .unwrap(),
            before_page,
        );
    }

    #[test]
    fn undo_rejects_appended_page_with_human_stroke_without_mutation() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let appended_page_id = "ai-appended-page".to_owned();
        let append = InkOperation::AppendBlankPage {
            page_id: appended_page_id.clone(),
            width: 100.0,
            height: 100.0,
            ruling: InkRuling::Blank,
        };
        let (ai_manifest, ai_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "undo-appended-page",
            &[append],
            &[],
        )
        .unwrap();
        let mut page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &ai_manifest.document_id,
            &appended_page_id,
        )
        .unwrap();
        page.objects.push(human_stroke());
        let human_manifest = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &ai_manifest.document_id,
            &ai_manifest.revision,
            "human-stroke-on-appended-page",
            &page,
        )
        .unwrap();
        let before_counts = storage_counts(&conn);

        assert_revision_conflict(
            VfsInkOperationRepo::undo_with_conn(
                &conn,
                db.blobs_dir(),
                &human_manifest.document_id,
                &human_manifest.revision,
                "undo-appended-page-with-content",
                &ai_result.object_changes,
                &ai_result.appended_page_ids,
            )
            .unwrap_err(),
        );

        assert_eq!(storage_counts(&conn), before_counts);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &human_manifest.document_id,)
                .unwrap(),
            human_manifest,
        );
        assert!(VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &human_manifest.document_id,
            &appended_page_id,
        )
        .unwrap()
        .objects
        .iter()
        .any(|object| object.id == "human-later-stroke"));
    }

    #[test]
    fn undo_retry_returns_original_revision_and_rejects_reused_input_without_mutation() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let mapping = freeze_render(&conn, &db, &original);
        let ops = operations(&original.pages[0].page_id);
        let (ai_manifest, ai_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "undo-retry-ai-apply",
            &ops,
            &[mapping],
        )
        .unwrap();
        let undo_operation_id = "undo-retry-token";
        let (undone, _) = VfsInkOperationRepo::undo_with_conn(
            &conn,
            db.blobs_dir(),
            &ai_manifest.document_id,
            &ai_manifest.revision,
            undo_operation_id,
            &ai_result.object_changes,
            &ai_result.appended_page_ids,
        )
        .unwrap();
        let receipt = undone.last_operation.clone();
        let counts_after_undo = storage_counts(&conn);

        let (replayed, replay_result) = VfsInkOperationRepo::undo_with_conn(
            &conn,
            db.blobs_dir(),
            &ai_manifest.document_id,
            &ai_manifest.revision,
            undo_operation_id,
            &ai_result.object_changes,
            &ai_result.appended_page_ids,
        )
        .unwrap();
        assert_eq!(replayed, undone);
        assert_eq!(replayed.last_operation, receipt);
        assert_eq!(replay_result.manifest, undone);
        assert_eq!(storage_counts(&conn), counts_after_undo);

        let mut changed = ai_result.object_changes.clone();
        changed[0].after.as_mut().unwrap().created_at += 1;
        let reused = VfsInkOperationRepo::undo_with_conn(
            &conn,
            db.blobs_dir(),
            &ai_manifest.document_id,
            &ai_manifest.revision,
            undo_operation_id,
            &changed,
            &ai_result.appended_page_ids,
        )
        .unwrap_err();
        assert!(matches!(
            reused,
            VfsError::Conflict { key, .. } if key == "ink.operation_id_reused"
        ));
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &undone.document_id,)
                .unwrap(),
            undone,
        );
        assert_eq!(storage_counts(&conn), counts_after_undo);
    }

    #[test]
    fn duplicate_operation_returns_original_receipt_without_extra_storage_or_objects() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_document(&conn, &db);
        let mapping = freeze_render(&conn, &db, &original);
        let ops = operations(&original.pages[0].page_id);
        let (committed, _) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "apply-ai-ops-retry",
            &ops,
            &[mapping.clone()],
        )
        .unwrap();
        let receipt = committed.last_operation.clone();
        let counts_after_first = storage_counts(&conn);

        let (replayed, replay_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "apply-ai-ops-retry",
            &ops,
            &[mapping],
        )
        .unwrap();

        assert_eq!(replayed, committed);
        assert_eq!(replayed.last_operation, receipt);
        assert_eq!(replay_result.manifest, committed);
        assert_eq!(storage_counts(&conn), counts_after_first);
        let page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &committed.document_id,
            &original.pages[0].page_id,
        )
        .unwrap();
        assert_eq!(page.objects.len(), 2);
    }
}
