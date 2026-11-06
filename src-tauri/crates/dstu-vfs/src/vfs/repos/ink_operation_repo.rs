//! Atomic persistence for bounded AI operations on Ink documents.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use rusqlite::Connection;
use serde::Serialize;

use crate::vfs::{
    error::{VfsError, VfsResult},
    ink::{
        apply_operations,
        board_operations::{plan_board_apply, plan_board_undo, BoardOperationPlan},
        undo_operations, InkBoardChunk, InkBoardSurface, InkManifest, InkObject, InkObjectChange,
        InkOperation, InkOperationError, InkOperationErrorCode, InkOperationReceipt,
        InkOperationsResult, InkRect, InkRenderMapping, INK_BOARD_SCHEMA_VERSION,
    },
    repos::{
        ink_artifact_repo::VfsInkArtifactRepo, ink_board_repo::VfsInkBoardRepo,
        ink_repo::VfsInkRepo, VfsBlobRepo,
    },
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
    #[serde(skip_serializing_if = "Option::is_none")]
    z_index: Option<i64>,
}

/// Read-only board operation plan exposed to the app PREPARED path.
///
/// It deliberately contains no chunks, chunk ids, or page snapshots. The
/// commit re-runs planning and CAS validation; this preview only fixes the
/// trusted before/after objects (including board z-index) and the exact
/// operation input hash the receipt will later carry.
#[derive(Debug, Clone, PartialEq)]
pub struct InkBoardOperationPreview {
    pub document_id: String,
    pub expected_revision: String,
    pub input_hash: String,
    pub object_changes: Vec<InkObjectChange>,
    pub affected_page_ids: Vec<String>,
    pub appended_page_ids: Vec<String>,
}

pub struct VfsInkOperationRepo;

impl VfsInkOperationRepo {
    /// Preview board apply changes without writing.
    ///
    /// Uses one read snapshot (or the caller's existing transaction) to load the
    /// canonical manifest, prove the render mappings, load chunks one at a time
    /// and run the same planner as `apply_with_conn`. Planning-only chunk ids are
    /// discarded; the returned stable changes and `input_hash` are what the app
    /// persists as PREPARED before the real CAS commit.
    pub fn preview_board_operations_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        ops: &[InkOperation],
        mappings: &[InkRenderMapping],
    ) -> VfsResult<InkBoardOperationPreview> {
        let input_hash = hash_input(&ApplyInput {
            document_id,
            expected_revision,
            operations: ops,
            mappings,
        })?;
        let read_tx = if conn.is_autocommit() {
            Some(conn.unchecked_transaction()?)
        } else {
            None
        };
        let read_conn: &Connection = match read_tx.as_ref() {
            Some(tx) => &**tx,
            None => conn,
        };
        let manifest = VfsInkRepo::get_manifest_with_conn(read_conn, blobs_dir, document_id)?;
        if manifest.schema_version != INK_BOARD_SCHEMA_VERSION {
            return Err(conflict(
                "ink.format_conflict",
                "Ink document is not a v2 board",
            ));
        }
        if manifest.revision != expected_revision {
            return Err(conflict(
                OPERATION_UNKNOWN,
                "A stale revision cannot prove the board operation preview",
            ));
        }
        let plan = plan_board_apply_with_conn(read_conn, blobs_dir, &manifest, ops, mappings)?;
        Ok(InkBoardOperationPreview {
            document_id: manifest.document_id.clone(),
            expected_revision: expected_revision.to_owned(),
            input_hash,
            object_changes: plan.object_changes,
            affected_page_ids: plan.affected_page_ids,
            appended_page_ids: plan.appended_page_ids,
        })
    }

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

        if manifest.schema_version == INK_BOARD_SCHEMA_VERSION {
            return apply_board_with_conn(
                conn,
                blobs_dir,
                &manifest,
                expected_revision,
                operation_id,
                &input_hash,
                ops,
                mappings,
            );
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
                    z_index: change.z_index,
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

        if manifest.schema_version == INK_BOARD_SCHEMA_VERSION {
            return undo_board_with_conn(
                conn,
                blobs_dir,
                &manifest,
                expected_revision,
                operation_id,
                &input_hash,
                changes,
                appended_page_ids,
            );
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

fn board_surface_page_id(manifest: &InkManifest) -> VfsResult<String> {
    match manifest.surface.as_ref() {
        Some(InkBoardSurface::Board { page_id, .. }) => Ok(page_id.clone()),
        None => Err(render_provenance_conflict()),
    }
}

fn load_board_chunks(
    conn: &Connection,
    blobs_dir: &Path,
    manifest: &InkManifest,
) -> VfsResult<Vec<InkBoardChunk>> {
    let mut chunks = Vec::with_capacity(manifest.chunks.len());
    for chunk_ref in &manifest.chunks {
        let mut loaded = VfsInkBoardRepo::get_chunks_with_conn(
            conn,
            blobs_dir,
            &manifest.document_id,
            std::slice::from_ref(&chunk_ref.chunk_id),
        )?;
        if loaded.len() != 1 {
            return Err(VfsError::Internal(
                "Ink board chunk read did not return exactly one chunk".to_owned(),
            ));
        }
        chunks.push(loaded.remove(0));
    }
    Ok(chunks)
}

fn validate_board_render_mappings(
    conn: &Connection,
    blobs_dir: &Path,
    manifest: &InkManifest,
    mappings: &[InkRenderMapping],
) -> VfsResult<BTreeMap<String, InkRect>> {
    let surface_page_id = board_surface_page_id(manifest)?;
    let mut seen = BTreeSet::new();
    let mut crops = BTreeMap::new();
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
        let crop = artifact.crop.ok_or_else(render_provenance_conflict)?;
        if mapping.document_id != manifest.document_id
            || mapping.revision != manifest.revision
            || mapping.page_id != surface_page_id
            || artifact.page_id != surface_page_id
            || mapping.crop != crop
            || !crop.x.is_finite()
            || !crop.y.is_finite()
            || !crop.width.is_finite()
            || !crop.height.is_finite()
            || crop.width <= 0.0
            || crop.height <= 0.0
        {
            return Err(render_provenance_conflict());
        }
        crops.insert(mapping.render_id.clone(), crop);
    }
    Ok(crops)
}

fn plan_board_apply_with_conn(
    conn: &Connection,
    blobs_dir: &Path,
    manifest: &InkManifest,
    ops: &[InkOperation],
    mappings: &[InkRenderMapping],
) -> VfsResult<BoardOperationPlan> {
    if ops
        .iter()
        .any(|operation| matches!(operation, InkOperation::AppendBlankPage { .. }))
    {
        return Err(invalid_operations(
            "Ink board documents do not support append_blank_page",
        ));
    }
    let surface_page_id = board_surface_page_id(manifest)?;
    let crops = validate_board_render_mappings(conn, blobs_dir, manifest, mappings)?;
    let chunks = load_board_chunks(conn, blobs_dir, manifest)?;
    plan_board_apply(manifest, &surface_page_id, &chunks, ops, &crops).map_err(map_operation_error)
}

fn apply_board_with_conn(
    conn: &Connection,
    blobs_dir: &Path,
    manifest: &InkManifest,
    expected_revision: &str,
    operation_id: &str,
    input_hash: &str,
    ops: &[InkOperation],
    mappings: &[InkRenderMapping],
) -> VfsResult<(InkManifest, InkOperationsResult)> {
    let plan = plan_board_apply_with_conn(conn, blobs_dir, manifest, ops, mappings)?;
    let committed = VfsInkBoardRepo::save_chunks_with_receipt_with_conn(
        conn,
        blobs_dir,
        &manifest.document_id,
        expected_revision,
        operation_id,
        input_hash,
        &plan.changed_chunks,
        &plan.deleted_chunk_ids,
    )?;
    let result = InkOperationsResult {
        manifest: committed.clone(),
        pages: Vec::new(),
        affected_page_ids: plan.affected_page_ids,
        object_changes: plan.object_changes,
        appended_page_ids: plan.appended_page_ids,
    };
    Ok((committed, result))
}

fn undo_board_with_conn(
    conn: &Connection,
    blobs_dir: &Path,
    manifest: &InkManifest,
    expected_revision: &str,
    operation_id: &str,
    input_hash: &str,
    changes: &[InkObjectChange],
    appended_page_ids: &[String],
) -> VfsResult<(InkManifest, InkOperationsResult)> {
    let surface_page_id = board_surface_page_id(manifest)?;
    let chunks = load_board_chunks(conn, blobs_dir, manifest)?;
    let plan = plan_board_undo(
        manifest,
        &surface_page_id,
        &chunks,
        changes,
        appended_page_ids,
    )
    .map_err(map_operation_error)?;
    let committed = VfsInkBoardRepo::save_chunks_with_receipt_with_conn(
        conn,
        blobs_dir,
        &manifest.document_id,
        expected_revision,
        operation_id,
        input_hash,
        &plan.changed_chunks,
        &plan.deleted_chunk_ids,
    )?;
    let result = InkOperationsResult {
        manifest: committed.clone(),
        pages: Vec::new(),
        affected_page_ids: plan.affected_page_ids,
        object_changes: Vec::new(),
        appended_page_ids: Vec::new(),
    };
    Ok((committed, result))
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
    use std::collections::BTreeSet;

    use rusqlite::Connection;

    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        error::VfsError,
        ink::{
            InkAuthor, InkBoardChunk, InkBoardObject, InkBoardSurface, InkCoordinateSpace,
            InkNormalizedPoint, InkNormalizedRect, InkObject, InkObjectContent, InkOperation,
            InkOperationContent, InkRect, InkRenderMapping, InkRuling, InkSample, InkStrokeStyle,
            InkTool, INK_BOARD_SCHEMA_VERSION,
        },
        repos::{
            ink_artifact_repo::{InkArtifactDraft, VfsInkArtifactRepo},
            ink_board_repo::VfsInkBoardRepo,
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

    fn create_board(
        conn: &Connection,
        db: &VfsDatabase,
        operation_id: &str,
    ) -> crate::vfs::ink::InkManifest {
        VfsInkBoardRepo::create_blank_with_conn(
            conn,
            db.blobs_dir(),
            "AI board operations",
            InkRuling::Blank,
            operation_id,
            None,
        )
        .unwrap()
    }

    fn board_surface_page_id(manifest: &crate::vfs::ink::InkManifest) -> String {
        match manifest
            .surface
            .as_ref()
            .expect("a board manifest must expose a surface")
        {
            InkBoardSurface::Board { page_id, .. } => page_id.clone(),
        }
    }

    fn board_chunk(chunk_id: &str, objects: Vec<InkBoardObject>) -> InkBoardChunk {
        InkBoardChunk {
            schema_version: INK_BOARD_SCHEMA_VERSION,
            chunk_id: chunk_id.to_owned(),
            objects,
        }
    }

    fn save_board_chunk(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
        operation_id: &str,
        chunk: InkBoardChunk,
    ) -> crate::vfs::ink::InkManifest {
        VfsInkBoardRepo::save_chunks_with_conn(
            conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.revision,
            operation_id,
            &[chunk],
            &[],
        )
        .unwrap()
    }

    fn board_chunks(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
    ) -> Vec<InkBoardChunk> {
        let chunk_ids = manifest
            .chunks
            .iter()
            .map(|chunk_ref| chunk_ref.chunk_id.clone())
            .collect::<Vec<_>>();
        VfsInkBoardRepo::get_chunks_with_conn(
            conn,
            db.blobs_dir(),
            &manifest.document_id,
            &chunk_ids,
        )
        .unwrap()
    }

    fn board_objects(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
    ) -> Vec<InkBoardObject> {
        board_chunks(conn, db, manifest)
            .into_iter()
            .flat_map(|chunk| chunk.objects)
            .collect()
    }

    /// Build a `based_on_render_id` mapping from a real immutable signed-crop
    /// artifact. Negative world origins are accepted only while the artifact
    /// still names the canonical board document, surface page and revision.
    fn signed_board_render_mapping(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
        render_id: &str,
    ) -> InkRenderMapping {
        let crop = InkRect {
            x: -250.5,
            y: -300.25,
            width: 400.0,
            height: 500.0,
        };
        let artifact = VfsInkArtifactRepo::store_png_with_conn(
            conn,
            db.blobs_dir(),
            InkArtifactDraft {
                artifact_id: render_id.to_owned(),
                render_id: render_id.to_owned(),
                document_id: manifest.document_id.clone(),
                page_id: board_surface_page_id(manifest),
                revision: manifest.revision.clone(),
                source_hash: None,
                source_annotation_revision: None,
                conversion_revision: None,
                crop: Some(crop),
                width_px: 1,
                height_px: 1,
            },
            PNG_1X1,
        )
        .expect("a signed world crop must be accepted with real board provenance");
        InkRenderMapping {
            render_id: artifact.render_id,
            document_id: artifact.document_id,
            revision: artifact.revision,
            page_id: artifact.page_id,
            crop: artifact
                .crop
                .expect("a signed board render must retain its world crop"),
        }
    }

    fn board_human_object(object_id: &str, z_index: i64) -> InkBoardObject {
        InkBoardObject {
            id: object_id.to_owned(),
            author: InkAuthor::User,
            created_at: 1_800_000_000_000,
            z_index,
            content: InkObjectContent::Rect {
                rect: InkRect {
                    x: -500.0,
                    y: -500.0,
                    width: 10.0,
                    height: 10.0,
                },
                color: "#000000".to_owned(),
                width: 2.0,
            },
        }
    }

    fn board_text_rect(object: &InkBoardObject) -> InkRect {
        match &object.content {
            InkObjectContent::Text { rect, .. } => *rect,
            other => panic!("expected a board text object, got {other:?}"),
        }
    }

    fn board_shape_rect(object: &InkBoardObject) -> InkRect {
        match &object.content {
            InkObjectContent::Rect { rect, .. } => *rect,
            other => panic!("expected a board rect object, got {other:?}"),
        }
    }

    fn assert_rect_close(actual: InkRect, expected: InkRect, label: &str) {
        let close = |left: f64, right: f64| (left - right).abs() < 1e-9;
        assert!(
            close(actual.x, expected.x)
                && close(actual.y, expected.y)
                && close(actual.width, expected.width)
                && close(actual.height, expected.height),
            "{label}: expected {expected:?}, got {actual:?}"
        );
    }

    fn board_file_hashes(conn: &Connection, document_id: &str) -> (String, String, String) {
        conn.query_row(
            "SELECT f.blob_hash, f.sha256, r.hash
             FROM files f JOIN resources r ON r.id = f.resource_id
             WHERE f.id = ?1",
            [document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }

    fn assert_global_z_unique(objects: &[InkBoardObject]) {
        let mut seen = BTreeSet::new();
        for object in objects {
            assert!(
                seen.insert(object.z_index),
                "board object {} reuses z_index {} across chunks",
                object.id,
                object.z_index
            );
        }
    }

    fn assert_board_apply_rejected_without_mutation(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
        operation_id: &str,
        ops: &[InkOperation],
        mappings: &[InkRenderMapping],
    ) -> VfsError {
        let counts = storage_counts(conn);
        let chunks = board_chunks(conn, db, manifest);
        let error = VfsInkOperationRepo::apply_with_conn(
            conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.revision,
            operation_id,
            ops,
            mappings,
        )
        .expect_err("the board operation must be rejected");
        assert_eq!(storage_counts(conn), counts);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(conn, db.blobs_dir(), &manifest.document_id)
                .unwrap(),
            *manifest,
        );
        assert_eq!(board_chunks(conn, db, manifest), chunks);
        error
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

    #[test]
    fn board_render_crop_negative_origin_adds_text_and_rect_with_global_z_and_cas_receipt() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-op-create-text-rect");
        let human_object = board_human_object("human-prior-rect", 7);
        let human = save_board_chunk(
            &conn,
            &db,
            &created,
            "board-human-prior-save",
            board_chunk("chunk-human-prior", vec![human_object.clone()]),
        );
        let created = human;
        let page_id = board_surface_page_id(&created);
        let mapping = signed_board_render_mapping(&conn, &db, &created, "board-signed-render-1");
        let ops = [
            InkOperation::AddText {
                page_id: page_id.clone(),
                object_id: "board-ai-text-1".to_owned(),
                created_at: 1_800_000_000_010,
                coordinate_space: InkCoordinateSpace::RenderCrop,
                based_on_render_id: mapping.render_id.clone(),
                rect: InkNormalizedRect {
                    x: 0.1,
                    y: 0.2,
                    width: 0.4,
                    height: 0.1,
                },
                text: "board atomic note".to_owned(),
                font_size: 16.0,
                color: "#1f2937".to_owned(),
            },
            InkOperation::AddRect {
                page_id,
                object_id: "board-ai-rect-1".to_owned(),
                created_at: 1_800_000_000_011,
                coordinate_space: InkCoordinateSpace::RenderCrop,
                based_on_render_id: mapping.render_id.clone(),
                rect: InkNormalizedRect {
                    x: 0.5,
                    y: 0.4,
                    width: 0.25,
                    height: 0.5,
                },
                color: "#ef4444".to_owned(),
                width: 2.0,
            },
        ];

        let (committed, result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-apply-text-rect-cas",
            &ops,
            &[mapping.clone()],
        )
        .expect("board render_crop operations must apply through the real signed artifact");

        assert_ne!(committed.revision, created.revision);
        let receipt = committed
            .last_operation
            .as_ref()
            .expect("a board operation must commit a receipt");
        assert_eq!(receipt.operation_id, "board-apply-text-rect-cas");
        assert_eq!(
            receipt.previous_revision.as_deref(),
            Some(created.revision.as_str())
        );
        assert_eq!(receipt.result_revision, committed.revision);
        assert_eq!(result.manifest, committed);

        let objects = board_objects(&conn, &db, &committed);
        assert_global_z_unique(&objects);
        assert_eq!(
            objects
                .iter()
                .find(|object| object.id == "human-prior-rect")
                .expect("a prior human object must survive a board AI apply"),
            &human_object,
        );
        let text = objects
            .iter()
            .find(|object| object.id == "board-ai-text-1")
            .expect("the AI text must be stored in a whole board chunk");
        assert_eq!(text.author, InkAuthor::Ai);
        assert_rect_close(
            board_text_rect(text),
            InkRect {
                x: -210.5,
                y: -200.25,
                width: 160.0,
                height: 50.0,
            },
            "board render_crop text",
        );
        let rect = objects
            .iter()
            .find(|object| object.id == "board-ai-rect-1")
            .expect("the AI rect must be stored in a whole board chunk");
        assert_eq!(rect.author, InkAuthor::Ai);
        assert_rect_close(
            board_shape_rect(rect),
            InkRect {
                x: -50.5,
                y: -100.25,
                width: 100.0,
                height: 250.0,
            },
            "board render_crop rect",
        );

        let counts_after_commit = storage_counts(&conn);
        let (replayed, replay_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-apply-text-rect-cas",
            &ops,
            &[mapping],
        )
        .expect("an exact board operation retry must return the committed receipt");
        assert_eq!(replayed, committed);
        assert_eq!(replayed.last_operation, committed.last_operation);
        assert_eq!(replay_result.manifest, committed);
        assert_eq!(storage_counts(&conn), counts_after_commit);
        assert_eq!(board_objects(&conn, &db, &committed), objects);
    }

    #[test]
    fn board_append_blank_page_is_rejected_without_mutation() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-op-create-append-reject");
        let human = save_board_chunk(
            &conn,
            &db,
            &created,
            "board-human-before-append",
            board_chunk(
                "chunk-human-before-append",
                vec![board_human_object("human-prior-to-append", 2)],
            ),
        );
        let append = [InkOperation::AppendBlankPage {
            page_id: "board-appended-page".to_owned(),
            width: 100.0,
            height: 100.0,
            ruling: InkRuling::Blank,
        }];

        let error = assert_board_apply_rejected_without_mutation(
            &conn,
            &db,
            &human,
            "board-reject-append-page",
            &append,
            &[],
        );
        assert!(
            matches!(&error, VfsError::InvalidArgument { param, .. } if param.as_str() == "operations"),
            "board append_blank_page must be a typed invalid-operations rejection, got {error:?}"
        );
    }

    #[test]
    fn board_update_remove_require_current_render_and_revision_and_reject_stale_missing_or_unsupported_page(
    ) {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-op-create-update-remove");
        let human_object = board_human_object("human-prior-to-update", 3);
        let human = save_board_chunk(
            &conn,
            &db,
            &created,
            "board-human-before-update",
            board_chunk("chunk-human-before-update", vec![human_object.clone()]),
        );
        let page_id = board_surface_page_id(&human);
        let mapping = signed_board_render_mapping(&conn, &db, &human, "board-update-render-1");
        let initial = [
            InkOperation::AddText {
                page_id: page_id.clone(),
                object_id: "board-update-me".to_owned(),
                created_at: 1_800_000_000_020,
                coordinate_space: InkCoordinateSpace::RenderCrop,
                based_on_render_id: mapping.render_id.clone(),
                rect: InkNormalizedRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.2,
                    height: 0.1,
                },
                text: "initial AI text".to_owned(),
                font_size: 16.0,
                color: "#1f2937".to_owned(),
            },
            InkOperation::AddRect {
                page_id: page_id.clone(),
                object_id: "board-remove-me".to_owned(),
                created_at: 1_800_000_000_021,
                coordinate_space: InkCoordinateSpace::RenderCrop,
                based_on_render_id: mapping.render_id.clone(),
                rect: InkNormalizedRect {
                    x: 0.4,
                    y: 0.4,
                    width: 0.2,
                    height: 0.2,
                },
                color: "#22c55e".to_owned(),
                width: 2.0,
            },
        ];
        let (applied, _) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &human.document_id,
            &human.revision,
            "board-apply-update-remove-baseline",
            &initial,
            &[mapping],
        )
        .expect("the board update/remove baseline must apply through a current render");

        let update_mapping =
            signed_board_render_mapping(&conn, &db, &applied, "board-update-render-2");
        let update = [InkOperation::UpdateObject {
            page_id: page_id.clone(),
            object_id: "board-update-me".to_owned(),
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: update_mapping.render_id.clone(),
            content: InkOperationContent::Text {
                rect: InkNormalizedRect {
                    x: 0.2,
                    y: 0.3,
                    width: 0.3,
                    height: 0.1,
                },
                text: "updated AI text".to_owned(),
                font_size: 18.0,
                color: "#0f172a".to_owned(),
            },
        }];
        let (updated, _) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &applied.document_id,
            &applied.revision,
            "board-update-ai-object",
            &update,
            &[update_mapping.clone()],
        )
        .expect("a board update must be bound to a current render id and revision");

        let remove = [InkOperation::RemoveObject {
            page_id: page_id.clone(),
            object_id: "board-remove-me".to_owned(),
        }];
        let (removed, _) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &updated.document_id,
            &updated.revision,
            "board-remove-ai-object",
            &remove,
            &[],
        )
        .expect("a board remove must commit against the current revision");

        let objects = board_objects(&conn, &db, &removed);
        assert_eq!(
            objects
                .iter()
                .find(|object| object.id == "human-prior-to-update")
                .expect("a human object must survive board update/remove"),
            &human_object,
        );
        let updated_object = objects
            .iter()
            .find(|object| object.id == "board-update-me")
            .expect("the updated AI object must still exist");
        assert_eq!(updated_object.author, InkAuthor::Ai);
        match &updated_object.content {
            InkObjectContent::Text { text, .. } => assert_eq!(text, "updated AI text"),
            other => panic!("expected the updated board text object, got {other:?}"),
        }
        assert_rect_close(
            board_text_rect(updated_object),
            InkRect {
                x: -170.5,
                y: -150.25,
                width: 120.0,
                height: 50.0,
            },
            "board updated text",
        );
        assert!(
            !objects.iter().any(|object| object.id == "board-remove-me"),
            "the removed board object must not survive"
        );

        let current_mapping =
            signed_board_render_mapping(&conn, &db, &removed, "board-update-render-3");
        let stale = [InkOperation::AddText {
            page_id: page_id.clone(),
            object_id: "board-stale-text".to_owned(),
            created_at: 1_800_000_000_030,
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: update_mapping.render_id.clone(),
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.1,
            },
            text: "stale render text".to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        }];
        let error = assert_board_apply_rejected_without_mutation(
            &conn,
            &db,
            &removed,
            "board-reject-stale-render",
            &stale,
            &[update_mapping],
        );
        assert!(
            matches!(&error, VfsError::Conflict { key, .. } if key.as_str() == "ink.artifact.provenance_mismatch"),
            "a stale board render must fail as a provenance conflict, got {error:?}"
        );

        let missing = InkRenderMapping {
            render_id: "missing-board-render".to_owned(),
            ..current_mapping.clone()
        };
        let missing_ops = [InkOperation::AddText {
            page_id: page_id.clone(),
            object_id: "board-missing-render-text".to_owned(),
            created_at: 1_800_000_000_031,
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: missing.render_id.clone(),
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.1,
            },
            text: "missing render text".to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        }];
        let error = assert_board_apply_rejected_without_mutation(
            &conn,
            &db,
            &removed,
            "board-reject-missing-render",
            &missing_ops,
            &[missing],
        );
        assert!(
            matches!(&error, VfsError::Conflict { key, .. } if key.as_str() == "ink.artifact.provenance_mismatch"),
            "a missing board render must fail as a provenance conflict, got {error:?}"
        );

        let unsupported = [InkOperation::AddText {
            page_id: "not-the-board-surface-page".to_owned(),
            object_id: "board-unsupported-page-text".to_owned(),
            created_at: 1_800_000_000_032,
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: current_mapping.render_id.clone(),
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.1,
            },
            text: "unsupported page text".to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        }];
        let error = assert_board_apply_rejected_without_mutation(
            &conn,
            &db,
            &removed,
            "board-reject-unsupported-page",
            &unsupported,
            &[current_mapping],
        );
        assert!(
            matches!(&error, VfsError::InvalidArgument { param, .. } if param.as_str() == "operations"),
            "an unsupported board page must be a typed invalid-operations rejection, got {error:?}"
        );
    }

    #[test]
    fn board_undo_removes_only_ai_delta_and_rejects_edited_ai_object_without_mutation() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-op-create-undo");
        let human_before = board_human_object("human-before-board-ai", 1);
        let human = save_board_chunk(
            &conn,
            &db,
            &created,
            "board-human-before-ai",
            board_chunk("chunk-human-before-ai", vec![human_before.clone()]),
        );
        let page_id = board_surface_page_id(&human);
        let mapping = signed_board_render_mapping(&conn, &db, &human, "board-undo-render-1");
        let ops = [
            InkOperation::AddText {
                page_id: page_id.clone(),
                object_id: "board-ai-undone-text".to_owned(),
                created_at: 1_800_000_000_040,
                coordinate_space: InkCoordinateSpace::RenderCrop,
                based_on_render_id: mapping.render_id.clone(),
                rect: InkNormalizedRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.3,
                    height: 0.1,
                },
                text: "AI text to undo".to_owned(),
                font_size: 16.0,
                color: "#1f2937".to_owned(),
            },
            InkOperation::AddRect {
                page_id,
                object_id: "board-ai-undone-rect".to_owned(),
                created_at: 1_800_000_000_041,
                coordinate_space: InkCoordinateSpace::RenderCrop,
                based_on_render_id: mapping.render_id.clone(),
                rect: InkNormalizedRect {
                    x: 0.5,
                    y: 0.5,
                    width: 0.2,
                    height: 0.2,
                },
                color: "#ef4444".to_owned(),
                width: 2.0,
            },
        ];
        let (ai_manifest, ai_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &human.document_id,
            &human.revision,
            "board-apply-before-undo",
            &ops,
            &[mapping],
        )
        .expect("the board AI apply must commit before trusted undo");

        let later_human_object = board_human_object("human-later-independent", 50);
        let human_manifest = save_board_chunk(
            &conn,
            &db,
            &ai_manifest,
            "board-human-later-independent",
            board_chunk(
                "chunk-human-later-independent",
                vec![later_human_object.clone()],
            ),
        );
        let (undone, result) = VfsInkOperationRepo::undo_with_conn(
            &conn,
            db.blobs_dir(),
            &human_manifest.document_id,
            &human_manifest.revision,
            "board-undo-ai-apply",
            &ai_result.object_changes,
            &ai_result.appended_page_ids,
        )
        .expect("trusted board undo must remove only the recorded AI delta");

        assert_ne!(undone.revision, human_manifest.revision);
        assert_eq!(result.manifest, undone);
        let objects = board_objects(&conn, &db, &undone);
        assert_global_z_unique(&objects);
        assert_eq!(
            objects
                .iter()
                .find(|object| object.id == "human-before-board-ai")
                .expect("a human object that predates the AI apply must survive undo"),
            &human_before,
        );
        assert_eq!(
            objects
                .iter()
                .find(|object| object.id == "human-later-independent")
                .expect("a later human independent chunk must survive AI undo"),
            &later_human_object,
        );
        assert!(
            !objects
                .iter()
                .any(|object| object.id == "board-ai-undone-text"),
            "undo must remove the recorded AI text"
        );
        assert!(
            !objects
                .iter()
                .any(|object| object.id == "board-ai-undone-rect"),
            "undo must remove the recorded AI rect"
        );

        let edit_mapping = signed_board_render_mapping(&conn, &db, &undone, "board-undo-render-2");
        let edit_apply = [InkOperation::AddText {
            page_id: board_surface_page_id(&undone),
            object_id: "board-ai-edited-by-human".to_owned(),
            created_at: 1_800_000_000_050,
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: edit_mapping.render_id.clone(),
            rect: InkNormalizedRect {
                x: 0.2,
                y: 0.2,
                width: 0.2,
                height: 0.1,
            },
            text: "AI text later edited".to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        }];
        let (second_ai, second_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &undone.document_id,
            &undone.revision,
            "board-apply-before-human-edit",
            &edit_apply,
            &[edit_mapping],
        )
        .expect("the second board AI apply must commit before the human edit");

        let mut chunks = board_chunks(&conn, &db, &second_ai);
        let mut edited_chunk = chunks
            .drain(..)
            .find(|chunk| {
                chunk
                    .objects
                    .iter()
                    .any(|object| object.id == "board-ai-edited-by-human")
            })
            .expect("the AI object must be stored in a whole board chunk");
        let edited_object = edited_chunk
            .objects
            .iter_mut()
            .find(|object| object.id == "board-ai-edited-by-human")
            .unwrap();
        edited_object.content = InkObjectContent::Text {
            rect: InkRect {
                x: -200.0,
                y: -200.0,
                width: 40.0,
                height: 12.0,
            },
            text: "human changed this AI text".to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        };
        let human_edited_manifest = save_board_chunk(
            &conn,
            &db,
            &second_ai,
            "board-human-edit-ai-object",
            edited_chunk,
        );
        let counts_before = storage_counts(&conn);
        let chunks_before = board_chunks(&conn, &db, &human_edited_manifest);
        let error = VfsInkOperationRepo::undo_with_conn(
            &conn,
            db.blobs_dir(),
            &human_edited_manifest.document_id,
            &human_edited_manifest.revision,
            "board-undo-edited-ai-object",
            &second_result.object_changes,
            &second_result.appended_page_ids,
        )
        .expect_err("undo must reject an AI object edited after the AI operation");
        assert!(
            matches!(&error, VfsError::Conflict { key, .. } if key.as_str() == "ink.revision_conflict"),
            "an edited board AI target must fail as a typed revision conflict, got {error:?}"
        );
        assert_eq!(storage_counts(&conn), counts_before);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(
                &conn,
                db.blobs_dir(),
                &human_edited_manifest.document_id,
            )
            .unwrap(),
            human_edited_manifest,
        );
        assert_eq!(
            board_chunks(&conn, &db, &human_edited_manifest),
            chunks_before,
        );
    }

    #[test]
    fn board_add_at_chunk_limit_reuses_existing_whole_chunk_slack() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-op-create-chunk-cap");
        let chunks = (0..256)
            .map(|index| {
                board_chunk(
                    &format!("chunk-cap-{index:03}"),
                    vec![board_human_object(
                        &format!("board-cap-prior-{index}"),
                        index as i64,
                    )],
                )
            })
            .collect::<Vec<_>>();
        let full = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-fill-256-chunks",
            &chunks,
            &[],
        )
        .unwrap();
        assert_eq!(full.chunks.len(), 256);
        let before_ids: BTreeSet<String> = full
            .chunks
            .iter()
            .map(|chunk_ref| chunk_ref.chunk_id.clone())
            .collect();
        let mapping = signed_board_render_mapping(&conn, &db, &full, "board-render-at-cap");
        let page_id = board_surface_page_id(&full);
        let add = [InkOperation::AddText {
            page_id,
            object_id: "board-ai-at-cap".to_owned(),
            created_at: 1_800_000_000_060,
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: mapping.render_id.clone(),
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.1,
            },
            text: "board add at chunk cap".to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        }];

        let (committed, _) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &full.document_id,
            &full.revision,
            "board-add-at-chunk-cap",
            &add,
            &[mapping],
        )
        .expect("a board with whole-object slack must reuse a chunk instead of exceeding 256");

        assert_eq!(
            committed.chunks.len(),
            256,
            "a new AI object must be packed into an existing whole chunk at the chunk limit"
        );
        let after_ids: BTreeSet<String> = committed
            .chunks
            .iter()
            .map(|chunk_ref| chunk_ref.chunk_id.clone())
            .collect();
        assert_eq!(
            after_ids, before_ids,
            "reuse must not invent a 257th chunk id"
        );
        let after_chunks = board_chunks(&conn, &db, &committed);
        assert!(
            after_chunks.iter().any(|chunk| chunk.objects.len() == 2),
            "at least one existing chunk must gain the whole AI object"
        );
        let objects = board_objects(&conn, &db, &committed);
        assert_eq!(objects.len(), 257);
        assert!(objects.iter().any(|object| object.id == "board-ai-at-cap"));
        assert_global_z_unique(&objects);
    }

    #[test]
    fn board_undo_restored_z_taken_by_later_human_is_typed_revision_conflict_without_writes() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-op-create-z-collision");
        let target = board_human_object("human-h-z5", 5);
        let seeded = save_board_chunk(
            &conn,
            &db,
            &created,
            "board-seed-h-z5",
            board_chunk("chunk-human-h-z5", vec![target]),
        );
        let remove = [InkOperation::RemoveObject {
            page_id: board_surface_page_id(&seeded),
            object_id: "human-h-z5".to_owned(),
        }];
        let (ai_manifest, ai_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &seeded.document_id,
            &seeded.revision,
            "board-ai-remove-h-z5",
            &remove,
            &[],
        )
        .expect("AI remove of a non-stroke board object must commit");
        assert!(ai_result.object_changes.iter().any(|change| {
            change.object_id == "human-h-z5"
                && change.before.is_some()
                && change.after.is_none()
                && change.z_index == Some(5)
        }));
        assert!(!board_objects(&conn, &db, &ai_manifest)
            .iter()
            .any(|object| object.id == "human-h-z5"));

        let later_human = board_human_object("human-b-z5", 5);
        let human_manifest = save_board_chunk(
            &conn,
            &db,
            &ai_manifest,
            "board-human-b-reuses-z5",
            board_chunk("chunk-human-b-z5", vec![later_human]),
        );
        let counts_before = storage_counts(&conn);
        let manifest_before =
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &human_manifest.document_id)
                .unwrap();
        let chunks_before = board_chunks(&conn, &db, &human_manifest);
        let hashes_before = board_file_hashes(&conn, &human_manifest.document_id);

        let error = VfsInkOperationRepo::undo_with_conn(
            &conn,
            db.blobs_dir(),
            &human_manifest.document_id,
            &human_manifest.revision,
            "board-undo-h-after-human-z5",
            &ai_result.object_changes,
            &ai_result.appended_page_ids,
        )
        .expect_err("undo must reject a restore whose receipt z was taken by a later human");
        assert!(
            matches!(&error, VfsError::Conflict { key, .. } if key.as_str() == "ink.revision_conflict"),
            "a later human z claim must be a typed revision conflict, got {error:?}"
        );
        assert_eq!(storage_counts(&conn), counts_before);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &human_manifest.document_id)
                .unwrap(),
            manifest_before,
        );
        assert_eq!(board_chunks(&conn, &db, &human_manifest), chunks_before);
        assert_eq!(
            board_file_hashes(&conn, &human_manifest.document_id),
            hashes_before,
        );
        let objects = board_objects(&conn, &db, &human_manifest);
        assert!(objects
            .iter()
            .any(|object| object.id == "human-b-z5" && object.z_index == 5));
        assert!(!objects.iter().any(|object| object.id == "human-h-z5"));
    }

    #[test]
    fn board_preview_matches_apply_changes_and_receipt_hash_without_writes() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-op-preview-create");
        let human = save_board_chunk(
            &conn,
            &db,
            &created,
            "board-preview-human",
            board_chunk(
                "chunk-preview-human",
                vec![board_human_object("human-preview-prior", 7)],
            ),
        );
        let page_id = board_surface_page_id(&human);
        let mapping = signed_board_render_mapping(&conn, &db, &human, "board-preview-render");
        let ops = [
            InkOperation::AddText {
                page_id: page_id.clone(),
                object_id: "board-preview-text".to_owned(),
                created_at: 1_800_000_000_070,
                coordinate_space: InkCoordinateSpace::RenderCrop,
                based_on_render_id: mapping.render_id.clone(),
                rect: InkNormalizedRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.3,
                    height: 0.1,
                },
                text: "preview text".to_owned(),
                font_size: 16.0,
                color: "#1f2937".to_owned(),
            },
            InkOperation::AddRect {
                page_id: page_id.clone(),
                object_id: "board-preview-rect".to_owned(),
                created_at: 1_800_000_000_071,
                coordinate_space: InkCoordinateSpace::RenderCrop,
                based_on_render_id: mapping.render_id.clone(),
                rect: InkNormalizedRect {
                    x: 0.5,
                    y: 0.5,
                    width: 0.2,
                    height: 0.2,
                },
                color: "#ef4444".to_owned(),
                width: 2.0,
            },
        ];
        let counts_before = storage_counts(&conn);
        let manifest_before =
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &human.document_id).unwrap();
        let chunks_before = board_chunks(&conn, &db, &human);
        let hashes_before = board_file_hashes(&conn, &human.document_id);

        let preview = VfsInkOperationRepo::preview_board_operations_with_conn(
            &conn,
            db.blobs_dir(),
            &human.document_id,
            &human.revision,
            &ops,
            &[mapping.clone()],
        )
        .expect("board preview must return a read-only trusted plan");

        assert_eq!(storage_counts(&conn), counts_before);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &human.document_id).unwrap(),
            manifest_before,
        );
        assert_eq!(board_chunks(&conn, &db, &human), chunks_before);
        assert_eq!(board_file_hashes(&conn, &human.document_id), hashes_before);
        assert_eq!(preview.document_id, human.document_id);
        assert_eq!(preview.expected_revision, human.revision);
        assert_eq!(preview.affected_page_ids, vec![page_id.clone()]);
        assert!(preview.appended_page_ids.is_empty());
        assert_eq!(preview.object_changes.len(), 2);
        for change in &preview.object_changes {
            assert!(
                change.z_index.is_some(),
                "board preview changes must carry trusted z-index"
            );
            for object in [change.before.as_ref(), change.after.as_ref()]
                .into_iter()
                .flatten()
            {
                assert!(
                    !matches!(&object.content, InkObjectContent::Stroke { .. }),
                    "board preview must not expose raw stroke sample arrays"
                );
            }
        }

        let (committed, applied) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &human.document_id,
            &human.revision,
            "board-apply-after-preview",
            &ops,
            &[mapping],
        )
        .unwrap();
        assert_eq!(preview.object_changes, applied.object_changes);
        assert_eq!(preview.affected_page_ids, applied.affected_page_ids);
        assert_eq!(
            preview.input_hash,
            committed
                .last_operation
                .as_ref()
                .expect("apply must commit a receipt")
                .input_hash,
        );
    }

    #[test]
    fn board_preview_rejects_stale_and_missing_artifacts_without_writes() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-op-preview-reject");
        let seeded = save_board_chunk(
            &conn,
            &db,
            &created,
            "board-preview-seed",
            board_chunk(
                "chunk-preview-seed",
                vec![board_human_object("human-preview-seed", 8)],
            ),
        );
        let stale_mapping =
            signed_board_render_mapping(&conn, &db, &seeded, "board-preview-stale-render");
        let current = save_board_chunk(
            &conn,
            &db,
            &seeded,
            "board-preview-advance",
            board_chunk(
                "chunk-preview-advance",
                vec![board_human_object("human-preview-later", 51)],
            ),
        );
        let page_id = board_surface_page_id(&current);
        let stale_ops = [InkOperation::AddText {
            page_id: page_id.clone(),
            object_id: "board-preview-stale-text".to_owned(),
            created_at: 1_800_000_000_072,
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: stale_mapping.render_id.clone(),
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.1,
            },
            text: "stale preview text".to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        }];
        let counts_before = storage_counts(&conn);
        let manifest_before =
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &current.document_id)
                .unwrap();
        let chunks_before = board_chunks(&conn, &db, &current);
        let hashes_before = board_file_hashes(&conn, &current.document_id);

        let error = VfsInkOperationRepo::preview_board_operations_with_conn(
            &conn,
            db.blobs_dir(),
            &current.document_id,
            &current.revision,
            &stale_ops,
            &[stale_mapping.clone()],
        )
        .expect_err("a stale board render must be rejected before preview");
        assert!(
            matches!(&error, VfsError::Conflict { key, .. } if key.as_str() == "ink.artifact.provenance_mismatch"),
            "stale preview render must be a typed provenance conflict, got {error:?}"
        );
        assert_eq!(storage_counts(&conn), counts_before);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &current.document_id)
                .unwrap(),
            manifest_before,
        );
        assert_eq!(board_chunks(&conn, &db, &current), chunks_before);
        assert_eq!(
            board_file_hashes(&conn, &current.document_id),
            hashes_before
        );

        let missing = InkRenderMapping {
            render_id: "missing-preview-render".to_owned(),
            revision: current.revision.clone(),
            ..stale_mapping.clone()
        };
        let missing_ops = [InkOperation::AddText {
            page_id,
            object_id: "board-preview-missing-text".to_owned(),
            created_at: 1_800_000_000_073,
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: missing.render_id.clone(),
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.1,
            },
            text: "missing preview text".to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        }];
        let error = VfsInkOperationRepo::preview_board_operations_with_conn(
            &conn,
            db.blobs_dir(),
            &current.document_id,
            &current.revision,
            &missing_ops,
            &[missing],
        )
        .expect_err("a missing board render must be rejected before preview");
        assert!(
            matches!(&error, VfsError::Conflict { key, .. } if key.as_str() == "ink.artifact.provenance_mismatch"),
            "missing preview render must be a typed provenance conflict, got {error:?}"
        );
        assert_eq!(storage_counts(&conn), counts_before);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &current.document_id)
                .unwrap(),
            manifest_before,
        );
        assert_eq!(board_chunks(&conn, &db, &current), chunks_before);
        assert_eq!(
            board_file_hashes(&conn, &current.document_id),
            hashes_before
        );
    }

    #[test]
    fn board_undo_reinsert_at_chunk_limit_reuses_slack_without_257th_chunk() {
        let (_temp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-op-preview-undo-cap");
        let chunks = (0..256)
            .map(|index| {
                board_chunk(
                    &format!("chunk-cap-{index:03}"),
                    vec![board_human_object(
                        &format!("board-cap-prior-{index}"),
                        index as i64,
                    )],
                )
            })
            .collect::<Vec<_>>();
        let full = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-fill-256-chunks-for-undo",
            &chunks,
            &[],
        )
        .unwrap();
        let mapping = signed_board_render_mapping(&conn, &db, &full, "board-render-undo-at-cap");
        let page_id = board_surface_page_id(&full);
        let add = [InkOperation::AddText {
            page_id: page_id.clone(),
            object_id: "board-ai-undo-at-cap".to_owned(),
            created_at: 1_800_000_000_080,
            coordinate_space: InkCoordinateSpace::RenderCrop,
            based_on_render_id: mapping.render_id.clone(),
            rect: InkNormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.1,
            },
            text: "board undo at cap".to_owned(),
            font_size: 16.0,
            color: "#1f2937".to_owned(),
        }];
        let (added, _) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &full.document_id,
            &full.revision,
            "board-add-before-undo-at-cap",
            &add,
            &[mapping],
        )
        .unwrap();
        assert_eq!(added.chunks.len(), 256);
        let added_objects = board_objects(&conn, &db, &added);
        let ai_object = added_objects
            .iter()
            .find(|object| object.id == "board-ai-undo-at-cap")
            .expect("the AI add must reuse a whole chunk")
            .clone();
        assert_eq!(ai_object.z_index, 256);
        let ai_chunk_id = board_chunks(&conn, &db, &added)
            .into_iter()
            .find(|chunk| {
                chunk
                    .objects
                    .iter()
                    .any(|object| object.id == "board-ai-undo-at-cap")
            })
            .expect("the AI object must live in a whole chunk")
            .chunk_id;

        let remove = [InkOperation::RemoveObject {
            page_id,
            object_id: "board-ai-undo-at-cap".to_owned(),
        }];
        let (removed, remove_result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            db.blobs_dir(),
            &added.document_id,
            &added.revision,
            "board-remove-before-undo-at-cap",
            &remove,
            &[],
        )
        .unwrap();
        assert_eq!(removed.chunks.len(), 256);
        assert!(remove_result.object_changes.iter().any(|change| {
            change.object_id == "board-ai-undo-at-cap"
                && change.before.is_some()
                && change.after.is_none()
                && change.z_index == Some(256)
        }));
        let after_remove_chunks = board_chunks(&conn, &db, &removed);
        let ai_chunk = after_remove_chunks
            .iter()
            .find(|chunk| chunk.chunk_id == ai_chunk_id)
            .expect("the previously reused chunk must remain");
        assert!(
            !ai_chunk.objects.is_empty(),
            "AI remove must leave prior human objects in the reused chunk"
        );

        let mut later_chunk = ai_chunk.clone();
        let later_human = board_human_object("human-later-at-cap", 257);
        later_chunk.objects.push(later_human.clone());
        let human_manifest = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &removed.document_id,
            &removed.revision,
            "board-human-later-at-cap",
            &[later_chunk],
            &[],
        )
        .unwrap();
        assert_eq!(human_manifest.chunks.len(), 256);
        let before_ids: BTreeSet<String> = human_manifest
            .chunks
            .iter()
            .map(|chunk_ref| chunk_ref.chunk_id.clone())
            .collect();
        let before_objects = board_objects(&conn, &db, &human_manifest);
        assert!(!before_objects
            .iter()
            .any(|object| object.id == "board-ai-undo-at-cap"));
        assert!(before_objects
            .iter()
            .any(|object| object.id == "human-later-at-cap" && object.z_index == 257));

        let (undone, result) = VfsInkOperationRepo::undo_with_conn(
            &conn,
            db.blobs_dir(),
            &human_manifest.document_id,
            &human_manifest.revision,
            "board-undo-reinsert-at-cap",
            &remove_result.object_changes,
            &remove_result.appended_page_ids,
        )
        .expect("undo reinsert must reuse whole-chunk slack instead of creating a 257th chunk");

        assert!(
            result.object_changes.is_empty(),
            "board undo must not fabricate apply object changes"
        );
        assert!(
            result.appended_page_ids.is_empty(),
            "board undo must not append pages"
        );
        assert_eq!(undone.chunks.len(), 256);
        let after_ids: BTreeSet<String> = undone
            .chunks
            .iter()
            .map(|chunk_ref| chunk_ref.chunk_id.clone())
            .collect();
        assert_eq!(
            after_ids, before_ids,
            "undo must not invent a 257th chunk id"
        );
        let objects = board_objects(&conn, &db, &undone);
        assert_eq!(objects.len(), 258);
        for index in 0..256 {
            let object = objects
                .iter()
                .find(|object| object.id == format!("board-cap-prior-{index}"))
                .expect("every prior human object must survive");
            assert_eq!(object.z_index, index as i64);
        }
        assert_eq!(
            objects
                .iter()
                .find(|object| object.id == "board-ai-undo-at-cap")
                .expect("undo must restore the AI object"),
            &ai_object,
        );
        assert_eq!(
            objects
                .iter()
                .find(|object| object.id == "human-later-at-cap")
                .expect("a later human object must survive undo"),
            &later_human,
        );
        assert_global_z_unique(&objects);
    }
}
