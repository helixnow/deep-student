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

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use crate::data_governance::schema_registry::{DatabaseId, SchemaRegistry};

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

// 导入各数据库的迁移集合
use super::chat_v2::CHAT_V2_MIGRATION_SET;
use super::llm_usage::LLM_USAGE_MIGRATION_SET;
use super::mistakes::MISTAKES_MIGRATIONS;
use super::vfs::VFS_MIGRATION_SET;

const SCHEMA_FINGERPRINT_TABLE: &str = "__governance_schema_fingerprints";
const CORE_BACKUP_ROOT_DIR_NAME: &str = "migration_core_backups";
const CORE_BACKUP_RETENTION_COUNT: usize = 5;

// 同一进程（一次应用启动）中，针对同一数据目录只做一次“迁移前核心库备份”
static STARTUP_CORE_BACKUP_GUARD: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

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
}

impl MigrationReport {
    /// 创建新的报告
    pub fn new() -> Self {
        Self {
            databases: Vec::new(),
            success: true,
            total_duration_ms: 0,
            error: None,
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
    /// 按依赖顺序执行，任一数据库失败则停止后续迁移。
    /// 迁移前检查磁盘可用空间，空间不足时 fail-fast。
    pub fn run_all(&mut self) -> Result<MigrationReport, MigrationError> {
        let start = std::time::Instant::now();
        let mut report = MigrationReport::new();

        tracing::info!(
            "🚀 [MigrationCoordinator] 开始执行所有数据库迁移, 数据目录: {}",
            self.app_data_dir.display()
        );

        // Issue #11 修复：迁移前检查磁盘可用空间
        self.preflight_disk_space_check()?;

        // 核心库迁移前保护：仅在存在待迁移项时，且同一启动周期只备份一次初始状态
        self.maybe_backup_core_databases_before_migration()?;

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
            // fail-close：依赖不满足时立即中断
            if let Err(e) = self.check_dependencies(&db_id, &report) {
                tracing::error!(
                    "❌ [MigrationCoordinator] {} 依赖检查失败: {}",
                    db_id.as_str(),
                    e
                );
                report.success = false;
                report.error = Some(e.to_string());
                return Err(e);
            }

            // 执行迁移（任一数据库失败即停止）
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
                    // 记录已成功迁移的数据库，帮助运维了解部分完成状态
                    let completed_dbs: Vec<&str> = report
                        .databases
                        .iter()
                        .filter(|r| r.success)
                        .map(|r| r.id.as_str())
                        .collect();
                    tracing::error!(
                        failed_db = db_id.as_str(),
                        error = %e,
                        completed_dbs = ?completed_dbs,
                        "❌ [MigrationCoordinator] {} 迁移失败 (已完成: {:?})",
                        db_id.as_str(),
                        completed_dbs,
                    );
                    report.success = false;
                    report.error = Some(format!(
                        "Database '{}' migration failed: {}. Successfully completed: [{}]",
                        db_id.as_str(),
                        e,
                        completed_dbs.join(", "),
                    ));
                    return Err(e);
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

    fn core_backup_root_dir(&self) -> PathBuf {
        self.app_data_dir.join(CORE_BACKUP_ROOT_DIR_NAME)
    }

    fn startup_guard_key(&self) -> String {
        std::fs::canonicalize(&self.app_data_dir)
            .unwrap_or_else(|_| self.app_data_dir.clone())
            .to_string_lossy()
            .to_string()
    }

    fn maybe_backup_core_databases_before_migration(&mut self) -> Result<(), MigrationError> {
        let pending = self.pending_migrations_count()?;
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

        // 执行迁移
        let applied_count = match self.run_refinery_migrations(&mut conn, &id) {
            Ok(count) => count,
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

        // 获取迁移后版本
        let to_version = self.get_current_version(&conn)?;

        // fail-close：迁移后验证失败时立即终止
        if let Err(e) = self.verify_migrations(&conn, &id, migration_set, to_version) {
            self.log_migration_failure(
                &id,
                from_version,
                &e.to_string(),
                start.elapsed().as_millis() as u64,
            );
            return Err(e);
        }

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
    ) -> Result<usize, MigrationError> {
        // 获取迁移前的迁移记录数量
        let before_count = self.get_migration_count(conn)?;

        // 根据数据库 ID 执行对应的迁移
        let runner = match id {
            DatabaseId::Vfs => self.create_vfs_runner()?,
            DatabaseId::ChatV2 => self.create_chat_v2_runner()?,
            DatabaseId::Mistakes => self.create_mistakes_runner()?,
            DatabaseId::LlmUsage => self.create_llm_usage_runner()?,
        };

        // 预修复：对齐已应用迁移的 checksum，避免 Refiner divergent 报错
        self.repair_refinery_checksums(conn, id, &runner)?;

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

        Ok(applied_count)
    }

    #[cfg(not(feature = "data_governance"))]
    fn run_refinery_migrations(
        &self,
        _conn: &mut rusqlite::Connection,
        id: &DatabaseId,
    ) -> Result<usize, MigrationError> {
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
                // 所有非幂等列都已存在 → 该迁移实际已执行，标记完成
                tracing::info!(
                    version = version,
                    columns = ?alter_columns,
                    "🔧 [make_alter_columns_safe] 检测到所有 ALTER 列已存在，标记 V{} 为已完成",
                    version
                );
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
                // 执行迁移中的 CREATE INDEX IF NOT EXISTS / CREATE TABLE IF NOT EXISTS
                // 这些是幂等的，可以安全重跑
                Self::replay_idempotent_statements(conn, sql);
                self.mark_migration_complete(conn, runner, version)?;
            }
            // 如果没有任何列存在，说明迁移从未执行过，正常让 Refinery 执行
        }

        Ok(())
    }

    /// 从迁移 SQL 中解析 ALTER TABLE ... ADD COLUMN 语句
    ///
    /// 返回 `(table_name, column_name)` 列表
    #[cfg(feature = "data_governance")]
    fn parse_alter_add_columns(sql: &str) -> Vec<(String, String)> {
        let mut results = Vec::new();
        // 匹配 ALTER TABLE xxx ADD COLUMN yyy（不区分大小写）
        for line in sql.lines() {
            let trimmed = line.trim();
            let upper = trimmed.to_uppercase();
            if upper.contains("ALTER")
                && upper.contains("TABLE")
                && upper.contains("ADD")
                && upper.contains("COLUMN")
            {
                // 解析: ALTER TABLE <table> ADD COLUMN <column> ...
                let tokens: Vec<&str> = trimmed.split_whitespace().collect();
                // 找到 TABLE 后面的表名和 COLUMN 后面的列名
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
        }
        results
    }

    /// 从 SQL 中提取列定义（ALTER TABLE xxx ADD COLUMN yyy <definition>）
    ///
    /// 返回 COLUMN 名称之后的类型定义部分，如 "TEXT DEFAULT 'pending'"
    #[cfg(feature = "data_governance")]
    fn extract_column_def(sql: &str, target_table: &str, target_column: &str) -> String {
        for line in sql.lines() {
            let trimmed = line.trim().trim_end_matches(';');
            let upper = trimmed.to_uppercase();
            if !upper.contains("ALTER") || !upper.contains("ADD") || !upper.contains("COLUMN") {
                continue;
            }
            // 检查是否匹配目标表和列
            let upper_table = target_table.to_uppercase();
            let upper_column = target_column.to_uppercase();
            if !upper.contains(&upper_table) || !upper.contains(&upper_column) {
                continue;
            }
            // 找到 COLUMN <name> 之后的部分作为类型定义
            let tokens: Vec<&str> = trimmed.split_whitespace().collect();
            for i in 0..tokens.len() {
                if tokens[i].to_uppercase() == "COLUMN" && i + 1 < tokens.len() {
                    let col_name =
                        tokens[i + 1].trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if col_name.to_uppercase() == upper_column {
                        // COLUMN 名之后的所有 token 就是类型定义
                        if i + 2 < tokens.len() {
                            return tokens[i + 2..].join(" ");
                        }
                        return "TEXT".to_string(); // 默认类型
                    }
                }
            }
        }
        "TEXT".to_string() // 兜底默认
    }

    /// 重放迁移 SQL 中的幂等语句（CREATE TABLE/INDEX IF NOT EXISTS）
    ///
    /// 在中间状态修复时调用，确保迁移中的建表/建索引语句也被执行
    #[cfg(feature = "data_governance")]
    fn replay_idempotent_statements(conn: &rusqlite::Connection, sql: &str) {
        for line in sql.lines() {
            let trimmed = line.trim();
            let upper = trimmed.to_uppercase();
            // 只重放幂等的 CREATE 语句
            if upper.starts_with("CREATE TABLE IF NOT EXISTS")
                || upper.starts_with("CREATE INDEX IF NOT EXISTS")
                || upper.starts_with("CREATE UNIQUE INDEX IF NOT EXISTS")
                || upper.starts_with("CREATE TRIGGER IF NOT EXISTS")
            {
                if let Err(e) = conn.execute(trimmed.trim_end_matches(';'), []) {
                    tracing::warn!(
                        sql = trimmed,
                        error = %e,
                        "replay_idempotent_statements: 执行失败（继续）"
                    );
                }
            }
        }
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

                // 安全限制：仅在以下情况修复
                // 1. baseline 对齐（checksum="0"，由 ensure_legacy_baseline 写入）
                // 2. 同名迁移的 checksum 漂移（脚本内容变更但名称一致）
                let is_baseline = db_checksum == "0";
                let is_same_name = db_name == name;

                if !is_baseline && !is_same_name {
                    tracing::warn!(
                        database = id.as_str(),
                        version = version,
                        db_name = %db_name,
                        expected_name = %name,
                        "跳过 checksum 修复：迁移名称不匹配且非 baseline，可能是版本号冲突"
                    );
                    continue;
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
                    if is_baseline {
                        "baseline_alignment"
                    } else {
                        "checksum_drift"
                    },
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
            const TARGET_COLUMN: &str = "active_skill_ids_json";
            const TARGET_TABLE: &str = "chat_v2_session_state";

            if self.table_exists(conn, TARGET_TABLE)?
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

        if !self.table_exists(conn, "chat_v2_sessions")? {
            return Ok(());
        }
        if self.is_migration_recorded(conn, VERSION)? {
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

        if !self.table_exists(conn, "chat_v2_sessions")? {
            return Ok(());
        }
        if self.is_migration_recorded(conn, VERSION)? {
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
        const PREVIEW_VERSION: i32 = 20260207;
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

        if has_mistakes {
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
        if has_mistakes && self.table_exists(conn, PREVIEW_TABLE)? {
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
    ) -> Result<(), MigrationError> {
        // 验证所有已应用的迁移
        // 注意：current_version 是 Refinery 记录的版本（如 20260130）
        for migration in migration_set.migrations.iter() {
            if migration.refinery_version <= current_version as i32 {
                MigrationVerifier::verify(conn, migration)?;
            }
        }

        let allow_rebaseline = migration_set
            .get(current_version as i32)
            .map(|m| m.idempotent)
            .unwrap_or(false);
        self.verify_schema_fingerprint(conn, id, current_version, allow_rebaseline)?;

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
        schema_version: u32,
        allow_rebaseline: bool,
    ) -> Result<(), MigrationError> {
        if schema_version == 0 {
            return Ok(());
        }

        self.ensure_schema_fingerprint_table(conn)?;
        let (current_fingerprint, canonical_schema) = self.compute_schema_fingerprint(conn)?;

        let select_sql = format!(
            "SELECT fingerprint FROM {} WHERE database_id = ?1 AND schema_version = ?2",
            SCHEMA_FINGERPRINT_TABLE
        );
        let existing: Option<String> = conn
            .query_row(
                &select_sql,
                rusqlite::params![id.as_str(), schema_version as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        if let Some(stored) = existing {
            if stored != current_fingerprint {
                if allow_rebaseline {
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
                    current_fingerprint,
                    canonical_schema,
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
                current_fingerprint,
                chrono::Utc::now().to_rfc3339(),
                canonical_schema,
            ],
        )
        .map_err(|e| MigrationError::Database(e.to_string()))?;

        Ok(())
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
    ) -> Result<(String, String), MigrationError> {
        let mut canonical = String::new();

        let tables_sql = format!(
            r#"SELECT name FROM sqlite_master
               WHERE type='table'
                 AND name NOT LIKE 'sqlite_%'
                 AND name != 'refinery_schema_history'
                 AND name != '{}'
               ORDER BY name"#,
            SCHEMA_FINGERPRINT_TABLE
        );

        let mut tables_stmt = conn
            .prepare(&tables_sql)
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        let tables = tables_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        for table in tables {
            let table = table.map_err(|e| MigrationError::Database(e.to_string()))?;
            canonical.push_str("table:");
            canonical.push_str(&table);
            canonical.push('\n');

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
                canonical.push_str(&format!("trg:{}:{}\n", name, sql));
            }
        }

        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        let fingerprint = format!("{:x}", hasher.finalize());

        Ok((fingerprint, canonical))
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
        use crate::data_governance::schema_registry::{get_data_contract_version, DatabaseStatus};

        tracing::info!("📊 [SchemaAggregation] 开始聚合数据库 Schema 状态...");
        let mut registry = SchemaRegistry::new();

        for db_id in DatabaseId::all_ordered() {
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

            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| MigrationError::Database(e.to_string()))?;

            let version = self.get_current_version(&conn)?;
            let migration_set = self.get_migration_set(&db_id);

            // 读取迁移历史（包含 Refinery 记录的 checksum）
            let history = self.read_migration_history(&conn)?;

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
        CHAT_V2_MIGRATION_SET, LLM_USAGE_MIGRATION_SET, VFS_MIGRATION_SET,
    };
    use tempfile::TempDir;

    fn create_test_coordinator() -> (MigrationCoordinator, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None); // 测试时不需要审计日志
        (coordinator, temp_dir)
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
            .verify_migrations(&conn, &DatabaseId::Mistakes, &MISTAKES_MIGRATIONS, 20260130)
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
            .verify_schema_fingerprint(&conn, &DatabaseId::Mistakes, 20260130, false)
            .unwrap();

        // 制造 schema 漂移
        conn.execute("ALTER TABLE anki_cards ADD COLUMN drift_marker INTEGER", [])
            .unwrap();

        // allow_rebaseline=false 时应检测到漂移并报错
        let err = coordinator
            .verify_schema_fingerprint(&conn, &DatabaseId::Mistakes, 20260130, false)
            .unwrap_err();

        match err {
            MigrationError::VerificationFailed { reason, .. } => {
                assert!(reason.contains("Schema fingerprint drift detected"));
            }
            other => panic!("unexpected error: {:?}", other),
        }

        // allow_rebaseline=true 时漂移应被容忍（不报错）
        coordinator
            .verify_schema_fingerprint(&conn, &DatabaseId::Mistakes, 20260130, true)
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
}
