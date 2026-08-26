//! 文档分段服务：将长文档切成可供 LLM 制卡的分段任务。
//!
//! # Token 估算权威规则（务必阅读）
//!
//! 本代码库中存在多套 token 估算实现，它们的口径**不一致**，这是已知且被接受的现状：
//!
//! | 位置 | 规则 | 用途 |
//! |------|------|------|
//! | 本文件 [`estimate_tokens`] | 汉字(0x4E00-0x9FFF)=1/字 + 词数×1.3 + 其它字符×0.2，下限=字符数/4 | **分段预算的唯一权威**。所有分段决策（是否分段、切点、重叠裁剪）只允许使用本函数 |
//! | `utils/token_budget.rs` | 逐字符加权（ASCII 字母 0.25、CJK/假名/谚文 1.0、Emoji 0.8…），启用 `tokenizer_tiktoken` 时用真实 tokenizer | 聊天上下文预算 |
//! | 前端 `src/features/chat/utils/tokenUtils.ts`、`CardAgent.ts` | CJK=1/字，ASCII≈4字符/token | UI 展示提示，仅供参考 |
//!
//! 约定：
//! 1. 分段逻辑内部必须自洽 —— 同一次分段中所有预算判断都用本文件的 [`estimate_tokens`]，
//!    绝不混用 `token_budget::estimate_tokens` 或前端估算值。
//! 2. 前端估算只用于展示（如"预计 N 段"），后端分段结果以本文件为准；两者出现 ±30% 偏差属预期。
//! 3. 默认每段预算 10_000 tokens（见 [`DEFAULT_MAX_TOKENS_PER_SEGMENT`]），相对主流模型
//!    128k+ 上下文留有充足余量，因此估算口径的偏差不会导致请求超限。
//! 4. 单元测试 `estimate_tokens_pinned_values` / `estimate_tokens_diverges_from_token_budget`
//!    钉住了本规则与差异，改动估算公式必须同步更新测试与本注释。
//!
//! # `enable_llm_boundary_detection` 的诚实说明
//!
//! 该选项由 ChatAnki 等调用方传入（`AnkiGenerationOptions.enable_llm_boundary_detection`）。
//! 历史上后端从未读取过它（假开关）。现在本服务会读取它，开启时在**硬切点**（超长单句
//! 被迫按字符切断处）附近向 段落(\n\n) > 换行 > 句末标点 > 空白 边界回退吸附。
//! 这是**纯规则的 "semantic-ish" 边界吸附，不是 LLM 定界**——没有任何模型调用参与切点选择。
//! 详见 `docs/research/anki-ai-native/round3/06-document-segmentation.md`。

use crate::database::Database;
use crate::models::{AnkiGenerationOptions, AppError, DocumentTask, TaskStatus};
use chrono::Utc;
use std::sync::Arc;
use uuid::Uuid;

/// 默认每段最大 token 预算（按本文件 `estimate_tokens` 口径）。
const DEFAULT_MAX_TOKENS_PER_SEGMENT: usize = 10_000;

/// 每段预算下限。防止调用方传入 `max_tokens=0` 之类的值把预算压成 0，
/// 旧实现会因此在 `split_by_characters` 中死循环（max_chars=0 时 start 永不前进）。
const MIN_TOKENS_PER_SEGMENT: usize = 256;

/// 句末标点集合（中英文），用于句子切分与边界吸附。
const SENTENCE_ENDS: [char; 6] = ['.', '!', '?', '。', '！', '？'];

pub struct DocumentProcessingService {
    db: Arc<Database>,
}

impl DocumentProcessingService {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 处理文档并创建分段任务
    /// `pre_allocated_document_id`: 可选的预分配 document_id，用于提前将 ID 返回给调用方
    pub async fn process_document_and_create_tasks(
        &self,
        document_content: String,
        original_document_name: String,
        options: AnkiGenerationOptions,
    ) -> Result<(String, Vec<DocumentTask>), AppError> {
        let document_id = Uuid::new_v4().to_string();
        self.process_document_and_create_tasks_with_id(
            document_id,
            document_content,
            original_document_name,
            options,
        )
        .await
    }

    /// 处理文档并创建分段任务（使用预分配的 document_id）
    pub async fn process_document_and_create_tasks_with_id(
        &self,
        document_id: String,
        document_content: String,
        original_document_name: String,
        options: AnkiGenerationOptions,
    ) -> Result<(String, Vec<DocumentTask>), AppError> {
        // 分段文档（纯函数，便于单测）
        let segments = segment_document(&document_content, &options)?;

        let mut tasks = Vec::new();
        let segment_limits = options
            .max_cards_total
            .filter(|total| *total > 0)
            .map(|total| distribute_global_max_cards(total, segments.len()));

        let now = Utc::now().to_rfc3339();

        for (index, segment) in segments.into_iter().enumerate() {
            let mut task_options = options.clone();
            if let Some(limits) = segment_limits.as_ref() {
                task_options.max_cards_per_mistake = limits.get(index).copied().unwrap_or(0);
            }
            let anki_options_json = serde_json::to_string(&task_options).map_err(|e| {
                AppError::validation(format!("序列化AnkiGenerationOptions失败: {}", e))
            })?;

            let task = DocumentTask {
                id: Uuid::new_v4().to_string(),
                document_id: document_id.clone(),
                original_document_name: original_document_name.clone(),
                segment_index: index as u32,
                content_segment: segment,
                status: TaskStatus::Pending,
                created_at: now.clone(),
                updated_at: now.clone(),
                error_message: None,
                anki_generation_options_json: anki_options_json.clone(),
            };

            // 保存到数据库
            self.db
                .insert_document_task(&task)
                .map_err(|e| AppError::database(format!("保存文档任务失败: {}", e)))?;

            tasks.push(task);
        }

        Ok((document_id, tasks))
    }

    /// 获取文档的所有任务
    pub fn get_document_tasks(&self, document_id: &str) -> Result<Vec<DocumentTask>, AppError> {
        self.db
            .get_tasks_for_document(document_id)
            .map_err(|e| AppError::database(format!("获取文档任务失败: {}", e)))
    }

    /// 更新任务状态
    pub fn update_task_status(
        &self,
        task_id: &str,
        status: TaskStatus,
        error_message: Option<String>,
    ) -> Result<(), AppError> {
        self.db
            .update_document_task_status(task_id, status, error_message)
            .map_err(|e| AppError::database(format!("更新任务状态失败: {}", e)))
    }

    /// 获取单个任务
    pub fn get_task(&self, task_id: &str) -> Result<DocumentTask, AppError> {
        self.db
            .get_document_task(task_id)
            .map_err(|e| AppError::database(format!("获取任务失败: {}", e)))
    }

    /// 删除文档及其所有任务
    pub fn delete_document(&self, document_id: &str) -> Result<(), AppError> {
        self.db
            .delete_document_session(document_id)
            .map_err(|e| AppError::database(format!("删除文档失败: {}", e)))
    }
}

// =====================================================================
// 纯分段逻辑（不依赖数据库，可直接单元测试）
// =====================================================================

/// 文档分段入口。
///
/// 流程：
/// 1. 估算全文 token（本文件权威口径），不超预算则整篇作为单段返回；
/// 2. 按 `\n\n` 段落边界优先聚合（[`segment_without_overlap`]）；
/// 3. 超预算段落按句子切分，超预算单句按字符硬切
///    （开启 `enable_llm_boundary_detection` 时硬切点做规则边界吸附）；
/// 4. `segment_overlap_size > 0` 时在相邻分段间注入重叠上下文；
/// 5. 兜底：过滤空白分段，保证至少返回一个分段。
fn segment_document(
    content: &str,
    options: &AnkiGenerationOptions,
) -> Result<Vec<String>, AppError> {
    let max_tokens_per_segment = calculate_max_tokens_per_segment(options);
    let estimated_content_tokens = estimate_tokens(content);

    // 如果内容较短（含空文档），不需要分段
    if estimated_content_tokens <= max_tokens_per_segment {
        return Ok(vec![content.to_string()]);
    }

    let overlap_size = options.segment_overlap_size as usize;
    // 诚实开关：这里读取的是规则边界吸附，不是 LLM 定界（见模块注释）。
    let snap_boundaries = options.enable_llm_boundary_detection.unwrap_or(false);
    println!(
        "[DOCUMENT_DEBUG] 文档分段: 估计{}tokens，每段最大{}tokens，重叠区域{}字符，边界吸附={}",
        estimated_content_tokens, max_tokens_per_segment, overlap_size, snap_boundaries
    );
    if snap_boundaries {
        println!(
            "[DOCUMENT_DEBUG] enable_llm_boundary_detection=true → 应用规则边界吸附（非 LLM 定界）"
        );
    }
    println!(
        "[DOCUMENT_DEBUG] 用户设置: 每个主题最大卡片数={}, 总体令牌限制={:?}",
        options.max_cards_per_mistake, options.max_tokens
    );

    // 使用重叠分段策略
    let mut segments = if overlap_size > 0 {
        segment_with_overlap(
            content,
            max_tokens_per_segment,
            overlap_size,
            snap_boundaries,
        )?
    } else {
        segment_without_overlap(content, max_tokens_per_segment, snap_boundaries)?
    };

    // 兜底修复：绝不返回空/纯空白分段（旧实现在 trim 后可能残留空段）
    segments.retain(|s| !s.trim().is_empty());
    if segments.is_empty() {
        segments.push(content.to_string());
    }

    println!("[DOCUMENT_DEBUG] 文档分段完成: {}个分段", segments.len());
    for (i, segment) in segments.iter().enumerate() {
        let segment_tokens = estimate_tokens(segment);
        println!(
            "[DOCUMENT_DEBUG] 分段{}: {}字符, 估计{}tokens",
            i + 1,
            segment.len(),
            segment_tokens
        );
    }
    Ok(segments)
}

/// 估算文本的 token 数量。
///
/// **分段预算的权威规则**（改动必须同步更新模块注释与钉住测试）：
///
/// ```text
/// tokens = 汉字数(U+4E00..=U+9FFF)
///        + floor(空白分词词数 × 1.3)
///        + floor(非汉字字符数 × 0.2)
/// 下限：max(tokens, 总字符数 / 4)
/// 空串 → 0
/// ```
///
/// 注意与 `utils/token_budget.rs`（逐字符加权/tiktoken）以及前端
/// `tokenUtils.ts`（CJK=1、ASCII=4字符/token）**口径不同**，差异已被接受，
/// 详见模块级注释与 `docs/research/anki-ai-native/round3/06-document-segmentation.md`。
fn estimate_tokens(text: &str) -> usize {
    let char_count = text.chars().count();
    if char_count == 0 {
        return 0;
    }
    let word_count = text.split_whitespace().count();

    let chinese_chars = text
        .chars()
        .filter(|c| {
            let code = *c as u32;
            (0x4E00..=0x9FFF).contains(&code) // 基本汉字范围
        })
        .count();

    let other_chars = char_count - chinese_chars;
    let estimated_tokens =
        chinese_chars + (word_count as f32 * 1.3) as usize + (other_chars as f32 * 0.2) as usize;

    std::cmp::max(estimated_tokens, char_count / 4) // 最少不低于字符数的1/4
}

/// 计算每个分段的最大 token 数。
///
/// - 默认 [`DEFAULT_MAX_TOKENS_PER_SEGMENT`]（10k，足以容纳完整章节/知识单元）；
/// - 用户设置了较小的 `max_output_tokens_override` / `max_tokens` 时，输入预算取其一半；
/// - 结果永远 ≥ [`MIN_TOKENS_PER_SEGMENT`]，修复旧实现 `max_tokens=0/1` 时预算为 0
///   导致按字符硬切死循环的问题。
fn calculate_max_tokens_per_segment(options: &AnkiGenerationOptions) -> usize {
    let base_limit = DEFAULT_MAX_TOKENS_PER_SEGMENT;

    if let Some(max_tokens) = options.max_output_tokens_override.or(options.max_tokens) {
        if (max_tokens as usize) < base_limit * 2 {
            // 如果输出限制较小，输入也应该相应减少
            let derived = std::cmp::min(base_limit, (max_tokens / 2) as usize);
            return derived.max(MIN_TOKENS_PER_SEGMENT);
        }
    }

    base_limit
}

/// 无重叠的文档分段：段落边界优先。
///
/// 按 `\n\n` 切分段落后贪心聚合：能放进当前分段就追加，放不下就另起新段；
/// 单段落超预算时降级为句子切分（[`split_long_paragraph`]）。
/// 因此只要段落本身不超预算，**返回的每个分段都由完整段落拼接而成**。
fn segment_without_overlap(
    content: &str,
    max_tokens_per_segment: usize,
    snap_boundaries: bool,
) -> Result<Vec<String>, AppError> {
    // 按自然段落分割
    let paragraphs: Vec<&str> = content
        .split("\n\n")
        .filter(|p| !p.trim().is_empty())
        .collect();

    let mut segments = Vec::new();
    let mut current_segment = String::new();
    let mut current_tokens = 0;

    for paragraph in paragraphs {
        let paragraph_tokens = estimate_tokens(paragraph);

        // 如果单个段落就超过限制，需要进一步分割
        if paragraph_tokens > max_tokens_per_segment {
            // 先保存当前分段（如果有内容）
            if !current_segment.trim().is_empty() {
                segments.push(current_segment.trim().to_string());
            }
            current_segment.clear();
            current_tokens = 0;

            // 分割长段落
            let sub_segments =
                split_long_paragraph(paragraph, max_tokens_per_segment, snap_boundaries)?;
            segments.extend(sub_segments);
            continue;
        }

        // 检查添加这个段落是否会超出限制
        if current_tokens + paragraph_tokens > max_tokens_per_segment && !current_segment.is_empty()
        {
            // 保存当前分段并开始新分段
            if !current_segment.trim().is_empty() {
                segments.push(current_segment.trim().to_string());
            }
            current_segment = paragraph.to_string();
            current_tokens = paragraph_tokens;
        } else {
            // 添加到当前分段
            if !current_segment.is_empty() {
                current_segment.push_str("\n\n");
            }
            current_segment.push_str(paragraph);
            current_tokens += paragraph_tokens;
        }
    }

    // 添加最后一个分段
    if !current_segment.trim().is_empty() {
        segments.push(current_segment.trim().to_string());
    }

    // 确保至少有一个分段
    if segments.is_empty() {
        segments.push(content.to_string());
    }

    Ok(segments)
}

/// 分割过长的段落：先按句末标点切句，超预算的单句按字符硬切。
fn split_long_paragraph(
    paragraph: &str,
    max_tokens: usize,
    snap_boundaries: bool,
) -> Result<Vec<String>, AppError> {
    // 按句子分割
    let sentences: Vec<&str> = paragraph
        .split_inclusive(&SENTENCE_ENDS[..])
        .filter(|s| !s.trim().is_empty())
        .collect();

    let mut segments = Vec::new();
    let mut current_segment = String::new();
    let mut current_tokens = 0;

    for sentence in sentences {
        let sentence_tokens = estimate_tokens(sentence);

        // 如果单个句子就超过限制，按字符数强制分割
        if sentence_tokens > max_tokens {
            // 先保存当前分段
            if !current_segment.trim().is_empty() {
                segments.push(current_segment.trim().to_string());
            }
            current_segment.clear();
            current_tokens = 0;

            // 按字符数分割长句子（硬切点可选边界吸附）
            let char_segments = split_by_characters(sentence, max_tokens, snap_boundaries);
            segments.extend(char_segments);
            continue;
        }

        if current_tokens + sentence_tokens > max_tokens && !current_segment.is_empty() {
            if !current_segment.trim().is_empty() {
                segments.push(current_segment.trim().to_string());
            }
            current_segment = sentence.to_string();
            current_tokens = sentence_tokens;
        } else {
            current_segment.push_str(sentence);
            current_tokens += sentence_tokens;
        }
    }

    if !current_segment.trim().is_empty() {
        segments.push(current_segment.trim().to_string());
    }

    Ok(segments)
}

/// 按字符强制分割（token 感知）。
///
/// 修复两个旧实现的真实 bug：
/// 1. 旧实现用 `max_chars = max_tokens * 2` 的粗略换算，对 CJK（≈1 token/字）
///    会产出约 2 倍超预算的分段；现在对切点做二分搜索，保证每段
///    `estimate_tokens(segment) <= max_tokens`（除非单个字符本身就超预算）。
/// 2. 旧实现 `max_tokens=0` 时 `max_chars=0`，`start` 永不前进 → 死循环；
///    现在预算钳制为 ≥1 且每轮至少消费 1 个字符，保证终止。
///
/// 始终在 `char` 边界切割（绝不切坏 UTF-8/CJK/emoji 标量值）；
/// `snap_boundaries` 开启时对硬切点执行 [`snap_cut_to_boundary`] 规则吸附。
/// 不做 trim：所有非纯空白分段拼接后与原文逐字节一致（纯空白块被跳过但仍推进游标）。
fn split_by_characters(text: &str, max_tokens: usize, snap_boundaries: bool) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let max_tokens = max_tokens.max(1);
    let chars: Vec<char> = text.chars().collect();
    let mut segments = Vec::new();

    let mut start = 0usize;
    while start < chars.len() {
        // 二分搜索最大的 end 使 estimate_tokens(chars[start..end]) <= max_tokens。
        // estimate_tokens 对前缀扩展单调不减，二分成立。
        let mut lo = start + 1;
        let mut hi = chars.len();
        let mut best = start + 1; // 即使单字符超预算也至少前进 1，保证终止
        while lo <= hi {
            let mid = lo + (hi - lo) / 2;
            let candidate: String = chars[start..mid].iter().collect();
            if estimate_tokens(&candidate) <= max_tokens {
                best = mid;
                lo = mid + 1;
            } else if mid <= start + 1 {
                break;
            } else {
                hi = mid - 1;
            }
        }

        let mut end = best;
        if snap_boundaries && end < chars.len() {
            end = snap_cut_to_boundary(&chars, start, end);
        }
        debug_assert!(end > start, "split_by_characters 必须每轮前进");

        let segment: String = chars[start..end].iter().collect();
        if !segment.trim().is_empty() {
            segments.push(segment);
        }
        start = end;
    }

    segments
}

/// 规则边界吸附（"semantic-ish" snap，**非 LLM 定界**）。
///
/// 在硬切点 `hard_end` 前的窗口（约本段长度的 20%，至少 16 字符）内，
/// 按优先级向后搜索更自然的切点：
/// 1. 段落边界 `\n\n`（切点落在其后，覆盖 Markdown 标题行前的空行）；
/// 2. 单个换行；
/// 3. 句末标点（。！？.!?，切点落在标点后）；
/// 4. 任意空白。
///
/// 找不到边界或本段太短（<32 字符）则维持硬切点。返回值保证 `> start`
/// 且 `<= hard_end`（只会把切点前移，不会扩大分段，因此不破坏 token 预算）。
fn snap_cut_to_boundary(chars: &[char], start: usize, hard_end: usize) -> usize {
    let len = hard_end - start;
    if len < 32 {
        return hard_end;
    }
    let window = (len / 5).max(16).min(len - 1);
    let min_cut = hard_end - window;

    // 1) 段落边界 "\n\n"：切点在第二个换行之后
    let mut i = hard_end;
    while i > min_cut {
        if chars[i - 1] == '\n' && i >= start + 2 && chars[i - 2] == '\n' {
            return i;
        }
        i -= 1;
    }
    // 2) 单个换行：切点在换行之后
    for i in (min_cut..hard_end).rev() {
        if chars[i] == '\n' {
            return i + 1;
        }
    }
    // 3) 句末标点：切点在标点之后
    for i in (min_cut..hard_end).rev() {
        if SENTENCE_ENDS.contains(&chars[i]) {
            return i + 1;
        }
    }
    // 4) 任意空白
    for i in (min_cut..hard_end).rev() {
        if chars[i].is_whitespace() {
            return i + 1;
        }
    }
    hard_end
}

/// 带重叠的文档分段。
///
/// 先做无重叠基础分段，再给每个分段注入相邻分段的边界上下文
/// （前段尾部 → 本段前缀，后段头部 → 本段后缀），并在超预算时按
/// 后缀 → 前缀 → 正文 的顺序裁剪，保证每段不超 `max_tokens_per_segment`。
fn segment_with_overlap(
    content: &str,
    max_tokens_per_segment: usize,
    overlap_size: usize,
    snap_boundaries: bool,
) -> Result<Vec<String>, AppError> {
    // 首先进行无重叠分段
    let base_segments = segment_without_overlap(content, max_tokens_per_segment, snap_boundaries)?;

    // 如果只有一个分段，不需要重叠
    if base_segments.len() <= 1 {
        return Ok(base_segments);
    }

    println!(
        "[DOCUMENT_DEBUG] 应用重叠策略，基础分段数: {}",
        base_segments.len()
    );

    let mut overlapped_segments = Vec::new();

    for (i, segment) in base_segments.iter().enumerate() {
        let mut core_segment = segment.clone();
        let mut base_tokens = estimate_tokens(&core_segment);
        let mut prefix_insert = String::new();
        let mut prefix_tokens: usize = 0;

        if i > 0 {
            let prev_segment = &base_segments[i - 1];
            if let Some(overlap_prefix) = get_overlap_suffix(prev_segment, overlap_size) {
                let allowed = max_tokens_per_segment.saturating_sub(base_tokens);
                if allowed > 0 {
                    let prefix_candidate = overlap_prefix.trim_end().to_string();
                    let candidate_tokens = estimate_tokens(&prefix_candidate);
                    let trimmed_prefix = if candidate_tokens > allowed {
                        let trimmed = take_suffix_with_token_limit(&prefix_candidate, allowed);
                        println!(
                            "[DOCUMENT_DEBUG] 分段{}前重叠裁剪: 原{}tokens → 裁剪后{}tokens (限制 {})",
                            i + 1,
                            candidate_tokens,
                            estimate_tokens(&trimmed),
                            allowed
                        );
                        trimmed
                    } else {
                        prefix_candidate
                    };
                    let trimmed_tokens = estimate_tokens(&trimmed_prefix);
                    if trimmed_tokens > 0 && !trimmed_prefix.is_empty() {
                        prefix_tokens = trimmed_tokens;
                        prefix_insert = trimmed_prefix;
                        println!(
                            "[DOCUMENT_DEBUG] 分段{}添加前重叠: {}字符 ({}tokens)",
                            i + 1,
                            prefix_insert.len(),
                            prefix_tokens
                        );
                    }
                }
            }
        }

        let mut suffix_insert = String::new();
        let mut suffix_tokens: usize = 0;

        if i < base_segments.len() - 1 {
            let next_segment = &base_segments[i + 1];
            if let Some(overlap_suffix) = get_overlap_prefix(next_segment, overlap_size) {
                let allowed = max_tokens_per_segment
                    .saturating_sub(base_tokens.saturating_add(prefix_tokens));
                if allowed > 0 {
                    let suffix_candidate = overlap_suffix.trim_start().to_string();
                    let candidate_tokens = estimate_tokens(&suffix_candidate);
                    let trimmed_suffix = if candidate_tokens > allowed {
                        let trimmed = take_prefix_with_token_limit(&suffix_candidate, allowed);
                        println!(
                            "[DOCUMENT_DEBUG] 分段{}后重叠裁剪: 原{}tokens → 裁剪后{}tokens (限制 {})",
                            i + 1,
                            candidate_tokens,
                            estimate_tokens(&trimmed),
                            allowed
                        );
                        trimmed
                    } else {
                        suffix_candidate
                    };
                    let trimmed_tokens = estimate_tokens(&trimmed_suffix);
                    if trimmed_tokens > 0 && !trimmed_suffix.is_empty() {
                        suffix_tokens = trimmed_tokens;
                        suffix_insert = trimmed_suffix;
                        println!(
                            "[DOCUMENT_DEBUG] 分段{}添加后重叠: {}字符 ({}tokens)",
                            i + 1,
                            suffix_insert.len(),
                            suffix_tokens
                        );
                    }
                }
            }
        }

        let mut combined_tokens = base_tokens
            .saturating_add(prefix_tokens)
            .saturating_add(suffix_tokens);
        if combined_tokens > max_tokens_per_segment {
            println!(
                "[DOCUMENT_DEBUG] 分段{}重叠后超出限制: {} > {}，开始裁剪",
                i + 1,
                combined_tokens,
                max_tokens_per_segment
            );
            if suffix_tokens > 0 {
                let allowed_for_suffix = max_tokens_per_segment
                    .saturating_sub(base_tokens.saturating_add(prefix_tokens));
                if allowed_for_suffix == 0 {
                    suffix_insert.clear();
                    suffix_tokens = 0;
                } else if suffix_tokens > allowed_for_suffix {
                    suffix_insert =
                        take_prefix_with_token_limit(&suffix_insert, allowed_for_suffix);
                    suffix_tokens = estimate_tokens(&suffix_insert);
                }
            }
            combined_tokens = base_tokens
                .saturating_add(prefix_tokens)
                .saturating_add(suffix_tokens);

            if combined_tokens > max_tokens_per_segment && prefix_tokens > 0 {
                let allowed_for_prefix = max_tokens_per_segment
                    .saturating_sub(base_tokens.saturating_add(suffix_tokens));
                if allowed_for_prefix == 0 {
                    prefix_insert.clear();
                    prefix_tokens = 0;
                } else if prefix_tokens > allowed_for_prefix {
                    prefix_insert =
                        take_suffix_with_token_limit(&prefix_insert, allowed_for_prefix);
                    prefix_tokens = estimate_tokens(&prefix_insert);
                }
            }
            combined_tokens = base_tokens
                .saturating_add(prefix_tokens)
                .saturating_add(suffix_tokens);

            if combined_tokens > max_tokens_per_segment {
                let allowed_for_base = max_tokens_per_segment
                    .saturating_sub(prefix_tokens.saturating_add(suffix_tokens));
                if allowed_for_base == 0 {
                    core_segment.clear();
                    base_tokens = 0;
                } else if base_tokens > allowed_for_base {
                    core_segment = take_prefix_with_token_limit(&core_segment, allowed_for_base);
                    base_tokens = estimate_tokens(&core_segment);
                }
            }
            combined_tokens = base_tokens
                .saturating_add(prefix_tokens)
                .saturating_add(suffix_tokens);

            if combined_tokens > max_tokens_per_segment && suffix_tokens > 0 {
                suffix_insert.clear();
                combined_tokens = base_tokens.saturating_add(prefix_tokens);
            }
            if combined_tokens > max_tokens_per_segment && prefix_tokens > 0 {
                prefix_insert.clear();
                combined_tokens = base_tokens;
            }
            if combined_tokens > max_tokens_per_segment {
                core_segment = take_prefix_with_token_limit(&core_segment, max_tokens_per_segment);
                base_tokens = estimate_tokens(&core_segment);
                combined_tokens = base_tokens;
            }
            println!(
                "[DOCUMENT_DEBUG] 分段{}裁剪后 token={}",
                i + 1,
                combined_tokens
            );
        }

        let mut parts: Vec<String> = Vec::new();
        if !prefix_insert.is_empty() {
            parts.push(prefix_insert.trim_end().to_string());
        }
        if !core_segment.is_empty() {
            parts.push(core_segment.clone());
        }
        if !suffix_insert.is_empty() {
            parts.push(suffix_insert.trim_start().to_string());
        }
        let final_segment = parts.join("\n\n");
        let final_tokens = estimate_tokens(&final_segment);
        if final_tokens > max_tokens_per_segment {
            println!(
                "[DOCUMENT_DEBUG] 分段{}最终兜底裁剪: {} > {}",
                i + 1,
                final_tokens,
                max_tokens_per_segment
            );
            let adjusted = take_prefix_with_token_limit(&final_segment, max_tokens_per_segment);
            overlapped_segments.push(adjusted);
        } else {
            overlapped_segments.push(final_segment);
        }
    }

    println!(
        "[DOCUMENT_DEBUG] 重叠处理完成，最终分段数: {}",
        overlapped_segments.len()
    );
    Ok(overlapped_segments)
}

/// 取不超过 `max_tokens` 的最长前缀（按 char 边界，绝不切坏字符）。
fn take_prefix_with_token_limit(text: &str, max_tokens: usize) -> String {
    if max_tokens == 0 || text.is_empty() {
        return String::new();
    }
    let mut result = String::new();
    for ch in text.chars() {
        result.push(ch);
        if estimate_tokens(&result) > max_tokens {
            result.pop();
            break;
        }
    }
    while !result.is_empty() && estimate_tokens(&result) > max_tokens {
        result.pop();
    }
    result
}

/// 取不超过 `max_tokens` 的最长后缀（按 char 边界，绝不切坏字符）。
fn take_suffix_with_token_limit(text: &str, max_tokens: usize) -> String {
    if max_tokens == 0 || text.is_empty() {
        return String::new();
    }
    let mut collected: Vec<char> = Vec::new();
    for ch in text.chars().rev() {
        collected.push(ch);
        let candidate: String = collected.iter().rev().collect();
        if estimate_tokens(&candidate) > max_tokens {
            collected.pop();
            break;
        }
    }
    collected.reverse();
    let mut result: String = collected.into_iter().collect();
    while !result.is_empty() && estimate_tokens(&result) > max_tokens {
        let mut iter = result.chars();
        iter.next();
        result = iter.collect();
    }
    result
}

/// 将字节索引转换为字符索引。
///
/// `byte_index` 必须来自对同一字符串的 `find`/`rfind`（即落在字符边界上）。
/// 修复：旧实现对空字符串会 `0 - 1` 下溢 panic，现在用 saturating_sub 兜底。
fn byte_index_to_char_index(text: &str, byte_index: usize) -> usize {
    text.char_indices()
        .take_while(|(i, _)| *i <= byte_index)
        .count()
        .saturating_sub(1)
}

/// 计算相邻段可借用的最大重叠字符数。
///
/// 修复「重复 overlap」bug：旧实现在邻段长度 ≤ overlap_size 时直接返回整个邻段，
/// 两个短分段会互相完整包含对方（内容成倍重复 → 重复制卡）。
/// 现在重叠上限还受"邻段字符数的一半"约束，保证重叠只是边界上下文而非整段复制。
fn effective_overlap_chars(neighbor_char_count: usize, max_chars: usize) -> usize {
    max_chars.min(neighbor_char_count / 2)
}

/// 获取文本的前缀（用于重叠：作为上一段的后缀上下文）。
fn get_overlap_prefix(text: &str, max_chars: usize) -> Option<String> {
    let char_count = text.chars().count();
    let max_chars = effective_overlap_chars(char_count, max_chars);
    if max_chars == 0 {
        return None;
    }

    // 安全地获取前缀（按字符数而非字节数）
    let prefix: String = text.chars().take(max_chars).collect();

    // 尝试在句子边界处截断
    if let Some(last_sentence_end_bytes) = prefix.rfind(&SENTENCE_ENDS[..]) {
        let last_sentence_end_chars = byte_index_to_char_index(&prefix, last_sentence_end_bytes);
        if last_sentence_end_chars > max_chars / 2 {
            // 确保不会截断太多
            return Some(prefix.chars().take(last_sentence_end_chars + 1).collect());
        }
    }

    // 尝试在段落边界处截断
    if let Some(last_paragraph_end_bytes) = prefix.rfind("\n\n") {
        let last_paragraph_end_chars = byte_index_to_char_index(&prefix, last_paragraph_end_bytes);
        if last_paragraph_end_chars > max_chars / 2 {
            return Some(prefix.chars().take(last_paragraph_end_chars).collect());
        }
    }

    // 尝试在词边界处截断
    if let Some(last_space_bytes) = prefix.rfind(' ') {
        let last_space_chars = byte_index_to_char_index(&prefix, last_space_bytes);
        if last_space_chars > max_chars / 2 {
            return Some(prefix.chars().take(last_space_chars).collect());
        }
    }

    // 最后选择：直接返回安全截断的前缀
    Some(prefix)
}

/// 获取文本的后缀（用于重叠：作为下一段的前缀上下文）。
fn get_overlap_suffix(text: &str, max_chars: usize) -> Option<String> {
    let char_count = text.chars().count();
    let max_chars = effective_overlap_chars(char_count, max_chars);
    if max_chars == 0 {
        return None;
    }

    // 安全地获取后缀（按字符数而非字节数）
    let suffix: String = text.chars().skip(char_count - max_chars).collect();

    // 尝试在句子边界处开始
    if let Some(first_sentence_start_bytes) = suffix.find(&SENTENCE_ENDS[..]) {
        let first_sentence_start_chars =
            byte_index_to_char_index(&suffix, first_sentence_start_bytes);
        let remaining: String = suffix
            .chars()
            .skip(first_sentence_start_chars + 1)
            .collect();
        if remaining.chars().count() > max_chars / 2 {
            // 确保不会截断太多
            return Some(remaining.trim().to_string());
        }
    }

    // 尝试在段落边界处开始
    if let Some(first_paragraph_start_bytes) = suffix.find("\n\n") {
        let first_paragraph_start_chars =
            byte_index_to_char_index(&suffix, first_paragraph_start_bytes);
        let remaining: String = suffix
            .chars()
            .skip(first_paragraph_start_chars + 2)
            .collect();
        if remaining.chars().count() > max_chars / 2 {
            return Some(remaining.to_string());
        }
    }

    // 尝试在词边界处开始
    if let Some(first_space_bytes) = suffix.find(' ') {
        let first_space_chars = byte_index_to_char_index(&suffix, first_space_bytes);
        let remaining: String = suffix.chars().skip(first_space_chars + 1).collect();
        if remaining.chars().count() > max_chars / 2 {
            return Some(remaining.to_string());
        }
    }

    // 最后选择：直接返回安全截断的后缀
    Some(suffix)
}

fn distribute_global_max_cards(total: i32, segments: usize) -> Vec<i32> {
    if segments == 0 {
        return Vec::new();
    }
    if total <= 0 {
        return vec![0; segments];
    }
    let total_usize = total as usize;
    let base = total_usize / segments;
    let remainder = total_usize % segments;
    (0..segments)
        .map(|idx| {
            let extra = if idx < remainder { 1 } else { 0 };
            (base + extra) as i32
        })
        .collect()
}

// =====================================================================
// 单元测试
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造测试用的最小 AnkiGenerationOptions。
    /// 通过 serde 反序列化构造：新增 `#[serde(default)]` 字段不会破坏本测试。
    fn test_options(overlap: u32) -> AnkiGenerationOptions {
        serde_json::from_value(serde_json::json!({
            "deck_name": "Default",
            "note_type": "Basic",
            "enable_images": false,
            "max_cards_per_mistake": 10,
            "segment_overlap_size": overlap,
        }))
        .expect("构造测试 AnkiGenerationOptions 失败")
    }

    /// 生成超过默认 10k token 预算的多段落中文文档。
    /// 每个段落带唯一编号标记，方便检测重复/丢失。
    fn build_long_paragraph_doc(paragraphs: usize, chars_per_paragraph: usize) -> Vec<String> {
        (0..paragraphs)
            .map(|i| {
                let marker = format!("知识点编号{:03}的内容", i);
                let mut p = String::new();
                while p.chars().count() < chars_per_paragraph {
                    p.push_str(&marker);
                }
                p
            })
            .collect()
    }

    // ---------------- token 估算：钉住权威规则 ----------------

    #[test]
    fn estimate_tokens_pinned_values() {
        // 空串 → 0
        assert_eq!(estimate_tokens(""), 0);
        // 纯英文: 11 字符, 2 词, 0 汉字 → floor(2*1.3)=2 + floor(11*0.2)=2 = 4
        assert_eq!(estimate_tokens("hello world"), 4);
        // 纯中文: 4 汉字 + 1 词 → 4 + floor(1.3)=1 = 5
        assert_eq!(estimate_tokens("你好世界"), 5);
        // 混合: "你好, world! 😀" → 2 汉字 + floor(3*1.3)=3 + floor(10*0.2)=2 = 7
        assert_eq!(estimate_tokens("你好, world! 😀"), 7);
        // 下限规则: 长串无空白 ASCII → max(公式值, 字符数/4)
        let s = "a".repeat(100);
        // 公式: 0 + floor(1*1.3)=1 + floor(100*0.2)=20 = 21; 下限 100/4=25 → 25
        assert_eq!(estimate_tokens(&s), 25);
    }

    /// 钉住与 token_budget.rs 的已知口径差异（模块注释中声明为可接受）。
    /// 若两边任何一侧改公式导致此测试失败，必须重新审视模块注释中的权威规则说明。
    #[test]
    fn estimate_tokens_diverges_from_token_budget() {
        let text = "hello world";
        let ours = estimate_tokens(text);
        let budget = crate::utils::token_budget::estimate_tokens(text);
        assert_eq!(ours, 4);
        assert_eq!(budget, 3); // token_budget: 10*0.25 + 0.05 ≈ 2.55 → round 3
        assert_ne!(
            ours, budget,
            "两套估算口径当前不同且已被文档接受；若变为一致请更新模块注释"
        );
    }

    #[test]
    fn estimate_tokens_monotonic_over_prefixes() {
        // split_by_characters 的二分搜索依赖前缀单调性，钉住该性质
        let text = "混合mixed内容123，标点。emoji😀和space word尾部";
        let chars: Vec<char> = text.chars().collect();
        let mut prev = 0usize;
        for end in 1..=chars.len() {
            let prefix: String = chars[..end].iter().collect();
            let t = estimate_tokens(&prefix);
            assert!(t >= prev, "前缀扩展时 token 估算必须单调不减");
            prev = t;
        }
    }

    // ---------------- 每段预算计算 ----------------

    #[test]
    fn max_tokens_per_segment_default_and_derived() {
        // 未设置 → 默认 10k
        let opts = test_options(200);
        assert_eq!(calculate_max_tokens_per_segment(&opts), 10_000);

        // 很大的 max_tokens 不影响默认值
        let mut opts = test_options(200);
        opts.max_tokens = Some(50_000);
        assert_eq!(calculate_max_tokens_per_segment(&opts), 10_000);

        // 较小的 max_tokens → 取一半
        let mut opts = test_options(200);
        opts.max_tokens = Some(8_000);
        assert_eq!(calculate_max_tokens_per_segment(&opts), 4_000);

        // override 优先于 max_tokens
        let mut opts = test_options(200);
        opts.max_tokens = Some(8_000);
        opts.max_output_tokens_override = Some(2_000);
        assert_eq!(calculate_max_tokens_per_segment(&opts), 1_000);
    }

    #[test]
    fn max_tokens_per_segment_zero_is_clamped() {
        // 修复钉住：max_tokens=0 时旧实现返回 0 → 下游死循环；现在钳制到下限
        let mut opts = test_options(200);
        opts.max_tokens = Some(0);
        assert_eq!(
            calculate_max_tokens_per_segment(&opts),
            MIN_TOKENS_PER_SEGMENT
        );
        let mut opts = test_options(200);
        opts.max_output_tokens_override = Some(1);
        assert_eq!(
            calculate_max_tokens_per_segment(&opts),
            MIN_TOKENS_PER_SEGMENT
        );
    }

    // ---------------- 基本形态：空文档 / 短文档 ----------------

    #[test]
    fn empty_document_returns_single_segment() {
        let opts = test_options(200);
        let segments = segment_document("", &opts).expect("空文档不应报错");
        assert_eq!(segments, vec!["".to_string()]);
    }

    #[test]
    fn whitespace_only_document_returns_single_segment() {
        let opts = test_options(200);
        let content = "   \n\n  \t \n ";
        let segments = segment_document(content, &opts).expect("纯空白文档不应报错");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0], content);
    }

    #[test]
    fn short_document_is_not_segmented() {
        let opts = test_options(200);
        let content = "第一段内容。\n\n第二段内容。";
        let segments = segment_document(content, &opts).expect("短文档分段失败");
        assert_eq!(segments, vec![content.to_string()]);
    }

    // ---------------- 10k token 默认预算切分 ----------------

    #[test]
    fn long_document_splits_within_10k_budget() {
        let opts = test_options(0);
        // 10 段 × 3000 汉字 ≈ 30k tokens → 至少 3 段
        let paragraphs = build_long_paragraph_doc(10, 3000);
        let content = paragraphs.join("\n\n");
        let segments = segment_document(&content, &opts).expect("长文档分段失败");
        assert!(
            segments.len() >= 3,
            "约 30k tokens 的文档应切成至少 3 段，实际 {} 段",
            segments.len()
        );
        for (i, seg) in segments.iter().enumerate() {
            let t = estimate_tokens(seg);
            assert!(t <= 10_000, "分段{}估算 {} tokens 超过 10k 预算", i + 1, t);
            assert!(!seg.trim().is_empty(), "分段{}为空白", i + 1);
        }
    }

    // ---------------- 段落边界优先 ----------------

    #[test]
    fn paragraph_boundaries_are_preferred() {
        let opts = test_options(0);
        let paragraphs = build_long_paragraph_doc(8, 3000);
        let content = paragraphs.join("\n\n");
        let segments = segment_document(&content, &opts).expect("分段失败");
        assert!(segments.len() > 1);
        // 每个分段必须由完整段落拼接而成（overlap=0 且单段落未超预算）
        for seg in &segments {
            for part in seg.split("\n\n") {
                assert!(
                    paragraphs.iter().any(|p| p == part),
                    "分段中出现被切碎的段落: {}...",
                    part.chars().take(30).collect::<String>()
                );
            }
        }
        // 所有段落都被覆盖且各出现一次（无重叠时不得重复、不得丢失）
        let joined = segments.join("\n\n");
        for p in &paragraphs {
            assert_eq!(
                joined.matches(p.as_str()).count(),
                1,
                "overlap=0 时每个段落应恰好出现一次"
            );
        }
    }

    // ---------------- overlap = 200（ChatAnki 普通材料默认值） ----------------

    #[test]
    fn overlap_200_adjacent_segments_share_boundary_context() {
        let opts = test_options(200);
        let paragraphs = build_long_paragraph_doc(10, 3000);
        let content = paragraphs.join("\n\n");
        let segments = segment_document(&content, &opts).expect("分段失败");
        assert!(segments.len() > 1);
        // 相邻分段之间必须共享边界上下文：
        // 分段 i 的尾部包含分段 i+1 正文的开头（后重叠），
        // 分段 i+1 的头部包含分段 i 正文的结尾（前重叠）。
        for w in segments.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            let shared = longest_shared_window(a, b, 80);
            assert!(
                shared,
                "overlap=200 时相邻分段应共享至少 80 字符的边界上下文"
            );
        }
        // 重叠不得导致超预算
        for seg in &segments {
            assert!(estimate_tokens(seg) <= 10_000);
        }
    }

    /// 判断 b 中是否存在长度为 window 的子串也出现在 a 中。
    fn longest_shared_window(a: &str, b: &str, window: usize) -> bool {
        let b_chars: Vec<char> = b.chars().collect();
        if b_chars.len() < window {
            return a.contains(b);
        }
        // 只需检查 b 的前 600 字符（重叠上下文注入在分段头部）
        let scan = b_chars.len().min(600);
        for start in 0..=(scan.saturating_sub(window)) {
            let candidate: String = b_chars[start..start + window].iter().collect();
            if a.contains(&candidate) {
                return true;
            }
        }
        false
    }

    // ---------------- overlap = 0（ChatAnki 词汇表模式） ----------------

    #[test]
    fn glossary_overlap_0_produces_no_duplication() {
        let opts = test_options(0);
        // 模拟 ChatAnki normalize_glossary_paragraphs 之后的词汇表：条目以 \n\n 分隔
        let entries: Vec<String> = (0..120)
            .map(|i| {
                format!(
                    "{}. 术语{:03}：{}",
                    i + 1,
                    i,
                    format!("这是术语{:03}的详细解释内容", i).repeat(12)
                )
            })
            .collect();
        let content = entries.join("\n\n");
        assert!(estimate_tokens(&content) > 10_000, "测试语料必须超过预算");
        let segments = segment_document(&content, &opts).expect("分段失败");
        assert!(segments.len() > 1);
        let joined = segments.join("\n\n");
        // overlap=0：每个条目恰好出现一次（不重复 → 不会重复制卡；不丢失）
        for (i, _) in entries.iter().enumerate() {
            let marker = format!("术语{:03}：", i);
            assert_eq!(
                joined.matches(&marker).count(),
                1,
                "词汇表条目 {} 在 overlap=0 时应恰好出现一次",
                i
            );
        }
    }

    // ---------------- 超长单段（句子切分路径） ----------------

    #[test]
    fn oversized_single_paragraph_is_split_by_sentences() {
        let opts = test_options(0);
        // 单个段落（无 \n\n），由大量带句号的句子组成，总量 > 10k tokens
        let mut paragraph = String::new();
        for i in 0..1500 {
            paragraph.push_str(&format!("这是第{}个完整句子的内容表述。", i));
        }
        assert!(estimate_tokens(&paragraph) > 10_000);
        let segments = segment_document(&paragraph, &opts).expect("分段失败");
        assert!(segments.len() > 1);
        for seg in &segments {
            assert!(estimate_tokens(seg) <= 10_000);
            // 句子切分路径下每段应以句末标点收尾（不会把句子拦腰切断）
            let last = seg.chars().last().expect("分段非空");
            assert!(
                SENTENCE_ENDS.contains(&last),
                "句子切分产生的分段应以句末标点结尾，实际结尾: {:?}",
                last
            );
        }
    }

    // ---------------- CJK / emoji 硬切不坏字符、无损 ----------------

    #[test]
    fn forced_char_split_preserves_cjk_and_emoji() {
        // 单个"句子"（无任何句末标点/空白）強制走 split_by_characters
        let unit = "汉字テスト한글😀🚀内容";
        let mut text = String::new();
        while estimate_tokens(&text) < 25_000 {
            text.push_str(unit);
        }
        let segments = split_by_characters(&text, 10_000, false);
        assert!(segments.len() > 1);
        // 1) 无损：拼接后与原文逐字节一致（该输入无纯空白块）
        assert_eq!(segments.concat(), text, "硬切必须无损且不切坏任何字符");
        // 2) 每段都是合法 UTF-8（String 类型保证）且非空
        for seg in &segments {
            assert!(!seg.is_empty());
            // 3) 不超预算（修复了旧实现 CJK 约 2 倍超预算的 bug）
            assert!(
                estimate_tokens(seg) <= 10_000,
                "硬切分段超预算: {} tokens",
                estimate_tokens(seg)
            );
        }
    }

    #[test]
    fn forced_char_split_zero_budget_terminates() {
        // 修复钉住：旧实现 max_tokens=0 → max_chars=0 → 死循环
        let text = "abc汉字😀";
        let segments = split_by_characters(text, 0, false);
        assert!(!segments.is_empty());
        assert_eq!(segments.concat(), text);
    }

    // ---------------- 边界吸附（enable_llm_boundary_detection） ----------------

    /// 构造一个无句末标点、每 200 字符插入一个换行的超长"单句"。
    fn build_newline_riddled_run() -> String {
        let mut text = String::new();
        let filler = "连续内容没有句读符号只有逗号，";
        let mut chars_since_newline = 0usize;
        while estimate_tokens(&text) < 25_000 {
            text.push_str(filler);
            chars_since_newline += filler.chars().count();
            if chars_since_newline >= 200 {
                text.push('\n');
                chars_since_newline = 0;
            }
        }
        text
    }

    #[test]
    fn boundary_snap_enabled_cuts_at_natural_boundaries() {
        let text = build_newline_riddled_run();
        let segments = split_by_characters(&text, 10_000, true);
        assert!(segments.len() > 1);
        // 除最后一段外，吸附后的切点应落在换行边界（段以 '\n' 收尾）
        for seg in &segments[..segments.len() - 1] {
            let last = seg.chars().last().unwrap();
            assert_eq!(
                last, '\n',
                "开启边界吸附后硬切点应吸附到换行边界，实际结尾: {:?}",
                last
            );
        }
        // 吸附只前移切点，不得超预算
        for seg in &segments {
            assert!(estimate_tokens(seg) <= 10_000);
        }
    }

    #[test]
    fn boundary_snap_disabled_keeps_hard_cut() {
        let text = build_newline_riddled_run();
        let segments = split_by_characters(&text, 10_000, false);
        assert!(segments.len() > 1);
        // 未开启吸附时，硬切点按 token 预算落点，几乎不可能恰好全部落在换行上
        let non_newline_endings = segments[..segments.len() - 1]
            .iter()
            .filter(|seg| seg.chars().last() != Some('\n'))
            .count();
        assert!(
            non_newline_endings > 0,
            "关闭吸附时应存在非换行结尾的硬切分段"
        );
    }

    #[test]
    fn segment_document_reads_llm_boundary_flag() {
        // 端到端验证：通过 options 传入开关（而不是直接调 split_by_characters）
        let mut opts = test_options(0);
        opts.enable_llm_boundary_detection = Some(true);
        let text = build_newline_riddled_run();
        let segments = segment_document(&text, &opts).expect("分段失败");
        assert!(segments.len() > 1);
        // segment_without_overlap 会 trim 每段；验证切点吸附体现在段尾完整性上：
        // 每个非末尾分段的结尾字符应是内容字符（逗号前的完整汉字或逗号），
        // 且拼接后不缺失任何内容字符（换行/空白 trim 掉属预期）。
        let strip_ws = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        assert_eq!(strip_ws(&segments.concat()), strip_ws(&text));
    }

    #[test]
    fn snap_cut_prefers_paragraph_over_sentence() {
        // 窗口内同时存在 \n\n、\n 与句号时，优先段落边界
        let mut chars: Vec<char> = "内容".repeat(100).chars().collect(); // 200 字符
        chars[150] = '。';
        chars[170] = '\n';
        chars[171] = '\n';
        let hard_end = 200;
        let cut = snap_cut_to_boundary(&chars, 0, hard_end);
        assert_eq!(cut, 172, "应吸附到 \\n\\n 之后");
        // 只有句号时吸附到句号后
        let mut chars2: Vec<char> = "内容".repeat(100).chars().collect();
        chars2[180] = '。';
        let cut2 = snap_cut_to_boundary(&chars2, 0, hard_end);
        assert_eq!(cut2, 181, "应吸附到句末标点之后");
        // 无任何边界时维持硬切点
        let chars3: Vec<char> = "内容".repeat(100).chars().collect();
        assert_eq!(snap_cut_to_boundary(&chars3, 0, hard_end), hard_end);
    }

    // ---------------- 重叠不整段复制（重复 overlap 修复） ----------------

    #[test]
    fn overlap_does_not_fully_duplicate_short_neighbor() {
        // 邻段只有 60 字符而 overlap=200：旧实现会把整个邻段复制进来
        let short_neighbor = "短段落内容".repeat(12); // 60 字符
        let suffix = get_overlap_suffix(&short_neighbor, 200);
        if let Some(s) = &suffix {
            assert!(
                s.chars().count() <= short_neighbor.chars().count() / 2,
                "重叠最多借用邻段一半内容，实际 {} / {}",
                s.chars().count(),
                short_neighbor.chars().count()
            );
        }
        let prefix = get_overlap_prefix(&short_neighbor, 200);
        if let Some(p) = &prefix {
            assert!(p.chars().count() <= short_neighbor.chars().count() / 2);
        }
        // 空邻段/1字符邻段 → 不产生重叠（而不是 panic 或整段复制）
        assert_eq!(get_overlap_suffix("", 200), None);
        assert_eq!(get_overlap_prefix("字", 200), None);
    }

    // ---------------- 空段防御 ----------------

    #[test]
    fn no_empty_segments_for_whitespace_heavy_document() {
        let opts = test_options(200);
        let paragraphs = build_long_paragraph_doc(8, 3000);
        // 段落之间夹杂纯空白"段落"
        let content = paragraphs.join("\n\n   \n\n\t\n\n");
        let segments = segment_document(&content, &opts).expect("分段失败");
        assert!(segments.len() > 1);
        for (i, seg) in segments.iter().enumerate() {
            assert!(!seg.trim().is_empty(), "分段{}是空白段", i + 1);
        }
    }

    // ---------------- 前后缀 token 截取工具 ----------------

    #[test]
    fn take_prefix_and_suffix_respect_token_limit_and_char_boundaries() {
        let text = "你好世界hello world😀日本語テキスト";
        for limit in [0usize, 1, 3, 5, 8, 100] {
            let prefix = take_prefix_with_token_limit(text, limit);
            assert!(estimate_tokens(&prefix) <= limit);
            assert!(text.starts_with(&prefix), "前缀必须落在字符边界上");
            let suffix = take_suffix_with_token_limit(text, limit);
            assert!(estimate_tokens(&suffix) <= limit);
            assert!(text.ends_with(&suffix), "后缀必须落在字符边界上");
        }
        // limit 足够大时应取全文
        assert_eq!(take_prefix_with_token_limit(text, 1000), text);
        assert_eq!(take_suffix_with_token_limit(text, 1000), text);
    }

    #[test]
    fn byte_index_to_char_index_handles_multibyte_and_empty() {
        let text = "a。b😀c";
        // rfind('。') 的字节索引应映射回字符索引 1
        let byte_idx = text.rfind('。').unwrap();
        assert_eq!(byte_index_to_char_index(text, byte_idx), 1);
        let emoji_idx = text.find('😀').unwrap();
        assert_eq!(byte_index_to_char_index(text, emoji_idx), 3);
        // 修复钉住：空串不再下溢 panic
        assert_eq!(byte_index_to_char_index("", 0), 0);
    }

    // ---------------- 卡片总额度分配 ----------------

    #[test]
    fn distribute_global_max_cards_cases() {
        assert_eq!(distribute_global_max_cards(10, 3), vec![4, 3, 3]);
        assert_eq!(distribute_global_max_cards(3, 3), vec![1, 1, 1]);
        assert_eq!(distribute_global_max_cards(2, 4), vec![1, 1, 0, 0]);
        assert_eq!(distribute_global_max_cards(0, 3), vec![0, 0, 0]);
        assert_eq!(distribute_global_max_cards(-5, 2), vec![0, 0]);
        assert_eq!(distribute_global_max_cards(5, 0), Vec::<i32>::new());
        // 总量守恒
        let dist = distribute_global_max_cards(103, 7);
        assert_eq!(dist.iter().sum::<i32>(), 103);
    }

    #[tokio::test]
    async fn max_cards_total_distributes_quota_across_persisted_segments() {
        // 0824 评审 #4（多分段额度）：CardAgent 形状的 options
        // （maxCards → max_cards_total）经真实任务创建路径落库后，
        // 每段任务持久化的额度必须来自总额度分配（总和守恒），
        // 而不是每段都拿满 max_cards_per_mistake 导致总数放大。
        let tmp_dir = std::env::temp_dir().join(format!("dstu_quota_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir).unwrap();
        {
            use crate::data_governance::migration::coordinator::MigrationCoordinator;
            use crate::data_governance::schema_registry::DatabaseId;
            let mut coordinator = MigrationCoordinator::new(tmp_dir.clone()).with_audit_db(None);
            coordinator
                .migrate_single(DatabaseId::Mistakes)
                .expect("mistakes migrations");
        }
        let db = std::sync::Arc::new(
            crate::database::Database::new(&tmp_dir.join("mistakes.db")).expect("db"),
        );
        let dps = DocumentProcessingService::new(db);

        // CardAgent 装配形状：maxCards=10 同时写入总额度与单段兜底上限
        let mut options = test_options(0);
        options.max_cards_per_mistake = 10;
        options.max_cards_total = Some(10);

        // 约 3 万 token 的长文档（默认 1 万 token/段预算）→ 必然多段
        let paragraph =
            "细胞呼吸分为糖酵解、丙酮酸氧化脱羧与三羧酸循环三个阶段，各阶段的场所与产物都不相同。"
                .repeat(25);
        let document = vec![paragraph; 30].join("\n\n");

        let (_doc_id, tasks) = dps
            .process_document_and_create_tasks(document, "长文档".to_string(), options)
            .await
            .expect("create tasks");
        assert!(
            tasks.len() >= 3,
            "长文档必须切成多段，实际 {} 段",
            tasks.len()
        );

        let per_segment: Vec<i32> = tasks
            .iter()
            .map(|t| {
                let opts: AnkiGenerationOptions =
                    serde_json::from_str(&t.anki_generation_options_json)
                        .expect("任务级 options 必须可反序列化");
                opts.max_cards_per_mistake
            })
            .collect();
        assert_eq!(
            per_segment.iter().sum::<i32>(),
            10,
            "分段额度总和必须等于 max_cards_total: {per_segment:?}"
        );
        assert!(
            per_segment.iter().all(|limit| *limit < 10),
            "任何单段都不得独占全部额度（否则退化回旧的每段上限语义）: {per_segment:?}"
        );
    }
}
