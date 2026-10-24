//! Read-only canonical question context, shared by references and indexing.
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub fn context_with_conn(conn: &Connection, exam_id: &str) -> Result<Option<Value>, String> {
    let mut stmt=conn.prepare("SELECT id,question_label,content,question_type,options_json,answer,explanation,structured_data,images_json,group_id,group_position,provenance_json FROM questions WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at,rowid").map_err(|e|e.to_string())?;
    let mut rows = stmt.query([exam_id]).map_err(|e| e.to_string())?;
    let mut questions = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let parsed = |index| -> Result<Value, rusqlite::Error> {
            Ok(row
                .get::<_, Option<String>>(index)?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null))
        };
        questions.push(json!({"id":row.get::<_,String>(0).map_err(|e|e.to_string())?,"original_label":row.get::<_,Option<String>>(1).map_err(|e|e.to_string())?,"content":row.get::<_,String>(2).map_err(|e|e.to_string())?,"question_type":row.get::<_,String>(3).map_err(|e|e.to_string())?,"options":parsed(4).map_err(|e|e.to_string())?,"answer":row.get::<_,Option<String>>(5).map_err(|e|e.to_string())?,"explanation":row.get::<_,Option<String>>(6).map_err(|e|e.to_string())?,"structured_data":parsed(7).map_err(|e|e.to_string())?,"images":parsed(8).map_err(|e|e.to_string())?,"group_id":row.get::<_,Option<String>>(9).map_err(|e|e.to_string())?,"group_position":row.get::<_,Option<i64>>(10).map_err(|e|e.to_string())?,"provenance":parsed(11).map_err(|e|e.to_string())?}));
    }
    let canonical:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM exam_sheets WHERE id=?1 AND json_extract(metadata_json,'$.question_document_version')=2)",[exam_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if questions.is_empty() && !canonical {
        return Ok(None);
    }
    let mut stmt=conn.prepare("SELECT DISTINCT m.id,m.content,m.images_json,m.source_refs_json,m.local_version FROM qbank_materials m JOIN qbank_group_materials l ON l.material_id=m.id JOIN qbank_groups g ON g.id=l.group_id WHERE m.exam_id=?1 AND m.deleted_at IS NULL AND l.deleted_at IS NULL AND g.deleted_at IS NULL AND EXISTS(SELECT 1 FROM questions q WHERE q.group_id=g.id AND q.deleted_at IS NULL) ORDER BY m.created_at,m.id").map_err(|e|e.to_string())?;
    let materials=stmt.query_map([exam_id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"content":r.get::<_,String>(1)?,"images":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(json!([])),"source_refs":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!([])),"version":r.get::<_,i64>(4)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let mut stmt=conn.prepare("SELECT g.id,g.label,g.local_version,l.material_id FROM qbank_groups g LEFT JOIN qbank_group_materials l ON l.group_id=g.id AND l.deleted_at IS NULL WHERE g.exam_id=?1 AND g.deleted_at IS NULL ORDER BY g.position,l.position").map_err(|e|e.to_string())?;
    let groups=stmt.query_map(params![exam_id],|r|Ok(json!({"group_id":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,"version":r.get::<_,i64>(2)?,"material_id":r.get::<_,Option<String>>(3)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(Some(
        json!({"schema_version":2,"exam_id":exam_id,"materials":materials,"groups":groups,"questions":questions}),
    ))
}

pub fn context_text(document: &Value) -> String {
    let mut lines = Vec::new();
    for material in document["materials"].as_array().into_iter().flatten() {
        lines.push(format!(
            "Shared material {}\n{}",
            material["id"].as_str().unwrap_or(""),
            material["content"].as_str().unwrap_or("")
        ));
    }
    for question in document["questions"].as_array().into_iter().flatten() {
        lines.push(format!("Question {}\n{}\noptions: {}\nanswer: {}\nexplanation: {}\nstructured_data: {}\ngroup: {}\nsource: {}",question["id"].as_str().unwrap_or(""),question["content"].as_str().unwrap_or(""),question["options"],question["answer"],question["explanation"],question["structured_data"],question["group_id"],question["provenance"]));
    }
    lines.join("\n\n")
}

pub fn image_refs(document: &Value) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut images = Vec::new();
    for item in document["materials"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(document["questions"].as_array().into_iter().flatten())
    {
        for image in item["images"].as_array().into_iter().flatten() {
            if let Some(hash) = image["hash"].as_str() {
                if seen.insert(hash.to_string()) {
                    images.push(image.clone());
                }
            }
        }
    }
    images
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qbank_authoring_service::QuestionAuthoringService;
    use crate::qbank_document::QuestionDocument;
    use crate::vfs::database::VfsDatabase;
    use crate::vfs::repos::VfsExamRepo;
    use crate::vfs::types::VfsCreateExamSheetParams;
    use std::sync::Arc;
    #[test]
    fn canonical_context_reads_current_questions_and_deduplicates_materials() {
        let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
        let db = Arc::new(db);
        let exam = VfsExamRepo::create_exam_sheet(
            &db,
            VfsCreateExamSheetParams {
                exam_name: Some("test".into()),
                temp_id: "tmp".into(),
                preview_json: json!({"pages":[{"cards":[{"ocr_text":"STALE SNAPSHOT"}]}]}),
                metadata_json: json!({}),
                status: "empty".into(),
                folder_id: None,
            },
        )
        .unwrap();
        let doc:QuestionDocument=serde_json::from_value(json!({"schema_version":2,"mode":"extract","materials":[{"local_id":"m1","content":"Shared passage"}],"groups":[{"local_id":"g1","label":"Reading","material_ids":["m1"],"question_ids":["q1","q2"]}],"questions":[{"local_id":"q1","content":"First","question_type":"short_answer","group_id":"g1"},{"local_id":"q2","content":"Second","question_type":"short_answer","group_id":"g1"}]})).unwrap();
        let authoring = QuestionAuthoringService::new(db.clone());
        let receipt = authoring.submit_document(&exam.id, &doc, "seed").unwrap();
        let conn = db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE questions SET content='CURRENT EDIT' WHERE id=?1",
            [&receipt.question_ids[0]],
        )
        .unwrap();
        let context = context_with_conn(&conn, &exam.id).unwrap().unwrap();
        assert_eq!(context["materials"].as_array().unwrap().len(), 1);
        assert_eq!(context["questions"].as_array().unwrap().len(), 2);
        let text = context_text(&context);
        assert!(text.contains("CURRENT EDIT"));
        assert!(!text.contains("STALE SNAPSHOT"));
        assert_eq!(text.matches("Shared passage").count(), 1);
    }
}
