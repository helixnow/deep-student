//! HPIAS（深度研究）Tauri 事件发射 — 与前端 `hpiasEventBridge` 对齐
//!
//! 通道名：`hpias_event`（见 `docs/generative-ui/ARCHITECTURE.md`）

use serde_json::Value;
use tauri::{Emitter, Window};

use super::payloads::build_session_started_payload;

/// 前端 `hpiasEventBridge` 订阅的 Tauri 事件通道
pub const HPIAS_EVENT_CHANNEL: &str = "hpias_event";

/// HPIAS 事件发射器（类比 `translation::events::TranslationEventEmitter`）
pub struct HpiasEventEmitter {
    window: Window,
}

impl HpiasEventEmitter {
    pub fn new(window: Window) -> Self {
        Self { window }
    }

    /// 发射任意 HpiasEvent JSON payload
    pub fn emit_raw(&self, payload: Value) -> Result<(), String> {
        self.window
            .emit(HPIAS_EVENT_CHANNEL, payload)
            .map_err(|e| e.to_string())
    }

    /// 构建 `session_started` 事件 payload（委托 payloads 模块）
    pub fn build_session_started_payload(session_id: &str, question: Option<&str>) -> Value {
        build_session_started_payload(session_id, question, None)
    }

    /// 通知前端 HPIAS 会话已绑定（Chat `researchSessionId` 联用时）
    pub fn emit_session_started(
        &self,
        session_id: &str,
        question: Option<&str>,
    ) -> Result<(), String> {
        self.emit_raw(Self::build_session_started_payload(session_id, question))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_matches_frontend_contract() {
        assert_eq!(HPIAS_EVENT_CHANNEL, "hpias_event");
    }

    #[test]
    fn build_session_started_payload_includes_question_when_present() {
        let payload =
            HpiasEventEmitter::build_session_started_payload("research-chat-1", Some("What is X?"));
        assert_eq!(payload["type"], "session_started");
        assert_eq!(payload["session_id"], "research-chat-1");
        assert_eq!(payload["question"], "What is X?");
    }

    #[test]
    fn build_session_started_payload_omits_blank_question() {
        let payload = HpiasEventEmitter::build_session_started_payload("s1", Some("   "));
        assert!(payload.get("question").is_none());
    }
}
