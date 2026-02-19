/// 作文批改模块类型定义
use serde::{Deserialize, Serialize};

// ============================================================================
// 批阅模式相关类型
// ============================================================================

/// 评分维度配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreDimension {
    /// 维度名称
    pub name: String,
    /// 维度满分
    pub max_score: f32,
    /// 维度描述
    pub description: Option<String>,
}

/// 批阅模式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradingMode {
    /// 模式 ID
    pub id: String,
    /// 模式名称
    pub name: String,
    /// 模式描述
    pub description: String,
    /// 系统提示词
    pub system_prompt: String,
    /// 评分维度配置
    pub score_dimensions: Vec<ScoreDimension>,
    /// 总分满分
    pub total_max_score: f32,
    /// 是否预置模式
    pub is_builtin: bool,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
}

/// 解析后的评分结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedScore {
    /// 总分
    pub total: f32,
    /// 总分满分
    pub max_total: f32,
    /// 等级（优秀/良好/及格/不及格）
    pub grade: String,
    /// 分项得分
    pub dimensions: Vec<DimensionScore>,
}

/// 分项得分
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DimensionScore {
    /// 维度名称
    pub name: String,
    /// 得分
    pub score: f32,
    /// 满分
    pub max_score: f32,
    /// 评语（可选）
    pub comment: Option<String>,
}

// ============================================================================
// 批改请求/响应类型
// ============================================================================

/// 批改请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradingRequest {
    /// 会话 ID
    pub session_id: String,

    /// 流式事件会话 ID
    pub stream_session_id: String,

    /// 当前轮次号
    pub round_number: i32,

    /// 用户输入的作文
    pub input_text: String,

    /// 作文题干（可选）
    pub topic: Option<String>,

    /// 批阅模式 ID（可选，默认使用通用模式）
    pub mode_id: Option<String>,

    /// 模型配置 ID（可选，默认使用 Model2）
    pub model_config_id: Option<String>,

    /// 作文类型（兼容旧版，优先使用 mode_id）
    pub essay_type: String,

    /// 年级水平（兼容旧版，优先使用 mode_id）
    pub grade_level: String,

    /// 自定义批改 Prompt（可选，会追加到模式 prompt 后）
    pub custom_prompt: Option<String>,

    /// 上一轮的批改结果（用于多轮上下文）
    pub previous_result: Option<String>,

    /// 上一轮的学生原文（用于多轮对比）
    pub previous_input: Option<String>,

    /// 作文原图 base64 列表（多模态模型使用原图，文本模型使用 OCR 文本）
    #[serde(default)]
    pub image_base64_list: Option<Vec<String>>,

    /// 题目/参考材料图片 base64 列表（作文要求、原题目、参考范文等）
    #[serde(default)]
    pub topic_image_base64_list: Option<Vec<String>>,
}

/// 批改响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradingResponse {
    /// 轮次 ID
    pub round_id: String,

    /// 会话 ID
    pub session_id: String,

    /// 轮次号
    pub round_number: i32,

    /// 完整批改结果
    pub grading_result: String,

    /// 综合得分（可选）
    pub overall_score: Option<f32>,

    /// 维度评分 JSON（可选）
    pub dimension_scores_json: Option<String>,

    /// 创建时间
    pub created_at: String,
}

/// 轮次查询响应（用于前端 GradingRound 接口兼容）
///
/// ★ 2025-01-01: 添加此类型以匹配前端 GradingRound 接口
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradingRoundResponse {
    /// 轮次 ID
    pub id: String,

    /// 会话 ID
    pub session_id: String,

    /// 轮次号
    pub round_number: i32,

    /// 用户输入的作文内容
    pub input_text: String,

    /// 批改结果（Markdown 文本）
    pub grading_result: String,

    /// 综合得分（可选）
    pub overall_score: Option<f32>,

    /// 维度评分 JSON 字符串（可选）
    pub dimension_scores_json: Option<String>,

    /// 创建时间
    pub created_at: String,
}

/// SSE 事件负载 - 增量数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradingStreamData {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "data"

    /// 本次增量内容
    pub chunk: String,

    /// 累积内容
    pub accumulated: String,

    /// 当前字符数
    pub char_count: usize,
}

/// SSE 事件负载 - 完成
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradingStreamComplete {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "complete"

    /// 轮次 ID
    pub round_id: String,

    /// 完整批改结果
    pub grading_result: String,

    /// 综合得分
    pub overall_score: Option<f32>,

    /// 解析后的评分（JSON 字符串）
    pub parsed_score: Option<String>,

    /// 创建时间
    pub created_at: String,
}

/// SSE 事件负载 - 错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradingStreamError {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "error"

    /// 错误消息
    pub message: String,
}

/// SSE 事件负载 - 取消
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradingStreamCancelled {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "cancelled"
}

// ============================================================================
// 标记符系统常量
// ============================================================================

/// 标记符使用说明（嵌入到系统 Prompt 中）
pub const MARKER_INSTRUCTIONS: &str = r#"
批改标记格式要求

请在批改时使用以下 XML 标记对原文进行标注：

删除标记：<del reason="原因">应删除的内容</del>
插入标记：<ins>建议增加的内容</ins>
替换标记：<replace old="原文" new="修正" reason="原因"/>
批注标记：<note text="批注内容">被批注的原文</note>
亮点标记：<good>优秀片段</good>
错误标记：<err type="grammar|spelling|logic|expression">错误内容</err>

错误类型说明：
grammar: 语法错误
spelling: 拼写/错别字
logic: 逻辑问题
expression: 表达不当

【重要】输出格式规范（严格禁止 Markdown）：
严禁使用任何 Markdown 语法，包括但不限于：
不要使用 #、##、### 等标题标记。
不要使用 **加粗** 或 *斜体*。
不要使用 ```代码块```。
不要使用 - 或 * 或 1. 等列表语法。
不要使用 > 引用语法。
不要使用 [链接](url) 语法。
不要使用 --- 或 *** 分隔线。
标题直接写文字后加冒号或换行，不加任何符号前缀。
用空行分隔段落，不要用任何列表或缩进格式。
XML 标记必须直接嵌入正文中，是实际标注而非代码示例。
输出纯文本 + XML 标记，这是唯一允许的格式。
"#;

/// 评分输出格式说明
pub const SCORE_FORMAT_INSTRUCTIONS: &str = r#"
评分格式要求

在批改的【最末尾】输出一个评分标签（注意：整个回复中只能有一个 <score> 标签）：

<score total="得分" max="满分">
  <dim name="维度名" score="得分" max="满分">简要评语</dim>
</score>

【重要规范】：
只输出一个评分，放在回复的最后。
不要用代码块包裹评分标签。
如果需要描述"修改后可能的分数"，用文字说明，不要再输出第二个 <score> 标签。
评分标签必须是有效的 XML 格式。
"#;

// ============================================================================
// 预置批阅模式
// ============================================================================

/// 获取预置批阅模式列表
pub fn get_builtin_grading_modes() -> Vec<GradingMode> {
    let now = chrono::Utc::now().to_rfc3339();

    vec![
        // 高考作文模式
        GradingMode {
            id: "gaokao".to_string(),
            name: "高考作文".to_string(),
            description: "按照高考作文评分标准进行批改，总分60分".to_string(),
            system_prompt: r#"你是一位资深的高考语文阅卷组长，请严格按照新课标高考作文评分标准对学生作文进行批改。

评分标准（总分60分）：
- 内容（28分）：立意是否准确高远、联想与想象是否独特、材料运用是否恰当、中心是否突出。
- 结构（16分）：行文脉络是否清晰、层次是否分明、过渡是否自然、首尾是否呼应。
- 语言（16分）：语言是否通顺流畅、用词是否生动准确、句式是否灵活多样、修辞是否得当、文采是否斐然。

【特别注意】：
1. 忽略字迹/卷面评分（因为是电子文本），将书写分权重重新分配给只属于文本质量的维度。
2. 对于套作、宿构（套用现成文章）要严厉扣分。
3. 批改时请先通读全文，给出整体优缺点评价，然后分段进行细致点评（使用标记符）。"#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "内容".to_string(), max_score: 28.0, description: Some("立意、材料、中心".to_string()) },
                ScoreDimension { name: "结构".to_string(), max_score: 16.0, description: Some("层次、过渡、首尾".to_string()) },
                ScoreDimension { name: "语言".to_string(), max_score: 16.0, description: Some("用词、句式、修辞".to_string()) },
            ],
            total_max_score: 60.0,
            is_builtin: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },

        // 雅思大作文模式（Task 2）
        GradingMode {
            id: "ielts".to_string(),
            name: "雅思大作文".to_string(),
            description: "IELTS Writing Task 2（议论文）评分模式，总分9分".to_string(),
            system_prompt: r#"You are a certified IELTS examiner. Grade this Task 2 essay strictly according to the official IELTS Writing Band Descriptors.

Band Descriptors (0-9 scale):
- Task Response (TR):
  * Addresses all parts of the task.
  * Presents a clear position throughout the response.
  * Presents, extends, and supports main ideas.
- Coherence & Cohesion (CC):
  * Logically organizes information and ideas; clear progression.
  * Uses a range of cohesive devices appropriately.
- Lexical Resource (LR):
  * Uses a wide range of vocabulary with fluency and flexibility.
  * Uses less common lexical items with awareness of style and collocation.
- Grammatical Range & Accuracy (GRA):
  * Uses a wide range of structures.
  * Produces multiple complex sentences free from error.

Feedback Requirements:
1. Identify errors using specific tags (<err>, <replace>).
2. For each criterion, give a band score (e.g., 6.5, 7.0).
3. Specifically comment on whether the "Position" is clear throughout (crucial for TR).
4. Provide feedback in English, with Chinese translations for complex advice."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Task Response".to_string(), max_score: 9.0, description: Some("TR".to_string()) },
                ScoreDimension { name: "Coherence & Cohesion".to_string(), max_score: 9.0, description: Some("CC".to_string()) },
                ScoreDimension { name: "Lexical Resource".to_string(), max_score: 9.0, description: Some("LR".to_string()) },
                ScoreDimension { name: "Grammatical Range & Accuracy".to_string(), max_score: 9.0, description: Some("GRA".to_string()) },
            ],
            total_max_score: 9.0,
            is_builtin: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },

        // 雅思小作文模式（Task 1）
        GradingMode {
            id: "ielts_task1".to_string(),
            name: "雅思小作文".to_string(),
            description: "IELTS Writing Task 1（Academic/General）评分模式，总分9分".to_string(),
            system_prompt: r#"You are a certified IELTS examiner. Grade this Task 1 essay strictly according to the official IELTS Writing Band Descriptors.
Determine if this is an ACADEMIC (Chart/Map/Process) or GENERAL TRAINING (Letter) task based on content, and grade accordingly.

Band Descriptors (0-9 scale):
- Task Achievement (TA):
  * (Academic) Overview of main trends/differences identified? Key features highlighted? Data accurate?
  * (General) Purpose convincing? Tone appropriate? Bullet points covered?
- Coherence & Cohesion (CC): Logical organization, progression, cohesion.
- Lexical Resource (LR): Range and accuracy of vocabulary.
- Grammatical Range & Accuracy (GRA): Range and accuracy of grammar.

Note: For Task 1, do NOT look for arguments or personal opinions (unless it's a General letter asking for one). Focus on factual reporting or purpose fulfillment."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Task Achievement".to_string(), max_score: 9.0, description: Some("TA".to_string()) },
                ScoreDimension { name: "Coherence & Cohesion".to_string(), max_score: 9.0, description: Some("CC".to_string()) },
                ScoreDimension { name: "Lexical Resource".to_string(), max_score: 9.0, description: Some("LR".to_string()) },
                ScoreDimension { name: "Grammatical Range & Accuracy".to_string(), max_score: 9.0, description: Some("GRA".to_string()) },
            ],
            total_max_score: 9.0,
            is_builtin: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },

        // 考研英语大作文模式
        GradingMode {
            id: "kaoyan".to_string(),
            name: "考研英语大作文".to_string(),
            description: "考研英语（一图画/二图表）Part B 评分模式，总分20分".to_string(),
            system_prompt: r#"You are a professional grader for the Chinese Graduate Entrance Examination (English). Please grade this essay based on the Part B (Big Composition) criteria.

Scoring Criteria (Total: 20 points):
- Content & Relevance (8 points):
  * Coverage of all prompt requirements (description + interpretation + comment).
  * Relevance to the visual prompt (picture/chart).
  * Development of ideas.
- Organization & Coherence (6 points):
  * Logical structure (Introduction, Body, Conclusion).
  * Effective use of cohesive devices.
- Language & Accuracy (6 points):
  * Variety of sentence structures.
  * Precision of vocabulary (avoiding low-level repetition).
  * Grammatical accuracy.

Special Instructions:
1. Identify if it is a Picture description (English I style) or Chart description (English II style) based on content.
2. Strictly penalize off-topic essays.
3. Check for diversity in sentence patterns (e.g., inverted sentences, particulate phrases).
4. Provide a holistic evaluation first, then detailed corrections."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Content & Relevance".to_string(), max_score: 8.0, description: Some("Prompt coverage & relevance".to_string()) },
                ScoreDimension { name: "Organization & Coherence".to_string(), max_score: 6.0, description: Some("Structure & cohesion".to_string()) },
                ScoreDimension { name: "Language & Accuracy".to_string(), max_score: 6.0, description: Some("Vocabulary & grammar".to_string()) },
            ],
            total_max_score: 20.0,
            is_builtin: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },

        // 托福独立写作模式
        GradingMode {
            id: "toefl".to_string(),
            name: "托福独立写作".to_string(),
            description: "TOEFL Independent Writing 评分模式，总分30分".to_string(),
            system_prompt: r#"You are a TOEFL writing rater. Grade this essay based on the Independent Writing Rubrics.

Scoring Criteria (Scaled to 0-30):
- Development (10 points):
  * Is the essay well-developed?
  * Are ideas clearly explained and sufficiently supported with details/reasons?
- Organization (10 points):
  * Is the essay unified and coherent?
  * Is there a logical progression of ideas?
- Language Use (10 points):
  * Is there facility in the use of language?
  * Assessing syntactic variety and vocabulary range.

Feedback Requirements:
1. Focus heavily on "Topic Development" - unsubstantiated claims should be penalized.
2. Check for sentence variety.
3. Provide a conversion from raw score (0-5) to scaled score (0-30) in your comments."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Development".to_string(), max_score: 10.0, description: Some("Topic development".to_string()) },
                ScoreDimension { name: "Organization".to_string(), max_score: 10.0, description: Some("Coherence & progression".to_string()) },
                ScoreDimension { name: "Language Use".to_string(), max_score: 10.0, description: Some("Syntax & vocabulary".to_string()) },
            ],
            total_max_score: 30.0,
            is_builtin: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },

        // 中考作文模式
        GradingMode {
            id: "zhongkao".to_string(),
            name: "中考作文".to_string(),
            description: "按照中考作文评分标准进行批改，总分50分".to_string(),
            system_prompt: r#"你是一位经验丰富的初中语文教师，请按照中考作文评分标准对学生作文进行批改。

评分标准（总分50分）：
- 内容（20分）：切题程度、中心突出、内容充实、感情真挚。
- 结构（15分）：条理清楚、详略得当、结构完整。
- 语言（15分）：语句通顺、表达准确、无语病。

批改要求：
1. 语气要亲切、鼓励性强，适合初中生心理特点。
2. 重点指出记叙文的要素是否齐全，议论文的观点是否明确。
3. 使用标记符指出可改进之处，多表扬闪光点。"#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "内容".to_string(), max_score: 20.0, description: Some("切题、中心、情感".to_string()) },
                ScoreDimension { name: "结构".to_string(), max_score: 15.0, description: Some("条理、详略、完整".to_string()) },
                ScoreDimension { name: "语言".to_string(), max_score: 15.0, description: Some("通顺、准确、语病".to_string()) },
            ],
            total_max_score: 50.0,
            is_builtin: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },

        // 四六级作文模式
        GradingMode {
            id: "cet".to_string(),
            name: "四六级作文".to_string(),
            description: "按照大学英语四六级作文评分标准进行批改，总分15分".to_string(),
            system_prompt: r#"You are an experienced CET (College English Test) grader. Please grade the essay according to CET-4/6 standards.

Scoring Criteria (Total: 15 points):
- Content & Relevance (5 points): Relevance to the topic, clarity of ideas.
- Organization (5 points): Logical structure, coherence, transitions.
- Language (5 points): Vocabulary diversity, grammatical accuracy.

CRITICAL CHECK (Anti-Template):
- Check for excessive use of memorized templates (clichéd openings/endings, empty fillers).
- If the essay relies heavily on templates with little original thought, significantly REDUCE the Content score.
- Mark template phrases that are misused or unnatural with <note> tags explaining why.

Grading Requirements:
1. Point out grammatical errors with <err type="grammar">.
2. Suggest better, more academic expressions with <replace>.
3. Provide overall feedback in Chinese, explaining where they lost points (especially regarding templates)."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Content & Relevance".to_string(), max_score: 5.0, description: Some("Topic & ideas".to_string()) },
                ScoreDimension { name: "Organization".to_string(), max_score: 5.0, description: Some("Structure & coherence".to_string()) },
                ScoreDimension { name: "Language".to_string(), max_score: 5.0, description: Some("Vocabulary & grammar".to_string()) },
            ],
            total_max_score: 15.0,
            is_builtin: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },

        // 日常练习模式
        GradingMode {
            id: "practice".to_string(),
            name: "日常练习".to_string(),
            description: "宽松友好的批改模式，适合日常写作练习".to_string(),
            system_prompt: r#"你是一位温和友善的写作教练，请以鼓励为主的方式对这篇作文进行批改。

批改风格：
- 多发现闪光点，用 <good> 标记优秀之处
- 委婉指出不足，给出具体改进建议
- 评分宽松，重在进步
- 语气亲切，像朋友间的交流

评分维度（总分100分）：
- 创意与表达（40分）：想法新颖、表达生动
- 内容完整（30分）：主题明确、论述充分
- 语言规范（30分）：用词准确、语句通顺

最后请给出整体鼓励性评语，指出1-2个最值得改进的方向。"#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "创意与表达".to_string(), max_score: 40.0, description: Some("想法、表达".to_string()) },
                ScoreDimension { name: "内容完整".to_string(), max_score: 30.0, description: Some("主题、论述".to_string()) },
                ScoreDimension { name: "语言规范".to_string(), max_score: 30.0, description: Some("用词、语句".to_string()) },
            ],
            total_max_score: 100.0,
            is_builtin: true,
            created_at: now.clone(),
            updated_at: now,
        },
    ]
}

/// 获取默认批阅模式（日常练习）
pub fn get_default_grading_mode() -> GradingMode {
    get_builtin_grading_modes()
        .into_iter()
        .find(|m| m.id == "practice")
        .unwrap()
}

/// 归一化预置模式 ID，兼容历史或外部调用别名
pub fn canonical_mode_id(mode_id: &str) -> &str {
    match mode_id.trim() {
        "ielts_task2" | "ielts_writing" => "ielts",
        "ielts_task_1" => "ielts_task1",
        "cet4" | "cet6" | "cet46" | "cet_46" => "cet",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::{canonical_mode_id, get_builtin_grading_modes};

    #[test]
    fn canonical_mode_id_maps_known_aliases() {
        assert_eq!(canonical_mode_id("ielts_task2"), "ielts");
        assert_eq!(canonical_mode_id("ielts_writing"), "ielts");
        assert_eq!(canonical_mode_id("ielts_task_1"), "ielts_task1");
        assert_eq!(canonical_mode_id("cet4"), "cet");
        assert_eq!(canonical_mode_id("cet6"), "cet");
        assert_eq!(canonical_mode_id("cet46"), "cet");
        assert_eq!(canonical_mode_id("cet_46"), "cet");
        assert_eq!(canonical_mode_id("  practice  "), "practice");
    }

    #[test]
    fn builtin_modes_include_new_exam_modes() {
        let ids: std::collections::HashSet<_> = get_builtin_grading_modes()
            .into_iter()
            .map(|m| m.id)
            .collect();

        assert!(ids.contains("gaokao"));
        assert!(ids.contains("ielts"));
        assert!(ids.contains("ielts_task1"));
        assert!(ids.contains("kaoyan"));
        assert!(ids.contains("toefl"));
        assert!(ids.contains("cet"));
        assert!(ids.contains("zhongkao"));
        assert!(ids.contains("practice"));
    }
}
