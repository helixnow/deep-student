use super::*;

// ============================================================================
// 变体 LLM 适配器
// ============================================================================

pub(crate) struct VariantLLMAdapter {
    ctx: Arc<super::super::variant_context::VariantExecutionContext>,
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
    pub(crate) fn new(
        ctx: Arc<super::super::variant_context::VariantExecutionContext>,
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

    pub(crate) fn finalize_all(&self) {
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
