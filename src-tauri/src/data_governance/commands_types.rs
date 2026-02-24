// ==================== 响应类型定义 ====================

use super::audit::{AuditLog, AuditStatus};

/// 维护模式状态响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct MaintenanceStatusResponse {
    pub is_in_maintenance_mode: bool,
}

/// Schema 注册表响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct SchemaRegistryResponse {
    pub global_version: u64,
    pub aggregated_at: String,
    pub databases: Vec<DatabaseStatusResponse>,
}

/// 数据库状态响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseStatusResponse {
    pub id: String,
    pub schema_version: u32,
    pub min_compatible_version: u32,
    pub max_compatible_version: u32,
    pub data_contract_version: String,
    pub migration_count: usize,
    pub checksum: String,
    pub updated_at: String,
}

/// 审计日志响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditLogResponse {
    pub id: String,
    pub timestamp: String,
    pub operation_type: String,
    pub target: String,
    pub status: String,
    pub duration_ms: Option<u64>,
    pub error_message: Option<String>,
}

/// 审计日志分页响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditLogPagedResponse {
    /// 当前页的审计日志列表
    pub logs: Vec<AuditLogResponse>,
    /// 满足过滤条件的总记录数（不受 limit/offset 影响）
    pub total: u64,
}

impl From<AuditLog> for AuditLogResponse {
    fn from(log: AuditLog) -> Self {
        let operation_type = match &log.operation {
            super::audit::AuditOperation::Migration { .. } => "Migration",
            super::audit::AuditOperation::Backup { .. } => "Backup",
            super::audit::AuditOperation::Restore { .. } => "Restore",
            super::audit::AuditOperation::Sync { .. } => "Sync",
            super::audit::AuditOperation::Maintenance { .. } => "Maintenance",
        };

        let status = match &log.status {
            AuditStatus::Started => "Started",
            AuditStatus::Completed => "Completed",
            AuditStatus::Failed => "Failed",
            AuditStatus::Partial => "Partial",
        };

        Self {
            id: log.id,
            timestamp: log.timestamp.to_rfc3339(),
            operation_type: operation_type.to_string(),
            target: log.target,
            status: status.to_string(),
            duration_ms: log.duration_ms,
            error_message: log.error_message,
        }
    }
}

/// 迁移状态响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct MigrationStatusResponse {
    pub global_version: u64,
    pub all_healthy: bool,
    pub databases: Vec<MigrationDatabaseStatus>,
    /// 待执行迁移总数
    pub pending_migrations_total: usize,
    /// 是否有待执行迁移
    pub has_pending_migrations: bool,
    /// 最后的迁移错误（如果有）
    pub last_error: Option<String>,
}

/// 迁移数据库状态
#[derive(Debug, Clone, serde::Serialize)]
pub struct MigrationDatabaseStatus {
    pub id: String,
    pub current_version: u32,
    /// 目标版本（最新可用迁移版本）
    pub target_version: u32,
    pub is_initialized: bool,
    pub last_migration_at: Option<String>,
    /// 待执行迁移数量
    pub pending_count: usize,
    /// 是否有待执行迁移
    pub has_pending: bool,
}

/// 健康检查响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct HealthCheckResponse {
    pub overall_healthy: bool,
    pub total_databases: usize,
    pub initialized_count: usize,
    pub uninitialized_count: usize,
    pub dependency_check_passed: bool,
    pub dependency_error: Option<String>,
    pub databases: Vec<DatabaseHealthStatus>,
    pub checked_at: String,
    /// 待执行迁移总数
    pub pending_migrations_count: usize,
    /// 是否有待执行迁移
    pub has_pending_migrations: bool,
    /// 审计写入是否健康
    pub audit_log_healthy: bool,
    /// 审计写入错误（如果有）
    pub audit_log_error: Option<String>,
    /// 审计写入错误时间（如果有）
    pub audit_log_error_at: Option<String>,
}

/// 数据库健康状态
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseHealthStatus {
    pub id: String,
    pub is_healthy: bool,
    pub dependencies_met: bool,
    pub schema_version: u32,
    /// 目标版本（最新可用迁移版本）
    pub target_version: u32,
    /// 待执行迁移数量
    pub pending_count: usize,
    pub issues: Vec<String>,
}

/// 数据库详情响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseDetailResponse {
    pub id: String,
    pub schema_version: u32,
    pub min_compatible_version: u32,
    pub max_compatible_version: u32,
    pub data_contract_version: String,
    pub checksum: String,
    pub updated_at: String,
    pub migration_history: Vec<MigrationRecordResponse>,
    pub dependencies: Vec<String>,
}

/// 迁移记录响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct MigrationRecordResponse {
    pub version: u32,
    pub name: String,
    pub checksum: String,
    pub applied_at: String,
    pub duration_ms: Option<u64>,
    pub success: bool,
}

