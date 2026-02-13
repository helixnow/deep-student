/// 作文批改事件发射器 - 负责发送 SSE 事件到前端
use tauri::{Emitter, Window};

use super::types::{
    GradingStreamCancelled, GradingStreamComplete, GradingStreamData, GradingStreamError,
};

/// 批改事件发射器
pub struct GradingEventEmitter {
    window: Window,
}

impl GradingEventEmitter {
    /// 创建新的事件发射器
    pub fn new(window: Window) -> Self {
        Self { window }
    }

    /// 发送增量数据事件
    pub fn emit_data(&self, stream_session_id: &str, chunk: String, accumulated: String) {
        let event_name = format!("essay_grading_stream_{}", stream_session_id);

        let char_count = accumulated.chars().count();

        let payload = GradingStreamData {
            event_type: "data".to_string(),
            chunk,
            accumulated,
            char_count,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            eprintln!("❌ [EssayGrading] 发送数据事件失败: {}", e);
        }
    }

    /// 发送完成事件
    pub fn emit_complete(
        &self,
        stream_session_id: &str,
        round_id: String,
        grading_result: String,
        overall_score: Option<f32>,
        parsed_score: Option<String>,
        created_at: String,
    ) {
        let event_name = format!("essay_grading_stream_{}", stream_session_id);
        let payload = GradingStreamComplete {
            event_type: "complete".to_string(),
            round_id,
            grading_result,
            overall_score,
            parsed_score,
            created_at,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            eprintln!("❌ [EssayGrading] 发送完成事件失败: {}", e);
        }
    }

    /// 发送错误事件
    pub fn emit_error(&self, stream_session_id: &str, message: String) {
        let event_name = format!("essay_grading_stream_{}", stream_session_id);
        let payload = GradingStreamError {
            event_type: "error".to_string(),
            message,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            eprintln!("❌ [EssayGrading] 发送错误事件失败: {}", e);
        }
    }

    /// 发送取消事件
    pub fn emit_cancelled(&self, stream_session_id: &str) {
        let event_name = format!("essay_grading_stream_{}", stream_session_id);
        let payload = GradingStreamCancelled {
            event_type: "cancelled".to_string(),
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            eprintln!("❌ [EssayGrading] 发送取消事件失败: {}", e);
        }
    }
}
