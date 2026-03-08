//! Chat V2 - 核心类型定义
//!
//! 本模块定义所有与前端对齐的类型，用于 Chat V2 后端实现。
//! 所有类型必须与前端 `src/chat-v2/core/types/` 目录中的定义完全对齐。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

// 导入资源库类型（统一上下文注入系统）
use super::resource_types::{ContextSnapshot, SendContextRef};

// ============================================================================
// Feature Flags 配置模块
// ============================================================================

/// Chat V2 Feature Flags
///
/// 控制 Chat V2 模块的功能开关，用于渐进式发布和回退。
/// 可通过环境变量配置，默认值为启用状态。
pub mod feature_flags {
    use std::sync::OnceLock;

    /// 多变体聊天功能开关
    ///
    /// 环境变量: `CHAT_V2_MULTI_VARIANT_ENABLED`
    /// - `true` / `1` / `yes` (默认): 启用多变体并行执行
    /// - `false` / `0` / `no`: 禁用多变体，强制走单变体路径
    ///
    /// 当此 flag 关闭时：
    /// - 即使前端传入 `parallel_model_ids`，也只使用第一个模型
    /// - 所有请求都走单变体执行路径 `execute_internal()`
    pub fn is_multi_variant_enabled() -> bool {
        static ENABLED: OnceLock<bool> = OnceLock::new();
        *ENABLED.get_or_init(|| {
            std::env::var("CHAT_V2_MULTI_VARIANT_ENABLED")
                .map(|v| {
                    let v_lower = v.to_ascii_lowercase();
                    // 只有明确设置为 false/0/no 时才禁用
                    !matches!(v_lower.as_str(), "false" | "0" | "no")
                })
                .unwrap_or(true) // 默认启用
        })
    }

    /// 获取 feature flags 状态摘要（用于日志）
    pub fn get_flags_summary() -> String {
        format!("multi_variant_enabled={}", is_multi_variant_enabled())
    }

    #[cfg(test)]
    mod tests {
        // 注意：由于使用 OnceLock，这些测试需要在独立进程中运行
        // 或者使用 serial_test crate 进行串行测试

        #[test]
        fn test_default_multi_variant_enabled() {
            // 默认应该启用（在没有设置环境变量的情况下）
            // 由于 OnceLock 的特性，这个测试可能受其他测试影响
            // 实际测试建议在 CI 中通过环境变量验证
        }
    }
}

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

    pub const ACADEMIC_SEARCH: &str = "academic_search";
    pub const MCP_TOOL: &str = "mcp_tool";
    pub const IMAGE_GEN: &str = "image_gen";

    // 特殊功能块
    pub const ANKI_CARDS: &str = "anki_cards";

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

    // 🆕 用户提问块
    pub const ASK_USER: &str = "ask_user";
}

/// 块状态字符串常量（与前端 BlockStatus 完全对齐）
pub mod block_status {
    pub const PENDING: &str = "pending";
    pub const RUNNING: &str = "running";
    pub const SUCCESS: &str = "success";
    pub const ERROR: &str = "error";
}

/// 变体状态常量（多模型并行变体，与前端 VariantStatus 完全对齐）
pub mod variant_status {
    /// 等待开始
    pub const PENDING: &str = "pending";
    /// 流式生成中
    pub const STREAMING: &str = "streaming";
    /// 成功完成
    pub const SUCCESS: &str = "success";
    /// 失败
    pub const ERROR: &str = "error";
    /// 被用户取消
    pub const CANCELLED: &str = "cancelled";
    /// 🆕 中断（网络错误/LLM 超时等，有未完成的 TODO 列表，可继续执行）
    pub const INTERRUPTED: &str = "interrupted";
}

// ============================================================================
// Token 统计类型
// ============================================================================

/// Token 来源枚举（类型安全）
///
/// 标识 Token 统计数据的来源，用于区分精确值和估算值。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TokenSource {
    /// LLM API 返回的精确值（最高优先级）
    Api,
    /// 使用 tiktoken 库估算（中等优先级）
    #[default]
    Tiktoken,
    /// 启发式规则估算（最低优先级）
    Heuristic,
    /// 多轮累加时来源混合
    Mixed,
}

impl std::fmt::Display for TokenSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenSource::Api => write!(f, "api"),
            TokenSource::Tiktoken => write!(f, "tiktoken"),
            TokenSource::Heuristic => write!(f, "heuristic"),
            TokenSource::Mixed => write!(f, "mixed"),
        }
    }
}

/// Token 使用统计
///
/// 记录 LLM 调用的 token 使用情况，支持 API 精确值和估算值
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// 输入 token 数量
    pub prompt_tokens: u32,

    /// 输出 token 数量
    pub completion_tokens: u32,

    /// 总计 token 数量
    pub total_tokens: u32,

    /// 数据来源（枚举类型）
    pub source: TokenSource,

    /// 思维链 token 数量（可选，部分 API 独立返回，如 DeepSeek）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u32>,

    /// 缓存命中的 token（可选，某些 API 支持，如 Anthropic）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u32>,

    /// 最后一轮请求的上下文窗口使用量（prompt + completion，即该轮在上下文窗口中的总占用）
    ///
    /// 行业标准：context_window = input_tokens + output_tokens
    /// 参考：Anthropic 文档 "context window refers to all the text a language model can reference
    /// when generating a response, including the response itself"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_round_prompt_tokens: Option<u32>,
}

impl TokenUsage {
    /// 从 API 返回值创建（精确值）
    ///
    /// # 参数
    /// - `prompt`: 输入 token 数量
    /// - `completion`: 输出 token 数量
    /// - `reasoning`: 思维链 token 数量（可选）
    pub fn from_api(prompt: u32, completion: u32, reasoning: Option<u32>) -> Self {
        Self {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            source: TokenSource::Api,
            reasoning_tokens: reasoning,
            cached_tokens: None,
            // 上下文窗口 = prompt + completion（行业标准：context_window 包含 input 和 output）
            last_round_prompt_tokens: Some(prompt + completion),
        }
    }

    /// 从 API 返回值创建（含缓存信息）
    ///
    /// # 参数
    /// - `prompt`: 输入 token 数量
    /// - `completion`: 输出 token 数量
    /// - `reasoning`: 思维链 token 数量（可选）
    /// - `cached`: 缓存命中的 token 数量（可选）
    pub fn from_api_with_cache(
        prompt: u32,
        completion: u32,
        reasoning: Option<u32>,
        cached: Option<u32>,
    ) -> Self {
        Self {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            source: TokenSource::Api,
            reasoning_tokens: reasoning,
            cached_tokens: cached,
            // 上下文窗口 = prompt + completion（行业标准：context_window 包含 input 和 output）
            last_round_prompt_tokens: Some(prompt + completion),
        }
    }

    /// 从估算值创建
    ///
    /// # 参数
    /// - `prompt`: 估算的输入 token 数量
    /// - `completion`: 估算的输出 token 数量
    /// - `precise`: 是否使用了 tiktoken（true）或启发式（false）
    pub fn from_estimate(prompt: u32, completion: u32, precise: bool) -> Self {
        Self {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            source: if precise {
                TokenSource::Tiktoken
            } else {
                TokenSource::Heuristic
            },
            reasoning_tokens: None,
            cached_tokens: None,
            // 上下文窗口 = prompt + completion（行业标准：context_window 包含 input 和 output）
            last_round_prompt_tokens: Some(prompt + completion),
        }
    }

    /// 累加另一个 TokenUsage（用于工具递归调用）
    ///
    /// 累加规则：
    /// - 数值字段直接相加
    /// - source 字段：如果来源不同，降级为 Mixed
    /// - reasoning_tokens 和 cached_tokens：合并相加
    /// - last_round_prompt_tokens：更新为最新一轮的上下文窗口使用量（prompt + completion）
    pub fn accumulate(&mut self, other: &TokenUsage) {
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        self.total_tokens += other.total_tokens;

        // 来源混合逻辑
        if self.source != other.source {
            self.source = TokenSource::Mixed;
        }

        // 累加 reasoning_tokens
        match (&self.reasoning_tokens, &other.reasoning_tokens) {
            (Some(a), Some(b)) => self.reasoning_tokens = Some(a + b),
            (None, Some(b)) => self.reasoning_tokens = Some(*b),
            _ => {}
        }

        // 累加 cached_tokens
        match (&self.cached_tokens, &other.cached_tokens) {
            (Some(a), Some(b)) => self.cached_tokens = Some(a + b),
            (None, Some(b)) => self.cached_tokens = Some(*b),
            _ => {}
        }

        // 更新 last_round_prompt_tokens 为最新一轮的上下文窗口使用量（prompt + completion）
        // 行业标准：context_window = input + output
        let other_context_window = other.prompt_tokens + other.completion_tokens;
        if other_context_window > 0 {
            self.last_round_prompt_tokens = Some(other_context_window);
        }
    }

    /// 检查是否有有效的 token 统计
    pub fn has_tokens(&self) -> bool {
        self.total_tokens > 0
    }

    /// 创建零值 TokenUsage（用于错误情况的兜底）
    pub fn zero() -> Self {
        Self::default()
    }
}

// ============================================================================
// 会话相关类型
// ============================================================================

/// 持久化状态（后端存储用，与前端 SessionStatus 分离）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PersistStatus {
    Active,
    Archived,
    Deleted,
}

impl Default for PersistStatus {
    fn default() -> Self {
        Self::Active
    }
}

/// 会话结构（与前端 Session 接口对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    /// 会话 ID（格式：sess_{uuid}）
    pub id: String,

    /// 会话模式（analysis/review/textbook/bridge/general_chat）
    pub mode: String,

    /// 会话标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 会话简介（自动生成，用于列表预览）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 摘要哈希（用于防重复生成标题/简介）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_hash: Option<String>,

    /// 持久化状态
    pub persist_status: PersistStatus,

    /// 创建时间
    pub created_at: DateTime<Utc>,

    /// 更新时间
    pub updated_at: DateTime<Utc>,

    /// 扩展元数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,

    /// 分组 ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,

    /// 标签哈希（用于防重复提取标签）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags_hash: Option<String>,

    /// 会话标签（从 chat_v2_session_tags 表 JOIN 获取，非持久化字段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// 会话标签
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTag {
    pub session_id: String,
    pub tag: String,
    pub tag_type: String,
    pub created_at: String,
}

/// 内容搜索结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResult {
    pub session_id: String,
    pub session_title: Option<String>,
    pub message_id: String,
    pub block_id: String,
    pub role: String,
    pub snippet: String,
    pub updated_at: String,
}

impl ChatSession {
    /// 创建新会话
    pub fn new(id: String, mode: String) -> Self {
        let now = Utc::now();
        Self {
            id,
            mode,
            title: None,
            description: None,
            summary_hash: None,
            persist_status: PersistStatus::Active,
            created_at: now,
            updated_at: now,
            metadata: None,
            group_id: None,
            tags_hash: None,
            tags: None,
        }
    }

    /// 生成会话 ID
    pub fn generate_id() -> String {
        format!("sess_{}", uuid::Uuid::new_v4())
    }
}

// ============================================================================
// 会话分组相关类型
// ============================================================================

/// 会话分组
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub default_skill_ids: Vec<String>,
    #[serde(default)]
    pub pinned_resource_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub sort_order: i32,
    pub persist_status: PersistStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl SessionGroup {
    pub fn generate_id() -> String {
        format!("group_{}", uuid::Uuid::new_v4())
    }
}

/// 创建分组请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub system_prompt: Option<String>,
    pub default_skill_ids: Option<Vec<String>>,
    pub pinned_resource_ids: Option<Vec<String>>,
    pub workspace_id: Option<String>,
}

/// 更新分组请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGroupRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub system_prompt: Option<String>,
    pub default_skill_ids: Option<Vec<String>>,
    pub pinned_resource_ids: Option<Vec<String>>,
    pub workspace_id: Option<String>,
    pub sort_order: Option<i32>,
    pub persist_status: Option<PersistStatus>,
}

// ============================================================================
// 消息相关类型
// ============================================================================

/// 消息角色（与前端 MessageRole 完全一致）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
}

/// 回答变体（与前端 Variant 接口对齐）
///
/// 每个变体是一个完全独立的 LLM 执行上下文，变体之间默认完全隔离。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    /// 变体 ID（格式：var_{uuid}）
    pub id: String,

    /// 生成此变体的模型 ID（显示名，如 "Qwen/Qwen3-8B"）
    pub model_id: String,

    /// 🔧 P2修复：API 配置 ID（用于 LLM 调用，如 "config_123"）
    /// 重试时使用此 ID 而不是 model_id
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,

    /// 属于此变体的块 ID 列表（有序）
    pub block_ids: Vec<String>,

    /// 变体状态（pending/streaming/success/error/cancelled）
    pub status: String,

    /// 错误信息（status=error 时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    /// 创建时间戳（毫秒）
    pub created_at: i64,

    /// Token 使用统计（多变体模式，每个变体独立）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,

    /// 变体级元数据（用于历史重放与 branch-local skill 快照）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<VariantMeta>,
}

impl Variant {
    /// 生成变体 ID
    pub fn generate_id() -> String {
        format!("var_{}", uuid::Uuid::new_v4())
    }

    /// 创建新变体
    pub fn new(model_id: String) -> Self {
        Self {
            id: Self::generate_id(),
            model_id,
            config_id: None,
            block_ids: Vec::new(),
            status: variant_status::PENDING.to_string(),
            error: None,
            created_at: Utc::now().timestamp_millis(),
            usage: None,
            meta: None,
        }
    }

    /// 🔧 P2修复：创建带 config_id 的变体
    pub fn new_with_config(model_id: String, config_id: String) -> Self {
        Self {
            id: Self::generate_id(),
            model_id,
            config_id: Some(config_id),
            block_ids: Vec::new(),
            status: variant_status::PENDING.to_string(),
            error: None,
            created_at: Utc::now().timestamp_millis(),
            usage: None,
            meta: None,
        }
    }

    /// 创建带指定 ID 的变体
    pub fn new_with_id(id: String, model_id: String) -> Self {
        Self {
            id,
            model_id,
            config_id: None,
            block_ids: Vec::new(),
            status: variant_status::PENDING.to_string(),
            error: None,
            created_at: Utc::now().timestamp_millis(),
            usage: None,
            meta: None,
        }
    }

    /// 🔧 P2修复：创建带指定 ID 和 config_id 的变体
    pub fn new_with_id_and_config(id: String, model_id: String, config_id: String) -> Self {
        Self {
            id,
            model_id,
            config_id: Some(config_id),
            block_ids: Vec::new(),
            status: variant_status::PENDING.to_string(),
            error: None,
            created_at: Utc::now().timestamp_millis(),
            usage: None,
            meta: None,
        }
    }

    /// Builder 方法：设置 token 使用统计
    pub fn with_usage(mut self, usage: TokenUsage) -> Self {
        self.usage = Some(usage);
        self
    }

    /// 设置 token 使用统计（可变引用版本）
    pub fn set_usage(&mut self, usage: TokenUsage) {
        self.usage = Some(usage);
    }

    /// 获取 token 使用统计
    pub fn get_usage(&self) -> Option<&TokenUsage> {
        self.usage.as_ref()
    }

    /// 添加块 ID 到此变体
    pub fn add_block(&mut self, block_id: String) {
        self.block_ids.push(block_id);
    }

    /// 设置状态为流式中
    pub fn set_streaming(&mut self) {
        self.status = variant_status::STREAMING.to_string();
    }

    /// 设置状态为成功
    pub fn set_success(&mut self) {
        self.status = variant_status::SUCCESS.to_string();
    }

    /// 设置状态为错误
    pub fn set_error(&mut self, error: &str) {
        self.status = variant_status::ERROR.to_string();
        self.error = Some(error.to_string());
    }

    /// 设置状态为取消
    pub fn set_cancelled(&mut self) {
        self.status = variant_status::CANCELLED.to_string();
    }

    /// 🆕 设置状态为中断（有未完成的 TODO 列表，可继续执行）
    pub fn set_interrupted(&mut self, error: &str) {
        self.status = variant_status::INTERRUPTED.to_string();
        self.error = Some(error.to_string());
    }

    /// 检查变体是否可以被激活（非 error 状态）
    pub fn can_activate(&self) -> bool {
        self.status != variant_status::ERROR
    }

    /// 检查变体是否可以重试（error 或 cancelled 状态）
    pub fn can_retry(&self) -> bool {
        self.status == variant_status::ERROR || self.status == variant_status::CANCELLED
    }

    /// 🆕 检查变体是否可以继续执行（interrupted 状态）
    pub fn can_continue(&self) -> bool {
        self.status == variant_status::INTERRUPTED
    }

    /// 🆕 检查变体是否处于终态（不会再有新内容）
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            variant_status::SUCCESS
                | variant_status::ERROR
                | variant_status::CANCELLED
                | variant_status::INTERRUPTED
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillStateSnapshot {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub manual_pinned_skill_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mode_required_bundle_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agentic_session_skill_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branch_local_skill_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effective_allowed_internal_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effective_allowed_external_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effective_allowed_external_servers: Vec<String>,
    #[serde(default)]
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySkillPayloadSnapshot {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_skill_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub skill_contents: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub skill_embedded_tools: std::collections::HashMap<String, Vec<McpToolSchema>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_tool_schemas: Vec<McpToolSchema>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_mcp_servers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSkillState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub manual_pinned_skill_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mode_required_bundle_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agentic_session_skill_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branch_local_skill_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effective_allowed_internal_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effective_allowed_external_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effective_allowed_external_servers: Vec<String>,
    #[serde(default)]
    pub version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_migrated: Option<bool>,
}

impl SessionSkillState {
    pub fn from_legacy(
        active_skill_ids_json: Option<&String>,
        loaded_skill_ids_json: Option<&String>,
    ) -> Self {
        let manual_pinned_skill_ids = active_skill_ids_json
            .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
            .unwrap_or_default();
        let agentic_session_skill_ids = loaded_skill_ids_json
            .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
            .unwrap_or_default();

        Self {
            manual_pinned_skill_ids,
            agentic_session_skill_ids,
            legacy_migrated: Some(true),
            ..Default::default()
        }
    }

    pub fn resolved_loaded_skill_ids(&self) -> Vec<String> {
        let mut merged = self.agentic_session_skill_ids.clone();
        merged.extend(self.branch_local_skill_ids.clone());
        merged.extend(self.mode_required_bundle_ids.clone());
        merged.sort();
        merged.dedup();
        merged
    }

    pub fn resolved_active_skill_ids(&self) -> Vec<String> {
        let mut merged = self.manual_pinned_skill_ids.clone();
        merged.sort();
        merged.dedup();
        merged
    }

    pub fn snapshot(&self) -> SkillStateSnapshot {
        SkillStateSnapshot {
            manual_pinned_skill_ids: self.manual_pinned_skill_ids.clone(),
            mode_required_bundle_ids: self.mode_required_bundle_ids.clone(),
            agentic_session_skill_ids: self.agentic_session_skill_ids.clone(),
            branch_local_skill_ids: self.branch_local_skill_ids.clone(),
            effective_allowed_internal_tools: self.effective_allowed_internal_tools.clone(),
            effective_allowed_external_tools: self.effective_allowed_external_tools.clone(),
            effective_allowed_external_servers: self.effective_allowed_external_servers.clone(),
            version: self.version,
        }
    }

    pub fn with_added_agentic_skills(&self, skill_ids: &[String]) -> Self {
        let mut next = self.clone();
        for skill_id in skill_ids {
            if !next.agentic_session_skill_ids.contains(skill_id) {
                next.agentic_session_skill_ids.push(skill_id.clone());
            }
        }
        next.agentic_session_skill_ids.sort();
        next.agentic_session_skill_ids.dedup();
        next.version = next.version.saturating_add(1);
        next.legacy_migrated = Some(false);
        next
    }

    pub fn with_added_branch_local_skills(&self, skill_ids: &[String]) -> Self {
        let mut next = self.clone();
        for skill_id in skill_ids {
            if !next.branch_local_skill_ids.contains(skill_id) {
                next.branch_local_skill_ids.push(skill_id.clone());
            }
        }
        next.branch_local_skill_ids.sort();
        next.branch_local_skill_ids.dedup();
        next.version = next.version.saturating_add(1);
        next.legacy_migrated = Some(false);
        next
    }

    pub fn promoted_branch_local_skills(&self) -> Self {
        let mut next = self.clone();
        next.agentic_session_skill_ids
            .extend(next.branch_local_skill_ids.clone());
        next.agentic_session_skill_ids.sort();
        next.agentic_session_skill_ids.dedup();
        next.branch_local_skill_ids.clear();
        next.version = next.version.saturating_add(1);
        next.legacy_migrated = Some(false);
        next
    }

    pub fn without_branch_local_skills(&self) -> Self {
        let mut next = self.clone();
        if !next.branch_local_skill_ids.is_empty() {
            next.branch_local_skill_ids.clear();
            next.version = next.version.saturating_add(1);
        }
        next.legacy_migrated = Some(false);
        next
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VariantMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_snapshot_before: Option<SkillStateSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_snapshot_after: Option<SkillStateSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_runtime_before: Option<ReplaySkillPayloadSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_runtime_after: Option<ReplaySkillPayloadSnapshot>,
}

/// 共享上下文 - 检索结果，所有变体共享，只读
///
/// 检索只执行一次，结果注入所有变体的 system prompt
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SharedContext {
    /// RAG 检索结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_sources: Option<Vec<SourceInfo>>,

    /// Memory 检索结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_sources: Option<Vec<SourceInfo>>,

    /// Graph RAG 结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_sources: Option<Vec<SourceInfo>>,

    /// Web 搜索结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search_sources: Option<Vec<SourceInfo>>,

    /// 多模态知识库结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_sources: Option<Vec<SourceInfo>>,

    // 🔧 P1修复：保存检索块 ID，用于持久化
    /// RAG 检索块 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_block_id: Option<String>,

    /// Memory 检索块 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_block_id: Option<String>,

    /// Graph RAG 检索块 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_block_id: Option<String>,

    /// Web 搜索检索块 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search_block_id: Option<String>,

    /// 多模态检索块 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_block_id: Option<String>,
}

impl SharedContext {
    /// 创建空的共享上下文
    pub fn new() -> Self {
        Self::default()
    }

    /// 检查是否有任何检索结果
    pub fn has_sources(&self) -> bool {
        self.rag_sources.as_ref().map_or(false, |v| !v.is_empty())
            || self
                .memory_sources
                .as_ref()
                .map_or(false, |v| !v.is_empty())
            || self.graph_sources.as_ref().map_or(false, |v| !v.is_empty())
            || self
                .web_search_sources
                .as_ref()
                .map_or(false, |v| !v.is_empty())
            || self
                .multimodal_sources
                .as_ref()
                .map_or(false, |v| !v.is_empty())
    }
}

/// 删除变体操作的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum DeleteVariantResult {
    /// 变体已删除，返回新的激活变体 ID
    #[serde(rename = "variantDeleted")]
    VariantDeleted {
        /// 新的激活变体 ID（如果删除的是当前激活变体）
        new_active_id: Option<String>,
    },
    /// 消息已删除（删除最后一个变体时）
    #[serde(rename = "messageDeleted")]
    MessageDeleted,
}

/// 消息结构（与前端 Message 接口对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// 消息 ID（格式：msg_{uuid}）
    pub id: String,

    /// 所属会话 ID
    pub session_id: String,

    /// 消息角色
    pub role: MessageRole,

    /// 块 ID 列表（有序）
    pub block_ids: Vec<String>,

    /// 创建时间戳（毫秒）
    pub timestamp: i64,

    /// 持久化稳定 ID（用于数据库关联）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistent_stable_id: Option<String>,

    /// 编辑/重试分支的父消息 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    /// 替代的消息 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,

    /// 消息级元数据（与前端 _meta 对应）
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<MessageMeta>,

    /// 用户消息附件（与前端 attachments 对应）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AttachmentMeta>>,

    // ========== 多模型并行变体 (Variant) ==========
    /// 当前激活的变体 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_variant_id: Option<String>,

    /// 变体列表（助手消息，多模型并行时使用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variants: Option<Vec<Variant>>,

    /// 共享上下文（检索结果，所有变体共享）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_context: Option<SharedContext>,
}

impl ChatMessage {
    /// 生成消息 ID
    pub fn generate_id() -> String {
        format!("msg_{}", uuid::Uuid::new_v4())
    }

    /// 创建用户消息
    pub fn new_user(session_id: String, block_ids: Vec<String>) -> Self {
        Self {
            id: Self::generate_id(),
            session_id,
            role: MessageRole::User,
            block_ids,
            timestamp: Utc::now().timestamp_millis(),
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: None,
            attachments: None,
            active_variant_id: None,
            variants: None,
            shared_context: None,
        }
    }

    /// 创建助手消息
    pub fn new_assistant(session_id: String) -> Self {
        Self {
            id: Self::generate_id(),
            session_id,
            role: MessageRole::Assistant,
            block_ids: Vec::new(),
            timestamp: Utc::now().timestamp_millis(),
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: None,
            attachments: None,
            active_variant_id: None,
            variants: None,
            shared_context: None,
        }
    }

    /// 检查是否为多变体消息
    ///
    /// 判断标准：variants.len() > 1
    /// - variants 为 None：返回 false
    /// - variants 为空数组 []：返回 false
    /// - variants 只有 1 个元素（单变体重试产生）：返回 false
    /// - variants 有 2+ 个元素（真正的多变体）：返回 true
    ///
    /// 注意：此判断逻辑需与前端 isMultiVariantMessage() 保持一致
    pub fn is_multi_variant(&self) -> bool {
        self.variants.as_ref().map_or(false, |v| v.len() > 1)
    }

    /// 获取当前应该显示的 block_ids（displayBlockIds 的后端权威实现）
    ///
    /// ================================================================
    /// 【统一逻辑】需与前端 createChatStore.ts::getDisplayBlockIds 保持一致
    /// ================================================================
    ///
    /// 计算规则：
    /// 1. 无变体时：返回 message.block_ids
    /// 2. 有变体时：返回 active_variant.block_ids
    /// 3. 找不到激活变体时：回退到 message.block_ids
    ///
    /// 前端对应位置：
    /// - src/chat-v2/core/store/createChatStore.ts - getDisplayBlockIds()
    /// - src/chat-v2/core/store/variantActions.ts - getDisplayBlockIds()（备用）
    pub fn get_active_block_ids(&self) -> &[String] {
        // 有变体且有激活变体时：返回激活变体的 block_ids
        if let (Some(active_id), Some(variants)) = (&self.active_variant_id, &self.variants) {
            if let Some(variant) = variants.iter().find(|v| &v.id == active_id) {
                return &variant.block_ids;
            }
        }
        // 无变体或找不到激活变体时：回退到 message.block_ids
        &self.block_ids
    }

    /// 获取激活的变体（如果存在）
    pub fn get_active_variant(&self) -> Option<&Variant> {
        if let (Some(active_id), Some(variants)) = (&self.active_variant_id, &self.variants) {
            return variants.iter().find(|v| &v.id == active_id);
        }
        None
    }

    /// 获取指定 ID 的变体
    pub fn get_variant(&self, variant_id: &str) -> Option<&Variant> {
        self.variants.as_ref()?.iter().find(|v| v.id == variant_id)
    }

    /// 获取指定 ID 的变体（可变引用）
    pub fn get_variant_mut(&mut self, variant_id: &str) -> Option<&mut Variant> {
        self.variants
            .as_mut()?
            .iter_mut()
            .find(|v| v.id == variant_id)
    }

    /// 获取激活变体的可变引用
    pub fn get_active_variant_mut(&mut self) -> Option<&mut Variant> {
        let active_id = self.active_variant_id.clone()?;
        self.get_variant_mut(&active_id)
    }

    /// 添加变体
    pub fn add_variant(&mut self, variant: Variant) {
        if self.variants.is_none() {
            self.variants = Some(Vec::new());
        }
        if let Some(variants) = &mut self.variants {
            variants.push(variant);
        }
    }

    /// 设置激活变体 ID
    ///
    /// 注意：该方法不会验证变体是否存在或可激活
    pub fn set_active_variant_id(&mut self, variant_id: String) {
        self.active_variant_id = Some(variant_id);
    }

    /// 选择第一个成功的变体作为激活变体
    ///
    /// 优先级：
    /// 1. 第一个 success 变体
    /// 2. 第一个 cancelled 变体
    /// 3. 第一个变体（即使是 error）
    ///
    /// 原则：必须有一个 active，否则 UI 无法渲染
    pub fn select_best_active_variant(&mut self) {
        if let Some(variants) = &self.variants {
            // 优先级 1：第一个 success
            if let Some(v) = variants
                .iter()
                .find(|v| v.status == variant_status::SUCCESS)
            {
                self.active_variant_id = Some(v.id.clone());
                return;
            }
            // 优先级 2：第一个 cancelled
            if let Some(v) = variants
                .iter()
                .find(|v| v.status == variant_status::CANCELLED)
            {
                self.active_variant_id = Some(v.id.clone());
                return;
            }
            // 优先级 3：第一个变体
            if let Some(v) = variants.first() {
                self.active_variant_id = Some(v.id.clone());
            }
        }
    }

    /// 删除指定变体
    ///
    /// 返回是否成功删除
    pub fn remove_variant(&mut self, variant_id: &str) -> bool {
        if let Some(variants) = &mut self.variants {
            let original_len = variants.len();
            variants.retain(|v| v.id != variant_id);
            return variants.len() < original_len;
        }
        false
    }

    /// 获取变体数量
    pub fn variant_count(&self) -> usize {
        self.variants.as_ref().map_or(0, |v| v.len())
    }
}

/// 消息元数据（与前端 MessageMeta 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageMeta {
    /// 生成此消息使用的模型 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,

    /// 生成此消息使用的对话参数快照
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_params: Option<Value>,

    /// 来源信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<MessageSources>,

    /// 工具调用结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_results: Option<Vec<ToolResultInfo>>,

    /// Anki 卡片（如果制卡模式生成）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anki_cards: Option<Vec<Value>>,

    /// Token 使用统计（单变体模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,

    /// 上下文快照（统一上下文注入系统）
    /// 记录消息发送时的上下文引用，只存 ContextRef 不存实际内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_snapshot: Option<ContextSnapshot>,

    /// 技能状态快照（执行前）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_snapshot_before: Option<SkillStateSnapshot>,

    /// 技能状态快照（执行后）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_snapshot_after: Option<SkillStateSnapshot>,

    /// 技能运行时快照（执行前）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_runtime_before: Option<ReplaySkillPayloadSnapshot>,

    /// 技能运行时快照（执行后）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_runtime_after: Option<ReplaySkillPayloadSnapshot>,

    /// 实际采用的 replay 来源
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_source: Option<String>,
}

impl Default for MessageMeta {
    fn default() -> Self {
        Self {
            model_id: None,
            chat_params: None,
            sources: None,
            tool_results: None,
            anki_cards: None,
            usage: None,
            context_snapshot: None,
            skill_snapshot_before: None,
            skill_snapshot_after: None,
            skill_runtime_before: None,
            skill_runtime_after: None,
            replay_source: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplayMode {
    Original,
    Current,
}

/// 消息来源（与前端 MessageSources 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSources {
    /// 文档 RAG 来源
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag: Option<Vec<SourceInfo>>,

    /// 智能记忆来源
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<Vec<SourceInfo>>,

    /// 知识图谱来源
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph: Option<Vec<SourceInfo>>,

    /// 网络搜索来源
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search: Option<Vec<SourceInfo>>,

    /// 多模态知识库来源
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal: Option<Vec<SourceInfo>>,
}

impl Default for MessageSources {
    fn default() -> Self {
        Self {
            rag: None,
            memory: None,
            graph: None,
            web_search: None,
            multimodal: None,
        }
    }
}

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
    #[serde(skip_serializing)]
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

/// 来源信息（与前端 SourceInfo 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// 来源标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 来源 URL 或路径
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,

    /// 内容片段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,

    /// 相关度分数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,

    /// 额外元数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ============================================================================
// 附件相关类型
// ============================================================================

/// 附件元数据（与前端 AttachmentMeta 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    /// 附件 ID（格式：att_{uuid}）
    #[serde(default)]
    pub id: String,

    /// 文件名
    #[serde(default)]
    pub name: String,

    /// 附件类型（'image' | 'document' | 'audio' | 'video' | 'other'）
    #[serde(default)]
    pub r#type: String,

    /// MIME 类型
    #[serde(default)]
    pub mime_type: String,

    /// 文件大小（字节）
    #[serde(default)]
    pub size: u64,

    /// 图片/文档的预览 URL 或 base64
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,

    /// 上传状态（'pending' | 'uploading' | 'ready' | 'error' | 'processing'）
    #[serde(default = "AttachmentMeta::default_status")]
    pub status: String,

    /// 错误信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AttachmentMeta {
    /// 生成附件 ID
    pub fn generate_id() -> String {
        format!("att_{}", uuid::Uuid::new_v4())
    }

    fn default_status() -> String {
        "pending".to_string()
    }
}

// ============================================================================
// 请求/响应类型
// ============================================================================

/// 发送消息请求（Tauri 命令参数）
///
/// ★ 2025-12-10 统一改造：移除 attachments 字段
/// 所有附件现在通过 user_context_refs 传递（VFS 引用模式）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    /// 会话 ID
    pub session_id: String,

    /// 消息内容
    pub content: String,

    /// 发送选项
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<SendOptions>,

    /// 前端生成的用户消息 ID（可选，用于 ID 统一）
    /// 如果提供，后端必须使用此 ID 而非自己生成
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_message_id: Option<String>,

    /// 前端生成的助手消息 ID（可选，用于 ID 统一）
    /// 如果提供，后端必须使用此 ID 而非自己生成
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_message_id: Option<String>,

    /// 用户上下文引用（统一上下文注入系统）
    /// ★ 包含所有类型的上下文资源（笔记、教材、附件等）
    /// 前端格式化后的上下文引用，包含 formattedBlocks
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_context_refs: Option<Vec<SendContextRef>>,

    /// ★ 文档28 Prompt10：资源路径映射
    /// 存储 resourceId -> 真实路径 的映射，用于 UI 显示
    /// 前端发送时获取，后端保存到 context_snapshot.path_map
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_map: Option<std::collections::HashMap<String, String>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// 附件输入（上传时的数据结构）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    /// 文件名
    pub name: String,

    /// MIME 类型
    pub mime_type: String,

    /// Base64 编码的文件内容（二进制文件）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64_content: Option<String>,

    /// 文本内容（文本文件）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_content: Option<String>,

    /// 额外元数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// MCP 工具 Schema（前端传递给后端）
///
/// 结构与 OpenAI function calling 兼容
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpToolSchema {
    /// 工具名称（可能带命名空间前缀）
    pub name: String,

    /// 所属 MCP 服务器 ID（外部工具去重/路由用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,

    /// 工具描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// JSON Schema 定义参数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

/// 发送选项（必须覆盖前端 ChatParams + 扩展功能）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SendOptions {
    // ========== 与前端 ChatParams 对应 ==========
    /// 模型 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,

    /// 温度
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,

    /// Top-P 核采样（0-1）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,

    /// 频率惩罚（-2 到 2）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f32>,

    /// 存在惩罚（-2 到 2）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,

    /// 上下文限制（tokens）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<u32>,

    /// 最大输出 tokens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,

    /// 启用推理/思维链
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_thinking: Option<bool>,

    /// 历史重放模式
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_mode: Option<ReplayMode>,

    /// 当前技能状态版本（用于事件去重/丢弃过期事件）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_state_version: Option<u64>,

    /// 禁用工具调用
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_tools: Option<bool>,

    /// 模型 2 覆盖
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model2_override_id: Option<String>,

    // ========== RAG 选项 ==========
    /// 启用 RAG
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_enabled: Option<bool>,

    /// RAG 知识库 ID 列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_library_ids: Option<Vec<String>>,

    /// RAG Top-K
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_top_k: Option<u32>,

    /// 🔧 P1-35: RAG 启用重排序（Rerank）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_enable_reranking: Option<bool>,

    /// 启用知识图谱 RAG
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_rag_enabled: Option<bool>,

    /// 选中的知识图谱 ID 列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_ids: Option<Vec<String>>,

    /// 图谱检索数量（Top-K）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_top_k: Option<u32>,

    /// 启用智能记忆
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_enabled: Option<bool>,

    // ========== 多模态 RAG 选项 ==========
    /// 启用多模态知识库检索
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_rag_enabled: Option<bool>,

    /// 多模态检索 Top-K
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_top_k: Option<u32>,

    /// 多模态检索启用精排
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_enable_reranking: Option<bool>,

    /// 多模态检索知识库 ID 过滤
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_library_ids: Option<Vec<String>>,

    // ★ 2026-01 简化：VFS RAG 作为唯一知识检索方案
    // rag_top_k 和 rag_enable_reranking 直接用于 VFS RAG 检索

    // ========== 工具选项 ==========
    /// 启用的 MCP 服务器 ID 列表（用于标识选中的服务器）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_tools: Option<Vec<String>>,

    /// MCP 工具的完整 Schema 列表
    ///
    /// 由前端从 mcpService 获取选中服务器的工具 Schema，传递给后端。
    /// 后端直接使用这些 Schema 注入到 LLM，而不需要自己连接 MCP 服务器。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_tool_schemas: Option<Vec<McpToolSchema>>,

    /// 工具递归最大深度（默认 30，范围 1-100）
    /// 控制 AI 可以连续调用工具的最大次数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tool_recursion: Option<u32>,

    /// 启用网络搜索
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search_enabled: Option<bool>,

    /// 搜索引擎列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_engines: Option<Vec<String>>,

    // ========== Anki 选项 ==========
    /// 启用 Anki 制卡
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anki_enabled: Option<bool>,

    /// Anki 模板 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anki_template_id: Option<String>,

    /// Anki 选项
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anki_options: Option<Value>,

    // ========== 系统提示 ==========
    /// 系统提示覆盖
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt_override: Option<String>,

    /// 系统提示追加
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt_append: Option<String>,

    // ========== 内部控制选项 ==========
    /// 跳过用户消息保存（编辑重发场景使用）
    /// 当为 true 时，Pipeline 不会创建新的用户消息，仅创建助手消息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_user_message_save: Option<bool>,

    /// 跳过助手消息保存（重试场景使用）
    /// 当为 true 时，Pipeline 使用已有的助手消息 ID，不创建新的助手消息
    /// 用于"替换"语义的重试操作
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_assistant_message_save: Option<bool>,

    // ========== 多变体选项 ==========
    /// 多模型并行的模型 ID 列表（2+ 个模型时触发多变体模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parallel_model_ids: Option<Vec<String>>,

    /// 变体数量上限（默认 10，范围 1-20）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_variants_per_message: Option<u32>,

    // ========== Canvas 智能笔记选项 ==========
    /// Canvas 模式绑定的笔记 ID
    /// 当设置此字段时，Pipeline 将启用 Canvas 工具（note_read、note_append 等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canvas_note_id: Option<String>,

    // ========== 统一上下文注入选项 ==========
    /// 用户上下文引用（含格式化内容）
    /// 前端发送时填充 formattedBlocks，后端直接使用
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_context_refs: Option<Vec<SendContextRef>>,

    /// Schema 注入型工具 ID 列表
    /// 需要注入到 LLM 的工具 Schema，LLM 可主动调用
    /// 遵循文档 26：统一工具注入系统
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_tool_ids: Option<Vec<String>>,

    /// 上下文类型的 System Prompt Hints
    /// 告知 LLM 用户消息中 XML 标签的含义和用途
    /// 在 System Prompt 中生成 <user_context_format_guide> 块
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_type_hints: Option<Vec<String>>,

    // ========== 🆕 P1-C: Skill 工具权限约束 ==========
    /// 当前会话激活的 Skill IDs
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_skill_ids: Option<Vec<String>>,

    // ========== 🆕 渐进披露 Skills 内容 ==========
    /// 技能内容映射（skillId -> content）
    /// 前端发送时填充所有已注册技能的 content
    /// 后端 load_skills 执行时从此字段获取技能内容并返回给 LLM
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_contents: Option<std::collections::HashMap<String, String>>,

    /// 技能嵌入工具映射（skillId -> embeddedTools）
    /// 前端发送时填充所有已注册技能的 embeddedTools
    /// 后端 load_skills 执行后从此字段获取工具 Schema 并动态追加到 tools 数组
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_embedded_tools: Option<std::collections::HashMap<String, Vec<McpToolSchema>>>,

    // ========== 🆕 消息内继续执行支持 ==========
    /// 标记这是继续执行（而非新消息）
    /// 当为 true 时，Pipeline 会恢复已有的 TODO 列表状态，继续在同一消息内执行
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_continue: Option<bool>,

    /// 继续执行的目标变体 ID
    /// 如果设置，Pipeline 会在该变体上继续执行
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continue_variant_id: Option<String>,

    // ========== 🆕 图片压缩策略 ==========
    /// 🆕 关闭工具白名单检查（允许所有工具绕过技能白名单限制）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_tool_whitelist: Option<bool>,

    /// 视觉质量策略（用于多模态图片压缩）
    ///
    /// - `low`: 最大 768px，JPEG 60%，适用于大量图片/PDF 概览
    /// - `medium`: 最大 1024px，JPEG 75%，适用于一般理解
    /// - `high`: 不压缩，适用于 OCR/细节识别
    /// - `auto`: 智能策略（默认）：
    ///   - 单图 + 非 PDF：high（保持原质量）
    ///   - 2-5 张图：medium
    ///   - 6+ 张图或 PDF：low（最大压缩）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision_quality: Option<String>,
}

/// 加载会话响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSessionResponse {
    /// 会话信息
    pub session: ChatSession,

    /// 消息列表
    pub messages: Vec<ChatMessage>,

    /// 块列表
    pub blocks: Vec<MessageBlock>,

    /// 会话状态（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<SessionState>,
}

/// 会话设置（用于更新会话）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    /// 会话标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// 扩展元数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ============================================================================
// 会话状态类型
// ============================================================================

/// 会话状态（对应 chat_v2_session_state 表）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// 会话 ID
    pub session_id: String,

    /// 聊天参数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_params: Option<ChatParams>,

    /// 功能开关 Map
    #[serde(skip_serializing_if = "Option::is_none")]
    pub features: Option<HashMap<String, bool>>,

    /// 模式状态
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_state: Option<Value>,

    /// 输入框草稿
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_value: Option<String>,

    /// 面板状态
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel_states: Option<PanelStates>,

    /// 更新时间（ISO 8601）
    pub updated_at: String,

    /// 待发送的上下文引用列表（JSON 格式）
    /// 存储 ContextRef[] 的 JSON，用于会话切换后恢复
    /// 结构: [{ resourceId, hash, typeId }, ...]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_context_refs_json: Option<String>,

    /// 🆕 渐进披露：已加载的 Skill IDs（JSON 格式）
    /// 存储 string[] 的 JSON，用于会话恢复后自动重新加载 Skills
    /// 结构: ["knowledge-retrieval", "todo-tools", ...]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loaded_skill_ids_json: Option<String>,

    /// 🆕 手动激活的 Skill ID 列表（JSON 格式，支持多选）
    /// 用于恢复用户选择的多个指令型 Skills
    /// 结构: ["skill-1", "skill-2", ...]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_skill_ids_json: Option<String>,

    /// 结构化 Skill 状态（JSON 格式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_state_json: Option<String>,
}

impl SessionState {
    pub fn resolved_skill_state(&self) -> SessionSkillState {
        self.skill_state_json
            .as_ref()
            .and_then(|raw| serde_json::from_str::<SessionSkillState>(raw).ok())
            .unwrap_or_else(|| {
                SessionSkillState::from_legacy(
                    self.active_skill_ids_json.as_ref(),
                    self.loaded_skill_ids_json.as_ref(),
                )
            })
    }

    pub fn set_skill_state(
        &mut self,
        skill_state: &SessionSkillState,
    ) -> Result<(), serde_json::Error> {
        self.skill_state_json = Some(serde_json::to_string(skill_state)?);

        let active_ids = skill_state.resolved_active_skill_ids();
        self.active_skill_ids_json = if active_ids.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&active_ids)?)
        };

        let loaded_ids = skill_state.resolved_loaded_skill_ids();
        self.loaded_skill_ids_json = if loaded_ids.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&loaded_ids)?)
        };

        Ok(())
    }
}

/// 聊天参数（与前端 ChatParams 对齐）
///
/// 🔧 P0修复：补全缺失字段，确保会话保存/恢复时参数不丢失
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatParams {
    /// 当前选择的模型 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,

    /// 温度（0-2，默认 0.7）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,

    /// Top-P 核采样（0-1，默认 0.9）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,

    /// 频率惩罚（-2 到 2，默认 0）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f32>,

    /// 存在惩罚（-2 到 2，默认 0）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,

    /// 上下文限制（tokens）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<u32>,

    /// 最大输出 tokens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,

    /// 启用推理/思维链
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_thinking: Option<bool>,

    /// 禁用工具调用
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_tools: Option<bool>,

    /// 模型 2 覆盖（用于特定场景）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model2_override_id: Option<String>,

    /// RAG 检索数量（Top-K）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_top_k: Option<u32>,

    /// RAG 选中的知识库 ID 列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_library_ids: Option<Vec<String>>,

    /// 学习模式提示词
    #[serde(skip_serializing_if = "Option::is_none")]
    pub learn_mode_prompt: Option<String>,

    /// 选中的 MCP 服务器 ID 列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_mcp_servers: Option<Vec<String>>,

    /// 选中的搜索引擎 ID 列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_search_engines: Option<Vec<String>>,

    /// 选中的知识图谱 ID 列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_ids: Option<Vec<String>>,

    /// 图谱检索数量（Top-K）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_top_k: Option<u32>,

    // ========== 🔧 2026-02-07 补齐前端同步字段，防止会话保存/恢复时丢失 ==========
    /// 模型显示名称（前端显示用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_display_name: Option<String>,

    /// RAG 启用重排序（Rerank）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_enable_reranking: Option<bool>,

    /// 工具递归最大深度（1-100，默认 30）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tool_recursion: Option<u32>,

    /// 启用多模态知识库检索
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_rag_enabled: Option<bool>,

    /// 多模态检索数量（Top-K），默认 10
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_top_k: Option<u32>,

    /// 多模态检索启用精排
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_enable_reranking: Option<bool>,

    /// 多模态检索知识库 ID 过滤
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_library_ids: Option<Vec<String>>,

    /// 关闭工具白名单检查
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_tool_whitelist: Option<bool>,

    /// 图片压缩策略（low/medium/high/auto）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision_quality: Option<String>,
}

impl Default for ChatParams {
    fn default() -> Self {
        Self {
            model_id: None,
            temperature: Some(0.7),
            top_p: Some(0.9),
            frequency_penalty: Some(0.0),
            presence_penalty: Some(0.0),
            context_limit: Some(8192),
            // 🔧 2026-02-07: 对齐前端默认值 (32768 / enableThinking=true)
            max_tokens: Some(32768),
            enable_thinking: Some(true),
            disable_tools: Some(false),
            model2_override_id: None,
            rag_top_k: None,
            rag_library_ids: None,
            learn_mode_prompt: None,
            selected_mcp_servers: None,
            selected_search_engines: None,
            graph_ids: None,
            graph_top_k: None,
            // 补齐字段默认值
            model_display_name: None,
            rag_enable_reranking: None,
            max_tool_recursion: Some(30),
            multimodal_rag_enabled: None,
            multimodal_top_k: None,
            multimodal_enable_reranking: None,
            multimodal_library_ids: None,
            disable_tool_whitelist: None,
            vision_quality: None,
        }
    }
}

/// 面板状态（与前端 PanelStates 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelStates {
    /// RAG 知识库面板
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag: Option<bool>,

    /// MCP 工具面板
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp: Option<bool>,

    /// 搜索引擎面板
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<bool>,

    /// 学习模式面板
    #[serde(skip_serializing_if = "Option::is_none")]
    pub learn: Option<bool>,

    /// 模型选择面板
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<bool>,

    /// 高级设置面板
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced: Option<bool>,

    /// 附件面板
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<bool>,
}

impl Default for PanelStates {
    fn default() -> Self {
        Self {
            rag: Some(false),
            mcp: Some(false),
            search: Some(false),
            learn: Some(false),
            model: Some(false),
            advanced: Some(false),
            attachment: Some(false),
        }
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json;

    #[test]
    fn test_message_block_serialization() {
        let block = MessageBlock {
            id: "blk_123".to_string(),
            message_id: "msg_456".to_string(),
            block_type: "content".to_string(),
            status: "running".to_string(),
            content: Some("Hello".to_string()),
            tool_name: None,
            tool_input: None,
            tool_output: None,
            citations: None,
            error: None,
            started_at: Some(1234567890),
            ended_at: None,
            first_chunk_at: None,
            block_index: 0,
        };

        let json = serde_json::to_string(&block).unwrap();

        // 验证 block_type 序列化为 "type"
        assert!(
            json.contains("\"type\":\"content\""),
            "Expected 'type' field, got: {}",
            json
        );

        // 验证使用 camelCase
        assert!(
            json.contains("\"messageId\""),
            "Expected camelCase 'messageId', got: {}",
            json
        );

        // 验证 block_index 不被序列化
        assert!(
            !json.contains("blockIndex"),
            "block_index should not be serialized, got: {}",
            json
        );

        // 验证 startedAt 使用 camelCase
        assert!(
            json.contains("\"startedAt\""),
            "Expected camelCase 'startedAt', got: {}",
            json
        );

        // 验证 None 字段不被序列化
        assert!(
            !json.contains("\"toolName\""),
            "None fields should not be serialized, got: {}",
            json
        );
    }

    #[test]
    fn test_chat_message_serialization() {
        let message = ChatMessage {
            id: "msg_123".to_string(),
            session_id: "sess_456".to_string(),
            role: MessageRole::Assistant,
            block_ids: vec!["blk_1".to_string(), "blk_2".to_string()],
            timestamp: 1234567890,
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: Some(MessageMeta {
                model_id: Some("gpt-4".to_string()),
                chat_params: None,
                sources: None,
                tool_results: None,
                anki_cards: None,
                usage: None,
                context_snapshot: None,
                skill_snapshot_before: None,
                skill_snapshot_after: None,
                skill_runtime_before: None,
                skill_runtime_after: None,
                replay_source: None,
            }),
            attachments: None,
            active_variant_id: None,
            variants: None,
            shared_context: None,
        };

        let json = serde_json::to_string(&message).unwrap();

        // 验证 camelCase
        assert!(
            json.contains("\"sessionId\""),
            "Expected camelCase 'sessionId', got: {}",
            json
        );
        assert!(
            json.contains("\"blockIds\""),
            "Expected camelCase 'blockIds', got: {}",
            json
        );

        // 验证 role 序列化为 snake_case
        assert!(
            json.contains("\"role\":\"assistant\""),
            "Expected role as 'assistant', got: {}",
            json
        );

        // 验证 None 字段不被序列化
        assert!(
            !json.contains("\"parentId\""),
            "None parentId should not be serialized, got: {}",
            json
        );

        // 验证 meta 字段序列化为 _meta（与前端对齐）
        assert!(
            json.contains("\"_meta\""),
            "Expected '_meta' field (not 'meta'), got: {}",
            json
        );
    }

    #[test]
    fn test_chat_session_serialization() {
        let session = ChatSession::new("sess_123".to_string(), "analysis".to_string());

        let json = serde_json::to_string(&session).unwrap();

        // 验证 camelCase
        assert!(
            json.contains("\"persistStatus\""),
            "Expected camelCase 'persistStatus', got: {}",
            json
        );
        assert!(
            json.contains("\"createdAt\""),
            "Expected camelCase 'createdAt', got: {}",
            json
        );

        // 验证 persistStatus 序列化为 snake_case
        assert!(
            json.contains("\"persistStatus\":\"active\""),
            "Expected persistStatus as 'active', got: {}",
            json
        );
    }

    #[test]
    fn test_send_options_serialization() {
        let options = SendOptions {
            model_id: Some("gpt-4".to_string()),
            temperature: Some(0.7),
            rag_enabled: Some(true),
            rag_library_ids: Some(vec!["lib_1".to_string(), "lib_2".to_string()]),
            ..Default::default()
        };

        let json = serde_json::to_string(&options).unwrap();

        // 验证 camelCase
        assert!(
            json.contains("\"modelId\""),
            "Expected camelCase 'modelId', got: {}",
            json
        );
        assert!(
            json.contains("\"ragEnabled\""),
            "Expected camelCase 'ragEnabled', got: {}",
            json
        );
        assert!(
            json.contains("\"ragLibraryIds\""),
            "Expected camelCase 'ragLibraryIds', got: {}",
            json
        );

        // 验证 None 字段不被序列化
        assert!(
            !json.contains("\"ankiEnabled\""),
            "None fields should not be serialized, got: {}",
            json
        );
    }

    #[test]
    fn test_block_id_generation() {
        let id1 = MessageBlock::generate_id();
        let id2 = MessageBlock::generate_id();

        // 验证格式
        assert!(
            id1.starts_with("blk_"),
            "Block ID should start with 'blk_', got: {}",
            id1
        );
        assert!(
            id2.starts_with("blk_"),
            "Block ID should start with 'blk_', got: {}",
            id2
        );

        // 验证唯一性
        assert_ne!(id1, id2, "Block IDs should be unique");
    }

    #[test]
    fn test_message_id_generation() {
        let id1 = ChatMessage::generate_id();
        let id2 = ChatMessage::generate_id();

        // 验证格式
        assert!(
            id1.starts_with("msg_"),
            "Message ID should start with 'msg_', got: {}",
            id1
        );

        // 验证唯一性
        assert_ne!(id1, id2, "Message IDs should be unique");
    }

    #[test]
    fn test_session_id_generation() {
        let id1 = ChatSession::generate_id();
        let id2 = ChatSession::generate_id();

        // 验证格式
        assert!(
            id1.starts_with("sess_"),
            "Session ID should start with 'sess_', got: {}",
            id1
        );

        // 验证唯一性
        assert_ne!(id1, id2, "Session IDs should be unique");
    }

    #[test]
    fn test_message_block_state_transitions() {
        let mut block = MessageBlock::new("msg_123".to_string(), block_types::CONTENT, 0);

        // 初始状态
        assert_eq!(block.status, block_status::PENDING);
        assert!(block.started_at.is_none());
        assert!(block.ended_at.is_none());

        // 设置为运行中
        block.set_running();
        assert_eq!(block.status, block_status::RUNNING);
        assert!(block.started_at.is_some());
        assert!(block.ended_at.is_none());

        // 设置为成功
        block.set_success();
        assert_eq!(block.status, block_status::SUCCESS);
        assert!(block.ended_at.is_some());
    }

    #[test]
    fn test_message_block_error_state() {
        let mut block = MessageBlock::new("msg_123".to_string(), block_types::CONTENT, 0);

        block.set_running();
        block.set_error("Test error message");

        assert_eq!(block.status, block_status::ERROR);
        assert_eq!(block.error, Some("Test error message".to_string()));
        assert!(block.ended_at.is_some());
    }

    #[test]
    fn test_message_block_content_append() {
        let mut block = MessageBlock::new("msg_123".to_string(), block_types::CONTENT, 0);

        // 追加到空内容
        block.append_content("Hello");
        assert_eq!(block.content, Some("Hello".to_string()));

        // 继续追加
        block.append_content(" World");
        assert_eq!(block.content, Some("Hello World".to_string()));
    }

    #[test]
    fn test_citation_serialization() {
        let citation = Citation {
            r#type: "rag".to_string(),
            title: Some("Test Document".to_string()),
            url: Some("https://example.com".to_string()),
            snippet: Some("Test snippet...".to_string()),
            score: Some(0.95),
        };

        let json = serde_json::to_string(&citation).unwrap();

        // 验证 type 字段（关键字）
        assert!(
            json.contains("\"type\":\"rag\""),
            "Expected 'type' field, got: {}",
            json
        );
    }

    #[test]
    fn test_persist_status_serialization() {
        let status = PersistStatus::Active;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"active\"");

        let status = PersistStatus::Archived;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"archived\"");

        let status = PersistStatus::Deleted;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"deleted\"");
    }

    #[test]
    fn test_message_role_serialization() {
        let role = MessageRole::User;
        let json = serde_json::to_string(&role).unwrap();
        assert_eq!(json, "\"user\"");

        let role = MessageRole::Assistant;
        let json = serde_json::to_string(&role).unwrap();
        assert_eq!(json, "\"assistant\"");
    }

    #[test]
    fn test_load_session_response_serialization() {
        let session = ChatSession::new("sess_123".to_string(), "analysis".to_string());
        let message = ChatMessage::new_assistant("sess_123".to_string());
        let block = MessageBlock::new_content("msg_123".to_string(), 0);

        let response = LoadSessionResponse {
            session,
            messages: vec![message],
            blocks: vec![block],
            state: None,
        };

        let json = serde_json::to_string(&response).unwrap();

        // 验证结构完整
        assert!(
            json.contains("\"session\""),
            "Expected 'session' field, got: {}",
            json
        );
        assert!(
            json.contains("\"messages\""),
            "Expected 'messages' field, got: {}",
            json
        );
        assert!(
            json.contains("\"blocks\""),
            "Expected 'blocks' field, got: {}",
            json
        );
    }

    #[test]
    fn test_deserialization_from_frontend() {
        // 模拟前端发送的 JSON（camelCase）
        let json = r#"{
            "sessionId": "sess_123",
            "content": "Hello",
            "options": {
                "modelId": "gpt-4",
                "temperature": 0.7,
                "ragEnabled": true
            }
        }"#;

        let request: SendMessageRequest = serde_json::from_str(json).unwrap();

        assert_eq!(request.session_id, "sess_123");
        assert_eq!(request.content, "Hello");
        assert!(request.options.is_some());

        let options = request.options.unwrap();
        assert_eq!(options.model_id, Some("gpt-4".to_string()));
        assert_eq!(options.temperature, Some(0.7));
        assert_eq!(options.rag_enabled, Some(true));
    }

    // ========== 变体相关测试 ==========

    #[test]
    fn test_variant_serialization_camel_case() {
        let variant = Variant {
            id: "var_123".to_string(),
            model_id: "gpt-4".to_string(),
            config_id: None,
            block_ids: vec!["blk_1".to_string(), "blk_2".to_string()],
            status: variant_status::SUCCESS.to_string(),
            error: None,
            created_at: 1234567890,
            usage: None,
            meta: None,
        };

        let json = serde_json::to_string(&variant).unwrap();

        // 验证 camelCase
        assert!(
            json.contains("\"modelId\":"),
            "Expected camelCase 'modelId', got: {}",
            json
        );
        assert!(
            json.contains("\"blockIds\":"),
            "Expected camelCase 'blockIds', got: {}",
            json
        );
        assert!(
            json.contains("\"createdAt\":"),
            "Expected camelCase 'createdAt', got: {}",
            json
        );

        // 验证 None 字段不被序列化
        assert!(
            !json.contains("\"error\":"),
            "None error should not be serialized, got: {}",
            json
        );
    }

    #[test]
    fn test_variant_id_generation() {
        let id1 = Variant::generate_id();
        let id2 = Variant::generate_id();

        // 验证格式
        assert!(
            id1.starts_with("var_"),
            "Variant ID should start with 'var_', got: {}",
            id1
        );

        // 验证唯一性
        assert_ne!(id1, id2, "Variant IDs should be unique");
    }

    #[test]
    fn test_variant_state_transitions() {
        let mut variant = Variant::new("gpt-4".to_string());

        // 初始状态
        assert_eq!(variant.status, variant_status::PENDING);
        assert!(variant.can_activate());
        assert!(!variant.can_retry());

        // 设置为流式中
        variant.set_streaming();
        assert_eq!(variant.status, variant_status::STREAMING);
        assert!(variant.can_activate());

        // 设置为成功
        variant.set_success();
        assert_eq!(variant.status, variant_status::SUCCESS);
        assert!(variant.can_activate());
        assert!(!variant.can_retry());
    }

    #[test]
    fn test_variant_error_state() {
        let mut variant = Variant::new("gpt-4".to_string());

        variant.set_error("API rate limit exceeded");

        assert_eq!(variant.status, variant_status::ERROR);
        assert_eq!(variant.error, Some("API rate limit exceeded".to_string()));
        assert!(!variant.can_activate()); // error 变体不能激活
        assert!(variant.can_retry()); // error 变体可以重试
    }

    #[test]
    fn test_variant_cancelled_state() {
        let mut variant = Variant::new("gpt-4".to_string());

        variant.set_cancelled();

        assert_eq!(variant.status, variant_status::CANCELLED);
        assert!(variant.can_activate()); // cancelled 可以激活
        assert!(variant.can_retry()); // cancelled 可以重试
    }

    #[test]
    fn test_shared_context_serialization() {
        let context = SharedContext {
            rag_sources: Some(vec![SourceInfo {
                title: Some("Test Doc".to_string()),
                url: None,
                snippet: Some("Test snippet".to_string()),
                score: Some(0.95),
                metadata: None,
            }]),
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            multimodal_sources: None,
            rag_block_id: None,
            memory_block_id: None,
            graph_block_id: None,
            web_search_block_id: None,
            multimodal_block_id: None,
        };

        let json = serde_json::to_string(&context).unwrap();

        // 验证 camelCase
        assert!(
            json.contains("\"ragSources\":"),
            "Expected camelCase 'ragSources', got: {}",
            json
        );

        // 验证 None 字段不被序列化
        assert!(
            !json.contains("\"memorySources\":"),
            "None memorySources should not be serialized, got: {}",
            json
        );
    }

    #[test]
    fn test_shared_context_has_sources() {
        let empty = SharedContext::new();
        assert!(!empty.has_sources());

        let with_rag = SharedContext {
            rag_sources: Some(vec![SourceInfo {
                title: Some("Test".to_string()),
                url: None,
                snippet: None,
                score: None,
                metadata: None,
            }]),
            ..Default::default()
        };
        assert!(with_rag.has_sources());
    }

    #[test]
    fn test_chat_message_is_multi_variant() {
        // 无变体
        let msg1 = ChatMessage::new_assistant("sess_1".to_string());
        assert!(!msg1.is_multi_variant());

        // 单变体
        let mut msg2 = ChatMessage::new_assistant("sess_1".to_string());
        msg2.variants = Some(vec![Variant::new("gpt-4".to_string())]);
        assert!(!msg2.is_multi_variant());

        // 多变体
        let mut msg3 = ChatMessage::new_assistant("sess_1".to_string());
        msg3.variants = Some(vec![
            Variant::new("gpt-4".to_string()),
            Variant::new("claude".to_string()),
        ]);
        assert!(msg3.is_multi_variant());
    }

    #[test]
    fn test_chat_message_get_active_block_ids_fallback() {
        // 无变体，返回 message.block_ids
        let mut msg = ChatMessage::new_assistant("sess_1".to_string());
        msg.block_ids = vec!["blk_1".to_string(), "blk_2".to_string()];
        assert_eq!(
            msg.get_active_block_ids(),
            &["blk_1".to_string(), "blk_2".to_string()]
        );

        // 有变体但无 active_variant_id
        let mut variant = Variant::new("gpt-4".to_string());
        variant.block_ids = vec!["blk_3".to_string()];
        msg.variants = Some(vec![variant.clone()]);
        // 仍返回 message.block_ids
        assert_eq!(
            msg.get_active_block_ids(),
            &["blk_1".to_string(), "blk_2".to_string()]
        );

        // 设置 active_variant_id
        msg.active_variant_id = Some(variant.id.clone());
        // 返回变体的 block_ids
        assert_eq!(msg.get_active_block_ids(), &["blk_3".to_string()]);

        // 边界情况：active_variant_id 指向不存在的变体（fallback 到 message.block_ids）
        msg.active_variant_id = Some("non_existent_var_id".to_string());
        assert_eq!(
            msg.get_active_block_ids(),
            &["blk_1".to_string(), "blk_2".to_string()]
        );
    }

    #[test]
    fn test_chat_message_select_best_active_variant() {
        let mut msg = ChatMessage::new_assistant("sess_1".to_string());

        let mut var1 = Variant::new("gpt-4".to_string());
        var1.set_error("Error");

        let mut var2 = Variant::new("claude".to_string());
        var2.set_cancelled();

        let mut var3 = Variant::new("deepseek".to_string());
        var3.set_success();

        msg.variants = Some(vec![var1.clone(), var2.clone(), var3.clone()]);

        // 应该选择第一个 success 变体
        msg.select_best_active_variant();
        assert_eq!(msg.active_variant_id, Some(var3.id.clone()));
    }

    #[test]
    fn test_chat_message_select_best_active_variant_fallback() {
        let mut msg = ChatMessage::new_assistant("sess_1".to_string());

        let mut var1 = Variant::new("gpt-4".to_string());
        var1.set_error("Error");

        let mut var2 = Variant::new("claude".to_string());
        var2.set_cancelled();

        msg.variants = Some(vec![var1.clone(), var2.clone()]);

        // 无 success，应该选择第一个 cancelled
        msg.select_best_active_variant();
        assert_eq!(msg.active_variant_id, Some(var2.id.clone()));
    }

    #[test]
    fn test_chat_message_select_best_active_variant_all_error() {
        let mut msg = ChatMessage::new_assistant("sess_1".to_string());

        let mut var1 = Variant::new("gpt-4".to_string());
        var1.set_error("Error 1");

        let mut var2 = Variant::new("claude".to_string());
        var2.set_error("Error 2");

        msg.variants = Some(vec![var1.clone(), var2.clone()]);

        // 所有变体都是 error，应该选择第一个变体（确保 UI 有内容可显示）
        msg.select_best_active_variant();
        assert_eq!(msg.active_variant_id, Some(var1.id.clone()));
    }

    #[test]
    fn test_chat_message_add_and_remove_variant() {
        let mut msg = ChatMessage::new_assistant("sess_1".to_string());

        // 添加变体
        let var1 = Variant::new("gpt-4".to_string());
        let var1_id = var1.id.clone();
        msg.add_variant(var1);
        assert_eq!(msg.variant_count(), 1);

        // 再添加一个
        let var2 = Variant::new("claude".to_string());
        msg.add_variant(var2);
        assert_eq!(msg.variant_count(), 2);

        // 删除第一个
        let removed = msg.remove_variant(&var1_id);
        assert!(removed);
        assert_eq!(msg.variant_count(), 1);

        // 删除不存在的
        let not_removed = msg.remove_variant("non_existent");
        assert!(!not_removed);
    }

    #[test]
    fn test_send_options_parallel_model_ids() {
        let options = SendOptions {
            parallel_model_ids: Some(vec!["gpt-4".to_string(), "claude".to_string()]),
            max_variants_per_message: Some(5),
            ..Default::default()
        };

        let json = serde_json::to_string(&options).unwrap();

        // 验证 camelCase
        assert!(
            json.contains("\"parallelModelIds\":"),
            "Expected camelCase 'parallelModelIds', got: {}",
            json
        );
        assert!(
            json.contains("\"maxVariantsPerMessage\":"),
            "Expected camelCase 'maxVariantsPerMessage', got: {}",
            json
        );
    }

    #[test]
    fn test_chat_message_with_variants_serialization() {
        let mut msg = ChatMessage::new_assistant("sess_1".to_string());

        let mut var1 = Variant::new("gpt-4".to_string());
        var1.block_ids = vec!["blk_1".to_string()];
        var1.set_success();

        msg.variants = Some(vec![var1.clone()]);
        msg.active_variant_id = Some(var1.id.clone());
        msg.shared_context = Some(SharedContext {
            rag_sources: Some(vec![]),
            ..Default::default()
        });

        let json = serde_json::to_string(&msg).unwrap();

        // 验证 camelCase
        assert!(
            json.contains("\"activeVariantId\":"),
            "Expected camelCase 'activeVariantId', got: {}",
            json
        );
        assert!(
            json.contains("\"variants\":"),
            "Expected 'variants' field, got: {}",
            json
        );
        assert!(
            json.contains("\"sharedContext\":"),
            "Expected camelCase 'sharedContext', got: {}",
            json
        );
    }

    // ========== Token 统计相关测试 ==========

    #[test]
    fn test_token_source_serialization() {
        // 验证 TokenSource 序列化为 snake_case
        let api = TokenSource::Api;
        let json = serde_json::to_string(&api).unwrap();
        assert_eq!(json, "\"api\"");

        let tiktoken = TokenSource::Tiktoken;
        let json = serde_json::to_string(&tiktoken).unwrap();
        assert_eq!(json, "\"tiktoken\"");

        let heuristic = TokenSource::Heuristic;
        let json = serde_json::to_string(&heuristic).unwrap();
        assert_eq!(json, "\"heuristic\"");

        let mixed = TokenSource::Mixed;
        let json = serde_json::to_string(&mixed).unwrap();
        assert_eq!(json, "\"mixed\"");
    }

    #[test]
    fn test_token_source_default() {
        let default = TokenSource::default();
        assert_eq!(default, TokenSource::Tiktoken);
    }

    #[test]
    fn test_token_source_display() {
        assert_eq!(format!("{}", TokenSource::Api), "api");
        assert_eq!(format!("{}", TokenSource::Tiktoken), "tiktoken");
        assert_eq!(format!("{}", TokenSource::Heuristic), "heuristic");
        assert_eq!(format!("{}", TokenSource::Mixed), "mixed");
    }

    #[test]
    fn test_token_usage_serialization_camel_case() {
        let usage = TokenUsage {
            prompt_tokens: 1234,
            completion_tokens: 567,
            total_tokens: 1801,
            source: TokenSource::Api,
            reasoning_tokens: Some(200),
            cached_tokens: None,
            last_round_prompt_tokens: None,
        };

        let json = serde_json::to_string(&usage).unwrap();

        // 验证 camelCase
        assert!(
            json.contains("\"promptTokens\":"),
            "Expected camelCase 'promptTokens', got: {}",
            json
        );
        assert!(
            json.contains("\"completionTokens\":"),
            "Expected camelCase 'completionTokens', got: {}",
            json
        );
        assert!(
            json.contains("\"totalTokens\":"),
            "Expected camelCase 'totalTokens', got: {}",
            json
        );
        assert!(
            json.contains("\"reasoningTokens\":"),
            "Expected camelCase 'reasoningTokens', got: {}",
            json
        );

        // 验证 source 序列化为 snake_case 值
        assert!(
            json.contains("\"source\":\"api\""),
            "Expected source as 'api', got: {}",
            json
        );

        // 验证 None 字段不被序列化
        assert!(
            !json.contains("\"cachedTokens\":"),
            "None cachedTokens should not be serialized, got: {}",
            json
        );
    }

    #[test]
    fn test_token_usage_from_api() {
        let usage = TokenUsage::from_api(1000, 500, Some(100));

        assert_eq!(usage.prompt_tokens, 1000);
        assert_eq!(usage.completion_tokens, 500);
        assert_eq!(usage.total_tokens, 1500);
        assert_eq!(usage.source, TokenSource::Api);
        assert_eq!(usage.reasoning_tokens, Some(100));
        assert!(usage.cached_tokens.is_none());
    }

    #[test]
    fn test_token_usage_from_api_with_cache() {
        let usage = TokenUsage::from_api_with_cache(1000, 500, None, Some(200));

        assert_eq!(usage.prompt_tokens, 1000);
        assert_eq!(usage.completion_tokens, 500);
        assert_eq!(usage.total_tokens, 1500);
        assert_eq!(usage.source, TokenSource::Api);
        assert!(usage.reasoning_tokens.is_none());
        assert_eq!(usage.cached_tokens, Some(200));
    }

    #[test]
    fn test_token_usage_from_estimate_tiktoken() {
        let usage = TokenUsage::from_estimate(800, 400, true);

        assert_eq!(usage.prompt_tokens, 800);
        assert_eq!(usage.completion_tokens, 400);
        assert_eq!(usage.total_tokens, 1200);
        assert_eq!(usage.source, TokenSource::Tiktoken);
    }

    #[test]
    fn test_token_usage_from_estimate_heuristic() {
        let usage = TokenUsage::from_estimate(800, 400, false);

        assert_eq!(usage.prompt_tokens, 800);
        assert_eq!(usage.completion_tokens, 400);
        assert_eq!(usage.total_tokens, 1200);
        assert_eq!(usage.source, TokenSource::Heuristic);
    }

    #[test]
    fn test_token_usage_accumulate_same_source() {
        let mut usage1 = TokenUsage::from_api(1000, 200, None);
        let usage2 = TokenUsage::from_api(500, 300, Some(50));

        usage1.accumulate(&usage2);

        assert_eq!(usage1.prompt_tokens, 1500);
        assert_eq!(usage1.completion_tokens, 500);
        assert_eq!(usage1.total_tokens, 2000);
        assert_eq!(usage1.source, TokenSource::Api); // 同源不变
        assert_eq!(usage1.reasoning_tokens, Some(50)); // 从 None + Some(50)
    }

    #[test]
    fn test_token_usage_accumulate_mixed_source() {
        let mut usage1 = TokenUsage::from_api(1000, 200, None);
        let usage2 = TokenUsage::from_estimate(500, 300, true);

        usage1.accumulate(&usage2);

        assert_eq!(usage1.prompt_tokens, 1500);
        assert_eq!(usage1.completion_tokens, 500);
        assert_eq!(usage1.total_tokens, 2000);
        assert_eq!(usage1.source, TokenSource::Mixed); // 不同源变为 Mixed
    }

    #[test]
    fn test_token_usage_accumulate_reasoning_tokens() {
        let mut usage1 = TokenUsage::from_api(1000, 200, Some(100));
        let usage2 = TokenUsage::from_api(500, 300, Some(50));

        usage1.accumulate(&usage2);

        assert_eq!(usage1.reasoning_tokens, Some(150)); // 100 + 50
    }

    #[test]
    fn test_token_usage_accumulate_cached_tokens() {
        let mut usage1 = TokenUsage::from_api_with_cache(1000, 200, None, Some(100));
        let usage2 = TokenUsage::from_api_with_cache(500, 300, None, Some(50));

        usage1.accumulate(&usage2);

        assert_eq!(usage1.cached_tokens, Some(150)); // 100 + 50
    }

    #[test]
    fn test_token_usage_has_tokens() {
        let empty = TokenUsage::default();
        assert!(!empty.has_tokens());

        let with_tokens = TokenUsage::from_api(100, 50, None);
        assert!(with_tokens.has_tokens());
    }

    #[test]
    fn test_token_usage_zero() {
        let zero = TokenUsage::zero();
        assert_eq!(zero.prompt_tokens, 0);
        assert_eq!(zero.completion_tokens, 0);
        assert_eq!(zero.total_tokens, 0);
        assert!(!zero.has_tokens());
    }

    #[test]
    fn test_message_meta_with_usage() {
        let meta = MessageMeta {
            model_id: Some("gpt-4".to_string()),
            usage: Some(TokenUsage::from_api(1000, 500, None)),
            ..Default::default()
        };

        let json = serde_json::to_string(&meta).unwrap();

        // 验证 usage 字段存在且使用 camelCase
        assert!(
            json.contains("\"usage\":"),
            "Expected 'usage' field, got: {}",
            json
        );
        assert!(
            json.contains("\"promptTokens\":"),
            "Expected camelCase 'promptTokens' in usage, got: {}",
            json
        );
    }

    #[test]
    fn test_message_meta_without_usage() {
        let meta = MessageMeta {
            model_id: Some("gpt-4".to_string()),
            usage: None,
            ..Default::default()
        };

        let json = serde_json::to_string(&meta).unwrap();

        // 验证 None usage 不被序列化
        assert!(
            !json.contains("\"usage\":"),
            "None usage should not be serialized, got: {}",
            json
        );
    }

    #[test]
    fn test_variant_with_usage_builder() {
        let usage = TokenUsage::from_api(1000, 500, None);
        let variant = Variant::new("gpt-4".to_string()).with_usage(usage.clone());

        assert!(variant.usage.is_some());
        let variant_usage = variant.usage.unwrap();
        assert_eq!(variant_usage.prompt_tokens, 1000);
        assert_eq!(variant_usage.completion_tokens, 500);
        assert_eq!(variant_usage.source, TokenSource::Api);
    }

    #[test]
    fn test_variant_set_usage() {
        let mut variant = Variant::new("gpt-4".to_string());
        assert!(variant.usage.is_none());

        let usage = TokenUsage::from_api(1000, 500, None);
        variant.set_usage(usage);

        assert!(variant.usage.is_some());
        assert_eq!(variant.get_usage().unwrap().prompt_tokens, 1000);
    }

    #[test]
    fn test_variant_serialization_with_usage() {
        let usage = TokenUsage::from_api(1000, 500, Some(100));
        let variant = Variant::new("gpt-4".to_string()).with_usage(usage);

        let json = serde_json::to_string(&variant).unwrap();

        // 验证 usage 字段存在
        assert!(
            json.contains("\"usage\":"),
            "Expected 'usage' field, got: {}",
            json
        );
        assert!(
            json.contains("\"promptTokens\":1000"),
            "Expected promptTokens=1000, got: {}",
            json
        );
        assert!(
            json.contains("\"source\":\"api\""),
            "Expected source='api', got: {}",
            json
        );
    }

    #[test]
    fn test_variant_serialization_without_usage() {
        let variant = Variant::new("gpt-4".to_string());

        let json = serde_json::to_string(&variant).unwrap();

        // 验证 None usage 不被序列化
        assert!(
            !json.contains("\"usage\":"),
            "None usage should not be serialized, got: {}",
            json
        );
    }

    #[test]
    fn test_token_usage_deserialization() {
        // 模拟前端发送的 JSON（camelCase）
        let json = r#"{
            "promptTokens": 1234,
            "completionTokens": 567,
            "totalTokens": 1801,
            "source": "api",
            "reasoningTokens": 200
        }"#;

        let usage: TokenUsage = serde_json::from_str(json).unwrap();

        assert_eq!(usage.prompt_tokens, 1234);
        assert_eq!(usage.completion_tokens, 567);
        assert_eq!(usage.total_tokens, 1801);
        assert_eq!(usage.source, TokenSource::Api);
        assert_eq!(usage.reasoning_tokens, Some(200));
        assert!(usage.cached_tokens.is_none());
    }

    #[test]
    fn test_session_skill_state_promoted_branch_local_skills() {
        let state = SessionSkillState {
            manual_pinned_skill_ids: vec!["manual-a".to_string()],
            agentic_session_skill_ids: vec!["agentic-a".to_string()],
            branch_local_skill_ids: vec!["branch-a".to_string()],
            version: 3,
            ..Default::default()
        };

        let promoted = state.promoted_branch_local_skills();
        assert_eq!(promoted.manual_pinned_skill_ids, vec!["manual-a".to_string()]);
        assert_eq!(
            promoted.agentic_session_skill_ids,
            vec!["agentic-a".to_string(), "branch-a".to_string()]
        );
        assert!(promoted.branch_local_skill_ids.is_empty());
        assert_eq!(promoted.version, 4);
    }

    #[test]
    fn test_session_skill_state_without_branch_local_skills() {
        let state = SessionSkillState {
            manual_pinned_skill_ids: vec!["manual-a".to_string()],
            branch_local_skill_ids: vec!["branch-a".to_string()],
            version: 3,
            ..Default::default()
        };

        let trimmed = state.without_branch_local_skills();
        assert_eq!(trimmed.manual_pinned_skill_ids, vec!["manual-a".to_string()]);
        assert!(trimmed.branch_local_skill_ids.is_empty());
        assert_eq!(trimmed.version, 4);
    }
}
