//! Chat V2 编排引擎 (Pipeline)
//!
//! 实现完整的消息发送流水线，协调检索、LLM 调用、工具执行和数据持久化。
//!
//! ## 流水线阶段
//! 1. 创建用户消息和助手消息
//! 2. 执行检索（RAG/图谱/记忆/网络搜索）- 并行执行
//! 3. 构建 system prompt
//! 4. 调用 LLM（流式）
//! 5. 处理工具调用（支持递归）
//! 6. 保存结果
//!
//! ## 约束
//! - 并行检索：使用 `tokio::join!`
//! - 取消支持：使用 `tokio_util::sync::CancellationToken`
//! - 工具并行：使用 `futures::future::join_all`
//! - 工具递归：最多递归 5 次
//! - 数据持久化：每个阶段完成后立即保存

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Window};
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::llm_manager::{LLMManager, LLMStreamHooks};

use super::approval_manager::{ApprovalManager, ApprovalRequest};
use super::database::ChatV2Database;
use super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE;
use super::tools::{
    AcademicSearchExecutor, AttemptCompletionExecutor, BuiltinResourceExecutor,
    BuiltinRetrievalExecutor, CanvasToolExecutor, ChatAnkiToolExecutor, ExecutionContext,
    FetchExecutor, GeneralToolExecutor, KnowledgeExecutor, MemoryToolExecutor,
    SkillsExecutor, TemplateDesignerExecutor, ToolExecutor, ToolExecutorRegistry,
    ToolSensitivity, WorkspaceToolExecutor,
};
use crate::database::Database as MainDatabase;
use crate::models::{ChatMessage as LegacyChatMessage, MultimodalContentPart, RagSourceInfo};
use crate::tools::web_search::{do_search, SearchInput, ToolConfig as WebSearchConfig};
use crate::tools::ToolRegistry;

use super::error::{ChatV2Error, ChatV2Result};
use super::events::{event_types, ChatV2EventEmitter};
use super::prompt_builder;
use super::repo::ChatV2Repo;
// 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db 的 VfsResourceRepo
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsResourceRepo;
// 🆕 VFS RAG 统一知识管理（2025-01）：使用 VFS 向量检索
use crate::vfs::indexing::{VfsFullSearchService, VfsSearchParams};
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::repos::MODALITY_TEXT;
use crate::vfs::multimodal_service::VfsMultimodalService;
// 🆕 MCP 工具注入支持：现在使用前端传递的 mcp_tool_schemas，无需后端 MCP Client
use super::context::PipelineContext;
use super::resource_types::{ContentBlock, ContextRef, ContextSnapshot};
use super::types::{
    block_status, block_types, feature_flags, variant_status, AttachmentInput, ChatMessage,
    MessageBlock, MessageMeta, MessageRole, MessageSources, SendMessageRequest, SendOptions,
    SharedContext, SourceInfo, TokenUsage, ToolCall, ToolResultInfo, Variant,
};
use super::user_message_builder::{build_user_message, UserMessageParams};
use super::workspace::WorkspaceCoordinator;
use std::sync::Mutex;

// ============================================================
// 常量定义
// ============================================================

/// 工具递归最大深度
pub(crate) const MAX_TOOL_RECURSION: u32 = 30;

/// 默认工具超时（毫秒）
pub(crate) const DEFAULT_TOOL_TIMEOUT_MS: u64 = 30_000;

/// 默认检索 TopK
pub(crate) const DEFAULT_RAG_TOP_K: u32 = 5;

/// 默认图谱检索 TopK
pub(crate) const DEFAULT_GRAPH_TOP_K: u32 = 10;

/// 默认多模态检索 TopK
pub(crate) const DEFAULT_MULTIMODAL_TOP_K: u32 = 10;

/// 🔧 P1修复：默认历史消息数量限制（条数，非 token）
/// context_limit 应该用于 LLM 的 token 限制，不应误用于消息条数
pub(crate) const DEFAULT_MAX_HISTORY_MESSAGES: usize = 50;

/// 🔧 P1修复：LLM 流式调用超时（秒）
/// 流式响应需要较长时间，设置为 10 分钟
pub(crate) const LLM_STREAM_TIMEOUT_SECS: u64 = 600;

/// 🔧 P1修复：LLM 非流式调用超时（秒）
/// 用于摘要生成等简单调用，设置为 2 分钟
pub(crate) const LLM_NON_STREAM_TIMEOUT_SECS: u64 = 120;

/// 判断一个字符串是否是 API 配置 ID 格式（而非模型显示名称）
///
/// 配置 ID 有两种已知格式：
/// 1. `builtin-*` — 内置模型配置（如 "builtin-deepseek-chat"）
/// 2. UUID v4 — 用户自建模型配置（如 "a1b2c3d4-e5f6-7890-abcd-ef1234567890"，36字符 8-4-4-4-12）
///
/// 不属于以上格式的字符串被认为是模型显示名称（如 "Qwen/Qwen3-8B"、"deepseek-chat"）。
fn is_config_id_format(id: &str) -> bool {
    if id.is_empty() {
        return false;
    }
    // 1. 内置配置 ID
    if id.starts_with("builtin-") {
        return true;
    }
    // 2. UUID v4 格式: 8-4-4-4-12 hex digits (total 36 chars with 4 hyphens)
    id.len() == 36
        && id.chars().filter(|c| *c == '-').count() == 4
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// 截断预览文本到指定字符数（用于笔记工具 diff 预览）
fn truncate_preview(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = chars[..max_chars].iter().collect();
        format!("{}...", truncated)
    }
}

// ============================================================
// 检索结果过滤配置（改进 3）
// ============================================================

/// 检索结果绝对最低分阈值
/// 低于此分数的结果直接剔除
pub(crate) const RETRIEVAL_MIN_SCORE: f32 = 0.3;

/// 检索结果相对阈值
/// 保留 >= 最高分 * 此比例的结果
pub(crate) const RETRIEVAL_RELATIVE_THRESHOLD: f32 = 0.5;

/// 批量重试变体参数
#[derive(Debug, Clone)]
pub(crate) struct VariantRetrySpec {
    pub variant_id: String,
    pub model_id: String,
    pub config_id: String,
}

// ============================================================
// 类型转换实现
// ============================================================

/// 从 RagSourceInfo 转换为 SourceInfo
impl From<RagSourceInfo> for SourceInfo {
    fn from(rag: RagSourceInfo) -> Self {
        Self {
            title: Some(rag.file_name.clone()),
            url: None,
            snippet: Some(rag.chunk_text.clone()),
            score: Some(rag.score),
            metadata: Some(json!({
                "documentId": rag.document_id,
                "chunkIndex": rag.chunk_index,
            })),
        }
    }
}

// ============================================================
// 辅助函数（改进 3 & 5）
// ============================================================

/// 过滤低相关性的检索结果（改进 3）
///
/// 使用阈值过滤和动态截断策略：
/// 1. 绝对阈值：score < min_score 的结果直接剔除
/// 2. 相对阈值：score < max_score * relative_threshold 的结果剔除
/// 3. 最大保留：保留最多 max_results 条结果
///
/// # 参数
/// - `sources`: 原始检索结果
/// - `min_score`: 绝对最低分阈值
/// - `relative_threshold`: 相对阈值（相对于最高分的比例）
/// - `max_results`: 最大保留数量
///
/// # 返回
/// 过滤后的检索结果（已按分数排序）
fn filter_retrieval_results(
    sources: Vec<SourceInfo>,
    min_score: f32,
    relative_threshold: f32,
    max_results: usize,
) -> Vec<SourceInfo> {
    if sources.is_empty() {
        return sources;
    }

    // 获取最高分
    let max_score = sources
        .iter()
        .filter_map(|s| s.score)
        .fold(0.0f32, |a, b| a.max(b));

    // 计算动态阈值：取绝对阈值和相对阈值中的较大者
    let dynamic_threshold = min_score.max(max_score * relative_threshold);

    // 过滤后按分数降序再截断，避免输入无序时丢失高分结果
    let before_count = sources.len();
    let mut filtered: Vec<SourceInfo> = sources
        .into_iter()
        .filter(|s| s.score.unwrap_or(0.0) >= dynamic_threshold)
        .collect();

    filtered.sort_by(|a, b| {
        b.score
            .unwrap_or(0.0)
            .partial_cmp(&a.score.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    filtered.truncate(max_results);

    let after_count = filtered.len();
    if before_count != after_count {
        log::debug!(
            "[ChatV2::pipeline] Filtered retrieval results: {} -> {} (threshold={:.3}, max_score={:.3})",
            before_count,
            after_count,
            dynamic_threshold,
            max_score
        );
    }

    filtered
}

fn approval_scope_setting_key(tool_name: &str, arguments: &Value) -> String {
    let serialized = serde_json::to_string(arguments).unwrap_or_else(|_| "null".to_string());
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    let fingerprint = hex::encode(hasher.finalize());
    format!("tool_approval.scope.{}.{}", tool_name, fingerprint)
}

/// 工具审批结果枚举
///
/// 区分用户主动操作与系统异常，使调用方能给出精确的错误消息。
/// - `Approved`：用户同意执行
/// - `Rejected`：用户明确拒绝
/// - `Timeout`：等待审批超时
/// - `ChannelClosed`：审批通道异常关闭
enum ApprovalOutcome {
    /// 用户同意执行
    Approved,
    /// 用户明确拒绝
    Rejected,
    /// 等待审批超时
    Timeout,
    /// 审批通道异常关闭
    ChannelClosed,
}

/// 验证工具调用链完整性（改进 5）
///
/// 检查聊天历史中的工具调用链是否完整：
/// - 每个 tool_call 必须有对应的 tool_result
/// - 记录未完成的调用数量
///
/// # 返回
/// - true: 工具链完整
/// - false: 存在未完成的工具调用
fn validate_tool_chain(chat_history: &[LegacyChatMessage]) -> bool {
    use std::collections::HashSet;

    let mut pending_calls: HashSet<String> = HashSet::new();

    for msg in chat_history {
        // 记录新的工具调用
        if let Some(ref tc) = msg.tool_call {
            pending_calls.insert(tc.id.clone());
        }
        // 移除已完成的工具调用
        if let Some(ref tr) = msg.tool_result {
            pending_calls.remove(&tr.call_id);
        }
    }

    if !pending_calls.is_empty() {
        log::warn!(
            "[ChatV2::pipeline] Incomplete tool chain detected: {} pending call(s): {:?}",
            pending_calls.len(),
            pending_calls
        );
    }

    pending_calls.is_empty()
}

/// 构建一个仅含 role/content 的空 ChatMessage，其余字段均为 None/默认值。
/// 用于合成消息构造，避免重复罗列 15+ 个 None 字段。
fn make_empty_message(role: &str, content: String) -> LegacyChatMessage {
    LegacyChatMessage {
        role: role.to_string(),
        content,
        timestamp: chrono::Utc::now(),
        thinking_content: None,
        thought_signature: None,
        rag_sources: None,
        memory_sources: None,
        graph_sources: None,
        web_search_sources: None,
        image_paths: None,
        image_base64: None,
        doc_attachments: None,
        multimodal_content: None,
        tool_call: None,
        tool_result: None,
        overrides: None,
        relations: None,
        persistent_stable_id: None,
        metadata: None,
    }
}

/// 🆕 2026-02-22: 为已激活的默认技能自动注入合成 load_skills 工具交互
///
/// 模型对 `role: tool` 结果中的指令遵循度远高于 user message 中的 XML 块。
/// 此函数在消息历史开头 prepend 一对合成的 assistant(tool_call) + tool(result) 消息，
/// 与真实 `load_skills` 返回格式完全一致。
///
/// 跳过条件：
/// - 没有 active_skill_ids 或 skill_contents
/// - 历史中已存在真实的 load_skills 调用（避免 regenerate/retry 时重复注入）
fn inject_synthetic_load_skills(
    chat_history: &mut Vec<LegacyChatMessage>,
    options: &SendOptions,
) {
    let active_ids = match options.active_skill_ids.as_ref() {
        Some(ids) if !ids.is_empty() => ids,
        _ => return,
    };
    let skill_contents = match options.skill_contents.as_ref() {
        Some(sc) if !sc.is_empty() => sc,
        _ => return,
    };

    // 收集有内容的已激活技能
    let skills_to_inject: Vec<(&String, &String)> = active_ids
        .iter()
        .filter_map(|id| skill_contents.get(id).map(|content| (id, content)))
        .collect();

    if skills_to_inject.is_empty() {
        return;
    }

    // 检查历史中是否已有真实的 load_skills 调用（regenerate/retry 场景）
    let has_existing_load_skills = chat_history.iter().any(|m| {
        m.tool_call
            .as_ref()
            .map_or(false, |tc| SkillsExecutor::is_load_skills_tool(&tc.tool_name))
    });

    if has_existing_load_skills {
        log::debug!(
            "[ChatV2::pipeline] Skipping synthetic load_skills: history already contains real load_skills call"
        );
        return;
    }

    // 构建合成的 load_skills 工具交互（与 SkillsExecutor 输出格式一致）
    let skill_ids: Vec<&str> = skills_to_inject.iter().map(|(id, _)| id.as_str()).collect();
    let tool_call_id = format!("tc_auto_skills_{}", uuid::Uuid::new_v4().simple());

    // 1. 合成 assistant 消息（tool_call: load_skills）
    let tool_call_args = json!({ "skills": skill_ids });
    let mut assistant_msg = make_empty_message("assistant", String::new());
    assistant_msg.tool_call = Some(crate::models::ToolCall {
        id: tool_call_id.clone(),
        tool_name: "load_skills".to_string(),
        args_json: tool_call_args,
    });

    // 2. 构建工具结果内容（与 SkillsExecutor 格式一致）
    let mut content_parts: Vec<String> = Vec::with_capacity(skills_to_inject.len() + 1);
    for (skill_id, content) in &skills_to_inject {
        content_parts.push(format!(
            "<skill_loaded id=\"{}\">\n<instructions>\n{}\n</instructions>\n</skill_loaded>",
            skill_id, content
        ));
    }
    content_parts.push(format!(
        "\n共加载 {} 个技能。这些工具现在可以使用了。",
        skills_to_inject.len()
    ));
    let full_content = content_parts.join("\n");
    let content_len = full_content.len();

    let mut tool_msg = make_empty_message("tool", full_content);
    tool_msg.tool_result = Some(crate::models::ToolResult {
        call_id: tool_call_id,
        ok: true,
        error: None,
        error_details: None,
        data_json: None,
        usage: None,
        citations: None,
    });

    // 3. Prepend 到消息历史开头（这两条消息会出现在 [LLM_REVIEW_DEBUG] 请求体日志中）
    log::info!(
        "[ChatV2::pipeline] 🆕 Synthetic load_skills injected: {} skill(s) {:?}, content_len={}, history {} -> {} messages",
        skills_to_inject.len(),
        skill_ids,
        content_len,
        chat_history.len(),
        chat_history.len() + 2
    );
    chat_history.insert(0, assistant_msg);
    chat_history.insert(1, tool_msg);
}

// ============================================================
// LLM 流式适配器
// ============================================================

/// 解析 API 返回的 usage 信息
///
/// 支持多种 LLM API 响应格式：
/// - **OpenAI 格式**: `prompt_tokens`, `completion_tokens`, `total_tokens`
/// - **Anthropic 格式**: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`
/// - **DeepSeek 格式**: `prompt_tokens`, `completion_tokens`, `reasoning_tokens`
///
/// # 参数
/// - `usage`: API 返回的 usage JSON 对象
///
/// # 返回
/// - `Some(TokenUsage)`: 解析成功
/// - `None`: 解析失败（格式不支持或字段缺失）
pub fn parse_api_usage(usage: &Value) -> Option<TokenUsage> {
    // 尝试 OpenAI 格式: prompt_tokens, completion_tokens
    let prompt_tokens = usage
        .get("prompt_tokens")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);

    let completion_tokens = usage
        .get("completion_tokens")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);

    // 尝试 Anthropic 格式: input_tokens, output_tokens
    let input_tokens = usage
        .get("input_tokens")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);

    let output_tokens = usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);

    // 确定 prompt 和 completion tokens
    let (prompt, completion) = match (
        prompt_tokens,
        completion_tokens,
        input_tokens,
        output_tokens,
    ) {
        // OpenAI 格式优先
        (Some(p), Some(c), _, _) => (p, c),
        // Anthropic 格式兜底
        (_, _, Some(i), Some(o)) => (i, o),
        // 部分字段存在
        (Some(p), None, _, _) => (p, 0),
        (None, Some(c), _, _) => (0, c),
        (_, _, Some(i), None) => (i, 0),
        (_, _, None, Some(o)) => (0, o),
        // 无法解析
        _ => return None,
    };

    // 提取 reasoning_tokens
    // - 顶层 reasoning_tokens（部分中转站/旧格式）
    // - 嵌套 completion_tokens_details.reasoning_tokens（OpenAI o系列/DeepSeek V3+ 标准格式）
    let reasoning_tokens = usage
        .get("reasoning_tokens")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .or_else(|| {
            usage
                .get("completion_tokens_details")
                .and_then(|d| d.get("reasoning_tokens"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
        });

    // 提取 cached_tokens
    // - Anthropic 格式：cache_creation_input_tokens + cache_read_input_tokens（应相加）
    // - OpenAI 格式：prompt_tokens_details.cached_tokens
    let anthropic_cache_creation = usage
        .get("cache_creation_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let anthropic_cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let openai_cached = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let total_cached = anthropic_cache_creation + anthropic_cache_read + openai_cached;
    let cached_tokens = if total_cached > 0 {
        Some(total_cached)
    } else {
        None
    };

    Some(TokenUsage::from_api_with_cache(
        prompt,
        completion,
        reasoning_tokens,
        cached_tokens,
    ))
}

/// Chat V2 LLM 流式回调适配器
///
/// 实现 `LLMStreamHooks` trait，将 LLM 流式事件转换为 Chat V2 块级事件。
/// 同时收集工具调用请求，供递归处理使用。
///
/// 🔧 支持 `<think>` 标签解析：某些中转站（如 yunwu.ai）不支持 Anthropic 的 Extended Thinking API，
/// 而是将思维链作为 `<think>` 标签嵌入到普通内容中返回。此适配器实时解析这些标签，
/// 将内容正确路由到 thinking 或 content 块。
pub struct ChatV2LLMAdapter {
    emitter: Arc<ChatV2EventEmitter>,
    message_id: String,
    enable_thinking: bool,
    /// thinking 块 ID（活跃的）
    thinking_block_id: std::sync::Mutex<Option<String>>,
    /// 🔧 修复：已结束的 thinking 块 ID（finalize 后保留，确保 collect_round_blocks 能获取）
    finalized_thinking_block_id: std::sync::Mutex<Option<String>>,
    /// content 块 ID
    content_block_id: std::sync::Mutex<Option<String>>,
    /// 累积的内容
    accumulated_content: std::sync::Mutex<String>,
    /// 累积的推理
    accumulated_reasoning: std::sync::Mutex<String>,
    /// 收集的工具调用（用于递归处理）
    collected_tool_calls: std::sync::Mutex<Vec<ToolCall>>,
    /// 存储 API 返回的 usage（用于 Token 统计）
    api_usage: std::sync::Mutex<Option<TokenUsage>>,
    /// 🔧 <think> 标签解析状态：是否当前在 <think> 标签内部
    in_think_tag: std::sync::Mutex<bool>,
    /// 🔧 <think> 标签解析缓冲区：用于处理跨 chunk 的标签边界
    think_tag_buffer: std::sync::Mutex<String>,
}

impl ChatV2LLMAdapter {
    pub fn new(
        emitter: Arc<ChatV2EventEmitter>,
        message_id: String,
        enable_thinking: bool,
    ) -> Self {
        Self {
            emitter,
            message_id,
            enable_thinking,
            thinking_block_id: std::sync::Mutex::new(None),
            finalized_thinking_block_id: std::sync::Mutex::new(None),
            content_block_id: std::sync::Mutex::new(None),
            accumulated_content: std::sync::Mutex::new(String::new()),
            accumulated_reasoning: std::sync::Mutex::new(String::new()),
            collected_tool_calls: std::sync::Mutex::new(Vec::new()),
            api_usage: std::sync::Mutex::new(None),
            in_think_tag: std::sync::Mutex::new(false),
            think_tag_buffer: std::sync::Mutex::new(String::new()),
        }
    }

    /// 生成块 ID
    pub(crate) fn generate_block_id() -> String {
        format!("blk_{}", Uuid::new_v4())
    }

    /// 确保 thinking 块已启动
    fn ensure_thinking_started(&self) -> Option<String> {
        if !self.enable_thinking {
            return None;
        }

        let mut guard = self
            .thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let block_id = Self::generate_block_id();
            self.emitter.emit_start(
                event_types::THINKING,
                &self.message_id,
                Some(&block_id),
                None,
                None, // variant_id
            );
            *guard = Some(block_id.clone());
        }
        guard.clone()
    }

    /// 确保 content 块已启动（必须在 thinking 块之后）
    fn ensure_content_started(&self) -> String {
        // 先结束 thinking 块（如果有）
        self.finalize_thinking();

        let mut guard = self
            .content_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard.clone() {
            existing
        } else {
            let block_id = Self::generate_block_id();
            self.emitter.emit_start(
                event_types::CONTENT,
                &self.message_id,
                Some(&block_id),
                None,
                None, // variant_id
            );
            *guard = Some(block_id.clone());
            block_id
        }
    }

    /// 结束 thinking 块
    fn finalize_thinking(&self) {
        let mut guard = self
            .thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(block_id) = guard.take() {
            // 🔧 修复：备份 thinking 块 ID，确保 collect_round_blocks 能获取
            *self
                .finalized_thinking_block_id
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(block_id.clone());
            self.emitter
                .emit_end(event_types::THINKING, &block_id, None, None); // variant_id
        }
    }

    /// 结束所有活跃块
    pub fn finalize_all(&self) {
        // 🔧 先处理缓冲区中剩余的内容
        self.flush_think_tag_buffer();

        // 结束 thinking
        self.finalize_thinking();

        // 结束 content
        let content_guard = self
            .content_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(ref block_id) = *content_guard {
            self.emitter
                .emit_end(event_types::CONTENT, block_id, None, None); // variant_id
        }
        // 🔧 P0修复：工具块的结束事件由 execute_single_tool 直接发射，不再在这里处理
    }

    /// 🔧 刷新 think 标签缓冲区中剩余的内容
    fn flush_think_tag_buffer(&self) {
        let mut buffer = self
            .think_tag_buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        if buffer.is_empty() {
            return;
        }

        let remaining = std::mem::take(&mut *buffer);
        let in_think = *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner());
        drop(buffer);

        if in_think && self.enable_thinking {
            // 剩余内容属于 thinking（未闭合的 think 标签）
            log::warn!(
                "[ChatV2::LLMAdapter] Flushing unclosed <think> tag content: {} chars",
                remaining.len()
            );
            {
                let mut guard = self
                    .accumulated_reasoning
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                guard.push_str(&remaining);
            }
            if let Some(block_id) = self.ensure_thinking_started() {
                self.emitter
                    .emit_chunk(event_types::THINKING, &block_id, &remaining, None);
            }
        } else if !remaining.is_empty() {
            // 剩余内容属于 content
            {
                let mut guard = self
                    .accumulated_content
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                guard.push_str(&remaining);
            }
            let block_id = self.ensure_content_started();
            self.emitter
                .emit_chunk(event_types::CONTENT, &block_id, &remaining, None);
        }
    }

    /// 获取累积的内容
    pub fn get_accumulated_content(&self) -> String {
        self.accumulated_content
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 获取累积的推理
    pub fn get_accumulated_reasoning(&self) -> Option<String> {
        let reasoning = self
            .accumulated_reasoning
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        log::info!(
            "[ChatV2::LLMAdapter] get_accumulated_reasoning: len={}, is_empty={}",
            reasoning.len(),
            reasoning.is_empty()
        );
        if reasoning.is_empty() {
            None
        } else {
            Some(reasoning)
        }
    }

    /// 获取 thinking 块 ID（如果存在）
    /// 🔧 修复：优先返回已结束的 thinking 块 ID（因为 finalize_thinking 会清空活跃 ID）
    pub fn get_thinking_block_id(&self) -> Option<String> {
        // 先检查已结束的 thinking 块 ID
        let finalized = self
            .finalized_thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if finalized.is_some() {
            return finalized;
        }
        // 否则返回活跃的 thinking 块 ID
        self.thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 获取 content 块 ID（如果存在）
    pub fn get_content_block_id(&self) -> Option<String> {
        self.content_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 获取并清空收集的工具调用
    ///
    /// 用于在 LLM 调用完成后获取需要执行的工具调用。
    /// 调用此方法会清空内部收集的工具调用列表。
    pub fn take_tool_calls(&self) -> Vec<ToolCall> {
        let mut guard = self
            .collected_tool_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *guard)
    }

    /// 检查是否有待处理的工具调用
    pub fn has_tool_calls(&self) -> bool {
        let guard = self
            .collected_tool_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        !guard.is_empty()
    }

    /// 获取 API 返回的 usage（如果有）
    ///
    /// 返回 LLM API 在流式响应中返回的 token 使用量。
    /// 如果 API 未返回 usage 信息，则返回 None。
    pub fn get_api_usage(&self) -> Option<TokenUsage> {
        self.api_usage
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 处理 LLM 调用错误
    ///
    /// 发射错误事件到所有活跃块，并结束流式处理。
    pub fn on_error(&self, error: &str) {
        log::error!(
            "[ChatV2::pipeline] LLM adapter error for message {}: {}",
            self.message_id,
            error
        );

        // 如果 content 块已启动但未结束，发射错误事件
        let content_guard = self
            .content_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(ref block_id) = *content_guard {
            self.emitter
                .emit_error(event_types::CONTENT, block_id, error, None);
        }

        // 结束 thinking 块（如果有）
        self.finalize_thinking();

        // 🔧 P0修复：工具块的错误事件由 execute_single_tool 直接发射，不再在这里处理
    }

    /// 🔧 P0修复：检查字符串是否以可能的 <think> 或 <thinking> 标签开始前缀结尾
    ///
    /// 这个函数精确检测标签前缀，避免误匹配 <table>, <td>, <tr> 等 HTML 标签。
    /// 只有当字符串以 `<`, `<t`, `<th`, `<thi`, `<thin`, `<think`, `<thinki`, `<thinkin`, `<thinking` 结尾时返回 true。
    fn ends_with_potential_think_start(s: &str) -> bool {
        const PREFIXES: &[&str] = &[
            "<thinking",
            "<thinkin",
            "<thinki",
            "<think",
            "<thin",
            "<thi",
            "<th",
            "<t",
            "<",
        ];
        // 检查是否以任何可能的标签前缀结尾
        for prefix in PREFIXES {
            if s.ends_with(prefix) {
                return true;
            }
        }
        false
    }

    /// 🔧 P0修复：检查字符串是否以可能的 </think> 或 </thinking> 标签结束前缀结尾
    ///
    /// 这个函数精确检测结束标签前缀，避免误匹配 </table>, </td> 等 HTML 标签。
    fn ends_with_potential_think_end(s: &str) -> bool {
        const PREFIXES: &[&str] = &[
            "</thinking",
            "</thinkin",
            "</thinki",
            "</think",
            "</thin",
            "</thi",
            "</th",
            "</t",
            "</",
            "<",
        ];
        for prefix in PREFIXES {
            if s.ends_with(prefix) {
                return true;
            }
        }
        false
    }

    fn is_builtin_retrieval_tool(tool_name: &str) -> bool {
        if let Some(stripped) = tool_name.strip_prefix("builtin-") {
            matches!(
                stripped,
                "rag_search"
                    | "multimodal_search"
                    | "unified_search"
                    | "memory_search"
                    | "web_search"
            )
        } else {
            false
        }
    }

    /// 🔧 处理 think 标签缓冲区，将内容路由到 thinking 或 content 块
    ///
    /// 支持中转站返回的 `<think>...</think>` 或 `<thinking>...</thinking>` 格式
    fn process_think_tag_buffer(&self) {
        // 开始标签模式（支持 <think> 和 <thinking>）
        const START_TAGS: &[&str] = &["<thinking>", "<think>"];
        // 结束标签模式（支持 </think> 和 </thinking>）
        const END_TAGS: &[&str] = &["</thinking>", "</think>"];

        loop {
            let mut buffer = self
                .think_tag_buffer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let in_think = *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner());

            if buffer.is_empty() {
                return;
            }

            if in_think {
                // 当前在 <think> 标签内，寻找结束标签
                let mut found_end = false;
                let mut end_pos = 0;
                let mut tag_len = 0;

                for end_tag in END_TAGS {
                    if let Some(pos) = buffer.find(end_tag) {
                        if !found_end || pos < end_pos {
                            found_end = true;
                            end_pos = pos;
                            tag_len = end_tag.len();
                        }
                    }
                }

                if found_end {
                    // 找到结束标签，输出 thinking 内容
                    let thinking_content: String = buffer.drain(..end_pos).collect();
                    // 移除结束标签
                    let _: String = buffer.drain(..tag_len).collect();
                    drop(buffer);

                    if !thinking_content.is_empty() && self.enable_thinking {
                        // 累积推理内容
                        {
                            let mut guard = self
                                .accumulated_reasoning
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            guard.push_str(&thinking_content);
                        }
                        // 发射 thinking chunk
                        if let Some(block_id) = self.ensure_thinking_started() {
                            self.emitter.emit_chunk(
                                event_types::THINKING,
                                &block_id,
                                &thinking_content,
                                None,
                            );
                        }
                    }

                    // 退出 thinking 模式
                    *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner()) = false;
                    // 继续处理剩余内容
                } else {
                    // 未找到完整的结束标签，检查是否有潜在的不完整标签
                    if Self::ends_with_potential_think_end(&buffer) {
                        // 保留可能的不完整标签，等待更多数据
                        return;
                    }
                    // 没有潜在标签，输出所有内容到 thinking
                    let thinking_content = std::mem::take(&mut *buffer);
                    drop(buffer);

                    if !thinking_content.is_empty() && self.enable_thinking {
                        {
                            let mut guard = self
                                .accumulated_reasoning
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            guard.push_str(&thinking_content);
                        }
                        if let Some(block_id) = self.ensure_thinking_started() {
                            self.emitter.emit_chunk(
                                event_types::THINKING,
                                &block_id,
                                &thinking_content,
                                None,
                            );
                        }
                    }
                    return;
                }
            } else {
                // 当前不在 <think> 标签内，寻找开始标签
                let mut found_start = false;
                let mut start_pos = 0;
                let mut tag_len = 0;

                for start_tag in START_TAGS {
                    if let Some(pos) = buffer.find(start_tag) {
                        if !found_start || pos < start_pos {
                            found_start = true;
                            start_pos = pos;
                            tag_len = start_tag.len();
                        }
                    }
                }

                if found_start {
                    // 找到开始标签，先输出标签前的 content
                    let content_before: String = buffer.drain(..start_pos).collect();
                    // 移除开始标签
                    let _: String = buffer.drain(..tag_len).collect();
                    drop(buffer);

                    if !content_before.is_empty() {
                        // 累积内容
                        {
                            let mut guard = self
                                .accumulated_content
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            guard.push_str(&content_before);
                        }
                        // 发射 content chunk
                        let block_id = self.ensure_content_started();
                        self.emitter.emit_chunk(
                            event_types::CONTENT,
                            &block_id,
                            &content_before,
                            None,
                        );
                    }

                    // 进入 thinking 模式
                    *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner()) = true;
                    // 继续处理剩余内容
                } else {
                    // 未找到完整的开始标签，检查是否有潜在的不完整标签
                    if Self::ends_with_potential_think_start(&buffer) {
                        // 找到最后一个 '<' 的位置，保留可能的不完整标签
                        if let Some(lt_pos) = buffer.rfind('<') {
                            // 输出 '<' 之前的内容
                            let content_before: String = buffer.drain(..lt_pos).collect();
                            drop(buffer);

                            if !content_before.is_empty() {
                                {
                                    let mut guard = self
                                        .accumulated_content
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner());
                                    guard.push_str(&content_before);
                                }
                                let block_id = self.ensure_content_started();
                                self.emitter.emit_chunk(
                                    event_types::CONTENT,
                                    &block_id,
                                    &content_before,
                                    None,
                                );
                            }
                        }
                        return;
                    }
                    // 没有潜在标签，输出所有内容到 content
                    let content = std::mem::take(&mut *buffer);
                    drop(buffer);

                    if !content.is_empty() {
                        {
                            let mut guard = self
                                .accumulated_content
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            guard.push_str(&content);
                        }
                        let block_id = self.ensure_content_started();
                        self.emitter
                            .emit_chunk(event_types::CONTENT, &block_id, &content, None);
                    }
                    return;
                }
            }
        }
    }
}

impl LLMStreamHooks for ChatV2LLMAdapter {
    /// 🔧 增强的 on_content_chunk：支持 `<think>` 标签实时解析
    ///
    /// 某些中转站不支持 Anthropic Extended Thinking API，而是将思维链作为
    /// `<think>...</think>` 或 `<thinking>...</thinking>` 标签嵌入到普通内容中。
    /// 此方法实时解析这些标签，将内容正确路由到 thinking 或 content 块。
    fn on_content_chunk(&self, text: &str) {
        if text.is_empty() {
            return;
        }

        // 🔧 <think> 标签解析：将 chunk 追加到缓冲区并处理
        {
            let mut buffer = self
                .think_tag_buffer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            buffer.push_str(text);
        }
        self.process_think_tag_buffer();
    }

    fn on_reasoning_chunk(&self, text: &str) {
        if text.is_empty() || !self.enable_thinking {
            return;
        }

        // 累积推理（简化日志：只输出 / 代表接收到 chunk）
        {
            let mut guard = self
                .accumulated_reasoning
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            guard.push_str(text);
            // 每 500 字符输出一个 / 以减少日志量
            if guard.len() % 500 < text.len() {
                print!("/");
                use std::io::Write;
                let _ = std::io::stdout().flush();
            }
        }

        if let Some(block_id) = self.ensure_thinking_started() {
            self.emitter
                .emit_chunk(event_types::THINKING, &block_id, text, None);
        }
    }

    /// 🆕 2026-01-15: 工具调用参数开始累积时通知前端
    /// 在 LLM 开始生成工具调用参数时立即调用，让前端显示"正在准备工具调用"
    fn on_tool_call_start(&self, tool_call_id: &str, tool_name: &str) {
        log::info!(
            "[ChatV2::pipeline] Tool call start: id={}, name={} (参数累积中...)",
            tool_call_id,
            tool_name
        );

        // 🔧 2026-01-16: 检索工具（builtin-*）有自己的事件类型和块渲染器
        // 如果发射 tool_call_preparing，会创建一个 mcp_tool 类型的 preparing 块
        // 但检索工具的 execute_* 方法会创建另一个检索类型块（如 web_search）
        // 由于检索工具不发射 tool_call_start，preparing 块不会被复用，导致两个块
        // 解决方案：检索工具跳过 tool_call_preparing 事件
        if Self::is_builtin_retrieval_tool(tool_name) {
            log::debug!(
                "[ChatV2::pipeline] Skipping tool_call_preparing for builtin retrieval tool: {}",
                tool_name
            );
            return;
        }

        // 发射 tool_call_preparing 事件，让前端显示"正在准备工具调用"状态
        // 使用新的事件类型，前端可以据此显示工具调用准备中的 UI
        self.emitter
            .emit_tool_call_preparing(&self.message_id, tool_call_id, tool_name);
    }

    fn on_tool_call(&self, msg: &LegacyChatMessage) {
        // 从 ChatMessage 中提取工具调用信息
        if let Some(ref tool_call) = msg.tool_call {
            let tool_call_id = &tool_call.id;
            let tool_name = &tool_call.tool_name;
            let tool_input = tool_call.args_json.clone();

            // 🔧 P0修复：移除 block_id 生成和 active_tool_blocks 映射
            // block_id 统一在 execute_single_tool 中生成，并记录到 ToolResultInfo.block_id
            // 这避免了前端事件 block_id 和数据库保存 block_id 不一致的问题

            // 收集工具调用信息供 Pipeline 执行
            {
                let mut guard = self
                    .collected_tool_calls
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                guard.push(ToolCall {
                    id: tool_call_id.clone(),
                    name: tool_name.clone(),
                    arguments: tool_input.clone(),
                });
                log::info!(
                    "[ChatV2::pipeline] Collected tool call: id={}, name={}",
                    tool_call_id,
                    tool_name
                );
            }

            // 🔧 P0修复：不再发射 start 事件
            // start/end 事件统一由 execute_single_tool 发射
        }
    }

    fn on_tool_result(&self, msg: &LegacyChatMessage) {
        // 🔧 P0修复：由于 disable_tools=true，LLM Manager 不会内部执行工具
        // 因此这个回调不会被调用。工具结果事件由 execute_single_tool 直接发射。
        // 保留此方法仅为满足 LLMStreamHooks trait 要求。
        if let Some(ref tool_result) = msg.tool_result {
            log::debug!(
                "[ChatV2::pipeline] on_tool_result called (unexpected in Chat V2): call_id={}",
                tool_result.call_id
            );
        }
    }

    fn on_usage(&self, usage: &Value) {
        // 解析 API 返回的 usage，支持多种格式
        // 注意：流式响应中每个 token 都会触发 usage 更新，这里只存储不打印日志
        // 最终 usage 会在 LLM 调用结束后的 Token usage for round 日志中输出
        let token_usage = parse_api_usage(usage);

        if let Some(u) = token_usage {
            // 存储到 api_usage 字段（多次调用时覆盖之前的值）
            let mut guard = self.api_usage.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(u);
        }
        // 移除每次调用的日志输出，避免流式响应时产生大量重复日志
    }

    fn on_complete(&self, _final_text: &str, _reasoning: Option<&str>) {
        self.finalize_all();
    }
}

// ============================================================
// 流水线主结构
// ============================================================

/// Chat V2 编排引擎
///
/// 协调整个消息发送流程，包括：
/// - 消息创建
/// - 检索执行
/// - LLM 调用
/// - 工具处理
/// - 数据持久化
#[derive(Clone)]
pub struct ChatV2Pipeline {
    db: Arc<ChatV2Database>,
    /// 主数据库（用于工具调用读取用户配置）
    main_db: Option<Arc<MainDatabase>>,
    /// Anki 数据库（用于 Anki 制卡工具进度查询）
    anki_db: Option<Arc<MainDatabase>>,
    /// VFS 数据库（用于统一资源存储）
    /// 🆕 VFS 统一存储（2025-12-07）：所有资源操作使用此数据库
    vfs_db: Option<Arc<VfsDatabase>>,
    llm_manager: Arc<LLMManager>,
    tool_registry: Arc<ToolRegistry>,
    /// 笔记管理器（用于 Canvas 工具调用）
    notes_manager: Option<Arc<crate::notes_manager::NotesManager>>,
    /// 🆕 工具执行器注册表（文档 29 P0-1）
    executor_registry: Arc<ToolExecutorRegistry>,
    /// 🆕 工具审批管理器（文档 29 P1-3）
    approval_manager: Option<Arc<ApprovalManager>>,
    workspace_coordinator: Option<Arc<WorkspaceCoordinator>>,
    /// 🆕 智能题目集服务（用于 qbank_* MCP 工具，2026-01）
    question_bank_service: Option<Arc<crate::question_bank_service::QuestionBankService>>,
    /// 🆕 PDF 处理服务（用于论文保存后触发 OCR/压缩 Pipeline）
    pdf_processing_service: Option<Arc<crate::vfs::pdf_processing_service::PdfProcessingService>>,
}

impl ChatV2Pipeline {
    /// 创建新的流水线实例
    ///
    /// ## 参数
    /// - `db`: Chat V2 独立数据库
    /// - `main_db`: 主数据库（可选，用于工具调用读取用户配置）
    /// - `vfs_db`: VFS 数据库（可选，用于统一资源存储）
    /// - `llm_manager`: LLM 管理器
    /// - `tool_registry`: 工具注册表
    /// - `notes_manager`: 笔记管理器（可选，用于 Canvas 工具调用）
    ///
    pub fn new(
        db: Arc<ChatV2Database>,
        main_db: Option<Arc<MainDatabase>>,
        anki_db: Option<Arc<MainDatabase>>,
        vfs_db: Option<Arc<VfsDatabase>>,
        llm_manager: Arc<LLMManager>,
        tool_registry: Arc<ToolRegistry>,
        notes_manager: Option<Arc<crate::notes_manager::NotesManager>>,
    ) -> Self {
        // 🆕 初始化工具执行器注册表（文档 29 P0-1）
        let executor_registry = Self::create_executor_registry();

        Self {
            db,
            main_db,
            anki_db,
            vfs_db,
            llm_manager,
            tool_registry,
            notes_manager,
            executor_registry,
            approval_manager: None,
            workspace_coordinator: None,
            question_bank_service: None,
            pdf_processing_service: None,
        }
    }

    /// 设置审批管理器
    ///
    /// 🆕 文档 29 P1-3：敏感工具需要用户审批
    pub fn with_approval_manager(mut self, approval_manager: Arc<ApprovalManager>) -> Self {
        self.approval_manager = Some(approval_manager);
        self
    }

    pub fn with_workspace_coordinator(mut self, coordinator: Arc<WorkspaceCoordinator>) -> Self {
        self.workspace_coordinator = Some(coordinator.clone());
        self.executor_registry = Self::create_executor_registry_with_workspace(Some(coordinator));
        self
    }

    /// 🆕 设置智能题目集服务（用于 qbank_* MCP 工具，2026-01）
    pub fn with_question_bank_service(
        mut self,
        service: Arc<crate::question_bank_service::QuestionBankService>,
    ) -> Self {
        self.question_bank_service = Some(service);
        self
    }

    /// 🆕 设置 PDF 处理服务（用于论文保存后触发 OCR/压缩 Pipeline）
    pub fn with_pdf_processing_service(
        mut self,
        service: Option<Arc<crate::vfs::pdf_processing_service::PdfProcessingService>>,
    ) -> Self {
        self.pdf_processing_service = service;
        self
    }

    fn create_executor_registry() -> Arc<ToolExecutorRegistry> {
        Self::create_executor_registry_with_workspace(None)
    }

    fn create_executor_registry_with_workspace(
        workspace_coordinator: Option<Arc<WorkspaceCoordinator>>,
    ) -> Arc<ToolExecutorRegistry> {
        let mut registry = ToolExecutorRegistry::new();

        registry.register(Arc::new(AttemptCompletionExecutor::new()));
        registry.register(Arc::new(CanvasToolExecutor::new()));
        // AnkiToolExecutor 已移除 — 旧 CardForge 2.0 管线由 ChatAnki 完全接管
        registry.register(Arc::new(ChatAnkiToolExecutor::new()));
        registry.register(Arc::new(BuiltinRetrievalExecutor::new()));
        registry.register(Arc::new(BuiltinResourceExecutor::new()));
        registry.register(Arc::new(super::tools::AttachmentToolExecutor::new())); // 🆕 附件工具执行器（解决 P0 断裂点）
        registry.register(Arc::new(FetchExecutor::new())); // 🆕 内置 Web Fetch 工具
        registry.register(Arc::new(AcademicSearchExecutor::new())); // 🆕 学术论文搜索工具（arXiv + OpenAlex）
        registry.register(Arc::new(super::tools::PaperSaveExecutor::new())); // 🆕 论文保存+引用格式化工具
        registry.register(Arc::new(KnowledgeExecutor::new()));
        registry.register(Arc::new(super::tools::TodoListExecutor::new()));
        registry.register(Arc::new(super::tools::qbank_executor::QBankExecutor::new()));
        registry.register(Arc::new(MemoryToolExecutor::new()));
        registry.register(Arc::new(super::tools::SkillsExecutor::new())); // 🆕 Skills 工具执行器（渐进披露架构）
        registry.register(Arc::new(TemplateDesignerExecutor::new())); // 🆕 模板设计师工具执行器
        registry.register(Arc::new(super::tools::AskUserExecutor::new())); // 🆕 用户提问工具执行器
        registry.register(Arc::new(super::tools::DocxToolExecutor::new())); // 🆕 DOCX 文档读写工具执行器
        registry.register(Arc::new(super::tools::PptxToolExecutor::new())); // 🆕 PPTX 演示文稿读写工具执行器
        registry.register(Arc::new(super::tools::XlsxToolExecutor::new())); // 🆕 XLSX 电子表格读写工具执行器

        if let Some(coordinator) = workspace_coordinator {
            registry.register(Arc::new(WorkspaceToolExecutor::new(coordinator.clone())));
            // 注册 SubagentExecutor（subagent_call 语法糖）
            registry.register(Arc::new(super::tools::SubagentExecutor::new(
                coordinator.clone(),
            )));
            // 🆕 注册 CoordinatorSleepExecutor（主代理睡眠/唤醒机制）
            registry.register(Arc::new(super::tools::CoordinatorSleepExecutor::new(
                coordinator,
            )));
        }

        registry.register(Arc::new(GeneralToolExecutor::new()));

        log::info!(
            "[ChatV2::pipeline] ToolExecutorRegistry initialized with {} executors: {:?}",
            registry.len(),
            registry.executor_names()
        );

        Arc::new(registry)
    }

    /// 根据工具名称判断正确的 block_type
    ///
    /// 检索工具使用对应的检索块类型，其他工具使用 mcp_tool 类型。
    /// 这确保前端渲染时使用正确的块渲染器。
    ///
    /// ## 参数
    /// - `tool_name`: 工具名称（可能带有 builtin- 前缀）
    ///
    /// ## 返回
    /// 对应的 block_type 字符串
    fn tool_name_to_block_type(tool_name: &str) -> String {
        let stripped = Self::normalize_tool_name_for_skill_match(tool_name);

        match stripped {
            "rag_search" | "multimodal_search" | "unified_search" => block_types::RAG.to_string(),
            "memory_search" => block_types::MEMORY.to_string(),
            "web_search" => block_types::WEB_SEARCH.to_string(),
            "ask_user" => block_types::ASK_USER.to_string(),
            _ => block_types::MCP_TOOL.to_string(),
        }
    }

    pub(crate) fn normalize_tool_name_for_skill_match(tool_name: &str) -> &str {
        tool_name
            .strip_prefix("builtin-")
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name)
    }

    pub(crate) fn skill_allows_tool(tool_name: &str, allowed: &str) -> bool {
        let tool_raw = tool_name.to_lowercase();
        let allowed_raw = allowed.to_lowercase();

        let tool_normalized = Self::normalize_tool_name_for_skill_match(&tool_raw);
        let allowed_normalized = Self::normalize_tool_name_for_skill_match(&allowed_raw);

        tool_raw == allowed_raw
            || tool_normalized == allowed_normalized
            || tool_normalized.starts_with(&format!("{}_", allowed_normalized))
            || tool_normalized.starts_with(allowed_normalized)
    }

    /// 执行消息发送流水线
    ///
    /// ## 流程
    /// 1. 创建用户消息和助手消息
    /// 2. 执行检索（RAG/图谱/记忆/网络搜索）
    /// 3. 构建 system prompt
    /// 4. 调用 LLM（流式）
    /// 5. 处理工具调用
    /// 6. 保存结果
    ///
    /// ## 参数
    /// - `window`: Tauri 窗口，用于事件发射
    /// - `request`: 发送消息请求
    /// - `cancel_token`: 取消令牌
    ///
    /// ## 返回
    /// 助手消息 ID
    /// 🔧 P1修复：添加 chat_v2_state 参数，用于注册每个变体的 cancel token
    pub async fn execute(
        &self,
        window: Window,
        mut request: SendMessageRequest,
        cancel_token: CancellationToken,
        chat_v2_state: Option<Arc<super::state::ChatV2State>>,
    ) -> ChatV2Result<String> {
        // === Feature Flag 检查 ===
        let multi_variant_enabled = feature_flags::is_multi_variant_enabled();
        log::info!(
            "[ChatV2::pipeline] Feature flags: {}",
            feature_flags::get_flags_summary()
        );

        // === 多变体模式检查 ===
        // 如果 parallel_model_ids 有 2+ 个模型，走多变体执行路径
        // 🔧 调试日志：打印收到的 options
        log::info!(
            "[ChatV2::pipeline] execute() received options: {:?}",
            request.options.as_ref().map(|o| format!(
                "parallelModelIds={:?}, modelId={:?}",
                o.parallel_model_ids, o.model_id
            ))
        );

        // 注意：先提取 model_ids 避免借用问题
        let multi_variant_model_ids = request
            .options
            .as_ref()
            .and_then(|opts| opts.parallel_model_ids.as_ref())
            .filter(|ids| ids.len() >= 2)
            .cloned();

        // === Feature Flag 拦截：如果多变体功能关闭，强制走单变体路径 ===
        if let Some(ref model_ids) = multi_variant_model_ids {
            if !multi_variant_enabled {
                log::warn!(
                    "[ChatV2::pipeline] Multi-variant DISABLED by feature flag. \
                     Received {} models, forcing single-variant mode with first model: {:?}",
                    model_ids.len(),
                    model_ids.first()
                );

                // 强制使用第一个模型走单变体路径
                if let Some(first_model) = model_ids.first() {
                    // 修改 request.options.model_id 为第一个模型
                    if let Some(ref mut opts) = request.options {
                        opts.model_id = Some(first_model.clone());
                        // 清除 parallel_model_ids 防止后续逻辑误判
                        opts.parallel_model_ids = None;
                    }
                }
                // 继续执行下面的单变体路径，不进入多变体分支
            } else {
                // Feature flag 启用，正常走多变体路径
                log::info!(
                    "[ChatV2::pipeline] Multi-variant mode detected: {} models",
                    model_ids.len()
                );
                return self
                    .execute_multi_variant(
                        window,
                        request,
                        model_ids.clone(),
                        cancel_token,
                        chat_v2_state,
                    )
                    .await;
            }
        }

        // === 单变体模式（原有逻辑）===
        let mut ctx = PipelineContext::new(request);
        // 🆕 设置取消令牌：传递给工具执行器，支持工具执行取消
        ctx.set_cancellation_token(cancel_token.clone());
        let session_id = ctx.session_id.clone();
        let assistant_message_id = ctx.assistant_message_id.clone();

        // 创建事件发射器
        let emitter = Arc::new(ChatV2EventEmitter::new(window.clone(), session_id.clone()));

        // 获取模型名称用于前端显示
        // 从 API 配置中解析 model_id 到真正的模型名称（如 "Qwen/Qwen3-8B"）
        log::info!(
            "[ChatV2::pipeline] Single variant: options.model_id = {:?}",
            ctx.options.model_id
        );

        let model_name: Option<String> =
            if let Some(config_id) = ctx.options.model_id.as_ref().filter(|s| !s.is_empty()) {
                // 有指定模型 ID，从 API 配置中查找
                match self.llm_manager.get_api_configs().await {
                    Ok(configs) => {
                        log::info!(
                            "[ChatV2::pipeline] Found {} API configs, looking for config_id: {}",
                            configs.len(),
                            config_id
                        );
                        // 🔧 Bug修复：优先通过 c.id 匹配，如果找不到再通过 c.model 匹配
                        // 这样无论前端传递的是 API 配置 ID（UUID）还是模型显示名称，都能正确解析
                        let found = configs
                            .iter()
                            .find(|c| &c.id == config_id)
                            .map(|c| c.model.clone())
                            .or_else(|| {
                                // 如果通过 id 找不到，尝试通过 model 名称匹配
                                // 这处理了 config_id 本身就是模型显示名称的情况
                                configs
                                    .iter()
                                    .find(|c| &c.model == config_id)
                                    .map(|c| c.model.clone())
                            })
                            .or_else(|| {
                                // 🔧 最后的回退：判断 config_id 是否是 API 配置 ID（不可作为显示名称）
                                // 配置 ID 有两种已知格式：
                                //   1. builtin-* （内置模型，如 "builtin-deepseek-chat"）
                                //   2. UUID 格式 （用户自建模型，如 "a1b2c3d4-e5f6-7890-abcd-ef1234567890"）
                                // 如果 config_id 不属于这两种格式，则认为它本身就是模型显示名称
                                // （例如删除了配置后重试旧消息，config_id 中保存的可能是旧的模型名）
                                if is_config_id_format(config_id) {
                                    log::warn!(
                                        "[ChatV2::pipeline] config_id is a config UUID/builtin ID, not usable as display name: {}",
                                        config_id
                                    );
                                    None
                                } else {
                                    log::info!(
                                        "[ChatV2::pipeline] Using config_id as model_name directly (not a config ID pattern): {}",
                                        config_id
                                    );
                                    Some(config_id.clone())
                                }
                            });
                        log::info!("[ChatV2::pipeline] Resolved model_name: {:?}", found);
                        found
                    }
                    Err(e) => {
                        log::warn!(
                            "[ChatV2::pipeline] Failed to get API configs for model name: {}",
                            e
                        );
                        None
                    }
                }
            } else {
                // 没有指定模型 ID（使用默认模型），从默认配置获取模型名称
                log::info!(
                    "[ChatV2::pipeline] options.model_id is None/empty, getting default model name"
                );
                match self
                    .llm_manager
                    .select_model_for("default", None, None, None, None, None, None)
                    .await
                {
                    Ok((config, _)) => {
                        log::info!(
                            "[ChatV2::pipeline] Default model resolved: {}",
                            config.model
                        );
                        Some(config.model)
                    }
                    Err(e) => {
                        log::warn!("[ChatV2::pipeline] Failed to get default model: {}", e);
                        None
                    }
                }
            };

        // 🔧 Bug修复：将模型显示名称存储到 ctx，用于消息保存
        ctx.model_display_name = model_name.clone();

        // 发射流式开始事件（带模型名称）
        log::info!(
            "[ChatV2::pipeline] Emitting stream_start with model_name: {:?}",
            model_name
        );
        emitter.emit_stream_start(&assistant_message_id, model_name.as_deref());

        log::info!(
            "[ChatV2::pipeline] Starting pipeline for session={}, assistant_msg={}",
            session_id,
            assistant_message_id
        );

        // 🆕 P0防闪退：用户消息即时保存
        // 在 Pipeline 执行前立即保存用户消息，确保用户输入不会因闪退丢失
        // 注意：skip_user_message_save 为 true 时跳过（编辑重发场景）
        if !ctx.options.skip_user_message_save.unwrap_or(false) {
            if let Err(e) = self.save_user_message_immediately(&ctx).await {
                log::warn!(
                    "[ChatV2::pipeline] Failed to save user message immediately: {}",
                    e
                );
                // 不阻塞流程，继续执行（save_results 会再次保存）
            } else {
                log::info!(
                    "[ChatV2::pipeline] User message saved immediately: id={}",
                    ctx.user_message_id
                );
            }
        }

        // 执行流水线
        let result = self
            .execute_internal(&mut ctx, emitter.clone(), cancel_token)
            .await;

        match result {
            Ok(_) => {
                // 发射流式完成事件（带 token 统计）
                let usage = if ctx.token_usage.has_tokens() {
                    Some(&ctx.token_usage)
                } else {
                    None
                };
                emitter.emit_stream_complete_with_usage(
                    &assistant_message_id,
                    ctx.elapsed_ms(),
                    usage,
                );

                // 注意：不再单独更新 assistant_meta
                // save_results() 已经保存了完整的 MessageMeta（包含 model_id, usage, sources, tool_results, chat_params, context_snapshot）
                // 这里如果再次调用 update_message_meta_with_conn 会覆盖这些字段，导致数据丢失

                log::info!(
                    "[ChatV2::pipeline] Pipeline completed for session={}, duration={}ms",
                    session_id,
                    ctx.elapsed_ms()
                );

                // 🔧 自动生成会话摘要（每轮对话后）
                // 通过内容哈希防止重复生成
                let user_content_for_summary = ctx.user_content.clone();
                let assistant_content_for_summary = ctx.final_content.clone();
                if self
                    .should_generate_summary(
                        &session_id,
                        &user_content_for_summary,
                        &assistant_content_for_summary,
                    )
                    .await
                {
                    let pipeline = self.clone();
                    let sid = session_id.clone();
                    let emitter_clone = emitter.clone();

                    // 🆕 P1修复：使用 TaskTracker 追踪异步任务，确保优雅关闭
                    // 异步执行摘要生成，不阻塞返回
                    let summary_future = async move {
                        pipeline
                            .generate_summary(
                                &sid,
                                &user_content_for_summary,
                                &assistant_content_for_summary,
                                emitter_clone,
                            )
                            .await;
                    };

                    // 🔧 P1修复：优先使用 spawn_tracked 追踪摘要任务
                    if let Some(ref state) = chat_v2_state {
                        state.spawn_tracked(summary_future);
                    } else {
                        log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for summary task");
                        tokio::spawn(summary_future);
                    }
                }

                Ok(assistant_message_id)
            }
            Err(ChatV2Error::Cancelled) => {
                // 🔧 修复：取消时也保存已累积的内容，避免用户消息丢失
                log::info!(
                    "[ChatV2::pipeline] Pipeline cancelled for session={}, attempting to save partial results...",
                    session_id
                );

                // 🔧 关键修复：从 adapter 获取已累积内容（tokio::select! 取消时不会执行 ctx 更新）
                if let Some(adapter) = &ctx.current_adapter {
                    if ctx.final_content.is_empty() {
                        ctx.final_content = adapter.get_accumulated_content();
                    }
                    if ctx.final_reasoning.is_none() {
                        ctx.final_reasoning = adapter.get_accumulated_reasoning();
                    }
                    if ctx.streaming_thinking_block_id.is_none() {
                        ctx.streaming_thinking_block_id = adapter.get_thinking_block_id();
                    }
                    if ctx.streaming_content_block_id.is_none() {
                        ctx.streaming_content_block_id = adapter.get_content_block_id();
                    }
                    log::info!(
                        "[ChatV2::pipeline] Retrieved partial content from adapter on cancel: content_len={}, reasoning_len={:?}",
                        ctx.final_content.len(),
                        ctx.final_reasoning.as_ref().map(|r| r.len())
                    );
                }

                // 尝试保存已累积的内容（即使为空也会保存用户消息）
                if let Err(save_err) = self.save_results(&ctx).await {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to save partial results on cancel: {}",
                        save_err
                    );
                } else {
                    log::info!(
                        "[ChatV2::pipeline] Partial results saved on cancel: content_len={}, reasoning_len={:?}",
                        ctx.final_content.len(),
                        ctx.final_reasoning.as_ref().map(|r| r.len())
                    );
                }

                // 发射取消事件
                emitter.emit_stream_cancelled(&assistant_message_id);
                Err(ChatV2Error::Cancelled)
            }
            Err(e) => {
                // 🔧 修复：错误时也保存已累积的内容，避免用户消息丢失
                log::error!(
                    "[ChatV2::pipeline] Pipeline error for session={}: {}, attempting to save partial results...",
                    session_id,
                    e
                );

                // 🔧 关键修复：从 adapter 获取已累积内容
                if let Some(adapter) = &ctx.current_adapter {
                    if ctx.final_content.is_empty() {
                        ctx.final_content = adapter.get_accumulated_content();
                    }
                    if ctx.final_reasoning.is_none() {
                        ctx.final_reasoning = adapter.get_accumulated_reasoning();
                    }
                    if ctx.streaming_thinking_block_id.is_none() {
                        ctx.streaming_thinking_block_id = adapter.get_thinking_block_id();
                    }
                    if ctx.streaming_content_block_id.is_none() {
                        ctx.streaming_content_block_id = adapter.get_content_block_id();
                    }
                    log::info!(
                        "[ChatV2::pipeline] Retrieved partial content from adapter on error: content_len={}, reasoning_len={:?}",
                        ctx.final_content.len(),
                        ctx.final_reasoning.as_ref().map(|r| r.len())
                    );
                }

                // 尝试保存已累积的内容（即使为空也会保存用户消息）
                if let Err(save_err) = self.save_results(&ctx).await {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to save partial results on error: {}",
                        save_err
                    );
                } else {
                    log::info!(
                        "[ChatV2::pipeline] Partial results saved on error: content_len={}, reasoning_len={:?}",
                        ctx.final_content.len(),
                        ctx.final_reasoning.as_ref().map(|r| r.len())
                    );
                }

                // 发射错误事件
                emitter.emit_stream_error(&assistant_message_id, &e.to_string());
                Err(e)
            }
        }
    }

    /// 内部执行流程
    async fn execute_internal(
        &self,
        ctx: &mut PipelineContext,
        emitter: Arc<ChatV2EventEmitter>,
        cancel_token: CancellationToken,
    ) -> ChatV2Result<()> {
        // 阶段 0：初始化上下文快照（统一上下文注入系统）
        ctx.init_context_snapshot();

        // 阶段 1：检查取消
        if cancel_token.is_cancelled() {
            return Err(ChatV2Error::Cancelled);
        }

        // 阶段 2：加载聊天历史
        self.load_chat_history(ctx).await?;

        // 阶段 3：并行执行检索
        if cancel_token.is_cancelled() {
            return Err(ChatV2Error::Cancelled);
        }

        // 使用 tokio::select! 支持取消
        let retrieval_result = tokio::select! {
            result = self.execute_retrievals(ctx, emitter.clone()) => result,
            _ = cancel_token.cancelled() => return Err(ChatV2Error::Cancelled),
        };
        retrieval_result?;

        // 阶段 3.5：创建检索资源并添加到上下文快照（统一上下文注入系统）
        let retrieval_refs = self
            .create_retrieval_resources(&ctx.retrieved_sources)
            .await;
        ctx.add_retrieval_refs_to_snapshot(retrieval_refs);

        // 阶段 4：构建系统提示
        let system_prompt = self.build_system_prompt(ctx).await;

        // 阶段 5：调用 LLM（带工具递归）
        if cancel_token.is_cancelled() {
            return Err(ChatV2Error::Cancelled);
        }

        let llm_result = tokio::select! {
            result = self.execute_with_tools(ctx, emitter.clone(), &system_prompt, 0) => result,
            _ = cancel_token.cancelled() => {
                log::info!("[ChatV2::pipeline] LLM call cancelled");
                return Err(ChatV2Error::Cancelled);
            }
        };
        llm_result?;

        // 阶段 5.5：空闲期检测 - 检查工作区 inbox 是否有待处理消息
        // 设计文档 30：在 stream_complete 前检查 inbox
        if let Some(workspace_id) = ctx.get_workspace_id() {
            if let Some(ref coordinator) = self.workspace_coordinator {
                use super::workspace::WorkspaceInjector;

                let injector = WorkspaceInjector::new(coordinator.clone());
                let max_injections = 3u32; // 单次空闲期最多处理 3 批消息

                match injector.check_and_inject(workspace_id, &ctx.session_id, max_injections) {
                    Ok(injection_result) => {
                        if !injection_result.messages.is_empty() {
                            let formatted = WorkspaceInjector::format_injected_messages(
                                &injection_result.messages,
                            );
                            ctx.inject_workspace_messages(formatted);

                            log::info!(
                                "[ChatV2::pipeline] Workspace idle injection: {} messages injected, should_continue={}",
                                injection_result.messages.len(),
                                injection_result.should_continue
                            );

                            // 如果注入了消息且需要继续，递归调用 LLM 处理
                            if injection_result.should_continue
                                || ctx.should_continue_for_workspace()
                            {
                                let continue_result = tokio::select! {
                                    result = self.execute_with_tools(ctx, emitter.clone(), &system_prompt, 0) => result,
                                    _ = cancel_token.cancelled() => {
                                        log::info!("[ChatV2::pipeline] Workspace continuation cancelled");
                                        return Err(ChatV2Error::Cancelled);
                                    }
                                };
                                continue_result?;
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[ChatV2::pipeline] Workspace injection check failed: {}", e);
                    }
                }
            }
        }

        // 阶段 6：保存结果
        self.save_results(ctx).await?;

        Ok(())
    }

    /// 加载聊天历史
    ///
    /// 从数据库加载会话的历史消息，应用 context_limit 限制，
    /// 并提取 content 类型块的内容构建 LLM 对话历史。
    async fn load_chat_history(&self, ctx: &mut PipelineContext) -> ChatV2Result<()> {
        log::debug!(
            "[ChatV2::pipeline] Loading chat history for session={}",
            ctx.session_id
        );

        // 获取数据库连接
        let conn = self.db.get_conn_safe()?;

        // 🆕 获取 VFS 数据库连接（用于解析历史消息中的 context_snapshot）
        let vfs_conn_opt = self.vfs_db.as_ref().and_then(|vfs_db| {
            match vfs_db.get_conn_safe() {
                Ok(vfs_conn) => Some(vfs_conn),
                Err(e) => {
                    log::warn!("[ChatV2::pipeline] Failed to get vfs.db connection for history context_snapshot: {}", e);
                    None
                }
            }
        });
        let vfs_blobs_dir = self
            .vfs_db
            .as_ref()
            .map(|vfs_db| vfs_db.blobs_dir().to_path_buf());

        // 从数据库加载消息
        let messages = ChatV2Repo::get_session_messages_with_conn(&conn, &ctx.session_id)?;

        if messages.is_empty() {
            log::debug!(
                "[ChatV2::pipeline] No chat history found for session={}",
                ctx.session_id
            );
            ctx.chat_history = Vec::new();
            return Ok(());
        }

        // 🔧 P1修复：使用固定的消息条数限制，而非 context_limit
        // context_limit 应该用于 LLM 的 max_input_tokens_override
        let max_messages = DEFAULT_MAX_HISTORY_MESSAGES;
        let messages_to_load: Vec<_> = if messages.len() > max_messages {
            // 取最新的 max_messages 条消息
            messages
                .into_iter()
                .rev()
                .take(max_messages)
                .rev()
                .collect()
        } else {
            messages
        };

        log::debug!(
            "[ChatV2::pipeline] Loading {} messages (max_messages={})",
            messages_to_load.len(),
            max_messages
        );

        // 转换为 LegacyChatMessage 格式
        let mut chat_history = Vec::new();
        for message in messages_to_load {
            // 加载该消息的所有块
            let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &message.id)?;

            // 只提取 content 类型块的内容
            let content: String = blocks
                .iter()
                .filter(|b| b.block_type == block_types::CONTENT)
                .filter_map(|b| b.content.as_ref())
                .cloned()
                .collect::<Vec<_>>()
                .join("");

            // 提取 thinking 类型块的内容（如果有）
            let thinking_content: Option<String> = {
                let thinking: String = blocks
                    .iter()
                    .filter(|b| b.block_type == block_types::THINKING)
                    .filter_map(|b| b.content.as_ref())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("");
                if thinking.is_empty() {
                    None
                } else {
                    Some(thinking)
                }
            };

            // 🔧 P1修复：提取 mcp_tool 类型块的工具调用信息
            // 对于 assistant 消息，如果包含工具调用，需要先添加工具调用消息
            // 🔧 改进 5：按 block_index 排序，确保多轮工具调用顺序正确
            let mut tool_blocks: Vec<_> = blocks
                .iter()
                .filter(|b| b.block_type == block_types::MCP_TOOL)
                .collect();
            tool_blocks.sort_by_key(|b| b.block_index);

            // 🆕 对于用户消息，解析 context_snapshot.user_refs 并将内容追加到 content
            // ★ 2025-12-10 修复：同时提取图片 base64，注入到 image_base64 字段
            let (content, vfs_image_base64) = if message.role == MessageRole::User {
                if let (Some(ref vfs_conn), Some(ref blobs_dir)) = (&vfs_conn_opt, &vfs_blobs_dir) {
                    self.resolve_history_context_snapshot_v2(
                        &content,
                        &message,
                        &**vfs_conn, // 解引用 PooledConnection 获取 &Connection
                        blobs_dir,
                    )
                } else {
                    (content, Vec::new())
                }
            } else {
                (content, Vec::new())
            };

            // 构建 LegacyChatMessage
            let role = match message.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
            };

            // 如果是 assistant 消息且有工具调用，先添加工具调用消息
            if role == "assistant" && !tool_blocks.is_empty() {
                for (idx, tool_block) in tool_blocks.iter().enumerate() {
                    // 生成 tool_call_id（使用块 ID 或生成新的）
                    let tool_call_id = format!("tc_{}", tool_block.id.replace("blk_", ""));

                    // 提取工具名称和输入
                    let tool_name = tool_block.tool_name.clone().unwrap_or_default();
                    let tool_input = tool_block
                        .tool_input
                        .clone()
                        .unwrap_or(serde_json::Value::Null);
                    let tool_output = tool_block
                        .tool_output
                        .clone()
                        .unwrap_or(serde_json::Value::Null);
                    let tool_success = tool_block.status == block_status::SUCCESS;
                    let tool_error = tool_block.error.clone();

                    // 1. 添加 assistant 消息（包含 tool_call）
                    let tool_call = crate::models::ToolCall {
                        id: tool_call_id.clone(),
                        tool_name: tool_name.clone(),
                        args_json: tool_input,
                    };
                    let assistant_tool_msg = LegacyChatMessage {
                        role: "assistant".to_string(),
                        content: String::new(),
                        timestamp: chrono::Utc::now(),
                        thinking_content: None,
                        thought_signature: None,
                        rag_sources: None,
                        memory_sources: None,
                        graph_sources: None,
                        web_search_sources: None,
                        image_paths: None,
                        image_base64: None,
                        doc_attachments: None,
                        multimodal_content: None,
                        tool_call: Some(tool_call),
                        tool_result: None,
                        overrides: None,
                        relations: None,
                        persistent_stable_id: None,
                        metadata: None,
                    };
                    chat_history.push(assistant_tool_msg);

                    // 2. 添加 tool 消息（包含 tool_result）
                    let tool_result = crate::models::ToolResult {
                        call_id: tool_call_id,
                        ok: tool_success,
                        error: tool_error,
                        error_details: None,
                        data_json: Some(tool_output.clone()),
                        usage: None,
                        citations: None,
                    };
                    let tool_msg = LegacyChatMessage {
                        role: "tool".to_string(),
                        content: serde_json::to_string(&tool_output).unwrap_or_default(),
                        timestamp: chrono::Utc::now(),
                        thinking_content: None,
                        thought_signature: None,
                        rag_sources: None,
                        memory_sources: None,
                        graph_sources: None,
                        web_search_sources: None,
                        image_paths: None,
                        image_base64: None,
                        doc_attachments: None,
                        multimodal_content: None,
                        tool_call: None,
                        tool_result: Some(tool_result),
                        overrides: None,
                        relations: None,
                        persistent_stable_id: None,
                        metadata: None,
                    };
                    chat_history.push(tool_msg);

                    log::debug!(
                        "[ChatV2::pipeline] Loaded tool call from history: tool={}, block_id={}, index={}",
                        tool_name,
                        tool_block.id,
                        idx
                    );
                }
            }

            // 跳过空内容消息（但工具调用消息已经添加）
            if content.is_empty() {
                continue;
            }

            // 从附件中提取图片 base64（仅用户消息有附件）
            // ★ 2025-12-10 修复：合并旧附件图片和 VFS 图片
            let mut all_images: Vec<String> = message
                .attachments
                .as_ref()
                .map(|attachments| {
                    attachments
                        .iter()
                        .filter(|a| a.r#type == "image")
                        .filter_map(|a| {
                            // preview_url 格式为 "data:image/xxx;base64,{base64_content}"
                            a.preview_url
                                .as_ref()
                                .and_then(|url| url.split(',').nth(1).map(|s| s.to_string()))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            // ★ 2025-12-10 修复：追加从 VFS context_snapshot 解析的图片
            all_images.extend(vfs_image_base64);

            let image_base64: Option<Vec<String>> = if all_images.is_empty() {
                None
            } else {
                Some(all_images)
            };

            // 🔧 P2修复：从附件中提取文档附件（同时支持文本和二进制文档）
            // 🔧 P0修复：使用 DocumentParser 解析 docx/pdf 等二进制文档
            let doc_attachments: Option<Vec<crate::models::DocumentAttachment>> = message.attachments
                .as_ref()
                .map(|attachments| {
                    attachments.iter()
                        .filter(|a| a.r#type == "document")
                        .map(|a| {
                            // 判断是否为文本类型
                            let is_text_type = a.mime_type.starts_with("text/") ||
                                               a.mime_type == "application/json" ||
                                               a.mime_type == "application/xml" ||
                                               a.mime_type == "application/javascript";

                            let mut text_content: Option<String> = None;
                            let mut base64_content: Option<String> = None;

                            // 从 preview_url 提取内容
                            if let Some(ref url) = a.preview_url {
                                if url.starts_with("data:") {
                                    if let Some(data_part) = url.split(',').nth(1) {
                                        if is_text_type {
                                            // 文本类型：解码 base64 为文本
                                            use base64::Engine;
                                            text_content = base64::engine::general_purpose::STANDARD
                                                .decode(data_part)
                                                .ok()
                                                .and_then(|bytes| String::from_utf8(bytes).ok());
                                        } else {
                                            // 二进制类型（如 docx/PDF）：先保存 base64
                                            base64_content = Some(data_part.to_string());

                                            // 🔧 P0修复：尝试使用 DocumentParser 解析二进制文档
                                            let parser = crate::document_parser::DocumentParser::new();
                                            match parser.extract_text_from_base64(&a.name, data_part) {
                                                Ok(text) => {
                                                    log::debug!("[ChatV2::pipeline] Extracted {} chars from history document: {}", text.len(), a.name);
                                                    text_content = Some(text);
                                                }
                                                Err(e) => {
                                                    log::debug!("[ChatV2::pipeline] Could not parse history document {}: {}", a.name, e);
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            crate::models::DocumentAttachment {
                                name: a.name.clone(),
                                mime_type: a.mime_type.clone(),
                                size_bytes: a.size as usize,
                                text_content,
                                base64_content,
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .filter(|v| !v.is_empty());

            let legacy_message = LegacyChatMessage {
                role: role.to_string(),
                content: content.clone(),
                timestamp: chrono::Utc::now(), // 历史消息的时间戳（用于格式兼容）
                thinking_content,
                thought_signature: None,
                rag_sources: None,
                memory_sources: None,
                graph_sources: None,
                web_search_sources: None,
                image_paths: None,
                image_base64,
                doc_attachments,
                multimodal_content: None,
                tool_call: None,
                tool_result: None,
                overrides: None,
                relations: None,
                persistent_stable_id: message.persistent_stable_id.clone(),
                metadata: None,
            };

            chat_history.push(legacy_message);
        }

        log::info!(
            "[ChatV2::pipeline] Loaded {} messages from history for session={}",
            chat_history.len(),
            ctx.session_id
        );

        // 🔧 改进 5：验证工具调用链完整性
        validate_tool_chain(&chat_history);

        // 🆕 2026-02-22: 为已激活的默认技能自动注入合成 load_skills 工具交互
        // 技能内容通过 role: tool 投递，模型遵循度远高于 user message 中的 XML 块
        inject_synthetic_load_skills(&mut chat_history, &ctx.options);

        ctx.chat_history = chat_history;
        Ok(())
    }

    /// 解析历史消息中的 context_snapshot（V2 版本）
    ///
    /// 使用统一的 `vfs_resolver` 模块处理所有资源类型的解引用。
    /// 返回 `(String, Vec<String>)`：
    /// - 第一个值是合并后的文本内容
    /// - 第二个值是图片 base64 列表，用于注入到 `image_base64` 字段
    ///
    /// 这确保历史消息中的 VFS 图片附件能正确注入到多模态请求中。
    fn resolve_history_context_snapshot_v2(
        &self,
        original_content: &str,
        message: &ChatMessage,
        vfs_conn: &rusqlite::Connection,
        blobs_dir: &std::path::Path,
    ) -> (String, Vec<String>) {
        use super::vfs_resolver::{resolve_context_ref_data_to_content, ResolvedContent};
        use crate::vfs::repos::VfsResourceRepo;
        use crate::vfs::types::VfsContextRefData;

        // 检查是否有 context_snapshot
        let context_snapshot = match &message.meta {
            Some(meta) => match &meta.context_snapshot {
                Some(snapshot) if !snapshot.user_refs.is_empty() => snapshot,
                _ => return (original_content.to_string(), Vec::new()),
            },
            None => return (original_content.to_string(), Vec::new()),
        };

        log::debug!(
            "[ChatV2::pipeline] resolve_history_context_snapshot_v2 for message {}: {} user_refs",
            message.id,
            context_snapshot.user_refs.len()
        );

        let mut total_result = ResolvedContent::new();

        // 遍历 user_refs
        for context_ref in &context_snapshot.user_refs {
            // 1. 从 VFS resources 表获取资源
            let resource =
                match VfsResourceRepo::get_resource_with_conn(vfs_conn, &context_ref.resource_id) {
                    Ok(Some(r)) => r,
                    Ok(None) => {
                        log::warn!(
                            "[ChatV2::pipeline] Resource not found: {}",
                            context_ref.resource_id
                        );
                        continue;
                    }
                    Err(e) => {
                        log::warn!(
                            "[ChatV2::pipeline] Failed to get resource {}: {}",
                            context_ref.resource_id,
                            e
                        );
                        continue;
                    }
                };

            // 2. 解析资源的 data 字段获取 VFS 引用
            let data_str = match &resource.data {
                Some(d) => d,
                None => {
                    log::debug!(
                        "[ChatV2::pipeline] Resource {} has no data",
                        context_ref.resource_id
                    );
                    continue;
                }
            };

            // 尝试解析为 VfsContextRefData（附件等引用模式资源）
            if let Ok(mut ref_data) = serde_json::from_str::<VfsContextRefData>(data_str) {
                // ★ 2026-02 修复：历史消息解引用时也要恢复 inject_modes
                // 否则编辑重发/重试时会错误注入文本
                if let Some(ref saved_inject_modes) = context_ref.inject_modes {
                    for vfs_ref in &mut ref_data.refs {
                        vfs_ref.inject_modes = Some(saved_inject_modes.clone());
                    }
                }
                // ★ 使用统一的 vfs_resolver 模块解析
                // ★ 2026-01-17 修复：历史加载时使用 is_multimodal=false，同时收集图片和 OCR 文本
                // 实际发送给 LLM 时，由 model2_pipeline 根据 config.is_multimodal 决定：
                // - 多模态模型：使用 image_base64 发送图片
                // - 非多模态模型：使用 content 中的 OCR 文本
                let content =
                    resolve_context_ref_data_to_content(vfs_conn, blobs_dir, &ref_data, false);
                total_result.merge(content);
            } else {
                // 非引用模式资源（如笔记内容直接存储），直接使用 data
                match context_ref.type_id.as_str() {
                    "note" | "translation" | "essay" => {
                        if !data_str.is_empty() {
                            let title = resource
                                .metadata
                                .as_ref()
                                .and_then(|m| m.title.clone())
                                .unwrap_or_else(|| context_ref.type_id.clone());
                            total_result.add_text(format!(
                                "<injected_context>\n[{}]\n{}\n</injected_context>",
                                title, data_str
                            ));
                        }
                    }
                    _ => {
                        log::debug!(
                            "[ChatV2::pipeline] Unknown type_id for resource {}: {}",
                            context_ref.resource_id,
                            context_ref.type_id
                        );
                    }
                }
            }
        }

        // 记录日志
        if !total_result.is_empty() {
            log::info!(
                "[ChatV2::pipeline] Resolved {} context items and {} images for message {}",
                total_result.text_contents.len(),
                total_result.image_base64_list.len(),
                message.id
            );
        }

        // 返回合并后的内容和图片列表
        let final_content = total_result.to_formatted_text(original_content);
        (final_content, total_result.image_base64_list)
    }

    /// 检索阶段（已废弃预调用模式）
    ///
    /// 🔧 2026-01-11 重构：彻底移除预调用检索，完全采用工具化模式
    ///
    /// 原预调用模式（已废弃）：
    /// - 在 LLM 调用前自动执行 RAG、图谱、记忆、网络搜索
    /// - 结果注入到系统提示中
    ///
    /// 新工具化模式（当前）：
    /// - 检索工具作为 MCP 工具注入到 LLM
    /// - LLM 根据用户问题主动决定是否调用检索工具
    /// - 更智能、更节省资源
    ///
    /// 内置检索工具（builtin-* 前缀）：
    /// - builtin-rag_search - 知识库检索
    /// - builtin-graph_search - 知识图谱检索
    /// - builtin-memory_search - 对话记忆检索
    /// - builtin-web_search - 网络搜索
    /// - builtin-resource_* - 学习资源工具
    /// - builtin-note_* - Canvas 笔记工具
    /// - builtin-memory_* - VFS 记忆工具
    /// - builtin-knowledge_* - 知识内化工具
    #[allow(unused_variables)]
    async fn execute_retrievals(
        &self,
        ctx: &mut PipelineContext,
        _emitter: Arc<ChatV2EventEmitter>,
    ) -> ChatV2Result<()> {
        // 🔧 工具化模式：跳过所有预调用检索
        // 检索由 LLM 通过 tool_calls 主动调用内置工具完成
        log::info!(
            "[ChatV2::pipeline] Tool-based retrieval mode: skipping pre-call retrievals for session={}",
            ctx.session_id
        );
        Ok(())
    }

    /// 🆕 执行 VFS RAG 统一知识管理检索
    ///
    /// 使用 VFS 统一存储的向量检索替代传统 RagManager，支持：
    /// - 文件夹范围过滤
    /// - 资源类型过滤
    /// - 可选重排序
    ///
    /// ## 返回
    /// (sources, block_id)
    async fn execute_vfs_rag_retrieval(
        &self,
        query: &str,
        folder_ids: Option<Vec<String>>,
        resource_types: Option<Vec<String>>,
        top_k: u32,
        enable_reranking: bool,
        enabled: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
    ) -> ChatV2Result<(Vec<SourceInfo>, Option<String>)> {
        if !enabled {
            return Ok((Vec::new(), None));
        }

        // 检查 VFS 数据库是否可用
        let vfs_db = match &self.vfs_db {
            Some(db) => db.clone(),
            None => {
                log::debug!("[ChatV2::pipeline] VFS database not available, skipping VFS RAG");
                return Ok((Vec::new(), None));
            }
        };

        let block_id = format!("blk_{}", Uuid::new_v4());

        // 发射 start 事件
        emitter.emit_start(event_types::RAG, message_id, Some(&block_id), None, None);

        let start_time = Instant::now();

        // 创建 VFS 搜索服务
        let lance_store = match VfsLanceStore::new(vfs_db.clone()) {
            Ok(store) => Arc::new(store),
            Err(e) => {
                log::warn!("[ChatV2::pipeline] Failed to create VFS Lance store: {}", e);
                emitter.emit_error(event_types::RAG, &block_id, &e.to_string(), None);
                return Ok((Vec::new(), Some(block_id)));
            }
        };
        let search_service =
            VfsFullSearchService::new(vfs_db.clone(), lance_store, self.llm_manager.clone());

        // 构建搜索参数
        let params = VfsSearchParams {
            query: query.to_string(),
            folder_ids,
            resource_ids: None,
            resource_types,
            modality: MODALITY_TEXT.to_string(),
            top_k,
        };

        // 执行搜索
        let result = search_service
            .search_with_resource_info(query, &params, enable_reranking)
            .await;

        match result {
            Ok(results) => {
                let raw_sources: Vec<SourceInfo> = results
                    .into_iter()
                    .map(|r| SourceInfo {
                        title: r.resource_title,
                        url: None,
                        snippet: Some(r.chunk_text),
                        score: Some(r.score as f32),
                        metadata: Some(json!({
                            "resourceId": r.resource_id,
                            "resourceType": r.resource_type,
                            "chunkIndex": r.chunk_index,
                            "embeddingId": r.embedding_id,
                            "sourceType": "vfs_rag",
                        })),
                    })
                    .collect();

                // 应用相关性过滤
                let sources = filter_retrieval_results(
                    raw_sources,
                    RETRIEVAL_MIN_SCORE,
                    RETRIEVAL_RELATIVE_THRESHOLD,
                    top_k as usize,
                );

                let duration = start_time.elapsed().as_millis() as u64;

                // 发射 end 事件
                emitter.emit_end(
                    event_types::RAG,
                    &block_id,
                    Some(json!({
                        "sources": sources,
                        "durationMs": duration,
                        "sourceType": "vfs_rag",
                    })),
                    None,
                );

                log::debug!(
                    "[ChatV2::pipeline] VFS RAG retrieval completed: {} sources in {}ms",
                    sources.len(),
                    duration
                );

                Ok((sources, Some(block_id)))
            }
            Err(e) => {
                // 发射 error 事件
                emitter.emit_error(event_types::RAG, &block_id, &e.to_string(), None);
                log::warn!("[ChatV2::pipeline] VFS RAG retrieval error: {}", e);
                Ok((Vec::new(), Some(block_id))) // 不中断流程，但保留块 ID
            }
        }
    }

    /// 执行多模态知识库检索
    /// 返回 (sources, block_id)
    async fn execute_multimodal_retrieval(
        &self,
        query: &str,
        library_ids: &Option<Vec<String>>,
        top_k: u32,
        _enable_reranking: bool,
        enabled: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
    ) -> ChatV2Result<(Vec<SourceInfo>, Option<String>)> {
        if !enabled {
            return Ok((Vec::new(), None));
        }

        // 检查多模态 RAG 是否已配置
        if !self.llm_manager.is_multimodal_rag_configured().await {
            log::debug!("[ChatV2::pipeline] Multimodal RAG not configured, skipping");
            return Ok((Vec::new(), None));
        }

        let block_id = format!("blk_{}", Uuid::new_v4());

        // 发射 start 事件
        emitter.emit_start(
            event_types::MULTIMODAL_RAG,
            message_id,
            Some(&block_id),
            None,
            None,
        );

        let start_time = Instant::now();

        // ★ 使用 VFS 多模态检索服务（2026-01 改造）
        let vfs_db = match &self.vfs_db {
            Some(db) => db.clone(),
            None => {
                log::warn!("[ChatV2::pipeline] VFS database not available");
                emitter.emit_error(
                    event_types::MULTIMODAL_RAG,
                    &block_id,
                    "VFS 数据库不可用",
                    None,
                );
                return Ok((Vec::new(), Some(block_id)));
            }
        };

        let lance_store = match VfsLanceStore::new(vfs_db.clone()) {
            Ok(ls) => Arc::new(ls),
            Err(e) => {
                log::warn!("[ChatV2::pipeline] Failed to create VFS Lance store: {}", e);
                emitter.emit_error(event_types::MULTIMODAL_RAG, &block_id, &e.to_string(), None);
                return Ok((Vec::new(), Some(block_id)));
            }
        };

        let mm_service = VfsMultimodalService::new(vfs_db, self.llm_manager.clone(), lance_store);

        // 执行 VFS 多模态检索
        let folder_ids_ref: Option<Vec<String>> = library_ids.clone();
        let result = mm_service
            .search(
                query,
                top_k as usize,
                folder_ids_ref.as_ref().map(|v| v.as_slice()),
                None, // resource_types
            )
            .await;

        match result {
            Ok(results) => {
                let sources: Vec<SourceInfo> = results
                    .into_iter()
                    .map(|r| {
                        let page_display = r.page_index + 1;
                        SourceInfo {
                            title: Some(format!("Page {} - {}", page_display, r.resource_type)),
                            url: None,
                            snippet: r.text_content,
                            score: Some(r.score),
                            metadata: Some(json!({
                                "sourceType": r.resource_type,
                                "sourceId": r.resource_id,
                                "pageIndex": r.page_index,
                                "blobHash": r.blob_hash,
                                "folderId": r.folder_id,
                            })),
                        }
                    })
                    .collect();

                let duration = start_time.elapsed().as_millis() as u64;

                // 发射 end 事件
                emitter.emit_end(
                    event_types::MULTIMODAL_RAG,
                    &block_id,
                    Some(json!({
                        "results": sources,
                        "durationMs": duration,
                    })),
                    None,
                );

                log::debug!(
                    "[ChatV2::pipeline] Multimodal retrieval completed: {} sources in {}ms",
                    sources.len(),
                    duration
                );

                Ok((sources, Some(block_id)))
            }
            Err(e) => {
                emitter.emit_error(event_types::MULTIMODAL_RAG, &block_id, &e.to_string(), None);
                log::warn!("[ChatV2::pipeline] Multimodal retrieval error: {}", e);
                Ok((Vec::new(), Some(block_id)))
            }
        }
    }

    /// 截断文本到指定长度
    pub(crate) fn truncate_text(text: &str, max_len: usize) -> String {
        if text.chars().count() <= max_len {
            text.to_string()
        } else {
            let truncated: String = text.chars().take(max_len).collect();
            format!("{}...", truncated)
        }
    }

    /// 执行记忆检索，返回 (sources, block_id)
    ///
    /// ★ 2026-01：已改用 Memory-as-VFS，通过 MemoryToolExecutor 执行
    /// 此方法仅在开启记忆检索时发射事件，实际检索由 LLM 工具完成
    async fn execute_memory_retrieval(
        &self,
        _query: &str,
        _session_id: &str,
        enabled: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
    ) -> ChatV2Result<(Vec<SourceInfo>, Option<String>)> {
        if !enabled {
            return Ok((Vec::new(), None));
        }

        let block_id = format!("blk_{}", Uuid::new_v4());
        emitter.emit_start(event_types::MEMORY, message_id, Some(&block_id), None, None);

        let start_time = Instant::now();

        // ★ 2026-01：使用 Memory-as-VFS
        // 记忆检索现在通过 builtin-memory_search 工具执行，此处仅返回空结果
        // LLM 会根据需要主动调用 memory_search 工具
        let sources: Vec<SourceInfo> = Vec::new();

        let duration = start_time.elapsed().as_millis() as u64;

        emitter.emit_end(
            event_types::MEMORY,
            &block_id,
            Some(json!({
                "sources": sources,
                "durationMs": duration,
                "note": "Memory retrieval now uses builtin-memory_search tool"
            })),
            None,
        );

        log::debug!(
            "[ChatV2::pipeline] Memory retrieval placeholder completed in {}ms (use builtin-memory_search tool)",
            duration
        );

        Ok((sources, Some(block_id)))
    }

    /// 执行网络搜索
    ///
    /// 调用 web_search 模块执行网络搜索，支持多种搜索引擎。
    ///
    /// ## 参数
    /// - `query`: 搜索查询字符串
    /// - `engines`: 可选的搜索引擎列表（如 ["google_cse", "bing"]）
    /// - `enabled`: 是否启用网络搜索
    /// - `emitter`: 事件发射器
    /// - `message_id`: 消息 ID
    ///
    /// ## 返回
    /// (sources, block_id) - 搜索结果列表和块 ID
    async fn execute_web_search(
        &self,
        query: &str,
        engines: &Option<Vec<String>>,
        enabled: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
    ) -> ChatV2Result<(Vec<SourceInfo>, Option<String>)> {
        if !enabled {
            return Ok((Vec::new(), None));
        }

        let block_id = format!("blk_{}", Uuid::new_v4());

        // 发射 start 事件
        emitter.emit_start(
            event_types::WEB_SEARCH,
            message_id,
            Some(&block_id),
            None,
            None,
        );

        let start_time = Instant::now();

        // 从环境变量或配置加载 web_search 配置，并应用数据库覆盖
        let mut config = match WebSearchConfig::from_env_and_file() {
            Ok(cfg) => cfg,
            Err(e) => {
                log::warn!("[ChatV2::pipeline] Failed to load web_search config: {}", e);
                // 使用默认配置继续
                WebSearchConfig::default()
            }
        };
        // 🔧 修复 #14: 统一应用数据库配置覆盖（API Keys、过滤、策略等）
        if let Some(ref db) = self.main_db {
            config.apply_db_overrides(
                |k| db.get_setting(k).ok().flatten(),
                |k| db.get_secret(k).ok().flatten(),
            );
        }

        // 构建搜索输入
        let search_input = SearchInput {
            query: query.to_string(),
            top_k: 5, // 默认返回 5 条结果
            engine: engines.as_ref().and_then(|e| e.first().cloned()),
            site: None,
            time_range: None,
            start: None,
            force_engine: None,
        };

        // 执行搜索
        let result = do_search(&config, search_input).await;
        let duration = start_time.elapsed().as_millis() as u64;

        if result.ok {
            // 将 web_search 的 citations 转换为 SourceInfo
            let sources: Vec<SourceInfo> = result
                .citations
                .unwrap_or_default()
                .into_iter()
                .map(|citation| SourceInfo {
                    title: Some(citation.file_name),
                    url: Some(citation.document_id), // document_id 存储的是 URL
                    snippet: Some(citation.chunk_text),
                    score: Some(citation.score),
                    metadata: Some(json!({
                        "sourceType": "web_search",
                        "chunkIndex": citation.chunk_index,
                        "provider": result.usage.as_ref()
                            .and_then(|u| u.get("provider"))
                            .and_then(|p| p.as_str())
                            .unwrap_or("unknown"),
                    })),
                })
                .collect();

            // 发射 end 事件
            emitter.emit_end(
                event_types::WEB_SEARCH,
                &block_id,
                Some(json!({
                    "sources": sources,
                    "durationMs": duration,
                    "usage": result.usage,
                })),
                None,
            );

            log::debug!(
                "[ChatV2::pipeline] Web search completed: {} sources in {}ms",
                sources.len(),
                duration
            );

            Ok((sources, Some(block_id)))
        } else {
            // 搜索失败，发射 error 事件
            let error_msg = result
                .error
                .map(|e| {
                    if let Some(s) = e.as_str() {
                        s.to_string()
                    } else {
                        e.to_string()
                    }
                })
                .or_else(|| result.error_details.as_ref().map(|d| d.message.clone()))
                .unwrap_or_else(|| "Unknown web search error".to_string());

            emitter.emit_error(event_types::WEB_SEARCH, &block_id, &error_msg, None);

            log::warn!(
                "[ChatV2::pipeline] Web search failed: {} ({}ms)",
                error_msg,
                duration
            );

            // 不中断流程，返回空结果但保留块 ID
            Ok((Vec::new(), Some(block_id)))
        }
    }

    /// 构建系统提示
    ///
    /// 使用 prompt_builder 模块统一格式化，采用 XML 标签分隔各部分，
    /// 统一引用格式为 `[类型-编号]`，并添加使用指引。
    /// 如果有 Canvas 笔记，也会一并注入。
    async fn build_system_prompt(&self, ctx: &PipelineContext) -> String {
        // 构建 Canvas 笔记信息（如果有）
        let canvas_note = self.build_canvas_note_info(ctx).await;
        prompt_builder::build_system_prompt(&ctx.options, &ctx.retrieved_sources, canvas_note)
    }

    /// 构建 Canvas 笔记信息
    async fn build_canvas_note_info(
        &self,
        ctx: &PipelineContext,
    ) -> Option<prompt_builder::CanvasNoteInfo> {
        let note_id = ctx.options.canvas_note_id.as_ref()?;
        let notes_mgr = self.notes_manager.as_ref()?;
        match notes_mgr.get_note(note_id) {
            Ok(note) => {
                let word_count = note.content_md.chars().count();
                log::info!(
                    "[ChatV2::pipeline] Canvas mode: loaded note '{}' ({} chars, is_long={})",
                    note.title,
                    word_count,
                    word_count >= 3000
                );
                Some(prompt_builder::CanvasNoteInfo::new(
                    note_id.clone(),
                    note.title,
                    note.content_md,
                ))
            }
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] Canvas mode: failed to read note {}: {}",
                    note_id,
                    e
                );
                None
            }
        }
    }

    /// 构建当前用户消息（用于 LLM 调用）
    ///
    /// ★ 2025-12-10 统一改造：移除 ctx.attachments 的直接处理
    /// 所有附件现在通过 user_context_refs 传递，图片和文档内容已在前端 formatToBlocks 中处理
    ///
    /// ## 统一上下文注入系统（Prompt 8）
    /// 使用 `get_combined_user_content()` 合并上下文内容和用户输入，
    /// 将 formattedBlocks 中的文本拼接到用户内容前面，图片添加到 image_base64。
    ///
    /// ## ★ 文档25：多模态图文交替支持
    /// 当上下文引用包含图片时，使用 `get_content_blocks_ordered()` 获取有序内容块，
    /// 填充 `multimodal_content` 字段以保持图文交替顺序。
    fn build_current_user_message(&self, ctx: &PipelineContext) -> LegacyChatMessage {
        // ★ 文档25：检查上下文引用是否包含图片（需要图文交替）
        let has_context_images = ctx.user_context_refs.iter().any(|r| {
            r.formatted_blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Image { .. }))
        });

        // ★ 2025-12-10 统一改造：所有内容都通过 user_context_refs 传递
        // 不再从 ctx.attachments 提取图片和文档

        let (combined_content, image_base64, multimodal_content) = if has_context_images {
            // 使用 get_content_blocks_ordered() 获取图文交替的内容块
            let ordered_blocks = ctx.get_content_blocks_ordered();

            // 转换为 MultimodalContentPart 数组
            let multimodal_parts: Vec<MultimodalContentPart> = ordered_blocks
                .into_iter()
                .map(|block| match block {
                    ContentBlock::Text { text } => MultimodalContentPart::text(text),
                    ContentBlock::Image { media_type, base64 } => {
                        MultimodalContentPart::image(media_type, base64)
                    }
                })
                .collect();

            log::info!(
                "[ChatV2::pipeline] build_current_user_message: Using multimodal mode with {} parts from context refs",
                multimodal_parts.len()
            );

            // 多模态模式：content 为空字符串，图片在 multimodal_content 中
            (String::new(), None, Some(multimodal_parts))
        } else {
            // 传统模式：使用 get_combined_user_content()
            let (combined_content, context_images) = ctx.get_combined_user_content();

            let image_base64: Option<Vec<String>> = if context_images.is_empty() {
                None
            } else {
                Some(context_images)
            };

            (combined_content, image_base64, None)
        };

        // ★ 2025-12-10 统一改造：doc_attachments 不再从 ctx.attachments 构建
        // 文档内容现在通过 user_context_refs 的 formattedBlocks 传递（已由 formatToBlocks 解析）

        LegacyChatMessage {
            role: "user".to_string(),
            content: combined_content,
            timestamp: chrono::Utc::now(),
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64,
            doc_attachments: None, // ★ 文档附件现在通过 user_context_refs 传递
            multimodal_content,    // ★ 文档25：多模态图文交替内容
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: None,
            persistent_stable_id: None,
            metadata: None,
        }
    }

    /// 执行 LLM 调用（支持工具递归）
    ///
    /// ## 工具递归流程
    /// 1. 调用 LLM 获取响应
    /// 2. 如果响应包含工具调用，执行工具
    /// 3. 将工具结果添加到聊天历史
    /// 4. 递归调用直到无工具调用或达到最大深度
    ///
    /// ## 参数
    /// - `ctx`: 流水线上下文（可变，用于存储工具结果）
    /// - `emitter`: 事件发射器
    /// - `system_prompt`: 系统提示
    /// - `recursion_depth`: 当前递归深度
    ///
    /// ## 错误
    /// - 超过最大递归深度 (MAX_TOOL_RECURSION = 5)
    /// - LLM 调用失败
    async fn execute_with_tools(
        &self,
        ctx: &mut PipelineContext,
        emitter: Arc<ChatV2EventEmitter>,
        system_prompt: &str,
        recursion_depth: u32,
    ) -> ChatV2Result<()> {
        // 检查递归深度限制
        // 🔧 配置化：使用用户设置的限制值，默认 MAX_TOOL_RECURSION (30)
        let max_recursion = ctx
            .options
            .max_tool_recursion
            .unwrap_or(MAX_TOOL_RECURSION)
            .clamp(1, 100); // 限制范围 1-100

        // 🆕 心跳机制：检测上一轮是否有 continue_execution 标志
        // 如果有，则绕过普通的递归限制（但仍受绝对上限 ABSOLUTE_MAX_RECURSION 限制）
        const ABSOLUTE_MAX_RECURSION: u32 = 500; // 硬编码绝对上限，防止无限循环
        let has_heartbeat = ctx.tool_results.iter().any(|r| {
            r.output
                .get("continue_execution")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        });

        // 绝对上限检查（不可绕过）
        if recursion_depth > ABSOLUTE_MAX_RECURSION {
            log::error!(
                "[ChatV2::pipeline] ABSOLUTE recursion limit reached: depth={}, absolute_max={}",
                recursion_depth,
                ABSOLUTE_MAX_RECURSION
            );
            return Err(ChatV2Error::Tool(format!(
                "达到绝对递归上限 ({})，任务已终止",
                ABSOLUTE_MAX_RECURSION
            )));
        }

        // 普通限制检查（可被心跳绕过）
        if recursion_depth > max_recursion && !has_heartbeat {
            log::warn!(
                "[ChatV2::pipeline] Tool recursion limit reached: depth={}, max={}",
                recursion_depth,
                max_recursion
            );

            // 创建 tool_limit 块，提示用户达到限制
            let block_id = MessageBlock::generate_id();
            let now_ms = chrono::Utc::now().timestamp_millis();
            let limit_message = format!(
                "⚠️ 已达到工具调用限制（{} 轮）\n\n\
                AI 已执行了 {} 轮工具调用。为防止无限循环，已暂停自动执行。\n\n\
                如果任务尚未完成，您可以：\n\
                • 发送「继续」让 AI 继续执行\n\
                • 发送新的指令调整方向\n\
                • 手动完成剩余步骤",
                max_recursion, max_recursion
            );

            // 发送 start 事件
            emitter.emit_start(
                event_types::TOOL_LIMIT,
                &ctx.assistant_message_id,
                Some(&block_id),
                None,
                None,
            );

            // 发送 end 事件，携带提示内容
            let result_payload = serde_json::json!({
                "content": limit_message,
                "recursionDepth": recursion_depth,
                "maxRecursion": max_recursion,
            });
            emitter.emit_end(
                event_types::TOOL_LIMIT,
                &block_id,
                Some(result_payload),
                None,
            );

            // 创建块并添加到 interleaved 列表
            let tool_limit_block = MessageBlock {
                id: block_id.clone(),
                message_id: ctx.assistant_message_id.clone(),
                block_type: block_types::TOOL_LIMIT.to_string(),
                status: block_status::SUCCESS.to_string(),
                content: Some(limit_message),
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                started_at: Some(now_ms),
                ended_at: Some(now_ms),
                first_chunk_at: Some(now_ms),
                block_index: 0, // 会被 add_interleaved_block 覆盖
            };
            ctx.add_interleaved_block(tool_limit_block);

            log::info!(
                "[ChatV2::pipeline] Created tool_limit block: id={}, message_id={}",
                block_id,
                ctx.assistant_message_id
            );

            // 正常返回，不抛出错误
            return Ok(());
        }

        log::info!(
            "[ChatV2::pipeline] Executing LLM call: session={}, recursion_depth={}, tool_results={}",
            ctx.session_id,
            recursion_depth,
            ctx.tool_results.len()
        );

        // 创建 LLM 适配器
        // 🔧 修复：默认启用 thinking，确保思维链内容能正确累积和保存
        let enable_thinking = ctx.options.enable_thinking.unwrap_or(true);
        log::info!(
            "[ChatV2::pipeline] enable_thinking={} (from options: {:?})",
            enable_thinking,
            ctx.options.enable_thinking
        );
        let adapter = Arc::new(ChatV2LLMAdapter::new(
            emitter.clone(),
            ctx.assistant_message_id.clone(),
            enable_thinking,
        ));

        // 🔧 修复：存储 adapter 引用到 ctx，确保取消时可以获取已累积内容
        ctx.current_adapter = Some(adapter.clone());

        // ============================================================
        // 构建聊天历史（包含之前的工具结果 + 当前用户消息）
        // ============================================================
        let mut messages = ctx.chat_history.clone();

        // 🔴 关键修复：添加当前用户消息到消息列表
        // 之前这里缺失，导致 LLM 看不到用户当前发送的问题
        let current_user_message = self.build_current_user_message(ctx);
        messages.push(current_user_message);
        log::debug!(
            "[ChatV2::pipeline] Added current user message: content_len={}, has_images={}, has_docs={}",
            ctx.user_content.len(),
            ctx.attachments.iter().any(|a| a.mime_type.starts_with("image/")),
            ctx.attachments.iter().any(|a| !a.mime_type.starts_with("image/"))
        );

        // 如果有工具结果（递归调用时），将**所有**工具结果添加到消息历史
        // 🔧 关键修复：由于 messages 每次从 chat_history.clone() 重建，
        // 之前只添加"新"工具结果会导致历史丢失。现在改为每次添加所有工具结果，
        // 确保 LLM 能看到完整的工具调用历史（符合 Anthropic 最佳实践：
        // "Messages API 是无状态的，必须每次发送完整对话历史"）
        if !ctx.tool_results.is_empty() {
            let tool_messages = ctx.all_tool_results_to_messages();
            let tool_count = tool_messages.len();
            messages.extend(tool_messages);

            log::debug!(
                "[ChatV2::pipeline] Added ALL {} tool result messages to chat history (tool_results count: {})",
                tool_count,
                ctx.tool_results.len()
            );
        }

        // ============================================================
        // 调用 LLM
        // ============================================================
        // 构建 LLM 调用上下文
        let mut llm_context: HashMap<String, Value> = HashMap::new();

        // 注入检索到的来源到上下文
        if let Some(ref rag_sources) = ctx.retrieved_sources.rag {
            llm_context.insert(
                "prefetched_rag_sources".into(),
                serde_json::to_value(rag_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref memory_sources) = ctx.retrieved_sources.memory {
            llm_context.insert(
                "prefetched_memory_sources".into(),
                serde_json::to_value(memory_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref web_sources) = ctx.retrieved_sources.web_search {
            llm_context.insert(
                "prefetched_web_search_sources".into(),
                serde_json::to_value(web_sources).unwrap_or(Value::Null),
            );
        }

        // ====================================================================
        // 🆕 图片压缩策略：vision_quality 智能默认
        // ====================================================================
        // 策略逻辑：
        // 1. 用户显式指定 → 直接使用
        // 2. auto/空 → 根据图片数量和来源自动选择：
        //    - 单图 + 非 PDF：high（保持原质量，便于 OCR）
        //    - 2-5 张图：medium
        //    - 6+ 张图或 PDF/教材：low（最大压缩，节省 token）
        let vision_quality = {
            // 检查用户是否显式指定
            let user_specified = ctx
                .options
                .vision_quality
                .as_deref()
                .filter(|v| !v.is_empty() && *v != "auto");

            if let Some(vq) = user_specified {
                // 用户显式指定
                log::debug!("[ChatV2::pipeline] vision_quality: user specified '{}'", vq);
                vq.to_string()
            } else {
                // 自动策略：统计图片数量和 PDF/教材来源
                let mut image_count = 0usize;
                let mut has_pdf_or_textbook = false;

                for ctx_ref in &ctx.user_context_refs {
                    // 统计图片块数量
                    for block in &ctx_ref.formatted_blocks {
                        if matches!(block, super::resource_types::ContentBlock::Image { .. }) {
                            image_count += 1;
                        }
                    }
                    // 检查是否有 PDF/教材来源（通过 type_id 判断）
                    let type_id_lower = ctx_ref.type_id.to_lowercase();
                    if type_id_lower.contains("pdf")
                        || type_id_lower.contains("textbook")
                        || type_id_lower.contains("file")
                        || ctx_ref.resource_id.starts_with("tb_")
                    {
                        has_pdf_or_textbook = true;
                    }
                }

                // 智能策略
                let auto_quality = if has_pdf_or_textbook || image_count >= 6 {
                    "low" // PDF/教材 或大量图片：最大压缩
                } else if image_count >= 2 {
                    "medium" // 中等数量：平衡压缩
                } else {
                    "high" // 单图或无图：保持原质量
                };

                log::info!(
                    "[ChatV2::pipeline] vision_quality: auto -> '{}' (images={}, has_pdf_or_textbook={})",
                    auto_quality, image_count, has_pdf_or_textbook
                );
                auto_quality.to_string()
            }
        };

        // 注入到 LLM 上下文
        llm_context.insert(
            "vision_quality".into(),
            Value::String(vision_quality.clone()),
        );

        // ====================================================================
        // 统一工具注入：使用 schema_tool_ids 注入工具 Schema
        // 遵循文档 26：统一工具注入系统架构设计
        // 🆕 文档 29 P1-4：自动注入 attempt_completion 工具（Agent 模式必备）
        // ====================================================================

        // 构建工具列表，自动添加 Agent 必备工具（如果有其他工具被注入）
        // 注意：内置工具（包括 TodoList）应该通过内置 MCP 服务器注入，不在此处添加
        let effective_tool_ids: Option<Vec<String>> = match ctx.options.schema_tool_ids.as_ref() {
            Some(ids) if !ids.is_empty() => {
                let mut extended_ids = ids.clone();

                // 🆕 自动添加 attempt_completion 到工具列表（如果尚未包含）
                // 这是唯一需要在此添加的工具，因为它是 Agent 模式的终止信号
                if !extended_ids
                    .iter()
                    .any(|id| id == super::tools::attempt_completion::TOOL_NAME)
                {
                    extended_ids.push(super::tools::attempt_completion::TOOL_NAME.to_string());
                    log::debug!(
                        "[ChatV2::pipeline] Auto-injected attempt_completion tool (Agent mode)"
                    );
                }

                Some(extended_ids)
            }
            _ => None,
        };

        let injected_count = super::tools::injector::inject_tool_schemas(
            effective_tool_ids.as_ref(),
            &mut llm_context,
        );
        if injected_count > 0 {
            log::info!(
                "[ChatV2::pipeline] Injected {} tool schemas via schema_tool_ids",
                injected_count
            );
        }

        // ====================================================================
        // 🆕 Workspace 工具注入：已迁移到内置 MCP 服务器
        // ====================================================================
        // 2026-01-16: Workspace 工具已迁移到 builtinMcpServer.ts，
        // 通过前端 mcp_tool_schemas 传递，不再需要后端自动注入。
        // 执行器 WorkspaceToolExecutor 仍然保留，负责处理 builtin-workspace_* 工具调用。
        //
        // 旧代码已移除：后端自动注入会导致工具重复（builtin-workspace_create vs workspace_create）
        if ctx.get_workspace_id().is_some() && self.workspace_coordinator.is_some() {
            log::debug!(
                "[ChatV2::pipeline] Workspace session detected, tools should come from builtin MCP server"
            );
        }

        // ====================================================================
        // 🆕 MCP 工具注入：使用前端传递的 mcp_tool_schemas
        // ====================================================================
        // 架构说明：
        // - 前端 mcpService 管理多 MCP 服务器连接，并缓存工具 Schema
        // - 前端 TauriAdapter 从 mcpService 获取选中服务器的工具 Schema
        // - 后端直接使用前端传递的 Schema，无需自己连接 MCP 服务器
        // - 🔧 P1-49：后端应用 whitelist/blacklist 策略过滤，确保配置生效

        // 🔍 调试日志：检查 mcp_tool_schemas 在 pipeline 中的状态
        let mcp_schema_count = ctx
            .options
            .mcp_tool_schemas
            .as_ref()
            .map(|s| s.len())
            .unwrap_or(0);
        log::info!(
            "[ChatV2::pipeline] 🔍 MCP tool schemas check: count={}, is_some={}",
            mcp_schema_count,
            ctx.options.mcp_tool_schemas.is_some()
        );

        if let Some(ref tool_schemas) = ctx.options.mcp_tool_schemas {
            if !tool_schemas.is_empty() {
                log::info!(
                    "[ChatV2::pipeline] Processing {} MCP tool schemas from frontend",
                    tool_schemas.len()
                );

                // 🔧 P1-49: 读取 MCP 策略配置（whitelist/blacklist）
                let (whitelist, blacklist) = if let Some(ref main_db) = self.main_db {
                    let whitelist: Vec<String> = main_db
                        .get_setting("mcp.tools.whitelist")
                        .ok()
                        .flatten()
                        .map(|s| {
                            s.split(',')
                                .map(|x| x.trim().to_string())
                                .filter(|x| !x.is_empty())
                                .collect()
                        })
                        .unwrap_or_default();
                    let blacklist: Vec<String> = main_db
                        .get_setting("mcp.tools.blacklist")
                        .ok()
                        .flatten()
                        .map(|s| {
                            s.split(',')
                                .map(|x| x.trim().to_string())
                                .filter(|x| !x.is_empty())
                                .collect()
                        })
                        .unwrap_or_default();
                    (whitelist, blacklist)
                } else {
                    (Vec::new(), Vec::new())
                };

                log::debug!(
                    "[ChatV2::pipeline] MCP policy: whitelist={:?}, blacklist={:?}",
                    whitelist,
                    blacklist
                );

                // 将前端传递的 MCP 工具 Schema 转换为 LLM 可用的格式
                // 🔧 P1-49: 应用 whitelist/blacklist 过滤
                let mcp_tool_values: Vec<Value> = tool_schemas
                    .iter()
                    .filter(|tool| {
                        // builtin- 前缀的工具不受策略过滤影响
                        if tool.name.starts_with(BUILTIN_NAMESPACE) {
                            return true;
                        }
                        // 黑名单优先级最高
                        if !blacklist.is_empty() && blacklist.iter().any(|b| b == &tool.name) {
                            log::debug!(
                                "[ChatV2::pipeline] Tool '{}' blocked by blacklist",
                                tool.name
                            );
                            return false;
                        }
                        // 如果白名单非空，工具必须在白名单中
                        if !whitelist.is_empty() && !whitelist.iter().any(|w| w == &tool.name) {
                            log::debug!("[ChatV2::pipeline] Tool '{}' not in whitelist", tool.name);
                            return false;
                        }
                        true
                    })
                    .map(|tool| {
                        // 🔧 P0-19 修复：builtin- 前缀的工具保持原名，MCP 工具添加 mcp_ 前缀
                        // 原因：executor 检查 tool_name.starts_with("builtin-")，
                        //       如果变成 "mcp_builtin-..." 则无法匹配
                        let tool_name = if tool.name.starts_with(BUILTIN_NAMESPACE) {
                            tool.name.clone()
                        } else {
                            format!("mcp_{}", tool.name)
                        };
                        json!({
                            "type": "function",
                            "function": {
                                "name": tool_name,
                                "description": tool.description.clone().unwrap_or_default(),
                                "parameters": tool.input_schema.clone().unwrap_or(json!({}))
                            }
                        })
                    })
                    .collect();

                let filtered_count = mcp_tool_values.len();
                let original_count = tool_schemas.len();
                if filtered_count < original_count {
                    log::info!(
                        "[ChatV2::pipeline] MCP policy filtered: {}/{} tools allowed",
                        filtered_count,
                        original_count
                    );
                }

                // 合并到 custom_tools（如果已存在则追加）
                if !mcp_tool_values.is_empty() {
                    if let Some(existing) = llm_context.get_mut("custom_tools") {
                        if let Some(arr) = existing.as_array_mut() {
                            for schema in mcp_tool_values {
                                arr.push(schema);
                            }
                            log::info!(
                                "[ChatV2::pipeline] Appended {} MCP tools to custom_tools",
                                filtered_count
                            );
                        }
                    } else {
                        llm_context.insert("custom_tools".into(), Value::Array(mcp_tool_values));
                        log::info!(
                            "[ChatV2::pipeline] Injected {} MCP tools as custom_tools",
                            filtered_count
                        );
                    }
                }

                // 记录工具名称用于调试
                let tool_names: Vec<&str> = tool_schemas.iter().map(|t| t.name.as_str()).collect();
                log::debug!(
                    "[ChatV2::pipeline] MCP tools (before filter): {:?}",
                    tool_names
                );
            }
        }

        // 生成流事件标识符
        let stream_event = format!("chat_v2_event_{}", ctx.session_id);

        // 注册 LLM 流式回调 hooks
        self.llm_manager
            .register_stream_hooks(&stream_event, adapter.clone())
            .await;

        // 获取调用选项
        // 🔧 P0修复：始终禁用 LLM Manager 内部的工具执行，由 Pipeline 完全接管
        // 这避免了工具被执行两次（LLM Manager 内部一次，Pipeline 一次）
        // 以及工具调用 start 事件被重复发射的问题
        let disable_tools = true;
        // 🔧 P0修复：优先使用 model2_override_id（ModelPanel 中选择的模型），其次使用 model_id
        let model_override = ctx
            .options
            .model2_override_id
            .clone()
            .or_else(|| ctx.options.model_id.clone());
        let temp_override = ctx.options.temperature;
        let top_p_override = ctx.options.top_p;
        let frequency_penalty_override = ctx.options.frequency_penalty;
        let presence_penalty_override = ctx.options.presence_penalty;
        let max_tokens_override = ctx.options.max_tokens;
        // 🔧 P1修复：将 context_limit 作为 max_input_tokens_override 传递给 LLM
        let max_input_tokens_override = ctx.options.context_limit.map(|v| v as usize);
        // 🔧 P2修复：始终使用 prompt_builder 生成的 system_prompt（XML 格式）
        // prompt_builder 已经将前端传入的 system_prompt_override 作为 base_prompt 处理
        // 不再让前端的值直接覆盖，避免丢失 LaTeX 规则等 XML 格式内容
        let system_prompt_override = Some(system_prompt.to_string());

        // 获取 window 用于流式事件发射
        let window = emitter.window();

        log::info!(
            "[ChatV2::pipeline] Calling LLMManager, stream_event={}, model_override={:?}, top_p={:?}, max_tokens={:?}, max_input_tokens={:?}",
            stream_event,
            model_override,
            top_p_override,
            max_tokens_override,
            max_input_tokens_override
        );

        // 调用 LLMManager 的流式接口
        // 🔧 P1修复：添加 Pipeline 层超时保护，不完全依赖上游 LLM 配置
        let llm_future = self.llm_manager.call_unified_model_2_stream(
            &llm_context,
            &messages,
            "",   // subject - Chat V2 不使用科目
            true, // enable_chain_of_thought
            enable_thinking,
            Some("chat_v2"),
            window,
            &stream_event,
            None, // trace_id
            disable_tools,
            max_input_tokens_override, // 🔧 P1修复：传递 context_limit 作为输入 token 限制
            model_override,
            temp_override,
            system_prompt_override,
            top_p_override,
            frequency_penalty_override,
            presence_penalty_override,
            max_tokens_override,
        );

        let call_result =
            match timeout(Duration::from_secs(LLM_STREAM_TIMEOUT_SECS), llm_future).await {
                Ok(result) => result,
                Err(_) => {
                    log::error!(
                        "[ChatV2::pipeline] LLM stream call timeout after {}s, session={}",
                        LLM_STREAM_TIMEOUT_SECS,
                        ctx.session_id
                    );
                    return Err(ChatV2Error::Timeout(format!(
                        "LLM stream call timed out after {}s",
                        LLM_STREAM_TIMEOUT_SECS
                    )));
                }
            };

        // 注销 hooks
        self.llm_manager
            .unregister_stream_hooks(&stream_event)
            .await;

        // 处理 LLM 调用结果
        match call_result {
            Ok(output) => {
                log::info!(
                    "[ChatV2::pipeline] LLM call succeeded, cancelled={}, content_len={}",
                    output.cancelled,
                    output.assistant_message.len()
                );

                // 更新上下文
                ctx.final_content = adapter.get_accumulated_content();
                ctx.final_reasoning = adapter.get_accumulated_reasoning();
                // 🔧 修复：保存流式过程中创建的块 ID，确保 save_results 使用相同的 ID
                ctx.streaming_thinking_block_id = adapter.get_thinking_block_id();
                ctx.streaming_content_block_id = adapter.get_content_block_id();

                log::info!(
                    "[ChatV2::pipeline] After LLM call: final_content_len={}, final_reasoning={:?}, thinking_block_id={:?}, content_block_id={:?}",
                    ctx.final_content.len(),
                    ctx.final_reasoning.as_ref().map(|r| r.len()),
                    ctx.streaming_thinking_block_id,
                    ctx.streaming_content_block_id
                );

                // 如果 adapter 累积内容为空但输出不为空，使用 LLM 输出
                if ctx.final_content.is_empty() && !output.assistant_message.is_empty() {
                    ctx.final_content = output.assistant_message.clone();
                }

                // ============================================================
                // Token 使用量统计与累加（Prompt 4）
                // ============================================================
                let round_usage = self.get_or_estimate_usage(
                    &adapter,
                    &messages,
                    &ctx.final_content,
                    system_prompt,
                    ctx.options.model_id.as_deref(),
                );

                // 累加到 PipelineContext.token_usage
                ctx.token_usage.accumulate(&round_usage);

                log::info!(
                    "[ChatV2::pipeline] Token usage for round {}: prompt={}, completion={}, total={}, source={}; Accumulated: prompt={}, completion={}, total={}, source={}",
                    recursion_depth,
                    round_usage.prompt_tokens,
                    round_usage.completion_tokens,
                    round_usage.total_tokens,
                    round_usage.source,
                    ctx.token_usage.prompt_tokens,
                    ctx.token_usage.completion_tokens,
                    ctx.token_usage.total_tokens,
                    ctx.token_usage.source
                );

                // 记录 LLM 使用量到数据库
                // 🔧 修复：优先使用解析后的模型显示名称，避免显示配置 ID
                let model_for_usage = ctx
                    .model_display_name
                    .as_deref()
                    .or(ctx.options.model_id.as_deref())
                    .unwrap_or("unknown");
                crate::llm_usage::record_llm_usage(
                    crate::llm_usage::CallerType::ChatV2,
                    model_for_usage,
                    round_usage.prompt_tokens,
                    round_usage.completion_tokens,
                    None, // reasoning_tokens - adapter 层面已单独处理
                    None, // cached_tokens
                    Some(ctx.session_id.clone()),
                    None, // duration_ms - 在 adapter 层面已记录
                    true,
                    None,
                );
            }
            Err(e) => {
                // 调用 adapter 的错误处理
                adapter.on_error(&e.to_string());
                log::error!("[ChatV2::pipeline] LLM call failed: {}", e);

                // 记录失败的 LLM 调用
                // 🔧 修复：优先使用解析后的模型显示名称，避免显示配置 ID
                let model_for_usage = ctx
                    .model_display_name
                    .as_deref()
                    .or(ctx.options.model_id.as_deref())
                    .unwrap_or("unknown");
                crate::llm_usage::record_llm_usage(
                    crate::llm_usage::CallerType::ChatV2,
                    model_for_usage,
                    0,
                    0,
                    None,
                    None,
                    Some(ctx.session_id.clone()),
                    None,
                    false,
                    Some(e.to_string()),
                );

                return Err(ChatV2Error::Llm(e.to_string()));
            }
        }

        // ============================================================
        // 处理 LLM 返回的工具调用
        // 工具调用通过 LLMStreamHooks.on_tool_call() 回调收集到 adapter 中。
        // 在 LLM 调用完成后，从 adapter 取出收集到的工具调用进行处理。
        // ============================================================
        let tool_calls = adapter.take_tool_calls();

        // 如果有工具调用，执行并递归
        if !tool_calls.is_empty() {
            log::info!(
                "[ChatV2::pipeline] LLM returned {} tool calls, executing sequentially...",
                tool_calls.len()
            );

            // ============================================================
            // Interleaved Thinking 支持：收集本轮产生的 thinking/content 块
            // 在工具调用之前，将本轮的 thinking 块添加到交替列表
            // 注意：工具调用模式下，LLM 通常不会返回 content（返回 tool_use 代替）
            // ============================================================
            let current_reasoning = adapter.get_accumulated_reasoning();
            ctx.collect_round_blocks(
                adapter.get_thinking_block_id(),
                current_reasoning.clone(),
                None, // 工具调用模式下，content 块通常为空
                None,
                &ctx.assistant_message_id.clone(),
            );

            // 🔧 修复：发射 thinking 块的 end 事件，通知前端思维链已结束
            // 之前只调用了 collect_round_blocks 收集数据，但没有发射 end 事件
            // 这导致前端一直显示"思考中..."状态
            adapter.finalize_all();

            // 🔧 DeepSeek Thinking Mode：保存 reasoning_content 用于下一轮 API 调用
            // 根据 DeepSeek API 文档，在工具调用迭代中需要回传 reasoning_content
            ctx.pending_reasoning_for_api = current_reasoning;
            log::debug!(
                "[ChatV2::pipeline] Interleaved: collected thinking block for round {}, total blocks={}, pending_reasoning={}",
                recursion_depth,
                ctx.interleaved_block_ids.len(),
                ctx.pending_reasoning_for_api.as_ref().map(|s| s.len()).unwrap_or(0)
            );

            // ============================================================
            // 🆕 P15 修复（补充）：工具执行前中间保存点
            // 确保 thinking 块等已生成内容在工具执行（可能阻塞）前被持久化
            // 关键场景：coordinator_sleep 会阻塞，如果只在工具执行后保存，保存永远不会执行
            // ============================================================
            if let Err(e) = self.save_intermediate_results(ctx).await {
                log::warn!(
                    "[ChatV2::pipeline] Failed to save intermediate results before tool execution: {}",
                    e
                );
            } else if !ctx.interleaved_blocks.is_empty() {
                log::info!(
                    "[ChatV2::pipeline] Pre-tool intermediate save completed, blocks={}",
                    ctx.interleaved_block_ids.len()
                );
            }

            // 并行执行所有工具调用
            let canvas_note_id = ctx.options.canvas_note_id.clone();
            // 🆕 P1-C: 传递 skill_allowed_tools 进行工具执行校验
            let skill_allowed_tools = ctx.options.skill_allowed_tools.clone();
            // 🆕 渐进披露：传递 skill_contents 给工具执行器
            let skill_contents = ctx.options.skill_contents.clone();
            let active_skill_ids = ctx.options.active_skill_ids.clone();
            let rag_top_k = ctx.options.rag_top_k;
            let rag_enable_reranking = ctx.options.rag_enable_reranking;
            // 🆕 取消支持：传递取消令牌给工具执行器
            let cancel_token = ctx.cancellation_token();
            let tool_results = self
                .execute_tool_calls(
                    &tool_calls,
                    &emitter,
                    &ctx.session_id,
                    &ctx.assistant_message_id,
                    &canvas_note_id,
                    &skill_allowed_tools,
                    &skill_contents,
                    &active_skill_ids,
                    cancel_token,
                    rag_top_k,
                    rag_enable_reranking,
                )
                .await?;

            // 记录执行结果
            let success_count = tool_results.iter().filter(|r| r.success).count();
            log::info!(
                "[ChatV2::pipeline] Tool execution completed: {}/{} succeeded",
                success_count,
                tool_results.len()
            );

            // ============================================================
            // 🆕 渐进披露：load_skills 执行后动态追加工具到 tools 数组
            // ============================================================
            for tool_result in &tool_results {
                if super::tools::SkillsExecutor::is_load_skills_tool(&tool_result.tool_name)
                    && tool_result.success
                {
                    // 从工具结果中提取加载的 skill_ids
                    if let Some(skill_ids) = tool_result
                        .output
                        .get("result")
                        .and_then(|r| r.get("skill_ids"))
                        .and_then(|ids| ids.as_array())
                    {
                        let loaded_skill_ids: Vec<String> = skill_ids
                            .iter()
                            .filter_map(|id| id.as_str().map(|s| s.to_string()))
                            .collect();

                        if !loaded_skill_ids.is_empty() {
                            // 从 skill_embedded_tools 中获取对应的工具 Schema
                            if let Some(ref embedded_tools_map) = ctx.options.skill_embedded_tools {
                                let mut new_tools: Vec<super::types::McpToolSchema> = Vec::new();
                                for skill_id in &loaded_skill_ids {
                                    if let Some(tools) = embedded_tools_map.get(skill_id) {
                                        for tool in tools {
                                            new_tools.push(tool.clone());
                                        }
                                    }
                                }

                                if !new_tools.is_empty() {
                                    // 动态追加到 mcp_tool_schemas（去重）
                                    let mcp_schemas =
                                        ctx.options.mcp_tool_schemas.get_or_insert_with(Vec::new);
                                    let before_count = mcp_schemas.len();

                                    // 收集已存在的工具名称用于去重（使用 owned String 避免借用问题）
                                    let existing_names: std::collections::HashSet<String> =
                                        mcp_schemas.iter().map(|t| t.name.clone()).collect();

                                    let mut added_count = 0;
                                    for tool in new_tools {
                                        if !existing_names.contains(&tool.name) {
                                            mcp_schemas.push(tool);
                                            added_count += 1;
                                        }
                                    }

                                    if added_count > 0 {
                                        log::info!(
                                            "[ChatV2::pipeline] 🆕 Progressive disclosure: added {} tools from skills {:?}, total tools: {} -> {}",
                                            added_count,
                                            loaded_skill_ids,
                                            before_count,
                                            mcp_schemas.len()
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // ============================================================
            // Interleaved Thinking 支持：添加工具调用块到交替列表
            // ============================================================
            let message_id = ctx.assistant_message_id.clone();
            for tool_result in &tool_results {
                ctx.add_tool_block(tool_result, &message_id);
            }
            log::debug!(
                "[ChatV2::pipeline] Interleaved: added {} tool blocks, total blocks={}",
                tool_results.len(),
                ctx.interleaved_block_ids.len()
            );

            // 🆕 文档 29 P1-4：检测 attempt_completion 的 task_completed 标志
            // 如果检测到任务完成，终止递归循环，不再继续调用 LLM
            let task_completed = tool_results.iter().any(|r| {
                r.output
                    .get("task_completed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            });

            // 🆕 心跳机制：检测 continue_execution 标志（TodoList 永续执行）
            // 如果任何工具返回 continue_execution: true，则绕过轮次限制继续执行
            let has_continue_execution = tool_results.iter().any(|r| {
                r.output
                    .get("continue_execution")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            });
            if has_continue_execution {
                log::info!(
                    "[ChatV2::pipeline] Heartbeat detected: continue_execution=true, will bypass recursion limit"
                );
            }

            // 🆕 持久化 TodoList 状态（消息内继续执行支持）
            // 检测是否有 todo 工具调用，如果有则持久化到数据库
            for tool_result in &tool_results {
                if tool_result.tool_name.contains("todo_") {
                    // 从内存获取当前 TodoList 状态并持久化
                    if let Some(todo_list) =
                        super::tools::todo_executor::get_todo_list(&ctx.session_id)
                    {
                        if let Err(e) = super::tools::todo_executor::persist_todo_list(
                            &self.db,
                            &ctx.session_id,
                            &ctx.assistant_message_id,
                            None, // variant_id 暂时为 None，后续可从 ctx 获取
                            &todo_list,
                        ) {
                            log::warn!("[ChatV2::pipeline] Failed to persist TodoList: {}", e);
                        } else {
                            log::debug!(
                                "[ChatV2::pipeline] TodoList persisted: session={}, progress={}/{}",
                                ctx.session_id,
                                todo_list.completed_count(),
                                todo_list.total_count()
                            );
                        }
                    }
                    break; // 只需持久化一次
                }
            }

            // 将工具结果添加到上下文
            // 🔧 思维链修复：为这一批工具结果中的第一个附加当前轮次的思维链
            // 一轮 LLM 调用可能产生多个工具调用，但只有一个思维链
            let tool_results_with_reasoning: Vec<_> = tool_results
                .into_iter()
                .enumerate()
                .map(|(i, mut result)| {
                    if i == 0 {
                        // 只有第一个工具结果携带这一轮的思维链
                        result.reasoning_content = ctx.pending_reasoning_for_api.clone();
                    }
                    result
                })
                .collect();
            ctx.add_tool_results(tool_results_with_reasoning);

            // ============================================================
            // 🆕 P15 修复：工具执行后中间保存点
            // 确保工具执行结果被持久化，防止后续阻塞操作（如睡眠）期间刷新丢失数据
            // ============================================================
            if let Err(e) = self.save_intermediate_results(ctx).await {
                log::warn!(
                    "[ChatV2::pipeline] Failed to save intermediate results after tool execution: {}",
                    e
                );
                // 不阻塞流程，继续执行
            } else {
                log::info!(
                    "[ChatV2::pipeline] Intermediate save completed after tool round {}, blocks={}",
                    recursion_depth,
                    ctx.interleaved_block_ids.len()
                );
            }

            // ============================================================
            // 空闲期检测点 2：工具执行完成后检查 inbox
            // 设计文档 30：在工具执行完成后、下一轮 LLM 调用前检查
            // ============================================================
            if let Some(workspace_id) = ctx.get_workspace_id() {
                if let Some(ref coordinator) = self.workspace_coordinator {
                    use super::workspace::WorkspaceInjector;

                    let injector = WorkspaceInjector::new(coordinator.clone());
                    let max_injections = 2u32; // 工具执行后最多处理 2 批消息

                    if let Ok(injection_result) =
                        injector.check_and_inject(workspace_id, &ctx.session_id, max_injections)
                    {
                        if !injection_result.messages.is_empty() {
                            let formatted = WorkspaceInjector::format_injected_messages(
                                &injection_result.messages,
                            );
                            ctx.inject_workspace_messages(formatted);

                            log::info!(
                                "[ChatV2::pipeline] Workspace tool-phase injection: {} messages, depth={}",
                                injection_result.messages.len(),
                                recursion_depth
                            );
                        }
                    }
                }
            }

            if task_completed {
                log::info!(
                    "[ChatV2::pipeline] Task completed detected via attempt_completion, stopping recursive loop at depth={}",
                    recursion_depth
                );

                // 收集当前轮次的块（无需再次调用 LLM）
                ctx.collect_round_blocks(
                    adapter.get_thinking_block_id(),
                    adapter.get_accumulated_reasoning(),
                    adapter.get_content_block_id(),
                    Some(ctx.final_content.clone()),
                    &ctx.assistant_message_id.clone(),
                );

                // 清除 pending_reasoning
                ctx.pending_reasoning_for_api = None;

                return Ok(());
            }

            // 递归调用 LLM 处理工具结果
            log::debug!(
                "[ChatV2::pipeline] Recursively calling LLM to process tool results, depth={}->{}",
                recursion_depth,
                recursion_depth + 1
            );
            return Box::pin(self.execute_with_tools(
                ctx,
                emitter,
                system_prompt,
                recursion_depth + 1,
            ))
            .await;
        }

        // ============================================================
        // 无工具调用，这是最后一轮 LLM 调用
        // 收集最终的 thinking 和 content 块
        // ============================================================
        ctx.collect_round_blocks(
            adapter.get_thinking_block_id(),
            adapter.get_accumulated_reasoning(),
            adapter.get_content_block_id(),
            Some(ctx.final_content.clone()),
            &ctx.assistant_message_id.clone(),
        );

        // 🔧 DeepSeek Thinking Mode：清除 pending_reasoning
        // 根据 DeepSeek API 文档，新的用户问题不需要回传之前的 reasoning_content
        ctx.pending_reasoning_for_api = None;

        log::info!(
            "[ChatV2::pipeline] LLM call completed without tool calls, recursion_depth={}, total interleaved_blocks={}",
            recursion_depth,
            ctx.interleaved_block_ids.len()
        );

        Ok(())
    }

    /// 并行执行多个工具调用
    ///
    /// 使用 `futures::future::join_all` 并行执行所有工具调用，
    /// 超时策略由 ToolExecutorRegistry 统一控制。
    ///
    /// ## 参数
    /// - `tool_calls`: 工具调用列表
    /// - `emitter`: 事件发射器
    /// - `session_id`: 会话 ID（用于工具状态隔离，如 TodoList）
    /// - `message_id`: 消息 ID（用于关联块）
    /// - `canvas_note_id`: Canvas 笔记 ID，用于 Canvas 工具默认值
    /// - `skill_allowed_tools`: 🆕 P1-C Skill 工具白名单（如果设置，只允许执行白名单中的工具）
    ///
    /// ## 返回
    /// 工具调用结果列表
    /// 对工具调用列表进行依赖感知排序
    ///
    /// 规则（按优先级从高到低）：
    /// 1. chatanki: run/start → control → status/analyze → wait → export/sync
    /// 2. pptx/xlsx/docx: _create 必须在 _read/_extract/_get/_replace/_edit/_to_spec 之前
    /// 3. 同优先级内保持原始顺序（stable sort）
    fn ordered_tool_calls_for_execution(&self, tool_calls: &[ToolCall]) -> Vec<ToolCall> {
        /// 剥离工具名前缀，返回短名
        fn strip_tool_prefix(tool_name: &str) -> &str {
            // builtin-xxx, mcp_xxx, mcp.tools.xxx, namespace.xxx
            tool_name
                .strip_prefix(BUILTIN_NAMESPACE)
                .or_else(|| tool_name.strip_prefix("mcp_"))
                .or_else(|| tool_name.strip_prefix("mcp.tools."))
                .unwrap_or(tool_name)
        }

        /// ChatAnki 工具优先级
        fn chatanki_priority(short_name: &str) -> Option<u8> {
            if !short_name.starts_with("chatanki_") {
                return None;
            }
            let p = match short_name {
                "chatanki_run" | "chatanki_start" => 0,
                "chatanki_control" => 1,
                "chatanki_status"
                | "chatanki_list_templates"
                | "chatanki_analyze"
                | "chatanki_check_anki_connect" => 2,
                "chatanki_wait" => 3,
                "chatanki_export" | "chatanki_sync" => 4,
                _ => 2,
            };
            Some(p)
        }

        /// 文档工具优先级（pptx/xlsx/docx）
        /// _create = 0, 其余 = 1, 不匹配 = None
        fn document_tool_priority(short_name: &str) -> Option<u8> {
            // 检测是否属于文档工具族
            let prefixes = ["pptx_", "xlsx_", "docx_"];
            let matched_prefix = prefixes.iter().find(|p| short_name.starts_with(**p));
            let prefix = match matched_prefix {
                Some(p) => *p,
                None => return None,
            };

            let action = &short_name[prefix.len()..];
            let p = match action {
                "create" => 0,                       // 创建文件 — 必须最先
                "read_structured" | "get_metadata"   // 只读操作
                | "extract_tables" => 1,
                "edit_cells" | "replace_text" => 2,  // 写操作（依赖文件存在）
                "to_spec" => 3,                      // 转换操作（依赖文件存在）
                _ => 1,                              // 未知动作，按只读对待
            };
            Some(p)
        }

        /// 综合优先级：(group_priority, action_priority)
        /// group 0 = chatanki, 1 = document, 99 = other
        fn tool_priority(tool_name: &str) -> (u8, u8) {
            let short = strip_tool_prefix(tool_name);
            if let Some(p) = chatanki_priority(short) {
                return (0, p);
            }
            if let Some(p) = document_tool_priority(short) {
                return (1, p);
            }
            (99, 0)
        }

        // 快速路径：如果没有需要排序的工具，直接返回原始顺序
        let needs_sort = tool_calls.iter().any(|call| {
            let short = strip_tool_prefix(&call.name);
            chatanki_priority(short).is_some() || document_tool_priority(short).is_some()
        });
        if !needs_sort {
            return tool_calls.to_vec();
        }

        let mut indexed_calls: Vec<(usize, ToolCall)> =
            tool_calls.iter().cloned().enumerate().collect();
        // stable sort: 先按 tool_priority，同优先级保持原始顺序（idx）
        indexed_calls.sort_by_key(|(idx, call)| {
            let (group, action) = tool_priority(&call.name);
            (group, action, *idx)
        });

        let reordered: Vec<ToolCall> =
            indexed_calls.into_iter().map(|(_, call)| call).collect();

        // 日志：如果顺序发生变化，记录重排结果
        if reordered
            .iter()
            .zip(tool_calls.iter())
            .any(|(a, b)| a.id != b.id)
        {
            let names: Vec<&str> = reordered.iter().map(|c| c.name.as_str()).collect();
            log::info!(
                "[ChatV2::pipeline] Tool calls reordered for dependency safety: {:?}",
                names
            );
        }

        reordered
    }

    async fn execute_tool_calls(
        &self,
        tool_calls: &[ToolCall],
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        canvas_note_id: &Option<String>,
        skill_allowed_tools: &Option<Vec<String>>,
        skill_contents: &Option<std::collections::HashMap<String, String>>,
        active_skill_ids: &Option<Vec<String>>,
        cancellation_token: Option<&CancellationToken>,
        rag_top_k: Option<u32>,
        rag_enable_reranking: Option<bool>,
    ) -> ChatV2Result<Vec<ToolResultInfo>> {
        let ordered_tool_calls = self.ordered_tool_calls_for_execution(tool_calls);
        log::debug!(
            "[ChatV2::pipeline] Executing {} tool calls sequentially",
            ordered_tool_calls.len()
        );

        // 🔧 2026-02-16: 追踪本批次 _create 工具返回的 file_id，用于修正依赖工具中
        // LLM 凭空捏造的 resource_id（LLM 在同一批次生成 create + read/edit 时，
        // 无法提前知道 create 返回的实际 file_id）
        // key: 文档类型前缀 ("xlsx" / "pptx" / "docx")
        // value: create 工具返回的实际 file_id
        let mut created_file_ids: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        // 顺序执行工具调用，避免非幂等工具并发导致的数据竞态
        let mut tool_results = Vec::new();
        for tc in ordered_tool_calls.iter() {
            // 检测截断标记：LLM 输出被 max_tokens 截断导致工具调用 JSON 不完整
            // 此时不执行工具，直接返回错误 tool_result 让 LLM 缩小输出重试
            if tc
                .arguments
                .get("_truncation_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let error_msg = tc
                    .arguments
                    .get("_error_message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("工具调用参数被截断");
                let args_len = tc
                    .arguments
                    .get("_args_len")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                log::warn!(
                    "[ChatV2::pipeline] 工具调用 JSON 被截断，跳过执行并反馈 LLM 重试: tool={}, args_len={}",
                    tc.name,
                    args_len
                );

                // 🆕 P1 修复：生成 block_id 并发射前端事件，让用户看到截断错误
                let block_id = MessageBlock::generate_id();
                let truncation_display_msg = format!(
                    "工具调用 {} 的参数因输出长度超限被截断（已生成 {} 字符），工具未执行，正在自动重试。",
                    tc.name, args_len
                );

                // 发射 tool_call start 事件（创建前端块）
                emitter.emit_tool_call_start(
                    message_id,
                    &block_id,
                    &tc.name,
                    json!({ "_truncated": true, "_args_len": args_len }),
                    Some(&tc.id),
                    None, // variant_id
                );

                // 发射 tool_call error 事件（标记块为错误状态）
                emitter.emit_error(
                    event_types::TOOL_CALL,
                    &block_id,
                    &truncation_display_msg,
                    None, // variant_id
                );

                let retry_hint = format!(
                    "CRITICAL ERROR: Tool call '{}' FAILED — your output was truncated at {} characters because it exceeded the max_tokens limit. The JSON arguments were incomplete and the tool was NOT executed.\n\n\
                    YOU MUST retry with significantly smaller arguments. Mandatory rules:\n\
                    1. Reduce the total argument size to under 50% of the previous attempt.\n\
                    2. For mindmap_create: create only the skeleton (top-level branches + minimal children), then use edit_nodes to add details incrementally.\n\
                    3. For any tool: remove verbose text, avoid deeply nested structures, keep JSON compact.\n\
                    4. If the content is inherently large, split it into multiple smaller tool calls.\n\n\
                    Do NOT repeat the same call with the same size — it will fail again.",
                    tc.name, args_len
                );

                tool_results.push(ToolResultInfo {
                    tool_call_id: Some(tc.id.clone()),
                    block_id: Some(block_id),
                    tool_name: tc.name.clone(),
                    input: tc.arguments.clone(),
                    output: json!({ "error": error_msg }),
                    success: false,
                    error: Some(retry_hint),
                    duration_ms: None,
                    reasoning_content: None,
                });
                continue;
            }

            // 🔧 2026-02-16: 修正依赖工具的 resource_id
            // 当 LLM 在同一批次生成 create + 依赖工具时，依赖工具的 resource_id
            // 是 LLM 捏造的（因为 create 还没返回真实 ID）。
            // 这里检测并替换为本批次 create 返回的实际 file_id。
            let tc_to_execute = self.fixup_document_tool_resource_id(tc, &created_file_ids);
            let tc_ref = tc_to_execute.as_ref().unwrap_or(tc);

            match self
                .execute_single_tool(
                    tc_ref,
                    emitter,
                    session_id,
                    message_id,
                    canvas_note_id,
                    skill_allowed_tools,
                    skill_contents,
                    active_skill_ids,
                    cancellation_token.cloned(),
                    rag_top_k,
                    rag_enable_reranking,
                )
                .await
            {
                Ok(info) => {
                    // 🔧 捕获 _create 工具返回的 file_id，供后续依赖工具使用
                    if info.success {
                        self.capture_created_file_id(&tc_ref.name, &info.output, &mut created_file_ids);
                    }
                    tool_results.push(info);
                }
                Err(e) => {
                    log::error!(
                        "[ChatV2::pipeline] Unexpected tool call error for {}: {}",
                        tc.name,
                        e
                    );
                    tool_results.push(ToolResultInfo {
                        tool_call_id: Some(tc.id.clone()),
                        block_id: None,
                        tool_name: tc.name.clone(),
                        input: tc.arguments.clone(),
                        output: json!(null),
                        success: false,
                        error: Some(e.to_string()),
                        duration_ms: None,
                        reasoning_content: None,
                    });
                }
            }
        }

        Ok(tool_results)
    }

    /// 🔧 2026-02-16: 修正依赖工具的 resource_id
    ///
    /// 当 LLM 在同一批次同时生成 `_create` 和 `_read/_edit` 等依赖工具时，
    /// 依赖工具的 `resource_id` 是 LLM 凭空捏造的（因为 create 尚未返回真实 ID）。
    /// 此方法检测这种情况并替换为本批次 _create 工具返回的实际 file_id。
    ///
    /// 替换条件（全部满足才替换）：
    /// 1. 工具是文档类型的非 _create 工具（如 xlsx_read_structured）
    /// 2. 参数中有 resource_id
    /// 3. 本批次有对应文档类型的 _create 结果
    /// 4. 当前 resource_id 与 _create 返回的不同
    /// 5. 当前 resource_id 在 VFS 中不存在（确认是捏造的）
    fn fixup_document_tool_resource_id(
        &self,
        tc: &ToolCall,
        created_file_ids: &std::collections::HashMap<String, String>,
    ) -> Option<ToolCall> {
        if created_file_ids.is_empty() {
            return None;
        }

        // 剥离前缀
        let short_name = tc
            .name
            .strip_prefix(super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
            .or_else(|| tc.name.strip_prefix("mcp_"))
            .unwrap_or(&tc.name);

        // 检测文档工具族
        let doc_type = if short_name.starts_with("pptx_") {
            "pptx"
        } else if short_name.starts_with("xlsx_") {
            "xlsx"
        } else if short_name.starts_with("docx_") {
            "docx"
        } else {
            return None;
        };

        // _create 工具本身不需要 fixup
        let action = &short_name[doc_type.len() + 1..]; // skip "xlsx_"
        if action == "create" {
            return None;
        }

        // 获取参数中的 resource_id
        let resource_id = tc.arguments.get("resource_id").and_then(|v| v.as_str())?;

        // 获取本批次 _create 返回的实际 file_id
        let actual_id = created_file_ids.get(doc_type)?;

        // 如果已经一致，无需替换
        if resource_id == actual_id.as_str() {
            return None;
        }

        // 检查原始 resource_id 是否在 VFS 中存在
        // 如果存在，说明 LLM 引用的是之前的文件，不应替换
        if let Some(ref vfs_db) = self.vfs_db {
            use crate::vfs::repos::VfsFileRepo;
            if let Ok(conn) = vfs_db.get_conn_safe() {
                if VfsFileRepo::get_file_with_conn(&conn, resource_id)
                    .ok()
                    .flatten()
                    .is_some()
                {
                    return None; // 原始 ID 有效，不替换
                }
            }
        }

        // 替换 resource_id
        let mut fixed_tc = tc.clone();
        if let Some(obj) = fixed_tc.arguments.as_object_mut() {
            obj.insert(
                "resource_id".to_string(),
                serde_json::Value::String(actual_id.clone()),
            );
        }

        log::info!(
            "[ChatV2::pipeline] 🔧 资源ID修正: {} 的 resource_id '{}' → '{}' (同批次 {}_create 返回)",
            tc.name, resource_id, actual_id, doc_type
        );

        Some(fixed_tc)
    }

    /// 🔧 2026-02-16: 捕获 _create 工具返回的 file_id
    fn capture_created_file_id(
        &self,
        tool_name: &str,
        output: &serde_json::Value,
        created_file_ids: &mut std::collections::HashMap<String, String>,
    ) {
        let short_name = tool_name
            .strip_prefix(super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name);

        let doc_type = if short_name.starts_with("pptx_") {
            "pptx"
        } else if short_name.starts_with("xlsx_") {
            "xlsx"
        } else if short_name.starts_with("docx_") {
            "docx"
        } else {
            return;
        };

        let action = &short_name[doc_type.len() + 1..];
        if action != "create" {
            return;
        }

        // 从输出中提取 file_id（可能嵌套在 result 内）
        let file_id = output
            .get("file_id")
            .and_then(|v| v.as_str())
            .or_else(|| {
                output
                    .get("result")
                    .and_then(|r| r.get("file_id"))
                    .and_then(|v| v.as_str())
            });

        if let Some(id) = file_id {
            log::info!(
                "[ChatV2::pipeline] 📦 捕获 {}_create 返回的 file_id: {}",
                doc_type,
                id
            );
            created_file_ids.insert(doc_type.to_string(), id.to_string());
        }
    }

    /// 执行单个工具调用
    ///
    /// 🆕 文档 29 P0-1: 委托给 ToolExecutorRegistry 执行
    ///
    /// ## 参数
    /// - `tool_call`: 工具调用
    /// - `emitter`: 事件发射器
    /// - `session_id`: 会话 ID（用于工具状态隔离，如 TodoList）
    /// - `message_id`: 消息 ID
    /// - `canvas_note_id`: Canvas 笔记 ID，用于 Canvas 工具默认值
    /// - `skill_allowed_tools`: 🆕 P1-C Skill 工具白名单
    /// - `cancellation_token`: 🆕 取消令牌，用于工具执行取消
    ///
    /// ## 返回
    /// 工具调用结果
    async fn execute_single_tool(
        &self,
        tool_call: &ToolCall,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        canvas_note_id: &Option<String>,
        skill_allowed_tools: &Option<Vec<String>>,
        skill_contents: &Option<std::collections::HashMap<String, String>>,
        active_skill_ids: &Option<Vec<String>>,
        cancellation_token: Option<CancellationToken>,
        rag_top_k: Option<u32>,
        rag_enable_reranking: Option<bool>,
    ) -> ChatV2Result<ToolResultInfo> {
        let block_id = MessageBlock::generate_id();

        log::debug!(
            "[ChatV2::pipeline] Executing tool via ExecutorRegistry: name={}, id={}",
            tool_call.name,
            tool_call.id
        );

        // 🆕 P1-C: Skill allowedTools 白名单校验
        // 安全默认：当会话中有激活技能但缺失 allowedTools 时，拒绝执行（fail-closed）
        let has_active_skills = active_skill_ids
            .as_ref()
            .map(|skills| !skills.is_empty())
            .unwrap_or(false);
        let is_load_skills_tool =
            super::tools::SkillsExecutor::is_load_skills_tool(&tool_call.name);

        if !is_load_skills_tool {
            match skill_allowed_tools {
                Some(allowed_tools) if allowed_tools.is_empty() => {
                    log::warn!(
                        "[ChatV2::pipeline] 🛡️ allowedTools is empty, blocking tool by default: {}",
                        tool_call.name
                    );
                    return Ok(ToolResultInfo {
                        tool_call_id: Some(tool_call.id.clone()),
                        block_id: Some(block_id),
                        tool_name: tool_call.name.clone(),
                        input: tool_call.arguments.clone(),
                        output: json!(null),
                        success: false,
                        error: Some("当前技能未声明可用工具，已安全拦截".to_string()),
                        duration_ms: None,
                        reasoning_content: None,
                    });
                }
                Some(allowed_tools) => {
                    let is_allowed = allowed_tools
                        .iter()
                        .any(|allowed| Self::skill_allows_tool(&tool_call.name, allowed));

                    if !is_allowed {
                        log::warn!(
                            "[ChatV2::pipeline] 🛡️ Tool {} blocked by Skill allowedTools constraint: {:?}",
                            tool_call.name,
                            allowed_tools
                        );
                        return Ok(ToolResultInfo {
                            tool_call_id: Some(tool_call.id.clone()),
                            block_id: Some(block_id),
                            tool_name: tool_call.name.clone(),
                            input: tool_call.arguments.clone(),
                            output: json!(null),
                            success: false,
                            error: Some(format!(
                                "当前技能不允许使用此工具，允许的工具: {:?}",
                                allowed_tools
                            )),
                            duration_ms: None,
                            reasoning_content: None,
                        });
                    }
                }
                None if has_active_skills => {
                    log::warn!(
                        "[ChatV2::pipeline] 🛡️ active skills detected but allowedTools missing, blocking tool: {}",
                        tool_call.name
                    );
                    return Ok(ToolResultInfo {
                        tool_call_id: Some(tool_call.id.clone()),
                        block_id: Some(block_id),
                        tool_name: tool_call.name.clone(),
                        input: tool_call.arguments.clone(),
                        output: json!(null),
                        success: false,
                        error: Some("技能工具白名单缺失，已安全拦截".to_string()),
                        duration_ms: None,
                        reasoning_content: None,
                    });
                }
                None => {
                    log::info!(
                        "[ChatV2::pipeline] No skill allowedTools constraint for tool: {}",
                        tool_call.name
                    );
                }
            }
        } else {
            log::info!(
                "[ChatV2::pipeline] load_skills bypasses allowedTools gating: {}",
                tool_call.name
            );
        }

        // 🆕 文档 29 P1-3：检查工具敏感等级，决定是否需要用户审批
        let sensitivity = self.executor_registry.get_sensitivity(&tool_call.name);

        // 🆕 全局免审批开关和单工具覆盖：
        // 1. 全局开关 tool_approval.global_bypass = "true" → 所有工具跳过审批
        // 2. 单工具覆盖 tool_approval.override.{tool_name} = "low" → 此工具跳过审批
        let effective_sensitivity = if let Some(ref db) = self.main_db {
            // 检查全局旁路开关
            let global_bypass = db
                .get_setting("tool_approval.global_bypass")
                .ok()
                .flatten()
                .map(|v| v == "true")
                .unwrap_or(false);

            if global_bypass {
                Some(ToolSensitivity::Low)
            } else {
                // 检查单工具覆盖
                let override_key = format!("tool_approval.override.{}", tool_call.name);
                if let Some(override_val) = db.get_setting(&override_key).ok().flatten() {
                    match override_val.as_str() {
                        "low" => Some(ToolSensitivity::Low),
                        "medium" => Some(ToolSensitivity::Medium),
                        "high" => Some(ToolSensitivity::High),
                        _ => sensitivity,
                    }
                } else {
                    sensitivity
                }
            }
        } else {
            sensitivity
        };

        if effective_sensitivity != Some(ToolSensitivity::Low) {
            if let Some(approval_manager) = &self.approval_manager {
                // 🔧 P1-51: 优先检查数据库中的持久化审批设置
                let persisted_approval: Option<bool> = self.main_db.as_ref().and_then(|db| {
                    let setting_key =
                        approval_scope_setting_key(&tool_call.name, &tool_call.arguments);
                    db.get_setting(&setting_key)
                        .ok()
                        .flatten()
                        .map(|v| v == "allow")
                });

                // 使用持久化设置或内存缓存
                let remembered = persisted_approval.or_else(|| {
                    approval_manager.check_remembered(&tool_call.name, &tool_call.arguments)
                });

                if let Some(is_allowed) = remembered {
                    log::info!(
                        "[ChatV2::pipeline] Tool {} approval remembered: {} (persisted={})",
                        tool_call.name,
                        is_allowed,
                        persisted_approval.is_some()
                    );
                    if !is_allowed {
                        // 用户之前选择了"始终拒绝"
                        return Ok(ToolResultInfo {
                            tool_call_id: Some(tool_call.id.clone()),
                            block_id: Some(block_id),
                            tool_name: tool_call.name.clone(),
                            input: tool_call.arguments.clone(),
                            output: json!(null),
                            success: false,
                            error: Some("用户已拒绝此工具执行".to_string()),
                            duration_ms: None,
                            reasoning_content: None,
                        });
                    }
                    // 用户之前选择了"始终允许"，继续执行
                } else {
                    // 需要请求用户审批
                    let actual_sensitivity = sensitivity.unwrap_or(ToolSensitivity::Medium);
                    let approval_outcome = self
                        .request_tool_approval(
                            tool_call,
                            emitter,
                            session_id,
                            message_id,
                            &block_id,
                            &actual_sensitivity,
                            approval_manager,
                        )
                        .await;

                    match approval_outcome {
                        ApprovalOutcome::Approved => {
                            // 用户同意，继续执行
                        }
                        ApprovalOutcome::Rejected => {
                            return Ok(ToolResultInfo {
                                tool_call_id: Some(tool_call.id.clone()),
                                block_id: Some(block_id),
                                tool_name: tool_call.name.clone(),
                                input: tool_call.arguments.clone(),
                                output: json!(null),
                                success: false,
                                error: Some("用户拒绝执行此工具".to_string()),
                                duration_ms: None,
                                reasoning_content: None,
                            });
                        }
                        ApprovalOutcome::Timeout => {
                            return Ok(ToolResultInfo {
                                tool_call_id: Some(tool_call.id.clone()),
                                block_id: Some(block_id),
                                tool_name: tool_call.name.clone(),
                                input: tool_call.arguments.clone(),
                                output: json!(null),
                                success: false,
                                error: Some("工具审批等待超时，请重试".to_string()),
                                duration_ms: None,
                                reasoning_content: None,
                            });
                        }
                        ApprovalOutcome::ChannelClosed => {
                            return Ok(ToolResultInfo {
                                tool_call_id: Some(tool_call.id.clone()),
                                block_id: Some(block_id),
                                tool_name: tool_call.name.clone(),
                                input: tool_call.arguments.clone(),
                                output: json!(null),
                                success: false,
                                error: Some("工具审批通道异常关闭，请重试".to_string()),
                                duration_ms: None,
                                reasoning_content: None,
                            });
                        }
                    }
                }
            }
        }

        // 🆕 构建执行上下文（文档 29 P0-1）
        let window = emitter.window();
        let mut ctx = ExecutionContext::new(
            session_id.to_string(),
            message_id.to_string(),
            block_id.clone(),
            emitter.clone(),
            self.tool_registry.clone(),
            window,
        )
        .with_canvas(canvas_note_id.clone(), self.notes_manager.clone())
        .with_main_db(self.main_db.clone())
        .with_anki_db(self.anki_db.clone())
        .with_vfs_db(self.vfs_db.clone()) // 🆕 学习资源工具需要访问 VFS 数据库
        .with_llm_manager(Some(self.llm_manager.clone())) // 🆕 VFS RAG 工具需要 LLM 管理器
        .with_chat_v2_db(Some(self.db.clone())) // 🆕 工具块防闪退保存
        .with_question_bank_service(self.question_bank_service.clone()) // 🆕 智能题目集工具
        .with_pdf_processing_service(self.pdf_processing_service.clone()) // 🆕 论文保存触发 Pipeline
        .with_rag_config(rag_top_k, rag_enable_reranking);

        // 🆕 渐进披露：传递 skill_contents
        ctx.skill_contents = skill_contents.clone();

        // 🆕 取消支持：传递取消令牌
        if let Some(token) = cancellation_token {
            ctx = ctx.with_cancellation_token(token);
        }

        // 🆕 委托给 ExecutorRegistry 执行
        match self.executor_registry.execute(tool_call, &ctx).await {
            Ok(result) => Ok(result),
            Err(error_msg) => {
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                // 执行器内部错误，构造失败结果
                log::error!(
                    "[ChatV2::pipeline] Executor error for tool {}: {}",
                    tool_call.name,
                    error_msg
                );
                Ok(ToolResultInfo {
                    tool_call_id: Some(tool_call.id.clone()),
                    block_id: Some(block_id),
                    tool_name: tool_call.name.clone(),
                    input: tool_call.arguments.clone(),
                    output: json!(null),
                    success: false,
                    error: Some(error_msg),
                    duration_ms: None,
                    reasoning_content: None,
                })
            }
        }
    }

    /// 请求用户审批敏感工具
    ///
    /// 🆕 文档 29 P1-3：发射审批事件并等待用户响应
    ///
    /// 返回 `ApprovalOutcome` 以区分用户同意、拒绝、超时、通道异常等情况。
    async fn request_tool_approval(
        &self,
        tool_call: &ToolCall,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        block_id: &str,
        sensitivity: &ToolSensitivity,
        approval_manager: &Arc<ApprovalManager>,
    ) -> ApprovalOutcome {
        let timeout_seconds = approval_manager.default_timeout();
        let approval_block_id = format!("approval_{}", tool_call.id);

        // 构建审批请求
        let request = ApprovalRequest {
            session_id: session_id.to_string(),
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            arguments: tool_call.arguments.clone(),
            sensitivity: match sensitivity {
                ToolSensitivity::Low => "low".to_string(),
                ToolSensitivity::Medium => "medium".to_string(),
                ToolSensitivity::High => "high".to_string(),
            },
            description: ApprovalManager::generate_description(
                &tool_call.name,
                &tool_call.arguments,
            ),
            timeout_seconds,
        };

        // 注册等待
        let rx = approval_manager.register_with_scope(
            session_id,
            &tool_call.id,
            &tool_call.name,
            &tool_call.arguments,
        );

        // 发射审批请求事件到前端
        log::info!(
            "[ChatV2::pipeline] Emitting tool approval request: tool={}, sensitivity={:?}",
            tool_call.name,
            sensitivity
        );
        let payload = serde_json::to_value(&request).ok();
        log::debug!(
            "[ChatV2::pipeline] tool approval block mapping: tool_block_id={}, approval_block_id={}",
            block_id,
            approval_block_id
        );
        emitter.emit_start(
            event_types::TOOL_APPROVAL_REQUEST,
            message_id,
            Some(&approval_block_id),
            payload,
            None, // variant_id
        );

        // 等待响应或超时
        let timeout_duration = std::time::Duration::from_secs(timeout_seconds as u64);
        match tokio::time::timeout(timeout_duration, rx).await {
            Ok(Ok(response)) => {
                log::info!(
                    "[ChatV2::pipeline] Received approval response: approved={}",
                    response.approved
                );
                let result_payload = serde_json::json!({
                    "toolCallId": tool_call.id,
                    "approved": response.approved,
                    "reason": response.reason,
                });
                emitter.emit_end(
                    event_types::TOOL_APPROVAL_REQUEST,
                    &approval_block_id,
                    Some(result_payload),
                    None,
                );
                if response.approved {
                    ApprovalOutcome::Approved
                } else {
                    ApprovalOutcome::Rejected
                }
            }
            Ok(Err(_)) => {
                // channel 被关闭（不应该发生）
                log::warn!("[ChatV2::pipeline] Approval channel closed unexpectedly");
                emitter.emit_error(
                    event_types::TOOL_APPROVAL_REQUEST,
                    &approval_block_id,
                    "approval_channel_closed",
                    None,
                );
                approval_manager.cancel_with_session(session_id, &tool_call.id);
                ApprovalOutcome::ChannelClosed
            }
            Err(_) => {
                // 超时
                log::warn!(
                    "[ChatV2::pipeline] Approval timeout for tool: {}",
                    tool_call.name
                );
                approval_manager.cancel_with_session(session_id, &tool_call.id);
                emitter.emit_error(
                    event_types::TOOL_APPROVAL_REQUEST,
                    &approval_block_id,
                    "approval_timeout",
                    None,
                );
                ApprovalOutcome::Timeout
            }
        }
    }

    // ========================================================================
    // Canvas 工具执行（已废弃 - 保留用于参考）
    // ========================================================================

    /// 执行 Canvas 笔记工具
    ///
    /// **已废弃**：此方法已被 `CanvasToolExecutor` 替代（文档 29 P0-1）
    /// 保留此代码仅用于参考，实际执行已委托给 `executor_registry`。
    ///
    /// Canvas 工具使用 NotesManager 直接操作笔记，不走 ToolRegistry。
    #[allow(dead_code)]
    ///
    /// ## 参数
    /// - `tool_call`: 工具调用信息
    /// - `emitter`: 事件发射器
    /// - `message_id`: 消息 ID
    /// - `block_id`: 块 ID
    /// - `start_time`: 开始时间
    /// - `canvas_note_id`: Canvas 笔记 ID，用于默认值
    async fn execute_canvas_tool(
        &self,
        tool_call: &ToolCall,
        emitter: &Arc<ChatV2EventEmitter>,
        _message_id: &str,
        block_id: &str,
        start_time: Instant,
        canvas_note_id: &Option<String>,
    ) -> ChatV2Result<ToolResultInfo> {
        use super::tools::canvas_tool_names;

        let notes_manager = match &self.notes_manager {
            Some(nm) => nm.clone(),
            None => {
                let error_msg = "Canvas 工具不可用：NotesManager 未初始化";
                emitter.emit_error(event_types::TOOL_CALL, block_id, error_msg, None);
                log::error!("[ChatV2::pipeline] {}", error_msg);
                return Ok(ToolResultInfo {
                    tool_call_id: Some(tool_call.id.clone()),
                    block_id: Some(block_id.to_string()),
                    tool_name: tool_call.name.clone(),
                    input: tool_call.arguments.clone(),
                    output: json!(null),
                    success: false,
                    error: Some(error_msg.to_string()),
                    duration_ms: Some(start_time.elapsed().as_millis() as u64),
                    reasoning_content: None,
                });
            }
        };

        // 解析参数：优先使用工具参数，否则使用 canvas_note_id 默认值
        let args = &tool_call.arguments;
        let note_id = args
            .get("noteId")
            .or(args.get("note_id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| canvas_note_id.clone())
            .unwrap_or_default();
        if note_id.is_empty() {
            let error_msg = "Canvas 工具缺少必需参数: noteId（请确保已选择笔记或在工具参数中指定）";
            emitter.emit_error(event_types::TOOL_CALL, block_id, error_msg, None);
            return Ok(ToolResultInfo {
                tool_call_id: Some(tool_call.id.clone()),
                block_id: Some(block_id.to_string()),
                tool_name: tool_call.name.clone(),
                input: tool_call.arguments.clone(),
                output: json!(null),
                success: false,
                error: Some(error_msg.to_string()),
                duration_ms: Some(start_time.elapsed().as_millis() as u64),
                reasoning_content: None,
            });
        }

        // 执行 Canvas 工具
        let tool_name = tool_call.name.clone();
        let nm = notes_manager.clone();
        let note_id_owned = note_id;
        let args_clone = args.clone();

        let result: Result<serde_json::Value, String> = tokio::task::spawn_blocking(move || {
            match tool_name.as_str() {
                canvas_tool_names::NOTE_READ => {
                    let section = args_clone.get("section").and_then(|v| v.as_str());
                    match nm.canvas_read_content(&note_id_owned, section) {
                        Ok(content) => Ok(json!({
                            "content": content,
                            "wordCount": content.chars().count(),
                            "isSection": section.is_some(),
                        })),
                        Err(e) => Err(e.to_string()),
                    }
                }
                canvas_tool_names::NOTE_APPEND => {
                    let content = args_clone
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let section = args_clone.get("section").and_then(|v| v.as_str());
                    // 读取操作前内容用于 diff 预览
                    let before_content = nm
                        .canvas_read_content(&note_id_owned, section)
                        .unwrap_or_default();
                    match nm.canvas_append_content(&note_id_owned, content, section) {
                        Ok(()) => {
                            // 读取操作后内容
                            let after_content = nm
                                .canvas_read_content(&note_id_owned, section)
                                .unwrap_or_default();
                            Ok(json!({
                                "success": true,
                                "appendedCount": content.chars().count(),
                                "beforePreview": truncate_preview(&before_content, 500),
                                "afterPreview": truncate_preview(&after_content, 500),
                                "addedContent": truncate_preview(content, 300),
                            }))
                        }
                        Err(e) => Err(e.to_string()),
                    }
                }
                canvas_tool_names::NOTE_REPLACE => {
                    let search = args_clone
                        .get("search")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let replace = args_clone
                        .get("replace")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let is_regex = args_clone
                        .get("isRegex")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    // 读取操作前内容用于 diff 预览
                    let before_content = nm
                        .canvas_read_content(&note_id_owned, None)
                        .unwrap_or_default();
                    match nm.canvas_replace_content(&note_id_owned, search, replace, is_regex) {
                        Ok(count) => {
                            // 读取操作后内容
                            let after_content = nm
                                .canvas_read_content(&note_id_owned, None)
                                .unwrap_or_default();
                            Ok(json!({
                                "success": true,
                                "replaceCount": count,
                                "beforePreview": truncate_preview(&before_content, 500),
                                "afterPreview": truncate_preview(&after_content, 500),
                                "searchPattern": search,
                                "replaceWith": replace,
                            }))
                        }
                        Err(e) => Err(e.to_string()),
                    }
                }
                canvas_tool_names::NOTE_SET => {
                    let content = args_clone
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    // 读取操作前内容用于 diff 预览
                    let before_content = nm
                        .canvas_read_content(&note_id_owned, None)
                        .unwrap_or_default();
                    match nm.canvas_set_content(&note_id_owned, content) {
                        Ok(()) => Ok(json!({
                            "success": true,
                            "wordCount": content.chars().count(),
                            "beforePreview": truncate_preview(&before_content, 500),
                            "afterPreview": truncate_preview(content, 500),
                        })),
                        Err(e) => Err(e.to_string()),
                    }
                }
                _ => Err(format!("未知的 Canvas 工具: {}", tool_name)),
            }
        })
        .await
        .map_err(|e| ChatV2Error::Tool(format!("Canvas 工具执行失败: {}", e)))?;

        let duration_ms = start_time.elapsed().as_millis() as u64;

        // 判断是否是写入操作（需要通知前端刷新）
        let is_write_operation = matches!(
            tool_call.name.as_str(),
            canvas_tool_names::NOTE_APPEND
                | canvas_tool_names::NOTE_REPLACE
                | canvas_tool_names::NOTE_SET
        );

        match result {
            Ok(output) => {
                emitter.emit_end(
                    event_types::TOOL_CALL,
                    block_id,
                    Some(json!({
                        "result": output,
                        "durationMs": duration_ms,
                    })),
                    None,
                );

                // 🔧 修复：写入操作成功后发送事件通知前端刷新笔记
                if is_write_operation {
                    let window = emitter.window();
                    let note_id_for_event = args
                        .get("noteId")
                        .or(args.get("note_id"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| canvas_note_id.clone());

                    if let Some(nid) = note_id_for_event {
                        let _ = window.emit(
                            "canvas:note-updated",
                            json!({
                                "noteId": nid,
                                "toolName": tool_call.name,
                            }),
                        );
                        log::info!(
                            "[ChatV2::pipeline] Emitted canvas:note-updated for noteId={}",
                            nid
                        );
                    }
                }

                log::info!(
                    "[ChatV2::pipeline] Canvas tool {} completed successfully in {}ms",
                    tool_call.name,
                    duration_ms
                );

                Ok(ToolResultInfo {
                    tool_call_id: Some(tool_call.id.clone()),
                    block_id: Some(block_id.to_string()),
                    tool_name: tool_call.name.clone(),
                    input: tool_call.arguments.clone(),
                    output,
                    success: true,
                    error: None,
                    duration_ms: Some(duration_ms),
                    reasoning_content: None,
                })
            }
            Err(error_msg) => {
                emitter.emit_error(event_types::TOOL_CALL, block_id, &error_msg, None);

                log::warn!(
                    "[ChatV2::pipeline] Canvas tool {} failed: {} ({}ms)",
                    tool_call.name,
                    error_msg,
                    duration_ms
                );

                Ok(ToolResultInfo {
                    tool_call_id: Some(tool_call.id.clone()),
                    block_id: Some(block_id.to_string()),
                    tool_name: tool_call.name.clone(),
                    input: tool_call.arguments.clone(),
                    output: json!(null),
                    success: false,
                    error: Some(error_msg),
                    duration_ms: Some(duration_ms),
                    reasoning_content: None,
                })
            }
        }
    }

    // ========================================================================
    // Token 估算逻辑（Prompt 4）
    // ========================================================================

    /// 获取或估算本轮 LLM 调用的 Token 使用量
    ///
    /// 优先使用 API 返回的 usage，如果不可用则估算。
    ///
    /// ## 参数
    /// - `adapter`: LLM 适配器，包含 API 返回的 usage
    /// - `messages`: 输入消息列表
    /// - `completion_text`: 输出文本
    /// - `system_prompt`: 系统提示
    /// - `model_id`: 模型 ID（用于选择 tiktoken 编码器）
    ///
    /// ## 返回
    /// TokenUsage 结构体
    fn get_or_estimate_usage(
        &self,
        adapter: &ChatV2LLMAdapter,
        messages: &[LegacyChatMessage],
        completion_text: &str,
        system_prompt: &str,
        model_id: Option<&str>,
    ) -> TokenUsage {
        // 1. 优先使用 API 返回的 usage
        if let Some(api_usage) = adapter.get_api_usage() {
            log::debug!(
                "[ChatV2::pipeline] Using API usage: prompt={}, completion={}",
                api_usage.prompt_tokens,
                api_usage.completion_tokens
            );
            return api_usage;
        }

        // 2. API 不可用时，使用估算
        log::debug!("[ChatV2::pipeline] API usage not available, using estimation");

        let prompt_tokens = self.estimate_prompt_tokens(messages, system_prompt, model_id);
        let completion_tokens = self.estimate_completion_tokens(completion_text, model_id);

        // 判断是否使用了精确估算（tiktoken）
        #[cfg(feature = "tokenizer_tiktoken")]
        let precise = true;
        #[cfg(not(feature = "tokenizer_tiktoken"))]
        let precise = false;

        TokenUsage::from_estimate(prompt_tokens, completion_tokens, precise)
    }

    /// 估算输入 Token 数量
    ///
    /// 将 system_prompt + 所有消息的内容拼接后估算 token 数量。
    ///
    /// ## 参数
    /// - `messages`: 消息列表
    /// - `system_prompt`: 系统提示
    /// - `model_id`: 模型 ID（用于选择 tiktoken 编码器）
    ///
    /// ## 返回
    /// 估算的 prompt token 数量
    fn estimate_prompt_tokens(
        &self,
        messages: &[LegacyChatMessage],
        system_prompt: &str,
        model_id: Option<&str>,
    ) -> u32 {
        use crate::utils::token_budget::estimate_tokens_with_model;

        // 构建完整的 prompt 文本
        let mut full_prompt = String::new();

        // 添加系统提示
        if !system_prompt.is_empty() {
            full_prompt.push_str(system_prompt);
            full_prompt.push('\n');
        }

        // 添加所有消息内容
        for msg in messages {
            // 消息角色标记（粗略估计 4 tokens）
            full_prompt.push_str(&msg.role);
            full_prompt.push_str(": ");
            full_prompt.push_str(&msg.content);
            full_prompt.push('\n');

            // 如果有 thinking 内容也计入
            if let Some(ref thinking) = msg.thinking_content {
                full_prompt.push_str(thinking);
                full_prompt.push('\n');
            }

            // 如果有工具调用，计入参数
            if let Some(ref tool_call) = msg.tool_call {
                full_prompt.push_str(&tool_call.args_json.to_string());
                full_prompt.push('\n');
            }

            // 如果有工具结果，计入输出
            if let Some(ref tool_result) = msg.tool_result {
                if let Some(ref data) = tool_result.data_json {
                    full_prompt.push_str(&data.to_string());
                    full_prompt.push('\n');
                }
            }
        }

        // 使用 token_budget 模块的估算函数
        let tokens = estimate_tokens_with_model(&full_prompt, model_id) as u32;

        // 添加消息格式开销（每条消息约 4 tokens）
        let message_overhead = (messages.len() as u32) * 4;

        tokens + message_overhead
    }

    /// 估算输出 Token 数量
    ///
    /// ## 参数
    /// - `completion_text`: 输出文本
    /// - `model_id`: 模型 ID（用于选择 tiktoken 编码器）
    ///
    /// ## 返回
    /// 估算的 completion token 数量
    fn estimate_completion_tokens(&self, completion_text: &str, model_id: Option<&str>) -> u32 {
        use crate::utils::token_budget::estimate_tokens_with_model;

        if completion_text.is_empty() {
            return 0;
        }

        estimate_tokens_with_model(completion_text, model_id) as u32
    }

    // ========================================================================
    // 统一上下文注入系统方法
    // ========================================================================

    /// 创建检索资源
    ///
    /// 将检索结果转换为资源引用，调用 ResourceRepo 创建实际资源。
    /// 统一架构修复（2025-12-06）：使用 resources.db 而非 chat_v2.db
    ///
    /// ## 约束（来自文档 17）
    /// - 检索结果创建资源并填充 retrievalRefs
    /// - 使用内容哈希去重
    ///
    /// ## 参数
    /// - `sources`: 检索到的消息来源
    ///
    /// ## 返回
    /// 检索资源的 ContextRef 列表
    async fn create_retrieval_resources(&self, sources: &MessageSources) -> Vec<ContextRef> {
        use crate::vfs::types::{VfsResourceMetadata, VfsResourceType};

        let mut refs = Vec::new();

        // 🆕 获取 VFS 数据库连接
        let vfs_db = match &self.vfs_db {
            Some(db) => db,
            None => {
                log::warn!(
                    "[ChatV2::pipeline] vfs_db not available, skipping retrieval resource creation"
                );
                return refs;
            }
        };

        let conn = match vfs_db.get_conn_safe() {
            Ok(conn) => conn,
            Err(e) => {
                log::error!("[ChatV2::pipeline] Failed to get vfs.db connection: {}", e);
                return refs;
            }
        };

        // 辅助宏：处理单个来源列表
        macro_rules! process_sources {
            ($source_list:expr, $source_type:expr) => {
                if let Some(ref source_list) = $source_list {
                    for (idx, source) in source_list.iter().enumerate() {
                        // 构建内容用于存储（JSON 格式）
                        let content = serde_json::json!({
                            "source_type": $source_type,
                            "title": source.title,
                            "snippet": source.snippet,
                            "url": source.url,
                        }).to_string();

                        // 构建元数据（使用 VFS 的类型）
                        let metadata = VfsResourceMetadata {
                            title: source.title.clone(),
                            source: Some($source_type.to_string()),
                            ..Default::default()
                        };

                        // 🆕 调用 VfsResourceRepo 创建或复用资源（写入 vfs.db）
                        match VfsResourceRepo::create_or_reuse_with_conn(
                            &conn,
                            VfsResourceType::Retrieval,
                            &content,
                            source.url.as_deref(), // source_id: 使用 URL
                            None, // source_table
                            Some(&metadata),
                        ) {
                            Ok(result) => {
                                refs.push(ContextRef::new(
                                    result.resource_id.clone(),
                                    result.hash.clone(),
                                    format!("retrieval_{}", $source_type),
                                ));

                                log::trace!(
                                    "[ChatV2::pipeline] Created retrieval resource in vfs.db: type={}, idx={}, id={}, is_new={}",
                                    $source_type,
                                    idx,
                                    result.resource_id,
                                    result.is_new
                                );
                            }
                            Err(e) => {
                                log::warn!(
                                    "[ChatV2::pipeline] Failed to create retrieval resource: type={}, idx={}, error={}",
                                    $source_type,
                                    idx,
                                    e
                                );
                            }
                        }
                    }
                }
            };
        }

        // 处理各类检索来源
        process_sources!(sources.rag, "rag");
        process_sources!(sources.memory, "memory");
        process_sources!(sources.graph, "graph");
        process_sources!(sources.web_search, "web");

        log::debug!(
            "[ChatV2::pipeline] Created {} retrieval resources in vfs.db",
            refs.len()
        );

        refs
    }

    /// 增加资源引用计数
    ///
    /// 消息保存后调用，增加所有关联资源的引用计数。
    /// 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db
    ///
    /// ## 约束（来自文档 17）
    /// - 消息保存后调用 incrementRef
    async fn increment_resource_refs(&self, resource_ids: &[&str]) {
        if resource_ids.is_empty() {
            return;
        }

        // 🆕 获取 VFS 数据库连接
        let vfs_db = match &self.vfs_db {
            Some(db) => db,
            None => {
                log::warn!(
                    "[ChatV2::pipeline] vfs_db not available, skipping increment_resource_refs"
                );
                return;
            }
        };

        let conn = match vfs_db.get_conn_safe() {
            Ok(conn) => conn,
            Err(e) => {
                log::error!("[ChatV2::pipeline] Failed to get vfs.db connection for increment_resource_refs: {}", e);
                return;
            }
        };

        // 遍历所有资源 ID，调用 VfsResourceRepo 增加引用计数
        for id in resource_ids {
            if let Err(e) = VfsResourceRepo::increment_ref_with_conn(&conn, id) {
                // 引用计数失败不阻塞流程，仅记录警告
                log::warn!(
                    "[ChatV2::pipeline] Failed to increment ref for resource {}: {}",
                    id,
                    e
                );
            }
        }

        log::debug!(
            "[ChatV2::pipeline] Incremented refs for {} resources in vfs.db: {:?}",
            resource_ids.len(),
            resource_ids.iter().take(3).collect::<Vec<_>>()
        );
    }

    /// 减少资源引用计数
    ///
    /// 消息删除时调用，减少所有关联资源的引用计数。
    /// 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db
    ///
    /// ## 约束（来自文档 17）
    /// - 消息删除时调用 decrementRef
    #[allow(dead_code)]
    async fn decrement_resource_refs(&self, resource_ids: &[&str]) {
        if resource_ids.is_empty() {
            return;
        }

        // 🆕 获取 VFS 数据库连接
        let vfs_db = match &self.vfs_db {
            Some(db) => db,
            None => {
                log::warn!(
                    "[ChatV2::pipeline] vfs_db not available, skipping decrement_resource_refs"
                );
                return;
            }
        };

        let conn = match vfs_db.get_conn_safe() {
            Ok(conn) => conn,
            Err(e) => {
                log::error!("[ChatV2::pipeline] Failed to get vfs.db connection for decrement_resource_refs: {}", e);
                return;
            }
        };

        // 遍历所有资源 ID，调用 VfsResourceRepo 减少引用计数
        for id in resource_ids {
            if let Err(e) = VfsResourceRepo::decrement_ref_with_conn(&conn, id) {
                // 引用计数失败不阻塞流程，仅记录警告
                log::warn!(
                    "[ChatV2::pipeline] Failed to decrement ref for resource {}: {}",
                    id,
                    e
                );
            }
        }

        log::debug!(
            "[ChatV2::pipeline] Decremented refs for {} resources in vfs.db: {:?}",
            resource_ids.len(),
            resource_ids.iter().take(3).collect::<Vec<_>>()
        );
    }

    /// 🆕 P0防闪退：用户消息即时保存
    ///
    /// 在 Pipeline 执行前立即保存用户消息，确保用户输入不会因闪退丢失。
    /// 使用 INSERT OR REPLACE 语义，与 save_results 兼容（不会重复插入）。
    ///
    /// ## 调用时机
    /// 在 execute() 中，emit_stream_start 之后、execute_internal 之前调用。
    ///
    /// ## 与 save_results 的关系
    /// - 本方法先保存用户消息
    /// - save_results 使用 INSERT OR REPLACE，会覆盖本方法保存的数据
    /// - 如果 Pipeline 正常完成，save_results 会保存完整数据
    /// - 如果闪退，至少用户消息已保存
    async fn save_user_message_immediately(&self, ctx: &PipelineContext) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 使用统一的用户消息构建器
        let user_msg_params =
            UserMessageParams::new(ctx.session_id.clone(), ctx.user_content.clone())
                .with_id(ctx.user_message_id.clone())
                .with_attachments(ctx.attachments.clone())
                .with_context_snapshot(ctx.context_snapshot.clone())
                .with_timestamp(now_ms);

        let user_msg_result = build_user_message(user_msg_params);

        // 使用 INSERT OR REPLACE 保存（与 save_results 兼容）
        ChatV2Repo::create_message_with_conn(&conn, &user_msg_result.message)?;
        ChatV2Repo::create_block_with_conn(&conn, &user_msg_result.block)?;

        Ok(())
    }

    /// 🆕 P15 修复：中间保存点
    ///
    /// 在工具执行后保存当前已生成的所有块，确保：
    /// 1. 用户刷新页面时不会丢失已执行的工具结果
    /// 2. 阻塞操作（如 coordinator_sleep）期间数据已持久化
    ///
    /// ## 与 save_results 的关系
    /// - 本方法在流程中间调用，保存部分结果
    /// - save_results 在流程结束时调用，保存完整结果
    /// - 两者都使用 INSERT OR REPLACE，不会冲突
    async fn save_intermediate_results(&self, ctx: &PipelineContext) -> ChatV2Result<()> {
        // 如果没有块需要保存，直接返回
        if ctx.interleaved_blocks.is_empty() {
            return Ok(());
        }

        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 🔧 P23 修复：中间保存也要保存用户消息
        // 否则刷新后子代理会话只有助手消息，没有用户消息（任务内容）
        // 检查是否跳过用户消息保存（编辑重发场景）
        let skip_user_message = ctx.options.skip_user_message_save.unwrap_or(false);
        if !skip_user_message {
            let user_msg_params =
                UserMessageParams::new(ctx.session_id.clone(), ctx.user_content.clone())
                    .with_id(ctx.user_message_id.clone())
                    .with_attachments(ctx.attachments.clone())
                    .with_context_snapshot(ctx.context_snapshot.clone())
                    .with_timestamp(now_ms);

            let user_msg_result = build_user_message(user_msg_params);

            // 使用 INSERT OR REPLACE 保存用户消息（与 save_results 兼容）
            ChatV2Repo::create_message_with_conn(&conn, &user_msg_result.message)?;
            ChatV2Repo::create_block_with_conn(&conn, &user_msg_result.block)?;
        }

        // 1. 保存助手消息（如果不存在则创建）
        // 🔧 Preserve `anki_cards` blocks created outside of `ctx.interleaved_blocks`.
        //
        // `ChatV2Repo::create_message_with_conn` uses SQLite `INSERT OR REPLACE`, which is a
        // DELETE+INSERT under the hood. With `chat_v2_blocks.message_id ON DELETE CASCADE`,
        // replacing the assistant message row will delete *all* existing blocks (including
        // ChatAnki-generated `anki_cards` blocks). We query + re-insert them best-effort.
        let preserved_anki_cards_blocks: Vec<MessageBlock> =
            ChatV2Repo::get_message_blocks_with_conn(&conn, &ctx.assistant_message_id)?
                .into_iter()
                .filter(|b| b.block_type == block_types::ANKI_CARDS)
                .collect();

        let interleaved_block_ids: Vec<String> = ctx
            .interleaved_blocks
            .iter()
            .map(|b| b.id.clone())
            .collect();

        // 🔧 修复：按原始 block_index 合并 anki_cards 块，保持其原始位置
        // 而不是追加到末尾导致刷新后位置变化
        let block_ids: Vec<String> = {
            let interleaved_id_set: std::collections::HashSet<&str> =
                interleaved_block_ids.iter().map(|s| s.as_str()).collect();

            // 收集需要插入的 anki_cards 块及其原始位置
            let mut anki_inserts: Vec<(u32, String)> = preserved_anki_cards_blocks
                .iter()
                .filter(|b| !interleaved_id_set.contains(b.id.as_str()))
                .map(|b| (b.block_index, b.id.clone()))
                .collect();
            anki_inserts.sort_by_key(|(idx, _)| *idx);

            // 合并：将 interleaved 块按顺序编号 (0,1,2,...)，
            // 将 anki_cards 块按其原始 block_index 插入对应位置
            let mut indexed: Vec<(u32, String)> = interleaved_block_ids
                .iter()
                .enumerate()
                .map(|(i, id)| (i as u32, id.clone()))
                .collect();

            for (orig_idx, id) in &anki_inserts {
                indexed.push((*orig_idx, id.clone()));
            }

            // 稳定排序：相同 block_index 时保持原有顺序
            indexed.sort_by_key(|(idx, _)| *idx);

            // 去重
            let mut seen = std::collections::HashSet::<String>::new();
            indexed
                .into_iter()
                .filter_map(|(_, id)| {
                    if seen.insert(id.clone()) {
                        Some(id)
                    } else {
                        None
                    }
                })
                .collect()
        };
        let assistant_msg = ChatMessage {
            id: ctx.assistant_message_id.clone(),
            session_id: ctx.session_id.clone(),
            role: MessageRole::Assistant,
            block_ids: block_ids.clone(),
            timestamp: now_ms,
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: None,
            attachments: None,
            active_variant_id: None,
            variants: None,
            shared_context: None,
        };
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg)?;

        // 2. 保存所有已生成的块
        for (index, block) in ctx.interleaved_blocks.iter().enumerate() {
            let mut block_to_save = block.clone();
            block_to_save.block_index = index as u32;
            ChatV2Repo::create_block_with_conn(&conn, &block_to_save)?;
        }

        // 3. Re-insert preserved `anki_cards` blocks deleted by the assistant message REPLACE.
        //    🔧 修复：保持 anki_cards 块的原始 block_index，不再追加到末尾
        if !preserved_anki_cards_blocks.is_empty() {
            let interleaved_block_id_set: std::collections::HashSet<&str> = ctx
                .interleaved_blocks
                .iter()
                .map(|b| b.id.as_str())
                .collect();

            for preserved in preserved_anki_cards_blocks {
                // If the pipeline already has the same block id, prefer the pipeline version.
                if interleaved_block_id_set.contains(preserved.id.as_str()) {
                    continue;
                }

                // 保持原始 block_index 不变，这样刷新后位置不会跳到末尾
                let block_to_save = preserved;

                if let Err(e) = ChatV2Repo::create_block_with_conn(&conn, &block_to_save) {
                    log::error!(
                        "[ChatV2::pipeline] Failed to re-insert preserved anki_cards block: message_id={}, block_id={}, err={:?}",
                        ctx.assistant_message_id,
                        block_to_save.id,
                        e
                    );
                }
            }
        }

        log::debug!(
            "[ChatV2::pipeline] Intermediate save: message_id={}, blocks={}, user_saved={}",
            ctx.assistant_message_id,
            ctx.interleaved_blocks.len(),
            !skip_user_message
        );

        Ok(())
    }

    /// 保存结果到数据库
    ///
    /// 保存用户消息、助手消息及其所有块到数据库。
    /// 块的 block_index 按生成顺序设置。
    ///
    /// ## skip_user_message_save 选项
    /// 当 `ctx.options.skip_user_message_save` 为 true 时，跳过用户消息的创建。
    /// 用于编辑重发场景：用户消息已在 Handler 中更新，无需 Pipeline 重复创建。
    async fn save_results(&self, ctx: &PipelineContext) -> ChatV2Result<()> {
        log::debug!(
            "[ChatV2::pipeline] Saving results for session={}",
            ctx.session_id
        );

        // 获取数据库连接
        let conn = self.db.get_conn_safe()?;

        // 🆕 P1修复：使用显式事务包裹所有数据库操作，确保原子性
        // 使用 BEGIN IMMEDIATE 避免写锁等待（与 VFS repos 保持一致）
        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| {
            log::error!(
                "[ChatV2::pipeline] Failed to begin transaction for save_results: {}",
                e
            );
            ChatV2Error::Database(format!("Failed to begin transaction: {}", e))
        })?;

        let save_result = self.save_results_inner(&conn, ctx);

        match save_result {
            Ok(()) => {
                conn.execute("COMMIT", []).map_err(|e| {
                    log::error!("[ChatV2::pipeline] Failed to commit transaction: {}", e);
                    ChatV2Error::Database(format!("Failed to commit transaction: {}", e))
                })?;
                log::debug!(
                    "[ChatV2::pipeline] Transaction committed for session={}",
                    ctx.session_id
                );

                // 事务提交成功后执行后处理操作
                self.save_results_post_commit(ctx).await;

                Ok(())
            }
            Err(e) => {
                // 回滚事务
                if let Err(rollback_err) = conn.execute("ROLLBACK", []) {
                    log::error!(
                        "[ChatV2::pipeline] Failed to rollback transaction: {} (original error: {:?})",
                        rollback_err,
                        e
                    );
                } else {
                    log::warn!(
                        "[ChatV2::pipeline] Transaction rolled back for session={}: {:?}",
                        ctx.session_id,
                        e
                    );
                }
                Err(e)
            }
        }
    }

    /// 保存结果的内部实现（在事务内执行）
    ///
    /// 此方法包含所有实际的数据库操作，由 `save_results` 在事务内调用。
    /// 注意：此方法是同步的，因为 SQLite 操作本身是同步的，
    /// 且 PooledConnection 不是 Sync，无法跨 await 点传递引用。
    fn save_results_inner(
        &self,
        conn: &crate::chat_v2::database::ChatV2PooledConnection,
        ctx: &PipelineContext,
    ) -> ChatV2Result<()> {
        // 检查是否跳过用户消息保存（编辑重发场景）
        let skip_user_message = ctx.options.skip_user_message_save.unwrap_or(false);

        // === 1. 创建并保存用户消息（除非 skip_user_message_save 为 true）===
        // 🆕 使用统一的用户消息构建器，确保所有路径的一致性
        if !skip_user_message {
            let user_now_ms = chrono::Utc::now().timestamp_millis();
            let user_msg_params =
                UserMessageParams::new(ctx.session_id.clone(), ctx.user_content.clone())
                    .with_id(ctx.user_message_id.clone())
                    .with_attachments(ctx.attachments.clone())
                    .with_context_snapshot(ctx.context_snapshot.clone())
                    .with_timestamp(user_now_ms);

            let user_msg_result = build_user_message(user_msg_params);

            // 保存用户消息和块
            ChatV2Repo::create_message_with_conn(&conn, &user_msg_result.message)?;
            ChatV2Repo::create_block_with_conn(&conn, &user_msg_result.block)?;

            log::debug!(
                "[ChatV2::pipeline] Saved user message: id={}, content_len={}",
                ctx.user_message_id,
                ctx.user_content.len()
            );
        } else {
            log::debug!(
                "[ChatV2::pipeline] Skipped user message save (skip_user_message_save=true): id={}",
                ctx.user_message_id
            );
        }

        // === 2. 创建并保存助手消息 ===
        //
        // 块保存逻辑优先级：
        // 1. interleaved_blocks（Interleaved Thinking 模式，支持 thinking→tool→thinking→content 交替）
        // 2. generated_blocks（旧逻辑，兼容性保留，目前未使用）
        // 3. 手动创建 thinking/content 块（无工具调用的简单场景）
        //
        // 🔧 块顺序修复：检索块插入在 thinking 之后、content 之前
        // 正确顺序：thinking → retrieval → content（与前端流式渲染一致）

        let assistant_now_ms = chrono::Utc::now().timestamp_millis();
        let elapsed_ms = ctx.elapsed_ms() as i64;
        let mut block_ids: Vec<String> = Vec::new();
        let mut blocks: Vec<MessageBlock> = Vec::new();
        let mut block_index = 0u32;

        // ============================================================
        // 辅助宏：创建检索块，使用流式过程中创建的块 ID
        // 🔧 修复：检索块应该在 thinking 之后、content 之前添加
        // ============================================================
        macro_rules! add_retrieval_block {
            ($block_ids:expr, $blocks:expr, $block_index:expr, $sources:expr, $block_type:expr) => {
                if let Some(ref sources) = $sources {
                    if !sources.is_empty() {
                        let retrieval_block_id = ctx.streaming_retrieval_block_ids
                            .get(&$block_type.to_string())
                            .cloned()
                            .unwrap_or_else(|| MessageBlock::generate_id());
                        let started_at = assistant_now_ms - elapsed_ms;
                        let block = MessageBlock {
                            id: retrieval_block_id,
                            message_id: ctx.assistant_message_id.clone(),
                            block_type: $block_type.to_string(),
                            status: block_status::SUCCESS.to_string(),
                            content: None,
                            tool_name: None,
                            tool_input: None,
                            tool_output: Some(json!({ "sources": sources })),
                            citations: None,
                            error: None,
                            started_at: Some(started_at),
                            ended_at: Some(assistant_now_ms),
                            // 🔧 检索块使用 started_at 作为排序依据
                            first_chunk_at: Some(started_at),
                            block_index: $block_index,
                        };
                        $block_ids.push(block.id.clone());
                        $blocks.push(block);
                        $block_index += 1;
                    }
                }
            };
        }

        // ============================================================
        // 优先级 1: Interleaved Thinking 模式（多轮工具调用）
        // 🔧 P3修复：保持原始交替顺序！不要分离 thinking 块
        // 正确顺序：retrieval → thinking → tool → thinking → tool → ...
        // ============================================================
        if ctx.has_interleaved_blocks() {
            log::info!(
                "[ChatV2::pipeline] Using interleaved blocks for save: count={}",
                ctx.interleaved_block_ids.len()
            );

            // 🔧 P3修复：先添加检索块（检索在 LLM 调用之前完成）
            add_retrieval_block!(
                block_ids,
                blocks,
                block_index,
                ctx.retrieved_sources.rag,
                block_types::RAG
            );
            add_retrieval_block!(
                block_ids,
                blocks,
                block_index,
                ctx.retrieved_sources.memory,
                block_types::MEMORY
            );
            add_retrieval_block!(
                block_ids,
                blocks,
                block_index,
                ctx.retrieved_sources.web_search,
                block_types::WEB_SEARCH
            );

            // 🔧 P3修复：保持 interleaved_blocks 的原始交替顺序
            // 不再分离 thinking 块，直接按原顺序添加
            for mut block in ctx.interleaved_blocks.iter().cloned() {
                block.block_index = block_index;
                block_ids.push(block.id.clone());
                blocks.push(block);
                block_index += 1;
            }
        }
        // ============================================================
        // 优先级 2: 旧的 generated_blocks 逻辑（兼容性保留，目前未使用）
        // 注意：generated_blocks 当前始终为空，此分支保留用于未来兼容
        // ============================================================
        else {
            let assistant_block_ids: Vec<String> =
                ctx.generated_blocks.iter().map(|b| b.id.clone()).collect();

            if !assistant_block_ids.is_empty() {
                // 分离 thinking 块和其他块
                let thinking_blocks: Vec<_> = ctx
                    .generated_blocks
                    .iter()
                    .filter(|b| b.block_type == block_types::THINKING)
                    .cloned()
                    .collect();
                let other_blocks: Vec<_> = ctx
                    .generated_blocks
                    .iter()
                    .filter(|b| b.block_type != block_types::THINKING)
                    .cloned()
                    .collect();

                // 1. 添加 thinking 块
                for mut block in thinking_blocks {
                    block.block_index = block_index;
                    block_ids.push(block.id.clone());
                    blocks.push(block);
                    block_index += 1;
                }

                // 2. 添加检索块
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.rag,
                    block_types::RAG
                );
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.memory,
                    block_types::MEMORY
                );
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.web_search,
                    block_types::WEB_SEARCH
                );

                // 3. 添加其他块（content/tool）
                for mut block in other_blocks {
                    block.block_index = block_index;
                    block_ids.push(block.id.clone());
                    blocks.push(block);
                    block_index += 1;
                }
            }
            // ============================================================
            // 优先级 3: 手动创建 thinking/content 块（无工具调用的简单场景）
            // 🔧 修复：正确顺序为 thinking → retrieval → content
            // 🔧 修复：只要有 thinking 或 content 内容，都应该保存（取消时可能只有 thinking）
            // ============================================================
            else if !ctx.final_content.is_empty()
                || ctx
                    .final_reasoning
                    .as_ref()
                    .map_or(false, |r| !r.is_empty())
            {
                log::info!(
                    "[ChatV2::pipeline] save_results priority 3: final_content_len={}, final_reasoning={:?}",
                    ctx.final_content.len(),
                    ctx.final_reasoning.as_ref().map(|r| format!("{}chars", r.len()))
                );
                // 1. thinking 块：使用流式过程中创建的块 ID，确保与前端一致
                if let Some(ref reasoning) = ctx.final_reasoning {
                    if !reasoning.is_empty() {
                        let thinking_block_id = ctx
                            .streaming_thinking_block_id
                            .clone()
                            .unwrap_or_else(|| MessageBlock::generate_id());
                        let started_at = assistant_now_ms - elapsed_ms;
                        let block = MessageBlock {
                            id: thinking_block_id,
                            message_id: ctx.assistant_message_id.clone(),
                            block_type: block_types::THINKING.to_string(),
                            status: block_status::SUCCESS.to_string(),
                            content: Some(reasoning.clone()),
                            tool_name: None,
                            tool_input: None,
                            tool_output: None,
                            citations: None,
                            error: None,
                            started_at: Some(started_at),
                            ended_at: Some(assistant_now_ms),
                            // 🔧 使用 started_at 作为 first_chunk_at（流式时记录的）
                            first_chunk_at: Some(started_at),
                            block_index,
                        };
                        block_ids.push(block.id.clone());
                        blocks.push(block);
                        block_index += 1;
                    }
                }

                // 2. 检索块（在 thinking 后、content 前）
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.rag,
                    block_types::RAG
                );
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.memory,
                    block_types::MEMORY
                );
                add_retrieval_block!(
                    block_ids,
                    blocks,
                    block_index,
                    ctx.retrieved_sources.web_search,
                    block_types::WEB_SEARCH
                );

                // 3. content 块：使用流式过程中创建的块 ID，确保与前端一致
                // 🔧 修复：只有当 final_content 不为空时才创建 content 块（取消时可能只有 thinking）
                if !ctx.final_content.is_empty() {
                    let content_block_id = ctx
                        .streaming_content_block_id
                        .clone()
                        .unwrap_or_else(|| MessageBlock::generate_id());
                    let started_at = assistant_now_ms - elapsed_ms;
                    let block = MessageBlock {
                        id: content_block_id,
                        message_id: ctx.assistant_message_id.clone(),
                        block_type: block_types::CONTENT.to_string(),
                        status: block_status::SUCCESS.to_string(),
                        content: Some(ctx.final_content.clone()),
                        tool_name: None,
                        tool_input: None,
                        tool_output: None,
                        citations: None,
                        error: None,
                        started_at: Some(started_at),
                        ended_at: Some(assistant_now_ms),
                        // 🔧 使用 started_at 作为 first_chunk_at
                        first_chunk_at: Some(started_at),
                        block_index,
                    };
                    block_ids.push(block.id.clone());
                    blocks.push(block);
                    block_index += 1;
                }
            }

            // 工具调用块（仅在非 interleaved 模式下添加，因为 interleaved 模式已包含）
            for tool_result in &ctx.tool_results {
                let tool_block_id = tool_result
                    .block_id
                    .clone()
                    .unwrap_or_else(|| MessageBlock::generate_id());
                let started_at = assistant_now_ms - tool_result.duration_ms.unwrap_or(0) as i64;

                // 🔧 修复：根据工具名称判断正确的 block_type
                // 检索工具使用对应的检索块类型，而不是 mcp_tool
                let block_type = Self::tool_name_to_block_type(&tool_result.tool_name);

                let block = MessageBlock {
                    id: tool_block_id,
                    message_id: ctx.assistant_message_id.clone(),
                    block_type,
                    status: if tool_result.success {
                        block_status::SUCCESS.to_string()
                    } else {
                        block_status::ERROR.to_string()
                    },
                    content: None,
                    tool_name: Some(tool_result.tool_name.clone()),
                    tool_input: Some(tool_result.input.clone()),
                    tool_output: Some(tool_result.output.clone()),
                    citations: None,
                    error: if tool_result.success {
                        None
                    } else {
                        tool_result.error.clone()
                    },
                    started_at: Some(started_at),
                    ended_at: Some(assistant_now_ms),
                    // 🔧 工具块使用 started_at 作为排序依据
                    first_chunk_at: Some(started_at),
                    block_index,
                };
                block_ids.push(block.id.clone());
                blocks.push(block);
                block_index += 1;
            }
        }

        // 🔧 Preserve `anki_cards` blocks created outside of pipeline-generated blocks.
        //
        // `ChatV2Repo::create_message_with_conn` uses SQLite `INSERT OR REPLACE` (DELETE+INSERT).
        // With `chat_v2_blocks.message_id ON DELETE CASCADE`, replacing the assistant message row
        // can delete existing blocks (including ChatAnki-generated `anki_cards` blocks).
        let preserved_anki_cards_blocks: Vec<MessageBlock> =
            ChatV2Repo::get_message_blocks_with_conn(&conn, &ctx.assistant_message_id)?
                .into_iter()
                .filter(|b| b.block_type == block_types::ANKI_CARDS)
                .collect();
        let _preserved_anki_cards_block_ids: Vec<String> = preserved_anki_cards_blocks
            .iter()
            .map(|b| b.id.clone())
            .collect();

        // 🔧 P37 修复：合并数据库中已有的 block_ids（保留前端追加的块）
        // 问题：前端在工具执行后创建 workspace_status 块并追加到消息的 block_ids，
        //       但 save_results 会用 final_block_ids 覆盖整个消息，导致前端追加的块丢失
        // 解决：先读取数据库中现有消息的 block_ids，合并前端追加的块
        let final_block_ids = {
            let mut merged_block_ids = block_ids;

            // 尝试读取数据库中现有消息的 block_ids
            if let Ok(existing_block_ids_json) = conn.query_row::<Option<String>, _, _>(
                "SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1",
                rusqlite::params![&ctx.assistant_message_id],
                |row| row.get(0),
            ) {
                if let Some(json_str) = existing_block_ids_json {
                    if let Ok(existing_block_ids) = serde_json::from_str::<Vec<String>>(&json_str) {
                        // 找出前端追加的块（在数据库中但不在当前 block_ids 中）
                        for existing_id in existing_block_ids {
                            if !merged_block_ids.contains(&existing_id) {
                                log::info!(
                                    "[ChatV2::pipeline] 🔧 P37: Preserving frontend-appended block_id: {}",
                                    existing_id
                                );
                                merged_block_ids.push(existing_id);
                            }
                        }
                    }
                }
            }

            // 🔧 修复：按原始 block_index 插入 anki_cards 块，保持其原始位置
            // 而不是追加到末尾导致刷新后位置变化
            let pipeline_id_set: std::collections::HashSet<&str> =
                merged_block_ids.iter().map(|s| s.as_str()).collect();
            let mut anki_inserts: Vec<(u32, String)> = preserved_anki_cards_blocks
                .iter()
                .filter(|b| !pipeline_id_set.contains(b.id.as_str()))
                .map(|b| (b.block_index, b.id.clone()))
                .collect();
            anki_inserts.sort_by_key(|(idx, _)| *idx);

            for (orig_idx, id) in anki_inserts {
                // 将 anki_cards 块插入到其原始 block_index 对应的位置
                let insert_pos = std::cmp::min(orig_idx as usize, merged_block_ids.len());
                if !merged_block_ids.contains(&id) {
                    merged_block_ids.insert(insert_pos, id);
                }
            }

            merged_block_ids
        };
        let blocks_to_save = blocks;
        let _pipeline_block_count = blocks_to_save.len() as u32;
        let pipeline_block_id_set: std::collections::HashSet<String> =
            blocks_to_save.iter().map(|b| b.id.clone()).collect();

        // 构建 chatParams 快照（从 SendOptions 中提取相关参数）
        let chat_params_snapshot = json!({
            "modelId": ctx.options.model_id,
            "temperature": ctx.options.temperature,
            "contextLimit": ctx.options.context_limit,
            "maxTokens": ctx.options.max_tokens,
            "enableThinking": ctx.options.enable_thinking,
            "disableTools": ctx.options.disable_tools,
            "model2OverrideId": ctx.options.model2_override_id,
        });

        // 构建助手消息元数据
        // 🔧 Bug修复：model_id 使用模型显示名称（如 "Qwen/Qwen3-8B"），而不是 API 配置 ID
        // 这确保刷新后前端能正确显示模型名称和图标
        let assistant_meta = MessageMeta {
            model_id: ctx
                .model_display_name
                .clone()
                .or_else(|| {
                    // 🔧 P0-2 修复：优先尝试 model2_override_id（实际使用的模型）
                    // 过滤配置 ID 格式，避免保存前端无法识别的值
                    ctx.options.model2_override_id.as_ref()
                        .filter(|id| !is_config_id_format(id))
                        .cloned()
                })
                .or_else(|| {
                    ctx.options.model_id.as_ref()
                        .filter(|id| !is_config_id_format(id))
                        .cloned()
                }),
            chat_params: Some(chat_params_snapshot),
            sources: if ctx.retrieved_sources.rag.is_some()
                || ctx.retrieved_sources.memory.is_some()
                || ctx.retrieved_sources.web_search.is_some()
            {
                Some(ctx.retrieved_sources.clone())
            } else {
                None
            },
            tool_results: if ctx.tool_results.is_empty() {
                None
            } else {
                Some(ctx.tool_results.clone())
            },
            anki_cards: None,
            // 🆕 Prompt 5: 保存 token 统计（始终保存，不跳过零值）
            usage: Some(ctx.token_usage.clone()),
            // 🆕 Prompt 8: 保存上下文快照（统一上下文注入系统）
            // 只存 ContextRef，不存 formattedBlocks
            context_snapshot: if ctx.context_snapshot.has_refs() {
                Some(ctx.context_snapshot.clone())
            } else {
                None
            },
        };

        let assistant_message = ChatMessage {
            id: ctx.assistant_message_id.clone(),
            session_id: ctx.session_id.clone(),
            role: MessageRole::Assistant,
            block_ids: final_block_ids,
            timestamp: chrono::Utc::now().timestamp_millis(),
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: Some(assistant_meta),
            attachments: None,
            active_variant_id: None,
            variants: None,
            shared_context: None,
        };

        // 检查是否跳过助手消息保存（重试场景）
        let skip_assistant_message = ctx.options.skip_assistant_message_save.unwrap_or(false);

        if !skip_assistant_message {
            // 正常场景：创建新的助手消息
            ChatV2Repo::create_message_with_conn(&conn, &assistant_message)?;
        } else {
            // 重试场景：更新已有的助手消息（只更新块列表和元数据）
            log::debug!(
                "[ChatV2::pipeline] Updating existing assistant message for retry: id={}",
                ctx.assistant_message_id
            );
            ChatV2Repo::update_message_with_conn(&conn, &assistant_message)?;
        }

        // 保存所有助手消息块（无论是创建还是更新消息，块都需要保存）
        for (index, mut block) in blocks_to_save.into_iter().enumerate() {
            // 确保 block_index 正确设置
            block.block_index = index as u32;
            // 确保 message_id 正确
            block.message_id = ctx.assistant_message_id.clone();
            ChatV2Repo::create_block_with_conn(&conn, &block)?;
        }

        // Re-insert preserved `anki_cards` blocks deleted by the assistant message REPLACE.
        //    🔧 修复：保持 anki_cards 块的原始 block_index，不再追加到末尾
        if !preserved_anki_cards_blocks.is_empty() {
            for preserved in preserved_anki_cards_blocks {
                // If the pipeline already has the same block id, prefer the pipeline version.
                if pipeline_block_id_set.contains(preserved.id.as_str()) {
                    continue;
                }

                // 保持原始 block_index 不变，这样刷新后位置不会跳到末尾
                let mut block_to_save = preserved;
                block_to_save.message_id = ctx.assistant_message_id.clone();

                if let Err(e) = ChatV2Repo::create_block_with_conn(&conn, &block_to_save) {
                    log::error!(
                        "[ChatV2::pipeline] Failed to re-insert preserved anki_cards block: message_id={}, block_id={}, err={:?}",
                        ctx.assistant_message_id,
                        block_to_save.id,
                        e
                    );
                }
            }
        }

        log::info!(
            "[ChatV2::pipeline] Results saved: session={}, user_msg={}, assistant_msg={}, blocks={}, content_len={}",
            ctx.session_id,
            ctx.user_message_id,
            ctx.assistant_message_id,
            ctx.generated_blocks.len(),
            ctx.final_content.len()
        );

        Ok(())
    }

    /// 保存结果后的后处理操作（在事务提交后执行）
    ///
    /// 此方法在事务成功提交后由 `save_results` 调用，
    /// 执行不需要事务保护的后处理操作。
    async fn save_results_post_commit(&self, ctx: &PipelineContext) {
        // 🆕 Prompt 8: 消息保存后增加资源引用计数（统一上下文注入系统）
        // 约束：消息保存后调用 incrementRef
        // 注意：此操作在事务提交后执行，确保只有在数据库写入成功后才增加引用计数
        if ctx.context_snapshot.has_refs() {
            let resource_ids = ctx.context_snapshot.all_resource_ids();
            self.increment_resource_refs(&resource_ids).await;
            log::debug!(
                "[ChatV2::pipeline] Incremented refs for {} resources after message save",
                resource_ids.len()
            );
        }
    }

    // ========================================================================
    // 自动摘要生成（标题 + 简介）
    // ========================================================================

    /// 摘要生成 Prompt（同时生成标题和简介）
    const SUMMARY_GENERATION_PROMPT: &'static str = r#"请根据以下对话内容生成会话标题和简介。

要求：
1. 标题（title）：5-20 个字符，概括对话主题
2. 简介（description）：30-80 个字符，描述对话的主要内容和结论
3. 使用中文
4. 不要使用引号包裹
5. 按 JSON 格式输出：{"title": "标题", "description": "简介"}

用户问题：
{user_content}

助手回复（摘要）：
{assistant_content}

请输出 JSON："#;

    /// 自动生成会话摘要（标题 + 简介）
    ///
    /// 在每轮对话完成后调用，根据对话内容生成标题和简介。
    /// 通过内容哈希防止重复生成。
    ///
    /// ## 参数
    /// - `session_id`: 会话 ID
    /// - `user_content`: 用户消息内容
    /// - `assistant_content`: 助手回复内容
    /// - `emitter`: 事件发射器（用于通知前端）
    ///
    /// ## 说明
    /// - 异步执行，不阻塞主流程
    /// - 生成失败不影响对话功能
    /// - 标题长度限制为 50 字符，简介限制为 100 字符
    pub async fn generate_summary(
        &self,
        session_id: &str,
        user_content: &str,
        assistant_content: &str,
        emitter: Arc<ChatV2EventEmitter>,
    ) {
        log::info!(
            "[ChatV2::pipeline] Generating summary for session={}",
            session_id
        );

        // 截取助手回复的前 500 个字符作为摘要（安全处理 UTF-8）
        let assistant_summary: String = assistant_content.chars().take(500).collect();

        // 构建 prompt
        let prompt = Self::SUMMARY_GENERATION_PROMPT
            .replace("{user_content}", user_content)
            .replace("{assistant_content}", &assistant_summary);

        // 调用 LLM 生成摘要
        let response = match self.call_llm_for_summary(&prompt).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[ChatV2::pipeline] Failed to generate summary: {}", e);
                return;
            }
        };

        // 解析 JSON 响应
        let (title, description) = match Self::parse_summary_response(&response) {
            Some((t, d)) => (t, d),
            None => {
                log::warn!(
                    "[ChatV2::pipeline] Failed to parse summary JSON: {}",
                    response
                );
                // 回退：将整个响应作为标题，简介留空
                let fallback_title = response
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .chars()
                    .take(50)
                    .collect::<String>();
                if fallback_title.is_empty() {
                    return;
                }
                (fallback_title, String::new())
            }
        };

        if title.is_empty() {
            log::warn!("[ChatV2::pipeline] Generated title is empty");
            return;
        }

        log::info!(
            "[ChatV2::pipeline] Generated summary for session={}: title={}, description={}",
            session_id,
            title,
            description
        );

        // 计算内容哈希（用于防重复生成）
        let content_hash = Self::compute_content_hash(user_content, &assistant_summary);

        // 更新数据库
        if let Err(e) = self
            .update_session_summary(session_id, &title, &description, &content_hash)
            .await
        {
            log::error!("[ChatV2::pipeline] Failed to update session summary: {}", e);
            return;
        }

        // 发送事件通知前端
        emitter.emit_summary_updated(&title, &description);
    }

    /// 解析摘要生成的 JSON 响应
    fn parse_summary_response(response: &str) -> Option<(String, String)> {
        // 尝试解析 JSON
        let response = response.trim();

        // 处理可能的 markdown 代码块包裹
        let json_str = if response.starts_with("```") {
            response
                .trim_start_matches("```json")
                .trim_start_matches("```")
                .trim_end_matches("```")
                .trim()
        } else {
            response
        };

        // 解析 JSON
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
            let title = v
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim_matches('「')
                .trim_matches('」');

            let description = v
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            // 截取长度
            let title = if title.chars().count() > 50 {
                title.chars().take(50).collect::<String>()
            } else {
                title.to_string()
            };

            let description = if description.chars().count() > 100 {
                description.chars().take(100).collect::<String>()
            } else {
                description.to_string()
            };

            if !title.is_empty() {
                return Some((title, description));
            }
        }

        None
    }

    /// 计算内容哈希（用于防重复生成）
    fn compute_content_hash(user_content: &str, assistant_content: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(user_content.as_bytes());
        hasher.update(b"|");
        hasher.update(assistant_content.as_bytes());
        let result = hasher.finalize();
        // 取前 16 字节作为哈希
        hex::encode(&result[..16])
    }

    /// 调用 LLM 生成摘要（简单的非流式调用）
    ///
    /// 使用标题/标签生成模型（回退链：chat_title_model → model2）。
    ///
    /// 🔧 P1修复：添加 Pipeline 层超时保护
    async fn call_llm_for_summary(&self, prompt: &str) -> ChatV2Result<String> {
        // 调用 LLM（非流式），使用标题生成专用模型，带超时保护
        let llm_future = self.llm_manager.call_chat_title_raw_prompt(prompt);

        let response =
            match timeout(Duration::from_secs(LLM_NON_STREAM_TIMEOUT_SECS), llm_future).await {
                Ok(result) => {
                    result.map_err(|e| ChatV2Error::Llm(format!("LLM call failed: {}", e)))?
                }
                Err(_) => {
                    log::error!(
                        "[ChatV2::pipeline] LLM summary call timeout after {}s",
                        LLM_NON_STREAM_TIMEOUT_SECS
                    );
                    return Err(ChatV2Error::Timeout(format!(
                        "LLM summary call timed out after {}s",
                        LLM_NON_STREAM_TIMEOUT_SECS
                    )));
                }
            };

        // 提取内容
        let summary = response.assistant_message.trim().to_string();
        Ok(summary)
    }

    /// 更新会话摘要（标题 + 简介 + 哈希）
    async fn update_session_summary(
        &self,
        session_id: &str,
        title: &str,
        description: &str,
        summary_hash: &str,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;

        // 获取会话
        let mut session = ChatV2Repo::get_session_with_conn(&conn, session_id)?
            .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.to_string()))?;

        // 更新摘要
        session.title = Some(title.to_string());
        session.description = if description.is_empty() {
            None
        } else {
            Some(description.to_string())
        };
        session.summary_hash = Some(summary_hash.to_string());
        session.updated_at = chrono::Utc::now();

        // 保存
        ChatV2Repo::update_session_with_conn(&conn, &session)?;

        log::debug!(
            "[ChatV2::pipeline] Session summary updated: session={}, title={}, description={}",
            session_id,
            title,
            description
        );

        Ok(())
    }

    /// 检查会话是否需要生成摘要
    ///
    /// 条件：内容哈希与上次生成时不同
    async fn should_generate_summary(
        &self,
        session_id: &str,
        user_content: &str,
        assistant_content: &str,
    ) -> bool {
        // 计算当前内容哈希
        let assistant_summary: String = assistant_content.chars().take(500).collect();
        let current_hash = Self::compute_content_hash(user_content, &assistant_summary);

        // 获取会话中保存的哈希
        let conn = match self.db.get_conn_safe() {
            Ok(c) => c,
            Err(_) => return true, // 出错时允许生成
        };

        let session = match ChatV2Repo::get_session_with_conn(&conn, session_id) {
            Ok(Some(s)) => s,
            Ok(None) | Err(_) => return true, // 会话不存在时允许生成
        };

        // 如果哈希相同，不需要重新生成
        match &session.summary_hash {
            Some(hash) if hash == &current_hash => {
                log::debug!(
                    "[ChatV2::pipeline] Skip summary generation, hash unchanged: {}",
                    session_id
                );
                false
            }
            _ => true,
        }
    }

    /// 取消正在进行的流式生成
    ///
    /// ## 参数
    /// - `session_id`: 会话 ID
    /// - `message_id`: 消息 ID
    ///
    /// ## 说明
    /// 取消操作通过 `CancellationToken` 实现，需要在 handlers 层管理 token。
    pub fn cancel(&self, session_id: &str, message_id: &str) {
        log::info!(
            "[ChatV2::pipeline] Cancel requested for session={}, message={}",
            session_id,
            message_id
        );
        // 实际取消逻辑在 handlers 层通过 CancellationToken 实现
    }

    // ========================================================================
    // 多模型并行变体执行 (Prompt 5)
    // ========================================================================

    /// 最大变体数限制（默认值）
    const DEFAULT_MAX_VARIANTS: u32 = 10;

    /// 多模型并行执行入口
    ///
    /// ## 执行流程
    /// 1. 创建用户消息和助手消息
    /// 2. 执行共享检索 → SharedContext
    /// 3. 持久化 shared_context
    /// 4. 为每个模型创建 VariantExecutionContext
    /// 5. 发射 stream_start
    /// 6. tokio::spawn + join_all 并行执行所有变体
    /// 7. 收集变体结果，确定 active_variant_id（第一个成功的）
    /// 8. 持久化变体列表
    /// 9. 发射 stream_complete
    ///
    /// ## 约束
    /// - 检索只执行一次
    /// - 多变体模式下强制 anki_enabled = false
    /// - 超过 max_variants_per_message 返回 LimitExceeded 错误
    /// - active_variant_id 默认设为第一个成功的变体
    ///
    /// ## 参数
    /// - `window`: Tauri 窗口句柄
    /// - `request`: 发送消息请求
    /// - `model_ids`: 要并行执行的模型 ID 列表
    /// - `cancel_token`: 取消令牌
    ///
    /// ## 返回
    /// 助手消息 ID
    /// 🔧 P1修复：添加 chat_v2_state 参数，用于注册每个变体的 cancel token
    pub async fn execute_multi_variant(
        &self,
        window: tauri::Window,
        request: SendMessageRequest,
        model_ids: Vec<String>,
        cancel_token: CancellationToken,
        chat_v2_state: Option<Arc<super::state::ChatV2State>>,
    ) -> ChatV2Result<String> {
        use super::variant_context::{ParallelExecutionManager, VariantExecutionContext};
        use futures::future::join_all;

        let start_time = Instant::now();
        let session_id = request.session_id.clone();
        let user_content = request.content.clone();
        let mut options = request.options.clone().unwrap_or_default();

        // === 0. 智能 vision_quality 计算（与单变体路径保持一致）===
        // 如果用户没有显式指定，根据图片数量和来源自动选择压缩策略
        if options
            .vision_quality
            .as_deref()
            .filter(|v| !v.is_empty() && *v != "auto")
            .is_none()
        {
            let user_refs = request.user_context_refs.as_deref().unwrap_or(&[]);
            let mut image_count = 0usize;
            let mut has_pdf_or_textbook = false;

            for ctx_ref in user_refs {
                // 统计图片块数量
                for block in &ctx_ref.formatted_blocks {
                    if matches!(block, super::resource_types::ContentBlock::Image { .. }) {
                        image_count += 1;
                    }
                }
                // 检查是否有 PDF/教材来源
                let type_id_lower = ctx_ref.type_id.to_lowercase();
                if type_id_lower.contains("pdf")
                    || type_id_lower.contains("textbook")
                    || type_id_lower.contains("file")
                    || ctx_ref.resource_id.starts_with("tb_")
                {
                    has_pdf_or_textbook = true;
                }
            }

            // 智能策略
            let auto_quality = if has_pdf_or_textbook || image_count >= 6 {
                "low" // PDF/教材 或大量图片：最大压缩
            } else if image_count >= 2 {
                "medium" // 中等数量：平衡压缩
            } else {
                "high" // 单图或无图：保持原质量
            };

            log::info!(
                "[ChatV2::pipeline] Multi-variant vision_quality: auto -> '{}' (images={}, has_pdf_or_textbook={})",
                auto_quality, image_count, has_pdf_or_textbook
            );
            options.vision_quality = Some(auto_quality.to_string());
        }

        // === 1. 约束检查 ===
        // 检查变体数量限制
        let max_variants = options
            .max_variants_per_message
            .unwrap_or(Self::DEFAULT_MAX_VARIANTS);
        if model_ids.len() as u32 > max_variants {
            return Err(ChatV2Error::LimitExceeded(format!(
                "Variant count {} exceeds maximum allowed {}",
                model_ids.len(),
                max_variants
            )));
        }

        if model_ids.is_empty() {
            return Err(ChatV2Error::Other("No model IDs provided".to_string()));
        }

        // 🔧 2025-01-27 对齐单变体：多变体模式现在支持 Anki，使用用户配置的值
        // options.anki_enabled 保持用户配置，不再强制禁用

        // === 获取 API 配置，构建 config_id -> model 的映射 ===
        // 前端传递的是 API 配置 ID，我们需要从中提取真正的模型名称用于前端显示
        let api_configs = self
            .llm_manager
            .get_api_configs()
            .await
            .map_err(|e| ChatV2Error::Other(format!("Failed to get API configs: {}", e)))?;

        // 构建 config_id -> (model, config_id) 的映射
        // model: 用于前端显示（如 "Qwen/Qwen3-8B"）
        // config_id: 用于 LLM 调用
        let config_map: std::collections::HashMap<String, (String, String)> = api_configs
            .into_iter()
            .map(|c| (c.id.clone(), (c.model.clone(), c.id)))
            .collect();

        // 解析 model_ids，提取真正的模型名称和配置 ID
        let resolved_models: Vec<(String, String)> = model_ids
            .iter()
            .filter_map(|config_id| {
                config_map.get(config_id).cloned().or_else(|| {
                    // 🔧 三轮修复：如果 config_id 是配置 UUID，不应作为模型显示名称
                    if is_config_id_format(config_id) {
                        log::warn!(
                            "[ChatV2::pipeline] Config not found for id and id is a config format, using empty display name: {}",
                            config_id
                        );
                        Some((String::new(), config_id.clone()))
                    } else {
                        log::warn!(
                            "[ChatV2::pipeline] Config not found for id: {}, using as model name",
                            config_id
                        );
                        Some((config_id.clone(), config_id.clone()))
                    }
                })
            })
            .collect();

        log::info!(
            "[ChatV2::pipeline] execute_multi_variant: session={}, models={:?}, content_len={}",
            session_id,
            resolved_models.iter().map(|(m, _)| m).collect::<Vec<_>>(),
            user_content.len()
        );

        // === 2. 使用请求中的消息 ID（如果提供），否则生成新的 ===
        // 🔧 修复：使用前端传递的 ID，确保前后端一致
        let user_message_id = request
            .user_message_id
            .clone()
            .unwrap_or_else(ChatMessage::generate_id);
        let assistant_message_id = request
            .assistant_message_id
            .clone()
            .unwrap_or_else(ChatMessage::generate_id);

        // === 3. 创建事件发射器 ===
        let emitter = Arc::new(ChatV2EventEmitter::new(window.clone(), session_id.clone()));

        // === 4. 执行共享检索（只执行一次）===
        let shared_context = self
            .execute_shared_retrievals(&request, &emitter, &assistant_message_id)
            .await?;
        let shared_context = Arc::new(shared_context);

        log::debug!(
            "[ChatV2::pipeline] Shared retrievals completed: has_sources={}",
            shared_context.has_sources()
        );

        // === 5. 发射 stream_start ===
        // 多变体模式不在 stream_start 中传递模型名称，每个变体通过 variant_start 事件传递
        emitter.emit_stream_start(&assistant_message_id, None);

        // 🆕 P0防闪退：用户消息即时保存（多变体模式）
        // 在变体执行前立即保存用户消息，确保用户输入不会因闪退丢失
        if !options.skip_user_message_save.unwrap_or(false) {
            // 构建临时 PipelineContext 用于保存用户消息
            let temp_request = SendMessageRequest {
                session_id: session_id.clone(),
                content: user_content.clone(),
                user_message_id: Some(user_message_id.clone()),
                assistant_message_id: Some(assistant_message_id.clone()),
                options: Some(options.clone()),
                user_context_refs: request.user_context_refs.clone(),
                path_map: request.path_map.clone(),
                workspace_id: request.workspace_id.clone(),
            };
            let temp_ctx = PipelineContext::new(temp_request);
            if let Err(e) = self.save_user_message_immediately(&temp_ctx).await {
                log::warn!(
                    "[ChatV2::pipeline] Multi-variant: Failed to save user message immediately: {}",
                    e
                );
            } else {
                log::info!(
                    "[ChatV2::pipeline] Multi-variant: User message saved immediately: id={}",
                    user_message_id
                );
            }
        }

        // === 6. 创建并行执行管理器 ===
        let manager = ParallelExecutionManager::with_cancel_token(cancel_token.clone());

        // 为每个模型创建 VariantExecutionContext
        // 使用 resolved_models 中的 (模型名称, 配置ID) 元组
        // - 模型名称：传递给变体上下文，用于前端显示
        // - 配置ID：用于 LLM 调用
        let mut variant_contexts: Vec<(Arc<VariantExecutionContext>, String)> =
            Vec::with_capacity(resolved_models.len());
        for (model_name, config_id) in &resolved_models {
            let variant_id = Variant::generate_id();
            let ctx = manager.create_variant(
                variant_id.clone(),
                model_name.clone(), // 使用模型名称，用于前端显示
                assistant_message_id.clone(),
                Arc::clone(&shared_context),
                Arc::clone(&emitter),
            );

            // 🔧 P2修复：设置 config_id，用于重试时正确选择模型
            ctx.set_config_id(config_id.clone());

            // 🔧 P1修复：为每个变体注册独立的 cancel token
            // 使用 session_id:variant_id 作为 key，这样可以精确取消单个变体
            if let Some(ref state) = chat_v2_state {
                let cancel_key = format!("{}:{}", session_id, variant_id);
                state.register_existing_token(&cancel_key, ctx.cancel_token().clone());
                log::debug!(
                    "[ChatV2::pipeline] Registered cancel token for variant: {}",
                    cancel_key
                );
            }

            variant_contexts.push((ctx, config_id.clone())); // 保存配置ID用于LLM调用
        }

        // === 6.5 防闪退：持久化助手消息骨架（含 pending 变体列表）===
        // 在变体执行前写入 DB，确保刷新/崩溃后仍能识别为多变体消息。
        // save_multi_variant_results 使用 INSERT OR REPLACE 在完成后覆盖此骨架。
        {
            let skeleton_variants: Vec<Variant> = variant_contexts
                .iter()
                .map(|(ctx, _)| {
                    Variant::new_with_id_and_config(
                        ctx.variant_id().to_string(),
                        ctx.model_id().to_string(),
                        ctx.get_config_id().unwrap_or_default(),
                    )
                })
                .collect();

            let first_variant_id = skeleton_variants.first().map(|v| v.id.clone());

            let skeleton_msg = ChatMessage {
                id: assistant_message_id.clone(),
                session_id: session_id.clone(),
                role: MessageRole::Assistant,
                block_ids: Vec::new(),
                timestamp: chrono::Utc::now().timestamp_millis(),
                persistent_stable_id: None,
                parent_id: None,
                supersedes: None,
                meta: Some(MessageMeta {
                    model_id: None,
                    chat_params: Some(serde_json::json!({
                        "multiVariantMode": true,
                    })),
                    sources: None,
                    tool_results: None,
                    anki_cards: None,
                    usage: None,
                    context_snapshot: None,
                }),
                attachments: None,
                active_variant_id: first_variant_id,
                variants: Some(skeleton_variants),
                shared_context: Some((*shared_context).clone()),
            };

            if let Ok(conn) = self.db.get_conn_safe() {
                if let Err(e) = ChatV2Repo::create_message_with_conn(&conn, &skeleton_msg) {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to persist skeleton assistant message (non-fatal): {}",
                        e
                    );
                } else {
                    log::info!(
                        "[ChatV2::pipeline] Persisted skeleton assistant message: id={}, variants={}",
                        assistant_message_id,
                        variant_contexts.len()
                    );
                }
            }
        }

        // === 7. 并行执行所有变体 ===
        let self_clone = self.clone();
        let options_arc = Arc::new(options.clone());
        let user_content_arc = Arc::new(user_content.clone());
        let session_id_arc = Arc::new(session_id.clone());

        // 🔧 P1修复：使用任务追踪器追踪并行任务
        // 创建并行任务
        let futures: Vec<_> = variant_contexts.iter().map(|(ctx, config_id)| {
            let self_ref = self_clone.clone();
            let ctx_clone = Arc::clone(ctx);
            let config_id_clone = config_id.clone();  // API 配置 ID，用于 LLM 调用
            let options_clone = Arc::clone(&options_arc);
            let user_content_clone = Arc::clone(&user_content_arc);
            let session_id_clone = Arc::clone(&session_id_arc);
            let shared_ctx = Arc::clone(&shared_context);
            // ★ 2025-12-10 统一改造：附件不再通过 request.attachments 传递
            let attachments = Vec::new();
            let state_clone = chat_v2_state.clone();

            let future = async move {
                self_ref.execute_single_variant_with_config(
                    ctx_clone,
                    config_id_clone,  // 传递 API 配置 ID
                    (*options_clone).clone(),
                    (*user_content_clone).clone(),
                    (*session_id_clone).clone(),
                    shared_ctx,
                    attachments,
                ).await
            };

            // 🔧 P1修复：优先使用 spawn_tracked 追踪任务
            if let Some(ref state) = state_clone {
                state.spawn_tracked(future)
            } else {
                log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for variant task");
                tokio::spawn(future)
            }
        }).collect();

        // 等待所有变体完成
        let results = join_all(futures).await;

        // 处理结果
        for (i, result) in results.into_iter().enumerate() {
            let (ctx, _) = &variant_contexts[i];
            match result {
                Ok(Ok(())) => {
                    log::info!(
                        "[ChatV2::pipeline] Variant {} completed successfully",
                        ctx.variant_id()
                    );
                }
                Ok(Err(e)) => {
                    log::error!(
                        "[ChatV2::pipeline] Variant {} failed: {}",
                        ctx.variant_id(),
                        e
                    );
                    // 错误已经在 execute_single_variant_with_config 中处理
                }
                Err(e) => {
                    log::error!(
                        "[ChatV2::pipeline] Variant {} task panicked: {}",
                        ctx.variant_id(),
                        e
                    );
                    // 标记为错误
                    ctx.fail(&format!("Task panicked: {}", e));
                }
            }
        }

        // === 8. 确定 active_variant_id ===
        let active_variant_id = manager.get_first_success();

        log::info!(
            "[ChatV2::pipeline] Multi-variant execution completed: active_variant={:?}, success={}, error={}",
            active_variant_id,
            manager.success_count(),
            manager.error_count()
        );

        // === 9. 构建上下文快照（统一上下文注入系统） ===
        let context_snapshot = {
            let mut snapshot = ContextSnapshot::new();

            // 9.1 添加用户上下文引用
            if let Some(ref user_refs) = request.user_context_refs {
                for send_ref in user_refs {
                    snapshot.add_user_ref(send_ref.to_context_ref());
                }
            }

            // 9.2 为检索结果创建资源（如果有）
            // 注：多变体模式下检索结果存储在 shared_context 中
            // 这里我们将检索结果转换为 retrieval 类型的资源
            // TODO: 如果需要更精细的检索资源管理，可以在 execute_shared_retrievals 中直接创建资源

            if snapshot.has_refs() {
                log::debug!(
                    "[ChatV2::pipeline] Multi-variant context snapshot: user_refs={}, retrieval_refs={}",
                    snapshot.user_refs.len(),
                    snapshot.retrieval_refs.len()
                );
                Some(snapshot)
            } else {
                None
            }
        };

        // === 10. 持久化消息和变体 ===
        // 提取纯变体上下文列表用于保存
        let contexts_only: Vec<Arc<VariantExecutionContext>> = variant_contexts
            .iter()
            .map(|(ctx, _)| Arc::clone(ctx))
            .collect();
        // ★ 2025-12-10 统一改造：附件不再通过 request.attachments 传递
        let empty_attachments: Vec<crate::chat_v2::types::AttachmentInput> = Vec::new();
        self.save_multi_variant_results(
            &session_id,
            &user_message_id,
            &assistant_message_id,
            &user_content,
            &empty_attachments,
            &options,
            &shared_context,
            &contexts_only, // 传入 contexts 以便获取累积的内容
            active_variant_id.as_deref(),
            context_snapshot, // 🆕 传入上下文快照
        )
        .await?;

        // === 11. 🔧 P1修复：清理每个变体的 cancel token ===
        if let Some(ref state) = chat_v2_state {
            for (ctx, _) in &variant_contexts {
                let cancel_key = format!("{}:{}", session_id, ctx.variant_id());
                state.remove_stream(&cancel_key);
            }
            log::debug!(
                "[ChatV2::pipeline] Cleaned up {} variant cancel tokens",
                variant_contexts.len()
            );
        }

        // === 12. 发射 stream_complete（带 token 统计） ===
        let duration_ms = start_time.elapsed().as_millis() as u64;
        // 多变体模式下 Message._meta.usage 为 None，每个变体独立统计
        // TODO: Prompt 9 实现后，可选择性汇总所有变体的 token 统计
        emitter.emit_stream_complete_with_usage(&assistant_message_id, duration_ms, None);

        log::info!(
            "[ChatV2::pipeline] Multi-variant pipeline completed in {}ms",
            duration_ms
        );

        // 🔧 自动生成会话摘要（多变体模式）
        // 使用 active_variant 的内容来生成摘要
        if let Some(active_id) = &active_variant_id {
            if let Some((active_ctx, _)) = variant_contexts
                .iter()
                .find(|(ctx, _)| ctx.variant_id() == active_id.as_str())
            {
                let assistant_content = active_ctx.get_accumulated_content();
                if self
                    .should_generate_summary(&session_id, &user_content, &assistant_content)
                    .await
                {
                    let pipeline = self.clone();
                    let sid = session_id.clone();
                    let emitter_clone = emitter.clone();
                    let user_content_clone = user_content.clone();

                    // 🆕 P1修复：使用 TaskTracker 追踪异步任务
                    let summary_future = async move {
                        pipeline
                            .generate_summary(
                                &sid,
                                &user_content_clone,
                                &assistant_content,
                                emitter_clone,
                            )
                            .await;
                    };

                    // 🔧 P1修复：优先使用 spawn_tracked 追踪摘要任务
                    if let Some(ref state) = chat_v2_state {
                        state.spawn_tracked(summary_future);
                    } else {
                        log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for summary task (multi-variant)");
                        tokio::spawn(summary_future);
                    }
                }
            }
        }

        Ok(assistant_message_id)
    }

    /// 执行单个变体
    ///
    /// 在隔离的上下文中执行 LLM 调用，支持工具递归。
    ///
    /// ## 参数
    /// - `ctx`: 变体执行上下文
    /// - `options`: 发送选项
    /// - `user_content`: 用户消息内容
    /// - `session_id`: 会话 ID
    /// - `shared_context`: 共享上下文（检索结果）
    /// - `attachments`: 附件列表
    async fn execute_single_variant(
        &self,
        ctx: Arc<super::variant_context::VariantExecutionContext>,
        mut options: SendOptions,
        user_content: String,
        session_id: String,
        shared_context: Arc<SharedContext>,
        attachments: Vec<AttachmentInput>,
    ) -> ChatV2Result<()> {
        // 使用变体的模型 ID
        options.model_id = Some(ctx.model_id().to_string());
        options.model2_override_id = Some(ctx.model_id().to_string());

        // 开始流式生成
        ctx.start_streaming();

        // 检查是否已取消
        if ctx.is_cancelled() {
            ctx.cancel();
            return Ok(());
        }

        // 构建系统提示（包含共享的检索结果）
        let system_prompt = self
            .build_system_prompt_with_shared_context(&options, &shared_context)
            .await;

        // 加载聊天历史
        let mut chat_history = self.load_variant_chat_history(&session_id).await?;
        // 🆕 2026-02-22: 为已激活的默认技能自动注入合成 load_skills 工具交互
        inject_synthetic_load_skills(&mut chat_history, &options);

        // 构建当前用户消息
        let current_user_message = self.build_variant_user_message(&user_content, &attachments);

        // 创建 LLM 适配器（使用变体的事件发射）
        let enable_thinking = options.enable_thinking.unwrap_or(true);
        let emitter = Arc::new(VariantLLMAdapter::new(Arc::clone(&ctx), enable_thinking));

        // 注册 LLM 流式回调 hooks
        // 🔧 P0修复：每个变体使用唯一的 hook 键，避免并行执行时互相覆盖
        // 前端仍然监听 chat_v2_event_{session_id}，变体 ID 通过 VariantLLMAdapter 在事件 payload 中携带
        let stream_event = format!("chat_v2_event_{}_{}", session_id, ctx.variant_id());
        self.llm_manager
            .register_stream_hooks(&stream_event, emitter.clone())
            .await;

        // 构建消息历史
        let mut messages = chat_history;
        messages.push(current_user_message);

        // 构建 LLM 上下文
        let mut llm_context: std::collections::HashMap<String, Value> =
            std::collections::HashMap::new();
        if let Some(ref rag_sources) = shared_context.rag_sources {
            llm_context.insert(
                "prefetched_rag_sources".into(),
                serde_json::to_value(rag_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref memory_sources) = shared_context.memory_sources {
            llm_context.insert(
                "prefetched_memory_sources".into(),
                serde_json::to_value(memory_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref graph_sources) = shared_context.graph_sources {
            llm_context.insert(
                "prefetched_graph_sources".into(),
                serde_json::to_value(graph_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref web_sources) = shared_context.web_search_sources {
            llm_context.insert(
                "prefetched_web_search_sources".into(),
                serde_json::to_value(web_sources).unwrap_or(Value::Null),
            );
        }

        // 🆕 图片压缩策略：从 options 获取或使用默认值
        // 如果 options.vision_quality 未设置，默认使用 "auto" 让 file_manager 根据图片大小自动选择
        let vq = options.vision_quality.as_deref().unwrap_or("auto");
        llm_context.insert("vision_quality".into(), Value::String(vq.to_string()));

        // 🔧 P1修复：将 context_limit 作为 max_input_tokens_override 传递给 LLM
        let max_input_tokens_override = options.context_limit.map(|v| v as usize);

        // 🔧 2025-01-27 对齐单变体：多变体模式现在支持工具链，使用 options 中的配置
        // 检查是否有工具可用（与 execute_single_variant_with_config 保持一致）
        let has_tools = options
            .mcp_tool_schemas
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let disable_tools = options.disable_tools.unwrap_or(false) || !has_tools;

        // 🔧 2025-01-27 对齐单变体：注入工具 schemas 到 LLM 上下文
        // 注意：execute_single_variant 用于单次变体重试，不支持工具递归调用
        // 如需完整的工具调用循环，请使用 execute_single_variant_with_config
        if !disable_tools {
            if let Some(ref tool_schemas) = options.mcp_tool_schemas {
                let mcp_tool_values: Vec<Value> = tool_schemas
                    .iter()
                    .map(|tool| {
                        let tool_name = if tool.name.starts_with(BUILTIN_NAMESPACE) {
                            tool.name.clone()
                        } else {
                            format!("mcp_{}", tool.name)
                        };
                        json!({
                            "type": "function",
                            "function": {
                                "name": tool_name,
                                "description": tool.description.clone().unwrap_or_default(),
                                "parameters": tool.input_schema.clone().unwrap_or(json!({}))
                            }
                        })
                    })
                    .collect();

                if !mcp_tool_values.is_empty() {
                    llm_context.insert("tools".into(), Value::Array(mcp_tool_values.clone()));
                    log::info!(
                        "[ChatV2::VariantPipeline] execute_single_variant: variant={} injected {} tools",
                        ctx.variant_id(),
                        mcp_tool_values.len()
                    );
                }
            }
        }

        // 调用 LLM
        // 🔧 P1修复：添加 Pipeline 层超时保护
        let llm_future = self.llm_manager.call_unified_model_2_stream(
            &llm_context,
            &messages,
            "",
            true,
            enable_thinking,
            Some("chat_v2_variant"),
            ctx.emitter().window(),
            &stream_event,
            None,
            disable_tools,
            max_input_tokens_override,
            options.model_id.clone(),
            options.temperature,
            Some(system_prompt),
            options.top_p,
            options.frequency_penalty,
            options.presence_penalty,
            options.max_tokens,
        );

        let call_result =
            match timeout(Duration::from_secs(LLM_STREAM_TIMEOUT_SECS), llm_future).await {
                Ok(result) => result,
                Err(_) => {
                    log::error!(
                        "[ChatV2::VariantPipeline] LLM stream call timeout after {}s, variant={}",
                        LLM_STREAM_TIMEOUT_SECS,
                        ctx.variant_id()
                    );
                    self.llm_manager
                        .unregister_stream_hooks(&stream_event)
                        .await;
                    ctx.fail(&format!(
                        "LLM stream call timed out after {}s",
                        LLM_STREAM_TIMEOUT_SECS
                    ));
                    return Err(ChatV2Error::Timeout(format!(
                        "LLM stream call timed out after {}s",
                        LLM_STREAM_TIMEOUT_SECS
                    )));
                }
            };

        // 注销 hooks
        self.llm_manager
            .unregister_stream_hooks(&stream_event)
            .await;

        // 处理结果
        match call_result {
            Ok(output) => {
                if output.cancelled {
                    ctx.cancel();
                } else {
                    ctx.complete();
                }
                Ok(())
            }
            Err(e) => {
                ctx.fail(&e.to_string());
                Err(ChatV2Error::Llm(e.to_string()))
            }
        }
    }

    async fn execute_single_variant_with_config(
        &self,
        ctx: Arc<super::variant_context::VariantExecutionContext>,
        config_id: String,
        mut options: SendOptions,
        user_content: String,
        session_id: String,
        shared_context: Arc<SharedContext>,
        attachments: Vec<AttachmentInput>,
    ) -> ChatV2Result<()> {
        const MAX_TOOL_ROUNDS: u32 = 10;

        options.model_id = Some(config_id.clone());
        options.model2_override_id = Some(config_id.clone());

        ctx.start_streaming();

        if ctx.is_cancelled() {
            ctx.cancel();
            return Ok(());
        }

        let system_prompt = self
            .build_system_prompt_with_shared_context(&options, &shared_context)
            .await;
        let mut chat_history = self.load_variant_chat_history(&session_id).await?;
        // 🆕 2026-02-22: 为已激活的默认技能自动注入合成 load_skills 工具交互
        inject_synthetic_load_skills(&mut chat_history, &options);
        let current_user_message = self.build_variant_user_message(&user_content, &attachments);

        let enable_thinking = options.enable_thinking.unwrap_or(true);
        let max_input_tokens_override = options.context_limit.map(|v| v as usize);
        let has_tools = options
            .mcp_tool_schemas
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let disable_tools = options.disable_tools.unwrap_or(false) || !has_tools;

        let mut messages = chat_history;
        messages.push(current_user_message);

        let adapter = Arc::new(VariantLLMAdapter::new(Arc::clone(&ctx), enable_thinking));
        let stream_event = format!("chat_v2_event_{}_{}", session_id, ctx.variant_id());
        self.llm_manager
            .register_stream_hooks(&stream_event, adapter.clone())
            .await;

        let mut llm_context: std::collections::HashMap<String, Value> =
            std::collections::HashMap::new();
        if let Some(ref rag_sources) = shared_context.rag_sources {
            llm_context.insert(
                "prefetched_rag_sources".into(),
                serde_json::to_value(rag_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref memory_sources) = shared_context.memory_sources {
            llm_context.insert(
                "prefetched_memory_sources".into(),
                serde_json::to_value(memory_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref graph_sources) = shared_context.graph_sources {
            llm_context.insert(
                "prefetched_graph_sources".into(),
                serde_json::to_value(graph_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref web_sources) = shared_context.web_search_sources {
            llm_context.insert(
                "prefetched_web_search_sources".into(),
                serde_json::to_value(web_sources).unwrap_or(Value::Null),
            );
        }

        // 🆕 图片压缩策略：从 options 获取或使用默认值
        let vq = options.vision_quality.as_deref().unwrap_or("auto");
        llm_context.insert("vision_quality".into(), Value::String(vq.to_string()));

        if !disable_tools {
            if let Some(ref tool_schemas) = options.mcp_tool_schemas {
                let mcp_tool_values: Vec<Value> = tool_schemas
                    .iter()
                    .map(|tool| {
                        let tool_name = if tool.name.starts_with(BUILTIN_NAMESPACE) {
                            tool.name.clone()
                        } else {
                            format!("mcp_{}", tool.name)
                        };
                        json!({
                            "type": "function",
                            "function": {
                                "name": tool_name,
                                "description": tool.description.clone().unwrap_or_default(),
                                "parameters": tool.input_schema.clone().unwrap_or(json!({}))
                            }
                        })
                    })
                    .collect();

                if !mcp_tool_values.is_empty() {
                    llm_context.insert("tools".into(), Value::Array(mcp_tool_values.clone()));
                    log::info!(
                        "[ChatV2::VariantPipeline] variant={} injected {} tools",
                        ctx.variant_id(),
                        mcp_tool_values.len()
                    );
                }
            }
        }

        let emitter_arc = ctx.emitter_arc();
        let canvas_note_id = options.canvas_note_id.clone();
        let skill_allowed_tools = options.skill_allowed_tools.clone();
        let skill_contents = options.skill_contents.clone();
        let active_skill_ids = options.active_skill_ids.clone();
        let variant_session_key = format!("{}:{}", session_id, ctx.variant_id());

        let mut tool_round = 0u32;
        loop {
            if ctx.is_cancelled() {
                ctx.cancel();
                break;
            }

            // 🔧 P1修复：添加 Pipeline 层超时保护
            let llm_future = self.llm_manager.call_unified_model_2_stream(
                &llm_context,
                &messages,
                "",
                true,
                enable_thinking,
                Some("chat_v2_variant"),
                ctx.emitter().window(),
                &stream_event,
                None,
                disable_tools,
                max_input_tokens_override,
                options.model_id.clone(),
                options.temperature,
                Some(system_prompt.clone()),
                options.top_p,
                options.frequency_penalty,
                options.presence_penalty,
                options.max_tokens,
            );

            // 使用 tokio::select! 支持取消（与单变体 pipeline 对齐）
            let call_result = tokio::select! {
                result = timeout(
                    Duration::from_secs(LLM_STREAM_TIMEOUT_SECS),
                    llm_future,
                ) => {
                    match result {
                        Ok(r) => Some(r),
                        Err(_) => {
                            log::error!(
                                "[ChatV2::VariantPipeline] LLM stream call timeout after {}s, variant={}, round={}",
                                LLM_STREAM_TIMEOUT_SECS,
                                ctx.variant_id(),
                                tool_round
                            );
                            self.llm_manager
                                .unregister_stream_hooks(&stream_event)
                                .await;
                            ctx.fail(&format!(
                                "LLM stream call timed out after {}s",
                                LLM_STREAM_TIMEOUT_SECS
                            ));
                            return Err(ChatV2Error::Timeout(format!(
                                "LLM stream call timed out after {}s",
                                LLM_STREAM_TIMEOUT_SECS
                            )));
                        }
                    }
                }
                _ = ctx.cancel_token().cancelled() => {
                    log::info!(
                        "[ChatV2::VariantPipeline] LLM call cancelled via token, variant={}, round={}",
                        ctx.variant_id(),
                        tool_round
                    );
                    // 同时通知 LLM 层停止 HTTP 流
                    self.llm_manager.request_cancel_stream(&stream_event).await;
                    None
                }
            };

            match call_result {
                None => {
                    // cancel_token 触发的取消
                    ctx.cancel();
                    break;
                }
                Some(Ok(output)) => {
                    if output.cancelled {
                        ctx.cancel();
                        break;
                    }
                }
                Some(Err(e)) => {
                    self.llm_manager
                        .unregister_stream_hooks(&stream_event)
                        .await;
                    ctx.fail(&e.to_string());
                    return Err(ChatV2Error::Llm(e.to_string()));
                }
            }

            let tool_calls = adapter.take_tool_calls();
            if tool_calls.is_empty() {
                adapter.finalize_all();
                ctx.complete();
                break;
            }

            log::info!(
                "[ChatV2::VariantPipeline] variant={} round={} has {} tool calls",
                ctx.variant_id(),
                tool_round,
                tool_calls.len()
            );

            let current_reasoning = adapter.get_accumulated_reasoning();
            adapter.finalize_all();
            ctx.set_pending_reasoning(current_reasoning.clone());

            // 🆕 取消支持：传递取消令牌给工具执行器
            let cancel_token = Some(ctx.cancel_token());
            let rag_top_k = options.rag_top_k;
            let rag_enable_reranking = options.rag_enable_reranking;
            let tool_results = self
                .execute_tool_calls(
                    &tool_calls,
                    &emitter_arc,
                    &variant_session_key,
                    ctx.message_id(),
                    &canvas_note_id,
                    &skill_allowed_tools,
                    &skill_contents,
                    &active_skill_ids,
                    cancel_token,
                    rag_top_k,
                    rag_enable_reranking,
                )
                .await?;

            let success_count = tool_results.iter().filter(|r| r.success).count();
            log::info!(
                "[ChatV2::VariantPipeline] variant={} tool execution: {}/{} succeeded",
                ctx.variant_id(),
                success_count,
                tool_results.len()
            );

            for tc in &tool_calls {
                let tool_call = crate::models::ToolCall {
                    id: tc.id.clone(),
                    tool_name: tc.name.clone(),
                    args_json: tc.arguments.clone(),
                };
                messages.push(LegacyChatMessage {
                    role: "assistant".to_string(),
                    content: String::new(),
                    timestamp: chrono::Utc::now(),
                    thinking_content: current_reasoning.clone(),
                    thought_signature: None,
                    rag_sources: None,
                    memory_sources: None,
                    graph_sources: None,
                    web_search_sources: None,
                    image_paths: None,
                    image_base64: None,
                    doc_attachments: None,
                    multimodal_content: None,
                    tool_call: Some(tool_call),
                    tool_result: None,
                    overrides: None,
                    relations: None,
                    persistent_stable_id: None,
                    metadata: None,
                });
            }

            for result in &tool_results {
                let result_content = if result.success {
                    serde_json::to_string(&result.output).unwrap_or_else(|_| "{}".to_string())
                } else {
                    format!(
                        "Error: {}",
                        result.error.as_deref().unwrap_or("Unknown error")
                    )
                };

                let tool_result = crate::models::ToolResult {
                    call_id: result.tool_call_id.clone().unwrap_or_default(),
                    ok: result.success,
                    error: result.error.clone(),
                    error_details: None,
                    data_json: Some(result.output.clone()),
                    usage: None,
                    citations: None,
                };
                messages.push(LegacyChatMessage {
                    role: "tool".to_string(),
                    content: result_content,
                    timestamp: chrono::Utc::now(),
                    thinking_content: None,
                    thought_signature: None,
                    rag_sources: None,
                    memory_sources: None,
                    graph_sources: None,
                    web_search_sources: None,
                    image_paths: None,
                    image_base64: None,
                    doc_attachments: None,
                    multimodal_content: None,
                    tool_call: None,
                    tool_result: Some(tool_result),
                    overrides: None,
                    relations: None,
                    persistent_stable_id: None,
                    metadata: None,
                });

                ctx.add_tool_result(result.clone());
            }

            let task_completed = tool_results.iter().any(|r| {
                r.output
                    .get("task_completed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            });
            if task_completed {
                log::info!(
                    "[ChatV2::VariantPipeline] variant={} task_completed detected, stopping",
                    ctx.variant_id()
                );
                ctx.complete();
                break;
            }

            tool_round += 1;
            ctx.increment_tool_round();

            if tool_round >= MAX_TOOL_ROUNDS {
                log::warn!(
                    "[ChatV2::VariantPipeline] variant={} reached max tool rounds ({})",
                    ctx.variant_id(),
                    MAX_TOOL_ROUNDS
                );
                ctx.complete();
                break;
            }

            adapter.reset_for_new_round();
        }

        self.llm_manager
            .unregister_stream_hooks(&stream_event)
            .await;
        Ok(())
    }

    /// 共享检索阶段（已废弃预调用模式）
    ///
    /// 🔧 2026-01-11 重构：彻底移除预调用检索，完全采用工具化模式
    ///
    /// 原预调用模式（已废弃）：
    /// - 在多变体 LLM 调用前执行 RAG/图谱/记忆/网络搜索
    /// - 结果注入到共享的系统提示中
    ///
    /// 新工具化模式（当前）：
    /// - 检索工具作为 MCP 工具注入到 LLM
    /// - 每个变体的 LLM 根据用户问题主动决定是否调用检索工具
    /// - 多变体模式下，每个变体独立调用检索（按需）
    ///
    /// ## 参数
    /// - `request`: 发送消息请求
    /// - `_emitter`: 事件发射器（不再使用）
    /// - `_message_id`: 消息 ID（不再使用）
    ///
    /// ## 返回
    /// 空的 SharedContext（工具化模式下由 LLM 按需调用检索）
    #[allow(unused_variables)]
    async fn execute_shared_retrievals(
        &self,
        request: &SendMessageRequest,
        _emitter: &Arc<ChatV2EventEmitter>,
        _message_id: &str,
    ) -> ChatV2Result<SharedContext> {
        // 🔧 工具化模式：跳过所有预调用检索
        // 多变体模式下，每个变体的 LLM 可独立通过 tool_calls 调用内置检索工具
        log::info!(
            "[ChatV2::pipeline] Tool-based retrieval mode (multi-variant): skipping shared pre-call retrievals for session={}",
            request.session_id
        );
        Ok(SharedContext::default())
    }

    /// 构建带共享上下文的系统提示
    ///
    /// 使用 prompt_builder 模块统一格式化，用于多变体并行执行场景，
    /// 共享检索结果注入到所有变体的 system prompt 中。
    /// 如果有 Canvas 笔记，也会一并注入。
    async fn build_system_prompt_with_shared_context(
        &self,
        options: &SendOptions,
        shared_context: &SharedContext,
    ) -> String {
        // 构建 Canvas 笔记信息（如果有）
        let canvas_note = self.build_canvas_note_info_from_options(options).await;
        prompt_builder::build_system_prompt_with_shared_context(
            options,
            shared_context,
            canvas_note,
        )
    }

    /// 根据 SendOptions 构建 Canvas 笔记信息
    async fn build_canvas_note_info_from_options(
        &self,
        options: &SendOptions,
    ) -> Option<prompt_builder::CanvasNoteInfo> {
        let note_id = options.canvas_note_id.as_ref()?;
        let notes_mgr = self.notes_manager.as_ref()?;
        match notes_mgr.get_note(note_id) {
            Ok(note) => {
                let word_count = note.content_md.chars().count();
                log::info!(
                    "[ChatV2::pipeline] Canvas mode (variant): loaded note '{}' ({} chars, is_long={})",
                    note.title,
                    word_count,
                    word_count >= 3000
                );
                Some(prompt_builder::CanvasNoteInfo::new(
                    note_id.clone(),
                    note.title,
                    note.content_md,
                ))
            }
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] Canvas mode (variant): failed to read note {}: {}",
                    note_id,
                    e
                );
                None
            }
        }
    }

    /// 加载变体的聊天历史（V2 增强版）
    ///
    /// 对齐单变体 `load_chat_history()` 的完整能力：
    /// - 使用 DEFAULT_MAX_HISTORY_MESSAGES 限制消息数
    /// - 提取所有 content 块并拼接（不只是第一个）
    /// - 提取 thinking 块内容
    /// - 提取 mcp_tool 块的工具调用信息
    /// - 解析 context_snapshot（如果有 vfs_db 连接）
    /// - 从附件中提取图片 base64 和文档附件
    async fn load_variant_chat_history(
        &self,
        session_id: &str,
    ) -> ChatV2Result<Vec<LegacyChatMessage>> {
        log::debug!(
            "[ChatV2::pipeline] Loading variant chat history for session={}",
            session_id
        );

        let conn = self.db.get_conn_safe()?;

        // 🆕 获取 VFS 数据库连接（用于解析历史消息中的 context_snapshot）
        let vfs_conn_opt = self.vfs_db.as_ref().and_then(|vfs_db| {
            match vfs_db.get_conn_safe() {
                Ok(vfs_conn) => Some(vfs_conn),
                Err(e) => {
                    log::warn!("[ChatV2::pipeline] Failed to get vfs.db connection for variant history context_snapshot: {}", e);
                    None
                }
            }
        });
        let vfs_blobs_dir = self
            .vfs_db
            .as_ref()
            .map(|vfs_db| vfs_db.blobs_dir().to_path_buf());

        let messages = ChatV2Repo::get_session_messages_with_conn(&conn, session_id)?;

        if messages.is_empty() {
            log::debug!(
                "[ChatV2::pipeline] No variant chat history found for session={}",
                session_id
            );
            return Ok(Vec::new());
        }

        // 🔧 使用固定的消息条数限制（对齐单变体）
        let max_messages = DEFAULT_MAX_HISTORY_MESSAGES;
        let messages_to_load: Vec<_> = if messages.len() > max_messages {
            // 取最新的 max_messages 条消息
            messages
                .into_iter()
                .rev()
                .take(max_messages)
                .rev()
                .collect()
        } else {
            messages
        };

        log::debug!(
            "[ChatV2::pipeline] Loading {} variant messages (max_messages={})",
            messages_to_load.len(),
            max_messages
        );

        let mut chat_history = Vec::new();
        for message in messages_to_load {
            let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &message.id)?;

            // 🔧 提取所有 content 类型块的内容并拼接（不只是第一个）
            let content: String = blocks
                .iter()
                .filter(|b| b.block_type == block_types::CONTENT)
                .filter_map(|b| b.content.as_ref())
                .cloned()
                .collect::<Vec<_>>()
                .join("");

            // 🆕 提取 thinking 类型块的内容（如果有）
            let thinking_content: Option<String> = {
                let thinking: String = blocks
                    .iter()
                    .filter(|b| b.block_type == block_types::THINKING)
                    .filter_map(|b| b.content.as_ref())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("");
                if thinking.is_empty() {
                    None
                } else {
                    Some(thinking)
                }
            };

            // 🆕 提取 mcp_tool 类型块的工具调用信息（按 block_index 排序）
            let mut tool_blocks: Vec<_> = blocks
                .iter()
                .filter(|b| b.block_type == block_types::MCP_TOOL)
                .collect();
            tool_blocks.sort_by_key(|b| b.block_index);

            // 🆕 对于用户消息，解析 context_snapshot.user_refs 并将内容追加到 content
            let (content, vfs_image_base64) = if message.role == MessageRole::User {
                if let (Some(ref vfs_conn), Some(ref blobs_dir)) = (&vfs_conn_opt, &vfs_blobs_dir) {
                    self.resolve_history_context_snapshot_v2(
                        &content,
                        &message,
                        &**vfs_conn,
                        blobs_dir,
                    )
                } else {
                    (content, Vec::new())
                }
            } else {
                (content, Vec::new())
            };

            let role = match message.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
            };

            // 🆕 如果是 assistant 消息且有工具调用，先添加工具调用消息
            if role == "assistant" && !tool_blocks.is_empty() {
                for (idx, tool_block) in tool_blocks.iter().enumerate() {
                    // 生成 tool_call_id（使用块 ID 或生成新的）
                    let tool_call_id = format!("tc_{}", tool_block.id.replace("blk_", ""));

                    // 提取工具名称和输入
                    let tool_name = tool_block.tool_name.clone().unwrap_or_default();
                    let tool_input = tool_block
                        .tool_input
                        .clone()
                        .unwrap_or(serde_json::Value::Null);
                    let tool_output = tool_block
                        .tool_output
                        .clone()
                        .unwrap_or(serde_json::Value::Null);
                    let tool_success = tool_block.status == block_status::SUCCESS;
                    let tool_error = tool_block.error.clone();

                    // 1. 添加 assistant 消息（包含 tool_call）
                    let tool_call = crate::models::ToolCall {
                        id: tool_call_id.clone(),
                        tool_name: tool_name.clone(),
                        args_json: tool_input,
                    };
                    let assistant_tool_msg = LegacyChatMessage {
                        role: "assistant".to_string(),
                        content: String::new(),
                        timestamp: chrono::Utc::now(),
                        thinking_content: None,
                        thought_signature: None,
                        rag_sources: None,
                        memory_sources: None,
                        graph_sources: None,
                        web_search_sources: None,
                        image_paths: None,
                        image_base64: None,
                        doc_attachments: None,
                        multimodal_content: None,
                        tool_call: Some(tool_call),
                        tool_result: None,
                        overrides: None,
                        relations: None,
                        persistent_stable_id: None,
                        metadata: None,
                    };
                    chat_history.push(assistant_tool_msg);

                    // 2. 添加 tool 消息（包含 tool_result）
                    let tool_result = crate::models::ToolResult {
                        call_id: tool_call_id,
                        ok: tool_success,
                        error: tool_error,
                        error_details: None,
                        data_json: Some(tool_output.clone()),
                        usage: None,
                        citations: None,
                    };
                    let tool_msg = LegacyChatMessage {
                        role: "tool".to_string(),
                        content: serde_json::to_string(&tool_output).unwrap_or_default(),
                        timestamp: chrono::Utc::now(),
                        thinking_content: None,
                        thought_signature: None,
                        rag_sources: None,
                        memory_sources: None,
                        graph_sources: None,
                        web_search_sources: None,
                        image_paths: None,
                        image_base64: None,
                        doc_attachments: None,
                        multimodal_content: None,
                        tool_call: None,
                        tool_result: Some(tool_result),
                        overrides: None,
                        relations: None,
                        persistent_stable_id: None,
                        metadata: None,
                    };
                    chat_history.push(tool_msg);

                    log::debug!(
                        "[ChatV2::pipeline] Loaded variant tool call from history: tool={}, block_id={}, index={}",
                        tool_name,
                        tool_block.id,
                        idx
                    );
                }
            }

            // 跳过空内容消息（但工具调用消息已经添加）
            if content.is_empty() {
                continue;
            }

            // 🆕 从附件中提取图片 base64（仅用户消息有附件）
            // 合并旧附件图片和 VFS 图片
            let mut all_images: Vec<String> = message
                .attachments
                .as_ref()
                .map(|attachments| {
                    attachments
                        .iter()
                        .filter(|a| a.r#type == "image")
                        .filter_map(|a| {
                            // preview_url 格式为 "data:image/xxx;base64,{base64_content}"
                            a.preview_url
                                .as_ref()
                                .and_then(|url| url.split(',').nth(1).map(|s| s.to_string()))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            // 追加从 VFS context_snapshot 解析的图片
            all_images.extend(vfs_image_base64);

            let image_base64: Option<Vec<String>> = if all_images.is_empty() {
                None
            } else {
                Some(all_images)
            };

            // 🆕 从附件中提取文档附件（同时支持文本和二进制文档）
            let doc_attachments: Option<Vec<crate::models::DocumentAttachment>> = message.attachments
                .as_ref()
                .map(|attachments| {
                    attachments.iter()
                        .filter(|a| a.r#type == "document")
                        .map(|a| {
                            // 判断是否为文本类型
                            let is_text_type = a.mime_type.starts_with("text/") ||
                                               a.mime_type == "application/json" ||
                                               a.mime_type == "application/xml" ||
                                               a.mime_type == "application/javascript";

                            let mut text_content: Option<String> = None;
                            let mut base64_content: Option<String> = None;

                            // 从 preview_url 提取内容
                            if let Some(ref url) = a.preview_url {
                                if url.starts_with("data:") {
                                    if let Some(data_part) = url.split(',').nth(1) {
                                        if is_text_type {
                                            // 文本类型：解码 base64 为文本
                                            use base64::Engine;
                                            text_content = base64::engine::general_purpose::STANDARD
                                                .decode(data_part)
                                                .ok()
                                                .and_then(|bytes| String::from_utf8(bytes).ok());
                                        } else {
                                            // 二进制类型（如 docx/PDF）：先保存 base64
                                            base64_content = Some(data_part.to_string());

                                            // 尝试使用 DocumentParser 解析二进制文档
                                            let parser = crate::document_parser::DocumentParser::new();
                                            match parser.extract_text_from_base64(&a.name, data_part) {
                                                Ok(text) => {
                                                    log::debug!("[ChatV2::pipeline] Extracted {} chars from variant history document: {}", text.len(), a.name);
                                                    text_content = Some(text);
                                                }
                                                Err(e) => {
                                                    log::debug!("[ChatV2::pipeline] Could not parse variant history document {}: {}", a.name, e);
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            crate::models::DocumentAttachment {
                                name: a.name.clone(),
                                mime_type: a.mime_type.clone(),
                                size_bytes: a.size as usize,
                                text_content,
                                base64_content,
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .filter(|v| !v.is_empty());

            let legacy_message = LegacyChatMessage {
                role: role.to_string(),
                content: content.clone(),
                timestamp: chrono::Utc::now(),
                thinking_content,
                thought_signature: None,
                rag_sources: None,
                memory_sources: None,
                graph_sources: None,
                web_search_sources: None,
                image_paths: None,
                image_base64,
                doc_attachments,
                multimodal_content: None,
                tool_call: None,
                tool_result: None,
                overrides: None,
                relations: None,
                persistent_stable_id: message.persistent_stable_id.clone(),
                metadata: None,
            };

            chat_history.push(legacy_message);
        }

        log::info!(
            "[ChatV2::pipeline] Loaded {} variant messages from history for session={}",
            chat_history.len(),
            session_id
        );

        // 🆕 验证工具调用链完整性
        validate_tool_chain(&chat_history);

        Ok(chat_history)
    }

    /// 构建变体用户消息
    fn build_variant_user_message(
        &self,
        user_content: &str,
        attachments: &[AttachmentInput],
    ) -> LegacyChatMessage {
        let image_base64: Option<Vec<String>> = {
            let images: Vec<String> = attachments
                .iter()
                .filter(|a| a.mime_type.starts_with("image/"))
                .filter_map(|a| a.base64_content.clone())
                .collect();
            if images.is_empty() {
                None
            } else {
                Some(images)
            }
        };

        let doc_attachments: Option<Vec<crate::models::DocumentAttachment>> = {
            let docs: Vec<crate::models::DocumentAttachment> = attachments
                .iter()
                .filter(|a| {
                    !a.mime_type.starts_with("image/")
                        && !a.mime_type.starts_with("audio/")
                        && !a.mime_type.starts_with("video/")
                })
                .map(|a| {
                    // 🔧 P0修复：如果没有 text_content 但有 base64_content，尝试使用 DocumentParser 解析
                    let text_content = if a.text_content.is_some() {
                        a.text_content.clone()
                    } else if let Some(ref base64) = a.base64_content {
                        // 尝试使用 DocumentParser 解析二进制文档（docx/pdf 等）
                        let parser = crate::document_parser::DocumentParser::new();
                        match parser.extract_text_from_base64(&a.name, base64) {
                            Ok(text) => {
                                log::info!(
                                    "[ChatV2::pipeline] Extracted {} chars from document: {}",
                                    text.len(),
                                    a.name
                                );
                                Some(text)
                            }
                            Err(e) => {
                                log::warn!(
                                    "[ChatV2::pipeline] Failed to parse document {}: {}",
                                    a.name,
                                    e
                                );
                                None
                            }
                        }
                    } else {
                        None
                    };

                    crate::models::DocumentAttachment {
                        name: a.name.clone(),
                        mime_type: a.mime_type.clone(),
                        size_bytes: a
                            .base64_content
                            .as_ref()
                            .map(|c| (c.len() * 3) / 4)
                            .unwrap_or(0),
                        text_content,
                        base64_content: a.base64_content.clone(),
                    }
                })
                .collect();
            if docs.is_empty() {
                None
            } else {
                Some(docs)
            }
        };

        LegacyChatMessage {
            role: "user".to_string(),
            content: user_content.to_string(),
            timestamp: chrono::Utc::now(),
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64,
            doc_attachments,
            multimodal_content: None,
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: None,
            persistent_stable_id: None,
            metadata: None,
        }
    }

    /// 执行批量变体重试
    ///
    /// 复用原有 SharedContext，并行执行多个变体的重试。
    /// 使用单一事件发射器以保证序列号全局递增。
    pub async fn execute_variants_retry_batch(
        &self,
        window: Window,
        session_id: String,
        message_id: String,
        variants: Vec<VariantRetrySpec>,
        user_content: String,
        user_attachments: Vec<AttachmentInput>,
        shared_context: SharedContext,
        options: SendOptions,
        cancel_token: CancellationToken,
        chat_v2_state: Option<Arc<super::state::ChatV2State>>,
    ) -> ChatV2Result<()> {
        use super::variant_context::{ParallelExecutionManager, VariantExecutionContext};
        use futures::future::join_all;

        log::info!(
            "[ChatV2::pipeline] execute_variants_retry_batch: session={}, message={}, variants={}",
            session_id,
            message_id,
            variants.len()
        );

        if variants.is_empty() {
            return Err(ChatV2Error::Validation(
                "No variant IDs provided for batch retry".to_string(),
            ));
        }

        // 单一事件发射器，确保 sequenceId 全局递增
        let emitter = Arc::new(super::events::ChatV2EventEmitter::new(
            window.clone(),
            session_id.clone(),
        ));

        let shared_context_arc = Arc::new(shared_context);

        // 创建并行执行管理器（多变体重试）
        let manager = ParallelExecutionManager::with_cancel_token(cancel_token.clone());

        let mut variant_contexts: Vec<(Arc<VariantExecutionContext>, String)> =
            Vec::with_capacity(variants.len());

        for spec in &variants {
            let ctx = manager.create_variant(
                spec.variant_id.clone(),
                spec.model_id.clone(),
                message_id.clone(),
                Arc::clone(&shared_context_arc),
                Arc::clone(&emitter),
            );
            ctx.set_config_id(spec.config_id.clone());

            // 注册每个变体的 cancel token（用于按 variant 取消）
            if let Some(ref state) = chat_v2_state {
                let cancel_key = format!("{}:{}", session_id, spec.variant_id);
                state.register_existing_token(&cancel_key, ctx.cancel_token().clone());
                log::debug!(
                    "[ChatV2::pipeline] Registered cancel token for retry variant: {}",
                    cancel_key
                );
            }

            variant_contexts.push((ctx, spec.config_id.clone()));
        }

        // 🔧 P1修复：并行执行所有变体（使用任务追踪器）
        let self_clone = self.clone();
        let options_arc = Arc::new(options.clone());
        let user_content_arc = Arc::new(user_content.clone());
        let session_id_arc = Arc::new(session_id.clone());
        let attachments_arc = Arc::new(user_attachments.clone());

        let futures: Vec<_> = variant_contexts
            .iter()
            .map(|(ctx, config_id)| {
                let self_ref = self_clone.clone();
                let ctx_clone = Arc::clone(ctx);
                let config_id_clone = config_id.clone();
                let options_clone = Arc::clone(&options_arc);
                let user_content_clone = Arc::clone(&user_content_arc);
                let session_id_clone = Arc::clone(&session_id_arc);
                let attachments_clone = Arc::clone(&attachments_arc);
                let shared_ctx = Arc::clone(&shared_context_arc);
                let state_clone = chat_v2_state.clone();

                let future = async move {
                    self_ref
                        .execute_single_variant_with_config(
                            ctx_clone,
                            config_id_clone,
                            (*options_clone).clone(),
                            (*user_content_clone).clone(),
                            (*session_id_clone).clone(),
                            shared_ctx,
                            (*attachments_clone).clone(),
                        )
                        .await
                };

                // 🔧 P1修复：优先使用 spawn_tracked 追踪任务
                if let Some(ref state) = state_clone {
                    state.spawn_tracked(future)
                } else {
                    log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for retry variant task");
                    tokio::spawn(future)
                }
            })
            .collect();

        let results = join_all(futures).await;

        for (i, result) in results.into_iter().enumerate() {
            let (ctx, _) = &variant_contexts[i];
            match result {
                Ok(Ok(())) => {
                    log::info!(
                        "[ChatV2::pipeline] Retry variant {} completed successfully",
                        ctx.variant_id()
                    );
                }
                Ok(Err(e)) => {
                    log::error!(
                        "[ChatV2::pipeline] Retry variant {} failed: {}",
                        ctx.variant_id(),
                        e
                    );
                    // 错误已在 execute_single_variant_with_config 中处理
                }
                Err(e) => {
                    log::error!(
                        "[ChatV2::pipeline] Retry variant {} task panicked: {}",
                        ctx.variant_id(),
                        e
                    );
                    ctx.fail(&format!("Task panicked: {}", e));
                }
            }
        }

        // 持久化每个变体
        let mut update_error: Option<ChatV2Error> = None;
        for (ctx, _) in &variant_contexts {
            if let Err(e) = self.update_variant_after_retry(&message_id, ctx).await {
                log::error!(
                    "[ChatV2::pipeline] Failed to update retry variant {}: {}",
                    ctx.variant_id(),
                    e
                );
                if update_error.is_none() {
                    update_error = Some(e);
                }
            }
        }

        // 清理 cancel token
        if let Some(ref state) = chat_v2_state {
            for (ctx, _) in &variant_contexts {
                let cancel_key = format!("{}:{}", session_id, ctx.variant_id());
                state.remove_stream(&cancel_key);
            }
        }

        if let Some(err) = update_error {
            return Err(err);
        }

        Ok(())
    }

    /// 执行变体重试
    ///
    /// 重新执行指定变体的 LLM 调用，复用原有的 SharedContext（检索结果）。
    ///
    /// ## 参数
    /// - `window`: Tauri 窗口，用于事件发射
    /// - `session_id`: 会话 ID
    /// - `message_id`: 助手消息 ID
    /// - `variant_id`: 要重试的变体 ID
    /// - `model_id`: 模型 ID（可能已被 model_override 覆盖）
    /// - `user_content`: 原始用户消息内容
    /// - `user_attachments`: 原始用户附件
    /// - `shared_context`: 共享上下文（检索结果，从原消息恢复）
    /// - `options`: 发送选项
    /// - `cancel_token`: 取消令牌
    ///
    /// ## 返回
    /// 成功完成后返回 Ok(())
    pub async fn execute_variant_retry(
        &self,
        window: Window,
        session_id: String,
        message_id: String,
        variant_id: String,
        model_id: String,
        user_content: String,
        user_attachments: Vec<AttachmentInput>,
        shared_context: SharedContext,
        options: SendOptions,
        cancel_token: CancellationToken,
    ) -> ChatV2Result<()> {
        log::info!(
            "[ChatV2::pipeline] execute_variant_retry: session={}, message={}, variant={}, model={}",
            session_id,
            message_id,
            variant_id,
            model_id
        );

        // 创建事件发射器
        let emitter = Arc::new(super::events::ChatV2EventEmitter::new(
            window.clone(),
            session_id.clone(),
        ));

        // 创建共享上下文的 Arc
        let shared_context_arc = Arc::new(shared_context);

        // 🔧 P1-4 修复：将 config_id 解析为模型显示名称
        // model_id 可能是 API 配置 UUID（如 "builtin-siliconflow"），需要解析为显示名称（如 "Qwen/Qwen3-8B"）
        // 用于 variant_start 事件和 variant.model_id 存储，确保前端能正确显示供应商图标
        let display_model_id = match self.llm_manager.get_api_configs().await {
            Ok(configs) => {
                configs
                    .iter()
                    .find(|c| c.id == model_id)
                    .map(|c| c.model.clone())
                    .or_else(|| {
                        // 通过 model 名称匹配（config_id 本身可能就是模型名）
                        configs.iter().find(|c| c.model == model_id).map(|c| c.model.clone())
                    })
                    .unwrap_or_else(|| {
                        // 无法从 configs 解析时，判断是否为配置 ID 格式
                        if is_config_id_format(&model_id) {
                            log::warn!(
                                "[ChatV2::pipeline] variant retry: config_id is not a display name: {}",
                                model_id
                            );
                            // 回退到空字符串，前端会显示 generic 图标
                            // 优于显示无法识别的 UUID
                            String::new()
                        } else {
                            model_id.clone()
                        }
                    })
            }
            Err(_) => model_id.clone(),
        };

        // 创建并行执行管理器（单变体）
        let manager = super::variant_context::ParallelExecutionManager::with_cancel_token(
            cancel_token.clone(),
        );

        // 创建变体执行上下文（使用已有的 variant_id）
        // 使用 display_model_id 作为变体的模型标识（用于前端图标显示）
        let ctx = manager.create_variant(
            variant_id.clone(),
            display_model_id,
            message_id.clone(),
            Arc::clone(&shared_context_arc),
            Arc::clone(&emitter),
        );

        // 执行变体（使用完整工具循环路径，与多变体主流程保持一致）
        // 注意：model_id（原始 config_id）传递给 execute_single_variant_with_config 用于 LLM 调用
        let result = self
            .execute_single_variant_with_config(
                ctx.clone(),
                model_id.clone(),
                options,
                user_content,
                session_id.clone(),
                shared_context_arc,
                user_attachments,
            )
            .await;

        // 处理结果并更新变体状态
        // 🔧 P0修复：无论成功还是失败，都需要持久化变体状态
        match result {
            Ok(()) => {
                // 更新变体在数据库中的状态和内容
                self.update_variant_after_retry(&message_id, &ctx).await?;
                log::info!(
                    "[ChatV2::pipeline] Variant retry completed: variant={}, status={}",
                    variant_id,
                    ctx.status()
                );
                Ok(())
            }
            Err(e) => {
                log::error!(
                    "[ChatV2::pipeline] Variant retry failed: variant={}, error={}",
                    variant_id,
                    e
                );
                // 🔧 P0修复：失败时也需要更新变体状态到数据库
                // ctx.status() 在 execute_single_variant 失败时会被设置为 ERROR 或 CANCELLED
                if let Err(update_err) = self.update_variant_after_retry(&message_id, &ctx).await {
                    log::error!(
                        "[ChatV2::pipeline] Failed to update variant status after error: {}",
                        update_err
                    );
                }
                Err(e)
            }
        }
    }

    /// 更新重试后的变体
    ///
    /// 更新变体状态、块内容等到数据库
    async fn update_variant_after_retry(
        &self,
        message_id: &str,
        ctx: &Arc<super::variant_context::VariantExecutionContext>,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 获取消息
        let mut message = ChatV2Repo::get_message_with_conn(&conn, message_id)?
            .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

        // 更新变体状态
        if let Some(ref mut variants) = message.variants {
            if let Some(variant) = variants.iter_mut().find(|v| v.id == ctx.variant_id()) {
                variant.status = ctx.status();
                variant.error = ctx.error();
                variant.block_ids = ctx.block_ids();
                let usage = ctx.get_usage();
                variant.usage = if usage.total_tokens > 0 {
                    Some(usage)
                } else {
                    None
                };
            }
        }

        // 🔧 优化：重试成功后自动设为激活变体
        if ctx.status() == variant_status::SUCCESS {
            message.active_variant_id = Some(ctx.variant_id().to_string());
            log::info!(
                "[ChatV2::pipeline] Auto-activated successful retry variant: {}",
                ctx.variant_id()
            );
        }

        // 保存 thinking 块（如果有）
        if let Some(thinking_block_id) = ctx.get_thinking_block_id() {
            let thinking_content = ctx.get_accumulated_reasoning();
            let thinking_block = MessageBlock {
                id: thinking_block_id.clone(),
                message_id: message_id.to_string(),
                block_type: block_types::THINKING.to_string(),
                status: block_status::SUCCESS.to_string(),
                content: thinking_content,
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                // 🔧 P3修复：使用 first_chunk_at 作为 started_at（真正的开始时间）
                started_at: ctx.get_thinking_first_chunk_at().or(Some(now_ms)),
                ended_at: Some(now_ms),
                // 🔧 使用 VariantContext 记录的 first_chunk_at 时间戳
                first_chunk_at: ctx.get_thinking_first_chunk_at(),
                block_index: 0,
            };
            ChatV2Repo::create_block_with_conn(&conn, &thinking_block)?;

            // 添加到消息的 block_ids
            if !message.block_ids.contains(&thinking_block_id) {
                message.block_ids.push(thinking_block_id);
            }
        }

        // 保存 content 块
        if let Some(content_block_id) = ctx.get_content_block_id() {
            let content = ctx.get_accumulated_content();
            let content_block = MessageBlock {
                id: content_block_id.clone(),
                message_id: message_id.to_string(),
                block_type: block_types::CONTENT.to_string(),
                // 🔧 P1修复：正确处理 CANCELLED 状态
                status: match ctx.status().as_str() {
                    s if s == variant_status::SUCCESS => block_status::SUCCESS.to_string(),
                    s if s == variant_status::ERROR => block_status::ERROR.to_string(),
                    s if s == variant_status::CANCELLED => block_status::SUCCESS.to_string(), // cancelled 但有内容，标记为 success
                    _ => block_status::RUNNING.to_string(),
                },
                content: if content.is_empty() {
                    None
                } else {
                    Some(content)
                },
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: ctx.error(),
                // 🔧 P3修复：使用 first_chunk_at 作为 started_at（真正的开始时间）
                started_at: ctx.get_content_first_chunk_at().or(Some(now_ms)),
                ended_at: Some(now_ms),
                // 🔧 使用 VariantContext 记录的 first_chunk_at 时间戳
                first_chunk_at: ctx.get_content_first_chunk_at(),
                block_index: 1, // content 在 thinking 之后
            };
            ChatV2Repo::create_block_with_conn(&conn, &content_block)?;

            // 添加到消息的 block_ids
            if !message.block_ids.contains(&content_block_id) {
                message.block_ids.push(content_block_id);
            }
        }

        // 更新消息
        ChatV2Repo::update_message_with_conn(&conn, &message)?;

        log::debug!(
            "[ChatV2::pipeline] Updated variant after retry: variant={}, blocks={}",
            ctx.variant_id(),
            ctx.block_ids().len()
        );

        Ok(())
    }

    /// 保存多变体结果
    ///
    /// 从每个 VariantExecutionContext 获取累积的内容，创建块并保存。
    ///
    /// ## 统一上下文注入系统支持
    /// - `context_snapshot`: 上下文快照（只存 ContextRef）
    async fn save_multi_variant_results(
        &self,
        session_id: &str,
        user_message_id: &str,
        assistant_message_id: &str,
        user_content: &str,
        attachments: &[AttachmentInput],
        options: &SendOptions,
        shared_context: &SharedContext,
        variant_contexts: &[Arc<super::variant_context::VariantExecutionContext>],
        active_variant_id: Option<&str>,
        context_snapshot: Option<ContextSnapshot>,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // === 1. 保存用户消息 ===
        // 🆕 使用统一的用户消息构建器，确保所有路径的一致性
        let mut user_msg_params =
            UserMessageParams::new(session_id.to_string(), user_content.to_string())
                .with_id(user_message_id.to_string())
                .with_attachments(attachments.to_vec())
                .with_timestamp(now_ms);

        if let Some(snapshot) = context_snapshot.clone() {
            user_msg_params = user_msg_params.with_context_snapshot(snapshot);
        }

        let user_msg_result = build_user_message(user_msg_params);

        ChatV2Repo::create_message_with_conn(&conn, &user_msg_result.message)?;
        ChatV2Repo::create_block_with_conn(&conn, &user_msg_result.block)?;

        // === 2. 🔧 P1修复：保存检索块 ===
        let mut all_block_ids: Vec<String> = Vec::new();
        let mut pending_blocks: Vec<MessageBlock> = Vec::new();
        let mut block_index_counter = 0;

        // 2.1 保存 RAG 检索块
        if let Some(ref block_id) = shared_context.rag_block_id {
            if shared_context
                .rag_sources
                .as_ref()
                .map_or(false, |v| !v.is_empty())
            {
                let rag_block = MessageBlock {
                    id: block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::RAG.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: None,
                    tool_name: None,
                    tool_input: None,
                    tool_output: Some(json!({ "sources": shared_context.rag_sources })),
                    citations: None,
                    error: None,
                    started_at: Some(now_ms),
                    ended_at: Some(now_ms),
                    // 🔧 检索块使用 now_ms 作为 first_chunk_at
                    first_chunk_at: Some(now_ms),
                    block_index: block_index_counter,
                };
                pending_blocks.push(rag_block);
                all_block_ids.push(block_id.clone());
                block_index_counter += 1;
            }
        }

        // 2.2 保存 Memory 检索块
        if let Some(ref block_id) = shared_context.memory_block_id {
            if shared_context
                .memory_sources
                .as_ref()
                .map_or(false, |v| !v.is_empty())
            {
                let memory_block = MessageBlock {
                    id: block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::MEMORY.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: None,
                    tool_name: None,
                    tool_input: None,
                    tool_output: Some(json!({ "sources": shared_context.memory_sources })),
                    citations: None,
                    error: None,
                    started_at: Some(now_ms),
                    ended_at: Some(now_ms),
                    // 🔧 检索块使用 now_ms 作为 first_chunk_at
                    first_chunk_at: Some(now_ms),
                    block_index: block_index_counter,
                };
                pending_blocks.push(memory_block);
                all_block_ids.push(block_id.clone());
                block_index_counter += 1;
            }
        }

        // 2.4 保存 Web 搜索检索块
        if let Some(ref block_id) = shared_context.web_search_block_id {
            if shared_context
                .web_search_sources
                .as_ref()
                .map_or(false, |v| !v.is_empty())
            {
                let web_block = MessageBlock {
                    id: block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::WEB_SEARCH.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: None,
                    tool_name: None,
                    tool_input: None,
                    tool_output: Some(json!({ "sources": shared_context.web_search_sources })),
                    citations: None,
                    error: None,
                    started_at: Some(now_ms),
                    ended_at: Some(now_ms),
                    // 🔧 检索块使用 now_ms 作为 first_chunk_at
                    first_chunk_at: Some(now_ms),
                    block_index: block_index_counter,
                };
                pending_blocks.push(web_block);
                all_block_ids.push(block_id.clone());
                block_index_counter += 1;
            }
        }

        log::debug!(
            "[ChatV2::pipeline] Multi-variant retrieval blocks saved: {} blocks",
            block_index_counter
        );

        // === 3. 收集所有变体块信息 ===
        let mut variants: Vec<Variant> = Vec::with_capacity(variant_contexts.len());

        for ctx in variant_contexts {
            let mut block_index = 0;

            // 保存 thinking 块（如果有）
            if let Some(thinking_block_id) = ctx.get_thinking_block_id() {
                let thinking_content = ctx.get_accumulated_reasoning();
                let thinking_block = MessageBlock {
                    id: thinking_block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::THINKING.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: thinking_content,
                    tool_name: None,
                    tool_input: None,
                    tool_output: None,
                    citations: None,
                    error: None,
                    // 🔧 P3修复：使用 first_chunk_at 作为 started_at（真正的开始时间）
                    started_at: ctx.get_thinking_first_chunk_at().or(Some(now_ms)),
                    ended_at: Some(now_ms),
                    // 🔧 使用 VariantContext 记录的 first_chunk_at 时间戳
                    first_chunk_at: ctx.get_thinking_first_chunk_at(),
                    block_index,
                };
                pending_blocks.push(thinking_block);
                all_block_ids.push(thinking_block_id);
                block_index += 1;
            }

            // 收集 content 块
            if let Some(content_block_id) = ctx.get_content_block_id() {
                let content = ctx.get_accumulated_content();
                let content_block = MessageBlock {
                    id: content_block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::CONTENT.to_string(),
                    status: if ctx.status() == variant_status::SUCCESS {
                        block_status::SUCCESS.to_string()
                    } else if ctx.status() == variant_status::ERROR {
                        block_status::ERROR.to_string()
                    } else {
                        block_status::RUNNING.to_string()
                    },
                    content: if content.is_empty() {
                        None
                    } else {
                        Some(content)
                    },
                    tool_name: None,
                    tool_input: None,
                    tool_output: None,
                    citations: None,
                    error: ctx.error(),
                    // 🔧 P3修复：使用 first_chunk_at 作为 started_at（真正的开始时间）
                    started_at: ctx.get_content_first_chunk_at().or(Some(now_ms)),
                    ended_at: Some(now_ms),
                    // 🔧 使用 VariantContext 记录的 first_chunk_at 时间戳
                    first_chunk_at: ctx.get_content_first_chunk_at(),
                    block_index,
                };
                pending_blocks.push(content_block);
                all_block_ids.push(content_block_id);
            }

            // 创建 Variant 结构
            let variant = ctx.to_variant();
            variants.push(variant);

            log::debug!(
                "[ChatV2::pipeline] Saved blocks for variant {}: status={}",
                ctx.variant_id(),
                ctx.status()
            );
        }

        // === 4. 保存助手消息（带变体信息）===
        let assistant_message = ChatMessage {
            id: assistant_message_id.to_string(),
            session_id: session_id.to_string(),
            role: MessageRole::Assistant,
            block_ids: all_block_ids,
            timestamp: now_ms,
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: Some(MessageMeta {
                model_id: None, // 多变体模式下不设置单一模型
                chat_params: Some(json!({
                    "temperature": options.temperature,
                    "maxTokens": options.max_tokens,
                    "enableThinking": options.enable_thinking,
                    "multiVariantMode": true,
                })),
                sources: if shared_context.has_sources() {
                    Some(MessageSources {
                        rag: shared_context.rag_sources.clone(),
                        memory: shared_context.memory_sources.clone(),
                        graph: shared_context.graph_sources.clone(),
                        web_search: shared_context.web_search_sources.clone(),
                        multimodal: shared_context.multimodal_sources.clone(),
                    })
                } else {
                    None
                },
                tool_results: None,
                anki_cards: None,
                // 多变体模式下 usage 为 None（各变体独立记录）
                usage: None,
                // 🆕 统一上下文注入系统：多变体模式支持 context_snapshot
                context_snapshot: context_snapshot.clone(),
            }),
            attachments: None,
            active_variant_id: active_variant_id.map(|s| s.to_string()),
            variants: Some(variants),
            shared_context: Some(shared_context.clone()),
        };

        ChatV2Repo::create_message_with_conn(&conn, &assistant_message)?;

        // 🆕 统一上下文注入系统：消息保存后增加资源引用计数
        // 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db
        if let Some(ref snapshot) = context_snapshot {
            if snapshot.has_refs() {
                if let Some(ref vfs_db) = self.vfs_db {
                    if let Ok(vfs_conn) = vfs_db.get_conn_safe() {
                        let resource_ids = snapshot.all_resource_ids();
                        // 使用同步方法增加引用计数（使用现有连接避免死锁）
                        for resource_id in &resource_ids {
                            if let Err(e) =
                                VfsResourceRepo::increment_ref_with_conn(&vfs_conn, resource_id)
                            {
                                log::warn!(
                                    "[ChatV2::pipeline] Failed to increment ref for resource {}: {}",
                                    resource_id, e
                                );
                            }
                        }
                        log::debug!(
                            "[ChatV2::pipeline] Multi-variant: incremented refs for {} resources in vfs.db",
                            resource_ids.len()
                        );
                    } else {
                        log::warn!("[ChatV2::pipeline] Multi-variant: failed to get vfs.db connection for increment refs");
                    }
                } else {
                    log::warn!("[ChatV2::pipeline] Multi-variant: vfs_db not available, skipping increment refs");
                }
            }
        }

        // === 4. 现在可以安全地创建块了（助手消息已存在）===
        for block in pending_blocks {
            ChatV2Repo::create_block_with_conn(&conn, &block)?;
        }

        log::info!(
            "[ChatV2::pipeline] Multi-variant results saved: user_msg={}, assistant_msg={}, variants={}",
            user_message_id,
            assistant_message_id,
            variant_contexts.len()
        );

        Ok(())
    }
}

// ============================================================================
// 变体 LLM 适配器
// ============================================================================

struct VariantLLMAdapter {
    ctx: Arc<super::variant_context::VariantExecutionContext>,
    enable_thinking: bool,
    content_block_initialized: Mutex<bool>,
    thinking_block_initialized: Mutex<bool>,
    finalized_thinking_block_id: Mutex<Option<String>>,
    /// 🔧 <think> 标签解析状态：是否当前在 <think> 标签内部
    in_think_tag: Mutex<bool>,
    /// 🔧 <think> 标签解析缓冲区：用于处理跨 chunk 的标签边界
    think_tag_buffer: Mutex<String>,
}

impl VariantLLMAdapter {
    fn new(
        ctx: Arc<super::variant_context::VariantExecutionContext>,
        enable_thinking: bool,
    ) -> Self {
        Self {
            ctx,
            enable_thinking,
            content_block_initialized: Mutex::new(false),
            thinking_block_initialized: Mutex::new(false),
            finalized_thinking_block_id: Mutex::new(None),
            in_think_tag: Mutex::new(false),
            think_tag_buffer: Mutex::new(String::new()),
        }
    }

    fn finalize_thinking(&self) {
        let mut initialized = self
            .thinking_block_initialized
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *initialized {
            if let Some(block_id) = self.ctx.get_thinking_block_id() {
                *self
                    .finalized_thinking_block_id
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(block_id.clone());
                self.ctx.emit_end(event_types::THINKING, &block_id, None);
            }
            *initialized = false;
        }
    }

    fn finalize_all(&self) {
        // 🔧 先处理缓冲区中剩余的内容
        self.flush_think_tag_buffer();
        self.finalize_thinking();
        let content_initialized = *self
            .content_block_initialized
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if content_initialized {
            if let Some(block_id) = self.ctx.get_content_block_id() {
                self.ctx.emit_end(event_types::CONTENT, &block_id, None);
            }
        }
    }

    /// 🔧 刷新 think 标签缓冲区中剩余的内容
    fn flush_think_tag_buffer(&self) {
        let mut buffer = self
            .think_tag_buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        if buffer.is_empty() {
            return;
        }

        let remaining = std::mem::take(&mut *buffer);
        let in_think = *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner());
        drop(buffer);

        if in_think && self.enable_thinking {
            // 剩余内容属于 thinking（未闭合的 think 标签）
            log::warn!(
                "[ChatV2::VariantAdapter] Flushing unclosed <think> tag content: {} chars",
                remaining.len()
            );
            self.ctx.append_reasoning(&remaining);
            if let Some(block_id) = self.ctx.get_thinking_block_id() {
                self.ctx
                    .emit_chunk(event_types::THINKING, &block_id, &remaining);
            }
        } else if !remaining.is_empty() {
            // 剩余内容属于 content
            self.ctx.append_content(&remaining);
            if let Some(block_id) = self.ctx.get_content_block_id() {
                self.ctx
                    .emit_chunk(event_types::CONTENT, &block_id, &remaining);
            }
        }
    }

    /// 🔧 确保 thinking 块已启动（用于 <think> 标签解析）
    fn ensure_thinking_started_for_tag(&self) -> Option<String> {
        if !self.enable_thinking {
            return None;
        }

        let mut initialized = self
            .thinking_block_initialized
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !*initialized {
            let block_id = MessageBlock::generate_id();
            self.ctx.set_thinking_block_id(&block_id);
            self.ctx.emit_start(event_types::THINKING, &block_id, None);
            *initialized = true;
        }
        drop(initialized);
        self.ctx.get_thinking_block_id()
    }

    /// 🔧 确保 content 块已启动（用于 <think> 标签解析）
    fn ensure_content_started_for_tag(&self) -> Option<String> {
        // 先结束 thinking 块（如果有）
        self.finalize_thinking();

        let mut initialized = self
            .content_block_initialized
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !*initialized {
            let block_id = MessageBlock::generate_id();
            self.ctx.set_content_block_id(&block_id);
            self.ctx.emit_start(event_types::CONTENT, &block_id, None);
            *initialized = true;
        }
        drop(initialized);
        self.ctx.get_content_block_id()
    }

    /// 🔧 处理 think 标签缓冲区，将内容路由到 thinking 或 content 块
    ///
    /// 支持中转站返回的 `<think>...</think>` 或 `<thinking>...</thinking>` 格式
    fn process_think_tag_buffer(&self) {
        // 开始标签模式（支持 <think> 和 <thinking>）
        const START_TAGS: &[&str] = &["<thinking>", "<think>"];
        // 结束标签模式（支持 </think> 和 </thinking>）
        const END_TAGS: &[&str] = &["</thinking>", "</think>"];

        loop {
            let mut buffer = self
                .think_tag_buffer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let in_think = *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner());

            if buffer.is_empty() {
                return;
            }

            if in_think {
                // 当前在 <think> 标签内，寻找结束标签
                let mut found_end = false;
                let mut end_pos = 0;
                let mut tag_len = 0;

                for end_tag in END_TAGS {
                    if let Some(pos) = buffer.find(end_tag) {
                        if !found_end || pos < end_pos {
                            found_end = true;
                            end_pos = pos;
                            tag_len = end_tag.len();
                        }
                    }
                }

                if found_end {
                    // 找到结束标签，输出 thinking 内容
                    let thinking_content: String = buffer.drain(..end_pos).collect();
                    // 移除结束标签
                    let _: String = buffer.drain(..tag_len).collect();
                    drop(buffer);

                    if !thinking_content.is_empty() && self.enable_thinking {
                        // 累积推理内容
                        self.ctx.append_reasoning(&thinking_content);
                        // 发射 thinking chunk
                        if let Some(block_id) = self.ensure_thinking_started_for_tag() {
                            self.ctx.emit_chunk(
                                event_types::THINKING,
                                &block_id,
                                &thinking_content,
                            );
                        }
                    }

                    // 退出 thinking 模式
                    *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner()) = false;
                    // 继续处理剩余内容
                } else {
                    // 未找到完整的结束标签，检查是否有潜在的不完整标签
                    if ChatV2LLMAdapter::ends_with_potential_think_end(&buffer) {
                        // 保留可能的不完整标签，等待更多数据
                        return;
                    }
                    // 没有潜在标签，输出所有内容到 thinking
                    let thinking_content = std::mem::take(&mut *buffer);
                    drop(buffer);

                    if !thinking_content.is_empty() && self.enable_thinking {
                        self.ctx.append_reasoning(&thinking_content);
                        if let Some(block_id) = self.ensure_thinking_started_for_tag() {
                            self.ctx.emit_chunk(
                                event_types::THINKING,
                                &block_id,
                                &thinking_content,
                            );
                        }
                    }
                    return;
                }
            } else {
                // 当前不在 <think> 标签内，寻找开始标签
                let mut found_start = false;
                let mut start_pos = 0;
                let mut tag_len = 0;

                for start_tag in START_TAGS {
                    if let Some(pos) = buffer.find(start_tag) {
                        if !found_start || pos < start_pos {
                            found_start = true;
                            start_pos = pos;
                            tag_len = start_tag.len();
                        }
                    }
                }

                if found_start {
                    // 找到开始标签，先输出标签前的 content
                    let content_before: String = buffer.drain(..start_pos).collect();
                    // 移除开始标签
                    let _: String = buffer.drain(..tag_len).collect();
                    drop(buffer);

                    if !content_before.is_empty() {
                        // 累积内容
                        self.ctx.append_content(&content_before);
                        // 发射 content chunk
                        if let Some(block_id) = self.ensure_content_started_for_tag() {
                            self.ctx
                                .emit_chunk(event_types::CONTENT, &block_id, &content_before);
                        }
                    }

                    // 进入 thinking 模式
                    *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner()) = true;
                    // 继续处理剩余内容
                } else {
                    // 未找到完整的开始标签，检查是否有潜在的不完整标签
                    if ChatV2LLMAdapter::ends_with_potential_think_start(&buffer) {
                        // 找到最后一个 '<' 的位置，保留可能的不完整标签
                        if let Some(lt_pos) = buffer.rfind('<') {
                            // 输出 '<' 之前的内容
                            let content_before: String = buffer.drain(..lt_pos).collect();
                            drop(buffer);

                            if !content_before.is_empty() {
                                self.ctx.append_content(&content_before);
                                if let Some(block_id) = self.ensure_content_started_for_tag() {
                                    self.ctx.emit_chunk(
                                        event_types::CONTENT,
                                        &block_id,
                                        &content_before,
                                    );
                                }
                            }
                        }
                        return;
                    }
                    // 没有潜在标签，输出所有内容到 content
                    let content = std::mem::take(&mut *buffer);
                    drop(buffer);

                    if !content.is_empty() {
                        self.ctx.append_content(&content);
                        if let Some(block_id) = self.ensure_content_started_for_tag() {
                            self.ctx
                                .emit_chunk(event_types::CONTENT, &block_id, &content);
                        }
                    }
                    return;
                }
            }
        }
    }

    pub fn get_thinking_block_id(&self) -> Option<String> {
        let finalized = self
            .finalized_thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if finalized.is_some() {
            return finalized;
        }
        self.ctx.get_thinking_block_id()
    }

    pub fn get_accumulated_reasoning(&self) -> Option<String> {
        self.ctx.get_accumulated_reasoning()
    }

    pub fn take_tool_calls(&self) -> Vec<ToolCall> {
        self.ctx.take_tool_calls()
    }

    pub fn get_content_block_id(&self) -> Option<String> {
        self.ctx.get_content_block_id()
    }

    pub fn reset_for_new_round(&self) {
        *self
            .content_block_initialized
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = false;
        *self
            .thinking_block_initialized
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = false;
        *self
            .finalized_thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        // 🔧 重置 <think> 标签解析状态
        *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner()) = false;
        *self
            .think_tag_buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = String::new();
        self.ctx.reset_for_new_round();
    }
}

impl crate::llm_manager::LLMStreamHooks for VariantLLMAdapter {
    /// 🔧 增强的 on_content_chunk：支持 `<think>` 标签实时解析
    ///
    /// 某些中转站不支持 Anthropic Extended Thinking API，而是将思维链作为
    /// `<think>...</think>` 或 `<thinking>...</thinking>` 标签嵌入到普通内容中。
    /// 此方法实时解析这些标签，将内容正确路由到 thinking 或 content 块。
    fn on_content_chunk(&self, text: &str) {
        if text.is_empty() {
            return;
        }

        // 🔧 <think> 标签解析：将 chunk 追加到缓冲区并处理
        {
            let mut buffer = self
                .think_tag_buffer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            buffer.push_str(text);
        }
        self.process_think_tag_buffer();
    }

    fn on_reasoning_chunk(&self, text: &str) {
        if !self.enable_thinking {
            return;
        }

        let mut initialized = self
            .thinking_block_initialized
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !*initialized {
            let block_id = MessageBlock::generate_id();
            self.ctx.set_thinking_block_id(&block_id);
            self.ctx.emit_start(event_types::THINKING, &block_id, None);
            *initialized = true;
        }
        drop(initialized);

        if let Some(block_id) = self.ctx.get_thinking_block_id() {
            self.ctx.emit_chunk(event_types::THINKING, &block_id, text);
            self.ctx.append_reasoning(text);
        }
    }

    fn on_tool_call_start(&self, tool_call_id: &str, tool_name: &str) {
        log::info!(
            "[ChatV2::VariantAdapter] Tool call start: variant={}, id={}, name={}",
            self.ctx.variant_id(),
            tool_call_id,
            tool_name
        );

        if ChatV2LLMAdapter::is_builtin_retrieval_tool(tool_name) {
            return;
        }

        self.ctx.emit_tool_call_preparing(tool_call_id, tool_name);
    }

    fn on_tool_call(&self, msg: &LegacyChatMessage) {
        if let Some(ref tool_call) = msg.tool_call {
            self.ctx.add_tool_call(ToolCall {
                id: tool_call.id.clone(),
                name: tool_call.tool_name.clone(),
                arguments: tool_call.args_json.clone(),
            });

            log::info!(
                "[ChatV2::VariantAdapter] Collected tool call: variant={}, id={}, name={}",
                self.ctx.variant_id(),
                tool_call.id,
                tool_call.tool_name
            );
        }
    }

    fn on_tool_result(&self, msg: &LegacyChatMessage) {
        if let Some(ref tool_result) = msg.tool_result {
            log::debug!(
                "[ChatV2::VariantAdapter] on_tool_result: variant={}, call_id={}",
                self.ctx.variant_id(),
                tool_result.call_id
            );
        }
    }

    fn on_usage(&self, usage: &serde_json::Value) {
        let token_usage = parse_api_usage(usage);

        if let Some(u) = token_usage {
            self.ctx.set_usage(u.clone());

            log::info!(
                "[ChatV2::VariantAdapter] variant={} usage: prompt={}, completion={}, total={}, source={:?}",
                self.ctx.variant_id(),
                u.prompt_tokens,
                u.completion_tokens,
                u.total_tokens,
                u.source
            );
        } else {
            log::warn!(
                "[ChatV2::VariantAdapter] variant={} failed to parse usage: {:?}",
                self.ctx.variant_id(),
                usage
            );
        }
    }

    fn on_complete(&self, _final_text: &str, _reasoning: Option<&str>) {
        self.finalize_all();
    }
}

// 测试模块已分离至 pipeline_tests.rs
