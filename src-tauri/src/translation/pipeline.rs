use futures_util::StreamExt;
use serde_json::json;
/// 翻译管线 - 核心业务逻辑
use std::sync::Arc;
use std::time::Duration;

use crate::database::Database;
use crate::llm_manager::{build_provider_adapter, ApiConfig, LLMManager};
use crate::models::AppError;
use crate::providers::ProviderAdapter;
// ★ VFS 统一存储（2025-12-07）
use crate::vfs::database::VfsDatabase;

use super::events::{StreamStats, TranslationEventEmitter};
use super::types::{TranslationRequest, TranslationResponse};

/// 翻译管线依赖
pub struct TranslationDeps {
    pub llm: Arc<LLMManager>,
    pub db: Arc<Database>, // 主数据库（配置/设置读取）
    pub emitter: TranslationEventEmitter,
    pub vfs_db: Arc<VfsDatabase>, // ★ VFS 数据库（必需，唯一存储）
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StreamStatus {
    Completed,
    Cancelled,
    /// ★ A6-02：流未收到完成标记（DONE / finish_reason）就结束，结果不完整
    Incomplete,
}

/// 结构化流式失败：携带用户可读消息 + 机器可读错误码 + 是否建议重试。
/// `stream_translate` 对旧调用方（chat_popover）折叠为 AppError；
/// `run_translation` 用它发出结构化 error 事件。
#[derive(Debug, Clone)]
pub(crate) struct StreamFailure {
    pub message: String,
    pub code: String,
    pub retriable: bool,
}

impl StreamFailure {
    fn new(message: impl Into<String>, code: impl Into<String>, retriable: bool) -> Self {
        Self {
            message: message.into(),
            code: code.into(),
            retriable,
        }
    }
}

impl From<AppError> for StreamFailure {
    fn from(e: AppError) -> Self {
        StreamFailure::new(e.to_string(), "internal", false)
    }
}

/// 流式空闲超时：超过该时长未收到任何新 chunk 视为供应商挂起
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// 流式总超时：单次翻译（含自动重试、全部分段）总时长上限
const TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
/// 初次请求失败（429/5xx/网络错误）时的最大尝试次数（1 次原始 + 2 次重试）
const MAX_REQUEST_ATTEMPTS: u32 = 3;
/// 重试退避基数
const RETRY_BACKOFF_BASE: Duration = Duration::from_millis(500);

/// 长文本分段翻译阈值：字符数达到该值才启用分段
const SEGMENTATION_MIN_CHARS: usize = 4_000;
/// 分段目标大小（字符）
const SEGMENT_TARGET_CHARS: usize = 2_000;
/// 段级重试上限（仅在该段尚未产出任何增量时允许重试）
const SEGMENT_MAX_ATTEMPTS: u32 = 2;
/// 段级重试退避
const SEGMENT_RETRY_BACKOFF: Duration = Duration::from_millis(800);
/// 段间上下文延续：上一段译文尾部携带的字符数
const SEGMENT_CONTEXT_TAIL_CHARS: usize = 240;

/// 流式调用可调参数（不同调用场景：standalone 管线 / 划词弹窗 / 多候选）
#[derive(Debug, Clone)]
pub(crate) struct StreamOptions {
    pub temperature: f32,
    /// None 时使用模型配置的默认输出上限
    pub max_tokens: Option<u32>,
    pub idle_timeout: Duration,
    pub total_timeout: Duration,
    pub max_request_attempts: u32,
}

impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            temperature: 0.3,
            max_tokens: None,
            idle_timeout: IDLE_TIMEOUT,
            total_timeout: TOTAL_TIMEOUT,
            max_request_attempts: MAX_REQUEST_ATTEMPTS,
        }
    }
}

/// 运行翻译管线
pub async fn run_translation(
    request: TranslationRequest,
    deps: TranslationDeps,
) -> Result<Option<TranslationResponse>, AppError> {
    // 失败路径统一：emit 结构化 error 事件（供前端流监听方消费），同时返回 Err（invoke reject）
    let session_id = request.session_id.clone();
    let stream_event = format!("translation_stream_{}", session_id);
    let result = run_translation_inner(request, &deps).await;
    // 终局清理取消通道与 registry 兜底标记：完成后到达的迟到 cancel 不会残留
    deps.llm.clear_cancel_artifacts(&stream_event).await;
    match result {
        Ok(v) => Ok(v),
        Err(failure) => {
            deps.emitter.emit_error(
                &session_id,
                failure.message.clone(),
                Some(failure.code.clone()),
                Some(failure.retriable),
            );
            Err(AppError::llm(failure.message))
        }
    }
}

async fn run_translation_inner(
    request: TranslationRequest,
    deps: &TranslationDeps,
) -> Result<Option<TranslationResponse>, StreamFailure> {
    // 0. 输入验证：检查空文本
    if request.text.trim().is_empty() {
        return Err(StreamFailure::new("翻译文本不能为空", "empty_text", false));
    }

    // 0.1 输入验证：检查文本长度（防止超大文本导致 API 超时或 OOM）
    const MAX_TEXT_CHARS: usize = 100_000; // 100K 字符上限
    let text_char_count = request.text.chars().count();
    if text_char_count > MAX_TEXT_CHARS {
        return Err(StreamFailure::new(
            format!(
                "翻译文本过长（当前 {} 字符，最大 {} 字符）",
                text_char_count, MAX_TEXT_CHARS
            ),
            "text_too_long",
            false,
        ));
    }

    // 0.2 auto 模式下启发式检测源语言（供前端「检测到：中文」回显）
    let detected_lang = if request.src_lang == "auto" {
        detect_source_lang(&request.text).map(|s| s.to_string())
    } else {
        None
    };

    // 1. 构造 System Prompt（分段与否共用）
    let system_prompt = build_system_prompt(&request);

    // 2. 获取翻译模型配置并解密 API Key
    let config = deps
        .llm
        .get_translation_model_config()
        .await
        .map_err(StreamFailure::from)?;
    let api_key = deps
        .llm
        .decrypt_api_key(&config.api_key)
        .map_err(StreamFailure::from)?;

    // 3. 长文本智能分段（段落优先，超长段落降级句子切分）
    let segments = if text_char_count >= SEGMENTATION_MIN_CHARS {
        build_segments(&request.text, SEGMENT_TARGET_CHARS)
    } else {
        vec![TextSegment {
            content: request.text.clone(),
            separator: String::new(),
        }]
    };
    let total = segments.len();
    let segmented = total > 1;
    if segmented {
        eprintln!(
            "📑 [Translation] 长文本分段翻译：{} 字符 → {} 段",
            text_char_count, total
        );
    }

    // 4. 逐段流式调用（顺序保证；段级重试；全局统计与 detected_lang 只发一次）
    let mut stats = StreamStats::new();
    let mut first_chunk = true;
    let mut final_parts: Vec<(String, String)> = Vec::with_capacity(total); // (译文, 段后分隔符)
    let stream_event = format!("translation_stream_{}", request.session_id);
    let overall_deadline = tokio::time::Instant::now() + TOTAL_TIMEOUT;

    for (seg_idx, segment) in segments.iter().enumerate() {
        // 段间取消检查（段进行中由 stream_translate_inner 内部处理）
        if deps.llm.consume_pending_cancel(&stream_event).await {
            deps.emitter.emit_cancelled(&request.session_id);
            return Ok(None);
        }

        let seg_info = if segmented {
            Some((seg_idx + 1, total))
        } else {
            None
        };
        let user_prompt = if segmented {
            let prev_tail = final_parts
                .last()
                .map(|(part, _)| tail_chars(part.trim_end(), SEGMENT_CONTEXT_TAIL_CHARS))
                .filter(|t| !t.is_empty());
            build_segment_user_prompt(&request, &segment.content, seg_idx + 1, total, prev_tail)
        } else {
            build_user_prompt(&request, &request.text)
        };

        let mut attempt: u32 = 0;
        let translated = loop {
            attempt += 1;
            let remaining = overall_deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(StreamFailure::new(
                    "翻译总时长超限，请缩短文本或稍后重试",
                    "timeout_total",
                    true,
                ));
            }

            let options = StreamOptions {
                total_timeout: remaining,
                ..StreamOptions::default()
            };
            let mut seg_accum = String::new();
            let status = stream_translate_inner(
                &config,
                &api_key,
                &system_prompt,
                &user_prompt,
                &stream_event,
                deps.llm.clone(),
                &options,
                |chunk| {
                    stats.push_chunk(&chunk);
                    seg_accum.push_str(&chunk);
                    // detected_lang 仅随首个 data 事件下发一次，避免重复 payload
                    let lang = if first_chunk {
                        first_chunk = false;
                        detected_lang.clone()
                    } else {
                        None
                    };
                    deps.emitter
                        .emit_data(&request.session_id, chunk, &stats, lang, seg_info);
                },
            )
            .await;

            let failure = match status {
                Ok(StreamStatus::Cancelled) => {
                    deps.emitter.emit_cancelled(&request.session_id);
                    return Ok(None);
                }
                Ok(StreamStatus::Completed) => {
                    if seg_accum.trim().is_empty() {
                        StreamFailure::new("翻译服务返回空结果，请重试", "empty_result", true)
                    } else {
                        break seg_accum;
                    }
                }
                // ★ A6-02（对齐作文批改 M-064）：流未正常完成时不把部分译文当成完成结果返回
                Ok(StreamStatus::Incomplete) => StreamFailure::new(
                    "翻译流式响应异常中断，结果不完整。请检查网络连接后重试。",
                    "stream_incomplete",
                    true,
                ),
                Err(f) => f,
            };

            // 段级重试：仅当该段尚未向前端发过任何增量（重试不会造成重复输出）
            let can_retry = failure.retriable
                && seg_accum.is_empty()
                && attempt < SEGMENT_MAX_ATTEMPTS
                && tokio::time::Instant::now() < overall_deadline;
            if !can_retry {
                if !seg_accum.is_empty() {
                    eprintln!(
                        "⚠️ [Translation] 段 {}/{} 失败（{}），已产出 {} 字符，不可重试",
                        seg_idx + 1,
                        total,
                        failure.code,
                        seg_accum.chars().count()
                    );
                }
                return Err(failure);
            }
            eprintln!(
                "🔁 [Translation] 段 {}/{} 失败（{}），退避后重试（第 {}/{} 次尝试）",
                seg_idx + 1,
                total,
                failure.code,
                attempt + 1,
                SEGMENT_MAX_ATTEMPTS
            );
            tokio::time::sleep(SEGMENT_RETRY_BACKOFF).await;
        };

        final_parts.push((translated, segment.separator.clone()));

        // 段间分隔符按原文回放（保持段落结构；complete 事件会以规整后全文纠正）
        if segmented && seg_idx + 1 < total && !segment.separator.is_empty() {
            stats.push_chunk(&segment.separator);
            deps.emitter.emit_data(
                &request.session_id,
                segment.separator.clone(),
                &stats,
                None,
                seg_info,
            );
        }
    }

    // 5. 组装权威全文（分段时逐段去尾部空白后按原分隔符拼接；单段保持原始输出）
    let accumulated = if segmented {
        let mut text = String::new();
        let count = final_parts.len();
        for (i, (part, sep)) in final_parts.iter().enumerate() {
            text.push_str(part.trim_end());
            if i + 1 < count {
                text.push_str(sep);
            }
        }
        text
    } else {
        final_parts.pop().map(|(part, _)| part).unwrap_or_default()
    };

    // 🔧 P0-06 修复：移除后端的 VFS 记录创建，由前端统一管理
    // 原因：前端通过 Learning Hub 创建空翻译文件后，后端再创建会导致双写（孤儿记录）
    // 现在只返回翻译结果，前端通过 DSTU adapter 的 updateTranslation 更新记录
    let now = chrono::Utc::now().to_rfc3339();

    // 6. 发送完成事件（不再创建新记录，只返回翻译结果）
    deps.emitter.emit_complete(
        &request.session_id,
        request.session_id.clone(), // 使用 session_id 作为临时 ID，前端会用实际 node ID
        accumulated.clone(),
        now.clone(),
        detected_lang,
    );

    Ok(Some(TranslationResponse {
        id: request.session_id.clone(), // 使用 session_id，前端会忽略此值
        translated_text: accumulated,
        created_at: now,
        session_id: request.session_id,
    }))
}

// ==================== 长文本分段 ====================

/// 文本分段：content 为待翻译内容，separator 为该段与下一段之间的原文分隔符
#[derive(Debug, Clone)]
pub(crate) struct TextSegment {
    pub content: String,
    pub separator: String,
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// 取字符串尾部 n 个字符（char 边界安全）
fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        s.to_string()
    } else {
        s.chars().skip(count - n).collect()
    }
}

/// 段落切分（保留段间分隔符原文）。分隔符定义：包含 ≥2 个换行的空白串。
fn split_paragraphs_keep_separators(text: &str) -> Vec<(String, String)> {
    let mut parts: Vec<(String, String)> = Vec::new();
    let mut para = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            let mut sep = String::new();
            sep.push(c);
            let mut newline_count = 1usize;
            while let Some(&nc) = chars.peek() {
                if matches!(nc, '\n' | '\r' | ' ' | '\t') {
                    if nc == '\n' {
                        newline_count += 1;
                    }
                    sep.push(nc);
                    chars.next();
                } else {
                    break;
                }
            }
            if newline_count >= 2 {
                if para.is_empty() {
                    // 文首分隔符或连续分隔符：并入上一段分隔符，避免空段
                    if let Some(last) = parts.last_mut() {
                        last.1.push_str(&sep);
                    }
                } else {
                    parts.push((std::mem::take(&mut para), sep));
                }
            } else {
                para.push_str(&sep);
            }
        } else {
            para.push(c);
        }
    }
    if !para.is_empty() {
        parts.push((para, String::new()));
    }
    parts
}

/// 超长段落降级：按句子切成 ~target 字符的块。
/// 每块的首部空白移交给前一块的 separator，保证西文重组时词间空格不丢。
fn split_sentence_chunks(paragraph: &str, target: usize) -> Vec<TextSegment> {
    let mut sentences: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in paragraph.chars() {
        cur.push(ch);
        if matches!(ch, '。' | '！' | '？' | '；' | '.' | '!' | '?' | ';' | '\n') {
            sentences.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        sentences.push(cur);
    }

    let mut chunks: Vec<TextSegment> = Vec::new();
    let mut buf = String::new();
    let mut buf_chars = 0usize;
    for sentence in sentences {
        let s_chars = char_len(&sentence);
        if buf_chars > 0 && buf_chars + s_chars > target {
            chunks.push(TextSegment {
                content: std::mem::take(&mut buf),
                separator: String::new(),
            });
            buf_chars = 0;
        }
        if s_chars > target * 2 {
            // 无标点超长句：按字符数硬切（char 边界安全）
            if !buf.is_empty() {
                chunks.push(TextSegment {
                    content: std::mem::take(&mut buf),
                    separator: String::new(),
                });
                buf_chars = 0;
            }
            let mut piece = String::new();
            let mut piece_chars = 0usize;
            for ch in sentence.chars() {
                piece.push(ch);
                piece_chars += 1;
                if piece_chars >= target {
                    chunks.push(TextSegment {
                        content: std::mem::take(&mut piece),
                        separator: String::new(),
                    });
                    piece_chars = 0;
                }
            }
            if !piece.is_empty() {
                chunks.push(TextSegment {
                    content: piece,
                    separator: String::new(),
                });
            }
        } else {
            buf.push_str(&sentence);
            buf_chars += s_chars;
        }
    }
    if !buf.is_empty() {
        chunks.push(TextSegment {
            content: buf,
            separator: String::new(),
        });
    }

    // 首部空白移交前一块 separator
    for i in 1..chunks.len() {
        let leading: String = chunks[i]
            .content
            .chars()
            .take_while(|c| c.is_whitespace())
            .collect();
        if !leading.is_empty() {
            let remainder: String = chunks[i]
                .content
                .chars()
                .skip(leading.chars().count())
                .collect();
            chunks[i].content = remainder;
            chunks[i - 1].separator = leading;
        }
    }
    chunks.retain(|c| !c.content.trim().is_empty());
    chunks
}

/// 智能分段：按段落分组到 ~target 字符；超长段落降级句子切分
pub(crate) fn build_segments(text: &str, target_chars: usize) -> Vec<TextSegment> {
    let paragraphs = split_paragraphs_keep_separators(text);
    if paragraphs.is_empty() {
        return vec![TextSegment {
            content: text.to_string(),
            separator: String::new(),
        }];
    }

    let mut segments: Vec<TextSegment> = Vec::new();
    let mut buf = String::new();
    let mut buf_chars = 0usize;
    // buf 尾部待定分隔符：继续并段则回填 buf，flush 时成为段间分隔符
    let mut pending_sep = String::new();

    for (content, sep) in paragraphs {
        let p_chars = char_len(&content);
        if p_chars > target_chars * 2 {
            // 超长段落：先落盘缓冲，再句子级切分
            if !buf.is_empty() {
                segments.push(TextSegment {
                    content: std::mem::take(&mut buf),
                    separator: std::mem::take(&mut pending_sep),
                });
                buf_chars = 0;
            } else {
                pending_sep.clear();
            }
            let mut chunks = split_sentence_chunks(&content, target_chars);
            if let Some(last) = chunks.last_mut() {
                last.separator = sep;
            }
            segments.extend(chunks);
            continue;
        }
        if buf_chars > 0 && buf_chars + p_chars > target_chars {
            segments.push(TextSegment {
                content: std::mem::take(&mut buf),
                separator: std::mem::take(&mut pending_sep),
            });
            buf_chars = 0;
        }
        if buf_chars > 0 {
            buf.push_str(&pending_sep);
            buf_chars += char_len(&pending_sep);
        }
        pending_sep = sep;
        buf.push_str(&content);
        buf_chars += p_chars;
    }
    if !buf.is_empty() {
        segments.push(TextSegment {
            content: buf,
            separator: pending_sep,
        });
    }

    if segments.is_empty() {
        vec![TextSegment {
            content: text.to_string(),
            separator: String::new(),
        }]
    } else {
        segments
    }
}

// ==================== 语言检测与 Prompt 构造 ====================

/// 启发式检测源语言（脚本级判定，快速且零依赖）
///
/// 判定顺序刻意先查假名/谚文再查汉字：日文夹杂大量汉字，
/// 先查汉字会把日文误判为中文（对齐 chat_popover 侧同类修复）。
/// 拉丁字母文本无法区分英/法/德等语种，仅在无变音符时保守返回 "en"。
pub(crate) fn detect_source_lang(text: &str) -> Option<&'static str> {
    let sample: Vec<char> = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .take(400)
        .collect();
    if sample.is_empty() {
        return None;
    }

    let mut kana = 0usize;
    let mut hangul = 0usize;
    let mut han = 0usize;
    let mut cyrillic = 0usize;
    let mut arabic = 0usize;
    let mut thai = 0usize;
    let mut devanagari = 0usize;
    let mut greek = 0usize;
    let mut latin = 0usize;
    let mut latin_extended = 0usize;

    for &ch in &sample {
        let cp = ch as u32;
        match cp {
            0x3040..=0x30FF | 0x31F0..=0x31FF => kana += 1,
            0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F => hangul += 1,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF => han += 1,
            0x0400..=0x04FF => cyrillic += 1,
            0x0600..=0x06FF | 0x0750..=0x077F => arabic += 1,
            0x0E00..=0x0E7F => thai += 1,
            0x0900..=0x097F => devanagari += 1,
            0x0370..=0x03FF => greek += 1,
            0x0041..=0x005A | 0x0061..=0x007A => latin += 1,
            0x00C0..=0x024F => latin_extended += 1,
            _ => {}
        }
    }

    let total = sample.len();
    let dominant = |count: usize| count * 5 >= total; // ≥20% 即视为主导脚本

    // CJK：假名/谚文优先于汉字（日/韩文本都可能夹杂汉字）
    if kana > 0 && dominant(kana + han) {
        return Some("ja");
    }
    if hangul > 0 && dominant(hangul) {
        return Some("ko");
    }
    if dominant(han) {
        return Some("zh-CN");
    }
    if dominant(cyrillic) {
        return Some("ru");
    }
    if dominant(arabic) {
        return Some("ar");
    }
    if dominant(thai) {
        return Some("th");
    }
    if dominant(devanagari) {
        return Some("hi");
    }
    if dominant(greek) {
        return Some("el");
    }
    // 拉丁文本：无扩展变音符时保守判为英语；带变音符时无法可靠区分语种，不回报
    if dominant(latin) && latin_extended * 20 < latin {
        return Some("en");
    }
    None
}

/// 语言 code → 全名映射，确保 LLM 精确理解目标语言
pub(crate) fn lang_full_name(code: &str) -> &str {
    match code {
        "zh-CN" | "zh" => "Simplified Chinese (简体中文)",
        "zh-TW" => "Traditional Chinese (繁體中文)",
        "en" => "English",
        "ja" => "Japanese (日本語)",
        "ko" => "Korean (한국어)",
        "fr" => "French (français)",
        "de" => "German (Deutsch)",
        "es" => "Spanish (español)",
        "ru" => "Russian (русский)",
        "ar" => "Arabic (العربية)",
        "pt" => "Portuguese (português)",
        "pt-BR" => "Brazilian Portuguese (português brasileiro)",
        "it" => "Italian (italiano)",
        "vi" => "Vietnamese (tiếng Việt)",
        "th" => "Thai (ไทย)",
        "hi" => "Hindi (हिन्दी)",
        "tr" => "Turkish (Türkçe)",
        "pl" => "Polish (polski)",
        "nl" => "Dutch (Nederlands)",
        "sv" => "Swedish (svenska)",
        "la" => "Latin (Latina)",
        "el" => "Greek (Ελληνικά)",
        "uk" => "Ukrainian (українська)",
        "id" => "Indonesian (Bahasa Indonesia)",
        "ms" => "Malay (Bahasa Melayu)",
        "auto" => "auto-detected language",
        other => other,
    }
}

/// 领域预设 prompt 模板
fn domain_system_prompt(domain: &str) -> &str {
    match domain {
        "academic" => 
            "You are an expert academic translator specializing in scholarly papers, theses, and research articles. \
             Translate with precision, maintaining academic register and discipline-specific terminology. \
             Preserve citation formats (e.g. [1], (Author, Year)), mathematical notation, and abbreviations. \
             Ensure terminological consistency throughout. Only output the translated text.",
        "technical" => 
            "You are a professional technical translator specializing in software documentation, engineering, and IT content. \
             Keep code snippets, variable names, command-line examples, and API references untranslated. \
             Preserve markdown/HTML formatting. Translate technical terms accurately using industry-standard vocabulary. \
             Only output the translated text.",
        "literary" => 
            "You are a literary translator with expertise in creative writing. \
             Prioritize natural fluency and emotional resonance over literal accuracy. \
             Preserve rhetorical devices, metaphors, rhythm, and the author's unique voice. \
             Adapt cultural references when necessary for the target audience. Only output the translated text.",
        "legal" => 
            "You are a certified legal translator. \
             Translate with absolute precision using standard legal terminology in the target language. \
             Preserve the exact structure of clauses, articles, and numbered sections. \
             Do not paraphrase or simplify legal language. Only output the translated text.",
        "medical" =>
            "You are a medical translator with expertise in clinical and biomedical texts. \
             Use standard medical terminology (ICD/MeSH terms where applicable). \
             Preserve drug names, dosages, anatomical terms, and abbreviations accurately. \
             Only output the translated text.",
        "casual" | "conversation" =>
            "You are a friendly translator for everyday conversations and social media content. \
             Use natural, colloquial language that sounds native. \
             Adapt idioms, slang, and cultural expressions appropriately. Only output the translated text.",
        _ =>
            "You are a professional translator. Translate the given text accurately while preserving its tone, style, and formatting. Do not add explanations or notes. Only output the translated text.",
    }
}

/// 构造 System Prompt（自定义覆盖 → 领域预设 → 风格控制 → 术语表）
pub(crate) fn build_system_prompt(request: &TranslationRequest) -> String {
    // System Prompt: 优先使用用户自定义，否则根据领域选择预设
    let mut system_prompt = if let Some(override_prompt) = &request.prompt_override {
        if !override_prompt.trim().is_empty() {
            override_prompt.clone()
        } else {
            domain_system_prompt(request.domain.as_deref().unwrap_or("general")).to_string()
        }
    } else {
        domain_system_prompt(request.domain.as_deref().unwrap_or("general")).to_string()
    };

    // 注入风格控制（当领域已是 casual 时跳过，避免重复指令）
    let domain_str = request.domain.as_deref().unwrap_or("general");
    if domain_str != "casual" && domain_str != "conversation" {
        if let Some(formality) = &request.formality {
            let style_instruction = match formality.as_str() {
                "formal" => {
                    "\n\nUse formal, polite language suitable for business or academic contexts."
                }
                "casual" => "\n\nUse casual, conversational language.",
                _ => "",
            };
            system_prompt.push_str(style_instruction);
        }
    }

    // 注入术语表
    // ★ 2026-07-19: 术语经 JSON 转义注入（防止术语内的引号/换行破坏指令结构），
    // 并要求模型保持大小写变体的一致处理。
    if let Some(glossary) = &request.glossary {
        let entries: Vec<(&str, &str)> = glossary
            .iter()
            .map(|(s, t)| (s.trim(), t.trim()))
            .filter(|(s, t)| !s.is_empty() && !t.is_empty())
            .collect();
        if !entries.is_empty() {
            system_prompt.push_str(
                "\n\nGlossary (you MUST use these exact translations for the specified terms, \
                 matching case-insensitively but preserving the target form exactly):",
            );
            for (src, tgt) in entries {
                system_prompt.push_str(&format!(
                    "\n- {} → {}",
                    serde_json::Value::String(src.to_string()),
                    serde_json::Value::String(tgt.to_string()),
                ));
            }
        }
    }

    system_prompt
}

/// 构造整段文本的 User Prompt（使用全语言名称）
pub(crate) fn build_user_prompt(request: &TranslationRequest, text: &str) -> String {
    let src_name = lang_full_name(&request.src_lang);
    let tgt_name = lang_full_name(&request.tgt_lang);

    if request.src_lang == "auto" {
        format!(
            "Please translate the following text to {}:\n\n{}",
            tgt_name, text
        )
    } else {
        format!(
            "Please translate the following text from {} to {}:\n\n{}",
            src_name, tgt_name, text
        )
    }
}

/// 构造分段翻译的 User Prompt（携带段序与上一段译文尾部作为延续上下文）
fn build_segment_user_prompt(
    request: &TranslationRequest,
    segment_text: &str,
    index: usize,
    total: usize,
    prev_translated_tail: Option<String>,
) -> String {
    let tgt_name = lang_full_name(&request.tgt_lang);
    let mut prompt = if request.src_lang == "auto" {
        format!(
            "This is part {} of {} of a longer document. Translate ONLY this part to {}. \
             Keep terminology and style consistent across parts. \
             Do not add headings, notes, part markers, or extra blank lines.\n\n",
            index, total, tgt_name
        )
    } else {
        format!(
            "This is part {} of {} of a longer document. Translate ONLY this part from {} to {}. \
             Keep terminology and style consistent across parts. \
             Do not add headings, notes, part markers, or extra blank lines.\n\n",
            index,
            total,
            lang_full_name(&request.src_lang),
            tgt_name
        )
    };
    if let Some(tail) = prev_translated_tail {
        prompt.push_str(&format!(
            "For continuity, the translation of the previous part ended with (do NOT repeat it):\n…{}\n\n",
            tail
        ));
    }
    prompt.push_str("Text to translate:\n");
    prompt.push_str(segment_text);
    prompt
}

/// 构造翻译 Prompt（兼容入口：rag_extension 等外部调用方依赖此签名）
pub fn build_translation_prompts(
    request: &TranslationRequest,
) -> Result<(String, String), AppError> {
    Ok((
        build_system_prompt(request),
        build_user_prompt(request, &request.text),
    ))
}

// ==================== 流式调用核心 ====================

/// 流式翻译（兼容包装：错误折叠为 AppError，并做终局取消清理）
///
/// chat_popover 等调用方使用本签名；
/// 需要结构化错误码的调用方（run_translation / candidates）使用 `stream_translate_inner`。
pub(crate) async fn stream_translate<F>(
    config: &ApiConfig,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    stream_event: &str,
    llm: Arc<LLMManager>,
    options: &StreamOptions,
    on_chunk: F,
) -> Result<StreamStatus, AppError>
where
    F: FnMut(String),
{
    let result = stream_translate_inner(
        config,
        api_key,
        system_prompt,
        user_prompt,
        stream_event,
        llm.clone(),
        options,
        on_chunk,
    )
    .await
    .map_err(|f| AppError::llm(f.message));
    llm.clear_cancel_artifacts(stream_event).await;
    result
}

/// 按 HTTP 状态码构造用户可读错误（不暴露服务端原始报文）
fn http_failure(status: u16) -> StreamFailure {
    let (message, code, retriable) = match status {
        400 => ("翻译请求参数无效，请检查模型配置", "http_400", false),
        401 => ("API 密钥无效或已过期，请检查设置", "http_401", false),
        402 => ("API 账户余额不足，请充值后重试", "http_402", false),
        403 => ("API 访问被拒绝，请检查账户权限", "http_403", false),
        404 => ("模型或接口不存在，请检查模型配置", "http_404", false),
        408 => ("翻译请求超时，请重试", "http_408", true),
        413 => ("翻译文本过大，请缩短后重试", "http_413", false),
        429 => ("请求过于频繁，请稍后重试", "rate_limited", true),
        500..=599 => ("翻译服务暂时不可用，请稍后重试", "http_5xx", true),
        _ if (400..500).contains(&status) => ("翻译请求被拒绝，请检查配置", "http_4xx", false),
        _ => ("翻译请求失败，请重试", "http_error", true),
    };
    StreamFailure::new(message, code, retriable)
}

/// 网络层错误分类（连接超时 / 无法连接 / 其他传输错误）
fn network_failure(context: &str, e: reqwest::Error) -> StreamFailure {
    if e.is_timeout() {
        StreamFailure::new(format!("{}：连接超时", context), "timeout_connect", true)
    } else if e.is_connect() {
        StreamFailure::new(
            format!("{}：无法连接翻译服务", context),
            "network_unreachable",
            true,
        )
    } else {
        StreamFailure::new(format!("{}: {}", context, e.without_url()), "network", true)
    }
}

/// 供应商流内错误块（SafetyBlocked 事件）分类：
/// 内容安全拦截 → content_filtered（不可重试）；其余供应商错误 → provider_error
fn classify_provider_block(info: &serde_json::Value) -> StreamFailure {
    let reason = info
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let block_type = info
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let detail_msg = info
        .get("details")
        .and_then(|d| d.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let is_content_block = matches!(block_type, "content_blocked" | "safety_error")
        || reason.contains("safety")
        || reason.contains("refusal")
        || reason.contains("content_filter");
    if is_content_block {
        return StreamFailure::new(
            "翻译内容被安全策略拦截，请调整文本后重试",
            "content_filtered",
            false,
        );
    }
    let message = if detail_msg.is_empty() {
        "翻译服务返回错误，请稍后重试".to_string()
    } else {
        format!("翻译服务返回错误：{}", detail_msg)
    };
    StreamFailure::new(message, "provider_error", false)
}

/// 流式翻译（核心逻辑，结构化错误版本）
///
/// ★ 2026-07-19 改造 + 2026-07-20 加固：
/// - 初次请求失败（429/5xx/网络错误）自动指数退避重试（可配置尝试次数；
///   一旦开始产出内容不再自动重试，避免重复输出）
/// - 空闲超时与总超时保护（可配置），供应商挂起不再无限转圈
/// - 完成判定兼容 finish_reason：适配器在 `parse_stream` 中将 finish_reason
///   归一化为 `StreamEvent::Done`，此处 DONE 标记与 Done 事件双路径均认可
/// - SafetyBlocked（内容安全拦截 / 供应商流内错误）不再被静默吞掉：
///   即使随后收到 Done 也按结构化错误上报，杜绝「静默截断当成完成」
/// - 取消 watch 通道关闭后停用该 select 分支，避免 changed() 立即 Err 造成忙等
/// - 取消路径显式 drop 响应流断开 HTTP 连接；cancel channel 在所有退出路径清理
pub(crate) async fn stream_translate_inner<F>(
    config: &ApiConfig,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    stream_event: &str,
    llm: Arc<LLMManager>,
    options: &StreamOptions,
    mut on_chunk: F,
) -> Result<StreamStatus, StreamFailure>
where
    F: FnMut(String),
{
    let total_deadline = tokio::time::Instant::now() + options.total_timeout;

    let result = async {
        // 构造消息
        let messages = vec![
            json!({
                "role": "system",
                "content": system_prompt
            }),
            json!({
                "role": "user",
                "content": user_prompt
            }),
        ];

        // 构造请求体
        let max_tokens = options.max_tokens.unwrap_or_else(|| {
            crate::llm_manager::effective_max_tokens(
                config.max_output_tokens,
                config.max_tokens_limit,
            )
        });
        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": options.temperature,
            "max_tokens": max_tokens,
            "stream": true, // 关键：启用流式
        });

        crate::llm_manager::LLMManager::apply_reasoning_config(&mut request_body, config, None);

        // 选择适配器
        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(config);

        // 注册取消监听。事件名对所有调用方都是每次运行唯一，
        // 因此进入时已存在的 pending cancel 是真实取消（如分段间隙抵达的信号），
        // 必须履行而非丢弃。
        if llm.consume_pending_cancel(stream_event).await {
            return Ok(StreamStatus::Cancelled);
        }
        let mut cancel_rx = llm.subscribe_cancel_stream(stream_event).await;
        // watch sender 被替换/清理后 changed() 会立即 Err；置 false 关闭该分支防忙等
        let mut cancel_watch_open = true;

        // ===== 请求阶段：可重试（指数退避），流式产出后不再自动重试 =====
        let mut attempt: u32 = 0;
        let response = loop {
            attempt += 1;

            // 每次尝试前检查取消
            if llm.consume_pending_cancel(stream_event).await || *cancel_rx.borrow() {
                return Ok(StreamStatus::Cancelled);
            }
            if tokio::time::Instant::now() >= total_deadline {
                return Err(StreamFailure::new(
                    "翻译总时长超限，请缩短文本或稍后重试",
                    "timeout_total",
                    true,
                ));
            }

            // 构造 HTTP 请求，并统一合并供应商自定义请求头 / Codex OAuth 凭据。
            let mut preq = llm
                .prepare_provider_request(
                    adapter.as_ref(),
                    config,
                    &request_body,
                    Some(api_key),
                    Some(stream_event),
                    "翻译请求构建失败",
                )
                .await
                .map_err(StreamFailure::from)?;

            // 复用 LLMManager 配置好的 HTTP 客户端
            let client = llm.get_http_client();

            // 发送流式请求
            let send_result: Result<reqwest::Response, StreamFailure> = if preq.is_codex() {
                llm.send_codex_stream_request_with_single_refresh(
                    &mut preq,
                    Some(options.total_timeout.min(Duration::from_secs(300))),
                )
                .await
                .map_err(|e| StreamFailure::new(format!("翻译请求失败: {}", e), "network", true))
            } else {
                let mut header_map = reqwest::header::HeaderMap::new();
                for (k, v) in &preq.headers {
                    if let (Ok(name), Ok(val)) = (
                        reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                        reqwest::header::HeaderValue::from_str(v),
                    ) {
                        header_map.insert(name, val);
                    }
                }

                client
                    .post(&preq.url)
                    .headers(header_map)
                    .json(&preq.body)
                    .send()
                    .await
                    .map_err(|e| network_failure("翻译请求失败", e))
            };

            let failure = match send_result {
                Ok(resp) => {
                    if resp.status().is_success() {
                        break resp;
                    }
                    let status = resp.status();
                    let error_text = resp.text().await.unwrap_or_default();
                    // 完整错误仅记录日志（开发调试用，截断防刷屏），不回传用户
                    let snippet: String = error_text.chars().take(600).collect();
                    eprintln!("❌ [Translation] API error {}: {}", status, snippet);
                    // 4xx 中的内容审核拒绝单独归类（部分供应商以 400 承载 content_filter）
                    if status.as_u16() == 400
                        && (error_text.contains("content_filter")
                            || error_text.contains("content_policy")
                            || error_text.contains("ResponsibleAIPolicy"))
                    {
                        StreamFailure::new(
                            "翻译内容被安全策略拦截，请调整文本后重试",
                            "content_filtered",
                            false,
                        )
                    } else {
                        http_failure(status.as_u16())
                    }
                }
                Err(f) => f,
            };

            // 不可重试错误 / 重试次数耗尽 → 直接失败
            if !failure.retriable || attempt >= options.max_request_attempts {
                return Err(failure);
            }

            // 指数退避：500ms → 1500ms（期间可取消）
            let backoff = RETRY_BACKOFF_BASE * 3u32.pow(attempt - 1);
            eprintln!(
                "🔁 [Translation] 请求失败（{}），{}ms 后重试（第 {}/{} 次尝试）",
                failure.code,
                backoff.as_millis(),
                attempt + 1,
                options.max_request_attempts
            );
            let backoff_sleep = tokio::time::sleep(backoff);
            tokio::pin!(backoff_sleep);
            loop {
                tokio::select! {
                    _ = &mut backoff_sleep => break,
                    changed = cancel_rx.changed(), if cancel_watch_open => {
                        match changed {
                            Ok(()) => {
                                if *cancel_rx.borrow() {
                                    return Ok(StreamStatus::Cancelled);
                                }
                            }
                            Err(_) => cancel_watch_open = false,
                        }
                    }
                }
            }
        };

        // ===== 流式解析阶段 =====
        let mut stream = response.bytes_stream();
        let mut sse_buffer = crate::utils::sse_buffer::SseEventBuffer::new();
        let mut stream_ended = false;
        let mut cancelled = false;
        // 供应商流内错误（内容安全拦截 / 配额不足等）：不可被后续 Done 掩盖
        let mut terminal_failure: Option<StreamFailure> = None;
        let mut handle_sse_block = |block: &str| -> bool {
            if crate::utils::sse_buffer::SseEventBuffer::check_done_marker(block) {
                return true;
            }
            for event in adapter.parse_stream(block) {
                match event {
                    crate::providers::StreamEvent::ContentChunk(content) => on_chunk(content),
                    // 适配器已把 finish_reason 归一化为 Done（详见 providers::should_finish_*），
                    // 因此仅发送 finish_reason、不发 [DONE] 的服务端也能正确判定完成
                    crate::providers::StreamEvent::Done => return true,
                    crate::providers::StreamEvent::SafetyBlocked(info) => {
                        eprintln!("🚫 [Translation] 供应商流内错误/安全拦截: {}", info);
                        if terminal_failure.is_none() {
                            terminal_failure = Some(classify_provider_block(&info));
                        }
                    }
                    _ => {}
                }
            }
            false
        };

        while !stream_ended && !cancelled {
            if llm.consume_pending_cancel(stream_event).await {
                cancelled = true;
                break;
            }

            let idle_deadline = tokio::time::Instant::now() + options.idle_timeout;
            let effective_deadline = idle_deadline.min(total_deadline);

            tokio::select! {
                changed = cancel_rx.changed(), if cancel_watch_open => {
                    match changed {
                        Ok(()) => {
                            if *cancel_rx.borrow() {
                                cancelled = true;
                            }
                        }
                        Err(_) => cancel_watch_open = false,
                    }
                }
                _ = tokio::time::sleep_until(effective_deadline) => {
                    // 显式断开 HTTP 连接后报超时
                    drop(stream);
                    if tokio::time::Instant::now() >= total_deadline {
                        return Err(StreamFailure::new(
                            "翻译总时长超限，请缩短文本或稍后重试",
                            "timeout_total",
                            true,
                        ));
                    }
                    return Err(StreamFailure::new(
                        "翻译服务长时间无响应，已中断。请重试。",
                        "timeout_idle",
                        true,
                    ));
                }
                chunk_result = stream.next() => {
                    match chunk_result {
                        Some(chunk) => {
                            let bytes = chunk.map_err(|e| network_failure("读取流失败", e))?;
                            for block in sse_buffer.process_bytes(&bytes) {
                                if handle_sse_block(&block) {
                                    stream_ended = true;
                                    break;
                                }
                            }
                        }
                        None => {
                            break;
                        }
                    }
                }
            }
        }

        if cancelled {
            // ★ 取消即断开：显式 drop 响应流，中止上游 HTTP 连接（停止计费）
            drop(stream);
            return Ok(StreamStatus::Cancelled);
        }

        if !stream_ended {
            for block in sse_buffer.flush() {
                if handle_sse_block(&block) {
                    stream_ended = true;
                    break;
                }
            }
        }

        // 供应商流内错误优先：即使收到 Done 也不能把被拦截/出错的流当成正常完成
        if let Some(failure) = terminal_failure {
            return Err(failure);
        }

        // ★ A6-02：区分正常完成（收到完成标记）与流意外中断
        if stream_ended {
            Ok(StreamStatus::Completed)
        } else {
            eprintln!("⚠️ [Translation] SSE 流未收到完成标记就结束，结果可能不完整");
            Ok(StreamStatus::Incomplete)
        }
    }
    .await;

    // 所有退出路径（完成/取消/错误/超时）都清理 cancel channel，
    // 防止同名 stream_event 复用时被残留取消信号立即假取消。
    // registry 兜底标记由外层终局清理（clear_cancel_artifacts）负责：
    // 分段翻译的段间隙依赖 registry 传递取消，不能在段结束时误清。
    llm.clear_cancel_stream(stream_event).await;

    result
}

#[cfg(test)]
mod tests {
    use super::{build_segments, detect_source_lang};

    #[test]
    fn detect_japanese_with_kanji_mix() {
        // 日文夹杂汉字：假名优先，不得误判为中文
        assert_eq!(detect_source_lang("東京の天気はとても良いです"), Some("ja"));
    }

    #[test]
    fn detect_chinese() {
        assert_eq!(
            detect_source_lang("今天天气很好，我们去公园散步吧。"),
            Some("zh-CN")
        );
    }

    #[test]
    fn detect_korean() {
        assert_eq!(detect_source_lang("오늘 날씨가 정말 좋아요"), Some("ko"));
    }

    #[test]
    fn detect_english() {
        assert_eq!(
            detect_source_lang("The quick brown fox jumps over the lazy dog"),
            Some("en")
        );
    }

    #[test]
    fn accented_latin_not_reported_as_english() {
        // 法语等带变音符文本无法可靠区分语种，应返回 None 而非误报 en
        assert_eq!(
            detect_source_lang("Être à côté de la plaque, c'est embêtant"),
            None
        );
    }

    #[test]
    fn empty_text_returns_none() {
        assert_eq!(detect_source_lang("   "), None);
    }

    #[test]
    fn segments_roundtrip_preserves_text() {
        let text = "第一段内容。\n\n第二段内容，稍微长一点。\n\n\n第三段。";
        let segments = build_segments(text, 8);
        let rebuilt: String = segments
            .iter()
            .map(|s| format!("{}{}", s.content, s.separator))
            .collect();
        assert_eq!(rebuilt, text);
    }

    #[test]
    fn small_text_stays_single_segment() {
        let text = "短文本。\n\n第二段。";
        let segments = build_segments(text, 1000);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].content, text);
    }

    #[test]
    fn oversized_paragraph_falls_back_to_sentence_chunks() {
        let long_para = "这是一句话。".repeat(50); // 300 字符，单段无空行
        let segments = build_segments(&long_para, 60);
        assert!(segments.len() > 1);
        let rebuilt: String = segments
            .iter()
            .map(|s| format!("{}{}", s.content, s.separator))
            .collect();
        assert_eq!(rebuilt, long_para);
    }

    #[test]
    fn latin_sentence_chunks_keep_word_spacing() {
        let long_para = "This is a sentence. ".repeat(30).trim_end().to_string();
        let segments = build_segments(&long_para, 60);
        assert!(segments.len() > 1);
        let rebuilt: String = segments
            .iter()
            .map(|s| format!("{}{}", s.content, s.separator))
            .collect();
        assert_eq!(rebuilt, long_para);
    }

    #[test]
    fn no_punctuation_text_hard_splits_on_char_boundary() {
        // 无标点长文本（含多字节字符）不得在 UTF-8 边界处 panic
        let long_text = "中".repeat(500);
        let segments = build_segments(&long_text, 60);
        assert!(segments.len() > 1);
        let rebuilt: String = segments.iter().map(|s| s.content.clone()).collect();
        assert_eq!(rebuilt, long_text);
    }
}
