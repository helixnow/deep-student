//! # Data Governance 初始化模块
//!
//! 提供数据治理系统的统一初始化入口。
//!
//! ## 功能
//!
//! 1. 初始化审计日志表
//! 2. 运行所有数据库迁移
//! 3. 聚合 Schema 状态
//!
//! ## 使用示例
//!
//! ```rust,ignore
//! use std::path::Path;
//! use crate::data_governance::init::initialize;
//!
//! fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let app_data_dir = Path::new("/path/to/app/data");
//!     let registry = initialize(app_data_dir)?;
//!
//!     println!("初始化完成，全局版本: {}", registry.global_version);
//!     Ok(())
//! }
//! ```

use std::path::Path;
use std::time::Instant;

use tracing::{debug, error, info};

use crate::data_governance::audit::{AuditError, AuditRepository};
use crate::data_governance::migration::{MigrationCoordinator, MigrationError};
use crate::data_governance::schema_registry::SchemaRegistry;
use crate::data_governance::DataGovernanceError;

/// 初始化结果
pub struct InitializationResult {
    /// Schema 注册表
    pub registry: SchemaRegistry,
    /// 初始化报告
    pub report: InitializationReport,
    /// 审计数据库连接（用于注册到 State）
    pub audit_db: Option<crate::data_governance::audit::AuditDatabase>,
}

impl std::fmt::Debug for InitializationResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InitializationResult")
            .field("registry", &self.registry)
            .field("report", &self.report)
            .field("audit_db", &self.audit_db.is_some())
            .finish()
    }
}

/// 初始化报告
#[derive(Debug)]
pub struct InitializationReport {
    /// 审计日志初始化是否成功
    pub audit_initialized: bool,
    /// 迁移是否成功
    pub migrations_success: bool,
    /// 应用的迁移总数
    pub migrations_applied: usize,
    /// 总耗时（毫秒）
    pub total_duration_ms: u64,
    /// 警告信息
    pub warnings: Vec<String>,
}

impl InitializationReport {
    /// 创建新的初始化报告
    fn new() -> Self {
        Self {
            audit_initialized: false,
            migrations_success: false,
            migrations_applied: 0,
            total_duration_ms: 0,
            warnings: Vec::new(),
        }
    }

    /// 添加警告
    fn add_warning(&mut self, warning: impl Into<String>) {
        self.warnings.push(warning.into());
    }

    /// 是否完全成功
    pub fn is_fully_successful(&self) -> bool {
        self.audit_initialized && self.migrations_success && self.warnings.is_empty()
    }
}

/// 初始化数据治理系统
///
/// 在应用启动时调用，执行以下步骤：
/// 1. 初始化审计日志
/// 2. 运行数据库迁移
/// 3. 聚合 Schema 状态
///
/// # Arguments
///
/// * `app_data_dir` - 应用数据目录路径
///
/// # Returns
///
/// * `Ok(SchemaRegistry)` - 成功时返回聚合后的 Schema 注册表
/// * `Err(DataGovernanceError)` - 失败时返回具体错误
///
/// # Example
///
/// ```rust,ignore
/// use std::path::Path;
/// use crate::data_governance::init::initialize;
///
/// let app_data_dir = Path::new("/path/to/app/data");
/// let registry = initialize(app_data_dir)?;
///
/// println!("数据库版本摘要: {:?}", registry.get_summary());
/// ```
pub fn initialize(app_data_dir: &Path) -> Result<SchemaRegistry, DataGovernanceError> {
    let result = initialize_with_report(app_data_dir)?;
    Ok(result.registry)
}

/// 初始化数据治理系统（带详细报告）
///
/// 与 `initialize` 功能相同，但返回详细的初始化报告。
///
/// # Arguments
///
/// * `app_data_dir` - 应用数据目录路径
///
/// # Returns
///
/// * `Ok(InitializationResult)` - 成功时返回初始化结果和详细报告
/// * `Err(DataGovernanceError)` - 失败时返回具体错误
pub fn initialize_with_report(
    app_data_dir: &Path,
) -> Result<InitializationResult, DataGovernanceError> {
    let start = Instant::now();
    let mut report = InitializationReport::new();

    info!(
        app_data_dir = %app_data_dir.display(),
        "开始初始化数据治理系统"
    );

    // 步骤 1: 确保数据目录存在
    ensure_directories(app_data_dir)?;

    // 步骤 2: 初始化审计日志（fail-close）
    let audit_db = match initialize_audit_log(app_data_dir) {
        Ok(db) => {
            report.audit_initialized = true;
            debug!("审计日志初始化成功");
            Some(db)
        }
        Err(e) => {
            error!(error = %e, "审计日志初始化失败，终止启动");
            return Err(DataGovernanceError::Backup(format!(
                "审计日志初始化失败: {}",
                e
            )));
        }
    };

    // 步骤 3: 运行数据库迁移（fail-close）
    let mut coordinator = MigrationCoordinator::new(app_data_dir.to_path_buf());
    let migration_report = coordinator
        .run_all()
        .map_err(DataGovernanceError::Migration)?;

    report.migrations_success = migration_report.success;
    report.migrations_applied = migration_report
        .databases
        .iter()
        .map(|db| db.applied_count)
        .sum();

    info!(
        applied_count = report.migrations_applied,
        duration_ms = migration_report.total_duration_ms,
        "数据库迁移完成"
    );

    // 步骤 4: 聚合 Schema 状态（fail-close）
    let registry = coordinator
        .aggregate_schema_registry()
        .map_err(DataGovernanceError::Migration)?;

    info!(
        global_version = registry.global_version,
        database_count = registry.databases.len(),
        "Schema 状态聚合完成"
    );

    // 步骤 5: 验证依赖关系（fail-close）
    if let Err(e) = registry.check_dependencies() {
        error!(error = %e, "依赖关系检查失败，终止启动");
        return Err(DataGovernanceError::Migration(
            MigrationError::DependencyNotSatisfied {
                database: "schema_registry".to_string(),
                dependency: e.to_string(),
            },
        ));
    }

    report.total_duration_ms = start.elapsed().as_millis() as u64;

    info!(
        total_duration_ms = report.total_duration_ms,
        warnings_count = report.warnings.len(),
        "数据治理系统初始化完成"
    );

    Ok(InitializationResult {
        registry,
        report,
        audit_db,
    })
}

/// 确保必要的目录存在
fn ensure_directories(app_data_dir: &Path) -> Result<(), DataGovernanceError> {
    // 数据库目录
    let databases_dir = app_data_dir.join("databases");
    if !databases_dir.exists() {
        std::fs::create_dir_all(&databases_dir)
            .map_err(|e| DataGovernanceError::Migration(MigrationError::Io(e)))?;
        debug!(path = %databases_dir.display(), "创建数据库目录");
    }

    // 备份目录
    let backups_dir = app_data_dir.join("backups");
    if !backups_dir.exists() {
        std::fs::create_dir_all(&backups_dir)
            .map_err(|e| DataGovernanceError::Migration(MigrationError::Io(e)))?;
        debug!(path = %backups_dir.display(), "创建备份目录");
    }

    // 插槽目录（用于主数据库 / mistakes.db）
    let slots_dir = crate::data_space::get_data_space_manager()
        .map(|mgr| mgr.active_dir())
        .unwrap_or_else(|| app_data_dir.join("slots").join("slotA"));
    if !slots_dir.exists() {
        std::fs::create_dir_all(&slots_dir)
            .map_err(|e| DataGovernanceError::Migration(MigrationError::Io(e)))?;
        debug!(path = %slots_dir.display(), "创建插槽目录");
    }

    Ok(())
}

/// 初始化审计日志
fn initialize_audit_log(
    app_data_dir: &Path,
) -> Result<crate::data_governance::audit::AuditDatabase, AuditError> {
    use crate::data_governance::audit::AuditDatabase;

    // 审计日志存储在独立的数据库中
    let audit_db_path = app_data_dir.join("databases").join("audit.db");

    // 确保目录存在
    if let Some(parent) = audit_db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AuditError::Database(e.to_string()))?;
    }

    // 打开数据库连接并初始化审计表
    let audit_db = AuditDatabase::open(&audit_db_path)?;
    audit_db.init()?;

    debug!(
        path = %audit_db_path.display(),
        "审计日志数据库初始化完成"
    );

    Ok(audit_db)
}

/// 快速检查是否需要初始化
///
/// 用于应用启动时快速判断是否需要执行完整初始化流程。
///
/// # Arguments
///
/// * `app_data_dir` - 应用数据目录路径
///
/// # Returns
///
/// * `true` - 需要执行初始化（有待执行的迁移）
/// * `false` - 不需要初始化（所有数据库已是最新版本）
pub fn needs_initialization(app_data_dir: &Path) -> Result<bool, DataGovernanceError> {
    let coordinator = MigrationCoordinator::new(app_data_dir.to_path_buf());
    let pending_count = coordinator.pending_migrations_count()?;

    debug!(pending_migrations = pending_count, "检查待执行迁移数量");

    Ok(pending_count > 0)
}

/// 获取当前 Schema 状态（不执行迁移）
///
/// 仅聚合当前各数据库的状态，不执行任何迁移操作。
/// 用于检查数据库状态或调试。
///
/// # Arguments
///
/// * `app_data_dir` - 应用数据目录路径
///
/// # Returns
///
/// * `Ok(SchemaRegistry)` - 当前的 Schema 注册表
/// * `Err(DataGovernanceError)` - 读取失败时返回错误
pub fn get_current_schema_state(
    app_data_dir: &Path,
) -> Result<SchemaRegistry, DataGovernanceError> {
    let coordinator = MigrationCoordinator::new(app_data_dir.to_path_buf());
    let registry = coordinator.aggregate_schema_registry()?;
    Ok(registry)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_dir() -> TempDir {
        TempDir::new().unwrap()
    }

    #[test]
    fn test_ensure_directories() {
        let temp_dir = create_test_dir();
        let app_data_dir = temp_dir.path();

        ensure_directories(app_data_dir).unwrap();

        assert!(app_data_dir.join("databases").exists());
        assert!(app_data_dir.join("backups").exists());
        assert!(app_data_dir.join("slots").join("slotA").exists());
    }

    #[test]
    fn test_initialization_report_new() {
        let report = InitializationReport::new();

        assert!(!report.audit_initialized);
        assert!(!report.migrations_success);
        assert_eq!(report.migrations_applied, 0);
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn test_initialization_report_is_fully_successful() {
        let mut report = InitializationReport::new();

        // 初始状态不是完全成功
        assert!(!report.is_fully_successful());

        // 设置成功状态
        report.audit_initialized = true;
        report.migrations_success = true;
        assert!(report.is_fully_successful());

        // 添加警告后不再是完全成功
        report.add_warning("test warning");
        assert!(!report.is_fully_successful());
    }

    #[test]
    fn test_needs_initialization_new_app() {
        let temp_dir = create_test_dir();
        let app_data_dir = temp_dir.path();

        // 新应用应该需要初始化
        let result = needs_initialization(app_data_dir);
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[test]
    fn test_get_current_schema_state_empty() {
        let temp_dir = create_test_dir();
        let app_data_dir = temp_dir.path();

        // 空目录应该返回空的 Registry
        let result = get_current_schema_state(app_data_dir);
        assert!(result.is_ok());

        let registry = result.unwrap();
        assert!(registry.databases.is_empty());
        assert_eq!(registry.global_version, 0);
    }

    #[test]
    fn test_initialize_audit_log() {
        let temp_dir = create_test_dir();
        let app_data_dir = temp_dir.path();

        // 确保目录存在
        ensure_directories(app_data_dir).unwrap();

        // 初始化审计日志
        let result = initialize_audit_log(app_data_dir);
        assert!(result.is_ok());

        // 验证审计数据库文件存在
        let audit_db_path = app_data_dir.join("databases").join("audit.db");
        assert!(audit_db_path.exists());
    }

    #[cfg(not(feature = "data_governance"))]
    #[test]
    fn test_initialize_without_feature() {
        let temp_dir = create_test_dir();
        let app_data_dir = temp_dir.path();

        // 在没有 data_governance feature 时，迁移会返回 NotImplemented 错误
        let result = initialize(app_data_dir);

        // 应该失败，因为 Refinery 迁移未启用
        assert!(result.is_err());
    }
}
