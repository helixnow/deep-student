//! HPIAS 研究服务 — 后端 pipeline 入口（Round 22）
//!
//! `StubHpiasResearchService` 委托 `HpiasPipelineOrchestrator`；
//! 未来真实 HPIAS 后端实现同一 trait，保留 `HpiasEventEmitter` emit 协议。

use serde_json::Value;
use tauri::Window;

use super::orchestrator::HpiasPipelineOrchestrator;
use super::payloads::intent_has_research_blocks;

/// HPIAS 后端实现种类（Round 23：环境变量 `DEEP_STUDENT_HPIAS_BACKEND` 选择）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HpiasBackendKind {
    /// Style Lab 时间线 stub（默认）
    Stub,
    // Retrieval — 未来：VFS unified_retriever 驱动真实检索 pipeline
}

impl HpiasBackendKind {
    pub fn from_env() -> Self {
        match std::env::var("DEEP_STUDENT_HPIAS_BACKEND")
            .unwrap_or_else(|_| "stub".to_string())
            .to_ascii_lowercase()
            .as_str()
        {
            "stub" | "" => Self::Stub,
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

/// HPIAS 研究 pipeline 后端（stub 与真实实现共用接口）
pub trait HpiasResearchBackend: Send + Sync {
    /// 绑定 Chat researchSessionId 后启动研究 pipeline
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

/// 默认后端工厂（`DEEP_STUDENT_HPIAS_BACKEND=stub` 为默认）
pub fn create_research_backend(window: Window) -> StubHpiasResearchService {
    let kind = HpiasBackendKind::from_env();
    match kind {
        HpiasBackendKind::Stub => StubHpiasResearchService::new(window),
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
}
