//! Agent-safe textbook annotations and bounded PDF page images.

use std::io::Cursor;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::vfs::handlers::read_pdf_page_image_bytes;
use crate::vfs::{VfsDatabase, VfsError, VfsTextbook, VfsTextbookRepo};

const BOOKMARKS_TOOL: &str = "textbook_bookmarks";
const HIGHLIGHTS_TOOL: &str = "textbook_highlights";
const PDF_PAGE_IMAGE_TOOL: &str = "pdf_page_image";

pub const PDF_ANNOTATIONS_CHANGED_EVENT: &str = "pdf-annotations:changed";

const MAX_PAGE_NUMBER: u32 = 100_000;
const MAX_ANNOTATIONS: usize = 500;
const MAX_RECTS: usize = 64;
const MAX_TOOL_STRING_CHARS: usize = 2_000;
const MAX_BOOKMARK_TITLE_CHARS: usize = 500;
const MAX_HIGHLIGHT_TEXT_CHARS: usize = 20_000;
const MAX_ID_CHARS: usize = 200;
const MAX_PAGE_SIZE: usize = 20;
const MAX_IMAGE_SOURCE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_OUTPUT_BYTES: usize = 1_500_000;
const MAX_IMAGE_OUTPUT_BASE64_CHARS: usize = 2_000_000;
const MAX_IMAGE_SOURCE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_OUTPUT_DIMENSION: u32 = 2_048;

const HIGHLIGHT_COLORS: &[&str] = &["#fef08a", "#bbf7d0", "#bfdbfe", "#fecaca"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Bookmark {
    id: String,
    page: u32,
    title: String,
    #[serde(rename = "createdAt")]
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct HighlightRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Highlight {
    id: String,
    #[serde(rename = "pageIndex")]
    page_index: u32,
    text: String,
    color: String,
    rects: Vec<HighlightRect>,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(rename = "coordVersion", skip_serializing_if = "Option::is_none")]
    coord_version: Option<u32>,
}

pub struct TextbookPdfToolExecutor;

impl TextbookPdfToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn vfs_db(ctx: &ExecutionContext) -> Result<Arc<VfsDatabase>, String> {
        ctx.vfs_db.clone().ok_or_else(|| {
            tool_error(
                "DEPENDENCY_UNAVAILABLE",
                "The VFS database is unavailable.",
                "Retry after the desktop app finishes starting.",
                true,
            )
        })
    }

    fn execute_bookmarks(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let action = required_action(args)?;
        let allowed = match action.as_str() {
            "get" => &["action", "textbook_id", "page", "page_size"][..],
            "add" => &[
                "action",
                "textbook_id",
                "page_number",
                "title",
                "expected_updated_at",
            ][..],
            "remove" => &[
                "action",
                "textbook_id",
                "bookmark_id",
                "expected_updated_at",
            ][..],
            "update" => &[
                "action",
                "textbook_id",
                "bookmark_id",
                "page_number",
                "title",
                "expected_updated_at",
            ][..],
            _ => {
                return Err(invalid_argument(
                    "action",
                    "expected get, add, remove, or update",
                ))
            }
        };
        let object = arguments_object(args, allowed)?;
        let textbook_id = required_identifier(object, "textbook_id")?;
        let db = Self::vfs_db(ctx)?;
        let textbook = load_textbook(&db, &textbook_id)?;
        let mut bookmarks = parse_bookmarks(&textbook.bookmarks)?;

        if action == "get" {
            let (page, page_size) = pagination(object)?;
            return Ok(paginated_annotations(
                "bookmarks",
                bookmarks.iter().map(bookmark_output).collect::<Vec<_>>(),
                page,
                page_size,
                &textbook,
            ));
        }

        let expected = required_string(object, "expected_updated_at", 128)?;
        ensure_expected_revision(&textbook, &expected, "bookmarks", &bookmarks)?;
        let previous: Option<Bookmark>;
        let changed: Bookmark;

        match action.as_str() {
            "add" => {
                if bookmarks.len() >= MAX_ANNOTATIONS {
                    return Err(tool_error(
                        "ANNOTATION_LIMIT_EXCEEDED",
                        format!("A textbook cannot contain more than {MAX_ANNOTATIONS} bookmarks."),
                        "Remove an existing bookmark before adding another.",
                        false,
                    ));
                }
                let page = required_u32(object, "page_number", 1, MAX_PAGE_NUMBER)?;
                validate_page_number(page, &textbook)?;
                if bookmarks.iter().any(|bookmark| bookmark.page == page) {
                    return Err(tool_error(
                        "BOOKMARK_PAGE_EXISTS",
                        format!("Page {page} already has a bookmark."),
                        "Update the existing bookmark instead of adding a duplicate.",
                        false,
                    ));
                }
                let title = required_string(object, "title", MAX_BOOKMARK_TITLE_CHARS)?;
                changed = Bookmark {
                    id: format!("bm-agent-{}", nanoid::nanoid!(16)),
                    page,
                    title,
                    created_at: chrono::Utc::now().timestamp_millis(),
                };
                previous = None;
                bookmarks.push(changed.clone());
            }
            "remove" => {
                let id = required_identifier(object, "bookmark_id")?;
                let index = bookmarks
                    .iter()
                    .position(|bookmark| bookmark.id == id)
                    .ok_or_else(|| annotation_not_found("bookmark", &id))?;
                changed = bookmarks[index].clone();
                previous = Some(changed.clone());
                bookmarks.remove(index);
            }
            "update" => {
                let id = required_identifier(object, "bookmark_id")?;
                let index = bookmarks
                    .iter()
                    .position(|bookmark| bookmark.id == id)
                    .ok_or_else(|| annotation_not_found("bookmark", &id))?;
                previous = Some(bookmarks[index].clone());
                let page = optional_u32(object, "page_number", 1, MAX_PAGE_NUMBER)?;
                let title = optional_string(object, "title", MAX_BOOKMARK_TITLE_CHARS)?;
                if page.is_none() && title.is_none() {
                    return Err(invalid_argument(
                        "update",
                        "provide at least one of page_number or title",
                    ));
                }
                if let Some(page) = page {
                    validate_page_number(page, &textbook)?;
                    if bookmarks
                        .iter()
                        .enumerate()
                        .any(|(other, bookmark)| other != index && bookmark.page == page)
                    {
                        return Err(tool_error(
                            "BOOKMARK_PAGE_EXISTS",
                            format!("Page {page} already has a bookmark."),
                            "Choose a page without a bookmark or update that bookmark.",
                            false,
                        ));
                    }
                    bookmarks[index].page = page;
                }
                if let Some(title) = title {
                    bookmarks[index].title = title;
                }
                changed = bookmarks[index].clone();
            }
            _ => unreachable!(),
        }

        let values = serialize_annotations(&bookmarks)?;
        let updated =
            VfsTextbookRepo::replace_bookmarks_if_version(&db, &textbook_id, &values, &expected)
                .map_err(|error| {
                    map_annotation_write_error(error, &db, &textbook_id, "bookmarks")
                })?;
        emit_annotations_changed(ctx, &updated, "bookmarks", &action);

        Ok(annotation_write_output(
            &action,
            "bookmark",
            bookmark_output(&changed),
            previous.as_ref().map(bookmark_output),
            &updated,
            bookmarks.len(),
        ))
    }

    fn execute_highlights(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let action = required_action(args)?;
        let allowed = match action.as_str() {
            "get" => &["action", "textbook_id", "page", "page_size", "page_index"][..],
            "add" => &[
                "action",
                "textbook_id",
                "page_index",
                "text",
                "color",
                "rects",
                "expected_updated_at",
            ][..],
            "remove" => &[
                "action",
                "textbook_id",
                "highlight_id",
                "expected_updated_at",
            ][..],
            "update" => &[
                "action",
                "textbook_id",
                "highlight_id",
                "page_index",
                "text",
                "color",
                "rects",
                "expected_updated_at",
            ][..],
            _ => {
                return Err(invalid_argument(
                    "action",
                    "expected get, add, remove, or update",
                ))
            }
        };
        let object = arguments_object(args, allowed)?;
        let textbook_id = required_identifier(object, "textbook_id")?;
        let db = Self::vfs_db(ctx)?;
        let textbook = load_textbook(&db, &textbook_id)?;
        let mut highlights = parse_highlights(&textbook.highlights)?;

        if action == "get" {
            let (page, page_size) = pagination(object)?;
            let filter_page = optional_u32(object, "page_index", 0, MAX_PAGE_NUMBER)?;
            if let Some(page_index) = filter_page {
                validate_page_index(page_index, &textbook)?;
            }
            let items = highlights
                .iter()
                .filter(|highlight| {
                    filter_page
                        .map(|page_index| highlight.page_index == page_index)
                        .unwrap_or(true)
                })
                .map(highlight_output)
                .collect::<Vec<_>>();
            return Ok(paginated_annotations(
                "highlights",
                items,
                page,
                page_size,
                &textbook,
            ));
        }

        let expected = required_string(object, "expected_updated_at", 128)?;
        ensure_expected_revision(&textbook, &expected, "highlights", &highlights)?;
        let previous: Option<Highlight>;
        let changed: Highlight;

        match action.as_str() {
            "add" => {
                if highlights.len() >= MAX_ANNOTATIONS {
                    return Err(tool_error(
                        "ANNOTATION_LIMIT_EXCEEDED",
                        format!(
                            "A textbook cannot contain more than {MAX_ANNOTATIONS} highlights."
                        ),
                        "Remove an existing highlight before adding another.",
                        false,
                    ));
                }
                let page_index = required_u32(object, "page_index", 0, MAX_PAGE_NUMBER)?;
                validate_page_index(page_index, &textbook)?;
                changed = Highlight {
                    id: format!("hl-agent-{}", nanoid::nanoid!(16)),
                    page_index,
                    text: required_string(object, "text", MAX_HIGHLIGHT_TEXT_CHARS)?,
                    color: required_highlight_color(object)?,
                    rects: required_rects(object)?,
                    created_at: chrono::Utc::now().timestamp_millis(),
                    coord_version: Some(2),
                };
                previous = None;
                highlights.push(changed.clone());
            }
            "remove" => {
                let id = required_identifier(object, "highlight_id")?;
                let index = highlights
                    .iter()
                    .position(|highlight| highlight.id == id)
                    .ok_or_else(|| annotation_not_found("highlight", &id))?;
                changed = highlights[index].clone();
                previous = Some(changed.clone());
                highlights.remove(index);
            }
            "update" => {
                let id = required_identifier(object, "highlight_id")?;
                let index = highlights
                    .iter()
                    .position(|highlight| highlight.id == id)
                    .ok_or_else(|| annotation_not_found("highlight", &id))?;
                previous = Some(highlights[index].clone());
                let page_index = optional_u32(object, "page_index", 0, MAX_PAGE_NUMBER)?;
                let text = optional_string(object, "text", MAX_HIGHLIGHT_TEXT_CHARS)?;
                let color = optional_highlight_color(object)?;
                let rects = optional_rects(object)?;
                if page_index.is_none() && text.is_none() && color.is_none() && rects.is_none() {
                    return Err(invalid_argument(
                        "update",
                        "provide at least one of page_index, text, color, or rects",
                    ));
                }
                if let Some(page_index) = page_index {
                    validate_page_index(page_index, &textbook)?;
                    highlights[index].page_index = page_index;
                }
                if let Some(text) = text {
                    highlights[index].text = text;
                }
                if let Some(color) = color {
                    highlights[index].color = color;
                }
                if let Some(rects) = rects {
                    highlights[index].rects = rects;
                }
                highlights[index].coord_version = Some(2);
                changed = highlights[index].clone();
            }
            _ => unreachable!(),
        }

        let values = serialize_annotations(&highlights)?;
        let updated = VfsTextbookRepo::replace_highlights_if_version(
            &db,
            &textbook_id,
            &values,
            &expected,
        )
        .map_err(|error| map_annotation_write_error(error, &db, &textbook_id, "highlights"))?;
        emit_annotations_changed(ctx, &updated, "highlights", &action);

        Ok(annotation_write_output(
            &action,
            "highlight",
            highlight_output(&changed),
            previous.as_ref().map(highlight_output),
            &updated,
            highlights.len(),
        ))
    }

    async fn execute_pdf_page_image(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let object = arguments_object(args, &["resource_id", "page_index"])?;
        let resource_id = required_identifier(object, "resource_id")?;
        if !resource_id.starts_with("res_") {
            return Err(invalid_argument(
                "resource_id",
                "expected a VFS resource ID beginning with 'res_'",
            ));
        }
        let page_index = required_u32(object, "page_index", 0, MAX_PAGE_NUMBER)? as usize;
        let db = Self::vfs_db(ctx)?;
        let source_id = resource_id.clone();
        let image = tokio::task::spawn_blocking(move || {
            read_pdf_page_image_bytes(&db, &source_id, page_index, Some(MAX_IMAGE_SOURCE_BYTES))
        })
        .await
        .map_err(|error| {
            tool_error(
                "PDF_PAGE_IMAGE_FAILED",
                format!("PDF page image task failed: {error}"),
                "Retry after checking the PDF processing status.",
                true,
            )
        })?
        .map_err(|error| {
            tool_error(
                "PDF_PAGE_IMAGE_NOT_AVAILABLE",
                error,
                "Check that the resource is a processed PDF and that page_index is zero-based.",
                false,
            )
        })?;
        let original_bytes = image.bytes.len();
        let bounded = fit_image_for_tool(image.bytes, &image.mime_type)?;
        let base64 = BASE64.encode(&bounded.bytes);
        if base64.len() > MAX_IMAGE_OUTPUT_BASE64_CHARS {
            return Err(tool_error(
                "PDF_PAGE_IMAGE_TOO_LARGE",
                "The bounded page image still exceeds the tool output limit.",
                "Rebuild the PDF preview or use OCR text for this page.",
                false,
            ));
        }

        Ok(json!({
            "resource_id": resource_id,
            "page_index": page_index,
            "mime_type": bounded.mime_type,
            "width": bounded.width,
            "height": bounded.height,
            "size_bytes": bounded.bytes.len(),
            "original_size_bytes": original_bytes,
            "stored_size_bytes": image.stored_size,
            "compressed": bounded.compressed,
            "image_url": format!("data:{};base64,{}", bounded.mime_type, base64),
            "image_url_chars": base64.len() + bounded.mime_type.len() + 13,
            "truncated": false,
            "message_key": "chat.tools.textbook_pdf.page_image.success",
        }))
    }
}

impl Default for TextbookPdfToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for TextbookPdfToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            BOOKMARKS_TOOL | HIGHLIGHTS_TOOL | PDF_PAGE_IMAGE_TOOL
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let output = match strip_tool_namespace(&call.name) {
            BOOKMARKS_TOOL => self.execute_bookmarks(&call.arguments, ctx),
            HIGHLIGHTS_TOOL => self.execute_highlights(&call.arguments, ctx),
            PDF_PAGE_IMAGE_TOOL => self.execute_pdf_page_image(&call.arguments, ctx).await,
            _ => Err(tool_error(
                "UNKNOWN_TOOL",
                format!("Unknown textbook/PDF tool '{}'.", call.name),
                "Use one of the registered textbook/PDF tools.",
                false,
            )),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        let result = match output {
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
        if let Err(error) = ctx.save_tool_block(&result) {
            log::warn!(
                "[TextbookPdfToolExecutor] Failed to persist tool block: {}",
                error
            );
        }
        Ok(result)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            BOOKMARKS_TOOL | HIGHLIGHTS_TOOL => ToolSensitivity::Medium,
            PDF_PAGE_IMAGE_TOOL => ToolSensitivity::Low,
            _ => ToolSensitivity::Medium,
        }
    }

    fn sensitivity_level_for_call(&self, tool_name: &str, arguments: &Value) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            PDF_PAGE_IMAGE_TOOL => ToolSensitivity::Low,
            BOOKMARKS_TOOL | HIGHLIGHTS_TOOL => {
                if arguments.get("action").and_then(Value::as_str) == Some("get") {
                    ToolSensitivity::Low
                } else {
                    ToolSensitivity::Medium
                }
            }
            _ => ToolSensitivity::Medium,
        }
    }

    fn has_dynamic_sensitivity(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            BOOKMARKS_TOOL | HIGHLIGHTS_TOOL
        )
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        match strip_tool_namespace(tool_name) {
            PDF_PAGE_IMAGE_TOOL => ToolConcurrency::ReadOnly,
            BOOKMARKS_TOOL | HIGHLIGHTS_TOOL => ToolConcurrency::Serial,
            _ => ToolConcurrency::Serial,
        }
    }

    fn name(&self) -> &'static str {
        "TextbookPdfToolExecutor"
    }
}

fn arguments_object<'a>(
    args: &'a Value,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    let object = args
        .as_object()
        .ok_or_else(|| invalid_argument("arguments", "expected a JSON object"))?;
    if let Some(unknown) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid_argument(
            unknown,
            "unknown field; use only fields declared by the tool schema",
        ));
    }
    Ok(object)
}

fn required_action(args: &Value) -> Result<String, String> {
    let object = args
        .as_object()
        .ok_or_else(|| invalid_argument("arguments", "expected a JSON object"))?;
    required_string(object, "action", 16)
}

fn required_string(
    object: &Map<String, Value>,
    field: &str,
    maximum_chars: usize,
) -> Result<String, String> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_argument(field, "expected a non-empty string"))?;
    let count = value.chars().count();
    if count > maximum_chars {
        return Err(invalid_argument(
            field,
            format!("cannot exceed {maximum_chars} Unicode characters"),
        ));
    }
    Ok(value.to_string())
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
    maximum_chars: usize,
) -> Result<Option<String>, String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_string(object, field, maximum_chars).map(Some),
    }
}

fn required_identifier(object: &Map<String, Value>, field: &str) -> Result<String, String> {
    let id = required_string(object, field, MAX_ID_CHARS)?;
    if !id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(invalid_argument(
            field,
            "may contain only ASCII letters, digits, '_' and '-'",
        ));
    }
    Ok(id)
}

fn required_u32(
    object: &Map<String, Value>,
    field: &str,
    minimum: u32,
    maximum: u32,
) -> Result<u32, String> {
    let value = object
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| (minimum..=maximum).contains(value))
        .ok_or_else(|| {
            invalid_argument(
                field,
                format!("expected an integer between {minimum} and {maximum}"),
            )
        })?;
    Ok(value)
}

fn optional_u32(
    object: &Map<String, Value>,
    field: &str,
    minimum: u32,
    maximum: u32,
) -> Result<Option<u32>, String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_u32(object, field, minimum, maximum).map(Some),
    }
}

fn pagination(object: &Map<String, Value>) -> Result<(usize, usize), String> {
    let page = optional_u32(object, "page", 1, u32::MAX)?.unwrap_or(1) as usize;
    let page_size = optional_u32(object, "page_size", 1, MAX_PAGE_SIZE as u32)?
        .unwrap_or(MAX_PAGE_SIZE as u32) as usize;
    Ok((page, page_size))
}

fn load_textbook(db: &VfsDatabase, textbook_id: &str) -> Result<VfsTextbook, String> {
    VfsTextbookRepo::get_textbook(db, textbook_id)
        .map_err(|error| {
            tool_error(
                "TEXTBOOK_READ_FAILED",
                format!("Failed to read textbook annotations: {error}"),
                "Retry after checking local storage.",
                true,
            )
        })?
        .filter(|textbook| textbook.status == "active")
        .ok_or_else(|| {
            tool_error(
                "TEXTBOOK_NOT_FOUND",
                format!("Active textbook '{textbook_id}' was not found."),
                "List or open the textbook again and use its current ID.",
                false,
            )
        })
}

fn parse_bookmarks(values: &[Value]) -> Result<Vec<Bookmark>, String> {
    values
        .iter()
        .cloned()
        .map(|value| {
            serde_json::from_value::<Bookmark>(value).map_err(|error| {
                tool_error(
                    "CORRUPT_ANNOTATIONS",
                    format!("Stored bookmark data is invalid: {error}"),
                    "Open the textbook reader and repair or remove the malformed bookmark.",
                    false,
                )
            })
        })
        .collect()
}

fn parse_highlights(values: &[Value]) -> Result<Vec<Highlight>, String> {
    values
        .iter()
        .cloned()
        .map(|value| {
            serde_json::from_value::<Highlight>(value).map_err(|error| {
                tool_error(
                    "CORRUPT_ANNOTATIONS",
                    format!("Stored highlight data is invalid: {error}"),
                    "Open the textbook reader and repair or remove the malformed highlight.",
                    false,
                )
            })
        })
        .collect()
}

fn serialize_annotations<T: Serialize>(items: &[T]) -> Result<Vec<Value>, String> {
    items
        .iter()
        .map(|item| {
            serde_json::to_value(item).map_err(|error| {
                tool_error(
                    "ANNOTATION_SERIALIZATION_FAILED",
                    format!("Failed to serialize annotation: {error}"),
                    "Retry after re-reading the textbook annotations.",
                    true,
                )
            })
        })
        .collect()
}

fn validate_page_number(page: u32, textbook: &VfsTextbook) -> Result<(), String> {
    if textbook
        .page_count
        .is_some_and(|page_count| page > page_count.max(0) as u32)
    {
        return Err(invalid_argument(
            "page_number",
            format!(
                "page {page} exceeds the textbook page count {}",
                textbook.page_count.unwrap_or_default()
            ),
        ));
    }
    Ok(())
}

fn validate_page_index(page_index: u32, textbook: &VfsTextbook) -> Result<(), String> {
    if textbook
        .page_count
        .is_some_and(|page_count| page_index >= page_count.max(0) as u32)
    {
        return Err(invalid_argument(
            "page_index",
            format!(
                "zero-based page index {page_index} exceeds the textbook page count {}",
                textbook.page_count.unwrap_or_default()
            ),
        ));
    }
    Ok(())
}

fn required_highlight_color(object: &Map<String, Value>) -> Result<String, String> {
    let color = required_string(object, "color", 7)?;
    if HIGHLIGHT_COLORS.contains(&color.as_str()) {
        Ok(color)
    } else {
        Err(invalid_argument(
            "color",
            "expected one of #fef08a, #bbf7d0, #bfdbfe, #fecaca",
        ))
    }
}

fn optional_highlight_color(object: &Map<String, Value>) -> Result<Option<String>, String> {
    match object.get("color") {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_highlight_color(object).map(Some),
    }
}

fn required_rects(object: &Map<String, Value>) -> Result<Vec<HighlightRect>, String> {
    let values = object
        .get("rects")
        .and_then(Value::as_array)
        .filter(|rects| !rects.is_empty() && rects.len() <= MAX_RECTS)
        .ok_or_else(|| {
            invalid_argument(
                "rects",
                format!("expected between 1 and {MAX_RECTS} normalized rectangles"),
            )
        })?;
    values
        .iter()
        .enumerate()
        .map(|(index, value)| parse_rect(value, index))
        .collect()
}

fn optional_rects(object: &Map<String, Value>) -> Result<Option<Vec<HighlightRect>>, String> {
    match object.get("rects") {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_rects(object).map(Some),
    }
}

fn parse_rect(value: &Value, index: usize) -> Result<HighlightRect, String> {
    let object = arguments_object(value, &["x", "y", "width", "height"])?;
    for field in ["x", "y", "width", "height"] {
        if !object.contains_key(field) {
            return Err(invalid_argument(
                "rects",
                format!("rects[{index}].{field} is required"),
            ));
        }
    }
    let number = |field: &str| {
        object
            .get(field)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| {
                invalid_argument(
                    "rects",
                    format!("rects[{index}].{field} must be a finite number"),
                )
            })
    };
    let rect = HighlightRect {
        x: number("x")?,
        y: number("y")?,
        width: number("width")?,
        height: number("height")?,
    };
    if rect.x < 0.0
        || rect.y < 0.0
        || rect.width <= 0.0
        || rect.height <= 0.0
        || rect.x + rect.width > 1.000_001
        || rect.y + rect.height > 1.000_001
    {
        return Err(invalid_argument(
            "rects",
            format!("rects[{index}] must fit within normalized page coordinates 0..1"),
        ));
    }
    Ok(rect)
}

fn ensure_expected_revision<T: Serialize>(
    textbook: &VfsTextbook,
    expected: &str,
    kind: &str,
    current: &[T],
) -> Result<(), String> {
    if textbook.updated_at == expected {
        return Ok(());
    }
    let mut current = serde_json::to_value(current).unwrap_or_else(|_| json!([]));
    let truncated = bound_json_strings(&mut current);
    Err(tool_error_with_fields(
        "ANNOTATION_CONFLICT",
        format!(
            "Textbook annotations changed (expected {}, current {}).",
            expected, textbook.updated_at
        ),
        "Re-read the annotations, review the current value, and ask before replacing conflicting edits.",
        false,
        json!({
            "kind": kind,
            "current_updated_at": textbook.updated_at,
            "current": current,
            "current_truncated": truncated,
        }),
    ))
}

fn map_annotation_write_error(
    error: VfsError,
    db: &VfsDatabase,
    textbook_id: &str,
    kind: &str,
) -> String {
    if matches!(error, VfsError::Conflict { .. }) {
        let current = VfsTextbookRepo::get_textbook(db, textbook_id)
            .ok()
            .flatten();
        let mut values = current
            .as_ref()
            .map(|textbook| {
                if kind == "bookmarks" {
                    Value::Array(textbook.bookmarks.clone())
                } else {
                    Value::Array(textbook.highlights.clone())
                }
            })
            .unwrap_or_else(|| json!([]));
        let truncated = bound_json_strings(&mut values);
        return tool_error_with_fields(
            "ANNOTATION_CONFLICT",
            error.to_string(),
            "Re-read the annotations and do not retry with the stale revision.",
            false,
            json!({
                "kind": kind,
                "current_updated_at": current.map(|textbook| textbook.updated_at),
                "current": values,
                "current_truncated": truncated,
            }),
        );
    }
    tool_error(
        "ANNOTATION_WRITE_FAILED",
        error.to_string(),
        "Retry after checking local storage and the current textbook revision.",
        true,
    )
}

fn bookmark_output(bookmark: &Bookmark) -> Value {
    let (title, title_truncated) = bounded_string(&bookmark.title);
    json!({
        "id": bookmark.id,
        "page": bookmark.page,
        "title": title,
        "title_truncated": title_truncated,
        "createdAt": bookmark.created_at,
    })
}

fn highlight_output(highlight: &Highlight) -> Value {
    let (text, text_truncated) = bounded_string(&highlight.text);
    json!({
        "id": highlight.id,
        "pageIndex": highlight.page_index,
        "text": text,
        "text_truncated": text_truncated,
        "color": highlight.color,
        "rects": highlight.rects,
        "createdAt": highlight.created_at,
        "coordVersion": highlight.coord_version,
    })
}

fn paginated_annotations(
    kind: &str,
    items: Vec<Value>,
    page: usize,
    page_size: usize,
    textbook: &VfsTextbook,
) -> Value {
    let total = items.len();
    let start = page.saturating_sub(1).saturating_mul(page_size).min(total);
    let end = start.saturating_add(page_size).min(total);
    let page_items = items[start..end].to_vec();
    let truncated = page_items.iter().any(annotation_has_truncation);
    json!({
        "textbook_id": textbook.id,
        "kind": kind,
        "items": page_items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "has_more": end < total,
        "updated_at": textbook.updated_at,
        "truncated": truncated,
        "message_key": "chat.tools.textbook_pdf.annotations_get.success",
    })
}

fn annotation_has_truncation(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object
            .iter()
            .any(|(key, value)| key.ends_with("_truncated") && value == true)
    })
}

fn annotation_write_output(
    action: &str,
    kind: &str,
    annotation: Value,
    previous: Option<Value>,
    textbook: &VfsTextbook,
    count: usize,
) -> Value {
    json!({
        "action": action,
        "kind": kind,
        "textbook_id": textbook.id,
        "annotation": annotation,
        "previous": previous,
        "count": count,
        "updated_at": textbook.updated_at,
        "event": PDF_ANNOTATIONS_CHANGED_EVENT,
        "reversible": false,
        "reversible_with_occ": true,
        "message_key": "chat.tools.textbook_pdf.annotation_write.success",
    })
}

fn emit_annotations_changed(
    ctx: &ExecutionContext,
    textbook: &VfsTextbook,
    kind: &str,
    action: &str,
) {
    if let Err(error) = ctx.window_ref().app_handle().emit(
        PDF_ANNOTATIONS_CHANGED_EVENT,
        json!({
            "textbook_id": textbook.id,
            "resource_path": format!("/{}", textbook.id),
            "kind": kind,
            "action": action,
            "updated_at": textbook.updated_at,
        }),
    ) {
        log::warn!(
            "[TextbookPdfToolExecutor] Failed to emit {}: {}",
            PDF_ANNOTATIONS_CHANGED_EVENT,
            error
        );
    }
}

struct BoundedImage {
    bytes: Vec<u8>,
    mime_type: String,
    width: u32,
    height: u32,
    compressed: bool,
}

fn fit_image_for_tool(bytes: Vec<u8>, source_mime: &str) -> Result<BoundedImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_SOURCE_BYTES {
        return Err(tool_error(
            "PDF_PAGE_IMAGE_TOO_LARGE",
            format!(
                "PDF preview source must contain 1..={} bytes (got {}).",
                MAX_IMAGE_SOURCE_BYTES,
                bytes.len()
            ),
            "Rebuild the PDF preview so a compressed page image is available.",
            false,
        ));
    }
    let decoded = image::load_from_memory(&bytes).map_err(|error| {
        tool_error(
            "PDF_PAGE_IMAGE_INVALID",
            format!("Failed to decode PDF page preview: {error}"),
            "Rebuild the PDF preview for this resource.",
            false,
        )
    })?;
    let (width, height) = decoded.dimensions();
    if width == 0
        || height == 0
        || width > MAX_IMAGE_SOURCE_DIMENSION
        || height > MAX_IMAGE_SOURCE_DIMENSION
    {
        return Err(tool_error(
            "PDF_PAGE_IMAGE_DIMENSIONS_INVALID",
            format!("PDF preview dimensions {width}x{height} are outside the safe range."),
            "Rebuild the PDF preview with standard page dimensions.",
            false,
        ));
    }
    let supported_mime = matches!(source_mime, "image/jpeg" | "image/png" | "image/webp");
    if bytes.len() <= MAX_IMAGE_OUTPUT_BYTES
        && width <= MAX_IMAGE_OUTPUT_DIMENSION
        && height <= MAX_IMAGE_OUTPUT_DIMENSION
        && supported_mime
    {
        return Ok(BoundedImage {
            bytes,
            mime_type: source_mime.to_string(),
            width,
            height,
            compressed: false,
        });
    }

    encode_bounded_jpeg(decoded, width, height)
}

fn encode_bounded_jpeg(
    decoded: DynamicImage,
    source_width: u32,
    source_height: u32,
) -> Result<BoundedImage, String> {
    let mut target = decoded.thumbnail(MAX_IMAGE_OUTPUT_DIMENSION, MAX_IMAGE_OUTPUT_DIMENSION);
    for _round in 0..5 {
        for quality in [82_u8, 70, 58, 46] {
            let rgb = target.to_rgb8();
            let (width, height) = rgb.dimensions();
            let mut output = Cursor::new(Vec::new());
            let mut encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality);
            encoder
                .encode(&rgb, width, height, image::ColorType::Rgb8)
                .map_err(|error| {
                    tool_error(
                        "PDF_PAGE_IMAGE_COMPRESSION_FAILED",
                        format!("Failed to compress PDF page image: {error}"),
                        "Rebuild the PDF preview and retry.",
                        true,
                    )
                })?;
            let bytes = output.into_inner();
            if bytes.len() <= MAX_IMAGE_OUTPUT_BYTES {
                return Ok(BoundedImage {
                    bytes,
                    mime_type: "image/jpeg".to_string(),
                    width,
                    height,
                    compressed: width != source_width || height != source_height || quality < 100,
                });
            }
        }
        let next_width = (target.width() * 3 / 4).max(320);
        let next_height = (target.height() * 3 / 4).max(320);
        if next_width == target.width() && next_height == target.height() {
            break;
        }
        target = target.resize(next_width, next_height, FilterType::Lanczos3);
    }
    Err(tool_error(
        "PDF_PAGE_IMAGE_TOO_LARGE",
        "PDF page preview could not be compressed below the safe output limit.",
        "Use OCR text for this page or rebuild its PDF preview.",
        false,
    ))
}

fn bounded_string(value: &str) -> (String, bool) {
    let truncated = value.chars().count() > MAX_TOOL_STRING_CHARS;
    (
        value.chars().take(MAX_TOOL_STRING_CHARS).collect(),
        truncated,
    )
}

fn bound_json_strings(value: &mut Value) -> bool {
    match value {
        Value::String(text) => {
            let (bounded, truncated) = bounded_string(text);
            if truncated {
                *text = bounded;
            }
            truncated
        }
        Value::Array(values) => values.iter_mut().fold(false, |truncated, value| {
            bound_json_strings(value) || truncated
        }),
        Value::Object(object) => object.values_mut().fold(false, |truncated, value| {
            bound_json_strings(value) || truncated
        }),
        _ => false,
    }
}

fn annotation_not_found(kind: &str, id: &str) -> String {
    tool_error(
        "ANNOTATION_NOT_FOUND",
        format!("The {kind} '{id}' was not found."),
        "Re-read the current annotations and use an existing ID.",
        false,
    )
}

fn invalid_argument(field: &str, reason: impl Into<String>) -> String {
    tool_error(
        "INVALID_ARGUMENT",
        format!("Invalid '{field}': {}.", reason.into()),
        "Correct the arguments to match the tool schema.",
        false,
    )
}

fn tool_error(code: &str, message: impl Into<String>, hint: &str, retryable: bool) -> String {
    tool_error_with_fields(code, message, hint, retryable, json!({}))
}

fn tool_error_with_fields(
    code: &str,
    message: impl Into<String>,
    hint: &str,
    retryable: bool,
    fields: Value,
) -> String {
    let (message, message_truncated) = bounded_string(&message.into());
    let mut error = json!({
        "code": code,
        "message": message,
        "message_truncated": message_truncated,
        "message_key": format!("chat.tools.textbook_pdf.errors.{}", code.to_ascii_lowercase()),
        "hint": hint,
        "retryable": retryable,
    });
    if let (Some(target), Some(extra)) = (error.as_object_mut(), fields.as_object()) {
        target.extend(extra.clone());
    }
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_textbook(page_count: i32) -> VfsTextbook {
        VfsTextbook {
            id: "file_test".to_string(),
            resource_id: Some("res_test".to_string()),
            blob_hash: None,
            sha256: "hash".to_string(),
            file_name: "book.pdf".to_string(),
            original_path: None,
            size: 1,
            page_count: Some(page_count),
            tags: vec![],
            is_favorite: false,
            last_opened_at: None,
            last_page: None,
            bookmarks: vec![],
            highlights: vec![],
            cover_key: None,
            status: "active".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn rejects_unknown_fields_and_invalid_normalized_rectangles() {
        let err =
            arguments_object(&json!({"action":"get", "extra": true}), &["action"]).unwrap_err();
        assert!(err.contains("INVALID_ARGUMENT"));
        let err = parse_rect(&json!({"x":0.9,"y":0.1,"width":0.2,"height":0.2}), 0).unwrap_err();
        assert!(err.contains("normalized page coordinates"));
    }

    #[test]
    fn paginates_at_twenty_and_marks_long_text_truncated() {
        let textbook = sample_textbook(100);
        let highlights = (0..21)
            .map(|index| Highlight {
                id: format!("hl-{index}"),
                page_index: index,
                text: "x".repeat(2_001),
                color: "#fef08a".to_string(),
                rects: vec![HighlightRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.2,
                    height: 0.1,
                }],
                created_at: 1,
                coord_version: Some(2),
            })
            .collect::<Vec<_>>();
        let output = paginated_annotations(
            "highlights",
            highlights.iter().map(highlight_output).collect(),
            1,
            20,
            &textbook,
        );
        assert_eq!(output["items"].as_array().unwrap().len(), 20);
        assert_eq!(output["has_more"], true);
        assert_eq!(output["truncated"], true);
        assert_eq!(
            output["items"][0]["text"].as_str().unwrap().chars().count(),
            2_000
        );
    }

    #[test]
    fn rejects_stale_occ_with_bounded_current_value() {
        let mut textbook = sample_textbook(10);
        textbook.updated_at = "rev-2".to_string();
        let current = vec![Bookmark {
            id: "bm-1".to_string(),
            page: 1,
            title: "title".to_string(),
            created_at: 1,
        }];
        let error =
            ensure_expected_revision(&textbook, "rev-1", "bookmarks", &current).unwrap_err();
        let error: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(error["code"], "ANNOTATION_CONFLICT");
        assert_eq!(error["current_updated_at"], "rev-2");
    }

    #[test]
    fn repository_persists_highlights_and_rejects_stale_version() {
        let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
        let textbook =
            VfsTextbookRepo::create_textbook(&db, "annotations-hash", "book.pdf", 1, None, None)
                .unwrap();
        let highlight = json!({
            "id":"hl-1", "pageIndex":0, "text":"hello", "color":"#fef08a",
            "rects":[{"x":0.1,"y":0.1,"width":0.2,"height":0.1}],
            "createdAt":1, "coordVersion":2
        });
        let updated = VfsTextbookRepo::replace_highlights_if_version(
            &db,
            &textbook.id,
            &[highlight.clone()],
            &textbook.updated_at,
        )
        .unwrap();
        assert_eq!(updated.highlights, vec![highlight.clone()]);
        let stale = VfsTextbookRepo::replace_highlights_if_version(
            &db,
            &textbook.id,
            &[highlight],
            &textbook.updated_at,
        )
        .unwrap_err();
        assert!(matches!(stale, VfsError::Conflict { .. }));
    }

    #[test]
    fn compresses_large_page_images_below_output_limits() {
        let image = DynamicImage::new_rgb8(3_000, 2_500);
        let mut png = Cursor::new(Vec::new());
        image
            .write_to(&mut png, image::ImageOutputFormat::Png)
            .unwrap();
        let bounded = fit_image_for_tool(png.into_inner(), "image/png").unwrap();
        assert!(bounded.width <= MAX_IMAGE_OUTPUT_DIMENSION);
        assert!(bounded.height <= MAX_IMAGE_OUTPUT_DIMENSION);
        assert!(bounded.bytes.len() <= MAX_IMAGE_OUTPUT_BYTES);
        assert!(BASE64.encode(&bounded.bytes).len() <= MAX_IMAGE_OUTPUT_BASE64_CHARS);
        assert!(bounded.compressed);
    }

    #[test]
    fn sensitivity_keeps_reads_low_and_annotation_writes_medium() {
        let executor = TextbookPdfToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-pdf_page_image"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-textbook_bookmarks"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-textbook_highlights"),
            ToolSensitivity::Medium
        );
        assert!(executor.has_dynamic_sensitivity("builtin-textbook_bookmarks"));
        assert!(executor.has_dynamic_sensitivity("builtin-textbook_highlights"));
        assert!(!executor.has_dynamic_sensitivity("builtin-pdf_page_image"));
        assert_eq!(
            executor.sensitivity_level_for_call(
                "builtin-textbook_bookmarks",
                &json!({"action":"get"}),
            ),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level_for_call(
                "builtin-textbook_highlights",
                &json!({"action":"remove"}),
            ),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level_for_call("builtin-textbook_highlights", &json!({}),),
            ToolSensitivity::Medium
        );
    }
}
