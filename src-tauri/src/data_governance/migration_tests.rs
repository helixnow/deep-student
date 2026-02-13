//! # Migration Integration Tests (迁移集成测试)
//!
//! 数据治理系统的迁移集成测试模块。
//!
//! ## ⚠️ 重复代码注意 (Issue #13)
//!
//! 此文件与 `tests.rs` 存在约 60% 的重叠（辅助函数、基础迁移验证等）。
//! 计划合并方案：
//! - 共享辅助函数提取到 `test_helpers` 子模块
//! - `tests.rs` 保留集成测试（完整初始化流程）
//! - 本文件专注于迁移回归测试（旧库兼容、边界条件）
//!
//! ## 测试覆盖范围
//!
//! 1. 新数据库完整迁移流程（从空数据库到最新版本）
//! 2. MigrationCoordinator::run_all() 执行所有数据库迁移
//! 3. 迁移后验证器是否正确工作
//! 4. 依赖关系检查（Chat V2 依赖 VFS）
//! 5. 审计日志是否正确记录
//!
//! ## 运行方式
//!
//! ```bash
//! # 运行所有迁移测试
//! cargo test --features data_governance migration_tests
//!
//! # 运行特定测试
//! cargo test --features data_governance test_full_migration_from_empty_database
//! ```
//!
//! ## 注意事项
//!
//! - 所有测试使用 tempfile 创建临时目录
//! - 测试完成后自动清理临时文件
//! - 测试需要 `data_governance` feature 启用

#[cfg(test)]
#[cfg(feature = "data_governance")]
mod tests {
    use std::path::PathBuf;

    use rusqlite::Connection;
    use tempfile::TempDir;

    use crate::data_governance::audit::{AuditFilter, AuditRepository, AuditStatus};
    use crate::data_governance::init::{initialize_with_report, needs_initialization};
    use crate::data_governance::migration::{
        DatabaseMigrationReport, MigrationCoordinator, MigrationError, MigrationReport,
        MigrationVerifier, ALL_MIGRATION_SETS, CHAT_V2_MIGRATION_SET, LLM_USAGE_MIGRATION_SET,
        MISTAKES_MIGRATIONS, VFS_MIGRATION_SET,
    };
    use crate::data_governance::schema_registry::{DatabaseId, SchemaRegistry};

    // ============================================================================
    // 常量定义
    // ============================================================================

    /// 迁移数量基线（冻结的已知最小值）
    ///
    /// 新增迁移只会让实际 count **增加**，不应减少。
    /// 如果新增了迁移，请将基线更新为新值。
    /// 如果这些断言失败，说明有迁移被误删。
    const VFS_MIGRATION_BASELINE: usize = 10;
    const CHAT_V2_MIGRATION_BASELINE: usize = 7;
    const MISTAKES_MIGRATION_BASELINE: usize = 6;
    const LLM_USAGE_MIGRATION_BASELINE: usize = 3;

    /// 数据库总数
    const DATABASE_COUNT: usize = 4;

    /// 总迁移数量（从实际迁移集动态计算，用于需要精确匹配的集成测试）
    const TOTAL_MIGRATIONS: usize = VFS_MIGRATION_SET.count()
        + CHAT_V2_MIGRATION_SET.count()
        + MISTAKES_MIGRATIONS.count()
        + LLM_USAGE_MIGRATION_SET.count();

    // ============================================================================
    // 辅助函数
    // ============================================================================

    /// 创建测试用的临时目录
    fn create_test_dir() -> TempDir {
        TempDir::new().expect("Failed to create temp dir")
    }

    /// 创建测试用的迁移协调器（禁用审计日志）
    fn create_test_coordinator(temp_dir: &TempDir) -> MigrationCoordinator {
        MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None)
    }

    /// 创建测试用的迁移协调器（启用审计日志）
    fn create_test_coordinator_with_audit(temp_dir: &TempDir) -> MigrationCoordinator {
        let audit_db_path = temp_dir.path().join("databases").join("audit.db");
        MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(Some(audit_db_path))
    }

    /// 确保测试目录结构存在
    fn setup_test_directories(temp_dir: &TempDir) {
        let databases_dir = temp_dir.path().join("databases");
        std::fs::create_dir_all(&databases_dir).expect("Failed to create databases dir");
    }

    /// 获取数据库文件路径
    fn get_database_path(temp_dir: &TempDir, db_id: &DatabaseId) -> PathBuf {
        match db_id {
            DatabaseId::Vfs => temp_dir.path().join("databases").join("vfs.db"),
            DatabaseId::ChatV2 => temp_dir.path().join("chat_v2.db"),
            DatabaseId::Mistakes => temp_dir.path().join("mistakes.db"),
            DatabaseId::LlmUsage => temp_dir.path().join("llm_usage.db"),
        }
    }

    fn expected_latest_version(db_id: &DatabaseId) -> u32 {
        match db_id {
            DatabaseId::Vfs => VFS_MIGRATION_SET.latest_version() as u32,
            DatabaseId::ChatV2 => CHAT_V2_MIGRATION_SET.latest_version() as u32,
            DatabaseId::Mistakes => MISTAKES_MIGRATIONS.latest_version() as u32,
            DatabaseId::LlmUsage => LLM_USAGE_MIGRATION_SET.latest_version() as u32,
        }
    }
    /// 初始化审计数据库
    fn init_audit_database(temp_dir: &TempDir) -> PathBuf {
        let audit_db_path = temp_dir.path().join("databases").join("audit.db");
        let conn = Connection::open(&audit_db_path).expect("Failed to create audit database");
        AuditRepository::init(&conn).expect("Audit init should succeed");
        audit_db_path
    }

    // ============================================================================
    // 测试组 1: 新数据库完整迁移流程
    // ============================================================================

    /// 测试从空数据库到最新版本的完整迁移流程
    #[test]
    fn test_full_migration_from_empty_database() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 确认初始状态：所有数据库都不存在
        for db_id in DatabaseId::all_ordered() {
            let db_path = get_database_path(&temp_dir, &db_id);
            assert!(
                !db_path.exists(),
                "Database {:?} should not exist before migration",
                db_id
            );
        }

        // 执行完整迁移
        let result = coordinator.run_all();
        assert!(result.is_ok(), "Full migration failed: {:?}", result.err());

        let report = result.unwrap();

        // 验证迁移报告
        assert!(report.success, "Migration should succeed");
        assert_eq!(
            report.databases.len(),
            DATABASE_COUNT,
            "Should have {} database reports",
            DATABASE_COUNT
        );
        assert!(
            report.total_duration_ms > 0,
            "Should have non-zero total duration"
        );

        // 验证每个数据库的迁移都成功且版本正确
        for db_report in &report.databases {
            assert!(
                db_report.success,
                "Database {:?} migration failed",
                db_report.id
            );
            assert_eq!(
                db_report.from_version, 0,
                "Database {:?} should start from version 0",
                db_report.id
            );
            assert!(
                db_report.to_version > 0,
                "Database {:?} should have positive target version",
                db_report.id
            );
            // 验证迁移数量与预期一致
            let expected_count = match db_report.id {
                DatabaseId::Vfs => VFS_MIGRATION_SET.count(),
                DatabaseId::ChatV2 => CHAT_V2_MIGRATION_SET.count(),
                DatabaseId::Mistakes => MISTAKES_MIGRATIONS.count(),
                DatabaseId::LlmUsage => LLM_USAGE_MIGRATION_SET.count(),
            };
            assert_eq!(
                db_report.applied_count, expected_count,
                "Database {:?} should apply {} migrations",
                db_report.id, expected_count
            );
        }

        // 验证所有数据库文件存在
        for db_id in DatabaseId::all_ordered() {
            let db_path = get_database_path(&temp_dir, &db_id);
            assert!(
                db_path.exists(),
                "Database {:?} file should exist after migration",
                db_id
            );
        }
    }

    /// 测试单个 VFS 数据库的完整迁移
    #[test]
    fn test_vfs_database_full_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        let result = coordinator.migrate_single(DatabaseId::Vfs);
        assert!(result.is_ok(), "VFS migration failed: {:?}", result.err());

        let report = result.unwrap();
        assert!(report.success, "VFS migration should succeed");
        assert_eq!(report.id, DatabaseId::Vfs);
        assert_eq!(report.from_version, 0);
        assert_eq!(
            report.to_version,
            VFS_MIGRATION_SET.latest_version() as u32,
            "VFS should migrate to latest version"
        );
        let vfs_count = VFS_MIGRATION_SET.count();
        assert_eq!(
            report.applied_count, vfs_count,
            "VFS should apply {} migrations",
            vfs_count
        );

        // 验证数据库文件
        let vfs_db_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        assert!(vfs_db_path.exists(), "VFS database file should exist");
    }

    /// 测试单个 Chat V2 数据库的完整迁移（含依赖）
    #[test]
    fn test_chat_v2_database_full_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // Chat V2 依赖 VFS，先迁移 VFS
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");

        // 迁移 Chat V2
        let result = coordinator.migrate_single(DatabaseId::ChatV2);
        assert!(
            result.is_ok(),
            "Chat V2 migration failed: {:?}",
            result.err()
        );

        let report = result.unwrap();
        assert!(report.success, "Chat V2 migration should succeed");
        assert_eq!(report.id, DatabaseId::ChatV2);
        assert_eq!(
            report.to_version,
            CHAT_V2_MIGRATION_SET.latest_version() as u32,
            "Chat V2 should migrate to latest version"
        );
    }

    /// 测试单个 LLM Usage 数据库的完整迁移（无依赖）
    #[test]
    fn test_llm_usage_database_full_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // LLM Usage 无依赖，直接迁移
        let result = coordinator.migrate_single(DatabaseId::LlmUsage);
        assert!(
            result.is_ok(),
            "LLM Usage migration failed: {:?}",
            result.err()
        );

        let report = result.unwrap();
        assert!(report.success, "LLM Usage migration should succeed");
        assert_eq!(report.id, DatabaseId::LlmUsage);
        assert_eq!(
            report.to_version, 20260201,
            "LLM Usage should migrate to version 20260201"
        );
    }

    /// 测试单个 Mistakes 数据库的完整迁移
    #[test]
    fn test_mistakes_database_full_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // Mistakes 依赖 VFS，先迁移 VFS
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");

        // 迁移 Mistakes
        let result = coordinator.migrate_single(DatabaseId::Mistakes);
        assert!(
            result.is_ok(),
            "Mistakes migration failed: {:?}",
            result.err()
        );

        let report = result.unwrap();
        assert!(report.success, "Mistakes migration should succeed");
        assert_eq!(report.id, DatabaseId::Mistakes);
        assert_eq!(
            report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32,
            "Mistakes should migrate to latest version"
        );

        // 验证数据库文件在正确位置
        let mistakes_db_path = get_database_path(&temp_dir, &DatabaseId::Mistakes);
        assert!(
            mistakes_db_path.exists(),
            "Mistakes database file should exist"
        );
    }

    // ============================================================================
    // 测试组 2: MigrationCoordinator::run_all() 测试
    // ============================================================================

    /// 测试 run_all() 按正确顺序执行迁移
    #[test]
    fn test_run_all_executes_in_correct_order() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        let result = coordinator.run_all();
        assert!(result.is_ok(), "run_all should succeed");

        let report = result.unwrap();

        // 获取迁移顺序
        let vfs_idx = report
            .databases
            .iter()
            .position(|r| r.id == DatabaseId::Vfs);
        let llm_idx = report
            .databases
            .iter()
            .position(|r| r.id == DatabaseId::LlmUsage);
        let chat_idx = report
            .databases
            .iter()
            .position(|r| r.id == DatabaseId::ChatV2);
        let mistakes_idx = report
            .databases
            .iter()
            .position(|r| r.id == DatabaseId::Mistakes);

        // 验证顺序：VFS 和 LlmUsage 应该在 ChatV2 和 Mistakes 之前
        if let (Some(vfs), Some(chat)) = (vfs_idx, chat_idx) {
            assert!(vfs < chat, "VFS should be migrated before ChatV2");
        }
        if let (Some(vfs), Some(mistakes)) = (vfs_idx, mistakes_idx) {
            assert!(vfs < mistakes, "VFS should be migrated before Mistakes");
        }
    }

    /// 测试 run_all() 的幂等性（重复执行）
    #[test]
    fn test_run_all_idempotency() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 第一次迁移
        let result1 = coordinator.run_all();
        assert!(result1.is_ok(), "First migration should succeed");
        let report1 = result1.unwrap();
        assert!(report1.success);

        // 计算第一次应用的迁移总数
        let first_applied: usize = report1.databases.iter().map(|r| r.applied_count).sum();
        assert_eq!(
            first_applied, TOTAL_MIGRATIONS,
            "First run should apply {} migrations",
            TOTAL_MIGRATIONS
        );

        // 第二次迁移（幂等性检验）
        let result2 = coordinator.run_all();
        assert!(
            result2.is_ok(),
            "Second migration should succeed (idempotent)"
        );
        let report2 = result2.unwrap();
        assert!(report2.success);

        // 第二次不应该应用任何新迁移
        let second_applied: usize = report2.databases.iter().map(|r| r.applied_count).sum();
        assert_eq!(
            second_applied, 0,
            "Second run should not apply any migrations"
        );
    }

    /// 测试 run_all() 在依赖失败时停止
    #[test]
    fn test_run_all_stops_on_dependency_failure() {
        // 这个测试验证当依赖数据库迁移失败时，后续迁移不会执行
        // 由于正常情况下迁移不会失败，这里只验证依赖检查逻辑
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let coordinator = create_test_coordinator(&temp_dir);

        let mut report = MigrationReport::default();

        // 添加一个失败的 VFS 报告
        report.add(DatabaseMigrationReport {
            id: DatabaseId::Vfs,
            from_version: 0,
            to_version: 0,
            applied_count: 0,
            success: false,
            duration_ms: 50,
            error: Some("Test error".to_string()),
        });

        // 检查 ChatV2 的依赖（应该失败）
        let result = coordinator.check_dependencies(&DatabaseId::ChatV2, &report);
        assert!(result.is_err(), "Should fail when VFS migration failed");

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

    /// 测试待迁移数量计算
    #[test]
    fn test_pending_migrations_count() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let coordinator = create_test_coordinator(&temp_dir);

        // 新数据库应该有 TOTAL_MIGRATIONS 个待执行迁移
        let count = coordinator
            .pending_migrations_count()
            .expect("Count should succeed");
        assert_eq!(
            count, TOTAL_MIGRATIONS,
            "Should have {} pending migrations",
            TOTAL_MIGRATIONS
        );
    }

    /// 测试迁移后待迁移数量为零
    #[test]
    fn test_pending_migrations_zero_after_run() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 执行迁移
        coordinator.run_all().expect("Migration should succeed");

        // 迁移后应该没有待执行迁移
        let count = coordinator
            .pending_migrations_count()
            .expect("Count should succeed");
        assert_eq!(count, 0, "Should have no pending migrations after run_all");
    }

    // ============================================================================
    // 测试组 3: 迁移验证器测试
    // ============================================================================

    /// 测试 VFS 表验证
    #[test]
    fn test_vfs_tables_verified_after_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");

        let vfs_db_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_db_path).expect("Failed to open VFS database");

        // 验证核心表存在
        let core_tables = [
            "resources",
            "notes",
            "files",
            "questions",
            "folders",
            "__change_log",
        ];

        for table in core_tables {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
                    [table],
                    |row| row.get(0),
                )
                .expect("Failed to check table existence");

            assert!(exists, "Table '{}' should exist after VFS migration", table);
        }
    }

    /// 测试 VFS 索引验证
    #[test]
    fn test_vfs_indexes_verified_after_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");

        let vfs_db_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_db_path).expect("Failed to open VFS database");

        // 验证核心索引存在
        let core_indexes = [
            "idx_resources_hash",
            "idx_resources_type",
            "idx_notes_resource",
            "idx_questions_exam_id",
        ];

        for index in core_indexes {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?)",
                    [index],
                    |row| row.get(0),
                )
                .expect("Failed to check index existence");

            assert!(exists, "Index '{}' should exist after VFS migration", index);
        }
    }

    /// 测试 Chat V2 表和列验证
    #[test]
    fn test_chat_v2_schema_verified_after_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 先迁移依赖
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("Chat V2 migration failed");

        let chat_db_path = get_database_path(&temp_dir, &DatabaseId::ChatV2);
        let conn = Connection::open(&chat_db_path).expect("Failed to open Chat V2 database");

        // 验证核心表
        let core_tables = [
            "chat_v2_sessions",
            "chat_v2_messages",
            "chat_v2_blocks",
            "__change_log",
        ];

        for table in core_tables {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
                    [table],
                    |row| row.get(0),
                )
                .expect("Failed to check table existence");

            assert!(
                exists,
                "Table '{}' should exist after Chat V2 migration",
                table
            );
        }

        // 验证 chat_v2_sessions 表的关键列
        let mut stmt = conn
            .prepare("PRAGMA table_info(chat_v2_sessions)")
            .expect("Failed to prepare PRAGMA");
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query columns")
            .filter_map(|r| r.ok())
            .collect();

        let expected_columns = ["id", "mode", "persist_status", "workspace_id"];
        for col in expected_columns {
            assert!(
                columns.contains(&col.to_string()),
                "Column '{}' should exist in chat_v2_sessions",
                col
            );
        }
    }

    /// 测试验证器检测缺失表
    #[test]
    fn test_verifier_detects_missing_table() {
        let temp_dir = create_test_dir();
        let db_path = temp_dir.path().join("test.db");
        let conn = Connection::open(&db_path).expect("Failed to create test database");

        conn.execute("CREATE TABLE resources (id TEXT PRIMARY KEY)", [])
            .expect("Failed to create table");

        let migration =
            crate::data_governance::migration::definitions::MigrationDef::new(1, "test", "")
                .with_expected_tables(&["resources", "nonexistent_table"]);

        let result = MigrationVerifier::verify(&conn, &migration);
        assert!(
            result.is_err(),
            "Verification should fail for missing table"
        );

        if let Err(MigrationError::VerificationFailed { version: _, reason }) = result {
            assert!(
                reason.contains("nonexistent_table"),
                "Error should mention missing table name"
            );
        } else {
            panic!("Expected VerificationFailed error");
        }
    }

    /// 测试验证器检测缺失列
    #[test]
    fn test_verifier_detects_missing_column() {
        let temp_dir = create_test_dir();
        let db_path = temp_dir.path().join("test.db");
        let conn = Connection::open(&db_path).expect("Failed to create test database");

        conn.execute("CREATE TABLE test_table (id TEXT PRIMARY KEY)", [])
            .expect("Failed to create table");

        let migration =
            crate::data_governance::migration::definitions::MigrationDef::new(1, "test", "")
                .with_expected_columns(&[("test_table", "id"), ("test_table", "missing_column")]);

        let result = MigrationVerifier::verify(&conn, &migration);
        assert!(
            result.is_err(),
            "Verification should fail for missing column"
        );

        if let Err(MigrationError::VerificationFailed { version: _, reason }) = result {
            assert!(
                reason.contains("missing_column"),
                "Error should mention missing column name"
            );
        } else {
            panic!("Expected VerificationFailed error");
        }
    }

    /// 测试验证器检测缺失索引
    #[test]
    fn test_verifier_detects_missing_index() {
        let temp_dir = create_test_dir();
        let db_path = temp_dir.path().join("test.db");
        let conn = Connection::open(&db_path).expect("Failed to create test database");

        conn.execute(
            "CREATE TABLE test_table (id TEXT PRIMARY KEY, name TEXT)",
            [],
        )
        .expect("Failed to create table");

        let migration =
            crate::data_governance::migration::definitions::MigrationDef::new(1, "test", "")
                .with_expected_indexes(&["idx_test_name"]);

        let result = MigrationVerifier::verify(&conn, &migration);
        assert!(
            result.is_err(),
            "Verification should fail for missing index"
        );

        if let Err(MigrationError::VerificationFailed { version: _, reason }) = result {
            assert!(
                reason.contains("idx_test_name"),
                "Error should mention missing index name"
            );
        } else {
            panic!("Expected VerificationFailed error");
        }
    }

    // ============================================================================
    // 测试组 4: 依赖关系检查测试
    // ============================================================================

    /// 测试 DatabaseId 依赖关系定义
    #[test]
    fn test_database_dependencies_definition() {
        // VFS 无依赖
        assert!(
            DatabaseId::Vfs.dependencies().is_empty(),
            "VFS should have no dependencies"
        );

        // LLM Usage 无依赖
        assert!(
            DatabaseId::LlmUsage.dependencies().is_empty(),
            "LLM Usage should have no dependencies"
        );

        // Chat V2 依赖 VFS
        assert_eq!(
            DatabaseId::ChatV2.dependencies(),
            &[DatabaseId::Vfs],
            "Chat V2 should depend on VFS"
        );

        // Mistakes 依赖 VFS
        assert_eq!(
            DatabaseId::Mistakes.dependencies(),
            &[DatabaseId::Vfs],
            "Mistakes should depend on VFS"
        );
    }

    /// 测试数据库排序顺序满足依赖
    #[test]
    fn test_database_ordering_satisfies_dependencies() {
        let ordered = DatabaseId::all_ordered();

        assert_eq!(
            ordered.len(),
            DATABASE_COUNT,
            "Should have {} databases",
            DATABASE_COUNT
        );

        // 获取各数据库的位置
        let vfs_pos = ordered
            .iter()
            .position(|id| *id == DatabaseId::Vfs)
            .unwrap();
        let chat_pos = ordered
            .iter()
            .position(|id| *id == DatabaseId::ChatV2)
            .unwrap();
        let mistakes_pos = ordered
            .iter()
            .position(|id| *id == DatabaseId::Mistakes)
            .unwrap();

        // VFS 必须在 ChatV2 和 Mistakes 之前
        assert!(vfs_pos < chat_pos, "VFS should come before ChatV2");
        assert!(vfs_pos < mistakes_pos, "VFS should come before Mistakes");
    }

    /// 测试依赖未满足时的错误
    #[test]
    fn test_dependency_not_satisfied_error() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let coordinator = create_test_coordinator(&temp_dir);

        // 创建空的迁移报告（VFS 未迁移）
        let report = MigrationReport::default();

        // 检查 ChatV2 的依赖（应该失败）
        let result = coordinator.check_dependencies(&DatabaseId::ChatV2, &report);

        assert!(result.is_err(), "Should fail when dependency not satisfied");

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

    /// 测试依赖已满足时成功
    #[test]
    fn test_dependency_satisfied_success() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let coordinator = create_test_coordinator(&temp_dir);

        // 创建包含成功 VFS 迁移的报告
        let mut report = MigrationReport::default();
        report.add(DatabaseMigrationReport {
            id: DatabaseId::Vfs,
            from_version: 0,
            to_version: 20260203,
            applied_count: VFS_MIGRATION_SET.count(),
            success: true,
            duration_ms: 100,
            error: None,
        });

        // 检查 ChatV2 的依赖（应该成功）
        let result = coordinator.check_dependencies(&DatabaseId::ChatV2, &report);
        assert!(
            result.is_ok(),
            "Should succeed when dependency is satisfied"
        );
    }

    /// 测试完整依赖链迁移
    #[test]
    fn test_full_dependency_chain_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        let result = coordinator.run_all();
        assert!(result.is_ok(), "run_all should succeed");

        let report = result.unwrap();

        // 所有数据库都应该成功迁移
        for db_report in &report.databases {
            assert!(
                db_report.success,
                "Database {:?} should succeed",
                db_report.id
            );
        }
    }

    // ============================================================================
    // 测试组 5: 审计日志测试
    // ============================================================================

    /// 测试审计日志表初始化
    #[test]
    fn test_audit_log_table_initialization() {
        let temp_dir = create_test_dir();
        let audit_db_path = temp_dir.path().join("audit.db");

        let conn = Connection::open(&audit_db_path).expect("Failed to create audit database");

        let result = AuditRepository::init(&conn);
        assert!(result.is_ok(), "Audit init should succeed");

        // 验证表存在
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__audit_log')",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check table");

        assert!(exists, "Audit log table should exist");

        // 验证索引存在
        let idx_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_audit_log_timestamp')",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check index");

        assert!(idx_exists, "Audit log timestamp index should exist");
    }

    /// 测试审计日志记录迁移完成
    #[test]
    fn test_audit_log_records_migration_complete() {
        let temp_dir = create_test_dir();
        let audit_db_path = temp_dir.path().join("audit.db");

        let conn = Connection::open(&audit_db_path).expect("Failed to create audit database");
        AuditRepository::init(&conn).expect("Audit init should succeed");

        // 记录迁移完成
        let result = AuditRepository::log_migration_complete(&conn, "vfs", 0, 20260201, 3, 150);

        assert!(result.is_ok(), "Should record migration");

        // 查询审计日志
        let logs = AuditRepository::query(
            &conn,
            AuditFilter {
                operation_type: Some("Migration".to_string()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .expect("Query should succeed");

        assert_eq!(logs.len(), 1, "Should have one migration log");
        assert!(matches!(logs[0].status, AuditStatus::Completed));
    }

    /// 测试审计日志记录迁移失败
    #[test]
    fn test_audit_log_records_migration_failed() {
        let temp_dir = create_test_dir();
        let audit_db_path = temp_dir.path().join("audit.db");

        let conn = Connection::open(&audit_db_path).expect("Failed to create audit database");
        AuditRepository::init(&conn).expect("Audit init should succeed");

        // 记录迁移失败
        let result =
            AuditRepository::log_migration_failed(&conn, "vfs", 0, 20260130, "Test failure");

        assert!(result.is_ok(), "Should record migration failure");

        // 查询审计日志
        let logs = AuditRepository::query(
            &conn,
            AuditFilter {
                operation_type: Some("Migration".to_string()),
                status: Some(AuditStatus::Failed),
                limit: Some(10),
                ..Default::default()
            },
        )
        .expect("Query should succeed");

        assert_eq!(logs.len(), 1, "Should have one failed migration log");
        assert!(logs[0]
            .error_message
            .as_ref()
            .unwrap()
            .contains("Test failure"));
    }

    /// 测试带审计日志的完整迁移
    #[test]
    fn test_migration_with_audit_logging() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);

        // 初始化审计数据库
        let audit_db_path = init_audit_database(&temp_dir);

        // 创建带审计的协调器
        let mut coordinator = create_test_coordinator_with_audit(&temp_dir);

        // 执行迁移
        coordinator.run_all().expect("Migration should succeed");

        // 验证审计日志
        let audit_conn = Connection::open(&audit_db_path).expect("Failed to open audit database");

        let count =
            AuditRepository::count_by_type(&audit_conn, "Migration").expect("Count should succeed");

        assert!(
            count >= DATABASE_COUNT as u64,
            "Should have at least {} migration audit logs (one per database)",
            DATABASE_COUNT
        );
    }

    /// 测试审计日志查询过滤
    #[test]
    fn test_audit_log_query_filtering() {
        let temp_dir = create_test_dir();
        let audit_db_path = temp_dir.path().join("audit.db");

        let conn = Connection::open(&audit_db_path).expect("Failed to create audit database");
        AuditRepository::init(&conn).expect("Audit init should succeed");

        // 记录多条日志
        AuditRepository::log_migration_complete(&conn, "vfs", 0, 20260130, 1, 100).unwrap();
        AuditRepository::log_migration_complete(&conn, "chat_v2", 0, 20260130, 1, 150).unwrap();
        AuditRepository::log_migration_failed(&conn, "mistakes", 0, 20260130, "Error").unwrap();

        // 查询所有迁移日志
        let all_logs = AuditRepository::query(
            &conn,
            AuditFilter {
                operation_type: Some("Migration".to_string()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .expect("Query should succeed");
        assert_eq!(all_logs.len(), 3, "Should have 3 migration logs");

        // 查询成功的迁移日志
        let completed_logs = AuditRepository::query(
            &conn,
            AuditFilter {
                operation_type: Some("Migration".to_string()),
                status: Some(AuditStatus::Completed),
                limit: Some(10),
                ..Default::default()
            },
        )
        .expect("Query should succeed");
        assert_eq!(completed_logs.len(), 2, "Should have 2 completed logs");

        // 查询失败的迁移日志
        let failed_logs = AuditRepository::query(
            &conn,
            AuditFilter {
                operation_type: Some("Migration".to_string()),
                status: Some(AuditStatus::Failed),
                limit: Some(10),
                ..Default::default()
            },
        )
        .expect("Query should succeed");
        assert_eq!(failed_logs.len(), 1, "Should have 1 failed log");
    }

    // ============================================================================
    // 测试组 6: Schema Registry 集成测试
    // ============================================================================

    /// 测试迁移后的 Schema Registry 聚合
    #[test]
    fn test_schema_registry_aggregation_after_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator.run_all().expect("Migration should succeed");

        let registry = coordinator
            .aggregate_schema_registry()
            .expect("Schema aggregation should succeed");

        // 验证注册表内容
        assert_eq!(
            registry.databases.len(),
            DATABASE_COUNT,
            "Should have {} databases in registry",
            DATABASE_COUNT
        );
        assert!(
            registry.global_version > 0,
            "Global version should be positive"
        );

        // 验证每个数据库状态
        for db_id in DatabaseId::all_ordered() {
            let status = registry.get_status(&db_id);
            assert!(status.is_some(), "Status for {:?} should exist", db_id);

            let status = status.unwrap();
            assert!(
                status.schema_version > 0,
                "Schema version for {:?} should be positive",
                db_id
            );
            let expected_version = match db_id {
                DatabaseId::Vfs => VFS_MIGRATION_SET.latest_version() as u32,
                DatabaseId::ChatV2 => CHAT_V2_MIGRATION_SET.latest_version() as u32,
                DatabaseId::Mistakes => MISTAKES_MIGRATIONS.latest_version() as u32,
                DatabaseId::LlmUsage => LLM_USAGE_MIGRATION_SET.latest_version() as u32,
            };
            assert_eq!(
                status.schema_version, expected_version,
                "Schema version for {:?} should match latest migration set",
                db_id
            );
        }
    }

    /// 测试 Schema Registry 依赖检查通过
    #[test]
    fn test_schema_registry_dependency_check_passes() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator.run_all().expect("Migration should succeed");

        let registry = coordinator
            .aggregate_schema_registry()
            .expect("Schema aggregation should succeed");

        let result = registry.check_dependencies();
        assert!(
            result.is_ok(),
            "Dependency check should pass: {:?}",
            result.err()
        );
    }

    /// 测试 needs_migration 检查
    #[test]
    fn test_needs_migration_check() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let coordinator = create_test_coordinator(&temp_dir);

        // 新数据库应该需要迁移
        for db_id in DatabaseId::all_ordered() {
            let needs = coordinator
                .needs_migration(&db_id)
                .expect("needs_migration check should succeed");
            assert!(needs, "New database {:?} should need migration", db_id);
        }
    }

    /// 测试迁移后不需要再次迁移
    #[test]
    fn test_no_migration_needed_after_run() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator.run_all().expect("Migration should succeed");

        // 迁移后不应该需要再次迁移
        for db_id in DatabaseId::all_ordered() {
            let needs = coordinator
                .needs_migration(&db_id)
                .expect("needs_migration check should succeed");
            assert!(
                !needs,
                "Database {:?} should not need migration after run_all",
                db_id
            );
        }
    }

    // ============================================================================
    // 测试组 7: 初始化流程集成测试
    // ============================================================================

    /// 测试 needs_initialization 函数
    #[test]
    fn test_needs_initialization_new_app() {
        let temp_dir = create_test_dir();

        let needs =
            needs_initialization(temp_dir.path()).expect("needs_initialization should succeed");
        assert!(needs, "New app should need initialization");
    }

    /// 测试完整初始化流程
    #[test]
    fn test_complete_initialization_flow() {
        let temp_dir = create_test_dir();

        let result = initialize_with_report(temp_dir.path());
        assert!(
            result.is_ok(),
            "Initialization should succeed: {:?}",
            result.err()
        );

        let init_result = result.unwrap();

        // 验证报告
        assert!(
            init_result.report.migrations_success,
            "Migrations should succeed"
        );
        assert_eq!(
            init_result.report.migrations_applied, TOTAL_MIGRATIONS,
            "Should apply {} migrations",
            TOTAL_MIGRATIONS
        );
        assert!(
            init_result.report.total_duration_ms > 0,
            "Should have positive duration"
        );

        // 验证 Registry
        assert!(
            !init_result.registry.databases.is_empty(),
            "Registry should have databases"
        );
        assert!(
            init_result.registry.global_version > 0,
            "Global version should be positive"
        );
    }

    /// 测试初始化后不需要再次初始化
    #[test]
    fn test_no_initialization_needed_after_init() {
        let temp_dir = create_test_dir();

        initialize_with_report(temp_dir.path()).expect("First initialization should succeed");

        let needs =
            needs_initialization(temp_dir.path()).expect("needs_initialization should succeed");

        assert!(!needs, "Should not need initialization after init");
    }

    // ============================================================================
    // 测试组 8: 迁移集合元数据测试
    // ============================================================================

    /// 测试所有迁移集合数量
    #[test]
    fn test_all_migration_sets_count() {
        assert_eq!(
            ALL_MIGRATION_SETS.len(),
            DATABASE_COUNT,
            "Should have {} migration sets",
            DATABASE_COUNT
        );
    }

    /// 测试各数据库迁移集合属性
    #[test]
    fn test_migration_set_properties() {
        // 基线守卫：实际迁移数量必须 >= 已知基线，防止迁移被误删
        // 如果新增了迁移，这些断言自动通过；如果迁移被删除，会立即告警
        assert_eq!(VFS_MIGRATION_SET.database_name, "vfs");
        assert!(
            VFS_MIGRATION_SET.count() >= VFS_MIGRATION_BASELINE,
            "VFS has {} migrations, expected >= {} (baseline). Was a migration deleted?",
            VFS_MIGRATION_SET.count(),
            VFS_MIGRATION_BASELINE
        );

        assert_eq!(CHAT_V2_MIGRATION_SET.database_name, "chat_v2");
        assert!(
            CHAT_V2_MIGRATION_SET.count() >= CHAT_V2_MIGRATION_BASELINE,
            "ChatV2 has {} migrations, expected >= {} (baseline). Was a migration deleted?",
            CHAT_V2_MIGRATION_SET.count(),
            CHAT_V2_MIGRATION_BASELINE
        );

        assert_eq!(MISTAKES_MIGRATIONS.database_name, "mistakes");
        assert!(
            MISTAKES_MIGRATIONS.count() >= MISTAKES_MIGRATION_BASELINE,
            "Mistakes has {} migrations, expected >= {} (baseline). Was a migration deleted?",
            MISTAKES_MIGRATIONS.count(),
            MISTAKES_MIGRATION_BASELINE
        );

        assert_eq!(LLM_USAGE_MIGRATION_SET.database_name, "llm_usage");
        assert!(
            LLM_USAGE_MIGRATION_SET.count() >= LLM_USAGE_MIGRATION_BASELINE,
            "LlmUsage has {} migrations, expected >= {} (baseline). Was a migration deleted?",
            LLM_USAGE_MIGRATION_SET.count(),
            LLM_USAGE_MIGRATION_BASELINE
        );
    }

    /// 测试迁移版本顺序
    #[test]
    fn test_migration_versions_ordered() {
        for set in ALL_MIGRATION_SETS {
            let mut prev_version = 0;
            for migration in set.migrations {
                assert!(
                    migration.refinery_version > prev_version,
                    "Migration versions should be strictly increasing in {}",
                    set.database_name
                );
                prev_version = migration.refinery_version;
            }
        }
    }

    #[test]
    fn test_mistakes_legacy_sparse_schema_recovers_to_latest() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = Connection::open(&db_path).expect("Failed to create sparse mistakes db");

        // 稀疏旧表：必须包含 V20260208 索引所依赖的列
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
        .expect("Failed to build sparse mistakes schema");
        drop(conn);

        let report = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("Sparse legacy mistakes schema should recover");

        assert!(report.success);
        assert_eq!(
            report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );

        let verify_conn = Connection::open(&db_path).expect("Failed to reopen mistakes db");
        let has_review_sessions: bool = verify_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_sessions')",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check review_sessions");
        assert!(has_review_sessions);

        let has_text: bool = verify_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('anki_cards') WHERE name='text')",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check anki_cards.text");
        assert!(has_text);
    }

    #[test]
    fn test_mistakes_legacy_recovery_is_reentrant_across_restart() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let db_path = temp_dir.path().join("mistakes.db");

        {
            let conn = Connection::open(&db_path).expect("Failed to create sparse mistakes db");
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
                    template_id TEXT
                );
                ",
            )
            .expect("Failed to initialize sparse legacy schema");
        }

        let mut first_boot = create_test_coordinator(&temp_dir);
        let first_report = first_boot
            .migrate_single(DatabaseId::Mistakes)
            .expect("first migration should succeed");
        assert!(first_report.success);

        let mut second_boot = create_test_coordinator(&temp_dir);
        let second_report = second_boot
            .migrate_single(DatabaseId::Mistakes)
            .expect("second migration should stay healthy");

        assert!(second_report.success);
        assert_eq!(second_report.applied_count, 0);
        assert_eq!(
            second_report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );
    }

    #[test]
    fn test_mistakes_schema_fingerprint_drift_fails_close() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);
        let db_path = temp_dir.path().join("mistakes.db");

        coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("Initial migration should succeed");

        let conn = Connection::open(&db_path).expect("Failed to open mistakes db");
        conn.execute("ALTER TABLE anki_cards ADD COLUMN drift_col TEXT", [])
            .expect("Failed to introduce schema drift");
        drop(conn);

        let err = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect_err("drifted schema must fail-close");

        match err {
            MigrationError::VerificationFailed { reason, .. } => {
                assert!(reason.contains("Schema fingerprint drift detected"));
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_mistakes_missing_index_is_self_healed() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);
        let db_path = temp_dir.path().join("mistakes.db");

        coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("Initial migration should succeed");

        let conn = Connection::open(&db_path).expect("Failed to open mistakes db");
        conn.execute("DROP INDEX IF EXISTS idx_anki_cards_text", [])
            .expect("Failed to remove index");
        drop(conn);

        let report = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("compat repair should recreate required index");
        assert!(report.success);

        let verify_conn = Connection::open(&db_path).expect("Failed to reopen mistakes db");
        let has_index: bool = verify_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_anki_cards_text')",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check repaired index");
        assert!(
            has_index,
            "idx_anki_cards_text should be recreated by compat repair"
        );
    }

    #[test]
    fn test_mistakes_preview_column_legacy_state_is_marked_without_duplicate_failure() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);
        let db_path = temp_dir.path().join("mistakes.db");
        let conn = Connection::open(&db_path).expect("Failed to open mistakes db");

        conn.execute_batch(include_str!(
            "../../migrations/mistakes/V20260130__init.sql"
        ))
        .expect("Failed to apply init schema");
        conn.execute_batch(include_str!(
            "../../migrations/mistakes/V20260131__add_change_log.sql"
        ))
        .expect("Failed to apply change log schema");
        conn.execute_batch(include_str!(
            "../../migrations/mistakes/V20260201__add_sync_fields.sql"
        ))
        .expect("Failed to apply sync fields schema");

        conn.execute(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT)",
            [],
        )
        .expect("Failed to create refinery history table");

        conn.execute(
            "INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260130, 'init', '2026-02-07T00:00:00Z', '0')",
            [],
        )
        .expect("Failed to insert 20260130 history");
        conn.execute(
            "INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260131, 'add_change_log', '2026-02-07T00:00:00Z', '0')",
            [],
        )
        .expect("Failed to insert 20260131 history");
        conn.execute(
            "INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260201, 'add_sync_fields', '2026-02-07T00:00:00Z', '0')",
            [],
        )
        .expect("Failed to insert 20260201 history");

        drop(conn);

        let report = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("preview column pre-exists: migration should converge");
        assert!(report.success);
        assert_eq!(
            report.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32
        );

        let verify_conn = Connection::open(&db_path).expect("Failed to reopen mistakes db");
        let history_count: i64 = verify_conn
            .query_row(
                "SELECT COUNT(*) FROM refinery_schema_history WHERE version = 20260207",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query 20260207 history");
        assert_eq!(history_count, 1, "20260207 should be marked exactly once");
    }

    #[test]
    fn test_run_all_recovers_after_chat_v2_lock_failure() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        let chat_db_path = get_database_path(&temp_dir, &DatabaseId::ChatV2);
        let lock_conn = Connection::open(&chat_db_path).expect("Failed to create lock db");
        lock_conn
            .execute_batch("BEGIN EXCLUSIVE;")
            .expect("Failed to acquire exclusive lock");

        let first_err = coordinator
            .run_all()
            .expect_err("run_all should fail while chat_v2 is locked");
        let err_msg = format!("{:?}", first_err);
        assert!(
            err_msg.contains("locked") || err_msg.contains("busy"),
            "Expected lock/busy error, got: {}",
            err_msg
        );

        let vfs_db_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let vfs_conn = Connection::open(&vfs_db_path).expect("Failed to open vfs db");
        let vfs_version = coordinator
            .get_current_version(&vfs_conn)
            .expect("Failed to read VFS version");
        assert_eq!(
            vfs_version,
            expected_latest_version(&DatabaseId::Vfs),
            "VFS should already be migrated before chat_v2 lock failure"
        );

        lock_conn
            .execute_batch("ROLLBACK;")
            .expect("Failed to release exclusive lock");
        drop(lock_conn);

        let retry = coordinator
            .run_all()
            .expect("run_all should recover after lock release");
        assert!(retry.success);

        for report in retry.databases {
            assert_eq!(
                report.to_version,
                expected_latest_version(&report.id),
                "Database {:?} should converge to latest version on retry",
                report.id
            );
        }
    }

    #[test]
    fn test_mistakes_sparse_schema_with_inflated_history_converges() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);
        let db_path = get_database_path(&temp_dir, &DatabaseId::Mistakes);
        let conn = Connection::open(&db_path).expect("Failed to create sparse mistakes db");

        conn.execute_batch(
            "
            CREATE TABLE migration_progress (category TEXT PRIMARY KEY, status TEXT NOT NULL);
            CREATE TABLE mistakes (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                status TEXT NOT NULL,
                question_images TEXT NOT NULL
            );
            CREATE TABLE refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            );
            INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
            VALUES (20260207, 'add_template_preview_data', '2026-02-07T00:00:00Z', '0');
            ",
        )
        .expect("Failed to prepare sparse schema with inflated history");
        drop(conn);

        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS dependency migration should succeed");

        let report = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("Sparse schema with inflated history should recover");
        assert!(report.success);
        assert_eq!(
            report.to_version,
            expected_latest_version(&DatabaseId::Mistakes)
        );

        let verify_conn = Connection::open(&db_path).expect("Failed to reopen mistakes db");
        let has_review_sessions: bool = verify_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_sessions')",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check review_sessions");
        assert!(has_review_sessions, "review_sessions should be repaired");

        let has_text_column: bool = verify_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('anki_cards') WHERE name='text')",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check anki_cards.text");
        assert!(has_text_column, "anki_cards.text should be repaired");
    }

    #[test]
    fn test_mistakes_migrate_recovers_after_lock_release() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS dependency migration should succeed");

        let mistakes_db_path = get_database_path(&temp_dir, &DatabaseId::Mistakes);
        let lock_conn = Connection::open(&mistakes_db_path).expect("Failed to open mistakes db");
        lock_conn
            .execute_batch("BEGIN EXCLUSIVE;")
            .expect("Failed to acquire mistakes db lock");

        let first_err = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect_err("migration should fail while mistakes db is locked");
        let err_msg = format!("{:?}", first_err);
        assert!(
            err_msg.contains("locked") || err_msg.contains("busy"),
            "Expected lock/busy error, got: {}",
            err_msg
        );

        lock_conn
            .execute_batch("ROLLBACK;")
            .expect("Failed to release mistakes db lock");
        drop(lock_conn);

        let retry = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("migration should recover after lock release");
        assert!(retry.success);
        assert_eq!(
            retry.to_version,
            expected_latest_version(&DatabaseId::Mistakes),
            "mistakes migration should converge after retry"
        );
    }

    #[test]
    fn test_vfs_malformed_history_record_is_cleaned_on_retry() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("Initial VFS migration should succeed");

        let vfs_db_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_db_path).expect("Failed to open vfs db");
        conn.execute(
            "INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (0, 'broken', '2026-02-07T00:00:00Z', '')",
            [],
        )
        .expect("Failed to insert malformed history row");
        drop(conn);

        let retry = coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("Migration retry should clean malformed history rows");
        assert!(retry.success);

        let verify_conn = Connection::open(&vfs_db_path).expect("Failed to reopen vfs db");
        let malformed_count: i64 = verify_conn
            .query_row(
                "SELECT COUNT(*) FROM refinery_schema_history WHERE version = 0",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query malformed history rows");
        assert_eq!(
            malformed_count, 0,
            "Malformed history rows should be deleted"
        );
    }
    /// 测试获取当前版本（新数据库）
    #[test]
    fn test_get_current_version_new_database() {
        let temp_dir = create_test_dir();
        let db_path = temp_dir.path().join("test.db");
        let conn = Connection::open(&db_path).expect("Failed to create database");

        let coordinator = create_test_coordinator(&temp_dir);
        let version = coordinator
            .get_current_version(&conn)
            .expect("Version check should succeed");

        assert_eq!(version, 0, "New database should have version 0");
    }

    /// 测试获取当前版本（已迁移数据库）
    #[test]
    fn test_get_current_version_migrated_database() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("Migration should succeed");

        let vfs_db_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_db_path).expect("Failed to open VFS database");

        let version = coordinator
            .get_current_version(&conn)
            .expect("Version check should succeed");

        assert_eq!(
            version,
            VFS_MIGRATION_SET.latest_version() as u32,
            "Migrated database should have latest VFS version"
        );
    }
}
