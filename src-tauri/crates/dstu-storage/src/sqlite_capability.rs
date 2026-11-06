//! SQLite connection-level capability for writers of a board-bearing VFS database.
//!
//! Older readers can open a VFS database created by a newer release because the
//! migration coordinator only warns about versions it does not recognise. That
//! is safe while no ink board exists, but once a board has been published, an
//! old writer must not mutate `files`, `blobs`, or `ink_render_artifacts`: doing
//! so could break the board manifest's content-addressed references.
//!
//! The gate has two independent pieces:
//!
//! 1. Every current write connection registers the scalar function
//!    [`VFS_WRITER_CAPABILITY_FUNCTION`] via [`register_vfs_writer_capability`].
//! 2. When (and only when) a board is published or an existing board needs
//!    repair, the board repo calls [`enable_vfs_board_writer_guard`], which
//!    atomically installs `BEFORE INSERT/UPDATE/DELETE` triggers on the
//!    protected tables. The trigger body calls the capability function
//!    unconditionally (there is deliberately no `WHEN` clause that could be
//!    skipped): a connection without the function fails to prepare the write,
//!    while `SELECT` remains unaffected.
//!
//! The marker table created by `V20261104__vfs_writer_guard.sql` is metadata
//! only. Enforcement lives in the triggers, and the triggers are installed only
//! for a database that actually contains a board — an old v1 database that has
//! never used boards keeps its normal read/write behaviour.

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OptionalExtension};

/// Minimum writer capability required by the board schema.
///
/// Version 5 is the first capability that understands board (`schema_version:
/// 2`) manifests and the write gate. A connection returning a value lower than
/// this (or not registering the function at all) is fail-closed by the guard
/// triggers.
pub const VFS_BOARD_WRITER_CAPABILITY_VERSION: i64 = 5;

/// Name of the connection-local scalar function registered by
/// [`register_vfs_writer_capability`].
pub const VFS_WRITER_CAPABILITY_FUNCTION: &str = "dstu_vfs_writer_capability";

#[cfg(test)]
const GUARD_METADATA_SQL: &str =
    include_str!("../../../migrations/vfs/V20261104__vfs_writer_guard.sql");

/// Marker table DDL used by the install path. The historical migration is
/// still the source of truth for the schema, but its upsert lowers an existing
/// floor to the migration's version. The install path writes the marker itself
/// with a conservative `MAX(existing, excluded)` so a newer row can never be
/// downgraded by an older writer.
const VFS_WRITER_GUARD_MARKER_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS __vfs_writer_guard (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    min_writer_capability INTEGER NOT NULL CHECK (min_writer_capability > 0),
    guard_installed INTEGER NOT NULL DEFAULT 0 CHECK (guard_installed IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
"#;

/// Typed failures for capability registration and guard installation.
#[derive(Debug, thiserror::Error)]
pub enum SqliteCapabilityError {
    /// The scalar function could not be registered on the connection.
    #[error("register VFS writer capability: {0}")]
    Register(#[source] rusqlite::Error),

    /// The guard metadata or triggers could not be written.
    #[error("install VFS board writer guard: {0}")]
    Install(#[source] rusqlite::Error),

    /// The connection reports a capability lower than the board schema needs.
    #[error("VFS board writer capability {required} required, connection reports {actual}")]
    CapabilityTooLow { required: i64, actual: i64 },
}

impl From<SqliteCapabilityError> for rusqlite::Error {
    fn from(error: SqliteCapabilityError) -> Self {
        rusqlite::Error::ToSqlConversionFailure(Box::new(error))
    }
}

/// Register the VFS writer capability function on a connection.
///
/// Call this on every production connection that is allowed to write a VFS
/// database: the pool `with_init` hook, `open_sync_connection`, migration and
/// backup read-write connections, and slot-copy writers. Connections that were
/// opened without this call keep read access but fail closed on guarded writes
/// once a board exists.
///
/// Re-registering on the same connection is harmless.
pub fn register_vfs_writer_capability(conn: &Connection) -> Result<(), SqliteCapabilityError> {
    conn.create_scalar_function(
        VFS_WRITER_CAPABILITY_FUNCTION,
        0,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_INNOCUOUS,
        |_ctx| Ok(VFS_BOARD_WRITER_CAPABILITY_VERSION),
    )
    .map_err(SqliteCapabilityError::Register)
}

/// Protected table/operation pairs. Trigger names, canonical SQL, and probe
/// checks are all derived from this single array so the nine definitions cannot
/// drift apart.
const VFS_BOARD_WRITER_GUARD_TARGETS: [(&str, &str); 9] = [
    ("files", "INSERT"),
    ("files", "UPDATE"),
    ("files", "DELETE"),
    ("blobs", "INSERT"),
    ("blobs", "UPDATE"),
    ("blobs", "DELETE"),
    ("ink_render_artifacts", "INSERT"),
    ("ink_render_artifacts", "UPDATE"),
    ("ink_render_artifacts", "DELETE"),
];

fn guard_trigger_name(table: &str, operation: &str) -> String {
    format!(
        "trg_vfs_writer_guard_{table}_{}",
        operation.to_ascii_lowercase()
    )
}

/// Canonical trigger body. Trigger bodies call the capability function in the
/// `WHERE` clause on purpose: SQLite resolves missing functions when the
/// trigger program is prepared, so an old connection fails before any row is
/// modified. Do not move the check into a `WHEN` clause or behind a marker-table
/// lookup: those forms can skip evaluation and silently allow an old writer.
fn guard_trigger_body(table: &str, operation: &str) -> String {
    format!(
        "BEFORE {operation} ON {table} \
         BEGIN SELECT RAISE(ABORT, 'vfs.board_writer_capability_required') \
         WHERE {function}() < {floor}; END",
        function = VFS_WRITER_CAPABILITY_FUNCTION,
        floor = VFS_BOARD_WRITER_CAPABILITY_VERSION,
    )
}

fn guard_trigger_sql(table: &str, operation: &str) -> String {
    format!(
        "CREATE TRIGGER {name} {body};",
        name = guard_trigger_name(table, operation),
        body = guard_trigger_body(table, operation),
    )
}

/// Compare canonical and live trigger SQL after removing whitespace, folding
/// case, and ignoring the trailing statement terminator. This catches same-name
/// triggers with a replaced or truncated body while still accepting harmless
/// formatting differences.
fn normalize_guard_trigger_sql(sql: &str) -> String {
    let compact: String = sql.chars().filter(|ch| !ch.is_whitespace()).collect();
    compact.trim_end_matches(';').to_ascii_lowercase()
}

fn marker_capability_floor(conn: &Connection) -> Result<Option<i64>, SqliteCapabilityError> {
    let has_marker_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = '__vfs_writer_guard'",
            [],
            |row| row.get(0),
        )
        .map_err(SqliteCapabilityError::Install)?;
    if has_marker_table == 0 {
        return Ok(None);
    }

    conn.query_row(
        "SELECT min_writer_capability FROM __vfs_writer_guard WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(SqliteCapabilityError::Install)
}

fn reject_newer_marker_floor(
    conn: &Connection,
    current_capability: i64,
) -> Result<(), SqliteCapabilityError> {
    if let Some(marker_floor) = marker_capability_floor(conn)? {
        if marker_floor > current_capability {
            return Err(SqliteCapabilityError::CapabilityTooLow {
                required: marker_floor,
                actual: current_capability,
            });
        }
    }
    Ok(())
}

/// Single source of truth for whether the board writer guard is complete.
///
/// Returns `Ok(false)` when the guard is absent or incomplete. A marker written
/// by a newer capability (`min_writer_capability` above this build) is a typed
/// error instead of an incomplete guard, so callers cannot silently downgrade it
/// by installing older triggers.
///
/// A complete guard requires:
/// - the marker's floor to equal this build's capability (a lower floor is an
///   upgrade candidate, a higher floor is rejected above);
/// - `guard_installed = 1`;
/// - all nine exact `(table, operation)` triggers, with canonical bodies and
///   the trigger attached to the expected table.
pub fn vfs_board_writer_guard_installed(conn: &Connection) -> Result<bool, SqliteCapabilityError> {
    let Some(marker_floor) = marker_capability_floor(conn)? else {
        return Ok(false);
    };
    if marker_floor > VFS_BOARD_WRITER_CAPABILITY_VERSION {
        return Err(SqliteCapabilityError::CapabilityTooLow {
            required: marker_floor,
            actual: VFS_BOARD_WRITER_CAPABILITY_VERSION,
        });
    }
    if marker_floor < VFS_BOARD_WRITER_CAPABILITY_VERSION {
        return Ok(false);
    }

    let installed: Option<i64> = conn
        .query_row(
            "SELECT guard_installed FROM __vfs_writer_guard WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(SqliteCapabilityError::Install)?;
    if installed != Some(1) {
        return Ok(false);
    }

    for (table, operation) in VFS_BOARD_WRITER_GUARD_TARGETS {
        let expected_name = guard_trigger_name(table, operation);
        let expected_body = normalize_guard_trigger_sql(&guard_trigger_body(table, operation));
        let actual: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT tbl_name, sql FROM sqlite_master
                 WHERE type = 'trigger' AND name = ?1",
                [expected_name.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(SqliteCapabilityError::Install)?;
        let Some((actual_table, actual_sql)) = actual else {
            return Ok(false);
        };
        let Some(actual_sql) = actual_sql else {
            return Ok(false);
        };
        let normalized_actual = normalize_guard_trigger_sql(&actual_sql);
        if actual_table.as_str() != table || !normalized_actual.ends_with(&expected_body) {
            return Ok(false);
        }
    }

    Ok(true)
}

/// Install the board writer guard on `conn`'s database.
///
/// Installation is atomic: the marker metadata, all nine triggers, and the
/// `guard_installed = 1` row are written inside an internal savepoint. On any
/// failure the savepoint is rolled back and released, so a failed install
/// leaves neither a partial trigger set nor a partially modified marker row.
/// SQLite savepoints nest, so this can be called from inside an existing board
/// savepoint as well as in autocommit mode.
///
/// The function verifies that the calling connection itself is capable and
/// that the existing marker floor is not newer than this build before touching
/// the database, then:
///
/// - ensures the `__vfs_writer_guard` marker row exists (idempotent, same DDL as
///   `V20261104__vfs_writer_guard.sql`);
/// - drops and recreates the nine owned `BEFORE INSERT/UPDATE/DELETE` triggers
///   for `files`, `blobs`, and `ink_render_artifacts` from the canonical
///   table/operation definitions (a damaged same-name body is replaced, while
///   non-owned triggers are untouched);
/// - marks `guard_installed = 1`.
pub fn enable_vfs_board_writer_guard(conn: &Connection) -> Result<(), SqliteCapabilityError> {
    let capability = require_writer_capability(conn)?;
    // Reject a marker written by a newer capability before opening the install
    // savepoint: no trigger, marker, or floor write may occur in this case.
    reject_newer_marker_floor(conn, capability)?;

    const SAVEPOINT: &str = "dstu_vfs_writer_guard_install";
    conn.execute_batch(&format!("SAVEPOINT {SAVEPOINT}"))
        .map_err(SqliteCapabilityError::Install)?;

    match install_guard_state(conn, capability) {
        Ok(()) => {
            if let Err(release_error) =
                conn.execute_batch(&format!("RELEASE SAVEPOINT {SAVEPOINT}"))
            {
                // Best-effort cleanup so a failed RELEASE does not leave the
                // connection sitting inside this helper's savepoint.
                let _ = conn.execute_batch(&format!(
                    "ROLLBACK TO SAVEPOINT {SAVEPOINT}; RELEASE SAVEPOINT {SAVEPOINT};"
                ));
                return Err(SqliteCapabilityError::Install(release_error));
            }
            Ok(())
        }
        Err(error) => {
            // If rollback itself fails, the database state is unknown. Report
            // that failure rather than pretending the partial install was
            // cleaned up.
            match conn.execute_batch(&format!(
                "ROLLBACK TO SAVEPOINT {SAVEPOINT}; RELEASE SAVEPOINT {SAVEPOINT};"
            )) {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(SqliteCapabilityError::Install(rollback_error)),
            }
        }
    }
}

fn install_guard_state(conn: &Connection, capability: i64) -> Result<(), SqliteCapabilityError> {
    conn.execute_batch(VFS_WRITER_GUARD_MARKER_DDL)
        .map_err(SqliteCapabilityError::Install)?;
    // This UPSERT is the writer statement that serializes us with concurrent
    // installers. MAX preserves a newer floor even if another connection
    // committed it after the pre-savepoint check. The floor is re-read only
    // after this write lock is held; a newer floor aborts inside the savepoint
    // and rolls back any marker/trigger DDL.
    conn.execute(
        "INSERT INTO __vfs_writer_guard (
             id, min_writer_capability, guard_installed
         ) VALUES (1, ?1, 0)
         ON CONFLICT(id) DO UPDATE SET
             min_writer_capability = MAX(min_writer_capability, excluded.min_writer_capability)",
        [capability],
    )
    .map_err(SqliteCapabilityError::Install)?;

    let marker_floor: i64 = conn
        .query_row(
            "SELECT min_writer_capability FROM __vfs_writer_guard WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(SqliteCapabilityError::Install)?;
    if marker_floor > capability {
        return Err(SqliteCapabilityError::CapabilityTooLow {
            required: marker_floor,
            actual: capability,
        });
    }

    let mut trigger_sql = String::new();
    for (table, operation) in VFS_BOARD_WRITER_GUARD_TARGETS {
        trigger_sql.push_str(&format!(
            "DROP TRIGGER IF EXISTS {};\n",
            guard_trigger_name(table, operation)
        ));
        trigger_sql.push_str(&guard_trigger_sql(table, operation));
        trigger_sql.push('\n');
    }
    conn.execute_batch(&trigger_sql)
        .map_err(SqliteCapabilityError::Install)?;
    conn.execute(
        "INSERT INTO __vfs_writer_guard (
             id, min_writer_capability, guard_installed, updated_at
         ) VALUES (1, ?1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(id) DO UPDATE SET
             min_writer_capability = MAX(min_writer_capability, excluded.min_writer_capability),
             guard_installed = 1,
             updated_at = excluded.updated_at",
        [capability],
    )
    .map_err(SqliteCapabilityError::Install)?;

    Ok(())
}

fn require_writer_capability(conn: &Connection) -> Result<i64, SqliteCapabilityError> {
    let actual: i64 = conn
        .query_row(
            &format!("SELECT {VFS_WRITER_CAPABILITY_FUNCTION}()"),
            [],
            |row| row.get(0),
        )
        .map_err(SqliteCapabilityError::Install)?;

    if actual < VFS_BOARD_WRITER_CAPABILITY_VERSION {
        return Err(SqliteCapabilityError::CapabilityTooLow {
            required: VFS_BOARD_WRITER_CAPABILITY_VERSION,
            actual,
        });
    }

    Ok(actual)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::path::Path;

    const MINIMAL_VFS_SCHEMA: &str = r#"
        CREATE TABLE blobs (
            hash TEXT PRIMARY KEY,
            ref_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE files (
            id TEXT PRIMARY KEY,
            blob_hash TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            file_name TEXT NOT NULL
        );
        CREATE TABLE ink_render_artifacts (
            render_id TEXT PRIMARY KEY,
            artifact_id TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            image_blob_hash TEXT NOT NULL,
            image_file_id TEXT NOT NULL,
            image_resource_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
    "#;

    fn open_fixture(path: &Path) -> Connection {
        let conn = Connection::open(path).expect("open fixture database");
        conn.execute_batch(MINIMAL_VFS_SCHEMA)
            .expect("create minimal vfs schema");
        conn.execute_batch(
            "INSERT INTO blobs (hash, ref_count) VALUES ('blob-1', 1), ('blob-2', 1);
             INSERT INTO files (id, blob_hash, sha256, file_name)
             VALUES ('file-1', 'blob-1', 'blob-1', 'board');
             INSERT INTO ink_render_artifacts (
                 render_id, artifact_id, metadata_json, image_blob_hash,
                 image_file_id, image_resource_id, created_at
             ) VALUES (
                 'render-1', 'artifact-1', '{}', 'blob-2',
                 'file-1', 'res-1', '2026-11-04T00:00:00Z'
             );",
        )
        .expect("seed fixture rows");
        conn
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0))
            .expect("count rows")
    }

    fn trigger_count(conn: &Connection) -> i64 {
        count(
            conn,
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'trigger' AND name LIKE 'trg_vfs_writer_guard_%'",
        )
    }

    /// Real SQLite, real guard triggers, no function stubs: an old connection
    /// cannot prepare guarded writes once a board has installed the guard.
    #[test]
    fn unregistered_connection_is_fail_closed_after_board_guard_install() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("vfs.db");

        {
            let seed = open_fixture(&path);
            drop(seed);
        }

        let writer = Connection::open(&path).expect("open writer connection");
        register_vfs_writer_capability(&writer).expect("register capability");
        enable_vfs_board_writer_guard(&writer).expect("install guard");
        // Idempotent: a retry inside the board savepoint must not fail.
        enable_vfs_board_writer_guard(&writer).expect("reinstall guard");

        assert_eq!(trigger_count(&writer), 9);
        let installed: i64 = writer
            .query_row(
                "SELECT guard_installed FROM __vfs_writer_guard WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("read guard marker");
        assert_eq!(installed, 1);

        let old = Connection::open(&path).expect("open old connection without capability");

        // Reads still work through the same connection.
        let file_name: String = old
            .query_row(
                "SELECT file_name FROM files WHERE id = 'file-1'",
                [],
                |row| row.get(0),
            )
            .expect("old connection can read files");
        assert_eq!(file_name, "board");

        // Every guarded write class is rejected, and none of them changes a row.
        assert!(old
            .execute(
                "INSERT INTO files (id, blob_hash, sha256, file_name)
                 VALUES ('file-2', 'blob-1', 'blob-1', 'other')",
                [],
            )
            .is_err());
        assert!(old
            .execute(
                "UPDATE files SET blob_hash = 'blob-2' WHERE id = 'file-1'",
                [],
            )
            .is_err());
        assert!(old
            .execute("DELETE FROM files WHERE id = 'file-1'", [])
            .is_err());

        assert!(old
            .execute(
                "INSERT INTO blobs (hash, ref_count) VALUES ('blob-3', 0)",
                []
            )
            .is_err());
        assert!(old
            .execute("UPDATE blobs SET ref_count = 99 WHERE hash = 'blob-1'", [])
            .is_err());
        assert!(old
            .execute("DELETE FROM blobs WHERE hash = 'blob-2'", [])
            .is_err());

        assert!(old
            .execute(
                "INSERT INTO ink_render_artifacts (
                     render_id, artifact_id, metadata_json, image_blob_hash,
                     image_file_id, image_resource_id, created_at
                 ) VALUES ('render-2', 'artifact-2', '{}', 'blob-1',
                           'file-1', 'res-1', '2026-11-04T00:00:00Z')",
                [],
            )
            .is_err());
        assert!(old
            .execute(
                "UPDATE ink_render_artifacts SET artifact_id = 'changed'
                 WHERE render_id = 'render-1'",
                [],
            )
            .is_err());
        assert!(old
            .execute(
                "DELETE FROM ink_render_artifacts WHERE render_id = 'render-1'",
                [],
            )
            .is_err());

        assert_eq!(count(&old, "SELECT COUNT(*) FROM files"), 1);
        assert_eq!(
            old.query_row(
                "SELECT blob_hash FROM files WHERE id = 'file-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("read file after rejected writes"),
            "blob-1"
        );
        assert_eq!(
            count(&old, "SELECT ref_count FROM blobs WHERE hash = 'blob-1'"),
            1
        );
        assert_eq!(
            count(
                &old,
                "SELECT COUNT(*) FROM ink_render_artifacts WHERE render_id = 'render-1'"
            ),
            1
        );

        // A registered writer is allowed to perform the same mutations.
        writer
            .execute(
                "INSERT INTO files (id, blob_hash, sha256, file_name)
                 VALUES ('file-2', 'blob-1', 'blob-1', 'other')",
                [],
            )
            .expect("registered writer inserts files");
        writer
            .execute(
                "UPDATE files SET blob_hash = 'blob-2' WHERE id = 'file-1'",
                [],
            )
            .expect("registered writer updates files");
        writer
            .execute("UPDATE blobs SET ref_count = 2 WHERE hash = 'blob-2'", [])
            .expect("registered writer updates blobs");
        writer
            .execute(
                "DELETE FROM ink_render_artifacts WHERE render_id = 'render-1'",
                [],
            )
            .expect("registered writer deletes ink artifacts");
    }

    /// Merely having the new marker table (from the migration) is not a gate:
    /// an old v1 database that never published a board stays writable.
    #[test]
    fn v1_database_without_board_guard_remains_writable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("vfs.db");

        let old = open_fixture(&path);
        old.execute_batch(GUARD_METADATA_SQL)
            .expect("apply guard metadata migration");

        assert_eq!(trigger_count(&old), 0);
        assert_eq!(
            count(
                &old,
                "SELECT guard_installed FROM __vfs_writer_guard WHERE id = 1"
            ),
            0
        );

        old.execute(
            "UPDATE files SET blob_hash = 'blob-2' WHERE id = 'file-1'",
            [],
        )
        .expect("old v1 database remains writable");
        old.execute("DELETE FROM blobs WHERE hash = 'blob-2'", [])
            .expect("old v1 database remains deletable");
        old.execute(
            "INSERT INTO blobs (hash, ref_count) VALUES ('blob-3', 0)",
            [],
        )
        .expect("old v1 database remains insertable");
    }

    /// Installation checks the caller's own capability before mutating the
    /// schema, so a forgotten registration cannot install a guard that locks
    /// out its own connection.
    #[test]
    fn guard_install_requires_a_registered_capability() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("vfs.db");
        let conn = open_fixture(&path);

        let error = enable_vfs_board_writer_guard(&conn)
            .expect_err("unregistered connection must not install the guard");
        match error {
            SqliteCapabilityError::Install(source) => {
                assert!(
                    source.to_string().contains("no such function"),
                    "unexpected install error: {source}"
                );
            }
            other => panic!("unexpected error variant: {other}"),
        }

        assert_eq!(trigger_count(&conn), 0);
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = '__vfs_writer_guard'"
            ),
            0
        );

        register_vfs_writer_capability(&conn).expect("register capability");
        enable_vfs_board_writer_guard(&conn).expect("install guard after registration");
        assert_eq!(trigger_count(&conn), 9);
    }

    /// `trusted_schema=OFF` is the SQLite posture that rejects non-innocuous
    /// functions referenced by schema objects. A registered writer must still
    /// pass its own guard triggers, while a raw connection stays fail-closed.
    ///
    /// Regression: without `SQLITE_INNOCUOUS`, executing the trigger under
    /// trusted_schema=OFF raises "unsafe use of
    /// dstu_vfs_writer_capability()" even though the same connection
    /// registered the function.
    #[test]
    fn trusted_schema_off_keeps_registered_writer_writable_and_old_writer_blocked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("vfs.db");

        {
            let seed = open_fixture(&path);
            drop(seed);
        }

        let writer = Connection::open(&path).expect("open writer connection");
        writer
            .execute_batch("PRAGMA trusted_schema = OFF;")
            .expect("disable trusted schema on the writer");
        register_vfs_writer_capability(&writer).expect("register capability");
        enable_vfs_board_writer_guard(&writer).expect("install guard");
        assert_eq!(trigger_count(&writer), 9);

        // All three guarded write classes must work for the registered writer.
        writer
            .execute(
                "INSERT INTO files (id, blob_hash, sha256, file_name)
                 VALUES ('file-2', 'blob-1', 'blob-1', 'other')",
                [],
            )
            .expect("registered writer inserts files under trusted_schema=OFF");
        writer
            .execute("UPDATE blobs SET ref_count = 2 WHERE hash = 'blob-1'", [])
            .expect("registered writer updates blobs under trusted_schema=OFF");
        writer
            .execute(
                "DELETE FROM ink_render_artifacts WHERE render_id = 'render-1'",
                [],
            )
            .expect("registered writer deletes ink artifacts under trusted_schema=OFF");

        let old = Connection::open(&path).expect("open old connection without capability");
        let file_name: String = old
            .query_row(
                "SELECT file_name FROM files WHERE id = 'file-2'",
                [],
                |row| row.get(0),
            )
            .expect("old connection can still read");
        assert_eq!(file_name, "other");

        assert!(
            old.execute(
                "INSERT INTO files (id, blob_hash, sha256, file_name)
                 VALUES ('file-3', 'blob-1', 'blob-1', 'old')",
                [],
            )
            .is_err(),
            "unregistered connection must stay fail-closed"
        );
        assert!(
            old.execute("UPDATE blobs SET ref_count = 99 WHERE hash = 'blob-2'", [])
                .is_err(),
            "unregistered connection must stay fail-closed"
        );
    }

    /// A missing protected table makes trigger installation fail after the
    /// metadata batch and after the earlier trigger batches already ran in
    /// autocommit mode. A failed install must not leave any guard trigger or
    /// marker table behind, regardless of how the helper achieves that.
    ///
    /// Regression: an implementation that writes the marker metadata and
    /// earlier triggers in autocommit before the `blobs` trigger fails leaves
    /// three guard triggers and the marker table behind after `Err`.
    #[test]
    fn failed_guard_install_leaves_no_partial_triggers_or_marker() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("vfs.db");
        let conn = open_fixture(&path);
        register_vfs_writer_capability(&conn).expect("register capability");

        // Controlled fixture scope: this standalone database intentionally
        // models a database missing one of the protected tables.
        conn.execute_batch("DROP TABLE blobs;")
            .expect("drop one protected table from the fixture");
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = '__vfs_writer_guard'"
            ),
            0,
            "fixture must start without guard metadata"
        );

        let error = enable_vfs_board_writer_guard(&conn)
            .expect_err("installation must fail when a protected table is missing");
        assert!(
            matches!(error, SqliteCapabilityError::Install(_)),
            "unexpected error variant: {error}"
        );

        assert_eq!(
            trigger_count(&conn),
            0,
            "a failed install must not leave any guard trigger behind"
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = '__vfs_writer_guard'"
            ),
            0,
            "a failed install must not leave the guard marker table behind"
        );
    }

    /// A future writer may raise the marker's minimum capability above this
    /// build's version. Installing with an older build must fail closed before
    /// any schema write, rather than silently downgrading the marker to 5.
    ///
    /// Regression: `enable_vfs_board_writer_guard` only checks its own constant
    /// and its upsert overwrites `min_writer_capability` with 5.
    #[test]
    fn enable_refuses_to_downgrade_a_newer_marker_capability() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("vfs.db");
        let conn = open_fixture(&path);
        register_vfs_writer_capability(&conn).expect("register current capability");
        conn.execute_batch(GUARD_METADATA_SQL)
            .expect("apply guard marker metadata");
        conn.execute(
            "UPDATE __vfs_writer_guard SET min_writer_capability = 6 WHERE id = 1",
            [],
        )
        .expect("simulate a database written by a newer capability");

        let marker_before: (i64, i64) = conn
            .query_row(
                "SELECT min_writer_capability, guard_installed
                 FROM __vfs_writer_guard WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read marker before install");
        assert_eq!(marker_before, (6, 0));
        assert_eq!(trigger_count(&conn), 0);

        let _error = enable_vfs_board_writer_guard(&conn)
            .expect_err("an older writer must not downgrade a newer marker");

        assert_eq!(
            trigger_count(&conn),
            0,
            "a refused install must not write any trigger"
        );
        let marker_after: (i64, i64) = conn
            .query_row(
                "SELECT min_writer_capability, guard_installed
                 FROM __vfs_writer_guard WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read marker after refused install");
        assert_eq!(
            marker_after, marker_before,
            "a refused install must leave the newer marker untouched"
        );
    }

    #[test]
    fn capability_function_reports_required_version() {
        let conn = Connection::open_in_memory().expect("memory database");
        register_vfs_writer_capability(&conn).expect("register capability");

        let actual: i64 = conn
            .query_row("SELECT dstu_vfs_writer_capability()", params![], |row| {
                row.get(0)
            })
            .expect("call capability function");
        assert_eq!(actual, VFS_BOARD_WRITER_CAPABILITY_VERSION);
    }
}
