//! HPIAS 研究服务 — 后端 pipeline 入口（Round 22–24）
//!
//! `StubHpiasResearchService` — Style Lab 时间线 stub（默认）
//! `RetrievalHpiasResearchService` — VFS UnifiedRetriever 真实检索（`DEEP_STUDENT_HPIAS_BACKEND=retrieval`）

use serde_json::Value;
use tauri::Window;

use super::orchestrator::HpiasPipelineOrchestrator;
use super::payloads::intent_has_research_blocks;
use super::retrieval_backend::{HpiasResearchDeps, RetrievalHpiasResearchService};

/// HPIAS 后端实现种类（环境变量 `DEEP_STUDENT_HPIAS_BACKEND`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HpiasBackendKind {
    /// Style Lab 时间线 stub（默认）
    Stub,
    /// VFS UnifiedRetriever 驱动检索 + LLM synthesis（失败回退确定性拼接）
    Retrieval,
}

impl HpiasBackendKind {
    pub fn from_env() -> Self {
        match std::env::var("DEEP_STUDENT_HPIAS_BACKEND")
            .unwrap_or_else(|_| "stub".to_string())
            .to_ascii_lowercase()
            .as_str()
        {
            "stub" | "" => Self::Stub,
            "retrieval" => Self::Retrieval,
            other => {
                log::warn!(
                    "[HpiasResearchService] Unknown DEEP_STUDENT_HPIAS_BACKEND={:?}, using stub",
                    other
                );
                Self::Stub
            }
        }
    }
}

/// HPIAS 研究会话启动参数
pub struct HpiasResearchSessionRequest<'a> {
    pub session_id: &'a str,
    pub question: Option<&'a str>,
    pub intent: &'a Value,
}

/// HPIAS 研究 pipeline 后端（stub 与 retrieval 共用接口）
pub trait HpiasResearchBackend: Send + Sync {
    fn start_research_session(&self, request: HpiasResearchSessionRequest<'_>);
}

/// Stub 实现 — 按 Style Lab 时间线 emit 生命周期事件
pub struct StubHpiasResearchService {
    window: Window,
}

impl StubHpiasResearchService {
    pub fn new(window: Window) -> Self {
        Self { window }
    }
}

impl HpiasResearchBackend for StubHpiasResearchService {
    fn start_research_session(&self, request: HpiasResearchSessionRequest<'_>) {
        if !intent_has_research_blocks(request.intent) {
            return;
        }
        HpiasPipelineOrchestrator::spawn_from_intent(
            self.window.clone(),
            request.session_id,
            request.question,
            request.intent,
        );
    }
}

/// 后端工厂：`retrieval` 模式在 VFS/LLM 不可用时自动回退 stub
pub fn create_research_backend(
    window: Window,
    deps: HpiasResearchDeps,
) -> Box<dyn HpiasResearchBackend> {
    match HpiasBackendKind::from_env() {
        HpiasBackendKind::Stub => Box::new(StubHpiasResearchService::new(window)),
        HpiasBackendKind::Retrieval => {
            if deps.can_run_retrieval() {
                Box::new(RetrievalHpiasResearchService::new(window, deps))
            } else {
                log::warn!(
                    "[HpiasResearchService] retrieval backend requested but VFS/LLM unavailable; using stub"
                );
                Box::new(StubHpiasResearchService::new(window))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_carries_session_and_intent() {
        let intent = json!({
            "blocks": [{ "type": "research-plan", "props": { "steps": [] } }]
        });
        let req = HpiasResearchSessionRequest {
            session_id: "s1",
            question: Some("Q?"),
            intent: &intent,
        };
        assert_eq!(req.session_id, "s1");
        assert!(intent_has_research_blocks(req.intent));
    }

    #[test]
    fn backend_kind_defaults_to_stub() {
        std::env::remove_var("DEEP_STUDENT_HPIAS_BACKEND");
        assert_eq!(HpiasBackendKind::from_env(), HpiasBackendKind::Stub);
    }

    #[test]
    fn backend_kind_reads_env_stub() {
        std::env::set_var("DEEP_STUDENT_HPIAS_BACKEND", "stub");
        assert_eq!(HpiasBackendKind::from_env(), HpiasBackendKind::Stub);
        std::env::remove_var("DEEP_STUDENT_HPIAS_BACKEND");
    }

    #[test]
    fn backend_kind_reads_env_retrieval() {
        std::env::set_var("DEEP_STUDENT_HPIAS_BACKEND", "retrieval");
        assert_eq!(HpiasBackendKind::from_env(), HpiasBackendKind::Retrieval);
        std::env::remove_var("DEEP_STUDENT_HPIAS_BACKEND");
    }
}
