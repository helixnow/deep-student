//! 模型特殊 token 剥离（issue #122 / #58）
//!
//! GLM/Qwen 系模型会把内部协议 token（`<|begin_of_box|>`、`<|im_end|>` 等）
//! 泄漏进流式正文。Anki 制卡管线（#187，`streaming_anki_service.rs`）已在
//! 残片切出后剥离同一白名单；本模块把该白名单抽为共享实现，供聊天流式
//! ContentChunk 路径在下发前端之前复用。
//!
//! 白名单必须与 `streaming_anki_service.rs` 中的保持一致：只剥离已知的
//! 协议 token，不碰用户内容里的其他 `<|...|>` 字面量。

/// 已知会泄漏进流式正文的模型特殊 token（与 #187 Anki 白名单一致）。
pub const MODEL_SPECIAL_TOKENS: &[&str] = &[
    "<|begin_of_box|>",
    "<|end_of_box|>",
    "<|im_start|>",
    "<|im_end|>",
    "<|endoftext|>",
];

/// 剥离白名单内的模型特殊 token（纯函数，语义与 anki 版一致）。
/// 仅适用于完整文本；流式分片请用 [`SpecialTokenStreamStripper`]，
/// 否则 token 跨 chunk 撕裂时会漏剥。
pub fn strip_model_special_tokens(text: &str) -> String {
    let mut out = text.to_string();
    for token in MODEL_SPECIAL_TOKENS {
        if out.contains(token) {
            out = out.replace(token, "");
        }
    }
    out
}

/// 尾部疑似"未写完的特殊 token 前缀"的字节长度。
/// 返回 0 表示尾部不可能补全成白名单 token，可以全部下发。
fn trailing_token_prefix_len(text: &str) -> usize {
    // 白名单 token 全为 ASCII；能匹配上前缀的尾部必然也是 ASCII，
    // 因此按 char 边界回退切片是安全的。
    let max_hold = MODEL_SPECIAL_TOKENS
        .iter()
        .map(|t| t.len())
        .max()
        .unwrap_or(0)
        .saturating_sub(1);

    let mut best = 0;
    for (idx, _) in text.char_indices().rev() {
        let suffix = &text[idx..];
        if suffix.len() > max_hold {
            break;
        }
        if MODEL_SPECIAL_TOKENS
            .iter()
            .any(|token| token.starts_with(suffix))
        {
            best = suffix.len();
        }
    }
    best
}

/// 流式安全的特殊 token 剥离器。
///
/// 逐 chunk 调用 [`process`](Self::process)：完整出现的白名单 token 被剥掉；
/// chunk 尾部若恰好是某个 token 的前半截（如 `数学<|end_of`），该前缀会被
/// 暂存，等后续 chunk 拼出完整 token 再剥、或证明不是 token 后原样吐出。
/// 流结束时必须调用 [`flush`](Self::flush) 取回暂存尾部，避免吞掉正常内容。
#[derive(Debug, Default)]
pub struct SpecialTokenStreamStripper {
    /// 尾部暂存：白名单 token 的某个真前缀（长度 < 最长 token，有界）。
    pending: String,
}

impl SpecialTokenStreamStripper {
    pub fn new() -> Self {
        Self::default()
    }

    /// 输入一个流式 chunk，返回此刻可安全下发前端的文本。
    pub fn process(&mut self, chunk: &str) -> String {
        self.pending.push_str(chunk);
        let stripped = strip_model_special_tokens(&self.pending);
        let hold = trailing_token_prefix_len(&stripped);
        let emit_end = stripped.len() - hold;
        self.pending = stripped[emit_end..].to_string();
        stripped[..emit_end].to_string()
    }

    /// 流结束/收尾：吐出暂存尾部（此时不会再有后续 chunk 补全 token）。
    pub fn flush(&mut self) -> String {
        // pending 在 process 中已剥过完整 token，这里再剥一次仅作防御。
        strip_model_special_tokens(&std::mem::take(&mut self.pending))
    }

    /// 重试/新一轮前清空暂存状态。
    pub fn reset(&mut self) {
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== 纯函数：issue #122 核心场景 =====

    #[test]
    fn strip_removes_inline_special_token() {
        assert_eq!(strip_model_special_tokens("数学<|end_of_box|>题"), "数学题");
    }

    #[test]
    fn strip_removes_all_whitelisted_tokens() {
        let input = "<|im_start|>解：<|begin_of_box|>42<|end_of_box|><|im_end|><|endoftext|>";
        assert_eq!(strip_model_special_tokens(input), "解：42");
    }

    #[test]
    fn strip_keeps_normal_markdown_untouched() {
        let markdown = "# 标题\n\n**加粗** 与 `code`，公式 $a < b$，表格 | A | B |\n\n<b>html</b> 以及 <think 字面量";
        assert_eq!(strip_model_special_tokens(markdown), markdown);
    }

    #[test]
    fn strip_keeps_non_whitelisted_pipe_brackets() {
        // 非白名单的 <|...|> 字面量属于用户内容，不得误剥
        let input = "自定义标记 <|custom|> 保留";
        assert_eq!(strip_model_special_tokens(input), input);
    }

    // ===== 流式剥离器：单 chunk 与跨 chunk =====

    #[test]
    fn stream_strips_token_within_single_chunk() {
        let mut stripper = SpecialTokenStreamStripper::new();
        let mut out = stripper.process("数学<|end_of_box|>题");
        out.push_str(&stripper.flush());
        assert_eq!(out, "数学题");
    }

    #[test]
    fn stream_strips_token_torn_across_chunks() {
        // GLM 的 token 常被 SSE 切在中间：`<|end_of` + `_box|>`
        let mut stripper = SpecialTokenStreamStripper::new();
        let mut out = String::new();
        out.push_str(&stripper.process("数学<|end_of"));
        out.push_str(&stripper.process("_box|>题"));
        out.push_str(&stripper.flush());
        assert_eq!(out, "数学题");
    }

    #[test]
    fn stream_strips_token_torn_char_by_char() {
        let mut stripper = SpecialTokenStreamStripper::new();
        let mut out = String::new();
        for ch in "解<|im_end|>毕".chars() {
            out.push_str(&stripper.process(&ch.to_string()));
        }
        out.push_str(&stripper.flush());
        assert_eq!(out, "解毕");
    }

    #[test]
    fn stream_releases_lookalike_prefix_once_disproven() {
        // `<|end` 之后接的不是 token 余下部分，应原样吐出，不吞用户内容
        let mut stripper = SpecialTokenStreamStripper::new();
        let mut out = String::new();
        out.push_str(&stripper.process("对比 <|end"));
        out.push_str(&stripper.process(" 与其他写法"));
        out.push_str(&stripper.flush());
        assert_eq!(out, "对比 <|end 与其他写法");
    }

    #[test]
    fn stream_flush_returns_trailing_prefix_at_stream_end() {
        // 流在疑似前缀处终止：flush 必须吐回暂存内容，不得丢字
        let mut stripper = SpecialTokenStreamStripper::new();
        let mut out = stripper.process("结尾悬着 <|end_of");
        assert_eq!(out, "结尾悬着 ");
        out.push_str(&stripper.flush());
        assert_eq!(out, "结尾悬着 <|end_of");
    }

    #[test]
    fn stream_keeps_normal_markdown_untouched() {
        let markdown = "1. 列表 `<div>` 与 a < b、竖线 | 表格 |";
        let mut stripper = SpecialTokenStreamStripper::new();
        let mut out = stripper.process(markdown);
        out.push_str(&stripper.flush());
        assert_eq!(out, markdown);
    }

    #[test]
    fn stream_reset_clears_pending() {
        let mut stripper = SpecialTokenStreamStripper::new();
        let _ = stripper.process("重试前残留 <|im_");
        stripper.reset();
        assert_eq!(stripper.flush(), "");
        // reset 后重新处理不受旧状态影响
        let mut out = stripper.process("新内容<|im_end|>！");
        out.push_str(&stripper.flush());
        assert_eq!(out, "新内容！");
    }
}
