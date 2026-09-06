//! Turn 划分、签名保真扫描与 tail 选择。
//!
//! tail 起点对齐 user turn 边界；扫描 tail 内部的 assistant 消息，若含活跃
//! `thought_signature`（Gemini 3）或 Anthropic 签名则把整个 turn 包进 tail。

use super::budget::{estimate_message_tokens, HEAD_USER_TURNS};
use crate::chat_v2::types::{ChatMessage, MessageBlock, MessageRole};
use log::{debug, info, warn};

/// 一个 turn：从某条 user 消息开始到下一条 user 消息之前（不含）
#[derive(Debug, Clone)]
pub(super) struct TurnRange {
    /// 消息下标范围 [start, end)
    pub(super) start: usize,
    pub(super) end: usize,
}

pub(super) fn split_into_turns(messages: &[ChatMessage]) -> Vec<TurnRange> {
    let mut turns = Vec::new();
    let mut cur_start: Option<usize> = None;
    for (i, m) in messages.iter().enumerate() {
        if matches!(m.role, MessageRole::User) {
            if let Some(s) = cur_start.take() {
                turns.push(TurnRange { start: s, end: i });
            }
            cur_start = Some(i);
        }
    }
    if let Some(s) = cur_start {
        turns.push(TurnRange {
            start: s,
            end: messages.len(),
        });
    }
    turns
}

/// 扫描一个 turn 内的 assistant 消息是否持有"活跃签名"
/// 只有持久化了签名的 turn 才需要保真——不是每个 thinking 块都有签名。
///
/// 🔧 P1-W2 修复：从"thinking 文本非空 → 保真"改为"只在真有签名时保真"。
/// 旧行为会把任何启用了 extended thinking 的 assistant turn 都钉在 tail 里，
/// 压缩几乎不节省空间。
///
/// 目前的签名来源：
/// - Gemini 3：`MessageMeta.tool_results[].thought_signature`（工具调用必须回传）
/// - Anthropic：thinking 块的 signature 目前未落盘为独立字段，暂不检测
///
/// 未来若增加 Anthropic signature 存储，应在此加一条对 `MessageBlock.meta.signature` 的检查。
fn turn_has_live_signature(
    messages: &[ChatMessage],
    turn: &TurnRange,
    _blocks_by_msg: &std::collections::HashMap<String, Vec<MessageBlock>>,
) -> bool {
    for i in turn.start..turn.end {
        let msg = &messages[i];
        if !matches!(msg.role, MessageRole::Assistant) {
            continue;
        }
        // Gemini 3：MessageMeta.tool_results[].thought_signature
        if let Some(meta) = &msg.meta {
            if let Some(tool_results) = &meta.tool_results {
                for tr in tool_results {
                    if tr
                        .thought_signature
                        .as_ref()
                        .map(|s| !s.is_empty())
                        .unwrap_or(false)
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[derive(Debug)]
pub(super) struct TailSelection {
    /// tail 起点在 messages 数组中的下标
    pub(super) tail_start_idx: usize,
    /// tail 估算 tokens
    pub(super) tail_tokens: usize,
}

pub(super) fn select_tail(
    messages: &[ChatMessage],
    turns: &[TurnRange],
    budget_tokens: usize,
    blocks_by_msg: &std::collections::HashMap<String, Vec<MessageBlock>>,
    model_id: Option<&str>,
) -> Option<TailSelection> {
    if turns.is_empty() {
        return None;
    }

    // 🔧 P1-B3 修复：从最后一个 turn 往前累加，严格遵守 budget。
    // 签名保真（Gemini 3 thoughtSignature / Anthropic thinking signature）允许个别
    // turn 超出预算，但**绝不允许整个 tail 超过 budget × SIGNATURE_GRACE**（默认 2×），
    // 否则会进入"压缩后仍溢出 → 又触发压缩"的死循环。
    const SIGNATURE_GRACE: f64 = 2.0;
    let hard_cap = ((budget_tokens as f64) * SIGNATURE_GRACE) as usize;

    let mut selected_start_turn: Option<usize> = None;
    let mut tail_tokens = 0usize;

    for t_idx in (0..turns.len()).rev() {
        let t = &turns[t_idx];
        let turn_tokens: usize = (t.start..t.end)
            .map(|i| estimate_message_tokens(&messages[i], blocks_by_msg, model_id))
            .sum();

        let has_sig = turn_has_live_signature(messages, t, blocks_by_msg);

        // 首个 turn 必须纳入（否则 tail 为空）
        if selected_start_turn.is_none() {
            if turn_tokens > hard_cap {
                // 🆕 2026-09 逃生舱：最后一个 turn 单独超过 hard_cap 时，不再整体
                // 放弃压缩（此前会一路涨到溢出，最终 FIFO 头删掉约 90% 历史）。
                // 改为尝试 turn 内切分：从该 turn 末尾往前按消息累加，tail 只保留
                // 该 turn 的末尾部分；其余部分落入 middle 进入增量摘要。
                // 工具 call/result 在同一块内（MessageBlock 同时持有 input/output），
                // 按消息粒度切分不会破坏工具配对。
                let mut acc = 0usize;
                let mut cut_idx: Option<usize> = None;
                for i in (t.start..t.end).rev() {
                    let m_tokens = estimate_message_tokens(&messages[i], blocks_by_msg, model_id);
                    if acc + m_tokens > hard_cap {
                        break;
                    }
                    acc += m_tokens;
                    cut_idx = Some(i);
                }
                match cut_idx {
                    // 必须切进 turn 内部（idx > t.start）且不侵入头部锚点区
                    Some(idx)
                        if idx > t.start
                            && (turns.len() <= HEAD_USER_TURNS
                                || idx >= turns[HEAD_USER_TURNS - 1].end) =>
                    {
                        info!(
                            "[compaction] last turn alone ({} tokens) exceeds hard cap ({}); intra-turn tail cut at msg idx={} (tail ~{} tokens)",
                            turn_tokens, hard_cap, idx, acc
                        );
                        return Some(TailSelection {
                            tail_start_idx: idx,
                            tail_tokens: acc,
                        });
                    }
                    _ => {
                        // 最后一条消息单独就超 hard_cap：压缩后仍必溢出，放弃。
                        // 让 trim_history_by_token_budget 走常规 FIFO 兜底更稳妥。
                        warn!(
                            "[compaction] last turn alone ({} tokens) exceeds hard cap ({}); aborting compaction to avoid loop",
                            turn_tokens, hard_cap
                        );
                        return None;
                    }
                }
            }
            tail_tokens = turn_tokens;
            selected_start_turn = Some(t_idx);
            continue;
        }

        // 非首个 turn：
        // - 若无签名且加上后超预算 → 停
        // - 若有签名但加上后超 hard_cap → 也停（让这 turn 落入 head，
        //   即摘要里会丢签名上下文；但这是"压缩后仍溢出"的最差备选）
        let new_total = tail_tokens + turn_tokens;
        if new_total > hard_cap {
            break;
        }
        if new_total > budget_tokens && !has_sig {
            break;
        }

        tail_tokens = new_total;
        selected_start_turn = Some(t_idx);
    }

    let start_turn_idx = selected_start_turn?;

    // 🔧 P1-B4 修复：保留开头 HEAD_USER_TURNS 个 turn 作任务锚点。
    // 若 tail 起点落在 head 之内，**clamp 到 HEAD_USER_TURNS**，不要整体放弃。
    // （原本放弃会导致带签名的短会话永远无法压缩）
    let clamped_start = start_turn_idx.max(HEAD_USER_TURNS);
    if clamped_start >= turns.len() {
        // 全部 turn 都在 head 里，没有可压缩的 middle
        debug!(
            "[compaction] no middle to summarize (clamped_start={}, total_turns={}); skip",
            clamped_start,
            turns.len()
        );
        return None;
    }

    // 如果 clamp 向后移，需要重新计算 tail_tokens
    let actual_tail_tokens: usize = if clamped_start != start_turn_idx {
        (clamped_start..turns.len())
            .flat_map(|ti| turns[ti].start..turns[ti].end)
            .map(|i| estimate_message_tokens(&messages[i], blocks_by_msg, model_id))
            .sum()
    } else {
        tail_tokens
    };

    Some(TailSelection {
        tail_start_idx: turns[clamped_start].start,
        tail_tokens: actual_tail_tokens,
    })
}

pub(super) fn split_summary_ranges(
    messages: &[ChatMessage],
    turns: &[TurnRange],
    blocks_by_msg: &std::collections::HashMap<String, Vec<MessageBlock>>,
    start: usize,
    end: usize,
    chunk_budget: usize,
    per_msg_token_cap: usize,
    model_id: Option<&str>,
) -> Vec<(usize, usize)> {
    // 🆕 2026-09：与 [start, end) 相交的 turn 按交集裁剪（此前要求 turn 完整
    // 落入区间，turn 内切分逃生舱下被部分隐藏的 turn 头部会丢失摘要覆盖）。
    // turn 边界对齐的常规调用下行为与原来完全一致。
    let relevant: Vec<(usize, usize)> = turns
        .iter()
        .filter_map(|turn| {
            let s = turn.start.max(start);
            let e = turn.end.min(end);
            if s < e {
                Some((s, e))
            } else {
                None
            }
        })
        .collect();
    if relevant.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut range_start = relevant[0].0;
    let mut range_end = range_start;
    let mut range_tokens = 0usize;
    for (turn_start, turn_end) in relevant {
        let turn_tokens = (turn_start..turn_end)
            .map(|index| {
                estimate_message_tokens(&messages[index], blocks_by_msg, model_id)
                    .min(per_msg_token_cap)
            })
            .sum::<usize>()
            .max(1);
        if range_end > range_start && range_tokens.saturating_add(turn_tokens) > chunk_budget {
            ranges.push((range_start, range_end));
            range_start = turn_start;
            range_tokens = 0;
        }
        range_end = turn_end;
        range_tokens = range_tokens.saturating_add(turn_tokens);
    }
    if range_end > range_start {
        ranges.push((range_start, range_end));
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::super::test_fixtures::{
        make_msg, make_msg_with_timestamp, make_text_block, make_tool_block,
    };
    use super::*;
    use crate::chat_v2::types::{block_status, block_types};

    #[test]
    fn split_into_turns_basic() {
        let msgs = vec![
            make_msg("m1", MessageRole::User),
            make_msg("m2", MessageRole::Assistant),
            make_msg("m3", MessageRole::Assistant),
            make_msg("m4", MessageRole::User),
            make_msg("m5", MessageRole::Assistant),
        ];
        let turns = split_into_turns(&msgs);
        assert_eq!(turns.len(), 2);
        assert_eq!((turns[0].start, turns[0].end), (0, 3));
        assert_eq!((turns[1].start, turns[1].end), (3, 5));
    }

    /// CORRECTNESS: select_tail 在最后一个 turn 单独超过 hard_cap 时必须放弃（P1-B3）
    /// —— 仅当该 turn 的**末尾消息**单独就超 hard_cap 时才放弃（turn 内无可切点）
    #[test]
    fn select_tail_aborts_when_last_turn_too_large() {
        let msgs = vec![
            make_msg_with_timestamp("u1", MessageRole::User, 100),
            make_msg_with_timestamp("a1", MessageRole::Assistant, 101),
            make_msg_with_timestamp("u2", MessageRole::User, 200),
            make_msg_with_timestamp("a2", MessageRole::Assistant, 201),
            make_msg_with_timestamp("u3", MessageRole::User, 300),
            make_msg_with_timestamp("a3", MessageRole::Assistant, 301),
        ];
        let turns = split_into_turns(&msgs);
        assert_eq!(turns.len(), 3);

        // 给最后一个 turn 注入一个大 tool_output —— 用较短字符串保证测试速度
        let mut blocks_by_msg = std::collections::HashMap::new();
        let medium = "word ".repeat(2000); // ~2500 tokens by heuristic
        blocks_by_msg.insert(
            "a3".to_string(),
            vec![make_tool_block(
                "b1",
                "a3",
                "w",
                serde_json::json!({}),
                serde_json::json!({"data": medium}),
            )],
        );
        for id in ["u1", "a1", "u2", "a2", "u3"] {
            blocks_by_msg.insert(id.to_string(), vec![make_text_block("b", id, "hi")]);
        }

        // budget = 500 → hard_cap = 1000；最后 turn 的末尾消息 a3 ≈ 2500 tokens >> hard_cap
        // → turn 内也无处可切，必须放弃
        let result = select_tail(&msgs, &turns, 500, &blocks_by_msg, None);
        assert!(
            result.is_none(),
            "最后 turn 末尾消息单独超过 hard_cap 时必须放弃压缩"
        );
    }

    /// 🆕 2026-09 逃生舱：最后 turn 整体超 hard_cap、但其末尾若干消息能装下时，
    /// tail 切进 turn 内部而不是整体放弃（此前该形态一路涨到溢出后被 FIFO 头删）。
    #[test]
    fn select_tail_cuts_inside_oversized_last_turn() {
        let msgs = vec![
            // turn 0
            make_msg_with_timestamp("u1", MessageRole::User, 100),
            make_msg_with_timestamp("a1", MessageRole::Assistant, 101),
            // turn 1
            make_msg_with_timestamp("u2", MessageRole::User, 200),
            make_msg_with_timestamp("a2", MessageRole::Assistant, 201),
            // turn 2
            make_msg_with_timestamp("u3", MessageRole::User, 300),
            make_msg_with_timestamp("a3", MessageRole::Assistant, 301),
            // turn 3（巨型工具循环：1 user + 4 assistant）
            make_msg_with_timestamp("u4", MessageRole::User, 400),
            make_msg_with_timestamp("a4", MessageRole::Assistant, 401),
            make_msg_with_timestamp("a5", MessageRole::Assistant, 402),
            make_msg_with_timestamp("a6", MessageRole::Assistant, 403),
            make_msg_with_timestamp("a7", MessageRole::Assistant, 404),
        ];
        let turns = split_into_turns(&msgs);
        assert_eq!(turns.len(), 4);
        assert_eq!(turns[3].start, 6);

        let mut blocks_by_msg = std::collections::HashMap::new();
        for m in &msgs {
            blocks_by_msg.insert(m.id.clone(), vec![make_text_block("b", &m.id, "hi")]);
        }
        // a4/a5 巨大（各 ~1600+ tokens，单独就超 hard_cap），a6/a7 小（各 ~80-100 tokens）。
        // 用数量级差距保证启发式与 tiktoken 两种计数下切点一致。
        let big_a = "word ".repeat(1600);
        let small_a = "word ".repeat(80);
        blocks_by_msg.insert("a4".to_string(), vec![make_text_block("b4", "a4", &big_a)]);
        blocks_by_msg.insert("a5".to_string(), vec![make_text_block("b5", "a5", &big_a)]);
        blocks_by_msg.insert(
            "a6".to_string(),
            vec![make_text_block("b6", "a6", &small_a)],
        );
        blocks_by_msg.insert(
            "a7".to_string(),
            vec![make_text_block("b7", "a7", &small_a)],
        );

        // budget = 500 → hard_cap = 1000。turn3 合计 ~3400+ > 1000；
        // turn 内从末尾累加：a7+a6 ≈ 200 ≤ 1000，再加 a5(~1600+) 超限 → tail=[a6,a7]
        let result = select_tail(&msgs, &turns, 500, &blocks_by_msg, None);
        let sel = result.expect("应切进 turn 内部而不是放弃");
        let a6_idx = msgs.iter().position(|m| m.id == "a6").unwrap();
        assert_eq!(sel.tail_start_idx, a6_idx, "tail 应从 turn3 内部的 a6 开始");
        assert!(sel.tail_tokens <= 1000, "tail 不得超过 hard_cap");
        assert!(
            sel.tail_start_idx >= turns[HEAD_USER_TURNS - 1].end,
            "tail 不得侵入头部锚点区"
        );
    }

    /// 🆕 2026-09：split_summary_ranges 对跨边界的 turn 按交集裁剪——
    /// turn 内切分后，被部分隐藏的 turn 头部必须仍进入摘要区间。
    #[test]
    fn split_summary_ranges_clamps_straddling_turn() {
        let msgs = vec![
            make_msg_with_timestamp("u1", MessageRole::User, 100),
            make_msg_with_timestamp("a1", MessageRole::Assistant, 101),
            make_msg_with_timestamp("u2", MessageRole::User, 200),
            make_msg_with_timestamp("a2", MessageRole::Assistant, 201),
            make_msg_with_timestamp("a3", MessageRole::Assistant, 202),
            make_msg_with_timestamp("a4", MessageRole::Assistant, 203),
        ];
        let turns = split_into_turns(&msgs);
        // turn0 = [0,2), turn1 = [2,6)
        assert_eq!(turns.len(), 2);
        let mut blocks_by_msg = std::collections::HashMap::new();
        for m in &msgs {
            blocks_by_msg.insert(m.id.clone(), vec![make_text_block("b", &m.id, "hi")]);
        }

        // end=4 落在 turn1 内部：旧实现会把 turn1 整个过滤掉（区间只到 [0,2)），
        // 新实现把相交部分并入——预算充足时合并为单个 chunk [0,4)，
        // 关键是 turn1 被裁剪的头部 [2,4) 必须进入摘要区间。
        let ranges =
            split_summary_ranges(&msgs, &turns, &blocks_by_msg, 0, 4, 100_000, 8_000, None);
        assert_eq!(
            ranges,
            vec![(0, 4)],
            "跨边界 turn 的相交部分必须并入摘要区间"
        );

        // 预算紧张时按裁剪后的范围分 chunk
        let tight = split_summary_ranges(&msgs, &turns, &blocks_by_msg, 0, 4, 1, 8_000, None);
        assert!(
            tight.iter().all(|(s, e)| *s < *e && *e <= 4),
            "分块不得越过 end 边界: {:?}",
            tight
        );
        assert_eq!(
            tight.last().map(|(_, e)| *e),
            Some(4),
            "分块必须覆盖到 end: {:?}",
            tight
        );

        // turn 边界对齐时行为不变
        let aligned =
            split_summary_ranges(&msgs, &turns, &blocks_by_msg, 0, 2, 100_000, 8_000, None);
        assert_eq!(aligned, vec![(0, 2)]);
    }

    /// CORRECTNESS: select_tail 当 tail_start 原本落入 head 时应 clamp 而非放弃（P1-B4）
    #[test]
    fn select_tail_clamps_into_head_instead_of_giving_up() {
        // 4 turns，全部短小；预算极大 → 原本会把 tail 选到 turn 0
        let msgs = vec![
            // turn 0
            make_msg_with_timestamp("u1", MessageRole::User, 100),
            make_msg_with_timestamp("a1", MessageRole::Assistant, 101),
            // turn 1
            make_msg_with_timestamp("u2", MessageRole::User, 200),
            make_msg_with_timestamp("a2", MessageRole::Assistant, 201),
            // turn 2
            make_msg_with_timestamp("u3", MessageRole::User, 300),
            make_msg_with_timestamp("a3", MessageRole::Assistant, 301),
            // turn 3
            make_msg_with_timestamp("u4", MessageRole::User, 400),
            make_msg_with_timestamp("a4", MessageRole::Assistant, 401),
        ];
        let turns = split_into_turns(&msgs);
        let mut blocks_by_msg = std::collections::HashMap::new();
        for m in &msgs {
            blocks_by_msg.insert(m.id.clone(), vec![make_text_block("b", &m.id, "x")]);
        }

        let result = select_tail(&msgs, &turns, 1_000_000, &blocks_by_msg, None);
        let sel = result.expect("tail should be selected (clamped to HEAD_USER_TURNS)");
        // 应从 turn[HEAD_USER_TURNS=2] 开始，而不是 turn[0]
        assert_eq!(
            sel.tail_start_idx, turns[HEAD_USER_TURNS].start,
            "tail_start 应被 clamp 到 HEAD_USER_TURNS={}",
            HEAD_USER_TURNS
        );
    }

    /// SECURITY: turn_has_live_signature 不再把普通 thinking 块误判为需要保真（P1-W2）
    #[test]
    fn thinking_without_signature_does_not_pin_turn() {
        let msgs = vec![
            make_msg("u1", MessageRole::User),
            make_msg("a1", MessageRole::Assistant),
        ];
        let turns = split_into_turns(&msgs);
        let mut blocks_by_msg = std::collections::HashMap::new();
        // a1 有 thinking 块但 meta.tool_results 为 None → 不应被 pin
        blocks_by_msg.insert(
            "a1".to_string(),
            vec![MessageBlock {
                id: "b".to_string(),
                message_id: "a1".to_string(),
                block_type: block_types::THINKING.to_string(),
                status: block_status::SUCCESS.to_string(),
                content: Some("let me think...".to_string()),
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                started_at: None,
                ended_at: None,
                first_chunk_at: None,
                block_index: 0,
            }],
        );
        assert!(
            !turn_has_live_signature(&msgs, &turns[0], &blocks_by_msg),
            "单独 thinking 块不再触发签名保真"
        );
    }

    /// SECURITY: Gemini 3 thought_signature 仍会触发签名保真
    #[test]
    fn gemini_thought_signature_pins_turn() {
        use crate::chat_v2::types::{MessageMeta, ToolResultInfo};
        let mut msg = make_msg("a1", MessageRole::Assistant);
        msg.meta = Some(MessageMeta {
            tool_results: Some(vec![ToolResultInfo {
                tool_call_id: Some("tc1".to_string()),
                block_id: None,
                tool_name: "weather".to_string(),
                input: serde_json::json!({}),
                output: serde_json::json!({}),
                success: true,
                error: None,
                duration_ms: None,
                reasoning_content: None,
                thought_signature: Some("sig_abc_xyz".to_string()),
            }]),
            ..Default::default()
        });
        let msgs = vec![make_msg("u1", MessageRole::User), msg];
        let turns = split_into_turns(&msgs);
        let blocks_by_msg = std::collections::HashMap::new();
        assert!(
            turn_has_live_signature(&msgs, &turns[0], &blocks_by_msg),
            "Gemini 3 thought_signature 必须触发保真"
        );
    }
}
