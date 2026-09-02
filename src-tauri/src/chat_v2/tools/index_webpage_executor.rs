//! Agent-safe VFS indexing inspection/rebuild and webpage archiving tools.
//!
//! The three tools in this module deliberately reuse the VFS SSOT rather than
//! maintaining a second, chat-only index:
//! - `builtin-index_status` reads resource/index/unit/OCR state with bounded
//!   output;
//! - `builtin-index_rebuild` runs the production full-indexing pipeline;
//! - `builtin-webpage_save` stores a fetched Markdown page as a VFS file,
//!   records its source metadata, and queues its units for indexing.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use url::Url;

use super::arg_utils::with_localized_message;
use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::dstu::handler_utils::{emit_watch_event, file_to_dstu_node};
use crate::dstu::types::DstuWatchEvent;
use crate::vfs::embedding_service::EmbeddingProgressCallback;
use crate::vfs::index_service::VfsIndexService;
use crate::vfs::indexing::VfsFullIndexingService;
use crate::vfs::repos::{
    index_unit_repo, VfsBlobRepo, VfsFileRepo, VfsFolderRepo, VfsIndexStateRepo, VfsResourceRepo,
};
use crate::vfs::unit_builder::UnitBuildInput;
use crate::vfs::{VfsFolderItem, VfsResourceMetadata};

const INDEX_STATUS_TOOL: &str = "index_status";
const INDEX_REBUILD_TOOL: &str = "index_rebuild";
const WEBPAGE_SAVE_TOOL: &str = "webpage_save";

const MAX_PAGE_SIZE: u32 = 20;
const DEFAULT_PAGE_SIZE: u32 = 20;
const MAX_PREVIEW_CHARS: usize = 2_000;
const MAX_UNIT_PREVIEW_CHARS: usize = 500;
const MAX_OCR_PAGE_PREVIEW_CHARS: usize = 500;
const MAX_OCR_PAGES: usize = 20;
const MAX_WEBPAGE_CONTENT_CHARS: usize = 1_000_000;
const MAX_WEBPAGE_CONTENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 300;
const MAX_URL_CHARS: usize = 4_096;
const MAX_ID_CHARS: usize = 200;

/// Agent-facing VFS index tools.
pub struct IndexWebpageToolExecutor;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebpageSaveDisposition {
    Created,
    Restored,
    Existing,
}

impl IndexWebpageToolExecutor {
    pub fn new() -> Self {
        Self
    }

    async fn execute_status(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let args = arguments_object(arguments, &["resource_id", "page", "page_size"])?;
        let page = optional_u32(args, "page", 1, 1, u32::MAX)?;
        let page_size = optional_u32(args, "page_size", DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)?;
        let resource_id = optional_resource_id(args, "resource_id")?;
        let db = vfs_db(ctx)?;
        let service = VfsIndexService::new(db.clone());
        let summary = service
            .get_status_summary()
            .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?;

        let mut output = json!({
            "success": true,
            "scope": resource_id.as_deref().unwrap_or("all"),
            "summary": summary,
            "units": [],
            "page": page,
            "pageSize": page_size,
            "totalUnits": 0,
            "hasMore": false,
        });

        let Some(resource_id) = resource_id else {
            return Ok(localized_success(
                output,
                "chat.tools.index.status",
                json!({ "scope": "all" }),
                "已读取全局索引状态。",
                "Read the global index status.",
            ));
        };

        let resource = VfsResourceRepo::get_resource(&db, &resource_id)
            .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?
            .ok_or_else(|| {
                tool_error(
                    "RESOURCE_NOT_FOUND",
                    format!("Resource '{resource_id}' was not found."),
                    "Use a current VFS resource ID and retry.",
                    false,
                )
            })?;

        let index_state = VfsIndexStateRepo::get_index_state(&db, &resource_id)
            .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?;
        let file = file_for_resource(&db, &resource)?;
        let ocr = read_ocr_snapshot(&db, &resource_id, file.as_ref())?;
        let statuses = service
            .get_resource_units(&resource_id)
            .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?;
        let raw_units = {
            let conn = db
                .get_conn_safe()
                .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?;
            index_unit_repo::get_by_resource(&conn, &resource_id)
                .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?
        };
        let raw_by_id: HashMap<String, _> = raw_units
            .into_iter()
            .map(|unit| (unit.id.clone(), unit))
            .collect();

        let total_units = statuses.len();
        let offset = ((page - 1) as usize).saturating_mul(page_size as usize);
        let units = statuses
            .into_iter()
            .skip(offset)
            .take(page_size as usize)
            .map(|status| {
                let mut value = serde_json::to_value(status).unwrap_or_else(|_| json!({}));
                if let Some(unit) = raw_by_id.get(value["unitId"].as_str().unwrap_or_default()) {
                    let (preview, truncated) =
                        bounded_text(unit.text_content.as_deref(), MAX_UNIT_PREVIEW_CHARS);
                    if let Some(object) = value.as_object_mut() {
                        object.insert("textPreview".to_string(), Value::String(preview));
                        object.insert("textPreviewTruncated".to_string(), Value::Bool(truncated));
                    }
                }
                value
            })
            .collect::<Vec<_>>();

        let resource_metadata = resource
            .metadata
            .as_ref()
            .and_then(|metadata| serde_json::to_value(metadata).ok());
        if let Some(object) = output.as_object_mut() {
            object.insert("resourceId".to_string(), Value::String(resource_id.clone()));
            object.insert(
                "resourceType".to_string(),
                Value::String(resource.resource_type.to_string()),
            );
            object.insert(
                "resourceMetadata".to_string(),
                resource_metadata.unwrap_or(Value::Null),
            );
            object.insert(
                "indexState".to_string(),
                serde_json::to_value(index_state.unwrap_or_default()).unwrap_or(Value::Null),
            );
            object.insert("ocr".to_string(), ocr);
            object.insert("units".to_string(), Value::Array(units));
            object.insert("totalUnits".to_string(), json!(total_units));
            object.insert(
                "hasMore".to_string(),
                json!(offset.saturating_add(page_size as usize) < total_units),
            );
        }

        Ok(localized_success(
            output,
            "chat.tools.index.status",
            json!({ "scope": resource_id }),
            "已读取资源索引、OCR 和提取文本状态。",
            "Read the resource index, OCR, and extracted-text status.",
        ))
    }

    async fn execute_rebuild(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let args = arguments_object(arguments, &["resource_id", "folder_id"])?;
        let resource_id = required_resource_id(args, "resource_id")?;
        let folder_id = optional_id(args, "folder_id")?;
        if ctx.is_cancelled() {
            return Err(tool_error(
                "CANCELLED",
                "Index rebuild was cancelled before any index mutation.",
                "Retry only if the resource still needs rebuilding.",
                true,
            ));
        }
        let db = vfs_db(ctx)?;
        ensure_rebuild_target(&db, &resource_id)?;
        // 阶段间隙取消检查点：目标校验通过后、获取重量级依赖之前。
        if ctx.is_cancelled() {
            return Err(tool_error(
                "CANCELLED",
                "Index rebuild was cancelled after target validation, before any index mutation.",
                "Retry only if the resource still needs rebuilding.",
                true,
            ));
        }
        let llm_manager = ctx.llm_manager.clone().ok_or_else(|| {
            tool_error(
                "DEPENDENCY_UNAVAILABLE",
                "The LLM manager is unavailable for embedding generation.",
                "Retry after the desktop app finishes starting, or configure an embedding model in Settings.",
                true,
            )
        })?;
        let lance_store = ctx.vfs_lance_store.clone().ok_or_else(|| {
            tool_error(
                "DEPENDENCY_UNAVAILABLE",
                "The VFS vector store is unavailable.",
                "Retry after the desktop app finishes starting.",
                true,
            )
        })?;

        let app_handle = ctx.window_ref().app_handle().clone();
        let progress_resource_id = resource_id.clone();
        let progress_block_id = ctx.block_id.clone();
        let progress_app = app_handle.clone();
        let progress_callback: EmbeddingProgressCallback = Box::new(move |done, total| {
            let progress = if total == 0 {
                0
            } else {
                ((done as f64 / total as f64) * 100.0).round() as u32
            };
            let _ = progress_app.emit(
                "vfs-index-progress",
                json!({
                    "type": "agent_rebuild_progress",
                    "resourceId": progress_resource_id,
                    "blockId": progress_block_id,
                    "current": done,
                    "total": total,
                    "progress": progress,
                }),
            );
        });
        // 阶段间隙取消检查点：依赖就绪后、发出 started 事件并进入重建管线之前。
        // 管线运行期间的取消由注册表派生的 scoped token 传播处理。
        if ctx.is_cancelled() {
            return Err(tool_error(
                "CANCELLED",
                "Index rebuild was cancelled after preflight, before any index mutation.",
                "Retry only if the resource still needs rebuilding.",
                true,
            ));
        }
        let _ = app_handle.emit(
            "vfs-index-progress",
            json!({
                "type": "agent_rebuild_started",
                "resourceId": resource_id,
                "blockId": ctx.block_id,
            }),
        );

        let started = Instant::now();
        let mut service = VfsFullIndexingService::new(db.clone(), llm_manager, lance_store)
            .map_err(|error| backend_error("INDEX_REBUILD_FAILED", error.to_string(), true))?;
        service.set_app_handle(app_handle.clone());
        let result = service
            .reindex_resource(&resource_id, folder_id.as_deref(), Some(progress_callback))
            .await;
        let duration_ms = started.elapsed().as_millis() as u64;

        match result {
            Ok((chunks, embedding_dim)) => {
                let _ = app_handle.emit(
                    "vfs-index-progress",
                    json!({
                        "type": "agent_rebuild_completed",
                        "resourceId": resource_id,
                        "blockId": ctx.block_id,
                        "chunks": chunks,
                        "embeddingDim": embedding_dim,
                    }),
                );
                let output = localized_success(
                    json!({
                        "success": true,
                        "resourceId": resource_id,
                        "status": "indexed",
                        "chunks": chunks,
                        "embeddingDim": embedding_dim,
                        "durationMs": duration_ms,
                        // 前端可按 blockId 订阅 vfs-index-progress 的
                        // agent_rebuild_progress 事件渲染进度条。
                        "blockId": ctx.block_id,
                        "progressEvent": "vfs-index-progress",
                    }),
                    "chat.tools.index.rebuild",
                    json!({ "resourceId": resource_id }),
                    "已完成资源索引重建。",
                    "Rebuilt the resource index.",
                );
                Ok(output)
            }
            Err(error) => {
                let _ = app_handle.emit(
                    "vfs-index-progress",
                    json!({
                        "type": "agent_rebuild_failed",
                        "resourceId": resource_id,
                        "blockId": ctx.block_id,
                        "error": error.to_string(),
                    }),
                );
                Err(backend_error(
                    "INDEX_REBUILD_FAILED",
                    error.to_string(),
                    true,
                ))
            }
        }
    }

    async fn execute_webpage_save(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let args = arguments_object(
            arguments,
            &["url", "title", "content", "content_type", "folder_id"],
        )?;
        let url = required_string(args, "url", MAX_URL_CHARS)?;
        validate_web_url(&url)?;
        let content = required_string(args, "content", MAX_WEBPAGE_CONTENT_CHARS)?;
        if content.contains("<truncated>Content truncated.") {
            return Err(tool_error(
                "INCOMPLETE_WEB_FETCH",
                "The content still contains a web_fetch truncation marker.",
                "Fetch and concatenate every page until hasMore=false, remove pagination markers, then save the complete content.",
                false,
            ));
        }
        if content.len() > MAX_WEBPAGE_CONTENT_BYTES {
            return Err(invalid_argument(
                "content",
                format!("content exceeds {MAX_WEBPAGE_CONTENT_BYTES} bytes"),
            ));
        }
        let title = match args.get("title") {
            Some(value) => {
                let title = value
                    .as_str()
                    .ok_or_else(|| invalid_argument("title", "expected a string"))?;
                validate_non_empty_string("title", title, MAX_TITLE_CHARS)?;
                title.to_string()
            }
            None => derive_title(&url),
        };
        let content_type = optional_string(args, "content_type", 200)?;
        let folder_id = optional_id(args, "folder_id")?;
        if ctx.is_cancelled() {
            return Err(tool_error(
                "CANCELLED",
                "Webpage save was cancelled before any VFS mutation.",
                "Retry only if the webpage still needs to be archived.",
                true,
            ));
        }

        // Include source information in the SSOT text so that a duplicate hash
        // is deterministic and the archived page remains self-describing even
        // when a consumer only reads extracted_text.
        let markdown = format_webpage_markdown(&title, &url, &content);
        let bytes = markdown.as_bytes();
        if bytes.len() > MAX_WEBPAGE_CONTENT_BYTES {
            return Err(invalid_argument(
                "content",
                format!(
                    "the archived Markdown, including source metadata, exceeds {MAX_WEBPAGE_CONTENT_BYTES} bytes"
                ),
            ));
        }
        let db = vfs_db(ctx)?;
        // 最终取消检查点：Markdown 组装与校验完成后、真正写入 VFS 之前。
        if ctx.is_cancelled() {
            return Err(tool_error(
                "CANCELLED",
                "Webpage save was cancelled before any VFS mutation.",
                "Retry only if the webpage still needs to be archived.",
                true,
            ));
        }
        let persisted = persist_webpage(
            &db,
            &title,
            &url,
            content_type.as_deref(),
            &markdown,
            folder_id.as_deref(),
        )?;
        let PersistedWebpage {
            file,
            resource_id,
            units_created,
            disposition,
        } = persisted;

        let node = file_to_dstu_node(&file);
        let node_path = node.path.clone();
        let event = match disposition {
            WebpageSaveDisposition::Created => DstuWatchEvent::created(node_path, node),
            WebpageSaveDisposition::Restored => DstuWatchEvent::restored(node_path, Some(node)),
            WebpageSaveDisposition::Existing => DstuWatchEvent::updated(node_path, node),
        };
        emit_watch_event(ctx.window_ref(), event);

        // 三态区分：Created=全新保存，Restored=同哈希内容曾被删除后恢复，
        // Existing=按内容哈希去重命中活跃文件。仅 Existing 视为 deduplicated。
        let (disposition_label, zh_message, en_message) = match disposition {
            WebpageSaveDisposition::Created => (
                "created",
                "网页已保存到知识库；文本单元已同步，向量索引异步进行中，可用 index_status 查询进度。",
                "Saved the webpage to the knowledge base; text units are synced and vector indexing continues asynchronously. Check progress with index_status.",
            ),
            WebpageSaveDisposition::Restored => (
                "restored",
                "相同内容此前已被删除，现已恢复保存到知识库；向量索引异步进行中，可用 index_status 查询进度。",
                "Identical content existed before but had been removed; it was re-saved to the knowledge base. Vector indexing continues asynchronously; check progress with index_status.",
            ),
            WebpageSaveDisposition::Existing => (
                "deduplicated",
                "网页内容已存在于知识库（按内容哈希去重），已复核索引单元；向量状态可用 index_status 查询。",
                "Identical webpage content already exists (content-hash deduplication); index units were re-verified. Check vector status with index_status.",
            ),
        };

        let output = localized_success(
            json!({
                "success": true,
                "fileId": file.id,
                "resourceId": resource_id,
                "title": title,
                "url": url,
                "blobHash": file.blob_hash,
                "unitsCreated": units_created,
                // 诚实的索引状态：本调用只保证 Unit 已同步入队，
                // 向量嵌入由后台索引管线异步完成。
                "indexState": "units_synced",
                "vectorIndexPending": true,
                "indexStatusTool": "builtin-index_status",
                "disposition": disposition_label,
                // 兼容字段：仅内容哈希命中活跃文件时为 true。
                "deduplicated": disposition == WebpageSaveDisposition::Existing,
                // 兼容字段：Unit 已入队（不代表向量已写入）。
                "indexQueued": true,
            }),
            "chat.tools.index.webpage_saved",
            json!({ "url": url, "disposition": disposition_label }),
            zh_message,
            en_message,
        );
        Ok(output)
    }
}

impl Default for IndexWebpageToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for IndexWebpageToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            INDEX_STATUS_TOOL | INDEX_REBUILD_TOOL | WEBPAGE_SAVE_TOOL
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let result = match strip_tool_namespace(&call.name) {
            INDEX_STATUS_TOOL => self.execute_status(&call.arguments, ctx).await,
            INDEX_REBUILD_TOOL => self.execute_rebuild(&call.arguments, ctx).await,
            WEBPAGE_SAVE_TOOL => self.execute_webpage_save(&call.arguments, ctx).await,
            _ => Err(tool_error(
                "UNKNOWN_TOOL",
                format!("Unknown index/webpage tool '{}'.", call.name),
                "Use one of the registered index/webpage tools.",
                false,
            )),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        let tool_result = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
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
                ctx.emit_tool_call_error(&error);
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
        if let Err(error) = ctx.save_tool_block(&tool_result) {
            log::warn!(
                "[IndexWebpageToolExecutor] Failed to persist tool block: {}",
                error
            );
        }
        Ok(tool_result)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            INDEX_REBUILD_TOOL => ToolSensitivity::High,
            WEBPAGE_SAVE_TOOL => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn sensitivity_level_for_call(&self, tool_name: &str, _arguments: &Value) -> ToolSensitivity {
        self.sensitivity_level(tool_name)
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        match strip_tool_namespace(tool_name) {
            INDEX_STATUS_TOOL => ToolConcurrency::ReadOnly,
            _ => ToolConcurrency::Serial,
        }
    }

    fn name(&self) -> &'static str {
        "IndexWebpageToolExecutor"
    }
}

fn vfs_db(ctx: &ExecutionContext) -> Result<Arc<crate::vfs::VfsDatabase>, String> {
    ctx.vfs_db.clone().ok_or_else(|| {
        tool_error(
            "DEPENDENCY_UNAVAILABLE",
            "The VFS database is unavailable.",
            "Retry after the desktop app finishes starting.",
            true,
        )
    })
}

fn ensure_rebuild_target(db: &crate::vfs::VfsDatabase, resource_id: &str) -> Result<(), String> {
    if VfsResourceRepo::exists(db, resource_id)
        .map_err(|error| backend_error("INDEX_REBUILD_FAILED", error.to_string(), true))?
    {
        return Ok(());
    }
    Err(tool_error(
        "RESOURCE_NOT_FOUND",
        format!("Resource '{resource_id}' was not found."),
        "Use a current VFS resource ID and retry.",
        false,
    ))
}

#[derive(Debug)]
struct PersistedWebpage {
    file: crate::vfs::VfsFile,
    resource_id: String,
    units_created: usize,
    disposition: WebpageSaveDisposition,
}

/// Persist the archive and queue its text units without requiring a Tauri
/// window. The executor adds desktop watch events after this core commits.
fn persist_webpage(
    db: &Arc<crate::vfs::VfsDatabase>,
    title: &str,
    url: &str,
    content_type: Option<&str>,
    markdown: &str,
    folder_id: Option<&str>,
) -> Result<PersistedWebpage, String> {
    let bytes = markdown.as_bytes();
    let sha256 = sha256_hex(bytes);
    let conn = db
        .get_conn_safe()
        .map_err(|error| backend_error("WEBPAGE_SAVE_FAILED", error.to_string(), true))?;
    let existing = VfsFileRepo::get_by_sha256_with_conn(&conn, &sha256)
        .map_err(|error| backend_error("WEBPAGE_SAVE_FAILED", error.to_string(), true))?;

    if let Some(folder_id) = folder_id {
        let exists = VfsFolderRepo::folder_exists_with_conn(&conn, folder_id)
            .map_err(|error| backend_error("WEBPAGE_SAVE_FAILED", error.to_string(), true))?;
        if !exists {
            return Err(tool_error(
                "FOLDER_NOT_FOUND",
                format!("Folder '{folder_id}' was not found."),
                "Use a current VFS folder ID or omit folder_id to save at the root.",
                false,
            ));
        }
    }

    let had_existing = existing.is_some();
    let (file, disposition) = if let Some(existing) =
        existing.filter(|file| file.status == "active")
    {
        if folder_id.is_some() {
            let item = VfsFolderItem::new(
                folder_id.map(str::to_string),
                "file".to_string(),
                existing.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(&conn, &item)
                .map_err(|error| backend_error("WEBPAGE_SAVE_FAILED", error.to_string(), true))?;
        }
        (existing, WebpageSaveDisposition::Existing)
    } else {
        let blob = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            bytes,
            Some("text/markdown; charset=utf-8"),
            Some("md"),
        )
        .map_err(|error| backend_error("WEBPAGE_SAVE_FAILED", error.to_string(), true))?;
        let file = match VfsFileRepo::create_file_with_doc_data_in_folder(
            &conn,
            &sha256,
            &format_file_name(title),
            bytes.len() as i64,
            "document",
            Some("text/markdown"),
            Some(&blob.hash),
            None,
            folder_id,
            None,
            Some(markdown),
            None,
        ) {
            Ok(file) => file,
            Err(error) => {
                let _ = VfsBlobRepo::decrement_ref_with_conn(&conn, db.blobs_dir(), &blob.hash);
                let _ = VfsBlobRepo::cleanup_blob_with_conn(&conn, db.blobs_dir(), &blob.hash);
                return Err(backend_error(
                    "WEBPAGE_SAVE_FAILED",
                    error.to_string(),
                    true,
                ));
            }
        };
        let disposition = if had_existing {
            WebpageSaveDisposition::Restored
        } else {
            WebpageSaveDisposition::Created
        };
        (file, disposition)
    };

    let resource_id = file.resource_id.clone().ok_or_else(|| {
        tool_error(
            "WEBPAGE_SAVE_FAILED",
            "The saved file has no VFS resource ID.",
            "Retry the save operation; no index was queued.",
            true,
        )
    })?;
    let metadata = VfsResourceMetadata {
        name: Some(title.to_string()),
        title: Some(title.to_string()),
        mime_type: Some("text/markdown".to_string()),
        size: Some(bytes.len() as u64),
        source: Some(url.to_string()),
        extra: Some(json!({
            "sourceUrl": url,
            "archivedBy": "builtin-webpage_save",
            "contentType": content_type,
        })),
    };
    let metadata_json = serde_json::to_string(&metadata)
        .map_err(|error| backend_error("WEBPAGE_SAVE_FAILED", error.to_string(), true))?;
    conn.execute(
        "UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![
            metadata_json,
            chrono::Utc::now().timestamp_millis(),
            resource_id
        ],
    )
    .map_err(|error| backend_error("WEBPAGE_SAVE_FAILED", error.to_string(), true))?;

    let index_service = VfsIndexService::new(db.clone());
    let units_created = index_service
        .sync_resource_units(UnitBuildInput {
            resource_id: resource_id.clone(),
            resource_type: "file".to_string(),
            data: None,
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: file.blob_hash.clone(),
            page_count: None,
            extracted_text: Some(markdown.to_string()),
            preview_json: None,
        })
        .map_err(|error| backend_error("WEBPAGE_SAVE_FAILED", error.to_string(), true))?
        .len();

    Ok(PersistedWebpage {
        file,
        resource_id,
        units_created,
        disposition,
    })
}

fn arguments_object<'a>(
    arguments: &'a Value,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    let object = arguments
        .as_object()
        .ok_or_else(|| invalid_argument("arguments", "expected a JSON object"))?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(invalid_argument(
            field,
            "unknown field; additional properties are not allowed",
        ));
    }
    Ok(object)
}

fn required_id(arguments: &Map<String, Value>, field: &str) -> Result<String, String> {
    let value = required_string(arguments, field, MAX_ID_CHARS)?;
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(invalid_argument(
            field,
            "must contain only ASCII letters, digits, '_' or '-'",
        ));
    }
    Ok(value)
}

fn optional_id(arguments: &Map<String, Value>, field: &str) -> Result<Option<String>, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_id(arguments, field).map(Some),
    }
}

fn required_resource_id(arguments: &Map<String, Value>, field: &str) -> Result<String, String> {
    let resource_id = required_id(arguments, field)?;
    if !resource_id.starts_with("res_") || resource_id.len() <= "res_".len() {
        return Err(invalid_argument(
            field,
            "must be a VFS resource ID with the 'res_' prefix",
        ));
    }
    Ok(resource_id)
}

fn optional_resource_id(
    arguments: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_resource_id(arguments, field).map(Some),
    }
}

fn required_string(
    arguments: &Map<String, Value>,
    field: &str,
    max_chars: usize,
) -> Result<String, String> {
    let value = arguments
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_argument(field, "expected a string"))?;
    validate_non_empty_string(field, value, max_chars)?;
    Ok(value.to_string())
}

fn optional_string(
    arguments: &Map<String, Value>,
    field: &str,
    max_chars: usize,
) -> Result<Option<String>, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_string(arguments, field, max_chars).map(Some),
    }
}

fn validate_non_empty_string(field: &str, value: &str, max_chars: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(invalid_argument(field, "must not be empty"));
    }
    if value.chars().count() > max_chars {
        return Err(invalid_argument(
            field,
            format!("must be at most {max_chars} characters"),
        ));
    }
    Ok(())
}

fn optional_u32(
    arguments: &Map<String, Value>,
    field: &str,
    default: u32,
    min: u32,
    max: u32,
) -> Result<u32, String> {
    let Some(value) = arguments.get(field) else {
        return Ok(default);
    };
    let raw = value
        .as_u64()
        .ok_or_else(|| invalid_argument(field, "expected an integer"))?;
    let value = u32::try_from(raw).map_err(|_| invalid_argument(field, "is out of range"))?;
    if !(min..=max).contains(&value) {
        return Err(invalid_argument(
            field,
            format!("must be between {min} and {max}"),
        ));
    }
    Ok(value)
}

fn validate_web_url(value: &str) -> Result<(), String> {
    let parsed = Url::parse(value).map_err(|error| invalid_argument("url", error.to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(invalid_argument(
            "url",
            "must be an absolute HTTP or HTTPS URL",
        ));
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(invalid_argument(
            "url",
            "must not contain embedded credentials",
        ));
    }
    // 🔒 SSRF 防护补齐（此前只查 scheme/凭据）：与 fetch_executor 同一正源
    // 判定——私网/链路本地/云元数据封锁，回环放行（本地文档站可索引）。
    let host = parsed.host_str().unwrap_or_default();
    let port = parsed
        .port()
        .unwrap_or(if parsed.scheme() == "https" { 443 } else { 80 });
    let addrs: Vec<_> = std::net::ToSocketAddrs::to_socket_addrs(&(host, port))
        .map_err(|error| invalid_argument("url", format!("DNS resolution failed: {error}")))?
        .collect();
    if addrs.is_empty()
        || addrs
            .iter()
            .any(|addr| crate::browser::policy::is_blocked_internal_ip(&addr.ip()))
    {
        return Err(invalid_argument(
            "url",
            "resolves to a blocked internal IP address",
        ));
    }
    Ok(())
}

fn derive_title(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed
                .path_segments()
                .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
                .map(|segment| segment.replace(['-', '_'], " "))
        })
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| {
            Url::parse(url)
                .ok()
                .and_then(|parsed| parsed.host_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "Saved webpage".to_string())
        })
}

fn format_file_name(title: &str) -> String {
    let sanitized = title
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>();
    let bounded: String = sanitized.chars().take(MAX_TITLE_CHARS).collect();
    if bounded.to_ascii_lowercase().ends_with(".md") {
        bounded
    } else {
        format!("{bounded}.md")
    }
}

fn format_webpage_markdown(title: &str, url: &str, content: &str) -> String {
    format!(
        "---\ntitle: {}\nsource: {}\n---\n\n# {}\n\nSource: <{}>\n\n{}\n",
        yaml_scalar(title),
        yaml_scalar(url),
        heading_text(title),
        url,
        content.trim()
    )
}

/// Encode a string as a safe YAML flow scalar for the frontmatter.
///
/// Values without control characters keep the historical single-quoted style
/// (only `'` doubled) so that re-saving an already archived page still yields
/// the same bytes and content hash (deduplication stays stable). Values with
/// newlines/control characters switch to a JSON-encoded double-quoted scalar
/// — valid YAML 1.2 — which escapes `\n`, `\r`, `\t`, quotes, backslashes and
/// other control characters so the frontmatter structure can never break.
fn yaml_scalar(value: &str) -> String {
    if value.chars().any(char::is_control) {
        serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
    } else {
        format!("'{}'", value.replace('\'', "''"))
    }
}

/// Collapse newlines/control characters so a multi-line title cannot break the
/// single-line `# heading` in the archived Markdown body.
fn heading_text(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn bounded_text(value: Option<&str>, max_chars: usize) -> (String, bool) {
    let value = value.unwrap_or_default();
    let mut chars = value.chars();
    let output: String = chars.by_ref().take(max_chars).collect();
    (output, chars.next().is_some())
}

fn file_for_resource(
    db: &crate::vfs::VfsDatabase,
    resource: &crate::vfs::VfsResource,
) -> Result<Option<crate::vfs::types::VfsFile>, String> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?;
    if let Some(source_id) = resource.source_id.as_deref() {
        if let Some(file) = VfsFileRepo::get_file_with_conn(&conn, source_id)
            .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?
        {
            return Ok(Some(file));
        }
    }
    let file_id: Option<String> = conn
        .query_row(
            "SELECT id FROM files WHERE resource_id = ?1 AND status = 'active' LIMIT 1",
            rusqlite::params![resource.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?;
    match file_id {
        Some(id) => VfsFileRepo::get_file_with_conn(&conn, &id)
            .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true)),
        None => Ok(None),
    }
}

fn read_ocr_snapshot(
    db: &crate::vfs::VfsDatabase,
    resource_id: &str,
    file: Option<&crate::vfs::types::VfsFile>,
) -> Result<Value, String> {
    let conn = db
        .get_conn_safe()
        .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?;
    let ocr_text: Option<String> = conn
        .query_row(
            "SELECT ocr_text FROM resources WHERE id = ?1",
            rusqlite::params![resource_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| backend_error("INDEX_STATUS_FAILED", error.to_string(), true))?
        .flatten();
    let (ocr_preview, ocr_truncated) = bounded_text(ocr_text.as_deref(), MAX_PREVIEW_CHARS);
    let (extracted_preview, extracted_truncated) = bounded_text(
        file.and_then(|value| value.extracted_text.as_deref()),
        MAX_PREVIEW_CHARS,
    );

    let parsed_pages = file
        .and_then(|value| value.ocr_pages_json.as_deref())
        .and_then(parse_ocr_pages);
    let ocr_pages_total = parsed_pages.as_ref().map(Vec::len).unwrap_or(0);
    let pages = parsed_pages.map(|pages| {
        pages
            .into_iter()
            .take(MAX_OCR_PAGES)
            .map(|(page_index, text, failed)| {
                let char_count = text.chars().count();
                let (text, truncated) = bounded_text(Some(&text), MAX_OCR_PAGE_PREVIEW_CHARS);
                json!({
                    "pageIndex": page_index,
                    "text": text,
                    "textTruncated": truncated,
                    "charCount": char_count,
                    "isFailed": failed,
                })
            })
            .collect::<Vec<_>>()
    });
    let active_source = if ocr_text
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        "ocr"
    } else if file
        .and_then(|value| value.extracted_text.as_ref())
        .is_some_and(|value| !value.trim().is_empty())
    {
        "extracted"
    } else {
        "none"
    };
    Ok(json!({
        "hasOcr": ocr_text.as_ref().is_some_and(|value| !value.trim().is_empty()) || pages.as_ref().is_some_and(|value| !value.is_empty()),
        "activeSource": active_source,
        "ocrText": ocr_preview,
        "ocrTextTruncated": ocr_truncated,
        "ocrTextLength": ocr_text.as_ref().map(|value| value.chars().count()).unwrap_or(0),
        "extractedText": extracted_preview,
        "extractedTextTruncated": extracted_truncated,
        "extractedTextLength": file.and_then(|value| value.extracted_text.as_ref()).map(|value| value.chars().count()).unwrap_or(0),
        "ocrPages": pages.unwrap_or_default(),
        "ocrPagesTotal": ocr_pages_total,
        "ocrPagesTruncated": ocr_pages_total > MAX_OCR_PAGES,
    }))
}

fn parse_ocr_pages(value: &str) -> Option<Vec<(usize, String, bool)>> {
    if let Ok(pages) = serde_json::from_str::<Vec<Option<String>>>(value) {
        return Some(
            pages
                .into_iter()
                .enumerate()
                .map(|(index, text)| match text {
                    Some(text) if text == "[OCR_FAILED]" => (index, String::new(), true),
                    Some(text) => (index, text.clone(), text.trim().is_empty()),
                    None => (index, String::new(), true),
                })
                .collect(),
        );
    }
    let object = serde_json::from_str::<Value>(value).ok()?;
    let pages = object.get("pages")?.as_array()?;
    Some(
        pages
            .iter()
            .enumerate()
            .map(|(index, page)| {
                let text = page
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let failed = text.trim().is_empty()
                    || page.get("error").and_then(Value::as_bool).unwrap_or(false)
                    || text == "[OCR_FAILED]";
                (index, text, failed)
            })
            .collect(),
    )
}

fn localized_success(
    payload: Value,
    key: &str,
    params: Value,
    zh_cn: impl Into<String>,
    en_us: impl Into<String>,
) -> Value {
    with_localized_message(payload, key, params, zh_cn, en_us)
}

fn invalid_argument(field: &str, reason: impl Into<String>) -> String {
    tool_error(
        "INVALID_ARGUMENT",
        format!("Invalid '{field}': {}.", reason.into()),
        "Correct the arguments to match the tool schema.",
        false,
    )
}

fn backend_error(code: &str, message: String, retryable: bool) -> String {
    tool_error(
        code,
        message,
        "Retry the operation after checking VFS availability.",
        retryable,
    )
}

fn tool_error(code: &str, message: impl Into<String>, hint: &str, retryable: bool) -> String {
    let message = message.into();
    let (message, message_truncated) = bounded_text(Some(&message), MAX_PREVIEW_CHARS);
    let message_key = format!(
        "chat.tools.index_webpage.errors.{}",
        code.to_ascii_lowercase()
    );
    let zh_cn = match code {
        "INVALID_ARGUMENT" => format!("工具参数无效：{message}"),
        "RESOURCE_NOT_FOUND" => "未找到指定的 VFS 资源。".to_string(),
        "FOLDER_NOT_FOUND" => "未找到指定的 VFS 文件夹。".to_string(),
        "DEPENDENCY_UNAVAILABLE" => "索引依赖尚未可用，请等待应用启动完成后重试。".to_string(),
        "INDEX_STATUS_FAILED" => format!("读取索引状态失败：{message}"),
        "INDEX_REBUILD_FAILED" => format!("重建索引失败：{message}"),
        "WEBPAGE_SAVE_FAILED" => format!("保存网页失败：{message}"),
        "INCOMPLETE_WEB_FETCH" => {
            "网页正文仍含抓取截断标记；必须读取并拼接全部分页后再保存。".to_string()
        }
        "CANCELLED" => "操作已在写入前取消。".to_string(),
        _ => format!("工具执行失败（{code}）：{message}"),
    };
    with_localized_message(
        json!({
        "code": code,
        "message_key": message_key.clone(),
        "message_truncated": message_truncated,
        "hint": hint,
        "retryable": retryable,
        }),
        &message_key,
        json!({ "code": code }),
        zh_cn,
        message,
    )
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_vfs() -> (tempfile::TempDir, Arc<crate::vfs::VfsDatabase>) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = tempfile::tempdir().expect("create VFS test directory");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("apply production VFS migrations");
        let db = Arc::new(
            crate::vfs::VfsDatabase::new(temp_dir.path()).expect("open migrated VFS database"),
        );
        (temp_dir, db)
    }

    #[test]
    fn validates_only_http_urls_without_credentials() {
        assert!(validate_web_url("https://example.com/a").is_ok());
        assert!(validate_web_url("file:///tmp/a").is_err());
        assert!(validate_web_url("https://user:pass@example.com/a").is_err());
    }

    #[test]
    fn index_and_webpage_arguments_are_closed_and_bounded() {
        let status_arguments = json!({"resource_id": "res_1", "page": 1, "page_size": 20});
        let status = arguments_object(&status_arguments, &["resource_id", "page", "page_size"])
            .expect("valid status arguments");
        assert_eq!(optional_u32(status, "page_size", 20, 1, 20).unwrap(), 20);
        assert!(optional_u32(
            arguments_object(&json!({"page_size": 21}), &["page_size"]).unwrap(),
            "page_size",
            20,
            1,
            20
        )
        .is_err());
        assert!(arguments_object(&json!({"unexpected": true}), &["resource_id"]).is_err());
        assert!(required_string(
            arguments_object(
                &json!({"title": "x".repeat(MAX_TITLE_CHARS + 1)}),
                &["title"]
            )
            .unwrap(),
            "title",
            MAX_TITLE_CHARS
        )
        .is_err());
    }

    #[test]
    fn webpage_markdown_contains_source_and_title() {
        let markdown = format_webpage_markdown("A title", "https://example.com/a", "Body");
        assert!(markdown.contains("source: 'https://example.com/a'"));
        assert!(markdown.contains("# A title"));
        assert!(markdown.ends_with("Body\n"));
    }

    #[test]
    fn yaml_scalar_escapes_newlines_quotes_and_control_characters() {
        // 无控制字符：保持历史单引号风格，保证既有归档的哈希/去重稳定
        assert_eq!(yaml_scalar("It's fine"), "'It''s fine'");
        // 含换行/制表符：切换为 JSON 双引号转义，frontmatter 结构不可能被破坏
        assert_eq!(yaml_scalar("line1\nline2"), r#""line1\nline2""#);
        assert_eq!(yaml_scalar("tab\there \"q\""), r#""tab\there \"q\"""#);
        let markdown =
            format_webpage_markdown("Multi\nline: title", "https://example.com/a", "Body");
        // frontmatter 恰好四行（--- / title / source / ---），标题换行被转义，
        // 不会把 frontmatter 撑成第五行
        let lines: Vec<&str> = markdown.lines().collect();
        assert_eq!(lines[0], "---");
        assert_eq!(lines[1], r#"title: "Multi\nline: title""#);
        assert!(lines[2].starts_with("source: "));
        assert_eq!(lines[3], "---");
        // 正文一级标题内的换行被折叠为空格
        assert!(markdown.contains("# Multi line: title"));
    }

    #[test]
    fn bounded_text_is_utf8_safe_and_reports_truncation() {
        let (value, truncated) = bounded_text(Some("中文内容"), 2);
        assert_eq!(value, "中文");
        assert!(truncated);
    }

    #[test]
    fn parses_legacy_and_object_ocr_pages() {
        let legacy = parse_ocr_pages(r#"["one", null, "[OCR_FAILED]"]"#).unwrap();
        assert_eq!(legacy.len(), 3);
        assert!(legacy[1].2);
        let object = parse_ocr_pages(r#"{"pages":[{"text":"two"}]}"#).unwrap();
        assert_eq!(object[0].1, "two");
    }

    #[test]
    fn sensitivity_and_routing_are_explicit() {
        let executor = IndexWebpageToolExecutor::new();
        assert!(executor.can_handle("builtin-index_status"));
        assert!(executor.can_handle("index_rebuild"));
        assert_eq!(
            executor.sensitivity_level("index_rebuild"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("webpage_save"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.concurrency_class("index_status"),
            ToolConcurrency::ReadOnly
        );
    }

    #[test]
    fn webpage_persistence_status_and_rebuild_preflight_use_real_vfs_state() {
        let (_temp_dir, db) = setup_vfs();
        let url = "https://example.com/reference";
        let markdown = format_webpage_markdown("Reference", url, "Persisted webpage body");
        let saved = persist_webpage(&db, "Reference", url, Some("text/html"), &markdown, None)
            .expect("persist webpage through executor production core");

        assert_eq!(saved.disposition, WebpageSaveDisposition::Created);
        assert!(saved.units_created > 0);
        let file = VfsFileRepo::get_file(&db, &saved.file.id)
            .expect("read saved file")
            .expect("file persisted");
        assert_eq!(file.extracted_text.as_deref(), Some(markdown.as_str()));
        assert!(file.blob_hash.is_some());

        let resource = VfsResourceRepo::get_resource(&db, &saved.resource_id)
            .expect("read webpage resource")
            .expect("resource persisted");
        assert_eq!(
            resource
                .metadata
                .as_ref()
                .and_then(|value| value.source.as_deref()),
            Some(url)
        );
        let state = VfsIndexStateRepo::get_index_state(&db, &saved.resource_id)
            .expect("read index state")
            .expect("index state persisted");
        assert_eq!(state.state, "pending");
        let summary = VfsIndexService::new(db.clone())
            .get_status_summary()
            .expect("read production status summary");
        assert!(summary.total_units >= saved.units_created as i64);
        ensure_rebuild_target(&db, &saved.resource_id)
            .expect("persisted resource passes rebuild preflight");

        let duplicate = persist_webpage(&db, "Reference", url, Some("text/html"), &markdown, None)
            .expect("deduplicate persisted webpage");
        assert_eq!(duplicate.disposition, WebpageSaveDisposition::Existing);
        assert_eq!(duplicate.file.id, saved.file.id);
    }

    #[test]
    fn rebuild_unit_test_boundary_stops_before_llm_lance_and_window_dependencies() {
        let (_temp_dir, db) = setup_vfs();
        let error = ensure_rebuild_target(&db, "res_missing")
            .expect_err("unknown resource must fail before embedding dependencies");
        let parsed: Value = serde_json::from_str(&error).expect("structured rebuild error");
        assert_eq!(parsed["code"], "RESOURCE_NOT_FOUND");
    }
}
