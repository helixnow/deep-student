//! Browser 数据层错误类型

use thiserror::Error;

/// Browser 模块错误
#[derive(Debug, Error)]
pub enum BrowserError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Connection pool error: {0}")]
    Pool(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Migration error: {0}")]
    Migration(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Data space unavailable: {0}")]
    DataSpace(String),

    #[error("Database not open (call ensure_open first)")]
    NotOpen,
}

/// Browser 模块结果类型
pub type BrowserResult<T> = Result<T, BrowserError>;
