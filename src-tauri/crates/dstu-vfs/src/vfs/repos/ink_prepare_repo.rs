//! Prepare source files into fixed Ink page backgrounds.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs::File,
    io::Read,
    path::{Component, Path},
};

use crate::vfs::{
    error::{VfsError, VfsResult},
    ink::{
        validate_manifest, validate_page, InkBackground, InkManifest, InkOperationReceipt, InkPage,
        InkPageRef, InkSource, INK_SCHEMA_VERSION, INK_TITLE_MAX_CHARS,
    },
    repos::{
        blob_repo::VfsBlobRepo,
        ink_artifact_repo::validate_png_bytes,
        ink_repo::VfsInkRepo,
        ink_source::{ink_source_format, validate_ink_source_with_conn, InkSourceIdentity},
    },
    upload_saga::with_savepoint,
};

const SOURCE_CHANGED: &str = "ink.source_changed";
const PNG_MAX_BYTES: usize = 4 * 1024 * 1024;
const PNG_MAX_DIMENSION: u32 = 16_384;
const PNG_MAX_DECODED_BYTES: u64 = 64 * 1024 * 1024;
const PREPARE_TITLE: &str = "Prepared source";

/// Metadata for one trusted, already-stored fixed PNG page background.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InkPreparedPage {
    pub width: f64,
    pub height: f64,
    pub background_blob_hash: String,
    pub source_page_index: Option<u32>,
}

#[derive(Serialize)]
struct PreparedOperationInput<'a> {
    source_resource_id: &'a str,
    source_hash: &'a str,
    conversion_revision: &'a str,
    pages: &'a [InkPreparedPage],
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceFormat {
    Pdf,
    Image,
    Office,
}

struct SourceFile {
    identity: InkSourceIdentity,
    format: SourceFormat,
}

enum ReusablePreparedManifest {
    Reuse(InkManifest),
    Rebuild { stale_document_id: Option<String> },
}

pub struct VfsInkPrepareRepo;

impl VfsInkPrepareRepo {
    /// Read-only reuse check for a source's default Ink target.
    ///
    /// Returns `None` when the target is missing or soft-deleted; an active
    /// target is returned only when its manifest matches the source identity,
    /// and any corrupt or mismatched active target is rejected.
    pub fn reusable_prepared_manifest_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        source_resource_id: &str,
        expected_source_hash: &str,
        conversion_revision: &str,
    ) -> VfsResult<Option<InkManifest>> {
        validate_identifier("source_resource_id", source_resource_id)?;
        validate_identifier("conversion_revision", conversion_revision)?;
        validate_hash(expected_source_hash)?;
        let identity = validate_ink_source_with_conn(
            conn,
            blobs_dir,
            source_resource_id,
            Some(expected_source_hash),
        )?
        .ok_or_else(|| source_changed("Source resource is missing"))?;
        let metadata = parse_metadata(identity.metadata_json.as_deref())?;
        match reusable_prepared_manifest_for_source(
            conn,
            blobs_dir,
            source_resource_id,
            expected_source_hash,
            conversion_revision,
            &metadata,
        )? {
            ReusablePreparedManifest::Reuse(manifest) => Ok(Some(manifest)),
            ReusablePreparedManifest::Rebuild { .. } => Ok(None),
        }
    }

    /// Persist renderer-produced PNG page backgrounds in one canonical Ink document.
    pub fn prepare_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        source_resource_id: &str,
        expected_source_hash: &str,
        conversion_revision: &str,
        pages: &[InkPreparedPage],
        operation_id: &str,
        folder_id: Option<&str>,
    ) -> VfsResult<InkManifest> {
        validate_identifier("source_resource_id", source_resource_id)?;
        validate_identifier("conversion_revision", conversion_revision)?;
        validate_identifier("operation_id", operation_id)?;
        if folder_id.is_some_and(|id| !valid_identifier(id)) {
            return Err(invalid_prepare("folder_id", "Folder identifier is invalid"));
        }
        validate_hash(expected_source_hash)?;
        if !(1..=500).contains(&pages.len()) {
            return Err(invalid_prepare(
                "pages",
                "Prepared pages must contain between 1 and 500 pages",
            ));
        }

        let guard = VfsInkRepo::acquire_mutation_guard(conn)?;
        with_savepoint(conn, "ink_prepare", || {
            // Reserve the SQLite writer before inspecting the source or its default document.
            let locked = conn.execute(
                "UPDATE resources SET hash = hash WHERE id = ?1",
                [source_resource_id],
            )?;
            if locked != 1 {
                return Err(source_changed("Source resource is missing"));
            }
            let source = load_source(conn, blobs_dir, source_resource_id, expected_source_hash)?;
            validate_page_inputs(conn, blobs_dir, &source, pages)?;

            let mut metadata = parse_metadata(source.identity.metadata_json.as_deref())?;
            let stale_document_id = match reusable_prepared_manifest_for_source(
                conn,
                blobs_dir,
                source_resource_id,
                expected_source_hash,
                conversion_revision,
                &metadata,
            )? {
                ReusablePreparedManifest::Reuse(manifest) => {
                    verify_source_unchanged(conn, blobs_dir, &source, expected_source_hash)?;
                    return Ok(manifest);
                }
                ReusablePreparedManifest::Rebuild { stale_document_id } => stale_document_id,
            };

            let create_operation_id = derived_operation_id(
                "prepare-create",
                source_resource_id,
                operation_id,
                stale_document_id.as_deref(),
            );
            let title = prepared_title(&source.identity.file_name);
            let initial = VfsInkRepo::create_blank_with_guard(
                conn,
                blobs_dir,
                &title,
                crate::vfs::ink::InkRuling::Blank,
                100.0,
                100.0,
                &create_operation_id,
                folder_id,
                &guard,
            )?;
            let mut manifest = initial.clone();
            manifest.source = InkSource::Resource {
                resource_id: source_resource_id.to_owned(),
                source_hash: expected_source_hash.to_owned(),
                conversion_revision: conversion_revision.to_owned(),
            };

            let mut page_bodies = Vec::with_capacity(pages.len());
            manifest.pages.clear();
            for (index, prepared) in pages.iter().enumerate() {
                let page = InkPage {
                    schema_version: INK_SCHEMA_VERSION,
                    page_id: format!("p_{}", nanoid::nanoid!(12)),
                    objects: Vec::new(),
                };
                let page_bytes = serde_json::to_vec(&page)
                    .map_err(|error| VfsError::Serialization(error.to_string()))?;
                let page_hash = VfsBlobRepo::compute_hash(&page_bytes);
                let background = match source.format {
                    SourceFormat::Pdf => InkBackground::PdfPage {
                        blob_hash: prepared.background_blob_hash.clone(),
                        source_page_index: prepared
                            .source_page_index
                            .expect("validated PDF page index"),
                    },
                    SourceFormat::Image | SourceFormat::Office => InkBackground::Image {
                        blob_hash: prepared.background_blob_hash.clone(),
                    },
                };
                let page_ref = InkPageRef {
                    page_id: page.page_id.clone(),
                    width: prepared.width,
                    height: prepared.height,
                    background,
                    page_blob_hash: page_hash,
                };
                validate_page(&page, &page_ref).map_err(map_ink_error)?;
                page_bodies.push(page);
                manifest.pages.push(page_ref);
                let _ = index;
            }
            manifest.revision = format!("r_{}", nanoid::nanoid!(16));
            let commit_operation_id = derived_operation_id(
                "prepare-commit",
                source_resource_id,
                operation_id,
                stale_document_id.as_deref(),
            );
            let input_hash = VfsBlobRepo::compute_hash(
                &serde_json::to_vec(&PreparedOperationInput {
                    source_resource_id,
                    source_hash: expected_source_hash,
                    conversion_revision,
                    pages,
                })
                .map_err(|error| VfsError::Serialization(error.to_string()))?,
            );
            manifest.last_operation = Some(InkOperationReceipt {
                operation_id: commit_operation_id.clone(),
                input_hash,
                previous_revision: Some(initial.revision.clone()),
                result_revision: manifest.revision.clone(),
            });
            validate_manifest(&manifest).map_err(map_ink_error)?;

            let committed = VfsInkRepo::commit_document_with_guard(
                conn,
                blobs_dir,
                &initial.document_id,
                &initial.revision,
                &commit_operation_id,
                manifest,
                &page_bodies,
                &guard,
            )?;

            verify_source_unchanged(conn, blobs_dir, &source, expected_source_hash)?;
            metadata["default_ink_document_id"] = Value::String(committed.document_id.clone());
            let metadata_json = serde_json::to_string(&metadata)
                .map_err(|error| VfsError::Serialization(error.to_string()))?;
            let changed = conn.execute(
                "UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3 AND hash = ?4 AND source_id = ?5 AND source_table = 'files'",
                params![
                    metadata_json,
                    chrono::Utc::now().timestamp_millis(),
                    source_resource_id,
                    source.identity.resource_hash,
                    source.identity.file_id,
                ],
            )?;
            if changed != 1 {
                return Err(source_changed(
                    "Source changed before prepared document was committed",
                ));
            }
            Ok(committed)
        })
    }
}

fn reusable_prepared_manifest_for_source(
    conn: &Connection,
    blobs_dir: &Path,
    source_resource_id: &str,
    expected_source_hash: &str,
    conversion_revision: &str,
    metadata: &Value,
) -> VfsResult<ReusablePreparedManifest> {
    let pointer = match metadata.get("default_ink_document_id") {
        Some(pointer) if !pointer.is_null() => pointer,
        _ => {
            tracing::info!(
                phase = "ink_prepare_reuse",
                state = "default_target_missing",
                reason = "default_pointer_absent",
                source_resource_id = %source_resource_id,
                "No reusable default Ink target"
            );
            return Ok(ReusablePreparedManifest::Rebuild {
                stale_document_id: None,
            });
        }
    };
    let document_id = pointer
        .as_str()
        .filter(|id| valid_identifier(id))
        .ok_or_else(|| {
            tracing::warn!(
                phase = "ink_prepare_reuse",
                state = "active_target_invalid",
                reason = "default_pointer_invalid",
                source_resource_id = %source_resource_id,
                "Default Ink pointer is invalid"
            );
            source_changed("Source default Ink document pointer is invalid")
        })?;

    let target = conn
        .query_row(
            "SELECT f.status, f.deleted_at IS NOT NULL, r.deleted_at IS NOT NULL FROM files f LEFT JOIN resources r ON r.id = f.resource_id WHERE f.id = ?1",
            [document_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<bool>>(1)?,
                    row.get::<_, Option<bool>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((status, file_deleted_at, resource_deleted_at)) = target else {
        tracing::info!(
            phase = "ink_prepare_reuse",
            state = "default_target_missing",
            reason = "target_row_missing",
            source_resource_id = %source_resource_id,
            document_id = %document_id,
            "Default Ink target no longer exists"
        );
        return Ok(ReusablePreparedManifest::Rebuild {
            stale_document_id: Some(document_id.to_owned()),
        });
    };
    if status.as_deref() == Some("deleted")
        || file_deleted_at == Some(true)
        || resource_deleted_at == Some(true)
    {
        let reason = if status.as_deref() == Some("deleted") {
            "file_status_deleted"
        } else if file_deleted_at == Some(true) {
            "file_deleted_at"
        } else {
            "resource_deleted_at"
        };
        tracing::info!(
            phase = "ink_prepare_reuse",
            state = "default_target_deleted",
            reason = %reason,
            source_resource_id = %source_resource_id,
            document_id = %document_id,
            "Default Ink target was explicitly soft-deleted"
        );
        return Ok(ReusablePreparedManifest::Rebuild {
            stale_document_id: Some(document_id.to_owned()),
        });
    }
    if status.as_deref() != Some("active") {
        tracing::warn!(
            phase = "ink_prepare_reuse",
            state = "active_target_invalid",
            reason = "target_status_invalid",
            source_resource_id = %source_resource_id,
            document_id = %document_id,
            "Default Ink target has an unsupported lifecycle status"
        );
        return Err(source_changed(
            "Source default Ink document is neither active nor deleted",
        ));
    }

    let manifest = match VfsInkRepo::get_manifest_with_conn(conn, blobs_dir, document_id) {
        Ok(manifest) => manifest,
        Err(error) => {
            tracing::warn!(
                phase = "ink_prepare_reuse",
                state = "active_target_invalid",
                reason = %safe_vfs_reason(&error),
                source_resource_id = %source_resource_id,
                document_id = %document_id,
                "Active default Ink target cannot be reopened"
            );
            return Err(source_changed(
                "Source default Ink document cannot be reopened",
            ));
        }
    };
    match &manifest.source {
        InkSource::Resource {
            resource_id,
            source_hash,
            conversion_revision: existing_revision,
        } if resource_id == source_resource_id
            && source_hash == expected_source_hash
            && existing_revision == conversion_revision =>
        {
            Ok(ReusablePreparedManifest::Reuse(manifest))
        }
        InkSource::Resource {
            resource_id,
            source_hash,
            ..
        } if resource_id == source_resource_id && source_hash != expected_source_hash => {
            tracing::warn!(
                phase = "ink_prepare_reuse",
                state = "active_target_invalid",
                reason = "source_hash_mismatch",
                source_resource_id = %source_resource_id,
                document_id = %document_id,
                "Active default Ink target belongs to a different source hash"
            );
            Err(source_changed(
                "Source hash differs from its prepared Ink document",
            ))
        }
        _ => {
            tracing::warn!(
                phase = "ink_prepare_reuse",
                state = "active_target_invalid",
                reason = "source_identity_mismatch",
                source_resource_id = %source_resource_id,
                document_id = %document_id,
                "Active default Ink target has a different source or converter profile"
            );
            Err(source_changed(
                "The default prepared Ink document has a different source or converter profile",
            ))
        }
    }
}

fn safe_vfs_reason(error: &VfsError) -> String {
    match error {
        VfsError::Conflict { key, .. } => key.clone(),
        _ => error.stable_code().to_owned(),
    }
}

fn load_source(
    conn: &Connection,
    blobs_dir: &Path,
    resource_id: &str,
    expected_hash: &str,
) -> VfsResult<SourceFile> {
    let identity =
        validate_ink_source_with_conn(conn, blobs_dir, resource_id, Some(expected_hash))?
            .ok_or_else(|| source_changed("Source resource is missing"))?;
    if VfsInkRepo::is_ink_file_candidate_with_conn(conn, &identity.file_id)? {
        return Err(unsupported_source(
            "An Ink document cannot be prepared as a source",
        ));
    }
    let mime = identity
        .mime_type
        .as_deref()
        .ok_or_else(|| unsupported_source("Source file MIME type is missing"))?;
    let format = classify_source(&identity.file_name, mime, &identity.file_type)?;
    Ok(SourceFile { identity, format })
}

fn verify_source_unchanged(
    conn: &Connection,
    blobs_dir: &Path,
    source: &SourceFile,
    expected_hash: &str,
) -> VfsResult<()> {
    let current = load_source(conn, blobs_dir, &source.identity.resource_id, expected_hash)?;
    if current.identity != source.identity || current.format != source.format {
        return Err(source_changed("Source changed while preparing Ink pages"));
    }
    Ok(())
}

fn validate_page_inputs(
    conn: &Connection,
    blobs_dir: &Path,
    source: &SourceFile,
    pages: &[InkPreparedPage],
) -> VfsResult<()> {
    let mut pdf_indexes = BTreeSet::new();
    for (index, page) in pages.iter().enumerate() {
        if !page.width.is_finite()
            || !page.height.is_finite()
            || !(1.0..=16_384.0).contains(&page.width)
            || !(1.0..=16_384.0).contains(&page.height)
        {
            return Err(invalid_prepare(
                "pages",
                "Prepared page dimensions are outside supported bounds",
            ));
        }
        validate_hash(&page.background_blob_hash)?;
        match source.format {
            SourceFormat::Pdf => {
                let expected_index = u32::try_from(index).map_err(|_| {
                    invalid_prepare("pages", "PDF page index is outside supported bounds")
                })?;
                if page.source_page_index != Some(expected_index)
                    || !pdf_indexes.insert(expected_index)
                {
                    return Err(invalid_prepare(
                        "pages",
                        "PDF page indices must be ordered and contiguous from zero",
                    ));
                }
            }
            SourceFormat::Image => {
                if pages.len() != 1 || page.source_page_index.is_some() {
                    return Err(invalid_prepare(
                        "pages",
                        "An image source must produce exactly one page without a PDF index",
                    ));
                }
            }
            SourceFormat::Office => {
                if page.source_page_index.is_some() {
                    return Err(invalid_prepare(
                        "pages",
                        "Office pages cannot have PDF source indices",
                    ));
                }
            }
        }
        let (raster_width, raster_height) =
            validate_png_blob(conn, blobs_dir, &page.background_blob_hash)?;
        if f64::from(raster_width) != page.width || f64::from(raster_height) != page.height {
            return Err(invalid_prepare(
                "pages",
                "Prepared page dimensions must match the frozen PNG raster",
            ));
        }
    }
    Ok(())
}

fn validate_png_blob(conn: &Connection, blobs_dir: &Path, hash: &str) -> VfsResult<(u32, u32)> {
    let blob = VfsBlobRepo::get_blob_with_conn(conn, hash)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "prepared PNG blob".to_owned(),
        id: hash.to_owned(),
    })?;
    if blob.hash != hash || blob.size <= 0 || blob.size as usize > PNG_MAX_BYTES {
        return Err(invalid_prepare(
            "background_blob_hash",
            "Prepared PNG blob metadata is invalid",
        ));
    }
    let relative = Path::new(&blob.relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid_prepare(
            "background_blob_hash",
            "Prepared PNG blob path is invalid",
        ));
    }
    let mut file =
        File::open(blobs_dir.join(relative)).map_err(|error| VfsError::Io(error.to_string()))?;
    let mut bytes = Vec::with_capacity(blob.size as usize);
    file.by_ref()
        .take((PNG_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| VfsError::Io(error.to_string()))?;
    if bytes.len() != blob.size as usize || VfsBlobRepo::compute_hash(&bytes) != hash {
        return Err(invalid_prepare(
            "background_blob_hash",
            "Prepared PNG bytes do not match their SHA-256",
        ));
    }
    let (width, height) = validate_png_bytes(&bytes).map_err(|_| {
        invalid_prepare(
            "background_blob_hash",
            "Prepared PNG payload or dimensions are invalid",
        )
    })?;
    if width > PNG_MAX_DIMENSION
        || height > PNG_MAX_DIMENSION
        || u64::from(width) * u64::from(height) * 4 > PNG_MAX_DECODED_BYTES
    {
        return Err(invalid_prepare(
            "background_blob_hash",
            "Prepared PNG dimensions exceed supported bounds",
        ));
    }
    Ok((width, height))
}

fn classify_source(file_name: &str, mime: &str, file_type: &str) -> VfsResult<SourceFormat> {
    match ink_source_format(file_name, mime, file_type) {
        Some("pdf") => Ok(SourceFormat::Pdf),
        Some("image") => Ok(SourceFormat::Image),
        Some("docx") | Some("pptx") => Ok(SourceFormat::Office),
        _ => Err(unsupported_source(
            "Only PDF, image, DOCX, and PPTX sources can be prepared",
        )),
    }
}

fn prepared_title(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    let title: String = stem
        .chars()
        .filter(|character| !character.is_control() && !matches!(character, '/' | '\\'))
        .take(INK_TITLE_MAX_CHARS)
        .collect();
    if title.trim().is_empty() {
        PREPARE_TITLE.to_owned()
    } else {
        title.trim().to_owned()
    }
}

fn parse_metadata(serialized: Option<&str>) -> VfsResult<Value> {
    let mut metadata = match serialized {
        Some(value) => serde_json::from_str::<Value>(value)
            .map_err(|error| VfsError::Serialization(error.to_string()))?,
        None => json!({}),
    };
    if !metadata.is_object() {
        return Err(source_changed(
            "Source resource metadata must be a JSON object",
        ));
    }
    if metadata.get("default_ink_document_id").is_none() {
        metadata["default_ink_document_id"] = Value::Null;
        metadata
            .as_object_mut()
            .unwrap()
            .remove("default_ink_document_id");
    }
    Ok(metadata)
}

fn derived_operation_id(
    prefix: &str,
    resource_id: &str,
    operation_id: &str,
    recovery_key: Option<&str>,
) -> String {
    let material = match recovery_key {
        Some(recovery_key) => format!(
            "deepstudent.dsink.{prefix}.recovery.v1\0{resource_id}\0{operation_id}\0{recovery_key}"
        ),
        None => format!("deepstudent.dsink.{prefix}.v1\0{resource_id}\0{operation_id}"),
    };
    format!(
        "{prefix}-{}",
        VfsBlobRepo::compute_hash(material.as_bytes())
    )
}

fn validate_identifier(param: &str, value: &str) -> VfsResult<()> {
    if !valid_identifier(value) {
        return Err(invalid_prepare(param, "Identifier is invalid"));
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= 128
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

fn validate_hash(hash: &str) -> VfsResult<()> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_prepare(
            "hash",
            "Hash must be lowercase SHA-256 hex",
        ));
    }
    Ok(())
}

fn map_ink_error(error: crate::vfs::ink::InkError) -> VfsError {
    VfsError::InvalidArgument {
        param: "ink_prepare".to_owned(),
        reason: error.message,
    }
}

fn invalid_prepare(param: &str, reason: &str) -> VfsError {
    VfsError::InvalidArgument {
        param: param.to_owned(),
        reason: reason.to_owned(),
    }
}

fn unsupported_source(message: &str) -> VfsError {
    VfsError::InvalidArgument {
        param: "source_resource_id".to_owned(),
        reason: message.to_owned(),
    }
}

fn source_changed(message: &str) -> VfsError {
    VfsError::Conflict {
        key: SOURCE_CHANGED.to_owned(),
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::Write,
        sync::{mpsc, Arc, Barrier},
        thread,
        time::Duration,
    };

    use rusqlite::Connection;

    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        error::VfsError,
        ink::{
            InkAuthor, InkBackground, InkManifest, InkObject, InkObjectContent, InkRect, InkSource,
        },
        repos::{
            blob_repo::VfsBlobRepo, file_repo::VfsFileRepo, ink_repo::VfsInkRepo,
            textbook_repo::VfsTextbookRepo, VfsAttachmentRepo,
        },
        types::VfsUploadAttachmentParams,
    };

    use super::{InkPreparedPage, VfsInkPrepareRepo};

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn png_612x792() -> Vec<u8> {
        use image::{ColorType, ImageEncoder};

        let (width, height) = (612_u32, 792_u32);
        let white_rgb = vec![u8::MAX; (width * height * 3) as usize];
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&white_rgb, width, height, ColorType::Rgb8)
            .unwrap();
        png
    }

    fn minimal_pdf() -> Vec<u8> {
        pdf_with_padding(0)
    }

    fn office_zip(parts: &[(&str, &[u8])]) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
            let options = zip::write::FileOptions::default();
            for (name, content) in parts {
                zip.start_file(*name, options).unwrap();
                zip.write_all(content).unwrap();
            }
            zip.finish().unwrap();
        }
        bytes
    }

    fn docx_bytes() -> Vec<u8> {
        office_zip(&[
            (
                "[Content_Types].xml",
                br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>"#,
            ),
            (
                "word/document.xml",
                br#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>docx source</w:t></w:r></w:p></w:body></w:document>"#,
            ),
        ])
    }

    fn pptx_bytes() -> Vec<u8> {
        office_zip(&[
            (
                "[Content_Types].xml",
                br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>"#,
            ),
            (
                "ppt/presentation.xml",
                br#"<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>"#,
            ),
        ])
    }

    fn textbook_source(
        conn: &Connection,
        db: &VfsDatabase,
        bytes: &[u8],
        file_name: &str,
        mime: &str,
        extracted_text: &str,
    ) -> (String, String) {
        let blob = VfsBlobRepo::store_blob_with_conn(
            conn,
            db.blobs_dir(),
            bytes,
            Some(mime),
            Some(file_name.rsplit('.').next().unwrap_or("bin")),
        )
        .unwrap();
        let textbook = VfsTextbookRepo::create_textbook_with_preview(
            conn,
            &blob.hash,
            file_name,
            bytes.len() as i64,
            Some(&blob.hash),
            None,
            None,
            Some(extracted_text),
            Some(1),
        )
        .unwrap();
        (textbook.resource_id.unwrap(), blob.hash)
    }

    fn pdf_with_padding(padding: usize) -> Vec<u8> {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        if padding > 0 {
            pdf.extend_from_slice(b"% ");
            pdf.resize(pdf.len() + padding, b' ');
            pdf.push(b'\n');
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

    fn source_file(
        conn: &Connection,
        db: &VfsDatabase,
        bytes: &[u8],
        mime: &str,
        file_name: &str,
        file_type: &str,
    ) -> (String, String) {
        let source = VfsBlobRepo::store_blob_with_conn(
            conn,
            db.blobs_dir(),
            bytes,
            Some(mime),
            Some(file_name.rsplit('.').next().unwrap_or("bin")),
        )
        .unwrap();
        let file = VfsFileRepo::create_file_with_conn(
            conn,
            &source.hash,
            file_name,
            bytes.len() as i64,
            file_type,
            Some(mime),
            Some(&source.hash),
            None,
        )
        .unwrap();
        (file.resource_id.unwrap(), source.hash)
    }

    fn background_ref_count(conn: &Connection, hash: &str) -> i32 {
        conn.query_row(
            "SELECT ref_count FROM blobs WHERE hash = ?1",
            [hash],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn assert_png_blob(conn: &Connection, db: &VfsDatabase, hash: &str, expected: &[u8]) {
        let path = VfsBlobRepo::get_blob_path_with_conn(conn, db.blobs_dir(), hash)
            .unwrap()
            .unwrap();
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(bytes, expected);
        assert_eq!(VfsBlobRepo::compute_hash(&bytes), hash);
    }

    fn database_counts(conn: &Connection) -> (i64, i64, i64) {
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM resources), (SELECT COALESCE(SUM(ref_count), 0) FROM blobs)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }

    fn source_file_id(conn: &Connection, resource_id: &str) -> String {
        conn.query_row(
            "SELECT source_id FROM resources WHERE id = ?1 AND source_table = 'files'",
            [resource_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn source_metadata_raw(conn: &Connection, resource_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT metadata_json FROM resources WHERE id = ?1",
            [resource_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn source_metadata_value(conn: &Connection, resource_id: &str) -> serde_json::Value {
        source_metadata_raw(conn, resource_id)
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .unwrap()
            .unwrap_or_else(|| serde_json::json!({}))
    }

    /// Save one real user stroke so reuse assertions can prove annotations survive.
    fn annotate_first_page(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &InkManifest,
    ) -> InkManifest {
        let mut page = VfsInkRepo::get_page_with_conn(
            conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.pages[0].page_id,
        )
        .unwrap();
        page.objects.push(InkObject {
            id: "user-stroke".to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            content: InkObjectContent::Rect {
                rect: InkRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.5,
                    height: 0.5,
                },
                color: "#000000".to_owned(),
                width: 1.0,
            },
        });
        VfsInkRepo::save_page_with_conn(
            conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.revision,
            "save-prepared-annotation",
            &page,
        )
        .unwrap()
    }

    fn assert_source_changed(result: Result<crate::vfs::ink::InkManifest, VfsError>) {
        match result {
            Err(VfsError::Conflict { key, .. }) => assert_eq!(key, "ink.source_changed"),
            Err(error) => panic!("expected ink.source_changed, got {error}"),
            Ok(_) => panic!("expected ink.source_changed, got a prepared manifest"),
        }
    }

    fn assert_reuse_source_changed(result: Result<Option<InkManifest>, VfsError>) {
        match result {
            Err(VfsError::Conflict { key, .. }) => assert_eq!(key, "ink.source_changed"),
            Err(error) => panic!("expected ink.source_changed, got {error}"),
            Ok(_) => panic!("expected ink.source_changed, got a reusable manifest"),
        }
    }

    #[test]
    fn prepares_real_uploaded_pdf_and_image_sources_without_rewriting_source_storage() {
        use crate::vfs::repos::ink_source::read_ink_source_with_conn;

        for (name, mime, external, is_pdf) in [
            ("讲义.pdf", "application/pdf", false, true),
            ("图片.png", "image/png", false, false),
            ("external.pdf", "application/pdf", true, true),
        ] {
            let (_temp_dir, db) = setup_migrated_test_db();
            let conn = db.get_conn_safe().unwrap();
            let bytes = if is_pdf {
                pdf_with_padding(if external { 1024 * 1024 } else { 0 })
            } else {
                PNG_1X1.to_vec()
            };
            let upload = VfsAttachmentRepo::upload_bytes_with_conn(
                &conn,
                db.blobs_dir(),
                &VfsUploadAttachmentParams {
                    name: name.to_owned(),
                    mime_type: mime.to_owned(),
                    base64_content: String::new(),
                    attachment_type: Some(if is_pdf { "file" } else { "image" }.to_owned()),
                },
                &bytes,
            )
            .unwrap();
            let resource_id = upload.attachment.resource_id.unwrap();
            let hash = VfsBlobRepo::compute_hash(&bytes);
            let source_before =
                read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash))
                    .unwrap()
                    .unwrap();
            assert_eq!(source_before.identity.blob_hash.is_some(), external);
            if !external {
                assert_ne!(source_before.identity.resource_hash, hash);
            }
            conn.execute(
                "UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.custom', 'preserved') WHERE id = ?1",
                [&resource_id],
            )
            .unwrap();
            let background = VfsBlobRepo::store_blob_with_conn(
                &conn,
                db.blobs_dir(),
                PNG_1X1,
                Some("image/png"),
                Some("png"),
            )
            .unwrap();
            let pages = [InkPreparedPage {
                width: 1.0,
                height: 1.0,
                background_blob_hash: background.hash,
                source_page_index: is_pdf.then_some(0),
            }];
            let manifest = VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &resource_id,
                &hash,
                "uploaded-source-v1",
                &pages,
                "prepare-upload",
                None,
            )
            .unwrap();
            assert_eq!(
                manifest.title,
                std::path::Path::new(name)
                    .file_stem()
                    .unwrap()
                    .to_str()
                    .unwrap(),
            );
            assert_eq!(
                VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &manifest.document_id)
                    .unwrap(),
                manifest,
            );
            let page = VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &manifest.document_id,
                &manifest.pages[0].page_id,
            )
            .unwrap();
            let saved = VfsInkRepo::save_page_with_conn(
                &conn,
                db.blobs_dir(),
                &manifest.document_id,
                &manifest.revision,
                "save-upload",
                &page,
            )
            .unwrap();
            assert_eq!(
                VfsInkPrepareRepo::prepare_with_conn(
                    &conn,
                    db.blobs_dir(),
                    &resource_id,
                    &hash,
                    "uploaded-source-v1",
                    &pages,
                    "prepare-upload-retry",
                    None,
                )
                .unwrap(),
                saved,
            );
            let source_after =
                read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash))
                    .unwrap()
                    .unwrap();
            assert_eq!(source_before.bytes, source_after.bytes);
            assert_eq!(
                source_before.identity.resource_hash,
                source_after.identity.resource_hash,
            );
            assert_eq!(source_before.identity.sha256, source_after.identity.sha256);
            assert_eq!(
                source_before.identity.blob_hash,
                source_after.identity.blob_hash
            );
            assert_eq!(
                source_before.identity.storage_mode,
                source_after.identity.storage_mode,
            );
            let metadata: serde_json::Value =
                serde_json::from_str(source_after.identity.metadata_json.as_deref().unwrap())
                    .unwrap();
            assert_eq!(metadata["custom"], "preserved");
            assert_eq!(metadata["default_ink_document_id"], saved.document_id);
            conn.execute(
                "UPDATE files SET resource_id = NULL WHERE id = ?1",
                [&upload.source_id],
            )
            .unwrap();
            let counts = database_counts(&conn);
            assert_source_changed(VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &resource_id,
                &hash,
                "uploaded-source-v1",
                &pages,
                "prepare-invalid-link",
                None,
            ));
            assert_eq!(database_counts(&conn), counts);
        }
    }

    #[test]
    fn prepares_and_reopens_textbook_imported_pdf_image_docx_and_pptx() {
        let cases = vec![
            ("讲义.pdf", "application/pdf", "pdf", minimal_pdf(), true),
            ("图片.png", "image/png", "image", PNG_1X1.to_vec(), false),
            (
                "文档.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "docx",
                docx_bytes(),
                false,
            ),
            (
                "幻灯片.pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "pptx",
                pptx_bytes(),
                false,
            ),
        ];

        for (file_name, mime, file_type, bytes, is_pdf) in cases {
            let (_temp_dir, db) = setup_migrated_test_db();
            let conn = db.get_conn_safe().unwrap();
            let (resource_id, source_hash) = textbook_source(
                &conn,
                &db,
                &bytes,
                file_name,
                mime,
                "textbook extracted text that is not source bytes",
            );
            let stored_type: String = conn
                .query_row(
                    "SELECT \"type\" FROM files WHERE resource_id = ?1",
                    [&resource_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(stored_type, file_type);

            let background = VfsBlobRepo::store_blob_with_conn(
                &conn,
                db.blobs_dir(),
                PNG_1X1,
                Some("image/png"),
                Some("png"),
            )
            .unwrap();
            let pages = [InkPreparedPage {
                width: 1.0,
                height: 1.0,
                background_blob_hash: background.hash.clone(),
                source_page_index: is_pdf.then_some(0),
            }];
            let refs_before = background_ref_count(&conn, &background.hash);
            let manifest = VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &resource_id,
                &source_hash,
                "textbook-source-v1",
                &pages,
                "prepare-textbook",
                None,
            )
            .unwrap();
            assert_eq!(
                manifest.title,
                std::path::Path::new(file_name)
                    .file_stem()
                    .unwrap()
                    .to_str()
                    .unwrap(),
            );
            assert!(matches!(
                &manifest.source,
                InkSource::Resource { resource_id: id, source_hash: hash, conversion_revision }
                    if id == &resource_id
                        && hash == &source_hash
                        && conversion_revision == "textbook-source-v1"
            ));
            if is_pdf {
                assert_eq!(
                    manifest.pages[0].background,
                    InkBackground::PdfPage {
                        blob_hash: background.hash.clone(),
                        source_page_index: 0,
                    }
                );
            } else {
                assert_eq!(
                    manifest.pages[0].background,
                    InkBackground::Image {
                        blob_hash: background.hash.clone(),
                    }
                );
            }
            assert_eq!(
                VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &manifest.document_id)
                    .unwrap(),
                manifest,
            );
            let page = VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &manifest.document_id,
                &manifest.pages[0].page_id,
            )
            .unwrap();
            assert!(page.objects.is_empty());
            assert_eq!(
                background_ref_count(&conn, &background.hash),
                refs_before + 1,
            );
        }
    }

    #[test]
    fn prepares_pdf_source_as_png_background_and_reopens_manifest_and_page() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let pdf = minimal_pdf();
        let (source_resource_id, source_hash) = source_file(
            &conn,
            &db,
            &pdf,
            "application/pdf",
            "source.pdf",
            "document",
        );
        let background_png = png_612x792();
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            &background_png,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let background_refs_before_prepare = background_ref_count(&conn, &background.hash);
        let pages = [InkPreparedPage {
            width: 612.0,
            height: 792.0,
            background_blob_hash: background.hash.clone(),
            source_page_index: Some(0),
        }];

        let manifest = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "pdf-render-v1",
            &pages,
            "prepare-pdf-1",
            None,
        )
        .unwrap();

        assert!(matches!(
            &manifest.source,
            InkSource::Resource { resource_id, source_hash: actual_hash, conversion_revision }
                if resource_id == &source_resource_id
                    && actual_hash == &source_hash
                    && conversion_revision == "pdf-render-v1"
        ));
        assert_eq!(manifest.pages.len(), 1);
        assert_eq!(
            manifest.pages[0].background,
            InkBackground::PdfPage {
                blob_hash: background.hash.clone(),
                source_page_index: 0,
            }
        );
        assert!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &manifest.document_id,)
                .is_ok()
        );
        let page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.pages[0].page_id,
        )
        .unwrap();
        assert!(page.objects.is_empty());
        assert_eq!(
            background_ref_count(&conn, &background.hash),
            background_refs_before_prepare + 1,
        );
        assert_png_blob(&conn, &db, &background.hash, &background_png);
    }

    #[test]
    fn prepares_image_source_once_and_reuses_default_ink_document_and_refs() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_hash) =
            source_file(&conn, &db, PNG_1X1, "image/png", "source.png", "image");
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let pages = [InkPreparedPage {
            width: 1.0,
            height: 1.0,
            background_blob_hash: background.hash.clone(),
            source_page_index: None,
        }];
        let before_refs = background_ref_count(&conn, &background.hash);

        let first = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "prepare-image-1",
            None,
        )
        .unwrap();
        let after_first_refs = background_ref_count(&conn, &background.hash);
        let second = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "prepare-image-retry",
            None,
        )
        .unwrap();

        assert_eq!(first, second);
        assert_ne!(first.document_id, source_resource_id);
        assert_eq!(after_first_refs, before_refs + 1);
        assert_eq!(
            background_ref_count(&conn, &background.hash),
            after_first_refs
        );
        let source_metadata: String = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        let source_metadata: serde_json::Value = serde_json::from_str(&source_metadata).unwrap();
        assert_eq!(
            source_metadata["default_ink_document_id"],
            first.document_id,
        );
        assert_eq!(
            VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &second.document_id,
                &second.pages[0].page_id,
            )
            .unwrap()
            .objects
            .len(),
            0,
        );
        assert_png_blob(&conn, &db, &background.hash, PNG_1X1);
    }

    #[test]
    fn first_prepare_keeps_legacy_create_and_commit_operation_ids() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_hash) =
            source_file(&conn, &db, PNG_1X1, "image/png", "source.png", "image");
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let operation_id = "prepare-legacy-id";
        let legacy_create_operation_id = format!(
            "prepare-create-{}",
            VfsBlobRepo::compute_hash(
                format!(
                    "deepstudent.dsink.prepare-create.v1\0{source_resource_id}\0{operation_id}"
                )
                .as_bytes(),
            )
        );
        let expected_document_id = format!(
            "file_ink_{}",
            VfsBlobRepo::compute_hash(
                format!("deepstudent.dsink.create.v1\0{legacy_create_operation_id}").as_bytes(),
            )
        );
        let expected_commit_operation_id = format!(
            "prepare-commit-{}",
            VfsBlobRepo::compute_hash(
                format!(
                    "deepstudent.dsink.prepare-commit.v1\0{source_resource_id}\0{operation_id}"
                )
                .as_bytes(),
            )
        );

        let prepared = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &[InkPreparedPage {
                width: 1.0,
                height: 1.0,
                background_blob_hash: background.hash,
                source_page_index: None,
            }],
            operation_id,
            None,
        )
        .unwrap();

        assert_eq!(prepared.document_id, expected_document_id);
        assert_eq!(
            prepared.last_operation.as_ref().unwrap().operation_id,
            expected_commit_operation_id,
        );
    }

    #[test]
    fn soft_deleted_default_target_prepares_a_new_active_document_and_keeps_old_annotations() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_hash) =
            source_file(&conn, &db, PNG_1X1, "image/png", "source.png", "image");
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let pages = [InkPreparedPage {
            width: 1.0,
            height: 1.0,
            background_blob_hash: background.hash,
            source_page_index: None,
        }];
        let first = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "reused-operation-id",
            None,
        )
        .unwrap();
        let annotated = annotate_first_page(&conn, &db, &first);
        conn.execute(
            "UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.custom', 'kept', '$.trash', json(?1)) WHERE id = ?2",
            rusqlite::params![r#"{"deleted_notes":["note-1"],"deleted_ink":true}"#, source_resource_id],
        )
        .unwrap();
        let pointer_before: String = source_metadata_value(&conn, &source_resource_id)
            ["default_ink_document_id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(pointer_before, first.document_id);

        VfsFileRepo::delete_file_with_conn(&conn, &first.document_id).unwrap();
        let deleted = VfsFileRepo::get_file_with_conn(&conn, &first.document_id)
            .unwrap()
            .expect("soft-deleted Ink document row must remain");
        assert_eq!(deleted.status, "deleted");
        let metadata_after_delete = source_metadata_raw(&conn, &source_resource_id);
        assert!(VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
        )
        .unwrap()
        .is_none());
        assert_eq!(
            source_metadata_raw(&conn, &source_resource_id),
            metadata_after_delete,
            "the read-side deleted-target check must not erase the pointer",
        );
        let (files_before, resources_before, _) = database_counts(&conn);

        // This is the regression: a deleted default target used to make the
        // prepare fail instead of rebuilding a fresh active document.
        let second = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "reused-operation-id",
            None,
        )
        .expect("soft-deleted default target must be rebuildable");

        assert_ne!(second.document_id, first.document_id);
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &second.document_id).unwrap(),
            second,
        );
        let metadata = source_metadata_value(&conn, &source_resource_id);
        assert_eq!(metadata["custom"], "kept");
        assert_eq!(metadata["trash"]["deleted_notes"][0], "note-1");
        assert_eq!(metadata["trash"]["deleted_ink"], true);
        assert_eq!(
            metadata["default_ink_document_id"],
            second.document_id.as_str()
        );
        let old_file = VfsFileRepo::get_file_with_conn(&conn, &first.document_id)
            .unwrap()
            .expect("old deleted document must not be purged");
        assert_eq!(old_file.status, "deleted");
        let (files_after, resources_after, _) = database_counts(&conn);
        assert_eq!(files_after, files_before + 1);
        assert_eq!(resources_after, resources_before + 1);

        // Old annotations and the deleted document itself are untouched; only
        // the source pointer moved to the new active document.
        VfsFileRepo::restore_file_with_conn(&conn, &first.document_id).unwrap();
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &first.document_id).unwrap(),
            annotated,
        );
        let old_page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &first.document_id,
            &annotated.pages[0].page_id,
        )
        .unwrap();
        assert_eq!(old_page.objects.len(), 1);
        assert_eq!(old_page.objects[0].id, "user-stroke");
    }

    #[test]
    fn missing_default_target_is_not_reusable_and_prepare_replaces_the_pointer() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_hash) =
            source_file(&conn, &db, PNG_1X1, "image/png", "source.png", "image");
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let pages = [InkPreparedPage {
            width: 1.0,
            height: 1.0,
            background_blob_hash: background.hash,
            source_page_index: None,
        }];

        assert!(VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
        )
        .unwrap()
        .is_none());
        assert!(source_metadata_raw(&conn, &source_resource_id).is_none());

        let orphan = format!("file_ink_{}", "a".repeat(64));
        conn.execute(
            "UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.default_ink_document_id', ?1, '$.custom', 'kept') WHERE id = ?2",
            rusqlite::params![orphan, source_resource_id],
        )
        .unwrap();
        let metadata_before = source_metadata_raw(&conn, &source_resource_id);
        assert!(VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
        )
        .unwrap()
        .is_none());
        assert_eq!(
            source_metadata_raw(&conn, &source_resource_id),
            metadata_before,
            "a missing target check must not erase the pointer",
        );

        let prepared = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "prepare-orphan-target",
            None,
        )
        .unwrap();
        assert_ne!(prepared.document_id, orphan);
        let metadata = source_metadata_value(&conn, &source_resource_id);
        assert_eq!(metadata["custom"], "kept");
        assert_eq!(
            metadata["default_ink_document_id"],
            prepared.document_id.as_str()
        );
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &prepared.document_id)
                .unwrap(),
            prepared,
        );
    }

    #[test]
    fn resource_deleted_at_marks_default_target_deleted_even_with_active_file_status() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_hash) =
            source_file(&conn, &db, PNG_1X1, "image/png", "source.png", "image");
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let pages = [InkPreparedPage {
            width: 1.0,
            height: 1.0,
            background_blob_hash: background.hash,
            source_page_index: None,
        }];
        let first = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "prepare-resource-deleted",
            None,
        )
        .unwrap();
        let document_resource_id: String = conn
            .query_row(
                "SELECT resource_id FROM files WHERE id = ?1",
                [&first.document_id],
                |row| row.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE resources SET deleted_at = '2026-11-04T09:08:22.000Z' WHERE id = ?1",
            [&document_resource_id],
        )
        .unwrap();
        assert!(VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
        )
        .unwrap()
        .is_none());
        let second = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "prepare-resource-deleted",
            None,
        )
        .unwrap();
        assert_ne!(second.document_id, first.document_id);
        assert_eq!(
            source_metadata_value(&conn, &source_resource_id)["default_ink_document_id"],
            second.document_id.as_str(),
        );
    }

    #[test]
    fn active_default_target_is_reused_with_annotations_and_pointer_unchanged() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_hash) =
            source_file(&conn, &db, PNG_1X1, "image/png", "source.png", "image");
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let pages = [InkPreparedPage {
            width: 1.0,
            height: 1.0,
            background_blob_hash: background.hash,
            source_page_index: None,
        }];
        let first = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "prepare-active-target",
            None,
        )
        .unwrap();
        let annotated = annotate_first_page(&conn, &db, &first);
        let metadata_before = source_metadata_raw(&conn, &source_resource_id);

        assert_eq!(
            VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
                &conn,
                db.blobs_dir(),
                &source_resource_id,
                &source_hash,
                "image-render-v1",
            )
            .unwrap(),
            Some(annotated.clone()),
        );
        assert_eq!(
            source_metadata_raw(&conn, &source_resource_id),
            metadata_before,
            "the read-side reuse check must not rewrite metadata",
        );
        assert_eq!(
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &source_resource_id,
                &source_hash,
                "image-render-v1",
                &pages,
                "prepare-active-target-retry",
                None,
            )
            .unwrap(),
            annotated,
        );
        assert_eq!(
            source_metadata_raw(&conn, &source_resource_id),
            metadata_before
        );
        let page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &first.document_id,
            &first.pages[0].page_id,
        )
        .unwrap();
        assert_eq!(page.objects.len(), 1);
        assert_eq!(page.objects[0].id, "user-stroke");
    }

    #[test]
    fn active_corrupt_default_target_is_rejected_without_replacement() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_hash) =
            source_file(&conn, &db, PNG_1X1, "image/png", "source.png", "image");
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let pages = [InkPreparedPage {
            width: 1.0,
            height: 1.0,
            background_blob_hash: background.hash,
            source_page_index: None,
        }];
        let first = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "prepare-corrupt-target",
            None,
        )
        .unwrap();
        let manifest_hash: String = conn
            .query_row(
                "SELECT blob_hash FROM files WHERE id = ?1",
                [&first.document_id],
                |row| row.get(0),
            )
            .unwrap();
        let manifest_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &manifest_hash)
                .unwrap()
                .unwrap();
        std::fs::write(manifest_path, b"{\"corrupt\":true}").unwrap();
        let metadata_before = source_metadata_raw(&conn, &source_resource_id);
        let counts_before = database_counts(&conn);

        assert_reuse_source_changed(VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
        ));
        assert_source_changed(VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            "prepare-corrupt-target-retry",
            None,
        ));
        assert_eq!(
            source_metadata_raw(&conn, &source_resource_id),
            metadata_before
        );
        assert_eq!(database_counts(&conn), counts_before);
    }

    #[test]
    fn active_default_target_with_another_source_or_profile_is_rejected() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (first_resource, first_hash) =
            source_file(&conn, &db, PNG_1X1, "image/png", "first.png", "image");
        let second_bytes = png_612x792();
        let (second_resource, second_hash) = source_file(
            &conn,
            &db,
            &second_bytes,
            "image/png",
            "second.png",
            "image",
        );
        let mut first_document_id = String::new();
        for (resource_id, hash) in [
            (&first_resource, &first_hash),
            (&second_resource, &second_hash),
        ] {
            let background = VfsBlobRepo::store_blob_with_conn(
                &conn,
                db.blobs_dir(),
                PNG_1X1,
                Some("image/png"),
                Some("png"),
            )
            .unwrap();
            let prepared = VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                resource_id,
                hash,
                "image-render-v1",
                &[InkPreparedPage {
                    width: 1.0,
                    height: 1.0,
                    background_blob_hash: background.hash,
                    source_page_index: None,
                }],
                &format!("prepare-{resource_id}-target"),
                None,
            )
            .unwrap();
            if resource_id == &first_resource {
                first_document_id = prepared.document_id;
            }
        }
        let second_pointer = source_metadata_value(&conn, &second_resource)
            ["default_ink_document_id"]
            .as_str()
            .unwrap()
            .to_owned();
        conn.execute(
            "UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.default_ink_document_id', ?1) WHERE id = ?2",
            rusqlite::params![second_pointer, first_resource],
        )
        .unwrap();

        assert_reuse_source_changed(VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
            &conn,
            db.blobs_dir(),
            &first_resource,
            &first_hash,
            "image-render-v1",
        ));
        conn.execute(
            "UPDATE resources SET metadata_json = json_set(metadata_json, '$.default_ink_document_id', ?1) WHERE id = ?2",
            rusqlite::params![first_document_id, first_resource],
        )
        .unwrap();
        assert_reuse_source_changed(VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
            &conn,
            db.blobs_dir(),
            &first_resource,
            &first_hash,
            "image-render-v2",
        ));
    }

    #[test]
    fn four_source_formats_share_stale_default_target_recovery() {
        let cases = vec![
            ("讲义.pdf", "application/pdf", "pdf", minimal_pdf(), true),
            ("图片.png", "image/png", "image", PNG_1X1.to_vec(), false),
            (
                "文档.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "docx",
                docx_bytes(),
                false,
            ),
            (
                "幻灯片.pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "pptx",
                pptx_bytes(),
                false,
            ),
        ];

        for (file_name, mime, _file_type, bytes, is_pdf) in cases {
            let (_temp_dir, db) = setup_migrated_test_db();
            let conn = db.get_conn_safe().unwrap();
            let (resource_id, source_hash) = textbook_source(
                &conn,
                &db,
                &bytes,
                file_name,
                mime,
                "textbook extracted text that is not source bytes",
            );
            let background = VfsBlobRepo::store_blob_with_conn(
                &conn,
                db.blobs_dir(),
                PNG_1X1,
                Some("image/png"),
                Some("png"),
            )
            .unwrap();
            let pages = [InkPreparedPage {
                width: 1.0,
                height: 1.0,
                background_blob_hash: background.hash,
                source_page_index: is_pdf.then_some(0),
            }];
            let first = VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &resource_id,
                &source_hash,
                "textbook-source-v1",
                &pages,
                "reused-textbook-operation",
                None,
            )
            .unwrap();
            VfsFileRepo::delete_file_with_conn(&conn, &first.document_id).unwrap();
            assert!(
                VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
                    &conn,
                    db.blobs_dir(),
                    &resource_id,
                    &source_hash,
                    "textbook-source-v1",
                )
                .unwrap()
                .is_none(),
                "{file_name} must report its deleted target as not reusable",
            );
            let second = VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &resource_id,
                &source_hash,
                "textbook-source-v1",
                &pages,
                "reused-textbook-operation",
                None,
            )
            .unwrap();
            assert_ne!(second.document_id, first.document_id, "{file_name}");
            assert_eq!(
                VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &second.document_id)
                    .unwrap(),
                second,
                "{file_name}",
            );
            assert_eq!(
                source_metadata_value(&conn, &resource_id)["default_ink_document_id"],
                second.document_id.as_str(),
                "{file_name}",
            );
        }
    }

    #[test]
    fn changed_source_hash_is_rejected_without_creating_an_ink_document() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let pdf = minimal_pdf();
        let (source_resource_id, original_hash) = source_file(
            &conn,
            &db,
            &pdf,
            "application/pdf",
            "source.pdf",
            "document",
        );
        let changed_bytes = b"changed source content";
        let replacement = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            changed_bytes,
            Some("application/pdf"),
            Some("pdf"),
        )
        .unwrap();
        conn.execute(
            "UPDATE files SET blob_hash = ?1, sha256 = ?1 WHERE resource_id = ?2",
            rusqlite::params![replacement.hash, source_resource_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE resources SET hash = ?1 WHERE id = ?2",
            rusqlite::params![replacement.hash, source_resource_id],
        )
        .unwrap();
        VfsBlobRepo::decrement_ref_with_conn(&conn, db.blobs_dir(), &original_hash).unwrap();
        let background_png = png_612x792();
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            &background_png,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let before = database_counts(&conn);
        let result = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &original_hash,
            "pdf-render-v1",
            &[InkPreparedPage {
                width: 612.0,
                height: 792.0,
                background_blob_hash: background.hash,
                source_page_index: Some(0),
            }],
            "prepare-changed-source",
            None,
        );
        assert_source_changed(result);
        assert_eq!(database_counts(&conn), before);
        let pointer: Option<String> = conn
            .query_row(
                "SELECT json_extract(metadata_json, '$.default_ink_document_id') FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(pointer.is_none());
    }

    #[test]
    fn rejects_invalid_hash_unsupported_source_and_invalid_page_inputs_without_writes() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let pdf = minimal_pdf();
        let (pdf_resource, pdf_hash) = source_file(
            &conn,
            &db,
            &pdf,
            "application/pdf",
            "source.pdf",
            "document",
        );
        let valid_background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let valid_page = InkPreparedPage {
            width: 1.0,
            height: 1.0,
            background_blob_hash: valid_background.hash.clone(),
            source_page_index: Some(0),
        };
        let (text_resource, text_hash) = source_file(
            &conn,
            &db,
            b"not a supported source format",
            "text/plain",
            "source.txt",
            "document",
        );
        let before = database_counts(&conn);

        assert!(matches!(
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &pdf_resource,
                "not-a-sha256",
                "pdf-render-v1",
                &[valid_page.clone()],
                "prepare-invalid-hash",
                None,
            ),
            Err(VfsError::InvalidArgument { .. })
        ));
        assert!(matches!(
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &text_resource,
                &text_hash,
                "text-v1",
                &[valid_page.clone()],
                "prepare-unsupported",
                None,
            ),
            Err(VfsError::InvalidArgument { .. })
        ));
        assert!(matches!(
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &pdf_resource,
                &pdf_hash,
                "pdf-render-v1",
                &[],
                "prepare-zero-pages",
                None,
            ),
            Err(VfsError::InvalidArgument { .. })
        ));
        let too_many_pages = vec![valid_page.clone(); 501];
        assert!(matches!(
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &pdf_resource,
                &pdf_hash,
                "pdf-render-v1",
                &too_many_pages,
                "prepare-too-many-pages",
                None,
            ),
            Err(VfsError::InvalidArgument { .. })
        ));
        let invalid_dimensions = [InkPreparedPage {
            width: 0.0,
            ..valid_page.clone()
        }];
        assert!(matches!(
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &pdf_resource,
                &pdf_hash,
                "pdf-render-v1",
                &invalid_dimensions,
                "prepare-invalid-dimensions",
                None,
            ),
            Err(VfsError::InvalidArgument { .. })
        ));
        assert_eq!(database_counts(&conn), before);
    }

    #[test]
    fn rejects_non_png_background_without_writing_document_or_references() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let pdf = minimal_pdf();
        let (source_resource_id, source_hash) = source_file(
            &conn,
            &db,
            &pdf,
            "application/pdf",
            "source.pdf",
            "document",
        );
        let invalid_blob = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            b"not a PNG",
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let before = database_counts(&conn);
        assert!(matches!(
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &source_resource_id,
                &source_hash,
                "pdf-render-v1",
                &[InkPreparedPage {
                    width: 612.0,
                    height: 792.0,
                    background_blob_hash: invalid_blob.hash,
                    source_page_index: Some(0),
                }],
                "prepare-invalid-png",
                None,
            ),
            Err(VfsError::InvalidArgument { .. })
        ));
        assert_eq!(database_counts(&conn), before);
        let pointer: Option<String> = conn
            .query_row(
                "SELECT json_extract(metadata_json, '$.default_ink_document_id') FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(pointer.is_none());
    }

    #[test]
    fn rejects_png_with_valid_header_but_truncated_idat_payload() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let pdf = minimal_pdf();
        let (source_resource_id, source_hash) = source_file(
            &conn,
            &db,
            &pdf,
            "application/pdf",
            "source.pdf",
            "document",
        );
        let truncated_png = &PNG_1X1[..49];
        assert!(crate::vfs::repos::ink_artifact_repo::validate_png_bytes(truncated_png).is_err());
        let invalid_blob = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            truncated_png,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let before = database_counts(&conn);

        assert!(matches!(
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &source_resource_id,
                &source_hash,
                "pdf-render-v1",
                &[InkPreparedPage {
                    width: 1.0,
                    height: 1.0,
                    background_blob_hash: invalid_blob.hash,
                    source_page_index: Some(0),
                }],
                "prepare-truncated-png",
                None,
            ),
            Err(VfsError::InvalidArgument { .. })
        ));
        assert_eq!(database_counts(&conn), before);
        let pointer: Option<String> = conn
            .query_row(
                "SELECT json_extract(metadata_json, '$.default_ink_document_id') FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(pointer.is_none());
    }

    #[test]
    fn rejects_page_dimensions_that_do_not_match_png_raster_dimensions() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let pdf = minimal_pdf();
        let (source_resource_id, source_hash) = source_file(
            &conn,
            &db,
            &pdf,
            "application/pdf",
            "source.pdf",
            "document",
        );
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let before = database_counts(&conn);

        assert!(matches!(
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                db.blobs_dir(),
                &source_resource_id,
                &source_hash,
                "pdf-render-v1",
                &[InkPreparedPage {
                    width: 2.0,
                    height: 1.0,
                    background_blob_hash: background.hash,
                    source_page_index: Some(0),
                }],
                "prepare-dimension-mismatch",
                None,
            ),
            Err(VfsError::InvalidArgument { .. })
        ));
        assert_eq!(database_counts(&conn), before);
    }

    #[test]
    fn failed_pointer_update_rolls_back_created_document_and_blob_references() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let pdf = minimal_pdf();
        let (source_resource_id, source_hash) = source_file(
            &conn,
            &db,
            &pdf,
            "application/pdf",
            "source.pdf",
            "document",
        );
        let background_png = png_612x792();
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            &background_png,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let before = database_counts(&conn);
        conn.execute_batch(&format!(
            "CREATE TRIGGER fail_prepare_pointer BEFORE UPDATE OF metadata_json ON resources WHEN OLD.id = '{}' BEGIN SELECT RAISE(ABORT, 'injected prepare failure'); END",
            source_resource_id,
        ))
        .unwrap();

        assert!(VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "pdf-render-v1",
            &[InkPreparedPage {
                width: 612.0,
                height: 792.0,
                background_blob_hash: background.hash,
                source_page_index: Some(0),
            }],
            "prepare-pointer-failure",
            None,
        )
        .is_err());
        assert_eq!(database_counts(&conn), before);
        let pointer: Option<String> = conn
            .query_row(
                "SELECT json_extract(metadata_json, '$.default_ink_document_id') FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(pointer.is_none());
    }

    #[test]
    fn deleted_target_rebuild_pointer_failure_rolls_back_new_document_and_keeps_old_state() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_hash) =
            source_file(&conn, &db, PNG_1X1, "image/png", "source.png", "image");
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let pages = [InkPreparedPage {
            width: 1.0,
            height: 1.0,
            background_blob_hash: background.hash.clone(),
            source_page_index: None,
        }];
        let operation_id = "prepare-deleted-pointer-failure";
        let first = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            operation_id,
            None,
        )
        .unwrap();
        let annotated = annotate_first_page(&conn, &db, &first);
        conn.execute(
            "UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.custom', 'kept', '$.trash', json(?1)) WHERE id = ?2",
            rusqlite::params![r#"{"deleted_notes":["note-1"],"deleted_ink":true}"#, source_resource_id],
        )
        .unwrap();
        let annotated_file = VfsFileRepo::get_file_with_conn(&conn, &first.document_id)
            .unwrap()
            .unwrap();
        let manifest_hash = annotated_file.blob_hash.as_deref().unwrap();
        let page_hash = &annotated.pages[0].page_blob_hash;
        let manifest_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), manifest_hash)
                .unwrap()
                .unwrap();
        let page_path = VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), page_hash)
            .unwrap()
            .unwrap();
        let manifest_bytes = std::fs::read(&manifest_path).unwrap();
        let page_bytes = std::fs::read(&page_path).unwrap();
        let manifest_refs = background_ref_count(&conn, manifest_hash);
        let page_refs = background_ref_count(&conn, page_hash);
        let old_page: crate::vfs::ink::InkPage = serde_json::from_slice(&page_bytes).unwrap();
        assert_eq!(old_page.objects.len(), 1);
        assert_eq!(old_page.objects[0].id, "user-stroke");

        VfsFileRepo::delete_file_with_conn(&conn, &first.document_id).unwrap();
        let deleted_file = VfsFileRepo::get_file_with_conn(&conn, &first.document_id)
            .unwrap()
            .unwrap();
        let metadata_before = source_metadata_raw(&conn, &source_resource_id);
        let counts_before = database_counts(&conn);
        let background_refs_before = background_ref_count(&conn, &background.hash);
        conn.execute_batch(&format!(
            "CREATE TRIGGER fail_prepare_pointer BEFORE UPDATE OF metadata_json ON resources WHEN OLD.id = '{}' BEGIN SELECT RAISE(ABORT, 'injected prepare failure'); END",
            source_resource_id,
        ))
        .unwrap();

        assert!(VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "image-render-v1",
            &pages,
            operation_id,
            None,
        )
        .is_err());

        assert_eq!(
            source_metadata_raw(&conn, &source_resource_id),
            metadata_before,
        );
        assert_eq!(database_counts(&conn), counts_before);
        assert_eq!(
            background_ref_count(&conn, &background.hash),
            background_refs_before,
        );
        let old_file = VfsFileRepo::get_file_with_conn(&conn, &first.document_id)
            .unwrap()
            .expect("old deleted document must remain");
        assert_eq!(old_file.status, "deleted");
        assert_eq!(
            serde_json::to_value(&old_file).unwrap(),
            serde_json::to_value(&deleted_file).unwrap(),
        );
        let manifest_after = std::fs::read(&manifest_path).unwrap();
        let page_after = std::fs::read(&page_path).unwrap();
        assert_eq!(manifest_after, manifest_bytes);
        assert_eq!(page_after, page_bytes);
        assert_eq!(VfsBlobRepo::compute_hash(&manifest_after), manifest_hash);
        assert_eq!(VfsBlobRepo::compute_hash(&page_after), *page_hash);
        assert_eq!(background_ref_count(&conn, manifest_hash), manifest_refs);
        assert_eq!(background_ref_count(&conn, page_hash), page_refs);
    }

    #[test]
    fn purging_source_keeps_prepared_document_and_its_background_reference() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let pdf = minimal_pdf();
        let (source_resource_id, source_hash) = source_file(
            &conn,
            &db,
            &pdf,
            "application/pdf",
            "source.pdf",
            "document",
        );
        let source_file_id = source_file_id(&conn, &source_resource_id);
        let background_png = png_612x792();
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            &background_png,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let before_refs = background_ref_count(&conn, &background.hash);
        let manifest = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            &source_resource_id,
            &source_hash,
            "pdf-render-v1",
            &[InkPreparedPage {
                width: 612.0,
                height: 792.0,
                background_blob_hash: background.hash.clone(),
                source_page_index: Some(0),
            }],
            "prepare-purge-source",
            None,
        )
        .unwrap();
        assert_eq!(
            background_ref_count(&conn, &background.hash),
            before_refs + 1
        );

        VfsFileRepo::purge_file_with_conn(&conn, db.blobs_dir(), &source_file_id).unwrap();

        assert!(VfsFileRepo::get_file_with_conn(&conn, &source_file_id)
            .unwrap()
            .is_none());
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &manifest.document_id)
                .unwrap(),
            manifest,
        );
        assert_eq!(
            background_ref_count(&conn, &background.hash),
            before_refs + 1
        );
        assert_png_blob(&conn, &db, &background.hash, &background_png);
    }

    #[test]
    fn prepare_and_blob_write_complete_with_two_connections_without_lock_inversion() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let setup_conn = db.get_conn_safe().unwrap();
        let pdf = minimal_pdf();
        let (source_resource_id, source_hash) = source_file(
            &setup_conn,
            &db,
            &pdf,
            "application/pdf",
            "source.pdf",
            "document",
        );
        let background = VfsBlobRepo::store_blob_with_conn(
            &setup_conn,
            db.blobs_dir(),
            PNG_1X1,
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let source_rowid: i64 = setup_conn
            .query_row(
                "SELECT rowid FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        drop(setup_conn);

        let db_path = db.db_path().to_path_buf();
        let blobs_dir = db.blobs_dir().to_path_buf();
        let (writer_locked_tx, writer_locked_rx) = mpsc::channel();
        let (release_prepare_tx, release_prepare_rx) = mpsc::channel();
        let prepare_resource_id = source_resource_id.clone();
        let prepare_hash = source_hash.clone();
        let prepare_background_hash = background.hash.clone();
        let prepare_thread = thread::spawn(move || {
            let conn = Connection::open(&db_path).unwrap();
            conn.busy_timeout(Duration::from_secs(2)).unwrap();
            let mut paused = false;
            conn.update_hook(Some(
                move |_action: rusqlite::hooks::Action,
                      _database: &str,
                      table: &str,
                      rowid: i64| {
                    if !paused && table == "resources" && rowid == source_rowid {
                        paused = true;
                        let _ = writer_locked_tx.send(());
                        let _ = release_prepare_rx.recv_timeout(Duration::from_secs(2));
                    }
                },
            ))
            .unwrap();
            VfsInkPrepareRepo::prepare_with_conn(
                &conn,
                &blobs_dir,
                &prepare_resource_id,
                &prepare_hash,
                "pdf-render-v1",
                &[InkPreparedPage {
                    width: 1.0,
                    height: 1.0,
                    background_blob_hash: prepare_background_hash,
                    source_page_index: Some(0),
                }],
                "prepare-concurrent",
                None,
            )
        });

        let writer_lock_seen = writer_locked_rx
            .recv_timeout(Duration::from_secs(2))
            .is_ok();
        let writer_path = db.db_path().to_path_buf();
        let writer_blobs = db.blobs_dir().to_path_buf();
        let barrier = Arc::new(Barrier::new(2));
        let writer_barrier = Arc::clone(&barrier);
        let writer_thread = thread::spawn(move || {
            let conn = Connection::open(writer_path).unwrap();
            conn.busy_timeout(Duration::from_secs(2)).unwrap();
            writer_barrier.wait();
            VfsBlobRepo::store_blob_with_conn(
                &conn,
                &writer_blobs,
                b"concurrent prepare lock-order probe",
                Some("application/octet-stream"),
                Some("bin"),
            )
        });
        barrier.wait();
        thread::sleep(Duration::from_millis(50));
        let _ = release_prepare_tx.send(());

        let prepared = prepare_thread.join().expect("prepare worker must finish");
        let blob_write = writer_thread.join().expect("blob worker must finish");
        assert!(
            writer_lock_seen,
            "prepare must reach its source writer lock"
        );
        assert!(
            prepared.is_ok(),
            "prepare should complete under concurrent blob writes"
        );
        assert!(
            blob_write.is_ok(),
            "the concurrent blob write should complete"
        );
    }
}
