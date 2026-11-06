use std::{
    fs::File,
    io::Read,
    path::{Component, Path},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::vfs::error::{VfsError, VfsResult};

use super::blob_repo::VfsBlobRepo;

pub const INK_SOURCE_MAX_BYTES: u64 = 128 * 1024 * 1024;
const INLINE_MAX_BYTES: u64 = 1024 * 1024;
const INLINE_MAX_BASE64_LEN: i64 = ((INLINE_MAX_BYTES + 2) / 3 * 4) as i64;

const PDF_MIME: &str = "application/pdf";
const DOCX_MIME: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME: &str = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/// Resolve the only four source formats accepted by Ink preparation.
///
/// The extension, MIME type, and VFS file category must all agree. Document
/// formats accept the historical `document`/`file` categories plus their own
/// type alias (`pdf`/`docx`/`pptx`), which is what the textbook import path
/// stores. Images keep the existing PNG/JPEG/WebP/GIF whitelist and must be
/// categorized as `image`.
pub fn ink_source_format(
    file_name: &str,
    mime_type: &str,
    file_type: &str,
) -> Option<&'static str> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    let mime = mime_type.trim().to_ascii_lowercase();
    match extension.as_str() {
        "pdf" if mime == PDF_MIME && matches!(file_type, "document" | "file" | "pdf") => {
            Some("pdf")
        }
        "docx" if mime == DOCX_MIME && matches!(file_type, "document" | "file" | "docx") => {
            Some("docx")
        }
        "pptx" if mime == PPTX_MIME && matches!(file_type, "document" | "file" | "pptx") => {
            Some("pptx")
        }
        "png" if mime == "image/png" && file_type == "image" => Some("image"),
        "jpg" | "jpeg"
            if matches!(mime.as_str(), "image/jpeg" | "image/jpg") && file_type == "image" =>
        {
            Some("image")
        }
        "webp" if mime == "image/webp" && file_type == "image" => Some("image"),
        "gif" if mime == "image/gif" && file_type == "image" => Some("image"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InkSourceIdentity {
    pub resource_id: String,
    pub resource_hash: String,
    pub resource_type: String,
    pub file_id: String,
    pub file_name: String,
    pub mime_type: Option<String>,
    pub file_type: String,
    pub sha256: String,
    pub size: u64,
    pub blob_hash: Option<String>,
    pub storage_mode: String,
    pub metadata_json: Option<String>,
}

#[derive(Debug)]
pub struct InkSourceFile {
    pub identity: InkSourceIdentity,
    pub bytes: Vec<u8>,
}

struct SourceRow {
    resource_hash: String,
    source_id: Option<String>,
    source_table: Option<String>,
    resource_type: String,
    storage_mode: String,
    external_hash: Option<String>,
    data_len: Option<i64>,
    data: Option<String>,
    metadata_json: Option<String>,
    file_id: Option<String>,
    file_resource_id: Option<String>,
    file_name: Option<String>,
    mime_type: Option<String>,
    file_type: Option<String>,
    blob_hash: Option<String>,
    sha256: Option<String>,
    size: Option<i64>,
    status: Option<String>,
    file_deleted: bool,
    resource_deleted: bool,
}

pub fn read_ink_source_with_conn(
    conn: &Connection,
    blobs_dir: &Path,
    resource_id: &str,
    expected_hash: Option<&str>,
) -> VfsResult<Option<InkSourceFile>> {
    load_ink_source_with_conn(conn, blobs_dir, resource_id, expected_hash, true)
}

pub fn validate_ink_source_with_conn(
    conn: &Connection,
    blobs_dir: &Path,
    resource_id: &str,
    expected_hash: Option<&str>,
) -> VfsResult<Option<InkSourceIdentity>> {
    load_ink_source_with_conn(conn, blobs_dir, resource_id, expected_hash, false)
        .map(|source| source.map(|source| source.identity))
}

fn load_ink_source_with_conn(
    conn: &Connection,
    blobs_dir: &Path,
    resource_id: &str,
    expected_hash: Option<&str>,
    retain_bytes: bool,
) -> VfsResult<Option<InkSourceFile>> {
    let row = conn
        .query_row(
            r#"SELECT r.hash, r.source_id, r.source_table, r.type, r.storage_mode,
                      r.external_hash, length(CAST(r.data AS BLOB)),
                      CASE WHEN length(CAST(r.data AS BLOB)) <= ?2 THEN r.data ELSE NULL END,
                      r.metadata_json, f.id, f.resource_id, f.file_name, f.mime_type,
                      f."type", f.blob_hash, f.sha256, f.size, f.status,
                      f.deleted_at IS NOT NULL, r.deleted_at IS NOT NULL
               FROM resources r LEFT JOIN files f ON f.id = r.source_id
               WHERE r.id = ?1"#,
            params![resource_id, INLINE_MAX_BASE64_LEN],
            |row| {
                Ok(SourceRow {
                    resource_hash: row.get(0)?,
                    source_id: row.get(1)?,
                    source_table: row.get(2)?,
                    resource_type: row.get(3)?,
                    storage_mode: row.get(4)?,
                    external_hash: row.get(5)?,
                    data_len: row.get(6)?,
                    data: row.get(7)?,
                    metadata_json: row.get(8)?,
                    file_id: row.get(9)?,
                    file_resource_id: row.get(10)?,
                    file_name: row.get(11)?,
                    mime_type: row.get(12)?,
                    file_type: row.get(13)?,
                    blob_hash: row.get(14)?,
                    sha256: row.get(15)?,
                    size: row.get(16)?,
                    status: row.get(17)?,
                    file_deleted: row.get(18)?,
                    resource_deleted: row.get(19)?,
                })
            },
        )
        .optional()?;
    let Some(row) = row else {
        let linked_file: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM files WHERE resource_id = ?1)",
            [resource_id],
            |row| row.get(0),
        )?;
        if linked_file {
            return Err(source_changed("Source file points to a missing resource"));
        }
        return Ok(None);
    };
    let file_id = row
        .file_id
        .as_deref()
        .ok_or_else(|| source_changed("Source resource does not resolve to a VFS file"))?;
    let file_name = row
        .file_name
        .as_deref()
        .ok_or_else(|| source_changed("Source file name is missing"))?;
    let file_type = row
        .file_type
        .as_deref()
        .ok_or_else(|| source_changed("Source file type is missing"))?;
    let mime_type = row
        .mime_type
        .as_deref()
        .ok_or_else(|| source_changed("Source file MIME type is missing"))?;
    let format = ink_source_format(file_name, mime_type, file_type).ok_or_else(|| {
        unsupported_format("Only PDF, image, DOCX, and PPTX sources are supported")
    })?;
    let sha256 = row
        .sha256
        .as_deref()
        .filter(|hash| valid_hash(hash))
        .ok_or_else(|| source_changed("Source file SHA-256 is invalid"))?;
    let size = row
        .size
        .filter(|size| *size >= 0)
        .ok_or_else(|| source_changed("Source file size is invalid"))? as u64;
    if size > INK_SOURCE_MAX_BYTES {
        return Err(limit_exceeded(
            "Source file exceeds the 128 MiB preparation limit",
        ));
    }
    // Textbook imports keep the original bytes in `blobs`, while the inline
    // `resources.data` column stores extracted text (possibly larger than the
    // 1 MiB inline payload limit). Blob-backed inline resources therefore use
    // the blob as the only payload and never interpret `data` as bytes/base64.
    let inline_blob_resource = row.blob_hash.is_some()
        && row.storage_mode == "inline"
        && row.external_hash.is_none()
        && row.data_len.is_some();
    let external_blob_resource = row.blob_hash.is_some()
        && row.storage_mode == "external"
        && row.external_hash.as_deref() == row.blob_hash.as_deref()
        && row.data_len.is_none();
    let storage_matches = if row.blob_hash.is_some() {
        inline_blob_resource || external_blob_resource
    } else {
        row.storage_mode == "inline" && row.external_hash.is_none() && row.data_len.is_some()
    };
    let resource_type_matches = match format {
        "pdf" | "docx" | "pptx" => row.resource_type == "file",
        "image" => {
            row.resource_type == "image" || (row.resource_type == "file" && inline_blob_resource)
        }
        _ => false,
    };
    if row.source_id.as_deref() != Some(file_id)
        || row.source_table.as_deref() != Some("files")
        || row.file_resource_id.as_deref() != Some(resource_id)
        || row.status.as_deref() != Some("active")
        || row.file_deleted
        || row.resource_deleted
        || !resource_type_matches
        || !storage_matches
        || !valid_hash(&row.resource_hash)
        || expected_hash.is_some_and(|expected| expected != sha256)
    {
        return Err(source_changed(
            "Source file linkage, type, storage, status, or hash changed",
        ));
    }

    let bytes = if let Some(blob_hash) = row.blob_hash.as_deref() {
        if blob_hash != sha256
            || row.resource_hash != sha256
            || !(inline_blob_resource || external_blob_resource)
        {
            return Err(source_changed(
                "Source blob and resource identities disagree",
            ));
        }
        read_blob_bytes(conn, blobs_dir, blob_hash, size, retain_bytes)?
    } else {
        if size > INLINE_MAX_BYTES
            || row
                .data_len
                .is_some_and(|length| length > INLINE_MAX_BASE64_LEN)
        {
            return Err(limit_exceeded(
                "Inline source exceeds the 1 MiB storage limit",
            ));
        }
        let data = row
            .data
            .as_deref()
            .ok_or_else(|| source_changed("Inline source data is missing"))?;
        let expected_base64_len = ((size + 2) / 3 * 4) as i64;
        if row.storage_mode != "inline"
            || row.external_hash.is_some()
            || row.data_len != Some(expected_base64_len)
            || VfsBlobRepo::compute_hash(data.as_bytes()) != row.resource_hash
        {
            return Err(source_changed(
                "Inline source storage or text hash is invalid",
            ));
        }
        let bytes = STANDARD
            .decode(data)
            .map_err(|_| source_changed("Inline source data is not valid base64"))?;
        if bytes.len() as u64 != size || VfsBlobRepo::compute_hash(&bytes) != sha256 {
            return Err(source_changed(
                "Source bytes no longer match their SHA-256 and size",
            ));
        }
        if retain_bytes {
            bytes
        } else {
            Vec::new()
        }
    };
    Ok(Some(InkSourceFile {
        identity: InkSourceIdentity {
            resource_id: resource_id.to_owned(),
            resource_hash: row.resource_hash,
            resource_type: row.resource_type,
            file_id: file_id.to_owned(),
            file_name: row
                .file_name
                .ok_or_else(|| source_changed("Source file name is missing"))?,
            mime_type: row.mime_type,
            file_type: file_type.to_owned(),
            sha256: sha256.to_owned(),
            size,
            blob_hash: row.blob_hash,
            storage_mode: row.storage_mode,
            metadata_json: row.metadata_json,
        },
        bytes,
    }))
}

fn read_blob_bytes(
    conn: &Connection,
    blobs_dir: &Path,
    hash: &str,
    size: u64,
    retain_bytes: bool,
) -> VfsResult<Vec<u8>> {
    let blob = VfsBlobRepo::get_blob_with_conn(conn, hash)?
        .ok_or_else(|| source_changed("Source blob is missing"))?;
    if blob.hash != hash || blob.ref_count <= 0 || blob.size < 0 || blob.size as u64 != size {
        return Err(source_changed("Source blob metadata is invalid"));
    }
    let relative = Path::new(&blob.relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(source_changed("Source blob path is invalid"));
    }
    let root = blobs_dir
        .canonicalize()
        .map_err(|_| source_changed("Source blob directory is missing"))?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| source_changed("Source blob file is missing"))?;
    if !path.starts_with(&root) {
        return Err(source_changed(
            "Source blob path escapes its storage directory",
        ));
    }
    let mut file =
        File::open(path).map_err(|_| source_changed("Source blob file cannot be opened"))?;
    let metadata = file
        .metadata()
        .map_err(|_| source_changed("Source blob file metadata cannot be read"))?;
    if !metadata.is_file() || metadata.len() != size {
        return Err(source_changed("Source blob file size changed"));
    }
    let mut bytes = if retain_bytes {
        Vec::with_capacity(size as usize)
    } else {
        Vec::new()
    };
    let mut hasher = Sha256::new();
    let mut remaining = size;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let length = remaining.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..length])
            .map_err(|_| source_changed("Source blob bytes changed while reading"))?;
        hasher.update(&buffer[..length]);
        if retain_bytes {
            bytes.extend_from_slice(&buffer[..length]);
        }
        remaining -= length as u64;
    }
    let mut trailing = [0_u8; 1];
    if file
        .read(&mut trailing)
        .map_err(|error| VfsError::Io(error.to_string()))?
        != 0
    {
        return Err(source_changed("Source blob grew while reading"));
    }
    if hex::encode(hasher.finalize()) != hash {
        return Err(source_changed(
            "Source blob bytes no longer match their SHA-256",
        ));
    }
    Ok(bytes)
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn source_changed(message: &str) -> VfsError {
    VfsError::Conflict {
        key: "ink.source_changed".to_owned(),
        message: message.to_owned(),
    }
}

fn unsupported_format(message: &str) -> VfsError {
    VfsError::InvalidArgument {
        param: "file_name".to_owned(),
        reason: message.to_owned(),
    }
}

fn limit_exceeded(message: &str) -> VfsError {
    VfsError::Conflict {
        key: "ink.limit_exceeded".to_owned(),
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::ImageEncoder;
    use rusqlite::params;

    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        error::VfsError,
        repos::{blob_repo::VfsBlobRepo, textbook_repo::VfsTextbookRepo, VfsAttachmentRepo},
        types::VfsUploadAttachmentParams,
    };

    use super::{
        ink_source_format, read_ink_source_with_conn, validate_ink_source_with_conn,
        INK_SOURCE_MAX_BYTES, INLINE_MAX_BASE64_LEN,
    };

    fn png(color: u8) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[color, 23, 51, 255], 1, 1, image::ColorType::Rgba8)
            .unwrap();
        bytes
    }

    fn minimal_pdf() -> Vec<u8> {
        b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
            .to_vec()
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
        conn: &rusqlite::Connection,
        db: &VfsDatabase,
        bytes: &[u8],
        file_name: &str,
        mime_type: &str,
        extracted_text: Option<&str>,
        page_count: Option<i32>,
    ) -> (String, String, String) {
        let extension = file_name.rsplit('.').next().unwrap_or("bin");
        let blob = VfsBlobRepo::store_blob_with_conn(
            conn,
            db.blobs_dir(),
            bytes,
            Some(mime_type),
            Some(extension),
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
            extracted_text,
            page_count,
        )
        .unwrap();
        (textbook.resource_id.unwrap(), textbook.id, blob.hash)
    }

    fn upload(conn: &rusqlite::Connection, db: &VfsDatabase, bytes: &[u8]) -> (String, String) {
        let uploaded = VfsAttachmentRepo::upload_bytes_with_conn(
            conn,
            db.blobs_dir(),
            &VfsUploadAttachmentParams {
                name: "source.png".to_owned(),
                mime_type: "image/png".to_owned(),
                base64_content: String::new(),
                attachment_type: Some("image".to_owned()),
            },
            bytes,
        )
        .unwrap();
        (uploaded.attachment.resource_id.unwrap(), uploaded.source_id)
    }

    fn assert_conflict<T: std::fmt::Debug>(result: Result<T, VfsError>, expected_key: &str) {
        match result {
            Err(VfsError::Conflict { key, .. }) => assert_eq!(key, expected_key),
            other => panic!("expected {expected_key}, got {other:?}"),
        }
    }

    #[test]
    fn reads_real_inline_image_upload_without_changing_resource_hash_or_data() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let bytes = png(1);
        let (resource_id, file_id) = upload(&conn, &db, &bytes);
        let before: (String, String) = conn
            .query_row(
                "SELECT hash, data FROM resources WHERE id = ?1",
                [&resource_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let source_hash = VfsBlobRepo::compute_hash(&bytes);
        let source =
            read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&source_hash))
                .unwrap()
                .unwrap();
        assert_eq!(source.bytes, bytes);
        assert_eq!(source.identity.file_id, file_id);
        assert_eq!(source.identity.sha256, source_hash);
        assert_eq!(source.identity.resource_hash, before.0);
        assert_ne!(source.identity.resource_hash, source_hash);
        assert_eq!(source.identity.resource_type, "image");
        assert!(source.identity.blob_hash.is_none());
        assert_eq!(
            validate_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&source_hash))
                .unwrap()
                .unwrap(),
            source.identity,
        );
        let after: (String, String) = conn
            .query_row(
                "SELECT hash, data FROM resources WHERE id = ?1",
                [&resource_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn ink_source_format_requires_matching_extension_mime_and_category() {
        assert_eq!(
            ink_source_format("讲义.pdf", "application/pdf", "document"),
            Some("pdf")
        );
        assert_eq!(
            ink_source_format("report.PDF", "Application/PDF", "file"),
            Some("pdf")
        );
        assert_eq!(
            ink_source_format("alias.pdf", "application/pdf", "pdf"),
            Some("pdf")
        );
        assert_eq!(
            ink_source_format(
                "word.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "docx"
            ),
            Some("docx")
        );
        assert_eq!(
            ink_source_format(
                "slides.pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "pptx"
            ),
            Some("pptx")
        );
        for name in [
            "photo.png",
            "photo.jpg",
            "photo.jpeg",
            "photo.webp",
            "photo.gif",
        ] {
            let mime = if name.ends_with(".png") {
                "image/png"
            } else if name.ends_with(".webp") {
                "image/webp"
            } else if name.ends_with(".gif") {
                "image/gif"
            } else {
                "image/jpeg"
            };
            assert_eq!(ink_source_format(name, mime, "image"), Some("image"));
        }
        assert_eq!(
            ink_source_format("photo.jpg", "image/jpg", "image"),
            Some("image")
        );

        for (name, mime, file_type) in [
            ("report.pdf", "application/pdf", "image"),
            ("report.pdf", "application/pdf", "docx"),
            ("report.pdf", "text/plain", "document"),
            ("report.docx", "application/pdf", "document"),
            ("report.docx", "application/octet-stream", "docx"),
            ("report.doc", "application/msword", "document"),
            ("report.ppt", "application/vnd.ms-powerpoint", "document"),
            (
                "report.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "document",
            ),
            ("report.epub", "application/epub+zip", "document"),
            ("photo.png", "image/jpeg", "image"),
            ("photo.png", "image/png", "file"),
            ("photo.svg", "image/svg+xml", "image"),
            ("photo.bmp", "image/bmp", "image"),
            ("photo.heic", "image/heic", "image"),
        ] {
            assert_eq!(
                ink_source_format(name, mime, file_type),
                None,
                "{name} / {mime} / {file_type} must be rejected"
            );
        }
    }

    #[test]
    fn reads_and_validates_textbook_imports_for_all_four_supported_formats() {
        let cases = vec![
            (
                "讲义.pdf",
                "application/pdf",
                "pdf",
                minimal_pdf(),
                Some("PDF extracted text"),
            ),
            ("图片.png", "image/png", "image", png(7), None),
            (
                "文档.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "docx",
                docx_bytes(),
                Some("DOCX extracted text"),
            ),
            (
                "幻灯片.pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "pptx",
                pptx_bytes(),
                Some("PPTX extracted text"),
            ),
        ];

        for (file_name, mime_type, expected_type, bytes, extracted_text) in cases {
            let (_temp_dir, db) = setup_migrated_test_db();
            let conn = db.get_conn_safe().unwrap();
            let (resource_id, _file_id, hash) = textbook_source(
                &conn,
                &db,
                &bytes,
                file_name,
                mime_type,
                extracted_text,
                Some(1),
            );
            let source =
                read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash))
                    .unwrap()
                    .unwrap();
            assert_eq!(source.bytes, bytes, "{file_name}");
            assert_eq!(source.identity.file_type, expected_type);
            assert_eq!(source.identity.resource_type, "file");
            assert_eq!(source.identity.storage_mode, "inline");
            assert_eq!(source.identity.blob_hash.as_deref(), Some(hash.as_str()));
            assert_eq!(source.identity.resource_hash, hash);
            assert_eq!(source.identity.sha256, hash);
            assert_eq!(source.identity.mime_type.as_deref(), Some(mime_type));
            assert_eq!(
                validate_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash),)
                    .unwrap()
                    .unwrap(),
                source.identity,
            );
            let stored_text: String = conn
                .query_row(
                    "SELECT data FROM resources WHERE id = ?1",
                    [&resource_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(stored_text, extracted_text.unwrap_or_default());
        }
    }

    #[test]
    fn textbook_extracted_text_over_inline_limit_is_never_used_as_payload() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let bytes = minimal_pdf();
        let extracted_text =
            "not base64 extracted text! ".repeat((INLINE_MAX_BASE64_LEN as usize / 26) + 32);
        assert!(extracted_text.len() as i64 > INLINE_MAX_BASE64_LEN);
        let (resource_id, _file_id, hash) = textbook_source(
            &conn,
            &db,
            &bytes,
            "large-text.pdf",
            "application/pdf",
            Some(&extracted_text),
            Some(1),
        );
        let source = read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash))
            .unwrap()
            .unwrap();
        assert_eq!(source.bytes, bytes);
        assert_eq!(source.identity.sha256, hash);
        assert!(
            validate_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash),)
                .unwrap()
                .is_some()
        );
        let stored_len: i64 = conn
            .query_row(
                "SELECT length(CAST(data AS BLOB)) FROM resources WHERE id = ?1",
                [&resource_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_len, extracted_text.len() as i64);
    }

    #[test]
    fn textbook_copy_hash_suffix_hash_drift_and_corrupted_blob_are_rejected() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let bytes = minimal_pdf();
        let (resource_id, file_id, hash) = textbook_source(
            &conn,
            &db,
            &bytes,
            "source.pdf",
            "application/pdf",
            Some("extracted"),
            Some(1),
        );

        conn.execute(
            "UPDATE files SET sha256 = ?1 WHERE id = ?2",
            params![format!("{hash}_copy_deadbeef"), file_id],
        )
        .unwrap();
        assert_conflict(
            read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash)),
            "ink.source_changed",
        );
        assert_conflict(
            validate_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash)),
            "ink.source_changed",
        );

        let drifted = VfsBlobRepo::compute_hash(b"different source bytes");
        conn.execute(
            "UPDATE files SET sha256 = ?1 WHERE id = ?2",
            params![drifted, file_id],
        )
        .unwrap();
        assert_conflict(
            read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&drifted)),
            "ink.source_changed",
        );
        conn.execute(
            "UPDATE files SET sha256 = ?1 WHERE id = ?2",
            params![hash, file_id],
        )
        .unwrap();

        let blob = VfsBlobRepo::get_blob_with_conn(&conn, &hash)
            .unwrap()
            .unwrap();
        let blob_path = db.blobs_dir().join(&blob.relative_path);
        let mut corrupted = std::fs::read(&blob_path).unwrap();
        corrupted[0] ^= 1;
        std::fs::write(&blob_path, &corrupted).unwrap();
        assert_conflict(
            read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash)),
            "ink.source_changed",
        );
        assert_conflict(
            validate_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash)),
            "ink.source_changed",
        );
    }

    #[test]
    fn rejects_integer_and_iso8601_deleted_markers_for_files_and_resources() {
        use rusqlite::types::Value as SqlValue;

        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let bytes = png(1);
        let (resource_id, file_id) = upload(&conn, &db, &bytes);
        let source_hash = VfsBlobRepo::compute_hash(&bytes);
        for (table, id) in [("files", &file_id), ("resources", &resource_id)] {
            let update = format!("UPDATE {table} SET deleted_at = ?1 WHERE id = ?2");
            for marker in [
                SqlValue::Integer(0),
                SqlValue::Integer(1),
                SqlValue::Text("2026-11-04T12:34:56.789Z".to_owned()),
            ] {
                conn.execute(&update, params![marker, id]).unwrap();
                assert_conflict(
                    read_ink_source_with_conn(
                        &conn,
                        db.blobs_dir(),
                        &resource_id,
                        Some(&source_hash),
                    ),
                    "ink.source_changed",
                );
                assert_conflict(
                    validate_ink_source_with_conn(
                        &conn,
                        db.blobs_dir(),
                        &resource_id,
                        Some(&source_hash),
                    ),
                    "ink.source_changed",
                );
                conn.execute(&update, params![SqlValue::Null, id]).unwrap();
                assert!(read_ink_source_with_conn(
                    &conn,
                    db.blobs_dir(),
                    &resource_id,
                    Some(&source_hash),
                )
                .unwrap()
                .is_some());
                assert!(validate_ink_source_with_conn(
                    &conn,
                    db.blobs_dir(),
                    &resource_id,
                    Some(&source_hash),
                )
                .unwrap()
                .is_some());
            }
        }
    }

    #[test]
    fn rejects_inline_corruption_changed_source_and_invalid_links() {
        for mutation in [
            "data",
            "text_hash",
            "decoded_hash",
            "invalid_base64",
            "changed_source",
            "storage_mode",
            "external_hash",
            "source_id",
            "source_table",
            "reverse_link",
            "type",
            "status",
            "deleted_at",
            "resource_deleted_at",
            "size",
            "expected_hash",
            "missing_resource",
        ] {
            let (_temp_dir, db) = setup_migrated_test_db();
            let conn = db.get_conn_safe().unwrap();
            let bytes = png(1);
            let (resource_id, file_id) = upload(&conn, &db, &bytes);
            let source_hash = VfsBlobRepo::compute_hash(&bytes);
            let mut expected_hash = source_hash.clone();
            match mutation {
                "data" => {
                    conn.execute(
                        "UPDATE resources SET data = 'AAAA' WHERE id = ?1",
                        [&resource_id],
                    )
                    .unwrap();
                }
                "text_hash" => {
                    conn.execute(
                        "UPDATE resources SET hash = ?1 WHERE id = ?2",
                        params!["a".repeat(64), resource_id],
                    )
                    .unwrap();
                }
                "decoded_hash" | "invalid_base64" => {
                    let mut changed = bytes.clone();
                    changed[20] ^= 1;
                    let data = if mutation == "decoded_hash" {
                        STANDARD.encode(changed)
                    } else {
                        "!".repeat(STANDARD.encode(&bytes).len())
                    };
                    conn.execute(
                        "UPDATE resources SET data = ?1, hash = ?2 WHERE id = ?3",
                        params![
                            data,
                            VfsBlobRepo::compute_hash(data.as_bytes()),
                            resource_id
                        ],
                    )
                    .unwrap();
                }
                "changed_source" => {
                    let mut changed = bytes.clone();
                    changed[20] ^= 1;
                    let data = STANDARD.encode(&changed);
                    conn.execute(
                        "UPDATE files SET sha256 = ?1, content_hash = ?1 WHERE id = ?2",
                        params![VfsBlobRepo::compute_hash(&changed), file_id],
                    )
                    .unwrap();
                    conn.execute(
                        "UPDATE resources SET data = ?1, hash = ?2 WHERE id = ?3",
                        params![
                            data,
                            VfsBlobRepo::compute_hash(data.as_bytes()),
                            resource_id
                        ],
                    )
                    .unwrap();
                }
                "storage_mode" => {
                    conn.execute(
                        "UPDATE resources SET storage_mode = 'external' WHERE id = ?1",
                        [&resource_id],
                    )
                    .unwrap();
                }
                "external_hash" => {
                    conn.execute(
                        "UPDATE resources SET external_hash = ?1 WHERE id = ?2",
                        params![source_hash, resource_id],
                    )
                    .unwrap();
                }
                "source_id" => {
                    let (_, other_file) = upload(&conn, &db, &png(2));
                    conn.execute(
                        "UPDATE resources SET source_id = ?1 WHERE id = ?2",
                        params![other_file, resource_id],
                    )
                    .unwrap();
                }
                "source_table" => {
                    conn.execute(
                        "UPDATE resources SET source_table = 'notes' WHERE id = ?1",
                        [&resource_id],
                    )
                    .unwrap();
                }
                "reverse_link" => {
                    let (other_resource, _) = upload(&conn, &db, &png(2));
                    conn.execute(
                        "UPDATE files SET resource_id = ?1 WHERE id = ?2",
                        params![other_resource, file_id],
                    )
                    .unwrap();
                }
                "type" => {
                    conn.execute(
                        "UPDATE resources SET type = 'file' WHERE id = ?1",
                        [&resource_id],
                    )
                    .unwrap();
                }
                "status" => {
                    conn.execute(
                        "UPDATE files SET status = 'deleted' WHERE id = ?1",
                        [&file_id],
                    )
                    .unwrap();
                }
                "deleted_at" => {
                    conn.execute(
                        "UPDATE files SET deleted_at = '2026-11-04' WHERE id = ?1",
                        [&file_id],
                    )
                    .unwrap();
                }
                "resource_deleted_at" => {
                    conn.execute(
                        "UPDATE resources SET deleted_at = 1 WHERE id = ?1",
                        [&resource_id],
                    )
                    .unwrap();
                }
                "size" => {
                    conn.execute("UPDATE files SET size = size + 1 WHERE id = ?1", [&file_id])
                        .unwrap();
                }
                "expected_hash" => expected_hash = "a".repeat(64),
                "missing_resource" => {
                    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
                    conn.execute("DELETE FROM resources WHERE id = ?1", [&resource_id])
                        .unwrap();
                    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
                }
                _ => unreachable!(),
            }
            assert_conflict(
                read_ink_source_with_conn(
                    &conn,
                    db.blobs_dir(),
                    &resource_id,
                    Some(&expected_hash),
                ),
                "ink.source_changed",
            );
            assert_conflict(
                validate_ink_source_with_conn(
                    &conn,
                    db.blobs_dir(),
                    &resource_id,
                    Some(&expected_hash),
                ),
                "ink.source_changed",
            );
        }
    }

    #[test]
    fn external_upload_requires_matching_bytes_blob_metadata_and_safe_path() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let mut bytes = png(1);
        bytes.resize(1024 * 1024, 0);
        let (resource_id, file_id) = upload(&conn, &db, &bytes);
        let hash = VfsBlobRepo::compute_hash(&bytes);
        conn.execute(
            "UPDATE files SET compressed_blob_hash = blob_hash WHERE id = ?1",
            [&file_id],
        )
        .unwrap();
        let source = read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash))
            .unwrap()
            .unwrap();
        assert_eq!(source.bytes, bytes);
        assert_eq!(source.identity.storage_mode, "external");
        assert_eq!(source.identity.blob_hash.as_deref(), Some(hash.as_str()));
        assert_eq!(
            validate_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash))
                .unwrap()
                .unwrap(),
            source.identity,
        );
        let blob = VfsBlobRepo::get_blob_with_conn(&conn, &hash)
            .unwrap()
            .unwrap();
        #[cfg(unix)]
        {
            let outside = db.blobs_dir().parent().unwrap().join("outside-source.png");
            std::fs::write(&outside, &bytes).unwrap();
            std::os::unix::fs::symlink(&outside, db.blobs_dir().join("escaped-source.png"))
                .unwrap();
            conn.execute(
                "UPDATE blobs SET relative_path = 'escaped-source.png' WHERE hash = ?1",
                [&hash],
            )
            .unwrap();
            assert_conflict(
                read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash)),
                "ink.source_changed",
            );
        }
        for path in ["../outside.png", "/outside.png"] {
            conn.execute(
                "UPDATE blobs SET relative_path = ?1 WHERE hash = ?2",
                params![path, hash],
            )
            .unwrap();
            assert_conflict(
                read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash)),
                "ink.source_changed",
            );
        }
        conn.execute(
            "UPDATE blobs SET relative_path = ?1, size = size + 1 WHERE hash = ?2",
            params![blob.relative_path, hash],
        )
        .unwrap();
        assert_conflict(
            read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash)),
            "ink.source_changed",
        );
        conn.execute("UPDATE blobs SET size = size - 1 WHERE hash = ?1", [&hash])
            .unwrap();
        bytes[20] ^= 1;
        std::fs::write(db.blobs_dir().join(&blob.relative_path), &bytes).unwrap();
        assert_conflict(
            read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash)),
            "ink.source_changed",
        );
        assert_conflict(
            validate_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, Some(&hash)),
            "ink.source_changed",
        );
    }

    #[test]
    fn source_and_inline_budgets_are_checked_before_materializing_payloads() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let bytes = png(1);
        let (resource_id, file_id) = upload(&conn, &db, &bytes);
        conn.execute(
            "UPDATE files SET size = ?1 WHERE id = ?2",
            params![(INK_SOURCE_MAX_BYTES + 1) as i64, file_id],
        )
        .unwrap();
        assert_conflict(
            read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, None),
            "ink.limit_exceeded",
        );
        conn.execute(
            "UPDATE files SET size = ?1 WHERE id = ?2",
            params![bytes.len() as i64, file_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE resources SET data = ?1 WHERE id = ?2",
            params!["A".repeat(INLINE_MAX_BASE64_LEN as usize + 4), resource_id],
        )
        .unwrap();
        assert_conflict(
            read_ink_source_with_conn(&conn, db.blobs_dir(), &resource_id, None),
            "ink.limit_exceeded",
        );
        assert!(
            read_ink_source_with_conn(&conn, db.blobs_dir(), "purged-source", None)
                .unwrap()
                .is_none()
        );
    }
}
