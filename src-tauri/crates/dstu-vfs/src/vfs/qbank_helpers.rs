//! 题库相关的纯 VFS SQL 辅助函数。
//!
//! 这些函数只读写 vfs 表（questions / exam_sheets / qbank_* / qbank_papers…），
//! 不含任何领域逻辑，因此放在 vfs 内；题库领域模块按原路径重导出给调用方。

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::models::AppError;
use crate::vfs::repos::VfsExamRepo;

fn storage(error: impl std::fmt::Display) -> AppError {
    AppError::database(error.to_string())
}

/// Keep files referenced by an archived paper or practice snapshot.
/// Soft-deleted history still owns its assets until explicitly purged.
pub fn retains_asset(conn: &Connection, value: &str) -> Result<bool, rusqlite::Error> {
    for table in [
        "qbank_papers",
        "qbank_practice_drafts",
        "qbank_practice_attempts",
    ] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )?;
        if !exists {
            continue;
        }
        let retained: bool = conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table},json_tree(document_json) j WHERE j.key IN ('id','hash') AND j.value=?1)"), [value], |r| r.get(0))?;
        if retained {
            return Ok(true);
        }
        let answers: bool = conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table},json_each(document_json,'$.answers') a,json_tree(CASE WHEN json_valid(a.value) THEN a.value ELSE '{{}}' END) j WHERE j.key IN ('id','hash') AND j.value=?1)"), [value], |r| r.get(0))?;
        if answers {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn refresh_canonical_preview_with_conn(
    conn: &Connection,
    exam_id: &str,
) -> Result<(), AppError> {
    let text: Option<String> = conn
        .query_row(
            "SELECT preview_json FROM exam_sheets WHERE id=?1",
            [exam_id],
            |r| r.get(0),
        )
        .map_err(storage)?;
    let mut preview: Value = text
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({"pages":[]}));
    if !preview["pages"].is_array() {
        preview["pages"] = json!([]);
    }
    for page in preview["pages"].as_array_mut().unwrap() {
        page["cards"] = json!([]);
    }
    let mut source_pages = HashMap::new();
    let mut descriptors=conn.prepare("SELECT id,descriptor_json FROM qbank_sources WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at,id").map_err(storage)?;
    for row in descriptors
        .query_map([exam_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage)?
    {
        let (source, descriptor) = row.map_err(storage)?;
        let descriptor: Value = serde_json::from_str(&descriptor).map_err(storage)?;
        for page in descriptor["pages"].as_array().into_iter().flatten() {
            let hash = page["blob_hash"]
                .as_str()
                .ok_or_else(|| AppError::validation("来源页面缺少blob_hash"))?;
            let existing = preview["pages"]
                .as_array()
                .unwrap()
                .iter()
                .position(|p| p["blob_hash"] == hash);
            let index = match existing {
                Some(index) => index,
                None => {
                    let index = preview["pages"].as_array().unwrap().len();
                    preview["pages"].as_array_mut().unwrap().push(json!({"page_index":index,"blob_hash":hash,"width":page["width"],"height":page["height"],"cards":[],"ocr_completed":true,"parse_completed":true}));
                    index
                }
            };
            source_pages.insert((source.clone(), page["page"].as_u64().unwrap_or(1)), index);
        }
    }
    drop(descriptors);
    if preview["pages"].as_array().unwrap().is_empty() {
        preview["pages"] = json!([{"page_index":0,"cards":[]}]);
    }
    let mut stmt=conn.prepare("SELECT COALESCE(card_id,id),question_label,content,question_type,answer,explanation,options_json,structured_data,images_json,provenance_json,group_id FROM questions WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at,rowid").map_err(storage)?;
    let rows = stmt
        .query_map([exam_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, Option<String>>(10)?,
            ))
        })
        .map_err(storage)?;
    for row in rows {
        let (
            id,
            label,
            content,
            kind,
            answer,
            explanation,
            options,
            structured,
            images,
            provenance,
            group,
        ) = row.map_err(storage)?;
        let refs: Value = provenance
            .and_then(|p| serde_json::from_str(&p).ok())
            .unwrap_or(Value::Null);
        let reference = &refs["source_refs"][0];
        let page = source_pages
            .get(&(
                reference["source_id"].as_str().unwrap_or("").to_string(),
                reference["page"].as_u64().unwrap_or(1),
            ))
            .copied()
            .unwrap_or(0);
        let page = page.min(preview["pages"].as_array().unwrap().len() - 1);
        preview["pages"][page]["cards"].as_array_mut().unwrap().push(json!({"card_id":id,"question_label":label.unwrap_or_default(),"ocr_text":content,"question_type":kind,"answer":answer,"explanation":explanation,"options":options.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"structured_data":structured.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"images":serde_json::from_str::<Value>(&images).unwrap_or(json!([])),"group_id":group,"page_index":page}));
    }
    drop(stmt);
    VfsExamRepo::update_preview_json_with_conn(conn, exam_id, preview).map_err(storage)
}
