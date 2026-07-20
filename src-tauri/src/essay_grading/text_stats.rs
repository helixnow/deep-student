use std::sync::LazyLock;

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

/// 与前端 textStats.ts 中 JS 正则 `\s` 完全一致的空白字符集。
///
/// 注意与 Rust `char::is_whitespace`（Unicode White_Space 属性）的两处差异：
/// - JS `\s` 包含 U+FEFF（BOM / 零宽不换行空格），White_Space 不包含；
/// - JS `\s` 不包含 U+0085（NEL），White_Space 包含。
/// 统计口径以前端为准，保证 UI 字数与 prompt 注入的统计块一致。
fn is_frontend_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{000B}'
            | '\u{000C}'
            | '\r'
            | ' '
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

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

static HAN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{Han}").expect("valid han regex"));
static EN_WORD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z]+(?:['’-][A-Za-z]+)*").expect("valid english word regex")
});
static PUNCT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{P}").expect("valid punctuation regex"));
/// 段落分隔正则：空白类使用与前端 JS `\s` 一致的显式字符集（见 is_frontend_whitespace）
static PARAGRAPH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\r?\n[\t\n\x0B\x0C\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\r?\n",
    )
    .expect("valid paragraph split regex")
});

pub fn calculate_text_stats(text: &str) -> EssayTextStats {
    let han_chars = HAN_RE.find_iter(text).count();
    let english_words = EN_WORD_RE.find_iter(text).count();
    let punctuation_total = PUNCT_RE.find_iter(text).count();

    let mut cn_punctuation = 0usize;
    let mut en_punctuation = 0usize;
    let mut non_whitespace_chars = 0usize;
    let mut total_chars = 0usize;

    for ch in text.chars() {
        total_chars += 1;
        if !is_frontend_whitespace(ch) {
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
    let paragraph_count = PARAGRAPH_RE
        .split(text)
        .map(|p| p.trim_matches(is_frontend_whitespace))
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

    /// 前端 JS `\s` 包含 U+FEFF（BOM），因此 BOM 不计入非空白字符
    #[test]
    fn bom_is_whitespace_like_frontend() {
        let text = "\u{FEFF}你好";
        let stats = calculate_text_stats(text);
        assert_eq!(stats.total_chars, 3);
        assert_eq!(stats.non_whitespace_chars, 2);
        assert_eq!(stats.han_chars, 2);
    }

    /// 前端 JS `\s` 不包含 U+0085（NEL），因此 NEL 计入非空白字符
    #[test]
    fn nel_is_not_whitespace_like_frontend() {
        let text = "a\u{0085}b";
        let stats = calculate_text_stats(text);
        assert_eq!(stats.non_whitespace_chars, 3);
    }

    /// 空行中夹杂 BOM 时仍视为段落分隔（与前端 /\r?\n\s*\r?\n/ 一致）
    #[test]
    fn paragraph_split_treats_bom_blank_line_as_separator() {
        let text = "第一段\n\u{FEFF}\n第二段";
        let stats = calculate_text_stats(text);
        assert_eq!(stats.paragraph_count, 2);
    }

    /// 英文缩写与连字符按单词整体计数（与前端 EN_WORD_RE 一致）
    #[test]
    fn english_words_count_contractions_and_hyphens() {
        let text = "state-of-the-art isn't don’t two words";
        let stats = calculate_text_stats(text);
        assert_eq!(stats.english_words, 5);
    }

    /// 中英文标点分别归类，且互不重复计数
    #[test]
    fn cn_and_en_punctuation_are_disjoint() {
        let text = "你好，世界。Hello, world!";
        let stats = calculate_text_stats(text);
        assert_eq!(stats.cn_punctuation, 2);
        assert_eq!(stats.en_punctuation, 2);
        assert_eq!(stats.punctuation_total, 4);
    }

    /// 尾部空段不计入段落数
    #[test]
    fn trailing_blank_lines_do_not_add_paragraphs() {
        let text = "唯一段落\n\n\n";
        let stats = calculate_text_stats(text);
        assert_eq!(stats.paragraph_count, 1);
    }
}
