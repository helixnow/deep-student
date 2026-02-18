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
    /// 关联的 answer_submission ID
    pub submission_id: String,
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
    /// 关联的 submission ID
    pub submission_id: String,
    /// 判定结论（仅 Grade 模式）
    pub verdict: Option<Verdict>,
    /// AI 评分 0-100（仅 Grade 模式）
    pub score: Option<i32>,
    /// AI 完整反馈文本
    pub feedback: String,
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
    pub submission_id: String,
    pub verdict: Option<String>,
    pub score: Option<i32>,
    pub feedback: String,
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

## 输出格式要求
在反馈的最末尾，必须输出以下两个标签（整个回复中只能各出现一次）：
<verdict>correct|partial|incorrect</verdict>
<score value="0-100"/>

- correct: 答案正确或基本正确（得分 >= 80）
- partial: 答案部分正确（得分 40-79）
- incorrect: 答案错误或严重不完整（得分 < 40）

主体部分请用 Markdown 格式撰写详细的评判与解析。
数学公式请使用 $...$ 包裹行内公式，$$...$$ 包裹块级公式（例如 $\lambda = \frac{h}{p}$）。不要使用 \(...\) 或裸写 LaTeX 命令。"#;

/// Analyze 模式的系统提示词（客观题解析）
pub const ANALYZE_SYSTEM_PROMPT: &str = r#"你是一位善于启发学生的教师。请针对学生的作答情况，提供详细的解题思路分析和知识点讲解。

## 分析要求
请用 Markdown 格式从以下几个方面进行分析：
1. **解题思路**：详细的解题过程和方法
2. **知识点**：涉及的核心知识点和公式
3. **易错点**：常见的错误和注意事项
4. **学习建议**：针对性的学习方向建议

数学公式请使用 $...$ 包裹行内公式，$$...$$ 包裹块级公式（例如 $\lambda = \frac{h}{p}$）。不要使用 \(...\) 或裸写 LaTeX 命令。
请不要输出 <verdict> 或 <score> 标签。"#;
