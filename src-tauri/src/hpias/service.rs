//! HPIAS 研究服务 — 后端 pipeline 入口（Round 22）
//!
//! `StubHpiasResearchService` 委托 `HpiasPipelineOrchestrator`；
//! 未来真实 HPIAS 后端实现同一 trait，保留 `HpiasEventEmitter` emit 协议。

use serde_json::Value;
use tauri::Window;

use super::orchestrator::HpiasPipelineOrchestrator;
use super::payloads::intent_has_research_blocks;

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

/// 默认后端工厂（当前返回 stub；真实 HPIAS 接入时切换实现）
pub fn create_research_backend(window: Window) -> StubHpiasResearchService {
    StubHpiasResearchService::new(window)
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
}
