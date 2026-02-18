use futures::stream::{self, StreamExt};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info, warn};

use crate::llm_manager::LLMManager;
use crate::models::PdfOcrTextBlock;
use crate::vfs::database::VfsDatabase;
use crate::vfs::embedding_service::{
    EmbeddingProgressCallback, VfsEmbeddingPipeline, VfsEmbeddingService,
};
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::index_service::VfsIndexService;
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::ocr_utils::{join_ocr_pages_text, parse_ocr_pages_json};
use crate::vfs::pdf_processing_service::{OcrPageResult, OcrPagesJson};
use crate::vfs::repos::{
    embedding_dim_repo, index_segment_repo, index_unit_repo, VfsBlobRepo, VfsEmbedding,
    VfsIndexStateRepo, VfsIndexingConfigRepo, VfsNoteRepo, VfsResourceRepo, INDEX_STATE_DISABLED,
    INDEX_STATE_FAILED, INDEX_STATE_INDEXED, INDEX_STATE_INDEXING, INDEX_STATE_PENDING,
    MODALITY_MULTIMODAL, MODALITY_TEXT, VFS_EMB_TABLE_PREFIX,
};
use crate::vfs::types::{PdfPreviewJson, VfsResource, VfsResourceType};
use crate::vfs::unit_builder::UnitBuildInput;

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::Indexing] Row parse error (skipped): {}", e);
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkingConfig {
    pub strategy: String,
    pub chunk_size: usize,
    pub chunk_overlap: usize,
    pub min_chunk_size: usize,
}

impl Default for ChunkingConfig {
    fn default() -> Self {
        Self {
            strategy: "fixed_size".to_string(),
            chunk_size: 512,
            chunk_overlap: 50,
            min_chunk_size: 20,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexingConfig {
    pub enabled: bool,
    pub batch_size: u32,
    pub interval_secs: u32,
    pub max_concurrent: u32,
    pub retry_delay_secs: u32,
    pub max_retries: i32,
}

impl Default for IndexingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            batch_size: 10,
            interval_secs: 5,
            max_concurrent: 2,
            retry_delay_secs: 60,
            max_retries: 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfig {
    pub default_top_k: u32,
    pub enable_hybrid: bool,
    pub enable_reranking: bool,
    pub fts_weight: f64,
    pub vector_weight: f64,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            default_top_k: 10,
            enable_hybrid: true,
            enable_reranking: false,
            fts_weight: 0.3,
            vector_weight: 0.7,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TextChunk {
    pub index: i32,
    pub text: String,
    pub start_pos: i32,
    pub end_pos: i32,
    /// 页面索引（用于 PDF/教材定位，0-indexed）
    pub page_index: Option<i32>,
    /// 来源 ID（如 textbook_xxx, att_xxx）
    pub source_id: Option<String>,
}

/// 按页的文本内容
#[derive(Debug, Clone)]
pub struct PageText {
    pub page_index: i32,
    pub text: String,
    pub source_id: Option<String>,
}

pub struct VfsChunker;

impl VfsChunker {
    /// 检查文本质量是否可接受（过滤 PDF 乱码等不可读文本）
    ///
    /// 返回 false 表示文本质量过低，不应被索引。
    /// 主要检测 PDF 解析产生的乱码——自定义字体编码会将 glyph ID 映射到错误的
    /// Unicode 码位，产出 ∂、∀、ℤ、Ⅳ、₃、⁰ 等技术上合法但无意义的符号。
    /// 这些字符会通过 `is_alphanumeric()` 检查，因此需要更严格的"常用文本字符"定义。
    pub fn is_text_quality_acceptable(text: &str) -> bool {
        let chars: Vec<char> = text.chars().collect();
        let total = chars.len();
        if total == 0 {
            return false;
        }

        let mut common_count = 0usize;      // 常用文本字符（ASCII字母数字、CJK、常见标点）
        let mut replacement_count = 0usize;  // Unicode 替换字符 U+FFFD
        let mut control_count = 0usize;      // 控制字符（非空白）

        for &ch in &chars {
            if ch == '\u{FFFD}' {
                replacement_count += 1;
            } else if ch.is_control() && !ch.is_whitespace() {
                control_count += 1;
            } else if Self::is_common_text_char(ch) {
                common_count += 1;
            }
            // 其余字符（数学符号、罕见 Unicode 等）不计入 common
        }

        let common_ratio = common_count as f64 / total as f64;
        let replacement_ratio = replacement_count as f64 / total as f64;
        let control_ratio = control_count as f64 / total as f64;

        // 拒绝条件：
        // 1. 替换字符超过 5%
        // 2. 控制字符超过 10%
        // 3. 常用文本字符低于 40%（大量罕见 Unicode 符号 = PDF 字体乱码）
        if replacement_ratio > 0.05 {
            debug!(
                "[VfsChunker] Text quality rejected: replacement_ratio={:.2}% ({}/{})",
                replacement_ratio * 100.0, replacement_count, total
            );
            return false;
        }
        if control_ratio > 0.10 {
            debug!(
                "[VfsChunker] Text quality rejected: control_ratio={:.2}% ({}/{})",
                control_ratio * 100.0, control_count, total
            );
            return false;
        }
        if common_ratio < 0.40 {
            debug!(
                "[VfsChunker] Text quality rejected: common_ratio={:.2}% ({}/{})",
                common_ratio * 100.0, common_count, total
            );
            return false;
        }

        true
    }

    /// 判断字符是否为"常用文本字符"
    ///
    /// 仅包含正常文本中频繁出现的字符类别，排除 PDF 字体乱码常见的
    /// 数学符号(∂∀∃)、罗马数字(Ⅳ)、上下标(₃⁰)、letterlike 符号(ℤℓ℮)等。
    #[inline]
    fn is_common_text_char(ch: char) -> bool {
        // ASCII 字母、数字、标点
        ch.is_ascii_alphanumeric()
        || ch.is_ascii_punctuation()
        || ch.is_ascii_whitespace()
        // 非 ASCII 空白（如全角空格 U+3000）
        || ch.is_whitespace()
        // CJK 统一汉字（基本 + 扩展 A + 兼容）
        || ('\u{4E00}'..='\u{9FFF}').contains(&ch)
        || ('\u{3400}'..='\u{4DBF}').contains(&ch)
        || ('\u{F900}'..='\u{FAFF}').contains(&ch)
        // CJK 标点和符号
        || ('\u{3000}'..='\u{303F}').contains(&ch)
        // 全角 ASCII（常见于中日韩文本）
        || ('\u{FF01}'..='\u{FF5E}').contains(&ch)
        // 日文假名
        || ('\u{3040}'..='\u{309F}').contains(&ch)  // 平假名
        || ('\u{30A0}'..='\u{30FF}').contains(&ch)  // 片假名
        // 韩文音节
        || ('\u{AC00}'..='\u{D7AF}').contains(&ch)
        // 常用 CJK 标点（非 ASCII）
        || matches!(ch,
            '，' | '。' | '；' | '：' | '！' | '？'
            | '\u{201C}' | '\u{201D}' | '\u{2018}' | '\u{2019}' // ""''
            | '（' | '）' | '【' | '】' | '《' | '》' | '、'
            | '…' | '—' | '～' | '·' | '「' | '」' | '『' | '』' | '〈' | '〉'
        )
        // 拉丁扩展（含重音字母：àáâãéèêëíìîïóòôõúùûü 等）
        || ('\u{00C0}'..='\u{024F}').contains(&ch)
    }

    pub fn chunk_text(text: &str, config: &ChunkingConfig) -> Vec<TextChunk> {
        let chunks = match config.strategy.as_str() {
            "semantic" => Self::chunk_semantic(text, config),
            _ => Self::chunk_fixed_size(text, config),
        };

        // 过滤掉乱码/不可读的 chunk（PDF 解析失败时可能产生大量乱码文本）
        let before_count = chunks.len();
        let mut chunks: Vec<TextChunk> = chunks
            .into_iter()
            .filter(|c| Self::is_text_quality_acceptable(&c.text))
            .collect();
        let filtered = before_count - chunks.len();
        if filtered > 0 {
            warn!(
                "[VfsChunker] Filtered {} garbled chunks out of {} (text quality check)",
                filtered, before_count
            );
            // 重新编号 index，避免下游 index_segments 出现断裂
            for (i, chunk) in chunks.iter_mut().enumerate() {
                chunk.index = i as i32;
            }
        }
        chunks
    }

    /// 按页分块文本，保留页码信息
    ///
    /// 每页单独分块，每个 chunk 记录来自哪一页
    pub fn chunk_text_with_pages(pages: &[PageText], config: &ChunkingConfig) -> Vec<TextChunk> {
        let mut all_chunks = Vec::new();
        let mut global_index = 0;

        for page in pages {
            let page_chunks = Self::chunk_text(&page.text, config);

            for chunk in page_chunks {
                all_chunks.push(TextChunk {
                    index: global_index,
                    text: chunk.text,
                    start_pos: chunk.start_pos,
                    end_pos: chunk.end_pos,
                    page_index: Some(page.page_index),
                    source_id: page.source_id.clone(),
                });
                global_index += 1;
            }
        }

        all_chunks
    }

    fn chunk_fixed_size(text: &str, config: &ChunkingConfig) -> Vec<TextChunk> {
        let mut chunks = Vec::new();
        let chars: Vec<char> = text.chars().collect();
        let total_len = chars.len();

        if total_len == 0 {
            return chunks;
        }

        if total_len <= config.chunk_size {
            chunks.push(TextChunk {
                index: 0,
                text: text.to_string(),
                start_pos: 0,
                end_pos: total_len as i32,
                page_index: None,
                source_id: None,
            });
            return chunks;
        }

        let mut start = 0;
        let mut chunk_index = 0;

        while start < total_len {
            let end = (start + config.chunk_size).min(total_len);
            let chunk_text: String = chars[start..end].iter().collect();

            if chunk_text.len() >= config.min_chunk_size {
                chunks.push(TextChunk {
                    index: chunk_index,
                    text: chunk_text,
                    start_pos: start as i32,
                    end_pos: end as i32,
                    page_index: None,
                    source_id: None,
                });
                chunk_index += 1;
            }

            if end >= total_len {
                break;
            }

            start = end.saturating_sub(config.chunk_overlap);
            if start >= end {
                start = end;
            }
        }

        chunks
    }

    fn chunk_semantic(text: &str, config: &ChunkingConfig) -> Vec<TextChunk> {
        let mut chunks = Vec::new();
        let paragraphs: Vec<&str> = text.split("\n\n").collect();

        let mut current_chunk = String::new();
        let mut current_start = 0;
        let mut chunk_index = 0;
        let mut pos = 0;

        for para in paragraphs {
            let para_len = para.len();

            if current_chunk.len() + para_len + 2 > config.chunk_size && !current_chunk.is_empty() {
                if current_chunk.len() >= config.min_chunk_size {
                    chunks.push(TextChunk {
                        index: chunk_index,
                        text: current_chunk.trim().to_string(),
                        start_pos: current_start as i32,
                        end_pos: pos as i32,
                        page_index: None,
                        source_id: None,
                    });
                    chunk_index += 1;
                }
                current_chunk = String::new();
                current_start = pos;
            }

            if !current_chunk.is_empty() {
                current_chunk.push_str("\n\n");
            }
            current_chunk.push_str(para);
            pos += para_len + 2;
        }

        if current_chunk.len() >= config.min_chunk_size {
            chunks.push(TextChunk {
                index: chunk_index,
                text: current_chunk.trim().to_string(),
                start_pos: current_start as i32,
                end_pos: pos as i32,
                page_index: None,
                source_id: None,
            });
        }

        if chunks.is_empty() && !text.is_empty() {
            return Self::chunk_fixed_size(text, config);
        }

        chunks
    }
}

pub struct VfsContentExtractor;

impl VfsContentExtractor {
    pub fn extract_indexable_content(
        resource_type: &VfsResourceType,
        data: &str,
    ) -> Option<String> {
        match resource_type {
            VfsResourceType::Note => Some(Self::extract_markdown_text(data)),
            VfsResourceType::Translation => Self::extract_translation_text(data),
            VfsResourceType::Exam => Self::extract_exam_text(data),
            VfsResourceType::Textbook => Self::extract_textbook_text(data),
            VfsResourceType::Essay => Some(data.to_string()),
            VfsResourceType::File => Self::extract_file_text(data),
            VfsResourceType::MindMap => Self::extract_mindmap_text(data),
            // Image/Retrieval：Image 内容为二进制（走 OCR），Retrieval 为临时搜索结果（不索引）
            VfsResourceType::Image | VfsResourceType::Retrieval => None,
        }
    }

    /// 按页提取可索引内容（用于 PDF/教材等有页面结构的资源）
    ///
    /// 返回 (pages, source_id)，pages 为按页的文本内容
    pub fn extract_indexable_pages(
        resource_type: &VfsResourceType,
        resource_id: &str,
        data: &str,
    ) -> Option<Vec<PageText>> {
        match resource_type {
            VfsResourceType::Exam => Self::extract_exam_pages(resource_id, data),
            VfsResourceType::Textbook => Self::extract_textbook_pages(resource_id, data),
            _ => None,
        }
    }

    /// 从题目 JSON 按页提取文本
    fn extract_exam_pages(resource_id: &str, data: &str) -> Option<Vec<PageText>> {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            if let Some(pages) = json.get("pages").and_then(|v| v.as_array()) {
                let mut result = Vec::new();

                for (page_idx, page) in pages.iter().enumerate() {
                    let mut texts = Vec::new();

                    let cards = page
                        .get("cards")
                        .and_then(|v| v.as_array())
                        .or_else(|| page.get("questions").and_then(|v| v.as_array()));

                    if let Some(cards) = cards {
                        for card in cards {
                            if let Some(content) = card
                                .get("ocr_text")
                                .and_then(|v| v.as_str())
                                .or_else(|| card.get("text").and_then(|v| v.as_str()))
                            {
                                if !content.trim().is_empty() {
                                    texts.push(format!("题目: {}", content.trim()));
                                }
                            }
                            if let Some(answer) = card.get("answer").and_then(|v| v.as_str()) {
                                if !answer.trim().is_empty() {
                                    texts.push(format!("答案: {}", answer.trim()));
                                }
                            }
                            if let Some(explanation) =
                                card.get("explanation").and_then(|v| v.as_str())
                            {
                                if !explanation.trim().is_empty() {
                                    texts.push(format!("解析: {}", explanation.trim()));
                                }
                            }
                        }
                    }

                    if !texts.is_empty() {
                        result.push(PageText {
                            page_index: page_idx as i32,
                            text: texts.join("\n\n"),
                            source_id: Some(resource_id.to_string()),
                        });
                    }
                }

                if !result.is_empty() {
                    return Some(result);
                }
            }
        }
        None
    }

    /// 从教材 JSON 按页提取文本
    fn extract_textbook_pages(resource_id: &str, data: &str) -> Option<Vec<PageText>> {
        // 尝试解析为 JSON（新格式：按页存储）
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            // 格式 1: { "pages": [{ "page_index": 0, "text": "..." }, ...] }
            if let Some(pages) = json.get("pages").and_then(|v| v.as_array()) {
                let mut result = Vec::new();

                for (idx, page) in pages.iter().enumerate() {
                    let page_index = page
                        .get("page_index")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(idx as i64) as i32;

                    let text = page
                        .get("text")
                        .or_else(|| page.get("content"))
                        .or_else(|| page.get("extracted_text"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if !text.trim().is_empty() {
                        result.push(PageText {
                            page_index,
                            text: text.to_string(),
                            source_id: Some(resource_id.to_string()),
                        });
                    }
                }

                if !result.is_empty() {
                    return Some(result);
                }
            }
        }

        // 旧格式：纯文本，无法提取页面信息
        None
    }

    fn extract_markdown_text(content: &str) -> String {
        let mut text = content.to_string();

        let patterns = [
            (r"!\[.*?\]\(.*?\)", ""),
            (r"\[([^\]]+)\]\([^\)]+\)", "$1"),
            (r"```[\s\S]*?```", ""),
            (r"`[^`]+`", ""),
            (r"^#{1,6}\s+", ""),
            (r"\*\*([^*]+)\*\*", "$1"),
            (r"\*([^*]+)\*", "$1"),
            (r"__([^_]+)__", "$1"),
            (r"_([^_]+)_", "$1"),
            (r"~~([^~]+)~~", "$1"),
            (r"^>\s+", ""),
            (r"^[-*+]\s+", ""),
            (r"^\d+\.\s+", ""),
            (r"^---+$", ""),
            (r"^\|.*\|$", ""),
        ];

        for (pattern, replacement) in patterns {
            if let Ok(re) = regex::Regex::new(pattern) {
                text = re.replace_all(&text, replacement).to_string();
            }
        }

        text.lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn extract_translation_text(data: &str) -> Option<String> {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            let source = json.get("source").and_then(|v| v.as_str()).unwrap_or("");
            let translated = json
                .get("translated")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if !source.is_empty() || !translated.is_empty() {
                return Some(format!("{}\n\n{}", source, translated));
            }
        }
        None
    }

    /// P2-2: 增强的题目文本提取，支持智能题目集的完整字段
    fn extract_exam_text(data: &str) -> Option<String> {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            let mut texts = Vec::new();

            // 支持新的 preview_json 格式（智能题目集）
            if let Some(pages) = json.get("pages").and_then(|v| v.as_array()) {
                for page in pages {
                    // 支持 cards 字段（新格式）
                    let cards = page
                        .get("cards")
                        .and_then(|v| v.as_array())
                        .or_else(|| page.get("questions").and_then(|v| v.as_array()));

                    if let Some(cards) = cards {
                        for card in cards {
                            // 提取题目内容（优先 ocr_text，兼容 text）
                            if let Some(content) = card
                                .get("ocr_text")
                                .and_then(|v| v.as_str())
                                .or_else(|| card.get("text").and_then(|v| v.as_str()))
                            {
                                if !content.trim().is_empty() {
                                    texts.push(format!("题目: {}", content.trim()));
                                }
                            }

                            // 提取标签（用于语义搜索）
                            if let Some(tags) = card.get("tags").and_then(|v| v.as_array()) {
                                let tag_strs: Vec<&str> =
                                    tags.iter().filter_map(|t| t.as_str()).collect();
                                if !tag_strs.is_empty() {
                                    texts.push(format!("标签: {}", tag_strs.join(", ")));
                                }
                            }

                            // 提取答案
                            if let Some(answer) = card.get("answer").and_then(|v| v.as_str()) {
                                if !answer.trim().is_empty() {
                                    texts.push(format!("答案: {}", answer.trim()));
                                }
                            }

                            // 提取解析（重要：帮助语义搜索理解题目知识点）
                            if let Some(explanation) =
                                card.get("explanation").and_then(|v| v.as_str())
                            {
                                if !explanation.trim().is_empty() {
                                    texts.push(format!("解析: {}", explanation.trim()));
                                }
                            }

                            // 提取用户笔记
                            if let Some(note) = card.get("user_note").and_then(|v| v.as_str()) {
                                if !note.trim().is_empty() {
                                    texts.push(format!("笔记: {}", note.trim()));
                                }
                            }
                        }
                    }
                }
            }

            if !texts.is_empty() {
                return Some(texts.join("\n\n"));
            }
        }
        None
    }

    fn extract_textbook_text(data: &str) -> Option<String> {
        // 教材的 data 字段直接存储的是提取的文本（纯文本格式）
        // 参见 textbook_repo.rs:99 - extracted_text.unwrap_or("")
        if !data.trim().is_empty() {
            return Some(data.to_string());
        }
        // 兼容 JSON 格式（旧数据可能是 JSON）
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            if let Some(text) = json.get("extracted_text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
        None
    }

    fn extract_file_text(data: &str) -> Option<String> {
        if data.starts_with('{') {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(text) = json.get("extracted_text").and_then(|v| v.as_str()) {
                    return Some(text.to_string());
                }
            }
        }
        None
    }

    /// ★ 2026-01 优化：提取知识导图文本内容（增强层级上下文）
    ///
    /// MindMapDocument JSON 格式：
    /// ```json
    /// {
    ///   "version": "1.0",
    ///   "root": {
    ///     "id": "root",
    ///     "text": "根节点",
    ///     "children": [
    ///       { "id": "n1", "text": "子节点1", "children": [...] }
    ///     ]
    ///   }
    /// }
    /// ```
    ///
    /// 优化：保留层级路径上下文，提高语义搜索精度
    pub fn extract_mindmap_text(data: &str) -> Option<String> {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            let mut texts = Vec::new();

            // ★ 2026-01 优化：递归提取节点文本，保留层级路径
            fn extract_node_texts_with_path(
                node: &serde_json::Value,
                texts: &mut Vec<String>,
                path: &[String],
                depth: usize,
            ) {
                // 提取当前节点文本
                let current_text = node
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());

                if let Some(text) = &current_text {
                    // 构建带层级上下文的文本
                    // 格式：根节点 > 子节点 > 当前节点
                    if path.is_empty() {
                        texts.push(format!("【{}】", text));
                    } else {
                        let path_str = path.join(" > ");
                        texts.push(format!("【{}】 > {}", path_str, text));
                    }

                    // 提取备注（与当前节点关联）
                    if let Some(note) = node.get("note").and_then(|v| v.as_str()) {
                        if !note.trim().is_empty() {
                            texts.push(format!("  备注: {}", note.trim()));
                        }
                    }
                }

                // 递归处理子节点（限制深度避免栈溢出）
                if depth < 50 {
                    if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
                        // 构建新的路径
                        let mut new_path = path.to_vec();
                        if let Some(text) = &current_text {
                            new_path.push(text.clone());
                        }

                        for child in children {
                            extract_node_texts_with_path(child, texts, &new_path, depth + 1);
                        }
                    }
                }
            }

            // 从根节点开始提取
            if let Some(root) = json.get("root") {
                extract_node_texts_with_path(root, &mut texts, &[], 0);
            }

            if !texts.is_empty() {
                return Some(texts.join("\n"));
            }
        }
        None
    }
}

/// ★ 核心修复：从正确的关联表获取各资源类型的可索引内容
///
/// 资源内容存储位置：
/// - Note/Translation/Essay/MindMap: resources.data
/// - Textbook: textbooks.ocr_pages_json / textbooks.extracted_text / resources.ocr_text
/// - Exam: exam_sheets.preview_json
/// - File/Image: attachments.extracted_text / resources.ocr_text
fn resolve_indexable_content(
    conn: &rusqlite::Connection,
    resource: &VfsResource,
) -> Option<String> {
    log::debug!(
        "[resolve_indexable_content] resource_id={}, type={:?}, data_len={}, storage_mode={:?}",
        resource.id,
        resource.resource_type,
        resource.data.as_ref().map(|d| d.len()).unwrap_or(0),
        resource.storage_mode
    );

    // 1. 优先检查 resources.ocr_text（通用 OCR 缓存）
    let ocr_text: Option<String> = conn
        .query_row(
            "SELECT ocr_text FROM resources WHERE id = ?",
            [resource.id.as_str()],
            |row| row.get(0),
        )
        .ok()
        .flatten()
        .filter(|t: &String| !t.trim().is_empty());

    if ocr_text.is_some() {
        log::debug!(
            "[resolve_indexable_content] Found ocr_text for {}",
            resource.id
        );
        return ocr_text;
    }

    // 2. 优先尝试 resource.data（inline 存储模式）
    // ★ 核心修复：Note/Translation/Essay/MindMap 的内容都在 resources.data
    if let Some(data) = resource.data.as_deref() {
        if !data.trim().is_empty() {
            log::debug!(
                "[resolve_indexable_content] Trying resource.data for {} (len={})",
                resource.id,
                data.len()
            );
            let content =
                VfsContentExtractor::extract_indexable_content(&resource.resource_type, data);
            if content.as_ref().map(|c| !c.is_empty()).unwrap_or(false) {
                log::debug!(
                    "[resolve_indexable_content] Extracted content from resource.data for {}",
                    resource.id
                );
                return content;
            }
        }
    } else {
        log::debug!(
            "[resolve_indexable_content] resource.data is None for {}",
            resource.id
        );
    }

    // 3. 对于特定资源类型，从关联表获取额外内容
    match resource.resource_type {
        VfsResourceType::Textbook => {
            // 教材：优先 ocr_pages_json，其次 extracted_text
            // ★ 2026-01 修复：同时支持 resource_id 和 source_id 查询
            // - resource_id: 资源 ID (res_xxx)
            // - source_id: 可能是 textbook_id (tb_xxx / file_xxx)
            let textbook_id = resource
                .source_id
                .as_deref()
                .filter(|s| s.starts_with("tb_") || s.starts_with("file_"))
                .unwrap_or(&resource.id);

            log::debug!(
                "[resolve_indexable_content] Textbook query: resource_id={}, source_id={:?}, using={}",
                resource.id, resource.source_id, textbook_id
            );

            // 先尝试通过 resource_id 查询
            let result: Option<(Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT ocr_pages_json, extracted_text FROM files WHERE resource_id = ?1",
                    rusqlite::params![resource.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();

            // 如果 resource_id 查询失败，尝试通过 textbook_id 查询
            let result = result.or_else(|| {
                if textbook_id != resource.id {
                    conn.query_row(
                        "SELECT ocr_pages_json, extracted_text FROM files WHERE id = ?1",
                        rusqlite::params![textbook_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .ok()
                } else {
                    None
                }
            });

            // ★ 2026-01 修复：OCR 失败标记，过滤掉永久失败的页面
            const OCR_FAILED_MARKER: &str = "__OCR_FAILED__";

            if let Some((ocr_pages_json, extracted_text)) = result {
                // 优先使用 ocr_pages_json
                if let Some(json_str) = ocr_pages_json {
                    log::debug!(
                        "[resolve_indexable_content] Found ocr_pages_json for textbook, len={}",
                        json_str.len()
                    );

                    // 尝试解析为 Vec<Option<String>>（旧格式）
                    if let Ok(pages) = serde_json::from_str::<Vec<Option<String>>>(&json_str) {
                        // ★ 过滤掉失败标记
                        let valid_pages: Vec<_> = pages
                            .iter()
                            .enumerate()
                            .filter_map(|(i, t)| t.as_ref().map(|s| (i, s)))
                            .filter(|(_, s)| !s.trim().is_empty() && *s != OCR_FAILED_MARKER)
                            .collect();

                        let total_pages = pages.len();
                        let valid_count = valid_pages.len();
                        let failed_count = pages
                            .iter()
                            .filter(|t| t.as_ref().map(|s| s == OCR_FAILED_MARKER).unwrap_or(false))
                            .count();

                        if failed_count > 0 {
                            log::warn!(
                                "[resolve_indexable_content] Textbook has {} failed OCR pages out of {} total",
                                failed_count, total_pages
                            );
                        }

                        let text = valid_pages
                            .into_iter()
                            .map(|(_, s)| s.clone())
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        if !text.is_empty() {
                            log::debug!(
                                "[resolve_indexable_content] Extracted {} chars from ocr_pages_json ({}/{} pages valid)",
                                text.len(), valid_count, total_pages
                            );
                            return Some(text);
                        }
                    } else {
                        // ★ P0 修复：尝试解析为新格式 OcrPagesJson（PDF 预处理流水线使用的格式）
                        #[derive(Debug, Deserialize)]
                        #[serde(rename_all = "camelCase")]
                        struct OcrPagesJsonCompat {
                            #[allow(dead_code)]
                            total_pages: usize,
                            pages: Vec<OcrPageResultCompat>,
                            #[allow(dead_code)]
                            completed_at: Option<String>,
                        }
                        #[derive(Debug, Deserialize)]
                        #[serde(rename_all = "camelCase")]
                        struct OcrPageResultCompat {
                            #[allow(dead_code)]
                            page_index: usize,
                            blocks: Vec<OcrTextBlockCompat>,
                        }
                        #[derive(Debug, Deserialize)]
                        struct OcrTextBlockCompat {
                            text: String,
                        }

                        if let Ok(ocr_json) = serde_json::from_str::<OcrPagesJsonCompat>(&json_str)
                        {
                            log::debug!(
                                "[resolve_indexable_content] Parsed as OcrPagesJson: {} pages",
                                ocr_json.pages.len()
                            );

                            // 合并所有页面的文本
                            let text = ocr_json
                                .pages
                                .iter()
                                .map(|page| {
                                    page.blocks
                                        .iter()
                                        .map(|b| b.text.as_str())
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                                .filter(|t| !t.trim().is_empty())
                                .collect::<Vec<_>>()
                                .join("\n\n");

                            if !text.is_empty() {
                                log::debug!(
                                    "[resolve_indexable_content] Extracted {} chars from OcrPagesJson format",
                                    text.len()
                                );
                                return Some(text);
                            }
                        }
                    }
                }
                // 回退到 extracted_text
                if let Some(text) = extracted_text {
                    if !text.trim().is_empty() {
                        log::debug!(
                            "[resolve_indexable_content] Using extracted_text for textbook, len={}",
                            text.len()
                        );
                        return Some(text);
                    }
                }
            } else {
                log::debug!("[resolve_indexable_content] No textbook record found for resource_id={} or id={}", resource.id, textbook_id);
            }
        }

        VfsResourceType::Exam => {
            // 题目集：从 exam_sheets.preview_json 获取
            let preview_json: Option<String> = conn
                .query_row(
                    "SELECT preview_json FROM exam_sheets WHERE resource_id = ?1",
                    rusqlite::params![resource.id],
                    |row| row.get(0),
                )
                .ok()
                .flatten();

            if let Some(json_str) = preview_json {
                if let Some(text) = VfsContentExtractor::extract_exam_text(&json_str) {
                    return Some(text);
                }
            }
        }

        VfsResourceType::File | VfsResourceType::Image => {
            // ★ 2026-01 策略：选择 extracted_text 和 ocr_text 中内容更多的
            // 文件/图片：从 files.extracted_text 和 resources.ocr_text 获取，选择更长的

            // 1. 获取 extracted_text（从 files 表）
            let extracted_text: Option<String> =
                if let Some(source_id) = resource.source_id.as_deref() {
                    if source_id.starts_with("att_") || source_id.starts_with("file_") {
                        conn.query_row(
                            "SELECT extracted_text FROM files WHERE id = ?1",
                            rusqlite::params![source_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten()
                    } else {
                        None
                    }
                } else {
                    None
                }
                .or_else(|| {
                    conn.query_row(
                        "SELECT extracted_text FROM files WHERE resource_id = ?1",
                        rusqlite::params![resource.id],
                        |row| row.get(0),
                    )
                    .ok()
                    .flatten()
                })
                .filter(|t: &String| !t.trim().is_empty());

            // 2. 获取 ocr_text（从 resources 表，已在函数开头查询过，这里重新获取以确保最新）
            let ocr_text_from_db: Option<String> = conn
                .query_row(
                    "SELECT ocr_text FROM resources WHERE id = ?1",
                    rusqlite::params![resource.id],
                    |row| row.get(0),
                )
                .ok()
                .flatten()
                .filter(|t: &String| !t.trim().is_empty());

            // 3. 选择内容更多的
            let extracted_len = extracted_text.as_ref().map(|t| t.len()).unwrap_or(0);
            let ocr_len = ocr_text_from_db.as_ref().map(|t| t.len()).unwrap_or(0);

            log::debug!(
                "[resolve_indexable_content] File/Image {}: extracted_text={} chars, ocr_text={} chars",
                resource.id, extracted_len, ocr_len
            );

            if extracted_len > 0 || ocr_len > 0 {
                if ocr_len > extracted_len {
                    log::debug!("[resolve_indexable_content] Using ocr_text (longer)");
                    return ocr_text_from_db;
                } else {
                    log::debug!(
                        "[resolve_indexable_content] Using extracted_text (longer or equal)"
                    );
                    // 缓存 extracted_text 到 resources.ocr_text（如果 ocr_text 为空）
                    if ocr_len == 0 {
                        if let Some(ref text) = extracted_text {
                            let _ = conn.execute(
                                "UPDATE resources SET ocr_text = ?1 WHERE id = ?2 AND (ocr_text IS NULL OR ocr_text = '')",
                                rusqlite::params![text, resource.id],
                            );
                        }
                    }
                    return extracted_text;
                }
            }

            // 4. 兜底：从 ocr_pages_json 合并文本（兼容 OcrPagesJson 格式）
            let ocr_pages_json: Option<String> =
                if let Some(source_id) = resource.source_id.as_deref() {
                    if source_id.starts_with("att_") || source_id.starts_with("file_") {
                        conn.query_row(
                            "SELECT ocr_pages_json FROM files WHERE id = ?1",
                            rusqlite::params![source_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten()
                    } else {
                        None
                    }
                } else {
                    None
                }
                .or_else(|| {
                    conn.query_row(
                        "SELECT ocr_pages_json FROM files WHERE resource_id = ?1",
                        rusqlite::params![resource.id],
                        |row| row.get(0),
                    )
                    .ok()
                    .flatten()
                });

            if let Some(json_str) = ocr_pages_json {
                let pages = parse_ocr_pages_json(&json_str);
                if let Some(joined) = join_ocr_pages_text(&pages, "第", "页") {
                    log::debug!(
                        "[resolve_indexable_content] Using joined ocr_pages_json for {} ({} pages)",
                        resource.id,
                        pages.len()
                    );
                    return Some(joined);
                }
            }
        }

        // Note/Translation/Essay/MindMap/Retrieval：内容已在步骤 2 从 resources.data 提取
        VfsResourceType::Note
        | VfsResourceType::Translation
        | VfsResourceType::Essay
        | VfsResourceType::MindMap
        | VfsResourceType::Retrieval => {}
    }

    None
}

/// ★ 2026-01 新增：从数据库获取按页的文本信息
///
/// 用于支持 page_index 字段，让搜索结果能够定位到具体页面
fn resolve_indexable_pages(
    conn: &rusqlite::Connection,
    resource: &VfsResource,
) -> Option<Vec<PageText>> {
    match resource.resource_type {
        VfsResourceType::Textbook => {
            // 从 textbooks.ocr_pages_json 获取按页 OCR 文本
            let textbook_id = resource
                .source_id
                .as_deref()
                .filter(|s| s.starts_with("tb_") || s.starts_with("file_"))
                .unwrap_or(&resource.id);

            log::info!(
                "[resolve_indexable_pages] Textbook {} (source_id={:?}, textbook_id={})",
                resource.id,
                resource.source_id,
                textbook_id
            );

            // 查询 ocr_pages_json, extracted_text, page_count
            let result: Option<(Option<String>, Option<String>, Option<i32>)> = conn
                .query_row(
                    "SELECT ocr_pages_json, extracted_text, page_count FROM files WHERE resource_id = ?1",
                    rusqlite::params![resource.id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok();

            log::info!(
                "[resolve_indexable_pages] Query by resource_id result: {:?}",
                result.as_ref().map(|(ocr, ext, pc)| (
                    ocr.as_ref().map(|s| s.len()),
                    ext.as_ref().map(|s| s.len()),
                    pc
                ))
            );

            // 回退到 textbook_id
            let result = result.or_else(|| {
                if textbook_id != resource.id {
                    let r: Option<(Option<String>, Option<String>, Option<i32>)> = conn.query_row(
                        "SELECT ocr_pages_json, extracted_text, page_count FROM files WHERE id = ?1",
                        rusqlite::params![textbook_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .ok();
                    log::info!(
                        "[resolve_indexable_pages] Query by textbook_id result: {:?}",
                        r.as_ref().map(|(ocr, ext, pc)| (ocr.as_ref().map(|s| s.len()), ext.as_ref().map(|s| s.len()), pc))
                    );
                    r
                } else {
                    None
                }
            });

            // ★ 2026-01 修复：OCR 失败标记，过滤掉永久失败的页面
            const OCR_FAILED_MARKER: &str = "__OCR_FAILED__";

            if let Some((ocr_pages_json, extracted_text, page_count)) = result {
                // 优先使用 ocr_pages_json（按页存储的 OCR 文本）
                if let Some(ref json_str) = ocr_pages_json {
                    log::info!(
                        "[resolve_indexable_pages] Attempting to parse ocr_pages_json for {}, len={}",
                        resource.id, json_str.len()
                    );

                    // 尝试解析为 Vec<Option<String>>
                    match serde_json::from_str::<Vec<Option<String>>>(json_str) {
                        Ok(pages) => {
                            log::info!(
                                "[resolve_indexable_pages] Parsed as Vec<Option<String>>: {} items",
                                pages.len()
                            );

                            // ★ 统计失败页面
                            let failed_count = pages
                                .iter()
                                .filter(|t| {
                                    t.as_ref().map(|s| s == OCR_FAILED_MARKER).unwrap_or(false)
                                })
                                .count();
                            if failed_count > 0 {
                                log::warn!(
                                    "[resolve_indexable_pages] Textbook {} has {} failed OCR pages out of {} total",
                                    resource.id, failed_count, pages.len()
                                );
                            }

                            let result: Vec<PageText> = pages
                                .into_iter()
                                .enumerate()
                                .filter_map(|(idx, text_opt)| {
                                    // ★ 过滤掉失败标记
                                    text_opt
                                        .filter(|t| !t.trim().is_empty() && t != OCR_FAILED_MARKER)
                                        .map(|text| PageText {
                                            page_index: idx as i32,
                                            text,
                                            // ★ 2026-01-22: 使用 source_id (tb_xxx) 而不是 resource.id (res_xxx)
                                            source_id: resource
                                                .source_id
                                                .clone()
                                                .or_else(|| Some(resource.id.clone())),
                                        })
                                })
                                .collect();

                            if !result.is_empty() {
                                log::info!(
                                    "[resolve_indexable_pages] Extracted {} pages from textbook {} (ocr_pages_json as Vec<Option<String>>)",
                                    result.len(), resource.id
                                );
                                return Some(result);
                            }
                        }
                        Err(e1) => {
                            log::warn!(
                                "[resolve_indexable_pages] Failed to parse as Vec<Option<String>>: {}, trying Vec<String>",
                                e1
                            );
                            // 回退：尝试解析为 Vec<String>
                            match serde_json::from_str::<Vec<String>>(json_str) {
                                Ok(pages) => {
                                    log::info!(
                                        "[resolve_indexable_pages] Parsed as Vec<String>: {} items",
                                        pages.len()
                                    );

                                    // ★ 统计失败页面
                                    let failed_count =
                                        pages.iter().filter(|t| *t == OCR_FAILED_MARKER).count();
                                    if failed_count > 0 {
                                        log::warn!(
                                            "[resolve_indexable_pages] Textbook {} has {} failed OCR pages out of {} total",
                                            resource.id, failed_count, pages.len()
                                        );
                                    }

                                    let result: Vec<PageText> = pages
                                        .into_iter()
                                        .enumerate()
                                        .filter_map(|(idx, text)| {
                                            // ★ 过滤掉失败标记
                                            if !text.trim().is_empty() && text != OCR_FAILED_MARKER
                                            {
                                                Some(PageText {
                                                    page_index: idx as i32,
                                                    text,
                                                    // ★ 2026-01-22: 使用 source_id (tb_xxx) 而不是 resource.id (res_xxx)
                                                    source_id: resource
                                                        .source_id
                                                        .clone()
                                                        .or_else(|| Some(resource.id.clone())),
                                                })
                                            } else {
                                                None
                                            }
                                        })
                                        .collect();

                                    if !result.is_empty() {
                                        log::info!(
                                            "[resolve_indexable_pages] Extracted {} pages from textbook {} (ocr_pages_json as Vec<String>)",
                                            result.len(), resource.id
                                        );
                                        return Some(result);
                                    }
                                }
                                Err(e2) => {
                                    // ★ P0 修复：尝试解析为新格式 OcrPagesJson（PDF 预处理流水线使用的格式）
                                    // 格式: {"totalPages": n, "pages": [{"pageIndex": i, "blocks": [...]}], "completedAt": "..."}
                                    #[derive(Debug, Deserialize)]
                                    #[serde(rename_all = "camelCase")]
                                    struct OcrPagesJsonCompat {
                                        #[allow(dead_code)]
                                        total_pages: usize,
                                        pages: Vec<OcrPageResultCompat>,
                                        #[allow(dead_code)]
                                        completed_at: Option<String>,
                                    }
                                    #[derive(Debug, Deserialize)]
                                    #[serde(rename_all = "camelCase")]
                                    struct OcrPageResultCompat {
                                        page_index: usize,
                                        blocks: Vec<OcrTextBlockCompat>,
                                    }
                                    #[derive(Debug, Deserialize)]
                                    struct OcrTextBlockCompat {
                                        text: String,
                                    }

                                    match serde_json::from_str::<OcrPagesJsonCompat>(json_str) {
                                        Ok(ocr_json) => {
                                            log::info!(
                                                "[resolve_indexable_pages] Parsed as OcrPagesJson: {} pages",
                                                ocr_json.pages.len()
                                            );

                                            let result: Vec<PageText> = ocr_json
                                                .pages
                                                .into_iter()
                                                .filter_map(|page| {
                                                    // 合并所有 blocks 的文本
                                                    let text = page
                                                        .blocks
                                                        .iter()
                                                        .map(|b| b.text.as_str())
                                                        .collect::<Vec<_>>()
                                                        .join("\n");

                                                    if !text.trim().is_empty() {
                                                        Some(PageText {
                                                            page_index: page.page_index as i32,
                                                            text,
                                                            source_id: resource
                                                                .source_id
                                                                .clone()
                                                                .or_else(|| {
                                                                    Some(resource.id.clone())
                                                                }),
                                                        })
                                                    } else {
                                                        None
                                                    }
                                                })
                                                .collect();

                                            if !result.is_empty() {
                                                log::info!(
                                                    "[resolve_indexable_pages] Extracted {} pages from {} (OcrPagesJson format)",
                                                    result.len(), resource.id
                                                );
                                                return Some(result);
                                            }
                                        }
                                        Err(e3) => {
                                            log::error!(
                                                "[resolve_indexable_pages] Failed to parse ocr_pages_json for {}: Vec<Option<String>> error: {}, Vec<String> error: {}, OcrPagesJson error: {}",
                                                resource.id, e1, e2, e3
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // ★ 2026-01 回退：如果没有 ocr_pages_json，但有 extracted_text 和 page_count
                // 将文本按段落均匀分配到各页（近似方案）
                if let (Some(text), Some(pc)) = (extracted_text, page_count) {
                    if pc > 0 && !text.trim().is_empty() {
                        let page_count = pc as usize;
                        // 按双换行分割段落
                        let paragraphs: Vec<&str> = text
                            .split("\n\n")
                            .filter(|p| !p.trim().is_empty())
                            .collect();

                        if !paragraphs.is_empty() {
                            // 将段落均匀分配到各页
                            let paragraphs_per_page =
                                (paragraphs.len() + page_count - 1) / page_count;
                            let result: Vec<PageText> = (0..page_count)
                                .filter_map(|page_idx| {
                                    let start = page_idx * paragraphs_per_page;
                                    let end = ((page_idx + 1) * paragraphs_per_page)
                                        .min(paragraphs.len());
                                    if start < paragraphs.len() {
                                        let page_text = paragraphs[start..end].join("\n\n");
                                        if !page_text.trim().is_empty() {
                                            Some(PageText {
                                                page_index: page_idx as i32,
                                                text: page_text,
                                                // ★ 2026-01-22: 使用 source_id (tb_xxx)
                                                source_id: resource
                                                    .source_id
                                                    .clone()
                                                    .or_else(|| Some(resource.id.clone())),
                                            })
                                        } else {
                                            None
                                        }
                                    } else {
                                        None
                                    }
                                })
                                .collect();

                            if !result.is_empty() {
                                log::info!(
                                    "[resolve_indexable_pages] Inferred {} pages from textbook {} (extracted_text + page_count={})",
                                    result.len(), resource.id, page_count
                                );
                                return Some(result);
                            }
                        }
                    }
                }
            }
        }

        VfsResourceType::Exam => {
            // 从 exam_sheets.preview_json 获取按页内容
            let preview_json: Option<String> = conn
                .query_row(
                    "SELECT preview_json FROM exam_sheets WHERE resource_id = ?1",
                    rusqlite::params![resource.id],
                    |row| row.get(0),
                )
                .ok()
                .flatten();

            if let Some(json_str) = preview_json {
                if let Some(pages) = VfsContentExtractor::extract_indexable_pages(
                    &resource.resource_type,
                    &resource.id,
                    &json_str,
                ) {
                    if !pages.is_empty() {
                        log::info!(
                            "[resolve_indexable_pages] Extracted {} pages from exam {}",
                            pages.len(),
                            resource.id
                        );
                        return Some(pages);
                    }
                }
            }
        }

        VfsResourceType::File | VfsResourceType::Image => {
            // 从 files.ocr_pages_json 获取按页 OCR 文本
            // 优先通过 source_id 查找
            let attachment_id = resource
                .source_id
                .as_deref()
                .filter(|s| s.starts_with("att_"));

            let ocr_pages_json: Option<String> = if let Some(att_id) = attachment_id {
                conn.query_row(
                    "SELECT ocr_pages_json FROM files WHERE id = ?1",
                    rusqlite::params![att_id],
                    |row| row.get(0),
                )
                .ok()
                .flatten()
            } else {
                conn.query_row(
                    "SELECT ocr_pages_json FROM files WHERE resource_id = ?1",
                    rusqlite::params![resource.id],
                    |row| row.get(0),
                )
                .ok()
                .flatten()
            };

            if let Some(json_str) = ocr_pages_json {
                let pages = parse_ocr_pages_json(&json_str);
                let result: Vec<PageText> = pages
                    .into_iter()
                    .enumerate()
                    .filter_map(|(idx, text_opt)| {
                        text_opt
                            .filter(|t| !t.trim().is_empty())
                            .map(|text| PageText {
                                page_index: idx as i32,
                                text,
                                // ★ 2026-01-22: 使用 source_id (att_xxx)
                                source_id: resource
                                    .source_id
                                    .clone()
                                    .or_else(|| Some(resource.id.clone())),
                            })
                    })
                    .collect();

                if !result.is_empty() {
                    log::info!(
                        "[resolve_indexable_pages] Extracted {} pages from attachment {}",
                        result.len(),
                        resource.id
                    );
                    return Some(result);
                }
            }
        }

        // Note/Translation/Essay/MindMap/Retrieval：无按页结构，跳过
        VfsResourceType::Note
        | VfsResourceType::Translation
        | VfsResourceType::Essay
        | VfsResourceType::MindMap
        | VfsResourceType::Retrieval => {}
    }

    // 回退：尝试从 resource.data 提取
    if let Some(data) = resource.data.as_deref() {
        if let Some(pages) = VfsContentExtractor::extract_indexable_pages(
            &resource.resource_type,
            &resource.id,
            data,
        ) {
            if !pages.is_empty() {
                return Some(pages);
            }
        }
    }

    None
}

pub struct VfsIndexingService {
    db: Arc<VfsDatabase>,
}

impl VfsIndexingService {
    pub fn new(db: Arc<VfsDatabase>) -> Self {
        Self { db }
    }

    pub fn get_indexing_config(&self) -> VfsResult<IndexingConfig> {
        Ok(IndexingConfig {
            enabled: VfsIndexingConfigRepo::get_bool(&self.db, "indexing.enabled", true)?,
            batch_size: VfsIndexingConfigRepo::get_i32(&self.db, "indexing.batch_size", 10)? as u32,
            interval_secs: VfsIndexingConfigRepo::get_i32(&self.db, "indexing.interval_secs", 5)?
                as u32,
            max_concurrent: VfsIndexingConfigRepo::get_i32(&self.db, "indexing.max_concurrent", 2)?
                as u32,
            retry_delay_secs: VfsIndexingConfigRepo::get_i32(
                &self.db,
                "indexing.retry_delay_secs",
                60,
            )? as u32,
            max_retries: VfsIndexingConfigRepo::get_i32(&self.db, "indexing.max_retries", 3)?,
        })
    }

    pub fn get_chunking_config(&self) -> VfsResult<ChunkingConfig> {
        let strategy = VfsIndexingConfigRepo::get_config(&self.db, "chunking.strategy")?
            .unwrap_or_else(|| "fixed_size".to_string());

        Ok(ChunkingConfig {
            strategy,
            chunk_size: VfsIndexingConfigRepo::get_i32(&self.db, "chunking.chunk_size", 512)?
                as usize,
            chunk_overlap: VfsIndexingConfigRepo::get_i32(&self.db, "chunking.chunk_overlap", 50)?
                as usize,
            min_chunk_size: VfsIndexingConfigRepo::get_i32(&self.db, "chunking.min_chunk_size", 20)?
                as usize,
        })
    }

    pub fn get_search_config(&self) -> VfsResult<SearchConfig> {
        Ok(SearchConfig {
            default_top_k: VfsIndexingConfigRepo::get_i32(&self.db, "search.default_top_k", 10)?
                as u32,
            enable_hybrid: VfsIndexingConfigRepo::get_bool(&self.db, "search.enable_hybrid", true)?,
            enable_reranking: VfsIndexingConfigRepo::get_bool(
                &self.db,
                "search.enable_reranking",
                false,
            )?,
            fts_weight: VfsIndexingConfigRepo::get_f64(&self.db, "search.fts_weight", 0.3)?,
            vector_weight: VfsIndexingConfigRepo::get_f64(&self.db, "search.vector_weight", 0.7)?,
        })
    }

    /// ⚠️ **已废弃** - 请使用 `VfsFullIndexingService::index_resource` 代替
    ///
    /// 此方法仅创建 SQLite 元数据，**不写入 LanceDB 向量数据**。
    /// 生产环境应使用 `VfsFullIndexingService::index_resource`，它会：
    /// 1. 生成嵌入向量
    /// 2. 写入 LanceDB
    /// 3. 使用正确的 `lance_row_id`（`emb_xxxxxxxxxx` 格式）
    ///
    /// ## lance_row_id 说明
    /// - 正确格式：`emb_xxxxxxxxxx`（由 `VfsEmbedding::generate_id()` 生成）
    /// - 此废弃方法使用 `placeholder_no_lance_xxxxxxxxxx` 表示未写入 Lance
    #[deprecated(
        since = "2026-02",
        note = "Use VfsFullIndexingService::index_resource instead. This method does not write to LanceDB."
    )]
    pub fn index_resource(&self, resource_id: &str, embedding_dim: i32) -> VfsResult<usize> {
        let conn = self.db.get_conn_safe()?;

        let resource =
            VfsResourceRepo::get_resource_with_conn(&conn, resource_id)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "Resource".to_string(),
                    id: resource_id.to_string(),
                }
            })?;

        let content = resolve_indexable_content(&conn, &resource);
        if content.is_none() {
            // 既没有可索引内容也没有 OCR 文本，标记为 indexed（无需向量）
            log::info!("[VfsIndexingService] Resource {} ({:?}) has no indexable content, marking as indexed", resource_id, resource.resource_type);
            VfsIndexStateRepo::set_index_state_with_conn(
                &conn,
                resource_id,
                INDEX_STATE_INDEXED,
                Some(&resource.hash),
                None,
            )?;
            return Ok(0);
        }
        if content.as_ref().map(|c| c.is_empty()).unwrap_or(true) {
            // 内容为空，标记为 indexed（已处理，无需向量）
            log::info!(
                "[VfsIndexingService] Resource {} ({:?}) has empty content, marking as indexed",
                resource_id,
                resource.resource_type
            );
            VfsIndexStateRepo::set_index_state_with_conn(
                &conn,
                resource_id,
                INDEX_STATE_INDEXED,
                Some(&resource.hash),
                None,
            )?;
            return Ok(0);
        }

        let content = content.unwrap();
        let chunking_config = self.get_chunking_config()?;
        let chunks = VfsChunker::chunk_text(&content, &chunking_config);

        if chunks.is_empty() {
            VfsIndexStateRepo::set_index_state_with_conn(
                &conn,
                resource_id,
                INDEX_STATE_INDEXED,
                Some(&resource.hash),
                None,
            )?;
            return Ok(0);
        }

        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<usize> {
            VfsIndexStateRepo::set_index_state_with_conn(
                &conn,
                resource_id,
                INDEX_STATE_INDEXING,
                None,
                None,
            )?;
            // 使用新架构：删除旧 units（segments 级联删除）
            index_unit_repo::delete_by_resource(&conn, resource_id)?;
            embedding_dim_repo::register(&conn, embedding_dim, MODALITY_TEXT)?;

            let now = chrono::Utc::now().timestamp_millis();
            let mut count = 0usize;

            // 查找或创建 unit
            let unit_id: String = conn.query_row(
                "SELECT id FROM vfs_index_units WHERE resource_id = ?1 AND unit_index = 0",
                rusqlite::params![resource_id],
                |row| row.get(0),
            ).unwrap_or_else(|_| {
                let new_unit_id = format!("unit_{}", nanoid::nanoid!(10));
                let _ = conn.execute(
                    r#"INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, text_required, text_state, mm_required, mm_state, created_at, updated_at)
                    VALUES (?1, ?2, 0, '', 1, 'indexing', 0, 'disabled', ?3, ?3)"#,
                    rusqlite::params![new_unit_id, resource_id, now],
                );
                new_unit_id
            });

            for chunk in &chunks {
                let id = format!("seg_{}", nanoid::nanoid!(10));
                // ★ 2026-02 修复：使用明确的占位符表示此记录未写入 LanceDB
                // 正确的 lance_row_id 应为 emb_xxxxxxxxxx 格式（由 VfsEmbedding::generate_id() 生成）
                // 此废弃方法不写入 Lance，故使用占位符避免误导
                let placeholder_lance_row_id =
                    format!("placeholder_no_lance_{}", nanoid::nanoid!(10));
                conn.execute(
                    r#"INSERT INTO vfs_index_segments (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text, start_pos, end_pos, metadata_json, created_at, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"#,
                    rusqlite::params![id, unit_id, chunk.index, MODALITY_TEXT, embedding_dim, placeholder_lance_row_id, chunk.text, chunk.start_pos, chunk.end_pos, Option::<String>::None, now, now],
                )?;
                count += 1;
            }

            // 更新 unit 状态为 indexed
            conn.execute(
                "UPDATE vfs_index_units SET text_state = 'indexed', text_indexed_at = ?1, text_chunk_count = ?2, text_embedding_dim = ?3, updated_at = ?1 WHERE id = ?4",
                rusqlite::params![now, count as i32, embedding_dim, unit_id],
            )?;

            conn.execute(
                "UPDATE vfs_embedding_dims SET record_count = record_count + ?1, last_used_at = ?2 WHERE dimension = ?3 AND modality = ?4",
                rusqlite::params![count as i32, now, embedding_dim, MODALITY_TEXT],
            )?;

            VfsIndexStateRepo::set_index_state_with_conn(
                &conn,
                resource_id,
                INDEX_STATE_INDEXED,
                Some(&resource.hash),
                None,
            )?;

            Ok(count)
        })();

        match result {
            Ok(count) => {
                conn.execute("COMMIT", [])?;
                warn!(
                    "[VfsIndexingService] DEPRECATED: Indexed resource {} with {} chunks (SQLite only, no Lance vectors). Use VfsFullIndexingService instead.",
                    resource_id, count
                );
                Ok(count)
            }
            Err(e) => {
                conn.execute("ROLLBACK", []).ok();
                VfsIndexStateRepo::mark_failed(&self.db, resource_id, &e.to_string())?;
                Err(e)
            }
        }
    }

    pub fn get_pending_resources(&self) -> VfsResult<Vec<String>> {
        let config = self.get_indexing_config()?;
        VfsIndexStateRepo::get_pending_resources(&self.db, config.batch_size, config.max_retries)
    }

    pub fn mark_resource_pending(&self, resource_id: &str) -> VfsResult<()> {
        VfsIndexStateRepo::mark_pending(&self.db, resource_id)
    }

    pub fn mark_resource_failed(&self, resource_id: &str, error: &str) -> VfsResult<()> {
        VfsIndexStateRepo::mark_failed(&self.db, resource_id, error)
    }

    pub fn check_needs_reindex(&self, resource_id: &str) -> VfsResult<bool> {
        let resource = VfsResourceRepo::get_resource(&self.db, resource_id)?;
        let state = VfsIndexStateRepo::get_index_state(&self.db, resource_id)?;

        match (resource, state) {
            (Some(r), Some(s)) => {
                if s.state != INDEX_STATE_INDEXED {
                    return Ok(true);
                }
                Ok(s.hash.as_deref() != Some(&r.hash))
            }
            (Some(_), None) => Ok(true),
            _ => Ok(false),
        }
    }

    /// 获取数据库引用
    pub fn db(&self) -> &Arc<VfsDatabase> {
        &self.db
    }
}

// ============================================================================
// VfsFullIndexingService - 集成嵌入生成和 Lance 存储的完整索引服务
// ============================================================================

/// VFS 完整索引服务
///
/// 扩展 VfsIndexingService，集成嵌入生成和 Lance 向量存储。
/// 支持教材/图片自动 OCR。
pub struct VfsFullIndexingService {
    db: Arc<VfsDatabase>,
    llm_manager: Arc<LLMManager>,
    pipeline: VfsEmbeddingPipeline,
    /// ★ 审计修复：持有 lance_store 引用，避免 delete_resource_index 每次新建实例
    lance_store: Arc<VfsLanceStore>,
    chunking_config: ChunkingConfig,
    /// ★ 2026-02-19：可选 AppHandle，用于 try_auto_ocr 发送细粒度进度事件
    app_handle: Option<AppHandle>,
}

impl VfsFullIndexingService {
    /// 创建新的完整索引服务
    pub fn new(
        db: Arc<VfsDatabase>,
        llm_manager: Arc<LLMManager>,
        lance_store: Arc<VfsLanceStore>,
    ) -> VfsResult<Self> {
        let basic_service = VfsIndexingService::new(db.clone());
        let chunking_config = basic_service.get_chunking_config()?;
        let pipeline = VfsEmbeddingPipeline::new(llm_manager.clone(), Arc::clone(&lance_store));

        Ok(Self {
            db,
            llm_manager,
            pipeline,
            lance_store,
            chunking_config,
            app_handle: None,
        })
    }

    /// 使用自定义分块配置创建服务
    pub fn with_chunking_config(
        db: Arc<VfsDatabase>,
        llm_manager: Arc<LLMManager>,
        lance_store: Arc<VfsLanceStore>,
        chunking_config: ChunkingConfig,
    ) -> Self {
        let pipeline = VfsEmbeddingPipeline::new(llm_manager.clone(), Arc::clone(&lance_store));
        Self {
            db,
            llm_manager,
            pipeline,
            lance_store,
            chunking_config,
            app_handle: None,
        }
    }

    /// ★ 2026-02-19：设置 AppHandle，用于 auto-OCR 期间发送细粒度进度事件
    pub fn set_app_handle(&mut self, app_handle: AppHandle) {
        self.app_handle = Some(app_handle);
 }

    /// 同步资源到 vfs_index_units 表（VFS 统一索引架构）
    ///
    /// 此方法在索引资源前调用，确保 Unit 记录存在
    fn sync_resource_to_units(&self, resource_id: &str) -> VfsResult<()> {
        let resource = match VfsResourceRepo::get_resource(&self.db, resource_id)? {
            Some(r) => r,
            None => return Ok(()), // 资源不存在，跳过
        };

        let index_service = VfsIndexService::new(self.db.clone());

        // 构建 UnitBuildInput（尽量补全资源信息）
        let input = match resource.resource_type {
            VfsResourceType::File | VfsResourceType::Image => {
                let conn = self.db.get_conn_safe()?;
                let (blob_hash, page_count, extracted_text, preview_json, ocr_pages_json): (
                    Option<String>,
                    Option<i32>,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                ) = conn
                    .query_row(
                        "SELECT blob_hash, page_count, extracted_text, preview_json, ocr_pages_json FROM files WHERE resource_id = ?1",
                        rusqlite::params![resource_id],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                            ))
                        },
                    )
                    .optional()?
                    .unwrap_or((None, None, None, None, None));

                let ocr_text: Option<String> = conn
                    .query_row(
                        "SELECT ocr_text FROM resources WHERE id = ?1",
                        rusqlite::params![resource_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten()
                    .filter(|t: &String| !t.trim().is_empty());

                UnitBuildInput {
                    resource_id: resource_id.to_string(),
                    resource_type: resource.resource_type.to_string(),
                    data: resource.data,
                    ocr_text,
                    ocr_pages_json,
                    blob_hash,
                    page_count,
                    extracted_text,
                    preview_json,
                }
            }
            _ => UnitBuildInput {
                resource_id: resource_id.to_string(),
                resource_type: resource.resource_type.to_string(),
                data: resource.data, // 内嵌内容
                ocr_text: None,      // OCR 文本需要从其他来源获取
                ocr_pages_json: None,
                blob_hash: Some(resource.hash),
                page_count: None,
                extracted_text: None,
                preview_json: None,
            },
        };

        match index_service.sync_resource_units(input) {
            Ok(units) => {
                debug!(
                    "[VfsFullIndexingService] Synced {} units for resource {}",
                    units.len(),
                    resource_id
                );
                Ok(())
            }
            Err(e) => {
                warn!(
                    "[VfsFullIndexingService] Failed to sync units for resource {}: {}",
                    resource_id, e
                );
                // 不阻止旧索引流程继续
                Ok(())
            }
        }
    }

    /// 索引资源（完整流程：提取内容 → 分块 → 生成嵌入 → 存储到 Lance）
    ///
    /// **这是生产环境推荐的索引方法**，它会：
    /// 1. 提取资源内容（支持自动 OCR）
    /// 2. 分块处理
    /// 3. 生成嵌入向量
    /// 4. 写入 LanceDB
    /// 5. 创建 SQLite 元数据（`vfs_index_segments`）
    ///
    /// ## lance_row_id 同步机制
    /// - `lance_row_id` 使用 `emb_xxxxxxxxxx` 格式（由 `VfsEmbedding::generate_id()` 生成）
    /// - 此 ID 在写入 LanceDB 时生成，并同步到 SQLite 的 `vfs_index_segments.lance_row_id`
    /// - 通过此 ID 可在 LanceDB 中精确定位对应的向量记录
    /// - 删除时使用此 ID 确保 SQLite 和 LanceDB 数据一致性
    ///
    /// ## 参数
    /// - `resource_id`: 资源 ID
    /// - `folder_id`: 可选的文件夹 ID（用于检索时的范围过滤）
    /// - `progress_callback`: 可选的进度回调
    ///
    /// ## 返回
    /// (索引的块数, 嵌入维度)
    pub async fn index_resource(
        &self,
        resource_id: &str,
        folder_id: Option<&str>,
        progress_callback: Option<EmbeddingProgressCallback>,
    ) -> VfsResult<(usize, usize)> {
        // 0. 同步资源到 vfs_index_units 表（VFS 统一索引架构）
        // ★ 2026-02 修复：检查 Units 是否已存在且有效，避免删除 Pipeline 创建的完整 Units
        let conn = self.db.get_conn_safe()?;
        let existing_units = index_unit_repo::get_by_resource(&conn, resource_id)?;
        let has_valid_units = existing_units
            .iter()
            .any(|u| u.text_content.is_some() || u.image_blob_hash.is_some());
        drop(conn); // 释放连接，避免长时间持有

        if has_valid_units {
            // Units 已存在且有效（由 Pipeline 的 sync_resource_units 创建），跳过重新同步
            debug!(
                "[VfsFullIndexingService] Reusing {} existing units for resource {}",
                existing_units.len(),
                resource_id
            );
        } else {
            // 无有效 Units，执行同步
            self.sync_resource_to_units(resource_id)?;
        }

        // 1. 获取资源
        let resource = VfsResourceRepo::get_resource(&self.db, resource_id)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "Resource".to_string(),
                id: resource_id.to_string(),
            }
        })?;

        let conn = self.db.get_conn_safe()?;

        let mut resolved_folder_id = folder_id.map(|value| value.to_string());
        if resource.resource_type == VfsResourceType::Note {
            if let Some(note_id) = resource.source_id.as_deref() {
                match VfsNoteRepo::get_note_with_conn(&conn, note_id)? {
                    Some(note) if note.deleted_at.is_some() => {
                        // ★ C-3 修复：使用统一的删除方法，确保所有 modality 的向量都被删除
                        self.delete_resource_index(resource_id).await?;
                        VfsIndexStateRepo::mark_disabled_with_reason(
                            &self.db,
                            resource_id,
                            "note deleted",
                        )?;
                        info!(
                            "[VfsFullIndexingService] Skip deleted note {} (resource {})",
                            note_id, resource_id
                        );
                        return Ok((0, 0));
                    }
                    Some(_) => {}
                    None => {
                        // ★ C-3 修复：使用统一的删除方法，确保所有 modality 的向量都被删除
                        self.delete_resource_index(resource_id).await?;
                        VfsIndexStateRepo::mark_disabled_with_reason(
                            &self.db,
                            resource_id,
                            "note missing",
                        )?;
                        info!(
                            "[VfsFullIndexingService] Skip missing note {} (resource {})",
                            note_id, resource_id
                        );
                        return Ok((0, 0));
                    }
                }

                if resolved_folder_id.is_none() {
                    if let Some(location) =
                        VfsNoteRepo::get_note_location_with_conn(&conn, note_id)?
                    {
                        resolved_folder_id = location.folder_id;
                    }
                }
            }
        }

        // 2. 设置索引状态为进行中
        VfsIndexStateRepo::mark_indexing(&self.db, resource_id)?;

        // 2.1 清理该资源历史 text 向量，避免维度切换后旧维度残留污染检索结果。
        // SQLite 元数据会在后续流程中重建，这里先确保 Lance 侧不会混入旧批次数据。
        self.pipeline.delete_resource_index(resource_id).await?;

        // 3. 提取内容
        // ★ 核心修复：移除 resource.data.is_empty() 提前检查
        // external 资源的 data 字段为空是正常的，内容存储在关联表中
        // 由 resolve_indexable_content 统一处理所有资源类型的内容获取
        let mut content = resolve_indexable_content(&conn, &resource);

        // ★ 2026-01 修复：教材/图片/文件无内容时自动触发 OCR
        // ★ 2026-02-10 修复：File 类型（可能是 PDF）也需要 auto-OCR 兜底
        if (content.is_none() || content.as_ref().map(|c| c.is_empty()).unwrap_or(true))
            && matches!(
                resource.resource_type,
                VfsResourceType::Textbook | VfsResourceType::Image | VfsResourceType::File
            )
        {
            info!(
                "[VfsFullIndexingService] Resource {} ({:?}) has no OCR text, attempting auto-OCR...",
                resource_id, resource.resource_type
            );

            // 尝试自动 OCR
            match self.try_auto_ocr(&resource).await {
                Ok(Some(ocr_text)) => {
                    info!(
                        "[VfsFullIndexingService] Auto-OCR succeeded for {} ({} chars)",
                        resource_id,
                        ocr_text.len()
                    );
                    content = Some(ocr_text);
                }
                Ok(None) => {
                    info!(
                        "[VfsFullIndexingService] Auto-OCR returned no content for {}",
                        resource_id
                    );
                }
                Err(e) => {
                    warn!(
                        "[VfsFullIndexingService] Auto-OCR failed for {}: {}",
                        resource_id, e
                    );
                }
            }
        }

        // ★ 2026-01 修复：空内容资源标记为 indexed（0 chunks），而非 disabled
        // 这样未来内容更新后可以重新索引
        if content.is_none() || content.as_ref().map(|c| c.is_empty()).unwrap_or(true) {
            info!(
                "[VfsFullIndexingService] Resource {} has no indexable content, marking as indexed (empty)",
                resource_id
            );

            // 记录空内容原因（但不阻止索引）
            let reason = match resource.resource_type {
                VfsResourceType::Textbook => "教材内容为空（OCR 未完成或无文字）",
                VfsResourceType::Exam => "题目集内容为空",
                VfsResourceType::Image => "图片内容为空（OCR 未完成或无文字）",
                VfsResourceType::File => "文件内容为空",
                VfsResourceType::Note => "笔记内容为空",
                VfsResourceType::MindMap => "导图内容为空",
                VfsResourceType::Translation => "翻译内容为空",
                VfsResourceType::Essay => "作文内容为空",
                VfsResourceType::Retrieval => "检索结果内容为空",
            };

            // 标记为 indexed，但 index_error 记录空内容信息
            VfsIndexStateRepo::set_index_state(
                &self.db,
                resource_id,
                INDEX_STATE_INDEXED,
                Some(&resource.hash),
                Some(reason),
            )?;
            return Ok((0, 0));
        }

        let content = content.unwrap();

        // 4. 分块
        // ★ 2026-01 优化：优先尝试按页分块以保留 page_index 信息
        // 使用 resolve_indexable_pages 从数据库获取按页信息（支持 textbooks.ocr_pages_json 等）
        let chunks = if let Some(pages) = resolve_indexable_pages(&conn, &resource) {
            info!(
                "[VfsFullIndexingService] Using page-aware chunking for {} ({} pages)",
                resource_id,
                pages.len()
            );
            let result = VfsChunker::chunk_text_with_pages(&pages, &self.chunking_config);
            let with_page_index = result.iter().filter(|c| c.page_index.is_some()).count();
            info!(
                "[VfsFullIndexingService] chunk_text_with_pages returned {} chunks, {} with page_index",
                result.len(), with_page_index
            );
            result
        } else {
            info!(
                "[VfsFullIndexingService] resolve_indexable_pages returned None for {}, using plain chunking",
                resource_id
            );
            VfsChunker::chunk_text(&content, &self.chunking_config)
        };
        let chunks_for_db = chunks.clone();
        if chunks.is_empty() {
            info!(
                "[VfsFullIndexingService] Resource {} has no chunks after splitting, marking as indexed (empty)",
                resource_id
            );
            // ★ 2026-01 修复：分块后无内容也标记为 indexed，而非 disabled
            VfsIndexStateRepo::set_index_state(
                &self.db,
                resource_id,
                INDEX_STATE_INDEXED,
                Some(&resource.hash),
                Some("文本内容过短，无法生成有效的索引块"),
            )?;
            return Ok((0, 0));
        }

        info!(
            "[VfsFullIndexingService] Indexing resource {} ({} chunks)",
            resource_id,
            chunks.len()
        );

        // 5. 生成嵌入并存储到 Lance
        let resource_type_str = resource.resource_type.to_string();
        match self
            .pipeline
            .index_chunks(
                resource_id,
                &resource_type_str,
                resolved_folder_id.as_deref(),
                chunks,
                MODALITY_TEXT,
                progress_callback,
            )
            .await
        {
            Ok(index_result) => {
                let count = index_result.count;
                let dim = index_result.dim;
                let embedding_ids = index_result.embedding_ids;

                let metadata_sync_result: VfsResult<()> = (|| {
                    // 6. ★ 审计修复：维度范围校验
                    if dim > 0 {
                        let dim_i32 = dim as i32;
                        if dim_i32 < embedding_dim_repo::MIN_DIMENSION
                            || dim_i32 > embedding_dim_repo::MAX_DIMENSION
                        {
                            warn!(
                                "[VfsFullIndexingService] Embedding dimension {} is outside valid range [{}, {}] for resource {}",
                                dim, embedding_dim_repo::MIN_DIMENSION, embedding_dim_repo::MAX_DIMENSION, resource_id
                            );
                        }
                    }

                    // 7. 写入 SQLite 元数据到 vfs_index_segments（新架构）
                    // ★ 2026-02 修复：统一 lance_row_id 生成逻辑
                    // - 正常情况：使用 LanceDB 返回的 embedding_id（emb_xxxxxxxxxx 格式）
                    // - 数量不匹配：使用 VfsEmbedding::generate_id() 生成（同样 emb_ 格式）并警告
                    if count > 0 {
                        let conn = self.db.get_conn()?;
                        let now = chrono::Utc::now().timestamp_millis();

                        // ★ 验证 embedding_ids 数量与 chunks 数量一致
                        if embedding_ids.len() != chunks_for_db.len() {
                            warn!(
                            "[VfsFullIndexingService] lance_row_id count mismatch for resource {}: \
                            embedding_ids={}, chunks={}, will generate fallback IDs with emb_ prefix",
                            resource_id, embedding_ids.len(), chunks_for_db.len()
                        );
                        }

                        // 获取或创建 unit
                        let unit_id: String = conn.query_row(
                        "SELECT id FROM vfs_index_units WHERE resource_id = ?1 AND unit_index = 0",
                        rusqlite::params![resource_id],
                        |row| row.get(0),
                    ).unwrap_or_else(|_| {
                        let new_unit_id = format!("unit_{}", nanoid::nanoid!(10));
                        let _ = conn.execute(
                            r#"INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, text_required, text_state, mm_required, mm_state, created_at, updated_at)
                            VALUES (?1, ?2, 0, '', 1, 'indexed', 0, 'disabled', ?3, ?3)"#,
                            rusqlite::params![new_unit_id, resource_id, now],
                        );
                        new_unit_id
                    });

                        // 标记该 unit 进入 indexing，并更新维度（避免删除检查误判旧维度）
                        let _ = conn.execute(
                            "UPDATE vfs_index_units SET
                                text_state = 'indexing',
                                text_error = NULL,
                                text_embedding_dim = ?1,
                                updated_at = ?2
                            WHERE id = ?3",
                            rusqlite::params![dim, now, unit_id],
                        );

                        // 删除该 unit 的旧 text segments
                        index_segment_repo::delete_by_unit_and_modality(
                            &conn,
                            &unit_id,
                            MODALITY_TEXT,
                        )?;

                        // 为每个 chunk 创建 segment，使用 Lance 返回的 embedding_id 作为 lance_row_id
                        for (i, chunk) in chunks_for_db.iter().enumerate() {
                            let seg_id = format!("seg_{}", nanoid::nanoid!(10));
                            // ★ 2026-02 修复：统一 lance_row_id 生成格式
                            // - 首选：使用 LanceDB 返回的 embedding_id
                            // - 回退：使用 VfsEmbedding::generate_id() 生成正确格式的 ID
                            // - 禁止：不再使用 seg_ 前缀作为 lance_row_id（之前的 bug）
                            let lance_row_id = embedding_ids.get(i).cloned().unwrap_or_else(|| {
                            let fallback_id = VfsEmbedding::generate_id();
                            warn!(
                                "[VfsFullIndexingService] Missing embedding_id at index {} for resource {}, using fallback: {}",
                                i, resource_id, fallback_id
                            );
                            fallback_id
                        });
                            conn.execute(
                            r#"INSERT INTO vfs_index_segments (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text, start_pos, end_pos, metadata_json, created_at, updated_at)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"#,
                            rusqlite::params![seg_id, unit_id, chunk.index, MODALITY_TEXT, dim, lance_row_id, chunk.text, chunk.start_pos, chunk.end_pos, Option::<String>::None, now, now],
                        )?;
                        }

                        // 更新 unit 状态
                        conn.execute(
                        "UPDATE vfs_index_units SET text_state = 'indexed', text_indexed_at = ?1, text_chunk_count = ?2, text_embedding_dim = ?3, updated_at = ?1 WHERE id = ?4",
                        rusqlite::params![now, count as i32, dim, unit_id],
                    )?;

                        // M12 fix: 确保维度记录存在后再更新计数（register 内部幂等）
                        embedding_dim_repo::register(&conn, dim as i32, MODALITY_TEXT)?;
                        embedding_dim_repo::increment_count(
                            &conn,
                            dim as i32,
                            MODALITY_TEXT,
                            count as i64,
                        )?;

                        debug!(
                        "[VfsFullIndexingService] Created {} segments for unit {} (resource {}), lance_row_ids synced (emb_ids={}, chunks={})",
                        chunks_for_db.len(), unit_id, resource_id, embedding_ids.len(), chunks_for_db.len()
                    );
                    }

                    Ok(())
                })();

                if let Err(sync_err) = metadata_sync_result {
                    let sync_error_msg = sync_err.to_string();
                    if let Ok(conn) = self.db.get_conn_safe() {
                        let now = chrono::Utc::now().timestamp_millis();
                        let _ = conn.execute(
                            "UPDATE vfs_index_units SET
                                text_state = 'failed',
                                text_error = ?1,
                                text_embedding_dim = NULL,
                                updated_at = ?2
                            WHERE resource_id = ?3 AND text_required = 1",
                            rusqlite::params![sync_error_msg, now, resource_id],
                        );
                    }
                    error!(
                        "[VfsFullIndexingService] Metadata sync failed after Lance write for {}: {}. Rolling back Lance vectors...",
                        resource_id, sync_error_msg
                    );

                    // 注意：此处不需要 decrement_count，因为 increment_count 是闭包中最后一个
                    // 可失败操作（?），如果 metadata_sync_result = Err，说明 increment_count
                    // 要么未被执行到，要么自身失败，计数从未被增加。

                    if let Err(cleanup_err) = self.pipeline.delete_resource_index(resource_id).await
                    {
                        error!(
                            "[VfsFullIndexingService] Lance rollback failed for {}: {}",
                            resource_id, cleanup_err
                        );
                        let combined_msg =
                            format!("{}; rollback failed: {}", sync_error_msg, cleanup_err);
                        VfsIndexStateRepo::mark_failed(&self.db, resource_id, &combined_msg)?;
                        return Err(VfsError::Other(combined_msg));
                    }

                    VfsIndexStateRepo::mark_failed(&self.db, resource_id, &sync_error_msg)?;
                    return Err(sync_err);
                }

                // 8. 索引其他 pending 的 text units（双文本来源支持）
                // FileBuilder 可能创建了多个 text units（如 native + ocr），
                // 上面的流程只处理了 resolve_indexable_content 返回的主文本（写入 unit_index=0），
                // 这里处理剩余的 pending text units
                {
                    let conn = self.db.get_conn()?;
                    let all_units = index_unit_repo::get_by_resource(&conn, resource_id)?;
                    for unit in &all_units {
                        if unit.text_required
                            && unit.text_state == index_unit_repo::IndexState::Pending
                        {
                            if let Some(ref text) = unit.text_content {
                                if !text.trim().is_empty() {
                                    info!(
                                        "[VfsFullIndexingService] Indexing additional text unit {} (source={:?}) for resource {}",
                                        unit.id, unit.text_source, resource_id
                                    );
                                    let extra_chunks =
                                        VfsChunker::chunk_text(text, &self.chunking_config);
                                    if !extra_chunks.is_empty() {
                                        let resource_type_str = resource.resource_type.to_string();
                                        match self
                                            .pipeline
                                            .index_chunks(
                                                resource_id,
                                                &resource_type_str,
                                                resolved_folder_id.as_deref(),
                                                extra_chunks.clone(),
                                                MODALITY_TEXT,
                                                None,
                                            )
                                            .await
                                        {
                                            Ok(extra_result) => {
                                                let now = chrono::Utc::now().timestamp_millis();
                                                let _ = conn.execute(
                                                    "UPDATE vfs_index_units SET
                                                        text_state = 'indexing',
                                                        text_error = NULL,
                                                        text_embedding_dim = ?1,
                                                        updated_at = ?2
                                                    WHERE id = ?3",
                                                    rusqlite::params![
                                                        extra_result.dim,
                                                        now,
                                                        unit.id
                                                    ],
                                                );
                                                index_segment_repo::delete_by_unit_and_modality(
                                                    &conn,
                                                    &unit.id,
                                                    MODALITY_TEXT,
                                                )?;
                                                for (i, chunk) in extra_chunks.iter().enumerate() {
                                                    let seg_id =
                                                        format!("seg_{}", nanoid::nanoid!(10));
                                                    let lance_row_id = extra_result
                                                        .embedding_ids
                                                        .get(i)
                                                        .cloned()
                                                        .unwrap_or_else(|| {
                                                            VfsEmbedding::generate_id()
                                                        });
                                                    conn.execute(
                                                        r#"INSERT INTO vfs_index_segments (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text, start_pos, end_pos, metadata_json, created_at, updated_at)
                                                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"#,
                                                        rusqlite::params![seg_id, unit.id, chunk.index, MODALITY_TEXT, extra_result.dim, lance_row_id, chunk.text, chunk.start_pos, chunk.end_pos, Option::<String>::None, now, now],
                                                    )?;
                                                }
                                                conn.execute(
                                                    "UPDATE vfs_index_units SET text_state = 'indexed', text_indexed_at = ?1, text_chunk_count = ?2, text_embedding_dim = ?3, updated_at = ?1 WHERE id = ?4",
                                                    rusqlite::params![now, extra_result.count as i32, extra_result.dim, unit.id],
                                                )?;
                                                // M12 fix: 确保维度记录存在
                                                embedding_dim_repo::register(
                                                    &conn,
                                                    extra_result.dim as i32,
                                                    MODALITY_TEXT,
                                                )?;
                                                embedding_dim_repo::increment_count(
                                                    &conn,
                                                    extra_result.dim as i32,
                                                    MODALITY_TEXT,
                                                    extra_result.count as i64,
                                                )?;
                                                info!(
                                                    "[VfsFullIndexingService] Additional unit {} indexed: {} chunks, dim={}",
                                                    unit.id, extra_result.count, extra_result.dim
                                                );
                                            }
                                            Err(e) => {
                                                warn!(
                                                    "[VfsFullIndexingService] Failed to index additional unit {} for resource {}: {}",
                                                    unit.id, resource_id, e
                                                );
                                                let now = chrono::Utc::now().timestamp_millis();
                                                let _ = conn.execute(
                                                    "UPDATE vfs_index_units SET text_state = 'failed', text_error = ?1, updated_at = ?2 WHERE id = ?3",
                                                    rusqlite::params![e.to_string(), now, unit.id],
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // 9. 更新索引状态
                VfsIndexStateRepo::mark_indexed(&self.db, resource_id, &resource.hash)?;

                info!(
                    "[VfsFullIndexingService] Successfully indexed resource {} ({} chunks, dim={})",
                    resource_id, count, dim
                );

                if let Ok(conn) = self.db.get_conn_safe() {
                    if let Err(e) = embedding_dim_repo::refresh_counts_from_segments(&conn) {
                        warn!(
                            "[VfsFullIndexingService] Failed to refresh embedding_dim counts after indexing {}: {}",
                            resource_id, e
                        );
                    }
                }

                Ok((count, dim))
            }
            Err(e) => {
                error!(
                    "[VfsFullIndexingService] Failed to index resource {}: {}",
                    resource_id, e
                );
                if let Ok(conn) = self.db.get_conn_safe() {
                    let now = chrono::Utc::now().timestamp_millis();
                    let _ = conn.execute(
                        "UPDATE vfs_index_units SET
                            text_state = 'failed',
                            text_error = ?1,
                            text_embedding_dim = NULL,
                            updated_at = ?2
                        WHERE resource_id = ?3 AND text_required = 1",
                        rusqlite::params![e.to_string(), now, resource_id],
                    );
                }
                VfsIndexStateRepo::mark_failed(&self.db, resource_id, &e.to_string())?;
                Err(e)
            }
        }
    }

    /// 尝试自动 OCR（教材/图片/文件）
    ///
    /// ## ★ 2026-02-19 重写：完整支持 Textbook 和 File(PDF) 自动 OCR
    ///
    /// 复用上传时已渲染的 preview_json 页面图片（blob），逐页调用 OCR 模型，
    /// 与 PdfProcessingService 的预处理管线效果一致。
    ///
    /// ## 教材/PDF 文件处理
    /// 1. 从 files 表读取 preview_json（上传时已渲染的页面图片）
    /// 2. 解析出每页 blob_hash → 获取 blob 文件路径
    /// 3. 逐页调用 OCR 模型（call_ocr_page_with_fallback，与预处理管线一致）
    /// 4. 存储 ocr_pages_json 到 files 表 + 合并文本到 resources.ocr_text
    /// 5. 通过 app_handle 发送细粒度进度事件
    ///
    /// ## 图片处理
    /// 从 blobs 表读取图片数据，调用 OCR 模型
    ///
    /// ## 返回
    /// - `Ok(Some(text))`: OCR 成功，返回识别文本
    /// - `Ok(None)`: 无法进行 OCR（如无图片数据、无预渲染页面）
    /// - `Err`: OCR 调用失败
    async fn try_auto_ocr(&self, resource: &VfsResource) -> VfsResult<Option<String>> {
        use crate::llm_manager::ImagePayload;

        match resource.resource_type {
            VfsResourceType::Image => {
                // 图片 OCR：从 attachments 或 blobs 获取图片数据
                let conn = self.db.get_conn_safe()?;

                // 尝试从 source_id 获取 attachment
                let image_data: Option<(String, String)> = if let Some(source_id) =
                    resource.source_id.as_deref()
                {
                    if source_id.starts_with("att_") {
                        conn.query_row(
                            "SELECT blob_hash, mime_type FROM files WHERE id = ?1",
                            rusqlite::params![source_id],
                            |row| {
                                Ok((
                                    row.get::<_, Option<String>>(0)?,
                                    row.get::<_, Option<String>>(1)?,
                                ))
                            },
                        )
                        .ok()
                        .and_then(|(hash, mime)| match (hash, mime) {
                            (Some(h), Some(m)) => Some((h, m)),
                            _ => None,
                        })
                    } else {
                        None
                    }
                } else {
                    None
                };

                if let Some((blob_hash, mime_type)) = image_data {
                    // 从 blobs 表读取图片数据
                    let blob_data: Option<Vec<u8>> = conn
                        .query_row(
                            "SELECT data FROM blobs WHERE hash = ?1",
                            rusqlite::params![blob_hash],
                            |row| row.get(0),
                        )
                        .ok();

                    if let Some(data) = blob_data {
                        let base64 = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &data,
                        );
                        let image_payload = ImagePayload {
                            mime: mime_type.clone(),
                            base64,
                        };

                        info!(
                            "[try_auto_ocr] Calling OCR for image {} ({})",
                            resource.id, mime_type
                        );

                        let result = self
                            .llm_manager
                            .call_ocr_model_raw_prompt(
                                "Convert the document to markdown.",
                                Some(vec![image_payload]),
                            )
                            .await
                            .map_err(|e| VfsError::Other(format!("OCR 调用失败: {}", e)))?;

                        let ocr_text = result.assistant_message.trim().to_string();

                        if !ocr_text.is_empty() {
                            // 缓存到 resources.ocr_text
                            let _ = conn.execute(
                                "UPDATE resources SET ocr_text = ?1 WHERE id = ?2",
                                rusqlite::params![ocr_text, resource.id],
                            );
                            return Ok(Some(ocr_text));
                        }
                    }
                }

                Ok(None)
            }

            VfsResourceType::Textbook | VfsResourceType::File => {
                // ★ 2026-02-19：Textbook 和 File(PDF) 统一 OCR 实现
                // 复用上传时已渲染的 preview_json 页面图片
                self.try_auto_ocr_pdf_pages(resource).await
            }

            // Note/Translation/Essay/Exam/MindMap/Retrieval：无需 OCR
            VfsResourceType::Note
            | VfsResourceType::Translation
            | VfsResourceType::Essay
            | VfsResourceType::Exam
            | VfsResourceType::MindMap
            | VfsResourceType::Retrieval => Ok(None),
        }
    }

    /// ★ 2026-02-19：对 Textbook/File(PDF) 执行自动 OCR
    ///
    /// 复用上传时渲染的 preview_json 页面图片（blob），逐页调用 OCR 模型。
    /// 流程与 PdfProcessingService::stage_ocr_processing 一致：
    /// 1. 查找关联的 file_id → 读取 preview_json
    /// 2. 解析出每页 blob_hash → 获取 blob 文件路径
    /// 3. 逐页调用 call_ocr_page_with_fallback（带重试，与预处理管线一致）
    /// 4. 存储 OcrPagesJson 到 files.ocr_pages_json
    /// 5. 合并所有页面文本 → 存储到 resources.ocr_text
    /// 6. 通过 app_handle 发送细粒度进度事件（auto_ocr_started / auto_ocr_page / auto_ocr_completed）
    ///
    /// 对于 File 类型的图片 MIME（非 PDF），回退到单图 OCR。
    async fn try_auto_ocr_pdf_pages(&self, resource: &VfsResource) -> VfsResult<Option<String>> {
        let conn = self.db.get_conn_safe()?;

        // 1. 查找关联的 file_id
        let file_id: Option<String> = if let Some(source_id) = resource.source_id.as_deref() {
            // source_id 可能直接是 file_id
            if source_id.starts_with("file_") || source_id.starts_with("att_") || source_id.starts_with("tb_") {
                // 检查 files 表中是否存在
                let exists: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM files WHERE id = ?1",
                        rusqlite::params![source_id],
                        |row| row.get::<_, i32>(0),
                    )
                    .unwrap_or(0)
                    > 0;
                if exists {
                    Some(source_id.to_string())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
        .or_else(|| {
            // 回退：通过 resource_id 查找 file_id
            conn.query_row(
                "SELECT id FROM files WHERE resource_id = ?1",
                rusqlite::params![resource.id],
                |row| row.get(0),
            )
            .ok()
        });

        let file_id = match file_id {
            Some(id) => id,
            None => {
                info!(
                    "[try_auto_ocr_pdf_pages] No file_id found for resource {}, skipping",
                    resource.id
                );
                return Ok(None);
            }
        };

        // 2. 读取文件信息：preview_json, mime_type, ocr_pages_json
        let file_info: Option<(Option<String>, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT preview_json, mime_type, ocr_pages_json FROM files WHERE id = ?1",
                rusqlite::params![file_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();

        let (preview_json_opt, mime_type_opt, existing_ocr_json) = match file_info {
            Some(info) => info,
            None => {
                info!(
                    "[try_auto_ocr_pdf_pages] File {} not found in DB, skipping",
                    file_id
                );
                return Ok(None);
            }
        };

        // ★ 2026-02-19 防竞态：如果 ocr_pages_json 已存在（并发预处理管线已完成），
        // 直接合并现有文本返回，避免重复调用 OCR API
        if let Some(ref ocr_json) = existing_ocr_json {
            if !ocr_json.trim().is_empty() {
                info!(
                    "[try_auto_ocr_pdf_pages] ocr_pages_json already exists for file {} (len={}), using existing OCR result",
                    file_id, ocr_json.len()
                );
                // 尝试从 ocr_pages_json 合并文本
                let pages = parse_ocr_pages_json(ocr_json);
                if let Some(text) = join_ocr_pages_text(&pages, "第", "页") {
                    if !text.is_empty() {
                        // 缓存到 resources.ocr_text（如果还没有）
                        let _ = conn.execute(
                            "UPDATE resources SET ocr_text = ?1 WHERE id = ?2 AND (ocr_text IS NULL OR ocr_text = '')",
                            rusqlite::params![text, resource.id],
                        );
                        return Ok(Some(text));
                    }
                }
                // ocr_pages_json 存在但无法提取文本，继续尝试重新 OCR
                info!(
                    "[try_auto_ocr_pdf_pages] Existing ocr_pages_json for file {} could not be parsed into text, will re-OCR",
                    file_id
                );
            }
        }

        let mime_type = mime_type_opt.unwrap_or_default();

        // 3. 对于 File 类型，检查 MIME 类型
        if resource.resource_type == VfsResourceType::File {
            let is_pdf = mime_type == "application/pdf";
            let is_image = mime_type.starts_with("image/");

            if is_image {
                // File 类型的图片：回退到单图 OCR（原有逻辑）
                return self.try_auto_ocr_single_image(resource, &file_id).await;
            }

            if !is_pdf {
                info!(
                    "[try_auto_ocr_pdf_pages] File {} has unsupported MIME type ({}), skipping OCR",
                    resource.id, mime_type
                );
                return Ok(None);
            }
        }

        // 4. 解析 preview_json
        let preview_json_str = match preview_json_opt {
            Some(ref s) if !s.trim().is_empty() => s.clone(),
            _ => {
                info!(
                    "[try_auto_ocr_pdf_pages] No preview_json for file {} (resource {}), cannot OCR without rendered pages",
                    file_id, resource.id
                );
                return Ok(None);
            }
        };

        let preview: PdfPreviewJson = serde_json::from_str(&preview_json_str).map_err(|e| {
            VfsError::Other(format!(
                "Failed to parse preview_json for file {}: {}",
                file_id, e
            ))
        })?;

        let total_pages = preview.pages.len();
        if total_pages == 0 {
            info!(
                "[try_auto_ocr_pdf_pages] preview_json has 0 pages for file {}, skipping",
                file_id
            );
            return Ok(None);
        }

        let blobs_dir = self.db.blobs_dir().to_path_buf();

        info!(
            "[try_auto_ocr_pdf_pages] Starting auto-OCR for resource {} (file={}, {} pages)",
            resource.id, file_id, total_pages
        );

        // 5. 发送 auto_ocr_started 事件
        if let Some(ref ah) = self.app_handle {
            let _ = ah.emit(
                "vfs-index-progress",
                serde_json::json!({
                    "type": "auto_ocr_started",
                    "resourceId": resource.id,
                    "fileId": file_id,
                    "totalPages": total_pages,
                    "message": format!("开始自动 OCR ({} 页)...", total_pages)
                }),
            );
        }

        // 6. 逐页 OCR（与 PdfProcessingService::stage_ocr_processing 一致）
        let mut ocr_results: Vec<OcrPageResult> = Vec::with_capacity(total_pages);
        let mut failed_count = 0usize;

        for (idx, page) in preview.pages.iter().enumerate() {
            // 获取 blob 文件路径
            let blob_path = match VfsBlobRepo::get_blob_path_with_conn(&conn, &blobs_dir, &page.blob_hash)? {
                Some(path) => path,
                None => {
                    warn!(
                        "[try_auto_ocr_pdf_pages] Blob not found for page {} (hash={}), skipping",
                        idx, page.blob_hash
                    );
                    failed_count += 1;
                    continue;
                }
            };

            // 调用 OCR（使用 call_ocr_page_with_fallback，与预处理管线一致）
            let path_str = blob_path.to_string_lossy().to_string();
            match self
                .llm_manager
                .call_ocr_page_with_fallback(&path_str, page.page_index)
                .await
            {
                Ok(cards) => {
                    let blocks: Vec<PdfOcrTextBlock> = cards
                        .iter()
                        .map(|c| PdfOcrTextBlock {
                            text: c.ocr_text.clone().unwrap_or_default(),
                            bbox: c.bbox.clone(),
                        })
                        .collect();

                    ocr_results.push(OcrPageResult {
                        page_index: page.page_index,
                        blocks,
                    });

                    info!(
                        "[try_auto_ocr_pdf_pages] OCR page {}/{} completed for resource {}",
                        idx + 1,
                        total_pages,
                        resource.id
                    );
                }
                Err(e) => {
                    warn!(
                        "[try_auto_ocr_pdf_pages] OCR failed for page {} of resource {}: {}",
                        idx, resource.id, e
                    );
                    failed_count += 1;
                }
            }

            // 发送逐页进度事件
            if let Some(ref ah) = self.app_handle {
                let completed = ocr_results.len() + failed_count;
                let percent = if total_pages > 0 {
                    (completed as f64 / total_pages as f64 * 100.0) as u32
                } else {
                    0
                };
                let _ = ah.emit(
                    "vfs-index-progress",
                    serde_json::json!({
                        "type": "auto_ocr_page",
                        "resourceId": resource.id,
                        "fileId": file_id,
                        "currentPage": idx + 1,
                        "totalPages": total_pages,
                        "successCount": ocr_results.len(),
                        "failCount": failed_count,
                        "percent": percent,
                        "message": format!("自动 OCR 进度: {}/{} 页", idx + 1, total_pages)
                    }),
                );
            }
        }

        // 7. 按页码排序
        ocr_results.sort_by_key(|r| r.page_index);

        let success_count = ocr_results.len();
        info!(
            "[try_auto_ocr_pdf_pages] OCR completed for resource {}: {} success, {} failed out of {} pages",
            resource.id, success_count, failed_count, total_pages
        );

        if success_count == 0 {
            // 发送完成事件（失败）
            if let Some(ref ah) = self.app_handle {
                let _ = ah.emit(
                    "vfs-index-progress",
                    serde_json::json!({
                        "type": "auto_ocr_completed",
                        "resourceId": resource.id,
                        "fileId": file_id,
                        "success": false,
                        "successCount": 0,
                        "failCount": failed_count,
                        "totalPages": total_pages,
                        "message": format!("自动 OCR 失败: 所有 {} 页均识别失败", total_pages)
                    }),
                );
            }
            return Ok(None);
        }

        // 8. 构建 OcrPagesJson 并存储到 files.ocr_pages_json
        let ocr_json = OcrPagesJson {
            total_pages,
            pages: ocr_results.clone(),
            completed_at: chrono::Utc::now().to_rfc3339(),
        };

        let ocr_json_str = serde_json::to_string(&ocr_json).map_err(|e| {
            VfsError::Other(format!("Failed to serialize OCR result: {}", e))
        })?;

        conn.execute(
            "UPDATE files SET ocr_pages_json = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![ocr_json_str, file_id],
        )?;

        // 9. 合并所有页面文本 → 存储到 resources.ocr_text
        let combined_text: String = ocr_results
            .iter()
            .map(|page| {
                page.blocks
                    .iter()
                    .map(|b| b.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|t| !t.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");

        if !combined_text.is_empty() {
            let _ = conn.execute(
                "UPDATE resources SET ocr_text = ?1, updated_at = datetime('now') WHERE id = ?2",
                rusqlite::params![combined_text, resource.id],
            );
        }

        // 10. 更新 processing_progress 中的 ready_modes（标记 ocr 已就绪）
        let progress_json: Option<String> = conn
            .query_row(
                "SELECT processing_progress FROM files WHERE id = ?1",
                rusqlite::params![file_id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(ref pj) = progress_json {
            if let Ok(mut progress) =
                serde_json::from_str::<crate::vfs::pdf_processing_service::ProcessingProgress>(pj)
            {
                if !progress.ready_modes.contains(&"ocr".to_string()) {
                    progress.ready_modes.push("ocr".to_string());
                    if let Ok(new_json) = serde_json::to_string(&progress) {
                        let _ = conn.execute(
                            "UPDATE files SET processing_progress = ?1, updated_at = datetime('now') WHERE id = ?2",
                            rusqlite::params![new_json, file_id],
                        );
                    }
                }
            }
        }

        // 11. 发送 auto_ocr_completed 事件
        if let Some(ref ah) = self.app_handle {
            let _ = ah.emit(
                "vfs-index-progress",
                serde_json::json!({
                    "type": "auto_ocr_completed",
                    "resourceId": resource.id,
                    "fileId": file_id,
                    "success": true,
                    "successCount": success_count,
                    "failCount": failed_count,
                    "totalPages": total_pages,
                    "textLength": combined_text.len(),
                    "message": format!("自动 OCR 完成: {}/{} 页成功", success_count, total_pages)
                }),
            );
        }

        if combined_text.is_empty() {
            Ok(None)
        } else {
            Ok(Some(combined_text))
        }
    }

    /// File 类型的单图 OCR（非 PDF 图片文件）
    ///
    /// 从 files 表获取 blob_hash → 读取 blob 数据 → 调用 OCR 模型
    ///
    /// ★ 2026-02-19 修复：不接受 &rusqlite::Connection 参数（Connection 是 !Sync，
    /// &Connection 是 !Send，跨 .await 会导致 future !Send）。
    /// 改为内部获取独立连接，确保 future 是 Send。
    async fn try_auto_ocr_single_image(
        &self,
        resource: &VfsResource,
        file_id: &str,
    ) -> VfsResult<Option<String>> {
        use crate::llm_manager::ImagePayload;

        // 在 .await 之前完成所有 DB 读取，然后 drop conn
        let ocr_input: Option<(String, ImagePayload)> = {
            let conn = self.db.get_conn_safe()?;
            let file_data: Option<(String, String)> = conn
                .query_row(
                    "SELECT blob_hash, mime_type FROM files WHERE id = ?1",
                    rusqlite::params![file_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .ok()
                .and_then(|(hash, mime)| match (hash, mime) {
                    (Some(h), Some(m)) => Some((h, m)),
                    _ => None,
                });

            if let Some((blob_hash, mime_type)) = file_data {
                let blob_data: Option<Vec<u8>> = conn
                    .query_row(
                        "SELECT data FROM blobs WHERE hash = ?1",
                        rusqlite::params![blob_hash],
                        |row| row.get(0),
                    )
                    .ok();

                if let Some(data) = blob_data {
                    let base64 = base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &data,
                    );
                    Some((mime_type.clone(), ImagePayload {
                        mime: mime_type,
                        base64,
                    }))
                } else {
                    None
                }
            } else {
                None
            }
        }; // conn dropped here, before .await

        if let Some((mime_type, image_payload)) = ocr_input {
            info!(
                "[try_auto_ocr_single_image] Calling OCR for file {} ({})",
                resource.id, mime_type
            );

            let result = self
                .llm_manager
                .call_ocr_model_raw_prompt(
                    "Convert the document to markdown.",
                    Some(vec![image_payload]),
                )
                .await
                .map_err(|e| VfsError::Other(format!("OCR 调用失败: {}", e)))?;

            let ocr_text = result.assistant_message.trim().to_string();

            if !ocr_text.is_empty() {
                // .await 之后重新获取连接写入
                let conn = self.db.get_conn_safe()?;
                let _ = conn.execute(
                    "UPDATE resources SET ocr_text = ?1 WHERE id = ?2",
                    rusqlite::params![ocr_text, resource.id],
                );
                return Ok(Some(ocr_text));
            }
        }

        Ok(None)
    }

    /// ★ 2026-01: 索引单个题目（Question 独立索引）
    ///
    /// 将题目作为独立的向量索引，而非整个 Exam 一起索引。
    /// 这样可以提高题目检索的精度。
    ///
    /// ## 参数
    /// - `question_id`: 题目 ID
    /// - `exam_id`: 所属试卷的资源 ID（用于文件夹过滤）
    ///
    /// ## 返回
    /// (索引的块数, 嵌入维度)
    ///
    /// ## 注意
    /// 此方法**不刷新** `vfs_embedding_dims.record_count`。
    /// 调用方须在批量完成后调用 `embedding_dim_repo::refresh_counts_from_segments`。
    /// `index_exam_questions` 已在尾部统一刷新。
    pub async fn index_question(
        &self,
        question_id: &str,
        exam_id: &str,
    ) -> VfsResult<(usize, usize)> {
        use crate::vfs::repos::VfsQuestionRepo;

        // 1. 获取题目
        let question = VfsQuestionRepo::get_question(&self.db, question_id)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "Question".to_string(),
                id: question_id.to_string(),
            }
        })?;

        // 2. 构建题目的可索引文本
        let mut texts = Vec::new();

        // 题目内容
        if !question.content.trim().is_empty() {
            texts.push(format!("题目: {}", question.content.trim()));
        }

        // 选项
        if let Some(options) = &question.options {
            for opt in options {
                texts.push(format!("选项{}: {}", opt.key, opt.content));
            }
        }

        // 答案
        if let Some(answer) = &question.answer {
            if !answer.trim().is_empty() {
                texts.push(format!("答案: {}", answer.trim()));
            }
        }

        // 解析
        if let Some(explanation) = &question.explanation {
            if !explanation.trim().is_empty() {
                texts.push(format!("解析: {}", explanation.trim()));
            }
        }

        // 标签
        if !question.tags.is_empty() {
            texts.push(format!("标签: {}", question.tags.join(", ")));
        }

        // 用户笔记
        if let Some(note) = &question.user_note {
            if !note.trim().is_empty() {
                texts.push(format!("笔记: {}", note.trim()));
            }
        }

        if texts.is_empty() {
            info!(
                "[VfsFullIndexingService] Question {} has no indexable content",
                question_id
            );
            return Ok((0, 0));
        }

        let content = texts.join("\n\n");

        // 3. 分块（题目通常较短，可能只有一个块）
        let chunks = VfsChunker::chunk_text(&content, &self.chunking_config);
        if chunks.is_empty() {
            return Ok((0, 0));
        }

        info!(
            "[VfsFullIndexingService] Indexing question {} ({} chunks)",
            question_id,
            chunks.len()
        );

        // 4. 获取 exam 资源的 folder_id
        let folder_id: Option<String> =
            VfsResourceRepo::get_resource(&self.db, exam_id)?.and_then(|r| r.source_id);

        // 5. 生成嵌入并存储到 Lance
        // 使用 question_id 作为 resource_id，类型为 "question"
        match self
            .pipeline
            .index_chunks(
                question_id,
                "question",
                folder_id.as_deref(),
                chunks.clone(),
                MODALITY_TEXT,
                None,
            )
            .await
        {
            Ok(index_result) => {
                let count = index_result.count;
                let dim = index_result.dim;
                let embedding_ids = index_result.embedding_ids;

                // ★ 审计修复：写入 SQLite unit + segments，与主 index_resource 路径保持一致
                // pipeline.index_chunks 只写 LanceDB，SQLite 元数据须由调用方写入
                // ★ C3-P1 修复：用闭包包裹 SQLite 写入，失败时回滚 LanceDB 向量
                if count > 0 {
                    let metadata_sync_result: VfsResult<()> = (|| {
                        let conn = self.db.get_conn()?;
                        let now = chrono::Utc::now().timestamp_millis();

                        // 注册维度（幂等）
                        embedding_dim_repo::register(&conn, dim as i32, MODALITY_TEXT)?;

                        // 获取或创建 unit（question 作为独立资源）
                        let unit_id: String = conn.query_row(
                            "SELECT id FROM vfs_index_units WHERE resource_id = ?1 AND unit_index = 0",
                            rusqlite::params![question_id],
                            |row| row.get(0),
                        ).unwrap_or_else(|_| {
                            let new_unit_id = format!("unit_{}", nanoid::nanoid!(10));
                            let _ = conn.execute(
                                r#"INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, text_required, text_state, mm_required, mm_state, created_at, updated_at)
                                VALUES (?1, ?2, 0, '', 1, 'indexing', 0, 'disabled', ?3, ?3)"#,
                                rusqlite::params![new_unit_id, question_id, now],
                            );
                            new_unit_id
                        });

                        // 删除该 unit 的旧 text segments
                        index_segment_repo::delete_by_unit_and_modality(
                            &conn,
                            &unit_id,
                            MODALITY_TEXT,
                        )?;

                        // 为每个 chunk 创建 segment
                        for (i, chunk) in chunks.iter().enumerate() {
                            let seg_id = format!("seg_{}", nanoid::nanoid!(10));
                            let lance_row_id = embedding_ids.get(i).cloned().unwrap_or_else(|| {
                                let fallback_id = VfsEmbedding::generate_id();
                                warn!(
                                    "[VfsFullIndexingService] Missing embedding_id at index {} for question {}, using fallback: {}",
                                    i, question_id, fallback_id
                                );
                                fallback_id
                            });
                            conn.execute(
                                r#"INSERT INTO vfs_index_segments (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text, start_pos, end_pos, metadata_json, created_at, updated_at)
                                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"#,
                                rusqlite::params![seg_id, unit_id, chunk.index, MODALITY_TEXT, dim, lance_row_id, chunk.text, chunk.start_pos, chunk.end_pos, Option::<String>::None, now, now],
                            )?;
                        }

                        // 更新 unit 状态
                        conn.execute(
                            "UPDATE vfs_index_units SET text_state = 'indexed', text_indexed_at = ?1, text_chunk_count = ?2, text_embedding_dim = ?3, updated_at = ?1 WHERE id = ?4",
                            rusqlite::params![now, count as i32, dim, unit_id],
                        )?;

                        Ok(())
                    })();

                    if let Err(sync_err) = metadata_sync_result {
                        // ★ C3-P1 修复：SQLite 写入失败时回滚 LanceDB 向量
                        error!(
                            "[VfsFullIndexingService] SQLite metadata sync failed for question {}: {}. Rolling back Lance vectors...",
                            question_id, sync_err
                        );
                        if let Err(rollback_err) =
                            self.pipeline.delete_resource_index(question_id).await
                        {
                            error!(
                                "[VfsFullIndexingService] Lance rollback also failed for question {}: {}",
                                question_id, rollback_err
                            );
                        }
                        return Err(sync_err);
                    }
                }

                info!(
                    "[VfsFullIndexingService] Successfully indexed question {} ({} chunks, dim={})",
                    question_id, count, dim
                );

                Ok((count, dim))
            }
            Err(e) => {
                error!(
                    "[VfsFullIndexingService] Failed to index question {}: {}",
                    question_id, e
                );
                Err(e)
            }
        }
    }

    /// ★ 2026-01: 批量索引试卷的所有题目
    ///
    /// 为试卷中的每个题目创建独立的向量索引。
    ///
    /// ## 参数
    /// - `exam_id`: 试卷资源 ID
    ///
    /// ## 返回
    /// (成功索引的题目数, 失败数)
    pub async fn index_exam_questions(&self, exam_id: &str) -> VfsResult<(usize, usize)> {
        use crate::vfs::repos::{QuestionFilters, VfsQuestionRepo};

        // 获取试卷的所有题目
        let result = VfsQuestionRepo::list_questions(
            &self.db,
            exam_id,
            &QuestionFilters::default(),
            1,
            1000, // 假设一张试卷最多 1000 题
        )?;

        if result.questions.is_empty() {
            info!(
                "[VfsFullIndexingService] Exam {} has no questions to index",
                exam_id
            );
            return Ok((0, 0));
        }

        info!(
            "[VfsFullIndexingService] Indexing {} questions from exam {}",
            result.questions.len(),
            exam_id
        );

        let mut success = 0;
        let mut failed = 0;

        for question in result.questions {
            match self.index_question(&question.id, exam_id).await {
                Ok((count, _)) => {
                    // ★ L-037 修复：Ok 即计数，空内容也算成功（避免统计偏小）
                    success += 1;
                    if count == 0 {
                        debug!(
                            "[VfsFullIndexingService] Question {} indexed with 0 chunks (empty content)",
                            question.id
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        "[VfsFullIndexingService] Failed to index question {}: {}",
                        question.id, e
                    );
                    failed += 1;
                }
            }
        }

        // ★ C3-P2 修复：批量索引完成后统一刷新 record_count（而非每题刷新）
        if success > 0 {
            if let Ok(conn) = self.db.get_conn() {
                if let Err(e) = embedding_dim_repo::refresh_counts_from_segments(&conn) {
                    warn!(
                        "[VfsFullIndexingService] Failed to refresh counts after batch indexing exam {}: {}",
                        exam_id, e
                    );
                }
            }
        }

        info!(
            "[VfsFullIndexingService] Indexed exam {} questions: {} success, {} failed",
            exam_id, success, failed
        );

        Ok((success, failed))
    }

    /// 重新索引资源
    ///
    /// ★ C-3 修复：使用统一的删除方法，确保所有 modality 的旧向量都被清理
    pub async fn reindex_resource(
        &self,
        resource_id: &str,
        folder_id: Option<&str>,
        progress_callback: Option<EmbeddingProgressCallback>,
    ) -> VfsResult<(usize, usize)> {
        // 1. 删除旧索引（text + multimodal + SQLite 元数据）
        self.delete_resource_index(resource_id).await?;

        // 2. 重新索引
        self.index_resource(resource_id, folder_id, progress_callback)
            .await
    }

    /// 删除资源索引
    ///
    /// ★ C-3/M-12 修复：同时删除 text 和 multimodal 两种 modality 的 LanceDB 向量，
    /// 确保软删除后的资源不会在 RAG 检索中被错误返回。
    /// ★ 审计修复：复用 self.lance_store，删除后刷新 record_count
    pub async fn delete_resource_index(&self, resource_id: &str) -> VfsResult<()> {
        // 1. 删除 text modality 的 Lance 向量（通过 pipeline）
        self.pipeline.delete_resource_index(resource_id).await?;

        // 2. 删除 multimodal modality 的 Lance 向量
        // ★ 审计修复：复用 self.lance_store 而非每次创建新实例
        self.lance_store
            .delete_by_resource(MODALITY_MULTIMODAL, resource_id)
            .await
            .map_err(|e| {
                VfsError::Other(format!(
                    "Failed to delete multimodal vectors for {}: {}",
                    resource_id, e
                ))
            })?;

        // 3. 删除 SQLite 中的元数据（新架构：Units + Segments 级联删除）
        let conn = self.db.get_conn()?;
        index_unit_repo::delete_by_resource(&conn, resource_id)?;

        // ★ 审计修复：刷新 record_count，防止删除后计数漂移
        if let Err(e) = embedding_dim_repo::refresh_counts_from_segments(&conn) {
            warn!(
                "[VfsFullIndexingService] Failed to refresh embedding_dim counts after deleting {}: {}",
                resource_id, e
            );
        }

        // 4. 重置索引状态
        VfsIndexStateRepo::mark_pending(&self.db, resource_id)?;

        info!(
            "[VfsFullIndexingService] Deleted index for resource {} (text + multimodal)",
            resource_id
        );

        Ok(())
    }

    /// 批量索引待处理的资源（并行处理）
    ///
    /// ## 参数
    /// - `batch_size`: 每批处理的资源数
    ///
    /// ## 返回
    /// (成功数, 失败数)
    ///
    /// ## 并行策略
    /// 使用 `max_concurrent` 配置控制并行度（默认 2）
    pub async fn process_pending_batch(&self, batch_size: u32) -> VfsResult<(usize, usize)> {
        let config = VfsIndexingService::new(self.db.clone()).get_indexing_config()?;
        let pending =
            VfsIndexStateRepo::claim_pending_resources(&self.db, batch_size, config.max_retries)?;

        if pending.is_empty() {
            return Ok((0, 0));
        }

        let total = pending.len();
        let max_concurrent = config.max_concurrent.max(1) as usize;

        info!(
            "[VfsFullIndexingService] Processing {} claimed pending resources (max_concurrent={})",
            total, max_concurrent
        );

        let success_count = Arc::new(AtomicUsize::new(0));
        let fail_count = Arc::new(AtomicUsize::new(0));

        // 使用 buffer_unordered 并行处理
        stream::iter(pending)
            .map(|resource_id| {
                let success = Arc::clone(&success_count);
                let fail = Arc::clone(&fail_count);
                async move {
                    match self.index_resource(&resource_id, None, None).await {
                        Ok((count, _)) => {
                            success.fetch_add(1, Ordering::Relaxed);
                            info!(
                                "[VfsFullIndexingService] Indexed {} ({} chunks)",
                                resource_id, count
                            );
                        }
                        Err(e) => {
                            warn!(
                                "[VfsFullIndexingService] Failed to index {}: {}",
                                resource_id, e
                            );
                            fail.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            })
            .buffer_unordered(max_concurrent)
            .collect::<Vec<_>>()
            .await;

        let success = success_count.load(Ordering::Relaxed);
        let fail = fail_count.load(Ordering::Relaxed);

        info!(
            "[VfsFullIndexingService] Batch complete: {} success, {} failed",
            success, fail
        );

        Ok((success, fail))
    }

    /// 检查资源是否需要重新索引
    pub fn check_needs_reindex(&self, resource_id: &str) -> VfsResult<bool> {
        VfsIndexingService::new(self.db.clone()).check_needs_reindex(resource_id)
    }

    /// 获取分块配置
    pub fn chunking_config(&self) -> &ChunkingConfig {
        &self.chunking_config
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsSearchParams {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_ids: Option<Vec<String>>,
    /// 🆕 精确到特定资源的过滤（用于针对特定文档进行深入检索）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_types: Option<Vec<String>>,
    #[serde(default = "default_modality")]
    pub modality: String,
    #[serde(default = "default_top_k")]
    pub top_k: u32,
}

fn default_modality() -> String {
    MODALITY_TEXT.to_string()
}

fn default_top_k() -> u32 {
    10
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsSearchResult {
    pub embedding_id: String,
    pub resource_id: String,
    pub chunk_index: i32,
    pub chunk_text: String,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    /// 页面索引（用于 PDF/教材定位，0-indexed）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_index: Option<i32>,
    /// 来源 ID（如 textbook_xxx, att_xxx）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsEmbeddingStats {
    pub total_embeddings: i64,
    pub total_resources_indexed: i64,
    pub dimensions: Vec<VfsDimensionStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsDimensionStat {
    pub dimension: i32,
    pub modality: String,
    /// ★ 审计修复：统一为 i64
    pub record_count: i64,
    pub table_name: String,
}

pub struct VfsSearchService {
    db: Arc<VfsDatabase>,
}

impl VfsSearchService {
    pub fn new(db: Arc<VfsDatabase>) -> Self {
        Self { db }
    }

    pub fn search_fts(&self, query: &str, top_k: u32) -> VfsResult<Vec<VfsSearchResult>> {
        // 新架构：使用 vfs_index_segments 表进行 FTS 搜索
        // 注意：vfs_index_segments 没有 FTS 虚拟表，使用 LIKE 搜索
        let conn = self.db.get_conn_safe()?;

        let mut stmt = conn.prepare(
            r#"SELECT s.id, u.resource_id, s.content_text, s.segment_index
               FROM vfs_index_segments s
               JOIN vfs_index_units u ON s.unit_id = u.id
               WHERE s.content_text LIKE '%' || ?1 || '%'
               LIMIT ?2"#,
        )?;

        let results: Vec<VfsSearchResult> = stmt
            .query_map(rusqlite::params![query, top_k], |row| {
                Ok(VfsSearchResult {
                    embedding_id: row.get(0)?,
                    resource_id: row.get(1)?,
                    chunk_index: row.get(3)?,
                    chunk_text: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    score: 1.0, // FTS 搜索暂无评分
                    resource_title: None,
                    resource_type: None,
                    page_index: None,
                    source_id: None,
                })
            })?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(results)
    }

    pub fn get_embedding_stats(&self) -> VfsResult<VfsEmbeddingStats> {
        let conn = self.db.get_conn_safe()?;

        let total_embeddings: i64 =
            conn.query_row("SELECT COUNT(*) FROM vfs_index_segments", [], |row| {
                row.get(0)
            })?;

        let total_resources_indexed: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT u.resource_id) FROM vfs_index_segments s JOIN vfs_index_units u ON s.unit_id = u.id",
            [],
            |row| row.get(0),
        )?;

        // ★ 审计修复：统一使用 embedding_dim_repo（替代已废弃的 VfsDimensionRepo）
        let dimensions = embedding_dim_repo::list_all(&conn)?;
        let dimension_stats: Vec<VfsDimensionStat> = dimensions
            .into_iter()
            .map(|d| VfsDimensionStat {
                dimension: d.dimension,
                modality: d.modality,
                record_count: d.record_count,
                table_name: d.lance_table_name,
            })
            .collect();

        Ok(VfsEmbeddingStats {
            total_embeddings,
            total_resources_indexed,
            dimensions: dimension_stats,
        })
    }
}

// ============================================================================
// VfsFullSearchService - 集成 Lance 向量检索的完整搜索服务
// ============================================================================

/// 搜索模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VfsSearchMode {
    /// 仅向量搜索
    Vector,
    /// 仅全文搜索
    FullText,
    /// 混合搜索（向量 + 全文）
    Hybrid,
}

/// VFS 完整搜索服务
///
/// 扩展 VfsSearchService，集成 Lance 向量检索和可选的重排序。
pub struct VfsFullSearchService {
    db: Arc<VfsDatabase>,
    lance_store: Arc<VfsLanceStore>,
    embedding_service: VfsEmbeddingService,
    llm_manager: Arc<LLMManager>,
}

impl VfsFullSearchService {
    /// 创建新的完整搜索服务
    pub fn new(
        db: Arc<VfsDatabase>,
        lance_store: Arc<VfsLanceStore>,
        llm_manager: Arc<LLMManager>,
    ) -> Self {
        let embedding_service = VfsEmbeddingService::new(llm_manager.clone());
        Self {
            db,
            lance_store,
            embedding_service,
            llm_manager,
        }
    }

    /// 向量搜索
    ///
    /// ## 参数
    /// - `query`: 查询文本
    /// - `params`: 搜索参数
    ///
    /// ## 返回
    /// 搜索结果列表
    pub async fn vector_search(
        &self,
        query: &str,
        params: &VfsSearchParams,
    ) -> VfsResult<Vec<VfsSearchResult>> {
        // 1. 生成查询向量
        let query_embedding = self.embedding_service.generate_embedding(query).await?;

        // 2. 执行向量搜索
        let folder_ids: Option<Vec<String>> = params.folder_ids.clone();
        let resource_ids: Option<Vec<String>> = params.resource_ids.clone();
        let resource_types: Option<Vec<String>> = params.resource_types.clone();

        let lance_results = self
            .lance_store
            .vector_search_full(
                &params.modality,
                &query_embedding,
                params.top_k as usize,
                folder_ids.as_deref(),
                resource_ids.as_deref(),
                resource_types.as_deref(),
            )
            .await?;

        // 3. 转换为 VfsSearchResult
        let results = self.lance_results_to_search_results(lance_results);

        info!(
            "[VfsFullSearchService] Vector search '{}' returned {} results",
            query,
            results.len()
        );

        Ok(results)
    }

    /// 混合搜索（向量 + 全文）
    ///
    /// ## 参数
    /// - `query`: 查询文本
    /// - `params`: 搜索参数
    ///
    /// ## 返回
    /// 搜索结果列表
    pub async fn hybrid_search(
        &self,
        query: &str,
        params: &VfsSearchParams,
    ) -> VfsResult<Vec<VfsSearchResult>> {
        // 1. 生成查询向量
        let query_embedding = self.embedding_service.generate_embedding(query).await?;

        // 2. 执行混合搜索
        let folder_ids: Option<Vec<String>> = params.folder_ids.clone();
        let resource_ids: Option<Vec<String>> = params.resource_ids.clone();
        let resource_types: Option<Vec<String>> = params.resource_types.clone();

        let lance_results = self
            .lance_store
            .hybrid_search_full(
                &params.modality,
                query,
                &query_embedding,
                params.top_k as usize,
                folder_ids.as_deref(),
                resource_ids.as_deref(),
                resource_types.as_deref(),
            )
            .await?;

        // 3. 转换为 VfsSearchResult
        let results = self.lance_results_to_search_results(lance_results);

        info!(
            "[VfsFullSearchService] Hybrid search '{}' returned {} results",
            query,
            results.len()
        );

        Ok(results)
    }

    /// 智能搜索（根据配置选择搜索模式）
    ///
    /// ## 参数
    /// - `query`: 查询文本
    /// - `params`: 搜索参数
    /// - `enable_reranking`: 是否启用重排序
    ///
    /// ## 返回
    /// 搜索结果列表
    pub async fn search(
        &self,
        query: &str,
        params: &VfsSearchParams,
        enable_reranking: bool,
    ) -> VfsResult<Vec<VfsSearchResult>> {
        // 根据配置决定搜索模式
        let config = VfsIndexingService::new(self.db.clone()).get_search_config()?;

        let mode = if config.enable_hybrid {
            VfsSearchMode::Hybrid
        } else {
            VfsSearchMode::Vector
        };

        // 执行搜索
        let mut results = match mode {
            VfsSearchMode::Hybrid => self.hybrid_search(query, params).await?,
            VfsSearchMode::Vector => self.vector_search(query, params).await?,
            VfsSearchMode::FullText => {
                VfsSearchService::new(self.db.clone()).search_fts(query, params.top_k)?
            }
        };

        // 可选的重排序
        if enable_reranking && !results.is_empty() && config.enable_reranking {
            results = self.rerank_results(query, results).await?;
        }

        Ok(results)
    }

    /// 重排序搜索结果
    async fn rerank_results(
        &self,
        query: &str,
        results: Vec<VfsSearchResult>,
    ) -> VfsResult<Vec<VfsSearchResult>> {
        // 获取重排序模型配置
        let model_assignments = self
            .llm_manager
            .get_model_assignments()
            .await
            .map_err(|e| VfsError::Other(format!("获取模型分配失败: {}", e)))?;

        let reranker_model_id = match model_assignments.reranker_model_config_id {
            Some(id) => id,
            None => {
                debug!("[VfsFullSearchService] No reranker model configured, skipping reranking");
                return Ok(results);
            }
        };

        // 转换为 RetrievedChunk 格式（复用 RagManager 的重排序逻辑）
        let chunks: Vec<crate::models::RetrievedChunk> = results
            .iter()
            .map(|r| crate::models::RetrievedChunk {
                chunk: crate::models::DocumentChunk {
                    id: r.embedding_id.clone(),
                    document_id: r.resource_id.clone(),
                    chunk_index: r.chunk_index as usize,
                    text: r.chunk_text.clone(),
                    metadata: std::collections::HashMap::new(),
                },
                score: r.score as f32,
            })
            .collect();

        // 调用重排序 API
        let reranked = self
            .llm_manager
            .call_reranker_api(query.to_string(), chunks, &reranker_model_id)
            .await
            .map_err(|e| VfsError::Other(format!("重排序失败: {}", e)))?;

        // 根据重排序结果重新排序
        let reranked_results: Vec<VfsSearchResult> = reranked
            .into_iter()
            .filter_map(|rc| {
                results
                    .iter()
                    .find(|r| r.embedding_id == rc.chunk.id)
                    .map(|r| VfsSearchResult {
                        score: rc.score as f64,
                        ..r.clone()
                    })
            })
            .collect();

        info!(
            "[VfsFullSearchService] Reranked {} results",
            reranked_results.len()
        );

        Ok(reranked_results)
    }

    /// 将 Lance 搜索结果转换为 VfsSearchResult
    fn lance_results_to_search_results(
        &self,
        lance_results: Vec<crate::vfs::lance_store::VfsLanceSearchResult>,
    ) -> Vec<VfsSearchResult> {
        lance_results
            .into_iter()
            .map(|lr| VfsSearchResult {
                embedding_id: lr.embedding_id,
                resource_id: lr.resource_id.clone(),
                chunk_index: lr.chunk_index,
                chunk_text: lr.text,
                score: lr.score as f64,
                resource_title: None,
                resource_type: Some(lr.resource_type),
                page_index: lr.page_index,
                source_id: lr.source_id,
            })
            .collect()
    }

    /// 获取带资源信息的搜索结果
    pub async fn search_with_resource_info(
        &self,
        query: &str,
        params: &VfsSearchParams,
        enable_reranking: bool,
    ) -> VfsResult<Vec<VfsSearchResult>> {
        let results = self.search(query, params, enable_reranking).await?;
        Self::enrich_and_filter_results(&self.db, results)
    }

    /// 公共的结果富化和软删除过滤方法
    ///
    /// ★ 2026-02 修复：抽取为公共方法，确保 search_with_resource_info 和
    /// search_cross_dimension_with_resource_info 两条路径都应用软删除过滤。
    fn enrich_and_filter_results(
        db: &Arc<VfsDatabase>,
        results: Vec<VfsSearchResult>,
    ) -> VfsResult<Vec<VfsSearchResult>> {
        let valid_results: Vec<VfsSearchResult> = results
            .into_iter()
            .filter_map(|mut result| {
                if let Ok(Some(resource)) = VfsResourceRepo::get_resource(db, &result.resource_id) {
                    // ★ 2026-02 修复：过滤已软删除的源资源，防止"幽灵搜索结果"
                    if let Some(source_id) = resource.source_id.as_deref() {
                        if Self::is_source_soft_deleted(db, source_id) {
                            debug!(
                                "[VFS::Search] Skipping soft-deleted source: resource_id={}, source_id={}",
                                result.resource_id, source_id
                            );
                            return None;
                        }
                    }

                    // 从元数据获取标题，或使用 source_id
                    let title = resource
                        .metadata
                        .as_ref()
                        .and_then(|m| m.title.clone())
                        .or_else(|| resource.source_id.clone())
                        .unwrap_or_else(|| resource.id.clone());
                    result.resource_title = Some(title);
                    result.resource_type = Some(resource.resource_type.to_string());
                    // ★ 2026-01-22: 补充 source_id（DSTU 资源 ID 如 tb_xxx）
                    if result.source_id.is_none() {
                        result.source_id = resource.source_id.clone();
                    }
                    Some(result)
                } else {
                    None
                }
            })
            .collect();

        Ok(valid_results)
    }

    /// 检查源资源是否已被软删除
    ///
    /// 通过 source_id 的前缀推断源表，然后检查 deleted_at 是否非空。
    fn is_source_soft_deleted(db: &VfsDatabase, source_id: &str) -> bool {
        let conn = match db.get_conn_safe() {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "[VFS::Search] is_source_soft_deleted: get_conn failed, skipping filter: {}",
                    e
                );
                return false;
            }
        };

        // 根据 source_id 前缀确定表名和 ID 列
        // ★ 注意：前缀检查顺序很重要，essay_session_ 必须在 essay_ 之前
        // ★ 注意：tb_ 存储在 files 表（VFS 迁移后教材统一到 files），不是 textbooks 表
        let table = if source_id.starts_with("note_") {
            "notes"
        } else if source_id.starts_with("tb_")
            || source_id.starts_with("file_")
            || source_id.starts_with("att_")
            || source_id.starts_with("img_")
        {
            "files"
        } else if source_id.starts_with("exam_") {
            "exam_sheets"
        } else if source_id.starts_with("essay_session_") || source_id.starts_with("es_") {
            "essay_sessions"
        } else if source_id.starts_with("essay_") {
            "essays"
        } else if source_id.starts_with("tr_") {
            "translations"
        } else if source_id.starts_with("mm_") {
            "mindmaps"
        } else {
            return false; // 未知类型，保守不过滤
        };

        // 使用 format! 构建 SQL（表名为硬编码常量，安全可控）
        let sql = format!(
            "SELECT 1 FROM {} WHERE id = ?1 AND deleted_at IS NOT NULL LIMIT 1",
            table
        );

        match conn.query_row(&sql, rusqlite::params![source_id], |_| Ok(true)) {
            Ok(true) => true,
            _ => false,
        }
    }

    /// 获取 Lance 表统计信息
    pub async fn get_lance_stats(&self, modality: &str) -> VfsResult<Vec<(String, usize)>> {
        self.lance_store.get_table_stats(modality).await
    }

    /// 优化 Lance 表
    pub async fn optimize_lance_tables(&self, modality: &str) -> VfsResult<usize> {
        self.lance_store.optimize_all(modality).await
    }

    // ========================================================================
    // 跨维度聚合检索
    // ========================================================================

    /// 跨维度聚合搜索（可完全替代普通搜索）
    ///
    /// 遍历所有有数据的维度，使用各自绑定的模型生成查询向量，
    /// 对于没有模型绑定的维度使用全局默认嵌入模型。
    /// 然后聚合所有维度的搜索结果，按分数排序返回。
    ///
    /// ## 参数
    /// - `query`: 查询文本
    /// - `params`: 搜索参数
    ///
    /// ## 返回
    /// 跨维度聚合的搜索结果列表
    pub async fn cross_dimension_search(
        &self,
        query: &str,
        params: &VfsSearchParams,
    ) -> VfsResult<Vec<VfsSearchResult>> {
        // 1. 获取所有有数据的维度
        // ★ 审计修复：统一使用 embedding_dim_repo（替代已废弃的 VfsDimensionRepo）
        let conn = self.db.get_conn()?;
        let all_dimensions = embedding_dim_repo::list_all(&conn)?;
        drop(conn);
        let dimensions: Vec<_> = all_dimensions
            .into_iter()
            .filter(|d| d.record_count > 0 && d.modality == params.modality)
            .collect();

        if dimensions.is_empty() {
            info!(
                "[VfsFullSearchService] No dimensions with data found for modality {}",
                params.modality
            );
            return Ok(Vec::new());
        }

        // 2. 获取全局默认嵌入模型（用于没有模型绑定的维度）
        let default_model_id = self.embedding_service.get_embedding_model_id().await.ok();

        info!(
            "[VfsFullSearchService] Cross-dimension search: {} dimensions, default model: {:?}",
            dimensions.len(),
            default_model_id
        );

        // ★ 审计修复：读取搜索配置，跨维度搜索也尊重 hybrid 设置
        let enable_hybrid = VfsIndexingService::new(self.db.clone())
            .get_search_config()
            .map(|c| c.enable_hybrid)
            .unwrap_or(false);

        let mut all_results: Vec<VfsSearchResult> = Vec::new();
        let folder_ids: Option<Vec<String>> = params.folder_ids.clone();
        let resource_ids: Option<Vec<String>> = params.resource_ids.clone();
        let resource_types: Option<Vec<String>> = params.resource_types.clone();

        // 3. 缓存 embedding 结果，避免对同一模型重复调用 API
        let mut embedding_cache: std::collections::HashMap<String, Vec<f32>> =
            std::collections::HashMap::new();

        // 4. 对每个维度执行搜索
        for dim in dimensions {
            // 确定使用的模型：优先使用维度绑定的模型，否则使用全局默认模型
            let model_config_id = dim
                .model_config_id
                .clone()
                .or_else(|| default_model_id.clone());

            let model_config_id = match model_config_id {
                Some(id) => id,
                None => {
                    warn!(
                        "[VfsFullSearchService] No model available for dimension {} (no binding and no default)",
                        dim.dimension
                    );
                    continue;
                }
            };

            // 从缓存获取或生成查询向量
            let query_embedding = if let Some(cached) = embedding_cache.get(&model_config_id) {
                cached.clone()
            } else {
                match self
                    .llm_manager
                    .call_embedding_api(vec![query.to_string()], &model_config_id)
                    .await
                {
                    Ok(embeddings) => {
                        if let Some(emb) = embeddings.into_iter().next() {
                            embedding_cache.insert(model_config_id.clone(), emb.clone());
                            emb
                        } else {
                            warn!(
                                "[VfsFullSearchService] Empty embedding returned for model {}",
                                model_config_id
                            );
                            continue;
                        }
                    }
                    Err(e) => {
                        warn!(
                            "[VfsFullSearchService] Failed to generate embedding with model {}: {}",
                            model_config_id, e
                        );
                        continue;
                    }
                }
            };

            // 验证向量维度匹配
            if query_embedding.len() != dim.dimension as usize {
                warn!(
                    "[VfsFullSearchService] Dimension mismatch: expected {}, got {} for model {} (data may have been indexed with a different model)",
                    dim.dimension, query_embedding.len(), model_config_id
                );
                continue;
            }

            // ★ 审计修复：根据搜索配置选择 vector 或 hybrid 模式
            // 跨维度搜索应与普通搜索使用相同的搜索模式，避免搜索质量降级
            let lance_results = if enable_hybrid {
                match self
                    .lance_store
                    .hybrid_search_full(
                        &params.modality,
                        query,
                        &query_embedding,
                        params.top_k as usize,
                        folder_ids.as_deref(),
                        resource_ids.as_deref(),
                        resource_types.as_deref(),
                    )
                    .await
                {
                    Ok(results) => results,
                    Err(e) => {
                        warn!(
                            "[VfsFullSearchService] Hybrid search failed for dimension {}: {}, falling back to vector",
                            dim.dimension, e
                        );
                        // 回退到纯向量搜索
                        match self
                            .lance_store
                            .vector_search_full(
                                &params.modality,
                                &query_embedding,
                                params.top_k as usize,
                                folder_ids.as_deref(),
                                resource_ids.as_deref(),
                                resource_types.as_deref(),
                            )
                            .await
                        {
                            Ok(results) => results,
                            Err(e2) => {
                                warn!(
                                    "[VfsFullSearchService] Vector search also failed for dimension {}: {}",
                                    dim.dimension, e2
                                );
                                continue;
                            }
                        }
                    }
                }
            } else {
                match self
                    .lance_store
                    .vector_search_full(
                        &params.modality,
                        &query_embedding,
                        params.top_k as usize,
                        folder_ids.as_deref(),
                        resource_ids.as_deref(),
                        resource_types.as_deref(),
                    )
                    .await
                {
                    Ok(results) => results,
                    Err(e) => {
                        warn!(
                            "[VfsFullSearchService] Vector search failed for dimension {}: {}",
                            dim.dimension, e
                        );
                        continue;
                    }
                }
            };

            let dim_results = self.lance_results_to_search_results(lance_results);
            info!(
                "[VfsFullSearchService] Dimension {} (model: {:?}) returned {} results",
                dim.dimension,
                dim.model_name.as_ref().unwrap_or(&model_config_id),
                dim_results.len()
            );

            all_results.extend(dim_results);
        }

        // 4. 去重（同一 resource_id + chunk_index 只保留分数最高的）
        let mut seen: std::collections::HashMap<(String, i32), usize> =
            std::collections::HashMap::new();
        let mut deduped_results: Vec<VfsSearchResult> = Vec::new();

        // 先按分数降序排序
        all_results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for result in all_results {
            let key = (result.resource_id.clone(), result.chunk_index);
            if !seen.contains_key(&key) {
                seen.insert(key, deduped_results.len());
                deduped_results.push(result);
            }
        }

        // 5. 截断到 top_k
        deduped_results.truncate(params.top_k as usize);

        info!(
            "[VfsFullSearchService] Cross-dimension search '{}' returned {} results after dedup",
            query,
            deduped_results.len()
        );

        Ok(deduped_results)
    }

    /// 智能搜索（支持跨维度）
    ///
    /// 如果启用跨维度搜索，则聚合所有维度的结果；否则只使用当前模型的维度。
    pub async fn search_cross_dimension(
        &self,
        query: &str,
        params: &VfsSearchParams,
        enable_cross_dimension: bool,
        enable_reranking: bool,
    ) -> VfsResult<Vec<VfsSearchResult>> {
        let mut results = if enable_cross_dimension {
            self.cross_dimension_search(query, params).await?
        } else {
            self.search(query, params, false).await?
        };

        // 可选的重排序
        if enable_reranking && !results.is_empty() {
            let config = VfsIndexingService::new(self.db.clone()).get_search_config()?;
            if config.enable_reranking {
                results = self.rerank_results(query, results).await?;
            }
        }

        Ok(results)
    }

    /// 跨维度搜索并补充资源信息
    ///
    /// 执行跨维度聚合搜索，并为每个结果补充资源标题等信息。
    pub async fn search_cross_dimension_with_resource_info(
        &self,
        query: &str,
        params: &VfsSearchParams,
        enable_reranking: bool,
    ) -> VfsResult<Vec<VfsSearchResult>> {
        let mut results = self.cross_dimension_search(query, params).await?;

        // 可选的重排序
        if enable_reranking && !results.is_empty() {
            let config = VfsIndexingService::new(self.db.clone()).get_search_config()?;
            if config.enable_reranking {
                results = self.rerank_results(query, results).await?;
            }
        }

        // ★ 2026-02 修复：使用公共方法，确保跨维度搜索也过滤软删除资源
        Self::enrich_and_filter_results(&self.db, results)
    }

    // ========================================================================
    // 多模态搜索说明
    // ========================================================================
    // 多模态内容（图片/PDF）由 crate::multimodal 模块统一处理
    // VFS 只负责文本内容的索引和检索
    // 如需多模态检索，请使用 MultimodalRetriever
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_fixed_size() {
        let config = ChunkingConfig {
            strategy: "fixed_size".to_string(),
            chunk_size: 10,
            chunk_overlap: 2,
            min_chunk_size: 3,
        };

        let text = "Hello world, this is a test string for chunking.";
        let chunks = VfsChunker::chunk_text(text, &config);

        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|c| c.text.len() >= config.min_chunk_size));
    }

    #[test]
    fn test_chunk_semantic() {
        let config = ChunkingConfig {
            strategy: "semantic".to_string(),
            chunk_size: 100,
            chunk_overlap: 0,
            min_chunk_size: 5,
        };

        let text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
        let chunks = VfsChunker::chunk_text(text, &config);

        assert!(!chunks.is_empty());
    }

    #[test]
    fn test_extract_markdown() {
        let md = "# Title\n\n**Bold** and *italic*\n\n![image](url)\n\n[link](url)";
        let text = VfsContentExtractor::extract_indexable_content(&VfsResourceType::Note, md);

        assert!(text.is_some());
        let text = text.unwrap();
        assert!(!text.contains("!["));
        assert!(!text.contains("**"));
    }

    #[test]
    fn test_extract_translation() {
        let json = r#"{"source": "Hello", "translated": "你好"}"#;
        let text =
            VfsContentExtractor::extract_indexable_content(&VfsResourceType::Translation, json);

        assert!(text.is_some());
        let text = text.unwrap();
        assert!(text.contains("Hello"));
        assert!(text.contains("你好"));
    }
}
