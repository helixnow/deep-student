//! Token 预算与压缩触发判定。
//!
//! 触发参数（参考 参考实现 overflow.ts + 2026 模型调研）、可用 token 估算，
//! 以及检查点 A（LLM 回复完成）/ 检查点 B（工具执行后）的触发判断。

use crate::chat_v2::context::PipelineContext;
use crate::chat_v2::types::{ChatMessage, MessageBlock};
use crate::llm_manager::ApiConfig;
use log::info;

/// 触发比率：`used >= (usable) * ratio`
pub const TRIGGER_RATIO: f64 = 0.85;
/// 无配置窗口时采用保守回退，避免未知模型被乐观地当作超长上下文。
pub const DEFAULT_CONTEXT_WINDOW: u32 = 32_768;
/// 无配置输出上限时的默认值
pub const DEFAULT_MAX_OUTPUT: u32 = 8_192;
/// tail 应至少保留的 token 比例（相对于 usable）
pub const TAIL_PRESERVE_RATIO: f64 = 0.25;
/// 绝对最小 tail tokens，防止极大窗口 + 过低比例导致保真不足
pub const MIN_TAIL_TOKENS: usize = 2_000;
/// 绝对最大 tail tokens，防止极大窗口分走所有空间
pub const MAX_TAIL_TOKENS: usize = 64_000;
/// 必须保留的"开头"user turn 数量（任务锚点）
pub const HEAD_USER_TURNS: usize = 2;
pub(super) const SUMMARY_INPUT_RATIO: f64 = 0.70;
pub(super) const MIN_SUMMARY_INPUT_TOKENS: usize = 2_000;
pub(super) const MAX_SUMMARY_INPUT_TOKENS: usize = 120_000;

/// 模型可用 token 数（扣除输出预留缓冲）
///
/// 输出预留采用请求输出上限与供应商上限的较小值；`max_tokens_limit = Some(0)`
/// 视为异常配置，不允许它把预留错误地压成 0。
/// 但 `context_window = Some(0)` 视为"明确知道这个模型没有可用窗口"（例如
/// 配置占位），此时返回 0，调用方据此跳过压缩。
pub fn usable_tokens(config: Option<&ApiConfig>) -> u32 {
    let context = config
        .and_then(|c| c.context_window)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW);
    if context == 0 {
        return 0;
    }
    let max_output = config
        .map(|c| {
            let requested = if c.max_output_tokens > 0 {
                c.max_output_tokens
            } else {
                DEFAULT_MAX_OUTPUT
            };
            c.max_tokens_limit
                .filter(|&limit| limit > 0)
                .map(|limit| requested.min(limit))
                .unwrap_or(requested)
        })
        .unwrap_or(DEFAULT_MAX_OUTPUT);
    context.saturating_sub(max_output)
}

pub fn effective_usable_tokens(config: Option<&ApiConfig>, context_limit: Option<u32>) -> u32 {
    let provider_budget = usable_tokens(config);
    match context_limit {
        Some(limit) => provider_budget.min(limit),
        None => provider_budget,
    }
}

/// 是否应当触发压缩（检查点 A：LLM 回复完成、真实 usage 可用）
///
/// 🔧 P1-W1 修复：不再把 `cached_tokens` 加到 prompt+completion（cache 是 prompt 的
/// **子集**，不是额外量，相加会双计 → 阈值被提前触发）
pub(crate) fn should_compact(ctx: &PipelineContext, config: Option<&ApiConfig>) -> bool {
    let usable = effective_usable_tokens(config, ctx.options.context_limit);
    if usable == 0 {
        return false;
    }

    // 🔧 语义澄清：last_round_prompt_tokens 实为「上一轮 prompt + completion」
    // （上下文窗口占用，见 types.rs 字段文档）。下一轮 prompt ≈ 上一轮
    // prompt + completion（+ 工具输出），因此它正是预测下一轮输入规模的正确基数。
    // 缺失时回退到累计值（多轮累计会偏大 → 保守提前触发，可接受）。
    let used = match ctx.token_usage.last_round_prompt_tokens {
        Some(v) if v > 0 => v,
        _ => {
            let sum = ctx
                .token_usage
                .prompt_tokens
                .saturating_add(ctx.token_usage.completion_tokens);
            ctx.token_usage.total_tokens.max(sum)
        }
    };

    let threshold = ((usable as f64) * TRIGGER_RATIO) as u32;
    let trigger = used >= threshold;
    if trigger {
        info!(
            "[compaction] trigger@A: used={} threshold={} usable={}",
            used, threshold, usable
        );
    }
    trigger
}

/// 预估工具输出大小是否会让下一轮 prompt 溢出（检查点 B：工具执行后）
pub(crate) fn should_compact_after_tool(
    ctx: &PipelineContext,
    config: Option<&ApiConfig>,
    predicted_tool_output_tokens: u32,
) -> bool {
    let usable = effective_usable_tokens(config, ctx.options.context_limit);
    if usable == 0 {
        return false;
    }

    // 下一轮 prompt ≈ 上一轮 (prompt + completion) + 本轮工具输出。
    // last_round_prompt_tokens 恰为上一轮 prompt+completion（见 types.rs），
    // 直接作为基数是准确预测而非高估。
    // 🔧 修复：缺失时的回退与 should_compact 对齐（此前回退到多轮累计
    // prompt_tokens，多轮工具会话会严重偏大）。
    let base = match ctx.token_usage.last_round_prompt_tokens {
        Some(v) if v > 0 => v,
        _ => ctx
            .token_usage
            .prompt_tokens
            .saturating_add(ctx.token_usage.completion_tokens)
            .max(ctx.token_usage.total_tokens),
    };
    let predicted_next_prompt = base.saturating_add(predicted_tool_output_tokens);

    let threshold = (usable as f64 * TRIGGER_RATIO) as u32;
    let trigger = predicted_next_prompt >= threshold;
    if trigger {
        info!(
            "[compaction] trigger@B: predicted_next={} threshold={} usable={} (base={}, tool_delta={})",
            predicted_next_prompt, threshold, usable, base, predicted_tool_output_tokens
        );
    }
    trigger
}

/// 粗略估算 JSON 值作为 tool output 会占多少 token（用于检查点 B）
pub fn estimate_json_tokens(value: &serde_json::Value, model_id: Option<&str>) -> u32 {
    let s = serde_json::to_string(value).unwrap_or_default();
    crate::utils::token_budget::estimate_tokens_with_model(&s, model_id) as u32
}

/// 按消息估算 token 数：**包含** content / thinking / tool_input / tool_output / error
/// 以便对 tool-heavy 会话给出真实的 tail 预算消耗。
pub(super) fn estimate_message_tokens(
    msg: &ChatMessage,
    blocks_by_msg: &std::collections::HashMap<String, Vec<MessageBlock>>,
    model_id: Option<&str>,
) -> usize {
    let mut text = String::new();
    if let Some(blocks) = blocks_by_msg.get(&msg.id) {
        for b in blocks {
            if let Some(c) = &b.content {
                text.push_str(c);
                text.push('\n');
            }
            // 🔧 P1-B1 修复：tool payload 必须计入预算
            if let Some(v) = &b.tool_input {
                let s = serde_json::to_string(v).unwrap_or_default();
                text.push_str(&s);
                text.push('\n');
            }
            if let Some(v) = &b.tool_output {
                let s = serde_json::to_string(v).unwrap_or_default();
                text.push_str(&s);
                text.push('\n');
            }
            if let Some(e) = &b.error {
                text.push_str(e);
                text.push('\n');
            }
        }
    }
    crate::utils::token_budget::estimate_tokens_with_model(&text, model_id)
}

#[cfg(test)]
mod tests {
    use super::super::test_fixtures::{
        dummy_ctx, make_config, make_msg, make_text_block, make_tool_block,
    };
    use super::*;
    use crate::chat_v2::types::MessageRole;

    #[test]
    fn usable_tokens_normal_model() {
        let cfg = make_config(1_000_000, 128_000);
        let u = usable_tokens(Some(&cfg));
        // 1_000_000 - 128_000 = 872_000
        assert_eq!(u, 872_000);
    }

    #[test]
    fn usable_tokens_small_model_clamps_to_max_output() {
        let cfg = make_config(16_000, 4_000);
        let u = usable_tokens(Some(&cfg));
        // 16_000 - 4_000 = 12_000
        assert_eq!(u, 12_000);
    }

    #[test]
    fn usable_tokens_zero_context_returns_zero() {
        let cfg = make_config(0, 8_192);
        assert_eq!(usable_tokens(Some(&cfg)), 0);
    }

    #[test]
    fn should_compact_triggers_near_threshold() {
        let cfg = make_config(100_000, 8_000);
        let usable = usable_tokens(Some(&cfg));
        assert_eq!(usable, 92_000);
        let threshold = (usable as f64 * TRIGGER_RATIO) as u32;

        let mut ctx = dummy_ctx();
        ctx.token_usage.last_round_prompt_tokens = Some(threshold - 1);
        assert!(!should_compact(&ctx, Some(&cfg)));

        ctx.token_usage.last_round_prompt_tokens = Some(threshold + 1);
        assert!(should_compact(&ctx, Some(&cfg)));
    }

    #[test]
    fn should_compact_after_tool_accounts_for_delta() {
        let cfg = make_config(100_000, 8_000);
        let usable = usable_tokens(Some(&cfg));
        let threshold = (usable as f64 * TRIGGER_RATIO) as u32;

        let mut ctx = dummy_ctx();
        ctx.token_usage.last_round_prompt_tokens = Some(threshold / 2);
        assert!(!should_compact_after_tool(&ctx, Some(&cfg), 100));

        let big_tool = threshold / 2 + 100;
        assert!(should_compact_after_tool(&ctx, Some(&cfg), big_tool));
    }

    #[test]
    fn default_context_window_when_no_config() {
        let u = usable_tokens(None);
        assert_eq!(u, DEFAULT_CONTEXT_WINDOW - DEFAULT_MAX_OUTPUT);
        // 32_768 - 8_192 = 24_576
        assert_eq!(u, 24_576);
    }

    /// SECURITY / CORRECTNESS: tool_input/output 必须计入 tail 预算（P1-B1）
    #[test]
    fn estimate_message_tokens_includes_tool_payload() {
        let msg = make_msg("m1", MessageRole::Assistant);
        let mut blocks_by_msg = std::collections::HashMap::new();

        // 只有 text block 的消息
        let text_only = vec![make_text_block("b1", "m1", "hi")];
        blocks_by_msg.insert("m1".to_string(), text_only);
        let t_text = estimate_message_tokens(&msg, &blocks_by_msg, None);

        // 追加一个中等大小的 tool_output（测试速度优先，不用太大）
        let medium_output = "lorem ipsum dolor sit amet ".repeat(50);
        let with_tool = vec![
            make_text_block("b1", "m1", "hi"),
            make_tool_block(
                "b2",
                "m1",
                "web_search",
                serde_json::json!({"query": "test"}),
                serde_json::json!({"html": medium_output}),
            ),
        ];
        blocks_by_msg.insert("m1".to_string(), with_tool);
        let t_with = estimate_message_tokens(&msg, &blocks_by_msg, None);

        assert!(
            t_with > t_text + 50,
            "tool_output 必须显著增加 token 估算：t_text={}, t_with={}",
            t_text,
            t_with
        );
    }
}
