//! # DTO 模块
//!
//! 统一数据传输对象定义。
//!
//! ## 设计原则
//!
//! 1. **唯一真相**：所有数据结构在 Rust 端定义
//! 2. **手写类型**：前端类型手写在 `src/types/dataGovernance.ts`
//! 3. **版本控制**：每个 DTO 关联 schema 版本
//!
//! ## 前端类型
//!
//! 前端 TypeScript 类型定义在 `src/types/dataGovernance.ts`，包含：
//! - 所有 API 响应类型
//! - UI 专用类型（如 `DashboardTab`）
//! - 工具函数（如 `formatBytes`, `formatTimestamp`）
//!
//! ## 使用方法
//!
//! ```rust
//! use serde::{Serialize, Deserialize};
//!
//! #[derive(Serialize, Deserialize)]
//! pub struct MyDto {
//!     pub id: String,
//!     pub name: String,
//! }
//! ```
//!
//! ## 导出的类型
//!
//! 数据治理系统的所有类型都在以下模块中定义：
//!
//! ### commands.rs
//! - `SchemaRegistryResponse` - Schema 注册表响应
//! - `DatabaseStatusResponse` - 数据库状态响应
//! - `AuditLogResponse` - 审计日志响应
//! - `MigrationStatusResponse` - 迁移状态响应
//! - `MigrationDatabaseStatus` - 迁移数据库状态
//! - `HealthCheckResponse` - 健康检查响应
//! - `DatabaseHealthStatus` - 数据库健康状态
//! - `DatabaseDetailResponse` - 数据库详情响应
//! - `MigrationRecordResponse` - 迁移记录响应
//! - `BackupResultResponse` - 备份结果响应
//! - `BackupInfoResponse` - 备份信息响应
//! - `BackupVerifyResponse` - 备份验证响应
//! - `DatabaseVerifyStatus` - 数据库验证状态
//! - `RestoreResultResponse` - 恢复结果响应
//! - `SyncStatusResponse` - 同步状态响应
//! - `DatabaseSyncStatusResponse` - 数据库同步状态响应
//! - `ConflictDetectionResponse` - 冲突检测响应
//! - `DatabaseConflictResponse` - 数据库冲突响应
//! - `SyncResultResponse` - 同步结果响应
//! - `SyncExecutionResponse` - 同步执行响应
//! - `SyncExportData` - 同步导出数据
//! - `SyncExportResponse` - 同步导出响应
//! - `SyncImportResponse` - 同步导入响应
//!
//! ### sync/mod.rs
//! - `SyncManifest` - 同步清单
//! - `DatabaseSyncState` - 数据库同步状态
//! - `SyncTransactionStatus` - 同步事务状态
//! - `DatabaseConflict` - 数据库级冲突
//! - `DatabaseConflictType` - 数据库冲突类型
//! - `ConflictRecord` - 冲突记录
//! - `ConflictDetectionResult` - 冲突检测结果
//! - `MergeStrategy` - 合并策略
//! - `SyncResult` - 同步结果
//! - `ChangeLogStats` - 变更日志统计
//! - `RecordSnapshot` - 记录快照
//! - `ConflictResolution` - 冲突解决方式
//! - `ResolvedRecord` - 已解决的记录
//! - `ChangeOperation` - 变更操作类型
//! - `ChangeLogEntry` - 变更日志条目
//! - `PendingChanges` - 待同步变更
//! - `MergeApplicationResult` - 合并应用结果
//! - `SyncDirection` - 同步方向
//! - `SyncExecutionResult` - 同步执行结果
//!
//! ### backup/mod.rs
//! - `BackupManifest` - 备份清单
//! - `BackupFile` - 备份文件信息
//! - `BackupProgress` - 备份进度
//! - `BackupStage` - 备份阶段
//!
//! ### audit/mod.rs
//! - `AuditLog` - 审计日志
//! - `AuditOperation` - 审计操作类型
//! - `BackupType` - 备份类型
//! - `AuditSyncDirection` - 审计同步方向
//! - `AuditStatus` - 审计状态

// 重新导出用于类型生成的宏
#[cfg(feature = "data_governance")]
// 重新导出所有需要的响应类型，方便统一访问
pub use super::commands_types::{
    AuditLogResponse, DatabaseDetailResponse, DatabaseHealthStatus, DatabaseStatusResponse,
    HealthCheckResponse, MigrationDatabaseStatus, MigrationRecordResponse, MigrationStatusResponse,
    SchemaRegistryResponse,
};
#[cfg(feature = "data_governance")]
pub use super::commands_backup::{
    BackupInfoResponse, BackupResultResponse, BackupVerifyResponse, DatabaseVerifyStatus,
};
#[cfg(feature = "data_governance")]
pub use super::commands_restore::RestoreResultResponse;
#[cfg(feature = "data_governance")]
pub use super::commands_sync::{
    ConflictDetectionResponse, DatabaseConflictResponse, DatabaseSyncStatusResponse,
    SyncExecutionResponse, SyncExportData, SyncExportResponse, SyncImportResponse,
    SyncResultResponse, SyncStatusResponse,
};

pub use super::sync::{
    ChangeLogEntry, ChangeLogStats, ChangeOperation, ConflictDetectionResult, ConflictRecord,
    DatabaseConflict, DatabaseConflictType, DatabaseSyncState, MergeApplicationResult,
    MergeStrategy, PendingChanges, RecordSnapshot, ResolvedRecord, SyncDirection,
    SyncExecutionResult, SyncManifest, SyncResult, SyncTransactionStatus,
};
// 注意：ConflictResolution 不导出 TS 类型，因为它包含 serde_json::Value

pub use super::backup::{BackupFile, BackupManifest, BackupProgress, BackupStage};

pub use super::audit::{
    AuditLog, AuditOperation, AuditStatus, BackupType, SyncDirection as AuditSyncDirection,
};
