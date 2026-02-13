/// 翻译事件发射器 - 负责发送 SSE 事件到前端
use tauri::{Emitter, Window};

use super::types::{
    TranslationStreamCancelled, TranslationStreamComplete, TranslationStreamData,
    TranslationStreamError,
};

/// 翻译事件发射器
pub struct TranslationEventEmitter {
    window: Window,
}

impl TranslationEventEmitter {
    /// 创建新的事件发射器
    pub fn new(window: Window) -> Self {
        Self { window }
    }

    /// 发送增量数据事件
    ///
    /// # 参数
    /// - `session_id`: 会话 ID（用于事件作用域）
    /// - `chunk`: 本次增量内容
    /// - `accumulated`: 累积内容
    pub fn emit_data(&self, session_id: &str, chunk: String, accumulated: String) {
        let event_name = format!("translation_stream_{}", session_id);

        // 计算字符数和单词数
        let char_count = accumulated.chars().count();
        let word_count = accumulated
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .count();

        let payload = TranslationStreamData {
            event_type: "data".to_string(),
            chunk,
            accumulated,
            char_count,
            word_count,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            eprintln!("❌ [Translation] 发送数据事件失败: {}", e);
        }
    }

    /// 发送完成事件
    pub fn emit_complete(
        &self,
        session_id: &str,
        id: String,
        translated_text: String,
        created_at: String,
    ) {
        let event_name = format!("translation_stream_{}", session_id);
        let payload = TranslationStreamComplete {
            event_type: "complete".to_string(),
            id,
            translated_text,
            created_at,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            eprintln!("❌ [Translation] 发送完成事件失败: {}", e);
        }
    }

    /// 发送错误事件
    pub fn emit_error(&self, session_id: &str, message: String) {
        let event_name = format!("translation_stream_{}", session_id);
        let payload = TranslationStreamError {
            event_type: "error".to_string(),
            message,
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            eprintln!("❌ [Translation] 发送错误事件失败: {}", e);
        }
    }

    /// 发送取消事件
    pub fn emit_cancelled(&self, session_id: &str) {
        let event_name = format!("translation_stream_{}", session_id);
        let payload = TranslationStreamCancelled {
            event_type: "cancelled".to_string(),
        };

        if let Err(e) = self.window.emit(&event_name, payload) {
            eprintln!("❌ [Translation] 发送取消事件失败: {}", e);
        }
    }
}
