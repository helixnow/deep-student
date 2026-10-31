//! HPIAS pipeline orchestrator — 异步 emit 研究生命周期事件
//!
//! Round 21：在 `render_generative_ui` 绑定 `researchSessionId` 且 intent 含 Research 块时，
//! 于后台按 Style Lab 时间线推送 plan → retrieval → subagents → synthesis → completed。
//! 未来真实 HPIAS 后端可替换此 stub，保留 `HpiasEventEmitter` + payload 构建器。

use std::time::Duration;

use serde_json::Value;
use tauri::Window;

use super::events::HpiasEventEmitter;
use super::payloads::{build_pipeline_timeline, intent_has_research_blocks};

/// 默认事件间隔（与 Style Lab demo 350ms 接近）
pub const DEFAULT_PIPELINE_INTERVAL_MS: u64 = 350;

/// HPIAS pipeline 编排器
pub struct HpiasPipelineOrchestrator {
    emitter: HpiasEventEmitter,
}

impl HpiasPipelineOrchestrator {
    pub fn new(window: Window) -> Self {
        Self {
            emitter: HpiasEventEmitter::new(window),
        }
    }

    /// 按序 emit 时间线；`skip_first` 为 true 时跳过首条（已由 executor 发过的 session_started）
    pub async fn run_timeline(&self, timeline: &[Value], interval: Duration, skip_first: bool) {
        for (index, payload) in timeline.iter().enumerate() {
            if skip_first && index == 0 {
                continue;
            }
            if index > 0 || !skip_first {
                tokio::time::sleep(interval).await;
            }
            if let Err(error) = self.emitter.emit_raw(payload.clone()) {
                log::warn!(
                    "[HpiasPipelineOrchestrator] emit failed at index {}: {}",
                    index,
                    error
                );
                break;
            }
        }
    }

    /// 从 intent 构建时间线并在后台 spawn（无 window 时 no-op）
    pub fn spawn_from_intent(
        window: Window,
        session_id: &str,
        question: Option<&str>,
        intent: &Value,
    ) {
        if !intent_has_research_blocks(intent) {
            return;
        }

        let session_id = session_id.to_string();
        let question = question.map(str::to_string);
        let intent = intent.clone();

        tauri::async_runtime::spawn(async move {
            let timeline = build_pipeline_timeline(&session_id, question.as_deref(), Some(&intent));
            let orchestrator = HpiasPipelineOrchestrator::new(window);
            orchestrator
                .run_timeline(
                    &timeline,
                    Duration::from_millis(DEFAULT_PIPELINE_INTERVAL_MS),
                    true,
                )
                .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spawn_from_intent_skips_non_research_intent() {
        let intent = json!({
            "blocks": [{ "type": "text", "props": { "text": "hi" } }]
        });
        assert!(!intent_has_research_blocks(&intent));
    }

    #[test]
    fn pipeline_timeline_length_matches_style_lab_demo() {
        let timeline = build_pipeline_timeline("demo", Some("Q"), None);
        // session_started + round + plan + retrieval + selection + 2*(start+complete) + synthesis + subagents_done + completed
        assert!(timeline.len() >= 10);
    }
}
