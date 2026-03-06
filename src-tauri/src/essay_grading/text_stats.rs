use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EssayTextStats {
    /// 中文汉字数（Han script）
    pub han_chars: usize,
    /// 英文词数
    pub english_words: usize,
    /// 标点总数（Unicode punctuation）
    pub punctuation_total: usize,
    /// 中文标点数（常见全角标点）
    pub cn_punctuation: usize,
    /// 英文标点数（ASCII 标点）
    pub en_punctuation: usize,
    /// 非空白字符数
    pub non_whitespace_chars: usize,
    /// 总字符数（Unicode scalar count）
    pub total_chars: usize,
    /// 行数
    pub line_count: usize,
    /// 段落数（按空行分段）
    pub paragraph_count: usize,
}

const CN_PUNCTUATION: &[char] = &[
    '，', '。', '！', '？', '；', '：', '、', '（', '）', '【', '】', '《', '》', '〈', '〉', '「',
    '」', '『', '』', '〔', '〕', '“', '”', '‘', '’', '—', '–', '…', '．', '·',
];

fn is_ascii_punctuation(c: char) -> bool {
    matches!(
        c,
        '!' | '"'
            | '#'
            | '$'
            | '%'
            | '&'
            | '\''
            | '('
            | ')'
            | '*'
            | '+'
            | ','
            | '-'
            | '.'
            | '/'
            | ':'
            | ';'
            | '<'
            | '='
            | '>'
            | '?'
            | '@'
            | '['
            | '\\'
            | ']'
            | '^'
            | '_'
            | '`'
            | '{'
            | '|'
            | '}'
            | '~'
    )
}

pub fn calculate_text_stats(text: &str) -> EssayTextStats {
    let han_re = Regex::new(r"\p{Han}").expect("valid han regex");
    let en_word_re = Regex::new(r"[A-Za-z]+(?:['’-][A-Za-z]+)*").expect("valid english word regex");
    let punct_re = Regex::new(r"\p{P}").expect("valid punctuation regex");
    let paragraph_re = Regex::new(r"\r?\n\s*\r?\n").expect("valid paragraph split regex");

    let han_chars = han_re.find_iter(text).count();
    let english_words = en_word_re.find_iter(text).count();
    let punctuation_total = punct_re.find_iter(text).count();

    let mut cn_punctuation = 0usize;
    let mut en_punctuation = 0usize;
    let mut non_whitespace_chars = 0usize;
    let mut total_chars = 0usize;

    for ch in text.chars() {
        total_chars += 1;
        if !ch.is_whitespace() {
            non_whitespace_chars += 1;
        }
        if CN_PUNCTUATION.contains(&ch) {
            cn_punctuation += 1;
        } else if is_ascii_punctuation(ch) {
            en_punctuation += 1;
        }
    }

    let normalized_line_text = text.replace("\r\n", "\n");
    let line_count = if normalized_line_text.is_empty() {
        0
    } else {
        normalized_line_text.split('\n').count()
    };
    let paragraph_count = paragraph_re
        .split(text)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .count();

    EssayTextStats {
        han_chars,
        english_words,
        punctuation_total,
        cn_punctuation,
        en_punctuation,
        non_whitespace_chars,
        total_chars,
        line_count,
        paragraph_count,
    }
}

pub fn build_stats_prompt_block(stats: &EssayTextStats) -> String {
    format!(
        "【写作统计（系统自动计算）】\n- 中文字数（汉字）: {}\n- 英文词数: {}\n- 标点总数: {}\n- 中文标点: {}\n- 英文标点: {}\n- 非空白字符数: {}\n- 总字符数: {}\n- 段落数: {}\n- 行数: {}\n\n请在判断是否达到字数要求时，优先依据以上统计，不要依据 token 估算。\n\n",
        stats.han_chars,
        stats.english_words,
        stats.punctuation_total,
        stats.cn_punctuation,
        stats.en_punctuation,
        stats.non_whitespace_chars,
        stats.total_chars,
        stats.paragraph_count,
        stats.line_count
    )
}

#[cfg(test)]
mod tests {
    use super::calculate_text_stats;

    #[test]
    fn calculates_mixed_zh_en_stats() {
        let text = "你好，world! It's fine.\n第二段……";
        let stats = calculate_text_stats(text);
        assert_eq!(stats.han_chars, 5);
        assert_eq!(stats.english_words, 3);
        assert!(stats.punctuation_total >= 5);
        assert_eq!(stats.paragraph_count, 1);
        assert_eq!(stats.line_count, 2);
    }

    #[test]
    fn handles_empty_text() {
        let stats = calculate_text_stats("");
        assert_eq!(stats.han_chars, 0);
        assert_eq!(stats.english_words, 0);
        assert_eq!(stats.punctuation_total, 0);
        assert_eq!(stats.line_count, 0);
        assert_eq!(stats.paragraph_count, 0);
    }

    #[test]
    fn paragraph_split_handles_windows_newline_and_blank_spaces() {
        let text = "第一段\r\n\r\n   \r\n第二段";
        let stats = calculate_text_stats(text);
        assert_eq!(stats.paragraph_count, 2);
    }
}
