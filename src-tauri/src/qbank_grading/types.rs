/// 题目集 AI 评判模块 - 类型定义
use serde::{Deserialize, Serialize};

// ============================================================================
// 评判模式
// ============================================================================

/// 评判模式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum QbankGradingMode {
    /// 主观题评判：判定正误 + 评分 + 详细反馈
    Grade,
    /// 客观题解析：解题思路 + 知识点 + 易错点
    Analyze,
}

// ============================================================================
// 请求/响应类型
// ============================================================================

/// AI 评判请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QbankGradingRequest {
    /// 题目 ID
    pub question_id: String,
    /// 关联的 answer_submission ID。
    ///
    /// Grade 模式必填；Analyze 模式可省略——省略时按题干/选项/参考答案生成
    /// 与作答无关的通用解析（#467：未作答的题也能补解析，且不必为此伪造作答记录）。
    #[serde(default)]
    pub submission_id: Option<String>,
    /// 流式事件会话 ID（前端生成的唯一标识）
    pub stream_session_id: String,
    /// 评判模式
    pub mode: QbankGradingMode,
    /// 模型配置 ID（可选，默认使用 Model2）
    pub model_config_id: Option<String>,
}

/// AI 评判响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QbankGradingResponse {
    /// 关联的 submission ID（通用解析无作答记录时为 None）
    pub submission_id: Option<String>,
    /// 判定结论（仅 Grade 模式）
    pub verdict: Option<Verdict>,
    /// AI 评分 0-100（仅 Grade 模式）
    pub score: Option<i32>,
    /// AI 完整反馈文本
    pub feedback: String,
    /// 本次是否把解析写入了题目的「解析」字段（仅通用解析且原解析为空时为 true）
    #[serde(default)]
    pub explanation_written: bool,
}

/// 正误判定
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Correct,
    Partial,
    Incorrect,
}

impl Verdict {
    /// 从字符串解析
    pub fn from_str(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "correct" => Some(Verdict::Correct),
            "partial" => Some(Verdict::Partial),
            "incorrect" => Some(Verdict::Incorrect),
            _ => None,
        }
    }

    /// 转换为 is_correct 布尔值
    pub fn is_correct(&self) -> bool {
        matches!(self, Verdict::Correct)
    }
}

// ============================================================================
// SSE 事件负载
// ============================================================================

/// SSE 事件 - 增量数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QbankGradingStreamData {
    #[serde(rename = "type")]
    pub event_type: String, // "data"
    pub chunk: String,
    pub accumulated: String,
}

/// SSE 事件 - 完成
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QbankGradingStreamComplete {
    #[serde(rename = "type")]
    pub event_type: String, // "complete"
    pub submission_id: Option<String>,
    pub verdict: Option<String>,
    pub score: Option<i32>,
    pub feedback: String,
    pub explanation_written: bool,
}

/// SSE 事件 - 错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QbankGradingStreamError {
    #[serde(rename = "type")]
    pub event_type: String, // "error"
    pub message: String,
}

/// SSE 事件 - 取消
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QbankGradingStreamCancelled {
    #[serde(rename = "type")]
    pub event_type: String, // "cancelled"
}

// ============================================================================
// Prompt 模板
// ============================================================================

/// Grade 模式的系统提示词（主观题评判）
pub const GRADE_SYSTEM_PROMPT: &str = r#"你是一位严谨的教师，负责批改学生的主观题作答。请根据参考答案评判学生答案的正确性，给出评分和详细反馈。

## 评判要求
1. 仔细对比学生答案与参考答案的要点
2. 考虑答案的完整性、准确性和表达清晰度
3. 给出具体的改进建议

## 图片作答
若学生以手写图片作答：请先在反馈开头逐条誊写你从图片中识别出的内容（便于学生核对识别是否准确），再对照参考答案评判。

## 输出格式要求
在反馈的最末尾，必须输出以下两个标签（整个回复中只能各出现一次）：
<verdict>correct|partial|incorrect</verdict>
<score value="0-100"/>

- correct: 答案正确或基本正确（得分 >= 80）
- partial: 答案部分正确（得分 40-79）
- incorrect: 答案错误或严重不完整（得分 < 40）

主体部分请用 Markdown 格式撰写详细的评判与解析。
公式格式遵循统一的 LaTeX 公式契约（见 prompt 末尾）。"#;

/// Analyze 模式的系统提示词（客观题解析）
pub const ANALYZE_SYSTEM_PROMPT: &str = r#"你是一位善于启发学生的教师。请针对学生的作答情况，提供详细的解题思路分析和知识点讲解。

## 分析要求
请用 Markdown 格式从以下几个方面进行分析：
1. **解题思路**：详细的解题过程和方法
2. **知识点**：涉及的核心知识点和公式
3. **易错点**：常见的错误和注意事项
4. **学习建议**：针对性的学习方向建议

若学生以手写图片作答：请先简要说明你从图片中识别出的作答内容，再展开分析。

公式格式遵循统一的 LaTeX 公式契约（见 prompt 末尾）。
请不要输出 <verdict> 或 <score> 标签。"#;

/// 通用解析模式的系统提示词（无作答记录：为题目本身撰写解析，可直接作为题目的「解析」）
pub const EXPLANATION_SYSTEM_PROMPT: &str = r#"你是一位善于讲解的教师。请为下面这道题撰写一份解析，它会作为题目自带的「解析」长期保存，供所有做这道题的学生参考。

## 撰写要求
请用 Markdown 格式，包含以下几部分：
1. **答案**：给出正确答案（有参考答案时以参考答案为准，不要另起炉灶）
2. **解题思路**：清晰的推理或计算过程
3. **知识点**：涉及的核心概念和公式
4. **易错点**：常见的错误和注意事项

不要假设或评价任何学生的作答，也不要写"你的答案"之类针对个人的话。
公式格式遵循统一的 LaTeX 公式契约（见 prompt 末尾）。
请不要输出 <verdict> 或 <score> 标签。"#;
