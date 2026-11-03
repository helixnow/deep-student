//! Shared request and service boundary for Ink VFS commands.

use std::{path::Path, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::{
    database::VfsDatabase,
    error::VfsError,
    ink::{InkManifest, InkPage, InkRuling},
    repos::VfsInkRepo,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkCreateRequest {
    pub title: String,
    pub ruling: InkRuling,
    pub width: f64,
    pub height: f64,
    pub operation_id: String,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkGetRequest {
    pub document_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkGetPageRequest {
    pub document_id: String,
    pub page_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkSavePageRequest {
    pub document_id: String,
    pub expected_revision: String,
    pub operation_id: String,
    pub page: InkPage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkCopyRequest {
    pub document_id: String,
    pub title: String,
    pub operation_id: String,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkAppendPageRequest {
    pub document_id: String,
    pub expected_revision: String,
    pub operation_id: String,
    pub width: f64,
    pub height: f64,
    pub ruling: InkRuling,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkRenameRequest {
    pub document_id: String,
    pub expected_revision: String,
    pub operation_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkCommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
}

impl InkCommandError {
    fn new(code: &str, message: &str, retryable: bool) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
            hint: None,
            retryable,
            current_revision: None,
        }
    }
}

impl From<VfsError> for InkCommandError {
    fn from(error: VfsError) -> Self {
        match error {
            VfsError::Conflict { key, .. } => match key.as_str() {
                "ink.operation_state_unknown" => Self::new(
                    "OPERATION_STATE_UNKNOWN",
                    "The Ink operation result cannot be verified; reload the document before retrying.",
                    false,
                ),
                "ink.operation_id_reused" => {
                    Self::new("INVALID_ARGUMENT", "Ink operation ID was reused with different input.", false)
                }
                "ink.limit_exceeded" => Self::new("LIMIT_EXCEEDED", "Ink limits were exceeded.", false),
                "ink.unsupported_schema" => Self::new("UNSUPPORTED_SCHEMA", "This Ink schema version is not supported.", false),
                "ink.source_changed" => Self::new("SOURCE_CHANGED", "The source file changed while preparing Ink.", false),
                "ink.artifact.provenance_mismatch" => Self::new(
                    "REVISION_CONFLICT",
                    "The Ink artifact does not match the document revision.",
                    false,
                ),
                "ink.revision_conflict" => Self::new(
                    "REVISION_CONFLICT",
                    "The Ink document changed while saving; reload and try again.",
                    true,
                ),
                "ink.format_conflict" => {
                    Self::new("UNSUPPORTED_FORMAT", "This VFS file is not a supported Ink document.", false)
                }
                "ink.blob_corrupt" => Self::new(
                    "RESOURCE_NOT_FOUND",
                    "Ink document data is missing or corrupted.",
                    false,
                ),
                _ => Self::new("INTERNAL", "Ink storage operation failed.", true),
            },
            VfsError::NotFound { .. }
            | VfsError::ItemNotFound { .. }
            | VfsError::FolderNotFound { .. } => {
                Self::new("RESOURCE_NOT_FOUND", "Ink document or page was not found.", false)
            }
            VfsError::InvalidArgument { .. }
            | VfsError::PathParse { .. }
            | VfsError::InvalidParent { .. }
            | VfsError::InvalidOperation { .. }
            | VfsError::InvalidState { .. } => {
                Self::new("INVALID_ARGUMENT", "Ink request is invalid.", false)
            }
            VfsError::FolderDepthExceeded { .. } | VfsError::FolderCountExceeded { .. } => {
                Self::new("LIMIT_EXCEEDED", "An Ink folder limit was exceeded.", false)
            }
            VfsError::Database(_)
            | VfsError::Pool(_)
            | VfsError::Io(_)
            | VfsError::Serialization(_)
            | VfsError::Migration(_)
            | VfsError::RefCount { .. }
            | VfsError::HashCollision { .. }
            | VfsError::AlreadyExists { .. }
            | VfsError::FolderAlreadyExists { .. }
            | VfsError::Maintenance { .. }
            | VfsError::Internal(_)
            | VfsError::Other(_) => Self::new("INTERNAL", "Ink storage operation failed.", true),
        }
    }
}

fn with_conn<T>(
    db: &VfsDatabase,
    operation: impl FnOnce(&rusqlite::Connection, &Path) -> Result<T, VfsError>,
) -> Result<T, InkCommandError> {
    let conn = db.get_conn_safe().map_err(InkCommandError::from)?;
    operation(&conn, db.blobs_dir()).map_err(InkCommandError::from)
}

pub fn create(db: &VfsDatabase, request: InkCreateRequest) -> Result<InkManifest, InkCommandError> {
    with_conn(db, |conn, blobs_dir| {
        VfsInkRepo::create_blank_with_conn(
            conn,
            blobs_dir,
            &request.title,
            request.ruling,
            request.width,
            request.height,
            &request.operation_id,
            request.folder_id.as_deref(),
        )
    })
}

pub fn get(db: &VfsDatabase, request: InkGetRequest) -> Result<InkManifest, InkCommandError> {
    with_conn(db, |conn, blobs_dir| {
        VfsInkRepo::get_manifest_with_conn(conn, blobs_dir, &request.document_id)
    })
}

pub fn get_page(db: &VfsDatabase, request: InkGetPageRequest) -> Result<InkPage, InkCommandError> {
    with_conn(db, |conn, blobs_dir| {
        VfsInkRepo::get_page_with_conn(conn, blobs_dir, &request.document_id, &request.page_id)
    })
}

pub fn save_page(
    db: &VfsDatabase,
    request: InkSavePageRequest,
) -> Result<InkManifest, InkCommandError> {
    with_conn(db, |conn, blobs_dir| {
        VfsInkRepo::save_page_with_conn(
            conn,
            blobs_dir,
            &request.document_id,
            &request.expected_revision,
            &request.operation_id,
            &request.page,
        )
    })
}

pub fn copy(db: &VfsDatabase, request: InkCopyRequest) -> Result<InkManifest, InkCommandError> {
    with_conn(db, |conn, blobs_dir| {
        VfsInkRepo::copy_with_conn(
            conn,
            blobs_dir,
            &request.document_id,
            &request.title,
            &request.operation_id,
            request.folder_id.as_deref(),
        )
    })
}

pub fn append_page(
    db: &VfsDatabase,
    request: InkAppendPageRequest,
) -> Result<InkManifest, InkCommandError> {
    with_conn(db, |conn, blobs_dir| {
        VfsInkRepo::append_blank_page_with_conn(
            conn,
            blobs_dir,
            &request.document_id,
            &request.expected_revision,
            &request.operation_id,
            request.width,
            request.height,
            request.ruling,
        )
    })
}

pub fn rename(db: &VfsDatabase, request: InkRenameRequest) -> Result<InkManifest, InkCommandError> {
    with_conn(db, |conn, blobs_dir| {
        VfsInkRepo::rename_with_conn(
            conn,
            blobs_dir,
            &request.document_id,
            &request.expected_revision,
            &request.operation_id,
            &request.title,
        )
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InkChangedEvent {
    pub document_id: String,
    pub revision: String,
    pub operation_id: String,
    pub affected_page_ids: Vec<String>,
}

fn changed_event(
    manifest: &InkManifest,
    operation_id: String,
    affected_page_ids: Vec<String>,
) -> InkChangedEvent {
    InkChangedEvent {
        document_id: manifest.document_id.clone(),
        revision: manifest.revision.clone(),
        operation_id,
        affected_page_ids,
    }
}

async fn run_blocking<T>(
    db: Arc<VfsDatabase>,
    operation: impl FnOnce(&VfsDatabase) -> Result<T, InkCommandError> + Send + 'static,
) -> Result<T, InkCommandError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || operation(&db))
        .await
        .map_err(|_| InkCommandError::new("INTERNAL", "Ink storage operation failed.", true))?
}

fn emit_changed(app: &AppHandle, event: InkChangedEvent) {
    if let Err(error) = app.emit("ink:changed", &event) {
        tracing::warn!("Failed to emit ink:changed event: {error}");
    }
}

#[tauri::command]
pub async fn vfs_ink_create(
    request: InkCreateRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    app: AppHandle,
) -> Result<InkManifest, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    let operation_id = request.operation_id.clone();
    let manifest = run_blocking(db, move |db| create(db, request)).await?;
    emit_changed(
        &app,
        changed_event(
            &manifest,
            operation_id,
            manifest
                .pages
                .iter()
                .map(|page| page.page_id.clone())
                .collect(),
        ),
    );
    Ok(manifest)
}

#[tauri::command]
pub async fn vfs_ink_get(
    request: InkGetRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<InkManifest, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    run_blocking(db, move |db| get(db, request)).await
}

#[tauri::command]
pub async fn vfs_ink_get_page(
    request: InkGetPageRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<InkPage, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    run_blocking(db, move |db| get_page(db, request)).await
}

#[tauri::command]
pub async fn vfs_ink_save_page(
    request: InkSavePageRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    app: AppHandle,
) -> Result<InkManifest, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    let operation_id = request.operation_id.clone();
    let page_id = request.page.page_id.clone();
    let manifest = run_blocking(db, move |db| save_page(db, request)).await?;
    emit_changed(&app, changed_event(&manifest, operation_id, vec![page_id]));
    Ok(manifest)
}

#[tauri::command]
pub async fn vfs_ink_copy(
    request: InkCopyRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    app: AppHandle,
) -> Result<InkManifest, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    let operation_id = request.operation_id.clone();
    let manifest = run_blocking(db, move |db| copy(db, request)).await?;
    emit_changed(
        &app,
        changed_event(
            &manifest,
            operation_id,
            manifest
                .pages
                .iter()
                .map(|page| page.page_id.clone())
                .collect(),
        ),
    );
    Ok(manifest)
}

#[tauri::command]
pub async fn vfs_ink_append_page(
    request: InkAppendPageRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    app: AppHandle,
) -> Result<InkManifest, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    let operation_id = request.operation_id.clone();
    let manifest = run_blocking(db, move |db| append_page(db, request)).await?;
    let affected = manifest
        .last_operation
        .as_ref()
        .filter(|receipt| receipt.operation_id == operation_id)
        .and_then(|_| manifest.pages.last())
        .map(|page| vec![page.page_id.clone()])
        .unwrap_or_default();
    emit_changed(&app, changed_event(&manifest, operation_id, affected));
    Ok(manifest)
}

#[tauri::command]
pub async fn vfs_ink_rename(
    request: InkRenameRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    app: AppHandle,
) -> Result<InkManifest, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    let operation_id = request.operation_id.clone();
    let manifest = run_blocking(db, move |db| rename(db, request)).await?;
    emit_changed(
        &app,
        changed_event(
            &manifest,
            operation_id,
            manifest
                .pages
                .iter()
                .map(|page| page.page_id.clone())
                .collect(),
        ),
    );
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::vfs::{
        database::setup_migrated_test_db,
        error::VfsError,
        ink::{
            InkAuthor, InkObject, InkObjectContent, InkRuling, InkSample, InkStrokeStyle, InkTool,
            INK_EXTENSION, INK_MIME,
        },
        repos::{blob_repo::VfsBlobRepo, file_repo::VfsFileRepo},
    };

    use super::{
        append_page, create, get, get_page, rename, save_page, InkAppendPageRequest,
        InkCreateRequest, InkGetPageRequest, InkGetRequest, InkRenameRequest, InkSavePageRequest,
    };

    #[test]
    fn request_types_reject_unknown_fields() {
        let malformed = json!({ "document_id": "ink-doc", "path": "/tmp/outside" });
        assert!(serde_json::from_value::<InkGetRequest>(malformed).is_err());

        let malformed = json!({
            "document_id": "ink-doc",
            "expected_revision": "r_1",
            "operation_id": "op-1",
            "page": { "schema_version": 1, "page_id": "p_1", "objects": [] },
            "path": "/tmp/outside"
        });
        assert!(serde_json::from_value::<InkSavePageRequest>(malformed).is_err());

        let malformed = json!({
            "document_id": "ink-doc",
            "expected_revision": "r_1",
            "operation_id": "append-1",
            "width": 800.0,
            "height": 1100.0,
            "ruling": "blank",
            "path": "/tmp/outside"
        });
        assert!(serde_json::from_value::<InkAppendPageRequest>(malformed).is_err());

        let malformed = json!({
            "document_id": "ink-doc",
            "expected_revision": "r_1",
            "operation_id": "rename-1",
            "title": "A title",
            "path": "/tmp/outside"
        });
        assert!(serde_json::from_value::<InkRenameRequest>(malformed).is_err());
    }

    #[test]
    fn command_error_serializes_stable_boundary_fields_only() {
        let error = super::InkCommandError::from(VfsError::Conflict {
            key: "ink.revision_conflict".to_owned(),
            message: "internal db details must not escape".to_owned(),
        });
        let payload = serde_json::to_value(error).unwrap();
        assert_eq!(payload["code"], "REVISION_CONFLICT");
        assert_eq!(payload["retryable"], true);
        assert_eq!(
            payload["message"],
            "The Ink document changed while saving; reload and try again."
        );
        assert!(payload.get("current_revision").is_none());
        assert!(!payload.to_string().contains("internal db details"));

        let storage_error = super::InkCommandError::from(VfsError::Database(
            "/private/user/path/vfs.db: raw storage details".to_owned(),
        ));
        let storage_payload = serde_json::to_value(storage_error).unwrap();
        assert_eq!(storage_payload["code"], "INTERNAL");
        assert!(!storage_payload.to_string().contains("/private/user/path"));
        assert!(!storage_payload.to_string().contains("raw storage details"));
    }

    #[test]
    fn changed_event_has_stable_payload_and_page_ids() {
        let (_temp, db) = setup_migrated_test_db();
        let manifest = create(
            &db,
            InkCreateRequest {
                title: "Event test".to_owned(),
                ruling: InkRuling::Blank,
                width: 800.0,
                height: 1100.0,
                operation_id: "event-create".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();
        let page_ids = manifest
            .pages
            .iter()
            .map(|page| page.page_id.clone())
            .collect::<Vec<_>>();
        let event = super::changed_event(&manifest, "event-create".to_owned(), page_ids.clone());
        let payload = serde_json::to_value(event).unwrap();

        assert_eq!(payload["document_id"], manifest.document_id);
        assert_eq!(payload["revision"], manifest.revision);
        assert_eq!(payload["operation_id"], "event-create");
        assert_eq!(payload["affected_page_ids"], json!(page_ids));
    }

    fn replace_manifest_blob(
        conn: &rusqlite::Connection,
        db: &crate::vfs::VfsDatabase,
        document_id: &str,
        bytes: &[u8],
    ) {
        let old_hash: String = conn
            .query_row(
                "SELECT blob_hash FROM files WHERE id = ?1",
                [document_id],
                |row| row.get(0),
            )
            .unwrap();
        let new_blob = VfsBlobRepo::store_blob_with_conn(
            conn,
            db.blobs_dir(),
            bytes,
            Some(INK_MIME),
            Some(INK_EXTENSION),
        )
        .unwrap();
        conn.execute(
            "UPDATE files SET blob_hash = ?1, sha256 = ?1, size = ?2 WHERE id = ?3",
            rusqlite::params![new_blob.hash, bytes.len() as i64, document_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE resources SET hash = ?1 WHERE source_id = ?2 AND source_table = 'files'",
            rusqlite::params![new_blob.hash, document_id],
        )
        .unwrap();
        VfsBlobRepo::decrement_ref_with_conn(conn, db.blobs_dir(), &old_hash).unwrap();
    }

    #[test]
    fn service_create_preserves_ink_limit_error_code() {
        let (_temp, db) = setup_migrated_test_db();
        let error = create(
            &db,
            InkCreateRequest {
                title: "x".repeat(crate::vfs::ink::INK_TITLE_MAX_CHARS + 1),
                ruling: InkRuling::Blank,
                width: 100.0,
                height: 100.0,
                operation_id: "overlong-title".to_owned(),
                folder_id: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "LIMIT_EXCEEDED");
    }

    #[test]
    fn service_get_preserves_unsupported_schema_and_malformed_manifest_errors() {
        let (_temp, db) = setup_migrated_test_db();
        let created = create(
            &db,
            InkCreateRequest {
                title: "Schema mapping".to_owned(),
                ruling: InkRuling::Blank,
                width: 100.0,
                height: 100.0,
                operation_id: "schema-mapping-create".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();
        let conn = db.get_conn_safe().unwrap();
        let manifest_path = {
            let hash: String = conn
                .query_row(
                    "SELECT blob_hash FROM files WHERE id = ?1",
                    [&created.document_id],
                    |row| row.get(0),
                )
                .unwrap();
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &hash)
                .unwrap()
                .unwrap()
        };
        let mut manifest_json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest_json["schema_version"] = serde_json::json!(99);
        let unsupported_bytes = serde_json::to_vec(&manifest_json).unwrap();
        replace_manifest_blob(&conn, &db, &created.document_id, &unsupported_bytes);
        drop(conn);

        let unsupported = get(
            &db,
            InkGetRequest {
                document_id: created.document_id.clone(),
            },
        )
        .unwrap_err();
        assert_eq!(unsupported.code, "UNSUPPORTED_SCHEMA");

        let conn = db.get_conn_safe().unwrap();
        replace_manifest_blob(&conn, &db, &created.document_id, b"not json");
        drop(conn);
        let malformed = get(
            &db,
            InkGetRequest {
                document_id: created.document_id,
            },
        )
        .unwrap_err();
        assert_eq!(malformed.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn command_conflicts_keep_prepare_source_and_artifact_revision_codes() {
        let source = super::InkCommandError::from(VfsError::Conflict {
            key: "ink.source_changed".to_owned(),
            message: "source changed".to_owned(),
        });
        assert_eq!(source.code, "SOURCE_CHANGED");

        let artifact = super::InkCommandError::from(VfsError::Conflict {
            key: "ink.artifact.provenance_mismatch".to_owned(),
            message: "provenance mismatch".to_owned(),
        });
        assert_eq!(artifact.code, "REVISION_CONFLICT");
    }

    #[test]
    fn failed_save_keeps_document_revision_and_blob_references_unchanged() {
        let (_temp, db) = setup_migrated_test_db();
        let created = create(
            &db,
            InkCreateRequest {
                title: "Failed save remains atomic".to_owned(),
                ruling: InkRuling::Blank,
                width: 100.0,
                height: 100.0,
                operation_id: "failed-save-create".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();
        let conn = db.get_conn_safe().unwrap();
        let before_refs: i64 = conn
            .query_row("SELECT COALESCE(SUM(ref_count), 0) FROM blobs", [], |row| {
                row.get(0)
            })
            .unwrap();
        drop(conn);
        let mut invalid_page = get_page(
            &db,
            InkGetPageRequest {
                document_id: created.document_id.clone(),
                page_id: created.pages[0].page_id.clone(),
            },
        )
        .unwrap();
        invalid_page.objects.push(InkObject {
            id: "invalid-stroke".to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            content: InkObjectContent::Stroke {
                samples: vec![InkSample {
                    x: 10_000.0,
                    y: 1.0,
                    pressure: 2.0,
                    elapsed_ms: None,
                }],
                style: InkStrokeStyle {
                    tool: InkTool::Pen,
                    color: "#000000".to_owned(),
                    width: 1.0,
                    pressure_enabled: true,
                },
            },
        });
        let error = save_page(
            &db,
            InkSavePageRequest {
                document_id: created.document_id.clone(),
                expected_revision: created.revision.clone(),
                operation_id: "failed-save-invalid-page".to_owned(),
                page: invalid_page,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        let loaded = get(
            &db,
            InkGetRequest {
                document_id: created.document_id,
            },
        )
        .unwrap();
        assert_eq!(loaded.revision, created.revision);
        let conn = db.get_conn_safe().unwrap();
        let after_refs: i64 = conn
            .query_row("SELECT COALESCE(SUM(ref_count), 0) FROM blobs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(after_refs, before_refs);
    }

    #[test]
    fn migrated_database_create_and_get_round_trip() {
        let (_temp, db) = setup_migrated_test_db();
        let created = create(
            &db,
            InkCreateRequest {
                title: "Service test".to_owned(),
                ruling: InkRuling::Blank,
                width: 800.0,
                height: 1100.0,
                operation_id: "create-service-test".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();

        let loaded = get(
            &db,
            InkGetRequest {
                document_id: created.document_id.clone(),
            },
        )
        .unwrap();
        assert_eq!(loaded, created);
    }

    #[test]
    fn unsupported_file_and_stale_revision_return_structured_errors() {
        let (_temp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let ordinary = VfsFileRepo::create_file_with_conn(
            &conn,
            &VfsBlobRepo::compute_hash(b"ordinary file"),
            "ordinary.txt",
            13,
            "document",
            Some("text/plain"),
            None,
            None,
        )
        .unwrap();
        drop(conn);
        let unsupported = get(
            &db,
            InkGetRequest {
                document_id: ordinary.id,
            },
        )
        .unwrap_err();
        assert_eq!(unsupported.code, "UNSUPPORTED_FORMAT");

        let created = create(
            &db,
            InkCreateRequest {
                title: "Stale service test".to_owned(),
                ruling: InkRuling::Blank,
                width: 800.0,
                height: 1100.0,
                operation_id: "create-stale-service-test".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();
        let page = get_page(
            &db,
            InkGetPageRequest {
                document_id: created.document_id.clone(),
                page_id: created.pages[0].page_id.clone(),
            },
        )
        .unwrap();
        let saved = save_page(
            &db,
            InkSavePageRequest {
                document_id: created.document_id.clone(),
                expected_revision: created.revision,
                operation_id: "save-stale-base".to_owned(),
                page: page.clone(),
            },
        )
        .unwrap();
        let stale = save_page(
            &db,
            InkSavePageRequest {
                document_id: created.document_id,
                expected_revision: "r_stale".to_owned(),
                operation_id: "save-stale-request".to_owned(),
                page,
            },
        )
        .unwrap_err();
        assert_eq!(stale.code, "OPERATION_STATE_UNKNOWN");
        assert!(stale.current_revision.is_none());
        assert_ne!(saved.revision, "r_stale");
    }

    #[test]
    fn migrated_database_append_page_returns_new_page_details() {
        let (_temp, db) = setup_migrated_test_db();
        let created = create(
            &db,
            InkCreateRequest {
                title: "Append service test".to_owned(),
                ruling: InkRuling::Blank,
                width: 800.0,
                height: 1100.0,
                operation_id: "create-append-service-test".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();

        let appended = append_page(
            &db,
            InkAppendPageRequest {
                document_id: created.document_id.clone(),
                expected_revision: created.revision.clone(),
                operation_id: "append-page-service-test".to_owned(),
                width: 640.0,
                height: 900.0,
                ruling: InkRuling::Grid,
            },
        )
        .unwrap();

        assert_eq!(appended.pages.len(), 2);
        assert_eq!(appended.pages[0].page_id, created.pages[0].page_id);
        assert_eq!(appended.pages[1].width, 640.0);
        assert_eq!(appended.pages[1].height, 900.0);
        assert_eq!(
            appended.pages[1].background,
            crate::vfs::ink::InkBackground::Blank {
                ruling: InkRuling::Grid
            }
        );
        assert_ne!(appended.revision, created.revision);
    }

    #[test]
    fn migrated_database_rename_changes_title_and_revision() {
        let (_temp, db) = setup_migrated_test_db();
        let created = create(
            &db,
            InkCreateRequest {
                title: "Rename before".to_owned(),
                ruling: InkRuling::Lined,
                width: 800.0,
                height: 1100.0,
                operation_id: "create-rename-service-test".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();

        let renamed = rename(
            &db,
            InkRenameRequest {
                document_id: created.document_id.clone(),
                expected_revision: created.revision.clone(),
                operation_id: "rename-service-test".to_owned(),
                title: "Rename after".to_owned(),
            },
        )
        .unwrap();
        let loaded = get(
            &db,
            InkGetRequest {
                document_id: created.document_id,
            },
        )
        .unwrap();

        assert_eq!(renamed.title, "Rename after");
        assert_ne!(renamed.revision, created.revision);
        assert_eq!(loaded, renamed);
    }

    #[test]
    fn migrated_database_stale_rename_returns_error_without_overwriting() {
        let (_temp, db) = setup_migrated_test_db();
        let created = create(
            &db,
            InkCreateRequest {
                title: "Stale rename".to_owned(),
                ruling: InkRuling::Blank,
                width: 800.0,
                height: 1100.0,
                operation_id: "create-stale-rename".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();
        let current = rename(
            &db,
            InkRenameRequest {
                document_id: created.document_id.clone(),
                expected_revision: created.revision,
                operation_id: "rename-current".to_owned(),
                title: "Current title".to_owned(),
            },
        )
        .unwrap();

        let stale = rename(
            &db,
            InkRenameRequest {
                document_id: created.document_id,
                expected_revision: "r_stale".to_owned(),
                operation_id: "rename-stale".to_owned(),
                title: "Must not replace current title".to_owned(),
            },
        )
        .unwrap_err();

        assert_eq!(stale.code, "OPERATION_STATE_UNKNOWN");
        assert_eq!(
            get(
                &db,
                InkGetRequest {
                    document_id: current.document_id.clone()
                }
            )
            .unwrap(),
            current
        );
    }

    #[test]
    fn migrated_database_save_page_and_read_round_trip() {
        let (_temp, db) = setup_migrated_test_db();
        let created = create(
            &db,
            InkCreateRequest {
                title: "Save service test".to_owned(),
                ruling: InkRuling::Lined,
                width: 800.0,
                height: 1100.0,
                operation_id: "create-save-service-test".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();
        let page_id = created.pages[0].page_id.clone();
        let page = get_page(
            &db,
            InkGetPageRequest {
                document_id: created.document_id.clone(),
                page_id: page_id.clone(),
            },
        )
        .unwrap();
        let saved = save_page(
            &db,
            InkSavePageRequest {
                document_id: created.document_id.clone(),
                expected_revision: created.revision,
                operation_id: "save-service-test".to_owned(),
                page: page.clone(),
            },
        )
        .unwrap();

        let loaded_page = get_page(
            &db,
            InkGetPageRequest {
                document_id: saved.document_id,
                page_id,
            },
        )
        .unwrap();
        assert_eq!(loaded_page, page);
    }
}
