//! HPIAS 研究服务 — 后端 pipeline 入口（Round 22–24）
//!
//! `StubHpiasResearchService` — 仅供 Style Lab / 显式测试启用的时间线 stub
//! `RetrievalHpiasResearchService` — VFS UnifiedRetriever 真实检索（`DEEP_STUDENT_HPIAS_BACKEND=retrieval`）

use serde_json::Value;
use tauri::Window;

use super::orchestrator::HpiasPipelineOrchestrator;
use super::payloads::intent_has_research_blocks;
use super::retrieval_backend::{HpiasResearchDeps, RetrievalHpiasResearchService};

/// HPIAS 后端实现种类（环境变量 `DEEP_STUDENT_HPIAS_BACKEND`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HpiasBackendKind {
    /// Chat 默认禁用动态 pipeline，研究块只渲染 intent 中的静态内容
    Disabled,
    /// Style Lab / 测试时间线 stub（仅显式配置 `stub` 时启用）
    Stub,
    /// VFS UnifiedRetriever 驱动检索 + LLM synthesis（失败回退确定性拼接）
    Retrieval,
}

impl HpiasBackendKind {
    pub fn from_env() -> Self {
        let configured = std::env::var("DEEP_STUDENT_HPIAS_BACKEND").ok();
        Self::from_config(configured.as_deref())
    }

    fn from_config(configured: Option<&str>) -> Self {
        match configured
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "disabled" | "off" => Self::Disabled,
            "stub" => Self::Stub,
            "retrieval" => Self::Retrieval,
            other => {
                log::warn!(
                    "[HpiasResearchService] Unknown DEEP_STUDENT_HPIAS_BACKEND={:?}; pipeline disabled",
                    other
                );
                Self::Disabled
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

/// 后端工厂：默认不启动 pipeline；显式 retrieval 依赖不可用时也 fail closed。
pub fn create_research_backend(
    window: Window,
    deps: HpiasResearchDeps,
) -> Option<Box<dyn HpiasResearchBackend>> {
    match HpiasBackendKind::from_env() {
        HpiasBackendKind::Disabled => None,
        HpiasBackendKind::Stub => Some(Box::new(StubHpiasResearchService::new(window))),
        HpiasBackendKind::Retrieval => {
            if deps.can_run_retrieval() {
                Some(Box::new(RetrievalHpiasResearchService::new(window, deps)))
            } else {
                log::warn!(
                    "[HpiasResearchService] retrieval backend requested but VFS/LLM unavailable; pipeline disabled"
                );
                None
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
    fn backend_kind_defaults_to_disabled() {
        assert_eq!(
            HpiasBackendKind::from_config(None),
            HpiasBackendKind::Disabled
        );
        assert_eq!(
            HpiasBackendKind::from_config(Some("")),
            HpiasBackendKind::Disabled
        );
    }

    #[test]
    fn backend_kind_reads_env_stub() {
        assert_eq!(
            HpiasBackendKind::from_config(Some("stub")),
            HpiasBackendKind::Stub
        );
    }

    #[test]
    fn backend_kind_reads_env_retrieval() {
        assert_eq!(
            HpiasBackendKind::from_config(Some("retrieval")),
            HpiasBackendKind::Retrieval
        );
    }

    #[test]
    fn backend_kind_unknown_value_fails_closed() {
        assert_eq!(
            HpiasBackendKind::from_config(Some("unexpected")),
            HpiasBackendKind::Disabled
        );
    }
}
