//! Chat V2 统一错误类型
//!
//! 提供 Chat V2 模块专用的错误处理机制。

use serde::Serialize;
use thiserror::Error;

/// Chat V2 统一错误类型
#[derive(Debug, Error, Serialize)]
pub enum ChatV2Error {
    /// 会话未找到
    #[error("Session not found: {0}")]
    SessionNotFound(String),

    /// 分组未找到
    #[error("Group not found: {0}")]
    GroupNotFound(String),

    /// 消息未找到
    #[error("Message not found: {0}")]
    MessageNotFound(String),

    /// 块未找到
    #[error("Block not found: {0}")]
    BlockNotFound(String),

    /// 资源未找到
    #[error("Resource not found: {0}")]
    ResourceNotFound(String),

    /// 变体未找到
    #[error("Variant not found: {0}")]
    VariantNotFound(String),

    /// 不能激活失败状态的变体
    #[error("Cannot activate failed variant: {0}")]
    VariantCannotActivateFailed(String),

    /// 不能删除最后一个变体
    #[error("Cannot delete last variant")]
    VariantCannotDeleteLast,

    /// 变体正在流式生成中
    #[error("Variant already streaming: {0}")]
    VariantAlreadyStreaming(String),

    /// 变体无法重试（非 error/cancelled 状态）
    #[error("Cannot retry variant: {0}, current status: {1}")]
    VariantCannotRetry(String, String),

    /// 变体数量超过限制
    #[error("Limit exceeded: {0}")]
    LimitExceeded(String),

    /// 数据库错误
    #[error("Database error: {0}")]
    Database(String),

    /// LLM 调用错误
    #[error("LLM error: {0}")]
    Llm(String),

    /// 工具调用错误
    #[error("Tool error: {0}")]
    Tool(String),

    /// 操作被取消
    #[error("Cancelled")]
    Cancelled,

    /// 序列化/反序列化错误
    #[error("Serialization error: {0}")]
    Serialization(String),

    /// 验证错误
    #[error("Validation error: {0}")]
    Validation(String),

    /// 其他错误
    #[error("{0}")]
    Other(String),

    /// IO 错误（文件系统操作等）
    #[error("IO error: {0}")]
    IoError(String),

    /// 无效输入
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    /// 数据库损坏（迁移失败且回滚也失败）
    #[error("DATABASE CORRUPTED - Original error: {original_error}, Rollback error: {rollback_error}. Database may be in inconsistent state.")]
    DatabaseCorrupted {
        original_error: String,
        rollback_error: String,
    },

    /// 工具执行超时
    #[error("Tool execution timeout: {0}")]
    Timeout(String),
}

// 从 rusqlite::Error 转换
impl From<rusqlite::Error> for ChatV2Error {
    fn from(e: rusqlite::Error) -> Self {
        ChatV2Error::Database(format!("{:#}", e))
    }
}

// 从 serde_json::Error 转换
impl From<serde_json::Error> for ChatV2Error {
    fn from(e: serde_json::Error) -> Self {
        ChatV2Error::Serialization(e.to_string())
    }
}

// 从 anyhow::Error 转换
impl From<anyhow::Error> for ChatV2Error {
    fn from(e: anyhow::Error) -> Self {
        ChatV2Error::Other(format!("{:#}", e))
    }
}

// Tauri 命令返回：序列化为结构化 JSON，便于前端按 code 差异化处理
impl From<ChatV2Error> for String {
    fn from(e: ChatV2Error) -> Self {
        let code = match &e {
            ChatV2Error::SessionNotFound(_) => "SESSION_NOT_FOUND",
            ChatV2Error::GroupNotFound(_) => "GROUP_NOT_FOUND",
            ChatV2Error::MessageNotFound(_) => "MESSAGE_NOT_FOUND",
            ChatV2Error::BlockNotFound(_) => "BLOCK_NOT_FOUND",
            ChatV2Error::ResourceNotFound(_) => "RESOURCE_NOT_FOUND",
            ChatV2Error::VariantNotFound(_) => "VARIANT_NOT_FOUND",
            ChatV2Error::VariantCannotActivateFailed(_) => "VARIANT_CANNOT_ACTIVATE",
            ChatV2Error::VariantCannotDeleteLast => "VARIANT_CANNOT_DELETE_LAST",
            ChatV2Error::VariantAlreadyStreaming(_) => "VARIANT_ALREADY_STREAMING",
            ChatV2Error::VariantCannotRetry(_, _) => "VARIANT_CANNOT_RETRY",
            ChatV2Error::LimitExceeded(_) => "LIMIT_EXCEEDED",
            ChatV2Error::Database(_) => "DATABASE_ERROR",
            ChatV2Error::Llm(_) => "LLM_ERROR",
            ChatV2Error::Tool(_) => "TOOL_ERROR",
            ChatV2Error::Cancelled => "CANCELLED",
            ChatV2Error::Serialization(_) => "SERIALIZATION_ERROR",
            ChatV2Error::Validation(_) => "VALIDATION_ERROR",
            ChatV2Error::Other(_) => "OTHER",
            ChatV2Error::IoError(_) => "IO_ERROR",
            ChatV2Error::InvalidInput(_) => "INVALID_INPUT",
            ChatV2Error::DatabaseCorrupted { .. } => "DATABASE_CORRUPTED",
            ChatV2Error::Timeout(_) => "TIMEOUT",
        };
        let message = e.to_string();
        serde_json::json!({ "code": code, "message": message }).to_string()
    }
}

/// Result 类型别名
pub type ChatV2Result<T> = Result<T, ChatV2Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = ChatV2Error::SessionNotFound("sess_123".to_string());
        assert_eq!(err.to_string(), "Session not found: sess_123");

        let err = ChatV2Error::MessageNotFound("msg_456".to_string());
        assert_eq!(err.to_string(), "Message not found: msg_456");

        let err = ChatV2Error::BlockNotFound("blk_789".to_string());
        assert_eq!(err.to_string(), "Block not found: blk_789");

        let err = ChatV2Error::Cancelled;
        assert_eq!(err.to_string(), "Cancelled");
    }

    #[test]
    fn test_variant_error_display() {
        let err = ChatV2Error::VariantNotFound("var_123".to_string());
        assert_eq!(err.to_string(), "Variant not found: var_123");

        let err = ChatV2Error::VariantCannotActivateFailed("var_456".to_string());
        assert_eq!(err.to_string(), "Cannot activate failed variant: var_456");

        let err = ChatV2Error::VariantCannotDeleteLast;
        assert_eq!(err.to_string(), "Cannot delete last variant");

        let err = ChatV2Error::VariantAlreadyStreaming("var_789".to_string());
        assert_eq!(err.to_string(), "Variant already streaming: var_789");

        let err = ChatV2Error::VariantCannotRetry("var_abc".to_string(), "success".to_string());
        assert_eq!(
            err.to_string(),
            "Cannot retry variant: var_abc, current status: success"
        );
    }

    #[test]
    fn test_error_to_string_conversion() {
        let err = ChatV2Error::Database("connection failed".to_string());
        let s: String = err.into();
        assert_eq!(s, "Database error: connection failed");
    }

    #[test]
    fn test_timeout_error() {
        let err =
            ChatV2Error::Timeout("Tool 'web_search' execution timed out after 180s".to_string());
        assert_eq!(
            err.to_string(),
            "Tool execution timeout: Tool 'web_search' execution timed out after 180s"
        );
    }
}
