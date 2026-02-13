//! 迁移测试模块（旧迁移系统）
//!
//! ★ P1-1-18: 测试数据库迁移路径和回滚机制
//!
//! ## 重要说明
//!
//! 此文件测试的是**旧的模块内迁移系统**（各模块 database.rs 中的条件编译代码）。
//! 新的统一迁移框架测试位于 `src/data_governance/migration_tests.rs`。
//!
//! ### 两套测试的关系
//!
//! | 测试文件 | 测试目标 | 运行条件 |
//! |---------|---------|---------|
//! | tests/migration_tests.rs (本文件) | 旧模块内迁移系统 | 默认（不带 data_governance feature） |
//! | src/data_governance/migration_tests.rs | 新统一迁移框架 | 需要 --features data_governance |
//!
//! ### 何时可以删除本文件
//!
//! 当满足以下条件时，本文件可以安全删除：
//! 1. data_governance feature 成为默认启用
//! 2. 各模块 database.rs 中的条件编译旧迁移代码已删除
//! 3. 完成至少一个稳定版本的发布验证
//!
//! ## 测试覆盖
//!
//! 1. v1 到最新版本的完整迁移路径
//! 2. 迁移失败时的回滚机制
//! 3. 迁移幂等性验证
//! 4. Schema 完整性验证
//!
//! ## 断言策略说明
//!
//! 本测试使用精确版本匹配断言（`assert_eq!`）而非宽松断言（`>= 1`），原因如下：
//! 1. **防止迁移遗漏**: 确保所有迁移步骤都已执行，而非仅检查是否"至少执行了一个"
//! 2. **及早发现问题**: 版本常量变更时测试会立即失败，提醒开发者审查迁移逻辑
//! 3. **避免假阳性**: 宽松断言可能掩盖部分迁移失败的情况

#![cfg(feature = "old_migration_impl")]

use rusqlite::{params, Connection};
use tempfile::TempDir;

// ============================================================================
// Chat V2 数据库迁移测试
// ============================================================================

mod chat_v2_migration_tests {
    use super::*;
    // 导入 ChatV2 版本常量，用于精确版本断言
    use deep_student_lib::chat_v2::{
        ChatV2Database, CURRENT_SCHEMA_VERSION as CHAT_V2_SCHEMA_VERSION,
    };

    /// 测试 Chat V2 数据库 v1 到 latest 的完整迁移路径
    ///
    /// ## 断言说明
    /// 使用精确版本匹配而非 `>= 1` 的宽松断言，原因：
    /// - 确保迁移完整执行到最新版本，而非仅检查是否执行了任意迁移
    /// - 当版本常量更新时测试会失败，提醒开发者确认迁移逻辑正确
    #[test]
    fn test_migration_path_v1_to_latest() {
        // 创建临时目录
        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 使用真实的 ChatV2Database 迁移路径
        let db = ChatV2Database::new(temp_dir.path()).expect("Failed to init ChatV2Database");
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证版本更新 - 必须精确匹配当前 schema 版本
        // 使用 assert_eq! 而非 assert!(>= 1)，确保迁移完整执行
        let final_version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM chat_v2_migrations",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get final version");
        assert_eq!(
            final_version, CHAT_V2_SCHEMA_VERSION,
            "Migration should reach exactly CURRENT_SCHEMA_VERSION ({}), got {}",
            CHAT_V2_SCHEMA_VERSION, final_version
        );

        // 验证关键表存在
        let sessions_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chat_v2_sessions'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check sessions table");
        assert_eq!(
            sessions_exists, 1,
            "Sessions table should exist after migration"
        );
    }

    /// 测试迁移失败时的回滚机制
    #[test]
    fn test_migration_rollback_on_failure() {
        // 创建临时目录
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_rollback.db");

        // 创建数据库
        let conn = Connection::open(&db_path).expect("Failed to create database");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("Failed to set pragmas");

        // 创建迁移记录表
        conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS test_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            "#,
            [],
        )
        .expect("Failed to create migration table");

        // 创建测试表
        conn.execute(
            "CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("Failed to create test table");

        // 插入测试数据
        conn.execute(
            "INSERT INTO test_data (id, value) VALUES (1, 'original')",
            [],
        )
        .expect("Failed to insert test data");

        // 开始事务模拟迁移
        conn.execute("BEGIN IMMEDIATE", [])
            .expect("Failed to begin transaction");

        // 执行一些迁移操作
        conn.execute(
            "INSERT INTO test_data (id, value) VALUES (2, 'migration_data')",
            [],
        )
        .expect("Failed to insert migration data");

        // 模拟迁移失败 - 回滚事务
        conn.execute("ROLLBACK", []).expect("Failed to rollback");

        // 验证回滚成功 - 只有原始数据存在
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM test_data", [], |row| row.get(0))
            .expect("Failed to count rows");
        assert_eq!(count, 1, "Should only have original data after rollback");

        // 验证原始数据完整
        let value: String = conn
            .query_row("SELECT value FROM test_data WHERE id = 1", [], |row| {
                row.get(0)
            })
            .expect("Failed to get original value");
        assert_eq!(
            value, "original",
            "Original data should be preserved after rollback"
        );

        // 验证迁移版本未更新
        let version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM test_migrations",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get version");
        assert_eq!(
            version, 0,
            "Migration version should not be updated after rollback"
        );
    }

    /// 测试 DatabaseCorrupted 错误场景
    ///
    /// ★ P1-12: 验证 ROLLBACK 失败时错误类型定义正确
    ///
    /// 由于难以模拟真实的 ROLLBACK 失败场景（需要磁盘满等极端条件），
    /// 此测试验证错误类型的定义和格式是否正确。
    #[test]
    fn test_database_corrupted_error_on_rollback_failure() {
        use deep_student_lib::chat_v2::ChatV2Error;

        // 模拟场景：
        // 1. 开始事务
        // 2. 执行会失败的操作
        // 3. ROLLBACK 失败时返回 DatabaseCorrupted

        // 由于难以模拟 ROLLBACK 失败，测试错误类型定义是否正确
        let err = ChatV2Error::DatabaseCorrupted {
            original_error: "Migration failed".to_string(),
            rollback_error: "Disk full".to_string(),
        };

        // 验证错误消息格式
        let error_string = err.to_string();
        assert!(
            error_string.contains("DATABASE CORRUPTED"),
            "Error should contain 'DATABASE CORRUPTED', got: {}",
            error_string
        );
        assert!(
            error_string.contains("Migration failed"),
            "Error should contain original error message, got: {}",
            error_string
        );
        assert!(
            error_string.contains("Disk full"),
            "Error should contain rollback error message, got: {}",
            error_string
        );
        assert!(
            error_string.contains("inconsistent state"),
            "Error should warn about inconsistent state, got: {}",
            error_string
        );
    }

    /// 测试迁移幂等性 - 重复执行不应产生错误
    #[test]
    fn test_migration_idempotency() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_idempotent.db");

        // 第一次创建和迁移
        {
            let conn = Connection::open(&db_path).expect("Failed to create database");
            conn.execute_batch("PRAGMA foreign_keys = ON;")
                .expect("Failed to set pragmas");

            // 创建迁移表和应用迁移
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS idempotent_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE IF NOT EXISTS test_table (
                    id TEXT PRIMARY KEY,
                    data TEXT
                );
            "#,
            )
            .expect("Failed to apply first migration");

            conn.execute(
                "INSERT OR IGNORE INTO idempotent_migrations (version, name) VALUES (1, 'init')",
                [],
            )
            .expect("Failed to record migration");
        }

        // 第二次打开同一数据库
        {
            let conn = Connection::open(&db_path).expect("Failed to reopen database");

            // 尝试再次执行相同的迁移 - 应该是幂等的
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS idempotent_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE IF NOT EXISTS test_table (
                    id TEXT PRIMARY KEY,
                    data TEXT
                );
            "#,
            )
            .expect("Idempotent migration should succeed");

            // 验证只有一条迁移记录
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM idempotent_migrations WHERE version = 1",
                    [],
                    |row| row.get(0),
                )
                .expect("Failed to count migrations");
            assert_eq!(count, 1, "Should only have one migration record");
        }
    }

    /// 测试 Schema 完整性验证
    #[test]
    fn test_schema_integrity_verification() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_integrity.db");

        let conn = Connection::open(&db_path).expect("Failed to create database");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("Failed to set pragmas");

        // 创建带有外键约束的表
        conn.execute_batch(
            r#"
            CREATE TABLE parent_table (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE child_table (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                data TEXT,
                FOREIGN KEY (parent_id) REFERENCES parent_table(id) ON DELETE CASCADE
            );
        "#,
        )
        .expect("Failed to create tables with foreign keys");

        // 验证外键约束启用
        let fk_enabled: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("Failed to check foreign keys");
        assert_eq!(fk_enabled, 1, "Foreign keys should be enabled");

        // 插入父记录
        conn.execute(
            "INSERT INTO parent_table (id, name) VALUES ('p1', 'Parent 1')",
            [],
        )
        .expect("Failed to insert parent");

        // 插入子记录
        conn.execute(
            "INSERT INTO child_table (id, parent_id, data) VALUES ('c1', 'p1', 'Child 1')",
            [],
        )
        .expect("Failed to insert child");

        // 删除父记录，验证级联删除
        conn.execute("DELETE FROM parent_table WHERE id = 'p1'", [])
            .expect("Failed to delete parent");

        // 验证子记录被级联删除
        let child_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM child_table", [], |row| row.get(0))
            .expect("Failed to count children");
        assert_eq!(child_count, 0, "Child record should be cascade deleted");
    }
}

// ============================================================================
// Workspace 数据库迁移测试
// ============================================================================

// ============================================================================
// Workspace 迁移测试暂时禁用
// 原因：WorkspaceDatabase 不使用迁移版本系统，没有 workspace_migrations 表
// ============================================================================
#[cfg(feature = "workspace_migrations_test")]
mod workspace_migration_tests {
    use super::*;
    // 导入 Workspace 版本常量，用于精确版本断言
    use deep_student_lib::chat_v2::WorkspaceDatabase;
    const WORKSPACE_SCHEMA_VERSION: u32 = 1; // 占位符

    /// 测试使用真实 WorkspaceDatabase 的完整迁移路径
    ///
    /// ## 断言说明
    /// 使用精确版本匹配而非宽松断言，确保迁移完整执行到最新版本
    #[test]
    fn test_real_workspace_migration_path_to_latest() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 使用真实的 WorkspaceDatabase 迁移路径
        // WorkspaceDatabase::new 需要 workspaces_dir 和 workspace_id 两个参数
        let test_workspace_id = "test_migration_ws";
        let db = WorkspaceDatabase::new(temp_dir.path(), test_workspace_id)
            .expect("Failed to init WorkspaceDatabase");
        let conn = db.get_connection().expect("Failed to get connection");

        // 验证版本更新 - 必须精确匹配当前 schema 版本
        let final_version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM workspace_migrations",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get final version");
        assert_eq!(
            final_version, WORKSPACE_SCHEMA_VERSION,
            "Workspace migration should reach exactly WORKSPACE_SCHEMA_VERSION ({}), got {}",
            WORKSPACE_SCHEMA_VERSION, final_version
        );

        // 验证关键表存在
        let workspace_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='workspace'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check workspace table");
        assert_eq!(
            workspace_exists, 1,
            "Workspace table should exist after migration"
        );
    }

    /// 测试 Workspace 数据库迁移表创建
    #[test]
    fn test_workspace_migration_table_creation() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_workspace.db");

        let conn = Connection::open(&db_path).expect("Failed to create database");
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .expect("Failed to set pragmas");

        // 创建迁移表（模拟 WorkspaceDatabase 的行为）
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS workspace_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        "#,
        )
        .expect("Failed to create workspace migration table");

        // 验证迁移表存在
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='workspace_migrations'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check migration table");
        assert_eq!(table_exists, 1, "Workspace migration table should exist");

        // 验证表结构
        let mut stmt = conn
            .prepare("PRAGMA table_info(workspace_migrations)")
            .expect("Failed to prepare PRAGMA");
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query columns")
            .filter_map(|r| r.ok())
            .collect();

        assert!(
            columns.contains(&"version".to_string()),
            "Should have version column"
        );
        assert!(
            columns.contains(&"name".to_string()),
            "Should have name column"
        );
        assert!(
            columns.contains(&"applied_at".to_string()),
            "Should have applied_at column"
        );
    }

    /// 测试 Workspace 模拟迁移路径（手动执行单步迁移）
    ///
    /// ## 注意
    /// 此测试使用手动 SQL 模拟迁移过程，仅验证迁移机制的正确性。
    /// 如需验证真实迁移路径到最新版本，请使用 `test_real_workspace_migration_path_to_latest`。
    ///
    /// 此处断言 version == 1 是正确的，因为我们只手动执行了 v1 迁移。
    #[test]
    fn test_workspace_simulated_migration_path() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_ws_migration.db");

        let conn = Connection::open(&db_path).expect("Failed to create database");
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .expect("Failed to set pragmas");

        // 创建迁移表
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS workspace_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        "#,
        )
        .expect("Failed to create migration table");

        // 模拟 v1 迁移 - 创建 workspace schema
        conn.execute("BEGIN IMMEDIATE", [])
            .expect("Failed to begin transaction");

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS workspace (
                id TEXT PRIMARY KEY,
                name TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                creator_session_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent (
                session_id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'worker',
                status TEXT NOT NULL DEFAULT 'idle',
                FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
            );
        "#,
        )
        .expect("Failed to apply v1 migration");

        conn.execute(
            "INSERT INTO workspace_migrations (version, name) VALUES (?1, ?2)",
            params![1, "001_workspace_schema"],
        )
        .expect("Failed to record migration");

        conn.execute("COMMIT", []).expect("Failed to commit");

        // 验证模拟迁移的版本（此处断言 == 1 是正确的，因为只模拟执行了 v1）
        let version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM workspace_migrations",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get version");
        assert_eq!(
            version, 1,
            "Simulated migration should be at version 1 (as manually applied)"
        );

        // 验证关键表存在
        let workspace_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='workspace'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check workspace table");
        assert_eq!(workspace_exists, 1, "Workspace table should exist");

        let agent_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check agent table");
        assert_eq!(agent_exists, 1, "Agent table should exist");
    }

    /// 测试 Workspace 迁移回滚
    #[test]
    fn test_workspace_migration_rollback() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_ws_rollback.db");

        let conn = Connection::open(&db_path).expect("Failed to create database");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("Failed to set pragmas");

        // 创建迁移表
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS workspace_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        "#,
        )
        .expect("Failed to create migration table");

        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])
            .expect("Failed to begin transaction");

        // 创建一些表
        conn.execute("CREATE TABLE test_ws_table (id TEXT PRIMARY KEY)", [])
            .expect("Failed to create table");

        // 记录迁移
        conn.execute(
            "INSERT INTO workspace_migrations (version, name) VALUES (99, 'test_migration')",
            [],
        )
        .expect("Failed to record migration");

        // 模拟失败 - 回滚
        conn.execute("ROLLBACK", []).expect("Failed to rollback");

        // 验证表不存在
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='test_ws_table'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check table");
        assert_eq!(table_exists, 0, "Table should not exist after rollback");

        // 验证迁移记录不存在
        let migration_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workspace_migrations WHERE version = 99",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check migration");
        assert_eq!(
            migration_exists, 0,
            "Migration record should not exist after rollback"
        );
    }
}

// ============================================================================
// Textbooks 数据库表名测试
// ============================================================================

mod textbooks_table_tests {
    use super::*;

    /// 测试 textbooks 表存在且结构正确
    #[test]
    fn test_textbooks_table_structure() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_textbooks.db");

        let conn = Connection::open(&db_path).expect("Failed to create database");
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .expect("Failed to set pragmas");

        // 创建 textbooks 表（模拟 TextbooksDb::init_schema）
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS textbooks (
                id TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL UNIQUE,
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                page_count INTEGER,
                tags_json TEXT NOT NULL DEFAULT '[]',
                favorite INTEGER NOT NULL DEFAULT 0,
                last_opened_at TEXT,
                last_page INTEGER,
                bookmarks_json TEXT NOT NULL DEFAULT '[]',
                cover_key TEXT,
                origin_json TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_textbooks_status ON textbooks(status);
            CREATE INDEX IF NOT EXISTS idx_textbooks_favorite ON textbooks(favorite);
        "#,
        )
        .expect("Failed to create textbooks schema");

        // 验证 textbooks 表存在（而不是 files 表）
        let textbooks_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='textbooks'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check textbooks table");
        assert_eq!(textbooks_exists, 1, "textbooks table should exist");

        // 验证 files 表不存在
        let files_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='files'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check files table");
        assert_eq!(
            files_exists, 0,
            "files table should NOT exist in textbooks db"
        );

        // 验证表结构
        let mut stmt = conn
            .prepare("PRAGMA table_info(textbooks)")
            .expect("Failed to prepare PRAGMA");
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query columns")
            .filter_map(|r| r.ok())
            .collect();

        let expected_columns = vec![
            "id",
            "sha256",
            "file_name",
            "file_path",
            "size",
            "page_count",
            "tags_json",
            "favorite",
            "last_opened_at",
            "last_page",
            "bookmarks_json",
            "cover_key",
            "origin_json",
            "status",
            "created_at",
            "updated_at",
        ];

        for col in expected_columns {
            assert!(
                columns.contains(&col.to_string()),
                "textbooks table should have {} column",
                col
            );
        }
    }

    /// 测试 textbooks CRUD 操作使用正确的表名
    #[test]
    fn test_textbooks_crud_operations() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_textbooks_crud.db");

        let conn = Connection::open(&db_path).expect("Failed to create database");

        // 创建 textbooks 表
        conn.execute_batch(
            r#"
            CREATE TABLE textbooks (
                id TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL UNIQUE,
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        "#,
        )
        .expect("Failed to create textbooks table");

        // 测试 INSERT
        let result = conn.execute(
            "INSERT INTO textbooks (id, sha256, file_name, file_path, size, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7)",
            params!["tb_1", "sha256_hash", "test.pdf", "/path/to/test.pdf", 1024, "2024-01-01", "2024-01-01"],
        );
        assert!(result.is_ok(), "INSERT into textbooks should succeed");

        // 测试 SELECT
        let file_name: String = conn
            .query_row(
                "SELECT file_name FROM textbooks WHERE id = ?1",
                params!["tb_1"],
                |row| row.get(0),
            )
            .expect("SELECT from textbooks should succeed");
        assert_eq!(file_name, "test.pdf");

        // 测试 UPDATE
        let affected = conn
            .execute(
                "UPDATE textbooks SET status = 'trashed' WHERE id = ?1",
                params!["tb_1"],
            )
            .expect("UPDATE textbooks should succeed");
        assert_eq!(affected, 1);

        // 测试 DELETE
        let affected = conn
            .execute("DELETE FROM textbooks WHERE id = ?1", params!["tb_1"])
            .expect("DELETE from textbooks should succeed");
        assert_eq!(affected, 1);
    }
}

// ============================================================================
// VFS 数据库迁移测试
// ============================================================================

mod vfs_migration_tests {
    use super::*;
    // 导入 VFS 版本常量，用于精确版本断言
    use deep_student_lib::vfs::database::CURRENT_SCHEMA_VERSION as VFS_SCHEMA_VERSION;
    use deep_student_lib::vfs::VfsDatabase;

    /// 测试 VFS 数据库从 v1 到 latest 的完整迁移路径
    ///
    /// ## 断言说明
    /// 使用精确版本匹配而非 `>= 1` 的宽松断言，原因：
    /// - 确保迁移完整执行到最新版本，而非仅检查是否执行了任意迁移
    /// - 当版本常量更新时测试会失败，提醒开发者确认迁移逻辑正确
    ///
    /// ## VFS 迁移复杂性说明
    /// VFS 有 35 个迁移版本，是项目中最复杂的数据库，包含：
    /// - 资源管理（resources, notes, files, translations, exam_sheets, essays）
    /// - 文件夹组织（folders, folder_items, path_cache）
    /// - 向量索引（vfs_index_units, vfs_index_segments, vfs_embedding_dims）
    /// - 题库系统（questions, question_history, review_plans）
    #[test]
    fn test_vfs_migration_path_v1_to_latest() {
        // 创建临时目录
        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 使用真实的 VfsDatabase 迁移路径
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证版本更新 - 必须精确匹配当前 schema 版本
        // VFS 使用 vfs_schema_history 表记录迁移（新架构），回退到 vfs_migrations（旧架构）
        let final_version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM vfs_schema_history WHERE success = 1 OR success IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get final version from vfs_schema_history");
        assert_eq!(
            final_version, VFS_SCHEMA_VERSION,
            "VFS migration should reach exactly CURRENT_SCHEMA_VERSION ({}), got {}",
            VFS_SCHEMA_VERSION, final_version
        );
    }

    /// 测试 VFS Schema 完整性 - 验证所有关键表存在
    ///
    /// VFS 数据库包含多个核心表，此测试验证迁移后这些表都已正确创建。
    #[test]
    fn test_vfs_schema_integrity() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 初始化数据库
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        // 核心资源表
        let core_tables = [
            "resources",      // 001: 资源元数据
            "blobs",          // 001: Blob 存储
            "notes",          // 001: 笔记
            "notes_versions", // 001: 笔记版本历史
            "files",          // 001: 文件（教材、附件）
            "translations",   // 001: 翻译
            "exam_sheets",    // 001: 题目集
            "essays",         // 001: 作文
        ];

        // 文件夹组织表
        let folder_tables = [
            "folders",      // 002: 文件夹
            "folder_items", // 002: 文件夹内容项
            "path_cache",   // 009: 路径缓存
        ];

        // 会话和扩展表
        let session_tables = [
            "essay_sessions", // 003: 作文会话
        ];

        // 迁移记录表
        let migration_tables = [
            "vfs_migrations",     // 旧迁移记录表（兼容）
            "vfs_schema_history", // 新迁移记录表
        ];

        // 向量索引表（迁移 027）
        let index_tables = [
            "vfs_index_units",     // 027: 索引单元
            "vfs_index_segments",  // 027: 索引分段
            "vfs_embedding_dims",  // 027: 向量维度
            "vfs_indexing_config", // 018: 索引配置
        ];

        // 题库系统表（迁移 025, 034, 035）
        let question_tables = [
            "questions",           // 025: 题目
            "question_history",    // 025: 题目历史
            "question_bank_stats", // 025: 题库统计
            "review_plans",        // 034: 复习计划
            "review_history",      // 034: 复习历史
            "review_stats",        // 034: 复习统计
        ];

        // 验证所有表存在
        let all_tables: Vec<&str> = core_tables
            .iter()
            .chain(folder_tables.iter())
            .chain(session_tables.iter())
            .chain(migration_tables.iter())
            .chain(index_tables.iter())
            .chain(question_tables.iter())
            .copied()
            .collect();

        for table in all_tables {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .expect(&format!("Failed to check table existence: {}", table));
            assert_eq!(
                exists, 1,
                "Table {} should exist after VFS migration",
                table
            );
        }

        // 验证关键索引存在
        let key_indexes = [
            "idx_resources_hash",      // 资源哈希唯一索引
            "idx_folders_parent",      // 文件夹父级索引
            "idx_folder_items_folder", // 文件夹内容项索引
            "idx_path_cache_path",     // 路径缓存索引
        ];

        for idx in key_indexes {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |row| row.get(0),
                )
                .expect(&format!("Failed to check index existence: {}", idx));
            assert_eq!(exists, 1, "Index {} should exist after VFS migration", idx);
        }

        // 验证外键约束已启用
        let fk_enabled: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("Failed to check foreign_keys pragma");
        assert_eq!(
            fk_enabled, 1,
            "Foreign keys should be enabled in VFS database"
        );
    }

    /// 测试 VFS 迁移幂等性 - 重复初始化不应产生错误
    ///
    /// 这是最重要的测试之一，确保：
    /// 1. 应用启动时可以安全地重新初始化数据库
    /// 2. 已执行的迁移不会被重复执行
    /// 3. Schema 版本号保持一致
    #[test]
    fn test_vfs_migration_idempotency() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 第一次初始化
        let version1 = {
            let db =
                VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase first time");
            let conn = db.get_conn().expect("Failed to get connection");

            let version: u32 = conn
                .query_row(
                    "SELECT COALESCE(MAX(version), 0) FROM vfs_schema_history WHERE success = 1 OR success IS NULL",
                    [],
                    |row| row.get(0),
                )
                .expect("Failed to get version");

            // 验证第一次初始化达到最新版本
            assert_eq!(
                version, VFS_SCHEMA_VERSION,
                "First init should reach latest version"
            );
            version
        };

        // 第二次初始化（模拟应用重启）
        let version2 = {
            let db =
                VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase second time");
            let conn = db.get_conn().expect("Failed to get connection");

            let version: u32 = conn
                .query_row(
                    "SELECT COALESCE(MAX(version), 0) FROM vfs_schema_history WHERE success = 1 OR success IS NULL",
                    [],
                    |row| row.get(0),
                )
                .expect("Failed to get version");
            version
        };

        // 验证版本一致
        assert_eq!(
            version1, version2,
            "Schema version should remain consistent after re-initialization"
        );
        assert_eq!(
            version2, VFS_SCHEMA_VERSION,
            "Schema version should still be at latest ({}) after re-init",
            VFS_SCHEMA_VERSION
        );

        // 第三次初始化，验证迁移记录数量不变
        {
            let db =
                VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase third time");
            let conn = db.get_conn().expect("Failed to get connection");

            // 统计迁移记录数量
            let migration_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM vfs_schema_history", [], |row| {
                    row.get(0)
                })
                .expect("Failed to count migrations");

            // 每个版本应该只有一条记录
            assert_eq!(
                migration_count as u32, VFS_SCHEMA_VERSION,
                "Should have exactly {} migration records (one per version), got {}",
                VFS_SCHEMA_VERSION, migration_count
            );
        }
    }

    /// 测试 VFS 数据库统计功能
    #[test]
    fn test_vfs_database_statistics() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase");

        let stats = db.get_statistics().expect("Failed to get statistics");

        // 新数据库应该为空
        assert_eq!(
            stats.resource_count, 0,
            "New database should have 0 resources"
        );
        assert_eq!(stats.note_count, 0, "New database should have 0 notes");
        assert_eq!(
            stats.textbook_count, 0,
            "New database should have 0 textbooks"
        );
        assert_eq!(stats.exam_count, 0, "New database should have 0 exams");
        assert_eq!(
            stats.translation_count, 0,
            "New database should have 0 translations"
        );
        assert_eq!(stats.essay_count, 0, "New database should have 0 essays");
        assert_eq!(stats.blob_count, 0, "New database should have 0 blobs");
        assert_eq!(
            stats.schema_version, VFS_SCHEMA_VERSION,
            "Schema version should be {}",
            VFS_SCHEMA_VERSION
        );
    }

    /// 测试 VFS 迁移表结构创建
    #[test]
    fn test_vfs_migration_table_structure() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证 vfs_schema_history 表结构
        let mut stmt = conn
            .prepare("PRAGMA table_info(vfs_schema_history)")
            .expect("Failed to prepare PRAGMA");
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query columns")
            .filter_map(|r| r.ok())
            .collect();

        assert!(
            columns.contains(&"version".to_string()),
            "Should have version column"
        );
        assert!(
            columns.contains(&"name".to_string()),
            "Should have name column"
        );
        assert!(
            columns.contains(&"applied_at".to_string()),
            "Should have applied_at column"
        );
        assert!(
            columns.contains(&"checksum".to_string()),
            "Should have checksum column"
        );
        assert!(
            columns.contains(&"success".to_string()),
            "Should have success column"
        );
    }

    /// 测试 VFS 关键列存在性（迁移 011 后的结构）
    #[test]
    fn test_vfs_key_columns_after_migration_011() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        // 迁移 011 后，folders 和 folder_items 表不应该有 subject 列
        let folders_subject: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('folders') WHERE name = 'subject'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check folders.subject");
        assert_eq!(
            folders_subject, 0,
            "folders should NOT have subject column after migration 011"
        );

        let folder_items_subject: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('folder_items') WHERE name = 'subject'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check folder_items.subject");
        assert_eq!(
            folder_items_subject, 0,
            "folder_items should NOT have subject column after migration 011"
        );

        // 验证 folder_items 有 cached_path 列（迁移 005）
        let cached_path: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('folder_items') WHERE name = 'cached_path'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check folder_items.cached_path");
        assert_eq!(
            cached_path, 1,
            "folder_items should have cached_path column"
        );

        // 验证 notes 有 deleted_at 列（迁移 004）
        let notes_deleted_at: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'deleted_at'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check notes.deleted_at");
        assert_eq!(notes_deleted_at, 1, "notes should have deleted_at column");

        // 验证 resources 有索引相关列（迁移 018-019）
        let index_columns = ["index_state", "index_hash", "index_error", "indexed_at"];
        for col in index_columns {
            let exists: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('resources') WHERE name = '{}'",
                        col
                    ),
                    [],
                    |row| row.get(0),
                )
                .expect(&format!("Failed to check resources.{}", col));
            assert_eq!(exists, 1, "resources should have {} column", col);
        }
    }

    /// 测试 VFS expected_columns 配置覆盖率
    ///
    /// 此测试验证 data_governance 迁移契约中的 expected_tables/expected_columns 配置：
    /// 1. 所有引用的表实际存在于迁移后的数据库中
    /// 2. 所有引用的列实际存在于对应的表中
    /// 3. 关键业务表有足够的列覆盖
    ///
    /// 这是对迁移配置正确性的元测试，确保配置与实际 Schema 一致。
    #[cfg(feature = "data_governance")]
    #[test]
    fn test_vfs_expected_columns_coverage() {
        use deep_student_lib::data_governance::migration::VFS_MIGRATION_SET;

        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        let mut referenced_tables: std::collections::HashSet<&str> =
            std::collections::HashSet::new();
        let mut referenced_columns: Vec<(&str, &str)> = Vec::new();

        for migration in VFS_MIGRATION_SET.migrations.iter() {
            for table in migration.expected_tables.iter() {
                referenced_tables.insert(table);
            }
            for (table, column) in migration.expected_columns.iter() {
                referenced_tables.insert(table);
                referenced_columns.push((table, column));
            }
        }

        for table in &referenced_tables {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [*table],
                    |row| row.get(0),
                )
                .expect(&format!("Failed to check table existence: {}", table));
            assert_eq!(
                exists, 1,
                "Table '{}' referenced in migration contract should exist after all migrations",
                table
            );
        }

        for (table, column) in &referenced_columns {
            let exists: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('{}') WHERE name = '{}'",
                        table, column
                    ),
                    [],
                    |row| row.get(0),
                )
                .expect(&format!(
                    "Failed to check column existence: {}.{}",
                    table, column
                ));
            assert_eq!(
                exists, 1,
                "Column '{}.{}' referenced in migration contract should exist after all migrations",
                table, column
            );
        }

        let critical_tables = [
            "folders",
            "files",
            "questions",
            "exam_sheets",
            "essay_sessions",
            "resources",
            "notes",
            "translations",
        ];

        for table in critical_tables {
            assert!(
                referenced_tables.contains(table),
                "Critical table '{}' should be covered by migration contract",
                table
            );
        }

        assert!(
            referenced_tables.len() >= 20,
            "VFS migration contract should cover at least 20 tables, got {}",
            referenced_tables.len()
        );

        println!(
            "[VFS Migration Test] contract coverage: {} tables, {} columns",
            referenced_tables.len(),
            referenced_columns.len()
        );
    }

    /// 测试 VFS 从空数据库初始化的完整性
    ///
    /// 此测试专门验证从零开始创建 VFS 数据库的场景，确保：
    /// 1. 所有 35 个迁移都能成功执行
    /// 2. 迁移后数据库结构完整
    /// 3. 迁移记录正确
    #[test]
    fn test_vfs_migration_from_scratch() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 确保目录为空（模拟全新安装）
        let db_dir = temp_dir.path().join("databases");
        assert!(
            !db_dir.exists(),
            "Database directory should not exist before init"
        );

        // 初始化数据库
        let db =
            VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase from scratch");

        // 验证数据库文件已创建
        assert!(
            db_dir.exists(),
            "Database directory should exist after init"
        );
        assert!(
            db_dir.join("vfs.db").exists(),
            "vfs.db file should exist after init"
        );

        let conn = db.get_conn().expect("Failed to get connection");

        // 验证迁移版本
        let version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM vfs_schema_history WHERE success = 1 OR success IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get version");
        assert_eq!(
            version, VFS_SCHEMA_VERSION,
            "Fresh database should be at version {}, got {}",
            VFS_SCHEMA_VERSION, version
        );

        // 验证迁移记录完整（每个版本一条记录）
        let migration_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vfs_schema_history", [], |row| {
                row.get(0)
            })
            .expect("Failed to count migrations");
        assert_eq!(
            migration_count as u32, VFS_SCHEMA_VERSION,
            "Should have exactly {} migration records, got {}",
            VFS_SCHEMA_VERSION, migration_count
        );

        // 验证核心表都已创建
        let core_tables = [
            "resources",
            "blobs",
            "notes",
            "notes_versions",
            "files",
            "translations",
            "exam_sheets",
            "essays",
            "folders",
            "folder_items",
            "path_cache",
            "essay_sessions",
            "questions",
            "question_history",
            "review_plans",
            "review_history",
            "vfs_index_units",
            "vfs_index_segments",
        ];

        for table in core_tables {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .expect(&format!("Failed to check table: {}", table));
            assert_eq!(
                exists, 1,
                "Core table '{}' should exist in fresh database",
                table
            );
        }

        // 验证外键约束启用
        let fk_enabled: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("Failed to check foreign_keys");
        assert_eq!(fk_enabled, 1, "Foreign keys should be enabled");

        // 验证 WAL 模式启用
        let journal_mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .expect("Failed to check journal_mode");
        assert_eq!(
            journal_mode.to_lowercase(),
            "wal",
            "WAL mode should be enabled"
        );
    }

    /// 测试 VFS Schema 验证 - 验证关键表和列存在
    ///
    /// 专门测试用户要求的关键表：folders, files, questions, exam_sheets, essay_sessions
    #[test]
    fn test_vfs_schema_verification() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证关键表存在
        let critical_tables = [
            (
                "folders",
                vec![
                    "id",
                    "parent_id",
                    "title",
                    "is_expanded",
                    "sort_order",
                    "deleted_at",
                    "created_at",
                    "updated_at",
                ],
            ),
            (
                "files",
                vec![
                    "id",
                    "type",
                    "name",
                    "mime_type",
                    "size",
                    "deleted_at",
                    "created_at",
                ],
            ),
            (
                "questions",
                vec![
                    "id",
                    "exam_id",
                    "content",
                    "status",
                    "created_at",
                    "updated_at",
                ],
            ),
            (
                "exam_sheets",
                vec!["id", "exam_name", "deleted_at", "created_at", "updated_at"],
            ),
            (
                "essay_sessions",
                vec!["id", "title", "deleted_at", "created_at", "updated_at"],
            ),
        ];

        for (table, expected_columns) in critical_tables {
            // 验证表存在
            let table_exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .expect(&format!("Failed to check table: {}", table));
            assert_eq!(table_exists, 1, "Critical table '{}' should exist", table);

            // 获取表的所有列
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info({})", table))
                .expect(&format!("Failed to prepare PRAGMA for {}", table));
            let actual_columns: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .expect("Failed to query columns")
                .filter_map(|r| r.ok())
                .collect();

            // 验证关键列存在
            for col in expected_columns {
                assert!(
                    actual_columns.contains(&col.to_string()),
                    "Table '{}' should have column '{}', actual columns: {:?}",
                    table,
                    col,
                    actual_columns
                );
            }
        }

        // 验证迁移版本正确
        let version = db
            .get_schema_version()
            .expect("Failed to get schema version");
        assert_eq!(
            version, VFS_SCHEMA_VERSION,
            "Schema version should be {} after verification",
            VFS_SCHEMA_VERSION
        );
    }

    /// 测试 VFS 迁移 032 完整性验证
    ///
    /// ★ P1-13: 验证 `_migration_032_validation` 表存在并记录了迁移完整性检查结果
    ///
    /// 迁移 032 是 textbooks/attachments → files 的统一存储迁移，
    /// 包含以下完整性检查：
    /// 1. folder_items 中是否存在悬挂引用
    /// 2. resources 中是否存在悬挂引用
    ///
    /// 此测试验证：
    /// 1. _migration_032_validation 表存在（迁移后保留用于验证）
    /// 2. 表中包含预期的检查记录
    /// 3. orphan_count 字段记录了悬挂引用数量
    #[test]
    fn test_vfs_migration_032_integrity_validation() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 初始化 VFS 数据库（会执行所有迁移，包括 032）
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to init VfsDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        // 1. 验证 _migration_032_validation 表存在
        let validation_table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_migration_032_validation'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check _migration_032_validation table");
        assert_eq!(
            validation_table_exists, 1,
            "_migration_032_validation table should exist after VFS migration"
        );

        // 2. 验证表结构正确
        let mut stmt = conn
            .prepare("PRAGMA table_info(_migration_032_validation)")
            .expect("Failed to prepare PRAGMA");
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query columns")
            .filter_map(|r| r.ok())
            .collect();

        assert!(
            columns.contains(&"check_name".to_string()),
            "_migration_032_validation should have check_name column"
        );
        assert!(
            columns.contains(&"orphan_count".to_string()),
            "_migration_032_validation should have orphan_count column"
        );
        assert!(
            columns.contains(&"details".to_string()),
            "_migration_032_validation should have details column"
        );

        // 3. 验证预期的检查记录存在
        let check_records: Vec<(String, i64)> = conn
            .prepare("SELECT check_name, orphan_count FROM _migration_032_validation")
            .expect("Failed to prepare query")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("Failed to query")
            .filter_map(|r| r.ok())
            .collect();

        // 迁移 032 应该记录两个检查：folder_items_orphans 和 resources_orphans
        let check_names: Vec<&str> = check_records
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert!(
            check_names.contains(&"folder_items_orphans"),
            "Should have folder_items_orphans check record, got: {:?}",
            check_names
        );
        assert!(
            check_names.contains(&"resources_orphans"),
            "Should have resources_orphans check record, got: {:?}",
            check_names
        );

        // 4. 对于全新数据库，悬挂引用数量应该为 0
        for (check_name, orphan_count) in &check_records {
            assert_eq!(
                *orphan_count, 0,
                "Fresh database should have 0 orphan count for {}, got {}",
                check_name, orphan_count
            );
        }

        // 5. 验证 files 表已正确创建（迁移 032 的主要结果）
        let files_table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='files'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check files table");
        assert_eq!(
            files_table_exists, 1,
            "files table should exist after migration 032"
        );

        // 6. 验证 attachments 表已被删除（迁移 032 的清理步骤）
        let attachments_table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='attachments'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check attachments table");
        assert_eq!(
            attachments_table_exists, 0,
            "attachments table should be dropped after migration 032"
        );

        // 7. 验证 _migration_032_id_map 临时表已被删除
        let id_map_table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_migration_032_id_map'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check _migration_032_id_map table");
        assert_eq!(
            id_map_table_exists, 0,
            "_migration_032_id_map temporary table should be dropped after migration"
        );
    }
}

// ============================================================================
// LLM Usage 数据库迁移测试
// ============================================================================

mod llm_usage_migration_tests {
    use super::*;
    // 导入 LlmUsage 版本常量，用于精确版本断言
    use deep_student_lib::llm_usage::{LlmUsageDatabase, LLM_USAGE_SCHEMA_VERSION};

    /// 测试 LLM Usage 数据库 v1 到 latest 的完整迁移路径
    ///
    /// ## 断言说明
    /// 使用精确版本匹配而非 `>= 1` 的宽松断言，原因：
    /// - 确保迁移完整执行到最新版本，而非仅检查是否执行了任意迁移
    /// - 当版本常量更新时测试会失败，提醒开发者确认迁移逻辑正确
    #[test]
    fn test_llm_usage_migration_path_v1_to_latest() {
        // 创建临时目录
        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 使用真实的 LlmUsageDatabase 迁移路径
        let db = LlmUsageDatabase::new(temp_dir.path()).expect("Failed to init LlmUsageDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证版本更新 - 必须精确匹配当前 schema 版本
        // 使用 assert_eq! 而非 assert!(>= 1)，确保迁移完整执行
        let final_version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get final version");
        assert_eq!(
            final_version, LLM_USAGE_SCHEMA_VERSION,
            "Migration should reach exactly LLM_USAGE_SCHEMA_VERSION ({}), got {}",
            LLM_USAGE_SCHEMA_VERSION, final_version
        );

        // 验证关键表存在
        let logs_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='llm_usage_logs'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check llm_usage_logs table");
        assert_eq!(
            logs_exists, 1,
            "llm_usage_logs table should exist after migration"
        );

        let daily_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='llm_usage_daily'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check llm_usage_daily table");
        assert_eq!(
            daily_exists, 1,
            "llm_usage_daily table should exist after migration"
        );
    }

    /// 测试 LLM Usage Schema 完整性验证
    ///
    /// 验证迁移后所有关键表和列都正确创建
    #[test]
    fn test_llm_usage_schema_integrity() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");

        // 使用真实的 LlmUsageDatabase
        let db = LlmUsageDatabase::new(temp_dir.path()).expect("Failed to init LlmUsageDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        // 验证外键约束启用
        let fk_enabled: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("Failed to check foreign keys");
        assert_eq!(fk_enabled, 1, "Foreign keys should be enabled");

        // 验证 schema_version 表结构
        let mut stmt = conn
            .prepare("PRAGMA table_info(schema_version)")
            .expect("Failed to prepare PRAGMA");
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query columns")
            .filter_map(|r| r.ok())
            .collect();

        assert!(
            columns.contains(&"version".to_string()),
            "schema_version should have version column"
        );
        assert!(
            columns.contains(&"applied_at".to_string()),
            "schema_version should have applied_at column"
        );
        assert!(
            columns.contains(&"description".to_string()),
            "schema_version should have description column"
        );

        // 验证 llm_usage_logs 表关键列
        let expected_logs_columns = vec![
            "id",
            "timestamp",
            "provider",
            "model",
            "adapter",
            "api_config_id",
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "reasoning_tokens",
            "cached_tokens",
            "token_source",
            "duration_ms",
            "request_bytes",
            "response_bytes",
            "first_token_ms",
            "caller_type",
            "session_id",
            "status",
            "error_message",
            "cost_estimate",
        ];

        let mut stmt = conn
            .prepare("PRAGMA table_info(llm_usage_logs)")
            .expect("Failed to prepare PRAGMA");
        let logs_columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query columns")
            .filter_map(|r| r.ok())
            .collect();

        for col in expected_logs_columns {
            assert!(
                logs_columns.contains(&col.to_string()),
                "llm_usage_logs should have {} column, actual columns: {:?}",
                col,
                logs_columns
            );
        }

        // 验证 llm_usage_daily 表关键列
        let expected_daily_columns = vec![
            "date",
            "caller_type",
            "model",
            "provider",
            "request_count",
            "success_count",
            "error_count",
            "total_prompt_tokens",
            "total_completion_tokens",
            "total_tokens",
            "total_reasoning_tokens",
            "total_cached_tokens",
            "total_cost_estimate",
            "avg_duration_ms",
            "total_duration_ms",
            "created_at",
            "updated_at",
        ];

        let mut stmt = conn
            .prepare("PRAGMA table_info(llm_usage_daily)")
            .expect("Failed to prepare PRAGMA");
        let daily_columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("Failed to query columns")
            .filter_map(|r| r.ok())
            .collect();

        for col in expected_daily_columns {
            assert!(
                daily_columns.contains(&col.to_string()),
                "llm_usage_daily should have {} column, actual columns: {:?}",
                col,
                daily_columns
            );
        }

        // 验证关键索引存在
        let indexes = [
            "idx_llm_usage_logs_timestamp",
            "idx_llm_usage_logs_date_key",
            "idx_llm_usage_logs_caller_type",
            "idx_llm_usage_logs_model",
            "idx_llm_usage_daily_date",
        ];

        for index in indexes {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [index],
                    |row| row.get(0),
                )
                .expect("Failed to check index existence");
            assert_eq!(exists, 1, "Index {} should exist", index);
        }
    }

    /// 测试 LLM Usage 迁移幂等性
    ///
    /// 验证重复创建数据库实例不会产生错误，迁移应该是幂等的
    #[test]
    fn test_llm_usage_migration_idempotency() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_dir = temp_dir.path();

        // 第一次创建和迁移
        {
            let db =
                LlmUsageDatabase::new(db_dir).expect("Failed to init LlmUsageDatabase first time");
            let version1 = db
                .get_schema_version()
                .expect("Failed to get schema version");
            assert_eq!(
                version1, LLM_USAGE_SCHEMA_VERSION,
                "First migration should reach latest version"
            );

            // 插入测试数据
            let conn = db.get_conn().expect("Failed to get connection");
            conn.execute(
                r#"
                INSERT INTO llm_usage_logs (
                    id, timestamp, provider, model, prompt_tokens, completion_tokens,
                    total_tokens, caller_type, status
                ) VALUES (
                    'usage_idempotent_test', '2025-01-23T10:30:00.000Z', 'openai', 'gpt-4o',
                    100, 50, 150, 'chat_v2', 'success'
                )
                "#,
                [],
            )
            .expect("Failed to insert test data");
        }

        // 第二次打开同一数据库（模拟应用重启）
        {
            let db =
                LlmUsageDatabase::new(db_dir).expect("Failed to init LlmUsageDatabase second time");
            let version2 = db
                .get_schema_version()
                .expect("Failed to get schema version");
            assert_eq!(
                version2, LLM_USAGE_SCHEMA_VERSION,
                "Second init should stay at latest version"
            );

            // 验证数据仍然存在
            let conn = db.get_conn().expect("Failed to get connection");
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_idempotent_test'",
                    [],
                    |row| row.get(0),
                )
                .expect("Failed to count records");
            assert_eq!(count, 1, "Test data should persist after second init");
        }

        // 第三次打开，验证迁移记录只有一条
        {
            let db =
                LlmUsageDatabase::new(db_dir).expect("Failed to init LlmUsageDatabase third time");
            let conn = db.get_conn().expect("Failed to get connection");

            // 验证迁移记录数量正确（每个版本只应有一条记录）
            let migration_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM schema_version WHERE version = 1",
                    [],
                    |row| row.get(0),
                )
                .expect("Failed to count migrations");
            assert_eq!(
                migration_count, 1,
                "Version 1 migration should only be recorded once"
            );

            // 验证总迁移记录数等于 SCHEMA_VERSION
            let total_migrations: i64 = conn
                .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
                .expect("Failed to count total migrations");
            assert_eq!(
                total_migrations as u32, LLM_USAGE_SCHEMA_VERSION,
                "Total migration records should equal SCHEMA_VERSION"
            );
        }
    }

    /// 测试 LLM Usage 数据库基本 CRUD 操作
    #[test]
    fn test_llm_usage_crud_operations() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = LlmUsageDatabase::new(temp_dir.path()).expect("Failed to init LlmUsageDatabase");
        let conn = db.get_conn().expect("Failed to get connection");

        // INSERT 测试
        let result = conn.execute(
            r#"
            INSERT INTO llm_usage_logs (
                id, timestamp, provider, model, prompt_tokens, completion_tokens,
                total_tokens, caller_type, status
            ) VALUES (
                'usage_crud_test', '2025-01-23T10:30:00.000Z', 'openai', 'gpt-4o',
                200, 100, 300, 'chat_v2', 'success'
            )
            "#,
            [],
        );
        assert!(result.is_ok(), "INSERT into llm_usage_logs should succeed");

        // SELECT 测试
        let total_tokens: i64 = conn
            .query_row(
                "SELECT total_tokens FROM llm_usage_logs WHERE id = 'usage_crud_test'",
                [],
                |row| row.get(0),
            )
            .expect("SELECT from llm_usage_logs should succeed");
        assert_eq!(total_tokens, 300, "total_tokens should be 300");

        // UPDATE 测试
        let affected = conn
            .execute(
                "UPDATE llm_usage_logs SET status = 'error', error_message = 'test error' WHERE id = 'usage_crud_test'",
                [],
            )
            .expect("UPDATE llm_usage_logs should succeed");
        assert_eq!(affected, 1, "Should update 1 row");

        // 验证 UPDATE 结果
        let status: String = conn
            .query_row(
                "SELECT status FROM llm_usage_logs WHERE id = 'usage_crud_test'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get status");
        assert_eq!(status, "error", "Status should be updated to 'error'");

        // DELETE 测试
        let affected = conn
            .execute(
                "DELETE FROM llm_usage_logs WHERE id = 'usage_crud_test'",
                [],
            )
            .expect("DELETE from llm_usage_logs should succeed");
        assert_eq!(affected, 1, "Should delete 1 row");

        // 验证 DELETE 结果
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_crud_test'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to count");
        assert_eq!(count, 0, "Record should be deleted");
    }

    /// 测试 LLM Usage 迁移回滚机制
    #[test]
    fn test_llm_usage_migration_rollback() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_llm_rollback.db");

        // 创建数据库并模拟迁移回滚场景
        let conn = Connection::open(&db_path).expect("Failed to create database");
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .expect("Failed to set pragmas");

        // 创建 schema_version 表
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now')),
                description TEXT
            );
        "#,
        )
        .expect("Failed to create schema_version table");

        // 创建 llm_usage_logs 表（模拟初始状态）
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS llm_usage_logs (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                provider TEXT,
                model TEXT,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                caller_type TEXT,
                status TEXT NOT NULL DEFAULT 'success'
            );
        "#,
        )
        .expect("Failed to create llm_usage_logs table");

        // 插入初始数据
        conn.execute(
            "INSERT INTO llm_usage_logs (id, timestamp, total_tokens) VALUES ('initial', '2025-01-01', 100)",
            [],
        ).expect("Failed to insert initial data");

        // 开始事务模拟迁移
        conn.execute("BEGIN IMMEDIATE", [])
            .expect("Failed to begin transaction");

        // 执行一些"迁移"操作
        conn.execute(
            "INSERT INTO llm_usage_logs (id, timestamp, total_tokens) VALUES ('migration_data', '2025-01-02', 200)",
            [],
        ).expect("Failed to insert migration data");

        // 模拟迁移失败 - 回滚事务
        conn.execute("ROLLBACK", []).expect("Failed to rollback");

        // 验证回滚成功 - 只有原始数据存在
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM llm_usage_logs", [], |row| row.get(0))
            .expect("Failed to count rows");
        assert_eq!(count, 1, "Should only have initial data after rollback");

        // 验证原始数据完整
        let id: String = conn
            .query_row("SELECT id FROM llm_usage_logs", [], |row| row.get(0))
            .expect("Failed to get id");
        assert_eq!(
            id, "initial",
            "Original data should be preserved after rollback"
        );
    }
}

// ============================================================================
// 通用迁移工具测试
// ============================================================================

mod migration_utils_tests {
    use super::*;

    /// 测试列存在性检查
    #[test]
    fn test_column_exists_check() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_column_check.db");

        let conn = Connection::open(&db_path).expect("Failed to create database");

        // 创建测试表
        conn.execute(
            "CREATE TABLE test_table (id TEXT PRIMARY KEY, existing_col TEXT)",
            [],
        )
        .expect("Failed to create test table");

        // 检查列存在性的辅助函数
        fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
            let sql = format!("PRAGMA table_info({})", table);
            let mut stmt = conn.prepare(&sql).expect("Failed to prepare");
            let columns: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .expect("Failed to query")
                .filter_map(|r| r.ok())
                .collect();
            columns.contains(&column.to_string())
        }

        // 验证存在的列
        assert!(
            column_exists(&conn, "test_table", "existing_col"),
            "existing_col should exist"
        );

        // 验证不存在的列
        assert!(
            !column_exists(&conn, "test_table", "nonexistent_col"),
            "nonexistent_col should not exist"
        );
    }

    /// 测试表存在性检查
    #[test]
    fn test_table_exists_check() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_table_check.db");

        let conn = Connection::open(&db_path).expect("Failed to create database");

        // 创建测试表
        conn.execute("CREATE TABLE existing_table (id TEXT PRIMARY KEY)", [])
            .expect("Failed to create test table");

        // 检查表存在性的辅助函数
        fn table_exists(conn: &Connection, table: &str) -> bool {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            count > 0
        }

        // 验证存在的表
        assert!(
            table_exists(&conn, "existing_table"),
            "existing_table should exist"
        );

        // 验证不存在的表
        assert!(
            !table_exists(&conn, "nonexistent_table"),
            "nonexistent_table should not exist"
        );
    }

    /// 测试事务原子性
    #[test]
    fn test_transaction_atomicity() {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("test_atomicity.db");

        let conn = Connection::open(&db_path).expect("Failed to create database");

        // 创建测试表
        conn.execute(
            "CREATE TABLE atomic_test (id INTEGER PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("Failed to create test table");

        // 插入初始数据
        conn.execute(
            "INSERT INTO atomic_test (id, value) VALUES (1, 'initial')",
            [],
        )
        .expect("Failed to insert initial data");

        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])
            .expect("Failed to begin");

        // 执行多个操作
        conn.execute(
            "INSERT INTO atomic_test (id, value) VALUES (2, 'second')",
            [],
        )
        .expect("Failed to insert second");
        conn.execute("UPDATE atomic_test SET value = 'modified' WHERE id = 1", [])
            .expect("Failed to update");

        // 回滚事务
        conn.execute("ROLLBACK", []).expect("Failed to rollback");

        // 验证原子性 - 所有操作都被回滚
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM atomic_test", [], |row| row.get(0))
            .expect("Failed to count");
        assert_eq!(count, 1, "Should only have initial row");

        let value: String = conn
            .query_row("SELECT value FROM atomic_test WHERE id = 1", [], |row| {
                row.get(0)
            })
            .expect("Failed to get value");
        assert_eq!(
            value, "initial",
            "Value should not be modified after rollback"
        );
    }
}
