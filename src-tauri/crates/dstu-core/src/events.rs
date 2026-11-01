//! Chat V2 事件名常量（与前端 eventRegistry 注册的类型一致的字符串契约）。
//!
//! 抽到 core 是因为 14 个 tools 文件与 `executor.rs` 只用到这些常量，不应为此
//! 依赖 agent/tauri。旧路径 `chat_v2::events`、`chat_v2::{event_types, ...}`
//! 通过 `pub use` 继续可用。

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
    /// 灵感召回（Insight Recall v2 阶段二，范式 A：实时即类型块）
    pub const INSIGHT_RECALL: &str = "insight_recall";
    pub const ANKI_CARDS: &str = "anki_cards";
    /// 🆕 AI 出题预览块（2026-09-09 D2）
    pub const QBANK_QUESTIONS: &str = "qbank_questions";
    /// 结构化 UI 意图（Generative UI）
    pub const GENERATIVE_UI: &str = "generative_ui";

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

    // ========== Plan gate（Ask/Plan/Craft 会话档）==========
    /// Plan 模式写工具挂起：等待用户确认计划批次（区别于普通 tool_approval）
    pub const PLAN_GATE: &str = "plan_gate";

    // ========== 系统提示事件 ==========
    /// 工具递归限制提示（达到最大递归次数时）
    pub const TOOL_LIMIT: &str = "tool_limit";
    /// 技能瞬态注入审计（hidden transient skill messages）
    pub const SKILL_INJECTION_AUDIT: &str = "skill_injection_audit";
    /// 🆕 工作区消息注入（契约 C11：主代理插话在子代理对话中实时渲染）
    pub const WORKSPACE_INJECTION: &str = "workspace_injection";
}

// ============================================================
// 会话事件类型常量
// ============================================================

/// 会话级事件类型常量
pub mod session_event_type {
    /// 流式生成开始
    pub const STREAM_START: &str = "stream_start";
    /// 流式生成重连/重试
    pub const STREAM_RECONNECT: &str = "stream_reconnect";
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
    /// 摘要更新（包含标题和简介）
    ///
    /// 注：原 `title_updated` 事件已废弃 —— 自动生成路径从未发射，
    /// 所有标题/简介更新统一走 `summary_updated`。
    pub const SUMMARY_UPDATED: &str = "summary_updated";
    /// Automatic compaction owns the session lock; renderer shows persistent progress.
    pub const COMPACTION_STARTED: &str = "compaction_started";
    /// Clears progress on every exit, including skipped, cancelled and dropped futures.
    pub const COMPACTION_FINISHED: &str = "compaction_finished";
    /// 🆕 自动压缩失败/被放弃（payload: {"reason": "<code>"}）
    /// 仅自动触发（检查点/兜底）路径发射；手动压缩结果走命令返回值。
    pub const COMPACTION_FAILED: &str = "compaction_failed";
    /// 🆕 压缩已落盘（payload: {"tokensBefore": N|null, "tokensAfter": M|null}）。
    /// 自动与手动路径成功落盘后都发射；前端据此立即刷新上下文水位环，
    /// 不必等下一轮回复的真实 usage。
    pub const COMPACTION_COMPLETED: &str = "compaction_completed";
    /// 🆕 FIFO 截断实际丢弃了历史消息
    /// （payload: {"droppedMessages": N, "estimatedDroppedTokens": M}）
    pub const CONTEXT_TRIMMED: &str = "context_trimmed";
    /// 🆕 Goal 模式（P0）：会话目标变更
    /// （payload: {"eventType":"goal_updated","sessionId":"...","goal": GoalRecord | null}，
    /// goal 为 null 表示目标已清除）
    pub const GOAL_UPDATED: &str = "goal_updated";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_type_strings_stay_wire_stable() {
        assert_eq!(event_types::TOOL_CALL, "tool_call");
        assert_eq!(event_types::TOOL_APPROVAL_REQUEST, "tool_approval_request");
        assert_eq!(session_event_type::GOAL_UPDATED, "goal_updated");
        assert_eq!(event_phase::START, "start");
    }
}
