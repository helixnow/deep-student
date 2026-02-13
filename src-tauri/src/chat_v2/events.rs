//! Chat V2 事件发射系统
//!
//! 实现块级和会话级事件的发射，用于前端实时更新 UI。
//!
//! ## 事件通道
//! - 块级事件: `chat_v2_event_{session_id}` - 前端监听单个块的生命周期
//! - 会话级事件: `chat_v2_session_{session_id}` - 前端监听整体流式状态
//!
//! ## 事件类型与块类型映射
//! | 事件类型 | 前端创建的块类型 |
//! |---------|----------------|
//! | thinking | thinking |
//! | content | content |
//! | tool_call | mcp_tool |
//! | rag | rag |
//! | graph_rag | graph_rag |
//! | memory | memory |
//! | web_search | web_search |
//! | image_gen | image_gen |
//! | anki_cards | anki_cards |

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::LazyLock;
use tauri::{Emitter, Window};

use super::types::TokenUsage;

// ============================================================
// 事件阶段常量
// ============================================================

/// 事件阶段常量
pub mod event_phase {
    /// 开始阶段 - 前端创建块
    pub const START: &str = "start";
    /// 数据块阶段 - 流式内容更新
    pub const CHUNK: &str = "chunk";
    /// 结束阶段 - 块完成
    pub const END: &str = "end";
    /// 错误阶段 - 块出错
    pub const ERROR: &str = "error";
}

// ============================================================
// 事件类型常量
// ============================================================

/// 事件类型常量（与前端 eventRegistry 注册的类型一致）
///
/// ⚠️ 注意：事件类型 ≠ 块类型！
/// 例如：`tool_call` 事件 → 前端创建 `mcp_tool` 块
pub mod event_types {
    /// 思维链/推理过程
    pub const THINKING: &str = "thinking";
    /// 主要内容输出
    pub const CONTENT: &str = "content";
    /// 工具调用（前端创建 mcp_tool 块）
    pub const TOOL_CALL: &str = "tool_call";
    /// 🆕 2026-01-15: 工具调用参数准备中（LLM 正在生成工具调用参数）
    pub const TOOL_CALL_PREPARING: &str = "tool_call_preparing";
    pub const IMAGE_GEN: &str = "image_gen";
    pub const RAG: &str = "rag";
    pub const MEMORY: &str = "memory";
    pub const WEB_SEARCH: &str = "web_search";
    pub const MULTIMODAL_RAG: &str = "multimodal_rag";
    pub const ANKI_CARDS: &str = "anki_cards";

    // ========== 变体生命周期事件 ==========
    /// 变体开始生成
    pub const VARIANT_START: &str = "variant_start";
    /// 变体生成完成
    pub const VARIANT_END: &str = "variant_end";

    // ========== 工具审批事件（文档 29 P1-3）==========
    /// 工具审批请求
    pub const TOOL_APPROVAL_REQUEST: &str = "tool_approval_request";
    /// 工具审批响应
    pub const TOOL_APPROVAL_RESPONSE: &str = "tool_approval_response";

    // ========== 系统提示事件 ==========
    /// 工具递归限制提示（达到最大递归次数时）
    pub const TOOL_LIMIT: &str = "tool_limit";
}

// ============================================================
// 会话事件类型常量
// ============================================================

/// 会话级事件类型常量
pub mod session_event_type {
    /// 流式生成开始
    pub const STREAM_START: &str = "stream_start";
    /// 流式生成完成
    pub const STREAM_COMPLETE: &str = "stream_complete";
    /// 流式生成错误
    pub const STREAM_ERROR: &str = "stream_error";
    /// 流式生成取消
    pub const STREAM_CANCELLED: &str = "stream_cancelled";
    /// 保存完成
    pub const SAVE_COMPLETE: &str = "save_complete";
    /// 保存错误
    pub const SAVE_ERROR: &str = "save_error";
    /// 变体删除
    pub const VARIANT_DELETED: &str = "variant_deleted";
    /// 标题更新（自动生成标题后通知前端）
    pub const TITLE_UPDATED: &str = "title_updated";
    /// 摘要更新（包含标题和简介）
    pub const SUMMARY_UPDATED: &str = "summary_updated";
}

// ============================================================
// 事件结构定义
// ============================================================

/// 块级事件 - 前端监听 `chat_v2_event_{session_id}`
///
/// 关键约定：
/// - `start` 阶段：`message_id` 必填，`block_id` 可选（多工具并发时由后端生成）
/// - `chunk/end/error` 阶段：`block_id` 必填
/// - 变体相关的 block 事件必须携带 `variant_id`
/// - `variant_start` 必须在变体的任何 block 事件之前
/// - `variant_end` 必须在变体的所有 block 事件之后
///
/// 参考：`src/chat-v2/core/middleware/eventBridge.ts::BackendEvent`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEvent {
    /// 递增序列号（用于前端检测乱序和丢失）
    /// 从 0 开始递增，每个会话的 EventEmitter 独立计数
    pub sequence_id: u64,

    /// 事件类型（如 'content', 'thinking', 'rag', 'tool_call', 'anki_cards', 'variant_start', 'variant_end'）
    pub r#type: String,

    /// 事件阶段：'start' | 'chunk' | 'end' | 'error'
    pub phase: String,

    /// 关联的消息 ID（start 阶段必须提供）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,

    /// 关联的块 ID
    /// - start 阶段：可选，多工具并发时由后端生成并传入
    /// - chunk/end/error 阶段：必填
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,

    /// 块类型（start 阶段可选，默认使用 type）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_type: Option<String>,

    /// 数据块（chunk 阶段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<String>,

    /// 最终结果（end 阶段，如检索结果、工具输出）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,

    /// 错误信息（error 阶段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    /// 附加数据（任意阶段，如 toolName, toolInput）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,

    // ========== 多变体支持字段 ==========
    /// 变体 ID（多变体模式下必填，单变体模式可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_id: Option<String>,

    /// 模型 ID（variant_start 事件时使用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,

    /// 变体状态（variant_end 事件时使用：success/error/cancelled）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,

    /// Token 使用统计（variant_end 事件时使用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}

impl BackendEvent {
    /// 创建 start 事件
    ///
    /// ## 参数
    /// - `sequence_id`: 递增序列号
    /// - `event_type`: 事件类型
    /// - `message_id`: 消息 ID
    /// - `block_id`: 块 ID（可选，多工具并发时由后端生成）
    /// - `payload`: 附加数据
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn start(
        sequence_id: u64,
        event_type: &str,
        message_id: &str,
        block_id: Option<&str>,
        payload: Option<Value>,
        variant_id: Option<&str>,
    ) -> Self {
        Self {
            sequence_id,
            r#type: event_type.to_string(),
            phase: event_phase::START.to_string(),
            message_id: Some(message_id.to_string()),
            block_id: block_id.map(|s| s.to_string()),
            block_type: None,
            chunk: None,
            result: None,
            error: None,
            payload,
            variant_id: variant_id.map(|s| s.to_string()),
            model_id: None,
            status: None,
            usage: None,
        }
    }

    /// 创建 chunk 事件
    ///
    /// ## 参数
    /// - `sequence_id`: 递增序列号
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `chunk`: 数据块内容
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn chunk(
        sequence_id: u64,
        event_type: &str,
        block_id: &str,
        chunk: &str,
        variant_id: Option<&str>,
    ) -> Self {
        Self {
            sequence_id,
            r#type: event_type.to_string(),
            phase: event_phase::CHUNK.to_string(),
            message_id: None,
            block_id: Some(block_id.to_string()),
            block_type: None,
            chunk: Some(chunk.to_string()),
            result: None,
            error: None,
            payload: None,
            variant_id: variant_id.map(|s| s.to_string()),
            model_id: None,
            status: None,
            usage: None,
        }
    }

    /// 创建 end 事件
    ///
    /// ## 参数
    /// - `sequence_id`: 递增序列号
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `result`: 最终结果（可选）
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn end(
        sequence_id: u64,
        event_type: &str,
        block_id: &str,
        result: Option<Value>,
        variant_id: Option<&str>,
    ) -> Self {
        Self {
            sequence_id,
            r#type: event_type.to_string(),
            phase: event_phase::END.to_string(),
            message_id: None,
            block_id: Some(block_id.to_string()),
            block_type: None,
            chunk: None,
            result,
            error: None,
            payload: None,
            variant_id: variant_id.map(|s| s.to_string()),
            model_id: None,
            status: None,
            usage: None,
        }
    }

    /// 创建 error 事件
    ///
    /// ## 参数
    /// - `sequence_id`: 递增序列号
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `error`: 错误信息
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn error(
        sequence_id: u64,
        event_type: &str,
        block_id: &str,
        error: &str,
        variant_id: Option<&str>,
    ) -> Self {
        Self {
            sequence_id,
            r#type: event_type.to_string(),
            phase: event_phase::ERROR.to_string(),
            message_id: None,
            block_id: Some(block_id.to_string()),
            block_type: None,
            chunk: None,
            result: None,
            error: Some(error.to_string()),
            payload: None,
            variant_id: variant_id.map(|s| s.to_string()),
            model_id: None,
            status: None,
            usage: None,
        }
    }

    /// 创建 variant_start 事件
    ///
    /// ## 参数
    /// - `sequence_id`: 递增序列号
    /// - `message_id`: 消息 ID
    /// - `variant_id`: 变体 ID
    /// - `model_id`: 模型 ID
    pub fn variant_start(
        sequence_id: u64,
        message_id: &str,
        variant_id: &str,
        model_id: &str,
    ) -> Self {
        Self {
            sequence_id,
            r#type: event_types::VARIANT_START.to_string(),
            phase: event_phase::START.to_string(),
            message_id: Some(message_id.to_string()),
            block_id: None,
            block_type: None,
            chunk: None,
            result: None,
            error: None,
            payload: None,
            variant_id: Some(variant_id.to_string()),
            model_id: Some(model_id.to_string()),
            status: None,
            usage: None,
        }
    }

    /// 创建 variant_end 事件
    ///
    /// ## 参数
    /// - `sequence_id`: 递增序列号
    /// - `variant_id`: 变体 ID
    /// - `status`: 变体最终状态（success/error/cancelled）
    /// - `error`: 错误信息（状态为 error 时提供）
    /// - `usage`: Token 使用统计（可选）
    pub fn variant_end(
        sequence_id: u64,
        variant_id: &str,
        status: &str,
        error: Option<&str>,
        usage: Option<TokenUsage>,
    ) -> Self {
        Self {
            sequence_id,
            r#type: event_types::VARIANT_END.to_string(),
            phase: event_phase::END.to_string(),
            message_id: None,
            block_id: None,
            block_type: None,
            chunk: None,
            result: None,
            error: error.map(|s| s.to_string()),
            payload: None,
            variant_id: Some(variant_id.to_string()),
            model_id: None,
            status: Some(status.to_string()),
            usage,
        }
    }
}

/// 会话级事件 - 前端监听 `chat_v2_session_{session_id}`
///
/// 用于通知前端整体流式状态变化，如开始、完成、错误、取消等。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    /// 会话 ID
    pub session_id: String,

    /// 事件类型：stream_start/stream_complete/stream_error/stream_cancelled/save_complete/save_error
    pub event_type: String,

    /// 关联的消息 ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,

    /// 模型标识符（stream_start 事件时提供，用于前端显示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,

    /// 错误信息（error 事件时提供）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    /// 持续时间（毫秒，complete 事件时提供）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,

    /// 事件时间戳（毫秒）
    pub timestamp: i64,

    /// Token 使用统计（stream_complete 事件时提供）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,

    /// 标题（title_updated/summary_updated 事件时提供）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 简介（summary_updated 事件时提供）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl SessionEvent {
    /// 创建流式开始事件
    /// `model_id` 是模型标识符（如 "Qwen/Qwen3-8B"），用于前端显示
    pub fn stream_start(session_id: &str, message_id: &str, model_id: Option<&str>) -> Self {
        Self {
            session_id: session_id.to_string(),
            event_type: session_event_type::STREAM_START.to_string(),
            message_id: Some(message_id.to_string()),
            model_id: model_id.map(|s| s.to_string()),
            error: None,
            duration_ms: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
            usage: None,
            title: None,
            description: None,
        }
    }

    /// 创建流式完成事件
    pub fn stream_complete(session_id: &str, message_id: &str, duration_ms: u64) -> Self {
        Self {
            session_id: session_id.to_string(),
            event_type: session_event_type::STREAM_COMPLETE.to_string(),
            message_id: Some(message_id.to_string()),
            model_id: None,
            error: None,
            duration_ms: Some(duration_ms),
            timestamp: chrono::Utc::now().timestamp_millis(),
            usage: None,
            title: None,
            description: None,
        }
    }

    /// 创建带 token 统计的流式完成事件
    ///
    /// ## 参数
    /// - `session_id`: 会话 ID
    /// - `message_id`: 消息 ID
    /// - `duration_ms`: 持续时间（毫秒）
    /// - `usage`: Token 使用统计（可选）
    pub fn stream_complete_with_usage(
        session_id: &str,
        message_id: &str,
        duration_ms: u64,
        usage: Option<TokenUsage>,
    ) -> Self {
        Self {
            session_id: session_id.to_string(),
            event_type: session_event_type::STREAM_COMPLETE.to_string(),
            message_id: Some(message_id.to_string()),
            model_id: None,
            error: None,
            duration_ms: Some(duration_ms),
            timestamp: chrono::Utc::now().timestamp_millis(),
            usage,
            title: None,
            description: None,
        }
    }

    /// 创建流式错误事件
    pub fn stream_error(session_id: &str, message_id: &str, error: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            event_type: session_event_type::STREAM_ERROR.to_string(),
            message_id: Some(message_id.to_string()),
            model_id: None,
            error: Some(error.to_string()),
            duration_ms: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
            usage: None,
            title: None,
            description: None,
        }
    }

    /// 创建流式取消事件
    pub fn stream_cancelled(session_id: &str, message_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            event_type: session_event_type::STREAM_CANCELLED.to_string(),
            message_id: Some(message_id.to_string()),
            model_id: None,
            error: None,
            duration_ms: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
            usage: None,
            title: None,
            description: None,
        }
    }

    /// 创建保存完成事件
    pub fn save_complete(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            event_type: session_event_type::SAVE_COMPLETE.to_string(),
            message_id: None,
            model_id: None,
            error: None,
            duration_ms: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
            usage: None,
            title: None,
            description: None,
        }
    }

    /// 创建保存错误事件
    pub fn save_error(session_id: &str, error: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            event_type: session_event_type::SAVE_ERROR.to_string(),
            message_id: None,
            model_id: None,
            error: Some(error.to_string()),
            duration_ms: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
            usage: None,
            title: None,
            description: None,
        }
    }

    /// 创建标题更新事件（仅标题，向后兼容）
    pub fn title_updated(session_id: &str, title: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            event_type: session_event_type::TITLE_UPDATED.to_string(),
            message_id: None,
            model_id: None,
            error: None,
            duration_ms: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
            usage: None,
            title: Some(title.to_string()),
            description: None,
        }
    }

    /// 创建摘要更新事件（包含标题和简介）
    pub fn summary_updated(session_id: &str, title: &str, description: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            event_type: session_event_type::SUMMARY_UPDATED.to_string(),
            message_id: None,
            model_id: None,
            error: None,
            duration_ms: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
            usage: None,
            title: Some(title.to_string()),
            description: Some(description.to_string()),
        }
    }
}

// ============================================================
// 事件发射器
// ============================================================

/// Chat V2 事件发射器
///
/// 封装 Tauri Window 事件发射，提供类型安全的便捷方法。
/// 内置 AtomicU64 序列号生成器，确保事件序列号严格递增。
///
/// ## 使用示例
/// ```ignore
/// let emitter = ChatV2EventEmitter::new(window, session_id);
///
/// // 发射 start 事件（前端创建块）
/// emitter.emit_start(event_types::CONTENT, &message_id, None, None, None);
///
/// // 发射 chunk 事件（流式内容）
/// emitter.emit_chunk(event_types::CONTENT, &block_id, "Hello ", None);
///
/// // 发射 end 事件（块完成）
/// emitter.emit_end(event_types::CONTENT, &block_id, None, None);
///
/// // 发射变体生命周期事件（多变体模式）
/// emitter.emit_variant_start(&message_id, &variant_id, &model_id);
/// emitter.emit_variant_end(&variant_id, "success", None, Some(usage));
///
/// // 发射会话级事件
/// emitter.emit_stream_complete(&message_id, 1500);
/// ```
static SESSION_SEQUENCE_COUNTERS: LazyLock<DashMap<String, Arc<AtomicU64>>> =
    LazyLock::new(DashMap::new);

fn get_or_create_session_counter(session_id: &str) -> Arc<AtomicU64> {
    SESSION_SEQUENCE_COUNTERS
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(AtomicU64::new(0)))
        .clone()
}

pub fn next_session_sequence_id(session_id: &str) -> u64 {
    let counter = get_or_create_session_counter(session_id);
    counter.fetch_add(1, Ordering::SeqCst)
}

pub fn clear_session_sequence_counter(session_id: &str) {
    SESSION_SEQUENCE_COUNTERS.remove(session_id);
}

pub struct ChatV2EventEmitter {
    window: Window,
    session_id: String,
    /// 递增序列号生成器（从 0 开始，按会话共享）
    sequence_counter: Arc<AtomicU64>,
}

impl ChatV2EventEmitter {
    /// 创建新的事件发射器
    pub fn new(window: Window, session_id: String) -> Self {
        Self {
            window,
            session_id: session_id.clone(),
            sequence_counter: get_or_create_session_counter(&session_id),
        }
    }

    /// 获取会话 ID
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 获取 Window 引用（供 LLM 调用使用）
    pub fn window(&self) -> Window {
        self.window.clone()
    }

    /// 获取下一个序列号（原子递增）
    fn next_sequence_id(&self) -> u64 {
        self.sequence_counter.fetch_add(1, Ordering::SeqCst)
    }

    /// 获取当前序列号（不递增，用于测试）
    #[cfg(test)]
    fn current_sequence_id(&self) -> u64 {
        self.sequence_counter.load(Ordering::SeqCst)
    }

    /// 获取块级事件通道名
    fn block_event_channel(&self) -> String {
        format!("chat_v2_event_{}", self.session_id)
    }

    /// 获取会话级事件通道名
    fn session_event_channel(&self) -> String {
        format!("chat_v2_session_{}", self.session_id)
    }

    // ========== 内部发射方法 ==========

    /// 发射块级事件（内部方法）
    fn emit(&self, event: BackendEvent) {
        let event_name = self.block_event_channel();

        if let Err(e) = self.window.emit(&event_name, &event) {
            log::error!(
                "[ChatV2::events] Failed to emit block event: {} - {:?}",
                event_name,
                e
            );
        } else {
            log::debug!(
                "[ChatV2::events] Emitted block event: {} type={} phase={} seq={}",
                event_name,
                event.r#type,
                event.phase,
                event.sequence_id
            );
        }
    }

    /// 发射会话级事件（内部方法）
    fn emit_session(&self, event: SessionEvent) {
        let event_name = self.session_event_channel();
        if let Err(e) = self.window.emit(&event_name, &event) {
            log::error!(
                "[ChatV2::events] Failed to emit session event: {} - {:?}",
                event_name,
                e
            );
        } else {
            log::debug!(
                "[ChatV2::events] Emitted session event: {} type={}",
                event_name,
                event.event_type
            );
        }
    }

    // ========== 块级事件便捷方法 ==========

    /// 发射 start 事件
    ///
    /// ## 参数
    /// - `event_type`: 事件类型（如 "content", "thinking", "tool_call"）
    /// - `message_id`: 消息 ID
    /// - `block_id`: 可选的块 ID（多工具并发时由后端生成）
    /// - `payload`: 可选的附加数据（如 toolName, toolInput）
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    ///
    /// ## 返回
    /// 如果传入了 `block_id` 则返回 `Some(block_id)`，否则返回 `None`（前端创建）
    pub fn emit_start(
        &self,
        event_type: &str,
        message_id: &str,
        block_id: Option<&str>,
        payload: Option<Value>,
        variant_id: Option<&str>,
    ) -> Option<String> {
        let seq = self.next_sequence_id();
        let event = BackendEvent::start(seq, event_type, message_id, block_id, payload, variant_id);
        self.emit(event);
        block_id.map(|s| s.to_string())
    }

    /// 发射 chunk 事件
    ///
    /// ## 参数
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `chunk`: 数据块内容
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn emit_chunk(
        &self,
        event_type: &str,
        block_id: &str,
        chunk: &str,
        variant_id: Option<&str>,
    ) {
        let seq = self.next_sequence_id();
        let event = BackendEvent::chunk(seq, event_type, block_id, chunk, variant_id);
        self.emit(event);
    }

    /// 发射 end 事件
    ///
    /// ## 参数
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `result`: 可选的最终结果（如检索结果、工具输出）
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn emit_end(
        &self,
        event_type: &str,
        block_id: &str,
        result: Option<Value>,
        variant_id: Option<&str>,
    ) {
        let seq = self.next_sequence_id();
        let event = BackendEvent::end(seq, event_type, block_id, result, variant_id);
        self.emit(event);
    }

    /// 发射 error 事件
    ///
    /// ## 参数
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `error`: 错误信息
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn emit_error(
        &self,
        event_type: &str,
        block_id: &str,
        error: &str,
        variant_id: Option<&str>,
    ) {
        let seq = self.next_sequence_id();
        let event = BackendEvent::error(seq, event_type, block_id, error, variant_id);
        self.emit(event);
    }

    // ========== 特定类型便捷方法 ==========

    /// 发射 content chunk 事件
    ///
    /// ## 参数
    /// - `block_id`: 块 ID
    /// - `content`: 内容
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn emit_content_chunk(&self, block_id: &str, content: &str, variant_id: Option<&str>) {
        self.emit_chunk(event_types::CONTENT, block_id, content, variant_id);
    }

    /// 发射 thinking chunk 事件
    ///
    /// ## 参数
    /// - `block_id`: 块 ID
    /// - `content`: 内容
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn emit_thinking_chunk(&self, block_id: &str, content: &str, variant_id: Option<&str>) {
        self.emit_chunk(event_types::THINKING, block_id, content, variant_id);
    }

    /// 发射 tool_call start 事件（带 payload）
    ///
    /// ## 参数
    /// - `message_id`: 消息 ID
    /// - `block_id`: 块 ID（多工具并发时由后端生成）
    /// - `tool_name`: 工具名称
    /// - `tool_input`: 工具输入参数
    /// - `tool_call_id`: 🆕 工具调用 ID（用于前端复用 preparing 块）
    /// - `variant_id`: 变体 ID（多变体模式下传入）
    pub fn emit_tool_call_start(
        &self,
        message_id: &str,
        block_id: &str,
        tool_name: &str,
        tool_input: Value,
        tool_call_id: Option<&str>,
        variant_id: Option<&str>,
    ) {
        let payload = serde_json::json!({
            "toolName": tool_name,
            "toolInput": tool_input,
            "toolCallId": tool_call_id, // 🆕 用于前端复用 preparing 块
        });
        self.emit_start(
            event_types::TOOL_CALL,
            message_id,
            Some(block_id),
            Some(payload),
            variant_id,
        );
    }

    /// 🆕 2026-01-15: 发射工具调用准备中事件
    /// 在 LLM 开始生成工具调用参数时立即调用，让前端显示"正在准备工具调用"状态
    ///
    /// ## 参数
    /// - `message_id`: 消息 ID
    /// - `tool_call_id`: 工具调用 ID
    /// - `tool_name`: 工具名称
    pub fn emit_tool_call_preparing(&self, message_id: &str, tool_call_id: &str, tool_name: &str) {
        let seq = self.next_sequence_id();
        let payload = serde_json::json!({
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "status": "preparing",
        });
        let event = BackendEvent {
            sequence_id: seq,
            r#type: event_types::TOOL_CALL_PREPARING.to_string(),
            phase: "start".to_string(),
            message_id: Some(message_id.to_string()),
            block_id: None,
            block_type: None,
            chunk: None,
            result: None,
            error: None,
            payload: Some(payload),
            variant_id: None,
            model_id: None,
            status: None,
            usage: None,
        };
        self.emit(event);
    }

    /// 发射工具调用准备中事件（带 variant_id）
    pub fn emit_tool_call_preparing_with_variant(
        &self,
        message_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        variant_id: &str,
    ) {
        let seq = self.next_sequence_id();
        let payload = serde_json::json!({
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "status": "preparing",
        });
        let event = BackendEvent {
            sequence_id: seq,
            r#type: event_types::TOOL_CALL_PREPARING.to_string(),
            phase: "start".to_string(),
            message_id: Some(message_id.to_string()),
            block_id: None,
            block_type: None,
            chunk: None,
            result: None,
            error: None,
            payload: Some(payload),
            variant_id: Some(variant_id.to_string()),
            model_id: None,
            status: None,
            usage: None,
        };
        self.emit(event);
    }

    // ========== 会话级事件便捷方法 ==========

    /// 发射流式开始事件
    /// `model_id` 是模型标识符（如 "Qwen/Qwen3-8B"），用于前端显示
    pub fn emit_stream_start(&self, message_id: &str, model_id: Option<&str>) {
        let event = SessionEvent::stream_start(&self.session_id, message_id, model_id);
        self.emit_session(event);
    }

    /// 发射流式完成事件
    pub fn emit_stream_complete(&self, message_id: &str, duration_ms: u64) {
        let event = SessionEvent::stream_complete(&self.session_id, message_id, duration_ms);
        self.emit_session(event);
    }

    /// 发射带 token 统计的流式完成事件
    ///
    /// ## 参数
    /// - `message_id`: 消息 ID
    /// - `duration_ms`: 持续时间（毫秒）
    /// - `usage`: Token 使用统计（可选）
    pub fn emit_stream_complete_with_usage(
        &self,
        message_id: &str,
        duration_ms: u64,
        usage: Option<&TokenUsage>,
    ) {
        let event = SessionEvent::stream_complete_with_usage(
            &self.session_id,
            message_id,
            duration_ms,
            usage.cloned(),
        );
        self.emit_session(event);
    }

    /// 发射流式错误事件
    pub fn emit_stream_error(&self, message_id: &str, error: &str) {
        let event = SessionEvent::stream_error(&self.session_id, message_id, error);
        self.emit_session(event);
    }

    /// 发射流式取消事件
    pub fn emit_stream_cancelled(&self, message_id: &str) {
        let event = SessionEvent::stream_cancelled(&self.session_id, message_id);
        self.emit_session(event);
    }

    /// 发射保存完成事件
    pub fn emit_save_complete(&self) {
        let event = SessionEvent::save_complete(&self.session_id);
        self.emit_session(event);
    }

    /// 发射保存错误事件
    pub fn emit_save_error(&self, error: &str) {
        let event = SessionEvent::save_error(&self.session_id, error);
        self.emit_session(event);
    }

    /// 发射标题更新事件
    ///
    /// ## 参数
    /// - `title`: 新的会话标题
    pub fn emit_title_updated(&self, title: &str) {
        let event = SessionEvent::title_updated(&self.session_id, title);
        self.emit_session(event);
    }

    /// 发射摘要更新事件（包含标题和简介）
    ///
    /// ## 参数
    /// - `title`: 新的会话标题
    /// - `description`: 新的会话简介
    pub fn emit_summary_updated(&self, title: &str, description: &str) {
        let event = SessionEvent::summary_updated(&self.session_id, title, description);
        self.emit_session(event);
    }

    // ========== 变体生命周期事件 ==========

    /// 发射 variant_start 事件
    ///
    /// 必须在变体的任何 block 事件之前发射。
    ///
    /// ## 参数
    /// - `message_id`: 消息 ID
    /// - `variant_id`: 变体 ID
    /// - `model_id`: 模型 ID
    pub fn emit_variant_start(&self, message_id: &str, variant_id: &str, model_id: &str) {
        let seq = self.next_sequence_id();
        let event = BackendEvent::variant_start(seq, message_id, variant_id, model_id);
        self.emit(event);
    }

    /// 发射 variant_end 事件
    ///
    /// 必须在变体的所有 block 事件之后发射。
    ///
    /// ## 参数
    /// - `variant_id`: 变体 ID
    /// - `status`: 变体最终状态（success/error/cancelled）
    /// - `error`: 错误信息（状态为 error 时提供）
    /// - `usage`: Token 使用统计（可选）
    pub fn emit_variant_end(
        &self,
        variant_id: &str,
        status: &str,
        error: Option<&str>,
        usage: Option<TokenUsage>,
    ) {
        let seq = self.next_sequence_id();
        let event = BackendEvent::variant_end(seq, variant_id, status, error, usage);
        self.emit(event);
    }
}

// ============================================================
// 单元测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backend_event_serialization() {
        let event = BackendEvent {
            sequence_id: 42,
            r#type: "content".to_string(),
            phase: "chunk".to_string(),
            message_id: None,
            block_id: Some("blk_123".to_string()),
            block_type: None,
            chunk: Some("Hello".to_string()),
            result: None,
            error: None,
            payload: None,
            variant_id: None,
            model_id: None,
            status: None,
            usage: None,
        };

        let json = serde_json::to_string(&event).unwrap();

        // 验证使用 camelCase
        assert!(json.contains("\"blockId\""));
        assert!(json.contains("\"blk_123\""));
        assert!(json.contains("\"sequenceId\""));
        assert!(json.contains("42"));

        // 验证 None 字段不被序列化
        assert!(!json.contains("\"messageId\""));
        assert!(!json.contains("\"blockType\""));
        assert!(!json.contains("\"result\""));
        assert!(!json.contains("\"error\""));
        assert!(!json.contains("\"payload\""));
        assert!(!json.contains("\"variantId\""));
        assert!(!json.contains("\"modelId\""));
        assert!(!json.contains("\"status\""));
    }

    #[test]
    fn test_backend_event_start_creation() {
        let event = BackendEvent::start(
            0,
            event_types::CONTENT,
            "msg_456",
            Some("blk_123"),
            Some(serde_json::json!({"key": "value"})),
            None,
        );

        assert_eq!(event.sequence_id, 0);
        assert_eq!(event.r#type, "content");
        assert_eq!(event.phase, "start");
        assert_eq!(event.message_id, Some("msg_456".to_string()));
        assert_eq!(event.block_id, Some("blk_123".to_string()));
        assert!(event.payload.is_some());
        assert!(event.variant_id.is_none());
    }

    #[test]
    fn test_backend_event_start_with_variant() {
        let event = BackendEvent::start(
            5,
            event_types::CONTENT,
            "msg_456",
            Some("blk_123"),
            None,
            Some("var_001"),
        );

        assert_eq!(event.sequence_id, 5);
        assert_eq!(event.variant_id, Some("var_001".to_string()));
    }

    #[test]
    fn test_backend_event_chunk_creation() {
        let event = BackendEvent::chunk(1, event_types::THINKING, "blk_789", "思考中...", None);

        assert_eq!(event.sequence_id, 1);
        assert_eq!(event.r#type, "thinking");
        assert_eq!(event.phase, "chunk");
        assert_eq!(event.block_id, Some("blk_789".to_string()));
        assert_eq!(event.chunk, Some("思考中...".to_string()));
        assert!(event.message_id.is_none());
        assert!(event.variant_id.is_none());
    }

    #[test]
    fn test_backend_event_chunk_with_variant() {
        let event =
            BackendEvent::chunk(10, event_types::CONTENT, "blk_789", "内容", Some("var_002"));

        assert_eq!(event.sequence_id, 10);
        assert_eq!(event.variant_id, Some("var_002".to_string()));
    }

    #[test]
    fn test_backend_event_end_creation() {
        let result = serde_json::json!({
            "sources": [{"title": "文档1"}]
        });
        let event = BackendEvent::end(2, event_types::RAG, "blk_abc", Some(result.clone()), None);

        assert_eq!(event.sequence_id, 2);
        assert_eq!(event.r#type, "rag");
        assert_eq!(event.phase, "end");
        assert_eq!(event.block_id, Some("blk_abc".to_string()));
        assert_eq!(event.result, Some(result));
        assert!(event.variant_id.is_none());
    }

    #[test]
    fn test_backend_event_error_creation() {
        let event = BackendEvent::error(3, event_types::TOOL_CALL, "blk_def", "工具调用超时", None);

        assert_eq!(event.sequence_id, 3);
        assert_eq!(event.r#type, "tool_call");
        assert_eq!(event.phase, "error");
        assert_eq!(event.block_id, Some("blk_def".to_string()));
        assert_eq!(event.error, Some("工具调用超时".to_string()));
    }

    #[test]
    fn test_backend_event_variant_start() {
        let event = BackendEvent::variant_start(0, "msg_001", "var_001", "gpt-4");

        assert_eq!(event.sequence_id, 0);
        assert_eq!(event.r#type, event_types::VARIANT_START);
        assert_eq!(event.phase, event_phase::START);
        assert_eq!(event.message_id, Some("msg_001".to_string()));
        assert_eq!(event.variant_id, Some("var_001".to_string()));
        assert_eq!(event.model_id, Some("gpt-4".to_string()));
        assert!(event.block_id.is_none());
        assert!(event.status.is_none());
    }

    #[test]
    fn test_backend_event_variant_end_success() {
        let event = BackendEvent::variant_end(10, "var_001", "success", None, None);

        assert_eq!(event.sequence_id, 10);
        assert_eq!(event.r#type, event_types::VARIANT_END);
        assert_eq!(event.phase, event_phase::END);
        assert_eq!(event.variant_id, Some("var_001".to_string()));
        assert_eq!(event.status, Some("success".to_string()));
        assert!(event.error.is_none());
        assert!(event.message_id.is_none());
        assert!(event.usage.is_none());
    }

    #[test]
    fn test_backend_event_variant_end_error() {
        let event = BackendEvent::variant_end(15, "var_002", "error", Some("模型调用失败"), None);

        assert_eq!(event.sequence_id, 15);
        assert_eq!(event.variant_id, Some("var_002".to_string()));
        assert_eq!(event.status, Some("error".to_string()));
        assert_eq!(event.error, Some("模型调用失败".to_string()));
        assert!(event.usage.is_none());
    }

    #[test]
    fn test_backend_event_variant_end_with_usage() {
        use super::TokenUsage;
        let usage = TokenUsage::from_api(100, 50, Some(10));
        let event = BackendEvent::variant_end(20, "var_003", "success", None, Some(usage));

        assert_eq!(event.sequence_id, 20);
        assert_eq!(event.variant_id, Some("var_003".to_string()));
        assert_eq!(event.status, Some("success".to_string()));
        assert!(event.usage.is_some());
        let u = event.usage.unwrap();
        assert_eq!(u.prompt_tokens, 100);
        assert_eq!(u.completion_tokens, 50);
        assert_eq!(u.total_tokens, 150);
    }

    #[test]
    fn test_session_event_serialization() {
        let event = SessionEvent {
            session_id: "sess_123".to_string(),
            event_type: "stream_complete".to_string(),
            message_id: Some("msg_456".to_string()),
            model_id: None, // stream_complete 事件不需要 model_id
            error: None,
            duration_ms: Some(1500),
            timestamp: 1701619200000,
            usage: None,
            title: None, // stream_complete 事件不需要 title
            description: None,
        };

        let json = serde_json::to_string(&event).unwrap();

        // 验证使用 camelCase
        assert!(json.contains("\"sessionId\""));
        assert!(json.contains("\"eventType\""));
        assert!(json.contains("\"messageId\""));
        assert!(json.contains("\"durationMs\""));

        // 验证 None 字段不被序列化
        assert!(!json.contains("\"error\""));
        assert!(!json.contains("\"usage\""));
    }

    #[test]
    fn test_session_event_stream_start() {
        // 测试无模型名称的情况
        let event = SessionEvent::stream_start("sess_abc", "msg_def", None);
        assert_eq!(event.session_id, "sess_abc");
        assert_eq!(event.event_type, session_event_type::STREAM_START);
        assert_eq!(event.message_id, Some("msg_def".to_string()));
        assert!(event.model_id.is_none());
        assert!(event.error.is_none());
        assert!(event.duration_ms.is_none());
        assert!(event.timestamp > 0);

        // 测试带模型名称的情况
        let event_with_model =
            SessionEvent::stream_start("sess_abc", "msg_def", Some("Qwen/Qwen3-8B"));
        assert_eq!(event_with_model.model_id, Some("Qwen/Qwen3-8B".to_string()));
    }

    #[test]
    fn test_session_event_stream_complete() {
        let event = SessionEvent::stream_complete("sess_abc", "msg_def", 2500);

        assert_eq!(event.event_type, session_event_type::STREAM_COMPLETE);
        assert_eq!(event.duration_ms, Some(2500));
        assert!(event.usage.is_none()); // 无 usage 时为 None
    }

    #[test]
    fn test_session_event_stream_complete_with_usage() {
        use super::super::types::{TokenSource, TokenUsage};

        // 创建 TokenUsage
        let usage = TokenUsage::from_api(1234, 567, Some(200));

        // 创建带 usage 的事件
        let event = SessionEvent::stream_complete_with_usage(
            "sess_abc",
            "msg_def",
            2500,
            Some(usage.clone()),
        );

        assert_eq!(event.event_type, session_event_type::STREAM_COMPLETE);
        assert_eq!(event.duration_ms, Some(2500));
        assert!(event.usage.is_some());

        let event_usage = event.usage.unwrap();
        assert_eq!(event_usage.prompt_tokens, 1234);
        assert_eq!(event_usage.completion_tokens, 567);
        assert_eq!(event_usage.total_tokens, 1801);
        assert_eq!(event_usage.source, TokenSource::Api);
        assert_eq!(event_usage.reasoning_tokens, Some(200));
    }

    #[test]
    fn test_session_event_with_usage_serialization() {
        use super::super::types::TokenUsage;

        // 创建带 usage 的事件
        let usage = TokenUsage::from_api(1000, 500, None);
        let event =
            SessionEvent::stream_complete_with_usage("sess_123", "msg_456", 1500, Some(usage));

        let json = serde_json::to_string(&event).unwrap();

        // 验证 usage 字段被序列化
        assert!(
            json.contains("\"usage\""),
            "usage field should be present: {}",
            json
        );
        assert!(
            json.contains("\"promptTokens\":1000"),
            "promptTokens should be 1000: {}",
            json
        );
        assert!(
            json.contains("\"completionTokens\":500"),
            "completionTokens should be 500: {}",
            json
        );
        assert!(
            json.contains("\"totalTokens\":1500"),
            "totalTokens should be 1500: {}",
            json
        );
        assert!(
            json.contains("\"source\":\"api\""),
            "source should be 'api': {}",
            json
        );

        // 验证 None 的 reasoning_tokens 不被序列化
        assert!(
            !json.contains("\"reasoningTokens\""),
            "None reasoningTokens should not be serialized: {}",
            json
        );
    }

    #[test]
    fn test_session_event_stream_error() {
        let event = SessionEvent::stream_error("sess_abc", "msg_def", "网络错误");

        assert_eq!(event.event_type, session_event_type::STREAM_ERROR);
        assert_eq!(event.error, Some("网络错误".to_string()));
    }

    #[test]
    fn test_session_event_stream_cancelled() {
        let event = SessionEvent::stream_cancelled("sess_abc", "msg_def");

        assert_eq!(event.event_type, session_event_type::STREAM_CANCELLED);
        assert!(event.error.is_none());
    }

    #[test]
    fn test_session_event_save_complete() {
        let event = SessionEvent::save_complete("sess_abc");

        assert_eq!(event.event_type, session_event_type::SAVE_COMPLETE);
        assert!(event.message_id.is_none());
    }

    #[test]
    fn test_session_event_save_error() {
        let event = SessionEvent::save_error("sess_abc", "数据库写入失败");

        assert_eq!(event.event_type, session_event_type::SAVE_ERROR);
        assert_eq!(event.error, Some("数据库写入失败".to_string()));
    }

    #[test]
    fn test_event_phase_constants() {
        assert_eq!(event_phase::START, "start");
        assert_eq!(event_phase::CHUNK, "chunk");
        assert_eq!(event_phase::END, "end");
        assert_eq!(event_phase::ERROR, "error");
    }

    #[test]
    fn test_event_types_constants() {
        assert_eq!(event_types::THINKING, "thinking");
        assert_eq!(event_types::CONTENT, "content");
        assert_eq!(event_types::TOOL_CALL, "tool_call");
        assert_eq!(event_types::IMAGE_GEN, "image_gen");
        assert_eq!(event_types::RAG, "rag");
        assert_eq!(event_types::MEMORY, "memory");
        assert_eq!(event_types::WEB_SEARCH, "web_search");
        assert_eq!(event_types::ANKI_CARDS, "anki_cards");
        // 变体生命周期事件
        assert_eq!(event_types::VARIANT_START, "variant_start");
        assert_eq!(event_types::VARIANT_END, "variant_end");
    }

    #[test]
    fn test_session_event_type_constants() {
        assert_eq!(session_event_type::STREAM_START, "stream_start");
        assert_eq!(session_event_type::STREAM_COMPLETE, "stream_complete");
        assert_eq!(session_event_type::STREAM_ERROR, "stream_error");
        assert_eq!(session_event_type::STREAM_CANCELLED, "stream_cancelled");
        assert_eq!(session_event_type::SAVE_COMPLETE, "save_complete");
        assert_eq!(session_event_type::SAVE_ERROR, "save_error");
    }

    #[test]
    fn test_backend_event_deserialization() {
        let json = r#"{
            "sequenceId": 5,
            "type": "content",
            "phase": "chunk",
            "blockId": "blk_123",
            "chunk": "Hello World"
        }"#;

        let event: BackendEvent = serde_json::from_str(json).unwrap();

        assert_eq!(event.sequence_id, 5);
        assert_eq!(event.r#type, "content");
        assert_eq!(event.phase, "chunk");
        assert_eq!(event.block_id, Some("blk_123".to_string()));
        assert_eq!(event.chunk, Some("Hello World".to_string()));
        assert!(event.message_id.is_none());
        assert!(event.variant_id.is_none());
    }

    #[test]
    fn test_backend_event_deserialization_with_variant() {
        let json = r#"{
            "sequenceId": 10,
            "type": "content",
            "phase": "chunk",
            "blockId": "blk_123",
            "chunk": "Hello",
            "variantId": "var_001"
        }"#;

        let event: BackendEvent = serde_json::from_str(json).unwrap();

        assert_eq!(event.sequence_id, 10);
        assert_eq!(event.variant_id, Some("var_001".to_string()));
    }

    #[test]
    fn test_session_event_deserialization() {
        let json = r#"{
            "sessionId": "sess_123",
            "eventType": "stream_complete",
            "messageId": "msg_456",
            "durationMs": 1500,
            "timestamp": 1701619200000
        }"#;

        let event: SessionEvent = serde_json::from_str(json).unwrap();

        assert_eq!(event.session_id, "sess_123");
        assert_eq!(event.event_type, "stream_complete");
        assert_eq!(event.message_id, Some("msg_456".to_string()));
        assert_eq!(event.duration_ms, Some(1500));
        assert_eq!(event.timestamp, 1701619200000);
    }

    #[test]
    fn test_sequence_id_strictly_increasing() {
        // 验证 sequence_id 严格递增（通过多次调用 BackendEvent 工厂方法）
        // 注意：这里我们直接测试工厂方法的 sequence_id 参数逻辑
        let event1 = BackendEvent::start(0, event_types::CONTENT, "msg_1", None, None, None);
        let event2 = BackendEvent::chunk(1, event_types::CONTENT, "blk_1", "a", None);
        let event3 = BackendEvent::chunk(2, event_types::CONTENT, "blk_1", "b", None);
        let event4 = BackendEvent::end(3, event_types::CONTENT, "blk_1", None, None);

        assert_eq!(event1.sequence_id, 0);
        assert_eq!(event2.sequence_id, 1);
        assert_eq!(event3.sequence_id, 2);
        assert_eq!(event4.sequence_id, 3);

        // 验证严格递增
        assert!(event1.sequence_id < event2.sequence_id);
        assert!(event2.sequence_id < event3.sequence_id);
        assert!(event3.sequence_id < event4.sequence_id);
    }

    #[test]
    fn test_variant_event_serialization() {
        // 测试 variant_start 事件序列化
        let event = BackendEvent::variant_start(0, "msg_001", "var_001", "gpt-4");
        let json = serde_json::to_string(&event).unwrap();

        assert!(json.contains("\"sequenceId\":0"));
        assert!(json.contains("\"type\":\"variant_start\""));
        assert!(json.contains("\"variantId\":\"var_001\""));
        assert!(json.contains("\"modelId\":\"gpt-4\""));
        assert!(json.contains("\"messageId\":\"msg_001\""));

        // 测试 variant_end 事件序列化
        let event2 = BackendEvent::variant_end(5, "var_001", "success", None, None);
        let json2 = serde_json::to_string(&event2).unwrap();

        assert!(json2.contains("\"sequenceId\":5"));
        assert!(json2.contains("\"type\":\"variant_end\""));
        assert!(json2.contains("\"status\":\"success\""));
        assert!(!json2.contains("\"error\""));
        assert!(!json2.contains("\"usage\"")); // usage 为 None 时不序列化
    }
}
