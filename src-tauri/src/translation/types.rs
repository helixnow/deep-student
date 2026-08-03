/// 翻译模块类型定义
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

/// 翻译响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationResponse {
    /// 翻译记录 ID
    pub id: String,

    /// 完整译文
    pub translated_text: String,

    /// 创建时间（RFC3339 格式）
    pub created_at: String,

    /// 会话 ID
    pub session_id: String,
}

/// SSE 事件负载 - 增量数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationStreamData {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "data"

    /// 本次增量内容（A6-11: 前端按 chunk 自行累加，不再回传全量 accumulated 以避免 IPC O(n²)）
    pub chunk: String,

    /// 本次增量内容（与 `chunk` 相同；新协议字段，前端应逐步迁移到 delta）
    pub delta: String,

    /// 当前字符数（增量维护，非全量扫描）
    pub char_count: usize,

    /// 估算的单词数（增量维护；CJK 文本按空白分词意义有限，仅供参考）
    pub word_count: usize,

    /// 检测到的源语言（仅 src_lang == "auto" 且启发式检测成功时携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_lang: Option<String>,

    /// 当前分段序号（从 1 开始；仅长文本分段翻译时携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_index: Option<usize>,

    /// 分段总数（仅长文本分段翻译时携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_total: Option<usize>,
}

/// SSE 事件负载 - 完成
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationStreamComplete {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "complete"

    /// 翻译记录 ID
    pub id: String,

    /// 完整译文
    pub translated_text: String,

    /// 创建时间
    pub created_at: String,

    /// 检测到的源语言（仅 src_lang == "auto" 且启发式检测成功时携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_lang: Option<String>,
}

/// SSE 事件负载 - 错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationStreamError {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "error"

    /// 用户可读错误消息
    pub message: String,

    /// 机器可读错误码（如 "http_401" / "rate_limited" / "timeout_idle" / "stream_incomplete"）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,

    /// 该错误是否可重试（后端已做有限次自动重试后仍失败时为用户手动重试提示）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retriable: Option<bool>,
}

/// SSE 事件负载 - 取消
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationStreamCancelled {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "cancelled"
}

/// 单条备选译文（多候选翻译，供 ComparisonView / 候选切换 UI 使用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationCandidate {
    /// 候选序号（0 起）
    pub index: u32,

    /// 候选风格标签："precise" | "natural" | "concise"
    pub label: String,

    /// 候选译文全文（失败时为空串）
    pub text: String,

    /// 该候选的失败原因（成功时为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 多候选翻译命令的返回值
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationCandidatesResponse {
    /// 会话 ID（与请求一致）
    pub session_id: String,

    /// 全部候选（按 index 升序；含失败候选，text 为空且 error 有值）
    pub candidates: Vec<TranslationCandidate>,

    /// 检测到的源语言（仅 src_lang == "auto" 且启发式检测成功时携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_lang: Option<String>,

    /// 是否被用户取消（true 时 candidates 可能不完整）
    pub cancelled: bool,

    /// 创建时间（RFC3339）
    pub created_at: String,
}

/// 多候选翻译 SSE 事件（事件名：`translation_candidates_{session_id}`）
///
/// serde tag = "type"，与既有翻译事件族一致：
/// - candidate_data / candidate_complete / candidate_error：单候选粒度
/// - complete / cancelled / error：整次调用终态
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranslationCandidatesEvent {
    CandidateData {
        candidate_index: u32,
        label: String,
        delta: String,
    },
    CandidateComplete {
        candidate_index: u32,
        label: String,
        text: String,
    },
    CandidateError {
        candidate_index: u32,
        label: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    Complete {
        candidates: Vec<TranslationCandidate>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detected_lang: Option<String>,
    },
    Cancelled,
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}
