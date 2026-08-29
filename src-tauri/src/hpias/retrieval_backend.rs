//! HPIAS retrieval 后端 — VFS UnifiedRetriever 驱动真实检索 pipeline（Round 24）
//!
//! `DEEP_STUDENT_HPIAS_BACKEND=retrieval` 且 ExecutionContext 注入 VFS/LLM 时启用；
//! 依赖不可用时 fail closed。Round 25：synthesis 优先 LLM 综合，失败回退确定性拼接。

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Window;

use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::retrieval_planner::{FusedRetrievalHit, QueryModality};
use crate::vfs::{UnifiedRetrievalRequest, VfsUnifiedRetriever};

use super::events::HpiasEventEmitter;
use super::payloads::{
    build_plan_generated_payload, build_retrieval_completed_payload, build_round_started_payload,
    build_selection_completed_payload, build_session_completed_payload,
    build_subagent_completed_payload, build_subagent_started_payload, build_subagents_done_payload,
    build_synthesis_updated_payload, extract_plan_queries_from_intent, intent_has_research_blocks,
};
use super::service::{HpiasResearchBackend, HpiasResearchSessionRequest};
use super::synthesis::generate_synthesis_with_llm;

const DEFAULT_TOP_K: usize = 8;
const SUBAGENT_INTERVAL_MS: u64 = 120;

/// generative_ui executor 注入的 VFS/LLM 依赖
#[derive(Clone, Default)]
pub struct HpiasResearchDeps {
    pub vfs_db: Option<Arc<VfsDatabase>>,
    pub vfs_lance_store: Option<Arc<VfsLanceStore>>,
    pub llm_manager: Option<Arc<LLMManager>>,
}

impl HpiasResearchDeps {
    pub fn can_run_retrieval(&self) -> bool {
        self.vfs_db.is_some() && self.llm_manager.is_some()
    }
}

/// VFS 检索驱动的 HPIAS pipeline
pub struct RetrievalHpiasResearchService {
    window: Window,
    deps: HpiasResearchDeps,
}

impl RetrievalHpiasResearchService {
    pub fn new(window: Window, deps: HpiasResearchDeps) -> Self {
        Self { window, deps }
    }

    fn resolve_queries(question: Option<&str>, intent: &Value) -> Vec<String> {
        let from_intent = extract_plan_queries_from_intent(intent);
        if !from_intent.is_empty() {
            return from_intent;
        }
        question
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|q| vec![q.to_string()])
            .unwrap_or_else(|| vec!["research query".to_string()])
    }

    async fn run_pipeline(
        emitter: HpiasEventEmitter,
        deps: HpiasResearchDeps,
        session_id: String,
        question: Option<String>,
        intent: Value,
    ) {
        let round = 1_i64;
        let queries = Self::resolve_queries(question.as_deref(), &intent);
        let plan = json!({ "core": { "queries": queries.clone() } });

        let _ = emitter.emit_raw(build_round_started_payload(&session_id, round));
        tokio::time::sleep(Duration::from_millis(SUBAGENT_INTERVAL_MS)).await;
        let _ = emitter.emit_raw(build_plan_generated_payload(&session_id, round, plan));

        let db = match deps.vfs_db.clone() {
            Some(db) => db,
            None => {
                log::warn!("[HpiasRetrieval] vfs_db missing mid-pipeline");
                return;
            }
        };
        let llm = match deps.llm_manager.clone() {
            Some(llm) => llm,
            None => return,
        };
        let lance = match RetrievalHpiasResearchService::lance_store_from_deps(&deps) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[HpiasRetrieval] Lance store error: {}", e);
                return;
            }
        };

        let llm_for_synthesis = Arc::clone(&llm);
        let retriever = VfsUnifiedRetriever::new(db, lance, llm);
        let mut all_hits: Vec<FusedRetrievalHit> = Vec::new();
        let mut per_query: Vec<(String, Vec<FusedRetrievalHit>)> = Vec::new();

        for (index, query) in queries.iter().enumerate() {
            let sub_id = (index + 1) as i64;
            let _ = emitter.emit_raw(build_subagent_started_payload(
                &session_id,
                round,
                sub_id,
                query,
            ));

            let mut query_hits = Vec::new();
            let request = UnifiedRetrievalRequest {
                query_text: Some(query.clone()),
                query_image_base64: None,
                query_image_media_type: None,
                query_modality: QueryModality::Text,
                top_k: DEFAULT_TOP_K,
                folder_ids: None,
                resource_ids: None,
                resource_types: None,
            };

            match retriever.search(request).await {
                Ok(response) => {
                    query_hits = response.result.hits;
                    all_hits.extend(query_hits.clone());
                }
                Err(error) => {
                    log::warn!(
                        "[HpiasRetrieval] search failed for query {:?}: {}",
                        query,
                        error
                    );
                }
            }

            let summary = summarize_hits_for_subagent(&query_hits);
            let citations: Value = json!(query_hits
                .iter()
                .take(3)
                .enumerate()
                .map(|(i, h)| {
                    json!([
                        h.hit
                            .source_id
                            .clone()
                            .unwrap_or_else(|| format!("hit-{}", i + 1)),
                        1
                    ])
                })
                .collect::<Vec<_>>());

            let _ = emitter.emit_raw(build_subagent_completed_payload(
                &session_id,
                round,
                sub_id,
                2,
                &summary,
                citations,
            ));
            per_query.push((query.clone(), query_hits));
            tokio::time::sleep(Duration::from_millis(SUBAGENT_INTERVAL_MS)).await;
        }

        let fetched = all_hits.len() as i64;
        let selected = all_hits.len().min(queries.len() * 3) as i64;
        let _ = emitter.emit_raw(build_retrieval_completed_payload(
            &session_id,
            round,
            fetched,
        ));
        let _ = emitter.emit_raw(build_selection_completed_payload(
            &session_id,
            round,
            selected,
            Some(json!({ "items": [] })),
        ));

        let synthesis =
            generate_synthesis_with_llm(&llm_for_synthesis, question.as_deref(), &per_query).await;
        let _ = emitter.emit_raw(build_synthesis_updated_payload(
            &session_id,
            round,
            &synthesis,
        ));
        let _ = emitter.emit_raw(build_subagents_done_payload(
            &session_id,
            round,
            json!({ "completed": queries.len() }),
            json!([]),
        ));
        let _ = emitter.emit_raw(build_session_completed_payload(&session_id, round));
    }

    fn lance_store_from_deps(deps: &HpiasResearchDeps) -> Result<Arc<VfsLanceStore>, String> {
        if let Some(store) = &deps.vfs_lance_store {
            return Ok(Arc::clone(store));
        }
        let db = deps
            .vfs_db
            .as_ref()
            .ok_or_else(|| "VFS database not available".to_string())?;
        VfsLanceStore::new(Arc::clone(db))
            .map(Arc::new)
            .map_err(|e| format!("Failed to create Lance store: {}", e))
    }
}

impl HpiasResearchBackend for RetrievalHpiasResearchService {
    fn start_research_session(&self, request: HpiasResearchSessionRequest<'_>) {
        if !intent_has_research_blocks(request.intent) {
            return;
        }

        let emitter = HpiasEventEmitter::new(self.window.clone());
        let session_id = request.session_id.to_string();
        let question = request.question.map(str::to_string);
        let intent = request.intent.clone();
        let deps = self.deps.clone();

        tauri::async_runtime::spawn(async move {
            Self::run_pipeline(emitter, deps, session_id, question, intent).await;
        });
    }
}

/// 子代理摘要 — 取 top hit 标题/片段
pub fn summarize_hits_for_subagent(hits: &[FusedRetrievalHit]) -> String {
    let Some(top) = hits.first() else {
        return "未检索到相关内容。".to_string();
    };
    let title = top
        .hit
        .title
        .as_deref()
        .filter(|t| !t.is_empty())
        .unwrap_or("检索结果");
    let snippet: String = top.hit.text.chars().take(240).collect();
    if snippet.is_empty() {
        format!("{}（无文本片段）", title)
    } else {
        format!("{}：{}…", title, snippet)
    }
}

/// 确定性 synthesis — 拼接各 query 的 top 片段（非 LLM）
pub fn build_synthesis_markdown(
    question: Option<&str>,
    per_query: &[(String, Vec<FusedRetrievalHit>)],
) -> String {
    let heading = question.filter(|q| !q.is_empty()).unwrap_or("研究主题");
    let mut md = format!("## 综合结论\n\n关于 **{}** 的检索摘要：\n\n", heading);

    for (query, hits) in per_query {
        md.push_str(&format!("### {}\n\n", query));
        if hits.is_empty() {
            md.push_str("_未找到相关内容_\n\n");
            continue;
        }
        for (i, hit) in hits.iter().take(3).enumerate() {
            let title = hit.hit.title.as_deref().unwrap_or("来源");
            let snippet: String = hit.hit.text.chars().take(320).collect();
            md.push_str(&format!("{}. **{}** — {}…\n\n", i + 1, title, snippet));
        }
    }
    md
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_hits_empty_returns_placeholder() {
        assert_eq!(summarize_hits_for_subagent(&[]), "未检索到相关内容。");
    }

    #[test]
    fn build_synthesis_includes_question_heading() {
        let md = build_synthesis_markdown(Some("AI in medicine"), &[]);
        assert!(md.contains("AI in medicine"));
        assert!(md.contains("综合结论"));
    }

    #[test]
    fn deps_can_run_retrieval_requires_vfs_and_llm() {
        let empty = HpiasResearchDeps::default();
        assert!(!empty.can_run_retrieval());
    }
}
