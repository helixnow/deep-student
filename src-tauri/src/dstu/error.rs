//! DSTU 访达协议层错误定义
//!
//! 本模块定义 DSTU 协议层的错误类型和结果类型。

use serde::Serialize;
use thiserror::Error;

/// DSTU 错误类型
#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum DstuError {
    /// 路径格式错误
    #[error("Invalid DSTU path: {0}")]
    InvalidPath(String),

    /// 路径段缺失
    #[error("Missing path segment: {0}")]
    MissingSegment(String),

    /// 无效的节点类型
    #[error("Invalid node type: {0}")]
    InvalidNodeType(String),

    /// 资源不存在
    #[error("Resource not found: {0}")]
    NotFound(String),

    /// 资源已存在
    #[error("Resource already exists: {0}")]
    AlreadyExists(String),

    /// 操作不支持
    #[error("Operation not supported: {0}")]
    NotSupported(String),

    /// 权限不足
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// VFS 错误
    #[error("VFS error: {0}")]
    VfsError(String),

    /// 数据库错误
    #[error("Database error: {0}")]
    DatabaseError(String),

    /// 序列化错误
    #[error("Serialization error: {0}")]
    SerializationError(String),

    /// IO 错误
    #[error("IO error: {0}")]
    IoError(String),

    /// 内部错误
    #[error("Internal error: {0}")]
    Internal(String),
}

/// DSTU 结果类型
pub type DstuResult<T> = Result<T, DstuError>;

impl DstuError {
    /// 创建无效路径错误
    pub fn invalid_path(msg: impl Into<String>) -> Self {
        DstuError::InvalidPath(msg.into())
    }

    /// 创建缺失段错误
    pub fn missing_segment(segment: impl Into<String>) -> Self {
        DstuError::MissingSegment(segment.into())
    }

    /// 创建无效节点类型错误
    pub fn invalid_node_type(type_str: impl Into<String>) -> Self {
        DstuError::InvalidNodeType(type_str.into())
    }

    /// 创建资源不存在错误
    pub fn not_found(path: impl Into<String>) -> Self {
        DstuError::NotFound(path.into())
    }

    /// 创建资源已存在错误
    pub fn already_exists(path: impl Into<String>) -> Self {
        DstuError::AlreadyExists(path.into())
    }

    /// 创建操作不支持错误
    pub fn not_supported(operation: impl Into<String>) -> Self {
        DstuError::NotSupported(operation.into())
    }

    /// 创建 VFS 错误
    pub fn vfs_error(msg: impl Into<String>) -> Self {
        DstuError::VfsError(msg.into())
    }

    /// 创建数据库错误
    pub fn database_error(msg: impl Into<String>) -> Self {
        DstuError::DatabaseError(msg.into())
    }

    /// 创建内部错误
    pub fn internal(msg: impl Into<String>) -> Self {
        DstuError::Internal(msg.into())
    }
}

// 实现从 String 到 DstuError 的转换，用于 Tauri 命令返回
impl From<DstuError> for String {
    fn from(err: DstuError) -> Self {
        err.to_string()
    }
}

// 实现从 std::io::Error 到 DstuError 的转换
impl From<std::io::Error> for DstuError {
    fn from(err: std::io::Error) -> Self {
        DstuError::IoError(err.to_string())
    }
}

// 实现从 serde_json::Error 到 DstuError 的转换
impl From<serde_json::Error> for DstuError {
    fn from(err: serde_json::Error) -> Self {
        DstuError::SerializationError(err.to_string())
    }
}

// 实现从 rusqlite::Error 到 DstuError 的转换
impl From<rusqlite::Error> for DstuError {
    fn from(err: rusqlite::Error) -> Self {
        DstuError::DatabaseError(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = DstuError::invalid_path("/invalid/path");
        assert_eq!(err.to_string(), "Invalid DSTU path: /invalid/path");

        let err = DstuError::not_found("/数学/notes/note_123");
        assert_eq!(err.to_string(), "Resource not found: /数学/notes/note_123");

        let err = DstuError::invalid_node_type("unknown");
        assert_eq!(err.to_string(), "Invalid node type: unknown");
    }

    #[test]
    fn test_error_to_string_conversion() {
        let err = DstuError::InvalidPath("test".to_string());
        let s: String = err.into();
        assert_eq!(s, "Invalid DSTU path: test");
    }
}
