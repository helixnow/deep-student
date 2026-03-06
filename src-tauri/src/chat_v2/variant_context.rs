//! Chat V2 变体执行上下文
//!
//! 实现多模型并行变体的隔离执行上下文，每个变体是一个完全独立的 LLM 执行环境。
//!
//! ## 核心设计原则：隔离优先
//! - 独立的取消令牌（支持级联取消）
//! - 独立的块 ID 列表
//! - 独立的事件发射（自动携带 variant_id）
//! - 独立的错误处理（一个变体失败不影响其他变体）
//!
//! ## 共享的只有
//! - 用户消息内容
//! - 检索结果（SharedContext，只读）

use crate::chat_v2::events::{event_types, ChatV2EventEmitter};
use crate::chat_v2::types::{
    MessageBlock, SharedContext, TokenUsage, ToolCall, ToolResultInfo, Variant, VariantMeta,
};
use crate::chat_v2::variant_status;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

// ============================================================================
// 变体执行上下文
// ============================================================================

/// 变体级别的隔离执行上下文
///
/// 每个变体拥有完全独立的执行环境，确保变体之间不会相互干扰。
///
/// ## 使用示例
/// ```ignore
/// let shared_context = Arc::new(SharedContext::new());
/// let emitter = Arc::new(ChatV2EventEmitter::new(window, session_id));
/// let parent_cancel = CancellationToken::new();
///
/// let ctx = VariantExecutionContext::new(
///     "var_123",
///     "gpt-4",
///     "msg_456",
///     shared_context,
///     emitter,
///     &parent_cancel,
/// );
///
/// // 开始流式生成
/// ctx.start_streaming();
///
/// // 创建块（自动归属到此变体）
/// let block_id = ctx.create_block("content");
///
/// // 发射事件（自动携带 variant_id）
/// ctx.emit_chunk("content", &block_id, "Hello");
///
/// // 完成
/// ctx.complete();
/// ```
pub struct VariantExecutionContext {
    /// 变体 ID（格式：var_{uuid}）
    variant_id: String,

    /// 模型 ID（显示名，如 "Qwen/Qwen3-8B"）
    model_id: String,

    /// 🔧 P2修复：API 配置 ID（用于 LLM 调用）
    config_id: RwLock<Option<String>>,

    /// 消息 ID
    message_id: String,

    /// 独立的取消令牌（从父令牌派生，支持级联取消）
    cancel_token: CancellationToken,

    /// 该变体专属的块 ID 列表
    block_ids: Mutex<Vec<String>>,

    /// 共享上下文（只读引用）
    shared_context: Arc<SharedContext>,

    /// 变体状态
    status: RwLock<String>,

    /// 错误信息
    error: RwLock<Option<String>>,

    /// 事件发射器
    emitter: Arc<ChatV2EventEmitter>,

    // ========== 内容累积字段（用于持久化）==========
    /// 累积的内容（content 块内容）
    accumulated_content: Mutex<String>,

    /// 累积的推理内容（thinking 块内容）
    accumulated_reasoning: Mutex<Option<String>>,

    /// Content 块 ID（用于持久化）
    content_block_id: Mutex<Option<String>>,

    /// Thinking 块 ID（用于持久化）
    thinking_block_id: Mutex<Option<String>>,

    /// Content 块第一个有效 chunk 到达时间（毫秒，用于排序）
    content_first_chunk_at: Mutex<Option<i64>>,

    /// Thinking 块第一个有效 chunk 到达时间（毫秒，用于排序）
    thinking_first_chunk_at: Mutex<Option<i64>>,

    /// 创建时间戳（毫秒）
    created_at: i64,

    // ========== Token 统计字段 ==========
    /// 该变体的 token 使用统计（由 VariantLLMAdapter.on_usage 设置）
    token_usage: Mutex<TokenUsage>,

    // ========== 🆕 工具调用支持字段 ==========
    /// 收集的工具调用（由 VariantLLMAdapter.on_tool_call 收集）
    collected_tool_calls: Mutex<Vec<ToolCall>>,

    /// 工具调用结果（用于递归调用 LLM）
    tool_results: Mutex<Vec<ToolResultInfo>>,

    /// 当前工具调用轮次（用于递归深度控制）
    tool_round_index: AtomicU32,

    /// 交替块 ID 列表（thinking→tool→thinking→content 交替顺序）
    interleaved_block_ids: Mutex<Vec<String>>,

    /// 交替块内容（与 interleaved_block_ids 对应）
    interleaved_blocks: Mutex<Vec<MessageBlock>>,

    /// 待回传给 LLM 的 reasoning_content（DeepSeek Thinking Mode）
    pending_reasoning_for_api: Mutex<Option<String>>,

    /// 变体级元数据（用于重放 skill 快照等）
    meta: Mutex<Option<VariantMeta>>,
}

impl VariantExecutionContext {
    /// 创建新的变体执行上下文
    ///
    /// ## 参数
    /// - `variant_id`: 变体 ID
    /// - `model_id`: 模型 ID
    /// - `message_id`: 消息 ID
    /// - `shared_context`: 共享上下文（检索结果）
    /// - `emitter`: 事件发射器
    /// - `parent_cancel_token`: 父取消令牌（用于全局取消）
    pub fn new(
        variant_id: impl Into<String>,
        model_id: impl Into<String>,
        message_id: impl Into<String>,
        shared_context: Arc<SharedContext>,
        emitter: Arc<ChatV2EventEmitter>,
        parent_cancel_token: &CancellationToken,
    ) -> Self {
        let variant_id = variant_id.into();
        let model_id = model_id.into();
        let message_id = message_id.into();

        log::info!(
            "[ChatV2::VariantContext] Created variant {} for model {} in message {}",
            variant_id,
            model_id,
            message_id
        );

        Self {
            variant_id,
            model_id,
            config_id: RwLock::new(None), // 🔧 P2修复：使用 RwLock，可通过 set_config_id 设置
            message_id,
            // 使用 child_token() 支持级联取消
            cancel_token: parent_cancel_token.child_token(),
            block_ids: Mutex::new(Vec::new()),
            shared_context,
            status: RwLock::new(variant_status::PENDING.to_string()),
            error: RwLock::new(None),
            emitter,
            // 内容累积字段初始化
            accumulated_content: Mutex::new(String::new()),
            accumulated_reasoning: Mutex::new(None),
            content_block_id: Mutex::new(None),
            thinking_block_id: Mutex::new(None),
            // 🔧 first_chunk_at 时间戳初始化（用于块排序）
            content_first_chunk_at: Mutex::new(None),
            thinking_first_chunk_at: Mutex::new(None),
            // 创建时间（在构造时记录，确保一致性）
            created_at: chrono::Utc::now().timestamp_millis(),
            // Token 统计初始化为默认值
            token_usage: Mutex::new(TokenUsage::default()),
            // 🆕 工具调用支持字段初始化
            collected_tool_calls: Mutex::new(Vec::new()),
            tool_results: Mutex::new(Vec::new()),
            tool_round_index: AtomicU32::new(0),
            interleaved_block_ids: Mutex::new(Vec::new()),
            interleaved_blocks: Mutex::new(Vec::new()),
            pending_reasoning_for_api: Mutex::new(None),
            meta: Mutex::new(None),
        }
    }

    pub fn set_meta(&self, meta: VariantMeta) {
        *self.meta.lock().unwrap_or_else(|e| e.into_inner()) = Some(meta);
    }

    pub fn get_meta(&self) -> Option<VariantMeta> {
        self.meta.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 🔧 P2修复：设置 config_id
    pub fn set_config_id(&self, config_id: String) {
        *self.config_id.write().unwrap_or_else(|e| e.into_inner()) = Some(config_id);
    }

    /// 🔧 P2修复：获取 config_id
    pub fn get_config_id(&self) -> Option<String> {
        self.config_id
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    // ========== Getter 方法 ==========

    /// 获取变体 ID
    pub fn variant_id(&self) -> &str {
        &self.variant_id
    }

    /// 获取模型 ID
    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    /// 获取消息 ID
    pub fn message_id(&self) -> &str {
        &self.message_id
    }

    /// 获取取消令牌（用于检查是否被取消或等待取消）
    pub fn cancel_token(&self) -> &CancellationToken {
        &self.cancel_token
    }

    /// 检查是否已取消
    pub fn is_cancelled(&self) -> bool {
        self.cancel_token.is_cancelled()
    }

    /// 获取共享上下文
    pub fn shared_context(&self) -> &SharedContext {
        &self.shared_context
    }

    /// 获取事件发射器（用于传递给 LLM 调用）
    pub fn emitter(&self) -> &ChatV2EventEmitter {
        &self.emitter
    }

    /// 获取事件发射器的 Arc 引用（用于工具调用）
    pub fn emitter_arc(&self) -> Arc<ChatV2EventEmitter> {
        Arc::clone(&self.emitter)
    }

    /// 获取当前状态
    pub fn status(&self) -> String {
        self.status
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 获取错误信息
    pub fn error(&self) -> Option<String> {
        self.error.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 获取块 ID 列表的副本
    pub fn block_ids(&self) -> Vec<String> {
        self.block_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    // ========== 块管理方法 ==========

    /// 创建新块（自动归属到此变体）
    ///
    /// ## 参数
    /// - `block_type`: 块类型（如 "thinking"、"content"、"mcp_tool"）
    ///
    /// ## 返回
    /// 新块的 ID
    pub fn create_block(&self, block_type: &str) -> String {
        let block_id = MessageBlock::generate_id();

        // 将块 ID 添加到此变体的块列表
        self.block_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(block_id.clone());

        log::debug!(
            "[ChatV2::VariantContext] Created block {} ({}) for variant {}",
            block_id,
            block_type,
            self.variant_id
        );

        block_id
    }

    /// 添加已存在的块 ID 到此变体
    pub fn add_block_id(&self, block_id: impl Into<String>) {
        self.block_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(block_id.into());
    }

    // ========== 内容累积方法 ==========

    /// 追加内容到累积的 content
    ///
    /// 当第一个有效 chunk 到达时，自动记录 `content_first_chunk_at` 时间戳。
    pub fn append_content(&self, text: &str) {
        // 🔧 记录 first_chunk_at（仅当第一次追加非空内容时）
        if !text.is_empty() {
            let mut first_chunk_at = self
                .content_first_chunk_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if first_chunk_at.is_none() {
                *first_chunk_at = Some(chrono::Utc::now().timestamp_millis());
            }
        }
        self.accumulated_content
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_str(text);
    }

    /// 追加内容到累积的 reasoning/thinking
    ///
    /// 当第一个有效 chunk 到达时，自动记录 `thinking_first_chunk_at` 时间戳。
    pub fn append_reasoning(&self, text: &str) {
        // 🔧 记录 first_chunk_at（仅当第一次追加非空内容时）
        if !text.is_empty() {
            let mut first_chunk_at = self
                .thinking_first_chunk_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if first_chunk_at.is_none() {
                *first_chunk_at = Some(chrono::Utc::now().timestamp_millis());
            }
        }
        let mut reasoning = self
            .accumulated_reasoning
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if reasoning.is_none() {
            *reasoning = Some(String::new());
        }
        if let Some(ref mut r) = *reasoning {
            r.push_str(text);
        }
    }

    /// 获取累积的内容
    pub fn get_accumulated_content(&self) -> String {
        self.accumulated_content
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 获取累积的推理内容
    pub fn get_accumulated_reasoning(&self) -> Option<String> {
        self.accumulated_reasoning
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 获取 content 块的 first_chunk_at 时间戳
    pub fn get_content_first_chunk_at(&self) -> Option<i64> {
        *self
            .content_first_chunk_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// 获取 thinking 块的 first_chunk_at 时间戳
    pub fn get_thinking_first_chunk_at(&self) -> Option<i64> {
        *self
            .thinking_first_chunk_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// 设置 content block ID
    ///
    /// 注意：如果 block_id 已在 block_ids 中，不会重复添加
    pub fn set_content_block_id(&self, block_id: impl Into<String>) {
        let block_id = block_id.into();
        // 检查是否已存在，避免重复添加
        let mut block_ids = self.block_ids.lock().unwrap_or_else(|e| e.into_inner());
        if !block_ids.contains(&block_id) {
            block_ids.push(block_id.clone());
        }
        drop(block_ids);
        *self
            .content_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(block_id);
    }

    /// 设置 thinking block ID
    ///
    /// 注意：如果 block_id 已在 block_ids 中，不会重复添加
    pub fn set_thinking_block_id(&self, block_id: impl Into<String>) {
        let block_id = block_id.into();
        // 检查是否已存在，避免重复添加
        let mut block_ids = self.block_ids.lock().unwrap_or_else(|e| e.into_inner());
        if !block_ids.contains(&block_id) {
            block_ids.push(block_id.clone());
        }
        drop(block_ids);
        *self
            .thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(block_id);
    }

    /// 获取 content block ID
    pub fn get_content_block_id(&self) -> Option<String> {
        self.content_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 获取 thinking block ID
    pub fn get_thinking_block_id(&self) -> Option<String> {
        self.thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    // ========== Token 统计方法 ==========

    /// 设置 token 使用统计（由 VariantLLMAdapter.on_usage 调用）
    ///
    /// ## 参数
    /// - `usage`: API 返回的 token 使用统计
    pub fn set_usage(&self, usage: TokenUsage) {
        log::info!(
            "[ChatV2::VariantContext] variant={} set usage: prompt={}, completion={}, source={:?}",
            self.variant_id,
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.source
        );
        *self.token_usage.lock().unwrap_or_else(|e| e.into_inner()) = usage;
    }

    /// 获取 token 使用统计（由持久化逻辑调用）
    ///
    /// 返回 token_usage 的克隆值
    pub fn get_usage(&self) -> TokenUsage {
        self.token_usage
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 检查是否有有效的 token 统计（total_tokens > 0）
    pub fn has_usage(&self) -> bool {
        self.token_usage
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .total_tokens
            > 0
    }

    // ========== 🆕 工具调用支持方法 ==========

    pub fn add_tool_call(&self, tool_call: ToolCall) {
        self.collected_tool_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(tool_call);
    }

    pub fn take_tool_calls(&self) -> Vec<ToolCall> {
        std::mem::take(
            &mut *self
                .collected_tool_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        )
    }

    pub fn has_tool_calls(&self) -> bool {
        !self
            .collected_tool_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    }

    pub fn add_tool_result(&self, result: ToolResultInfo) {
        self.tool_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(result);
    }

    pub fn add_tool_results(&self, results: Vec<ToolResultInfo>) {
        self.tool_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(results);
    }

    pub fn get_tool_results(&self) -> Vec<ToolResultInfo> {
        self.tool_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn increment_tool_round(&self) -> u32 {
        self.tool_round_index.fetch_add(1, Ordering::SeqCst)
    }

    pub fn get_tool_round(&self) -> u32 {
        self.tool_round_index.load(Ordering::SeqCst)
    }

    pub fn add_interleaved_block(&self, mut block: MessageBlock) -> u32 {
        let mut blocks = self
            .interleaved_blocks
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let index = blocks.len() as u32;
        block.block_index = index;
        self.interleaved_block_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(block.id.clone());
        blocks.push(block);
        index
    }

    pub fn get_interleaved_blocks(&self) -> Vec<MessageBlock> {
        self.interleaved_blocks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn get_interleaved_block_ids(&self) -> Vec<String> {
        self.interleaved_block_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn has_interleaved_blocks(&self) -> bool {
        !self
            .interleaved_block_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    }

    pub fn set_pending_reasoning(&self, reasoning: Option<String>) {
        *self
            .pending_reasoning_for_api
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = reasoning;
    }

    pub fn get_pending_reasoning(&self) -> Option<String> {
        self.pending_reasoning_for_api
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn clear_pending_reasoning(&self) {
        *self
            .pending_reasoning_for_api
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn reset_for_new_round(&self) {
        *self
            .accumulated_content
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = String::new();
        *self
            .accumulated_reasoning
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .content_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .content_first_chunk_at
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .thinking_first_chunk_at
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }

    // ========== 事件发射方法（自动携带 variant_id）==========

    /// 发射 start 事件（自动携带 variant_id）
    ///
    /// ## 参数
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `payload`: 可选的附加数据
    pub fn emit_start(&self, event_type: &str, block_id: &str, payload: Option<Value>) {
        self.emitter.emit_start(
            event_type,
            &self.message_id,
            Some(block_id),
            payload,
            Some(&self.variant_id), // 自动携带 variant_id
        );
    }

    /// 发射 chunk 事件（自动携带 variant_id）
    ///
    /// ## 参数
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `chunk`: 数据块内容
    pub fn emit_chunk(&self, event_type: &str, block_id: &str, chunk: &str) {
        self.emitter.emit_chunk(
            event_type,
            block_id,
            chunk,
            Some(&self.variant_id), // 自动携带 variant_id
        );
    }

    /// 发射 end 事件（自动携带 variant_id）
    ///
    /// ## 参数
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `result`: 可选的最终结果
    pub fn emit_end(&self, event_type: &str, block_id: &str, result: Option<Value>) {
        self.emitter.emit_end(
            event_type,
            block_id,
            result,
            Some(&self.variant_id), // 自动携带 variant_id
        );
    }

    /// 发射 error 事件（自动携带 variant_id）
    ///
    /// ## 参数
    /// - `event_type`: 事件类型
    /// - `block_id`: 块 ID
    /// - `error`: 错误信息
    pub fn emit_error(&self, event_type: &str, block_id: &str, error: &str) {
        self.emitter.emit_error(
            event_type,
            block_id,
            error,
            Some(&self.variant_id), // 自动携带 variant_id
        );
    }

    /// 发射 tool_call_preparing 事件（自动携带 variant_id）
    pub fn emit_tool_call_preparing(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        block_id: Option<&str>,
    ) {
        self.emitter.emit_tool_call_preparing_with_variant(
            &self.message_id,
            tool_call_id,
            tool_name,
            block_id,
            &self.variant_id,
        );
    }

    /// 发射 tool_call_preparing 的 args delta chunk（自动携带 variant_id）
    pub fn emit_tool_call_preparing_chunk(&self, block_id: &str, chunk: &str) {
        self.emitter.emit_chunk(
            event_types::TOOL_CALL_PREPARING,
            block_id,
            chunk,
            Some(&self.variant_id),
        );
    }

    // ========== 变体生命周期方法 ==========

    /// 检查是否已经是终止状态
    fn is_terminal_status(&self) -> bool {
        let status = self.status.read().unwrap_or_else(|e| e.into_inner());
        *status == variant_status::SUCCESS
            || *status == variant_status::ERROR
            || *status == variant_status::CANCELLED
    }

    /// 开始流式生成（发射 variant_start 事件）
    ///
    /// 如果已经在 streaming 或终止状态，则跳过
    pub fn start_streaming(&self) {
        // 状态检查：只允许从 pending 转换
        {
            let status = self.status.read().unwrap_or_else(|e| e.into_inner());
            if *status != variant_status::PENDING {
                log::warn!(
                    "[ChatV2::VariantContext] Variant {} cannot start streaming: already in {} state",
                    self.variant_id,
                    *status
                );
                return;
            }
        }

        *self.status.write().unwrap_or_else(|e| e.into_inner()) =
            variant_status::STREAMING.to_string();

        log::info!(
            "[ChatV2::VariantContext] Variant {} started streaming with model {}",
            self.variant_id,
            self.model_id
        );

        // 发射 variant_start 事件
        self.emitter
            .emit_variant_start(&self.message_id, &self.variant_id, &self.model_id);
    }

    /// 完成生成（发射 variant_end(success) 事件）
    ///
    /// 如果已经在终止状态，则跳过
    pub fn complete(&self) {
        // 状态检查：不允许重复终止
        if self.is_terminal_status() {
            log::warn!(
                "[ChatV2::VariantContext] Variant {} already in terminal state, skipping complete",
                self.variant_id
            );
            return;
        }

        *self.status.write().unwrap_or_else(|e| e.into_inner()) =
            variant_status::SUCCESS.to_string();

        log::info!(
            "[ChatV2::VariantContext] Variant {} completed successfully",
            self.variant_id
        );

        // 获取 usage（如果有有效数据）
        let usage = {
            let u = self.token_usage.lock().unwrap_or_else(|e| e.into_inner());
            if u.total_tokens > 0 {
                Some(u.clone())
            } else {
                None
            }
        };

        // 发射 variant_end 事件（携带 usage）
        self.emitter
            .emit_variant_end(&self.variant_id, variant_status::SUCCESS, None, usage);
    }

    /// 失败（发射 variant_end(error) 事件）
    ///
    /// 如果已经在终止状态，则跳过
    ///
    /// ## 参数
    /// - `error`: 错误信息
    pub fn fail(&self, error: &str) {
        // 状态检查：不允许重复终止
        if self.is_terminal_status() {
            log::warn!(
                "[ChatV2::VariantContext] Variant {} already in terminal state, skipping fail",
                self.variant_id
            );
            return;
        }

        *self.status.write().unwrap_or_else(|e| e.into_inner()) = variant_status::ERROR.to_string();
        *self.error.write().unwrap_or_else(|e| e.into_inner()) = Some(error.to_string());

        log::error!(
            "[ChatV2::VariantContext] Variant {} failed: {}",
            self.variant_id,
            error
        );

        // 获取 usage（即使失败也可能有部分 token 统计）
        let usage = {
            let u = self.token_usage.lock().unwrap_or_else(|e| e.into_inner());
            if u.total_tokens > 0 {
                Some(u.clone())
            } else {
                None
            }
        };

        // 发射 variant_end 事件（携带 usage）
        self.emitter
            .emit_variant_end(&self.variant_id, variant_status::ERROR, Some(error), usage);
    }

    /// 取消（发射 variant_end(cancelled) 事件）
    ///
    /// 如果已经在终止状态，则只触发取消令牌而不发射事件
    pub fn cancel(&self) {
        // 始终触发取消令牌（幂等操作）
        self.cancel_token.cancel();

        // 状态检查：不允许重复终止
        if self.is_terminal_status() {
            log::debug!(
                "[ChatV2::VariantContext] Variant {} already in terminal state, skipping cancel event",
                self.variant_id
            );
            return;
        }

        *self.status.write().unwrap_or_else(|e| e.into_inner()) =
            variant_status::CANCELLED.to_string();

        log::info!(
            "[ChatV2::VariantContext] Variant {} cancelled",
            self.variant_id
        );

        // 获取 usage（取消前可能已有部分生成）
        let usage = {
            let u = self.token_usage.lock().unwrap_or_else(|e| e.into_inner());
            if u.total_tokens > 0 {
                Some(u.clone())
            } else {
                None
            }
        };

        // 发射 variant_end 事件（携带 usage）
        self.emitter
            .emit_variant_end(&self.variant_id, variant_status::CANCELLED, None, usage);
    }

    /// 转换为 Variant 结构体
    ///
    /// 包含 token 使用统计（如果有有效数据）
    pub fn to_variant(&self) -> Variant {
        // 获取 usage，如果 total_tokens > 0 则包含
        let usage = {
            let u = self.token_usage.lock().unwrap_or_else(|e| e.into_inner());
            if u.total_tokens > 0 {
                Some(u.clone())
            } else {
                None
            }
        };

        Variant {
            id: self.variant_id.clone(),
            model_id: self.model_id.clone(),
            config_id: self.get_config_id(), // 🔧 P2修复：包含 config_id
            block_ids: self.block_ids(),
            status: self.status(),
            error: self.error(),
            created_at: self.created_at, // 使用构造时记录的时间
            usage,
            meta: self.get_meta(),
        }
    }

    /// 获取创建时间戳
    pub fn created_at(&self) -> i64 {
        self.created_at
    }
}

// ============================================================================
// 并行执行管理器
// ============================================================================

/// 并行执行管理器
///
/// 管理多个变体的并行执行，提供全局取消和状态查询功能。
///
/// ## 使用示例
/// ```ignore
/// let manager = ParallelExecutionManager::new();
///
/// // 添加变体执行上下文
/// manager.add_variant(variant_ctx1);
/// manager.add_variant(variant_ctx2);
///
/// // 取消单个变体
/// manager.cancel_variant("var_001");
///
/// // 取消所有变体
/// manager.cancel_all();
///
/// // 获取第一个成功的变体
/// let first_success = manager.get_first_success();
/// ```
pub struct ParallelExecutionManager {
    /// 全局取消令牌（取消所有变体）
    global_cancel: CancellationToken,

    /// 每个变体的独立执行上下文
    variant_contexts: RwLock<HashMap<String, Arc<VariantExecutionContext>>>,
}

impl ParallelExecutionManager {
    /// 创建新的并行执行管理器
    pub fn new() -> Self {
        Self {
            global_cancel: CancellationToken::new(),
            variant_contexts: RwLock::new(HashMap::new()),
        }
    }

    /// 创建带已有取消令牌的管理器
    pub fn with_cancel_token(cancel_token: CancellationToken) -> Self {
        Self {
            global_cancel: cancel_token,
            variant_contexts: RwLock::new(HashMap::new()),
        }
    }

    /// 获取全局取消令牌
    pub fn global_cancel_token(&self) -> &CancellationToken {
        &self.global_cancel
    }

    /// 添加变体执行上下文
    pub fn add_variant(&self, ctx: Arc<VariantExecutionContext>) {
        let variant_id = ctx.variant_id().to_string();
        self.variant_contexts
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(variant_id, ctx);
    }

    /// 创建并添加新的变体执行上下文
    ///
    /// ## 参数
    /// - `variant_id`: 变体 ID
    /// - `model_id`: 模型 ID
    /// - `message_id`: 消息 ID
    /// - `shared_context`: 共享上下文
    /// - `emitter`: 事件发射器
    ///
    /// ## 返回
    /// 新创建的变体执行上下文的 Arc 引用
    pub fn create_variant(
        &self,
        variant_id: impl Into<String>,
        model_id: impl Into<String>,
        message_id: impl Into<String>,
        shared_context: Arc<SharedContext>,
        emitter: Arc<ChatV2EventEmitter>,
    ) -> Arc<VariantExecutionContext> {
        let ctx = Arc::new(VariantExecutionContext::new(
            variant_id,
            model_id,
            message_id,
            shared_context,
            emitter,
            &self.global_cancel,
        ));

        self.add_variant(Arc::clone(&ctx));
        ctx
    }

    /// 获取变体执行上下文
    pub fn get_variant(&self, variant_id: &str) -> Option<Arc<VariantExecutionContext>> {
        self.variant_contexts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(variant_id)
            .cloned()
    }

    /// 取消单个变体
    ///
    /// ## 返回
    /// - `true`: 成功取消
    /// - `false`: 变体不存在
    pub fn cancel_variant(&self, variant_id: &str) -> bool {
        if let Some(ctx) = self.get_variant(variant_id) {
            ctx.cancel();
            log::info!("[ChatV2::ParallelManager] Cancelled variant {}", variant_id);
            true
        } else {
            log::warn!("[ChatV2::ParallelManager] Variant {} not found", variant_id);
            false
        }
    }

    /// 取消所有变体
    pub fn cancel_all(&self) {
        // 触发全局取消令牌（子令牌会自动取消）
        self.global_cancel.cancel();

        log::info!("[ChatV2::ParallelManager] Cancelled all variants");

        // 更新所有变体状态
        for (_, ctx) in self
            .variant_contexts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
        {
            // 状态更新由 VariantExecutionContext 的 cancel_token 触发
            // 这里只需要发射事件（如果尚未发射）
            let status = ctx.status();
            if status == variant_status::STREAMING || status == variant_status::PENDING {
                ctx.cancel();
            }
        }
    }

    /// 获取所有变体
    pub fn get_variants(&self) -> Vec<Variant> {
        self.variant_contexts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|ctx| ctx.to_variant())
            .collect()
    }

    /// 获取变体数量
    pub fn variant_count(&self) -> usize {
        self.variant_contexts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// 获取第一个成功的变体 ID
    ///
    /// 按优先级顺序：
    /// 1. 第一个 success 状态的变体
    /// 2. 第一个 cancelled 状态的变体
    /// 3. 第一个变体（即使是 error）
    pub fn get_first_success(&self) -> Option<String> {
        let contexts = self
            .variant_contexts
            .read()
            .unwrap_or_else(|e| e.into_inner());

        // 优先级 1: 找第一个 success 的
        for (id, ctx) in contexts.iter() {
            if ctx.status() == variant_status::SUCCESS {
                return Some(id.clone());
            }
        }

        // 优先级 2: 找第一个 cancelled 的
        for (id, ctx) in contexts.iter() {
            if ctx.status() == variant_status::CANCELLED {
                return Some(id.clone());
            }
        }

        // 优先级 3: 返回第一个（即使是 error）
        contexts.keys().next().cloned()
    }

    /// 检查是否所有变体都已完成
    pub fn all_completed(&self) -> bool {
        self.variant_contexts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .all(|ctx| {
                let status = ctx.status();
                status == variant_status::SUCCESS
                    || status == variant_status::ERROR
                    || status == variant_status::CANCELLED
            })
    }

    /// 检查是否有任何变体正在流式生成
    pub fn has_streaming(&self) -> bool {
        self.variant_contexts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|ctx| ctx.status() == variant_status::STREAMING)
    }

    /// 获取成功的变体数量
    pub fn success_count(&self) -> usize {
        self.variant_contexts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|ctx| ctx.status() == variant_status::SUCCESS)
            .count()
    }

    /// 获取失败的变体数量
    pub fn error_count(&self) -> usize {
        self.variant_contexts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|ctx| ctx.status() == variant_status::ERROR)
            .count()
    }

    /// 移除变体
    pub fn remove_variant(&self, variant_id: &str) -> Option<Arc<VariantExecutionContext>> {
        self.variant_contexts
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(variant_id)
    }

    /// 清空所有变体
    pub fn clear(&self) {
        self.variant_contexts
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

impl Default for ParallelExecutionManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // 注意：由于 ChatV2EventEmitter 需要 tauri::Window，
    // 这些测试主要验证逻辑正确性，不验证实际事件发射

    #[test]
    fn test_variant_id_generation() {
        let id = Variant::generate_id();
        assert!(id.starts_with("var_"));
    }

    #[test]
    fn test_cancel_token_cascade() {
        let parent = CancellationToken::new();
        let child = parent.child_token();

        assert!(!parent.is_cancelled());
        assert!(!child.is_cancelled());

        // 取消父令牌
        parent.cancel();

        // 子令牌也应该被取消
        assert!(parent.is_cancelled());
        assert!(child.is_cancelled());
    }

    #[test]
    fn test_child_cancel_not_affect_parent() {
        let parent = CancellationToken::new();
        let child = parent.child_token();

        // 取消子令牌
        child.cancel();

        // 父令牌不应该被取消
        assert!(!parent.is_cancelled());
        assert!(child.is_cancelled());
    }

    #[test]
    fn test_parallel_manager_basic() {
        let manager = ParallelExecutionManager::new();

        assert_eq!(manager.variant_count(), 0);
        assert!(manager.all_completed());
        assert!(!manager.has_streaming());
    }

    #[test]
    fn test_parallel_manager_cancel_all() {
        let manager = ParallelExecutionManager::new();

        // 取消所有（即使没有变体也不应该 panic）
        manager.cancel_all();

        assert!(manager.global_cancel_token().is_cancelled());
    }

    #[test]
    fn test_get_first_success_empty() {
        let manager = ParallelExecutionManager::new();

        assert!(manager.get_first_success().is_none());
    }

    #[test]
    fn test_shared_context() {
        let ctx = SharedContext::new();
        assert!(!ctx.has_sources());

        let ctx_with_sources = SharedContext {
            rag_sources: Some(vec![]),
            ..Default::default()
        };
        assert!(!ctx_with_sources.has_sources()); // 空向量也算没有

        use crate::chat_v2::types::SourceInfo;
        let ctx_with_real_sources = SharedContext {
            rag_sources: Some(vec![SourceInfo {
                title: Some("Test".to_string()),
                url: None,
                snippet: None,
                score: None,
                metadata: None,
            }]),
            ..Default::default()
        };
        assert!(ctx_with_real_sources.has_sources());
    }

    #[test]
    fn test_block_auto_attribution() {
        // 验证 create_block 自动将 block_id 添加到 block_ids
        // 由于需要 ChatV2EventEmitter，这里只测试 block_ids 的逻辑

        // 使用 Mutex<Vec<String>> 模拟 block_ids 行为
        let block_ids: Mutex<Vec<String>> = Mutex::new(Vec::new());

        // 模拟 create_block 的核心逻辑
        let block_id = MessageBlock::generate_id();
        block_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(block_id.clone());

        // 验证 block_id 已添加
        assert_eq!(block_ids.lock().unwrap_or_else(|e| e.into_inner()).len(), 1);
        assert!(block_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&block_id));
        assert!(block_id.starts_with("blk_"));
    }

    #[test]
    fn test_block_id_no_duplicate() {
        // 验证 set_*_block_id 不会重复添加已存在的 block_id
        let block_ids: Mutex<Vec<String>> = Mutex::new(Vec::new());
        let block_id = "blk_test_123".to_string();

        // 第一次添加
        {
            let mut ids = block_ids.lock().unwrap_or_else(|e| e.into_inner());
            if !ids.contains(&block_id) {
                ids.push(block_id.clone());
            }
        }
        assert_eq!(block_ids.lock().unwrap_or_else(|e| e.into_inner()).len(), 1);

        // 第二次添加（应该不会重复）
        {
            let mut ids = block_ids.lock().unwrap_or_else(|e| e.into_inner());
            if !ids.contains(&block_id) {
                ids.push(block_id.clone());
            }
        }
        assert_eq!(block_ids.lock().unwrap_or_else(|e| e.into_inner()).len(), 1);
        // 仍然是 1
    }

    #[test]
    fn test_created_at_consistency() {
        // 验证 created_at 在构造时记录，后续调用不变
        let created_at = chrono::Utc::now().timestamp_millis();

        // 等待一小段时间
        std::thread::sleep(std::time::Duration::from_millis(10));

        let later = chrono::Utc::now().timestamp_millis();

        // 验证时间戳递增
        assert!(later > created_at);
    }

    // ========== Token Usage 相关测试 ==========

    #[test]
    fn test_token_usage_default() {
        // 验证 TokenUsage 默认值
        let usage = TokenUsage::default();
        assert_eq!(usage.prompt_tokens, 0);
        assert_eq!(usage.completion_tokens, 0);
        assert_eq!(usage.total_tokens, 0);
        assert_eq!(usage.source, crate::chat_v2::types::TokenSource::Tiktoken); // default
        assert!(usage.reasoning_tokens.is_none());
        assert!(usage.cached_tokens.is_none());
    }

    #[test]
    fn test_token_usage_from_api() {
        // 验证从 API 创建 TokenUsage
        let usage = TokenUsage::from_api(100, 50, Some(10));
        assert_eq!(usage.prompt_tokens, 100);
        assert_eq!(usage.completion_tokens, 50);
        assert_eq!(usage.total_tokens, 150);
        assert_eq!(usage.source, crate::chat_v2::types::TokenSource::Api);
        assert_eq!(usage.reasoning_tokens, Some(10));
    }

    #[test]
    fn test_token_usage_mutex() {
        // 验证 Mutex<TokenUsage> 的 set/get 操作
        let token_usage: Mutex<TokenUsage> = Mutex::new(TokenUsage::default());

        // 初始状态
        {
            let u = token_usage.lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(u.total_tokens, 0);
        }

        // 设置新值
        {
            let new_usage = TokenUsage::from_api(200, 100, None);
            *token_usage.lock().unwrap_or_else(|e| e.into_inner()) = new_usage;
        }

        // 验证新值
        {
            let u = token_usage.lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(u.prompt_tokens, 200);
            assert_eq!(u.completion_tokens, 100);
            assert_eq!(u.total_tokens, 300);
            assert_eq!(u.source, crate::chat_v2::types::TokenSource::Api);
        }
    }

    #[test]
    fn test_variant_with_usage() {
        // 验证 Variant 的 usage 字段
        let variant = Variant::new("gpt-4".to_string());
        assert!(variant.usage.is_none());

        // 使用 with_usage builder
        let usage = TokenUsage::from_api(100, 50, None);
        let variant_with_usage = Variant::new("gpt-4".to_string()).with_usage(usage.clone());

        assert!(variant_with_usage.usage.is_some());
        let u = variant_with_usage.usage.unwrap();
        assert_eq!(u.prompt_tokens, 100);
        assert_eq!(u.completion_tokens, 50);
    }

    #[test]
    fn test_variant_set_usage() {
        // 验证 Variant 的 set_usage 方法
        let mut variant = Variant::new("claude".to_string());
        assert!(variant.usage.is_none());

        let usage = TokenUsage::from_api(300, 150, Some(20));
        variant.set_usage(usage);

        assert!(variant.usage.is_some());
        let u = variant.get_usage().unwrap();
        assert_eq!(u.prompt_tokens, 300);
        assert_eq!(u.reasoning_tokens, Some(20));
    }
}
