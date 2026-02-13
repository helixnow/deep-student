//! # Migration Verifier (迁移验证器)
//!
//! 验证迁移执行结果是否符合预期。
//!
//! ## 验证内容
//!
//! - 表是否存在
//! - 列是否存在
//! - 索引是否存在
//! - 关键查询是否可执行（语义 smoke test）

use super::{definitions::MigrationDef, MigrationError};

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: std::result::Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("[MigrationVerifier] Row parse error (skipped): {}", e);
            None
        }
    }
}

/// 迁移验证器
pub struct MigrationVerifier;

impl MigrationVerifier {
    /// 验证迁移结果
    pub fn verify(
        conn: &rusqlite::Connection,
        migration: &MigrationDef,
    ) -> Result<(), MigrationError> {
        // 验证表
        for table in migration.expected_tables {
            if !Self::table_exists(conn, table)? {
                return Err(MigrationError::VerificationFailed {
                    version: migration.refinery_version as u32,
                    reason: format!("Table '{}' not found", table),
                });
            }
        }

        // 验证列
        for (table, column) in migration.expected_columns {
            if !Self::column_exists(conn, table, column)? {
                return Err(MigrationError::VerificationFailed {
                    version: migration.refinery_version as u32,
                    reason: format!("Column '{}.{}' not found", table, column),
                });
            }
        }

        // 验证索引
        for index in migration.expected_indexes {
            if !Self::index_exists(conn, index)? {
                return Err(MigrationError::VerificationFailed {
                    version: migration.refinery_version as u32,
                    reason: format!("Index '{}' not found", index),
                });
            }
        }

        // 验证关键查询
        for query in migration.expected_queries {
            if let Err(err) = Self::query_executes(conn, query) {
                return Err(MigrationError::VerificationFailed {
                    version: migration.refinery_version as u32,
                    reason: format!(
                        "Query smoke test failed '{}': {}",
                        Self::shorten_query(query),
                        err
                    ),
                });
            }
        }

        Ok(())
    }

    fn shorten_query(query: &str) -> String {
        const MAX_LEN: usize = 96;
        if query.len() <= MAX_LEN {
            return query.to_string();
        }
        format!("{}...", &query[..MAX_LEN])
    }

    /// 检查表是否存在
    fn table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, MigrationError> {
        let sql = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?";
        let count: i32 = conn
            .query_row(sql, [table], |row| row.get(0))
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        Ok(count > 0)
    }

    /// 检查列是否存在
    fn column_exists(
        conn: &rusqlite::Connection,
        table: &str,
        column: &str,
    ) -> Result<bool, MigrationError> {
        let sql = format!("PRAGMA table_info({})", table);
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| MigrationError::Database(e.to_string()))?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(columns.contains(&column.to_string()))
    }

    /// 检查索引是否存在
    fn index_exists(conn: &rusqlite::Connection, index: &str) -> Result<bool, MigrationError> {
        let sql = "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?";
        let count: i32 = conn
            .query_row(sql, [index], |row| row.get(0))
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        Ok(count > 0)
    }

    /// 检查关键查询是否可执行
    fn query_executes(conn: &rusqlite::Connection, query: &str) -> Result<(), MigrationError> {
        let mut stmt = conn
            .prepare(query)
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        // 只需确保查询可以成功执行并开始迭代
        let _ = rows
            .next()
            .map_err(|e| MigrationError::Database(e.to_string()))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_supports_query_smoke_tests() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY,
                text TEXT
            );
            ",
        )
        .unwrap();

        let migration = MigrationDef::new(20260130, "init", "")
            .with_expected_tables(&["anki_cards"])
            .with_expected_columns(&[("anki_cards", "text")])
            .with_expected_queries(&["SELECT text FROM anki_cards LIMIT 1"]);

        MigrationVerifier::verify(&conn, &migration).unwrap();
    }

    #[test]
    fn verify_fails_when_query_smoke_test_breaks() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY
            );
            ",
        )
        .unwrap();

        let migration = MigrationDef::new(20260130, "init", "")
            .with_expected_tables(&["anki_cards"])
            .with_expected_queries(&["SELECT text FROM anki_cards LIMIT 1"]);

        let err = MigrationVerifier::verify(&conn, &migration).unwrap_err();
        match err {
            MigrationError::VerificationFailed { reason, .. } => {
                assert!(reason.contains("Query smoke test failed"));
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }
}
