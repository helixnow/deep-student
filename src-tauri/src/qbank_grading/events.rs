/// 题目集 AI 评判事件发射器
use tauri::{Emitter, Window};

use super::types::{
    QbankGradingStreamCancelled, QbankGradingStreamComplete, QbankGradingStreamData,
    QbankGradingStreamError,
};

/// 评判事件发射器
pub struct QbankGradingEmitter {
    window: Window,
}

impl QbankGradingEmitter {
    pub fn new(window: Window) -> Self {
        Self { window }
    }

    /// 发送增量数据事件
    pub fn emit_data(&self, stream_session_id: &str, chunk: String, accumulated: String) {
        let event_name = format!("qbank_grading_stream_{}", stream_session_id);
        let payload = QbankGradingStreamData {
            event_type: "data".to_string(),
            chunk,
            accumulated,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            log::error!("[QbankGrading] 发送数据事件失败: {}", e);
        }
    }

    /// 发送完成事件
    pub fn emit_complete(
        &self,
        stream_session_id: &str,
        submission_id: String,
        verdict: Option<String>,
        score: Option<i32>,
        feedback: String,
    ) {
        let event_name = format!("qbank_grading_stream_{}", stream_session_id);
        let payload = QbankGradingStreamComplete {
            event_type: "complete".to_string(),
            submission_id,
            verdict,
            score,
            feedback,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            log::error!("[QbankGrading] 发送完成事件失败: {}", e);
        }
    }

    /// 发送错误事件
    pub fn emit_error(&self, stream_session_id: &str, message: String) {
        let event_name = format!("qbank_grading_stream_{}", stream_session_id);
        let payload = QbankGradingStreamError {
            event_type: "error".to_string(),
            message,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            log::error!("[QbankGrading] 发送错误事件失败: {}", e);
        }
    }

    /// 发送取消事件
    pub fn emit_cancelled(&self, stream_session_id: &str) {
        let event_name = format!("qbank_grading_stream_{}", stream_session_id);
        let payload = QbankGradingStreamCancelled {
            event_type: "cancelled".to_string(),
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            log::error!("[QbankGrading] 发送取消事件失败: {}", e);
        }
    }
}
