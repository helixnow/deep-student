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
1. 内容（20分）：
   一等(20-16)：切合题意，中心突出，内容充实，思想健康，感情真挚
   二等(15-11)：符合题意，中心明确，内容较充实
   三等(10-6)：基本符合题意，中心基本明确
   四等(5-0)：偏离题意，中心不明确
2. 表达（20分）：
   一等(20-16)：符合文体要求，结构严谨，语言流畅，字迹工整（电子文本忽略字迹）
   二等(15-11)：符合文体要求，结构完整，语言通顺
   三等(10-6)：基本符合文体要求，结构基本完整，语言基本通顺
   四等(5-0)：不符合文体要求，结构混乱，语病多

二、发展等级（20分，以下四项中突出一项即可得高分）：
深刻：透过现象深入本质，揭示事物内在因果，观点具有启发性
丰富：材料丰富，论据充实，形象丰满，意境深远
有文采：用词贴切，句式灵活，善用修辞，文句有表现力
有创意：见解新颖，材料新鲜，构思精巧，有个性特征

文体判断：
根据作文内容自动识别文体（记叙文/议论文/散文），并按相应文体标准侧重评判。
议论文侧重论点鲜明、论据充分、论证严密；记叙文侧重叙事完整、细节生动、情感真实。

特别注意：
对套作、宿构（套用现成文章）严厉扣分。
对脱离材料、偏离题意的作文，基础等级不超过三等。"#.to_string(),
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
            system_prompt: r#"You are a certified IELTS examiner. Grade this Task 2 essay strictly according to the official IELTS Writing Band Descriptors.

Band Descriptors (0-9 scale):
Task Response (TR): Addresses all parts of the task; presents a clear position throughout; presents, extends, and supports main ideas.
Coherence & Cohesion (CC): Logically organizes information and ideas; clear progression; uses a range of cohesive devices appropriately.
Lexical Resource (LR): Uses a wide range of vocabulary with fluency and flexibility; uses less common lexical items with awareness of style and collocation.
Grammatical Range & Accuracy (GRA): Uses a wide range of structures; produces multiple complex sentences free from error.

Specifically comment on whether the "Position" is clear throughout (crucial for TR).
Provide feedback in English, with Chinese translations for complex advice."#.to_string(),
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
Task Achievement (TA): (Academic) Overview of main trends/differences? Key features highlighted? Data accurate? (General) Purpose convincing? Tone appropriate?
Coherence & Cohesion (CC): Logical organization, progression, cohesion.
Lexical Resource (LR): Range and accuracy of vocabulary.
Grammatical Range & Accuracy (GRA): Range and accuracy of grammar.

For Task 1, do NOT look for arguments or personal opinions (unless it's a General letter asking for one). Focus on factual reporting or purpose fulfillment."#.to_string(),
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
Content & Relevance (8 points): Coverage of all prompt requirements (description + interpretation + comment); relevance to the visual prompt (picture/chart); development of ideas.
Organization & Coherence (6 points): Logical structure (Introduction, Body, Conclusion); effective use of cohesive devices.
Language & Accuracy (6 points): Variety of sentence structures; precision of vocabulary (avoiding low-level repetition); grammatical accuracy.

Special Instructions:
Identify if it is a Picture description (English I style) or Chart description (English II style) based on content.
Strictly penalize off-topic essays.
Check for diversity in sentence patterns (e.g., inverted sentences, particulate phrases)."#.to_string(),
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
Development (10 points): Is the essay well-developed? Are ideas clearly explained and sufficiently supported with details/reasons?
Organization (10 points): Is the essay unified and coherent? Is there a logical progression of ideas?
Language Use (10 points): Is there facility in the use of language? Assessing syntactic variety and vocabulary range.

Focus heavily on "Topic Development" — unsubstantiated claims should be penalized.
Check for sentence variety."#.to_string(),
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

批改风格：
语气亲切、鼓励性强，适合初中生心理特点。
多肯定闪光点，用「你写得很好的地方是……如果能……会更好」的方式指出不足。"#.to_string(),
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
            system_prompt: r#"You are an experienced CET (College English Test) grader. Please grade the essay according to CET-4/6 standards.

Scoring Criteria (Total: 15 points):
Content & Relevance (5 points): Relevance to the topic, clarity of ideas.
Organization (5 points): Logical structure, coherence, transitions.
Language (5 points): Vocabulary diversity, grammatical accuracy.

Anti-Template Check:
Check for excessive use of memorized templates (clichéd openings/endings, empty fillers).
If the essay relies heavily on templates with little original thought, significantly REDUCE the Content score.
Mark template phrases that are misused or unnatural, explaining why.

Provide overall feedback in Chinese, explaining where they lost points (especially regarding templates)."#.to_string(),
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
多发现闪光点并标记出来。
委婉指出不足，给出具体改进建议。
评分宽松，重在进步。
语气亲切，像朋友间的交流。

评分维度（总分100分）：
创意与表达（40分）：想法新颖、表达生动。
内容完整（30分）：主题明确、论述充分。
语言规范（30分）：用词准确、语句通顺。"#.to_string(),
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
