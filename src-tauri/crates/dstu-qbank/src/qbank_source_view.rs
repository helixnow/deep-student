//! Read-only source-page lookup for the question source viewer.
//!
//! `questions.provenance_json.source_refs[].source_id` points at a
//! `qbank_sources.id` (the authoring commit remaps draft-local ids before it
//! stores provenance). The source row's `descriptor_json` contains the original
//! source metadata plus a `pages` array with 1-based page numbers and the
//! rasterized page blob hash:
//!
//! ```json
//! {
//!   "source_id": "s1",
//!   "name": "exam.pdf",
//!   "format": "pdf",
//!   "page_count": 12,
//!   "pages": [
//!     { "source_id": "s1", "page": 1, "blob_hash": "…", "width": 2480, "height": 3508 }
//!   ]
//! }
//! ```
//!
//! The viewer never invents a page. A `page: null` ref (native text/transcript
//! sources) returns the descriptor metadata and any native text that the
//! descriptor carries; a ref to a missing page returns no `blob_hash` and the
//! list of real pages so the UI can state that explicitly.

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

/// A real rasterized source page or descriptor-backed source metadata.
///
/// Field names deliberately stay snake_case: this is also the IPC payload the
/// frontend consumes (`source_id`, `blob_hash`, …).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SourcePageView {
    /// Requested `qbank_sources.id` (not the descriptor-local `source_id`).
    pub source_id: String,
    /// Requested 1-based page. `None` is a real, supported value for sources
    /// without pagination (native text/transcripts); it is never normalized to 1.
    pub page: Option<u32>,
    /// Page image blob. `None` means "no page image available", not "page 1".
    pub blob_hash: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Page text layer for a found page, or the descriptor's native text for a
    /// source without pages.
    pub text: Option<String>,
    /// Original source display name from the descriptor.
    pub source_name: Option<String>,
    /// Original source format (pdf/image/docx/media_transcript/…).
    pub source_format: Option<String>,
    /// Original path when the descriptor retained one; otherwise the source name.
    pub original_path: Option<String>,
    pub page_count: Option<u32>,
    /// Real page numbers present in the descriptor, sorted ascending.
    pub available_pages: Vec<u32>,
}

impl SourcePageView {
    fn has_image(&self) -> bool {
        self.blob_hash
            .as_deref()
            .is_some_and(|hash| !hash.trim().is_empty())
    }
}

fn non_empty_str<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    })
}

fn positive_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
        .filter(|number| *number > 0)
}

fn file_format(file_name: &str, file_type: &str, mime_type: Option<&str>) -> Option<String> {
    let extension = std::path::Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| !value.is_empty());
    extension
        .or_else(|| {
            mime_type
                .and_then(|mime| mime.split('/').next_back())
                .map(str::to_ascii_lowercase)
                .filter(|value| !value.is_empty())
        })
        .or_else(|| Some(file_type.to_ascii_lowercase()).filter(|value| !value.is_empty()))
}

/// Fallback for chat-authored refs whose `source_id` is a VFS file id
/// (`att_*`/`file_*`/`tb_*`) and whose draft metadata had no source descriptor.
///
/// Only images are returned as a page image. PDFs/DOCX/etc. deliberately return
/// metadata without `blob_hash`: handing raw document bytes to the image viewer
/// would be a fabricated "page".
fn vfs_file_fallback(
    conn: &Connection,
    source_id: &str,
    page: Option<u32>,
) -> Result<Option<SourcePageView>, AppError> {
    let row = conn
        .query_row(
            "SELECT file_name, original_path, type, mime_type, blob_hash, page_count \
             FROM files \
             WHERE (id=?1 OR resource_id=?1) AND deleted_at IS NULL \
             ORDER BY CASE WHEN id=?1 THEN 0 ELSE 1 END LIMIT 1",
            params![source_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| AppError::database(error.to_string()))?;

    let Some((file_name, original_path, file_type, mime_type, blob_hash, page_count)) = row else {
        return Ok(None);
    };

    let is_image = file_type.eq_ignore_ascii_case("image")
        || mime_type
            .as_deref()
            .is_some_and(|mime| mime.to_ascii_lowercase().starts_with("image/"));
    let image_blob = is_image
        .then_some(blob_hash)
        .flatten()
        .filter(|hash| !hash.trim().is_empty())
        .filter(|_| page.is_none() || page == Some(1));
    let page_count = if is_image {
        Some(1)
    } else {
        page_count
            .and_then(|count| u32::try_from(count).ok())
            .filter(|count| *count > 0)
    };

    let mut view = SourcePageView {
        source_id: source_id.to_string(),
        page,
        blob_hash: image_blob,
        width: None,
        height: None,
        text: None,
        source_name: Some(file_name.clone()),
        source_format: file_format(&file_name, &file_type, mime_type.as_deref()),
        original_path: original_path.or(Some(file_name)),
        page_count,
        available_pages: if is_image { vec![1] } else { Vec::new() },
    };
    if !is_image {
        let preview: Option<String> = conn.query_row(
            "SELECT preview_json FROM files WHERE (id=?1 OR resource_id=?1) AND deleted_at IS NULL ORDER BY CASE WHEN id=?1 THEN 0 ELSE 1 END LIMIT 1",[source_id],|row|row.get(0),
        ).optional().map_err(|error|AppError::database(error.to_string()))?.flatten();
        if let Some(preview) = preview {
            let preview: Value = serde_json::from_str(&preview)
                .map_err(|error| AppError::validation(format!("原始文件页图索引无效: {error}")))?;
            let pages = preview["pages"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            view.available_pages = pages
                .iter()
                .filter_map(|entry| {
                    entry["pageIndex"]
                        .as_u64()
                        .or_else(|| entry["page_index"].as_u64())
                })
                .filter_map(|n| u32::try_from(n).ok()?.checked_add(1))
                .collect();
            if let Some(entry) = pages.iter().find(|entry| {
                entry["pageIndex"]
                    .as_u64()
                    .or_else(|| entry["page_index"].as_u64())
                    .is_some_and(|index| Some(index + 1) == page.map(u64::from))
            }) {
                view.blob_hash =
                    non_empty_str(entry, &["blobHash", "blob_hash"]).map(str::to_string);
                view.width = positive_u32(entry.get("width"));
                view.height = positive_u32(entry.get("height"));
            }
        }
    }
    Ok(Some(view))
}

/// Resolve one source page against an existing VFS connection.
///
/// The exam id is part of the lookup (not merely a post-hoc check), so a valid
/// source id from another exam is indistinguishable from a missing source.
pub fn get_source_page_with_conn(
    conn: &Connection,
    exam_id: &str,
    source_id: &str,
    page: Option<u32>,
) -> Result<SourcePageView, AppError> {
    // Pages are 1-based. An invalid 0 is treated as "no page" rather than 1.
    let page = page.filter(|page| *page > 0);
    if exam_id.trim().is_empty() || source_id.trim().is_empty() {
        return Err(AppError::validation("题目集或来源标识为空"));
    }

    // Exam verification: a soft-deleted exam must not expose retained sources.
    let exam_exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id=?1 AND deleted_at IS NULL)",
            [exam_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| AppError::database(error.to_string()))?;
    if !exam_exists {
        return Err(AppError::not_found("题目集不存在或已删除"));
    }

    let descriptor_json = conn
        .query_row(
            "SELECT descriptor_json FROM qbank_sources \
             WHERE id=?1 AND exam_id=?2 AND deleted_at IS NULL",
            params![source_id, exam_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| AppError::database(error.to_string()))?;

    let Some(descriptor_json) = descriptor_json else {
        // Chat-authored refs can carry a VFS attachment id with no qbank source
        // descriptor (`metadata.sources = []`). Resolve the original file
        // without inventing a page.
        if let Some(view) = vfs_file_fallback(conn, source_id, page)? {
            return Ok(view);
        }
        return Err(AppError::not_found("来源不存在或不属于该题目集"));
    };

    let descriptor: Value = serde_json::from_str(&descriptor_json)
        .map_err(|error| AppError::database(format!("来源描述无效: {error}")))?;

    let source_name =
        non_empty_str(&descriptor, &["name", "file_name", "title"]).map(str::to_string);
    let source_format =
        non_empty_str(&descriptor, &["format", "source_format"]).map(str::to_string);
    let original_path = non_empty_str(
        &descriptor,
        &[
            "original_path",
            "originalPath",
            "path",
            "anchor",
            "name",
            "file_name",
        ],
    )
    .map(str::to_string);
    let page_count = positive_u32(descriptor.get("page_count"));

    let pages = descriptor
        .get("pages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut available_pages: Vec<u32> = pages
        .iter()
        .filter_map(|entry| positive_u32(entry.get("page")))
        .collect();
    available_pages.sort_unstable();
    available_pages.dedup();

    let native_text = non_empty_str(
        &descriptor,
        &["text", "native_text", "content", "extracted_text"],
    )
    .map(str::to_string);

    let mut view = SourcePageView {
        source_id: source_id.to_string(),
        page,
        blob_hash: None,
        width: None,
        height: None,
        text: native_text,
        source_name,
        source_format,
        original_path,
        page_count,
        available_pages,
    };

    let Some(requested_page) = page else {
        // Native text / transcript source: metadata + text only, no synthetic page.
        return Ok(view);
    };

    let Some(page_entry) = pages
        .iter()
        .find(|entry| positive_u32(entry.get("page")) == Some(requested_page))
    else {
        // A page-bearing ref whose page is absent from the descriptor is a data
        // inconsistency. Return it explicitly without fabricating a page image.
        return Ok(view);
    };

    view.width = positive_u32(page_entry.get("width"));
    view.height = positive_u32(page_entry.get("height"));
    view.blob_hash = non_empty_str(page_entry, &["blob_hash"]).map(str::to_string);
    view.text = non_empty_str(page_entry, &["text_hint", "text"])
        .map(str::to_string)
        .or(view.text);

    if !view.has_image() {
        // Keep metadata/text, but make the absence visible to the caller.
        view.blob_hash = None;
    }
    Ok(view)
}

/// IPC: `qbank_get_source_page(examId, sourceId, page)`.
///
/// `page` is optional so callers can inspect a native-text source without
/// substituting a fabricated first page.
#[tauri::command]
pub async fn qbank_get_source_page(
    exam_id: String,
    source_id: String,
    page: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<SourcePageView, AppError> {
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|error| AppError::database(error.to_string()))?;
    get_source_page_with_conn(&conn, &exam_id, &source_id, page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::repos::VfsExamRepo;
    use crate::vfs::types::VfsCreateExamSheetParams;
    use serde_json::json;

    fn test_db() -> (tempfile::TempDir, Arc<VfsDatabase>, String) {
        let (temp, db) = crate::vfs::database::setup_migrated_test_db();
        let db = Arc::new(db);
        let exam = VfsExamRepo::create_exam_sheet(
            &db,
            VfsCreateExamSheetParams {
                exam_name: Some("source view test".into()),
                temp_id: "tmp_source_view".into(),
                preview_json: json!({"pages": []}),
                metadata_json: json!({}),
                status: "completed".into(),
                folder_id: None,
            },
        )
        .unwrap();
        (temp, db, exam.id)
    }

    fn insert_source(db: &VfsDatabase, exam_id: &str, source_id: &str, descriptor: Value) {
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "INSERT INTO qbank_sources \
             (id, exam_id, source_key, descriptor_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                source_id,
                exam_id,
                format!("key:{source_id}"),
                descriptor.to_string(),
                "2026-10-23T00:00:00Z"
            ],
        )
        .unwrap();
    }

    fn insert_vfs_file(
        db: &VfsDatabase,
        file_id: &str,
        file_name: &str,
        file_type: &str,
        mime_type: &str,
        blob_hash: &str,
        page_count: Option<i64>,
    ) {
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO blobs \
             (hash, relative_path, size, mime_type, ref_count, created_at) \
             VALUES (?1, 'test', 8, ?2, 1, 0)",
            params![blob_hash, mime_type],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files \
             (id, blob_hash, sha256, file_name, original_path, size, page_count, type, mime_type, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, 8, ?6, ?7, ?8, ?9, ?9)",
            params![
                file_id,
                blob_hash,
                format!("sha:{file_id}"),
                file_name,
                format!("/library/{file_name}"),
                page_count,
                file_type,
                mime_type,
                "2026-10-23T00:00:00Z"
            ],
        )
        .unwrap();
    }

    fn paged_descriptor() -> Value {
        json!({
            "source_id": "s1",
            "name": "midterm.pdf",
            "format": "pdf",
            "page_count": 2,
            "original_path": "/library/midterm.pdf",
            "pages": [
                {"source_id": "s1", "page": 1, "blob_hash": "blob_page_1", "width": 1200, "height": 1600, "text_hint": "Page one"},
                {"source_id": "s1", "page": 2, "blob_hash": "blob_page_2", "width": 1200, "height": 1600, "text_hint": "Page two"}
            ]
        })
    }

    #[test]
    fn resolves_a_real_page_and_keeps_the_database_source_id() {
        let (_temp, db, exam_id) = test_db();
        insert_source(&db, &exam_id, "qsource_db_1", paged_descriptor());
        let conn = db.get_conn_safe().unwrap();

        let view = get_source_page_with_conn(&conn, &exam_id, "qsource_db_1", Some(2)).unwrap();

        assert_eq!(view.source_id, "qsource_db_1");
        assert_eq!(view.page, Some(2));
        assert_eq!(view.blob_hash.as_deref(), Some("blob_page_2"));
        assert_eq!(view.width, Some(1200));
        assert_eq!(view.height, Some(1600));
        assert_eq!(view.text.as_deref(), Some("Page two"));
        assert_eq!(view.available_pages, vec![1, 2]);
        assert_eq!(view.source_name.as_deref(), Some("midterm.pdf"));
        assert_eq!(view.original_path.as_deref(), Some("/library/midterm.pdf"));
    }

    #[test]
    fn a_page_less_source_returns_native_text_without_fabricating_page_one() {
        let (_temp, db, exam_id) = test_db();
        insert_source(
            &db,
            &exam_id,
            "qsource_text",
            json!({
                "source_id": "r1_s1",
                "name": "lecture-transcript.txt",
                "format": "media_transcript",
                "page_count": null,
                "original_path": "/library/lecture-transcript.txt",
                "text": "Native text layer"
            }),
        );
        let conn = db.get_conn_safe().unwrap();

        let view = get_source_page_with_conn(&conn, &exam_id, "qsource_text", None).unwrap();

        assert_eq!(view.page, None);
        assert_eq!(view.blob_hash, None);
        assert_eq!(view.width, None);
        assert_eq!(view.height, None);
        assert_eq!(view.text.as_deref(), Some("Native text layer"));
        assert_eq!(
            view.original_path.as_deref(),
            Some("/library/lecture-transcript.txt")
        );
        assert!(view.available_pages.is_empty());
    }

    #[test]
    fn a_missing_page_is_reported_without_substituting_another_image() {
        let (_temp, db, exam_id) = test_db();
        insert_source(&db, &exam_id, "qsource_db_1", paged_descriptor());
        let conn = db.get_conn_safe().unwrap();

        let view = get_source_page_with_conn(&conn, &exam_id, "qsource_db_1", Some(9)).unwrap();

        assert_eq!(view.page, Some(9));
        assert_eq!(view.blob_hash, None);
        assert_eq!(view.available_pages, vec![1, 2]);
    }

    #[test]
    fn a_source_from_another_or_deleted_exam_is_rejected() {
        let (_temp, db, exam_id) = test_db();
        let (_other_temp, other_db, other_exam_id) = test_db();
        insert_source(
            &other_db,
            &other_exam_id,
            "qsource_other",
            paged_descriptor(),
        );
        let conn = db.get_conn_safe().unwrap();

        let error =
            get_source_page_with_conn(&conn, &exam_id, "qsource_other", Some(1)).unwrap_err();
        assert!(error.message.contains("来源不存在"));

        let error =
            get_source_page_with_conn(&conn, "exam_missing", "qsource_other", Some(1)).unwrap_err();
        assert!(error.message.contains("题目集不存在"));
    }

    #[test]
    fn malformed_descriptors_are_not_treated_as_an_empty_page() {
        let (_temp, db, exam_id) = test_db();
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "INSERT INTO qbank_sources \
             (id, exam_id, source_key, descriptor_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                "qsource_bad",
                exam_id,
                "key:bad",
                "{not-json",
                "2026-10-23T00:00:00Z"
            ],
        )
        .unwrap();

        let error = get_source_page_with_conn(&conn, &exam_id, "qsource_bad", Some(1)).unwrap_err();
        assert!(error.message.contains("来源描述无效"));
    }

    #[test]
    fn chat_attachment_refs_fall_back_to_the_original_vfs_image() {
        let (_temp, db, exam_id) = test_db();
        insert_vfs_file(
            &db,
            "att_chat_image",
            "chat-figure.png",
            "image",
            "image/png",
            "blob_chat_image",
            None,
        );
        let conn = db.get_conn_safe().unwrap();

        let view = get_source_page_with_conn(&conn, &exam_id, "att_chat_image", Some(1)).unwrap();

        assert_eq!(view.source_id, "att_chat_image");
        assert_eq!(view.page, Some(1));
        assert_eq!(view.blob_hash.as_deref(), Some("blob_chat_image"));
        assert_eq!(view.source_name.as_deref(), Some("chat-figure.png"));
        assert_eq!(view.source_format.as_deref(), Some("png"));
        assert_eq!(view.page_count, Some(1));
        assert_eq!(view.available_pages, vec![1]);
        assert_eq!(
            view.original_path.as_deref(),
            Some("/library/chat-figure.png")
        );
    }

    #[test]
    fn chat_attachment_pdf_exposes_metadata_but_never_document_bytes_as_a_page() {
        let (_temp, db, exam_id) = test_db();
        insert_vfs_file(
            &db,
            "att_chat_pdf",
            "chat-notes.pdf",
            "document",
            "application/pdf",
            "blob_chat_pdf",
            Some(12),
        );
        let conn = db.get_conn_safe().unwrap();

        let view = get_source_page_with_conn(&conn, &exam_id, "att_chat_pdf", Some(3)).unwrap();

        assert_eq!(view.page, Some(3));
        assert_eq!(view.blob_hash, None);
        assert_eq!(view.source_name.as_deref(), Some("chat-notes.pdf"));
        assert_eq!(view.source_format.as_deref(), Some("pdf"));
        assert_eq!(view.page_count, Some(12));
        assert!(view.available_pages.is_empty());
        assert_eq!(
            view.original_path.as_deref(),
            Some("/library/chat-notes.pdf")
        );
    }

    #[test]
    fn chat_attachment_pdf_uses_cached_actual_page_images() {
        let (_temp, db, exam) = test_db();
        insert_vfs_file(
            &db,
            "att_cached_pdf",
            "cached.pdf",
            "document",
            "application/pdf",
            "original_pdf_bytes",
            Some(18),
        );
        let conn = db.get_conn_safe().unwrap();
        conn.execute("UPDATE files SET preview_json=?1 WHERE id='att_cached_pdf'",[json!({"pages":[{"pageIndex":2,"blobHash":"actual_page_three","width":1133,"height":1600}]}).to_string()]).unwrap();
        let view = get_source_page_with_conn(&conn, &exam, "att_cached_pdf", Some(3)).unwrap();
        assert_eq!(view.blob_hash.as_deref(), Some("actual_page_three"));
        assert_eq!(view.available_pages, vec![3]);
        assert_eq!(view.width, Some(1133));
        let missing = get_source_page_with_conn(&conn, &exam, "att_cached_pdf", Some(4)).unwrap();
        assert!(missing.blob_hash.is_none());
    }

    #[test]
    fn an_image_attachment_does_not_claim_to_have_a_second_page() {
        let (_temp, db, exam_id) = test_db();
        insert_vfs_file(
            &db,
            "att_chat_image",
            "chat-figure.png",
            "image",
            "image/png",
            "blob_chat_image",
            None,
        );
        let conn = db.get_conn_safe().unwrap();

        let view = get_source_page_with_conn(&conn, &exam_id, "att_chat_image", Some(2)).unwrap();

        assert_eq!(view.page, Some(2));
        assert_eq!(view.blob_hash, None);
        assert_eq!(view.available_pages, vec![1]);
    }

    #[test]
    fn an_unknown_attachment_still_fails_explicitly() {
        let (_temp, db, exam_id) = test_db();
        let conn = db.get_conn_safe().unwrap();

        let error = get_source_page_with_conn(&conn, &exam_id, "att_missing", Some(1)).unwrap_err();

        assert!(error.message.contains("来源不存在"));
    }
}
