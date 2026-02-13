//! VFS 错误类型定义
//!
//! 本模块定义 VFS 操作的错误类型和结果类型别名。

use std::fmt;

/// VFS 操作结果类型别名
pub type VfsResult<T> = Result<T, VfsError>;

/// VFS 错误类型
#[derive(Debug)]
pub enum VfsError {
    /// 数据库错误
    Database(String),

    /// 资源未找到
    NotFound { resource_type: String, id: String },

    /// 资源已存在
    AlreadyExists { resource_type: String, id: String },

    /// 哈希冲突（不同内容产生相同哈希，理论上不可能）
    HashCollision { hash: String },

    /// IO 错误（文件操作）
    Io(String),

    /// 序列化/反序列化错误
    Serialization(String),

    /// 无效参数
    InvalidArgument { param: String, reason: String },

    /// 路径解析错误
    PathParse { path: String, reason: String },

    /// 引用计数错误
    RefCount { resource_id: String, reason: String },

    /// 迁移错误
    Migration(String),

    /// 连接池错误
    Pool(String),

    // ========================================================================
    // 文件夹相关错误（契约 H）
    // ========================================================================
    /// 文件夹不存在
    FolderNotFound { folder_id: String },

    /// 文件夹已存在（幂等检查）
    FolderAlreadyExists { folder_id: String },

    /// 超过最大深度（最大 10 层）
    FolderDepthExceeded {
        folder_id: String,
        current_depth: usize,
        max_depth: usize,
    },

    /// 内容项不存在
    ItemNotFound { item_type: String, item_id: String },

    /// 无效的父文件夹
    InvalidParent { folder_id: String, reason: String },

    /// 文件夹数量超限（最大 500 个）
    FolderCountExceeded {
        current_count: usize,
        max_count: usize,
    },

    /// 无效操作（HIGH-R001修复：批量操作超限等）
    InvalidOperation { operation: String, reason: String },

    /// 无效状态（处理流水线等场景）
    InvalidState { message: String },

    /// 内部错误（OCR/外部服务调用等）
    Internal(String),

    /// 并发冲突（乐观锁检测到版本不一致）
    ///
    /// ★ S-002 修复：用于 update_note 等操作的乐观锁冲突检测。
    /// - `key`: 冲突的语义标识（如 "notes.conflict"），方便前端 i18n
    /// - `message`: 人类可读的英文描述
    Conflict { key: String, message: String },

    /// 其他错误
    Other(String),
}

impl fmt::Display for VfsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VfsError::Database(msg) => write!(f, "Database error: {}", msg),
            VfsError::NotFound { resource_type, id } => {
                write!(f, "{} not found: {}", resource_type, id)
            }
            VfsError::AlreadyExists { resource_type, id } => {
                write!(f, "{} already exists: {}", resource_type, id)
            }
            VfsError::HashCollision { hash } => {
                write!(f, "Hash collision detected: {}", hash)
            }
            VfsError::Io(msg) => write!(f, "IO error: {}", msg),
            VfsError::Serialization(msg) => write!(f, "Serialization error: {}", msg),
            VfsError::InvalidArgument { param, reason } => {
                write!(f, "Invalid argument '{}': {}", param, reason)
            }
            VfsError::PathParse { path, reason } => {
                write!(f, "Failed to parse path '{}': {}", path, reason)
            }
            VfsError::RefCount {
                resource_id,
                reason,
            } => {
                write!(f, "Ref count error for '{}': {}", resource_id, reason)
            }
            VfsError::Migration(msg) => write!(f, "Migration error: {}", msg),
            VfsError::Pool(msg) => write!(f, "Connection pool error: {}", msg),
            VfsError::FolderNotFound { folder_id } => {
                write!(f, "FOLDER_NOT_FOUND: {}", folder_id)
            }
            VfsError::FolderAlreadyExists { folder_id } => {
                write!(f, "FOLDER_ALREADY_EXISTS: {}", folder_id)
            }
            VfsError::FolderDepthExceeded {
                folder_id,
                current_depth,
                max_depth,
            } => {
                write!(
                    f,
                    "FOLDER_DEPTH_EXCEEDED: {} (depth {} > max {})",
                    folder_id, current_depth, max_depth
                )
            }
            VfsError::ItemNotFound { item_type, item_id } => {
                write!(f, "ITEM_NOT_FOUND: {}:{}", item_type, item_id)
            }
            VfsError::InvalidParent { folder_id, reason } => {
                write!(f, "INVALID_PARENT: {} - {}", folder_id, reason)
            }
            VfsError::FolderCountExceeded {
                current_count,
                max_count,
            } => {
                write!(
                    f,
                    "FOLDER_COUNT_EXCEEDED: {} folders (max {})",
                    current_count, max_count
                )
            }
            VfsError::InvalidOperation { operation, reason } => {
                write!(f, "INVALID_OPERATION: {} - {}", operation, reason)
            }
            VfsError::InvalidState { message } => {
                write!(f, "INVALID_STATE: {}", message)
            }
            VfsError::Conflict { key, message } => {
                write!(f, "CONFLICT({}): {}", key, message)
            }
            VfsError::Internal(msg) => write!(f, "Internal error: {}", msg),
            VfsError::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for VfsError {}

// 从标准错误类型转换
impl From<std::io::Error> for VfsError {
    fn from(err: std::io::Error) -> Self {
        VfsError::Io(err.to_string())
    }
}

impl From<serde_json::Error> for VfsError {
    fn from(err: serde_json::Error) -> Self {
        VfsError::Serialization(err.to_string())
    }
}

impl From<rusqlite::Error> for VfsError {
    fn from(err: rusqlite::Error) -> Self {
        VfsError::Database(err.to_string())
    }
}

// 转换为 String（用于 Tauri 命令返回）
impl From<VfsError> for String {
    fn from(err: VfsError) -> Self {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = VfsError::NotFound {
            resource_type: "Note".to_string(),
            id: "note_abc123".to_string(),
        };
        assert_eq!(err.to_string(), "Note not found: note_abc123");

        let err = VfsError::InvalidArgument {
            param: "subject".to_string(),
            reason: "cannot be empty".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "Invalid argument 'subject': cannot be empty"
        );
    }

    #[test]
    fn test_error_to_string() {
        let err = VfsError::Database("connection failed".to_string());
        let s: String = err.into();
        assert_eq!(s, "Database error: connection failed");
    }
}
