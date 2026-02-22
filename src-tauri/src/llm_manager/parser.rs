//! JSON/思维链解析工具集
//!
//! 从 llm_manager.rs 拆分的纯函数模块，零依赖于 LLMManager 结构体

use log::{debug, warn};
use regex::Regex;
use serde_json::json;
use std::sync::LazyLock;

static RE_CODE_FENCE_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?im)^\s*```[\w-]*\s*$").expect("static regex"));
static RE_TILDE_FENCE_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?im)^\s*~~~[\w-]*\s*$").expect("static regex"));
static RE_BACKTICK_INLINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)```").expect("static regex"));
static RE_TILDE_INLINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"~~~").expect("static regex"));
static RE_OCR_JSON_FRAGMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\{[^{}]*"ocr_text"[^{}]*"tags"[^{}]*"mistake_type"[^{}]*\}"#)
        .expect("static regex")
});
static RE_OCR_TEXT_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:ocr_text|题目内容|文字内容|题目文字)[":\s]*["']?([^"'\n\r}]+)["']?"#)
        .expect("static regex")
});
static RE_TAGS_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:tags|标签|知识点)[":\s]*\[([^\]]+)\]"#).expect("static regex")
});
static RE_TYPE_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:mistake_type|题目类型|类型)[":\s]*["']?([^"'\n\r}]+)["']?"#)
        .expect("static regex")
});

// 提取推理模型的思维链段落
/// 改进的思维链内容提取方法，提供多种策略以提高可靠性
pub(crate) fn extract_reasoning_sections(content: &str) -> Vec<serde_json::Value> {
    // 策略1: 尝试标准化的思维链格式提取
    if let Some(sections) = extract_standard_cot_format(content) {
        return sections;
    }

    // 策略2: 尝试数字列表格式提取
    if let Some(sections) = extract_numbered_list_format(content) {
        return sections;
    }

    // 策略3: 尝试关键词段落格式提取
    if let Some(sections) = extract_keyword_sections(content) {
        return sections;
    }

    // 策略4: 尝试markdown格式提取
    if let Some(sections) = extract_markdown_sections(content) {
        return sections;
    }

    // 策略5: 回退到语义分割
    extract_semantic_sections(content)
}

/// 策略1: 提取标准化的思维链格式（如 "## 步骤1:", "### 分析:", 等）
pub(crate) fn extract_standard_cot_format(content: &str) -> Option<Vec<serde_json::Value>> {
    use regex::Regex;

    // 匹配标准思维链格式的标题
    let cot_patterns = [
        r"(?i)^#{1,4}\s*(步骤\s*\d+|问题理解|知识点分析|解题思路|具体步骤|结论总结)[:：]?\s*(.*)$",
        r"(?i)^(\d+\.\s*(?:问题理解|知识点分析|解题思路|具体步骤|结论总结))[:：]?\s*(.*)$",
        r"(?i)^(思考过程\s*\d*|分析\s*\d*|推理\s*\d*)[:：]\s*(.*)$",
    ];

    for pattern in &cot_patterns {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(content) {
                return Some(extract_sections_by_regex(content, &re));
            }
        }
    }

    None
}

/// 策略2: 提取数字列表格式（如 "1. 分析", "2. 推理"）
pub(crate) fn extract_numbered_list_format(content: &str) -> Option<Vec<serde_json::Value>> {
    use regex::Regex;

    if let Ok(re) = Regex::new(r"(?m)^(\d+\.\s+.+?)(?=^\d+\.\s|\z)") {
        let sections: Vec<_> = re
            .captures_iter(content)
            .enumerate()
            .filter_map(|(i, cap)| {
                let full_match = cap.get(0)?.as_str();
                let lines: Vec<&str> = full_match.lines().collect();
                let title = lines.first().unwrap_or(&"").trim();
                let content_lines = &lines[1..];

                Some(json!({
                    "title": title,
                    "content": content_lines.join("\n").trim(),
                    "section_index": i,
                    "extraction_method": "numbered_list"
                }))
            })
            .collect();

        if !sections.is_empty() {
            return Some(sections);
        }
    }

    None
}

/// 策略3: 提取关键词段落格式
pub(crate) fn extract_keyword_sections(content: &str) -> Option<Vec<serde_json::Value>> {
    let mut sections = Vec::new();
    let lines: Vec<&str> = content.lines().collect();
    let mut current_section: Option<(String, Vec<String>)> = None;

    // 增强的关键词列表
    let section_keywords = [
        "思考过程",
        "分析过程",
        "推理过程",
        "解题思路",
        "问题理解",
        "知识点分析",
        "具体步骤",
        "结论总结",
        "答案推导",
        "计算过程",
        "观察",
        "假设",
        "验证",
        "解法",
        "方法",
        "策略",
        "思维链",
        "第一步",
        "第二步",
        "第三步",
        "最后",
        "因此",
        "所以",
        "综上",
    ];

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // 检查是否是段落标题 - 更严格的匹配
        let is_section_title = section_keywords.iter().any(|&keyword| {
            trimmed.starts_with(keyword)
                || (trimmed.contains(keyword)
                    && (trimmed.ends_with("：") || trimmed.ends_with(":")))
                || (trimmed.len() < 50
                    && trimmed.contains(keyword)
                    && (trimmed.contains("分析")
                        || trimmed.contains("思考")
                        || trimmed.contains("步骤")))
        });

        if is_section_title {
            // 保存上一个段落
            if let Some((title, content_lines)) = current_section.take() {
                if !content_lines.is_empty() {
                    sections.push(json!({
                        "title": title,
                        "content": content_lines.join("\n"),
                        "extraction_method": "keyword_sections"
                    }));
                }
            }

            // 开始新段落
            let title = trimmed.trim_end_matches(['：', ':']).to_string();
            current_section = Some((title, Vec::new()));
        } else if let Some((_, ref mut content_lines)) = current_section {
            // 添加到当前段落内容
            content_lines.push(trimmed.to_string());
        }
    }

    // 保存最后一个段落
    if let Some((title, content_lines)) = current_section {
        if !content_lines.is_empty() {
            sections.push(json!({
                "title": title,
                "content": content_lines.join("\n"),
                "extraction_method": "keyword_sections"
            }));
        }
    }

    if !sections.is_empty() {
        Some(sections)
    } else {
        None
    }
}

/// 策略4: 提取markdown格式
pub(crate) fn extract_markdown_sections(content: &str) -> Option<Vec<serde_json::Value>> {
    use regex::Regex;

    if let Ok(re) = Regex::new(r"(?m)^(#{1,6}\s+.+?)$((?:(?!^#{1,6}\s).)*?)") {
        let sections: Vec<_> = re
            .captures_iter(content)
            .enumerate()
            .map(|(i, cap)| {
                let title = cap.get(1).map(|m| m.as_str()).unwrap_or("").trim();
                let section_content = cap.get(2).map(|m| m.as_str()).unwrap_or("").trim();

                json!({
                    "title": title.trim_start_matches('#').trim(),
                    "content": section_content,
                    "section_index": i,
                    "extraction_method": "markdown"
                })
            })
            .collect();

        if !sections.is_empty() {
            return Some(sections);
        }
    }

    None
}

/// 策略5: 语义分割回退方案
pub(crate) fn extract_semantic_sections(content: &str) -> Vec<serde_json::Value> {
    let trimmed_content = content.trim();

    if trimmed_content.is_empty() {
        return vec![];
    }

    // 尝试按句号或换行符分割
    let sentences: Vec<&str> = trimmed_content
        .split(|c| c == '。' || c == '.' || c == '\n')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && s.len() > 10) // 过滤太短的内容
        .collect();

    if sentences.len() > 1 {
        // 如果能分割出多个句子，按句子分组
        let sections: Vec<_> = sentences
            .chunks(2) // 每两个句子一组
            .enumerate()
            .map(|(i, chunk)| {
                json!({
                    "title": format!("思维片段 {}", i + 1),
                    "content": chunk.join("。"),
                    "section_index": i,
                    "extraction_method": "semantic_fallback"
                })
            })
            .collect();
        sections
    } else {
        // 无法分割，返回整个内容
        vec![json!({
            "title": "完整推理内容",
            "content": trimmed_content,
            "section_index": 0,
            "extraction_method": "full_content_fallback"
        })]
    }
}

/// 通用的正则表达式段落提取器
pub(crate) fn extract_sections_by_regex(
    content: &str,
    re: &regex::Regex,
) -> Vec<serde_json::Value> {
    let sections: Vec<_> = re
        .captures_iter(content)
        .enumerate()
        .map(|(i, cap)| {
            let title = cap.get(1).map(|m| m.as_str()).unwrap_or("未知段落");
            let section_content = cap.get(2).map(|m| m.as_str()).unwrap_or("");

            json!({
                "title": title.trim(),
                "content": section_content.trim(),
                "section_index": i,
                "extraction_method": "regex"
            })
        })
        .collect();

    sections
}

// 清理JSON响应内容
pub(crate) fn clean_json_response(content: &str) -> String {
    // 移除常见的包装文本
    let mut cleaned = content.trim();

    // 移除markdown代码块标记
    if cleaned.starts_with("```json") {
        cleaned = cleaned.strip_prefix("```json").unwrap_or(cleaned).trim();
    }
    if cleaned.starts_with("```") {
        cleaned = cleaned.strip_prefix("```").unwrap_or(cleaned).trim();
    }
    if cleaned.ends_with("```") {
        cleaned = cleaned.strip_suffix("```").unwrap_or(cleaned).trim();
    }

    // 移除常见的前缀文本
    let prefixes_to_remove = [
        "以下是JSON格式的结果：",
        "JSON结果：",
        "结果：",
        "答案：",
        "这是分析结果：",
    ];

    for prefix in &prefixes_to_remove {
        if cleaned.starts_with(prefix) {
            cleaned = cleaned.strip_prefix(prefix).unwrap_or(cleaned).trim();
            break;
        }
    }

    cleaned.to_string()
}

// 从文本中提取JSON
pub(crate) fn extract_json_from_text(text: &str) -> Option<String> {
    // 方法1：查找第一个{到最后一个}
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            if end > start {
                let json_candidate = &text[start..=end];
                // 验证这是一个合理的JSON结构
                if json_candidate.contains("ocr_text")
                    || json_candidate.contains("tags")
                    || json_candidate.contains("mistake_type")
                {
                    return Some(json_candidate.to_string());
                }
            }
        }
    }

    // 方法2：查找包含所需字段的JSON对象
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.trim().starts_with('{') {
            // 从这一行开始，找到匹配的}
            let mut brace_count = 0;
            let mut json_lines = Vec::new();

            for j in i..lines.len() {
                let current_line = lines[j];
                json_lines.push(current_line);

                for ch in current_line.chars() {
                    match ch {
                        '{' => brace_count += 1,
                        '}' => brace_count -= 1,
                        _ => {}
                    }
                }

                if brace_count == 0 {
                    let json_candidate = json_lines.join("\n");
                    if json_candidate.contains("ocr_text")
                        || json_candidate.contains("tags")
                        || json_candidate.contains("mistake_type")
                    {
                        return Some(json_candidate);
                    }
                    break;
                }
            }
        }
    }

    None
}

// 修复常见的JSON错误
pub(crate) fn fix_common_json_errors(json_str: &str) -> String {
    let mut fixed = json_str.to_string();

    // 修复常见的转义问题
    // 1. 修复单引号为双引号（但要小心不要破坏字符串内容）
    // 这个比较复杂，暂时跳过

    // 2. 修复未转义的引号
    // 在字符串值中查找未转义的引号并转义它们
    // 这需要更复杂的解析，暂时使用简单的替换

    // 3. 修复尾随逗号
    fixed = fixed.replace(",}", "}");
    fixed = fixed.replace(",]", "]");

    // 4. 修复多余的空白字符
    fixed = fixed.replace("\n", " ");
    fixed = fixed.replace("\r", " ");

    // 5. 修复常见的字段名问题
    fixed = fixed.replace("'ocr_text'", "\"ocr_text\"");
    fixed = fixed.replace("'tags'", "\"tags\"");
    fixed = fixed.replace("'mistake_type'", "\"mistake_type\"");

    // 6. 确保字符串值被正确引用
    // 这需要更复杂的逻辑，暂时跳过

    fixed
}

/// 增强的JSON清理函数
pub(crate) fn enhanced_clean_json_response(content: &str) -> String {
    let mut cleaned = content.trim().to_string();

    // 移除markdown代码块及常见围栏（使用预编译的静态正则）
    cleaned = RE_CODE_FENCE_LINE.replace_all(&cleaned, "").to_string();
    cleaned = RE_TILDE_FENCE_LINE.replace_all(&cleaned, "").to_string();
    cleaned = RE_BACKTICK_INLINE.replace_all(&cleaned, "").to_string();
    cleaned = RE_TILDE_INLINE.replace_all(&cleaned, "").to_string();

    // 移除常见前缀和后缀
    let prefixes = [
        "以下是JSON格式的结果：",
        "JSON结果：",
        "结果：",
        "答案：",
        "分析结果：",
        "Here is the JSON:",
        "JSON:",
        "Result:",
        "Output:",
        "Analysis:",
        "根据分析，JSON格式结果如下：",
        "JSON格式输出：",
    ];

    for prefix in &prefixes {
        if cleaned.starts_with(prefix) {
            cleaned = cleaned
                .strip_prefix(prefix)
                .unwrap_or(&cleaned)
                .trim()
                .to_string();
        }
    }

    // 移除常见后缀
    let suffixes = [
        "以上就是分析结果。",
        "分析完成。",
        "希望对您有帮助。",
        "That's the analysis.",
        "Analysis complete.",
    ];

    for suffix in &suffixes {
        if cleaned.ends_with(suffix) {
            cleaned = cleaned
                .strip_suffix(suffix)
                .unwrap_or(&cleaned)
                .trim()
                .to_string();
        }
    }

    cleaned
}

/// 智能JSON提取函数
pub(crate) fn smart_extract_json_from_text(text: &str) -> Option<String> {
    if let Some(captures) = RE_OCR_JSON_FRAGMENT.find(text) {
        return Some(captures.as_str().to_string());
    }

    // 备用方法：查找花括号包围的内容
    let mut brace_depth = 0;
    let mut start_pos = None;
    let mut end_pos = None;

    for (i, ch) in text.char_indices() {
        match ch {
            '{' => {
                if brace_depth == 0 {
                    start_pos = Some(i);
                }
                brace_depth += 1;
            }
            '}' => {
                brace_depth -= 1;
                if brace_depth == 0 && start_pos.is_some() {
                    end_pos = Some(i + 1);
                    break;
                }
            }
            _ => {}
        }
    }

    if let (Some(start), Some(end)) = (start_pos, end_pos) {
        let json_candidate = &text[start..end];
        // 验证是否包含必需字段
        if json_candidate.contains("ocr_text")
            && json_candidate.contains("tags")
            && json_candidate.contains("mistake_type")
        {
            return Some(json_candidate.to_string());
        }
    }

    None
}

/// 从内容中重构JSON（当结构化JSON无法提取时）
pub(crate) fn reconstruct_json_from_content(content: &str) -> Option<String> {
    let mut ocr_text = "";
    let mut tags_text = "";
    let mut mistake_type = "";

    if let Some(captures) = RE_OCR_TEXT_FIELD.captures(content) {
        ocr_text = captures.get(1).map(|m| m.as_str().trim()).unwrap_or("");
    }

    if let Some(captures) = RE_TAGS_FIELD.captures(content) {
        tags_text = captures.get(1).map(|m| m.as_str().trim()).unwrap_or("");
    }

    if let Some(captures) = RE_TYPE_FIELD.captures(content) {
        mistake_type = captures.get(1).map(|m| m.as_str().trim()).unwrap_or("");
    }

    // 如果至少提取到一些内容，构建JSON
    if !ocr_text.is_empty() || !tags_text.is_empty() || !mistake_type.is_empty() {
        // 处理标签字符串
        let tags_vec: Vec<String> = if tags_text.is_empty() {
            vec![]
        } else {
            tags_text
                .split(',')
                .map(|tag| tag.trim().trim_matches('"').trim_matches('\'').to_string())
                .collect()
        };

        let result = json!({
            "ocr_text": ocr_text,
            "tags": tags_vec,
            "mistake_type": mistake_type,
        });

        return serde_json::to_string(&result).ok();
    }

    None
}

/// 创建降级JSON（最后的兜底方案）
pub(crate) fn create_fallback_json(content: &str) -> String {
    debug!("创建降级JSON，原始内容长度: {} 字符", content.len());

    if content.trim().is_empty() || content.trim() == "{}" || content.trim() == "[]" {
        warn!("检测到空响应，生成默认内容");
        return serde_json::to_string(&json!({
            "ocr_text": "模型响应为空，无法识别题目内容",
            "tags": ["API响应异常", "需要人工处理"],
            "mistake_type": "系统错误"
        }))
        .unwrap_or_default();
    }

    let mut ocr_content: String = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !line.contains("JSON") && !line.contains("格式"))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");

    if ocr_content.chars().count() > 200 {
        ocr_content = format!("{}...", ocr_content.chars().take(200).collect::<String>());
    }

    if ocr_content.is_empty() || ocr_content == "{}" {
        ocr_content = "无法识别题目内容，模型响应异常".to_string();
    }

    serde_json::to_string(&json!({
        "ocr_text": ocr_content,
        "tags": ["需要人工标注"],
        "mistake_type": "未分类"
    }))
    .unwrap_or_default()
}
