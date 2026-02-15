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
    #[serde(default)]
    pub formality: Option<String>, // "formal" | "casual" | null

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

    /// 本次增量内容
    pub chunk: String,

    /// 累积内容
    pub accumulated: String,

    /// 当前字符数
    pub char_count: usize,

    /// 估算的单词数
    pub word_count: usize,
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
}

/// SSE 事件负载 - 错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationStreamError {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "error"

    /// 错误消息
    pub message: String,
}

/// SSE 事件负载 - 取消
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationStreamCancelled {
    /// 事件类型
    #[serde(rename = "type")]
    pub event_type: String, // "cancelled"
}
