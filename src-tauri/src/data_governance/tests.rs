//! # Data Governance Integration Tests
//!
//! 数据治理系统的集成测试，测试完整的迁移流程。
//!
//! ## 测试内容
//!
//! 1. 新数据库完整迁移（从 0 到最新版本）
//! 2. 迁移验证器（表/列/索引检查）
//! 3. 依赖检查逻辑
//! 4. 迁移报告生成
//!
//! ## 运行方式
//!
//! ```bash
//! cargo test --features data_governance test_data_governance
//! ```

#[cfg(test)]
#[cfg(feature = "data_governance")]
mod integration_tests {
    use rusqlite::Connection;
    use std::path::PathBuf;
    use tempfile::TempDir;

    use crate::data_governance::audit::{AuditFilter, AuditRepository};
    use crate::data_governance::init::{initialize_with_report, needs_initialization};
    use crate::data_governance::migration::{
        MigrationCoordinator, MigrationError, MigrationReport, MigrationVerifier,
        CHAT_V2_MIGRATION_SET, LLM_USAGE_MIGRATION_SET, MISTAKES_MIGRATIONS, VFS_MIGRATION_SET,
    };
    use crate::data_governance::schema_registry::{DatabaseId, SchemaRegistry};

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
        // 测试时禁用审计日志
    }

    /// 创建测试用的迁移协调器（启用审计日志）
    fn create_test_coordinator_with_audit(temp_dir: &TempDir) -> MigrationCoordinator {
        let audit_db_path = temp_dir.path().join("databases").join("audit.db");
        MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(Some(audit_db_path))
    }

    /// 获取数据库文件路径（与 MigrationCoordinator::get_database_path 保持一致）
    fn get_database_path(temp_dir: &TempDir, db_id: &DatabaseId) -> PathBuf {
        match db_id {
            DatabaseId::Vfs => temp_dir.path().join("databases").join("vfs.db"),
            DatabaseId::ChatV2 => temp_dir.path().join("chat_v2.db"),
            DatabaseId::Mistakes => temp_dir.path().join("mistakes.db"),
            DatabaseId::LlmUsage => temp_dir.path().join("llm_usage.db"),
        }
    }

    /// 确保测试目录结构存在
    fn setup_test_directories(temp_dir: &TempDir) {
        let databases_dir = temp_dir.path().join("databases");
        std::fs::create_dir_all(&databases_dir).expect("Failed to create databases dir");
    }

    // ============================================================================
    // 测试组 1: 完整迁移流程测试
    // ============================================================================

    /// 测试 VFS 数据库完整迁移流程
    #[test]
    fn test_vfs_full_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 执行 VFS 数据库迁移
        let result = coordinator.migrate_single(DatabaseId::Vfs);
        assert!(result.is_ok(), "VFS migration failed: {:?}", result.err());

        let report = result.unwrap();
        assert!(report.success, "VFS migration should succeed");
        assert_eq!(report.id, DatabaseId::Vfs);
        assert_eq!(report.from_version, 0, "Should start from version 0");
        assert!(report.to_version > 0, "Should migrate to a version > 0");
        assert!(
            report.applied_count > 0,
            "Should apply at least one migration"
        );
        assert!(report.duration_ms > 0, "Should have non-zero duration");

        // 验证数据库文件已创建
        let vfs_db_path = temp_dir.path().join("databases").join("vfs.db");
        assert!(vfs_db_path.exists(), "VFS database file should exist");
    }

    /// 测试 Chat V2 数据库完整迁移流程
    #[test]
    fn test_chat_v2_full_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // Chat V2 依赖 VFS，先迁移 VFS
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");

        // 执行 Chat V2 迁移
        let result = coordinator.migrate_single(DatabaseId::ChatV2);
        assert!(
            result.is_ok(),
            "Chat V2 migration failed: {:?}",
            result.err()
        );

        let report = result.unwrap();
        assert!(report.success, "Chat V2 migration should succeed");
        assert_eq!(report.id, DatabaseId::ChatV2);
    }

    /// 测试 Mistakes 数据库完整迁移流程
    #[test]
    fn test_mistakes_full_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // Mistakes 依赖 VFS，先迁移 VFS
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");

        // 执行 Mistakes 迁移
        let result = coordinator.migrate_single(DatabaseId::Mistakes);
        assert!(
            result.is_ok(),
            "Mistakes migration failed: {:?}",
            result.err()
        );

        let report = result.unwrap();
        assert!(report.success, "Mistakes migration should succeed");
        assert_eq!(report.id, DatabaseId::Mistakes);

        // 验证数据库文件在正确位置
        let mistakes_db_path = get_database_path(&temp_dir, &DatabaseId::Mistakes);
        assert!(
            mistakes_db_path.exists(),
            "Mistakes database file should exist"
        );
    }

    /// 测试 LLM Usage 数据库完整迁移流程
    #[test]
    fn test_llm_usage_full_migration() {
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

        // 验证数据库文件
        let llm_usage_db_path = temp_dir.path().join("llm_usage.db");
        assert!(
            llm_usage_db_path.exists(),
            "LLM Usage database file should exist"
        );
    }

    /// 测试所有数据库的完整迁移流程（run_all）
    #[test]
    fn test_run_all_migrations() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 执行所有迁移
        let result = coordinator.run_all();
        assert!(result.is_ok(), "run_all failed: {:?}", result.err());

        let report = result.unwrap();
        assert!(report.success, "All migrations should succeed");
        assert_eq!(report.databases.len(), 4, "Should have 4 database reports");
        assert!(
            report.total_duration_ms > 0,
            "Should have non-zero total duration"
        );

        // 验证每个数据库的迁移都成功
        for db_report in &report.databases {
            assert!(
                db_report.success,
                "Database {:?} migration failed",
                db_report.id
            );
        }

        // 验证所有数据库文件存在
        assert!(temp_dir.path().join("databases").join("vfs.db").exists());
        assert!(get_database_path(&temp_dir, &DatabaseId::ChatV2).exists());
        assert!(get_database_path(&temp_dir, &DatabaseId::Mistakes).exists());
        assert!(temp_dir.path().join("llm_usage.db").exists());
    }

    // ============================================================================
    // 测试组 2: 迁移验证器测试
    // ============================================================================

    /// 测试 VFS 表验证
    #[test]
    fn test_vfs_table_verification() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 执行迁移
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");

        // 打开数据库连接验证表
        let vfs_db_path = temp_dir.path().join("databases").join("vfs.db");
        let conn = Connection::open(&vfs_db_path).expect("Failed to open VFS database");

        // 验证核心表存在
        let core_tables = [
            "resources",
            "notes",
            "files",
            "exam_sheets",
            "translations",
            "essays",
            "folders",
            "questions",
            "review_plans",
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
    fn test_vfs_index_verification() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 执行迁移
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");

        // 打开数据库连接验证索引
        let vfs_db_path = temp_dir.path().join("databases").join("vfs.db");
        let conn = Connection::open(&vfs_db_path).expect("Failed to open VFS database");

        // 验证核心索引存在
        let core_indexes = [
            "idx_resources_hash",
            "idx_resources_type",
            "idx_notes_resource",
            "idx_files_sha256",
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

    /// 测试 Chat V2 列验证
    #[test]
    fn test_chat_v2_column_verification() {
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

        // 打开数据库连接验证列
        let chat_db_path = get_database_path(&temp_dir, &DatabaseId::ChatV2);
        let conn = Connection::open(&chat_db_path).expect("Failed to open Chat V2 database");

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

    /// 测试验证器对缺失表的检测
    #[test]
    fn test_verifier_detects_missing_table() {
        let temp_dir = create_test_dir();
        let db_path = temp_dir.path().join("test.db");
        let conn = Connection::open(&db_path).expect("Failed to create test database");

        // 创建一个只有部分表的数据库
        conn.execute("CREATE TABLE resources (id TEXT PRIMARY KEY)", [])
            .expect("Failed to create table");

        // 创建一个期望更多表的迁移定义
        let migration =
            crate::data_governance::migration::definitions::MigrationDef::new(1, "test", "")
                .with_expected_tables(&["resources", "nonexistent_table"]);

        // 验证应该失败
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

    /// 测试验证器对缺失列的检测
    #[test]
    fn test_verifier_detects_missing_column() {
        let temp_dir = create_test_dir();
        let db_path = temp_dir.path().join("test.db");
        let conn = Connection::open(&db_path).expect("Failed to create test database");

        // 创建表但缺少某些列
        conn.execute("CREATE TABLE test_table (id TEXT PRIMARY KEY)", [])
            .expect("Failed to create table");

        // 创建期望更多列的迁移定义
        let migration =
            crate::data_governance::migration::definitions::MigrationDef::new(1, "test", "")
                .with_expected_columns(&[("test_table", "id"), ("test_table", "missing_column")]);

        // 验证应该失败
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

    /// 测试验证器对缺失索引的检测
    #[test]
    fn test_verifier_detects_missing_index() {
        let temp_dir = create_test_dir();
        let db_path = temp_dir.path().join("test.db");
        let conn = Connection::open(&db_path).expect("Failed to create test database");

        // 创建表但不创建索引
        conn.execute(
            "CREATE TABLE test_table (id TEXT PRIMARY KEY, name TEXT)",
            [],
        )
        .expect("Failed to create table");

        // 创建期望索引的迁移定义
        let migration =
            crate::data_governance::migration::definitions::MigrationDef::new(1, "test", "")
                .with_expected_indexes(&["idx_test_name"]);

        // 验证应该失败
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
    // 测试组 3: 依赖检查测试
    // ============================================================================

    /// 测试 DatabaseId 依赖关系
    #[test]
    fn test_database_dependencies() {
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

    /// 测试数据库排序顺序
    #[test]
    fn test_database_ordering() {
        let ordered = DatabaseId::all_ordered();

        assert_eq!(ordered.len(), 4, "Should have 4 databases");

        // 获取各数据库的位置
        let vfs_pos = ordered
            .iter()
            .position(|id| *id == DatabaseId::Vfs)
            .unwrap();
        let llm_pos = ordered
            .iter()
            .position(|id| *id == DatabaseId::LlmUsage)
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

        // 创建一个模拟的迁移报告，VFS 未迁移
        let report = MigrationReport::default();

        // 检查 ChatV2 的依赖（应该失败因为 VFS 未迁移）
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

    /// 测试依赖已满足时的成功
    #[test]
    fn test_dependency_satisfied() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let coordinator = create_test_coordinator(&temp_dir);

        // 创建一个模拟的迁移报告，VFS 已成功迁移
        let mut report = MigrationReport::default();
        report.add(crate::data_governance::migration::DatabaseMigrationReport {
            id: DatabaseId::Vfs,
            from_version: 0,
            to_version: 20260131,
            applied_count: 2,
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

        // run_all 应该按正确顺序执行迁移
        let result = coordinator.run_all();
        assert!(result.is_ok(), "run_all should succeed");

        let report = result.unwrap();

        // 验证迁移顺序：VFS 和 LlmUsage 应该在 ChatV2 和 Mistakes 之前
        let vfs_idx = report
            .databases
            .iter()
            .position(|r| r.id == DatabaseId::Vfs);
        let chat_idx = report
            .databases
            .iter()
            .position(|r| r.id == DatabaseId::ChatV2);
        let mistakes_idx = report
            .databases
            .iter()
            .position(|r| r.id == DatabaseId::Mistakes);

        if let (Some(vfs), Some(chat)) = (vfs_idx, chat_idx) {
            assert!(vfs < chat, "VFS should be migrated before ChatV2");
        }

        if let (Some(vfs), Some(mistakes)) = (vfs_idx, mistakes_idx) {
            assert!(vfs < mistakes, "VFS should be migrated before Mistakes");
        }
    }

    // ============================================================================
    // 测试组 4: 迁移报告测试
    // ============================================================================

    /// 测试空迁移报告
    #[test]
    fn test_migration_report_empty() {
        let report = MigrationReport::default();

        assert!(report.success, "Empty report should be successful");
        assert!(
            report.databases.is_empty(),
            "Empty report should have no databases"
        );
        assert_eq!(
            report.total_duration_ms, 0,
            "Empty report should have zero duration"
        );
        assert!(report.error.is_none(), "Empty report should have no error");
    }

    /// 测试迁移报告添加成功结果
    #[test]
    fn test_migration_report_add_success() {
        let mut report = MigrationReport::default();

        report.add(crate::data_governance::migration::DatabaseMigrationReport {
            id: DatabaseId::Vfs,
            from_version: 0,
            to_version: 20260131,
            applied_count: 2,
            success: true,
            duration_ms: 150,
            error: None,
        });

        assert!(report.success, "Report should still be successful");
        assert_eq!(report.databases.len(), 1, "Report should have one database");
    }

    /// 测试迁移报告添加失败结果
    #[test]
    fn test_migration_report_add_failure() {
        let mut report = MigrationReport::default();

        report.add(crate::data_governance::migration::DatabaseMigrationReport {
            id: DatabaseId::Vfs,
            from_version: 0,
            to_version: 0,
            applied_count: 0,
            success: false,
            duration_ms: 50,
            error: Some("Test error".to_string()),
        });

        assert!(
            !report.success,
            "Report should be unsuccessful after adding failure"
        );
        assert_eq!(report.databases.len(), 1, "Report should have one database");
    }

    /// 测试完整迁移报告内容
    #[test]
    fn test_migration_report_content() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        let result = coordinator.run_all();
        assert!(result.is_ok());

        let report = result.unwrap();

        // 验证报告结构
        assert_eq!(report.databases.len(), 4);

        for db_report in &report.databases {
            assert!(
                db_report.success,
                "Database {:?} should succeed",
                db_report.id
            );
            assert!(
                db_report.to_version >= db_report.from_version,
                "to_version should be >= from_version"
            );
            assert!(
                db_report.duration_ms > 0,
                "Duration should be positive for {:?}",
                db_report.id
            );
        }
    }

    // ============================================================================
    // 测试组 5: Schema Registry 集成测试
    // ============================================================================

    /// 测试迁移后的 Schema Registry 聚合
    #[test]
    fn test_schema_registry_aggregation() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 执行所有迁移
        coordinator.run_all().expect("Migration should succeed");

        // 聚合 Schema Registry
        let registry = coordinator
            .aggregate_schema_registry()
            .expect("Schema aggregation should succeed");

        // 验证注册表内容
        assert_eq!(
            registry.databases.len(),
            4,
            "Should have 4 databases in registry"
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
        }
    }

    /// 测试 Schema Registry 依赖检查
    #[test]
    fn test_schema_registry_dependency_check() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 执行所有迁移
        coordinator.run_all().expect("Migration should succeed");

        // 聚合 Schema Registry
        let registry = coordinator
            .aggregate_schema_registry()
            .expect("Schema aggregation should succeed");

        // 依赖检查应该通过
        let result = registry.check_dependencies();
        assert!(
            result.is_ok(),
            "Dependency check should pass: {:?}",
            result.err()
        );
    }

    /// 测试需要迁移检查
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

        // 执行迁移
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
    // 测试组 6: 初始化流程测试
    // ============================================================================

    /// 测试 needs_initialization
    #[test]
    fn test_needs_initialization() {
        let temp_dir = create_test_dir();

        // 新目录应该需要初始化
        let needs =
            needs_initialization(temp_dir.path()).expect("needs_initialization should succeed");
        assert!(needs, "New app should need initialization");
    }

    /// 测试完整初始化流程
    #[test]
    fn test_full_initialization() {
        let temp_dir = create_test_dir();

        // 执行完整初始化
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
        assert!(
            init_result.report.migrations_applied > 0,
            "Should apply some migrations"
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

        // 执行初始化
        initialize_with_report(temp_dir.path()).expect("First initialization should succeed");

        // 检查是否需要初始化
        let needs =
            needs_initialization(temp_dir.path()).expect("needs_initialization should succeed");

        assert!(!needs, "Should not need initialization after init");
    }

    // ============================================================================
    // 测试组 7: 审计日志测试
    // ============================================================================

    /// 测试审计日志初始化
    #[test]
    fn test_audit_log_initialization() {
        let temp_dir = create_test_dir();
        let audit_db_path = temp_dir.path().join("audit.db");

        // 创建审计数据库
        let conn = Connection::open(&audit_db_path).expect("Failed to create audit database");

        // 初始化审计表
        let result = AuditRepository::init(&conn);
        assert!(result.is_ok(), "Audit init should succeed");

        // 验证表存在
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__audit_log')",
            [],
            |row| row.get(0),
        ).expect("Failed to check table");

        assert!(exists, "Audit log table should exist");
    }

    /// 测试审计日志记录迁移
    #[test]
    fn test_audit_log_migration_record() {
        let temp_dir = create_test_dir();
        let audit_db_path = temp_dir.path().join("audit.db");

        let conn = Connection::open(&audit_db_path).expect("Failed to create audit database");

        AuditRepository::init(&conn).expect("Audit init should succeed");

        // 记录迁移完成
        let result = AuditRepository::log_migration_complete(&conn, "vfs", 0, 20260131, 2, 150);

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
    }

    /// 测试带审计日志的完整迁移
    #[test]
    fn test_migration_with_audit_logging() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);

        // 初始化审计数据库
        let audit_db_path = temp_dir.path().join("databases").join("audit.db");
        let audit_conn = Connection::open(&audit_db_path).expect("Failed to create audit database");
        AuditRepository::init(&audit_conn).expect("Audit init should succeed");
        drop(audit_conn); // 关闭连接让协调器可以使用

        // 创建带审计的协调器
        let mut coordinator = create_test_coordinator_with_audit(&temp_dir);

        // 执行迁移
        coordinator.run_all().expect("Migration should succeed");

        // 验证审计日志
        let audit_conn = Connection::open(&audit_db_path).expect("Failed to open audit database");

        let count =
            AuditRepository::count_by_type(&audit_conn, "Migration").expect("Count should succeed");

        assert!(
            count >= 4,
            "Should have at least 4 migration audit logs (one per database)"
        );
    }

    // ============================================================================
    // 测试组 8: 边界条件和错误处理测试
    // ============================================================================

    /// 测试重复迁移是幂等的
    #[test]
    fn test_migration_idempotency() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 第一次迁移
        let result1 = coordinator.run_all();
        assert!(result1.is_ok(), "First migration should succeed");
        let report1 = result1.unwrap();
        assert!(report1.success);

        // 第二次迁移（应该是幂等的）
        let result2 = coordinator.run_all();
        assert!(
            result2.is_ok(),
            "Second migration should succeed (idempotent)"
        );
        let report2 = result2.unwrap();
        assert!(report2.success);

        // 第二次不应该应用任何新迁移
        let total_applied: usize = report2.databases.iter().map(|r| r.applied_count).sum();
        assert_eq!(
            total_applied, 0,
            "Second run should not apply any migrations"
        );
    }

    /// 测试待迁移数量计算
    #[test]
    fn test_pending_migrations_count() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let coordinator = create_test_coordinator(&temp_dir);

        // 新数据库应该有所有数据库的待执行迁移总数
        let expected = VFS_MIGRATION_SET.count()
            + CHAT_V2_MIGRATION_SET.count()
            + MISTAKES_MIGRATIONS.count()
            + LLM_USAGE_MIGRATION_SET.count();
        let count = coordinator
            .pending_migrations_count()
            .expect("Count should succeed");
        assert_eq!(count, expected, "Pending migrations count mismatch");
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

    /// 测试获取当前版本（新数据库）
    #[test]
    fn test_get_current_version_new_db() {
        let temp_dir = create_test_dir();
        let db_path = temp_dir.path().join("test.db");
        let conn = Connection::open(&db_path).expect("Failed to create database");

        let coordinator = create_test_coordinator(&temp_dir);
        let version = coordinator
            .get_current_version(&conn)
            .expect("Version check should succeed");

        assert_eq!(version, 0, "New database should have version 0");
    }

    /// 测试迁移集合属性
    #[test]
    fn test_migration_set_properties() {
        // 验证各迁移集合的基本属性（使用动态计数，避免新增迁移后硬编码断裂）
        assert_eq!(VFS_MIGRATION_SET.database_name, "vfs");
        assert!(
            VFS_MIGRATION_SET.count() >= 9,
            "VFS should have at least 9 migrations"
        );
        assert!(
            VFS_MIGRATION_SET.latest_version() >= 20260207,
            "VFS latest should be >= 20260207"
        );

        assert_eq!(CHAT_V2_MIGRATION_SET.database_name, "chat_v2");
        assert!(
            CHAT_V2_MIGRATION_SET.count() >= 7,
            "ChatV2 should have at least 7 migrations"
        );
        assert!(
            CHAT_V2_MIGRATION_SET.latest_version() >= 20260207,
            "ChatV2 latest should be >= 20260207"
        );

        assert_eq!(MISTAKES_MIGRATIONS.database_name, "mistakes");
        assert!(
            MISTAKES_MIGRATIONS.count() >= 4,
            "Mistakes should have at least 4 migrations"
        );
        assert!(
            MISTAKES_MIGRATIONS.latest_version() >= 20260207,
            "Mistakes latest should be >= 20260207"
        );

        assert_eq!(LLM_USAGE_MIGRATION_SET.database_name, "llm_usage");
        assert!(
            LLM_USAGE_MIGRATION_SET.count() >= 3,
            "LlmUsage should have at least 3 migrations"
        );
        assert!(
            LLM_USAGE_MIGRATION_SET.latest_version() >= 20260201,
            "LlmUsage latest should be >= 20260201"
        );
    }
}
