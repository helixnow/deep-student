//! 双适配器流式过滤公共核心（Wave2-A R3 #7 骨架，未接线）
//!
//! 设计文档：`docs/dev/wave2-A/r3-adapter-parallel.md`
//!
//! `llm_adapter.rs`（ChatV2LLMAdapter）与 `variant_adapter.rs`（VariantLLMAdapter）
//! 的内容过滤 + `<think>` 标签路由逻辑逐行平行（清单 #1–#5，约 400 行重复）。
//! 本文件是第一刀抽取的骨架：**纯状态机**，不持锁、不持 emitter、不管块生命周期，
//! 输入 chunk、输出路由片段，由两适配器在各自的锁纪律与事件落点下消费。
//!
//! 状态：本轮（R3）仅建骨架 + 注释，`pipeline.rs` 尚未声明 `mod stream_filter_core;`
//! （属死代码占位）。第 4 轮接线计划：
//! 1. 把 `ChatV2LLMAdapter::process_think_tag_buffer` / `flush_think_tag_buffer` /
//!    `ends_with_potential_think_start|end` 的查找逻辑**移动**（非复制）到本文件；
//! 2. 两适配器删除各自的 `in_think_tag` / `think_tag_buffer` / `wrap_token_filter`
//!    三字段，改持一把 `Mutex<StreamFilterCore>`；
//! 3. 在 `process_reasoning` 挂 reasoning 过滤（当前两侧 `on_reasoning_chunk`
//!    均为裸转发，这是 R4 的过滤挂点）。
//!
//! 红线：迁移时必须保持"最早匹配标签优先"与"不完整前缀保留"语义；
//! HTML 负例测试（`<table>`/`<td>` 不得误判为 think 标签）随迁不删。

#![allow(dead_code)] // R3 骨架：未在 pipeline.rs 声明 mod，R4 接线后移除

use crate::utils::model_special_tokens::{ModelWrapTokenPolicy, ModelWrapTokenStreamFilter};

/// 过滤/路由后的流片段。
///
/// 调用方（适配器）的消费合同：
/// - `Thinking`：累积到 reasoning（LLM 侧 `accumulated_reasoning` /
///   变体侧 `ctx.append_reasoning`），惰性建 thinking 块并发 THINKING chunk；
/// - `Content`：累积到 content，惰性建 content 块（必先 finalize thinking）
///   并发 CONTENT chunk。
///
/// `enable_thinking=false` 时核心内部直接丢弃 Thinking 片段（与现状一致），
/// 调用方无需再判。
#[derive(Debug, PartialEq, Eq)]
pub enum RoutedPiece {
    Thinking(String),
    Content(String),
}

/// 内容过滤 + `<think>` 标签路由状态机（平行逻辑清单 #1–#5 的公共核心）。
///
/// 有意不包含（留在适配器 / 第二刀）：
/// - 块 ID 生命周期与 emit 时序（清单 #6–#9）；
/// - 工具调用 preparing 块与 args delta 节流（清单 #11）；
/// - `touch_activity` 空闲计时（清单 #12，重复成本低于抽取成本）；
/// - LLM 侧 `reasoning_content_observed` 标志（"字段是否出现"语义，非过滤语义）。
pub struct StreamFilterCore {
    /// GLM/Qwen 协议包装 token 过滤器（清单 #1）。
    /// content chunk 先过 `process()`；结束态 `flush()` 的尾巴回灌 think 缓冲。
    wrap_token_filter: ModelWrapTokenStreamFilter,
    /// 是否当前在 `<think>` 标签内部（清单 #2）。
    in_think_tag: bool,
    /// 跨 chunk 标签边界缓冲区（清单 #2）。
    think_tag_buffer: String,
    /// 关闭时 Thinking 片段被静默丢弃（与两适配器现状一致）。
    enable_thinking: bool,
}

impl StreamFilterCore {
    pub fn new(policy: ModelWrapTokenPolicy, enable_thinking: bool) -> Self {
        Self {
            wrap_token_filter: ModelWrapTokenStreamFilter::new(policy),
            in_think_tag: false,
            think_tag_buffer: String::new(),
            enable_thinking,
        }
    }

    /// 处理一个 content chunk（对应两适配器的 `on_content_chunk`，清单 #4）。
    ///
    /// R4 迁入语义（以 llm_adapter.rs:1116-1140 + 922-1107 为准）：
    /// 1. 空 chunk 直接返回空；
    /// 2. 过 `wrap_token_filter.process()`；
    /// 3. 追加到 `think_tag_buffer`，跑 `<think>`/`<thinking>` 标签状态机：
    ///    开/闭标签取**最早匹配**；结尾疑似不完整标签前缀时保留缓冲等待下一 chunk
    ///    （`ends_with_potential_think_start/end`，防 `<table>` 等 HTML 误判）；
    /// 4. 标签内文本产出 `Thinking`，标签外产出 `Content`，一个 chunk 可产出多段。
    pub fn process_content(&mut self, chunk: &str) -> Vec<RoutedPiece> {
        // TODO(R4): 迁移 process_think_tag_buffer 状态机；当前骨架直通为 Content。
        if chunk.is_empty() {
            return Vec::new();
        }
        let filtered = self.wrap_token_filter.process(chunk);
        if filtered.is_empty() {
            return Vec::new();
        }
        vec![RoutedPiece::Content(filtered)]
    }

    /// 处理一个 reasoning chunk（对应两适配器的 `on_reasoning_chunk`，清单 #5）。
    ///
    /// 现状：两侧 reasoning 均**裸转发**，不过 wrap 过滤、不做标签清洗。
    /// 本方法即 R4 "挂 reasoning 过滤"的落点：签名与 `process_content` 对齐，
    /// 填实函数体后两适配器调用点零改动。
    pub fn process_reasoning(&mut self, chunk: &str) -> Vec<RoutedPiece> {
        // TODO(R4): 挂 wrap token 过滤 + 必要的 <think> 标签清洗。
        if !self.enable_thinking || chunk.is_empty() {
            return Vec::new();
        }
        vec![RoutedPiece::Thinking(chunk.to_string())]
    }

    /// 结束态冲刷（对应 `finalize_all_inner` 的前两步，清单 #1 尾巴 + #3）。
    ///
    /// R4 迁入语义：`wrap_token_filter.flush()` 的尾巴先回灌缓冲，再冲缓冲残留——
    /// 仍在未闭合 `<think>` 内的残留归 `Thinking`（warn 由调用方打），否则归 `Content`。
    /// 注意：本方法只产出片段；thinking end → content end 的块结束时序仍由
    /// 适配器负责（前端块状态机的隐式合同，不下沉）。
    pub fn flush(&mut self) -> Vec<RoutedPiece> {
        // TODO(R4): 迁移 flush_think_tag_buffer 语义；当前骨架仅冲过滤器尾巴。
        let tail = self.wrap_token_filter.flush();
        self.think_tag_buffer.push_str(&tail);
        let remaining = std::mem::take(&mut self.think_tag_buffer);
        if remaining.is_empty() {
            return Vec::new();
        }
        if self.in_think_tag {
            self.in_think_tag = false;
            if self.enable_thinking {
                vec![RoutedPiece::Thinking(remaining)]
            } else {
                Vec::new()
            }
        } else {
            vec![RoutedPiece::Content(remaining)]
        }
    }

    /// 重置过滤状态（清单 #14 的公共重置项）。
    ///
    /// 供两条既有重置路径共用：LLM 侧 `reset_stream_state`（外层重试）与
    /// 变体侧 `reset_for_new_round`（新一轮）。两路径语义不同、入口不合并，
    /// 但对本核心的重置动作相同。
    pub fn reset(&mut self) {
        self.wrap_token_filter.reset();
        self.in_think_tag = false;
        self.think_tag_buffer.clear();
    }
}
