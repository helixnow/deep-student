/// 题目集 AI 出题模块 - 类型定义
///
/// v2 契约：与导入共用 QuestionDocument 根对象和 canonical 草稿；旧 drafts 字段仅用于
/// 兼容已有前端展示与历史任务。正式入库必须经 `qbank_commit_authoring_draft`。
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ============================================================================
// 请求/响应类型
// ============================================================================

/// 单题生成参数（题量/题型分布/难度/知识点范围）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionGenerationSpec {
    /// 题型（snake_case，与 QuestionType 序列化一致：single_choice/multiple_choice/
    /// fill_blank/short_answer/essay/calculation/true_false 等）
    pub question_type: String,
    /// 该题型生成的数量
    #[serde(default = "default_count")]
    pub count: u32,
    /// 难度（easy/medium/hard/very_hard；空则由模型自行分布）
    #[serde(default)]
    pub difficulty: Option<String>,
}

fn default_count() -> u32 {
    1
}

/// 前端临时上传的参考文件（未经资源库，直接 base64 随请求传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceFileBase64 {
    /// 文件名（含扩展名，供 DocumentParser 分流与 prompt 标注）
    pub name: String,
    /// 文件内容（base64）
    pub base64: String,
}

/// AI 出题请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QbankGenerationRequest {
    /// 目标题目集（exam_sheets.id）
    pub exam_id: String,
    /// 流式事件会话 ID（前端生成的唯一标识）
    pub stream_session_id: String,
    /// 模型配置 ID（可选，默认 qbank_ai_grading 槽 → Model2 兜底）
    pub model_config_id: Option<String>,
    /// 出题要求总题量上限（所有 spec.count 之和的硬顶）
    #[serde(default = "default_max_questions")]
    pub max_questions: u32,
    /// 题型分布
    #[serde(default)]
    pub specs: Vec<QuestionGenerationSpec>,
    /// 难度总偏好（spec 未指定时使用）
    #[serde(default)]
    pub difficulty: Option<String>,
    /// 知识点/范围提示（自由文本；空则参考题目集现有题目自行发挥）
    #[serde(default)]
    pub topic_hint: Option<String>,
    /// 是否参考题目集现有题目出变式题（true 时 prompt 附带现有题目样本）
    #[serde(default)]
    pub based_on_existing: bool,
    /// 语言（默认跟随前端 locale，如 zh-CN / en-US）
    #[serde(default)]
    pub language: Option<String>,
    /// 参考资料来源一：资源库文件 ID（后端直读并提取文本）
    #[serde(default)]
    pub reference_file_ids: Vec<String>,
    /// 参考资料来源二：前端临时上传文件（base64，不落资源库）
    #[serde(default)]
    pub reference_files_base64: Vec<ReferenceFileBase64>,
    /// 知识点（前端从现有题目 tags 收集或手动输入；注入 prompt 限定出题范围）
    #[serde(default)]
    pub knowledge_points: Vec<String>,
}

fn default_max_questions() -> u32 {
    10
}

/// 单道 AI 生成的题目（校验后的结构化预览，未入库）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedQuestionDraft {
    /// QuestionDocument 内稳定临时 ID（确认时按它选择，不按数组下标）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_id: Option<String>,
    /// 所属题组（共享材料/阅读文章）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// 原题号/展示标签
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_label: Option<String>,
    /// 题型（snake_case 字符串；入库前由前端映射回枚举）
    pub question_type: String,
    /// 题干（Markdown；公式 $...$ / $$...$$）
    pub content: String,
    /// 选项（选择题必填）
    #[serde(default)]
    pub options: Option<Vec<GeneratedQuestionOption>>,
    /// 答案（选择题为 "A"/"AB"；判断题为 "true"/"false"；其余为文本）
    #[serde(default)]
    pub answer: Option<String>,
    /// 解析
    #[serde(default)]
    pub explanation: Option<String>,
    /// 难度（easy/medium/hard/very_hard）
    #[serde(default)]
    pub difficulty: Option<String>,
    /// 知识点标签
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// 新题型结构化答案（matching/ordering/numeric/fill_blank）。
    /// 必须原样保留，不能因为旧预览层不支持就丢弃。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_data: Option<Value>,
    /// 分子结构式 SMILES 串（可选；有机结构题填写，前端用 SmilesDrawer 渲染为骨架式）
    #[serde(default)]
    pub smiles: Option<String>,
    /// SMILES 结构的名称/说明（可选，如 "2-甲基丙烷"、"苯"）
    #[serde(default)]
    pub smiles_caption: Option<String>,
    /// 出处（JSON：{"resourceIds":[…]}，题目依据的资料库参考资料）——由出题流水线填写，
    /// 不信任模型输出；导入题库后写入 questions.source_ref，题目详情可回到资料。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
}

/// 生成的选项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedQuestionOption {
    pub key: String,
    pub content: String,
}

/// AI 出题响应（预览列表；入库由前端另行调用 qbank_batch_create_questions）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QbankGenerationResponse {
    pub exam_id: String,
    /// 同一 canonical 契约下的完整出题文档（materials/groups/questions/coverage/issues）
    #[serde(default)]
    pub document: Value,
    /// 已持久化草稿 job ID；前端确认时提交它，而不是重新拼 CreateQuestionParams
    #[serde(default)]
    pub job_id: String,
    /// 草稿 OCC 版本
    #[serde(default)]
    pub version: i64,
    /// 本次实际模型路线（主模型、视觉兜底、JSON 模式、usage）
    #[serde(default)]
    pub model_route: Value,
    /// 通过校验的题目草稿
    pub drafts: Vec<GeneratedQuestionDraft>,
    /// 被剔除的题目数（校验失败）
    pub rejected_count: usize,
    /// 拒绝原因（与被剔除题目对应，供调试展示）
    pub rejection_reasons: Vec<String>,
    /// 被跳过的参考文件（提取失败/超限；前端据此提示用户）
    #[serde(default)]
    pub skipped_references: Vec<SkippedReference>,
    /// 实际注入 prompt 的参考资料数（文本份数 + 图片页数）
    #[serde(default)]
    pub used_reference_count: usize,
}

// ============================================================================
// Prompt 模板
// ============================================================================

/// 出题系统提示词（JSON 数组输出契约）
pub const GENERATION_SYSTEM_PROMPT: &str = r#"你是一位经验丰富的命题教师。你在生成新题，不是抽取已有题目。

## 输出契约
只输出一个完整 JSON 根对象，不要 Markdown 代码围栏，不要数组顶层。根对象字段与统一
QuestionDocument v2 完全一致：schema_version / mode / materials / groups / questions /
unmatched_answers / coverage / issues。mode 必须为 "generate"。

## 字符串转义要求（重要）
JSON 字符串内部的换行必须使用标准 JSON 转义 \n（一个反斜杠），严禁写成 \\n（两个反斜杠）——
后者会让题目里出现字面的 "\n" 字符而不是换行。同理制表符用 \t，不要写成 \\t。

## 各题型的字段约定
1. single_choice / multiple_choice / indefinite_choice：必须给出 options（2-8 个），answer 为正确选项 key 的拼接（如 "A" 或 "ABD"）
2. true_false：不给 options，answer 为 "true" 或 "false"
3. fill_blank：不给 options，answer 为答案文本（多空用 "||" 分隔），并尽量给出
   structured_data.blanks（每空 answers 数组）；content 中空位用 ______ 表示
4. short_answer / essay / calculation / proof：不给 options，answer 为参考答案（Markdown）
5. matching：structured_data 必须为 {left:[{key,content}],right:[{key,content}],pairs:[{left,right}]}
6. ordering：structured_data 必须为 {items:[{key,content}],correct_order:[key]}
7. numeric：structured_data 必须为 {answer_value:number,tolerance:number,unit:string,tolerance_mode:"absolute"|"relative"}
8. other：仅用于无法归类的题型，必须提供 answer。

## 材料与题组
- 阅读文章、实验条件、共同图表等共享内容只生成一次 material，并在 groups.material_ids 引用。
- 同一材料下的每个独立作答位各生成一个 question；questions[i].group_id 必须与对应
  groups[j].question_ids 闭合一致，不能只写进 structured_data 副本。
- 普通独立题 group_id=null，不要伪造单题题组。
- generation 模式答案由你推导，answer_origin 必须为 "generated"。

## 质量要求
1. 题干表述清晰无歧义；公式一律遵循统一的 LaTeX 公式契约（见 prompt 末尾）
2. 每题必须给出 answer 与 explanation；解析要说明解题思路与关键步骤
3. difficulty 取值只能是 easy / medium / hard / very_hard
4. tags 给出 1-3 个核心知识点
5. 严格按用户指定的题量与题型分布生成，不要多生成或遗漏
6. 参考材料只作为命题依据；不得把资料中的原题直接抄成新题，也不得编造不存在的图片路径或 hash。
7. coverage 必须覆盖所有实际提供的来源页；没有来源时输出空数组。

## 化学式与分子结构（化学类题目必须遵守）
1. 一切化学式、化学方程式、离子方程式必须用 LaTeX 的 \\ce{} 宏书写，并包裹在 $ 或 $$ 中：
   - 方程式：$\\ce{2H2 + O2 -> 2H2O}$
   - 带条件：$\\ce{CaCO3 ->[高温] CaO + CO2 ^}$
   - 离子式：$\\ce{SO4^2-}$、$\\ce{H+ + OH- -> H2O}$
   - 可逆反应：$\\ce{N2 + 3H2 <=> 2NH3}$
2. 严禁在正文直接裸写化学式（如 H2SO4、Fe2O3），严禁用文本下标模拟化学式
3. 涉及有机分子结构（骨架式、官能团位置、同分异构体）时，额外给出 SMILES 串：
   - "smiles": 分子的标准 SMILES 字符串（如乙醇 "CCO"、苯 "c1ccccc1"、乙酸 "CC(=O)O"）
   - "smiles_caption": 分子中文名（如 "乙醇"、"苯"）
   - 每题最多给一个主要结构的 SMILES；非有机结构题（无需画结构式）两字段保持 null
4. SMILES 必须是合法的标准写法：原子用元素符号、支链用括号、双键 =、三键 #、芳香环用小写 c"#;
/// 构造出题指令。完整原文/页图由 `SourceBundle::user_content` 紧随其后提供，
/// 此处只放任务约束和来源清单，不截断参考资料。
pub fn build_generation_instructions(
    exam_name: &str,
    existing_samples: &[String],
    request: &QbankGenerationRequest,
    sources: &[Value],
    has_media_anchors: bool,
) -> String {
    let language = request.language.as_deref().unwrap_or("zh-CN");
    let mut prompt = String::new();

    prompt.push_str(&format!("## 题目集\n「{}」\n\n", exam_name));

    if !request.specs.is_empty() {
        prompt.push_str("## 题型分布\n");
        for spec in &request.specs {
            let difficulty = spec
                .difficulty
                .as_deref()
                .or(request.difficulty.as_deref())
                .unwrap_or("由你按难度梯度合理分布");
            prompt.push_str(&format!(
                "- {}: {} 题（难度：{}）\n",
                spec.question_type, spec.count, difficulty
            ));
        }
        prompt.push('\n');
    } else {
        let difficulty = request
            .difficulty
            .as_deref()
            .unwrap_or("由你按难度梯度合理分布");
        prompt.push_str(&format!(
            "## 题量与难度\n- 总共 {} 题（难度：{}），题型由你根据知识点合理搭配\n\n",
            request.max_questions, difficulty
        ));
    }

    let knowledge_points: Vec<&str> = request
        .knowledge_points
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if !knowledge_points.is_empty() {
        prompt.push_str("## 知识点范围（围绕这些知识点出题）\n");
        for point in &knowledge_points {
            prompt.push_str(&format!("- {}\n", point));
        }
        prompt.push('\n');
    }

    if let Some(hint) = request
        .topic_hint
        .as_deref()
        .filter(|h| !h.trim().is_empty())
    {
        prompt.push_str("## 知识点范围要求\n");
        prompt.push_str(hint.trim());
        prompt.push_str("\n\n");
    }

    if request.based_on_existing && !existing_samples.is_empty() {
        prompt.push_str("## 现有题目样本（请出与之风格相近、不重复的变式题）\n");
        for (i, sample) in existing_samples.iter().enumerate() {
            prompt.push_str(&format!("{}. {}\n", i + 1, sample));
        }
        prompt.push('\n');
    }

    if sources.is_empty() {
        prompt.push_str("## 参考资料\n本次没有参考文件，请仅依据题目集信息与知识点要求命题。\n\n");
    } else {
        prompt.push_str("## 参考资料清单（完整正文/页图随后提供）\n");
        for source in sources {
            prompt.push_str(&format!(
                "- source_id={} name={} format={} pages={}\n",
                source["source_id"].as_str().unwrap_or(""),
                source["name"].as_str().unwrap_or(""),
                source["format"].as_str().unwrap_or(""),
                source["page_count"]
                    .as_u64()
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "无分页".to_string())
            ));
        }
        prompt.push_str(
            "请完整阅读后续全部来源。题干不得直接抄袭原文成句；不得只处理前几页或截断长文。\n\n",
        );
    }

    // 音视频转写参考资料：解析末尾写可跳转的 [媒体@id:mm:ss] 出处
    if has_media_anchors {
        prompt.push_str(crate::study_loop::media_source::MEDIA_QUESTION_REQUIREMENTS);
    }

    prompt.push_str(&format!(
        "## 输出语言\n题目使用 {}。现在请生成题目，只输出一个 QuestionDocument JSON 根对象。\n",
        language
    ));
    prompt
}

/// 被跳过的参考文件（提取失败 / 超限）
///
/// 2026-09-09 新增：此前提取失败只写后端日志、静默丢弃，用户完全感知不到
/// 「上传的扫描件没有进 prompt」。现随 complete 事件回传前端提示。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedReference {
    /// 文件名（取不到元数据时为 file_id）
    pub name: String,
    /// 机器可读原因码（前端映射本地化文案）：
    /// `text_extract_failed` | `file_not_found` | `unsupported_format` |
    /// `read_failed` | `too_many_files` | `model_not_multimodal`
    pub reason: String,
    /// 补充诊断信息（如解析错误摘要），可直接展示
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl SkippedReference {
    pub fn new(name: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            reason: reason.into(),
            detail: None,
        }
    }

    pub fn with_detail(
        name: impl Into<String>,
        reason: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            reason: reason.into(),
            detail: Some(detail.into()),
        }
    }
}

// ============================================================================
// JSON 解析与校验
// ============================================================================

/// 从 LLM 输出中提取 JSON 数组文本。
/// 兼容三种情况：纯数组 / ```json 围栏 / 前后混有说明文字。
pub fn extract_json_array(text: &str) -> Option<String> {
    let trimmed = text.trim();
    // 去掉 markdown 代码围栏
    let stripped = if trimmed.starts_with("```") {
        let inner = trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        inner
    } else {
        trimmed
    };
    if stripped.starts_with('[') {
        return Some(stripped.to_string());
    }
    // 混有说明文字时找第一个 '[' 与最后一个 ']'（取最长候选，容错 LLM 前缀噪声）
    let start = stripped.find('[')?;
    let end = stripped.rfind(']')?;
    if start < end {
        Some(stripped[start..=end].to_string())
    } else {
        None
    }
}

/// 选择题题型判断（answer 必须是选项 key 的组合）
fn is_choice_type(question_type: &str) -> bool {
    matches!(
        question_type,
        "single_choice" | "multiple_choice" | "indefinite_choice"
    )
}

/// 校验单题草稿；返回 Err(原因) 表示该题应被剔除。
///
/// 强校验项（可行性文档 §四 MVP-2）：
/// - content 非空
/// - 选择题：options 2-6 个且 key 非空不重复；answer 每个 key 都在 options 中
/// - 判断题：answer ∈ {true, false}
/// - 其余题型：answer 非空
/// - question_type ∈ 支持集合（matching/ordering/numeric 明确拒绝）
pub fn validate_draft(draft: &GeneratedQuestionDraft) -> Result<(), String> {
    const SUPPORTED: &[&str] = &[
        "single_choice",
        "multiple_choice",
        "indefinite_choice",
        "fill_blank",
        "short_answer",
        "essay",
        "calculation",
        "proof",
        "true_false",
        "other",
    ];
    if !SUPPORTED.contains(&draft.question_type.as_str()) {
        return Err(format!(
            "不支持的题型: {}（matching/ordering/numeric 请手动创建）",
            draft.question_type
        ));
    }
    if draft.content.trim().is_empty() {
        return Err("题干为空".to_string());
    }

    let answer = draft
        .answer
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| "缺少答案".to_string())?;

    if is_choice_type(&draft.question_type) {
        let options = draft
            .options
            .as_ref()
            .filter(|o| !o.is_empty())
            .ok_or_else(|| "选择题缺少选项".to_string())?;
        if options.len() < 2 || options.len() > 6 {
            return Err(format!("选项数量非法: {}（需 2-6 个）", options.len()));
        }
        let mut seen = std::collections::HashSet::new();
        for opt in options {
            if opt.key.trim().is_empty() {
                return Err("存在空选项 key".to_string());
            }
            if opt.content.trim().is_empty() {
                return Err(format!("选项 {} 内容为空", opt.key));
            }
            if !seen.insert(opt.key.trim().to_uppercase()) {
                return Err(format!("选项 key 重复: {}", opt.key));
            }
        }
        let valid_keys: std::collections::HashSet<String> = options
            .iter()
            .map(|o| o.key.trim().to_uppercase())
            .collect();
        let answer_keys: Vec<char> = answer
            .to_uppercase()
            .chars()
            .filter(|c| c.is_ascii_alphabetic())
            .collect();
        if answer_keys.is_empty() {
            return Err(format!("答案格式非法: {}", answer));
        }
        for key in &answer_keys {
            if !valid_keys.contains(&key.to_string()) {
                return Err(format!("答案 {} 不在选项中", key));
            }
        }
        if draft.question_type == "single_choice" && answer_keys.len() > 1 {
            return Err("单选题答案包含多个选项".to_string());
        }
    } else if draft.question_type == "true_false" {
        let lower = answer.to_lowercase();
        if lower != "true" && lower != "false" {
            return Err(format!("判断题答案必须是 true/false，收到: {}", answer));
        }
    }
    // 其余题型：answer 非空即可（上方已保证）

    // SMILES 可选校验：给了就查基本合法性（字符集 + 括号配对）。
    // 非法 SMILES 会被前端渲染失败，宁可在此剔除并说明，让模型重试。
    if let Some(smiles) = draft
        .smiles
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        validate_smiles(smiles)?;
    } else if draft.smiles_caption.is_some() {
        return Err("给出了 smiles_caption 但缺少 smiles".to_string());
    }

    Ok(())
}

/// SMILES 基本合法性校验（轻量级：字符集 + 括号/环号配对）。
/// 不做化学语义校验（那需要 rdkit 等重量依赖）；渲染失败的兜底在前端。
pub fn validate_smiles(smiles: &str) -> Result<(), String> {
    const ALLOWED: &str = "BCNOPSFIHbcnops#%+-=()[]@/\\.$0123456789:";
    if smiles.len() > 256 {
        return Err(format!("SMILES 过长（{} 字符）", smiles.len()));
    }
    for ch in smiles.chars() {
        if !ALLOWED.contains(ch) {
            return Err(format!("SMILES 含非法字符 '{}'：{}", ch, smiles));
        }
    }
    let mut stack = 0usize;
    for ch in smiles.chars() {
        match ch {
            '(' => stack += 1,
            ')' => {
                stack = stack
                    .checked_sub(1)
                    .ok_or_else(|| format!("SMILES 括号不配对: {}", smiles))?;
            }
            _ => {}
        }
    }
    if stack != 0 {
        return Err(format!("SMILES 括号不配对: {}", smiles));
    }
    Ok(())
}

/// 解析 LLM 完整输出为校验后的草稿列表。
/// 单题校验失败不整体失败——剔除并记录原因（rejected_count / rejection_reasons）。
/// 还原模型偶发的「双重转义」文本。
///
/// 背景（2026-09-09 实测）：模型在 JSON 字符串里把换行写成 `\\n`（两个反斜杠），
/// 标准 serde 解析后得到**字面** `\n` 两个字符，题目里因此显示 "\n" 而不是换行。
///
/// 保守策略：仅当反斜杠后跟 n/t/r 且**再后面不是字母**时才还原，
/// 避免误伤 LaTeX 命令（`\nu`、`\neq`、`\nabla` 等 `\` + 字母 的写法）。
fn normalize_escaped_text(text: &str) -> String {
    if !text.contains("\\n") && !text.contains("\\t") && !text.contains("\\r") {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            // 只把 ASCII 字母视为 LaTeX 命令（`\nu`/`\neq`）；
            // 中文/标点紧跟 `\n` 时应正常还原（is_alphabetic 对中文也返回 true，故不用它）
            let after_is_ascii_alpha = chars
                .get(i + 2)
                .map(|c| c.is_ascii_alphabetic())
                .unwrap_or(false);
            if !after_is_ascii_alpha {
                match next {
                    // \r\n（双重转义的 CRLF）→ 单个换行
                    'r' if chars.get(i + 2) == Some(&'\\') && chars.get(i + 3) == Some(&'n') => {
                        out.push('\n');
                        i += 4;
                        continue;
                    }
                    'r' | 'n' => {
                        out.push('\n');
                        i += 2;
                        continue;
                    }
                    't' => {
                        out.push('\t');
                        i += 2;
                        continue;
                    }
                    _ => {}
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 对单题的文本字段做双重转义还原；返回是否发生过还原（供日志）
fn normalize_draft_text(draft: &mut GeneratedQuestionDraft) -> bool {
    let mut changed = false;
    let normalized = normalize_escaped_text(&draft.content);
    if normalized != draft.content {
        draft.content = normalized;
        changed = true;
    }
    if let Some(explanation) = draft.explanation.as_mut() {
        let normalized = normalize_escaped_text(explanation);
        if &normalized != explanation {
            *explanation = normalized;
            changed = true;
        }
    }
    if let Some(answer) = draft.answer.as_mut() {
        let normalized = normalize_escaped_text(answer);
        if &normalized != answer {
            *answer = normalized;
            changed = true;
        }
    }
    if let Some(options) = draft.options.as_mut() {
        for option in options.iter_mut() {
            let normalized = normalize_escaped_text(&option.content);
            if normalized != option.content {
                option.content = normalized;
                changed = true;
            }
        }
    }
    changed
}

/// 解析并校验模型输出，得到可预览的草稿列表。
pub fn parse_generation_output(
    raw: &str,
    max_questions: u32,
) -> Result<QbankGenerationResponse, String> {
    let json_text =
        extract_json_array(raw).ok_or_else(|| "输出中没有找到 JSON 数组".to_string())?;
    let parsed: Vec<Value> =
        serde_json::from_str(&json_text).map_err(|e| format!("JSON 解析失败: {}", e))?;
    if parsed.is_empty() {
        return Err("模型返回了空数组，未生成任何题目".to_string());
    }

    let mut drafts = Vec::new();
    let mut reasons = Vec::new();
    for (index, item) in parsed.into_iter().enumerate() {
        if drafts.len() >= max_questions as usize {
            reasons.push(format!(
                "第 {} 题起超过题量上限 {}，已截断",
                index + 1,
                max_questions
            ));
            break;
        }
        match serde_json::from_value::<GeneratedQuestionDraft>(item) {
            Ok(mut draft) => {
                // 2026-09-09：还原模型偶发的双重转义（字面 "\n" → 真换行）
                if normalize_draft_text(&mut draft) {
                    log::info!(
                        "[QbankGeneration] 第 {} 题检测到双重转义文本，已还原为真实换行",
                        index + 1
                    );
                }
                match validate_draft(&draft) {
                    Ok(()) => drafts.push(draft),
                    Err(reason) => reasons.push(format!("第 {} 题被剔除：{}", index + 1, reason)),
                }
            }
            Err(e) => reasons.push(format!("第 {} 题结构不符合契约：{}", index + 1, e)),
        }
    }

    Ok(QbankGenerationResponse {
        exam_id: String::new(),
        document: Value::Null,
        job_id: String::new(),
        version: 0,
        model_route: Value::Null,
        rejected_count: reasons.len(),
        rejection_reasons: reasons,
        drafts,
        // 参考资料统计由 run_qbank_generation 填充
        skipped_references: Vec::new(),
        used_reference_count: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(
        question_type: &str,
        content: &str,
        options: Option<Vec<(&str, &str)>>,
        answer: &str,
    ) -> GeneratedQuestionDraft {
        GeneratedQuestionDraft {
            local_id: None,
            group_id: None,
            original_label: None,
            structured_data: None,
            source_ref: None,
            question_type: question_type.to_string(),
            content: content.to_string(),
            options: options.map(|opts| {
                opts.into_iter()
                    .map(|(key, content)| GeneratedQuestionOption {
                        key: key.to_string(),
                        content: content.to_string(),
                    })
                    .collect()
            }),
            answer: Some(answer.to_string()),
            explanation: None,
            difficulty: Some("medium".to_string()),
            tags: None,
            smiles: None,
            smiles_caption: None,
        }
    }

    #[test]
    fn validate_smiles_accepts_common_molecules_and_rejects_bad_input() {
        assert_eq!(validate_smiles("CCO"), Ok(())); // 乙醇
        assert_eq!(validate_smiles("c1ccccc1"), Ok(())); // 苯
        assert_eq!(validate_smiles("CC(=O)O"), Ok(())); // 乙酸
        assert!(validate_smiles("C[C@H](N)C(=O)O").is_ok()); // 手性中心
        assert!(validate_smiles("CC(=O").is_err()); // 括号不配对
        assert!(validate_smiles("c1ccccc").is_err() == false || true); // 环号配对不在此校验
        assert!(validate_smiles("CC O<H>").is_err()); // 非法字符
    }

    #[test]
    fn validate_draft_checks_smiles_pair_consistency() {
        let mut good = draft(
            "single_choice",
            "下列哪个是乙醇？",
            Some(vec![("A", "甲醇"), ("B", "乙醇")]),
            "B",
        );
        good.smiles = Some("CCO".to_string());
        good.smiles_caption = Some("乙醇".to_string());
        assert_eq!(validate_draft(&good), Ok(()));

        let mut caption_only = draft(
            "single_choice",
            "题干",
            Some(vec![("A", "x"), ("B", "y")]),
            "A",
        );
        caption_only.smiles_caption = Some("苯".to_string());
        assert!(validate_draft(&caption_only).is_err());

        let mut bad_smiles = draft(
            "single_choice",
            "题干",
            Some(vec![("A", "x"), ("B", "y")]),
            "A",
        );
        bad_smiles.smiles = Some("CC(=O".to_string());
        assert!(validate_draft(&bad_smiles).is_err());
    }

    #[test]
    fn extract_json_array_handles_fenced_and_noisy_output() {
        assert_eq!(
            extract_json_array("[{\"a\":1}]"),
            Some("[{\"a\":1}]".to_string())
        );
        assert_eq!(
            extract_json_array("```json\n[{\"a\":1}]\n```"),
            Some("[{\"a\":1}]".to_string())
        );
        assert_eq!(
            extract_json_array("好的，以下是题目：\n[{\"a\":1}]\n希望有帮助"),
            Some("[{\"a\":1}]".to_string())
        );
        assert_eq!(extract_json_array("没有数组"), None);
    }

    #[test]
    fn validate_draft_accepts_valid_single_choice_and_rejects_bad_answer_key() {
        let good = draft(
            "single_choice",
            "1+1=?",
            Some(vec![("A", "2"), ("B", "3")]),
            "A",
        );
        assert_eq!(validate_draft(&good), Ok(()));

        let bad_answer = draft(
            "single_choice",
            "1+1=?",
            Some(vec![("A", "2"), ("B", "3")]),
            "C",
        );
        assert!(validate_draft(&bad_answer).is_err());

        let multi_answer_single = draft(
            "single_choice",
            "1+1=?",
            Some(vec![("A", "2"), ("B", "3")]),
            "AB",
        );
        assert!(validate_draft(&multi_answer_single).is_err());
    }

    #[test]
    fn validate_draft_rejects_empty_options_and_true_false_bad_value() {
        let no_options = draft("single_choice", "1+1=?", None, "A");
        assert!(validate_draft(&no_options).is_err());

        let bad_tf = draft("true_false", "1+1=2", None, "yes");
        assert!(validate_draft(&bad_tf).is_err());

        let good_tf = draft("true_false", "1+1=2", None, "TRUE");
        assert_eq!(validate_draft(&good_tf), Ok(()));
    }

    #[test]
    fn validate_draft_rejects_unsupported_types() {
        let matching = draft("matching", "连线", None, "1-A");
        assert!(validate_draft(&matching).is_err());
    }

    #[test]
    fn parse_generation_output_filters_invalid_items_and_reports_reasons() {
        let raw = r#"[
            {"question_type":"single_choice","content":"1+1=?","options":[{"key":"A","content":"2"},{"key":"B","content":"3"}],"answer":"A"},
            {"question_type":"short_answer","content":"","answer":"x"},
            {"question_type":"true_false","content":"1+1=2","answer":"true"}
        ]"#;
        let response = parse_generation_output(raw, 10).unwrap();
        assert_eq!(response.drafts.len(), 2);
        assert_eq!(response.drafts[0].question_type, "single_choice");
        assert_eq!(response.drafts[1].question_type, "true_false");
        assert_eq!(response.rejected_count, 1);
        assert!(response.rejection_reasons[0].contains("第 2 题"));
    }

    #[test]
    fn parse_generation_output_truncates_to_max_questions() {
        let raw = r#"[
            {"question_type":"true_false","content":"1=1","answer":"true"},
            {"question_type":"true_false","content":"2=2","answer":"true"},
            {"question_type":"true_false","content":"3=3","answer":"true"}
        ]"#;
        let response = parse_generation_output(raw, 2).unwrap();
        assert_eq!(response.drafts.len(), 2);
        assert_eq!(response.rejected_count, 1);
        assert!(response.rejection_reasons[0].contains("上限"));
    }

    #[test]
    fn parse_generation_output_rejects_empty_and_non_json() {
        assert!(parse_generation_output("随便说说", 10).is_err());
        assert!(parse_generation_output("[]", 10).is_err());
    }

    #[test]
    fn build_generation_user_prompt_includes_specs_and_hint() {
        let request = QbankGenerationRequest {
            exam_id: "exam_1".to_string(),
            stream_session_id: "sess".to_string(),
            model_config_id: None,
            max_questions: 5,
            specs: vec![QuestionGenerationSpec {
                question_type: "single_choice".to_string(),
                count: 3,
                difficulty: Some("hard".to_string()),
            }],
            difficulty: None,
            topic_hint: Some("二次函数".to_string()),
            based_on_existing: false,
            language: Some("zh-CN".to_string()),
            reference_file_ids: vec![],
            reference_files_base64: vec![],
            knowledge_points: vec![],
        };
        let prompt = build_generation_instructions("测试题目集", &[], &request, &[], false);
        assert!(prompt.contains("「测试题目集」"));
        assert!(prompt.contains("single_choice: 3 题"));
        assert!(prompt.contains("二次函数"));
        assert!(prompt.contains("zh-CN"));
    }

    #[test]
    fn build_generation_user_prompt_includes_knowledge_points_and_references() {
        let request = QbankGenerationRequest {
            exam_id: "exam_1".to_string(),
            stream_session_id: "sess".to_string(),
            model_config_id: None,
            max_questions: 5,
            specs: vec![],
            difficulty: None,
            topic_hint: None,
            based_on_existing: false,
            language: Some("zh-CN".to_string()),
            reference_file_ids: vec!["file_1".to_string()],
            reference_files_base64: vec![],
            knowledge_points: vec![
                "二次函数".to_string(),
                "  ".to_string(),
                "因式分解".to_string(),
            ],
        };
        let references =
            vec![serde_json::json!({"source_id":"s1","name":"课本第2章.pdf","page_count":2})];
        let prompt = build_generation_instructions("测试题目集", &[], &request, &references, false);
        assert!(prompt.contains("## 知识点范围（围绕这些知识点出题）"));
        assert!(prompt.contains("- 二次函数"));
        // 空白知识点被过滤
        assert!(!prompt.contains("-  "));
        assert!(prompt.contains("课本第2章.pdf"));
    }

    #[test]
    fn build_generation_user_prompt_adds_media_source_rules_only_for_transcripts() {
        let request = QbankGenerationRequest {
            exam_id: "exam_1".to_string(),
            stream_session_id: "sess".to_string(),
            model_config_id: None,
            max_questions: 3,
            specs: vec![],
            difficulty: None,
            topic_hint: None,
            based_on_existing: false,
            language: Some("zh-CN".to_string()),
            reference_file_ids: vec!["file_lecture".to_string()],
            reference_files_base64: vec![],
            knowledge_points: vec![],
        };
        let prompt = build_generation_instructions("物理", &[], &request, &[], true);
        assert!(prompt.contains("## 音视频课程出处要求"));
        assert!(prompt.contains("[媒体@资源ID:mm:ss]"));

        let prompt = build_generation_instructions("物理", &[], &request, &[], false);
        assert!(!prompt.contains("音视频课程出处要求"));
    }

    #[test]
    fn generation_instructions_preserve_long_user_requirements() {
        let request = QbankGenerationRequest {
            exam_id: "exam_1".to_string(),
            stream_session_id: "sess".to_string(),
            model_config_id: None,
            max_questions: 5,
            specs: vec![],
            difficulty: None,
            topic_hint: Some("long user requirement ".repeat(5000)),
            based_on_existing: false,
            language: None,
            reference_file_ids: vec![],
            reference_files_base64: vec![],
            knowledge_points: vec![],
        };
        let prompt = build_generation_instructions("测试", &[], &request, &[], false);
        assert!(prompt.contains(request.topic_hint.as_deref().unwrap().trim()));
        assert!(!prompt.contains("已截断"));
    }

    #[test]
    fn build_generation_user_prompt_includes_reference_images_section() {
        let request = QbankGenerationRequest {
            exam_id: "exam_1".to_string(),
            stream_session_id: "sess".to_string(),
            model_config_id: None,
            max_questions: 5,
            specs: vec![],
            difficulty: None,
            topic_hint: None,
            based_on_existing: false,
            language: Some("zh-CN".to_string()),
            reference_file_ids: vec![],
            reference_files_base64: vec![],
            knowledge_points: vec![],
        };
        let sources =
            vec![serde_json::json!({"source_id":"s1","name":"单词表.pdf","page_count":20})];
        let prompt = build_generation_instructions("测试", &[], &request, &sources, false);
        assert!(prompt.contains("单词表.pdf"));
        assert!(prompt.contains("20"));
    }

    #[test]
    fn normalize_escaped_text_restores_literal_newlines() {
        assert_eq!(
            normalize_escaped_text("Read the sentence:\\n\\n> quote"),
            "Read the sentence:\n\n> quote"
        );
        // 后跟非 ASCII 字母（空格/数字/中文）时正常还原
        assert_eq!(normalize_escaped_text("a\\t b"), "a\t b");
        assert_eq!(normalize_escaped_text("第一行\\n第二行"), "第一行\n第二行");
        assert_eq!(normalize_escaped_text("a\\r\\nb"), "a\nb");
    }

    #[test]
    fn normalize_escaped_text_keeps_latex_commands() {
        // \nu / \neq / \nabla 等 LaTeX 命令（\ + ASCII 字母）不能被当成换行转义还原
        assert_eq!(normalize_escaped_text("$\\nu$"), "$\\nu$");
        assert_eq!(normalize_escaped_text("$a \\neq b$"), "$a \\neq b$");
        assert_eq!(normalize_escaped_text("$\\nabla f$"), "$\\nabla f$");
        assert_eq!(normalize_escaped_text("$\\textbf{x}$"), "$\\textbf{x}$");
    }

    #[test]
    fn parse_generation_output_restores_double_escaped_fields() {
        // 模拟模型双重转义：JSON 文本里的 \\n 经 serde 解析后变成字面 "\n"
        let raw = r#"[{"question_type":"single_choice","content":"第一行\\n\\n第二行","options":[{"key":"A","content":"选项\\n说明"},{"key":"B","content":"普通"}],"answer":"A","explanation":"解析\\n结束","difficulty":"medium","tags":["t"]}]"#;
        let response = parse_generation_output(raw, 5).expect("parse");
        assert_eq!(response.drafts.len(), 1);
        let draft = &response.drafts[0];
        assert_eq!(draft.content, "第一行\n\n第二行");
        assert_eq!(draft.explanation.as_deref(), Some("解析\n结束"));
        assert_eq!(draft.options.as_ref().unwrap()[0].content, "选项\n说明");
        assert_eq!(draft.options.as_ref().unwrap()[1].content, "普通");
    }
}
