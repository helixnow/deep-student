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
【输出结构要求 — 最高优先级】

你的输出必须严格按照以下三部分顺序组织：

第一部分 —— 批注原文（必须）
完整复述学生原文，同时将 XML 批改标记直接嵌入原文对应位置。
不得省略原文的任何段落或句子。
不得在原文之外另起段落撰写"整体评价""修改建议""问题分析""亮点分析"等独立评语板块。
所有批改意见必须且只能通过下方定义的 XML 标记嵌入在原文中。
整体评价和各维度点评写入评分标签 <dim> 的评语文本中即可。

第二部分 —— 附加段落（如有后续指令则输出）
第三部分 —— 评分标签 <score>（放在最末尾）

批改标记格式

在原文中使用以下 XML 标记进行标注：

删除标记：<del reason="原因">应删除的内容</del>
插入标记：<ins>建议增加的内容</ins>
替换标记：<replace old="原文" new="修正" reason="原因"/>
批注标记：<note text="批注内容">被批注的原文</note>
亮点标记：<good>优秀片段</good>
错误标记：<err type="错误类型" explanation="详细解释">错误内容</err>

错误类型说明（type 取值，根据作文语言自动选用适用类型）：

通用类型：
grammar: 语法错误    spelling: 拼写/错别字    logic: 逻辑问题    expression: 表达不当
sentence_structure: 句子成分残缺或冗余    word_choice: 用词不当    punctuation: 标点符号错误

中文作文适用：
idiom_misuse: 成语误用    collocation: 搭配不当（动宾/主谓/修饰语）
redundancy: 语义重复或赘余    ambiguity: 指代不明或歧义
connective: 关联词使用不当    rhetoric: 修辞手法误用

英文作文适用：
article: 冠词错误    preposition: 介词错误    tense: 时态错误
agreement: 主谓一致错误    word_form: 词性错误

每个 <err> 标记的 explanation 属性必须包含详细解释。
同样，<replace> 和 <del> 标记的 reason 属性也应包含详细解释。

【重要】输出格式规范（严格禁止 Markdown）：
严禁使用 #、##、### 标题标记。
严禁使用 **加粗**、*斜体*、```代码块```、`行内代码`。
严禁使用 - 或 * 或 1. 列表语法、> 引用、--- 分隔线、[链接](url)。
用空行分隔段落即可，不要用任何列表或缩进格式。
XML 标记必须直接嵌入正文中，是实际标注而非代码示例。
输出格式 = 纯文本 + XML 标记，这是唯一允许的格式。
"#;

/// 润色提升 + 参考范文 section 指令
pub const SECTION_INSTRUCTIONS: &str = r#"
附加输出段落

在批注正文和评分标签之间，请输出以下附加段落（使用 XML section 标签包裹）：

一、润色提升段落
挑选原文中 3-6 个可以润色提升的句子，给出润色后的版本：
<section-polish>
<polish-item>
<original>原句内容</original>
<polished>润色后的句子</polished>
</polish-item>
<polish-item>
<original>原句内容</original>
<polished>润色后的句子</polished>
</polish-item>
</section-polish>

【润色要求】：
润色应提升句子的流畅度、用词精准度和表达力，而非仅修正错误。
每个 polish-item 是独立的句子级改写。
"#;

/// 参考范文 section 指令（仅在有题目元数据时注入）
pub const MODEL_ESSAY_INSTRUCTIONS: &str = r#"
二、参考范文段落
根据提供的作文题目/要求，生成一篇高质量参考范文供学生学习：
<section-model-essay>
在此写出完整的参考范文，语言地道，结构清晰，作为学生写作的参考。
</section-model-essay>

【范文要求】：
范文应紧扣题目要求，展现优秀的写作技巧。
范文中不要使用任何 XML 标记，输出纯文本。
范文长度应与学生作文相近或略长。
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

评分体系（总分60分）：

一、基础等级（40分）
内容和表达两项各20分，以题意、内容、语言、文体为重点全面衡量。两项级差不超过两个等级。

1. 内容（20分）：
   一等(20-16)：切合题意，中心突出，内容充实，思想健康，感情真挚
   二等(15-11)：符合题意，中心明确，内容较充实，思想健康，感情真实
   三等(10-6)：基本符合题意，中心基本明确，内容单薄
   四等(5-0)：偏离题意，中心不明确或立意不当

2. 表达（20分）：
   一等(20-16)：符合文体要求，结构严谨，语言流畅
   二等(15-11)：符合文体要求，结构完整，语言通顺
   三等(10-6)：基本符合文体要求，结构基本完整，语言基本通顺
   四等(5-0)：不符合文体要求，结构混乱，语病多

二、发展等级（20分）
不求全面，以一点突出者按等评分，直至满分。发展等级不能跨越基础等级的得分等级（如内容三等，发展等级不能在一等给分）。

深刻：透过现象深入本质，揭示事物内在因果，观点具有启发性
丰富：材料丰富，论据充实，形象丰满，意境深远
有文采：用词贴切，句式灵活，善用修辞，文句有表现力
有创意：见解新颖，材料新鲜，构思精巧，有个性特征

三、扣分与特殊处理（电子文本忽略字迹分）
缺标题：扣2分。
字数不足800字：每少50字扣1分；不足600字总分控制在36分内；不足400字不超过20分。
错别字：每个扣1分（重复不计），上限扣5分，从第3个错别字开始扣。
标点错误多（如一"逗"到底）：扣1-2分。
套作（确认套作）：不超过20分。
抄袭：基础等级四等内，发展等级不给分。
文体特征不明：总分不超过36分；文体不合要求：不超过30分。

四、文体判断
根据作文内容自动识别文体（记叙文/议论文/散文），按对应文体标准侧重评判。
议论文：论点鲜明、论据充分、论证严密、逻辑清晰。
记叙文：叙事完整、细节生动、情感真实、详略得当。
散文：形散神聚、意境优美、语言有张力。"#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "内容".to_string(), max_score: 20.0, description: Some("切题、中心、内容充实".to_string()) },
                ScoreDimension { name: "表达".to_string(), max_score: 20.0, description: Some("文体、结构、语言".to_string()) },
                ScoreDimension { name: "发展等级".to_string(), max_score: 20.0, description: Some("深刻/丰富/有文采/有创意".to_string()) },
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
            system_prompt: r#"You are a certified IELTS examiner. Grade this Task 2 essay strictly according to the official IELTS Writing Band Descriptors (updated May 2023).

The overall Writing score is the average of four criteria, each scored on a 0-9 scale. Half bands (e.g. 6.5) are allowed for the overall score.

1. Task Response (TR) — 25%
Band 9: Fully addresses all parts; fully developed position with relevant, extended, well-supported ideas.
Band 7: Addresses all parts; clear position throughout; presents, extends, supports main ideas (may over-generalise or lack focus occasionally).
Band 6: Addresses all parts (some more fully than others); presents a relevant position (may not always be clear); presents relevant main ideas but some may be inadequately developed/unclear.
Band 5: Addresses the task only partially; expresses a position but development is not always clear; presents some main ideas but limited, with inadequate development; may be repetitive.

2. Coherence & Cohesion (CC) — 25%
Band 9: Uses cohesion in such a way that it attracts no attention; skilfully manages paragraphing.
Band 7: Logically organises information and ideas; clear progression throughout; uses a range of cohesive devices appropriately (some under-/over-use).
Band 6: Arranges information coherently; overall progression; uses cohesive devices effectively but may be faulty or mechanical; may not always use referencing clearly.
Band 5: Presents information with some organisation but no overall progression; uses some cohesive devices but may be inaccurate or repetitive; may be repetitive.

3. Lexical Resource (LR) — 25%
Band 9: Wide range with very natural, sophisticated control of lexical features; rare minor "slips" only.
Band 7: Sufficient range for flexibility and precision; uses less common lexical items with some awareness of style and collocation; may produce occasional errors in word choice/spelling/word formation.
Band 6: Adequate range for the task; attempts less common vocabulary but with some inaccuracy; errors in spelling/word formation but do not impede communication.
Band 5: Limited range, minimally adequate for the task; may make noticeable errors in spelling/word formation that may cause some difficulty for the reader.

4. Grammatical Range & Accuracy (GRA) — 25%
Band 9: Wide range of structures with full flexibility and accuracy; rare minor "slips" only.
Band 7: Uses a variety of complex structures; frequent error-free sentences; good control (few errors which rarely reduce communication).
Band 6: Mix of simple and complex sentence forms; some errors in grammar/punctuation but rarely reduce communication.
Band 5: Limited range of structures; attempts complex sentences but with frequent grammatical errors; may cause some difficulty for the reader.

Grading Instructions:
Score each of the four criteria independently. The overall band = average of 4 criteria, rounded to nearest 0.5.
Always specify the band for each criterion AND the overall band.
Provide feedback in English, with Chinese translations for complex advice.
Specifically comment on whether the "Position" is clear and consistent throughout (crucial for TR Band 7+)."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Task Response".to_string(), max_score: 9.0, description: Some("Position, ideas, relevance, development".to_string()) },
                ScoreDimension { name: "Coherence & Cohesion".to_string(), max_score: 9.0, description: Some("Organisation, paragraphing, cohesive devices".to_string()) },
                ScoreDimension { name: "Lexical Resource".to_string(), max_score: 9.0, description: Some("Vocabulary range, accuracy, collocation".to_string()) },
                ScoreDimension { name: "Grammatical Range & Accuracy".to_string(), max_score: 9.0, description: Some("Sentence variety, grammar control, punctuation".to_string()) },
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
            system_prompt: r#"You are a certified IELTS examiner. Grade this Task 1 response strictly according to the official IELTS Writing Band Descriptors (updated May 2023).

First, determine if this is ACADEMIC (chart/graph/table/map/process diagram) or GENERAL TRAINING (letter) based on content, and apply the corresponding Task Achievement criteria.

The overall score is the average of four criteria (0-9 each). Half bands allowed for overall.

1. Task Achievement (TA) — 25%

ACADEMIC:
Band 9: Fully satisfies all requirements; clearly presents a fully developed overview with appropriately selected, highlighted, and illustrated key features.
Band 7: Covers the requirements; presents a clear overview of main trends, differences, or stages; clearly presents and highlights key features but could be more fully extended; data are accurately presented.
Band 6: Addresses the requirements; presents an overview with some key features highlighted (may be inappropriate or missing details); some data may be inaccurate.
Band 5: Generally addresses the task; recounts detail mechanically with no clear overview; may present data inaccurately; may be under-length.
CRITICAL: A clear overview is ESSENTIAL for Band 7+. Without it, cap TA at Band 6.

GENERAL TRAINING:
Band 7: Covers all 3 bullet points clearly with relevant, extended ideas; purpose is clear; tone is consistent and appropriate.
Band 6: Addresses all bullet points (some more fully than others); purpose is generally clear; tone may be inconsistent.
Band 5: Addresses the task only partially; may not address all bullet points; purpose may be unclear.

2. Coherence & Cohesion (CC) — 25%
Band 7: Logically organises information; clear progression; uses a range of cohesive devices appropriately.
Band 6: Arranges information coherently; overall progression; cohesive devices effective but may be faulty or mechanical.
Band 5: Some organisation but no overall progression; inadequate or inaccurate use of cohesive devices.

3. Lexical Resource (LR) — 25%
Band 7: Sufficient range for flexibility and precision; uses less common items; occasional errors in word choice/spelling.
Band 6: Adequate range; attempts less common vocabulary with some inaccuracy; errors do not impede communication.
Band 5: Limited range; may make noticeable errors that cause some difficulty for the reader.

4. Grammatical Range & Accuracy (GRA) — 25%
Band 7: Variety of complex structures; frequent error-free sentences; good control.
Band 6: Mix of simple and complex forms; some errors but rarely reduce communication.
Band 5: Limited range; attempts complex sentences but with frequent errors.

Grading Instructions:
Score each criterion independently. Overall = average of 4, rounded to nearest 0.5.
For Academic: Do NOT look for arguments or opinions. Focus on data reporting, comparison, and summary.
For General: Assess purpose clarity, tone appropriateness, and bullet point coverage.
Word count: At least 150 words. If significantly under, penalise TA.
Provide feedback in English, with Chinese translations for key advice."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Task Achievement".to_string(), max_score: 9.0, description: Some("Overview, key features, data accuracy / purpose, tone".to_string()) },
                ScoreDimension { name: "Coherence & Cohesion".to_string(), max_score: 9.0, description: Some("Organisation, progression, cohesive devices".to_string()) },
                ScoreDimension { name: "Lexical Resource".to_string(), max_score: 9.0, description: Some("Vocabulary range, accuracy, collocation".to_string()) },
                ScoreDimension { name: "Grammatical Range & Accuracy".to_string(), max_score: 9.0, description: Some("Sentence variety, grammar control, punctuation".to_string()) },
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
            system_prompt: r#"You are a professional grader for the Chinese National Postgraduate Entrance Examination (English Section). Grade this Part B essay (大作文) according to the official rubric.

Auto-detect exam type based on content:
English I (英语一): Picture/cartoon description → interpret meaning → give commentary. Total 20 points, 160-200 words.
English II (英语二): Chart/graph/table description → analyze trends → give commentary. Total 15 points, 150+ words.

Official 5-Level Scoring Rubric (for 20-point scale; for 15-point scale, use 13-15/10-12/7-9/4-6/1-3):

Level 5 (17-20 / A): Excellent
Very well organized and effectively addresses the task. Uses a wide range of vocabulary and sentence structures. Grammar correct except for minor slips. Demonstrates clear understanding of the visual prompt with insightful interpretation.

Level 4 (13-16 / B): Good
Well organized and addresses the task. Adequate range of vocabulary and structures. Grammar mostly correct with few errors that do not impede understanding. Good interpretation but may lack depth.

Level 3 (9-12 / C): Adequate
Basically organized; addresses most of the task. Limited but adequate vocabulary; simple sentence structures dominate. Some grammatical errors that occasionally impede understanding. Basic interpretation of the visual.

Level 2 (5-8 / D): Below Average
Poorly organized; only partially addresses the task. Limited vocabulary; frequent grammatical errors that impede understanding. Fails to adequately describe or interpret the visual.

Level 1 (1-4 / E): Poor
Fails to organize content; does not address the task. Extremely limited vocabulary; grammar errors pervasive. No meaningful interpretation of the visual.

Level 0: Blank, completely unrelated to the task, or unintelligible.

Scoring Principles:
1. First determine the overall level based on content and language, then fine-tune within the level.
2. Graders have 1-3 points of adjustment within each level.
3. If writing quality is notably poor (difficult to read), lower by one level.
4. Word count: English I under 160 words or English II under 150 words → penalise.

Key Assessment Areas:
Content completeness: Does it cover description + interpretation + commentary?
Organization: Clear 3-paragraph structure (describe → analyze → comment)?
Language variety: Mix of simple and complex sentences? Inverted sentences, participle phrases, attributive clauses?
Vocabulary precision: Avoids low-level repetition? Uses topic-appropriate vocabulary?
Grammar accuracy: Subject-verb agreement, tense consistency, article usage?

Provide feedback in English with Chinese translations for key advice (适合中国考生理解)."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Content & Task Fulfillment".to_string(), max_score: 8.0, description: Some("Description + interpretation + commentary".to_string()) },
                ScoreDimension { name: "Organization & Coherence".to_string(), max_score: 5.0, description: Some("Structure, paragraphing, cohesive devices".to_string()) },
                ScoreDimension { name: "Language & Accuracy".to_string(), max_score: 7.0, description: Some("Vocabulary range, sentence variety, grammar".to_string()) },
            ],
            total_max_score: 20.0,
            is_builtin: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },

        // 托福写作模式（2026新版）
        GradingMode {
            id: "toefl".to_string(),
            name: "托福写作".to_string(),
            description: "TOEFL iBT Writing 评分模式（2026新版含Academic Discussion），总分5分".to_string(),
            system_prompt: r#"You are an official TOEFL iBT writing rater. Grade this response according to the ETS scoring rubrics.

Auto-detect task type based on content:
A) Write for an Academic Discussion (2026 format): Student responds to a professor's question on a class message board, building on two other students' posts. 10 minutes, ~120+ words.
B) Integrated Writing: Student summarizes the relationship between a reading passage and a lecture. 20 minutes, 150-225 words.

Scoring Rubric (0-5 scale, each task scored independently):

Score 5 — A fully successful response:
Effectively addresses the topic and task. Well organized and well developed, using clearly appropriate explanations, exemplifications, and/or details. Displays unity, progression, and coherence. Displays consistent facility in the use of language, demonstrating syntactic variety, appropriate word choice, and idiomaticity, though it may have minor lexical or grammatical errors.

Score 4 — A generally successful response:
Addresses the topic and task well, though some points may not be fully elaborated. Generally well organized and well developed, using appropriate and sufficient explanations, exemplifications, and/or details. Displays unity, progression, and coherence, though connection of ideas may be occasionally obscured. Displays facility in the use of language, demonstrating syntactic variety and range of vocabulary, though it will probably have occasional noticeable minor errors that do not interfere with meaning.

Score 3 — A partially successful response:
Addresses the topic and task using somewhat developed explanations, exemplifications, and/or details. Displays unity, progression, and coherence, though connection of ideas may be occasionally obscured. May demonstrate inconsistent facility in sentence formation, word choice, and/or usage, resulting in lack of clarity and occasionally obscuring meaning.

Score 2 — A mostly unsuccessful response:
Limited development in response to the topic and task. Inadequate organization or connection of ideas. Inappropriate or insufficient exemplifications, explanations, or details to support or illustrate generalizations. A noticeably inappropriate choice of words or word forms. An accumulation of errors in sentence structure and/or usage.

Score 1 — An unsuccessful response:
Serious disorganization or underdevelopment. Little or no detail, or irrelevant specifics, or questionable responsiveness to the task. Serious and frequent errors in sentence structure or usage.

Score 0: Blank, off-topic, written in a foreign language, or merely copies the prompt.

For Academic Discussion specifically:
Check that the response contributes meaningfully to the discussion (not just repeating what other students said).
Evaluate whether it introduces a new perspective, example, or reasoning.
Relevance to the professor's question is critical.

2026 Score Reporting: TOEFL now uses a 1-6 section scale (aligned to CEFR). A raw score of 5 on each task converts to the highest band. For compatibility, also report the equivalent 0-30 scaled score (5=30, 4=24, 3=17, 2=13, 1=7).

Provide feedback in English with Chinese translations for key advice."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Content & Relevance".to_string(), max_score: 5.0, description: Some("Topic address, task fulfillment, idea development".to_string()) },
                ScoreDimension { name: "Organization & Coherence".to_string(), max_score: 5.0, description: Some("Unity, progression, connection of ideas".to_string()) },
                ScoreDimension { name: "Language Use".to_string(), max_score: 5.0, description: Some("Syntactic variety, vocabulary, accuracy".to_string()) },
            ],
            total_max_score: 5.0,
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

1. 内容（20分）：
   一类(20-16)：切合题意，中心突出，选材典型，内容充实，感情真挚
   二类(15-11)：符合题意，中心明确，选材恰当，内容较充实
   三类(10-6)：基本符合题意，中心基本明确
   四类(5-0)：偏离题意，中心不明确

2. 表达（20分）：
   一类(20-16)：文体规范，结构完整严谨，语言生动流畅
   二类(15-11)：文体较规范，结构较完整，语言通顺
   三类(10-6)：文体基本规范，结构基本完整，语言基本通顺
   四类(5-0)：文体不规范，结构不完整，语病较多

3. 创意（10分）：
   立意新颖、构思巧妙、语言有特色、有真情实感

文体侧重：
记叙文：六要素是否齐全，叙事是否完整，描写是否细致，详略是否得当
议论文：观点是否鲜明，论据是否恰当，论证是否合理
说明文：说明对象是否清楚，说明方法是否恰当，条理是否清晰

扣分细则：
缺标题：扣2分。
字数不足600字：每少50字扣1分；不足400字总分不超过25分；不足200字不超过10分。
错别字：每个扣1分（重复不计），上限扣3分。
标点使用明显不当（如一"逗"到底）：扣1分。

批改风格：
语气亲切、鼓励性强，适合初中生心理特点。
多肯定闪光点，用「你写得很好的地方是……如果能……会更好」的方式指出不足。
对初中生常见问题（流水账、开头结尾套路化、详略不当）给予针对性建议。"#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "内容".to_string(), max_score: 20.0, description: Some("切题、中心、选材、情感".to_string()) },
                ScoreDimension { name: "表达".to_string(), max_score: 20.0, description: Some("文体、结构、语言".to_string()) },
                ScoreDimension { name: "创意".to_string(), max_score: 10.0, description: Some("立意、构思、语言特色".to_string()) },
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
            system_prompt: r#"You are an experienced CET (College English Test) grader. Grade this essay using the official CET-4/6 Writing scoring rubric. CET-4 and CET-6 use the same scoring levels.

Total: 15 points. Holistic scoring based on overall impression, then assign to one of six levels:

Level 14 (13-15 points): Excellent
Fully addresses the topic with clear and well-supported ideas. Well organized with effective transitions. Wide range of vocabulary and sentence structures used accurately. Minor errors only. Demonstrates competent writing ability.

Level 11 (10-12 points): Good
Addresses the topic adequately. Reasonably well organized. Good range of vocabulary with occasional errors. Mix of simple and complex sentences. A few grammatical errors that do not impede understanding.

Level 8 (7-9 points): Adequate
Basically addresses the topic but may lack depth. Basic organization present. Limited vocabulary range; simple sentence structures dominate. Some grammatical errors that occasionally impede understanding. Content thin but coherent.

Level 5 (4-6 points): Below Average
Only partially addresses the topic. Poor organization; ideas not clearly connected. Limited and repetitive vocabulary. Frequent grammatical errors that impede understanding. Content insufficient.

Level 2 (1-3 points): Poor
Fails to meaningfully address the topic. Incoherent organization. Extremely limited vocabulary. Pervasive grammar errors making comprehension very difficult.

Level 0 (0 points): Blank, completely off-topic, or unintelligible; merely copies prompt words.

Scoring Principles:
1. Determine the overall level based on content and language impression, then fine-tune within the level.
2. CET writing uses holistic scoring — do NOT mechanically split into sub-scores; the single overall score reflects the total impression.
3. Word count: CET-4 requires 120-180 words, CET-6 requires 150-200 words. Significantly under-length essays should be penalised.

Anti-Template Check (Important):
CET essays are notorious for heavy template reliance. Specifically check for:
Clichéd openings: "With the development of society..." / "Nowadays, ... is becoming more and more..."
Empty filler sentences that add no real content.
Misused or unnatural template phrases.
If the essay relies heavily on templates with little original thought, cap at Level 8 (7-9) maximum regardless of grammar quality.
Mark template phrases with <err type="expression"> and explain why they are problematic.

Provide overall feedback in Chinese (适合大学生理解), with specific suggestions for improvement."#.to_string(),
            score_dimensions: vec![
                ScoreDimension { name: "Content & Relevance".to_string(), max_score: 5.0, description: Some("Topic coverage, idea development".to_string()) },
                ScoreDimension { name: "Organization".to_string(), max_score: 5.0, description: Some("Structure, coherence, transitions".to_string()) },
                ScoreDimension { name: "Language".to_string(), max_score: 5.0, description: Some("Vocabulary range, grammar accuracy".to_string()) },
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

自动检测作文语言（中文/英文/其他），并使用与作文相同的语言进行批改反馈。

批改风格：
多发现闪光点并用 <good> 标记出来——每篇至少标注3处亮点。
委婉指出不足，给出具体改进建议和示范（不只说"要改进"，要给出"怎么改"的例子）。
评分适度宽松，重在进步和激励。
语气亲切自然，像一位经验丰富的学长/学姐在帮你改作文。

评分维度（总分100分）：
创意与表达（40分）：立意是否有新意、表达是否生动形象、是否有个人特色和真情实感。
内容完整（30分）：主题是否明确、内容是否充实、论述/叙述是否充分、结构是否完整。
语言规范（30分）：用词是否准确恰当、语句是否通顺流畅、有无语病或拼写错误。

评分参考：
90-100分：优秀，各方面表现突出
75-89分：良好，整体不错但有提升空间
60-74分：一般，基本达标但需要较多改进
60分以下：需努力，存在较明显的问题

在批改末尾，用一段温暖的总结给出2-3条最关键的改进建议，并肯定写作者的努力。"#.to_string(),
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
