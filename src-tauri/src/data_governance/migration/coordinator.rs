//! # Migration Coordinator (迁移协调器)
//!
//! 统一协调多个数据库的迁移执行。
//!
//! ## 职责
//!
//! 1. 检查所有数据库当前版本
//! 2. 验证跨库依赖兼容性
//! 3. 按依赖顺序执行迁移
//! 4. 迁移后验证结果
//! 5. 记录审计日志
//! 6. 失败时协调回滚

use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::data_governance::schema_registry::{DatabaseId, SchemaRegistry};
use crate::data_governance::StartupComponentHealth;

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("[MigrationCoordinator] Row parse error (skipped): {}", e);
            None
        }
    }
}

use super::definitions::MigrationSet;
use super::verifier::MigrationVerifier;
use super::MigrationError;

// 测试专用故障注入 failpoint 注册表。
// 仅在 cfg(test) 下编译；生产构建中既无该模块、也无任何激活路径
// （不读环境变量/配置）。通过 #[path] 声明避免改动 mod.rs。
#[cfg(test)]
#[path = "fault_injection.rs"]
pub(crate) mod fault_injection;

// 导入各数据库的迁移集合
use super::chat_v2::CHAT_V2_MIGRATION_SET;
use super::llm_usage::LLM_USAGE_MIGRATION_SET;
use super::mistakes::MISTAKES_MIGRATIONS;
use super::vfs::VFS_MIGRATION_SET;

const SCHEMA_FINGERPRINT_TABLE: &str = "__governance_schema_fingerprints";
const CHAT_V2_SESSION_TAGS_SYNC_VERSION: u32 = 20260711;
const CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION: u32 = 20260528;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION: u32 = 20260721;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION: u32 = 20260720;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_SCOPE_VERSION: u32 = 20260719;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_FINGERPRINT: &str =
    "50871351ff82068328d59089f21a2b400be006e15be136ce5991d8e2d41fabd6";

/// A narrowly scoped recovery for a fingerprint written by an older binary
/// whose migration set ended immediately before `target_version`.
///
/// This is intentionally an allowlist rather than a general rebaseline path:
/// every listed migration must validate the complete schema delta against a
/// scratch database before its stale fingerprint can be replaced.
#[derive(Debug)]
struct KnownPriorScopeRecoverySpec {
    target_version: u32,
    previous_version: u32,
    accepted_recorded_scope_versions: &'static [u32],
    accepted_recorded_fingerprints: &'static [&'static str],
    validate_current_schema_against_target: bool,
    migration_name: &'static str,
    added_tables: &'static [&'static str],
    added_indexes: &'static [&'static str],
    added_triggers: &'static [&'static str],
}

const CHAT_V2_KNOWN_PRIOR_SCOPE_RECOVERIES: &[KnownPriorScopeRecoverySpec] = &[
    KnownPriorScopeRecoverySpec {
        target_version: CHAT_V2_SESSION_TAGS_SYNC_VERSION,
        previous_version: CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION,
        accepted_recorded_scope_versions: &[CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION],
        accepted_recorded_fingerprints: &[],
        validate_current_schema_against_target: false,
        migration_name: "session_tags_sync_coverage",
        added_tables: &[],
        added_indexes: &[],
        added_triggers: &[
            "trg__change_log_session_tags_delete",
            "trg__change_log_session_tags_insert",
            "trg__change_log_session_tags_update",
        ],
    },
    KnownPriorScopeRecoverySpec {
        target_version: CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
        previous_version: CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION,
        // An early v20260721 binary predated V20260720 in its migration
        // registry and wrote the v20260719 baseline under the v20260721 key.
        accepted_recorded_scope_versions: &[
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_SCOPE_VERSION,
        ],
        // The canonical text emitted by the July 2026 draft cannot be
        // reproduced from today's historical SQL. Accept only its audited
        // SHA-256, after the stored text and the live target schema both pass
        // independent validation below.
        accepted_recorded_fingerprints: &[CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_FINGERPRINT],
        validate_current_schema_against_target: true,
        migration_name: "workspace_deletion_intent_journal",
        added_tables: &["__file_deletion_journal"],
        added_indexes: &[
            "idx__file_deletion_journal_recovery",
            "idx__file_deletion_journal_target",
        ],
        added_triggers: &["trg__workspace_deletion_queue_published"],
    },
];
const CORE_BACKUP_ROOT_DIR_NAME: &str = "migration_core_backups";
const CORE_BACKUP_RETENTION_COUNT: usize = 5;
const RESTORE_FAILURE_JOURNAL_FILE: &str = "restore-failures.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistentRestoreFailure {
    database: DatabaseId,
    migration_error: String,
    restore_error: String,
    failed_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistentRestoreFailureJournal {
    #[serde(default)]
    failures: Vec<PersistentRestoreFailure>,
}

/// 已知历史 checksum 漂移的显式 allowlist（fail-close 的唯一放行通道）。
///
/// 条目为 `(database_id, refinery_version)`：该版本的迁移脚本存在**已知**的
/// 历史草稿版本（发布后被重写），允许在迁移契约验证通过（证明 schema 已被
/// `repair_recorded_migration_schema_gaps` 等修复收敛）后把 history 中的
/// checksum 对齐到当前脚本。
///
/// 除 baseline（checksum="0"）与本清单外，任何 checksum/名称漂移一律中止
/// 迁移（`MigrationError::ChecksumMismatch`），不得静默改写迁移历史。
/// 新增条目必须附带对应的 schema 收敛修复逻辑与测试。
const LEGACY_CHECKSUM_DRIFT_ALLOWLIST: &[(&str, i32)] = &[
    // V20260714 vector index profiles 存在多个历史草稿（schema 草稿与 DML
    // 语义草稿），由 repair_vfs_v20260714_vector_index_profiles 先行收敛。
    ("vfs", 20260714),
];

/// 启动时兼容 patch（`make_alter_columns_safe` 的自动重放/补列/标记完成）
/// 允许作用的最大迁移版本（含）。
///
/// 该机制是为修复历史上 `set_grouped(true)` 时代 DDL 回滚不可靠留下的
/// 中间状态而生：它解析迁移 SQL 里的 `ALTER TABLE ADD COLUMN` 并在运行时
/// 补列/重放/直接标记迁移完成。这类运行时 ALTER 不应无限期作用于未来的
/// 迁移——边界固定在引入本 fail-close 修复时仓库中的最新迁移版本；
/// 之后的新迁移只能由 Refinery 正常执行，残留问题必须显式处理
///（新增 pre_repair 或迁移脚本自身幂等），不再被自动"修复"。
#[cfg(feature = "data_governance")]
const STARTUP_COMPAT_REPLAY_MAX_VERSION: i32 = 20260801;

// 同一进程（一次应用启动）中，针对同一数据目录只做一次“迁移前核心库备份”
static STARTUP_CORE_BACKUP_GUARD: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug, Default)]
struct SchemaFingerprintScope {
    tables: BTreeSet<String>,
    indexes: BTreeSet<String>,
    triggers: BTreeSet<String>,
}

#[derive(Debug)]
struct SchemaFingerprint {
    hash: String,
    canonical_schema: String,
    scope: SchemaFingerprintScope,
}

#[derive(Debug, Default)]
struct MigrationRunOutcome {
    applied_count: usize,
    schema_repaired: bool,
}

/// 迁移协调器
pub struct MigrationCoordinator {
    /// 应用数据目录
    app_data_dir: PathBuf,
    /// 审计数据库连接路径（用于记录审计日志）
    audit_db_path: Option<PathBuf>,
}

/// 迁移报告
#[derive(Debug)]
pub struct MigrationReport {
    /// 各数据库的迁移结果
    pub databases: Vec<DatabaseMigrationReport>,
    /// 总体是否成功
    pub success: bool,
    /// 总耗时（毫秒）
    pub total_duration_ms: u64,
    /// 错误信息（如果有）
    pub error: Option<String>,
    /// Per-component startup health, including isolated failures and dependency skips.
    pub component_health: StartupComponentHealth,
}

impl MigrationReport {
    /// 创建新的报告
    pub fn new() -> Self {
        Self {
            databases: Vec::new(),
            success: true,
            total_duration_ms: 0,
            error: None,
            component_health: StartupComponentHealth::default(),
        }
    }

    /// 添加数据库报告
    pub fn add(&mut self, report: DatabaseMigrationReport) {
        if !report.success {
            self.success = false;
        }
        self.databases.push(report);
    }
}

impl Default for MigrationReport {
    fn default() -> Self {
        Self::new()
    }
}

/// 单个数据库的迁移报告
#[derive(Debug)]
pub struct DatabaseMigrationReport {
    /// 数据库标识
    pub id: DatabaseId,
    /// 迁移前版本
    pub from_version: u32,
    /// 迁移后版本
    pub to_version: u32,
    /// 应用的迁移数量
    pub applied_count: usize,
    /// 是否成功
    pub success: bool,
    /// 耗时（毫秒）
    pub duration_ms: u64,
    /// 错误信息（如果有）
    pub error: Option<String>,
}

impl MigrationCoordinator {
    /// 创建新的迁移协调器
    pub fn new(app_data_dir: PathBuf) -> Self {
        // 默认设置审计数据库路径
        let audit_db_path = Some(app_data_dir.join("databases").join("audit.db"));
        Self {
            app_data_dir,
            audit_db_path,
        }
    }

    /// 设置审计数据库路径（可选）
    pub fn with_audit_db(mut self, path: Option<PathBuf>) -> Self {
        self.audit_db_path = path;
        self
    }

    /// 执行所有数据库的迁移
    ///
    /// 按依赖顺序执行。单库失败只恢复并阻断该库，跳过其传递依赖，
    /// 同时继续迁移无关数据库。
    /// 迁移前检查磁盘可用空间，空间不足时 fail-fast。
    pub fn run_all(&mut self) -> Result<MigrationReport, MigrationError> {
        if !cfg!(feature = "data_governance") {
            return Err(MigrationError::NotImplemented(
                "Data governance feature is not enabled".to_string(),
            ));
        }

        let start = std::time::Instant::now();
        let mut report = MigrationReport::new();

        tracing::info!(
            "🚀 [MigrationCoordinator] 开始执行所有数据库迁移, 数据目录: {}",
            self.app_data_dir.display()
        );

        // Issue #11 修复：迁移前检查磁盘可用空间
        self.preflight_disk_space_check()?;

        // 上次单库恢复如果未完成，必须先基于当时的可信快照重试。未恢复前不创建
        // 新快照，否则会把已经迁移失败的文件覆盖成新的“基线”。
        if let Some(persisted_report) = self.retry_persisted_restore_failures(start)? {
            return Ok(persisted_report);
        }

        // 核心库迁移前保护：仅在存在待迁移项时，且同一启动周期只备份一次初始状态
        self.maybe_backup_core_databases_before_migration()?;

        // failpoint: 核心快照完成后、任何数据库迁移开始前
        self.failpoint("after_core_backup")?;

        // 按依赖顺序获取数据库列表
        let ordered_databases = DatabaseId::all_ordered();
        tracing::info!(
            "📋 [MigrationCoordinator] 待迁移数据库: {:?}",
            ordered_databases
                .iter()
                .map(|d| d.as_str())
                .collect::<Vec<_>>()
        );

        for db_id in ordered_databases {
            // 依赖失败只阻断当前组件；无关数据库仍继续迁移。
            if let Err(e) = self.check_dependencies(&db_id, &report) {
                let dependency = match &e {
                    MigrationError::DependencyNotSatisfied { dependency, .. } => dependency.clone(),
                    _ => "unknown".to_string(),
                };
                let reason = format!("Skipped because dependency '{}' is blocked", dependency);
                tracing::warn!(
                    "⚠️ [MigrationCoordinator] {} 依赖检查失败，跳过该组件: {}",
                    db_id.as_str(),
                    e
                );
                report.component_health.mark_dependency_blocked(
                    db_id.as_str(),
                    &dependency,
                    reason.clone(),
                );
                let current_version = self.current_database_version_or_zero(&db_id);
                report.add(DatabaseMigrationReport {
                    id: db_id,
                    from_version: current_version,
                    to_version: current_version,
                    applied_count: 0,
                    success: false,
                    duration_ms: 0,
                    error: Some(reason),
                });
                continue;
            }

            let from_version = self.current_database_version_or_zero(&db_id);
            let migration_started = std::time::Instant::now();
            match self.migrate_database(db_id.clone()) {
                Ok(db_report) => {
                    tracing::info!(
                        "✅ [MigrationCoordinator] {} 迁移完成: v{} -> v{}, 应用了 {} 个迁移",
                        db_id.as_str(),
                        db_report.from_version,
                        db_report.to_version,
                        db_report.applied_count
                    );
                    report.add(db_report);
                }
                Err(e) => {
                    tracing::error!(
                        failed_db = db_id.as_str(),
                        error = %e,
                        "❌ [MigrationCoordinator] {} 迁移失败",
                        db_id.as_str(),
                    );

                    // 只恢复失败数据库。成功的无关数据库不得回滚。
                    let failure_reason = match self
                        .restore_database_from_latest_core_backup(&db_id)
                    {
                        Ok(()) => format!(
                            "Database '{}' migration failed: {}. Restored this database from the startup snapshot.",
                            db_id.as_str(),
                            e
                        ),
                        Err(restore_err) => {
                            tracing::error!(
                                failed_db = db_id.as_str(),
                                error = %restore_err,
                                "[MigrationCoordinator] 单库自动恢复失败"
                            );
                            self.record_restore_failure(
                                &db_id,
                                &e.to_string(),
                                &restore_err.to_string(),
                            )?;
                            format!(
                                "Database '{}' migration failed: {}. Restoring this database also failed: {}",
                                db_id.as_str(),
                                e,
                                restore_err
                            )
                        }
                    };
                    report
                        .component_health
                        .mark_blocked(db_id.as_str(), failure_reason.clone());
                    report.error = Some(match report.error.take() {
                        Some(previous) => format!("{}; {}", previous, failure_reason),
                        None => failure_reason.clone(),
                    });
                    report.add(DatabaseMigrationReport {
                        id: db_id,
                        from_version,
                        to_version: from_version,
                        applied_count: 0,
                        success: false,
                        duration_ms: migration_started.elapsed().as_millis() as u64,
                        error: Some(failure_reason),
                    });
                }
            }
        }

        report.total_duration_ms = start.elapsed().as_millis() as u64;
        tracing::info!(
            "🏁 [MigrationCoordinator] 迁移完成, 总耗时: {}ms, 成功: {}",
            report.total_duration_ms,
            report.success
        );
        Ok(report)
    }

    fn current_database_version_or_zero(&self, id: &DatabaseId) -> u32 {
        let path = self.get_database_path(id);
        if !path.exists() {
            return 0;
        }
        rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()
        .and_then(|conn| self.get_current_version(&conn).ok())
        .unwrap_or(0)
    }

    fn core_backup_root_dir(&self) -> PathBuf {
        self.app_data_dir.join(CORE_BACKUP_ROOT_DIR_NAME)
    }

    fn restore_failure_journal_path(&self) -> PathBuf {
        self.core_backup_root_dir()
            .join(RESTORE_FAILURE_JOURNAL_FILE)
    }

    fn restore_failure_journal_backup_path(&self) -> PathBuf {
        self.core_backup_root_dir()
            .join("restore-failures.json.bak")
    }

    fn load_restore_failure_journal(
        &self,
    ) -> Result<PersistentRestoreFailureJournal, MigrationError> {
        let primary = self.restore_failure_journal_path();
        let backup = self.restore_failure_journal_backup_path();
        let path = if primary.is_file() {
            primary
        } else if backup.is_file() {
            backup
        } else {
            return Ok(PersistentRestoreFailureJournal::default());
        };
        let content = std::fs::read_to_string(&path).map_err(|error| {
            MigrationError::Database(format!(
                "无法读取单库恢复故障记录 {}: {}",
                path.display(),
                error
            ))
        })?;
        serde_json::from_str(&content).map_err(|error| {
            MigrationError::Database(format!(
                "单库恢复故障记录已损坏 {}: {}",
                path.display(),
                error
            ))
        })
    }

    fn persist_restore_failure_journal(
        &self,
        journal: &PersistentRestoreFailureJournal,
    ) -> Result<(), MigrationError> {
        let path = self.restore_failure_journal_path();
        let backup = self.restore_failure_journal_backup_path();
        if journal.failures.is_empty() {
            if path.exists() {
                std::fs::remove_file(&path).map_err(|error| {
                    MigrationError::Database(format!(
                        "清除单库恢复故障记录失败 {}: {}",
                        path.display(),
                        error
                    ))
                })?;
            }
            if backup.exists() {
                std::fs::remove_file(&backup)?;
            }
            return Ok(());
        }
        let parent = path.parent().ok_or_else(|| {
            MigrationError::Database("单库恢复故障记录路径没有父目录".to_string())
        })?;
        std::fs::create_dir_all(parent)?;
        let temp = path.with_extension("json.tmp");
        let content = serde_json::to_vec_pretty(journal).map_err(|error| {
            MigrationError::Database(format!("序列化恢复故障记录失败: {error}"))
        })?;
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&temp)?;
            file.write_all(&content)?;
            file.sync_all()?;
        }
        if path.exists() {
            if backup.exists() {
                std::fs::remove_file(&backup)?;
            }
            std::fs::rename(&path, &backup)?;
        }
        if let Err(error) = std::fs::rename(&temp, &path) {
            if backup.exists() {
                let _ = std::fs::rename(&backup, &path);
            }
            return Err(error.into());
        }
        if backup.exists() {
            std::fs::remove_file(&backup)?;
        }
        Ok(())
    }

    fn record_restore_failure(
        &self,
        database: &DatabaseId,
        migration_error: &str,
        restore_error: &str,
    ) -> Result<(), MigrationError> {
        let mut journal = self.load_restore_failure_journal()?;
        journal
            .failures
            .retain(|failure| failure.database != *database);
        journal.failures.push(PersistentRestoreFailure {
            database: database.clone(),
            migration_error: migration_error.to_string(),
            restore_error: restore_error.to_string(),
            failed_at: chrono::Utc::now().to_rfc3339(),
        });
        self.persist_restore_failure_journal(&journal)
    }

    fn retry_persisted_restore_failures(
        &self,
        started: std::time::Instant,
    ) -> Result<Option<MigrationReport>, MigrationError> {
        let journal = self.load_restore_failure_journal()?;
        if journal.failures.is_empty() {
            return Ok(None);
        }

        tracing::warn!(
            failures = journal.failures.len(),
            "[MigrationCoordinator] 发现未完成的单库恢复，先重试可信快照恢复"
        );
        let mut remaining = Vec::new();
        for mut failure in journal.failures {
            match self.restore_database_from_latest_core_backup(&failure.database) {
                Ok(()) => tracing::info!(
                    database = failure.database.as_str(),
                    "[MigrationCoordinator] 持久化单库恢复重试成功"
                ),
                Err(error) => {
                    failure.restore_error = error.to_string();
                    failure.failed_at = chrono::Utc::now().to_rfc3339();
                    remaining.push(failure);
                }
            }
        }
        let journal = PersistentRestoreFailureJournal {
            failures: remaining,
        };
        self.persist_restore_failure_journal(&journal)?;
        if journal.failures.is_empty() {
            return Ok(None);
        }

        let mut report = MigrationReport::new();
        let blocked: HashSet<DatabaseId> = journal
            .failures
            .iter()
            .map(|failure| failure.database.clone())
            .collect();
        for database in DatabaseId::all_ordered() {
            if let Some(failure) = journal
                .failures
                .iter()
                .find(|failure| failure.database == database)
            {
                let current_version = self.current_database_version_or_zero(&database);
                let reason = format!(
                    "Database '{}' remains blocked: migration failed ({}); restoring the trusted startup snapshot failed again ({})",
                    database.as_str(),
                    failure.migration_error,
                    failure.restore_error
                );
                report
                    .component_health
                    .mark_blocked(database.as_str(), reason.clone());
                report.add(DatabaseMigrationReport {
                    id: database,
                    from_version: current_version,
                    to_version: current_version,
                    applied_count: 0,
                    success: false,
                    duration_ms: 0,
                    error: Some(reason),
                });
                continue;
            }
            if let Some(dependency) = database
                .dependencies()
                .iter()
                .find(|dependency| blocked.contains(*dependency))
            {
                let current_version = self.current_database_version_or_zero(&database);
                let reason = format!(
                    "Skipped because dependency '{}' has an unresolved restore failure",
                    dependency.as_str()
                );
                report.component_health.mark_dependency_blocked(
                    database.as_str(),
                    dependency.as_str(),
                    reason.clone(),
                );
                report.add(DatabaseMigrationReport {
                    id: database,
                    from_version: current_version,
                    to_version: current_version,
                    applied_count: 0,
                    success: false,
                    duration_ms: 0,
                    error: Some(reason),
                });
            }
        }
        report.error = Some(
            "One or more databases could not be restored from the trusted startup snapshot"
                .to_string(),
        );
        report.total_duration_ms = started.elapsed().as_millis() as u64;
        Ok(Some(report))
    }

    fn startup_guard_key(&self) -> String {
        std::fs::canonicalize(&self.app_data_dir)
            .unwrap_or_else(|_| self.app_data_dir.clone())
            .to_string_lossy()
            .to_string()
    }

    /// 测试专用 failpoint 钩子：armed 时返回确定性注入错误。
    ///
    /// 按 app_data_dir 作用域隔离，避免并行测试互相干扰。
    #[cfg(test)]
    fn failpoint(&self, point: &str) -> Result<(), MigrationError> {
        fault_injection::fire(&self.startup_guard_key(), point)
    }

    /// 生产构建下的零成本占位。
    ///
    /// 注意：生产构建中不存在任何激活路径（不读环境变量、不读配置），
    /// 故障注入仅存在于 `cfg(test)`。
    #[cfg(not(test))]
    #[inline(always)]
    fn failpoint(&self, _point: &str) -> Result<(), MigrationError> {
        Ok(())
    }

    fn maybe_backup_core_databases_before_migration(&mut self) -> Result<(), MigrationError> {
        let pending = match self.pending_migrations_count() {
            Ok(pending) => pending,
            Err(error) => {
                // A corrupt/unreadable database must be handled by the per-database
                // migration and restore path below. Failing here turns one damaged
                // component into a global startup failure, while attempting a new
                // core snapshot could overwrite the last trusted recovery point.
                tracing::warn!(
                    error = %error,
                    data_dir = %self.app_data_dir.display(),
                    "[MigrationCoordinator] 无法读取部分数据库版本；跳过新核心快照并继续逐库隔离迁移"
                );
                return Ok(());
            }
        };
        if pending == 0 {
            tracing::info!(
                "[MigrationCoordinator] 当前无待执行迁移，跳过核心库快照备份: {}",
                self.app_data_dir.display()
            );
            return Ok(());
        }
        self.backup_core_databases_once_per_startup()
    }

    fn backup_sqlite_consistent(src: &PathBuf, dst: &PathBuf) -> Result<(), MigrationError> {
        let src_conn = rusqlite::Connection::open(src).map_err(|e| {
            MigrationError::Database(format!("打开源数据库失败 {}: {}", src.display(), e))
        })?;
        let mut dst_conn = rusqlite::Connection::open(dst).map_err(|e| {
            MigrationError::Database(format!("创建备份数据库失败 {}: {}", dst.display(), e))
        })?;

        {
            let backup = rusqlite::backup::Backup::new(&src_conn, &mut dst_conn).map_err(|e| {
                MigrationError::Database(format!("初始化 SQLite backup 失败: {}", e))
            })?;
            backup
                .run_to_completion(50, Duration::from_millis(20), None)
                .map_err(|e| MigrationError::Database(format!("执行 SQLite backup 失败: {}", e)))?;
        } // drop backup，释放 dst_conn 的可变借用

        // P1-3 修复：备份完成后验证目标数据库完整性
        // 使用 quick_check 而非 integrity_check：跳过索引验证，速度快 5-10x，
        // 仍能检测 B-tree 结构损坏和行格式错误。对启动时间影响更小。
        let integrity: String = dst_conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|e| {
                MigrationError::Database(format!("备份完整性检查失败 {}: {}", dst.display(), e))
            })?;
        if integrity != "ok" {
            return Err(MigrationError::Database(format!(
                "备份完整性校验不通过 {}: {}",
                dst.display(),
                integrity
            )));
        }

        Ok(())
    }

    fn prune_old_core_backups(&self) -> Result<(), MigrationError> {
        let root = self.core_backup_root_dir();
        if !root.exists() {
            return Ok(());
        }

        let mut snapshot_dirs: Vec<PathBuf> = std::fs::read_dir(&root)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();

        snapshot_dirs.sort_by(|a, b| {
            a.file_name()
                .and_then(|n| n.to_str())
                .cmp(&b.file_name().and_then(|n| n.to_str()))
        });

        if snapshot_dirs.len() <= CORE_BACKUP_RETENTION_COUNT {
            return Ok(());
        }

        let remove_count = snapshot_dirs.len() - CORE_BACKUP_RETENTION_COUNT;
        for old in snapshot_dirs.into_iter().take(remove_count) {
            if let Err(e) = std::fs::remove_dir_all(&old) {
                tracing::warn!(
                    "[MigrationCoordinator] 清理旧核心快照失败: {} ({})",
                    old.display(),
                    e
                );
            }
        }
        Ok(())
    }

    /// 从最新的迁移前快照恢复所有核心数据库
    ///
    /// 当迁移失败时调用，将所有核心库恢复到迁移前的一致状态。
    /// 使用 SQLite Backup API 确保恢复的原子性和 WAL 兼容性。
    ///
    /// # Returns
    /// 成功恢复的数据库数量
    pub fn restore_from_latest_core_backup(&self) -> Result<usize, MigrationError> {
        // failpoint: 恢复开始前（磁盘尚未被恢复流程触碰）
        self.failpoint("before_restore")?;

        let root = self.core_backup_root_dir();
        if !root.exists() {
            return Err(MigrationError::Database(
                "无迁移前快照可用于恢复（migration_core_backups 目录不存在）".to_string(),
            ));
        }

        let mut snapshot_dirs: Vec<PathBuf> = std::fs::read_dir(&root)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("startup_"))
            })
            .collect();

        snapshot_dirs.sort_by(|a, b| {
            a.file_name()
                .and_then(|n| n.to_str())
                .cmp(&b.file_name().and_then(|n| n.to_str()))
        });

        let latest = snapshot_dirs
            .last()
            .ok_or_else(|| MigrationError::Database("无迁移前快照目录可用于恢复".to_string()))?;

        tracing::info!(
            "[MigrationCoordinator] 尝试从快照恢复: {}",
            latest.display()
        );

        let metadata_path = latest.join("metadata.json");
        let copied_files: Vec<String> = if metadata_path.exists() {
            let content = std::fs::read_to_string(&metadata_path)?;
            let parsed: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| MigrationError::Database(format!("解析快照元数据失败: {}", e)))?;
            parsed
                .get("copied_files")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default()
        } else {
            tracing::warn!("[MigrationCoordinator] 快照缺少 metadata.json，回退到默认核心文件列表");
            vec![
                "databases/vfs.db".to_string(),
                "chat_v2.db".to_string(),
                "mistakes.db".to_string(),
                "llm_usage.db".to_string(),
            ]
        };

        if copied_files.is_empty() {
            return Err(MigrationError::Database(
                "快照元数据中无备份文件记录".to_string(),
            ));
        }

        let mut restored = 0usize;
        let mut errors: Vec<String> = Vec::new();

        for relative in &copied_files {
            let src = latest.join(relative);
            let dst = self.app_data_dir.join(relative);

            if !src.exists() {
                tracing::warn!(
                    "[MigrationCoordinator] 快照文件不存在，跳过: {}",
                    src.display()
                );
                continue;
            }

            if let Some(parent) = dst.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    errors.push(format!("创建目录失败 {}: {}", parent.display(), e));
                    continue;
                }
            }

            match Self::backup_sqlite_consistent(&src, &dst) {
                Ok(()) => {
                    // 清除残留的 WAL/SHM 文件，避免下次打开时回放旧事务污染恢复的数据
                    for ext in &["db-wal", "db-shm"] {
                        let residual = dst.with_extension(ext);
                        if residual.exists() {
                            if let Err(e) = std::fs::remove_file(&residual) {
                                tracing::warn!(
                                    "[MigrationCoordinator] 清理残留文件失败 {}: {}",
                                    residual.display(),
                                    e
                                );
                            }
                        }
                    }
                    restored += 1;
                    tracing::info!(
                        "[MigrationCoordinator] 已恢复: {} -> {}",
                        src.display(),
                        dst.display()
                    );
                }
                Err(e) => {
                    let msg = format!("恢复 {} 失败: {}", relative, e);
                    tracing::error!("[MigrationCoordinator] {}", msg);
                    errors.push(msg);
                }
            }
        }

        if restored == 0 {
            return Err(MigrationError::Database(format!(
                "从快照恢复失败，无数据库成功恢复。错误: {}",
                errors.join("; ")
            )));
        }

        if !errors.is_empty() {
            tracing::warn!(
                "[MigrationCoordinator] 部分数据库恢复失败（已恢复 {}）: {:?}",
                restored,
                errors
            );
        }

        tracing::info!(
            "[MigrationCoordinator] 从快照恢复完成: {}/{} 个数据库",
            restored,
            copied_files.len()
        );

        // failpoint: 所有数据库文件已恢复到旧状态，但恢复结果尚未上报
        self.failpoint("after_restore")?;

        Ok(restored)
    }

    /// Restore exactly one governed database from the latest startup snapshot.
    ///
    /// If the database did not exist when the snapshot was created, recovery
    /// removes the newly-created failed database instead of treating it as valid.
    pub fn restore_database_from_latest_core_backup(
        &self,
        id: &DatabaseId,
    ) -> Result<(), MigrationError> {
        self.failpoint("before_restore")?;

        let root = self.core_backup_root_dir();
        let mut snapshot_dirs: Vec<PathBuf> = std::fs::read_dir(&root)
            .map_err(|e| {
                MigrationError::Database(format!(
                    "无法读取迁移前快照目录 {}: {}",
                    root.display(),
                    e
                ))
            })?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_dir()
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("startup_"))
            })
            .collect();
        snapshot_dirs.sort();
        let latest = snapshot_dirs
            .last()
            .ok_or_else(|| MigrationError::Database("无迁移前快照目录可用于恢复".to_string()))?;

        let relative = match id {
            DatabaseId::Vfs => "databases/vfs.db",
            DatabaseId::ChatV2 => "chat_v2.db",
            DatabaseId::Mistakes => "mistakes.db",
            DatabaseId::LlmUsage => "llm_usage.db",
        };
        let src = latest.join(relative);
        let dst = self.get_database_path(id);

        if src.is_file() {
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            Self::backup_sqlite_consistent(&src, &dst)?;
        } else {
            // Metadata from snapshots created by this coordinator is the proof
            // that an omitted file did not exist before migration.
            let metadata_path = latest.join("metadata.json");
            let content = std::fs::read_to_string(&metadata_path).map_err(|e| {
                MigrationError::Database(format!(
                    "快照缺少数据库 {} 且无法读取元数据 {}: {}",
                    relative,
                    metadata_path.display(),
                    e
                ))
            })?;
            let metadata: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| MigrationError::Database(format!("解析快照元数据失败: {}", e)))?;
            let copied_files = metadata
                .get("copied_files")
                .and_then(|value| value.as_array())
                .ok_or_else(|| {
                    MigrationError::Database("快照元数据缺少 copied_files".to_string())
                })?;
            if copied_files
                .iter()
                .any(|value| value.as_str() == Some(relative))
            {
                return Err(MigrationError::Database(format!(
                    "快照声明包含数据库但文件不存在: {}",
                    src.display()
                )));
            }
            if dst.exists() {
                std::fs::remove_file(&dst).map_err(|e| {
                    MigrationError::Database(format!(
                        "删除迁移前不存在的失败数据库 {} 失败: {}",
                        dst.display(),
                        e
                    ))
                })?;
            }
        }

        for ext in ["db-wal", "db-shm"] {
            let residual = dst.with_extension(ext);
            if residual.exists() {
                std::fs::remove_file(&residual).map_err(|e| {
                    MigrationError::Database(format!(
                        "清理恢复后的残留文件 {} 失败: {}",
                        residual.display(),
                        e
                    ))
                })?;
            }
        }

        self.failpoint("after_restore")?;
        tracing::info!(
            database = id.as_str(),
            snapshot = %latest.display(),
            "[MigrationCoordinator] 单数据库恢复完成"
        );
        Ok(())
    }

    fn backup_core_databases_once_per_startup(&mut self) -> Result<(), MigrationError> {
        let guard = STARTUP_CORE_BACKUP_GUARD.get_or_init(|| Mutex::new(HashSet::new()));
        let mut sessions = guard
            .lock()
            .map_err(|_| MigrationError::Database("核心库备份锁已损坏".to_string()))?;

        let key = self.startup_guard_key();
        if sessions.contains(&key) {
            tracing::info!(
                "[MigrationCoordinator] 已存在本次启动的核心库备份，跳过: {}",
                self.app_data_dir.display()
            );
            return Ok(());
        }

        std::fs::create_dir_all(self.core_backup_root_dir())?;
        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
        let snapshot_dir = self.core_backup_root_dir().join(format!(
            "startup_{}_{}",
            timestamp,
            std::process::id()
        ));
        std::fs::create_dir_all(&snapshot_dir)?;

        let core_files = [
            "databases/vfs.db",
            "chat_v2.db",
            "mistakes.db",
            "llm_usage.db",
        ];

        let mut copied_files: Vec<String> = Vec::new();
        for relative in core_files {
            let src = self.app_data_dir.join(relative);
            if !src.exists() {
                continue;
            }
            let dst = snapshot_dir.join(relative);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            Self::backup_sqlite_consistent(&src, &dst)?;
            copied_files.push(relative.to_string());
        }

        // P1-2 修复：记录各数据库的 schema 版本，便于手动恢复时判断备份对应的版本
        let mut schema_versions = serde_json::Map::new();
        for relative in &copied_files {
            let db_path = self.app_data_dir.join(relative);
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                if let Ok(version) = self.get_current_version(&conn) {
                    let db_name = std::path::Path::new(relative)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or(relative);
                    schema_versions.insert(db_name.to_string(), serde_json::Value::from(version));
                }
            }
        }

        let metadata = serde_json::json!({
            "created_at": chrono::Utc::now().to_rfc3339(),
            "source_dir": self.app_data_dir.display().to_string(),
            "copied_files": copied_files,
            "schema_versions": schema_versions,
            "purpose": "pre-migration core databases snapshot",
        });
        std::fs::write(
            snapshot_dir.join("metadata.json"),
            serde_json::to_string_pretty(&metadata)
                .map_err(|e| MigrationError::Database(format!("写入备份元数据失败: {}", e)))?,
        )?;

        tracing::info!(
            "[MigrationCoordinator] 已完成迁移前核心库备份: {}",
            snapshot_dir.display()
        );

        sessions.insert(key);
        self.prune_old_core_backups()?;
        Ok(())
    }

    /// 检查数据库依赖是否已满足
    pub(crate) fn check_dependencies(
        &self,
        db_id: &DatabaseId,
        report: &MigrationReport,
    ) -> Result<(), MigrationError> {
        for dep in db_id.dependencies() {
            let dep_success = report
                .databases
                .iter()
                .find(|r| &r.id == dep)
                .map(|r| r.success)
                .unwrap_or(false);

            if !dep_success {
                return Err(MigrationError::DependencyNotSatisfied {
                    database: db_id.as_str().to_string(),
                    dependency: dep.as_str().to_string(),
                });
            }
        }
        Ok(())
    }

    /// 迁移单个数据库
    ///
    /// 使用 Refinery 框架执行 SQL 迁移，然后验证结果。
    /// 对于旧数据库（有旧迁移表但没有 refinery_schema_history），会先创建 baseline。
    fn migrate_database(
        &mut self,
        id: DatabaseId,
    ) -> Result<DatabaseMigrationReport, MigrationError> {
        let start = std::time::Instant::now();

        // 获取数据库路径
        let db_path = self.get_database_path(&id);

        tracing::info!(
            "📦 [Migration] 开始迁移数据库 {}: {}",
            id.as_str(),
            db_path.display()
        );

        // 确保目录存在
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // 打开数据库连接
        let mut conn = match rusqlite::Connection::open(&db_path) {
            Ok(conn) => conn,
            Err(e) => {
                let err = MigrationError::Database(e.to_string());
                self.log_migration_failure(
                    &id,
                    0,
                    &err.to_string(),
                    start.elapsed().as_millis() as u64,
                );
                return Err(err);
            }
        };

        // 🔧 启用外键约束（SQLite 默认禁用，需要在每个连接上启用）
        // 这确保迁移脚本中的外键约束能正确验证
        conn.execute("PRAGMA foreign_keys = ON", [])
            .map_err(|e| MigrationError::Database(format!("启用外键约束失败: {}", e)))?;

        // 🔧 旧数据库兼容处理：检测并创建 baseline
        if let Err(e) = self.ensure_legacy_baseline(&conn, &id) {
            self.log_migration_failure(&id, 0, &e.to_string(), start.elapsed().as_millis() as u64);
            return Err(e);
        }

        // 获取迁移前版本
        let from_version = match self.get_current_version(&conn) {
            Ok(version) => version,
            Err(e) => {
                self.log_migration_failure(
                    &id,
                    0,
                    &e.to_string(),
                    start.elapsed().as_millis() as u64,
                );
                return Err(e);
            }
        };

        // 获取迁移集合
        let migration_set = self.get_migration_set(&id);

        // 预处理：修复格式错误的迁移记录（所有数据库通用）
        if let Err(e) = self.fix_malformed_migration_records(&conn) {
            self.log_migration_failure(
                &id,
                from_version,
                &e.to_string(),
                start.elapsed().as_millis() as u64,
            );
            return Err(e);
        }

        // failpoint: 某数据库迁移执行前（schema/history 均未变更）
        self.failpoint(&format!("before_db_migration::{}", id.as_str()))?;

        // 执行迁移
        let migration_outcome = match self.run_refinery_migrations(&mut conn, &id) {
            Ok(outcome) => outcome,
            Err(e) => {
                self.log_migration_failure(
                    &id,
                    from_version,
                    &e.to_string(),
                    start.elapsed().as_millis() as u64,
                );
                return Err(e);
            }
        };
        let applied_count = migration_outcome.applied_count;

        // failpoint: 迁移 SQL 与 refinery history 已落盘，但验证尚未执行
        self.failpoint(&format!("after_db_migration::{}", id.as_str()))?;

        // 获取迁移后版本
        let to_version = self.get_current_version(&conn)?;

        // fail-close：迁移后验证失败时立即终止
        if let Err(e) = self.verify_migrations(
            &conn,
            &id,
            migration_set,
            to_version,
            applied_count,
            migration_outcome.schema_repaired,
        ) {
            self.log_migration_failure(
                &id,
                from_version,
                &e.to_string(),
                start.elapsed().as_millis() as u64,
            );
            return Err(e);
        }

        // failpoint: 该数据库迁移+验证全部完成，审计/报告尚未记录
        self.failpoint(&format!("after_verification::{}", id.as_str()))?;

        let duration_ms = start.elapsed().as_millis() as u64;

        // 记录审计日志（包含耗时）
        self.log_migration_audit(&id, from_version, to_version, applied_count, duration_ms)?;

        Ok(DatabaseMigrationReport {
            id,
            from_version,
            to_version,
            applied_count,
            success: true,
            duration_ms,
            error: None,
        })
    }

    /// 获取数据库文件路径
    ///
    /// 注意：`app_data_dir` 已经是活动数据空间目录（如 `slots/slotA`），
    /// 所以路径应该相对于它，而不是再嵌套 slots 目录。
    fn get_database_path(&self, id: &DatabaseId) -> PathBuf {
        match id {
            // VFS 数据库放在 databases 子目录
            DatabaseId::Vfs => self.app_data_dir.join("databases").join("vfs.db"),
            // ChatV2 数据库直接放在 app_data_dir 根目录
            DatabaseId::ChatV2 => self.app_data_dir.join("chat_v2.db"),
            // Mistakes 数据库直接放在 app_data_dir 根目录
            DatabaseId::Mistakes => self.app_data_dir.join("mistakes.db"),
            // LLM Usage 数据库直接放在 app_data_dir 根目录
            DatabaseId::LlmUsage => self.app_data_dir.join("llm_usage.db"),
        }
    }

    /// 获取数据库的迁移集合
    fn get_migration_set(&self, id: &DatabaseId) -> &'static MigrationSet {
        match id {
            DatabaseId::Vfs => &VFS_MIGRATION_SET,
            DatabaseId::ChatV2 => &CHAT_V2_MIGRATION_SET,
            DatabaseId::Mistakes => &MISTAKES_MIGRATIONS,
            DatabaseId::LlmUsage => &LLM_USAGE_MIGRATION_SET,
        }
    }

    /// 获取当前 schema 版本
    ///
    /// 从 Refinery 的 `refinery_schema_history` 表读取最新版本。
    pub(crate) fn get_current_version(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<u32, MigrationError> {
        // 检查 Refinery 的 schema history 表是否存在
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        if !table_exists {
            return Ok(0);
        }

        // 获取最大版本号
        let version: Option<i32> = conn
            .query_row(
                "SELECT MAX(version) FROM refinery_schema_history",
                [],
                |row| row.get(0),
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        Ok(version.unwrap_or(0) as u32)
    }

    /// 获取已应用的迁移数量
    ///
    /// 从 Refinery 创建的 `refinery_schema_history` 表读取迁移记录数。
    fn get_migration_count(&self, conn: &rusqlite::Connection) -> Result<usize, MigrationError> {
        // 检查 Refinery 的 schema history 表是否存在
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        if !table_exists {
            return Ok(0);
        }

        // 获取迁移记录数量
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM refinery_schema_history", [], |row| {
                row.get(0)
            })
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        Ok(count as usize)
    }

    /// 为旧数据库创建 Refinery baseline
    ///
    /// 检测是否是旧迁移系统的数据库（有旧迁移表但没有 refinery_schema_history），
    /// 如果是，则创建 baseline 记录使 Refinery 能够正确识别已有数据。
    fn ensure_legacy_baseline(
        &self,
        conn: &rusqlite::Connection,
        id: &DatabaseId,
    ) -> Result<(), MigrationError> {
        // 检查是否已有 refinery_schema_history 表且有记录
        let has_refinery_with_records: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM refinery_schema_history LIMIT 1)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false); // 表不存在时返回 false

        if has_refinery_with_records {
            // 已有 Refinery 表且有记录，不需要创建 baseline
            return Ok(());
        }

        // 检测旧迁移系统
        let legacy_info = self.detect_legacy_migration(conn, id)?;

        if let Some((legacy_type, has_data)) = legacy_info {
            if has_data {
                tracing::info!(
                    "🔄 [Migration] 检测到旧数据库 {} ({}), 创建 Refinery baseline",
                    id.as_str(),
                    legacy_type
                );

                // 创建 refinery_schema_history 表
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS refinery_schema_history (
                        version INTEGER PRIMARY KEY,
                        name TEXT,
                        applied_on TEXT,
                        checksum TEXT
                    )",
                    [],
                )
                .map_err(|e| MigrationError::Database(e.to_string()))?;

                // 获取初始迁移的信息
                let migration_set = self.get_migration_set(id);
                if let Some(first_migration) = migration_set.migrations.first() {
                    // baseline 仅在首迁移契约满足时写入，避免“先记账后修复”的漂移
                    match MigrationVerifier::verify(conn, first_migration) {
                        Ok(()) => {
                            let now = chrono::Utc::now().to_rfc3339();

                            // 插入 baseline 记录（标记初始迁移已完成）
                            // checksum 使用 "0"，后续由 repair_refinery_checksums 对齐真实值
                            conn.execute(
                                "INSERT OR IGNORE INTO refinery_schema_history (version, name, applied_on, checksum)
                                 VALUES (?1, ?2, ?3, ?4)",
                                rusqlite::params![
                                    first_migration.refinery_version,
                                    first_migration.name,
                                    now,
                                    "0",
                                ],
                            )
                            .map_err(|e| MigrationError::Database(e.to_string()))?;

                            tracing::info!(
                                "✅ [Migration] 已为 {} 创建 baseline: v{}",
                                id.as_str(),
                                first_migration.refinery_version
                            );
                        }
                        Err(err) => {
                            tracing::warn!(
                                database = id.as_str(),
                                version = first_migration.refinery_version,
                                error = %err,
                                "⚠️ [Migration] 首迁移契约未满足，跳过 baseline 记账，后续将执行真实迁移"
                            );
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// 检测旧迁移系统类型
    ///
    /// 返回 Some((迁移类型名称, 是否有实际数据)) 或 None（不是旧数据库）
    fn detect_legacy_migration(
        &self,
        conn: &rusqlite::Connection,
        id: &DatabaseId,
    ) -> Result<Option<(&'static str, bool)>, MigrationError> {
        match id {
            DatabaseId::ChatV2 => {
                // 检查 chat_v2_migrations 表
                let has_legacy: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_v2_migrations')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| MigrationError::Database(e.to_string()))?;

                if has_legacy {
                    return Ok(Some(("chat_v2_migrations", true)));
                }

                // 检查核心表
                let has_sessions: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_v2_sessions')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| MigrationError::Database(e.to_string()))?;

                if has_sessions {
                    return Ok(Some(("existing_tables", true)));
                }
            }
            DatabaseId::LlmUsage => {
                // 检查 schema_version 表
                let has_legacy: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| MigrationError::Database(e.to_string()))?;

                if has_legacy {
                    return Ok(Some(("schema_version", true)));
                }

                // 检查核心表
                let has_logs: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='llm_usage_logs')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| MigrationError::Database(e.to_string()))?;

                if has_logs {
                    return Ok(Some(("existing_tables", true)));
                }
            }
            DatabaseId::Mistakes => {
                // 检查 migration_progress 表
                let has_legacy: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_progress')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| MigrationError::Database(e.to_string()))?;

                if has_legacy {
                    return Ok(Some(("migration_progress", true)));
                }

                // 检查核心业务表（旧库通常至少包含 mistakes）
                let has_mistakes: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mistakes')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| MigrationError::Database(e.to_string()))?;

                if has_mistakes {
                    return Ok(Some(("existing_tables", true)));
                }
            }
            DatabaseId::Vfs => {
                // VFS 已经迁移到 Refinery，检查旧表
                let has_legacy: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='vfs_schema_history')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| MigrationError::Database(e.to_string()))?;

                if has_legacy {
                    return Ok(Some(("vfs_schema_history", true)));
                }
            }
        }

        Ok(None)
    }

    /// 使用 Refinery 执行迁移
    ///
    /// 此方法在 `data_governance` feature 启用时使用 Refinery 框架，
    /// 否则返回 NotImplemented 错误。
    #[cfg(feature = "data_governance")]
    fn run_refinery_migrations(
        &self,
        conn: &mut rusqlite::Connection,
        id: &DatabaseId,
    ) -> Result<MigrationRunOutcome, MigrationError> {
        // 获取迁移前的迁移记录数量
        let before_count = self.get_migration_count(conn)?;

        // 根据数据库 ID 执行对应的迁移
        let runner = match id {
            DatabaseId::Vfs => self.create_vfs_runner()?,
            DatabaseId::ChatV2 => self.create_chat_v2_runner()?,
            DatabaseId::Mistakes => self.create_mistakes_runner()?,
            DatabaseId::LlmUsage => self.create_llm_usage_runner()?,
        };

        // 配置 Runner：
        // - set_grouped(false): 逐条迁移，每条成功立即记录到 refinery_schema_history。
        //   **不能用 set_grouped(true)**：SQLite 对 DDL（ALTER TABLE ADD COLUMN）的
        //   事务回滚不可靠——列已加上但 refinery_schema_history 记录被回滚，导致
        //   下次重跑时 duplicate column 永久卡死。逐条执行避免这个根本矛盾。
        // - set_abort_divergent(false): 不因 checksum 不匹配而中止（兼容旧数据库）
        // - set_abort_missing(false): 不因缺少迁移文件而中止
        let runner = runner
            .set_grouped(false)
            .set_abort_divergent(false)
            .set_abort_missing(false);

        // 迁移前：清理可能存在的中间状态表（从之前失败的迁移遗留）
        self.cleanup_intermediate_tables(conn, id)?;

        // 🔧 预修复：处理 schema 不一致问题（旧数据库兼容）
        // 这会检查并修复列缺失/重复的问题，避免迁移失败
        self.pre_repair_schema(conn, id, &runner)?;
        let schema_repaired = self.repair_recorded_migration_schema_gaps(conn, id, &runner)?;

        // Schema and DML compatibility repairs need to observe the previous
        // checksum. Reconcile history only after those repairs have converged.
        self.repair_refinery_checksums(conn, id, &runner)?;

        // 🔧 通用防御：对所有待执行迁移中的 ALTER TABLE ADD COLUMN 做幂等预处理
        // 检查列是否已存在（可能由之前失败的 grouped 事务残留），已存在则预标记迁移完成
        // 这是根本解决方案，不再需要为每个新迁移手动写 pre_repair
        self.make_alter_columns_safe(conn, &runner)?;

        // 执行迁移
        runner
            .run(conn)
            .map_err(|e| MigrationError::Refinery(e.to_string()))?;

        // 获取迁移后的迁移记录数量
        let after_count = self.get_migration_count(conn)?;

        // 计算应用的迁移数量（通过迁移记录数差值）
        let applied_count = after_count.saturating_sub(before_count);

        // 获取当前版本用于日志
        let after_version = self.get_current_version(conn)?;

        tracing::info!(
            database = id.as_str(),
            to_version = after_version,
            applied_count = applied_count,
            "Migration completed"
        );

        Ok(MigrationRunOutcome {
            applied_count,
            schema_repaired,
        })
    }

    #[cfg(not(feature = "data_governance"))]
    fn run_refinery_migrations(
        &self,
        _conn: &mut rusqlite::Connection,
        id: &DatabaseId,
    ) -> Result<MigrationRunOutcome, MigrationError> {
        Err(MigrationError::NotImplemented(format!(
            "Refinery migrations for {} (feature 'data_governance' not enabled)",
            id.as_str()
        )))
    }

    /// 创建 VFS 数据库的 Refinery Runner
    #[cfg(feature = "data_governance")]
    fn create_vfs_runner(&self) -> Result<refinery::Runner, MigrationError> {
        // 使用 embed_migrations! 宏嵌入迁移文件
        // 迁移文件路径相对于 Cargo.toml 所在目录
        mod vfs_migrations {
            refinery::embed_migrations!("migrations/vfs");
        }

        Ok(vfs_migrations::migrations::runner())
    }

    /// 创建 Chat V2 数据库的 Refinery Runner
    #[cfg(feature = "data_governance")]
    fn create_chat_v2_runner(&self) -> Result<refinery::Runner, MigrationError> {
        mod chat_v2_migrations {
            refinery::embed_migrations!("migrations/chat_v2");
        }

        Ok(chat_v2_migrations::migrations::runner())
    }

    /// 创建 Mistakes 数据库的 Refinery Runner
    #[cfg(feature = "data_governance")]
    fn create_mistakes_runner(&self) -> Result<refinery::Runner, MigrationError> {
        mod mistakes_migrations {
            refinery::embed_migrations!("migrations/mistakes");
        }

        Ok(mistakes_migrations::migrations::runner())
    }

    /// 创建 LLM Usage 数据库的 Refinery Runner
    #[cfg(feature = "data_governance")]
    fn create_llm_usage_runner(&self) -> Result<refinery::Runner, MigrationError> {
        mod llm_usage_migrations {
            refinery::embed_migrations!("migrations/llm_usage");
        }

        Ok(llm_usage_migrations::migrations::runner())
    }

    /// 修复格式错误的迁移记录
    ///
    /// 删除之前版本插入的格式错误的迁移记录，
    /// 然后重新插入正确格式的记录。
    fn fix_malformed_migration_records(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<(), MigrationError> {
        // 检查 refinery_schema_history 表是否存在
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !table_exists {
            return Ok(());
        }

        // 🔧 旧数据库兼容：只删除明显无效的记录
        // - checksum 为 NULL 或空字符串
        // - version 为 NULL 或 0
        // 不再检查 applied_on 格式，因为不同来源可能有不同格式
        let deleted = conn
            .execute(
                "DELETE FROM refinery_schema_history WHERE
             checksum IS NULL OR checksum = '' OR
             version IS NULL OR version = 0",
                [],
            )
            .unwrap_or(0);

        if deleted > 0 {
            tracing::info!(deleted_count = deleted, "删除了无效的迁移记录");
        }

        Ok(())
    }

    /// 通用幂等防御：对所有待执行迁移中的 ALTER TABLE ADD COLUMN 做预检查
    ///
    /// ## 背景
    ///
    /// SQLite 对 DDL（ALTER TABLE ADD COLUMN）的事务回滚不可靠：
    /// 列已加上但 refinery_schema_history 的记录被回滚，导致下次重跑时
    /// duplicate column 永久卡死。
    ///
    /// 即使改为 set_grouped(false)（逐条迁移），仍可能因为单条迁移内部
    /// 包含多条 ALTER TABLE 而出现部分残留。
    ///
    /// ## 策略
    ///
    /// 对每条**未记录**的迁移，解析其 SQL 中的 ALTER TABLE ADD COLUMN 语句，
    /// 检查目标列是否已存在。如果该迁移的**所有非幂等 ALTER TABLE ADD COLUMN
    /// 的目标列都已存在**，则认为该迁移实际上已经执行过（只是记录被回滚了），
    /// 预先标记为已完成，让 Refinery 跳过它。
    ///
    /// 这是根本解决方案，**不再需要为每个新迁移手动写 pre_repair**。
    #[cfg(feature = "data_governance")]
    fn make_alter_columns_safe(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        self.ensure_refinery_history_table(conn)?;

        for migration in runner.get_migrations() {
            let version = migration.version();

            // 跳过已记录的迁移
            if self.is_migration_recorded(conn, version)? {
                continue;
            }

            // 版本边界（fail-close）：兼容重放只服务于边界内的历史迁移。
            // 边界之后的新迁移必须由 Refinery 正常执行，运行时 ALTER/重放/
            // 预标记完成一律不适用，避免"任意未来迁移都可被启动时补丁改写"。
            if version > STARTUP_COMPAT_REPLAY_MAX_VERSION {
                tracing::debug!(
                    version = version,
                    boundary = STARTUP_COMPAT_REPLAY_MAX_VERSION,
                    "跳过启动时兼容重放：迁移版本超出兼容边界，交由 Refinery 正常执行"
                );
                continue;
            }

            // 解析 SQL 中的 ALTER TABLE ... ADD COLUMN
            let sql = migration.sql().unwrap_or_default();
            let alter_columns = Self::parse_alter_add_columns(sql);

            if alter_columns.is_empty() {
                continue; // 该迁移没有 ALTER TABLE ADD COLUMN，不需要处理
            }

            // 检查是否所有 ALTER TABLE ADD COLUMN 的目标列都已存在
            let mut all_exist = true;
            let mut any_exist = false;

            for (table, column) in &alter_columns {
                if self.table_exists(conn, table)? && self.column_exists(conn, table, column)? {
                    any_exist = true;
                } else {
                    all_exist = false;
                }
            }

            if all_exist {
                // 所有 ALTER 列都已落盘，但 history 可能在迁移后半段执行前丢失。
                // 跳过非幂等 ALTER，严格重放其余 DML/DDL 后才能标记完成。
                tracing::info!(
                    version = version,
                    columns = ?alter_columns,
                    "🔧 [make_alter_columns_safe] 检测到所有 ALTER 列已存在，重放剩余 SQL 后标记 V{}",
                    version
                );
                Self::replay_migration_without_alter_add_columns(conn, sql, version)?;
                self.mark_migration_complete(conn, runner, version)?;
            } else if any_exist {
                // 部分列存在 → 中间状态，补齐缺失的列
                tracing::info!(
                    version = version,
                    columns = ?alter_columns,
                    "🔧 [make_alter_columns_safe] 检测到部分 ALTER 列已存在（中间状态），补齐并标记 V{}",
                    version
                );
                for (table, column) in &alter_columns {
                    // 从 SQL 中提取该列的完整定义
                    let col_def = Self::extract_column_def(sql, table, column);
                    let _ = self.add_column_if_missing(conn, table, column, &col_def)?;
                }
                // 列补齐后重放迁移其余部分。必须使用 execute_batch：多行索引/
                // 触发器不能按行执行，且 backfill/cleanup DML 同样不能遗漏。
                Self::replay_migration_without_alter_add_columns(conn, sql, version)?;
                self.mark_migration_complete(conn, runner, version)?;
            }
            // 如果没有任何列存在，说明迁移从未执行过，正常让 Refinery 执行
        }

        Ok(())
    }

    /// Drop leading `--` / `/* */` trivia so statement classifiers see real SQL.
    #[cfg(feature = "data_governance")]
    fn strip_leading_sql_trivia(sql: &str) -> &str {
        let mut rest = sql.trim_start();
        loop {
            if rest.starts_with("--") {
                match rest.find('\n') {
                    Some(pos) => rest = rest[pos + 1..].trim_start(),
                    None => return "",
                }
                continue;
            }
            if let Some(body) = rest.strip_prefix("/*") {
                match body.find("*/") {
                    Some(pos) => rest = body[pos + 2..].trim_start(),
                    None => return "",
                }
                continue;
            }
            break;
        }
        rest
    }

    #[cfg(feature = "data_governance")]
    fn is_alter_add_column_statement(stmt: &str) -> bool {
        let upper = Self::strip_leading_sql_trivia(stmt).to_uppercase();
        upper.starts_with("ALTER TABLE ") && upper.contains(" ADD COLUMN ")
    }

    /// Split migration SQL using SQLite's own completeness parser. This covers
    /// trigger bodies, CASE/END, all SQLite identifier quoting forms, comments,
    /// and transaction statements without maintaining a second SQL grammar.
    #[cfg(feature = "data_governance")]
    fn split_sql_statements(sql: &str) -> Vec<String> {
        let mut statements = Vec::new();
        let mut current = String::new();
        for ch in sql.chars() {
            current.push(ch);
            if ch != ';' {
                continue;
            }
            let Ok(candidate) = std::ffi::CString::new(current.as_bytes()) else {
                continue;
            };
            // SAFETY: candidate is NUL-terminated and valid for the duration of
            // this call. sqlite3_complete performs no allocation or mutation.
            let complete = unsafe { rusqlite::ffi::sqlite3_complete(candidate.as_ptr()) } != 0;
            if complete {
                let stmt = current.trim().trim_end_matches(';').trim().to_string();
                if !stmt.is_empty() {
                    statements.push(stmt);
                }
                current.clear();
            }
        }
        let stmt = current.trim().to_string();
        if !stmt.is_empty() {
            statements.push(stmt);
        }
        statements
    }

    /// 从迁移 SQL 中解析 ALTER TABLE ... ADD COLUMN 语句
    ///
    /// 返回 `(table_name, column_name)` 列表
    #[cfg(feature = "data_governance")]
    fn parse_alter_add_columns(sql: &str) -> Vec<(String, String)> {
        let mut results = Vec::new();
        for stmt in Self::split_sql_statements(sql) {
            if !Self::is_alter_add_column_statement(&stmt) {
                continue;
            }
            let trimmed = Self::strip_leading_sql_trivia(&stmt);
            let tokens: Vec<&str> = trimmed.split_whitespace().collect();
            let mut table = None;
            let mut column = None;
            for i in 0..tokens.len() {
                let t = tokens[i].to_uppercase();
                if t == "TABLE" && i + 1 < tokens.len() && table.is_none() {
                    table = Some(
                        tokens[i + 1].trim_matches(|c: char| !c.is_alphanumeric() && c != '_'),
                    );
                }
                if t == "COLUMN" && i + 1 < tokens.len() && column.is_none() {
                    column = Some(
                        tokens[i + 1].trim_matches(|c: char| !c.is_alphanumeric() && c != '_'),
                    );
                }
            }
            if let (Some(t), Some(c)) = (table, column) {
                if !t.is_empty() && !c.is_empty() {
                    results.push((t.to_string(), c.to_string()));
                }
            }
        }
        results
    }

    /// 从 SQL 中提取列定义（ALTER TABLE xxx ADD COLUMN yyy <definition>）
    ///
    /// 返回 COLUMN 名称之后的类型定义部分，如 "TEXT DEFAULT 'pending'"
    ///（含跨行 `CHECK (...)` 约束）
    #[cfg(feature = "data_governance")]
    fn extract_column_def(sql: &str, target_table: &str, target_column: &str) -> String {
        let upper_table = target_table.to_uppercase();
        let upper_column = target_column.to_uppercase();
        for stmt in Self::split_sql_statements(sql) {
            if !Self::is_alter_add_column_statement(&stmt) {
                continue;
            }
            let trimmed = Self::strip_leading_sql_trivia(&stmt)
                .trim()
                .trim_end_matches(';');
            let upper = trimmed.to_uppercase();
            if !upper.contains(&upper_table) || !upper.contains(&upper_column) {
                continue;
            }
            let tokens: Vec<&str> = trimmed.split_whitespace().collect();
            for i in 0..tokens.len() {
                if tokens[i].to_uppercase() == "COLUMN" && i + 1 < tokens.len() {
                    let col_name =
                        tokens[i + 1].trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if col_name.to_uppercase() == upper_column {
                        if i + 2 < tokens.len() {
                            return tokens[i + 2..].join(" ");
                        }
                        return "TEXT".to_string();
                    }
                }
            }
        }
        "TEXT".to_string()
    }

    /// 重放未记录迁移中除 `ALTER TABLE ... ADD COLUMN` 外的全部 SQL。
    ///
    /// ALTER 列已由 `make_alter_columns_safe` 检查/补齐；其余语句必须作为完整
    /// batch 执行，才能正确恢复多行 trigger/index 以及 backfill/cleanup DML。
    /// 只有 batch 全部成功后调用方才会写入 refinery history。
    ///
    /// 必须按语句边界跳过 ALTER（而非按行）：多行
    /// `ADD COLUMN ... CHECK (...)` 若只跳过首行会留下孤立的 `CHECK` 片段。
    #[cfg(feature = "data_governance")]
    fn replay_migration_without_alter_add_columns(
        conn: &rusqlite::Connection,
        sql: &str,
        version: i32,
    ) -> Result<(), MigrationError> {
        let mut replay_sql = String::with_capacity(sql.len());
        for stmt in Self::split_sql_statements(sql) {
            if Self::is_alter_add_column_statement(&stmt) {
                continue;
            }
            replay_sql.push_str(&stmt);
            replay_sql.push_str(";\n");
        }

        if replay_sql.trim().is_empty() {
            return Ok(());
        }

        conn.execute_batch(&replay_sql).map_err(|e| {
            MigrationError::Database(format!(
                "恢复未记录迁移 V{} 的非 ALTER SQL 失败: {}",
                version, e
            ))
        })
    }

    /// 修复因迁移脚本变更导致的 checksum 不一致
    ///
    /// 仅更新 refinery_schema_history 中已存在的记录，避免重复迁移执行。
    ///
    /// ## 安全限制
    ///
    /// - 仅修改已存在的迁移记录，不插入新记录
    /// - 每次修复都记录详细审计日志（含 old/new checksum）
    /// - 修复数量超过阈值时发出警告
    fn repair_refinery_checksums(
        &self,
        conn: &rusqlite::Connection,
        id: &DatabaseId,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !table_exists {
            return Ok(());
        }

        /// 安全阈值：单次修复超过此数量发出警告
        const REPAIR_WARN_THRESHOLD: usize = 5;

        let mut repaired = 0usize;
        let mut repair_details: Vec<String> = Vec::new();

        for migration in runner.get_migrations() {
            let version = migration.version();
            let name = migration.name().to_string();
            let checksum = migration.checksum().to_string();

            let existing: Option<(String, String)> = conn
                .query_row(
                    "SELECT name, checksum FROM refinery_schema_history WHERE version = ?1",
                    rusqlite::params![version],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| MigrationError::Database(e.to_string()))?;

            if let Some((db_name, db_checksum)) = existing {
                if db_checksum == checksum && db_name == name {
                    continue; // 已一致，跳过
                }

                // fail-close 策略：history 是迁移的唯一事实源，只有两条明确
                // 允许的对齐路径，其余漂移一律中止迁移（而不是静默改写记录）：
                // 1. baseline 对齐——checksum="0" 由 ensure_legacy_baseline 在
                //    首迁移契约验证通过后写入，是显式的占位值；
                // 2. 显式 allowlist 中的同名漂移——已知历史草稿脚本被重写的
                //    版本，且必须先通过该版本的迁移契约验证（证明 schema 已由
                //    repair_recorded_migration_schema_gaps 等修复收敛）。
                let is_baseline = db_checksum == "0";
                let is_same_name = db_name == name;

                if !is_baseline && !is_same_name {
                    // 版本号冲突/历史被篡改：既不是 baseline 也不是同名脚本漂移
                    return Err(MigrationError::Database(format!(
                        "refinery 迁移历史 V{} 名称不匹配（记录 '{}'，期望 '{}'，记录 checksum '{}'）。\
                         未知漂移 fail-close：请人工核对 {} 库的 refinery_schema_history 后再升级",
                        version,
                        db_name,
                        name,
                        db_checksum,
                        id.as_str(),
                    )));
                }

                let mut reason = "baseline_alignment";
                if !is_baseline {
                    let allowlisted =
                        LEGACY_CHECKSUM_DRIFT_ALLOWLIST.contains(&(id.as_str(), version));
                    if !allowlisted {
                        // 未知 checksum 漂移：可能是脚本被篡改、部分应用或分叉
                        // 版本，静默对齐会掩盖真实的 schema 分歧，必须中止。
                        return Err(MigrationError::ChecksumMismatch {
                            version: version as u32,
                            expected: checksum.clone(),
                            actual: db_checksum.clone(),
                        });
                    }
                    // allowlist 只放行"已知草稿版本"，还必须证明 schema 已收敛：
                    // 该版本的迁移契约（表/列/索引/语义烟测）验证通过才允许对齐。
                    let migration_set = self.get_migration_set(id);
                    let definition = migration_set.get(version).ok_or_else(|| {
                        MigrationError::Database(format!(
                            "allowlist 中的 V{} 缺少迁移契约定义，无法验证收敛，拒绝对齐 checksum",
                            version
                        ))
                    })?;
                    MigrationVerifier::verify(conn, definition)?;
                    reason = "allowlisted_legacy_drift";
                }

                conn.execute(
                    "UPDATE refinery_schema_history SET name = ?1, checksum = ?2 WHERE version = ?3",
                    rusqlite::params![name, checksum, version],
                )
                .map_err(|e| MigrationError::Database(e.to_string()))?;

                let detail = format!(
                    "v{}: name '{}'->'{}', checksum '{}..'->'{}..', reason={}",
                    version,
                    &db_name,
                    &name,
                    &db_checksum.get(..8).unwrap_or(&db_checksum),
                    &checksum.get(..8).unwrap_or(&checksum),
                    reason,
                );
                repair_details.push(detail);
                repaired += 1;
            }
        }

        if repaired > 0 {
            if repaired > REPAIR_WARN_THRESHOLD {
                tracing::warn!(
                    database = id.as_str(),
                    repaired = repaired,
                    threshold = REPAIR_WARN_THRESHOLD,
                    "⚠️ Checksum repair count exceeds safety threshold — review migration scripts"
                );
            }

            tracing::info!(
                database = id.as_str(),
                repaired = repaired,
                details = ?repair_details,
                "Refinery checksum records reconciled"
            );

            // 写入审计日志
            self.log_checksum_repair_audit(id, &repair_details);
        }

        Ok(())
    }

    /// 记录 checksum 修复的审计日志
    fn log_checksum_repair_audit(&self, id: &DatabaseId, repair_details: &[String]) {
        use crate::data_governance::audit::AuditRepository;

        let Some(audit_db_path) = &self.audit_db_path else {
            return;
        };

        let Ok(conn) = rusqlite::Connection::open(audit_db_path) else {
            tracing::warn!("Failed to open audit db for checksum repair logging");
            return;
        };

        if AuditRepository::init(&conn).is_err() {
            return;
        }

        let details_json = serde_json::json!({
            "action": "checksum_repair",
            "database": id.as_str(),
            "repairs": repair_details,
            "count": repair_details.len(),
        });

        let log = crate::data_governance::audit::AuditLog::new(
            crate::data_governance::audit::AuditOperation::Migration {
                from_version: 0,
                to_version: 0,
                applied_count: 0,
            },
            format!("checksum_repair:{}", id.as_str()),
        )
        .with_details(details_json)
        .complete(0);

        if let Err(e) = AuditRepository::save(&conn, &log) {
            tracing::warn!(error = %e, "Failed to save checksum repair audit log");
        }
    }

    /// 预修复 schema 不一致问题
    ///
    /// 在执行 Refinery 迁移之前，检查并修复以下问题：
    /// 1. VFS: 旧数据库可能缺少 `deleted_at` 列（虽然迁移记录显示 v20260130）
    /// 2. chat_v2: 如果 `active_skill_ids_json` 列已存在，标记迁移为已完成
    /// 3. mistakes: 如果 `preview_data_json` 列已存在，标记迁移为已完成
    ///
    /// 这解决了数据库实际 schema 与迁移记录不一致的问题。
    #[cfg(feature = "data_governance")]
    fn pre_repair_schema(
        &self,
        conn: &rusqlite::Connection,
        id: &DatabaseId,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        match id {
            DatabaseId::Vfs => self.pre_repair_vfs_schema(conn, runner)?,
            DatabaseId::ChatV2 => self.pre_repair_chat_v2_schema(conn, runner)?,
            DatabaseId::Mistakes => self.pre_repair_mistakes_schema(conn, runner)?,
            DatabaseId::LlmUsage => self.pre_repair_llm_usage_schema(conn, runner)?,
        }
        Ok(())
    }

    /// 检查表中是否存在指定列
    #[cfg(feature = "data_governance")]
    fn column_exists(
        &self,
        conn: &rusqlite::Connection,
        table_name: &str,
        column_name: &str,
    ) -> Result<bool, MigrationError> {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name = ?2",
                rusqlite::params![table_name, column_name],
                |row| row.get(0),
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        Ok(exists)
    }

    /// 检查表是否存在
    #[cfg(feature = "data_governance")]
    fn table_exists(
        &self,
        conn: &rusqlite::Connection,
        table_name: &str,
    ) -> Result<bool, MigrationError> {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table_name],
                |row| row.get(0),
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        Ok(exists)
    }

    /// 预修复 VFS 数据库的 schema
    ///
    /// 问题：旧数据库在 v20260130 之前创建，resources 等表可能缺少 deleted_at 列，
    /// 但迁移记录显示为 v20260130。V20260201 迁移尝试创建引用 deleted_at 的索引会失败。
    #[cfg(feature = "data_governance")]
    fn pre_repair_vfs_schema(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        // --- V20260131: __change_log 表修复（通用防御） ---
        self.ensure_change_log_table(
            conn,
            "vfs",
            include_str!("../../../migrations/vfs/V20260131__add_change_log.sql"),
            "resources",
        )?;

        const TARGET_VERSION: i32 = 20260201;

        // 新数据库（尚未创建表）无需预修复
        if !self.table_exists(conn, "resources")? {
            return Ok(());
        }

        // V20260201 已记录：直接补齐缺失列/索引，避免 schema 不一致
        let migration_recorded = self.is_migration_recorded(conn, TARGET_VERSION)?;
        if migration_recorded {
            self.apply_vfs_sync_fields_compat(conn)?;
        } else {
            // 如果任一同步字段已存在，说明旧库部分迁移或手动改动过
            // 这会导致 V20260201 迁移出现 duplicate column 错误
            let would_conflict = self.vfs_sync_fields_would_conflict(conn)?;
            if would_conflict {
                self.apply_vfs_sync_fields_compat(conn)?;
                self.ensure_refinery_history_table(conn)?;
                self.mark_migration_complete(conn, runner, TARGET_VERSION)?;
            } else {
                // 正常情况：补齐 deleted_at（resources/notes/questions/folders）
                // review_plans 的 deleted_at 由 V20260201 迁移添加，避免重复
                self.ensure_vfs_deleted_at_core(conn)?;
            }
        }

        // V20260204: PDF 处理状态字段（5 列 + 3 索引）
        self.pre_repair_vfs_v20260204(conn, runner)?;

        // V20260205: 压缩 blob hash（1 列 + 1 索引）
        self.pre_repair_vfs_v20260205(conn, runner)?;

        // V20260209: 题目图片（1 列）
        self.pre_repair_vfs_v20260209(conn, runner)?;

        // V20260210: 答题提交（3 列，answer_submissions 表天然幂等）
        self.pre_repair_vfs_v20260210(conn, runner)?;

        Ok(())
    }

    /// 确保 __change_log 表存在（通用防御）
    ///
    /// 所有四个数据库的 V20260131 都创建 __change_log 表。
    /// 旧版 set_grouped(true) 时代，SQLite DDL 回滚后表可能被删除，
    /// 但 refinery_schema_history 中的记录未被回滚，导致：
    /// - 迁移记录显示 V20260131 已完成
    /// - __change_log 表实际不存在
    /// - verify_migrations 阶段 fail-close，阻塞所有后续迁移
    ///
    /// 此方法在 pre_repair 阶段统一检测并修复此问题。
    /// V20260131 SQL 全部使用 IF NOT EXISTS，可安全重复执行。
    #[cfg(feature = "data_governance")]
    fn ensure_change_log_table(
        &self,
        conn: &rusqlite::Connection,
        db_name: &str,
        change_log_sql: &str,
        core_table: &str,
    ) -> Result<(), MigrationError> {
        const CHANGE_LOG_VERSION: i32 = 20260131;

        // 场景 1：迁移已记录但表不存在（DDL 回滚残留）
        if self.is_migration_recorded(conn, CHANGE_LOG_VERSION)?
            && !self.table_exists(conn, "__change_log")?
        {
            tracing::info!(
                "🔧 [PreRepair] {}: V{} 已记录但 __change_log 表不存在，重新执行幂等 SQL",
                db_name,
                CHANGE_LOG_VERSION
            );
            conn.execute_batch(change_log_sql).map_err(|e| {
                MigrationError::Database(format!("重新执行 {} V20260131 SQL 失败: {}", db_name, e))
            })?;
        }

        // 场景 2：核心表存在但 __change_log 缺失（旧库从未成功执行过 V20260131）
        if self.table_exists(conn, core_table)? && !self.table_exists(conn, "__change_log")? {
            tracing::info!(
                "🔧 [PreRepair] {}: 核心表存在但 __change_log 缺失，补齐",
                db_name
            );
            conn.execute_batch(change_log_sql).map_err(|e| {
                MigrationError::Database(format!("补齐 {} __change_log 表失败: {}", db_name, e))
            })?;
        }

        Ok(())
    }

    /// 确保 refinery_schema_history 存在（用于手动标记迁移）
    #[cfg(feature = "data_governance")]
    fn ensure_refinery_history_table(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<(), MigrationError> {
        if self.table_exists(conn, "refinery_schema_history")? {
            return Ok(());
        }
        conn.execute(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            )",
            [],
        )
        .map_err(|e| MigrationError::Database(e.to_string()))?;
        Ok(())
    }

    /// 添加列（若缺失）
    #[cfg(feature = "data_governance")]
    fn add_column_if_missing(
        &self,
        conn: &rusqlite::Connection,
        table_name: &str,
        column_name: &str,
        column_def: &str,
    ) -> Result<bool, MigrationError> {
        if !self.table_exists(conn, table_name)? {
            return Ok(false);
        }
        if self.column_exists(conn, table_name, column_name)? {
            return Ok(false);
        }
        let sql = format!(
            "ALTER TABLE {} ADD COLUMN {} {}",
            table_name, column_name, column_def
        );
        conn.execute(&sql, []).map_err(|e| {
            MigrationError::Database(format!(
                "为 {} 添加 {} 列失败: {}",
                table_name, column_name, e
            ))
        })?;
        Ok(true)
    }

    /// 仅补齐 resources/notes/questions/folders 的 deleted_at（避免与迁移冲突）
    ///
    /// ## deleted_at 类型说明
    ///
    /// 所有表的 `deleted_at` 统一使用 `TEXT`（ISO 8601 格式）。
    ///
    /// 历史说明：V20260130 init.sql 中 resources 表原本使用 INTEGER 毫秒时间戳，
    /// V20260207 迁移已将其统一为 TEXT 类型。此处 pre-repair 使用 TEXT，
    /// 即使 resources 表尚未执行 V20260207，SQLite 动态类型也能兼容。
    #[cfg(feature = "data_governance")]
    fn ensure_vfs_deleted_at_core(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<(), MigrationError> {
        // 统一使用 TEXT 类型（V20260207 迁移将 resources 从 INTEGER 改为 TEXT）
        let tables_with_deleted_at = ["resources", "notes", "questions", "folders"];

        for table_name in tables_with_deleted_at {
            if self.add_column_if_missing(conn, table_name, "deleted_at", "TEXT")? {
                tracing::info!(
                    "🔧 [PreRepair] VFS: 为 {} 表添加缺失的 deleted_at 列 (TEXT)",
                    table_name
                );
            }
        }

        Ok(())
    }

    /// 判断 V20260201 迁移是否会因重复列而失败
    #[cfg(feature = "data_governance")]
    fn vfs_sync_fields_would_conflict(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<bool, MigrationError> {
        let targets: &[(&str, &[&str])] = &[
            ("resources", &["device_id", "local_version"]),
            ("notes", &["device_id", "local_version"]),
            ("questions", &["device_id", "local_version"]),
            (
                "review_plans",
                &["device_id", "local_version", "deleted_at"],
            ),
            ("folders", &["device_id", "local_version"]),
        ];

        for (table_name, columns) in targets {
            if !self.table_exists(conn, table_name)? {
                continue;
            }
            for column in *columns {
                if self.column_exists(conn, table_name, column)? {
                    return Ok(true);
                }
            }
        }

        Ok(false)
    }

    /// 兼容处理 V20260201：补齐列与索引，然后标记迁移完成
    #[cfg(feature = "data_governance")]
    fn apply_vfs_sync_fields_compat(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<(), MigrationError> {
        // 先补齐 deleted_at（核心表）
        self.ensure_vfs_deleted_at_core(conn)?;

        // 补齐同步字段
        let _ = self.add_column_if_missing(conn, "resources", "device_id", "TEXT")?;
        let _ =
            self.add_column_if_missing(conn, "resources", "local_version", "INTEGER DEFAULT 0")?;
        let _ = self.add_column_if_missing(conn, "notes", "device_id", "TEXT")?;
        let _ = self.add_column_if_missing(conn, "notes", "local_version", "INTEGER DEFAULT 0")?;
        let _ = self.add_column_if_missing(conn, "questions", "device_id", "TEXT")?;
        let _ =
            self.add_column_if_missing(conn, "questions", "local_version", "INTEGER DEFAULT 0")?;
        let _ = self.add_column_if_missing(conn, "review_plans", "device_id", "TEXT")?;
        let _ =
            self.add_column_if_missing(conn, "review_plans", "local_version", "INTEGER DEFAULT 0")?;
        let _ = self.add_column_if_missing(conn, "review_plans", "deleted_at", "TEXT")?;
        let _ = self.add_column_if_missing(conn, "folders", "device_id", "TEXT")?;
        let _ =
            self.add_column_if_missing(conn, "folders", "local_version", "INTEGER DEFAULT 0")?;

        // 创建索引（全部 IF NOT EXISTS，安全幂等）
        let index_sqls = [
            // resources
            "CREATE INDEX IF NOT EXISTS idx_resources_local_version ON resources(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_resources_device_id ON resources(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_resources_updated_at ON resources(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_resources_device_version ON resources(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_resources_updated_not_deleted ON resources(updated_at) WHERE deleted_at IS NULL",
            // notes
            "CREATE INDEX IF NOT EXISTS idx_notes_local_version ON notes(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_notes_deleted_at_sync ON notes(deleted_at)",
            "CREATE INDEX IF NOT EXISTS idx_notes_device_id ON notes(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_notes_device_version ON notes(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_notes_updated_not_deleted ON notes(updated_at) WHERE deleted_at IS NULL",
            // questions
            "CREATE INDEX IF NOT EXISTS idx_questions_local_version ON questions(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_questions_device_id ON questions(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_questions_updated_at ON questions(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_questions_device_version ON questions(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_questions_updated_not_deleted ON questions(updated_at) WHERE deleted_at IS NULL",
            // review_plans
            "CREATE INDEX IF NOT EXISTS idx_review_plans_local_version ON review_plans(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_review_plans_deleted_at ON review_plans(deleted_at)",
            "CREATE INDEX IF NOT EXISTS idx_review_plans_device_id ON review_plans(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_review_plans_updated_at ON review_plans(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_review_plans_device_version ON review_plans(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_review_plans_updated_not_deleted ON review_plans(updated_at) WHERE deleted_at IS NULL",
            // folders
            "CREATE INDEX IF NOT EXISTS idx_folders_local_version ON folders(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_folders_device_id ON folders(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_folders_updated_at ON folders(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_folders_device_version ON folders(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_folders_updated_not_deleted ON folders(updated_at) WHERE deleted_at IS NULL",
        ];

        for sql in index_sqls {
            conn.execute(sql, [])
                .map_err(|e| MigrationError::Database(format!("创建索引失败: {} ({})", sql, e)))?;
        }

        Ok(())
    }

    #[cfg(feature = "data_governance")]
    fn index_exists(
        &self,
        conn: &rusqlite::Connection,
        index_name: &str,
    ) -> Result<bool, MigrationError> {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
                [index_name],
                |row| row.get(0),
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        Ok(exists)
    }

    #[cfg(feature = "data_governance")]
    fn trigger_exists(
        &self,
        conn: &rusqlite::Connection,
        trigger_name: &str,
    ) -> Result<bool, MigrationError> {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)",
                [trigger_name],
                |row| row.get(0),
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        Ok(exists)
    }

    #[cfg(feature = "data_governance")]
    fn repair_recorded_migration_schema_gaps(
        &self,
        conn: &rusqlite::Connection,
        id: &DatabaseId,
        runner: &refinery::Runner,
    ) -> Result<bool, MigrationError> {
        match id {
            DatabaseId::Vfs => self.repair_vfs_v20260714_vector_index_profiles(conn, runner),
            DatabaseId::Mistakes => self.repair_mistakes_v20260523_document_tasks(conn),
            _ => Ok(false),
        }
    }

    #[cfg(feature = "data_governance")]
    fn repair_vfs_v20260714_vector_index_profiles(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<bool, MigrationError> {
        use super::vfs::V20260714_ADD_VECTOR_INDEX_PROFILES as MIGRATION;

        const VERSION: i32 = 20260714;
        if !self.is_migration_recorded(conn, VERSION)? || !self.table_exists(conn, "resources")? {
            return Ok(false);
        }

        let current_migration = runner
            .get_migrations()
            .iter()
            .find(|migration| migration.version() == VERSION)
            .ok_or_else(|| {
                MigrationError::Database(format!(
                    "VFS migration runner does not contain V{}",
                    VERSION
                ))
            })?;
        let recorded_checksum: String = conn
            .query_row(
                "SELECT checksum FROM refinery_schema_history WHERE version = ?1",
                [VERSION],
                |row| row.get(0),
            )
            .map_err(|error| MigrationError::Database(error.to_string()))?;
        let checksum_drift = recorded_checksum != current_migration.checksum().to_string();

        let mut schema_or_data_repair = checksum_drift;
        if self.table_exists(conn, "vfs_index_profiles")? {
            for column in [
                "id",
                "model_fingerprint",
                "dimension",
                "modality",
                "embedding_protocol",
                "lance_table_name",
            ] {
                if !self.column_exists(conn, "vfs_index_profiles", column)? {
                    return Err(MigrationError::Database(format!(
                        "recorded VFS V{} has an incompatible vfs_index_profiles table: missing {}",
                        VERSION, column
                    )));
                }
            }
            for (column, definition) in [
                ("model_config_id", "TEXT"),
                ("model_name", "TEXT"),
                ("schema_version", "INTEGER NOT NULL DEFAULT 1"),
                ("active_generation", "INTEGER NOT NULL DEFAULT 0"),
                ("state", "TEXT NOT NULL DEFAULT 'active'"),
                ("ann_metric", "TEXT NOT NULL DEFAULT 'legacy_l2'"),
                ("ann_index_version", "INTEGER NOT NULL DEFAULT 0"),
                ("created_at", "INTEGER NOT NULL DEFAULT 0"),
                ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
            ] {
                schema_or_data_repair |=
                    self.add_column_if_missing(conn, "vfs_index_profiles", column, definition)?;
            }
        }

        for (table, column) in Self::parse_alter_add_columns(MIGRATION.sql) {
            if !self.table_exists(conn, &table)? {
                return Err(MigrationError::Database(format!(
                    "recorded VFS V{} requires missing base table {}",
                    VERSION, table
                )));
            }
            let definition = Self::extract_column_def(MIGRATION.sql, &table, &column);
            schema_or_data_repair |=
                self.add_column_if_missing(conn, &table, &column, &definition)?;
        }

        for table in MIGRATION.expected_tables {
            schema_or_data_repair |= !self.table_exists(conn, table)?;
        }
        for (table, column) in MIGRATION.expected_columns {
            schema_or_data_repair |= !self.column_exists(conn, table, column)?;
        }
        let mut missing_index = false;
        for index in MIGRATION.expected_indexes {
            missing_index |= !self.index_exists(conn, index)?;
        }

        if !schema_or_data_repair && !missing_index {
            return Ok(false);
        }

        if schema_or_data_repair {
            // The migration SQL keeps ALTER statements for fresh databases. For a
            // recorded older draft, replay the idempotent profile/index DDL and
            // data backfills after its columns have converged.
            Self::replay_migration_without_alter_add_columns(conn, MIGRATION.sql, VERSION)?;
        } else {
            // Recreating a dropped index must not enqueue every resource for a
            // vector rebuild. This branch contains DDL only.
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_vfs_index_profiles_route
                    ON vfs_index_profiles(modality, dimension, state);
                 CREATE INDEX IF NOT EXISTS idx_vfs_index_profiles_model
                    ON vfs_index_profiles(model_config_id, state);
                 CREATE INDEX IF NOT EXISTS idx_vfs_index_segments_profile_generation
                    ON vfs_index_segments(index_profile_id, generation);
                 CREATE INDEX IF NOT EXISTS idx_vfs_index_units_text_profile
                    ON vfs_index_units(text_profile_id, text_generation);
                 CREATE INDEX IF NOT EXISTS idx_vfs_index_units_mm_profile
                    ON vfs_index_units(mm_profile_id, mm_generation);
                 CREATE INDEX IF NOT EXISTS idx_resources_index_retry_due
                    ON resources(index_state, index_next_retry_at);
                 CREATE INDEX IF NOT EXISTS idx_resources_mm_index_retry_due
                    ON resources(mm_index_state, mm_index_next_retry_at);
                 CREATE INDEX IF NOT EXISTS idx_lance_orphan_retry_due
                    ON __lance_orphan_queue(next_retry_at, enqueued_at);",
            )
            .map_err(|error| MigrationError::Database(error.to_string()))?;
        }

        MigrationVerifier::verify(conn, &MIGRATION)?;

        tracing::warn!(
            database = "vfs",
            version = VERSION,
            "Repaired recorded vector profile migration schema gap"
        );
        Ok(true)
    }

    #[cfg(feature = "data_governance")]
    fn repair_mistakes_v20260523_document_tasks(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<bool, MigrationError> {
        const VERSION: i32 = 20260523;
        if !self.is_migration_recorded(conn, VERSION)?
            || !self.table_exists(conn, "document_tasks")?
        {
            return Ok(false);
        }

        let mut repaired = false;

        for (column, definition) in [
            ("device_id", "TEXT"),
            ("local_version", "INTEGER DEFAULT 0"),
            ("deleted_at", "TEXT"),
        ] {
            repaired |= self.add_column_if_missing(conn, "document_tasks", column, definition)?;
        }

        for (name, sql) in [
            (
                "idx_document_tasks_local_version",
                "CREATE INDEX IF NOT EXISTS idx_document_tasks_local_version ON document_tasks(local_version)",
            ),
            (
                "idx_document_tasks_deleted_at",
                "CREATE INDEX IF NOT EXISTS idx_document_tasks_deleted_at ON document_tasks(deleted_at)",
            ),
            (
                "idx_document_tasks_device_id",
                "CREATE INDEX IF NOT EXISTS idx_document_tasks_device_id ON document_tasks(device_id)",
            ),
            (
                "idx_document_tasks_sync_updated_at",
                "CREATE INDEX IF NOT EXISTS idx_document_tasks_sync_updated_at ON document_tasks(updated_at)",
            ),
            (
                "idx_document_tasks_device_version",
                "CREATE INDEX IF NOT EXISTS idx_document_tasks_device_version ON document_tasks(device_id, local_version)",
            ),
            (
                "idx_document_tasks_updated_not_deleted",
                "CREATE INDEX IF NOT EXISTS idx_document_tasks_updated_not_deleted ON document_tasks(updated_at) WHERE deleted_at IS NULL",
            ),
        ] {
            if !self.index_exists(conn, name)? {
                repaired = true;
            }
            conn.execute(sql, []).map_err(|e| {
                MigrationError::Database(format!(
                    "repair mistakes V{} index {} failed: {}",
                    VERSION, name, e
                ))
            })?;
        }

        for (name, sql) in [
            (
                "trg__change_log_document_tasks_insert",
                "CREATE TRIGGER IF NOT EXISTS trg__change_log_document_tasks_insert
AFTER INSERT ON document_tasks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('document_tasks', NEW.id, 'INSERT');
END;",
            ),
            (
                "trg__change_log_document_tasks_update",
                "CREATE TRIGGER IF NOT EXISTS trg__change_log_document_tasks_update
AFTER UPDATE ON document_tasks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('document_tasks', NEW.id, 'UPDATE');
END;",
            ),
            (
                "trg__change_log_document_tasks_delete",
                "CREATE TRIGGER IF NOT EXISTS trg__change_log_document_tasks_delete
AFTER DELETE ON document_tasks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('document_tasks', OLD.id, 'DELETE');
END;",
            ),
        ] {
            if !self.trigger_exists(conn, name)? {
                repaired = true;
            }
            conn.execute_batch(sql).map_err(|e| {
                MigrationError::Database(format!(
                    "repair mistakes V{} trigger {} failed: {}",
                    VERSION, name, e
                ))
            })?;
        }

        if repaired {
            tracing::warn!(
                database = "mistakes",
                version = VERSION,
                "Repaired recorded migration schema gap for document_tasks sync coverage"
            );
        }

        Ok(repaired)
    }

    /// V20260204: PDF 处理状态字段预修复
    ///
    /// 检查 files 表的 processing_status 等列是否已存在但迁移未记录，
    /// 如果是则补齐所有列/索引并标记迁移完成。
    #[cfg(feature = "data_governance")]
    fn pre_repair_vfs_v20260204(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        const VERSION: i32 = 20260204;

        if !self.table_exists(conn, "files")? {
            return Ok(());
        }
        if self.is_migration_recorded(conn, VERSION)? {
            return Ok(());
        }

        // 检查是否有任一 PDF 处理字段已存在
        if !self.column_exists(conn, "files", "processing_status")? {
            return Ok(());
        }

        tracing::info!(
            "🔧 [PreRepair] VFS: 检测到 PDF 处理字段残留，补齐并标记 V{}",
            VERSION
        );

        // 补齐所有列
        let _ = self.add_column_if_missing(
            conn,
            "files",
            "processing_status",
            "TEXT DEFAULT 'pending'",
        )?;
        let _ = self.add_column_if_missing(conn, "files", "processing_progress", "TEXT")?;
        let _ = self.add_column_if_missing(conn, "files", "processing_error", "TEXT")?;
        let _ = self.add_column_if_missing(conn, "files", "processing_started_at", "INTEGER")?;
        let _ = self.add_column_if_missing(conn, "files", "processing_completed_at", "INTEGER")?;

        // 补齐索引
        let index_sqls: &[&str] = &[
            "CREATE INDEX IF NOT EXISTS idx_files_processing_status ON files(processing_status)",
            "CREATE INDEX IF NOT EXISTS idx_files_pdf_processing ON files(mime_type, processing_status) WHERE mime_type = 'application/pdf'",
            "CREATE INDEX IF NOT EXISTS idx_files_processing_started ON files(processing_started_at) WHERE processing_status IN ('text_extraction', 'page_rendering', 'ocr_processing', 'vector_indexing')",
        ];
        for sql in index_sqls {
            conn.execute(sql, []).map_err(|e| {
                MigrationError::Database(format!("VFS V20260204 索引创建失败: {} ({})", sql, e))
            })?;
        }

        // P1-1 修复：执行 V20260204 中的 UPDATE 回填语句（幂等，WHERE 条件确保不重复更新）
        // 如果不执行，已有 PDF 的 processing_status 会保持 'pending' 而非根据实际内容设为 'completed'
        let backfill_sqls: &[&str] = &[
            "UPDATE files SET processing_status = 'completed', processing_progress = '{\"stage\":\"completed\",\"percent\":100,\"ready_modes\":[\"text\",\"image\"]}', processing_completed_at = (strftime('%s', 'now') * 1000) WHERE mime_type = 'application/pdf' AND processing_status = 'pending' AND (preview_json IS NOT NULL OR extracted_text IS NOT NULL)",
            "UPDATE files SET processing_progress = '{\"stage\":\"completed\",\"percent\":100,\"ready_modes\":[\"text\",\"image\",\"ocr\"]}' WHERE mime_type = 'application/pdf' AND processing_status = 'completed' AND ocr_pages_json IS NOT NULL",
        ];
        for sql in backfill_sqls {
            if let Err(e) = conn.execute(sql, []) {
                tracing::warn!(
                    "VFS V20260204 回填 PDF 处理状态失败（继续）: {} ({})",
                    sql,
                    e
                );
            }
        }

        self.ensure_refinery_history_table(conn)?;
        self.mark_migration_complete(conn, runner, VERSION)?;
        Ok(())
    }

    /// V20260205: 压缩 blob hash 预修复
    #[cfg(feature = "data_governance")]
    fn pre_repair_vfs_v20260205(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        const VERSION: i32 = 20260205;

        if !self.table_exists(conn, "files")? {
            return Ok(());
        }
        if self.is_migration_recorded(conn, VERSION)? {
            return Ok(());
        }
        if !self.column_exists(conn, "files", "compressed_blob_hash")? {
            return Ok(());
        }

        tracing::info!(
            "🔧 [PreRepair] VFS: 检测到 compressed_blob_hash 残留，标记 V{}",
            VERSION
        );

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_files_compressed_blob_hash ON files(compressed_blob_hash)",
            [],
        ).map_err(|e| MigrationError::Database(format!("VFS V20260205 索引创建失败: {}", e)))?;

        self.ensure_refinery_history_table(conn)?;
        self.mark_migration_complete(conn, runner, VERSION)?;
        Ok(())
    }

    /// V20260209: 题目图片字段预修复
    #[cfg(feature = "data_governance")]
    fn pre_repair_vfs_v20260209(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        const VERSION: i32 = 20260209;

        if !self.table_exists(conn, "questions")? {
            return Ok(());
        }
        if self.is_migration_recorded(conn, VERSION)? {
            return Ok(());
        }
        if !self.column_exists(conn, "questions", "images_json")? {
            return Ok(());
        }

        tracing::info!(
            "🔧 [PreRepair] VFS: 检测到 images_json 残留，标记 V{}",
            VERSION
        );

        self.ensure_refinery_history_table(conn)?;
        self.mark_migration_complete(conn, runner, VERSION)?;
        Ok(())
    }

    /// V20260210: 答题提交字段预修复
    ///
    /// answer_submissions 表使用 CREATE TABLE IF NOT EXISTS（天然幂等），
    /// 仅需处理 questions 表的 3 个 ALTER TABLE ADD COLUMN。
    #[cfg(feature = "data_governance")]
    fn pre_repair_vfs_v20260210(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        const VERSION: i32 = 20260210;

        if !self.table_exists(conn, "questions")? {
            return Ok(());
        }
        if self.is_migration_recorded(conn, VERSION)? {
            return Ok(());
        }

        // 检查是否有任一 AI 评判字段已存在
        let has_any = self.column_exists(conn, "questions", "ai_feedback")?
            || self.column_exists(conn, "questions", "ai_score")?
            || self.column_exists(conn, "questions", "ai_graded_at")?;

        if !has_any {
            return Ok(());
        }

        tracing::info!(
            "🔧 [PreRepair] VFS: 检测到答题提交字段残留，补齐并标记 V{}",
            VERSION
        );

        // 补齐 questions 表列
        let _ = self.add_column_if_missing(conn, "questions", "ai_feedback", "TEXT")?;
        let _ = self.add_column_if_missing(conn, "questions", "ai_score", "INTEGER")?;
        let _ = self.add_column_if_missing(conn, "questions", "ai_graded_at", "TEXT")?;

        // answer_submissions 表天然幂等（CREATE TABLE IF NOT EXISTS）
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS answer_submissions (
                id TEXT PRIMARY KEY NOT NULL,
                question_id TEXT NOT NULL,
                user_answer TEXT NOT NULL,
                is_correct INTEGER,
                grading_method TEXT NOT NULL DEFAULT 'auto',
                submitted_at TEXT NOT NULL,
                FOREIGN KEY (question_id) REFERENCES questions(id)
            );
            CREATE INDEX IF NOT EXISTS idx_submissions_question
                ON answer_submissions(question_id, submitted_at DESC);",
        )
        .map_err(|e| {
            MigrationError::Database(format!("VFS V20260210 answer_submissions 创建失败: {}", e))
        })?;

        self.ensure_refinery_history_table(conn)?;
        self.mark_migration_complete(conn, runner, VERSION)?;
        Ok(())
    }

    /// 预修复 chat_v2 数据库的 schema
    ///
    /// 处理多个版本的迁移残留：
    /// - V20260130: 旧库缺少新增表（sleep_block, subagent_task, workspace_index 等）
    /// - V20260201: 同步字段（device_id, local_version, updated_at, deleted_at）
    /// - V20260204: 会话分组（group_id）
    /// - V20260207: active_skill_ids_json
    #[cfg(feature = "data_governance")]
    fn pre_repair_chat_v2_schema(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        // --- V20260130: 旧库表补齐 ---
        // 旧库可能只有 chat_v2_sessions/messages/blocks 等核心表，
        // 缺少后续添加到 init SQL 的表（sleep_block, subagent_task, workspace_index,
        // chat_v2_todo_lists, chat_v2_session_state, resources 等）。
        // V20260130 init SQL 全部使用 CREATE TABLE/INDEX IF NOT EXISTS，天然幂等，
        // 可安全回放补齐缺失表，不影响已有数据。
        if self.table_exists(conn, "chat_v2_sessions")? {
            conn.execute_batch(include_str!(
                "../../../migrations/chat_v2/V20260130__init.sql"
            ))
            .map_err(|e| {
                MigrationError::Database(format!("回放 chat_v2 init 补齐缺失表失败: {}", e))
            })?;
        }

        // --- V20260131: __change_log 表修复（通用防御） ---
        self.ensure_change_log_table(
            conn,
            "chat_v2",
            include_str!("../../../migrations/chat_v2/V20260131__add_change_log.sql"),
            "chat_v2_sessions",
        )?;

        // --- V20260201: 同步字段 ---
        self.pre_repair_chat_v2_v20260201(conn, runner)?;

        // --- V20260204: 会话分组 ---
        self.pre_repair_chat_v2_v20260204(conn, runner)?;

        // --- V20260207: active_skill_ids_json ---
        {
            const TARGET_VERSION: i32 = 20260207;
            const PREVIOUS_VERSION: u32 = 20260204;
            const TARGET_COLUMN: &str = "active_skill_ids_json";
            const TARGET_TABLE: &str = "chat_v2_session_state";

            if self.table_exists(conn, TARGET_TABLE)?
                && self.get_current_version(conn)? >= PREVIOUS_VERSION
                && !self.is_migration_recorded(conn, TARGET_VERSION)?
            {
                // 旧库兼容：主动补齐列（幂等），然后标记迁移完成
                let _ = self.add_column_if_missing(
                    conn,
                    TARGET_TABLE,
                    TARGET_COLUMN,
                    "TEXT DEFAULT '[]'",
                )?;
                tracing::info!(
                    "🔧 [PreRepair] chat_v2: {} 列已补齐，标记 V{} 迁移为已完成",
                    TARGET_COLUMN,
                    TARGET_VERSION
                );
                self.ensure_refinery_history_table(conn)?;
                self.mark_migration_complete(conn, runner, TARGET_VERSION)?;
            }
        }

        // --- V20260221: 分组关联来源（pinned_resource_ids_json） ---
        {
            const TARGET_VERSION: i32 = 20260221;
            const PREVIOUS_VERSION: u32 = 20260207;
            const TARGET_COLUMN: &str = "pinned_resource_ids_json";
            const TARGET_TABLE: &str = "chat_v2_session_groups";

            if self.table_exists(conn, TARGET_TABLE)?
                && self.get_current_version(conn)? >= PREVIOUS_VERSION
                && !self.is_migration_recorded(conn, TARGET_VERSION)?
            {
                let _ = self.add_column_if_missing(
                    conn,
                    TARGET_TABLE,
                    TARGET_COLUMN,
                    "TEXT DEFAULT '[]'",
                )?;
                tracing::info!(
                    "🔧 [PreRepair] chat_v2: {} 列已补齐，标记 V{} 迁移为已完成",
                    TARGET_COLUMN,
                    TARGET_VERSION
                );
                self.ensure_refinery_history_table(conn)?;
                self.mark_migration_complete(conn, runner, TARGET_VERSION)?;
            }
        }

        // --- V20260306: skill_state_json ---
        {
            const TARGET_VERSION: i32 = 20260306;
            const PREVIOUS_VERSION: u32 = 20260302;
            const TARGET_COLUMN: &str = "skill_state_json";
            const TARGET_TABLE: &str = "chat_v2_session_state";

            if self.table_exists(conn, TARGET_TABLE)?
                && self.get_current_version(conn)? >= PREVIOUS_VERSION
                && !self.is_migration_recorded(conn, TARGET_VERSION)?
            {
                let _ = self.add_column_if_missing(conn, TARGET_TABLE, TARGET_COLUMN, "TEXT")?;
                let _ = conn
                    .execute(
                        r#"
                    UPDATE chat_v2_session_state
                    SET skill_state_json = json_object(
                        'manualPinnedSkillIds', json(COALESCE(active_skill_ids_json, '[]')),
                        'modeRequiredBundleIds', json('[]'),
                        'agenticSessionSkillIds', json(COALESCE(loaded_skill_ids_json, '[]')),
                        'branchLocalSkillIds', json('[]'),
                        'effectiveAllowedInternalTools', json('[]'),
                        'effectiveAllowedExternalTools', json('[]'),
                        'effectiveAllowedExternalServers', json('[]'),
                        'version', 0,
                        'legacyMigrated', 1
                    )
                    WHERE skill_state_json IS NULL
                    "#,
                        [],
                    )
                    .map_err(|e| {
                        MigrationError::Database(format!(
                            "回填 chat_v2.skill_state_json 失败: {}",
                            e
                        ))
                    })?;
                tracing::info!(
                    "🔧 [PreRepair] chat_v2: {} 列已补齐，标记 V{} 迁移为已完成",
                    TARGET_COLUMN,
                    TARGET_VERSION
                );
                self.ensure_refinery_history_table(conn)?;
                self.mark_migration_complete(conn, runner, TARGET_VERSION)?;
            }
        }

        // --- V20260717: 课题首选 runtime root ---
        {
            const TARGET_VERSION: i32 = 20260717;
            const PREVIOUS_VERSION: u32 = 20260711;
            const TARGET_TABLE: &str = "chat_v2_session_groups";

            if self.table_exists(conn, TARGET_TABLE)?
                && self.get_current_version(conn)? >= PREVIOUS_VERSION
                && !self.is_migration_recorded(conn, TARGET_VERSION)?
            {
                let _ = self.add_column_if_missing(
                    conn,
                    TARGET_TABLE,
                    "default_runtime_root_id",
                    "TEXT",
                )?;
                let _ = self.add_column_if_missing(
                    conn,
                    TARGET_TABLE,
                    "preferred_project_root_path",
                    "TEXT",
                )?;
                tracing::info!(
                    "🔧 [PreRepair] chat_v2: 课题首选 runtime root 列已补齐，标记 V{} 迁移为已完成",
                    TARGET_VERSION
                );
                self.ensure_refinery_history_table(conn)?;
                self.mark_migration_complete(conn, runner, TARGET_VERSION)?;
            }
        }

        Ok(())
    }

    /// V20260201: Chat V2 同步字段预修复
    ///
    /// 处理 chat_v2_sessions/messages/blocks 三表的 11 个 ALTER TABLE ADD COLUMN
    /// 和 18 个索引。
    ///
    /// ## 触发场景
    ///
    /// 1. **残留修复**：部分同步列已存在（之前失败的迁移残留），补齐缺失部分
    /// 2. **旧库兼容**：旧库通过 baseline 跳到高版本（如 V20260207），
    ///    V20260201 从未执行，但 verify_migrations 会检查其索引。
    ///    此时主动补齐所有列和索引，避免验证失败。
    #[cfg(feature = "data_governance")]
    fn pre_repair_chat_v2_v20260201(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        const VERSION: i32 = 20260201;
        const PREVIOUS_VERSION: u32 = 20260131;

        if !self.table_exists(conn, "chat_v2_sessions")? {
            return Ok(());
        }
        if self.is_migration_recorded(conn, VERSION)? {
            return Ok(());
        }
        if self.get_current_version(conn)? < PREVIOUS_VERSION {
            return Ok(());
        }

        // 旧库兼容：即使同步列都不存在，只要是旧库（核心表存在但 V20260201 未记录），
        // 也需要主动补齐所有列和索引，因为 verify_migrations 会检查它们。
        tracing::info!(
            "🔧 [PreRepair] chat_v2: 补齐 V{} 同步字段和索引（旧库兼容/残留修复）",
            VERSION
        );

        // 补齐所有列
        let sync_columns: &[(&str, &str, &str)] = &[
            ("chat_v2_sessions", "device_id", "TEXT"),
            ("chat_v2_sessions", "local_version", "INTEGER DEFAULT 0"),
            ("chat_v2_sessions", "deleted_at", "TEXT"),
            ("chat_v2_messages", "device_id", "TEXT"),
            ("chat_v2_messages", "local_version", "INTEGER DEFAULT 0"),
            ("chat_v2_messages", "updated_at", "TEXT"),
            ("chat_v2_messages", "deleted_at", "TEXT"),
            ("chat_v2_blocks", "device_id", "TEXT"),
            ("chat_v2_blocks", "local_version", "INTEGER DEFAULT 0"),
            ("chat_v2_blocks", "updated_at", "TEXT"),
            ("chat_v2_blocks", "deleted_at", "TEXT"),
        ];

        for (table, col, def) in sync_columns {
            let _ = self.add_column_if_missing(conn, table, col, def)?;
        }

        // 补齐索引
        let index_sqls: &[&str] = &[
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_local_version ON chat_v2_sessions(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_deleted_at ON chat_v2_sessions(deleted_at)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_device_id ON chat_v2_sessions(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_sync_updated_at ON chat_v2_sessions(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_local_version ON chat_v2_messages(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_deleted_at ON chat_v2_messages(deleted_at)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_device_id ON chat_v2_messages(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_sync_updated_at ON chat_v2_messages(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_local_version ON chat_v2_blocks(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_deleted_at ON chat_v2_blocks(deleted_at)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_device_id ON chat_v2_blocks(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_sync_updated_at ON chat_v2_blocks(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_device_version ON chat_v2_sessions(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_device_version ON chat_v2_messages(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_device_version ON chat_v2_blocks(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_updated_not_deleted ON chat_v2_sessions(updated_at) WHERE deleted_at IS NULL",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_updated_not_deleted ON chat_v2_messages(updated_at) WHERE deleted_at IS NULL",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_updated_not_deleted ON chat_v2_blocks(updated_at) WHERE deleted_at IS NULL",
        ];

        for sql in index_sqls {
            conn.execute(sql, []).map_err(|e| {
                MigrationError::Database(format!("Chat V2 V20260201 索引创建失败: {} ({})", sql, e))
            })?;
        }

        self.ensure_refinery_history_table(conn)?;
        self.mark_migration_complete(conn, runner, VERSION)?;
        Ok(())
    }

    /// V20260204: Chat V2 会话分组预修复
    ///
    /// chat_v2_session_groups 表使用 CREATE TABLE IF NOT EXISTS（天然幂等），
    /// 仅需处理 chat_v2_sessions 表的 group_id ALTER TABLE ADD COLUMN。
    ///
    /// ## 触发场景
    ///
    /// 1. **残留修复**：group_id 列已存在但迁移未记录
    /// 2. **旧库兼容**：旧库 baseline 跳到高版本，V20260204 从未执行，
    ///    主动补齐列和索引避免 verify_migrations 失败
    #[cfg(feature = "data_governance")]
    fn pre_repair_chat_v2_v20260204(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        const VERSION: i32 = 20260204;
        const PREVIOUS_VERSION: u32 = 20260203;

        if !self.table_exists(conn, "chat_v2_sessions")? {
            return Ok(());
        }
        if self.is_migration_recorded(conn, VERSION)? {
            return Ok(());
        }
        if self.get_current_version(conn)? < PREVIOUS_VERSION {
            return Ok(());
        }

        tracing::info!(
            "🔧 [PreRepair] chat_v2: 补齐 V{} 会话分组字段和索引（旧库兼容/残留修复）",
            VERSION
        );

        // 补齐 group_id 列
        let _ = self.add_column_if_missing(conn, "chat_v2_sessions", "group_id", "TEXT")?;

        // chat_v2_session_groups 表天然幂等
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat_v2_session_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                icon TEXT,
                color TEXT,
                system_prompt TEXT,
                default_skill_ids_json TEXT DEFAULT '[]',
                workspace_id TEXT,
                sort_order INTEGER DEFAULT 0,
                persist_status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .map_err(|e| {
            MigrationError::Database(format!("Chat V2 V20260204 session_groups 创建失败: {}", e))
        })?;

        // 补齐索引
        let index_sqls: &[&str] = &[
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_sort_order ON chat_v2_session_groups(sort_order)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_status ON chat_v2_session_groups(persist_status)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_workspace ON chat_v2_session_groups(workspace_id)",
            "CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_group_id ON chat_v2_sessions(group_id)",
        ];

        for sql in index_sqls {
            conn.execute(sql, []).map_err(|e| {
                MigrationError::Database(format!("Chat V2 V20260204 索引创建失败: {} ({})", sql, e))
            })?;
        }

        self.ensure_refinery_history_table(conn)?;
        self.mark_migration_complete(conn, runner, VERSION)?;
        Ok(())
    }

    /// 预修复 mistakes 数据库的 schema
    ///
    /// 处理两类典型问题：
    /// 1. 旧库与 V20260130 契约不一致（缺表/缺列）
    /// 2. preview_data_json 已存在但 V20260207 未记录，导致 duplicate column
    #[cfg(feature = "data_governance")]
    fn pre_repair_mistakes_schema(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        const SYNC_VERSION: i32 = 20260201;
        const SYNC_PREVIOUS_VERSION: u32 = 20260131;
        const PREVIEW_VERSION: i32 = 20260207;
        const PREVIEW_PREVIOUS_VERSION: u32 = 20260201;
        const PREVIEW_COLUMN: &str = "preview_data_json";
        const PREVIEW_TABLE: &str = "custom_anki_templates";

        let has_mistakes = self.table_exists(conn, "mistakes")?;

        // 旧库兼容：只要存在核心表，就先执行 V20260130 契约补齐。
        // ⚠️ 必须先于 ensure_change_log_table 执行，因为 V20260131 的 change_log SQL
        //    包含引用 review_analyses 等表的触发器，这些表由 init_compat 补齐。
        if has_mistakes {
            self.apply_mistakes_init_compat(conn)?;

            // --- V20260131: __change_log 表修复（通用防御） ---
            // 放在 init_compat 之后，确保所有被触发器引用的表已存在
            self.ensure_change_log_table(
                conn,
                "mistakes",
                include_str!("../../../migrations/mistakes/V20260131__add_change_log.sql"),
                "mistakes",
            )?;
        } else {
            // 新库场景：核心表不存在时也尝试修复（由 Refinery 正常创建表后触发）
            self.ensure_change_log_table(
                conn,
                "mistakes",
                include_str!("../../../migrations/mistakes/V20260131__add_change_log.sql"),
                "mistakes",
            )?;
        }

        if has_mistakes && self.get_current_version(conn)? >= SYNC_PREVIOUS_VERSION {
            // 对旧库提前补齐 V20260201 同步字段与索引，避免后续迁移因重复列或缺列失败。
            self.apply_mistakes_sync_fields_compat(conn)?;
            if !self.is_migration_recorded(conn, SYNC_VERSION)? {
                self.ensure_refinery_history_table(conn)?;
                tracing::info!(
                    "🔧 [PreRepair] mistakes: sync 字段已补齐，标记 V{} 迁移为已完成",
                    SYNC_VERSION
                );
                self.mark_migration_complete(conn, runner, SYNC_VERSION)?;
            }
        }

        // 处理 V20260207 重复列问题（仅 legacy 路径）。
        // 新库不应提前写入高版本迁移记录，否则会跳过 init 迁移。
        if has_mistakes
            && self.get_current_version(conn)? >= PREVIEW_PREVIOUS_VERSION
            && self.table_exists(conn, PREVIEW_TABLE)?
        {
            let _ = self.add_column_if_missing(conn, PREVIEW_TABLE, PREVIEW_COLUMN, "TEXT")?;

            if !self.is_migration_recorded(conn, PREVIEW_VERSION)?
                && self.column_exists(conn, PREVIEW_TABLE, PREVIEW_COLUMN)?
            {
                self.ensure_refinery_history_table(conn)?;
                tracing::info!(
                    "🔧 [PreRepair] mistakes: {} 已就绪，标记 V{} 迁移为已完成",
                    PREVIEW_COLUMN,
                    PREVIEW_VERSION
                );
                self.mark_migration_complete(conn, runner, PREVIEW_VERSION)?;
            }
        }

        Ok(())
    }

    #[cfg(feature = "data_governance")]
    fn apply_mistakes_init_compat(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<(), MigrationError> {
        // 旧库可能只保留了部分列；init.sql 在后半段会创建索引/触发器。
        // 先补齐“被索引/触发器引用”的关键列，避免回放 init 时因缺列失败。
        let index_and_trigger_columns: &[(&str, &str, &str)] = &[
            ("mistakes", "irec_card_id", "TEXT"),
            ("mistakes", "updated_at", "TEXT"),
            ("chat_messages", "turn_id", "TEXT"),
            ("chat_messages", "mistake_id", "TEXT"),
            ("document_tasks", "document_id", "TEXT"),
            ("document_tasks", "status", "TEXT"),
            ("anki_cards", "task_id", "TEXT"),
            ("anki_cards", "is_error_card", "INTEGER NOT NULL DEFAULT 0"),
            ("anki_cards", "source_type", "TEXT NOT NULL DEFAULT ''"),
            ("anki_cards", "source_id", "TEXT NOT NULL DEFAULT ''"),
            ("anki_cards", "updated_at", "TEXT"),
            ("anki_cards", "text", "TEXT"),
            ("review_analyses", "updated_at", "TEXT"),
            (
                "custom_anki_templates",
                "is_active",
                "INTEGER NOT NULL DEFAULT 1",
            ),
            (
                "custom_anki_templates",
                "is_built_in",
                "INTEGER NOT NULL DEFAULT 0",
            ),
            ("document_control_states", "document_id", "TEXT"),
            ("document_control_states", "state", "TEXT"),
            (
                "document_control_states",
                "updated_at",
                "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
            ),
            ("vectorized_data", "mistake_id", "TEXT"),
            ("review_session_mistakes", "session_id", "TEXT"),
            ("review_session_mistakes", "mistake_id", "TEXT"),
            (
                "search_logs",
                "created_at",
                "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
            ),
            ("search_logs", "search_type", "TEXT"),
            ("exam_sheet_sessions", "status", "TEXT"),
        ];

        for (table_name, column_name, column_def) in index_and_trigger_columns {
            let _ = self.add_column_if_missing(conn, table_name, column_name, column_def)?;
        }

        // 旧库中可能缺少运行时查询依赖列，提前补齐以满足语义验证。
        let runtime_compat_columns: &[(&str, &str, &str)] = &[
            ("mistakes", "mistake_summary", "TEXT"),
            ("mistakes", "user_error_analysis", "TEXT"),
            ("mistakes", "irec_status", "INTEGER DEFAULT 0"),
            ("chat_messages", "graph_sources", "TEXT"),
            ("chat_messages", "turn_seq", "SMALLINT"),
            ("chat_messages", "reply_to_msg_id", "INTEGER"),
            ("chat_messages", "message_kind", "TEXT"),
            ("chat_messages", "lifecycle", "TEXT"),
            ("chat_messages", "metadata", "TEXT"),
            ("review_chat_messages", "web_search_sources", "TEXT"),
            ("review_chat_messages", "tool_call", "TEXT"),
            ("review_chat_messages", "tool_result", "TEXT"),
            ("review_chat_messages", "overrides", "TEXT"),
            ("review_chat_messages", "relations", "TEXT"),
        ];

        for (table_name, column_name, column_def) in runtime_compat_columns {
            let _ = self.add_column_if_missing(conn, table_name, column_name, column_def)?;
        }

        // 回放 init，补齐缺失表/索引/触发器
        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260130__init.sql"
        ))
        .map_err(|e| MigrationError::Database(format!("回放 mistakes init 失败: {}", e)))?;

        // 旧库在 baseline 被跳过时，可能缺失 change_log 表；该脚本幂等，可安全回放。
        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260131__add_change_log.sql"
        ))
        .map_err(|e| {
            MigrationError::Database(format!("回放 mistakes add_change_log 失败: {}", e))
        })?;

        // 再次兜底 text 列及索引，确保修复幂等且可重入
        let _ = self.add_column_if_missing(conn, "anki_cards", "text", "TEXT")?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_text ON anki_cards(text)",
            [],
        )
        .map_err(|e| MigrationError::Database(format!("创建 idx_anki_cards_text 失败: {}", e)))?;

        Ok(())
    }

    /// 对 mistakes V20260201 同步字段进行兼容补齐（幂等）。
    #[cfg(feature = "data_governance")]
    fn apply_mistakes_sync_fields_compat(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<(), MigrationError> {
        let sync_columns: &[(&str, &str, &str)] = &[
            ("mistakes", "device_id", "TEXT"),
            ("mistakes", "local_version", "INTEGER DEFAULT 0"),
            ("mistakes", "deleted_at", "TEXT"),
            ("anki_cards", "device_id", "TEXT"),
            ("anki_cards", "local_version", "INTEGER DEFAULT 0"),
            ("anki_cards", "deleted_at", "TEXT"),
            ("review_analyses", "device_id", "TEXT"),
            ("review_analyses", "local_version", "INTEGER DEFAULT 0"),
            ("review_analyses", "deleted_at", "TEXT"),
        ];

        for (table_name, column_name, column_def) in sync_columns {
            let _ = self.add_column_if_missing(conn, table_name, column_name, column_def)?;
        }

        let sync_index_sqls: &[&str] = &[
            "CREATE INDEX IF NOT EXISTS idx_mistakes_local_version ON mistakes(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_mistakes_deleted_at ON mistakes(deleted_at)",
            "CREATE INDEX IF NOT EXISTS idx_mistakes_device_id ON mistakes(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_mistakes_updated_at ON mistakes(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_local_version ON anki_cards(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_deleted_at ON anki_cards(deleted_at)",
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_device_id ON anki_cards(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_updated_at ON anki_cards(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_review_analyses_local_version ON review_analyses(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_review_analyses_deleted_at ON review_analyses(deleted_at)",
            "CREATE INDEX IF NOT EXISTS idx_review_analyses_device_id ON review_analyses(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_review_analyses_updated_at ON review_analyses(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_mistakes_device_version ON mistakes(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_device_version ON anki_cards(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_review_analyses_device_version ON review_analyses(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_mistakes_updated_not_deleted ON mistakes(updated_at) WHERE deleted_at IS NULL",
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_updated_not_deleted ON anki_cards(updated_at) WHERE deleted_at IS NULL",
            "CREATE INDEX IF NOT EXISTS idx_review_analyses_updated_not_deleted ON review_analyses(updated_at) WHERE deleted_at IS NULL",
        ];

        for sql in sync_index_sqls {
            conn.execute(sql, []).map_err(|e| {
                MigrationError::Database(format!("执行同步索引 SQL 失败: {} ({})", sql, e))
            })?;
        }

        Ok(())
    }

    /// 预修复 LLM Usage 数据库的 schema
    ///
    /// 处理两类问题：
    /// 1. V20260131: `__change_log` 表被记录为已完成但实际不存在
    ///    （旧版 set_grouped(true) 时代 SQLite DDL 回滚残留）
    /// 2. V20260201: 同步字段迁移失败后的残留状态
    #[cfg(feature = "data_governance")]
    fn pre_repair_llm_usage_schema(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
    ) -> Result<(), MigrationError> {
        // --- V20260131: __change_log 表修复（通用防御） ---
        self.ensure_change_log_table(
            conn,
            "llm_usage",
            include_str!("../../../migrations/llm_usage/V20260131__add_change_log.sql"),
            "llm_usage_logs",
        )?;

        const SYNC_VERSION: i32 = 20260201;

        // 新数据库（尚未创建表）无需预修复
        if !self.table_exists(conn, "llm_usage_logs")? {
            return Ok(());
        }

        // 如果迁移已记录，无需处理
        if self.is_migration_recorded(conn, SYNC_VERSION)? {
            return Ok(());
        }

        // 检查是否有任一同步字段已存在（说明部分迁移残留）
        let has_any_sync_field = self.column_exists(conn, "llm_usage_logs", "device_id")?
            || self.column_exists(conn, "llm_usage_logs", "local_version")?
            || self.column_exists(conn, "llm_usage_daily", "device_id")?;

        if !has_any_sync_field {
            return Ok(());
        }

        tracing::info!(
            "🔧 [PreRepair] llm_usage: 检测到同步字段残留，补齐并标记 V{}",
            SYNC_VERSION
        );

        // 补齐所有列（幂等）
        let sync_columns: &[(&str, &str, &str)] = &[
            ("llm_usage_logs", "device_id", "TEXT"),
            ("llm_usage_logs", "local_version", "INTEGER DEFAULT 0"),
            ("llm_usage_logs", "updated_at", "TEXT"),
            ("llm_usage_logs", "deleted_at", "TEXT"),
            ("llm_usage_daily", "device_id", "TEXT"),
            ("llm_usage_daily", "local_version", "INTEGER DEFAULT 0"),
            ("llm_usage_daily", "deleted_at", "TEXT"),
        ];

        for (table, col, def) in sync_columns {
            let _ = self.add_column_if_missing(conn, table, col, def)?;
        }

        // 补齐索引 — llm_usage_logs（表已确认存在）
        let logs_index_sqls: &[&str] = &[
            "CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_local_version ON llm_usage_logs(local_version)",
            "CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_deleted_at ON llm_usage_logs(deleted_at)",
            "CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_device_id ON llm_usage_logs(device_id)",
            "CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_updated_at ON llm_usage_logs(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_device_version ON llm_usage_logs(device_id, local_version)",
            "CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_updated_not_deleted ON llm_usage_logs(updated_at) WHERE deleted_at IS NULL",
        ];

        for sql in logs_index_sqls {
            conn.execute(sql, []).map_err(|e| {
                MigrationError::Database(format!("LLM Usage 索引创建失败: {} ({})", sql, e))
            })?;
        }

        // 补齐索引 — llm_usage_daily（需先确认表存在，部分失败场景下可能只有 logs 表）
        if self.table_exists(conn, "llm_usage_daily")? {
            let daily_index_sqls: &[&str] = &[
                "CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_local_version ON llm_usage_daily(local_version)",
                "CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_deleted_at ON llm_usage_daily(deleted_at)",
                "CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_device_id ON llm_usage_daily(device_id)",
                "CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_updated_at ON llm_usage_daily(updated_at)",
                "CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_device_version ON llm_usage_daily(device_id, local_version)",
                "CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_updated_not_deleted ON llm_usage_daily(updated_at) WHERE deleted_at IS NULL",
            ];

            for sql in daily_index_sqls {
                conn.execute(sql, []).map_err(|e| {
                    MigrationError::Database(format!("LLM Usage 索引创建失败: {} ({})", sql, e))
                })?;
            }
        }

        // 标记迁移完成
        self.ensure_refinery_history_table(conn)?;
        self.mark_migration_complete(conn, runner, SYNC_VERSION)?;

        Ok(())
    }

    fn is_migration_recorded(
        &self,
        conn: &rusqlite::Connection,
        version: i32,
    ) -> Result<bool, MigrationError> {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM refinery_schema_history WHERE version = ?1)",
                [version],
                |row| row.get(0),
            )
            .unwrap_or(false);
        Ok(exists)
    }

    /// 手动标记迁移为已完成
    ///
    /// 从 Runner 中获取迁移信息，插入到 refinery_schema_history 表。
    #[cfg(feature = "data_governance")]
    fn mark_migration_complete(
        &self,
        conn: &rusqlite::Connection,
        runner: &refinery::Runner,
        target_version: i32,
    ) -> Result<(), MigrationError> {
        // 从 runner 中找到对应的迁移
        for migration in runner.get_migrations() {
            if migration.version() == target_version {
                let now = chrono::Utc::now().to_rfc3339();
                conn.execute(
                    "INSERT OR IGNORE INTO refinery_schema_history (version, name, applied_on, checksum)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        target_version,
                        migration.name(),
                        now,
                        migration.checksum().to_string(),
                    ],
                )
                .map_err(|e| MigrationError::Database(format!(
                    "标记迁移 V{} 为已完成失败: {}",
                    target_version, e
                )))?;

                tracing::info!(
                    "✅ [PreRepair] 已标记迁移 V{}_{} 为已完成",
                    target_version,
                    migration.name()
                );
                return Ok(());
            }
        }

        tracing::warn!(
            "⚠️ [PreRepair] 未找到版本 {} 的迁移定义，跳过标记",
            target_version
        );
        Ok(())
    }

    /// 清理中间状态的临时表
    ///
    /// 在迁移失败时，可能会遗留 `*_new` 形式的中间表。
    /// 此方法在迁移前检测并清理这些表，确保迁移可以重新执行。
    ///
    /// # 安全说明
    /// - 只清理已知的中间表模式（如 `xxx_new`）
    /// - 只在 `refinery_schema_history` 中没有对应版本记录时才清理
    fn cleanup_intermediate_tables(
        &self,
        conn: &rusqlite::Connection,
        id: &DatabaseId,
    ) -> Result<(), MigrationError> {
        // 定义各数据库可能存在的中间表
        let intermediate_tables: &[&str] = match id {
            DatabaseId::Vfs => &[
                "vfs_index_segments_new",
                "vfs_index_units_new",
                "vfs_blobs_new",
            ],
            DatabaseId::ChatV2 => &["messages_new", "variants_new", "sessions_new"],
            DatabaseId::Mistakes => &["mistakes_new"],
            DatabaseId::LlmUsage => &["llm_usage_new"],
        };

        for table_name in intermediate_tables {
            // 检查中间表是否存在
            let table_exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table_name],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if table_exists {
                tracing::warn!(
                    database = id.as_str(),
                    table = table_name,
                    "检测到中间状态表（可能来自失败的迁移），正在清理..."
                );

                // 删除中间表
                if let Err(e) = conn.execute(&format!("DROP TABLE IF EXISTS {}", table_name), []) {
                    tracing::warn!(
                        database = id.as_str(),
                        table = table_name,
                        error = %e,
                        "清理中间状态表失败，继续迁移流程"
                    );
                } else {
                    tracing::info!(
                        database = id.as_str(),
                        table = table_name,
                        "成功清理中间状态表"
                    );
                }
            }
        }

        Ok(())
    }

    /// 验证迁移结果
    ///
    /// 使用 MigrationVerifier 检查表、列、索引是否正确创建。
    fn verify_migrations(
        &self,
        conn: &rusqlite::Connection,
        id: &DatabaseId,
        migration_set: &MigrationSet,
        current_version: u32,
        applied_count: usize,
        schema_repaired: bool,
    ) -> Result<(), MigrationError> {
        // 验证所有已应用的迁移
        // 注意：current_version 是 Refinery 记录的版本（如 20260130）
        for migration in migration_set.migrations.iter() {
            if migration.refinery_version <= current_version as i32 {
                MigrationVerifier::verify(conn, migration)?;
            }
        }

        // fingerprint rebaseline 仅允许在"本次启动确实（重新）应用了迁移、
        // 且头部迁移声明为 idempotent"时发生——幂等迁移重跑可能合法地收敛 schema。
        // 稳态启动（applied_count == 0）下的指纹漂移意味着外部篡改，必须 fail-close，
        // 否则只要头部迁移恰好是 idempotent，漂移检测就永久失效。
        let allow_rebaseline = schema_repaired
            || (applied_count > 0
                && migration_set
                    .get(current_version as i32)
                    .map(|m| m.idempotent)
                    .unwrap_or(false));
        self.verify_schema_fingerprint(conn, id, migration_set, current_version, allow_rebaseline)?;

        tracing::debug!(
            database = migration_set.database_name,
            version = current_version,
            "Migration verification passed"
        );

        Ok(())
    }

    /// 验证并记录 schema fingerprint。
    ///
    /// 同版本下 fingerprint 不一致说明发生了“记录-事实”漂移，直接 fail-close。
    fn verify_schema_fingerprint(
        &self,
        conn: &rusqlite::Connection,
        id: &DatabaseId,
        migration_set: &MigrationSet,
        schema_version: u32,
        allow_rebaseline: bool,
    ) -> Result<(), MigrationError> {
        if schema_version == 0 {
            return Ok(());
        }

        let latest_supported_version = migration_set.latest_version();
        if i64::from(schema_version) > i64::from(latest_supported_version) {
            tracing::warn!(
                database = id.as_str(),
                history_version = schema_version,
                latest_supported_version,
                "Skipping schema fingerprint because database history is newer than this binary"
            );
            return Ok(());
        }

        self.ensure_schema_fingerprint_table(conn)?;
        let current_fingerprint =
            self.compute_schema_fingerprint(conn, migration_set, schema_version)?;

        let select_sql = format!(
            "SELECT fingerprint, canonical_schema FROM {} WHERE database_id = ?1 AND schema_version = ?2",
            SCHEMA_FINGERPRINT_TABLE
        );
        let existing: Option<(String, Option<String>)> = conn
            .query_row(
                &select_sql,
                rusqlite::params![id.as_str(), schema_version as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        if let Some((stored, stored_canonical_schema)) = existing {
            if stored != current_fingerprint.hash {
                let filtered_legacy_hash = stored_canonical_schema
                    .as_deref()
                    .map(|schema| {
                        Self::hash_canonical_schema(&Self::filter_canonical_schema_to_scope(
                            schema,
                            &current_fingerprint.scope,
                        ))
                    })
                    .transpose()?;

                let known_prior_scope_poisoning =
                    if filtered_legacy_hash.as_deref() == Some(current_fingerprint.hash.as_str()) {
                        false
                    } else {
                        self.is_known_chat_v2_prior_scope_fingerprint(
                            conn,
                            id,
                            migration_set,
                            schema_version,
                            &stored,
                            stored_canonical_schema.as_deref(),
                            &current_fingerprint,
                        )?
                    };

                if filtered_legacy_hash.as_deref() == Some(current_fingerprint.hash.as_str()) {
                    tracing::warn!(
                        database = id.as_str(),
                        version = schema_version,
                        "Schema fingerprint used legacy broad scope, rebaseline to migration-managed scope"
                    );
                } else if known_prior_scope_poisoning {
                    // The recovery helper emitted a structured audit warning after every
                    // schema-delta and sqlite_master comparison completed successfully.
                } else if allow_rebaseline {
                    tracing::warn!(
                        database = id.as_str(),
                        version = schema_version,
                        "Schema fingerprint drift detected, rebaseline enabled"
                    );
                } else {
                    return Err(MigrationError::VerificationFailed {
                        version: schema_version,
                        reason: format!(
                            "Schema fingerprint drift detected at v{} (db: {}). \
                             Use the canonical_schema column in {} to diff the expected vs actual schema.",
                            schema_version,
                            id.as_str(),
                            SCHEMA_FINGERPRINT_TABLE,
                        ),
                    });
                }
            }

            // 更新 verified_at、fingerprint 和 canonical_schema
            let update_sql = format!(
                "UPDATE {} SET verified_at = ?3, fingerprint = ?4, canonical_schema = ?5 WHERE database_id = ?1 AND schema_version = ?2",
                SCHEMA_FINGERPRINT_TABLE
            );
            conn.execute(
                &update_sql,
                rusqlite::params![
                    id.as_str(),
                    schema_version as i64,
                    chrono::Utc::now().to_rfc3339(),
                    current_fingerprint.hash,
                    current_fingerprint.canonical_schema,
                ],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
            return Ok(());
        }

        // Issue #12: 同时存储 fingerprint hash 和可读的 canonical schema
        let insert_sql = format!(
            "INSERT INTO {} (database_id, schema_version, fingerprint, verified_at, canonical_schema) VALUES (?1, ?2, ?3, ?4, ?5)",
            SCHEMA_FINGERPRINT_TABLE
        );
        conn.execute(
            &insert_sql,
            rusqlite::params![
                id.as_str(),
                schema_version as i64,
                current_fingerprint.hash,
                chrono::Utc::now().to_rfc3339(),
                current_fingerprint.canonical_schema,
            ],
        )
        .map_err(|e| MigrationError::Database(e.to_string()))?;

        Ok(())
    }

    fn is_known_chat_v2_prior_scope_fingerprint(
        &self,
        conn: &rusqlite::Connection,
        id: &DatabaseId,
        migration_set: &MigrationSet,
        schema_version: u32,
        stored_hash: &str,
        stored_canonical_schema: Option<&str>,
        current_fingerprint: &SchemaFingerprint,
    ) -> Result<bool, MigrationError> {
        if id != &DatabaseId::ChatV2 || migration_set.database_name != "chat_v2" {
            return Ok(false);
        }

        let Some(spec) = CHAT_V2_KNOWN_PRIOR_SCOPE_RECOVERIES
            .iter()
            .find(|spec| spec.target_version == schema_version)
        else {
            return Ok(false);
        };

        let Some(stored_canonical_schema) = stored_canonical_schema else {
            Self::log_known_prior_scope_recovery_rejection(id, spec, "missing_canonical_schema");
            return Ok(false);
        };
        if Self::hash_canonical_schema(stored_canonical_schema)? != stored_hash {
            Self::log_known_prior_scope_recovery_rejection(id, spec, "stored_hash_mismatch");
            return Ok(false);
        }

        let Some(target_position) = migration_set
            .migrations
            .iter()
            .position(|migration| migration.refinery_version == schema_version as i32)
        else {
            Self::log_known_prior_scope_recovery_rejection(id, spec, "target_migration_not_found");
            return Ok(false);
        };
        let target_migration = &migration_set.migrations[target_position];
        let previous_version = target_position
            .checked_sub(1)
            .and_then(|position| migration_set.migrations.get(position))
            .map(|migration| migration.refinery_version);
        if target_migration.name != spec.migration_name
            || previous_version != Some(spec.previous_version as i32)
        {
            Self::log_known_prior_scope_recovery_rejection(id, spec, "migration_chain_mismatch");
            return Ok(false);
        }

        let previous_scope =
            self.compute_schema_fingerprint_scope(migration_set, spec.previous_version)?;
        if !Self::scope_delta_matches(&previous_scope, &current_fingerprint.scope, spec) {
            Self::log_known_prior_scope_recovery_rejection(
                id,
                spec,
                "managed_scope_delta_mismatch",
            );
            return Ok(false);
        }

        let scratch = Self::build_migration_scratch(migration_set, schema_version)?;
        if spec.validate_current_schema_against_target {
            let expected_current =
                self.compute_schema_fingerprint(&scratch, migration_set, schema_version)?;
            if current_fingerprint.canonical_schema != expected_current.canonical_schema {
                Self::log_known_prior_scope_recovery_rejection(
                    id,
                    spec,
                    "current_schema_does_not_match_target_migrations",
                );
                return Ok(false);
            }
            let mut recorded_scope_matches = false;
            for recorded_scope_version in spec.accepted_recorded_scope_versions {
                let recorded_scratch =
                    Self::build_migration_scratch(migration_set, *recorded_scope_version)?;
                let expected_recorded = self.compute_schema_fingerprint(
                    &recorded_scratch,
                    migration_set,
                    *recorded_scope_version,
                )?;
                if expected_recorded.canonical_schema == stored_canonical_schema {
                    recorded_scope_matches = true;
                    break;
                }
            }
            let known_historical_fingerprint = spec
                .accepted_recorded_fingerprints
                .iter()
                .any(|fingerprint| *fingerprint == stored_hash);
            if !recorded_scope_matches && !known_historical_fingerprint {
                Self::log_known_prior_scope_recovery_rejection(
                    id,
                    spec,
                    "recorded_scope_canonical_mismatch",
                );
                return Ok(false);
            }
        } else {
            let current_in_previous_scope = Self::filter_canonical_schema_to_scope(
                &current_fingerprint.canonical_schema,
                &previous_scope,
            );
            if current_in_previous_scope != stored_canonical_schema {
                Self::log_known_prior_scope_recovery_rejection(
                    id,
                    spec,
                    "previous_scope_canonical_mismatch",
                );
                return Ok(false);
            }
        }

        for (object_type, names) in [
            ("table", spec.added_tables),
            ("index", spec.added_indexes),
            ("trigger", spec.added_triggers),
        ] {
            for name in names {
                let actual = Self::schema_object_definition(conn, object_type, name)?;
                let expected = Self::schema_object_definition(&scratch, object_type, name)?;
                if actual.is_none() || actual != expected {
                    Self::log_known_prior_scope_recovery_rejection(
                        id,
                        spec,
                        "added_object_definition_mismatch",
                    );
                    return Ok(false);
                }
            }
        }

        tracing::warn!(
            database = id.as_str(),
            target_version = spec.target_version,
            previous_version = spec.previous_version,
            migration = spec.migration_name,
            stored_fingerprint = %stored_hash,
            actual_fingerprint = %current_fingerprint.hash,
            "Validated and recovering known chat_v2 prior-scope schema fingerprint"
        );

        Ok(true)
    }

    fn log_known_prior_scope_recovery_rejection(
        id: &DatabaseId,
        spec: &KnownPriorScopeRecoverySpec,
        reason: &str,
    ) {
        tracing::warn!(
            database = id.as_str(),
            target_version = spec.target_version,
            previous_version = spec.previous_version,
            migration = spec.migration_name,
            reason,
            "Rejected known chat_v2 prior-scope fingerprint recovery"
        );
    }

    fn scope_delta_matches(
        previous: &SchemaFingerprintScope,
        current: &SchemaFingerprintScope,
        spec: &KnownPriorScopeRecoverySpec,
    ) -> bool {
        fn matches(
            previous: &BTreeSet<String>,
            current: &BTreeSet<String>,
            expected_added: &[&str],
        ) -> bool {
            let expected_added = expected_added
                .iter()
                .map(|name| (*name).to_owned())
                .collect::<BTreeSet<_>>();
            previous.is_subset(current) && current.difference(previous).eq(expected_added.iter())
        }

        matches(&previous.tables, &current.tables, spec.added_tables)
            && matches(&previous.indexes, &current.indexes, spec.added_indexes)
            && matches(&previous.triggers, &current.triggers, spec.added_triggers)
    }

    fn schema_object_definition(
        conn: &rusqlite::Connection,
        object_type: &str,
        name: &str,
    ) -> Result<Option<(String, String, String, String)>, MigrationError> {
        conn.query_row(
            "SELECT type, name, tbl_name, IFNULL(sql, '')
             FROM sqlite_master WHERE type = ?1 AND name = ?2",
            [object_type, name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| MigrationError::Database(error.to_string()))
    }

    fn build_migration_scratch(
        migration_set: &MigrationSet,
        schema_version: u32,
    ) -> Result<rusqlite::Connection, MigrationError> {
        let scratch = rusqlite::Connection::open_in_memory()
            .map_err(|error| MigrationError::Database(error.to_string()))?;
        for migration in migration_set.migrations.iter() {
            if migration.refinery_version <= schema_version as i32 {
                scratch
                    .execute_batch(migration.sql)
                    .map_err(|error| MigrationError::Database(error.to_string()))?;
            }
        }
        Ok(scratch)
    }

    fn ensure_schema_fingerprint_table(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<(), MigrationError> {
        let create_sql = format!(
            r#"CREATE TABLE IF NOT EXISTS {} (
                database_id TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                fingerprint TEXT NOT NULL,
                verified_at TEXT NOT NULL,
                PRIMARY KEY (database_id, schema_version)
            )"#,
            SCHEMA_FINGERPRINT_TABLE
        );
        conn.execute(&create_sql, [])
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        // Issue #12: 添加 canonical_schema 列存储结构化 schema 文本（可读，便于调试漂移）
        // 使用 ALTER TABLE ... ADD COLUMN，对已有表安全
        let alter_sql = format!(
            "ALTER TABLE {} ADD COLUMN canonical_schema TEXT",
            SCHEMA_FINGERPRINT_TABLE
        );
        // 列已存在时 SQLite 返回 "duplicate column" 错误，忽略即可
        // 但其他错误（磁盘满、权限不足等）应记录警告
        if let Err(e) = conn.execute(&alter_sql, []) {
            let err_msg = e.to_string();
            if !err_msg.contains("duplicate column") {
                tracing::warn!(
                    error = %e,
                    "Failed to add canonical_schema column to {} (non-duplicate error)",
                    SCHEMA_FINGERPRINT_TABLE
                );
            }
        }

        Ok(())
    }

    /// 计算 schema fingerprint
    ///
    /// 返回 `(fingerprint_hash, canonical_schema_text)` 元组。
    /// - `fingerprint_hash`: SHA256 hash（用于快速比较）
    /// - `canonical_schema_text`: 结构化 schema 文本（用于调试漂移原因）
    ///
    /// ## Issue #12 改进
    ///
    /// 之前仅返回 hash，无法确定漂移发生在哪个表/列。
    /// 现在同时保留 canonical 文本，漂移发生时可通过 diff 快速定位。
    fn compute_schema_fingerprint(
        &self,
        conn: &rusqlite::Connection,
        migration_set: &MigrationSet,
        schema_version: u32,
    ) -> Result<SchemaFingerprint, MigrationError> {
        let mut canonical = String::new();
        let scope = self.compute_schema_fingerprint_scope(migration_set, schema_version)?;

        for table in &scope.tables {
            canonical.push_str("table:");
            canonical.push_str(table);
            canonical.push('\n');

            if !self.table_exists(conn, table)? {
                canonical.push_str("missing_table:");
                canonical.push_str(table);
                canonical.push('\n');
                continue;
            }

            let escaped_table = table.replace('\'', "''");
            let pragma_sql = format!("PRAGMA table_info('{}')", escaped_table);
            let mut columns_stmt = conn
                .prepare(&pragma_sql)
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            let columns = columns_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i32>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        row.get::<_, i32>(3)?,
                        row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        row.get::<_, i32>(5)?,
                    ))
                })
                .map_err(|e| MigrationError::Database(e.to_string()))?;

            for column in columns {
                let (cid, name, ty, not_null, default_val, pk) =
                    column.map_err(|e| MigrationError::Database(e.to_string()))?;
                canonical.push_str(&format!(
                    "col:{}:{}:{}:{}:{}:{}\n",
                    cid, name, ty, not_null, default_val, pk
                ));
            }

            let mut indexes_stmt = conn
                .prepare(
                    "SELECT name, IFNULL(sql, '') FROM sqlite_master                     WHERE type='index' AND tbl_name = ?1 AND name NOT LIKE 'sqlite_autoindex%'                     ORDER BY name",
                )
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            let indexes = indexes_stmt
                .query_map([table.as_str()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| MigrationError::Database(e.to_string()))?;

            for index in indexes {
                let (name, sql) = index.map_err(|e| MigrationError::Database(e.to_string()))?;
                if !scope.indexes.contains(&name) {
                    continue;
                }
                canonical.push_str(&format!("idx:{}:{}\n", name, sql));
            }

            let mut triggers_stmt = conn
                .prepare(
                    "SELECT name, IFNULL(sql, '') FROM sqlite_master                     WHERE type='trigger' AND tbl_name = ?1                     ORDER BY name",
                )
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            let triggers = triggers_stmt
                .query_map([table.as_str()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| MigrationError::Database(e.to_string()))?;

            for trigger in triggers {
                let (name, sql) = trigger.map_err(|e| MigrationError::Database(e.to_string()))?;
                if !scope.triggers.contains(&name) {
                    continue;
                }
                canonical.push_str(&format!("trg:{}:{}\n", name, sql));
            }
        }

        for index in &scope.indexes {
            let exists = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
                    [index.as_str()],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            if !exists {
                canonical.push_str("missing_idx:");
                canonical.push_str(index);
                canonical.push('\n');
            }
        }

        for trigger in &scope.triggers {
            let exists = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)",
                    [trigger.as_str()],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            if !exists {
                canonical.push_str("missing_trg:");
                canonical.push_str(trigger);
                canonical.push('\n');
            }
        }

        let fingerprint = Self::hash_canonical_schema(&canonical)?;

        Ok(SchemaFingerprint {
            hash: fingerprint,
            canonical_schema: canonical,
            scope,
        })
    }

    fn hash_canonical_schema(canonical: &str) -> Result<String, MigrationError> {
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        Ok(format!("{:x}", hasher.finalize()))
    }

    fn filter_canonical_schema_to_scope(canonical: &str, scope: &SchemaFingerprintScope) -> String {
        let mut filtered = String::new();
        let mut include_current_table = false;
        let mut include_continuation = false;

        for line in canonical.lines() {
            if let Some(table_name) = line.strip_prefix("table:") {
                include_continuation = false;
                include_current_table = scope.tables.contains(table_name);
                if include_current_table {
                    filtered.push_str(line);
                    filtered.push('\n');
                }
                continue;
            }

            if line.starts_with("col:") {
                include_continuation = false;
                if include_current_table {
                    filtered.push_str(line);
                    filtered.push('\n');
                }
                continue;
            }

            if let Some(rest) = line.strip_prefix("idx:") {
                include_continuation = false;
                let index_name = rest.split(':').next().unwrap_or_default();
                if include_current_table && scope.indexes.contains(index_name) {
                    filtered.push_str(line);
                    filtered.push('\n');
                    include_continuation = true;
                }
                continue;
            }

            if let Some(rest) = line.strip_prefix("trg:") {
                include_continuation = false;
                let trigger_name = rest.split(':').next().unwrap_or_default();
                if include_current_table && scope.triggers.contains(trigger_name) {
                    filtered.push_str(line);
                    filtered.push('\n');
                    include_continuation = true;
                }
                continue;
            }

            if include_continuation {
                filtered.push_str(line);
                filtered.push('\n');
            }
        }

        filtered
    }

    fn compute_schema_fingerprint_scope(
        &self,
        migration_set: &MigrationSet,
        schema_version: u32,
    ) -> Result<SchemaFingerprintScope, MigrationError> {
        let scratch = rusqlite::Connection::open_in_memory()
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        for migration in migration_set.migrations.iter() {
            if migration.refinery_version > schema_version as i32 {
                continue;
            }
            scratch
                .execute_batch(migration.sql)
                .map_err(|e| MigrationError::Database(e.to_string()))?;
        }

        let mut scope = SchemaFingerprintScope::default();

        {
            let mut stmt = scratch
                .prepare(
                    r#"SELECT name FROM sqlite_master
                       WHERE type='table'
                         AND name NOT LIKE 'sqlite_%'
                         AND name != 'refinery_schema_history'
                         AND name != ?1
                       ORDER BY name"#,
                )
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            let rows = stmt
                .query_map([SCHEMA_FINGERPRINT_TABLE], |row| row.get::<_, String>(0))
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            for row in rows {
                scope
                    .tables
                    .insert(row.map_err(|e| MigrationError::Database(e.to_string()))?);
            }
        }

        {
            let mut stmt = scratch
                .prepare(
                    "SELECT name FROM sqlite_master                      WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'                      ORDER BY name",
                )
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            for row in rows {
                scope
                    .indexes
                    .insert(row.map_err(|e| MigrationError::Database(e.to_string()))?);
            }
        }

        {
            let mut stmt = scratch
                .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| MigrationError::Database(e.to_string()))?;
            for row in rows {
                scope
                    .triggers
                    .insert(row.map_err(|e| MigrationError::Database(e.to_string()))?);
            }
        }

        Ok(scope)
    }

    /// 记录迁移审计日志
    fn log_migration_audit(
        &self,
        id: &DatabaseId,
        from_version: u32,
        to_version: u32,
        applied_count: usize,
        duration_ms: u64,
    ) -> Result<(), MigrationError> {
        use crate::data_governance::audit::AuditRepository;

        // 如果没有配置审计数据库，仅记录日志
        let Some(audit_db_path) = &self.audit_db_path else {
            tracing::debug!(
                database = id.as_str(),
                from_version = from_version,
                to_version = to_version,
                applied_count = applied_count,
                "Migration audit (no audit db configured)"
            );
            return Ok(());
        };

        // 尝试打开审计数据库并写入日志
        match rusqlite::Connection::open(audit_db_path) {
            Ok(conn) => {
                // 确保审计表存在
                if let Err(e) = AuditRepository::init(&conn) {
                    tracing::warn!(
                        error = %e,
                        "Failed to init audit table, skipping audit log"
                    );
                    return Ok(()); // 不影响迁移
                }

                // 写入审计日志
                match AuditRepository::log_migration_complete(
                    &conn,
                    id.as_str(),
                    from_version,
                    to_version,
                    applied_count,
                    duration_ms,
                ) {
                    Ok(audit_id) => {
                        tracing::info!(
                            database = id.as_str(),
                            from_version = from_version,
                            to_version = to_version,
                            applied_count = applied_count,
                            audit_id = %audit_id,
                            "Migration audit log saved to database"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            database = id.as_str(),
                            "Failed to save migration audit log"
                        );
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    path = %audit_db_path.display(),
                    "Failed to open audit database for logging"
                );
            }
        }

        Ok(())
    }

    /// 记录迁移失败审计日志
    fn log_migration_failure(
        &self,
        id: &DatabaseId,
        from_version: u32,
        error_message: &str,
        duration_ms: u64,
    ) {
        use crate::data_governance::audit::{AuditLog, AuditOperation, AuditRepository};

        let Some(audit_db_path) = &self.audit_db_path else {
            tracing::warn!(
                database = id.as_str(),
                error = error_message,
                "Migration failed (no audit db configured)"
            );
            return;
        };

        let mut log = AuditLog::new(
            AuditOperation::Migration {
                from_version,
                to_version: from_version,
                applied_count: 0,
            },
            id.as_str(),
        )
        .fail(error_message.to_string())
        .with_details(serde_json::json!({
            "database": id.as_str(),
            "from_version": from_version,
            "error": error_message,
        }));
        log.duration_ms = Some(duration_ms);

        match rusqlite::Connection::open(audit_db_path) {
            Ok(conn) => {
                if let Err(e) = AuditRepository::init(&conn) {
                    tracing::warn!(
                        error = %e,
                        "Failed to init audit table for migration failure"
                    );
                    return;
                }
                if let Err(e) = AuditRepository::save(&conn, &log) {
                    tracing::warn!(
                        error = %e,
                        database = id.as_str(),
                        "Failed to save migration failure audit log"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    path = %audit_db_path.display(),
                    "Failed to open audit database for migration failure logging"
                );
            }
        }
    }

    /// 磁盘空间预检查
    ///
    /// 迁移过程中可能需要创建临时表（CREATE-COPY-SWAP 模式），
    /// 磁盘空间不足会导致迁移中途失败并可能损坏数据库。
    /// 此方法在迁移前检查可用空间，不足时提前 fail-fast 并给出可操作提示。
    ///
    /// ## 检查策略
    ///
    /// - 计算所有数据库文件总大小
    /// - 要求可用空间至少为数据库总大小的 2 倍 + 50MB 余量
    ///   （CREATE-COPY-SWAP 需要一份完整拷贝）
    fn preflight_disk_space_check(&self) -> Result<(), MigrationError> {
        use std::fs;

        // 计算所有数据库文件总大小
        let mut total_db_size: u64 = 0;
        for db_id in DatabaseId::all_ordered() {
            let db_path = self.get_database_path(&db_id);
            if db_path.exists() {
                if let Ok(metadata) = fs::metadata(&db_path) {
                    total_db_size += metadata.len();
                }
                // 也计算 WAL 文件大小
                let wal_path = db_path.with_extension("db-wal");
                if wal_path.exists() {
                    if let Ok(metadata) = fs::metadata(&wal_path) {
                        total_db_size += metadata.len();
                    }
                }
            }
        }

        // 需要的最小空间 = 数据库总大小 * 2 + 50MB 余量
        let min_margin_bytes: u64 = 50 * 1024 * 1024; // 50MB
        let required_bytes = total_db_size
            .saturating_mul(2)
            .saturating_add(min_margin_bytes);

        // 获取磁盘可用空间（使用已有的跨平台实现）
        let available =
            crate::backup_common::get_available_disk_space(&self.app_data_dir).unwrap_or(u64::MAX);

        let required_mb = required_bytes / (1024 * 1024);
        let available_mb = available / (1024 * 1024);

        if available < required_bytes {
            tracing::error!(
                available_mb = available_mb,
                required_mb = required_mb,
                total_db_size_mb = total_db_size / (1024 * 1024),
                "磁盘空间不足，无法安全执行迁移"
            );
            return Err(MigrationError::InsufficientDiskSpace {
                available_mb,
                required_mb,
            });
        }

        tracing::debug!(
            available_mb = available_mb,
            required_mb = required_mb,
            "磁盘空间预检查通过"
        );

        Ok(())
    }

    /// 获取应用数据目录
    pub fn app_data_dir(&self) -> &PathBuf {
        &self.app_data_dir
    }

    /// 聚合当前 Schema 状态
    ///
    /// 从所有数据库读取当前版本信息，生成统一的 SchemaRegistry。
    /// 支持多种迁移系统：Refinery、ChatV2、LLM Usage 等。
    pub fn aggregate_schema_registry(&self) -> Result<SchemaRegistry, MigrationError> {
        self.aggregate_schema_registry_internal(None)
    }

    /// Aggregate healthy components while isolating per-database read failures.
    pub fn aggregate_schema_registry_with_health(
        &self,
        component_health: &mut StartupComponentHealth,
    ) -> Result<SchemaRegistry, MigrationError> {
        self.aggregate_schema_registry_internal(Some(component_health))
    }

    fn aggregate_schema_registry_internal(
        &self,
        mut component_health: Option<&mut StartupComponentHealth>,
    ) -> Result<SchemaRegistry, MigrationError> {
        use crate::data_governance::schema_registry::{get_data_contract_version, DatabaseStatus};

        tracing::info!("📊 [SchemaAggregation] 开始聚合数据库 Schema 状态...");
        let mut registry = SchemaRegistry::new();

        for db_id in DatabaseId::all_ordered() {
            if component_health
                .as_ref()
                .is_some_and(|health| health.is_blocked(db_id.as_str()))
            {
                tracing::warn!(
                    database = db_id.as_str(),
                    "⏭️ [SchemaAggregation] 跳过已阻断数据库"
                );
                continue;
            }
            let db_path = self.get_database_path(&db_id);

            // 如果数据库文件不存在，记录并跳过
            if !db_path.exists() {
                tracing::debug!(
                    "  ⏭️ [SchemaAggregation] {}: 文件不存在 ({})",
                    db_id.as_str(),
                    db_path.display()
                );
                continue;
            }

            let conn = match rusqlite::Connection::open(&db_path) {
                Ok(conn) => conn,
                Err(error) => {
                    let error = MigrationError::Database(format!("{}: {}", db_id.as_str(), error));
                    if let Some(health) = component_health.as_deref_mut() {
                        health.mark_blocked(
                            db_id.as_str(),
                            format!("Schema aggregation failed: {}", error),
                        );
                        health.apply_database_dependency_closure();
                        continue;
                    }
                    return Err(error);
                }
            };

            let version = match self.get_current_version(&conn) {
                Ok(version) => version,
                Err(error) => {
                    if let Some(health) = component_health.as_deref_mut() {
                        health.mark_blocked(
                            db_id.as_str(),
                            format!("Schema version read failed: {}", error),
                        );
                        health.apply_database_dependency_closure();
                        continue;
                    }
                    return Err(error);
                }
            };
            let migration_set = self.get_migration_set(&db_id);

            // 读取迁移历史（包含 Refinery 记录的 checksum）
            let history = match self.read_migration_history(&conn) {
                Ok(history) => history,
                Err(error) => {
                    if let Some(health) = component_health.as_deref_mut() {
                        health.mark_blocked(
                            db_id.as_str(),
                            format!("Migration history read failed: {}", error),
                        );
                        health.apply_database_dependency_closure();
                        continue;
                    }
                    return Err(error);
                }
            };

            // 使用 Refinery 记录的最新 checksum（权威来源）
            let checksum = history
                .iter()
                .filter(|r| r.version == version)
                .map(|r| r.checksum.clone())
                .next()
                .unwrap_or_default();

            tracing::info!(
                "  ✅ [SchemaAggregation] {}: v{} (路径: {})",
                db_id.as_str(),
                version,
                db_path.display()
            );

            let status = DatabaseStatus {
                id: db_id.clone(),
                schema_version: version,
                min_compatible_version: 1,
                max_compatible_version: migration_set.latest_version() as u32,
                data_contract_version: get_data_contract_version(version),
                migration_history: history,
                checksum,
                updated_at: chrono::Utc::now().to_rfc3339(),
            };

            registry.databases.insert(db_id, status);
        }

        registry.global_version = registry.calculate_global_version();
        registry.aggregated_at = chrono::Utc::now().to_rfc3339();

        tracing::info!(
            "📊 [SchemaAggregation] 聚合完成: 全局版本={}, 数据库数量={}",
            registry.global_version,
            registry.databases.len()
        );

        Ok(registry)
    }

    /// 读取数据库的迁移历史
    fn read_migration_history(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<Vec<crate::data_governance::schema_registry::MigrationRecord>, MigrationError> {
        use crate::data_governance::schema_registry::MigrationRecord;

        // 检查 Refinery 的 schema history 表是否存在
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        if !table_exists {
            return Ok(Vec::new());
        }

        // 读取迁移历史
        let mut stmt = conn
            .prepare(
                "SELECT version, name, checksum, applied_on FROM refinery_schema_history ORDER BY version",
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        let records = stmt
            .query_map([], |row| {
                Ok(MigrationRecord {
                    version: row.get::<_, i32>(0)? as u32,
                    name: row.get(1)?,
                    checksum: row.get(2)?,
                    applied_at: row.get(3)?,
                    duration_ms: None, // Refinery 不记录耗时
                    success: true,
                })
            })
            .map_err(|e| MigrationError::Database(e.to_string()))?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(records)
    }

    /// 执行单个数据库的迁移（公开方法）
    ///
    /// 用于单独迁移某个数据库，不检查依赖关系。
    pub fn migrate_single(
        &mut self,
        id: DatabaseId,
    ) -> Result<DatabaseMigrationReport, MigrationError> {
        self.migrate_database(id)
    }

    /// 检查数据库是否需要迁移
    pub fn needs_migration(&self, id: &DatabaseId) -> Result<bool, MigrationError> {
        let db_path = self.get_database_path(id);

        // 如果数据库不存在，需要迁移
        if !db_path.exists() {
            return Ok(true);
        }

        let conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        let current_version = self.get_current_version(&conn)? as i32;
        let migration_set = self.get_migration_set(id);
        let latest_version = migration_set.latest_version();

        Ok(current_version < latest_version)
    }

    /// 获取所有待执行的迁移数量
    pub fn pending_migrations_count(&self) -> Result<usize, MigrationError> {
        let mut total = 0;

        for db_id in DatabaseId::all_ordered() {
            let db_path = self.get_database_path(&db_id);

            let current_version = if db_path.exists() {
                let conn = rusqlite::Connection::open(&db_path)
                    .map_err(|e| MigrationError::Database(e.to_string()))?;
                self.get_current_version(&conn)? as i32
            } else {
                0
            };

            let migration_set = self.get_migration_set(&db_id);
            total += migration_set.pending(current_version).count();
        }

        Ok(total)
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_governance::migration::{
        chat_v2::CHAT_V2_MIGRATIONS, CHAT_V2_MIGRATION_SET, LLM_USAGE_MIGRATION_SET,
        VFS_MIGRATION_SET,
    };
    use tempfile::TempDir;

    fn create_test_coordinator() -> (MigrationCoordinator, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None); // 测试时不需要审计日志
        (coordinator, temp_dir)
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn sql_splitter_keeps_case_end_inside_trigger_body() {
        let sql = r#"
            ALTER TABLE sample ADD COLUMN extra TEXT;
            CREATE TRIGGER sample_ai AFTER INSERT ON sample
            BEGIN
                INSERT INTO audit(value)
                VALUES (CASE WHEN NEW.extra IS NULL THEN 'none' ELSE NEW.extra END);
                UPDATE counters SET value = value + 1;
            END;
            CREATE INDEX sample_extra ON sample(extra);
        "#;
        let statements = MigrationCoordinator::split_sql_statements(sql);
        assert_eq!(statements.len(), 3, "{statements:#?}");
        assert!(statements[1].contains("CASE WHEN"));
        assert!(statements[1].contains("UPDATE counters"));
        assert!(statements[1].trim_end().ends_with("END"));
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn sql_splitter_delegates_quotes_comments_and_transactions_to_sqlite() {
        let sql = r#"
            /* a block comment containing ; and CASE END */
            CREATE TABLE [odd;table] (`semi;column` TEXT, "double;column" TEXT);
            INSERT INTO [odd;table] VALUES ('value;still-string', 'x');
            BEGIN TRANSACTION;
            UPDATE [odd;table] SET `semi;column` = 'inside;transaction';
            COMMIT;
        "#;
        let statements = MigrationCoordinator::split_sql_statements(sql);
        assert_eq!(statements.len(), 5, "{statements:#?}");
        assert!(statements[0].contains("[odd;table]"));
        assert!(statements[1].contains("value;still-string"));
        assert_eq!(statements[2], "BEGIN TRANSACTION");
        assert_eq!(statements[4], "COMMIT");
    }

    fn create_test_sqlite_db(path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO test_data (value) VALUES ('ok')", [])
            .unwrap();
    }

    fn mark_latest_version(path: &std::path::Path, version: u32) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?1, 'latest', '2026-02-11T00:00:00Z', 'x')",
            [version],
        )
        .unwrap();
    }

    fn mark_mistakes_version(conn: &rusqlite::Connection, version: i32, name: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (?1, ?2, '2026-06-30T00:00:00Z', '0')",
            rusqlite::params![version, name],
        )
        .unwrap();
    }

    fn apply_chat_v2_migrations(conn: &rusqlite::Connection) {
        for migration in CHAT_V2_MIGRATIONS {
            conn.execute_batch(migration.sql).unwrap();
        }
    }

    fn chat_v2_migration_set_through(version: i32) -> MigrationSet {
        let migrations = CHAT_V2_MIGRATIONS
            .iter()
            .filter(|migration| migration.refinery_version <= version)
            .cloned()
            .collect::<Vec<_>>()
            .into_boxed_slice();
        MigrationSet {
            database_name: "chat_v2",
            migrations: Box::leak(migrations),
        }
    }

    fn seed_chat_v2_prior_scope_fingerprint(
        coordinator: &MigrationCoordinator,
        conn: &rusqlite::Connection,
    ) -> SchemaFingerprint {
        seed_chat_v2_prior_scope_fingerprint_for(
            coordinator,
            conn,
            CHAT_V2_SESSION_TAGS_SYNC_VERSION,
            CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION,
        )
    }

    fn seed_chat_v2_prior_scope_fingerprint_for(
        coordinator: &MigrationCoordinator,
        conn: &rusqlite::Connection,
        target_version: u32,
        previous_version: u32,
    ) -> SchemaFingerprint {
        coordinator.ensure_schema_fingerprint_table(conn).unwrap();
        let prior = coordinator
            .compute_schema_fingerprint(conn, &CHAT_V2_MIGRATION_SET, previous_version)
            .unwrap();
        conn.execute(
            "INSERT INTO __governance_schema_fingerprints
             (database_id, schema_version, fingerprint, verified_at, canonical_schema)
             VALUES ('chat_v2', ?1, ?2, 'poisoned-baseline', ?3)",
            rusqlite::params![target_version, prior.hash, prior.canonical_schema],
        )
        .unwrap();
        prior
    }

    fn seed_chat_v2_historical_scope_fingerprint(
        coordinator: &MigrationCoordinator,
        conn: &rusqlite::Connection,
        target_version: u32,
        recorded_scope_version: u32,
    ) -> SchemaFingerprint {
        coordinator.ensure_schema_fingerprint_table(conn).unwrap();
        let historical_scratch = MigrationCoordinator::build_migration_scratch(
            &CHAT_V2_MIGRATION_SET,
            recorded_scope_version,
        )
        .unwrap();
        let prior = coordinator
            .compute_schema_fingerprint(
                &historical_scratch,
                &CHAT_V2_MIGRATION_SET,
                recorded_scope_version,
            )
            .unwrap();
        conn.execute(
            "INSERT INTO __governance_schema_fingerprints
             (database_id, schema_version, fingerprint, verified_at, canonical_schema)
             VALUES ('chat_v2', ?1, ?2, 'poisoned-historical-baseline', ?3)",
            rusqlite::params![target_version, prior.hash, prior.canonical_schema],
        )
        .unwrap();
        prior
    }

    #[test]
    fn test_new_coordinator() {
        let (coordinator, temp_dir) = create_test_coordinator();
        assert_eq!(coordinator.app_data_dir(), temp_dir.path());
    }

    #[test]
    fn test_database_paths() {
        let (coordinator, temp_dir) = create_test_coordinator();

        // VFS 数据库在 databases 子目录
        assert_eq!(
            coordinator.get_database_path(&DatabaseId::Vfs),
            temp_dir.path().join("databases").join("vfs.db")
        );

        // ChatV2, Mistakes, LlmUsage 数据库在根目录
        assert_eq!(
            coordinator.get_database_path(&DatabaseId::ChatV2),
            temp_dir.path().join("chat_v2.db")
        );

        assert_eq!(
            coordinator.get_database_path(&DatabaseId::Mistakes),
            temp_dir.path().join("mistakes.db")
        );

        assert_eq!(
            coordinator.get_database_path(&DatabaseId::LlmUsage),
            temp_dir.path().join("llm_usage.db")
        );
    }

    #[test]
    fn test_migration_report() {
        let mut report = MigrationReport::new();
        assert!(report.success);
        assert!(report.databases.is_empty());

        report.add(DatabaseMigrationReport {
            id: DatabaseId::Vfs,
            from_version: 0,
            to_version: 1,
            applied_count: 1,
            success: true,
            duration_ms: 100,
            error: None,
        });

        assert!(report.success);
        assert_eq!(report.databases.len(), 1);

        report.add(DatabaseMigrationReport {
            id: DatabaseId::ChatV2,
            from_version: 0,
            to_version: 0,
            applied_count: 0,
            success: false,
            duration_ms: 50,
            error: Some("Test error".to_string()),
        });

        assert!(!report.success);
        assert_eq!(report.databases.len(), 2);
    }

    #[test]
    fn test_needs_migration_nonexistent_db() {
        let (coordinator, _temp_dir) = create_test_coordinator();

        // 不存在的数据库应该需要迁移
        assert!(coordinator.needs_migration(&DatabaseId::Vfs).unwrap());
        assert!(coordinator.needs_migration(&DatabaseId::ChatV2).unwrap());
        assert!(coordinator.needs_migration(&DatabaseId::Mistakes).unwrap());
        assert!(coordinator.needs_migration(&DatabaseId::LlmUsage).unwrap());
    }

    #[test]
    fn test_pending_migrations_count_empty() {
        let (coordinator, _temp_dir) = create_test_coordinator();

        // 所有数据库都不存在时，待执行迁移数量应等于全部迁移条目数
        let expected: usize = crate::data_governance::migration::ALL_MIGRATION_SETS
            .iter()
            .map(|set| set.count())
            .sum();
        let count = coordinator.pending_migrations_count().unwrap();
        assert_eq!(count, expected);
    }

    #[test]
    fn test_get_current_version_no_table() {
        let (coordinator, temp_dir) = create_test_coordinator();

        // 创建一个空数据库
        let db_path = temp_dir.path().join("test.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        // 没有 refinery_schema_history 表时应该返回 0
        let version = coordinator.get_current_version(&conn).unwrap();
        assert_eq!(version, 0);
    }

    #[test]
    fn test_check_dependencies_success() {
        let (coordinator, _temp_dir) = create_test_coordinator();
        let mut report = MigrationReport::new();

        // VFS 没有依赖，应该成功
        assert!(coordinator
            .check_dependencies(&DatabaseId::Vfs, &report)
            .is_ok());

        // 添加 VFS 成功报告
        report.add(DatabaseMigrationReport {
            id: DatabaseId::Vfs,
            from_version: 0,
            to_version: 1,
            applied_count: 1,
            success: true,
            duration_ms: 100,
            error: None,
        });

        // ChatV2 依赖 VFS，现在应该成功
        assert!(coordinator
            .check_dependencies(&DatabaseId::ChatV2, &report)
            .is_ok());
    }

    #[test]
    fn test_legacy_baseline_skips_when_init_contract_missing() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute(
            "CREATE TABLE migration_progress (category TEXT PRIMARY KEY, status TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
            [],
        )
        .unwrap();

        coordinator
            .ensure_legacy_baseline(&conn, &DatabaseId::Mistakes)
            .unwrap();

        let recorded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM refinery_schema_history WHERE version = 20260130",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recorded, 0, "invalid legacy schema must not be baselined");
    }

    #[test]
    fn test_legacy_baseline_writes_record_when_init_contract_satisfied() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260130__init.sql"
        ))
        .unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS migration_progress (category TEXT PRIMARY KEY, status TEXT NOT NULL)",
            [],
        )
        .unwrap();

        coordinator
            .ensure_legacy_baseline(&conn, &DatabaseId::Mistakes)
            .unwrap();

        let recorded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM refinery_schema_history WHERE version = 20260130",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            recorded, 1,
            "valid legacy schema should be baselined exactly once"
        );
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn test_apply_mistakes_init_compat_repairs_legacy_schema() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(
            "
            CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, question_images TEXT NOT NULL);
            CREATE TABLE document_tasks (id TEXT PRIMARY KEY);
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT '',
                source_id TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, mistake_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, stable_id TEXT);
            CREATE TABLE review_chat_messages (id INTEGER PRIMARY KEY, review_analysis_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL);
            ",
        )
        .unwrap();

        coordinator.apply_mistakes_init_compat(&conn).unwrap();

        let has_text: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('anki_cards') WHERE name='text')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_text, "anki_cards.text should be repaired");

        let has_review_sessions: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_sessions')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_review_sessions,
            "missing review_sessions table should be created"
        );
    }

    #[test]
    fn test_verify_migrations_persists_schema_fingerprint() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260130__init.sql"
        ))
        .unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260130, 'init', '2026-02-07T00:00:00Z', '0')",
            [],
        )
        .unwrap();

        coordinator
            .verify_migrations(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260130,
                1,
                false,
            )
            .unwrap();

        let check_sql = format!(
            "SELECT COUNT(*) FROM {} WHERE database_id = ?1 AND schema_version = ?2",
            SCHEMA_FINGERPRINT_TABLE
        );
        let count: i64 = conn
            .query_row(
                &check_sql,
                rusqlite::params!["mistakes", 20260130_i64],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 1,
            "fingerprint should be recorded for the verified version"
        );
    }

    #[test]
    fn test_verify_migrations_detects_schema_fingerprint_drift() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260130__init.sql"
        ))
        .unwrap();

        // 首次记录 fingerprint（allow_rebaseline=false）
        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260130,
                false,
            )
            .unwrap();

        // 制造 schema 漂移
        conn.execute("ALTER TABLE anki_cards ADD COLUMN drift_marker INTEGER", [])
            .unwrap();

        // allow_rebaseline=false 时应检测到漂移并报错
        let err = coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260130,
                false,
            )
            .unwrap_err();

        match err {
            MigrationError::VerificationFailed { reason, .. } => {
                assert!(reason.contains("Schema fingerprint drift detected"));
            }
            other => panic!("unexpected error: {:?}", other),
        }

        // allow_rebaseline=true 时漂移应被容忍（不报错）
        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260130,
                true,
            )
            .unwrap();
    }

    #[test]
    fn test_newer_history_does_not_create_or_update_fingerprint() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        let older_set = chat_v2_migration_set_through(CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION as i32);

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &older_set,
                CHAT_V2_SESSION_TAGS_SYNC_VERSION,
                false,
            )
            .unwrap();
        let fingerprint_table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [SCHEMA_FINGERPRINT_TABLE],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!fingerprint_table_exists);

        coordinator.ensure_schema_fingerprint_table(&conn).unwrap();
        let sentinel_schema = "table:sentinel\n";
        let sentinel_hash = MigrationCoordinator::hash_canonical_schema(sentinel_schema).unwrap();
        conn.execute(
            "INSERT INTO __governance_schema_fingerprints
             (database_id, schema_version, fingerprint, verified_at, canonical_schema)
             VALUES ('chat_v2', ?1, ?2, 'sentinel-time', ?3)",
            rusqlite::params![
                CHAT_V2_SESSION_TAGS_SYNC_VERSION,
                sentinel_hash,
                sentinel_schema
            ],
        )
        .unwrap();

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &older_set,
                CHAT_V2_SESSION_TAGS_SYNC_VERSION,
                false,
            )
            .unwrap();
        let persisted: (String, String, String) = conn
            .query_row(
                "SELECT fingerprint, verified_at, canonical_schema
                 FROM __governance_schema_fingerprints
                 WHERE database_id='chat_v2' AND schema_version=?1",
                [CHAT_V2_SESSION_TAGS_SYNC_VERSION],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            persisted,
            (
                sentinel_hash,
                "sentinel-time".to_string(),
                sentinel_schema.to_string()
            )
        );
    }

    #[test]
    fn test_known_chat_v2_prior_scope_fingerprint_is_recovered() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        let prior = seed_chat_v2_prior_scope_fingerprint(&coordinator, &conn);
        let current = coordinator
            .compute_schema_fingerprint(
                &conn,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_SESSION_TAGS_SYNC_VERSION,
            )
            .unwrap();
        assert_ne!(prior.hash, current.hash);

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_SESSION_TAGS_SYNC_VERSION,
                false,
            )
            .unwrap();

        let persisted: (String, String) = conn
            .query_row(
                "SELECT fingerprint, canonical_schema
                 FROM __governance_schema_fingerprints
                 WHERE database_id='chat_v2' AND schema_version=?1",
                [CHAT_V2_SESSION_TAGS_SYNC_VERSION],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(persisted, (current.hash, current.canonical_schema));
    }

    #[test]
    fn test_known_chat_v2_recovery_rejects_changed_trigger_sql() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        seed_chat_v2_prior_scope_fingerprint(&coordinator, &conn);
        conn.execute_batch(
            "DROP TRIGGER trg__change_log_session_tags_insert;
             CREATE TRIGGER trg__change_log_session_tags_insert
             AFTER INSERT ON chat_v2_session_tags BEGIN SELECT 1; END;",
        )
        .unwrap();

        let error = coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_SESSION_TAGS_SYNC_VERSION,
                false,
            )
            .unwrap_err();
        match error {
            MigrationError::VerificationFailed { reason, .. } => {
                assert!(reason.contains("Schema fingerprint drift detected"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_known_chat_v2_recovery_rejects_unrelated_managed_schema_drift() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        seed_chat_v2_prior_scope_fingerprint(&coordinator, &conn);
        conn.execute(
            "ALTER TABLE chat_v2_sessions ADD COLUMN external_drift_marker TEXT",
            [],
        )
        .unwrap();

        let error = coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_SESSION_TAGS_SYNC_VERSION,
                false,
            )
            .unwrap_err();
        match error {
            MigrationError::VerificationFailed { reason, .. } => {
                assert!(reason.contains("Schema fingerprint drift detected"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_known_chat_v2_v20260721_prior_scope_fingerprint_is_recovered_and_stable() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        let prior = seed_chat_v2_prior_scope_fingerprint_for(
            &coordinator,
            &conn,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION,
        );
        let current = coordinator
            .compute_schema_fingerprint(
                &conn,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
            )
            .unwrap();
        assert_ne!(prior.hash, current.hash);

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
                false,
            )
            .unwrap();

        let persisted: (String, String) = conn
            .query_row(
                "SELECT fingerprint, canonical_schema
                 FROM __governance_schema_fingerprints
                 WHERE database_id='chat_v2' AND schema_version=?1",
                [CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(persisted, (current.hash, current.canonical_schema));

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
                false,
            )
            .unwrap();
    }

    #[test]
    fn test_known_chat_v2_v20260721_recovers_v20260719_historical_scope_fingerprint() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        let historical = seed_chat_v2_historical_scope_fingerprint(
            &coordinator,
            &conn,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_SCOPE_VERSION,
        );
        let current = coordinator
            .compute_schema_fingerprint(
                &conn,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
            )
            .unwrap();
        assert_ne!(historical.hash, current.hash);

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
                false,
            )
            .unwrap();

        let persisted: (String, String) = conn
            .query_row(
                "SELECT fingerprint, canonical_schema
                 FROM __governance_schema_fingerprints
                 WHERE database_id='chat_v2' AND schema_version=?1",
                [CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(persisted, (current.hash, current.canonical_schema));
    }

    #[test]
    fn test_known_chat_v2_v20260721_recovery_rejects_changed_journal_table_sql() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        seed_chat_v2_prior_scope_fingerprint_for(
            &coordinator,
            &conn,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION,
        );
        conn.execute(
            "ALTER TABLE __file_deletion_journal ADD COLUMN external_drift_marker TEXT",
            [],
        )
        .unwrap();

        let error = coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
                false,
            )
            .unwrap_err();
        assert!(matches!(error, MigrationError::VerificationFailed { .. }));
    }

    #[test]
    fn test_known_chat_v2_v20260721_recovery_rejects_changed_journal_index_sql() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        seed_chat_v2_prior_scope_fingerprint_for(
            &coordinator,
            &conn,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION,
        );
        conn.execute_batch(
            "DROP INDEX idx__file_deletion_journal_recovery;
             CREATE INDEX idx__file_deletion_journal_recovery
             ON __file_deletion_journal(state, prepared_at);",
        )
        .unwrap();

        let error = coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
                false,
            )
            .unwrap_err();
        assert!(matches!(error, MigrationError::VerificationFailed { .. }));
    }

    #[test]
    fn test_known_chat_v2_v20260721_recovery_rejects_changed_journal_trigger_sql() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        seed_chat_v2_prior_scope_fingerprint_for(
            &coordinator,
            &conn,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION,
        );
        conn.execute_batch(
            "DROP TRIGGER trg__workspace_deletion_queue_published;
             CREATE TRIGGER trg__workspace_deletion_queue_published
             AFTER DELETE ON __workspace_deletion_queue BEGIN SELECT 1; END;",
        )
        .unwrap();

        let error = coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
                false,
            )
            .unwrap_err();
        assert!(matches!(error, MigrationError::VerificationFailed { .. }));
    }

    #[test]
    fn test_known_chat_v2_v20260721_recovery_rejects_malformed_stored_hash() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);
        seed_chat_v2_prior_scope_fingerprint_for(
            &coordinator,
            &conn,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
            CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION,
        );
        conn.execute(
            "UPDATE __governance_schema_fingerprints SET fingerprint='not-a-sha256'
             WHERE database_id='chat_v2' AND schema_version=?1",
            [CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION],
        )
        .unwrap();

        let error = coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
                false,
            )
            .unwrap_err();
        assert!(matches!(error, MigrationError::VerificationFailed { .. }));
    }

    #[test]
    fn test_known_chat_v2_prior_scope_recovery_rejects_unlisted_versions_and_databases() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("chat_v2.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        apply_chat_v2_migrations(&conn);

        let v20260719 = coordinator
            .compute_schema_fingerprint(&conn, &CHAT_V2_MIGRATION_SET, 20260719)
            .unwrap();
        let v20260720 = coordinator
            .compute_schema_fingerprint(&conn, &CHAT_V2_MIGRATION_SET, 20260720)
            .unwrap();
        assert!(!coordinator
            .is_known_chat_v2_prior_scope_fingerprint(
                &conn,
                &DatabaseId::ChatV2,
                &CHAT_V2_MIGRATION_SET,
                20260720,
                &v20260719.hash,
                Some(&v20260719.canonical_schema),
                &v20260720,
            )
            .unwrap());

        let v20260721 = coordinator
            .compute_schema_fingerprint(
                &conn,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
            )
            .unwrap();
        assert!(!coordinator
            .is_known_chat_v2_prior_scope_fingerprint(
                &conn,
                &DatabaseId::Mistakes,
                &CHAT_V2_MIGRATION_SET,
                CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION,
                &v20260720.hash,
                Some(&v20260720.canonical_schema),
                &v20260721,
            )
            .unwrap());
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn test_vfs_recorded_v20260714_schema_gap_is_repaired_idempotently() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("vfs.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        // Simulate a database whose older V20260714 draft was recorded before
        // the complete profile/generation/retry schema reached disk.
        conn.execute_batch(
            "CREATE TABLE refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            );
            INSERT INTO refinery_schema_history VALUES (
                20260714, 'add_vector_index_profiles',
                '2026-07-14T00:00:00Z', 'old-draft'
            );
            CREATE TABLE vfs_embedding_dims (
                dimension INTEGER NOT NULL,
                modality TEXT NOT NULL,
                lance_table_name TEXT NOT NULL,
                record_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER NOT NULL,
                model_config_id TEXT,
                model_name TEXT,
                PRIMARY KEY (dimension, modality)
            );
            CREATE TABLE vfs_index_profiles (
                id TEXT PRIMARY KEY,
                model_fingerprint TEXT NOT NULL,
                dimension INTEGER NOT NULL,
                modality TEXT NOT NULL,
                embedding_protocol TEXT NOT NULL,
                lance_table_name TEXT NOT NULL
            );
            CREATE TABLE vfs_index_units (
                id TEXT PRIMARY KEY,
                text_embedding_dim INTEGER,
                mm_embedding_dim INTEGER,
                text_required INTEGER NOT NULL DEFAULT 0,
                text_state TEXT NOT NULL DEFAULT 'disabled',
                text_error TEXT,
                mm_required INTEGER NOT NULL DEFAULT 0,
                mm_state TEXT NOT NULL DEFAULT 'disabled',
                mm_error TEXT
            );
            CREATE TABLE vfs_index_segments (
                id TEXT PRIMARY KEY,
                embedding_dim INTEGER NOT NULL,
                modality TEXT NOT NULL
            );
            CREATE TABLE resources (
                id TEXT PRIMARY KEY,
                index_state TEXT,
                index_error TEXT,
                index_retry_count INTEGER DEFAULT 0,
                mm_index_state TEXT,
                mm_index_error TEXT,
                mm_index_retry_count INTEGER DEFAULT 0
            );
            CREATE TABLE __lance_orphan_queue (
                lance_row_id TEXT PRIMARY KEY,
                enqueued_at INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO vfs_embedding_dims VALUES (
                768, 'text', 'legacy_text_768', 1, 1, 1, 'cfg-text', 'text-model'
            );
            INSERT INTO vfs_index_units (
                id, text_embedding_dim, text_required, text_state
            ) VALUES ('unit-1', 768, 1, 'indexed');
            INSERT INTO vfs_index_segments (id, embedding_dim, modality)
            VALUES ('segment-1', 768, 'text');
            INSERT INTO resources (
                id, index_state, index_retry_count, mm_index_state, mm_index_retry_count
            ) VALUES ('resource-1', 'indexed', 2, NULL, 0);",
        )
        .unwrap();

        let runner = coordinator.create_vfs_runner().unwrap();
        let repaired = coordinator
            .repair_recorded_migration_schema_gaps(&conn, &DatabaseId::Vfs, &runner)
            .unwrap();
        assert!(repaired);
        coordinator
            .repair_refinery_checksums(&conn, &DatabaseId::Vfs, &runner)
            .unwrap();

        MigrationVerifier::verify(
            &conn,
            &super::super::vfs::V20260714_ADD_VECTOR_INDEX_PROFILES,
        )
        .unwrap();

        let (profile_id, state): (String, String) = conn
            .query_row(
                "SELECT u.text_profile_id, r.index_state
                 FROM vfs_index_units u, resources r
                 WHERE u.id = 'unit-1' AND r.id = 'resource-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(profile_id, "profile_legacy_text_768");
        assert_eq!(state, "pending");

        // A complete older draft can still carry incorrect DML semantics: image
        // embeddings were labelled as text and image-only units were unbound.
        conn.execute_batch(
            "INSERT INTO vfs_embedding_dims (
                dimension, modality, lance_table_name, record_count, created_at,
                last_used_at, model_config_id, model_name, active_profile_id,
                model_fingerprint, embedding_protocol, active_generation,
                ann_metric, ann_index_version
             ) VALUES (
                512, 'image', 'legacy_image_512', 1, 1, 1, 'cfg-image',
                'image-model', 'profile_legacy_image_512',
                'legacy:model-config:cfg-image', 'text-embedding-v1', 0,
                'legacy_l2', 0
             );
             INSERT INTO vfs_index_profiles (
                id, model_fingerprint, model_config_id, model_name, dimension,
                modality, embedding_protocol, schema_version, lance_table_name,
                active_generation, state, ann_metric, ann_index_version,
                created_at, updated_at
             ) VALUES (
                'profile_legacy_image_512', 'legacy:model-config:cfg-image',
                'cfg-image', 'image-model', 512, 'image', 'text-embedding-v1',
                1, 'legacy_image_512', 0, 'active', 'legacy_l2', 0, 1, 1
             );
             INSERT INTO vfs_index_units (
                id, mm_embedding_dim, mm_required, mm_state
             ) VALUES ('unit-image', 512, 1, 'indexed');
             UPDATE refinery_schema_history
             SET checksum = 'old-semantic-draft'
             WHERE version = 20260714;",
        )
        .unwrap();

        let semantic_repaired = coordinator
            .repair_recorded_migration_schema_gaps(&conn, &DatabaseId::Vfs, &runner)
            .unwrap();
        assert!(
            semantic_repaired,
            "checksum drift must replay legacy DML fixes"
        );
        coordinator
            .repair_refinery_checksums(&conn, &DatabaseId::Vfs, &runner)
            .unwrap();

        let (dim_protocol, profile_protocol, image_profile): (String, String, String) = conn
            .query_row(
                "SELECT d.embedding_protocol, p.embedding_protocol, u.mm_profile_id
                 FROM vfs_embedding_dims d
                 JOIN vfs_index_profiles p ON p.id = d.active_profile_id
                 JOIN vfs_index_units u ON u.id = 'unit-image'
                 WHERE d.dimension = 512 AND d.modality = 'image'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(dim_protocol, "multimodal-embedding-v1");
        assert_eq!(profile_protocol, "multimodal-embedding-v1");
        assert_eq!(image_profile, "profile_legacy_image_512");

        let repaired_again = coordinator
            .repair_recorded_migration_schema_gaps(&conn, &DatabaseId::Vfs, &runner)
            .unwrap();
        assert!(!repaired_again, "a converged schema must remain stable");
    }

    /// 回归（fail-close）：未知的同名 checksum 漂移必须中止迁移，
    /// 而不是像旧实现那样静默把 history 改写成当前脚本的 checksum。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_unknown_checksum_drift_fails_close() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("llm_usage.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        // 同名迁移、未知 checksum（不在 allowlist，也不是 baseline "0"）
        conn.execute_batch(
            "CREATE TABLE refinery_schema_history (
                version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT
            );
            INSERT INTO refinery_schema_history VALUES (
                20260130, 'init', '2026-01-30T00:00:00Z', 'unknown-tampered-checksum'
            );",
        )
        .unwrap();

        let runner = coordinator.create_llm_usage_runner().unwrap();
        let error = coordinator
            .repair_refinery_checksums(&conn, &DatabaseId::LlmUsage, &runner)
            .expect_err("unknown checksum drift must abort the migration");
        match &error {
            MigrationError::ChecksumMismatch {
                version, actual, ..
            } => {
                assert_eq!(*version, 20260130);
                assert_eq!(actual, "unknown-tampered-checksum");
            }
            other => panic!("expected ChecksumMismatch, got: {other:?}"),
        }

        // fail-close：history 记录必须保持原样，不得被部分改写
        let recorded: String = conn
            .query_row(
                "SELECT checksum FROM refinery_schema_history WHERE version = 20260130",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recorded, "unknown-tampered-checksum");
    }

    /// 回归（fail-close）：版本号相同但名称不同（版本冲突/历史被篡改）
    /// 必须中止迁移，而不是旧实现的"warn 后跳过"。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_migration_name_conflict_fails_close() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("llm_usage.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(
            "CREATE TABLE refinery_schema_history (
                version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT
            );
            INSERT INTO refinery_schema_history VALUES (
                20260130, 'someone_elses_migration', '2026-01-30T00:00:00Z', 'not-zero'
            );",
        )
        .unwrap();

        let runner = coordinator.create_llm_usage_runner().unwrap();
        let error = coordinator
            .repair_refinery_checksums(&conn, &DatabaseId::LlmUsage, &runner)
            .expect_err("name conflict must abort the migration");
        assert!(
            error.to_string().contains("名称不匹配"),
            "error should describe the name conflict: {error}"
        );
    }

    /// baseline（checksum="0"）仍是显式允许的对齐路径：
    /// ensure_legacy_baseline 写入的占位 checksum 会被对齐到真实值。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_baseline_zero_checksum_is_aligned_to_real_checksum() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("llm_usage.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(
            "CREATE TABLE refinery_schema_history (
                version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT
            );
            INSERT INTO refinery_schema_history VALUES (
                20260130, 'init', '2026-01-30T00:00:00Z', '0'
            );",
        )
        .unwrap();

        let runner = coordinator.create_llm_usage_runner().unwrap();
        coordinator
            .repair_refinery_checksums(&conn, &DatabaseId::LlmUsage, &runner)
            .expect("baseline alignment must stay permitted");

        let expected = runner
            .get_migrations()
            .iter()
            .find(|m| m.version() == 20260130)
            .expect("init migration exists")
            .checksum()
            .to_string();
        let recorded: String = conn
            .query_row(
                "SELECT checksum FROM refinery_schema_history WHERE version = 20260130",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recorded, expected, "baseline '0' should be aligned");
    }

    /// 回归：启动时兼容重放存在明确版本边界——边界之后的迁移即使
    /// 命中"ALTER 列已存在"的残留特征，也不再被自动重放/标记完成，
    /// 必须交由 Refinery 正常执行。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_startup_compat_replay_respects_version_boundary() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("probe.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        // 目标列已存在：对边界内的迁移，旧机制会重放并预标记完成
        conn.execute_batch("CREATE TABLE probe (id INTEGER PRIMARY KEY, smuggled TEXT);")
            .unwrap();

        let future_version = STARTUP_COMPAT_REPLAY_MAX_VERSION + 1;
        let migration = refinery::Migration::unapplied(
            &format!("V{}__future_alter", future_version),
            "ALTER TABLE probe ADD COLUMN smuggled TEXT;",
        )
        .unwrap();
        let runner = refinery::Runner::new(&[migration]);

        coordinator
            .make_alter_columns_safe(&conn, &runner)
            .expect("boundary skip must not error");

        assert!(
            !coordinator
                .is_migration_recorded(&conn, future_version)
                .unwrap(),
            "migrations beyond the compat boundary must not be pre-marked complete"
        );
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn test_mistakes_recorded_v20260523_document_tasks_gap_is_repaired_and_rebaselined() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        for sql in [
            include_str!("../../../migrations/mistakes/V20260130__init.sql"),
            include_str!("../../../migrations/mistakes/V20260131__add_change_log.sql"),
            include_str!("../../../migrations/mistakes/V20260201__add_sync_fields.sql"),
            include_str!("../../../migrations/mistakes/V20260207__add_template_preview_data.sql"),
            include_str!("../../../migrations/mistakes/V20260208__add_hot_query_indexes.sql"),
            include_str!("../../../migrations/mistakes/V20260209__anki_card_dedup_unique.sql"),
            include_str!("../../../migrations/mistakes/V20260524__add_change_log_field_deltas.sql"),
        ] {
            conn.execute_batch(sql).unwrap();
        }

        conn.execute(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            )",
            [],
        )
        .unwrap();
        for (version, name) in [
            (20260130, "init"),
            (20260131, "add_change_log"),
            (20260201, "add_sync_fields"),
            (20260207, "add_template_preview_data"),
            (20260208, "add_hot_query_indexes"),
            (20260209, "anki_card_dedup_unique"),
            (20260523, "add_missing_sync_coverage"),
            (20260524, "add_change_log_field_deltas"),
        ] {
            mark_mistakes_version(&conn, version, name);
        }

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260524,
                false,
            )
            .unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS runtime_documents (id TEXT PRIMARY KEY, body TEXT)",
            [],
        )
        .unwrap();

        let runner = coordinator.create_mistakes_runner().unwrap();
        let repaired = coordinator
            .repair_recorded_migration_schema_gaps(&conn, &DatabaseId::Mistakes, &runner)
            .unwrap();
        assert!(
            repaired,
            "recorded V20260523 should repair missing document_tasks sync coverage"
        );

        coordinator
            .verify_migrations(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260524,
                0,
                repaired,
            )
            .unwrap();

        for column in ["device_id", "local_version", "deleted_at"] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('document_tasks') WHERE name=?1)",
                    [column],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "document_tasks.{} should be repaired", column);
        }

        let has_device_version_index: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_document_tasks_device_version')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_device_version_index,
            "document_tasks sync compound index should be repaired"
        );

        let has_insert_trigger: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg__change_log_document_tasks_insert')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_insert_trigger,
            "document_tasks change-log trigger should be repaired"
        );

        coordinator
            .verify_migrations(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260524,
                0,
                false,
            )
            .unwrap();

        conn.execute(
            "ALTER TABLE anki_cards ADD COLUMN external_drift_marker TEXT",
            [],
        )
        .unwrap();
        let err = coordinator
            .verify_migrations(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260524,
                0,
                false,
            )
            .unwrap_err();

        match err {
            MigrationError::VerificationFailed { reason, .. } => {
                assert!(reason.contains("Schema fingerprint drift detected"));
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_schema_fingerprint_ignores_runtime_managed_objects() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260130__init.sql"
        ))
        .unwrap();

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260130,
                false,
            )
            .unwrap();

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS runtime_documents (
                id TEXT PRIMARY KEY,
                body TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_runtime_documents_body
                ON runtime_documents(body);
            CREATE INDEX IF NOT EXISTS idx_rag_sub_libraries_runtime_name
                ON rag_sub_libraries(name);
            ",
        )
        .unwrap();

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260130,
                false,
            )
            .unwrap();
    }

    #[test]
    fn test_schema_fingerprint_rebaselines_legacy_broad_scope_record() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260130__init.sql"
        ))
        .unwrap();

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260130,
                false,
            )
            .unwrap();

        let select_sql = format!(
            "SELECT canonical_schema FROM {} WHERE database_id = ?1 AND schema_version = ?2",
            SCHEMA_FINGERPRINT_TABLE
        );
        let canonical_schema: String = conn
            .query_row(
                &select_sql,
                rusqlite::params!["mistakes", 20260130_i64],
                |row| row.get(0),
            )
            .unwrap();

        let legacy_broad_schema = format!(
            "{}table:runtime_documents\ncol:0:id:TEXT:0::1\nidx:idx_rag_sub_libraries_runtime_name:CREATE INDEX idx_rag_sub_libraries_runtime_name ON rag_sub_libraries(name)\n",
            canonical_schema
        );
        let current = coordinator
            .compute_schema_fingerprint(&conn, &MISTAKES_MIGRATIONS, 20260130)
            .unwrap();
        let filtered = MigrationCoordinator::filter_canonical_schema_to_scope(
            &legacy_broad_schema,
            &current.scope,
        );
        assert_eq!(filtered, current.canonical_schema);

        let mut hasher = Sha256::new();
        hasher.update(legacy_broad_schema.as_bytes());
        let legacy_broad_hash = format!("{:x}", hasher.finalize());

        let update_sql = format!(
            "UPDATE {} SET fingerprint = ?1, canonical_schema = ?2 WHERE database_id = ?3 AND schema_version = ?4",
            SCHEMA_FINGERPRINT_TABLE
        );
        conn.execute(
            &update_sql,
            rusqlite::params![
                legacy_broad_hash,
                legacy_broad_schema,
                "mistakes",
                20260130_i64
            ],
        )
        .unwrap();

        coordinator
            .verify_schema_fingerprint(
                &conn,
                &DatabaseId::Mistakes,
                &MISTAKES_MIGRATIONS,
                20260130,
                false,
            )
            .unwrap();
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn test_apply_mistakes_init_compat_is_idempotent_on_sparse_legacy_schema() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(
            "
            CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, question_images TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
            CREATE TABLE document_tasks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL DEFAULT '',
                original_document_name TEXT NOT NULL DEFAULT '',
                segment_index INTEGER NOT NULL DEFAULT 0,
                content_segment TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Pending',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                anki_generation_options_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT '',
                source_id TEXT NOT NULL DEFAULT '',
                card_order_in_task INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                template_id TEXT,
                text TEXT
            );
            CREATE TABLE chat_messages (
                id INTEGER PRIMARY KEY,
                mistake_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                stable_id TEXT
            );
            CREATE TABLE review_chat_messages (
                id INTEGER PRIMARY KEY,
                review_analysis_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );
            CREATE TABLE custom_anki_templates (
                id TEXT PRIMARY KEY,
                name TEXT,
                generation_prompt TEXT,
                front_template TEXT,
                back_template TEXT,
                css_style TEXT
            );
            ",
        )
        .unwrap();

        coordinator.apply_mistakes_init_compat(&conn).unwrap();
        coordinator.apply_mistakes_init_compat(&conn).unwrap();

        let has_irec_card_id: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('mistakes') WHERE name='irec_card_id')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_irec_card_id,
            "mistakes.irec_card_id should exist after compat repair"
        );

        let has_turn_id: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chat_messages') WHERE name='turn_id')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_turn_id,
            "chat_messages.turn_id should exist after compat repair"
        );

        let has_text_idx: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_anki_cards_text')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_text_idx,
            "idx_anki_cards_text should exist after compat repair"
        );
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn test_migrate_single_mistakes_recovers_partial_legacy_database() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(
            "
            CREATE TABLE migration_progress (category TEXT PRIMARY KEY, status TEXT NOT NULL);
            CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, question_images TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
            CREATE TABLE document_tasks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL DEFAULT '',
                original_document_name TEXT NOT NULL DEFAULT '',
                segment_index INTEGER NOT NULL DEFAULT 0,
                content_segment TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Pending',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                anki_generation_options_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT '',
                source_id TEXT NOT NULL DEFAULT '',
                card_order_in_task INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                template_id TEXT,
                text TEXT
            );
            CREATE TABLE chat_messages (
                id INTEGER PRIMARY KEY,
                mistake_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                stable_id TEXT
            );
            CREATE TABLE review_chat_messages (
                id INTEGER PRIMARY KEY,
                review_analysis_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );
            ",
        )
        .unwrap();

        drop(conn);

        let report = coordinator.migrate_single(DatabaseId::Mistakes).unwrap();
        assert!(report.success);
        assert_eq!(
            report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );

        let verify_conn = rusqlite::Connection::open(&db_path).unwrap();
        let has_review_sessions: bool = verify_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_sessions')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_review_sessions,
            "review_sessions should exist after migration recovery"
        );

        let has_anki_text: bool = verify_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('anki_cards') WHERE name='text')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_anki_text,
            "anki_cards.text should exist after migration recovery"
        );
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn test_migrate_single_mistakes_reentrant_after_recovery() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        conn.execute_batch(
            "
            CREATE TABLE migration_progress (category TEXT PRIMARY KEY, status TEXT NOT NULL);
            CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, question_images TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
            CREATE TABLE document_tasks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL DEFAULT '',
                original_document_name TEXT NOT NULL DEFAULT '',
                segment_index INTEGER NOT NULL DEFAULT 0,
                content_segment TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Pending',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                anki_generation_options_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT '',
                source_id TEXT NOT NULL DEFAULT '',
                card_order_in_task INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                template_id TEXT,
                text TEXT
            );
            ",
        )
        .unwrap();

        drop(conn);

        let first = coordinator.migrate_single(DatabaseId::Mistakes).unwrap();
        let second = coordinator.migrate_single(DatabaseId::Mistakes).unwrap();

        assert!(first.success);
        assert!(second.success);
        assert_eq!(
            second.applied_count, 0,
            "second migration should be idempotent"
        );
        assert_eq!(
            second.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32,
            "second migration should stay at latest version"
        );
    }

    #[test]
    fn test_check_dependencies_failure() {
        let (coordinator, _temp_dir) = create_test_coordinator();
        let report = MigrationReport::new();

        // ChatV2 依赖 VFS，但 VFS 未迁移
        let result = coordinator.check_dependencies(&DatabaseId::ChatV2, &report);
        assert!(result.is_err());

        if let Err(MigrationError::DependencyNotSatisfied {
            database,
            dependency,
        }) = result
        {
            assert_eq!(database, "chat_v2");
            assert_eq!(dependency, "vfs");
        } else {
            panic!("Expected DependencyNotSatisfied error");
        }
    }

    #[test]
    fn test_core_backup_creates_snapshot_for_four_core_dbs() {
        let (mut coordinator, temp_dir) = create_test_coordinator();

        // 准备四个核心库（真实 SQLite）
        create_test_sqlite_db(&temp_dir.path().join("databases").join("vfs.db"));
        create_test_sqlite_db(&temp_dir.path().join("chat_v2.db"));
        create_test_sqlite_db(&temp_dir.path().join("mistakes.db"));
        create_test_sqlite_db(&temp_dir.path().join("llm_usage.db"));

        coordinator
            .backup_core_databases_once_per_startup()
            .unwrap();

        let backup_root = coordinator.core_backup_root_dir();
        let snapshots: Vec<_> = std::fs::read_dir(&backup_root)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(snapshots.len(), 1, "首次应生成一个快照目录");

        let snapshot_dir = snapshots[0].path();
        assert!(snapshot_dir.join("databases").join("vfs.db").exists());
        assert!(snapshot_dir.join("chat_v2.db").exists());
        assert!(snapshot_dir.join("mistakes.db").exists());
        assert!(snapshot_dir.join("llm_usage.db").exists());
    }

    #[test]
    fn test_core_backup_only_once_in_same_process_for_same_data_dir() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        create_test_sqlite_db(&temp_dir.path().join("databases").join("vfs.db"));
        create_test_sqlite_db(&temp_dir.path().join("chat_v2.db"));
        create_test_sqlite_db(&temp_dir.path().join("mistakes.db"));
        create_test_sqlite_db(&temp_dir.path().join("llm_usage.db"));

        coordinator
            .backup_core_databases_once_per_startup()
            .unwrap();
        coordinator
            .backup_core_databases_once_per_startup()
            .unwrap();

        let backup_root = coordinator.core_backup_root_dir();
        let snapshot_count = std::fs::read_dir(&backup_root)
            .unwrap()
            .filter_map(|e| e.ok())
            .count();
        assert_eq!(snapshot_count, 1, "同一启动周期同一目录仅允许一次备份");
    }

    #[test]
    fn test_core_backup_skips_when_no_pending_migrations() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let vfs_db = temp_dir.path().join("databases").join("vfs.db");
        let chat_db = temp_dir.path().join("chat_v2.db");
        let mistakes_db = temp_dir.path().join("mistakes.db");
        let llm_db = temp_dir.path().join("llm_usage.db");

        mark_latest_version(&vfs_db, VFS_MIGRATION_SET.latest_version() as u32);
        mark_latest_version(&chat_db, CHAT_V2_MIGRATION_SET.latest_version() as u32);
        mark_latest_version(&mistakes_db, MISTAKES_MIGRATIONS.latest_version() as u32);
        mark_latest_version(&llm_db, LLM_USAGE_MIGRATION_SET.latest_version() as u32);

        // 清理该目录可能被前序测试写入的启动 guard
        let key = coordinator.startup_guard_key();
        if let Some(guard) = STARTUP_CORE_BACKUP_GUARD.get() {
            let mut sessions = guard.lock().unwrap();
            sessions.remove(&key);
        }

        coordinator
            .maybe_backup_core_databases_before_migration()
            .unwrap();

        assert!(
            !coordinator.core_backup_root_dir().exists(),
            "无待迁移时不应创建核心快照目录"
        );
    }

    #[test]
    fn test_core_backup_preflight_isolates_unreadable_database() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let vfs_db = temp_dir.path().join("databases").join("vfs.db");
        std::fs::create_dir_all(vfs_db.parent().unwrap()).unwrap();
        std::fs::write(&vfs_db, b"not a sqlite database").unwrap();

        mark_latest_version(
            &temp_dir.path().join("chat_v2.db"),
            CHAT_V2_MIGRATION_SET.latest_version() as u32,
        );
        mark_latest_version(
            &temp_dir.path().join("mistakes.db"),
            MISTAKES_MIGRATIONS.latest_version() as u32,
        );
        mark_latest_version(
            &temp_dir.path().join("llm_usage.db"),
            LLM_USAGE_MIGRATION_SET.latest_version() as u32,
        );

        coordinator
            .maybe_backup_core_databases_before_migration()
            .expect("unreadable component must not abort global migration preflight");

        assert!(
            !coordinator.core_backup_root_dir().exists(),
            "an unreadable database must not seed a new trusted core snapshot"
        );
    }

    /// 复现 V20260202 (llm_usage) 迁移失败场景
    ///
    /// 模拟已完成 V20260130+V20260131+V20260201 的数据库，
    /// 验证 V20260202 能否成功执行。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_reproduce_llm_usage_v20260202_failure() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("llm_usage.db");

        // 按顺序执行前三个迁移的 SQL，建立 v20260201 状态
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(include_str!(
            "../../../migrations/llm_usage/V20260130__init.sql"
        ))
        .unwrap();
        conn.execute_batch(include_str!(
            "../../../migrations/llm_usage/V20260131__add_change_log.sql"
        ))
        .unwrap();
        conn.execute_batch(include_str!(
            "../../../migrations/llm_usage/V20260201__add_sync_fields.sql"
        ))
        .unwrap();

        // 手动标记前三个迁移已完成
        conn.execute(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260130, 'init', '2026-01-30T00:00:00Z', '0')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260131, 'add_change_log', '2026-01-31T00:00:00Z', '0')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260201, 'add_sync_fields', '2026-02-01T00:00:00Z', '0')",
            [],
        ).unwrap();
        drop(conn);

        // 执行迁移 — 应执行 V20260202
        let result = coordinator.migrate_single(DatabaseId::LlmUsage);
        match &result {
            Ok(report) => {
                eprintln!(
                    "[llm_usage V20260202] SUCCESS: from={} to={} applied={}",
                    report.from_version, report.to_version, report.applied_count
                );
            }
            Err(e) => {
                eprintln!("[llm_usage V20260202] FAILED: {}", e);
                eprintln!("[llm_usage V20260202] Debug: {:?}", e);
            }
        }
        assert!(
            result.is_ok(),
            "V20260202 migration should succeed: {:?}",
            result.err()
        );

        let report = result.unwrap();
        assert_eq!(
            report.to_version,
            LLM_USAGE_MIGRATION_SET.latest_version() as u32
        );
    }

    /// 复现 V20260208+V20260209 (mistakes) 迁移失败场景
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_reproduce_mistakes_v20260208_v20260209_failure() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let db_path = temp_dir.path().join("mistakes.db");

        let conn = rusqlite::Connection::open(&db_path).unwrap();
        // 执行前四个迁移建立 v20260207 状态
        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260130__init.sql"
        ))
        .unwrap();
        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260131__add_change_log.sql"
        ))
        .unwrap();
        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260201__add_sync_fields.sql"
        ))
        .unwrap();
        conn.execute_batch(include_str!(
            "../../../migrations/mistakes/V20260207__add_template_preview_data.sql"
        ))
        .unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT)",
            [],
        ).unwrap();
        for (v, n) in [
            (20260130, "init"),
            (20260131, "add_change_log"),
            (20260201, "add_sync_fields"),
            (20260207, "add_template_preview_data"),
        ] {
            conn.execute(
                "INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?1, ?2, '2026-02-07T00:00:00Z', '0')",
                rusqlite::params![v, n],
            ).unwrap();
        }
        drop(conn);

        let result = coordinator.migrate_single(DatabaseId::Mistakes);
        match &result {
            Ok(report) => {
                eprintln!(
                    "[mistakes V20260208+9] SUCCESS: from={} to={} applied={}",
                    report.from_version, report.to_version, report.applied_count
                );
            }
            Err(e) => {
                eprintln!("[mistakes V20260208+9] FAILED: {}", e);
                eprintln!("[mistakes V20260208+9] Debug: {:?}", e);
            }
        }
        assert!(
            result.is_ok(),
            "V20260208+V20260209 migration should succeed: {:?}",
            result.err()
        );

        let report = result.unwrap();
        assert_eq!(
            report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );
    }

    // ========================================================================
    // 故障注入与恢复测试（failpoint fault injection & recovery）
    //
    // 约定：
    // - failpoint 仅在 cfg(test) 下存在（见 fault_injection.rs 模块头注释），
    //   生产构建无任何激活路径（不读环境变量/配置）。
    // - 全部使用确定性错误注入，不使用 process::abort / SIGKILL，
    //   不破坏测试 runner。真正的 hard-kill 语义需要独立子进程 harness，
    //   明确不在本套测试边界内。
    // ========================================================================

    /// 每个数据库的迁移集合（测试辅助）
    #[cfg(feature = "data_governance")]
    fn migration_set_for(id: &DatabaseId) -> &'static MigrationSet {
        match id {
            DatabaseId::Vfs => &VFS_MIGRATION_SET,
            DatabaseId::ChatV2 => &CHAT_V2_MIGRATION_SET,
            DatabaseId::Mistakes => &MISTAKES_MIGRATIONS,
            DatabaseId::LlmUsage => &LLM_USAGE_MIGRATION_SET,
        }
    }

    /// 集合中倒数第二个迁移版本（用于构造"还差一个迁移"的旧状态）
    #[cfg(feature = "data_governance")]
    fn second_latest_version(set: &MigrationSet) -> i32 {
        set.migrations[set.migrations.len() - 2].refinery_version
    }

    const FAULT_MARKER_PAYLOAD: &str = "governance-fault-marker";

    /// 把某个数据库构造到指定版本的真实旧状态：
    /// 顺序执行注册迁移 SQL 并写入 refinery history（checksum '0'，
    /// 由 repair_refinery_checksums 在迁移时对齐），启用 WAL，写入 marker 数据。
    #[cfg(feature = "data_governance")]
    fn build_db_at_version(coordinator: &MigrationCoordinator, id: &DatabaseId, target: i32) {
        let path = coordinator.get_database_path(id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let conn = rusqlite::Connection::open(&path).unwrap();
        // 与真实应用一致地使用 WAL，让备份/恢复路径在 WAL 场景下被验证
        let _mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            )",
            [],
        )
        .unwrap();

        let set = migration_set_for(id);
        for migration in set
            .migrations
            .iter()
            .filter(|m| m.refinery_version <= target)
        {
            conn.execute_batch(migration.sql).unwrap_or_else(|e| {
                panic!(
                    "构造旧状态失败 {} V{}: {}",
                    set.database_name, migration.refinery_version, e
                )
            });
            conn.execute(
                "INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum)
                 VALUES (?1, ?2, '2026-07-01T00:00:00Z', '0')",
                rusqlite::params![migration.refinery_version, migration.name],
            )
            .unwrap();
        }

        // 关键数据 marker：迁移不管理的 runtime 表，fingerprint 会忽略它，
        // 但备份/恢复必须完整保留其内容
        conn.execute(
            "CREATE TABLE IF NOT EXISTS __test_marker (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO __test_marker (id, payload) VALUES ('m', ?1)",
            [FAULT_MARKER_PAYLOAD],
        )
        .unwrap();
    }

    /// 构造四核心库的一致旧状态：
    /// - vfs 处于已注册迁移的最新版（其待执行项与本测试无关）
    /// - chat_v2 / mistakes / llm_usage 各留一个待执行迁移
    ///
    /// 返回旧版本 tuple（按 all_ordered 顺序）。
    #[cfg(feature = "data_governance")]
    fn build_old_core_state(coordinator: &MigrationCoordinator) -> Vec<(DatabaseId, u32)> {
        let targets = [
            (DatabaseId::Vfs, VFS_MIGRATION_SET.latest_version()),
            (
                DatabaseId::LlmUsage,
                second_latest_version(&LLM_USAGE_MIGRATION_SET),
            ),
            (
                DatabaseId::ChatV2,
                second_latest_version(&CHAT_V2_MIGRATION_SET),
            ),
            (
                DatabaseId::Mistakes,
                second_latest_version(&MISTAKES_MIGRATIONS),
            ),
        ];
        for (id, target) in &targets {
            build_db_at_version(coordinator, id, *target);
        }
        targets
            .iter()
            .map(|(id, target)| (id.clone(), *target as u32))
            .collect()
    }

    /// 读取四核心库当前 schema 版本 tuple
    #[cfg(feature = "data_governance")]
    fn core_version_tuple(coordinator: &MigrationCoordinator) -> Vec<(DatabaseId, u32)> {
        DatabaseId::all_ordered()
            .into_iter()
            .map(|id| {
                let conn = rusqlite::Connection::open(coordinator.get_database_path(&id)).unwrap();
                let version = coordinator.get_current_version(&conn).unwrap();
                (id, version)
            })
            .collect()
    }

    /// 新 schema 哨兵：分别对应 chat_v2 / mistakes / llm_usage 的最后一个迁移
    /// 引入的可观测 schema 变化。返回 (chat_new, mistakes_new, llm_new)。
    #[cfg(feature = "data_governance")]
    fn new_schema_sentinels(coordinator: &MigrationCoordinator) -> (bool, bool, bool) {
        let chat_conn =
            rusqlite::Connection::open(coordinator.get_database_path(&DatabaseId::ChatV2)).unwrap();
        // V20260719 新建复合索引
        let chat_new = coordinator
            .index_exists(&chat_conn, "idx_chat_v2_sessions_status_updated")
            .unwrap();

        let mistakes_conn =
            rusqlite::Connection::open(coordinator.get_database_path(&DatabaseId::Mistakes))
                .unwrap();
        // V20260721 新增列
        let mistakes_new = coordinator
            .column_exists(
                &mistakes_conn,
                "automation_definitions",
                "trusted_profile_json",
            )
            .unwrap();

        let llm_conn =
            rusqlite::Connection::open(coordinator.get_database_path(&DatabaseId::LlmUsage))
                .unwrap();
        // V20260525 删除 daily 触发器（新 = 触发器不存在）
        let llm_new = !coordinator
            .trigger_exists(&llm_conn, "trg__change_log_usage_daily_insert")
            .unwrap();

        (chat_new, mistakes_new, llm_new)
    }

    /// 断言 marker 数据在四核心库中完整存在
    #[cfg(feature = "data_governance")]
    fn assert_markers_intact(coordinator: &MigrationCoordinator, context: &str) {
        for id in DatabaseId::all_ordered() {
            let conn = rusqlite::Connection::open(coordinator.get_database_path(&id)).unwrap();
            let payload: String = conn
                .query_row(
                    "SELECT payload FROM __test_marker WHERE id = 'm'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or_else(|e| panic!("[{}] {} marker 丢失: {}", context, id.as_str(), e));
            assert_eq!(
                payload,
                FAULT_MARKER_PAYLOAD,
                "[{}] {} marker 数据被破坏",
                context,
                id.as_str()
            );
        }
    }

    /// 参数化故障注入：覆盖 核心快照后 / 某库迁移前 / 某库迁移后(history 已写、
    /// 验证前) / 验证后 等关键边界。
    ///
    /// 断言：任一故障后四核心库 schema tuple 与关键数据必须"全旧"（恢复成功），
    /// 不允许混合状态；解除故障后重试必须成功且哨兵"全新"。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_failpoint_injection_keeps_core_state_atomic_and_retry_succeeds() {
        struct Case {
            point: &'static str,
            failed_component: Option<DatabaseId>,
        }
        let cases = [
            Case {
                point: "after_core_backup",
                failed_component: None,
            },
            Case {
                point: "before_db_migration::llm_usage",
                failed_component: Some(DatabaseId::LlmUsage),
            },
            Case {
                point: "before_db_migration::chat_v2",
                failed_component: Some(DatabaseId::ChatV2),
            },
            Case {
                point: "after_db_migration::chat_v2",
                failed_component: Some(DatabaseId::ChatV2),
            },
            Case {
                point: "after_db_migration::mistakes",
                failed_component: Some(DatabaseId::Mistakes),
            },
            Case {
                point: "after_verification::mistakes",
                failed_component: Some(DatabaseId::Mistakes),
            },
        ];

        for case in &cases {
            let (mut coordinator, temp_dir) = create_test_coordinator();
            let old_tuple = build_old_core_state(&coordinator);

            let guard = fault_injection::arm(temp_dir.path(), case.point, 1);
            let run = coordinator.run_all();
            assert_eq!(
                guard.hits(),
                1,
                "[{}] failpoint 必须恰好触发一次",
                case.point
            );

            if let Some(failed_component) = &case.failed_component {
                let report = run.unwrap_or_else(|error| {
                    panic!("[{}] 单库故障不应成为全局错误: {}", case.point, error)
                });
                assert!(!report.success);
                assert!(report
                    .component_health
                    .is_blocked(failed_component.as_str()));
                let failed_report = report
                    .databases
                    .iter()
                    .find(|entry| &entry.id == failed_component)
                    .expect("failed database report must be retained");
                assert!(!failed_report.success);
                assert!(
                    failed_report
                        .error
                        .as_deref()
                        .is_some_and(|error| error.contains("[failpoint]")),
                    "failure report should retain the injected error"
                );

                for entry in &report.databases {
                    if entry.id != *failed_component {
                        assert!(
                            entry.success,
                            "[{}] unrelated {} must continue",
                            case.point,
                            entry.id.as_str()
                        );
                    }
                }

                let current = core_version_tuple(&coordinator);
                for (id, version) in current {
                    let old_version = old_tuple
                        .iter()
                        .find(|(old_id, _)| old_id == &id)
                        .map(|(_, version)| *version)
                        .unwrap();
                    if id == *failed_component {
                        assert_eq!(
                            version, old_version,
                            "[{}] failed database alone must be restored",
                            case.point
                        );
                    } else {
                        assert!(
                            version >= migration_set_for(&id).latest_version() as u32,
                            "[{}] unrelated {} must remain migrated",
                            case.point,
                            id.as_str()
                        );
                    }
                }
            } else {
                let err = run.expect_err("global post-snapshot failpoint must still fail");
                assert!(
                    err.to_string().contains("[failpoint]"),
                    "[{}] 应为注入错误: {}",
                    case.point,
                    err
                );
                assert_eq!(core_version_tuple(&coordinator), old_tuple);
            }
            assert_markers_intact(&coordinator, case.point);

            // 解除故障后重试必须成功，且全部推进到新版本
            drop(guard);
            let report = coordinator
                .run_all()
                .unwrap_or_else(|e| panic!("[{}] 重试应成功: {}", case.point, e));
            assert!(report.success, "[{}] 重试报告应成功", case.point);
            for (id, version) in core_version_tuple(&coordinator) {
                assert!(
                    version >= migration_set_for(&id).latest_version() as u32,
                    "[{}] {} 重试后应达到最新注册版本",
                    case.point,
                    id.as_str()
                );
            }
            assert_eq!(
                new_schema_sentinels(&coordinator),
                (true, true, true),
                "[{}] 重试成功后哨兵必须全新",
                case.point
            );
            assert_markers_intact(&coordinator, &format!("{}(retry)", case.point));
        }
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn test_vfs_failure_blocks_dependency_closure_but_not_llm_usage() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let old_tuple = build_old_core_state(&coordinator);
        let guard = fault_injection::arm(temp_dir.path(), "before_db_migration::vfs", 1);

        let report = coordinator.run_all().unwrap();
        assert_eq!(guard.hits(), 1);
        assert!(!report.success);
        assert!(report.component_health.is_blocked("vfs"));
        assert!(report.component_health.is_blocked("chat_v2"));
        assert!(report.component_health.is_blocked("mistakes"));
        assert!(!report.component_health.is_blocked("llm_usage"));

        for dependent in ["chat_v2", "mistakes"] {
            let issue = report
                .component_health
                .issues()
                .into_iter()
                .find(|issue| issue.component == dependent)
                .unwrap();
            assert_eq!(issue.dependency.as_deref(), Some("vfs"));
        }

        let current = core_version_tuple(&coordinator);
        let llm_version = current
            .iter()
            .find(|(id, _)| id == &DatabaseId::LlmUsage)
            .unwrap()
            .1;
        assert_eq!(llm_version, LLM_USAGE_MIGRATION_SET.latest_version() as u32);
        for blocked in [DatabaseId::Vfs, DatabaseId::ChatV2, DatabaseId::Mistakes] {
            let before = old_tuple.iter().find(|(id, _)| id == &blocked).unwrap().1;
            let after = current.iter().find(|(id, _)| id == &blocked).unwrap().1;
            assert_eq!(after, before, "{} must not advance", blocked.as_str());
        }
    }

    #[cfg(feature = "data_governance")]
    #[test]
    fn test_chat_failure_isolated_from_mistakes_and_llm_usage() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let old_tuple = build_old_core_state(&coordinator);
        let guard = fault_injection::arm(temp_dir.path(), "before_db_migration::chat_v2", 1);

        let report = coordinator.run_all().unwrap();
        assert_eq!(guard.hits(), 1);
        assert_eq!(
            report.component_health.blocked_components(),
            vec!["chat_v2"]
        );

        let current = core_version_tuple(&coordinator);
        for independent in [DatabaseId::LlmUsage, DatabaseId::Mistakes] {
            let version = current.iter().find(|(id, _)| id == &independent).unwrap().1;
            assert!(
                version >= migration_set_for(&independent).latest_version() as u32,
                "{} should remain at or advance beyond the latest registered migration",
                independent.as_str()
            );
        }
        let old_chat = old_tuple
            .iter()
            .find(|(id, _)| id == &DatabaseId::ChatV2)
            .unwrap()
            .1;
        let current_chat = current
            .iter()
            .find(|(id, _)| id == &DatabaseId::ChatV2)
            .unwrap()
            .1;
        assert_eq!(current_chat, old_chat);
    }

    /// 恢复前故障只阻断失败组件，并在健康信息中同时保留迁移与恢复错误。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_failpoint_before_restore_leaves_untouched_state_consistent() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let old_tuple = build_old_core_state(&coordinator);

        let migration_guard = fault_injection::arm(temp_dir.path(), "before_db_migration::vfs", 1);
        let restore_guard = fault_injection::arm(temp_dir.path(), "before_restore", 1);

        let report = coordinator.run_all().unwrap();
        assert_eq!(migration_guard.hits(), 1);
        assert_eq!(restore_guard.hits(), 1, "恢复流程应已被触达并被阻断");
        assert!(!report.success);
        assert!(report.component_health.is_blocked("vfs"));
        let reason = report
            .component_health
            .issues()
            .into_iter()
            .find(|issue| issue.component == "vfs")
            .and_then(|issue| issue.reason)
            .unwrap();
        assert!(
            reason.contains("migration failed") && reason.contains("also failed"),
            "both errors must be retained: {reason}"
        );

        let current = core_version_tuple(&coordinator);
        assert_eq!(current[0], old_tuple[0], "vfs must remain unchanged");
        assert_eq!(
            current[1].1,
            migration_set_for(&DatabaseId::LlmUsage).latest_version() as u32,
            "independent llm_usage must continue"
        );
        assert!(
            coordinator.restore_failure_journal_path().is_file(),
            "恢复失败必须跨进程持久化，避免下次启动建立错误基线"
        );
        assert_markers_intact(&coordinator, "before_restore");

        drop(migration_guard);
        drop(restore_guard);
        let mut restarted = MigrationCoordinator::new(temp_dir.path().to_path_buf());
        let report = restarted.run_all().unwrap();
        assert!(report.success);
        assert!(
            !restarted.restore_failure_journal_path().exists(),
            "可信快照恢复成功后必须清除故障记录"
        );
        assert_eq!(new_schema_sentinels(&restarted), (true, true, true));
        assert_markers_intact(&restarted, "before_restore(retry)");
    }

    /// 恢复后上报故障仍只 affects the failed database.
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_failpoint_after_restore_disk_recovered_despite_reported_failure() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let old_tuple = build_old_core_state(&coordinator);

        let migration_guard =
            fault_injection::arm(temp_dir.path(), "before_db_migration::chat_v2", 1);
        let restore_guard = fault_injection::arm(temp_dir.path(), "after_restore", 1);

        let report = coordinator.run_all().unwrap();
        assert_eq!(migration_guard.hits(), 1);
        assert_eq!(restore_guard.hits(), 1, "after_restore 应在恢复完成后触发");
        assert!(!report.success);
        assert!(report.component_health.is_blocked("chat_v2"));

        let current = core_version_tuple(&coordinator);
        let old_chat = old_tuple
            .iter()
            .find(|(id, _)| id == &DatabaseId::ChatV2)
            .unwrap()
            .1;
        let current_chat = current
            .iter()
            .find(|(id, _)| id == &DatabaseId::ChatV2)
            .unwrap()
            .1;
        assert_eq!(current_chat, old_chat, "chat_v2 was restored on disk");
        for independent in [DatabaseId::LlmUsage, DatabaseId::Mistakes] {
            let version = current.iter().find(|(id, _)| id == &independent).unwrap().1;
            assert_eq!(
                version,
                migration_set_for(&independent).latest_version() as u32,
                "{} must not be rolled back",
                independent.as_str()
            );
        }
        assert_markers_intact(&coordinator, "after_restore");

        drop(migration_guard);
        drop(restore_guard);
        let report = coordinator.run_all().unwrap();
        assert!(report.success);
        assert_eq!(new_schema_sentinels(&coordinator), (true, true, true));
    }

    /// 未 arm 的 failpoint 必须是 no-op（防止注册表泄漏影响其他测试）
    #[test]
    fn test_failpoint_unarmed_is_noop_and_guard_disarms_on_drop() {
        let (coordinator, temp_dir) = create_test_coordinator();
        assert!(coordinator.failpoint("never_armed").is_ok());

        {
            let _guard = fault_injection::arm(temp_dir.path(), "scoped_point", 1);
            assert!(coordinator.failpoint("scoped_point").is_err());
        }
        // guard drop 后自动解除
        assert!(coordinator.failpoint("scoped_point").is_ok());

        // 不同数据目录的同名 failpoint 互不影响
        let other_dir = TempDir::new().unwrap();
        let _other_guard = fault_injection::arm(other_dir.path(), "scoped_point", 1);
        assert!(coordinator.failpoint("scoped_point").is_ok());
    }

    // ========================================================================
    // make_alter_columns_safe 回归：列已存在但同迁移 DML 未完成时，
    // 绝不允许"整条预标记"而跳过回填/索引；必须重放剩余 SQL 后才记账。
    // 目标迁移：mistakes V20260720（2×ALTER + UPDATE 回填 + CREATE INDEX）。
    // ========================================================================

    /// 构造 mistakes 库到 V20260715，并插入一条待回填的 fsrs_review_logs 行
    #[cfg(feature = "data_governance")]
    fn build_mistakes_before_mastery_outbox(
        coordinator: &MigrationCoordinator,
    ) -> rusqlite::Connection {
        build_db_at_version(coordinator, &DatabaseId::Mistakes, 20260715);
        let conn = rusqlite::Connection::open(coordinator.get_database_path(&DatabaseId::Mistakes))
            .unwrap();
        conn.execute(
            "INSERT INTO document_tasks (
                id, document_id, original_document_name, segment_index,
                content_segment, status, anki_generation_options_json
             ) VALUES ('task-1', 'doc-1', 'doc.md', 0, 'seg', 'Completed', '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO anki_cards (id, task_id, front, back, created_at, updated_at)
             VALUES ('card-1', 'task-1', 'f', 'b', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, created_at, updated_at)
             VALUES ('state-1', 'card-1', 0, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO fsrs_review_logs (
                id, card_state_id, anki_card_id, rating, state_before, state_after,
                review_ms, fsrs_params_version, created_at, updated_at
             ) VALUES (
                'log-1', 'state-1', 'card-1', 3, 0, 1,
                1751328000000, 'rs-fsrs-1.2', '2026-07-01T00:00:00Z', NULL
             )",
            [],
        )
        .unwrap();
        conn
    }

    /// 直接回归 make_alter_columns_safe：所有 ALTER 列已存在、DML 未执行
    /// （模拟 history 回滚残留）。必须重放回填 UPDATE 与 CREATE INDEX，
    /// 不能只标记完成。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_make_alter_columns_safe_replays_backfill_when_all_columns_exist() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let _ = temp_dir;
        let conn = build_mistakes_before_mastery_outbox(&coordinator);

        // 模拟部分失败：V20260720 的两条 ALTER 已落盘，但 UPDATE 回填、
        // CREATE INDEX 和 history 记录都丢失
        conn.execute_batch(
            "ALTER TABLE fsrs_review_logs ADD COLUMN mastery_synced_at TEXT;
             ALTER TABLE fsrs_review_logs ADD COLUMN mastery_revert_pending INTEGER NOT NULL DEFAULT 0;",
        )
        .unwrap();
        let pre_backfill: Option<String> = conn
            .query_row(
                "SELECT mastery_synced_at FROM fsrs_review_logs WHERE id = 'log-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(pre_backfill.is_none(), "构造场景应为未回填状态");

        let runner = coordinator.create_mistakes_runner().unwrap();
        coordinator.make_alter_columns_safe(&conn, &runner).unwrap();

        // 1) 必须已记账
        assert!(
            coordinator.is_migration_recorded(&conn, 20260720).unwrap(),
            "V20260720 应被标记完成"
        );
        // 2) 回填 DML 必须已重放（mastery_synced_at = COALESCE(updated_at, created_at, ...)）
        let backfilled: String = conn
            .query_row(
                "SELECT mastery_synced_at FROM fsrs_review_logs WHERE id = 'log-1'",
                [],
                |row| row.get(0),
            )
            .expect("回填 UPDATE 必须执行，不能被预标记跳过");
        assert_eq!(backfilled, "2026-07-01T00:00:00Z");
        // 3) 同迁移中的 CREATE INDEX 也必须重放
        assert!(
            coordinator
                .index_exists(&conn, "idx_fsrs_review_logs_mastery_pending")
                .unwrap(),
            "V20260720 的索引必须随重放创建"
        );
    }

    /// 部分列存在（中间状态）：补齐缺失列后同样必须重放回填与索引。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_make_alter_columns_safe_completes_partial_columns_and_backfills() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let _ = temp_dir;
        let conn = build_mistakes_before_mastery_outbox(&coordinator);

        // 只有第一条 ALTER 落盘
        conn.execute(
            "ALTER TABLE fsrs_review_logs ADD COLUMN mastery_synced_at TEXT",
            [],
        )
        .unwrap();

        let runner = coordinator.create_mistakes_runner().unwrap();
        coordinator.make_alter_columns_safe(&conn, &runner).unwrap();

        assert!(coordinator.is_migration_recorded(&conn, 20260720).unwrap());
        // 缺失列被补齐（含列定义/默认值）
        let revert_pending: i64 = conn
            .query_row(
                "SELECT mastery_revert_pending FROM fsrs_review_logs WHERE id = 'log-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revert_pending, 0, "补齐列应带 DEFAULT 0");
        // 回填与索引依然必须执行
        let backfilled: String = conn
            .query_row(
                "SELECT mastery_synced_at FROM fsrs_review_logs WHERE id = 'log-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(backfilled, "2026-07-01T00:00:00Z");
        assert!(coordinator
            .index_exists(&conn, "idx_fsrs_review_logs_mastery_pending")
            .unwrap());
    }

    /// 端到端回归：ALTER 残留状态下走完整 migrate_single，
    /// 回填生效、后续迁移继续、且可重入。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_migrate_single_recovers_alter_residue_without_skipping_backfill() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let _ = temp_dir;
        let conn = build_mistakes_before_mastery_outbox(&coordinator);
        conn.execute_batch(
            "ALTER TABLE fsrs_review_logs ADD COLUMN mastery_synced_at TEXT;
             ALTER TABLE fsrs_review_logs ADD COLUMN mastery_revert_pending INTEGER NOT NULL DEFAULT 0;",
        )
        .unwrap();
        drop(conn);

        let report = coordinator.migrate_single(DatabaseId::Mistakes).unwrap();
        assert!(report.success);
        assert_eq!(
            report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );

        let conn = rusqlite::Connection::open(coordinator.get_database_path(&DatabaseId::Mistakes))
            .unwrap();
        let backfilled: String = conn
            .query_row(
                "SELECT mastery_synced_at FROM fsrs_review_logs WHERE id = 'log-1'",
                [],
                |row| row.get(0),
            )
            .expect("端到端路径同样不允许跳过回填");
        assert_eq!(backfilled, "2026-07-01T00:00:00Z");
        drop(conn);

        // 可重入
        let second = coordinator.migrate_single(DatabaseId::Mistakes).unwrap();
        assert!(second.success);
        assert_eq!(second.applied_count, 0);
    }

    // ========================================================================
    // lock / read-only / WAL / 备份恢复补充场景
    // ========================================================================

    /// 另一连接持有写锁（BEGIN IMMEDIATE）时迁移必须失败，
    /// 释放后重试成功且不留混合状态。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_migration_fails_cleanly_when_database_write_locked_then_retries() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        let _ = temp_dir;
        build_db_at_version(
            &coordinator,
            &DatabaseId::Mistakes,
            second_latest_version(&MISTAKES_MIGRATIONS),
        );
        let old_version = {
            let conn =
                rusqlite::Connection::open(coordinator.get_database_path(&DatabaseId::Mistakes))
                    .unwrap();
            coordinator.get_current_version(&conn).unwrap()
        };

        // 持有写锁
        let locker =
            rusqlite::Connection::open(coordinator.get_database_path(&DatabaseId::Mistakes))
                .unwrap();
        locker.execute_batch("BEGIN IMMEDIATE").unwrap();

        let err = coordinator.migrate_single(DatabaseId::Mistakes);
        assert!(err.is_err(), "写锁存在时迁移必须失败: {err:?}");

        // 释放写锁
        locker.execute_batch("ROLLBACK").unwrap();
        drop(locker);

        // 失败后版本不能前进到一半（history 未变更）
        {
            let conn =
                rusqlite::Connection::open(coordinator.get_database_path(&DatabaseId::Mistakes))
                    .unwrap();
            assert_eq!(coordinator.get_current_version(&conn).unwrap(), old_version);
        }

        let report = coordinator.migrate_single(DatabaseId::Mistakes).unwrap();
        assert!(report.success);
        assert_eq!(
            report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );
    }

    /// 数据库文件只读时迁移必须失败且不破坏文件；恢复权限后重试成功。
    #[cfg(all(unix, feature = "data_governance"))]
    #[test]
    fn test_migration_fails_cleanly_on_readonly_database_then_retries() {
        use std::os::unix::fs::PermissionsExt;

        let (mut coordinator, temp_dir) = create_test_coordinator();
        let _ = temp_dir;
        build_db_at_version(
            &coordinator,
            &DatabaseId::LlmUsage,
            second_latest_version(&LLM_USAGE_MIGRATION_SET),
        );
        let db_path = coordinator.get_database_path(&DatabaseId::LlmUsage);
        // This test isolates filesystem permission recovery. WAL recovery and
        // stale-sidecar cleanup are covered separately by the snapshot tests.
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            let mode: String = conn
                .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
                .unwrap();
            assert_eq!(mode.to_ascii_lowercase(), "delete");
        }

        std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let result = coordinator.migrate_single(DatabaseId::LlmUsage);
        assert!(result.is_err(), "只读数据库上的迁移必须失败: {result:?}");

        std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        // 只读失败不能损坏数据库
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            let integrity: String = conn
                .query_row("PRAGMA quick_check", [], |row| row.get(0))
                .unwrap();
            assert_eq!(integrity, "ok");
        }

        let report = coordinator.migrate_single(DatabaseId::LlmUsage).unwrap();
        assert!(report.success);
        assert_eq!(
            report.to_version,
            LLM_USAGE_MIGRATION_SET.latest_version() as u32
        );
    }

    /// 无快照时恢复必须显式报错（而不是静默"成功"）。
    #[test]
    fn test_restore_without_snapshot_errors_explicitly() {
        let (coordinator, _temp_dir) = create_test_coordinator();
        let err = coordinator.restore_from_latest_core_backup().unwrap_err();
        assert!(
            err.to_string().contains("无迁移前快照"),
            "unexpected error: {err}"
        );
    }

    /// 恢复必须覆盖故障后的脏数据，并清理残留 WAL/SHM 文件。
    #[test]
    fn test_restore_overwrites_tampered_data_and_cleans_stale_wal_files() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        create_test_sqlite_db(&temp_dir.path().join("databases").join("vfs.db"));
        create_test_sqlite_db(&temp_dir.path().join("chat_v2.db"));
        create_test_sqlite_db(&temp_dir.path().join("mistakes.db"));
        create_test_sqlite_db(&temp_dir.path().join("llm_usage.db"));

        coordinator
            .backup_core_databases_once_per_startup()
            .unwrap();

        // 模拟失败迁移留下的脏数据 + 残留 WAL/SHM
        let chat_path = temp_dir.path().join("chat_v2.db");
        {
            let conn = rusqlite::Connection::open(&chat_path).unwrap();
            conn.execute("INSERT INTO test_data (value) VALUES ('tampered')", [])
                .unwrap();
        }
        let wal_residual = temp_dir.path().join("chat_v2.db-wal");
        let shm_residual = temp_dir.path().join("chat_v2.db-shm");
        std::fs::write(&wal_residual, b"stale-wal-garbage").unwrap();
        std::fs::write(&shm_residual, b"stale-shm-garbage").unwrap();

        let restored = coordinator.restore_from_latest_core_backup().unwrap();
        assert_eq!(restored, 4, "四个核心库都应恢复");

        assert!(!wal_residual.exists(), "残留 WAL 必须被清理");
        assert!(!shm_residual.exists(), "残留 SHM 必须被清理");

        let conn = rusqlite::Connection::open(&chat_path).unwrap();
        let tampered_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM test_data WHERE value = 'tampered'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tampered_count, 0, "脏数据必须被快照覆盖");
        let ok_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM test_data WHERE value = 'ok'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ok_count, 1, "快照数据必须完整恢复");
        let integrity: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }

    #[test]
    fn test_single_database_restore_does_not_rewind_unrelated_databases() {
        let (mut coordinator, temp_dir) = create_test_coordinator();
        for path in [
            temp_dir.path().join("databases").join("vfs.db"),
            temp_dir.path().join("chat_v2.db"),
            temp_dir.path().join("mistakes.db"),
            temp_dir.path().join("llm_usage.db"),
        ] {
            create_test_sqlite_db(&path);
        }
        coordinator
            .backup_core_databases_once_per_startup()
            .unwrap();

        for id in DatabaseId::all_ordered() {
            let conn = rusqlite::Connection::open(coordinator.get_database_path(&id)).unwrap();
            conn.execute(
                "INSERT INTO test_data (value) VALUES (?1)",
                [format!("new-{}", id.as_str())],
            )
            .unwrap();
        }

        coordinator
            .restore_database_from_latest_core_backup(&DatabaseId::ChatV2)
            .unwrap();

        for id in DatabaseId::all_ordered() {
            let conn = rusqlite::Connection::open(coordinator.get_database_path(&id)).unwrap();
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM test_data WHERE value = ?1",
                    [format!("new-{}", id.as_str())],
                    |row| row.get(0),
                )
                .unwrap();
            if id == DatabaseId::ChatV2 {
                assert_eq!(count, 0, "failed database must be restored");
            } else {
                assert_eq!(count, 1, "{} must not be restored", id.as_str());
            }
        }
    }

    /// 存在多个快照时必须恢复最新的一个。
    #[test]
    fn test_restore_picks_latest_snapshot() {
        let (coordinator, temp_dir) = create_test_coordinator();
        let root = coordinator.core_backup_root_dir();

        for (dir_name, payload) in [
            ("startup_20260101T000000.000Z_1", "old-snapshot"),
            ("startup_20260702T000000.000Z_1", "new-snapshot"),
        ] {
            let snapshot_dir = root.join(dir_name);
            std::fs::create_dir_all(&snapshot_dir).unwrap();
            let db_path = snapshot_dir.join("chat_v2.db");
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute(
                "CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO test_data (value) VALUES (?1)", [payload])
                .unwrap();
            std::fs::write(
                snapshot_dir.join("metadata.json"),
                r#"{"copied_files":["chat_v2.db"]}"#,
            )
            .unwrap();
        }

        let restored = coordinator.restore_from_latest_core_backup().unwrap();
        assert_eq!(restored, 1);

        let conn = rusqlite::Connection::open(temp_dir.path().join("chat_v2.db")).unwrap();
        let value: String = conn
            .query_row("SELECT value FROM test_data LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "new-snapshot", "必须从最新快照恢复");
    }
}
