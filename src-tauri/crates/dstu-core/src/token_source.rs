//! Token 统计来源（`chat_v2::types::TokenSource` 按原路径重导出）

use serde::{Deserialize, Serialize};

/// Token 来源枚举（类型安全）
///
/// 标识 Token 统计数据的来源，用于区分精确值和估算值。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TokenSource {
    /// LLM API 返回的精确值（最高优先级）
    Api,
    /// 使用 tiktoken 库估算（中等优先级）
    #[default]
    Tiktoken,
    /// 启发式规则估算（最低优先级）
    Heuristic,
    /// 多轮累加时来源混合
    Mixed,
}

impl std::fmt::Display for TokenSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenSource::Api => write!(f, "api"),
            TokenSource::Tiktoken => write!(f, "tiktoken"),
            TokenSource::Heuristic => write!(f, "heuristic"),
            TokenSource::Mixed => write!(f, "mixed"),
        }
    }
}
