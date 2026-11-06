use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{ChangeOperation, SyncChangeWithData, SyncError, SyncManager};
use crate::vfs::{
    ink::{
        parse_board_chunk, parse_manifest, parse_page, InkManifest, INK_BOARD_CHUNK_MAX_BYTES,
        INK_BOARD_SCHEMA_VERSION, INK_EXTENSION, INK_MANIFEST_MAX_BYTES, INK_MIME,
        INK_PAGE_MAX_BYTES, INK_SCHEMA_VERSION,
    },
    repos::{ink_artifact_repo::validate_png_bytes, InkArtifact, VfsBlobRepo},
};

const DSINK_MIME: &str = INK_MIME;

/// Validate the complete canonical pointer group in one files-row payload.
pub(super) fn validate_ink_change(data: &Value) -> Result<(), SyncError> {
    let invalid =
        |reason: &str| SyncError::Database(format!("invalid dsink pointer tuple: {reason}"));
    let object = data
        .as_object()
        .ok_or_else(|| invalid("files row is not an object"))?;
    let required_string = |field: &str| {
        object
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid(&format!("missing or empty {field}")))
    };

    let id = required_string("id")?;
    let file_name = required_string("file_name")?;
    if !file_name
        .to_ascii_lowercase()
        .ends_with(&format!(".{INK_EXTENSION}"))
    {
        return Err(invalid("file_name does not identify a .dsink file"));
    }
    if required_string("mime_type")? != DSINK_MIME {
        return Err(invalid("mime_type does not match dsink"));
    }
    if required_string("type")? != "document" {
        return Err(invalid("type does not match dsink"));
    }
    let blob_hash = required_string("blob_hash")?;
    let sha256 = required_string("sha256")?;
    if !is_sha256(blob_hash) || sha256 != blob_hash {
        return Err(invalid("blob_hash and sha256 must be the same SHA-256"));
    }

    let preview_json = required_string("preview_json")?;
    let preview: Value =
        serde_json::from_str(preview_json).map_err(|_| invalid("preview_json is invalid JSON"))?;
    let ink = preview
        .get("ink")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("preview_json.ink is missing"))?;
    if ink.get("schema_version").and_then(Value::as_u64) != Some(INK_SCHEMA_VERSION as u64)
        && ink.get("schema_version").and_then(Value::as_u64)
            != Some(INK_BOARD_SCHEMA_VERSION as u64)
    {
        return Err(invalid("unsupported preview schema_version"));
    }
    if ink.get("document_id").and_then(Value::as_str) != Some(id) {
        return Err(invalid("document_id does not match files.id"));
    }
    if ink
        .get("revision")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(invalid("revision is missing"));
    }
    if ink.get("manifest_blob_hash").and_then(Value::as_str) != Some(blob_hash) {
        return Err(invalid("manifest_blob_hash does not match files.blob_hash"));
    }
    let refs = ink
        .get("blob_refs")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("blob_refs is missing or not an array"))?;
    let mut hashes = Vec::with_capacity(refs.len());
    for value in refs {
        let hash = value
            .as_str()
            .filter(|value| is_sha256(value))
            .ok_or_else(|| invalid("blob_refs contains an invalid SHA-256"))?;
        hashes.push(hash.to_owned());
    }
    let mut canonical = hashes.clone();
    canonical.sort();
    canonical.dedup();
    if hashes != canonical {
        return Err(invalid("blob_refs must be sorted and unique"));
    }
    Ok(())
}

/// A board v2 change is any files-row upsert whose canonical preview says
/// `ink.schema_version = 2`. Upload paths use this to require `ink_board_v2`
/// before the first board row/blob is published.
pub(super) fn is_board_v2_change(change: &SyncChangeWithData) -> bool {
    change.table_name == "files" && change.data.as_ref().is_some_and(is_board_v2_row)
}

pub(super) fn is_board_v2_row(row: &Value) -> bool {
    row.get("preview_json")
        .and_then(Value::as_str)
        .and_then(|preview| serde_json::from_str::<Value>(preview).ok())
        .and_then(|preview| {
            preview
                .get("ink")
                .and_then(|ink| ink.get("schema_version"))
                .and_then(Value::as_u64)
        })
        == Some(INK_BOARD_SCHEMA_VERSION as u64)
}

/// Install the VFS board writer guard after a canonical board v2 row has been
/// verified and published inside the caller's apply transaction.
///
/// The caller must invoke this only after [`validate_change`] verified the full
/// manifest/page/chunk closure and after the files row write succeeded for an
/// actually applied board v2 change. Missing chunks therefore quarantine before
/// this point, and v1 changes never install the guard.
///
/// The connection must already have the VFS writer capability registered by
/// `VfsDatabase` initialization. An unregistered connection fails closed
/// (`enable_vfs_board_writer_guard` cannot call the capability function) rather
/// than being silently registered as an unknown legacy writer here.
pub(super) fn ensure_board_writer_guard_after_publish(
    conn: &Connection,
    change: &SyncChangeWithData,
) -> Result<(), SyncError> {
    if !matches!(
        change.operation,
        ChangeOperation::Insert | ChangeOperation::Update
    ) || !is_board_v2_change(change)
    {
        return Ok(());
    }

    let installed = dstu_storage::sqlite_capability::vfs_board_writer_guard_installed(conn)
        .map_err(|error| SyncError::Database(format!("inspect VFS board writer guard: {error}")))?;
    if installed {
        return Ok(());
    }

    dstu_storage::sqlite_capability::enable_vfs_board_writer_guard(conn)
        .map_err(|error| SyncError::Database(format!("install VFS board writer guard: {error}")))?;
    Ok(())
}

/// Guard both ordinary and conflict-aware sync paths against dsink partial-row patches.
pub(super) fn validate_change(
    conn: &Connection,
    change: &SyncChangeWithData,
) -> Result<(), SyncError> {
    if change.table_name == "ink_render_artifacts"
        && matches!(
            change.operation,
            ChangeOperation::Insert | ChangeOperation::Update
        )
    {
        return validate_artifact_change(conn, change);
    }
    if change.table_name != "files"
        || !matches!(
            change.operation,
            ChangeOperation::Insert | ChangeOperation::Update
        )
        || !table_has_column(conn, "files", "mime_type")
    {
        return Ok(());
    }

    let local: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = conn
        .query_row(
            "SELECT file_name, mime_type, \"type\", preview_json FROM files WHERE id = ?1",
            [&change.record_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| SyncError::Database(format!("read local dsink identity: {error}")))?;
    let local_is_ink = change.record_id.starts_with("file_ink_")
        || change.record_id.starts_with("ink_")
        || local.as_ref().is_some_and(|(name, mime, kind, preview)| {
            identifies_ink(
                name.as_deref(),
                mime.as_deref(),
                kind.as_deref(),
                preview.as_deref(),
            )
        });
    let incoming_is_ink = change.record_id.starts_with("file_ink_")
        || change.record_id.starts_with("ink_")
        || change.data.as_ref().is_some_and(|data| {
            identifies_ink(
                data.get("file_name").and_then(Value::as_str),
                data.get("mime_type").and_then(Value::as_str),
                data.get("type").and_then(Value::as_str),
                data.get("preview_json").and_then(Value::as_str),
            )
        });
    if !local_is_ink && !incoming_is_ink {
        return Ok(());
    }

    let data = change
        .data
        .as_ref()
        .ok_or_else(|| SyncError::Database("dsink upsert missing complete row data".to_owned()))?;
    if data.get("id").and_then(Value::as_str) != Some(change.record_id.as_str()) {
        return Err(SyncError::Database(
            "dsink row id does not match the sync record id".to_owned(),
        ));
    }
    verify_ink_row(conn, data).map(|_| ())
}

fn validate_artifact_change(
    conn: &Connection,
    change: &SyncChangeWithData,
) -> Result<(), SyncError> {
    let invalid =
        |message: &str| SyncError::Database(format!("invalid immutable Ink artifact: {message}"));
    let data = change
        .data
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("complete row payload is required"))?;
    let required = |column: &str| {
        data.get(column)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid(&format!("missing or empty {column}")))
    };
    let render_id = required("render_id")?;
    if render_id != change.record_id {
        return Err(invalid("render_id does not match the sync key"));
    }
    let artifact_id = required("artifact_id")?;
    let metadata_json = required("metadata_json")?;
    let artifact: InkArtifact = serde_json::from_str(metadata_json)
        .map_err(|_| invalid("metadata_json is not canonical InkArtifact JSON"))?;
    let hash = required("image_blob_hash")?;
    if !is_sha256(hash)
        || artifact.render_id != render_id
        || artifact.artifact_id != artifact_id
        || artifact.blob_hash != hash
        || artifact.content_hash != hash
        || artifact.mime_type != "image/png"
        || artifact.width_px == 0
        || artifact.height_px == 0
        || artifact.file_id != required("image_file_id")?
        || artifact.resource_id != required("image_resource_id")?
        || artifact.created_at != required("created_at")?
    {
        return Err(invalid(
            "row fields disagree with the globally verified artifact metadata",
        ));
    }
    let db_path = database_path(conn)?;
    let blobs_dir = blob_directory(&db_path)?;
    let png = read_verified_blob(conn, &blobs_dir, hash, 4 * 1024 * 1024)?;
    let dimensions = validate_png_bytes(&png)
        .map_err(|error| invalid(&format!("invalid stored PNG: {error}")))?;
    if dimensions != (artifact.width_px, artifact.height_px) {
        return Err(invalid(
            "image_blob_hash does not identify the declared PNG dimensions",
        ));
    }

    let local = SyncManager::get_record_data(conn, "ink_render_artifacts", render_id, "render_id")?;
    if local.as_ref().is_some_and(|local| {
        !SyncManager::records_semantically_equal_for_sync(local, &Value::Object(data.clone()))
    }) {
        return Err(invalid("an existing render_id cannot be changed"));
    }
    Ok(())
}

fn identifies_ink(
    name: Option<&str>,
    mime: Option<&str>,
    kind: Option<&str>,
    preview: Option<&str>,
) -> bool {
    mime == Some(DSINK_MIME)
        || name.is_some_and(|name| {
            name.to_ascii_lowercase()
                .ends_with(&format!(".{INK_EXTENSION}"))
        })
        || kind == Some("dsink")
        || preview
            .and_then(|preview| serde_json::from_str::<Value>(preview).ok())
            .is_some_and(|value| value.get("ink").is_some())
}

/// Result of verifying one canonical Ink row.
pub(crate) struct VerifiedInkRow {
    pub refs: Vec<String>,
    pub is_board: bool,
}

/// Verified Ink closure of one VFS database.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InkDatabaseClosureSummary {
    pub verified_rows: usize,
    pub board_rows: usize,
}

/// Verify manifest and dependency bytes, then return hashes derived from the manifest itself.
fn verify_ink_row(conn: &Connection, row: &Value) -> Result<Vec<String>, SyncError> {
    let database_path = database_path(conn)?;
    let blobs_dir = blob_directory(&database_path)?;
    Ok(verify_ink_row_with_blobs(conn, row, &blobs_dir)?.refs)
}

/// Verify a canonical Ink row against an explicit blob directory.
///
/// Backup reuses this exact pointer/hash/byte-budget validator for an archived
/// or freshly restored VFS database instead of duplicating the contract.
pub(crate) fn verify_ink_row_with_blobs(
    conn: &Connection,
    row: &Value,
    blobs_dir: &Path,
) -> Result<VerifiedInkRow, SyncError> {
    let invalid =
        |reason: &str| SyncError::Database(format!("dsink blob closure unavailable: {reason}"));
    validate_ink_change(row)?;
    let id = row["id"]
        .as_str()
        .ok_or_else(|| invalid("missing file id"))?;
    let manifest_hash = row["blob_hash"]
        .as_str()
        .ok_or_else(|| invalid("missing manifest hash"))?;
    let manifest_bytes = read_verified_blob(
        conn,
        blobs_dir,
        manifest_hash,
        INK_MANIFEST_MAX_BYTES.saturating_add(1),
    )?;
    let manifest: InkManifest =
        parse_manifest(&manifest_bytes).map_err(|error| invalid(&error.to_string()))?;
    let preview: Value = serde_json::from_str(row["preview_json"].as_str().unwrap_or_default())
        .map_err(|_| invalid("invalid preview JSON"))?;
    let preview_schema = preview["ink"]["schema_version"]
        .as_u64()
        .unwrap_or_default();
    if manifest.schema_version as u64 != preview_schema {
        return Err(invalid(
            "manifest schema_version does not match preview_json.ink",
        ));
    }
    if manifest.document_id != id
        || manifest.revision != preview["ink"]["revision"].as_str().unwrap_or_default()
    {
        return Err(invalid(
            "manifest identity/revision does not match the canonical row",
        ));
    }

    // A v2 board document must never be replaced by a v1 manifest. Legacy
    // writers can still be in flight when the board descriptor is published;
    // this logical guard preserves the board pointer instead of claiming the
    // old writer was retroactively blocked at the format gate.
    if manifest.schema_version != INK_BOARD_SCHEMA_VERSION {
        let local_preview: Option<Option<String>> = conn
            .query_row(
                "SELECT preview_json FROM files WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| invalid(&format!("read local board identity: {error}")))?;
        let local_is_board = local_preview
            .flatten()
            .and_then(|preview| serde_json::from_str::<Value>(&preview).ok())
            .and_then(|preview| {
                preview
                    .get("ink")
                    .and_then(|ink| ink.get("schema_version"))
                    .and_then(Value::as_u64)
            })
            == Some(INK_BOARD_SCHEMA_VERSION as u64);
        if local_is_board {
            return Err(invalid(
                "an existing board v2 document cannot be downgraded to v1",
            ));
        }
    }

    for page_ref in &manifest.pages {
        let bytes = read_verified_blob(
            conn,
            blobs_dir,
            &page_ref.page_blob_hash,
            INK_PAGE_MAX_BYTES,
        )?;
        parse_page(&bytes, page_ref).map_err(|error| invalid(&error.to_string()))?;
        match &page_ref.background {
            crate::vfs::ink::InkBackground::Blank { .. } => {}
            crate::vfs::ink::InkBackground::Image { blob_hash }
            | crate::vfs::ink::InkBackground::PdfPage { blob_hash, .. } => {
                verify_blob_hash(conn, blobs_dir, blob_hash)?;
            }
        }
    }

    let mut board_object_ids: HashSet<String> = HashSet::new();
    let mut board_z_indices: HashSet<i64> = HashSet::new();
    for chunk_ref in &manifest.chunks {
        let bytes = read_verified_blob(
            conn,
            blobs_dir,
            &chunk_ref.blob_hash,
            INK_BOARD_CHUNK_MAX_BYTES,
        )?;
        let chunk =
            parse_board_chunk(&bytes, chunk_ref).map_err(|error| invalid(&error.to_string()))?;
        for object in &chunk.objects {
            if !board_object_ids.insert(object.id.clone()) {
                return Err(invalid("board object IDs must be unique across chunks"));
            }
            if !board_z_indices.insert(object.z_index) {
                return Err(invalid("board z-index values must be unique across chunks"));
            }
            if let Some((min_x, min_y, max_x, max_y)) = board_object_bounds(&object.content) {
                let bounds = &chunk_ref.bounds;
                if min_x < bounds.x - BOARD_BOUNDS_EPSILON
                    || min_y < bounds.y - BOARD_BOUNDS_EPSILON
                    || max_x > bounds.x + bounds.width + BOARD_BOUNDS_EPSILON
                    || max_y > bounds.y + bounds.height + BOARD_BOUNDS_EPSILON
                {
                    return Err(invalid(
                        "board chunk bounds do not enclose the actual object geometry",
                    ));
                }
            }
        }
    }

    let is_board = manifest.schema_version == INK_BOARD_SCHEMA_VERSION;
    let refs = manifest_blob_refs(&manifest);
    let expected = Value::Array(refs.iter().cloned().map(Value::String).collect());
    if preview["ink"]["blob_refs"] != expected {
        return Err(invalid(
            "preview blob_refs do not match manifest dependencies",
        ));
    }
    Ok(VerifiedInkRow { refs, is_board })
}

/// Verify every canonical Ink pointer in one VFS database against an explicit
/// blob directory.
///
/// A database without a `files` table predates Ink and is a legitimate no-op.
/// Once the table exists, every required closure column must be present: a
/// missing column is a broken database, not an empty one.
///
/// This is the shared closure entry point for backup publication and restore:
/// it reuses [`verify_ink_row_with_blobs`] so manifest/page/background/chunk
/// pointers, hashes and declared byte budgets are checked by the same code as
/// sync. It never scans unrelated user file bodies. `board_rows` is derived
/// from the verified manifest, never from the preview mirror alone.
pub(crate) fn verify_ink_database_closure(
    conn: &Connection,
    blobs_dir: &Path,
) -> Result<InkDatabaseClosureSummary, SyncError> {
    const REQUIRED_COLUMNS: [&str; 7] = [
        "id",
        "file_name",
        "mime_type",
        "type",
        "blob_hash",
        "sha256",
        "preview_json",
    ];
    if !table_exists(conn, "files")? {
        if vfs_has_installed_writer_guard(conn)? || vfs_has_known_migration_history(conn)? {
            return Err(SyncError::Database(
                "files table is missing from a VFS database with guard or migration evidence"
                    .to_string(),
            ));
        }
        return Ok(InkDatabaseClosureSummary::default());
    }
    for column in REQUIRED_COLUMNS {
        if !table_has_column(conn, "files", column) {
            return Err(SyncError::Database(format!(
                "files table is missing required dsink closure column: {column}"
            )));
        }
    }

    let mut statement = conn
        .prepare(
            r#"SELECT id, file_name, mime_type, "type", blob_hash, sha256, preview_json
               FROM files
               WHERE mime_type = ?1
                  OR lower(file_name) LIKE ?2
                  OR (json_valid(preview_json) AND json_type(preview_json, '$.ink') IS NOT NULL)
               ORDER BY id"#,
        )
        .map_err(|error| SyncError::Database(format!("prepare dsink closure scan: {error}")))?;
    let rows = statement
        .query_map(params![DSINK_MIME, format!("%.{INK_EXTENSION}")], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "file_name": row.get::<_, Option<String>>(1)?,
                "mime_type": row.get::<_, Option<String>>(2)?,
                "type": row.get::<_, Option<String>>(3)?,
                "blob_hash": row.get::<_, Option<String>>(4)?,
                "sha256": row.get::<_, Option<String>>(5)?,
                "preview_json": row.get::<_, Option<String>>(6)?,
            }))
        })
        .map_err(|error| SyncError::Database(format!("scan dsink closure: {error}")))?;

    let mut summary = InkDatabaseClosureSummary::default();
    for row in rows {
        let row = row.map_err(|error| SyncError::Database(format!("read dsink row: {error}")))?;
        let verified = verify_ink_row_with_blobs(conn, &row, blobs_dir)?;
        summary.verified_rows += 1;
        if verified.is_board {
            summary.board_rows += 1;
        }
    }
    Ok(summary)
}

/// Recompute the derived unique dsink dependencies for current files and unresolved conflict rows.
/// The files.blob_hash column already contributes the current manifest reference; conflict
/// snapshots additionally own their manifest and dependency closure.
pub(super) fn rebuild_dependency_refs(conn: &Connection) -> Result<bool, SyncError> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS temp.__dsink_blob_refs;
         CREATE TEMP TABLE __dsink_blob_refs (
           owner_id TEXT NOT NULL,
           blob_hash TEXT NOT NULL,
           PRIMARY KEY(owner_id, blob_hash)
         );",
    )
    .map_err(|error| SyncError::Database(format!("prepare dsink ref recount: {error}")))?;

    if [
        "id",
        "file_name",
        "mime_type",
        "type",
        "blob_hash",
        "sha256",
        "preview_json",
    ]
    .iter()
    .any(|column| !table_has_column(conn, "files", column))
    {
        return Ok(false);
    }
    let mut current_rows = Vec::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT id, file_name, mime_type, \"type\", blob_hash, sha256, preview_json
                 FROM files
                 WHERE id LIKE 'file_ink_%'
                    OR id LIKE 'ink_%'
                    OR lower(COALESCE(file_name, '')) LIKE ?1
                    OR mime_type = ?2
                    OR (preview_json IS NOT NULL AND json_valid(preview_json)
                        AND json_type(preview_json, '$.ink') IS NOT NULL)",
            )
            .map_err(|error| SyncError::Database(format!("query dsink files: {error}")))?;
        let rows = statement
            .query_map(params![format!("%.{INK_EXTENSION}"), DSINK_MIME], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(|error| SyncError::Database(format!("read dsink files: {error}")))?;
        for row in rows {
            current_rows.push(
                row.map_err(|error| SyncError::Database(format!("read dsink row: {error}")))?,
            );
        }
    }
    for (id, name, mime, kind, hash, sha, preview) in current_rows {
        if !id.starts_with("file_ink_")
            && !id.starts_with("ink_")
            && !identifies_ink(
                name.as_deref(),
                mime.as_deref(),
                kind.as_deref(),
                preview.as_deref(),
            )
        {
            continue;
        }
        let row = json!({
            "id": id,
            "file_name": name,
            "mime_type": mime,
            "type": kind,
            "blob_hash": hash,
            "sha256": sha,
            "preview_json": preview,
        });
        let refs = verify_ink_row(conn, &row)?;
        for hash in refs {
            conn.execute(
                "INSERT OR IGNORE INTO temp.__dsink_blob_refs(owner_id, blob_hash) VALUES (?1, ?2)",
                params![format!("file:{id}"), hash],
            )
            .map_err(|error| SyncError::Database(format!("save current dsink refs: {error}")))?;
        }
    }

    if table_has_column(conn, "__sync_conflicts", "data_json")
        && table_has_column(conn, "__sync_conflicts", "resolved_at")
    {
        let mut conflict_rows = Vec::new();
        {
            let mut statement = conn
                .prepare("SELECT id, record_id, data_json FROM __sync_conflicts WHERE table_name = 'files' AND resolved_at IS NULL AND data_json IS NOT NULL AND json_valid(data_json)")
                .map_err(|error| SyncError::Database(format!("query dsink conflicts: {error}")))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| SyncError::Database(format!("read dsink conflicts: {error}")))?;
            for row in rows {
                conflict_rows.push(row.map_err(|error| {
                    SyncError::Database(format!("read conflict snapshot: {error}"))
                })?);
            }
        }
        for (conflict_id, record_id, serialized) in conflict_rows {
            let Ok(row) = serde_json::from_str::<Value>(&serialized) else {
                continue;
            };
            if !record_id.starts_with("file_ink_")
                && !record_id.starts_with("ink_")
                && !identifies_ink(
                    row.get("file_name").and_then(Value::as_str),
                    row.get("mime_type").and_then(Value::as_str),
                    row.get("type").and_then(Value::as_str),
                    row.get("preview_json").and_then(Value::as_str),
                )
            {
                continue;
            }
            let refs = verify_ink_row(conn, &row)?;
            let owner_id = format!("conflict:{conflict_id}");
            conn.execute(
                "INSERT OR IGNORE INTO temp.__dsink_blob_refs(owner_id, blob_hash) VALUES (?1, ?2)",
                params![owner_id, row["blob_hash"].as_str().unwrap_or_default()],
            )
            .map_err(|error| SyncError::Database(format!("save conflict manifest pin: {error}")))?;
            for hash in refs {
                conn.execute(
                    "INSERT OR IGNORE INTO temp.__dsink_blob_refs(owner_id, blob_hash) VALUES (?1, ?2)",
                    params![owner_id, hash],
                )
                .map_err(|error| SyncError::Database(format!("save conflict dependency pins: {error}")))?;
            }
        }
    }
    Ok(true)
}

const BOARD_BOUNDS_EPSILON: f64 = 1e-6;

/// Geometry actually occupied by one board object. Sync must recompute this
/// instead of trusting `InkBoardChunkRef.bounds`, otherwise a forged bbox can
/// hide objects from visible-only culling.
fn board_object_bounds(
    content: &crate::vfs::ink::InkObjectContent,
) -> Option<(f64, f64, f64, f64)> {
    use crate::vfs::ink::InkObjectContent;
    match content {
        InkObjectContent::Stroke { samples, .. } => {
            let mut samples = samples.iter();
            let first = samples.next()?;
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (first.x, first.y, first.x, first.y);
            for sample in samples {
                min_x = min_x.min(sample.x);
                min_y = min_y.min(sample.y);
                max_x = max_x.max(sample.x);
                max_y = max_y.max(sample.y);
            }
            Some((min_x, min_y, max_x, max_y))
        }
        InkObjectContent::Text { rect, .. }
        | InkObjectContent::Rect { rect, .. }
        | InkObjectContent::Ellipse { rect, .. }
        | InkObjectContent::RegionHighlight { rect, .. } => {
            Some((rect.x, rect.y, rect.x + rect.width, rect.y + rect.height))
        }
        InkObjectContent::Arrow { from, to, .. } => Some((
            from.x.min(to.x),
            from.y.min(to.y),
            from.x.max(to.x),
            from.y.max(to.y),
        )),
    }
}

fn manifest_blob_refs(manifest: &InkManifest) -> Vec<String> {
    let mut refs = manifest
        .pages
        .iter()
        .flat_map(|page| {
            let mut hashes = vec![page.page_blob_hash.clone()];
            match &page.background {
                crate::vfs::ink::InkBackground::Blank { .. } => {}
                crate::vfs::ink::InkBackground::Image { blob_hash }
                | crate::vfs::ink::InkBackground::PdfPage { blob_hash, .. } => {
                    hashes.push(blob_hash.clone())
                }
            }
            hashes
        })
        .collect::<Vec<_>>();
    refs.extend(manifest.chunks.iter().map(|chunk| chunk.blob_hash.clone()));
    refs.sort();
    refs.dedup();
    refs
}

fn read_verified_blob(
    conn: &Connection,
    blobs_dir: &Path,
    hash: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, SyncError> {
    let path = VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, hash)
        .map_err(|error| SyncError::Database(format!("lookup dsink blob {hash}: {error}")))?
        .filter(|path| path.is_file())
        .ok_or_else(|| SyncError::Database(format!("dsink blob closure missing {hash}")))?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > max_bytes as u64 {
        return Err(SyncError::Database(format!(
            "dsink blob exceeds size limit: {hash}"
        )));
    }
    let bytes = fs::read(path)?;
    if VfsBlobRepo::compute_hash(&bytes) != hash {
        return Err(SyncError::Database(format!(
            "dsink blob hash mismatch {hash}"
        )));
    }
    Ok(bytes)
}

fn verify_blob_hash(conn: &Connection, blobs_dir: &Path, hash: &str) -> Result<(), SyncError> {
    let path = VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, hash)
        .map_err(|error| SyncError::Database(format!("lookup dsink dependency {hash}: {error}")))?
        .filter(|path| path.is_file())
        .ok_or_else(|| SyncError::Database(format!("dsink blob closure missing {hash}")))?;
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    if hex::encode(digest.finalize()) != hash {
        return Err(SyncError::Database(format!(
            "dsink dependency hash mismatch {hash}"
        )));
    }
    Ok(())
}

fn database_path(conn: &Connection) -> Result<PathBuf, SyncError> {
    let path: String = conn
        .query_row("PRAGMA database_list", [], |row| row.get(2))
        .map_err(|error| SyncError::Database(format!("locate dsink database: {error}")))?;
    if path.is_empty() {
        return Err(SyncError::Database(
            "dsink VFS database has no filesystem path".to_owned(),
        ));
    }
    Ok(PathBuf::from(path))
}

pub(super) fn blob_directory(database_path: &Path) -> Result<PathBuf, SyncError> {
    let is_vfs_database = database_path.file_name().and_then(|name| name.to_str())
        == Some("vfs.db")
        && database_path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("databases");
    if !is_vfs_database {
        return Err(SyncError::Database(
            "database path is not a VfsDatabase::new database".to_owned(),
        ));
    }
    database_path
        .parent()
        .and_then(Path::parent)
        .map(|root| root.join("vfs_blobs"))
        .ok_or_else(|| SyncError::Database("cannot derive VFS blob directory".to_owned()))
}

fn is_sha256(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, SyncError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(|error| SyncError::Database(format!("inspect table {table}: {error}")))
}

/// The VFS init migration is the first one that creates `files`; any later
/// known migration means a missing `files` table is damage, not an empty DB.
const VFS_INIT_SCHEMA_VERSION: i64 = 20260130;

fn vfs_has_installed_writer_guard(conn: &Connection) -> Result<bool, SyncError> {
    if !table_exists(conn, "__vfs_writer_guard")? {
        return Ok(false);
    }
    let installed: Option<i64> = conn
        .query_row(
            "SELECT guard_installed FROM __vfs_writer_guard WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| SyncError::Database(format!("inspect VFS writer guard: {error}")))?;
    Ok(installed == Some(1))
}

fn vfs_has_known_migration_history(conn: &Connection) -> Result<bool, SyncError> {
    if !table_exists(conn, "refinery_schema_history")? {
        return Ok(false);
    }
    let max_version: Option<i64> = conn
        .query_row(
            "SELECT MAX(version) FROM refinery_schema_history",
            [],
            |row| row.get(0),
        )
        .map_err(|error| SyncError::Database(format!("inspect VFS migration history: {error}")))?;
    Ok(max_version.is_some_and(|version| version >= VFS_INIT_SCHEMA_VERSION))
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table, column],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

/// Reconcile only the derived resource hash mirror for dsink files.
pub(super) fn reconcile_resource_hash(conn: &Connection) -> Result<(), SyncError> {
    if !table_has_column(conn, "files", "preview_json")
        || !table_has_column(conn, "resources", "source_table")
    {
        return Ok(());
    }
    conn.execute(
        "UPDATE resources
         SET hash = (SELECT f.blob_hash FROM files f WHERE f.id = resources.source_id)
         WHERE resources.source_table = 'files'
           AND resources.hash IS NOT (SELECT f.blob_hash FROM files f WHERE f.id = resources.source_id)
           AND EXISTS (
             SELECT 1 FROM files f
             WHERE f.id = resources.source_id
               AND (f.mime_type = ?1 OR lower(f.file_name) LIKE ?2 OR
                    (json_valid(f.preview_json) AND json_type(f.preview_json, '$.ink') IS NOT NULL))
           )",
        params![DSINK_MIME, format!("%.{INK_EXTENSION}")],
    )
    .map_err(|error| SyncError::Database(format!("reconcile dsink resource hash: {error}")))?;
    Ok(())
}
