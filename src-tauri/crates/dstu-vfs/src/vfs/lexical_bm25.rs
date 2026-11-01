//! BM25 lexical scoring for the SQLite text-ledger route.
//!
//! Ported from BA7MLV/wangke-agent `src/harness/lexical.ts`
//! (Copyright (c) 2026 BA7MLV, MIT License). The scoring idea is kept as-is:
//!
//! - Tokenisation needs no dictionary: CJK runs emit every **unigram and adjacent bigram**
//!   (unigrams keep single-character queries such as 「幂」 matchable, bigrams carry precision),
//!   latin/number runs stay whole so identifiers like `E1234` / `bge` match literally.
//!   Query and document go through the same function — that symmetry is the only hard rule.
//! - Non-negative idf variant `ln(1 + (N - df + 0.5) / (df + 0.5))`: the classic form turns
//!   negative once `df > N/2`, which on a small candidate set ranks common words *up*.
//! - Coverage bonus: `score *= 1 + bonus * matched_terms / query_terms`, so a passage that
//!   contains every query term beats one that repeats a single term many times.
//!
//! DeepStudent adaptation: the candidate set is the LIKE-prefiltered ledger rows of
//! `execute_fts_route`, so this module only scores — it never scans the whole corpus. All
//! accumulation runs in query-term order over `Vec`s (no map iteration), so equal inputs
//! always produce bit-identical scores and a stable ranking.

use std::collections::HashMap;

/// Upper bound of characters scored per document. Ledger rows are chunks/pages in the
/// common case; whole-document units (long notes) are scored on their head only so a
/// single huge row cannot dominate route latency.
pub const MAX_SCORED_DOC_CHARS: usize = 12_000;

/// BM25 parameters (defaults match the original implementation).
#[derive(Debug, Clone, Copy)]
pub struct Bm25Options {
    /// Term-frequency saturation.
    pub k1: f64,
    /// Length normalisation strength (0 = none, 1 = full).
    pub b: f64,
    /// Coverage bonus factor; 0 disables it.
    pub coverage_bonus: f64,
}

impl Default for Bm25Options {
    fn default() -> Self {
        Self {
            k1: 1.2,
            b: 0.75,
            coverage_bonus: 0.5,
        }
    }
}

/// CJK ideographs and Japanese kana — the scripts without word boundaries. Full-width
/// punctuation is deliberately excluded: it is a natural separator.
pub fn is_cjk_char(character: char) -> bool {
    matches!(
        character as u32,
        0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
    )
}

fn is_word_char(character: char) -> bool {
    !is_cjk_char(character) && character.is_alphanumeric()
}

/// Calls `emit` for every token of an already lower-cased `text`, in text order.
fn for_each_token<'a>(text: &'a str, mut emit: impl FnMut(&'a str)) {
    let mut chars = text.char_indices().peekable();
    while let Some((start, character)) = chars.next() {
        if is_cjk_char(character) {
            // Collect the CJK run as byte offsets of each character.
            let mut bounds = vec![start];
            let mut end = start + character.len_utf8();
            while let Some(&(index, next)) = chars.peek() {
                if !is_cjk_char(next) {
                    break;
                }
                bounds.push(index);
                end = index + next.len_utf8();
                chars.next();
            }
            bounds.push(end);
            let count = bounds.len() - 1;
            for position in 0..count {
                emit(&text[bounds[position]..bounds[position + 1]]);
                if position + 2 <= count {
                    emit(&text[bounds[position]..bounds[position + 2]]);
                }
            }
        } else if is_word_char(character) {
            let mut end = start + character.len_utf8();
            while let Some(&(index, next)) = chars.peek() {
                if !is_word_char(next) {
                    break;
                }
                end = index + next.len_utf8();
                chars.next();
            }
            emit(&text[start..end]);
        }
        // Everything else (whitespace, punctuation, symbols) separates tokens.
    }
}

/// Tokenises `text` case-insensitively (see module docs).
pub fn tokenize(text: &str) -> Vec<String> {
    let lowered = text.to_lowercase();
    let mut tokens = Vec::new();
    for_each_token(&lowered, |token| tokens.push(token.to_string()));
    tokens
}

/// Non-negative BM25 idf.
pub fn bm25_idf(doc_count: usize, doc_freq: usize) -> f64 {
    let n = doc_count as f64;
    let df = doc_freq as f64;
    (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
}

fn head_chars(text: &str, max_chars: usize) -> &str {
    match text.char_indices().nth(max_chars) {
        Some((byte_index, _)) => &text[..byte_index],
        None => text,
    }
}

/// Scores every document against the (deduplicated, ordered) query terms.
///
/// Returns one score per input document, in input order. Documents that match no term
/// score `0.0`. `terms` must already be lower-cased tokens (use [`tokenize`]).
pub fn bm25_scores<S: AsRef<str>>(terms: &[String], docs: &[S], options: Bm25Options) -> Vec<f64> {
    let doc_count = docs.len();
    if terms.is_empty() || doc_count == 0 {
        return vec![0.0; doc_count];
    }
    let term_slot: HashMap<&str, usize> = terms
        .iter()
        .enumerate()
        .map(|(slot, term)| (term.as_str(), slot))
        .collect();

    // tf[doc][term]
    let mut term_freqs = vec![vec![0u32; terms.len()]; doc_count];
    let mut doc_lens = vec![0usize; doc_count];
    let mut doc_freqs = vec![0usize; terms.len()];
    for (doc_index, doc) in docs.iter().enumerate() {
        let scored = head_chars(doc.as_ref(), MAX_SCORED_DOC_CHARS);
        let lowered = scored.to_lowercase();
        doc_lens[doc_index] = lowered.chars().count();
        let freqs = &mut term_freqs[doc_index];
        for_each_token(&lowered, |token| {
            if let Some(&slot) = term_slot.get(token) {
                freqs[slot] += 1;
            }
        });
        for (slot, freq) in freqs.iter().enumerate() {
            if *freq > 0 {
                doc_freqs[slot] += 1;
            }
        }
    }

    let total_len: usize = doc_lens.iter().sum();
    let avg_len = if total_len == 0 {
        1.0
    } else {
        total_len as f64 / doc_count as f64
    };
    let idfs: Vec<f64> = doc_freqs
        .iter()
        .map(|df| bm25_idf(doc_count, *df))
        .collect();

    term_freqs
        .iter()
        .zip(doc_lens.iter())
        .map(|(freqs, len)| {
            let len_norm = 1.0 - options.b + options.b * (*len as f64) / avg_len;
            let mut score = 0.0;
            let mut matched = 0usize;
            for (slot, freq) in freqs.iter().enumerate() {
                if *freq == 0 {
                    continue;
                }
                matched += 1;
                let tf = *freq as f64;
                score += idfs[slot] * (tf * (options.k1 + 1.0)) / (tf + options.k1 * len_norm);
            }
            if score <= 0.0 {
                return 0.0;
            }
            if options.coverage_bonus > 0.0 {
                score *= 1.0 + options.coverage_bonus * (matched as f64 / terms.len() as f64);
            }
            score
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(query: &str) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        tokenize(query)
            .into_iter()
            .filter(|token| seen.insert(token.clone()))
            .collect()
    }

    #[test]
    fn tokenizer_emits_cjk_unigrams_bigrams_and_whole_latin_words() {
        assert_eq!(tokenize("幂运算"), vec!["幂", "幂运", "运", "运算", "算"]);
        assert_eq!(tokenize("单"), vec!["单"]);
        assert_eq!(
            tokenize("BGE-M3 用于 E1234"),
            vec!["bge", "m3", "用", "用于", "于", "e1234"]
        );
        // Full-width punctuation separates runs; Greek letters stay word characters.
        assert_eq!(tokenize("α粒子，β"), vec!["α", "粒", "粒子", "子", "β"]);
    }

    #[test]
    fn idf_is_never_negative() {
        assert!(bm25_idf(10, 10) > 0.0);
        assert!(bm25_idf(10, 1) > bm25_idf(10, 9));
    }

    #[test]
    fn single_character_query_matches_inside_words() {
        let docs = ["幂运算的定义", "加法交换律"];
        let scores = bm25_scores(&terms("幂"), &docs, Bm25Options::default());
        assert!(scores[0] > 0.0);
        assert_eq!(scores[1], 0.0);
    }

    #[test]
    fn full_coverage_beats_repeating_one_term() {
        let docs = [
            "傅里叶 傅里叶 傅里叶 傅里叶 傅里叶 傅里叶",
            "傅里叶变换把信号分解为频率分量",
            "今天天气不错",
        ];
        let scores = bm25_scores(&terms("傅里叶变换"), &docs, Bm25Options::default());
        assert!(scores[1] > scores[0], "{scores:?}");
        assert_eq!(scores[2], 0.0);
    }

    #[test]
    fn rare_terms_outweigh_common_terms() {
        let docs = [
            "这是一个关于梯度下降的例子",
            "这是一个关于数据的例子",
            "这是一个关于模型的例子",
        ];
        let scores = bm25_scores(&terms("梯度 例子"), &docs, Bm25Options::default());
        assert!(scores[0] > scores[1]);
        assert!((scores[1] - scores[2]).abs() < 1e-12);
    }

    #[test]
    fn scoring_is_deterministic_and_case_insensitive() {
        let docs = ["Lance VECTOR store", "lance vector", "other"];
        let first = bm25_scores(&terms("lance Vector"), &docs, Bm25Options::default());
        let second = bm25_scores(&terms("LANCE vector"), &docs, Bm25Options::default());
        assert_eq!(first, second);
        assert!(
            first[1] > first[0],
            "shorter doc wins at equal tf: {first:?}"
        );
        assert_eq!(first[2], 0.0);
    }

    #[test]
    fn huge_documents_are_scored_on_a_bounded_head() {
        let mut big = "其他文字".repeat(MAX_SCORED_DOC_CHARS);
        big.push_str("关键结论");
        let docs = [big.as_str(), "关键结论"];
        let scores = bm25_scores(&terms("关键结论"), &docs, Bm25Options::default());
        assert_eq!(scores[0], 0.0);
        assert!(scores[1] > 0.0);
    }
}
