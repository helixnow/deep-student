//! Versioned authoring interchange. Model local identities never become DB ids.
use crate::models::AppError;
use crate::vfs::repos::{QuestionImage, QuestionOption};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SourceRef {
    pub source_id: String,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub bbox: Option<[f64; 4]>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DraftFigure {
    pub source_id: String,
    #[serde(default)]
    pub page: Option<u32>,
    pub bbox: [f64; 4],
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub role: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DraftMaterial {
    pub local_id: String,
    pub content: String,
    #[serde(default)]
    pub source_refs: Vec<SourceRef>,
    #[serde(default)]
    pub figures: Vec<DraftFigure>,
    #[serde(default)]
    pub images: Vec<QuestionImage>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DraftGroup {
    pub local_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub material_ids: Vec<String>,
    pub question_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DraftQuestion {
    pub local_id: String,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default, alias = "questionLabel", alias = "question_label")]
    pub original_label: Option<String>,
    #[serde(default)]
    pub section_path: Vec<String>,
    pub content: String,
    #[serde(alias = "questionType")]
    pub question_type: String,
    #[serde(default)]
    pub options: Option<Vec<QuestionOption>>,
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub structured_data: Option<Value>,
    #[serde(default)]
    pub difficulty: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_refs: Vec<SourceRef>,
    #[serde(default)]
    pub answer_source_refs: Vec<SourceRef>,
    #[serde(default)]
    pub figures: Vec<DraftFigure>,
    #[serde(default)]
    pub images: Vec<QuestionImage>,
    #[serde(default)]
    pub answer_origin: Option<String>,
    #[serde(default)]
    pub smiles: Option<String>,
    #[serde(default)]
    pub smiles_caption: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default, alias = "variant_parent_local_id")]
    pub parent_local_id: Option<String>,
    #[serde(default)]
    pub source_ref: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionDocument {
    pub schema_version: u32,
    pub mode: String,
    #[serde(default)]
    pub materials: Vec<DraftMaterial>,
    #[serde(default)]
    pub groups: Vec<DraftGroup>,
    pub questions: Vec<DraftQuestion>,
    #[serde(default)]
    pub unmatched_answers: Vec<Value>,
    #[serde(default)]
    pub coverage: Vec<Value>,
    #[serde(default)]
    pub issues: Vec<Value>,
}
impl Default for QuestionDocument {
    fn default() -> Self {
        Self {
            schema_version: 2,
            mode: "extract".into(),
            materials: vec![],
            groups: vec![],
            questions: vec![],
            unmatched_answers: vec![],
            coverage: vec![],
            issues: vec![],
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QuestionMaterial {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<QuestionImage>,
    #[serde(default)]
    pub source_refs: Vec<SourceRef>,
    pub version: i64,
}

impl QuestionDocument {
    pub fn validate(&self) -> Result<(), AppError> {
        let invalid = |message: &str| AppError::validation(format!("题目文档校验失败: {message}"));
        if self.schema_version != 2 || !matches!(self.mode.as_str(), "extract" | "generate") {
            return Err(invalid("版本或任务模式不支持"));
        }
        if self.questions.is_empty() {
            return Err(invalid("没有可作答题目"));
        }
        let mut all = HashSet::new();
        for id in self
            .materials
            .iter()
            .map(|m| &m.local_id)
            .chain(self.groups.iter().map(|g| &g.local_id))
            .chain(self.questions.iter().map(|q| &q.local_id))
        {
            if id.trim().is_empty() || !all.insert(id) {
                return Err(invalid("local_id 为空或重复"));
            }
        }
        let materials: HashSet<_> = self.materials.iter().map(|m| m.local_id.as_str()).collect();
        let groups: HashMap<_, _> = self
            .groups
            .iter()
            .map(|g| (g.local_id.as_str(), g))
            .collect();
        let questions: HashMap<_, _> = self
            .questions
            .iter()
            .map(|q| (q.local_id.as_str(), q))
            .collect();
        for group in &self.groups {
            let mut members = HashSet::new();
            let mut refs = HashSet::new();
            if group.question_ids.is_empty() {
                return Err(invalid("题组没有子题"));
            }
            for id in &group.material_ids {
                if !materials.contains(id.as_str()) {
                    return Err(invalid(&format!(
                        "groups[{}].material_ids 引用了不存在的材料 {id}；请在 materials 中提供该 local_id 的完整正文，不要删除材料引用或只重发子题",
                        group.local_id
                    )));
                }
                if !refs.insert(id) {
                    return Err(invalid(&format!(
                        "groups[{}].material_ids 重复引用材料 {id}",
                        group.local_id
                    )));
                }
            }
            for id in &group.question_ids {
                if !members.insert(id)
                    || questions
                        .get(id.as_str())
                        .is_none_or(|q| q.group_id.as_deref() != Some(group.local_id.as_str()))
                {
                    return Err(invalid(&format!(
                        "groups[{}].question_ids 的成员 {id} 缺失、重复或其 group_id 不一致",
                        group.local_id
                    )));
                }
            }
        }
        for material in &self.materials {
            if material.content.trim().is_empty() && material.images.is_empty() {
                return Err(invalid("共享材料为空"));
            }
            validate_refs(&material.source_refs)?;
        }
        const TYPES: &[&str] = &[
            "single_choice",
            "multiple_choice",
            "indefinite_choice",
            "fill_blank",
            "short_answer",
            "essay",
            "calculation",
            "proof",
            "true_false",
            "matching",
            "ordering",
            "numeric",
            "other",
        ];
        for q in &self.questions {
            if q.parent_local_id
                .as_deref()
                .is_some_and(|id| id == q.local_id || !questions.contains_key(id))
            {
                return Err(invalid("变式父题临时身份不存在或自引用"));
            }
            if q.content.trim().is_empty() || !TYPES.contains(&q.question_type.as_str()) {
                return Err(invalid("题干为空或题型无效"));
            }
            if let Some(id) = &q.group_id {
                if groups
                    .get(id.as_str())
                    .is_none_or(|g| !g.question_ids.contains(&q.local_id))
                {
                    return Err(invalid(&format!(
                        "questions[{}].group_id={id} 没有对应的题组成员身份",
                        q.local_id
                    )));
                }
            }
            validate_refs(&q.source_refs)?;
            validate_refs(&q.answer_source_refs)?;
            if let Some(d) = &q.difficulty {
                if !matches!(d.as_str(), "easy" | "medium" | "hard" | "very_hard") {
                    return Err(invalid("难度无效"));
                }
            }
            if matches!(
                q.question_type.as_str(),
                "single_choice" | "multiple_choice" | "indefinite_choice"
            ) {
                let opts = q.options.as_deref().unwrap_or(&[]);
                let mut keys = HashSet::new();
                if opts.len() < 2 {
                    return Err(invalid("选择题至少需要两个选项"));
                }
                for option in opts {
                    if option.key.trim().is_empty()
                        || option.content.trim().is_empty()
                        || !keys.insert(option.key.as_str())
                    {
                        return Err(invalid("选项键/内容为空或重复"));
                    }
                }
                if let Some(answer) = q.answer.as_deref().filter(|a| !a.trim().is_empty()) {
                    let answers: Vec<_> = answer
                        .split([',', ' ', '|', '、'])
                        .filter(|a| !a.is_empty())
                        .collect();
                    let count = if keys.contains(answer) {
                        1
                    } else {
                        if answers.len() > 1 {
                            if answers.iter().any(|a| !keys.contains(a)) {
                                return Err(invalid("答案引用不存在的选项"));
                            }
                            answers.len()
                        } else {
                            if answer
                                .chars()
                                .any(|c| !keys.contains(c.to_string().as_str()))
                            {
                                return Err(invalid("答案引用不存在的选项"));
                            }
                            answer.chars().count()
                        }
                    };
                    if q.question_type == "single_choice" && count != 1 {
                        return Err(invalid("单选题答案必须唯一"));
                    }
                }
            }
            if q.question_type == "true_false"
                && q.answer
                    .as_deref()
                    .is_some_and(|a| !matches!(a, "true" | "false"))
            {
                return Err(invalid("判断题答案必须为true/false"));
            }
            if self.mode == "generate"
                && q.answer.as_deref().is_none_or(|a| a.trim().is_empty())
                && !matches!(
                    q.question_type.as_str(),
                    "matching" | "ordering" | "numeric"
                )
            {
                return Err(invalid("新命题缺少答案"));
            }
            if let Some(smiles) = &q.smiles {
                crate::qbank_generation::types::validate_smiles(smiles).map_err(|e| invalid(&e))?;
            }
            validate_structured(q)?;
        }
        Ok(())
    }
    pub fn needs_review(&self) -> bool {
        !self.issues.is_empty()
            || !self.unmatched_answers.is_empty()
            || self.coverage.iter().any(|c| c["status"] != "processed")
    }
}
fn validate_refs(refs: &[SourceRef]) -> Result<(), AppError> {
    for r in refs {
        if r.source_id.is_empty()
            || r.page == Some(0)
            || r.bbox.is_some_and(|b| {
                b.iter().any(|n| !n.is_finite() || !(0.0..=1.0).contains(n))
                    || b[0] >= b[2]
                    || b[1] >= b[3]
            })
        {
            return Err(AppError::validation("来源定位或bbox无效"));
        }
    }
    Ok(())
}
fn validate_structured(q: &DraftQuestion) -> Result<(), AppError> {
    let data = q.structured_data.as_ref().unwrap_or(&Value::Null);
    let invalid =
        || AppError::validation(format!("{} 的 structured_data 不完整或无效", q.local_id));
    match q.question_type.as_str() {
        "numeric" => {
            if !data["answer_value"].as_f64().is_some_and(f64::is_finite)
                || data["tolerance"]
                    .as_f64()
                    .is_some_and(|t| !t.is_finite() || t < 0.0)
            {
                return Err(invalid());
            }
        }
        "ordering" => {
            let items = data["items"].as_array().ok_or_else(invalid)?;
            let order = data["correct_order"].as_array().ok_or_else(invalid)?;
            let keys: HashSet<_> = items.iter().filter_map(|i| i["key"].as_str()).collect();
            let chosen: HashSet<_> = order.iter().filter_map(Value::as_str).collect();
            if keys.len() != items.len()
                || chosen.len() != order.len()
                || keys != chosen
                || keys.len() < 2
            {
                return Err(invalid());
            }
        }
        "matching" => {
            let left = data["left"].as_array().ok_or_else(invalid)?;
            let right = data["right"].as_array().ok_or_else(invalid)?;
            let pairs = data["pairs"].as_array().ok_or_else(invalid)?;
            let l: HashSet<_> = left.iter().filter_map(|i| i["key"].as_str()).collect();
            let r: HashSet<_> = right.iter().filter_map(|i| i["key"].as_str()).collect();
            if l.len() != left.len()
                || r.len() != right.len()
                || pairs.len() != left.len()
                || pairs.iter().any(|p| {
                    p["left"].as_str().is_none_or(|k| !l.contains(k))
                        || p["right"].as_str().is_none_or(|k| !r.contains(k))
                })
            {
                return Err(invalid());
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn document() -> QuestionDocument {
        serde_json::from_value(json!({"schema_version":2,"mode":"extract","questions":[{"local_id":"q1","content":"question","question_type":"short_answer"}]})).unwrap()
    }
    #[test]
    fn ordinary_legacy_question_remains_valid_without_invented_answer() {
        assert!(document().validate().is_ok());
    }
    #[test]
    fn duplicate_ids_and_dangling_members_are_rejected() {
        let mut d = document();
        d.questions.push(d.questions[0].clone());
        assert!(d.validate().is_err());
        let mut d = document();
        d.questions[0].group_id = Some("missing".into());
        assert!(d.validate().is_err());
    }
    #[test]
    fn serialized_backup_retains_historical_answer_origin() {
        let mut d = document();
        d.questions[0].answer_origin = Some("generated".into());
        assert!(d.validate().is_ok());
    }
}
