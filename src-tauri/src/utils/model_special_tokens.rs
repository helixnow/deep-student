//! Conservative streaming cleanup for protocol tokens leaked by GLM/Qwen.
//!
//! This intentionally does not perform a global string replacement. A token is
//! removed only when it is an outer wrapper, an otherwise-empty logical line,
//! or the matching close token for a wrapper removed earlier in the stream.
//! Markdown code spans and fenced code blocks are always passed through.

const MODEL_SPECIAL_TOKENS: &[&str] = &[
    "<|begin_of_box|>",
    "<|end_of_box|>",
    "<|im_start|>",
    "<|im_end|>",
    "<|endoftext|>",
];

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
    line_candidate: String,
    line_candidate_tokens: Vec<&'static str>,
    line_is_candidate: bool,
    stream_has_substantive_text: bool,
    code: Option<MarkdownCode>,
    box_wrapper_open: bool,
    im_wrapper_open: bool,
}

impl ModelWrapTokenStreamFilter {
    pub fn new(policy: ModelWrapTokenPolicy) -> Self {
        Self {
            policy,
            input: String::new(),
            line_candidate: String::new(),
            line_candidate_tokens: Vec::new(),
            line_is_candidate: true,
            stream_has_substantive_text: false,
            code: None,
            box_wrapper_open: false,
            im_wrapper_open: false,
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
        if self.line_is_candidate {
            if self.line_candidate_tokens.is_empty() || self.code.is_some() {
                output.push_str(&self.line_candidate);
            } else {
                self.record_stripped_candidate_tokens();
            }
            self.clear_line_candidate();
        }
        output
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.policy);
    }

    fn process_available(&mut self, flushing: bool) -> String {
        let mut output = String::new();

        while !self.input.is_empty() {
            if self.input.starts_with('<') {
                if let Some(token) = token_at_start(&self.input) {
                    self.consume_prefix(token.len());
                    self.process_token(token, &mut output);
                    continue;
                }
                if !flushing && is_incomplete_token_prefix(&self.input) {
                    break;
                }
            }

            let ch = self.input.chars().next().expect("input is not empty");
            if ch == '`' || ch == '~' {
                let width = self.input.chars().take_while(|value| *value == ch).count();
                if !flushing && width == self.input.chars().count() {
                    break;
                }
                self.consume_prefix(width);
                self.process_marker_run(ch, width, &mut output);
                continue;
            }

            self.consume_prefix(ch.len_utf8());
            if ch == '\n' {
                self.process_newline(&mut output);
            } else if ch.is_whitespace() && self.line_is_candidate {
                self.line_candidate.push(ch);
            } else {
                self.begin_literal_content(&mut output);
                output.push(ch);
                if !ch.is_whitespace() {
                    self.stream_has_substantive_text = true;
                }
            }
        }

        output
    }

    fn consume_prefix(&mut self, byte_len: usize) {
        self.input.drain(..byte_len);
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
        } else {
            output.push_str(token);
            self.stream_has_substantive_text = true;
        }
    }

    fn process_newline(&mut self, output: &mut String) {
        if self.line_is_candidate {
            if !self.line_candidate_tokens.is_empty() && self.code.is_none() {
                // Remove the token-only logical line, including its newline.
                self.record_stripped_candidate_tokens();
            } else {
                output.push_str(&self.line_candidate);
                output.push('\n');
            }
            self.clear_line_candidate();
        } else {
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
}
