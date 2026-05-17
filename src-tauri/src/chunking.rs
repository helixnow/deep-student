//! 文档分块（chunking）公共模块
//!
//! 该模块抽取了 `exam_sheet_service` 与 `question_import_service` 中重复的分段
//! 逻辑：按段落边界（双换行优先，单换行回退）合并到 token 上限附近，超长单段
//! 按字符强制切分。token 估算使用粗略的 "字符数 / 2"（中文≈1.5 字符/token，
//! 英文≈4 字符/token，取平均 2 字符/token）。
//!
//! 设计说明：
//! - 仅抽取 **完全一致** 的 `segment_document_for_questions` /
//!   `segment_document` 实现作为共享逻辑。
//! - `document_processing_service` 拥有自己的中文感知 token 估算 + 句子粒度
//!   长段切分 + 复杂重叠策略，行为差异较大，**不在此模块复用**，避免引入
//!   隐式行为变更。
//! - `ChunkConfig::overlap_tokens` 字段保留以备未来扩展，但当前实现仅在
//!   `Some(n)` 时按字符级简单 prefix-overlap 处理；现有调用方均传 `None`
//!   以保留旧行为。
//!
//! 默认 `max_tokens_per_chunk = 6000`：与现有 4 处硬编码值保持一致。

/// 分块配置
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkConfig {
    /// 单个 chunk 允许的最大 token 数（粗略估算：字符数 / 2）。
    pub max_tokens_per_chunk: usize,
    /// 可选：相邻 chunk 之间重叠的 token 数。`None` 表示不重叠。
    pub overlap_tokens: Option<usize>,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            max_tokens_per_chunk: 6000,
            overlap_tokens: None,
        }
    }
}

impl ChunkConfig {
    /// 仅指定 max_tokens 的便捷构造器，等价于旧 `segment_document(content, max_tokens)`。
    pub fn with_max_tokens(max_tokens_per_chunk: usize) -> Self {
        Self {
            max_tokens_per_chunk,
            overlap_tokens: None,
        }
    }
}

/// 粗略估算 token 数：字符数 / 2。
///
/// 该估算与 `exam_sheet_service` / `question_import_service` 旧实现保持
/// 一致。若需中文感知或词级估算，请使用调用方自有实现。
#[inline]
pub fn estimate_tokens_simple(text: &str) -> usize {
    text.chars().count() / 2
}

/// 将文档按段落切分为多个 chunk，每个 chunk 的估算 token 数不超过
/// `config.max_tokens_per_chunk`。
///
/// 切分策略（与旧实现保持一致）：
/// 1. 优先按 `\n\n` 切段；若得到的段落少于 3 个，回退按 `\n` 切段。
/// 2. 单个段落若超过 token 上限，先 flush 当前 chunk，再按
///    `max_tokens * 2` 字符强制切分。
/// 3. 段落能放入当前 chunk 时累加；放不下则 flush 并开新 chunk。
///
/// 返回的每个 chunk 已 `trim()`。
pub fn segment_document(text: &str, config: &ChunkConfig) -> Vec<String> {
    let max_tokens = config.max_tokens_per_chunk;

    let paragraphs: Vec<&str> = text
        .split("\n\n")
        .filter(|p| !p.trim().is_empty())
        .collect();

    let paragraphs: Vec<&str> = if paragraphs.len() < 3 {
        text.split('\n')
            .filter(|p| !p.trim().is_empty())
            .collect()
    } else {
        paragraphs
    };

    let mut chunks: Vec<String> = Vec::new();
    let mut current_chunk = String::new();
    let mut current_tokens = 0usize;

    for para in paragraphs {
        let para_tokens = estimate_tokens_simple(para);

        if para_tokens > max_tokens {
            if !current_chunk.is_empty() {
                chunks.push(current_chunk.trim().to_string());
                current_chunk.clear();
                current_tokens = 0;
            }
            let char_limit = max_tokens.saturating_mul(2).max(1);
            let chars: Vec<char> = para.chars().collect();
            for chunk_chars in chars.chunks(char_limit) {
                chunks.push(chunk_chars.iter().collect());
            }
            continue;
        }

        if current_tokens + para_tokens > max_tokens && !current_chunk.is_empty() {
            chunks.push(current_chunk.trim().to_string());
            current_chunk = para.to_string();
            current_tokens = para_tokens;
        } else {
            if !current_chunk.is_empty() {
                current_chunk.push_str("\n\n");
            }
            current_chunk.push_str(para);
            current_tokens += para_tokens;
        }
    }

    if !current_chunk.is_empty() {
        chunks.push(current_chunk.trim().to_string());
    }

    if let Some(overlap) = config.overlap_tokens {
        if overlap > 0 && chunks.len() > 1 {
            return apply_simple_overlap(chunks, overlap);
        }
    }

    chunks
}

/// 在相邻 chunk 间插入字符级 overlap：将上一段尾部 `overlap_tokens * 2`
/// 字符前置到下一段。当前调用方均传 `None`，此函数仅供未来扩展使用。
fn apply_simple_overlap(chunks: Vec<String>, overlap_tokens: usize) -> Vec<String> {
    let overlap_chars = overlap_tokens.saturating_mul(2);
    let mut out: Vec<String> = Vec::with_capacity(chunks.len());

    for (i, chunk) in chunks.iter().enumerate() {
        if i == 0 {
            out.push(chunk.clone());
            continue;
        }
        let prev: &str = &chunks[i - 1];
        let prev_chars: Vec<char> = prev.chars().collect();
        let take_from = prev_chars.len().saturating_sub(overlap_chars);
        let prefix: String = prev_chars[take_from..].iter().collect();
        let combined = if prefix.is_empty() {
            chunk.clone()
        } else {
            format!("{}\n\n{}", prefix.trim(), chunk)
        };
        out.push(combined);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_matches_legacy_constants() {
        let cfg = ChunkConfig::default();
        assert_eq!(cfg.max_tokens_per_chunk, 6000);
        assert!(cfg.overlap_tokens.is_none());
    }

    #[test]
    fn short_doc_yields_single_chunk() {
        let text = "Hello world.\n\nThis is short.";
        let chunks = segment_document(text, &ChunkConfig::default());
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].contains("Hello world."));
        assert!(chunks[0].contains("This is short."));
    }

    #[test]
    fn empty_input_yields_no_chunks() {
        let chunks = segment_document("", &ChunkConfig::default());
        assert!(chunks.is_empty());
        let chunks_ws = segment_document("\n\n   \n\n", &ChunkConfig::default());
        assert!(chunks_ws.is_empty());
    }

    #[test]
    fn long_doc_splits_by_paragraph_boundary() {
        // 6 个段落 × 每个 ~200 字符 ≈ 100 tokens 每段，总 ≈ 600 tokens；
        // max=120 → 应切成多块。
        let para = "x".repeat(200);
        let text = std::iter::repeat(para.as_str())
            .take(6)
            .collect::<Vec<_>>()
            .join("\n\n");
        let cfg = ChunkConfig::with_max_tokens(120);
        let chunks = segment_document(&text, &cfg);
        assert!(
            chunks.len() >= 2,
            "expected multiple chunks, got {}",
            chunks.len()
        );
        for c in &chunks {
            assert!(
                estimate_tokens_simple(c) <= 120 + 100, // 允许单段累加略超
                "chunk too large: {} tokens",
                estimate_tokens_simple(c)
            );
        }
    }

    #[test]
    fn oversized_paragraph_is_force_split() {
        // 单段 1000 字符 ≈ 500 tokens；max=100 → 强制按 char_limit=200 切。
        let huge = "y".repeat(1000);
        let cfg = ChunkConfig::with_max_tokens(100);
        let chunks = segment_document(&huge, &cfg);
        assert_eq!(chunks.len(), 5, "1000 chars / (100*2) = 5 chunks");
        for c in &chunks {
            assert!(c.chars().count() <= 200);
        }
    }

    #[test]
    fn boundary_exactly_at_max_keeps_single_chunk() {
        // max=100 tokens → 200 字符上限。准备恰好 200 字符的单段。
        let text: String = "a".repeat(200);
        let cfg = ChunkConfig::with_max_tokens(100);
        let chunks = segment_document(&text, &cfg);
        // 单段 token = 100 == max，按规则不会进入 force-split 分支
        // (条件是 para_tokens > max_tokens)
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chars().count(), 200);
    }

    #[test]
    fn fallback_to_single_newline_when_few_double_newlines() {
        // 没有双换行：应回退按单换行切段。
        let text = "line one\nline two\nline three\nline four";
        let cfg = ChunkConfig::with_max_tokens(5); // 强制每行单独成块
        let chunks = segment_document(text, &cfg);
        assert_eq!(chunks.len(), 4);
        assert_eq!(chunks[0], "line one");
        assert_eq!(chunks[3], "line four");
    }

    #[test]
    fn overlap_disabled_by_default() {
        let para_a = "alpha ".repeat(50);
        let para_b = "beta ".repeat(50);
        let text = format!("{}\n\n{}", para_a, para_b);
        let cfg = ChunkConfig::with_max_tokens(80);
        let chunks_no = segment_document(&text, &cfg);
        let cfg_ov = ChunkConfig {
            max_tokens_per_chunk: 80,
            overlap_tokens: Some(20),
        };
        let chunks_ov = segment_document(&text, &cfg_ov);
        assert_eq!(chunks_no.len(), chunks_ov.len());
        // 启用 overlap 时除第一块外，其余 chunk 均应包含上一块的尾部内容
        if chunks_no.len() >= 2 {
            assert_ne!(
                chunks_ov[1], chunks_no[1],
                "overlap should mutate downstream chunks"
            );
        }
    }

    /// 行为保留 smoke test：复刻旧 `question_import_service::segment_document`
    /// 的字面实现，与新共享实现在多种输入上对比 chunk 数量与每块内容。
    #[test]
    fn behavior_preservation_vs_legacy_impl() {
        fn legacy_segment_document(content: &str, max_tokens: usize) -> Vec<String> {
            let paragraphs: Vec<&str> = content
                .split("\n\n")
                .filter(|p| !p.trim().is_empty())
                .collect();
            let paragraphs: Vec<&str> = if paragraphs.len() < 3 {
                content
                    .split('\n')
                    .filter(|p| !p.trim().is_empty())
                    .collect()
            } else {
                paragraphs
            };
            let mut chunks = Vec::new();
            let mut current_chunk = String::new();
            let mut current_tokens = 0;
            for para in paragraphs {
                let para_tokens = para.chars().count() / 2;
                if para_tokens > max_tokens {
                    if !current_chunk.is_empty() {
                        chunks.push(current_chunk.trim().to_string());
                        current_chunk.clear();
                        current_tokens = 0;
                    }
                    let char_limit = max_tokens * 2;
                    let chars: Vec<char> = para.chars().collect();
                    for chunk_chars in chars.chunks(char_limit) {
                        chunks.push(chunk_chars.iter().collect());
                    }
                    continue;
                }
                if current_tokens + para_tokens > max_tokens && !current_chunk.is_empty() {
                    chunks.push(current_chunk.trim().to_string());
                    current_chunk = para.to_string();
                    current_tokens = para_tokens;
                } else {
                    if !current_chunk.is_empty() {
                        current_chunk.push_str("\n\n");
                    }
                    current_chunk.push_str(para);
                    current_tokens += para_tokens;
                }
            }
            if !current_chunk.is_empty() {
                chunks.push(current_chunk.trim().to_string());
            }
            chunks
        }

        // 1) 短文档
        let s1 = "短文一段。\n\n短文二段。";
        assert_eq!(
            segment_document(s1, &ChunkConfig::default()),
            legacy_segment_document(s1, 6000)
        );

        // 2) ~10K 字符多段文档
        let para = "这是一段示范性的文本内容，用于检验分块逻辑是否一致。".repeat(10);
        let s2 = std::iter::repeat(para.as_str())
            .take(40)
            .collect::<Vec<_>>()
            .join("\n\n");
        assert_eq!(
            segment_document(&s2, &ChunkConfig::with_max_tokens(500)),
            legacy_segment_document(&s2, 500)
        );

        // 3) 含超长单段
        let oversized = "z".repeat(3000);
        let s3 = format!("intro\n\n{}\n\noutro", oversized);
        assert_eq!(
            segment_document(&s3, &ChunkConfig::with_max_tokens(200)),
            legacy_segment_document(&s3, 200)
        );

        // 4) 仅单换行（触发回退）
        let s4 = "a\nbb\nccc\ndddd";
        assert_eq!(
            segment_document(s4, &ChunkConfig::with_max_tokens(2)),
            legacy_segment_document(s4, 2)
        );
    }
}
