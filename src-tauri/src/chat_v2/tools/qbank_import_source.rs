//! `qbank_import_document` 输入解析：`content`（base64 / 纯文本）或资源库 `resource_id`。
//!
//! 背景（2026-10）：Agent 已用 resource_read 找到资源库里的试卷 PDF，却只能把内容以
//! base64 传给 `qbank_import_document`；纯文本又会因导入器 base64 解码失败而报错，
//! Agent 最终去申请 High 风险的本地 shell `base64 < exam.txt` 绕路。现在：
//!
//! - `resource_id`（别名 `file_id`）：直接从 VFS 读取原始文件字节（与题库 UI 导入同一管线：
//!   PDF/图片走 Visual-First、DOCX/文本走 LLM 结构化）；原始文件不可用或格式不被导入器
//!   支持时，回退到已解析/OCR 文本；仍在解析中则返回 `status=processing` 提示而非报错。
//! - `note_*`（或映射到笔记的 `res_*`）：笔记 Markdown 正文按 md 导入。
//! - `content`：保持向后兼容；文本类格式（txt/md/csv/json）接受纯文本，自动编码为 base64。

use std::sync::Arc;

use base64::Engine as _;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use super::document_processing_executor::DocumentProcessingExecutor;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsFileRepo, VfsNoteRepo};
use crate::vfs::types::VfsFile;

/// 文本类导入格式：导入器对其做 base64 → UTF-8/GBK 解码
const TEXT_FORMATS: &[&str] = &["txt", "md", "markdown", "csv", "json"];

/// 导入器可直接消费原始字节（base64）的格式
const NATIVE_FORMATS: &[&str] = &[
    "pdf", "docx", "xlsx", "xls", "txt", "md", "markdown", "csv", "json", "png", "jpg", "jpeg",
    "webp", "bmp", "gif", "tiff", "heic", "heif",
];

/// 已就绪的导入输入（`content` 已是导入器期望的形态）
#[derive(Debug, Clone)]
pub(crate) struct ResolvedImportInput {
    pub content: String,
    pub format: String,
    /// 资源名（文件名去扩展名 / 笔记标题），调用方未传 name 时用作题目集名
    pub default_name: Option<String>,
    /// 来源说明（回传给模型，便于审计）
    pub source: Option<Value>,
}

#[derive(Debug, Clone)]
pub(crate) enum ImportInput {
    Ready(ResolvedImportInput),
    /// 资源仍在解析/OCR 中：调用方原样返回该提示
    NotReady(Value),
}

fn non_empty_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 解析 `qbank_import_document` 的输入。
///
/// `is_parse_running(file_id)`：该文件的解析/OCR 管线是否正在运行。
pub(crate) fn resolve_import_input(
    vfs_db: Option<&Arc<VfsDatabase>>,
    args: &Value,
    is_parse_running: &dyn Fn(&str) -> bool,
) -> Result<ImportInput, String> {
    let resource_id = non_empty_str(args, "resource_id");
    let file_id = non_empty_str(args, "file_id");
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty());

    let resource_id = match (resource_id, file_id) {
        (Some(a), Some(b)) if a != b => {
            return Err(format!(
                "resource_id（{}）与 file_id（{}）不一致：二者是同一参数的别名，只传 resource_id 即可。",
                a, b
            ))
        }
        (Some(a), _) => Some(a),
        (None, b) => b,
    };

    match (resource_id, content) {
        (Some(_), Some(_)) => Err(
            "content 与 resource_id 互斥：资源库中的文件只传 resource_id（不要再传 base64/文本 content）；没有资源时才传 content。"
                .to_string(),
        ),
        (None, None) => Err(
            "缺少导入来源：资源库（Files）里的文件/笔记请传 resource_id（resource_list/resource_read 返回的 file_*/res_*/note_* ID）；否则传 content。"
                .to_string(),
        ),
        (Some(id), None) => {
            let vfs_db = vfs_db.ok_or("VFS database not available")?;
            resolve_resource(vfs_db, id, is_parse_running)
        }
        (None, Some(content)) => {
            let format = non_empty_str(args, "format")
                .unwrap_or("txt")
                .to_ascii_lowercase();
            let content = if TEXT_FORMATS.contains(&format.as_str()) {
                normalize_text_content(content)
            } else {
                content.to_string()
            };
            Ok(ImportInput::Ready(ResolvedImportInput {
                content,
                format,
                default_name: None,
                source: None,
            }))
        }
    }
}

/// 文本类 content：已是 UTF-8 文本的 base64 则保持（兼容旧调用），否则视为纯文本并编码。
fn normalize_text_content(content: &str) -> String {
    let trimmed = content.trim();
    let payload = if trimmed.starts_with("data:") {
        trimmed.split_once(',').map(|(_, p)| p).unwrap_or(trimmed)
    } else {
        trimmed
    };
    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) {
        if std::str::from_utf8(&bytes).is_ok() {
            return payload.to_string();
        }
    }
    base64::engine::general_purpose::STANDARD.encode(content.as_bytes())
}

fn resolve_resource(
    vfs_db: &Arc<VfsDatabase>,
    raw_id: &str,
    is_parse_running: &dyn Fn(&str) -> bool,
) -> Result<ImportInput, String> {
    let id = DocumentProcessingExecutor::sanitize_id(raw_id)?;

    if let Some(note_id) = note_id_for(vfs_db, &id)? {
        return resolve_note(vfs_db, &id, &note_id);
    }

    let file = match VfsFileRepo::get_file(vfs_db, &id) {
        Ok(Some(file)) => file,
        _ => DocumentProcessingExecutor::resolve_file(vfs_db, &id).map_err(|e| {
            format!(
                "{}（qbank_import_document 仅支持资源库中的文件——PDF/DOCX/TXT/MD/CSV/XLSX/图片——与笔记）",
                e
            )
        })?,
    };
    resolve_file(vfs_db, &id, &file, is_parse_running)
}

/// `note_*` 直接视为笔记；`res_*` 若是笔记的内容资源则映射到笔记 ID
fn note_id_for(vfs_db: &Arc<VfsDatabase>, id: &str) -> Result<Option<String>, String> {
    if id.starts_with("note_") {
        return Ok(Some(id.to_string()));
    }
    if !id.starts_with("res_") {
        return Ok(None);
    }
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| format!("获取数据库连接失败: {}", e))?;
    conn.query_row(
        "SELECT id FROM notes WHERE resource_id = ?1 LIMIT 1",
        rusqlite::params![id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("查询笔记失败: {}", e))
}

fn resolve_note(
    vfs_db: &Arc<VfsDatabase>,
    requested_id: &str,
    note_id: &str,
) -> Result<ImportInput, String> {
    let note = VfsNoteRepo::get_note(vfs_db, note_id)
        .map_err(|e| format!("查询笔记失败: {}", e))?
        .ok_or_else(|| {
            format!(
                "笔记不存在: {}（请用 resource_list/resource_search 获取有效 ID）",
                note_id
            )
        })?;
    let content = VfsNoteRepo::get_note_content(vfs_db, note_id)
        .map_err(|e| format!("读取笔记内容失败: {}", e))?
        .unwrap_or_default();
    if content.trim().is_empty() {
        return Err(format!("笔记「{}」内容为空，无法导入题目", note.title));
    }
    Ok(ImportInput::Ready(ResolvedImportInput {
        content: base64::engine::general_purpose::STANDARD.encode(content.as_bytes()),
        format: "md".to_string(),
        default_name: Some(note.title.clone()).filter(|t| !t.trim().is_empty()),
        source: Some(json!({
            "resource_id": requested_id,
            "note_id": note_id,
            "title": note.title,
            "content_source": "note",
        })),
    }))
}

fn resolve_file(
    vfs_db: &Arc<VfsDatabase>,
    requested_id: &str,
    file: &VfsFile,
    is_parse_running: &dyn Fn(&str) -> bool,
) -> Result<ImportInput, String> {
    let default_name = file_stem(&file.file_name);
    let source = |content_source: &str, format: &str| {
        json!({
            "resource_id": requested_id,
            "file_id": file.id,
            "file_name": file.file_name,
            "format": format,
            "content_source": content_source,
        })
    };

    // ① 原始文件字节（与题库 UI 导入同一管线）
    let native_format = infer_native_format(file);
    if let Some(format) = native_format {
        match VfsFileRepo::get_content(vfs_db, &file.id) {
            Ok(Some(b64)) if !b64.trim().is_empty() => {
                return Ok(ImportInput::Ready(ResolvedImportInput {
                    content: b64,
                    format: format.to_string(),
                    default_name,
                    source: Some(source("original_file", format)),
                }));
            }
            Ok(_) => log::warn!(
                "[QbankImport] 资源 {} 原始文件不可用，回退到已解析/OCR 文本",
                file.id
            ),
            Err(e) => log::warn!(
                "[QbankImport] 资源 {} 原始文件读取失败（{}），回退到已解析/OCR 文本",
                file.id,
                e
            ),
        }
    }

    // ② 已解析/OCR 文本（与 resource_read 同一抽取策略：OCR 与 extracted_text 取大者）
    let text = {
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| format!("获取数据库连接失败: {}", e))?;
        crate::vfs::ref_handlers::extract_file_text_with_strategy(
            &conn,
            &file.id,
            &file.file_name,
            None,
        )
    };
    if let Some(text) = text.filter(|t| !t.trim().is_empty()) {
        return Ok(ImportInput::Ready(ResolvedImportInput {
            content: base64::engine::general_purpose::STANDARD.encode(text.as_bytes()),
            format: "txt".to_string(),
            default_name,
            source: Some(source("extracted_text", "txt")),
        }));
    }

    // ③ 尚无可用内容：区分"解析中"与"从未解析/不支持"
    let stage = file
        .processing_status
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let stage_in_progress = stage
        .as_deref()
        .is_some_and(|s| !matches!(s, "completed" | "completed_with_issues" | "error"));
    if is_parse_running(&file.id) || stage_in_progress {
        return Ok(ImportInput::NotReady(json!({
            "success": false,
            "status": "processing",
            "resource_id": requested_id,
            "file_id": file.id,
            "file_name": file.file_name,
            "stage": stage,
            "progress": file.processing_progress,
            "message": format!("「{}」仍在解析/OCR 中，暂无可导入的内容", file.file_name),
            "hint": "用 document_parse_status 轮询该 resource_id，完成后再用同一 resource_id 调用 qbank_import_document；不要自行编码 base64 或调用 shell。",
        })));
    }

    let kind = file
        .mime_type
        .as_deref()
        .filter(|m| !m.is_empty())
        .unwrap_or(&file.file_type);
    if native_format.is_some() {
        Err(format!(
            "资源「{}」（{}）既读不到原始文件，也没有已解析/OCR 文本。PDF/图片可先用 document_parse 发起解析，完成后再用同一 resource_id 导入。",
            file.file_name, kind
        ))
    } else {
        Err(format!(
            "资源「{}」（{}）不是题库导入支持的格式（PDF/DOCX/TXT/MD/CSV/XLSX/JSON/图片），且没有已解析文本。PPTX 等可先用对应的 Office 读取工具取得题目文本，再用 qbank_batch_import 导入。",
            file.file_name, kind
        ))
    }
}

/// 由文件名扩展名 / MIME 推断导入器格式；返回 None 表示导入器不能直接消费原始字节
fn infer_native_format(file: &VfsFile) -> Option<&'static str> {
    let ext = file
        .file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    if let Some(ext) = ext.as_deref() {
        if let Some(fmt) = NATIVE_FORMATS.iter().find(|f| **f == ext) {
            return Some(*fmt);
        }
    }
    let mime = file.mime_type.as_deref().unwrap_or("").to_ascii_lowercase();
    match mime.as_str() {
        "application/pdf" => Some("pdf"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.ms-excel" => Some("xls"),
        "text/plain" => Some("txt"),
        "text/markdown" => Some("md"),
        "text/csv" => Some("csv"),
        "application/json" => Some("json"),
        m if m.starts_with("image/") => Some("image"),
        _ if file.file_type == "image" => Some("image"),
        _ => None,
    }
}

fn file_stem(file_name: &str) -> Option<String> {
    let stem = match file_name.rsplit_once('.') {
        Some((stem, _)) if !stem.trim().is_empty() => stem,
        _ => file_name,
    };
    Some(stem.trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::repos::VfsBlobRepo;
    use crate::vfs::types::VfsCreateNoteParams;

    fn not_running(_: &str) -> bool {
        false
    }

    fn ready(input: ImportInput) -> ResolvedImportInput {
        match input {
            ImportInput::Ready(r) => r,
            ImportInput::NotReady(v) => panic!("expected ready, got {}", v),
        }
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn create_file_with_blob(db: &VfsDatabase, name: &str, mime: &str, bytes: &[u8]) -> VfsFile {
        let blob = VfsBlobRepo::store_blob(db, bytes, Some(mime), name.rsplit('.').next())
            .expect("store blob");
        VfsFileRepo::create_file(
            db,
            &blob.hash,
            name,
            bytes.len() as i64,
            "document",
            Some(mime),
            Some(&blob.hash),
            None,
        )
        .expect("create file")
    }

    #[test]
    fn rejects_missing_and_conflicting_inputs() {
        let err = resolve_import_input(None, &json!({}), &not_running).unwrap_err();
        assert!(err.contains("resource_id"), "{}", err);

        let err = resolve_import_input(
            None,
            &json!({"resource_id": "file_a", "content": "1+1=?"}),
            &not_running,
        )
        .unwrap_err();
        assert!(err.contains("互斥"), "{}", err);

        let err = resolve_import_input(
            None,
            &json!({"resource_id": "file_a", "file_id": "file_b"}),
            &not_running,
        )
        .unwrap_err();
        assert!(err.contains("不一致"), "{}", err);
    }

    #[test]
    fn plain_text_content_is_encoded_and_base64_is_kept() {
        let text = "1. What is 2+2?\nA. 3  B. 4\nAnswer: B";
        let input = ready(
            resolve_import_input(
                None,
                &json!({"content": text, "format": "txt"}),
                &not_running,
            )
            .unwrap(),
        );
        assert_eq!(input.format, "txt");
        assert_eq!(input.content, b64(text.as_bytes()));

        // 旧调用：已是 base64 的文本保持原样
        let encoded = b64(text.as_bytes());
        let input = ready(
            resolve_import_input(
                None,
                &json!({"content": encoded, "format": "md"}),
                &not_running,
            )
            .unwrap(),
        );
        assert_eq!(input.content, encoded);

        // 二进制格式不做文本归一化
        let input = ready(
            resolve_import_input(
                None,
                &json!({"content": "UEsDBA==", "format": "docx"}),
                &not_running,
            )
            .unwrap(),
        );
        assert_eq!(input.content, "UEsDBA==");
    }

    #[test]
    fn resource_id_loads_original_pdf_bytes_via_file_and_res_ids() {
        let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
        let db = Arc::new(db);
        let bytes = b"%PDF-1.4 fake exam";
        let file = create_file_with_blob(
            &db,
            "Calculus I Midterm Practice.pdf",
            "application/pdf",
            bytes,
        );

        for id in [file.id.clone(), file.resource_id.clone().unwrap()] {
            let input = ready(
                resolve_import_input(Some(&db), &json!({"resource_id": id}), &not_running).unwrap(),
            );
            assert_eq!(input.format, "pdf");
            assert_eq!(input.content, b64(bytes));
            assert_eq!(
                input.default_name.as_deref(),
                Some("Calculus I Midterm Practice")
            );
            assert_eq!(
                input.source.as_ref().unwrap()["content_source"],
                "original_file"
            );
            assert_eq!(input.source.as_ref().unwrap()["file_id"], file.id.as_str());
        }

        // file_id 别名
        let input = ready(
            resolve_import_input(Some(&db), &json!({"file_id": file.id}), &not_running).unwrap(),
        );
        assert_eq!(input.format, "pdf");
    }

    #[test]
    fn falls_back_to_extracted_text_then_reports_processing() {
        let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
        let db = Arc::new(db);
        // 无 blob/原始路径：原始字节不可用
        let file = VfsFileRepo::create_file(
            &db,
            "sha-no-blob",
            "scan.pdf",
            10,
            "document",
            Some("application/pdf"),
            None,
            None,
        )
        .unwrap();

        // 解析中 → NotReady 提示
        let running = |id: &str| id == file.id;
        match resolve_import_input(Some(&db), &json!({"resource_id": file.id}), &running).unwrap() {
            ImportInput::NotReady(v) => {
                assert_eq!(v["status"], "processing");
                assert_eq!(v["success"], false);
                assert!(v["hint"]
                    .as_str()
                    .unwrap()
                    .contains("document_parse_status"));
            }
            ImportInput::Ready(_) => panic!("expected processing status"),
        }

        // 未在解析且无文本 → 明确错误（指引 document_parse）
        let err = resolve_import_input(Some(&db), &json!({"resource_id": file.id}), &not_running)
            .unwrap_err();
        assert!(err.contains("document_parse"), "{}", err);

        // OCR/解析完成后 → 用已解析文本按 txt 导入
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE files SET extracted_text = ?1 WHERE id = ?2",
            rusqlite::params!["1. Find d/dx x^2. Answer: 2x", file.id],
        )
        .unwrap();
        drop(conn);
        let input = ready(
            resolve_import_input(Some(&db), &json!({"resource_id": file.id}), &not_running)
                .unwrap(),
        );
        assert_eq!(input.format, "txt");
        assert_eq!(
            input.content,
            b64("1. Find d/dx x^2. Answer: 2x".as_bytes())
        );
        assert_eq!(input.source.unwrap()["content_source"], "extracted_text");
    }

    #[test]
    fn note_resource_imports_markdown() {
        let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
        let db = Arc::new(db);
        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "Limits drill".to_string(),
                content: "1. lim x->0 sin x / x = ?\nAnswer: 1".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        for id in [note.id.clone(), note.resource_id.clone()] {
            let input = ready(
                resolve_import_input(Some(&db), &json!({"resource_id": id}), &not_running).unwrap(),
            );
            assert_eq!(input.format, "md");
            assert_eq!(input.default_name.as_deref(), Some("Limits drill"));
            assert_eq!(
                input.content,
                b64("1. lim x->0 sin x / x = ?\nAnswer: 1".as_bytes())
            );
        }
    }

    #[test]
    fn unknown_resource_gives_actionable_error() {
        let (_tmp, db) = crate::vfs::database::setup_migrated_test_db();
        let db = Arc::new(db);
        let err = resolve_import_input(
            Some(&db),
            &json!({"resource_id": "file_missing"}),
            &not_running,
        )
        .unwrap_err();
        assert!(err.contains("resource_list"), "{}", err);
    }
}
