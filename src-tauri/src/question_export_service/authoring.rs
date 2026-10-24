//! Canonical, lossless interchange and hash-verified portable assets.
use crate::models::AppError;
use crate::qbank_document::QuestionDocument;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{QuestionFilters, VfsBlobRepo, VfsFileRepo, VfsQuestionRepo};
use base64::Engine;
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Cursor, Read, Write};

fn error(e: impl std::fmt::Display) -> AppError {
    AppError::database(e.to_string())
}
pub fn export_document(db: &VfsDatabase, exam_id: &str) -> Result<Value, AppError> {
    let mut questions = Vec::new();
    let mut page = 1;
    loop {
        let result =
            VfsQuestionRepo::list_questions(db, exam_id, &QuestionFilters::default(), page, 100)
                .map_err(error)?;
        questions.extend(result.questions);
        if !result.has_more {
            break;
        }
        page += 1;
    }
    let conn = db.get_conn_safe().map_err(error)?;
    let mut materials = Vec::new();
    let mut groups = Vec::new();
    let mut sources = Vec::new();
    let mut pages = Vec::new();
    let mut stmt=conn.prepare("SELECT id,content,images_json,source_refs_json FROM qbank_materials WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at,id").map_err(error)?;
    for row in stmt
        .query_map([exam_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(error)?
    {
        let (id, content, images, refs) = row.map_err(error)?;
        materials.push(json!({"local_id":id,"content":content,"images":serde_json::from_str::<Value>(&images).map_err(error)?,"source_refs":serde_json::from_str::<Value>(&refs).map_err(error)?}));
    }
    drop(stmt);
    let mut stmt=conn.prepare("SELECT id,label FROM qbank_groups WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY position,id").map_err(error)?;
    for row in stmt
        .query_map([exam_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(error)?
    {
        let (id, label) = row.map_err(error)?;
        let mut links=conn.prepare("SELECT l.material_id FROM qbank_group_materials l JOIN qbank_materials m ON m.id=l.material_id WHERE l.group_id=?1 AND l.deleted_at IS NULL AND m.deleted_at IS NULL ORDER BY l.position,l.id").map_err(error)?;
        let mids = links
            .query_map([&id], |r| r.get::<_, String>(0))
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        let mut members=conn.prepare("SELECT id FROM questions WHERE group_id=?1 AND deleted_at IS NULL ORDER BY group_position,id").map_err(error)?;
        let qids = members
            .query_map([&id], |r| r.get::<_, String>(0))
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        if !qids.is_empty() {
            groups
                .push(json!({"local_id":id,"label":label,"material_ids":mids,"question_ids":qids}));
        }
    }
    drop(stmt);
    let mut stmt=conn.prepare("SELECT id,descriptor_json FROM qbank_sources WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at,id").map_err(error)?;
    for row in stmt
        .query_map([exam_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(error)?
    {
        let (id, descriptor) = row.map_err(error)?;
        let mut descriptor: Value = serde_json::from_str(&descriptor).map_err(error)?;
        descriptor["source_id"] = json!(id);
        for mut page in descriptor["pages"]
            .as_array()
            .into_iter()
            .flatten()
            .cloned()
        {
            page["source_id"] = json!(id);
            pages.push(page);
        }
        sources.push(descriptor);
    }
    drop(stmt);
    let mut items = Vec::new();
    for q in questions {
        let (group, provenance, origin): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT group_id,provenance_json,answer_origin FROM questions WHERE id=?1",
                [&q.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(error)?;
        let provenance: Value = provenance
            .and_then(|p| serde_json::from_str(&p).ok())
            .unwrap_or(Value::Null);
        items.push(json!({"local_id":q.id,"group_id":group,"original_label":q.question_label,"content":q.content,"question_type":q.question_type,"options":q.options,"answer":q.answer,"explanation":q.explanation,"structured_data":q.structured_data,"difficulty":q.difficulty,"tags":q.tags,"images":q.images,"source_refs":provenance["source_refs"].as_array().cloned().unwrap_or_default(),"answer_source_refs":provenance["answer_source_refs"].as_array().cloned().unwrap_or_default(),"section_path":provenance["section_path"].as_array().cloned().unwrap_or_default(),"source_ref":q.source_ref,"answer_origin":origin,"variant_parent_local_id":q.parent_id}));
    }
    Ok(
        json!({"schema_version":2,"mode":"extract","materials":materials,"groups":groups,"questions":items,"coverage":[],"issues":[],"unmatched_answers":[],"sources":sources,"source_pages":pages}),
    )
}

#[derive(Debug, Serialize)]
pub struct PortableExport {
    pub base64: String,
    pub name: String,
}
fn hashes(value: &Value, out: &mut HashSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if matches!(key.as_str(), "hash" | "blob_hash") {
                    if let Some(hash) = value
                        .as_str()
                        .filter(|h| h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit()))
                    {
                        out.insert(hash.to_string());
                    }
                }
                hashes(value, out);
            }
        }
        Value::Array(values) => {
            for value in values {
                hashes(value, out);
            }
        }
        _ => {}
    }
}
pub fn export_portable(db: &VfsDatabase, exam_id: &str) -> Result<PortableExport, AppError> {
    let document = export_document(db, exam_id)?;
    let mut all = HashSet::new();
    hashes(&document, &mut all);
    let mut assets = BTreeMap::new();
    let mut total = 0usize;
    for hash in all {
        let path = VfsBlobRepo::get_blob_path(db, &hash)
            .map_err(error)?
            .ok_or_else(|| AppError::not_found(format!("导出缺少源资产: {hash}")))?;
        let bytes = std::fs::read(&path).map_err(error)?;
        total = total.saturating_add(bytes.len());
        if total > 200 * 1024 * 1024 {
            return Err(AppError::validation(
                "便携题库超过200MB安全限制，请减少来源资产后导出",
            ));
        }
        if hex::encode(Sha256::digest(&bytes)) != hash {
            return Err(AppError::validation("源资产哈希校验失败，已停止导出"));
        }
        assets.insert(hash, bytes);
    }
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("document.json", options).map_err(error)?;
    zip.write_all(document.to_string().as_bytes())
        .map_err(error)?;
    zip.start_file("manifest.json", options).map_err(error)?;
    zip.write_all(json!({"schema_version":2,"assets":assets.keys().map(|hash|json!({"hash":hash,"path":format!("assets/{hash}")})).collect::<Vec<_>>()}).to_string().as_bytes()).map_err(error)?;
    for (hash, bytes) in assets {
        zip.start_file(format!("assets/{hash}"), options)
            .map_err(error)?;
        zip.write_all(&bytes).map_err(error)?;
    }
    let bytes = zip.finish().map_err(error)?.into_inner();
    Ok(PortableExport {
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        name: format!("question-bank-{exam_id}.zip"),
    })
}

pub fn import_portable(
    db: &VfsDatabase,
    encoded: &str,
) -> Result<(QuestionDocument, Value), AppError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(error)?;
    if bytes.len() > 200 * 1024 * 1024 {
        return Err(AppError::validation("便携题库超过200MB安全限制"));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(error)?;
    let mut entries = HashMap::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(error)?;
        if file.is_dir() {
            continue;
        }
        if file.enclosed_name().is_none() || entries.contains_key(file.name()) {
            return Err(AppError::validation("便携包包含无效或重复路径"));
        }
        total = total.saturating_add(file.size());
        if total > 200 * 1024 * 1024 {
            return Err(AppError::validation("便携包解压超过安全限制"));
        }
        let name = file.name().to_string();
        let mut bytes = Vec::new();
        file.by_ref()
            .take(200 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        entries.insert(name, bytes);
    }
    let manifest: Value = serde_json::from_slice(
        entries
            .get("manifest.json")
            .ok_or_else(|| AppError::validation("缺少资产清单"))?,
    )
    .map_err(error)?;
    if manifest["schema_version"] != 2 {
        return Err(AppError::validation("便携包版本不支持"));
    }
    let mut document: Value = serde_json::from_slice(
        entries
            .get("document.json")
            .ok_or_else(|| AppError::validation("缺少题目文档"))?,
    )
    .map_err(error)?;
    let mut required = HashSet::new();
    hashes(&document, &mut required);
    let mut verified = HashSet::new();
    for asset in manifest["assets"]
        .as_array()
        .ok_or_else(|| AppError::validation("资产清单无效"))?
    {
        let hash = asset["hash"]
            .as_str()
            .ok_or_else(|| AppError::validation("资产缺少hash"))?;
        if asset["path"] != format!("assets/{hash}") || !verified.insert(hash.to_string()) {
            return Err(AppError::validation("资产路径或哈希重复"));
        }
        let bytes = entries
            .get(&format!("assets/{hash}"))
            .ok_or_else(|| AppError::not_found("便携包缺少声明资产"))?;
        if hex::encode(Sha256::digest(bytes)) != hash {
            return Err(AppError::validation("便携包资产哈希校验失败"));
        }
    }
    if required != verified {
        return Err(AppError::validation("便携包内容与资产清单不一致"));
    }
    let mut images = HashMap::new();
    for hash in verified {
        let bytes = &entries[&format!("assets/{hash}")];
        let mime = match image::guess_format(bytes) {
            Ok(image::ImageFormat::Png) => "image/png",
            Ok(image::ImageFormat::Jpeg) => "image/jpeg",
            Ok(image::ImageFormat::WebP) => "image/webp",
            _ => "application/octet-stream",
        };
        let blob = VfsBlobRepo::store_blob(db, bytes, Some(mime), None).map_err(error)?;
        if mime.starts_with("image/") {
            let name = format!(
                "figure_{hash}.{}",
                if mime == "image/png" {
                    "png"
                } else if mime == "image/jpeg" {
                    "jpg"
                } else {
                    "webp"
                }
            );
            let file = VfsFileRepo::create_file(
                db,
                &blob.hash,
                &name,
                bytes.len() as i64,
                "image",
                Some(mime),
                Some(&blob.hash),
                None,
            )
            .map_err(error)?;
            images.insert(
                hash,
                json!({"id":file.id,"name":name,"mime":mime,"hash":blob.hash}),
            );
        }
    }
    for field in ["questions", "materials"] {
        for item in document[field].as_array_mut().into_iter().flatten() {
            for image in item["images"].as_array_mut().into_iter().flatten() {
                let role = image.get("role").cloned();
                let name = image.get("name").cloned();
                let hash = image["hash"].as_str().unwrap_or("");
                *image = images
                    .get(hash)
                    .cloned()
                    .ok_or_else(|| AppError::validation("题目配图资产类型无效"))?;
                if let Some(role) = role {
                    image["role"] = role;
                }
                if let Some(name) = name {
                    image["name"] = name;
                }
            }
        }
    }
    let metadata = json!({"sources":document["sources"],"pages":document["source_pages"],"source_format":"portable_v2"});
    let document: QuestionDocument = serde_json::from_value(document).map_err(error)?;
    document.validate()?;
    Ok((document, metadata))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qbank_authoring_service::QuestionAuthoringService;
    use crate::vfs::repos::VfsExamRepo;
    use crate::vfs::types::VfsCreateExamSheetParams;
    use std::sync::Arc;
    fn exam(db: &VfsDatabase) -> String {
        VfsExamRepo::create_exam_sheet(
            db,
            VfsCreateExamSheetParams {
                exam_name: Some("reading".into()),
                temp_id: uuid::Uuid::new_v4().to_string(),
                metadata_json: json!({}),
                preview_json: json!({"pages":[]}),
                status: "empty".into(),
                folder_id: None,
            },
        )
        .unwrap()
        .id
    }
    #[test]
    fn portable_round_trip_preserves_materials_types_and_assets_across_databases() {
        let (_left, db) = crate::vfs::database::setup_migrated_test_db();
        let (_right, other) = crate::vfs::database::setup_migrated_test_db();
        let db = Arc::new(db);
        let other = Arc::new(other);
        let exam = exam(&db);
        let target = super::tests::exam(&other);
        let mut image = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(10, 10)
            .write_to(&mut image, image::ImageFormat::Png)
            .unwrap();
        let image = image.into_inner();
        let blob = VfsBlobRepo::store_blob(&db, &image, Some("image/png"), Some("png")).unwrap();
        let file = VfsFileRepo::create_file(
            &db,
            &blob.hash,
            "condition.png",
            image.len() as i64,
            "image",
            Some("image/png"),
            Some(&blob.hash),
            None,
        )
        .unwrap();
        let document:QuestionDocument=serde_json::from_value(json!({"schema_version":2,"mode":"extract","materials":[{"local_id":"m1","content":"Shared conditions","images":[{"id":file.id,"hash":blob.hash,"name":"condition.png","mime":"image/png"}]}],"groups":[{"local_id":"g1","label":"Conditions","material_ids":["m1"],"question_ids":["q1","q2"]}],"questions":[
            {"local_id":"q1","group_id":"g1","content":"Numeric question","question_type":"numeric","structured_data":{"answer_value":12.5,"tolerance":0.01}},
            {"local_id":"q2","group_id":"g1","content":"Explain","question_type":"short_answer","answer":null}
        ]})).unwrap();
        QuestionAuthoringService::new(db.clone())
            .submit_document(&exam, &document, "seed")
            .unwrap();
        let package = export_portable(&db, &exam).unwrap();
        let (imported, metadata) = import_portable(&other, &package.base64).unwrap();
        let service = QuestionAuthoringService::new(other.clone());
        let job = service.save_draft(&target, &imported, &metadata).unwrap();
        let receipt = service
            .commit_draft(
                &job,
                &imported
                    .questions
                    .iter()
                    .map(|q| q.local_id.clone())
                    .collect::<Vec<_>>(),
                1,
            )
            .unwrap();
        assert_eq!(receipt.imported_count, 2);
        let exported = export_document(&other, &target).unwrap();
        assert_eq!(exported["materials"].as_array().unwrap().len(), 1);
        assert_eq!(
            exported["groups"][0]["question_ids"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            exported["questions"][0]["structured_data"]["answer_value"],
            12.5
        );
        assert_eq!(exported["materials"][0]["images"][0]["hash"], blob.hash);
        assert_ne!(exported["materials"][0]["images"][0]["id"], file.id);
    }
}
