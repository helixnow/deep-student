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

    /// 数据治理维护屏障正在阻止 VFS 访问
    Maintenance { component: String },

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

impl VfsError {
    /// TD-11：稳定错误码（IPC 契约）。
    ///
    /// 约束：`Display` 文案可自由改动；本方法返回的 code **一经发布不可更名**，
    /// 前端（src/features/todo/api.ts 等）只允许依赖 code 做行为分派。
    /// 新增变体时按语义归入既有 code 或新增 code，禁止改动既有映射。
    pub fn stable_code(&self) -> &'static str {
        match self {
            VfsError::Database(_) | VfsError::Pool(_) => "VFS_STORAGE",
            VfsError::Io(_) => "VFS_IO",
            VfsError::NotFound { .. }
            | VfsError::ItemNotFound { .. }
            | VfsError::FolderNotFound { .. } => "VFS_NOT_FOUND",
            VfsError::AlreadyExists { .. } | VfsError::FolderAlreadyExists { .. } => {
                "VFS_ALREADY_EXISTS"
            }
            VfsError::InvalidArgument { .. }
            | VfsError::PathParse { .. }
            | VfsError::InvalidParent { .. } => {
                "VFS_INVALID_ARGUMENT"
            }
            VfsError::InvalidOperation { .. } | VfsError::InvalidState { .. } => {
                "VFS_INVALID_OPERATION"
            }
            VfsError::Maintenance { .. } => "VFS_MAINTENANCE",
            VfsError::Conflict { .. } => "VFS_CONFLICT",
            VfsError::Serialization(_) => "VFS_SERIALIZATION",
            VfsError::Migration(_) => "VFS_MIGRATION",
            VfsError::RefCount { .. } => "VFS_REF_COUNT",
            VfsError::FolderDepthExceeded { .. } | VfsError::FolderCountExceeded { .. } => {
                "VFS_LIMIT_EXCEEDED"
            }
            VfsError::HashCollision { .. } | VfsError::Internal(_) | VfsError::Other(_) => {
                "VFS_INTERNAL"
            }
        }
    }

    /// 转换为稳定 IPC envelope；结构化字段（冲突 key、资源 id 等）进 `data`，
    /// `message` 保持与历史 `Display` 文案一致（存量 UI 展示不回归）。
    pub fn to_command_error(&self) -> crate::error_details::CommandError {
        use crate::error_details::CommandError;
        let envelope = CommandError::new(self.stable_code(), self.to_string());
        match self {
            VfsError::Conflict { key, .. } => {
                envelope.with_data(serde_json::json!({ "key": key }))
            }
            VfsError::NotFound { resource_type, id } => envelope.with_data(serde_json::json!({
                "resourceType": resource_type,
                "id": id,
            })),
            VfsError::ItemNotFound { item_type, item_id } => {
                envelope.with_data(serde_json::json!({
                    "resourceType": item_type,
                    "id": item_id,
                }))
            }
            VfsError::FolderNotFound { folder_id } => {
                envelope.with_data(serde_json::json!({ "id": folder_id }))
            }
            VfsError::InvalidArgument { param, .. } => {
                envelope.with_data(serde_json::json!({ "param": param }))
            }
            VfsError::Maintenance { component } => {
                envelope.with_data(serde_json::json!({ "component": component }))
            }
            _ => envelope,
        }
    }
}

impl From<VfsError> for crate::error_details::CommandError {
    fn from(err: VfsError) -> Self {
        err.to_command_error()
    }
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
            VfsError::Maintenance { component } => {
                write!(f, "MAINTENANCE_MODE: {} is temporarily unavailable", component)
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

    /// TD-11 契约：同一变体换任意 message，stable_code 不变（前端只依赖 code）
    #[test]
    fn stable_code_is_independent_of_message() {
        let a = VfsError::Conflict {
            key: "todo.conflict".to_string(),
            message: "TODO_CONFLICT: item was modified".to_string(),
        };
        let b = VfsError::Conflict {
            key: "notes.conflict".to_string(),
            message: "完全不同的新文案（fully reworded message）".to_string(),
        };
        assert_ne!(a.to_string(), b.to_string());
        assert_eq!(a.stable_code(), "VFS_CONFLICT");
        assert_eq!(a.stable_code(), b.stable_code());

        let db_old = VfsError::Database("disk I/O error".to_string());
        let db_new = VfsError::Database("数据库暂时不可用，请稍后重试".to_string());
        assert_eq!(db_old.stable_code(), "VFS_STORAGE");
        assert_eq!(db_old.stable_code(), db_new.stable_code());
    }

    #[test]
    fn stable_code_covers_key_variants() {
        assert_eq!(
            VfsError::NotFound {
                resource_type: "Note".into(),
                id: "n1".into()
            }
            .stable_code(),
            "VFS_NOT_FOUND"
        );
        assert_eq!(
            VfsError::ItemNotFound {
                item_type: "todo".into(),
                item_id: "t1".into()
            }
            .stable_code(),
            "VFS_NOT_FOUND"
        );
        assert_eq!(
            VfsError::InvalidArgument {
                param: "title".into(),
                reason: "empty".into()
            }
            .stable_code(),
            "VFS_INVALID_ARGUMENT"
        );
        assert_eq!(
            VfsError::InvalidParent {
                folder_id: "child".into(),
                reason: "cycle".into(),
            }
            .stable_code(),
            "VFS_INVALID_ARGUMENT"
        );
        assert_eq!(
            VfsError::InvalidOperation {
                operation: "batch".into(),
                reason: "too many".into()
            }
            .stable_code(),
            "VFS_INVALID_OPERATION"
        );
        assert_eq!(
            VfsError::Maintenance {
                component: "vfs".into(),
            }
            .stable_code(),
            "VFS_MAINTENANCE"
        );
        assert_eq!(VfsError::Pool("busy".into()).stable_code(), "VFS_STORAGE");
        assert_eq!(VfsError::Other("misc".into()).stable_code(), "VFS_INTERNAL");
    }

    #[test]
    fn command_error_envelope_carries_code_message_and_data() {
        let err = VfsError::Conflict {
            key: "todo.conflict".to_string(),
            message: "TODO_CONFLICT: stale".to_string(),
        };
        let display = err.to_string();
        let envelope = err.to_command_error();
        assert_eq!(envelope.code, "VFS_CONFLICT");
        // message 与历史 Display 文案一致，存量 UI 展示不回归
        assert_eq!(envelope.message, display);

        let value = serde_json::to_value(&envelope).unwrap();
        assert_eq!(value["code"], "VFS_CONFLICT");
        assert_eq!(value["data"]["key"], "todo.conflict");
    }
}
