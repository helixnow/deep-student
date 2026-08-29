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
//! - `backup`: 备份管理器（SQLite Backup API；增量创建已下线，历史包仅识别/拒恢复）
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
pub mod commands_asset;
pub mod commands_backup;
pub mod commands_restore;
pub mod commands_sync;
pub mod commands_types;
pub mod commands_zip;
pub mod dto;
pub mod file_deletion_queue;
pub mod init;
pub mod migration;
pub mod plugin;
pub mod restore_codes;
pub mod schema_registry;
pub mod sync;

/// Stable startup status for a governed component.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupComponentStatus {
    Healthy,
    Degraded,
    Blocked,
}

/// Startup health entry for one stable governed component.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StartupComponentIssue {
    pub component: String,
    pub status: StartupComponentStatus,
    pub reason: Option<String>,
    /// The failed direct dependency when this component was skipped.
    pub dependency: Option<String>,
}

/// Complete startup health for the governed databases and audit subsystem.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StartupComponentHealth {
    pub components: Vec<StartupComponentIssue>,
}

impl Default for StartupComponentHealth {
    fn default() -> Self {
        Self {
            components: ["vfs", "mistakes", "chat_v2", "llm_usage", "audit"]
                .into_iter()
                .map(|component| StartupComponentIssue {
                    component: component.to_string(),
                    status: StartupComponentStatus::Healthy,
                    reason: None,
                    dependency: None,
                })
                .collect(),
        }
    }
}

impl StartupComponentHealth {
    pub fn is_blocked(&self, component: &str) -> bool {
        self.components.iter().any(|entry| {
            entry.component == component && entry.status == StartupComponentStatus::Blocked
        })
    }

    pub fn blocked_components(&self) -> Vec<String> {
        self.components
            .iter()
            .filter(|entry| entry.status == StartupComponentStatus::Blocked)
            .map(|entry| entry.component.clone())
            .collect()
    }

    pub fn requires_core_recovery(&self) -> bool {
        self.is_blocked("vfs") || self.is_blocked("mistakes")
    }

    pub fn issues(&self) -> Vec<StartupComponentIssue> {
        self.components
            .iter()
            .filter(|entry| entry.status != StartupComponentStatus::Healthy)
            .cloned()
            .collect()
    }

    pub(crate) fn mark_degraded(&mut self, component: &str, reason: impl Into<String>) {
        self.set(
            component,
            StartupComponentStatus::Degraded,
            reason.into(),
            None,
        );
    }

    pub(crate) fn mark_blocked(&mut self, component: &str, reason: impl Into<String>) {
        self.set(
            component,
            StartupComponentStatus::Blocked,
            reason.into(),
            None,
        );
    }

    pub(crate) fn mark_dependency_blocked(
        &mut self,
        component: &str,
        dependency: &str,
        reason: impl Into<String>,
    ) {
        self.set(
            component,
            StartupComponentStatus::Blocked,
            reason.into(),
            Some(dependency.to_string()),
        );
    }

    pub(crate) fn apply_database_dependency_closure(&mut self) {
        if !self.is_blocked("vfs") {
            return;
        }
        for dependent in ["chat_v2", "mistakes"] {
            let is_healthy = self.components.iter().any(|entry| {
                entry.component == dependent && entry.status == StartupComponentStatus::Healthy
            });
            if is_healthy {
                self.mark_dependency_blocked(
                    dependent,
                    "vfs",
                    "Skipped because dependency 'vfs' is blocked",
                );
            }
        }
    }

    fn set(
        &mut self,
        component: &str,
        status: StartupComponentStatus,
        reason: String,
        dependency: Option<String>,
    ) {
        if let Some(entry) = self
            .components
            .iter_mut()
            .find(|entry| entry.component == component)
        {
            entry.status = status;
            entry.reason = Some(reason);
            entry.dependency = dependency;
        }
    }
}

/// Clonable Tauri state holder for startup component health.
#[derive(Clone, Default)]
pub struct StartupComponentHealthState {
    inner: std::sync::Arc<std::sync::RwLock<StartupComponentHealth>>,
}

impl StartupComponentHealthState {
    pub fn new(health: StartupComponentHealth) -> Self {
        Self {
            inner: std::sync::Arc::new(std::sync::RwLock::new(health)),
        }
    }

    pub fn snapshot(&self) -> StartupComponentHealth {
        match self.inner.read() {
            Ok(health) => health.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn replace(&self, health: StartupComponentHealth) {
        match self.inner.write() {
            Ok(mut current) => *current = health,
            Err(poisoned) => *poisoned.into_inner() = health,
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod migration_tests;

#[cfg(test)]
mod migration_compat_tests;

#[cfg(test)]
mod critical_audit_tests;

// Re-exports - 命令（commands.rs 中保留的命令）
pub use commands::{
    data_governance_cleanup_audit_logs, data_governance_get_audit_logs,
    data_governance_get_database_status, data_governance_get_migration_status,
    data_governance_get_schema_registry, data_governance_run_health_check,
};

// Re-exports - 备份命令（commands_backup.rs）
pub use commands_backup::{
    data_governance_backup_tiered, data_governance_cancel_backup,
    data_governance_cleanup_persisted_jobs, data_governance_delete_backup,
    data_governance_get_backup_job, data_governance_get_backup_list,
    data_governance_list_backup_jobs, data_governance_list_resumable_jobs,
    data_governance_resume_backup_job, data_governance_run_backup, data_governance_verify_backup,
};

// Re-exports - ZIP 导出/导入命令（commands_zip.rs）
pub use commands_zip::{
    data_governance_backup_and_export_zip, data_governance_export_zip, data_governance_import_zip,
};

// Re-exports - 恢复命令（commands_restore.rs）
pub use commands_restore::data_governance_restore_backup;

// Re-exports - 资产管理命令（commands_asset.rs）
pub use commands_asset::{
    data_governance_get_asset_types, data_governance_restore_with_assets,
    data_governance_scan_assets, data_governance_verify_backup_with_assets,
};

// Re-exports - 同步命令（commands_sync.rs）
pub use commands_sync::{
    data_governance_count_record_conflicts, data_governance_detect_conflicts,
    data_governance_detect_prune_gap, data_governance_export_sync_data,
    data_governance_get_sync_status, data_governance_import_sync_data,
    data_governance_list_record_conflicts, data_governance_list_sync_snapshot_batches,
    data_governance_list_unsynced_items, data_governance_mark_asset_deleted,
    data_governance_mark_blob_deleted, data_governance_purge_resolved_conflicts,
    data_governance_repo_check, data_governance_resolve_conflicts,
    data_governance_resolve_record_conflict, data_governance_rollback_sync_snapshot_batch,
    data_governance_run_sync, data_governance_run_sync_with_progress,
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

/// 启动期数据治理初始化失败时，判断是否应强制进入维护模式。
///
/// Schema fingerprint drift 说明“当前物理 schema 与已记录基线不一致”，
/// 但在已完成迁移且运行时可降级的情况下，不应阻断整站启动。
pub fn should_force_maintenance_mode_on_init_failure(err: &DataGovernanceError) -> bool {
    match err {
        DataGovernanceError::Migration(migration::MigrationError::VerificationFailed {
            reason,
            ..
        }) => !reason.contains("Schema fingerprint drift detected"),
        _ => true,
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;

    #[test]
    fn schema_fingerprint_drift_does_not_force_maintenance_mode() {
        let err = DataGovernanceError::Migration(migration::MigrationError::VerificationFailed {
            version: 20260524,
            reason: "Schema fingerprint drift detected at v20260524 (db: mistakes).".to_string(),
        });

        assert!(
            !should_force_maintenance_mode_on_init_failure(&err),
            "Schema drift should degrade startup without forcing maintenance mode"
        );
    }

    #[test]
    fn non_drift_verification_failure_still_forces_maintenance_mode() {
        let err = DataGovernanceError::Migration(migration::MigrationError::VerificationFailed {
            version: 20260524,
            reason: "critical verification mismatch".to_string(),
        });

        assert!(
            should_force_maintenance_mode_on_init_failure(&err),
            "Other verification failures should still force maintenance mode"
        );
    }

    #[test]
    fn startup_health_applies_vfs_dependency_closure_only() {
        let mut health = StartupComponentHealth::default();
        health.mark_blocked("vfs", "migration failed");
        health.apply_database_dependency_closure();

        assert_eq!(
            health.blocked_components(),
            vec!["vfs", "mistakes", "chat_v2"]
        );
        assert!(!health.is_blocked("llm_usage"));
        assert!(health.requires_core_recovery());
        for dependent in ["mistakes", "chat_v2"] {
            let issue = health
                .issues()
                .into_iter()
                .find(|issue| issue.component == dependent)
                .unwrap();
            assert_eq!(issue.dependency.as_deref(), Some("vfs"));
        }
    }

    #[test]
    fn startup_health_serializes_stable_status_values() {
        let mut health = StartupComponentHealth::default();
        health.mark_degraded("audit", "unavailable");
        let value = serde_json::to_value(&health).unwrap();

        assert_eq!(value["components"][0]["component"], "vfs");
        assert_eq!(value["components"][0]["status"], "healthy");
        assert_eq!(value["components"][4]["status"], "degraded");
    }
}
