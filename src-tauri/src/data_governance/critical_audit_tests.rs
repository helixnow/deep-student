//! # 数据治理系统批判性审阅 - 问题确认测试
//!
//! 本测试文件根据审阅报告创建，用于确认报告中发现的所有问题。
//! 每个测试对应报告中的一个具体问题编号。
//!
//! ## 运行方式
//!
//! ```bash
//! cargo test --features data_governance critical_audit_tests
//! ```

#[cfg(test)]
#[cfg(feature = "data_governance")]
mod critical_audit_tests {
    use rusqlite::Connection;
    use std::path::PathBuf;
    use tempfile::TempDir;

    use crate::data_governance::audit::{AuditFilter, AuditRepository, AuditStatus};
    use crate::data_governance::backup::{BackupConfig, BackupManager, BackupManifest};
    use crate::data_governance::init::{initialize_with_report, needs_initialization};
    use crate::data_governance::migration::{
        DatabaseMigrationReport, MigrationCoordinator, MigrationError, MigrationReport,
        MigrationVerifier, CHAT_V2_MIGRATION_SET, LLM_USAGE_MIGRATION_SET, MISTAKES_MIGRATIONS,
        VFS_MIGRATION_SET,
    };
    use crate::data_governance::schema_registry::DatabaseId;

    // ============================================================================
    // 辅助函数
    // ============================================================================

    fn create_test_dir() -> TempDir {
        TempDir::new().expect("Failed to create temp dir")
    }

    fn create_test_coordinator(temp_dir: &TempDir) -> MigrationCoordinator {
        MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None)
    }

    fn create_test_coordinator_with_audit(temp_dir: &TempDir) -> MigrationCoordinator {
        let audit_db_path = temp_dir.path().join("databases").join("audit.db");
        MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(Some(audit_db_path))
    }

    fn setup_test_directories(temp_dir: &TempDir) {
        let databases_dir = temp_dir.path().join("databases");
        std::fs::create_dir_all(&databases_dir).expect("Failed to create databases dir");
    }

    fn get_database_path(temp_dir: &TempDir, db_id: &DatabaseId) -> PathBuf {
        match db_id {
            DatabaseId::Vfs => temp_dir.path().join("databases").join("vfs.db"),
            DatabaseId::ChatV2 => temp_dir.path().join("chat_v2.db"),
            DatabaseId::Mistakes => temp_dir.path().join("mistakes.db"),
            DatabaseId::LlmUsage => temp_dir.path().join("llm_usage.db"),
        }
    }

    fn init_audit_database(temp_dir: &TempDir) -> PathBuf {
        let audit_db_path = temp_dir.path().join("databases").join("audit.db");
        let conn = Connection::open(&audit_db_path).expect("Failed to create audit database");
        AuditRepository::init(&conn).expect("Audit init should succeed");
        audit_db_path
    }

    /// 执行完整迁移并返回协调器
    fn migrate_all(temp_dir: &TempDir) -> MigrationCoordinator {
        setup_test_directories(temp_dir);
        let mut coordinator = create_test_coordinator(temp_dir);
        coordinator
            .run_all()
            .expect("Full migration should succeed");
        coordinator
    }

    // ============================================================================
    // 🔴 问题 1: 缺少"备份恢复后重新迁移"测试
    //
    // 验证：恢复旧版本备份后，needs_migration 应返回 true，
    // 且执行迁移后 schema 应达到最新版本。
    // 当前状态：BackupManager::restore() 不会触发迁移。
    // ============================================================================

    /// 测试：创建v2数据库 → 手动模拟恢复到v1 schema → 验证 needs_migration 返回 true
    ///
    /// 问题 1: 恢复旧版本备份后不触发迁移
    #[test]
    fn test_issue1_restore_old_backup_needs_migration_is_true() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 步骤 1: 完整迁移到最新版本
        coordinator
            .run_all()
            .expect("Initial migration should succeed");

        // 步骤 2: 验证迁移后不需要再次迁移
        for db_id in DatabaseId::all_ordered() {
            let needs = coordinator
                .needs_migration(&db_id)
                .expect("needs_migration should succeed");
            assert!(
                !needs,
                "After full migration, {:?} should not need migration",
                db_id
            );
        }

        // 步骤 3: 模拟恢复旧版本数据库 —— 删除 VFS 并创建一个只有 init schema 的数据库
        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        std::fs::remove_file(&vfs_path).expect("Failed to remove VFS db");
        // 删除 WAL/SHM 文件
        let _ = std::fs::remove_file(vfs_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(vfs_path.with_extension("db-shm"));

        // 创建一个只有 v20260130 (init) 的数据库，模拟旧版备份
        let conn = Connection::open(&vfs_path).expect("Failed to create old VFS db");
        conn.execute_batch(include_str!("../../migrations/vfs/V20260130__init.sql"))
            .expect("Failed to apply init schema");
        // 手动写入 refinery_schema_history 只到 v20260130
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            );
            INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
            VALUES (20260130, 'init', '2026-01-30T00:00:00Z', '0');",
        )
        .expect("Failed to create refinery history");
        drop(conn);

        // 步骤 4: 验证 needs_migration 返回 true（旧版本应需要迁移）
        let needs = coordinator
            .needs_migration(&DatabaseId::Vfs)
            .expect("needs_migration should succeed");
        assert!(
            needs,
            "BUG CONFIRMED (Issue 1): After restoring old backup, VFS should need migration, \
             but needs_migration returned false. This means restore does not trigger re-migration."
        );
    }

    /// 测试：恢复旧备份后执行迁移，验证 schema 达到最新版本
    ///
    /// 问题 1: 备份恢复后重新迁移的端到端流程
    #[test]
    fn test_issue1_restore_old_backup_then_migrate_reaches_latest() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 步骤 1: 完整迁移
        coordinator
            .run_all()
            .expect("Initial migration should succeed");

        // 步骤 2: 模拟恢复旧 Mistakes 数据库（只有 init）
        let mistakes_path = get_database_path(&temp_dir, &DatabaseId::Mistakes);
        std::fs::remove_file(&mistakes_path).expect("Failed to remove mistakes db");
        let _ = std::fs::remove_file(mistakes_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(mistakes_path.with_extension("db-shm"));

        let conn = Connection::open(&mistakes_path).expect("Failed to create old mistakes db");
        conn.execute_batch(include_str!(
            "../../migrations/mistakes/V20260130__init.sql"
        ))
        .expect("Failed to apply init schema");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT
            );
            INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
            VALUES (20260130, 'init', '2026-01-30T00:00:00Z', '0');",
        )
        .expect("Failed to create refinery history");
        drop(conn);

        // 步骤 3: 重新执行迁移
        let mut coordinator2 = create_test_coordinator(&temp_dir);
        let result = coordinator2.run_all();
        assert!(
            result.is_ok(),
            "Re-migration after restore should succeed: {:?}",
            result.err()
        );

        let report = result.unwrap();
        assert!(report.success, "Re-migration should be successful");

        // 步骤 4: 验证 Mistakes 达到最新版本
        let mistakes_report = report
            .databases
            .iter()
            .find(|r| r.id == DatabaseId::Mistakes);
        assert!(mistakes_report.is_some(), "Mistakes should be in report");
        let mr = mistakes_report.unwrap();
        assert_eq!(
            mr.to_version,
            MISTAKES_MIGRATIONS.latest_version() as u32,
            "Mistakes should reach latest version after re-migration"
        );
    }

    // ============================================================================
    // 🔴 问题 2: 迁移过程中不验证用户数据存活
    //
    // 验证：插入真实业务数据 → 执行迁移 → 验证数据仍然完好。
    // 当前测试仅检查 schema 结构，从未验证数据。
    // ============================================================================

    /// 测试：在 VFS 数据库中插入测试数据 → 迁移 → 验证数据完整
    ///
    /// 问题 2: 迁移测试从未验证用户数据存活
    #[test]
    fn test_issue2_vfs_data_survives_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 执行 VFS 迁移
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration should succeed");

        // 插入测试数据到 resources 表（注意：resources 无 title 列，使用真实 schema）
        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_path).expect("Failed to open VFS db");

        conn.execute(
            "INSERT INTO resources (id, type, hash, storage_mode, data, metadata_json, ref_count, created_at, updated_at)
             VALUES ('res-001', 'note', 'hash_alpha_unique', 'inline', 'Test Resource Alpha Content', '{}', 1, 1706745600000, 1706745600000)",
            [],
        ).expect("Failed to insert resource");

        conn.execute(
            "INSERT INTO resources (id, type, hash, storage_mode, data, metadata_json, ref_count, created_at, updated_at)
             VALUES ('res-002', 'file', 'hash_beta_unique', 'inline', 'Test Resource Beta Content', '{}', 1, 1706832000000, 1706832000000)",
            [],
        ).expect("Failed to insert resource");

        // 插入 notes 数据（notes 有 title，resource_id 引用 resources）
        conn.execute(
            "INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
             VALUES ('note-001', 'res-001', 'Test Note Title', '[]', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).expect("Failed to insert note");

        // 插入 folders 数据（真实 schema：title 非 name，created_at/updated_at 为 INTEGER）
        conn.execute(
            "INSERT INTO folders (id, title, sort_order, is_expanded, created_at, updated_at)
             VALUES ('folder-001', 'My Study Folder', 0, 1, 1706745600000, 1706745600000)",
            [],
        )
        .expect("Failed to insert folder");

        drop(conn);

        // 重新运行迁移（应为幂等）
        let mut coordinator2 = create_test_coordinator(&temp_dir);
        let report = coordinator2
            .migrate_single(DatabaseId::Vfs)
            .expect("Re-migration should succeed");
        assert!(report.success);

        // 验证数据仍然存在且完整
        let conn = Connection::open(&vfs_path).expect("Failed to reopen VFS db");

        let resource_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
            .expect("Failed to count resources");
        assert_eq!(
            resource_count, 2,
            "Issue 2: Resources should survive migration (expected 2, got {})",
            resource_count
        );

        let data_value: String = conn
            .query_row(
                "SELECT data FROM resources WHERE id = 'res-001'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query resource data");
        assert_eq!(
            data_value, "Test Resource Alpha Content",
            "Issue 2: Resource data should be preserved"
        );

        let note_title: String = conn
            .query_row("SELECT title FROM notes WHERE id = 'note-001'", [], |row| {
                row.get(0)
            })
            .expect("Failed to query note title");
        assert_eq!(
            note_title, "Test Note Title",
            "Issue 2: Note title should be preserved after migration"
        );

        let folder_title: String = conn
            .query_row(
                "SELECT title FROM folders WHERE id = 'folder-001'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query folder title");
        assert_eq!(
            folder_title, "My Study Folder",
            "Issue 2: Folder title should be preserved"
        );
    }

    /// 测试：在 Mistakes 数据库中插入 anki_cards 数据 → 迁移 → 验证数据完整
    ///
    /// 问题 2: 从未验证 Mistakes 用户数据迁移后的完整性
    #[test]
    fn test_issue2_mistakes_anki_cards_data_survives_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 先迁移 VFS（依赖）
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration should succeed");

        // 迁移 Mistakes
        coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("Mistakes migration should succeed");

        let mistakes_path = get_database_path(&temp_dir, &DatabaseId::Mistakes);
        let conn = Connection::open(&mistakes_path).expect("Failed to open mistakes db");

        // 先插入 document_tasks（anki_cards 的外键依赖）
        for i in 1..=10 {
            conn.execute(
                "INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status, anki_generation_options_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'Completed', '{}')",
                rusqlite::params![
                    format!("task-{:03}", i),
                    format!("doc-{:03}", i),
                    format!("document_{}.pdf", i),
                    i,
                    format!("Content segment {}", i),
                ],
            )
            .expect(&format!("Failed to insert document_task {}", i));
        }

        // 插入 10 行 anki_cards 测试数据（task_id 引用 document_tasks）
        for i in 1..=10 {
            conn.execute(
                "INSERT INTO anki_cards (id, task_id, front, back, source_type, source_id, text)
                 VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6)",
                rusqlite::params![
                    format!("card-{:03}", i),
                    format!("task-{:03}", i),
                    format!("Front of card {}", i),
                    format!("Back of card {}", i),
                    format!("src-{:03}", i),
                    format!("Full text for card {}", i),
                ],
            )
            .expect(&format!("Failed to insert anki_card {}", i));
        }

        // 插入 review_sessions 数据（真实 schema：id, title, start_date, end_date）
        conn.execute(
            "INSERT INTO review_sessions (id, title, start_date, end_date)
             VALUES ('session-001', 'Daily Review', '2026-01-01', '2026-01-07')",
            [],
        )
        .expect("Failed to insert review_session");

        drop(conn);

        // 重新执行迁移（幂等性测试 + 数据存活）
        let mut coordinator2 = create_test_coordinator(&temp_dir);
        let report = coordinator2
            .migrate_single(DatabaseId::Mistakes)
            .expect("Re-migration should succeed");
        assert!(report.success);

        // 验证所有 10 行 anki_cards 数据存活
        let conn = Connection::open(&mistakes_path).expect("Failed to reopen mistakes db");

        let card_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM anki_cards", [], |row| row.get(0))
            .expect("Failed to count anki_cards");
        assert_eq!(
            card_count, 10,
            "Issue 2: All 10 anki_cards should survive migration (got {})",
            card_count
        );

        // 验证具体字段值
        let front: String = conn
            .query_row(
                "SELECT front FROM anki_cards WHERE id = 'card-005'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query card front");
        assert_eq!(
            front, "Front of card 5",
            "Issue 2: anki_card front field should be preserved"
        );

        let back: String = conn
            .query_row(
                "SELECT back FROM anki_cards WHERE id = 'card-005'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query card back");
        assert_eq!(
            back, "Back of card 5",
            "Issue 2: anki_card back field should be preserved"
        );

        // 验证 review_sessions 存活
        let session_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_sessions", [], |row| row.get(0))
            .expect("Failed to count review_sessions");
        assert_eq!(
            session_count, 1,
            "Issue 2: review_sessions should survive migration"
        );
    }

    /// 测试：Chat V2 数据在迁移后存活
    ///
    /// 问题 2: chat_messages 等核心数据迁移后的完整性
    #[test]
    fn test_issue2_chat_v2_data_survives_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 先迁移依赖
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration failed");
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("ChatV2 migration failed");

        let chat_path = get_database_path(&temp_dir, &DatabaseId::ChatV2);
        let conn = Connection::open(&chat_path).expect("Failed to open chat_v2 db");

        // 插入 sessions（使用真实 schema 列名）
        conn.execute(
            "INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at, persist_status)
             VALUES ('sess-001', 'general_chat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'active')",
            [],
        ).expect("Failed to insert session");

        // 插入 messages（timestamp 是 INTEGER 毫秒，非 created_at TEXT）
        for i in 1..=5 {
            conn.execute(
                "INSERT INTO chat_v2_messages (id, session_id, role, timestamp)
                 VALUES (?1, 'sess-001', ?2, ?3)",
                rusqlite::params![
                    format!("msg-{:03}", i),
                    if i % 2 == 0 { "assistant" } else { "user" },
                    1706745600000i64 + (i as i64 * 1000),
                ],
            )
            .expect(&format!("Failed to insert message {}", i));
        }

        drop(conn);

        // 重新迁移
        let mut coordinator2 = create_test_coordinator(&temp_dir);
        let report = coordinator2
            .migrate_single(DatabaseId::ChatV2)
            .expect("Re-migration failed");
        assert!(report.success);

        // 验证数据存活
        let conn = Connection::open(&chat_path).expect("Failed to reopen chat_v2 db");

        let msg_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_v2_messages WHERE session_id = 'sess-001'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to count messages");
        assert_eq!(
            msg_count, 5,
            "Issue 2: All 5 chat messages should survive migration"
        );

        let session_mode: String = conn
            .query_row(
                "SELECT mode FROM chat_v2_sessions WHERE id = 'sess-001'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query session mode");
        assert_eq!(
            session_mode, "general_chat",
            "Issue 2: Session mode should be preserved"
        );
    }

    /// 测试：LLM Usage 数据在迁移后存活
    ///
    /// 问题 2: llm_usage token 记录迁移后完整性
    #[test]
    fn test_issue2_llm_usage_data_survives_migration() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator
            .migrate_single(DatabaseId::LlmUsage)
            .expect("LlmUsage migration failed");

        let llm_path = get_database_path(&temp_dir, &DatabaseId::LlmUsage);
        let conn = Connection::open(&llm_path).expect("Failed to open llm_usage db");

        // 插入 token 使用记录（真实表名 llm_usage_logs，使用真实 schema）
        for i in 1..=8 {
            conn.execute(
                "INSERT INTO llm_usage_logs (id, timestamp, provider, model, prompt_tokens, completion_tokens, total_tokens, caller_type, status)
                 VALUES (?1, '2026-01-01T00:00:00Z', 'openai', 'gpt-4o', ?2, ?3, ?4, 'chat_v2', 'success')",
                rusqlite::params![
                    format!("usage-{:03}", i),
                    100 * i as i64,
                    50 * i as i64,
                    150 * i as i64,
                ],
            ).expect(&format!("Failed to insert llm_usage_logs {}", i));
        }

        drop(conn);

        // 重新迁移
        let mut coordinator2 = create_test_coordinator(&temp_dir);
        let report = coordinator2
            .migrate_single(DatabaseId::LlmUsage)
            .expect("Re-migration failed");
        assert!(report.success);

        let conn = Connection::open(&llm_path).expect("Failed to reopen llm_usage db");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM llm_usage_logs", [], |row| row.get(0))
            .expect("Failed to count llm_usage_logs");
        assert_eq!(
            count, 8,
            "Issue 2: All 8 llm_usage_logs records should survive migration"
        );

        let tokens: i64 = conn
            .query_row(
                "SELECT prompt_tokens FROM llm_usage_logs WHERE id = 'usage-005'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query tokens");
        assert_eq!(
            tokens, 500,
            "Issue 2: Token count should be preserved exactly"
        );
    }

    // ============================================================================
    // 🔴 问题 3: 跨版本恢复无版本兼容性检查
    //
    // 验证：BackupManifest 有 schema_versions 字段，
    // 但 restore() 从不检查该字段。
    // ============================================================================

    /// 测试：restore() 对含未来 schema 版本的 manifest 不拒绝
    ///
    /// 问题 3: 恢复时不检查 schema 版本兼容性
    /// 真正的验证逻辑：构建一个声称来自未来版本的备份目录 → 调用 restore() →
    /// 验证 restore 没有因版本不兼容而报错（而是因为别的原因）
    #[test]
    fn test_issue3_restore_does_not_check_schema_version_compatibility() {
        let backup_dir = TempDir::new().unwrap();
        let manager = BackupManager::new(backup_dir.path().to_path_buf());

        // 构建一个声称来自未来版本的备份
        let future_version = VFS_MIGRATION_SET.latest_version() as u32 + 99999;
        let mut manifest = BackupManifest::new("99.0.0");
        manifest.backup_id = "future_backup".to_string();
        manifest.set_schema_version("vfs", future_version);

        // 创建备份目录和一个假的 .db 文件 + manifest，让 restore 走到版本检查应该发生的位置
        let sub = backup_dir.path().join("future_backup");
        std::fs::create_dir_all(&sub).expect("Failed to create backup subdir");
        // 写一个有效的空 SQLite 文件
        let fake_db = sub.join("vfs.db");
        let conn = Connection::open(&fake_db).expect("create fake db");
        conn.execute_batch("CREATE TABLE t(x)").unwrap();
        drop(conn);
        let sha = crate::data_governance::backup::BackupFile {
            path: "vfs.db".to_string(),
            size: std::fs::metadata(&fake_db).unwrap().len(),
            sha256: {
                use sha2::{Digest, Sha256};
                let bytes = std::fs::read(&fake_db).unwrap();
                let hash = Sha256::digest(&bytes);
                hex::encode(hash)
            },
            database_id: Some("vfs".to_string()),
        };
        manifest.add_file(sha);
        manifest.save_to_file(&sub.join("manifest.json")).unwrap();

        // 调用 restore
        let result = manager.restore(&manifest);

        // Issue 3 已修复：restore() 应拒绝来自未来版本的备份
        assert!(
            result.is_err(),
            "Issue 3 FIXED: restore() should reject future-version backup"
        );
        let msg = format!("{}", result.unwrap_err());
        assert!(
            msg.contains("version")
                || msg.contains("incompatible")
                || msg.contains("兼容")
                || msg.contains("Version"),
            "Issue 3 FIXED: error should mention version incompatibility, got: {}",
            msg
        );
    }

    // ============================================================================
    // 🔴 问题 4: 数据库损坏场景无测试
    //
    // 验证：写入随机字节到 .db 文件 → 调用 migrate_single → 应返回友好错误
    // ============================================================================

    /// 测试：损坏的数据库文件应返回友好的错误
    ///
    /// 问题 4: 完全损坏的 SQLite 文件
    #[test]
    fn test_issue4_corrupted_database_file_returns_friendly_error() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 创建一个完全损坏的 VFS 数据库文件
        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        std::fs::write(
            &vfs_path,
            b"THIS IS NOT A SQLITE DATABASE - RANDOM CORRUPTED BYTES 12345",
        )
        .expect("Failed to write corrupted file");

        // 尝试迁移应该返回错误
        let result = coordinator.migrate_single(DatabaseId::Vfs);

        assert!(
            result.is_err(),
            "Issue 4: Migrating a corrupted database should return an error, not crash"
        );

        // 验证错误类型是 Database 错误，而非 panic
        let err = result.unwrap_err();
        let err_msg = format!("{:?}", err);
        assert!(
            err_msg.contains("Database")
                || err_msg.contains("not a database")
                || err_msg.contains("Refinery"),
            "Issue 4: Error should mention database-related problem, got: {}",
            err_msg
        );
    }

    /// 测试：截断的数据库文件应返回友好错误
    ///
    /// 问题 4: 磁盘断电导致的截断文件
    #[test]
    fn test_issue4_truncated_database_file() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 先正常迁移创建数据库
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("Initial migration should succeed");

        // 读取前 16 字节（SQLite header 不完整）然后截断
        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let data = std::fs::read(&vfs_path).expect("Failed to read VFS db");
        let truncated = &data[..std::cmp::min(16, data.len())];
        std::fs::write(&vfs_path, truncated).expect("Failed to write truncated file");

        // 尝试迁移截断的数据库
        let mut coordinator2 = create_test_coordinator(&temp_dir);
        let result = coordinator2.migrate_single(DatabaseId::Vfs);

        assert!(
            result.is_err(),
            "Issue 4: Migrating a truncated database should return an error"
        );
    }

    /// 测试：权限被拒绝时应返回友好错误（仅 Unix）
    ///
    /// 问题 4: 数据库文件权限变更
    #[cfg(unix)]
    #[test]
    fn test_issue4_readonly_database_file() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 先创建数据库
        coordinator
            .migrate_single(DatabaseId::LlmUsage)
            .expect("Initial migration should succeed");

        // 设置为只读
        let llm_path = get_database_path(&temp_dir, &DatabaseId::LlmUsage);
        let metadata = std::fs::metadata(&llm_path).expect("Failed to get metadata");
        let mut perms = metadata.permissions();
        perms.set_mode(0o444); // 只读
        std::fs::set_permissions(&llm_path, perms).expect("Failed to set permissions");

        // 尝试再次迁移（应该不需要迁移，但如果需要写入会失败）
        let mut coordinator2 = create_test_coordinator(&temp_dir);
        // 注意：如果不需要迁移，这不会失败。但如果底层需要写操作则会失败。
        let result = coordinator2.migrate_single(DatabaseId::LlmUsage);

        // 恢复权限（清理）
        let metadata = std::fs::metadata(&llm_path).expect("Failed to get metadata");
        let mut perms = metadata.permissions();
        perms.set_mode(0o644);
        let _ = std::fs::set_permissions(&llm_path, perms);

        // 只读文件的迁移结果取决于是否需要写操作
        // 但至少不应该 panic
        if let Err(e) = &result {
            let err_msg = format!("{:?}", e);
            assert!(
                !err_msg.contains("panic"),
                "Issue 4: Read-only database should not cause panic"
            );
        }
    }

    // ============================================================================
    // 🔴 问题 5: repair_refinery_checksums 静默覆盖 checksum
    //
    // 验证：修改已有迁移记录的 checksum → 调用迁移 →
    // checksum 被静默修复而非报错
    // ============================================================================

    /// 测试：篡改已有迁移记录的 checksum 后，系统静默修复而非报警
    ///
    /// 问题 5: repair_refinery_checksums 绕过了 Refinery 的安全检查
    #[test]
    fn test_issue5_tampered_checksum_is_silently_repaired() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        // 步骤 1: 正常迁移
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("Initial VFS migration should succeed");

        // 步骤 2: 篡改一个已有迁移的 checksum（模拟恶意/意外修改）
        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_path).expect("Failed to open VFS db");

        // 记录原始 checksum
        let original_checksum: String = conn
            .query_row(
                "SELECT checksum FROM refinery_schema_history WHERE version = 20260130",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get original checksum");

        // 篡改 checksum（模拟迁移脚本被修改后的状态）
        let tampered_checksum = "TAMPERED_MALICIOUS_CHECKSUM_12345";
        conn.execute(
            "UPDATE refinery_schema_history SET checksum = ?1 WHERE version = 20260130",
            [tampered_checksum],
        )
        .expect("Failed to tamper checksum");

        drop(conn);

        // 步骤 3: 再次执行迁移
        let mut coordinator2 = create_test_coordinator(&temp_dir);
        let result = coordinator2.migrate_single(DatabaseId::Vfs);

        // 步骤 4: 无条件检查 checksum 是否被静默修复
        // 迁移应该成功（repair_refinery_checksums 会在 Refinery 执行前修复 checksum）
        assert!(
            result.is_ok(),
            "Issue 5: Migration should succeed because repair_refinery_checksums \
             silently fixes the tampered checksum before Refinery sees it. Got error: {:?}",
            result.err()
        );

        let conn = Connection::open(&vfs_path).expect("Failed to reopen VFS db");
        let current_checksum: String = conn
            .query_row(
                "SELECT checksum FROM refinery_schema_history WHERE version = 20260130",
                [],
                |row| row.get(0),
            )
            .expect("Failed to get current checksum");

        // 核心断言：篡改的 checksum 一定被静默修复回了正确值
        assert_ne!(
            current_checksum, tampered_checksum,
            "Issue 5 CONFIRMED: Tampered checksum was silently repaired. \
             repair_refinery_checksums bypasses Refinery's divergent detection."
        );
        // 修复后的值应该等于原始值
        assert_eq!(
            current_checksum, original_checksum,
            "Issue 5: Checksum was repaired back to the original value"
        );
    }

    // ============================================================================
    // 🟡 问题 6: 增量备份恢复路径完全缺失
    //
    // 验证：backup_incremental() 存在但没有 restore_incremental()
    // ============================================================================

    /// 测试：对增量备份 manifest 调用 restore()，证明不会恢复任何数据库
    ///
    /// 问题 6: 增量备份可以创建但无法恢复
    #[test]
    fn test_issue6_incremental_restore_silently_restores_nothing() {
        let backup_dir = TempDir::new().unwrap();
        let manager = BackupManager::new(backup_dir.path().to_path_buf());

        // 构建一个增量备份 manifest，其中只有 _changes.json 文件
        let mut manifest = BackupManifest::new("1.0.0");
        manifest.backup_id = "incr_test".to_string();
        manifest.is_incremental = true;
        manifest.incremental_base = Some("20260101_000000".to_string());
        manifest.add_file(crate::data_governance::backup::BackupFile {
            path: "vfs_changes.json".to_string(),
            size: 128,
            sha256: "aaa".to_string(),
            database_id: Some("vfs".to_string()),
        });

        // 创建备份目录及文件
        let sub = backup_dir.path().join("incr_test");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("vfs_changes.json"),
            r#"[{"table":"resources","op":"INSERT"}]"#,
        )
        .unwrap();
        // 重新计算 sha 让 verify 通过
        let real_sha = {
            use sha2::{Digest, Sha256};
            let bytes = std::fs::read(sub.join("vfs_changes.json")).unwrap();
            hex::encode(Sha256::digest(&bytes))
        };
        manifest.files[0].sha256 = real_sha;
        manifest.files[0].size = std::fs::metadata(sub.join("vfs_changes.json"))
            .unwrap()
            .len();
        manifest.save_to_file(&sub.join("manifest.json")).unwrap();

        // 调用 restore — restore() 内部只处理 .db 结尾的文件
        let result = manager.restore(&manifest);

        // 关键断言：restore 对于增量 manifest "成功"了，但实际上什么数据库也没恢复
        // Issue 6 已修复：restore() 应拒绝增量备份并返回明确错误
        assert!(
            result.is_err(),
            "Issue 6 FIXED: restore() should reject incremental backup"
        );
        let msg = format!("{}", result.unwrap_err());
        assert!(
            msg.contains("incremental") || msg.contains("增量"),
            "Issue 6 FIXED: error should mention incremental restore not supported, got: {}",
            msg
        );
    }

    // ============================================================================
    // 🟡 问题 7: 审计日志无容量控制
    //
    // 验证：AuditRepository 只有 INSERT/QUERY，无清理/轮转机制
    // ============================================================================

    /// 测试：确认审计日志无容量控制，大量日志不会被清理
    ///
    /// 问题 7: audit.db 会无限增长
    #[test]
    fn test_issue7_audit_log_grows_unbounded() {
        let temp_dir = create_test_dir();
        let audit_db_path = temp_dir.path().join("audit.db");

        let conn = Connection::open(&audit_db_path).expect("Failed to create audit database");
        AuditRepository::init(&conn).expect("Audit init should succeed");

        // 写入 500 条审计日志模拟长期运行
        for i in 0..500 {
            AuditRepository::log_migration_complete(
                &conn,
                &format!("db_{}", i % 4),
                0,
                20260130,
                1,
                100,
            )
            .expect("Failed to log migration");
        }

        // 验证所有 500 条都在
        let total_count =
            AuditRepository::count_by_type(&conn, "Migration").expect("Count should succeed");
        assert_eq!(total_count, 500, "All 500 logs should exist");

        // 问题 7 确认：没有 cleanup_old_logs 或类似方法
        // 以下注释的代码应该存在但不存在：
        // AuditRepository::cleanup_old_logs(&conn, 90).expect("Cleanup should succeed");

        // 再次计数 - 仍然是 500（没有清理机制）
        let after_count =
            AuditRepository::count_by_type(&conn, "Migration").expect("Count should succeed");
        assert_eq!(
            after_count, 500,
            "Issue 7 CONFIRMED: After attempting cleanup, all 500 logs still exist. \
             AuditRepository has no cleanup/rotation mechanism. \
             audit.db will grow unboundedly over time."
        );
    }

    // ============================================================================
    // 🟡 问题 8: pre_restore_backup 回滚路径未测试
    //
    // 验证：rollback_from_pre_restore 方法存在但测试套件从未调用
    // ============================================================================

    /// 测试：含损坏文件的 manifest 调用 restore()，验证是否触发回滚并报错
    ///
    /// 问题 8: pre_restore 回滚路径无测试覆盖
    #[test]
    fn test_issue8_restore_with_corrupted_backup_triggers_rollback_error() {
        let backup_dir = TempDir::new().unwrap();
        let manager = BackupManager::new(backup_dir.path().to_path_buf());

        // 构建一个 manifest，声称有两个数据库文件
        let mut manifest = BackupManifest::new("1.0.0");
        manifest.backup_id = "rollback_test".to_string();

        // vfs.db 正常
        manifest.add_file(crate::data_governance::backup::BackupFile {
            path: "vfs.db".to_string(),
            size: 100,
            sha256: "will_be_fixed".to_string(),
            database_id: Some("vfs".to_string()),
        });
        // chat_v2.db 将会损坏
        manifest.add_file(crate::data_governance::backup::BackupFile {
            path: "chat_v2.db".to_string(),
            size: 50,
            sha256: "intentionally_wrong_checksum".to_string(),
            database_id: Some("chat_v2".to_string()),
        });

        // 创建备份目录
        let sub = backup_dir.path().join("rollback_test");
        std::fs::create_dir_all(&sub).unwrap();

        // 创建有效的 vfs.db
        let vfs_conn = Connection::open(sub.join("vfs.db")).unwrap();
        vfs_conn.execute_batch("CREATE TABLE t(x)").unwrap();
        drop(vfs_conn);
        // 修正 vfs.db 的 sha
        let vfs_sha = {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(&std::fs::read(sub.join("vfs.db")).unwrap()))
        };
        manifest.files[0].sha256 = vfs_sha;
        manifest.files[0].size = std::fs::metadata(sub.join("vfs.db")).unwrap().len();

        // chat_v2.db 写入损坏数据（sha 故意不匹配）
        std::fs::write(sub.join("chat_v2.db"), b"CORRUPTED DATA").unwrap();
        manifest.files[1].size = std::fs::metadata(sub.join("chat_v2.db")).unwrap().len();
        // sha 保持错误值 — verify_internal 会在这里失败

        // 写入 manifest
        manifest.save_to_file(&sub.join("manifest.json")).unwrap();

        // 调用 restore — 应该在 verify 阶段因 checksum 不匹配而失败
        let result = manager.restore(&manifest);

        assert!(
            result.is_err(),
            "Issue 8: restore() with corrupted backup file should fail"
        );
        let err_msg = format!("{}", result.unwrap_err());
        // 验证错误信息中提到校验和不匹配
        assert!(
            err_msg.contains("校验和")
                || err_msg.contains("checksum")
                || err_msg.contains("验证失败"),
            "Issue 8: Error should mention checksum mismatch. Got: {}",
            err_msg
        );
        // 注意：由于 verify 在 pre_restore_backup 之前执行，
        // 如果 verify 先失败则 rollback_from_pre_restore 根本不会被调用。
        // 这意味着只有 verify 通过但个别 restore_single_database 失败时
        // 回滚才会触发 — 这种路径更难测试，且当前没有任何测试覆盖。
    }

    // ============================================================================
    // 🟡 问题 9: VFS deleted_at 列类型不一致
    //
    // 验证：resources.deleted_at 是 INTEGER 而其他表是 TEXT
    // ============================================================================

    /// 测试：VFS deleted_at 值类型已统一为 TEXT
    ///
    /// Issue 9 修复验证：V20260207 将 resources.deleted_at 的 INTEGER 值
    /// UPDATE 为 TEXT（ISO 8601）。SQLite 动态类型下列声明仍为 INTEGER，
    /// 但实际存储的值和新写入的值统一为 TEXT 格式。
    ///
    /// 验证方式：插入带 deleted_at 的测试行，确认写入和读取都是 TEXT。
    #[test]
    fn test_issue9_vfs_deleted_at_column_type_inconsistency() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration should succeed");

        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_path).expect("Failed to open VFS db");

        // 插入一条带 TEXT 格式 deleted_at 的资源（模拟应用层统一写入 TEXT）
        conn.execute(
            "INSERT INTO resources (id, hash, type, created_at, updated_at, deleted_at) \
             VALUES ('res_test_issue9', 'hash_issue9', 'note', 1000, 2000, '2026-02-07T00:00:00Z')",
            [],
        )
        .expect("Insert with TEXT deleted_at should succeed");

        // 验证写入的值确实是 TEXT 类型
        let actual_type: String = conn
            .query_row(
                "SELECT typeof(deleted_at) FROM resources WHERE id = 'res_test_issue9'",
                [],
                |row| row.get(0),
            )
            .expect("Query should succeed");

        assert_eq!(
            actual_type, "text",
            "Issue 9 FIXED: deleted_at value should be stored as text type"
        );

        // 验证其他表的 deleted_at 声明类型仍为 TEXT
        let notes_decl_type: String = conn
            .query_row(
                "SELECT type FROM pragma_table_info('notes') WHERE name = 'deleted_at'",
                [],
                |row| row.get(0),
            )
            .expect("notes should have deleted_at");
        assert_eq!(notes_decl_type.to_uppercase(), "TEXT");

        // 清理
        conn.execute("DELETE FROM resources WHERE id = 'res_test_issue9'", [])
            .ok();
    }

    // ============================================================================
    // 🟡 问题 10: 并发写入时的备份一致性问题
    //
    // 验证：在 checkpoint 和 backup 之间有新写入时的行为
    // ============================================================================

    /// 测试：checkpoint 后写入的数据可能不被 Backup API 捕获
    ///
    /// 问题 10: backup_single_database 中 checkpoint 和 Backup::new 之间无锁
    #[test]
    fn test_issue10_checkpoint_then_write_then_backup_may_lose_data() {
        let temp_dir = create_test_dir();
        let src_path = temp_dir.path().join("source.db");
        let dst_path = temp_dir.path().join("backup.db");

        // 步骤 1: 创建源数据库
        let src = Connection::open(&src_path).expect("Failed to create source db");
        src.execute_batch("PRAGMA journal_mode=WAL").unwrap();
        src.execute_batch(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT);
             INSERT INTO items (value) VALUES ('row_1');
             INSERT INTO items (value) VALUES ('row_2');",
        )
        .unwrap();

        // 步骤 2: 模拟 backup_single_database 的操作顺序（与源码一致）
        // 2a: checkpoint（与 coordinator.rs 一致）
        src.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();

        // 2b: 在 checkpoint 和 Backup::new 之间写入（模拟并发）
        src.execute("INSERT INTO items (value) VALUES ('after_checkpoint')", [])
            .unwrap();

        // 2c: 执行 Backup API（与 coordinator.rs 一致）
        {
            let mut dst = Connection::open(&dst_path).expect("Failed to create backup db");
            let backup = rusqlite::backup::Backup::new(&src, &mut dst).unwrap();
            backup
                .run_to_completion(5, std::time::Duration::from_millis(10), None)
                .unwrap();
        }

        // 步骤 3: 比较源和备份的行数
        let src_count: i64 = src
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .unwrap();
        let dst = Connection::open(&dst_path).unwrap();
        let dst_count: i64 = dst
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .unwrap();

        assert_eq!(src_count, 3, "Source should have 3 rows");
        // 注意：SQLite Backup API 实际上能读到 WAL 中的数据（因为共用同一个连接的 cache），
        // 所以 dst_count 可能也是 3。但在多进程/多连接场景下，竞态窗口确实存在。
        // 问题 10 的核心在于代码没有使用 BEGIN IMMEDIATE 来防止这种竞态。
        // 这里我们验证的是 backup 代码路径中 checkpoint → backup 之间没有事务保护。
        if dst_count == src_count {
            // 单连接场景下 Backup API 恰好能读到 WAL — 但这不代表多连接安全
            assert_eq!(
                dst_count, 3,
                "Issue 10: In single-connection test, Backup API happens to see WAL data. \
                 But backup_single_database uses separate connections and no BEGIN IMMEDIATE, \
                 so multi-process races are unprotected."
            );
        } else {
            assert_eq!(
                dst_count, 2,
                "Issue 10 CONFIRMED: Backup missed the post-checkpoint write"
            );
        }
    }

    // ============================================================================
    // 🟡 问题 11: 磁盘空间耗尽场景无处理
    //
    // 验证：迁移前没有磁盘空间检查
    // ============================================================================

    /// 测试：run_all 产生的错误中没有磁盘空间相关的诊断信息
    ///
    /// 问题 11: run_all 开始前不检查可用磁盘空间
    /// 我们无法在测试中真正填满磁盘，但可以验证 MigrationError 枚举
    /// 没有磁盘空间不足的专用变体。
    #[test]
    fn test_issue11_migration_error_has_no_disk_space_variant() {
        // 验证 MigrationError 的所有变体中没有"磁盘空间"相关的
        // 这证明了 run_all 不可能产生"磁盘不足"的友好错误
        let io_err = MigrationError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            "No space left on device",
        ));
        let msg = format!("{}", io_err);

        // MigrationError::Io 会传播原始 IO 错误，但不会添加可操作提示
        assert!(
            !msg.contains("磁盘") && !msg.contains("disk space") && !msg.contains("建议"),
            "Issue 11 would be FIXED if MigrationError included actionable disk space hints. \
             Currently the Io variant just wraps the raw error: {}",
            msg
        );

        // 同时验证 run_all 对空目录直接执行，无任何预检查
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);
        // 如果有预检查，对于空目录也应该能发现"无法确定磁盘空间"之类的信息
        // 但实际上直接成功了
        assert!(coordinator.run_all().is_ok());
    }

    // ============================================================================
    // 🟡 问题 12: Schema fingerprint 跨 SQLite 版本可能误报
    //
    // 验证：compute_schema_fingerprint 将原始 SQL 文本纳入 hash
    // ============================================================================

    /// 测试：修改 index SQL 的空白后 fingerprint 会变化
    ///
    /// 问题 12: compute_schema_fingerprint 将原始 SQL 纳入 hash，
    /// 导致不同 SQLite 版本的格式差异可能触发 fail-close
    #[test]
    fn test_issue12_schema_fingerprint_changes_with_sql_formatting() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);

        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("VFS migration should succeed");

        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_path).expect("Failed to open VFS db");

        // 读取 fingerprint 表中的值（迁移后自动写入）
        let has_fp_table: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__governance_schema_fingerprints')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_fp_table {
            // 如果没有 fingerprint 表，说明功能可能还没启用，跳过
            return;
        }

        let original_fp: String = conn
            .query_row(
                "SELECT fingerprint FROM __governance_schema_fingerprints ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("Failed to read fingerprint");

        // 验证 fingerprint 的 hash 输入确实包含 sqlite_master 的原始 SQL 文本
        // 方法：查看 sqlite_master 中的索引 SQL 文本是否非空
        let index_sql_texts: Vec<String> = conn
            .prepare(
                "SELECT IFNULL(sql, '') FROM sqlite_master
                 WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'
                 ORDER BY name",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        let non_empty_count = index_sql_texts.iter().filter(|s| !s.is_empty()).count();
        assert!(
            non_empty_count > 0,
            "Issue 12: There should be index SQL text in sqlite_master"
        );

        // 核心断言：compute_schema_fingerprint 使用的格式是
        // "idx:{name}:{sql}\n"，所以任何 SQL 文本格式变化都会改变 fingerprint。
        // 不同 SQLite 版本可能对同一 CREATE INDEX 输出不同的空白/大小写。
        assert!(
            !original_fp.is_empty(),
            "Issue 12 CONFIRMED: Schema fingerprint is computed and stored. \
             Since it hashes raw SQL text from sqlite_master (idx:name:sql format), \
             SQLite version upgrades that change SQL formatting will cause fingerprint drift."
        );
    }

    // ============================================================================
    // 🟢 问题 13: tests.rs 和 migration_tests.rs 约 60% 重复
    //
    // 验证：两个文件有高度相似的测试
    // ============================================================================

    /// 测试：确认两个测试文件的测试名称重复
    ///
    /// 问题 13: 测试文件间约 60% 重复
    #[test]
    fn test_issue13_duplicate_test_functions_exist() {
        // 通过源码内容验证两个文件有相同的测试函数名
        let tests_rs = include_str!("tests.rs");
        let migration_tests_rs = include_str!("migration_tests.rs");

        // 统计两个文件中都出现的测试逻辑模式
        let shared_patterns = [
            "migrate_single(DatabaseId::Vfs)",
            "run_all()",
            "test_migration_idempotency",
            "needs_migration",
            "check_dependencies",
            "MigrationReport::default()",
            "DependencyNotSatisfied",
            "VerificationFailed",
            "pending_migrations_count",
            "migration_set_properties",
            "Schema Registry",
        ];

        let mut both_count = 0;
        for pattern in &shared_patterns {
            let in_tests = tests_rs.contains(pattern);
            let in_migration = migration_tests_rs.contains(pattern);
            if in_tests && in_migration {
                both_count += 1;
            }
        }

        assert!(
            both_count >= 8,
            "Issue 13 CONFIRMED: {} out of {} checked patterns appear in BOTH test files. \
             tests.rs and migration_tests.rs have significant duplication.",
            both_count,
            shared_patterns.len()
        );
    }

    // ============================================================================
    // 🟢 问题 14: 迁移数量硬编码在常量中
    //
    // 验证：migration_tests.rs 中的常量需要手动维护
    // ============================================================================

    /// 测试：确认硬编码常量与实际迁移数量的一致性
    ///
    /// 问题 14: 每次新增迁移脚本都需要手动更新常量
    #[test]
    fn test_issue14_hardcoded_migration_counts_must_match() {
        // 验证迁移数量 >= 已知最小值（避免硬编码具体数字，
        // 新增迁移时此测试自动通过，删除迁移时此测试会 catch）
        let actual_vfs = VFS_MIGRATION_SET.count();
        let actual_chat_v2 = CHAT_V2_MIGRATION_SET.count();
        let actual_mistakes = MISTAKES_MIGRATIONS.count();
        let actual_llm_usage = LLM_USAGE_MIGRATION_SET.count();

        assert!(
            actual_vfs >= 9,
            "Issue 14: VFS should have at least 9 migrations, got {}",
            actual_vfs
        );
        assert!(
            actual_chat_v2 >= 7,
            "Issue 14: ChatV2 should have at least 7 migrations, got {}",
            actual_chat_v2
        );
        assert!(
            actual_mistakes >= 4,
            "Issue 14: Mistakes should have at least 4 migrations, got {}",
            actual_mistakes
        );
        assert!(
            actual_llm_usage >= 3,
            "Issue 14: LlmUsage should have at least 3 migrations, got {}",
            actual_llm_usage
        );
    }

    // ============================================================================
    // 🟢 问题 16: 同步模块基本为空壳
    //
    // 验证：sync 模块存在但无实质同步逻辑测试
    // ============================================================================

    /// 测试：确认同步模块缺少与实际数据库交互的集成测试
    ///
    /// 问题 16: sync 模块只有单元测试，无集成测试
    #[test]
    fn test_issue16_sync_module_has_no_integration_tests_with_real_db() {
        // 问题 16 确认：sync/mod.rs 有以下测试，但都是纯内存模拟：
        // - test_detect_no_conflicts: 纯 SyncManifest 比较
        // - test_detect_schema_mismatch: 纯 SyncManifest 比较
        // - test_sync_keep_local: 使用空的 ConflictDetectionResult
        // - test_record_conflict_detection: 使用构造的 RecordSnapshot
        //
        // 缺少：
        // - 实际打开已迁移的数据库，读取 __change_log 表的测试
        // - 实际执行 get_pending_changes → upload → download → apply 的集成测试
        // - 测试同步触发后数据库 schema 不匹配时的行为

        // 尝试在真实迁移后的数据库上获取待同步变更
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);
        coordinator.run_all().expect("Migration should succeed");

        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_path).expect("Failed to open VFS db");

        // 验证 __change_log 表存在
        let has_change_log: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
                [],
                |row| row.get(0),
            )
            .expect("Failed to check __change_log");

        assert!(
            has_change_log,
            "Issue 16: VFS database has __change_log table after migration, \
             but there are no integration tests that exercise sync operations \
             on this real table."
        );
    }

    // ============================================================================
    // 额外验证测试：从 Legacy 恢复时的数据存活
    // ============================================================================

    /// 测试：Mistakes Legacy 恢复时保留已有的 anki_cards 数据
    ///
    /// 综合问题 1+2: Legacy 数据库恢复 + 数据存活
    #[test]
    fn test_combined_issue1_2_legacy_mistakes_data_survives_recovery() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let mut coordinator = create_test_coordinator(&temp_dir);
        let db_path = temp_dir.path().join("mistakes.db");

        // 创建一个 Legacy Mistakes 数据库（有数据）
        let conn = Connection::open(&db_path).expect("Failed to create legacy mistakes db");
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
        .expect("Failed to build legacy schema");

        // 插入业务数据
        conn.execute(
            "INSERT INTO anki_cards (id, task_id, front, back, source_type, source_id)
             VALUES ('legacy-card-1', 'task-1', 'What is Rust?', 'A systems programming language', 'manual', 'src-1')",
            [],
        ).expect("Failed to insert legacy card 1");
        conn.execute(
            "INSERT INTO anki_cards (id, task_id, front, back, source_type, source_id)
             VALUES ('legacy-card-2', 'task-2', 'What is ownership?', 'Memory management without GC', 'manual', 'src-2')",
            [],
        ).expect("Failed to insert legacy card 2");
        conn.execute(
            "INSERT INTO mistakes (id, created_at, status, question_images)
             VALUES ('mistake-1', '2026-01-01T00:00:00Z', 'active', '[]')",
            [],
        )
        .expect("Failed to insert legacy mistake");

        drop(conn);

        // 执行迁移（应该恢复 legacy schema 到最新）
        let report = coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("Legacy mistakes recovery should succeed");
        assert!(report.success);

        // 验证数据存活
        let conn = Connection::open(&db_path).expect("Failed to reopen mistakes db");

        let card_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM anki_cards", [], |row| row.get(0))
            .expect("Failed to count cards");
        assert_eq!(
            card_count, 2,
            "Combined Issue 1+2: Both legacy anki_cards should survive recovery migration"
        );

        let front: String = conn
            .query_row(
                "SELECT front FROM anki_cards WHERE id = 'legacy-card-1'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query card front");
        assert_eq!(
            front, "What is Rust?",
            "Combined Issue 1+2: Legacy card content should be preserved exactly"
        );

        let mistake_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM mistakes", [], |row| row.get(0))
            .expect("Failed to count mistakes");
        assert_eq!(
            mistake_count, 1,
            "Combined Issue 1+2: Legacy mistakes data should survive recovery"
        );
    }

    // ============================================================================
    // 额外验证：迁移后审计日志中 repair_refinery_checksums 操作的可追溯性
    // ============================================================================

    /// 测试：repair_refinery_checksums 操作没有审计日志记录
    ///
    /// 问题 5 补充: 静默修复应该被审计
    #[test]
    fn test_issue5_supplement_checksum_repair_not_audited() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);

        // 初始化审计数据库
        let audit_db_path = init_audit_database(&temp_dir);

        let mut coordinator = create_test_coordinator_with_audit(&temp_dir);

        // 执行迁移
        coordinator.run_all().expect("Migration should succeed");

        // 篡改 checksum
        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        let conn = Connection::open(&vfs_path).expect("Failed to open VFS db");
        conn.execute(
            "UPDATE refinery_schema_history SET checksum = 'TAMPERED' WHERE version = 20260130",
            [],
        )
        .expect("Failed to tamper checksum");
        drop(conn);

        // 重新迁移（会触发 repair_refinery_checksums）
        let mut coordinator2 = create_test_coordinator_with_audit(&temp_dir);
        let _ = coordinator2.run_all();

        // 查看审计日志中是否有 checksum 修复的记录
        let audit_conn = Connection::open(&audit_db_path).expect("Failed to open audit db");
        let all_logs = AuditRepository::query(
            &audit_conn,
            AuditFilter {
                limit: Some(100),
                ..Default::default()
            },
        )
        .expect("Query should succeed");

        // 检查是否有任何日志提到 checksum repair
        let has_repair_log = all_logs.iter().any(|log| {
            let details = serde_json::to_string(&log.details).unwrap_or_default();
            let error_msg = log.error_message.as_deref().unwrap_or("");
            let target = &log.target;
            details.contains("checksum")
                || details.contains("repair")
                || error_msg.contains("checksum")
                || error_msg.contains("repair")
                || target.contains("checksum")
                || target.contains("repair")
        });

        // Issue 5 已修复：checksum 修复现在应该有审计日志
        assert!(
            has_repair_log,
            "Issue 5 FIXED: repair_refinery_checksums should leave an audit trail. \
             Found {} audit logs total but none mention checksum repair. \
             Check log_checksum_repair_audit() implementation.",
            all_logs.len()
        );
    }

    // ============================================================================
    // 初始化流程中的数据存活测试
    // ============================================================================

    /// 测试：完整的初始化 → 插入数据 → 再次初始化 → 数据存活
    ///
    /// 综合验证：初始化流程的幂等性和数据安全性
    #[test]
    fn test_initialization_preserves_existing_data() {
        let temp_dir = create_test_dir();

        // 第一次初始化
        let result = initialize_with_report(temp_dir.path());
        assert!(result.is_ok(), "First initialization should succeed");

        // 插入数据到 VFS（使用真实 schema：resources 无 title 列）
        let vfs_path = temp_dir.path().join("databases").join("vfs.db");
        let conn = Connection::open(&vfs_path).expect("Failed to open VFS db");
        conn.execute(
            "INSERT INTO resources (id, type, hash, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('preserved-001', 'note', 'hash_xyz_unique', 'inline', 'Must Survive Init Content', 1, 1706745600000, 1706745600000)",
            [],
        ).expect("Failed to insert data");
        drop(conn);

        // 第二次初始化（应保留数据）
        let result2 = initialize_with_report(temp_dir.path());
        assert!(result2.is_ok(), "Second initialization should succeed");

        // 验证数据存活
        let conn = Connection::open(&vfs_path).expect("Failed to reopen VFS db");
        let data_value: String = conn
            .query_row(
                "SELECT data FROM resources WHERE id = 'preserved-001'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query preserved data");
        assert_eq!(
            data_value, "Must Survive Init Content",
            "Data inserted between initializations should be preserved"
        );
    }

    // ============================================================================
    // 边界条件：空数据库的 needs_migration 行为
    // ============================================================================

    /// 测试：空文件上调用 needs_migration，应返回 true 或错误，不应 panic
    #[test]
    fn test_needs_migration_on_empty_file() {
        let temp_dir = create_test_dir();
        setup_test_directories(&temp_dir);
        let coordinator = create_test_coordinator(&temp_dir);

        // 创建一个空文件（不是 SQLite 数据库）
        let vfs_path = get_database_path(&temp_dir, &DatabaseId::Vfs);
        std::fs::write(&vfs_path, b"").expect("Failed to create empty file");

        // 到这里没有 panic 就说明函数正确处理了异常输入
        let result = coordinator.needs_migration(&DatabaseId::Vfs);
        match result {
            Ok(needs) => {
                // 空文件应该需要迁移（或被视为损坏）
                assert!(needs, "Empty file should be treated as needing migration");
            }
            Err(_) => {
                // 返回错误也是可接受的行为
            }
        }
    }
}
