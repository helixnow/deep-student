//! Trusted app jobs for preparing source-backed Ink documents and exporting them.

use std::{
    collections::HashMap,
    io::{Cursor, Read},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use dstu_vfs::vfs::{
    database::VfsDatabase,
    error::VfsError,
    ink::{
        InkBackground, InkBoardChunk, InkBoardSurface, InkManifest, InkPage, InkPageRef, InkRect,
        InkSource, INK_BOARD_SCHEMA_VERSION, INK_BOARD_WORLD_LIMIT, INK_PAGES_MAX,
    },
    repos::{
        blob_repo::VfsBlobRepo,
        file_repo::VfsFileRepo,
        ink_prepare_repo::{InkPreparedPage, VfsInkPrepareRepo},
        ink_repo::VfsInkRepo,
        ink_source::{ink_source_format, read_ink_source_with_conn},
    },
    upload_saga::UploadSaga,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InkJobError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InkJobKind {
    Prepare,
    Export,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InkJobIdentity {
    pub request_id: String,
    pub operation_id: String,
    pub kind: InkJobKind,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InkJobPayload {
    Prepare {
        source_resource_id: String,
        source_hash: String,
        file_name: String,
        mime_type: String,
        source_bytes_base64: String,
        converter_profile: String,
        expected_converter_version: String,
    },
    Export {
        document_id: String,
        revision: String,
        page_ids: Vec<String>,
        format: InkExportFormat,
        pages: Vec<InkExportPageRequest>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        board: Option<InkExportBoardPayload>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InkExportPageRequest {
    pub page_ref: InkPageRef,
    pub page: InkPage,
    pub highlights: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkExportBoardPayload {
    pub surface: InkBoardSurface,
    pub region: InkRect,
    pub page_width: f64,
    pub page_height: f64,
    pub paginate: bool,
    /// Backend-authoritative row-major page rectangles inside `region`.
    pub pages: Vec<InkRect>,
    pub chunks: Vec<InkBoardChunk>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InkJobRequest {
    pub request_id: String,
    pub operation_id: String,
    pub kind: InkJobKind,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub payload: InkJobPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InkJobResponseValue {
    Prepared {
        pages: Vec<InkStagedPage>,
        converter_version: String,
        warnings: Vec<String>,
    },
    Exported {
        staged_upload_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkJobResponse {
    pub request_id: String,
    pub operation_id: String,
    pub kind: InkJobKind,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub value: Option<InkJobResponseValue>,
    #[serde(default)]
    pub error: Option<InkJobError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InkJobBusError {
    InvalidIdentity,
    DuplicateRequest,
    ForeignWebview,
    IdentityMismatch,
    NotPending,
    Cancelled,
    Timeout,
    JobFailed(InkJobError),
}

#[derive(Clone, Default)]
pub struct PendingInkJobBus {
    pending: Arc<Mutex<HashMap<String, PendingInkJobEntry>>>,
}

struct PendingInkJobEntry {
    identity: InkJobIdentity,
    sender: oneshot::Sender<Result<InkJobResponseValue, InkJobError>>,
}

pub struct PendingInkJob {
    identity: InkJobIdentity,
    receiver: Option<oneshot::Receiver<Result<InkJobResponseValue, InkJobError>>>,
    bus: PendingInkJobBus,
}

impl PendingInkJobBus {
    pub fn register(&self, identity: InkJobIdentity) -> Result<PendingInkJob, InkJobBusError> {
        if identity.request_id.trim().is_empty()
            || identity.operation_id.trim().is_empty()
            || identity.session_id.is_some() != identity.tool_call_id.is_some()
        {
            return Err(InkJobBusError::InvalidIdentity);
        }
        let (sender, receiver) = oneshot::channel();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| InkJobBusError::NotPending)?;
        if pending.contains_key(&identity.request_id) {
            return Err(InkJobBusError::DuplicateRequest);
        }
        pending.insert(
            identity.request_id.clone(),
            PendingInkJobEntry {
                identity: identity.clone(),
                sender,
            },
        );
        drop(pending);
        Ok(PendingInkJob {
            identity,
            receiver: Some(receiver),
            bus: self.clone(),
        })
    }

    pub fn complete_from_labels(
        &self,
        source_label: &str,
        configured_main_label: Option<&str>,
        response: InkJobResponse,
    ) -> Result<(), InkJobBusError> {
        if configured_main_label != Some(source_label) {
            return Err(InkJobBusError::ForeignWebview);
        }
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| InkJobBusError::NotPending)?;
        let expected = pending
            .get(&response.request_id)
            .ok_or(InkJobBusError::NotPending)?;
        let actual = InkJobIdentity {
            request_id: response.request_id.clone(),
            operation_id: response.operation_id.clone(),
            kind: response.kind,
            session_id: response.session_id.clone(),
            tool_call_id: response.tool_call_id.clone(),
        };
        if expected.identity != actual {
            return Err(InkJobBusError::IdentityMismatch);
        }
        if !valid_job_result(&response) {
            return Err(InkJobBusError::InvalidIdentity);
        }
        let entry = pending
            .remove(&response.request_id)
            .ok_or(InkJobBusError::NotPending)?;
        drop(pending);
        let result = match (response.value, response.error) {
            (Some(value), None) => Ok(value),
            (None, Some(error)) => Err(error),
            _ => return Err(InkJobBusError::InvalidIdentity),
        };
        entry
            .sender
            .send(result)
            .map_err(|_| InkJobBusError::NotPending)
    }

    fn remove_if_matching(&self, identity: &InkJobIdentity) {
        if let Ok(mut pending) = self.pending.lock() {
            if pending
                .get(&identity.request_id)
                .is_some_and(|entry| entry.identity == *identity)
            {
                pending.remove(&identity.request_id);
            }
        }
    }
}

fn valid_job_result(response: &InkJobResponse) -> bool {
    match (&response.kind, &response.value, &response.error) {
        (
            InkJobKind::Prepare,
            Some(InkJobResponseValue::Prepared {
                pages,
                converter_version,
                warnings,
            }),
            None,
        ) => {
            (1..=500).contains(&pages.len())
                && !converter_version.trim().is_empty()
                && converter_version.len() <= 4096
                && warnings.len() <= 128
                && warnings.iter().all(|warning| warning.len() <= 2048)
                && pages.iter().all(|page| {
                    !page.staged_upload_id.trim().is_empty()
                        && page.staged_upload_id.len() <= 128
                        && (1..=2048).contains(&page.width_px)
                        && (1..=2048).contains(&page.height_px)
                        && u64::from(page.width_px) * u64::from(page.height_px) <= 16_000_000
                })
        }
        (InkJobKind::Export, Some(InkJobResponseValue::Exported { staged_upload_id }), None) => {
            !staged_upload_id.trim().is_empty() && staged_upload_id.len() <= 128
        }
        (_, None, Some(error)) => {
            !error.code.is_empty() && error.code.len() <= 64 && error.message.len() <= 2048
        }
        _ => false,
    }
}

impl PendingInkJob {
    pub async fn wait(
        mut self,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<InkJobResponseValue, InkJobBusError> {
        let receiver = self.receiver.take().ok_or(InkJobBusError::NotPending)?;
        tokio::select! {
            biased;
            result = receiver => match result.map_err(|_| InkJobBusError::NotPending)? {
                Ok(value) => Ok(value),
                Err(error) => Err(InkJobBusError::JobFailed(error)),
            },
            _ = cancellation.cancelled() => Err(InkJobBusError::Cancelled),
            _ = tokio::time::sleep(timeout) => Err(InkJobBusError::Timeout),
        }
    }
}

impl Drop for PendingInkJob {
    fn drop(&mut self) {
        self.bus.remove_if_matching(&self.identity);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InkStagedPage {
    pub staged_upload_id: String,
    pub width_px: u32,
    pub height_px: u32,
    pub source_page_index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InkExportFormat {
    Png,
    Pdf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InkExportArtifact {
    pub artifact_id: String,
    pub document_id: String,
    pub revision: String,
    pub page_ids: Vec<String>,
    pub format: InkExportFormat,
    pub operation_id: String,
    pub source_hash: Option<String>,
    pub conversion_revision: Option<String>,
    pub mime_type: String,
    pub file_id: String,
    pub resource_id: String,
    pub blob_hash: String,
    pub content_hash: String,
    pub open_locator: String,
    pub created_at: String,
}

const SOURCE_PAGE_MAX_BYTES: u64 = 4 * 1024 * 1024;
const SOURCE_PAGE_MAX_EDGE: u32 = 2048;
const SOURCE_PAGE_MAX_PIXELS: u64 = 16_000_000;
const EXPORT_PNG_MAX_BYTES: u64 = 128 * 1024 * 1024;
const EXPORT_PDF_MAX_BYTES: u64 = 200 * 1024 * 1024;
const BOARD_EXPORT_MAX_EDGE: f64 = 4096.0;
const BOARD_EXPORT_MAX_PIXELS: f64 = SOURCE_PAGE_MAX_PIXELS as f64;

fn job_error(code: &str, message: impl Into<String>) -> InkJobError {
    InkJobError {
        code: code.to_owned(),
        message: message.into(),
    }
}

trait IntoInkJobError {
    fn into_ink_job_error(self) -> InkJobError;
}

impl IntoInkJobError for VfsError {
    fn into_ink_job_error(self) -> InkJobError {
        if let VfsError::Conflict { key, message } = &self {
            if key == "ink.source_changed" {
                tracing::warn!(phase = "source_validation", reason = %message, "Ink source validation failed");
            }
        }
        if matches!(&self, VfsError::InvalidArgument { param, .. } if param == "file_name") {
            return job_error(
                "UNSUPPORTED_FORMAT",
                "The VFS file extension and MIME type are unsupported or inconsistent.",
            );
        }
        let error = dstu_vfs::vfs::ink_commands::InkCommandError::from(self);
        job_error(&error.code, error.message)
    }
}

impl IntoInkJobError for tauri::Error {
    fn into_ink_job_error(self) -> InkJobError {
        job_error("JOB_INTERNAL", self.to_string())
    }
}

impl IntoInkJobError for rusqlite::Error {
    fn into_ink_job_error(self) -> InkJobError {
        job_error("VFS_STORAGE", self.to_string())
    }
}

impl IntoInkJobError for serde_json::Error {
    fn into_ink_job_error(self) -> InkJobError {
        job_error("VFS_SERIALIZATION", self.to_string())
    }
}

impl IntoInkJobError for std::io::Error {
    fn into_ink_job_error(self) -> InkJobError {
        job_error("VFS_IO", self.to_string())
    }
}

impl IntoInkJobError for std::num::TryFromIntError {
    fn into_ink_job_error(self) -> InkJobError {
        job_error("LIMIT_EXCEEDED", self.to_string())
    }
}

impl IntoInkJobError for tokio::task::JoinError {
    fn into_ink_job_error(self) -> InkJobError {
        job_error("JOB_INTERNAL", self.to_string())
    }
}

fn vfs_error(error: impl IntoInkJobError) -> InkJobError {
    error.into_ink_job_error()
}

/// Log a prepare failure with enough structure to diagnose imports without
/// recording source bytes, extracted text, or any other file content.
fn log_prepare_failure(source_resource_id: &str, operation_id: &str, error: &InkJobError) {
    tracing::warn!(
        phase = "prepare",
        code = %error.code,
        reason = %error.message,
        source_resource_id = %source_resource_id,
        operation_id = %operation_id,
        "vfs_ink_prepare failed"
    );
}

fn source_changed(message: &str) -> InkJobError {
    job_error("SOURCE_CHANGED", message)
}

fn source_format(
    file_name: &str,
    mime_type: &str,
    file_type: &str,
) -> Result<&'static str, InkJobError> {
    // Keep the backend's single source-format whitelist authoritative. Real
    // textbook imports persist "pdf"/"docx"/"pptx" as files.type while older
    // VFS rows used "document"/"file"; the shared helper accepts both aliases.
    if let Some(format) = ink_source_format(file_name, mime_type, file_type) {
        return Ok(format);
    }
    let ext = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Preserve the specific legacy Office rejection used by older clients
    // instead of collapsing it into the generic mismatch message.
    if matches!(
        ext.as_str(),
        "xls" | "xlsx" | "ppt" | "doc" | "docm" | "pptm"
    ) {
        return Err(job_error(
            "UNSUPPORTED_FORMAT",
            "This source format is not supported for Ink preparation.",
        ));
    }
    Err(job_error(
        "UNSUPPORTED_FORMAT",
        "The VFS file extension and MIME type are unsupported or inconsistent.",
    ))
}

fn load_source_bytes(
    db: &VfsDatabase,
    resource_id: &str,
) -> Result<(String, String, String, String, Vec<u8>), InkJobError> {
    let mut conn = db.get_conn_safe().map_err(vfs_error)?;
    let tx = conn.transaction().map_err(vfs_error)?;
    let source = read_ink_source_with_conn(&tx, db.blobs_dir(), resource_id, None)
        .map_err(vfs_error)?
        .ok_or_else(|| source_changed("Source resource is missing."))?;
    let identity = source.identity;
    if VfsInkRepo::is_ink_file_candidate_with_conn(&tx, &identity.file_id).map_err(vfs_error)? {
        return Err(job_error(
            "UNSUPPORTED_FORMAT",
            "An Ink document cannot be prepared as a source.",
        ));
    }
    let mime = identity
        .mime_type
        .ok_or_else(|| job_error("UNSUPPORTED_FORMAT", "Source file MIME type is missing."))?;
    let kind = source_format(&identity.file_name, &mime, &identity.file_type)?;
    tx.commit().map_err(vfs_error)?;
    Ok((
        identity.sha256,
        kind.to_owned(),
        identity.file_name,
        mime,
        source.bytes,
    ))
}

fn reusable_prepared_manifest(
    db: &VfsDatabase,
    source_resource_id: &str,
    source_hash: &str,
    conversion_revision: &str,
) -> Result<Option<InkManifest>, InkJobError> {
    let mut conn = db.get_conn_safe().map_err(vfs_error)?;
    let tx = conn.transaction().map_err(vfs_error)?;
    let manifest = VfsInkPrepareRepo::reusable_prepared_manifest_with_conn(
        &tx,
        db.blobs_dir(),
        source_resource_id,
        source_hash,
        conversion_revision,
    )
    .map_err(vfs_error)?;
    tx.commit().map_err(vfs_error)?;
    Ok(manifest)
}

// First-RED seam for notifying the frontend to abort staged output on timeout.
async fn wait_pending_ink_job_with_timeout_notify<F>(
    pending: PendingInkJob,
    timeout: Duration,
    cancellation: &CancellationToken,
    notify: F,
) -> Result<InkJobResponseValue, InkJobError>
where
    F: FnOnce() + Send + 'static,
{
    let result = pending.wait(timeout, cancellation).await;
    if matches!(
        result,
        Err(InkJobBusError::Timeout | InkJobBusError::Cancelled)
    ) {
        notify();
    }
    result.map_err(job_bus_error)
}

fn commit_prepared_source_pages_cancellable(
    db: &VfsDatabase,
    source_resource_id: &str,
    expected_source_hash: &str,
    conversion_revision: &str,
    pages: &[InkStagedPage],
    operation_id: &str,
    cancellation: &CancellationToken,
) -> Result<InkManifest, InkJobError> {
    commit_prepared_source_pages_inner(
        db,
        source_resource_id,
        expected_source_hash,
        conversion_revision,
        pages,
        operation_id,
        Some(cancellation),
    )
}

// RED seam: the export service checks its durable receipt before requesting another render.
fn load_export_receipt_for_retry(
    db: &VfsDatabase,
    document_id: &str,
    expected_revision: &str,
    page_ids: &[String],
    format: InkExportFormat,
    operation_id: &str,
    board: Option<&InkExportBoardRequest>,
) -> Result<Option<InkExportArtifact>, InkJobError> {
    if let Some(board) = board {
        validate_board_export_request(board, format, page_ids)?;
    }
    let input_hash = export_input_hash(
        document_id,
        expected_revision,
        page_ids,
        format,
        operation_id,
        board,
    )?;
    let mut conn = db.get_conn_safe().map_err(vfs_error)?;
    let tx = conn.transaction().map_err(vfs_error)?;
    let file = VfsFileRepo::get_file_with_conn(&tx, document_id)
        .map_err(vfs_error)?
        .ok_or_else(|| job_error("RESOURCE_NOT_FOUND", "Ink document file is missing."))?;
    let document_resource_id = file
        .resource_id
        .ok_or_else(|| job_error("RESOURCE_NOT_FOUND", "Ink document resource is missing."))?;
    tx.execute(
        "UPDATE resources SET hash = hash WHERE id = ?1",
        [&document_resource_id],
    )
    .map_err(vfs_error)?;
    let manifest =
        VfsInkRepo::get_manifest_with_conn(&tx, db.blobs_dir(), document_id).map_err(vfs_error)?;
    let selection_matches = if board.is_some() {
        manifest.schema_version == INK_BOARD_SCHEMA_VERSION
            && page_ids.len() == 1
            && matches!(
                manifest.surface.as_ref(),
                Some(InkBoardSurface::Board { page_id, .. }) if page_id == &page_ids[0]
            )
    } else {
        page_ids
            .iter()
            .all(|id| manifest.pages.iter().any(|page| &page.page_id == id))
    };
    if manifest.revision != expected_revision || !selection_matches {
        return Err(job_error(
            "REVISION_CONFLICT",
            "Ink document revision or page selection changed before export retry.",
        ));
    }
    let raw: Option<String> = tx
        .query_row(
            "SELECT metadata_json FROM resources WHERE id = ?1",
            [&document_resource_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(vfs_error)?
        .flatten();
    let metadata: Value = raw
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(vfs_error)?
        .unwrap_or_else(|| json!({}));
    let receipts = metadata
        .get("ink_export_receipts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let result = if let Some(receipt) = receipts
        .iter()
        .find(|receipt| receipt.get("operation_id").and_then(Value::as_str) == Some(operation_id))
    {
        if receipt.get("input_hash").and_then(Value::as_str) != Some(input_hash.as_str()) {
            return Err(job_error(
                "OPERATION_CONFLICT",
                "This export operation ID is already bound to different input.",
            ));
        }
        let artifact: InkExportArtifact =
            serde_json::from_value(receipt.get("artifact").cloned().ok_or_else(|| {
                job_error(
                    "EXPORT_RECEIPT_INVALID",
                    "Stored export receipt is incomplete.",
                )
            })?)
            .map_err(vfs_error)?;
        Some(artifact)
    } else {
        None
    };
    tx.commit().map_err(vfs_error)?;
    Ok(result)
}

fn commit_prepared_source_pages(
    db: &VfsDatabase,
    source_resource_id: &str,
    expected_source_hash: &str,
    conversion_revision: &str,
    pages: &[InkStagedPage],
    operation_id: &str,
) -> Result<InkManifest, InkJobError> {
    commit_prepared_source_pages_inner(
        db,
        source_resource_id,
        expected_source_hash,
        conversion_revision,
        pages,
        operation_id,
        None,
    )
}

fn commit_prepared_source_pages_inner(
    db: &VfsDatabase,
    source_resource_id: &str,
    expected_source_hash: &str,
    conversion_revision: &str,
    pages: &[InkStagedPage],
    operation_id: &str,
    cancellation: Option<&CancellationToken>,
) -> Result<InkManifest, InkJobError> {
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        for page in pages {
            crate::staged_upload::abort(&page.staged_upload_id);
        }
        return Err(job_error(
            "CANCELLED",
            "Ink preparation was cancelled before staged-page persistence.",
        ));
    }
    if !(1..=500).contains(&pages.len())
        || conversion_revision.trim().is_empty()
        || conversion_revision.len() > 128
    {
        for page in pages {
            crate::staged_upload::abort(&page.staged_upload_id);
        }
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Prepared source metadata is invalid.",
        ));
    }
    let mut saga = UploadSaga::new();
    let result = (|| {
        let (actual_hash, kind, _, _, _) = load_source_bytes(db, source_resource_id)?;
        if actual_hash != expected_source_hash {
            return Err(source_changed("Source hash changed before preparation."));
        }
        if let Some(manifest) = reusable_prepared_manifest(
            db,
            source_resource_id,
            expected_source_hash,
            conversion_revision,
        )? {
            for page in pages {
                crate::staged_upload::abort(&page.staged_upload_id);
            }
            return Ok(manifest);
        }
        let mut prepared_pages = Vec::with_capacity(pages.len());
        for (index, page) in pages.iter().enumerate() {
            if cancellation.is_some_and(CancellationToken::is_cancelled) {
                return Err(job_error(
                    "CANCELLED",
                    "Ink preparation was cancelled while persisting staged pages.",
                ));
            }
            let staged = crate::staged_upload::take_staged_upload(&page.staged_upload_id)
                .map_err(|error| job_error("INVALID_STAGED_UPLOAD", error))?;
            let bytes = staged
                .read_bounded(SOURCE_PAGE_MAX_BYTES)
                .map_err(|error| job_error("LIMIT_EXCEEDED", error))?;
            validate_png_page(&bytes, page.width_px, page.height_px)?;
            if kind == "pdf" && page.source_page_index != Some(index as u32) {
                return Err(job_error(
                    "INVALID_ARGUMENT",
                    "PDF source page indices must be zero-based and ordered.",
                ));
            }
            if kind != "pdf" && page.source_page_index.is_some() {
                return Err(job_error(
                    "INVALID_ARGUMENT",
                    "Only PDF pages may include a source page index.",
                ));
            }
            let conn = db.get_conn_safe().map_err(vfs_error)?;
            let blob = VfsBlobRepo::store_blob_with_conn(
                &conn,
                db.blobs_dir(),
                &bytes,
                Some("image/png"),
                Some("png"),
            )
            .map_err(vfs_error)?;
            saga.record_blob_ref(&blob.hash);
            prepared_pages.push(InkPreparedPage {
                width: f64::from(page.width_px),
                height: f64::from(page.height_px),
                background_blob_hash: blob.hash,
                source_page_index: page.source_page_index,
            });
        }
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(job_error(
                "CANCELLED",
                "Ink preparation was cancelled before manifest commit.",
            ));
        }
        let (current_hash, current_kind, _, _, _) = load_source_bytes(db, source_resource_id)?;
        if current_hash != expected_source_hash || current_kind != kind {
            return Err(source_changed(
                "Source changed while page conversion was running.",
            ));
        }
        let conn = db.get_conn_safe().map_err(vfs_error)?;
        let manifest = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            source_resource_id,
            expected_source_hash,
            conversion_revision,
            &prepared_pages,
            operation_id,
            None,
        )
        .map_err(vfs_error)?;
        // The repository commits its own atomic manifest savepoint; these are only
        // this job's temporary staging refs, distinct from the manifest-owned refs.
        saga.abort(&conn, db.blobs_dir());
        Ok(manifest)
    })();
    match result {
        Ok(manifest) => {
            saga.commit();
            Ok(manifest)
        }
        Err(error) => {
            if let Ok(conn) = db.get_conn_safe() {
                saga.abort(&conn, db.blobs_dir());
            }
            for page in pages {
                crate::staged_upload::abort(&page.staged_upload_id);
            }
            Err(error)
        }
    }
}

fn validate_png_page(bytes: &[u8], width: u32, height: u32) -> Result<(), InkJobError> {
    use image::{codecs::png::PngDecoder, io::Limits, ImageDecoder};
    if bytes.is_empty()
        || bytes.len() as u64 > SOURCE_PAGE_MAX_BYTES
        || width == 0
        || height == 0
        || width > SOURCE_PAGE_MAX_EDGE
        || height > SOURCE_PAGE_MAX_EDGE
        || u64::from(width) * u64::from(height) > SOURCE_PAGE_MAX_PIXELS
    {
        return Err(job_error(
            "LIMIT_EXCEEDED",
            "Prepared PNG dimensions or byte size exceed the source limits.",
        ));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(SOURCE_PAGE_MAX_EDGE);
    limits.max_image_height = Some(SOURCE_PAGE_MAX_EDGE);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let mut decoder = PngDecoder::with_limits(Cursor::new(bytes), limits)
        .map_err(|_| job_error("INVALID_STAGED_UPLOAD", "Prepared page is not a valid PNG."))?;
    let dimensions = decoder.dimensions();
    let decoded_len = usize::try_from(decoder.total_bytes()).map_err(vfs_error)?;
    if dimensions != (width, height) || decoded_len > 64 * 1024 * 1024 {
        return Err(job_error(
            "INVALID_STAGED_UPLOAD",
            "Prepared PNG dimensions do not match staged metadata.",
        ));
    }
    let mut decoded = vec![0; decoded_len];
    decoder.read_image(&mut decoded).map_err(|_| {
        job_error(
            "INVALID_STAGED_UPLOAD",
            "Prepared PNG pixels could not be decoded.",
        )
    })?;
    Ok(())
}

fn commit_ink_export_cancellable(
    db: &VfsDatabase,
    document_id: &str,
    expected_revision: &str,
    page_ids: &[String],
    format: InkExportFormat,
    operation_id: &str,
    staged_upload_id: &str,
    expected_snapshot: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<InkExportArtifact, InkJobError> {
    if cancellation.is_cancelled() {
        crate::staged_upload::abort(staged_upload_id);
        return Err(job_error(
            "CANCELLED",
            "Ink export was cancelled before the blocking commit.",
        ));
    }
    commit_ink_export_with_snapshot_inner(
        db,
        document_id,
        expected_revision,
        page_ids,
        format,
        operation_id,
        staged_upload_id,
        expected_snapshot,
        None,
    )
}

fn commit_ink_board_export_cancellable(
    db: &VfsDatabase,
    document_id: &str,
    expected_revision: &str,
    page_ids: &[String],
    format: InkExportFormat,
    operation_id: &str,
    staged_upload_id: &str,
    expected_snapshot: Option<&str>,
    cancellation: &CancellationToken,
    board: &InkExportBoardRequest,
) -> Result<InkExportArtifact, InkJobError> {
    if cancellation.is_cancelled() {
        crate::staged_upload::abort(staged_upload_id);
        return Err(job_error(
            "CANCELLED",
            "Ink export was cancelled before the blocking commit.",
        ));
    }
    if let Err(error) = validate_board_export_request(board, format, page_ids) {
        crate::staged_upload::abort(staged_upload_id);
        return Err(error);
    }
    commit_ink_export_with_snapshot_inner(
        db,
        document_id,
        expected_revision,
        page_ids,
        format,
        operation_id,
        staged_upload_id,
        expected_snapshot,
        Some(board),
    )
}

fn commit_ink_export(
    db: &VfsDatabase,
    document_id: &str,
    expected_revision: &str,
    page_ids: &[String],
    format: InkExportFormat,
    operation_id: &str,
    staged_upload_id: &str,
) -> Result<InkExportArtifact, InkJobError> {
    commit_ink_export_with_snapshot(
        db,
        document_id,
        expected_revision,
        page_ids,
        format,
        operation_id,
        staged_upload_id,
        None,
    )
}

fn export_input_hash(
    document_id: &str,
    expected_revision: &str,
    page_ids: &[String],
    format: InkExportFormat,
    operation_id: &str,
    board: Option<&InkExportBoardRequest>,
) -> Result<String, InkJobError> {
    let bytes = if let Some(board) = board {
        serde_json::to_vec(&(
            document_id,
            expected_revision,
            page_ids,
            format,
            operation_id,
            board,
        ))
    } else {
        serde_json::to_vec(&(
            document_id,
            expected_revision,
            page_ids,
            format,
            operation_id,
        ))
    }
    .map_err(vfs_error)?;
    Ok(sha256_hex(&bytes))
}

fn commit_ink_export_with_snapshot(
    db: &VfsDatabase,
    document_id: &str,
    expected_revision: &str,
    page_ids: &[String],
    format: InkExportFormat,
    operation_id: &str,
    staged_upload_id: &str,
    expected_snapshot: Option<&str>,
) -> Result<InkExportArtifact, InkJobError> {
    commit_ink_export_with_snapshot_inner(
        db,
        document_id,
        expected_revision,
        page_ids,
        format,
        operation_id,
        staged_upload_id,
        expected_snapshot,
        None,
    )
}

fn commit_ink_export_with_snapshot_inner(
    db: &VfsDatabase,
    document_id: &str,
    expected_revision: &str,
    page_ids: &[String],
    format: InkExportFormat,
    operation_id: &str,
    staged_upload_id: &str,
    expected_snapshot: Option<&str>,
    board: Option<&InkExportBoardRequest>,
) -> Result<InkExportArtifact, InkJobError> {
    if document_id.trim().is_empty()
        || expected_revision.trim().is_empty()
        || operation_id.trim().is_empty()
        || operation_id.len() > 128
        || page_ids.is_empty()
        || page_ids.len() > 500
        || (format == InkExportFormat::Png && page_ids.len() != 1)
    {
        crate::staged_upload::abort(staged_upload_id);
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Ink export identity or page selection is invalid.",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    if page_ids
        .iter()
        .any(|id| id.trim().is_empty() || !seen.insert(id))
    {
        crate::staged_upload::abort(staged_upload_id);
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Export page IDs must be ordered and unique.",
        ));
    }
    let staged = crate::staged_upload::take_staged_upload(staged_upload_id)
        .map_err(|error| job_error("INVALID_STAGED_UPLOAD", error))?;
    let max_bytes = match format {
        InkExportFormat::Png => EXPORT_PNG_MAX_BYTES,
        InkExportFormat::Pdf => EXPORT_PDF_MAX_BYTES,
    };
    let bytes = staged
        .read_bounded(max_bytes)
        .map_err(|error| job_error("LIMIT_EXCEEDED", error))?;
    let (mime_type, extension, file_type) = match format {
        InkExportFormat::Png => {
            let (width, height) = validate_png_export(&bytes)?;
            if width > 4096
                || height > 4096
                || u64::from(width) * u64::from(height) > SOURCE_PAGE_MAX_PIXELS
            {
                return Err(job_error(
                    "LIMIT_EXCEEDED",
                    "Export PNG dimensions exceed limits.",
                ));
            }
            ("image/png", "png", "image")
        }
        InkExportFormat::Pdf => {
            if !bytes.starts_with(b"%PDF-") || bytes.len() as u64 > EXPORT_PDF_MAX_BYTES {
                return Err(job_error(
                    "INVALID_STAGED_UPLOAD",
                    "Export bytes are not a bounded PDF.",
                ));
            }
            ("application/pdf", "pdf", "document")
        }
    };
    if let Some(expected) = expected_snapshot {
        let current = match board {
            Some(board) => vec![load_board_export_inputs(
                db,
                document_id,
                expected_revision,
                page_ids,
                board,
            )?],
            None => load_export_inputs(db, document_id, expected_revision, page_ids)?,
        };
        if frozen_snapshot_hash(&current)? != expected {
            return Err(job_error(
                "REVISION_CONFLICT",
                "Ink pages, source annotations, or frozen backgrounds changed during export.",
            ));
        }
    }
    let manifest = {
        let conn = db.get_conn_safe().map_err(vfs_error)?;
        VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), document_id).map_err(vfs_error)?
    };
    let selection_matches = if board.is_some() {
        manifest.schema_version == INK_BOARD_SCHEMA_VERSION
            && page_ids.len() == 1
            && matches!(
                manifest.surface.as_ref(),
                Some(InkBoardSurface::Board { page_id, .. }) if page_id == &page_ids[0]
            )
    } else {
        page_ids
            .iter()
            .all(|id| manifest.pages.iter().any(|page| &page.page_id == id))
    };
    if manifest.revision != expected_revision || !selection_matches {
        return Err(job_error(
            "REVISION_CONFLICT",
            "Ink document revision or selected pages changed before export.",
        ));
    }
    let (source_hash, conversion_revision) = match &manifest.source {
        InkSource::Blank {} => (None, None),
        InkSource::Resource {
            source_hash,
            conversion_revision,
            ..
        } => (Some(source_hash.clone()), Some(conversion_revision.clone())),
    };
    let input_hash = export_input_hash(
        document_id,
        expected_revision,
        page_ids,
        format,
        operation_id,
        board,
    )?;
    let receipt_id = format!("ink-export-{}", input_hash);
    let content_hash = VfsBlobRepo::compute_hash(&bytes);
    let mut conn = db.get_conn_safe().map_err(vfs_error)?;
    let stored_blob = VfsBlobRepo::store_blob_with_conn(
        &conn,
        db.blobs_dir(),
        &bytes,
        Some(mime_type),
        Some(extension),
    )
    .map_err(vfs_error)?;
    if stored_blob.hash != content_hash {
        return Err(job_error(
            "HASH_MISMATCH",
            "VFS stored a different export hash.",
        ));
    }
    let mut saga = UploadSaga::new();
    saga.record_blob_ref(&content_hash);
    let result = (|| {
        let tx = conn.transaction().map_err(vfs_error)?;
        let file = VfsFileRepo::get_file_with_conn(&tx, document_id)
            .map_err(vfs_error)?
            .ok_or_else(|| job_error("RESOURCE_NOT_FOUND", "Ink document file is missing."))?;
        let document_resource_id = file
            .resource_id
            .clone()
            .ok_or_else(|| job_error("RESOURCE_NOT_FOUND", "Ink document resource is missing."))?;
        tx.execute(
            "UPDATE resources SET hash = hash WHERE id = ?1",
            [&document_resource_id],
        )
        .map_err(vfs_error)?;
        let current_manifest = VfsInkRepo::get_manifest_with_conn(&tx, db.blobs_dir(), document_id)
            .map_err(vfs_error)?;
        if current_manifest.revision != expected_revision {
            return Err(job_error(
                "REVISION_CONFLICT",
                "Ink document changed before export commit.",
            ));
        }
        if let Some(expected_snapshot) = expected_snapshot {
            let current_snapshot = frozen_snapshot_hash_with_conn(
                &tx,
                db.blobs_dir(),
                document_id,
                expected_revision,
                page_ids,
                board,
            )?;
            if current_snapshot != expected_snapshot {
                return Err(job_error(
                    "REVISION_CONFLICT",
                    "Ink pages, source annotations, or frozen backgrounds changed during export.",
                ));
            }
        }
        let raw: Option<String> = tx
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&document_resource_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(vfs_error)?
            .flatten();
        let mut metadata: Value = raw
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(vfs_error)?
            .unwrap_or_else(|| json!({}));
        let mut receipts = metadata
            .get("ink_export_receipts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(existing) = receipts.iter().find(|receipt| {
            receipt.get("operation_id").and_then(Value::as_str) == Some(operation_id)
        }) {
            if existing.get("input_hash").and_then(Value::as_str) != Some(input_hash.as_str()) {
                return Err(job_error(
                    "OPERATION_CONFLICT",
                    "This export operation ID is already bound to different input.",
                ));
            }
            let artifact: InkExportArtifact =
                serde_json::from_value(existing.get("artifact").cloned().ok_or_else(|| {
                    job_error(
                        "EXPORT_RECEIPT_INVALID",
                        "Stored export receipt is incomplete.",
                    )
                })?)
                .map_err(vfs_error)?;
            tx.rollback().map_err(vfs_error)?;
            VfsBlobRepo::decrement_ref_with_conn(&conn, db.blobs_dir(), &content_hash)
                .map_err(vfs_error)?;
            saga.commit();
            return Ok(artifact);
        }
        let existing_file =
            VfsFileRepo::get_by_sha256_with_conn(&tx, &content_hash).map_err(vfs_error)?;
        if let Some(existing) = existing_file.as_ref() {
            if existing.file_type != file_type
                || existing.mime_type.as_deref() != Some(mime_type)
                || existing.blob_hash.as_deref() != Some(content_hash.as_str())
            {
                return Err(job_error(
                    "CONTENT_HASH_CONFLICT",
                    "An existing VFS file has incompatible metadata for these bytes.",
                ));
            }
        }
        let output_file = VfsFileRepo::create_file_with_conn(
            &tx,
            &content_hash,
            &format!("ink-export.{}", extension),
            bytes.len() as i64,
            file_type,
            Some(mime_type),
            Some(&content_hash),
            None,
        )
        .map_err(vfs_error)?;
        let resource_id = output_file
            .resource_id
            .clone()
            .ok_or_else(|| job_error("VFS_ERROR", "Export VFS file has no resource."))?;
        if existing_file.is_some() {
            VfsBlobRepo::decrement_ref_with_conn(&tx, db.blobs_dir(), &content_hash)
                .map_err(vfs_error)?;
        }
        let artifact = InkExportArtifact {
            artifact_id: receipt_id.clone(),
            document_id: document_id.to_owned(),
            revision: expected_revision.to_owned(),
            page_ids: page_ids.to_vec(),
            format,
            operation_id: operation_id.to_owned(),
            source_hash: source_hash.clone(),
            conversion_revision: conversion_revision.clone(),
            mime_type: mime_type.to_owned(),
            file_id: output_file.id.clone(),
            resource_id: resource_id.clone(),
            blob_hash: content_hash.clone(),
            content_hash: content_hash.clone(),
            open_locator: format!("vfs://{}", resource_id),
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        if receipts.len() >= 1000 {
            return Err(job_error(
                "LIMIT_EXCEEDED",
                "This Ink document has reached its bounded export receipt limit.",
            ));
        }
        receipts.push(json!({"receipt_id": receipt_id, "operation_id": operation_id, "input_hash": input_hash, "artifact": artifact}));
        metadata["ink_export_receipts"] = Value::Array(receipts);
        tx.execute(
            "UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&metadata).map_err(vfs_error)?,
                chrono::Utc::now().timestamp_millis(),
                document_resource_id
            ],
        )
        .map_err(vfs_error)?;
        let mut output_metadata: Value = tx
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(vfs_error)?
            .flatten()
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(vfs_error)?
            .unwrap_or_else(|| json!({}));
        let mut exports = output_metadata
            .get("ink_exports")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !exports.iter().any(|entry| {
            entry.get("artifact_id").and_then(Value::as_str) == Some(receipt_id.as_str())
        }) {
            exports.push(json!({"artifact_id": receipt_id, "document_id": document_id, "revision": expected_revision, "page_ids": page_ids, "format": format, "operation_id": operation_id}));
        }
        output_metadata["ink_exports"] = Value::Array(exports);
        tx.execute(
            "UPDATE resources SET metadata_json = ?1 WHERE id = ?2",
            params![
                serde_json::to_string(&output_metadata).map_err(vfs_error)?,
                resource_id
            ],
        )
        .map_err(vfs_error)?;
        tx.commit().map_err(vfs_error)?;
        Ok(artifact)
    })();
    match result {
        Ok(artifact) => {
            saga.commit();
            Ok(artifact)
        }
        Err(error) => {
            saga.abort(&conn, db.blobs_dir());
            Err(error)
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn validate_png_export(bytes: &[u8]) -> Result<(u32, u32), InkJobError> {
    use image::{codecs::png::PngDecoder, io::Limits, ImageDecoder};
    if bytes.is_empty() || bytes.len() as u64 > EXPORT_PNG_MAX_BYTES {
        return Err(job_error(
            "LIMIT_EXCEEDED",
            "Export PNG exceeds size limits.",
        ));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let mut decoder = PngDecoder::with_limits(Cursor::new(bytes), limits)
        .map_err(|_| job_error("INVALID_STAGED_UPLOAD", "Export is not a valid PNG."))?;
    let (width, height) = decoder.dimensions();
    let decoded_len = usize::try_from(decoder.total_bytes()).map_err(vfs_error)?;
    if u64::from(width) * u64::from(height) > SOURCE_PAGE_MAX_PIXELS
        || decoded_len > 64 * 1024 * 1024
    {
        return Err(job_error(
            "LIMIT_EXCEEDED",
            "Export PNG decoded dimensions exceed limits.",
        ));
    }
    let mut decoded = vec![0; decoded_len];
    decoder.read_image(&mut decoded).map_err(|_| {
        job_error(
            "INVALID_STAGED_UPLOAD",
            "Export PNG pixels could not be decoded.",
        )
    })?;
    Ok((width, height))
}

const JOB_TIMEOUT: Duration = Duration::from_secs(180);
const JOB_EVENT: &str = "ink:job-request";

fn configured_main_label(app: &AppHandle) -> Option<&str> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .map(|window| window.label.as_str())
}

fn job_bus_error(error: InkJobBusError) -> InkJobError {
    match error {
        InkJobBusError::InvalidIdentity | InkJobBusError::IdentityMismatch => {
            job_error("INVALID_ARGUMENT", "Ink job response identity is invalid.")
        }
        InkJobBusError::DuplicateRequest => job_error(
            "DUPLICATE_REQUEST",
            "Ink job request ID is already pending.",
        ),
        InkJobBusError::ForeignWebview => job_error(
            "UNTRUSTED_WEBVIEW",
            "Only the configured main webview may answer an Ink job.",
        ),
        InkJobBusError::NotPending => {
            job_error("STALE_RESPONSE", "Ink job request is no longer pending.")
        }
        InkJobBusError::Cancelled => job_error("CANCELLED", "Ink job was cancelled."),
        InkJobBusError::Timeout => job_error(
            "JOB_TIMEOUT",
            "The main webview did not finish the Ink job before timeout.",
        ),
        InkJobBusError::JobFailed(error) => error,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkPrepareCommandRequest {
    pub source_resource_id: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkExportBoardRequest {
    /// Explicit absolute world rectangle. Board export never falls back to
    /// `surface.bounds`.
    pub region: InkRect,
    /// Logical world tile/page width.
    pub page_width: f64,
    /// Logical world tile/page height.
    pub page_height: f64,
    /// PDF only: tile `region` into row-major pages. PNG is always one frame.
    #[serde(default)]
    pub paginate: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkExportCommandRequest {
    pub document_id: String,
    pub expected_revision: String,
    pub page_ids: Vec<String>,
    pub format: InkExportFormat,
    pub operation_id: String,
    #[serde(default)]
    pub board: Option<InkExportBoardRequest>,
}

fn prepare_profile(kind: &str) -> Result<(String, String), InkJobError> {
    let (converter, profile) = match kind {
        "pdf" => ("pdfjs-dist@5.4.296;png-pages-v1;max-edge-2048", "ink-pdf-pages-v1"),
        "image" => ("browser-imagebitmap-v1;png-pages-v1;max-edge-2048", "ink-image-pages-v1"),
        "docx" | "pptx" => ("docx-preview@0.3.7+pptx-preview@1.0.7+@zumer/snapdom@2.0.2;pages-v1;white-paper;embed-fonts;max-edge-2048", "ink-office-pages-v1"),
        _ => return Err(job_error("UNSUPPORTED_FORMAT", "Source format cannot be prepared as Ink.")),
    };
    Ok((
        converter.to_owned(),
        format!("{}-{}", profile, sha256_hex(converter.as_bytes())),
    ))
}

fn frozen_snapshot_hash(
    inputs: &[crate::ink_bridge::FrozenRenderInputs],
) -> Result<String, InkJobError> {
    // Keep the v1 paged hash byte-for-byte stable. Board inputs opt into an
    // extended identity that includes the real crop and chunk snapshot.
    let has_board = inputs.iter().any(|input| input.board.is_some());
    let bytes = if has_board {
        serde_json::to_vec(
            &inputs
                .iter()
                .map(|input| {
                    let board = input.board.as_ref().map(|board| {
                        (&board.surface, board.crop, &board.chunk_refs, &board.chunks)
                    });
                    (
                        &input.manifest.document_id,
                        &input.manifest.revision,
                        board,
                        &input.highlights,
                        &input.source_annotation_revision,
                        &input.source_hash,
                        &input.conversion_revision,
                    )
                })
                .collect::<Vec<_>>(),
        )
    } else {
        serde_json::to_vec(
            &inputs
                .iter()
                .map(|input| {
                    (
                        &input.manifest.document_id,
                        &input.manifest.revision,
                        &input.page_ref,
                        &input.page,
                        &input.highlights,
                        &input.source_annotation_revision,
                        &input.source_hash,
                        &input.conversion_revision,
                    )
                })
                .collect::<Vec<_>>(),
        )
    }
    .map_err(vfs_error)?;
    Ok(sha256_hex(&bytes))
}

fn frozen_snapshot_hash_with_conn(
    conn: &rusqlite::Connection,
    blobs_dir: &Path,
    document_id: &str,
    revision: &str,
    page_ids: &[String],
    board: Option<&InkExportBoardRequest>,
) -> Result<String, InkJobError> {
    if let Some(board) = board {
        if page_ids.len() != 1 {
            return Err(job_error(
                "INVALID_ARGUMENT",
                "Board export requires exactly one surface page ID.",
            ));
        }
        let spec = crate::ink_bridge::InkRenderSpec {
            document_id: document_id.to_owned(),
            expected_revision: revision.to_owned(),
            page_id: page_ids[0].clone(),
            crop: None,
            board: Some(crate::ink_bridge::InkBoardRenderSpec {
                crop: board.region,
                chunk_ids: Vec::new(),
            }),
            long_edge: None,
        };
        let input = crate::ink_bridge::load_frozen_inputs_with_conn(conn, blobs_dir, &spec)
            .map_err(|error| job_error(&error.code, error.message))?;
        return frozen_snapshot_hash(&[input]);
    }
    let mut inputs = Vec::with_capacity(page_ids.len());
    for page_id in page_ids {
        let spec = crate::ink_bridge::InkRenderSpec {
            document_id: document_id.to_owned(),
            expected_revision: revision.to_owned(),
            page_id: page_id.clone(),
            crop: None,
            board: None,
            long_edge: None,
        };
        let input = crate::ink_bridge::load_frozen_inputs_with_conn(conn, blobs_dir, &spec)
            .map_err(|error| job_error(&error.code, error.message))?;
        inputs.push(input);
    }
    frozen_snapshot_hash(&inputs)
}

fn load_export_inputs(
    db: &VfsDatabase,
    document_id: &str,
    revision: &str,
    page_ids: &[String],
) -> Result<Vec<crate::ink_bridge::FrozenRenderInputs>, InkJobError> {
    if page_ids.is_empty() || page_ids.len() > 500 || (page_ids.len() != 1 && page_ids.len() > 500)
    {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Export requires one to 500 pages.",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    if page_ids
        .iter()
        .any(|id| id.trim().is_empty() || !seen.insert(id))
    {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Export page IDs must be nonempty and unique.",
        ));
    }
    {
        let conn = db.get_conn_safe().map_err(vfs_error)?;
        let manifest = VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), document_id)
            .map_err(vfs_error)?;
        if manifest.schema_version == INK_BOARD_SCHEMA_VERSION {
            return Err(job_error(
                "INVALID_ARGUMENT",
                "Board export requires an explicit region.",
            ));
        }
    }
    let mut inputs = Vec::with_capacity(page_ids.len());
    for page_id in page_ids {
        let spec = crate::ink_bridge::InkRenderSpec {
            document_id: document_id.to_owned(),
            expected_revision: revision.to_owned(),
            page_id: page_id.clone(),
            crop: None,
            board: None,
            long_edge: None,
        };
        inputs.push(
            crate::ink_bridge::load_frozen_inputs(db, &spec)
                .map_err(|error| job_error(error.code.as_str(), error.message))?,
        );
    }
    Ok(inputs)
}

/// Planned pure geometry for exporting an explicit v2 board region.
///
/// - `paginate == false` returns exactly one frame covering `region`.
/// - `paginate == true` returns tiles in row-major order: left-to-right, then
///   top-to-bottom, clipped to `region`.
/// - More than 500 tiles is a typed `LIMIT_EXCEEDED` failure.
fn board_export_grid(
    region: InkRect,
    page_width: f64,
    page_height: f64,
    paginate: bool,
) -> Result<Vec<InkRect>, InkJobError> {
    validate_board_region(region)?;
    validate_board_tile(page_width, page_height)?;
    if !paginate {
        return Ok(vec![region]);
    }
    validate_board_tile_budget(page_width, page_height)?;
    let columns = (region.width / page_width).ceil();
    let rows = (region.height / page_height).ceil();
    if !columns.is_finite() || !rows.is_finite() || columns < 1.0 || rows < 1.0 {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Board export page geometry is invalid.",
        ));
    }
    if columns > INK_PAGES_MAX as f64 || rows > INK_PAGES_MAX as f64 {
        return Err(job_error(
            "LIMIT_EXCEEDED",
            "Board export exceeds the 500-page limit.",
        ));
    }
    let columns = columns as usize;
    let rows = rows as usize;
    let page_count = columns
        .checked_mul(rows)
        .ok_or_else(|| job_error("LIMIT_EXCEEDED", "Board export exceeds the 500-page limit."))?;
    if page_count > INK_PAGES_MAX {
        return Err(job_error(
            "LIMIT_EXCEEDED",
            "Board export exceeds the 500-page limit.",
        ));
    }
    let mut pages = Vec::with_capacity(page_count);
    for row in 0..rows {
        let y = region.y + row as f64 * page_height;
        let height = (region.y + region.height - y).min(page_height);
        for column in 0..columns {
            let x = region.x + column as f64 * page_width;
            let width = (region.x + region.width - x).min(page_width);
            if width <= 0.0 || height <= 0.0 {
                return Err(job_error(
                    "INVALID_ARGUMENT",
                    "Board export page geometry is invalid.",
                ));
            }
            pages.push(InkRect {
                x,
                y,
                width,
                height,
            });
        }
    }
    Ok(pages)
}

fn validate_board_region(region: InkRect) -> Result<(), InkJobError> {
    if !region.x.is_finite()
        || !region.y.is_finite()
        || !region.width.is_finite()
        || !region.height.is_finite()
        || region.width <= 0.0
        || region.height <= 0.0
        || region.x < -INK_BOARD_WORLD_LIMIT
        || region.y < -INK_BOARD_WORLD_LIMIT
        || region.x + region.width > INK_BOARD_WORLD_LIMIT
        || region.y + region.height > INK_BOARD_WORLD_LIMIT
    {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Board export region must be explicit, finite, positive, and inside the board world.",
        ));
    }
    Ok(())
}

fn validate_board_tile(page_width: f64, page_height: f64) -> Result<(), InkJobError> {
    if !page_width.is_finite()
        || !page_height.is_finite()
        || page_width <= 0.0
        || page_height <= 0.0
    {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Board export page size must be finite and positive.",
        ));
    }
    Ok(())
}

fn validate_board_tile_budget(page_width: f64, page_height: f64) -> Result<(), InkJobError> {
    if page_width > BOARD_EXPORT_MAX_EDGE
        || page_height > BOARD_EXPORT_MAX_EDGE
        || page_width * page_height > BOARD_EXPORT_MAX_PIXELS
    {
        return Err(job_error(
            "LIMIT_EXCEEDED",
            "Board export page size exceeds the raster budget.",
        ));
    }
    Ok(())
}

fn validate_board_export_request(
    board: &InkExportBoardRequest,
    format: InkExportFormat,
    page_ids: &[String],
) -> Result<(), InkJobError> {
    if page_ids.len() != 1 || page_ids[0].trim().is_empty() {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Board export requires exactly one surface page ID.",
        ));
    }
    if format == InkExportFormat::Png && board.paginate {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "PNG board export is a single frame and cannot paginate.",
        ));
    }
    validate_board_region(board.region)?;
    validate_board_tile(board.page_width, board.page_height)?;
    if !board.paginate {
        if board.region.width > BOARD_EXPORT_MAX_EDGE
            || board.region.height > BOARD_EXPORT_MAX_EDGE
            || board.region.width * board.region.height > BOARD_EXPORT_MAX_PIXELS
        {
            return Err(job_error(
                "LIMIT_EXCEEDED",
                "Board export frame exceeds the raster budget.",
            ));
        }
    } else {
        board_export_grid(board.region, board.page_width, board.page_height, true)?;
    }
    Ok(())
}

fn load_board_export_inputs(
    db: &VfsDatabase,
    document_id: &str,
    revision: &str,
    page_ids: &[String],
    board: &InkExportBoardRequest,
) -> Result<crate::ink_bridge::FrozenRenderInputs, InkJobError> {
    if page_ids.len() != 1 {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Board export requires exactly one surface page ID.",
        ));
    }
    validate_board_region(board.region)?;
    let spec = crate::ink_bridge::InkRenderSpec {
        document_id: document_id.to_owned(),
        expected_revision: revision.to_owned(),
        page_id: page_ids[0].clone(),
        crop: None,
        board: Some(crate::ink_bridge::InkBoardRenderSpec {
            crop: board.region,
            chunk_ids: Vec::new(),
        }),
        long_edge: None,
    };
    let input = crate::ink_bridge::load_frozen_inputs(db, &spec)
        .map_err(|error| job_error(error.code.as_str(), error.message))?;
    if input.board.is_none() {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Board export requires a v2 board surface.",
        ));
    }
    Ok(input)
}

pub async fn prepare_source_ink(
    app: &AppHandle,
    db: Arc<VfsDatabase>,
    source_resource_id: &str,
    operation_id: &str,
    session_id: Option<&str>,
    tool_call_id: Option<&str>,
    cancellation: Option<CancellationToken>,
) -> Result<InkManifest, InkJobError> {
    if source_resource_id.trim().is_empty()
        || operation_id.trim().is_empty()
        || operation_id.len() > 128
        || session_id.is_some() != tool_call_id.is_some()
    {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Ink prepare identity is invalid.",
        ));
    }
    let cancellation = cancellation.unwrap_or_default();
    if cancellation.is_cancelled() {
        return Err(job_error(
            "CANCELLED",
            "Ink preparation was cancelled before reading the source.",
        ));
    }
    let source_db = db.clone();
    let source_id = source_resource_id.to_owned();
    let (source_hash, format, file_name, mime_type, bytes) =
        tauri::async_runtime::spawn_blocking(move || load_source_bytes(&source_db, &source_id))
            .await
            .map_err(vfs_error)??;
    if cancellation.is_cancelled() {
        return Err(job_error(
            "CANCELLED",
            "Ink preparation was cancelled before page conversion.",
        ));
    }
    let (expected_converter_version, conversion_profile) = prepare_profile(&format)?;
    if let Some(manifest) =
        reusable_prepared_manifest(&db, source_resource_id, &source_hash, &conversion_profile)?
    {
        return Ok(manifest);
    }
    use base64::Engine as _;
    let payload = InkJobPayload::Prepare {
        source_resource_id: source_resource_id.to_owned(),
        source_hash: source_hash.clone(),
        file_name,
        mime_type,
        source_bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        converter_profile: conversion_profile.clone(),
        expected_converter_version,
    };
    if cancellation.is_cancelled() {
        return Err(job_error(
            "CANCELLED",
            "Ink preparation was cancelled before requesting page conversion.",
        ));
    }
    let (request, pending) = emit_job_request(
        app,
        &app.state::<PendingInkJobBus>().inner().clone(),
        operation_id,
        InkJobKind::Prepare,
        session_id,
        tool_call_id,
        payload,
    )?;
    let request_id = request.request_id.clone();
    let result = wait_for_ink_job(app, &request_id, pending, &cancellation).await?;
    let (pages, converter_version, warnings) = match result {
        InkJobResponseValue::Prepared {
            pages,
            converter_version,
            warnings,
        } => (pages, converter_version, warnings),
        _ => {
            return Err(job_error(
                "INVALID_RESPONSE",
                "Ink prepare received an export result.",
            ))
        }
    };
    if cancellation.is_cancelled() {
        for page in &pages {
            crate::staged_upload::abort(&page.staged_upload_id);
        }
        return Err(job_error(
            "CANCELLED",
            "Ink preparation was cancelled before VFS commit.",
        ));
    }
    if converter_version.trim().is_empty() || converter_version.len() > 4096 {
        for page in &pages {
            crate::staged_upload::abort(&page.staged_upload_id);
        }
        return Err(job_error(
            "INVALID_RESPONSE",
            "Converter version is invalid.",
        ));
    }
    let db_for_commit = db.clone();
    let source_id_for_commit = source_resource_id.to_owned();
    let source_hash_for_commit = source_hash.clone();
    let profile_for_commit = conversion_profile.clone();
    let op_for_commit = operation_id.to_owned();
    let pages_for_commit = pages.clone();
    let cancellation_for_commit = cancellation.clone();
    let manifest = tauri::async_runtime::spawn_blocking(move || {
        commit_prepared_source_pages_cancellable(
            &db_for_commit,
            &source_id_for_commit,
            &source_hash_for_commit,
            &profile_for_commit,
            &pages_for_commit,
            &op_for_commit,
            &cancellation_for_commit,
        )
    })
    .await
    .map_err(vfs_error)??;
    let warning_metadata = json!({ "converter_version": converter_version, "warnings": warnings });
    let db_for_metadata = db.clone();
    let source_id_for_metadata = source_resource_id.to_owned();
    let warning_write = tauri::async_runtime::spawn_blocking(move || {
        let conn = db_for_metadata.get_conn_safe().map_err(vfs_error)?;
        conn.execute("UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.ink_prepare_info', json(?1)) WHERE id = ?2", params![warning_metadata.to_string(), source_id_for_metadata]).map_err(vfs_error)?;
        Ok::<_, InkJobError>(())
    }).await;
    if !matches!(warning_write, Ok(Ok(()))) {
        tracing::warn!("Ink source was prepared but non-canonical converter warning metadata could not be recorded");
    }
    let _ = request_id;
    Ok(manifest)
}

async fn wait_for_ink_job(
    app: &AppHandle,
    request_id: &str,
    pending: PendingInkJob,
    cancellation: &CancellationToken,
) -> Result<InkJobResponseValue, InkJobError> {
    let main = app
        .get_webview_window("main")
        .filter(|window| configured_main_label(app) == Some(window.label()))
        .ok_or_else(|| job_error("JOB_UNAVAILABLE", "Configured main webview is unavailable."))?;
    let notify_request_id = request_id.to_owned();
    wait_pending_ink_job_with_timeout_notify(pending, JOB_TIMEOUT, cancellation, move || {
        let _ = main.emit("ink:job-cancel", json!({"request_id": notify_request_id}));
    })
    .await
}

fn emit_job_request(
    app: &AppHandle,
    bus: &PendingInkJobBus,
    operation_id: &str,
    kind: InkJobKind,
    session_id: Option<&str>,
    tool_call_id: Option<&str>,
    payload: InkJobPayload,
) -> Result<(InkJobRequest, PendingInkJob), InkJobError> {
    if session_id.is_some() != tool_call_id.is_some() {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Tool Ink jobs require session_id and tool_call_id together.",
        ));
    }
    let main = app
        .get_webview_window("main")
        .filter(|window| configured_main_label(app) == Some(window.label()))
        .ok_or_else(|| job_error("JOB_UNAVAILABLE", "Configured main webview is unavailable."))?;
    let identity = InkJobIdentity {
        request_id: uuid::Uuid::new_v4().to_string(),
        operation_id: operation_id.to_owned(),
        kind,
        session_id: session_id.map(str::to_owned),
        tool_call_id: tool_call_id.map(str::to_owned),
    };
    let pending = bus.register(identity.clone()).map_err(job_bus_error)?;
    let request = InkJobRequest {
        request_id: identity.request_id.clone(),
        operation_id: identity.operation_id.clone(),
        kind,
        session_id: identity.session_id.clone(),
        tool_call_id: identity.tool_call_id.clone(),
        payload,
    };
    if let Err(error) = main.emit(JOB_EVENT, request.clone()) {
        drop(pending);
        return Err(job_error("JOB_UNAVAILABLE", error.to_string()));
    }
    Ok((request, pending))
}

pub async fn export_ink_document(
    app: &AppHandle,
    db: Arc<VfsDatabase>,
    document_id: &str,
    expected_revision: &str,
    page_ids: &[String],
    format: InkExportFormat,
    operation_id: &str,
    session_id: Option<&str>,
    tool_call_id: Option<&str>,
    cancellation: Option<CancellationToken>,
    board: Option<InkExportBoardRequest>,
) -> Result<InkExportArtifact, InkJobError> {
    if session_id.is_some() != tool_call_id.is_some() {
        return Err(job_error(
            "INVALID_ARGUMENT",
            "Tool Ink jobs require session_id and tool_call_id together.",
        ));
    }
    if let Some(board) = board.as_ref() {
        validate_board_export_request(board, format, page_ids)?;
    }
    let cancellation = cancellation.unwrap_or_default();
    if cancellation.is_cancelled() {
        return Err(job_error(
            "CANCELLED",
            "Ink export was cancelled before editor flush.",
        ));
    }
    crate::ink_bridge::flush_ink_editor(app, document_id)
        .await
        .map_err(|error| job_error(error.code.as_str(), error.message))?;
    if cancellation.is_cancelled() {
        return Err(job_error(
            "CANCELLED",
            "Ink export was cancelled before snapshot.",
        ));
    }
    let db_for_receipt = db.clone();
    let document_for_receipt = document_id.to_owned();
    let revision_for_receipt = expected_revision.to_owned();
    let page_ids_for_receipt = page_ids.to_vec();
    let operation_for_receipt = operation_id.to_owned();
    let board_for_receipt = board.clone();
    if let Some(artifact) = tauri::async_runtime::spawn_blocking(move || {
        load_export_receipt_for_retry(
            &db_for_receipt,
            &document_for_receipt,
            &revision_for_receipt,
            &page_ids_for_receipt,
            format,
            &operation_for_receipt,
            board_for_receipt.as_ref(),
        )
    })
    .await
    .map_err(vfs_error)??
    {
        return Ok(artifact);
    }
    if cancellation.is_cancelled() {
        return Err(job_error(
            "CANCELLED",
            "Ink export was cancelled before snapshot.",
        ));
    }
    let db_for_snapshot = db.clone();
    let document_for_snapshot = document_id.to_owned();
    let revision_for_snapshot = expected_revision.to_owned();
    let page_ids_for_snapshot = page_ids.to_vec();
    let board_for_snapshot = board.clone();
    let before = tauri::async_runtime::spawn_blocking(move || match board_for_snapshot.as_ref() {
        Some(board) => Ok(vec![load_board_export_inputs(
            &db_for_snapshot,
            &document_for_snapshot,
            &revision_for_snapshot,
            &page_ids_for_snapshot,
            board,
        )?]),
        None => load_export_inputs(
            &db_for_snapshot,
            &document_for_snapshot,
            &revision_for_snapshot,
            &page_ids_for_snapshot,
        ),
    })
    .await
    .map_err(vfs_error)??;
    let snapshot = frozen_snapshot_hash(&before)?;
    let (pages, board_payload) = if let Some(board) = board.as_ref() {
        let input = before.first().ok_or_else(|| {
            job_error(
                "RENDER_UNAVAILABLE",
                "Frozen board export input is missing.",
            )
        })?;
        let frozen = input.board.as_ref().ok_or_else(|| {
            job_error(
                "RENDER_UNAVAILABLE",
                "Ink export only supports v2 board inputs with an explicit region.",
            )
        })?;
        let pages = board_export_grid(
            board.region,
            board.page_width,
            board.page_height,
            board.paginate,
        )?;
        (
            Vec::new(),
            Some(InkExportBoardPayload {
                surface: frozen.surface.clone(),
                region: board.region,
                page_width: board.page_width,
                page_height: board.page_height,
                paginate: board.paginate,
                pages,
                chunks: frozen.chunks.clone(),
            }),
        )
    } else {
        let pages = before
            .iter()
            .map(|input| -> Result<InkExportPageRequest, InkJobError> {
                Ok(InkExportPageRequest {
                    page_ref: input.page_ref.clone().ok_or_else(|| {
                        job_error(
                            "RENDER_UNAVAILABLE",
                            "Ink export only supports paged v1 inputs.",
                        )
                    })?,
                    page: input.page.clone().ok_or_else(|| {
                        job_error(
                            "RENDER_UNAVAILABLE",
                            "Ink export only supports paged v1 inputs.",
                        )
                    })?,
                    highlights: input.highlights.clone(),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        (pages, None)
    };
    let payload = InkJobPayload::Export {
        document_id: document_id.to_owned(),
        revision: expected_revision.to_owned(),
        page_ids: page_ids.to_vec(),
        format,
        pages,
        board: board_payload,
    };
    if cancellation.is_cancelled() {
        return Err(job_error(
            "CANCELLED",
            "Ink export was cancelled before rendering.",
        ));
    }
    let bus = app.state::<PendingInkJobBus>().inner().clone();
    let (request, pending) = emit_job_request(
        app,
        &bus,
        operation_id,
        InkJobKind::Export,
        session_id,
        tool_call_id,
        payload,
    )?;
    let response = wait_for_ink_job(app, &request.request_id, pending, &cancellation).await?;
    let staged_upload_id = match response {
        InkJobResponseValue::Exported { staged_upload_id } => staged_upload_id,
        _ => {
            return Err(job_error(
                "INVALID_RESPONSE",
                "Ink export received a prepare result.",
            ))
        }
    };
    if cancellation.is_cancelled() {
        crate::staged_upload::abort(&staged_upload_id);
        return Err(job_error(
            "CANCELLED",
            "Ink export was cancelled before commit.",
        ));
    }
    let db_for_check = db.clone();
    let document_for_check = document_id.to_owned();
    let revision_for_check = expected_revision.to_owned();
    let pages_for_check = page_ids.to_vec();
    let board_for_check = board.clone();
    let after = match tauri::async_runtime::spawn_blocking(move || match board_for_check.as_ref() {
        Some(board) => Ok(vec![load_board_export_inputs(
            &db_for_check,
            &document_for_check,
            &revision_for_check,
            &pages_for_check,
            board,
        )?]),
        None => load_export_inputs(
            &db_for_check,
            &document_for_check,
            &revision_for_check,
            &pages_for_check,
        ),
    })
    .await
    {
        Ok(Ok(inputs)) => inputs,
        Ok(Err(error)) => {
            crate::staged_upload::abort(&staged_upload_id);
            return Err(error);
        }
        Err(error) => {
            crate::staged_upload::abort(&staged_upload_id);
            return Err(vfs_error(error));
        }
    };
    if frozen_snapshot_hash(&after)? != snapshot {
        crate::staged_upload::abort(&staged_upload_id);
        return Err(job_error(
            "REVISION_CONFLICT",
            "Ink pages, source annotations, or frozen backgrounds changed during export.",
        ));
    }
    if cancellation.is_cancelled() {
        crate::staged_upload::abort(&staged_upload_id);
        return Err(job_error(
            "CANCELLED",
            "Ink export was cancelled before VFS persistence.",
        ));
    }
    let db_for_commit = db.clone();
    let document_for_commit = document_id.to_owned();
    let revision_for_commit = expected_revision.to_owned();
    let page_ids_for_commit = page_ids.to_vec();
    let operation_for_commit = operation_id.to_owned();
    let cancellation_for_commit = cancellation.clone();
    let board_for_commit = board.clone();
    tauri::async_runtime::spawn_blocking(move || match board_for_commit.as_ref() {
        Some(board) => commit_ink_board_export_cancellable(
            &db_for_commit,
            &document_for_commit,
            &revision_for_commit,
            &page_ids_for_commit,
            format,
            &operation_for_commit,
            &staged_upload_id,
            Some(&snapshot),
            &cancellation_for_commit,
            board,
        ),
        None => commit_ink_export_cancellable(
            &db_for_commit,
            &document_for_commit,
            &revision_for_commit,
            &page_ids_for_commit,
            format,
            &operation_for_commit,
            &staged_upload_id,
            Some(&snapshot),
            &cancellation_for_commit,
        ),
    })
    .await
    .map_err(vfs_error)?
}

#[tauri::command]
pub async fn vfs_ink_prepare(
    app: AppHandle,
    window: WebviewWindow,
    request: InkPrepareCommandRequest,
    session_id: Option<String>,
    tool_call_id: Option<String>,
    db: State<'_, Arc<VfsDatabase>>,
) -> Result<InkManifest, InkJobError> {
    if configured_main_label(&app) != Some(window.label()) {
        return Err(job_error(
            "UNTRUSTED_WEBVIEW",
            "Only main may start Ink jobs.",
        ));
    }
    let manifest = match prepare_source_ink(
        &app,
        db.inner().clone(),
        &request.source_resource_id,
        &request.operation_id,
        session_id.as_deref(),
        tool_call_id.as_deref(),
        None,
    )
    .await
    {
        Ok(manifest) => manifest,
        Err(error) => {
            log_prepare_failure(&request.source_resource_id, &request.operation_id, &error);
            return Err(error);
        }
    };
    crate::vfs::hooks::notify_resource_created(&app, &manifest.document_id);
    let _ = app.emit("ink:changed", json!({"document_id": manifest.document_id, "revision": manifest.revision, "operation_id": request.operation_id, "affected_page_ids": manifest.pages.iter().map(|page| page.page_id.clone()).collect::<Vec<_>>()}));
    Ok(manifest)
}

#[tauri::command]
pub async fn vfs_ink_export(
    app: AppHandle,
    window: WebviewWindow,
    request: InkExportCommandRequest,
    session_id: Option<String>,
    tool_call_id: Option<String>,
    db: State<'_, Arc<VfsDatabase>>,
) -> Result<InkExportArtifact, InkJobError> {
    if configured_main_label(&app) != Some(window.label()) {
        return Err(job_error(
            "UNTRUSTED_WEBVIEW",
            "Only main may start Ink jobs.",
        ));
    }
    let artifact = export_ink_document(
        &app,
        db.inner().clone(),
        &request.document_id,
        &request.expected_revision,
        &request.page_ids,
        request.format,
        &request.operation_id,
        session_id.as_deref(),
        tool_call_id.as_deref(),
        None,
        request.board,
    )
    .await?;
    crate::vfs::hooks::notify_resource_created(&app, &artifact.file_id);
    Ok(artifact)
}

#[tauri::command]
pub fn vfs_ink_job_result(
    app: AppHandle,
    window: WebviewWindow,
    response: InkJobResponse,
    bus: State<'_, PendingInkJobBus>,
) -> Result<(), InkJobError> {
    bus.complete_from_labels(window.label(), configured_main_label(&app), response)
        .map_err(job_bus_error)
}

#[cfg(test)]
#[path = "ink_jobs_bus_tests.rs"]
mod bus_tests;

#[cfg(test)]
mod tests {
    use std::{
        io::{Cursor, Write},
        path::Path,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };

    use dstu_vfs::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        ink::{
            InkAuthor, InkBackground, InkBoardChunk, InkBoardObject, InkBoardSurface, InkManifest,
            InkObject, InkObjectContent, InkRect, InkRuling, InkSource, INK_BOARD_SCHEMA_VERSION,
        },
        repos::{
            blob_repo::VfsBlobRepo,
            file_repo::VfsFileRepo,
            ink_board_repo::VfsInkBoardRepo,
            ink_prepare_repo::{InkPreparedPage, VfsInkPrepareRepo},
            ink_repo::VfsInkRepo,
            textbook_repo::VfsTextbookRepo,
            VfsAttachmentRepo,
        },
        types::VfsUploadAttachmentParams,
    };
    use image::ImageEncoder;
    use tokio_util::sync::CancellationToken;

    use super::{
        board_export_grid, commit_ink_board_export_cancellable, commit_ink_export,
        commit_ink_export_cancellable, commit_ink_export_with_snapshot,
        commit_prepared_source_pages, commit_prepared_source_pages_cancellable,
        frozen_snapshot_hash, load_board_export_inputs, load_export_inputs,
        load_export_receipt_for_retry, load_source_bytes, reusable_prepared_manifest,
        source_format, wait_pending_ink_job_with_timeout_notify, InkExportBoardRequest,
        InkExportCommandRequest, InkExportFormat, InkJobBusError, InkJobIdentity, InkJobKind,
        InkJobResponse, InkJobResponseValue, InkStagedPage, PendingInkJobBus,
    };

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    const PNG_MIME: &str = "image/png";
    const PDF_MIME: &str = "application/pdf";
    const DOCX_MIME: &str =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const PPTX_MIME: &str =
        "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    const MAX_STAGED_BYTES: u64 = 4 * 1024 * 1024;

    fn distinct_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[255, 0, 0, 255], 1, 1, image::ColorType::Rgba8)
            .unwrap();
        bytes
    }

    fn second_source_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[0, 255, 0, 255], 1, 1, image::ColorType::Rgba8)
            .unwrap();
        bytes
    }

    fn minimal_pdf() -> Vec<u8> {
        pdf_with_padding(0)
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

    fn ooxml_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, contents) in entries {
                writer.start_file(*name, options).unwrap();
                writer.write_all(contents.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn minimal_docx() -> Vec<u8> {
        ooxml_zip(&[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
            ),
            (
                "word/document.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Textbook DOCX fixture</w:t></w:r></w:p></w:body></w:document>"#,
            ),
        ])
    }

    fn minimal_pptx() -> Vec<u8> {
        ooxml_zip(&[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#,
            ),
            (
                "ppt/presentation.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>"#,
            ),
            (
                "ppt/slides/slide1.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Textbook PPTX fixture</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#,
            ),
        ])
    }

    fn source_file(conn: &rusqlite::Connection, db: &VfsDatabase) -> (String, String, String) {
        source_file_with_bytes(conn, db, PNG_1X1, "source.png")
    }

    fn source_file_with_bytes(
        conn: &rusqlite::Connection,
        db: &VfsDatabase,
        bytes: &[u8],
        file_name: &str,
    ) -> (String, String, String) {
        let stored = VfsBlobRepo::store_blob_with_conn(
            conn,
            db.blobs_dir(),
            bytes,
            Some(PNG_MIME),
            Some("png"),
        )
        .unwrap();
        let file = VfsFileRepo::create_file_with_conn(
            conn,
            &stored.hash,
            file_name,
            bytes.len() as i64,
            "image",
            Some(PNG_MIME),
            Some(&stored.hash),
            None,
        )
        .unwrap();
        (
            file.resource_id.expect("source resource id"),
            file.id,
            stored.hash,
        )
    }

    fn stage_bytes(directory: &std::path::Path, name: &str, bytes: &[u8]) -> String {
        let (id, size) = crate::staged_upload::stage_from_reader(
            directory,
            name,
            &mut Cursor::new(bytes),
            MAX_STAGED_BYTES,
        )
        .unwrap();
        assert_eq!(size, bytes.len() as u64);
        id
    }

    fn prepared_manifest(
        db: &VfsDatabase,
        source_resource_id: &str,
        source_hash: &str,
        operation_id: &str,
    ) -> InkManifest {
        let conn = db.get_conn_safe().unwrap();
        let background = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            PNG_1X1,
            Some(PNG_MIME),
            Some("png"),
        )
        .unwrap();
        let manifest = VfsInkPrepareRepo::prepare_with_conn(
            &conn,
            db.blobs_dir(),
            source_resource_id,
            source_hash,
            "test-image-converter-v1",
            &[InkPreparedPage {
                width: 1.0,
                height: 1.0,
                background_blob_hash: background.hash.clone(),
                source_page_index: None,
            }],
            operation_id,
            None,
        )
        .unwrap();
        VfsBlobRepo::decrement_ref_with_conn(&conn, db.blobs_dir(), &background.hash).unwrap();
        manifest
    }

    fn board_chunk_fixture() -> InkBoardChunk {
        InkBoardChunk {
            schema_version: INK_BOARD_SCHEMA_VERSION,
            chunk_id: "board-export-chunk".to_owned(),
            objects: vec![InkBoardObject {
                id: "board-export-object".to_owned(),
                author: InkAuthor::User,
                created_at: 0,
                z_index: 0,
                content: InkObjectContent::Rect {
                    rect: InkRect {
                        x: -20.0,
                        y: -10.0,
                        width: 40.0,
                        height: 20.0,
                    },
                    color: "#000000".to_owned(),
                    width: 2.0,
                },
            }],
        }
    }

    /// Create and save a real v2 board through the migrated repositories so the
    /// export tests observe the same frozen surface/chunk refs production does.
    fn saved_board_fixture(db: &VfsDatabase) -> (InkManifest, InkBoardChunk) {
        let conn = db.get_conn_safe().unwrap();
        let created = VfsInkBoardRepo::create_blank_with_conn(
            &conn,
            db.blobs_dir(),
            "Ink export board fixture",
            InkRuling::Blank,
            "board-export-create",
            None,
        )
        .expect("migrated board create");
        let chunk = board_chunk_fixture();
        let saved = VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &created.document_id,
            &created.revision,
            "board-export-save",
            std::slice::from_ref(&chunk),
            &[],
        )
        .expect("migrated board save");
        let reread = VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &saved.document_id)
            .expect("reget saved board manifest");
        (reread, chunk)
    }

    fn board_surface_page_id(manifest: &InkManifest) -> String {
        match manifest.surface.as_ref().expect("board surface") {
            InkBoardSurface::Board { page_id, .. } => page_id.clone(),
        }
    }

    fn board_export_request(region: InkRect) -> InkExportBoardRequest {
        InkExportBoardRequest {
            region,
            page_width: 20.0,
            page_height: 20.0,
            paginate: false,
        }
    }

    fn uploaded_source_snapshot(
        conn: &rusqlite::Connection,
        resource_id: &str,
    ) -> (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        i64,
    ) {
        conn.query_row(
            "SELECT r.hash, r.data, r.external_hash, f.blob_hash, f.sha256, f.size FROM resources r JOIN files f ON f.id = r.source_id WHERE r.id = ?1",
            [resource_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .unwrap()
    }

    fn textbook_import_source(
        conn: &rusqlite::Connection,
        db: &VfsDatabase,
        file_name: &str,
        mime_type: &str,
        bytes: &[u8],
        extracted_text: &str,
    ) -> (String, String) {
        let extension = Path::new(file_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bin");
        let stored = VfsBlobRepo::store_blob_with_conn(
            conn,
            db.blobs_dir(),
            bytes,
            Some(mime_type),
            Some(extension),
        )
        .expect("textbook source blob");
        let source_hash = VfsBlobRepo::compute_hash(bytes);
        assert_eq!(stored.hash, source_hash);
        let textbook = VfsTextbookRepo::create_textbook_with_preview(
            conn,
            &source_hash,
            file_name,
            bytes.len() as i64,
            Some(&stored.hash),
            Some("/imports/textbook"),
            None,
            Some(extracted_text),
            Some(1),
        )
        .expect("real textbook import");
        (
            textbook.resource_id.expect("textbook resource id"),
            source_hash,
        )
    }

    fn attachment_import_source(
        db: &VfsDatabase,
        name: &str,
        mime_type: &str,
        bytes: &[u8],
        attachment_type: &str,
    ) -> (String, String) {
        let conn = db.get_conn_safe().unwrap();
        let upload = VfsAttachmentRepo::upload_bytes_with_conn(
            &conn,
            db.blobs_dir(),
            &VfsUploadAttachmentParams {
                name: name.to_owned(),
                mime_type: mime_type.to_owned(),
                base64_content: String::new(),
                attachment_type: Some(attachment_type.to_owned()),
            },
            bytes,
        )
        .expect("real attachment upload");
        (
            upload
                .attachment
                .resource_id
                .expect("attachment resource id"),
            VfsBlobRepo::compute_hash(bytes),
        )
    }

    fn assert_prepared_source_chain(
        temp_dir: &Path,
        db: &VfsDatabase,
        resource_id: &str,
        source_hash: &str,
        conversion_profile: &str,
        source_page_index: Option<u32>,
        operation_prefix: &str,
    ) -> InkManifest {
        let staged = InkStagedPage {
            staged_upload_id: stage_bytes(temp_dir, "prepared-source-page.png", PNG_1X1),
            width_px: 1,
            height_px: 1,
            source_page_index,
        };
        let manifest = commit_prepared_source_pages(
            db,
            resource_id,
            source_hash,
            conversion_profile,
            &[staged],
            &format!("{operation_prefix}-prepare"),
        )
        .expect("prepared source commit");
        assert_eq!(manifest.pages.len(), 1);
        match &manifest.source {
            InkSource::Resource {
                resource_id: manifest_resource_id,
                source_hash: manifest_hash,
                conversion_revision: manifest_profile,
            } => {
                assert_eq!(manifest_resource_id, resource_id);
                assert_eq!(manifest_hash, source_hash);
                assert_eq!(manifest_profile, conversion_profile);
            }
            other => panic!("prepared source must reference its resource, got {other:?}"),
        }
        assert_eq!(
            reusable_prepared_manifest(db, resource_id, source_hash, conversion_profile)
                .expect("reusable manifest query")
                .expect("committed manifest must be reusable"),
            manifest
        );

        let conn = db.get_conn_safe().unwrap();
        let mut page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.pages[0].page_id,
        )
        .expect("prepared page reopen");
        assert!(page.objects.is_empty());
        page.objects.push(InkObject {
            id: "source-annotation".to_owned(),
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
        let saved = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.revision,
            &format!("{operation_prefix}-save"),
            &page,
        )
        .expect("prepared page annotation save");
        let reopened =
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &saved.document_id)
                .expect("saved manifest reopen");
        assert_eq!(reopened, saved);
        let reopened_page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &saved.document_id,
            &saved.pages[0].page_id,
        )
        .expect("saved page reopen");
        assert_eq!(reopened_page, page);
        drop(conn);

        let (loaded_hash, _, _, _, loaded_bytes) =
            load_source_bytes(db, resource_id).expect("source must survive the prepare/save chain");
        assert_eq!(loaded_hash, source_hash);
        assert_eq!(VfsBlobRepo::compute_hash(&loaded_bytes), source_hash);
        reopened
    }

    #[test]
    fn source_format_accepts_import_aliases_and_keeps_legacy_office_rejection() {
        for (name, mime, file_type) in [
            ("book.pdf", PDF_MIME, "pdf"),
            ("book.pdf", PDF_MIME, "document"),
            ("book.pdf", PDF_MIME, "file"),
            ("guide.docx", DOCX_MIME, "docx"),
            ("guide.docx", DOCX_MIME, "document"),
            ("guide.docx", DOCX_MIME, "file"),
            ("slides.pptx", PPTX_MIME, "pptx"),
            ("slides.pptx", PPTX_MIME, "document"),
            ("slides.pptx", PPTX_MIME, "file"),
            ("scan.png", PNG_MIME, "image"),
            ("photo.jpg", "image/jpeg", "image"),
            ("photo.jpeg", "image/jpeg", "image"),
            ("photo.webp", "image/webp", "image"),
            ("photo.gif", "image/gif", "image"),
        ] {
            assert_eq!(
                source_format(name, mime, file_type).unwrap(),
                if mime == PDF_MIME {
                    "pdf"
                } else if mime.starts_with("image/") {
                    "image"
                } else if name.ends_with(".docx") {
                    "docx"
                } else {
                    "pptx"
                },
                "{name} ({mime}, {file_type})"
            );
        }
        for name in ["legacy.doc", "legacy.ppt", "legacy.xls", "legacy.xlsx"] {
            let error = source_format(name, "application/octet-stream", "file").unwrap_err();
            assert_eq!(error.code, "UNSUPPORTED_FORMAT");
            assert_eq!(
                error.message,
                "This source format is not supported for Ink preparation."
            );
        }
        let error = source_format("book.pdf", "image/png", "file").unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_FORMAT");
        assert_eq!(
            error.message,
            "The VFS file extension and MIME type are unsupported or inconsistent."
        );
    }

    #[test]
    fn unsupported_source_format_keeps_a_typed_job_error() {
        let error = super::vfs_error(dstu_vfs::vfs::error::VfsError::InvalidArgument {
            param: "file_name".to_owned(),
            reason: "unsupported format".to_owned(),
        });
        assert_eq!(error.code, "UNSUPPORTED_FORMAT");
        let error = super::vfs_error(dstu_vfs::vfs::error::VfsError::InvalidArgument {
            param: "source_resource_id".to_owned(),
            reason: "invalid id".to_owned(),
        });
        assert_eq!(error.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn real_textbook_imports_prepare_reuse_save_and_reopen_pdf_docx_pptx_image() {
        for (name, mime, bytes, expected_kind, extracted_text) in [
            (
                "教材讲义.pdf",
                PDF_MIME,
                minimal_pdf(),
                "pdf",
                "PDF textbook extracted text",
            ),
            (
                "课堂笔记.docx",
                DOCX_MIME,
                minimal_docx(),
                "docx",
                "DOCX textbook extracted text",
            ),
            (
                "演示文稿.pptx",
                PPTX_MIME,
                minimal_pptx(),
                "pptx",
                "PPTX textbook extracted text",
            ),
            (
                "教材插图.png",
                PNG_MIME,
                distinct_png(),
                "image",
                "PNG textbook extracted text",
            ),
        ] {
            let (temp_dir, db) = setup_migrated_test_db();
            let conn = db.get_conn_safe().unwrap();
            let (resource_id, source_hash) =
                textbook_import_source(&conn, &db, name, mime, &bytes, extracted_text);
            let (stored_data, stored_blob_hash, stored_file_type, storage_mode): (
                String,
                Option<String>,
                String,
                String,
            ) = conn
                .query_row(
                    "SELECT r.data, f.blob_hash, f.type, r.storage_mode FROM resources r JOIN files f ON f.id = r.source_id WHERE r.id = ?1",
                    [&resource_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert_eq!(stored_data, extracted_text);
            assert_eq!(stored_blob_hash.as_deref(), Some(source_hash.as_str()));
            assert_eq!(stored_file_type, expected_kind);
            assert_eq!(storage_mode, "inline");
            conn.execute(
                "UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.custom', 'kept') WHERE id = ?1",
                [&resource_id],
            )
            .unwrap();
            drop(conn);

            let (hash, kind, loaded_name, loaded_mime, loaded_bytes) =
                load_source_bytes(&db, &resource_id).expect("textbook source bytes");
            assert_eq!(hash, source_hash);
            assert_eq!(kind, expected_kind);
            assert_eq!(loaded_name, name);
            assert_eq!(loaded_mime, mime);
            assert_eq!(loaded_bytes, bytes);

            let manifest = assert_prepared_source_chain(
                temp_dir.path(),
                &db,
                &resource_id,
                &source_hash,
                "textbook-import-test-v1",
                (expected_kind == "pdf").then_some(0),
                "textbook-import",
            );
            assert_eq!(
                manifest.title,
                Path::new(name).file_stem().unwrap().to_str().unwrap()
            );
            match &manifest.pages[0].background {
                InkBackground::PdfPage {
                    source_page_index, ..
                } => {
                    assert_eq!(expected_kind, "pdf");
                    assert_eq!(*source_page_index, 0);
                }
                InkBackground::Image { .. } => assert_ne!(expected_kind, "pdf"),
                InkBackground::Blank { .. } => panic!("prepared source page must have a raster"),
            }

            let conn = db.get_conn_safe().unwrap();
            let (data_after, blob_after): (String, Option<String>) = conn
                .query_row(
                    "SELECT r.data, f.blob_hash FROM resources r JOIN files f ON f.id = r.source_id WHERE r.id = ?1",
                    [&resource_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(data_after, extracted_text);
            assert_eq!(blob_after.as_deref(), Some(source_hash.as_str()));
            let metadata: String = conn
                .query_row(
                    "SELECT metadata_json FROM resources WHERE id = ?1",
                    [&resource_id],
                    |row| row.get(0),
                )
                .unwrap();
            let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
            assert_eq!(metadata["custom"], "kept");
            assert_eq!(
                metadata["default_ink_document_id"],
                manifest.document_id.as_str()
            );
        }
    }

    #[test]
    fn real_attachment_imports_prepare_reuse_save_and_reopen_pdf_docx_pptx_image() {
        for (name, mime, bytes, expected_kind, attachment_type) in [
            ("课堂讲义.pdf", PDF_MIME, minimal_pdf(), "pdf", "file"),
            ("课堂笔记.docx", DOCX_MIME, minimal_docx(), "docx", "file"),
            ("演示文稿.pptx", PPTX_MIME, minimal_pptx(), "pptx", "file"),
            ("课堂图片.png", PNG_MIME, distinct_png(), "image", "image"),
        ] {
            let (temp_dir, db) = setup_migrated_test_db();
            let (resource_id, source_hash) =
                attachment_import_source(&db, name, mime, &bytes, attachment_type);
            let (hash, kind, loaded_name, loaded_mime, loaded_bytes) =
                load_source_bytes(&db, &resource_id).expect("attachment source bytes");
            assert_eq!(hash, source_hash);
            assert_eq!(kind, expected_kind);
            assert_eq!(loaded_name, name);
            assert_eq!(loaded_mime, mime);
            assert_eq!(loaded_bytes, bytes);

            let manifest = assert_prepared_source_chain(
                temp_dir.path(),
                &db,
                &resource_id,
                &source_hash,
                "attachment-import-test-v1",
                (expected_kind == "pdf").then_some(0),
                "attachment-import",
            );
            assert_eq!(
                manifest.title,
                Path::new(name).file_stem().unwrap().to_str().unwrap()
            );
            match &manifest.pages[0].background {
                InkBackground::PdfPage {
                    source_page_index, ..
                } => {
                    assert_eq!(expected_kind, "pdf");
                    assert_eq!(*source_page_index, 0);
                }
                InkBackground::Image { .. } => assert_ne!(expected_kind, "pdf"),
                InkBackground::Blank { .. } => panic!("prepared source page must have a raster"),
            }
        }
    }

    #[test]
    fn real_attachment_uploads_prepare_reopen_save_and_load_frozen_render_inputs() {
        for (name, mime, external, is_pdf) in [
            ("课堂讲义.pdf", PDF_MIME, false, true),
            ("课堂图片.png", PNG_MIME, false, false),
            ("external-source.pdf", PDF_MIME, true, true),
            ("external-image.png", PNG_MIME, true, false),
        ] {
            let (temp_dir, db) = setup_migrated_test_db();
            let conn = db.get_conn_safe().unwrap();
            let mut bytes = if is_pdf {
                pdf_with_padding(if external { 1024 * 1024 } else { 0 })
            } else {
                PNG_1X1.to_vec()
            };
            if external && !is_pdf {
                bytes.resize(1024 * 1024, 0);
            }
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
            .expect("real attachment upload");
            let resource_id = upload.attachment.resource_id.unwrap();
            let source_hash = VfsBlobRepo::compute_hash(&bytes);
            let before = uploaded_source_snapshot(&conn, &resource_id);
            assert_eq!(before.4, source_hash);
            assert_eq!(before.3.is_some(), external);
            if external {
                assert_eq!(before.0, source_hash);
            } else {
                assert_ne!(before.0, source_hash);
            }
            conn.execute(
                "UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.custom', 'kept', '$.extra.highlights', json(?1)) WHERE id = ?2",
                rusqlite::params![serde_json::json!([{"id": "source-highlight", "pageIndex": 0}]).to_string(), resource_id],
            )
            .unwrap();
            drop(conn);

            let (hash, kind, loaded_name, loaded_mime, loaded_bytes) =
                load_source_bytes(&db, &resource_id).expect("uploaded source bytes must load");
            assert_eq!(hash, source_hash);
            assert_eq!(kind, if is_pdf { "pdf" } else { "image" });
            assert_eq!(loaded_name, name);
            assert_eq!(loaded_mime, mime);
            assert_eq!(loaded_bytes, bytes);
            let staged = InkStagedPage {
                staged_upload_id: stage_bytes(temp_dir.path(), "prepared-page.png", PNG_1X1),
                width_px: 1,
                height_px: 1,
                source_page_index: is_pdf.then_some(0),
            };
            let manifest = commit_prepared_source_pages(
                &db,
                &resource_id,
                &source_hash,
                "uploaded-source-test-v1",
                &[staged],
                "prepare-uploaded-source",
            )
            .expect("real uploaded source must prepare");
            assert_eq!(
                manifest.title,
                Path::new(name).file_stem().unwrap().to_str().unwrap(),
            );
            let conn = db.get_conn_safe().unwrap();
            let reopened =
                VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &manifest.document_id)
                    .unwrap();
            assert_eq!(reopened, manifest);
            let mut page = VfsInkRepo::get_page_with_conn(
                &conn,
                db.blobs_dir(),
                &manifest.document_id,
                &manifest.pages[0].page_id,
            )
            .unwrap();
            page.objects.push(InkObject {
                id: "uploaded-annotation".to_owned(),
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
            let saved = VfsInkRepo::save_page_with_conn(
                &conn,
                db.blobs_dir(),
                &manifest.document_id,
                &manifest.revision,
                "save-uploaded-annotation",
                &page,
            )
            .expect("uploaded source annotation must save");
            assert_eq!(uploaded_source_snapshot(&conn, &resource_id), before);
            let metadata: String = conn
                .query_row(
                    "SELECT metadata_json FROM resources WHERE id = ?1",
                    [&resource_id],
                    |row| row.get(0),
                )
                .unwrap();
            let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
            assert_eq!(metadata["custom"], "kept");
            assert_eq!(metadata["default_ink_document_id"], saved.document_id);
            drop(conn);

            let inputs = load_export_inputs(
                &db,
                &saved.document_id,
                &saved.revision,
                &[saved.pages[0].page_id.clone()],
            )
            .expect("frozen render inputs must accept inline and external uploads");
            assert_eq!(inputs[0].page.as_ref().unwrap(), &page);
            assert_eq!(inputs[0].source_hash.as_deref(), Some(source_hash.as_str()));
            assert_eq!(inputs[0].highlights[0]["id"], "source-highlight");
            assert!(inputs[0].source_annotation_revision.is_some());
            let retry_stage = InkStagedPage {
                staged_upload_id: stage_bytes(temp_dir.path(), "retry-page.png", PNG_1X1),
                width_px: 1,
                height_px: 1,
                source_page_index: is_pdf.then_some(0),
            };
            let retried = commit_prepared_source_pages(
                &db,
                &resource_id,
                &source_hash,
                "uploaded-source-test-v1",
                &[retry_stage],
                "prepare-uploaded-retry",
            )
            .unwrap();
            assert_eq!(retried, saved);

            let conn = db.get_conn_safe().unwrap();
            if external {
                let path =
                    VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &source_hash)
                        .unwrap()
                        .unwrap();
                let mut corrupted = bytes.clone();
                corrupted[20] ^= 1;
                std::fs::write(path, corrupted).unwrap();
            } else {
                conn.execute(
                    "UPDATE resources SET data = 'AAAA' WHERE id = ?1",
                    [&resource_id],
                )
                .unwrap();
            }
            drop(conn);
            assert_eq!(
                load_source_bytes(&db, &resource_id).unwrap_err().code,
                "SOURCE_CHANGED",
            );
            match load_export_inputs(
                &db,
                &saved.document_id,
                &saved.revision,
                &[saved.pages[0].page_id.clone()],
            ) {
                Err(error) => assert_eq!(error.code, "SOURCE_CHANGED"),
                Ok(_) => {
                    panic!("corrupt uploaded source must not provide frozen annotation inputs")
                }
            }
            let conn = db.get_conn_safe().unwrap();
            if external {
                let path =
                    VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &source_hash)
                        .unwrap()
                        .unwrap();
                std::fs::write(path, &bytes).unwrap();
            } else {
                conn.execute(
                    "UPDATE resources SET data = ?1 WHERE id = ?2",
                    rusqlite::params![before.1, resource_id],
                )
                .unwrap();
            }
            VfsFileRepo::purge_file_with_conn(&conn, db.blobs_dir(), &upload.source_id).unwrap();
            drop(conn);
            let purged_inputs = load_export_inputs(
                &db,
                &saved.document_id,
                &saved.revision,
                &[saved.pages[0].page_id.clone()],
            )
            .expect("prepared background must survive a real uploaded source purge");
            assert_eq!(purged_inputs[0].page.as_ref().unwrap(), &page);
            assert!(purged_inputs[0].highlights.is_empty());
            assert!(purged_inputs[0].source_annotation_revision.is_none());
        }
    }

    #[test]
    fn real_inline_upload_rejects_changed_hash_and_wrong_link_without_prepare_writes() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let upload = VfsAttachmentRepo::upload_bytes_with_conn(
            &conn,
            db.blobs_dir(),
            &VfsUploadAttachmentParams {
                name: "inline-source.png".to_owned(),
                mime_type: PNG_MIME.to_owned(),
                base64_content: String::new(),
                attachment_type: Some("image".to_owned()),
            },
            PNG_1X1,
        )
        .unwrap();
        let resource_id = upload.attachment.resource_id.unwrap();
        let source_hash = VfsBlobRepo::compute_hash(PNG_1X1);
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);
        let stage = InkStagedPage {
            staged_upload_id: stage_bytes(temp_dir.path(), "changed-source-page.png", PNG_1X1),
            width_px: 1,
            height_px: 1,
            source_page_index: None,
        };
        assert_eq!(
            commit_prepared_source_pages(
                &db,
                &resource_id,
                &"a".repeat(64),
                "uploaded-source-test-v1",
                &[stage],
                "reject-stale-source",
            )
            .unwrap_err()
            .code,
            "SOURCE_CHANGED",
        );
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE resources SET source_id = 'wrong-file' WHERE id = ?1",
            [&resource_id],
        )
        .unwrap();
        drop(conn);
        assert_eq!(
            load_source_bytes(&db, &resource_id).unwrap_err().code,
            "SOURCE_CHANGED",
        );
        let stage = InkStagedPage {
            staged_upload_id: stage_bytes(temp_dir.path(), "wrong-source-page.png", PNG_1X1),
            width_px: 1,
            height_px: 1,
            source_page_index: None,
        };
        assert_eq!(
            commit_prepared_source_pages(
                &db,
                &resource_id,
                &source_hash,
                "uploaded-source-test-v1",
                &[stage],
                "reject-wrong-source",
            )
            .unwrap_err()
            .code,
            "SOURCE_CHANGED",
        );
        let conn = db.get_conn_safe().unwrap();
        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, after);
        let pointer: Option<String> = conn
            .query_row(
                "SELECT json_extract(metadata_json, '$.default_ink_document_id') FROM resources WHERE id = ?1",
                [&resource_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(pointer.is_none());
    }

    #[test]
    fn staged_png_page_is_committed_as_a_readable_owned_prepared_background() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _source_file_id, source_hash) = source_file(&conn, &db);
        drop(conn);
        let staged_id = stage_bytes(temp_dir.path(), "prepared-page.png", PNG_1X1);
        let staged = [InkStagedPage {
            staged_upload_id: staged_id.clone(),
            width_px: 1,
            height_px: 1,
            source_page_index: None,
        }];

        let result = commit_prepared_source_pages(
            &db,
            &source_resource_id,
            &source_hash,
            "test-image-converter-v1",
            &staged,
            "prepare-ct-operation-1",
        );
        crate::staged_upload::abort(&staged_id);
        let manifest = result.expect("staged PNG page should create and persist an Ink manifest");

        assert_eq!(
            manifest.source,
            dstu_vfs::vfs::ink::InkSource::Resource {
                resource_id: source_resource_id,
                source_hash,
                conversion_revision: "test-image-converter-v1".to_owned(),
            }
        );
        assert_eq!(manifest.pages.len(), 1);
        let background_hash = match &manifest.pages[0].background {
            InkBackground::Image { blob_hash } => blob_hash,
            other => panic!("expected frozen image PNG background, got {other:?}"),
        };
        let conn = db.get_conn_safe().unwrap();
        let reopened =
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &manifest.document_id)
                .expect("prepared manifest should reopen from the migrated VFS");
        assert_eq!(reopened, manifest);
        let page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.pages[0].page_id,
        )
        .expect("prepared page should reopen from the migrated VFS");
        assert!(page.objects.is_empty());
        let blob = VfsBlobRepo::get_blob_with_conn(&conn, background_hash)
            .unwrap()
            .expect("manifest must own its background blob");
        assert!(blob.ref_count >= 1);
        let path = VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), background_hash)
            .unwrap()
            .expect("background blob path");
        assert_eq!(std::fs::read(path).unwrap(), PNG_1X1);
    }

    #[test]
    fn soft_deleted_prepared_target_is_rebuilt_on_retry_with_same_operation_id() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        let first_stage = InkStagedPage {
            staged_upload_id: stage_bytes(temp_dir.path(), "first-page.png", PNG_1X1),
            width_px: 1,
            height_px: 1,
            source_page_index: None,
        };
        let first = commit_prepared_source_pages(
            &db,
            &source_resource_id,
            &source_hash,
            "test-image-converter-v1",
            &[first_stage],
            "prepare-reused-operation-id",
        )
        .expect("initial prepared document");

        let mut page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &first.document_id,
            &first.pages[0].page_id,
        )
        .unwrap();
        page.objects.push(InkObject {
            id: "job-user-stroke".to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            content: InkObjectContent::Rect {
                rect: InkRect {
                    x: 0.2,
                    y: 0.2,
                    width: 0.4,
                    height: 0.4,
                },
                color: "#000000".to_owned(),
                width: 1.0,
            },
        });
        let annotated = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &first.document_id,
            &first.revision,
            "save-job-annotation",
            &page,
        )
        .unwrap();
        conn.execute(
            "UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.custom', 'kept', '$.trash', json(?1)) WHERE id = ?2",
            rusqlite::params![r#"{"deleted_notes":["note-9"]}"#, source_resource_id],
        )
        .unwrap();
        let metadata_before = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap();
        let files_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        VfsFileRepo::delete_file_with_conn(&db.get_conn_safe().unwrap(), &first.document_id)
            .unwrap();

        // Regression from logcat: this used to surface ink.format_conflict ->
        // UNSUPPORTED_FORMAT instead of reporting "not reusable".
        let reusable = reusable_prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "test-image-converter-v1",
        )
        .expect("deleted default target must not fail the read-side reuse check");
        assert!(reusable.is_none());
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap(),
            metadata_before,
            "read-side reuse check must not rewrite the stale pointer",
        );
        drop(conn);

        let retry_stage = InkStagedPage {
            staged_upload_id: stage_bytes(temp_dir.path(), "retry-page.png", PNG_1X1),
            width_px: 1,
            height_px: 1,
            source_page_index: None,
        };
        let second = commit_prepared_source_pages(
            &db,
            &source_resource_id,
            &source_hash,
            "test-image-converter-v1",
            &[retry_stage],
            "prepare-reused-operation-id",
        )
        .expect("retry with the same operation ID must rebuild after target deletion");

        assert_ne!(second.document_id, first.document_id);
        let conn = db.get_conn_safe().unwrap();
        let metadata: serde_json::Value = serde_json::from_str(
            conn.query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
            .as_str(),
        )
        .unwrap();
        assert_eq!(metadata["custom"], "kept");
        assert_eq!(metadata["trash"]["deleted_notes"][0], "note-9");
        assert_eq!(
            metadata["default_ink_document_id"],
            second.document_id.as_str()
        );
        let old_file = VfsFileRepo::get_file_with_conn(&conn, &first.document_id)
            .unwrap()
            .expect("old deleted document must remain");
        assert_eq!(old_file.status, "deleted");
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            files_before + 1,
        );

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
        assert_eq!(old_page.objects[0].id, "job-user-stroke");
    }

    #[test]
    fn missing_default_target_is_not_reusable_and_commit_replaces_pointer() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        assert!(reusable_prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "test-image-converter-v1",
        )
        .unwrap()
        .is_none());

        let orphan = format!("file_ink_{}", "b".repeat(64));
        conn.execute(
            "UPDATE resources SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.default_ink_document_id', ?1, '$.custom', 'kept') WHERE id = ?2",
            rusqlite::params![orphan, source_resource_id],
        )
        .unwrap();
        let metadata_before = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap();
        drop(conn);

        assert!(reusable_prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "test-image-converter-v1",
        )
        .unwrap()
        .is_none());
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap(),
            metadata_before,
            "the read-side missing-target check must not rewrite metadata",
        );
        drop(conn);

        let stage = InkStagedPage {
            staged_upload_id: stage_bytes(temp_dir.path(), "missing-target.png", PNG_1X1),
            width_px: 1,
            height_px: 1,
            source_page_index: None,
        };
        let manifest = commit_prepared_source_pages(
            &db,
            &source_resource_id,
            &source_hash,
            "test-image-converter-v1",
            &[stage],
            "prepare-missing-target",
        )
        .expect("a missing default target must be replaceable");
        assert_ne!(manifest.document_id, orphan);
        let conn = db.get_conn_safe().unwrap();
        let metadata: serde_json::Value = serde_json::from_str(
            conn.query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
            .as_str(),
        )
        .unwrap();
        assert_eq!(metadata["custom"], "kept");
        assert_eq!(
            metadata["default_ink_document_id"],
            manifest.document_id.as_str()
        );
    }

    #[test]
    fn active_prepared_target_keeps_annotations_and_pointer_on_retry() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        let manifest = prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "prepare-active-reuse",
        );
        let mut page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.pages[0].page_id,
        )
        .unwrap();
        page.objects.push(InkObject {
            id: "active-user-stroke".to_owned(),
            author: InkAuthor::User,
            created_at: 0,
            content: InkObjectContent::Rect {
                rect: InkRect {
                    x: 0.3,
                    y: 0.3,
                    width: 0.2,
                    height: 0.2,
                },
                color: "#000000".to_owned(),
                width: 1.0,
            },
        });
        let annotated = VfsInkRepo::save_page_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.revision,
            "save-active-annotation",
            &page,
        )
        .unwrap();
        let metadata_before = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap();
        let files_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        assert_eq!(
            reusable_prepared_manifest(
                &db,
                &source_resource_id,
                &source_hash,
                "test-image-converter-v1",
            )
            .unwrap(),
            Some(annotated.clone()),
        );
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap(),
            metadata_before,
        );
        drop(conn);

        let stage = InkStagedPage {
            staged_upload_id: stage_bytes(temp_dir.path(), "active-reuse.png", PNG_1X1),
            width_px: 1,
            height_px: 1,
            source_page_index: None,
        };
        let reused = commit_prepared_source_pages(
            &db,
            &source_resource_id,
            &source_hash,
            "test-image-converter-v1",
            &[stage],
            "prepare-active-reuse-retry",
        )
        .unwrap();
        assert_eq!(reused, annotated);
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap(),
            metadata_before,
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            files_before,
        );
        let page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &reused.document_id,
            &reused.pages[0].page_id,
        )
        .unwrap();
        assert_eq!(page.objects.len(), 1);
        assert_eq!(page.objects[0].id, "active-user-stroke");
    }

    #[test]
    fn active_corrupt_prepared_target_is_rejected_without_replacement() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        let manifest = prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "prepare-corrupt-active",
        );
        let manifest_hash: String = conn
            .query_row(
                "SELECT blob_hash FROM files WHERE id = ?1",
                [&manifest.document_id],
                |row| row.get(0),
            )
            .unwrap();
        let manifest_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &manifest_hash)
                .unwrap()
                .unwrap();
        std::fs::write(manifest_path, b"{\"corrupt\":true}").unwrap();
        let metadata_before = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap();
        let files_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        assert_eq!(
            reusable_prepared_manifest(
                &db,
                &source_resource_id,
                &source_hash,
                "test-image-converter-v1",
            )
            .unwrap_err()
            .code,
            "SOURCE_CHANGED",
        );
        let stage = InkStagedPage {
            staged_upload_id: stage_bytes(temp_dir.path(), "corrupt-active.png", PNG_1X1),
            width_px: 1,
            height_px: 1,
            source_page_index: None,
        };
        assert_eq!(
            commit_prepared_source_pages(
                &db,
                &source_resource_id,
                &source_hash,
                "test-image-converter-v1",
                &[stage],
                "prepare-corrupt-active-retry",
            )
            .unwrap_err()
            .code,
            "SOURCE_CHANGED",
        );
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap(),
            metadata_before,
            "a rejected corrupt active target must not rewrite metadata",
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            files_before,
            "a rejected corrupt active target must not create a replacement",
        );
    }

    #[test]
    fn export_commits_independent_png_and_pdf_files_with_provenance_and_exact_retries() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_file_id, source_hash) = source_file(&conn, &db);
        let manifest = prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "prepare-export-fixture",
        );
        let source_metadata_before: Option<String> = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        let source_file_before = VfsFileRepo::get_file_with_conn(&conn, &source_file_id)
            .unwrap()
            .expect("source file");
        let document_resource_id = VfsFileRepo::get_file_with_conn(&conn, &manifest.document_id)
            .unwrap()
            .and_then(|file| file.resource_id)
            .expect("Ink document resource");
        let page_ids = vec![manifest.pages[0].page_id.clone()];
        let png = distinct_png();
        let pdf = minimal_pdf();
        drop(conn);

        for (format, name, bytes, mime) in [
            (InkExportFormat::Png, "export.png", png.as_slice(), PNG_MIME),
            (InkExportFormat::Pdf, "export.pdf", pdf.as_slice(), PDF_MIME),
        ] {
            let operation_id = match format {
                InkExportFormat::Png => "export-png-operation",
                InkExportFormat::Pdf => "export-pdf-operation",
            };
            let stage_id = stage_bytes(temp_dir.path(), name, bytes);
            let first_result = commit_ink_export(
                &db,
                &manifest.document_id,
                &manifest.revision,
                &page_ids,
                format,
                operation_id,
                &stage_id,
            );
            crate::staged_upload::abort(&stage_id);
            let first = first_result.expect("real staged export bytes should create a VFS file");
            assert_eq!(first.document_id, manifest.document_id);
            assert_eq!(first.revision, manifest.revision);
            assert_eq!(first.page_ids, page_ids);
            assert_eq!(first.format, format);
            assert_eq!(first.operation_id, operation_id);
            assert_eq!(first.mime_type, mime);
            assert_ne!(first.resource_id, manifest.document_id);
            assert_ne!(first.file_id, manifest.document_id);
            assert_eq!(first.content_hash, VfsBlobRepo::compute_hash(bytes));
            assert_eq!(first.blob_hash, first.content_hash);

            let retry_stage_id = stage_bytes(temp_dir.path(), name, bytes);
            let retry_result = commit_ink_export(
                &db,
                &manifest.document_id,
                &manifest.revision,
                &page_ids,
                format,
                operation_id,
                &retry_stage_id,
            );
            crate::staged_upload::abort(&retry_stage_id);
            let retry =
                retry_result.expect("an exact export retry should reuse its immutable artifact");
            assert_eq!(retry, first);

            let conn = db.get_conn_safe().unwrap();
            let file = VfsFileRepo::get_file_with_conn(&conn, &first.file_id)
                .unwrap()
                .expect("export should be an independent VFS file");
            assert_eq!(
                file.resource_id.as_deref(),
                Some(first.resource_id.as_str())
            );
            assert_eq!(file.mime_type.as_deref(), Some(mime));
            assert_eq!(file.sha256, first.content_hash);
            let path =
                VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &first.blob_hash)
                    .unwrap()
                    .expect("export blob path");
            assert_eq!(std::fs::read(path).unwrap(), bytes);
            let metadata: Option<String> = conn
                .query_row(
                    "SELECT metadata_json FROM resources WHERE id = ?1",
                    [&document_resource_id],
                    |row| row.get(0),
                )
                .unwrap();
            let metadata: serde_json::Value =
                serde_json::from_str(metadata.as_deref().unwrap()).unwrap();
            let receipt = metadata["ink_export_receipts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|receipt| receipt["operation_id"] == operation_id)
                .expect("document resource owns the authoritative immutable export receipt");
            assert_eq!(receipt["artifact"]["document_id"], manifest.document_id);
            assert_eq!(receipt["artifact"]["revision"], manifest.revision);
            assert_eq!(receipt["artifact"]["operation_id"], operation_id);
            assert_eq!(
                receipt["artifact"]["content_hash"],
                VfsBlobRepo::compute_hash(bytes)
            );
            assert_eq!(receipt["input_hash"].as_str().unwrap().len(), 64);
            assert_eq!(
                receipt["artifact"]["format"],
                match format {
                    InkExportFormat::Png => "png",
                    InkExportFormat::Pdf => "pdf",
                }
            );
            let output_metadata: Option<String> = conn
                .query_row(
                    "SELECT metadata_json FROM resources WHERE id = ?1",
                    [&first.resource_id],
                    |row| row.get(0),
                )
                .unwrap();
            let output_metadata: serde_json::Value =
                serde_json::from_str(output_metadata.as_deref().unwrap()).unwrap();
            assert!(output_metadata["ink_exports"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["artifact_id"] == first.artifact_id));
            assert_eq!(
                VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &manifest.document_id)
                    .unwrap(),
                manifest,
                "export must not mutate the canonical Ink document",
            );
            let source_file_after = VfsFileRepo::get_file_with_conn(&conn, &source_file_id)
                .unwrap()
                .expect("source file must remain active");
            assert_eq!(source_file_after.sha256, source_file_before.sha256);
            let source_metadata_after: Option<String> = conn
                .query_row(
                    "SELECT metadata_json FROM resources WHERE id = ?1",
                    [&source_resource_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(source_metadata_after, source_metadata_before);
        }
    }

    #[test]
    fn malformed_second_prepared_page_releases_prior_temporary_blob_refs_and_stages() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        let before = VfsBlobRepo::get_blob_with_conn(&conn, &source_hash)
            .unwrap()
            .unwrap()
            .ref_count;
        let files_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);
        let first_stage = stage_bytes(temp_dir.path(), "first.png", PNG_1X1);
        let second_stage = stage_bytes(temp_dir.path(), "malformed.png", b"not a png");
        let stages = [
            InkStagedPage {
                staged_upload_id: first_stage.clone(),
                width_px: 1,
                height_px: 1,
                source_page_index: None,
            },
            InkStagedPage {
                staged_upload_id: second_stage.clone(),
                width_px: 1,
                height_px: 1,
                source_page_index: None,
            },
        ];

        let result = commit_prepared_source_pages(
            &db,
            &source_resource_id,
            &source_hash,
            "test-image-converter-v1",
            &stages,
            "prepare-malformed-second",
        );

        assert_eq!(result.unwrap_err().code, "INVALID_STAGED_UPLOAD");
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            VfsBlobRepo::get_blob_with_conn(&conn, &source_hash)
                .unwrap()
                .unwrap()
                .ref_count,
            before
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            files_before
        );
        assert!(crate::staged_upload::take_staged_upload(&first_stage).is_err());
        assert!(crate::staged_upload::take_staged_upload(&second_stage).is_err());
    }

    #[tokio::test]
    async fn cancelled_prepare_before_commit_consumes_stages_without_vfs_mutation() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        let count_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);
        let stage_id = stage_bytes(temp_dir.path(), "cancelled.png", PNG_1X1);
        let bus = PendingInkJobBus::default();
        let identity = InkJobIdentity {
            request_id: "cancelled-prepare-before-commit".to_owned(),
            operation_id: "prepare-cancelled".to_owned(),
            kind: InkJobKind::Prepare,
            session_id: None,
            tool_call_id: None,
        };
        let pending = bus.register(identity.clone()).unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            pending.wait(Duration::from_secs(1), &cancellation).await,
            Err(InkJobBusError::Cancelled)
        );
        crate::staged_upload::abort(&stage_id);
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            count_before
        );
        let metadata: Option<String> = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&source_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        let metadata: serde_json::Value = metadata
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .unwrap()
            .unwrap_or_default();
        assert!(metadata.get("default_ink_document_id").is_none());
        assert!(crate::staged_upload::take_staged_upload(&stage_id).is_err());
        assert_eq!(
            VfsBlobRepo::get_blob_with_conn(&conn, &source_hash)
                .unwrap()
                .unwrap()
                .ref_count,
            1
        );
    }

    #[test]
    fn export_operation_id_rejects_different_input_without_adding_receipt() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        let manifest = prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "prepare-export-conflict-fixture",
        );
        let document_resource_id = VfsFileRepo::get_file_with_conn(&conn, &manifest.document_id)
            .unwrap()
            .unwrap()
            .resource_id
            .unwrap();
        drop(conn);
        let page_ids = vec![manifest.pages[0].page_id.clone()];
        let first_png = distinct_png();
        let first_id = stage_bytes(temp_dir.path(), "first.png", &first_png);
        let first = commit_ink_export(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Png,
            "same-export-operation",
            &first_id,
        )
        .unwrap();
        let changed_pdf = minimal_pdf();
        let second_id = stage_bytes(temp_dir.path(), "different.pdf", &changed_pdf);

        let rejected = commit_ink_export(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Pdf,
            "same-export-operation",
            &second_id,
        );

        assert_eq!(rejected.unwrap_err().code, "OPERATION_CONFLICT");
        let conn = db.get_conn_safe().unwrap();
        let raw: Option<String> = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&document_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        let metadata: serde_json::Value = serde_json::from_str(raw.as_deref().unwrap()).unwrap();
        let receipts = metadata["ink_export_receipts"].as_array().unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0]["artifact"]["artifact_id"], first.artifact_id);
        assert!(crate::staged_upload::take_staged_upload(&second_id).is_err());
    }

    #[test]
    fn identical_png_exported_by_two_documents_preserves_both_receipt_indexes() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_a, _, hash_a) = source_file(&conn, &db);
        let manifest_a = prepared_manifest(&db, &source_a, &hash_a, "prepare-export-a");
        let png = distinct_png();
        let source_b_png = second_source_png();
        let (source_b, _, hash_b) =
            source_file_with_bytes(&conn, &db, &source_b_png, "source-b.png");
        let manifest_b = prepared_manifest(&db, &source_b, &hash_b, "prepare-export-b");
        let doc_resource_a = VfsFileRepo::get_file_with_conn(&conn, &manifest_a.document_id)
            .unwrap()
            .unwrap()
            .resource_id
            .unwrap();
        let doc_resource_b = VfsFileRepo::get_file_with_conn(&conn, &manifest_b.document_id)
            .unwrap()
            .unwrap()
            .resource_id
            .unwrap();
        drop(conn);
        let page_a = vec![manifest_a.pages[0].page_id.clone()];
        let page_b = vec![manifest_b.pages[0].page_id.clone()];
        let stage_a = stage_bytes(temp_dir.path(), "same.png", &png);
        let artifact_a = commit_ink_export(
            &db,
            &manifest_a.document_id,
            &manifest_a.revision,
            &page_a,
            InkExportFormat::Png,
            "export-doc-a",
            &stage_a,
        )
        .unwrap();
        let stage_b = stage_bytes(temp_dir.path(), "same.png", &png);
        let artifact_b = commit_ink_export(
            &db,
            &manifest_b.document_id,
            &manifest_b.revision,
            &page_b,
            InkExportFormat::Png,
            "export-doc-b",
            &stage_b,
        )
        .unwrap();

        assert_eq!(artifact_a.content_hash, artifact_b.content_hash);
        assert_eq!(
            artifact_a.resource_id, artifact_b.resource_id,
            "content-addressed output metadata is appended, never overwritten"
        );
        let conn = db.get_conn_safe().unwrap();
        for (resource_id, artifact) in [
            (&doc_resource_a, &artifact_a),
            (&doc_resource_b, &artifact_b),
        ] {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT metadata_json FROM resources WHERE id = ?1",
                    [resource_id],
                    |row| row.get(0),
                )
                .unwrap();
            let metadata: serde_json::Value =
                serde_json::from_str(raw.as_deref().unwrap()).unwrap();
            assert!(metadata["ink_export_receipts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|receipt| receipt["artifact"]["artifact_id"] == artifact.artifact_id));
        }
        let raw: Option<String> = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&artifact_a.resource_id],
                |row| row.get(0),
            )
            .unwrap();
        let metadata: serde_json::Value = serde_json::from_str(raw.as_deref().unwrap()).unwrap();
        let exports = metadata["ink_exports"].as_array().unwrap();
        assert!(exports
            .iter()
            .any(|entry| entry["artifact_id"] == artifact_a.artifact_id));
        assert!(exports
            .iter()
            .any(|entry| entry["artifact_id"] == artifact_b.artifact_id));
    }

    #[tokio::test]
    async fn cancellation_after_prepare_work_is_queued_prevents_manifest_commit_and_releases_stage()
    {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        let source_blob_refs = VfsBlobRepo::get_blob_with_conn(&conn, &source_hash)
            .unwrap()
            .unwrap()
            .ref_count;
        let files_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);
        let stage_id = stage_bytes(temp_dir.path(), "queued-prepare.png", PNG_1X1);
        let staged_pages = vec![InkStagedPage {
            staged_upload_id: stage_id.clone(),
            width_px: 1,
            height_px: 1,
            source_page_index: None,
        }];
        let cancellation = CancellationToken::new();
        let worker_db = Arc::new(db);
        let worker_db_for_task = worker_db.clone();
        let worker_source_id = source_resource_id.clone();
        let worker_hash = source_hash.clone();
        let worker_stage_id = stage_id.clone();
        let (queued_tx, queued_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker_cancel = cancellation.clone();
        let worker = tokio::task::spawn_blocking(move || {
            queued_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            commit_prepared_source_pages_cancellable(
                &worker_db_for_task,
                &worker_source_id,
                &worker_hash,
                "test-image-converter-v1",
                &staged_pages,
                "queued-prepare-cancelled",
                &worker_cancel,
            )
        });
        queued_rx.await.unwrap();
        cancellation.cancel();
        release_tx.send(()).unwrap();
        let result = worker.await.unwrap();
        let staged_left = crate::staged_upload::take_staged_upload(&worker_stage_id).is_ok();

        assert_eq!(result.unwrap_err().code, "CANCELLED");
        let conn = worker_db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            files_before
        );
        assert_eq!(
            VfsBlobRepo::get_blob_with_conn(&conn, &source_hash)
                .unwrap()
                .unwrap()
                .ref_count,
            source_blob_refs
        );
        assert!(
            !staged_left,
            "cancelled queued prepare must discard its staged PNG"
        );
    }

    #[tokio::test]
    async fn cancellation_after_export_work_is_queued_prevents_vfs_commit_and_releases_stage() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        let manifest = prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "prepare-queued-export-fixture",
        );
        let files_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);
        let page_ids = vec![manifest.pages[0].page_id.clone()];
        let staged_id = stage_bytes(temp_dir.path(), "queued-export.png", &distinct_png());
        let cancellation = CancellationToken::new();
        let worker_db = Arc::new(db);
        let worker_db_for_task = worker_db.clone();
        let document_id = manifest.document_id.clone();
        let revision = manifest.revision.clone();
        let worker_stage = staged_id.clone();
        let worker_cancel = cancellation.clone();
        let (queued_tx, queued_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            queued_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            commit_ink_export_cancellable(
                &worker_db_for_task,
                &document_id,
                &revision,
                &page_ids,
                InkExportFormat::Png,
                "queued-export-cancelled",
                &worker_stage,
                None,
                &worker_cancel,
            )
        });
        queued_rx.await.unwrap();
        cancellation.cancel();
        release_tx.send(()).unwrap();
        let result = worker.await.unwrap();
        let stage_remaining = crate::staged_upload::take_staged_upload(&staged_id).is_ok();

        assert_eq!(result.unwrap_err().code, "CANCELLED");
        let conn = worker_db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            files_before
        );
        assert!(
            !stage_remaining,
            "cancelled queued export must discard its staged file"
        );
    }

    #[tokio::test]
    async fn pending_job_timeout_notifies_frontend_to_abort_staged_output() {
        let bus = PendingInkJobBus::default();
        let pending = bus
            .register(InkJobIdentity {
                request_id: "timeout-notify-request".to_owned(),
                operation_id: "timeout-notify-operation".to_owned(),
                kind: InkJobKind::Export,
                session_id: None,
                tool_call_id: None,
            })
            .unwrap();
        let notified = Arc::new(AtomicBool::new(false));
        let notify = notified.clone();

        let result = wait_pending_ink_job_with_timeout_notify(
            pending,
            Duration::ZERO,
            &CancellationToken::new(),
            move || notify.store(true, Ordering::SeqCst),
        )
        .await;

        assert_eq!(result.unwrap_err().code, "JOB_TIMEOUT");
        assert!(
            notified.load(Ordering::SeqCst),
            "timeout must signal the frontend to abort any staged upload"
        );
    }

    #[test]
    fn pdf_export_retry_reuses_durable_receipt_before_rendering_new_pdf_bytes() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, _, source_hash) = source_file(&conn, &db);
        let manifest = prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "prepare-pdf-retry-fixture",
        );
        let page_ids = vec![manifest.pages[0].page_id.clone()];
        let original_pdf = minimal_pdf();
        let staged_id = stage_bytes(_temp_dir.path(), "first.pdf", &original_pdf);
        let original = commit_ink_export(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Pdf,
            "stable-pdf-operation",
            &staged_id,
        )
        .unwrap();
        drop(conn);
        let mut regenerated_pdf = minimal_pdf();
        regenerated_pdf.extend_from_slice(b"\n% Different renderer timestamp on a fresh render\n");
        assert_ne!(
            VfsBlobRepo::compute_hash(&original_pdf),
            VfsBlobRepo::compute_hash(&regenerated_pdf)
        );

        let retry = load_export_receipt_for_retry(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Pdf,
            "stable-pdf-operation",
            None,
        )
        .unwrap();

        assert_eq!(retry, Some(original));
    }

    #[test]
    fn export_after_original_source_purge_uses_shared_frozen_source_guard() {
        let (temp_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let (source_resource_id, source_file_id, source_hash) = source_file(&conn, &db);
        let manifest = prepared_manifest(
            &db,
            &source_resource_id,
            &source_hash,
            "prepare-purged-source-export",
        );
        let page_ids = vec![manifest.pages[0].page_id.clone()];
        VfsFileRepo::purge_file_with_conn(&conn, db.blobs_dir(), &source_file_id).unwrap();
        VfsBlobRepo::cleanup_unreferenced_with_conn(&conn, db.blobs_dir()).unwrap();
        drop(conn);

        let frozen =
            load_export_inputs(&db, &manifest.document_id, &manifest.revision, &page_ids).unwrap();
        assert!(frozen[0].highlights.is_empty());
        assert!(frozen[0].source_annotation_revision.is_none());
        let snapshot = frozen_snapshot_hash(&frozen).unwrap();
        let output_bytes = distinct_png();
        let staged_id = stage_bytes(
            temp_dir.path(),
            "export-after-source-purge.png",
            &output_bytes,
        );

        let result = commit_ink_export_with_snapshot(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Png,
            "export-after-source-purge",
            &staged_id,
            Some(&snapshot),
        );

        assert!(
            result.is_ok(),
            "export must apply the shared source-purged frozen-input policy: {:?}",
            result.err()
        );
    }

    // Board export is still RED on purpose: these tests pin the smallest
    // backward-compatible contract before the request/load/render path exists.

    #[test]
    fn board_export_request_keeps_page_only_requests_and_accepts_optional_board_payload() {
        let page_only = serde_json::json!({
            "document_id": "file_ink_board_fixture",
            "expected_revision": "r_board_1",
            "page_ids": ["board-surface-page"],
            "format": "pdf",
            "operation_id": "board-export-page-only",
        });
        serde_json::from_value::<InkExportCommandRequest>(page_only)
            .expect("legacy page-only export requests must remain accepted");

        let board = serde_json::json!({
            "document_id": "file_ink_board_fixture",
            "expected_revision": "r_board_1",
            "page_ids": ["board-surface-page"],
            "format": "pdf",
            "operation_id": "board-export-region",
            "board": {
                "region": { "x": -20.0, "y": -10.0, "width": 40.0, "height": 20.0 },
                "page_width": 20.0,
                "page_height": 10.0,
                "paginate": true
            }
        });
        serde_json::from_value::<InkExportCommandRequest>(board)
            .expect("board export requests must accept the optional finite region, page size, and paginate flag");
    }

    #[test]
    fn board_export_without_explicit_region_is_typed_rejected_and_leaves_manifest_unchanged() {
        let (_temp_dir, db) = setup_migrated_test_db();
        let (manifest, _chunk) = saved_board_fixture(&db);
        let surface_page_id = match manifest.surface.as_ref().expect("board surface") {
            InkBoardSurface::Board { page_id, .. } => page_id.clone(),
        };
        let manifest_before = manifest.clone();

        let error = match load_export_inputs(
            &db,
            &manifest.document_id,
            &manifest.revision,
            std::slice::from_ref(&surface_page_id),
        ) {
            Ok(_) => panic!(
                "board export without an explicit region must not fall back to surface bounds"
            ),
            Err(error) => error,
        };

        assert!(
            error.code == "INVALID_ARGUMENT" || error.code == "UNSUPPORTED",
            "board export without explicit region must fail as a typed argument/unsupported error, got {error:?}"
        );

        let conn = db.get_conn_safe().unwrap();
        let after =
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &manifest.document_id)
                .expect("board manifest must reopen unchanged");
        assert_eq!(
            after, manifest_before,
            "rejected board export must not mutate the canonical board"
        );
    }

    #[test]
    fn board_export_grid_is_row_major_and_clips_edge_tiles_to_the_explicit_region() {
        let region = InkRect {
            x: -15.0,
            y: -5.0,
            width: 35.0,
            height: 20.0,
        };

        let pages = board_export_grid(region, 20.0, 10.0, true)
            .expect("paginated board export must produce a finite row-major grid");

        assert_eq!(
            pages.as_slice(),
            &[
                InkRect {
                    x: -15.0,
                    y: -5.0,
                    width: 20.0,
                    height: 10.0,
                },
                InkRect {
                    x: 5.0,
                    y: -5.0,
                    width: 15.0,
                    height: 10.0,
                },
                InkRect {
                    x: -15.0,
                    y: 5.0,
                    width: 20.0,
                    height: 10.0,
                },
                InkRect {
                    x: 5.0,
                    y: 5.0,
                    width: 15.0,
                    height: 10.0,
                },
            ],
            "board grid must walk left-to-right, then top-to-bottom, clipping the final column"
        );
    }

    #[test]
    fn board_export_grid_returns_one_frame_without_pagination_and_rejects_more_than_500_pages() {
        let region = InkRect {
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 20.0,
        };
        let single = board_export_grid(region, 20.0, 20.0, false)
            .expect("a non-paginated board export must be exactly one frame");
        assert_eq!(single.as_slice(), &[region]);

        let over_budget = InkRect {
            x: 0.0,
            y: 0.0,
            width: 501.0,
            height: 1.0,
        };
        let error = board_export_grid(over_budget, 1.0, 1.0, true)
            .expect_err("501 board pages must exceed the export page budget");
        assert_eq!(error.code, "LIMIT_EXCEEDED");
    }

    #[test]
    fn board_export_same_operation_with_different_region_is_conflict_and_writes_nothing() {
        let (temp_dir, db) = setup_migrated_test_db();
        let (manifest, _chunk) = saved_board_fixture(&db);
        let page_ids = vec![board_surface_page_id(&manifest)];
        let region_a = InkRect {
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 20.0,
        };
        let region_b = InkRect {
            x: 1.0,
            y: 0.0,
            width: 40.0,
            height: 20.0,
        };
        let board_a = board_export_request(region_a);
        let board_b = board_export_request(region_b);
        let operation_id = "board-export-same-operation";

        let first_stage = stage_bytes(temp_dir.path(), "board-a.png", &distinct_png());
        let first = commit_ink_board_export_cancellable(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Png,
            operation_id,
            &first_stage,
            None,
            &CancellationToken::new(),
            &board_a,
        )
        .expect("first board export should commit");
        assert_eq!(first.page_ids, page_ids);

        let conn = db.get_conn_safe().unwrap();
        let files_after_first: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        let document_resource_id = VfsFileRepo::get_file_with_conn(&conn, &manifest.document_id)
            .unwrap()
            .unwrap()
            .resource_id
            .unwrap();
        drop(conn);

        let second_stage = stage_bytes(temp_dir.path(), "board-b.png", &distinct_png());
        let rejected = commit_ink_board_export_cancellable(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Png,
            operation_id,
            &second_stage,
            None,
            &CancellationToken::new(),
            &board_b,
        );
        assert_eq!(rejected.unwrap_err().code, "OPERATION_CONFLICT");
        assert!(
            crate::staged_upload::take_staged_upload(&second_stage).is_err(),
            "conflicting board export must consume its staged upload"
        );

        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            files_after_first,
            "conflicting board export must not write another file"
        );
        let raw: Option<String> = conn
            .query_row(
                "SELECT metadata_json FROM resources WHERE id = ?1",
                [&document_resource_id],
                |row| row.get(0),
            )
            .unwrap();
        let metadata: serde_json::Value = serde_json::from_str(raw.as_deref().unwrap()).unwrap();
        assert_eq!(
            metadata["ink_export_receipts"].as_array().unwrap().len(),
            1,
            "conflicting board export must not add a receipt"
        );
    }

    #[test]
    fn board_commit_rejects_crop_and_chunk_drift_without_an_artifact() {
        let (temp_dir, db) = setup_migrated_test_db();
        let (manifest, _chunk) = saved_board_fixture(&db);
        let page_ids = vec![board_surface_page_id(&manifest)];
        let board = board_export_request(InkRect {
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 20.0,
        });
        let before = load_board_export_inputs(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            &board,
        )
        .expect("frozen board inputs");
        let snapshot = frozen_snapshot_hash(&[before]).unwrap();

        let conn = db.get_conn_safe().unwrap();
        let files_before_crop: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        let crop_drift = board_export_request(InkRect {
            x: 1.0,
            y: 0.0,
            width: 40.0,
            height: 20.0,
        });
        let crop_stage = stage_bytes(temp_dir.path(), "board-crop-drift.png", &distinct_png());
        let rejected = commit_ink_board_export_cancellable(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Png,
            "board-crop-drift",
            &crop_stage,
            Some(&snapshot),
            &CancellationToken::new(),
            &crop_drift,
        );
        assert_eq!(rejected.unwrap_err().code, "REVISION_CONFLICT");
        assert!(
            crate::staged_upload::take_staged_upload(&crop_stage).is_err(),
            "drifted board crop must consume its staged upload"
        );
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            files_before_crop,
            "drifted board crop must not create an artifact file"
        );
        drop(conn);

        let mut drifted_chunk = board_chunk_fixture();
        drifted_chunk.chunk_id = "board-export-chunk-drift".to_owned();
        drifted_chunk.objects[0].id = "board-export-object-drift".to_owned();
        drifted_chunk.objects[0].z_index = 1;
        let conn = db.get_conn_safe().unwrap();
        VfsInkBoardRepo::save_chunks_with_conn(
            &conn,
            db.blobs_dir(),
            &manifest.document_id,
            &manifest.revision,
            "board-drift-save",
            std::slice::from_ref(&drifted_chunk),
            &[],
        )
        .expect("board chunk drift");
        let files_before_chunk: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        let chunk_stage = stage_bytes(temp_dir.path(), "board-chunk-drift.png", &distinct_png());
        let rejected = commit_ink_board_export_cancellable(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Png,
            "board-chunk-drift",
            &chunk_stage,
            Some(&snapshot),
            &CancellationToken::new(),
            &board,
        );
        assert_eq!(rejected.unwrap_err().code, "REVISION_CONFLICT");
        assert!(
            crate::staged_upload::take_staged_upload(&chunk_stage).is_err(),
            "drifted board chunk must consume its staged upload"
        );
        let conn = db.get_conn_safe().unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap(),
            files_before_chunk,
            "drifted board chunk must not create an artifact file"
        );
    }

    #[test]
    fn board_commit_entry_failures_consume_the_stage() {
        let (temp_dir, db) = setup_migrated_test_db();
        let (manifest, _chunk) = saved_board_fixture(&db);
        let page_ids = vec![board_surface_page_id(&manifest)];
        let valid = board_export_request(InkRect {
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 20.0,
        });
        let invalid = InkExportBoardRequest {
            page_width: 0.0,
            ..valid.clone()
        };

        let invalid_stage = stage_bytes(temp_dir.path(), "board-invalid.png", &distinct_png());
        let rejected = commit_ink_board_export_cancellable(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Png,
            "board-invalid-request",
            &invalid_stage,
            None,
            &CancellationToken::new(),
            &invalid,
        );
        assert_eq!(rejected.unwrap_err().code, "INVALID_ARGUMENT");
        assert!(
            crate::staged_upload::take_staged_upload(&invalid_stage).is_err(),
            "invalid board request must abort its staged upload before returning"
        );

        let cancelled_stage = stage_bytes(temp_dir.path(), "board-cancelled.png", &distinct_png());
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let rejected = commit_ink_board_export_cancellable(
            &db,
            &manifest.document_id,
            &manifest.revision,
            &page_ids,
            InkExportFormat::Png,
            "board-cancelled-request",
            &cancelled_stage,
            None,
            &cancellation,
            &valid,
        );
        assert_eq!(rejected.unwrap_err().code, "CANCELLED");
        assert!(
            crate::staged_upload::take_staged_upload(&cancelled_stage).is_err(),
            "cancelled board commit must abort its staged upload"
        );
    }
}
