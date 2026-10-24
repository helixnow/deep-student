//! 判分上下文：题干 + 共享材料 + 附图 + 提交时快照。
//!
//! issue 491：判分不能只看题干和学生答案图。组内子题依赖的共享材料
//! （阅读文章、共同条件、材料配图）必须一并进入模型输入，否则判分会在
//! 缺失必要条件下盲判。题目/材料图与作答图统一走多模态消息，
//! 任一必需图片取不到就显式报错，不静默降级为纯文本。
//!
//! 提交时快照（`answer_submissions.question_snapshot_json` /
//! `material_snapshot_json`）用于让旧判分可复核：材料或题干被编辑后，
//! 历史 submission 仍按当时的版本判分。快照缺失（旧数据或迁移未落库）时
//! 退回 live canonical 内容。

use rusqlite::OptionalExtension;
use serde_json::json;

use crate::models::AppError;
use crate::qbank_document::QuestionMaterial;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{Question, QuestionImage, QuestionOption, VfsAttachmentRepo};

/// 单张图片解码后的上限（与 image_answer 对齐，50MB）
const MAX_IMAGE_DECODED_BYTES: usize = 50 * 1024 * 1024;

/// 进入多模态消息的一张图片
#[derive(Debug, Clone, PartialEq)]
pub struct GradingImage {
    pub base64: String,
    pub mime: String,
    /// 给模型看的标签（题干配图 / 材料「…」配图 / 学生作答图 N）
    pub label: String,
}

/// 判分使用的完整题目上下文
#[derive(Debug, Clone)]
pub struct GradingContext {
    pub content: String,
    pub question_type: String,
    pub question_label: Option<String>,
    pub options: Option<Vec<QuestionOption>>,
    pub structured_data: Option<serde_json::Value>,
    pub answer: Option<String>,
    pub explanation: Option<String>,
    pub materials: Vec<QuestionMaterial>,
    /// 题干/选项配图（引用，未取内容）
    pub question_images: Vec<QuestionImage>,
    /// 取回内容后的多模态图片（材料图在前、题干图在后）
    pub images: Vec<GradingImage>,
}

impl GradingContext {
    /// 无 DB 的纯题目上下文（单测/无材料场景）
    pub fn from_question(question: &Question) -> Self {
        Self {
            content: question.content.clone(),
            question_type: format!("{:?}", question.question_type),
            question_label: question.question_label.clone(),
            options: question.options.clone(),
            structured_data: question.structured_data.clone(),
            answer: question.answer.clone(),
            explanation: question.explanation.clone(),
            materials: Vec::new(),
            question_images: question.images.clone(),
            images: Vec::new(),
        }
    }

    /// 从 canonical 题目 + 材料加载完整上下文。
    pub fn load(
        db: &VfsDatabase,
        question: &Question,
        question_snapshot: Option<&str>,
        material_snapshot: Option<&str>,
    ) -> Result<Self, AppError> {
        let conn = db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let materials = load_question_materials_with_conn(&conn, &question.id)?;
        drop(conn);

        let mut context = Self {
            content: question.content.clone(),
            question_type: format!("{:?}", question.question_type),
            question_label: question.question_label.clone(),
            options: question.options.clone(),
            structured_data: question.structured_data.clone(),
            answer: question.answer.clone(),
            explanation: question.explanation.clone(),
            materials,
            question_images: question.images.clone(),
            images: Vec::new(),
        };
        context.apply_snapshots(question_snapshot, material_snapshot)?;
        context.images = fetch_context_images(db, &context.materials, &context.question_images)?;
        Ok(context)
    }

    /// 用 submission 快照覆盖 live 内容。
    ///
    /// 快照是判分版本权威：显式 null 表示"提交时该字段就是空"，
    /// 必须覆盖 live 值，避免编辑后新答案/选项泄漏进历史判分。
    /// 快照存在但损坏时返回错误——不能静默退回 live 内容冒充当时版本。
    pub fn apply_snapshots(
        &mut self,
        question_snapshot: Option<&str>,
        material_snapshot: Option<&str>,
    ) -> Result<(), AppError> {
        if let Some(raw) = question_snapshot {
            let snapshot: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
                AppError::validation(format!("作答提交快照损坏，无法复核本次判分: {}", e))
            })?;
            if let Some(content) = snapshot.get("content").and_then(|v| v.as_str()) {
                if !content.trim().is_empty() {
                    self.content = content.to_string();
                }
            }
            if snapshot.get("question_label").is_some() {
                self.question_label = snapshot
                    .get("question_label")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            if snapshot.get("question_type").is_some() {
                if let Some(value) = snapshot.get("question_type").and_then(|v| v.as_str()) {
                    self.question_type =
                        format!("{:?}", crate::vfs::repos::QuestionType::from_str(value));
                }
            }
            if snapshot.get("options").is_some() {
                self.options = match snapshot.get("options") {
                    Some(serde_json::Value::Null) | None => None,
                    Some(value) => Some(
                        serde_json::from_value::<Vec<QuestionOption>>(value.clone()).map_err(
                            |e| AppError::validation(format!("作答提交快照中的选项损坏: {}", e)),
                        )?,
                    ),
                };
            }
            if snapshot.get("answer").is_some() {
                self.answer = snapshot
                    .get("answer")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            if snapshot.get("explanation").is_some() {
                self.explanation = snapshot
                    .get("explanation")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            if snapshot.get("structured_data").is_some() {
                self.structured_data = snapshot
                    .get("structured_data")
                    .filter(|v| !v.is_null())
                    .cloned();
            }
            if snapshot.get("images").is_some() {
                self.question_images = match snapshot.get("images") {
                    Some(serde_json::Value::Null) | None => Vec::new(),
                    Some(value) => serde_json::from_value::<Vec<QuestionImage>>(value.clone())
                        .map_err(|e| {
                            AppError::validation(format!("作答提交快照中的题目图片损坏: {}", e))
                        })?,
                };
            }
        }
        if let Some(raw) = material_snapshot {
            let snapshot: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
                AppError::validation(format!("作答材料快照损坏，无法复核本次判分: {}", e))
            })?;
            // 兼容两种快照形态：v2 根对象 `{"materials":[…]}`（提交路径写入）
            // 与旧版直接数组。对象形态缺 materials 键视为空材料，不猜内容。
            let materials_value = match snapshot {
                serde_json::Value::Null => serde_json::Value::Null,
                serde_json::Value::Array(_) => snapshot,
                serde_json::Value::Object(ref map) => map
                    .get("materials")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                _ => {
                    return Err(AppError::validation(
                        "作答材料快照内容损坏: 期望数组或 {materials:[]} 对象".to_string(),
                    ))
                }
            };
            self.materials = match materials_value {
                serde_json::Value::Null => Vec::new(),
                value => serde_json::from_value::<Vec<QuestionMaterial>>(value)
                    .map_err(|e| AppError::validation(format!("作答材料快照内容损坏: {}", e)))?,
            };
        }
        Ok(())
    }
}

/// 读取 submission 上的版本快照；列不存在（旧库/旧测试库）时返回空。
pub fn submission_snapshots(
    conn: &rusqlite::Connection,
    submission_id: &str,
) -> (Option<String>, Option<String>) {
    conn.query_row(
        "SELECT question_snapshot_json, material_snapshot_json
         FROM answer_submissions WHERE id = ?1",
        [submission_id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        },
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or((None, None))
}

/// 题目所属题组的共享材料（按组的材料顺序返回，去重）。
pub fn load_question_materials_with_conn(
    conn: &rusqlite::Connection,
    question_id: &str,
) -> Result<Vec<QuestionMaterial>, AppError> {
    let sql = r#"
        SELECT m.id
        FROM questions q
        JOIN qbank_group_materials gm
          ON gm.group_id = q.group_id AND gm.exam_id = q.exam_id AND gm.deleted_at IS NULL
        JOIN qbank_materials m
          ON m.id = gm.material_id AND m.exam_id = gm.exam_id AND m.deleted_at IS NULL
        WHERE q.id = ?1 AND q.deleted_at IS NULL AND q.group_id IS NOT NULL
        ORDER BY gm.position ASC, m.id ASC
    "#;
    let ids: Vec<String> = match conn.prepare(sql) {
        Ok(mut stmt) => {
            let rows = stmt
                .query_map([question_id], |row| row.get::<_, String>(0))
                .map_err(|e| AppError::database(format!("查询共享材料失败: {}", e)))?;
            let mut seen = std::collections::HashSet::new();
            let mut ids = Vec::new();
            for row in rows.flatten() {
                if seen.insert(row.clone()) {
                    ids.push(row);
                }
            }
            ids
        }
        // 迁移未应用的库（旧测试库）没有材料表：按无材料处理
        Err(err) if err.to_string().contains("no such table") => Vec::new(),
        Err(err) => return Err(AppError::database(format!("准备共享材料查询失败: {}", err))),
    };

    let mut materials = Vec::with_capacity(ids.len());
    for id in ids {
        let material = crate::qbank_authoring_service::read_material(conn, &id)?;
        materials.push(material);
    }
    Ok(materials)
}

/// 题干图 + 材料图 → 多模态图片。缺图显式报错（判分缺图等于盲判）。
fn fetch_context_images(
    db: &VfsDatabase,
    materials: &[QuestionMaterial],
    question_images: &[QuestionImage],
) -> Result<Vec<GradingImage>, AppError> {
    let mut refs: Vec<(String, &QuestionImage)> = Vec::new();
    for material in materials {
        let label = material_label(material);
        for image in &material.images {
            refs.push((format!("材料「{}」配图", label), image));
        }
    }
    for image in question_images {
        refs.push((image_role_label(image), image));
    }

    let mut images = Vec::with_capacity(refs.len());
    for (label, image) in refs {
        let base64 = VfsAttachmentRepo::get_content_bounded(
            db,
            &image.id,
            MAX_IMAGE_DECODED_BYTES as u64,
        )
        .map_err(|e| {
            AppError::database(format!(
                "读取题目/材料配图失败（附件 {}）：{}",
                image.id, e
            ))
        })?
        .ok_or_else(|| {
            AppError::not_found(format!(
                "题目/材料配图缺失或尚未同步到本机（{}，附件 {}），无法判分。请重新上传该图片或补齐材料。",
                image.name, image.id
            ))
        })?;
        let mime = if image.mime.trim().is_empty() {
            "image/jpeg".to_string()
        } else {
            image.mime.clone()
        };
        images.push(GradingImage {
            base64,
            mime,
            label,
        });
    }
    Ok(images)
}

fn material_label(material: &QuestionMaterial) -> String {
    let trimmed = material.content.trim();
    if trimmed.is_empty() {
        material.id.clone()
    } else {
        trimmed.chars().take(20).collect::<String>()
    }
}

/// 图片角色（data 层新增 `role`）优先用于提示词标签；缺省按题干配图。
fn image_role_label(image: &QuestionImage) -> String {
    match image.role.as_deref().map(str::trim) {
        Some("material") => "材料配图".to_string(),
        Some("option") => "选项配图".to_string(),
        Some("answer") => "答案区配图".to_string(),
        Some("question") => "题干配图".to_string(),
        Some(other) if !other.is_empty() => format!("配图（{}）", other),
        _ => "题干配图".to_string(),
    }
}

/// 提交时的题目版本快照（由提交路径写入 question_snapshot_json）。
pub fn question_snapshot_json(question: &Question) -> serde_json::Value {
    json!({
        "id": question.id,
        "exam_id": question.exam_id,
        "question_label": question.question_label,
        "content": question.content,
        "question_type": question.question_type.as_str(),
        "options": question.options,
        "answer": question.answer,
        "explanation": question.explanation,
        "structured_data": question.structured_data,
        "images": question.images,
        "source_ref": question.source_ref,
        "updated_at": question.updated_at,
    })
}

/// 提交时的材料版本快照（由提交路径写入 material_snapshot_json）。
pub fn material_snapshot_json(materials: &[QuestionMaterial]) -> serde_json::Value {
    serde_json::to_value(materials).unwrap_or_else(|_| json!([]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::repos::QuestionType;

    fn question() -> Question {
        Question {
            id: "q1".into(),
            exam_id: "exam1".into(),
            card_id: None,
            question_label: Some("1".into()),
            content: "原始题干".into(),
            options: None,
            answer: Some("原始答案".into()),
            explanation: None,
            structured_data: None,
            question_type: QuestionType::ShortAnswer,
            difficulty: None,
            tags: vec![],
            status: crate::vfs::repos::question_repo::QuestionStatus::New,
            user_answer: None,
            is_correct: None,
            attempt_count: 0,
            correct_count: 0,
            last_attempt_at: None,
            user_note: None,
            is_favorite: false,
            is_bookmarked: false,
            source_type: crate::vfs::repos::question_repo::SourceType::Manual,
            source_ref: None,
            images: vec![],
            parent_id: None,
            created_at: String::new(),
            updated_at: String::new(),
            ai_feedback: None,
            ai_score: None,
            ai_graded_at: None,
            ..Default::default()
        }
    }

    #[test]
    fn snapshot_overrides_live_question_version() {
        let mut context = GradingContext::from_question(&question());
        let snapshot = json!({
            "content": "提交时题干",
            "answer": "提交时答案",
            "question_label": "2",
            "options": [{"key": "A", "content": "选项甲"}],
        })
        .to_string();
        context.apply_snapshots(Some(&snapshot), None).unwrap();
        assert_eq!(context.content, "提交时题干");
        assert_eq!(context.answer.as_deref(), Some("提交时答案"));
        assert_eq!(context.question_label.as_deref(), Some("2"));
        assert_eq!(context.options.as_ref().map(|o| o.len()), Some(1));
    }

    #[test]
    fn corrupted_snapshot_is_reported_not_silently_ignored() {
        let mut context = GradingContext::from_question(&question());
        assert!(context.apply_snapshots(Some("not-json"), None).is_err());
        assert!(context.apply_snapshots(None, Some("{")).is_err());
    }

    #[test]
    fn material_snapshot_replaces_live_materials() {
        let mut context = GradingContext::from_question(&question());
        let snapshot = json!({"materials": [{
            "id": "m1",
            "content": "提交时共享材料",
            "images": [],
            "source_refs": [],
            "version": 3
        }]})
        .to_string();
        context.apply_snapshots(None, Some(&snapshot)).unwrap();
        assert_eq!(context.materials.len(), 1);
        assert_eq!(context.materials[0].version, 3);
        assert_eq!(context.materials[0].content, "提交时共享材料");
    }

    #[test]
    fn legacy_array_material_snapshot_is_still_readable() {
        let mut context = GradingContext::from_question(&question());
        let snapshot = json!([{
            "id": "m1",
            "content": "旧版数组材料",
            "images": [],
            "source_refs": [],
            "version": 1
        }])
        .to_string();
        context.apply_snapshots(None, Some(&snapshot)).unwrap();
        assert_eq!(context.materials.len(), 1);
        assert_eq!(context.materials[0].content, "旧版数组材料");
    }

    /// 回归：材料在提交后被编辑，旧 submission 仍按提交时版本判分。
    #[test]
    fn edited_material_does_not_leak_into_old_submission_grading() {
        let mut context = GradingContext::from_question(&question());
        context.materials = vec![QuestionMaterial {
            id: "m1".to_string(),
            content: "编辑后的新材料内容".to_string(),
            images: Vec::new(),
            source_refs: Vec::new(),
            version: 9,
        }];
        let snapshot = json!({"materials": [{
            "id": "m1",
            "content": "提交时的旧材料内容",
            "images": [],
            "source_refs": [],
            "version": 2
        }]})
        .to_string();
        context.apply_snapshots(None, Some(&snapshot)).unwrap();
        assert_eq!(context.materials[0].version, 2);
        assert_eq!(context.materials[0].content, "提交时的旧材料内容");
    }

    #[test]
    fn explicit_null_snapshot_clears_live_answer_and_options() {
        let mut question = question();
        question.options = Some(vec![QuestionOption {
            key: "A".into(),
            content: "live 选项".into(),
        }]);
        let mut context = GradingContext::from_question(&question);
        let snapshot = json!({
            "content": "提交时题干",
            "question_type": "single_choice",
            "options": null,
            "answer": null,
            "explanation": null,
            "structured_data": null,
            "images": []
        })
        .to_string();
        context.apply_snapshots(Some(&snapshot), None).unwrap();
        assert!(context.options.is_none());
        assert!(context.answer.is_none());
        assert!(context.explanation.is_none());
        assert!(context.structured_data.is_none());
        assert_eq!(context.question_type, "SingleChoice");
    }

    #[test]
    fn question_snapshot_keeps_grading_fields() {
        let value = question_snapshot_json(&question());
        assert_eq!(value["id"], "q1");
        assert_eq!(value["content"], "原始题干");
        assert_eq!(value["question_type"], "short_answer");
        assert_eq!(value["answer"], "原始答案");
    }
}
