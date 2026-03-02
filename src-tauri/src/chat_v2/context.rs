//! PipelineContext - 流水线执行上下文
//!
//! 从 pipeline.rs 拆分，管理单次请求的完整状态

use std::collections::HashMap;
use std::time::Instant;

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::models::ChatMessage as LegacyChatMessage;

use super::pipeline::ChatV2LLMAdapter;
use super::resource_types::{ContentBlock, ContextRef, ContextSnapshot, SendContextRef};
use super::types::{
    block_status, block_types, AttachmentInput, MessageBlock, MessageSources, SendMessageRequest,
    SendOptions, TokenUsage, ToolResultInfo,
};
use super::vfs_resolver::escape_xml_content;

// ============================================================
// 内部上下文
// ============================================================

/// 流水线执行上下文
pub(crate) struct PipelineContext {
    /// 会话 ID
    pub(crate) session_id: String,
    /// 用户消息 ID
    pub(crate) user_message_id: String,
    /// 助手消息 ID
    pub(crate) assistant_message_id: String,
    /// 用户消息内容
    pub(crate) user_content: String,
    /// 用户附件
    pub(crate) attachments: Vec<AttachmentInput>,
    /// 聊天历史（用于构建上下文）
    pub(crate) chat_history: Vec<LegacyChatMessage>,
    /// 检索到的来源
    pub(crate) retrieved_sources: MessageSources,
    /// 发送选项
    pub(crate) options: SendOptions,
    /// 工具调用结果
    pub(crate) tool_results: Vec<ToolResultInfo>,
    /// 最终生成的内容
    pub(crate) final_content: String,
    /// 最终生成的思维链
    pub(crate) final_reasoning: Option<String>,
    /// 活跃的块 ID 映射（event_type -> block_id）
    pub(crate) active_blocks: HashMap<String, String>,
    /// 生成的块列表（用于持久化）
    pub(crate) generated_blocks: Vec<MessageBlock>,
    /// 流式过程中创建的 thinking 块 ID
    pub(crate) streaming_thinking_block_id: Option<String>,
    /// 流式过程中创建的 content 块 ID
    pub(crate) streaming_content_block_id: Option<String>,
    /// 流式过程中创建的检索块 ID（block_type -> block_id）
    pub(crate) streaming_retrieval_block_ids: HashMap<String, String>,
    /// 🔧 P1修复：已添加到消息历史的工具结果数量（避免递归时重复添加）
    pub(crate) tool_results_added_count: usize,
    /// 开始时间
    pub(crate) start_time: Instant,
    /// Token 使用统计（累积多轮工具调用）
    pub(crate) token_usage: TokenUsage,

    // ========== Interleaved Thinking 支持（思维链+工具调用交替）==========
    /// 所有轮次产生的块 ID（按时序顺序，支持 thinking→tool→thinking→content 交替）
    /// 这是最终保存到消息的 block_ids 列表
    pub(crate) interleaved_block_ids: Vec<String>,
    /// 所有轮次产生的块内容（与 interleaved_block_ids 对应）
    pub(crate) interleaved_blocks: Vec<MessageBlock>,
    /// 全局块索引计数器（确保块按时序排序）
    pub(crate) global_block_index: u32,

    /// 待传递给 API 的 reasoning_content（DeepSeek/Claude 工具调用递归时使用）
    /// 在工具调用迭代中，需要将上一轮的 thinking_content 回传给 API
    pub(crate) pending_reasoning_for_api: Option<String>,

    /// Gemini 3 思维签名缓存（工具调用迭代时回传）
    /// 在工具调用场景下，API 返回的 thoughtSignature 需要缓存并在后续请求中回传
    pub(crate) pending_thought_signature: Option<String>,

    /// 🔧 修复：当前 LLM 适配器引用（用于取消时获取已累积的内容）
    pub(crate) current_adapter: Option<std::sync::Arc<ChatV2LLMAdapter>>,

    // ========== 统一上下文注入系统支持 ==========
    /// 用户上下文引用（前端传递，包含 formattedBlocks）
    pub(crate) user_context_refs: Vec<SendContextRef>,
    /// 上下文快照（消息保存时使用，只存 ContextRef）
    pub(crate) context_snapshot: ContextSnapshot,

    /// 🔧 Bug修复：模型显示名称（如 "Qwen/Qwen3-8B"），用于消息保存
    /// 区别于 options.model_id（API 配置 ID），这个字段用于前端显示
    pub(crate) model_display_name: Option<String>,

    pub(crate) last_block_ended_at: Option<i64>,

    pub(crate) workspace_id: Option<String>,
    pub(crate) workspace_injection_count: u32,

    /// 🆕 取消令牌：用于工具执行取消机制
    /// 从 Pipeline.execute() 传递，允许工具执行器响应取消请求
    pub(crate) cancellation_token: Option<CancellationToken>,

    /// 🔒 安全修复：连续心跳次数追踪
    /// 防止工具通过持续返回 continue_execution 无限绕过递归限制
    pub(crate) heartbeat_count: u32,
}

impl PipelineContext {
    pub(crate) fn new(request: SendMessageRequest) -> Self {
        // 如果前端传递了消息 ID，使用前端的；否则后端生成
        let user_message_id = request
            .user_message_id
            .clone()
            .unwrap_or_else(|| format!("msg_{}", Uuid::new_v4()));
        let assistant_message_id = request
            .assistant_message_id
            .clone()
            .unwrap_or_else(|| format!("msg_{}", Uuid::new_v4()));

        Self {
            session_id: request.session_id,
            user_message_id,
            assistant_message_id,
            user_content: request.content,
            // ★ 2025-12-10 统一改造：附件不再通过 request.attachments 传递
            // 所有附件现在通过 user_context_refs 传递
            attachments: Vec::new(),
            chat_history: Vec::new(),
            retrieved_sources: MessageSources::default(),
            options: request.options.unwrap_or_default(),
            tool_results: Vec::new(),
            final_content: String::new(),
            final_reasoning: None,
            active_blocks: HashMap::new(),
            generated_blocks: Vec::new(),
            streaming_thinking_block_id: None,
            streaming_content_block_id: None,
            streaming_retrieval_block_ids: HashMap::new(),
            tool_results_added_count: 0,
            start_time: Instant::now(),
            token_usage: TokenUsage::default(),
            // Interleaved Thinking 支持
            interleaved_block_ids: Vec::new(),
            interleaved_blocks: Vec::new(),
            global_block_index: 0,
            pending_reasoning_for_api: None,
            pending_thought_signature: None,
            current_adapter: None,
            // 统一上下文注入系统支持
            user_context_refs: request.user_context_refs.clone().unwrap_or_default(),
            // ★ 文档28 Prompt10：初始化 context_snapshot 时设置 path_map
            context_snapshot: {
                let mut snapshot = ContextSnapshot::new();
                if let Some(path_map) = request.path_map {
                    snapshot.path_map = path_map;
                }
                snapshot
            },
            model_display_name: None,
            last_block_ended_at: None,
            workspace_id: request.workspace_id.clone(),
            workspace_injection_count: 0,
            cancellation_token: None,
            heartbeat_count: 0,
        }
    }

    /// 🆕 设置取消令牌
    pub(crate) fn set_cancellation_token(&mut self, token: CancellationToken) {
        self.cancellation_token = Some(token);
    }

    /// 🆕 获取取消令牌（如果有）
    pub(crate) fn cancellation_token(&self) -> Option<&CancellationToken> {
        self.cancellation_token.as_ref()
    }

    /// 获取经过的时间（毫秒）
    pub(crate) fn elapsed_ms(&self) -> u64 {
        self.start_time.elapsed().as_millis() as u64
    }

    /// 添加工具调用结果
    pub(crate) fn add_tool_results(&mut self, results: Vec<ToolResultInfo>) {
        self.tool_results.extend(results);
    }

    /// 将**所有**工具调用结果转换为 LLM 消息格式
    ///
    /// 🔧 P2修复：每次递归调用时，需要包含所有历史工具结果，而不是只有新的。
    /// 因为 messages 每次都从 ctx.chat_history.clone() 重新构建，之前添加的工具结果不会被保留。
    pub(crate) fn all_tool_results_to_messages(&self) -> Vec<LegacyChatMessage> {
        self.tool_results_to_messages_impl(&self.tool_results)
    }

    /// 将工具调用结果转换为 LLM 消息格式
    ///
    /// 按照 OpenAI/DeepSeek 工具调用协议，返回正确顺序的消息：
    /// 1. 一个 assistant 消息，包含 tool_calls（以及可选的 thinking_content 用于 DeepSeek reasoner）
    /// 2. 多个 tool 消息，对应每个工具调用的结果
    ///
    /// ## DeepSeek Thinking Mode 支持
    /// 根据 DeepSeek API 文档，在工具调用迭代中，需要将上一轮的 reasoning_content 回传给 API。
    /// 第一个 assistant 消息会包含 `thinking_content` 字段（对应 DeepSeek 的 `reasoning_content`）。
    ///
    /// 🔧 P1修复：只返回尚未添加到消息历史的工具结果，避免递归时重复添加
    /// 🔧 P2修复：此方法已废弃，请使用 all_tool_results_to_messages()
    #[allow(dead_code)]
    pub(crate) fn tool_results_to_messages(&self) -> Vec<LegacyChatMessage> {
        // 只处理尚未添加到消息历史的工具结果
        let new_results = &self.tool_results[self.tool_results_added_count..];
        if new_results.is_empty() {
            return Vec::new();
        }

        let mut messages = Vec::new();
        let mut is_first_assistant_msg = true;

        // 1. 首先生成 assistant 消息（包含所有 tool_calls）
        // 按照 OpenAI 规范，assistant 消息必须在 tool 消息之前
        for result in new_results {
            // 为每个工具调用生成一个带 tool_call 的 assistant 消息
            let tool_call = crate::models::ToolCall {
                id: result.tool_call_id.clone().unwrap_or_default(),
                tool_name: result.tool_name.clone(),
                args_json: result.input.clone(),
            };

            // 🔧 DeepSeek Thinking Mode：第一个 assistant 消息包含 reasoning_content
            // 根据 DeepSeek API 文档，在工具调用迭代中需要回传 reasoning_content
            let thinking_content = if is_first_assistant_msg {
                is_first_assistant_msg = false;
                self.pending_reasoning_for_api.clone()
            } else {
                None
            };

            let assistant_msg = LegacyChatMessage {
                role: "assistant".to_string(),
                content: String::new(), // 工具调用时内容可为空
                timestamp: chrono::Utc::now(),
                thinking_content, // 🆕 回传 reasoning_content 给 DeepSeek API
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
            messages.push(assistant_msg);

            // 2. 紧跟对应的 tool 消息
            let tool_result = crate::models::ToolResult {
                call_id: result.tool_call_id.clone().unwrap_or_default(),
                ok: result.success,
                error: result.error.clone(),
                error_details: None,
                data_json: Some(result.output.clone()),
                usage: None,
                citations: None,
            };
            let tool_msg = LegacyChatMessage {
                role: "tool".to_string(),
                content: serde_json::to_string(&result.output).unwrap_or_default(),
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
            messages.push(tool_msg);
        }

        messages
    }

    /// 内部实现：将指定的工具结果转换为 LLM 消息格式
    fn tool_results_to_messages_impl(&self, results: &[ToolResultInfo]) -> Vec<LegacyChatMessage> {
        if results.is_empty() {
            return Vec::new();
        }

        let mut messages = Vec::new();

        for result in results {
            // 为每个工具调用生成一个带 tool_call 的 assistant 消息
            let tool_call = crate::models::ToolCall {
                id: result.tool_call_id.clone().unwrap_or_default(),
                tool_name: result.tool_name.clone(),
                args_json: result.input.clone(),
            };

            // 🔧 思维链修复：每个工具结果使用它自己的 reasoning_content
            // 这样多轮工具调用的思维链都能被正确保留和回传
            let thinking_content = result.reasoning_content.clone();

            let assistant_msg = LegacyChatMessage {
                role: "assistant".to_string(),
                content: String::new(),
                timestamp: chrono::Utc::now(),
                thinking_content,
                thought_signature: result.thought_signature.clone(),
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
            messages.push(assistant_msg);

            // 紧跟对应的 tool 消息
            let tool_result = crate::models::ToolResult {
                call_id: result.tool_call_id.clone().unwrap_or_default(),
                ok: result.success,
                error: result.error.clone(),
                error_details: None,
                data_json: Some(result.output.clone()),
                usage: None,
                citations: None,
            };

            // 🔧 修复：当工具失败时，content 应包含错误信息而非空的 output
            // 这样 LLM 才能知道工具调用失败的原因并做出合理响应
            let tool_content = if result.success {
                // 成功时使用 output
                serde_json::to_string(&result.output).unwrap_or_default()
            } else {
                // 失败时优先使用 error，若 error 为空则回退到 output
                if let Some(ref err) = result.error {
                    if !err.is_empty() {
                        format!("Error: {}", err)
                    } else {
                        serde_json::to_string(&result.output).unwrap_or_default()
                    }
                } else {
                    serde_json::to_string(&result.output).unwrap_or_default()
                }
            };

            let tool_msg = LegacyChatMessage {
                role: "tool".to_string(),
                content: tool_content,
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
            messages.push(tool_msg);
        }

        messages
    }

    // ========== Interleaved Thinking 辅助方法 ==========

    /// 添加一个块到交替块列表（按时序累积）
    ///
    /// 用于 thinking→tool→thinking→content 交替模式，确保块 ID 按生成顺序累积。
    ///
    /// ## 参数
    /// - `block`: 要添加的块
    ///
    /// ## 返回
    /// 块被分配的 block_index
    pub(crate) fn add_interleaved_block(&mut self, mut block: MessageBlock) -> u32 {
        let index = self.global_block_index;
        block.block_index = index;
        self.global_block_index += 1;
        self.interleaved_block_ids.push(block.id.clone());
        self.interleaved_blocks.push(block);
        index
    }

    /// 收集本轮 LLM 调用产生的 thinking 和 content 块
    ///
    /// 在递归调用 execute_with_tools 之前调用，将本轮产生的块添加到交替列表。
    ///
    /// ## 参数
    /// - `thinking_block_id`: thinking 块 ID（如果有）
    /// - `thinking_content`: thinking 内容（如果有）
    /// - `content_block_id`: content 块 ID（如果有）
    /// - `content_text`: content 内容（如果有）
    /// - `message_id`: 消息 ID
    pub(crate) fn collect_round_blocks(
        &mut self,
        thinking_block_id: Option<String>,
        thinking_content: Option<String>,
        content_block_id: Option<String>,
        content_text: Option<String>,
        message_id: &str,
    ) {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let context_start_ms = now_ms - self.elapsed_ms() as i64;

        // 添加 thinking 块（如果有）
        if let (Some(block_id), Some(content)) = (thinking_block_id, thinking_content) {
            if !content.is_empty() {
                // 🔧 P3修复：使用上一个块的结束时间作为本块的开始时间
                // 第一个块使用 context 开始时间
                let started_at = self.last_block_ended_at.unwrap_or(context_start_ms);
                let block = MessageBlock {
                    id: block_id,
                    message_id: message_id.to_string(),
                    block_type: block_types::THINKING.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: Some(content),
                    tool_name: None,
                    tool_input: None,
                    tool_output: None,
                    citations: None,
                    error: None,
                    started_at: Some(started_at),
                    ended_at: Some(now_ms),
                    // 🔧 递归调用时使用 started_at 作为 first_chunk_at
                    first_chunk_at: Some(started_at),
                    block_index: 0, // 会被 add_interleaved_block 重新设置
                };
                self.add_interleaved_block(block);
                // 🔧 P3修复：更新上一个块的结束时间
                self.last_block_ended_at = Some(now_ms);
            }
        }

        // 添加 content 块（如果有）
        // 注意：在工具调用后可能没有 content（LLM 返回的是 tool_use）
        if let (Some(block_id), Some(content)) = (content_block_id, content_text) {
            if !content.is_empty() {
                // 🔧 P3修复：使用上一个块的结束时间作为本块的开始时间
                let started_at = self.last_block_ended_at.unwrap_or(context_start_ms);
                let block = MessageBlock {
                    id: block_id,
                    message_id: message_id.to_string(),
                    block_type: block_types::CONTENT.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: Some(content),
                    tool_name: None,
                    tool_input: None,
                    tool_output: None,
                    citations: None,
                    error: None,
                    started_at: Some(started_at),
                    ended_at: Some(now_ms),
                    // 🔧 递归调用时使用 started_at 作为 first_chunk_at
                    first_chunk_at: Some(started_at),
                    block_index: 0,
                };
                self.add_interleaved_block(block);
                // 🔧 P3修复：更新上一个块的结束时间
                self.last_block_ended_at = Some(now_ms);
            }
        }
    }

    /// 添加工具调用块到交替列表
    ///
    /// ## 参数
    /// - `tool_result`: 工具调用结果
    /// - `message_id`: 消息 ID
    pub(crate) fn add_tool_block(&mut self, tool_result: &ToolResultInfo, message_id: &str) {
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 使用工具结果中记录的 block_id
        let block_id = tool_result
            .block_id
            .clone()
            .unwrap_or_else(|| MessageBlock::generate_id());

        // 🔧 P0 修复：检索工具使用正确的块类型，而非通用的 mcp_tool
        // 这样前端 sourceAdapter 能正确从 toolOutput.sources 中提取来源
        let block_type = Self::get_block_type_for_tool(&tool_result.tool_name);

        // 工具块使用自己的执行时间（有记录的 duration_ms）
        let started_at = now_ms - tool_result.duration_ms.unwrap_or(0) as i64;
        let block = MessageBlock {
            id: block_id,
            message_id: message_id.to_string(),
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
            ended_at: Some(now_ms),
            // 🔧 工具块使用 started_at 作为排序依据
            first_chunk_at: Some(started_at),
            block_index: 0,
        };
        self.add_interleaved_block(block);
        // 🔧 P3修复：更新上一个块的结束时间，让后续 thinking 块能正确计算时间
        self.last_block_ended_at = Some(now_ms);
    }

    /// 检查是否有交替块（用于判断是否使用新的保存逻辑）
    pub(crate) fn has_interleaved_blocks(&self) -> bool {
        !self.interleaved_block_ids.is_empty()
    }

    /// 根据工具名称获取正确的块类型
    ///
    /// 🔧 P0 修复：检索工具（builtin-*_search）使用语义化的块类型，
    /// 这样前端 sourceAdapter 能正确识别并从 toolOutput.sources 中提取来源。
    ///
    /// ## 映射规则
    /// - `builtin-rag_search` / `builtin-multimodal_search` / `builtin-unified_search` → `rag`
    /// - `builtin-memory_search` → `memory`
    /// - `builtin-web_search` → `web_search`
    /// - 其他工具 → `mcp_tool`
    fn get_block_type_for_tool(tool_name: &str) -> String {
        Self::get_block_type_for_tool_static(tool_name)
    }

    pub fn get_block_type_for_tool_static(tool_name: &str) -> String {
        let stripped = tool_name.strip_prefix("builtin-").unwrap_or(tool_name);

        match stripped {
            "rag_search" | "multimodal_search" | "unified_search" => block_types::RAG.to_string(),
            "memory_search" => block_types::MEMORY.to_string(),
            "web_search" => block_types::WEB_SEARCH.to_string(),
            "arxiv_search" | "scholar_search" => block_types::ACADEMIC_SEARCH.to_string(),
            "coordinator_sleep" => block_types::SLEEP.to_string(),
            "subagent_call" => block_types::SUBAGENT_EMBED.to_string(),
            "ask_user" => block_types::ASK_USER.to_string(),
            _ => block_types::MCP_TOOL.to_string(),
        }
    }

    // ========== 统一上下文注入系统方法 ==========

    /// 从上下文引用构建用户内容块
    ///
    /// 将 SendContextRef 列表中的 formattedBlocks 拼接成 ContentBlock 列表。
    /// 后端直接使用 formattedBlocks，不关心具体类型。
    ///
    /// ## 约束
    /// - 后端直接使用 formattedBlocks，不需要知道资源的具体类型
    /// - 按照引用顺序拼接，保持前端定义的顺序
    ///
    /// ## 参数
    /// - `refs`: SendContextRef 列表（包含格式化后的内容块）
    ///
    /// ## 返回
    /// 拼接后的 ContentBlock 列表
    pub(crate) fn build_user_content_from_context_refs(
        refs: &[SendContextRef],
    ) -> Vec<ContentBlock> {
        let mut blocks = Vec::new();
        for context_ref in refs {
            blocks.extend(context_ref.formatted_blocks.clone());
        }
        log::debug!(
            "[ChatV2::pipeline] Built {} content blocks from {} context refs",
            blocks.len(),
            refs.len()
        );
        blocks
    }

    /// 获取合并后的用户内容（统一上下文注入系统）
    ///
    /// 将 user_context_refs 中的 formattedBlocks 与 user_content 合并。
    ///
    /// ## 组装顺序（用户输入优先）
    /// 1. `<user_query>` - 用户输入内容（用 XML 标签包裹，确保 LLM 注意力聚焦）
    /// 2. `<injected_context>` - 注入的上下文内容（防止过长内容淹没用户输入）
    ///
    /// ## 返回
    /// - 合并后的用户内容文本
    /// - 从 formattedBlocks 中提取的图片 base64 列表
    pub(crate) fn get_combined_user_content(&self) -> (String, Vec<String>) {
        let mut combined_text = String::new();
        let mut context_images: Vec<String> = Vec::new();
        let mut context_text = String::new();

        // 1. 首先添加用户输入（用 XML 标签包裹，确保 LLM 注意力聚焦）
        // 安全：转义用户输入中的 XML 特殊字符，防止通过 </user_query> 闭合标签篡改 prompt 结构
        if !self.user_content.is_empty() {
            combined_text.push_str(&format!(
                "<user_query>\n{}\n</user_query>",
                escape_xml_content(&self.user_content)
            ));
        }

        // 2. 处理上下文引用的 formattedBlocks
        if !self.user_context_refs.is_empty() {
            let content_blocks =
                Self::build_user_content_from_context_refs(&self.user_context_refs);

            for block in content_blocks {
                match block {
                    ContentBlock::Text { text } => {
                        if !context_text.is_empty() {
                            context_text.push_str("\n\n");
                        }
                        context_text.push_str(&text);
                    }
                    ContentBlock::Image { base64, .. } => {
                        // 图片类型的 ContentBlock 添加到图片列表
                        context_images.push(base64);
                    }
                }
            }

            // 3. 将上下文内容追加到用户输入后面（用 XML 标签包裹）
            if !context_text.is_empty() {
                if !combined_text.is_empty() {
                    combined_text.push_str("\n\n");
                }
                combined_text.push_str(&format!(
                    "<injected_context>\n{}\n</injected_context>",
                    context_text
                ));
            }
        }

        log::debug!(
            "[ChatV2::pipeline] Combined user content: context_refs={}, context_images={}, total_len={}",
            self.user_context_refs.len(),
            context_images.len(),
            combined_text.len()
        );

        (combined_text, context_images)
    }

    /// 将用户上下文引用转换为 ContextRef（丢弃 formattedBlocks）
    ///
    /// 消息保存时只存 ContextRef，不存实际内容。
    ///
    /// ## 参数
    /// - `refs`: SendContextRef 列表
    ///
    /// ## 返回
    /// ContextRef 列表
    pub(crate) fn convert_to_context_refs(refs: &[SendContextRef]) -> Vec<ContextRef> {
        refs.iter().map(|r| r.to_context_ref()).collect()
    }

    /// 初始化上下文快照（填充 user_refs）
    ///
    /// 在消息发送开始时调用，将用户上下文引用保存到快照中。
    pub(crate) fn init_context_snapshot(&mut self) {
        // 将 SendContextRef 转换为 ContextRef
        for send_ref in &self.user_context_refs {
            self.context_snapshot
                .add_user_ref(send_ref.to_context_ref());
        }
        log::debug!(
            "[ChatV2::pipeline] Initialized context snapshot with {} user refs",
            self.context_snapshot.user_refs.len()
        );
    }

    /// 添加检索结果到上下文快照
    ///
    /// 检索结果创建资源后调用，将检索上下文引用添加到快照中。
    ///
    /// ## 参数
    /// - `refs`: 检索资源的 ContextRef 列表
    pub(crate) fn add_retrieval_refs_to_snapshot(&mut self, refs: Vec<ContextRef>) {
        for context_ref in refs {
            self.context_snapshot.add_retrieval_ref(context_ref);
        }
        log::debug!(
            "[ChatV2::pipeline] Added {} retrieval refs to context snapshot",
            self.context_snapshot.retrieval_refs.len()
        );
    }

    /// ★ 获取保持原始顺序的内容块列表（支持图文交替）
    ///
    /// 用于多模态场景，保持 ContentBlock 的原始顺序（图片和文本交替）。
    /// 这个方法不会将文本合并或将图片分离，而是保持前端/格式化模块返回的原始顺序。
    ///
    /// ## 组装顺序
    /// 1. `<user_query>` 文本块（用户输入）
    /// 2. `<injected_context>` 开始标签
    /// 3. 按原始顺序的 ContentBlock（图片和文本交替）
    /// 4. `</injected_context>` 结束标签
    ///
    /// ## 返回
    /// - `Vec<ContentBlock>`: 保持原始顺序的内容块列表
    ///
    /// ## 用途
    /// - 多模态 AI 模型（如 GPT-4V、Claude 3）需要图文交替的输入格式
    /// - 题目集识别等混合类型数据的上下文注入
    ///
    /// ★ 文档25：此方法现在被 build_current_user_message 调用
    pub(crate) fn get_content_blocks_ordered(&self) -> Vec<ContentBlock> {
        let mut blocks: Vec<ContentBlock> = Vec::new();

        // 1. 用户输入在前（用 XML 标签包裹）
        // 安全：转义用户输入中的 XML 特殊字符，防止通过 </user_query> 闭合标签篡改 prompt 结构
        if !self.user_content.is_empty() {
            blocks.push(ContentBlock::text(format!(
                "<user_query>\n{}\n</user_query>",
                escape_xml_content(&self.user_content)
            )));
        }

        // 2. 处理上下文引用的 formattedBlocks（保持原始顺序）
        if !self.user_context_refs.is_empty() {
            let content_blocks =
                Self::build_user_content_from_context_refs(&self.user_context_refs);

            if !content_blocks.is_empty() {
                // 添加开始标签
                blocks.push(ContentBlock::text("<injected_context>".to_string()));

                // 按原始顺序添加所有 ContentBlock
                blocks.extend(content_blocks);

                // 添加结束标签
                blocks.push(ContentBlock::text("</injected_context>".to_string()));
            }
        }

        log::debug!(
            "[ChatV2::pipeline] get_content_blocks_ordered: total_blocks={}",
            blocks.len()
        );

        blocks
    }

    /// ★ 构建多模态消息内容（用于 LLM 请求体）
    ///
    /// 将 ContentBlock 列表转换为 LLM API 所需的 JSON 格式。
    /// 支持 OpenAI/Anthropic/Gemini 的多模态消息格式。
    ///
    /// ## 参数
    /// - `content_blocks`: ContentBlock 列表
    ///
    /// ## 返回
    /// - `Vec<serde_json::Value>`: JSON 格式的消息内容部分
    #[allow(dead_code)]
    pub fn build_multimodal_message_parts(
        content_blocks: &[ContentBlock],
    ) -> Vec<serde_json::Value> {
        use serde_json::json;

        content_blocks
            .iter()
            .map(|block| match block {
                ContentBlock::Text { text } => {
                    json!({
                        "type": "text",
                        "text": text
                    })
                }
                ContentBlock::Image { media_type, base64 } => {
                    json!({
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:{};base64,{}", media_type, base64)
                        }
                    })
                }
            })
            .collect()
    }

    // ========== 工作区消息注入方法 ==========

    /// 注入工作区消息到聊天历史
    ///
    /// 将工作区消息格式化为系统消息并添加到聊天历史中，
    /// 使 LLM 能够感知并响应工作区中的通信。
    ///
    /// ## 参数
    /// - `formatted_messages`: 格式化后的工作区消息字符串
    ///
    /// ## 返回
    /// 是否成功注入
    pub(crate) fn inject_workspace_messages(&mut self, formatted_messages: String) -> bool {
        if formatted_messages.is_empty() {
            return false;
        }

        // 创建一个系统消息来传递工作区消息
        let workspace_msg = LegacyChatMessage {
            role: "user".to_string(), // 使用 user 角色，因为这代表来自其他 Agent 的消息
            content: formatted_messages,
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
            metadata: Some(serde_json::json!({
                "workspace_injection": true,
                "workspace_id": self.workspace_id
            })),
        };

        self.chat_history.push(workspace_msg);
        self.workspace_injection_count += 1;

        log::debug!(
            "[ChatV2::context] Injected workspace messages, total injections: {}",
            self.workspace_injection_count
        );

        true
    }

    /// 检查是否需要继续执行（有待处理的工作区消息时）
    ///
    /// ## 返回
    /// 是否需要继续 LLM 调用
    pub(crate) fn should_continue_for_workspace(&self) -> bool {
        // 如果本轮有注入过工作区消息，需要继续执行让 LLM 处理
        self.workspace_injection_count > 0 && self.workspace_id.is_some()
    }

    /// 获取工作区 ID（如果有）
    pub(crate) fn get_workspace_id(&self) -> Option<&str> {
        self.workspace_id.as_deref()
    }

    /// 设置工作区 ID
    pub(crate) fn set_workspace_id(&mut self, workspace_id: Option<String>) {
        self.workspace_id = workspace_id;
    }

    /// 获取本轮工作区消息注入次数
    pub(crate) fn get_workspace_injection_count(&self) -> u32 {
        self.workspace_injection_count
    }

    /// 重置工作区注入计数（新一轮 LLM 调用开始时）
    pub(crate) fn reset_workspace_injection_count(&mut self) {
        self.workspace_injection_count = 0;
    }
}
