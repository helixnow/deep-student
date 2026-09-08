/// 题目集 AI 出题事件发射器
use tauri::{Emitter, Window};

use super::types::{
    GeneratedQuestionDraft, QbankGenerationStreamCancelled, QbankGenerationStreamComplete,
    QbankGenerationStreamData, QbankGenerationStreamError,
};

/// 出题事件发射器
pub struct QbankGenerationEmitter {
    window: Window,
}

impl QbankGenerationEmitter {
    pub fn new(window: Window) -> Self {
        Self { window }
    }

    /// 发送增量数据事件
    pub fn emit_data(&self, stream_session_id: &str, chunk: String, accumulated: String) {
        let event_name = format!("qbank_generation_stream_{}", stream_session_id);
        let payload = QbankGenerationStreamData {
            event_type: "data".to_string(),
            chunk,
            accumulated,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            log::error!("[QbankGeneration] 发送数据事件失败: {}", e);
        }
    }

    /// 发送完成事件
    pub fn emit_complete(
        &self,
        stream_session_id: &str,
        exam_id: String,
        drafts: Vec<GeneratedQuestionDraft>,
        rejected_count: usize,
        rejection_reasons: Vec<String>,
    ) {
        let event_name = format!("qbank_generation_stream_{}", stream_session_id);
        let payload = QbankGenerationStreamComplete {
            event_type: "complete".to_string(),
            exam_id,
            drafts,
            rejected_count,
            rejection_reasons,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            log::error!("[QbankGeneration] 发送完成事件失败: {}", e);
        }
    }

    /// 发送错误事件
    pub fn emit_error(&self, stream_session_id: &str, message: String) {
        let event_name = format!("qbank_generation_stream_{}", stream_session_id);
        let payload = QbankGenerationStreamError {
            event_type: "error".to_string(),
            message,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            log::error!("[QbankGeneration] 发送错误事件失败: {}", e);
        }
    }

    /// 发送取消事件
    pub fn emit_cancelled(&self, stream_session_id: &str) {
        let event_name = format!("qbank_generation_stream_{}", stream_session_id);
        let payload = QbankGenerationStreamCancelled {
            event_type: "cancelled".to_string(),
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            log::error!("[QbankGeneration] 发送取消事件失败: {}", e);
        }
    }
}
