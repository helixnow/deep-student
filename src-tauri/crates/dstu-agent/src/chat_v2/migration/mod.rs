//! Chat V2 数据迁移模块
//!
//! 将旧版 chat_messages 迁移到 Chat V2 架构

mod legacy_migration;
pub mod types;

pub use legacy_migration::{
    check_migration_status, migrate_legacy_chat, rollback_migration, MigrationExecutor,
};
pub use types::{
    MigrationCheckResult, MigrationEvent, MigrationProgress, MigrationReport, MigrationStatus,
    MigrationStep,
};
