//! HPIAS 事件 payload 构建器 — 与前端 `HpiasEvent` 联合类型对齐
//!
//! 纯函数便于单测；orchestrator 与 `HpiasEventEmitter` 共用。

use std::collections::HashSet;

use serde_json::{json, Value};

const RESEARCH_BLOCK_TYPES: [&str; 3] = ["research-plan", "research-report", "paper-digest"];
const MAX_RESEARCH_PLAN_QUERIES: usize = 12;

/// intent 是否含 Research 类块（与前端 `intentHasResearchBlocks` 对齐）
pub fn intent_has_research_blocks(intent: &Value) -> bool {
    intent
        .get("blocks")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks.iter().any(|block| {
                block
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|t| RESEARCH_BLOCK_TYPES.contains(&t))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// 从 intent 提取研究问题（meta.title 或 research-plan props.title）
pub fn extract_question_from_intent(intent: &Value) -> Option<String> {
    intent
        .get("meta")
        .and_then(|m| m.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            intent
                .get("blocks")
                .and_then(Value::as_array)
                .and_then(|blocks| {
                    blocks.iter().find_map(|block| {
                        if block.get("type").and_then(Value::as_str) != Some("research-plan") {
                            return None;
                        }
                        block
                            .get("props")
                            .and_then(|p| p.get("title"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    })
                })
        })
}

/// 从 research-plan 块 steps 提取 subagent 查询词
pub fn extract_plan_queries_from_intent(intent: &Value) -> Vec<String> {
    let Some(blocks) = intent.get("blocks").and_then(Value::as_array) else {
        return Vec::new();
    };

    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("research-plan") {
            continue;
        }
        let Some(steps) = block
            .get("props")
            .and_then(|p| p.get("steps"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        let mut seen = HashSet::new();
        let queries: Vec<String> = steps
            .iter()
            .filter_map(|step| step.get("label").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .filter(|query| seen.insert(query.clone()))
            .take(MAX_RESEARCH_PLAN_QUERIES)
            .collect();
        if !queries.is_empty() {
            return queries;
        }
    }
    Vec::new()
}

/// 从 research-report 块提取 synthesis 正文
pub fn extract_synthesis_from_intent(intent: &Value) -> Option<String> {
    intent
        .get("blocks")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks.iter().find_map(|block| {
                if block.get("type").and_then(Value::as_str) != Some("research-report") {
                    return None;
                }
                block
                    .get("props")
                    .and_then(|p| p.get("body"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
        })
}

pub fn build_session_started_payload(
    session_id: &str,
    question: Option<&str>,
    options_json: Option<&str>,
) -> Value {
    let mut payload = json!({
        "type": "session_started",
        "session_id": session_id,
    });
    if let Some(q) = question.map(str::trim).filter(|s| !s.is_empty()) {
        payload["question"] = json!(q);
    }
    if let Some(opts) = options_json.map(str::trim).filter(|s| !s.is_empty()) {
        payload["options_json"] = json!(opts);
    }
    payload
}

pub fn build_round_started_payload(session_id: &str, round: i64) -> Value {
    json!({
        "type": "round_started",
        "session_id": session_id,
        "round": round,
    })
}

pub fn build_plan_generated_payload(session_id: &str, round: i64, plan: Value) -> Value {
    json!({
        "type": "plan_generated",
        "session_id": session_id,
        "round": round,
        "plan": plan,
    })
}

pub fn build_retrieval_completed_payload(session_id: &str, round: i64, fetched: i64) -> Value {
    json!({
        "type": "retrieval_completed",
        "session_id": session_id,
        "round": round,
        "fetched": fetched,
    })
}

pub fn build_selection_completed_payload(
    session_id: &str,
    round: i64,
    selected: i64,
    citations: Option<Value>,
) -> Value {
    let mut payload = json!({
        "type": "selection_completed",
        "session_id": session_id,
        "round": round,
        "selected": selected,
    });
    if let Some(c) = citations {
        payload["citations"] = c;
    }
    payload
}

pub fn build_subagent_started_payload(
    session_id: &str,
    round: i64,
    sub_id: i64,
    query: &str,
) -> Value {
    json!({
        "type": "subagent_started",
        "session_id": session_id,
        "round": round,
        "sub_id": sub_id,
        "query": query,
    })
}

pub fn build_subagent_completed_payload(
    session_id: &str,
    round: i64,
    sub_id: i64,
    steps: i64,
    summary_md: &str,
    citations: Value,
) -> Value {
    json!({
        "type": "subagent_completed",
        "session_id": session_id,
        "round": round,
        "sub_id": sub_id,
        "steps": steps,
        "summary_md": summary_md,
        "citations": citations,
    })
}

pub fn build_synthesis_updated_payload(session_id: &str, round: i64, synthesis: &str) -> Value {
    json!({
        "type": "synthesis_updated",
        "session_id": session_id,
        "round": round,
        "synthesis": synthesis,
    })
}

pub fn build_subagents_done_payload(
    session_id: &str,
    round: i64,
    metrics: Value,
    sub_reports: Value,
) -> Value {
    json!({
        "type": "subagents_done",
        "session_id": session_id,
        "round": round,
        "metrics": metrics,
        "sub_reports": sub_reports,
    })
}

pub fn build_session_completed_payload(session_id: &str, round: i64) -> Value {
    json!({
        "type": "session_completed",
        "session_id": session_id,
        "round": round,
    })
}

/// 构建完整 pipeline 事件序列（对齐 Style Lab `buildStyleLabHpiasDemoTimeline`）
pub fn build_pipeline_timeline(
    session_id: &str,
    question: Option<&str>,
    intent: Option<&Value>,
) -> Vec<Value> {
    let round = 1_i64;
    let queries = intent
        .map(extract_plan_queries_from_intent)
        .filter(|q| !q.is_empty())
        .unwrap_or_else(|| {
            vec![
                "2024-2026 医学影像深度学习综述".to_string(),
                "FDA 批准的 AI 影像诊断产品".to_string(),
            ]
        });

    let synthesis = intent
        .and_then(extract_synthesis_from_intent)
        .unwrap_or_else(|| {
            "## 综合结论\n\n深度学习在医学影像领域持续向 **多模态融合** 与 **可解释性** 演进 [review-1]。"
                .to_string()
        });

    let plan = json!({
        "core": {
            "queries": queries.clone(),
        }
    });

    let fetched = (queries.len() as i64 * 21).max(12);
    let selected = (queries.len() as i64 * 6).max(6);

    let mut timeline = vec![
        build_session_started_payload(
            session_id,
            question,
            Some(r#"{"execution_mode":"autonomous"}"#),
        ),
        build_round_started_payload(session_id, round),
        build_plan_generated_payload(session_id, round, plan),
        build_retrieval_completed_payload(session_id, round, fetched),
        build_selection_completed_payload(
            session_id,
            round,
            selected,
            Some(json!({ "items": [] })),
        ),
    ];

    for (index, query) in queries.iter().enumerate() {
        let sub_id = (index + 1) as i64;
        timeline.push(build_subagent_started_payload(
            session_id, round, sub_id, query,
        ));

        if index == 0 {
            timeline.push(build_synthesis_updated_payload(
                session_id, round, &synthesis,
            ));
        }

        timeline.push(build_subagent_completed_payload(
            session_id,
            round,
            sub_id,
            3,
            &format!("子代理 {} 已完成检索与摘要。", sub_id),
            json!([[format!("paper-{}", sub_id), sub_id]]),
        ));
    }

    timeline.push(build_subagents_done_payload(
        session_id,
        round,
        json!({ "completed": queries.len() }),
        json!([]),
    ));
    timeline.push(build_session_completed_payload(session_id, round));

    timeline
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn intent_has_research_blocks_detects_research_plan() {
        let intent = json!({
            "blocks": [{ "type": "research-plan", "props": { "steps": [] } }]
        });
        assert!(intent_has_research_blocks(&intent));
    }

    #[test]
    fn intent_has_research_blocks_rejects_text_only() {
        let intent = json!({
            "blocks": [{ "type": "text", "props": { "text": "hi" } }]
        });
        assert!(!intent_has_research_blocks(&intent));
    }

    #[test]
    fn extract_plan_queries_from_research_plan_steps() {
        let intent = json!({
            "blocks": [{
                "type": "research-plan",
                "props": {
                    "steps": [
                        { "label": "Query A" },
                        { "label": "Query B" }
                    ]
                }
            }]
        });
        assert_eq!(
            extract_plan_queries_from_intent(&intent),
            vec!["Query A", "Query B"]
        );
    }

    #[test]
    fn extract_plan_queries_deduplicates_and_caps_at_frontend_limit() {
        let steps: Vec<Value> = std::iter::once(json!({ "label": "Query 0" }))
            .chain(std::iter::once(json!({ "label": "Query 0" })))
            .chain((1..20).map(|index| json!({ "label": format!("Query {}", index) })))
            .collect();
        let intent = json!({
            "blocks": [{
                "type": "research-plan",
                "props": { "steps": steps }
            }]
        });

        let queries = extract_plan_queries_from_intent(&intent);
        assert_eq!(queries.len(), MAX_RESEARCH_PLAN_QUERIES);
        assert_eq!(queries.first().map(String::as_str), Some("Query 0"));
        assert_eq!(queries.last().map(String::as_str), Some("Query 11"));
    }

    #[test]
    fn build_pipeline_timeline_includes_lifecycle_events() {
        let timeline = build_pipeline_timeline("s1", Some("Q?"), None);
        let types: Vec<&str> = timeline
            .iter()
            .filter_map(|e| e.get("type").and_then(Value::as_str))
            .collect();
        assert!(types.contains(&"session_started"));
        assert!(types.contains(&"plan_generated"));
        assert!(types.contains(&"retrieval_completed"));
        assert!(types.contains(&"synthesis_updated"));
        assert!(types.contains(&"session_completed"));
    }

    #[test]
    fn build_pipeline_timeline_uses_intent_synthesis() {
        let intent = json!({
            "blocks": [{
                "type": "research-report",
                "props": { "body": "Custom synthesis body" }
            }]
        });
        let timeline = build_pipeline_timeline("s1", None, Some(&intent));
        let synthesis = timeline
            .iter()
            .find(|e| e.get("type") == Some(&json!("synthesis_updated")))
            .expect("synthesis event");
        assert_eq!(
            synthesis.get("synthesis").and_then(Value::as_str),
            Some("Custom synthesis body")
        );
    }

    #[test]
    fn build_pipeline_timeline_formats_stub_citation_ids() {
        let intent = json!({
            "blocks": [{
                "type": "research-plan",
                "props": { "steps": [{ "label": "Query A" }] }
            }]
        });
        let timeline = build_pipeline_timeline("s1", None, Some(&intent));
        let completed = timeline
            .iter()
            .find(|event| event.get("type") == Some(&json!("subagent_completed")))
            .expect("subagent_completed event");

        assert_eq!(completed["citations"], json!([["paper-1", 1]]));
        assert!(!completed.to_string().contains("paper-{}"));
    }

    #[test]
    fn build_pipeline_timeline_covers_required_lifecycle() {
        let timeline = build_pipeline_timeline("s1", Some("Q"), None);
        let types: Vec<&str> = timeline
            .iter()
            .filter_map(|e| e.get("type").and_then(Value::as_str))
            .collect();
        for required in [
            "session_started",
            "round_started",
            "plan_generated",
            "retrieval_completed",
            "selection_completed",
            "subagent_started",
            "subagent_completed",
            "synthesis_updated",
            "subagents_done",
            "session_completed",
        ] {
            assert!(
                types.contains(&required),
                "missing lifecycle event: {}",
                required
            );
        }
    }
}
