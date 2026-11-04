//! Board (`schema_version: 2`) storage contract for the infinite ink canvas.
//!
//! A board manifest is the canonical pointer document (`pages: []`, one stable
//! board `surface`, ordered `chunks` references). Chunks are content-addressed
//! blobs written before the canonical manifest is published under
//! `BlobMutationGuard` + a SQLite savepoint; reads are all-or-nothing so a
//! missing/corrupt referenced chunk never yields a partial object list.
//!
//! `InkBoardChunk`/`InkBoardObject` come from the frozen `vfs::ink::types`
//! surface owned by the D1 domain worker; this module must not define a second
//! copy.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::Path,
};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::vfs::{
    error::{VfsError, VfsResult},
    ink::{
        parse_board_chunk, validate_board_chunk, validate_manifest, InkBoardBounds, InkBoardChunk,
        InkBoardChunkRef, InkBoardObject, InkBoardSurface, InkManifest, InkObjectContent,
        InkOperationReceipt, InkRuling, InkSource, INK_BOARD_CHUNK_MAX_BYTES,
        INK_BOARD_CHUNK_SAMPLES_MAX, INK_BOARD_WORLD_LIMIT, INK_DIMENSION_MIN, INK_EXTENSION,
        INK_MIME, INK_TITLE_MAX_CHARS,
    },
    repos::{
        blob_repo::{BlobMutationGuard, VfsBlobRepo},
        folder_repo::VfsFolderRepo,
        ink_repo::{
            conflict, file_id_exists, hash_json, invalid_ink_argument, map_ink_error, preview_json,
            read_verified_blob, reference_counts, serialize_manifest, validate_operation_id,
            VfsInkRepo,
        },
    },
    types::VfsFolderItem,
    upload_saga::with_savepoint,
};

/// Board and chunk wire schema version.
pub const BOARD_SCHEMA_VERSION: u32 = 2;

/// Upper bound for one `get_chunks_with_conn` response (16 MiB).
const BOARD_READ_BATCH_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Minimum visible extent contributed by a stroke/arrow so zero-pressure or
/// zero-extent geometry still produces a strictly positive bounding box. This
/// is a storage contract constant, independent of renderer defaults.
const MIN_VISIBLE_PAD: f64 = 0.01;

const OPERATION_REUSED: &str = "ink.operation_id_reused";
const OPERATION_UNKNOWN: &str = "ink.operation_state_unknown";
const REVISION_CONFLICT: &str = "ink.revision_conflict";
const FORMAT_CONFLICT: &str = "ink.format_conflict";

#[derive(Serialize)]
struct BoardCreateInput<'a> {
    title: &'a str,
    ruling: InkRuling,
    folder_id: Option<&'a str>,
}

#[derive(Serialize)]
struct SaveChunksInput<'a> {
    document_id: &'a str,
    expected_revision: &'a str,
    changed: &'a [InkBoardChunk],
    deleted: &'a [String],
}

struct PreparedChunk {
    chunk_ref: InkBoardChunkRef,
    bytes: Vec<u8>,
}

/// Read-only board overview for the UI insert path before chunk hydration.
///
/// `max_z_index` is the globally unique maximum `z_index` encoded as an exact
/// decimal string. A JSON number would be rounded by JavaScript above
/// `Number.MAX_SAFE_INTEGER`; `None` means the board has no objects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InkBoardOverview {
    pub document_id: String,
    pub revision: String,
    pub page_id: String,
    pub max_z_index: Option<String>,
}

/// Repository entry point for board documents.
pub struct VfsInkBoardRepo;

impl VfsInkBoardRepo {
    /// Create a blank board document.
    ///
    /// Emits the v2 manifest contract (`pages: []`, one stable board `surface`,
    /// `chunks: []`). The document id is derived from a board-specific
    /// operation scope so a v1 document created with the same operation id can
    /// never collide with it.
    pub fn create_blank_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        title: &str,
        ruling: InkRuling,
        operation_id: &str,
        folder_id: Option<&str>,
    ) -> VfsResult<InkManifest> {
        let guard = VfsInkRepo::acquire_mutation_guard(conn)?;
        validate_operation_id(operation_id)?;
        if title.trim().is_empty() {
            return Err(invalid_ink_argument(
                "title",
                "Ink board title must be nonempty",
            ));
        }
        if title.chars().count() > INK_TITLE_MAX_CHARS {
            return Err(conflict(
                "ink.limit_exceeded",
                "Ink title exceeds the character limit",
            ));
        }
        let input_hash = hash_json(&BoardCreateInput {
            title,
            ruling,
            folder_id,
        })?;
        let document_id = format!(
            "file_ink_board_{}",
            VfsBlobRepo::compute_hash(
                format!("deepstudent.dsink.board.create.v2\0{operation_id}").as_bytes()
            )
        );

        if file_id_exists(conn, &document_id)? {
            let current = VfsInkRepo::get_manifest_with_conn(conn, blobs_dir, &document_id)?;
            // A board may predate the writer guard. Retrying its create owns a
            // capable connection, so upgrade the guard safely before returning;
            // an unregistered legacy connection still fails the capability
            // check instead of bypassing the writer boundary.
            ensure_board_writer_guard(conn)?;
            match current.last_operation.as_ref() {
                Some(receipt) if receipt.operation_id == operation_id => {
                    if receipt.input_hash == input_hash {
                        return Ok(current);
                    }
                    return Err(conflict(
                        OPERATION_REUSED,
                        "Create operation ID was already used with different input",
                    ));
                }
                _ => {
                    return Err(conflict(
                        OPERATION_UNKNOWN,
                        "Create operation result can no longer be proven",
                    ));
                }
            }
        }

        if let Some(folder_id) = folder_id {
            if !VfsFolderRepo::folder_exists_with_conn(conn, folder_id)? {
                return Err(VfsError::FolderNotFound {
                    folder_id: folder_id.to_owned(),
                });
            }
        }

        let revision = format!("r_{}", nanoid::nanoid!(16));
        let manifest = InkManifest {
            schema_version: BOARD_SCHEMA_VERSION,
            document_id: document_id.clone(),
            revision: revision.clone(),
            title: title.to_owned(),
            source: InkSource::Blank {},
            pages: Vec::new(),
            last_operation: Some(InkOperationReceipt {
                operation_id: operation_id.to_owned(),
                input_hash,
                previous_revision: None,
                result_revision: revision,
            }),
            surface: Some(InkBoardSurface::Board {
                page_id: format!("p_{}", nanoid::nanoid!(12)),
                ruling,
                bounds: InkBoardBounds {
                    x: 0.0,
                    y: 0.0,
                    width: INK_DIMENSION_MIN,
                    height: INK_DIMENSION_MIN,
                },
            }),
            chunks: Vec::new(),
        };
        validate_manifest(&manifest).map_err(map_ink_error)?;

        with_savepoint(conn, "ink_board_create", || {
            // Install the capability gate in the same savepoint that first
            // publishes the board. Any failure rolls back the manifest and all
            // chunk blobs registered below; the guard is never half-installed.
            ensure_board_writer_guard(conn)?;
            let manifest_bytes = serialize_manifest(&manifest)?;
            let manifest_blob = VfsBlobRepo::store_blob_with_conn_guarded(
                conn,
                blobs_dir,
                &manifest_bytes,
                Some(INK_MIME),
                Some(INK_EXTENSION),
                &guard,
            )?;
            let preview = preview_json(&manifest, &manifest_blob.hash)?;
            let now_ms = chrono::Utc::now().timestamp_millis();
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let resource_id = format!("res_{}", nanoid::nanoid!(12));

            conn.execute(
                "INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at) VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', 0, ?4, ?4)",
                params![resource_id, manifest_blob.hash, document_id, now_ms],
            )?;
            conn.execute(
                r#"INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count, "type", mime_type, tags_json, is_favorite, status, created_at, updated_at, preview_json)
                   VALUES (?1, ?2, ?3, ?3, ?4, NULL, ?5, 0, 'document', ?6, '[]', 0, 'active', ?7, ?7, ?8)"#,
                params![
                    document_id,
                    resource_id,
                    manifest_blob.hash,
                    format!("{title}.{INK_EXTENSION}"),
                    manifest_bytes.len() as i64,
                    INK_MIME,
                    now,
                    preview,
                ],
            )?;
            VfsFolderRepo::add_item_to_folder_with_conn(
                conn,
                &VfsFolderItem::new(
                    folder_id.map(str::to_owned),
                    "file".to_owned(),
                    document_id.clone(),
                ),
            )?;
            Ok(manifest.clone())
        })
    }

    /// Load the requested chunks.
    ///
    /// Contract: results follow the caller-supplied `chunk_ids` order; a
    /// missing id or a missing/corrupt referenced blob fails the entire call.
    pub fn get_chunks_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        chunk_ids: &[String],
    ) -> VfsResult<Vec<InkBoardChunk>> {
        let (manifest, _file) = VfsInkRepo::load_manifest(conn, blobs_dir, document_id)?;
        if manifest.schema_version != BOARD_SCHEMA_VERSION {
            return Err(conflict(FORMAT_CONFLICT, "Ink document is not a v2 board"));
        }
        let refs: HashMap<&str, &InkBoardChunkRef> = manifest
            .chunks
            .iter()
            .map(|chunk_ref| (chunk_ref.chunk_id.as_str(), chunk_ref))
            .collect();

        let mut resolved = Vec::with_capacity(chunk_ids.len());
        let mut total_bytes: u64 = 0;
        for chunk_id in chunk_ids {
            let chunk_ref =
                refs.get(chunk_id.as_str())
                    .copied()
                    .ok_or_else(|| VfsError::NotFound {
                        resource_type: "ink board chunk".to_owned(),
                        id: chunk_id.clone(),
                    })?;
            total_bytes = total_bytes
                .checked_add(chunk_ref.byte_length)
                .ok_or_else(|| {
                    conflict("ink.limit_exceeded", "Ink board read exceeds the budget")
                })?;
            if total_bytes > BOARD_READ_BATCH_MAX_BYTES {
                return Err(conflict(
                    "ink.limit_exceeded",
                    "Ink board read exceeds the byte budget",
                ));
            }
            resolved.push(chunk_ref);
        }

        let mut chunks = Vec::with_capacity(resolved.len());
        for chunk_ref in resolved {
            let bytes = read_verified_blob(
                conn,
                blobs_dir,
                &chunk_ref.blob_hash,
                INK_BOARD_CHUNK_MAX_BYTES,
            )?;
            chunks.push(parse_board_chunk(&bytes, chunk_ref).map_err(map_ink_error)?);
        }
        Ok(chunks)
    }

    /// Read the board surface identity and the global maximum `z_index`.
    ///
    /// Reads the canonical manifest, then verifies and parses each referenced
    /// chunk one at a time under `INK_BOARD_CHUNK_MAX_BYTES`; it never
    /// materializes the full 16 MiB read batch. Save already guarantees a
    /// globally unique `z_index`, so the maximum needs no deduplication and the
    /// overview exposes no object counts.
    pub fn overview_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
    ) -> VfsResult<InkBoardOverview> {
        let manifest = VfsInkRepo::get_manifest_with_conn(conn, blobs_dir, document_id)?;
        if manifest.schema_version != BOARD_SCHEMA_VERSION {
            return Err(conflict(FORMAT_CONFLICT, "Ink document is not a v2 board"));
        }
        let page_id = match manifest.surface.as_ref() {
            Some(InkBoardSurface::Board { page_id, .. }) => page_id.clone(),
            None => {
                return Err(conflict(
                    FORMAT_CONFLICT,
                    "Ink board manifest requires a board surface",
                ))
            }
        };

        let missing_chunk = |chunk_ref: &InkBoardChunkRef| VfsError::NotFound {
            resource_type: "ink blob".to_owned(),
            id: chunk_ref.blob_hash.clone(),
        };
        let mut max_z_index: Option<i64> = None;
        for chunk_ref in &manifest.chunks {
            // A registered blob row can outlive its physical file. Resolve that
            // real ENOENT at this read boundary as the typed not-found already
            // used for unknown blobs; permission and corrupt-content errors
            // still propagate unchanged.
            let path = VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, &chunk_ref.blob_hash)?
                .ok_or_else(|| missing_chunk(chunk_ref))?;
            match std::fs::metadata(&path) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(missing_chunk(chunk_ref));
                }
                Err(error) => return Err(VfsError::Io(error.to_string())),
            }
            let bytes = read_verified_blob(
                conn,
                blobs_dir,
                &chunk_ref.blob_hash,
                INK_BOARD_CHUNK_MAX_BYTES,
            )?;
            let chunk = parse_board_chunk(&bytes, chunk_ref).map_err(map_ink_error)?;
            for object in &chunk.objects {
                max_z_index =
                    Some(max_z_index.map_or(object.z_index, |current| current.max(object.z_index)));
            }
        }

        Ok(InkBoardOverview {
            document_id: manifest.document_id,
            revision: manifest.revision,
            page_id,
            max_z_index: max_z_index.map(|z_index| z_index.to_string()),
        })
    }

    /// Atomically apply changed/deleted chunks under CAS.
    ///
    /// Contract: validate first, write new chunk blobs, then publish exactly one
    /// canonical manifest in the same commit. Retrying the same operation id
    /// with the same input returns the committed result without new writes;
    /// any stale/different operation fails without partial publication.
    pub fn save_chunks_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        changed: &[InkBoardChunk],
        deleted: &[String],
    ) -> VfsResult<InkManifest> {
        let input_hash = hash_json(&SaveChunksInput {
            document_id,
            expected_revision,
            changed,
            deleted,
        })?;
        Self::save_chunks_with_receipt_with_conn(
            conn,
            blobs_dir,
            document_id,
            expected_revision,
            operation_id,
            &input_hash,
            changed,
            deleted,
        )
    }

    /// Commit whole-chunk changes while preserving the caller's operation
    /// receipt hash.
    ///
    /// Board AI apply/undo hashes its own operation input (document, revision,
    /// operations, mappings); re-hashing chunks here would silently replace that
    /// receipt and break retry proof. The guard is acquired once and the nested
    /// savepoint reuses it.
    pub(crate) fn save_chunks_with_receipt_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        receipt_input_hash: &str,
        changed: &[InkBoardChunk],
        deleted: &[String],
    ) -> VfsResult<InkManifest> {
        let guard = VfsInkRepo::acquire_mutation_guard(conn)?;
        Self::save_chunks_with_receipt_with_guard(
            conn,
            blobs_dir,
            document_id,
            expected_revision,
            operation_id,
            receipt_input_hash,
            changed,
            deleted,
            &guard,
        )
    }

    fn save_chunks_with_receipt_with_guard(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        receipt_input_hash: &str,
        changed: &[InkBoardChunk],
        deleted: &[String],
        guard: &BlobMutationGuard,
    ) -> VfsResult<InkManifest> {
        validate_operation_id(operation_id)?;
        let (mut manifest, file) = VfsInkRepo::load_manifest(conn, blobs_dir, document_id)?;
        if manifest.schema_version != BOARD_SCHEMA_VERSION {
            return Err(conflict(FORMAT_CONFLICT, "Ink document is not a v2 board"));
        }

        // A board may predate the guard, or its marker may have outlived a
        // dropped trigger. Repair it before any early idempotent return and
        // before any blob/manifest write. The repo blob-mutation guard is
        // already held; the storage helper supplies its own nested savepoint.
        ensure_board_writer_guard(conn)?;

        if let Some(receipt) = manifest.last_operation.as_ref() {
            if receipt.operation_id == operation_id {
                if receipt.input_hash == receipt_input_hash {
                    return Ok(manifest);
                }
                return Err(conflict(
                    OPERATION_REUSED,
                    "Save operation ID was already used with different input",
                ));
            }
        }
        if manifest.revision != expected_revision {
            return Err(conflict(
                OPERATION_UNKNOWN,
                "A stale revision cannot prove whether this operation already committed",
            ));
        }

        let previous_manifest = manifest.clone();
        let old_refs: HashMap<&str, &InkBoardChunkRef> = previous_manifest
            .chunks
            .iter()
            .map(|chunk_ref| (chunk_ref.chunk_id.as_str(), chunk_ref))
            .collect();

        let mut removed: BTreeSet<String> = BTreeSet::new();
        for chunk_id in deleted {
            if !old_refs.contains_key(chunk_id.as_str()) {
                return Err(VfsError::NotFound {
                    resource_type: "ink board chunk".to_owned(),
                    id: chunk_id.clone(),
                });
            }
            if !removed.insert(chunk_id.clone()) {
                return Err(invalid_ink_argument(
                    "deleted",
                    "Ink board delete list contains duplicate chunk IDs",
                ));
            }
        }

        // `carried` is declared before the ID set so every borrowed object id
        // lives at least as long as the set that borrows it.
        let mut carried: Vec<InkBoardChunk> = Vec::new();
        // Validate and serialize the replacement chunks before any blob write.
        let mut changed_ids: HashSet<&str> = HashSet::with_capacity(changed.len());
        let mut replacements: BTreeMap<String, PreparedChunk> = BTreeMap::new();
        let mut object_ids: HashSet<&str> = HashSet::new();
        let mut z_indices: HashSet<i64> = HashSet::new();
        for chunk in changed {
            if !changed_ids.insert(chunk.chunk_id.as_str()) {
                return Err(invalid_ink_argument(
                    "changed",
                    "Ink board save contains duplicate chunk IDs",
                ));
            }
            if removed.contains(&chunk.chunk_id) {
                return Err(invalid_ink_argument(
                    "changed",
                    "Ink board chunk cannot be both changed and deleted",
                ));
            }
            if chunk.objects.is_empty() {
                // An empty replacement is a removal, never a stored chunk. An
                // unknown empty id is rejected exactly like an unknown delete.
                if !old_refs.contains_key(chunk.chunk_id.as_str()) {
                    return Err(VfsError::NotFound {
                        resource_type: "ink board chunk".to_owned(),
                        id: chunk.chunk_id.clone(),
                    });
                }
                removed.insert(chunk.chunk_id.clone());
                continue;
            }
            for object in &chunk.objects {
                if !object_ids.insert(object.id.as_str()) {
                    return Err(invalid_ink_argument(
                        "changed",
                        "Ink board contains duplicate object IDs across chunks",
                    ));
                }
                if !z_indices.insert(object.z_index) {
                    return Err(invalid_ink_argument(
                        "changed",
                        "Ink board contains duplicate z_index values across chunks",
                    ));
                }
            }
            replacements.insert(chunk.chunk_id.clone(), prepare_chunk(chunk)?);
        }

        // Carried-over chunks are re-read and validated so cross-chunk object
        // IDs stay unique and a corrupt survivor fails the whole save.
        for chunk_ref in &previous_manifest.chunks {
            if removed.contains(&chunk_ref.chunk_id)
                || replacements.contains_key(&chunk_ref.chunk_id)
            {
                continue;
            }
            let bytes = read_verified_blob(
                conn,
                blobs_dir,
                &chunk_ref.blob_hash,
                INK_BOARD_CHUNK_MAX_BYTES,
            )?;
            carried.push(parse_board_chunk(&bytes, chunk_ref).map_err(map_ink_error)?);
        }
        for chunk in &carried {
            for object in &chunk.objects {
                if !object_ids.insert(object.id.as_str()) {
                    return Err(invalid_ink_argument(
                        "changed",
                        "Ink board contains duplicate object IDs across chunks",
                    ));
                }
                if !z_indices.insert(object.z_index) {
                    return Err(invalid_ink_argument(
                        "changed",
                        "Ink board contains duplicate z_index values across chunks",
                    ));
                }
            }
        }

        let mut chunks: Vec<InkBoardChunkRef> = previous_manifest
            .chunks
            .iter()
            .filter(|chunk_ref| {
                !removed.contains(&chunk_ref.chunk_id)
                    && !replacements.contains_key(&chunk_ref.chunk_id)
            })
            .cloned()
            .collect();
        chunks.extend(
            replacements
                .values()
                .map(|prepared| prepared.chunk_ref.clone()),
        );
        chunks.sort_by(|left, right| left.chunk_id.cmp(&right.chunk_id));

        let previous_revision = manifest.revision.clone();
        let revision = format!("r_{}", nanoid::nanoid!(16));
        manifest.revision = revision.clone();
        manifest.chunks = chunks;
        manifest.last_operation = Some(InkOperationReceipt {
            operation_id: operation_id.to_owned(),
            input_hash: receipt_input_hash.to_owned(),
            previous_revision: Some(previous_revision),
            result_revision: revision,
        });
        validate_manifest(&manifest).map_err(map_ink_error)?;
        let manifest_bytes = serialize_manifest(&manifest)?;

        with_savepoint(conn, "ink_board_save_chunks", || {
            let mut temporary_refs = BTreeMap::<String, i32>::new();
            for prepared in replacements.values() {
                let stored = VfsBlobRepo::store_blob_with_conn_guarded(
                    conn,
                    blobs_dir,
                    &prepared.bytes,
                    Some("application/json"),
                    Some("json"),
                    guard,
                )?;
                *temporary_refs.entry(stored.hash).or_default() += 1;
            }
            let manifest_blob = VfsBlobRepo::store_blob_with_conn_guarded(
                conn,
                blobs_dir,
                &manifest_bytes,
                Some(INK_MIME),
                Some(INK_EXTENSION),
                guard,
            )?;
            *temporary_refs
                .entry(manifest_blob.hash.clone())
                .or_default() += 1;
            let preview = preview_json(&manifest, &manifest_blob.hash)?;

            let mut deltas = reference_counts(&manifest, &manifest_blob.hash);
            for (hash, count) in reference_counts(&previous_manifest, &file.manifest_hash) {
                *deltas.entry(hash).or_default() -= count;
            }
            // store_blob adds one temporary reference for each stored blob.
            for (hash, count) in temporary_refs {
                *deltas.entry(hash).or_default() -= count;
            }
            for (hash, delta) in deltas {
                for _ in 0..delta.max(0) {
                    VfsBlobRepo::increment_ref_with_conn(conn, &hash)?;
                }
                for _ in 0..(-delta).max(0) {
                    VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, &hash)?;
                }
            }

            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let changed_rows = conn.execute(
                r#"UPDATE files SET blob_hash = ?1, sha256 = ?1, file_name = ?2, size = ?3,
                          page_count = 0, preview_json = ?4, updated_at = ?5
                   WHERE id = ?6 AND blob_hash = ?7 AND sha256 = ?7 AND resource_id = ?8
                     AND mime_type = ?9 AND "type" = 'document' AND status = 'active'"#,
                params![
                    manifest_blob.hash,
                    format!("{}.{INK_EXTENSION}", manifest.title),
                    manifest_bytes.len() as i64,
                    preview,
                    now,
                    document_id,
                    file.manifest_hash,
                    file.resource_id,
                    INK_MIME,
                ],
            )?;
            if changed_rows != 1 {
                return Err(conflict(
                    REVISION_CONFLICT,
                    "Ink board file changed while committing chunks",
                ));
            }
            let changed_rows = conn.execute(
                "UPDATE resources SET hash = ?1, updated_at = ?2 WHERE id = ?3 AND hash = ?4",
                params![
                    manifest_blob.hash,
                    chrono::Utc::now().timestamp_millis(),
                    file.resource_id,
                    file.resource_hash,
                ],
            )?;
            if changed_rows != 1 {
                return Err(conflict(
                    REVISION_CONFLICT,
                    "Ink board resource mirror changed while committing chunks",
                ));
            }
            Ok(manifest.clone())
        })
    }
}

/// Serialize a chunk with the exact byte length/hash recorded in its manifest
/// reference, derive conservative world bounds from its real geometry, and
/// validate the result against the domain contract.
fn prepare_chunk(chunk: &InkBoardChunk) -> VfsResult<PreparedChunk> {
    let bytes =
        serde_json::to_vec(chunk).map_err(|error| VfsError::Serialization(error.to_string()))?;
    if bytes.len() > INK_BOARD_CHUNK_MAX_BYTES {
        return Err(conflict(
            "ink.limit_exceeded",
            "Ink board chunk exceeds the byte limit",
        ));
    }
    let object_count = u32::try_from(chunk.objects.len()).map_err(|_| {
        conflict(
            "ink.limit_exceeded",
            "Ink board chunk exceeds the object limit",
        )
    })?;
    let sample_count = chunk_sample_count(chunk)?;
    let bounds = chunk_bounds(&chunk.objects)?;
    let chunk_ref = InkBoardChunkRef {
        chunk_id: chunk.chunk_id.clone(),
        blob_hash: VfsBlobRepo::compute_hash(&bytes),
        byte_length: bytes.len() as u64,
        object_count,
        sample_count,
        bounds,
    };
    validate_board_chunk(chunk, &chunk_ref).map_err(map_ink_error)?;
    Ok(PreparedChunk { chunk_ref, bytes })
}

fn chunk_sample_count(chunk: &InkBoardChunk) -> VfsResult<u32> {
    let mut total: u32 = 0;
    for object in &chunk.objects {
        let samples = match &object.content {
            InkObjectContent::Stroke { samples, .. } => {
                u32::try_from(samples.len()).map_err(|_| {
                    conflict(
                        "ink.limit_exceeded",
                        "Ink board chunk exceeds the sample limit",
                    )
                })?
            }
            _ => 0,
        };
        total = total.checked_add(samples).ok_or_else(|| {
            conflict(
                "ink.limit_exceeded",
                "Ink board chunk exceeds the sample limit",
            )
        })?;
        if total > INK_BOARD_CHUNK_SAMPLES_MAX {
            return Err(conflict(
                "ink.limit_exceeded",
                "Ink board chunk exceeds the sample limit",
            ));
        }
    }
    Ok(total)
}

#[derive(Clone, Copy)]
struct Extent {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

impl Extent {
    fn new() -> Self {
        Self {
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
        }
    }

    fn is_empty(&self) -> bool {
        !self.min_x.is_finite() || !self.min_y.is_finite()
    }

    fn add_point(&mut self, x: f64, y: f64) {
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
    }

    fn add_rect(&mut self, x: f64, y: f64, width: f64, height: f64) {
        self.add_point(x, y);
        self.add_point(x + width, y + height);
    }

    fn expand(&mut self, pad: f64) {
        if pad.is_finite() && pad > 0.0 && !self.is_empty() {
            self.min_x -= pad;
            self.min_y -= pad;
            self.max_x += pad;
            self.max_y += pad;
        }
    }

    /// Renderer head points sit at `to - headlen * (cos/sin)(angle ± PI/6)`
    /// with `headlen = max(8, width * 4)`. The head may be longer than the
    /// shaft; even a zero-length arrow still draws a visible V, so `headlen`
    /// is never clamped by the shaft length.
    fn add_arrow_head(&mut self, from_x: f64, from_y: f64, to_x: f64, to_y: f64, width: f64) {
        let dx = to_x - from_x;
        let dy = to_y - from_y;
        let head_len = 8.0_f64.max(width * 4.0);
        let angle = dy.atan2(dx);
        for offset in [-std::f64::consts::FRAC_PI_6, std::f64::consts::FRAC_PI_6] {
            let direction = angle + offset;
            self.add_point(
                to_x - head_len * direction.cos(),
                to_y - head_len * direction.sin(),
            );
        }
    }

    fn union(&mut self, other: Self) {
        if other.is_empty() {
            return;
        }
        self.add_point(other.min_x, other.min_y);
        self.add_point(other.max_x, other.max_y);
    }
}

fn chunk_bounds(objects: &[InkBoardObject]) -> VfsResult<InkBoardBounds> {
    let mut total = Extent::new();
    for object in objects {
        // Compute each object's visible bbox independently, then union, so
        // one object's stroke padding never leaks onto an adjacent object.
        let mut visible = Extent::new();
        let pad = match &object.content {
            InkObjectContent::Stroke { samples, style } => {
                for sample in samples {
                    visible.add_point(sample.x, sample.y);
                }
                // Renderer radius per sample:
                //   max(0.01, width * (enabled ? 0.25 + 0.75 * pressure : 1)) / 2
                // Take the maximum radius across samples for a conservative
                // visible bbox (never raw pressure times width).
                samples
                    .iter()
                    .map(|sample| {
                        let factor = if style.pressure_enabled {
                            0.25 + 0.75 * sample.pressure
                        } else {
                            1.0
                        };
                        MIN_VISIBLE_PAD.max(style.width * factor) / 2.0
                    })
                    .fold(0.0_f64, f64::max)
            }
            InkObjectContent::Text { rect, .. } => {
                visible.add_rect(rect.x, rect.y, rect.width, rect.height);
                0.0
            }
            InkObjectContent::Rect { rect, width, .. }
            | InkObjectContent::Ellipse { rect, width, .. } => {
                visible.add_rect(rect.x, rect.y, rect.width, rect.height);
                (*width / 2.0).max(MIN_VISIBLE_PAD)
            }
            // Region highlights are filled, so their rect already is the
            // visible extent and must not gain a stroke half-width.
            InkObjectContent::RegionHighlight { rect, .. } => {
                visible.add_rect(rect.x, rect.y, rect.width, rect.height);
                0.0
            }
            InkObjectContent::Arrow {
                from, to, width, ..
            } => {
                visible.add_point(from.x, from.y);
                visible.add_point(to.x, to.y);
                visible.add_arrow_head(from.x, from.y, to.x, to.y, *width);
                (*width / 2.0).max(MIN_VISIBLE_PAD)
            }
        };
        visible.expand(pad);
        total.union(visible);
    }
    if total.is_empty() {
        // Chunks without visible geometry still need a valid, positive range;
        // content validation rejects those objects afterwards.
        return Ok(InkBoardBounds {
            x: 0.0,
            y: 0.0,
            width: INK_DIMENSION_MIN,
            height: INK_DIMENSION_MIN,
        });
    }
    let (x, width) = visible_span(total.min_x, total.max_x)?;
    let (y, height) = visible_span(total.min_y, total.max_y)?;
    Ok(InkBoardBounds {
        x,
        y,
        width,
        height,
    })
}

/// Reject a visible bbox that leaves the signed world range instead of
/// silently clamping ink out of view. A zero-extent span is expanded inward by
/// `MIN_VISIBLE_PAD` so the manifest reference still satisfies the domain's
/// strictly-positive bounds contract.
fn visible_span(min: f64, max: f64) -> VfsResult<(f64, f64)> {
    if !min.is_finite() || !max.is_finite() || max < min {
        return Err(conflict(
            "ink.board_bounds",
            "Ink board chunk visible bounds are not finite",
        ));
    }
    let limit = INK_BOARD_WORLD_LIMIT;
    if min < -limit || max > limit {
        return Err(conflict(
            "ink.limit_exceeded",
            "Ink board chunk visible bounds exceed the safe world range",
        ));
    }
    let span = max - min;
    if span > 0.0 {
        // Guard against the rounded `min + span` overshooting the limit.
        let width = span.min(limit - min);
        if width > 0.0 {
            return Ok((min, width));
        }
    }
    let width = MIN_VISIBLE_PAD;
    let start = if min + width > limit {
        limit - width
    } else {
        min
    };
    Ok((start, width))
}

/// Verify and, when necessary, install the board writer guard.
///
/// The caller must already hold the repo blob-mutation guard and must call this
/// only for a database that is publishing or already contains a board. The
/// storage-side probe is the single source of truth: it verifies the marker
/// floor, the marker flag, and all nine exact `(table, operation, canonical
/// body)` triggers. A missing, damaged, or downgraded guard is repaired atomically
/// by `enable_vfs_board_writer_guard`, which supplies its own nested savepoint,
/// so this function acquires no additional lock and starts no extra repo
/// transaction.
fn map_board_writer_capability_error(
    error: dstu_storage::sqlite_capability::SqliteCapabilityError,
) -> VfsError {
    match error {
        dstu_storage::sqlite_capability::SqliteCapabilityError::CapabilityTooLow { .. } => {
            conflict(
                "ink.unsupported_schema",
                "Ink board writer capability is newer than this build",
            )
        }
        other => VfsError::Database(other.to_string()),
    }
}

pub(super) fn ensure_board_writer_guard(conn: &Connection) -> VfsResult<()> {
    if dstu_storage::sqlite_capability::vfs_board_writer_guard_installed(conn)
        .map_err(map_board_writer_capability_error)?
    {
        return Ok(());
    }
    dstu_storage::sqlite_capability::enable_vfs_board_writer_guard(conn)
        .map_err(map_board_writer_capability_error)
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use rusqlite::Connection;
    use serde_json::{json, Value};
    use tempfile::TempDir;

    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        error::VfsError,
        ink::{
            types::InkBoardObject, InkAuthor, InkBoardSurface, InkManifest, InkObjectContent,
            InkPoint, InkRect, InkRuling, InkSample, InkStrokeStyle, InkTool,
        },
        repos::{blob_repo::VfsBlobRepo, ink_repo::VfsInkRepo},
    };

    use super::{InkBoardChunk, VfsInkBoardRepo, BOARD_SCHEMA_VERSION, FORMAT_CONFLICT};

    const SAFE_COORDINATE_LIMIT: f64 = 10_000_000.0;

    fn setup() -> (TempDir, VfsDatabase) {
        setup_migrated_test_db()
    }

    /// Every board test enters through the same creator. The assertion is the
    /// intended RED: today the scaffold returns a v1 manifest, so this fails on
    /// the schema contract rather than on a panic or a transport error.
    fn create_board(
        conn: &Connection,
        db: &VfsDatabase,
        operation_id: &str,
        title: &str,
    ) -> crate::vfs::ink::InkManifest {
        let manifest = VfsInkBoardRepo::create_blank_with_conn(
            conn,
            db.blobs_dir(),
            title,
            InkRuling::Blank,
            operation_id,
            None,
        )
        .expect("board create scaffold must return the migrated document");
        let wire = manifest_wire(conn, db, &manifest.document_id);
        assert_eq!(
            wire["schema_version"].as_u64(),
            Some(BOARD_SCHEMA_VERSION as u64),
            "board create must emit a v2 board manifest; scaffold currently returns v1: {wire}"
        );
        manifest
    }

    fn board_surface_page_id(manifest: &InkManifest) -> String {
        match manifest.surface.as_ref().expect("board surface") {
            InkBoardSurface::Board { page_id, .. } => page_id.clone(),
        }
    }

    fn manifest_blob_hash(conn: &Connection, document_id: &str) -> String {
        conn.query_row(
            "SELECT blob_hash FROM files WHERE id = ?1",
            [document_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn manifest_wire(conn: &Connection, db: &VfsDatabase, document_id: &str) -> Value {
        let hash = manifest_blob_hash(conn, document_id);
        let path = VfsBlobRepo::get_blob_path_with_conn(conn, db.blobs_dir(), &hash)
            .unwrap()
            .expect("canonical manifest blob must exist");
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn file_index_state(conn: &Connection, document_id: &str) -> (String, String, i64, String) {
        conn.query_row(
            "SELECT f.blob_hash, f.sha256, f.page_count, r.hash
             FROM files f JOIN resources r ON r.id = f.resource_id
             WHERE f.id = ?1",
            [document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
    }

    fn database_counts(conn: &Connection) -> (i64, i64, i64) {
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM resources), (SELECT COALESCE(SUM(ref_count), 0) FROM blobs)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }

    fn blob_ref_count(conn: &Connection, hash: &str) -> i64 {
        conn.query_row(
            "SELECT ref_count FROM blobs WHERE hash = ?1",
            [hash],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn guard_trigger_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'trigger' AND name LIKE 'trg_vfs_writer_guard_%'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn guard_marker_installed(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COALESCE(
                 (SELECT guard_installed FROM __vfs_writer_guard WHERE id = 1),
                 0
             )",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn drop_all_guard_triggers(conn: &Connection) {
        let names: Vec<String> = {
            let mut statement = conn
                .prepare(
                    "SELECT name FROM sqlite_master
                     WHERE type = 'trigger' AND name LIKE 'trg_vfs_writer_guard_%'",
                )
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        for name in names {
            conn.execute(&format!("DROP TRIGGER \"{name}\""), [])
                .unwrap();
        }
    }

    fn chunk_refs(wire: &Value) -> BTreeMap<String, Value> {
        wire["chunks"]
            .as_array()
            .expect("board manifest chunks must be an array")
            .iter()
            .map(|reference| {
                (
                    reference["chunk_id"]
                        .as_str()
                        .expect("chunk refs must carry a chunk_id")
                        .to_owned(),
                    reference.clone(),
                )
            })
            .collect()
    }

    fn chunk_ref_hash(reference: &Value) -> String {
        reference["blob_hash"]
            .as_str()
            .expect("chunk refs must carry blob_hash")
            .to_owned()
    }

    fn rect_object(
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        z_index: i64,
    ) -> InkBoardObject {
        InkBoardObject {
            id: id.to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            z_index,
            content: InkObjectContent::Rect {
                rect: InkRect {
                    x,
                    y,
                    width,
                    height,
                },
                color: "#000000".to_owned(),
                width: 2.0,
            },
        }
    }

    fn stroke_object(
        id: &str,
        x: f64,
        y: f64,
        sample_count: usize,
        z_index: i64,
    ) -> InkBoardObject {
        InkBoardObject {
            id: id.to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            z_index,
            content: InkObjectContent::Stroke {
                samples: (0..sample_count)
                    .map(|index| InkSample {
                        x: x + index as f64,
                        y,
                        pressure: 0.5,
                        elapsed_ms: Some(index as f64),
                    })
                    .collect(),
                style: InkStrokeStyle {
                    tool: InkTool::Pen,
                    color: "#000000".to_owned(),
                    width: 2.0,
                    pressure_enabled: true,
                },
            },
        }
    }

    fn stroke_object_with_width(
        id: &str,
        x: f64,
        y: f64,
        sample_count: usize,
        stroke_width: f64,
        z_index: i64,
    ) -> InkBoardObject {
        InkBoardObject {
            id: id.to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            z_index,
            content: InkObjectContent::Stroke {
                samples: (0..sample_count)
                    .map(|index| InkSample {
                        x: x + index as f64,
                        y,
                        pressure: 0.5,
                        elapsed_ms: Some(index as f64),
                    })
                    .collect(),
                style: InkStrokeStyle {
                    tool: InkTool::Pen,
                    color: "#000000".to_owned(),
                    width: stroke_width,
                    pressure_enabled: true,
                },
            },
        }
    }

    fn stroke_object_with_pressure(
        id: &str,
        x: f64,
        y: f64,
        sample_count: usize,
        stroke_width: f64,
        pressure: f64,
        pressure_enabled: bool,
        z_index: i64,
    ) -> InkBoardObject {
        InkBoardObject {
            id: id.to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            z_index,
            content: InkObjectContent::Stroke {
                samples: (0..sample_count)
                    .map(|index| InkSample {
                        x: x + index as f64,
                        y,
                        pressure,
                        elapsed_ms: Some(index as f64),
                    })
                    .collect(),
                style: InkStrokeStyle {
                    tool: InkTool::Pen,
                    color: "#000000".to_owned(),
                    width: stroke_width,
                    pressure_enabled,
                },
            },
        }
    }

    fn rect_object_with_width(
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        stroke_width: f64,
        z_index: i64,
    ) -> InkBoardObject {
        InkBoardObject {
            id: id.to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            z_index,
            content: InkObjectContent::Rect {
                rect: InkRect {
                    x,
                    y,
                    width,
                    height,
                },
                color: "#000000".to_owned(),
                width: stroke_width,
            },
        }
    }

    fn ellipse_object_with_width(
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        stroke_width: f64,
        z_index: i64,
    ) -> InkBoardObject {
        InkBoardObject {
            id: id.to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            z_index,
            content: InkObjectContent::Ellipse {
                rect: InkRect {
                    x,
                    y,
                    width,
                    height,
                },
                color: "#000000".to_owned(),
                width: stroke_width,
            },
        }
    }

    fn region_highlight_object(
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        z_index: i64,
    ) -> InkBoardObject {
        InkBoardObject {
            id: id.to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            z_index,
            content: InkObjectContent::RegionHighlight {
                rect: InkRect {
                    x,
                    y,
                    width,
                    height,
                },
                color: "#000000".to_owned(),
                width: 1.0,
            },
        }
    }

    fn arrow_object(
        id: &str,
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        stroke_width: f64,
        z_index: i64,
    ) -> InkBoardObject {
        InkBoardObject {
            id: id.to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            z_index,
            content: InkObjectContent::Arrow {
                from: InkPoint {
                    x: from_x,
                    y: from_y,
                },
                to: InkPoint { x: to_x, y: to_y },
                color: "#000000".to_owned(),
                width: stroke_width,
            },
        }
    }

    /// Assert `bounds` contains the visible interval, allowing a conservative
    /// (larger) bounding box as long as no visible pixel falls outside.
    fn assert_bounds_contain(
        bounds: &Value,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        label: &str,
    ) {
        let x = bounds["x"].as_f64().expect("bounds.x must be numeric");
        let y = bounds["y"].as_f64().expect("bounds.y must be numeric");
        let width = bounds["width"]
            .as_f64()
            .expect("bounds.width must be numeric");
        let height = bounds["height"]
            .as_f64()
            .expect("bounds.height must be numeric");
        assert!(
            x <= min_x + 1e-9,
            "{label}: bounds.x={x} must reach {min_x} or less (bounds={bounds})"
        );
        assert!(
            y <= min_y + 1e-9,
            "{label}: bounds.y={y} must reach {min_y} or less (bounds={bounds})"
        );
        assert!(
            x + width >= max_x - 1e-9,
            "{label}: bounds right edge {} must reach {max_x} or more (bounds={bounds})",
            x + width
        );
        assert!(
            y + height >= max_y - 1e-9,
            "{label}: bounds bottom edge {} must reach {max_y} or more (bounds={bounds})",
            y + height
        );
    }

    fn chunk(chunk_id: &str, objects: Vec<InkBoardObject>) -> InkBoardChunk {
        InkBoardChunk {
            schema_version: BOARD_SCHEMA_VERSION,
            chunk_id: chunk_id.to_owned(),
            objects,
        }
    }

    fn sample_count(chunk: &InkBoardChunk) -> usize {
        chunk
            .objects
            .iter()
            .map(|object| match &object.content {
                InkObjectContent::Stroke { samples, .. } => samples.len(),
                _ => 0,
            })
            .sum()
    }

    #[test]
    fn create_blank_board_emits_schema_v2_surface_and_is_idempotent() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-create", "Board create");

        let wire = manifest_wire(&conn, &db, &created.document_id);
        assert_eq!(
            wire["document_id"].as_str(),
            Some(created.document_id.as_str())
        );
        assert_eq!(wire["source"], json!({ "kind": "blank" }));
        assert_eq!(
            wire["pages"],
            json!([]),
            "v2 boards carry chunk refs, not fixed pages"
        );
        assert_eq!(wire["chunks"], json!([]));
        assert_eq!(wire["surface"]["kind"].as_str(), Some("board"));
        assert_eq!(wire["surface"]["ruling"].as_str(), Some("blank"));
        assert!(
            !wire["surface"]["page_id"]
                .as_str()
                .unwrap_or_default()
                .is_empty(),
            "a board keeps one stable page_id for artifact addressing"
        );
        let bounds = wire["surface"]["bounds"]
            .as_object()
            .expect("surface bounds must be an object");
        assert_eq!(bounds.len(), 4, "bounds are exactly x/y/width/height");
        for key in ["x", "y", "width", "height"] {
            assert!(
                bounds[key].as_f64().is_some_and(f64::is_finite),
                "surface bounds.{key} must be finite"
            );
        }

        let (_, _, page_count, _) = file_index_state(&conn, &created.document_id);
        assert_eq!(page_count, 0, "v2 board files must index page_count = 0");

        let before_retry = database_counts(&conn);
        let retry = VfsInkBoardRepo::create_blank_with_conn(
            &conn,
            db.blobs_dir(),
            "Board create",
            InkRuling::Blank,
            "board-create",
            None,
        )
        .unwrap();
        assert_eq!(retry.document_id, created.document_id);
        assert_eq!(retry.revision, created.revision);
        assert_eq!(database_counts(&conn), before_retry);

        assert!(VfsInkBoardRepo::create_blank_with_conn(
            &conn,
            db.blobs_dir(),
            "Different board title",
            InkRuling::Blank,
            "board-create",
            None,
        )
        .is_err());
        assert_eq!(database_counts(&conn), before_retry);
    }

    #[test]
    fn save_chunks_uses_cas_and_adjacent_retry_is_idempotent() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-cas-create", "Board CAS");

        let chunk_a = chunk(
            "chunk-a",
            vec![rect_object("obj-a", -20.0, -10.0, 40.0, 20.0, 0)],
        );
        let chunk_b = chunk("chunk-b", vec![stroke_object("obj-b", 12.5, 30.0, 3, 1)]);
        let changed = vec![chunk_a.clone(), chunk_b.clone()];
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-save-1",
            &changed,
            &[],
        )
        .unwrap();
        assert_ne!(saved.revision, created.revision);
        let after_save = database_counts(&conn);

        let retried = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-save-1",
            &changed,
            &[],
        )
        .unwrap();
        assert_eq!(retried, saved);
        assert_eq!(database_counts(&conn), after_save);

        let mut different_input = changed.clone();
        different_input[0].objects[0].z_index = 99;
        assert!(VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-save-1",
            &different_input,
            &[],
        )
        .is_err());
        assert_eq!(database_counts(&conn), after_save);

        assert!(VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-save-stale",
            &[chunk_b.clone()],
            &[],
        )
        .is_err());
        assert_eq!(database_counts(&conn), after_save);

        let reopened = VfsInkBoardRepo::get_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &saved.document_id,
            &["chunk-a".to_owned(), "chunk-b".to_owned()],
        )
        .unwrap();
        assert_eq!(reopened, vec![chunk_a, chunk_b]);
        assert_eq!(
            manifest_wire(&conn, &db, &saved.document_id)["revision"].as_str(),
            Some(saved.revision.as_str())
        );
    }

    /// A guard trigger can be replaced by a same-name no-op trigger. Name and
    /// marker checks alone must not accept that state: save must repair the
    /// body before publishing, and an unregistered connection must still be
    /// rejected on the repaired table.
    ///
    /// Regression: the repo probe only checks the nine names plus the marker,
    /// so save succeeds with the fake body and a raw blobs INSERT is allowed.
    #[test]
    fn save_repairs_replaced_guard_trigger_body_and_keeps_raw_writes_blocked() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-guard-body", "Board guard body");

        conn.execute_batch(
            "DROP TRIGGER trg_vfs_writer_guard_blobs_insert;
             CREATE TRIGGER trg_vfs_writer_guard_blobs_insert
             BEFORE INSERT ON blobs
             BEGIN
                 SELECT 1;
             END;",
        )
        .expect("replace one owned guard trigger with a same-name no-op");
        assert_eq!(guard_trigger_count(&conn), 9);
        assert_eq!(guard_marker_installed(&conn), 1);

        let saved_chunk = chunk(
            "chunk-guard-body",
            vec![rect_object("obj-guard-body", 0.0, 0.0, 10.0, 10.0, 0)],
        );
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-guard-body-save",
            &[saved_chunk],
            &[],
        )
        .expect("save must repair the damaged guard and publish");
        assert_ne!(saved.revision, created.revision);

        let trigger_sql: String = conn
            .query_row(
                "SELECT COALESCE(sql, '') FROM sqlite_master
                 WHERE type = 'trigger' AND name = 'trg_vfs_writer_guard_blobs_insert'",
                [],
                |row| row.get(0),
            )
            .expect("read repaired trigger body");
        let normalized = trigger_sql.to_ascii_lowercase();
        assert!(
            normalized.contains("dstu_vfs_writer_capability") && normalized.contains("raise(abort"),
            "save must restore the guarded trigger body, got: {trigger_sql}"
        );
        assert_eq!(guard_trigger_count(&conn), 9);

        let old = Connection::open(db.db_path()).expect("open unregistered connection");
        assert!(
            old.execute(
                "INSERT INTO blobs (hash, relative_path, size, ref_count, created_at)
                 VALUES ('guard-body-probe', 'guard-body-probe', 0, 0, 0)",
                [],
            )
            .is_err(),
            "repaired guard must reject an unregistered blobs insert"
        );
        assert_eq!(
            old.query_row(
                "SELECT COUNT(*) FROM blobs WHERE hash = 'guard-body-probe'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
    }

    /// A marker alone cannot certify that the guard is intact: if one trigger
    /// is missing, an unregistered legacy writer can still mutate that table.
    /// An exact create retry owns a capable connection and must restore every
    /// guard trigger before returning the already-published board.
    ///
    /// Regression: an earlier implementation trusted only
    /// `guard_installed = 1` and returned early, leaving the dropped trigger
    /// missing so the unregistered INSERT succeeded.
    #[test]
    fn create_retry_restores_missing_guard_trigger_and_blocks_old_writer() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-guard-retry", "Board guard retry");
        assert_eq!(guard_trigger_count(&conn), 9);
        assert_eq!(guard_marker_installed(&conn), 1);

        conn.execute_batch("DROP TRIGGER trg_vfs_writer_guard_blobs_insert;")
            .expect("simulate a board with one missing guard trigger");
        assert_eq!(
            guard_marker_installed(&conn),
            1,
            "the marker stays installed while a trigger is missing"
        );
        assert_eq!(guard_trigger_count(&conn), 8);

        let retried = create_board(&conn, &db, "board-guard-retry", "Board guard retry");
        assert_eq!(retried.document_id, created.document_id);
        assert_eq!(
            guard_trigger_count(&conn),
            9,
            "exact create retry must restore every guard trigger"
        );
        assert_eq!(guard_marker_installed(&conn), 1);

        let old = Connection::open(db.db_path()).expect("open unregistered connection");
        assert!(
            old.execute(
                "INSERT INTO blobs (hash, relative_path, size, ref_count, created_at)
                 VALUES ('guard-probe-retry', 'guard-probe-retry', 0, 0, 0)",
                [],
            )
            .is_err(),
            "restored guard must reject an unregistered blobs insert"
        );
        assert_eq!(
            old.query_row(
                "SELECT COUNT(*) FROM blobs WHERE hash = 'guard-probe-retry'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
    }

    /// An existing board may predate the guard (marker row and triggers
    /// absent). Saving chunks must install the guard, and a failed CAS must
    /// leave the published manifest untouched.
    ///
    /// Regression: an earlier implementation never called
    /// `ensure_board_writer_guard` from save, so after the save the marker was
    /// still 0, no trigger existed, and an unregistered connection could write
    /// blobs.
    #[test]
    fn save_chunks_installs_absent_guard_and_failed_cas_keeps_manifest() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-guard-upgrade", "Board guard upgrade");

        conn.execute_batch("DELETE FROM __vfs_writer_guard WHERE id = 1;")
            .expect("simulate a board without the guard marker");
        drop_all_guard_triggers(&conn);
        assert_eq!(guard_marker_installed(&conn), 0);
        assert_eq!(guard_trigger_count(&conn), 0);

        let saved_chunk = chunk(
            "chunk-guard-installed",
            vec![rect_object(
                "obj-guard-installed",
                -5.0,
                -5.0,
                10.0,
                10.0,
                0,
            )],
        );
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-guard-save",
            &[saved_chunk.clone()],
            &[],
        )
        .expect("saving an existing board must upgrade it to the guarded schema");
        assert_eq!(
            guard_trigger_count(&conn),
            9,
            "save must install every guard trigger"
        );
        assert_eq!(guard_marker_installed(&conn), 1);
        assert_eq!(
            VfsInkBoardRepo::get_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &saved.document_id,
                &[saved_chunk.chunk_id.clone()],
            )
            .unwrap(),
            vec![saved_chunk.clone()]
        );

        let wire_before = manifest_wire(&conn, &db, &saved.document_id);
        let hash_before = manifest_blob_hash(&conn, &saved.document_id);
        let counts_before = database_counts(&conn);

        let stale_chunk = chunk(
            "chunk-stale-cas",
            vec![rect_object("obj-stale-cas", 0.0, 0.0, 10.0, 10.0, 1)],
        );
        assert!(
            VfsInkBoardRepo::save_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &saved.document_id,
                &created.revision,
                "board-guard-stale",
                &[stale_chunk],
                &[],
            )
            .is_err(),
            "a stale expected revision must fail the CAS"
        );

        assert_eq!(
            manifest_wire(&conn, &db, &saved.document_id),
            wire_before,
            "failed CAS must not publish a partial manifest"
        );
        assert_eq!(manifest_blob_hash(&conn, &saved.document_id), hash_before);
        assert_eq!(database_counts(&conn), counts_before);
        assert_eq!(guard_trigger_count(&conn), 9);
        assert_eq!(guard_marker_installed(&conn), 1);
        assert_eq!(
            VfsInkBoardRepo::get_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &saved.document_id,
                &[saved_chunk.chunk_id.clone()],
            )
            .unwrap(),
            vec![saved_chunk]
        );

        let old = Connection::open(db.db_path()).expect("open unregistered connection");
        assert!(
            old.execute(
                "INSERT INTO blobs (hash, relative_path, size, ref_count, created_at)
                 VALUES ('guard-probe-upgrade', 'guard-probe-upgrade', 0, 0, 0)",
                [],
            )
            .is_err(),
            "installed guard must reject an unregistered blobs insert"
        );
        assert!(
            old.execute(
                "UPDATE files SET file_name = 'tampered' WHERE id = ?1",
                [saved.document_id.as_str()],
            )
            .is_err(),
            "installed guard must reject an unregistered files update"
        );
    }

    #[test]
    fn multi_chunk_roundtrip_writes_exact_refs_and_refcounts() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-chunks-create", "Board chunks");
        let old_manifest_hash = manifest_blob_hash(&conn, &created.document_id);

        let chunk_a = chunk(
            "chunk-a",
            vec![
                rect_object("obj-a", -9_999_999.0, -250.5, 10.0, 20.0, 0),
                stroke_object("obj-b", -75.0, 120.0, 3, 1),
            ],
        );
        let chunk_b = chunk(
            "chunk-b",
            vec![rect_object(
                "obj-c",
                9_999_000.0,
                9_999_000.0,
                100.0,
                100.0,
                2,
            )],
        );
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-chunks-save",
            &[chunk_a.clone(), chunk_b.clone()],
            &[],
        )
        .unwrap();

        let requested = ["chunk-b".to_owned(), "chunk-a".to_owned()];
        assert_eq!(
            VfsInkBoardRepo::get_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &saved.document_id,
                &requested,
            )
            .unwrap(),
            vec![chunk_b.clone(), chunk_a.clone()],
            "get_chunks must preserve the requested chunk id order"
        );

        let wire = manifest_wire(&conn, &db, &saved.document_id);
        assert_eq!(wire["schema_version"].as_u64(), Some(2));
        assert_eq!(wire["pages"], json!([]));
        let refs = chunk_refs(&wire);
        assert_eq!(refs.len(), 2, "exactly two chunk references");

        let expected_keys: BTreeSet<&str> = [
            "chunk_id",
            "blob_hash",
            "byte_length",
            "object_count",
            "sample_count",
            "bounds",
        ]
        .into_iter()
        .collect();
        for (chunk, expected_samples) in [(&chunk_a, 3_usize), (&chunk_b, 0_usize)] {
            let reference = refs
                .get(&chunk.chunk_id)
                .unwrap_or_else(|| panic!("missing ref for {}", chunk.chunk_id));
            let actual_keys: BTreeSet<&str> = reference
                .as_object()
                .expect("chunk refs are objects")
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(actual_keys, expected_keys, "chunk ref field set is exact");

            let bytes = serde_json::to_vec(chunk).unwrap();
            let expected_hash = VfsBlobRepo::compute_hash(&bytes);
            let expected_len = bytes.len() as u64;
            assert_eq!(
                reference["blob_hash"].as_str(),
                Some(expected_hash.as_str())
            );
            assert_eq!(reference["byte_length"].as_u64(), Some(expected_len));
            assert_eq!(
                reference["object_count"].as_u64(),
                Some(chunk.objects.len() as u64)
            );
            assert_eq!(
                reference["sample_count"].as_u64(),
                Some(expected_samples as u64)
            );
            let bounds = reference["bounds"]
                .as_object()
                .expect("chunk bounds must be an object");
            assert_eq!(bounds.len(), 4);
            for key in ["x", "y", "width", "height"] {
                assert!(
                    bounds[key].as_f64().is_some_and(f64::is_finite),
                    "chunk bounds.{key} must be finite"
                );
            }

            let path = VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &expected_hash)
                .unwrap()
                .expect("chunk blob must exist");
            let stored = std::fs::read(path).unwrap();
            assert_eq!(stored, bytes, "stored chunk bytes are canonical");
            assert_eq!(stored.len() as u64, expected_len);
            assert_eq!(blob_ref_count(&conn, &expected_hash), 1);
            assert_eq!(sample_count(chunk), expected_samples);
        }

        // Visible bbox includes the rect's stroke half-width (2 / 2 = 1) on
        // every side, so the stored reference is the padded rectangle.
        let bounds_b = &refs["chunk-b"]["bounds"];
        assert_eq!(bounds_b["x"].as_f64(), Some(9_998_999.0));
        assert_eq!(bounds_b["y"].as_f64(), Some(9_998_999.0));
        assert_eq!(bounds_b["width"].as_f64(), Some(102.0));
        assert_eq!(bounds_b["height"].as_f64(), Some(102.0));

        let new_manifest_hash = manifest_blob_hash(&conn, &saved.document_id);
        assert_eq!(blob_ref_count(&conn, &new_manifest_hash), 1);
        assert_eq!(
            blob_ref_count(&conn, &old_manifest_hash),
            0,
            "the superseded canonical manifest loses its only reference"
        );
        let (file_hash, sha256, page_count, resource_hash) =
            file_index_state(&conn, &saved.document_id);
        assert_eq!(file_hash, new_manifest_hash);
        assert_eq!(sha256, new_manifest_hash);
        assert_eq!(resource_hash, new_manifest_hash);
        assert_eq!(page_count, 0);
    }

    #[test]
    fn missing_chunk_never_returns_a_partial_result() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-missing-create", "Board missing");
        let chunk_a = chunk(
            "chunk-a",
            vec![rect_object("obj-a", 0.0, 0.0, 10.0, 10.0, 0)],
        );
        let chunk_b = chunk(
            "chunk-b",
            vec![rect_object("obj-b", 20.0, 20.0, 10.0, 10.0, 1)],
        );
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-missing-save",
            &[chunk_a, chunk_b.clone()],
            &[],
        )
        .unwrap();

        assert!(VfsInkBoardRepo::get_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &saved.document_id,
            &["chunk-a".to_owned(), "chunk-not-in-manifest".to_owned()],
        )
        .is_err());

        let refs = chunk_refs(&manifest_wire(&conn, &db, &saved.document_id));
        let chunk_b_hash = chunk_ref_hash(&refs["chunk-b"]);
        let path = VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &chunk_b_hash)
            .unwrap()
            .unwrap();
        std::fs::remove_file(path).unwrap();

        assert!(
            VfsInkBoardRepo::get_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &saved.document_id,
                &["chunk-a".to_owned(), "chunk-b".to_owned()],
            )
            .is_err(),
            "a missing canonical chunk must fail the whole read, not return chunk-a alone"
        );
        assert_eq!(
            VfsInkBoardRepo::get_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &saved.document_id,
                &["chunk-a".to_owned()],
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn deleted_chunks_are_removed_in_the_same_cas_commit() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-delete-create", "Board delete");
        let chunk_a = chunk(
            "chunk-a",
            vec![rect_object("obj-a", 0.0, 0.0, 10.0, 10.0, 0)],
        );
        let chunk_b = chunk(
            "chunk-b",
            vec![rect_object("obj-b", 20.0, 20.0, 10.0, 10.0, 1)],
        );
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-delete-save",
            &[chunk_a.clone(), chunk_b.clone()],
            &[],
        )
        .unwrap();
        let refs = chunk_refs(&manifest_wire(&conn, &db, &saved.document_id));
        let chunk_a_hash = chunk_ref_hash(&refs["chunk-a"]);
        let chunk_b_hash = chunk_ref_hash(&refs["chunk-b"]);

        let deleted = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &saved.document_id,
            &saved.revision,
            "board-delete-commit",
            &[],
            &["chunk-a".to_owned()],
        )
        .unwrap();
        assert_ne!(deleted.revision, saved.revision);

        let remaining = chunk_refs(&manifest_wire(&conn, &db, &deleted.document_id));
        assert_eq!(remaining.len(), 1);
        assert!(remaining.contains_key("chunk-b"));
        assert!(!remaining.contains_key("chunk-a"));
        assert_eq!(blob_ref_count(&conn, &chunk_a_hash), 0);
        assert_eq!(blob_ref_count(&conn, &chunk_b_hash), 1);
        assert!(VfsInkBoardRepo::get_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &deleted.document_id,
            &["chunk-a".to_owned()],
        )
        .is_err());
        assert_eq!(
            VfsInkBoardRepo::get_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &deleted.document_id,
                &["chunk-b".to_owned()],
            )
            .unwrap(),
            vec![chunk_b]
        );
    }

    #[test]
    fn signed_safe_range_boundary_is_accepted_and_beyond_is_rejected_without_writes() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-range-create", "Board range");

        // A filled region highlight has no stroke half-width beyond its rect,
        // so its visible bbox still fits exactly at the signed world boundary.
        // Stroked shapes at the same coordinate are covered by the dedicated
        // visible-overflow rejection test below.
        let boundary = chunk(
            "chunk-boundary",
            vec![region_highlight_object(
                "obj-boundary",
                -SAFE_COORDINATE_LIMIT,
                -SAFE_COORDINATE_LIMIT,
                1.0,
                1.0,
                0,
            )],
        );
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-range-boundary",
            &[boundary.clone()],
            &[],
        )
        .unwrap();
        assert_eq!(
            VfsInkBoardRepo::get_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &saved.document_id,
                &["chunk-boundary".to_owned()],
            )
            .unwrap(),
            vec![boundary]
        );

        let before = database_counts(&conn);
        let too_far = chunk(
            "chunk-too-far",
            vec![rect_object(
                "obj-too-far",
                SAFE_COORDINATE_LIMIT + 0.5,
                0.0,
                1.0,
                1.0,
                1,
            )],
        );
        assert!(VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &saved.document_id,
            &saved.revision,
            "board-range-rejected",
            &[too_far],
            &[],
        )
        .is_err());
        assert_eq!(database_counts(&conn), before);
        let wire = manifest_wire(&conn, &db, &saved.document_id);
        assert_eq!(wire["revision"].as_str(), Some(saved.revision.as_str()));
        assert_eq!(chunk_refs(&wire).len(), 1);
    }

    #[test]
    fn chunk_bounds_cover_visible_stroke_padding_and_arrow_head() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-visible-bounds-create", "Board visible");

        let rect = rect_object_with_width("obj-rect-visible", 0.0, 0.0, 10.0, 10.0, 256.0, 0);
        let ellipse =
            ellipse_object_with_width("obj-ellipse-visible", 0.0, 0.0, 10.0, 10.0, 256.0, 1);
        let arrow = arrow_object("obj-arrow-head", 0.0, 0.0, 100.0, 0.0, 2.0, 2);
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-visible-bounds-save",
            &[
                chunk("chunk-rect-visible", vec![rect]),
                chunk("chunk-ellipse-visible", vec![ellipse]),
                chunk("chunk-arrow-head", vec![arrow]),
            ],
            &[],
        )
        .unwrap();

        let refs = chunk_refs(&manifest_wire(&conn, &db, &saved.document_id));

        // Stroke width 256 contributes a visible half-width of 128 on every
        // side, so a (0,0,10,10) rect/ellipse must cover [-128, 138].
        assert_bounds_contain(
            &refs["chunk-rect-visible"]["bounds"],
            -128.0,
            -128.0,
            138.0,
            138.0,
            "stroked rect (width 256)",
        );
        assert_bounds_contain(
            &refs["chunk-ellipse-visible"]["bounds"],
            -128.0,
            -128.0,
            138.0,
            138.0,
            "stroked ellipse (width 256)",
        );

        // Arrow stroke width 2 pads 1. The renderer head points are at
        // `to - headlen * (cos/sin)(angle +- PI/6)`: for (0,0)->(100,0) with
        // headlen 8 they land at x ~= 93.07, y = +-4, so the tip stays the
        // right-most coordinate. Correct visible bbox: x in [-1, 101],
        // y in [-5, 5] -- not just the +-1 stroke-only line bbox.
        assert_bounds_contain(
            &refs["chunk-arrow-head"]["bounds"],
            -1.0,
            -5.0,
            101.0,
            5.0,
            "arrow with visible head",
        );
    }

    #[test]
    fn duplicate_z_index_across_chunks_is_rejected_without_writes() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-z-create", "Board z");

        // Two changed chunks in one save sharing a z_index must be rejected
        // before any manifest or blob publication.
        let before = database_counts(&conn);
        let same_z_changed = [
            chunk(
                "chunk-z-a",
                vec![rect_object("obj-z-a", 0.0, 0.0, 10.0, 10.0, 0)],
            ),
            chunk(
                "chunk-z-b",
                vec![rect_object("obj-z-b", 20.0, 0.0, 10.0, 10.0, 0)],
            ),
        ];
        assert!(
            VfsInkBoardRepo::save_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &created.document_id,
                &created.revision,
                "board-z-dup-changed",
                &same_z_changed,
                &[],
            )
            .is_err(),
            "two changed chunks sharing a z_index must be rejected"
        );
        assert_eq!(
            database_counts(&conn),
            before,
            "a rejected changed/changed z conflict must not write"
        );
        let wire = manifest_wire(&conn, &db, &created.document_id);
        assert_eq!(wire["revision"].as_str(), Some(created.revision.as_str()));
        assert_eq!(chunk_refs(&wire).len(), 0);

        // A changed chunk reusing the z_index of an unchanged chunk must also
        // be rejected without publishing a new revision.
        let base = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-z-base",
            &[chunk(
                "chunk-z-a",
                vec![rect_object("obj-z-a", 0.0, 0.0, 10.0, 10.0, 0)],
            )],
            &[],
        )
        .unwrap();
        let after_base = database_counts(&conn);

        assert!(
            VfsInkBoardRepo::save_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &base.document_id,
                &base.revision,
                "board-z-dup-unchanged",
                &[chunk(
                    "chunk-z-b",
                    vec![rect_object("obj-z-b", 20.0, 0.0, 10.0, 10.0, 0)],
                )],
                &[],
            )
            .is_err(),
            "a changed chunk sharing z_index with an unchanged chunk must be rejected"
        );
        assert_eq!(
            database_counts(&conn),
            after_base,
            "a rejected changed/unchanged z conflict must not write"
        );
        let wire = manifest_wire(&conn, &db, &base.document_id);
        assert_eq!(wire["revision"].as_str(), Some(base.revision.as_str()));
        let refs = chunk_refs(&wire);
        assert_eq!(refs.len(), 1);
        assert!(refs.contains_key("chunk-z-a"));
    }

    #[test]
    fn visible_stroke_overflow_at_world_limit_is_rejected_without_clamping_or_writes() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(
            &conn,
            &db,
            "board-stroke-overflow-create",
            "Board stroke overflow",
        );
        let before = database_counts(&conn);

        // The sample point itself is exactly at +10M, but a width-256 stroke
        // has 128 units of visible ink beyond it. Clamping the bbox to the
        // world limit would silently hide content, so this must be rejected.
        let overflowing = chunk(
            "chunk-stroke-overflow",
            vec![stroke_object_with_width(
                "obj-stroke-overflow",
                SAFE_COORDINATE_LIMIT,
                0.0,
                1,
                256.0,
                0,
            )],
        );
        assert!(
            VfsInkBoardRepo::save_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &created.document_id,
                &created.revision,
                "board-stroke-overflow-rejected",
                &[overflowing],
                &[],
            )
            .is_err(),
            "a visible stroke half-width past +10M must be rejected, not clamped"
        );
        assert_eq!(
            database_counts(&conn),
            before,
            "a rejected visible overflow must not write"
        );
        let wire = manifest_wire(&conn, &db, &created.document_id);
        assert_eq!(wire["revision"].as_str(), Some(created.revision.as_str()));
        assert_eq!(chunk_refs(&wire).len(), 0);
    }

    /// A board-bearing database must stay readable from a legacy connection
    /// that never registered the writer-capability UDF, while guarded tables
    /// (`files`/`blobs`) must fail closed on write. The pool connection, which
    /// registers the capability, keeps saving and reading normally.
    #[test]
    fn legacy_connection_without_capability_reads_board_but_guarded_writes_fail_closed() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-guard-create", "Board guard");
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-guard-save",
            &[chunk(
                "chunk-guard",
                vec![rect_object("obj-guard", 0.0, 0.0, 10.0, 10.0, 0)],
            )],
            &[],
        )
        .unwrap();

        let refs = chunk_refs(&manifest_wire(&conn, &db, &saved.document_id));
        let chunk_hash = chunk_ref_hash(&refs["chunk-guard"]);
        let manifest_hash = manifest_blob_hash(&conn, &saved.document_id);
        let before_chunk_refs = blob_ref_count(&conn, &chunk_hash);
        assert_eq!(before_chunk_refs, 1);

        // Real database, separate raw connection: no capability registration.
        let raw = Connection::open(db.db_path()).expect("open legacy raw connection");

        // SELECT still works for both the file row and the chunk blob.
        let (raw_blob_hash, raw_sha256): (String, String) = raw
            .query_row(
                "SELECT blob_hash, sha256 FROM files WHERE id = ?1",
                [&saved.document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(raw_blob_hash, manifest_hash);
        assert_eq!(raw_sha256, manifest_hash);
        assert_eq!(
            raw.query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&chunk_hash],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            before_chunk_refs
        );
        let chunk_path = VfsBlobRepo::get_blob_path_with_conn(&raw, db.blobs_dir(), &chunk_hash)
            .unwrap()
            .expect("legacy connection can locate the chunk blob");
        let chunk_bytes = std::fs::read(chunk_path).unwrap();
        assert_eq!(VfsBlobRepo::compute_hash(&chunk_bytes), chunk_hash);

        // Guarded writes are rejected by the legacy connection...
        assert!(
            raw.execute(
                "UPDATE files SET blob_hash = blob_hash WHERE id = ?1",
                [&saved.document_id],
            )
            .is_err(),
            "legacy writer must not update files after a board exists"
        );
        assert!(
            raw.execute(
                "UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?1",
                [&chunk_hash],
            )
            .is_err(),
            "legacy writer must not change blob reference counts"
        );
        assert!(
            raw.execute("DELETE FROM blobs WHERE hash = ?1", [&chunk_hash])
                .is_err(),
            "legacy writer must not delete a chunk blob"
        );

        // ...and none of the rejected statements left a trace.
        let (after_blob_hash, after_sha256): (String, String) = raw
            .query_row(
                "SELECT blob_hash, sha256 FROM files WHERE id = ?1",
                [&saved.document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(after_blob_hash, manifest_hash);
        assert_eq!(after_sha256, manifest_hash);
        assert_eq!(blob_ref_count(&raw, &chunk_hash), before_chunk_refs);
        assert!(
            VfsBlobRepo::get_blob_path_with_conn(&raw, db.blobs_dir(), &chunk_hash)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            raw.query_row(
                "SELECT COUNT(*) FROM blobs WHERE hash = ?1",
                [&chunk_hash],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );

        // A fresh pool connection (capability registered by the pool init hook)
        // can still save and read.
        let pool = db.get_conn_safe().unwrap();
        let next = VfsInkBoardRepo::save_chunks_with_conn(
            &pool,
            db.blobs_dir(),
            &saved.document_id,
            &saved.revision,
            "board-guard-pool-save",
            &[chunk(
                "chunk-guard-2",
                vec![rect_object("obj-guard-2", 20.0, 0.0, 10.0, 10.0, 1)],
            )],
            &[],
        )
        .unwrap();
        assert_ne!(next.revision, saved.revision);
        let reopened = VfsInkBoardRepo::get_chunks_with_conn(
            &pool,
            db.blobs_dir(),
            &next.document_id,
            &["chunk-guard".to_owned(), "chunk-guard-2".to_owned()],
        )
        .unwrap();
        assert_eq!(reopened.len(), 2);
        assert_eq!(reopened[0].chunk_id, "chunk-guard");
        assert_eq!(reopened[1].chunk_id, "chunk-guard-2");
    }

    /// The renderer caps the arrow head at `max(8, width * 4)`, not at 8 and
    /// not at the shaft length. With width 256 the head is 1024 long, so its
    /// two rear points reach x ~ -786.81 and y = +-512; stroke padding 128
    /// then yields x ~ -914.81..228 and y +-640.
    #[test]
    fn wide_arrow_bounds_use_renderer_head_length() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-wide-arrow-create", "Board wide arrow");

        let arrow = arrow_object("obj-wide-arrow", 0.0, 0.0, 100.0, 0.0, 256.0, 0);
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-wide-arrow-save",
            &[chunk("chunk-wide-arrow", vec![arrow])],
            &[],
        )
        .unwrap();
        let refs = chunk_refs(&manifest_wire(&conn, &db, &saved.document_id));

        let width = 256.0_f64;
        let head_len = 8.0_f64.max(width * 4.0);
        let head_angle = std::f64::consts::FRAC_PI_6;
        let head_x = 100.0 - head_len * head_angle.cos();
        let head_y = head_len * head_angle.sin();
        let pad = width / 2.0;
        assert_bounds_contain(
            &refs["chunk-wide-arrow"]["bounds"],
            head_x - pad,
            -head_y - pad,
            100.0 + pad,
            head_y + pad,
            "wide arrow with renderer head length",
        );
    }

    /// Stroke padding follows
    /// `max(0.01, width * (pressure_enabled ? 0.25 + 0.75 * p : 1.0)) / 2`.
    /// Non-pressure ink ignores the sample pressure; pressure ink at p=0 still
    /// keeps a quarter of the nominal width.
    #[test]
    fn stroke_padding_uses_pressure_enabled_formula_and_rejects_world_edge_overflow() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(&conn, &db, "board-stroke-pad-create", "Board stroke pad");

        let flat =
            stroke_object_with_pressure("obj-stroke-flat", 0.0, 0.0, 1, 256.0, 0.5, false, 0);
        let pressure_zero = stroke_object_with_pressure(
            "obj-stroke-pressure-zero",
            0.0,
            0.0,
            1,
            256.0,
            0.0,
            true,
            1,
        );
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-stroke-pad-save",
            &[
                chunk("chunk-stroke-flat", vec![flat]),
                chunk("chunk-stroke-pressure-zero", vec![pressure_zero]),
            ],
            &[],
        )
        .unwrap();
        let refs = chunk_refs(&manifest_wire(&conn, &db, &saved.document_id));

        // Non-pressure: 256 * 1.0 / 2 = 128 on both axes.
        let flat_bounds = &refs["chunk-stroke-flat"]["bounds"];
        assert_eq!(flat_bounds["x"].as_f64(), Some(-128.0));
        assert_eq!(flat_bounds["y"].as_f64(), Some(-128.0));
        assert_eq!(flat_bounds["width"].as_f64(), Some(256.0));
        assert_eq!(flat_bounds["height"].as_f64(), Some(256.0));

        // Pressure-enabled at p=0: 256 * 0.25 / 2 = 32 on both axes.
        let pressure_bounds = &refs["chunk-stroke-pressure-zero"]["bounds"];
        assert_eq!(pressure_bounds["x"].as_f64(), Some(-32.0));
        assert_eq!(pressure_bounds["y"].as_f64(), Some(-32.0));
        assert_eq!(pressure_bounds["width"].as_f64(), Some(64.0));
        assert_eq!(pressure_bounds["height"].as_f64(), Some(64.0));

        // At the world edge even the smallest formula pad leaves the safe
        // range, so both variants must be rejected without writing.
        let before = database_counts(&conn);
        let flat_edge = chunk(
            "chunk-flat-edge",
            vec![stroke_object_with_pressure(
                "obj-flat-edge",
                SAFE_COORDINATE_LIMIT,
                0.0,
                1,
                256.0,
                0.5,
                false,
                2,
            )],
        );
        assert!(VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &saved.document_id,
            &saved.revision,
            "board-stroke-flat-edge",
            &[flat_edge],
            &[],
        )
        .is_err());
        assert_eq!(database_counts(&conn), before);

        let pressure_edge = chunk(
            "chunk-pressure-edge",
            vec![stroke_object_with_pressure(
                "obj-pressure-edge",
                SAFE_COORDINATE_LIMIT,
                0.0,
                1,
                256.0,
                0.0,
                true,
                3,
            )],
        );
        assert!(VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &saved.document_id,
            &saved.revision,
            "board-stroke-pressure-edge",
            &[pressure_edge],
            &[],
        )
        .is_err());
        assert_eq!(database_counts(&conn), before);

        let wire = manifest_wire(&conn, &db, &saved.document_id);
        assert_eq!(wire["revision"].as_str(), Some(saved.revision.as_str()));
        assert_eq!(chunk_refs(&wire).len(), 2);
    }

    #[test]
    fn board_overview_reports_global_max_z_from_far_offscreen_third_chunk() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(
            &conn,
            &db,
            "board-overview-max-create",
            "Board overview max",
        );

        let chunk_a = chunk(
            "chunk-a",
            vec![rect_object("obj-a", 0.0, 0.0, 10.0, 10.0, 0)],
        );
        let chunk_b = chunk(
            "chunk-b",
            vec![rect_object("obj-b", 100.0, 100.0, 10.0, 10.0, 7)],
        );
        // The largest z lives in the third chunk, far from the origin. A reader
        // that stops after the first chunk, or scans only the visible viewport,
        // misses it; a JS Number would round this value.
        let chunk_c = chunk(
            "chunk-c",
            vec![rect_object(
                "obj-c",
                9_999_000.0,
                -9_999_000.0,
                10.0,
                10.0,
                9_007_199_254_740_993,
            )],
        );
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-overview-max-save",
            &[chunk_a, chunk_b, chunk_c],
            &[],
        )
        .unwrap();

        let overview =
            VfsInkBoardRepo::overview_with_conn(&conn, db.blobs_dir(), &saved.document_id)
                .expect("overview must scan every chunk and return the global maximum z");
        assert_eq!(overview.document_id, saved.document_id);
        assert_eq!(overview.revision, saved.revision);
        assert_eq!(overview.page_id, board_surface_page_id(&saved));
        assert_eq!(
            overview.max_z_index.as_deref(),
            Some("9007199254740993"),
            "max_z_index must be the exact decimal i64, not a JS-rounded number"
        );

        let wire = serde_json::to_value(&overview).unwrap();
        assert!(
            wire["max_z_index"].is_string(),
            "the wire value must stay a decimal string: {wire}"
        );
        assert_eq!(wire["max_z_index"].as_str(), Some("9007199254740993"));

        let again =
            VfsInkBoardRepo::overview_with_conn(&conn, db.blobs_dir(), &saved.document_id).unwrap();
        assert_eq!(again, overview, "revision and surface page stay stable");
    }

    #[test]
    fn board_overview_empty_board_reports_null_max_z() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_board(
            &conn,
            &db,
            "board-overview-empty-create",
            "Board overview empty",
        );

        let overview =
            VfsInkBoardRepo::overview_with_conn(&conn, db.blobs_dir(), &created.document_id)
                .expect("an empty board still has a stable surface and revision");
        assert_eq!(overview.document_id, created.document_id);
        assert_eq!(overview.revision, created.revision);
        assert_eq!(overview.page_id, board_surface_page_id(&created));
        assert_eq!(overview.max_z_index, None);

        let wire = serde_json::to_value(&overview).unwrap();
        assert_eq!(wire["max_z_index"], json!(null));

        let again =
            VfsInkBoardRepo::overview_with_conn(&conn, db.blobs_dir(), &created.document_id)
                .unwrap();
        assert_eq!(again, overview);
    }

    #[test]
    fn board_overview_typed_rejects_v1_and_missing_or_corrupt_chunk_without_partial() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();

        // v1 is not a board; the overview must fail with the typed format
        // conflict, not reinterpret pages as chunks.
        let v1 = VfsInkRepo::create_blank_with_conn(
            &conn,
            db.blobs_dir(),
            "V1 overview",
            InkRuling::Blank,
            800.0,
            1100.0,
            "board-overview-v1-create",
            None,
        )
        .unwrap();
        let v1_error = VfsInkBoardRepo::overview_with_conn(&conn, db.blobs_dir(), &v1.document_id)
            .expect_err("v1 documents must not produce a board overview");
        assert!(
            matches!(
                &v1_error,
                VfsError::Conflict { key, .. } if key.as_str() == FORMAT_CONFLICT
            ),
            "v1 overview must be a typed format conflict, got {v1_error:?}"
        );

        let missing = create_board(
            &conn,
            &db,
            "board-overview-missing-create",
            "Board overview missing",
        );
        let missing_saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &missing.document_id,
            &missing.revision,
            "board-overview-missing-save",
            &[
                chunk(
                    "chunk-a",
                    vec![rect_object("obj-a", 0.0, 0.0, 10.0, 10.0, 0)],
                ),
                chunk(
                    "chunk-b",
                    vec![rect_object("obj-b", 50.0, 50.0, 10.0, 10.0, 1)],
                ),
                chunk(
                    "chunk-c",
                    vec![rect_object(
                        "obj-c",
                        9_999_000.0,
                        -9_999_000.0,
                        10.0,
                        10.0,
                        2,
                    )],
                ),
            ],
            &[],
        )
        .unwrap();
        let refs = chunk_refs(&manifest_wire(&conn, &db, &missing_saved.document_id));
        let chunk_c_hash = chunk_ref_hash(&refs["chunk-c"]);
        let chunk_c_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &chunk_c_hash)
                .unwrap()
                .expect("third chunk blob must exist");
        std::fs::remove_file(&chunk_c_path).unwrap();

        assert!(
            VfsInkBoardRepo::get_chunks_with_conn(
                &conn,
                db.blobs_dir(),
                &missing_saved.document_id,
                &["chunk-a".to_owned()],
            )
            .is_ok(),
            "the board is otherwise readable, so overview failure must not be a partial scan"
        );
        let missing_error =
            VfsInkBoardRepo::overview_with_conn(&conn, db.blobs_dir(), &missing_saved.document_id)
                .expect_err("a missing referenced chunk must fail the whole overview");
        assert!(
            matches!(
                &missing_error,
                VfsError::NotFound { resource_type, .. } if resource_type.as_str() == "ink blob"
            ),
            "missing chunk must surface as a typed not-found blob error, got {missing_error:?}"
        );

        let corrupt = create_board(
            &conn,
            &db,
            "board-overview-corrupt-create",
            "Board overview corrupt",
        );
        let corrupt_saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &corrupt.document_id,
            &corrupt.revision,
            "board-overview-corrupt-save",
            &[
                chunk(
                    "chunk-a",
                    vec![rect_object("obj-d", 0.0, 0.0, 10.0, 10.0, 0)],
                ),
                chunk(
                    "chunk-b",
                    vec![rect_object("obj-e", 50.0, 50.0, 10.0, 10.0, 1)],
                ),
                chunk(
                    "chunk-c",
                    vec![rect_object(
                        "obj-f",
                        9_999_000.0,
                        -9_999_000.0,
                        10.0,
                        10.0,
                        2,
                    )],
                ),
            ],
            &[],
        )
        .unwrap();
        let refs = chunk_refs(&manifest_wire(&conn, &db, &corrupt_saved.document_id));
        let chunk_c_hash = chunk_ref_hash(&refs["chunk-c"]);
        let chunk_c_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &chunk_c_hash)
                .unwrap()
                .expect("third chunk blob must exist");
        let mut corrupt_bytes = std::fs::read(&chunk_c_path).unwrap();
        corrupt_bytes.push(b' ');
        std::fs::write(&chunk_c_path, corrupt_bytes).unwrap();

        let corrupt_error =
            VfsInkBoardRepo::overview_with_conn(&conn, db.blobs_dir(), &corrupt_saved.document_id)
                .expect_err("a corrupt referenced chunk must fail the whole overview");
        assert!(
            matches!(
                &corrupt_error,
                VfsError::Conflict { key, .. } if key.as_str() == "ink.blob_corrupt"
            ),
            "corrupt chunk must surface as a typed blob-corrupt conflict, got {corrupt_error:?}"
        );
    }
}
