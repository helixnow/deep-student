use super::*;

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
    /// 🔧 Gemini 3 思维签名缓存：工具调用场景下必须在后续请求中回传
    cached_thought_signature: std::sync::Mutex<Option<String>>,
    /// tool_call_id → preparing block_id 映射（用于 args delta chunk 寻址）
    preparing_block_ids: std::sync::Mutex<HashMap<String, String>>,
    /// tool_call_id → 累积的 args delta（节流缓冲，减少事件频率）
    args_delta_buffer: std::sync::Mutex<HashMap<String, String>>,
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
            cached_thought_signature: std::sync::Mutex::new(None),
            preparing_block_ids: std::sync::Mutex::new(HashMap::new()),
            args_delta_buffer: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// 生成块 ID
    pub(crate) fn generate_block_id() -> String {
        format!("blk_{}", Uuid::new_v4())
    }

    /// 刷新指定 tool_call_id 的 args delta 缓冲（参数累积完成时调用）
    fn flush_args_delta_buffer(&self, tool_call_id: &str) {
        let block_id = {
            let mut guard = self
                .preparing_block_ids
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            guard.remove(tool_call_id)
        };
        if let Some(block_id) = block_id {
            let chunk = {
                let mut guard = self
                    .args_delta_buffer
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                guard.remove(tool_call_id).unwrap_or_default()
            };
            if !chunk.is_empty() {
                self.emitter
                    .emit_chunk(event_types::TOOL_CALL_PREPARING, &block_id, &chunk, None);
            }
        }
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

    /// 获取缓存的 Gemini 3 思维签名（如果有）
    pub fn get_thought_signature(&self) -> Option<String> {
        self.cached_thought_signature
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
    pub(crate) fn ends_with_potential_think_start(s: &str) -> bool {
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
    pub(crate) fn ends_with_potential_think_end(s: &str) -> bool {
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

    pub(crate) fn is_builtin_retrieval_tool(tool_name: &str) -> bool {
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

        // 生成 block_id 并存储映射，供后续 args delta chunk 使用
        let block_id = Self::generate_block_id();
        {
            let mut guard = self
                .preparing_block_ids
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            guard.insert(tool_call_id.to_string(), block_id.clone());
        }

        self.emitter.emit_tool_call_preparing(
            &self.message_id,
            tool_call_id,
            tool_name,
            Some(&block_id),
        );
    }

    /// 工具调用参数流式片段回调（带节流）
    /// 每累积 ≥500 字符发射一次 chunk，避免事件风暴
    fn on_tool_call_args_delta(&self, tool_call_id: &str, delta: &str) {
        let block_id = {
            let guard = self
                .preparing_block_ids
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match guard.get(tool_call_id) {
                Some(id) => id.clone(),
                None => return,
            }
        };

        let should_flush = {
            let mut guard = self
                .args_delta_buffer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let entry = guard.entry(tool_call_id.to_string()).or_default();
            entry.push_str(delta);
            entry.len() >= 500
        };

        if should_flush {
            let chunk = {
                let mut guard = self
                    .args_delta_buffer
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                guard.remove(tool_call_id).unwrap_or_default()
            };
            if !chunk.is_empty() {
                self.emitter
                    .emit_chunk(event_types::TOOL_CALL_PREPARING, &block_id, &chunk, None);
            }
        }
    }

    fn on_thought_signature(&self, signature: &str) {
        log::info!(
            "[ChatV2::pipeline] Cached thought_signature: len={}",
            signature.len()
        );
        let mut guard = self
            .cached_thought_signature
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *guard = Some(signature.to_string());
    }

    fn on_tool_call(&self, msg: &LegacyChatMessage) {
        // 从 ChatMessage 中提取工具调用信息
        if let Some(ref tool_call) = msg.tool_call {
            let tool_call_id = &tool_call.id;
            let tool_name = &tool_call.tool_name;
            let tool_input = tool_call.args_json.clone();

            // 刷新该工具调用剩余的 args delta 缓冲
            self.flush_args_delta_buffer(tool_call_id);

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
