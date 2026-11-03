//! Repository operations for `.dsink` documents stored in canonical VFS file rows.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
};

use sha2::{Digest, Sha256};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::vfs::upload_saga::with_savepoint;
use crate::vfs::{
    error::{VfsError, VfsResult},
    ink::{
        parse_manifest, parse_page, validate_manifest, validate_page, InkBackground, InkManifest,
        InkOperationReceipt, InkPage, InkPageRef, InkRuling, InkSource, INK_EXTENSION,
        INK_MANIFEST_MAX_BYTES, INK_MIME, INK_PAGES_MAX, INK_PAGE_MAX_BYTES, INK_SCHEMA_VERSION,
    },
    repos::{
        blob_repo::{acquire_blob_mutation_guard, BlobMutationGuard, VfsBlobRepo},
        folder_repo::VfsFolderRepo,
    },
    types::VfsFolderItem,
};

const OPERATION_REUSED: &str = "ink.operation_id_reused";
const OPERATION_UNKNOWN: &str = "ink.operation_state_unknown";
const REVISION_CONFLICT: &str = "ink.revision_conflict";
const FORMAT_CONFLICT: &str = "ink.format_conflict";
const BLOB_CORRUPT: &str = "ink.blob_corrupt";

#[derive(Serialize)]
struct CreateInput<'a> {
    title: &'a str,
    ruling: InkRuling,
    width: f64,
    height: f64,
    folder_id: Option<&'a str>,
}

#[derive(Serialize)]
struct SaveInput<'a> {
    document_id: &'a str,
    expected_revision: &'a str,
    page: &'a InkPage,
}

#[derive(Serialize)]
struct CopyInput<'a> {
    source_document_id: &'a str,
    source_revision: &'a str,
    title: &'a str,
    folder_id: Option<&'a str>,
}

#[derive(Serialize)]
struct AppendInput<'a> {
    document_id: &'a str,
    expected_revision: &'a str,
    width: f64,
    height: f64,
    ruling: InkRuling,
}

#[derive(Serialize)]
struct RenameInput<'a> {
    document_id: &'a str,
    expected_revision: &'a str,
    title: &'a str,
}

struct InkFileState {
    resource_id: String,
    manifest_hash: String,
    resource_hash: String,
}

pub struct VfsInkRepo;

impl VfsInkRepo {
    pub fn create_blank_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        title: &str,
        ruling: InkRuling,
        width: f64,
        height: f64,
        operation_id: &str,
        folder_id: Option<&str>,
    ) -> VfsResult<InkManifest> {
        let guard = acquire_mutation_guard(conn)?;
        Self::create_blank_with_guard(
            conn,
            blobs_dir,
            title,
            ruling,
            width,
            height,
            operation_id,
            folder_id,
            &guard,
        )
    }

    pub(crate) fn acquire_mutation_guard(conn: &Connection) -> VfsResult<BlobMutationGuard> {
        super::ink_repo::acquire_mutation_guard(conn)
    }

    pub(crate) fn create_blank_with_guard(
        conn: &Connection,
        blobs_dir: &Path,
        title: &str,
        ruling: InkRuling,
        width: f64,
        height: f64,
        operation_id: &str,
        folder_id: Option<&str>,
        guard: &BlobMutationGuard,
    ) -> VfsResult<InkManifest> {
        validate_operation_id(operation_id)?;
        if title.trim().is_empty() {
            return Err(invalid_ink_argument("title", "Ink title must be nonempty"));
        }
        let input_hash = hash_json(&CreateInput {
            title,
            ruling,
            width,
            height,
            folder_id,
        })?;
        let document_id = format!(
            "file_ink_{}",
            VfsBlobRepo::compute_hash(
                format!("deepstudent.dsink.create.v1\0{operation_id}").as_bytes()
            )
        );

        if file_id_exists(conn, &document_id)? {
            let current = Self::get_manifest_with_conn(conn, blobs_dir, &document_id)?;
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

        if title.chars().count() > crate::vfs::ink::INK_TITLE_MAX_CHARS {
            return Err(conflict(
                "ink.limit_exceeded",
                "Ink title exceeds the character limit",
            ));
        }
        let page = InkPage {
            schema_version: INK_SCHEMA_VERSION,
            page_id: format!("p_{}", nanoid::nanoid!(12)),
            objects: Vec::new(),
        };
        let page_bytes = serialize_page(&page)?;
        let page_ref = InkPageRef {
            page_id: page.page_id.clone(),
            width,
            height,
            background: InkBackground::Blank { ruling },
            page_blob_hash: VfsBlobRepo::compute_hash(&page_bytes),
        };
        validate_page(&page, &page_ref).map_err(map_ink_error)?;
        let revision = format!("r_{}", nanoid::nanoid!(16));
        let mut manifest = InkManifest {
            schema_version: INK_SCHEMA_VERSION,
            document_id: document_id.clone(),
            revision: revision.clone(),
            title: title.to_owned(),
            source: InkSource::Blank {},
            pages: vec![page_ref],
            last_operation: Some(InkOperationReceipt {
                operation_id: operation_id.to_owned(),
                input_hash,
                previous_revision: None,
                result_revision: revision,
            }),
        };

        with_savepoint(conn, "ink_create", || {
            let page_blob = VfsBlobRepo::store_blob_with_conn_guarded(
                conn,
                blobs_dir,
                &page_bytes,
                Some("application/json"),
                Some("json"),
                guard,
            )?;
            manifest.pages[0].page_blob_hash = page_blob.hash.clone();
            validate_manifest(&manifest).map_err(map_ink_error)?;

            let manifest_bytes = serialize_manifest(&manifest)?;
            let manifest_blob = VfsBlobRepo::store_blob_with_conn_guarded(
                conn,
                blobs_dir,
                &manifest_bytes,
                Some(INK_MIME),
                Some(INK_EXTENSION),
                guard,
            )?;
            let preview_json = preview_json(&manifest, &manifest_blob.hash)?;
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
                   VALUES (?1, ?2, ?3, ?3, ?4, NULL, ?5, 1, 'document', ?6, '[]', 0, 'active', ?7, ?7, ?8)"#,
                params![
                    document_id,
                    resource_id,
                    manifest_blob.hash,
                    format!("{title}.{INK_EXTENSION}"),
                    manifest_bytes.len() as i64,
                    INK_MIME,
                    now,
                    preview_json,
                ],
            )?;
            let item = VfsFolderItem::new(
                folder_id.map(str::to_owned),
                "file".to_owned(),
                document_id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &item)?;
            Ok(manifest.clone())
        })
    }

    pub fn copy_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        title: &str,
        operation_id: &str,
        folder_id: Option<&str>,
    ) -> VfsResult<InkManifest> {
        let guard = acquire_mutation_guard(conn)?;
        validate_operation_id(operation_id)?;
        if title.trim().is_empty() || title.chars().count() > crate::vfs::ink::INK_TITLE_MAX_CHARS {
            return Err(invalid_ink_argument("title", "Ink copy title is invalid"));
        }
        let operation_scope = format!(
            "copyop_{}",
            VfsBlobRepo::compute_hash(format!("{document_id}\0{operation_id}").as_bytes())
        );
        let copy_id = format!(
            "file_ink_copy_{}",
            VfsBlobRepo::compute_hash(
                format!("deepstudent.dsink.copy.v1\0{document_id}\0{operation_id}").as_bytes()
            )
        );

        let source = if file_id_exists(conn, &copy_id)? {
            let current = Self::get_manifest_with_conn(conn, blobs_dir, &copy_id)?;
            let receipt = current.last_operation.as_ref().ok_or_else(|| {
                conflict(
                    OPERATION_UNKNOWN,
                    "Copy operation result can no longer be proven",
                )
            })?;
            if receipt.operation_id != operation_scope {
                return Err(conflict(
                    OPERATION_UNKNOWN,
                    "Copy operation result can no longer be proven",
                ));
            }
            let source_revision = receipt.previous_revision.as_deref().ok_or_else(|| {
                conflict(OPERATION_UNKNOWN, "Copy source revision is unavailable")
            })?;
            let input_hash = hash_json(&CopyInput {
                source_document_id: document_id,
                source_revision,
                title,
                folder_id,
            })?;
            if receipt.input_hash == input_hash {
                return Ok(current);
            }
            return Err(conflict(
                OPERATION_REUSED,
                "Copy operation ID was already used with different input",
            ));
        } else {
            Self::get_manifest_with_conn(conn, blobs_dir, document_id)?
        };
        let input_hash = hash_json(&CopyInput {
            source_document_id: document_id,
            source_revision: &source.revision,
            title,
            folder_id,
        })?;
        if let Some(folder_id) = folder_id {
            if !VfsFolderRepo::folder_exists_with_conn(conn, folder_id)? {
                return Err(VfsError::FolderNotFound {
                    folder_id: folder_id.to_owned(),
                });
            }
        }

        let mut pages = Vec::with_capacity(source.pages.len());
        let mut copied_page_bytes = Vec::with_capacity(source.pages.len());
        for source_ref in &source.pages {
            let source_page =
                Self::get_page_with_conn(conn, blobs_dir, document_id, &source_ref.page_id)?;
            let mut page = source_page;
            page.page_id = format!("p_{}", nanoid::nanoid!(12));
            for object in &mut page.objects {
                object.id = format!("o_{}", nanoid::nanoid!(12));
            }
            let bytes = serialize_page(&page)?;
            let page_hash = VfsBlobRepo::compute_hash(&bytes);
            copied_page_bytes.push(bytes);
            pages.push(InkPageRef {
                page_id: page.page_id,
                width: source_ref.width,
                height: source_ref.height,
                background: source_ref.background.clone(),
                page_blob_hash: page_hash,
            });
        }
        let revision = format!("r_{}", nanoid::nanoid!(16));
        let source_revision = source.revision.clone();
        let mut manifest = InkManifest {
            schema_version: source.schema_version,
            document_id: copy_id.clone(),
            revision: revision.clone(),
            title: title.to_owned(),
            source: source.source.clone(),
            pages,
            last_operation: Some(InkOperationReceipt {
                operation_id: operation_scope,
                input_hash,
                previous_revision: Some(source_revision),
                result_revision: revision,
            }),
        };
        validate_manifest(&manifest).map_err(map_ink_error)?;

        with_savepoint(conn, "ink_copy", || {
            let mut temporary_refs = BTreeMap::<String, i32>::new();
            for (index, bytes) in copied_page_bytes.iter().enumerate() {
                let stored = VfsBlobRepo::store_blob_with_conn_guarded(
                    conn,
                    blobs_dir,
                    bytes,
                    Some("application/json"),
                    Some("json"),
                    &guard,
                )?;
                *temporary_refs.entry(stored.hash.clone()).or_default() += 1;
                manifest.pages[index].page_blob_hash = stored.hash;
            }
            validate_manifest(&manifest).map_err(map_ink_error)?;
            let manifest_bytes = serialize_manifest(&manifest)?;
            let manifest_blob = VfsBlobRepo::store_blob_with_conn_guarded(
                conn,
                blobs_dir,
                &manifest_bytes,
                Some(INK_MIME),
                Some(INK_EXTENSION),
                &guard,
            )?;
            *temporary_refs
                .entry(manifest_blob.hash.clone())
                .or_default() += 1;
            let preview = preview_json(&manifest, &manifest_blob.hash)?;
            let mut deltas = reference_counts(&manifest, &manifest_blob.hash);
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
            let now_ms = chrono::Utc::now().timestamp_millis();
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let resource_id = format!("res_{}", nanoid::nanoid!(12));
            conn.execute(
                "INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at) VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', 0, ?4, ?4)",
                params![resource_id, manifest_blob.hash, copy_id, now_ms],
            )?;
            conn.execute(
                r#"INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count, "type", mime_type, tags_json, is_favorite, status, created_at, updated_at, preview_json)
                   VALUES (?1, ?2, ?3, ?3, ?4, NULL, ?5, ?6, 'document', ?7, '[]', 0, 'active', ?8, ?8, ?9)"#,
                params![
                    copy_id,
                    resource_id,
                    manifest_blob.hash,
                    format!("{title}.{INK_EXTENSION}"),
                    manifest_bytes.len() as i64,
                    manifest.pages.len() as i32,
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
                    copy_id.clone(),
                ),
            )?;
            Ok(manifest.clone())
        })
    }

    pub fn get_manifest_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
    ) -> VfsResult<InkManifest> {
        Self::load_manifest(conn, blobs_dir, document_id).map(|(manifest, _)| manifest)
    }

    pub fn is_ink_file_candidate_with_conn(
        conn: &Connection,
        document_id: &str,
    ) -> VfsResult<bool> {
        let metadata = conn
            .query_row(
                "SELECT mime_type, file_name, preview_json FROM files WHERE id = ?1",
                [document_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        Ok(metadata.is_some_and(|(mime, name, preview)| {
            document_id.starts_with("file_ink_")
                || mime.as_deref() == Some(INK_MIME)
                || name
                    .as_deref()
                    .is_some_and(|name| name.ends_with(&format!(".{INK_EXTENSION}")))
                || preview.as_deref().is_some_and(|json| {
                    serde_json::from_str::<Value>(json)
                        .ok()
                        .is_some_and(|value| value.get("ink").is_some())
                })
        }))
    }

    pub fn purge_file_refs_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
    ) -> VfsResult<bool> {
        let Some((
            mime_type,
            file_type,
            file_name,
            status,
            manifest_hash,
            sha256,
            page_count,
            preview_json,
            compressed_hash,
            resource_hash,
        )) = conn
            .query_row(
                r#"SELECT f.mime_type, f."type", f.file_name, f.status,
                          f.blob_hash, f.sha256, f.page_count, f.preview_json,
                          f.compressed_blob_hash, r.hash
                   FROM files f LEFT JOIN resources r ON r.id = f.resource_id WHERE f.id = ?1"#,
                [document_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<i32>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(false);
        };
        let is_candidate = document_id.starts_with("file_ink_")
            || mime_type.as_deref() == Some(INK_MIME)
            || file_name
                .as_deref()
                .is_some_and(|name| name.ends_with(&format!(".{INK_EXTENSION}")))
            || preview_json.as_deref().is_some_and(|json| {
                serde_json::from_str::<Value>(json)
                    .ok()
                    .is_some_and(|value| value.get("ink").is_some())
            });
        if !is_candidate {
            return Ok(false);
        }
        let (
            Some(manifest_hash),
            Some(sha256),
            Some(file_name),
            Some(page_count),
            Some(preview_json),
            Some(resource_hash),
        ) = (
            manifest_hash,
            sha256,
            file_name,
            page_count,
            preview_json,
            resource_hash,
        )
        else {
            return Err(conflict(
                FORMAT_CONFLICT,
                "Ink file reference metadata is incomplete",
            ));
        };
        if mime_type.as_deref() != Some(INK_MIME)
            || file_type.as_deref() != Some("document")
            || !matches!(status.as_deref(), Some("active" | "deleted"))
            || compressed_hash.is_some()
            || manifest_hash != sha256
            || resource_hash != sha256
        {
            return Err(conflict(
                FORMAT_CONFLICT,
                "Ink file reference metadata is inconsistent",
            ));
        }
        let manifest_bytes =
            read_verified_blob(conn, blobs_dir, &manifest_hash, INK_MANIFEST_MAX_BYTES)?;
        let manifest = parse_manifest(&manifest_bytes).map_err(map_ink_error)?;
        if manifest.document_id != document_id
            || file_name != format!("{}.{INK_EXTENSION}", manifest.title)
            || page_count != manifest.pages.len() as i32
            || !preview_matches(&preview_json, &manifest, &manifest_hash)?
        {
            return Err(conflict(
                FORMAT_CONFLICT,
                "Ink manifest and file index are inconsistent",
            ));
        }

        let mut hashes = BTreeSet::from([manifest_hash]);
        hashes.extend(blob_refs(&manifest));
        for page_ref in &manifest.pages {
            let bytes = read_verified_blob(
                conn,
                blobs_dir,
                &page_ref.page_blob_hash,
                INK_PAGE_MAX_BYTES,
            )?;
            parse_page(&bytes, page_ref).map_err(map_ink_error)?;
        }
        for hash in &hashes {
            let blob =
                VfsBlobRepo::get_blob_with_conn(conn, hash)?.ok_or_else(|| VfsError::NotFound {
                    resource_type: "ink blob".to_owned(),
                    id: hash.clone(),
                })?;
            if blob.ref_count <= 0 || hash_blob_file(&blobs_dir.join(&blob.relative_path))? != *hash
            {
                return Err(conflict(
                    BLOB_CORRUPT,
                    "Ink reference blob content or refcount is invalid",
                ));
            }
        }
        for hash in hashes {
            VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, &hash)?;
        }
        Ok(true)
    }

    pub fn get_page_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        page_id: &str,
    ) -> VfsResult<InkPage> {
        let (manifest, _) = Self::load_manifest(conn, blobs_dir, document_id)?;
        let page_ref = manifest
            .pages
            .iter()
            .find(|page| page.page_id == page_id)
            .ok_or_else(|| VfsError::NotFound {
                resource_type: "ink page".to_owned(),
                id: page_id.to_owned(),
            })?;
        let bytes = read_verified_blob(
            conn,
            blobs_dir,
            &page_ref.page_blob_hash,
            INK_PAGE_MAX_BYTES,
        )?;
        parse_page(&bytes, page_ref).map_err(map_ink_error)
    }

    pub fn append_blank_page_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        width: f64,
        height: f64,
        ruling: InkRuling,
    ) -> VfsResult<InkManifest> {
        let guard = acquire_mutation_guard(conn)?;
        validate_operation_id(operation_id)?;
        let input_hash = hash_json(&AppendInput {
            document_id,
            expected_revision,
            width,
            height,
            ruling,
        })?;
        let (mut manifest, _) = Self::load_manifest(conn, blobs_dir, document_id)?;
        if let Some(receipt) = manifest.last_operation.as_ref() {
            if receipt.operation_id == operation_id {
                if receipt.input_hash == input_hash {
                    return Ok(manifest);
                }
                return Err(conflict(
                    OPERATION_REUSED,
                    "Append operation ID was reused with different input",
                ));
            }
        }
        if manifest.revision != expected_revision {
            return Err(conflict(
                OPERATION_UNKNOWN,
                "A stale revision cannot prove whether this append already committed",
            ));
        }
        if manifest.pages.len() >= INK_PAGES_MAX {
            return Err(invalid_ink_argument(
                "pages",
                "Ink document page limit reached",
            ));
        }

        let page = InkPage {
            schema_version: INK_SCHEMA_VERSION,
            page_id: format!("p_{}", nanoid::nanoid!(12)),
            objects: Vec::new(),
        };
        let page_bytes = serialize_page(&page)?;
        let page_hash = VfsBlobRepo::compute_hash(&page_bytes);
        manifest.pages.push(InkPageRef {
            page_id: page.page_id.clone(),
            width,
            height,
            background: InkBackground::Blank { ruling },
            page_blob_hash: page_hash,
        });
        let previous_revision = manifest.revision.clone();
        let revision = format!("r_{}", nanoid::nanoid!(16));
        manifest.revision = revision.clone();
        manifest.last_operation = Some(InkOperationReceipt {
            operation_id: operation_id.to_owned(),
            input_hash,
            previous_revision: Some(previous_revision),
            result_revision: revision,
        });
        Self::commit_document_with_guard(
            conn,
            blobs_dir,
            document_id,
            expected_revision,
            operation_id,
            manifest,
            &[page],
            &guard,
        )
    }

    pub fn rename_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        title: &str,
    ) -> VfsResult<InkManifest> {
        let guard = acquire_mutation_guard(conn)?;
        validate_operation_id(operation_id)?;
        if title.trim().is_empty() || title.chars().count() > crate::vfs::ink::INK_TITLE_MAX_CHARS {
            return Err(invalid_ink_argument("title", "Ink title is invalid"));
        }
        let input_hash = hash_json(&RenameInput {
            document_id,
            expected_revision,
            title,
        })?;
        let (mut manifest, _) = Self::load_manifest(conn, blobs_dir, document_id)?;
        if let Some(receipt) = manifest.last_operation.as_ref() {
            if receipt.operation_id == operation_id {
                if receipt.input_hash == input_hash {
                    return Ok(manifest);
                }
                return Err(conflict(
                    OPERATION_REUSED,
                    "Rename operation ID was reused with different input",
                ));
            }
        }
        if manifest.revision != expected_revision {
            return Err(conflict(
                OPERATION_UNKNOWN,
                "A stale revision cannot prove whether this rename already committed",
            ));
        }
        let previous_revision = manifest.revision.clone();
        let revision = format!("r_{}", nanoid::nanoid!(16));
        manifest.title = title.to_owned();
        manifest.revision = revision.clone();
        manifest.last_operation = Some(InkOperationReceipt {
            operation_id: operation_id.to_owned(),
            input_hash,
            previous_revision: Some(previous_revision),
            result_revision: revision,
        });
        Self::commit_document_with_guard(
            conn,
            blobs_dir,
            document_id,
            expected_revision,
            operation_id,
            manifest,
            &[],
            &guard,
        )
    }

    pub(crate) fn commit_document_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        manifest: InkManifest,
        changed_pages: &[InkPage],
    ) -> VfsResult<InkManifest> {
        let guard = acquire_mutation_guard(conn)?;
        Self::commit_document_with_guard(
            conn,
            blobs_dir,
            document_id,
            expected_revision,
            operation_id,
            manifest,
            changed_pages,
            &guard,
        )
    }

    pub(crate) fn commit_document_with_guard(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        mut manifest: InkManifest,
        changed_pages: &[InkPage],
        guard: &BlobMutationGuard,
    ) -> VfsResult<InkManifest> {
        let (current, file) = Self::load_manifest(conn, blobs_dir, document_id)?;
        let receipt = manifest.last_operation.as_ref().ok_or_else(|| {
            VfsError::Internal("Ink document update missing operation receipt".to_owned())
        })?;
        if receipt.operation_id != operation_id
            || receipt.previous_revision.as_deref() != Some(expected_revision)
            || receipt.result_revision != manifest.revision
        {
            return Err(VfsError::Internal(
                "Ink document update receipt is inconsistent".to_owned(),
            ));
        }
        if let Some(previous) = current.last_operation.as_ref() {
            if previous.operation_id == operation_id {
                if previous.input_hash == receipt.input_hash {
                    return Ok(current);
                }
                return Err(conflict(
                    OPERATION_REUSED,
                    "Operation ID was reused with different input",
                ));
            }
        }
        if current.revision != expected_revision {
            return Err(conflict(
                OPERATION_UNKNOWN,
                "A stale revision cannot prove whether this operation already committed",
            ));
        }
        if manifest.document_id != document_id {
            return Err(invalid_ink_argument(
                "document_id",
                "Ink document ID cannot be changed",
            ));
        }
        validate_manifest(&manifest).map_err(map_ink_error)?;

        let mut page_indexes = Vec::with_capacity(changed_pages.len());
        for page in changed_pages {
            let index = manifest
                .pages
                .iter()
                .position(|page_ref| page_ref.page_id == page.page_id)
                .ok_or_else(|| VfsError::NotFound {
                    resource_type: "ink page".to_owned(),
                    id: page.page_id.clone(),
                })?;
            validate_page(page, &manifest.pages[index]).map_err(map_ink_error)?;
            page_indexes.push(index);
        }

        with_savepoint(conn, "ink_commit_document", || {
            let mut temporary_refs = BTreeMap::<String, i32>::new();
            for (page, index) in changed_pages.iter().zip(page_indexes) {
                let bytes = serialize_page(page)?;
                let stored = VfsBlobRepo::store_blob_with_conn_guarded(
                    conn,
                    blobs_dir,
                    &bytes,
                    Some("application/json"),
                    Some("json"),
                    guard,
                )?;
                *temporary_refs.entry(stored.hash.clone()).or_default() += 1;
                manifest.pages[index].page_blob_hash = stored.hash;
            }
            validate_manifest(&manifest).map_err(map_ink_error)?;
            let manifest_bytes = serialize_manifest(&manifest)?;
            let stored_manifest = VfsBlobRepo::store_blob_with_conn_guarded(
                conn,
                blobs_dir,
                &manifest_bytes,
                Some(INK_MIME),
                Some(INK_EXTENSION),
                guard,
            )?;
            *temporary_refs
                .entry(stored_manifest.hash.clone())
                .or_default() += 1;
            let preview = preview_json(&manifest, &stored_manifest.hash)?;
            let mut deltas = reference_counts(&manifest, &stored_manifest.hash);
            for (hash, count) in reference_counts(&current, &file.manifest_hash) {
                *deltas.entry(hash).or_default() -= count;
            }
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
            let changed = conn.execute(
                r#"UPDATE files SET blob_hash = ?1, sha256 = ?1, file_name = ?2, size = ?3,
                          page_count = ?4, preview_json = ?5, updated_at = ?6
                   WHERE id = ?7 AND blob_hash = ?8 AND sha256 = ?8 AND resource_id = ?9
                     AND mime_type = ?10 AND "type" = 'document' AND status = 'active'"#,
                params![
                    stored_manifest.hash,
                    format!("{}.{INK_EXTENSION}", manifest.title),
                    manifest_bytes.len() as i64,
                    manifest.pages.len() as i32,
                    preview,
                    now,
                    document_id,
                    file.manifest_hash,
                    file.resource_id,
                    INK_MIME,
                ],
            )?;
            if changed != 1 {
                return Err(conflict(
                    REVISION_CONFLICT,
                    "Ink file changed while committing",
                ));
            }
            let changed = conn.execute(
                "UPDATE resources SET hash = ?1, updated_at = ?2 WHERE id = ?3 AND hash = ?4",
                params![
                    stored_manifest.hash,
                    chrono::Utc::now().timestamp_millis(),
                    file.resource_id,
                    file.resource_hash,
                ],
            )?;
            if changed != 1 {
                return Err(conflict(
                    REVISION_CONFLICT,
                    "Ink resource mirror changed while committing",
                ));
            }
            Ok(manifest.clone())
        })
    }

    pub fn save_page_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        page: &InkPage,
    ) -> VfsResult<InkManifest> {
        let guard = acquire_mutation_guard(conn)?;
        Self::save_page_with_guard(
            conn,
            blobs_dir,
            document_id,
            expected_revision,
            operation_id,
            page,
            &guard,
        )
    }

    fn save_page_with_guard(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
        expected_revision: &str,
        operation_id: &str,
        page: &InkPage,
        guard: &BlobMutationGuard,
    ) -> VfsResult<InkManifest> {
        validate_operation_id(operation_id)?;
        let input_hash = hash_json(&SaveInput {
            document_id,
            expected_revision,
            page,
        })?;
        let (mut manifest, file) = Self::load_manifest(conn, blobs_dir, document_id)?;
        let previous_manifest = manifest.clone();

        if let Some(receipt) = manifest.last_operation.as_ref() {
            if receipt.operation_id == operation_id {
                if receipt.input_hash == input_hash {
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
        let page_index = manifest
            .pages
            .iter()
            .position(|page_ref| page_ref.page_id == page.page_id)
            .ok_or_else(|| VfsError::NotFound {
                resource_type: "ink page".to_owned(),
                id: page.page_id.clone(),
            })?;
        validate_page(page, &manifest.pages[page_index]).map_err(map_ink_error)?;
        let page_bytes = serialize_page(page)?;
        let previous_revision = manifest.revision.clone();
        let revision = format!("r_{}", nanoid::nanoid!(16));
        manifest.revision = revision.clone();
        manifest.last_operation = Some(InkOperationReceipt {
            operation_id: operation_id.to_owned(),
            input_hash,
            previous_revision: Some(previous_revision),
            result_revision: revision,
        });

        with_savepoint(conn, "ink_save_page", || {
            let page_blob = VfsBlobRepo::store_blob_with_conn_guarded(
                conn,
                blobs_dir,
                &page_bytes,
                Some("application/json"),
                Some("json"),
                guard,
            )?;
            manifest.pages[page_index].page_blob_hash = page_blob.hash.clone();
            validate_manifest(&manifest).map_err(map_ink_error)?;
            let manifest_bytes = serialize_manifest(&manifest)?;
            let manifest_blob = VfsBlobRepo::store_blob_with_conn_guarded(
                conn,
                blobs_dir,
                &manifest_bytes,
                Some(INK_MIME),
                Some(INK_EXTENSION),
                guard,
            )?;
            let preview_json = preview_json(&manifest, &manifest_blob.hash)?;

            adjust_blob_references(
                conn,
                blobs_dir,
                &previous_manifest,
                &file.manifest_hash,
                &manifest,
                &page_blob.hash,
                &manifest_blob.hash,
            )?;

            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let changed = conn.execute(
                r#"UPDATE files SET blob_hash = ?1, sha256 = ?1, size = ?2, page_count = ?3, preview_json = ?4, updated_at = ?5
                   WHERE id = ?6 AND blob_hash = ?7 AND sha256 = ?7 AND resource_id = ?8 AND mime_type = ?9 AND "type" = 'document' AND status = 'active'"#,
                params![
                    manifest_blob.hash,
                    manifest_bytes.len() as i64,
                    manifest.pages.len() as i32,
                    preview_json,
                    now,
                    document_id,
                    file.manifest_hash,
                    file.resource_id,
                    INK_MIME,
                ],
            )?;
            if changed != 1 {
                return Err(conflict(
                    REVISION_CONFLICT,
                    "Ink file changed while saving the page",
                ));
            }
            let changed = conn.execute(
                "UPDATE resources SET hash = ?1, updated_at = ?2 WHERE id = ?3 AND hash = ?4",
                params![
                    manifest_blob.hash,
                    chrono::Utc::now().timestamp_millis(),
                    file.resource_id,
                    file.resource_hash
                ],
            )?;
            if changed != 1 {
                return Err(conflict(
                    REVISION_CONFLICT,
                    "Ink resource mirror changed while saving the page",
                ));
            }
            Ok(manifest.clone())
        })
    }

    fn load_manifest(
        conn: &Connection,
        blobs_dir: &Path,
        document_id: &str,
    ) -> VfsResult<(InkManifest, InkFileState)> {
        let row = conn
            .query_row(
                r#"SELECT f.resource_id, f.blob_hash, f.sha256, f.file_name, f.page_count, f.mime_type, f.preview_json, f."type", f.status, r.hash
                   FROM files f LEFT JOIN resources r ON r.id = f.resource_id WHERE f.id = ?1"#,
                [document_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<i32>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| VfsError::NotFound {
                resource_type: "ink document".to_owned(),
                id: document_id.to_owned(),
            })?;
        let (
            resource_id,
            manifest_hash,
            sha256,
            file_name,
            page_count,
            mime_type,
            preview_json,
            file_type,
            status,
            resource_hash,
        ) = row;
        let (
            resource_id,
            manifest_hash,
            sha256,
            file_name,
            page_count,
            preview_json,
            resource_hash,
        ) = match (
            resource_id,
            manifest_hash,
            sha256,
            file_name,
            page_count,
            preview_json,
            resource_hash,
        ) {
            (Some(r), Some(b), Some(s), Some(n), Some(c), Some(p), Some(rh)) => {
                (r, b, s, n, c, p, rh)
            }
            _ => return Err(conflict(FORMAT_CONFLICT, "Ink file metadata is incomplete")),
        };
        if mime_type.as_deref() != Some(INK_MIME)
            || file_type.as_deref() != Some("document")
            || status.as_deref() != Some("active")
            || manifest_hash != sha256
            || resource_hash != sha256
        {
            return Err(conflict(
                FORMAT_CONFLICT,
                "File is not a canonical active Ink document",
            ));
        }
        let bytes = read_verified_blob(conn, blobs_dir, &manifest_hash, INK_MANIFEST_MAX_BYTES)?;
        let manifest = parse_manifest(&bytes).map_err(map_ink_error)?;
        if manifest.document_id != document_id
            || file_name != format!("{}.{INK_EXTENSION}", manifest.title)
            || page_count != manifest.pages.len() as i32
            || !preview_matches(&preview_json, &manifest, &manifest_hash)?
        {
            return Err(conflict(
                FORMAT_CONFLICT,
                "Ink manifest does not match its canonical file index",
            ));
        }
        Ok((
            manifest,
            InkFileState {
                resource_id,
                manifest_hash,
                resource_hash,
            },
        ))
    }
}

fn acquire_mutation_guard(conn: &Connection) -> VfsResult<BlobMutationGuard> {
    if !conn.is_autocommit() {
        return Err(VfsError::InvalidState {
            message: "Ink mutation requires a blob guard before opening a SQLite write transaction"
                .to_owned(),
        });
    }
    acquire_blob_mutation_guard()
}

fn validate_operation_id(operation_id: &str) -> VfsResult<()> {
    let length = operation_id.chars().count();
    if length == 0
        || length > 128
        || operation_id.trim().is_empty()
        || operation_id
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
    {
        return Err(invalid_ink_argument(
            "operation_id",
            "Ink operation ID must be a valid nonempty identifier of at most 128 characters",
        ));
    }
    Ok(())
}

fn file_id_exists(conn: &Connection, document_id: &str) -> VfsResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)",
        [document_id],
        |row| row.get(0),
    )?)
}

fn serialize_page(page: &InkPage) -> VfsResult<Vec<u8>> {
    let bytes =
        serde_json::to_vec(page).map_err(|error| VfsError::Serialization(error.to_string()))?;
    if bytes.len() > INK_PAGE_MAX_BYTES {
        return Err(invalid_ink_argument(
            "page",
            "Ink page exceeds the byte limit",
        ));
    }
    Ok(bytes)
}

fn serialize_manifest(manifest: &InkManifest) -> VfsResult<Vec<u8>> {
    let bytes =
        serde_json::to_vec(manifest).map_err(|error| VfsError::Serialization(error.to_string()))?;
    if bytes.len() > INK_MANIFEST_MAX_BYTES {
        return Err(invalid_ink_argument(
            "manifest",
            "Ink manifest exceeds the byte limit",
        ));
    }
    Ok(bytes)
}

fn hash_json<T: Serialize>(value: &T) -> VfsResult<String> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| VfsError::Serialization(error.to_string()))?;
    Ok(VfsBlobRepo::compute_hash(&bytes))
}

fn preview_json(manifest: &InkManifest, manifest_hash: &str) -> VfsResult<String> {
    serde_json::to_string(&json!({
        "ink": {
            "schema_version": INK_SCHEMA_VERSION,
            "document_id": manifest.document_id,
            "revision": manifest.revision,
            "manifest_blob_hash": manifest_hash,
            "blob_refs": blob_refs(manifest),
        }
    }))
    .map_err(|error| VfsError::Serialization(error.to_string()))
}

fn preview_matches(
    serialized: &str,
    manifest: &InkManifest,
    manifest_hash: &str,
) -> VfsResult<bool> {
    let actual: Value = serde_json::from_str(serialized)
        .map_err(|error| VfsError::Serialization(error.to_string()))?;
    let expected = json!({
        "ink": {
            "schema_version": INK_SCHEMA_VERSION,
            "document_id": manifest.document_id,
            "revision": manifest.revision,
            "manifest_blob_hash": manifest_hash,
            "blob_refs": blob_refs(manifest),
        }
    });
    Ok(actual == expected)
}

fn blob_refs(manifest: &InkManifest) -> Vec<String> {
    let mut hashes = manifest
        .pages
        .iter()
        .flat_map(|page| {
            let mut hashes = vec![page.page_blob_hash.clone()];
            match &page.background {
                InkBackground::Blank { .. } => {}
                InkBackground::Image { blob_hash } | InkBackground::PdfPage { blob_hash, .. } => {
                    hashes.push(blob_hash.clone())
                }
            }
            hashes
        })
        .collect::<Vec<_>>();
    hashes.sort();
    hashes.dedup();
    hashes
}

fn reference_counts(manifest: &InkManifest, manifest_hash: &str) -> BTreeMap<String, i32> {
    let mut counts = BTreeMap::new();
    *counts.entry(manifest_hash.to_owned()).or_default() += 1;
    for hash in blob_refs(manifest) {
        *counts.entry(hash).or_default() += 1;
    }
    counts
}

fn adjust_blob_references(
    conn: &Connection,
    blobs_dir: &Path,
    old_manifest: &InkManifest,
    old_manifest_hash: &str,
    new_manifest: &InkManifest,
    stored_page_hash: &str,
    stored_manifest_hash: &str,
) -> VfsResult<()> {
    let mut deltas = reference_counts(new_manifest, stored_manifest_hash);
    for (hash, count) in reference_counts(old_manifest, old_manifest_hash) {
        *deltas.entry(hash).or_default() -= count;
    }
    // store_blob adds one temporary reference for each newly serialized blob.
    *deltas.entry(stored_page_hash.to_owned()).or_default() -= 1;
    *deltas.entry(stored_manifest_hash.to_owned()).or_default() -= 1;

    for (hash, delta) in deltas {
        for _ in 0..delta.max(0) {
            VfsBlobRepo::increment_ref_with_conn(conn, &hash)?;
        }
        for _ in 0..(-delta).max(0) {
            VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, &hash)?;
        }
    }
    Ok(())
}

fn hash_blob_file(path: &Path) -> VfsResult<String> {
    let mut file = File::open(path).map_err(|error| VfsError::Io(error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| VfsError::Io(error.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn read_verified_blob(
    conn: &Connection,
    blobs_dir: &Path,
    hash: &str,
    max_bytes: usize,
) -> VfsResult<Vec<u8>> {
    let path = VfsBlobRepo::get_blob_path_with_conn(conn, blobs_dir, hash)?.ok_or_else(|| {
        VfsError::NotFound {
            resource_type: "ink blob".to_owned(),
            id: hash.to_owned(),
        }
    })?;
    let metadata = std::fs::metadata(&path).map_err(|error| VfsError::Io(error.to_string()))?;
    if metadata.len() > max_bytes as u64 {
        return Err(invalid_ink_argument(
            "blob",
            "Ink blob exceeds the byte limit",
        ));
    }
    let file = File::open(path).map_err(|error| VfsError::Io(error.to_string()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| VfsError::Io(error.to_string()))?;
    if bytes.len() > max_bytes {
        return Err(invalid_ink_argument(
            "blob",
            "Ink blob exceeds the byte limit",
        ));
    }
    if VfsBlobRepo::compute_hash(&bytes) != hash {
        return Err(conflict(
            BLOB_CORRUPT,
            "Ink blob hash does not match its contents",
        ));
    }
    Ok(bytes)
}

fn map_ink_error(error: crate::vfs::ink::InkError) -> VfsError {
    match error.code {
        crate::vfs::ink::InkErrorCode::InvalidArgument => {
            invalid_ink_argument("ink", &error.message)
        }
        crate::vfs::ink::InkErrorCode::LimitExceeded => {
            conflict("ink.limit_exceeded", &error.message)
        }
        crate::vfs::ink::InkErrorCode::UnsupportedSchema => {
            conflict("ink.unsupported_schema", &error.message)
        }
    }
}

fn invalid_ink_argument(param: &str, reason: &str) -> VfsError {
    VfsError::InvalidArgument {
        param: param.to_owned(),
        reason: reason.to_owned(),
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
    use rusqlite::{params, Connection};
    use tempfile::TempDir;

    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        ink::{
            InkAuthor, InkBackground, InkObject, InkObjectContent, InkPage, InkRuling, InkSample,
            InkStrokeStyle, InkTool, INK_MIME,
        },
        repos::{blob_repo::VfsBlobRepo, file_repo::VfsFileRepo},
    };

    use super::VfsInkRepo;

    fn setup() -> (TempDir, VfsDatabase) {
        setup_migrated_test_db()
    }

    fn create_blank(
        conn: &Connection,
        db: &VfsDatabase,
        operation_id: &str,
    ) -> crate::vfs::error::VfsResult<crate::vfs::ink::InkManifest> {
        VfsInkRepo::create_blank_with_conn(
            conn,
            db.blobs_dir(),
            "Ink test",
            InkRuling::Blank,
            100.0,
            100.0,
            operation_id,
            None,
        )
    }

    #[test]
    fn blank_documents_use_distinct_manifest_blobs_and_reopen() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let first = create_blank(&conn, &db, "create-op-a").unwrap();
        let second = create_blank(&conn, &db, "create-op-b").unwrap();

        assert_ne!(first.document_id, second.document_id);
        let file_identity = |document_id: &str| {
            conn.query_row(
                "SELECT resource_id, blob_hash, sha256 FROM files WHERE id = ?1",
                [document_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap()
        };
        let first_file = file_identity(&first.document_id);
        let second_file = file_identity(&second.document_id);
        assert_ne!(first_file.0, second_file.0);
        assert_ne!(first_file.1, second_file.1);
        assert_ne!(first_file.2, second_file.2);

        for manifest in [&first, &second] {
            assert_eq!(manifest.pages.len(), 1);
            assert_eq!(
                VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &manifest.document_id)
                    .unwrap(),
                *manifest
            );
            let path = VfsBlobRepo::get_blob_path_with_conn(
                &conn,
                db.blobs_dir(),
                &manifest.pages[0].page_blob_hash,
            )
            .unwrap()
            .unwrap();
            assert!(path.is_file());

            let file_path = VfsBlobRepo::get_blob_path_with_conn(
                &conn,
                db.blobs_dir(),
                &file_identity(&manifest.document_id).1,
            )
            .unwrap()
            .unwrap();
            let bytes = std::fs::read(file_path).unwrap();
            assert!(std::str::from_utf8(&bytes)
                .unwrap()
                .contains(&manifest.document_id));
        }
    }

    #[test]
    fn repeating_blank_create_operation_keeps_revision_and_references() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let first = create_blank(&conn, &db, "create-op-retry").unwrap();
        let before = database_counts(&conn);

        let retry = create_blank(&conn, &db, "create-op-retry").unwrap();

        assert_eq!(retry.document_id, first.document_id);
        assert_eq!(retry.revision, first.revision);
        assert_eq!(database_counts(&conn), before);
    }

    #[test]
    fn saving_page_reopens_stroke_and_mirrors_manifest_hash() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let original = create_blank(&conn, &db, "create-op-save").unwrap();
        let page_id = original.pages[0].page_id.clone();
        let page = InkPage {
            schema_version: 1,
            page_id: page_id.clone(),
            objects: vec![InkObject {
                id: "stroke-a".to_owned(),
                author: InkAuthor::User,
                created_at: 0,
                content: InkObjectContent::Stroke {
                    samples: vec![InkSample {
                        x: 12.5,
                        y: 23.75,
                        pressure: 0.4,
                        elapsed_ms: Some(0.0),
                    }],
                    style: InkStrokeStyle {
                        tool: InkTool::Pen,
                        color: "#000000".to_owned(),
                        width: 2.0,
                        pressure_enabled: true,
                    },
                },
            }],
        };

        let old_page_hash = original.pages[0].page_blob_hash.clone();
        let old_page_refs: i64 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&old_page_hash],
                |row| row.get(0),
            )
            .unwrap();
        let updated = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &original.document_id,
            &original.revision,
            "save-op-a",
            &page,
        )
        .unwrap();
        assert_ne!(updated.revision, original.revision);
        let new_page_hash = updated.pages[0].page_blob_hash.clone();
        let old_page_refs_after: i64 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&old_page_hash],
                |row| row.get(0),
            )
            .unwrap();
        let new_page_refs: i64 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&new_page_hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_page_refs_after, old_page_refs - 1);
        assert_eq!(new_page_refs, 1);
        let reopened =
            VfsInkRepo::get_page_with_conn(&conn, db.blobs_dir(), &updated.document_id, &page_id)
                .unwrap();
        assert_eq!(reopened, page);

        let preview_json: Option<String> = conn
            .query_row(
                "SELECT preview_json FROM files WHERE id = ?1",
                [&updated.document_id],
                |row| row.get(0),
            )
            .unwrap();
        let preview: serde_json::Value = serde_json::from_str(&preview_json.unwrap()).unwrap();
        let manifest_hash = preview["ink"]["manifest_blob_hash"].as_str().unwrap();
        let (blob_hash, sha256, resource_hash): (String, String, String) = conn
            .query_row(
                "SELECT f.blob_hash, f.sha256, r.hash FROM files f JOIN resources r ON r.id = f.resource_id WHERE f.id = ?1",
                params![updated.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(blob_hash, manifest_hash);
        assert_eq!(sha256, manifest_hash);
        assert_eq!(resource_hash, manifest_hash);

        let path = VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), manifest_hash)
            .unwrap()
            .unwrap();
        let manifest_bytes = std::fs::read(path).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&manifest_bytes).unwrap()["revision"],
            updated.revision
        );
    }

    fn stroke_page(page_id: &str, x: f64) -> InkPage {
        InkPage {
            schema_version: 1,
            page_id: page_id.to_owned(),
            objects: vec![InkObject {
                id: "stroke-a".to_owned(),
                author: InkAuthor::User,
                created_at: 0,
                content: InkObjectContent::Stroke {
                    samples: vec![InkSample {
                        x,
                        y: 20.0,
                        pressure: 0.4,
                        elapsed_ms: Some(0.0),
                    }],
                    style: InkStrokeStyle {
                        tool: InkTool::Pen,
                        color: "#000000".to_owned(),
                        width: 2.0,
                        pressure_enabled: true,
                    },
                },
            }],
        }
    }

    fn file_state(
        conn: &Connection,
        document_id: &str,
    ) -> (String, String, Option<String>, String) {
        conn.query_row(
            "SELECT f.blob_hash, f.sha256, f.preview_json, r.hash FROM files f JOIN resources r ON r.id = f.resource_id WHERE f.id = ?1",
            [document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
    }

    fn add_image_background(
        conn: &Connection,
        db: &VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
    ) -> (crate::vfs::ink::InkManifest, String) {
        let image = VfsBlobRepo::store_blob_with_conn(
            conn,
            db.blobs_dir(),
            b"test background image",
            Some("image/png"),
            Some("png"),
        )
        .unwrap();
        let old_manifest_hash: String = conn
            .query_row(
                "SELECT blob_hash FROM files WHERE id = ?1",
                [&manifest.document_id],
                |row| row.get(0),
            )
            .unwrap();
        let mut updated = manifest.clone();
        updated.pages[0].background = InkBackground::Image {
            blob_hash: image.hash.clone(),
        };
        let bytes = serde_json::to_vec(&updated).unwrap();
        let stored = VfsBlobRepo::store_blob_with_conn(
            conn,
            db.blobs_dir(),
            &bytes,
            Some(INK_MIME),
            Some("dsink"),
        )
        .unwrap();
        let preview = super::preview_json(&updated, &stored.hash).unwrap();
        conn.execute(
            "UPDATE files SET blob_hash = ?1, sha256 = ?1, size = ?2, preview_json = ?3 WHERE id = ?4",
            params![stored.hash, bytes.len() as i64, preview, manifest.document_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE resources SET hash = ?1 WHERE source_id = ?2",
            params![stored.hash, manifest.document_id],
        )
        .unwrap();
        VfsBlobRepo::decrement_ref_with_conn(conn, db.blobs_dir(), &old_manifest_hash).unwrap();
        (updated, image.hash)
    }

    #[test]
    fn save_retry_order_stale_revision_and_reused_ids_are_characterized() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_blank(&conn, &db, "create-replay").unwrap();
        let page_id = &created.pages[0].page_id;
        let page_a = stroke_page(page_id, 12.5);
        let saved_a = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "save-a",
            &page_a,
        )
        .unwrap();
        let after_a = database_counts(&conn);
        assert_eq!(
            VfsInkRepo::save_page_with_conn(
                &conn,
                db.blobs_dir(),
                &created.document_id,
                &created.revision,
                "save-a",
                &page_a
            )
            .unwrap(),
            saved_a
        );
        assert_eq!(database_counts(&conn), after_a);
        assert!(VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "save-a",
            &stroke_page(page_id, 13.0)
        )
        .is_err());
        assert!(VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "stale",
            &stroke_page(page_id, 14.0)
        )
        .is_err());
        assert_eq!(database_counts(&conn), after_a);
        let saved_b = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &saved_a.revision,
            "save-b",
            &stroke_page(page_id, 15.0),
        )
        .unwrap();
        let after_b = database_counts(&conn);
        assert!(VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "save-a",
            &page_a
        )
        .is_err());
        assert_eq!(database_counts(&conn), after_b);
        assert_ne!(saved_a.revision, saved_b.revision);
    }

    #[test]
    fn create_retry_with_different_input_is_rejected_without_storage_changes() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let first = create_blank(&conn, &db, "create-reused").unwrap();
        let before = database_counts(&conn);
        assert!(VfsInkRepo::create_blank_with_conn(
            &conn,
            db.blobs_dir(),
            "Different title",
            InkRuling::Blank,
            100.0,
            100.0,
            "create-reused",
            None,
        )
        .is_err());
        assert_eq!(
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &first.document_id).unwrap(),
            first
        );
        assert_eq!(database_counts(&conn), before);
    }

    #[test]
    fn resource_update_abort_rolls_back_file_pointer_and_blob_refs() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_blank(&conn, &db, "create-trigger").unwrap();
        let before_counts = database_counts(&conn);
        let before_file = file_state(&conn, &created.document_id);
        conn.execute_batch(&format!(
            "CREATE TRIGGER fail_ink_resource BEFORE UPDATE OF hash ON resources WHEN OLD.source_id = '{}' BEGIN SELECT RAISE(ABORT, 'injected'); END",
            created.document_id,
        )).unwrap();
        assert!(VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "save-trigger",
            &stroke_page(&created.pages[0].page_id, 12.5),
        )
        .is_err());
        assert_eq!(database_counts(&conn), before_counts);
        assert_eq!(file_state(&conn, &created.document_id), before_file);
        assert_eq!(
            VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &created.document_id,
                &created.pages[0].page_id
            )
            .unwrap()
            .objects
            .len(),
            0
        );
    }

    #[test]
    fn corrupt_missing_blob_and_ordinary_file_are_rejected() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_blank(&conn, &db, "create-bad-blob").unwrap();
        let page_hash = &created.pages[0].page_blob_hash;
        let path = VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), page_hash)
            .unwrap()
            .unwrap();
        std::fs::write(&path, b"not the content for this hash").unwrap();
        assert!(VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.pages[0].page_id
        )
        .is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.pages[0].page_id
        )
        .is_err());
        let ordinary_hash = VfsBlobRepo::compute_hash(b"ordinary file");
        let ordinary = VfsFileRepo::create_file_with_conn(
            &conn,
            &ordinary_hash,
            "ordinary.txt",
            13,
            "document",
            Some("text/plain"),
            None,
            None,
        )
        .unwrap();
        assert!(VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &ordinary.id).is_err());
    }

    #[test]
    fn purging_corrupt_ink_dependency_keeps_file_and_reference_counts() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_blank(&conn, &db, "create-corrupt-purge").unwrap();
        let before_file = file_state(&conn, &created.document_id);
        let before_counts = database_counts(&conn);
        let page_path = VfsBlobRepo::get_blob_path_with_conn(
            &conn,
            db.blobs_dir(),
            &created.pages[0].page_blob_hash,
        )
        .unwrap()
        .unwrap();
        std::fs::write(page_path, b"corrupt ink page").unwrap();

        assert!(
            VfsFileRepo::purge_file_with_conn(&conn, db.blobs_dir(), &created.document_id).is_err()
        );
        assert_eq!(file_state(&conn, &created.document_id), before_file);
        assert_eq!(database_counts(&conn), before_counts);
    }

    #[test]
    fn purging_ink_source_preserves_shared_copy_page_and_background_blobs() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_blank(&conn, &db, "create-copy-purge-source").unwrap();
        let with_background = add_image_background(&conn, &db, &created);
        let source = with_background.0;
        let background_hash = with_background.1;
        let copy = VfsInkRepo::copy_with_conn(
            &conn,
            db.blobs_dir(),
            &source.document_id,
            "Lifecycle copy",
            "copy-purge-op",
            None,
        )
        .unwrap();
        let copied_page_hash = copy.pages[0].page_blob_hash.clone();
        let copied_manifest_hash: String = conn
            .query_row(
                "SELECT blob_hash FROM files WHERE id = ?1",
                [&copy.document_id],
                |row| row.get(0),
            )
            .unwrap();

        VfsFileRepo::purge_file_with_conn(&conn, db.blobs_dir(), &source.document_id).unwrap();

        assert!(VfsFileRepo::get_file_with_conn(&conn, &source.document_id)
            .unwrap()
            .is_none());
        assert!(VfsFileRepo::get_file_with_conn(&conn, &copy.document_id)
            .unwrap()
            .is_some());
        assert_eq!(
            VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &copy.document_id,
                &copy.pages[0].page_id,
            )
            .unwrap(),
            InkPage {
                schema_version: 1,
                page_id: copy.pages[0].page_id.clone(),
                objects: Vec::new(),
            }
        );
        for hash in [&background_hash, &copied_page_hash, &copied_manifest_hash] {
            let refs: i32 = conn
                .query_row(
                    "SELECT ref_count FROM blobs WHERE hash = ?1",
                    [hash],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(refs, 1);
        }
    }

    #[test]
    fn copy_scaffold_preserves_background_and_allows_independent_edits() {
        let (_temp_dir, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let created = create_blank(&conn, &db, "create-copy-source").unwrap();
        let source_page = stroke_page(&created.pages[0].page_id, 31.5);
        let source = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "source-save-copy",
            &source_page,
        )
        .unwrap();
        let (source, image_hash) = add_image_background(&conn, &db, &source);
        let before_refs: i64 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&image_hash],
                |row| row.get(0),
            )
            .unwrap();
        let copy = VfsInkRepo::copy_with_conn(
            &conn,
            db.blobs_dir(),
            &source.document_id,
            "Copy",
            "copy-op",
            None,
        )
        .unwrap();
        assert_ne!(copy.document_id, source.document_id);
        assert!(copy.document_id.starts_with("file_"));
        assert!(source.document_id.starts_with("file_"));
        assert_ne!(copy.pages[0].page_id, source.pages[0].page_id);
        assert_eq!(copy.title, "Copy");
        assert_eq!(copy.pages[0].background, source.pages[0].background);
        let copied_page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &copy.document_id,
            &copy.pages[0].page_id,
        )
        .unwrap();
        assert_ne!(copied_page.objects[0].id, source_page.objects[0].id);
        assert_eq!(copied_page.objects[0].author, source_page.objects[0].author);
        assert_eq!(
            copied_page.objects[0].content,
            source_page.objects[0].content
        );
        let after_refs: i64 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&image_hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_refs, before_refs + 1);
        assert_eq!(
            VfsInkRepo::copy_with_conn(
                &conn,
                db.blobs_dir(),
                &source.document_id,
                "Copy",
                "copy-op",
                None,
            )
            .unwrap(),
            copy,
        );
        let edited = stroke_page(&copy.pages[0].page_id, 12.5);
        let edited_copy = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &copy.document_id,
            &copy.revision,
            "copy-edit",
            &edited,
        )
        .unwrap();
        assert_eq!(
            VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &source.document_id,
                &source.pages[0].page_id,
            )
            .unwrap(),
            source_page,
        );
        assert_eq!(
            VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &edited_copy.document_id,
                &edited_copy.pages[0].page_id
            )
            .unwrap(),
            edited
        );
    }

    fn database_counts(conn: &Connection) -> (i64, i64, i64) {
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM resources), (SELECT COALESCE(SUM(ref_count), 0) FROM blobs)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }
}
