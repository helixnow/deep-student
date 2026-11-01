/// 作文批改事件发射器 - 负责发送 SSE 事件到前端
///
/// 事件名固定为 `essay_grading_stream_{stream_session_id}`，payload 的
/// `type` 字段取值 data/complete/error/cancelled（前端契约，不可更改）
/// 以及 progress（2026-07 新增的阶段进度事件，旧监听方自动忽略）。
use tauri::{Emitter, Window};

use super::types::{
    GradingStreamCancelled, GradingStreamComplete, GradingStreamData, GradingStreamError,
    GradingStreamProgress,
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

    fn event_name(stream_session_id: &str) -> String {
        format!("essay_grading_stream_{}", stream_session_id)
    }

    /// 发送增量数据事件
    ///
    /// A6-11: payload 只携带增量 chunk（前端自行累加）；`char_count` 为
    /// 已累积的总字符数，由调用方增量维护，避免每个 chunk 重扫全文。
    pub fn emit_data(&self, stream_session_id: &str, chunk: String, char_count: usize) {
        let payload = GradingStreamData {
            event_type: "data".to_string(),
            chunk,
            char_count,
        };

        if let Err(e) = self
            .window
            .emit(&Self::event_name(stream_session_id), payload)
        {
            log::error!("[EssayGrading] 发送数据事件失败: {}", e);
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
        let payload = GradingStreamComplete {
            event_type: "complete".to_string(),
            round_id,
            grading_result,
            overall_score,
            parsed_score,
            created_at,
        };

        if let Err(e) = self
            .window
            .emit(&Self::event_name(stream_session_id), payload)
        {
            log::error!("[EssayGrading] 发送完成事件失败: {}", e);
        }
    }

    /// 发送阶段进度事件（2026-07 新增）
    ///
    /// payload：`{ type: "progress", stage, char_count }`。
    /// 旧前端只分发 data/complete/error/cancelled，未识别的 type 自动忽略，
    /// 因此该事件对历史监听方完全兼容。
    pub fn emit_progress(&self, stream_session_id: &str, stage: &str, char_count: usize) {
        let payload = GradingStreamProgress {
            event_type: "progress".to_string(),
            stage: stage.to_string(),
            char_count,
        };

        if let Err(e) = self
            .window
            .emit(&Self::event_name(stream_session_id), payload)
        {
            log::error!("[EssayGrading] 发送进度事件失败: {}", e);
        }
    }

    /// 发送错误事件
    ///
    /// `partial_chars`：错误发生前已流出的字符数（可选附加字段，便于前端
    /// 提示"已生成部分结果"）；None 时 payload 与历史格式完全一致。
    pub fn emit_error(
        &self,
        stream_session_id: &str,
        message: String,
        partial_chars: Option<usize>,
    ) {
        self.emit_error_classified(stream_session_id, message, partial_chars, None);
    }

    /// 发送带分类信息的错误事件（2026-07 新增）
    ///
    /// `classification`：可选的结构化分类附加字段（如
    /// `{ category: "rate_limit", retryable: true, http_status: 429 }`），
    /// 直接合并进 payload 顶层。历史字段（type/message/partial_chars）不变，
    /// 旧前端只读 message，附加字段自动忽略。
    pub fn emit_error_classified(
        &self,
        stream_session_id: &str,
        message: String,
        partial_chars: Option<usize>,
        classification: Option<&serde_json::Value>,
    ) {
        let base = GradingStreamError {
            event_type: "error".to_string(),
            message,
        };
        let mut payload = match serde_json::to_value(&base) {
            Ok(value) => value,
            Err(e) => {
                log::error!("[EssayGrading] 序列化错误事件失败: {}", e);
                return;
            }
        };
        if let Some(obj) = payload.as_object_mut() {
            if let Some(chars) = partial_chars {
                obj.insert("partial_chars".to_string(), serde_json::json!(chars));
            }
            if let Some(serde_json::Value::Object(extra)) = classification {
                for (key, value) in extra {
                    // 保护历史契约字段不被附加信息覆盖
                    if key == "type" || key == "message" || key == "partial_chars" {
                        continue;
                    }
                    obj.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
        }

        if let Err(e) = self
            .window
            .emit(&Self::event_name(stream_session_id), payload)
        {
            log::error!("[EssayGrading] 发送错误事件失败: {}", e);
        }
    }

    /// 发送取消事件
    pub fn emit_cancelled(&self, stream_session_id: &str) {
        let payload = GradingStreamCancelled {
            event_type: "cancelled".to_string(),
        };

        if let Err(e) = self
            .window
            .emit(&Self::event_name(stream_session_id), payload)
        {
            log::error!("[EssayGrading] 发送取消事件失败: {}", e);
        }
    }
}
