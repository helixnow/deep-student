//! 翻译请求类型与 prompt 构造纯函数（`translation::types` / `translation::pipeline` 按原路径重导出）

use crate::models::AppError;
use serde::{Deserialize, Serialize};

/// 翻译请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationRequest {
    /// 待翻译文本
    pub text: String,

    /// 源语言（如 "zh", "en", "auto"）
    pub src_lang: String,

    /// 目标语言
    pub tgt_lang: String,

    /// 自定义提示词（可选）
    pub prompt_override: Option<String>,

    /// 会话 ID（用于事件作用域）
    pub session_id: String,

    /// 风格控制（可选）
    /// "formal" | "casual" | "auto"（匹配原文语气） | null
    #[serde(default)]
    pub formality: Option<String>,

    /// 术语表（可选，键值对：源词 -> 目标词）
    #[serde(default)]
    pub glossary: Option<Vec<(String, String)>>,

    /// 翻译领域/场景（可选）
    /// "academic" | "technical" | "literary" | "casual" | "legal" | "medical"
    #[serde(default)]
    pub domain: Option<String>,
}

/// 语言 code → 全名映射，确保 LLM 精确理解目标语言
pub fn lang_full_name(code: &str) -> &str {
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
pub fn build_system_prompt(request: &TranslationRequest) -> String {
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

    // 公式契约（共享常量）：译文中的公式保持 LaTeX 形态、不得裸写
    system_prompt.push_str("\n\n");
    system_prompt.push_str(crate::prompt_contracts::LATEX_OUTPUT_BRIEF_EN);

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
pub fn build_user_prompt(request: &TranslationRequest, text: &str) -> String {
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

/// 构造翻译 Prompt（兼容入口：rag_extension 等外部调用方依赖此签名）
pub fn build_translation_prompts(
    request: &TranslationRequest,
) -> Result<(String, String), AppError> {
    Ok((
        build_system_prompt(request),
        build_user_prompt(request, &request.text),
    ))
}
