//! Chat V2 - System Prompt 构建器
//!
//! 统一的 System Prompt 格式化逻辑，使用 XML 标签分隔各部分。
//!
//! ## 设计原则
//! 1. **边界明确**：使用 XML 标签包裹不同部分，LLM 不易混淆
//! 2. **引用一致**：统一使用 `[类型-编号]` 格式
//! 3. **使用指引**：明确告知 LLM 如何引用来源
//! 4. **可扩展**：新增来源类型只需添加新标签
//!
//! ## 输出格式示例
//! ```xml
//! <system_instructions>
//! 你是一个专业的AI学习助手...
//!
//! 回答时如引用了上下文信息，请使用 [来源类型-编号] 格式标注。
//! </system_instructions>
//!
//! <context>
//! <knowledge_base>
//! [知识库-1] 内容...
//! </knowledge_base>
//! ...
//! </context>
//!
//! <user_preferences>
//! 用户追加的指令...
//! </user_preferences>
//! ```

use super::types::{MessageSources, SendOptions, SharedContext, SourceInfo};
use super::vfs_resolver::escape_xml_content;

// ============================================================================
// 常量定义
// ============================================================================

/// 默认系统提示
const DEFAULT_SYSTEM_PROMPT: &str = "你是一个专业的AI学习助手，帮助学生理解知识、解答问题、分析错题。请用清晰、准确的语言回答问题，必要时提供示例和解释。";

/// 引用指引（详细版）
/// ★ 2026-01 修复：添加 [图片-N] 引用类型，与前端 citationParser 保持一致
const CITATION_GUIDE: &str = r#"<citation_rules>
<description>引用格式规范，回答时必须遵守</description>
<format>
当引用上下文中的信息时，请使用 [来源类型-编号] 格式标注引用来源。
</format>
<source_types>
- [知识库-N]: 引用知识库/RAG检索中的内容
- [记忆-N]: 引用智能记忆中的内容
- [搜索-N]: 引用网络搜索结果
- [图片-N]: 引用多模态检索中的图片内容（仅当引用了图片来源时使用）
</source_types>
<rules>
1. 每个引用标记必须紧跟在引用内容之后，不要单独成行
2. 同一句话引用多个来源时，可连续标注如 [知识库-1][知识库-2]
3. 编号 N 从 1 开始，对应上下文中同类型来源的顺序
4. 只引用确实使用的来源，不要虚构引用
5. 引用标记会被渲染为可点击的链接，用户可以快速查看原文
6. 禁止在回复末尾生成"参考文献"、"来源汇总"、"相关论文"等表格或列表，系统会自动展示来源面板
7. 如需在引用处显示图片缩略图，可使用 [知识库-N:图片] 或 [图片-N:图片] 格式
</rules>
<examples>
正确：根据牛顿第二定律 F=ma [知识库-1]，力与加速度成正比。
正确：这个概念在你之前的笔记中也提到过 [记忆-1]。
正确：如图所示 [图片-1]，函数在 x=0 处不连续。
正确：根据教材中的图示 [知识库-2:图片]，力的方向如下。
错误：[知识库-1] 根据牛顿第二定律...（标记不应在句首）
错误：根据资料显示...（缺少引用标记）
错误：在回复末尾添加"参考文献"表格（系统已自动展示，禁止重复）
</examples>
</citation_rules>"#;

/// LaTeX 输出规则（XML 格式）
const LATEX_RULES: &str = r#"<latex_rules priority="highest">
<description>数学公式输出规范，必须严格遵守</description>
<rules>
1. 任何数学表达式必须使用 $...$ (行内) 或 $$...$$ (块级) 包裹，分隔符必须成对闭合。
2. 禁止裸露 LaTeX：不得出现未被 $ 或 $$ 包裹的 \frac、\sqrt、\int、\sum、\lim、上下标 ^/_ 等。
3. 严禁用任何形式的 Markdown 代码块（三反引号）包裹数学内容，包括 ```math、```latex 等，全部改用 $/$$ 直接输出。
4. 禁止使用 \(...\) 与 \[...\] 作为分隔符。
5. 多行/展示型公式须使用 $$ 并独立成段，起止各占一行；行内使用单 $ 且不跨段落。
6. 仅使用 KaTeX 支持的命令；多字符上下标需加花括号；中文/非 ASCII 请置于 \text{...}；矩阵使用 bmatrix 环境。
7. \boxed{} 命令必须用 $...$ 包裹：正确格式为 $\boxed{C}$，禁止使用 [\boxed{C}] 等未包裹格式。
</rules>
<examples type="correct">
- 行内：$\lim_{x\to 0}\frac{\sin(ax)-\sin(bx)}{x}=a-b$
- 块级：
$$
\int_0^1 x^2\,\mathrm{d}x = \tfrac{1}{3}
$$
- 带框答案：$\boxed{C}$ 或 $$\boxed{C}$$
</examples>
<examples type="incorrect">
- \lim_{x\to 0} \frac{\sin x}{x} （未包裹）
- \( \int_a^b f(x)\,\mathrm{d}x \) （错误分隔符）
- ```math ... ``` （代码块包裹，禁止！）
- [\boxed{C}] （\boxed 未用 $ 包裹，禁止！）
</examples>
<self_check>
发送前自检：若检测到数学符号未在 $ 或 $$ 内，请重写并补齐分隔符后再发送。
</self_check>
</latex_rules>"#;

/// 各来源类型的最大条目数
const MAX_RAG_ITEMS: usize = 5;
const MAX_MEMORY_ITEMS: usize = 3;
const MAX_WEB_ITEMS: usize = 5;

/// 单条来源内容的最大字符数（超出则截断）
const MAX_SINGLE_SOURCE_CHARS: usize = 1500;
/// RAG 来源的总字符上限
const MAX_RAG_TOTAL_CHARS: usize = 6000;
/// 记忆来源的总字符上限
const MAX_MEMORY_TOTAL_CHARS: usize = 3000;
/// 网络搜索来源的总字符上限
const MAX_WEB_TOTAL_CHARS: usize = 4000;

// ============================================================================
// 来源类型标识
// ============================================================================

/// 来源类型枚举
/// ★ 2026-01 清理：移除 Mistakes 类型（错题系统废弃）
#[derive(Debug, Clone, Copy)]
pub enum SourceType {
    /// 知识库（RAG）
    KnowledgeBase,
    /// 智能记忆
    Memory,
    /// 网络搜索
    WebSearch,
}

impl SourceType {
    /// 获取来源类型的中文标签
    fn label(&self) -> &'static str {
        match self {
            SourceType::KnowledgeBase => "知识库",
            SourceType::Memory => "记忆",
            SourceType::WebSearch => "搜索",
        }
    }

    /// 获取 XML 标签名
    fn xml_tag(&self) -> &'static str {
        match self {
            SourceType::KnowledgeBase => "knowledge_base",
            SourceType::Memory => "memory",
            SourceType::WebSearch => "web_search",
        }
    }
}

// ============================================================================
// 格式化辅助函数
// ============================================================================

/// 截断超长内容，保留 `max_chars` 个字符并追加省略标记
fn truncate_content(content: &str, max_chars: usize) -> String {
    if content.chars().count() <= max_chars {
        content.to_string()
    } else {
        let truncated: String = content.chars().take(max_chars).collect();
        format!("{}…（已截断）", truncated)
    }
}

/// 格式化单个来源条目
///
/// 输出格式：`[类型-编号] 内容`
/// 对外部内容进行XML转义，防止间接Prompt注入
fn format_source_item(source_type: SourceType, index: usize, content: &str) -> String {
    format!(
        "[{}-{}] {}",
        source_type.label(),
        index + 1,
        escape_xml_content(content)
    )
}

/// 格式化网络搜索条目（包含标题和摘要）
/// 对外部内容进行XML转义，防止间接Prompt注入
fn format_web_search_item(
    index: usize,
    title: Option<&str>,
    snippet: Option<&str>,
) -> Option<String> {
    match (title, snippet) {
        (Some(t), Some(s)) => Some(format!(
            "[{}-{}] 标题: {}\n摘要: {}",
            SourceType::WebSearch.label(),
            index + 1,
            escape_xml_content(t),
            escape_xml_content(s)
        )),
        (Some(t), None) => Some(format!(
            "[{}-{}] {}",
            SourceType::WebSearch.label(),
            index + 1,
            escape_xml_content(t)
        )),
        (None, Some(s)) => Some(format!(
            "[{}-{}] {}",
            SourceType::WebSearch.label(),
            index + 1,
            escape_xml_content(s)
        )),
        (None, None) => None,
    }
}

/// 格式化来源列表为 XML 块
///
/// 同时受 `max_items`（条目数）和 `max_total_chars`（总字符数）双重限制，
/// 两者取最先触发的。每条内容超过 `MAX_SINGLE_SOURCE_CHARS` 会被截断。
fn format_sources_as_xml(
    sources: &[SourceInfo],
    source_type: SourceType,
    max_items: usize,
    max_total_chars: usize,
) -> Option<String> {
    let mut items: Vec<String> = Vec::new();
    let mut total_chars: usize = 0;

    for s in sources.iter() {
        let content = match s.snippet.as_ref().or(s.title.as_ref()) {
            Some(c) => c,
            None => continue,
        };

        if items.len() >= max_items {
            break;
        }

        let content = truncate_content(content, MAX_SINGLE_SOURCE_CHARS);
        let item = format_source_item(source_type, items.len(), &content);
        let item_chars = item.chars().count();

        if !items.is_empty() && total_chars + item_chars > max_total_chars {
            break;
        }

        total_chars += item_chars;
        items.push(item);
    }

    if items.is_empty() {
        return None;
    }

    Some(format!(
        "<{}>\n{}\n</{}>",
        source_type.xml_tag(),
        items.join("\n"),
        source_type.xml_tag()
    ))
}

/// 格式化网络搜索结果为 XML 块
///
/// 同时受 `max_items` 和 `max_total_chars` 双重限制。
/// 每条 snippet 超过 `MAX_SINGLE_SOURCE_CHARS` 会被截断。
fn format_web_search_as_xml(
    sources: &[SourceInfo],
    max_items: usize,
    max_total_chars: usize,
) -> Option<String> {
    let mut items: Vec<String> = Vec::new();
    let mut total_chars: usize = 0;

    for (i, s) in sources.iter().take(max_items).enumerate() {
        let truncated_snippet = s
            .snippet
            .as_deref()
            .map(|sn| truncate_content(sn, MAX_SINGLE_SOURCE_CHARS));

        let item = match format_web_search_item(
            i,
            s.title.as_deref(),
            truncated_snippet.as_deref(),
        ) {
            Some(item) => item,
            None => continue,
        };

        let item_chars = item.chars().count();
        if !items.is_empty() && total_chars + item_chars > max_total_chars {
            break;
        }

        total_chars += item_chars;
        items.push(item);
    }

    if items.is_empty() {
        return None;
    }

    Some(format!(
        "<{}>\n{}\n</{}>",
        SourceType::WebSearch.xml_tag(),
        items.join("\n\n"),
        SourceType::WebSearch.xml_tag()
    ))
}

// ============================================================================
// 主构建函数
// ============================================================================

/// 长笔记阈值（字数）
const LONG_NOTE_THRESHOLD: usize = 3000;

/// Canvas 笔记信息
#[derive(Debug, Clone)]
pub struct CanvasNoteInfo {
    /// 笔记 ID
    pub note_id: String,
    /// 笔记标题
    pub title: String,
    /// 笔记内容
    pub content: String,
    /// 笔记字数
    pub word_count: usize,
}

impl CanvasNoteInfo {
    /// 创建新的 Canvas 笔记信息
    pub fn new(note_id: String, title: String, content: String) -> Self {
        let word_count = content.chars().count();
        Self {
            note_id,
            title,
            content,
            word_count,
        }
    }

    /// 判断是否为长笔记
    pub fn is_long_note(&self) -> bool {
        self.word_count >= LONG_NOTE_THRESHOLD
    }

    /// 解析笔记结构（提取 Markdown 标题）
    pub fn parse_structure(&self) -> Vec<String> {
        self.content
            .lines()
            .filter(|line| line.starts_with('#'))
            .map(|line| line.trim().to_string())
            .collect()
    }

    /// 生成笔记摘要
    pub fn generate_summary(&self, max_length: usize) -> String {
        // 移除 Markdown 标题和代码块，只保留正文
        let text: String = self
            .content
            .lines()
            .filter(|line| !line.starts_with('#'))
            .filter(|line| !line.starts_with("```"))
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        if text.chars().count() <= max_length {
            text
        } else {
            format!("{}...", text.chars().take(max_length).collect::<String>())
        }
    }
}

/// System Prompt 构建器
pub struct PromptBuilder {
    /// 基础系统提示（来自前端模式插件或默认值）
    base_prompt: String,
    /// 上下文块列表
    context_blocks: Vec<String>,
    /// 用户追加指令
    user_append: Option<String>,
    /// 是否有任何来源（用于决定是否添加引用指引）
    has_sources: bool,
    /// Canvas 笔记信息（可选）
    canvas_note: Option<CanvasNoteInfo>,
    /// 上下文类型 Hints（告知 LLM 用户消息中 XML 标签的含义）
    context_type_hints: Vec<String>,
}

impl PromptBuilder {
    /// 创建新的构建器
    ///
    /// # 参数
    /// - `system_prompt_override`: 前端传入的系统提示覆盖（来自模式插件）
    pub fn new(system_prompt_override: Option<&str>) -> Self {
        let base_prompt = system_prompt_override
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_SYSTEM_PROMPT)
            .to_string();

        Self {
            base_prompt,
            context_blocks: Vec::new(),
            user_append: None,
            has_sources: false,
            canvas_note: None,
            context_type_hints: Vec::new(),
        }
    }

    /// 添加 Canvas 笔记信息
    pub fn with_canvas_note(mut self, note: Option<CanvasNoteInfo>) -> Self {
        self.canvas_note = note;
        self
    }

    /// 添加 RAG 知识库来源
    pub fn with_rag_sources(mut self, sources: Option<&Vec<SourceInfo>>) -> Self {
        if let Some(src) = sources {
            if !src.is_empty() {
                if let Some(block) = format_sources_as_xml(
                    src,
                    SourceType::KnowledgeBase,
                    MAX_RAG_ITEMS,
                    MAX_RAG_TOTAL_CHARS,
                ) {
                    self.context_blocks.push(block);
                    self.has_sources = true;
                }
            }
        }
        self
    }

    /// 添加记忆来源
    pub fn with_memory_sources(mut self, sources: Option<&Vec<SourceInfo>>) -> Self {
        if let Some(src) = sources {
            if !src.is_empty() {
                if let Some(block) = format_sources_as_xml(
                    src,
                    SourceType::Memory,
                    MAX_MEMORY_ITEMS,
                    MAX_MEMORY_TOTAL_CHARS,
                ) {
                    self.context_blocks.push(block);
                    self.has_sources = true;
                }
            }
        }
        self
    }

    /// 添加网络搜索来源
    pub fn with_web_search_sources(mut self, sources: Option<&Vec<SourceInfo>>) -> Self {
        if let Some(src) = sources {
            if !src.is_empty() {
                if let Some(block) =
                    format_web_search_as_xml(src, MAX_WEB_ITEMS, MAX_WEB_TOTAL_CHARS)
                {
                    self.context_blocks.push(block);
                    self.has_sources = true;
                }
            }
        }
        self
    }

    /// 添加用户追加指令
    pub fn with_user_append(mut self, append: Option<&str>) -> Self {
        if let Some(a) = append {
            if !a.is_empty() {
                self.user_append = Some(a.to_string());
            }
        }
        self
    }

    /// 从 MessageSources 添加所有来源
    /// ★ 2026-01 清理：移除 graph 来源（错题系统废弃）
    pub fn with_message_sources(self, sources: &MessageSources) -> Self {
        self.with_rag_sources(sources.rag.as_ref())
            .with_memory_sources(sources.memory.as_ref())
            .with_web_search_sources(sources.web_search.as_ref())
    }

    /// 从 SharedContext 添加所有来源
    /// ★ 2026-01 清理：移除 graph 来源（错题系统废弃）
    pub fn with_shared_context(self, context: &SharedContext) -> Self {
        self.with_rag_sources(context.rag_sources.as_ref())
            .with_memory_sources(context.memory_sources.as_ref())
            .with_web_search_sources(context.web_search_sources.as_ref())
    }

    /// 从 SendOptions 配置构建器
    pub fn with_options(self, options: &SendOptions) -> Self {
        self.with_user_append(options.system_prompt_append.as_deref())
            .with_context_type_hints(options.context_type_hints.as_ref())
    }

    /// 添加上下文类型 Hints
    pub fn with_context_type_hints(mut self, hints: Option<&Vec<String>>) -> Self {
        if let Some(h) = hints {
            if !h.is_empty() {
                self.context_type_hints = h.clone();
            }
        }
        self
    }

    /// 构建最终的 System Prompt
    pub fn build(self) -> String {
        let mut parts: Vec<String> = Vec::new();

        // 0. 系统时间信息（让 LLM 知道当前时间）
        let now = chrono::Local::now();
        let time_info = format!(
            "<system_time>\n当前时间: {}\n时区: {}\n</system_time>",
            now.format("%Y-%m-%d %H:%M:%S"),
            now.format("%:z")
        );
        parts.push(time_info);

        // 1. LaTeX 规则（最高优先级，放在最前面）
        parts.push(LATEX_RULES.to_string());

        // 2. 系统指令块
        let instructions = self.base_prompt.clone();
        parts.push(format!(
            "<system_instructions>\n{}\n</system_instructions>",
            instructions
        ));

        // 2.1 引用规则（如果有来源）
        if self.has_sources {
            parts.push(CITATION_GUIDE.to_string());
        }

        // 2.5 用户消息格式说明（如果有 hints）
        if !self.context_type_hints.is_empty() {
            let hints_content = self.context_type_hints.join("\n");
            parts.push(format!(
                r#"<user_message_format_guide>
用户消息的结构如下：
1. <user_query> - 用户的实际问题或请求（优先响应）
2. <injected_context> - 相关上下文信息，包含以下可能的子标签：
{}

请优先理解并响应 <user_query> 中的内容，<injected_context> 中的信息仅供参考。
</user_message_format_guide>"#,
                hints_content
            ));
        }

        // 3. 上下文块（如果有来源）
        if !self.context_blocks.is_empty() {
            let context_content = self.context_blocks.join("\n\n");
            parts.push(format!("<context>\n{}\n</context>", context_content));
        }

        // 4. 用户追加指令（如果有）
        if let Some(append) = self.user_append {
            parts.push(format!(
                "<user_preferences>\n{}\n</user_preferences>",
                append
            ));
        }

        // 5. Canvas 笔记块（如果有）
        // 实现长短笔记策略：短笔记（<3000字）全量注入，长笔记仅注入摘要
        if let Some(note) = self.canvas_note {
            let structure = note.parse_structure();
            let structure_str = if structure.is_empty() {
                "（无标题结构）".to_string()
            } else {
                structure.join("\n")
            };

            let content_section = if note.is_long_note() {
                // 长笔记：仅注入摘要（转义防止注入）
                let summary = note.generate_summary(500);
                format!(
                    r#"<note_summary>
{}
</note_summary>
<note_hint>笔记较长（{}字），请使用 note_read 工具查看具体章节</note_hint>"#,
                    escape_xml_content(&summary),
                    note.word_count
                )
            } else {
                // 短笔记：全量注入（转义防止注入）
                format!(
                    "<note_content>\n{}\n</note_content>",
                    escape_xml_content(&note.content)
                )
            };

            let canvas_block = format!(
                r#"<canvas_note>
<note_meta>
  <title>{}</title>
  <note_id>{}</note_id>
  <word_count>{}</word_count>
  <structure>
{}
  </structure>
</note_meta>
{}
<available_tools>
你可以使用以下工具来操作这个笔记：
- note_read: 读取笔记内容（可指定 section 参数）
- note_append: 追加内容（可指定 section 参数）
- note_replace: 替换内容（支持 search/replace/isRegex 参数）
- note_set: 设置完整内容（谨慎使用）
</available_tools>
<behavior_rules>
- 修改笔记时，使用工具调用而非直接输出内容
- 大段修改前，先用 note_read 确认当前内容
- 每次修改后，简要说明做了什么改动
</behavior_rules>
</canvas_note>"#,
                escape_xml_content(&note.title),
                escape_xml_content(&note.note_id),
                note.word_count,
                escape_xml_content(&structure_str),
                content_section
            );
            parts.push(canvas_block);
        }

        parts.join("\n\n")
    }
}

// ============================================================================
// 便捷构建函数
// ============================================================================

/// 从 SendOptions 和 MessageSources 构建 System Prompt
///
/// 这是 Pipeline 中 `build_system_prompt` 的替代函数
pub fn build_system_prompt(
    options: &SendOptions,
    sources: &MessageSources,
    canvas_note: Option<CanvasNoteInfo>,
) -> String {
    PromptBuilder::new(options.system_prompt_override.as_deref())
        .with_message_sources(sources)
        .with_options(options)
        .with_canvas_note(canvas_note)
        .build()
}

/// 从 SendOptions 和 SharedContext 构建 System Prompt
///
/// 这是 Pipeline 中 `build_system_prompt_with_shared_context` 的替代函数
pub fn build_system_prompt_with_shared_context(
    options: &SendOptions,
    shared_context: &SharedContext,
    canvas_note: Option<CanvasNoteInfo>,
) -> String {
    PromptBuilder::new(options.system_prompt_override.as_deref())
        .with_shared_context(shared_context)
        .with_options(options)
        .with_canvas_note(canvas_note)
        .build()
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_prompt() {
        let prompt = PromptBuilder::new(None).build();
        assert!(prompt.contains("<system_instructions>"));
        assert!(prompt.contains(DEFAULT_SYSTEM_PROMPT));
        assert!(prompt.contains("</system_instructions>"));
        // 没有来源时不应该有引用指引
        assert!(!prompt.contains("<citation_rules>"));
    }

    #[test]
    fn test_custom_prompt_override() {
        let custom = "你是一个数学老师";
        let prompt = PromptBuilder::new(Some(custom)).build();
        assert!(prompt.contains(custom));
        assert!(!prompt.contains(DEFAULT_SYSTEM_PROMPT));
    }

    #[test]
    fn test_with_rag_sources() {
        let sources = vec![SourceInfo {
            title: Some("文档1".to_string()),
            url: None,
            snippet: Some("这是知识库内容".to_string()),
            score: Some(0.9),
            metadata: None,
        }];

        let prompt = PromptBuilder::new(None)
            .with_rag_sources(Some(&sources))
            .build();

        assert!(prompt.contains("<context>"));
        assert!(prompt.contains("<knowledge_base>"));
        assert!(prompt.contains("[知识库-1] 这是知识库内容"));
        assert!(prompt.contains("</knowledge_base>"));
        assert!(prompt.contains("</context>"));
        // 有来源时应该有引用指引
        assert!(prompt.contains("<citation_rules>"));
        assert!(prompt.contains("[知识库-N]"));
    }

    #[test]
    fn test_with_multiple_sources() {
        let rag = vec![SourceInfo {
            title: None,
            url: None,
            snippet: Some("RAG内容".to_string()),
            score: None,
            metadata: None,
        }];
        let memory = vec![SourceInfo {
            title: None,
            url: None,
            snippet: Some("记忆内容".to_string()),
            score: None,
            metadata: None,
        }];

        let prompt = PromptBuilder::new(None)
            .with_rag_sources(Some(&rag))
            .with_memory_sources(Some(&memory))
            .build();

        assert!(prompt.contains("[知识库-1] RAG内容"));
        assert!(prompt.contains("[记忆-1] 记忆内容"));
    }

    #[test]
    fn test_with_user_append() {
        let prompt = PromptBuilder::new(None)
            .with_user_append(Some("请用英文回答"))
            .build();

        assert!(prompt.contains("<user_preferences>"));
        assert!(prompt.contains("请用英文回答"));
        assert!(prompt.contains("</user_preferences>"));
    }

    #[test]
    fn test_web_search_format() {
        let sources = vec![SourceInfo {
            title: Some("搜索标题".to_string()),
            url: Some("https://example.com".to_string()),
            snippet: Some("搜索摘要".to_string()),
            score: None,
            metadata: None,
        }];

        let prompt = PromptBuilder::new(None)
            .with_web_search_sources(Some(&sources))
            .build();

        assert!(prompt.contains("<web_search>"));
        assert!(prompt.contains("[搜索-1] 标题: 搜索标题"));
        assert!(prompt.contains("摘要: 搜索摘要"));
        assert!(prompt.contains("</web_search>"));
    }

    #[test]
    fn test_empty_sources_ignored() {
        let empty: Vec<SourceInfo> = vec![];

        let prompt = PromptBuilder::new(None)
            .with_rag_sources(Some(&empty))
            .build();

        // 空来源不应该生成 context 块
        assert!(!prompt.contains("<context>"));
    }

    #[test]
    fn test_source_type_labels() {
        assert_eq!(SourceType::KnowledgeBase.label(), "知识库");
        assert_eq!(SourceType::Memory.label(), "记忆");
        assert_eq!(SourceType::WebSearch.label(), "搜索");
    }

    #[test]
    fn test_complete_prompt_structure() {
        let rag = vec![SourceInfo {
            title: None,
            url: None,
            snippet: Some("知识内容".to_string()),
            score: None,
            metadata: None,
        }];

        let prompt = PromptBuilder::new(Some("自定义指令"))
            .with_rag_sources(Some(&rag))
            .with_user_append(Some("追加指令"))
            .build();

        // 验证结构顺序
        let instructions_pos = prompt.find("<system_instructions>").unwrap();
        let context_pos = prompt.find("<context>").unwrap();
        let prefs_pos = prompt.find("<user_preferences>").unwrap();

        assert!(instructions_pos < context_pos);
        assert!(context_pos < prefs_pos);
    }
}
