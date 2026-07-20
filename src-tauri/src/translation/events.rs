/// 翻译事件发射器 - 负责发送 SSE 事件到前端
use tauri::{Emitter, Window};

use super::types::{
    TranslationStreamCancelled, TranslationStreamComplete, TranslationStreamData,
    TranslationStreamError,
};

/// 流式统计（增量维护，避免每 chunk 全量扫描累积文本的 O(n²) 开销）
#[derive(Debug, Default, Clone)]
pub struct StreamStats {
    pub char_count: usize,
    pub word_count: usize,
    /// 上一个已处理字符是否为空白（用于跨 chunk 边界正确统计单词数）
    last_was_whitespace: bool,
    started: bool,
}

impl StreamStats {
    pub fn new() -> Self {
        Self {
            char_count: 0,
            word_count: 0,
            last_was_whitespace: true,
            started: false,
        }
    }

    /// 按增量 chunk 更新统计
    pub fn push_chunk(&mut self, chunk: &str) {
        for ch in chunk.chars() {
            self.char_count += 1;
            let is_ws = ch.is_whitespace();
            // 空白 → 非空白 的边沿即一个新单词的开始
            if !is_ws && (self.last_was_whitespace || !self.started) {
                self.word_count += 1;
            }
            self.last_was_whitespace = is_ws;
            self.started = true;
        }
    }
}

/// 翻译事件发射器
pub struct TranslationEventEmitter {
    window: Window,
}

impl TranslationEventEmitter {
    /// 创建新的事件发射器
    pub fn new(window: Window) -> Self {
        Self { window }
    }

    fn event_name(session_id: &str) -> String {
        format!("translation_stream_{}", session_id)
    }

    /// 发送增量数据事件
    ///
    /// # 参数
    /// - `session_id`: 会话 ID（用于事件作用域）
    /// - `chunk`: 本次增量内容（payload 同时携带 `chunk` 与 `delta`，语义相同；
    ///   `delta` 为新协议字段，`chunk` 为兼容保留）
    /// - `stats`: 增量维护的字符/单词统计（A6-11：不再回传全量 accumulated）
    /// - `detected_lang`: 检测到的源语言（仅 auto 模式且检测成功时携带）
    pub fn emit_data(
        &self,
        session_id: &str,
        chunk: String,
        stats: &StreamStats,
        detected_lang: Option<String>,
    ) {
        let payload = TranslationStreamData {
            event_type: "data".to_string(),
            delta: chunk.clone(),
            chunk,
            char_count: stats.char_count,
            word_count: stats.word_count,
            detected_lang,
            segment_index: None,
            segment_total: None,
        };

        if let Err(e) = self.window.emit(&Self::event_name(session_id), payload) {
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
        detected_lang: Option<String>,
    ) {
        let payload = TranslationStreamComplete {
            event_type: "complete".to_string(),
            id,
            translated_text,
            created_at,
            detected_lang,
        };

        if let Err(e) = self.window.emit(&Self::event_name(session_id), payload) {
            eprintln!("❌ [Translation] 发送完成事件失败: {}", e);
        }
    }

    /// 发送错误事件
    ///
    /// - `code`: 机器可读错误码（如 "http_401" / "rate_limited" / "timeout_idle"）
    /// - `retriable`: 是否建议用户重试
    pub fn emit_error(
        &self,
        session_id: &str,
        message: String,
        code: Option<String>,
        retriable: Option<bool>,
    ) {
        let payload = TranslationStreamError {
            event_type: "error".to_string(),
            message,
            code,
            retriable,
        };

        if let Err(e) = self.window.emit(&Self::event_name(session_id), payload) {
            eprintln!("❌ [Translation] 发送错误事件失败: {}", e);
        }
    }

    /// 发送取消事件
    pub fn emit_cancelled(&self, session_id: &str) {
        let payload = TranslationStreamCancelled {
            event_type: "cancelled".to_string(),
        };

        if let Err(e) = self.window.emit(&Self::event_name(session_id), payload) {
            eprintln!("❌ [Translation] 发送取消事件失败: {}", e);
        }
    }
}
