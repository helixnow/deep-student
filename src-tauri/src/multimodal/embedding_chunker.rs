//! 嵌入文本分块器
//!
//! 解决长文本超过嵌入模型 token 限制的问题。
//!
//! ## 设计要点
//!
//! - **UTF-8 安全**: 所有分割操作都在字符边界进行，避免切断多字节字符
//! - **语义保持**: 优先在段落、句子边界分割，保持语义完整性
//! - **模型适配**: 根据不同嵌入模型的 token 限制自动调整
//!
//! ## Token 限制参考
//!
//! | 模型 | Token 限制 |
//! |------|-----------|
//! | BAAI/bge-large-zh/en-v1.5 | 512 |
//! | BAAI/bge-m3 | 8,192 |
//! | Qwen3-Embedding | 32,768 |
//! | text-embedding-3-small/large | 8,192 |
//! | voyage-3 | 32,000 |

use std::collections::HashMap;

/// 检查字符是否为 CJK 标点符号
#[inline]
fn is_cjk_punctuation(c: char) -> bool {
    matches!(c,
        '\u{3000}'..='\u{303F}' |  // CJK 标点符号（含「」『』【】《》等）
        '\u{FF00}'..='\u{FFEF}' |  // 全角字符（含，！？；：（）等）
        '\u{2000}'..='\u{206F}'    // 通用标点
    )
}

/// 嵌入模型 Token 限制配置
#[derive(Debug, Clone)]
pub struct EmbeddingTokenLimits {
    /// 默认安全限制（最保守）
    pub default_limit: usize,
    /// 已知模型的限制映射（模型名前缀 -> token 限制）
    model_limits: HashMap<String, usize>,
    /// 安全裕量（预留比例，如 0.9 表示使用 90% 的限制）
    pub safety_margin: f32,
}

impl Default for EmbeddingTokenLimits {
    fn default() -> Self {
        let mut limits = HashMap::new();

        // SiliconFlow 模型
        limits.insert("BAAI/bge-large-zh".into(), 512);
        limits.insert("BAAI/bge-large-en".into(), 512);
        limits.insert("netease-youdao/bce-embedding".into(), 512);
        limits.insert("BAAI/bge-m3".into(), 8192);
        limits.insert("Pro/BAAI/bge-m3".into(), 8192);
        limits.insert("Qwen/Qwen3-Embedding".into(), 32768);

        // OpenAI 模型
        limits.insert("text-embedding-3".into(), 8192);
        limits.insert("text-embedding-ada".into(), 8192);

        // Voyage AI 模型
        limits.insert("voyage-3".into(), 32000);
        limits.insert("voyage-code".into(), 32000);
        limits.insert("voyage-multilingual".into(), 32000);

        // Jina AI 模型
        limits.insert("jina-embeddings".into(), 8192);

        // Cohere 模型（较短）
        limits.insert("embed-".into(), 512);

        Self {
            default_limit: 512, // 最保守的默认值
            model_limits: limits,
            safety_margin: 0.9,
        }
    }
}

impl EmbeddingTokenLimits {
    /// 获取指定模型的 token 限制
    ///
    /// 按模型名前缀匹配，返回匹配到的限制或默认值
    pub fn get_limit(&self, model_name: &str) -> usize {
        // 按前缀匹配
        for (prefix, limit) in &self.model_limits {
            if model_name.starts_with(prefix) || model_name.contains(prefix) {
                let effective_limit = (*limit as f32 * self.safety_margin) as usize;
                log::debug!(
                    "[EmbeddingChunker] 模型 {} 匹配到限制 {} (安全值 {})",
                    model_name,
                    limit,
                    effective_limit
                );
                return effective_limit;
            }
        }

        // 默认值
        let effective_limit = (self.default_limit as f32 * self.safety_margin) as usize;
        log::warn!(
            "[EmbeddingChunker] 模型 {} 未匹配到已知限制，使用默认值 {} (安全值 {})",
            model_name,
            self.default_limit,
            effective_limit
        );
        effective_limit
    }

    /// 添加自定义模型限制
    pub fn add_limit(&mut self, model_prefix: &str, limit: usize) {
        self.model_limits.insert(model_prefix.to_string(), limit);
    }
}

/// 多块嵌入聚合方法
#[derive(Debug, Clone, Copy, Default)]
pub enum ChunkAggregation {
    /// 取第一块（适合标题/摘要优先的场景）
    First,
    /// 平均池化（适合长文档，默认）
    #[default]
    MeanPooling,
    /// 保留所有块（适合精细检索，返回多个向量）
    KeepAll,
}

/// 嵌入文本分块器
///
/// 将超过 token 限制的长文本分割为多个块
#[derive(Debug, Clone)]
pub struct EmbeddingChunker {
    /// Token 限制
    max_tokens: usize,
    /// 分块重叠 token 数（保持语义连贯）
    overlap_tokens: usize,
    /// 聚合方法
    aggregation: ChunkAggregation,
}

impl EmbeddingChunker {
    /// 创建分块器
    ///
    /// ## 参数
    /// - `max_tokens`: 最大 token 数
    /// - `overlap_tokens`: 重叠 token 数（默认 50）
    pub fn new(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            overlap_tokens: 50,
            aggregation: ChunkAggregation::MeanPooling,
        }
    }

    /// 设置重叠 token 数
    pub fn with_overlap(mut self, overlap: usize) -> Self {
        self.overlap_tokens = overlap;
        self
    }

    /// 设置聚合方法
    pub fn with_aggregation(mut self, aggregation: ChunkAggregation) -> Self {
        self.aggregation = aggregation;
        self
    }

    /// 获取聚合方法
    pub fn aggregation(&self) -> ChunkAggregation {
        self.aggregation
    }

    /// 估算文本的 token 数
    ///
    /// 使用启发式方法（保守估算，避免分块后单块超限）：
    /// - 中文字符：约 1.5 token/字符（tiktoken 对中文通常 1-3 tokens/字符）
    /// - 英文/数字：约 0.3 token/字符（约 3-4 字符/token）
    /// - 空白符：约 0.2 token/字符
    /// - 标点符号：约 1 token/字符
    ///
    /// ★ 2026-01 修复：之前使用 0.7 token/中文字符导致严重低估，
    /// 实际 tokenizer 对中文的处理方式不同，每个字符可能需要 1-3 tokens
    pub fn estimate_tokens(text: &str) -> usize {
        let mut chinese_count = 0usize;
        let mut ascii_count = 0usize;
        let mut space_count = 0usize;
        let mut punct_count = 0usize;

        for c in text.chars() {
            if c.is_whitespace() {
                space_count += 1;
            } else if c.is_ascii_punctuation() || is_cjk_punctuation(c) {
                // 标点符号（中英文）
                punct_count += 1;
            } else if c > '\u{4E00}' && c < '\u{9FFF}' {
                // CJK 统一汉字
                chinese_count += 1;
            } else if c > '\u{3400}' && c < '\u{4DBF}' {
                // CJK 扩展 A
                chinese_count += 1;
            } else if c > '\u{F900}' && c < '\u{FAFF}' {
                // CJK 兼容汉字
                chinese_count += 1;
            } else if c.is_ascii() {
                ascii_count += 1;
            } else {
                // 其他 Unicode 字符（日文、韩文等）按中文处理
                chinese_count += 1;
            }
        }

        // 计算估算 token 数（保守估算）
        // ★ 2026-01 修复：使用更保守的估算值
        let tokens = (chinese_count as f32 * 1.5)  // 中文：1.5 token/字符
            + (ascii_count as f32 * 0.3)           // 英文：0.3 token/字符
            + (space_count as f32 * 0.2)           // 空白：0.2 token/字符
            + (punct_count as f32 * 1.0); // 标点：1 token/字符

        // 至少返回 1
        (tokens.ceil() as usize).max(1)
    }

    /// 检查文本是否需要分块
    pub fn needs_chunking(&self, text: &str) -> bool {
        Self::estimate_tokens(text) > self.max_tokens
    }

    /// 将长文本分块
    ///
    /// ## 分割策略
    /// 1. 按段落边界分割（\n\n）
    /// 2. 如果单个段落超限，按句子边界分割（。！？.!?）
    /// 3. 如果单个句子超限，按 token 数量硬切割
    ///
    /// ## 返回
    /// 分块后的文本列表
    pub fn chunk_text(&self, text: &str) -> Vec<String> {
        let estimated_tokens = Self::estimate_tokens(text);

        // 不需要分块
        if estimated_tokens <= self.max_tokens {
            return vec![text.to_string()];
        }

        log::info!(
            "[EmbeddingChunker] 文本需要分块: {} tokens > {} 限制",
            estimated_tokens,
            self.max_tokens
        );

        // 按段落分割
        let paragraphs: Vec<&str> = text.split("\n\n").collect();
        let mut chunks = Vec::new();
        let mut current_chunk = String::new();
        let mut current_tokens = 0usize;

        for para in paragraphs {
            let para = para.trim();
            if para.is_empty() {
                continue;
            }

            let para_tokens = Self::estimate_tokens(para);

            // 当前块加上新段落会超限
            if current_tokens + para_tokens > self.max_tokens {
                // 保存当前块（如果非空）
                if !current_chunk.is_empty() {
                    chunks.push(current_chunk.trim().to_string());
                    current_chunk = String::new();
                    current_tokens = 0;
                }

                // 如果单个段落超限，需要进一步分割
                if para_tokens > self.max_tokens {
                    let sub_chunks = self.chunk_paragraph(para);
                    chunks.extend(sub_chunks);
                } else {
                    current_chunk = para.to_string();
                    current_tokens = para_tokens;
                }
            } else {
                // 可以添加到当前块
                if !current_chunk.is_empty() {
                    current_chunk.push_str("\n\n");
                }
                current_chunk.push_str(para);
                current_tokens += para_tokens;
            }
        }

        // 保存最后一块
        if !current_chunk.is_empty() {
            chunks.push(current_chunk.trim().to_string());
        }

        log::info!(
            "[EmbeddingChunker] 分块完成: {} tokens -> {} 块",
            estimated_tokens,
            chunks.len()
        );

        chunks
    }

    /// 分割单个段落（按句子边界）
    fn chunk_paragraph(&self, para: &str) -> Vec<String> {
        // 定义句子结束符
        let sentence_endings = ['。', '！', '？', '.', '!', '?', '；', ';', '\n'];

        let mut sentences = Vec::new();
        let mut current = String::new();

        for c in para.chars() {
            current.push(c);
            if sentence_endings.contains(&c) {
                if !current.trim().is_empty() {
                    sentences.push(current.trim().to_string());
                }
                current = String::new();
            }
        }

        // 处理没有句子结束符的剩余文本
        if !current.trim().is_empty() {
            sentences.push(current.trim().to_string());
        }

        // 如果没有分割出句子，直接硬切割
        if sentences.is_empty() {
            return self.hard_chunk(para);
        }

        // 合并句子直到接近限制
        let mut chunks = Vec::new();
        let mut current_chunk = String::new();
        let mut current_tokens = 0usize;

        for sentence in sentences {
            let sentence_tokens = Self::estimate_tokens(&sentence);

            // 单个句子超限，需要硬切割
            if sentence_tokens > self.max_tokens {
                if !current_chunk.is_empty() {
                    chunks.push(current_chunk.clone());
                    current_chunk = String::new();
                    current_tokens = 0;
                }
                chunks.extend(self.hard_chunk(&sentence));
                continue;
            }

            if current_tokens + sentence_tokens > self.max_tokens {
                if !current_chunk.is_empty() {
                    chunks.push(current_chunk.clone());
                }
                current_chunk = sentence;
                current_tokens = sentence_tokens;
            } else {
                if !current_chunk.is_empty() {
                    current_chunk.push(' ');
                }
                current_chunk.push_str(&sentence);
                current_tokens += sentence_tokens;
            }
        }

        if !current_chunk.is_empty() {
            chunks.push(current_chunk);
        }

        chunks
    }

    /// 硬切割文本（按字符边界，UTF-8 安全）
    ///
    /// 当文本无法按语义边界分割时使用
    fn hard_chunk(&self, text: &str) -> Vec<String> {
        let mut chunks = Vec::new();
        let mut current_chunk = String::new();
        let mut current_tokens = 0usize;

        // 按字符迭代，确保 UTF-8 安全
        // ★ 2026-01 修复：使用与 estimate_tokens 一致的保守估算值
        for c in text.chars() {
            let char_tokens = if c.is_whitespace() {
                0.2
            } else if c.is_ascii_punctuation() || is_cjk_punctuation(c) {
                1.0
            } else if c > '\u{4E00}' && c < '\u{9FFF}' {
                1.5
            } else if c.is_ascii() {
                0.3
            } else {
                1.5 // 其他 Unicode 字符按中文处理
            };

            let new_tokens = current_tokens as f32 + char_tokens;

            if new_tokens > self.max_tokens as f32 {
                // 当前块满了，保存并开始新块
                if !current_chunk.is_empty() {
                    chunks.push(current_chunk.clone());
                }
                current_chunk = String::new();
                current_chunk.push(c);
                current_tokens = char_tokens.ceil() as usize;
            } else {
                current_chunk.push(c);
                current_tokens = new_tokens.ceil() as usize;
            }
        }

        if !current_chunk.is_empty() {
            chunks.push(current_chunk);
        }

        log::debug!(
            "[EmbeddingChunker] 硬切割: {} 字符 -> {} 块",
            text.chars().count(),
            chunks.len()
        );

        chunks
    }

    /// 聚合多个块的嵌入向量
    ///
    /// ## 参数
    /// - `embeddings`: 多个块的嵌入向量
    ///
    /// ## 返回
    /// 聚合后的嵌入向量（如果使用 KeepAll，返回第一个）
    pub fn aggregate_embeddings(embeddings: &[Vec<f32>], method: ChunkAggregation) -> Vec<f32> {
        if embeddings.is_empty() {
            return Vec::new();
        }

        if embeddings.len() == 1 {
            return embeddings[0].clone();
        }

        match method {
            ChunkAggregation::First => embeddings[0].clone(),

            ChunkAggregation::MeanPooling => {
                let dim = embeddings[0].len();
                let mut result = vec![0.0f32; dim];

                for emb in embeddings {
                    for (i, v) in emb.iter().enumerate() {
                        if i < dim {
                            result[i] += v;
                        }
                    }
                }

                let n = embeddings.len() as f32;
                for v in result.iter_mut() {
                    *v /= n;
                }

                // 归一化（L2 norm）
                let norm: f32 = result.iter().map(|v| v * v).sum::<f32>().sqrt();
                if norm > 0.0 {
                    for v in result.iter_mut() {
                        *v /= norm;
                    }
                }

                result
            }

            ChunkAggregation::KeepAll => {
                // KeepAll 模式下，调用者应该自行处理多个向量
                // 这里返回第一个作为 fallback
                log::warn!(
                    "[EmbeddingChunker] aggregate_embeddings 不应在 KeepAll 模式下调用，返回第一个向量"
                );
                embeddings[0].clone()
            }
        }
    }
}

/// 分块结果
#[derive(Debug, Clone)]
pub struct ChunkResult {
    /// 原始文本索引
    pub original_index: usize,
    /// 分块后的文本列表
    pub chunks: Vec<String>,
}

/// 批量分块文本
///
/// ## 参数
/// - `texts`: 原始文本列表
/// - `chunker`: 分块器
///
/// ## 返回
/// 分块结果列表，保留原始索引关系
pub fn batch_chunk_texts(texts: &[String], chunker: &EmbeddingChunker) -> Vec<ChunkResult> {
    texts
        .iter()
        .enumerate()
        .map(|(idx, text)| ChunkResult {
            original_index: idx,
            chunks: chunker.chunk_text(text),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_estimate_tokens_chinese() {
        let text = "这是一段中文测试文本";
        let tokens = EmbeddingChunker::estimate_tokens(text);
        // 10 个中文字符 * 0.7 ≈ 7 tokens
        assert!(tokens >= 5 && tokens <= 10);
    }

    #[test]
    fn test_estimate_tokens_english() {
        let text = "This is a test sentence.";
        let tokens = EmbeddingChunker::estimate_tokens(text);
        // 24 个字符 * 0.25 ≈ 6 tokens
        assert!(tokens >= 4 && tokens <= 10);
    }

    #[test]
    fn test_estimate_tokens_mixed() {
        let text = "Hello 世界 Test 测试";
        let tokens = EmbeddingChunker::estimate_tokens(text);
        assert!(tokens > 0);
    }

    #[test]
    fn test_chunk_short_text() {
        let chunker = EmbeddingChunker::new(100);
        let text = "短文本";
        let chunks = chunker.chunk_text(text);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], text);
    }

    #[test]
    fn test_chunk_long_text() {
        let chunker = EmbeddingChunker::new(10);
        let text = "这是第一段。\n\n这是第二段。\n\n这是第三段。";
        let chunks = chunker.chunk_text(text);
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn test_hard_chunk_utf8_safe() {
        let chunker = EmbeddingChunker::new(5);
        let text = "你好世界测试文本";
        let chunks = chunker.hard_chunk(text);

        // 确保每个块都是有效的 UTF-8
        for chunk in &chunks {
            assert!(chunk.is_ascii() || !chunk.is_empty());
            // 验证可以正常迭代字符
            let _ = chunk.chars().count();
        }
    }

    #[test]
    fn test_aggregate_mean_pooling() {
        let embeddings = vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0]];
        let result =
            EmbeddingChunker::aggregate_embeddings(&embeddings, ChunkAggregation::MeanPooling);

        // 平均后应该接近 [0.5, 0.5, 0.0]，归一化后接近 [0.707, 0.707, 0.0]
        assert!(result.len() == 3);
        assert!((result[0] - result[1]).abs() < 0.01);
    }

    #[test]
    fn test_token_limits() {
        let limits = EmbeddingTokenLimits::default();

        assert_eq!(
            limits.get_limit("BAAI/bge-large-zh-v1.5"),
            (512.0 * 0.9) as usize
        );
        assert_eq!(limits.get_limit("BAAI/bge-m3"), (8192.0 * 0.9) as usize);
        assert_eq!(
            limits.get_limit("Qwen/Qwen3-Embedding-8B"),
            (32768.0 * 0.9) as usize
        );
    }
}
