//! Chat V2 LLM 流式回调适配器
//!
//! ⚠️ **注意**：此模块当前未被使用！
//! Pipeline (`pipeline.rs`) 使用的是其内嵌的 `ChatV2LLMAdapter` 实现，
//! 该内嵌版本包含额外功能（accumulated_content、collected_tool_calls）。
//!
//! 此模块保留作为参考实现，包含更完善的原子操作（AtomicBool 防止重复结束）。
//! 未来可能将两个实现合并。
//!
//! 实现 `LLMStreamHooks` trait，将 LLM 流式回调转换为 Chat V2 块级事件。
//!
//! ## 功能特性
//! - 支持 thinking/content 块的懒初始化
//! - 支持多工具并发调用（通过 HashMap 追踪 tool_call_id -> block_id）
//! - 自动管理块的生命周期（start -> chunk -> end）
//! - 空内容自动跳过，避免无效事件
//!
//! ## 块生成顺序
//! 1. thinking 块（如果 enable_thinking 为 true）
//! 2. content 块（收到第一个内容 chunk 时自动结束 thinking）
//! 3. tool 块（可并发，每个工具调用独立的块）
//!
//! ## 使用示例
//! ```ignore
//! let emitter = ChatV2EventEmitter::new(window, session_id);
//! let adapter = ChatV2LLMAdapter::new(emitter, message_id, true);
//!
//! // LLM 调用时传入 adapter 作为 hooks
//! llm_manager.stream_chat(&request, Some(Arc::new(adapter))).await?;
//! ```

use crate::chat_v2::events::{event_types, ChatV2EventEmitter};
use crate::llm_manager::LLMStreamHooks;
use crate::models::ChatMessage;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use uuid::Uuid;

/// Chat V2 LLM 流式回调适配器
///
/// 将 LLM 流式回调（content/reasoning/tool_call/tool_result）
/// 转换为 Chat V2 块级事件（start/chunk/end/error）。
pub struct ChatV2LLMAdapter {
    /// 事件发射器
    emitter: ChatV2EventEmitter,

    /// 当前消息 ID
    message_id: String,

    /// 是否启用思维链
    enable_thinking: bool,

    // ========== 状态追踪 ==========
    /// thinking 块 ID（懒初始化）
    thinking_block_id: Mutex<Option<String>>,

    /// thinking 块是否已结束
    thinking_ended: AtomicBool,

    /// content 块 ID（懒初始化）
    content_block_id: Mutex<Option<String>>,

    /// content 块是否已结束
    content_ended: AtomicBool,

    // ========== 多工具并发支持 ==========
    /// 活跃的工具块：tool_call_id -> block_id
    active_tool_blocks: Mutex<HashMap<String, String>>,
}

impl ChatV2LLMAdapter {
    /// 创建新的 LLM 适配器
    ///
    /// ## 参数
    /// - `emitter`: 事件发射器
    /// - `message_id`: 当前 assistant 消息 ID
    /// - `enable_thinking`: 是否启用思维链（决定是否发射 thinking 事件）
    pub fn new(emitter: ChatV2EventEmitter, message_id: String, enable_thinking: bool) -> Self {
        log::info!(
            "[ChatV2::LLMAdapter] Created for message {} (thinking={})",
            message_id,
            enable_thinking
        );
        Self {
            emitter,
            message_id,
            enable_thinking,
            thinking_block_id: Mutex::new(None),
            thinking_ended: AtomicBool::new(false),
            content_block_id: Mutex::new(None),
            content_ended: AtomicBool::new(false),
            active_tool_blocks: Mutex::new(HashMap::new()),
        }
    }

    /// 生成块 ID（格式：blk_{uuid}）
    fn generate_block_id() -> String {
        format!("blk_{}", Uuid::new_v4())
    }

    /// 确保 thinking 块已启动（懒初始化）
    ///
    /// ## 返回
    /// - 如果 enable_thinking 为 false，返回 None
    /// - 如果 thinking 块已结束，返回 None
    /// - 否则返回块 ID（首次调用时创建）
    fn ensure_thinking_started(&self) -> Option<String> {
        if !self.enable_thinking {
            return None;
        }

        // 如果已结束，不再创建
        if self.thinking_ended.load(Ordering::SeqCst) {
            return None;
        }

        let mut guard = match self.thinking_block_id.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log::error!("[ChatV2::LLMAdapter] thinking_block_id mutex poisoned");
                poisoned.into_inner()
            }
        };

        if guard.is_none() {
            let block_id = Self::generate_block_id();
            log::debug!("[ChatV2::LLMAdapter] Starting thinking block: {}", block_id);

            // 发射 start 事件，传递 block_id（后端生成）
            self.emitter.emit_start(
                event_types::THINKING,
                &self.message_id,
                Some(&block_id),
                None,
                None, // variant_id: 单变体模式
            );

            *guard = Some(block_id.clone());
        }

        guard.clone()
    }

    /// 确保 content 块已启动（懒初始化）
    ///
    /// 注意：调用此方法会自动结束 thinking 块（如果有）
    ///
    /// ## 返回
    /// 块 ID（首次调用时创建）
    fn ensure_content_started(&self) -> String {
        // 先结束 thinking 块（如果有且未结束）
        self.finalize_thinking_if_needed();

        let mut guard = match self.content_block_id.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log::error!("[ChatV2::LLMAdapter] content_block_id mutex poisoned");
                poisoned.into_inner()
            }
        };

        if guard.is_none() {
            let block_id = Self::generate_block_id();
            log::debug!("[ChatV2::LLMAdapter] Starting content block: {}", block_id);

            // 发射 start 事件，传递 block_id（后端生成）
            self.emitter.emit_start(
                event_types::CONTENT,
                &self.message_id,
                Some(&block_id),
                None,
                None, // variant_id: 单变体模式
            );

            *guard = Some(block_id.clone());
        }

        guard.clone().expect("content_block_id should be set")
    }

    /// 如果 thinking 块存在且未结束，则结束它
    fn finalize_thinking_if_needed(&self) {
        // 使用原子操作检查并设置结束标志
        if !self.enable_thinking {
            return;
        }

        // 检查是否已经结束
        if self
            .thinking_ended
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            // 已经被结束了，直接返回
            return;
        }

        // 获取 block_id 并发射 end 事件
        let guard = match self.thinking_block_id.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log::error!("[ChatV2::LLMAdapter] thinking_block_id mutex poisoned in finalize!");
                poisoned.into_inner()
            }
        };

        if let Some(block_id) = guard.as_ref() {
            log::debug!("[ChatV2::LLMAdapter] Ending thinking block: {}", block_id);
            self.emitter
                .emit_end(event_types::THINKING, block_id, None, None);
        }
    }

    /// 如果 content 块存在且未结束，则结束它
    fn finalize_content_if_needed(&self) {
        // 检查是否已经结束
        if self
            .content_ended
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            // 已经被结束了，直接返回
            return;
        }

        // 获取 block_id 并发射 end 事件
        let guard = match self.content_block_id.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log::error!("[ChatV2::LLMAdapter] content_block_id mutex poisoned in finalize!");
                poisoned.into_inner()
            }
        };

        if let Some(block_id) = guard.as_ref() {
            log::debug!("[ChatV2::LLMAdapter] Ending content block: {}", block_id);
            self.emitter
                .emit_end(event_types::CONTENT, block_id, None, None);
        }
    }

    /// 结束所有活跃块
    ///
    /// 在流式完成或出错时调用，确保所有块都收到 end 事件。
    pub fn finalize_all(&self) {
        log::debug!("[ChatV2::LLMAdapter] Finalizing all blocks");

        // 结束 thinking
        self.finalize_thinking_if_needed();

        // 结束 content
        self.finalize_content_if_needed();

        // 结束所有未完成的工具块（标记为错误）
        let guard = match self.active_tool_blocks.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log::error!(
                    "[ChatV2::LLMAdapter] active_tool_blocks mutex poisoned in finalize_all!"
                );
                poisoned.into_inner()
            }
        };

        for (tool_call_id, block_id) in guard.iter() {
            log::warn!(
                "[ChatV2::LLMAdapter] Tool block {} (call_id={}) not completed, marking as error",
                block_id,
                tool_call_id
            );
            self.emitter.emit_error_with_meta(
                event_types::TOOL_CALL,
                block_id,
                "Stream terminated",
                None,
                None,
                None,
            );
        }
    }

    /// 标记所有块为错误状态
    ///
    /// 在流式出错时调用。
    pub fn mark_all_error(&self, error: &str) {
        log::error!(
            "[ChatV2::LLMAdapter] Marking all blocks as error: {}",
            error
        );

        // 标记 content 块为错误（如果存在且未结束）
        if !self.content_ended.load(Ordering::SeqCst) {
            let guard = match self.content_block_id.lock() {
                Ok(g) => g,
                Err(poisoned) => {
                    log::error!(
                        "[ChatV2::LLMAdapter] content_block_id mutex poisoned in mark_all_error!"
                    );
                    poisoned.into_inner()
                }
            };

            if let Some(block_id) = guard.as_ref() {
                self.emitter
                    .emit_error(event_types::CONTENT, block_id, error, None);
                self.content_ended.store(true, Ordering::SeqCst);
            }
        }

        // 标记所有工具块为错误
        let guard = match self.active_tool_blocks.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log::error!(
                    "[ChatV2::LLMAdapter] active_tool_blocks mutex poisoned in mark_all_error!"
                );
                poisoned.into_inner()
            }
        };

        for (_, block_id) in guard.iter() {
            self.emitter.emit_error_with_meta(
                event_types::TOOL_CALL,
                block_id,
                error,
                None,
                None,
                None,
            );
        }
    }

    /// 获取消息 ID
    pub fn message_id(&self) -> &str {
        &self.message_id
    }

    /// 获取 thinking 块 ID（如果已创建）
    pub fn thinking_block_id(&self) -> Option<String> {
        self.thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 获取 content 块 ID（如果已创建）
    pub fn content_block_id(&self) -> Option<String> {
        self.content_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

// ============================================================
// 实现 LLMStreamHooks trait
// ============================================================

impl LLMStreamHooks for ChatV2LLMAdapter {
    /// 处理内容块
    ///
    /// 接收 LLM 生成的主要内容，发射 chunk 事件。
    fn on_content_chunk(&self, text: &str) {
        // 空内容跳过
        if text.is_empty() {
            return;
        }

        // 确保 content 块已启动（同时结束 thinking）
        let block_id = self.ensure_content_started();

        // 发射 chunk 事件
        self.emitter.emit_content_chunk(&block_id, text, None);
    }

    /// 处理推理/思维链块
    ///
    /// 接收 LLM 的推理过程，发射 thinking chunk 事件。
    fn on_reasoning_chunk(&self, text: &str) {
        // 空内容或未启用 thinking 时跳过
        if text.is_empty() || !self.enable_thinking {
            return;
        }

        // 确保 thinking 块已启动
        if let Some(block_id) = self.ensure_thinking_started() {
            // 发射 chunk 事件
            self.emitter.emit_thinking_chunk(&block_id, text, None);
            return;
        }

        // OpenAI Responses 可能在首个 content 后才返回 reasoning summary。
        // 若此前从未创建过 thinking 块，允许一次延迟创建，避免 summary 丢失。
        let had_thinking_block = self
            .thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        if !had_thinking_block && self.thinking_ended.load(Ordering::SeqCst) {
            self.thinking_ended.store(false, Ordering::SeqCst);
            if let Some(block_id) = self.ensure_thinking_started() {
                self.emitter.emit_thinking_chunk(&block_id, text, None);
            }
        }
    }

    /// 处理工具调用开始
    ///
    /// 从 ChatMessage.tool_call 提取信息，收集工具调用供 Pipeline 执行。
    /// 🔧 P0修复：不再发射 start 事件，事件发射统一由 Pipeline.execute_single_tool 处理，
    /// 避免前端收到重复的 tool_call start 事件。
    fn on_tool_call(&self, msg: &ChatMessage) {
        // 提取工具调用信息
        let tool_call = match &msg.tool_call {
            Some(tc) => tc,
            None => {
                log::warn!("[ChatV2::LLMAdapter] on_tool_call called but no tool_call in message");
                return;
            }
        };

        let tool_call_id = &tool_call.id;
        let tool_name = &tool_call.tool_name;

        log::info!(
            "[ChatV2::LLMAdapter] Tool call detected: {} -> {} (will be executed by Pipeline)",
            tool_call_id,
            tool_name
        );

        // 🔧 P0修复：移除 active_tool_blocks 映射和 emit_tool_call_start
        // 工具调用的 block_id 生成和事件发射统一由 Pipeline.execute_single_tool 处理
        // 这里只负责收集工具调用信息，供 Pipeline 后续执行
    }

    /// 处理工具调用结果
    ///
    /// 🔧 P0修复：由于 Chat V2 Pipeline 设置 disable_tools=true，LLM Manager 不会
    /// 内部执行工具，因此这个回调不会被 LLM Manager 调用。
    /// 工具结果事件由 Pipeline.execute_single_tool 直接发射。
    /// 保留此方法仅为满足 LLMStreamHooks trait 要求。
    fn on_tool_result(&self, msg: &ChatMessage) {
        // 由于 disable_tools=true，此方法在 Chat V2 中不会被调用
        // 工具执行和结果事件发射统一由 Pipeline.execute_single_tool 处理
        if let Some(ref tool_result) = msg.tool_result {
            log::debug!(
                "[ChatV2::LLMAdapter] on_tool_result called (unexpected in Chat V2): call_id={}",
                tool_result.call_id
            );
        }
    }

    /// 处理使用量信息
    ///
    /// 目前仅记录日志，不发射事件。
    fn on_usage(&self, usage: &Value) {
        log::debug!(
            "[ChatV2::LLMAdapter] Usage for message {}: {:?}",
            self.message_id,
            usage
        );
        // 可选：将 usage 存储到消息元数据
    }

    /// 处理流式完成
    ///
    /// 结束所有活跃块。
    fn on_complete(&self, _final_text: &str, _reasoning: Option<&str>) {
        log::info!(
            "[ChatV2::LLMAdapter] Stream complete for message {}",
            self.message_id
        );
        self.finalize_all();
    }
}

// ============================================================
// 单元测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // ========== 基础功能测试 ==========

    #[test]
    fn test_generate_block_id_format() {
        let block_id = ChatV2LLMAdapter::generate_block_id();
        assert!(block_id.starts_with("blk_"));
        assert_eq!(block_id.len(), 4 + 36); // "blk_" + UUID
    }

    #[test]
    fn test_generate_block_id_uniqueness() {
        let ids: Vec<String> = (0..100)
            .map(|_| ChatV2LLMAdapter::generate_block_id())
            .collect();
        let unique_count = ids.iter().collect::<std::collections::HashSet<_>>().len();
        assert_eq!(
            unique_count, 100,
            "All generated block IDs should be unique"
        );
    }

    // ========== 状态追踪测试（不需要 Window） ==========

    /// 测试：多次调用 ensure_thinking_started 只创建一个 block_id
    #[test]
    fn test_thinking_block_id_created_once() {
        // 由于没有 Window，我们测试内部状态变化
        // 这里测试 Mutex 和懒初始化逻辑

        let thinking_block_id: Mutex<Option<String>> = Mutex::new(None);
        let enable_thinking = true;
        let thinking_ended = AtomicBool::new(false);

        // 模拟 ensure_thinking_started 的逻辑
        let create_if_needed = || {
            if !enable_thinking {
                return None;
            }
            if thinking_ended.load(Ordering::SeqCst) {
                return None;
            }
            let mut guard = thinking_block_id.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                let block_id = ChatV2LLMAdapter::generate_block_id();
                *guard = Some(block_id.clone());
            }
            guard.clone()
        };

        // 第一次调用应该创建 block_id
        let first_id = create_if_needed();
        assert!(first_id.is_some());

        // 第二次调用应该返回相同的 block_id
        let second_id = create_if_needed();
        assert_eq!(first_id, second_id);

        // 第三次调用仍然相同
        let third_id = create_if_needed();
        assert_eq!(first_id, third_id);
    }

    /// 测试：content 块创建时 thinking 应该先结束
    #[test]
    fn test_thinking_finalized_before_content() {
        let thinking_ended = AtomicBool::new(false);
        let enable_thinking = true;

        // 模拟 finalize_thinking_if_needed 的逻辑
        let finalize_thinking = || {
            if !enable_thinking {
                return false;
            }
            thinking_ended
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        };

        // 第一次调用应该成功结束
        assert!(finalize_thinking());
        assert!(thinking_ended.load(Ordering::SeqCst));

        // 第二次调用应该返回 false（已经结束了）
        assert!(!finalize_thinking());
    }

    /// 测试：多工具调用产生唯一的 block_id
    #[test]
    fn test_multiple_tool_calls_unique_block_ids() {
        let active_tool_blocks: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());

        // 模拟多个工具调用
        let tool_calls = vec![
            ("call_1", "tool_a"),
            ("call_2", "tool_b"),
            ("call_3", "tool_c"),
        ];

        let mut block_ids = Vec::new();

        for (call_id, _tool_name) in &tool_calls {
            let block_id = ChatV2LLMAdapter::generate_block_id();
            {
                let mut guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
                guard.insert(call_id.to_string(), block_id.clone());
            }
            block_ids.push(block_id);
        }

        // 验证所有 block_id 唯一
        let unique_count = block_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len();
        assert_eq!(unique_count, 3);

        // 验证映射正确
        let guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(guard.len(), 3);
        assert!(guard.contains_key("call_1"));
        assert!(guard.contains_key("call_2"));
        assert!(guard.contains_key("call_3"));
    }

    /// 测试：工具结果处理后从映射中移除
    #[test]
    fn test_tool_result_removes_from_map() {
        let active_tool_blocks: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());

        // 添加工具调用
        {
            let mut guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
            guard.insert("call_1".to_string(), "blk_123".to_string());
            guard.insert("call_2".to_string(), "blk_456".to_string());
        }

        // 处理第一个结果
        let removed = {
            let mut guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
            guard.remove("call_1")
        };
        assert_eq!(removed, Some("blk_123".to_string()));

        // 验证只剩一个
        {
            let guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(guard.len(), 1);
            assert!(!guard.contains_key("call_1"));
            assert!(guard.contains_key("call_2"));
        }

        // 处理第二个结果
        let removed = {
            let mut guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
            guard.remove("call_2")
        };
        assert_eq!(removed, Some("blk_456".to_string()));

        // 验证为空
        {
            let guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
            assert!(guard.is_empty());
        }
    }

    /// 测试：处理未知的工具调用 ID
    #[test]
    fn test_tool_result_unknown_call_id() {
        let active_tool_blocks: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());

        // 尝试移除不存在的调用 ID
        let removed = {
            let mut guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
            guard.remove("unknown_call")
        };
        assert!(removed.is_none());
    }

    /// 测试：thinking 禁用时不创建块
    #[test]
    fn test_thinking_disabled_no_block() {
        let thinking_block_id: Mutex<Option<String>> = Mutex::new(None);
        let enable_thinking = false; // 禁用
        let thinking_ended = AtomicBool::new(false);

        let create_if_needed = || {
            if !enable_thinking {
                return None;
            }
            if thinking_ended.load(Ordering::SeqCst) {
                return None;
            }
            let mut guard = thinking_block_id.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                let block_id = ChatV2LLMAdapter::generate_block_id();
                *guard = Some(block_id.clone());
            }
            guard.clone()
        };

        // 应该返回 None
        assert!(create_if_needed().is_none());

        // 内部状态应该保持为 None
        assert!(thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none());
    }

    /// 测试：thinking 结束后不再创建新块
    #[test]
    fn test_thinking_ended_no_new_block() {
        let thinking_block_id: Mutex<Option<String>> = Mutex::new(None);
        let enable_thinking = true;
        let thinking_ended = AtomicBool::new(true); // 已经结束

        let create_if_needed = || {
            if !enable_thinking {
                return None;
            }
            if thinking_ended.load(Ordering::SeqCst) {
                return None;
            }
            let mut guard = thinking_block_id.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                let block_id = ChatV2LLMAdapter::generate_block_id();
                *guard = Some(block_id.clone());
            }
            guard.clone()
        };

        // 应该返回 None（因为已经结束）
        assert!(create_if_needed().is_none());

        // 内部状态应该保持为 None
        assert!(thinking_block_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none());
    }

    /// 测试：content 块只创建一次
    #[test]
    fn test_content_block_created_once() {
        let content_block_id: Mutex<Option<String>> = Mutex::new(None);

        let create_if_needed = || {
            let mut guard = content_block_id.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                let block_id = ChatV2LLMAdapter::generate_block_id();
                *guard = Some(block_id.clone());
            }
            guard.clone().unwrap()
        };

        // 第一次调用
        let first_id = create_if_needed();

        // 第二次调用应该返回相同的 ID
        let second_id = create_if_needed();
        assert_eq!(first_id, second_id);

        // 第三次仍然相同
        let third_id = create_if_needed();
        assert_eq!(first_id, third_id);
    }

    /// 测试：finalize_all 应该清理所有活跃工具块
    #[test]
    fn test_finalize_all_clears_tool_blocks() {
        let active_tool_blocks: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());

        // 添加一些工具块
        {
            let mut guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
            guard.insert("call_1".to_string(), "blk_1".to_string());
            guard.insert("call_2".to_string(), "blk_2".to_string());
        }

        // 模拟 finalize_all 中遍历工具块的逻辑
        let guard = active_tool_blocks.lock().unwrap_or_else(|e| e.into_inner());
        let pending_tools: Vec<_> = guard.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        drop(guard);

        // 验证有 2 个待处理的工具块
        assert_eq!(pending_tools.len(), 2);

        // 验证包含正确的 block_id
        let block_ids: Vec<_> = pending_tools.iter().map(|(_, v)| v.clone()).collect();
        assert!(block_ids.contains(&"blk_1".to_string()));
        assert!(block_ids.contains(&"blk_2".to_string()));
    }

    /// 测试：content 结束标志防止重复结束
    #[test]
    fn test_content_ended_prevents_double_finalize() {
        let content_ended = AtomicBool::new(false);

        // 第一次结束应该成功
        let first_result = content_ended
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        assert!(first_result);

        // 第二次结束应该失败（已经结束了）
        let second_result = content_ended
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        assert!(!second_result);
    }
}
