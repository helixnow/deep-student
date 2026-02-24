//! # 数据治理系统 (Data Governance System)
//!
//! 统一的数据库迁移、备份、同步管理模块。
//!
//! ## 设计目标
//!
//! 1. **统一迁移框架**：基于 Refinery，所有数据库使用同一套迁移机制
//! 2. **原子性备份**：使用 SQLite Backup API，确保备份/恢复的原子性
//! 3. **记录级同步**：基于版本戳的冲突检测，支持记录级别合并
//! 4. **类型一致性**：手写 TypeScript 类型 (`src/types/dataGovernance.ts`)
//!
//! ## 模块结构
//!
//! - `schema_registry`: Schema 注册表（派生视图，从各库聚合）
//! - `migration`: 迁移协调器和执行器（含验证机制）
//! - `backup`: 备份管理器（SQLite Backup API + 增量备份）
//! - `sync`: 云同步管理器（记录级冲突检测）
//! - `audit`: 审计日志
//! - `dto`: 统一数据传输对象
//!
//! ## Feature Gate
//!
//! 此模块通过 `data_governance` feature 控制，默认已启用（见 Cargo.toml default features）。
//!
//! ```toml
//! [features]
//! data_governance = []
//! ```
//!
//! ## 参考文档
//!
//! - [数据治理系统重构方案](../../../docs/数据治理系统重构方案.md)
//! - [Refinery 文档](https://docs.rs/refinery/)

pub mod audit;
pub mod backup;
pub mod commands;
pub mod commands_types;
pub mod commands_backup;
pub mod commands_zip;
pub mod commands_restore;
pub mod commands_asset;
pub mod commands_sync;
pub mod dto;
pub mod init;
pub mod migration;
pub mod plugin;
pub mod schema_registry;
pub mod sync;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod migration_tests;

#[cfg(test)]
mod critical_audit_tests;

// Re-exports - 命令（commands.rs 中保留的命令）
pub use commands::{
    data_governance_cleanup_audit_logs,
    data_governance_get_audit_logs,
    data_governance_get_database_status,
    data_governance_get_migration_status,
    data_governance_get_schema_registry,
    data_governance_run_health_check,
};

// Re-exports - 备份命令（commands_backup.rs）
pub use commands_backup::{
    data_governance_backup_tiered,
    data_governance_cancel_backup,
    data_governance_cleanup_persisted_jobs,
    data_governance_delete_backup,
    data_governance_get_backup_job,
    data_governance_get_backup_list,
    data_governance_list_backup_jobs,
    data_governance_list_resumable_jobs,
    data_governance_resume_backup_job,
    data_governance_run_backup,
    data_governance_verify_backup,
};

// Re-exports - ZIP 导出/导入命令（commands_zip.rs）
pub use commands_zip::{
    data_governance_backup_and_export_zip,
    data_governance_export_zip,
    data_governance_import_zip,
};

// Re-exports - 恢复命令（commands_restore.rs）
pub use commands_restore::data_governance_restore_backup;

// Re-exports - 资产管理命令（commands_asset.rs）
pub use commands_asset::{
    data_governance_get_asset_types,
    data_governance_restore_with_assets,
    data_governance_scan_assets,
    data_governance_verify_backup_with_assets,
};

// Re-exports - 同步命令（commands_sync.rs）
pub use commands_sync::{
    data_governance_detect_conflicts,
    data_governance_export_sync_data,
    data_governance_get_sync_status,
    data_governance_import_sync_data,
    data_governance_resolve_conflicts,
    data_governance_run_sync,
    data_governance_run_sync_with_progress,
};

// Re-exports - 同步进度相关
pub use init::{initialize, initialize_with_report, InitializationReport, InitializationResult};
pub use migration::MigrationCoordinator;
pub use schema_registry::SchemaRegistry;
pub use sync::{SyncPhase, SyncProgress, SyncProgressEmitter, EVENT_NAME as SYNC_PROGRESS_EVENT};

/// 数据治理系统错误类型
#[derive(Debug, thiserror::Error)]
pub enum DataGovernanceError {
    #[error("Migration error: {0}")]
    Migration(#[from] migration::MigrationError),

    #[error("Schema registry error: {0}")]
    SchemaRegistry(#[from] schema_registry::SchemaRegistryError),

    #[error("Backup error: {0}")]
    Backup(String),

    #[error("Sync error: {0}")]
    Sync(String),

    #[error("Not implemented: {0}")]
    NotImplemented(String),
}

/// 数据治理系统结果类型
pub type DataGovernanceResult<T> = Result<T, DataGovernanceError>;
