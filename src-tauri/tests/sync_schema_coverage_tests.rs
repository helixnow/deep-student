//! Real-schema sync coverage tests.
//!
//! These tests build the four governed databases from the real migrations and
//! verify that the sync classification registry matches the schema that ships.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use deep_student_lib::data_governance::migration::{MigrationCoordinator, ALL_MIGRATION_SETS};
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::data_governance::sync::classification::{
    sync_classification_registry, SyncCategory, TableClassification,
};
use rusqlite::Connection;
use tempfile::TempDir;

struct MigratedDbs {
    _temp_dir: TempDir,
    paths: BTreeMap<&'static str, PathBuf>,
}

impl MigratedDbs {
    fn open(&self, database: &str) -> Connection {
        let path = self
            .paths
            .get(database)
            .unwrap_or_else(|| panic!("missing test database path for {database}"));
        Connection::open(path)
            .unwrap_or_else(|e| panic!("failed to open migrated database {database}: {e}"))
    }
}

fn migrate_real_databases() -> MigratedDbs {
    let temp_dir = TempDir::new().expect("create temp app data dir");
    let root = temp_dir.path().to_path_buf();
    let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
    let report = coordinator.run_all().expect("real migrations should run");
    assert!(
        report.success,
        "migration report should be successful: {report:?}"
    );

    let paths = BTreeMap::from([
        ("vfs", root.join("databases").join("vfs.db")),
        ("chat_v2", root.join("chat_v2.db")),
        ("mistakes", root.join("mistakes.db")),
        ("llm_usage", root.join("llm_usage.db")),
    ]);

    for (database, path) in &paths {
        assert!(
            path.exists(),
            "migration should create {database} database at {}",
            path.display()
        );
    }

    MigratedDbs {
        _temp_dir: temp_dir,
        paths,
    }
}

fn real_user_tables(conn: &Connection) -> BTreeSet<String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'table'
             ORDER BY name",
        )
        .expect("prepare table list query");

    stmt.query_map([], |row| row.get::<_, String>(0))
        .expect("query sqlite_master tables")
        .filter_map(Result::ok)
        .filter(|name| !is_framework_table(name))
        .collect()
}

fn is_framework_table(table_name: &str) -> bool {
    table_name.starts_with("sqlite_")
        || table_name.starts_with("__")
        || table_name == "refinery_schema_history"
}

fn table_columns(conn: &Connection, table_name: &str) -> BTreeSet<String> {
    let escaped = table_name.replace('\'', "''");
    let sql = format!("PRAGMA table_info('{escaped}')");
    let mut stmt = conn.prepare(&sql).expect("prepare table_info query");

    stmt.query_map([], |row| row.get::<_, String>(1))
        .expect("query table_info")
        .filter_map(Result::ok)
        .collect()
}

fn unique_index_column_groups(conn: &Connection, table_name: &str) -> Vec<BTreeSet<String>> {
    let escaped_table = table_name.replace('\'', "''");
    let sql = format!("PRAGMA index_list('{escaped_table}')");
    let mut stmt = conn.prepare(&sql).expect("prepare index_list query");

    let unique_index_names: Vec<String> = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let is_unique: i64 = row.get(2)?;
            Ok((name, is_unique))
        })
        .expect("query index_list")
        .filter_map(Result::ok)
        .filter_map(|(name, is_unique)| if is_unique != 0 { Some(name) } else { None })
        .collect();

    unique_index_names
        .into_iter()
        .filter_map(|index_name| {
            let escaped_index = index_name.replace('\'', "''");
            let sql = format!("PRAGMA index_info('{escaped_index}')");
            let mut stmt = conn.prepare(&sql).ok()?;
            let columns: BTreeSet<String> = stmt
                .query_map([], |row| row.get::<_, Option<String>>(2))
                .ok()?
                .filter_map(Result::ok)
                .flatten()
                .collect();
            if columns.is_empty() {
                None
            } else {
                Some(columns)
            }
        })
        .collect()
}

fn trigger_sql_for_table(conn: &Connection, table_name: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(sql, '')
             FROM sqlite_master
             WHERE type = 'trigger' AND tbl_name = ?1
             ORDER BY name",
        )
        .expect("prepare trigger query");

    stmt.query_map([table_name], |row| row.get::<_, String>(0))
        .expect("query triggers")
        .filter_map(Result::ok)
        .map(|sql| sql.to_lowercase())
        .collect()
}

fn migration_versions_on_disk(database: &str) -> BTreeSet<i32> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(database);
    std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read migration dir {}: {e}", dir.display()))
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let file_name = file_name.to_str()?;
            let rest = file_name.strip_prefix('V')?;
            let version = rest.split("__").next()?;
            version.parse::<i32>().ok()
        })
        .collect()
}

fn foreign_key_parent_tables(conn: &Connection, table_name: &str) -> BTreeSet<String> {
    let escaped = table_name.replace('\'', "''");
    let sql = format!("PRAGMA foreign_key_list('{escaped}')");
    let mut stmt = conn.prepare(&sql).expect("prepare foreign_key_list query");

    stmt.query_map([], |row| row.get::<_, String>(2))
        .expect("query foreign_key_list")
        .filter_map(Result::ok)
        .collect()
}

fn registry_by_database() -> BTreeMap<&'static str, Vec<TableClassification>> {
    let mut by_database: BTreeMap<&'static str, Vec<TableClassification>> = BTreeMap::new();
    for entry in sync_classification_registry() {
        by_database.entry(entry.database).or_default().push(entry);
    }
    by_database
}

fn registry_by_table() -> BTreeMap<(&'static str, &'static str), TableClassification> {
    sync_classification_registry()
        .into_iter()
        .map(|entry| ((entry.database, entry.table_name), entry))
        .collect()
}

#[test]
fn real_schema_tables_are_all_classified() {
    let migrated = migrate_real_databases();
    let registry = registry_by_database();

    for database in ["vfs", "chat_v2", "mistakes", "llm_usage"] {
        let conn = migrated.open(database);
        let classified: BTreeSet<&str> = registry
            .get(database)
            .into_iter()
            .flatten()
            .map(|entry| entry.table_name)
            .collect();

        let mut unclassified = Vec::new();
        for table in real_user_tables(&conn) {
            if TableClassification::is_excluded_from_checksum(database, &table) {
                continue;
            }
            if !classified.contains(table.as_str()) {
                unclassified.push(table);
            }
        }

        assert!(
            unclassified.is_empty(),
            "{database} has schema tables missing from sync classification: {unclassified:?}"
        );
    }
}

#[test]
fn classified_non_deprecated_tables_exist_in_real_schema() {
    let migrated = migrate_real_databases();

    for entry in sync_classification_registry()
        .into_iter()
        .filter(|entry| entry.category != SyncCategory::Deprecated)
    {
        let conn = migrated.open(entry.database);
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM sqlite_master
                 WHERE type IN ('table', 'view') AND name = ?1",
                [entry.table_name],
                |row| row.get(0),
            )
            .unwrap_or_else(|e| {
                panic!(
                    "failed checking existence for {}.{}: {e}",
                    entry.database, entry.table_name
                )
            });
        assert_eq!(
            exists, 1,
            "classification references missing object {}.{}",
            entry.database, entry.table_name
        );
    }
}

#[test]
fn row_sync_tables_have_primary_keys_and_change_log_triggers() {
    let migrated = migrate_real_databases();

    for entry in TableClassification::row_sync_tables() {
        let conn = migrated.open(entry.database);
        let columns = table_columns(&conn, entry.table_name);
        for pk_column in entry
            .primary_key
            .split(',')
            .map(str::trim)
            .filter(|column| !column.is_empty())
        {
            assert!(
                columns.contains(pk_column),
                "{}.{} primary key column '{}' from classification is missing in real schema",
                entry.database,
                entry.table_name,
                pk_column
            );
        }

        let triggers = trigger_sql_for_table(&conn, entry.table_name);
        for operation in ["insert", "update", "delete"] {
            let has_operation_trigger = triggers.iter().any(|sql| {
                sql.contains("__change_log")
                    && sql.contains(entry.table_name)
                    && sql.contains(operation)
            });
            assert!(
                has_operation_trigger,
                "{}.{} is RowSync but lacks a __change_log {} trigger",
                entry.database, entry.table_name, operation
            );
        }
    }
}

#[test]
fn row_sync_change_log_record_ids_follow_classified_primary_keys() {
    let migrated = migrate_real_databases();

    for entry in TableClassification::row_sync_tables() {
        let conn = migrated.open(entry.database);
        let triggers = trigger_sql_for_table(&conn, entry.table_name);
        let pk_columns: Vec<&str> = entry
            .primary_key
            .split(',')
            .map(str::trim)
            .filter(|column| !column.is_empty())
            .collect();

        for operation in ["insert", "update", "delete"] {
            let row_alias = if operation == "delete" { "old" } else { "new" };
            let operation_clause = format!("after {operation} on");
            let trigger_sql = triggers
                .iter()
                .find(|sql| {
                    sql.contains("__change_log")
                        && sql.contains(entry.table_name)
                        && sql.contains(&operation_clause)
                })
                .unwrap_or_else(|| {
                    panic!(
                        "{}.{} is RowSync but lacks a __change_log {} trigger",
                        entry.database, entry.table_name, operation
                    )
                });

            for pk_column in &pk_columns {
                let expected_ref = format!("{row_alias}.{pk_column}");
                assert!(
                    trigger_sql.contains(&expected_ref),
                    "{}.{} {} change_log trigger must derive record_id from classified primary key column '{}'; sql: {}",
                    entry.database,
                    entry.table_name,
                    operation,
                    pk_column,
                    trigger_sql
                );
            }
        }
    }
}

#[test]
fn row_sync_business_unique_keys_match_real_unique_indexes() {
    let migrated = migrate_real_databases();

    for entry in TableClassification::row_sync_tables()
        .into_iter()
        .filter(|entry| !entry.business_unique_keys.trim().is_empty())
    {
        let conn = migrated.open(entry.database);
        let unique_columns: BTreeSet<String> = unique_index_column_groups(&conn, entry.table_name)
            .into_iter()
            .flatten()
            .collect();

        let missing_columns: Vec<&str> = entry
            .business_unique_keys
            .split(',')
            .map(str::trim)
            .filter(|column| !column.is_empty())
            .filter(|column| !unique_columns.contains(*column))
            .collect();

        assert!(
            missing_columns.is_empty(),
            "{}.{} registers business unique keys not backed by real UNIQUE indexes: {:?}",
            entry.database,
            entry.table_name,
            missing_columns
        );
    }
}

#[test]
fn row_sync_foreign_key_parents_are_incrementally_available() {
    let migrated = migrate_real_databases();
    let registry = registry_by_table();

    for entry in TableClassification::row_sync_tables() {
        let conn = migrated.open(entry.database);
        for parent_table in foreign_key_parent_tables(&conn, entry.table_name) {
            let parent = registry
                .get(&(entry.database, parent_table.as_str()))
                .unwrap_or_else(|| {
                    panic!(
                        "{}.{} references unclassified parent table {}",
                        entry.database, entry.table_name, parent_table
                    )
                });

            assert!(
                matches!(parent.category, SyncCategory::RowSync | SyncCategory::FileSync),
                "{}.{} is RowSync but references {}.{} classified as {:?}; the parent must be available during incremental replay",
                entry.database,
                entry.table_name,
                entry.database,
                parent.table_name,
                parent.category
            );
        }
    }
}

#[test]
fn non_row_sync_tables_do_not_emit_incremental_change_log_triggers() {
    let migrated = migrate_real_databases();

    for entry in sync_classification_registry()
        .into_iter()
        .filter(|entry| entry.category != SyncCategory::RowSync)
    {
        let conn = migrated.open(entry.database);
        let offenders: Vec<String> = trigger_sql_for_table(&conn, entry.table_name)
            .into_iter()
            .filter(|sql| sql.contains("__change_log"))
            .collect();

        assert!(
            offenders.is_empty(),
            "{}.{} is {:?} but still writes to __change_log: {:?}",
            entry.database,
            entry.table_name,
            entry.category,
            offenders
        );
    }
}

#[test]
fn change_log_schema_supports_field_deltas_in_every_database() {
    let migrated = migrate_real_databases();

    for database in ["vfs", "chat_v2", "mistakes", "llm_usage"] {
        let conn = migrated.open(database);
        let columns = table_columns(&conn, "__change_log");
        for required in [
            "table_name",
            "record_id",
            "operation",
            "changed_at",
            "sync_version",
            "field_deltas_json",
        ] {
            assert!(
                columns.contains(required),
                "{database}.__change_log missing required column {required}"
            );
        }
    }
}

#[test]
fn checksum_scope_contains_only_row_or_file_sync_tables() {
    let migrated = migrate_real_databases();

    for database in ["vfs", "chat_v2", "mistakes", "llm_usage"] {
        let conn = migrated.open(database);
        let checksum_tables: BTreeSet<&str> = TableClassification::checksum_tables(database)
            .iter()
            .map(|entry| entry.table_name)
            .collect();

        for table in real_user_tables(&conn) {
            let in_checksum = checksum_tables.contains(table.as_str());
            let excluded = TableClassification::is_excluded_from_checksum(database, &table);
            assert_eq!(
                in_checksum, !excluded,
                "{database}.{table} checksum classification is inconsistent"
            );
        }
    }
}

#[test]
fn migration_order_still_covers_all_governed_databases() {
    let ordered: Vec<&str> = DatabaseId::all_ordered()
        .iter()
        .map(DatabaseId::as_str)
        .collect();
    assert_eq!(ordered, vec!["vfs", "llm_usage", "chat_v2", "mistakes"]);

    let registry_databases: BTreeSet<&str> = sync_classification_registry()
        .iter()
        .map(|entry| entry.database)
        .collect();
    let ordered_databases: BTreeSet<&str> = ordered.into_iter().collect();
    assert_eq!(
        registry_databases, ordered_databases,
        "classification registry and migration coordinator should cover the same databases"
    );
}

#[test]
fn migration_definition_sets_match_embedded_sql_files() {
    for set in ALL_MIGRATION_SETS {
        let disk_versions = migration_versions_on_disk(set.database_name);
        let registered_versions: BTreeSet<i32> = set
            .migrations
            .iter()
            .map(|migration| migration.refinery_version)
            .collect();

        assert_eq!(
            registered_versions, disk_versions,
            "{} migration definitions must match migrations/{} SQL files",
            set.database_name, set.database_name
        );
    }
}

#[allow(dead_code)]
fn _assert_path_is_under_tempdir(path: &Path, temp_dir: &TempDir) {
    assert!(path.starts_with(temp_dir.path()));
}
