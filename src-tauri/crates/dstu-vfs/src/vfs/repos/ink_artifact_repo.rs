//! Immutable provenance for frozen Ink render artifacts.

use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
};

use image::{codecs::png::PngDecoder, io::Limits, ImageDecoder};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::vfs::{
    error::{VfsError, VfsResult},
    ink::InkRect,
    repos::{blob_repo::VfsBlobRepo, file_repo::VfsFileRepo},
    upload_saga::{with_savepoint, UploadSaga},
};

const PNG_MIME: &str = "image/png";
const PNG_MAX_BYTES: usize = 4 * 1024 * 1024;
const PNG_MAX_DIMENSION: u32 = 2048;
const PNG_MAX_PIXELS: u64 = 16_000_000;

/// Canonical, session-independent provenance for one frozen render.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkArtifact {
    pub artifact_id: String,
    pub render_id: String,
    pub document_id: String,
    pub page_id: String,
    pub revision: String,
    pub source_hash: Option<String>,
    pub source_annotation_revision: Option<String>,
    pub conversion_revision: Option<String>,
    pub crop: Option<InkRect>,
    pub width_px: u32,
    pub height_px: u32,
    pub mime_type: String,
    pub resource_id: String,
    pub file_id: String,
    pub blob_hash: String,
    pub content_hash: String,
    pub created_at: String,
}

/// Provenance supplied by the trusted renderer before its PNG is persisted.
#[derive(Debug, Clone, PartialEq)]
pub struct InkArtifactDraft {
    pub artifact_id: String,
    pub render_id: String,
    pub document_id: String,
    pub page_id: String,
    pub revision: String,
    pub source_hash: Option<String>,
    pub source_annotation_revision: Option<String>,
    pub conversion_revision: Option<String>,
    pub crop: Option<InkRect>,
    pub width_px: u32,
    pub height_px: u32,
}

pub struct VfsInkArtifactRepo;

impl VfsInkArtifactRepo {
    pub fn store_png_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        draft: InkArtifactDraft,
        png: &[u8],
    ) -> VfsResult<InkArtifact> {
        Self::store_png_checked_with_conn(conn, blobs_dir, draft, png, |_| Ok(()))
    }

    pub fn store_png_checked_with_conn<F>(
        conn: &Connection,
        blobs_dir: &Path,
        draft: InkArtifactDraft,
        png: &[u8],
        check: F,
    ) -> VfsResult<InkArtifact>
    where
        F: FnOnce(&Connection) -> VfsResult<()>,
    {
        let (width, height) = validate_png_bytes(png)?;
        if (width, height) != (draft.width_px, draft.height_px) {
            return Err(invalid_artifact(
                "PNG dimensions do not match render metadata",
            ));
        }
        validate_draft(&draft)?;
        if !conn.is_autocommit() {
            return Err(VfsError::InvalidState {
                message: "Ink artifact storage requires an autocommit VFS connection".to_owned(),
            });
        }
        let content_hash = VfsBlobRepo::compute_hash(png);
        let stored_blob =
            VfsBlobRepo::store_blob_with_conn(conn, blobs_dir, png, Some(PNG_MIME), Some("png"))?;
        if stored_blob.hash != content_hash {
            return Err(VfsError::HashCollision { hash: content_hash });
        }
        let mut saga = UploadSaga::new();
        saga.record_blob_ref(&content_hash);

        let stored = with_savepoint(conn, "ink_artifact_store", || {
            // Reserve SQLite's writer lock before the identity read; otherwise another
            // publisher could insert the same immutable render after this transaction's read.
            conn.execute("UPDATE blobs SET ref_count = ref_count WHERE 0", [])?;
            check(conn)?;
            if let Some(existing) = load_artifact_row(conn, &draft.render_id)? {
                if !same_draft(&existing, &draft) || existing.content_hash != content_hash {
                    return Err(render_collision(&draft.render_id));
                }
                let (loaded, bytes) = Self::load_with_conn(conn, blobs_dir, &draft.render_id)?;
                if bytes != png {
                    return Err(render_collision(&draft.render_id));
                }
                return Ok((loaded, false));
            }

            let existing_file = VfsFileRepo::get_by_sha256_with_conn(conn, &content_hash)?;
            if let Some(file) = existing_file.as_ref() {
                if file.file_type != "image"
                    || file.mime_type.as_deref() != Some(PNG_MIME)
                    || file.blob_hash.as_deref() != Some(content_hash.as_str())
                {
                    return Err(VfsError::Conflict {
                        key: "ink.artifact.file_hash_collision".to_owned(),
                        message: "An existing VFS file with the PNG hash has incompatible metadata"
                            .to_owned(),
                    });
                }
            }

            let file = VfsFileRepo::create_file_with_conn(
                conn,
                &content_hash,
                "ink-render.png",
                png.len() as i64,
                "image",
                Some(PNG_MIME),
                Some(&content_hash),
                None,
            )?;
            let resource_id = file
                .resource_id
                .clone()
                .ok_or_else(|| VfsError::InvalidState {
                    message: "Ink render image has no VFS resource".to_owned(),
                })?;
            if existing_file.is_some() {
                VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, &content_hash)?;
            }

            let artifact = InkArtifact {
                artifact_id: draft.artifact_id,
                render_id: draft.render_id,
                document_id: draft.document_id,
                page_id: draft.page_id,
                revision: draft.revision,
                source_hash: draft.source_hash,
                source_annotation_revision: draft.source_annotation_revision,
                conversion_revision: draft.conversion_revision,
                crop: draft.crop,
                width_px: width,
                height_px: height,
                mime_type: PNG_MIME.to_owned(),
                resource_id: resource_id.clone(),
                file_id: file.id.clone(),
                blob_hash: content_hash.clone(),
                content_hash: content_hash.clone(),
                created_at: chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string(),
            };
            let metadata_json = serde_json::to_string(&artifact)
                .map_err(|error| VfsError::Serialization(error.to_string()))?;
            conn.execute(
                "INSERT INTO ink_render_artifacts (render_id, artifact_id, metadata_json, image_blob_hash, image_file_id, image_resource_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    artifact.render_id,
                    artifact.artifact_id,
                    metadata_json,
                    artifact.blob_hash,
                    artifact.file_id,
                    artifact.resource_id,
                    artifact.created_at,
                ],
            )?;
            Ok((artifact, true))
        });

        match stored {
            Ok((artifact, true)) => {
                saga.commit();
                Ok(artifact)
            }
            Ok((artifact, false)) => {
                saga.abort(conn, blobs_dir);
                Ok(artifact)
            }
            Err(error) => {
                saga.abort(conn, blobs_dir);
                Err(error)
            }
        }
    }

    pub fn load_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        render_id: &str,
    ) -> VfsResult<(InkArtifact, Vec<u8>)> {
        let artifact = load_artifact_row(conn, render_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "Ink render artifact".to_owned(),
            id: render_id.to_owned(),
        })?;
        let blob =
            VfsBlobRepo::get_blob_with_conn(conn, &artifact.blob_hash)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "Ink artifact PNG".to_owned(),
                    id: artifact.blob_hash.clone(),
                }
            })?;
        if blob.ref_count < 1 || blob.size < 0 || blob.size as usize > PNG_MAX_BYTES {
            return Err(invalid_artifact("Stored PNG blob metadata is invalid"));
        }
        let relative_path = Path::new(&blob.relative_path);
        if relative_path.is_absolute()
            || relative_path
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(invalid_artifact("Stored PNG blob path is invalid"));
        }
        let path = blobs_dir.join(relative_path);
        let file = File::open(path).map_err(|error| VfsError::Io(error.to_string()))?;
        let mut bytes = Vec::with_capacity(blob.size as usize);
        file.take((PNG_MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| VfsError::Io(error.to_string()))?;
        if bytes.len() > PNG_MAX_BYTES
            || bytes.len() != blob.size as usize
            || VfsBlobRepo::compute_hash(&bytes) != artifact.content_hash
        {
            return Err(invalid_artifact(
                "Stored PNG bytes do not match immutable artifact hash",
            ));
        }
        let (width, height) = validate_png_bytes(&bytes)?;
        if width != artifact.width_px || height != artifact.height_px {
            return Err(invalid_artifact(
                "Stored PNG dimensions do not match immutable artifact",
            ));
        }
        Ok((artifact, bytes))
    }

    pub fn load_for_document_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        render_id: &str,
        document_id: &str,
        revision: &str,
    ) -> VfsResult<(InkArtifact, Vec<u8>)> {
        let (artifact, bytes) = Self::load_with_conn(conn, blobs_dir, render_id)?;
        if artifact.document_id != document_id || artifact.revision != revision {
            return Err(VfsError::Conflict {
                key: "ink.artifact.provenance_mismatch".to_owned(),
                message: "Ink render artifact does not belong to the requested document revision"
                    .to_owned(),
            });
        }
        Ok((artifact, bytes))
    }
}

fn load_artifact_row(conn: &Connection, render_id: &str) -> VfsResult<Option<InkArtifact>> {
    let row = conn
        .query_row(
            "SELECT artifact_id, metadata_json, image_blob_hash, image_file_id, image_resource_id, created_at FROM ink_render_artifacts WHERE render_id = ?1",
            [render_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((artifact_id, metadata, blob_hash, file_id, resource_id, created_at)) = row else {
        return Ok(None);
    };
    let artifact: InkArtifact = serde_json::from_str(&metadata)
        .map_err(|error| VfsError::Serialization(error.to_string()))?;
    if artifact.render_id != render_id
        || artifact.artifact_id != artifact_id
        || artifact.blob_hash != blob_hash
        || artifact.content_hash != blob_hash
        || artifact.file_id != file_id
        || artifact.resource_id != resource_id
        || artifact.created_at != created_at
        || artifact.mime_type != PNG_MIME
    {
        return Err(invalid_artifact(
            "Artifact row and canonical metadata disagree",
        ));
    }
    Ok(Some(artifact))
}

pub fn validate_png_bytes(bytes: &[u8]) -> VfsResult<(u32, u32)> {
    if bytes.is_empty() || bytes.len() > PNG_MAX_BYTES {
        return Err(invalid_artifact("PNG exceeds the 4 MiB artifact limit"));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(PNG_MAX_DIMENSION);
    limits.max_image_height = Some(PNG_MAX_DIMENSION);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let decoder = PngDecoder::with_limits(Cursor::new(bytes), limits)
        .map_err(|_| invalid_artifact("Artifact bytes are not a valid bounded PNG"))?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || u64::from(width) * u64::from(height) > PNG_MAX_PIXELS
        || decoder.total_bytes() > 64 * 1024 * 1024
    {
        return Err(invalid_artifact("PNG dimensions exceed artifact limits"));
    }
    let decoded_size = usize::try_from(decoder.total_bytes())
        .map_err(|_| invalid_artifact("PNG decoded size exceeds platform limits"))?;
    let mut decoded = vec![0; decoded_size];
    decoder
        .read_image(&mut decoded)
        .map_err(|_| invalid_artifact("Artifact PNG payload is malformed"))?;
    Ok((width, height))
}

fn validate_draft(draft: &InkArtifactDraft) -> VfsResult<()> {
    if draft.artifact_id != draft.render_id
        || !valid_id(&draft.render_id)
        || !valid_id(&draft.document_id)
        || !valid_id(&draft.page_id)
        || !valid_id(&draft.revision)
        || draft.width_px == 0
        || draft.height_px == 0
        || draft.width_px > PNG_MAX_DIMENSION
        || draft.height_px > PNG_MAX_DIMENSION
        || u64::from(draft.width_px) * u64::from(draft.height_px) > PNG_MAX_PIXELS
    {
        return Err(invalid_artifact(
            "Ink artifact provenance or dimensions are invalid",
        ));
    }
    if draft
        .source_hash
        .as_deref()
        .is_some_and(|hash| !valid_hash(hash))
    {
        return Err(invalid_artifact(
            "Ink source hash must be lowercase SHA-256 hex",
        ));
    }
    if draft.crop.is_some_and(|crop| {
        !crop.x.is_finite()
            || !crop.y.is_finite()
            || !crop.width.is_finite()
            || !crop.height.is_finite()
            || crop.x < 0.0
            || crop.y < 0.0
            || crop.width <= 0.0
            || crop.height <= 0.0
    }) {
        return Err(invalid_artifact("Ink crop is invalid"));
    }
    for value in [
        draft.source_annotation_revision.as_deref(),
        draft.conversion_revision.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !valid_id(value) {
            return Err(invalid_artifact("Ink provenance revision is invalid"));
        }
    }
    Ok(())
}

fn same_draft(artifact: &InkArtifact, draft: &InkArtifactDraft) -> bool {
    artifact.artifact_id == draft.artifact_id
        && artifact.render_id == draft.render_id
        && artifact.document_id == draft.document_id
        && artifact.page_id == draft.page_id
        && artifact.revision == draft.revision
        && artifact.source_hash == draft.source_hash
        && artifact.source_annotation_revision == draft.source_annotation_revision
        && artifact.conversion_revision == draft.conversion_revision
        && artifact.crop == draft.crop
        && artifact.width_px == draft.width_px
        && artifact.height_px == draft.height_px
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= 128
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn invalid_artifact(message: &str) -> VfsError {
    VfsError::InvalidArgument {
        param: "ink_artifact".to_owned(),
        reason: message.to_owned(),
    }
}

fn render_collision(render_id: &str) -> VfsError {
    VfsError::Conflict {
        key: "ink.artifact.render_id_reused".to_owned(),
        message: format!("Render ID {render_id} already names different immutable content"),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::OptionalExtension;

    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        error::VfsError,
        ink::InkRect,
        repos::blob_repo::VfsBlobRepo,
    };

    use super::{InkArtifactDraft, VfsInkArtifactRepo};

    // Complete 1x1 RGBA PNG generated locally for this test fixture.
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

    fn draft(render_id: &str, revision: &str) -> InkArtifactDraft {
        InkArtifactDraft {
            artifact_id: render_id.to_owned(),
            render_id: render_id.to_owned(),
            document_id: "doc-ink-a".to_owned(),
            page_id: "page-1".to_owned(),
            revision: revision.to_owned(),
            source_hash: Some(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned(),
            ),
            source_annotation_revision: Some("annotations-4".to_owned()),
            conversion_revision: Some("convert-2".to_owned()),
            crop: Some(InkRect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            }),
            width_px: 1,
            height_px: 1,
        }
    }

    #[test]
    fn stores_same_png_as_distinct_immutable_revision_artifacts_and_pins_it() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();

        let first = VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            draft("render-r1", "revision-1"),
            PNG_1X1,
        )
        .unwrap();
        assert_eq!(
            VfsInkArtifactRepo::store_png_with_conn(
                &conn,
                db.blobs_dir(),
                draft("render-r1", "revision-1"),
                PNG_1X1,
            )
            .unwrap(),
            first,
            "an identical render retry must return the same immutable artifact",
        );
        let second = VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            draft("render-r2", "revision-2"),
            PNG_1X1,
        )
        .unwrap();

        assert_ne!(first.artifact_id, second.artifact_id);
        assert_eq!(first.content_hash, VfsBlobRepo::compute_hash(PNG_1X1));
        assert_eq!(second.content_hash, first.content_hash);
        assert_eq!(second.blob_hash, first.blob_hash);
        assert_eq!(second.revision, "revision-2");
        let visible_file_hash: String = conn
            .query_row(
                "SELECT sha256 FROM files WHERE id = ?1",
                [&first.file_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(visible_file_hash, VfsBlobRepo::compute_hash(PNG_1X1));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM ink_render_artifacts", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            2
        );
        let before_delete: i64 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&first.blob_hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            before_delete, 3,
            "one visible file reference plus two artifact pins"
        );

        conn.execute("DELETE FROM files WHERE id = ?1", [&first.file_id])
            .unwrap();
        conn.execute("DELETE FROM resources WHERE id = ?1", [&first.resource_id])
            .unwrap();
        VfsBlobRepo::decrement_ref_with_conn(&conn, db.blobs_dir(), &first.blob_hash).unwrap();
        let after_delete: i64 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&first.blob_hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_delete, 2);

        let (loaded_first, first_png) =
            VfsInkArtifactRepo::load_with_conn(&conn, db.blobs_dir(), &first.render_id).unwrap();
        let (loaded_second, second_png) =
            VfsInkArtifactRepo::load_with_conn(&conn, db.blobs_dir(), &second.render_id).unwrap();
        assert_eq!(loaded_first, first);
        assert_eq!(loaded_second, second);
        assert_eq!(first_png, PNG_1X1);
        assert_eq!(second_png, PNG_1X1);
    }

    #[test]
    fn render_id_collision_with_different_provenance_cannot_mutate_original() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            draft("render-fixed", "revision-1"),
            PNG_1X1,
        )
        .unwrap();

        assert!(VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            draft("render-fixed", "revision-2"),
            PNG_1X1,
        )
        .is_err());
        let (loaded, bytes) =
            VfsInkArtifactRepo::load_with_conn(&conn, db.blobs_dir(), "render-fixed").unwrap();
        assert_eq!(loaded, original);
        assert_eq!(bytes, PNG_1X1);
    }

    #[test]
    fn checked_store_runs_validator_in_writer_transaction_and_releases_png_on_rejection() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let existing = VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            draft("render-existing", "revision-0"),
            PNG_1X1,
        )
        .unwrap();
        let refs_before: i32 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&existing.blob_hash],
                |row| row.get(0),
            )
            .unwrap();
        let mut callback_seen = false;

        let result = VfsInkArtifactRepo::store_png_checked_with_conn(
            &conn,
            db.blobs_dir(),
            draft("render-checked", "revision-1"),
            PNG_1X1,
            |writer_conn| {
                callback_seen = true;
                assert!(!writer_conn.is_autocommit());
                let existing_rows: i64 = writer_conn
                    .query_row(
                        "SELECT COUNT(*) FROM ink_render_artifacts WHERE render_id = 'render-existing'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(existing_rows, 1);
                Err(VfsError::Conflict {
                    key: "ink.artifact.snapshot_changed".to_owned(),
                    message: "source revision changed before artifact publication".to_owned(),
                })
            },
        );

        assert!(
            callback_seen,
            "snapshot check must run before artifact publication"
        );
        assert!(result.is_err());
        let artifact_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ink_render_artifacts WHERE render_id = 'render-checked'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(artifact_rows, 0);
        let refs_after: i32 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&existing.blob_hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            refs_after, refs_before,
            "rejected render cannot leak a deduplicated PNG ref"
        );
    }

    #[test]
    fn document_revision_mismatch_is_rejected_without_session_binding() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let artifact = VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            draft("render-owner", "revision-1"),
            PNG_1X1,
        )
        .unwrap();

        assert!(VfsInkArtifactRepo::load_for_document_with_conn(
            &conn,
            db.blobs_dir(),
            &artifact.render_id,
            "another-document",
            "revision-1",
        )
        .is_err());
        assert!(VfsInkArtifactRepo::load_for_document_with_conn(
            &conn,
            db.blobs_dir(),
            &artifact.render_id,
            &artifact.document_id,
            "revision-2",
        )
        .is_err());
        assert!(VfsInkArtifactRepo::load_for_document_with_conn(
            &conn,
            db.blobs_dir(),
            &artifact.render_id,
            &artifact.document_id,
            &artifact.revision,
        )
        .is_ok());
    }

    #[test]
    fn invalid_and_mismatched_pngs_are_rejected_before_storage() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let mut invalid_source_hash = draft("bad-source", "revision-1");
        invalid_source_hash.source_hash = Some("source-sha256".to_owned());
        assert!(VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            invalid_source_hash,
            PNG_1X1,
        )
        .is_err());
        assert!(VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            draft("bad-png", "revision-1"),
            b"\x89PNG\r\n\x1a\nnot an image",
        )
        .is_err());
        let mut wrong_dimensions = draft("wrong-dimensions", "revision-1");
        wrong_dimensions.width_px = 2;
        assert!(VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            wrong_dimensions,
            PNG_1X1,
        )
        .is_err());
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM ink_render_artifacts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0);
    }
}
