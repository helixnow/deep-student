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
    // - 嵌套 output_tokens_details.reasoning_tokens（OpenAI Responses API 标准格式）
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
        })
        .or_else(|| {
            usage
                .get("output_tokens_details")
                .and_then(|d| d.get("reasoning_tokens"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
        });

    // 提取缓存命中 token（业界最佳实践 LiteLLM 对齐）
    //
    // 归一化规则：
    // - Anthropic: cache_read_input_tokens 才是缓存命中；
    //   cache_creation_input_tokens 是计费元数据（写入缓存），不计入缓存命中
    // - OpenAI Chat Completions: prompt_tokens_details.cached_tokens
    // - OpenAI/DeepSeek Responses: input_tokens_details.cached_tokens
    // - DeepSeek CC: prompt_cache_hit_tokens
    // - Gemini: cached_tokens（顶层，由 gemini-openai-converter 注入）
    //
    // 防中转站重复：使用 max() 而非 sum()
    // 网关（LiteLLM/OneAPI）可能同时返回多种格式表示同一份缓存数据
    let anthropic_cache_hit = usage
        .get("cache_read_input_tokens")
        .and_then(|v| v.as_u64());
    let openai_cached = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64());
    let responses_cached = usage
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64());
    let deepseek_cached = usage
        .get("prompt_cache_hit_tokens")
        .and_then(|v| v.as_u64());
    let gemini_cached = usage.get("cached_tokens").and_then(|v| v.as_u64());
    // Presence is the measurement signal: an explicit 0 is a measured miss,
    // while no supported field at all is an unmeasured request.
    let cached_tokens = [
        anthropic_cache_hit,
        openai_cached,
        responses_cached,
        deepseek_cached,
        gemini_cached,
    ]
    .into_iter()
    .flatten()
    .max()
    .map(|tokens| tokens.min(u32::MAX as u64) as u32);

    // 提取缓存写入 token（计费元数据，不计入命中；观测用）
    // - Anthropic: cache_creation_input_tokens
    // - OpenAI/DeepSeek Responses: input_tokens_details.cache_write_tokens
    // - 部分网关：顶层 cache_write_tokens
    // 同一份写入量可能以多种格式重复出现，同样用 max() 归一
    let anthropic_cache_write = usage
        .get("cache_creation_input_tokens")
        .and_then(|v| v.as_u64());
    let responses_cache_write = usage
        .get("input_tokens_details")
        .and_then(|d| d.get("cache_write_tokens"))
        .and_then(|v| v.as_u64());
    let gateway_cache_write = usage.get("cache_write_tokens").and_then(|v| v.as_u64());
    let cache_write_tokens = [
        anthropic_cache_write,
        responses_cache_write,
        gateway_cache_write,
    ]
    .into_iter()
    .flatten()
    .max()
    .map(|tokens| tokens.min(u32::MAX as u64) as u32);

    let mut token_usage =
        TokenUsage::from_api_with_cache(prompt, completion, reasoning_tokens, cached_tokens);
    token_usage.cache_write_tokens = cache_write_tokens;
    Some(token_usage)
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
    skill_state_version: Option<u64>,
    round_id: Option<String>,
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
    /// API 是否返回过 reasoning_content 字段，即使字段值为空字符串也要保留。
    reasoning_content_observed: std::sync::Mutex<bool>,
    /// 收集的工具调用（用于递归处理）
    collected_tool_calls: std::sync::Mutex<Vec<ToolCall>>,
    /// 存储 API 返回的 usage（用于 Token 统计）
    api_usage: std::sync::Mutex<Option<TokenUsage>>,
    /// 🔧 <think> 标签解析状态：是否当前在 <think> 标签内部
    in_think_tag: std::sync::Mutex<bool>,
    /// 🔧 <think> 标签解析缓冲区：用于处理跨 chunk 的标签边界
    think_tag_buffer: std::sync::Mutex<String>,
    /// GLM/Qwen 路由专用的协议包装 token 流式过滤器（content 路径）。
    wrap_token_filter:
        std::sync::Mutex<crate::utils::model_special_tokens::ModelWrapTokenStreamFilter>,
    /// reasoning 路径专用的**独立**包装 token 过滤器（Wave2-A R4 #1）。
    /// 不与 content 路径的 `wrap_token_filter` 共享实例：过滤器持有跨 chunk 的
    /// 行前缀/围栏状态，reasoning 与 content 两路交错到达会互相污染行状态。
    reasoning_wrap_token_filter:
        std::sync::Mutex<crate::utils::model_special_tokens::ModelWrapTokenStreamFilter>,
    /// 🔧 Gemini 3 思维签名缓存：工具调用场景下必须在后续请求中回传
    cached_thought_signature: std::sync::Mutex<Option<String>>,
    /// OpenAI Responses reasoning items，按响应顺序收集（一次响应可含多个）。
    /// 每个条目为 `(配对的 tool_call_id, 完整 item)`：reasoning item 在流中
    /// 紧邻其后继 function_call，`on_tool_call_start` 到达时把最近一个未配对
    /// 条目配到该 tool_call_id（禁止把所有 item 绑到本批第一个 tool id）。
    /// 纯文本轮（无 function_call）条目保持未配对，由调用方按最终 assistant
    /// 语义持久化回放。
    response_reasoning_items: std::sync::Mutex<Vec<(Option<String>, Value)>>,
    /// tool_call_id → preparing block_id 映射（用于 args delta chunk 寻址）
    preparing_block_ids: std::sync::Mutex<HashMap<String, String>>,
    /// tool_call_id → 累积的 args delta（节流缓冲，减少事件频率）
    args_delta_buffer: std::sync::Mutex<HashMap<String, String>>,
    /// 🔧 F2 修复：最近一次收到流式数据的时刻（用于空闲超时判定）
    last_activity_at: std::sync::Mutex<std::time::Instant>,
    /// 🆕 2026-08: 服务端联网搜索（DeepSeek Responses web_search 工具）块 ID
    web_search_block_id: std::sync::Mutex<Option<String>>,
    /// 🆕 服务端搜索开始时刻（用于 end 事件 durationMs）
    web_search_started_at: std::sync::Mutex<Option<std::time::Instant>>,
    /// 🆕 服务端搜索收集到的来源（供 pipeline 持久化检索块）
    cached_web_search_sources: std::sync::Mutex<Option<Vec<SourceInfo>>>,
    /// P2-13 收尾：服务端 `web_search_call` 完整 item（流事件 `item` 键，
    /// 按 id 去重、后到覆盖），供 pipeline 写入 assistant 消息 meta 并在
    /// 下一轮 Responses 请求中原样回传 input
    cached_web_search_items: std::sync::Mutex<Vec<Value>>,
}

impl ChatV2LLMAdapter {
    pub fn new(
        emitter: Arc<ChatV2EventEmitter>,
        message_id: String,
        enable_thinking: bool,
        skill_state_version: Option<u64>,
        round_id: Option<String>,
        wrap_token_policy: crate::utils::model_special_tokens::ModelWrapTokenPolicy,
    ) -> Self {
        Self {
            emitter,
            message_id,
            enable_thinking,
            skill_state_version,
            round_id,
            thinking_block_id: std::sync::Mutex::new(None),
            finalized_thinking_block_id: std::sync::Mutex::new(None),
            content_block_id: std::sync::Mutex::new(None),
            accumulated_content: std::sync::Mutex::new(String::new()),
            accumulated_reasoning: std::sync::Mutex::new(String::new()),
            reasoning_content_observed: std::sync::Mutex::new(false),
            collected_tool_calls: std::sync::Mutex::new(Vec::new()),
            api_usage: std::sync::Mutex::new(None),
            in_think_tag: std::sync::Mutex::new(false),
            think_tag_buffer: std::sync::Mutex::new(String::new()),
            wrap_token_filter: std::sync::Mutex::new(
                crate::utils::model_special_tokens::ModelWrapTokenStreamFilter::new(
                    wrap_token_policy,
                ),
            ),
            reasoning_wrap_token_filter: std::sync::Mutex::new(
                crate::utils::model_special_tokens::ModelWrapTokenStreamFilter::new(
                    wrap_token_policy,
                ),
            ),
            cached_thought_signature: std::sync::Mutex::new(None),
            response_reasoning_items: std::sync::Mutex::new(Vec::new()),
            preparing_block_ids: std::sync::Mutex::new(HashMap::new()),
            args_delta_buffer: std::sync::Mutex::new(HashMap::new()),
            last_activity_at: std::sync::Mutex::new(std::time::Instant::now()),
            web_search_block_id: std::sync::Mutex::new(None),
            web_search_started_at: std::sync::Mutex::new(None),
            cached_web_search_sources: std::sync::Mutex::new(None),
            cached_web_search_items: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// 生成块 ID
    pub(crate) fn generate_block_id() -> String {
        format!("blk_{}", Uuid::new_v4())
    }

    /// 🔧 F2 修复：刷新流式活动时间戳（每次收到任何流式数据时调用）
    fn touch_activity(&self) {
        *self
            .last_activity_at
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = std::time::Instant::now();
    }

    /// 🔧 F2 修复：距最近一次流式活动的时长（用于 Pipeline 层空闲超时判定）
    pub fn idle_elapsed(&self) -> std::time::Duration {
        self.last_activity_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .elapsed()
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
        self.finalize_all_inner(false);
    }

    fn finalize_all_with_authoritative_content(&self) {
        self.finalize_all_inner(true);
    }

    fn finalize_all_inner(&self, include_authoritative_content: bool) {
        let filter_tail = self
            .wrap_token_filter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .flush();
        if !filter_tail.is_empty() {
            self.think_tag_buffer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push_str(&filter_tail);
        }

        // reasoning 路径独立过滤器的尾巴直接归 thinking：reasoning 通道
        // 不参与 <think> 标签状态机，不得回灌 think_tag_buffer
        let reasoning_tail = self
            .reasoning_wrap_token_filter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .flush();
        if !reasoning_tail.is_empty() && self.enable_thinking {
            {
                let mut guard = self
                    .accumulated_reasoning
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                guard.push_str(&reasoning_tail);
            }
            if let Some(block_id) = self.ensure_thinking_started() {
                self.emitter
                    .emit_chunk(event_types::THINKING, &block_id, &reasoning_tail, None);
            }
        }

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
            let result = include_authoritative_content.then(|| {
                let content = self
                    .accumulated_content
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                json!({ "content": content })
            });
            self.emitter.emit_end(
                event_types::CONTENT,
                block_id,
                result,
                None, // variant_id
            );
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
        let observed = *self
            .reasoning_content_observed
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        log::info!(
            "[ChatV2::LLMAdapter] get_accumulated_reasoning: len={}, is_empty={}, observed={}",
            reasoning.len(),
            reasoning.is_empty(),
            observed
        );
        if observed || !reasoning.is_empty() {
            Some(reasoning)
        } else {
            None
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

    /// 重试前重置流式累积状态
    ///
    /// 外层重试（Pipeline 级超时/瞬时网络错误）复用同一 adapter 实例（Arc），
    /// 重新注册 hooks 并不会清空累积状态。若失败尝试已流出部分内容或已收集
    /// 工具调用，不重置会导致重试响应被追加到旧的部分内容之后（内容重复落库），
    /// 甚至同一工具调用被收集两次而重复执行。
    ///
    /// 注意：保留 thinking/content 块 ID，使重试内容继续写入同一前端块，
    /// 避免 UI 留下永远处于 running 状态的孤儿块。
    pub fn reset_stream_state(&self) {
        self.accumulated_content
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.accumulated_reasoning
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        *self
            .reasoning_content_observed
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = false;
        self.collected_tool_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        *self.api_usage.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.in_think_tag.lock().unwrap_or_else(|e| e.into_inner()) = false;
        self.think_tag_buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.wrap_token_filter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reset();
        self.reasoning_wrap_token_filter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reset();
        *self
            .cached_thought_signature
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        self.response_reasoning_items
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.preparing_block_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.args_delta_buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        *self
            .web_search_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .web_search_started_at
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .cached_web_search_sources
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        // 🔧 F2：重试视为一次新的流，重置空闲计时
        self.touch_activity();
        log::info!(
            "[ChatV2::LLMAdapter] Stream state reset for retry: message_id={}",
            self.message_id
        );
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

    /// 按响应顺序返回本轮收集的 Responses reasoning items。
    /// 条目为 `(配对的 tool_call_id, 完整 item)`；纯文本轮条目未配对（None）。
    pub fn get_response_reasoning_items(&self) -> Vec<(Option<String>, Value)> {
        self.response_reasoning_items
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 🆕 获取并清空服务端搜索收集到的来源（供 pipeline 保存检索块）。
    pub fn take_web_search_sources(&self) -> Option<Vec<SourceInfo>> {
        self.cached_web_search_sources
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    /// P2-13 收尾：获取并清空服务端 `web_search_call` 完整 item（供 pipeline
    /// 累积到 ctx 并随 assistant 消息 meta 持久化）。
    pub fn take_web_search_items(&self) -> Vec<Value> {
        std::mem::take(
            &mut *self
                .cached_web_search_items
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        )
    }

    /// 缓存流事件载荷里的完整 web_search_call item：按 id 去重，后到覆盖
    /// （completed 带 search_results，覆盖 in_progress 的骨架 item）。
    fn cache_web_search_item(&self, item: &Value) {
        let mut items = self
            .cached_web_search_items
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let id = item.get("id").and_then(Value::as_str);
        let existing = id.and_then(|id| {
            items
                .iter_mut()
                .find(|existing| existing.get("id").and_then(Value::as_str) == Some(id))
        });
        match existing {
            Some(existing) => *existing = item.clone(),
            None => items.push(item.clone()),
        }
    }

    /// 🆕 把服务端搜索载荷渲染为前端检索块事件。
    /// 载荷格式见 `StreamEvent::WebSearchCall`：
    /// `{"id","stage":"in_progress"|"searching"|"completed","sources":[{"title","url","snippet"}]}`
    fn handle_web_search(&self, payload: &Value) {
        // P2-13 收尾：载荷携带完整 web_search_call item 时缓存（写入 assistant
        // 消息 meta 键 openai_responses_web_search_items，下一轮原样回传 input）
        if let Some(item) = payload.get("item") {
            self.cache_web_search_item(item);
        }

        let stage = payload
            .get("stage")
            .and_then(Value::as_str)
            .unwrap_or("completed");

        if stage == "completed" {
            let sources: Vec<SourceInfo> = payload
                .get("sources")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| {
                            let url = entry.get("url").and_then(Value::as_str).unwrap_or_default();
                            if url.is_empty() {
                                return None;
                            }
                            Some(SourceInfo {
                                title: entry
                                    .get("title")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                url: Some(url.to_string()),
                                snippet: entry
                                    .get("snippet")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                score: None,
                                metadata: Some(json!({
                                    "sourceType": "web_search",
                                })),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            // 供 pipeline 持久化
            *self
                .cached_web_search_sources
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(sources.clone());

            // 兜底：服务端未发进度事件（in_progress/searching）直接 completed 时，
            // 必须补发 start 事件，否则前端永远不会创建 web_search 块
            let block_id = {
                let mut guard = self
                    .web_search_block_id
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                match guard.clone() {
                    Some(existing) => existing,
                    None => {
                        let generated = Self::generate_block_id();
                        self.emitter.emit_start(
                            event_types::WEB_SEARCH,
                            &self.message_id,
                            Some(&generated),
                            None,
                            None,
                        );
                        *guard = Some(generated.clone());
                        generated
                    }
                }
            };

            let duration_ms = self
                .web_search_started_at
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .map(|started| started.elapsed().as_millis() as u64)
                .unwrap_or(0);

            let numbered_sources: Vec<Value> = sources
                .iter()
                .enumerate()
                .map(|(index, source)| {
                    json!({
                        "index": index + 1,
                        "citationTag": format!("[搜索-{}]", index + 1),
                        "typeIndex": index + 1,
                        "title": source.title,
                        "url": source.url,
                        "snippet": source.snippet,
                        "score": source.score,
                        "source_type": "web_search",
                    })
                })
                .collect();

            self.emitter.emit_end(
                event_types::WEB_SEARCH,
                &block_id,
                Some(json!({
                    "sources": numbered_sources,
                    "count": sources.len(),
                    "durationMs": duration_ms,
                })),
                None,
            );
        } else {
            // in_progress / searching：创建（或复用）web_search 块
            let mut guard = self
                .web_search_block_id
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let block_id = match guard.clone() {
                Some(existing) => existing,
                None => {
                    let generated = Self::generate_block_id();
                    self.emitter.emit_start(
                        event_types::WEB_SEARCH,
                        &self.message_id,
                        Some(&generated),
                        None,
                        None,
                    );
                    *guard = Some(generated.clone());
                    generated
                }
            };
            *self
                .web_search_started_at
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
        }
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
        self.touch_activity();
        if text.is_empty() {
            return;
        }

        let filtered = self
            .wrap_token_filter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .process(text);
        if filtered.is_empty() {
            return;
        }

        // 🔧 <think> 标签解析：将 chunk 追加到缓冲区并处理
        {
            let mut buffer = self
                .think_tag_buffer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            buffer.push_str(&filtered);
        }
        self.process_think_tag_buffer();
    }

    fn on_reasoning_chunk(&self, text: &str) {
        self.touch_activity();
        if !self.enable_thinking {
            return;
        }

        *self
            .reasoning_content_observed
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = true;

        if text.is_empty() {
            return;
        }

        // R4 #1：独立 reasoning 过滤器（不与 content 路径共享行状态）。
        // 过滤后再累积/emit；被暂扣的片段由 finalize_all_inner 的 flush 尾巴兜底
        let filtered = self
            .reasoning_wrap_token_filter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .process(text);
        if filtered.is_empty() {
            return;
        }

        // 累积推理（简化日志：只输出 / 代表接收到 chunk）
        {
            let mut guard = self
                .accumulated_reasoning
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            guard.push_str(&filtered);
            // 每 500 字符输出一个 / 以减少日志量
            if guard.len() % 500 < filtered.len() {
                print!("/");
                use std::io::Write;
                let _ = std::io::stdout().flush();
            }
        }

        if let Some(block_id) = self.ensure_thinking_started() {
            self.emitter
                .emit_chunk(event_types::THINKING, &block_id, &filtered, None);
        }
    }

    /// 🆕 2026-01-15: 工具调用参数开始累积时通知前端
    /// 在 LLM 开始生成工具调用参数时立即调用，让前端显示"正在准备工具调用"
    fn on_tool_call_start(&self, tool_call_id: &str, tool_name: &str) {
        self.touch_activity();
        log::info!(
            "[ChatV2::pipeline] Tool call start: id={}, name={} (参数累积中...)",
            tool_call_id,
            tool_name
        );

        // Responses reasoning item 相邻配对：reasoning item 在流中先于其
        // function_call 到达，把最近一个未配对条目配到本 tool_call_id。
        // 同一 tool_call_id 可能触发多次 start（added 分块 + done 终态），
        // 已配对过的 id 不再重复认领，防止吞掉下一轮的 reasoning item。
        {
            let mut items = self
                .response_reasoning_items
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let already_claimed = items
                .iter()
                .any(|(id, _)| id.as_deref() == Some(tool_call_id));
            if !already_claimed {
                if let Some(entry) = items.iter_mut().rev().find(|(id, _)| id.is_none()) {
                    entry.0 = Some(tool_call_id.to_string());
                }
            }
        }

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

        // 生成 block_id 并存储映射，供后续 args delta chunk 使用。
        // 幂等：Responses 流式路径（output_item.added 分块 + arguments.done 终态）
        // 会对同一 tool_call_id 触发两次 start，复用已有 preparing 块避免 UI 重复
        let block_id = Self::generate_block_id();
        {
            let mut guard = self
                .preparing_block_ids
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if guard.contains_key(tool_call_id) {
                return;
            }
            guard.insert(tool_call_id.to_string(), block_id.clone());
        }

        self.emitter.register_block_event_meta(
            &block_id,
            None,
            self.skill_state_version,
            self.round_id.as_deref(),
        );

        self.emitter.emit_tool_call_preparing_with_meta(
            &self.message_id,
            tool_call_id,
            tool_name,
            Some(&block_id),
            None,
            self.skill_state_version,
            self.round_id.as_deref(),
        );
    }

    /// 工具调用参数流式片段回调（带节流）
    /// 每累积 ≥500 字符发射一次 chunk，避免事件风暴
    fn on_tool_call_args_delta(&self, tool_call_id: &str, delta: &str) {
        self.touch_activity();
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
                self.emitter.emit_chunk_with_meta(
                    event_types::TOOL_CALL_PREPARING,
                    &block_id,
                    &chunk,
                    None,
                    self.skill_state_version,
                    self.round_id.as_deref(),
                );
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

    fn on_response_reasoning_item(&self, item: &Value) {
        self.touch_activity();
        // 按响应顺序追加（禁止单值覆盖）；配对留给随后到达的 on_tool_call_start
        self.response_reasoning_items
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((None, item.clone()));
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
        self.touch_activity();
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

    fn on_web_search(&self, payload: &Value) {
        self.touch_activity();
        log::info!(
            "[ChatV2::pipeline] Server-side web search: stage={:?}",
            payload.get("stage").and_then(Value::as_str)
        );
        self.handle_web_search(payload);
    }

    fn on_complete(&self, _final_text: &str, _reasoning: Option<&str>) {
        // Incremental UI events are best-effort. Include the adapter's complete,
        // post-processed text in the terminal block event so the frontend can
        // reconcile a delayed or dropped tail before marking the block complete.
        self.finalize_all_with_authoritative_content();
    }
}

#[cfg(test)]
mod web_search_item_tests {
    use super::*;

    fn test_adapter() -> ChatV2LLMAdapter {
        let emitter = Arc::new(ChatV2EventEmitter::new_windowless_for_test(
            "sess_ws_items".to_string(),
        ));
        ChatV2LLMAdapter::new(
            emitter,
            "msg_ws_items".to_string(),
            false,
            None,
            None,
            crate::utils::model_special_tokens::ModelWrapTokenPolicy::Disabled,
        )
    }

    /// P2-13 收尾：流事件载荷携带的完整 web_search_call item 被缓存，
    /// 同 id 后到覆盖（completed 带 search_results 覆盖 in_progress 骨架），
    /// take 后清空。
    #[test]
    fn handle_web_search_caches_full_items_deduped_by_id() {
        let adapter = test_adapter();

        // in_progress：骨架 item
        adapter.handle_web_search(&json!({
            "id": "ws_1",
            "stage": "in_progress",
            "item": { "type": "web_search_call", "id": "ws_1", "status": "in_progress" }
        }));
        // completed：完整 item（带 search_results），覆盖骨架
        adapter.handle_web_search(&json!({
            "id": "ws_1",
            "stage": "completed",
            "sources": [{ "title": "A", "url": "https://a.example.com" }],
            "item": {
                "type": "web_search_call",
                "id": "ws_1",
                "status": "completed",
                "search_results": [{ "url": "https://a.example.com", "title": "A" }]
            }
        }));
        // 第二个搜索调用
        adapter.handle_web_search(&json!({
            "id": "ws_2",
            "stage": "completed",
            "sources": [],
            "item": { "type": "web_search_call", "id": "ws_2", "status": "completed" }
        }));
        // 无 item 键的载荷（进度事件）不影响缓存
        adapter.handle_web_search(&json!({ "id": "ws_3", "stage": "searching" }));

        let items = adapter.take_web_search_items();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], json!("ws_1"));
        assert_eq!(
            items[0]["status"],
            json!("completed"),
            "同 id 后到的 completed item 应覆盖 in_progress 骨架"
        );
        assert!(items[0].get("search_results").is_some());
        assert_eq!(items[1]["id"], json!("ws_2"));

        // take 后清空
        assert!(adapter.take_web_search_items().is_empty());
    }
}

#[cfg(test)]
mod response_reasoning_pairing_tests {
    use super::*;

    fn test_adapter() -> ChatV2LLMAdapter {
        let emitter = Arc::new(ChatV2EventEmitter::new_windowless_for_test(
            "sess_rr_pairing".to_string(),
        ));
        ChatV2LLMAdapter::new(
            emitter,
            "msg_rr_pairing".to_string(),
            false,
            None,
            None,
            crate::utils::model_special_tokens::ModelWrapTokenPolicy::Disabled,
        )
    }

    fn reasoning_item(id: &str) -> Value {
        json!({
            "type": "reasoning",
            "id": id,
            "encrypted_content": format!("enc-{}", id)
        })
    }

    /// 回归：两个 function_call 各自带不同 reasoning item —— 按响应顺序收集
    /// 且各自与相邻 function_call 配对，禁止全部绑到第一个 tool id。
    #[test]
    fn pairs_each_reasoning_item_with_adjacent_function_call() {
        let adapter = test_adapter();
        let r1 = reasoning_item("rs_1");
        let r2 = reasoning_item("rs_2");

        adapter.on_response_reasoning_item(&r1);
        adapter.on_tool_call_start("call_1", "tool_a");
        adapter.on_response_reasoning_item(&r2);
        adapter.on_tool_call_start("call_2", "tool_b");

        let items = adapter.get_response_reasoning_items();
        assert_eq!(
            items.len(),
            2,
            "两个 reasoning item 都应保留（禁止单值覆盖）"
        );
        assert_eq!(items[0], (Some("call_1".to_string()), r1));
        assert_eq!(items[1], (Some("call_2".to_string()), r2));
    }

    /// Responses 流式路径同一 tool_call_id 会触发两次 start
    /// （output_item.added 分块 + 终态），重复 start 不得认领下一轮的 item。
    #[test]
    fn repeated_tool_call_start_does_not_steal_next_reasoning_item() {
        let adapter = test_adapter();
        let r1 = reasoning_item("rs_1");
        let r2 = reasoning_item("rs_2");

        adapter.on_response_reasoning_item(&r1);
        adapter.on_tool_call_start("call_1", "tool_a");
        adapter.on_response_reasoning_item(&r2);
        adapter.on_tool_call_start("call_1", "tool_a"); // 终态重复 start
        adapter.on_tool_call_start("call_2", "tool_b");

        let items = adapter.get_response_reasoning_items();
        assert_eq!(items[0].0.as_deref(), Some("call_1"));
        assert_eq!(items[1].0.as_deref(), Some("call_2"));
    }

    /// 检索工具（builtin-*）跳过 preparing 事件但仍参与配对。
    #[test]
    fn builtin_retrieval_tool_still_claims_reasoning_item() {
        let adapter = test_adapter();
        let r1 = reasoning_item("rs_1");
        adapter.on_response_reasoning_item(&r1);
        adapter.on_tool_call_start("call_rag", "builtin-rag_search");

        let items = adapter.get_response_reasoning_items();
        assert_eq!(items[0].0.as_deref(), Some("call_rag"));
    }

    /// 纯文本轮（无 function_call）：reasoning item 保持未配对，
    /// 由 tool_loop 挂到哨兵键持久化回放。
    #[test]
    fn text_only_round_keeps_reasoning_item_unpaired() {
        let adapter = test_adapter();
        let r1 = reasoning_item("rs_final");
        adapter.on_response_reasoning_item(&r1);

        let items = adapter.get_response_reasoning_items();
        assert_eq!(items, vec![(None, r1)]);
    }

    /// 外层重试复用同一 adapter：重置后不得残留上次的 reasoning items。
    #[test]
    fn reset_stream_state_clears_reasoning_items() {
        let adapter = test_adapter();
        adapter.on_response_reasoning_item(&reasoning_item("rs_1"));
        adapter.reset_stream_state();
        assert!(adapter.get_response_reasoning_items().is_empty());
    }
}
