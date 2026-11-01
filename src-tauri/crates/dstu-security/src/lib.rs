//! Deep Student 安全存储与加密 crate（不依赖 tauri）。
//!
//! 加密服务与备份加密格式（`crypto`）、恢复密钥发布 journal（`crypto_publication`）、
//! 跨平台凭据安全存储（`secure_store`：AES-256-GCM 加密文件、根种子平台保护、
//! 云存储凭据 API）。`secure_store` 的 Tauri 命令与依赖云存储配置的 hydrate
//! 逻辑留在 app，app 的 `secure_store` 模块重导出这里的全部公开项。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致，app 通过
//! `pub use dstu_security::xxx` 保留原路径。

// 拆分前这些模块通过 `crate::error_details` 引用错误类型，保留原路径。
use dstu_core::error_details;

#[allow(dead_code)]
pub mod crypto;
pub mod crypto_publication; // 恢复密钥发布 journal 与启动侧前滚/回滚
pub mod secure_store;
