//! ChatV2 DSTU/VFS mutation tools.
//!
//! These tools deliberately call the same Tauri handlers used by the Finder UI so
//! validation, soft-delete semantics, index cleanup, and VFS invariants stay on one
//! backend path. Folder mutations and file upload do not emit DSTU watch events in
//! their handlers, so this executor fills those two notification gaps.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::io::AsyncReadExt;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::runtime_roots::{
    normalize_runtime_relative_path, revalidate_runtime_root, runtime_root_by_id,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::dstu::handler_utils::{emit_watch_event, file_to_dstu_node};
use crate::dstu::types::{DstuNode, DstuWatchEvent};
use crate::vfs::repos::{VfsAttachmentRepo, VfsFolderRepo};
use crate::vfs::{VfsDatabase, VfsFolder};

const DEFAULT_TRASH_LIMIT: u32 = 20;
const MAX_TRASH_LIMIT: u32 = 20;

const TOOL_NAMES: &[&str] = &[
    "dstu_folder_create",
    "dstu_folder_rename",
    "dstu_rename",
    "dstu_move",
    "dstu_delete",
    "dstu_restore",
    "dstu_list_trash",
    "dstu_set_favorite",
    "dstu_purge",
    "dstu_upload_file",
];

fn dstu_error(
    code: &str,
    message: impl Into<String>,
    hint: impl Into<String>,
    retryable: bool,
) -> String {
    json!({
        "code": code,
        "message": message.into(),
        "hint": hint.into(),
        "retryable": retryable,
    })
    .to_string()
}

fn invalid_args(message: impl Into<String>, hint: impl Into<String>) -> String {
    dstu_error("INVALID_ARGS", message, hint, false)
}

fn backend_error(action: &str, error: impl std::fmt::Display) -> String {
    let raw = error.to_string();
    if serde_json::from_str::<Value>(&raw).is_ok() {
        return raw;
    }
    dstu_error(
        "DSTU_OPERATION_FAILED",
        format!("{} failed: {}", action, raw),
        "Refresh the target resource and verify that its path still exists before retrying.",
        false,
    )
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            invalid_args(
                format!("{} must be a non-empty string", key),
                format!("Provide the required '{}' argument.", key),
            )
        })
}

fn optional_string(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Err(invalid_args(
                    format!("{} cannot be empty when provided", key),
                    format!("Omit '{}' or provide a non-empty string.", key),
                ))
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Some(_) => Err(invalid_args(
            format!("{} must be a string", key),
            format!("Correct the type of '{}'.", key),
        )),
    }
}

fn required_bool(args: &Value, key: &str) -> Result<bool, String> {
    args.get(key).and_then(Value::as_bool).ok_or_else(|| {
        invalid_args(
            format!("{} must be a boolean", key),
            format!("Provide '{}' as true or false.", key),
        )
    })
}

fn reject_unknown_args(args: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = args.as_object().ok_or_else(|| {
        invalid_args(
            "tool arguments must be a JSON object",
            "Send named arguments matching the tool schema.",
        )
    })?;
    if let Some(unknown) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid_args(
            format!("unknown argument: {}", unknown),
            "Use only the fields declared by the DSTU tool schema.",
        ));
    }
    Ok(())
}

fn parse_trash_pagination(args: &Value) -> Result<(u32, u32), String> {
    reject_unknown_args(args, &["limit", "offset"])?;
    let raw_limit = args
        .get("limit")
        .map(|value| {
            value.as_u64().ok_or_else(|| {
                invalid_args("limit must be an integer", "Use a value from 1 to 20.")
            })
        })
        .transpose()?
        .unwrap_or(DEFAULT_TRASH_LIMIT as u64);
    if !(1..=MAX_TRASH_LIMIT as u64).contains(&raw_limit) {
        return Err(invalid_args(
            "limit must be between 1 and 20",
            "Reduce the page size and use offset to continue reading.",
        ));
    }
    let raw_offset = args
        .get("offset")
        .map(|value| {
            value.as_u64().ok_or_else(|| {
                invalid_args("offset must be a non-negative integer", "Use offset >= 0.")
            })
        })
        .transpose()?
        .unwrap_or(0);
    let offset = u32::try_from(raw_offset).map_err(|_| {
        invalid_args(
            "offset exceeds the supported range",
            "Use a smaller pagination offset.",
        )
    })?;
    Ok((raw_limit as u32, offset))
}

fn vfs_db(ctx: &ExecutionContext) -> Result<Arc<VfsDatabase>, String> {
    ctx.vfs_db
        .clone()
        .or_else(|| {
            ctx.window_ref()
                .try_state::<Arc<VfsDatabase>>()
                .map(|state| state.inner().clone())
        })
        .ok_or_else(|| {
            dstu_error(
                "VFS_UNAVAILABLE",
                "VFS database is not available",
                "Restart the desktop app and retry after storage initialization completes.",
                true,
            )
        })
}

fn managed_state_error(name: &str) -> String {
    dstu_error(
        "SERVICE_UNAVAILABLE",
        format!("required backend service is unavailable: {}", name),
        "Restart the desktop app and retry after all backend services initialize.",
        true,
    )
}

fn folder_node(db: &VfsDatabase, folder: &VfsFolder) -> Result<DstuNode, String> {
    let folder_path = VfsFolderRepo::build_folder_path(db, &folder.id)
        .map_err(|error| backend_error("build folder path", error))?;
    let path = format!("/{}", folder_path.trim_matches('/'));
    Ok(DstuNode::folder(&folder.id, path, &folder.title)
        .with_timestamps(folder.created_at, folder.updated_at)
        .with_metadata(json!({
            "parentId": folder.parent_id,
            "icon": folder.icon,
            "color": folder.color,
            "isExpanded": folder.is_expanded,
            "isFavorite": folder.is_favorite,
            "sortOrder": folder.sort_order,
        })))
}

fn mime_type_from_name(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("heic") => "image/heic",
        Some("heif") => "image/heif",
        Some("pdf") => "application/pdf",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("xls") => "application/vnd.ms-excel",
        Some("xlsb") => "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
        Some("ods") => "application/vnd.oasis.opendocument.spreadsheet",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("txt") => "text/plain",
        Some("md" | "markdown") => "text/markdown",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("html" | "htm") => "text/html",
        Some("epub") => "application/epub+zip",
        Some("rtf") => "application/rtf",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        _ => "application/octet-stream",
    }
}

fn ensure_no_symlink_components(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            continue;
        };
        current.push(part);
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|error| backend_error("inspect upload source", error))?;
        if metadata.file_type().is_symlink() {
            return Err(dstu_error(
                "UNSAFE_UPLOAD_PATH",
                "upload source must not traverse symbolic links",
                "Use the canonical file inside an authorized runtime root.",
                false,
            ));
        }
    }
    Ok(())
}

fn resolve_runtime_upload_path(
    root_id: &str,
    relative_path: &str,
    ctx: &ExecutionContext,
) -> Result<PathBuf, String> {
    let database = ctx
        .main_db
        .as_ref()
        .ok_or_else(|| managed_state_error("main database"))?;
    let relative = normalize_runtime_relative_path(Some(relative_path)).map_err(|error| {
        dstu_error(
            "INVALID_UPLOAD_PATH",
            error,
            "Use a relative path below the selected runtime root without '..'.",
            false,
        )
    })?;
    if relative.as_os_str().is_empty() {
        return Err(invalid_args(
            "relative_path must identify a file",
            "Provide the file path relative to root_id.",
        ));
    }
    let root = runtime_root_by_id(
        ctx.window_ref().app_handle(),
        database,
        &ctx.session_id,
        ctx.skill_package_roots.as_ref(),
        Some(root_id),
        false,
    )
    .map_err(|error| backend_error("resolve runtime root", error))?;
    let root_canon = revalidate_runtime_root(database, &root)
        .map_err(|error| backend_error("revalidate runtime root", error))?;
    ensure_no_symlink_components(&root_canon, &relative)?;
    let target = root_canon.join(&relative);
    let canonical = target
        .canonicalize()
        .map_err(|error| backend_error("resolve upload source", error))?;
    if !canonical.starts_with(&root_canon) {
        return Err(dstu_error(
            "UNSAFE_UPLOAD_PATH",
            "upload source escapes the selected runtime root",
            "Use a file contained by root_id.",
            false,
        ));
    }
    Ok(canonical)
}

fn required_upload_locator(args: &Value) -> Result<(String, String), String> {
    let root_id = optional_string(args, "root_id")?;
    let relative_path = optional_string(args, "relative_path")?;

    match (root_id, relative_path) {
        (Some(root_id), Some(relative_path)) => Ok((root_id, relative_path)),
        (None, None) => Err(invalid_args(
            "an upload source is required",
            "Provide root_id and relative_path from an authorized runtime source.",
        )),
        _ => Err(invalid_args(
            "upload source is incomplete",
            "Provide both root_id and relative_path.",
        )),
    }
}

fn resolve_upload_path(args: &Value, ctx: &ExecutionContext) -> Result<PathBuf, String> {
    let (root_id, relative_path) = required_upload_locator(args)?;
    resolve_runtime_upload_path(&root_id, &relative_path, ctx)
}

async fn read_upload_bytes(path: &Path, mime_type: &str) -> Result<Vec<u8>, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| backend_error("stat upload source", error))?;
    if !metadata.is_file() {
        return Err(dstu_error(
            "INVALID_UPLOAD_SOURCE",
            "upload source is not a regular file",
            "Choose a supported file rather than a directory or device.",
            false,
        ));
    }
    let max_bytes = VfsAttachmentRepo::max_upload_size_bytes(mime_type);
    if metadata.len() > max_bytes as u64 {
        return Err(dstu_error(
            "UPLOAD_TOO_LARGE",
            format!(
                "file is {} bytes; maximum for this type is {} bytes",
                metadata.len(),
                max_bytes
            ),
            "Choose a smaller file.",
            false,
        ));
    }

    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| backend_error("open upload source", error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| backend_error("read upload source", error))?;
    if bytes.len() > max_bytes {
        return Err(dstu_error(
            "UPLOAD_TOO_LARGE",
            "file grew beyond the upload limit while being read",
            "Retry only after the source file is no longer changing.",
            false,
        ));
    }
    Ok(bytes)
}

pub struct DstuToolExecutor;

impl DstuToolExecutor {
    pub fn new() -> Self {
        Self
    }

    async fn execute_folder_create(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        reject_unknown_args(args, &["title", "parent_id", "icon", "color"])?;
        let title = required_string(args, "title")?;
        let parent_id = optional_string(args, "parent_id")?;
        let icon = optional_string(args, "icon")?;
        let color = optional_string(args, "color")?;
        let db = vfs_db(ctx)?;
        let write_db = db.clone();
        let folder = tokio::task::spawn_blocking(move || {
            crate::dstu::folder_handlers::dstu_folder_create_with_db(
                &write_db, title, parent_id, icon, color,
            )
        })
        .await
        .map_err(|error| backend_error("create folder task", error))?
        .map_err(|error| backend_error("create folder", error))?;
        let node = folder_node(&db, &folder)?;
        emit_watch_event(
            ctx.window_ref(),
            DstuWatchEvent::created(&node.path, node.clone()),
        );
        Ok(json!({
            "success": true,
            "action": "folder_create",
            "folder": folder,
            "node": node,
            "path": node.path,
            "entity_ids": [node.id],
        }))
    }

    async fn execute_folder_rename(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        reject_unknown_args(args, &["folder_id", "title"])?;
        let folder_id = required_string(args, "folder_id")?;
        let title = required_string(args, "title")?;
        let state = ctx
            .window_ref()
            .try_state::<Arc<VfsDatabase>>()
            .ok_or_else(|| managed_state_error("VFS database"))?;
        crate::dstu::folder_handlers::dstu_folder_rename(state, folder_id.clone(), title)
            .await
            .map_err(|error| backend_error("rename folder", error))?;
        let db = vfs_db(ctx)?;
        let folder = VfsFolderRepo::get_folder(&db, &folder_id)
            .map_err(|error| backend_error("read renamed folder", error))?
            .ok_or_else(|| {
                dstu_error(
                    "DSTU_INCONSISTENT_RESULT",
                    "folder was renamed but could not be loaded",
                    "Refresh the folder tree before retrying any mutation.",
                    true,
                )
            })?;
        let node = folder_node(&db, &folder)?;
        emit_watch_event(
            ctx.window_ref(),
            DstuWatchEvent::updated(&node.path, node.clone()),
        );
        Ok(json!({
            "success": true,
            "action": "folder_rename",
            "folder": folder,
            "node": node,
            "path": node.path,
            "entity_ids": [node.id],
        }))
    }

    async fn execute_rename(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        reject_unknown_args(args, &["path", "new_name"])?;
        let path = required_string(args, "path")?;
        let new_name = required_string(args, "new_name")?;
        let state = ctx
            .window_ref()
            .try_state::<Arc<VfsDatabase>>()
            .ok_or_else(|| managed_state_error("VFS database"))?;
        let node = crate::dstu::handlers::dstu_rename(
            path.clone(),
            new_name,
            ctx.window_ref().clone(),
            state,
        )
        .await
        .map_err(|error| backend_error("rename resource", error))?;
        Ok(json!({
            "success": true,
            "action": "rename",
            "previous_path": path,
            "path": node.path,
            "node": node,
            "entity_ids": [node.id],
        }))
    }

    async fn execute_move(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        reject_unknown_args(args, &["src", "dst"])?;
        let src = required_string(args, "src")?;
        let dst = required_string(args, "dst")?;
        let state = ctx
            .window_ref()
            .try_state::<Arc<VfsDatabase>>()
            .ok_or_else(|| managed_state_error("VFS database"))?;
        let node = crate::dstu::handlers::dstu_move(
            src.clone(),
            dst.clone(),
            ctx.window_ref().clone(),
            state,
        )
        .await
        .map_err(|error| backend_error("move resource", error))?;
        Ok(json!({
            "success": true,
            "action": "move",
            "source_path": src,
            "destination_path": dst,
            "path": node.path,
            "node": node,
            "entity_ids": [node.id],
        }))
    }

    async fn execute_delete(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        reject_unknown_args(args, &["path"])?;
        let path = required_string(args, "path")?;
        let db = ctx
            .window_ref()
            .try_state::<Arc<VfsDatabase>>()
            .ok_or_else(|| managed_state_error("VFS database"))?;
        let lance = ctx
            .window_ref()
            .try_state::<Arc<crate::vfs::lance_store::VfsLanceStore>>()
            .ok_or_else(|| managed_state_error("VFS vector store"))?;
        crate::dstu::handlers::dstu_delete(path.clone(), ctx.window_ref().clone(), db, lance)
            .await
            .map_err(|error| backend_error("delete resource", error))?;
        Ok(json!({
            "success": true,
            "action": "delete",
            "path": path,
        }))
    }

    async fn execute_restore(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        reject_unknown_args(args, &["path"])?;
        let path = required_string(args, "path")?;
        let state = ctx
            .window_ref()
            .try_state::<Arc<VfsDatabase>>()
            .ok_or_else(|| managed_state_error("VFS database"))?;
        let node =
            crate::dstu::handlers::dstu_restore(path.clone(), ctx.window_ref().clone(), state)
                .await
                .map_err(|error| backend_error("restore resource", error))?;
        Ok(json!({
            "success": true,
            "action": "restore",
            "path": node.path,
            "trash_path": path,
            "node": node,
            "entity_ids": [node.id],
        }))
    }

    async fn execute_list_trash(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let (limit, offset) = parse_trash_pagination(args)?;
        let probe_limit = limit.saturating_add(1);
        let db = vfs_db(ctx)?;
        let mut items = crate::dstu::trash_handlers::list_trash_with_db(&db, probe_limit, offset)
            .map_err(|error| backend_error("list trash", error))?;
        let has_more = items.len() > limit as usize;
        if has_more {
            items.truncate(limit as usize);
        }
        let count = items.len();
        let next_offset = has_more.then(|| offset.saturating_add(count as u32));
        Ok(json!({
            "success": true,
            "action": "list_trash",
            "items": items,
            "count": count,
            "limit": limit,
            "offset": offset,
            "has_more": has_more,
            "next_offset": next_offset,
        }))
    }

    async fn execute_set_favorite(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        reject_unknown_args(args, &["path", "favorite"])?;
        let path = required_string(args, "path")?;
        let favorite = required_bool(args, "favorite")?;
        let state = ctx
            .window_ref()
            .try_state::<Arc<VfsDatabase>>()
            .ok_or_else(|| managed_state_error("VFS database"))?;
        crate::dstu::handlers::dstu_set_favorite(
            path.clone(),
            favorite,
            ctx.window_ref().clone(),
            state,
        )
        .await
        .map_err(|error| backend_error("set favorite", error))?;
        Ok(json!({
            "success": true,
            "action": "set_favorite",
            "path": path,
            "favorite": favorite,
        }))
    }

    async fn execute_purge(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        reject_unknown_args(args, &["path"])?;
        let path = required_string(args, "path")?;
        let db = ctx
            .window_ref()
            .try_state::<Arc<VfsDatabase>>()
            .ok_or_else(|| managed_state_error("VFS database"))?;
        let lance = ctx
            .window_ref()
            .try_state::<Arc<crate::vfs::lance_store::VfsLanceStore>>()
            .ok_or_else(|| managed_state_error("VFS vector store"))?;
        crate::dstu::handlers::dstu_purge(path.clone(), ctx.window_ref().clone(), db, lance)
            .await
            .map_err(|error| backend_error("purge resource", error))?;
        Ok(json!({
            "success": true,
            "action": "purge",
            "path": path,
        }))
    }

    async fn execute_upload_file(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        reject_unknown_args(
            args,
            &["root_id", "relative_path", "folder_id", "name", "mime_type"],
        )?;
        let source_path = resolve_upload_path(args, ctx)?;
        let source_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                invalid_args(
                    "upload source has no valid UTF-8 file name",
                    "Provide an explicit name or select a normally named file.",
                )
            })?;
        let name = optional_string(args, "name")?.unwrap_or_else(|| source_name.to_string());
        if name.len() > 255
            || name.chars().any(char::is_control)
            || Path::new(&name).components().count() != 1
        {
            return Err(invalid_args(
                "name must be a plain file name of at most 255 bytes",
                "Remove path separators and control characters from name.",
            ));
        }
        let mime_type = optional_string(args, "mime_type")?
            .unwrap_or_else(|| mime_type_from_name(&name).to_string())
            .to_ascii_lowercase();
        if !VfsAttachmentRepo::is_supported_upload_type(&name, &mime_type) {
            return Err(dstu_error(
                "UNSUPPORTED_FILE_TYPE",
                format!("unsupported file type: {} ({})", name, mime_type),
                "Use a supported image, PDF, Office, text, ebook, audio, or video file.",
                false,
            ));
        }
        let folder_id = optional_string(args, "folder_id")?;
        let bytes = read_upload_bytes(&source_path, &mime_type).await?;
        if ctx.is_cancelled() {
            return Err(dstu_error(
                "CANCELLED",
                "upload cancelled before VFS mutation",
                "No VFS file was created; retry only if still needed.",
                true,
            ));
        }

        let vfs_state = ctx
            .window_ref()
            .try_state::<Arc<VfsDatabase>>()
            .ok_or_else(|| managed_state_error("VFS database"))?;
        let llm_state = ctx
            .window_ref()
            .try_state::<Arc<crate::llm_manager::LLMManager>>()
            .ok_or_else(|| managed_state_error("LLM manager"))?;
        let database_state = ctx
            .window_ref()
            .try_state::<Arc<crate::database::Database>>()
            .ok_or_else(|| managed_state_error("main database"))?;
        let pdf_state = ctx
            .window_ref()
            .try_state::<Arc<crate::vfs::pdf_processing_service::PdfProcessingService>>()
            .ok_or_else(|| managed_state_error("PDF processing service"))?;
        let app_handle = {
            use tauri::Manager;
            ctx.window_ref().app_handle().clone()
        };
        let upload = crate::vfs::handlers::vfs_upload_file(
            app_handle,
            crate::vfs::handlers::VfsUploadFileParams {
                name: name.clone(),
                mime_type: mime_type.clone(),
                base64_content: BASE64.encode(bytes),
                file_type: None,
                folder_id: folder_id.clone(),
            },
            vfs_state,
            llm_state,
            database_state,
            pdf_state,
        )
        .await
        .map_err(|error| backend_error("upload file", error))?;

        let node = file_to_dstu_node(&upload.file);
        let event = if upload.is_new {
            DstuWatchEvent::created(&node.path, node.clone())
        } else {
            DstuWatchEvent::updated(&node.path, node.clone())
        };
        emit_watch_event(ctx.window_ref(), event);
        Ok(json!({
            "success": true,
            "action": "upload_file",
            "node": node,
            "source_id": upload.source_id,
            "resource_id": upload.file.resource_id,
            "path": node.path,
            "name": upload.file.file_name,
            "mime_type": upload.file.mime_type,
            "size": upload.file.size,
            "folder_id": folder_id,
            "is_new": upload.is_new,
            "resource_hash": upload.resource_hash,
            "ocr_status": upload.ocr_status,
            "index_status": upload.index_status,
            "entity_ids": [node.id],
        }))
    }
}

impl Default for DstuToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for DstuToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        TOOL_NAMES.contains(&strip_tool_namespace(tool_name))
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let output = match tool_name {
            "dstu_folder_create" => self.execute_folder_create(&call.arguments, ctx).await,
            "dstu_folder_rename" => self.execute_folder_rename(&call.arguments, ctx).await,
            "dstu_rename" => self.execute_rename(&call.arguments, ctx).await,
            "dstu_move" => self.execute_move(&call.arguments, ctx).await,
            "dstu_delete" => self.execute_delete(&call.arguments, ctx).await,
            "dstu_restore" => self.execute_restore(&call.arguments, ctx).await,
            "dstu_list_trash" => self.execute_list_trash(&call.arguments, ctx).await,
            "dstu_set_favorite" => self.execute_set_favorite(&call.arguments, ctx).await,
            "dstu_purge" => self.execute_purge(&call.arguments, ctx).await,
            "dstu_upload_file" => self.execute_upload_file(&call.arguments, ctx).await,
            _ => Err(dstu_error(
                "UNKNOWN_TOOL",
                format!("unsupported DSTU tool: {}", call.name),
                "Use one of the registered builtin-dstu_* tools.",
                false,
            )),
        };
        let duration_ms = started.elapsed().as_millis() as u64;

        let result = match output {
            Ok(output) => {
                ctx.emitter.emit_end_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({"result": output, "durationMs": duration_ms})),
                    ctx.variant_id.as_deref(),
                    ctx.skill_state_version,
                    ctx.round_id.as_deref(),
                );
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                )
            }
            Err(error) => {
                ctx.emitter.emit_error_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    &error,
                    ctx.variant_id.as_deref(),
                    ctx.skill_state_version,
                    ctx.round_id.as_deref(),
                );
                ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                )
            }
        };
        if let Err(error) = ctx.save_tool_block(&result) {
            log::warn!("[DstuToolExecutor] failed to save tool block: {}", error);
        }
        Ok(result)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            "dstu_list_trash" | "dstu_set_favorite" => ToolSensitivity::Low,
            "dstu_purge" => ToolSensitivity::High,
            _ => ToolSensitivity::Medium,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        if strip_tool_namespace(tool_name) == "dstu_list_trash" {
            ToolConcurrency::ReadOnly
        } else {
            ToolConcurrency::Serial
        }
    }

    fn name(&self) -> &'static str {
        "DstuToolExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_vfs() -> (tempfile::TempDir, VfsDatabase) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = tempfile::tempdir().expect("create VFS test directory");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("apply production VFS migrations");
        let db = VfsDatabase::new(temp_dir.path()).expect("open migrated VFS database");
        (temp_dir, db)
    }

    #[test]
    fn handles_exact_dstu_tool_surface() {
        let executor = DstuToolExecutor::new();
        for tool in TOOL_NAMES {
            assert!(executor.can_handle(tool), "{}", tool);
            assert!(
                executor.can_handle(&format!("builtin-{}", tool)),
                "{}",
                tool
            );
        }
        assert!(!executor.can_handle("builtin-resource_read"));
        assert!(!executor.can_handle("builtin-dstu_empty_trash"));
    }

    #[test]
    fn risk_levels_match_product_contract() {
        let executor = DstuToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-dstu_list_trash"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-dstu_set_favorite"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-dstu_purge"),
            ToolSensitivity::High
        );
        for tool in TOOL_NAMES {
            if matches!(
                *tool,
                "dstu_list_trash" | "dstu_set_favorite" | "dstu_purge"
            ) {
                continue;
            }
            assert_eq!(executor.sensitivity_level(tool), ToolSensitivity::Medium);
        }
    }

    #[test]
    fn list_trash_is_the_only_parallel_read() {
        let executor = DstuToolExecutor::new();
        assert_eq!(
            executor.concurrency_class("builtin-dstu_list_trash"),
            ToolConcurrency::ReadOnly
        );
        assert_eq!(
            executor.concurrency_class("builtin-dstu_set_favorite"),
            ToolConcurrency::Serial
        );
    }

    #[test]
    fn secx_08_upload_source_requires_managed_runtime_locator() {
        assert_eq!(
            required_upload_locator(&json!({
                "root_id": "temp",
                "relative_path": "attachments/a.pdf"
            }))
            .unwrap(),
            ("temp".to_string(), "attachments/a.pdf".to_string())
        );
        assert!(required_upload_locator(&json!({})).is_err());
        assert!(required_upload_locator(&json!({"root_id": "temp"})).is_err());
        assert!(required_upload_locator(&json!({"relative_path": "a.pdf"})).is_err());
        assert!(normalize_runtime_relative_path(Some("/tmp/a.pdf")).is_err());
        assert!(normalize_runtime_relative_path(Some("../a.pdf")).is_err());
        assert!(reject_unknown_args(
            &json!({"local_path": "/tmp/a.pdf"}),
            &["root_id", "relative_path", "folder_id", "name", "mime_type"]
        )
        .is_err());
    }

    #[test]
    fn mime_inference_covers_primary_document_types() {
        assert_eq!(mime_type_from_name("a.pdf"), "application/pdf");
        assert_eq!(mime_type_from_name("a.PNG"), "image/png");
        assert_eq!(
            mime_type_from_name("a.docx"),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert_eq!(mime_type_from_name("a.unknown"), "application/octet-stream");
    }

    #[test]
    fn structured_errors_are_machine_readable() {
        let raw = invalid_args("bad", "fix it");
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["code"], "INVALID_ARGS");
        assert_eq!(parsed["retryable"], false);
    }

    #[test]
    fn trash_pagination_matches_global_read_limit() {
        assert_eq!(DEFAULT_TRASH_LIMIT, 20);
        assert_eq!(MAX_TRASH_LIMIT, 20);
        assert_eq!(parse_trash_pagination(&json!({})).unwrap(), (20, 0));
        assert_eq!(
            parse_trash_pagination(&json!({"limit": 1, "offset": 7})).unwrap(),
            (1, 7)
        );
        for arguments in [
            json!({"limit": 0}),
            json!({"limit": 21}),
            json!({"offset": -1}),
            json!({"unknown": true}),
        ] {
            assert!(parse_trash_pagination(&arguments).is_err(), "{arguments}");
        }
        assert!(reject_unknown_args(&json!({"title": "ok", "extra": 1}), &["title"]).is_err());
        assert!(required_string(&json!({"title": "  "}), "title").is_err());
    }

    #[test]
    fn folder_create_and_trash_listing_use_real_migrated_vfs_repository() {
        let (_temp_dir, db) = setup_vfs();
        let folder = crate::dstu::folder_handlers::dstu_folder_create_with_db(
            &db,
            "Agent repository folder".to_string(),
            None,
            Some("folder".to_string()),
            Some("#336699".to_string()),
        )
        .expect("create folder through production core");

        let persisted = VfsFolderRepo::get_folder(&db, &folder.id)
            .expect("read created folder")
            .expect("folder persisted");
        assert_eq!(persisted.title, "Agent repository folder");
        assert_eq!(persisted.color.as_deref(), Some("#336699"));

        VfsFolderRepo::delete_folder(&db, &folder.id).expect("soft-delete folder");
        let trash = crate::dstu::trash_handlers::list_trash_with_db(&db, 20, 0)
            .expect("list trash through production core");
        let trashed = trash
            .iter()
            .find(|node| node.id == folder.id)
            .expect("deleted folder appears in global trash listing");
        assert_eq!(trashed.path, format!("/_trash/{}", folder.id));
    }
}
