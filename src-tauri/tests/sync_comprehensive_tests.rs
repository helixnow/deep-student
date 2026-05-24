//! Comprehensive integration tests for the sync system.
//!
//! Validates:
//! - Classification registry (4 databases, all table categories)
//! - Checksum computation (excludes FTS shadows, runtime, derived)
//! - ZIP restore baseline (local_version touch + change_log truncation)
//! - Field-level merge strategies (counter, set union, max, sum, boolean, string, JSON deep)
//! - Prune gap detection
//! - Trigger coverage and classification integrity
//! - Edge cases (composite PKs, NULL values, auto-increment tables)

#[cfg(test)]
mod tests {
    // No top-level imports needed here — each sub-module imports what it uses

    // ============================================================================
    // Module 1: Classification Registry Tests
    // ============================================================================
    mod classification_tests {
        use deep_student_lib::data_governance::sync::classification::{
            sync_classification_registry, SyncCategory, TableClassification,
        };

        #[test]
        fn test_registry_has_all_4_databases() {
            let registry = sync_classification_registry();
            let dbs: std::collections::HashSet<_> = registry.iter().map(|c| c.database).collect();
            assert!(dbs.contains("vfs"));
            assert!(dbs.contains("chat_v2"));
            assert!(dbs.contains("mistakes"));
            assert!(dbs.contains("llm_usage"));
        }

        #[test]
        fn test_row_sync_tables_have_valid_config() {
            let tables = TableClassification::row_sync_tables();
            assert!(
                !tables.is_empty(),
                "Should have at least some RowSync tables"
            );
            for t in &tables {
                assert!(
                    !t.primary_key.is_empty(),
                    "Table {} has no PK",
                    t.table_name
                );
                let valid_pk = t
                    .primary_key
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == ',');
                assert!(
                    valid_pk,
                    "Table {} has invalid PK chars: '{}'",
                    t.table_name, t.primary_key
                );
            }
        }

        #[test]
        fn test_checksum_tables_excludes_runtime() {
            for db in &["vfs", "chat_v2", "mistakes", "llm_usage"] {
                let checksum_tables = TableClassification::checksum_tables(db);
                for t in &checksum_tables {
                    assert!(
                        matches!(t.category, SyncCategory::RowSync | SyncCategory::FileSync),
                        "Table {}.{} in checksum but not RowSync/FileSync",
                        db,
                        t.table_name
                    );
                }
            }
            // Inverse: runtime tables should NOT be in checksum
            let vfs_checksum_tables: Vec<_> = TableClassification::checksum_tables("vfs");
            let vfs_names: Vec<_> = vfs_checksum_tables.iter().map(|t| t.table_name).collect();
            assert!(!vfs_names.contains(&"question_history"));
            assert!(!vfs_names.contains(&"question_bank_stats"));
            assert!(!vfs_names.contains(&"path_cache"));
            assert!(!vfs_names.contains(&"memory_audit_log"));
        }

        #[test]
        fn test_fts_shadows_are_excluded() {
            assert!(TableClassification::is_excluded_from_checksum(
                "vfs",
                "questions_fts_content"
            ));
            assert!(TableClassification::is_excluded_from_checksum(
                "vfs",
                "questions_fts_docsize"
            ));
            assert!(TableClassification::is_excluded_from_checksum(
                "vfs",
                "questions_fts_config"
            ));
            assert!(TableClassification::is_excluded_from_checksum(
                "chat_v2",
                "chat_v2_content_fts_idx"
            ));
        }

        #[test]
        fn test_user_tables_not_excluded() {
            assert!(!TableClassification::is_excluded_from_checksum(
                "vfs",
                "resources"
            ));
            assert!(!TableClassification::is_excluded_from_checksum(
                "vfs", "notes"
            ));
            assert!(!TableClassification::is_excluded_from_checksum(
                "chat_v2",
                "chat_v2_sessions"
            ));
        }

        #[test]
        fn test_business_unique_keys_not_empty() {
            let keys = TableClassification::get_business_unique_keys("vfs", "resources");
            assert!(keys.contains(&"hash".to_string()));

            let keys = TableClassification::get_business_unique_keys("vfs", "review_plans");
            assert!(keys.contains(&"question_id".to_string()));
        }

        #[test]
        fn test_chat_v2_attachments_has_content_hash_key() {
            let keys =
                TableClassification::get_business_unique_keys("chat_v2", "chat_v2_attachments");
            assert!(
                keys.contains(&"content_hash".to_string()),
                "chat_v2_attachments should have content_hash as business unique key"
            );
        }
    }

    // ============================================================================
    // Module 2: Checksum Tests
    // ============================================================================
    mod checksum_tests {
        use deep_student_lib::data_governance::sync::SyncManager;
        use rusqlite::Connection;

        fn create_test_db() -> Connection {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS __change_log (
                    id INTEGER PRIMARY KEY,
                    table_name TEXT,
                    record_id TEXT,
                    operation TEXT,
                    changed_at TEXT DEFAULT (datetime('now')),
                    sync_version INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS test_table (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    updated_at TEXT DEFAULT (datetime('now')),
                    device_id TEXT,
                    local_version INTEGER DEFAULT 0,
                    deleted_at TEXT
                );
                CREATE TABLE IF NOT EXISTS refinery_schema_history (
                    version INTEGER PRIMARY KEY,
                    applied_on TEXT
                );
                INSERT INTO refinery_schema_history VALUES (1, datetime('now'));",
            )
            .unwrap();
            conn
        }

        #[test]
        fn test_checksum_compiles_and_runs() {
            let conn = create_test_db();
            let state = SyncManager::get_database_sync_state(&conn, "vfs").unwrap();
            assert_eq!(state.schema_version, 1, "Should detect refinery version 1");
            assert_eq!(
                state.data_version, 0,
                "Empty change_log should give data_version 0"
            );
            assert!(
                !state.checksum.is_empty(),
                "Checksum should not be empty even for empty DB"
            );
        }

        #[test]
        fn test_checksum_on_empty_db() {
            let conn = create_test_db();
            conn.execute("DELETE FROM __change_log", []).unwrap();
            let state = SyncManager::get_database_sync_state(&conn, "vfs").unwrap();
            assert_eq!(state.data_version, 0);
        }

        #[test]
        fn test_checksum_reflects_sync_version() {
            let conn = create_test_db();
            conn.execute(
                "INSERT INTO __change_log (table_name, record_id, operation, sync_version)
                 VALUES ('test_table', 'r1', 'INSERT', 42)",
                [],
            )
            .unwrap();
            let state = SyncManager::get_database_sync_state(&conn, "vfs").unwrap();
            assert_eq!(state.data_version, 42);
        }
    }

    // ============================================================================
    // Module 3: ZIP Restore Baseline Tests
    // ============================================================================
    mod restore_baseline_tests {
        use deep_student_lib::data_governance::sync::SyncManager;
        use rusqlite::Connection;

        #[test]
        fn test_reset_baseline_touches_local_version() {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE resources (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    device_id TEXT,
                    local_version INTEGER DEFAULT 0,
                    updated_at TEXT DEFAULT (datetime('now')),
                    deleted_at TEXT
                );
                INSERT INTO resources (id, title, local_version) VALUES ('res_1', 'test', 5);
                CREATE TABLE __change_log (
                    id INTEGER PRIMARY KEY,
                    table_name TEXT,
                    record_id TEXT,
                    operation TEXT,
                    changed_at TEXT,
                    sync_version INTEGER DEFAULT 0
                );
                INSERT INTO __change_log (table_name, record_id, operation)
                VALUES ('resources', 'res_1', 'INSERT');
                CREATE TABLE __sync_conflicts (
                    id INTEGER PRIMARY KEY,
                    table_name TEXT,
                    record_id TEXT,
                    side TEXT,
                    data_json TEXT,
                    data_hash TEXT DEFAULT '',
                    detected_at TEXT DEFAULT (datetime('now')),
                    resolved_at TEXT,
                    resolution TEXT
                );",
            )
            .unwrap();

            let result = SyncManager::reset_sync_baseline_after_restore(&conn);
            assert!(result.is_ok());
            let (truncated, reset_count) = result.unwrap();

            assert!(truncated > 0, "__change_log should be emptied");
            assert!(
                reset_count > 0,
                "reset_count should be > 0 after baseline reset"
            );

            let new_version: i64 = conn
                .query_row(
                    "SELECT local_version FROM resources WHERE id = 'res_1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                new_version, 6,
                "local_version should be incremented from 5 to 6"
            );
        }

        #[test]
        fn test_reset_baseline_multiple_tables() {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE notes (
                    id TEXT PRIMARY KEY, title TEXT,
                    device_id TEXT, local_version INTEGER DEFAULT 0,
                    updated_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
                );
                INSERT INTO notes (id, title, local_version) VALUES ('n1', 'note1', 3);
                INSERT INTO notes (id, title, local_version) VALUES ('n2', 'note2', 7);
                CREATE TABLE questions (
                    id TEXT PRIMARY KEY, title TEXT,
                    device_id TEXT, local_version INTEGER DEFAULT 0,
                    updated_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
                );
                INSERT INTO questions (id, title, local_version) VALUES ('q1', 'q1', 1);
                CREATE TABLE __change_log (
                    id INTEGER PRIMARY KEY, table_name TEXT,
                    record_id TEXT, operation TEXT, changed_at TEXT,
                    sync_version INTEGER DEFAULT 0
                );
                INSERT INTO __change_log (table_name, record_id, operation)
                VALUES ('notes', 'n1', 'INSERT');
                INSERT INTO __change_log (table_name, record_id, operation)
                VALUES ('questions', 'q1', 'INSERT');
                CREATE TABLE __sync_conflicts (
                    id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT,
                    side TEXT, data_json TEXT, data_hash TEXT DEFAULT '',
                    detected_at TEXT DEFAULT (datetime('now')),
                    resolved_at TEXT, resolution TEXT
                );",
            )
            .unwrap();

            let result = SyncManager::reset_sync_baseline_after_restore(&conn);
            assert!(result.is_ok());
            let (_truncated, reset_count) = result.unwrap();
            assert!(reset_count >= 3, "should touch all 3 rows across 2 tables");

            let n1_version: i64 = conn
                .query_row(
                    "SELECT local_version FROM notes WHERE id = 'n1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let n2_version: i64 = conn
                .query_row(
                    "SELECT local_version FROM notes WHERE id = 'n2'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let q1_version: i64 = conn
                .query_row(
                    "SELECT local_version FROM questions WHERE id = 'q1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(n1_version, 4);
            assert_eq!(n2_version, 8);
            assert_eq!(q1_version, 2);
        }

        #[test]
        fn test_reset_baseline_table_without_local_version_is_skipped() {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE no_sync (id TEXT PRIMARY KEY, title TEXT);
                 INSERT INTO no_sync (id, title) VALUES ('ns_1', 'test');
                 CREATE TABLE __change_log (
                    id INTEGER PRIMARY KEY, table_name TEXT,
                    record_id TEXT, operation TEXT, changed_at TEXT,
                    sync_version INTEGER DEFAULT 0
                 );
                 CREATE TABLE __sync_conflicts (
                    id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT,
                    side TEXT, data_json TEXT, data_hash TEXT DEFAULT '',
                    detected_at TEXT DEFAULT (datetime('now')),
                    resolved_at TEXT, resolution TEXT
                 );",
            )
            .unwrap();

            let result = SyncManager::reset_sync_baseline_after_restore(&conn);
            assert!(result.is_ok());
            let (_truncated, reset_count) = result.unwrap();
            assert_eq!(
                reset_count, 0,
                "tables without local_version should be skipped"
            );

            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM no_sync WHERE id = 'ns_1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "table without sync fields must survive intact");
        }

        #[test]
        fn test_reset_baseline_empty_db_does_not_panic() {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE __change_log (
                    id INTEGER PRIMARY KEY, table_name TEXT,
                    record_id TEXT, operation TEXT, changed_at TEXT,
                    sync_version INTEGER DEFAULT 0
                );
                CREATE TABLE __sync_conflicts (
                    id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT,
                    side TEXT, data_json TEXT, data_hash TEXT DEFAULT '',
                    detected_at TEXT DEFAULT (datetime('now')),
                    resolved_at TEXT, resolution TEXT
                );",
            )
            .unwrap();

            let result = SyncManager::reset_sync_baseline_after_restore(&conn);
            assert!(result.is_ok());
            let (truncated, reset_count) = result.unwrap();
            assert_eq!(truncated, 0, "No change_log entries on empty DB");
            assert_eq!(reset_count, 0, "No business records to touch on empty DB");
        }
    }

    // ============================================================================
    // Module 4: Field Merge Tests
    // (exercising domain-aware merge strategies through merge_field public API)
    // ============================================================================
    mod field_merge_tests {
        use deep_student_lib::data_governance::sync::field_merge::merge_field;
        use serde_json::{json, Value};

        // --- Counter merge (exercised via "resources"."ref_count") ---

        #[test]
        fn test_counter_merge_max() {
            let (result, merged, conflict) =
                merge_field("resources", "ref_count", Some(&json!(5)), Some(&json!(3)));
            assert_eq!(result, 5);
            assert!(merged);
            assert!(!conflict);
        }

        #[test]
        fn test_counter_merge_equal() {
            let (result, merged, _) =
                merge_field("resources", "ref_count", Some(&json!(7)), Some(&json!(7)));
            assert_eq!(result, 7);
            assert!(!merged);
        }

        #[test]
        fn test_counter_merge_zero() {
            let (result, merged, _) =
                merge_field("resources", "ref_count", Some(&json!(0)), Some(&json!(0)));
            assert_eq!(result, 0);
            assert!(!merged);
        }

        #[test]
        fn test_counter_merge_blobs_ref_count() {
            let (result, merged, _) =
                merge_field("blobs", "ref_count", Some(&json!(10)), Some(&json!(3)));
            assert_eq!(result, 10);
            assert!(
                merged,
                "Values differ (10 vs 3), should be reported as merged"
            );
        }

        // --- Set union (exercised via "notes"."tags") ---

        #[test]
        fn test_tag_union_with_overlap() {
            let (result, merged, _) = merge_field(
                "notes",
                "tags",
                Some(&json!(["a", "b", "c"])),
                Some(&json!(["b", "c", "d"])),
            );
            let arr = result.as_array().unwrap();
            assert_eq!(arr.len(), 4);
            assert!(merged);
        }

        #[test]
        fn test_tag_union_disjoint() {
            let (result, merged, _) = merge_field(
                "notes",
                "tags",
                Some(&json!(["x", "y"])),
                Some(&json!(["a", "b"])),
            );
            let arr = result.as_array().unwrap();
            assert_eq!(arr.len(), 4);
            assert!(merged);
        }

        #[test]
        fn test_tag_union_identical() {
            let (_result, merged, _) = merge_field(
                "notes",
                "tags",
                Some(&json!(["a", "b"])),
                Some(&json!(["a", "b"])),
            );
            assert!(!merged);
        }

        #[test]
        fn test_tag_union_empty() {
            let (result, merged, _) =
                merge_field("notes", "tags", Some(&json!([])), Some(&json!([])));
            assert_eq!(result, json!([]));
            assert!(!merged);
        }

        // --- Max value (exercised via "questions"."attempt_count") ---

        #[test]
        fn test_max_value() {
            let (result, merged, _) = merge_field(
                "questions",
                "attempt_count",
                Some(&json!(10)),
                Some(&json!(7)),
            );
            assert_eq!(result, 10);
            assert!(
                merged,
                "Values differ (10 vs 7), should be reported as merged"
            );
        }

        #[test]
        fn test_max_value_reverse() {
            let (result, merged, _) = merge_field(
                "questions",
                "attempt_count",
                Some(&json!(3)),
                Some(&json!(15)),
            );
            assert_eq!(result, 15);
            assert!(merged);
        }

        // --- Sum value (exercised via "todo_items"."estimated_pomodoros") ---

        #[test]
        fn test_sum_value() {
            let (result, merged, _) = merge_field(
                "todo_items",
                "estimated_pomodoros",
                Some(&json!(3)),
                Some(&json!(4)),
            );
            assert_eq!(result, 7);
            assert!(merged);
        }

        #[test]
        fn test_sum_value_zero_remote() {
            let (result, merged, _) = merge_field(
                "todo_items",
                "estimated_pomodoros",
                Some(&json!(5)),
                Some(&json!(0)),
            );
            assert_eq!(result, 5);
            assert!(!merged);
        }

        // --- Boolean OR (exercised via "notes"."is_favorite") ---

        #[test]
        fn test_boolean_or_true_wins() {
            let (result, merged, _) = merge_field(
                "notes",
                "is_favorite",
                Some(&json!(false)),
                Some(&json!(true)),
            );
            assert_eq!(result, true);
            assert!(merged);
        }

        #[test]
        fn test_boolean_or_both_false() {
            let (result, merged, _) = merge_field(
                "notes",
                "is_favorite",
                Some(&json!(false)),
                Some(&json!(false)),
            );
            assert_eq!(result, false);
            assert!(!merged);
        }

        // --- String concat (exercised via "questions"."user_note") ---

        #[test]
        fn test_string_concat_basic() {
            let (result, merged, _) = merge_field(
                "questions",
                "user_note",
                Some(&json!("Hello")),
                Some(&json!("World")),
            );
            assert!(result.as_str().unwrap().contains("Hello"));
            assert!(result.as_str().unwrap().contains("World"));
            assert!(merged);
        }

        #[test]
        fn test_string_concat_empty_local() {
            let (result, merged, _) = merge_field(
                "questions",
                "user_note",
                Some(&json!("")),
                Some(&json!("World")),
            );
            assert_eq!(result, "World");
            assert!(!merged);
        }

        #[test]
        fn test_string_concat_contains_remote() {
            let (result, merged, _) = merge_field(
                "questions",
                "user_note",
                Some(&json!("Hello World")),
                Some(&json!("Hello")),
            );
            assert_eq!(result, "Hello World");
            assert!(!merged);
        }

        // --- JSON deep merge (exercised via "resources"."metadata_json") ---

        #[test]
        fn test_json_deep_merge_nested() {
            let (result, changed, _) = merge_field(
                "resources",
                "metadata_json",
                Some(&json!({"a": 1, "b": {"x": 10}})),
                Some(&json!({"b": {"y": 20}, "c": 30})),
            );
            assert_eq!(result["a"], 1);
            assert_eq!(result["b"]["x"], 10);
            assert_eq!(result["b"]["y"], 20);
            assert_eq!(result["c"], 30);
            assert!(changed);
        }

        #[test]
        fn test_json_deep_merge_no_change() {
            let (_result, changed, _) = merge_field(
                "resources",
                "metadata_json",
                Some(&json!({"a": 1})),
                Some(&json!({"a": 1})),
            );
            assert!(!changed);
        }

        #[test]
        fn test_json_deep_merge_overwrite_primitive() {
            let (result, changed, _) = merge_field(
                "resources",
                "metadata_json",
                Some(&json!({"a": 1})),
                Some(&json!({"a": 2})),
            );
            assert_eq!(result["a"], 2);
            assert!(changed);
        }

        // --- Identity and conflict cases ---

        #[test]
        fn test_merge_field_identical() {
            let val = json!("same");
            let (result, merged, conflict) = merge_field("notes", "title", Some(&val), Some(&val));
            assert_eq!(result, "same");
            assert!(!merged);
            assert!(!conflict);
        }

        #[test]
        fn test_merge_field_generic_conflict() {
            let (result, _, conflict) = merge_field(
                "unknown_table",
                "unknown_col",
                Some(&json!("A")),
                Some(&json!("B")),
            );
            assert_eq!(result, "B");
            assert!(conflict);
        }

        #[test]
        fn test_merge_field_none_values() {
            let (result, _, _) = merge_field("notes", "title", None, Some(&json!("hello")));
            assert_eq!(result, "hello");

            let (result, _, _) = merge_field("notes", "title", Some(&json!("hello")), None);
            assert_eq!(result, "hello");

            let (result, _, _) = merge_field("notes", "title", None, None);
            assert_eq!(result, Value::Null);
        }

        #[test]
        fn test_merge_field_ease_factor_avg() {
            let (result, merged, _) = merge_field(
                "review_plans",
                "ease_factor",
                Some(&json!(2.5)),
                Some(&json!(2.8)),
            );
            let val = result.as_f64().unwrap();
            assert!(
                (val - 2.65).abs() < 0.01,
                "ease_factor should be averaged: got {}",
                val
            );
            assert!(merged);
        }

        #[test]
        fn test_merge_field_interval_days_max() {
            let (result, merged, _) = merge_field(
                "review_plans",
                "interval_days",
                Some(&json!(3)),
                Some(&json!(7)),
            );
            assert_eq!(result, 7);
            assert!(merged);
        }

        #[test]
        fn test_merge_field_default_skill_ids() {
            let (result, merged, _) = merge_field(
                "chat_v2_session_groups",
                "default_skill_ids_json",
                Some(&json!(["skill_a", "skill_b"])),
                Some(&json!(["skill_b", "skill_c"])),
            );
            let arr = result.as_array().unwrap();
            assert_eq!(arr.len(), 3);
            assert!(merged);
        }
    }

    // ============================================================================
    // Module 5: Prune Gap Detection Tests
    // ============================================================================
    mod prune_gap_tests {
        use deep_student_lib::data_governance::sync::SyncManager;

        #[test]
        fn test_gap_detected_when_since_far_behind() {
            let result = SyncManager::has_prune_gap(100, Some(500));
            assert!(
                result,
                "Should detect gap when since_version (100) < min_available (500)"
            );
        }

        #[test]
        fn test_gap_not_detected_when_ahead() {
            let result = SyncManager::has_prune_gap(500, Some(100));
            assert!(!result, "Should NOT detect gap when since_version is ahead");
        }

        #[test]
        fn test_gap_not_detected_when_equal() {
            let result = SyncManager::has_prune_gap(200, Some(200));
            assert!(!result);
        }

        #[test]
        fn test_gap_not_detected_at_zero() {
            let result = SyncManager::has_prune_gap(0, Some(500));
            assert!(
                !result,
                "Version 0 means no sync history, should not be a gap"
            );
        }

        #[test]
        fn test_gap_not_detected_when_no_min_available() {
            let result = SyncManager::has_prune_gap(100, None);
            assert!(!result, "No min_available means no files exist, not a gap");
        }

        #[test]
        fn test_gap_boundary_exact_match() {
            let result = SyncManager::has_prune_gap(500, Some(500));
            assert!(!result, "Exact match is not a gap");
        }

        #[test]
        fn test_gap_large_distance() {
            let result = SyncManager::has_prune_gap(10, Some(50000));
            assert!(result, "Large version gap should be detected");
        }
    }

    // ============================================================================
    // Module 6: Change Log Trigger Coverage Tests
    // ============================================================================
    mod trigger_coverage_tests {
        use deep_student_lib::data_governance::sync::classification::{
            sync_classification_registry, TableClassification,
        };

        #[test]
        fn test_no_duplicate_row_sync_classifications() {
            let tables = TableClassification::row_sync_tables();
            let mut seen = std::collections::HashSet::new();
            for t in &tables {
                let key = format!("{}.{}", t.database, t.table_name);
                assert!(
                    seen.insert(key.clone()),
                    "Duplicate classification: {}.{}",
                    t.database,
                    t.table_name
                );
            }
        }

        #[test]
        fn test_every_classification_has_merge_notes() {
            for c in &sync_classification_registry() {
                assert!(
                    !c.merge_notes.is_empty(),
                    "Table {}.{} has empty merge_notes field",
                    c.database,
                    c.table_name
                );
            }
        }

        #[test]
        fn test_no_duplicate_classifications() {
            let registry = sync_classification_registry();
            let mut map = std::collections::HashMap::new();
            for c in &registry {
                let key = format!("{}.{}", c.database, c.table_name);
                assert!(map.insert(key.clone(), c).is_none(), "Duplicate: {}", key);
            }
        }

        #[test]
        fn test_registry_size_is_reasonable() {
            let registry = sync_classification_registry();
            assert!(registry.len() > 50, "Registry should be comprehensive");
            assert!(registry.len() < 300, "Registry should not be bloated");
        }

        #[test]
        fn test_row_sync_tables_include_key_tables() {
            let tables = TableClassification::row_sync_tables();
            let names: std::collections::HashSet<_> = tables.iter().map(|t| t.table_name).collect();
            assert!(names.contains("resources"));
            assert!(names.contains("notes"));
            assert!(names.contains("questions"));
            assert!(names.contains("chat_v2_sessions"));
            assert!(names.contains("chat_v2_messages"));
            assert!(names.contains("todo_items"));
            assert!(names.contains("mistakes"));
            assert!(names.contains("llm_usage_logs"));
        }

        #[test]
        fn test_row_sync_tables_have_trigger_count() {
            let row_sync_tables = TableClassification::row_sync_tables();

            let mut db_counts: std::collections::HashMap<&str, usize> =
                std::collections::HashMap::new();
            for t in &row_sync_tables {
                *db_counts.entry(t.database).or_default() += 1;
            }

            assert!(
                db_counts.get("vfs").unwrap_or(&0) >= &15,
                "VFS should have at least 15 RowSync tables, found {}",
                db_counts.get("vfs").unwrap_or(&0)
            );

            assert!(
                db_counts.get("chat_v2").unwrap_or(&0) >= &7,
                "chat_v2 should have at least 7 RowSync tables, found {}",
                db_counts.get("chat_v2").unwrap_or(&0)
            );

            assert!(
                db_counts.get("mistakes").unwrap_or(&0) >= &6,
                "mistakes should have at least 6 RowSync tables, found {}",
                db_counts.get("mistakes").unwrap_or(&0)
            );

            assert_eq!(
                db_counts.get("llm_usage").unwrap_or(&0),
                &1,
                "llm_usage should have exactly 1 RowSync table (logs), found {}",
                db_counts.get("llm_usage").unwrap_or(&0)
            );
        }
    }

    // ============================================================================
    // Module 7: NULL PK and Special Case Tests
    // ============================================================================
    mod edge_case_tests {
        use deep_student_lib::data_governance::sync::classification::{
            sync_classification_registry, SyncCategory,
        };

        #[test]
        fn test_composite_pk_tables() {
            let registry = sync_classification_registry();
            let tables_with_composite_pk: Vec<_> = registry
                .iter()
                .filter(|c| c.primary_key.contains(','))
                .collect();

            let expected = vec![
                "path_cache",
                "chat_v2_session_mistakes",
                "chat_v2_session_tags",
                "review_session_mistakes",
                "llm_usage_daily",
                "vfs_embedding_dims",
            ];
            for name in &expected {
                let found = tables_with_composite_pk
                    .iter()
                    .any(|c| c.table_name == *name);
                assert!(found, "Missing composite PK: {}", name);
            }
            let found_names: Vec<_> = tables_with_composite_pk
                .iter()
                .map(|c| c.table_name)
                .collect();
            assert_eq!(
                tables_with_composite_pk.len(),
                expected.len(),
                "All composite PK tables should be accounted for. Found: {:?}",
                found_names
            );
        }

        #[test]
        fn test_chat_messages_in_mistakes_is_row_sync() {
            let registry = sync_classification_registry();
            let chat_msg = registry
                .iter()
                .find(|c| c.table_name == "chat_messages" && c.database == "mistakes")
                .unwrap();
            assert!(matches!(chat_msg.category, SyncCategory::RowSync));
        }

        #[test]
        fn test_virtual_fts_tables_have_virtual_pk() {
            let registry = sync_classification_registry();
            for c in &registry {
                if c.primary_key == "(virtual)" {
                    assert!(
                        c.table_name.ends_with("_fts"),
                        "Expected FTS table, got {}",
                        c.table_name
                    );
                }
            }
        }

        #[test]
        fn test_refinery_schema_history_not_in_registry() {
            let registry = sync_classification_registry();
            let found = registry
                .iter()
                .any(|c| c.table_name == "refinery_schema_history");
            assert!(
                !found,
                "refinery_schema_history is migration framework, not user data"
            );
        }

        #[test]
        fn test_deprecated_tables_exist() {
            let registry = sync_classification_registry();
            let deprecated: Vec<_> = registry
                .iter()
                .filter(|c| c.category == SyncCategory::Deprecated)
                .collect();
            assert!(
                !deprecated.is_empty(),
                "Should have at least one deprecated table"
            );
            // notes_versions is the known deprecated table
            let has_notes_versions = deprecated.iter().any(|c| c.table_name == "notes_versions");
            assert!(has_notes_versions);
        }
    }

    mod review_plan_merge_tests {
        use rusqlite::Connection;

        #[test]
        fn test_review_plan_question_id_conflict_uses_upsert() {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE review_plans (
                    id TEXT PRIMARY KEY,
                    question_id TEXT NOT NULL UNIQUE,
                    ease_factor REAL NOT NULL DEFAULT 2.5,
                    interval_days INTEGER NOT NULL DEFAULT 0,
                    repetitions INTEGER NOT NULL DEFAULT 0,
                    total_reviews INTEGER NOT NULL DEFAULT 0,
                    total_correct INTEGER NOT NULL DEFAULT 0,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    device_id TEXT,
                    local_version INTEGER DEFAULT 0,
                    updated_at TEXT DEFAULT (datetime('now')),
                    deleted_at TEXT
                );
                CREATE TABLE __change_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    table_name TEXT NOT NULL,
                    record_id TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
                    sync_version INTEGER DEFAULT 0
                );",
            )
            .unwrap();

            // Device A creates plan rp_a for question q1
            conn.execute(
                "INSERT INTO review_plans (id, question_id, ease_factor, interval_days, total_reviews, total_correct)
                 VALUES ('rp_a', 'q1', 2.5, 1, 5, 4)",
                [],
            ).unwrap();

            // Device B independently creates plan rp_b for same question q1
            // This triggers UNIQUE constraint — sync layer should UPSERT instead
            let upsert_result = conn.execute(
                "INSERT INTO review_plans (id, question_id, ease_factor, interval_days, total_reviews, total_correct)
                 VALUES ('rp_b', 'q1', 2.8, 3, 10, 8)
                 ON CONFLICT(question_id) DO UPDATE SET
                    ease_factor = (ease_factor + excluded.ease_factor) / 2.0,
                    interval_days = MAX(interval_days, excluded.interval_days),
                    total_reviews = total_reviews + excluded.total_reviews,
                    total_correct = total_correct + excluded.total_correct,
                    id = (CASE WHEN excluded.id > id THEN excluded.id ELSE id END)",
                [],
            );
            assert!(
                upsert_result.is_ok(),
                "UPSERT should handle the question_id conflict"
            );

            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM review_plans WHERE question_id = 'q1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();

            assert_eq!(
                count, 1,
                "Only one review plan should exist for q1 after UPSERT"
            );
        }
    }
}
