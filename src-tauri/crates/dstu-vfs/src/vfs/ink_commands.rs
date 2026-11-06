//! Shared request and service boundary for Ink VFS commands.

use std::{collections::HashSet, path::Path, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::{
    database::VfsDatabase,
    error::VfsError,
    ink::{
        InkBoardChunk, InkBoardSurface, InkManifest, InkPage, InkRuling, INK_BOARD_CHUNKS_MAX,
        INK_BOARD_CHUNK_MAX_BYTES, INK_BOARD_CONTENT_MAX_BYTES, INK_BOARD_SCHEMA_VERSION,
    },
    repos::{
        ink_board_repo::{InkBoardOverview, VfsInkBoardRepo},
        VfsInkRepo,
    },
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkCreateBoardRequest {
    pub title: String,
    pub ruling: InkRuling,
    pub operation_id: String,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkGetChunksRequest {
    pub document_id: String,
    #[serde(default)]
    pub expected_revision: Option<String>,
    pub chunk_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkGetBoardOverviewRequest {
    pub document_id: String,
    #[serde(default)]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkSaveChunksRequest {
    pub document_id: String,
    pub expected_revision: String,
    pub operation_id: String,
    pub changed: Vec<InkBoardChunk>,
    pub deleted: Vec<String>,
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

    fn unsupported_format() -> Self {
        Self::new(
            "UNSUPPORTED_FORMAT",
            "This VFS file is not a supported Ink document.",
            false,
        )
    }

    fn revision_conflict(current_revision: String) -> Self {
        let mut error = Self::new(
            "REVISION_CONFLICT",
            "The Ink board changed; reload the board before reading chunks.",
            true,
        );
        error.current_revision = Some(current_revision);
        error
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

/// Private execution path for the public facade and for tests.
pub(crate) fn execute_create_board(
    db: &VfsDatabase,
    request: InkCreateBoardRequest,
) -> Result<InkManifest, InkCommandError> {
    with_conn(db, |conn, blobs_dir| {
        VfsInkBoardRepo::create_blank_with_conn(
            conn,
            blobs_dir,
            &request.title,
            request.ruling,
            &request.operation_id,
            request.folder_id.as_deref(),
        )
    })
}

/// Single public entry point for board creation.
///
/// There is intentionally no facade-level open/closed switch: the real gate is
/// the VFS writer guard installed by the repository in the same savepoint that
/// publishes the first board. That guard requires the caller's connection to
/// report the board writer capability, refuses to downgrade a newer marker
/// floor, and installs all nine exact triggers atomically. Tooling must call
/// this facade; it must not pre-install the guard or bypass it via the private
/// execution path.
pub fn create_board_gated(
    db: &VfsDatabase,
    request: InkCreateBoardRequest,
) -> Result<InkManifest, InkCommandError> {
    execute_create_board(db, request)
}

fn validate_board_chunk_ids(chunk_ids: &[String]) -> Result<(), InkCommandError> {
    if chunk_ids.len() > INK_BOARD_CHUNKS_MAX {
        return Err(InkCommandError::new(
            "LIMIT_EXCEEDED",
            "Ink board chunk request exceeds the chunk limit.",
            false,
        ));
    }
    let mut seen = HashSet::with_capacity(chunk_ids.len());
    if chunk_ids
        .iter()
        .any(|chunk_id| !seen.insert(chunk_id.as_str()))
    {
        return Err(InkCommandError::new(
            "INVALID_ARGUMENT",
            "Ink board chunk request contains duplicate chunk IDs.",
            false,
        ));
    }
    Ok(())
}

fn validate_board_save_budget(
    changed: &[InkBoardChunk],
    deleted: &[String],
) -> Result<(), InkCommandError> {
    if changed.len() > INK_BOARD_CHUNKS_MAX || deleted.len() > INK_BOARD_CHUNKS_MAX {
        return Err(InkCommandError::new(
            "LIMIT_EXCEEDED",
            "Ink board save exceeds the chunk limit.",
            false,
        ));
    }
    let mut total_bytes: u64 = 0;
    for chunk in changed {
        let bytes = serde_json::to_vec(chunk)
            .map_err(|error| InkCommandError::from(VfsError::Serialization(error.to_string())))?;
        let byte_length = bytes.len() as u64;
        if byte_length > INK_BOARD_CHUNK_MAX_BYTES as u64 {
            return Err(InkCommandError::new(
                "LIMIT_EXCEEDED",
                "Ink board chunk exceeds the byte limit.",
                false,
            ));
        }
        total_bytes = total_bytes.checked_add(byte_length).ok_or_else(|| {
            InkCommandError::new(
                "LIMIT_EXCEEDED",
                "Ink board save exceeds the content budget.",
                false,
            )
        })?;
        if total_bytes > INK_BOARD_CONTENT_MAX_BYTES {
            return Err(InkCommandError::new(
                "LIMIT_EXCEEDED",
                "Ink board save exceeds the content budget.",
                false,
            ));
        }
    }
    Ok(())
}

/// Read chunks for a v2 board.
///
/// `expected_revision` is a strict epoch check: when the caller's base
/// revision is no longer current this returns `REVISION_CONFLICT` with the
/// current revision instead of a chunk snapshot from a newer epoch. The
/// manifest check and the chunk reads share one read transaction so a
/// concurrent save can never slip between them.
pub(crate) fn get_board_chunks(
    db: &VfsDatabase,
    request: InkGetChunksRequest,
) -> Result<Vec<InkBoardChunk>, InkCommandError> {
    validate_board_chunk_ids(&request.chunk_ids)?;
    let mut conn = db.get_conn_safe().map_err(InkCommandError::from)?;
    let tx = conn
        .transaction()
        .map_err(|error| InkCommandError::from(VfsError::Database(error.to_string())))?;
    let blobs_dir = db.blobs_dir();
    let manifest = VfsInkRepo::get_manifest_with_conn(&tx, blobs_dir, &request.document_id)
        .map_err(InkCommandError::from)?;
    if manifest.schema_version != INK_BOARD_SCHEMA_VERSION {
        return Err(InkCommandError::unsupported_format());
    }
    if let Some(expected_revision) = request.expected_revision.as_deref() {
        if manifest.revision != expected_revision {
            return Err(InkCommandError::revision_conflict(manifest.revision));
        }
    }
    let chunks = VfsInkBoardRepo::get_chunks_with_conn(
        &tx,
        blobs_dir,
        &request.document_id,
        &request.chunk_ids,
    )
    .map_err(InkCommandError::from)?;
    tx.commit()
        .map_err(|error| InkCommandError::from(VfsError::Database(error.to_string())))?;
    Ok(chunks)
}

/// Read the board overview under the same read transaction as the epoch check.
///
/// `expected_revision` is optional, but when present the manifest revision and
/// the chunk scan come from one snapshot so a concurrent save cannot return an
/// overview from a newer epoch than the caller validated.
pub(crate) fn get_board_overview(
    db: &VfsDatabase,
    request: InkGetBoardOverviewRequest,
) -> Result<InkBoardOverview, InkCommandError> {
    let mut conn = db.get_conn_safe().map_err(InkCommandError::from)?;
    let tx = conn
        .transaction()
        .map_err(|error| InkCommandError::from(VfsError::Database(error.to_string())))?;
    let blobs_dir = db.blobs_dir();
    let manifest = VfsInkRepo::get_manifest_with_conn(&tx, blobs_dir, &request.document_id)
        .map_err(InkCommandError::from)?;
    if manifest.schema_version != INK_BOARD_SCHEMA_VERSION {
        return Err(InkCommandError::unsupported_format());
    }
    if let Some(expected_revision) = request.expected_revision.as_deref() {
        if manifest.revision != expected_revision {
            return Err(InkCommandError::revision_conflict(manifest.revision));
        }
    }
    let overview = VfsInkBoardRepo::overview_with_conn(&tx, blobs_dir, &request.document_id)
        .map_err(InkCommandError::from)?;
    tx.commit()
        .map_err(|error| InkCommandError::from(VfsError::Database(error.to_string())))?;
    Ok(overview)
}

/// Apply one atomic chunk delta; the repository owns the v2 schema check and
/// the CAS expected-revision semantics (including idempotent operation retry).
pub(crate) fn execute_save_chunks(
    db: &VfsDatabase,
    request: InkSaveChunksRequest,
) -> Result<InkManifest, InkCommandError> {
    validate_board_save_budget(&request.changed, &request.deleted)?;
    with_conn(db, |conn, blobs_dir| {
        VfsInkBoardRepo::save_chunks_with_conn(
            conn,
            blobs_dir,
            &request.document_id,
            &request.expected_revision,
            &request.operation_id,
            &request.changed,
            &request.deleted,
        )
    })
}

fn board_surface_page_ids(manifest: &InkManifest) -> Vec<String> {
    manifest
        .surface
        .as_ref()
        .map(|surface| match surface {
            InkBoardSurface::Board { page_id, .. } => page_id.clone(),
        })
        .into_iter()
        .collect()
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

#[tauri::command]
pub async fn vfs_ink_create_board(
    request: InkCreateBoardRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    app: AppHandle,
) -> Result<InkManifest, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    let operation_id = request.operation_id.clone();
    let manifest = run_blocking(db, move |db| create_board_gated(db, request)).await?;
    emit_changed(
        &app,
        changed_event(&manifest, operation_id, board_surface_page_ids(&manifest)),
    );
    Ok(manifest)
}

#[tauri::command]
pub async fn vfs_ink_get_chunks(
    request: InkGetChunksRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<InkBoardChunk>, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    run_blocking(db, move |db| get_board_chunks(db, request)).await
}

#[tauri::command]
pub async fn vfs_ink_get_board_overview(
    request: InkGetBoardOverviewRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<InkBoardOverview, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    run_blocking(db, move |db| get_board_overview(db, request)).await
}

#[tauri::command]
pub async fn vfs_ink_save_chunks(
    request: InkSaveChunksRequest,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    app: AppHandle,
) -> Result<InkManifest, InkCommandError> {
    let db = Arc::clone(&*vfs_db);
    let operation_id = request.operation_id.clone();
    let manifest = run_blocking(db, move |db| execute_save_chunks(db, request)).await?;
    emit_changed(
        &app,
        changed_event(&manifest, operation_id, board_surface_page_ids(&manifest)),
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
            InkAuthor, InkBoardChunk, InkBoardObject, InkBoardSurface, InkObject, InkObjectContent,
            InkRect, InkRuling, InkSample, InkStrokeStyle, InkTool, INK_BOARD_CHUNKS_MAX,
            INK_BOARD_SCHEMA_VERSION, INK_EXTENSION, INK_MIME,
        },
        repos::{blob_repo::VfsBlobRepo, file_repo::VfsFileRepo},
    };

    use super::{
        append_page, create, create_board_gated, execute_create_board, execute_save_chunks, get,
        get_board_chunks, get_board_overview, get_page, rename, save_page, InkAppendPageRequest,
        InkCreateBoardRequest, InkCreateRequest, InkGetBoardOverviewRequest, InkGetChunksRequest,
        InkGetPageRequest, InkGetRequest, InkRenameRequest, InkSaveChunksRequest,
        InkSavePageRequest,
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

    fn board_create_request(operation_id: &str, title: &str) -> InkCreateBoardRequest {
        InkCreateBoardRequest {
            title: title.to_owned(),
            ruling: InkRuling::Blank,
            operation_id: operation_id.to_owned(),
            folder_id: None,
        }
    }

    fn board_rect_chunk(
        chunk_id: &str,
        object_id: &str,
        x: f64,
        y: f64,
        z_index: i64,
    ) -> InkBoardChunk {
        InkBoardChunk {
            schema_version: INK_BOARD_SCHEMA_VERSION,
            chunk_id: chunk_id.to_owned(),
            objects: vec![InkBoardObject {
                id: object_id.to_owned(),
                author: InkAuthor::User,
                created_at: 0,
                z_index,
                content: InkObjectContent::Rect {
                    rect: InkRect {
                        x,
                        y,
                        width: 10.0,
                        height: 10.0,
                    },
                    color: "#000000".to_owned(),
                    width: 1.0,
                },
            }],
        }
    }

    #[test]
    fn board_request_types_reject_unknown_fields() {
        let malformed = json!({
            "title": "Board",
            "ruling": "blank",
            "operation_id": "board-op",
            "width": 800.0
        });
        assert!(serde_json::from_value::<InkCreateBoardRequest>(malformed).is_err());

        let malformed = json!({
            "document_id": "ink-doc",
            "expected_revision": "r_1",
            "chunk_ids": [],
            "path": "/tmp/outside"
        });
        assert!(serde_json::from_value::<InkGetChunksRequest>(malformed).is_err());

        let malformed = json!({
            "document_id": "ink-doc",
            "expected_revision": "r_1",
            "operation_id": "save-1",
            "changed": [],
            "deleted": [],
            "path": "/tmp/outside"
        });
        assert!(serde_json::from_value::<InkSaveChunksRequest>(malformed).is_err());

        let valid = json!({ "document_id": "ink-doc", "chunk_ids": ["chunk-a"] });
        assert!(serde_json::from_value::<InkGetChunksRequest>(valid).is_ok());

        let malformed = json!({
            "document_id": "ink-doc",
            "expected_revision": "r_1",
            "path": "/tmp/outside"
        });
        assert!(serde_json::from_value::<InkGetBoardOverviewRequest>(malformed).is_err());

        let minimal: InkGetBoardOverviewRequest =
            serde_json::from_value(json!({ "document_id": "ink-doc" })).unwrap();
        assert_eq!(minimal.expected_revision, None);
        let with_epoch: InkGetBoardOverviewRequest = serde_json::from_value(json!({
            "document_id": "ink-doc",
            "expected_revision": "r_1"
        }))
        .unwrap();
        assert_eq!(with_epoch.expected_revision.as_deref(), Some("r_1"));
    }

    fn set_writer_guard_floor(db: &crate::vfs::database::VfsDatabase, floor: i64) {
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE __vfs_writer_guard
             SET min_writer_capability = ?1, guard_installed = 0
             WHERE id = 1",
            [floor],
        )
        .unwrap();
    }

    /// A database written by a newer writer (marker floor 6) must not be
    /// downgraded by this build. The repository-side guard is the real gate,
    /// so public board creation is rejected before any manifest is published.
    #[test]
    fn board_public_creation_rejects_a_future_writer_floor() {
        let (_temp, db) = setup_migrated_test_db();
        set_writer_guard_floor(&db, 6);

        let error = create_board_gated(
            &db,
            board_create_request("board-future-floor-create", "Future floor board"),
        )
        .unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_SCHEMA");
        assert!(!error.retryable);

        let conn = db.get_conn_safe().unwrap();
        let marker: (i64, i64) = conn
            .query_row(
                "SELECT min_writer_capability, guard_installed
                 FROM __vfs_writer_guard WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let triggers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'trigger' AND name LIKE 'trg_vfs_writer_guard_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            marker,
            (6, 0),
            "a refused install must neither lower nor mark the future floor installed"
        );
        assert_eq!(
            triggers, 0,
            "a refused install must not leave partial guard triggers"
        );
    }

    /// The future-floor rejection must be a real zero-write failure: no board
    /// is published, the floor is not lowered, and no partial guard is left.
    #[test]
    fn board_public_creation_future_floor_failure_writes_nothing_and_preserves_marker() {
        fn counts(db: &crate::vfs::database::VfsDatabase) -> (i64, i64, i64) {
            let conn = db.get_conn_safe().unwrap();
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM resources), (SELECT COALESCE(SUM(ref_count), 0) FROM blobs)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
        }

        let (_temp, db) = setup_migrated_test_db();
        set_writer_guard_floor(&db, 6);
        let before = counts(&db);

        let error = create_board_gated(
            &db,
            board_create_request("board-future-floor-zero-write", "Future floor zero write"),
        )
        .unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_SCHEMA");
        assert!(!error.retryable);
        assert_eq!(
            counts(&db),
            before,
            "the future-floor rejection must not write files, resources, or blob references"
        );

        let conn = db.get_conn_safe().unwrap();
        let marker: (i64, i64) = conn
            .query_row(
                "SELECT min_writer_capability, guard_installed
                 FROM __vfs_writer_guard WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        drop(conn);
        assert_eq!(marker, (6, 0), "the floor must not be lowered");
    }

    /// Positive regression for the enabled public gate: `create_board_gated`
    /// must publish a real v2 board, leave the nine exact guard triggers and
    /// the marker installed, keep the pool connection capability-registered,
    /// and make non-idempotent retries write-free.
    #[test]
    fn board_public_creation_publishes_guarded_v2_and_retries_idempotently() {
        fn counts(db: &crate::vfs::database::VfsDatabase) -> (i64, i64, i64) {
            let conn = db.get_conn_safe().unwrap();
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM resources), (SELECT COALESCE(SUM(ref_count), 0) FROM blobs)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
        }

        fn guard_trigger_count(conn: &rusqlite::Connection) -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'trigger' AND name LIKE 'trg_vfs_writer_guard_%'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        }

        fn guard_marker_installed(conn: &rusqlite::Connection) -> i64 {
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

        let (_temp, db) = setup_migrated_test_db();
        let created = create_board_gated(
            &db,
            board_create_request("board-public-create", "Public board"),
        )
        .expect("the enabled public gate must create a v2 board");

        assert_eq!(created.schema_version, INK_BOARD_SCHEMA_VERSION);
        assert!(created.pages.is_empty());
        assert!(created.chunks.is_empty());
        match created.surface.as_ref().expect("board surface") {
            InkBoardSurface::Board { ruling, .. } => assert_eq!(*ruling, InkRuling::Blank),
        }

        let loaded = get(
            &db,
            InkGetRequest {
                document_id: created.document_id.clone(),
            },
        )
        .unwrap();
        assert_eq!(loaded, created);

        // The published board must carry the complete storage-side guard, not
        // just the marker row: nine canonical triggers plus a registered writer
        // capability on the pool connection that created it.
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(guard_trigger_count(&conn), 9);
        assert_eq!(guard_marker_installed(&conn), 1);
        let capability: i64 = conn
            .query_row("SELECT dstu_vfs_writer_capability()", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            capability,
            dstu_storage::sqlite_capability::VFS_BOARD_WRITER_CAPABILITY_VERSION
        );
        drop(conn);

        // An exact create retry is idempotent and never publishes a second file.
        let retried_create = create_board_gated(
            &db,
            board_create_request("board-public-create", "Public board"),
        )
        .expect("an exact public create retry must return the published board");
        assert_eq!(retried_create.document_id, created.document_id);
        assert_eq!(retried_create.revision, created.revision);
        let conn = db.get_conn_safe().unwrap();
        let files: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);
        assert_eq!(files, 1, "exact create retry must not add a VFS file");

        // Reusing the create operation id with different input is rejected
        // before any row or blob reference is written.
        let before_reuse = counts(&db);
        let reused = create_board_gated(
            &db,
            board_create_request("board-public-create", "Different public board"),
        )
        .unwrap_err();
        assert_eq!(reused.code, "INVALID_ARGUMENT");
        assert_eq!(
            counts(&db),
            before_reuse,
            "different create input must not perform a second write"
        );

        // Saving the board is a real public command path and retries by the
        // same operation id without a second commit.
        let chunk = board_rect_chunk("chunk-public-a", "obj-public-a", 0.0, 0.0, 0);
        let save_request = InkSaveChunksRequest {
            document_id: created.document_id.clone(),
            expected_revision: created.revision.clone(),
            operation_id: "board-public-save".to_owned(),
            changed: vec![chunk],
            deleted: Vec::new(),
        };
        let saved = execute_save_chunks(&db, save_request.clone()).unwrap();
        assert_ne!(saved.revision, created.revision);
        let retried_save = execute_save_chunks(&db, save_request).unwrap();
        assert_eq!(retried_save, saved);

        // After the save receipt replaced the create receipt, a create retry can
        // no longer prove the original result. That unknown state must also
        // leave storage untouched.
        let before_unknown = counts(&db);
        let unknown = create_board_gated(
            &db,
            board_create_request("board-public-create", "Public board"),
        )
        .unwrap_err();
        assert_eq!(unknown.code, "OPERATION_STATE_UNKNOWN");
        assert_eq!(
            counts(&db),
            before_unknown,
            "an unprovable create retry must not perform a second write"
        );

        // A legacy connection without the capability UDF can still read, but
        // every guarded DML class stays fail-closed.
        let old = rusqlite::Connection::open(db.db_path()).expect("open unregistered connection");
        assert!(
            old.execute(
                "INSERT INTO blobs (hash, relative_path, size, ref_count, created_at)
                 VALUES ('board-public-probe', 'board-public-probe', 0, 0, 0)",
                [],
            )
            .is_err(),
            "an unregistered connection must not insert blobs"
        );
        assert!(
            old.execute(
                "UPDATE files SET file_name = 'tampered' WHERE id = ?1",
                [saved.document_id.as_str()],
            )
            .is_err(),
            "an unregistered connection must not update files"
        );
        assert!(
            old.execute(
                "DELETE FROM files WHERE id = ?1",
                [saved.document_id.as_str()],
            )
            .is_err(),
            "an unregistered connection must not delete files"
        );
        let after_blocked_writes = counts(&db);
        assert_eq!(after_blocked_writes, before_unknown);
        drop(old);

        // Reopening through the public read path still returns the saved board.
        let reopen = get(
            &db,
            InkGetRequest {
                document_id: saved.document_id.clone(),
            },
        )
        .unwrap();
        assert_eq!(reopen, saved);
    }

    #[test]
    fn execute_create_board_writes_v2_manifest_and_retries_idempotently() {
        let (_temp, db) = setup_migrated_test_db();
        let created =
            execute_create_board(&db, board_create_request("board-exec-create", "Board exec"))
                .unwrap();

        assert_eq!(created.schema_version, INK_BOARD_SCHEMA_VERSION);
        assert!(created.pages.is_empty());
        assert!(created.chunks.is_empty());
        match created.surface.as_ref().expect("board surface") {
            InkBoardSurface::Board { ruling, .. } => assert_eq!(*ruling, InkRuling::Blank),
        }

        let loaded = get(
            &db,
            InkGetRequest {
                document_id: created.document_id.clone(),
            },
        )
        .unwrap();
        assert_eq!(loaded, created);

        let conn = db.get_conn_safe().unwrap();
        let page_count: i64 = conn
            .query_row(
                "SELECT page_count FROM files WHERE id = ?1",
                [&created.document_id],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);
        assert_eq!(page_count, 0);

        let retry =
            execute_create_board(&db, board_create_request("board-exec-create", "Board exec"))
                .unwrap();
        assert_eq!(retry, created);

        let reused = execute_create_board(
            &db,
            board_create_request("board-exec-create", "Different board"),
        )
        .unwrap_err();
        assert_eq!(reused.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn board_save_and_get_chunks_enforce_the_expected_revision_epoch() {
        let (_temp, db) = setup_migrated_test_db();
        let created = execute_create_board(
            &db,
            board_create_request("board-epoch-create", "Board epoch"),
        )
        .unwrap();
        let chunk_a = board_rect_chunk("chunk-a", "obj-a", 0.0, 0.0, 0);
        let chunk_b = board_rect_chunk("chunk-b", "obj-b", 20.0, 20.0, 1);
        let save_request = InkSaveChunksRequest {
            document_id: created.document_id.clone(),
            expected_revision: created.revision.clone(),
            operation_id: "board-epoch-save".to_owned(),
            changed: vec![chunk_a.clone(), chunk_b.clone()],
            deleted: Vec::new(),
        };
        let saved = execute_save_chunks(&db, save_request.clone()).unwrap();
        assert_ne!(saved.revision, created.revision);

        let retried = execute_save_chunks(&db, save_request).unwrap();
        assert_eq!(retried, saved);

        let current = get_board_chunks(
            &db,
            InkGetChunksRequest {
                document_id: saved.document_id.clone(),
                expected_revision: Some(saved.revision.clone()),
                chunk_ids: vec!["chunk-b".to_owned(), "chunk-a".to_owned()],
            },
        )
        .unwrap();
        assert_eq!(current, vec![chunk_b, chunk_a]);

        let stale = get_board_chunks(
            &db,
            InkGetChunksRequest {
                document_id: saved.document_id.clone(),
                expected_revision: Some(created.revision.clone()),
                chunk_ids: vec!["chunk-a".to_owned()],
            },
        )
        .unwrap_err();
        assert_eq!(stale.code, "REVISION_CONFLICT");
        assert_eq!(
            stale.current_revision.as_deref(),
            Some(saved.revision.as_str())
        );
        assert!(stale.retryable);

        let without_epoch = get_board_chunks(
            &db,
            InkGetChunksRequest {
                document_id: saved.document_id.clone(),
                expected_revision: None,
                chunk_ids: vec!["chunk-a".to_owned()],
            },
        )
        .unwrap();
        assert_eq!(without_epoch.len(), 1);

        let stale_save = execute_save_chunks(
            &db,
            InkSaveChunksRequest {
                document_id: saved.document_id,
                expected_revision: "r_stale".to_owned(),
                operation_id: "board-epoch-stale-save".to_owned(),
                changed: vec![board_rect_chunk("chunk-c", "obj-c", 40.0, 40.0, 2)],
                deleted: Vec::new(),
            },
        )
        .unwrap_err();
        assert_eq!(stale_save.code, "OPERATION_STATE_UNKNOWN");
        assert!(stale_save.current_revision.is_none());
    }

    #[test]
    fn board_overview_command_enforces_expected_revision_epoch() {
        let (_temp, db) = setup_migrated_test_db();
        let created = execute_create_board(
            &db,
            board_create_request("board-overview-create", "Board overview"),
        )
        .unwrap();
        let saved = execute_save_chunks(
            &db,
            InkSaveChunksRequest {
                document_id: created.document_id.clone(),
                expected_revision: created.revision.clone(),
                operation_id: "board-overview-save".to_owned(),
                changed: vec![board_rect_chunk("chunk-a", "obj-a", 0.0, 0.0, 7)],
                deleted: Vec::new(),
            },
        )
        .unwrap();
        let surface_page_id = match saved.surface.as_ref().expect("board surface") {
            InkBoardSurface::Board { page_id, .. } => page_id.clone(),
        };

        let current = get_board_overview(
            &db,
            InkGetBoardOverviewRequest {
                document_id: saved.document_id.clone(),
                expected_revision: Some(saved.revision.clone()),
            },
        )
        .unwrap();
        assert_eq!(current.document_id, saved.document_id);
        assert_eq!(current.revision, saved.revision);
        assert_eq!(current.page_id, surface_page_id);
        assert_eq!(current.max_z_index.as_deref(), Some("7"));

        let stale = get_board_overview(
            &db,
            InkGetBoardOverviewRequest {
                document_id: saved.document_id.clone(),
                expected_revision: Some(created.revision.clone()),
            },
        )
        .unwrap_err();
        assert_eq!(stale.code, "REVISION_CONFLICT");
        assert_eq!(
            stale.current_revision.as_deref(),
            Some(saved.revision.as_str())
        );
        assert!(stale.retryable);

        let without_epoch = get_board_overview(
            &db,
            InkGetBoardOverviewRequest {
                document_id: saved.document_id,
                expected_revision: None,
            },
        )
        .unwrap();
        assert_eq!(without_epoch.revision, saved.revision);
        assert_eq!(without_epoch.max_z_index.as_deref(), Some("7"));
    }

    #[test]
    fn board_chunk_commands_typed_reject_v1_documents() {
        let (_temp, db) = setup_migrated_test_db();
        let v1 = create(
            &db,
            InkCreateRequest {
                title: "V1 document".to_owned(),
                ruling: InkRuling::Blank,
                width: 800.0,
                height: 1100.0,
                operation_id: "board-v1-create".to_owned(),
                folder_id: None,
            },
        )
        .unwrap();

        let read = get_board_chunks(
            &db,
            InkGetChunksRequest {
                document_id: v1.document_id.clone(),
                expected_revision: None,
                chunk_ids: Vec::new(),
            },
        )
        .unwrap_err();
        assert_eq!(read.code, "UNSUPPORTED_FORMAT");

        let save = execute_save_chunks(
            &db,
            InkSaveChunksRequest {
                document_id: v1.document_id,
                expected_revision: v1.revision,
                operation_id: "board-v1-save".to_owned(),
                changed: vec![board_rect_chunk("chunk-v1", "obj-v1", 0.0, 0.0, 0)],
                deleted: Vec::new(),
            },
        )
        .unwrap_err();
        assert_eq!(save.code, "UNSUPPORTED_FORMAT");
    }

    #[test]
    fn board_chunk_requests_enforce_strict_request_budgets() {
        let (_temp, db) = setup_migrated_test_db();
        let created = execute_create_board(
            &db,
            board_create_request("board-budget-create", "Board budget"),
        )
        .unwrap();

        let duplicate = vec!["chunk-a".to_owned(), "chunk-a".to_owned()];
        let duplicate = get_board_chunks(
            &db,
            InkGetChunksRequest {
                document_id: created.document_id.clone(),
                expected_revision: None,
                chunk_ids: duplicate,
            },
        )
        .unwrap_err();
        assert_eq!(duplicate.code, "INVALID_ARGUMENT");

        let too_many = (0..=INK_BOARD_CHUNKS_MAX)
            .map(|index| format!("chunk-{index}"))
            .collect();
        let too_many = get_board_chunks(
            &db,
            InkGetChunksRequest {
                document_id: created.document_id.clone(),
                expected_revision: None,
                chunk_ids: too_many,
            },
        )
        .unwrap_err();
        assert_eq!(too_many.code, "LIMIT_EXCEEDED");

        let too_many_deleted = (0..=INK_BOARD_CHUNKS_MAX)
            .map(|index| format!("chunk-{index}"))
            .collect();
        let too_many_deleted = execute_save_chunks(
            &db,
            InkSaveChunksRequest {
                document_id: created.document_id,
                expected_revision: created.revision,
                operation_id: "board-budget-delete".to_owned(),
                changed: Vec::new(),
                deleted: too_many_deleted,
            },
        )
        .unwrap_err();
        assert_eq!(too_many_deleted.code, "LIMIT_EXCEEDED");
    }

    #[test]
    fn board_save_event_targets_the_surface_page() {
        let (_temp, db) = setup_migrated_test_db();
        let created = execute_create_board(
            &db,
            board_create_request("board-event-create", "Board event"),
        )
        .unwrap();
        let page_ids = super::board_surface_page_ids(&created);
        let surface_page_id = match created.surface.as_ref().expect("board surface") {
            InkBoardSurface::Board { page_id, .. } => page_id.clone(),
        };
        assert_eq!(page_ids, vec![surface_page_id]);

        let payload = serde_json::to_value(super::changed_event(
            &created,
            "board-event-op".to_owned(),
            page_ids.clone(),
        ))
        .unwrap();
        assert_eq!(payload["document_id"], created.document_id);
        assert_eq!(payload["revision"], created.revision);
        assert_eq!(payload["operation_id"], "board-event-op");
        assert_eq!(payload["affected_page_ids"], json!(page_ids));
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
