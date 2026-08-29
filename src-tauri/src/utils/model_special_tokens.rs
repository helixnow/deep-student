//! Conservative streaming cleanup for protocol tokens leaked by GLM/Qwen.
//!
//! This intentionally does not perform a global string replacement.
//!
//! # What IS removed
//!
//! - Leading outer wrappers (`<|im_start|>` / `<|begin_of_box|>` before any
//!   substantive text) and their matching close tokens later in the stream.
//! - Logical lines that consist solely of special tokens.
//! - Continuation headers from stop-token failures: a line-leading
//!   `<|im_start|>` immediately followed by a known role word
//!   (`assistant` / `user` / `system`) and end-of-line. The whole line is
//!   dropped and the wrapper is treated as opened, so the paired `<|im_end|>`
//!   of the runaway turn is removed as well.
//! - Close tokens (`<|im_end|>` / `<|end_of_box|>` / `<|endoftext|>`) glued to
//!   the very end of the stream (only whitespace after them until flush).
//!
//! # What is NOT removed (deliberate)
//!
//! - Tokens quoted inside prose mid-line with more content after them
//!   (e.g. "请解释 `<|im_end|>` 的含义" or "… <|im_end|> 后还有字").
//! - Anything inside Markdown inline code spans or fenced code blocks.
//!   Inline-code state is reset at each newline (streaming approximation of
//!   CommonMark) so a single unpaired backtick cannot disable filtering for
//!   the rest of the stream; a token inside a code span that happens to span
//!   a soft line break loses that protection, which is the accepted trade-off.
//! - A close token glued mid-stream to text with more content following
//!   (unless a stripped continuation header proves it was a failure tail).
//! - Line-leading `<|im_start|>` followed by a role word plus further content
//!   on the same line (treated as a literal mention, not a header).

/// Single source of truth for the wrapper tokens known to leak from GLM/Qwen
/// chat templates. Shared crate-wide (e.g. `streaming_anki_service` reuses it
/// for its whole-fragment stripping) so the two cleanup layers can never
/// disagree on the token list.
pub(crate) const MODEL_SPECIAL_TOKENS: &[&str] = &[
    "<|begin_of_box|>",
    "<|end_of_box|>",
    "<|im_start|>",
    "<|im_end|>",
    "<|endoftext|>",
];

/// Role words that follow `<|im_start|>` in ChatML-style templates. Used only
/// for the narrow continuation-header rule (line-leading opener + role + EOL).
const CONTINUATION_ROLE_WORDS: &[&str] = &["assistant", "user", "system"];

fn is_continuation_role_word(word: &str) -> bool {
    CONTINUATION_ROLE_WORDS.contains(&word)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelWrapTokenPolicy {
    Disabled,
    GlmOrQwen,
}

impl ModelWrapTokenPolicy {
    /// Limit cleanup to routes known to leak GLM/Qwen chat-template tokens.
    ///
    /// `provider_type` covers the first-party `qwen` and `zhipu` routes, while
    /// matching the model name also covers those models behind OpenAI-compatible
    /// providers such as SiliconFlow or a user-defined endpoint.
    pub fn for_provider_model(
        provider_type: Option<&str>,
        provider_scope: Option<&str>,
        model: &str,
    ) -> Self {
        let affected_provider = [provider_type, provider_scope]
            .into_iter()
            .flatten()
            .map(|value| value.trim().to_ascii_lowercase())
            .any(|value| matches!(value.as_str(), "qwen" | "dashscope" | "zhipu" | "bigmodel"));
        let model = model.trim().to_ascii_lowercase();
        let affected_model = model.contains("qwen")
            || model.contains("chatglm")
            || model
                .split(|ch: char| !ch.is_ascii_alphanumeric())
                .any(|part| {
                    part.starts_with("glm") || part.starts_with("qwq") || part.starts_with("qvq")
                });

        if affected_provider || affected_model {
            Self::GlmOrQwen
        } else {
            Self::Disabled
        }
    }

    fn is_enabled(self) -> bool {
        matches!(self, Self::GlmOrQwen)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WrapperFamily {
    Box,
    Im,
}

fn opening_family(token: &str) -> Option<WrapperFamily> {
    match token {
        "<|begin_of_box|>" => Some(WrapperFamily::Box),
        "<|im_start|>" => Some(WrapperFamily::Im),
        _ => None,
    }
}

fn closing_family(token: &str) -> Option<WrapperFamily> {
    match token {
        "<|end_of_box|>" => Some(WrapperFamily::Box),
        "<|im_end|>" => Some(WrapperFamily::Im),
        _ => None,
    }
}

fn token_at_start(text: &str) -> Option<&'static str> {
    MODEL_SPECIAL_TOKENS
        .iter()
        .copied()
        .find(|token| text.starts_with(token))
}

fn is_incomplete_token_prefix(text: &str) -> bool {
    !text.is_empty()
        && MODEL_SPECIAL_TOKENS
            .iter()
            .any(|token| token.starts_with(text))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkdownCode {
    Inline { ticks: usize },
    Fenced { marker: char, width: usize },
}

/// Streaming, Markdown-aware filter for leaked model wrapper tokens.
///
/// Ordinary text is emitted immediately. Only a possible special-token prefix
/// and a logical-line prefix made exclusively of whitespace/tokens are held,
/// so the filter does not turn normal streaming into whole-response buffering.
#[derive(Debug)]
pub struct ModelWrapTokenStreamFilter {
    policy: ModelWrapTokenPolicy,
    input: String,
    /// Byte offset of the first unconsumed byte in `input`. Always on a char
    /// boundary (advanced by whole tokens/chars only). Consumed bytes are
    /// reclaimed once per `process_available` pass instead of on every
    /// `consume_prefix`, so a large chunk is not re-memmoved per character.
    input_cursor: usize,
    line_candidate: String,
    line_candidate_tokens: Vec<&'static str>,
    line_is_candidate: bool,
    stream_has_substantive_text: bool,
    code: Option<MarkdownCode>,
    box_wrapper_open: bool,
    im_wrapper_open: bool,
    /// Held role-word characters directly following a lone line-leading
    /// `<|im_start|>` (continuation-header candidate). Invariant: non-empty
    /// only while `line_is_candidate` and the candidate holds exactly that
    /// opener. Bounded by the longest role word plus trailing whitespace.
    role_suffix: String,
    /// Close tokens (and following whitespace) glued mid-line to text: held
    /// back because they may be a stop-token failure tail at end of stream.
    /// Released verbatim as soon as any further substantive content arrives.
    tail_hold_raw: String,
    /// Same held span with the token text removed (whitespace only); emitted
    /// instead of `tail_hold_raw` at flush or after a stripped continuation
    /// header, when the held tokens are known to be failure artifacts.
    tail_hold_stripped: String,
}

impl ModelWrapTokenStreamFilter {
    pub fn new(policy: ModelWrapTokenPolicy) -> Self {
        Self {
            policy,
            input: String::new(),
            input_cursor: 0,
            line_candidate: String::new(),
            line_candidate_tokens: Vec::new(),
            line_is_candidate: true,
            stream_has_substantive_text: false,
            code: None,
            box_wrapper_open: false,
            im_wrapper_open: false,
            role_suffix: String::new(),
            tail_hold_raw: String::new(),
            tail_hold_stripped: String::new(),
        }
    }

    pub fn process(&mut self, chunk: &str) -> String {
        if !self.policy.is_enabled() {
            return chunk.to_string();
        }
        self.input.push_str(chunk);
        self.process_available(false)
    }

    pub fn flush(&mut self) -> String {
        if !self.policy.is_enabled() {
            return String::new();
        }

        let mut output = self.process_available(true);
        // Stream ends right on a continuation header (`…\n<|im_start|>assistant`):
        // drop it, and drop any tail-glued closers held just before it.
        if self.line_is_candidate && self.is_continuation_role_header() {
            self.record_stripped_candidate_tokens();
            self.clear_line_candidate();
            self.role_suffix.clear();
            self.drop_tail_hold_tokens();
        }
        // Closers glued to the very end of the stream are stop-token failure
        // artifacts: drop the token text, keep any held whitespace.
        output.push_str(&self.tail_hold_stripped);
        self.tail_hold_raw.clear();
        self.tail_hold_stripped.clear();
        if self.line_is_candidate {
            if !self.role_suffix.is_empty() {
                // Opener + partial role word: cannot confirm a header — emit
                // literally (conservative).
                output.push_str(&self.line_candidate);
                output.push_str(&self.role_suffix);
            } else if self.line_candidate_tokens.is_empty() || self.code.is_some() {
                output.push_str(&self.line_candidate);
            } else {
                self.record_stripped_candidate_tokens();
            }
            self.clear_line_candidate();
            self.role_suffix.clear();
        }
        output
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.policy);
    }

    fn process_available(&mut self, flushing: bool) -> String {
        let mut output = String::new();

        while !self.pending_input().is_empty() {
            if self.pending_input().starts_with('<') {
                if let Some(token) = token_at_start(self.pending_input()) {
                    self.consume_prefix(token.len());
                    // A token ends any pending role-word hold (the line is no
                    // longer `opener + role + EOL`).
                    self.release_role_suffix(&mut output);
                    self.process_token(token, &mut output);
                    continue;
                }
                if !flushing && is_incomplete_token_prefix(self.pending_input()) {
                    break;
                }
            }

            let ch = self
                .pending_input()
                .chars()
                .next()
                .expect("input is not empty");
            if ch == '`' || ch == '~' {
                let width = self
                    .pending_input()
                    .chars()
                    .take_while(|value| *value == ch)
                    .count();
                if !flushing && width == self.pending_input().chars().count() {
                    break;
                }
                self.consume_prefix(width);
                self.release_role_suffix(&mut output);
                self.process_marker_run(ch, width, &mut output);
                continue;
            }

            self.consume_prefix(ch.len_utf8());
            if ch == '\n' {
                self.process_newline(&mut output);
            } else if !self.role_suffix.is_empty() {
                self.process_role_suffix_char(ch, &mut output);
            } else if ch.is_whitespace() && self.line_is_candidate {
                self.line_candidate.push(ch);
            } else if self.line_is_candidate && self.can_start_role_hold(ch) {
                self.role_suffix.push(ch);
            } else if ch.is_whitespace()
                && !self.line_is_candidate
                && !self.tail_hold_raw.is_empty()
            {
                // Whitespace after a held tail closer: still a possible stream
                // tail, keep holding.
                self.tail_hold_raw.push(ch);
                self.tail_hold_stripped.push(ch);
            } else {
                self.begin_literal_content(&mut output);
                output.push(ch);
                if !ch.is_whitespace() {
                    self.stream_has_substantive_text = true;
                }
            }
        }

        self.compact_input();
        output
    }

    /// The unconsumed remainder of the buffered input.
    fn pending_input(&self) -> &str {
        &self.input[self.input_cursor..]
    }

    fn consume_prefix(&mut self, byte_len: usize) {
        // Cursor advance instead of `String::drain(..byte_len)`: draining the
        // front memmoves the whole tail on every consumed token/char, which is
        // O(n²) over a large chunk. The consumed prefix is dropped once per
        // pass in `compact_input`.
        self.input_cursor += byte_len;
    }

    /// Reclaim the consumed prefix in one drain at the end of a pass, leaving
    /// only the held remainder (incomplete token/marker prefix) buffered.
    fn compact_input(&mut self) {
        if self.input_cursor == 0 {
            return;
        }
        self.input.drain(..self.input_cursor);
        self.input_cursor = 0;
    }

    /// Line-leading `<|im_start|>` with the role word starting right after it
    /// (no gap): begin holding characters that may form a continuation header.
    fn can_start_role_hold(&self, ch: char) -> bool {
        self.code.is_none()
            && self.line_candidate_tokens.as_slice() == ["<|im_start|>"]
            && self.line_candidate.ends_with("<|im_start|>")
            && CONTINUATION_ROLE_WORDS
                .iter()
                .any(|word| word.starts_with(ch))
    }

    /// Extend or abandon a pending role-word hold with the next character.
    fn process_role_suffix_char(&mut self, ch: char, output: &mut String) {
        let trimmed_len = self.role_suffix.trim_end().len();
        let extend = if ch.is_whitespace() {
            // Trailing whitespace is only plausible after a complete role word.
            is_continuation_role_word(self.role_suffix.trim_end())
        } else if trimmed_len == self.role_suffix.len() {
            let mut candidate_role = String::with_capacity(trimmed_len + ch.len_utf8());
            candidate_role.push_str(&self.role_suffix);
            candidate_role.push(ch);
            CONTINUATION_ROLE_WORDS
                .iter()
                .any(|word| word.starts_with(candidate_role.as_str()))
        } else {
            // Non-whitespace after "role " → not a bare header line.
            false
        };
        if extend {
            self.role_suffix.push(ch);
        } else {
            self.release_role_suffix(output);
            output.push(ch);
            if !ch.is_whitespace() {
                self.stream_has_substantive_text = true;
            }
        }
    }

    fn is_continuation_role_header(&self) -> bool {
        self.code.is_none()
            && self.line_candidate_tokens.as_slice() == ["<|im_start|>"]
            && self.line_candidate.ends_with("<|im_start|>")
            && is_continuation_role_word(self.role_suffix.trim_end())
    }

    /// Abandon a pending role-word hold: emit the held line prefix and role
    /// characters through the normal literal path.
    fn release_role_suffix(&mut self, output: &mut String) {
        if self.role_suffix.is_empty() {
            return;
        }
        let suffix = std::mem::take(&mut self.role_suffix);
        self.begin_literal_content(output);
        output.push_str(&suffix);
        self.stream_has_substantive_text = true;
    }

    /// Emit a held tail (closer tokens + whitespace) verbatim: more content
    /// arrived, so it was a mid-stream literal rather than a stream tail.
    fn release_tail_hold(&mut self, output: &mut String) {
        if self.tail_hold_raw.is_empty() {
            return;
        }
        output.push_str(&self.tail_hold_raw);
        self.tail_hold_raw.clear();
        self.tail_hold_stripped.clear();
        self.stream_has_substantive_text = true;
    }

    /// The held tail is confirmed to be a failure artifact: drop the token
    /// text but keep the held whitespace (newlines) for later emission.
    fn drop_tail_hold_tokens(&mut self) {
        self.tail_hold_raw = self.tail_hold_stripped.clone();
    }

    fn process_token(&mut self, token: &'static str, output: &mut String) {
        if self.code.is_some() {
            self.begin_literal_content(output);
            output.push_str(token);
            self.stream_has_substantive_text = true;
            return;
        }

        if self.line_is_candidate {
            self.line_candidate.push_str(token);
            self.line_candidate_tokens.push(token);
            return;
        }

        let matching_close =
            closing_family(token).is_some_and(|family| self.wrapper_is_open(family));
        let wrapped_end_of_text =
            token == "<|endoftext|>" && (self.box_wrapper_open || self.im_wrapper_open);
        if matching_close || wrapped_end_of_text {
            self.record_stripped_token(token);
        } else if closing_family(token).is_some() || token == "<|endoftext|>" {
            // Non-matching closer glued mid-line: hold it — if the stream ends
            // here it is a stop-token failure tail; if more content follows it
            // is released verbatim as a literal.
            self.tail_hold_raw.push_str(token);
        } else {
            self.release_tail_hold(output);
            output.push_str(token);
            self.stream_has_substantive_text = true;
        }
    }

    fn process_newline(&mut self, output: &mut String) {
        // Streaming approximation of CommonMark: an inline code span does not
        // survive the end of a line here, so a single unpaired backtick cannot
        // disable filtering for the rest of the stream. Fenced blocks are
        // unaffected.
        if matches!(self.code, Some(MarkdownCode::Inline { .. })) {
            self.code = None;
        }

        // `<|im_start|>assistant` (role word, end of line) is a stop-token
        // failure continuation header: drop the whole line including its
        // newline, and treat the opener as stripped so the paired `<|im_end|>`
        // of the runaway turn is removed too.
        if self.line_is_candidate && self.is_continuation_role_header() {
            self.record_stripped_candidate_tokens();
            self.clear_line_candidate();
            self.role_suffix.clear();
            // A closer glued to the previous line's text belongs to the same
            // failure artifact: drop the held token text, keep held whitespace.
            self.drop_tail_hold_tokens();
            self.line_is_candidate = true;
            return;
        }

        // Newline right after a held tail closer: still a possible stream
        // tail, keep holding (the newline's line-state effect still applies).
        if !self.line_is_candidate && !self.tail_hold_raw.is_empty() {
            self.tail_hold_raw.push('\n');
            self.tail_hold_stripped.push('\n');
            self.line_is_candidate = true;
            return;
        }

        self.release_role_suffix(output);
        if self.line_is_candidate {
            if !self.line_candidate_tokens.is_empty() && self.code.is_none() {
                // Remove the token-only logical line, including its newline.
                self.record_stripped_candidate_tokens();
            } else if !self.tail_hold_raw.is_empty() {
                // Whitespace-only line while a tail closer is held: only
                // whitespace has arrived since the closer, so it is still a
                // possible stream tail — keep holding line and newline.
                // (A held tail implies `code` is `None`: opening a fence goes
                // through `begin_literal_content`, which releases the hold.)
                self.tail_hold_raw.push_str(&self.line_candidate);
                self.tail_hold_raw.push('\n');
                self.tail_hold_stripped.push_str(&self.line_candidate);
                self.tail_hold_stripped.push('\n');
            } else {
                self.release_tail_hold(output);
                output.push_str(&self.line_candidate);
                output.push('\n');
            }
            self.clear_line_candidate();
        } else {
            self.release_tail_hold(output);
            output.push('\n');
        }
        self.line_is_candidate = true;
    }

    fn process_marker_run(&mut self, marker: char, width: usize, output: &mut String) {
        let can_be_fence = self.line_is_candidate
            && self.line_candidate_tokens.is_empty()
            && self.line_candidate.chars().all(|ch| ch == ' ')
            && self.line_candidate.len() <= 3
            && width >= 3;

        match self.code {
            Some(MarkdownCode::Fenced {
                marker: open_marker,
                width: open_width,
            }) if marker == open_marker && width >= open_width && can_be_fence => {
                self.begin_literal_content(output);
                output.extend(std::iter::repeat(marker).take(width));
                self.code = None;
            }
            Some(MarkdownCode::Inline { ticks }) if marker == '`' && width == ticks => {
                self.begin_literal_content(output);
                output.extend(std::iter::repeat(marker).take(width));
                self.code = None;
            }
            Some(_) => {
                self.begin_literal_content(output);
                output.extend(std::iter::repeat(marker).take(width));
            }
            None if can_be_fence => {
                self.begin_literal_content(output);
                output.extend(std::iter::repeat(marker).take(width));
                self.code = Some(MarkdownCode::Fenced { marker, width });
            }
            None => {
                self.begin_literal_content(output);
                output.extend(std::iter::repeat(marker).take(width));
                if marker == '`' {
                    self.code = Some(MarkdownCode::Inline { ticks: width });
                }
            }
        }
        self.stream_has_substantive_text = true;
    }

    fn begin_literal_content(&mut self, output: &mut String) {
        // Substantive content is arriving: anything held as a possible stream
        // tail was a mid-stream literal after all — emit it first (stream order).
        self.release_tail_hold(output);
        if !self.line_is_candidate {
            return;
        }

        let candidate_is_leading_wrapper = !self.stream_has_substantive_text
            && !self.line_candidate_tokens.is_empty()
            && self
                .line_candidate_tokens
                .iter()
                .all(|token| opening_family(token).is_some());

        if candidate_is_leading_wrapper && self.code.is_none() {
            let whitespace: String = self
                .line_candidate
                .chars()
                .filter(|ch| ch.is_whitespace())
                .collect();
            output.push_str(&whitespace);
            self.record_stripped_candidate_tokens();
        } else {
            output.push_str(&self.line_candidate);
            if !self.line_candidate_tokens.is_empty() {
                self.stream_has_substantive_text = true;
            }
        }

        self.clear_line_candidate();
        self.line_is_candidate = false;
    }

    fn record_stripped_candidate_tokens(&mut self) {
        let tokens = std::mem::take(&mut self.line_candidate_tokens);
        for token in tokens {
            self.record_stripped_token(token);
        }
    }

    fn record_stripped_token(&mut self, token: &str) {
        if let Some(family) = opening_family(token) {
            match family {
                WrapperFamily::Box => self.box_wrapper_open = true,
                WrapperFamily::Im => self.im_wrapper_open = true,
            }
            return;
        }
        if let Some(family) = closing_family(token) {
            match family {
                WrapperFamily::Box => self.box_wrapper_open = false,
                WrapperFamily::Im => self.im_wrapper_open = false,
            }
        } else if token == "<|endoftext|>" {
            self.box_wrapper_open = false;
            self.im_wrapper_open = false;
        }
    }

    fn wrapper_is_open(&self, family: WrapperFamily) -> bool {
        match family {
            WrapperFamily::Box => self.box_wrapper_open,
            WrapperFamily::Im => self.im_wrapper_open,
        }
    }

    fn clear_line_candidate(&mut self) {
        self.line_candidate.clear();
        self.line_candidate_tokens.clear();
    }
}

impl Default for ModelWrapTokenStreamFilter {
    fn default() -> Self {
        Self::new(ModelWrapTokenPolicy::Disabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled_filter() -> ModelWrapTokenStreamFilter {
        ModelWrapTokenStreamFilter::new(ModelWrapTokenPolicy::GlmOrQwen)
    }

    fn filter_chunks(chunks: &[&str]) -> String {
        let mut filter = enabled_filter();
        let mut output = String::new();
        for chunk in chunks {
            output.push_str(&filter.process(chunk));
        }
        output.push_str(&filter.flush());
        output
    }

    #[test]
    fn policy_is_limited_to_glm_and_qwen_routes() {
        assert_eq!(
            ModelWrapTokenPolicy::for_provider_model(Some("qwen"), None, "custom"),
            ModelWrapTokenPolicy::GlmOrQwen
        );
        assert_eq!(
            ModelWrapTokenPolicy::for_provider_model(
                Some("openai"),
                Some("siliconflow"),
                "Qwen/Qwen3-8B"
            ),
            ModelWrapTokenPolicy::GlmOrQwen
        );
        assert_eq!(
            ModelWrapTokenPolicy::for_provider_model(Some("openai"), None, "THUDM/glm-4-9b"),
            ModelWrapTokenPolicy::GlmOrQwen
        );
        assert_eq!(
            ModelWrapTokenPolicy::for_provider_model(Some("openai"), None, "gpt-5.6"),
            ModelWrapTokenPolicy::Disabled
        );
    }

    #[test]
    fn disabled_policy_preserves_even_a_token_only_stream() {
        let mut filter = ModelWrapTokenStreamFilter::default();
        assert_eq!(filter.process("<|im_end|>"), "<|im_end|>");
        assert_eq!(filter.flush(), "");
    }

    #[test]
    fn strips_token_only_stream_and_standalone_residual_line() {
        assert_eq!(filter_chunks(&["<|end_of_box|>"]), "");
        assert_eq!(
            filter_chunks(&["答案\n", "<|end_of_box|>\n", "补充"]),
            "答案\n补充"
        );
    }

    #[test]
    fn strips_torn_outer_wrappers() {
        assert_eq!(
            filter_chunks(&["<|begin_", "of_box|>最终", "答案<|end", "_of_box|>"]),
            "最终答案"
        );
        assert_eq!(
            filter_chunks(&["<|im_start|>\n", "回答\n", "<|im_end|>"]),
            "回答\n"
        );
    }

    #[test]
    fn preserves_literal_tokens_in_prose() {
        let prose = "请解释 <|im_end|> 的含义；<|begin_of_box|> 也可能是用户正文。";
        assert_eq!(filter_chunks(&[prose]), prose);
        assert_eq!(
            filter_chunks(&["这一行以字面量 <|im_end|> 结尾"]),
            "这一行以字面量 <|im_end|> 结尾"
        );
    }

    #[test]
    fn preserves_literal_tokens_in_inline_and_fenced_code() {
        let markdown = concat!(
            "行内代码 `<|im_end|>` 保留。\n",
            "```text\n",
            "<|begin_of_box|>\n",
            "<|im_end|>\n",
            "```\n",
            "~~~\n",
            "<|endoftext|>\n",
            "~~~"
        );
        let chunks: Vec<String> = markdown.chars().map(|ch| ch.to_string()).collect();
        let chunk_refs: Vec<&str> = chunks.iter().map(String::as_str).collect();
        assert_eq!(filter_chunks(&chunk_refs), markdown);
    }

    #[test]
    fn reset_discards_partial_candidate_from_failed_attempt() {
        let mut filter = enabled_filter();
        assert_eq!(filter.process("<|im_"), "");
        filter.reset();
        let mut output = filter.process("正常回答");
        output.push_str(&filter.flush());
        assert_eq!(output, "正常回答");
    }

    // ------------------------------------------------------------------
    // Stop-token failure: continuation header `<|im_start|>assistant`
    // ------------------------------------------------------------------

    #[test]
    fn strips_continuation_header_after_substantive_text() {
        // The canonical runaway-turn shape: glued closer, header line, more prose.
        assert_eq!(
            filter_chunks(&["正文<|im_end|>\n", "<|im_start|>assistant\n", "继续的正文"]),
            "正文\n继续的正文"
        );
        // Torn across arbitrary chunk boundaries.
        let full = "正文<|im_end|>\n<|im_start|>assistant\n继续的正文";
        let chunks: Vec<String> = full.chars().map(|ch| ch.to_string()).collect();
        let chunk_refs: Vec<&str> = chunks.iter().map(String::as_str).collect();
        assert_eq!(filter_chunks(&chunk_refs), "正文\n继续的正文");
    }

    #[test]
    fn strips_continuation_header_for_all_known_roles() {
        for role in ["assistant", "user", "system"] {
            let input = format!("回答\n<|im_start|>{role}\n多余的续写");
            assert_eq!(
                filter_chunks(&[input.as_str()]),
                "回答\n多余的续写",
                "role: {role}"
            );
        }
    }

    #[test]
    fn strips_continuation_header_at_stream_head_and_at_flush() {
        // At stream head the whole header line disappears (previously the
        // role word leaked as content).
        assert_eq!(filter_chunks(&["<|im_start|>assistant\n你好"]), "你好");
        // Stream ends right on the header (stop finally hit): drop it.
        assert_eq!(
            filter_chunks(&["正文\n", "<|im_start|>assistant"]),
            "正文\n"
        );
        // Trailing whitespace after the role word is still a header.
        assert_eq!(
            filter_chunks(&["正文\n<|im_start|>assistant \n续写"]),
            "正文\n续写"
        );
    }

    #[test]
    fn stripped_continuation_header_opens_wrapper_for_its_closer() {
        // The runaway turn's own `<|im_end|>` pairs with the stripped header.
        assert_eq!(
            filter_chunks(&["正文\n<|im_start|>assistant\n续写<|im_end|>"]),
            "正文\n续写"
        );
    }

    #[test]
    fn preserves_role_word_lines_that_are_not_bare_headers() {
        // Mid-line mention: not line-leading, untouched.
        let prose = "标记 <|im_start|>assistant 用于协议说明。";
        assert_eq!(filter_chunks(&["前文\n", prose]), format!("前文\n{prose}"));
        // Line-leading but with more content after the role word: literal.
        assert_eq!(
            filter_chunks(&["前文\n<|im_start|>assistant 是协议头\n后文"]),
            "前文\n<|im_start|>assistant 是协议头\n后文"
        );
        // Role word extended into a longer word: literal.
        assert_eq!(
            filter_chunks(&["前文\n<|im_start|>assistants\n后文"]),
            "前文\n<|im_start|>assistants\n后文"
        );
        // Partial role word at end of stream: cannot confirm, emit literally.
        assert_eq!(
            filter_chunks(&["前文\n<|im_start|>assi"]),
            "前文\n<|im_start|>assi"
        );
    }

    // ------------------------------------------------------------------
    // Stop-token failure: closer glued to the end of the stream
    // ------------------------------------------------------------------

    #[test]
    fn strips_tail_glued_closer_at_flush() {
        assert_eq!(filter_chunks(&["回答完毕<|im_end|>"]), "回答完毕");
        assert_eq!(
            filter_chunks(&["回答完毕<|im_end|>", "<|endoftext|>"]),
            "回答完毕"
        );
        // Held whitespace between/after the closers survives; token text does not.
        assert_eq!(filter_chunks(&["回答完毕<|im_end|>\n"]), "回答完毕\n");
        assert_eq!(filter_chunks(&["回答完毕<|end_of_box|> "]), "回答完毕 ");
    }

    #[test]
    fn strips_tail_glued_closer_followed_by_blank_lines_at_flush() {
        // Regression: the first newline after a held closer kept holding, but
        // a following blank/whitespace-only line released the hold verbatim,
        // leaking the token even though only whitespace followed until flush.
        assert_eq!(filter_chunks(&["回答完毕<|im_end|>\n\n"]), "回答完毕\n\n");
        assert_eq!(filter_chunks(&["回答完毕<|im_end|>\n \n"]), "回答完毕\n \n");
        // Substantive content after the blank line still releases verbatim.
        assert_eq!(
            filter_chunks(&["字面<|im_end|>\n\n下一段正文"]),
            "字面<|im_end|>\n\n下一段正文"
        );
    }

    #[test]
    fn preserves_mid_stream_glued_closer_when_content_follows() {
        // A literal mention followed by more prose must be released verbatim.
        assert_eq!(
            filter_chunks(&["字面 <|im_end|> 后还有字"]),
            "字面 <|im_end|> 后还有字"
        );
        assert_eq!(
            filter_chunks(&["字面<|im_end|>\n下一段正文"]),
            "字面<|im_end|>\n下一段正文"
        );
    }

    // ------------------------------------------------------------------
    // Inline-code state resets at end of line
    // ------------------------------------------------------------------

    #[test]
    fn unpaired_backtick_does_not_disable_filtering_past_the_line() {
        // Regression: a lone backtick used to latch Inline state forever,
        // letting every later token pass as code-span content.
        assert_eq!(
            filter_chunks(&["看 `代码\n", "<|im_end|>\n", "尾行"]),
            "看 `代码\n尾行"
        );
        // Same-line inline code still protects its token.
        assert_eq!(
            filter_chunks(&["行内 `<|im_end|>` 保留\n<|im_end|>\n尾行"]),
            "行内 `<|im_end|>` 保留\n尾行"
        );
    }

    // ------------------------------------------------------------------
    // Cursor-based input consumption (large-chunk regression)
    // ------------------------------------------------------------------

    #[test]
    fn large_single_chunk_keeps_semantics_with_cursor_consumption() {
        // Regression companion for the cursor-based `consume_prefix`:
        // front-draining the buffer per consumed char/token was O(n²) on a
        // large chunk. The rewrite must not change semantics — the leading
        // wrapper and its matching closer are still stripped, while mid-line
        // literal tokens followed by more prose still survive verbatim.
        let mut body = String::new();
        for index in 0..2_000 {
            body.push_str("第");
            body.push_str(&index.to_string());
            body.push_str("行正文，字面 <|im_end|> 保留。\n");
        }
        let input = format!("<|begin_of_box|>{body}<|end_of_box|>");

        assert_eq!(filter_chunks(&[input.as_str()]), body);

        // The same stream torn into two big halves (split kept on a char
        // boundary) must agree with the single-chunk result: compaction at
        // the end of a pass may not leak or duplicate held bytes.
        let mid = (input.len() / 2..)
            .find(|offset| input.is_char_boundary(*offset))
            .expect("a char boundary exists in the second half");
        assert_eq!(filter_chunks(&[&input[..mid], &input[mid..]]), body);
    }
}
