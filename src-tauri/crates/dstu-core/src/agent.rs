//! Agent 消息/工具调用的纯数据类型。
//!
//! 这里是 60+ 个工具执行器共享的形状定义（`ToolCall`、`ToolResultInfo`、
//! `MessageBlock`、`Citation`、`ToolScope`）以及块类型/状态常量。它们不依赖
//! tauri、数据库或任何上层模块；数据库读写行为留在 agent/app。
//!
//! 旧路径 `chat_v2::types`、`chat_v2::grants` 通过 `pub use` 继续可用。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ============================================================================
// 常量模块
// ============================================================================

/// 块类型字符串常量（与前端 BlockType 完全对齐）
pub mod block_types {
    // 流式内容块
    pub const THINKING: &str = "thinking";
    pub const CONTENT: &str = "content";

    pub const RAG: &str = "rag";
    pub const MEMORY: &str = "memory";
    pub const GRAPH: &str = "graph";
    pub const WEB_SEARCH: &str = "web_search";
    pub const MULTIMODAL_RAG: &str = "multimodal_rag";
    /// 灵感召回块（Insight Recall v2，披露级内容随升级就地更新）
    pub const INSIGHT_RECALL: &str = "insight_recall";

    pub const ACADEMIC_SEARCH: &str = "academic_search";
    pub const MCP_TOOL: &str = "mcp_tool";
    pub const IMAGE_GEN: &str = "image_gen";

    // 特殊功能块
    pub const ANKI_CARDS: &str = "anki_cards";
    /// 🆕 AI 出题预览块（2026-09-09 D2）：对话内可勾选草稿 + 一键入库
    pub const QBANK_QUESTIONS: &str = "qbank_questions";

    // 🆕 多代理协作块
    /// 主代理睡眠块（等待子代理完成）
    pub const SLEEP: &str = "sleep";
    /// 子代理嵌入块（在主代理消息中嵌入子代理聊天）
    pub const SUBAGENT_EMBED: &str = "subagent_embed";

    // 系统提示块
    /// 工具递归限制提示块（达到最大递归次数时创建）
    pub const TOOL_LIMIT: &str = "tool_limit";

    // 后端扩展（前端暂无，可通过 string 扩展）
    pub const OCR_RESULT: &str = "ocr_result";
    pub const SUMMARY: &str = "summary";
    /// 🆕 P1: 上下文压缩摘要块（每次 compaction 生成一条）
    pub const COMPACTION_SUMMARY: &str = "compaction_summary";

    // 🆕 用户提问块
    pub const ASK_USER: &str = "ask_user";

    /// 结构化 UI 意图块（Generative UI 桥接）
    pub const GENERATIVE_UI: &str = "generative_ui";

    // ACR R1-01：工作台操作工具卡（前端 remap workbench_* → 此块类型）
    pub const WORKBENCH_OPS: &str = "workbench_ops";

    // 🆕 主代理→子代理消息链路（契约 C11/缺口 2）
    /// 工作区消息注入块（注入内容持久化 + 前端渲染"主代理插话"）
    pub const WORKSPACE_INJECTION: &str = "workspace_injection";
    /// workspace_send 工具专属块（历史加载与前端实时块类型对齐）
    pub const WORKSPACE_SEND: &str = "workspace_send";
}

/// 块状态字符串常量（与前端 BlockStatus 完全对齐）
pub mod block_status {
    pub const PENDING: &str = "pending";
    pub const RUNNING: &str = "running";
    pub const SUCCESS: &str = "success";
    pub const ERROR: &str = "error";
}

// ============================================================================
// 委派授权范围（纯数据）
// ============================================================================

/// 类型化工具授权范围。
///
/// 匹配逻辑（白名单条目匹配、注册表 hint 推导）依赖 chat_v2 的
/// `tool_policy` / `tool_descriptors`，因此留在 `chat_v2::grants` 的
/// `ToolScopeExt` 扩展 trait 上；这里只保留可跨 crate 共享的数据形状。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ToolScope {
    /// 内建工具（`builtin-*` / `builtin:*` / 裸名条目）。
    Builtin { name: String },
    /// MCP 工具。`server` 非空时等价白名单的 `server::tool` 显式源限定条目；
    /// 为空时表示 `mcp_*` 命名空间条目（未限定服务器）。
    Mcp { server: String, tool: String },
    /// Shell 命令前缀授权（P1 占位：恒不匹配——worker 白名单无 shell 条目，
    /// fail-closed；P2 参照 TrustedAutomationProfile.shell_command_prefixes 接线）。
    Shell { prefixes: Vec<String> },
}

// ============================================================================
// 工具调用类型
// ============================================================================

/// 工具调用请求（LLM 返回的工具调用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// 工具调用 ID（由 LLM 生成，用于关联结果）
    pub id: String,

    /// 工具名称
    pub name: String,

    /// 工具输入参数
    pub arguments: Value,
}

impl ToolCall {
    /// 创建新的工具调用
    pub fn new(id: String, name: String, arguments: Value) -> Self {
        Self {
            id,
            name,
            arguments,
        }
    }
}

/// 工具调用结果（与前端 ToolResult 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultInfo {
    /// 工具调用 ID（关联 ToolCall.id）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,

    /// 🔧 P0修复：工具块 ID（用于持久化时与前端事件对齐）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,

    /// 工具名称
    pub tool_name: String,

    /// 工具输入
    pub input: Value,

    /// 工具输出
    pub output: Value,

    /// 是否成功
    pub success: bool,

    /// 错误信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    /// 执行耗时（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,

    /// 🔧 思维链修复：该轮工具调用对应的 reasoning_content
    /// 用于在多轮工具调用中保留每轮的思维链，确保完整回传给 LLM
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,

    /// 🔧 Gemini 3 思维签名：工具调用场景必需
    /// API 返回的 thoughtSignature 需要在后续请求中回传，否则 Gemini 3 返回 400 错误
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

impl ToolResultInfo {
    /// #469：有对应工具块时清空 input/output（块表已存同一份数据），只保留
    /// 重放所需的轻量字段。无 block_id 的条目没有别处可取，原样保留。
    pub fn strip_payload_backed_by_block(&mut self) {
        if self.block_id.as_deref().is_some_and(|id| !id.is_empty()) {
            self.input = Value::Null;
            self.output = Value::Null;
        }
    }

    /// 创建成功结果
    pub fn success(
        tool_call_id: Option<String>,
        block_id: Option<String>,
        tool_name: String,
        input: Value,
        output: Value,
        duration_ms: u64,
    ) -> Self {
        Self {
            tool_call_id,
            block_id,
            tool_name,
            input,
            output,
            success: true,
            error: None,
            duration_ms: Some(duration_ms),
            reasoning_content: None, // 稍后通过 with_reasoning 设置
            thought_signature: None,
        }
    }

    /// 创建失败结果
    pub fn failure(
        tool_call_id: Option<String>,
        block_id: Option<String>,
        tool_name: String,
        input: Value,
        error: String,
        duration_ms: u64,
    ) -> Self {
        Self {
            tool_call_id,
            block_id,
            tool_name,
            input,
            output: Value::Null,
            success: false,
            error: Some(error),
            duration_ms: Some(duration_ms),
            reasoning_content: None, // 稍后通过 with_reasoning 设置
            thought_signature: None,
        }
    }

    /// Create a failed tool result while preserving structured diagnostics.
    ///
    /// Use this when a tool has a machine-readable error payload that the UI
    /// and model still need (for example partial/rejected batch results).
    pub fn failure_with_output(
        tool_call_id: Option<String>,
        block_id: Option<String>,
        tool_name: String,
        input: Value,
        output: Value,
        error: String,
        duration_ms: u64,
    ) -> Self {
        Self {
            tool_call_id,
            block_id,
            tool_name,
            input,
            output,
            success: false,
            error: Some(error),
            duration_ms: Some(duration_ms),
            reasoning_content: None,
            thought_signature: None,
        }
    }

    /// 设置该工具调用对应的思维链内容
    pub fn with_reasoning(mut self, reasoning: Option<String>) -> Self {
        self.reasoning_content = reasoning;
        self
    }

    /// 🆕 创建取消结果
    ///
    /// 当工具执行被取消时使用此方法创建结果。
    /// 取消被视为失败，但错误信息明确标识为取消操作。
    pub fn cancelled(
        tool_call_id: Option<String>,
        block_id: Option<String>,
        tool_name: String,
        input: Value,
        duration_ms: u64,
    ) -> Self {
        Self {
            tool_call_id,
            block_id,
            tool_name,
            input,
            output: Value::Null,
            success: false,
            error: Some("Tool execution was cancelled".to_string()),
            duration_ms: Some(duration_ms),
            reasoning_content: None,
            thought_signature: None,
        }
    }
}

// ============================================================================
// 块相关类型
// ============================================================================

/// 块结构（与前端 Block 接口对齐）
///
/// 注意：前端字段名使用 camelCase，serde 自动转换
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBlock {
    /// 块 ID（格式：blk_{uuid}）
    pub id: String,

    /// 所属消息 ID
    pub message_id: String,

    /// 块类型（前端字段名是 type，不是 blockType）
    #[serde(rename = "type")]
    pub block_type: String,

    /// 块状态
    pub status: String,

    // ========== 流式内容 ==========
    /// 流式内容（thinking/content 等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,

    // ========== 工具调用专用 ==========
    /// 工具名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,

    /// 工具输入参数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,

    /// 工具输出结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_output: Option<Value>,

    // ========== 知识检索专用 ==========
    /// 引用来源列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citations: Option<Vec<Citation>>,

    // ========== 错误信息 ==========
    /// 错误描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    // ========== 时间戳 ==========
    /// 块创建/开始时间（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,

    /// 块结束时间（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,

    /// 第一个有效 chunk 到达时间（毫秒，用于精确排序）
    ///
    /// 解决刷新后思维链块被置顶的问题。
    /// 记录块第一次收到有效内容的时间戳，加载时按此排序。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_chunk_at: Option<i64>,

    // ========== 后端专用字段 ==========
    /// 块顺序（前端通过 message.blockIds 顺序确定，不序列化到前端）
    #[serde(skip_serializing, default)]
    pub block_index: u32,
}

impl MessageBlock {
    /// 生成块 ID
    pub fn generate_id() -> String {
        format!("blk_{}", uuid::Uuid::new_v4())
    }

    /// 创建新块
    pub fn new(message_id: String, block_type: &str, block_index: u32) -> Self {
        Self {
            id: Self::generate_id(),
            message_id,
            block_type: block_type.to_string(),
            status: block_status::PENDING.to_string(),
            content: None,
            tool_name: None,
            tool_input: None,
            tool_output: None,
            citations: None,
            error: None,
            started_at: None,
            ended_at: None,
            first_chunk_at: None,
            block_index,
        }
    }

    /// 创建内容块
    pub fn new_content(message_id: String, block_index: u32) -> Self {
        Self::new(message_id, block_types::CONTENT, block_index)
    }

    /// 创建思维链块
    pub fn new_thinking(message_id: String, block_index: u32) -> Self {
        Self::new(message_id, block_types::THINKING, block_index)
    }

    /// 创建工具调用块
    pub fn new_tool(
        message_id: String,
        tool_name: &str,
        tool_input: Value,
        block_index: u32,
    ) -> Self {
        let mut block = Self::new(message_id, block_types::MCP_TOOL, block_index);
        block.tool_name = Some(tool_name.to_string());
        block.tool_input = Some(tool_input);
        block
    }

    /// 设置状态为运行中
    pub fn set_running(&mut self) {
        self.status = block_status::RUNNING.to_string();
        self.started_at = Some(Utc::now().timestamp_millis());
    }

    /// 设置状态为成功
    pub fn set_success(&mut self) {
        self.status = block_status::SUCCESS.to_string();
        self.ended_at = Some(Utc::now().timestamp_millis());
    }

    /// 设置状态为错误
    pub fn set_error(&mut self, error: &str) {
        self.status = block_status::ERROR.to_string();
        self.error = Some(error.to_string());
        self.ended_at = Some(Utc::now().timestamp_millis());
    }

    /// 追加内容
    ///
    /// 当第一个有效 chunk 到达时，自动设置 `first_chunk_at` 时间戳。
    /// 此时间戳用于块的精确排序，解决刷新后思维链块被置顶的问题。
    pub fn append_content(&mut self, chunk: &str) {
        // 🔧 设置 first_chunk_at（仅当第一次追加非空内容时）
        if self.first_chunk_at.is_none() && !chunk.is_empty() {
            self.first_chunk_at = Some(Utc::now().timestamp_millis());
        }

        if let Some(ref mut content) = self.content {
            content.push_str(chunk);
        } else {
            self.content = Some(chunk.to_string());
        }
    }
}

/// 引用来源（与前端 Citation 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    /// 来源类型（'rag' | 'memory' | 'graph' | 'web'）
    pub r#type: String,

    /// 来源标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 来源 URL 或文件路径
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,

    /// 来源内容片段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,

    /// 相关度分数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_block_starts_pending_and_records_first_chunk() {
        let mut block = MessageBlock::new("msg_1".to_string(), block_types::CONTENT, 0);
        assert_eq!(block.status, block_status::PENDING);
        block.append_content("hello");
        assert_eq!(block.content.as_deref(), Some("hello"));
        assert!(block.first_chunk_at.is_some());
        block.set_success();
        assert_eq!(block.status, block_status::SUCCESS);
        assert!(block.ended_at.is_some());
    }

    #[test]
    fn tool_result_info_strip_payload_requires_block_id() {
        let mut with_block = ToolResultInfo::success(
            Some("call_1".to_string()),
            Some("blk_1".to_string()),
            "tool".to_string(),
            serde_json::json!({"a": 1}),
            serde_json::json!({"b": 2}),
            1,
        );
        with_block.strip_payload_backed_by_block();
        assert_eq!(with_block.input, Value::Null);
        assert_eq!(with_block.output, Value::Null);

        let mut without_block = ToolResultInfo::success(
            None,
            None,
            "tool".to_string(),
            serde_json::json!({"a": 1}),
            serde_json::json!({"b": 2}),
            1,
        );
        without_block.strip_payload_backed_by_block();
        assert_eq!(without_block.input, serde_json::json!({"a": 1}));
    }

    #[test]
    fn tool_scope_serializes_with_kind_tag() {
        let scope = ToolScope::Mcp {
            server: "server-a".to_string(),
            tool: "fetch".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&scope).unwrap(),
            serde_json::json!({"kind": "mcp", "server": "server-a", "tool": "fetch"})
        );
    }
}
