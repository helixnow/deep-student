//! Canvas 智能笔记工具
//!
//! 本模块实现 Chat V2 Pipeline 中使用的 Canvas 笔记操作工具。
//!
//! ## 工具列表
//! - `note_read`: 读取当前笔记的内容（可指定章节）
//! - `note_append`: 追加内容到笔记（可指定章节）
//! - `note_replace`: 替换笔记中的内容（支持正则）
//! - `note_set`: 设置笔记的完整内容
//!
//! ## 约束
//! - 所有工具从 Pipeline 上下文获取 `note_id` 和 `subject`
//! - 操作后通过事件通知前端刷新

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::canvas_tool_names;

// ============================================================================
// 工具参数类型
// ============================================================================

/// note_read 工具参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReadArgs {
    /// 笔记 ID（从 Canvas 上下文获取）
    pub note_id: String,
    /// 可选：只读取指定章节（如 "## 代码实现"）
    #[serde(default)]
    pub section: Option<String>,
}

/// note_append 工具参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAppendArgs {
    /// 笔记 ID
    pub note_id: String,
    /// 要追加的内容
    pub content: String,
    /// 可选：追加到指定章节末尾
    #[serde(default)]
    pub section: Option<String>,
}

/// note_replace 工具参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReplaceArgs {
    /// 笔记 ID
    pub note_id: String,
    /// 查找文本
    pub search: String,
    /// 替换文本
    pub replace: String,
    /// 是否使用正则表达式
    #[serde(default)]
    pub is_regex: bool,
}

/// note_set 工具参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSetArgs {
    /// 笔记 ID
    pub note_id: String,
    /// 新的完整内容
    pub content: String,
}

/// note_create 工具参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreateArgs {
    /// 笔记标题
    pub title: String,
    /// 初始内容（可选，支持 Markdown）
    #[serde(default)]
    pub content: Option<String>,
    /// 标签列表（可选）
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

/// note_create 工具结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreateResult {
    /// 新创建的笔记 ID
    pub note_id: String,
    /// 笔记标题
    pub title: String,
    /// 初始内容的字数
    pub word_count: usize,
}

// ============================================================================
// 工具执行结果
// ============================================================================

/// 读取结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReadResult {
    /// 读取的内容
    pub content: String,
    /// 字数
    pub word_count: usize,
    /// 是否为章节内容
    pub is_section: bool,
}

/// 追加结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAppendResult {
    /// 追加后的总字数
    pub new_word_count: usize,
    /// 追加的字数
    pub appended_count: usize,
}

/// 替换结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReplaceResult {
    /// 替换次数
    pub replace_count: usize,
    /// 替换后的总字数
    pub new_word_count: usize,
}

/// 设置结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSetResult {
    /// 新内容的字数
    pub word_count: usize,
}

// ============================================================================
// 工具结构体
// ============================================================================

/// 笔记读取工具
pub struct NoteReadTool;

impl NoteReadTool {
    /// 工具名称
    pub fn name() -> &'static str {
        canvas_tool_names::NOTE_READ
    }

    /// 工具描述
    pub fn description() -> &'static str {
        "读取笔记的内容。可指定 noteId 读取特定笔记，或指定 section 只读取特定章节。"
    }

    /// 工具 schema（OpenAI Function Calling 格式）
    pub fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": Self::name(),
                "description": Self::description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "noteId": {
                            "type": "string",
                            "description": "笔记 ID。如果用户已在编辑器中打开笔记，可不指定。"
                        },
                        "section": {
                            "type": "string",
                            "description": "要读取的章节标题（如 '## 代码实现'）。不指定则读取完整内容。"
                        }
                    },
                    "required": []
                }
            }
        })
    }
}

/// 笔记追加工具
pub struct NoteAppendTool;

impl NoteAppendTool {
    /// 工具名称
    pub fn name() -> &'static str {
        canvas_tool_names::NOTE_APPEND
    }

    /// 工具描述
    pub fn description() -> &'static str {
        "追加内容到笔记末尾。可指定 noteId 操作特定笔记，或指定 section 追加到特定章节。"
    }

    /// 工具 schema
    pub fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": Self::name(),
                "description": Self::description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "noteId": {
                            "type": "string",
                            "description": "笔记 ID。如果用户已在编辑器中打开笔记，可不指定。"
                        },
                        "content": {
                            "type": "string",
                            "description": "要追加的内容（支持 Markdown 格式）"
                        },
                        "section": {
                            "type": "string",
                            "description": "要追加到的章节标题（如 '## 代码实现'）。不指定则追加到末尾。"
                        }
                    },
                    "required": ["content"]
                }
            }
        })
    }
}

/// 笔记替换工具
pub struct NoteReplaceTool;

impl NoteReplaceTool {
    /// 工具名称
    pub fn name() -> &'static str {
        canvas_tool_names::NOTE_REPLACE
    }

    /// 工具描述
    pub fn description() -> &'static str {
        "替换笔记中的内容。可指定 noteId 操作特定笔记。支持普通文本和正则表达式。"
    }

    /// 工具 schema
    pub fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": Self::name(),
                "description": Self::description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "noteId": {
                            "type": "string",
                            "description": "笔记 ID。如果用户已在编辑器中打开笔记，可不指定。"
                        },
                        "search": {
                            "type": "string",
                            "description": "要查找的文本或正则表达式"
                        },
                        "replace": {
                            "type": "string",
                            "description": "替换后的文本"
                        },
                        "isRegex": {
                            "type": "boolean",
                            "description": "是否使用正则表达式（默认 false）"
                        }
                    },
                    "required": ["search", "replace"]
                }
            }
        })
    }
}

/// 笔记设置工具
pub struct NoteSetTool;

impl NoteSetTool {
    /// 工具名称
    pub fn name() -> &'static str {
        canvas_tool_names::NOTE_SET
    }

    /// 工具描述
    pub fn description() -> &'static str {
        "设置笔记的完整内容。可指定 noteId 操作特定笔记。⚠️ 谨慎使用，会覆盖原有内容。"
    }

    /// 工具 schema
    pub fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": Self::name(),
                "description": Self::description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "noteId": {
                            "type": "string",
                            "description": "笔记 ID。如果用户已在编辑器中打开笔记，可不指定。"
                        },
                        "content": {
                            "type": "string",
                            "description": "笔记的新完整内容（支持 Markdown 格式）"
                        }
                    },
                    "required": ["content"]
                }
            }
        })
    }
}

// ============================================================================
// 笔记创建工具
// ============================================================================

/// 笔记创建工具
pub struct NoteCreateTool;

impl NoteCreateTool {
    /// 工具名称
    pub fn name() -> &'static str {
        canvas_tool_names::NOTE_CREATE
    }

    /// 工具描述
    pub fn description() -> &'static str {
        "创建一个新笔记。返回新笔记的 ID，可用于后续 note_append/note_set 操作。"
    }

    /// 工具 schema
    pub fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": Self::name(),
                "description": Self::description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "笔记标题"
                        },
                        "content": {
                            "type": "string",
                            "description": "初始内容（可选，支持 Markdown 格式）"
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "标签列表（可选）"
                        }
                    },
                    "required": ["title"]
                }
            }
        })
    }
}

// ============================================================================
// 笔记列表工具
// ============================================================================

/// note_list 工具参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListArgs {
    /// 返回数量限制（默认 20）
    #[serde(default)]
    pub limit: Option<usize>,
    /// 按标签过滤（可选）
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// 是否只返回收藏（可选）
    #[serde(default)]
    pub favorites_only: Option<bool>,
}

/// 笔记列表结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListResult {
    /// 笔记列表
    pub notes: Vec<NoteListItem>,
    /// 总数
    pub total: usize,
}

/// 笔记列表项（轻量）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListItem {
    /// 笔记 ID
    pub id: String,
    /// 标题
    pub title: String,
    /// 标签
    pub tags: Vec<String>,
    /// 是否收藏
    pub is_favorite: bool,
    /// 更新时间
    pub updated_at: String,
}

/// 笔记列表工具
pub struct NoteListTool;

impl NoteListTool {
    /// 工具名称
    pub fn name() -> &'static str {
        canvas_tool_names::NOTE_LIST
    }

    /// 工具描述
    pub fn description() -> &'static str {
        "列出 Learning Hub 中的笔记。可按标签过滤或只显示收藏。"
    }

    /// 工具 schema
    pub fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": Self::name(),
                "description": Self::description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "返回数量限制（默认 20，最大 100）"
                        },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "按标签过滤（AND 逻辑）"
                        },
                        "favoritesOnly": {
                            "type": "boolean",
                            "description": "是否只返回收藏的笔记"
                        }
                    },
                    "required": []
                }
            }
        })
    }
}

// ============================================================================
// 笔记搜索工具
// ============================================================================

/// note_search 工具参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchArgs {
    /// 搜索关键词
    pub query: String,
    /// 返回数量限制（默认 10）
    #[serde(default)]
    pub limit: Option<usize>,
}

/// 笔记搜索结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchResult {
    /// 搜索结果
    pub results: Vec<NoteSearchItem>,
    /// 结果数量
    pub count: usize,
}

/// 笔记搜索结果项
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchItem {
    /// 笔记 ID
    pub id: String,
    /// 标题
    pub title: String,
    /// 匹配片段（高亮上下文）
    pub snippet: Option<String>,
}

/// 笔记搜索工具
pub struct NoteSearchTool;

impl NoteSearchTool {
    /// 工具名称
    pub fn name() -> &'static str {
        canvas_tool_names::NOTE_SEARCH
    }

    /// 工具描述
    pub fn description() -> &'static str {
        "在 Learning Hub 中搜索笔记。支持全文检索，返回匹配片段。"
    }

    /// 工具 schema
    pub fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": Self::name(),
                "description": Self::description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "返回数量限制（默认 10，最大 50）"
                        }
                    },
                    "required": ["query"]
                }
            }
        })
    }
}

// ============================================================================
// 辅助函数：章节操作
// ============================================================================

/// 提取指定章节的内容
///
/// ## 参数
/// - `content`: 完整笔记内容
/// - `section_title`: 章节标题（如 "## 代码实现"）
///
/// ## 返回
/// - `Some(section_content)`: 章节存在时返回内容（不包含标题行）
/// - `None`: 章节不存在
pub fn extract_section(content: &str, section_title: &str) -> Option<String> {
    let section_title = section_title.trim();
    if section_title.is_empty() {
        return None;
    }

    // 解析章节级别（#的数量）
    let section_level = section_title.chars().take_while(|c| *c == '#').count();
    if section_level == 0 {
        return None;
    }

    let lines: Vec<&str> = content.lines().collect();
    let mut in_section = false;
    let mut section_content = Vec::new();

    for line in lines {
        if in_section {
            // 检查是否遇到同级或更高级标题
            let line_trimmed = line.trim_start();
            if line_trimmed.starts_with('#') {
                let line_level = line_trimmed.chars().take_while(|c| *c == '#').count();
                if line_level <= section_level {
                    break; // 遇到同级或更高级标题，结束
                }
            }
            section_content.push(line);
        } else if line.trim() == section_title {
            in_section = true;
        }
    }

    if section_content.is_empty() && !in_section {
        None
    } else {
        Some(section_content.join("\n").trim().to_string())
    }
}

/// 在指定章节末尾追加内容
///
/// ## 参数
/// - `content`: 完整笔记内容
/// - `section_title`: 章节标题
/// - `append_content`: 要追加的内容
///
/// ## 返回
/// - `Some(new_content)`: 成功追加后的内容
/// - `None`: 章节不存在
pub fn append_to_section(
    content: &str,
    section_title: &str,
    append_content: &str,
) -> Option<String> {
    let section_title = section_title.trim();
    if section_title.is_empty() {
        return None;
    }

    let section_level = section_title.chars().take_while(|c| *c == '#').count();
    if section_level == 0 {
        return None;
    }

    let lines: Vec<&str> = content.lines().collect();
    let mut result = Vec::new();
    let mut found_section = false;
    let mut insert_index = None;

    for (i, line) in lines.iter().enumerate() {
        if found_section && insert_index.is_none() {
            let line_trimmed = line.trim_start();
            if line_trimmed.starts_with('#') {
                let line_level = line_trimmed.chars().take_while(|c| *c == '#').count();
                if line_level <= section_level {
                    insert_index = Some(i);
                }
            }
        }
        if line.trim() == section_title {
            found_section = true;
        }
        result.push(*line);
    }

    if !found_section {
        return None;
    }

    // 如果没找到下一个章节，追加到末尾
    let insert_pos = insert_index.unwrap_or(result.len());

    // 在 insert_pos 位置插入内容
    let mut final_result: Vec<&str> = result[..insert_pos].to_vec();

    // 确保有空行分隔
    if !final_result.is_empty() && !final_result.last().map(|s| s.is_empty()).unwrap_or(true) {
        final_result.push("");
    }

    // 追加内容
    for line in append_content.lines() {
        final_result.push(line);
    }

    // 追加剩余内容
    if insert_pos < result.len() {
        final_result.push("");
        for line in &result[insert_pos..] {
            final_result.push(line);
        }
    }

    Some(final_result.join("\n"))
}

/// 执行文本替换
///
/// ## 参数
/// - `content`: 原始内容
/// - `search`: 查找文本或正则表达式
/// - `replace`: 替换文本
/// - `is_regex`: 是否使用正则表达式
///
/// ## 返回
/// - `Ok((new_content, replace_count))`: 替换后的内容和替换次数
/// - `Err(error)`: 正则表达式无效
pub fn replace_content(
    content: &str,
    search: &str,
    replace: &str,
    is_regex: bool,
) -> Result<(String, usize), String> {
    if is_regex {
        let regex = Regex::new(search).map_err(|e| format!("无效的正则表达式: {}", e))?;
        let mut count = 0;
        let new_content = regex
            .replace_all(content, |_caps: &regex::Captures| {
                count += 1;
                replace.to_string()
            })
            .to_string();
        Ok((new_content, count))
    } else {
        let count = content.matches(search).count();
        let new_content = content.replace(search, replace);
        Ok((new_content, count))
    }
}

/// 解析笔记结构（提取所有标题）
pub fn parse_structure(content: &str) -> Vec<String> {
    content
        .lines()
        .filter(|line| line.trim_start().starts_with('#'))
        .map(|line| line.trim().to_string())
        .collect()
}

/// 生成笔记摘要（取前 N 个字符）
pub fn generate_summary(content: &str, max_length: usize) -> String {
    // 移除 Markdown 标记，获取纯文本
    let plain_text: String = content
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<&str>>()
        .join(" ");

    if plain_text.chars().count() <= max_length {
        plain_text
    } else {
        let truncated: String = plain_text.chars().take(max_length).collect();
        format!("{}...", truncated)
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_section() {
        let content = "# Title\n## Intro\nHello\n## Code\n```js\nconst x = 1;\n```\n## End\nBye";

        let section = extract_section(content, "## Code");
        assert!(section.is_some());
        let section_content = section.unwrap();
        assert!(section_content.contains("const x = 1;"));
        assert!(!section_content.contains("Hello"));
        assert!(!section_content.contains("Bye"));
    }

    #[test]
    fn test_extract_section_not_found() {
        let content = "# Title\n## Intro\nHello";
        let section = extract_section(content, "## NotExist");
        assert!(section.is_none());
    }

    #[test]
    fn test_append_to_section() {
        let content = "# Title\n## Intro\nHello\n## Code\nOld code\n## End";
        let result = append_to_section(content, "## Code", "New code");
        assert!(result.is_some());
        let new_content = result.unwrap();
        assert!(new_content.contains("Old code"));
        assert!(new_content.contains("New code"));
    }

    #[test]
    fn test_replace_content_plain() {
        let content = "Hello world, hello Rust";
        let (new_content, count) = replace_content(content, "hello", "hi", false).unwrap();
        assert_eq!(count, 1); // 区分大小写
        assert!(new_content.contains("hi Rust"));
        assert!(new_content.contains("Hello world"));
    }

    #[test]
    fn test_replace_content_regex() {
        let content = "Hello world, hello Rust";
        let (new_content, count) = replace_content(content, "(?i)hello", "hi", true).unwrap();
        assert_eq!(count, 2); // 不区分大小写的正则
        assert!(new_content.contains("hi world"));
        assert!(new_content.contains("hi Rust"));
    }

    #[test]
    fn test_parse_structure() {
        let content = "# Title\n## Section 1\n### Subsection\n## Section 2";
        let structure = parse_structure(content);
        assert_eq!(structure.len(), 4);
        assert_eq!(structure[0], "# Title");
        assert_eq!(structure[1], "## Section 1");
    }

    #[test]
    fn test_generate_summary() {
        let content = "# Title\nThis is a very long content that needs to be truncated.";
        let summary = generate_summary(content, 20);
        assert!(summary.ends_with("..."));
        assert!(summary.len() <= 23); // 20 + "..."
    }

    #[test]
    fn test_tool_schemas() {
        let read_schema = NoteReadTool.schema();
        assert!(read_schema.get("function").is_some());

        let append_schema = NoteAppendTool.schema();
        assert!(append_schema.get("function").is_some());

        let replace_schema = NoteReplaceTool.schema();
        assert!(replace_schema.get("function").is_some());

        let set_schema = NoteSetTool.schema();
        assert!(set_schema.get("function").is_some());

        let create_schema = NoteCreateTool.schema();
        assert!(create_schema.get("function").is_some());

        let list_schema = NoteListTool.schema();
        assert!(list_schema.get("function").is_some());

        let search_schema = NoteSearchTool.schema();
        assert!(search_schema.get("function").is_some());
    }

    #[test]
    fn test_note_create_schema_has_required_title() {
        let schema = NoteCreateTool.schema();
        let function = schema.get("function").unwrap();
        let parameters = function.get("parameters").unwrap();
        let required = parameters.get("required").unwrap().as_array().unwrap();
        assert!(required.iter().any(|v| v.as_str() == Some("title")));
    }

    #[test]
    fn test_tool_schemas_have_note_id() {
        // 验证读写工具的 schema 包含可选的 noteId 参数
        for tool_schema in [
            NoteReadTool.schema(),
            NoteAppendTool.schema(),
            NoteReplaceTool.schema(),
            NoteSetTool.schema(),
        ] {
            let function = tool_schema.get("function").unwrap();
            let parameters = function.get("parameters").unwrap();
            let properties = parameters.get("properties").unwrap();
            assert!(
                properties.get("noteId").is_some(),
                "Tool schema should have noteId property"
            );
        }
    }
}
