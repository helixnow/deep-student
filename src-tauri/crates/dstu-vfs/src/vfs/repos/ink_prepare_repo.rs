//! Prepare source files into fixed Ink page backgrounds.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
        InkPageRef, InkSource, INK_EXTENSION, INK_MIME, INK_SCHEMA_VERSION,
    },
    repos::{blob_repo::VfsBlobRepo, ink_artifact_repo::validate_png_bytes, ink_repo::VfsInkRepo},
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
    resource_id: String,
    file_id: String,
    file_name: String,
    mime_type: String,
    file_type: String,
    blob_hash: String,
    sha256: String,
    resource_hash: String,
    metadata_json: Option<String>,
    format: SourceFormat,
}

pub struct VfsInkPrepareRepo;

impl VfsInkPrepareRepo {
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

            let mut metadata = parse_metadata(source.metadata_json.as_deref())?;
            if let Some(pointer) = metadata.get("default_ink_document_id") {
                let document_id = pointer
                    .as_str()
                    .filter(|id| valid_identifier(id))
                    .ok_or_else(|| {
                        source_changed("Source default Ink document pointer is invalid")
                    })?;
                let manifest = VfsInkRepo::get_manifest_with_conn(conn, blobs_dir, document_id)
                    .map_err(|_| {
                        source_changed("Source default Ink document cannot be reopened")
                    })?;
                match &manifest.source {
                    InkSource::Resource {
                        resource_id,
                        source_hash,
                        conversion_revision: existing_revision,
                    } if resource_id == source_resource_id
                        && source_hash == expected_source_hash
                        && existing_revision == conversion_revision => {}
                    _ => {
                        return Err(source_changed(
                            "Source or conversion revision differs from its prepared document",
                        ))
                    }
                }
                verify_source_unchanged(conn, blobs_dir, &source, expected_source_hash)?;
                return Ok(manifest);
            }

            let create_operation_id =
                derived_operation_id("prepare-create", source_resource_id, operation_id);
            let initial = VfsInkRepo::create_blank_with_guard(
                conn,
                blobs_dir,
                PREPARE_TITLE,
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
            let commit_operation_id =
                derived_operation_id("prepare-commit", source_resource_id, operation_id);
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
                    expected_source_hash,
                    source.file_id,
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

fn load_source(
    conn: &Connection,
    blobs_dir: &Path,
    resource_id: &str,
    expected_hash: &str,
) -> VfsResult<SourceFile> {
    let row = conn
        .query_row(
            r#"SELECT r.hash, r.source_id, r.source_table, r.type, r.metadata_json,
                      f.file_name, f.mime_type, f."type", f.blob_hash, f.sha256,
                      f.status, f.compressed_blob_hash
               FROM resources r JOIN files f ON f.id = r.source_id
               WHERE r.id = ?1"#,
            [resource_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| source_changed("Source resource does not resolve to a VFS file"))?;
    let (
        resource_hash,
        source_id,
        source_table,
        resource_type,
        metadata_json,
        file_name,
        mime_type,
        file_type,
        blob_hash,
        sha256,
        status,
        compressed_blob_hash,
    ) = row;
    let file_id =
        source_id.ok_or_else(|| source_changed("Source resource has no file identity"))?;
    let source_table =
        source_table.ok_or_else(|| source_changed("Source resource has no source table"))?;
    let mime_type =
        mime_type.ok_or_else(|| unsupported_source("Source file MIME type is missing"))?;
    let blob_hash = blob_hash.ok_or_else(|| source_changed("Source file blob hash is missing"))?;
    let sha256 = sha256.ok_or_else(|| source_changed("Source file SHA-256 is missing"))?;
    if source_table != "files"
        || resource_type != "file"
        || file_type != "document" && file_type != "image"
        || status.as_deref() != Some("active")
        || compressed_blob_hash.is_some()
        || resource_hash != expected_hash
        || blob_hash != expected_hash
        || sha256 != expected_hash
    {
        return Err(source_changed(
            "Source file identity or hash metadata changed",
        ));
    }
    if VfsInkRepo::is_ink_file_candidate_with_conn(conn, &file_id)? {
        return Err(unsupported_source(
            "An Ink document cannot be prepared as a source",
        ));
    }
    let format = classify_source(&file_name, &mime_type, &file_type)?;
    let blob = VfsBlobRepo::get_blob_with_conn(conn, expected_hash)?
        .ok_or_else(|| source_changed("Source blob is missing"))?;
    if blob.hash != expected_hash || blob.size < 0 || blob.ref_count <= 0 {
        return Err(source_changed("Source blob metadata is invalid"));
    }
    let relative = Path::new(&blob.relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(source_changed("Source blob path is invalid"));
    }
    let source_path = blobs_dir.join(relative);
    if hash_file(&source_path)? != expected_hash {
        return Err(source_changed(
            "Source blob bytes no longer match the expected hash",
        ));
    }
    Ok(SourceFile {
        resource_id: resource_id.to_owned(),
        file_id,
        file_name,
        mime_type,
        file_type,
        blob_hash,
        sha256,
        resource_hash,
        metadata_json,
        format,
    })
}

fn verify_source_unchanged(
    conn: &Connection,
    blobs_dir: &Path,
    source: &SourceFile,
    expected_hash: &str,
) -> VfsResult<()> {
    let current = load_source(conn, blobs_dir, &source.resource_id, expected_hash)?;
    if current.resource_id != source.resource_id
        || current.file_id != source.file_id
        || current.file_name != source.file_name
        || current.mime_type != source.mime_type
        || current.file_type != source.file_type
        || current.blob_hash != source.blob_hash
        || current.sha256 != source.sha256
        || current.resource_hash != source.resource_hash
        || current.format != source.format
    {
        return Err(source_changed("Source changed while preparing Ink pages"));
    }
    Ok(())
}

fn source_resource_id_for_file(conn: &Connection, file_id: &str) -> VfsResult<String> {
    conn.query_row(
        "SELECT id FROM resources WHERE source_id = ?1 AND source_table = 'files' AND type = 'file'",
        [file_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| source_changed("Source resource disappeared while preparing Ink pages"))
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
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if (mime == "application/pdf" || extension == "pdf") && file_type == "document" {
        return Ok(SourceFormat::Pdf);
    }
    if mime.starts_with("image/") && file_type == "image" {
        return Ok(SourceFormat::Image);
    }
    let office_mime = matches!(
        mime,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    if file_type == "document"
        && ((office_mime && matches!(extension.as_str(), "docx" | "pptx"))
            || matches!(extension.as_str(), "docx" | "pptx"))
    {
        return Ok(SourceFormat::Office);
    }
    Err(unsupported_source(
        "Only PDF, image, DOCX, and PPTX sources can be prepared",
    ))
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

fn derived_operation_id(prefix: &str, resource_id: &str, operation_id: &str) -> String {
    let material = format!("deepstudent.dsink.{prefix}.v1\0{resource_id}\0{operation_id}");
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

fn hash_file(path: &Path) -> VfsResult<String> {
    let mut file = File::open(path).map_err(|error| VfsError::Io(error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| VfsError::Io(error.to_string()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
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
        sync::{mpsc, Arc, Barrier},
        thread,
        time::Duration,
    };

    use rusqlite::Connection;

    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        error::VfsError,
        ink::{InkBackground, InkSource},
        repos::{blob_repo::VfsBlobRepo, file_repo::VfsFileRepo, ink_repo::VfsInkRepo},
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

    fn assert_source_changed(result: Result<crate::vfs::ink::InkManifest, VfsError>) {
        match result {
            Err(VfsError::Conflict { key, .. }) => assert_eq!(key, "ink.source_changed"),
            Err(error) => panic!("expected ink.source_changed, got {error}"),
            Ok(_) => panic!("expected ink.source_changed, got a prepared manifest"),
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
