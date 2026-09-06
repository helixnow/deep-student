use crate::models::ChatMessage;

// 改进版近似：
// - ASCII 字母数字约 4 字符/Token
// - ASCII 标点/空白给予更高权重（更接近 BPE 切分）
// - 中日韩字符（含假名/谚文）≈ 1 字符/Token
// - 其它多字节字符（Emoji 等）≈ 0.8 Token/字符
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let mut sum: f32 = 0.0;
    for ch in text.chars() {
        if ch.is_ascii() {
            if ch.is_ascii_alphanumeric() {
                sum += 0.25;
            } else if ch.is_ascii_whitespace() {
                sum += 0.05;
            } else {
                sum += 0.30;
            } // 标点/其它 ASCII
            continue;
        }
        let cp = ch as u32;
        if is_cjk(cp) || is_kana(cp) || is_hangul(cp) {
            sum += 1.0;
        } else {
            sum += 0.8;
        }
    }
    let v = sum.round() as usize;
    std::cmp::max(1, v)
}

/// Model-aware estimation: when built with `tokenizer_tiktoken` feature, use actual tokenizer encodings.
/// `model_hint` 可以是 OpenAI/兼容模型名，用于选择合适的编码（如 cl100k_base / o200k_base）。
pub fn estimate_tokens_with_model(text: &str, model_hint: Option<&str>) -> usize {
    #[cfg(feature = "tokenizer_tiktoken")]
    {
        use std::sync::Once;
        use tiktoken_rs::{cl100k_base, o200k_base, CoreBPE};

        // P2修复：首次调用时打印 tokenizer 状态，让用户了解当前使用精确计数
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            println!(
                "✅ [TokenBudget] 使用 tiktoken 精确计数（已启用 tokenizer_tiktoken feature）"
            );
        });

        /// 检查模型名称中是否存在以词边界开始的 o 系列前缀（o1/o3/o4）。
        /// 避免 "proto1-model" 等误匹配。
        fn has_o_series_prefix(m: &str) -> bool {
            for prefix in &["o1", "o3", "o4"] {
                if let Some(pos) = m.find(prefix) {
                    // 确保 prefix 前面是非字母数字字符（即词边界）
                    if pos == 0 || !m.as_bytes()[pos - 1].is_ascii_alphanumeric() {
                        return true;
                    }
                }
            }
            false
        }

        fn pick_encoding(model: &str) -> CoreBPE {
            let m = model.to_lowercase();
            // o200k_base 编码器：GPT-4o/4.1/4.5/5 系列、o1/o3/o4 系列
            if m.contains("o200k")
                || m.contains("gpt-4o")
                || m.contains("gpt-4.1")
                || m.contains("gpt-4.5")
                || m.contains("gpt-5")
                || has_o_series_prefix(&m)
            {
                o200k_base().unwrap_or_else(|_| cl100k_base().unwrap())
            } else {
                cl100k_base().unwrap()
            }
        }
        if let Some(m) = model_hint {
            let enc = pick_encoding(m);
            encode_capped(&enc, text)
        } else {
            let enc = cl100k_base().unwrap();
            encode_capped(&enc, text)
        }
    }
    #[cfg(not(feature = "tokenizer_tiktoken"))]
    {
        use std::sync::Once;

        // 启发式估算不区分模型编码
        let _ = model_hint;

        // P2修复：使用启发式估算时打印警告，建议启用精确计数
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            println!("⚠️ [TokenBudget] 使用启发式估算（建议启用 --features tokenizer_tiktoken 以获得精确计数）");
        });

        estimate_tokens(text)
    }
}

/// 🆕 2026-09：超长文本的采样外推阈值（字符数）。超过后按首/中/尾采样线性外推。
/// tiktoken BPE 合并是近似平方级复杂度：病态内容（单字符重复、minified、
/// 重复日志）几千字符就要数秒（实测 15K 重复字符 ≈5.7s，75K >60s），
/// 会把压缩/预算流水线整体卡死。采样把单次估算压到亚秒级。
#[cfg(feature = "tokenizer_tiktoken")]
const TIKTOKEN_SAMPLE_THRESHOLD_CHARS: usize = 8_000;
/// 首/中/尾各采样的字符数（2K 重复字符的 BPE 耗时约 0.1s，可接受）
#[cfg(feature = "tokenizer_tiktoken")]
const TIKTOKEN_SAMPLE_PART_CHARS: usize = 2_000;

#[cfg(feature = "tokenizer_tiktoken")]
fn encode_capped(enc: &tiktoken_rs::CoreBPE, text: &str) -> usize {
    let total_chars = text.chars().count();
    if total_chars <= TIKTOKEN_SAMPLE_THRESHOLD_CHARS {
        return enc.encode_with_special_tokens(text).len();
    }
    // 首/中/尾采样 + 按密度线性外推（超长文本的精度损失可接受——它们通常远超预算）
    let head: String = text.chars().take(TIKTOKEN_SAMPLE_PART_CHARS).collect();
    let mid_start = (total_chars - TIKTOKEN_SAMPLE_PART_CHARS) / 2;
    let mid: String = text
        .chars()
        .skip(mid_start)
        .take(TIKTOKEN_SAMPLE_PART_CHARS)
        .collect();
    let tail: String = text
        .chars()
        .skip(total_chars - TIKTOKEN_SAMPLE_PART_CHARS)
        .collect();
    let sampled_tokens = enc.encode_with_special_tokens(&head).len()
        + enc.encode_with_special_tokens(&mid).len()
        + enc.encode_with_special_tokens(&tail).len();
    let sampled_chars = TIKTOKEN_SAMPLE_PART_CHARS * 3;
    // 按采样密度外推，并保证不低于采样值（防低估导致预算失控）
    let extrapolated =
        (sampled_tokens as f64 * (total_chars as f64 / sampled_chars as f64)).round() as usize;
    extrapolated.max(sampled_tokens)
}

fn is_cjk(cp: u32) -> bool {
    // 中日韩统一表意及扩展块 + 兼容表意
    (0x4E00..=0x9FFF).contains(&cp)
        || (0x3400..=0x4DBF).contains(&cp)
        || (0x20000..=0x2A6DF).contains(&cp)
        || (0x2A700..=0x2B73F).contains(&cp)
        || (0x2B740..=0x2B81F).contains(&cp)
        || (0x2B820..=0x2CEAF).contains(&cp)
        || (0x2CEB0..=0x2EBEF).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
}

fn is_kana(cp: u32) -> bool {
    (0x3040..=0x309F).contains(&cp) // Hiragana
        || (0x30A0..=0x30FF).contains(&cp) // Katakana
}

fn is_hangul(cp: u32) -> bool {
    (0xAC00..=0xD7AF).contains(&cp) // Hangul Syllables
        || (0x1100..=0x11FF).contains(&cp) // Hangul Jamo
        || (0xA960..=0xA97F).contains(&cp) // Hangul Jamo Extended-A
        || (0xD7B0..=0xD7FF).contains(&cp) // Hangul Jamo Extended-B
}

pub struct BudgetResult {
    pub kept: Vec<ChatMessage>,
    pub dropped: usize,
    pub summary: Option<String>,
}

// 简化策略：从末尾向前保留，直到达到 max_ctx - reserve_completion
// 优先保证最后一条用户消息和其后的助手消息保留。
pub fn budget_messages(
    max_ctx: usize,
    reserve_completion: usize,
    messages: &[ChatMessage],
) -> BudgetResult {
    if messages.is_empty() {
        return BudgetResult {
            kept: vec![],
            dropped: 0,
            summary: None,
        };
    }

    let mut kept: Vec<ChatMessage> = Vec::new();
    let mut used_tokens = 0usize;
    let budget = max_ctx.saturating_sub(reserve_completion);

    // 从尾到头扫描，尽可能保留最近的对话；优先保留含图片/含 rag_sources 的消息
    for msg in messages.iter().rev() {
        let mut msg_tokens = estimate_tokens(&msg.content);
        // 用户消息权重略高
        if msg.role == "user" {
            msg_tokens = (msg_tokens as f64 * 1.2) as usize;
        }
        // 含图片：给予负向“成本”，更容易被保留
        if let Some(imgs) = &msg.image_base64 {
            if !imgs.is_empty() {
                msg_tokens = msg_tokens.saturating_sub(512);
            }
        }
        // 含 rag_sources：也给予优惠
        if let Some(r) = &msg.rag_sources {
            if !r.is_empty() {
                msg_tokens = msg_tokens.saturating_sub(256);
            }
        }
        if used_tokens + msg_tokens > budget {
            break;
        }
        kept.push(msg.clone());
        used_tokens += msg_tokens;
    }

    kept.reverse();
    let dropped = messages.len().saturating_sub(kept.len());
    // 生成滚动摘要占位（不输出正文）
    let summary = if dropped > 0 {
        Some("⋯context trimmed⋯".to_string())
    } else {
        None
    };
    BudgetResult {
        kept,
        dropped,
        summary,
    }
}

#[cfg(all(test, feature = "tokenizer_tiktoken"))]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_with_model_short_text_matches_exact_encoding() {
        // 短文本走精确编码路径
        let text = "hello world 你好，世界";
        let direct = tiktoken_rs::cl100k_base()
            .unwrap()
            .encode_with_special_tokens(text)
            .len();
        assert_eq!(estimate_tokens_with_model(text, None), direct);
    }

    #[test]
    fn estimate_tokens_with_model_huge_repetitive_text_is_fast_and_reasonable() {
        // 病态输入：单字符重复 200K 次。BPE 全量编码在此形态下合并轮次爆炸（>60s），
        // 采样外推必须秒回且量级正确（"数"在 cl100k 里约 1 token/字符）。
        let pathological = "数".repeat(200_000);
        let start = std::time::Instant::now();
        let estimate = estimate_tokens_with_model(&pathological, None);
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "采样外推应在 5s 内完成，实际 {:?}",
            elapsed
        );
        // 量级校验：应在精确值（≈200K）的 0.5x ~ 2x 之间
        assert!(
            (100_000..=400_000).contains(&estimate),
            "外推估算量级异常: {}",
            estimate
        );
    }

    #[test]
    fn estimate_tokens_with_model_varied_huge_text_extrapolates_close_to_exact() {
        // 多样化长文本：外推误差应较小（±20%）
        let varied: String =
            "fn process_frame(idx: usize) -> Result<Frame, RenderError> { /* 渲染管线 */ }"
                .chars()
                .cycle()
                .take(120_000)
                .collect();
        let exact = tiktoken_rs::cl100k_base()
            .unwrap()
            .encode_with_special_tokens(&varied)
            .len();
        let estimate = estimate_tokens_with_model(&varied, None);
        let ratio = estimate as f64 / exact as f64;
        assert!(
            (0.8..=1.25).contains(&ratio),
            "外推偏差过大: estimate={} exact={} ratio={:.2}",
            estimate,
            exact,
            ratio
        );
    }
}
